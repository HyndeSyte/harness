// Round 12: the append-only logs (the link's issued tap keys, the keeper's mirror of them, the
// keeper's consumed tap keys, and the landing ledger's hand settles), one framed record per line:
//   <byte length of the JSON>:<its CRC-32, 8 hex digits>:<the JSON>\n
// Each record is appended and fsynced before anything acts on it (the directory too when the file
// is new). On read, a final record that is cut short, or whose length or checksum doesn't match (a
// write a power cut tore), is truncated off the file and reported as torn, once: what came before
// it stands. A bad record before the last one is skipped and counted. No log is ever rewritten.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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

// Reads a log. repair: a torn final record is truncated off the file (the default).
export function readLog<T = any>(file: string, o: { repair?: boolean } = {}): LogRead<T> {
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
  if (out.torn && o.repair !== false) truncateSync(file, good);
  return out;
}

// Appends one record and fsyncs it (and its directory when the file is new). Throws on failure:
// the caller acts only once this returns.
export function appendLog(file: string, rec: unknown): void {
  const fresh = !existsSync(file);
  if (fresh) mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a", 0o600);
  try { writeSync(fd, frame(rec)); fsyncSync(fd); } finally { closeSync(fd); }
  if (fresh) {
    try { const d = openSync(dirname(file), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* a directory that can't be opened to sync (not on Linux) */ }
  }
}

// The same file's content written whole and fsynced, for a test that wants a log in a given state.
export function writeLogForTest(file: string, recs: unknown[], tail = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "w", 0o600);
  try { writeSync(fd, recs.map(frame).join("") + tail); fsyncSync(fd); } finally { closeSync(fd); }
}
