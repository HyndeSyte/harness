// Round 12: the append-only logs (the link's issued tap keys, the keeper's mirror of them, the
// keeper's consumed tap keys, and the landing ledger's hand settles), one framed record per line:
//   <byte length of the JSON>:<its CRC-32, 8 hex digits>:<the JSON>\n
// Each record is appended and fsynced before anything acts on it (the directory too when the file
// is new). On read, a final record that is cut short, or whose length or checksum doesn't match (a
// write a power cut tore), is truncated off the file and reported as torn, once: what came before
// it stands. A bad record before the last one is skipped and counted. No log is ever rewritten.
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, truncateSync, writeSync } from "node:fs";
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
export function readLog<T = any>(file: string, o: { repair?: boolean | "mirror" } = {}): LogRead<T> {
  if (o.repair === "mirror" && basename(file) !== SINGLE_WRITER_MIRROR) throw new Error(`only the keeper's single-writer mirror (${SINGLE_WRITER_MIRROR}) is repaired without the lock, not ${file}`);
  if (o.repair === true && existsSync(file)) return withLogLock(file, () => readOnce<T>(file, true));
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
export const LOCK_CALLERS: Record<string, string> = {
  "consumed-key log: consuming intent (keeper intendConsume)": "the request stays queued and is tried again next round",
  "consumed-key log: consumed record (keeper appendConsumed)": "the state keeps it, and the intent is resolved from the commit's trailers next round",
  "consumed-key log: dropped intent (keeper dropIntent)": "the intent stays open and is resolved from the record's history next round",
  "consumed-key log: landed and unlanded marks (keeper unlandedConsumes)": "nothing is marked; looked at again next round",
  "held log: held (link holdTap)": "the tap answers busy and the card keeps its buttons",
  "held log: releasing, released, replay marks (link releaseHeldTaps, replayWatch)": "the release or mark is retried next sweep",
  "landing ledger settle log (link landings.ts settleHand, ownerLine)": "it answers false: nothing is settled and his message isn't used up, so Cain runs the same command again with the same message",
};
export const LIBC_NAMES = ["libc.so.6", "libc.so", "libc", "libc.dylib", "libSystem.B.dylib"];
// A test's view of the FFI: names to try instead of LIBC_NAMES, or a flock stand-in returning [rc, errno].
export const lockTest: { names: string[] | null; call: null | ((fd: number, op: number) => [number, number]) } = { names: null, call: null };
const sleepSync = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* spin */ } };
type Flock = (fd: number, op: number) => [number, number];
let flockFn: Flock | null = null;
export function resetFlockForTest(): void { flockFn = null; }
function flock(): Flock {
  if (lockTest.call) return lockTest.call;
  if (flockFn) return flockFn;
  const { dlopen, FFIType, read } = require("bun:ffi");
  let lib: any = null, errno: (() => number) | null = null;
  const tried: string[] = [];
  for (const name of lockTest.names ?? LIBC_NAMES) {
    try { lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); }
    catch (e) { tried.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 60)}`); continue; }
    for (const sym of ["__errno_location", "__error"]) {
      try { const l = dlopen(name, { [sym]: { args: [], returns: FFIType.ptr } }); errno = () => read.i32(l.symbols[sym]()); break; } catch { /* the other name */ }
    }
    break;
  }
  if (!lib) throw new LockError(`flock couldn't be loaded from libc (tried ${tried.join("; ")}), so no shared log is written`);
  flockFn = (fd, op) => { const rc = lib.symbols.flock(fd, op); return [rc, rc === 0 ? 0 : errno ? errno() : -1]; };
  return flockFn;
}
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
const EINTR = 4, WOULD_BLOCK = new Set([11, 35]);   // EAGAIN/EWOULDBLOCK on Linux, on macOS
const ERRNO: Record<number, string> = { 1: "EPERM", 4: "EINTR", 5: "EIO", 9: "EBADF", 12: "ENOMEM", 13: "EACCES", 22: "EINVAL", 37: "ENOLCK", 38: "ENOSYS", 77: "ENOLCK", 95: "EOPNOTSUPP" };
export const lockFile = (file: string) => `${file}.flock`;
export function withLogLock<T>(file: string, fn: () => T): T {
  const f = flock();
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(lockFile(file), "a+", 0o600);
  try {
    const until = performance.now() + lockWait.ms;   // the monotonic clock: a bound inside this process
    for (;;) {
      const [rc, err] = f(fd, LOCK_EX | LOCK_NB);
      if (rc === 0) break;
      if (err === EINTR) continue;
      if (!WOULD_BLOCK.has(err)) throw new LockError(`the log ${file} couldn't be locked: flock failed with errno ${err}${ERRNO[err] ? ` (${ERRNO[err]})` : ""}, a lock error of its own (not would-block); nothing was written`);
      if (performance.now() > until) throw new LockTimeout(file, lockWait.ms);
      sleepSync(5);
    }
    try { return fn(); } finally { f(fd, LOCK_UN); }
  } finally { closeSync(fd); }
}
// Round 21: the start probe: flock loaded, and taken and released on a probe file in the real log folder. null: fine;
// otherwise the specific cause, for the refusal line.
export function probeLock(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    withLogLock(join(dir, ".lock-probe"), () => undefined);
    return null;
  } catch (e) { return String((e as Error)?.message ?? e).slice(0, 300); }
}
// The status line he sees when the probe fails (the link's notice; the keeper's line through Cain).
export const lockRefusal = (who: "link" | "record keeper", why: string) =>
  `Cain's ${who === "link" ? "App" : "record keeper"} can't lock its logs on this box, so it isn't ${who === "link" ? "taking taps or posting cards" : "applying anything"}. Nothing was lost. It needs a fix in a new version of the App. (${why.replace(/(?:\/[\w.@+-]+)+/g, "its log folder").slice(0, 160)})`;
// Round 19: a test's short write: returns how many bytes the write puts down (null: all of them).
export const shortWriteSpy: { on: null | ((file: string) => number | null) } = { on: null };
export function appendLog(file: string, rec: unknown): void {
  const buf = encode(rec);
  const fresh = !existsSync(file);
  if (fresh) mkdirSync(dirname(file), { recursive: true });
  withLogLock(file, () => appendBuf(file, buf));
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
