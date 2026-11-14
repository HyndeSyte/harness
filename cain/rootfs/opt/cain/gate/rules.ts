// The message gate's rules (piece D): what a message to Dane may not say, as plain
// code, no model and no I/O. Since Cain 0.10.0 they act: the reply hook
// (hooks/discord-send.ts) and the link's send points fix what's fixable and hold back
// what isn't (each send point's table is in DOCS.md and the link's core.ts), and the
// replay reads his DM with them. tests/message_rules.py is a port for the calendar
// specialist's tests, kept equal to this file by cain/tests/gate-cases.json.
//
//   dash     an em dash, never inside code or a link. In words of a writer the gate
//            refuses (Context.refusable: Cain's replies and edits, his asks and their
//            options, Ship cards, morning message and connector notice), every one:
//                                          refuse: rewrite it without one, since only he
//                                          knows whether he meant a range or a break.
//            In words that are never refused (the specialist's cards and notes, the
//            link's own)                   fix: ", ", only between plain words (two on
//                                          each side: no digit, day, month, time of day,
//            symbol or single letter), never " to ". Any other stays as it is, flagged:
//            a flag costs nothing, and a comma could make a range a list
//   app      "the add-on", "Cain's add-on", "Harness add-on", "Settings > Add-ons" and
//            the like (also "addon" and the specialist's escaped "add\-on"; plural and
//            possessive)                   fix: "App", "Apps", "App's". A bare "add-on"
//            (a browser add-on in a calendar title) is left alone.
//   count    "and 3 more", "and a few more", "+2 more", "(+2)", "4 more changes"
//                                          refuse: name each one
//   machine  a full commit sha, a cloud job id (cse_), an ISO date-time, a Discord id
//            (17 to 20 digits), "job" and a hex id     refuse: say it as people say it.
//            In a reply to his own message a long number, and anything in code, passes.
//   button   a known button label named as one ("tap Undo", "press Ship", "the Stop
//            button", "with Undo"), exact case, when the message (or the live card a
//            reply answers) doesn't have it        refuse; "unsure" when which buttons
//            are up can't be told
// Masked link targets are never visible text, so no rule reads them. An en dash is
// left alone: "9 – 11" would lose its meaning as "9, 11".

export const RULES = ["dash", "app", "count", "machine", "button"] as const;
// Goes up whenever a rule changes what it catches: the link replays his DM once more by
// itself with the new rules (1: Cain 0.9.0, report mode; 2: 0.10.0, tuned from the replay).
export const RULES_VERSION = 2;
export type Rule = (typeof RULES)[number];
export type Result = "fix" | "refuse" | "unsure";
// Why a dash in words that are never refused stays as it is: anything but plain words round
// it ("range": a range may be meant), or a link right before it ("link").
export type Kept = "range" | "link";
export interface Hit { rule: Rule; result: Result; at: number; end: number; around: string; label?: string; kept?: Kept }
export interface Report { hits: Hit[]; fixed: string }
export interface Context {
  rules?: readonly Rule[];               // the rules this send point applies (default: all)
  buttons?: readonly string[] | null;    // labels on this message, or on the live card a reply answers;
                                         // null: which buttons are up can't be told
  known?: readonly string[];             // labels on live cards, on top of the static list
  answersHim?: boolean;                  // a reply to a message of his: a long number he asked for, or code, passes
  refusable?: boolean;                   // a writer the gate refuses (Cain): every em dash is refused, none fixed
}

// Both Apps' own button labels, so "Undo" is known as a button even when no card with
// Undo is up. Labels on live cards come on top (Context.known).
export const STATIC_LABELS: readonly string[] = [
  // Cain's link, and his own asks (CLAUDE.md, Check-ins)
  "Ship", "Not now", "Stop", "Turn back on", "Start", "Open connector settings", "Do it", "I'll do it", "Drop it",
  // the calendar specialist
  "Approve", "Decline", "Undo", "Undo both", "Undo these", "Use new", "Keep old", "Not mine", "Wrong time",
  "Just this once", "Yes", "No", "Depends", "All of it", "Part of it", "Skip", "Keep rule", "Drop rule",
  "Turn on", "None wrong: stop checking", "Something was off: keep checking", "Do it now",
];

const HIDE = "\u0000";   // a character no rule can match, put over what isn't visible text

// What isn't visible text, or isn't his words to judge, hidden in place (same length,
// new lines kept): masked link targets always; code and bare links unless only targets.
// "code" hides targets and code but not bare links: what the machine rule reads in a
// reply to his own message.
export function hidden(text: string, onlyTargets: boolean | "code" = false): string {
  const t = text.split("");
  const cover = (from: number, to: number) => { for (let i = from; i < to; i++) if (t[i] !== "\n") t[i] = HIDE; };
  const each = (re: RegExp, from = 0) => { for (const m of text.matchAll(re)) cover(m.index! + from, m.index! + m[0].length); };
  each(/\]\([^)\s]*\)/g, 1);                          // [words](target): the target
  if (onlyTargets !== true) {
    each(/```[\s\S]*?```/g);
    each(/`[^`\n]+`/g);
  }
  if (onlyTargets === false) each(/<?https?:\/\/[^\s<>()]+>?/g);
  return t.join("");
}

// Up to n characters of the text around a hit, on one line. A link in it keeps only its
// scheme and host: the rest can carry an id, a token or a password, and excerpts go to the
// gate's log, the safety net's note and lines for Cain. links: the text's links, found once.
export function around(text: string, at: number, end: number, n = 60, links?: readonly LinkSpan[]): string {
  const pad = Math.max(0, Math.floor((n - Math.min(end - at, n)) / 2));
  let from = Math.max(0, at - pad);
  const to = Math.min(text.length, from + n);
  from = Math.max(0, to - n);
  return hostsOnly(text, from, to, links).replace(/\s+/g, " ").trim().slice(0, n);
}

// A link as its scheme and host alone, with "/…" when anything else was cut: never a user
// name, password, port, path, query or fragment ("https://github.com/…"). A link has any
// scheme (letters, digits, "+", "." and "-" before "://": "https://", "wss://", in any case),
// or none and starts with "www." or is a host with a path ("example.com/reset?token=…",
// "192.168.1.1/admin"; a domain's trailing dot counts). It runs to the next space or line
// break, whatever stands between ("<", ">" and brackets included; the zero-width U+FEFF too,
// which hides in text). Its authority runs to the first "/", "?", "#" or "\" (a browser reads
// "\" as "/"); its host is what follows the authority's last "@", less any port; one that isn't
// a plain name or address is "a link". Nothing after the host comes back, not even a
// sentence's own marks. Each part is bounded (a user name up to 256 characters, up to 16
// labels of up to 63), so finding the links in a long run without spaces stays quick.
const GAP = "\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";   // what ends a link
// A character of a domain's name: a letter, a digit, "-", "_", or anything past ASCII but a space.
const LABEL = `[^${GAP}\\x00-\\x2c\\x2e\\x2f\\x3a-\\x40\\x5b-\\x5e\\x60\\x7b-\\x7f]`;
const SCHEMED = `(?<![A-Za-z0-9+.\\-])[A-Za-z0-9+.\\-]+:\\/\\/[^${GAP}]+`;
// One with no scheme never starts right after a letter, a digit, "-", "_", "." or "@" of
// ASCII (a name going on); after anything else (a space, a bracket, a quote of any kind, ":"
// or "/") it may. A user name before an "@" comes with it.
const HOST_PATH = `(?:(?:${LABEL}{1,63}\\.){1,16}(?:[A-Za-z]|[^${GAP}\\x00-\\x7f])${LABEL}{1,62}|(?:\\d{1,3}\\.){3}\\d{1,3})\\.?(?::\\d{0,5})?(?=[\\/\\\\]|[?#][^${GAP}])`;
const BARE = `(?<![A-Za-z0-9_\\-.@])(?:[^${GAP}\\/?#\\\\]{0,256}@)?(?:[Ww][Ww][Ww]\\.|${HOST_PATH})[^${GAP}]*`;
const LINK = new RegExp(`${SCHEMED}|${BARE}`, "g");
// A link found in a text: where it starts and ends, and how it shows (linkHost).
export type LinkSpan = readonly [number, number, string];
export function linkSpans(text: string): LinkSpan[] {
  const t = String(text ?? "");
  return [...t.matchAll(LINK)].map((m) => [m.index!, m.index! + m[0].length, linkHost(m[0])] as const);
}
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?)(?::\d*)?$/;
export function linkHost(link: string): string {
  const s = String(link ?? "");
  const m = /^([A-Za-z0-9+.\-]+:\/\/)?([^/?#\\]*)/.exec(s)!;
  const scheme = m[1] ?? "", auth = m[2];
  const h = HOST.exec(auth.slice(auth.lastIndexOf("@") + 1));
  if (!h) return "a link";
  return `${scheme.toLowerCase()}${h[1].toLowerCase()}${s.length > scheme.length + h[1].length ? "/…" : ""}`;
}

// text[from, to) with each link as linkHost has it. A link that runs past either end of the
// window still comes out whole, as its host: never a piece of what follows the host. links:
// the text's links, when they've been found already.
export function hostsOnly(text: string, from = 0, to = text.length, links?: readonly LinkSpan[]): string {
  const t = String(text ?? "");
  const stop = Math.min(to, t.length);
  const spans = links ?? linkSpans(t);
  let lo = 0, hi = spans.length;                     // the first link that ends after from
  while (lo < hi) { const mid = (lo + hi) >> 1; if (spans[mid][1] <= from) lo = mid + 1; else hi = mid; }
  let out = "", i = from;
  for (let k = lo; k < spans.length; k++) {
    const [a, b, host] = spans[k];
    if (b <= i) continue;
    if (a >= stop) break;
    out += t.slice(i, Math.max(i, a)) + host;
    i = b;
  }
  return out + t.slice(i, Math.max(i, stop));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// -- dash ----------------------------------------------------------------------------
// In Cain's words (Context.refusable) every em dash is refused, none fixed in place: ", "
// still turned ranges into lists wherever the numbers sat behind markdown, units or words
// (a dash between bold "5" and "6 PM", "30 min" and "1 hr", "Week 1" and "Week 3"), and only
// he knows whether he meant a range or a break, so he says it again without one.
// In words that are never refused a flag costs nothing (the dash stays, and Cain hears of
// it), so an em dash becomes ", " only between plain words: the nearest two words on each
// side, on its own line, touching it with a letter, each of letters alone (an apostrophe or a
// hyphen between them), two or more, and none of DASH_WORDS. Anything else stays as it is,
// flagged: a digit, a day, a month or a time of day, a symbol ("%", "$", "°", "#", "~"), a
// single letter, markdown, a bracket or a mark against it, a line's start or end, a link
// (kept for a link right before it, or round it: a comma would run into it). Never " to ".
// The spaces around it, any but a new line (the Unicode ones too), go with it, and so does
// another dash with only spaces between.
const DASH = new RegExp("(?:[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*\\u2014+)+[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*", "g");
// Words a range can be made of, in lower case: days and months, full and short; times of day,
// of the week and of the year; units of time; numbers and ordinals in words; Roman numerals.
// Lower-case "may", "march", "sat", "sun" and "wed" alone are words (LOWER_WORDS). Kept equal
// to the port by gate-cases.json (dash_words).
export const DASH_WORDS: readonly string[] = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "morning", "mornings", "afternoon", "afternoons", "evening", "evenings", "night", "nights", "tonight", "today", "tomorrow",
  "yesterday", "noon", "midday", "midnight", "dawn", "dusk", "sunrise", "sunset", "now", "later", "overnight", "weekend",
  "weekends", "weekday", "weekdays", "am", "pm", "o'clock", "o\u2019clock", "breakfast", "brunch", "lunch", "dinner", "supper", "bedtime",
  "spring", "summer", "fall", "autumn", "winter", "christmas", "easter", "thanksgiving", "halloween",
  "second", "seconds", "sec", "secs", "minute", "minutes", "min", "mins", "hour", "hours", "hr", "hrs",
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "thousand", "million", "dozen", "half", "quarter",
  "first", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "twentieth", "thirtieth",
  "ii", "iii", "iv", "vi", "vii", "viii", "ix", "xi", "xii",
];
const RANGE_WORDS = new Set(DASH_WORDS);
const LOWER_WORDS = new Set(["may", "march", "sat", "sun", "wed"]);
const WORD = new RegExp("^[A-Za-z]+(?:['\\u2019-][A-Za-z]+)*$");
const LEAD = new RegExp("^[(\\[\"'\\u2018\\u201c]+"), TRAIL = new RegExp("[.,;:!?)\\]}\"'\\u2019\\u201d]+$");
const MAX_WORD = 40;                                 // a longer run without a space is no plain word
// A plain word, once opening quotes and brackets before it and marks after it are set aside.
function plainWord(token: string): boolean {
  const w = token.replace(LEAD, "").replace(TRAIL, "");
  return w.length >= 2 && WORD.test(w) && (!RANGE_WORDS.has(w.toLowerCase()) || LOWER_WORDS.has(w));
}
// JavaScript's \s, and the line breaks among it.
const isSpace = (c: number) => (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
// Where the spaces and line breaks are, found once per text, so each dash finds its nearest
// words at once however long the runs without a space: for each place, the last space and
// the last other character before it, the first of each at or after it, and how many line
// breaks come before it.
interface Words { prevSpace: Int32Array; prevWord: Int32Array; nextSpace: Int32Array; nextWord: Int32Array; breaks: Int32Array }
function wordsOf(text: string): Words {
  const n = text.length;
  const w: Words = { prevSpace: new Int32Array(n + 1), prevWord: new Int32Array(n + 1), nextSpace: new Int32Array(n + 1),
    nextWord: new Int32Array(n + 1), breaks: new Int32Array(n + 1) };
  let space = -1, word = -1, breaks = 0;
  for (let i = 0; i <= n; i++) {
    w.prevSpace[i] = space; w.prevWord[i] = word; w.breaks[i] = breaks;
    if (i === n) break;
    const c = text.charCodeAt(i);
    if (isSpace(c)) { space = i; if (isBreak(c)) breaks++; } else word = i;
  }
  space = n; word = n;
  for (let i = n; i >= 0; i--) {
    if (i < n) { if (isSpace(text.charCodeAt(i))) space = i; else word = i; }
    w.nextSpace[i] = space; w.nextWord[i] = word;
  }
  return w;
}
// Whether the dash at [at, end) stands between plain words: two on each side, on its line.
function betweenPlainWords(text: string, w: Words, at: number, end: number): boolean {
  const s1 = w.prevSpace[at] + 1, q = w.prevWord[s1];        // the word right before it ends at at; the one before that, at q
  const e2 = w.nextSpace[end], r = w.nextWord[e2];           // the word right after it starts at end; the one after that, at r
  if (s1 >= at || e2 <= end || q < 0 || r >= text.length) return false;
  if (w.breaks[s1] !== w.breaks[q + 1] || w.breaks[r] !== w.breaks[e2]) return false;   // a line break between
  const s0 = w.prevSpace[q] + 1, e3 = w.nextSpace[r];
  if (at - s1 > MAX_WORD || q + 1 - s0 > MAX_WORD || e2 - end > MAX_WORD || e3 - r > MAX_WORD) return false;
  const words = [text.slice(s0, q + 1), text.slice(s1, at), text.slice(end, e2), text.slice(r, e3)];
  return /[A-Za-z]$/.test(words[1]) && /^[A-Za-z]/.test(words[2]) && words.every(plainWord);
}

// Each em dash and what goes in its place; null: it stays (refused, or kept and flagged).
interface Dash { at: number; end: number; put: string | null; kept?: Kept }
function dashes(text: string, seen: string, refusable: boolean, links: readonly LinkSpan[]): Dash[] {
  const out: Dash[] = [];
  // The links a comma could run into: any but a masked link's target, which its brackets close.
  const near = refusable ? [] : links.filter(([a]) => text.slice(Math.max(0, a - 2), a) !== "](");
  let words: Words | undefined;
  for (const m of seen.matchAll(DASH)) {
    const at = m.index!, end = at + m[0].length;
    if (refusable) { out.push({ at, end, put: null }); continue; }
    let lo = 0, hi = near.length;                    // the last link that starts before the dash
    while (lo < hi) { const mid = (lo + hi) >> 1; if (near[mid][0] < at) lo = mid + 1; else hi = mid; }
    if (lo > 0 && near[lo - 1][1] >= at) out.push({ at, end, put: null, kept: "link" });
    else if (betweenPlainWords(text, words ??= wordsOf(text), at, end)) out.push({ at, end, put: ", " });
    else out.push({ at, end, put: null, kept: "range" });
  }
  return out;
}

// -- app -------------------------------------------------------------------------------
// Only the words that make it one of these two Apps: "your add-on order" is something else.
const OWNERS = "the|cain['’]s|cain|harness['’]s|harness['’]|harness";
const APP = new RegExp(`(?:\\b(?:${OWNERS})|>)[*_~]*\\s+[*_~]*(add\\\\?-?ons?(?:['’]s?)?)(?![A-Za-z0-9])`, "gid");
function apps(seen: string): { at: number; end: number; put: string }[] {
  const out: { at: number; end: number; put: string }[] = [];
  for (const m of seen.matchAll(APP)) {
    const word = m[1], [at] = m.indices![1];
    const plural = /ons/i.test(word);
    const tail = /['’]s$/i.test(word) ? `${word.at(-2)}s` : /['’]$/.test(word) ? word.at(-1)! : "";
    out.push({ at, end: at + word.length, put: (plural ? "Apps" : "App") + tail });
  }
  return out;
}

// -- count -----------------------------------------------------------------------------
const NUM = "(?:\\d+|a\\s+few|a\\s+couple(?:\\s+of)?|several|two|three|four|five|six|seven|eight|nine|ten|a\\s+dozen)";
const UNIT = "(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|times?|tries)";
// Not "questions": "two more questions after this" is how he's told a few asks follow.
const ITEMS = "(?:changes|events|blocks|cards|items|messages|notes|places|things|ones|appointments|receipts)";
const COUNTS: RegExp[] = [
  new RegExp(`\\band\\s+${NUM}\\s+(?:more|others?)\\b(?!\\s+${UNIT}\\b)`, "gi"),
  /\+\s?\d+\s+more\b/gi,
  /\\?\(\s*\+\s?\d+\s*\\?\)/g,
  new RegExp(`\\b${NUM}\\s+more\\s+${ITEMS}\\b`, "gi"),
];

// -- machine ---------------------------------------------------------------------------
const MACHINE: [RegExp, boolean][] = [   // [pattern, a Discord-id-like digit run]
  [/(?<![0-9A-Fa-f])[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g, false],
  [/\bcse\\?_[A-Za-z0-9]/g, false],
  [/\b\d{4}\\?-\d{2}\\?-\d{2}T\d{2}:\d{2}/g, false],
  [/(?<!\d)\d{17,20}(?!\d)/g, true],
];
const JOB = /\bjob\s+(?:id\s+)?#?([0-9a-f]{6,})\b/gi;

// -- button ----------------------------------------------------------------------------
const Q = "[\"“”'‘’*_]*";
const VERB = "(?:[Tt]ap|[Tt]apping|[Pp]ress|[Pp]ressing|[Hh]it|[Cc]lick|[Cc]hoose|[Pp]ick|[Ss]elect)";
// "with X" names a button only for labels that are never plain words: "ends with Stop",
// "go with No" and "syncs with Gmail" (a live card's option) are just words.
export const WITH_LABELS: readonly string[] = [
  "Undo", "Undo both", "Undo these", "Not mine", "Wrong time", "Just this once", "Turn back on", "Not now",
  "Use new", "Keep old", "Keep rule", "Drop rule", "All of it", "Part of it", "None wrong: stop checking",
  "Something was off: keep checking", "Open connector settings",
];
function named(seen: string, label: string): { at: number; end: number }[] {
  const L = escapeRe(label);
  const forms = [
    new RegExp(`(?<![A-Za-z])${VERB}\\s+(?:(?:on\\s+)?the\\s+|on\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])`, "gd"),
    new RegExp(`(?<![A-Za-z0-9])${Q}(${L})${Q}\\s+[Bb]uttons?\\b`, "gd"),
    ...(WITH_LABELS.includes(label)
      ? [new RegExp(`(?<![A-Za-z])[Ww]ith\\s+(?:the\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])`, "gd")] : []),
  ];
  const out: { at: number; end: number }[] = [];
  const starts = new Set<number>();
  for (const re of forms) for (const m of seen.matchAll(re)) {
    const [at, end] = m.indices![1];
    if (!starts.has(at)) { starts.add(at); out.push({ at, end }); }
  }
  return out;
}

// Spans found so far, in order and none overlapping: a new one is taken only if it overlaps
// none, which its neighbours alone can tell.
class Taken {
  private list: [number, number][] = [];
  take(at: number, end: number): boolean {
    let lo = 0, hi = this.list.length;                 // the first one starting at or after at
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.list[mid][0] < at) lo = mid + 1; else hi = mid; }
    if ((lo > 0 && this.list[lo - 1][1] > at) || (lo < this.list.length && this.list[lo][0] < end)) return false;
    this.list.splice(lo, 0, [at, end]);
    return true;
  }
}

// A message gets at most this many excerpts, the first hits in it, and one more for each kind
// of hit (rule, result, why it's kept, label) not among them: enough to say what to change,
// and quick however many hits a long message holds.
export const MAX_EXCERPTS = 20;

export function check(text: string, ctx: Context = {}): Report {
  const t = String(text ?? "");
  const on = new Set<Rule>(ctx.rules ?? RULES);
  // The machine rule reads code too, except in a reply to his own message (what he asked for).
  const seen = hidden(t), targetsOnly = hidden(t, ctx.answersHim ? "code" : true);
  const links = linkSpans(t);                        // found once, for every excerpt
  const found: Omit<Hit, "around">[] = [];
  const taken = new Map<Rule, Taken>();              // a rule's hits never overlap: the first found stays
  const add = (rule: Rule, result: Result, at: number, end: number, label?: string, kept?: Kept) => {
    let spans = taken.get(rule);
    if (!spans) taken.set(rule, spans = new Taken());
    if (!spans.take(at, end)) return;
    found.push({ rule, result, at, end, ...(label ? { label } : {}), ...(kept ? { kept } : {}) });
  };
  const edits: { at: number; end: number; put: string }[] = [];
  if (on.has("dash")) for (const e of dashes(t, seen, !!ctx.refusable, links)) {
    if (e.put === null) { add("dash", "refuse", e.at, e.end, undefined, e.kept); continue; }
    add("dash", "fix", e.at, e.end);
    edits.push({ at: e.at, end: e.end, put: e.put });
  }
  if (on.has("app")) for (const e of apps(seen)) { add("app", "fix", e.at, e.end); edits.push(e); }
  if (on.has("count")) for (const re of COUNTS) for (const m of seen.matchAll(re)) add("count", "refuse", m.index!, m.index! + m[0].length);
  if (on.has("machine")) {
    for (const [re, digits] of MACHINE) {
      if (digits && ctx.answersHim) continue;
      for (const m of targetsOnly.matchAll(re)) add("machine", "refuse", m.index!, m.index! + m[0].length);
    }
    for (const m of targetsOnly.matchAll(JOB)) if (/\d/.test(m[1])) add("machine", "refuse", m.index!, m.index! + m[0].length);
  }
  if (on.has("button")) {
    const has = ctx.buttons === null ? null : new Set(ctx.buttons ?? []);
    const labels = [...new Set([...STATIC_LABELS, ...(ctx.known ?? [])].map((l) => String(l).trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    const named_ = new Taken();
    for (const label of labels) for (const span of named(seen, label)) {
      if (!named_.take(span.at, span.end)) continue;
      if (has && has.has(label)) continue;
      add("button", has === null ? "unsure" : "refuse", span.at, span.end, label);
    }
  }
  found.sort((a, b) => a.at - b.at || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
  const kinds = new Set<string>();
  const hits: Hit[] = [];
  found.forEach((h, i) => {
    const kind = `${h.rule}|${h.result}|${h.kept ?? ""}|${h.label ?? ""}`;
    if (i < MAX_EXCERPTS || !kinds.has(kind))
      hits.push({ rule: h.rule, result: h.result, at: h.at, end: h.end, around: around(t, h.at, h.end, 60, links),
        ...(h.label ? { label: h.label } : {}), ...(h.kept ? { kept: h.kept } : {}) });
    kinds.add(kind);
  });
  // The fixes, in one pass.
  let fixed = "", i = 0;
  for (const e of edits.sort((a, b) => a.at - b.at)) { fixed += t.slice(i, e.at) + e.put; i = e.end; }
  return { hits, fixed: fixed + t.slice(i) };
}

// The one word for a report: refuse beats fix, fix beats unsure.
export function verdict(r: Report): "pass" | "fix" | "refuse" | "unsure" {
  if (r.hits.some((h) => h.result === "refuse")) return "refuse";
  if (r.hits.some((h) => h.result === "fix")) return "fix";
  return r.hits.some((h) => h.result === "unsure") ? "unsure" : "pass";
}

// Which rules each send point applies (the design's table). The specialist's cards get
// no machine rule: their numbers come from his calendar titles, and CI keeps the
// templates clean. Tap notes and the link's own words only get the two fixes. Cain's own
// words are checked as a writer the gate refuses (Context.refusable): every em dash in them
// is refused.
export const AT: Record<string, readonly Rule[]> = {
  cain: RULES,                                          // his replies and edits, asks, Ship cards, the morning message
  card: ["dash", "app", "count", "button"],             // the specialist's cards
  answer: ["dash", "app"],                              // the specialist's notes after a tap
  link: ["dash", "app"],                                // the link's own notices and lines
};

// What each rule asks of the writer, for the line that says why words were held back.
export const WHY: Record<Rule, string> = {
  dash: "no em dashes",
  app: "Home Assistant calls them Apps, not add-ons",
  count: "name each one instead of a count",
  machine: "no shas, job ids, ISO times or Discord ids; say it as people say it",
  button: "name only a button the message has",
};
// The same for one hit. An em dash of Cain's is refused, every one: what to put instead.
export const DASH_WHY = 'an em dash; rewrite it without one, using a comma or a new sentence for a break, "to" or "through" for a range';
// One kept in words that are never refused (flagged to Cain on a specialist's card): it
// isn't between plain words, so it may be a range; or a comma in its place would run into
// the link before it.
export const RANGE_WHY = "say it without the dash, as a range in words if it is one";
export const LINK_WHY = "say it without the dash; a comma there would run into the link";
export function whyOf(h: { rule: string; result?: string; kept?: string }): string {
  if (h.rule === "dash" && h.result === "refuse") return h.kept === "range" ? RANGE_WHY : h.kept === "link" ? LINK_WHY : DASH_WHY;
  return WHY[h.rule as Rule] ?? "a message rule";
}
// DASH_WHY, said once for several em dashes.
export const DASHES_WHY = 'em dashes; rewrite each without one, using a comma or a new sentence for a break, "to" or "through" for a range';

// Hits as parts of a line to the writer: each reason said once, after the excerpts it covers
// (each excerpt once, at most `each` of them), in the order the reasons first come.
export function reasonParts(hits: readonly { rule: string; result?: string; around: string; kept?: string }[], each = 3): string[] {
  const order: string[] = [];
  const quotes = new Map<string, { said: string[]; n: number }>();
  for (const h of hits) {
    const why = whyOf(h);
    let q = quotes.get(why);
    if (!q) { quotes.set(why, q = { said: [], n: 0 }); order.push(why); }
    q.n++;
    if (h.around && !q.said.includes(h.around)) q.said.push(h.around);
  }
  return order.map((why) => {
    const q = quotes.get(why)!;
    const reason = why === DASH_WHY && q.n > 1 ? DASHES_WHY : why;
    return each > 0 && q.said.length ? `${q.said.slice(0, each).map((a) => `"${a}"`).join(", ")}: ${reason}` : reason;
  });
}

// The fixable hits, as a few words: "no em dashes; Apps, not add-ons".
export function fixedWhat(hits: readonly Hit[]): string {
  const rules = RULES.filter((r) => hits.some((h) => h.result === "fix" && h.rule === r));
  return rules.map((r) => (r === "app" ? "Apps, not add-ons" : WHY[r])).join("; ");
}
