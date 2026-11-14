// What the gate does with one of Cain's own Discord replies or edits, against the cards
// that are up now (piece D, enforcing since Cain 0.10.0). Pure: the reply hook
// (../hooks/discord-send.ts) and the link's dry run (keeper.sh check) both call it, so
// they agree; only the hook also has his session's transcript, the proof that a fresh
// message is his own reply before the link has heard of it.
//
//   pass    nothing to change
//   fix     only em dashes or "add-on": the hook sends the fixed words in its place
//   refuse  held back, with what to change: a hidden count, machine text, an em dash
//           between two numbers that isn't a clock range, a button the card it answers
//           doesn't have, or a named button while which buttons are up can't be told.
//           Never released by a third try (hard): a chat the link says isn't his DM, or
//           an edit of a message that isn't one of Cain's own replies, or whose owner
//           can't be told right now
import { snowflakeTime } from "./plugin";
import { AT, check, type Hit, type Result, whyOf } from "./rules";

export type Writer = "cain" | "specialist" | "link";

// One message the link knows, as the link publishes it (no text): its Discord id, what
// it is, who wrote its words, the labels of its buttons, and whether they're up and count.
export interface CardView {
  message: string; kind: string; writer: Writer; labels: string[]; live: boolean;
  item: string | null; question: string | null; posted: number | null;
}
// sent: the ids of Cain's own replies (35 days): the only messages he may edit (0.10.0).
export interface CardsView { written_at: number; owner: string | null; dm: string | null; cards: CardView[]; sent?: string[] }

export interface SendCall { tool: "reply" | "edit"; text: string; replyTo?: string; target?: string; chat?: string }
export interface GateHit { rule: string; result: Result; around: string; label?: string }
export interface Decision {
  would: "pass" | "fix" | "refuse";
  fixed: string; hits: GateHit[]; said: string;
  hard: boolean;                       // a refusal no third try releases
  chat: "his" | "other" | "unknown";   // whether the send goes to his DM, as far as can be told
}

const when = (ms: number | null, tz: string) => (ms ? new Intl.DateTimeFormat("en-US",
  { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms)) : "time unknown");

export const HELD = "The message gate held this:";
export const REWRITE = "Rewrite and send now; don't mention it to him.";
// A message the link doesn't know, made this recently, can be a reply of Cain's whose
// PostToolUse word hasn't reached the link yet (it's sent in the background).
export const EDIT_WINDOW_MS = 10 * 60_000;

// cards: the link's view now, or null when it can't be had (the link down and its file
// missing or stale): then a named button can't be checked, and an edit waits.
// dm: the hook's cached DM id, which counts only when there are no cards at all; a chat
// that differs from it alone is a soft refusal, since the plugin's own allowlist holds
// the chats it sends to. Cards that name no DM (the link hasn't asked Discord yet, say
// after a new bot token) leave the chat unknown: the cache may be the old bot's.
// now: for the edit window. replied: the ids the plugin's reply tool answered with in this
// session, from its transcript (the hook's, never the link's).
export function decideSend(call: SendCall, cards: CardsView | null,
                           o: { tz?: string; dm?: string | null; now?: number; replied?: ReadonlySet<string> } = {}): Decision {
  const tz = o.tz ?? "America/New_York";
  const now = o.now ?? Date.now();
  const dm = cards ? cards.dm ?? null : o.dm ?? null;
  const target = call.replyTo && cards ? cards.cards.find((c) => c.message === call.replyTo) : undefined;
  const live = (cards?.cards ?? []).filter((c) => c.live);
  // Known labels: those on live cards, and the card a reply answers even once its buttons
  // are off (naming one then points him at a button that's gone).
  const known = cards ? [...live.flatMap((c) => c.labels), ...(target?.labels ?? [])] : [];
  // An edit names no button. A reply names only buttons on the live card it answers.
  // "tap Stop" is true while any live message carries Stop (it sits on the newest plain one).
  const buttons: string[] | null = call.tool === "edit" || !call.replyTo ? [] : !cards ? null : target?.live ? [...target.labels] : [];
  if (buttons && live.some((c) => c.labels.includes("Stop"))) buttons.push("Stop");
  // A reply to a message that is neither one the link posted nor one of Cain's own answers him.
  const answersHim = call.tool === "reply" && !!call.replyTo && !!cards && !target && !(cards.sent ?? []).includes(call.replyTo);
  const r = check(call.text, { rules: AT.cain, buttons, known, answersHim });
  const hits: GateHit[] = r.hits.map((h: Hit) => ({ rule: h.rule, result: h.result, around: h.around, ...(h.label ? { label: h.label } : {}) }));
  let hard = false;
  // Only his DM: the plugin's own allowlist holds that today; this says so in words.
  const chat = !call.chat || !dm ? "unknown" : call.chat === dm ? "his" : "other";
  if (chat === "other") { hits.push({ rule: "chat", result: "refuse", around: "" }); if (cards?.dm) hard = true; }
  // An edit is for Cain's own replies only, never a card or notice the link posted.
  if (call.tool === "edit") {
    const t = editTarget(call.target, cards, now, o.replied);
    if (t !== "ok") { hits.push({ rule: "target", result: t, around: "" }); hard = true; }
  }
  const held = hits.some((h) => h.result === "refuse" || h.result === "unsure");
  const would = held ? "refuse" : hits.some((h) => h.result === "fix") ? "fix" : "pass";
  const lines: string[] = [];
  for (const h of hits) {
    if (h.rule === "button" && h.label) {
      const with_ = live.filter((c) => c.labels.includes(h.label!) && c.message !== call.replyTo);
      const where = with_.length ? `; live card${with_.length > 1 ? "s" : ""} with it: ${with_.map((c) => `message ${c.message} (${when(c.posted, tz)})`).join(", ")}`
        : "; no live card has it";
      if (h.result === "unsure")
        lines.push(`"${h.label}" names a button, and which buttons are up can't be checked right now: say it without naming a button, or try again in a minute.`);
      else if (call.tool === "reply" && target)
        lines.push(`"${h.label}" isn't on the card this answers (its buttons: ${target.live && target.labels.length ? target.labels.join(", ") : "none up now"})${where}.`);
      else
        lines.push(`"${h.label}" names a button, and ${call.tool === "edit" ? "an edit" : "this reply"} answers no card that has it: name one only in a reply to its card${where}.`);
    } else if (h.rule === "target") {
      lines.push(h.result === "unsure" ? "Which messages are your own replies can't be checked right now: send it as a new reply instead, or edit in a minute."
        : "That message isn't one of your own replies: edit only your own, or say it in a new reply.");
    } else if (h.rule === "chat") {
      lines.push(hard ? "That chat isn't his DM: send only to him, in his DM."
        : "That chat isn't his DM as last seen (the link can't be asked right now): send only to him, in his DM.");
    } else if (h.result === "refuse") lines.push(`"${h.around}": ${whyOf(h)}.`);
  }
  let said: string;
  if (would === "refuse") {
    const fixes = !hits.some((h) => h.result === "fix") ? ""
      : hits.some((h) => h.rule === "dash" && h.result === "refuse") ? " Its other em dashes and add-ons are fixed for you when it goes."
      : " Its em dashes and add-ons are fixed for you when it goes.";
    // An edit held for its target isn't fixed by rewording it.
    said = `${HELD} ${lines.join(" ")}${fixes} ${hits.some((h) => h.rule === "target") ? "Don't mention it to him." : REWRITE}`;
  } else if (would === "fix") said = `Send exactly this instead: ${r.fixed}`;
  else said = "Nothing to change.";
  return { would, fixed: r.fixed, hits, said, hard, chat };
}

// Whether an edit's target is one of Cain's own replies. "refuse": a message the link
// posted (anything but "plain", even one on his list), or one neither on his list nor
// fresh. "unsure": it can't be told now (no cards, or a fresh message the link doesn't know
// that this session's transcript doesn't show as his reply). A fresh message the link
// doesn't know passes only on his reply tool's own answer: the bot's other messages (a
// post of the link's whose answer was lost, the plugin's permission prompts) never show
// there as one.
function editTarget(target: string | undefined, cards: CardsView | null, now: number, replied?: ReadonlySet<string>): "ok" | "refuse" | "unsure" {
  if (!target) return "refuse";
  if (!cards) return "unsure";
  const known = cards.cards.find((c) => c.message === target);
  if (known && known.kind !== "plain") return "refuse";
  if ((cards.sent ?? []).includes(target)) return "ok";
  if (known) return "refuse";
  const at = snowflakeTime(target);
  if (at > now - EDIT_WINDOW_MS && at <= now + 60_000) return replied?.has(target) ? "ok" : "unsure";
  return "refuse";
}
