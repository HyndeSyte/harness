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
import { closeSync, constants as FS, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { BACKUP_CHECK_BUSY, BACKUP_KEY_SENTINEL, inWords, BACKUP_KEY_TMP_PREFIX, BACKUP_KEYS_DIR, CHECK_CONTROL_FILE, DRILL_SPENT_DIR, DRILL_SPENT_SENTINEL, HEARTBEAT_MS, type HcCheck, KEY_FILE, KEY_TMP_PREFIX, Keeper, LEGACY_KEY_TMP, OLD_KEY_FILE, POLL_MS, type State } from "./core.ts";
import { handle, handleLocal } from "./server.ts";
import { supervisor } from "./supervisor.ts";
import { type ArchiveFile, budgetWhy, type Needle, OVER_LIMIT_EXIT, type ScanResult } from "./scan.ts";

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
// (0.1.15) item 10: the drill flags' spent list, root's: one empty file per nonce in a 0700 folder the backup exclusion leaves out
// (config.yaml backup_exclude: drill-spent and everything in it), so a restore of Keeper never rolls it back (the Supervisor keeps
// excluded paths on a restore: a device check). add creates the nonce's file exclusively and fsyncs it and the folder; a nonce
// already there is false. Nothing is ever pruned from it (the files are empty; a nonce is 16 hex digits).
export const DRILL_SPENT_PATH = `${DATA}/${DRILL_SPENT_DIR}`;
export function drillSpent(dir = DRILL_SPENT_PATH) {
  const NONCE = /^[0-9a-f]{16}$/;
  return {
    list: (): string[] => { try { return readdirSync(dir).filter((n) => NONCE.test(n)); } catch (e: any) { if (e?.code === "ENOENT") return []; throw e; } },
    add: (nonce: string): boolean => {
      if (!NONCE.test(nonce)) return false;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const fd = openSync(join(dir, nonce), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        try { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* the file itself is synced */ }
        return true;
      } catch { return false; }
    },
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
  const inStore = (n: string) => basename(n) === n || (dirname(n) === BACKUP_KEYS_DIR && basename(n) !== "" && !basename(n).startsWith("."))
    || n === `${DRILL_SPENT_DIR}/${DRILL_SPENT_SENTINEL}`;   // (0.1.16)
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
      // (0.1.16) the drill flags' spent list: a sentinel under a fixed name that is never a nonce (drillSpent lists only nonces)
      try { mkdirSync(join(dir, DRILL_SPENT_DIR), { recursive: true, mode: 0o700 }); } catch { /* the check fails on the missing sentinel */ }
      try { put(`${DRILL_SPENT_DIR}/${DRILL_SPENT_SENTINEL}`, `${sentinel}\n`); } catch { /* idem */ }
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
      // (0.1.16) and the one an interrupted check left in the drill flags' spent list (a nonce's file is empty, never a sentinel)
      try {
        const p = join(dir, DRILL_SPENT_DIR, DRILL_SPENT_SENTINEL);
        let gone = false; try { gone = readFileSync(p, "utf8").startsWith(SENTINEL); } catch { gone = false; }
        if (gone) { rmSync(p, { force: true }); out.push(`${DRILL_SPENT_DIR}/${DRILL_SPENT_SENTINEL}`); }
      } catch { /* no list yet */ }
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
// revocation() judges it (0.1.16: only "wrong api key" on a 401 or 403 proves it revoked; a bare 401 or 403 never does). Null:
// no answer. 0.1.16: the body is read bounded in time (HC_BODY_MS, the read aborted then) and size (the first HC_BODY_MAX bytes,
// the rest never read); the documented answer is looked for in that prefix only, and a body cut short by either bound carries no
// error text, so it proves nothing.
export const HC_BODY_MAX = 4096, HC_BODY_MS = 3_000;
export async function readCapped(r: Response, max = HC_BODY_MAX, ms = HC_BODY_MS): Promise<{ text: string; whole: boolean }> {
  const reader = r.body?.getReader();
  if (!reader) return { text: "", whole: true };
  const parts: Uint8Array[] = [];
  let n = 0, whole = false, t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => { t = setTimeout(() => res("timeout"), ms); (t as any)?.unref?.(); });
  try {
    while (n < max) {
      const x = await Promise.race([reader.read(), timeout]);
      if (x === "timeout") break;
      if (x.done) { whole = true; break; }
      parts.push(x.value); n += x.value.length;
    }
  } catch { whole = false; } finally {
    if (t) clearTimeout(t);
    if (!whole) { try { void reader.cancel().catch(() => {}); } catch { /* already closed */ } }
  }
  const all = new Uint8Array(Math.min(n, max)); let o = 0;
  for (const p of parts) { const take = p.subarray(0, Math.min(p.length, all.length - o)); all.set(take, o); o += take.length; if (o >= all.length) break; }
  return { text: new TextDecoder().decode(all), whole: whole && n <= max };
}
export async function hcTry(key: string, http: typeof fetch = fetch, bodyMs = HC_BODY_MS): Promise<{ status: number; error?: string } | null> {
  try {
    const r = await http(HC_API, { method: "GET", headers: { "x-api-key": key }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    let error: string | undefined;
    const body = await readCapped(r, HC_BODY_MAX, bodyMs).catch(() => ({ text: "", whole: false }));
    if (body.whole) { try { const j: any = JSON.parse(body.text); if (typeof j?.error === "string") error = j.error.slice(0, 80); } catch { /* not the documented body */ } }
    return { status: r.status, ...(error ? { error } : {}) };
  } catch { return null; }
}
// (0.1.10) The backup check's download, through a file in its own folder (removed after it is read): one an interrupted
// check left behind is removed at the next start (archives().sweep).
export const ARCHIVE_DIR = process.env.KEEPER_ARCHIVE_DIR ?? "/tmp/keeper-backup-check";
export function archives(dir = ARCHIVE_DIR) {
  return {
    sweep: (): string[] => { try { return readdirSync(dir).filter((n) => n.endsWith(".tar")).map((n) => { rmSync(join(dir, n), { force: true }); return n; }); } catch { return []; } },
    // 0.1.17: the file itself is answered (its path, its size and its removal), never its bytes read whole into memory; the scan
    // reads it a chunk at a time, and backupCheck removes it once the scan has ended
    // Fix round: fetchTo may answer why it failed (a string), handed on as { why }; the file's name always ends in .tar, so
    // sweep() finds it whatever the slug holds
    through: async (slug: string, fetchTo: (path: string) => Promise<boolean | string>): Promise<ArchiveFile | { why: string } | null> => {
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
      const path = join(dir, `${slug.replace(/[^A-Za-z0-9_-]/g, "_")}.tar`);
      const remove = () => { rmSync(path, { force: true }); };
      try {
        const ok = await fetchTo(path);
        if (ok !== true) { remove(); return typeof ok === "string" ? { why: ok } : null; }
        return { path, size: statSync(path).size, remove };
      } catch { try { remove(); } catch { /* swept at the next start */ } return null; }
    },
  };
}

// (0.1.17) The backup check's scan, in a child process of the service (scan.ts run as `bun --smol scan.ts child`): if the
// kernel's out-of-memory killer still picks it, it takes the child and not the service, which then counts the check failed,
// removes the sentinels, deletes the test backup and answers why, with the archive's size. The job goes to the child on its
// standard input (the needles are key values: never on a command line), with a bare environment (no Supervisor token). Its own
// memory limit: --smol (a smaller heap, collected sooner) and KEEPER_SCAN_RSS_MAX, its resident size sampled as it runs, over
// which it exits at once (OVER_LIMIT_EXIT). A scan running past its time (SCAN_CHILD_MS, or what the check's deadline leaves) is
// stopped.
// Fix round, the protocol can't hang: both pipes are read from the moment the child starts, while the job is written, each to its
// cap and drained past it (stderr's excess discarded; stdout past SCAN_OUT_MAX is an overflow), so the child never blocks on a
// full pipe; a failed write of the job (the child already gone: EPIPE) is caught and named; stdout's end, stderr's end and the
// exit are awaited together under the one deadline, and once the child has exited its pipes get PIPE_GRACE_MS to close (a
// grandchild holding one open fails the scan by name). On a timeout, an overflow, a read failure or an abort the child is killed
// and reaped and the pipes cancelled without waiting for their end. A result counts only as one schema-valid JSON line with exit
// 0: it never overrides a timeout, a signal or a non-zero exit. A stop is named in this order: the timeout (the service's own
// kill), the child's own memory limit, then signal 9 as "killed (signal 9)", "likely out of memory" only when the child's last
// reported memory sample was near its limit (NEAR_LIMIT of it).
export const SCAN_RSS_MAX = Number(process.env.KEEPER_SCAN_RSS_MAX ?? 384 * 1024 * 1024);
export const SCAN_CHILD_MS = 7 * 60_000;
export const SCAN_OUT_MAX = 1024 * 1024;
export const SCAN_ERR_MAX = 4096;
export const PIPE_GRACE_MS = 2000;
export const NEAR_LIMIT = 0.8;
const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;
// one pipe read to its end: the first `max` bytes kept (or, with lines, each line handed on and the last `max` bytes of the rest
// kept), everything past that read and dropped; over() is told once the cap is passed
function drain(s: ReadableStream<Uint8Array> | number | undefined | null, max: number, o: { over?: () => void; line?: (l: string) => boolean; fail?: (why: string) => void } = {}) {
  const parts: Uint8Array[] = []; let n = 0, kept = 0, partial = "", tail = "", passed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try { reader = s && typeof s === "object" ? s.getReader() : null; } catch { reader = null; }
  const done = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        n += value.length;
        if (o.line) {
          partial += Buffer.from(value).toString("utf8");
          const ls = partial.split("\n"); partial = ls.pop() ?? "";
          if (partial.length > max) partial = partial.slice(-max);
          for (const l of ls) if (!o.line(l)) tail = `${tail}${l}\n`.slice(-max);
        } else if (kept < max) { const p = value.subarray(0, max - kept); parts.push(p.slice()); kept += p.length; }
        if (n > max && !passed && o.over) { passed = true; o.over(); }
      }
    } catch (e) { o.fail?.(String((e as Error)?.message ?? e).slice(0, 60)); }
  })();
  return {
    done, get bytes() { return n; },
    text: () => (o.line ? `${tail}${partial}` : Buffer.concat(parts).toString("utf8")),
    cancel: () => { try { void reader?.cancel().catch(() => {}); } catch { /* gone */ } },
  };
}
// a result line, checked field by field
function resultOf(line: string): (ScanResult & { peakRss?: number; oomScoreAdj?: number | null }) | null {
  let r: any = null;
  try { r = JSON.parse(line); } catch { return null; }
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean" || typeof r.why !== "string" || !count(r.members) || !strs(r.names) || !strs(r.found) || !count(r.control)) return null;
  for (const k of ["expanded", "peakRss"]) if (r[k] !== undefined && !count(r[k])) return null;
  if (r.oomScoreAdj !== undefined && r.oomScoreAdj !== null && typeof r.oomScoreAdj !== "number") return null;
  return { ok: r.ok, why: r.why, members: r.members, names: r.names, found: r.found, control: r.control, expanded: r.expanded ?? 0, peakRss: r.peakRss ?? 0, oomScoreAdj: r.oomScoreAdj ?? null };
}
export async function scanChild(file: ArchiveFile, names: RegExp, needles: Needle[], control: string,
  o: { rssMax?: number; timeoutMs?: number; maxExpanded?: number; script?: string; log?: (l: string) => void; signal?: AbortSignal; onSpawn?: (pid: number) => void } = {}): Promise<ScanResult & { peakRss?: number; lastRss?: number; oomScoreAdj?: number | null }> {
  const rssMax = o.rssMax ?? SCAN_RSS_MAX, timeoutMs = o.timeoutMs ?? SCAN_CHILD_MS;
  const of = `the ${file.size}-byte (${mb(file.size)}) test backup`;
  const fail = (why: string, lastRss = 0) => ({ ok: false, why, members: 0, names: [], found: [], control: 0, lastRss });
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([process.execPath, "--smol", o.script ?? join(import.meta.dir, "scan.ts"), "child"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", KEEPER_SCAN_RSS_MAX: String(rssMax) },
    });
  } catch (e) { return fail(`the scan couldn't start (${String((e as Error)?.message ?? e).slice(0, 80)})`); }
  try { o.onSpawn?.(child.pid); } catch { /* a test's hook */ }
  // why it was stopped, if it was: the first reason wins, and the child is killed at once
  type Stop = "" | "timeout" | "overflow" | "io" | "held" | "aborted";
  let stop = "" as Stop, stopDetail = "";
  let wake = () => {};
  const stopped = new Promise<void>((res) => { wake = res; });
  const halt = (why: Exclude<Stop, "">, detail = "") => { if (stop) return; stop = why; stopDetail = detail; try { child.kill("SIGKILL"); } catch { /* gone */ } wake(); };
  const timer = setTimeout(() => halt("timeout"), timeoutMs);
  const onAbort = () => halt("aborted");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) halt("aborted");
  // both pipes read from the start, before the job is written
  let lastRss = 0, overAt = 0;
  const out = drain(child.stdout as any, SCAN_OUT_MAX, { over: () => halt("overflow"), fail: (w) => halt("io", w) });
  const err = drain(child.stderr as any, SCAN_ERR_MAX, {
    line: (l) => { let m = /^rss (\d+)$/.exec(l); if (m) { lastRss = Number(m[1]); return true; } m = /^over the scan's memory limit: (\d+) bytes resident$/.exec(l); if (m) overAt = Number(m[1]); return false; },
    fail: (w) => halt("io", w),
  });
  // the job, its one line; standard input then held open while the child runs (its end tells the child the service is gone)
  let stdinFailed = "";
  const sink = child.stdin as any;
  const lost = (e: unknown) => { stdinFailed ||= String((e as Error)?.message ?? e).slice(0, 60); };
  // a write or flush may answer at once, or later (a promise): a failure either way is caught here, never left unhandled
  const settle = async (v: unknown) => { if (v && typeof (v as any).then === "function") await Promise.race([(v as Promise<unknown>).then(() => {}, lost), stopped]); };
  try {
    await settle(sink.write(`${JSON.stringify({ path: file.path, names: { source: names.source, flags: names.flags }, needles, control, ...(o.maxExpanded ? { maxExpanded: o.maxExpanded } : {}) })}\n`));
    if (!stdinFailed) await settle(sink.flush());
  } catch (e) { lost(e); }
  // its pipes' ends and its exit, together under the deadline; after the exit, the pipes' grace
  let grace: ReturnType<typeof setTimeout> | undefined;
  void child.exited.then(() => { grace = setTimeout(() => halt("held"), PIPE_GRACE_MS); }, () => {});
  await Promise.race([Promise.all([out.done, err.done, child.exited]), stopped]);
  if (stop) {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([child.exited.catch(() => {}), Bun.sleep(2000)]);   // reaped
    out.cancel(); err.cancel();
  }
  clearTimeout(timer); clearTimeout(grace);
  o.signal?.removeEventListener("abort", onAbort);
  try { const e = sink.end(); if (e && typeof e.then === "function") e.then(() => {}, () => {}); } catch { /* the child is gone */ }
  const code = child.exitCode, sig = child.signalCode;
  const said = err.text().trim().split("\n").pop()?.slice(0, 120) ?? "";
  // a stop by the service first: its own timeout is a timeout, whatever signal ended the child
  if (stop === "timeout") return fail(`the scan took longer than ${inWords(timeoutMs)} reading ${of} and was stopped (a timeout, not a crash) ${budgetWhy({ budget: "the scan's time limit", phase: "scan", limit: inWords(timeoutMs), seen: `still running after ${inWords(timeoutMs)}`, todo: "run backup-check again when the device is less busy; if it runs out of time again, report it with the backup's size from Keeper's log" })}`, lastRss);
  if (stop === "aborted") return fail(`the scan was stopped reading ${of}: the backup check's deadline passed`, lastRss);
  if (stop === "overflow") return fail(`the scan wrote more than ${mb(SCAN_OUT_MAX)} on its output reading ${of}, more than its one-line result, and was stopped ${budgetWhy({ budget: "the scan's output limit", phase: "scan", limit: mb(SCAN_OUT_MAX), seen: `over ${mb(SCAN_OUT_MAX)}`, todo: "report it: the scan's output is never that large" })}`, lastRss);
  if (stop === "io") return fail(`the scan's output couldn't be read (${stopDetail}) reading ${of}, so it was stopped`, lastRss);
  if (stop === "held") return fail(`the scan's output stayed open ${inWords(PIPE_GRACE_MS)} after it exited (exit ${code}) reading ${of}: something it started still holds it, so its result isn't used`, lastRss);
  if (code === OVER_LIMIT_EXIT) return fail(`the scan was killed (out of memory): it passed its own limit of ${mb(rssMax)} reading ${of} ${budgetWhy({ budget: "the scan's memory limit", phase: "scan", limit: `${mb(rssMax)} resident`, seen: `${mb(overAt || lastRss)} resident`, todo: "stop other Apps or free memory on the device, then run backup-check again; if it fails again, report it with the backup's size" })}`, lastRss);
  if (sig === "SIGKILL" || code === 137) {
    const near = rssMax > 0 && lastRss >= NEAR_LIMIT * rssMax;
    return fail(`the scan was killed (signal 9) reading ${of}${near ? `: likely out of memory, its last memory sample ${mb(lastRss)} near its limit of ${mb(rssMax)}` : `: its last memory sample was ${mb(lastRss)}, not near its limit of ${mb(rssMax)}, so something else stopped it (the system, a supervisor stop or a manual kill)`}; Keeper's service is unharmed`, lastRss);
  }
  if (sig) return fail(`the scan was stopped by ${sig} reading ${of}`, lastRss);
  const text = out.text();
  const lines = text.split("\n");
  const r = code === 0 && !stdinFailed && lines.length === 2 && lines[1] === "" ? resultOf(lines[0]) : null;
  if (!r) return fail(`the scan ended without a result (exit ${code}) reading ${of}${stdinFailed ? `: it didn't take its job (${stdinFailed})` : code === 0 ? ": its output wasn't one valid result line" : ""}${said ? `: ${said}` : ""}`, lastRss);
  o.log?.(`backup check: the scan read ${r.members} files, decoded ${r.expanded ?? 0} bytes, peak memory ${mb(r.peakRss ?? 0)} (its limit ${mb(rssMax)})`);
  return { ...r, lastRss };
}

// (0.1.17) The loopback listener's handler. The backup check runs for minutes (a backup made, downloaded and scanned): its request
// alone is exempt from the idle timeout (exemptBackupCheck: server.timeout(req, 0)). Fix round, checked against Bun 1.4.4 (the
// Dockerfile's BUN_VERSION; scan-review.test.ts item 7): the exemption is per request, not per connection (the next request on the
// same keep-alive connection is under the idle timeout again); and Bun 1.4.4 doesn't idle-cut a request with a body while its
// handler runs at all, so the loopback's commands (all POST) were never cut there; the exemption stays for a Bun that does. A second
// backup check while one runs is answered at once (core.ts BACKUP_CHECK_BUSY), so nothing holds two checks open.
export const LOCAL_IDLE_S = 30;
export function exemptBackupCheck(req: Request, server: { timeout: (req: Request, s: number) => void }) {
  if (new URL(req.url).pathname === "/backup-check") { try { server.timeout(req, 0); } catch { /* an older Bun: idleTimeout holds */ } }
}
export function localFetch(k: Keeper, log: (l: string) => void) {
  return (req: Request, server: { timeout: (req: Request, s: number) => void; requestIP: (req: Request) => { address: string } | null }) => {
    exemptBackupCheck(req, server);
    return handleLocal(k, req, server.requestIP(req)?.address ?? "", log);
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
    backups: sup.backups, activeJobs: sup.activeJobs, backupJobs: sup.backupJobs, installStartedAt: sup.installStartedAt, hcKeyStore: hcKeyStore(),
    installJobs: sup.installJobs, drillSpent: drillSpent(),   // (0.1.15) items 2 and 10
    diskFree: sup.diskFree, download: (slug, o) => archives().through(slug, (path) => sup.downloadTo(slug, path, o)), archives: archives(),
    // (0.1.17) in a child process; fix round: given what the check's deadline leaves, and stopped by its abort
    scan: (file, names, needles, control, o) => scanChild(file, names, needles, control, { log, ...(o ? { timeoutMs: o.timeoutMs, signal: o.signal } : {}) }),
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
  Bun.serve({ port: LOCAL_PORT, hostname: "127.0.0.1", idleTimeout: LOCAL_IDLE_S, maxRequestBodySize: 4096, fetch: localFetch(k, log) });
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
  "drill-state": () => ({}),                         // (0.1.13) the drill runbook's state read, read only
};
const DONE: Record<string, string> = {
  "drill-record": "drill recorded", "phone-test": "phone test sent: once the pages reached your phone, phone-confirm <code from the log> <each check>",
  "phone-confirm": "phone test recorded", "key-confirm": "Ship key confirmed",
  "missed-heartbeat": "missed-heartbeat drill started: once its page reached your phone, missed-heartbeat-confirm <code from the log>",
  "missed-heartbeat-confirm": "missed-heartbeat drill recorded",
  "accept-limits": "the accepted limits are recorded", "hc-key": "the Healthchecks read-only key is checked and kept",
  "key-code": "a fresh key-confirm code is printed in Keeper's log",
  "backup-check": "the backup check passed: a test backup of Keeper leaves out every key file and holds no key",
  "drill-state": "Keeper's drill state",
};
// (0.1.17) The CLI's backup-check: it waits at most BACKUP_CHECK_CLI_MS, says while it waits that the check is running, and says in
// plain words what happened: the result (passed, or why not: the scan killed, out of memory, among them), the service not
// running, the service stopping while the check ran (its restart counts the check failed and deletes the test backup), or no
// answer in time. Never only "the keeper's service didn't answer". Fix round: its wait is longer than the service's one deadline
// for the check (core.ts CHECK_DEADLINE_MS) with a margin for the cleanup, so the owner hears the check's own answer; and the cause
// of a failed request is read from its structured code (ECONNREFUSED, ECONNRESET, TimeoutError), never from its message text,
// with a neutral line naming the raw code for anything else.
export const BACKUP_CHECK_CLI_MS = 10 * 60_000;
export const BACKUP_CHECK_CLI_MARGIN_MS = 60_000;
export const BACKUP_CHECK_SAYS = {
  running: "backup check running: Keeper makes a test backup of itself, downloads it and scans it in a separate process; this can take several minutes (at most 10)",
  still: (min: number) => `backup check still running (${min} min): the scan is reading the test backup`,
  refused: "not done: the keeper's service isn't answering on its loopback port (127.0.0.1:8096): is Keeper started? Nothing was checked",
  stopped: "not done: the keeper's service stopped answering while the backup check ran (it was likely restarted while scanning). Its restart counts the check failed, removes the sentinels and deletes the test backup; read Keeper's log, then run backup-check again",
  timeout: "not done: no answer within 10 minutes; the backup check may still be running. Read Keeper's log for \"backup check passed\" or \"backup check FAILED\"; if the service restarts, that counts the check failed and deletes the test backup",
  garbled: (status: number) => `not done: the keeper's service answered without a result (HTTP ${status}); read Keeper's log`,
  other: (code: string) => `not done: the request to Keeper's service failed (${code}); whether the check ran is unknown: read Keeper's log for "backup check passed" or "backup check FAILED"`,
  busy: `not done: ${BACKUP_CHECK_BUSY}; wait for it (Keeper's log says when it ends), then run backup-check again if you need to`,
};
// a failed request's cause, from its structured fields only (Bun's fetch: code ECONNREFUSED or ECONNRESET; an AbortSignal timeout:
// name TimeoutError, DOMException code 23)
export function requestCause(e: any): "refused" | "stopped" | "timeout" | string {
  const code = typeof e?.code === "string" ? e.code : "", name = typeof e?.name === "string" ? e.name : "";
  if (name === "TimeoutError" || e?.code === 23) return "timeout";
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "refused";
  if (code === "ECONNRESET" || code === "ConnectionClosed" || code === "EPIPE" || code === "UND_ERR_SOCKET") return "stopped";
  return code || name || "no code";
}
export async function backupCheckCli(url = `http://127.0.0.1:${LOCAL_PORT}/backup-check`, o: { timeoutMs?: number; everyMs?: number; say?: (l: string) => void; http?: typeof fetch } = {}): Promise<{ ok: boolean; line: string }> {
  const say = o.say ?? ((l: string) => console.log(l));
  const http = o.http ?? fetch;
  say(BACKUP_CHECK_SAYS.running);
  const t0 = Date.now();
  const every = setInterval(() => say(BACKUP_CHECK_SAYS.still(Math.round((Date.now() - t0) / 60_000))), o.everyMs ?? 60_000);
  const failed = (e: unknown) => {
    const c = requestCause(e);
    return { ok: false, line: c === "timeout" ? BACKUP_CHECK_SAYS.timeout : c === "refused" ? BACKUP_CHECK_SAYS.refused : c === "stopped" ? BACKUP_CHECK_SAYS.stopped : BACKUP_CHECK_SAYS.other(c) };
  };
  try {
    let r: Response;
    try { r = await http(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(o.timeoutMs ?? BACKUP_CHECK_CLI_MS) }); }
    catch (e) { return failed(e); }
    let j: any = null;
    const text = await r.text().catch((e) => e as Error);
    if (text instanceof Error) return failed(text);
    try { j = JSON.parse(text); } catch { return { ok: false, line: BACKUP_CHECK_SAYS.garbled(r.status) }; }
    if (!j || typeof j.ok !== "boolean") return { ok: false, line: BACKUP_CHECK_SAYS.garbled(r.status) };
    if (!j.ok && j.why === BACKUP_CHECK_BUSY) return { ok: false, line: BACKUP_CHECK_SAYS.busy };
    return j.ok ? { ok: true, line: DONE["backup-check"] } : { ok: false, line: `not done: ${String(j.why ?? "no reason given")}` };
  } finally { clearInterval(every); }
}
// (0.1.7) The key from standard input, first line, trimmed; never echoed.
async function readStdinKey(): Promise<string> {
  try { return (await Bun.stdin.text()).split("\n")[0].trim(); } catch { return ""; }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "serve") await serve();
  else if (cmd === "backup-check") {
    const r = await backupCheckCli();
    console.log(r.line);
    process.exit(r.ok ? 0 : 1);
  } else if (LOCAL_CMDS[cmd]) {
    const body: any = LOCAL_CMDS[cmd](rest);
    if (cmd === "hc-key") {
      if (rest.length > 1) { console.error("hc-key takes only the code: the key goes on standard input, never the command line"); process.exit(2); }
      body.key = await readStdinKey();
    }
    const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/${cmd}`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    if (cmd === "drill-state" && j?.ok) console.log(JSON.stringify(j.state, null, 2));
    else console.log(j?.ok ? `${DONE[cmd]}${j.why ? ` (${j.why})` : ""}` : `not done: ${j?.why ?? "the keeper's service didn't answer"}`);
    process.exit(j?.ok ? 0 : 1);
  } else if (cmd === "selftest") {
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error(`the image's KEEPER_VERSION isn't a version: ${VERSION}`); process.exit(1); }
    console.log(`keeper ${VERSION}: the code loads`);
  } else { console.error("usage: main.ts serve | drill-record <attempt id> | phone-test | phone-confirm <code> <check>... | key-confirm <fingerprint> <code> | missed-heartbeat | missed-heartbeat-confirm <code> | accept-limits <code> | hc-key <code> (key on stdin) | key-code | backup-check | drill-state | selftest"); process.exit(2); }
}
