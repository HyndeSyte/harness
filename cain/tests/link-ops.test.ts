// The link's signed operations, each done once (rootfs/opt/cain/link/auth.ts, SignedOps and
// RequestLog, from the C1 code review and its re-check): simultaneous copies run once; an
// operation the link may not have finished runs again only where that's safe (a card), and is
// otherwise an explicit unknown, never a success; a server error is no outcome, so its retry
// isn't answered with it for good; the history survives a damaged copy with its newest change;
// damaged history takes no new operation until it can't matter; an operation is remembered
// longer than it's ever retried; and a body over the limit is refused before it's read.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedText, KEEP_MS, RERUN_SAFE, RequestLog, SignedOps, writeSynced } from "../rootfs/opt/cain/link/auth";

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

  test("a card received but never done runs again: the link makes it once per request id, and posts it once", async () => {
    expect([...RERUN_SAFE]).toEqual(["/card"]);
    const f = join(dir(), "requests.json");
    new RequestLog(f).put(ID, { at: Date.now(), state: "received" });
    let runs = 0;
    const a = await new SignedOps(new RequestLog(f)).run(ID, "/card", async () => { runs++; return { status: 200, body: '{"id":3}' }; });
    expect(a).toEqual({ status: 200, body: '{"id":3}' });
    expect(runs).toBe(1);
  });

  test("anything else received but never done (a line for Cain, a change of buttons) is an explicit unknown, never run again", async () => {
    for (const path of ["/relay", "/buttons"]) {
      const f = join(dir(), "requests.json");
      new RequestLog(f).put(ID, { at: Date.now(), state: "received" });     // the link stopped after it appended the line
      let runs = 0;
      const ops = new SignedOps(new RequestLog(f));
      const a = await ops.run(ID, path, async () => { runs++; return { status: 200, body: "{}" }; });
      expect([path, a.status, JSON.parse(a.body).status, runs]).toEqual([path, 409, "unknown", 0]);
      expect((await ops.run(ID, path, ok())).status).toBe(409);
    }
  });

  test("a server error is no outcome: a card's retry runs again once things are back, never answered with the old error", async () => {
    const ops = new SignedOps(new RequestLog(join(dir(), "requests.json")));
    let runs = 0, up = false;
    const act = async () => { runs++; return up ? { status: 200, body: '{"id":4}' } : { status: 500, body: '{"status":"error"}' }; };
    expect((await ops.run(ID, "/card", act)).status).toBe(500);
    up = true;
    expect(await ops.run(ID, "/card", act)).toEqual({ status: 200, body: '{"id":4}' });
    expect(runs).toBe(2);
    expect(await ops.run(ID, "/card", act)).toEqual({ status: 200, body: '{"id":4}' });  // now done: stored
    expect(runs).toBe(2);
  });

  test("a server error or a throw on any other route: its retry is an explicit unknown", async () => {
    for (const fail of [async () => ({ status: 502, body: "{}" }), async () => { throw new Error("boom"); }]) {
      const ops = new SignedOps(new RequestLog(join(dir(), "requests.json")));
      const first = await ops.run(ID, "/answer", fail);
      expect(first.status).toBeGreaterThanOrEqual(500);
      let runs = 0;
      const again = await ops.run(ID, "/answer", async () => { runs++; return { status: 200, body: "{}" }; });
      expect([again.status, JSON.parse(again.body).status, runs]).toEqual([409, "unknown", 0]);
    }
  });

  test("a \"received\" that couldn't be made durable (the folder's sync failed) does nothing: 503, and the route never runs", async () => {
    const f = join(dir(), "requests.json");
    let failing = true;
    const write = (p: string, b: string) => writeSynced(p, b, () => { if (failing) throw new Error("EIO: the folder's sync failed"); });
    const ops = new SignedOps(new RequestLog(f, Date.now(), write));
    let runs = 0;
    const act = async () => { runs++; return { status: 200, body: '{"id":5}' }; };
    const a = await ops.run(ID, "/card", act);
    expect([a.status, JSON.parse(a.body).status, runs]).toEqual([503, "not recorded", 0]);
    failing = false;
    expect(await ops.run(ID, "/card", act)).toEqual({ status: 200, body: '{"id":5}' });
    expect(runs).toBe(1);
  });

  test("the folder's sync failing is the writer's error, never swallowed", () => {
    const f = join(dir(), "x.json");
    expect(() => writeSynced(f, "{}", () => { throw new Error("EIO") })).toThrow("EIO");
  });

  test("a refusal is an outcome: kept, and its retry gets it without running again", async () => {
    const ops = new SignedOps(new RequestLog(join(dir(), "requests.json")));
    let runs = 0;
    const act = async () => { runs++; return { status: 400, body: '{"status":"refused"}' }; };
    expect((await ops.run(ID, "/card", act)).status).toBe(400);
    expect((await ops.run(ID, "/card", act)).status).toBe(400);
    expect(runs).toBe(1);
  });
});

describe("the request history", () => {
  test("none yet is empty, not damaged", () => {
    const log = new RequestLog(join(dir(), "requests.json"));
    expect(log.damaged()).toBe(false);
  });

  test("the newest change survives a damaged first copy: an operation done just before is still done", async () => {
    // The re-check's reproduction: received, then done (its side effect happened), then the
    // first copy damaged. The second copy holds the done, so the retry runs nothing.
    const d = dir(), f = join(d, "requests.json");
    const ops = new SignedOps(new RequestLog(f));
    let runs = 0;
    const act = async () => { runs++; return { status: 200, body: '{"status":"ok"}' }; };
    expect((await ops.run(ID, "/relay", act)).status).toBe(200);
    writeFileSync(f, "{not json");
    const log = new RequestLog(f);
    expect([log.damaged(), log.get(ID)?.state, log.recoveredFrom]).toEqual([false, "done", "the second copy"]);
    expect(await new SignedOps(log).run(ID, "/relay", act)).toEqual({ status: 200, body: '{"status":"ok"}' });
    expect(runs).toBe(1);
  });

  test("a second copy a step ahead (the link stopped between the two writes) is the one read", () => {
    const d = dir(), f = join(d, "requests.json");
    const log = new RequestLog(f);
    log.put(ID, { at: Date.now(), state: "received" });
    const behind = readFileSync(f, "utf8");
    log.put(ID, { at: Date.now(), state: "done", status: 200, body: "{}" });
    writeFileSync(f, behind);                                  // the first copy never got the done
    expect(new RequestLog(f).get(ID)?.state).toBe("done");
  });

  test("a damaged second copy: the first is read, and the next change writes both again", () => {
    const d = dir(), f = join(d, "requests.json");
    const log = new RequestLog(f);
    log.put(ID, { at: Date.now(), state: "done", status: 200, body: "{}" });
    writeFileSync(`${f}.2`, "{not json");
    const again = new RequestLog(f);
    expect([again.damaged(), again.get(ID)?.state, again.recoveredFrom]).toEqual([false, "done", "the first copy"]);
    again.put("b".repeat(32), { at: Date.now(), state: "received" });
    expect(new RequestLog(f).recoveredFrom).toBe("");
  });

  test("a copy without its generation, or with entries that aren't valid, counts as damaged, never as empty", () => {
    for (const bad of ['{"x": 1}', `{"${ID}": {"at": 1, "state": "done", "status": 200, "body": "{}"}}`, '{"gen": 3, "ops": {"zz": {}}}']) {
      const d = dir(), f = join(d, "requests.json");
      writeFileSync(f, bad); writeFileSync(`${f}.2`, bad);
      expect(new RequestLog(f).damaged()).toBe(true);
    }
  });

  test("damaged with no good copy: no new operation is taken, even after a restart, until it can't matter", async () => {
    const d = dir(), f = join(d, "requests.json");
    writeFileSync(f, "{not json"); writeFileSync(`${f}.2`, '{"x": 1}');
    const t0 = 1_800_000_000_000;
    let now = t0;
    const first = new RequestLog(f, t0);
    expect(first.damagedNow).toBe(true);                      // told once, at the load that found it
    const ops = new SignedOps(first, () => now);
    let runs = 0;
    const act = async () => { runs++; return { status: 200, body: "{}" }; };
    expect((await ops.run(ID, "/relay", act)).status).toBe(503);
    expect(runs).toBe(0);
    expect(readFileSync(`${f}.damaged`, "utf8")).toBe(String(t0));
    now = t0 + KEEP_MS - 1;
    const restarted = new RequestLog(f, now);
    expect([restarted.damagedSince, restarted.damagedNow]).toEqual([t0, false]);   // a restart remembers, and isn't told again
    expect((await new SignedOps(restarted, () => now).run(ID, "/relay", act)).status).toBe(503);
    now = t0 + KEEP_MS + 1;
    expect((await new SignedOps(new RequestLog(f, now), () => now).run(ID, "/relay", act)).status).toBe(200);
    expect(runs).toBe(1);
  });

  test("when the damage can't matter any more, a fresh log is written first: a restart then doesn't start another wait", () => {
    const d = dir(), f = join(d, "requests.json");
    writeFileSync(f, "{not json"); writeFileSync(`${f}.2`, "{not json");
    const t0 = 1_800_000_000_000;
    const log = new RequestLog(f, t0);
    expect(log.damaged(t0 + KEEP_MS + 1)).toBe(false);
    expect(existsSync(`${f}.damaged`)).toBe(false);
    const after = new RequestLog(f, t0 + KEEP_MS + 2);
    expect([after.damagedSince, after.damaged(t0 + KEEP_MS + 2)]).toEqual([0, false]);
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
