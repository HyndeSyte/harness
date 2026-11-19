// The message gate as the broker runs it (C1): the reply hook's own decision code
// (../hooks/discord-send.ts, ../gate/send.ts), called from root instead of from Claude Code,
// with the same rules, reasons, tries and log. What differs:
//   - The cards come from the link's root socket, never a key-bearing request over TCP.
//   - His own replies (what he may edit) are the ids the broker saw the plugin answer for
//     his replies, with the link's list; no transcript is read.
//   - It fails closed: an error refuses the send, and a try that can't be counted stays
//     refused. Only the wording rules ever let a third try through (act()); a hard refusal
//     (not his DM, not his reply, a Reviewed line the service didn't give, a record code)
//     never.
import { readFileSync } from "node:fs";
import { claimsReview, hasLink, mayHaveCode, recordItems } from "../gate/cain";
import { LINK_HELD, noteAt } from "../gate/held";
import { readHosts } from "../gate/hosts";
import { appendGate } from "../gate/log";
import { EDIT_TOOL, REPLY_TOOL } from "../gate/plugin";
import { type CardsView, decideSend } from "../gate/send";
import { act, callOf, cardsNow, entry, keepDm, readDm, readTries, writeTries } from "../hooks/discord-send";
import { madeUpReviews, noteOf, type SentNote } from "../hooks/discord-sent";
import { readReviewed } from "../reviewed";
import type { GateVerdict } from "./broker";

const PENDING = process.env.CAIN_PENDING ?? "/data/record/state/PENDING.md";

export interface GateDeps {
  cards: () => Promise<CardsView | null>;        // the link's answer, over its root socket
  cardsFile: () => string | null;                // /data/trust/cards.json, while fresh
  replied: () => ReadonlySet<string>;            // ids of his replies the broker saw go out
  now?: () => number;
  tz?: string;
  log?: (line: Record<string, unknown>) => Promise<void>;
  items?: () => ReadonlySet<string> | null;
  reviewed?: () => ReturnType<typeof readReviewed>;
  hosts?: () => ReadonlySet<string>;              // the gate's list of cited hosts (gate/hosts.ts)
  held?: string;                                 // where a held link reply's time is noted (gate/held.ts)
}

const readItems = (): ReadonlySet<string> | null => { try { return recordItems(readFileSync(PENDING, "utf8")); } catch { return null; } };

// One send's verdict. Never throws: a failure inside is a refusal.
export async function gateSend(tool: "reply" | "edit", args: Record<string, unknown>, session: string, deps: GateDeps): Promise<GateVerdict> {
  try {
    const now = deps.now?.() ?? Date.now();
    const input = { tool_name: tool === "reply" ? REPLY_TOOL : EDIT_TOOL, tool_input: args, session_id: session };
    const call = callOf(input);
    if (!call) return { kind: "refuse", reason: "the message gate couldn't read this send, so it wasn't sent." };
    const got = await cardsNow(deps.cards, deps.cardsFile, now);
    keepDm(got.cards?.dm);
    const d = decideSend(call, got.cards, {
      dm: got.cards ? null : readDm(), tz: deps.tz ?? process.env.CHECKIN_TZ ?? "America/New_York", now,
      ...(call.tool === "edit" ? { replied: deps.replied() } : {}),
      ...(claimsReview(call.text) ? { reviewed: (deps.reviewed ?? (() => readReviewed()))() } : {}),
      ...(mayHaveCode(call.text) ? { items: (deps.items ?? readItems)() } : {}),
      // Links, as the reply hook does (Cain 0.13.0): the plugin's replies hold any while the link
      // answers (keeper.sh reply posts them with the preview off), and go as they are, noted, while
      // it doesn't; an https link to a host off the gate's list is noted.
      plugin: true, linkDown: got.from !== "link", ...(hasLink(call.text) ? { hosts: (deps.hosts ?? readHosts)() } : {}),
    });
    const tries = readTries();
    const out = act(call, d, tries, now);
    // A reply held for the keeper: its time noted, for the check-in's "waiting" line (gate/held.ts).
    if (out.did === "refused" && d.hits.some((h) => h.rule === "keeper" && h.result === "refuse")) noteAt(deps.held ?? LINK_HELD, now);
    // A try that couldn't be counted stays what act() said; at the boundary nothing passes
    // because a file couldn't be written.
    writeTries(tries, now);
    const line = entry(call, d, out, got.from, now);
    if (line) await (deps.log ?? appendGate)(line);
    const o = out.output as any;
    const h = o?.hookSpecificOutput;
    if (!h) return { kind: "pass", did: out.did };
    if (h.permissionDecision === "deny") return { kind: "refuse", reason: String(h.permissionDecisionReason ?? "the message gate held this.") };
    if (h.permissionDecision === "allow" && typeof h.updatedInput?.text === "string")
      return { kind: "fix", text: h.updatedInput.text, note: String(h.permissionDecisionReason ?? "The message gate fixed its wording as it went.") };
    return { kind: "refuse", reason: "the message gate couldn't tell what to do with this, so it wasn't sent; send it again." };
  } catch (e) {
    return { kind: "refuse", reason: `the message gate couldn't check this (${String((e as Error)?.message ?? e).slice(0, 80)}), so it wasn't sent; send it again.` };
  }
}

// What went out, as discord-sent.ts told the link: the note for /sent, and any bypass to log.
export function sentNote(tool: "reply" | "edit", args: Record<string, unknown>, result: unknown, session: string, now = Date.now()):
    { note: SentNote | null; madeUp: ReturnType<typeof madeUpReviews> } {
  const input = { tool_name: tool === "reply" ? REPLY_TOOL : EDIT_TOOL, tool_input: args, tool_response: result, session_id: session };
  const note = noteOf(input, now);
  return { note, madeUp: note ? madeUpReviews(String(args.text ?? "")) : [] };
}
