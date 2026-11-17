// Round 12: the append-only logs (the link's issued tap keys, the keeper's mirror of them, the
// keeper's consumed tap keys, and the landing ledger's hand settles), one framed record per line:
//   <byte length of the JSON>:<its CRC-32, 8 hex digits>:<the JSON>\n
// Each record is appended and fsynced before anything acts on it (the directory too when the file
// is new). On read, a final record that is cut short, or whose length or checksum doesn't match (a
// write a power cut tore), is truncated off the file and reported as torn, once: what came before
// it stands. A bad record before the last one is skipped and counted. No log is ever rewritten.
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function frame(rec: unknown): string {
  const json = JSON.stringify(rec);
  const bytes = Buffer.from(json, "utf8");
  return `${bytes.length}:${crc32(bytes).toString(16).padStart(8, "0")}:${json}\n`;
}

export interface LogRead<T = any> {
  records: T[];
  missing: boolean;          // no file at all
  torn: boolean;             // a torn final record was found (and truncated, when repair is on)
  tornBytes: number;         // how many bytes it was
  bad: number;               // bad records before the last one, skipped
}

// Reads a log. Round 21: repair is off by default (a reader only skips a torn final record and reports it). repair: true
// truncates a torn final record under the log's flock (withLogLock), re-read inside it, so a repair never races a writer;
// repair: "mirror" truncates without the lock, and only the keeper's single-writer mirror (record-issued.log) may ask for
// it (any other file throws).
export const SINGLE_WRITER_MIRROR = "record-issued.log";
// Round 22: repair: "try" takes the flock with one non-blocking try (no wait): on would-block it throws a LockTimeout at
// once, nothing truncated, and the caller skips the repair to its next round (the keeper's per-round torn check).
export function readLog<T = any>(file: string, o: { repair?: boolean | "mirror" | "try" } = {}): LogRead<T> {
  if (o.repair === "mirror" && basename(file) !== SINGLE_WRITER_MIRROR) throw new Error(`only the keeper's single-writer mirror (${SINGLE_WRITER_MIRROR}) is repaired without the lock, not ${file}`);
  if (o.repair === true && existsSync(file)) return withLogLock(file, () => readOnce<T>(file, true));
  if (o.repair === "try" && existsSync(file)) return withLogLock(file, () => readOnce<T>(file, true), { wait: 0 });
  return readOnce<T>(file, o.repair === "mirror");
}
function readOnce<T>(file: string, repair: boolean): LogRead<T> {
  const out: LogRead<T> = { records: [], missing: false, torn: false, tornBytes: 0, bad: 0 };
  let buf: Buffer;
  try { buf = readFileSync(file); }
  catch (e: any) { if (e?.code === "ENOENT") { out.missing = true; return out; } throw e; }
  let pos = 0, good = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(pos, end);
    const ok = (() => {
      if (nl === -1) return null;                                    // no newline: cut short
      const s = line.toString("utf8");
      const m = /^(\d{1,9}):([0-9a-f]{8}):/.exec(s);
      if (!m) return null;
      const body = line.subarray(m[0].length);
      if (body.length !== Number(m[1]) || crc32(body).toString(16).padStart(8, "0") !== m[2]) return null;
      try { return { v: JSON.parse(body.toString("utf8")) }; } catch { return null; }
    })();
    const last = nl === -1 || nl + 1 >= buf.length;
    if (ok) { out.records.push(ok.v as T); good = end + 1; }
    else if (last) { out.torn = true; out.tornBytes = buf.length - good; break; }
    else out.bad++;
    pos = end + 1;
  }
  if (out.torn) reportTorn(file, out.tornBytes, buf.length);
  if (out.torn && repair) truncateSync(file, good);
  return out;
}

// Round 19: every reader skips a torn final line (above) and reports it: one line per file and torn length, so a
// reader that doesn't repair (repair: false) still says what it skipped. A test may watch it (tornSpy).
export const tornSpy: { on: null | ((file: string, bytes: number) => void) } = { on: null };
const tornTold = new Set<string>();
function reportTorn(file: string, bytes: number, size: number): void {
  tornSpy.on?.(file, bytes);
  const k = `${file}\u0000${size}\u0000${bytes}`;
  if (tornTold.has(k)) return;
  tornTold.add(k);
  if (tornTold.size > 500) tornTold.delete(tornTold.values().next().value!);
  console.error(`[applog] a torn final record (${bytes} bytes) in ${file} was skipped; the records before it stand`);
}

// Appends one record and fsyncs it (and its directory when the file is new). Throws on failure:
// the caller acts only once this returns.
// Round 13: a test's view of each fsync, in order ("file <path>" or "dir <path>").
export const syncSpy: { on: null | ((what: string) => void) } = { on: null };
// Round 18: the tests' crash point for a durable write: called with the file after its bytes are written and before
// they are fsynced (an append here, and the whole-file writers: the link's writeDurable, the landing ledger's, the
// keeper's writeAtomic). A test throws from it to kill the write there and checks the dependent effect hadn't happened.
export const crashSpy: { on: null | ((file: string) => void) } = { on: null };
// Round 19: the whole-file writers' second crash point, after the rename and before the folder's fsync: crashSpy is
// called with the file's name plus this suffix (a power cut there may keep the old file at the name).
export const AFTER_RENAME = "#after-rename";
// Round 18: the interleaving rule for logs two processes append to (the install log: the link and the keeper): each
// record is one framed write, opened for append, under MAX_RECORD_BYTES (below the 4096 bytes a single append is
// written whole in), so two writers' records never interleave; a longer record is refused before anything is written.
export const MAX_RECORD_BYTES = 4000;
// Round 19: free-text fields (a settle reason from GitHub, a notice's reason, an error) are cut before the record is
// serialised. Round 20: the cut is against a byte budget for the whole serialised UTF-8 record (its frame included), on a
// code-point boundary, recursing into nested objects and arrays: each free-text string is first cut to FREE_TEXT_BUDGET
// bytes, then, while the record is still over MAX_RECORD_BYTES, the longest free-text string left is halved. Nesting is
// bounded too (MAX_NEST levels: anything deeper is replaced by a marker). A record that still doesn't fit (its other
// fields alone are over the limit) is refused before anything is written, with a bounded message (fitRecord throws).
export const FREE_TEXT_FIELDS = ["why", "reason", "error", "last", "detail", "note"];
export const FREE_TEXT_BUDGET = 600;
export const MAX_NEST = 8;
const CUT = "\u2026";
// The bytes a string takes inside the record's JSON (escapes counted).
const jsonBytes = (s: string) => Buffer.byteLength(JSON.stringify(s), "utf8") - 2;
// s cut to at most budget JSON bytes, on a code-point boundary, ending with the cut mark when cut.
export function cutToBytes(s: string, budget: number): string {
  if (jsonBytes(s) <= budget) return s;
  const room = Math.max(0, budget - jsonBytes(CUT));
  let out = "", used = 0;
  for (const cp of s) {             // iterates code points, never splitting a surrogate pair
    const b = jsonBytes(cp);
    if (used + b > room) break;
    out += cp; used += b;
  }
  return out + CUT;
}
export function fitRecord<T>(rec: T): T {
  if (!rec || typeof rec !== "object") return rec;
  // Each free-text string, with a setter to replace it in the copy.
  const texts: { get: () => string; set: (v: string) => void }[] = [];
  const copy = (v: any, depth: number, key: string | null): any => {
    if (v && typeof v === "object") {
      if (depth >= MAX_NEST) return "[nested too deep]";
      if (Array.isArray(v)) {
        const a: any[] = v.map((x) => copy(x, depth + 1, key));
        if (key !== null && FREE_TEXT_FIELDS.includes(key)) a.forEach((x, i) => { if (typeof x === "string") texts.push({ get: () => a[i], set: (y) => { a[i] = y; } }); });
        return a;
      }
      const o: any = {};
      for (const k of Object.keys(v)) {
        o[k] = copy(v[k], depth + 1, k);
        if (FREE_TEXT_FIELDS.includes(k) && typeof o[k] === "string") texts.push({ get: () => o[k], set: (y) => { o[k] = y; } });
      }
      return o;
    }
    return v;
  };
  const out = copy(rec, 0, null);
  for (const t of texts) t.set(cutToBytes(t.get(), FREE_TEXT_BUDGET));
  const size = () => Buffer.byteLength(frame(out), "utf8");
  for (let guard = 0; size() > MAX_RECORD_BYTES && guard < 200; guard++) {
    const t = texts.filter((x) => jsonBytes(x.get()) > jsonBytes(CUT)).sort((a, b) => jsonBytes(b.get()) - jsonBytes(a.get()))[0];
    if (!t) break;
    t.set(cutToBytes(t.get(), Math.floor(jsonBytes(t.get()) / 2)));
  }
  const n = size();
  if (n > MAX_RECORD_BYTES) throw new Error(`a log record over ${MAX_RECORD_BYTES} bytes (${n}) isn't written: its fields other than free text are too long`);
  return out;
}
// Round 20: shared-log writers are serialised by an OS advisory lock (flock, exclusive) on a file beside the log
// (<log>.flock), held through the torn-tail repair, the append and the fsync. The kernel releases it when its holder
// dies, so a dead holder is recovered by whichever waiter gets the lock next: no takeover, and no two waiters can both
// hold it. Round 21: a waiter that gets would-block for lockWait.ms (LOCK_WAIT_MS) gives up with a LockTimeout, nothing
// written, and every caller holds what it was doing and retries (LOCK_CALLERS); any other flock error is reported at once
// with its real cause (errno and its name), never as "another writer holds it". flock comes from libc through bun:ffi,
// resolved through a soname fallback list (LIBC_NAMES); the link and the keeper each probe it at start (probeLock) on a
// probe file in the real log folder and refuse to start, with a status line he sees, when it fails.
export const LOCK_WAIT_MS = 5_000;
export const lockWait = { ms: LOCK_WAIT_MS };
export class LockTimeout extends Error { constructor(file: string, ms: number) { super(`the log ${file} is locked by another writer (waited ${ms / 1000} seconds); nothing was written, and it is tried again`); this.name = "LockTimeout"; } }
export class LockError extends Error { constructor(msg: string) { super(msg); this.name = "LockError"; } }
// Round 21: every append caller and what it does on a LockTimeout (hold and retry, never a dropped record or a crashed
// loop). Listed in the invariant table; a test checks each.
// Round 22: the list is complete: every call site of appendLog, appendLogHeld, appendInstall and withLogLock in the
// link and the keeper is named by one entry's sites (a source fragment on that call's line), and a test checks that
// every call site in the source matches an entry and every entry's sites are in the source (LOCK_SITES).
export const LOCK_CALLERS: Record<string, string> = {
  "consumed-key log: consuming intent (keeper intendConsume)": "the request stays queued and is tried again next round",
  "consumed-key log: consumed record (keeper appendConsumed)": "the state keeps it, and the intent is resolved from the commit's trailers next round",
  "consumed-key log: dropped intent (keeper dropIntent)": "the intent stays open and is resolved from the record's history next round",
  "consumed-key log: landed and unlanded marks (keeper unlandedConsumes, dropUnlanded)": "nothing is marked or dropped and no commit is abandoned; looked at again next round (round 25: a reset-copy's tombstones, tombstoneDiscarded: nothing is discarded and the request waits for the next round)",
  "consumed-key log: the push guard (keeper guardedPush)": "nothing is pushed this round (refused: the lock); the local commits stay and the next round tries again",
  "held log: held (link holdTap)": "the tap answers busy and the card keeps its buttons",
  "held log: releasing, released, dropped, replay marks (link releaseHeldTaps, replayWatch, replayWaiting)": "the release or mark is retried next sweep",
  "landing ledger settle log (link landings.ts settleHand, ownerLine)": "it answers false: nothing is settled and his message isn't used up, so Cain runs the same command again with the same message",
  "issued-key log: key (link issueKeys)": "no key is logged, so the card is never made tappable (withdrawn, Cain asks again): no tap can count without its key",
  "issued-key log: run (link start)": "the run isn't logged yet; the link logs it at its next start, and the keeper reads the run from the link's state meanwhile",
  "issued-key log: void and armed marks (link voidCard, armCard, a tap on an unsaved card)": "the mark isn't written: an unarmed card stays without buttons, and a void is retried by the sweep that finds the card again",
  "issued-key log: supersede (link replayWatch)": "nothing is superseded and nothing is asked again; the replay is looked at again next sweep",
  "expired-key index (link expiry sweep, unarm)": "the card isn't indexed yet; its buttons still come off, and the next sweep indexes it",
  "strip queue (link queueStrip, stripDone)": "the removal isn't queued (or marked done); the sweep edits the card again, which is idempotent",
  "keeper's mirror of the issued-key log (keeper mirrorIssued)": "the round mirrors nothing more; the next round mirrors what is still missing",
  "install log (keeper restore flag, once-used rebuild; link install-taps through appendInstall)": "nothing is written: install taps stay as they were, and the rebuild or flag is tried again next round",
  "torn check (keeper cycle, readLog repair try)": "one non-blocking try: on would-block the repair is skipped to the next round, the round goes on",
  "repair at start (link repairLogs, landings repair; readLog repair true)": "the repair waits for the lock up to the timeout, then is skipped and tried at the next start; readers skip a torn tail anyway",
  // Round 23: the whole source tree is scanned, so the log module's own primitives are listed too.
  "the log module's own primitives (applog.ts readLog repair, appendLog, the start probe and its contention helper)": "the primitive throws the LockTimeout to its caller (each listed above), writing nothing; the start probe answers its reason, so the start is refused and probed again hourly",
};
// Round 22: for each LOCK_CALLERS entry, the source fragments of its call sites (file: fragments on the call's line).
export const LOCK_SITES: Record<string, Record<string, string[]>> = {
  "consumed-key log: consuming intent (keeper intendConsume)": { "record/main.ts": ['{ t: "consuming", tap, id, at }'] },
  "consumed-key log: consumed record (keeper appendConsumed)": { "record/main.ts": ["appendLog(tapsLogFile(cfg), { tap, id, at }, { wait: consumedWait() })"] },
  "consumed-key log: dropped intent (keeper dropIntent)": { "record/main.ts": ['{ t: "dropped", tap, id, at, why }'] },
  "consumed-key log: landed and unlanded marks (keeper unlandedConsumes, dropUnlanded)": { "record/main.ts": ['{ t: "landed", tap: x.tap', 'withLogLock(tapsLogFile(cfg), () => { // dropUnlanded', '{ t: "landed", tap, id, at, how', '{ t: "dropped", tap, id, unlanded: true'] },
  // Round 25: the reset-copy's tombstones are on the same line form ('{ t: "dropped", tap, id, unlanded: true, why: RESET_COPY_DROP_WHY').
  "consumed-key log: the push guard (keeper guardedPush)": { "record/main.ts": ["withLogLock(tapsLogFile(cfg), () => { // guardedPush"] },
  "held log: held (link holdTap)": { "link/core.ts": ['appendLog(this.heldFile()!, { t: "held"'] },
  "held log: releasing, released, dropped, replay marks (link releaseHeldTaps, replayWatch, replayWaiting)": { "link/core.ts": ['appendLog(this.heldFile()!, { t: "dropped"', 'appendLog(this.heldFile()!, { t: "released"', 'appendLog(this.heldFile()!, { t: "releasing"', '{ t: "replay-waiting"', '{ t: "replay-done"'] },
  "landing ledger settle log (link landings.ts settleHand, ownerLine)": { "link/landings.ts": ["{ key, how, at, said }", '{ t: "owner", kind, said, at }'] },
  "issued-key log: key (link issueKeys)": { "link/core.ts": ['{ t: "key", kid: tapKid(key)'] },
  "issued-key log: run (link start)": { "link/core.ts": ['{ t: "run", run: s.run'] },
  "issued-key log: void and armed marks (link voidCard, armCard, a tap on an unsaved card)": { "link/core.ts": ['{ t: "void", msg: msgId, at: now }', '{ t: "void", msg: msgId, at: this.d.now() }', '{ t: "void", msg, at: this.d.now(), why }', '{ t: "armed", msg: msgId'] },
  "issued-key log: supersede (link replayWatch)": { "link/core.ts": ['{ t: "supersede", kid: r.kid'] },
  "expired-key index (link expiry sweep, unarm)": { "link/core.ts": ['this.indexRecord(msg, r, false, "unarmed")', 'this.indexRecord(id, undefined, old, "swept")', 'this.indexRecord(msg, rec, false, "swept")'] },
  "strip queue (link queueStrip, stripDone)": { "link/core.ts": ['{ t: "strip", msg, line', '{ t: "done", msg, at'] },
  "keeper's mirror of the issued-key log (keeper mirrorIssued)": { "record/main.ts": ["appendLog(issuedMirrorFile(cfg), r)"] },
  "install log (keeper restore flag, once-used rebuild; link install-taps through appendInstall)": { "record/main.ts": ['{ t: "flag", how: "off", by: "keeper"', '{ t: "once-used", kid: k, by: "keeper"'], "installflag.ts": ["appendLog(file, rec)"], "link/core.ts": ['{ t: "once-used", kid, msg: msgId', '{ t: "flag", how, by: "cain"', '{ t: "flag", how: "on", by: "owner"'] },
  "torn check (keeper cycle, readLog repair try)": { "record/main.ts": ['repair: f === issuedMirrorFile(cfg) ? "mirror" : "try"'] },
  "repair at start (link repairLogs, landings repair; readLog repair true)": { "link/core.ts": ["readLog(this.d.issuedLog, { repair: true })"], "link/landings.ts": ["readLog(join(dir, SETTLED_LOG), { repair: true })"] },
  "the log module's own primitives (applog.ts readLog repair, appendLog, the start probe and its contention helper)": { "applog.ts": ["withLogLock(file, () => readOnce<T>(file, true))", "withLogLock(file, () => readOnce<T>(file, true), { wait: 0 })", "withLogLock(probe, () => undefined)", "withLogLock(file, () => appendBuf(file, buf), o)", 'withLogLock(file, () => { writeFileSync(flag, "held")'] },
};
export const LIBC_NAMES = ["libc.so.6", "libc.so", "libc", "libc.dylib", "libSystem.B.dylib"];
// A test's view of the FFI: names to try instead of LIBC_NAMES, or a flock stand-in returning [rc, errno].
// Round 22: errnoSyms, the errno symbols to try instead of ERRNO_SYMS (a test's libc that loads with no errno symbol).
export const ERRNO_SYMS = ["__errno_location", "__error"];
// Round 23: helper, the argv prefix to start the contention helper with instead of probeHelperArgv() (a test's helper
// that can't start).
export const lockTest: { names: string[] | null; call: null | ((fd: number, op: number) => [number, number]); errnoSyms: string[] | null; helper: string[] | null } = { names: null, call: null, errnoSyms: null, helper: null };
const sleepSync = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* spin */ } };
type Flock = (fd: number, op: number) => [number, number];
let flockFn: Flock | null = null;
// Round 22: whether errno resolved (null: flock not loaded yet). Without it every flock failure reads as errno -1, so a
// contention would be told at once as a lock error instead of waited for: the start probe refuses then.
let errnoResolved: boolean | null = null;
export function resetFlockForTest(): void { flockFn = null; errnoResolved = null; }
function flock(): Flock {
  if (lockTest.call) return lockTest.call;
  if (flockFn) return flockFn;
  const { dlopen, FFIType, read } = require("bun:ffi");
  let lib: any = null, errno: (() => number) | null = null;
  const tried: string[] = [];
  for (const name of lockTest.names ?? LIBC_NAMES) {
    try { lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); }
    catch (e) { tried.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 60)}`); continue; }
    for (const sym of lockTest.errnoSyms ?? ERRNO_SYMS) {
      try { const l = dlopen(name, { [sym]: { args: [], returns: FFIType.ptr } }); errno = () => read.i32(l.symbols[sym]()); break; } catch { /* the other name */ }
    }
    break;
  }
  if (!lib) throw new LockError(`flock couldn't be loaded from libc (tried ${tried.join("; ")}), so no shared log is written`);
  errnoResolved = errno !== null;
  flockFn = (fd, op) => { const rc = lib.symbols.flock(fd, op); return [rc, rc === 0 ? 0 : errno ? errno() : -1]; };
  return flockFn;
}
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
const EINTR = 4, WOULD_BLOCK = new Set([11, 35]);   // EAGAIN/EWOULDBLOCK on Linux, on macOS
const ERRNO: Record<number, string> = { 1: "EPERM", 4: "EINTR", 5: "EIO", 9: "EBADF", 12: "ENOMEM", 13: "EACCES", 22: "EINVAL", 37: "ENOLCK", 38: "ENOSYS", 77: "ENOLCK", 95: "EOPNOTSUPP" };
export const lockFile = (file: string) => `${file}.flock`;
// Round 22: o.wait, the wait in ms instead of lockWait.ms (0: one non-blocking try, a LockTimeout at once on would-block).
export function withLogLock<T>(file: string, fn: () => T, o: { wait?: number } = {}): T {
  const f = flock();
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(lockFile(file), "a+", 0o600);
  try {
    const wait = o.wait ?? lockWait.ms;
    const until = performance.now() + wait;   // the monotonic clock: a bound inside this process
    for (;;) {
      const [rc, err] = f(fd, LOCK_EX | LOCK_NB);
      if (rc === 0) break;
      if (err === EINTR) continue;
      if (!WOULD_BLOCK.has(err)) throw new LockError(`the log ${file} couldn't be locked: flock failed with errno ${err}${ERRNO[err] ? ` (${ERRNO[err]})` : ""}, a lock error of its own (not would-block); nothing was written`);
      if (performance.now() >= until) throw new LockTimeout(file, wait);
      sleepSync(5);
    }
    try { return fn(); } finally { f(fd, LOCK_UN); }
  } finally { closeSync(fd); }
}
// Round 21: the start probe: flock loaded, and taken and released on a probe file in the real log folder. null: fine;
// otherwise the specific cause, for the refusal line.
// Round 22: the probe also requires errno to resolve, and runs a contention self-test: a child process (this file run as
// a script, --hold) takes the probe file's lock, and the probe's own non-blocking try must answer would-block. Either
// failing refuses the start with its precise reason.
export const PROBE_HOLD_MS = 4_000;
export function probeLock(dir: string): string | null {
  let child: { kill: () => void } | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".lock-probe");
    withLogLock(probe, () => undefined);
    if (!lockTest.call && errnoResolved === false) return `flock loaded from libc, but errno couldn't be resolved (tried ${(lockTest.errnoSyms ?? ERRNO_SYMS).join(", ")}), so a lock held by another writer couldn't be told from a lock error`;
    // The contention self-test.
    const flag = join(dir, `.lock-probe.${process.pid}.held`);
    try { rmSync(flag, { force: true }); } catch { /* none */ }
    // Round 23: started with the exact runtime and loader flags this process runs under (its executable and its
    // execArgv), on this module's own file, so the helper runs wherever the entry point does. A helper that can't be
    // spawned, or exits before it takes the lock, is its own refusal ("failed to start"), told apart from one that
    // runs but can't take the lock and from a flock that doesn't contend.
    let p: ReturnType<typeof Bun.spawn>;
    try { p = Bun.spawn([...(lockTest.helper ?? probeHelperArgv()), "--hold", probe, flag, String(PROBE_HOLD_MS)], { stdio: ["ignore", "ignore", "ignore"] }); }
    catch (e) { return `the lock self-test's helper process failed to start (${String((e as Error)?.message ?? e).slice(0, 80)}), so contention couldn't be checked`; }
    child = p;
    const until = performance.now() + 5_000;
    // Whether the helper has exited: its /proc entry gone or a zombie (exitCode isn't updated while this loop blocks).
    const gone = () => {
      if (p.exitCode !== null) return true;
      try { const st = readFileSync(`/proc/${p.pid}/stat`, "utf8"); return /^\s*[ZX]/.test(st.slice(st.lastIndexOf(")") + 1)); }
      catch (e: any) { return e?.code === "ENOENT" && existsSync("/proc/self/stat"); }
    };
    while (!existsSync(flag) && !gone() && performance.now() < until) sleepSync(10);
    if (!existsSync(flag) && gone()) return "the lock self-test's helper process failed to start (it exited before taking the probe lock), so contention couldn't be checked";
    if (!existsSync(flag)) return "the lock self-test's helper process started but couldn't take the probe lock within 5 seconds, so contention couldn't be checked";
    const fd = openSync(lockFile(probe), "a+", 0o600);
    let rc = 0, err = 0;
    try { [rc, err] = flock()(fd, LOCK_EX | LOCK_NB); if (rc === 0) flock()(fd, LOCK_UN); } finally { closeSync(fd); }
    try { rmSync(flag, { force: true }); } catch { /* left */ }
    if (rc === 0) return "the lock self-test took a lock another process held, so flock doesn't exclude other writers here";
    if (!WOULD_BLOCK.has(err)) return `the lock self-test got errno ${err}${ERRNO[err] ? ` (${ERRNO[err]})` : ""} for a lock another process held, not would-block`;
    return null;
  } catch (e) { return String((e as Error)?.message ?? e).slice(0, 300); }
  finally { try { child?.kill(); } catch { /* gone */ } }
}
// Round 23: the contention helper's command: the running executable, its own runtime flags (process.execArgv: the
// loader and preload the entry point was started with), and this module's file.
export const probeHelperArgv = (): string[] => [process.execPath, ...process.execArgv, import.meta.path];
// The status line he sees when the probe fails (the link's notice; the keeper's line through Cain).
export const lockRefusal = (who: "link" | "record keeper", why: string) =>
  `Cain's ${who === "link" ? "App" : "record keeper"} can't lock its logs on this box, so it isn't ${who === "link" ? "taking taps or posting cards" : "applying anything"}. Nothing was lost. It needs a fix in a new version of the App. (${why.replace(/(?:\/[\w.@+-]+)+/g, "its log folder").slice(0, 160)})`;
// Round 19: a test's short write: returns how many bytes the write puts down (null: all of them).
export const shortWriteSpy: { on: null | ((file: string) => number | null) } = { on: null };
// Round 23: o.wait, the lock wait in ms instead of lockWait.ms (the consumed-key log's writers wait longer than its
// guarded push's hard timeout).
export function appendLog(file: string, rec: unknown, o: { wait?: number } = {}): void {
  const buf = encode(rec);
  const fresh = !existsSync(file);
  if (fresh) mkdirSync(dirname(file), { recursive: true });
  withLogLock(file, () => appendBuf(file, buf), o);
  // A new log's directory entry is fsynced too, so a power cut can't lose the whole file.
  if (fresh) syncDir(dirname(file));
}
// Round 21: an append by a caller that already holds the log's flock (withLogLock), for a step that must be atomic with
// a read of the same log (the keeper's unlanded drop).
export function appendLogHeld(file: string, rec: unknown): void {
  const buf = encode(rec);
  const fresh = !existsSync(file);
  appendBuf(file, buf);
  if (fresh) syncDir(dirname(file));
}
function encode(rec: unknown): Buffer {
  const buf = Buffer.from(frame(fitRecord(rec)), "utf8");
  if (buf.length > MAX_RECORD_BYTES) throw new Error(`a log record over ${MAX_RECORD_BYTES} bytes (${buf.length}) isn't written: one record is one write`);
  return buf;
}
function appendBuf(file: string, buf: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a+", 0o600);
  try {
    // Round 19: a torn final line (a write cut short) is cut off before this record goes on, so the new record never
    // lands glued to it (where every reader would skip it as torn too).
    let pre = fstatSync(fd).size;
    if (pre > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, pre - 1);
      if (last[0] !== 0x0a) {
        const all = readFileSync(file);
        const keep = all.lastIndexOf(0x0a) + 1;
        reportTorn(file, pre - keep, pre);
        ftruncateSync(fd, keep);
        pre = keep;
      }
    }
    let n = 0;
    try { const cut = shortWriteSpy.on?.(file); n = writeSync(fd, typeof cut === "number" ? buf.subarray(0, Math.max(0, Math.min(cut, buf.length))) : buf); }
    catch (e) { try { ftruncateSync(fd, pre); } catch { /* the reader skips it as torn */ } throw e; }
    // Round 19: a short write is truncated back to the file's length before it, then refused.
    if (n !== buf.length) { try { ftruncateSync(fd, pre); } catch { /* the reader skips it as torn */ } throw new Error(`a log record was written short (${n} of ${buf.length} bytes)`); }
    crashSpy.on?.(file);
    fsyncSync(fd); syncSpy.on?.(`file ${file}`);
  } finally { closeSync(fd); }
}
export function syncDir(dir: string): void {
  try { const d = openSync(dir, "r"); try { fsyncSync(d); syncSpy.on?.(`dir ${dir}`); } finally { closeSync(d); } } catch { /* a directory that can't be opened to sync (not on Linux) */ }
}

// The same file's content written whole and fsynced, for a test that wants a log in a given state.
export function writeLogForTest(file: string, recs: unknown[], tail = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "w", 0o600);
  try { writeSync(fd, recs.map(frame).join("") + tail); fsyncSync(fd); } finally { closeSync(fd); }
}

// Round 22: the start probe's contention helper: `bun applog.ts --hold <probe file> <flag file> <ms>` takes the probe
// file's lock, writes the flag, and holds the lock for ms (or until it is killed).
if (import.meta.main && process.argv[2] === "--hold") {
  const [file, flag, ms] = process.argv.slice(3);
  withLogLock(file, () => { writeFileSync(flag, "held"); sleepSync(Number(ms) || PROBE_HOLD_MS); }, { wait: 5_000 });
}
