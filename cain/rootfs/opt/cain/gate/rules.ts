// The message gate's rules (piece D): what a message to Dane may not say, as plain
// code, no model and no I/O. Since Cain 0.10.0 they act: the reply hook
// (hooks/discord-send.ts) and the link's send points fix what's fixable and hold back
// what isn't (each send point's table is in DOCS.md and the link's core.ts), and the
// replay reads his DM with them. tests/message_rules.py is a port for the calendar
// specialist's tests, kept equal to this file by cain/tests/gate-cases.json.
//
//   dash     an em dash                    fix: ", " (removed at a line's start or end,
//                                          or before a stop), never " to ", and never
//                                          inside code or a link. One with a number right
//            on both sides (a digit, a clock time, a day or a month by name, noon or
//            midnight: "2026" and "2027", "6 PM" and "8", "Monday" and "Friday") could
//            be a range or a list: refuse, to be said without it (a writer that's never
//            refused keeps it as it is, flagged)
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
export interface Hit { rule: Rule; result: Result; at: number; end: number; around: string; label?: string }
export interface Report { hits: Hit[]; fixed: string }
export interface Context {
  rules?: readonly Rule[];               // the rules this send point applies (default: all)
  buttons?: readonly string[] | null;    // labels on this message, or on the live card a reply answers;
                                         // null: which buttons are up can't be told
  known?: readonly string[];             // labels on live cards, on top of the static list
  answersHim?: boolean;                  // a reply to a message of his: a long number he asked for, or code, passes
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
// gate's log, the safety net's note and lines for Cain.
export function around(text: string, at: number, end: number, n = 60): string {
  const pad = Math.max(0, Math.floor((n - Math.min(end - at, n)) / 2));
  let from = Math.max(0, at - pad);
  const to = Math.min(text.length, from + n);
  from = Math.max(0, to - n);
  return hostsOnly(text, from, to).replace(/\s+/g, " ").trim().slice(0, n);
}

// A link as its scheme and host alone, with "/…" when anything else was cut: never a user
// name, password, port, path, query or fragment ("https://github.com/…"). A link runs to the
// next space or angle bracket, parentheses included (a user name can hold them), and its
// scheme may be in any case. Its host is what follows the authority's last "@", less any
// port; one that isn't a plain name or address is "a link". Nothing after the host comes
// back, not even a sentence's own marks.
const LINK = /https?:\/\/[^\s<>]+/gi;
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?)(?::\d*)?$/;
export function linkHost(link: string): string {
  const m = /^(https?:\/\/)([^/?#]*)/i.exec(link);
  const auth = m?.[2] ?? "";
  const h = m ? HOST.exec(auth.slice(auth.lastIndexOf("@") + 1)) : null;
  if (!m || !h) return "a link";
  return `${m[1].toLowerCase()}${h[1].toLowerCase()}${link.length > m[1].length + h[1].length ? "/…" : ""}`;
}

// text[from, to) with each link as linkHost has it. A link that runs past either end of the
// window still comes out whole, as its host: never a piece of what follows the host.
export function hostsOnly(text: string, from = 0, to = text.length): string {
  const t = String(text ?? "");
  const stop = Math.min(to, t.length);
  let out = "", i = from;
  for (const m of t.matchAll(LINK)) {
    const a = m.index!, b = a + m[0].length;
    if (b <= i) continue;
    if (a >= stop) break;
    out += t.slice(i, Math.max(i, a)) + linkHost(m[0]);
    i = b;
  }
  return out + t.slice(i, Math.max(i, stop));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// -- dash ----------------------------------------------------------------------------
// An em dash is never read as "to": rewriting one into a range changed what messages said,
// round after round. One with a number right on both sides is held instead, since ", "
// could make a range a list and " to " a list a range. A number here is a digit; before the
// dash also a clock time ending in AM or PM, an ordinal or a percentage; after it also a
// currency sign and its digits; and on either side a day or a month by name (full or
// short, any case, with or without a period), noon or midnight: "2026" and "2027", "6 PM"
// and "8", "Monday" and "Friday", "Nov 12" and "Nov 14", "noon" and "1 PM". Every other em
// dash gets ", " or goes. The spaces around it, any but a new line (the Unicode ones too), go
// with it, and so does another dash with only spaces between.
const DASH = new RegExp("(?:[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*\\u2014+)+[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]*", "g");
const MERIDIEM = "\\s?[AaPp]\\.?[Mm]\\.?";
const CLOCK = `(?:\\d{1,2}:\\d{2}(?:${MERIDIEM})?|\\d{1,2}${MERIDIEM})`;
const NAMES = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|noon|midnight)\\.?";
// Past what can stand between a number and the dash: on the left, closing brackets, quotes,
// "!" and "."; on the right, opening brackets and quotes; on both, spaces, zero-width
// characters and a line break, so a dash at a line's end or start between numbers counts too.
const PAST_LEFT = "[)\\]}\"'\\u2018\\u2019\\u201c\\u201d!.\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff\\u200b-\\u200d\\u2060\\ufeff\\n\\r\\u2028\\u2029]*";
const PAST_RIGHT = "[(\\[{\"'\\u2018\\u2019\\u201c\\u201d\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff\\u200b-\\u200d\\u2060\\ufeff\\n\\r\\u2028\\u2029]*";
const NUMBER_BEFORE = new RegExp(`(?:\\d(?:st|nd|rd|th|%)?|(?<![\\d:.])${CLOCK}|(?<![A-Za-z])${NAMES})${PAST_LEFT}$`, "i");
const NUMBER_AFTER = new RegExp(`^${PAST_RIGHT}(?:[$€£]?\\d|${NAMES}(?![A-Za-z]))`, "i");

// Each em dash and what goes in its place; null: it stays, and the writer says it without it.
function dashes(text: string, seen: string): { at: number; end: number; put: string | null }[] {
  const out: { at: number; end: number; put: string | null }[] = [];
  for (const m of seen.matchAll(DASH)) {
    const at = m.index!, end = at + m[0].length;
    const before = at === 0 ? "\n" : text[at - 1], after = end >= text.length ? "\n" : text[end];
    let put: string | null = ", ";
    if (NUMBER_BEFORE.test(text.slice(0, at)) && NUMBER_AFTER.test(text.slice(end))) put = null;   // a range or a list
    else if (before === "\n" || after === "\n" || /[,.;:!?)]/.test(after)) put = "";
    else if (/[,;:]/.test(before)) put = " ";
    out.push({ at, end, put });
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
  for (const re of forms) for (const m of seen.matchAll(re)) {
    const [at, end] = m.indices![1];
    if (!out.some((x) => x.at === at)) out.push({ at, end });
  }
  return out;
}

const overlaps = (a: { at: number; end: number }, b: { at: number; end: number }) => a.at < b.end && b.at < a.end;

export function check(text: string, ctx: Context = {}): Report {
  const t = String(text ?? "");
  const on = new Set<Rule>(ctx.rules ?? RULES);
  // The machine rule reads code too, except in a reply to his own message (what he asked for).
  const seen = hidden(t), targetsOnly = hidden(t, ctx.answersHim ? "code" : true);
  const hits: Hit[] = [];
  const add = (rule: Rule, result: Result, at: number, end: number, label?: string) => {
    if (hits.some((h) => h.rule === rule && overlaps(h, { at, end }))) return;
    hits.push({ rule, result, at, end, around: around(t, at, end), ...(label ? { label } : {}) });
  };
  const edits: { at: number; end: number; put: string }[] = [];
  if (on.has("dash")) for (const e of dashes(t, seen)) {
    if (e.put === null) { add("dash", "refuse", e.at, e.end); continue; }
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
    const taken: { at: number; end: number }[] = [];
    for (const label of labels) for (const span of named(seen, label)) {
      if (taken.some((x) => overlaps(x, span))) continue;
      taken.push(span);
      if (has && has.has(label)) continue;
      add("button", has === null ? "unsure" : "refuse", span.at, span.end, label);
    }
  }
  hits.sort((a, b) => a.at - b.at || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
  let fixed = t;
  for (const e of edits.sort((a, b) => b.at - a.at)) fixed = fixed.slice(0, e.at) + e.put + fixed.slice(e.end);
  return { hits, fixed };
}

// The one word for a report: refuse beats fix, fix beats unsure.
export function verdict(r: Report): "pass" | "fix" | "refuse" | "unsure" {
  if (r.hits.some((h) => h.result === "refuse")) return "refuse";
  if (r.hits.some((h) => h.result === "fix")) return "fix";
  return r.hits.some((h) => h.result === "unsure") ? "unsure" : "pass";
}

// Which rules each send point applies (the design's table). The specialist's cards get
// no machine rule: their numbers come from his calendar titles, and CI keeps the
// templates clean. Tap notes and the link's own words only get the two fixes.
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
// The same for one hit: an em dash that's held stands between two numbers, times or dates,
// and may or may not be a range.
export const RANGE_WHY = "say it without the dash, as a range in words if it is one";
export function whyOf(h: { rule: string; result?: string }): string {
  if (h.rule === "dash" && h.result === "refuse") return RANGE_WHY;
  return WHY[h.rule as Rule] ?? "a message rule";
}

// The fixable hits, as a few words: "no em dashes; Apps, not add-ons".
export function fixedWhat(hits: readonly Hit[]): string {
  const rules = RULES.filter((r) => hits.some((h) => h.result === "fix" && h.rule === r));
  return rules.map((r) => (r === "app" ? "Apps, not add-ons" : WHY[r])).join("; ");
}
