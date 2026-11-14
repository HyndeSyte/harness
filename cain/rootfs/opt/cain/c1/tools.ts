// Small root helpers for the start (C1), in code rather than shell so no secret is ever on a
// command line (any user can read those in /proc):
//   bun tools.ts handover-key <token file>   HMAC(bot token, "harness-handover-v1"), the key the
//                                            Harness App checks for Cain's handovers
//   bun tools.ts login-check <token file>    start the pinned plugin's server as discord with the
//                                            token in its environment only, and wait (at most
//                                            40 s) for its gateway to connect; exit 0 if it did
//   bun tools.ts write-state <path> <text>   write a file whole and durably: a temp file, fsync,
//                                            rename, fsync of the folder; then read it back
//   bun tools.ts secrets <out file>          the current secret values, one a line, for the search
//                                            of Cain's files (the token, the App's keys and token,
//                                            the Supervisor token), written 0600
import { createHmac } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
export const tokenIn = (p: string) => text(p).match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";

export function writeDurably(path: string, body: string): boolean {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return readFileSync(path, "utf8") === body;
}

export function secretValues(options = "/data/options.json", tokenFile = "/data/link/discord.env",
                             s6 = "/run/s6/container_environment"): string[] {
  const out = new Set<string>();
  const t = tokenIn(tokenFile) || tokenIn("/data/.claude/channels/discord/.env");
  if (t) out.add(t);
  try {
    const o = JSON.parse(text(options) || "{}");
    for (const k of ["github_token", "gemini_api_key", "perplexity_api_key", "anthropic_api_key"]) if (typeof o[k] === "string" && o[k].length >= 12) out.add(o[k]);
  } catch { /* none */ }
  for (const k of ["SUPERVISOR_TOKEN", "HASSIO_TOKEN"]) { const v = text(join(s6, k)).trim(); if (v.length >= 12) out.add(v); }
  return [...out];
}

async function loginCheck(tokenFile: string): Promise<boolean> {
  const token = tokenIn(tokenFile);
  if (!token) { console.error("[c1] no bot token to check with"); return false; }
  const plugin = process.env.CAIN_DISCORD_PLUGIN ?? "/opt/cain/discord/plugin";
  const proc = Bun.spawn(["setpriv", "--reuid=discord", "--regid=discord", "--init-groups", "--no-new-privs",
    "--inh-caps=-all", "--bounding-set=-all", "/usr/local/bin/bun", join(plugin, "server.ts")], {
    cwd: plugin, stdin: "pipe", stdout: "ignore", stderr: "pipe",
    env: { HOME: "/data/discord", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISCORD_STATE_DIR: "/data/discord",
      DISCORD_ACCESS_MODE: "static", DISCORD_BOT_TOKEN: token },
  });
  const dec = new TextDecoder();
  let seen = "";
  const found = await Promise.race([
    (async () => { for await (const c of proc.stderr) { seen += dec.decode(c, { stream: true }); if (/gateway connected as/.test(seen)) return true; } return false; })(),
    Bun.sleep(40_000).then(() => false),
  ]);
  try { proc.kill(); } catch { /* gone */ }
  if (!found) console.error(`[c1] the plugin's server didn't connect: ${seen.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  return found;
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "handover-key" && a) {
    const t = tokenIn(a);
    if (!t) process.exit(1);
    process.stdout.write(createHmac("sha256", t).update("harness-handover-v1").digest("hex"));
  } else if (cmd === "login-check" && a) {
    process.exit((await loginCheck(a)) ? 0 : 1);
  } else if (cmd === "write-state" && a && b !== undefined) {
    process.exit(writeDurably(a, b) ? 0 : 1);
  } else if (cmd === "secrets" && a) {
    const fd = openSync(a, "w", 0o600);
    try { writeSync(fd, secretValues().join("\n") + "\n"); } finally { closeSync(fd); }
  } else {
    console.error("usage: tools.ts handover-key <file> | login-check <file> | write-state <path> <text> | secrets <out>");
    process.exit(2);
  }
}
