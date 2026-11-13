// The message gate's rules (piece D): what a message to Dane may not say, as plain
// code, no model and no I/O. In this release they only report: the reply hook
// (hooks/discord-send.ts), the link's send points and the replay log what each rule
// would have done, and nothing is refused or rewritten. tests/message_rules.py is a
// port for the calendar specialist's tests, kept equal to this file by
// cain/tests/gate-cases.json.
//
//   dash     an em dash                    fix: ", " (removed at a line's start or end,
//                                          or before a stop), never inside code or a link
//   app      "the add-on", "Cain's add-on", "Harness add-on", "Settings > Add-ons" and
//            the like (also "addon" and the specialist's escaped "add\-on"; plural and
//            possessive)                   fix: "App", "Apps", "App's". A bare "add-on"
//            (a browser add-on in a calendar title) is left alone.
//   count    "and 3 more", "and a few more", "+2 more", "(+2)", "4 more changes"
//                                          refuse: name each one
//   machine  a full commit sha, a cloud job id (cse_), an ISO date-time, a Discord id
//            (17 to 20 digits; passes in a reply to his own message), "job" and a hex id
//                                          refuse: say it as people say it
//   button   a known button label named as one ("tap Undo", "press Ship", "the Stop
//            button", "with Undo"), exact case, when the message (or the live card a
//            reply answers) doesn't have it        refuse; "unsure" when which buttons
//            are up can't be told
// Masked link targets are never visible text, so no rule reads them. An en dash is
// left alone: "9 – 11" would lose its meaning as "9, 11".

export const RULES = ["dash", "app", "count", "machine", "button"] as const;
export type Rule = (typeof RULES)[number];
export type Result = "fix" | "refuse" | "unsure";
export interface Hit { rule: Rule; result: Result; at: number; end: number; around: string; label?: string }
export interface Report { hits: Hit[]; fixed: string }
export interface Context {
  rules?: readonly Rule[];               // the rules this send point applies (default: all)
  buttons?: readonly string[] | null;    // labels on this message, or on the live card a reply answers;
                                         // null: which buttons are up can't be told
  known?: readonly string[];             // labels on live cards, on top of the static list
  answersHim?: boolean;                  // a reply to a message of his: a long number he asked for passes
}

// Both Apps' own button labels, so "Undo" is known as a button even when no card with
// Undo is up. Labels on live cards come on top (Context.known).
export const STATIC_LABELS: readonly string[] = [
  // Cain's link
  "Ship", "Not now", "Stop", "Turn back on", "Start", "Open connector settings",
  // the calendar specialist
  "Approve", "Decline", "Undo", "Undo both", "Undo these", "Use new", "Keep old", "Not mine", "Wrong time",
  "Just this once", "Yes", "No", "Depends", "All of it", "Part of it", "Skip", "Keep rule", "Drop rule",
  "Turn on", "None wrong: stop checking", "Something was off: keep checking",
];

const HIDE = "\u0000";   // a character no rule can match, put over what isn't visible text

// What isn't visible text, or isn't his words to judge, hidden in place (same length,
// new lines kept): masked link targets always; code and bare links unless only targets.
export function hidden(text: string, onlyTargets = false): string {
  const t = text.split("");
  const cover = (from: number, to: number) => { for (let i = from; i < to; i++) if (t[i] !== "\n") t[i] = HIDE; };
  const each = (re: RegExp, from = 0) => { for (const m of text.matchAll(re)) cover(m.index! + from, m.index! + m[0].length); };
  each(/\]\([^)\s]*\)/g, 1);                          // [words](target): the target
  if (!onlyTargets) {
    each(/```[\s\S]*?```/g);
    each(/`[^`\n]+`/g);
    each(/<?https?:\/\/[^\s<>()]+>?/g);
  }
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
function dashes(text: string, seen: string): { at: number; end: number; put: string }[] {
  const out: { at: number; end: number; put: string }[] = [];
  for (const m of seen.matchAll(/[ \t]*—+[ \t]*/g)) {
    const at = m.index!, end = at + m[0].length;
    const before = at === 0 ? "\n" : text[at - 1], after = end >= text.length ? "\n" : text[end];
    let put = ", ";
    if (before === "\n" || after === "\n" || /[,.;:!?)]/.test(after)) put = "";
    else if (/[,;:]/.test(before)) put = " ";
    out.push({ at, end, put });
  }
  return out;
}

// -- app -------------------------------------------------------------------------------
const OWNERS = "the|this|that|these|those|its|your|his|my|our|each|both|other|assistant|cain['’]s|cains|cain|harness['’]s|harness['’]|harness";
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
const ITEMS = "(?:changes|events|blocks|cards|items|messages|notes|places|questions|things|ones|appointments|receipts)";
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
function named(seen: string, label: string): { at: number; end: number }[] {
  const L = escapeRe(label);
  const forms = [
    new RegExp(`(?<![A-Za-z])${VERB}\\s+(?:(?:on\\s+)?the\\s+|on\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])`, "gd"),
    new RegExp(`(?<![A-Za-z0-9])${Q}(${L})${Q}\\s+[Bb]uttons?\\b`, "gd"),
    new RegExp(`(?<![A-Za-z])[Ww]ith\\s+(?:the\\s+)?${Q}(${L})${Q}(?![A-Za-z0-9])`, "gd"),
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
  const seen = hidden(t), targetsOnly = hidden(t, true);
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
