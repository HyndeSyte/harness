import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACK, backText, check, classify, DOWN, downText, every, fileStore, GRACE_MS, healthBody, hmacKey,
  MAX_SHOWN_MS, minutes, NOTICE_TIMEOUT_MS, PeerWatch, probeHarness, STILL, STILL_MS, stillText } from "../rootfs/opt/cain/link/watch";
import { emptyState, Link, State } from "../rootfs/opt/cain/link/core";

function rig(saved: any = null, start = 1_000_000) {
  const clock = { t: start };
  let file: any = saved;
  const w = new PeerWatch({ load: () => file, save: (s) => { file = s; }, now: () => clock.t, mono: () => clock.t });
  return { w, clock, file: () => file };
}

describe("the watch on the calendar specialist", () => {
  test("a restart inside the grace period says nothing", () => {
    const { w, clock } = rig();
    expect(w.observe(true)).toBeNull();
    for (let i = 0; i < 4; i++) { clock.t += 60_000; expect(w.observe(false)).toBeNull(); }
    clock.t += 60_000;
    expect(w.observe(true)).toBeNull();
    expect(w.state()).toBe("up");
  });

  test("down past the grace period is told once, and back once", () => {
    const { w, clock } = rig();
    w.observe(true);
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      clock.t += 60_000;
      const due = w.observe(false);
      if (due) { seen.push(due); w.sent(due); }
    }
    expect(seen).toEqual([DOWN]);
    expect(w.state()).toBe("down");
    clock.t += 60_000;
    expect(w.observe(true)).toBe(BACK);
    w.sent(BACK);
    for (let i = 0; i < 5; i++) { clock.t += 60_000; expect(w.observe(true)).toBeNull(); }
    expect(w.state()).toBe("up");
  });

  test("the first failure starts the clock", () => {
    const { w, clock } = rig();
    w.observe(false);
    clock.t += GRACE_MS - 1;
    expect(w.observe(false)).toBeNull();
    clock.t += 1;
    expect(w.observe(false)).toBe(DOWN);
  });

  test("a restart of Cain mid-outage doesn't tell him twice; an untold outage starts over", () => {
    const a = rig();
    a.w.observe(false);
    a.clock.t += GRACE_MS;
    a.w.sent(a.w.observe(false));
    const b = rig(a.file(), a.clock.t);
    for (let i = 0; i < 10; i++) { b.clock.t += 60_000; expect(b.w.observe(false)).toBeNull(); }
    b.clock.t += 60_000;
    expect(b.w.observe(true)).toBe(BACK);

    const c = rig();
    c.w.observe(false);
    c.clock.t += GRACE_MS - 30_000;
    c.w.observe(false);
    const d = rig(c.file(), c.clock.t + 3_600_000);
    expect(d.w.observe(false)).toBeNull();
    d.clock.t += GRACE_MS;
    expect(d.w.observe(false)).toBe(DOWN);
  });

  test("a damaged file is a fresh start", () => {
    const { w } = rig({ down_since: "x", alerted_at: {} });
    expect(w.state()).toBe("unknown");
    expect(w.observe(true)).toBeNull();
  });

  test("check: a send that fails is tried at the next check, and only then", async () => {
    const { w, clock } = rig();
    const told: string[] = [];
    let fail = true;
    const tell = async (text: string) => { if (fail) throw new Error("discord 503"); told.push(text); };
    await check(w, async () => false, tell);
    clock.t += GRACE_MS;
    expect(await check(w, async () => false, tell)).toBeNull();
    fail = false;
    clock.t += 60_000;
    expect(await check(w, async () => false, tell)).toBe(DOWN);
    clock.t += 60_000;
    expect(await check(w, async () => false, tell)).toBeNull();
    clock.t += 60_000;
    expect(await check(w, async () => true, tell)).toBe(BACK);
    expect(told.length).toBe(2);
    expect(told[0]).toContain("hasn't answered for 6 minutes");
    expect(told[1]).toContain("answering again, after about 8 minutes");
  });

  test("the words: the first notice asks nothing, and no message says add-on", () => {
    expect(minutes(20_000)).toBe("1 minute");
    expect(minutes(7_200_000)).toBe("2 hours");
    expect(downText(300_000)).toBe("The calendar specialist (Harness) hasn't answered for 5 minutes. Calendar requests, its cards and the morning calendar wait until it's back. You'll hear once it is.");
    expect(stillText()).toBe("Harness is still down. Restarting it should bring it back: Settings > Apps > Harness > Restart.");
    expect(backText(60_000)).toContain("answering again");
    for (const t of [downText(300_000), stillText(), backText(60_000)]) {
      expect(t).not.toMatch(/add-?on/i);
      expect(t).not.toContain("—");                              // no em dash
    }
    expect(downText(300_000)).not.toMatch(/restart/i);
  });

  test("still down after 30 minutes: the restart line goes once, never after it's back", () => {
    const { w, clock } = rig();
    w.observe(true);
    const seen: string[] = [];
    const minute = (up: boolean) => { clock.t += 60_000; const due = w.observe(up); if (due) { seen.push(due); w.sent(due); } };
    for (let i = 0; i < 90; i++) minute(false);
    expect(seen).toEqual([DOWN, STILL]);
    minute(true);
    expect(seen).toEqual([DOWN, STILL, BACK]);
    // A short outage: down and back, no restart line.
    for (let i = 0; i < 10; i++) minute(false);
    minute(true);
    for (let i = 0; i < 40; i++) minute(true);
    expect(seen).toEqual([DOWN, STILL, BACK, DOWN, BACK]);
    // The next long outage gets its own.
    for (let i = 0; i < 40; i++) minute(false);
    expect(seen.slice(5)).toEqual([DOWN, STILL]);
  });

  test("the restart line waits for the first notice, and goes at 30 minutes", () => {
    const { w, clock } = rig();
    w.observe(false);
    clock.t += STILL_MS - 60_000;
    expect(w.observe(false)).toBe(DOWN);              // not sent yet: no restart line before it
    clock.t += 120_000;
    expect(w.observe(false)).toBe(DOWN);
    w.sent(DOWN);
    expect(w.observe(false)).toBe(STILL);
  });

  test("a restart of Cain mid-outage never sends the restart line twice, and still sends it once", () => {
    const a = rig();
    a.w.observe(false);
    a.clock.t += GRACE_MS;
    a.w.sent(a.w.observe(false));                      // the first notice
    a.clock.t += 5 * 60_000;
    const b = rig(a.file(), a.clock.t);                   // restarted 10 minutes in, before the restart line
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) { b.clock.t += 60_000; const due = b.w.observe(false); if (due) { seen.push(due); b.w.sent(due); } }
    expect(seen).toEqual([STILL]);
    const c = rig(b.file(), b.clock.t);                   // and again after it went
    for (let i = 0; i < 40; i++) { c.clock.t += 60_000; expect(c.w.observe(false)).toBeNull(); }
    c.clock.t += 60_000;
    expect(c.w.observe(true)).toBe(BACK);
    c.w.sent(BACK);
    expect(c.file().still_at).toBeNull();
  });

  test("check: the restart line goes through the same send, and Cain hears it", async () => {
    const { w, clock } = rig();
    const told: string[] = [], relayed: string[] = [];
    const tell = async (t: string) => { told.push(t); };
    await check(w, async () => false, tell, () => {}, (d) => relayed.push(String(d)));
    for (let i = 0; i < 31; i++) { clock.t += 60_000; await check(w, async () => false, tell, () => {}, (d) => relayed.push(String(d))); }
    expect(told).toEqual([downText(GRACE_MS), stillText()]);
    expect(relayed).toEqual([DOWN, STILL]);
  });
});

describe("the link's notice", () => {
  test("goes straight to his DM with no pings, carrying the moving Stop unless things are stopped", async () => {
    for (const stopped of [false, true]) {
      let state: State = emptyState();
      const calls: any[] = [];
      const rest = async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        if (path === "/oauth2/applications/@me") return { owner: { id: "4242" } };
        if (path === "/users/@me") return { id: "999" };
        if (path === "/users/@me/channels") return { id: "5151" };
        return { id: "7001", content: body?.content, components: body?.components };
      };
      const link = new Link({ rest, load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; },
        now: () => 1, relay: () => {}, toHarness: async () => true, paired: () => "4242", log: () => {},
        stop: { read: () => ({ stopped, at: 0 }), write: () => {} } });
      await link.notice(downText(GRACE_MS));
      const post = calls.find((c) => c.method === "POST" && c.path === "/channels/5151/messages");
      expect(post.body.content).toContain("calendar specialist");
      expect(post.body.components).toEqual(stopped ? undefined
        : [{ type: 1, components: [{ type: 2, style: 4, label: "Stop", custom_id: "k:stop" }] }]);
      expect(post.body.allowed_mentions).toEqual({ parse: [] });
    }
  });
});

describe("review fixes", () => {
  test("once the DM is out it's sent, even if the line to Cain fails", async () => {
    const { w, clock } = rig();
    const told: string[] = [];
    const logs: string[] = [];
    const tell = async (text: string) => { told.push(text); };
    const relay = () => { throw new Error("EACCES: relay.queue"); };
    await check(w, async () => false, tell, (l) => logs.push(l), relay);
    clock.t += GRACE_MS;
    expect(await check(w, async () => false, tell, (l) => logs.push(l), relay)).toBe(DOWN);
    for (let i = 0; i < 5; i++) {
      clock.t += 60_000;
      expect(await check(w, async () => false, tell, (l) => logs.push(l), relay)).toBeNull();
    }
    expect(told.length).toBe(1);
    expect(logs.some((l) => l.includes("couldn't pass the down line to Cain"))).toBe(true);
  });

  test("checks never overlap, and a failure is logged", async () => {
    const timers: (() => void)[] = [];
    const logs: string[] = [];
    let release!: () => void;
    let runs = 0;
    every(60_000, async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => { release = r; });
      if (runs === 2) throw new Error("boom");
    }, (l) => logs.push(l), (cb) => { timers.push(cb); });
    expect(timers.length).toBe(1);
    timers.shift()!();                    // the first check starts, and hangs
    await Promise.resolve();
    expect(timers.length).toBe(0);        // nothing else is scheduled while it runs
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.length).toBe(1);
    timers.shift()!();                    // the second fails
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes("check failed: Error: boom"))).toBe(true);
    expect(timers.length).toBe(1);        // and the loop goes on
    expect(runs).toBe(2);
  });

  test("the notice has a timeout of about 15 s", async () => {
    expect(NOTICE_TIMEOUT_MS).toBe(15_000);
    const timeouts: (number | undefined)[] = [];
    let state: State = emptyState();
    Object.assign(state, { owner: "4242", dm: "5151", bot: "999" });
    const rest = async (_m: string, _p: string, body?: any, _a?: boolean, t?: number) => { timeouts.push(t); return { id: "1", content: body?.content }; };
    const link = new Link({ rest, load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; },
      now: () => 1, relay: () => {}, toHarness: async () => true, paired: () => "4242", log: () => {} });
    await link.notice("x", NOTICE_TIMEOUT_MS);
    expect(timeouts).toEqual([15_000]);
  });

  test("only 404 counts as alive without a body; 5xx and no answer are down; 403 is refused", async () => {
    expect(classify(404, null)).toBe("up");
    expect(classify(200, { status: "ok" })).toBe("up");
    expect(classify(200, { status: "starting" })).toBe("up");
    expect(classify(200, { status: "stuck" })).toBe("down");
    expect(classify(500, null)).toBe("down");
    expect(classify(503, null)).toBe("down");
    expect(classify(403, null)).toBe("refused");
    expect(await probeHarness(async () => { throw new Error("ECONNREFUSED"); })).toBe("down");
    expect(await probeHarness(async () => new Response("{}", { status: 502 }))).toBe("down");
    expect(await probeHarness(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }))).toBe("up");
  });

  test("a refused key tells him nothing, is logged once, and shows as can't check", async () => {
    const { w, clock } = rig();
    const logs: string[] = [];
    const told: string[] = [];
    for (let i = 0; i < 20; i++) {
      expect(await check(w, async () => "refused", async (t) => { told.push(t); }, (l) => logs.push(l))).toBeNull();
      clock.t += 60_000;
    }
    expect(told).toEqual([]);
    expect(logs.filter((l) => l.includes("refused our key")).length).toBe(1);
    expect(w.state()).toBe("refused");
    expect(w.status().note).toBe("can't check: key refused");
  });

  test("the handover key matches the Python side (tests/test_watch.py)", () => {
    expect(hmacKey("not-a-real-token.cross-language-vector", "harness-handover-v1"))
      .toBe("d8bd045641e8485f5f91e19bbcabc8dd05ae3b3b5d98dd30609c58119229450a");
    expect(hmacKey("", "harness-handover-v1")).toBe("");
  });

  test("a wall-clock jump at boot doesn't make a short outage look long", () => {
    const wall = { t: 1_000_000 }, mono = { t: 5 };
    const w = new PeerWatch({ load: () => null, save: () => {}, now: () => wall.t, mono: () => mono.t });
    expect(w.observe(false)).toBeNull();
    wall.t += 365 * 86_400_000;
    mono.t += 60_000;
    expect(w.observe(false)).toBeNull();
    mono.t += GRACE_MS;
    expect(w.observe(false)).toBe(DOWN);
    expect(w.downFor()).toBeLessThan(GRACE_MS + 120_000);
    expect(minutes(-5)).toBe("1 minute");
    expect(minutes(1e15)).toBe(minutes(MAX_SHOWN_MS));
  });

  test("health: bare ok without the key, the detail only with it", () => {
    const detail = () => ({ discord: { connected: true, last_heard: 5 }, watch: { state: "up" } });
    expect(healthBody(false, detail)).toEqual({ status: "ok" });
    expect(healthBody(true, detail)).toEqual({ status: "ok", ...detail() });
  });

  test("the watch file: the folder is made first, and a failed save is logged", () => {
    const root = mkdtempSync(join(tmpdir(), "watch-"));
    const logs: string[] = [];
    const path = join(root, "gone", "link", "watch.json");
    const st = fileStore(path, (l) => logs.push(l));
    st.save({ down_since: 1, alerted_at: 2, last_ok: null });
    expect(JSON.parse(readFileSync(path, "utf8")).alerted_at).toBe(2);
    expect(st.load()?.alerted_at).toBe(2);
    writeFileSync(join(root, "file"), "x");
    const bad = fileStore(join(root, "file", "watch.json"), (l) => logs.push(l));
    expect(() => bad.save({ down_since: null, alerted_at: null, last_ok: null })).not.toThrow();
    expect(logs.some((l) => l.includes("couldn't save"))).toBe(true);
  });
});
