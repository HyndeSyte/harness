// The keeper's service (core.ts has the rules):
//   bun main.ts serve                 the service: a poll every 30 seconds, a heartbeat every minute,
//                                     the HTTP service on port 8097 (the internal App network only)
//   bun main.ts drill-record <id>     a drill record from the keeper's own result for that attempt
//                                     (asks the running service; it decides from its own state alone)
//   bun main.ts selftest              the image's own check (CI): the code loads and the version reads
// Its state is /data/state.json, written whole (temp file, fsync, rename). Nothing of it is in /share.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { HEARTBEAT_MS, Keeper, POLL_MS, parseOptions, type State } from "./core.ts";
import { handle } from "./server.ts";
import { supervisor } from "./supervisor.ts";

export const PORT = Number(process.env.KEEPER_PORT ?? 8097);
const DATA = process.env.KEEPER_DATA ?? "/data";
const STATE = `${DATA}/state.json`;
const OPTIONS = `${DATA}/options.json`;
export const VERSION = process.env.KEEPER_VERSION ?? "0.0.0";
const log = (m: string) => console.log(`[keeper] ${m}`);

export function writeWhole(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

async function serve(): Promise<void> {
  const token = process.env.SUPERVISOR_TOKEN ?? "";
  delete process.env.SUPERVISOR_TOKEN;
  if (!token) log("no Supervisor token: the keeper can read nothing and restore nothing");
  const sup = supervisor(token);
  const me = await sup.selfInfo().catch(() => null);
  const self = me?.slug ?? "keeper";
  const version = VERSION;
  if (me && me.version && me.version !== version) log(`the Supervisor says this is ${me.version}, the image says ${version}: the image's is bound`);
  const k = new Keeper({
    now: Date.now, version, self,
    appInfo: sup.appInfo, backupInfo: sup.backupInfo, restore: sup.restore,
    health: async (hp) => {
      if (!/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/.test(hp)) return false;
      try { const r = await fetch(`http://${hp}/health`, { signal: AbortSignal.timeout(5_000), redirect: "manual" }); return r.status === 200; } catch { return false; }
    },
    ping: async (url, body) => {
      try { const r = await fetch(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "text/plain" } }); return r.status >= 200 && r.status < 300; }
      catch { return false; }
    },
    options: () => readJson(OPTIONS),
    save: (s: State) => { try { writeWhole(STATE, JSON.stringify(s)); } catch (e) { log(`couldn't save its state: ${String((e as Error)?.message ?? e).slice(0, 80)}`); } },
    log,
  }, readJson(STATE));
  const o = parseOptions(readJson(OPTIONS));
  k.opts = o;
  k.start();
  log(`Keeper ${version} watching ${o.watch.join(", ") || "nothing"}; Healthchecks ${o.hc_done && o.hc_failed ? "set" : "not set, so the keeper is not armable"}`);
  process.on("SIGTERM", () => {
    const open = k.open();
    if (open.length) log(`stopping with ${open.map((a) => `${a.id} (${a.status})`).join(", ")} open: it resumes at the next start, and an update of the keeper should wait until it ends`);
    k.save();
    process.exit(0);
  });
  Bun.serve({ port: PORT, hostname: "0.0.0.0", idleTimeout: 30, maxRequestBodySize: 4096,
    fetch: (req, server) => handle(k, req, server.requestIP(req)?.address ?? "", log) });
  const tick = async () => { try { await k.poll(); } catch (e) { log(`a poll failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`); } };
  await tick();
  setInterval(tick, POLL_MS);
  setInterval(() => k.heartbeat(), HEARTBEAT_MS);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "serve") await serve();
  else if (cmd === "drill-record") {
    const r = await fetch(`http://127.0.0.1:${PORT}/drill-record`, { method: "POST", body: JSON.stringify({ attempt: arg ?? "" }) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    console.log(j?.ok ? `drill recorded: ${arg}` : `no drill record: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "selftest") {
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error(`the image's KEEPER_VERSION isn't a version: ${VERSION}`); process.exit(1); }
    console.log(`keeper ${VERSION}: the code loads`);
  } else { console.error("usage: main.ts serve | drill-record <attempt id> | selftest"); process.exit(2); }
}
