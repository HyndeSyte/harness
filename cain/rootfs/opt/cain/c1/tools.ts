// Small root helpers for the start and the switch (C1 plan 3.12), in code rather than shell so
// no secret is ever on a command line (any user can read those in /proc):
//   bun tools.ts handover-key <token file>     HMAC(bot token, "harness-handover-v1"), the key
//                                              the Harness App checks for Cain's handovers
//   bun tools.ts login-check <token file>      start the pinned plugin's server as discord, the
//                                              token in its environment only; exit 0 once its
//                                              gateway connects (at most 40 s)
//   bun tools.ts write-state <path> <text>     write a file whole and durably, then read it back
//   bun tools.ts journal-add <path> <line>     append one line durably (the switch's journal)
//   bun tools.ts journal-check <path>          print the journal's last step, or "bad"
//   bun tools.ts container-id                  this container's identity: the kernel's boot id
//                                              and the start time of PID 1
//   bun tools.ts may-retry <failed file>       exit 0 while the switch may be tried again: fewer
//                                              than 3 failures, or the last over 6 hours ago
//   bun tools.ts secrets <out file>            the current secret values, one a line, 0600
//   bun tools.ts readable <out file> <dir>...  every regular file under the dirs that uid 1000
//                                              could read, by owners, modes and his groups,
//                                              NUL-separated (computed by root: nothing of his runs)
//   bun tools.ts scan <needles> <list> <out>   the files in the list that hold any needle, as
//                                              it is or encoded (base64, base64url, hex)
//   bun tools.ts scan-tree <needles> <out> <dir>...   the switch's scrub, deeper: every regular
//                                              file under the dirs that holds a needle (as it is
//                                              or encoded) or a token's shape (but his own
//                                              sign-in's file), and every git folder whose
//                                              objects hold either (history, not only what's
//                                              checked out)
//   bun tools.ts allowed <list>                exit 0 when every readable file is one section 3.2
//                                              gives him (contract.ts); else print the first other
//   bun tools.ts same-tree <a> <b>             exit 0 when the two trees have the same manifest
//                                              (manifest(): type, mode, owner, group, size, time,
//                                              link target); else print the first entry that differs
//   bun tools.ts only <list> <path>...         exit 0 when every file in the list is one of these
//                                              paths or under one; else print the first other
import { createHmac } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readableAllowed } from "./contract";

// A file the switch needs: any error reading it, its absence included, is a failure, so no
// list or search input can ever read as an empty one (C1 re-check R4).
const need = (p: string) => readFileSync(p, "utf8");
// A file that may not be there yet: only its absence is empty; any other error is a failure.
const maybe = (p: string) => { try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return ""; throw e; } };
export const tokenIn = (p: string) => need(p).match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";

function fsyncDir(p: string): void {
  const d = openSync(p, "r");
  try { fsyncSync(d); } finally { closeSync(d); }
}

export function writeDurably(path: string, body: string): boolean {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
  return readFileSync(path, "utf8") === body;
}

export function appendDurably(path: string, line: string): void {
  let made = false;
  try { lstatSync(path); } catch { made = true; }
  const fd = openSync(path, "a", 0o600);
  try { writeSync(fd, line.replace(/\n/g, " ") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  if (made) fsyncDir(dirname(path));
}

// The journal's lines, in the order the switch writes them (cutover.sh). Anything else, or a
// first line that isn't begin, makes the journal "bad" and the state Stopped.
const STEPS = ["begin", "locked", "staged", "scrubbed", "validated", "commit", "committed"] as const;
const LINE = /^(begin [0-9a-f-]{36}:\d+|locked|staged|scrubbed \d+ \d+|validated|commit|committed) \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
export function journalStep(body: string): string {
  const lines = body.split("\n").filter((l) => l !== "");
  if (!lines.length || !lines[0].startsWith("begin ")) return "bad";
  let at = -1;
  for (const l of lines) {
    if (!LINE.test(l)) return "bad";
    const i = STEPS.indexOf(l.split(" ")[0] as typeof STEPS[number]);
    if (i !== at + 1) return "bad";                 // each step once, in order
    at = i;
  }
  return STEPS[at];
}

export function containerId(): string {
  const boot = need("/proc/sys/kernel/random/boot_id").trim();
  // Field 22 of /proc/1/stat, counted after the command's closing parenthesis (it may hold spaces).
  const stat = need("/proc/1/stat");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  if (!/^[0-9a-f-]{36}$/.test(boot) || !/^\d+$/.test(start)) throw new Error("no container identity");
  return `${boot}:${start}`;
}

export function mayRetry(body: string, now = Date.now()): boolean {
  const times = body.split("\n").map((l) => Date.parse(l.split(" ")[0] ?? "")).filter((t) => !Number.isNaN(t));
  return times.length < 3 || now - Math.max(...times) >= 6 * 3_600_000;
}

// The secret values: the bot token and both keys derived from it that aren't his (the old relay
// key and the signing key), the App's options, the link's Ship and deploy keys (each line of
// their bodies), the ChatGPT sign-in, the Supervisor token. Fail closed (C1 code review, C1-4):
// the options and the bot token are required, and any source that exists but can't be read or
// parsed throws, so a scan is never given fewer values than there are. Only a source that doesn't
// exist is absent. His own keys (handover, cain.key) are his by design, so they aren't searched.
const readIfThere = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw new Error(`${p} exists but can't be read (${e?.code ?? e})`); }
};
export function secretValues(d = process.env.C1_DATA ?? "/data", s6 = "/run/s6/container_environment"): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim().length >= 16 && !v.includes("\n")) out.add(v.trim()); };
  const envFile = readIfThere(join(d, "link/discord.env")) ?? readIfThere(join(d, ".claude/channels/discord/.env"));
  const t = envFile?.match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
  if (!t) throw new Error("no bot token to search for (link/discord.env or the old .env)");
  add(t);
  add(createHmac("sha256", t).update("harness-relay-v1").digest("hex"));
  add(createHmac("sha256", t).update("harness-link-sign-v2").digest("hex"));
  const optionsText = readIfThere(join(d, "options.json"));
  if (optionsText === null) throw new Error("no options.json to read the App's keys from");
  let o: any;
  try { o = JSON.parse(optionsText); } catch { throw new Error("options.json doesn't parse"); }
  if (!o || typeof o !== "object") throw new Error("options.json isn't an object");
  for (const k of ["github_token", "gemini_api_key", "perplexity_api_key", "anthropic_api_key"]) add(o[k]);
  for (const f of ["link/ship.key", "link/deploy_key"])
    for (const l of (readIfThere(join(d, f)) ?? "").split("\n")) if (!l.startsWith("-----") && l.trim().length >= 40) add(l);
  const walk = (v: unknown): void => { if (typeof v === "string") { if (v.length >= 32 && !/\s/.test(v)) add(v); } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
  let codex: string[] = [];
  try { codex = readdirSync(join(d, "codex")); } catch (e: any) { if (e?.code !== "ENOENT") throw new Error(`codex/ can't be listed (${e?.code ?? e})`); }
  for (const f of codex) if (f.endsWith(".json")) {
    const body = readIfThere(join(d, "codex", f)) ?? "";
    try { walk(JSON.parse(body)); } catch { throw new Error(`codex/${f} doesn't parse`); }
  }
  for (const k of ["SUPERVISOR_TOKEN", "HASSIO_TOKEN"]) add(readIfThere(join(s6, k)) ?? "");
  return [...out];
}

// Who uid 1000 is to the kernel's permission check: his uid and his one group.
const UID = Number(process.env.C1_CAIN_UID ?? 1000), GIDS = [Number(process.env.C1_CAIN_GID ?? 1000)];
// C1_NOT_HIS=1: leave out the files he owns (what root has to answer for is root's own files).
const NOT_HIS = process.env.C1_NOT_HIS === "1";
const may = (st: Stats, bit: number) =>
  st.uid === UID ? (st.mode >> 6) & bit : GIDS.includes(st.gid) ? (st.mode >> 3) & bit : st.mode & bit;

export function readableFiles(roots: string[]): string[] {
  const out: string[] = [];
  // A dir's own path reaches it only if he can search every folder above it.
  const reachable = (p: string): boolean => {
    for (let q = dirname(p); ; q = dirname(q)) {
      let st: Stats;
      try { st = lstatSync(q); } catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
      if (!may(st, 1)) return false;
      if (q === dirname(q)) return true;
    }
  };
  // A folder that can't be listed, or an entry that can't be looked at, stops the whole check
  // (C1-4): only an entry gone between the listing and the look is skipped.
  const walk = (dir: string, reach: boolean) => {
    const names = readdirSync(dir);
    for (const n of names) {
      const p = join(dir, n);
      let st: Stats;
      try { st = lstatSync(p); } catch (e: any) { if (e?.code === "ENOENT") continue; throw e; }
      if (st.isDirectory()) walk(p, reach && may(st, 1) !== 0);
      else if (st.isFile() && reach && may(st, 4) && !(NOT_HIS && st.uid === UID)) out.push(p);
    }
  };
  for (const r of roots) {
    let st: Stats;
    try { st = lstatSync(r); } catch (e: any) { if (e?.code === "ENOENT") continue; throw e; }
    if (st.isDirectory()) walk(r, reachable(r) && may(st, 1) !== 0);
    else if (st.isFile() && reachable(r) && may(st, 4) && !(NOT_HIS && st.uid === UID)) out.push(r);
  }
  return out;
}

export function filesUnder(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let st: Stats;
    try { st = lstatSync(p); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
    if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); }
    else if (st.isFile()) out.push(p);
  };
  for (const r of roots) walk(r);
  return out;
}

// Every entry of a tree with what a copy must keep: path, type, mode, owner, group, size,
// modification time (to the second) and a link's target. Two trees with the same manifest are
// the same copy (with diff -r --no-dereference for the contents).
export function manifest(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const p = rel ? join(root, rel) : root;
    const st = lstatSync(p);
    const type = st.isDirectory() ? "d" : st.isFile() ? "f" : st.isSymbolicLink() ? "l" : "o";
    const target = type === "l" ? readlinkSync(p) : "";
    out.push(JSON.stringify([rel, type, (st.mode & 0o7777).toString(8), st.uid, st.gid, type === "f" ? st.size : 0, Math.floor(st.mtimeMs / 1000), target]));
    if (type === "d") for (const n of readdirSync(p).sort()) walk(rel ? join(rel, n) : n);
  };
  walk("");
  return out;
}

// Each secret as it would read inside base64 (standard and url-safe, at each of the three byte
// alignments, without the edge characters its neighbours share) and hex (both cases), so an
// encoded copy is found too (C1 review service, theme 3).
export function encodedForms(v: string): string[] {
  const b = Buffer.from(v);
  const out = new Set<string>();
  for (let pad = 0; pad < 3; pad++) {
    const enc = Buffer.concat([Buffer.alloc(pad), b]).toString("base64");
    const core = enc.slice(Math.ceil((4 * pad) / 3), Math.floor((8 * (pad + b.length)) / 6));
    if (core.length >= 16) { out.add(core); out.add(core.replace(/\+/g, "-").replace(/\//g, "_")); }
  }
  const hex = b.toString("hex");
  out.add(hex); out.add(hex.toUpperCase());
  return [...out];
}
export const searchable = (values: string[]) => [...new Set(values.flatMap((v) => [v, ...encodedForms(v)]))];

// The shapes of tokens and keys, for a value that isn't a current secret (an old token, another
// account's key). His own sign-in's file holds his own tokens by design, so it isn't searched for
// shapes; every current value is still searched there.
export const TOKEN_SHAPES: { what: string; re: RegExp }[] = [
  { what: "a Discord bot token", re: /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/ },
  { what: "a GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}/ },
  { what: "an Anthropic API key", re: /sk-ant-api\d\d-[A-Za-z0-9_-]{40,}/ },
  { what: "an OpenAI key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { what: "a Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { what: "a Perplexity key", re: /pplx-[A-Za-z0-9]{40,}/ },
  // A key itself, its body right after the header (a raw line break or an escaped one), not
  // code that only names the header.
  { what: "a private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\s|\\n)+[A-Za-z0-9+\/=]{40}/ },
  { what: "a web token", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];
const HIS_OWN = new Set([".credentials.json"]);
export const shapeIn = (s: string) => TOKEN_SHAPES.find((t) => t.re.test(s))?.what ?? null;

// The files that hold any needle. A file that can't be read is an error, never a pass. With
// shapes, a token's shape counts too, outside his own sign-in's file.
export function holding(needles: string[], files: string[], shapes = false): string[] {
  const bufs = needles.filter((n) => n.length > 0).map((n) => Buffer.from(n));
  if (!bufs.length) return [];
  const keep = Math.max(200, ...bufs.map((b) => b.length)) - 1;
  const hits: string[] = [];
  const chunk = Buffer.alloc(4 << 20);
  for (const f of files) {
    const look = shapes && !HIS_OWN.has(basename(f));
    const fd = openSync(f, "r");
    try {
      let tail = Buffer.alloc(0), found = false;
      for (;;) {
        const n = readSync(fd, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        const window = Buffer.concat([tail, chunk.subarray(0, n)]);
        if (bufs.some((b) => window.indexOf(b) >= 0) || (look && shapeIn(window.toString("latin1")))) { found = true; break; }
        tail = window.subarray(Math.max(0, window.length - keep));
      }
      if (found) hits.push(f);
    } finally { closeSync(fd); }
  }
  return hits;
}

// The git folders under the roots (a repository's .git, or a bare one's objects' parent).
export function gitDirsUnder(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let st: Stats;
    try { st = lstatSync(p); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
    if (!st.isDirectory()) return;
    if (basename(p) === ".git") { out.push(p); return; }
    for (const n of readdirSync(p)) walk(join(p, n));
  };
  for (const r of roots) walk(r);
  return out;
}

// The git folders whose objects (every blob, tree and commit, history included) hold a needle or
// a token's shape, read through git's own cat-file with no config, hooks or filesystem monitor of
// the repository's own (C1 review service, theme 3). A repository git can't read is an error.
export async function gitHolding(needles: string[], dirs: string[]): Promise<string[]> {
  const bufs = needles.filter((n) => n.length > 0).map((n) => Buffer.from(n));
  const keep = Math.max(200, ...bufs.map((b) => b.length)) - 1;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "safe.directory", GIT_CONFIG_VALUE_2: "*" };
  const hits: string[] = [];
  for (const g of dirs) {
    const p = Bun.spawn(["git", "--git-dir", g, "--no-replace-objects", "cat-file", "--batch-all-objects", "--batch"],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let tail = Buffer.alloc(0), found = false;
    for await (const c of p.stdout) {
      if (found) continue;                                   // read to the end so git can exit
      const window = Buffer.concat([tail, Buffer.from(c)]);
      if (bufs.some((b) => window.indexOf(b) >= 0) || shapeIn(window.toString("latin1"))) found = true;
      tail = window.subarray(Math.max(0, window.length - keep));
    }
    const code = await p.exited;
    if (code !== 0) throw new Error(`git couldn't read the objects of ${g} (${code}): ${(await new Response(p.stderr).text()).trim().slice(0, 120)}`);
    if (found) hits.push(g);
  }
  return hits;
}

async function loginCheck(tokenFile: string): Promise<boolean> {
  const token = tokenIn(tokenFile);
  if (!token) { console.error("[c1] no bot token to check with"); return false; }
  // The login check's own path setting (the CI image test points it at a stand-in), so the
  // broker's pinned plugin path (CAIN_DISCORD_PLUGIN) is never moved with it.
  const plugin = process.env.C1_LOGIN_PLUGIN ?? "/opt/cain/discord/plugin";
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

// A list a step wrote (readable): it must be there, and an empty one is only a file with nothing
// in it. The secret values searched for must be there too, and hold at least one.
const nulList = (p: string) => need(p).split("\0").filter(Boolean);
const needles = (p: string) => {
  const n = need(p).split("\n").filter((x) => x.length > 0);
  if (!n.length) throw new Error(`no secret values to search for in ${p}`);
  return n;
};
const writeList = (p: string, l: string[]) => { const fd = openSync(p, "w", 0o600); try { writeSync(fd, l.map((x) => x + "\0").join("")); } finally { closeSync(fd); } };

if (import.meta.main) {
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "handover-key" && a) {
      const t = tokenIn(a);
      if (!t) process.exit(1);
      process.stdout.write(createHmac("sha256", t).update("harness-handover-v1").digest("hex"));
    } else if (cmd === "login-check" && a) {
      process.exit((await loginCheck(a)) ? 0 : 1);
    } else if (cmd === "write-state" && a && b !== undefined) {
      process.exit(writeDurably(a, b) ? 0 : 1);
    } else if (cmd === "journal-add" && a && b) {
      appendDurably(a, b);
    } else if (cmd === "journal-check" && a) {
      console.log(journalStep(need(a)));
    } else if (cmd === "container-id") {
      console.log(containerId());
    } else if (cmd === "may-retry" && a) {
      process.exit(mayRetry(maybe(a)) ? 0 : 1);
    } else if (cmd === "secrets" && a) {
      const fd = openSync(a, "w", 0o600);
      try { writeSync(fd, secretValues().join("\n") + "\n"); } finally { closeSync(fd); }
    } else if (cmd === "readable" && a && b) {
      writeList(a, readableFiles([b, ...rest]));
    } else if (cmd === "scan" && a && b && rest[0]) {
      writeList(rest[0], holding(searchable(needles(a)), nulList(b)));
    } else if (cmd === "scan-tree" && a && b && rest.length) {
      const all = searchable(needles(a));
      writeList(b, [...holding(all, filesUnder(rest), true), ...await gitHolding(all, gitDirsUnder(rest))]);
    } else if (cmd === "allowed" && a) {
      const bad = nulList(a).find((p) => !readableAllowed(p));
      if (bad) { console.log(bad); process.exit(1); }
    } else if (cmd === "same-tree" && a && b) {
      // The root entries themselves may differ in name only; everything below must match.
      const [x, y] = [manifest(a), manifest(b)];
      const strip = (l: string[]) => l.map((e, i) => i === 0 ? JSON.stringify(["", ...JSON.parse(e).slice(1)]) : e);
      const [sx, sy] = [strip(x), strip(y)];
      const diff = sx.findIndex((e, i) => e !== sy[i]);
      if (sx.length !== sy.length || diff >= 0) { console.log(diff >= 0 ? JSON.parse(sx[diff])[0] || "." : "a different number of entries"); process.exit(1); }
    } else if (cmd === "only" && a && b) {
      // Every path in the list is one of these files, or under one of these folders.
      const ok = [b, ...rest];
      const bad = nulList(a).find((p) => !ok.some((o) => p === o || p.startsWith(o.endsWith("/") ? o : o + "/")));
      if (bad) { console.log(bad); process.exit(1); }
    } else {
      console.error("usage: tools.ts handover-key|login-check|write-state|journal-add|journal-check|container-id|may-retry|secrets|readable|scan|scan-tree|allowed ...");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[c1] tools ${cmd}: ${String(e).slice(0, 200)}`);
    process.exit(3);
  }
}
