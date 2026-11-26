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
// 0.1.17, the review's fix round (each kept fail-closed; nothing it looks for changed):
//   - the gzip member's end is the inflater's own end-of-stream signal (its "end" event, which zlib's stream raises only once
//     inflate has returned Z_STREAM_END and every output byte is handed on), with the inflater's consumed count read at that
//     moment for the trailer's offset, never a short count of one piece: a stream that ends on a piece's last byte, a trailer
//     split across pieces or writes, and bytes after the end (never given to the inflater once its end is seen) are all read
//     exactly; the trailer's CRC32 and ISIZE and the zero-tail rule stay;
//   - a tar layer searches its whole byte stream, member data included, with one contiguous Finder, so a value split between a
//     header (or padding) and a member's data is found by that layer; a hit wholly inside a member's data is left to the
//     member's own layer, which sees the same bytes at the same offset less the region's start (so nothing is reported twice);
//   - backpressure: the inflater is fed 4 KB at a time, paused after each output chunk until the next layer has taken it, so
//     it never runs ahead of the layers below; the expanded-bytes budget is charged as each chunk arrives, before it is held
//     or handed on, and the child's resident size is checked per output chunk as well as on its timer;
//   - every budget failure names its phase, its limit, what was seen and what to do (budgetWhy).
// 0.1.17, the last fix round (each kept fail-closed; nothing it looks for changed):
//   - a hit wholly inside a member's data is left to the member's own layer only when a layer was made for that member and it
//     completed; every other range is reported by the tar layer itself (GNU long-name and long-link data, pax extended and global
//     headers, a member whose layer failed), and the tar layer's own hits (straddles included) are counted apart from the member's,
//     so a member-internal match never hides an overlapping straddle;
//   - the inflater's end clock runs only while the scan waits on the inflater, never while it is paused for the layers below;
//   - the child's oom_score_adj ask is never fatal: a refusal is said as a note on standard error, which the service logs.
// The memory bound the design gives (MEMORY_BOUND, pinned in the tests under the 256 MB cap at the deepest nesting): each gzip layer
// is fed INFLATE_IN (4 KB) at a time, which deflate expands at most DEFLATE_MAX_RATIO (about 1032) times, so one piece's output is
// at most about 4 MB; with backpressure a layer holds at most that much in the inflater and its output queue, and MAX_DEPTH (6)
// layers deep that is about 25 MB in all. To it add each layer's own buffering (a record held to MAX_RECORD, 1 MB; a tar header;
// the search's carry, under a needle's length; an output chunk or two of 64 KB) times MAX_DEPTH, and the outer read's chunk
// (256 KB): about 33 MB on top of the runtime's own (Bun with --smol, about 30 to 50 MB). The child's resident-size limit
// (KEEPER_SCAN_RSS_MAX) is a sampled check, not a hard one: the kernel is the hard limit until a cgroup limit lands (DOCS).
// 0.1.18: the App's own image. A backup of a locally built App holds its container image (`./image.tar` in the App's archive,
// written by `docker save`): the image as built from the App's public source, before any key exists. A container's writes never
// reach it (they live in the container's layer, and /data is a volume), so no key value, fingerprint, sentinel or control can be
// in it. Base images ship files in formats Keeper can't open (Debian's apt logs are xz), and 0.1.17 failed the check on the
// first one. Inside the image only, such a file (a format Keeper can't open, a name that says archive with bytes that are
// neither gzip nor tar, or a layer past the nesting budget) is searched as raw bytes and counted as not opened, never failed.
// Everywhere else nothing changed: the App's data, its options (addon.json) and the outer archive still fail closed.
// SCAN_VERSION names this coverage: a pass recorded by an earlier scan no longer counts (core.ts checkPassed).
// It runs in a child process of the service (main.ts scanChild runs this file as `bun --smol scan.ts child`), so if the kernel
// still kills it the service lives on and reports it; core.ts and the tests call scanFile or scanBackup in process.
import { createInflateRaw, crc32 as zcrc32 } from "node:zlib";
import { open } from "node:fs/promises";
import { writeFileSync } from "node:fs";

export const SCAN_VERSION = 4;
// (0.1.16) the shortest value searched for in an archive's bytes: shorter ones (an 8 or 12 hex digit fingerprint) are left out
export const MIN_NEEDLE = 16;
// (0.1.17) the budgets: bytes decoded by every gzip layer together, the deepest nesting, and the largest record held to be read
export const MAX_EXPANDED = 4 * 1024 ** 3;
export const MAX_DEPTH = 6;
export const MAX_RECORD = 1024 * 1024;
const READ_CHUNK = 256 * 1024;        // the outer file, read a chunk at a time
// (0.1.17, fix round) the inflater fed this much at a time (at most about 4 MB of output per piece at deflate's 1032:1, handed on
// 64 KB at a time with the inflater paused between), and its output chunk
export const INFLATE_IN = 4 * 1024;
export const OUT_CHUNK = 64 * 1024;
export const DEFLATE_MAX_RATIO = 1032;
// (last round) the bound above, in bytes: the deepest nesting's inflaters plus every layer's own buffering plus the outer read
export const MEMORY_BOUND = INFLATE_IN * DEFLATE_MAX_RATIO * MAX_DEPTH + MAX_DEPTH * (MAX_RECORD + 512 + 2 * OUT_CHUNK) + READ_CHUNK;
// the inflater's end signal, once due, must come within this. (last round) The clock runs only while the scan waits on the inflater
// itself, never while the inflater is paused for the layers below: it starts afresh after every output chunk has been taken and
// the inflater resumed, so a slow nested layer (ARM) can't trip it however long its pauses add up to.
export const END_DUE_MS = 10_000;

export interface ScanResult { ok: boolean; why: string; members: number; names: string[]; found: string[]; control: number; expanded?: number; unopened?: number }
// (0.1.17) the downloaded archive the scan reads: its file's path, its size in bytes, and its removal
export interface ArchiveFile { path: string; size: number; remove: () => void }
// tick: (0.1.17, fix round) called for every chunk read and every chunk the inflater puts out (the child checks its resident size there)
// endDueMs: (last round) END_DUE_MS, smaller in the tests
export interface ScanOpts { control?: string; maxExpanded?: number; maxDepth?: number; tick?: () => void; endDueMs?: number }
// (0.1.17, fix round) a budget's failure, in the same words everywhere: the budget, its phase, its limit, what was seen, what to do
export function budgetWhy(o: { budget: string; phase: string; limit: string; seen: string; todo: string }): string {
  return `(${o.budget}, in the ${o.phase} phase: limit ${o.limit}, seen ${o.seen}; what to do: ${o.todo})`;
}
const BUDGET_TODO = "nothing on the device raises it: this build's limits are fixed, so read Keeper's log for the backup's size and report it; a larger backup needs a new Keeper release";
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
// (0.1.18) inside the App's own container image: the App archive's top-level image.tar (the outer tar's "<slug>.tar.gz" member,
// then its "./image.tar" member), and anything below it
const IN_IMAGE = /^(\.\/)?[^:/]+\.tar\.gz:(\.\/)?image\.tar:/;
export const inImage = (where: string) => IN_IMAGE.test(where);
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
// (0.1.17) The needle search over a stream: every occurrence of each pattern reported by its absolute offset, in order, including
// one split across two chunks (the last longest-needle-minus-one bytes are carried into the next push and searched with its start).
// Every push must follow on from the last (fix round: no layer leaves bytes out any more, so a gap fails closed rather than
// dropping the carry). One pattern may be counted without overlaps (the control in a leaf): the end of its last counted match is
// kept across pushes, so a match that crosses a seam is counted once, never twice, and never missed.
class Finder {
  private carry = new Uint8Array(0);
  private carryAt = 0;
  private next = 0;                      // the offset the next push must start at
  private readonly keep: number;
  private lastEnd = -1;                  // the end of the last counted match of the non-overlapping pattern
  constructor(private readonly pats: Pat[], private readonly hit: (i: number, at: number) => void, private readonly nonOverlap = -1) {
    this.keep = Math.max(1, ...pats.map((p) => p.b.length)) - 1;
  }
  private report(p: number, at: number) {
    if (p === this.nonOverlap) { if (at < this.lastEnd) return; this.lastEnd = at + this.pats[p].b.length; }
    this.hit(p, at);
  }
  push(chunk: Uint8Array, at: number) {
    if (!chunk.length || !this.pats.length) return;
    if (at !== this.next) throw new Error(`the scan's search lost its place (bytes at ${at}, expected ${this.next}), so it stops rather than miss a value`);
    this.next = at + chunk.length;
    const C = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    for (let p = 0; p < this.pats.length; p++) {
      const n = this.pats[p].b;
      if (this.carry.length) {
        // the seam: the carry and the first bytes of this chunk, searched for occurrences that start in the carry
        const seam = Buffer.from(cat(this.carry, chunk.subarray(0, this.keep)));
        let i = seam.indexOf(n);
        // only an occurrence that runs into this chunk: one wholly inside the carry was reported by the push that brought it
        while (i >= 0 && i < this.carry.length) { if (i + n.length > this.carry.length) this.report(p, this.carryAt + i); i = seam.indexOf(n, i + 1); }
      }
      let i = C.indexOf(n);
      while (i >= 0) { this.report(p, at + i); i = C.indexOf(n, i + 1); }
    }
    // the next carry: the last `keep` bytes seen, copied (the chunk itself is never held)
    if (chunk.length >= this.keep) { this.carry = chunk.slice(chunk.length - this.keep); this.carryAt = at + chunk.length - this.keep; }
    else { const all = cat(this.carry, chunk); this.carry = all.slice(Math.max(0, all.length - this.keep)); this.carryAt = at + chunk.length - this.carry.length; }
  }
}

// What every layer of one scan shares: the patterns, the findings, the counts and the budgets.
class Ctx {
  found: string[] = []; seen: string[] = [];
  members = 0; control = 0; expanded = 0; unopened = 0;
  readonly pats: Pat[]; readonly ctl: Uint8Array | null; readonly all: Pat[]; readonly tick: () => void; readonly endDueMs: number;
  constructor(readonly names: RegExp, needles: Needle[], opts: ScanOpts, readonly maxExpanded: number, readonly maxDepth: number) {
    this.tick = opts.tick ?? (() => {});
    this.endDueMs = opts.endDueMs ?? END_DUE_MS;
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
  // (0.1.18) past the nesting budget inside the App's image: read as a leaf, not opened
  private readonly tooDeep: boolean;
  constructor(private readonly ctx: Ctx, private readonly where: string, private readonly depth: number, private readonly afterGzip = false) {
    this.tooDeep = depth > ctx.maxDepth && inImage(where);
    if (depth > ctx.maxDepth && !this.tooDeep) throw new Error(`the archive nests too deep: ${where || "the archive"} is more than ${ctx.maxDepth} layers in (at byte 0) ${budgetWhy({ budget: "the nesting budget", phase: "scan", limit: `${ctx.maxDepth} layers`, seen: `${depth} layers`, todo: BUDGET_TODO })}`);
  }
  private choose(): Sink {
    const b = this.head, what = this.where || "the archive";
    // (0.1.18) a file in the App's image Keeper doesn't open: its raw bytes are searched as a leaf, and it is counted
    const unopened = () => { this.ctx.unopened++; return new Leaf(this.ctx, this.where); };
    if (this.tooDeep) return unopened();
    if (!this.afterGzip && isGzip(b)) return new GzipLayer(this.ctx, this.where, this.depth);
    const m = magic(b);
    if (m && inImage(this.where)) return unopened();
    if (m) throw new Error(`${what} is ${m}-compressed, which Keeper can't read (at byte 0)`);
    if (isTar(b)) return new TarLayer(this.ctx, this.where, this.depth);
    if (this.depth > 0 && ARCHIVE_NAME.test(this.where.split(":").pop() ?? "")) { if (inImage(this.where)) return unopened(); throw new Error(`${what} is named as an archive but is neither gzip nor tar (encrypted or unknown) (at byte 0)`); }
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
  private at = 0; private json: Uint8Array[] | null = null; private jsonLen = 0;
  private readonly finder: Finder; private readonly reported = new Set<number>();
  constructor(private readonly ctx: Ctx, private readonly where: string) {
    const ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    // the control counted without overlaps, its last match's end carried across pushes by the Finder
    this.finder = new Finder(ctx.all, (i, at) => {
      if (i === ctl) { ctx.control++; return; }
      if (this.reported.has(i)) return;
      this.reported.add(i);
      ctx.found.push(`${where} holds ${ctx.all[i].kind} at byte ${at}`);
    }, ctl);
    if (/(^|\/)backup\.json$/.test(where.split(":").pop() ?? "")) this.json = [];
  }
  async write(b: Uint8Array) {
    this.finder.push(b, this.at);
    this.at += b.length;
    if (this.json) {
      this.jsonLen += b.length;
      if (this.jsonLen > MAX_RECORD) throw new Error(`${this.where} is larger than ${MAX_RECORD} bytes, more than Keeper reads of a backup.json (at byte ${MAX_RECORD}) ${budgetWhy({ budget: "the record budget", phase: "scan", limit: `${MAX_RECORD} bytes`, seen: `more than ${this.jsonLen - b.length} bytes`, todo: BUDGET_TODO })}`);
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

// (0.1.17) A tar layer, parsed as it streams. Fix round: its whole byte stream (each header, each pax or long-name record, each
// member's data, each member's padding, the end-of-archive block and everything after it) goes through one contiguous Finder, so
// a value split across any structural edge (a header's end into a member's data, data into padding, padding into the next
// header) is found here. A hit wholly inside a member's data is that member's own layer's to report (it searches the same bytes,
// at this offset less the region's start), so it is left to it and never reported twice; any other hit is this layer's. A
// control copy anywhere but wholly inside a member's data fails the check at once; a key value or fingerprint is a finding.
class TarLayer implements Sink {
  private at = 0;                         // the layer's offset of the next byte
  private state: "head" | "data" | "pad" | "tail" = "head";
  private h = new Uint8Array(512); private hn = 0; private hAt = 0;
  private longName = "";
  private left = 0; private pad = 0;      // data bytes and padding bytes still to come for the current member
  private child: Sink | null = null;      // the current member's layer (a file's data), or null
  private rec: Uint8Array[] | null = null; private recLen = 0; private recType = "";
  private region: [number, number] = [0, 0];   // the current member's data region [start, end), searched here and by its layer
  private last: [number, number, string] = [0, 0, ""];   // the member before it: its region and name, for a hit that crosses its end
  private name = "";
  // (last round) the hits wholly inside the current member's data, by pattern (the first of each): left to the member's layer only
  // once that layer has completed (its end() returned); a member whose layer fails reports them here first
  private inside = new Map<number, number>();
  private readonly finder: Finder; private readonly reported = new Set<number>();
  private readonly what: string;
  constructor(private readonly ctx: Ctx, private readonly where: string, private readonly depth: number) {
    this.what = where || "the archive";
    const ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    this.finder = new Finder(ctx.all, (i, at) => {
      const n = ctx.all[i].b.length, [s, e] = this.region;
      // wholly inside the data of a member that has a layer of its own: held until that layer completes (memberEnd)
      if (this.child && e > s && at >= s && at + n <= e) { if (!this.inside.has(i)) this.inside.set(i, at); return; }
      this.own(i, at);
    });
  }
  // a hit that is this layer's own: in a header, a record (pax, long name, long link), padding, the tail, across any of their edges,
  // or in a member no layer completed. Counted apart from every member-internal match, so none of those ever hides it.
  private own(i: number, at: number) {
    const ctx = this.ctx, ctl = ctx.ctl ? ctx.all.length - 1 : -1;
    {
      const n = ctx.all[i].b.length, [s, e] = this.region;
      const edge = (rs: number, re: number, nm: string) => (re > rs && ((at < rs && at + n > rs) || (at < re && at + n > re)) ? `, across the edge of ${nm}'s data` : "");
      const across = edge(s, e, this.name) || edge(this.last[0], this.last[1], this.last[2]);
      if (i === ctl) throw new Error(`${this.what} (its tar headers, padding or tail) holds the positive control outside any file, at byte ${at}${across}`);
      if (this.reported.has(i)) return;
      this.reported.add(i);
      ctx.found.push(`${this.what} (its tar headers, padding or tail) holds ${ctx.all[i].kind} at byte ${at}${across}`);
    }
  }
  private fail(why: string): never { throw new Error(`${this.what}, read as a tar: ${why}`); }
  // a member's layer that didn't complete: the hits held for it are this layer's, reported before its failure goes on
  private childFailed(e: unknown): never {
    this.child = null;
    for (const [i, at] of this.inside) { try { this.own(i, at); } catch { /* the failure below is the scan's */ } }
    this.inside.clear();
    throw e;
  }
  // every byte of the layer, searched in order
  private search(b: Uint8Array) { this.finder.push(b, this.at); this.at += b.length; }
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
    this.child = null; this.rec = null; this.inside.clear();
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      // a long-name, long-link or pax record: read by Keeper (held, to MAX_RECORD), and its bytes are the layer's own (no child
      // reads them, so every hit in them is reported here). (last round) GNU long-link data (K) too, which 0.1.17 refused as data
      if (size > MAX_RECORD) this.fail(`a ${type === "L" ? "long-name" : type === "K" ? "long-link" : "pax"} record of ${size} bytes at byte ${off}, more than Keeper reads ${budgetWhy({ budget: "the record budget", phase: "scan", limit: `${MAX_RECORD} bytes`, seen: `${size} bytes`, todo: BUDGET_TODO })}`);
      this.rec = []; this.recLen = 0; this.recType = type;
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
    if (this.child) {
      const c = this.child;
      // the member's layer completes, or every hit held for it is reported here before its failure goes on
      try { await c.end(); } catch (e) { this.childFailed(e); }
      this.inside.clear();
    }
    if (this.rec) {
      const all = new Uint8Array(this.recLen); let o = 0; for (const p of this.rec) { all.set(p, o); o += p.length; }
      this.rec = null;
      if (this.recType === "L") this.longName = dec.decode(all).replace(/\0+$/, "");
      else { const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(all)); if (m && this.recType === "x") this.longName = m[1]; }
    }
    this.last = [this.region[0], this.region[1], this.name];
    this.region = [0, 0]; this.child = null;
    this.state = this.pad ? "pad" : "head";
  }
  async write(b: Uint8Array) {
    let i = 0;
    while (i < b.length) {
      if (this.state === "head") {
        const n = Math.min(512 - this.hn, b.length - i);
        if (this.hn === 0) this.hAt = this.at;
        this.h.set(b.subarray(i, i + n), this.hn); this.hn += n;
        this.search(b.subarray(i, i + n)); i += n;
        if (this.hn === 512) { this.hn = 0; await this.header(); }
      } else if (this.state === "data") {
        const n = Math.min(this.left, b.length - i);
        const part = b.subarray(i, i + n);
        // searched here first (an occurrence crossing the region's edges is this layer's), then handed to the member's layer
        this.search(part);
        if (this.rec) { this.rec.push(part.slice()); this.recLen += n; }
        else if (this.child) { try { await this.child.write(part); } catch (e) { this.childFailed(e); } }
        i += n; this.left -= n;
        if (!this.left) await this.memberEnd();
      } else if (this.state === "pad") {
        const n = Math.min(this.pad, b.length - i);
        this.search(b.subarray(i, i + n)); i += n; this.pad -= n;
        if (!this.pad) this.state = "head";
      } else {
        // (0.1.16) nothing but zeros after the end-of-archive block: a second archive appended there is never read as members
        const part = b.subarray(i);
        this.search(part);
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
// The member's end (fix round): the inflater's own end-of-stream signal. zlib's inflate returns Z_STREAM_END at the end of the
// deflate stream's final block and nowhere else; the stream wrapper then ends its readable side, once every output byte is
// handed on, and raises "end". At that moment its count of bytes consumed (bytesWritten) is exactly the deflate stream's length,
// the byte holding its last bit included: the trailer starts there. Two cases reach that signal:
//   - the stream ends inside a piece: inflate stops with input left over, and the wrapper ends at once;
//   - the stream ends on a piece's last byte: inflate has returned Z_STREAM_END with no input left, which the wrapper doesn't
//     pass on; the next piece fed (whatever bytes follow) is then consumed not at all (inflate stays in its done state and reads
//     nothing more) and the wrapper ends, its count unchanged, so the trailer starts at that piece's first byte.
// Nothing is fed once the end is seen: the bytes after it go to the trailer and the zero-tail check. The count is not trusted
// alone: it must fall within the bytes given, and at that position the trailer must carry the CRC32 and the length (mod 2^32)
// of every byte decoded (had the end been misplaced, the 8 bytes there would be deflate data or something else, and matching
// both by chance has odds below one in 2^32). The scan's tests place the end at every offset of a piece, on its boundary and
// either side of it, and split the trailer every way, with the deflate stream's length known.
// Backpressure: the inflater is paused after each output chunk and resumed only once the next layer has taken every chunk
// held, so it never runs ahead of the layers below (deflate expands up to about 1032:1; nested gzip layers each hold at most a
// chunk or two). The expanded-bytes budget is charged as each chunk arrives, before it is held or handed on.
class GzipLayer implements Sink {
  private at = 0;                          // the layer's offset of the next raw byte
  private state: "head" | "body" | "trailer" | "after" = "head";
  private head = new Uint8Array(0); private bodyAt = 0;
  private inf: any = null;
  private q: Uint8Array[] = [];            // output chunks charged and held, not yet handed on (one or two: the inflater pauses)
  private fed = 0;                         // raw bytes handed to the inflater
  private ended = false; private consumed = -1;
  private infErr: unknown = null; private stop: unknown = null;
  private dirty = false; private kick: (() => void) | null = null;
  private crc = 0; private size = 0;       // over the output
  private tr = new Uint8Array(0); private trAt = 0;
  private pend = -1;                       // after the trailer: the offset of a 0x1f that may start a second member
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
  private fail(why: string, at: number): never { this.close(); throw new Error(`${this.what} is a gzip that can't be read whole: ${why} (at byte ${at})`); }
  private close() { const inf = this.inf; if (inf) { try { inf.destroy(); } catch { /* gone */ } } }
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
  // the inflater's events only record what happened and wake the reader (wait): nothing is thrown from inside them
  private wake() { this.dirty = true; const k = this.kick; this.kick = null; k?.(); }
  private wait(): Promise<void> {
    if (this.dirty) { this.dirty = false; return Promise.resolve(); }
    return new Promise((res) => { this.kick = () => { this.dirty = false; res(); }; });
  }
  private startInflate() {
    const inf = createInflateRaw({ chunkSize: OUT_CHUNK });
    this.inf = inf;
    inf.on("data", (d: Uint8Array) => {
      if (this.stop) return;
      // charged as it arrives, before it is held or handed on
      const ctx = this.ctx;
      ctx.expanded += d.length;
      if (ctx.expanded > ctx.maxExpanded) {
        this.stop = new Error(`${this.what} decodes past Keeper's budget of ${ctx.maxExpanded} bytes expanded in all (the expanded-bytes budget), at byte ${this.size + d.length} of its output ${budgetWhy({ budget: "the expanded-bytes budget", phase: "scan", limit: `${ctx.maxExpanded} bytes decoded in all`, seen: `${ctx.expanded} bytes decoded`, todo: BUDGET_TODO })}`);
        this.close(); this.wake(); return;
      }
      try { ctx.tick(); } catch (e) { this.stop = e; this.close(); this.wake(); return; }
      this.q.push(d);
      inf.pause();
      this.wake();
    });
    inf.on("end", () => { this.ended = true; this.consumed = Number(inf.bytesWritten); this.wake(); });
    inf.on("error", (e: unknown) => { if (!this.ended) this.infErr ??= e; this.wake(); });
  }
  private decodeFail(e: unknown, at: number): never { this.fail(`its deflate stream doesn't decode (${String((e as Error)?.message ?? e).slice(0, 40)})`, at); }
  private check() {
    if (this.stop) { this.close(); throw this.stop; }
    if (this.infErr) this.decodeFail(this.infErr, this.bodyAt);
  }
  // every chunk held, handed on in order (CRC32 and length kept over it), each taken by the next layer before the inflater resumes
  private async pump() {
    while (this.q.length) {
      const d = this.q.shift()!;
      this.crc = crc32(d, this.crc); this.size += d.length;
      await this.next.write(d);
      if (this.stop) return;
    }
    if (!this.ended && !this.stop && this.inf.isPaused()) this.inf.resume();
  }
  // the inflater driven until `done` says so, its output handed on as it comes; stops at its end, a decode error or a budget.
  // within: a bound on waiting with nothing happening (used only once the end is due), past which it fails closed by name
  private async drive(done: () => boolean, within = 0) {
    for (;;) {
      await this.pump();
      this.check();
      if (!this.q.length && (this.ended || (done() && !this.inf.readableLength))) return;
      // the end's clock only while the inflater runs: never while it is paused for the layers below (pump resumes it once they
      // have taken every chunk, so after pump it is flowing; a new clock starts on every output chunk)
      if (!within || this.inf.isPaused()) { await this.wait(); continue; }
      let t: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([this.wait().then(() => false), new Promise<boolean>((res) => { t = setTimeout(() => res(true), within); })]);
      clearTimeout(t);
      if (late) this.fail(`the inflater left part of what it was given unread but never signalled its stream's end within ${within} ms`, this.bodyAt);
    }
  }
  // one piece into the inflater: done once it has taken the piece (every output byte of it handed on), or once it has ended. A
  // piece it took only in part means its stream ended inside it: its end signal must follow (it comes once the inflater's
  // readable side, resumed, has nothing left), and the count is read then, not now.
  private async feed(piece: Uint8Array) {
    let written = false;
    this.fed += piece.length;
    this.inf.write(piece, (e: unknown) => { written = true; if (e && !this.ended) this.infErr ??= e; this.wake(); });
    await this.drive(() => written);
    if (!this.ended && Number(this.inf.bytesWritten) < this.fed) await this.drive(() => false, this.ctx.endDueMs);
  }
  // the inflater has ended: its count says where the trailer starts, which must lie within what it was given and within this write
  private atEnd(pos: number, len: number): number {
    const c = this.consumed, end = this.bodyAt + c;
    if (!Number.isSafeInteger(c) || c < 0 || c > this.fed || end < pos || end > pos + len) this.fail(`the inflater's count of what it read (${c} of ${this.fed} bytes given) doesn't fit the stream`, this.bodyAt);
    this.close();
    this.state = "trailer"; this.trAt = end;
    return end - pos;
  }
  // the body bytes of one write, fed a piece at a time until the inflater ends: the bytes of it the deflate stream used
  private async body(b: Uint8Array, pos: number): Promise<number> {
    for (let i = 0; i < b.length; i += INFLATE_IN) {
      await this.feed(b.subarray(i, Math.min(b.length, i + INFLATE_IN)));
      if (this.ended) return this.atEnd(pos, b.length);
    }
    return b.length;
  }
  private afterBytes(b: Uint8Array, at: number) {
    for (let i = 0; i < b.length; i++) {
      const x = b[i];
      if (this.pend >= 0) {
        if (x === 0x8b) throw new Error(`${this.what} holds a second gzip member after the first (at byte ${this.pend}), which Keeper doesn't read`);
        throw new Error(`${this.what} holds data after its gzip stream (at byte ${this.pend})`);
      }
      if (x === 0) continue;
      if (x === 0x1f) { this.pend = at + i; continue; }
      throw new Error(`${this.what} holds data after its gzip stream (at byte ${at + i})`);
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
        if (this.head.length > MAX_RECORD) this.fail(`its header fields run past ${MAX_RECORD} bytes, more than Keeper reads ${budgetWhy({ budget: "the record budget", phase: "scan", limit: `${MAX_RECORD} bytes`, seen: `${this.head.length} bytes`, todo: BUDGET_TODO })}`, 0);
        return;
      }
      this.state = "body"; this.bodyAt = p; this.startInflate();
      b = b.subarray(p - had); pos = p;
      this.head = new Uint8Array(0);
    }
    if (this.state === "body" && b.length) { const used = await this.body(b, pos); b = b.subarray(used); pos += used; }
    if (this.state === "trailer" && b.length) { const rest = await this.trailer(b); pos += b.length - rest.length; b = rest; }
    if (this.state === "after" && b.length) this.afterBytes(b, pos);
  }
  async end() {
    if (this.at < 18) this.fail("no gzip header", 0);
    if (this.state === "head") this.headCut();
    if (this.state === "body") {
      // no more input, and the inflater told so: it ends only if its stream ended right at the last byte given, else it fails
      // (the stream is cut off)
      this.inf.end();
      await this.drive(() => false);
      if (this.consumed !== this.fed) this.fail(`the inflater's count of what it read (${this.consumed} of ${this.fed} bytes given) doesn't fit the stream`, this.bodyAt);
      this.close();
      this.state = "trailer"; this.trAt = this.bodyAt + this.consumed;
    }
    if (this.state === "trailer") this.fail("its 8-byte trailer is cut off", this.trAt);
    if (this.pend >= 0) throw new Error(`${this.what} holds data after its gzip stream (at byte ${this.pend})`);
  }
}

function result(ctx: Ctx, err: unknown): ScanResult {
  const base = { members: ctx.members, names: ctx.seen, found: ctx.found, control: ctx.control, expanded: ctx.expanded, unopened: ctx.unopened };
  if (err) return { ok: false, why: `the backup couldn't be read: ${String((err as Error)?.message ?? err).slice(0, 600)}`, ...base };
  if (!ctx.members) return { ok: false, why: "the backup holds no files Keeper could read", ...base };
  if (ctx.found.length) return { ok: false, why: `the backup holds key material: ${[...new Set(ctx.found)].slice(0, 5).join("; ")}`, ...base };
  if (ctx.ctl && ctx.control !== 1) return { ok: false, why: `the positive control was found ${ctx.control} times, not exactly once, in the files read (the scan didn't read the files the backup holds as it should)`, ...base };
  return { ok: true, why: "", ...base };
}
const ctxOf = (names: RegExp, needles: Needle[], opts: ScanOpts) => new Ctx(names, needles, opts, opts.maxExpanded ?? MAX_EXPANDED, opts.maxDepth ?? MAX_DEPTH);

// (0.1.17) The scan of a downloaded archive, read from its file by offsets a chunk at a time.
// names: a member whose path matches is a finding; needles: any found in a member's bytes (or its name) is a finding;
// opts.control: the positive control, which must be found exactly once in the files read, and nowhere else.
export async function scanFile(path: string, names: RegExp, needles: Needle[], opts: ScanOpts = {}): Promise<ScanResult> {
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
      ctx.tick();
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
// (0.1.17, fix round) chunk: the member written to the layer this many bytes at a time (or at these cuts); the answer's ended says
// the next layer was told its stream is whole (at the trailer) exactly once.
// (last round) slowMs: each chunk the next layer takes held this long first (a slow nested layer); endDueMs: the end's clock
export async function gzipMember(b: Uint8Array, what: string, o: { chunk?: number; cuts?: number[]; maxExpanded?: number; slowMs?: number; endDueMs?: number } = {}): Promise<Uint8Array> {
  const ctx = ctxOf(/$^/, [], { maxExpanded: o.maxExpanded, endDueMs: o.endDueMs });
  const parts: Uint8Array[] = [];
  let ends = 0;
  const g = new GzipLayer(ctx, what, 1);
  (g as any).next = { write: async (d: Uint8Array) => { if (ends) throw new Error("output after the end"); if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs)); parts.push(d.slice()); }, end: async () => { ends++; } };
  const cuts = o.cuts ?? [];
  if (cuts.length) { let p = 0; for (const c of [...cuts, b.length]) { if (c > p) await g.write(b.subarray(p, c)); p = Math.max(p, c); } }
  else { const n = o.chunk ?? b.length; for (let i = 0; i < b.length; i += n) await g.write(b.subarray(i, i + n)); }
  await g.end();
  if (ends !== 1) throw new Error(`the next layer was told its end ${ends} times`);
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let w = 0; for (const p of parts) { out.set(p, w); w += p.length; }
  return out;
}

// (0.1.17) The child process side (main.ts scanChild): the job arrives on standard input as JSON (the archive's path, the names
// pattern, the needles and the control: never on the command line), the result goes to standard output as one JSON line with the
// peak resident memory seen (sampled, and the kernel's VmHWM where Linux gives it). Its own memory limit: the resident size is
// sampled as it runs, and over KEEPER_SCAN_RSS_MAX bytes the child exits at once with code 75 (the service reports the scan killed,
// out of memory), before the kernel has to.
// Fix round: the resident size is checked for every chunk read and every chunk the inflater puts out, as well as every 20 ms; each
// change of a megabyte or more is reported on standard error ("rss <bytes>"), so if the child is killed anyway the service knows
// its last sample (main.ts names a kill "likely out of memory" only near the limit). It asks the kernel's out-of-memory killer to
// prefer it over the service (1000 in /proc/self/oom_score_adj, which needs no privilege; a failure is ignored). The job is the
// first line on standard input, which the service then holds open for as long as it waits: its end, or a change of parent
// process, means the service is gone, and the child exits (76) rather than run on as an orphan.
// (last round) the ask to the out-of-memory killer: never fatal. A read-only /proc, a seccomp refusal or no Linux at all answers why
// (the child says it on standard error as a note, which the service logs), and the scan goes on under its own memory limit.
export function preferOomKill(path = "/proc/self/oom_score_adj", write: (p: string, v: string) => void = (p, v) => writeFileSync(p, v)): string {
  try { write(path, "1000"); return ""; }
  catch (e) { return `oom_score_adj not set (${String((e as any)?.code ?? (e as Error)?.message ?? e).slice(0, 60)}): the scan's own memory limit still holds`; }
}
export const OVER_LIMIT_EXIT = 75;
export const PARENT_GONE_EXIT = 76;
if (import.meta.main && process.argv[2] === "child") {
  const { readFileSync, writeSync } = await import("node:fs");
  const oomWhy = preferOomKill();
  let oomScoreAdj: number | null = null;
  try { oomScoreAdj = Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()); } catch { oomScoreAdj = null; }
  const max = Number(process.env.KEEPER_SCAN_RSS_MAX ?? 0);
  const ppid = process.ppid;
  let peak = 0, told = 0;
  // standard error and output written synchronously, so a line written just before an exit is never lost
  const say = (fd: number, l: string) => { try { const b = Buffer.from(`${l}\n`); for (let o = 0; o < b.length;) o += writeSync(fd, b, o, b.length - o); } catch { /* the service is gone */ } };
  const rss = () => {
    const r = process.memoryUsage.rss();
    if (r > peak) peak = r;
    if (Math.abs(r - told) >= 1024 * 1024) { told = r; say(2, `rss ${r}`); }
    if (max > 0 && r > max) { say(2, `rss ${r}`); say(2, `over the scan's memory limit: ${r} bytes resident`); process.exit(OVER_LIMIT_EXIT); }
  };
  if (oomWhy) say(2, `note ${oomWhy}`);
  const timer = setInterval(() => { rss(); if (process.ppid !== ppid) process.exit(PARENT_GONE_EXIT); }, 20);
  const answer = (r: object) => { clearInterval(timer); say(1, JSON.stringify(r)); process.exit(0); };
  try {
    // the job's line; then standard input watched to its end, which only the service's going (or its letting go) brings
    const reader = (Bun.stdin.stream() as ReadableStream<Uint8Array>).getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) process.exit(PARENT_GONE_EXIT);
      text += Buffer.from(value).toString("utf8");
      if (text.includes("\n")) break;
      if (text.length > 64 * 1024 * 1024) throw new Error("the job's line is too long");
    }
    const job = JSON.parse(text.slice(0, text.indexOf("\n")));
    void (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* closed */ } process.exit(PARENT_GONE_EXIT); })();
    const names = new RegExp(String(job.names?.source ?? "$^"), String(job.names?.flags ?? ""));
    const r = await scanFile(String(job.path), names, Array.isArray(job.needles) ? job.needles : [], { control: job.control || undefined, maxExpanded: job.maxExpanded, maxDepth: job.maxDepth, tick: rss });
    rss();
    // the kernel's own high-water mark of the resident size (Linux), so the peak reported isn't only what the samples caught
    try { const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8")); if (m) peak = Math.max(peak, Number(m[1]) * 1024); } catch { /* not Linux */ }
    answer({ ...r, names: r.names.slice(0, 50), found: r.found.slice(0, 50), peakRss: peak, oomScoreAdj });
  } catch (e) {
    answer({ ok: false, why: `the scan couldn't run: ${String((e as Error)?.message ?? e).slice(0, 120)}`, members: 0, names: [], found: [], control: 0, peakRss: peak, oomScoreAdj });
  }
}
