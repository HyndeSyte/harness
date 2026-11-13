// What the gate would do with one of Cain's own Discord replies or edits, against the
// cards that are up now (piece D). Pure: the reply hook (../hooks/discord-send.ts) and
// the link's dry run (keeper.sh check) both call it, so they always agree. In this
// release nothing acts on it: the hook only logs it.

import { AT, check, type Hit, type Result, verdict } from "./rules";

export type Writer = "cain" | "specialist" | "link";

// One message the link knows, as the link publishes it (no text): its Discord id, what
// it is, who wrote its words, the labels of its buttons, and whether they're up and count.
export interface CardView {
  message: string; kind: string; writer: Writer; labels: string[]; live: boolean;
  item: string | null; question: string | null; posted: number | null;
}
export interface CardsView { written_at: number; owner: string | null; dm: string | null; cards: CardView[] }

export interface SendCall { tool: "reply" | "edit"; text: string; replyTo?: string; target?: string }
export interface GateHit { rule: string; result: Result; around: string; label?: string }
export interface Decision { would: "pass" | "fix" | "refuse" | "unsure"; fixed: string; hits: GateHit[]; said: string }

const when = (ms: number | null, tz: string) => (ms ? new Intl.DateTimeFormat("en-US",
  { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)) : "time unknown");

const WHY: Record<string, string> = {
  dash: "no em dashes",
  app: "Home Assistant calls them Apps",
  count: "name each one instead of a count",
  machine: "no shas, job ids, ISO times or Discord ids: say it as people say it",
};

// cards: the link's view now, or null when it can't be had (the link down and its file
// missing or stale): then a named button is "can't tell".
export function decideSend(call: SendCall, cards: CardsView | null, tz = "America/New_York"): Decision {
  const target = call.replyTo && cards ? cards.cards.find((c) => c.message === call.replyTo) : undefined;
  // Known labels: those on live cards, and the card a reply answers even once its buttons
  // are off (naming one then points him at a button that's gone).
  const known = cards ? [...cards.cards.filter((c) => c.live).flatMap((c) => c.labels), ...(target?.labels ?? [])] : [];
  // An edit names no button. A reply names only buttons on the live card it answers; one
  // to a message the link didn't post answers him (or an older reply of Cain's).
  const buttons = call.tool === "edit" || !call.replyTo ? [] : !cards ? null : target?.live ? target.labels : [];
  const answersHim = call.tool === "reply" && !!call.replyTo && !!cards && !target;
  const r = check(call.text, { rules: AT.cain, buttons, known, answersHim });
  const hits: GateHit[] = r.hits.map((h: Hit) => ({ rule: h.rule, result: h.result, around: h.around, ...(h.label ? { label: h.label } : {}) }));
  // An edit is for Cain's own replies, never a message the link posted.
  if (call.tool === "edit") {
    if (!cards) hits.push({ rule: "target", result: "unsure", around: "" });
    else if (cards.cards.some((c) => c.message === call.target))
      hits.push({ rule: "target", result: "refuse", around: "" });
  }
  const would = hits.some((h) => h.result === "refuse") ? "refuse" : verdict(r) === "fix" ? "fix"
    : hits.some((h) => h.result === "unsure") ? "unsure" : "pass";
  const lines: string[] = [];
  for (const h of hits) {
    if (h.rule === "button" && h.label) {
      const with_ = (cards?.cards ?? []).filter((c) => c.live && c.labels.includes(h.label!));
      lines.push(h.result === "unsure"
        ? `"${h.label}" names a button, and which buttons are up can't be checked right now: say it without naming a button, or try again in a minute.`
        : `"${h.label}" isn't a button on ${call.tool === "reply" && target ? "the card this answers" : "this message"}${with_.length
          ? `; live cards with it: ${with_.map((c) => `message ${c.message} (${when(c.posted, tz)})`).join(", ")}` : ", and no live card has it"}.`);
    } else if (h.rule === "target") {
      lines.push(h.result === "unsure" ? "Which messages are cards can't be checked right now, so an edit waits: try again in a minute."
        : "That message is one the link posted (a card or notice): edit only your own replies.");
    } else if (h.result === "refuse") lines.push(`"${h.around}": ${WHY[h.rule] ?? "change it"}.`);
  }
  if (would === "fix") lines.push(`Send exactly this instead: ${r.fixed}`);
  return { would, fixed: r.fixed, hits, said: lines.join(" ") || "Nothing to change." };
}
