// The c1 check (C1 plan 3.12, state C): run as Cain's own user at each start, by root through
// as-cain (c1/check.sh), which keeps its answer: one line of JSON, {ok, failed, checks}. Each
// check is something his user must not be able to do, tried for real, or a fact of his
// process the kernel reports. Root writes the result; he can read it, never be its reporter.
import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const failed: string[] = [];
let checks = 0;
const must = (name: string, ok: boolean) => { checks++; if (!ok) failed.push(name); };
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

// 2. Writes his user must not make.
for (const p of ["/etc/claude-code/managed-settings.json", "/etc/claude-code/CLAUDE.md", "/opt/cain/settings.json",
  "/run/s6/c1check-probe", "/usr/local/bin/c1check-probe", "/data/trust/c1check.json", "/data/review-queue/c1check-probe"])
  must(`can't write ${p}`, refused(() => closeSync(openSync(p, "a"))));

// 3. What the kernel says of this process: no capabilities, no way to gain any, his ids only.
const status = readFileSync("/proc/self/status", "utf8");
const field = (k: string) => (status.match(new RegExp(`^${k}:\\s+(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
for (const k of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) must(`${k} is 0`, /^0+$/.test(field(k)));
must("no_new_privs", field("NoNewPrivs") === "1");
must("his uid only", field("Uid").split(/\s+/).every((x) => x === "1000"));
must("his gid only", field("Gid").split(/\s+/).every((x) => x === "1000"));
must("his group only", field("Groups") === "1000");

// 4. The link: his key opens none of the specialist's routes, nor root's; nothing opens without one.
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
for (const route of ["/card", "/buttons", "/relay", "/sent"]) must(`his key can't call ${route}`, (await post(route, mine)) === 403);
must("no key opens /ask", (await post("/ask", null)) === 403);
// Root's socket to the link: his user can't connect.
const sockRefused = await new Promise<boolean>((done) => {
  const s = connect("/run/cain/link.sock");
  s.on("connect", () => { s.destroy(); done(false); });
  s.on("error", () => done(true));
  setTimeout(() => { s.destroy(); done(true); }, 3000);
});
must("can't reach the link's root socket", sockRefused);

console.log(JSON.stringify({ ok: failed.length === 0, failed, checks }));
