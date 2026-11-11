// Cards that clean up after themselves (Cain 0.7.0): each card's item, question and
// expiry; the sweep; taps on dead cards; replies in the thread; one ask at a time.
import { describe, expect, test } from "bun:test";
import { BUILD, decide, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { closedItems, EXPIRED_TAP, nextCheckin, parseHolds, STOP } from "../rootfs/opt/cain/link/core";
import { BOT, DAY, DM, HOUR, MIN, NOV11_8AM, OWNER, PR, pendingWith, rig, SHA1, SHA2 } from "./link-rig";

const undoRows = [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:abc" },
                                           { type: 2, style: 2, label: "Stop", custom_id: STOP }] }];
const laptopHolds = (item: string, branches: string[] = []) =>
  JSON.stringify({ [item]: { holder: "laptop:s1", for: "his chat", branches, taken: "x", renewed: "x" } });
const snap = (m: any) => structuredClone(m);                         // the card as his phone shows it
const nyTime = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" });

async function ask(r: ReturnType<typeof rig>, item: string, question = "", text = `${item} ${question}: Filed?`,
                   options = ["Filed", "Not filed", "Not sure"], replyTo?: string) {
  const out = await r.link.ask({ text, options, item, question, replyTo });
  return out.status === "posted" ? out.message : "";
}

describe("the check-in clock", () => {
  test("an ask lasts until the next morning check-in, 7:10 AM in New York", () => {
    expect(nyTime(nextCheckin(NOV11_8AM))).toBe("11/12/2026, 7:10:00 AM");
    expect(nyTime(nextCheckin(Date.UTC(2026, 10, 11, 11, 0)))).toBe("11/11/2026, 7:10:00 AM");   // 6:00 AM
    expect(nyTime(nextCheckin(Date.UTC(2026, 10, 11, 12, 10)))).toBe("11/12/2026, 7:10:00 AM");  // 7:10 sharp
    // across the end of daylight saving time (Nov 1, 2026) and its start (Mar 8, 2026)
    expect(new Date(nextCheckin(Date.UTC(2026, 10, 1, 0, 0))).toISOString()).toBe("2026-11-01T12:10:00.000Z");
    expect(new Date(nextCheckin(Date.UTC(2026, 2, 8, 5, 0))).toISOString()).toBe("2026-03-08T11:10:00.000Z");
  });
});

describe("what the record says", () => {
  test("closed means in Done and not in Open; an unknown item isn't closed", () => {
    const md = pendingWith(["P08", "P11"], ["P07", "P11"]);
    expect([...closedItems(md)]).toEqual(["P07"]);
    expect(closedItems(null).size).toBe(0);
  });

  test("holds: a missing file is no holds; a broken one decides nothing", () => {
    expect(parseHolds(null)).toEqual({});
    expect(parseHolds("{nope")).toBeNull();
    expect(parseHolds("[1]")).toBeNull();
    expect(parseHolds(laptopHolds("P12"))!.P12.holder).toBe("laptop:s1");
  });
});

describe("asks and cards name their item, and the link refuses what isn't Cain's", () => {
  test("an ask needs an item and an option", async () => {
    const r = rig();
    await expect(r.link.ask({ text: "Filed?", options: ["Filed"] })).rejects.toThrow("needs an item");
    await expect(r.link.ask({ text: "Filed?", options: [], item: "P08" })).rejects.toThrow("at least one option");
    await expect(r.link.ask({ text: "Filed?", options: ["Filed"], item: "P08", replyTo: "abc" })).rejects.toThrow("reply_to");
    expect(Object.keys(r.posted)).toEqual([]);
  });

  test("/ask and /show refuse items held by someone else, and say not to tell him who", async () => {
    const r = rig({ holds: laptopHolds("P12") });
    await expect(ask(r, "P12", "Q1")).rejects.toThrow("held by another session");
    await expect(ask(r, "p12", "Q1")).rejects.toThrow("don't ask him about it or say who has it".replace("don't", "Don't"));
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    await expect(r.link.show(card, { item: "P12" })).rejects.toThrow("held by another session");
    await expect(r.link.ship({ text: "Ship?", item: "P12", pr: PR, head: SHA1 })).rejects.toThrow("held by another session");
    expect(Object.keys(r.posted)).toEqual([]);
    expect(await ask(r, "none")).not.toBe("");                         // a one-off is never held
    await r.link.answered({ item: "none" });
    r.files.holds = JSON.stringify({ P12: { holder: "cain", branches: [] } });
    expect(await ask(r, "P12", "Q1")).not.toBe("");                    // his own hold is fine
  });

  test("when the holds can't be read, items wait; closed items are refused", async () => {
    const r = rig({ holds: "{half a fi", pending: pendingWith(["P08"], ["P07"]) });
    await expect(ask(r, "P08")).rejects.toThrow("can't be read");
    r.files.holds = null;
    await expect(ask(r, "P07")).rejects.toThrow("closed");
    expect(await ask(r, "P08")).not.toBe("");
  });
});

describe("the sweep takes buttons off cards that stopped mattering", () => {
  test("answered: when the tap's in-place update didn't land, the sweep finishes it", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    r.failing.add("/interactions/");
    expect(await r.tap(snap(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    expect(r.buttons(id)).toEqual(["Filed", "Not filed", "Not sure"]);   // Discord didn't take it
    r.failing.clear();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toBe("P08 Q2: Filed?\n\nYou answered: Filed");
  });

  test("expired: Cain's asks at the next morning check-in", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    r.t.now = Date.UTC(2026, 10, 12, 12, 9);                           // Nov 12, 7:09 AM
    await r.link.sweep();
    expect(r.buttons(id).length).toBe(3);
    r.t.now = Date.UTC(2026, 10, 12, 12, 10);                          // 7:10 AM
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toBe("P08 Q2: Filed?\n\nExpired");
    expect(r.relayed).toEqual([]);                                     // he re-asks at the check-in
  });

  test("expired: a Ship card when its pull request's head moves, and Cain is told", async () => {
    const r = rig();
    const out = await r.link.ship({ text: "Cain 0.7.0 ready. CI passed.", item: "P41", pr: PR, head: SHA1 });
    const id = (out as any).message;
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    r.heads[PR] = SHA1;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    r.heads[PR] = SHA2;
    r.later(2 * MIN);
    await r.link.sweep();                                              // looked at no more than every 5 minutes
    expect(r.buttons(id).length).toBe(2);
    r.later(4 * MIN);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toBe("Cain 0.7.0 ready. CI passed.\n\nExpired");
    expect(r.relayed[0]).toContain("head moved");
    expect(r.relayed[0]).toContain(PR);
  });

  test("expired: a specialist's card at its own expiry; without one, it stays the specialist's", async () => {
    const r = rig();
    const timed = await r.link.addCard({ text: "Approve the dentist?", rows: undoRows, expires: NOV11_8AM + HOUR });
    const plain = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const a = await r.link.show(timed, { item: "none" });
    const b = await r.link.show(plain, { item: "none" });
    r.later(30 * MIN);
    await r.link.sweep();
    expect(r.buttons(a)).toEqual(["Undo", "Stop"]);
    r.later(31 * MIN);
    await r.link.sweep();
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content).toBe("Approve the dentist?\n\nExpired");
    r.later(3 * DAY);
    await r.link.sweep();
    expect(r.buttons(b)).toEqual(["Undo", "Stop"]);
    // ISO times from the specialist work too
    const iso = await r.link.addCard({ text: "Approve lunch?", rows: undoRows, expires: new Date(r.t.now + MIN).toISOString() });
    const c = await r.link.show(iso, { item: "none" });
    r.later(2 * MIN);
    await r.link.sweep();
    expect(r.buttons(c)).toEqual([]);
  });

  test("replaced: a newer card for the same item and question", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "P06 Q1: Tie you up for the turkey harvest?", rows: undoRows });
    const old = await r.link.show(card, { item: "P06", question: "Q1" });
    r.failing.add("PATCH");                                            // the immediate take-off fails...
    const fresh = await ask(r, "P06", "Q1", "P06 Q1: Does the turkey harvest (Fri Nov 21) tie you up?", ["Ties me up", "Doesn't"]);
    expect(r.buttons(old)).toEqual(["Undo", "Stop"]);
    r.failing.clear();
    await r.link.sweep();                                              // ...and the sweep finishes it
    expect(r.buttons(old)).toEqual([]);
    expect(r.msg(old).content).toBe("P06 Q1: Tie you up for the turkey harvest?\n\nReplaced by a newer card");
    expect(r.buttons(fresh)).toEqual(["Ties me up", "Doesn't"]);
  });

  test("closed or moved to another holder: off, and Cain is told", async () => {
    const r = rig({ pending: pendingWith(["P08", "P09"], []) });
    const a = await ask(r, "P08", "Q2");
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const b = await r.link.show(card, { item: "P09" });
    r.relayed.length = 0;
    r.files.pending = pendingWith(["P09"], ["P08"]);
    await r.link.sweep();
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content.endsWith("\n\nExpired")).toBe(true);
    expect(r.relayed[0]).toContain("P08 is closed");
    r.files.holds = laptopHolds("P09");
    await r.link.sweep();
    expect(r.buttons(b)).toEqual([]);
    expect(r.relayed.length).toBe(1);                                  // a specialist's card: nothing for Cain
  });

  test("a held item takes Cain's question off, and he's told not to say who has it", async () => {
    const r = rig();
    const a = await ask(r, "P33", "Q1");
    r.files.holds = laptopHolds("P33");
    await r.link.sweep();
    expect(r.buttons(a)).toEqual([]);
    expect(r.relayed[0]).toContain("held by another session");
    expect(r.relayed[0]).toContain("Don't ask him about it or say who has it");
    expect(r.relayed[0]).not.toContain("laptop:s1");
  });

  test("a card is never forgotten with its buttons on: a day before, they come off", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const id = await r.link.show(card, { item: "none" });
    r.later(33 * DAY);
    await r.link.sweep();
    expect(r.buttons(id).length).toBe(2);
    r.later(1 * DAY + MIN);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    r.later(2 * DAY);
    await ask(r, "none");                                              // remembering anything prunes
    expect(r.state().messages[id]).toBeUndefined();
  });

  test("after a link restart, the first sweep still takes off what's due", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    r.restart();
    r.t.now = Date.UTC(2026, 10, 12, 13, 0);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content.endsWith("Expired")).toBe(true);
  });

  test("the first sweep takes the buttons off cards posted before 0.7.0, once", async () => {
    const r = rig();
    const two = NOV11_8AM - 2 * DAY;
    const post = (content: string, ids: string[], at = two, author = BOT) => {
      const id = r.snowflake(at);
      r.posted[id] = { id, content, author: { id: author },
        components: ids.length ? [{ type: 1, components: ids.map((c, i) => ({ type: 2, style: 1, label: `B${i}`, custom_id: c })) }] : [] };
      return id;
    };
    const askId = post("Book the plumber?", ["q:aa:0", "q:aa:1"]);
    const usedId = post("Old used one?", ["q:bb:0"]);
    const cardId = post("Moved the dentist.", ["k:c:abc", STOP]);
    const morningOld = post("## Mon", [STOP], two);
    const morningNew = post("## Tue", [STOP], two + DAY);
    const unknown = post("A card from before the link", ["k:a:old"], two - 40 * DAY);
    const young = post("Just posted", ["q:cc:0"], NOV11_8AM - MIN);
    const perm = post("Permission: Bash", ["perm:allow:abcde"]);
    const his = post("hi", [], two, OWNER);
    const until = (at: number) => at + 35 * DAY;
    const s = r.state();
    s.migrated = undefined as any;
    s.cards["77"] = { text: "Moved the dentist.", rows: [], kind: "reply", created: two, shown: cardId };
    s.messages = {
      [askId]: { digest: "x", until: until(two), q: { q: "Book the plumber?", options: ["Yes", "No"], used: false } },
      [usedId]: { digest: "x", until: until(two), q: { q: "Old used one?", options: ["Yes"], used: true } },
      [cardId]: { digest: "x", until: until(two), card: 77 },
      [morningOld]: { digest: "x", until: until(two) },
      [morningNew]: { digest: "x", until: until(two + DAY) },
      "1234": { digest: "x", until: until(two) },                     // no buttons anywhere: nothing to do
    };
    r.setState(s);
    await r.link.sweep();
    expect(r.buttons(askId)).toEqual([]);
    expect(r.msg(askId).content).toBe("Book the plumber?\n\nExpired");
    expect(r.buttons(usedId)).toEqual([]);
    expect(r.buttons(unknown)).toEqual([]);
    expect(r.msg(unknown).content).toBe("A card from before the link\n\nExpired");
    expect(r.buttons(morningOld)).toEqual([]);
    expect(r.msg(morningOld).content).toBe("## Mon");                 // a summary asked nothing: Stop just goes
    expect(r.buttons(morningNew)).toEqual(["B0"]);                    // the newest morning keeps Stop
    expect(r.buttons(cardId)).toEqual(["B0", "B1"]);                  // the specialist's own card: its call
    expect(r.buttons(young)).toEqual(["B0"]);                         // may still be on its way in
    expect(r.buttons(perm)).toEqual(["B0"]);                          // the plugin's own buttons
    expect(r.state().migrated).toBe(true);
    const histories = () => r.calls.filter((c) => c.method === "GET" && c.path.includes("/messages?")).length;
    expect(histories()).toBe(1);
    await r.link.sweep();
    expect(histories()).toBe(1);                                      // once
  });

  test("Discord's rate limit stops a sweep; the rest come off at the next", async () => {
    const r = rig();
    const card = (n: number) => r.link.addCard({ text: `Card ${n}`, rows: undoRows, expires: NOV11_8AM + MIN });
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push(await r.link.show(await card(n), { item: "none" }));
    r.later(2 * MIN);
    const patches = () => r.calls.filter((c) => c.method === "PATCH").length;
    r.limited.add("PATCH");
    await r.link.sweep();
    expect(patches()).toBe(1);                                        // stopped at the first refusal
    expect(ids.every((id) => r.buttons(id).length === 2)).toBe(true);
    r.limited.clear();
    await r.link.sweep();
    expect(ids.every((id) => r.buttons(id).length === 0)).toBe(true);
    expect(patches()).toBe(4);
  });

  test("a card he deleted is simply let go", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    delete r.posted[id];
    r.t.now = Date.UTC(2026, 10, 12, 13, 0);
    await r.link.sweep();
    expect(r.state().messages[id].buttons).toBe(false);
  });
});

describe("taps on dead cards", () => {
  const dead = async (r: ReturnType<typeof rig>, msg: any, cid: string, line: string) => {
    const before = r.relayed.length;
    expect(await r.tap(msg, cid)).toStartWith("dead:");
    expect(r.answers().at(-1)).toBe(7);                               // updated in place, never a silent ack
    expect(r.updates().at(-1).components).toEqual([]);
    expect(r.updates().at(-1).content.endsWith(line)).toBe(true);
    expect(r.ephemerals().at(-1)).toEqual({ content: EXPIRED_TAP, flags: 64, allowed_mentions: { parse: [] } });
    expect(r.relayed.length).toBe(before);                            // nothing reached Cain
    expect(r.harness).toEqual([]);                                    // or the specialist
  };

  test("an expired card", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    const m = snap(r.msg(id));
    r.t.now = Date.UTC(2026, 10, 12, 12, 30);
    await dead(r, m, r.ids(id)[0], "\n\nExpired");
    expect(r.buttons(id)).toEqual([]);
  });

  test("a card the sweep already stripped (his phone still showed the buttons)", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    const m = snap(r.msg(id));
    r.t.now = Date.UTC(2026, 10, 12, 12, 30);
    await r.link.sweep();
    await dead(r, m, m.components[0].components[1].custom_id, "\n\nExpired");
  });

  test("a replaced card", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2", "P08 Q2: Filed yet?", ["Filed", "Not yet"]);
    const m = snap(r.msg(id));
    await ask(r, "P08", "Q2");
    await dead(r, m, m.components[0].components[1].custom_id, "\n\nReplaced by a newer card");
  });

  test("an answered card", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    const m = snap(r.msg(id));
    await r.tap(m, m.components[0].components[2].custom_id);
    r.relayed.length = 0;
    await dead(r, m, m.components[0].components[0].custom_id, "\n\nYou answered: Not sure");
  });

  test("a card whose item moved to another holder", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const id = await r.link.show(card, { item: "P33" });
    r.files.holds = laptopHolds("P33");
    await dead(r, snap(r.msg(id)), "k:c:abc", "\n\nExpired");
  });

  test("a card of ours the link doesn't know (from before it remembered)", async () => {
    const r = rig();
    const id = r.snowflake(NOV11_8AM - 50 * DAY);
    r.posted[id] = { id, content: "Old card", author: { id: BOT },
      components: [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:old" }] }] };
    await dead(r, snap(r.posted[id]), "k:c:old", "Old card\n\nExpired");
    expect(r.state().messages[id].outcome).toBe("expired");
  });

  test("Stop still works from any card of ours", async () => {
    const r = rig();
    const first = await r.link.morning("## Wed");
    const m = snap(r.msg(first));
    await r.link.morning("## Thu");
    expect(r.buttons(first)).toEqual([]);
    expect(await r.tap(m, STOP)).toBe("to specialist");
    expect(r.harness[0][1].custom_id).toBe(STOP);
  });
});

describe("threading", () => {
  test("the relayed tap carries the Discord message id, and a Ship tap its pull request and head", async () => {
    const r = rig();
    const id = await ask(r, "P08", "Q2");
    await r.tap(snap(r.msg(id)), r.ids(id)[1]);
    expect(r.relayed[0]).toBe(`Dane tapped "Not filed" on your question P08 Q2: "P08 Q2: Filed?" (Discord message ${id}: answer it with reply_to ${id})`);
    const ship = (await r.link.ship({ text: "Cain 0.7.0 ready.", item: "P41", pr: PR, head: SHA1.toUpperCase() }) as any).message;
    await r.tap(snap(r.msg(ship)), r.ids(ship)[0]);
    expect(r.relayed[1]).toBe(`Dane tapped "Ship" on your Ship card for P41: ${PR} at head ${SHA1} (Discord message ${ship}: answer it with reply_to ${ship})`);
    expect(r.msg(ship).content).toBe("Cain 0.7.0 ready.\n\nYou answered: Ship");
  });

  test("the link's posts that answer a tap or a message are Discord replies", async () => {
    const r = rig();
    const his = r.his("Is the license packet in?");
    const a = await ask(r, "P08", "Q2", "P08 Q2: Filed?", ["Filed"], his.id);
    expect(r.msg(a).message_reference).toEqual({ message_id: his.id, channel_id: DM, fail_if_not_exists: false });
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const b = await r.link.show(card, { item: "none", replyTo: his.id });
    expect(r.msg(b).message_reference.message_id).toBe(his.id);
    const s = (await r.link.ship({ text: "Ready.", item: "P41", pr: PR, head: SHA1, replyTo: a }) as any).message;
    expect(r.msg(s).message_reference.message_id).toBe(a);
    await r.link.morning("## Wed");
    expect(r.last().message_reference).toBeUndefined();               // a fresh message, not an answer
  });

  test("a held ask keeps its thread when it goes out", async () => {
    const r = rig();
    const a = await ask(r, "P08", "Q2");
    const his = r.his("And the farm one?");
    await ask(r, "P11", "Q1", "P11 Q1: Signed?", ["Signed", "Not signed"], his.id);
    await r.tap(snap(r.msg(a)), r.ids(a)[0]);
    expect(r.last().content).toBe("P11 Q1: Signed?");
    expect(r.last().message_reference.message_id).toBe(his.id);
  });

  test("Cain can see what a message of his replied to", async () => {
    const r = rig();
    const a = await ask(r, "P08", "Q2");
    const reply = r.his("not sure actually", a);
    expect(await r.link.replied(reply.id)).toEqual({ status: "ok", reply_to: a, card: null, item: "P08", question: "Q2",
      asked: "P08 Q2: Filed?", open: true });
    const plain = r.his("what's on today?");
    expect((await r.link.replied(plain.id)).reply_to).toBeNull();
    await expect(r.link.replied(a)).rejects.toThrow("isn't one of his messages");
    await expect(r.link.replied("abc")).rejects.toThrow("message's id");
  });
});

describe("one open ask at a time", () => {
  test("a second ask waits until the first is answered, then goes out by itself", async () => {
    const r = rig();
    const a = await ask(r, "P08", "Q2");
    const held = await r.link.ask({ text: "P11 Q1: Signed?", options: ["Signed", "Not signed"], item: "P11", question: "Q1" });
    expect(held.status).toBe("held");
    expect((held as any).said).toContain("Not asked yet");
    expect(Object.keys(r.posted).length).toBe(1);
    await r.tap(snap(r.msg(a)), r.ids(a)[0]);
    expect(Object.keys(r.posted).length).toBe(2);
    expect(r.last().content).toBe("P11 Q1: Signed?");
    expect(r.relayed[0]).toContain('Dane tapped "Filed"');
    expect(r.relayed[1]).toBe(`Your held question P11 Q1 is now in front of Dane (Discord message ${r.last().id}): "P11 Q1: Signed?"`);
  });

  test("...or when the open one's item closes or moves", async () => {
    const r = rig();
    await ask(r, "P08", "Q2");
    await ask(r, "P11", "Q1");
    r.files.holds = laptopHolds("P08");
    await r.link.sweep();
    expect(r.last().content).toBe("P11 Q1: Filed?");
  });

  test("held asks that outlive their morning are dropped unasked, and Cain is told", async () => {
    const r = rig();
    await ask(r, "P08", "Q2");
    await ask(r, "P11", "Q1");
    r.t.now = Date.UTC(2026, 10, 12, 12, 11);
    await r.link.sweep();
    expect(Object.keys(r.posted).length).toBe(1);
    expect(r.relayed[0]).toContain("Your held question P11 Q1 was never shown");
    expect(r.state().held).toEqual([]);
    expect(await ask(r, "P11", "Q1")).not.toBe("");                  // the morning's fresh ask goes straight out
  });

  test("the same item and question asked again replaces the open card at once, or the held one", async () => {
    const r = rig();
    const a = await ask(r, "P08", "Q2", "P08 Q2: Filed?", ["Filed", "Not yet"]);
    const b = await ask(r, "P08", "Q2", "P08 Q2: Is the business-license packet filed?");
    expect(b).not.toBe("");
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content.endsWith("Replaced by a newer card")).toBe(true);
    await ask(r, "P11", "Q1", "first wording");
    await ask(r, "P11", "Q1", "second wording");
    expect(r.state().held!.map((h) => h.text)).toEqual(["second wording"]);
  });

  test("Ship cards and specialists' cards don't wait their turn", async () => {
    const r = rig();
    await ask(r, "P08", "Q2");
    const ship = await r.link.ship({ text: "Ready.", item: "P41", pr: PR, head: SHA1 });
    expect(ship.status).toBe("posted");
    const card = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    expect(await r.link.show(card, { item: "none" })).toBeTruthy();
    expect(Object.keys(r.posted).length).toBe(3);
  });

  test("answered in words: its buttons come off, and the next one goes out", async () => {
    const r = rig();
    const a = await ask(r, "P08", "Q2");
    await ask(r, "P11", "Q1");
    expect((await r.link.answered({ item: "P08", question: "Q2" })).status).toBe("closed");
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content.endsWith("You answered in a message")).toBe(true);
    expect(r.last().content).toBe("P11 Q1: Filed?");
    expect((await r.link.answered({ item: "P99" })).status).toBe("none open");
    const n = await ask(r, "none", "", "Want the long version?", ["Yes"]);
    expect(n).toBe("");                                               // P11 is open
    await r.link.answered({ item: "P11", question: "Q1" });
    expect(r.last().content).toBe("Want the long version?");
    expect((await r.link.answered({ item: "none" })).status).toBe("closed");
  });
});

describe("a replay of this morning (Nov 11)", () => {
  test("the farm card asked again exactly: the old card's buttons come off", async () => {
    const r = rig();
    const old = await ask(r, "P08", "Q2", "Farm Q2: business license?", ["Done", "Not yet"]);
    const m = snap(r.msg(old));
    const exact = await ask(r, "P08", "Q2", "P08 Q2: Is the business-license packet filed? (Not the land-use one.)",
      ["Filed", "Not filed", "Not sure"]);
    expect(r.buttons(old)).toEqual([]);
    expect(r.msg(old).content).toBe("Farm Q2: business license?\n\nReplaced by a newer card");
    expect(r.buttons(exact)).toEqual(["Filed", "Not filed", "Not sure"]);
    expect(await r.tap(m, m.components[0].components[1].custom_id)).toBe("dead: replaced");   // "Not yet" does nothing
    expect(r.ephemerals().at(-1).content).toBe(EXPIRED_TAP);
    expect(r.relayed).toEqual([]);                                    // nothing recorded from it
  });

  test("a tap is answered in its thread", async () => {
    const r = rig();
    const q = await ask(r, "P08", "Q2", "P08 Q2: Is the business-license packet filed?", ["Filed", "Not filed", "Not sure"]);
    await r.tap(snap(r.msg(q)), r.ids(q)[2]);
    const line = r.relayed[0];
    expect(line).toContain(`"Not sure"`);
    expect(line).toContain(`reply_to ${q}`);
    const replyTo = /reply_to (\d+)/.exec(line)![1];
    const follow = await ask(r, "P08", "Q3", "P08 Q3: Want me to check with the county?", ["Check", "Leave it"], replyTo);
    expect(r.msg(follow).message_reference.message_id).toBe(q);
  });

  test("Cain's cloud jobs: fixes onto a laptop's branch, a pull request for a branch, a Ship with no sha: all refused", () => {
    const run = (trigger_id: string, text: string) => ({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id, body: { text } } });
    const holds = JSON.stringify({ P42: { holder: "laptop:9f2c", for: "his chat", branches: ["claude/cain-owner-gate"] } });
    expect(decide(run(BUILD, "Fix the review findings on https://github.com/HyndeSyte/harness/pull/3"), holds)).toContain("names its branch");
    expect(decide(run(BUILD, "Branch: claude/cain-owner-gate\nFix the review findings."), holds)).toContain("held by another session");
    expect(decide(run(SHIP, "Ship pull request https://github.com/HyndeSyte/harness/pull/1. Dane tapped Ship at 9:12."), holds))
      .toContain("40-character head sha");
  });

  test("the Ship card carries the full head, and an old one goes when the head moves", async () => {
    const r = rig();
    const first = (await r.link.ship({ text: "Ready.", item: "P41", pr: PR, head: SHA1 }) as any).message;
    const second = (await r.link.ship({ text: "Ready, with fixes.", item: "P41", pr: PR, head: SHA2 }) as any).message;
    expect(r.buttons(first)).toEqual([]);
    expect(r.msg(first).content.endsWith("Replaced by a newer card")).toBe(true);
    expect(r.state().messages[second].ship).toEqual({ pr: PR, head: SHA2 });
    await expect(r.link.ship({ text: "x", item: "P41", pr: PR, head: "abc123" })).rejects.toThrow("40-character");
    await expect(r.link.ship({ text: "x", item: "P41", pr: "https://github.com/HyndeSyte/harness/tree/main", head: SHA1 }))
      .rejects.toThrow("pull request's address");
  });
});
