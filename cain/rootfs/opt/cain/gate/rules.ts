// The message gate's rules (piece D): what a message to Dane may not say, as plain
// code, no model and no I/O. Since Cain 0.10.0 they act: the reply hook
// (hooks/discord-send.ts) and the link's send points fix what's fixable and hold back
// what isn't (each send point's table is in DOCS.md and the link's core.ts), and the
// replay reads his DM with them. tests/message_rules.py is a port for the calendar
// specialist's tests, kept equal to this file by cain/tests/gate-cases.json.
//
//   dash     an em dash                    fix: ", " (removed at a line's start or end,
//                                          or before a stop; " to " only between two
//                                          clock times), never inside code or a link
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

// Up to n characters of the text around a hit, on one line.
export function around(text: string, at: number, end: number, n = 60): string {
  const pad = Math.max(0, Math.floor((n - Math.min(end - at, n)) / 2));
  let from = Math.max(0, at - pad);
  const to = Math.min(text.length, from + n);
  from = Math.max(0, to - n);
  return text.slice(from, to).replace(/\s+/g, " ").trim().slice(0, n);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// -- dash ----------------------------------------------------------------------------
// " to " only between two clock times: a dash between 9:30 and 10:15, 6 PM and 8 PM, or 6
// and 8 PM, where one side says it's a time (a colon, or AM or PM) and the other is a time
// or a bare hour. Any other pair of numbers (Room 4 and 5, a score of 3 and 2) gets ", ".
const MERIDIEM = "\\s?[AaPp]\\.?[Mm]\\.?";
const CLOCK_END = new RegExp(`(?<![\\d:.])(?:\\d{1,2}:\\d{2}(?:${MERIDIEM})?|\\d{1,2}${MERIDIEM})$`);
const HOUR_END = /(?<![\d:])(?<!\d[.,])\d{1,2}$/;               // not "1.5" or "2026"
const CLOCK_START = new RegExp(`^(?:\\d{1,2}:\\d{2}(?:${MERIDIEM})?|\\d{1,2}${MERIDIEM})(?![A-Za-z0-9:])`);
const HOUR_START = /^\d{1,2}(?![A-Za-z0-9:]|[.,]\d)/;
function clockRange(left: string, right: string): boolean {
  const l = CLOCK_END.test(left), r = CLOCK_START.test(right);
  return (l && (r || HOUR_START.test(right))) || (r && HOUR_END.test(left));
}

function dashes(text: string, seen: string): { at: number; end: number; put: string }[] {
  const out: { at: number; end: number; put: string }[] = [];
  for (const m of seen.matchAll(/[ \t]*—+[ \t]*/g)) {
    const at = m.index!, end = at + m[0].length;
    const before = at === 0 ? "\n" : text[at - 1], after = end >= text.length ? "\n" : text[end];
    let put = ", ";
    if (clockRange(text.slice(Math.max(0, at - 12), at), text.slice(end, end + 12))) put = " to ";   // 9:30 to 10:15
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
  if (on.has("dash")) for (const e of dashes(t, seen)) { add("dash", "fix", e.at, e.end); edits.push(e); }
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

// The fixable hits, as a few words: "no em dashes; Apps, not add-ons".
export function fixedWhat(hits: readonly Hit[]): string {
  const rules = RULES.filter((r) => hits.some((h) => h.result === "fix" && h.rule === r));
  return rules.map((r) => (r === "app" ? "Apps, not add-ons" : WHY[r])).join("; ");
}
