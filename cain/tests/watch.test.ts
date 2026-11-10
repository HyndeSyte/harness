import { describe, expect, test } from "bun:test";
import { BACK, backText, check, DOWN, downText, GRACE_MS, minutes, PeerWatch } from "../rootfs/opt/cain/link/watch";
import { emptyState, Link, State } from "../rootfs/opt/cain/link/core";

function rig(saved: any = null, start = 1_000_000) {
  const clock = { t: start };
  let file: any = saved;
  const w = new PeerWatch({ load: () => file, save: (s) => { file = s; }, now: () => clock.t });
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

  test("the words", () => {
    expect(minutes(20_000)).toBe("1 minute");
    expect(minutes(7_200_000)).toBe("2 hours");
    expect(downText(300_000)).toContain("restart Harness in Home Assistant");
    expect(backText(60_000)).toContain("answering again");
  });
});

describe("the link's notice", () => {
  test("goes straight to his DM, with no buttons and no pings", async () => {
    let state: State = emptyState();
    const calls: any[] = [];
    const rest = async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (path === "/oauth2/applications/@me") return { owner: { id: "4242" } };
      if (path === "/users/@me") return { id: "999" };
      if (path === "/users/@me/channels") return { id: "5151" };
      return { id: "7001", content: body?.content };
    };
    const link = new Link({ rest, load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; },
      now: () => 1, relay: () => {}, toHarness: async () => true, paired: () => "4242", log: () => {} });
    await link.notice(downText(GRACE_MS));
    const post = calls.find((c) => c.method === "POST" && c.path === "/channels/5151/messages");
    expect(post.body.content).toContain("calendar specialist");
    expect(post.body.components).toBeUndefined();
    expect(post.body.allowed_mentions).toEqual({ parse: [] });
  });
});
