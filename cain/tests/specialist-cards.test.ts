// A specialist's card is the specialist talking to him (Cain 0.7.2). The item Cain
// files it under is only a label: it lets a newer card for the same item and question
// replace an older one, and it's kept for the record. So no hold and no closed item
// stops the card going out, takes its buttons off, or turns a tap on it away. It ends
// only when it's answered, expires, is replaced or is forgotten. Cain's own asks and
// Ship cards keep their hold and closed checks. And a card with buttons reaches him
// within its life whatever Cain is doing: if Cain hasn't shown it within about 2
// minutes, it goes out by itself, and Cain is told when one can't.
import { describe, expect, test } from "bun:test";
import { digest, EXPIRED_TAP, excerpt, RESUME, STOP } from "../rootfs/opt/cain/link/core";
import { BOT, DAY, DM, HOUR, keeperHolds, MIN, pendingWith, PR, rig, SHA1 } from "./link-rig";

const NOV11_644PM = Date.UTC(2026, 10, 11, 23, 44);                  // Wed Nov 11 2026, 6:44 PM local
const LAPSES = NOV11_644PM + 15 * MIN;                               // the card's own 15 minutes
// The calendar specialist's approval card as the Harness builds it: Approve and
// Decline, its Stop row, and an expiry.
const TEXT = "Approve the change? Only your tap applies it. *Expires in 15 min.*";
const ROWS = [
  { type: 1, components: [{ type: 2, style: 2, label: "Approve", custom_id: "k:c:ok49" },
                          { type: 2, style: 2, label: "Decline", custom_id: "k:c:no49" }] },
  { type: 1, components: [{ type: 2, style: 2, label: "Stop", custom_id: STOP }] },
];
const BUTTONS = ["Approve", "Decline", "Stop"];
const elsewhere = (item: string) => keeperHolds({ [item]: { holder: "laptop:s1" } });
const snap = (m: any) => structuredClone(m);                         // the card as his phone shows it
const tick = () => new Promise((ok) => setTimeout(ok, 0));
// What Cain is told about a card the link handles by itself, with what it was.
const byItself = (card: number, message: string, text = TEXT) =>
  `Card ${card} ("${excerpt(text, 60)}") went out to him by itself (Discord message ${message}): you hadn't shown it within 2 minutes. Showing it now only files it under its item and question; it won't go out twice. Nothing to tell him.`;
const failed = (card: number, why: string, text = TEXT, expires = true) =>
  `Card ${card} ("${excerpt(text, 60)}") didn't go out: ${why}. I'll keep trying${expires ? " until it expires" : ""}.`;
const lapsed = (card: number, text = TEXT) =>
  `Card ${card} ("${excerpt(text, 60)}") expired before it reached him. Tell him in your own words, or ask the specialist to send it again.`;
// A receipt for something the specialist already did, with its Undo.
const RECEIPT = "Moved the call to Thu 2 PM.";
const UNDO = [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:undo1" }] }];
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await tick(); };

// That evening: P49 and P50 open in the record, and P49 held by a laptop session.
const evening = (o: { holds?: string | null; pending?: string | null } = {}) =>
  rig({ now: NOV11_644PM, pending: pendingWith(["P49", "P50"], []), holds: elsewhere("P49"), ...o });
const approval = (r: ReturnType<typeof rig>) =>
  r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: new Date(LAPSES).toISOString() });
async function asked(r: ReturnType<typeof rig>, item: string, question = "Q1"): Promise<string> {
  const out = await r.link.ask({ text: `${item} ${question}: Filed?`, options: ["Filed", "Not filed"], item, question });
  if (out.status !== "posted") throw new Error(`not posted: ${out.said}`);
  return out.message;
}

describe("(a) a specialist's card goes out whoever holds its item", () => {
  test("Nov 11, 6:44 PM: the approval card filed under P49, which another session holds, is posted", async () => {
    const r = evening();
    const card = await approval(r);
    expect(Object.keys(r.posted)).toEqual([]);                        // it waits for Cain
    const id = await r.link.show(card, { item: "P49" });             // keeper.sh show <card> --item P49
    expect(id).toMatch(/^\d{15,22}$/);                                // a Discord message id
    expect(r.msg(id).content).toBe(TEXT);                             // unchanged
    expect(r.buttons(id)).toEqual(BUTTONS);
    expect(r.state().messages[id]).toMatchObject({ kind: "card", card, item: "P49", buttons: true, expires: LAPSES });
    expect(r.link.cardInfo(id)).toEqual({ card, item: "P49", question: null });
    expect(await r.link.show(card, { item: "P49" })).toBe(id);       // shown once
    expect(r.cards().length).toBe(1);
  });

  test("...and under an item that's closed, or while the holds can't be read", async () => {
    const closed = evening({ holds: null, pending: pendingWith(["P50"], ["P49"]) });
    expect(closed.buttons(await closed.link.show(await approval(closed), { item: "P49" }))).toEqual(BUTTONS);
    const unread = evening({ holds: "{half a fi" });
    expect(unread.buttons(await unread.link.show(await approval(unread), { item: "P49" }))).toEqual(BUTTONS);
  });

  test("its item is still checked for shape", async () => {
    const r = evening();
    const card = await approval(r);
    await expect(r.link.show(card, {})).rejects.toThrow("needs an item");
    await expect(r.link.show(card, { item: "P 49" })).rejects.toThrow("PENDING id");
    expect(Object.keys(r.posted)).toEqual([]);
  });

  test("the line Cain gets for it says the item is only a label", async () => {
    const r = evening();
    const card = await approval(r);
    expect(r.relayed).toHaveLength(1);
    expect(r.relayed[0]).toContain(`It has buttons: show it now, or it goes out by itself in about 2 minutes. Run /opt/cain/keeper.sh show ${card} --item`);
    expect(r.relayed[0]).toEndWith("The item is only its label: the card goes out whoever holds the item, open or closed.");
    await r.link.addCard({ text: "Long words. ".repeat(200), rows: ROWS });
    expect(r.relayed[1].length).toBeLessThanOrEqual(600);             // main.ts cuts a relayed line at 600 characters
    expect(r.relayed[1]).toEndWith("open or closed.");
  });
});

describe("(b) once it's up, a specialist's card keeps its buttons whoever holds its item", () => {
  test("the Nov 11 card keeps its buttons while P49 is held elsewhere and after P49 closes, until its own 15 minutes are up", async () => {
    const r = evening();
    const id = await r.link.show(await approval(r), { item: "P49" });
    r.relayed.length = 0;
    r.later(MIN);
    await r.link.sweep();                                             // 6:45, P49 still held by the laptop session
    expect(r.buttons(id)).toEqual(BUTTONS);
    r.files.pending = pendingWith(["P50"], ["P49"]);                  // P49 closes
    r.later(MIN);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(BUTTONS);
    r.t.now = LAPSES - 1;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(BUTTONS);
    expect(r.state().messages[id].outcome).toBeUndefined();
    r.t.now = LAPSES;                                                 // 6:59: its own expiry
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toBe(`${TEXT}\n\nExpired`);
    expect(r.state().messages[id]).toMatchObject({ outcome: "expired", why: "expired", buttons: false });
    expect(r.relayed).toEqual([]);                                    // a specialist's card: nothing for Cain
  });

  test("a card already up keeps its buttons when its item moves to another session, and when it closes", async () => {
    const r = evening({ holds: null });                               // P49 is free when the card goes up
    const id = await r.link.show(await approval(r), { item: "P49" });
    r.files.holds = elsewhere("P49");
    r.later(MIN);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(BUTTONS);
    r.files.pending = pendingWith(["P50"], ["P49"]);
    r.later(MIN);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(BUTTONS);
    expect(r.calls.filter((c) => c.method === "PATCH")).toEqual([]);   // never touched
    expect(r.relayed.filter((l) => l.includes("taken off"))).toEqual([]);
  });

  test("a newer card for the same item and question still replaces it", async () => {
    const r = evening();
    const first = await r.link.show(await approval(r), { item: "P49", question: "Q1" });
    const second = await r.link.show(await approval(r), { item: "P49", question: "Q1" });
    expect(r.buttons(first)).toEqual([]);
    expect(r.msg(first).content).toBe(`${TEXT}\n\nReplaced by a newer card`);
    expect(r.buttons(second)).toEqual(BUTTONS);
  });

  test("a tap on it still reaches the specialist once its item is held elsewhere, or closed", async () => {
    const r = evening({ holds: null });
    const held = await approval(r), done = await approval(r);
    const a = await r.link.show(held, { item: "P49" });
    const b = await r.link.show(done, { item: "P50" });
    r.files.holds = elsewhere("P49");
    r.files.pending = pendingWith(["P49"], ["P50"]);
    expect(await r.tap(snap(r.msg(a)), "k:c:ok49")).toBe("to specialist");
    expect(await r.tap(snap(r.msg(b)), "k:c:no49")).toBe("to specialist");
    expect(r.harness.map(([path, body]) => [path, body.custom_id, body.message_id]))
      .toEqual([["/press", "k:c:ok49", held], ["/press", "k:c:no49", done]]);
    expect(r.ephemerals()).toEqual([]);                               // never "This card expired"
    expect(r.state().messages[a].outcome).toBeUndefined();
    expect(r.state().messages[b].outcome).toBeUndefined();
  });
});

describe("(c) Cain's own asks and Ship cards keep the hold and closed checks", () => {
  test("an ask or a Ship card under an item another session holds is refused, and so is an ask under a closed item", async () => {
    const r = evening({ pending: pendingWith(["P49"], ["P50"]) });
    await expect(asked(r, "P49")).rejects.toThrow("held by another session");
    await expect(r.link.ship({ text: "P49: ready.", item: "P49", pr: PR, head: SHA1 })).rejects.toThrow("held by another session");
    await expect(asked(r, "P50")).rejects.toThrow("P50 is closed");
    expect(Object.keys(r.posted)).toEqual([]);
  });

  test("an open ask and a Ship card lose their buttons when their item moves to another session, and Cain is told", async () => {
    const r = evening({ holds: null });
    const a = await asked(r, "P49");
    const s = ((await r.link.ship({ text: "P49: ready.", item: "P49", pr: PR, head: SHA1 })) as any).message as string;
    r.files.holds = elsewhere("P49");
    await r.link.sweep();
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content).toBe("P49 Q1: Filed?\n\nExpired");
    expect(r.buttons(s)).toEqual([]);
    expect(r.relayed).toEqual([
      `Your question P49 Q1 (Discord message ${a}) was taken off: P49 is now held by another session. Don't ask him about it or say who has it. Nothing to tell him.`,
      `Your Ship card for ${PR} (Discord message ${s}) was taken off: P49 is now held by another session. Don't ask him about it or say who has it. Nothing to tell him.`,
    ]);
  });

  test("an open ask loses its buttons when its item closes, and Cain is told", async () => {
    const r = evening({ holds: null });
    const a = await asked(r, "P49");
    r.files.pending = pendingWith(["P50"], ["P49"]);
    await r.link.sweep();
    expect(r.buttons(a)).toEqual([]);
    expect(r.relayed).toEqual([`Your question P49 Q1 (Discord message ${a}) was taken off: P49 is closed in PENDING.md. Nothing to tell him.`]);
  });

  test("a tap on Cain's ask after its item moved does nothing, and a held ask whose item moved is dropped unasked", async () => {
    const r = evening({ holds: null });
    const open = await asked(r, "P49");
    expect((await r.link.ask({ text: "P50 Q1: Signed?", options: ["Signed"], item: "P50", question: "Q1" })).status).toBe("held");
    const m = snap(r.msg(open));
    r.files.holds = keeperHolds({ P49: { holder: "laptop:s1" }, P50: { holder: "laptop:s2" } });
    expect(await r.tap(m, r.ids(open)[0])).toBe("dead: held elsewhere");
    expect(r.ephemerals().at(-1).content).toBe(EXPIRED_TAP);
    expect(r.harness).toEqual([]);
    await r.link.sweep();
    expect(r.state().held).toEqual([]);
    expect(r.cards().length).toBe(1);                                 // P50's ask never went out
    expect(r.relayed).toEqual(["Your held question P50 Q1 was dropped unasked: P50 is now held by another session. Don't ask him about it or say who has it. Nothing to tell him."]);
  });
});

describe("a card with buttons goes out within about 2 minutes, whatever Cain is doing", () => {
  test("(d) one Cain hasn't shown goes out by itself about 2 minutes after it came, under no item, and Cain is told once", async () => {
    const r = evening();
    await r.link.sweep();                                             // the link's sweep at start
    const card = await approval(r);                                   // Cain is busy with something else
    r.relayed.length = 0;
    r.later(MIN);
    await r.link.sweep();
    expect(r.cards()).toEqual([]);                                    // a minute in: still Cain's to show
    r.later(MIN);
    await r.link.sweep();                                             // two minutes in: out by itself
    expect(r.cards().length).toBe(1);
    const id = r.cards()[0].id;
    expect(r.msg(id).content).toBe(TEXT);                             // unchanged
    expect(r.buttons(id)).toEqual(BUTTONS);
    expect(r.state().cards[card].shown).toBe(id);
    expect(r.state().messages[id]).toMatchObject({ kind: "card", card, item: "none", question: "", buttons: true, expires: LAPSES, byItself: true });
    expect(r.relayed).toEqual([byItself(card, id)]);
    r.later(MIN);
    await r.link.sweep();
    // His late show (the old "show it now" line) posts nothing; it only files it.
    expect(await r.link.showCard(card, { item: "P49" })).toEqual({ status: "already out", message: id,
      said: "It had gone out by itself; this only filed it under P49, and nothing more was posted. Write no lead-in for it." });
    expect(r.link.cardInfo(id)).toEqual({ card, item: "P49", question: null });
    expect(r.cards().length).toBe(1);
    expect(r.posts()).toBe(1);
    expect(r.relayed).toEqual([byItself(card, id)]);                  // told once
  });

  test("(e) one Cain shows within the 2 minutes goes out once, and the sweep leaves it be", async () => {
    const r = evening({ holds: null });
    const card = await approval(r);
    r.later(90_000);
    const id = await r.link.show(card, { item: "P49" });
    r.relayed.length = 0;
    for (let i = 0; i < 3; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.cards().length).toBe(1);
    expect(r.posts()).toBe(1);                                        // Discord was asked once
    expect(r.state().messages[id].item).toBe("P49");                  // Cain's own label stays
    expect(r.relayed).toEqual([]);
    expect(await r.link.showCard(card, { item: "P50" })).toEqual({ status: "already out", message: id,
      said: "It's already in front of him; nothing more was posted." });
    expect(r.state().messages[id].item).toBe("P49");                  // a second show of his doesn't relabel it
  });

  test("(f) one without buttons keeps waiting for Cain, and Stop notices still go straight out, once", async () => {
    const r = evening();
    const plain = await r.link.addCard({ text: RECEIPT, rows: [] });
    expect(r.relayed[0]).toContain("fold it into the morning message");
    r.later(3 * MIN);
    await r.link.sweep();
    r.later(HOUR);
    await r.link.sweep();
    expect(r.cards()).toEqual([]);
    expect(r.state().cards[plain].shown).toBeNull();
    const id = await r.link.show(plain, { item: "none" });           // still Cain's to show, whenever he likes
    expect(r.msg(id).content).toBe(RECEIPT);
    const turnBackOn = [{ type: 1, components: [{ type: 2, style: 2, label: "Turn back on", custom_id: RESUME }] }];
    await r.link.addCard({ text: "Stopped.", rows: turnBackOn, kind: "stopped" });
    expect(r.cards().length).toBe(2);                                 // straight out
    r.failing.add(`POST /channels/${DM}/messages`);
    await expect(r.link.addCard({ text: "Stopped.", rows: turnBackOn, kind: "stopped" })).rejects.toThrow("discord 500");
    r.failing.clear();                                                // the specialist sends it again itself
    r.later(3 * MIN);
    await r.link.sweep();
    expect(r.cards().length).toBe(2);                                 // the sweep posts neither again
  });

  for (const first of ["Cain", "the sweep"] as const) {
    test(`(g) Cain's show and the sweep at the same moment post once, one Discord message (${first} first)`, async () => {
      const r = evening({ holds: null });
      await r.link.sweep();                                           // the link's sweep at start
      const card = await approval(r);
      r.relayed.length = 0;
      r.later(2 * MIN);                                               // it's due to go out by itself...
      r.gate.posts = true;                                            // ...and Discord is slow to answer
      const go = { Cain: () => r.link.show(card, { item: "P49" }), "the sweep": () => r.link.sweep() };
      const one = go[first]();
      await until(() => r.posts() === 1);
      const other = go[first === "Cain" ? "the sweep" : "Cain"]();
      for (let i = 0; i < 20; i++) await tick();                     // every chance for the other to post too
      expect(r.posts()).toBe(1);                                      // it waits for the first: one post, not two
      r.release();
      await Promise.all([one, other]);
      expect(r.cards().length).toBe(1);
      const id = r.cards()[0].id;
      expect(r.state().cards[card].shown).toBe(id);
      expect(Object.keys(r.state().messages)).toEqual([id]);
      expect(r.state().messages[id].item).toBe("P49");                // Cain's item, whoever posted it
      expect(r.relayed).toEqual(first === "Cain" ? [] : [byItself(card, id)]);
      r.later(MIN);
      await r.link.sweep();
      expect(r.posts()).toBe(1);
    });
  }

  test("(g) its life ending while its post is on its way leaves no second message and nothing unrecorded", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const card = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: new Date(NOV11_644PM + 150_000).toISOString() });
    r.later(2 * MIN);
    r.gate.posts = true;
    const swept = r.link.sweep();                                     // the sweep posts it by itself...
    await until(() => r.posts() === 1);
    const mine = r.link.show(card, { item: "P49" });                 // ...Cain's show joins...
    r.later(MIN);                                                     // ...and its 2.5 minutes run out meanwhile
    for (let i = 0; i < 20; i++) await tick();
    r.release();
    await Promise.all([swept, mine]);
    await r.link.sweep();
    expect(r.posts()).toBe(1);
    expect(r.cards().length).toBe(1);
    for (const m of r.cards()) expect(r.state().messages[m.id]?.card).toBe(card);   // nothing on Discord the link doesn't know
    expect(r.buttons(r.cards()[0].id)).toEqual([]);                   // and it expired on time
  });

  test("(h) one whose own expiry passed before it went out is never posted; it's marked expired, and Cain hears what it was", async () => {
    const r = evening();
    const short = await r.link.addCard({ text: RECEIPT, rows: UNDO, kind: "reply", expires: new Date(NOV11_644PM + MIN).toISOString() });
    const card = await approval(r);                                   // 15 minutes
    r.relayed.length = 0;
    r.later(MIN);
    await r.link.sweep();                                             // the one-minute receipt lapses before it's due
    expect(r.state().cards[short]).toMatchObject({ shown: null, outcome: "expired" });
    expect(r.relayed).toEqual([lapsed(short, RECEIPT)]);              // says what it was, so he can tell the owner
    r.restart();                                                      // the link is down until the other has lapsed too
    r.later(20 * MIN);
    await r.link.sweep();
    await r.link.sweep();
    expect(r.cards()).toEqual([]);
    expect(r.state().cards[card]).toMatchObject({ shown: null, outcome: "expired" });
    expect(r.relayed).toEqual([lapsed(short, RECEIPT), lapsed(card)]);   // once each
    await expect(r.link.show(card, { item: "P49" })).rejects.toThrow(
      `card ${card} ("${excerpt(TEXT, 60)}") expired before it reached him; nothing was posted. Tell him in your own words, or ask the specialist to send it again.`);
    const late = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: new Date(r.t.now + MIN).toISOString() });
    r.later(MIN);                                                     // Cain shows it after it lapsed, before any sweep
    await expect(r.link.show(late, { item: "none" })).rejects.toThrow("expired before it reached him");
    expect(r.state().cards[late].outcome).toBe("expired");
    await r.link.sweep();
    expect(r.relayed.length).toBe(3);                                 // his show was told; the sweep adds nothing
    expect(r.posts()).toBe(0);
  });

  test("(i) one that can't go out: Cain hears once what it was and why, the link keeps trying, and he hears when it lapses", async () => {
    const r = evening();
    await r.link.sweep();
    const card = await approval(r);                                   // 15 minutes
    r.relayed.length = 0;
    r.limited.add(`POST /channels/${DM}/messages`);                   // first Discord's rate limit: nothing to tell
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.relayed).toEqual([]);
    r.limited.clear();
    r.failing.add(`POST /channels/${DM}/messages`);                   // then it refuses outright
    r.later(MIN);
    await r.link.sweep();
    expect(r.relayed).toEqual([failed(card, "discord 500: unavailable")]);
    for (let i = 0; i < 5; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.relayed).toEqual([failed(card, "discord 500: unavailable")]);   // once, though it kept trying
    r.t.now = LAPSES;
    await r.link.sweep();
    expect(r.relayed).toEqual([failed(card, "discord 500: unavailable"), lapsed(card)]);
    expect(r.cards()).toEqual([]);
  });

  test("(j) one with no expiry that keeps failing is told once, not tried silently forever, and goes out when Discord is back", async () => {
    const r = evening();
    await r.link.sweep();
    const today = "Today: 9:00 call, 2:00 review.";
    const stop = [{ type: 1, components: [{ type: 2, style: 2, label: "Stop", custom_id: STOP }] }];
    const card = await r.link.addCard({ text: today, rows: stop, kind: "digest" });   // its only button is Stop; no expiry
    r.relayed.length = 0;
    r.failing.add(`POST /channels/${DM}/messages`);
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.relayed).toEqual([failed(card, "discord 500: unavailable", today, false)]);
    for (let i = 0; i < 30; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.relayed.length).toBe(1);
    r.failing.clear();
    r.later(MIN);
    await r.link.sweep();
    expect(r.cards().length).toBe(1);
    expect(r.relayed).toEqual([failed(card, "discord 500: unavailable", today, false), byItself(card, r.cards()[0].id, today)]);
  });
});

describe("a card that went out by itself is still filed and replaceable", () => {
  const TEXT2 = "Approve the new time? Only your tap applies it. *Expires in 15 min.*";
  const ROWS2 = [{ type: 1, components: [{ type: 2, style: 2, label: "Approve", custom_id: "k:c:ok50" },
                                         { type: 2, style: 2, label: "Decline", custom_id: "k:c:no50" }] }];
  const second = (r: ReturnType<typeof rig>) =>
    r.link.addCard({ text: TEXT2, rows: ROWS2, kind: "card", expires: new Date(r.t.now + 15 * MIN).toISOString() });
  const live = (r: ReturnType<typeof rig>) => r.cards().filter((m: any) => r.buttons(m.id).length).map((m: any) => m.id);

  test("(k) v1 goes out by itself, Cain's late show files it under P49 Q1, and v2 shown under P49 Q1 replaces it: one live card", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const v1 = await approval(r);
    r.later(2 * MIN);
    await r.link.sweep();                                             // v1 out by itself, under no item
    const m1 = r.cards()[0].id;
    expect(r.link.cardInfo(m1)).toEqual({ card: v1, item: "none", question: null });
    expect((await r.link.showCard(v1, { item: "P49", question: "Q1" })).status).toBe("already out");
    expect(r.posts()).toBe(1);
    expect(r.link.cardInfo(m1)).toEqual({ card: v1, item: "P49", question: "Q1" });   // /card-of
    const reply = r.his("approved?", m1);
    expect(await r.link.replied(reply.id)).toMatchObject({ reply_to: m1, card: v1, item: "P49", question: "Q1" });
    r.later(MIN);
    const m2 = await r.link.show(await second(r), { item: "P49", question: "Q1" });
    expect(live(r)).toEqual([m2]);
    expect(r.msg(m1).content).toBe(`${TEXT}\n\nReplaced by a newer card`);
  });

  test("(k) ...and when v2 was shown first, filing v1 late makes v1 give way, not v2", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const v1 = await approval(r);
    r.later(2 * MIN);
    await r.link.sweep();                                             // v1 out by itself
    const m1 = r.cards()[0].id;
    r.later(MIN);
    const m2 = await r.link.show(await second(r), { item: "P49", question: "Q1" });
    await r.link.show(v1, { item: "P49", question: "Q1" });          // the old line about v1 comes last
    expect(live(r)).toEqual([m2]);
    expect(r.msg(m1).content).toBe(`${TEXT}\n\nReplaced by a newer card`);
  });
});

describe("a card's buttons and record stay true", () => {
  test("(l) buttons the specialist changes while the card is on its way are what he gets, and what the link records", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const stopOnly = [{ type: 1, components: [{ type: 2, style: 2, label: "Stop", custom_id: STOP }] }];
    const card = await approval(r);
    r.gate.posts = true;
    const shown = r.link.show(card, { item: "P49" });
    await until(() => r.posts() === 1);
    await r.link.editButtons(card, stopOnly);                         // the specialist acts while Discord is slow
    r.release();
    const id = await shown;
    expect(r.buttons(id)).toEqual(["Stop"]);                          // the message follows
    expect(r.state().messages[id].buttons).toBe(true);
    expect(await r.tap(snap(r.msg(id)), STOP)).toBe("to specialist");   // and its record matches what he sees
    const other = await approval(r);
    r.gate.posts = true;
    const shown2 = r.link.show(other, { item: "none" });
    await until(() => r.posts() === 2);
    await r.link.editButtons(other, []);                              // all its buttons gone in flight
    r.release();
    const id2 = await shown2;
    expect(r.buttons(id2)).toEqual([]);
    expect(r.state().messages[id2].buttons).toBe(false);
  });

  test("(m) buttons taken off before the 2 minutes are up: it waits for Cain; buttons added later: 2 minutes from then", async () => {
    const r = evening();
    await r.link.sweep();
    const card = await approval(r);
    r.later(MIN);
    await r.link.editButtons(card, []);                               // the specialist took them off
    for (let i = 0; i < 3; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.cards()).toEqual([]);
    expect(r.state().cards[card].due).toBeNull();
    const plain = await r.link.addCard({ text: RECEIPT, rows: [] });
    r.later(5 * MIN);
    await r.link.editButtons(plain, UNDO);                            // it gained an Undo
    r.later(MIN);
    await r.link.sweep();
    expect(r.cards()).toEqual([]);
    r.later(MIN);
    await r.link.sweep();                                             // 2 minutes after it gained it
    expect(r.cards().length).toBe(1);
    expect(r.buttons(r.cards()[0].id)).toEqual(["Undo"]);
  });

  test("(n) an expiry given in seconds is read as seconds; one that isn't a time is logged once, and the card has none", async () => {
    const r = evening();
    const secs = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: Math.floor(LAPSES / 1000) });
    expect(r.state().cards[secs].expires).toBe(LAPSES);
    const odd = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: "in a bit" });
    expect(r.state().cards[odd].expires).toBeNull();
    for (let i = 0; i < 3; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.logs.filter((l) => l.includes("isn't a time"))).toEqual([`[cain] link: card ${odd}: its expiry isn't a time (in a bit), so it has none`]);
  });

  test("(o) a card stored before this version (no due time) is never posted by itself", async () => {
    const r = evening();
    const s = r.state();
    s.cards["77"] = { text: TEXT, rows: ROWS, kind: "card", created: NOV11_644PM - 10 * MIN, shown: null, expires: LAPSES };
    r.setState(s);
    for (let i = 0; i < 5; i++) { r.later(MIN); await r.link.sweep(); }
    expect(r.cards()).toEqual([]);
    expect(r.relayed).toEqual([]);
    expect(await r.link.show(77, { item: "none" })).toBeTruthy();     // still Cain's to show
  });

  test("(p) a tap on a specialist's card from before 0.7.0 (no kind on its record) still reaches the specialist", async () => {
    const r = evening();                                              // P49 held elsewhere, and no sweep has run yet
    const id = r.snowflake(NOV11_644PM - DAY);
    r.posted[id] = { id, content: TEXT, author: { id: BOT }, components: ROWS };
    const s = r.state();
    s.migrated = undefined as any;
    s.cards["77"] = { text: TEXT, rows: ROWS, kind: "card", created: NOV11_644PM - DAY, shown: id };
    s.messages[id] = { digest: digest(TEXT, ROWS), until: NOV11_644PM + 34 * DAY, card: 77 };
    r.setState(s);
    expect(await r.tap(snap(r.posted[id]), "k:c:ok49")).toBe("to specialist");
    expect(r.harness[0][1]).toMatchObject({ custom_id: "k:c:ok49", message_id: 77 });
  });

  test("(q) a post whose answer was lost, tried again after Discord's nonce forgot it, is found in his DM, not posted twice", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const card = await approval(r);
    r.relayed.length = 0;
    r.lose.posts = 1;                                                 // Discord makes it, but its answer never comes
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.cards().length).toBe(1);
    expect(r.state().cards[card].shown).toBeNull();
    r.failing.add(`/channels/${DM}/messages`);                        // then Discord is down for 6 minutes
    for (let i = 0; i < 6; i++) { r.later(MIN); await r.link.sweep(); }
    r.failing.clear();
    r.later(MIN);
    await r.link.sweep();
    expect(r.cards().length).toBe(1);                                 // the same message, found and recorded
    const id = r.cards()[0].id;
    expect(r.state().cards[card].shown).toBe(id);
    expect(r.relayed).toEqual([failed(card, "TimeoutError: The operation timed out."), byItself(card, id)]);
  });

  test("(q) ...and one whose life ran out meanwhile is found too, so Cain is never told it didn't reach him", async () => {
    const r = evening({ holds: null });
    await r.link.sweep();
    const card = await approval(r);                                   // 15 minutes
    r.relayed.length = 0;
    r.lose.posts = 1;
    r.later(2 * MIN);
    await r.link.sweep();                                             // on Discord, but the link never heard
    r.failing.add(`/channels/${DM}/messages`);
    for (let i = 0; i < 15; i++) { r.later(MIN); await r.link.sweep(); }   // down until past its expiry
    r.failing.clear();
    r.later(MIN);
    await r.link.sweep();
    const id = r.cards()[0].id;
    expect(r.cards().length).toBe(1);
    expect(r.state().cards[card]).toMatchObject({ shown: id });
    expect(r.relayed).toEqual([failed(card, "TimeoutError: The operation timed out."), byItself(card, id)]);
    expect(r.relayed.join("\n")).not.toContain("expired before it reached him");
    expect(r.buttons(id)).toEqual([]);                                // its buttons come off: it has expired
  });
});
