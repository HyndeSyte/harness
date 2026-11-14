// Cards as data (piece D): every message the link posts records its buttons' labels,
// kept once they come off; Cain's lines and answers name them; keeper.sh card reads a
// message back from Discord; the cards are published for the reply hook without text;
// and each send point logs what the gate's rules would have done, changing nothing.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_LABEL, CONNECTOR_URL, cardsView, RESUME, STOP, withoutOutcome } from "../rootfs/opt/cain/link/core";
import { CardsWriter, publishCards, readTranscripts, seedReplies, stateFile } from "../rootfs/opt/cain/link/publish";
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
    const notice = v.cards.find((c) => c.kind === "notice")!;
    expect(notice).toMatchObject({ writer: "link", labels: ["Stop"], live: true });   // it carries the moving Stop
    expect(JSON.stringify(v)).not.toContain("private");
    await r.link.answered({ item: "P08", question: "Q2" });
    r.later(DAY);
    await r.link.sweep();
    v = cardsView(r.state(), r.t.now);
    expect(v.cards.find((c) => c.message === ask)).toMatchObject({ live: false, labels: ["Filed", "Not filed"] });
    r.later(DAY + HOUR);
    v = cardsView(r.state(), r.t.now);
    // Their buttons are still up (the receipt's, and the notice's Stop); the rest finished over 2 days ago.
    expect(v.cards.map((c) => c.message).sort()).toEqual([card, notice.message].sort());
  });

  test("every message the link posts is in the published view at once, buttons or not: an edit of one is never taken for a fresh reply", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const ship = (await r.link.ship({ text: "Cain 0.10.0 ready.", item: "P41", pr: PR, head: SHA1 }) as any).message;
    const morning = await r.link.morning("## Thu Nov 12");
    const notice = await r.link.notice("The calendar specialist is answering again.");
    const asking = await r.link.notice("Is the calendar specialist still needed today?");
    const connector = (await r.link.connector({ item: "P41", text: "Installing Harness 0.23.0" })).message;
    const { id: plain } = await receipt(r, "Today: Swim at 4:30.", []);
    r.harnessDown.down = true;
    await r.tap(structuredClone(r.msg(morning)), STOP);                   // and the link's own Stopped notice
    await r.link.whenStopPlaced();
    const view = cardsView(r.state(), r.t.now).cards.map((c) => c.message);
    for (const id of [ask, ship, morning, notice, asking, connector, plain]) expect(view).toContain(id);
    expect(view.sort()).toEqual(r.cards().map((m: any) => m.id).sort());   // every bot message on Discord, and nothing else
  });

  test("with the ids of Cain's own replies from the last 35 days, the only messages he may edit", async () => {
    const r = rig();
    const old = r.snowflake(r.t.now - 36 * DAY), recent = r.snowflake(r.t.now - DAY);
    expect(r.link.seedSent([old, recent, "not-an-id"])).toBe(1);
    await r.link.sent({ tool: "reply", ids: [r.snowflake()], question: false });
    const v = cardsView(r.state(), r.t.now);
    expect(v.sent).toHaveLength(2);
    expect(v.sent).toContain(recent);
    expect(v.sent).not.toContain(old);
  });

  test("written whole through a rename, readable by all", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const path = join(dir, "trust", "cards.json");
    await publishCards(r.state(), 5, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ written_at: 5, owner: null, dm: null, cards: [], sent: [] });
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
    expect(main).toContain('url.pathname === "/cards") return json(await link.cardsFor())');
    expect(main).not.toContain("publishCards(");                          // only through the writer
  });

  test("with no DM id yet (a new bot token), /cards asks Discord whose bot it is, waiting a moment at most; a slower answer is there for the next send", async () => {
    const r = rig();
    await r.link.notice("The calendar specialist is answering again.");  // the link knows his DM
    expect((await r.link.cardsFor()).dm).toBe(DM);
    r.link.forget();                                                      // the token changed
    expect(r.link.cardsNow().dm).toBeNull();
    const asks = () => r.calls.filter((c) => c.path === "/oauth2/applications/@me").length;
    const before = asks();
    expect((await r.link.cardsFor()).dm).toBe(DM);                        // Discord answered within the wait
    expect(asks()).toBe(before + 1);
    expect((await r.link.cardsFor()).dm).toBe(DM);
    expect(asks()).toBe(before + 1);                                      // kept: asked once
    // Discord slow: the hook gets the cards without it in time, and the next read has it.
    r.link.forget();
    r.gate.identity = true;
    const t0 = performance.now();
    const [a, b] = await Promise.all([r.link.cardsFor(30), r.link.cardsFor(30)]);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect([a.dm, b.dm]).toEqual([null, null]);
    expect(asks()).toBe(before + 2);                                      // one ask for both
    r.release();
    await Bun.sleep(5);
    expect(r.link.cardsNow().dm).toBe(DM);
  });
});

describe("the gate at the link's send points", () => {
  test("exit drill: Cain's ask naming a button it lacks is refused before anything is sent, saying what to change", async () => {
    const r = rig();
    const ask = r.link.ask({ text: "P08 Q2: Filed? If not, tap Undo.", options: ["Filed", "Not filed"], item: "P08", question: "Q2" });
    await expect(ask).rejects.toThrow('The message gate held this ask: "Undo" isn\'t one of its buttons (Filed, Not filed). Rewrite it and send it again.');
    expect(r.posts()).toBe(0);
    expect(r.reports).toMatchObject([{ point: "ask", writer: "cain", did: "refused", hits: [{ rule: "button", result: "refuse", label: "Undo" }] }]);
    for (const h of r.reports[0].hits) expect(h.around.length).toBeLessThanOrEqual(60);
  });

  test("Cain's words through the link: add-ons fixed before the card is made, and the answer says so; every em dash refused, an option's too", async () => {
    const r = rig();
    const out = await r.link.ask({ text: "P08 Q2: Is the add-on back?", options: ["The add-on's back", "Not yet"], item: "P08", question: "Q2" }) as any;
    expect(out).toMatchObject({ status: "posted", said: "Posted. The message gate fixed its wording first: Apps, not add-ons." });
    expect(r.last().content).toBe("P08 Q2: Is the App back?");
    expect(r.buttons(out.message)).toEqual(["The App's back", "Not yet"]);
    expect(r.state().messages[out.message].labels).toEqual(["The App's back", "Not yet"]);
    // The same words again make the same card: the nonce is made from the fixed words.
    const again = await r.link.ask({ text: "P08 Q2: Is the add-on back?", options: ["The add-on's back", "Not yet"], item: "P08", question: "Q2" }) as any;
    expect(again.message).toBe(out.message);
    expect(r.reports.filter((x) => x.point === "ask")).toMatchObject([{ did: "fixed" }, { did: "fixed" }]);
    const posts = r.posts();
    await expect(r.link.ask({ text: "P08 Q3: Is the App back — or not?", options: ["Back", "Not yet"], item: "P08", question: "Q3" }))
      .rejects.toThrow('The message gate held this ask: "P08 Q3: Is the App back — or not?": an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range. Rewrite it and send it again.');
    await expect(r.link.ask({ text: "P08 Q3: Is the App back?", options: ["Back — yes", "Not yet"], item: "P08", question: "Q3" }))
      .rejects.toThrow("The message gate held this ask's option: \"Back — yes\": an em dash");
    expect(r.posts()).toBe(posts);
    expect(r.reports.filter((x) => x.did === "refused")).toMatchObject([{ point: "ask", hits: [{ rule: "dash", result: "refuse" }] },
      { point: "ask option", hits: [{ rule: "dash", result: "refuse" }] }]);
  });

  test("a hidden count or machine text is refused on an ask, a Ship card, the morning message and the connector notice", async () => {
    const r = rig();
    await expect(r.link.ask({ text: "P08 Q2: Two blocks and 3 more: fine?", options: ["Yes", "No"], item: "P08", question: "Q2" })).rejects.toThrow("name each one instead of a count");
    await expect(r.link.ask({ text: "P08 Q2: Fine?", options: ["Yes", "Yes and 2 more"], item: "P08", question: "Q2" })).rejects.toThrow("held this ask's option");
    await expect(r.link.ship({ text: "Harness 0.23.0 ready, and 2 more fixes.", item: "P41", pr: PR, head: SHA1 })).rejects.toThrow("held this Ship card");
    await expect(r.link.morning("## Thu Nov 12\nTap Undo on the receipt.")).rejects.toThrow('"Undo" isn\'t one of its buttons (Stop)');
    await expect(r.link.connector({ item: "P41", text: "Installing Harness, see message 123456789012345678" })).rejects.toThrow("held this notice");
    // And an em dash, on each of them.
    await expect(r.link.ship({ text: "Harness 0.23.0 ready — the gate on.", item: "P41", pr: PR, head: SHA1 })).rejects.toThrow("held this Ship card");
    await expect(r.link.morning("## Thu Nov 12\n• Swim — 4:30")).rejects.toThrow("held this morning message");
    await expect(r.link.connector({ item: "P41", text: "Installing Harness — 0.23.0" })).rejects.toThrow("held this notice");
    expect(r.posts()).toBe(0);
    const ship = await r.link.ship({ text: "Harness 0.23.0 ready: the add-on's gate is on.", item: "P41", pr: PR, head: SHA1 }) as any;
    expect(ship.said).toBe("Posted. The message gate fixed its wording first: Apps, not add-ons.");
    expect(r.msg(ship.message).content).toStartWith("P41: Harness 0.23.0 ready: the App's gate is on.");
    expect((await r.link.morningPost("## Thu Nov 12\n• The add-on restarts at 4:30")).said).toContain("Apps, not add-ons");
    expect(r.last().content).toBe("## Thu Nov 12\n• The App restarts at 4:30");
  });

  test("a specialist card naming a button it lacks is never refused: posted as it is, logged, and Cain told once", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Three blocks added — each on its own card with Undo.", rows: [{ type: 1, components: [btn("Stop", STOP)] }], kind: "digest" });
    expect(r.relayed.at(-1)).toContain('The message gate flags its words: "Undo" isn\'t one of its buttons. It goes out as it is');
    const id = await r.link.show(card, { item: "none" });
    expect(r.msg(id).content).toBe("Three blocks added, each on its own card with Undo.");   // the dash fixed, the rest as it was
    expect(r.state().cards[String(card)].text).toBe("Three blocks added, each on its own card with Undo.");
    expect(r.reports).toMatchObject([{ point: "card", writer: "specialist", did: "posted as it is", hits: [{ rule: "dash" }, { rule: "button", label: "Undo" }] }]);
    expect(r.relayed.filter((l) => l.includes("flags its words"))).toHaveLength(1);
  });

  test("the specialist's numbers aren't checked as machine text; its notes after a tap get only the fixes", async () => {
    const r = rig();
    await r.link.addCard({ text: "Room 123456789012345678 booked.", rows: [], kind: "card" });
    expect(r.reports).toEqual([]);
    await r.link.followup("999:tok", "Done, tap Undo — if wrong.");
    expect(r.reports).toMatchObject([{ point: "answer", writer: "specialist", did: "fixed", hits: [{ rule: "dash", result: "fix" }] }]);
    expect(r.ephemerals().at(-1).content).toBe("Done, tap Undo, if wrong.");
  });

  test("the link's own notices are fixed", async () => {
    const r = rig();
    await r.link.notice("The add-on — is back.");
    expect(r.reports).toMatchObject([{ point: "notice", writer: "link", did: "fixed", hits: [{ rule: "app" }, { rule: "dash" }] }]);
    expect(r.last().content).toBe("The App, is back.");
  });

  test("an em dash between two numbers, or a time and a number: Cain's ask is refused like any of his em dashes; a specialist's card keeps it, flagged", async () => {
    const r = rig();
    await expect(r.link.ask({ text: "P08 Q2: Is Room 4—5 free?", options: ["Yes", "No"], item: "P08", question: "Q2" }))
      .rejects.toThrow('The message gate held this ask: "P08 Q2: Is Room 4—5 free?": an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range. Rewrite it and send it again.');
    await expect(r.link.ship({ text: "Harness 0.23.0 ready, for 2026 — 2027.", item: "P41", pr: PR, head: SHA1 })).rejects.toThrow("an em dash; rewrite it without one");
    await expect(r.link.ask({ text: "P08 Q2: Party at 6 PM — 8 people, fine?", options: ["Yes", "No"], item: "P08", question: "Q2" })).rejects.toThrow("an em dash; rewrite it without one");
    expect(r.posts()).toBe(0);
    const card = await r.link.addCard({ text: "Swim moved to 4:30 — 2 blocks shifted.", rows: [], kind: "card" });
    expect(r.relayed.at(-1)).toContain('The message gate flags its words: "Swim moved to 4:30 — 2 blocks shifted." (say it without the dash, as a range in words if it is one). It goes out as it is');
    const id = await r.link.show(card, { item: "none" });
    expect(r.msg(id).content).toBe("Swim moved to 4:30 — 2 blocks shifted.");   // left as it is, never ", "
    expect(r.reports.at(-1)).toMatchObject({ point: "card", writer: "specialist", did: "posted as it is", hits: [{ rule: "dash", result: "refuse" }] });
    const party = await r.link.show(await r.link.addCard({ text: "Party is 6 PM — 8.", rows: [], kind: "card" }), { item: "none" });
    expect(r.msg(party).content).toBe("Party is 6 PM — 8.");                    // a time and a number: kept, flagged
    expect(r.reports.at(-1)).toMatchObject({ point: "card", did: "posted as it is", hits: [{ rule: "dash", result: "refuse" }] });
    await r.link.notice("Back at 6 PM — 8 at the latest.");                    // the link's own words: kept, flagged
    expect(r.last().content).toBe("Back at 6 PM — 8 at the latest.");
    expect(r.reports.at(-1)).toMatchObject({ point: "notice", writer: "link", hits: [{ rule: "dash", result: "refuse", kept: "range" }] });
    // Behind markdown too, and right after a link, where a comma would run into it.
    const bold = await r.link.show(await r.link.addCard({ text: "Swim is **5** — **6 PM**.", rows: [], kind: "card" }), { item: "none" });
    expect(r.msg(bold).content).toBe("Swim is **5** — **6 PM**.");
    const linked = await r.link.addCard({ text: "Its page: https://example.com/a — then reply.", rows: [], kind: "card" });
    expect(r.relayed.at(-1)).toContain('The message gate flags its words: "Its page: https://example.com/… — then reply." (say it without the dash; a comma there would run into the link).');
    expect(r.msg(await r.link.show(linked, { item: "none" })).content).toBe("Its page: https://example.com/a — then reply.");
  });

  test("keeper.sh check gives the hook's decision against the cards up now, and sends nothing", async () => {
    const r = rig();
    const { id } = await receipt(r);
    const posts = r.posts();
    expect(r.link.checkSend({ text: "If it's wrong, tap Undo.", replyTo: id })).toMatchObject({ status: "ok", would: "refuse" });
    expect(r.link.checkSend({ text: "Tap Wrong time if it's off.", replyTo: id }).would).toBe("pass");
    expect(r.link.checkSend({ text: "Restarted the add-on at 4:30.", replyTo: id })).toMatchObject({ would: "fix", fixed: "Restarted the App at 4:30." });
    expect(r.link.checkSend({ text: "Moved swim — at 4:30.", replyTo: id })).toMatchObject({ would: "refuse", fixed: "Moved swim — at 4:30.", hits: [{ rule: "dash", result: "refuse" }] });
    expect(r.link.checkSend({ text: "Fixed.", edit: id }).hits).toMatchObject([{ rule: "target", result: "refuse" }]);
    expect(r.link.checkSend({ text: "Room 4—5 is free." }).hits).toMatchObject([{ rule: "dash", result: "refuse" }]);
    expect(() => r.link.checkSend({ text: " " })).toThrow("needs the text");
    expect(() => r.link.checkSend({ text: "x", replyTo: "abc" })).toThrow("Discord id");
    expect(r.posts()).toBe(posts);
    expect(r.reports.filter((x) => x.point === "reply")).toEqual([]);
  });
});

describe("what Cain sent, from the PostToolUse hook (/sent)", () => {
  test("his ids go on his edit allowlist, each part of a reply; an edit only updates whether it asks something", async () => {
    const r = rig();
    const [a, b] = [r.snowflake(), r.snowflake()];
    for (const id of [a, b]) r.posted[id] = { id, content: "A long reply, in two parts.", author: { id: "999" }, components: [] };
    await r.link.sent({ tool: "reply", ids: [a, b], question: false });
    expect(r.state().sent).toMatchObject({ [a]: { last: false, asks: false }, [b]: { last: true, asks: false } });
    await r.link.sent({ tool: "edit", ids: [b], question: true });
    expect(r.state().sent![b]).toMatchObject({ last: true, asks: true });
    await expect(r.link.sent({ tool: "reply", ids: ["nope"] })).rejects.toThrow("needs the ids");
    // An edit never adds a message to the list: only a reply does.
    const elsewhere = r.snowflake();
    await r.link.sent({ tool: "edit", ids: [elsewhere], question: false });
    expect(r.state().sent![elsewhere]).toBeUndefined();
  });

  test("a message the link knows as its own never goes on his list: not from a note, not from his transcripts", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const notice = await r.link.notice("The calendar specialist is answering again.");
    const mine = r.snowflake();
    await r.link.sent({ tool: "reply", ids: [ask, mine], question: false });
    expect(Object.keys(r.state().sent!)).toEqual([mine]);
    expect(r.state().sent![mine]).toMatchObject({ last: true });
    expect(r.link.seedSent([ask, notice, r.snowflake()])).toBe(1);
    expect(cardsView(r.state(), r.t.now).sent).not.toContain(ask);
    expect(cardsView(r.state(), r.t.now).sent).not.toContain(notice);
  });

  test("his transcripts give his edit allowlist his reply tool's answers alone, never an edit's, as the link's start seeds it", async () => {
    const r = rig();
    const root = mkdtempSync(join(tmpdir(), "seed-"));
    mkdirSync(join(root, "-data-work"));
    const use = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
    const REPLY = "mcp__plugin_discord_discord__reply", EDIT = "mcp__plugin_discord_discord__edit_message";
    const [reply, part1, part2, edited] = [r.snowflake(), r.snowflake(), r.snowflake(), r.snowflake()];
    writeFileSync(join(root, "-data-work", "s.jsonl"), [
      use("t1", REPLY, { chat_id: DM, text: "Moved swim." }), result("t1", `sent (id: ${reply})`),
      use("t2", REPLY, { chat_id: DM, text: "A long one." }), result("t2", `sent 2 parts (ids: ${part1}, ${part2})`),
      use("t3", EDIT, { chat_id: DM, message_id: edited, text: "Fixed." }), result("t3", `edited (id: ${edited})`),   // a message he only edited
      use("t4", EDIT, { chat_id: DM, message_id: reply, text: "Moved swim to 5." }), result("t4", `edited (id: ${reply})`),
    ].join("\n") + "\n");
    const sent = await readTranscripts(root, 0);
    expect([...sent.replies!].sort()).toEqual([reply, part1, part2].sort());
    expect([...sent.ids]).toContain(edited);                              // the replay still reads it as his
    expect(await seedReplies(r.link, root, 0)).toBe(3);
    expect(Object.keys(r.state().sent!).sort()).toEqual([reply, part1, part2].sort());
    expect(cardsView(r.state(), r.t.now).sent).not.toContain(edited);
    // The link's start and its 6-hourly pass seed through this, and nothing else.
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toContain("const n = await seedReplies(link, TRANSCRIPTS,");
    expect(main).not.toContain("seedSent(");
  });

  test("an edit of a message the link posted (the reply hook bypassed) is logged and Cain hears it once per edit", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    await r.link.sent({ tool: "edit", ids: [ask], question: false, call: "toolu_01first" });
    expect(r.state().sent?.[ask]).toBeUndefined();
    expect(r.reports.at(-1)).toMatchObject({ point: "sent", writer: "cain", message: ask, did: "bypassed: an edit of a message the link posted" });
    expect(r.relayed.at(-1)).toBe(`Your edit changed Discord message ${ask}, a card your App posted, not one of your replies: the message gate should have held it, and it's logged for a fix. Don't edit it again; if it needs setting right, say so in a new reply.`);
    // The hook sends a note again when its answer is lost: the line, and the log, come once.
    const said = r.relayed.length, logged = r.reports.length;
    await r.link.sent({ tool: "edit", ids: [ask], question: false, call: "toolu_01first" });
    expect([r.relayed.length, r.reports.length]).toEqual([said, logged]);
    // A second, different edit of the same card within the minute is its own send: told too.
    await r.link.sent({ tool: "edit", ids: [ask], question: false, call: "toolu_01second" });
    expect([r.relayed.length, r.reports.length]).toEqual([said + 1, logged + 1]);
    await r.link.sent({ tool: "edit", ids: [ask], question: false, call: "toolu_01second" });   // and its retry isn't
    expect(r.relayed.length).toBe(said + 1);
    // The same for what the safety net found: once per send, a retry not again, another send again.
    const net = { released: false, hits: [{ rule: "count", result: "refuse", around: "and 3 more" }] };
    const mine = r.snowflake();
    for (const call of ["toolu_01a", "toolu_01a", "toolu_01b"]) await r.link.sent({ tool: "reply", ids: [mine], question: false, call, net });
    expect(r.relayed.filter((l) => l.includes(`(Discord message ${mine})`))).toHaveLength(2);
  });

  test("what the safety net found reaches Cain as each rule and a short excerpt, with what to fix, or that his third try went out as it was", async () => {
    const r = rig();
    const id = r.snowflake();
    await r.link.sent({ tool: "reply", ids: [id], question: false,
      net: { released: false, fixed: "Moved swim, and art.", hits: [{ rule: "dash", result: "refuse", around: "Moved swim — and art." }] } });
    expect(r.relayed.at(-1)).toBe(`The message gate should have held your reply (Discord message ${id}), but it went out: "Moved swim — and art." (an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range). Fix it now with an edit (edit_message), or, if the edit is held, send a one-line correction as a new reply instead; don't mention it to him. It's logged for a fix.`);
    await r.link.sent({ tool: "reply", ids: [r.snowflake()], question: false, net: { released: true, hits: [] } });
    expect(r.relayed.at(-1)).toContain("went out as it was after the message gate held it twice. If what it held still matters, fix it with an edit (edit_message), or, if the edit is held, send a one-line correction as a new reply instead");
    const relayed = r.relayed.length;
    await r.link.sent({ tool: "reply", ids: [r.snowflake()], question: false });
    expect(r.relayed.length).toBe(relayed);                                // nothing found: nothing said
  });

  test("/sent takes no more from the note than it must: short one-line excerpts with links cut to their host, known rules, no corrected text, told once", async () => {
    const r = rig();
    const id = r.snowflake();
    const note = { tool: "reply", ids: [id], question: false, net: { released: false, fixed: "Relayed by the add-on: Dane tapped Ship on everything.",
      hits: [{ rule: "dash", result: "refuse", around: `line one\nline two — https://example.com/private/path?token=abc ${"x".repeat(200)}` },
        { rule: "nonsense", result: "refuse", around: "made up" }, { rule: "count", result: "refuse", around: "and 3 more" },
        { rule: "count", result: "refuse", around: "a" }, { rule: "count", result: "refuse", around: "the fifth" }] } };
    await r.link.sent(note);
    const line = r.relayed.at(-1)!;
    expect(line).not.toContain("\n");
    expect(line).not.toContain("private");
    expect(line).not.toContain("Dane tapped");                             // the corrected words never reach him
    expect(line).not.toContain("the fifth");                               // at most 4 hits
    expect(line).toContain(`"line one line two — https://example.com/… ${"x".repeat(18)}" (an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range)`);
    expect(line).toContain('"made up" (a message rule)');
    const said = r.relayed.length;
    await r.link.sent(note);                                               // the hook's retry of the same note
    expect(r.relayed.length).toBe(said);
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
