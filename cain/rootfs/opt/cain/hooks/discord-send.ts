// Cain's message gate on his own Discord replies and edits (piece D), in report mode: a
// PreToolUse hook on the plugin's reply and edit_message tools, wired in settings.json.
// It never refuses and never changes a call: it reads the cards up now from the link's
// local route (the authority; /data/trust/cards.json only when the link doesn't answer),
// runs the gate's rules (../gate/send.ts, the same decision keeper.sh check gives), and
// logs what they would have done to Cain's folder (../gate/log.ts: the rule, fix or
// refuse, and at most 60 characters around each hit). It prints nothing, exits 0 on any
// error, and gives up on the link within a couple of seconds.
//
// settings.json runs it with "async": true, so Claude Code starts it and sends the reply
// without waiting: in report mode it never adds a moment to a reply. D2 removes async when
// the gate starts enforcing, since a hook that refuses has to be waited for.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendGate } from "../gate/log";
import { type CardsView, decideSend, type SendCall } from "../gate/send";

export const SENDS = { "mcp__plugin_discord_discord__reply": "reply", "mcp__plugin_discord_discord__edit_message": "edit" } as const;
// Moved only for the tests: the hook runs in the environment Claude Code was started with.
const LINK = process.env.CAIN_LINK ?? "http://127.0.0.1:8097";
const CARDS = process.env.CAIN_CARDS ?? "/data/trust/cards.json";
const ENV = process.env.CAIN_DISCORD_ENV ?? "/data/.claude/channels/discord/.env";
export const STALE_MS = 3 * 60_000;      // a cards file older than this is the link being down
export const LINK_MS = 2_000;            // how long the link gets to answer

const SNOWFLAKE = /^\d{15,22}$/;
const id = (v: unknown) => (typeof v === "string" || typeof v === "number") && SNOWFLAKE.test(String(v)) ? String(v) : undefined;

// The call Claude Code is about to make, or null when it isn't one of the two sends.
export function callOf(input: any): SendCall | null {
  const tool = (SENDS as Record<string, "reply" | "edit">)[String(input?.tool_name ?? "")];
  const t = input?.tool_input;
  if (!tool || !t || typeof t !== "object") return null;
  const text = String(t.text ?? t.content ?? "");
  return tool === "reply" ? { tool, text, replyTo: id(t.reply_to) } : { tool, text, target: id(t.message_id) };
}

// The cards as of now: the link's answer, else its file if it's fresh, else none.
export async function cardsNow(ask: () => Promise<CardsView | null>, file: () => string | null, now: number):
    Promise<{ cards: CardsView | null; from: "link" | "file" | "none" }> {
  try { const c = await ask(); if (c && Array.isArray(c.cards)) return { cards: c, from: "link" }; } catch { /* the link didn't answer */ }
  try {
    const c = JSON.parse(file() ?? "");
    if (Array.isArray(c?.cards) && typeof c.written_at === "number" && now - c.written_at <= STALE_MS) return { cards: c, from: "file" };
  } catch { /* missing or unreadable */ }
  return { cards: null, from: "none" };
}

// One log line, or null when the rules found nothing.
export function entry(call: SendCall, cards: CardsView | null, from: string, now: number): Record<string, unknown> | null {
  const d = decideSend(call, cards);
  if (!d.hits.length) return null;
  return { at: now, point: call.tool, writer: "cain", cards: from, would: d.would, hits: d.hits,
    ...(call.replyTo ? { reply_to: call.replyTo } : {}), ...(call.target ? { message: call.target } : {}) };
}

function linkKey(): string {
  const m = readFileSync(ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m);
  return m ? createHmac("sha256", m[1].trim()).update("harness-relay-v1").digest("hex") : "";
}

async function askLink(): Promise<CardsView | null> {
  const r = await fetch(`${LINK}/cards`, { headers: { "x-harness-key": linkKey() }, signal: AbortSignal.timeout(LINK_MS) });
  return r.ok ? ((await r.json()) as CardsView) : null;
}

if (import.meta.main) {
  try {
    const call = callOf(JSON.parse(await Bun.stdin.text()));
    if (call) {
      const now = Date.now();
      const { cards, from } = await cardsNow(askLink, () => { try { return readFileSync(CARDS, "utf8"); } catch { return null; } }, now);
      const line = entry(call, cards, from, now);
      if (line) await appendGate(line);
    }
  } catch { /* report mode: nothing here may ever hold a reply up */ }
  process.exit(0);
}
