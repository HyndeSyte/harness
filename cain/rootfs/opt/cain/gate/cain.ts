// The message gate's rules for Cain's words alone (piece D, Cain 0.11.0), on top of the
// shared ones in rules.ts. Pure, no I/O. They aren't in tests/message_rules.py: that port is
// for the calendar specialist's tests, and the specialist never writes these.
//
//   reviewed     a "Reviewed:" sentence (in his replies and edits, his asks and their options,
//                the morning message and the connector notice) goes only as the review
//                service gave it (../reviewed.ts), word for word: refuse, offering its newest
//                lines; "unsure" while those lines can't be read. The reply hook holds a made-up
//                line for good (no third try lets it through) and an unreadable file softly.
//   ship words   on a Ship card, his own line claiming evidence the link adds itself: the word
//                "reviewed", or a CI, check, test or build word with pass, passed, green,
//                succeeded, fail, failed or red within about 30 characters after it: refuse.
// Code spans and links are never read, as in rules.ts.
import type { Reviewed } from "../reviewed";
import { around, hidden, hostsOnly } from "./rules";

export type CainRule = "reviewed" | "ship words";
export const CAIN_RULES: readonly CainRule[] = ["reviewed", "ship words"];
export interface CainHit { rule: CainRule; result: "refuse" | "unsure"; at: number; end: number; around: string }

const REVIEWED = /(?<![A-Za-z0-9])reviewed:/gi;
// Whether a text has a "Reviewed:" sentence at all, before anything is read to check it.
export function mentionsReviewed(text: string): boolean {
  return /(?<![A-Za-z0-9])reviewed:/i.test(hidden(String(text ?? "")));
}

// Each "Reviewed:" sentence: from the word to the full stop that ends it, or the end of its line.
function reviewedSentences(text: string): { at: number; end: number; said: string }[] {
  const t = String(text ?? "");
  const out: { at: number; end: number; said: string }[] = [];
  for (const m of hidden(t).matchAll(REVIEWED)) {
    const at = m.index!;
    const stop = /\.(?=\s|$)|\n/.exec(t.slice(at));
    const end = stop ? at + stop.index + (stop[0] === "." ? 1 : 0) : t.length;
    out.push({ at, end, said: t.slice(at, end).trim() });
  }
  return out;
}

// One line as he may say it: its own words, the full stop at its end may go.
const same = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\.$/, "");

// published: the review service's lines; null (or not given) when they can't be read.
export function reviewedHits(text: string, published: readonly Reviewed[] | null | undefined): CainHit[] {
  const t = String(text ?? "");
  const found = reviewedSentences(t);
  if (!found.length) return [];
  const real = published ? new Set(published.map((p) => same(p.line))) : null;
  // Its excerpt is the sentence itself (up to 60 characters, a link only its host), so he sees what he wrote.
  return found.filter((s) => !real || !real.has(same(s.said)))
    .map((s) => ({ rule: "reviewed" as const, result: real ? "refuse" as const : "unsure" as const, at: s.at, end: s.end,
      around: hostsOnly(s.said).replace(/\s+/g, " ").trim().slice(0, 60) }));
}

const CI_WORD = "ci|checks?|tests?|tested|builds?";
const RESULT_WORD = "pass|passes|passed|passing|green|succeeded|succeeds|fail|fails|failed|failing|red";
const SHIP_WORDS: RegExp[] = [
  /(?<![A-Za-z0-9])reviewed(?![A-Za-z0-9])/gi,
  new RegExp(`(?<![A-Za-z0-9])(?:${CI_WORD})(?![A-Za-z0-9])[^\\n]{0,30}?(?<![A-Za-z0-9])(?:${RESULT_WORD})(?![A-Za-z0-9])`, "gi"),
];
export function shipWordsHits(text: string): CainHit[] {
  const t = String(text ?? "");
  const seen = hidden(t);
  const out: CainHit[] = [];
  for (const re of SHIP_WORDS) for (const m of seen.matchAll(re)) {
    const at = m.index!, end = at + m[0].length;
    if (out.some((h) => h.at < end && at < h.end)) continue;
    out.push({ rule: "ship words", result: "refuse", at, end, around: around(t, at, end) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// What each asks of him, for the line that says why his words were held back.
export const SHIP_WORDS_WHY = "the link adds the checks and the Reviewed line itself, so leave CI, check and review claims out of your words";
export const REVIEWED_UNSURE = "reviews can't be checked right now: leave the Reviewed line out, or send it in a minute";
// n: how many of the service's newest lines to offer (each with its review id).
export function reviewedWhy(published: readonly Reviewed[] | null | undefined, n = 3): string {
  const real = (published ?? []).slice(0, Math.max(1, n));
  return real.length
    ? `a Reviewed line goes only as the review service gave it, word for word, or not at all (${real.map((p) => `review ${p.id}: "${p.line}"`).join("; ")})`
    : "a Reviewed line goes only as the review service gave it, and it has given none yet: leave it out";
}
export function cainWhy(h: Pick<CainHit, "rule" | "result">, published?: readonly Reviewed[] | null, n = 3): string {
  if (h.rule === "ship words") return SHIP_WORDS_WHY;
  return h.result === "unsure" ? REVIEWED_UNSURE : reviewedWhy(published, n);
}

// The hits as parts of a line to him, like rules.ts reasonParts: each reason once, after its
// excerpts (at most `each`; with none, one of the service's lines is still offered).
export function cainReasons(hits: readonly CainHit[], published?: readonly Reviewed[] | null, each = 3): string[] {
  const order: string[] = [];
  const said = new Map<string, string[]>();
  for (const h of hits) {
    const why = cainWhy(h, published, each);
    if (!said.has(why)) { said.set(why, []); order.push(why); }
    const q = said.get(why)!;
    if (h.around && !q.includes(h.around)) q.push(h.around);
  }
  return order.map((why) => {
    const q = said.get(why)!;
    return each > 0 && q.length && why !== REVIEWED_UNSURE ? `${q.slice(0, each).map((a) => `"${a}"`).join(", ")}: ${why}` : why;
  });
}
