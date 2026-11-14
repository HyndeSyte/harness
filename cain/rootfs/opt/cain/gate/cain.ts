// The message gate's rules for Cain's words alone (piece D, Cain 0.11.0), on top of the
// shared ones in rules.ts. Pure, no I/O. They aren't in tests/message_rules.py: that port is
// for the calendar specialist's tests, and the specialist never writes these.
//
//   reviewed     a review claim (in his replies and edits, his asks and their options, the
//                morning message and the connector notice) goes only as the review service
//                gave it (../reviewed.ts), word for word: refuse, offering its newest lines;
//                "unsure" while those lines can't be read. A claim is a "Reviewed" heading (then
//                optional spaces and ":" or "-"), "reviewed by" a seat, or a seat's name in the
//                same sentence as a verdict word. After a line the service gave, the rest of its
//                paragraph may carry no other claim. The reply hook holds a made-up claim for
//                good (no third try lets it through) and holds softly while the lines can't
//                be read.
//   ship words   on a Ship card, his own line claiming evidence the link adds itself: any review
//                claim (a real line too) or the word "reviewed", or a CI claim: a CI, check,
//                test or build word and pass, passed, green, succeeded, fail, failed or red,
//                either way round, with at most a few small words between ("checks are green",
//                "Passed all checks", "the pipeline is green"): refuse.
//   codes        a record code in his words: an item id his record has (P64), with a question
//                id right after it ("P08 Q2"). He can't tell what those are, so the thing is
//                named by what it does for him. Ids the record doesn't have and ordinary words
//                ("Q4 taxes", "vitamin D3", "a P100 filter") pass, as do code spans and links;
//                with no record to read, nothing is a code. Held softly, like the wording
//                rules: his third try goes.
// Both read the words as he'd see them, so nothing slips past by its spelling: compatibility
// forms folded (NFKC), zero-width and bidi characters dropped, Cyrillic and Greek letters that
// look like Latin ones read as those, markdown emphasis, quote marks and code marks dropped
// (code is read, not skipped). Links aren't words: a masked link reads as its words, a bare
// one not at all.
import type { Reviewed } from "../reviewed";
import { around, hidden, linkSpans } from "./rules";

export type CainRule = "reviewed" | "ship words" | "codes";
export const CAIN_RULES: readonly CainRule[] = ["reviewed", "ship words", "codes"];
export interface CainHit { rule: CainRule; result: "refuse" | "unsure"; at: number; end: number; around: string }

// -- reading the words as he'd see them -----------------------------------------------------
const INVISIBLE = new RegExp("[\\u00ad\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");
// Cyrillic and Greek letters that look like Latin ones.
const LOOKALIKE = new Map<string, string>(([
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0443, "y"], [0x0445, "x"], [0x0456, "i"],
  [0x0458, "j"], [0x0455, "s"], [0x04bb, "h"], [0x0501, "d"], [0x051b, "q"], [0x051d, "w"], [0x04cf, "l"], [0x04af, "y"],
  [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"], [0x0420, "P"],
  [0x0421, "C"], [0x0422, "T"], [0x0423, "Y"], [0x0425, "X"], [0x0406, "I"], [0x0408, "J"], [0x0405, "S"], [0x04ae, "Y"],
  [0x051a, "Q"], [0x051c, "W"], [0x04c0, "I"],
  [0x03b1, "a"], [0x03bf, "o"], [0x03c1, "p"], [0x03bd, "v"], [0x03b9, "i"], [0x03ba, "k"], [0x03c5, "u"], [0x03c7, "x"],
  [0x03b5, "e"], [0x03c4, "t"], [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"],
  [0x039a, "K"], [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"], [0x03a5, "Y"], [0x03a7, "X"],
] as [number, string][]).map(([cp, latin]) => [String.fromCharCode(cp), latin]));
const LOOKALIKES = new RegExp(`[${[...LOOKALIKE.keys()].join("")}]`, "g");
const DOUBLE_QUOTES = new RegExp("[\"\\u201c\\u201d\\u201e\\u201f\\u00ab\\u00bb]", "g");
// A single quote mark, not an apostrophe inside a word ("ChatGPT's" keeps its).
const SINGLE_QUOTES = new RegExp("(^|[^A-Za-z0-9])['\\u2018\\u2019\\u201a\\u201b]+|['\\u2018\\u2019\\u201a\\u201b]+(?=[^A-Za-z0-9]|$)", "g");

export function claimText(text: string): string {
  let t = String(text ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(LOOKALIKES, (c) => LOOKALIKE.get(c) ?? c);
  t = t.replace(/\]\([^)\s]*\)/g, "]");                         // [words](target): its words
  let bare = "", i = 0;                                          // a bare link: not words
  for (const [a, b] of linkSpans(t)) { bare += `${t.slice(i, a)} `; i = b; }
  t = bare + t.slice(i);
  return t.replace(/[*~`[\]]/g, "")                              // emphasis, code marks (the code is read), brackets
    .replace(/(^|[^A-Za-z0-9])_+|_+(?=[^A-Za-z0-9]|$)/g, "$1")   // _emphasis_, never an underscore inside a word
    .replace(DOUBLE_QUOTES, "").replace(SINGLE_QUOTES, "$1")
    .replace(/^[ \t]*>+[ \t]?/gm, "");                           // block quotes
}

// -- review claims ------------------------------------------------------------------------------
const WORD = (alts: string) => `(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`;
const SEATS = "openai|chatgpt|codex|gpt|gemini|perplexity|claude";
const VERDICTS = "approve|approved|approves|approval|verdict|verdicts|reject|rejected|rejects|signed\\s+off|lgtm";
const REVIEW_WORDS = "review|reviews|reviewed|reviewer|reviewers";
// "Reviewed", then any spaces (a line break too), then ":" or "-": a heading only where it
// starts a sentence or a line ("Done. Reviewed: ..."), never mid-sentence ("what I reviewed: the calendar").
const HEADING = new RegExp("(?<![A-Za-z0-9])reviewed\\s*[:\\-\\u2013\\u2014]", "gi");
const SEAT = new RegExp(WORD(SEATS), "i");
const VERDICT = new RegExp(WORD(VERDICTS), "i");
const REVIEW = new RegExp(WORD(REVIEW_WORDS), "i");
const BY_SEAT = new RegExp(`(?<![A-Za-z0-9])reviewed\\s+by\\s+(?:the\\s+)?${WORD(SEATS)}`, "i");

interface Claim { at: number; end: number; said: string; heading: boolean }
// A "Reviewed" heading's claim runs to the full stop that ends its sentence, or its line's end.
function headings(t: string): Claim[] {
  const out: Claim[] = [];
  for (const m of t.matchAll(HEADING)) {
    const at = m.index!;
    const before = t.slice(0, at).replace(/[ \t]+$/, "");
    if (before && !/[\n.!?;:(•>#\-*]$/.test(before)) continue;      // mid-sentence: not a heading
    const stop = /\.(?=\s|$)|\n/.exec(t.slice(at + m[0].length));
    const end = stop ? at + m[0].length + stop.index + (stop[0] === "." ? 1 : 0) : t.length;
    out.push({ at, end, said: t.slice(at, end).trim(), heading: true });
  }
  return out;
}
// Sentences end at a full stop, "!" or "?" before a space or the end, at ";", and at a line's end.
function sentences(t: string): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  const add = (a: number, b: number) => {
    while (a < b && /\s/.test(t[a])) a++;
    while (b > a && /\s/.test(t[b - 1])) b--;
    if (b > a) out.push([a, b]);
  };
  for (const m of t.matchAll(/[.!?]+(?=\s|$)|;|\n/g)) { add(from, m.index! + m[0].length); from = m.index! + m[0].length; }
  add(from, t.length);
  return out;
}
// Every claim in words already read as he'd see them (claimText), in order. A claim is a
// "Reviewed" heading, "reviewed by" a seat, or a sentence with both a review word and a
// verdict word ("All reviewers approved it"). broad (his Ship card line and a pull request's
// title, where no review talk belongs): a seat's name with a verdict word counts too
// ("OpenAI approved it"). In his other words that alone isn't one, so "the Gemini API
// rejected the request" still goes out.
function claimsIn(t: string, broad = false): Claim[] {
  const out = headings(t);
  for (const [a, b] of sentences(t)) {
    const s = t.slice(a, b);
    if (BY_SEAT.test(s) || (VERDICT.test(s) && (REVIEW.test(s) || (broad && SEAT.test(s)))))
      out.push({ at: a, end: b, said: s, heading: false });
  }
  return out.sort((x, y) => x.at - y.at);
}
// Whether his words claim anything about a review, before the service's lines are read.
export function claimsReview(text: string): boolean { return claimsIn(claimText(text)).length > 0; }

// A line as the gate compares it, the same on both sides: spaces as one, the heading as
// "Reviewed: ", and the full stop at its end may go.
const canon = (s: string) => s.replace(/\s+/g, " ").trim()
  .replace(new RegExp("^reviewed\\s*[:\\-\\u2013\\u2014]\\s*", "i"), "Reviewed: ").replace(/\.$/, "");
const excerpt = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);

// published: the review service's lines; null (or not given) when they can't be read. Each
// claim that isn't a line the service gave is a hit, once, with itself as its excerpt. After
// a line the service gave, the rest of its paragraph may claim nothing more about a review.
export function reviewedHits(text: string, published: readonly Reviewed[] | null | undefined): CainHit[] {
  const t = claimText(text);
  const heads = headings(t);
  if (!heads.length && !claimsIn(t).length) return [];
  let rest = t;
  const tails: [number, number][] = [];
  if (published) {
    const real = new Set(published.map((p) => canon(claimText(p.line))));
    // A line the service gave is taken out; whatever claim is left, around it too, is a hit.
    for (const c of heads) if (real.has(canon(c.said))) {
      rest = rest.slice(0, c.at) + " ".repeat(c.end - c.at) + rest.slice(c.end);
      const blank = /\n[ \t]*\n/.exec(t.slice(c.end));
      tails.push([c.end, blank ? c.end + blank.index : t.length]);
    }
  }
  const claims = claimsIn(rest);
  // After a line the service gave, the rest of its paragraph may give no other verdict ("All
  // reviewers approved it", "Gemini, approve too", "The reviewer signed off").
  for (const [a, b] of tails) for (const [x, y] of sentences(rest.slice(a, b))) {
    const s = rest.slice(a + x, a + y);
    if (VERDICT.test(s)) claims.push({ at: a + x, end: a + y, said: s, heading: false });
  }
  claims.sort((p, q) => p.at - q.at);
  const out: CainHit[] = [];
  for (const c of claims) {
    if (out.some((h) => h.at < c.end && c.at < h.end)) continue;
    out.push({ rule: "reviewed", result: published ? "refuse" : "unsure", at: c.at, end: c.end, around: excerpt(rest.slice(c.at, c.end)) });
  }
  return out;
}

// -- ship words -----------------------------------------------------------------------------------
// On a Ship card, and in a pull request's title there, nothing but the link's own lines may
// speak of checks or a review: a sentence with a CI word and a result word anywhere in it
// counts ("The checks on this commit are green", "Passed all checks"), as does any review
// claim (broad) or the word "reviewed" at all.
const CI = new RegExp(WORD("ci|checks?|tests?|tested|builds?|pipelines?|workflows?"), "i");
const RESULT = new RegExp(WORD("pass|passes|passed|passing|green|succeeded|succeeds|success|successful|fail|fails|failed|failing|failure|red|broken"), "i");
const REVIEWED_WORD = new RegExp(WORD("reviewed"), "gi");

function ciClaimSpans(t: string): [number, number][] {
  return sentences(t).filter(([a, b]) => { const s = t.slice(a, b); return CI.test(s) && RESULT.test(s); });
}
// Whether words claim checks passed or failed.
export function claimsChecks(text: string): boolean { return ciClaimSpans(claimText(text)).length > 0; }

export function shipWordsHits(text: string): CainHit[] {
  const t = claimText(text);
  const spans: [number, number][] = [...claimsIn(t, true).map((c): [number, number] => [c.at, c.end]),
    ...[...t.matchAll(REVIEWED_WORD)].map((m): [number, number] => [m.index!, m.index! + m[0].length]), ...ciClaimSpans(t)];
  const out: CainHit[] = [];
  for (const [at, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (out.some((h) => h.at < end && at < h.end)) continue;
    out.push({ rule: "ship words", result: "refuse", at, end, around: around(t, at, end) });
  }
  return out;
}

// -- record codes -------------------------------------------------------------------------------
// The item ids his record has, open or done, from state/PENDING.md, as "P" and the number
// ("P08" is P8); null when there's no record to read, and then nothing is a code.
export function recordItems(pending: string | null | undefined): Set<string> | null {
  if (typeof pending !== "string") return null;
  const out = new Set<string>();
  for (const line of pending.split(/\r?\n/)) {
    const m = /^\|\s*P0*(\d{1,4})(?![A-Za-z0-9])/i.exec(line);
    if (m) out.add(`P${Number(m[1])}`);
  }
  return out.size ? out : null;
}
const CODE = /(?<![A-Za-z0-9])P0*(\d{1,4})(?![A-Za-z0-9])(?:[ \t]+Q\d{1,2}(?![A-Za-z0-9]))?/gi;
// Codes are read as he'd see them too: compatibility forms folded (full-width digits) and
// invisible characters dropped, before anything is matched.
const codeText = (text: string): string => String(text ?? "").normalize("NFKC").replace(INVISIBLE, "");
// Whether words could hold a record code at all, so the record is read only when they might.
export const mayHaveCode = (text: string): boolean => /P\d/i.test(codeText(text));
export function codesHits(text: string, items: ReadonlySet<string> | null | undefined): CainHit[] {
  if (!items?.size) return [];
  const t = codeText(text);
  const seen = hidden(t);                                        // code spans and links aren't read
  const out: CainHit[] = [];
  for (const m of seen.matchAll(CODE)) {
    if (!items.has(`P${Number(m[1])}`)) continue;
    const at = m.index!, end = at + m[0].length;
    out.push({ rule: "codes", result: "refuse", at, end, around: around(t, at, end) });
  }
  return out;
}

// -- what each asks of him, for the line that says why his words were held back -----------------
export const CODES_WHY = "name it by what it does for him, not by its record code: he can't tell what those are";
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
  if (h.rule === "codes") return CODES_WHY;
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
