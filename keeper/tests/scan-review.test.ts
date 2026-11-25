// Keeper 0.1.17, the review's fix round (pull request 58): one test group per item.
//   1. the gzip member's end comes from the inflater's own end signal: the stream's end at every offset of a 4 KB piece, on its
//      boundary and either side, the trailer split every way, truncations, and what may follow the trailer;
//   2. a value straddling a tar header, a member's data and its padding is found by one layer, at every chunking;
//   3. backpressure: a 2 GB all-zero image and a doubly nested all-zero gzip scanned under the 256 MB cap, and the
//      expanded-bytes budget tripping on the all-zero image by name before memory grows;
//   4. the child's protocol never hangs: 50 MB on stdout, an early exit, a pipe a grandchild holds, a result with a bad exit;
//   5. how a stopped child is named: a timeout, signal 9 (likely out of memory only near its limit), its own limit;
//   6. one deadline for the whole check, shorter than the CLI's wait (fake timers);
//   7. one check at a time, no orphaned child, the archive removed, the idle-timeout exemption for one request only;
//   8. budget messages, the backup's size logged, the CLI's causes from error codes, and DOCS.
import { afterAll, describe, expect, jest, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, crc32, deflateRawSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { BACKUP_CHECK_BUSY, CHECK_DEADLINE_MS, CHECK_SETTLE_MS, KEY_NAME, Keeper } from "../rootfs/opt/keeper/core.ts";
import { BACKUP_CHECK_CLI_MARGIN_MS, BACKUP_CHECK_CLI_MS, BACKUP_CHECK_SAYS, LOCAL_IDLE_S, NEAR_LIMIT, PIPE_GRACE_MS, SCAN_OUT_MAX, archives, backupCheckCli, exemptBackupCheck, localFetch, requestCause, scanChild } from "../rootfs/opt/keeper/main.ts";
import { DOWNLOAD_MAX, supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { INFLATE_IN, PARENT_GONE_EXIT, gzipMember, scanBackup } from "../rootfs/opt/keeper/scan.ts";

const enc = (x: string) => new TextEncoder().encode(x);
const CTL = "keeper-control-0123456789abcdef01234567";
const KEY = "planted-value-aaaaaaaaaa";
const MB = 1024 * 1024;
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keeper-review-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const cat = (...p: Uint8Array[]) => { const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const hdr = (o: { name: string; size?: number; type?: string }) => {
  const h = new Uint8Array(512);
  const put = (x: string, off: number) => h.set(enc(x), off);
  put(o.name, 0); put("0000600\0", 100); put("0000000\0", 108); put("0000000\0", 116);
  put((o.size ?? 0).toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148); put(o.type ?? "0", 156);
  put("ustar\0", 257); put("00", 263);
  put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
};
const member = (name: string, body: string | Uint8Array, fill = "") => {
  const data = typeof body === "string" ? enc(body) : body;
  const p = new Uint8Array((512 - (data.length % 512)) % 512); if (fill) p.set(enc(fill).subarray(0, p.length));
  return cat(hdr({ name, size: data.length }), data, p);
};
const END = new Uint8Array(1024);
const good = () => [member("./addon.json", "{}"), member("./data/state.json", "{\"format\":1}"), member("./data/backup-check-control", `${CTL}\n`)];
const outer = (inner: Uint8Array) => cat(member("./backup.json", "{\"protected\":false}"), member("./0fcc2575_keeper.tar.gz", inner), END);
const scan = (b: Uint8Array, chunk?: number, needles: string[] = [KEY]) => scanBackup(b, KEY_NAME, needles, { control: CTL, ...(chunk ? { chunk } : {}) });

// A gzip member built by hand around a raw deflate stream whose length is known: header (with a name field of `name` bytes, so the
// body can start anywhere), the deflate stream, the trailer. E is where the deflate stream ends (the trailer's first byte).
function member1(payload: Uint8Array, name = 0) {
  const d = deflateRawSync(payload);
  const head = cat(new Uint8Array([0x1f, 0x8b, 8, name ? 0x08 : 0, 0, 0, 0, 0, 0, 3]), name ? cat(enc("n".repeat(name)), new Uint8Array(1)) : new Uint8Array(0));
  const t = new Uint8Array(8); const v = new DataView(t.buffer);
  v.setUint32(0, crc32(payload) >>> 0, true); v.setUint32(4, payload.length >>> 0, true);
  return { bytes: cat(head, d, t), bodyAt: head.length, E: head.length + d.length, dlen: d.length };
}
// fixed pseudo-random bytes (xorshift), so a search over payloads finds the same one every run
const prng = (seed: number, n: number) => { const o = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o[i] = x & 0xff; } return o; };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const why = async (p: Promise<unknown>) => { try { await p; return "passed"; } catch (e) { return String((e as Error).message); } };

describe("item 1: the gzip member's end, from the inflater's own end signal", () => {
  // a payload that compresses to several 4 KB pieces: random bytes and repeats mixed
  const payload = cat(randomBytes(9000), new Uint8Array(20000).fill(0x41), randomBytes(5000), enc("tail of the payload ".repeat(200)));
  const m = member1(payload, 5);
  test("the pieces are 4 KB and the deflate stream spans several of them", () => {
    expect(INFLATE_IN).toBe(4096);
    expect(m.dlen).toBeGreaterThan(3 * INFLATE_IN);
  });
  test("the stream's end at every offset within a piece, exactly on the piece boundary, and one byte either side", async () => {
    // the first write ends at `cut`, so the second write's pieces start there: the stream ends r bytes into the second write
    // (r = 0: on the first write's last byte; r = 4096: on the last byte of the second write's first piece; r = 4097: one past it)
    const fails: string[] = [];
    for (let r = 0; r <= INFLATE_IN + 1; r++) {
      const cut = m.E - r;
      try {
        const out = await gzipMember(m.bytes, "t", { cuts: [cut] });
        if (!same(out, payload)) fails.push(`r=${r}: the output differs`);
      } catch (e) { fails.push(`r=${r}: ${String((e as Error).message).slice(0, 120)}`); }
    }
    expect(fails).toEqual([]);
  }, 60_000);
  test("the stream's end on a piece boundary when the whole member comes in one write, and at every offset by the header's length", async () => {
    // one write: the pieces start at the body, so the end falls dlen mod 4096 into its last piece; the name field moves it
    const fails: string[] = [];
    for (const shift of [0, 1, 2, 3, 7, 100, 4095]) {
      const mm = member1(payload, shift + 1);
      try { if (!same(await gzipMember(mm.bytes, "t"), payload)) fails.push(`shift ${shift}: the output differs`); } catch (e) { fails.push(`shift ${shift}: ${(e as Error).message}`); }
    }
    expect(fails).toEqual([]);
    // a payload whose deflate stream is exactly a whole number of pieces long, found by search: the end on the boundary in one write
    let exact: Uint8Array | null = null;
    const rnd = prng(58, 4000);
    for (let n = 1; n < 60000 && !exact; n++) {
      const p = cat(rnd, new Uint8Array(n).fill(0x42));
      if (deflateRawSync(p).length === INFLATE_IN) exact = p;
    }
    expect(exact).not.toBeNull();
    {
      const mm = member1(exact!);
      expect(mm.dlen).toBe(INFLATE_IN);
      expect(same(await gzipMember(mm.bytes, "t"), exact!)).toBe(true);
      expect(same(await gzipMember(mm.bytes, "t", { cuts: [mm.E] }), exact!)).toBe(true);
      // and the trailer cut off right at that boundary is named as such
      expect(await why(gzipMember(mm.bytes.subarray(0, mm.E), "t"))).toBe(`t is a gzip that can't be read whole: its 8-byte trailer is cut off (at byte ${mm.E})`);
    }
  }, 60_000);
  test("every split of the 8-byte trailer across writes, with the end in a piece and on a boundary; and a byte at a time", async () => {
    const fails: string[] = [];
    for (let s = 0; s <= 8; s++) {
      for (const cuts of [[m.E + s], [m.E, m.E + s], [m.E - 1, m.E + s], [m.E - INFLATE_IN, m.E + s]]) {
        try { if (!same(await gzipMember(m.bytes, "t", { cuts }), payload)) fails.push(`${cuts}: the output differs`); } catch (e) { fails.push(`${cuts}: ${(e as Error).message}`); }
      }
      // the trailer split in two writes, each byte of it in turn
      try { if (!same(await gzipMember(m.bytes, "t", { cuts: [m.E + s, m.E + s + 1] }), payload)) fails.push(`${s}+1: differs`); } catch (e) { fails.push(`${s}+1: ${(e as Error).message}`); }
    }
    for (const chunk of [1, 3, 8, 9, 4095, 4097]) {
      try { if (!same(await gzipMember(m.bytes, "t", { chunk }), payload)) fails.push(`chunk ${chunk}: differs`); } catch (e) { fails.push(`chunk ${chunk}: ${(e as Error).message}`); }
    }
    expect(fails).toEqual([]);
  }, 60_000);
  test("a truncated deflate stream fails by name, wherever it is cut", async () => {
    for (const at of [m.bodyAt + 3, m.bodyAt + 100, m.bodyAt + INFLATE_IN, m.bodyAt + INFLATE_IN + 1, m.E - 1]) {
      expect([at, await why(gzipMember(m.bytes.subarray(0, at), "t"))]).toEqual([at, expect.stringContaining("t is a gzip that can't be read whole: its deflate stream doesn't decode")]);
      expect([at, await why(gzipMember(m.bytes.subarray(0, at), "t", { chunk: 1000 }))]).toEqual([at, expect.stringContaining("its deflate stream doesn't decode")]);
    }
  });
  // byte-at-a-time writes on a small member (each write is a round trip through the inflater)
  const small = cat(randomBytes(300), enc("x".repeat(700)));
  const sm = member1(small, 3);
  test("a truncated trailer fails by name, cut at each of its bytes (none of it there included)", async () => {
    for (let k = 0; k < 8; k++) {
      for (const chunk of [undefined, 7, 4096]) expect([k, chunk, await why(gzipMember(m.bytes.subarray(0, m.E + k), "t", chunk ? { chunk } : {}))]).toEqual([k, chunk, `t is a gzip that can't be read whole: its 8-byte trailer is cut off (at byte ${m.E})`]);
      expect([k, await why(gzipMember(sm.bytes.subarray(0, sm.E + k), "t", { chunk: 1 }))]).toEqual([k, `t is a gzip that can't be read whole: its 8-byte trailer is cut off (at byte ${sm.E})`]);
    }
  });
  test("after the trailer: zeros pass; garbage and a second 0x1f 0x8b member fail by name, straight after or after zero padding", async () => {
    const second = gzipSync(enc("a second member"));
    for (const pad of [0, 1, 511, 5000]) for (const chunk of [undefined, 1, 7, 4096]) {
      const o = chunk ? { chunk } : {};
      const [mb, pl] = chunk === 1 ? [sm.bytes, small] : [m.bytes, payload];
      const T = mb.length;
      expect(same(await gzipMember(cat(mb, new Uint8Array(pad + 3)), "t", o), pl)).toBe(true);
      expect([pad, chunk, await why(gzipMember(cat(mb, new Uint8Array(pad), enc("garbage")), "t", o))]).toEqual([pad, chunk, `t holds data after its gzip stream (at byte ${T + pad})`]);
      expect([pad, chunk, await why(gzipMember(cat(mb, new Uint8Array(pad), second), "t", o))]).toEqual([pad, chunk, `t holds a second gzip member after the first (at byte ${T + pad}), which Keeper doesn't read`]);
      // a lone 0x1f at the very end, or 0x1f followed by anything but 0x8b, is data after the stream
      expect(await why(gzipMember(cat(mb, new Uint8Array(pad), new Uint8Array([0x1f])), "t", o))).toBe(`t holds data after its gzip stream (at byte ${T + pad})`);
      expect(await why(gzipMember(cat(mb, new Uint8Array(pad), new Uint8Array([0x1f, 0x00])), "t", o))).toBe(`t holds data after its gzip stream (at byte ${T + pad})`);
    }
  }, 60_000);
  test("the trailer is checked at the inflater's end: a wrong CRC32 or length fails by name at the trailer's offset", async () => {
    const c = m.bytes.slice(); c[m.E] ^= 1;
    expect(await why(gzipMember(c, "t"))).toBe(`t is a gzip that can't be read whole: its trailer's CRC32 doesn't match what it decodes to (at byte ${m.E})`);
    const l = m.bytes.slice(); l[m.E + 4] ^= 1;
    expect(await why(gzipMember(l, "t", { chunk: 1 }))).toBe(`t is a gzip that can't be read whole: its trailer's length doesn't match what it decodes to (at byte ${m.E + 4})`);
  });
  test("inside a whole archive, the image's stream ending at every offset of the outer read's chunk scans the same", async () => {
    const inner = gzipSync(cat(...good(), member("./data/blob", randomBytes(20000)), END));
    const arch = outer(inner);
    const want = await scan(arch);
    expect(want).toMatchObject({ ok: true, control: 1 });
    for (const chunk of [1, 8, 9, 4095, 4096, 4097, 65536]) expect([chunk, (await scan(arch, chunk)).why]).toEqual([chunk, ""]);
  }, 60_000);
});

describe("item 2: a value straddling a tar header, a member's data and its padding is found by one layer", () => {
  const half = KEY.length >> 1;
  // a header whose last bytes (after the prefix field, before byte 512) hold `tail`, its checksum made right again
  const headEnding = (name: string, size: number, tail: string) => {
    const h = hdr({ name, size }); h.set(enc(tail), 512 - tail.length);
    for (let i = 148; i < 156; i++) h[i] = 32;
    let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
    h.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    return h;
  };
  const plainWith = (...m: Uint8Array[]) => cat(member("./backup.json", "{}"), ...m, ...good(), END);
  // (a) the end of a header into the member's data
  const headIntoData = (v = KEY, h = half) => { const data = cat(enc(v.slice(h)), enc("y".repeat(300))); return cat(headEnding("./data/a", data.length, v.slice(0, h)), data, new Uint8Array((512 - (data.length % 512)) % 512)); };
  // (b) the end of the member's data into its padding
  const dataIntoPad = () => { const data = cat(enc("y".repeat(300)), enc(KEY.slice(0, half))); return member("./data/b", data, KEY.slice(half)); };
  // (c) the end of the padding into the next header (its name field)
  const padIntoHead = () => {
    const data = enc("y".repeat(300)); const p = new Uint8Array(512 - 300); p.set(enc(KEY.slice(0, half)), p.length - half);
    return cat(hdr({ name: "./data/c", size: 300 }), data, p, member(`${KEY.slice(half)}-next`, "z"));
  };
  const CHUNKS = [1, 7, 511, 512, 65536];
  test("each straddle, in a plain tar, at chunk sizes 1, 7, 511, 512 and 65536: found and named by the tar layer", async () => {
    const cases: [string, Uint8Array, RegExp][] = [
      ["a header's end into data", plainWith(headIntoData()), /the archive \(its tar headers, padding or tail\) holds a key value, a key's fingerprint or the sentinel at byte \d+, across the edge of \.\/data\/a's data/],
      ["data's end into padding", plainWith(dataIntoPad()), /the archive \(its tar headers, padding or tail\) holds a key value, a key's fingerprint or the sentinel at byte \d+, across the edge of \.\/data\/b's data/],
      ["padding's end into the next header", plainWith(padIntoHead()), /the archive \(its tar headers, padding or tail\) holds a key value, a key's fingerprint or the sentinel at byte \d+/],
    ];
    for (const [what, arch, re] of cases) {
      // no member alone holds the value: neither half matches
      const one = await scan(arch, arch.length);
      expect([what, one.ok, one.why]).toEqual([what, false, expect.stringMatching(re)]);
      for (const chunk of CHUNKS) expect([what, chunk, (await scan(arch, chunk)).why]).toEqual([what, chunk, one.why]);
    }
  }, 60_000);
  test("the same straddles inside the image's tar (behind gzip) are found too", async () => {
    for (const m of [headIntoData(), dataIntoPad(), padIntoHead()]) {
      const r = await scan(outer(gzipSync(cat(m, ...good(), END))));
      expect(r.why).toMatch(/\.\/0fcc2575_keeper\.tar\.gz \(its tar headers, padding or tail\) holds a key value/);
    }
  });
  test("a value longer than the chunk, straddling a header into data, is found at every chunk size", async () => {
    const long = `long-value-${"q".repeat(600)}`;
    const arch = plainWith(headIntoData(long, 10));
    for (const chunk of [...CHUNKS, arch.length]) {
      const r = await scanBackup(arch, KEY_NAME, [long], { control: CTL, chunk });
      expect([chunk, r.why]).toEqual([chunk, expect.stringMatching(/holds a key value, a key's fingerprint or the sentinel at byte 1526, across the edge of \.\/data\/a's data/)]);
    }
  });
  test("a control wholly inside a leaf passes once; a second control crossing a header into data fails", async () => {
    const ctlStraddle = (() => { const h = 9; const data = cat(enc(CTL.slice(h)), enc("y".repeat(10))); return cat(headEnding("./data/s", data.length, CTL.slice(0, h)), data, new Uint8Array(512 - data.length)); })();
    const okArch = plainWith();
    for (const chunk of [...CHUNKS, okArch.length]) expect((await scan(okArch, chunk)).ok).toBe(true);
    const bad = plainWith(ctlStraddle);
    for (const chunk of [...CHUNKS, bad.length]) {
      const r = await scan(bad, chunk);
      expect([chunk, r.why]).toEqual([chunk, expect.stringMatching(/the archive \(its tar headers, padding or tail\) holds the positive control outside any file, at byte \d+, across the edge of \.\/data\/s's data/)]);
    }
  });
  test("a value wholly inside a member's data is reported once, by the member's own layer, never by the tar layer as well", async () => {
    const arch = plainWith(member("./data/inside", `${"x".repeat(100)}${KEY}${"x".repeat(100)}`));
    for (const chunk of [...CHUNKS, arch.length]) {
      const r = await scan(arch, chunk);
      expect([chunk, r.found]).toEqual([chunk, ["./data/inside holds a key value, a key's fingerprint or the sentinel at byte 100"]]);
    }
  });
  test("the control's non-overlapping count carries across seams: never twice, never missed", async () => {
    const A = "A".repeat(20);
    for (const [n, want] of [[39, 1], [40, 2], [59, 2], [60, 3]] as [number, number][]) {
      const arch = cat(member("./backup.json", "{}"), member("./addon.json", "{}"), member("./data/ctl", "A".repeat(n)), END);
      for (const chunk of [1, 7, 13, 19, 20, 21, 511, 512, arch.length]) {
        const r = await scanBackup(arch, KEY_NAME, [], { control: A, chunk });
        expect([n, chunk, r.control]).toEqual([n, chunk, want]);
      }
    }
  });
  test("streamed equals one-shot over every case here and the earlier rounds' shapes", async () => {
    const cases = [plainWith(headIntoData()), plainWith(dataIntoPad()), plainWith(padIntoHead()), plainWith(), outer(gzipSync(cat(headIntoData(), ...good(), END))),
      outer(gzipSync(cat(member("./data/short", "x", CTL), ...good(), END))), cat(outer(gzipSync(cat(...good(), END))), enc(KEY))];
    for (const [i, c] of cases.entries()) {
      const one = await scan(c, c.length);
      for (const chunk of CHUNKS) {
        const r = await scan(c, chunk);
        // a scan that stops on an unreadable archive stops where the bad byte is: its findings so far depend on the chunking
        const stopped = one.why.startsWith("the backup couldn't be read");
        expect([i, chunk, r.ok, r.why, stopped || r.control, stopped || r.found]).toEqual([i, chunk, one.ok, one.why, stopped || one.control, stopped || one.found]);
      }
    }
  }, 60_000);
});

// a file of the given bytes in a scratch folder, as the downloaded archive
const fileOf = (b: Uint8Array) => { const p = join(scratch(), "bk.tar"); writeFileSync(p, b); return { path: p, size: b.length, remove: () => rmSync(p, { force: true }) }; };
// a gzip stream of the given parts, written to a file a piece at a time (zeros come from one buffer, never held whole)
async function gzipFile(path: string, parts: (Uint8Array | { zeros: number })[]): Promise<number> {
  const g = createGzip({ level: 9, memLevel: 9 });
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(path);
  g.pipe(out);
  const Z = new Uint8Array(16 * MB);
  let n = 0;
  const put = async (b: Uint8Array) => { n += b.length; if (!g.write(b)) await new Promise((r) => g.once("drain", r)); };
  for (const p of parts) {
    if (p instanceof Uint8Array) await put(p);
    else for (let left = p.zeros; left > 0; left -= Z.length) await put(Z.subarray(0, Math.min(Z.length, left)));
  }
  await new Promise<void>((res) => { out.once("close", () => res()); g.end(); });
  return n;
}
// the outer tar around an image tar.gz read from its file
function outerFile(path: string, inner: Uint8Array) {
  const fd = openSync(path, "w");
  const w = (b: Uint8Array) => { for (let o = 0; o < b.length;) o += writeSync(fd, b, o, b.length - o); };
  w(member("./backup.json", "{\"protected\":false}")); w(member("./0fcc2575_keeper.tar.gz", inner)); w(END);
  closeSync(fd);
  return { path, size: statSync(path).size, remove: () => rmSync(path, { force: true }) };
}

describe("item 3: backpressure: deflate's expansion never outruns the layers below", () => {
  const CAP = 256 * MB;
  test("the resident size is checked for every chunk the inflater puts out, not only on a timer", async () => {
    let ticks = 0;
    const arch = outer(gzipSync(cat(...good(), member("./data/zeros", new Uint8Array(8 * MB)), END)));
    const r = await scanBackup(arch, KEY_NAME, [], { control: CTL, tick: () => { ticks++; } });
    expect(r.ok).toBe(true);
    expect(ticks).toBeGreaterThanOrEqual(Math.floor((r.expanded ?? 0) / (64 * 1024)));
  });
  test("an image tar.gz of 2 GB of zeros (2 MB compressed) passes in its child under the 256 MB cap, its peak asserted", async () => {
    const d = scratch();
    const gzPath = join(d, "image.tar.gz");
    const zeros = 2 * 1024 * MB;
    const inflated = await gzipFile(gzPath, [...good(), hdr({ name: "./data/zeros.img", size: zeros }), { zeros }, END]);
    const inner = new Uint8Array(readFileSync(gzPath));
    expect(inner.length).toBeLessThan(8 * MB);
    const f = outerFile(join(d, "bk.tar"), inner);
    const r = await scanChild(f, KEY_NAME, [KEY], CTL, { rssMax: CAP, log: () => {} });
    expect(r).toMatchObject({ ok: true, why: "", control: 1 });
    expect(r.expanded).toBe(inflated);
    expect(r.peakRss!).toBeGreaterThan(0);
    expect(r.peakRss!).toBeLessThan(CAP);
    console.log(`2 GB of zeros: ${(f.size / MB).toFixed(1)} MB archive, ${(inflated / MB).toFixed(0)} MB decoded, the child's peak ${(r.peakRss! / MB).toFixed(1)} MB`);
  }, 240_000);
  test("a doubly nested all-zero gzip (a gzip of zeros inside the image's tar.gz) passes under the cap, its peak asserted", async () => {
    const d = scratch();
    const zPath = join(d, "blob.gz");
    const zeros = 1024 * MB;
    await gzipFile(zPath, [{ zeros }]);
    const blob = new Uint8Array(readFileSync(zPath));
    const inner = gzipSync(cat(...good(), member("./data/blob.bin", blob), END), { level: 9 });
    const f = outerFile(join(d, "bk.tar"), inner);
    const r = await scanChild(f, KEY_NAME, [KEY], CTL, { rssMax: CAP, log: () => {} });
    expect(r).toMatchObject({ ok: true, why: "", control: 1 });
    expect(r.expanded!).toBeGreaterThan(zeros);
    expect(r.peakRss!).toBeLessThan(CAP);
    console.log(`doubly nested zeros: ${(f.size / 1024).toFixed(0)} KB archive, ${((r.expanded ?? 0) / MB).toFixed(0)} MB decoded, the child's peak ${(r.peakRss! / MB).toFixed(1)} MB`);
  }, 240_000);
  test("the expanded-bytes budget trips on the all-zero image by name, before memory grows", async () => {
    const d = scratch();
    const gzPath = join(d, "image.tar.gz");
    const zeros = 2 * 1024 * MB;
    await gzipFile(gzPath, [...good(), hdr({ name: "./data/zeros.img", size: zeros }), { zeros }, END]);
    const f = outerFile(join(d, "bk.tar"), new Uint8Array(readFileSync(gzPath)));
    const limit = 64 * MB;
    const r = await scanChild(f, KEY_NAME, [KEY], CTL, { rssMax: CAP, maxExpanded: limit, log: () => {} });
    expect(r.ok).toBe(false);
    expect(r.why).toContain(`./0fcc2575_keeper.tar.gz decodes past Keeper's budget of ${limit} bytes expanded in all (the expanded-bytes budget), at byte`);
    expect(r.why).toMatch(new RegExp(`\\(the expanded-bytes budget, in the scan phase: limit ${limit} bytes decoded in all, seen \\d+ bytes decoded; what to do: `));
    const seen = Number(/seen (\d+) bytes decoded/.exec(r.why)![1]);
    expect(seen).toBeGreaterThan(limit);
    expect(seen).toBeLessThanOrEqual(limit + 64 * 1024);           // charged per output chunk, as it arrives
    // the scan ended there, with the inflater never far ahead: the child stayed small
    expect(r.peakRss!).toBeGreaterThan(0);
    expect(r.peakRss!).toBeLessThan(128 * MB);
  }, 240_000);
});

// a child script, written to a scratch file and run in place of scan.ts
const script = (src: string) => { const p = join(scratch(), "child.ts"); writeFileSync(p, src); return p; };
const small = () => fileOf(outer(gzipSync(cat(...good(), END))));
const OF = (f: { size: number }) => `the ${f.size}-byte (${(f.size / MB).toFixed(1)} MB) test backup`;

describe("item 4: the child's protocol never hangs", () => {
  test("a child that writes 50 MB to stdout is stopped at the cap, not waited on for its time", async () => {
    const f = small();
    const t0 = Date.now();
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script("const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 50; i++) await Bun.write(Bun.stdout, b); await Bun.sleep(60_000);\n"), timeoutMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.why).toStartWith(`the scan wrote more than 1.0 MB on its output reading ${OF(f)}, more than its one-line result, and was stopped (the scan's output limit, in the scan phase: limit 1.0 MB`);
    expect(SCAN_OUT_MAX).toBe(MB);
  }, 30_000);
  test("a child that writes 50 MB to stderr is drained past its cap and its result still used", async () => {
    const f = small();
    const good1 = JSON.stringify({ ok: true, why: "", members: 3, names: [], found: [], control: 1 });
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script(`const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 50; i++) await Bun.write(Bun.stderr, b); console.log(${JSON.stringify(good1)});\n`), timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: true, members: 3, control: 1 });
  }, 30_000);
  test("a child that exits before reading stdin: its job's write fails or is never read, named \"ended without a result\"", async () => {
    const f = small();
    for (const needles of [[], [{ value: "x".repeat(4 * MB), kind: "a big needle" }]]) {
      const r = await scanChild(f, KEY_NAME, needles, CTL, { script: script("process.exit(3);\n"), timeoutMs: 20_000 });
      expect(r.why).toStartWith(`the scan ended without a result (exit 3) reading ${OF(f)}`);
    }
  }, 30_000);
  test("a pipe held open by a grandchild after the child exits: not waited on, its result not used", async () => {
    const f = small();
    const d = scratch(); const pidFile = join(d, "grandchild.pid");
    const good1 = JSON.stringify({ ok: true, why: "", members: 3, names: [], found: [], control: 1 });
    const src = `const g = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref(); console.log(${JSON.stringify(good1)}); process.exit(0);\n`;
    const t0 = Date.now();
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script(src), timeoutMs: 60_000 });
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
    expect(Date.now() - t0).toBeLessThan(PIPE_GRACE_MS + 8000);
    expect(r.ok).toBe(false);
    expect(r.why).toBe(`the scan's output stayed open 2 seconds after it exited (exit 0) reading ${OF(f)}: something it started still holds it, so its result isn't used`);
  }, 30_000);
  test("a valid result followed by a non-zero exit is not a result; nor two lines, nor a line that isn't the schema", async () => {
    const f = small();
    const good1 = JSON.stringify({ ok: true, why: "", members: 3, names: [], found: [], control: 1 });
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script(`console.log(${JSON.stringify(good1)}); process.exit(1);\n`) });
    expect(r.why).toBe(`the scan ended without a result (exit 1) reading ${OF(f)}`);
    expect(r.ok).toBe(false);
    const two = await scanChild(f, KEY_NAME, [], CTL, { script: script(`console.log(${JSON.stringify(good1)}); console.log(${JSON.stringify(good1)});\n`) });
    expect(two.why).toBe(`the scan ended without a result (exit 0) reading ${OF(f)}: its output wasn't one valid result line`);
    for (const bad of [{ ok: "yes", why: "" }, { ok: true, why: "", members: -1, names: [], found: [], control: 1 }, { ok: true, why: "", members: 1, names: [1], found: [], control: 1 }]) {
      const b = await scanChild(f, KEY_NAME, [], CTL, { script: script(`console.log(${JSON.stringify(JSON.stringify(bad))});\n`) });
      expect(b.why).toBe(`the scan ended without a result (exit 0) reading ${OF(f)}: its output wasn't one valid result line`);
    }
  }, 30_000);
});

describe("item 5: how a stopped child is named", () => {
  const RSS = 100 * MB;
  test("the service's own timeout is a timeout, though the child dies of its signal 9", async () => {
    const f = small();
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script("await Bun.sleep(60_000);\n"), timeoutMs: 1500 });
    expect(r.why).toStartWith(`the scan took longer than 2 seconds reading ${OF(f)} and was stopped (a timeout, not a crash) (the scan's time limit, in the scan phase: limit 2 seconds`);
    expect(r.why).not.toContain("signal 9");
    expect(r.why).not.toContain("out of memory");
  }, 20_000);
  test("signal 9 with no memory sample near the limit: killed (signal 9), not out of memory; near it: likely out of memory", async () => {
    const f = small();
    const far = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script(`require("node:fs").writeSync(2, "rss ${10 * MB}\\n"); process.kill(process.pid, "SIGKILL");\n`) });
    expect(far.why).toBe(`the scan was killed (signal 9) reading ${OF(f)}: its last memory sample was 10.0 MB, not near its limit of 100.0 MB, so something else stopped it (the system, a supervisor stop or a manual kill); Keeper's service is unharmed`);
    const near = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script(`require("node:fs").writeSync(2, "rss ${10 * MB}\\nrss ${95 * MB}\\n"); process.kill(process.pid, "SIGKILL");\n`) });
    expect(near.why).toBe(`the scan was killed (signal 9) reading ${OF(f)}: likely out of memory, its last memory sample 95.0 MB near its limit of 100.0 MB; Keeper's service is unharmed`);
    expect(NEAR_LIMIT).toBe(0.8);
    // exit status 137 (a shell's report of signal 9) is read the same way
    const code = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script("process.exit(137);\n") });
    expect(code.why).toStartWith(`the scan was killed (signal 9) reading ${OF(f)}: its last memory sample was 0.0 MB`);
  }, 20_000);
  test("another signal is named as itself; the child's own limit as out of memory with what it saw", async () => {
    const f = small();
    const term = await scanChild(f, KEY_NAME, [], CTL, { script: script("process.kill(process.pid, 'SIGTERM'); await Bun.sleep(5000);\n") });
    expect(term.why).toBe(`the scan was stopped by SIGTERM reading ${OF(f)}`);
    const own = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script(`require("node:fs").writeSync(2, "rss ${101 * MB}\\nover the scan's memory limit: ${101 * MB} bytes resident\\n"); process.exit(75);\n`) });
    expect(own.why).toBe(`the scan was killed (out of memory): it passed its own limit of 100.0 MB reading ${OF(f)} (the scan's memory limit, in the scan phase: limit 100.0 MB resident, seen 101.0 MB resident; what to do: stop other Apps or free memory on the device, then run backup-check again; if it fails again, report it with the backup's size)`);
  }, 20_000);
  test("the real child asks the kernel's out-of-memory killer to prefer it (oom_score_adj 1000) and reports its memory as it runs", async () => {
    const f = small();
    const r = await scanChild(f, KEY_NAME, [], CTL, { log: () => {} });
    expect(r).toMatchObject({ ok: true, control: 1 });
    if (existsSync("/proc/self/oom_score_adj")) expect(r.oomScoreAdj).toBe(1000);
    expect(r.lastRss!).toBeGreaterThan(0);
  });
});

// A Keeper with only what the backup check needs (as scan-stream.test.ts's): key files in memory, a test backup and its delete
const LEGACY_TMP = ["hc-key", "1", "abcdefabcdef", "tmp"].join(".");
function bare(o: { download?: (slug: string, x?: any) => Promise<any>; scan?: (f: any, n: RegExp, nd: any[], c: string, x?: any) => Promise<any>; size?: number } = {}) {
  const logs: string[] = [], deleted: string[] = [];
  const files: Record<string, string> = {};
  let control = "", made = 0;
  const k = new Keeper({
    now: () => Date.parse("2026-11-25T10:00:00Z"), version: "0.1.17", self: "0fcc2575_keeper",
    appInfo: async () => null, backupInfo: async () => ({ homeassistant: null, addons: [], folders: [], sizeBytes: o.size ?? 0 }),
    makeBackup: async () => { made++; return { slug: "bc-test" }; }, restore: async () => ({ kind: "refused", why: "no" } as any), job: async () => null,
    live: async () => true, ready: async () => true, ping: async () => true, options: () => null, save: () => true, log: (l) => logs.push(l),
    deleteBackup: async (sl) => { deleted.push(sl); return true; }, backups: async () => [],
    keyFiles: {
      place: (sv: string, skip: string[] = []) => { const out = ["hc-key", "hc-key-old", "hc-key.tmp-aa", LEGACY_TMP, "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa", "drill-spent/backup-check-sentinel"].filter((n) => !skip.includes(n)); for (const n of out) files[n] = sv; return out; },
      read: (n: string) => files[n] ?? null, control: (v: string) => { control = v; files["backup-check-control"] = v; return "backup-check-control"; },
      clear: () => {}, sweep: () => [],
    },
    download: o.download ?? (async () => null),
    ...(o.scan ? { scan: o.scan } : {}),
  }, null);
  return { k, logs, deleted, get control() { return control; }, get made() { return made; } };
}
const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

describe("item 6: one deadline for the whole check, shorter than the CLI's wait", () => {
  test("the CLI waits longer than the service's deadline, with a margin for the cleanup", () => {
    expect(CHECK_DEADLINE_MS).toBe(8 * 60_000);
    expect(BACKUP_CHECK_CLI_MS).toBeGreaterThanOrEqual(CHECK_DEADLINE_MS + BACKUP_CHECK_CLI_MARGIN_MS);
  });
  test("a download that never ends: the check fails at 8 minutes naming the download phase, and the download is aborted (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      let given: any = null, late: (f: any) => void = () => {};
      const removed: string[] = [];
      const b = bare({ download: (_s, x) => { given = x; return new Promise((res) => { late = res; }); } });
      const p = b.k.backupCheck();
      await settle();
      expect(given.timeoutMs).toBeLessThanOrEqual(CHECK_DEADLINE_MS);
      expect(given.signal.aborted).toBe(false);
      jest.advanceTimersByTime(CHECK_DEADLINE_MS - 1);
      await settle();
      jest.advanceTimersByTime(1);
      // (last round) the cleanup waits up to CHECK_SETTLE_MS for the download, which ignores its abort here, then deletes the backup
      for (let t = 0; t <= CHECK_SETTLE_MS; t += 1000) { await settle(); jest.advanceTimersByTime(1000); }
      await settle();
      const r = await p;
      // the download is still outstanding: the slot stays held until it settles
      expect(await b.k.backupCheck()).toEqual({ ok: false, why: BACKUP_CHECK_BUSY });
      expect(r.why).toStartWith("the backup check ran past its deadline of 8 minutes while downloading the test backup (the backup check's deadline, in the downloading phase: limit 8 minutes for the whole check, seen still downloading after 8 minutes; what to do: ");
      expect(given.signal.aborted).toBe(true);
      expect(b.deleted).toEqual(["bc-test"]);
      // a download that answers after the deadline has its file removed
      late({ path: "/nonexistent", size: 1, remove: () => removed.push("late") });
      await settle();
      expect(removed).toEqual(["late"]);
      // and with it settled, the slot is free
      expect((b.k as any).checking).toBe(false);
    } finally { jest.useRealTimers(); }
  });
  test("a scan that never ends: the check fails at 8 minutes naming the scan phase, its child aborted and its file removed (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      let given: any = null;
      const removed: string[] = [];
      const b = bare({ download: async () => ({ path: "/nonexistent", size: 0, remove: () => removed.push("file") }), scan: (_f, _n, _nd, _c, x) => { given = x; return new Promise(() => {}); } });
      const p = b.k.backupCheck();
      await settle();
      expect(given.timeoutMs).toBeLessThanOrEqual(CHECK_DEADLINE_MS);
      jest.advanceTimersByTime(CHECK_DEADLINE_MS);
      // (last round) the cleanup waits up to CHECK_SETTLE_MS for the scan (which never ends here), then goes on
      await settle();
      jest.advanceTimersByTime(CHECK_SETTLE_MS);
      await settle();
      const r = await p;
      expect(r.why).toStartWith("the backup check ran past its deadline of 8 minutes while scanning the test backup (the backup check's deadline, in the scanning phase:");
      expect(given.signal.aborted).toBe(true);
      expect(removed).toEqual(["file"]);
      expect(b.k.checkPassed()).toBe(false);
    } finally { jest.useRealTimers(); }
  });
  test("the real child, aborted by the check's deadline, is stopped at once and named", async () => {
    const ac = new AbortController();
    const f = small();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script("await Bun.sleep(60_000);\n"), signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.why).toBe(`the scan was stopped reading ${OF(f)}: the backup check's deadline passed`);
  });
});

describe("item 7: one check at a time, and no orphans", () => {
  test("a second backup check while one runs is answered at once with the fixed message: one download, one scan, one backup", async () => {
    let gate: (v: any) => void = () => {};
    let downloads = 0, scans = 0;
    const f = small();
    const b = bare({ size: f.size, download: () => { downloads++; return new Promise((res) => { gate = res; }); }, scan: async () => { scans++; return { ok: false, why: "stub", members: 0, names: [], found: [], control: 0 }; } });
    const first = b.k.backupCheck();
    await settle();
    expect(await b.k.backupCheck()).toEqual({ ok: false, why: BACKUP_CHECK_BUSY });
    expect(BACKUP_CHECK_BUSY).toBe("a backup check is already running");
    gate(f);
    expect((await first).why).toBe("stub");
    expect([downloads, scans, b.made]).toEqual([1, 1, 1]);
    // and the CLI says so in plain words
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: false, why: BACKUP_CHECK_BUSY }, { status: 409 }) });
    expect((await backupCheckCli(`http://127.0.0.1:${srv.port}/backup-check`, { say: () => {} })).line).toBe(BACKUP_CHECK_SAYS.busy);
    srv.stop(true);
  });
  const fifo = () => { const p = join(scratch(), "never.tar"); expect(Bun.spawnSync(["mkfifo", p]).exitCode).toBe(0); return p; };
  const alive = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^\d+ \(.*\) Z/.test(st); } catch { return false; } };
  test("the child exits when its standard input closes (the service gone), though its scan is blocked", async () => {
    const path = fifo();
    const scanTs = join(import.meta.dir, "..", "rootfs", "opt", "keeper", "scan.ts");
    const c = Bun.spawn([process.execPath, "--smol", scanTs, "child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    c.stdin.write(`${JSON.stringify({ path, names: { source: "$^", flags: "" }, needles: [], control: CTL })}\n`); await c.stdin.flush();
    await Bun.sleep(400);
    expect(c.exitCode).toBeNull();                                   // blocked opening a pipe nobody writes
    await c.stdin.end();
    const code = await Promise.race([c.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(code).toBe(PARENT_GONE_EXIT);
  }, 15_000);
  test("the child exits when its parent is killed (no orphaned scan)", async () => {
    const d = scratch(), pidFile = join(d, "child.pid"), path = fifo();
    const main = join(import.meta.dir, "..", "rootfs", "opt", "keeper", "main.ts");
    const src = `import { scanChild } from ${JSON.stringify(main)};\nawait scanChild({ path: ${JSON.stringify(path)}, size: 1, remove: () => {} }, /$^/, [], "c", { onSpawn: (pid) => require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(pid)) });\n`;
    const mid = Bun.spawn([process.execPath, script(src)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(400);
    expect(alive(pid)).toBe(true);
    mid.kill("SIGKILL");
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) { await Bun.sleep(50); gone = !alive(pid); }
    if (!gone) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    expect(gone).toBe(true);
  }, 15_000);
  test("the downloaded archive: removed in the check's finally, and by the start-up sweep whatever the slug's name", async () => {
    const dir = scratch();
    // a download interrupted mid-way (the service killed): its file stays, named <slug>.tar, and the sweep removes it
    for (const slug of ["bc-test", "a/b c..d", "x.tar.gz"]) void archives(dir).through(slug, async (p) => { writeFileSync(p, "partial"); return new Promise<boolean>(() => {}); });
    await Bun.sleep(20);
    const left = readdirSync(dir).sort();
    expect(left).toEqual(["a_b_c__d.tar", "bc-test.tar", "x_tar_gz.tar"]);
    expect(archives(dir).sweep().sort()).toEqual(left);
    expect(readdirSync(dir)).toEqual([]);
    // the check removes its file whatever the scan answers
    const removed: string[] = [];
    const f = small();
    const b = bare({ size: f.size, download: async () => ({ ...f, remove: () => removed.push("done") }), scan: async () => { throw new Error("boom"); } });
    expect((await b.k.backupCheck()).why).toBe("the scan couldn't run (boom)");
    expect(removed).toEqual(["done"]);
  });
  test("the idle-timeout exemption covers the backup check's request only, not its connection afterwards (Bun as in the Dockerfile)", async () => {
    const docker = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
    expect(Bun.version).toBe(/ARG BUN_VERSION=([\d.]+)/.exec(docker)![1]);
    expect(LOCAL_IDLE_S).toBe(30);
    // the loopback listener's own handler calls exemptBackupCheck for every request
    expect(String(localFetch)).toContain("exemptBackupCheck(req, server)");
    // Bun 1.4.4 idle-cuts only a request without a body while its handler runs, so the check is made with GETs: the same
    // exemption, the same server option, on a 1 s idle timeout (Bun's idle timer has a coarse tick, so each request takes 9 s)
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 1, fetch: async (req, server) => { exemptBackupCheck(req, server); await Bun.sleep(9000); return new Response("done"); } });
    const { connect } = await import("node:net");
    const sock = connect(srv.port, "127.0.0.1");
    let got = "", closed = false;
    sock.on("data", (x) => { got += x.toString(); }); sock.on("close", () => { closed = true; }); sock.on("error", () => {});
    await new Promise((r) => sock.once("connect", r));
    sock.write("GET /backup-check HTTP/1.1\r\nHost: x\r\n\r\n");
    for (let i = 0; i < 240 && !got.includes("done"); i++) await Bun.sleep(50);
    expect(got).toContain("HTTP/1.1 200");                          // 9 s on a 1 s idle timeout: exempt
    expect(closed).toBe(false);
    got = "";
    sock.write("GET /drill-state HTTP/1.1\r\nHost: x\r\n\r\n");   // the same connection, another slow request
    for (let i = 0; i < 240 && !closed; i++) await Bun.sleep(50);
    expect(closed).toBe(true);                                      // cut by the idle timeout: the exemption didn't stay
    expect(got).toBe("");
    srv.stop(true);
  }, 40_000);
});

describe("item 8: messages and budgets", () => {
  test("every budget's failure names its phase, its limit, what was seen and what to do", async () => {
    const shape = /\(the [a-z' -]+, in the [a-z]+ phase: limit [^,;]+, seen [^;]+; what to do: [^)]+\)/;
    // nesting
    let t = cat(...good(), END);
    for (let i = 0; i < 8; i++) t = cat(member(`./layer-${i}.tar`, t), END);
    const deep = await scan(cat(member("./backup.json", "{}"), member("./deep.tar.gz", gzipSync(t)), END));
    expect(deep.why).toMatch(/the nesting budget, in the scan phase: limit 6 layers, seen 7 layers; what to do: /);
    // a record past MAX_RECORD (a pax header of 2 MB)
    const pax = cat(hdr({ name: "./PaxHeaders/x", size: 2 * MB, type: "x" }), new Uint8Array(2 * MB), hdr({ name: "./data/x", size: 0 }));
    const rec = await scan(outer(gzipSync(cat(pax, ...good(), END))));
    expect(rec.why).toMatch(/the record budget, in the scan phase: limit 1048576 bytes, seen 2097152 bytes; what to do: /);
    for (const w of [deep.why, rec.why]) expect(w).toMatch(shape);
  });
  test("the download's cap and time limit are named as budgets of the download phase", async () => {
    const d = scratch();
    const big = new Uint8Array(MB);
    const stream = (n: number, stall = false) => new ReadableStream<Uint8Array>({ async pull(c) { if (stall) { await Bun.sleep(10_000); return; } if (n-- > 0) c.enqueue(big); else c.close(); } });
    const capped = supervisor("t", "http://sup", async () => new Response(stream(DOWNLOAD_MAX / MB + 1)));
    const cap = await capped.downloadTo("bk", join(d, "a.tar"));
    expect(cap).toMatch(/^it passed Keeper's download cap \(the download cap, in the download phase: limit 200\.0 MB, seen over 200\.0 MB \(\d+ bytes when it stopped\); what to do: /);
    expect(existsSync(join(d, "a.tar"))).toBe(false);
    const slow = supervisor("t", "http://sup", async (_u, init) => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); (init.signal as AbortSignal).addEventListener("abort", () => c.error((init.signal as AbortSignal).reason)); } })));
    const late = await slow.downloadTo("bk", join(d, "b.tar"), { timeoutMs: 300 });
    expect(late).toBe(`it took longer than 300 ms (the download's time limit, in the download phase: limit 300 ms, seen ${MB} bytes in 300 ms; what to do: run backup-check again when the device is less busy)`);
    expect(existsSync(join(d, "b.tar"))).toBe(false);
    // the check passes the reason on, with the Supervisor's size for the backup
    const b = bare({ size: 4242, download: async () => ({ why: cap as string }) });
    expect((await b.k.backupCheck()).why).toStartWith("the test backup bc-test (4242 bytes, as the Supervisor reports it) couldn't be downloaded: it passed Keeper's download cap (the download cap, in the download phase:");
  });
  test("the backup's size is logged on every check, passed or failed", async () => {
    const f = small();
    for (const scanR of [{ ok: true, why: "", members: 3, names: [], found: [], control: 1 }, { ok: false, why: "no", members: 0, names: [], found: [], control: 0 }]) {
      const b = bare({ size: f.size, download: async () => ({ ...f, remove: () => {} }), scan: async () => scanR });
      await b.k.backupCheck();
      expect(b.logs).toContain(`backup check: test backup bc-test downloaded, ${f.size} bytes (${(f.size / MB).toFixed(1)} MB; the Supervisor reports ${f.size} bytes)`);
    }
    // a size mismatch still logs the size first
    const m = bare({ size: f.size + 1, download: async () => ({ ...f, remove: () => {} }) });
    expect((await m.k.backupCheck()).why).toContain(`download is ${f.size} bytes, but the Supervisor reports ${f.size + 1}`);
    expect(m.logs.some((l) => l.startsWith(`backup check: test backup bc-test downloaded, ${f.size} bytes`))).toBe(true);
  });
  test("the CLI reads the cause from the error's code: a real closed port, a reset mid-response, a stall; a neutral line otherwise", async () => {
    const say = { say: () => {} };
    const gone = Bun.serve({ port: 0, fetch: () => new Response("") }); const port = gone.port; gone.stop(true);
    expect((await backupCheckCli(`http://127.0.0.1:${port}/backup-check`, say)).line).toBe(BACKUP_CHECK_SAYS.refused);
    const listen = async (on: (s: any) => void) => { const srv = createServer(on); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}/backup-check` }; };
    const reset = await listen((s) => s.once("data", () => { s.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"ok\":"); setTimeout(() => s.resetAndDestroy(), 30); }));
    expect((await backupCheckCli(reset.url, say)).line).toBe(BACKUP_CHECK_SAYS.stopped);
    reset.srv.close();
    const early = await listen((s) => s.once("data", () => setTimeout(() => s.resetAndDestroy(), 30)));
    expect((await backupCheckCli(early.url, say)).line).toBe(BACKUP_CHECK_SAYS.stopped);
    early.srv.close();
    const stall = await listen((s) => s.once("data", () => {}));
    expect((await backupCheckCli(stall.url, { ...say, timeoutMs: 300 })).line).toBe(BACKUP_CHECK_SAYS.timeout);
    stall.srv.close();
    const stallMid = await listen((s) => s.once("data", () => s.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{")));
    expect((await backupCheckCli(stallMid.url, { ...say, timeoutMs: 300 })).line).toBe(BACKUP_CHECK_SAYS.timeout);
    stallMid.srv.close();
    // the code decides, never the message: a message that names a cause, without its code, gets the neutral line with the raw code
    const http = (e: any) => (async () => { throw e; }) as any;
    expect((await backupCheckCli("http://x/", { ...say, http: http(Object.assign(new Error("ECONNREFUSED: Unable to connect"), { name: "TypeError" })) })).line).toBe(BACKUP_CHECK_SAYS.other("TypeError"));
    expect((await backupCheckCli("http://x/", { ...say, http: http(Object.assign(new Error("whatever"), { code: "EHOSTUNREACH" })) })).line).toBe(BACKUP_CHECK_SAYS.other("EHOSTUNREACH"));
    expect(BACKUP_CHECK_SAYS.other("EHOSTUNREACH")).toBe("not done: the request to Keeper's service failed (EHOSTUNREACH); whether the check ran is unknown: read Keeper's log for \"backup check passed\" or \"backup check FAILED\"");
    expect([requestCause({ code: "ECONNREFUSED" }), requestCause({ code: "ECONNRESET" }), requestCause({ name: "TimeoutError", code: 23 }), requestCause({})]).toEqual(["refused", "stopped", "timeout", "no code"]);
  });
  test("DOCS: device check 15 runs under a memory hog, on an all-zero image and with the service stopped mid-scan; the follow-ups noted", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    for (const l of ["a memory hog (dd)", "the kernel's out-of-memory killer", "an all-zero high-ratio image", "stopped mid-scan", "no orphaned child, temp file or sentinel", "each run's peak memory and duration",
      "a cgroup memory limit", "the download's cap from free disk", BACKUP_CHECK_SAYS.busy]) expect([l, docs.includes(l)]).toEqual([l, true]);
  });
});
