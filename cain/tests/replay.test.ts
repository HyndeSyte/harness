// The gate's replay over his DM (piece D, core.ts replay): it reads only, says whose words
// each bot message carries from the link's records, Cain's own replies and his transcripts
// (one bot token posts them all), runs the rules over each and writes what it found for Cain.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP } from "../rootfs/opt/cain/link/core";
import { readTranscripts } from "../rootfs/opt/cain/link/publish";
import { BOT, DAY, DM, HOUR, MIN, OWNER, PR, rig, SHA1 } from "./link-rig";

const btn = (label: string, custom_id: string) => ({ type: 2, style: 2, label, custom_id });
const STOP_ONLY = [{ type: 1, components: [{ ...btn("Stop", STOP), style: 4 }] }];
const RECEIPT_ROWS = [{ type: 1, components: [btn("Not mine", "k:c:nm"), btn("Wrong time", "k:c:wt"), btn("Just this once", "k:c:jo")] }, ...STOP_ONLY];

// A bot message the link didn't post (Cain's plugin, or something else on the bot token).
function botMessage(r: ReturnType<typeof rig>, content: string, o: { replyTo?: string; components?: any[]; at?: number } = {}) {
  const id = r.snowflake(o.at);
  r.posted[id] = { id, content, author: { id: BOT }, components: o.components ?? [],
    ...(o.replyTo ? { message_reference: { type: 0, message_id: o.replyTo, channel_id: DM } } : {}) };
  return id;
}
const done = async (r: ReturnType<typeof rig>) => { await r.link.whenReplayed(); return r.replays.at(-1); };

// A DM like his: an ask he answered, a specialist card naming a button it lacks, Cain's
// replies (one naming a button the card it answers lacks), his own messages, a permission
// prompt, something else on the bot's token, and a morning message whose Stop came off.
async function dm(r: ReturnType<typeof rig>) {
  const ask = (await r.link.ask({ text: "P08 Q2: Filed — or not?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
  await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
  const digest = await r.link.addCard({ text: "Three blocks added, each on its own card with Undo.", rows: STOP_ONLY, kind: "digest" });
  const digestMsg = await r.link.show(digest, { item: "none" });
  const card = await r.link.addCard({ text: "Added Swim to your Gmail.", rows: RECEIPT_ROWS, kind: "card" });
  const receipt = await r.link.show(card, { item: "none" });
  const his = r.his("what's the tracking number?");
  const reply1 = botMessage(r, "If that's wrong, tap Undo.", { replyTo: receipt });
  const reply2 = botMessage(r, "It's 123456789012345678.", { replyTo: his.id });
  const reply3 = botMessage(r, "Tap Approve on it.", { replyTo: "1100000000000000001" });   // answers a message out of reach
  for (const id of [reply1, reply2, reply3]) r.sent.ids.add(id);
  botMessage(r, "Allow Bash?", { components: [{ type: 1, components: [btn("Allow", "perm:allow:1")] }] });
  const stranger = botMessage(r, "Cain can't answer — sign in again.");
  const morning = await r.link.morning("## Thu Nov 12");
  return { ask, digestMsg, receipt, his, reply1, reply2, reply3, stranger, morning };
}

describe("the replay", () => {
  test("reads his DM back to the start of the range, posting and changing nothing", async () => {
    const r = rig();
    botMessage(r, "Old words — from before the range.", { at: r.t.now - 20 * DAY });
    r.later(HOUR);
    await dm(r);
    r.later(DAY);
    await r.link.morning("## Fri Nov 13");                             // the first one's Stop comes off
    const before = r.calls.length;
    expect(r.link.replay(14)).toMatchObject({ status: "started" });
    expect(r.link.replay(14)).toMatchObject({ status: "running" });
    const rep = await done(r);
    const after = r.calls.slice(before);
    expect(after.every((c) => c.method === "GET")).toBe(true);           // no POST, no PATCH
    expect(rep.range).toMatchObject({ days: 14, reached_cutoff: true, stopped: null, page_cap: 60, pages: 1 });
    expect(rep.list.some((h: any) => h.around.includes("Old words"))).toBe(false);
    expect(r.state().replayed).toBe(r.t.now);
  });

  test("says whose words each message carries, from the link's records and Cain's transcripts", async () => {
    const r = rig();
    const m = await dm(r);
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.messages.by_writer).toEqual({ cain: 5, specialist: 2, link: 0, unknown: 1 });   // 3 replies, the ask and the morning
    expect(rep.messages.skipped).toEqual({ his: 1, permission_prompts: 1, others: 0 });
    const hits = (id: string) => rep.list.filter((h: any) => h.message === id);
    expect(hits(m.reply1)).toMatchObject([{ writer: "cain", rule: "button", result: "refuse", label: "Undo" }]);
    expect(hits(m.reply2)).toEqual([]);                                  // a long number in a reply to him
    expect(hits(m.reply3)).toMatchObject([{ rule: "button", result: "unsure", label: "Approve" }]);
    expect(hits(m.digestMsg)).toMatchObject([{ writer: "specialist", rule: "button", result: "refuse", label: "Undo" }]);
    expect(hits(m.ask)).toEqual([]);                                    // its dash was fixed before it was posted
    expect(hits(m.stranger)).toMatchObject([{ writer: "unknown", rule: "dash" }]);
    expect(rep.hits.by_rule.button).toEqual({ fix: 0, refuse: 2, unsure: 1 });
    expect(rep.hits.by_writer.cain.button).toEqual({ fix: 0, refuse: 1, unsure: 1 });
    expect(rep.hits.total).toBe(rep.list.length);
  });

  test("takes the link's outcome lines off before reading a card's words", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[1]);
    r.posted[ask].content += " Wrong time";                              // as if his tap's line named a label
    r.link.replay(14);
    const rep = await done(r);
    expect(r.msg(ask).content).toContain("You answered: Not filed");
    expect(rep.list.filter((h: any) => h.message === ask)).toEqual([]);
  });

  test("finds a reply's card from the link's state, from Discord, or says it can't tell", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Moved Swim to 4:30.", rows: [{ type: 1, components: [btn("Undo", "k:c:u")] }], kind: "card" });
    const shown = await r.link.show(card, { item: "none" });
    const known = botMessage(r, "Tap Undo if it's wrong.", { replyTo: shown });                 // from state: has Undo
    const other = botMessage(r, "Tap Keep old.", { components: [{ type: 1, components: [btn("Keep old", "k:x")] }] });
    const viaDiscord = botMessage(r, "Tap Keep old if so.", { replyTo: other });                // from Discord: has Keep old
    const lost = botMessage(r, "Tap Undo.", { replyTo: "1100000000000000002" });               // can't tell
    for (const id of [known, viaDiscord, lost]) r.sent.ids.add(id);
    r.link.replay(14);
    const rep = await done(r);
    const of = (id: string) => rep.list.filter((h: any) => h.message === id).map((h: any) => h.result);
    expect(of(known)).toEqual([]);
    expect(of(viaDiscord)).toEqual([]);
    expect(of(lost)).toEqual(["unsure"]);
    // A reply after the card's buttons came off names a button that's gone.
    await r.link.editButtons(card, []);
    r.later(MIN);
    const late = botMessage(r, "Tap Undo now.", { replyTo: shown });
    r.sent.texts.add("Tap Undo now.");                                    // found by its words this time
    r.link.replay(14);
    expect((await done(r)).list.filter((h: any) => h.message === late).map((h: any) => h.result)).toEqual(["refuse"]);
  });

  test("the specialist's cards that never went out are read as the link got them", async () => {
    const r = rig();
    await r.link.addCard({ text: "Swim moved, with Undo.", rows: STOP_ONLY, kind: "card" });   // waiting for Cain
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.messages.cards_never_posted).toBe(1);
    expect(rep.list).toMatchObject([{ writer: "specialist", rule: "button", label: "Undo" }]);
    expect(rep.list[0].message).toMatch(/^card \d+$/);
  });

  test("reads at most its page cap: done all the same, and says the oldest part wasn't read", async () => {
    const r = rig();
    for (let i = 0; i < 6100; i++) botMessage(r, "x", { at: r.t.now - 6100 + i });
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.range).toMatchObject({ pages: 60, page_cap: 60, reached_cutoff: false, capped: true, stopped: null });
    expect(rep.messages.read).toBe(6000);
    // A rerun would stop at the same place, so it's done: "replayed" is set (the link's start
    // doesn't run it again), and Cain files it rather than running it again in an hour.
    expect(r.state().replayed).toBe(r.t.now);
    const line = r.relayed.at(-1)!;
    expect(line).toStartWith("The gate's replay over the last 14 days of his DM is done:");
    expect(line).toContain("It read its most, 60 pages of 100 messages, so the oldest part of the range wasn't read");
    expect(line).toContain("file it in the record as your CLAUDE.md says (Gate replay), saying the oldest part of the range wasn't read.");
    expect(line).not.toContain("again in an hour");
    expect(line).not.toContain("stopped before it was done");
  });

  test("an error partway is a stop, not the cap: not done, and Cain runs it again in an hour", async () => {
    const r = rig();
    for (let i = 0; i < 250; i++) botMessage(r, "x", { at: r.t.now - 250 + i });
    r.gate.history = true;                                              // its first page waits
    r.link.replay(14);
    for (let i = 0; i < 200 && !r.reads(); i++) await Bun.sleep(1);
    expect(r.reads()).toBe(1);
    r.failing.add(`/channels/${DM}/messages?`);                        // every page after the first fails
    r.release();
    const rep = await done(r);
    expect(rep.range).toMatchObject({ pages: 1, reached_cutoff: false, capped: false });
    expect(rep.range.stopped).toContain("Discord refused it");
    expect(rep.messages.read).toBe(100);
    expect(r.state().replayed).toBeUndefined();
    expect(r.relayed.at(-1)).toContain("stopped before it was done");
    expect(r.relayed.at(-1)).toContain("run /opt/cain/keeper.sh replay 14 again in an hour");
    expect(r.relayed.at(-1)).not.toContain("file it in the record as your CLAUDE.md says");
  });

  test("rate limits past its tries are a stop too", async () => {
    const r = rig();
    await dm(r);
    r.limitN[`/channels/${DM}/messages?`] = 5;                         // its fifth try is limited too
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.range).toMatchObject({ pages: 0, reached_cutoff: false, capped: false });
    expect(rep.range.stopped).toContain("discord 429");
    expect(r.state().replayed).toBeUndefined();
    expect(r.relayed.at(-1)).toContain("again in an hour");
  });

  test("waits out a rate limit and reads the same page again", async () => {
    const r = rig();
    await dm(r);
    r.limitN[`/channels/${DM}/messages?`] = 2;
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.range).toMatchObject({ stopped: null, reached_cutoff: true, pages: 1 });
    expect(rep.messages.read).toBeGreaterThan(5);
  });

  test("a read Discord keeps refusing ends it early, and says why", async () => {
    const r = rig();
    await dm(r);
    r.failing.add(`/channels/${DM}/messages?`);
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.range.stopped).toContain("Discord refused it");
    expect(rep.messages.read).toBe(0);
    expect(r.state().replayed).toBeUndefined();
    expect(r.relayed.at(-1)).toContain("again in an hour");
    r.failing.clear();
    r.link.replay(14);
    await done(r);
    expect(r.state().replayed).toBe(r.t.now);                         // done once it reads the whole range
  });

  test("a card from before 0.9.0 whose buttons came off: can't tell, never refused", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Moved Swim. If that's wrong, tap Undo.", rows: [{ type: 1, components: [btn("Undo", "k:c:u")] }], kind: "card", expires: r.t.now + 15 * MIN });
    const shown = await r.link.show(card, { item: "none" });
    r.later(HOUR);
    await r.link.sweep();                                               // expired: its buttons and rows go
    const old = r.state();
    delete old.messages[shown].labels;                                  // as a record from before 0.9.0
    delete old.labelled;
    r.setState(old);
    await r.link.sweep();                                               // the one backfill can't know them
    expect(r.state().messages[shown].labels).toBeUndefined();
    expect(r.state().labelled).toBe(true);
    const reply = botMessage(r, "Tap Undo on it.", { replyTo: shown });
    r.sent.ids.add(reply);
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.list.filter((h: any) => h.message === shown)).toMatchObject([{ rule: "button", result: "unsure", label: "Undo" }]);
    expect(rep.list.filter((h: any) => h.message === reply)).toMatchObject([{ rule: "button", result: "unsure" }]);
    expect(rep.hits.by_rule.button.refuse).toBe(0);
  });

  test("a notice records its buttons: a reply naming another is refused, not can't tell", async () => {
    const r = rig();
    await r.link.sweep();                                               // the one backfill is done before it goes out
    const notice = await r.link.notice("The calendar specialist hasn't answered for 5 minutes.");
    expect(r.state().messages[notice]).toMatchObject({ kind: "notice", buttons: true, labels: ["Stop"] });
    const reply = botMessage(r, "Tap Undo on it.", { replyTo: notice });
    r.sent.ids.add(reply);
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.list.filter((h: any) => h.message === reply)).toMatchObject([{ rule: "button", result: "refuse", label: "Undo" }]);
  });

  test("every message the link posts records the labels it posted, no buttons as none", async () => {
    const r = rig();
    await r.link.sweep();
    const ids = [
      await r.link.notice("The calendar specialist hasn't answered for 5 minutes."),
      (await r.link.connector({ item: "P07", text: "Installing Harness 0.22.0" })).message,
      (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message,
      (await r.link.ship({ text: "Harness 0.22.0 ready.", item: "P09", pr: PR, head: SHA1 }) as any).message,
      await r.link.show(await r.link.addCard({ text: "Moved Swim.", rows: [{ type: 1, components: [btn("Undo", "k:c:u")] }], kind: "card" }), { item: "none" }),
    ];
    const morning = await r.link.morning("## Thu Nov 12");
    const posted = [...ids, morning].map((id) => r.buttons(id));        // as they went out
    r.harnessDown.down = true;
    await r.tap(structuredClone(r.msg(morning)), STOP);                 // the link posts its own Stop notice
    await r.link.whenStopPlaced();                                      // and the moving Stop comes off the notice
    const toggle = r.last().id;
    for (const [i, id] of [...ids, morning, toggle].entries()) {
      expect(r.state().messages[id].labels).toBeDefined();
      expect(r.state().messages[id].labels).toEqual(i < posted.length ? (id === morning ? ["Turn back on"] : posted[i]) : r.buttons(id));
    }
    expect(posted[0]).toEqual(["Stop"]);                                // the notice went out with the moving Stop
    expect(r.buttons(ids[0])).toEqual([]);                              // which came off with his Stop; its label stays
    expect(r.buttons(toggle)).toEqual(["Turn back on"]);
  });

  test("the one backfill keeps what it knows: an ask's options, a live morning message's button", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "P08 Q2: Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const morning = await r.link.morning("## Thu Nov 12");
    const s = r.state();
    for (const id of [ask, morning]) delete s.messages[id].labels;
    r.setState(s);
    await r.link.sweep();
    expect(r.state().messages[ask].labels).toEqual(["Filed", "Not filed"]);
    expect(r.state().messages[morning].labels).toEqual(["Stop"]);
    const again = r.state();
    delete again.messages[ask].labels;
    r.setState(again);
    await r.link.sweep();                                               // once: it doesn't run again
    expect(r.state().messages[ask].labels).toBeUndefined();
  });

  test("a record from before 0.7.0 is read as unknown words, under Cain's rules", async () => {
    const r = rig();
    const id = botMessage(r, "Two blocks and 3 more — sorted.");
    const s = r.state();
    s.messages[id] = { digest: "", until: r.t.now + 30 * DAY, kind: "legacy", item: "none", posted: r.t.now, buttons: false };
    r.setState(s);
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.messages.by_writer).toMatchObject({ link: 0, unknown: 1 });
    expect(rep.list.filter((h: any) => h.message === id).map((h: any) => `${h.writer} ${h.rule}`)).toEqual(["unknown count", "unknown dash"]);
  });

  test("says whether Discord marks an edit of buttons alone as (edited)", async () => {
    for (const marks of [true, false]) {
      const r = rig();
      r.discord.marksButtonEdits = marks;
      await r.link.morning("## Wed Nov 11");
      r.later(DAY);
      await r.link.morning("## Thu Nov 12");                           // the first one's Stop comes off: buttons alone
      r.link.replay(14);
      const rep = await done(r);
      expect(rep.edited).toMatchObject({ morning_messages: 2, buttons_changed: 1, marked_edited: marks ? 1 : 0, buttons_only_edits_marked: marks });
    }
    const r = rig();
    await r.link.morning("## Thu Nov 12");
    r.link.replay(14);
    expect((await done(r)).edited).toMatchObject({ buttons_changed: 0, buttons_only_edits_marked: null });
  });

  test("Cain hears one line when it's done; each hit keeps at most 60 characters", async () => {
    const r = rig();
    await dm(r);
    const relayed = r.relayed.length;
    r.link.replay("x");                                                   // not a number: the default 14 days
    const rep = await done(r);
    expect(rep.range.days).toBe(14);
    expect(r.relayed.slice(relayed)).toHaveLength(1);
    const line = r.relayed.at(-1)!;
    expect(line).toStartWith("The gate's replay over the last 14 days of his DM is done:");
    expect(line).toContain("/data/work/gate-replay.json");
    expect(line).toEndWith("Nothing to tell him.");
    for (const h of rep.list) expect(h.around.length).toBeLessThanOrEqual(60);
    expect(Object.keys(rep)).toEqual(["written_at", "rules_version", "range", "messages", "hits", "list", "edited"]);
    expect(rep.rules_version).toBe(2);
  });

  test("keyed and on this machine only", () => {
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    const local = /const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/.exec(main)![1];
    for (const route of ["/replay", "/look", "/cards", "/check", "/connector", "/sent"]) expect(local).toContain(`"${route}"`);
    expect(main.indexOf('if (!keyOk) return json({ status: "refused" }, 403);')).toBeLessThan(main.indexOf('case "/replay"'));
    expect(main).toContain('if (token() && link.replayDue()) link.replay(30, "rules")');   // once by itself after the rules change
  });
});

describe("the replay after the rules were tuned (0.10.0)", () => {
  test("the link's own line on a specialist's Stop notice is judged as the link's words", async () => {
    const r = rig();
    r.stop.stopped = true; r.stop.at = r.t.now;
    // As 0.9.0 recorded it: a specialist's Stopped notice, with the link's line, its buttons gone.
    const card = await r.link.addCard({ text: "Stopped. Nothing runs.\n\nCain's Build and Ship jobs, Ship cards and outside reviews are stopped too, and nothing lands in main, until you tap Turn back on. A job already running finishes.",
      rows: [], kind: "card" });
    const id = await r.link.show(card, { item: "none" });
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.list.filter((h: any) => h.message === id)).toEqual([]);   // no "can't tell" for the link's line
  });

  test("a reply of Cain's that held the moving Stop is read as his, against the card it answered", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Moved Swim to 4:30.", rows: [{ type: 1, components: [btn("Undo", "k:c:u")] }], kind: "card" });
    const shown = await r.link.show(card, { item: "none" });
    const reply = botMessage(r, "Tap Not mine if it's wrong.", { replyTo: shown });
    await r.link.sent({ tool: "reply", ids: [reply], question: false });   // not in his transcripts: the link's own list says it's his
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.list.filter((h: any) => h.message === reply)).toMatchObject([{ writer: "cain", rule: "button", result: "refuse", label: "Not mine" }]);
  });

  test("runs by itself once after the rules change, and then has Cain check the gate end to end", async () => {
    const r = rig();
    expect(r.link.replayDue()).toBe(true);                               // none on record
    const s = r.state();
    s.replayed = r.t.now - 2 * DAY;                                      // one from 0.9.0
    r.setState(s);
    expect(r.link.replayDue()).toBe(true);
    const notice = await r.link.notice("The calendar specialist is answering again.");
    r.link.replay(30, "rules");
    await done(r);
    expect(r.link.replayDue()).toBe(false);
    expect(r.state().replayedRules).toBe(2);
    const line = r.relayed.at(-1)!;
    expect(line).toContain("The message gate's rules changed (version 2)");
    expect(line).toContain("/opt/cain/keeper.sh selftest");
    expect(line).toContain("/opt/cain/keeper.sh check --reply-to");
    expect(line).toContain(`/opt/cain/keeper.sh card on Discord message ${notice}, which carries Stop now`);
    expect(line).toEndWith("Nothing to tell him.");
    r.link.replay(14);                                                   // Cain's own run, rules unchanged: no checks asked
    await done(r);
    expect(r.relayed.at(-1)).not.toContain("end to end");
  });

  test("if the link's own run is cut short, the first replay that finishes asks for the checks", async () => {
    const r = rig();
    await r.link.morning("## Thu Nov 12");
    r.failing.add(`/channels/${DM}/messages?`);
    r.link.replay(30, "rules");
    await done(r);
    expect(r.relayed.at(-1)).toContain("stopped before it was done");
    expect(r.link.replayDue()).toBe(true);
    r.failing.clear();
    r.link.replay(30);                                                   // Cain's run, an hour on
    await done(r);
    expect(r.relayed.at(-1)).toContain("check it end to end");
    expect(r.link.replayDue()).toBe(false);
  });
});

describe("Cain's transcripts", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const use = (id: string, name: string, input: unknown) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: unknown) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const REPLY = "mcp__plugin_discord_discord__reply", EDIT = "mcp__plugin_discord_discord__edit_message";
  const NL = String.fromCharCode(10);

  test("give the ids from the plugin's own answers and the words of what he sent, from files changed in the range", async () => {
    const root = mkdtempSync(join(tmpdir(), "transcripts-"));
    mkdirSync(join(root, "-data-work"));
    const lines = [
      use("t1", REPLY, { chat_id: DM, text: "Moved it to 4:30.", reply_to: "1300000000000000001" }),
      result("t1", [{ type: "text", text: "sent (id: 1300000000000000777)" }]),
      use("t2", EDIT, { chat_id: DM, message_id: "1300000000000000778", text: "Moved it to 5:00." }),
      result("t2", "edited (id: 1300000000000000778)"),
      use("t4", REPLY, { chat_id: DM, text: "A long one." }),
      result("t4", "sent 2 parts (ids: 1300000000000000779, 1300000000000000780)"),
      use("t5", REPLY, { chat_id: DM, text: "Another." }),
      result("t5", "sent (id: 1300000000000000781) after 1300000000000000997 was read"),   // only the answer's own id
      use("t6", EDIT, { chat_id: DM, message_id: "1300000000000000996", text: "Never edited." }),
      result("t6", "error: that message isn't yours to edit"),          // an edit that failed names nothing
      use("t3", "Bash", { command: "echo 1300000000000000999" }),
      result("t3", "sent (id: 1300000000000000998)"),                    // not the plugin's answer
      "not json",
    ];
    writeFileSync(join(root, "-data-work", "a.jsonl"), lines.join(NL));
    writeFileSync(join(root, "-data-work", "old.jsonl"), lines[0].replace("Moved it to 4:30.", "Old words."));
    utimesSync(join(root, "-data-work", "old.jsonl"), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    const sent = await readTranscripts(root, Date.now() - 14 * DAY);
    expect([...sent.ids].sort()).toEqual(["1300000000000000777", "1300000000000000778", "1300000000000000779",
      "1300000000000000780", "1300000000000000781"]);
    expect([...sent.texts].sort()).toEqual(["A long one.", "Another.", "Moved it to 4:30.", "Moved it to 5:00.", "Never edited."]);
    expect(await readTranscripts(join(root, "none"), 0)).toEqual({ ids: new Set(), texts: new Set() });
  });

  test("a long session is read in turns, so a timer fires during the read, and a huge line is skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "transcripts-big-"));
    mkdirSync(join(root, "-data-work"));
    const filler = line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2000) }] } });
    const parts: string[] = [];
    for (let i = 0; i < 6000; i++) parts.push(filler);                   // about 12 MB of other work
    parts.push(use("t1", REPLY, { chat_id: DM, text: "Found in a long session." }), result("t1", "sent (id: 1300000000000000801)"));
    parts.push(`{"type":"assistant","message":{"content":[{"type":"text","text":"plugin_discord_discord__ ${"y".repeat(5 * 1024 * 1024)}"}]}}`);
    parts.push(use("t2", REPLY, { chat_id: DM, text: "After the huge line." }), result("t2", "sent (id: 1300000000000000802)"));
    writeFileSync(join(root, "-data-work", "long.jsonl"), parts.join(NL));
    let firedAt = 0;
    setTimeout(() => { firedAt = performance.now(); }, 0);
    const sent = await readTranscripts(root, 0);
    const doneAt = performance.now();
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThan(doneAt);                                 // the loop had turns while it read
    expect([...sent.ids].sort()).toEqual(["1300000000000000801", "1300000000000000802"]);
    expect([...sent.texts].sort()).toEqual(["After the huge line.", "Found in a long session."]);
  }, 60_000);
});
