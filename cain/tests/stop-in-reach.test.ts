// Stop within reach (Cain 0.10.0, link/core.ts): one red Stop on the newest plain bot
// message (Cain's reply, or a notice of the link's, that asks nothing), never on a card
// that asks something. It moves only when none of the newest 5 bot messages carries a Stop,
// Stop first on the new message and then off the old, and only when Discord is quiet. While
// stopped it comes off, and Turn back on is kept within reach instead.
import { describe, expect, test } from "bun:test";
import { asksSomething } from "../rootfs/opt/cain/gate/plugin";
import { cardsView, RESUME, STILL_STOPPED, STOP } from "../rootfs/opt/cain/link/core";
import { BOT, DM, HOUR, MIN, PR, rig, SHA1 } from "./link-rig";

type Rig = ReturnType<typeof rig>;
const btn = (label: string, custom_id: string) => ({ type: 2, style: 2, label, custom_id });
const STOP_ROW = [{ type: 1, components: [{ type: 2, style: 4, label: "Stop", custom_id: STOP }] }];
const RECEIPT_ROWS = [{ type: 1, components: [btn("Not mine", "k:c:nm"), btn("Wrong time", "k:c:wt")] }, ...STOP_ROW];

// One of Cain's replies as his plugin posts it, then the PostToolUse hook's word on it.
async function cainSays(r: Rig, content: string, o: { replyTo?: string } = {}): Promise<string> {
  const id = r.snowflake();
  r.posted[id] = { id, content, author: { id: BOT }, components: [],
    ...(o.replyTo ? { message_reference: { type: 0, message_id: o.replyTo, channel_id: DM } } : {}) };
  await r.link.sent({ tool: "reply", ids: [id], question: content.trim().endsWith("?"), ...(o.replyTo ? { reply_to: o.replyTo } : {}) });
  return id;
}
const patchesOf = (r: Rig, id: string) => r.calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${id}`);
const holder = (r: Rig) => r.state().stopAt;
async function replies(r: Rig, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await cainSays(r, `Done with part ${i + 1}.`));
  return out;
}

describe("where the moving Stop sits", () => {
  test("a notice carries it when posted, red, on its own row", async () => {
    const r = rig();
    const n = await r.link.notice("The calendar specialist is answering again.");
    expect(r.msg(n).components).toEqual(STOP_ROW);
    expect(holder(r)).toBe(n);
    expect(cardsView(r.state(), r.t.now).cards.find((c) => c.message === n)).toMatchObject({ kind: "notice", writer: "link", labels: ["Stop"], live: true });
  });

  test("a notice that asks something, or one posted while stopped, carries none", async () => {
    const r = rig();
    const asking = await r.link.notice("Is the calendar specialist still needed today?");
    expect(r.msg(asking).components).toEqual([]);
    r.stop.stopped = true; r.stop.at = r.t.now;
    const stopped = await r.link.notice("The calendar specialist is answering again.");
    expect(r.msg(stopped).components).toEqual([]);
    expect(holder(r)).toBeUndefined();
  });

  test("Cain's reply gets it once the hook says it went out, as his and still his to edit; a move edits buttons alone", async () => {
    const r = rig();
    const reply = await cainSays(r, "Moved swim to 4:30.");
    expect(r.msg(reply).components).toEqual(STOP_ROW);
    expect(r.msg(reply).content).toBe("Moved swim to 4:30.");
    expect(patchesOf(r, reply).map((c) => c.body)).toEqual([{ components: STOP_ROW, allowed_mentions: { parse: [] } }]);
    const v = cardsView(r.state(), r.t.now);
    expect(v.cards.find((c) => c.message === reply)).toMatchObject({ kind: "plain", writer: "cain", labels: ["Stop"], live: true });
    expect(v.sent).toContain(reply);
  });

  test("it moves only when none of the newest 5 bot messages carries a Stop: Stop on the new one first, then off the old, with no line", async () => {
    const r = rig();
    const n = await r.link.notice("The calendar specialist is answering again.");
    const [, , , r4] = await replies(r, 4);
    expect(holder(r)).toBe(n);                                         // the notice is one of the newest 5
    const r5 = await cainSays(r, "And that's the last part.");
    expect(holder(r)).toBe(r5);
    const add = r.calls.findIndex((c) => c.method === "PATCH" && c.path.endsWith(`/${r5}`));
    const off = r.calls.findIndex((c) => c.method === "PATCH" && c.path.endsWith(`/${n}`));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(add);                                  // add before strip
    expect(r.calls[off].body).toEqual({ components: [], allowed_mentions: { parse: [] } });   // buttons only: no line
    expect(r.msg(n)).toMatchObject({ content: "The calendar specialist is answering again.", components: [] });
    expect(r.msg(r4).components).toEqual([]);
  });

  test("never onto an ask, a Ship card, a specialist's card, the connector notice or a question", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" });
    await r.link.ship({ text: "Harness 0.23.0 ready.", item: "P41", pr: PR, head: SHA1 });
    await r.link.show(await r.link.addCard({ text: "Moved Swim.", rows: [{ type: 1, components: [btn("Undo", "k:c:u")] }], kind: "card" }), { item: "none" });
    await r.link.connector({ item: "P41", text: "Installing Harness 0.23.0" });
    const question = await cainSays(r, "Want me to move art too?");
    await r.link.sweep();
    expect(holder(r)).toBe(first);                                     // nothing newer may carry it
    for (const id of Object.keys(r.posted).filter((x) => x !== first)) expect(r.buttons(id)).not.toContain("Stop");
    expect(r.msg(question).components).toEqual([]);
    const plain = await cainSays(r, "Art stays at 5.");
    expect(holder(r)).toBe(plain);
    expect(r.buttons(first)).toEqual([]);
  });

  for (const [what, carrier] of [
    ["the morning message", (r: Rig) => r.link.morning("## Thu Nov 12")],
    ["a specialist's card with its Stop row", async (r: Rig) => r.link.show(await r.link.addCard({ text: "Added Swim to your Gmail.", rows: RECEIPT_ROWS, kind: "card" }), { item: "none" })],
  ] as const) test(`${what} counts as a Stop within reach`, async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await carrier(r);
    await replies(r, 4);
    expect(holder(r)).toBe(first);                                     // the carrier is one of the newest 5
    const last = await cainSays(r, "All set.");
    expect(holder(r)).toBe(last);
    expect(r.buttons(first)).toEqual([]);
  });
});

describe("moving it safely", () => {
  test("if Discord won't take the new Stop, the old one stays; the next try moves it", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await replies(r, 4);
    r.failing.add("PATCH");
    const last = await cainSays(r, "All set.");
    expect(holder(r)).toBe(first);
    expect(r.buttons(first)).toEqual(["Stop"]);
    expect(patchesOf(r, first)).toHaveLength(1);                       // only the add that put it there
    r.failing.clear();
    await r.link.sweep();
    expect(holder(r)).toBe(last);
    expect(r.buttons(first)).toEqual([]);
  });

  test("a strip that fails is tried again by the sweep, and the old Stop keeps working meanwhile", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await replies(r, 4);
    r.failing.add(`PATCH /channels/${DM}/messages/${first}`);
    const last = await cainSays(r, "All set.");
    expect(holder(r)).toBe(last);
    expect(r.buttons(first)).toEqual(["Stop"]);                        // two at worst, never none
    r.failing.clear();
    await r.link.sweep();
    expect(r.buttons(first)).toEqual([]);
    expect(r.buttons(last)).toEqual(["Stop"]);
    // An old Stop that's still up works like any other.
    const r2 = rig();
    const old = await cainSays(r2, "Moved swim to 4:30.");
    await replies(r2, 4);
    r2.failing.add(`PATCH /channels/${DM}/messages/${old}`);
    await cainSays(r2, "All set.");
    expect(await r2.tap(structuredClone(r2.msg(old)), STOP)).toBe("to specialist");
    expect(r2.stop.stopped).toBe(true);
  });

  test("after a rate limit it waits a minute", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await replies(r, 4);
    r.limitN.PATCH = 1;
    await cainSays(r, "All set.");
    expect(holder(r)).toBe(first);
    const tries = r.calls.filter((c) => c.method === "PATCH").length;
    await r.link.sweep();
    expect(r.calls.filter((c) => c.method === "PATCH").length).toBe(tries);   // nothing within the minute
    r.later(61_000);
    await r.link.sweep();
    expect(holder(r)).not.toBe(first);
  });

  test("it waits while a card's outcome edit is pending", async () => {
    const r = rig();
    await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" });
    r.failing.add("PATCH");
    await r.link.answered({ item: "P08", question: "Q2" });            // its strip fails: the outcome edit waits
    r.failing.clear();
    const reply = await cainSays(r, "Noted.");
    expect(patchesOf(r, reply)).toEqual([]);
    await r.link.sweep();                                              // the card's edit first, then the move
    expect(holder(r)).toBe(reply);
  });

  test("an outcome edit that keeps failing holds moves up for 10 minutes at most", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    r.failing.add(`PATCH /channels/${DM}/messages/${ask}`);
    await r.link.answered({ item: "P08", question: "Q2" });            // its strip keeps failing
    const reply = await cainSays(r, "Noted.");
    expect(holder(r)).toBeUndefined();
    r.later(11 * MIN);
    await r.link.sweep();
    expect(holder(r)).toBe(reply);
  });

  test("an edit that makes its message ask something moves it; a plain text edit leaves it alone", async () => {
    const r = rig();
    await replies(r, 4);
    const last = await cainSays(r, "All set.");
    const before = r.calls.length;
    await r.link.sent({ tool: "edit", ids: [last], question: false });
    expect(r.calls.length).toBe(before);                               // the plugin's text edit keeps the buttons
    await r.link.sent({ tool: "edit", ids: [last], question: true });
    expect(r.buttons(last)).toEqual([]);
    expect(holder(r)).not.toBe(last);
    expect(r.buttons(holder(r)!)).toEqual(["Stop"]);
  });

  test("a message Discord keeps refusing Stop on is left after three tries; the next plain message gets it, never an older one", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await replies(r, 4);
    r.failing.add("PATCH");                                            // Discord refuses, but not with a 404 or a rate limit
    const stuck = await cainSays(r, "All set.");
    await r.link.sweep();
    await r.link.sweep();
    expect(patchesOf(r, stuck)).toHaveLength(3);
    await r.link.sweep();
    await r.link.sweep();
    expect(patchesOf(r, stuck)).toHaveLength(3);                       // no fourth try, every minute or ever
    expect(holder(r)).toBe(first);                                     // the old one keeps working meanwhile
    r.failing.clear();
    await r.link.sweep();
    expect(patchesOf(r, stuck)).toHaveLength(3);
    const next = await cainSays(r, "One more thing done.");
    expect(holder(r)).toBe(next);
    expect(r.buttons(first)).toEqual([]);
  });

  test("Stop that lands while he taps Stop comes straight off: a move, and a notice", async () => {
    const r = rig();
    r.spy.onCall = (method) => {                                       // his Stop lands while Discord takes the move
      if (method !== "PATCH") return;
      r.stop.stopped = true; r.stop.at = r.t.now; r.spy.onCall = null;
    };
    const reply = await cainSays(r, "Moved swim to 4:30.");
    expect(r.buttons(reply)).toEqual([]);
    expect(holder(r)).toBeUndefined();
    // A notice on its way to Discord when he taps Stop: it goes in the Stop queue, and comes off once it lands.
    const r2 = rig();
    const old = await cainSays(r2, "Moved swim to 4:30.");
    r2.gate.posts = true;
    const notice = r2.link.notice("The calendar specialist is answering again.");
    await Bun.sleep(5);
    await r2.tap(structuredClone(r2.msg(old)), STOP);
    r2.release();
    const id = await notice;
    await r2.link.whenStopPlaced();
    expect(r2.stop.stopped).toBe(true);
    expect(r2.buttons(id)).toEqual([]);
    expect(r2.buttons(old)).toEqual([]);
    expect(holder(r2)).toBeUndefined();
  });

  test("a reply or notice whose last paragraph asks anything, even mid-paragraph, never carries it", async () => {
    const r = rig();
    const first = await cainSays(r, "Moved swim to 4:30.");
    await replies(r, 4);
    const id = r.snowflake();
    r.posted[id] = { id, content: "Should I move swim? Say yes and I'll do it.", author: { id: BOT }, components: [] };
    await r.link.sent({ tool: "reply", ids: [id], question: asksSomething("Should I move swim? Say yes and I'll do it.") });
    expect(r.buttons(id)).toEqual([]);
    expect(holder(r)).not.toBe(id);
    const n = await r.link.notice("The calendar specialist is back. Want me to hand the swim change over again? It waits until you say.");
    expect(r.msg(n).components).toEqual([]);
    expect(holder(r)).not.toBe(n);
    expect(first).toBeTruthy();
  });

  test("a restart finds it where it was", async () => {
    const r = rig();
    const reply = await cainSays(r, "Moved swim to 4:30.");
    const calls = r.calls.length;
    r.restart();
    await r.link.sweep();
    expect(holder(r)).toBe(reply);
    expect(r.calls.slice(calls).filter((c) => c.method === "PATCH")).toEqual([]);
  });
});

describe("Stop and Turn back on", () => {
  test("his Stop tap on it stops everything, the notices go out as today, and the moving Stop comes off", async () => {
    const r = rig();
    const reply = await cainSays(r, "Moved swim to 4:30.");
    expect(await r.tap(structuredClone(r.msg(reply)), STOP)).toBe("to specialist");
    await r.link.whenStopPlaced();
    expect(r.stop.stopped).toBe(true);
    expect(r.harness.some(([p, b]: any) => p === "/press" && b.custom_id === STOP)).toBe(true);
    expect(r.relayed.some((l) => l.includes(" tapped Stop. Everything of yours is stopped"))).toBe(true);
    expect(r.buttons(reply)).toEqual([]);
    expect(holder(r)).toBeUndefined();
    await cainSays(r, "Noted.");                                      // nothing rides on Cain's words while stopped
    expect(holder(r)).toBeUndefined();
  });

  test("a Turn back on on the message holding Stop changes nothing, live or not", async () => {
    const r = rig();
    const reply = await cainSays(r, "Moved swim to 4:30.");
    expect(await r.tap(structuredClone(r.msg(reply)), RESUME)).toBe("refused: that message doesn't carry Turn back on");
    expect(r.stop.stopped).toBe(false);
    expect(r.harness).toEqual([]);
    await r.tap(structuredClone(r.msg(reply)), STOP);
    await r.link.whenStopPlaced();
    await r.tap(structuredClone(r.msg(reply)), RESUME);                // a forged one, after its Stop came off
    expect(r.stop.stopped).toBe(true);
    expect(r.harness.filter(([, b]: any) => b.custom_id === RESUME)).toEqual([]);
  });

  test("while stopped, Turn back on is posted again when it's out of reach: at most hourly, or once he's written", async () => {
    const r = rig();
    r.harnessDown.down = true;                                         // so the link posts its own Stopped notice
    const reply = await cainSays(r, "Moved swim to 4:30.");
    await r.tap(structuredClone(r.msg(reply)), STOP);
    await r.link.whenStopPlaced();
    const stoppedNotice = r.last().id;
    expect(r.buttons(stoppedNotice)).toEqual(["Turn back on"]);
    const posts = () => r.posts();                                     // what the link posts (Cain's replies are his plugin's)
    const before = posts();
    await cainSays(r, "Noted.");
    await cainSays(r, "The swim moved.");
    expect(posts()).toBe(before);                                      // out of reach, but within the hour: no notice again
    r.later(5 * MIN);
    const early = r.his("ok");
    await cainSays(r, "Good.", { replyTo: early.id });                 // he wrote, but the last notice is 5 minutes old
    expect(posts()).toBe(before);
    r.later(6 * MIN);
    const his = r.his("ok, and art?");
    await cainSays(r, "Art stays at 5.", { replyTo: his.id });         // he wrote since, 10 minutes on
    expect(posts()).toBe(before + 1);
    const again = r.last().id;
    expect(r.msg(again).content).toBe(STILL_STOPPED);
    expect(r.buttons(again)).toEqual(["Turn back on"]);
    expect(r.msg(stoppedNotice).components).toEqual([]);               // the older notice's button moved down, with no line
    expect(r.msg(stoppedNotice).content).not.toContain("since");
    await cainSays(r, "Noted.");                                       // the new notice is one of the newest 2
    await cainSays(r, "Noted again.");
    await cainSays(r, "And again.");
    expect(posts()).toBe(before + 1);                                  // never every few messages
    r.later(HOUR + MIN);
    await cainSays(r, "An hour on.");
    expect(posts()).toBe(before + 2);
    expect(r.msg(r.last().id).content).toBe(STILL_STOPPED);
    // Turn back on from the newest notice works, and the moving Stop comes back.
    await r.tap(structuredClone(r.last()), RESUME);
    await r.link.whenStopPlaced();
    expect(r.stop.stopped).toBe(false);
  });

  test("while stopped, a live conversation brings Still stopped down at most every 10 minutes, never every second reply", async () => {
    const r = rig();
    r.harnessDown.down = true;
    const reply = await cainSays(r, "Moved swim to 4:30.");
    await r.tap(structuredClone(r.msg(reply)), STOP);
    await r.link.whenStopPlaced();
    const before = r.posts();
    for (let i = 0; i < 12; i++) {                                     // he and Cain trade a message every 30 seconds
      r.later(30_000);
      const his = r.his(`and ${i}?`);
      await cainSays(r, `Answer ${i}.`, { replyTo: his.id });
    }
    expect(r.posts() - before).toBeLessThanOrEqual(1);                 // 6 minutes: none, or one at most
    for (let i = 0; i < 20; i++) {
      r.later(30_000);
      const his = r.his(`then ${i}?`);
      await cainSays(r, `Then ${i}.`, { replyTo: his.id });
    }
    expect(r.posts() - before).toBeLessThanOrEqual(2);                 // 16 minutes: one every 10 at most
  });

  test("if the Stopped notice fails to post, Turn back on is posted again on each pass until one is up, then hourly again", async () => {
    const r = rig();
    r.harnessDown.down = true;                                         // the link's own notice is the one that says it
    const reply = await cainSays(r, "Moved swim to 4:30.");
    r.failing.add(`POST /channels/${DM}/messages`);
    await r.tap(structuredClone(r.msg(reply)), STOP);
    await r.link.whenStopPlaced();
    const tries = () => r.posts();
    const first = tries();                                             // its own notice, tried once and lost
    await cainSays(r, "Noted.");
    expect(tries()).toBe(first);                                       // within the minute its own notice gets: nothing
    r.later(61_000);
    await r.link.sweep();
    expect(tries()).toBe(first + 1);                                   // none up anywhere: tried at once
    await r.link.sweep();
    expect(tries()).toBe(first + 2);                                   // and again on the next pass
    r.failing.clear();
    await r.link.sweep();
    expect(r.msg(r.last().id)).toMatchObject({ content: STILL_STOPPED });
    expect(r.buttons(r.last().id)).toEqual(["Turn back on"]);
    const up = tries();
    for (let i = 0; i < 4; i++) await cainSays(r, `Reply ${i}.`);      // out of reach now, but one is up: the hour holds
    await r.link.sweep();
    expect(tries()).toBe(up);
  });

  test("after Turn back on, the moving Stop returns", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    const [, , , , r5] = await replies(r, 5);
    expect(holder(r)).toBe(r5);
    await r.tap(structuredClone(r.msg(morning)), STOP);
    await r.link.whenStopPlaced();
    expect(r.buttons(r5)).toEqual([]);
    expect(r.buttons(morning)).toEqual(["Turn back on"]);
    await r.tap(structuredClone(r.msg(morning)), RESUME);
    await r.link.whenStopPlaced();
    expect(r.stop.stopped).toBe(false);
    expect(holder(r)).toBe(r5);
    expect(r.buttons(r5)).toEqual(["Stop"]);
  });
});
