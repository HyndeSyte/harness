// The gate's replay over his DM (piece D, core.ts replay): it reads only, says whose words
// each bot message carries from the link's records and Cain's transcripts (one bot token
// posts them all), runs the rules in report mode and writes what it found for Cain.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP } from "../rootfs/opt/cain/link/core";
import { readTranscripts } from "../rootfs/opt/cain/link/publish";
import { BOT, DAY, DM, HOUR, MIN, OWNER, rig } from "./link-rig";

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
    expect(hits(m.ask)).toMatchObject([{ writer: "cain", rule: "dash", result: "fix" }]);
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

  test("respects its page cap and says so", async () => {
    const r = rig();
    for (let i = 0; i < 6100; i++) botMessage(r, "x", { at: r.t.now - 6100 + i });
    r.link.replay(14);
    const rep = await done(r);
    expect(rep.range).toMatchObject({ pages: 60, reached_cutoff: false });
    expect(rep.range.stopped).toContain("60 pages");
    expect(rep.messages.read).toBe(6000);
    expect(r.relayed.at(-1)).toContain("stopped early");
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
    expect(Object.keys(rep)).toEqual(["written_at", "range", "messages", "hits", "list", "edited"]);
  });

  test("keyed and on this machine only", () => {
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    const local = /const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/.exec(main)![1];
    for (const route of ["/replay", "/look", "/cards", "/check", "/connector"]) expect(local).toContain(`"${route}"`);
    expect(main.indexOf('if (!keyOk) return json({ status: "refused" }, 403);')).toBeLessThan(main.indexOf('case "/replay"'));
    expect(main).toContain("if (token() && !load().replayed) link.replay(30)");   // once by itself after the install
  });
});

describe("Cain's transcripts", () => {
  test("give the ids and words of what he sent with the plugin, from files changed in the range", () => {
    const root = mkdtempSync(join(tmpdir(), "transcripts-"));
    mkdirSync(join(root, "-data-work"));
    const line = (o: unknown) => JSON.stringify(o);
    const lines = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__plugin_discord_discord__reply", input: { chat_id: DM, text: "Moved it to 4:30.", reply_to: "1300000000000000001" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "sent (id: 1300000000000000777)" }] }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__plugin_discord_discord__edit_message", input: { chat_id: DM, message_id: "1300000000000000778", text: "Moved it to 5:00." } }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "echo 1300000000000000999" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "1300000000000000998" }] } }),
      "not json",
    ];
    writeFileSync(join(root, "-data-work", "a.jsonl"), lines.join("\n"));
    writeFileSync(join(root, "-data-work", "old.jsonl"), lines[0].replace("Moved it to 4:30.", "Old words."));
    utimesSync(join(root, "-data-work", "old.jsonl"), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    const sent = readTranscripts(root, Date.now() - 14 * DAY);
    expect([...sent.ids].sort()).toEqual(["1300000000000000777", "1300000000000000778"]);
    expect([...sent.texts].sort()).toEqual(["Moved it to 4:30.", "Moved it to 5:00."]);
    expect(readTranscripts(join(root, "none"), 0)).toEqual({ ids: new Set(), texts: new Set() });
  });
});
