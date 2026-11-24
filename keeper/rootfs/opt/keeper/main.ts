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
//   bun main.ts key-code              (0.1.8) a fresh key-confirm code in the log (0.1.9: the only way one is printed)
//   bun main.ts backup-check          (0.1.9) a test backup of Keeper, downloaded and scanned for key files and keys
// The owner's commands go to the loopback listener (127.0.0.1:8096), never the App network's (0.1.6).
//   bun main.ts selftest              the image's own check (CI): the code loads and the version reads
// Its state is /data/state.json, written whole (temp file, fsync, rename). Nothing of it is in /share.
import { closeSync, constants as FS, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { BACKUP_KEY_SENTINEL, BACKUP_KEY_TMP_PREFIX, BACKUP_KEYS_DIR, CHECK_CONTROL_FILE, HEARTBEAT_MS, type HcCheck, KEY_FILE, KEY_TMP_PREFIX, Keeper, LEGACY_KEY_TMP, OLD_KEY_FILE, POLL_MS, type State } from "./core.ts";
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
// 0.1.8: written 0600 from its first byte (writeWhole: an exclusive temporary file opened 0600 in the data folder, the
// key written and fsynced, then renamed into place), never a write followed by a chmod. onTemp: tests only, called
// with the temporary file's path once the key is in it, before the rename.
// 0.1.9: its temporary file has the fixed prefix hc-key.tmp- (KEY_TMP_PREFIX), which backup_exclude's "hc-key*" covers,
// so a crash between the write and the rename leaves nothing outside the exclusion; leftovers are swept at every start.
export function hcKeyStore(path = HC_KEY_FILE, onTemp?: (tmp: string) => void) {
  return {
    load: (): string => { try { const k = readFileSync(path, "utf8").trim(); return k.startsWith(SENTINEL) ? "" : k; } catch { return ""; } },
    store: (key: string): boolean => { try { writeWhole(path, `${key}\n`, onTemp, keyTmp(path)); return true; } catch { return false; } },
  };
}
// (0.1.12) The backup key store: one root-only file per backup Keeper makes of a watched App, named by the backup's name, holding
// its password, in a root-only folder (0700) the backup exclusion leaves out (config.yaml backup_exclude: backup-keys and
// everything in it). Written whole (writeWhole: a temporary file with the fixed prefix tmp- in the same folder, 0600 from its
// first byte, fsynced, renamed). Never in the options, the state or a log line. onTemp: tests only, as hcKeyStore's.
export const BACKUP_KEYS_PATH = `${DATA}/${BACKUP_KEYS_DIR}`;
export function backupKeys(dir = BACKUP_KEYS_PATH, onTemp?: (tmp: string) => void) {
  const ok = (n: string) => typeof n === "string" && n.length > 0 && n.length <= 200 && basename(n) === n && n !== "." && n !== ".." && !n.startsWith(BACKUP_KEY_TMP_PREFIX);
  return {
    store: (name: string, key: string): boolean => {
      if (!ok(name)) return false;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });   // root-only from its creation (never a chmod after)
        writeWhole(join(dir, name), `${key}\n`, onTemp, join(dir, `${BACKUP_KEY_TMP_PREFIX}${randomBytes(6).toString("hex")}`));
        return true;
      } catch { return false; }
    },
    load: (name: string): string | null => { if (!ok(name)) return null; try { const k = readFileSync(join(dir, name), "utf8").trim(); return k && !k.startsWith(SENTINEL) ? k : null; } catch { return null; } },
    drop: (name: string): boolean => { if (basename(name) !== name || !name) return false; const p = join(dir, name); if (!existsSync(p)) return false; rmSync(p, { force: true }); return true; },
    list: (): string[] => { try { return readdirSync(dir); } catch { return []; } },
  };
}
// (0.1.9) The old hc_api_key, kept only to try it once at the rotation's attestation, then dropped.
export const OLD_KEY_PATH = `${DATA}/${OLD_KEY_FILE}`;
// 0.1.10: name, the file's name in the data folder, which core.ts checks inside the backup exclusion before it stores a key.
export function oldKeyStore(path = OLD_KEY_PATH) {
  return { ...hcKeyStore(path), drop: () => { rmSync(path, { force: true }); }, name: basename(path) };
}
const SENTINEL = "keeper-sentinel-";
export const keyTmp = (path: string) => join(dirname(path), `${KEY_TMP_PREFIX}${randomBytes(6).toString("hex")}`);
// (0.1.9) The key files' names in the data folder, for the backup check and the start's sweep: place a sentinel in every
// name (current and legacy, never over a real key), clear what was placed, and sweep leftovers (temporary files of both
// spellings, and a sentinel left by an interrupted check).
// 0.1.10: skip names a kept key's file, never written over; read reads one back (the check verifies each sentinel landed);
// control writes the positive control in a file the exclusion doesn't cover; clear removes it with the sentinels, and sweep
// removes a control an interrupted check left.
export function keyFiles(dir = DATA) {
  let placed: string[] = [];
  // a name in the data folder, or (0.1.12) one in the backup key store
  const inStore = (n: string) => basename(n) === n || (dirname(n) === BACKUP_KEYS_DIR && basename(n) !== "" && !basename(n).startsWith("."));
  const put = (name: string, body: string) => { const p = join(dir, name); if (existsSync(p)) return; const fd = openSync(p, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600); try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); } placed.push(name); };
  return {
    place: (sentinel: string, skip: string[] = []): string[] => {
      placed = [];
      for (const n of [KEY_FILE, OLD_KEY_FILE]) if (!skip.includes(n)) put(n, `${sentinel}\n`);
      put(`${KEY_TMP_PREFIX}${randomBytes(6).toString("hex")}`, `${sentinel}\n`);
      put(`${KEY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`, `${sentinel}\n`);   // the 0.1.7 and 0.1.8 temporary name
      // (0.1.12) the backup key store: a sentinel under a fixed name there, and one under its temporary prefix (never a backup's name)
      try { mkdirSync(join(dir, BACKUP_KEYS_DIR), { recursive: true, mode: 0o700 }); } catch { /* the check fails on the missing sentinel */ }
      try { put(`${BACKUP_KEYS_DIR}/${BACKUP_KEY_SENTINEL}`, `${sentinel}\n`); } catch { /* idem */ }
      try { put(`${BACKUP_KEYS_DIR}/${BACKUP_KEY_TMP_PREFIX}${randomBytes(6).toString("hex")}`, `${sentinel}\n`); } catch { /* idem */ }
      return [...placed];
    },
    read: (name: string): string | null => { if (!inStore(name)) return null; try { return readFileSync(join(dir, name), "utf8").trim(); } catch { return null; } },
    control: (value: string): string | null => { try { rmSync(join(dir, CHECK_CONTROL_FILE), { force: true }); put(CHECK_CONTROL_FILE, `${value}\n`); return CHECK_CONTROL_FILE; } catch { return null; } },
    clear: (): void => { for (const n of placed) rmSync(join(dir, n), { force: true }); placed = []; },
    sweep: (): string[] => {
      const out: string[] = [];
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        let gone = n.startsWith(KEY_TMP_PREFIX) || LEGACY_KEY_TMP.test(n) || n === CHECK_CONTROL_FILE;
        if (!gone && (n === KEY_FILE || n === OLD_KEY_FILE)) { try { gone = readFileSync(p, "utf8").startsWith(SENTINEL); } catch { gone = false; } }
        if (gone) { rmSync(p, { force: true }); out.push(n); }
      }
      // (0.1.12) a sentinel an interrupted check left in the backup key store (never a backup's key: those hold no sentinel)
      try {
        for (const n of readdirSync(join(dir, BACKUP_KEYS_DIR))) {
          const p = join(dir, BACKUP_KEYS_DIR, n);
          let gone = false; try { gone = readFileSync(p, "utf8").startsWith(SENTINEL); } catch { gone = false; }
          if (gone) { rmSync(p, { force: true }); out.push(`${BACKUP_KEYS_DIR}/${n}`); }
        }
      } catch { /* no store yet */ }
      return out;
    },
  };
}
export const VERSION = process.env.KEEPER_VERSION ?? "0.0.0";
const log = (m: string) => console.log(`[keeper] ${m}`);

// A file written whole: a temporary file beside it, created exclusively (O_EXCL, so never one that already exists)
// with mode 0600 from its first byte, the body written and fsynced, then renamed into place and the folder fsynced
// (0.1.8), so the state's counter is on disk before /armed answers with it.
export function writeWhole(path: string, body: string, onTemp?: (tmp: string) => void, tmpPath?: string): void {
  const tmp = tmpPath ?? `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
  try {
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    onTemp?.(tmp);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* the folder's fsync is best effort */ }
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

// (0.1.9) The old key tried once at the Healthchecks API. 0.1.10: a GET of the checks list (read-only, no side effects, and
// the endpoint the old hc_api_key option was used for from 0.1.5), answering its status and the API's error text; core.ts
// revocation() judges it (a 401 or "wrong api key" proves it revoked, never a bare 403). Null: no answer.
export async function hcTry(key: string, http: typeof fetch = fetch): Promise<{ status: number; error?: string } | null> {
  try {
    const r = await http(HC_API, { method: "GET", headers: { "x-api-key": key }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    let error: string | undefined;
    try { const j: any = await r.json(); if (typeof j?.error === "string") error = j.error.slice(0, 80); } catch { /* no body */ }
    return { status: r.status, ...(error ? { error } : {}) };
  } catch { return null; }
}
// (0.1.10) The backup check's download, through a file in its own folder (removed after it is read): one an interrupted
// check left behind is removed at the next start (archives().sweep).
export const ARCHIVE_DIR = process.env.KEEPER_ARCHIVE_DIR ?? "/tmp/keeper-backup-check";
export function archives(dir = ARCHIVE_DIR) {
  return {
    sweep: (): string[] => { try { return readdirSync(dir).filter((n) => n.endsWith(".tar")).map((n) => { rmSync(join(dir, n), { force: true }); return n; }); } catch { return []; } },
    through: async (slug: string, fetchTo: (path: string) => Promise<boolean>): Promise<Uint8Array | null> => {
      const { mkdirSync } = await import("node:fs");
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
      const path = join(dir, `${slug.replace(/[^A-Za-z0-9_-]/g, "_")}.tar`);
      try { if (!(await fetchTo(path))) return null; return new Uint8Array(readFileSync(path)); } catch { return null; } finally { rmSync(path, { force: true }); }
    },
  };
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
    backups: sup.backups, activeJobs: sup.activeJobs, installStartedAt: sup.installStartedAt, hcKeyStore: hcKeyStore(),
    diskFree: sup.diskFree, download: (slug) => archives().through(slug, (path) => sup.downloadTo(slug, path)), archives: archives(),
    keyFiles: keyFiles(), oldKeyStore: oldKeyStore(), backupKeys: backupKeys(), hcTry: (key) => hcTry(key),
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
  else k.optionsUnreadable();                     // (0.1.9) counts as the old option present until a read answers
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
  "key-code": () => ({}),                            // (0.1.8)
  "backup-check": () => ({}),                        // (0.1.9)
};
const DONE: Record<string, string> = {
  "drill-record": "drill recorded", "phone-test": "phone test sent: once the pages reached your phone, phone-confirm <code from the log> <each check>",
  "phone-confirm": "phone test recorded", "key-confirm": "Ship key confirmed",
  "missed-heartbeat": "missed-heartbeat drill started: once its page reached your phone, missed-heartbeat-confirm <code from the log>",
  "missed-heartbeat-confirm": "missed-heartbeat drill recorded",
  "accept-limits": "the accepted limits are recorded", "hc-key": "the Healthchecks read-only key is checked and kept",
  "key-code": "a fresh key-confirm code is printed in Keeper's log",
  "backup-check": "the backup check passed: a test backup of Keeper leaves out every key file and holds no key",
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
  } else { console.error("usage: main.ts serve | drill-record <attempt id> | phone-test | phone-confirm <code> <check>... | key-confirm <fingerprint> <code> | missed-heartbeat | missed-heartbeat-confirm <code> | accept-limits <code> | hc-key <code> (key on stdin) | key-code | backup-check | selftest"); process.exit(2); }
}
