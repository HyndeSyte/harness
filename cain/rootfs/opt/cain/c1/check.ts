// The c1 check (C1 plan 3.12, state C): run as Cain's own user at each start, by root through
// as-cain (c1/check.sh), which keeps its answer: one line of JSON, {ok, failed, unchecked,
// checks}. Each check is something his user must not be able to do, tried for real, or a fact of
// his process the kernel reports. A check fails only on a breach (a read, a write, a connection
// or a request that went through); one that couldn't be tried (the link not up yet) is
// unchecked, tried again by check.sh. Root writes the result; he can read it, never be its
// reporter. C1_CHECK_NO_LINK=1 leaves out what needs the running stack (the CI image test).
import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const failed: string[] = [], unchecked: string[] = [];
let checks = 0;
const must = (name: string, ok: boolean) => { checks++; if (!ok) failed.push(name); };
const NO_LINK = process.env.C1_CHECK_NO_LINK === "1";
const refused = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

// 1. Reads his user must not make.
for (const p of ["/data/options.json", "/data/link/discord.env", "/data/link/ship.key", "/data/link/deploy_key",
  "/data/link/state.json", "/run/s6/container_environment/SUPERVISOR_TOKEN", "/data/c1/state", "/proc/1/environ"])
  must(`can't read ${p}`, refused(() => readFileSync(p)));
for (const d of ["/data/link", "/data/codex", "/data/c1", "/run/s6/container_environment", "/run/cain/root-tmp"])
  must(`can't list ${d}`, refused(() => readdirSync(d)));
// Every root process's environment (the link, the keeper and the runner hold keys there).
let rootEnvs = 0;
for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
  let uid = "";
  try { uid = (readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m) ?? [])[1] ?? ""; } catch { continue; }
  if (uid !== "0") continue;
  rootEnvs++;
  if (!refused(() => readFileSync(`/proc/${pid}/environ`))) { must(`can't read root process ${pid}'s environment`, false); break; }
}
must("found root processes to check", rootEnvs > 0);

// 2. Writes his user must not make: his rules, root's files, and what the Discord plugin's
// server loads (it holds the bot token, as the discord user), so nothing of his runs in it.
for (const p of ["/etc/claude-code/managed-settings.json", "/etc/claude-code/CLAUDE.md", "/opt/cain/settings.json",
  "/run/s6/c1check-probe", "/usr/local/bin/c1check-probe", "/data/trust/c1check.json", "/data/review-queue/c1check-probe",
  "/opt/cain/discord/plugin/server.ts", "/opt/cain/discord/plugin/c1check-probe", "/opt/cain/discord/broker.ts",
  "/usr/local/bin/bun"])
  must(`can't write ${p}`, refused(() => closeSync(openSync(p, "a"))));

// 3. What the kernel says of this process: no capabilities, no way to gain any, his ids only.
const status = readFileSync("/proc/self/status", "utf8");
const field = (k: string) => (status.match(new RegExp(`^${k}:\\s+(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
for (const k of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) must(`${k} is 0`, /^0+$/.test(field(k)));
must("no_new_privs", field("NoNewPrivs") === "1");
must("his uid only", field("Uid").split(/\s+/).every((x) => x === "1000"));
must("his gid only", field("Gid").split(/\s+/).every((x) => x === "1000"));
must("his group only", field("Groups") === "1000");

// 4. No process he can see carries the bot token: not in any command line (the kernel shows those
// to everyone) nor in any environment he can read (his own processes'), by its variable's name,
// since the value isn't his to know (C1 review service, theme 4).
let carried = "";
for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
  try { if (readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("DISCORD_BOT_TOKEN")) carried ||= `process ${pid}'s command line`; } catch { /* gone, or not his to read */ }
  try { if (/(^|\0)DISCORD_BOT_TOKEN=[^\0]/.test(readFileSync(`/proc/${pid}/environ`, "latin1"))) carried ||= `process ${pid}'s environment`; } catch { /* not his */ }
}
must(`no process he can see carries the bot token${carried ? ` (${carried})` : ""}`, !carried);

if (NO_LINK) { console.log(JSON.stringify({ ok: failed.length === 0, failed, unchecked, checks })); process.exit(0); }

// 5. Home Assistant's Supervisor without its token: refused (or not there at all), never answered.
const supervisor = await fetch("http://supervisor/info", { signal: AbortSignal.timeout(3000) }).then((r) => r.status).catch(() => 0);
must("the Supervisor refuses him without its token", !(supervisor >= 200 && supervisor < 300));
// The panel's sockets (the terminal, the review sign-in): his user can't connect.
const connects = (path: string) => new Promise<boolean>((done) => {
  const s = connect(path);
  s.on("connect", () => { s.destroy(); done(true); });
  s.on("error", () => done(false));
  setTimeout(() => { s.destroy(); done(false); }, 3000);
});
for (const sock of ["/run/cain-web/upstream/ttyd.sock", "/run/cain-web/upstream/codex.sock"])
  must(`can't reach ${sock}`, !(await connects(sock)));

// 6. The link: his key opens none of the specialist's routes, nor root's; nothing opens without
// one. A breach is a request it took (2xx); no answer at all is the link not up yet: unchecked.
async function post(path: string, key: string | null): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:8097${path}`, { method: "POST", body: "{}",
      headers: { "content-type": "application/json", ...(key ? { "x-harness-key": key } : {}) }, signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch { return 0; }
}
let mine = "";
try { mine = readFileSync("/run/cain/keys/cain.key", "utf8").trim(); } catch { /* below */ }
must("has his own link key", mine.length === 64);
const took = (s: number) => s >= 200 && s < 300;
for (const [route, key] of [["/card", mine], ["/buttons", mine], ["/relay", mine], ["/sent", mine], ["/ask", null]] as const) {
  const s = await post(route, key);
  if (s === 0) { unchecked.push(`${key ? "his key on" : "no key on"} ${route}: the link didn't answer`); continue; }
  must(key ? `his key can't call ${route}` : `no key opens ${route}`, !took(s));
}
// Root's socket to the link: his user can't connect.
must("can't reach the link's root socket", !(await connects("/run/cain/link.sock")));

console.log(JSON.stringify({ ok: failed.length === 0, failed, unchecked, checks }));
