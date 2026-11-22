// The keeper's service (core.ts has the rules):
//   bun main.ts serve                 the service: a poll every 30 seconds, a heartbeat every minute,
//                                     the HTTP service on port 8097 (the internal App network only)
//   bun main.ts drill-record <id>     a drill record from the keeper's own result for that attempt
//                                     (asks the running service; it decides from its own state alone)
//   bun main.ts phone-test            (0.1.3) the phone test drill: pages each watched App's alert check once,
//                                     and (0.1.4) the dead-man check; (0.1.6) prints a one-time code in the log
//   bun main.ts phone-confirm <code> <check>...   (0.1.3) once those pages reached the owner's phone: records it
//                                     (14 days) for each check named (0.1.6: an App's short name, or deadman)
//   bun main.ts key-confirm <fp> <code>   (0.1.4) the owner confirms ship_public_key by its fingerprint (0.1.5: the
//                                     first pin, a new state and a rotation alike; 0.1.6: with the code from the log)
//   bun main.ts missed-heartbeat      (0.1.6) the missed-heartbeat drill: the heartbeat ping stops until Healthchecks
//                                     pages; prints a one-time code
//   bun main.ts missed-heartbeat-confirm <code>   (0.1.6) once that page reached the owner's phone
//   bun main.ts accept-limits <code>  (0.1.7) the owner accepts DOCS.md's "Accepted limits" (code printed at start)
//   bun main.ts hc-key <code>         (0.1.7) the Healthchecks read-only key, read from standard input (never the
//                                     command line), checked and kept in /data/hc-key (0600); prints nothing of it
// The owner's commands go to the loopback listener (127.0.0.1:8096), never the App network's (0.1.6).
//   bun main.ts selftest              the image's own check (CI): the code loads and the version reads
// Its state is /data/state.json, written whole (temp file, fsync, rename). Nothing of it is in /share.
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { HEARTBEAT_MS, type HcCheck, Keeper, POLL_MS, type State } from "./core.ts";
import { handle, handleLocal } from "./server.ts";
import { supervisor } from "./supervisor.ts";

export const PORT = Number(process.env.KEEPER_PORT ?? 8097);
export const LOCAL_PORT = Number(process.env.KEEPER_LOCAL_PORT ?? 8096);   // (0.1.6) the owner's commands, loopback only
const DATA = process.env.KEEPER_DATA ?? "/data";
const STATE = `${DATA}/state.json`;
const OPTIONS = `${DATA}/options.json`;
// (0.1.7) The Healthchecks key's file: root-only, never in the options, and left out of the keeper's own backups
// (config.yaml backup_exclude names it).
export const HC_KEY_FILE = `${DATA}/hc-key`;
export function hcKeyStore(path = HC_KEY_FILE) {
  return {
    load: (): string => { try { return readFileSync(path, "utf8").trim(); } catch { return ""; } },
    store: (key: string): boolean => { try { writeWhole(path, `${key}\n`); chmodSync(path, 0o600); return true; } catch { return false; } },
  };
}
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
// (0.1.5) The Healthchecks management API's checks (GET /api/v3/checks/, the key in X-Api-Key, never
// logged). Null when it can't be read. healthchecks.io only: a self-hosted Healthchecks isn't read.
export const HC_API = "https://healthchecks.io/api/v3/checks/";
export async function hcChecks(key: string, http: typeof fetch = fetch): Promise<HcCheck[] | null> {
  try {
    const r = await http(HC_API, { headers: { "x-api-key": key }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.checks)) return null;
    return j.checks.filter((c: any) => c && typeof c === "object").map((c: any) => {
      const out: HcCheck = {};
      for (const k of ["name", "slug", "ping_url", "unique_key", "status", "channels", "schedule"] as const) if (typeof c[k] === "string") (out as any)[k] = c[k];
      for (const k of ["timeout", "grace"] as const) if (typeof c[k] === "number") out[k] = c[k];
      return out;
    });
  } catch { return null; }
}

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
    appInfo: sup.appInfo, backupInfo: sup.backupInfo, makeBackup: sup.makeBackup, restore: sup.restore, deleteBackup: sup.deleteBackup, job: sup.job, hcChecks: (key) => hcChecks(key),
    backups: sup.backups, activeJobs: sup.activeJobs, hcKeyStore: hcKeyStore(),
    ready: (hp) => get200(healthUrl(hp)),
    live: (hp) => get200(liveUrl(hp)),
    ping: async (url, body) => {
      try { const r = await fetch(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "text/plain" } }); return r.status >= 200 && r.status < 300; }
      catch { return false; }
    },
    // The options as the Supervisor holds them (the file is written only at the keeper's start); the
    // Supervisor not answering keeps the last ones read in force. The keeper never writes options.
    options: () => sup.selfOptions(),
    // 0.1.5: false when the write failed, so a claim is refused rather than answered unsaved.
    save: (s: State) => { try { writeWhole(STATE, JSON.stringify(s)); return true; } catch (e) { log(`couldn't save its state: ${String((e as Error)?.message ?? e).slice(0, 80)}`); return false; } },
    log,
  }, readJson(STATE));
  // 0.1.3: the options as they are; nothing is filled in from a kept copy.
  k.useOptions(readJson(OPTIONS));
  // (0.1.7) and as the Supervisor holds them, where an option the schema dropped (hc_api_key) still shows
  const held = await sup.selfOptions().catch(() => null);
  if (held) k.useOptions(held);
  k.start();
  const o = k.opts;
  log(`Keeper ${version} watching ${o.watch.join(", ") || "nothing"}; Healthchecks ${k.armable() ? "set" : "not all set, so the keeper is not armable"}`);
  process.on("SIGTERM", () => {
    const open = k.open();
    if (open.length) log(`stopping with ${open.map((a) => `${a.id} (${a.status})`).join(", ")} open: it resumes at the next start, and an update of the keeper should wait until it ends`);
    k.save();
    process.exit(0);
  });
  // 0.1.5: POST /attempt answers at once (the backup runs in the background), so no request is held open.
  Bun.serve({ port: PORT, hostname: "0.0.0.0", idleTimeout: 30, maxRequestBodySize: 4096,
    fetch: (req, server) => handle(k, req, server.requestIP(req)?.address ?? "", log) });
  // 0.1.6: the owner's commands, on the container's own loopback only (the App network can't reach it).
  Bun.serve({ port: LOCAL_PORT, hostname: "127.0.0.1", idleTimeout: 30, maxRequestBodySize: 4096,
    fetch: (req, server) => handleLocal(k, req, server.requestIP(req)?.address ?? "", log) });
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

// (0.1.6) The owner's commands and the body each sends to the loopback listener.
const LOCAL_CMDS: Record<string, (a: string[]) => unknown> = {
  "drill-record": (a) => ({ attempt: a[0] ?? "" }),
  "phone-test": () => ({}),
  "phone-confirm": (a) => ({ code: a[0] ?? "", checks: a.slice(1) }),
  "key-confirm": (a) => ({ fingerprint: a[0] ?? "", code: a[1] ?? "" }),
  "missed-heartbeat": () => ({}),
  "missed-heartbeat-confirm": (a) => ({ code: a[0] ?? "" }),
  "accept-limits": (a) => ({ code: a[0] ?? "" }),
  "hc-key": (a) => ({ code: a[0] ?? "" }),          // (0.1.7) the key itself is added from standard input
};
const DONE: Record<string, string> = {
  "drill-record": "drill recorded", "phone-test": "phone test sent: once the pages reached your phone, phone-confirm <code from the log> <each check>",
  "phone-confirm": "phone test recorded", "key-confirm": "Ship key confirmed",
  "missed-heartbeat": "missed-heartbeat drill started: once its page reached your phone, missed-heartbeat-confirm <code from the log>",
  "missed-heartbeat-confirm": "missed-heartbeat drill recorded",
  "accept-limits": "the accepted limits are recorded", "hc-key": "the Healthchecks read-only key is checked and kept",
};
// (0.1.7) The key from standard input, first line, trimmed; never echoed.
async function readStdinKey(): Promise<string> {
  try { return (await Bun.stdin.text()).split("\n")[0].trim(); } catch { return ""; }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "serve") await serve();
  else if (LOCAL_CMDS[cmd]) {
    const body: any = LOCAL_CMDS[cmd](rest);
    if (cmd === "hc-key") {
      if (rest.length > 1) { console.error("hc-key takes only the code: the key goes on standard input, never the command line"); process.exit(2); }
      body.key = await readStdinKey();
    }
    const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/${cmd}`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    console.log(j?.ok ? `${DONE[cmd]}${j.why ? ` (${j.why})` : ""}` : `not done: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "selftest") {
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error(`the image's KEEPER_VERSION isn't a version: ${VERSION}`); process.exit(1); }
    console.log(`keeper ${VERSION}: the code loads`);
  } else { console.error("usage: main.ts serve | drill-record <attempt id> | phone-test | phone-confirm <code> <check>... | key-confirm <fingerprint> <code> | missed-heartbeat | missed-heartbeat-confirm <code> | accept-limits <code> | hc-key <code> (key on stdin) | selftest"); process.exit(2); }
}
