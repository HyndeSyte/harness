// (Keeper 0.1.9) The backup check's scan: a Home Assistant backup archive (an outer tar holding backup.json and one
// "<slug>.tar.gz" per App, unencrypted when made without a password) read member by member, nested tars and gzip
// opened, every member's name checked against the key file names and every member's bytes searched for the needles
// (the key values, their fingerprints, the sentinel). Pure: core.ts and the tests call it with bytes.
// 0.1.10: it fails closed. Every tar header's checksum and size are checked against the bytes there, a gzip that doesn't
// end whole (truncated) fails, a member in a format it can't open (zstd, xz, bzip2, zip, 7z), an archive-named member
// that is neither gzip nor tar (an encrypted SecureTar, or anything unknown), an unknown tar entry type and a
// backup.json that says protected all fail rather than being skipped; and a positive control (a value placed in a file
// the backup doesn't leave out) must be found exactly once, so a scan that read nothing useful can't pass.
// 0.1.16: the scan reaches every byte of the archive. Each archive layer's own bytes are searched whole as well as member by
// member (the gzip header's name and comment fields, each tar header's link name, owner names and pax records, the padding
// after each member, and whatever follows the end-of-archive block), a tar without the ustar magic (an old v7 header, its
// checksum valid) is read as a tar, and anything but zeros after a gzip stream or after a tar's end-of-archive block fails
// the check, since nothing reads it as a member. SCAN_VERSION names this coverage: a pass recorded by an earlier scan no
// longer counts (core.ts checkPassed).
// 0.1.16 (the fix round): the gzip member's end is found by the scan itself (gzipMember: the header's flags, extra field, name,
// comment and header CRC parsed, the deflate stream inflated with the inflater's consumed length, that length confirmed by
// inflating exactly that prefix and one byte less, and the 8-byte trailer's CRC32 and length checked against the output); a
// second gzip member, a trailer that doesn't match, or anything but zeros after the trailer fails closed. The positive control
// is counted once per leaf file only, and a copy of it anywhere else in a layer (a header field, the padding, the tail) fails
// the check. A layer read as a tar (ustar, or v7 with a valid checksum) must parse to its end-of-archive block, and one whose
// magic says gzip must decode: neither is ever taken for a leaf file. Every value searched for is at least MIN_NEEDLE bytes
// long (a shorter fingerprint could match random bytes by chance). Every failure names the layer, the byte offset and what
// matched.
import { inflateRawSync } from "node:zlib";

export const SCAN_VERSION = 2;
// (0.1.16) the shortest value searched for in an archive's bytes: shorter ones (an 8 or 12 hex digit fingerprint) are left out
export const MIN_NEEDLE = 16;

export interface ScanResult { ok: boolean; why: string; members: number; names: string[]; found: string[]; control: number }
export interface ScanOpts { control?: string }
// (0.1.16) a value searched for, with what it is (named in a failure); a bare string is "a key value, a key's fingerprint or the sentinel"
export type Needle = string | { value: string; kind: string };

const dec = new TextDecoder();
// The tar entry types a backup may hold: files, links, devices, folders, fifos, contiguous, GNU long names, pax headers.
const TAR_TYPES = new Set(["0", "\0", "1", "2", "3", "4", "5", "6", "7", "L", "K", "x", "g"]);
function* tarMembers(buf: Uint8Array): Generator<{ name: string; data: Uint8Array; type: string; at: number }> {
  let off = 0, longName = "", ended = false;
  const str = (a: number, n: number) => { const b = buf.subarray(a, a + n); const z = b.indexOf(0); return dec.decode(z >= 0 ? b.subarray(0, z) : b); };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) { ended = true; break; }
    // the header's own checksum (the sum of its bytes with the checksum field read as spaces)
    const want = parseInt(str(off + 148, 8).trim() || "x", 8);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(want) || want !== sum) throw new Error(`a tar header's checksum doesn't match at byte ${off}`);
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("a tar header's size can't be read");
    const type = String.fromCharCode(h[156]);
    if (!TAR_TYPES.has(type)) throw new Error(`a tar entry of an unknown type (${JSON.stringify(type)})`);
    const prefix = str(off + 345, 155);
    const name = longName || (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100));
    longName = "";
    if (off + 512 + size > buf.length) throw new Error(`the tar ends inside ${name} (truncated)`);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    const at = off - Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "x" || type === "g") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      if (m && type === "x") longName = m[1];
      continue;
    }
    yield { name, data, type, at };
  }
  if (!ended) throw new Error("the tar has no end-of-archive block (truncated)");
  // (0.1.16) nothing but zeros after the end-of-archive block: a second archive appended there is never read as members
  for (let i = off; i < buf.length; i++) if (buf[i] !== 0) throw new Error(`the tar holds data after its end-of-archive block (at byte ${i})`);
}
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
// (0.1.16) a ustar header, or an old v7 header (no magic) whose checksum is right and whose name is set
const isTar = (b: Uint8Array) => {
  if (b.length < 512) return false;
  if (dec.decode(b.subarray(257, 262)) === "ustar") return true;
  if (b[0] === 0) return false;
  const f = b.subarray(148, 156); const z = f.indexOf(0);
  const want = parseInt(dec.decode(z >= 0 ? f.subarray(0, z) : f).trim() || "x", 8);
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  return Number.isFinite(want) && want === sum;
};
// (0.1.16) CRC-32 (the gzip trailer's), table driven.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// (0.1.16) One gzip member read whole by the scan itself, never by trusting a decoder's count alone: the header parsed (method 8,
// no reserved flags; the extra field, name, comment and header CRC skipped by their own lengths and checked), the deflate stream
// inflated with the inflater's consumed length, that length confirmed (exactly that prefix inflates to the same output, one byte
// less doesn't), and the trailer's CRC32 and ISIZE checked against the output. After the trailer only zeros may follow: a second
// gzip member, or any other byte, fails closed (nothing would read it as a member). Throws, naming the offset, on any failure.
export function gzipMember(b: Uint8Array, what: string): Uint8Array {
  const fail = (why: string, at: number): never => { throw new Error(`${what} is a gzip that can't be read whole: ${why} (at byte ${at})`); };
  if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b) fail("no gzip header", 0);
  if (b[2] !== 8) fail(`compression method ${b[2]}, not deflate`, 2);
  const flg = b[3];
  if (flg & 0xe0) fail("reserved header flags set", 3);
  let p = 10;
  if (flg & 0x04) { if (p + 2 > b.length) fail("its extra field is cut off", p); const xlen = b[p] | (b[p + 1] << 8); p += 2 + xlen; if (p > b.length) fail("its extra field is cut off", p); }
  for (const bit of [0x08, 0x10]) if (flg & bit) { const z = b.indexOf(0, p); if (z < 0) fail(bit === 0x08 ? "its name field never ends" : "its comment field never ends", p); p = z + 1; }
  if (flg & 0x02) {
    if (p + 2 > b.length) fail("its header CRC is cut off", p);
    const want = b[p] | (b[p + 1] << 8);
    if ((crc32(b.subarray(0, p)) & 0xffff) !== want) fail("its header CRC doesn't match", p);
    p += 2;
  }
  const body = b.subarray(p);
  let r: any;
  try { r = inflateRawSync(body, { info: true } as any); } catch (e) { fail(`its deflate stream doesn't decode (${String((e as Error)?.message ?? e).slice(0, 40)})`, p); }
  const out: Uint8Array | undefined = r?.buffer instanceof Uint8Array ? r.buffer : undefined;
  const used = Number(r?.engine?.bytesWritten);
  if (!out || !Number.isSafeInteger(used) || used <= 0 || used > body.length) fail("the inflater doesn't say how much of the stream it read", p);
  // the consumed length confirmed: exactly that prefix decodes to the same output, and one byte less doesn't decode at all
  let same = false;
  try { const again = inflateRawSync(body.subarray(0, used)); same = again.length === out!.length && Buffer.from(again).equals(Buffer.from(out!)); } catch { same = false; }
  if (!same) fail("the inflater's read length doesn't hold up", p + used);
  let shorter = true;
  try { inflateRawSync(body.subarray(0, used - 1)); } catch { shorter = false; }
  if (shorter) fail("the deflate stream ends before the inflater says it does", p + used);
  const t = p + used;
  if (t + 8 > b.length) fail("its 8-byte trailer is cut off", t);
  const crc = (b[t] | (b[t + 1] << 8) | (b[t + 2] << 16) | (b[t + 3] << 24)) >>> 0;
  const isize = (b[t + 4] | (b[t + 5] << 8) | (b[t + 6] << 16) | (b[t + 7] << 24)) >>> 0;
  if (crc !== crc32(out!)) fail("its trailer's CRC32 doesn't match what it decodes to", t);
  if (isize !== (out!.length >>> 0)) fail("its trailer's length doesn't match what it decodes to", t + 4);
  const end = t + 8;
  if (end + 1 < b.length && b[end] === 0x1f && b[end + 1] === 0x8b) throw new Error(`${what} holds a second gzip member after the first (at byte ${end}), which Keeper doesn't read`);
  for (let i = end; i < b.length; i++) if (b[i] !== 0) throw new Error(`${what} holds data after its gzip stream (at byte ${i})`);
  return out!;
}
// Formats Keeper can't open: a member in one fails the check, never skipped.
const UNREADABLE: [string, number[]][] = [["zstd", [0x28, 0xb5, 0x2f, 0xfd]], ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ["bzip2", [0x42, 0x5a, 0x68]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]], ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ["lz4", [0x04, 0x22, 0x4d, 0x18]]];
const magic = (b: Uint8Array) => UNREADABLE.find(([, m]) => b.length >= m.length && m.every((x, i) => b[i] === x))?.[0] ?? "";
const ARCHIVE_NAME = /\.(tar|tgz|gz|tar\.gz|zst|tzst|xz|txz|bz2|tbz2?|zip|7z|lz4)$/i;
// Count of non-overlapping occurrences of needle in hay.
const count = (hay: Buffer, needle: Buffer) => { let n = 0, i = hay.indexOf(needle); while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };
const GENERIC = "a key value, a key's fingerprint or the sentinel";

// names: a member whose path matches is a finding; needles: any found in a member's bytes (or its name) is a finding;
// opts.control: the positive control, which must be found exactly once in the files read, and nowhere else.
export function scanBackup(bytes: Uint8Array, names: RegExp, needles: Needle[], opts: ScanOpts = {}): ScanResult {
  const found: string[] = [], seen: string[] = [];
  let members = 0, control = 0;
  const enc = new TextEncoder();
  // (0.1.16) every value at least MIN_NEEDLE bytes: shorter ones are never searched for in the archive's bytes
  const pats = needles.map((n) => (typeof n === "string" ? { value: n, kind: GENERIC } : n)).filter((n) => enc.encode(n.value).length >= MIN_NEEDLE)
    .map((n) => ({ n: n.value, kind: n.kind, b: Buffer.from(enc.encode(n.value)) }));
  const ctl = opts.control ? Buffer.from(enc.encode(opts.control)) : null;
  const buf = (x: Uint8Array) => Buffer.from(x.buffer, x.byteOffset, x.length);
  // (0.1.16) a layer's own bytes searched whole for the key values, fingerprints and sentinels (never the control), each finding
  // naming the layer, the byte offset and what matched
  const search = (x: Uint8Array, layer: string) => { const X = buf(x); for (const p of pats) { const i = X.indexOf(p.b); if (i >= 0) found.push(`${layer} holds ${p.kind} at byte ${i}`); } };
  const walk = (b0: Uint8Array, where: string, depth: number) => {
    if (depth > 6) throw new Error("the archive nests too deep");
    const what = where || "the archive";
    let b = b0;
    if (isGzip(b)) {
      search(b, `${what} (its gzip bytes)`);
      if (ctl) { const i = buf(b).indexOf(ctl); if (i >= 0) throw new Error(`${what} (its gzip bytes) holds the positive control outside any file, at byte ${i}`); }
      // a gzip that doesn't decode, isn't whole, or has anything but zeros after its one member fails the check: never a leaf
      b = gzipMember(b, what);
    }
    const m = magic(b);
    if (m) throw new Error(`${what} is ${m}-compressed, which Keeper can't read (at byte 0)`);
    if (!isTar(b)) {
      if (depth > 0 && ARCHIVE_NAME.test(where.split(":").pop() ?? "")) throw new Error(`${what} is named as an archive but is neither gzip nor tar (encrypted or unknown) (at byte 0)`);
      if (depth === 0) throw new Error("the backup isn't a tar archive (at byte 0)");
      search(b, what);
      // the control counted once per leaf file
      if (ctl) control += count(buf(b), ctl);
      if (/(^|\/)backup\.json$/.test(where.split(":").pop() ?? "")) {
        let j: any = null; try { j = JSON.parse(dec.decode(b)); } catch { j = null; }
        if (j && j.protected === true) throw new Error(`${what} says the backup is protected (encrypted)`);
      }
      return;
    }
    // a layer read as a tar (ustar, or v7 with a valid checksum) parses to its end-of-archive block, or the check fails (tarMembers
    // throws, naming the byte): it is never taken for a leaf file
    search(b, `${what} (its tar headers, padding or tail)`);
    let list: { name: string; data: Uint8Array; type: string; at: number }[];
    try { list = [...tarMembers(b)]; } catch (e) { throw new Error(`${what}, read as a tar: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    if (ctl) {
      // a control copy in the tar's own bytes that no member's data holds (a header field, the padding, the tail) fails the check
      const whole = count(buf(b), ctl);
      const inData = list.reduce((n, t) => n + count(buf(t.data), ctl), 0);
      if (whole !== inData) {
        let at = -1, i = buf(b).indexOf(ctl);
        while (i >= 0 && at < 0) { if (!list.some((t) => i >= t.at && i + ctl.length <= t.at + t.data.length)) at = i; i = buf(b).indexOf(ctl, i + 1); }
        throw new Error(`${what} (its tar headers, padding or tail) holds the positive control outside any file, at byte ${at}`);
      }
    }
    for (const t of list) {
      members++;
      const path = `${where}${where ? ":" : ""}${t.name}`;
      seen.push(path);
      const bare = t.name.replace(/^\.\//, "");
      if (names.test(bare)) found.push(`${path} is a key file's name (at byte ${t.at - 512} of ${what})`);
      for (const p of pats) if (t.name.includes(p.n)) found.push(`${path} names ${p.kind} (at byte ${t.at - 512} of ${what})`);
      if (t.type === "0" || t.type === "\0" || t.type === "7") walk(t.data, path, depth + 1);
      else if (t.data.length) throw new Error(`${path} is a tar entry of type ${t.type} that carries data (at byte ${t.at} of ${what})`);
    }
  };
  try { walk(bytes, "", 0); } catch (e) { return { ok: false, why: `the backup couldn't be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`, members, names: seen, found, control }; }
  if (!members) return { ok: false, why: "the backup holds no files Keeper could read", members, names: seen, found, control };
  if (found.length) return { ok: false, why: `the backup holds key material: ${[...new Set(found)].slice(0, 5).join("; ")}`, members, names: seen, found, control };
  if (ctl && control !== 1) return { ok: false, why: `the positive control was found ${control} times, not exactly once, in the files read (the scan didn't read the files the backup holds as it should)`, members, names: seen, found, control };
  return { ok: true, why: "", members, names: seen, found, control };
}
