// The keeper's service (core.ts has the rules):
//   bun main.ts serve                 the service: a poll every 30 seconds, a heartbeat every minute,
//                                     the HTTP service on port 8097 (the internal App network only)
//   bun main.ts drill-record <id>     a drill record from the keeper's own result for that attempt
//                                     (asks the running service; it decides from its own state alone)
//   bun main.ts phone-test            (0.1.3) the phone test drill: pages each watched App's alert check once,
//                                     and (0.1.4) the dead-man check
//   bun main.ts phone-confirm         (0.1.3) once those pages reached the owner's phone: records it (30 days)
//   bun main.ts key-confirm <fp>      (0.1.4) the owner confirms a changed ship_public_key by its fingerprint
//   bun main.ts selftest              the image's own check (CI): the code loads and the version reads
// Its state is /data/state.json, written whole (temp file, fsync, rename). Nothing of it is in /share.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { HEARTBEAT_MS, Keeper, POLL_MS, type State } from "./core.ts";
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
// The address the keeper polls for a watched App (option health, "host:port" or "host:port/path";
// 0.1.1: Cain's default names /ready, his readiness; no path is /health).
export function healthUrl(hp: string): string | null {
  const m = /^([A-Za-z0-9.-]{1,253}:\d{1,5})(\/[A-Za-z0-9._\/-]{0,64})?$/.exec(hp);
  return m ? `http://${m[1]}${m[2] || "/health"}` : null;
}
// The same host's liveness address, /health: the one the install check and the rollback's confirmation
// decide on (0.1.3); the health address's own path (Cain's /ready) is only reported, as chat connected.
export function liveUrl(hp: string): string | null {
  const m = /^([A-Za-z0-9.-]{1,253}:\d{1,5})(\/[A-Za-z0-9._\/-]{0,64})?$/.exec(hp);
  return m ? `http://${m[1]}/health` : null;
}
async function get200(url: string | null): Promise<boolean> {
  if (!url) return false;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" }); return r.status === 200; } catch { return false; }
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
    appInfo: sup.appInfo, backupInfo: sup.backupInfo, makeBackup: sup.makeBackup, restore: sup.restore, job: sup.job, restoreJobs: sup.restoreJobs,
    ready: (hp) => get200(healthUrl(hp)),
    live: (hp) => get200(liveUrl(hp)),
    ping: async (url, body) => {
      try { const r = await fetch(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "text/plain" } }); return r.status >= 200 && r.status < 300; }
      catch { return false; }
    },
    // The options as the Supervisor holds them (the file is written only at the keeper's start); the
    // Supervisor not answering keeps the last ones read in force. The keeper never writes options.
    options: () => sup.selfOptions(),
    save: (s: State) => { try { writeWhole(STATE, JSON.stringify(s)); } catch (e) { log(`couldn't save its state: ${String((e as Error)?.message ?? e).slice(0, 80)}`); } },
    log,
  }, readJson(STATE));
  // 0.1.3: the options as they are; nothing is filled in from a kept copy.
  k.useOptions(readJson(OPTIONS));
  k.start();
  const o = k.opts;
  log(`Keeper ${version} watching ${o.watch.join(", ") || "nothing"}; Healthchecks ${k.armable() ? "set" : "not all set, so the keeper is not armable"}`);
  process.on("SIGTERM", () => {
    const open = k.open();
    if (open.length) log(`stopping with ${open.map((a) => `${a.id} (${a.status})`).join(", ")} open: it resumes at the next start, and an update of the keeper should wait until it ends`);
    k.save();
    process.exit(0);
  });
  // idleTimeout 255 (Bun's most): POST /attempt answers only once the keeper's backup is done (0.1.4, up to 4 minutes).
  Bun.serve({ port: PORT, hostname: "0.0.0.0", idleTimeout: 255, maxRequestBodySize: 4096,
    fetch: (req, server) => handle(k, req, server.requestIP(req)?.address ?? "", log) });
  const tick = async () => { try { await k.poll(); } catch (e) { log(`a poll failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`); } };
  await tick();
  setInterval(tick, POLL_MS);
  setInterval(() => k.heartbeat(), HEARTBEAT_MS);
  // The dead-man check (0.1.3): its own timer, apart from the poll, so it stops only with the process.
  let deadmanSaid = false;
  // 0.1.4: only while the poll loop completed within 3 minutes; otherwise its /fail ping, logged loudly.
  const deadman = async () => {
    const stalled = k.loopStalled();
    const ok = await k.deadman().catch(() => false);
    if (!ok && !deadmanSaid && k.opts.hc_deadman) log(stalled ? "THE POLL LOOP HASN'T COMPLETED FOR OVER 3 MINUTES: the dead-man check gets its fail ping, not keeper alive" : "a dead-man ping wasn't delivered: tried again in a minute");
    deadmanSaid = !ok;
  };
  void deadman();
  setInterval(() => { void deadman(); }, HEARTBEAT_MS);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "serve") await serve();
  else if (cmd === "drill-record") {
    const r = await fetch(`http://127.0.0.1:${PORT}/drill-record`, { method: "POST", body: JSON.stringify({ attempt: arg ?? "" }) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    console.log(j?.ok ? `drill recorded: ${arg}` : `no drill record: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "phone-test" || cmd === "phone-confirm") {
    const r = await fetch(`http://127.0.0.1:${PORT}/${cmd}`, { method: "POST", body: "{}" }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    console.log(j?.ok ? (cmd === "phone-test" ? "phone test sent: confirm with phone-confirm once it reached your phone" : "phone test recorded") : `not done: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "key-confirm") {
    const r = await fetch(`http://127.0.0.1:${PORT}/key-confirm`, { method: "POST", body: JSON.stringify({ fingerprint: arg ?? "" }) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    console.log(j?.ok ? `Ship key confirmed: ${arg}` : `not confirmed: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "selftest") {
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error(`the image's KEEPER_VERSION isn't a version: ${VERSION}`); process.exit(1); }
    console.log(`keeper ${VERSION}: the code loads`);
  } else { console.error("usage: main.ts serve | drill-record <attempt id> | phone-test | phone-confirm | key-confirm <fingerprint> | selftest"); process.exit(2); }
}
