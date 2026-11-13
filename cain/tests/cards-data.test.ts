// Cards as data (piece D): every message the link posts records its buttons' labels,
// kept once they come off; Cain's lines and answers name them; keeper.sh card reads a
// message back from Discord; the cards are published for the reply hook without text;
// and each send point logs what the gate's rules would have done, changing nothing.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_LABEL, CONNECTOR_URL, cardsView, RESUME, STOP, withoutOutcome } from "../rootfs/opt/cain/link/core";
import { CardsWriter, publishCards, stateFile } from "../rootfs/opt/cain/link/publish";
import { DAY, DM, HOUR, MIN, PR, rig, SHA1 } from "./link-rig";

const btn = (label: string, custom_id: string) => ({ type: 2, style: 2, label, custom_id });
// A receipt for something the specialist did, as the Harness builds it.
const RECEIPT_ROWS = [{ type: 1, components: [btn("Not mine", "k:c:nm1"), btn("Wrong time", "k:c:wt1"), btn("Just this once", "k:c:jo1")] },
  { type: 1, components: [{ ...btn("Stop", STOP), style: 4 }] }];
const RECEIPT = ["Not mine", "Wrong time", "Just this once", "Stop"];
const UNDO_ROWS = [{ type: 1, components: [btn("Undo", "k:c:u1")] }, { type: 1, components: [{ ...btn("Stop", STOP), style: 4 }] }];

async function receipt(r: ReturnType<typeof rig>, text = "Added Swim to your Gmail.", rows = RECEIPT_ROWS, expires?: number) {
  const card = await r.link.addCard({ text, rows, kind: "card", ...(expires ? { expires } : {}) });
  const id = await r.link.show(card, { item: "none" });
  return { card, id };
}

describe("each card's buttons, as data", () => {
  test("recorded for every kind the link posts, and kept once they come off", async () => {
    const r = rig();
    const { id: card } = await receipt(r, undefined, undefined, r.t.now + 15 * MIN);
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const ship = (await r.link.ship({ text: "Cain 0.9.0 ready.", item: "P41", pr: PR, head: SHA1 }) as any).message;
    const morning = await r.link.morning("## Thu Nov 12");
    const s = r.state().messages;
    expect(s[card].labels).toEqual(RECEIPT);
    expect(s[ask].labels).toEqual(["Filed", "Not filed"]);
    expect(s[ship].labels).toEqual(["Ship", "Not now"]);
    expect(s[morning].labels).toEqual(["Stop"]);
    // Answered, expired, replaced and taken off: the labels stay; the buttons up now are none.
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const again = (await r.link.ship({ text: "Cain 0.9.0 ready, again.", item: "P41", pr: PR, head: SHA1 }) as any).message;
    r.later(2 * DAY);
    await r.link.sweep();
    const after = r.state().messages;
    for (const [id, labels] of [[card, RECEIPT], [ask, ["Filed", "Not filed"]], [ship, ["Ship", "Not now"]], [again, ["Ship", "Not now"]]] as const) {
      expect(after[id].labels).toEqual([...labels]);
      expect(after[id].buttons).toBe(false);
      expect(r.link.cardInfo(id)).toMatchObject({ buttons: [], live: false });
    }
    expect(r.state().cards[String(after[card].card)].rows).toEqual([]);   // the specialist's rows go, its labels don't
  });

  test("a Stop notice and the morning message keep the label of the button they carry now", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(structuredClone(r.msg(morning)), STOP);
    expect(r.state().messages[morning].labels).toEqual(["Turn back on"]);
    const notice = Object.entries(r.state().messages).find(([, m]) => m.toggle === RESUME);
    if (notice) expect(notice[1].labels).toEqual(["Turn back on"]);
    expect(r.msg(morning).components[0].components[0]).toMatchObject({ label: "Turn back on", style: 2 });
  });

  test("Stop is red wherever the link puts it", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    expect(r.msg(morning).components[0].components[0]).toMatchObject({ label: "Stop", custom_id: STOP, style: 4 });
  });

  test("the specialist's new buttons replace the old ones, and show, replied and /card-of say so", async () => {
    const r = rig();
    const { card, id } = await receipt(r, "Moved Swim to 4:30.", UNDO_ROWS);
    expect((await r.link.showCard(card, { item: "none" })).buttons).toEqual(["Undo", "Stop"]);
    await r.link.editButtons(card, RECEIPT_ROWS);
    const his = r.his("hm", id);
    expect(await r.link.replied(his.id)).toMatchObject({ reply_to: id, buttons: RECEIPT, live: true });
    expect(r.link.cardInfo(id)).toMatchObject({ buttons: RECEIPT, live: true });
    await r.link.editButtons(card, []);
    expect(r.link.cardInfo(id)).toMatchObject({ buttons: [] });
    expect(r.state().messages[id].labels).toEqual(RECEIPT);              // what it last had
  });
});

describe("Cain's lines name a card's buttons", () => {
  test("the card's first line, and the line when it went out by itself", async () => {
    const r = rig();
    await r.link.addCard({ text: "Added Swim to your Gmail.", rows: RECEIPT_ROWS, kind: "card" });
    expect(r.relayed[0]).toContain("Its buttons: Not mine, Wrong time, Just this once, Stop.");
    await r.link.addCard({ text: "Today: Swim at 4:30.", rows: [], kind: "digest" });
    expect(r.relayed[1]).toContain("It has no buttons.");
    r.later(3 * MIN);
    await r.link.sweep();
    const line = r.relayed.find((l) => l.includes("went out to him by itself"))!;
    expect(line).toContain("Its buttons: Not mine, Wrong time, Just this once, Stop.");
  });
});

describe("keeper.sh card reads Discord, not memory", () => {
  test("a message whose buttons changed on Discord reports them as they are now", async () => {
    const r = rig();
    const { id } = await receipt(r);
    r.posted[id].components = UNDO_ROWS;                                  // changed on Discord, not through the link
    const out = await r.link.look(id);
    expect(out).toMatchObject({ status: "ok", message: id, from: "the bot", buttons: ["Undo", "Stop"],
      known: { kind: "card", writer: "specialist", item: "none", live: true, labels: RECEIPT } });
    expect(String(out.text).length).toBeLessThanOrEqual(200);
    expect(r.calls.filter((c) => c.method === "GET" && c.path === `/channels/${DM}/messages/${id}`)).toHaveLength(1);
    const his = r.his("x".repeat(500));
    expect(await r.link.look(his.id)).toMatchObject({ from: "Dane", known: null, buttons: [] });
    expect(String((await r.link.look(his.id)).text)).toHaveLength(200);
    await expect(r.link.look("nope")).rejects.toThrow("Discord message id");
  });
});

describe("the cards, published for the reply hook", () => {
  test("live cards and two days of finished ones, with labels and writers, and no text", async () => {
    const r = rig();
    const { id: card } = await receipt(r, "Added Swim, a private title, to your Gmail.");
    const ask = (await r.link.ask({ text: "P08 Q2: Is the private packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    await r.link.notice("A plain notice.");
    let v = cardsView(r.state(), r.t.now);
    expect(v).toMatchObject({ written_at: r.t.now, owner: "4242", dm: DM });
    expect(v.cards.find((c) => c.message === card)).toEqual({ message: card, kind: "card", writer: "specialist", labels: RECEIPT,
      live: true, item: "none", question: null, posted: r.t.now });
    expect(v.cards.find((c) => c.message === ask)).toMatchObject({ kind: "ask", writer: "cain", labels: ["Filed", "Not filed"], live: true, question: "Q2" });
    expect(v.cards.find((c) => c.kind === "notice")).toMatchObject({ writer: "link", labels: [], live: false });
    expect(JSON.stringify(v)).not.toContain("private");
    await r.link.answered({ item: "P08", question: "Q2" });
    r.later(DAY);
    await r.link.sweep();
    v = cardsView(r.state(), r.t.now);
    expect(v.cards.find((c) => c.message === ask)).toMatchObject({ live: false, labels: ["Filed", "Not filed"] });
    r.later(DAY + HOUR);
    v = cardsView(r.state(), r.t.now);
    expect(v.cards.map((c) => c.message)).toEqual([card]);               // its buttons are still up; the rest finished over 2 days ago
  });

  test("written whole through a rename, readable by all", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const path = join(dir, "trust", "cards.json");
    await publishCards(r.state(), 5, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ written_at: 5, owner: null, dm: null, cards: [] });
    if (process.platform !== "win32") expect((statSync(path).mode & 0o777).toString(8)).toBe("644");
  });

  test("a save never writes them; one write shortly after carries the latest state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const statePath = join(dir, "state.json"), cardsPath = join(dir, "trust", "cards.json");
    let reads = 0;
    const writer = new CardsWriter(() => { reads++; return store.load(); }, cardsPath, 40);
    const store = stateFile(statePath, () => writer.soon());
    const r = rig();
    await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" });
    const s = r.state();
    store.save(s);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(cardsPath)).toBe(false);                            // nothing on the save itself
    store.save({ ...s, owner: "4242" });
    store.save({ ...s, owner: "4343" });
    await writer.settled();
    expect(reads).toBe(1);                                                // three saves, one write
    expect(JSON.parse(readFileSync(cardsPath, "utf8"))).toMatchObject({ owner: "4343", cards: [{ kind: "ask", labels: ["Filed", "Not filed"] }] });
    store.save({ ...s, owner: "4444" });
    await writer.settled();
    expect(JSON.parse(readFileSync(cardsPath, "utf8")).owner).toBe("4444");
  });

  test("the link asks for a write after each save and each sweep, and answers /cards itself", () => {
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toContain("const stateStore = stateFile(STATE, () => cards.soon());");
    expect(main).toContain("function save(s: State): void { stateStore.save(s); }");
    expect(main).toContain("finally { cards.soon(); setTimeout(sweepLoop, SWEEP_MS); }");
    expect(main).toContain('url.pathname === "/cards") return json(link.cardsNow())');
    expect(main).not.toContain("publishCards(");                          // only through the writer
  });
});

describe("the gate's report at the link's send points", () => {
  test("Cain's words through the link: logged with the rule, and still sent as they were", async () => {
    const r = rig();
    const out = await r.link.ask({ text: "P08 Q2: Filed? If not, tap Undo — then Filed.", options: ["Filed", "Not filed"], item: "P08", question: "Q2" });
    expect(out.status).toBe("posted");
    expect(r.last().content).toBe("P08 Q2: Filed? If not, tap Undo — then Filed.");   // nothing changed in D1
    expect(r.reports).toMatchObject([{ point: "ask", writer: "cain", hits: [{ rule: "button", result: "refuse", label: "Undo" }, { rule: "dash", result: "fix" }] }]);
    for (const h of r.reports[0].hits) expect(h.around.length).toBeLessThanOrEqual(60);
  });

  test("a specialist card naming a button it lacks is posted unchanged, and logged", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Three blocks added, each on its own card with Undo.", rows: [{ type: 1, components: [btn("Stop", STOP)] }], kind: "digest" });
    const id = await r.link.show(card, { item: "none" });
    expect(r.msg(id).content).toBe("Three blocks added, each on its own card with Undo.");
    expect(r.reports).toMatchObject([{ point: "card", writer: "specialist", hits: [{ rule: "button", label: "Undo" }] }]);
  });

  test("the specialist's numbers aren't checked as machine text; its notes after a tap get only the fixes", async () => {
    const r = rig();
    await r.link.addCard({ text: "Room 123456789012345678 booked.", rows: [], kind: "card" });
    expect(r.reports).toEqual([]);
    await r.link.followup("999:tok", "Done, tap Undo — if wrong.");
    expect(r.reports).toMatchObject([{ point: "answer", writer: "specialist", hits: [{ rule: "dash", result: "fix" }] }]);
  });

  test("the link's own notices are checked with its rules", async () => {
    const r = rig();
    await r.link.notice("The add-on — is back.");
    expect(r.reports).toMatchObject([{ point: "notice", writer: "link", hits: [{ rule: "app" }, { rule: "dash" }] }]);
    expect(r.last().content).toBe("The add-on — is back.");
  });

  test("keeper.sh check gives the hook's decision against the cards up now, and sends nothing", async () => {
    const r = rig();
    const { id } = await receipt(r);
    const posts = r.posts();
    expect(r.link.checkSend({ text: "If it's wrong, tap Undo.", replyTo: id })).toMatchObject({ status: "ok", would: "refuse" });
    expect(r.link.checkSend({ text: "Tap Wrong time if it's off.", replyTo: id }).would).toBe("pass");
    expect(r.link.checkSend({ text: "Fixed.", edit: id }).hits).toMatchObject([{ rule: "target", result: "refuse" }]);
    expect(() => r.link.checkSend({ text: " " })).toThrow("needs the text");
    expect(() => r.link.checkSend({ text: "x", replyTo: "abc" })).toThrow("Discord id");
    expect(r.posts()).toBe(posts);
    expect(r.reports.filter((x) => x.point === "reply")).toEqual([]);
  });
});

describe("the notice that Home Assistant's connector needs signing in again", () => {
  test("one notice, whose only button opens Claude's connector settings, asking nothing back", async () => {
    const r = rig();
    const out = await r.link.connector({ item: "P41", text: "Installing Harness 0.22.0" });
    expect(out.status).toBe("posted");
    const msg = r.msg(out.message);
    expect(msg.content).toBe("P41: Installing Harness 0.22.0 waits until Claude can reach Home Assistant again: its connector needs you to sign in again. Open Claude's connector settings and reconnect Home Assistant there. It goes ahead by itself once Home Assistant answers.");
    expect(msg.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: CONNECTOR_LABEL, url: CONNECTOR_URL }] }]);
    expect(CONNECTOR_URL).toBe("https://claude.ai/customize/connectors");   // settings/connectors only says they moved
    expect(msg.content).not.toMatch(/tap|reconnected|tell me|let me know/i);
    expect(r.state().messages[out.message]).toMatchObject({ kind: "notice", question: "connector", labels: [CONNECTOR_LABEL] });
    expect(cardsView(r.state(), r.t.now).cards.find((c) => c.message === out.message)).toMatchObject({ live: true, writer: "link" });
  });

  test("only once while it lasts, then again for a later lapse", async () => {
    const r = rig();
    await r.link.connector({ item: "P41", text: "Installing Harness 0.22.0" });
    r.later(15 * MIN);
    const again = await r.link.connector({ item: "P41", text: "Installing Harness 0.22.0." });
    expect(again.status).toBe("already told");
    expect(r.posts()).toBe(1);
    r.later(13 * HOUR);
    expect((await r.link.connector({ item: "P41", text: "Installing Harness 0.22.0" })).status).toBe("posted");
  });

  test("its words are a few, with no machine text", async () => {
    const r = rig();
    await expect(r.link.connector({ item: "P41", text: "" })).rejects.toThrow("what waits");
    await expect(r.link.connector({ item: "P41", text: `Installing ${SHA1}` })).rejects.toThrow("commit sha");
    await expect(r.link.connector({ item: "P41", text: "x".repeat(200) })).rejects.toThrow("few words");
    await expect(r.link.connector({ text: "Installing Harness" })).rejects.toThrow("needs an item");
  });
});

describe("outcome lines", () => {
  test("come off the end of a card's words", () => {
    expect(withoutOutcome("P08 Q2: Filed?\n\nYou answered: Filed")).toBe("P08 Q2: Filed?");
    expect(withoutOutcome("Added Swim.\n\nExpired")).toBe("Added Swim.");
    expect(withoutOutcome("Cain 0.9.0 ready.\n\nShipped: it's in main as of 4:10 PM. Installing it is next.")).toBe("Cain 0.9.0 ready.");
    expect(withoutOutcome("Plain words.")).toBe("Plain words.");
  });
});
