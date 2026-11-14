// What went out, told to the link (piece D, Cain 0.10.0): a PostToolUse hook on the
// plugin's reply and edit_message tools, wired with "async", so nothing waits on it.
//   - Stop within reach: the link learns the ids of the message Cain just sent (each part)
//     and whether its last paragraph asks something, and puts the moving Stop on the newest
//     plain message (POST /sent). A reply's ids make up his edit allowlist: he edits only
//     his own replies. An edit that turns the Stop's message into a question moves it.
//   - The safety net: what went out is read again with the rules that need nothing from the
//     link. A hit means the reply hook was bypassed, or let a third try through: it's logged
//     here, and the link tells Cain the rule and a short excerpt, and to fix it by an edit.
//     Never through this hook's own output, which Claude Code would show him as the hook's.
// A note the link doesn't take (no answer, or a 5xx or 429) is sent again, up to 3 times,
// inside the hook's 15 seconds, the same note each time: it names its tool call
// (tool_use_id, or a hash of the text), so the link tells Cain once per send, never once
// per message. Nothing is kept beyond that: Cain's next reply places Stop again.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendGate } from "../gate/log";
import { answerText, asksSomething, SENDS, sentIds } from "../gate/plugin";
import { check } from "../gate/rules";
import { keyOf, readTries, textHash, type Tries, wasReleased } from "./discord-send";

const LINK = process.env.CAIN_LINK ?? "http://127.0.0.1:8097";
const ENV = process.env.CAIN_DISCORD_ENV ?? "/data/.claude/channels/discord/.env";
const SNOWFLAKE = /^\d{15,22}$/;
const id = (v: unknown) => (typeof v === "string" || typeof v === "number") && SNOWFLAKE.test(String(v)) ? String(v) : undefined;
export const POST_MS = 2_000;                        // each try at /sent gets this long
export const AGAIN_MS = [500, 1_000, 2_000];         // the waits before each of the 3 tries again: 11.5 s at most

export interface NetHit { rule: string; result: string; around: string }
export interface SentNote {
  tool: "reply" | "edit"; ids: string[]; question: boolean;
  call: string;                     // the tool call's own id (tool_use_id), else a hash of its text: one send, however often its note goes
  chat?: string; reply_to?: string;
  net?: { hits: NetHit[]; released: boolean };
}
const CALL = /^[A-Za-z0-9_-]{1,100}$/;

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
  // the net gives it the benefit of the doubt. His words are a writer's the gate refuses:
  // any em dash in them is one it should have held.
  const r = check(text, { rules: ["dash", "app", "count", "machine"], answersHim: !!replyTo, refusable: true });
  // Which send this is: a retried note keeps it, and a second edit of the same message has its own.
  const call = typeof input?.tool_use_id === "string" && CALL.test(input.tool_use_id) ? input.tool_use_id : textHash(text);
  const note: SentNote = { tool, ids, question: asksSomething(text), call, ...(chat ? { chat } : {}), ...(replyTo ? { reply_to: replyTo } : {}) };
  // A third try the reply hook let through is always told, hits here or not (a button the
  // card lacks is one only the cards can show).
  const released = wasReleased(tries, keyOf(String(input?.session_id ?? ""), chat), text, now);
  if (r.hits.length || released) note.net = { hits: r.hits.map((h) => ({ rule: h.rule, result: h.result, around: h.around })), released };
  return note;
}

// POST /sent until the link takes it: true once it does. A refusal (another 4xx) is final:
// the same note would be refused again.
export async function tellLink(note: SentNote, post: (body: string, timeoutMs: number) => Promise<Response>,
                               wait: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms)): Promise<boolean> {
  const body = JSON.stringify(note);
  for (let i = 0; i <= AGAIN_MS.length; i++) {
    if (i) await wait(AGAIN_MS[i - 1]);
    try {
      const r = await post(body, POST_MS);
      if (r.ok) return true;
      if (r.status < 500 && r.status !== 429) return false;
    } catch { /* no answer in time: try again */ }
  }
  return false;
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
      const key = linkKey();
      await tellLink(note, (body, timeoutMs) => fetch(`${LINK}/sent`, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "x-harness-key": key } }));
    }
  } catch { /* nothing waits on this hook, and nothing it says reaches him */ }
  process.exit(0);
}
