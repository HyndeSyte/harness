// (Keeper 0.1.9) The backup check's scan: a Home Assistant backup archive (an outer tar holding backup.json and one
// "<slug>.tar.gz" per App, unencrypted when made without a password) read member by member, nested tars and gzip
// opened, every member's name checked against the key file names and every member's bytes searched for the needles
// (the key values, their fingerprints, the sentinel).
// 0.1.10: it fails closed. Every tar header's checksum and size are checked against the bytes there, a gzip that doesn't
// end whole (truncated) fails, a member in a format it can't open (zstd, xz, bzip2, zip, 7z), an archive-named member
// that is neither gzip nor tar (an encrypted SecureTar, or anything unknown), an unknown tar entry type and a
// backup.json that says protected all fail rather than being skipped; and a positive control (a value placed in a file
// the backup doesn't leave out) must be found exactly once, so a scan that read nothing useful can't pass.
// 0.1.16: the scan reaches every byte of the archive. Each archive layer's own bytes are searched as well as member by
// member (the gzip header's name and comment fields, each tar header's link name, owner names and pax records, the padding
// after each member, and whatever follows the end-of-archive block), a tar without the ustar magic (an old v7 header, its
// checksum valid) is read as a tar, and anything but zeros after a gzip stream or after a tar's end-of-archive block fails
// the check, since nothing reads it as a member. The gzip member's end is found by the scan itself (the header's flags,
// extra field, name, comment and header CRC parsed, the trailer's CRC32 and length checked against the output); a second
// gzip member, a trailer that doesn't match, or anything but zeros after the trailer fails closed. The positive control is
// counted once per leaf file only, and a copy of it anywhere else in a layer (a header field, the padding, the tail, the
// gzip bytes) fails the check. A layer read as a tar (ustar, or v7 with a valid checksum) must parse to its end-of-archive
// block, and one whose magic says gzip must decode: neither is ever taken for a leaf file. Every value searched for is at
// least MIN_NEEDLE bytes long (a shorter fingerprint could match random bytes by chance). Every failure names the layer,
// the byte offset and what matched.
// 0.1.17: the scan streams, in bounded memory (on the device, 0.1.16's scan of a 100 MB backup held the whole archive and
// each inflated layer several times over, and the kernel killed the service). Nothing it looks for changed, only how it reads:
//   - the outer tar is read from the downloaded file by offsets (scanFile), a chunk at a time, never whole in memory;
//   - each layer is a stream: a tar layer parses its headers as the bytes arrive and hands each member's data on to the
//     member's own layer as it streams; a gzip layer parses its header, inflates its one member once through a streaming
//     inflater into the next layer, and computes CRC32 and the length over the output as it streams (gzipLayer: the proof of
//     the member's end, which replaces 0.1.16's two confirming re-inflations, is written there);
//   - the needles are searched for across chunk boundaries (Finder: the last longest-needle-minus-one bytes are carried over,
//     so a value split across two chunks is still found), and a tar layer's own bytes (headers, pax and long-name records,
//     padding, the end block and its tail) are searched by offset ranges as the layer streams, excluding each member's data
//     region, which that member's layer searches itself; the control is counted the same way;
//   - a hard budget on expanded bytes (MAX_EXPANDED, 4 GB decoded in all) and on nesting (MAX_DEPTH) fails closed, naming
//     itself; a record Keeper must hold to read (a pax or long-name record, a gzip header's fields, backup.json) is held to
//     MAX_RECORD bytes, and a larger one fails closed too.
// SCAN_VERSION names this coverage: a pass recorded by an earlier scan no longer counts (core.ts checkPassed).
// It runs in a child process of the service (main.ts scanChild runs this file as `bun --smol scan.ts child`), so if the kernel
// still kills it the service lives on and reports it; core.ts and the tests call scanFile or scanBackup in process.
import { createInflateRaw, crc32 as zcrc32 } from "node:zlib";
import { open } from "node:fs/promises";

export const SCAN_VERSION = 3;
// (0.1.16) the shortest value searched for in an archive's bytes: shorter ones (an 8 or 12 hex digit fingerprint) are left out
export const MIN_NEEDLE = 16;
// (0.1.17) the budgets: bytes decoded by every gzip layer together, the deepest nesting, and the largest record held to be read
export const MAX_EXPANDED = 4 * 1024 ** 3;
export const MAX_DEPTH = 6;
export const MAX_RECORD = 1024 * 1024;
const READ_CHUNK = 256 * 1024;        // the outer file, read a chunk at a time
const INFLATE_IN = 8 * 1024;          // the inflater fed this much at a time: at most about 8 MB of output per step (deflate's 1032:1)

export interface ScanResult { ok: boolean; why: string; members: number; names: string[]; found: string[]; control: number; expanded?: number }
// (0.1.17) the downloaded archive the scan reads: its file's path, its size in bytes, and its removal
export interface ArchiveFile { path: string; size: number; remove: () => void }
export interface ScanOpts { control?: string; maxExpanded?: number; maxDepth?: number }
// (0.1.16) a value searched for, with what it is (named in a failure); a bare string is "a key value, a key's fingerprint or the sentinel"
export type Needle = string | { value: string; kind: string };

const dec = new TextDecoder();
const enc = new TextEncoder();
const GENERIC = "a key value, a key's fingerprint or the sentinel";
const NAMES_KEPT = 10_000;            // the member paths kept for the result (every member is still counted and checked)
// The tar entry types a backup may hold: files, links, devices, folders, fifos, contiguous, GNU long names, pax headers.
const TAR_TYPES = new Set(["0", "\0", "1", "2", "3", "4", "5", "6", "7", "L", "K", "x", "g"]);
// Formats Keeper can't open: a member in one fails the check, never skipped.
const UNREADABLE: [string, number[]][] = [["zstd", [0x28, 0xb5, 0x2f, 0xfd]], ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ["bzip2", [0x42, 0x5a, 0x68]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]], ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ["lz4", [0x04, 0x22, 0x4d, 0x18]]];
const magic = (b: Uint8Array) => UNREADABLE.find(([, m]) => b.length >= m.length && m.every((x, i) => b[i] === x))?.[0] ?? "";
const ARCHIVE_NAME = /\.(tar|tgz|gz|tar\.gz|zst|tzst|xz|txz|bz2|tbz2?|zip|7z|lz4)$/i;
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const field = (b: Uint8Array, a: number, n: number) => { const x = b.subarray(a, a + n); const z = x.indexOf(0); return dec.decode(z >= 0 ? x.subarray(0, z) : x); };
const headerSum = (h: Uint8Array) => { let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]; return sum; };
// (0.1.16) a ustar header, or an old v7 header (no magic) whose checksum is right and whose name is set
const isTar = (b: Uint8Array) => {
  if (b.length < 512) return false;
  if (dec.decode(b.subarray(257, 262)) === "ustar") return true;
  if (b[0] === 0) return false;
  const want = parseInt(field(b, 148, 8).trim() || "x", 8);
  return Number.isFinite(want) && want === headerSum(b);
};
// (0.1.16) CRC-32 (the gzip trailer's); 0.1.17: zlib's own, run over the output as it streams
export function crc32(b: Uint8Array, prev = 0): number { return zcrc32(b, prev) >>> 0; }
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

interface Pat { kind: string; b: Uint8Array }
// (0.1.17) The needle search over a stream: every occurrence of each pattern reported by its absolute offset, including one
// split across two chunks (the last longest-needle-minus-one bytes are carried into the next push and searched with its start).
// gap() says bytes were left out (a member's data inside a tar layer, which the member's own layer searches): the carry is
// dropped, since no occurrence that ends after the gap can start before it without lying wholly inside that data.
class Finder {
  private carry = new Uint8Array(0);
  private carryAt = 0;
  private readonly keep: number;
  constructor(private readonly pats: Pat[], private readonly hit: (i: number, at: number) => void) {
    this.keep = Math.max(1, ...pats.map((p) => p.b.length)) - 1;
  }
  push(chunk: Uint8Array, at: number) {
    if (!chunk.length || !this.pats.length) return;
    if (this.carry.length && this.carryAt + this.carry.length !== at) this.gap();
    const C = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    if (this.carry.length) {
      // the seam: the carry and the first bytes of this chunk, searched for occurrences that start in the carry
      const seam = Buffer.from(cat(this.carry, chunk.subarray(0, this.keep)));
      for (let p = 0; p < this.pats.length; p++) {
        const n = this.pats[p].b;
        let i = seam.indexOf(n);
        // only an occurrence that runs into this chunk: one wholly inside the carry was reported by the push that brought it
        while (i >= 0 && i < this.carry.length) { if (i + n.length > this.carry.length) this.hit(p, this.carryAt + i); i = seam.indexOf(n, i + 1); }
      }
    }
    for (let p = 0; p < this.pats.length; p++) {
      const n = this.pats[p].b;
      let i = C.indexOf(n);
      while (i >= 0) { this.hit(p, at + i); i = C.indexOf(n, i + 1); }
    }
    // the next carry: the last `keep` bytes seen, copied (the chunk itself is never held)
    if (chunk.length >= this.keep) { this.carry = chunk.slice(chunk.length - this.keep); this.carryAt = at + chunk.length - this.keep; }
    else { const all = cat(this.carry, chunk); this.carry = all.slice(Math.max(0, all.length - this.keep)); this.carryAt = at + chunk.length - this.carry.length; }
  }
  gap() { this.carry = new Uint8Array(0); }
}

// What every layer of one scan shares: the patterns, the findings, the counts and the budgets.
class Ctx {
  found: string[] = []; seen: string[] = [];
  members = 0; control = 0; expanded = 0;
  readonly pats: Pat[]; readonly ctl: Uint8Array | null; readonly all: Pat[];
  constructor(readonly names: RegExp, needles: Needle[], opts: ScanOpts, readonly maxExpanded: number, readonly maxDepth: number) {
    // (0.1.16) every value at least MIN_NEEDLE bytes: shorter ones are never searched for in the archive's bytes
    this.pats = needles.map((n) => (typeof n === "string" ? { value: n, kind: GENERIC } : n)).filter((n) => enc.encode(n.value).length >= MIN_NEEDLE)
      .map((n) => ({ kind: n.kind, b: enc.encode(n.value) }));
    this.ctl = opts.control ? enc.encode(opts.control) : null;
    // the control, when set, is the last pattern of every Finder
    this.all = this.ctl ? [...this.pats, { kind: "the positive control", b: this.ctl }] : this.pats;
  }
}

interface Sink { write(b: Uint8Array): Promise<void>; end(): Promise<void> }

// (0.1.17) A layer whose kind isn't known yet: its first bytes (up to one tar header) are held, then it becomes a gzip, tar
// or leaf layer, chosen as 0.1.16 chose them (gzip by its magic unless it is already a gzip's output, then a format Keeper
// can't read, then a tar, else a leaf file; at the top a leaf fails: the backup isn't a tar).
class Detect implements Sink {
  private head = new Uint8Array(0);
  private next: Sink | null = null;
  constructor(private readonly ctx: Ctx, private readonly where: string, private readonly depth: number, private readonly afterGzip = false) {
    if (depth > ctx.maxDepth) throw new Error(`the archive nests too deep: ${where || "the archive"} is more than ${ctx.maxDepth} layers in (the nesting budget, at byte 0)`);
  }
  private choose(): Sink {
    const b = this.head, what = this.where || "the archive";
    if (!this.afterGzip && isGzip(b)) return new GzipLayer(this.ctx, this.where, this.depth);
    const m = magic(b);
    if (m) throw new Error(`${what} is ${m}-compressed, which Keeper can't read (at byte 0)`);
    if (isTar(b)) return new TarLayer(this.ctx, this.where, this.depth);
    if (this.depth > 0 && ARCHIVE_NAME.test(this.where.split(":").pop() ?? "")) throw new Error(`${what} is named as an archive but is neither gzip nor tar (encrypted or unknown) (at byte 0)`);
    if (this.depth === 0) throw new Error("the backup isn't a tar archive (at byte 0)");
    return new Leaf(this.ctx, this.where);
  }
  async write(b: Uint8Array) {
    if (this.next) return this.next.write(b);
    const need = 512 - this.head.length;
    this.head = cat(this.head, b.subarray(0, need));
    if (this.head.length < 512) return;
    this.next = this.choose();
    await this.next.write(this.head);
    if (b.length > need) await this.next.write(b.subarray(need));
  }
  async end() {
    if (!this.next) { this.next = this.choose(); if (this.head.length) await this.next.write(this.head); }
    await this.next.end();
  }
}

// A leaf file: searched whole (as it streams), the control counted (non-overlapping), backup.json read for its protected flag.
class Leaf implements Sink {
  private at = 0; private ctlEnd = 0; private json: Uint8Array[] | null = null; private jsonLen = 0;
  private readonly finder: Finder; private readonly reported = new Set<number>();
  constructor(private readonly ctx: Ctx, private readonly where: string) {
    const ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    this.finder = new Finder(ctx.all, (i, at) => {
      if (i === ctl) { if (at >= this.ctlEnd) { ctx.control++; this.ctlEnd = at + ctx.ctl!.length; } return; }
      if (this.reported.has(i)) return;
      this.reported.add(i);
      ctx.found.push(`${where} holds ${ctx.all[i].kind} at byte ${at}`);
    });
    if (/(^|\/)backup\.json$/.test(where.split(":").pop() ?? "")) this.json = [];
  }
  async write(b: Uint8Array) {
    this.finder.push(b, this.at);
    this.at += b.length;
    if (this.json) {
      this.jsonLen += b.length;
      if (this.jsonLen > MAX_RECORD) throw new Error(`${this.where} is larger than ${MAX_RECORD} bytes, more than Keeper reads of a backup.json (the record budget, at byte ${MAX_RECORD})`);
      this.json.push(b.slice());
    }
  }
  async end() {
    if (!this.json) return;
    const all = new Uint8Array(this.jsonLen); let o = 0; for (const p of this.json) { all.set(p, o); o += p.length; }
    let j: any = null; try { j = JSON.parse(dec.decode(all)); } catch { j = null; }
    if (j && j.protected === true) throw new Error(`${this.where} says the backup is protected (encrypted)`);
  }
}

// (0.1.17) A tar layer, parsed as it streams. Its own bytes (each header, each pax or long-name record, each member's padding,
// the end-of-archive block and everything after it) are searched for the needles and the control by offset ranges: a member's
// data region is left to the member's own layer, so only its first and last longest-needle-minus-one bytes are searched here,
// for an occurrence that straddles a region's edge; an occurrence wholly inside a member's data is that member's to report.
// A control copy anywhere in the layer's own bytes fails the check at once; a key value or fingerprint is a finding.
class TarLayer implements Sink {
  private at = 0;                         // the layer's offset of the next byte
  private state: "head" | "data" | "pad" | "tail" = "head";
  private h = new Uint8Array(512); private hn = 0; private hAt = 0;
  private longName = "";
  private left = 0; private pad = 0;      // data bytes and padding bytes still to come for the current member
  private child: Sink | null = null;      // the current member's layer (a file's data), or null
  private rec: Uint8Array[] | null = null; private recLen = 0; private recType = "";
  private region: [number, number] = [0, 0];   // the current member's data region [start, end), left to its layer
  private name = "";
  private readonly finder: Finder; private readonly reported = new Set<number>();
  private readonly what: string; private readonly keep: number;
  constructor(private readonly ctx: Ctx, private readonly where: string, private readonly depth: number) {
    this.what = where || "the archive";
    const ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    this.keep = Math.max(1, ...ctx.all.map((p) => p.b.length)) - 1;
    this.finder = new Finder(ctx.all, (i, at) => {
      const n = ctx.all[i].b.length;
      if (at >= this.region[0] && at + n <= this.region[1]) return;        // wholly inside the member's data: its own layer reports it
      if (i === ctl) throw new Error(`${this.what} (its tar headers, padding or tail) holds the positive control outside any file, at byte ${at}`);
      if (this.reported.has(i)) return;
      this.reported.add(i);
      ctx.found.push(`${this.what} (its tar headers, padding or tail) holds ${ctx.all[i].kind} at byte ${at}`);
    });
  }
  private fail(why: string): never { throw new Error(`${this.what}, read as a tar: ${why}`); }
  // the layer's own bytes, searched whole
  private own(b: Uint8Array) { this.finder.push(b, this.at); this.at += b.length; }
  // a member's data bytes: only those within `keep` of the region's edges are searched here
  private data(b: Uint8Array) {
    const [s, e] = this.region, k = this.keep, a = this.at, z = a + b.length;
    const lo = Math.min(z, s + k), hi = Math.max(a, e - k);
    if (lo >= hi) this.finder.push(b, a);
    else {
      if (lo > a) this.finder.push(b.subarray(0, lo - a), a);
      this.finder.gap();
      if (z > hi) this.finder.push(b.subarray(hi - a), hi);
    }
    this.at = z;
  }
  private async header() {
    const h = this.h, off = this.hAt;
    if (h.every((x) => x === 0)) { this.state = "tail"; return; }
    // the header's own checksum (the sum of its bytes with the checksum field read as spaces)
    const want = parseInt(field(h, 148, 8).trim() || "x", 8);
    if (!Number.isFinite(want) || want !== headerSum(h)) this.fail(`a tar header's checksum doesn't match at byte ${off}`);
    const size = parseInt(field(h, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) this.fail(`a tar header's size can't be read (at byte ${off})`);
    const type = String.fromCharCode(h[156]);
    if (!TAR_TYPES.has(type)) this.fail(`a tar entry of an unknown type (${JSON.stringify(type)}) at byte ${off}`);
    const prefix = field(h, 345, 155);
    const name = this.longName || (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    this.longName = "";
    this.name = name;
    this.left = size; this.pad = Math.ceil(size / 512) * 512 - size;
    this.region = [off + 512, off + 512 + size];
    this.child = null; this.rec = null;
    if (type === "L" || type === "x" || type === "g") {
      // a long-name or pax record: read by Keeper (held, to MAX_RECORD), and its bytes are the layer's own, searched whole
      if (size > MAX_RECORD) this.fail(`a ${type === "L" ? "long-name" : "pax"} record of ${size} bytes at byte ${off}, more than Keeper reads (the record budget)`);
      this.rec = []; this.recLen = 0; this.recType = type; this.region = [0, 0];
    } else {
      const ctx = this.ctx;
      ctx.members++;
      const path = `${this.where}${this.where ? ":" : ""}${name}`;
      if (ctx.seen.length < NAMES_KEPT) ctx.seen.push(path);
      const bare = name.replace(/^\.\//, "");
      if (ctx.names.test(bare)) ctx.found.push(`${path} is a key file's name (at byte ${off} of ${this.what})`);
      for (const p of ctx.pats) if (name.includes(dec.decode(p.b))) ctx.found.push(`${path} names ${p.kind} (at byte ${off} of ${this.what})`);
      if (type === "0" || type === "\0" || type === "7") this.child = new Detect(ctx, path, this.depth + 1);
      else if (size) throw new Error(`${path} is a tar entry of type ${type} that carries data (at byte ${off + 512} of ${this.what})`);
    }
    this.state = "data";
    if (!this.left) await this.memberEnd();
  }
  private async memberEnd() {
    if (this.child) { const c = this.child; this.child = null; await c.end(); }
    if (this.rec) {
      const all = new Uint8Array(this.recLen); let o = 0; for (const p of this.rec) { all.set(p, o); o += p.length; }
      this.rec = null;
      if (this.recType === "L") this.longName = dec.decode(all).replace(/\0+$/, "");
      else { const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(all)); if (m && this.recType === "x") this.longName = m[1]; }
    }
    this.region = [0, 0];
    this.state = this.pad ? "pad" : "head";
  }
  async write(b: Uint8Array) {
    let i = 0;
    while (i < b.length) {
      if (this.state === "head") {
        const n = Math.min(512 - this.hn, b.length - i);
        if (this.hn === 0) this.hAt = this.at;
        this.h.set(b.subarray(i, i + n), this.hn); this.hn += n;
        this.own(b.subarray(i, i + n)); i += n;
        if (this.hn === 512) { this.hn = 0; await this.header(); }
      } else if (this.state === "data") {
        const n = Math.min(this.left, b.length - i);
        const part = b.subarray(i, i + n);
        if (this.rec) { this.rec.push(part.slice()); this.recLen += n; this.own(part); }
        else { this.data(part); if (this.child) await this.child.write(part); }
        i += n; this.left -= n;
        if (!this.left) await this.memberEnd();
      } else if (this.state === "pad") {
        const n = Math.min(this.pad, b.length - i);
        this.own(b.subarray(i, i + n)); i += n; this.pad -= n;
        if (!this.pad) this.state = "head";
      } else {
        // (0.1.16) nothing but zeros after the end-of-archive block: a second archive appended there is never read as members
        const part = b.subarray(i);
        this.own(part);
        const nz = part.findIndex((x) => x !== 0);
        if (nz >= 0) this.fail(`the tar holds data after its end-of-archive block (at byte ${this.at - part.length + nz})`);
        i = b.length;
      }
    }
  }
  async end() {
    if (this.state === "data") this.fail(`the tar ends inside ${this.name} (truncated)`);
    if (this.state !== "tail") this.fail("the tar has no end-of-archive block (truncated)");
  }
}

// (0.1.17) A gzip layer: one gzip member read whole by the scan itself, as it streams. Its raw bytes are searched whole (the
// header's name and comment fields included); the header is parsed (method 8, no reserved flags; the extra field, name, comment
// and header CRC skipped by their own lengths and checked); the deflate stream goes once through zlib's streaming inflater,
// whose output goes on to the next layer as it comes, with its CRC32, its length and the expanded-bytes budget kept over it;
// then the 8-byte trailer is checked against them, and after it only zeros may follow (a second gzip member, or any other
// byte, fails closed: nothing would read it as a member).
// The proof of the member's end (it replaces 0.1.16's two confirming re-inflations, which needed the whole member in memory):
// zlib's inflate stops at the end of the deflate stream's final block and nowhere else, and gives back every whole byte it
// didn't use, so the count of bytes it consumed (the stream's bytesWritten, checked a step at a time: a step that consumed less
// than it was given, or nothing, is the end) is exactly the stream's end, the byte holding its last bit included, as zlib itself
// defines it; one byte less would leave that final block unfinished. At that position the trailer must carry the CRC32 and the
// length (mod 2^32) of every byte decoded: had the end been misplaced, the 8 bytes there would be deflate data or something
// else, and matching both by chance has odds below one in 2^32. The 0.1.16 re-inflations proved the same two things (the
// consumed length decodes to the same output; one byte less doesn't end) with the whole member held twice more.
class GzipLayer implements Sink {
  private at = 0;                          // the layer's offset of the next raw byte
  private state: "head" | "body" | "trailer" | "after" = "head";
  private head = new Uint8Array(0); private bodyAt = 0;
  private inf: any = null; private q: Uint8Array[] = []; private infErr: unknown = null; private done: Promise<void> | null = null;
  private crc = 0; private size = 0;       // over the output
  private tr = new Uint8Array(0); private trAt = 0; private endAt = 0;
  private after = 0; private first = -1;
  private readonly next: Detect; private readonly finder: Finder; private readonly reported = new Set<number>();
  private readonly what: string;
  constructor(private readonly ctx: Ctx, where: string, depth: number) {
    this.what = where || "the archive";
    const ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    this.finder = new Finder(ctx.all, (i, at) => {
      if (i === ctl) throw new Error(`${this.what} (its gzip bytes) holds the positive control outside any file, at byte ${at}`);
      if (this.reported.has(i)) return;
      this.reported.add(i);
      ctx.found.push(`${this.what} (its gzip bytes) holds ${ctx.all[i].kind} at byte ${at}`);
    });
    this.next = new Detect(ctx, where, depth, true);
  }
  private fail(why: string, at: number): never { throw new Error(`${this.what} is a gzip that can't be read whole: ${why} (at byte ${at})`); }
  // the header, from the bytes held so far: its length once whole, or -1 while more is needed
  private parseHead(): number {
    const b = this.head;
    if (b.length < 10) return -1;
    if (b[2] !== 8) this.fail(`compression method ${b[2]}, not deflate`, 2);
    const flg = b[3];
    if (flg & 0xe0) this.fail("reserved header flags set", 3);
    let p = 10;
    if (flg & 0x04) { if (p + 2 > b.length) return -1; const xlen = b[p] | (b[p + 1] << 8); if (p + 2 + xlen > b.length) return -1; p += 2 + xlen; }
    for (const bit of [0x08, 0x10]) if (flg & bit) { const z = b.indexOf(0, p); if (z < 0) return -1; p = z + 1; }
    if (flg & 0x02) {
      if (p + 2 > b.length) return -1;
      const want = b[p] | (b[p + 1] << 8);
      if ((crc32(b.subarray(0, p)) & 0xffff) !== want) this.fail("its header CRC doesn't match", p);
      p += 2;
    }
    return p;
  }
  // why the header can't be finished, once the stream has ended inside it
  private headCut(): never {
    const b = this.head;
    if (b.length < 18) this.fail("no gzip header", 0);
    const flg = b[3]; let p = 10;
    if (flg & 0x04) { if (p + 2 > b.length) this.fail("its extra field is cut off", p); p += 2 + (b[p] | (b[p + 1] << 8)); if (p > b.length) this.fail("its extra field is cut off", p); }
    for (const bit of [0x08, 0x10]) if (flg & bit) { const z = b.indexOf(0, p); if (z < 0) this.fail(bit === 0x08 ? "its name field never ends" : "its comment field never ends", p); p = z + 1; }
    this.fail("its header CRC is cut off", p);
  }
  private startInflate() {
    this.inf = createInflateRaw({ chunkSize: 64 * 1024 });
    this.inf.on("data", (d: Uint8Array) => { this.q.push(d); });
    // the inflater's readable side ends once it has decoded the stream's final block and handed on every byte of output
    this.done = new Promise<void>((res, rej) => { this.inf.once("end", res); this.inf.on("error", (e: unknown) => { this.infErr ??= e; rej(e); }); });
    this.done.catch(() => {});
  }
  private decodeFail(e: unknown, at: number): never { this.fail(`its deflate stream doesn't decode (${String((e as Error)?.message ?? e).slice(0, 40)})`, at); }
  // the output so far, handed on: CRC32, length and the budget kept over it
  private async drain() {
    while (this.q.length) {
      const d = this.q.shift()!;
      this.ctx.expanded += d.length;
      if (this.ctx.expanded > this.ctx.maxExpanded)
        throw new Error(`${this.what} decodes past Keeper's budget of ${this.ctx.maxExpanded} bytes expanded in all (the expanded-bytes budget), at byte ${this.size + d.length} of its output`);
      this.crc = crc32(d, this.crc); this.size += d.length;
      await this.next.write(d);
    }
  }
  // one step of the inflater: the bytes it consumed of this piece
  private step(piece: Uint8Array): Promise<number> {
    const inf = this.inf, before = Number(inf.bytesWritten);
    return new Promise((res, rej) => {
      const onErr = (e: unknown) => rej(e);
      inf.once("error", onErr);
      inf.write(piece, (e: unknown) => { inf.off("error", onErr); if (e) rej(e); else res(Number(inf.bytesWritten) - before); });
    });
  }
  private async body(b: Uint8Array): Promise<Uint8Array> {
    for (let i = 0; i < b.length; i += INFLATE_IN) {
      const piece = b.subarray(i, Math.min(b.length, i + INFLATE_IN));
      let used: number;
      try { used = await this.step(piece); } catch (e) { this.decodeFail(e, this.bodyAt); }
      if (this.infErr) this.decodeFail(this.infErr, this.bodyAt);
      if (!Number.isSafeInteger(used) || used < 0 || used > piece.length) this.fail("the inflater doesn't say how much of the stream it read", this.bodyAt);
      await this.drain();
      if (used < piece.length) {
        // the deflate stream ended inside this piece: what follows is the trailer
        this.state = "trailer"; this.trAt = this.bodyAt + Number(this.inf.bytesWritten);
        await this.finish();
        return b.subarray(i + used);
      }
    }
    return new Uint8Array(0);
  }
  // the inflater's end: every output byte delivered, then the next layer told its stream is whole
  private async finish() {
    await this.done!.catch((e) => this.decodeFail(e, this.bodyAt));
    await this.drain();
  }
  private async afterBytes(b: Uint8Array, at: number) {
    for (let i = 0; i < b.length; i++) {
      const x = b[i];
      if (this.after === 0 && this.first < 0) {
        if (x === 0x1f) { this.first = at + i; continue; }
        if (x !== 0) throw new Error(`${this.what} holds data after its gzip stream (at byte ${at + i})`);
        this.after++;
        continue;
      }
      if (this.first >= 0) {
        if (x === 0x8b) throw new Error(`${this.what} holds a second gzip member after the first (at byte ${this.first}), which Keeper doesn't read`);
        throw new Error(`${this.what} holds data after its gzip stream (at byte ${this.first})`);
      }
      if (x !== 0) throw new Error(`${this.what} holds data after its gzip stream (at byte ${at + i})`);
    }
  }
  private async trailer(b: Uint8Array): Promise<Uint8Array> {
    const need = 8 - this.tr.length;
    this.tr = cat(this.tr, b.subarray(0, need));
    if (this.tr.length < 8) return new Uint8Array(0);
    const t = this.tr, at = this.trAt;
    const crc = (t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0;
    const isize = (t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24)) >>> 0;
    if (crc !== this.crc) this.fail("its trailer's CRC32 doesn't match what it decodes to", at);
    if (isize !== (this.size >>> 0)) this.fail("its trailer's length doesn't match what it decodes to", at + 4);
    this.endAt = at + 8;
    this.state = "after";
    await this.next.end();
    return b.subarray(need);
  }
  async write(b0: Uint8Array) {
    // every raw byte searched, in order, before it is read
    this.finder.push(b0, this.at);
    const start = this.at;
    this.at += b0.length;
    let b = b0, pos = start;
    if (this.state === "head") {
      const had = this.head.length;
      this.head = cat(this.head, b);
      const p = this.parseHead();
      if (p < 0) {
        if (this.head.length > MAX_RECORD) this.fail(`its header fields run past ${MAX_RECORD} bytes, more than Keeper reads (the record budget)`, 0);
        return;
      }
      this.state = "body"; this.bodyAt = p; this.startInflate();
      b = b.subarray(p - had); pos = p;
      this.head = new Uint8Array(0);
    }
    if (this.state === "body" && b.length) {
      const rest = await this.body(b);
      pos += b.length - rest.length; b = rest;
    }
    if (this.state === "trailer" && b.length) { const rest = await this.trailer(b); pos += b.length - rest.length; b = rest; }
    if (this.state === "after" && b.length) await this.afterBytes(b, pos);
  }
  async end() {
    if (this.at < 18) this.fail("no gzip header", 0);
    if (this.state === "head") this.headCut();
    if (this.state === "body") {
      // the stream ran out with the inflater still reading: it must have ended right at the last byte given, or it is cut off
      await new Promise<void>((res, rej) => { this.inf.once("error", rej); this.inf.end(() => res()); }).catch((e) => this.decodeFail(e, this.bodyAt));
      await this.finish();
      this.state = "trailer"; this.trAt = this.bodyAt + Number(this.inf.bytesWritten);
    }
    if (this.state === "trailer") this.fail("its 8-byte trailer is cut off", this.trAt);
    if (this.first >= 0) throw new Error(`${this.what} holds data after its gzip stream (at byte ${this.first})`);
  }
}

function result(ctx: Ctx, err: unknown): ScanResult {
  const base = { members: ctx.members, names: ctx.seen, found: ctx.found, control: ctx.control, expanded: ctx.expanded };
  if (err) return { ok: false, why: `the backup couldn't be read: ${String((err as Error)?.message ?? err).slice(0, 240)}`, ...base };
  if (!ctx.members) return { ok: false, why: "the backup holds no files Keeper could read", ...base };
  if (ctx.found.length) return { ok: false, why: `the backup holds key material: ${[...new Set(ctx.found)].slice(0, 5).join("; ")}`, ...base };
  if (ctx.ctl && ctx.control !== 1) return { ok: false, why: `the positive control was found ${ctx.control} times, not exactly once, in the files read (the scan didn't read the files the backup holds as it should)`, ...base };
  return { ok: true, why: "", ...base };
}
const ctxOf = (names: RegExp, needles: Needle[], opts: ScanOpts) => new Ctx(names, needles, opts, opts.maxExpanded ?? MAX_EXPANDED, opts.maxDepth ?? MAX_DEPTH);

// (0.1.17) The scan of a downloaded archive, read from its file by offsets a chunk at a time.
// names: a member whose path matches is a finding; needles: any found in a member's bytes (or its name) is a finding;
// opts.control: the positive control, which must be found exactly once in the files read, and nowhere else.
export async function scanFile(path: string, names: RegExp, needles: Needle[], opts: ScanOpts = {}, onChunk?: () => void): Promise<ScanResult> {
  const ctx = ctxOf(names, needles, opts);
  let err: unknown = null;
  const fh = await open(path, "r").catch((e) => { err = e; return null; });
  if (!fh) return result(ctx, new Error(`the archive's file couldn't be opened (${String((err as Error)?.message ?? err).slice(0, 60)})`));
  try {
    const root = new Detect(ctx, "", 0);
    for (let pos = 0; ;) {
      const buf = new Uint8Array(READ_CHUNK);
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, pos);
      if (!bytesRead) break;
      await root.write(buf.subarray(0, bytesRead));
      pos += bytesRead;
      onChunk?.();
    }
    await root.end();
  } catch (e) { err = e; } finally { await fh.close().catch(() => {}); }
  return result(ctx, err);
}
// The same scan over bytes already in memory (the tests' archives), streamed in chunks as a file's would be.
export async function scanBackup(bytes: Uint8Array, names: RegExp, needles: Needle[], opts: ScanOpts & { chunk?: number } = {}): Promise<ScanResult> {
  const ctx = ctxOf(names, needles, opts);
  let err: unknown = null;
  try {
    const root = new Detect(ctx, "", 0);
    const n = opts.chunk ?? READ_CHUNK;
    for (let i = 0; i < bytes.length; i += n) await root.write(bytes.subarray(i, i + n));
    await root.end();
  } catch (e) { err = e; }
  return result(ctx, err);
}
// One gzip member, decoded by the scan's own gzip layer (its header, its trailer, the zeros after it all checked): the tests' way
// in to the layer alone. Throws, naming the offset, on any failure.
export async function gzipMember(b: Uint8Array, what: string): Promise<Uint8Array> {
  const ctx = ctxOf(/$^/, [], {});
  const parts: Uint8Array[] = [];
  const g = new GzipLayer(ctx, what, 1);
  (g as any).next = { write: async (d: Uint8Array) => { parts.push(d.slice()); }, end: async () => {} };
  await g.write(b);
  await g.end();
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// (0.1.17) The child process side (main.ts scanChild): the job arrives on standard input as JSON (the archive's path, the names
// pattern, the needles and the control: never on the command line), the result goes to standard output as one JSON line with the
// peak resident memory seen (sampled, and the kernel's VmHWM where Linux gives it). Its own memory limit: the resident size is sampled as it runs, and over KEEPER_SCAN_RSS_MAX bytes
// the child exits at once with code 75 (the service reports the scan killed, out of memory), before the kernel has to.
export const OVER_LIMIT_EXIT = 75;
if (import.meta.main && process.argv[2] === "child") {
  const max = Number(process.env.KEEPER_SCAN_RSS_MAX ?? 0);
  let peak = 0;
  const rss = () => { const r = process.memoryUsage.rss(); if (r > peak) peak = r; if (max > 0 && r > max) { process.stderr.write(`over the scan's memory limit: ${r} bytes resident\n`); process.exit(OVER_LIMIT_EXIT); } };
  const timer = setInterval(rss, 20);
  try {
    const job = JSON.parse(await Bun.stdin.text());
    const names = new RegExp(String(job.names?.source ?? "$^"), String(job.names?.flags ?? ""));
    const r = await scanFile(String(job.path), names, Array.isArray(job.needles) ? job.needles : [], { control: job.control || undefined, maxExpanded: job.maxExpanded, maxDepth: job.maxDepth }, rss);
    rss();
    clearInterval(timer);
    // the kernel's own high-water mark of the resident size (Linux), so the peak reported isn't only what the samples caught
    try { const m = /VmHWM:\s+(\d+) kB/.exec(await Bun.file("/proc/self/status").text()); if (m) peak = Math.max(peak, Number(m[1]) * 1024); } catch { /* not Linux */ }
    process.stdout.write(`${JSON.stringify({ ...r, names: r.names.slice(0, 50), peakRss: peak })}\n`);
    process.exit(0);
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`${JSON.stringify({ ok: false, why: `the scan couldn't run: ${String((e as Error)?.message ?? e).slice(0, 120)}`, members: 0, names: [], found: [], control: 0, peakRss: peak })}\n`);
    process.exit(0);
  }
}
