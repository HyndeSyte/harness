// The message gate on Cain's own Discord replies and edits (hooks/discord-send.ts and
// gate/send.ts), in report mode: it logs what the rules would have done and never
// refuses, changes or holds up a call.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGate } from "../rootfs/opt/cain/gate/log";
import { decideSend, type CardsView } from "../rootfs/opt/cain/gate/send";
import { callOf, cardsNow, entry, STALE_MS } from "../rootfs/opt/cain/hooks/discord-send";

const HOOK = join(import.meta.dir, "../rootfs/opt/cain/hooks/discord-send.ts");
const REPLY = "mcp__plugin_discord_discord__reply", EDIT = "mcp__plugin_discord_discord__edit_message";
const NOW = Date.UTC(2026, 10, 12, 15, 0);
// A receipt whose buttons are Not mine, Wrong time, Just this once and Stop; an approval
// with Undo up; Cain's own ask, answered; a link notice.
const RECEIPT = "1300000000000000001", UNDO_CARD = "1300000000000000002", ASK = "1300000000000000003", NOTICE = "1300000000000000004";
const CARDS: CardsView = { written_at: NOW, owner: "4242", dm: "5151", cards: [
  { message: RECEIPT, kind: "card", writer: "specialist", labels: ["Not mine", "Wrong time", "Just this once", "Stop"], live: true, item: "none", question: null, posted: NOW - 3_600_000 },
  { message: UNDO_CARD, kind: "card", writer: "specialist", labels: ["Undo", "Stop"], live: true, item: "none", question: null, posted: NOW - 600_000 },
  { message: ASK, kind: "ask", writer: "cain", labels: ["Filed", "Not filed"], live: false, item: "P08", question: "Q2", posted: NOW - 7_200_000 },
  { message: NOTICE, kind: "notice", writer: "link", labels: [], live: false, item: "none", question: "notice", posted: NOW - 60_000 },
] };
const reply = (text: string, reply_to?: string) => ({ tool_name: REPLY, hook_event_name: "PreToolUse", tool_input: { chat_id: "5151", text, ...(reply_to ? { reply_to } : {}) } });
const edit = (text: string, message_id: string) => ({ tool_name: EDIT, hook_event_name: "PreToolUse", tool_input: { chat_id: "5151", message_id, text } });

describe("what the gate would do with Cain's reply", () => {
  test("Nov 10, synthetic: tap Undo in a reply to a receipt without Undo, with the live cards that have it", () => {
    const d = decideSend(callOf(reply("If that's wrong, tap Undo.", RECEIPT))!, CARDS);
    expect(d.would).toBe("refuse");
    expect(d.hits).toMatchObject([{ rule: "button", result: "refuse", label: "Undo" }]);
    expect(d.said).toContain(`live cards with it: message ${UNDO_CARD}`);
  });

  test("a button on the live card it answers passes; on a card whose buttons came off it doesn't", () => {
    expect(decideSend(callOf(reply("Tap Wrong time if it's off.", RECEIPT))!, CARDS).would).toBe("pass");
    expect(decideSend(callOf(reply("Tap Filed when it's in.", ASK))!, CARDS).would).toBe("refuse");
    expect(decideSend(callOf(reply("Tap Undo below the card."))!, CARDS).would).toBe("refuse");   // answers no card
  });

  test("a long number in a reply to his own message passes; elsewhere it's machine text", () => {
    const his = "1300000000000000099";                                   // not a message the link posted
    expect(decideSend(callOf(reply("The tracking number is 123456789012345678.", his))!, CARDS).would).toBe("pass");
    expect(decideSend(callOf(reply("The tracking number is 123456789012345678."))!, CARDS).would).toBe("refuse");
  });

  test("a fix says exactly what to send instead", () => {
    const d = decideSend(callOf(reply("Moved swim — it's at 4:30 now."))!, CARDS);
    expect(d.would).toBe("fix");
    expect(d.fixed).toBe("Moved swim, it's at 4:30 now.");
    expect(d.said).toBe("Send exactly this instead: Moved swim, it's at 4:30 now.");
  });

  test("with no cards to check against, a named button can't be told; the text rules still run", () => {
    const d = decideSend(callOf(reply("Tap Approve on it.", RECEIPT))!, null);
    expect(d.would).toBe("unsure");
    expect(decideSend(callOf(reply("Two blocks and 3 more.", RECEIPT))!, null).would).toBe("refuse");
  });

  test("an edit names no button and never touches a message the link posted", () => {
    expect(decideSend(callOf(edit("Fixed the time.", NOTICE))!, CARDS).hits).toMatchObject([{ rule: "target", result: "refuse" }]);
    expect(decideSend(callOf(edit("Tap Undo now.", "1300000000000000099"))!, CARDS).would).toBe("refuse");
    expect(decideSend(callOf(edit("Fixed the time.", "1300000000000000099"))!, CARDS).would).toBe("pass");
    expect(decideSend(callOf(edit("Fixed the time.", "1300000000000000099"))!, null).hits).toMatchObject([{ rule: "target", result: "unsure" }]);
  });

  test("only the two sends are read", () => {
    expect(callOf({ tool_name: "mcp__plugin_discord_discord__react", tool_input: { text: "x" } })).toBeNull();
    expect(callOf({ tool_name: REPLY })).toBeNull();
    expect(callOf(reply("hi", "not-an-id"))).toEqual({ tool: "reply", text: "hi", replyTo: undefined });
  });
});

describe("where the hook gets the cards", () => {
  test("the link first; its file only while fresh; else none", async () => {
    const file = JSON.stringify({ ...CARDS, written_at: NOW - 60_000 });
    expect((await cardsNow(async () => CARDS, () => file, NOW)).from).toBe("link");
    expect((await cardsNow(async () => { throw new Error("ECONNREFUSED"); }, () => file, NOW)).from).toBe("file");
    const stale = JSON.stringify({ ...CARDS, written_at: NOW - STALE_MS - 1 });
    expect(await cardsNow(async () => null, () => stale, NOW)).toEqual({ cards: null, from: "none" });
    expect(await cardsNow(async () => null, () => null, NOW)).toEqual({ cards: null, from: "none" });
    expect(await cardsNow(async () => null, () => "{half", NOW)).toEqual({ cards: null, from: "none" });
  });

  test("a log line only when a rule fired, with at most 60 characters around each hit", () => {
    expect(entry(callOf(reply("Moved swim to 4:30."))!, CARDS, "link", NOW)).toBeNull();
    const line = entry(callOf(reply(`${"Moved the swim lesson to later today. ".repeat(4)}Tap Undo if wrong.`, RECEIPT))!, CARDS, "link", NOW)!;
    expect(line).toMatchObject({ at: NOW, point: "reply", writer: "cain", cards: "link", would: "refuse", reply_to: RECEIPT });
    for (const h of line.hits as any[]) expect(h.around.length).toBeLessThanOrEqual(60);
    expect(JSON.stringify(line)).not.toContain("Moved the swim lesson to later today. Moved");   // never the whole message
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
});

describe("run as Claude Code runs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cain-send-"));
  const TOKEN = "not-a-real-token.for-the-gate-test";
  writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
  const KEY = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
  const run = async (input: string, env: Record<string, string>) => {
    const p = Bun.spawn(["bun", HOOK], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CAIN_DISCORD_ENV: join(dir, ".env"), ...env } });
    const out = await new Response(p.stdout).text();
    return { out, code: await p.exited };
  };
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  test("it asks the link with the key, logs what it would do, prints nothing and lets the reply go", async () => {
    const asked: string[] = [];
    const server = Bun.serve({ port: 0, fetch(req) {
      asked.push(`${new URL(req.url).pathname} ${req.headers.get("x-harness-key") === KEY}`);
      return Response.json({ ...CARDS, written_at: Date.now() });
    } });
    try {
      const log = join(dir, "a.jsonl");
      const env = { CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_GATE_LOG: log, CAIN_CARDS: join(dir, "none.json") };
      expect(await run(JSON.stringify(reply("If that's wrong, tap Undo.", RECEIPT)), env)).toEqual({ out: "", code: 0 });
      expect(asked).toEqual(["/cards true"]);
      expect(lines(log)).toMatchObject([{ point: "reply", cards: "link", would: "refuse", hits: [{ rule: "button", label: "Undo" }] }]);
      expect(await run(JSON.stringify(reply("Moved swim to 4:30.", RECEIPT)), env)).toEqual({ out: "", code: 0 });
      expect(lines(log)).toHaveLength(1);                                 // a clean reply logs nothing
    } finally { server.stop(true); }
  }, 30_000);

  test("with the link down it reads the cards file while it's fresh, and never holds anything up", async () => {
    const log = join(dir, "b.jsonl"), cards = join(dir, "cards.json");
    writeFileSync(cards, JSON.stringify({ ...CARDS, written_at: Date.now() }));
    const env = { CAIN_LINK: "http://127.0.0.1:9", CAIN_GATE_LOG: log, CAIN_CARDS: cards };
    expect(await run(JSON.stringify(reply("Tap Undo below.", RECEIPT)), env)).toEqual({ out: "", code: 0 });
    expect(lines(log)).toMatchObject([{ cards: "file", would: "refuse" }]);
    writeFileSync(cards, JSON.stringify({ ...CARDS, written_at: Date.now() - STALE_MS - 60_000 }));
    expect(await run(JSON.stringify(reply("Tap Undo below.", RECEIPT)), env)).toEqual({ out: "", code: 0 });
    expect(lines(log)[1]).toMatchObject({ cards: "none", would: "unsure" });
    for (const bad of ["not json", "", JSON.stringify({ tool_name: REPLY, tool_input: null })])
      expect(await run(bad, env)).toEqual({ out: "", code: 0 });
    writeFileSync(join(dir, "blocker"), "a file where the log's folder would be");
    expect(await run(JSON.stringify(reply("Tap Undo.")), { ...env, CAIN_GATE_LOG: join(dir, "blocker", "gate.jsonl") }))
      .toEqual({ out: "", code: 0 });                                     // even a log it can't write
  }, 30_000);

  test("wired on exactly the reply and edit tools, never blocking, short, and a crash lets the reply go", async () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/settings.json"), "utf8"));
    const sends = settings.hooks.PreToolUse.filter((e: any) => e.hooks.some((h: any) => String(h.command).includes("/discord-send.ts")));
    expect(sends.map((e: any) => e.matcher).sort()).toEqual([EDIT, REPLY]);
    for (const e of sends) {
      expect(e.hooks).toHaveLength(1);
      const h = e.hooks[0];
      expect(h.command).toBe("bun /opt/cain/hooks/discord-send.ts || true");
      expect(h.onFailure).toBeUndefined();                                // a timeout lets the call through
      // Report mode never adds a moment to a reply: Claude Code starts it and goes on.
      // D2 removes async when the gate starts enforcing.
      expect(h.async).toBe(true);
      expect(h.timeout).toBeLessThanOrEqual(5);
    }
    // The plugin's send tools stay off the allow list: the gate doesn't make them run unasked.
    for (const t of [REPLY, EDIT]) expect(settings.permissions.allow).not.toContain(t);
    const crash = Bun.spawn(["bash", "-c", sends[0].hooks[0].command.replace("/opt/cain/hooks/discord-send.ts", join(tmpdir(), "no-such-hook.ts"))],
      { stdout: "ignore", stderr: "ignore" });
    expect(await crash.exited).toBe(0);
  }, 30_000);
});
