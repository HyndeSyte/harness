// Keeper 0.1.17, the last fix round (the review of pull request 58 at cd86741): one test group per item.
//   1. a test backup the host finishes after the check gave up on it is found and deleted, the single-flight slot held until the
//      cleanup is done, the cleanup's bound named, and the next start's sweep of test backups;
//   2. the inflater's end clock never fires on a healthy stream paused by a slow layer below;
//   3. memory samples parsed apart from stderr's capped text;
//   4. exactly-once reporting with no blind spot: pax, long-name and long-link data, straddles, nested raw and inflated hits;
//   5. the child's process group killed whole, and the oom_score_adj ask never fatal;
//   6. the memory bound stated, pinned, and run at the deepest nesting under the 256 MB cap; DOCS.
import { afterAll, describe, expect, jest, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { BACKUP_CHECK_BUSY, CHECK_CLEANUP_MS, CHECK_DEADLINE_MS, CHECK_SETTLE_MS, KEY_NAME, Keeper, LATE_KEEP_MS, LATE_POLL_MS, REGISTER_WAIT_MS, TEST_BACKUP_NAME } from "../rootfs/opt/keeper/core.ts";
import { BACKUP_CHECK_CLI_MARGIN_MS, BACKUP_CHECK_CLI_MS, SCAN_ERR_MAX, scanChild } from "../rootfs/opt/keeper/main.ts";
import { DEFLATE_MAX_RATIO, END_DUE_MS, INFLATE_IN, MAX_DEPTH, MAX_RECORD, MEMORY_BOUND, gzipMember, preferOomKill, scanBackup } from "../rootfs/opt/keeper/scan.ts";

const enc = (x: string) => new TextEncoder().encode(x);
const CTL = "keeper-control-0123456789abcdef01234567";
const KEY = "planted-value-aaaaaaaaaa";
const MB = 1024 * 1024;
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keeper-last-")); dirs.push(d); return d; };
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
const member = (name: string, body: string | Uint8Array, o: { type?: string; fill?: string } = {}) => {
  const data = typeof body === "string" ? enc(body) : body;
  const p = new Uint8Array((512 - (data.length % 512)) % 512); if (o.fill) p.set(enc(o.fill.repeat(512)).subarray(0, p.length));
  return cat(hdr({ name, size: data.length, type: o.type }), data, p);
};
const END = new Uint8Array(1024);
const good = () => [member("./addon.json", "{}"), member("./data/state.json", "{\"format\":1}"), member("./data/backup-check-control", `${CTL}\n`)];
const outer = (inner: Uint8Array) => cat(member("./backup.json", "{\"protected\":false}"), member("./0fcc2575_keeper.tar.gz", inner), END);
const fileOf = (b: Uint8Array) => { const p = join(scratch(), "bk.tar"); writeFileSync(p, b); return { path: p, size: b.length, remove: () => rmSync(p, { force: true }) }; };
const script = (src: string) => { const p = join(scratch(), "child.ts"); writeFileSync(p, src); return p; };
const small = () => fileOf(outer(gzipSync(cat(...good(), END))));
const OF = (f: { size: number }) => `the ${f.size}-byte (${(f.size / MB).toFixed(1)} MB) test backup`;
const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };

// -- item 1 -----------------------------------------------------------------------------------------------------------------------
const LEGACY_TMP = ["hc-key", "1", "abcdefabcdef", "tmp"].join(".");
// A Keeper with only what the backup check needs; the host's backups list and the create are the test's to drive
function rig(o: { make?: (name: string) => Promise<any>; list?: () => { slug: string; name: string }[]; del?: (slug: string) => Promise<boolean>; download?: () => Promise<any>; saved?: unknown } = {}) {
  const logs: string[] = [], deleted: string[] = [];
  const files: Record<string, string> = {};
  let name = "", saved: any = o.saved ?? null;
  const k = new Keeper({
    now: () => Date.parse("2026-11-25T10:00:00Z"), version: "0.1.17", self: "0fcc2575_keeper",
    appInfo: async () => null, backupInfo: async () => ({ homeassistant: null, addons: [], folders: [], sizeBytes: 0 }),
    makeBackup: async (_app: string, n: string) => { name = n; return o.make ? o.make(n) : { slug: "bc-test" }; },
    restore: async () => ({ kind: "refused", why: "no" } as any), job: async () => null,
    live: async () => true, ready: async () => true, ping: async () => true, options: () => null, save: (st: any) => { saved = JSON.parse(JSON.stringify(st)); return true; }, log: (l) => logs.push(l),
    deleteBackup: async (sl) => { const ok = o.del ? await o.del(sl) : true; if (ok) deleted.push(sl); return ok; }, backups: async () => (o.list ? o.list() : []),
    keyFiles: {
      place: (sv: string, skip: string[] = []) => { const out = ["hc-key", "hc-key-old", "hc-key.tmp-aa", LEGACY_TMP, "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa", "drill-spent/backup-check-sentinel"].filter((n) => !skip.includes(n)); for (const n of out) files[n] = sv; return out; },
      read: (n: string) => files[n] ?? null, control: (v: string) => { files["backup-check-control"] = v; return "backup-check-control"; },
      clear: () => {}, sweep: () => [],
    },
    download: o.download ?? (async () => null),
  }, o.saved ?? null);
  return { k, logs, deleted, get name() { return name; }, get saved() { return saved; } };
}
const settle = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
// fake time moved on a second at a time, the promises settled between
async function pass(ms: number) { for (let t = 0; t < ms; t += 1000) { jest.advanceTimersByTime(Math.min(1000, ms - t)); await settle(); } }

describe("item 1: a late test backup is cleaned up, and the slot is held until the cleanup is done", () => {
  test("the arithmetic: the deadline plus the cleanup's bound stays under the CLI's 10-minute wait with a margin", () => {
    expect(CHECK_DEADLINE_MS).toBe(8 * 60_000);
    expect(CHECK_CLEANUP_MS).toBe(60_000);
    expect(BACKUP_CHECK_CLI_MS).toBe(10 * 60_000);
    expect(CHECK_DEADLINE_MS + CHECK_CLEANUP_MS + BACKUP_CHECK_CLI_MARGIN_MS).toBeLessThanOrEqual(BACKUP_CHECK_CLI_MS);
    expect(BACKUP_CHECK_CLI_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
    // the wait for outstanding work leaves the delete and the late search room inside the bound, polled several times
    expect(CHECK_SETTLE_MS).toBeLessThan(CHECK_CLEANUP_MS / 2);
    expect(LATE_POLL_MS * 4).toBeLessThanOrEqual(CHECK_CLEANUP_MS - CHECK_SETTLE_MS);
    // the create's own bound is inside the deadline
    expect(REGISTER_WAIT_MS).toBeLessThan(CHECK_DEADLINE_MS);
  });
  test("a create that gives up (its 4-minute bound) and a backup the host finishes after it: found by its name and deleted; a second request meanwhile is busy (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      let shown = false;
      const r = rig({
        make: () => new Promise((res) => setTimeout(() => res({ why: "TimeoutError" }), REGISTER_WAIT_MS)),
        list: () => (shown ? [{ slug: "owner-1", name: "Automatic backup" }, { slug: "late-1", name: r.name }] : [{ slug: "owner-1", name: "Automatic backup" }]),
      });
      const p = r.k.backupCheck();
      let answer: any = null; void p.then((x) => { answer = x; });
      await settle();
      expect(r.name).toMatch(TEST_BACKUP_NAME);
      await pass(REGISTER_WAIT_MS);
      // the create has given up; the check is cleaning up, and the slot is still held
      expect(answer).toBeNull();
      expect(await r.k.backupCheck()).toEqual({ ok: false, why: BACKUP_CHECK_BUSY });
      await pass(12_000);
      expect(answer).toBeNull();
      expect(await r.k.backupCheck()).toEqual({ ok: false, why: BACKUP_CHECK_BUSY });
      // the host finishes the backup now: the next look finds it and deletes it
      shown = true;
      await pass(LATE_POLL_MS + 1000);
      expect(answer).not.toBeNull();
      expect(answer.ok).toBe(false);
      expect(answer.why).toStartWith("the test backup couldn't be made (TimeoutError); its test backup late-1, made on the host after the check gave up on it, was found and deleted");
      expect(r.deleted).toEqual(["late-1"]);
      expect(r.k.st.backupCheckRun).toBeUndefined();
      expect(r.logs).toContain(`backup check: the test backup late-1 ("${r.name}") was made on the host after the check gave up on it: found and deleted`);
      // the slot is free again once everything has settled
      shown = false;
      const again = r.k.backupCheck();
      await settle();
      expect(r.name).toMatch(TEST_BACKUP_NAME);
      await pass(REGISTER_WAIT_MS + CHECK_CLEANUP_MS + 1000);
      expect((await again).why).not.toBe(BACKUP_CHECK_BUSY);
    } finally { jest.useRealTimers(); }
  });
  test("a create that runs past the 8-minute deadline: the slot is held while it is outstanding, and a slug it answers late is deleted (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      let answerMake: (v: any) => void = () => {};
      const r = rig({ make: () => new Promise((res) => { answerMake = res; }) });
      const p = r.k.backupCheck();
      let answer: any = null; void p.then((x) => { answer = x; });
      await settle();
      await pass(CHECK_DEADLINE_MS);
      expect(answer).toBeNull();
      await pass(CHECK_CLEANUP_MS);
      // answered within the deadline and the cleanup's bound, naming the leftover
      expect(answer).not.toBeNull();
      expect(answer.why).toStartWith("the backup check ran past its deadline of 8 minutes while making the test backup");
      expect(answer.why).toContain(`the test backup "${r.name}" may still be on the host: it wasn't found within the cleanup's bound of 60 seconds; Keeper deletes it when it shows (each poll for 60 minutes, and at every start), or delete it by hand in Settings, System, Backups`);
      // the create is still outstanding: the slot stays held
      expect(await r.k.backupCheck()).toEqual({ ok: false, why: BACKUP_CHECK_BUSY });
      // it answers with a slug at last: that backup is deleted, and the slot is free
      answerMake({ slug: "very-late" });
      await settle(); await pass(1000);
      expect(r.deleted).toEqual(["very-late"]);
      expect(r.k.st.backupCheckRun).toBeUndefined();
      expect(r.logs).toContain("backup check: test backup very-late deleted after the check");
      const next = r.k.backupCheck();
      await settle();
      answerMake({ slug: "bc-2" });
      await settle();
      await pass(CHECK_DEADLINE_MS + CHECK_CLEANUP_MS);
      expect((await next).why).not.toBe(BACKUP_CHECK_BUSY);
    } finally { jest.useRealTimers(); }
  });
  test("the cleanup's bound trips: the leftover is named, its record kept as late; polls keep looking; the next start deletes it (fake timers)", async () => {
    jest.useFakeTimers();
    let r: ReturnType<typeof rig>;
    try {
      r = rig({ make: () => new Promise((res) => setTimeout(() => res({ why: "AbortError" }), 1000)) });
      const p = r.k.backupCheck();
      await settle();
      await pass(1000 + CHECK_CLEANUP_MS + 1000);
      const a = await p;
      expect(a.why).toBe(`the test backup couldn't be made (AbortError); the test backup "${r.name}" may still be on the host: it wasn't found within the cleanup's bound of 60 seconds; Keeper deletes it when it shows (each poll for 60 minutes, and at every start), or delete it by hand in Settings, System, Backups`);
      expect(r.k.st.backupCheckRun).toMatchObject({ name: r.name, late: true });
      expect(r.logs.some((l) => l.startsWith(`backup check: the test backup "${r.name}" wasn't found within the cleanup's 60 seconds: it may be on the host`))).toBe(true);
    } finally { jest.useRealTimers(); }
    // a poll that still doesn't see it keeps the record (late, under LATE_KEEP_MS)
    expect(await r!.k.leftoverCheck("a poll")).toBe("");
    expect(r!.k.st.backupCheckRun).toMatchObject({ late: true });
    expect(r!.k.checkPassed()).toBe(false);
    expect(LATE_KEEP_MS).toBe(60 * 60_000);
    // the next start (a new Keeper from the saved state): the host's backup is there now, by its name, and is deleted
    const name = r!.name;
    const next = rig({ saved: r!.saved, list: () => [{ slug: "late-2", name }, { slug: "owner-1", name: "Automatic backup" }] });
    expect(await next.k.leftoverCheck("at start")).toBe("");
    expect(next.deleted).toEqual(["late-2"]);
    expect(next.k.st.backupCheckRun).toBeUndefined();
  });
  test("the start's sweep deletes any backup named like a test backup, recorded or not; never an owner's or an install's backup", async () => {
    const r = rig({ list: () => [{ slug: "orphan-1", name: "Keeper backup check 0a1b2c3d" }, { slug: "owner-1", name: "Automatic backup" }, { slug: "att-1", name: "Keeper att-1 0a1b2c3d" }, { slug: "near", name: "Keeper backup check 0a1b2c3d copy" }] });
    expect(r.k.st.backupCheckRun).toBeUndefined();
    expect(await r.k.leftoverCheck("at start")).toBe("");
    expect(r.deleted).toEqual(["orphan-1"]);
    expect(r.logs).toContain(`at start: deleted the test backup orphan-1 ("Keeper backup check 0a1b2c3d") a backup check left behind`);
    // a poll alone, with no record, lists nothing and deletes nothing
    const q = rig({ list: () => { throw new Error("not listed"); } });
    expect(await q.k.leftoverCheck("a poll")).toBe("");
    expect(q.deleted).toEqual([]);
  });
  test("a definite refusal (a 4xx answer) made nothing: no late search, the answer at once", async () => {
    let looks = 0;
    const r = rig({ make: async () => ({ why: "400 backup already running" }), list: () => { looks++; return []; } });
    const a = await r.k.backupCheck();
    expect(a.why).toBe("the test backup couldn't be made (400 backup already running)");
    expect(looks).toBe(1);                  // the list before the create, and nothing after
  });
  test("a check that passes deletes its test backup and frees the slot at once, as before", async () => {
    const r = rig({ download: async () => ({ path: "/nonexistent", size: 0, remove: () => {} }) });
    (r.k as any).d.scan = async () => ({ ok: true, why: "", members: 3, names: [], found: [], control: 1 });
    expect(await r.k.backupCheck()).toEqual({ ok: true, why: "" });
    expect(r.deleted).toEqual(["bc-test"]);
    expect(r.k.checkPassed()).toBe(true);
    expect((await r.k.backupCheck()).why).not.toBe(BACKUP_CHECK_BUSY);
  });
});

// -- item 2 -----------------------------------------------------------------------------------------------------------------------
describe("item 2: the end clock never fires on a healthy stream paused by a slow layer below", () => {
  // 4 MB of zeros: about 4 KB of deflate, so nearly all of the output (64 chunks of 64 KB) comes from the piece the stream ends in
  const payload = new Uint8Array(4 * MB);
  const gz = gzipSync(payload, { level: 9 });
  test("a downstream layer pausing the inflater ten times the clock's bound in all, with the clock at 100 ms: it passes", async () => {
    const t0 = Date.now();
    const out = await gzipMember(gz, "slow", { slowMs: 20, endDueMs: 100 });
    expect(out.length).toBe(payload.length);
    expect(Date.now() - t0).toBeGreaterThan(10 * 100);
  }, 30_000);
  test("the real clock (10 seconds) with more than 10 seconds of pauses in all: it passes", async () => {
    expect(END_DUE_MS).toBe(10_000);
    const t0 = Date.now();
    const out = await gzipMember(gz, "slow", { slowMs: 170 });
    expect(out.length).toBe(payload.length);
    expect(Date.now() - t0).toBeGreaterThan(END_DUE_MS);
  }, 60_000);
  test("a cut-off stream still fails by name, the clock not involved", async () => {
    let w = "";
    try { await gzipMember(gz.subarray(0, gz.length - 12), "cut", { slowMs: 1, endDueMs: 100 }); w = "passed"; } catch (e) { w = String((e as Error).message); }
    expect(w).toContain("cut is a gzip that can't be read whole");
  });
});

// -- item 3 -----------------------------------------------------------------------------------------------------------------------
describe("item 3: memory samples parsed apart from stderr's capped text", () => {
  const RSS = 100 * MB;
  test("more than 4 KB of stderr before a final high sample: named likely out of memory", async () => {
    const f = small();
    const junk = "x".repeat(200);
    const src = `const fs = require("node:fs"); for (let i = 0; i < 20; i++) fs.writeSync(2, "rss ${10 * MB}\\n");
for (let i = 0; i < 60; i++) fs.writeSync(2, "${junk}\\n");
fs.writeSync(2, "rss ${95 * MB}\\n"); process.kill(process.pid, "SIGKILL");\n`;
    expect(60 * 201).toBeGreaterThan(SCAN_ERR_MAX * 2);
    const r = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script(src) });
    expect(r.why).toBe(`the scan was killed (signal 9) reading ${OF(f)}: likely out of memory, its last memory sample 95.0 MB near its limit of 100.0 MB; Keeper's service is unharmed`);
    expect(r.lastRss).toBe(95 * MB);
  }, 20_000);
  test("the peak is kept too: a high sample long before a lower last one, with 8 KB of stderr between, is still near the limit", async () => {
    const f = small();
    const src = `const fs = require("node:fs"); fs.writeSync(2, "rss ${96 * MB}\\n"); for (let i = 0; i < 80; i++) fs.writeSync(2, "${"y".repeat(100)}\\n");
fs.writeSync(2, "rss ${40 * MB}\\n"); process.kill(process.pid, "SIGKILL");\n`;
    const r = await scanChild(f, KEY_NAME, [], CTL, { rssMax: RSS, script: script(src) });
    expect(r.why).toBe(`the scan was killed (signal 9) reading ${OF(f)}: likely out of memory, its last memory sample 40.0 MB (its peak 96.0 MB) near its limit of 100.0 MB; Keeper's service is unharmed`);
  }, 20_000);
});

// -- item 4 -----------------------------------------------------------------------------------------------------------------------
const scan = (b: Uint8Array, needles: (string | { value: string; kind: string })[] = [KEY], chunk?: number, control = CTL) => scanBackup(b, KEY_NAME, needles, { control, ...(chunk ? { chunk } : {}) });
const tarOf = (...m: Uint8Array[]) => cat(...m, END);
// a gzip member with a name field (FNAME), around a raw deflate stream
const gzNamed = (payload: Uint8Array, fname: string) => {
  const t = new Uint8Array(8); const v = new DataView(t.buffer);
  v.setUint32(0, crc32(payload) >>> 0, true); v.setUint32(4, payload.length >>> 0, true);
  return cat(new Uint8Array([0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3]), enc(fname), new Uint8Array(1), deflateRawSync(payload), t);
};
describe("item 4: exactly-once reporting without a blind spot", () => {
  test("a needle inside pax data (extended and global), inside long-name data and inside long-link data: reported by the tar layer, once", async () => {
    for (const [what, m] of [
      ["a pax extended header", member("./PaxHeaders/x", `40 comment=${KEY}\n`, { type: "x" })],
      ["a pax global header", member("./GlobalHead", `40 comment=${KEY}\n`, { type: "g" })],
      ["a long name", member("././@LongLink", `./data/${KEY}-dir/file\0`, { type: "L" })],
      ["a long link", member("././@LongLink", `./data/${KEY}-target\0`, { type: "K" })],
    ] as [string, Uint8Array][]) {
      for (const chunk of [1, 7, 512, 65536]) {
        const r = await scan(outer(gzipSync(tarOf(...good(), m, member("./data/after", "plain")))), [KEY], chunk);
        expect([what, chunk, r.ok]).toEqual([what, chunk, false]);
        const hits = r.found.filter((x) => x.includes("(its tar headers, padding or tail)") && x.includes(GENERIC_KIND));
        expect([what, chunk, hits.length]).toEqual([what, chunk, 1]);
        expect(hits[0]).toStartWith("./0fcc2575_keeper.tar.gz (its tar headers, padding or tail) holds");
      }
    }
  });
  test("a long-link record is read as a record now, not refused as data", async () => {
    const r = await scan(outer(gzipSync(tarOf(...good(), member("././@LongLink", "./data/some-target\0", { type: "K" }), member("./data/x", "plain")))));
    expect(r).toMatchObject({ ok: true, control: 1 });
  });
  test("a key straddling a leaf's data end into its padding, overlapping a copy wholly inside the data: both reported, in their own layers", async () => {
    const Q = "Q".repeat(20);
    // the leaf's data ends with 20 Q's (one occurrence wholly inside), and its padding starts with Q's (occurrences crossing its end)
    const m = member("./data/q", `plain text ${Q}`, { fill: "Q" });
    for (const chunk of [1, 13, 512, 65536]) {
      const r = await scan(outer(gzipSync(tarOf(...good(), m))), [Q], chunk);
      expect(r.ok).toBe(false);
      expect(r.found.filter((x) => x.startsWith("./0fcc2575_keeper.tar.gz:./data/q holds")).length).toBe(1);
      const straddle = r.found.filter((x) => x.startsWith("./0fcc2575_keeper.tar.gz (its tar headers, padding or tail) holds"));
      expect(straddle.length).toBe(1);
      expect(straddle[0]).toContain("across the edge of ./data/q's data");
    }
  });
  test("an overlapping straddling control beside a control wholly inside the leaf: the straddle still fails the scan", async () => {
    const Z = "Z".repeat(20);
    const m = member("./data/backup-check-control", `${Z}`, { fill: "Z" });
    for (const chunk of [1, 13, 512, 65536]) {
      const r = await scan(outer(gzipSync(tarOf(member("./addon.json", "{}"), m))), [KEY], chunk, Z);
      expect(r.ok).toBe(false);
      expect(r.why).toContain("holds the positive control outside any file");
      expect(r.why).toContain("across the edge of ./data/backup-check-control's data");
    }
  });
  test("nested: a hit in a gzip member's raw bytes and a distinct hit in its inflated payload, each reported once, in its own layer", async () => {
    const RAW = "raw-needle-in-the-gzip-name";
    const IN = "inflated-needle-in-the-leaf";
    const payload = tarOf(...good(), member("./data/inner.txt", `before ${IN} after`));
    const arch = outer(gzNamed(payload, `image-${RAW}.tar`));
    for (const chunk of [1, 64, 512, 65536]) {
      const r = await scan(arch, [{ value: RAW, kind: "the raw needle" }, { value: IN, kind: "the inflated needle" }], chunk);
      expect(r.ok).toBe(false);
      const raw = r.found.filter((x) => x.includes("the raw needle"));
      const inner = r.found.filter((x) => x.includes("the inflated needle"));
      expect([chunk, raw.length, inner.length]).toEqual([chunk, 1, 1]);
      expect(raw[0]).toStartWith("./0fcc2575_keeper.tar.gz (its gzip bytes) holds the raw needle at byte 16");
      expect(inner[0]).toStartWith("./0fcc2575_keeper.tar.gz:./data/inner.txt holds the inflated needle at byte 7");
      // nothing from the outer tar: its member's layer completed, so a hit inside its data is that layer's
      expect(r.found.filter((x) => x.startsWith("the archive")).length).toBe(0);
    }
  });
  test("nested: a control in the gzip member's raw (non-leaf) bytes fails the scan", async () => {
    const arch = outer(gzNamed(tarOf(...good()), `image-${CTL}.tar`));
    for (const chunk of [1, 512, 65536]) {
      const r = await scan(arch, [KEY], chunk);
      expect(r.ok).toBe(false);
      expect(r.why).toContain("./0fcc2575_keeper.tar.gz (its gzip bytes) holds the positive control outside any file, at byte 16");
    }
  });
  test("a member whose layer fails: the hit held inside its data is reported by the tar layer as well as the failure", async () => {
    // a member named as an archive that is neither gzip nor tar fails its layer at its end; the key inside it was held for it
    const r = await scan(outer(gzipSync(tarOf(...good(), member("./data/blob.zst.tar", `${"a".repeat(600)} ${KEY}`)))), [KEY]);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("is named as an archive but is neither gzip nor tar");
    expect(r.found.some((x) => x.startsWith("./0fcc2575_keeper.tar.gz (its tar headers, padding or tail) holds"))).toBe(true);
  });
});
const GENERIC_KIND = "a key value, a key's fingerprint or the sentinel";

// -- item 5 -----------------------------------------------------------------------------------------------------------------------
describe("item 5: the child's process group, and the oom_score_adj ask", () => {
  const src = (pidFile: string) => `const g = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); await Bun.sleep(60_000);\n`;
  const pidOf = async (p: string) => { for (let i = 0; i < 100; i++) { try { const n = Number(readFileSync(p, "utf8")); if (n > 0) return n; } catch { /* not yet */ } await Bun.sleep(50); } throw new Error("no pid"); };
  test("the control: a grandchild survives a plain kill of its parent's pid", async () => {
    const d = scratch(); const pidFile = join(d, "g.pid");
    const c = Bun.spawn([process.execPath, script(src(pidFile))], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const g = await pidOf(pidFile);
    c.kill("SIGKILL"); await c.exited;
    await Bun.sleep(200);
    expect(alive(g)).toBe(true);
    process.kill(g, "SIGKILL");
  }, 20_000);
  test("a timeout kills the child's whole group: the grandchild holding its pipes goes too, and the answer comes at once", async () => {
    const d = scratch(); const pidFile = join(d, "g.pid");
    const f = small();
    const t0 = Date.now();
    const r = await scanChild(f, KEY_NAME, [], CTL, { script: script(src(pidFile)), timeoutMs: 1500 });
    const g = await pidOf(pidFile);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.why).toStartWith(`the scan took longer than 2 seconds reading ${OF(f)} and was stopped (a timeout, not a crash)`);
    await Bun.sleep(200);
    const left = alive(g);
    if (left) process.kill(g, "SIGKILL");
    expect(left).toBe(false);
  }, 20_000);
  test("an abort kills the group too", async () => {
    const d = scratch(); const pidFile = join(d, "g.pid");
    const ac = new AbortController();
    const p = scanChild(small(), KEY_NAME, [], CTL, { script: script(src(pidFile)), signal: ac.signal });
    const g = await pidOf(pidFile);
    ac.abort();
    expect((await p).why).toContain("the backup check's deadline passed");
    await Bun.sleep(200);
    const left = alive(g);
    if (left) process.kill(g, "SIGKILL");
    expect(left).toBe(false);
  }, 20_000);
  test("the oom_score_adj write is wrapped: a read-only /proc, a seccomp refusal or no such file is never fatal, and says why", () => {
    const erofs = preferOomKill("/proc/self/oom_score_adj", () => { throw Object.assign(new Error("read-only file system"), { code: "EROFS" }); });
    expect(erofs).toBe("oom_score_adj not set (EROFS): the scan's own memory limit still holds");
    const eperm = preferOomKill("/proc/self/oom_score_adj", () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); });
    expect(eperm).toContain("(EPERM)");
    expect(preferOomKill(join(scratch(), "no", "such", "oom_score_adj"))).toContain("(ENOENT)");
    let wrote = "";
    expect(preferOomKill("/x", (_p, v) => { wrote = v; })).toBe("");
    expect(wrote).toBe("1000");
  });
  test("the child's note on stderr is logged by the service, and its result still used", async () => {
    const good1 = JSON.stringify({ ok: true, why: "", members: 3, names: [], found: [], control: 1 });
    const logs: string[] = [];
    const r = await scanChild(small(), KEY_NAME, [], CTL, { log: (l) => logs.push(l), script: script(`require("node:fs").writeSync(2, "note oom_score_adj not set (EROFS): the scan's own memory limit still holds\\n"); console.log(${JSON.stringify(good1)});\n`) });
    expect(r).toMatchObject({ ok: true, control: 1 });
    expect(logs).toContain("backup check: the scan's child says: oom_score_adj not set (EROFS): the scan's own memory limit still holds");
  }, 20_000);
});

// -- item 6 -----------------------------------------------------------------------------------------------------------------------
describe("item 6: the memory bound, stated and pinned", () => {
  const CAP = 256 * MB;
  test("the bound: 4 KB pieces times deflate's 1032:1 times 6 layers, plus each layer's buffering and the outer read, well under the cap", () => {
    expect([INFLATE_IN, DEFLATE_MAX_RATIO, MAX_DEPTH, MAX_RECORD]).toEqual([4096, 1032, 6, MB]);
    expect(INFLATE_IN * DEFLATE_MAX_RATIO * MAX_DEPTH).toBe(25_362_432);
    expect(MEMORY_BOUND).toBeGreaterThan(INFLATE_IN * DEFLATE_MAX_RATIO * MAX_DEPTH);
    expect(MEMORY_BOUND).toBeLessThan(40 * MB);
    // with the runtime's own (well under 128 MB), the cap holds
    expect(MEMORY_BOUND + 128 * MB).toBeLessThan(CAP);
    const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "scan.ts"), "utf8").replace(/\s*\/\/\s*/g, " ");
    for (const l of ["INFLATE_IN (4 KB) at a time, which deflate expands at most DEFLATE_MAX_RATIO (about 1032) times", "MAX_DEPTH (6) layers deep that is about 25 MB in all", "a sampled check, not a hard one: the kernel is the hard limit until a cgroup limit lands"])
      expect([l, src.includes(l)]).toEqual([l, true]);
  });
  test("at the deepest nesting, an all-zero leaf at every level: the real child passes under the 256 MB cap", async () => {
    // the outer tar's members are layer 1 (the image's gzip and its tar), the image tar's members layer 2, and each nested tar.gz
    // member one layer deeper: the innermost leaves at MAX_DEPTH
    const zeros = () => member("./data/zeros.bin", new Uint8Array(16 * MB));
    let t = tarOf(...good(), zeros());
    for (let i = 3; i <= MAX_DEPTH; i++) t = tarOf(member(`./layer-${i}.tar.gz`, gzipSync(t, { level: 9 })), zeros());
    // one level deeper fails by name (the nesting budget), so this is the deepest that passes
    const deeper = await scanBackup(outer(gzipSync(tarOf(member("./one-more.tar.gz", gzipSync(t, { level: 9 }))), { level: 9 })), KEY_NAME, [KEY], { control: CTL });
    expect(deeper.why).toContain("the nesting budget");
    const f = fileOf(outer(gzipSync(t, { level: 9 })));
    const r = await scanChild(f, KEY_NAME, [KEY], CTL, { rssMax: CAP, log: () => {} });
    expect(r).toMatchObject({ ok: true, why: "", control: 1 });
    expect(r.expanded!).toBeGreaterThan((MAX_DEPTH - 1) * 16 * MB);
    expect(r.names.some((n) => n.split(":").length === MAX_DEPTH)).toBe(true);
    expect(r.peakRss!).toBeGreaterThan(0);
    expect(r.peakRss!).toBeLessThan(CAP);
    console.log(`deepest nesting (${MAX_DEPTH} layers): ${(f.size / 1024).toFixed(0)} KB archive, ${((r.expanded ?? 0) / MB).toFixed(0)} MB decoded, the child's peak ${(r.peakRss! / MB).toFixed(1)} MB`);
  }, 240_000);
  test("DOCS: the bound, the sampled limit and the kernel as the hard one, device check 15's runs as the condition, and the follow-ups", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    for (const l of ["4 KB times deflate's maximum ratio (about 1032) times the deepest nesting (6)", "a sampled check", "the kernel is the hard limit until a cgroup limit lands",
      "are the conditions for setting `drill_followups_open` to false", "a pinned Bun build on ARM running the gzip boundary suite", "a cgroup memory limit in the workflow",
      "backup the host finishes after the check gave up on it"]) expect([l, docs.includes(l)]).toEqual([l, true]);
  });
});
