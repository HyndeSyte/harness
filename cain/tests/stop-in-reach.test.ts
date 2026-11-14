// Stop within reach (Cain 0.10.0, link/core.ts): one red Stop on the newest plain bot
// message (Cain's reply, or a notice of the link's, that asks nothing), never on a card
// that asks something. It moves only when none of the newest 5 bot messages carries a Stop,
// Stop first on the new message and then off the old, and only when Discord is quiet. While
// stopped it comes off, and Turn back on is kept within reach instead.
import { describe, expect, test } from "bun:test";
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
    const his = r.his("ok, and art?");
    await cainSays(r, "Art stays at 5.", { replyTo: his.id });         // he wrote since
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
