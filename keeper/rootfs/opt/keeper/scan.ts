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
import { gunzipSync } from "node:zlib";

export const SCAN_VERSION = 2;

export interface ScanResult { ok: boolean; why: string; members: number; names: string[]; found: string[]; control: number }
export interface ScanOpts { control?: string }

const dec = new TextDecoder();
// The tar entry types a backup may hold: files, links, devices, folders, fifos, contiguous, GNU long names, pax headers.
const TAR_TYPES = new Set(["0", "\0", "1", "2", "3", "4", "5", "6", "7", "L", "K", "x", "g"]);
function* tarMembers(buf: Uint8Array): Generator<{ name: string; data: Uint8Array; type: string }> {
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
    if (type === "L") { longName = dec.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "x" || type === "g") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      if (m && type === "x") longName = m[1];
      continue;
    }
    yield { name, data, type };
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
// (0.1.16) A gzip read whole, its members one after another; what follows the last member must be zeros (the decoder stops
// at them silently, so bytes after them would never be read). A decoder that doesn't say how much it read fails closed.
function gunzipWhole(b: Uint8Array, what: string): Uint8Array {
  let r: any;
  try { r = gunzipSync(b, { info: true } as any); } catch (e) { throw new Error(`${what} is a gzip that can't be read whole (${String((e as Error)?.message ?? e).slice(0, 40)})`); }
  const out: Uint8Array | undefined = r?.buffer ?? (r instanceof Uint8Array ? r : undefined);
  const used = Number(r?.engine?.bytesWritten);
  if (!out || !Number.isFinite(used) || used <= 0 || used > b.length) throw new Error(`${what} is a gzip whose read length can't be told, so its end can't be checked`);
  for (let i = used; i < b.length; i++) if (b[i] !== 0) throw new Error(`${what} holds data after its gzip stream (at byte ${i})`);
  return out;
}
// Formats Keeper can't open: a member in one fails the check, never skipped.
const UNREADABLE: [string, number[]][] = [["zstd", [0x28, 0xb5, 0x2f, 0xfd]], ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ["bzip2", [0x42, 0x5a, 0x68]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]], ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ["lz4", [0x04, 0x22, 0x4d, 0x18]]];
const magic = (b: Uint8Array) => UNREADABLE.find(([, m]) => b.length >= m.length && m.every((x, i) => b[i] === x))?.[0] ?? "";
const ARCHIVE_NAME = /\.(tar|tgz|gz|tar\.gz|zst|tzst|xz|txz|bz2|tbz2?|zip|7z|lz4)$/i;
// Count of non-overlapping occurrences of needle in hay.
const count = (hay: Buffer, needle: Buffer) => { let n = 0, i = hay.indexOf(needle); while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };

// names: a member whose path matches is a finding; needles: any found in a member's bytes (or its name) is a finding;
// opts.control: the positive control, which must be found exactly once in the files read.
export function scanBackup(bytes: Uint8Array, names: RegExp, needles: string[], opts: ScanOpts = {}): ScanResult {
  const found: string[] = [], seen: string[] = [];
  let members = 0, control = 0;
  const enc = new TextEncoder();
  const pats = needles.filter((n) => n.length >= 8).map((n) => ({ n, b: Buffer.from(enc.encode(n)) }));
  const ctl = opts.control ? Buffer.from(enc.encode(opts.control)) : null;
  const walk = (buf: Uint8Array, where: string, depth: number) => {
    if (depth > 6) throw new Error("the archive nests too deep");
    const what = where || "the archive";
    let b = buf;
    // (0.1.16) every layer's own bytes, searched whole: a gzip's header fields, a tar's headers, padding and tail
    const raw = (x: Uint8Array, layer: string) => { const X = Buffer.from(x.buffer, x.byteOffset, x.length); for (const p of pats) if (X.includes(p.b)) found.push(`${what}${layer} holds a key value, a key's fingerprint or the sentinel`); };
    if (isGzip(b)) {
      raw(b, " (its gzip bytes)");
      // a gzip that doesn't end whole throws here (unexpected end of file): a truncated member fails the check
      b = gunzipWhole(b, what);
    }
    const m = magic(b);
    if (m) throw new Error(`${what} is ${m}-compressed, which Keeper can't read`);
    if (!isTar(b)) {
      if (depth > 0 && ARCHIVE_NAME.test(where.split(":").pop() ?? "")) throw new Error(`${what} is named as an archive but is neither gzip nor tar (encrypted or unknown)`);
      if (depth === 0) throw new Error("the backup isn't a tar archive");
      const B = Buffer.from(b.buffer, b.byteOffset, b.length);
      for (const p of pats) if (B.includes(p.b)) found.push(`${what} holds a key value, a key's fingerprint or the sentinel`);
      if (ctl) control += count(B, ctl);
      if (/(^|\/)backup\.json$/.test(where.split(":").pop() ?? "")) {
        let j: any = null; try { j = JSON.parse(dec.decode(b)); } catch { j = null; }
        if (j && j.protected === true) throw new Error(`${what} says the backup is protected (encrypted)`);
      }
      return;
    }
    raw(b, " (its tar headers, padding or tail)");
    for (const t of tarMembers(b)) {
      members++;
      const path = `${where}${where ? ":" : ""}${t.name}`;
      seen.push(path);
      const bare = t.name.replace(/^\.\//, "");
      if (names.test(bare)) found.push(`${path} is a key file's name`);
      for (const p of pats) if (t.name.includes(p.n)) found.push(`${path} names a key value, a key's fingerprint or the sentinel`);
      if (t.type === "0" || t.type === "\0" || t.type === "7") walk(t.data, path, depth + 1);
      else if (t.data.length) throw new Error(`${path} is a tar entry of type ${t.type} that carries data`);
    }
  };
  try { walk(bytes, "", 0); } catch (e) { return { ok: false, why: `the backup couldn't be read: ${String((e as Error)?.message ?? e).slice(0, 160)}`, members, names: seen, found, control }; }
  if (!members) return { ok: false, why: "the backup holds no files Keeper could read", members, names: seen, found, control };
  if (found.length) return { ok: false, why: `the backup holds key material: ${[...new Set(found)].slice(0, 5).join("; ")}`, members, names: seen, found, control };
  if (ctl && control !== 1) return { ok: false, why: `the positive control was found ${control} times, not exactly once (the scan didn't read the files the backup holds as it should)`, members, names: seen, found, control };
  return { ok: true, why: "", members, names: seen, found, control };
}
