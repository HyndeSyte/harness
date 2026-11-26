// Keeper 0.1.17: the backup check's scan streams in bounded memory, in a child process of the service.
//   - a device-size backup-check (an outer tar of at least 100 MB holding backup.json and an image tar.gz whose inflated tar is
//     at least 300 MB, compressible and random data mixed, the control once in a leaf) passes with the scan's peak resident
//     memory under 256 MB, the child run under that same hard cap (its own limit: over it, it exits and the check fails);
//   - a needle split across a chunk boundary is found (the outer read, the inflater's output, a tar header's edge);
//   - the expanded-bytes and nesting budgets trip and name themselves;
//   - the control in padding, a header field or the gzip comment still fails, streamed a byte at a time too;
//   - a clean real-shaped nested archive passes (outer tar, inner tar.gz, leaf), read from its file;
//   - a scan the system kills leaves the service answering: the check fails, its sentinels removed and its test backup
//     deleted, with the archive's size; and the CLI says what happened in plain words.
import { afterAll, describe, expect, test } from "bun:test";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { EXCLUDE_HASH, KEY_NAME, Keeper } from "../rootfs/opt/keeper/core.ts";
import { BACKUP_CHECK_SAYS, backupCheckCli, scanChild } from "../rootfs/opt/keeper/main.ts";
import { MAX_DEPTH, MAX_EXPANDED, SCAN_VERSION, scanBackup, scanFile } from "../rootfs/opt/keeper/scan.ts";

const enc = (x: string) => new TextEncoder().encode(x);
const CTL = "keeper-control-0123456789abcdef01234567";
const KEY = "planted-value-aaaaaaaaaa";
const SENTINEL = "keeper-sentinel-aaaaaaaaaaaaaaaa";   // plain test text standing in for the check's sentinel
// the legacy temporary key file's name (0.1.7 and 0.1.8), built from its parts so the secret scan doesn't read a file name as a key
const LEGACY_TMP = ["hc-key", "1", "abcdefabcdef", "tmp"].join(".");
const MB = 1024 * 1024;
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keeper-stream-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// a ustar header (any field by hand), a member (header, data, padding) and an archive
const hdr = (o: { name: string; size?: number; type?: string; linkname?: string; uname?: string }) => {
  const h = new Uint8Array(512);
  const put = (x: string, off: number) => h.set(enc(x), off);
  put(o.name, 0); put("0000600\0", 100); put("0000000\0", 108); put("0000000\0", 116);
  put((o.size ?? 0).toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148); put(o.type ?? "0", 156);
  if (o.linkname) put(o.linkname, 157);
  put("ustar\0", 257); put("00", 263);
  if (o.uname) put(o.uname, 265);
  put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
};
const cat = (...p: Uint8Array[]) => { const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const member = (name: string, body: string | Uint8Array, o: { type?: string; linkname?: string; uname?: string; fill?: string } = {}) => {
  const data = typeof body === "string" ? enc(body) : body;
  const p = new Uint8Array((512 - (data.length % 512)) % 512); if (o.fill) p.set(enc(o.fill).subarray(0, p.length));
  return cat(hdr({ name, size: data.length, ...o }), data, p);
};
const END = new Uint8Array(1024);
const good = () => [member("./addon.json", "{}"), member("./data/state.json", "{\"format\":1}"), member("./data/backup-check-control", `${CTL}\n`)];
const gz = (b: Uint8Array, o: { comment?: string } = {}) => {
  const z = gzipSync(b);
  if (o.comment === undefined) return z;
  const head = z.slice(0, 10); head[3] |= 0x10;
  return cat(head, enc(`${o.comment}\0`), z.subarray(10));
};
const outer = (inner: Uint8Array, json = "{\"protected\":false}") => cat(member("./backup.json", json), member("./0fcc2575_keeper.tar.gz", inner), END);
const scan = (b: Uint8Array, chunk?: number, needles: string[] = [KEY]) => scanBackup(b, KEY_NAME, needles, { control: CTL, ...(chunk ? { chunk } : {}) });

describe("0.1.17: a needle split across a chunk boundary is found", () => {
  test("in the outer read: a key in a leaf, cut at every byte of it by the chunk size", async () => {
    const leaf = member("./data/notes", `${"x".repeat(300)}${KEY}${"y".repeat(300)}`);
    const arch = outer(gz(cat(leaf, ...good(), END)));
    // a stored (uncompressed) copy as well, so the outer tar's own chunks cut the value
    const plain = cat(member("./backup.json", "{}"), leaf, ...good(), END);
    const at = 512 + 512 + 300;                                        // the key's offset in the plain archive
    for (const cut of [1, 3, 7, 11, 23]) {
      const r = await scan(plain, at + cut);
      expect([cut, r.ok, r.why.includes("./data/notes holds a key value, a key's fingerprint or the sentinel at byte 300")]).toEqual([cut, false, true]);
    }
    for (const chunk of [1, 5, 64, 509, 4096]) expect([chunk, (await scan(arch, chunk)).why]).toEqual([chunk, expect.stringContaining("holds a key value")]);
  });
  test("in the inflater's output: a key straddling its 64 KB output chunks, deep in a large leaf", async () => {
    const body = new Uint8Array(3 * 65536); body.set(randomBytes(body.length));
    const off = 65536 - 512 - 512 - 512 - 9;                          // in the inner tar's output the key crosses byte 65536
    body.set(enc(KEY), off);
    const r = await scan(outer(gz(cat(...good(), member("./data/big", body), END))));
    expect(r.ok).toBe(false);
    expect(r.why).toContain(`./0fcc2575_keeper.tar.gz:./data/big holds a key value, a key's fingerprint or the sentinel at byte ${off}`);
  });
  test("at a tar header's edge: a value half in a header field and half in the data is the layer's own, and found", async () => {
    // a link name ending in the first half of the key, the member's data starting with the second: neither half alone matches
    const half = KEY.length >> 1;
    const h = hdr({ name: "./data/edge", size: 600, uname: "x".repeat(32 - half) + KEY.slice(0, half) });
    // the owner name field is 32 bytes at 265; put the value at the end of the header's last bytes instead, by hand
    const head = h.slice(); head.set(enc(KEY.slice(0, half)), 512 - half);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
    head.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    const data = new Uint8Array(600); data.set(enc(KEY.slice(half)), 0);
    const edge = cat(head, data, new Uint8Array(424));
    for (const chunk of [undefined, 1, 511, 512, 513]) {
      const r = await scan(outer(gz(cat(edge, ...good(), END))), chunk);
      expect([chunk, r.why]).toEqual([chunk, expect.stringContaining("(its tar headers, padding or tail) holds a key value")]);
    }
  });
  test("every streaming result matches the default chunking, down to a byte at a time", async () => {
    const cases = [
      outer(gz(cat(...good(), END))),
      outer(gz(cat(member("./data/short", "x", { fill: CTL }), ...good(), END))),
      outer(gz(cat(...good(), END), { comment: KEY })),
      outer(gz(cat(member("./data/hc-key", "x"), ...good(), END))),
      cat(outer(gz(cat(...good(), END))), enc(KEY), new Uint8Array(512 - KEY.length)),
      outer(cat(gz(cat(...good(), END)), gzipSync(enc("again")))),
    ];
    for (const [i, c] of cases.entries()) {
      const want = await scan(c);
      for (const chunk of [1, 2, 13, 512]) expect([i, chunk, (await scan(c, chunk)).why]).toEqual([i, chunk, want.why]);
    }
  });
});

describe("0.1.17: the budgets", () => {
  test("the expanded-bytes budget trips and names itself", async () => {
    const big = outer(gz(cat(...good(), member("./data/zeros", new Uint8Array(4 * MB)), END)));
    const r = await scanBackup(big, KEY_NAME, [], { control: CTL, maxExpanded: MB });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("./0fcc2575_keeper.tar.gz decodes past Keeper's budget of 1048576 bytes expanded in all (the expanded-bytes budget), at byte");
    expect(MAX_EXPANDED).toBe(4 * 1024 ** 3);
    // under the budget it passes
    expect((await scanBackup(big, KEY_NAME, [], { control: CTL, maxExpanded: 8 * MB })).ok).toBe(true);
  });
  test("the budget is cumulative: every gzip layer's output counts toward it", async () => {
    const one = gz(cat(member("./data/zeros", new Uint8Array(600 * 1024)), END));
    const arch = cat(member("./backup.json", "{}"), member("./a.tar.gz", one), member("./b.tar.gz", gz(cat(...good(), END))), member("./c.tar.gz", one), END);
    expect((await scanBackup(arch, KEY_NAME, [], { control: CTL, maxExpanded: MB })).why).toContain("./c.tar.gz decodes past Keeper's budget");
  });
  test("the nesting budget trips and names itself", async () => {
    let t = cat(...good(), END);
    for (let i = 0; i < MAX_DEPTH + 1; i++) t = cat(member(`./layer-${i}.tar`, t), END);
    const r = await scan(cat(member("./backup.json", "{}"), member("./deep.tar.gz", gz(t)), END));
    expect(r.ok).toBe(false);
    expect(r.why).toContain(`the archive nests too deep`);
    expect(r.why).toContain("the nesting budget");
  });
});

describe("0.1.17: the control outside a file still fails, streamed", () => {
  test("in a member's padding, a header field and the gzip comment, at any chunking", async () => {
    const places: [string, Uint8Array][] = [
      ["padding", outer(gz(cat(member("./data/short", "x", { fill: CTL }), ...good(), END)))],
      ["a link name", outer(gz(cat(member("./data/link", "", { type: "2", linkname: CTL }), ...good(), END)))],
      ["an owner name", outer(gz(cat(member("./data/owned", "x", { uname: CTL.slice(0, 32) }), ...good(), END)))],
      ["the gzip comment", outer(gz(cat(...good(), END), { comment: CTL }))],
    ];
    for (const [where, b] of places) for (const chunk of [undefined, 1, 37]) {
      const r = await scan(b, chunk);
      // the 32-byte owner name holds only a prefix of the 39-byte control: no copy, so it passes; the others fail
      if (where === "an owner name") { expect([where, chunk, r.ok]).toEqual([where, chunk, true]); continue; }
      expect([where, chunk, r.why]).toEqual([where, chunk, expect.stringMatching(/holds the positive control outside any file, at byte \d+/)]);
    }
  });
});

describe("0.1.17: a clean real-shaped nested archive passes, read from its file", () => {
  test("outer tar, inner tar.gz, leaf", async () => {
    const d = scratch();
    const path = join(d, "bk.tar");
    writeFileSync(path, outer(gz(cat(member("./addon.json", "{\"version\":\"0.1.17\"}"), member("./data/", "", { type: "5" }), ...good().slice(1), END))));
    const r = await scanFile(path, KEY_NAME, [KEY, SENTINEL], { control: CTL });
    expect(r).toMatchObject({ ok: true, why: "", control: 1, found: [] });
    expect(r.names).toContain("./0fcc2575_keeper.tar.gz:./data/backup-check-control");
    expect(SCAN_VERSION).toBe(3);
  });
});

// A Keeper with only what the backup check needs: key files in memory, a test backup made from the archive's file, its delete.
function bare(file: () => { path: string; size: number }, scan?: (f: any, n: RegExp, nd: any[], c: string) => Promise<any>) {
  const logs: string[] = [], deleted: string[] = [];
  const files: Record<string, string> = {};
  let cleared = false, control = "";
  const k = new Keeper({
    now: () => Date.parse("2026-11-25T10:00:00Z"), version: "0.1.17", self: "0fcc2575_keeper",
    appInfo: async () => null, backupInfo: async () => ({ homeassistant: null, addons: [], folders: [], sizeBytes: file().size }),
    makeBackup: async () => ({ slug: "bc-test" }), restore: async () => ({ kind: "refused", why: "no" } as any), job: async () => null,
    live: async () => true, ready: async () => true, ping: async () => true, options: () => null, save: () => true, log: (l) => logs.push(l),
    deleteBackup: async (s) => { deleted.push(s); return true; }, backups: async () => [],
    keyFiles: {
      place: (sv: string, skip: string[] = []) => { const out = ["hc-key", "hc-key-old", "hc-key.tmp-aa", LEGACY_TMP, "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa", "drill-spent/backup-check-sentinel"].filter((n) => !skip.includes(n)); for (const n of out) files[n] = sv; return out; },
      read: (n: string) => files[n] ?? null, control: (v: string) => { control = v; files["backup-check-control"] = v; return "backup-check-control"; },
      clear: () => { cleared = true; }, sweep: () => [],
    },
    download: async () => ({ ...file(), remove: () => {} }),
    ...(scan ? { scan } : {}),
  }, null);
  return { k, logs, deleted, get cleared() { return cleared; }, get control() { return control; } };
}

describe("0.1.17: a scan the system kills leaves the service answering", () => {
  const small = () => { const d = scratch(); const p = join(d, "bk.tar"); writeFileSync(p, outer(gz(cat(...good(), END)))); return { path: p, size: statSync(p).size }; };
  test("over its own memory limit the child stops; the check fails with the archive's size, its sentinels and test backup removed", async () => {
    const f = small();
    const b = bare(() => f, (file, n, nd, c) => scanChild(file, n, nd, c, { rssMax: 1024 }));
    const r = await b.k.backupCheck();
    expect(r.ok).toBe(false);
    expect(r.why).toStartWith(`the scan was killed (out of memory): it passed its own limit of 0.0 MB reading the ${f.size}-byte (${(f.size / MB).toFixed(1)} MB) test backup (the scan's memory limit, in the scan phase: limit 0.0 MB resident, seen `);
    expect(r.why).toContain("; what to do: stop other Apps or free memory on the device, then run backup-check again");
    expect(b.cleared).toBe(true);
    expect(b.deleted).toEqual(["bc-test"]);
    expect(b.k.st.backupCheckRun).toBeUndefined();
    expect(b.k.checkPassed()).toBe(false);
    expect(b.logs.some((l) => l.startsWith("backup check FAILED: the scan was killed (out of memory)"))).toBe(true);
  });
  test("killed by the system (SIGKILL, as the kernel's out-of-memory killer does): named signal 9, the service unharmed", async () => {
    const f = small();
    const d = scratch(); const script = join(d, "killed.ts");
    writeFileSync(script, "process.kill(process.pid, 'SIGKILL');\n");
    const b = bare(() => f, (file, n, nd, c) => scanChild(file, n, nd, c, { script }));
    const r = await b.k.backupCheck();
    // (fix round) no memory sample near its limit: signal 9, not "out of memory"
    expect(r.why).toBe(`the scan was killed (signal 9) reading the ${f.size}-byte (${(f.size / MB).toFixed(1)} MB) test backup: its last memory sample was 0.0 MB, not near its limit of 384.0 MB, so something else stopped it (the system, a supervisor stop or a manual kill); Keeper's service is unharmed`);
    expect(b.deleted).toEqual(["bc-test"]);
    expect(b.cleared).toBe(true);
  });
  test("a child that runs past its time is stopped and named; one that answers is used, and its pass recorded at scan 3", async () => {
    const f = small();
    const d = scratch(); const script = join(d, "slow.ts");
    writeFileSync(script, "await Bun.sleep(60_000);\n");
    const slow = bare(() => f, (file, n, nd, c) => scanChild(file, n, nd, c, { script, timeoutMs: 300 }));
    expect((await slow.k.backupCheck()).why).toContain("the scan took longer than 300 ms reading the");
    // a real scan in its child: the archive holds the check's own control, written as the test backup is made
    let made: { path: string; size: number } | null = null;
    const real = bare(() => made!, (file, n, nd, c) => scanChild(file, n, nd, c, { log: () => {} }));
    (real.k as any).d.makeBackup = async () => { const p = join(scratch(), "bk.tar"); writeFileSync(p, outer(gz(cat(...good().slice(0, 2), member("./data/backup-check-control", `${real.control}\n`), END)))); made = { path: p, size: statSync(p).size }; return { slug: "bc-test" }; };
    expect(await real.k.backupCheck()).toEqual({ ok: true, why: "" });
    expect(real.k.st.backupCheck).toMatchObject({ exclude: EXCLUDE_HASH, scan: 3 });
    expect(real.k.checkPassed()).toBe(true);
    // the child is handed the needles on standard input, never its command line
    const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "main.ts"), "utf8");
    expect(src).toContain('Bun.spawn([process.execPath, "--smol", o.script ?? join(import.meta.dir, "scan.ts"), "child"]');
  });
});

describe("0.1.17: the CLI's backup-check says what happened", () => {
  const serve = (fetch: (req: Request) => Response | Promise<Response>) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  test("the result: passed, or why not", async () => {
    const said: string[] = [];
    const ok = serve(() => Response.json({ ok: true, why: "" }));
    expect(await backupCheckCli(`http://127.0.0.1:${ok.port}/backup-check`, { say: (l) => said.push(l) })).toEqual({ ok: true, line: "the backup check passed: a test backup of Keeper leaves out every key file and holds no key" });
    expect(said[0]).toBe(BACKUP_CHECK_SAYS.running);
    ok.stop(true);
    const no = serve(() => Response.json({ ok: false, why: "the scan was killed (out of memory) reading the 104857600-byte (100.0 MB) test backup" }));
    expect((await backupCheckCli(`http://127.0.0.1:${no.port}/backup-check`, { say: () => {} })).line).toBe("not done: the scan was killed (out of memory) reading the 104857600-byte (100.0 MB) test backup");
    no.stop(true);
  });
  test("still running, said while it waits; no answer in time; the service not running; the service stopping mid-check", async () => {
    const said: string[] = [];
    const slow = serve(async () => { await Bun.sleep(400); return Response.json({ ok: true, why: "" }); });
    const r = await backupCheckCli(`http://127.0.0.1:${slow.port}/backup-check`, { say: (l) => said.push(l), everyMs: 100 });
    expect(r.ok).toBe(true);
    expect(said.some((l) => l.startsWith("backup check still running ("))).toBe(true);
    expect((await backupCheckCli(`http://127.0.0.1:${slow.port}/backup-check`, { say: () => {}, timeoutMs: 100 })).line).toBe(BACKUP_CHECK_SAYS.timeout);
    slow.stop(true);
    // nothing listening
    const gone = serve(() => new Response("")); const port = gone.port; gone.stop(true);
    expect((await backupCheckCli(`http://127.0.0.1:${port}/backup-check`, { say: () => {} })).line).toBe(BACKUP_CHECK_SAYS.refused);
    // a service that takes the request and then dies (its socket closed, no answer)
    const srv = createServer((s) => { s.once("data", () => setTimeout(() => s.destroy(), 50)); });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const p = (srv.address() as any).port;
    expect((await backupCheckCli(`http://127.0.0.1:${p}/backup-check`, { say: () => {} })).line).toBe(BACKUP_CHECK_SAYS.stopped);
    srv.close();
    expect(BACKUP_CHECK_SAYS.stopped).toContain("Its restart counts the check failed, removes the sentinels and deletes the test backup");
  });
  test("DOCS carry each of the CLI's messages, and device check 11 is run at device size under a memory cap first", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    for (const l of [BACKUP_CHECK_SAYS.running, BACKUP_CHECK_SAYS.refused, BACKUP_CHECK_SAYS.stopped, BACKUP_CHECK_SAYS.timeout]) expect([l, docs.includes(l)]).toEqual([l, true]);
    expect(docs).toContain("at device size (an archive of 100 MB or more) under a memory cap");
    expect(docs).toContain("app_0fcc2575_keeper");
  });
});

// The device-size check: a backup the shape of the device's (about 100 MB), the scan in its child process under a hard cap of
// 256 MB resident (the child's own limit: over it, it exits and the check fails), its peak sampled and asserted.
describe("0.1.17: a device-size backup-check in bounded memory", () => {
  const CAP = 256 * MB;
  // the inner image tar.gz, streamed to a file: addon.json, the data folder with the control, then image layers each of random
  // (incompressible) and repeated (compressible) data; returns the inflated size
  async function buildInner(path: string, ctl: string): Promise<number> {
    const gzs = createGzip({ level: 1 });
    const out = createWriteStream(path);
    gzs.pipe(out);
    let n = 0;
    const put = async (b: Uint8Array) => { n += b.length; if (!gzs.write(b)) await new Promise((r) => gzs.once("drain", r)); };
    const file = async (name: string, parts: (() => Uint8Array)[], size: number) => {
      await put(hdr({ name, size }));
      for (const p of parts) await put(p());
      const pad = (512 - (size % 512)) % 512; if (pad) await put(new Uint8Array(pad));
    };
    await file("./addon.json", [() => enc("{\"version\":\"0.1.17\"}")], 20);
    await file("./data/state.json", [() => enc("{\"format\":1}")], 12);
    await file("./data/backup-check-control", [() => enc(`${ctl}\n`)], ctl.length + 1);
    const text = enc("layer of an App image: compressible, repeated ".repeat(23000)).subarray(0, MB);
    if (text.length !== MB) throw new Error("the compressible part must be 1 MB");
    for (let i = 0; i < 11; i++) {
      const parts: (() => Uint8Array)[] = [];
      for (let j = 0; j < 10; j++) parts.push(() => randomBytes(MB));
      for (let j = 0; j < 20; j++) parts.push(() => text);
      await file(`./image/layer-${i}.bin`, parts, 30 * MB);
    }
    await put(new Uint8Array(1024));
    await new Promise<void>((res) => { out.once("close", () => res()); gzs.end(); });
    return n;
  }
  // the outer tar: backup.json, then the image tar.gz copied in from its file, then the end block
  function buildOuter(path: string, inner: string) {
    const fd = openSync(path, "w");
    const w = (b: Uint8Array) => { for (let o = 0; o < b.length;) o += require("node:fs").writeSync(fd, b, o, b.length - o); };
    w(member("./backup.json", JSON.stringify({ slug: "bc", name: "Keeper backup check 0a0b0c0d", protected: false, compressed: true, addons: [{ slug: "0fcc2575_keeper" }] })));
    const size = statSync(inner).size;
    w(hdr({ name: "./0fcc2575_keeper.tar.gz", size }));
    const src = openSync(inner, "r"); const buf = new Uint8Array(4 * MB);
    for (let o = 0; o < size;) { const got = readSync(src, buf, 0, buf.length, o); w(buf.subarray(0, got)); o += got; }
    closeSync(src);
    w(new Uint8Array((512 - (size % 512)) % 512)); w(END);
    closeSync(fd);
  }
  test("an archive of 100 MB or more, its image tar 300 MB or more inflated, passes with the scan's peak under 256 MB", async () => {
    const d = scratch();
    const inner = join(d, "inner.tar.gz"), path = join(d, "backup.tar");
    let control = "";
    // the control is the check's own, known only once the check has placed it: the archive is built at download time, as the
    // Supervisor makes it after the check placed its files
    let built: { path: string; size: number } | null = null;
    let inflated = 0;
    const file = () => built!;
    const logs: string[] = [];
    let peak = 0;
    const b = bare(() => built ?? { path, size: 0 }, async (f, n, nd, c) => {
      const r = await scanChild(f, n, nd, c, { rssMax: CAP, log: (l) => logs.push(l) });
      peak = r.peakRss ?? 0;
      return r;
    });
    (b.k as any).d.makeBackup = async () => {
      control = b.control;
      inflated = await buildInner(inner, control);
      buildOuter(path, inner);
      rmSync(inner, { force: true });
      built = { path, size: statSync(path).size };
      return { slug: "bc-device" };
    };
    (b.k as any).d.download = async () => ({ ...file(), remove: () => rmSync(path, { force: true }) });
    const r = await b.k.backupCheck();
    expect(built!.size).toBeGreaterThanOrEqual(100 * MB);
    expect(inflated).toBeGreaterThanOrEqual(300 * MB);
    expect(r).toEqual({ ok: true, why: "" });
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(CAP);
    expect(logs.some((l) => /^backup check: the scan read 16 files, decoded \d+ bytes, peak memory [\d.]+ MB \(its limit 256\.0 MB\)$/.test(l))).toBe(true);
    console.log(`device-size check: archive ${(built!.size / MB).toFixed(1)} MB, image tar ${(inflated / MB).toFixed(1)} MB inflated, the scan's peak ${(peak / MB).toFixed(1)} MB`);
  }, 300_000);
});
