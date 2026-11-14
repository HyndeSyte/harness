// What went out, told to the link (piece D, Cain 0.10.0): a PostToolUse hook on the
// plugin's reply and edit_message tools, wired with "async", so nothing waits on it.
//   - Stop within reach: the link learns the ids of the message Cain just sent (each part)
//     and whether its last line asks something, and puts the moving Stop on the newest
//     plain message (POST /sent). The same ids make up his edit allowlist: he edits only
//     his own replies. An edit that turns the Stop's message into a question moves it.
//   - The safety net: what went out is read again with the rules that need nothing from the
//     link. A hit means the reply hook was bypassed, or let a third try through: it's logged
//     here, and the link tells Cain, with what to fix by an edit. Never through this hook's
//     own output, which Claude Code would show him as the hook's.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendGate } from "../gate/log";
import { answerText, asksSomething, SENDS, sentIds } from "../gate/plugin";
import { check } from "../gate/rules";
import { keyOf, readTries, type Tries, wasReleased } from "./discord-send";

const LINK = process.env.CAIN_LINK ?? "http://127.0.0.1:8097";
const ENV = process.env.CAIN_DISCORD_ENV ?? "/data/.claude/channels/discord/.env";
const SNOWFLAKE = /^\d{15,22}$/;
const id = (v: unknown) => (typeof v === "string" || typeof v === "number") && SNOWFLAKE.test(String(v)) ? String(v) : undefined;
const FIXED_MAX = 600;                  // a fixed text longer than this isn't repeated to Cain

export interface NetHit { rule: string; result: string; around: string }
export interface SentNote {
  tool: "reply" | "edit"; ids: string[]; question: boolean; chat?: string; reply_to?: string;
  net?: { hits: NetHit[]; released: boolean; fixed?: string };
}

// What to tell the link about one call that went out, or null when nothing went out (the
// plugin's answer names no message: it failed, or it's another tool).
export function noteOf(input: any, now: number, tries: Tries = readTries()): SentNote | null {
  const tool = (SENDS as Record<string, "reply" | "edit">)[String(input?.tool_name ?? "")];
  const t = input?.tool_input;
  if (!tool || !t || typeof t !== "object") return null;
  const ids = sentIds(answerText(input?.tool_response)).filter((x) => SNOWFLAKE.test(x)).slice(0, 10);
  if (!ids.length) return null;
  const text = String(t.text ?? "");
  const chat = id(t.chat_id), replyTo = tool === "reply" ? id(t.reply_to) : undefined;
  // A long number or code in a reply may be what he asked for: only the cards can tell, so
  // the net gives it the benefit of the doubt.
  const r = check(text, { rules: ["dash", "app", "count", "machine"], answersHim: !!replyTo });
  const note: SentNote = { tool, ids, question: asksSomething(text), ...(chat ? { chat } : {}), ...(replyTo ? { reply_to: replyTo } : {}) };
  // A third try the reply hook let through is always told, hits here or not (a button the
  // card lacks is one only the cards can show).
  const released = wasReleased(tries, keyOf(String(input?.session_id ?? ""), chat), text, now);
  if (r.hits.length || released) {
    const fixed = r.hits.some((h) => h.result === "fix") && r.fixed.length <= FIXED_MAX ? r.fixed : undefined;
    note.net = { hits: r.hits.map((h) => ({ rule: h.rule, result: h.result, around: h.around })), released, ...(fixed ? { fixed } : {}) };
  }
  return note;
}

function linkKey(): string {
  const m = readFileSync(ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m);
  return m ? createHmac("sha256", m[1].trim()).update("harness-relay-v1").digest("hex") : "";
}

if (import.meta.main) {
  try {
    const now = Date.now();
    const note = noteOf(JSON.parse(await Bun.stdin.text()), now);
    if (note) {
      // A let-through third try is already logged by the reply hook; a bypass is logged here.
      if (note.net && !note.net.released) await appendGate({ at: now, point: "sent", writer: "cain", message: note.ids.at(-1),
        did: "bypassed", hits: note.net.hits });
      await fetch(`${LINK}/sent`, { method: "POST", body: JSON.stringify(note), signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-harness-key": linkKey() } });
    }
  } catch { /* nothing waits on this hook, and nothing it says reaches him */ }
  process.exit(0);
}
