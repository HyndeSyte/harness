// A specialist's card is the specialist talking to him (Cain 0.7.2). The item Cain
// files it under is only a label: it lets a newer card for the same item and question
// replace an older one, and it's kept for the record. So no hold and no closed item
// stops the card going out, takes its buttons off, or turns a tap on it away. It ends
// only when it's answered, expires, is replaced or is forgotten. Cain's own asks and
// Ship cards keep their hold and closed checks. And a card with buttons reaches him
// within its life whatever Cain is doing: if Cain hasn't shown it within about 2
// minutes, it goes out by itself.
import { describe, expect, test } from "bun:test";
import { EXPIRED_TAP, RESUME, STOP } from "../rootfs/opt/cain/link/core";
import { DM, HOUR, keeperHolds, MIN, pendingWith, PR, rig, SHA1 } from "./link-rig";

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
const byItself = (card: number, message: string) =>
  `Card ${card} went out to him by itself (Discord message ${message}): you hadn't shown it within 2 minutes. Don't show it again. Nothing to tell him.`;

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
    expect(r.state().messages[id]).toMatchObject({ kind: "card", card, item: "none", question: "", buttons: true, expires: LAPSES });
    expect(r.relayed).toEqual([byItself(card, id)]);
    r.later(MIN);
    await r.link.sweep();
    expect(await r.link.show(card, { item: "P49" })).toBe(id);       // a late show from Cain: the same message
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
  });

  test("(f) one without buttons keeps waiting for Cain, and Stop notices still go straight out, once", async () => {
    const r = evening();
    const plain = await r.link.addCard({ text: "Moved the call to Thu 2 PM.", rows: [] });
    expect(r.relayed[0]).toContain("fold it into the morning message");
    r.later(3 * MIN);
    await r.link.sweep();
    r.later(HOUR);
    await r.link.sweep();
    expect(r.cards()).toEqual([]);
    expect(r.state().cards[plain].shown).toBeNull();
    const id = await r.link.show(plain, { item: "none" });           // still Cain's to show, whenever he likes
    expect(r.msg(id).content).toBe("Moved the call to Thu 2 PM.");
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
    test(`(g) Cain's show and the sweep at the same moment make one Discord message (${first} first)`, async () => {
      const r = evening({ holds: null });
      await r.link.sweep();                                           // the link's sweep at start
      const card = await approval(r);
      r.relayed.length = 0;
      r.later(2 * MIN);                                               // it's due to go out by itself...
      r.gate.posts = true;                                            // ...and Discord is slow to answer
      const go = { Cain: () => r.link.show(card, { item: "P49" }), "the sweep": () => r.link.sweep() };
      const one = go[first](), other = go[first === "Cain" ? "the sweep" : "Cain"]();
      for (let i = 0; i < 100 && r.posts() < 2; i++) await tick();
      expect(r.posts()).toBe(2);                                      // both asked Discord before either heard back
      r.release();
      await Promise.all([one, other]);
      expect(r.cards().length).toBe(1);                               // one message: the card's own nonce
      const id = r.cards()[0].id;
      expect(r.state().cards[card].shown).toBe(id);
      expect(Object.keys(r.state().messages)).toEqual([id]);
      // Whoever asked Discord first records it; the other gets the same message back.
      expect(r.state().messages[id].item).toBe(first === "Cain" ? "P49" : "none");
      expect(r.relayed).toEqual(first === "Cain" ? [] : [byItself(card, id)]);
      expect(await r.link.show(card, { item: "P49" })).toBe(id);
      r.later(MIN);
      await r.link.sweep();
      expect(r.cards().length).toBe(1);
      expect(r.relayed.length).toBe(first === "Cain" ? 0 : 1);
    });
  }

  test("(h) one whose own expiry passed before it went out is never posted, and is marked expired", async () => {
    const r = evening();
    const short = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: new Date(NOV11_644PM + MIN).toISOString() });
    const card = await approval(r);                                   // 15 minutes
    r.relayed.length = 0;
    r.later(MIN);
    await r.link.sweep();                                             // the one-minute card lapses before it's due
    expect(r.state().cards[short]).toMatchObject({ shown: null, outcome: "expired" });
    r.restart();                                                      // the link is down until the other has lapsed too
    r.later(20 * MIN);
    await r.link.sweep();
    expect(r.cards()).toEqual([]);
    expect(r.state().cards[card]).toMatchObject({ shown: null, outcome: "expired" });
    expect(r.relayed).toEqual([]);                                    // as the sweep does with a specialist's card: nothing for Cain
    await expect(r.link.show(card, { item: "P49" })).rejects.toThrow(`card ${card} expired before it went out; nothing was posted`);
    const late = await r.link.addCard({ text: TEXT, rows: ROWS, kind: "card", expires: new Date(r.t.now + MIN).toISOString() });
    r.later(MIN);                                                     // Cain shows it after it lapsed, before any sweep
    await expect(r.link.show(late, { item: "none" })).rejects.toThrow("expired before it went out");
    expect(r.state().cards[late].outcome).toBe("expired");
    expect(r.cards()).toEqual([]);
    expect(r.posts()).toBe(0);
  });
});
