// The link's signed operations, each done once (rootfs/opt/cain/link/auth.ts, SignedOps and
// RequestLog, from the C1 code review): simultaneous copies run once; an answer to a tap the
// link may not have sent is an explicit unknown, never a success; damaged history takes no new
// operation until it can't matter; an operation is remembered longer than it's ever retried;
// and a body over the limit is refused before it's read.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedText, KEEP_MS, RequestLog, SignedOps } from "../rootfs/opt/cain/link/auth";

const ID = "a".repeat(32);
const dir = () => mkdtempSync(join(tmpdir(), "link-ops-"));
const ok = (body = '{"status":"ok"}') => async () => ({ status: 200, body });

describe("each signed operation once", () => {
  test("two copies at once run once, and both get its answer", async () => {
    const ops = new SignedOps(new RequestLog(join(dir(), "requests.json")));
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const act = async () => { runs++; await gate; return { status: 200, body: '{"id":7}' }; };
    const a = ops.run(ID, "/relay", act), b = ops.run(ID, "/relay", act);
    release();
    expect(await a).toEqual({ status: 200, body: '{"id":7}' });
    expect(await b).toEqual({ status: 200, body: '{"id":7}' });
    expect(runs).toBe(1);
    expect(await ops.run(ID, "/relay", act)).toEqual({ status: 200, body: '{"id":7}' });   // a later repeat: the stored answer
    expect(runs).toBe(1);
  });

  test("an answer to a tap the link may not have sent before it stopped: unknown, not sent again, never success", async () => {
    const f = join(dir(), "requests.json");
    new RequestLog(f).put(ID, { at: Date.now(), state: "received" });       // the link stopped mid-way
    const ops = new SignedOps(new RequestLog(f));
    let runs = 0;
    const a = await ops.run(ID, "/answer", async () => { runs++; return { status: 200, body: "{}" }; });
    expect(a.status).toBe(409);
    expect(JSON.parse(a.body).status).toBe("unknown");
    expect(runs).toBe(0);
    expect((await ops.run(ID, "/answer", ok())).status).toBe(409);         // and stays so
  });

  test("anything else received but never done runs again (each is deduplicated or idempotent by its id)", async () => {
    const f = join(dir(), "requests.json");
    new RequestLog(f).put(ID, { at: Date.now(), state: "received" });
    let runs = 0;
    const a = await new SignedOps(new RequestLog(f)).run(ID, "/card", async () => { runs++; return { status: 200, body: '{"id":3}' }; });
    expect(a).toEqual({ status: 200, body: '{"id":3}' });
    expect(runs).toBe(1);
  });
});

describe("the request history", () => {
  test("none yet is empty, not damaged", () => {
    const log = new RequestLog(join(dir(), "requests.json"));
    expect(log.damaged()).toBe(false);
  });

  test("a damaged file with a good copy beside it: the copy is used", () => {
    const d = dir(), f = join(d, "requests.json");
    const good = new RequestLog(f);
    good.put(ID, { at: Date.now(), state: "done", status: 200, body: "{}" });
    good.put("b".repeat(32), { at: Date.now(), state: "done", status: 200, body: "{}" });   // the first is now in the copy too
    writeFileSync(f, "{not json");
    const log = new RequestLog(f);
    expect(log.damaged()).toBe(false);
    expect(log.get(ID)?.state).toBe("done");
  });

  test("damaged with no good copy: no new operation is taken, even after a restart, until it can't matter", async () => {
    const d = dir(), f = join(d, "requests.json");
    writeFileSync(f, "{not json"); writeFileSync(`${f}.prev`, '{"x": 1}');
    const t0 = 1_800_000_000_000;
    let now = t0;
    const ops = new SignedOps(new RequestLog(f, t0), () => now);
    let runs = 0;
    const act = async () => { runs++; return { status: 200, body: "{}" }; };
    expect((await ops.run(ID, "/relay", act)).status).toBe(503);
    expect(runs).toBe(0);
    expect(readFileSync(`${f}.damaged`, "utf8")).toBe(String(t0));
    now = t0 + KEEP_MS - 1;
    expect((await new SignedOps(new RequestLog(f, now), () => now).run(ID, "/relay", act)).status).toBe(503);   // a restart remembers
    now = t0 + KEEP_MS + 1;
    expect((await new SignedOps(new RequestLog(f, now), () => now).run(ID, "/relay", act)).status).toBe(200);
    expect(runs).toBe(1);
  });

  test("an operation is remembered longer than the specialist ever retries one (7 days)", () => {
    expect(KEEP_MS).toBeGreaterThan(7 * 24 * 3_600_000);
    const py = readFileSync(join(import.meta.dir, "../../harness/app/harness/outbox.py"), "utf8");
    expect(py).toContain("MAX_AGE_S = 7 * 24 * 3600");
  });
});

describe("a body over the limit is refused before it's read", () => {
  test("a declared length over it, unread", async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    const req = new Request("http://link/card", { method: "POST", body, headers: { "content-length": "999999" }, duplex: "half" } as RequestInit);
    expect(await boundedText(req, 16_384)).toBeNull();
    expect(pulled).toBe(0);
  });
  test("a body that runs past it with no length, cut off", async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096)); if (pulled > 100) c.close(); } }, { highWaterMark: 0 });
    const req = new Request("http://link/card", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await boundedText(req, 16_384)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
  test("a body within it, whole", async () => {
    const req = new Request("http://link/card", { method: "POST", body: '{"text":"x"}' });
    expect(await boundedText(req, 16_384)).toBe('{"text":"x"}');
  });
});
