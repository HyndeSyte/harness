// The message gate on Cain's own Discord replies and edits (hooks/discord-send.ts and
// gate/send.ts), enforcing since 0.10.0: em dashes and "add-on" fixed in place, the rest
// held back with what to change, the third try let through, and the safety net after the
// send (hooks/discord-sent.ts). Each hook is also run as a child process, as Claude Code
// runs it.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGate } from "../rootfs/opt/cain/gate/log";
import { asksSomething } from "../rootfs/opt/cain/gate/plugin";
import { decideSend, EDIT_WINDOW_MS, type CardsView } from "../rootfs/opt/cain/gate/send";
import { act, callOf, cardsNow, entry, plainInput, readDm, keepDm, keyOf, releasable, repliedIn, selfTest, STALE_MS, textHash, TRY_MS, type Tries, wasReleased } from "../rootfs/opt/cain/hooks/discord-send";
import { AGAIN_MS, noteOf, tellLink } from "../rootfs/opt/cain/hooks/discord-sent";

const HOOK = join(import.meta.dir, "../rootfs/opt/cain/hooks/discord-send.ts");
const SENT_HOOK = join(import.meta.dir, "../rootfs/opt/cain/hooks/discord-sent.ts");
const SETTINGS = join(import.meta.dir, "../rootfs/opt/cain/settings.json");
const REPLY = "mcp__plugin_discord_discord__reply", EDIT = "mcp__plugin_discord_discord__edit_message";
const NOW = Date.UTC(2026, 10, 12, 15, 0);
const DM = "5151000000000000001", OTHER = "5151000000000000002";
// A Discord id made at a time, as Discord makes them.
const flake = (at: number, n = 1) => String(((BigInt(at) - 1420070400000n) << 22n) + BigInt(n));
// A receipt whose buttons are Not mine, Wrong time, Just this once and Stop; an approval
// with Undo up; Cain's own ask, answered; a link notice; and two replies of Cain's own.
const RECEIPT = "1300000000000000001", UNDO_CARD = "1300000000000000002", ASK = "1300000000000000003", NOTICE = "1300000000000000004";
const MINE = "1300000000000000010", MINE2 = "1300000000000000011", HIS = "1300000000000000099";
const CARDS: CardsView = { written_at: NOW, owner: "4242", dm: DM, sent: [MINE, MINE2], cards: [
  { message: RECEIPT, kind: "card", writer: "specialist", labels: ["Not mine", "Wrong time", "Just this once", "Stop"], live: true, item: "none", question: null, posted: NOW - 3_600_000 },
  { message: UNDO_CARD, kind: "card", writer: "specialist", labels: ["Undo", "Stop"], live: true, item: "none", question: null, posted: NOW - 600_000 },
  { message: ASK, kind: "ask", writer: "cain", labels: ["Filed", "Not filed"], live: false, item: "P08", question: "Q2", posted: NOW - 7_200_000 },
  { message: NOTICE, kind: "notice", writer: "link", labels: [], live: false, item: "none", question: "notice", posted: NOW - 60_000 },
] };
const NO_STOP: CardsView = { ...CARDS, cards: CARDS.cards.map((c) => ({ ...c, labels: c.labels.filter((l) => l !== "Stop") })) };
const reply = (text: string, reply_to?: string, chat_id = DM) => ({ session_id: "s1", tool_name: REPLY, hook_event_name: "PreToolUse",
  tool_input: { chat_id, text, ...(reply_to ? { reply_to } : {}) } });
const edit = (text: string, message_id: string, chat_id = DM) => ({ session_id: "s1", tool_name: EDIT, hook_event_name: "PreToolUse",
  tool_input: { chat_id, message_id, text } });
const decide = (input: any, cards: CardsView | null = CARDS, o: { dm?: string | null; now?: number; replied?: Set<string> } = {}) =>
  decideSend(callOf(input)!, cards, { now: NOW, ...o });

describe("what the gate does with Cain's reply", () => {
  test("Nov 10, synthetic: tap Undo in a reply to a receipt without Undo is held, naming its buttons and the live card with Undo", () => {
    const d = decide(reply("If that's wrong, tap Undo.", RECEIPT));
    expect(d.would).toBe("refuse");
    expect(d.hard).toBe(false);
    expect(d.hits).toMatchObject([{ rule: "button", result: "refuse", label: "Undo" }]);
    expect(d.said).toStartWith("The message gate held this: \"Undo\" isn't on the card this answers (its buttons: Not mine, Wrong time, Just this once, Stop); live card with it: message 1300000000000000002 (");
    expect(d.said).toEndWith("Rewrite and send now; don't mention it to him.");
  });

  test("a button on the live card it answers passes; on a card whose buttons came off, or with no card, it's held", () => {
    expect(decide(reply("Tap Wrong time if it's off.", RECEIPT)).would).toBe("pass");
    expect(decide(reply("Tap Filed when it's in.", ASK)).would).toBe("refuse");
    const none = decide(reply("Tap Undo below the card."));
    expect(none.would).toBe("refuse");
    expect(none.said).toContain("this reply answers no card that has it");
  });

  test("tap Stop is true while a live message carries Stop, and held when none does", () => {
    expect(decide(reply("If you want it all to halt, tap Stop.", HIS)).would).toBe("pass");
    expect(decide(reply("If you want it all to halt, tap Stop.", HIS), NO_STOP).would).toBe("refuse");
  });

  test("each refusing rule holds it back, with what to change", () => {
    const count = decide(reply("Two blocks moved and 3 more."));
    expect(count).toMatchObject({ would: "refuse", hits: [{ rule: "count" }] });
    expect(count.said).toContain("name each one instead of a count");
    const machine = decide(reply("Landed 0123456789abcdef0123456789abcdef01234567 in main."));
    expect(machine).toMatchObject({ would: "refuse", hits: [{ rule: "machine" }] });
    expect(machine.said).toContain("say it as people say it");
  });

  test("a long number or code passes only in a reply to his own message, never to one of Cain's own", () => {
    expect(decide(reply("The tracking number is 123456789012345678.", HIS)).would).toBe("pass");
    expect(decide(reply("The tracking number is 123456789012345678.")).would).toBe("refuse");
    expect(decide(reply("The tracking number is 123456789012345678.", MINE)).would).toBe("refuse");
    expect(decide(reply("Run `0123456789abcdef0123456789abcdef01234567`.", HIS)).would).toBe("pass");
  });

  test("a fix sends the fixed words; a fix and a refusal together hold it, saying the fix is made for him", () => {
    const d = decide(reply("Moved swim — it's at 4:30 now."));
    expect(d).toMatchObject({ would: "fix", fixed: "Moved swim, it's at 4:30 now.", chat: "his" });
    const both = decide(reply("Moved swim — tap Undo."));
    expect(both.would).toBe("refuse");
    expect(both.said).toContain("Its em dashes and add-ons are fixed for you when it goes.");
  });

  test("with no cards, a named button is held and the text rules still run", () => {
    const d = decide(reply("Tap Approve on it.", RECEIPT), null, { dm: DM });
    expect(d).toMatchObject({ would: "refuse", hits: [{ rule: "button", result: "unsure" }] });
    expect(d.said).toContain("can't be checked right now");
    expect(decide(reply("Two blocks and 3 more.", RECEIPT), null).would).toBe("refuse");
    expect(decide(reply("Moved swim to 4:30."), null).would).toBe("pass");
  });

  test("only his DM: a chat the link says isn't his is held for good; one that differs only from the cached id is soft; an unknown DM passes, said so", () => {
    const other = decide(reply("Moved swim to 4:30.", undefined, OTHER));
    expect(other).toMatchObject({ would: "refuse", hard: true, chat: "other" });
    expect(other.said).toContain("That chat isn't his DM: send only to him");
    // The link's DM id wins over the cached one: a stale cache never holds a send to his DM.
    expect(decide(reply("Moved swim to 4:30."), CARDS, { dm: OTHER })).toMatchObject({ would: "pass", chat: "his" });
    // With no cards, the cached id is all there is: a mismatch is held, softly (the plugin's own allowlist still holds).
    const cached = decide(reply("Moved swim to 4:30.", undefined, OTHER), null, { dm: DM });
    expect(cached).toMatchObject({ would: "refuse", hard: false, chat: "other" });
    expect(cached.said).toContain("isn't his DM as last seen");
    expect(decide(reply("Moved swim to 4:30."), null, { dm: null })).toMatchObject({ would: "pass", chat: "unknown" });
  });

  test("cards that name no DM (a new bot, before the link has asked Discord) leave his DM unknown: the cached id doesn't count", () => {
    const noDm: CardsView = { ...CARDS, dm: null };
    // The cache holds the old bot's DM: a send to his new DM isn't held against it.
    expect(decide(reply("Moved swim to 4:30."), noDm, { dm: OTHER })).toMatchObject({ would: "pass", chat: "unknown", hits: [] });
    expect(decide(reply("Moved swim to 4:30.", undefined, OTHER), noDm, { dm: DM })).toMatchObject({ would: "pass", chat: "unknown" });
    // Only with no cards at all does the cache count.
    expect(decide(reply("Moved swim to 4:30."), null, { dm: OTHER })).toMatchObject({ would: "refuse", chat: "other", hard: false });
  });

  test("an edit is only for his own replies, names no button, and waits while that can't be checked", () => {
    expect(decide(edit("Moved swim to 5:00.", MINE)).would).toBe("pass");
    const card = decide(edit("Fixed the time.", NOTICE));
    expect(card).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "target", result: "refuse" }] });
    expect(card.said).toContain("isn't one of your own replies: edit only your own, or say it in a new reply.");
    expect(card.said).not.toContain("Rewrite");                                // rewording it wouldn't help
    expect(decide(edit("Fixed the time.", RECEIPT)).hard).toBe(true);           // a specialist's card
    expect(decide(edit("Tap Undo now.", MINE)).would).toBe("refuse");
    const down = decide(edit("Fixed the time.", MINE), null);
    expect(down).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "target", result: "unsure" }] });
    expect(down.said).toBe("The message gate held this: Which messages are your own replies can't be checked right now: send it as a new reply instead, or edit in a minute. Don't mention it to him.");
  });

  test("a message the link knows as its own is never his to edit, even on his list", () => {
    const listed: CardsView = { ...CARDS, sent: [...CARDS.sent!, NOTICE, RECEIPT] };
    expect(decide(edit("Fixed the time.", NOTICE), listed)).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "target", result: "refuse" }] });
    expect(decide(edit("Fixed the time.", RECEIPT), listed).would).toBe("refuse");
    // His reply holding the moving Stop is one the link knows as "plain": still his.
    const plain: CardsView = { ...CARDS, cards: [...CARDS.cards, { message: MINE, kind: "plain", writer: "cain", labels: ["Stop"], live: true, item: "none", question: "plain", posted: NOW - 60_000 }] };
    expect(decide(edit("Moved swim to 5:00.", MINE), plain).would).toBe("pass");
  });

  test("the edit window: a fresh message the link doesn't know passes once his session's transcript shows his reply tool made it", () => {
    const fresh = flake(NOW - 30_000), old = flake(NOW - EDIT_WINDOW_MS - 60_000);
    expect(decide(edit("Moved swim to 5:00.", fresh), CARDS, { replied: new Set([fresh]) })).toMatchObject({ would: "pass", hits: [] });
    // Fresh but not shown as his reply (a permission prompt the plugin posted, a reply of another session): it waits.
    const unsure = decide(edit("Moved swim to 5:00.", fresh), CARDS, { replied: new Set() });
    expect(unsure).toMatchObject({ would: "refuse", hard: true, hits: [{ rule: "target", result: "unsure" }] });
    expect(unsure.said).toContain("send it as a new reply instead, or edit in a minute");
    expect(decide(edit("Moved swim to 5:00.", fresh)).would).toBe("refuse");   // no transcript at all (keeper.sh check)
    // Older than the window and not on his list: not his.
    expect(decide(edit("Moved swim to 5:00.", old), CARDS, { replied: new Set([old]) }).hits).toMatchObject([{ rule: "target", result: "refuse" }]);
    // The window never covers a message the link knows, or one with no cards to tell.
    expect(decide(edit("Fixed.", NOTICE), CARDS, { replied: new Set([NOTICE]) }).would).toBe("refuse");
    expect(decide(edit("Moved swim to 5:00.", fresh), null, { replied: new Set([fresh]) }).hits).toMatchObject([{ rule: "target", result: "unsure" }]);
    // And the wording rules still run on an edit that passes the window.
    expect(decide(edit("Moved swim and 3 more.", fresh), CARDS, { replied: new Set([fresh]) }).hits).toMatchObject([{ rule: "count" }]);
  });

  test("with no cards: every rule still runs; a long number in a reply is held, since whether it answers him can't be told", () => {
    expect(decide(reply("Two blocks and 3 more.", RECEIPT), null).would).toBe("refuse");
    expect(decide(reply("It's 123456789012345678.", HIS), null).would).toBe("refuse");
    expect(decide(reply("Tap Undo.", RECEIPT), null).hits).toMatchObject([{ rule: "button", result: "unsure" }]);
    expect(decide(edit("Fixed.", NOTICE), null).hits).toMatchObject([{ rule: "target", result: "unsure" }]);
  });

  test("an em dash between two numbers, or a time and a number, is held, saying to say it without the dash, and the other fixes are still made", () => {
    const d = decide(reply("Room 4—5 is free — then lunch."));
    expect(d).toMatchObject({ would: "refuse", hard: false, hits: [{ rule: "dash", result: "refuse" }, { rule: "dash", result: "fix" }] });
    expect(d.said).toBe("The message gate held this: \"Room 4—5 is free — then lunch.\": say it without the dash, as a range in words if it is one. Its other em dashes and add-ons are fixed for you when it goes. Rewrite and send now; don't mention it to him.");
    // A time and a number: held, and the reason doesn't call it a range.
    const party = decide(reply("Party is 6 PM — 8."));
    expect(party).toMatchObject({ would: "refuse", hard: false, hits: [{ rule: "dash", result: "refuse" }] });
    expect(party.said).toBe("The message gate held this: \"Party is 6 PM — 8.\": say it without the dash, as a range in words if it is one. Rewrite and send now; don't mention it to him.");
    expect(decide(reply("Swim moved to 4:30 — that works."))).toMatchObject({ would: "fix", fixed: "Swim moved to 4:30, that works." });
  });

  test("only the two sends are read, with the chat, the session and the whole input", () => {
    expect(callOf({ tool_name: "mcp__plugin_discord_discord__react", tool_input: { text: "x" } })).toBeNull();
    expect(callOf({ tool_name: REPLY })).toBeNull();
    expect(callOf(reply("hi", "not-an-id"))).toEqual({ tool: "reply", text: "hi", chat: DM, session: "s1", replyTo: undefined,
      input: { chat_id: DM, text: "hi", reply_to: "not-an-id" } });
  });
});

describe("what the hook answers, and the third try", () => {
  const call = (text: string, chat = DM) => callOf(reply(text, undefined, chat))!;
  test("a fix to his DM goes out in place: allow, with the whole input and only the text changed", () => {
    const c = callOf(reply("Moved swim — it's at 4:30 now.", HIS))!;
    const out = act(c, decideSend(c, CARDS), {}, NOW);
    expect(out.did).toBe("fixed");
    expect(out.output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      permissionDecisionReason: expect.stringContaining("fixed its wording"),
      updatedInput: { chat_id: DM, text: "Moved swim, it's at 4:30 now.", reply_to: HIS } } });
  });

  test("a fix while his DM can't be told is a refusal that says exactly what to send", () => {
    const c = call("Moved swim — it's at 4:30 now.");
    const out = act(c, decideSend(c, null, { dm: null }), {}, NOW);
    expect(out.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny",
      permissionDecisionReason: "Send exactly this instead: Moved swim, it's at 4:30 now." } });
  });

  test("two refusals in 10 minutes, and the third try goes as it is, logged; a pass resets the count", () => {
    const t: Tries = {};
    const c = call("Two blocks moved and 3 more.");
    const d = decideSend(c, CARDS);
    expect(act(c, d, t, NOW).did).toBe("refused");
    expect(act(c, d, t, NOW + 60_000).did).toBe("refused");
    const third = act(c, d, t, NOW + 120_000);
    expect(third).toEqual({ output: null, did: "passed after two refusals" });
    expect(wasReleased(t, keyOf("s1", DM), c.text, NOW + 130_000)).toBe(true);
    expect(wasReleased(t, keyOf("s1", DM), "other words", NOW + 130_000)).toBe(false);
    expect(act(c, d, t, NOW + 180_000).did).toBe("refused");            // counting again from there
    const clean = call("Moved swim to 4:30.");
    expect(act(clean, decideSend(clean, CARDS), t, NOW + 200_000).did).toBe("passed");
    expect(act(c, d, t, NOW + 210_000).did).toBe("refused");
    expect(act(c, d, t, NOW + 220_000).did).toBe("refused");            // a pass between: two again before a release
  });

  test("refusals further apart than 10 minutes start the count over", () => {
    const t: Tries = {};
    const c = call("Two blocks moved and 3 more.");
    const d = decideSend(c, CARDS);
    act(c, d, t, NOW);
    act(c, d, t, NOW + 60_000);
    expect(act(c, d, t, NOW + TRY_MS + 1_000).did).toBe("refused");
  });

  test("another chat, or an edit of someone else's message, is never let through", () => {
    const t: Tries = {};
    const c = call("Moved swim to 4:30.", OTHER);
    const d = decideSend(c, CARDS);
    for (let i = 0; i < 5; i++) expect(act(c, d, t, NOW + i).did).toBe("refused");
    const e = callOf(edit("Fixed.", NOTICE))!;
    for (let i = 0; i < 5; i++) expect(act(e, decideSend(e, CARDS), t, NOW + i).did).toBe("refused");
  });

  test("no third try for a hard decision, even when its wording is what's held", () => {
    // An edit of the link's card with a hidden count (the third try once let this through).
    const card = callOf(edit("Shipped two fixes and 3 more.", NOTICE))!;
    const dc = decideSend(card, CARDS);
    expect(releasable(dc)).toBe(false);
    const t: Tries = {};
    for (let i = 0; i < 5; i++) expect(act(card, dc, t, NOW + i)).toMatchObject({ did: "refused", output: { hookSpecificOutput: { permissionDecision: "deny" } } });
    // An edit while which messages are his can't be told, and a send to a chat the link says isn't his.
    const down = callOf(edit("Moved swim and 3 more.", MINE))!;
    const other = callOf(reply("Two blocks and 3 more.", undefined, OTHER))!;
    for (const [c, d] of [[down, decideSend(down, null, { dm: DM })], [other, decideSend(other, CARDS)]] as const) {
      expect(releasable(d)).toBe(false);
      const tries: Tries = {};
      for (let i = 0; i < 5; i++) {
        const out = act(c, d, tries, NOW + i);
        expect(out.did).toBe("refused");
        expect(out.counted).toBeUndefined();
      }
      expect(Object.values(tries).every((r) => r.n === 0)).toBe(true);   // nothing counted toward a third try
    }
    // A chat that differs only from the cached id is soft: the third try lets it go.
    const stale = callOf(reply("Moved swim to 4:30.", undefined, OTHER))!;
    const ds = decideSend(stale, null, { dm: DM });
    expect(releasable(ds)).toBe(true);
    const tries: Tries = {};
    expect(act(stale, ds, tries, NOW).did).toBe("refused");
    expect(act(stale, ds, tries, NOW + 1).did).toBe("refused");
    expect(act(stale, ds, tries, NOW + 2).did).toBe("passed after two refusals");
  });

  test("while his DM can't be told, a refusal ends on the third try, as a clean send there goes; a fix says what to send, and ends the same way", () => {
    const held = callOf(reply("Two blocks and 3 more."))!;
    const dh = decideSend(held, null, { dm: null });
    expect(dh).toMatchObject({ would: "refuse", chat: "unknown", hard: false });
    expect(releasable(dh)).toBe(true);
    const t: Tries = {};
    expect(act(held, dh, t, NOW)).toMatchObject({ did: "refused", counted: true });
    expect(act(held, dh, t, NOW + 1).did).toBe("refused");
    expect(act(held, dh, t, NOW + 2)).toEqual({ output: null, did: "passed after two refusals" });
    // A fix goes in place only to his DM: elsewhere it's "send exactly this instead", never a loop.
    const fix = callOf(reply("Moved swim — it's at 4:30 now."))!;
    const df = decideSend(fix, { ...CARDS, dm: null });
    expect(df).toMatchObject({ would: "fix", chat: "unknown" });
    const tf: Tries = {};
    expect(act(fix, df, tf, NOW).output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Send exactly this instead: Moved swim, it's at 4:30 now." } });
    expect(act(fix, df, tf, NOW + 1).did).toBe("refused");
    expect(act(fix, df, tf, NOW + 2).did).toBe("passed after two refusals");
    const sent = callOf(reply("Moved swim, it's at 4:30 now."))!;
    expect(act(sent, decideSend(sent, { ...CARDS, dm: null }), {}, NOW)).toEqual({ output: null, did: "passed, his DM unknown" });
  });

  test("allow only for a plain call: with anything else (files to attach), a fix says what to send instead and auto mode checks the call", () => {
    const files = callOf({ ...reply("Moved swim — see the photo.", HIS), tool_input: { chat_id: DM, text: "Moved swim — see the photo.", reply_to: HIS, files: ["/tmp/a.png"] } })!;
    expect(plainInput(files)).toBe(false);
    const out = act(files, decideSend(files, CARDS), {}, NOW);
    expect(out).toMatchObject({ did: "refused", counted: true, output: { hookSpecificOutput: { permissionDecision: "deny",
      permissionDecisionReason: "Send exactly this instead: Moved swim, see the photo." } } });
    // The fixed words, sent again with the file, carry nothing to fix: the hook says nothing, and auto mode decides.
    const again = callOf({ ...reply("x", HIS), tool_input: { chat_id: DM, text: "Moved swim, see the photo.", reply_to: HIS, files: ["/tmp/a.png"] } })!;
    expect(act(again, decideSend(again, CARDS), {}, NOW)).toEqual({ output: null, did: "passed" });
    // An edit's plain input is chat_id, message_id and text: its fix goes in place.
    const e = callOf(edit("Moved swim — now at 5.", MINE))!;
    expect(plainInput(e)).toBe(true);
    expect(act(e, decideSend(e, CARDS), {}, NOW)).toMatchObject({ did: "fixed",
      output: { hookSpecificOutput: { permissionDecision: "allow", updatedInput: { chat_id: DM, message_id: MINE, text: "Moved swim, now at 5." } } } });
  });

  test("a log line for each hit and each refusal, never for a clean reply to his DM", () => {
    const clean = call("Moved swim to 4:30.");
    const dc = decideSend(clean, CARDS);
    expect(entry(clean, dc, act(clean, dc, {}, NOW), "link", NOW)).toBeNull();
    const c = callOf(reply(`${"Moved the swim lesson to later today. ".repeat(4)}Tap Undo if wrong.`, RECEIPT))!;
    const d = decideSend(c, CARDS);
    const line = entry(c, d, act(c, d, {}, NOW), "link", NOW)!;
    expect(line).toMatchObject({ at: NOW, point: "reply", writer: "cain", cards: "link", would: "refuse", did: "refused", chat: "his", reply_to: RECEIPT });
    for (const h of line.hits as any[]) expect(h.around.length).toBeLessThanOrEqual(60);
    expect(JSON.stringify(line)).not.toContain("Moved the swim lesson to later today. Moved");   // never the whole message
    const unknown = call("Moved swim to 4:30.");
    const du = decideSend(unknown, null, { dm: null });
    expect(entry(unknown, du, act(unknown, du, {}, NOW), "none", NOW)).toMatchObject({ did: "passed, his DM unknown" });
  });
});

describe("where the hook gets the cards and his DM", () => {
  test("the link first; its file only while fresh; else none", async () => {
    const file = JSON.stringify({ ...CARDS, written_at: NOW - 60_000 });
    expect((await cardsNow(async () => CARDS, () => file, NOW)).from).toBe("link");
    expect((await cardsNow(async () => { throw new Error("ECONNREFUSED"); }, () => file, NOW)).from).toBe("file");
    const stale = JSON.stringify({ ...CARDS, written_at: NOW - STALE_MS - 1 });
    expect(await cardsNow(async () => null, () => stale, NOW)).toEqual({ cards: null, from: "none" });
    expect(await cardsNow(async () => null, () => null, NOW)).toEqual({ cards: null, from: "none" });
    expect(await cardsNow(async () => null, () => "{half", NOW)).toEqual({ cards: null, from: "none" });
  });

  test("his DM's id is kept in a small file of the hook's own", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gate-dm-")), "work", "gate-dm.json");
    expect(readDm(path)).toBeNull();
    keepDm(DM, path);
    expect(readDm(path)).toBe(DM);
    keepDm("not an id", path);
    expect(readDm(path)).toBe(DM);
    keepDm(OTHER, path);                                                 // the link's word replaces a stale one
    expect(readDm(path)).toBe(OTHER);
  });

  test("his own replies, from the end of his session's transcript: only the reply tool's own answers count", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-transcript-"));
    const path = join(dir, "session.jsonl");
    const line = (o: unknown) => JSON.stringify(o);
    const use = (id: string, name: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { chat_id: DM, text: "x" } }] } });
    const result = (id: string, text: string) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
    writeFileSync(path, [
      "{half a line cut off at the start",
      use("toolu_1", REPLY), result("toolu_1", "sent (id: 1300000000000000801)"),
      use("toolu_2", REPLY), result("toolu_2", "sent 2 parts (ids: 1300000000000000802, 1300000000000000803)"),
      use("toolu_3", EDIT), result("toolu_3", "edited (id: 1300000000000000804)"),             // an edit makes no reply
      use("toolu_4", "Bash"), result("toolu_4", "sent (id: 1300000000000000805)"),             // words elsewhere aren't proof
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "sent (id: 1300000000000000806)" }] } }),
      use("toolu_5", REPLY), result("toolu_5", "reply failed after 0 of 1 chunk(s) sent: boom"),
    ].join("\n") + "\n");
    expect([...repliedIn(path)].sort()).toEqual(["1300000000000000801", "1300000000000000802", "1300000000000000803"]);
    expect([...repliedIn(path, 600)]).not.toContain("1300000000000000801");   // only the end is read
    expect(repliedIn(join(dir, "none.jsonl")).size).toBe(0);
    expect(repliedIn(undefined).size).toBe(0);
  });
});

describe("the gate's log", () => {
  test("written in the background, never in the way: the call returns before the line lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-log-"));
    const path = join(dir, "work", "gate-report.jsonl");
    const pending = appendGate({ point: "reply", hits: [] }, path);
    expect(existsSync(path)).toBe(false);                               // nothing written on the caller's turn
    await pending;
    expect(readFileSync(path, "utf8")).toBe('{"point":"reply","hits":[]}' + String.fromCharCode(10));
  });

  test("a full log moves aside, and one that can't be written is only logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-log-"));
    const path = join(dir, "gate-report.jsonl");
    writeFileSync(path, "x".repeat(50));
    await appendGate({ n: 1 }, path, 10);
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(50));
    expect(readFileSync(path, "utf8")).toBe('{"n":1}' + String.fromCharCode(10));
    writeFileSync(join(dir, "blocker"), "a file where the folder would be");
    const said: string[] = [];
    await appendGate({ n: 2 }, join(dir, "blocker", "gate.jsonl"), 10, (l) => said.push(l));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("couldn't log the gate's report");
  });

  test("appends in the same tick go one at a time: a full log moves aside once, and no line is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-log-"));
    const path = join(dir, "gate-report.jsonl");
    writeFileSync(path, "x".repeat(2000));                              // over the limit
    const all = Array.from({ length: 20 }, (_, n) => appendGate({ n }, path, 1000));
    expect(await Promise.all(all)).toEqual(Array(20).fill(undefined));   // each settles, none throws
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(2000));   // the full log, kept
    const NL = String.fromCharCode(10);
    expect(readFileSync(path, "utf8")).toBe(Array.from({ length: 20 }, (_, n) => JSON.stringify({ n }) + NL).join(""));
  });
});

describe("the safety net after the send (discord-sent.ts)", () => {
  const sent = (text: string, response: unknown, extra: any = {}) => ({ session_id: "s1", tool_name: REPLY, hook_event_name: "PostToolUse",
    tool_input: { chat_id: DM, text, ...extra }, tool_response: response });

  test("tells the link the ids the plugin answered with, and whether the last line asks something", () => {
    expect(noteOf(sent("Moved swim to 4:30.", [{ type: "text", text: "sent (id: 1300000000000000777)" }]), NOW, {}))
      .toEqual({ tool: "reply", ids: ["1300000000000000777"], question: false, chat: DM });
    expect(noteOf(sent("Want me to move it?", "sent 2 parts (ids: 1300000000000000778, 1300000000000000779)", { reply_to: HIS }), NOW, {}))
      .toEqual({ tool: "reply", ids: ["1300000000000000778", "1300000000000000779"], question: true, chat: DM, reply_to: HIS });
    expect(noteOf({ ...sent("x", "edited (id: 1300000000000000010)"), tool_name: EDIT, tool_input: { chat_id: DM, message_id: MINE, text: "Fixed the time." } }, NOW, {}))
      .toMatchObject({ tool: "edit", ids: [MINE], question: false });
    expect(noteOf(sent("x", "reply failed after 0 of 1 chunk(s) sent: boom"), NOW, {})).toBeNull();   // nothing went out
    expect(noteOf({ ...sent("x", "sent (id: 1300000000000000777)"), tool_name: "Bash" }, NOW, {})).toBeNull();
  });

  test("what went out is read again with the rules that need no cards: a hit is a bypass, unless the third try let it through", () => {
    const text = "Two blocks moved — and 3 more.";
    const bypass = noteOf(sent(text, "sent (id: 1300000000000000777)"), NOW, {})!;
    expect(bypass.net).toEqual({ released: false, hits: [{ rule: "dash", result: "fix", around: text }, { rule: "count", result: "refuse", around: text }] });
    // Never the corrected words, and an excerpt's link keeps only its host.
    const link = noteOf(sent("See https://example.com/private/path?token=abc — and 3 more.", "sent (id: 1300000000000000777)"), NOW, {})!;
    expect(JSON.stringify(link)).not.toContain("private");
    expect(link.net!.hits[0].around).toBe("See https://example.com/… — and 3 more.");
    const t: Tries = { [keyOf("s1", DM)]: { n: 0, first: NOW, released: [{ hash: textHash(text), at: NOW - 1_000 }] } };
    expect(noteOf(sent(text, "sent (id: 1300000000000000777)"), NOW, t)!.net!.released).toBe(true);
    expect(noteOf(sent("It's 123456789012345678.", "sent (id: 1300000000000000777)", { reply_to: HIS }), NOW, {})!.net).toBeUndefined();
  });

  test("whether it asks something: any sentence of its last paragraph ending in a question", () => {
    expect(asksSomething("Should I move swim? Say yes and I'll do it.")).toBe(true);
    expect(noteOf(sent("Should I move swim? Say yes and I'll do it.", "sent (id: 1300000000000000777)"), NOW, {})!.question).toBe(true);
    expect(asksSomething("Moved swim.\n\nWant art moved too?")).toBe(true);
    expect(asksSomething("Really?! Then I'll leave it.")).toBe(true);
    expect(asksSomething("Did it move?\n\nIt moved to 4:30.")).toBe(false);   // asked in an earlier paragraph
    expect(asksSomething("See https://example.com/a?b=1 for it.")).toBe(false);
    expect(asksSomething("Moved swim to 4:30.")).toBe(false);
  });

  test("a third try let through is told even when these rules find nothing (a button only the cards show)", () => {
    const text = "Tap Undo on that one.";
    const t: Tries = { [keyOf("s1", DM)]: { n: 0, first: NOW, released: [{ hash: textHash(text), at: NOW - 1_000 }] } };
    expect(noteOf(sent(text, "sent (id: 1300000000000000777)"), NOW, t)!.net).toEqual({ hits: [], released: true });
    expect(noteOf(sent(text, "sent (id: 1300000000000000777)"), NOW + TRY_MS + 1, t)!.net).toBeUndefined();   // only just now
  });

  test("a note the link doesn't take is sent again, up to 3 times within the hook's 15 seconds; a refusal isn't", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const note = { tool: "reply" as const, ids: ["1300000000000000777"], question: false };
    const answers = (...xs: (number | "no answer")[]) => {
      const tries: number[] = [];
      return { tries, post: async (_: string, timeoutMs: number) => {
        tries.push(timeoutMs);
        const x = xs.shift() ?? 200;
        if (x === "no answer") throw new Error("TimeoutError");
        return new Response("{}", { status: x });
      } };
    };
    const lost = answers("no answer", 503, 200);
    expect(await tellLink(note, lost.post, wait)).toBe(true);
    expect(lost.tries).toHaveLength(3);
    expect(waits).toEqual([500, 1_000]);
    const never = answers("no answer", "no answer", 500, 429, 200);
    expect(await tellLink(note, never.post, wait)).toBe(false);
    expect(never.tries).toHaveLength(4);                                 // the first try and 3 more
    const refused = answers(400);
    expect(await tellLink(note, refused.post, wait)).toBe(false);
    expect(refused.tries).toHaveLength(1);
    // Every try and every wait fit inside the hook's 15 seconds, with room to start.
    expect(4 * never.tries[0] + AGAIN_MS.reduce((a, b) => a + b, 0)).toBeLessThan(13_000);
  });

  test("run as Claude Code runs it: it posts to the link's /sent with the key, prints nothing, and logs a bypass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-sent-"));
    const TOKEN = "not-a-real-token.for-the-sent-test";
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    const KEY = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const got: any[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      got.push({ path: new URL(req.url).pathname, key: req.headers.get("x-harness-key") === KEY, body: await req.json() });
      return Response.json({ status: "ok" });
    } });
    try {
      const env = { ...process.env, CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_ENV: join(dir, ".env"),
        CAIN_GATE_LOG: join(dir, "gate.jsonl"), CAIN_GATE_TRIES: join(dir, "tries.json") };
      const p = Bun.spawn(["bun", SENT_HOOK], { stdin: new TextEncoder().encode(JSON.stringify(sent("Moved swim and 3 more.", "sent (id: 1300000000000000777)"))),
        stdout: "pipe", stderr: "pipe", env });
      expect(await new Response(p.stdout).text()).toBe("");
      expect(await p.exited).toBe(0);
      expect(got).toMatchObject([{ path: "/sent", key: true, body: { tool: "reply", ids: ["1300000000000000777"], net: { released: false } } }]);
      expect(readFileSync(join(dir, "gate.jsonl"), "utf8")).toContain('"did":"bypassed"');
      const bad = Bun.spawn(["bun", SENT_HOOK], { stdin: new TextEncoder().encode("not json"), stdout: "pipe", stderr: "pipe", env });
      expect([await new Response(bad.stdout).text(), await bad.exited]).toEqual(["", 0]);
    } finally { server.stop(true); }
  }, 30_000);

  test("run as Claude Code runs it, against a link that answers 503 once: the note goes again and lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-sent-"));
    writeFileSync(join(dir, ".env"), "DISCORD_BOT_TOKEN=not-a-real-token.for-the-retry-test\n");
    const got: any[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      got.push(await req.json());
      return got.length === 1 ? new Response("busy", { status: 503 }) : Response.json({ status: "ok" });
    } });
    try {
      const env = { ...process.env, CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_ENV: join(dir, ".env"),
        CAIN_GATE_LOG: join(dir, "gate.jsonl"), CAIN_GATE_TRIES: join(dir, "tries.json") };
      const p = Bun.spawn(["bun", SENT_HOOK], { stdin: new TextEncoder().encode(JSON.stringify(sent("Moved swim to 4:30.", "sent (id: 1300000000000000777)"))),
        stdout: "pipe", stderr: "pipe", env });
      expect(await p.exited).toBe(0);
      expect(got).toHaveLength(2);
      expect(got[1]).toEqual(got[0]);
    } finally { server.stop(true); }
  }, 30_000);
});

describe("run as Claude Code runs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cain-send-"));
  const TOKEN = "not-a-real-token.for-the-gate-test";
  writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
  const KEY = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
  let n = 0;
  const files = () => { n++; return { CAIN_GATE_LOG: join(dir, `${n}.jsonl`), CAIN_GATE_TRIES: join(dir, `${n}-tries.json`), CAIN_GATE_DM: join(dir, `${n}-dm.json`) }; };
  const run = async (input: unknown, env: Record<string, string>) => {
    const p = Bun.spawn(["bun", HOOK], { stdin: new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input)),
      stdout: "pipe", stderr: "pipe", env: { ...process.env, CAIN_DISCORD_ENV: join(dir, ".env"), ...env } });
    const out = await new Response(p.stdout).text();
    return { out, code: await p.exited, json: out ? JSON.parse(out).hookSpecificOutput : null };
  };
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const fakeLink = (view: () => CardsView) => {
    const asked: string[] = [];
    const server = Bun.serve({ port: 0, fetch(req) {
      asked.push(`${new URL(req.url).pathname} ${req.headers.get("x-harness-key") === KEY}`);
      return Response.json({ ...view(), written_at: Date.now() });
    } });
    return { server, asked, url: `http://127.0.0.1:${server.port}` };
  };

  test("asks the link with the key; a refusal is a deny with exit 0, a fix an allow with the whole input, a clean reply silence", async () => {
    const link = fakeLink(() => CARDS);
    try {
      const f = files();
      const env = { ...f, CAIN_LINK: link.url, CAIN_CARDS: join(dir, "none.json") };
      const held = await run(reply("If that's wrong, tap Undo.", RECEIPT), env);
      expect(held.code).toBe(0);
      expect(held.json).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(held.json.permissionDecisionReason).toContain("\"Undo\" isn't on the card this answers");
      expect(link.asked).toEqual(["/cards true"]);
      const fixed = await run(reply("Moved swim — it's at 4:30 now.", RECEIPT), env);
      expect(fixed.json).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: expect.any(String),
        updatedInput: { chat_id: DM, text: "Moved swim, it's at 4:30 now.", reply_to: RECEIPT } });
      expect(await run(reply("Moved swim to 4:30.", RECEIPT), env)).toMatchObject({ out: "", code: 0 });
      expect(lines(f.CAIN_GATE_LOG)).toMatchObject([{ did: "refused", cards: "link" }, { did: "fixed" }]);
      expect(readDm(f.CAIN_GATE_DM)).toBe(DM);                            // kept from the link's answer
    } finally { link.server.stop(true); }
  }, 30_000);

  test("a link that never answers costs it 1.5 seconds, well inside its 5, and the rules still hold", async () => {
    const hung = Bun.serve({ port: 0, async fetch() { await Bun.sleep(10_000); return Response.json({}); } });
    try {
      const env = { ...files(), CAIN_LINK: `http://127.0.0.1:${hung.port}`, CAIN_CARDS: join(dir, "none.json") };
      const t0 = performance.now();
      const out = await run(reply("Tap Wrong time if it's off.", RECEIPT), env);
      expect(performance.now() - t0).toBeLessThan(4_500);
      expect(out.json.permissionDecisionReason).toContain("can't be checked right now");   // no cards: a named button is held
    } finally { hung.stop(true); }
  }, 30_000);

  test("the cards are always read first, so no check is skipped: a count is held after the link is asked", async () => {
    const link = fakeLink(() => CARDS);
    try {
      const out = await run(reply("Two blocks moved and 3 more.", RECEIPT), { ...files(), CAIN_LINK: link.url, CAIN_CARDS: join(dir, "none.json") });
      expect(out.json.permissionDecision).toBe("deny");
      expect(link.asked).toEqual(["/cards true"]);
    } finally { link.server.stop(true); }
  }, 30_000);

  test("a stale cached DM id never silences him: the link's id wins and rewrites the file", async () => {
    const link = fakeLink(() => CARDS);
    try {
      const f = files();
      writeFileSync(f.CAIN_GATE_DM, JSON.stringify({ dm: OTHER, at: Date.now() - 86_400_000 }));   // the old bot's DM
      const env = { ...f, CAIN_LINK: link.url, CAIN_CARDS: join(dir, "none.json") };
      for (let i = 0; i < 4; i++) expect(await run(reply("Moved swim to 4:30."), env)).toMatchObject({ out: "", code: 0 });
      expect(readDm(f.CAIN_GATE_DM)).toBe(DM);
      expect(lines(f.CAIN_GATE_LOG)).toEqual([]);
    } finally { link.server.stop(true); }
  }, 30_000);

  test("with the link and its file both down, a chat that differs from the cached id is held softly: the third try lets it go", async () => {
    const f = files();
    writeFileSync(f.CAIN_GATE_DM, JSON.stringify({ dm: OTHER, at: Date.now() }));
    const env = { ...f, CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: join(dir, "none.json") };
    const input = reply("Moved swim to 4:30.");
    expect((await run(input, env)).json.permissionDecisionReason).toContain("isn't his DM as last seen");
    expect((await run(input, env)).json.permissionDecision).toBe("deny");
    expect(await run(input, env)).toMatchObject({ out: "", code: 0 });
    expect(lines(f.CAIN_GATE_LOG).map((l) => l.did)).toEqual(["refused", "refused", "passed after two refusals"]);
  }, 30_000);

  test("an edit straight after his reply passes on his session's transcript, before the link has heard of the reply", async () => {
    const link = fakeLink(() => CARDS);                                  // its list doesn't have the new reply yet
    try {
      const fresh = flake(Date.now() - 5_000);
      const transcript = join(dir, "transcript.jsonl");
      writeFileSync(transcript, [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_9", name: REPLY, input: { chat_id: DM, text: "Moved swim." } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: `sent (id: ${fresh})` }] }] } }),
      ].join("\n") + "\n");
      const env = { ...files(), CAIN_LINK: link.url, CAIN_CARDS: join(dir, "none.json") };
      expect(await run({ ...edit("Moved swim to 5:00.", fresh), transcript_path: transcript }, env)).toMatchObject({ out: "", code: 0 });
      const without = await run(edit("Moved swim to 5:00.", fresh), env);
      expect(without.json.permissionDecisionReason).toContain("can't be checked right now: send it as a new reply instead, or edit in a minute");
    } finally { link.server.stop(true); }
  }, 30_000);

  test("a refusal the tries can't be counted for lets the reply go, logged; a fix still goes in place", async () => {
    writeFileSync(join(dir, "tries-blocker"), "a file where the tries' folder would be");
    const f = { ...files(), CAIN_GATE_TRIES: join(dir, "tries-blocker", "tries.json") };
    const env = { ...f, CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: join(dir, "none.json") };
    writeFileSync(f.CAIN_GATE_DM, JSON.stringify({ dm: DM, at: Date.now() }));
    expect(await run(reply("Two blocks moved and 3 more."), env)).toMatchObject({ out: "", code: 0 });
    expect((await run(reply("Moved swim — it's at 4:30 now."), env)).json.permissionDecision).toBe("allow");
    const link = fakeLink(() => CARDS);                                  // a hard refusal needs no count
    try { expect((await run(reply("Moved swim to 4:30.", undefined, OTHER), { ...env, CAIN_LINK: link.url })).json.permissionDecision).toBe("deny"); }
    finally { link.server.stop(true); }
    expect(lines(f.CAIN_GATE_LOG).map((l) => l.did)).toEqual(["passed, tries not counted", "fixed", "refused"]);
  }, 30_000);

  test("with the link down: its file while fresh; then a named button is held, the text rules hold, his DM is still known", async () => {
    const cards = join(dir, "cards.json");
    writeFileSync(cards, JSON.stringify({ ...CARDS, written_at: Date.now() }));
    const f = files();
    const env = { ...f, CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: cards };
    expect((await run(reply("Tap Wrong time if it's off.", RECEIPT), env)).out).toBe("");
    expect(lines(f.CAIN_GATE_LOG)).toEqual([]);
    expect((await run(reply("Tap Undo below.", RECEIPT), env)).json.permissionDecision).toBe("deny");
    expect(lines(f.CAIN_GATE_LOG)).toMatchObject([{ cards: "file", did: "refused" }]);
    writeFileSync(cards, JSON.stringify({ ...CARDS, written_at: Date.now() - STALE_MS - 60_000 }));
    const unsure = await run(reply("Tap Wrong time if it's off.", RECEIPT), env);
    expect(unsure.json.permissionDecisionReason).toContain("can't be checked right now");
    expect((await run(reply("Moved swim to 4:30."), env)).out).toBe("");
    expect((await run(reply("Moved swim to 4:30.", undefined, OTHER), env)).json.permissionDecisionReason).toContain("isn't his DM");
    expect((await run(edit("Fixed the time.", MINE), env)).json.permissionDecisionReason).toContain("send it as a new reply instead, or edit in a minute");
  }, 30_000);

  test("two refusals, then the third try goes as it is; the same while his DM can't be told at all", async () => {
    const f = files();
    writeFileSync(f.CAIN_GATE_DM, JSON.stringify({ dm: DM, at: Date.now() }));
    const env = { ...f, CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: join(dir, "none.json") };
    const input = reply("Two blocks moved and 3 more.");
    expect((await run(input, env)).json.permissionDecision).toBe("deny");
    expect((await run(input, env)).json.permissionDecision).toBe("deny");
    expect(await run(input, env)).toMatchObject({ out: "", code: 0 });
    expect(lines(env.CAIN_GATE_LOG).map((l) => l.did)).toEqual(["refused", "refused", "passed after two refusals"]);
    const blind = { ...files(), CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: join(dir, "none.json") };   // no DM known anywhere
    expect((await run(input, blind)).json.permissionDecision).toBe("deny");
    expect((await run(input, blind)).json.permissionDecision).toBe("deny");
    expect(await run(input, blind)).toMatchObject({ out: "", code: 0 });
    expect(lines(blind.CAIN_GATE_LOG)).toMatchObject([{ chat: "unknown", did: "refused" }, { did: "refused" }, { did: "passed after two refusals" }]);
  }, 30_000);

  test("after a new bot token the link names no DM yet and the cache holds the old bot's: his replies go at once, never held as another chat", async () => {
    const link = fakeLink(() => ({ ...CARDS, dm: null }));
    try {
      const f = files();
      writeFileSync(f.CAIN_GATE_DM, JSON.stringify({ dm: OTHER, at: Date.now() - 86_400_000 }));   // the old bot's DM
      const env = { ...f, CAIN_LINK: link.url, CAIN_CARDS: join(dir, "none.json") };
      for (let i = 0; i < 3; i++) expect(await run(reply(`Moved swim to 4:3${i}.`), env)).toMatchObject({ out: "", code: 0 });
      expect(lines(f.CAIN_GATE_LOG).map((l) => [l.chat, l.did])).toEqual(Array(3).fill(["unknown", "passed, his DM unknown"]));
      expect(link.asked).toEqual(Array(3).fill("/cards true"));
    } finally { link.server.stop(true); }
  }, 30_000);

  test("fails open: bad input, a log it can't write, or a hook that can't start lets the reply go", async () => {
    const env = { ...files(), CAIN_LINK: "http://127.0.0.1:9", CAIN_CARDS: join(dir, "none.json") };
    for (const bad of ["not json", "", JSON.stringify({ tool_name: REPLY, tool_input: null })])
      expect(await run(bad, env)).toMatchObject({ out: "", code: 0 });
    writeFileSync(join(dir, "blocker"), "a file where the log's folder would be");
    expect((await run(reply("Moved swim — it's at 4:30 now."), { ...env, CAIN_GATE_LOG: join(dir, "blocker", "gate.jsonl"),
      CAIN_GATE_TRIES: join(dir, "blocker", "tries.json") })).code).toBe(0);
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const command = settings.hooks.PreToolUse.find((e: any) => e.matcher === REPLY).hooks[0].command;
    const crash = Bun.spawn(["bash", "-c", command.replace("/opt/cain/hooks/discord-send.ts", "/no/such/hook.ts")], { stdout: "pipe", stderr: "ignore" });
    expect([await new Response(crash.stdout).text(), await crash.exited]).toEqual(["", 0]);
  }, 30_000);

  test("wired on exactly the reply and edit tools: waited for, short, no failure rule; the safety net after, in the background", () => {
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const pre = settings.hooks.PreToolUse.filter((e: any) => e.hooks.some((h: any) => String(h.command).includes("/discord-send.ts")));
    expect(pre.map((e: any) => e.matcher).sort()).toEqual([EDIT, REPLY]);
    for (const e of pre) {
      expect(e.hooks).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-send.ts || true", timeout: 5 }]);
    }
    const post = settings.hooks.PostToolUse.filter((e: any) => e.hooks.some((h: any) => String(h.command).includes("/discord-sent.ts")));
    expect(post.map((e: any) => e.matcher).sort()).toEqual([EDIT, REPLY]);
    for (const e of post) expect(e.hooks).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-sent.ts || true", timeout: 15, async: true }]);
    // The plugin's send tools stay off the allow list: the gate's "allow" covers only a fixed reply to his DM.
    for (const t of [REPLY, EDIT]) expect(settings.permissions.allow).not.toContain(t);
  });

  test("the self-test runs the installed command on a fix, a refusal and a clean reply, and fails on a wiring that can't hold anything", async () => {
    const ok = await selfTest(SETTINGS);
    expect(ok.status).toBe("ok");
    expect(ok.said).toContain("passed its self-test");
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
    settings.hooks.PreToolUse.find((e: any) => e.matcher === REPLY).hooks[0].async = true;
    const broken = join(dir, "settings-async.json");
    writeFileSync(broken, JSON.stringify(settings));
    expect(await selfTest(broken)).toMatchObject({ status: "failed", said: expect.stringContaining("in the background") });
    expect((await selfTest(join(dir, "nowhere.json"))).status).toBe("failed");
  }, 60_000);
});
