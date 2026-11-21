// The message gate's rules for Cain's words alone (piece D, Cain 0.11.0), on top of the
// shared ones in rules.ts. Pure, no I/O. They aren't in tests/message_rules.py: that port is
// for the calendar specialist's tests, and the specialist never writes these.
//
//   reviewed     a review claim (in his replies and edits, his asks and their options, the
//                morning message and the connector notice) goes only as the review service
//                gave it (../reviewed.ts), word for word: refuse, offering its newest lines;
//                "unsure" while those lines can't be read. A claim is a "Reviewed" heading
//                (then any spaces and ":" or "-", where it starts a sentence or a line),
//                "reviewed by" a seat, or a sentence with a verdict word and either a review
//                word or a seat's name ("All reviewers approved it", "Gemini approved the
//                release"), in any paragraph. The reply hook holds every one for good (no third
//                try lets it through), also while the lines can't be read: the way through is
//                leaving the claim out.
//   ship words   on a Ship card, his own line says only what Dane will notice: no CI, check,
//                test, build or pipeline words, and no review, verdict or seat words, at all.
//                The link adds the checks and the Reviewed line itself, so nothing he writes
//                there can stand in for them, however it's phrased. A few plain lines are
//                held too ("Check the red Stop"); he says them another way.
//   codes        a record code in his words: an item id his record has (P64), with a question
//                id right after it ("P08 Q2"). He can't tell what those are, so the thing is
//                named by what it does for him. Ids the record doesn't have and ordinary words
//                ("Q4 taxes", "vitamin D3", "a P100 filter") pass; with no record to read,
//                nothing is a code. Held for good (no third try lets one through): he asked
//                that none reach him, and the thing can always be named instead.
//   links        (Cain 0.13.0, his replies and edits) a link he couldn't judge by its look: its
//                host a bare IP address (also as one number or hex), punycode (a label that
//                starts "xn--") or letters outside plain ASCII, a link shortener's, or a link
//                carrying a user name or password before its host (user:pass@). Masked link
//                targets count: they're what a tap opens. Held for good (no third try): a plain
//                https link to the named site always says the same. Every hit is logged.
//                Second round: each link is parsed as a browser would (WHATWG URL) after the
//                tidying Discord does (<> and closing marks off, backslashes as slashes, a
//                percent-encoded host decoded), and held too when it isn't https, names a port
//                other than 443, has no scheme ("//host"), uses a scheme with no "//"
//                (javascript:, data:, file: and the like), or is a masked link whose visible
//                text is an address on another host. An https link to a host off LINK_HOSTS
//                (and the hosts added with keeper.sh link-host) is never held: it only gets a
//                notice-only line in the gate report, so the list grows from real use.
// The first three read the words as he'd see them, so nothing slips past by its spelling:
// compatibility forms folded (NFKC, full-width letters and digits too), invisible characters
// and combining marks dropped, Cyrillic and Greek letters that look like Latin ones read as
// those, markdown emphasis, quote marks and code marks dropped (code is read, not skipped).
// Links aren't words: a masked link reads as its words, a bare one not at all.
import type { Reviewed } from "../reviewed";
import { around, linkSpans } from "./rules";

export type CainRule = "reviewed" | "ship words" | "codes" | "links";
export const CAIN_RULES: readonly CainRule[] = ["reviewed", "ship words", "codes", "links"];
export interface CainHit { rule: CainRule; result: "refuse" | "unsure" | "note"; at: number; end: number; around: string }

// -- reading the words as he'd see them -----------------------------------------------------
// Invisible characters (zero-width, bidi controls, soft hyphens, joiners: Unicode's default
// ignorables) and combining marks left after NFKC composed what it could.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Mn}]/gu;
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

// links: "drop" (claims: a bare link isn't words) or "keep" (record codes: he sees a link's
// text, so a code in it shows).
export function claimText(text: string, links: "drop" | "keep" = "drop"): string {
  let t = String(text ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(LOOKALIKES, (c) => LOOKALIKE.get(c) ?? c);
  t = t.replace(/\]\([^)\s]*\)/g, "]");                         // [words](target): its words
  if (links === "drop") {
    let bare = "", i = 0;                                        // a bare link: not words
    for (const [a, b] of linkSpans(t)) { bare += `${t.slice(i, a)} `; i = b; }
    t = bare + t.slice(i);
  }
  return t.replace(/[*~`[\]]/g, "")                              // emphasis, code marks (the code is read), brackets
    .replace(/(^|[^A-Za-z0-9])_+|_+(?=[^A-Za-z0-9]|$)/g, "$1")   // _emphasis_, never an underscore inside a word
    .replace(DOUBLE_QUOTES, "").replace(SINGLE_QUOTES, "$1")
    .replace(/^[ \t]*>+[ \t]?/gm, "");                           // block quotes
}

// -- review claims ------------------------------------------------------------------------------
const WORD = (alts: string) => `(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`;
const SEATS = "openai|chatgpt|codex|gpt|gemini|perplexity|claude";
const VERDICTS = "approve|approved|approves|approving|approval|verdict|verdicts|reject|rejected|rejects|rejecting|signed\\s+off|sign[\\s-]off|lgtm"
  + "|greenlit|greenlighted|greenlight|green\\s+light|go-ahead|blessing|blessed|thumbs[\\s-]up";
const REVIEW_WORDS = "review|reviews|reviewed|reviewer|reviewers|reviewing";
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
// Every claim in words already read as he'd see them (claimText), in order: a "Reviewed"
// heading, "reviewed by" a seat, or a sentence with a verdict word and either a review word or
// a seat's name. Talk of an API's answer that names a seat and a verdict reads as one too: he
// says it without the verdict word ("Gemini's key stopped working").
function claimsIn(t: string): Claim[] {
  const out = headings(t);
  for (const [a, b] of sentences(t)) {
    const s = t.slice(a, b);
    if (BY_SEAT.test(s) || (VERDICT.test(s) && (REVIEW.test(s) || SEAT.test(s))))
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
// claim that isn't a line the service gave is a hit, once, with itself as its excerpt.
export function reviewedHits(text: string, published: readonly Reviewed[] | null | undefined): CainHit[] {
  const t = claimText(text);
  const heads = headings(t);
  if (!heads.length && !claimsIn(t).length) return [];
  let rest = t;
  if (published) {
    const real = new Set(published.map((p) => canon(claimText(p.line))));
    // A line the service gave is taken out; whatever claim is left, anywhere, is a hit.
    for (const c of heads) if (real.has(canon(c.said))) rest = rest.slice(0, c.at) + " ".repeat(c.end - c.at) + rest.slice(c.end);
  }
  const out: CainHit[] = [];
  for (const c of claimsIn(rest)) {
    if (out.some((h) => h.at < c.end && c.at < h.end)) continue;
    out.push({ rule: "reviewed", result: published ? "refuse" : "unsure", at: c.at, end: c.end, around: excerpt(rest.slice(c.at, c.end)) });
  }
  return out;
}

// -- ship words -----------------------------------------------------------------------------------
// On a Ship card, his line holds none of these words, however it's dressed: CI's words, the
// words of a status or a result ("GitHub says all jobs passed", "All validation stages
// passed", "green status"), and review, verdict and seat words. A closed list can't know
// every English way to claim a result, so his rules forbid the rest; this holds the forms
// that are natural to write.
const CI_WORDS = "ci|check|checks|checked|checking|test|tests|tested|testing|build|builds|pipeline|pipelines|workflow|workflows|pytest|lint";
const STATUS_WORDS = "github|job|jobs|stage|stages|status|validation|validated|verified|pass|passes|passed|passing|green|success|successful|successfully|succeeded|succeeds|fail|fails|failed|failing|failure|clean";
const SHIP_BANNED = new RegExp(WORD(`${CI_WORDS}|${STATUS_WORDS}|${REVIEW_WORDS}|${VERDICTS}|${SEATS}`), "gi");

export function shipWordsHits(text: string): CainHit[] {
  const t = claimText(text);
  const out: CainHit[] = [];
  for (const m of t.matchAll(SHIP_BANNED)) {
    const at = m.index!, end = at + m[0].length;
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
// Whether words could hold a record code at all, read as he'd see them, so the record is read
// only when they might.
export const mayHaveCode = (text: string): boolean => /P\d/i.test(claimText(text, "keep"));
export function codesHits(text: string, items: ReadonlySet<string> | null | undefined): CainHit[] {
  if (!items?.size) return [];
  const t = claimText(text, "keep");                             // code spans and a link's text show to him, so they're read
  const out: CainHit[] = [];
  for (const m of t.matchAll(CODE)) {
    if (!items.has(`P${Number(m[1])}`)) continue;
    const at = m.index!, end = at + m[0].length;
    out.push({ rule: "codes", result: "refuse", at, end, around: around(t, at, end) });
  }
  return out;
}

// -- links he can't judge by their look ------------------------------------------------------------
// Link shorteners: where they lead can't be seen. A host counts when it is one of these or under one.
export const SHORTENERS: readonly string[] = [
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "v.gd", "buff.ly", "rebrand.ly", "cutt.ly",
  "shorturl.at", "tiny.cc", "rb.gy", "lnkd.in", "s.id", "t.ly", "bl.ink", "short.io", "shorturl.com", "trib.al",
  "dlvr.it", "soo.gd", "clck.ru", "qr.ae", "tr.im", "x.co", "lc.chat", "tiny.one", "surl.li", "shorte.st", "adf.ly",
  "bc.vc", "ouo.io", "cli.re", "chilp.it", "u.to", "y2u.be", "aka.ms",
];
// Schemes with no "//" that a link can still carry (Cain 0.13.0, second round): held wherever they appear as a link.
const ODD_SCHEMES = "javascript|vbscript|data|file|blob|about|mailto|tel|sms|intent|view-source|filesystem|jar";
export type LinkWhy = "ip" | "punycode" | "shortener" | "userinfo" | "scheme" | "port" | "relative" | "masked";
// The hosts Cain normally cites (a link to one of these or under one is quiet; any other https host still
// goes, with a notice-only line in the gate report so the list can grow from real use). The owner's chief
// of staff extends it with keeper.sh link-host <host>; this is what the list holds before that.
export const LINK_HOSTS: readonly string[] = [
  "claude.ai", "claude.com", "anthropic.com", "github.com", "githubusercontent.com", "home-assistant.io", "intel.com",
  "healthchecks.io", "discord.com", "google.com", "microsoft.com", "apple.com", "wikipedia.org", "python.org", "bun.sh",
];
// The text of a link as Discord reads it: <> and the sentence's own closing marks off, backslashes read as slashes.
export function normalLink(link: string): string {
  return String(link ?? "").trim().replace(/^<|>$/g, "").replace(/[>)\].,;:!?'"]+$/g, "").replace(/\\/g, "/");
}
// The link parsed as a browser would (WHATWG URL), a link written without a scheme read as https. null: it
// doesn't parse.
export function parseLink(link: string): URL | null {
  const s = normalLink(link);
  if (/^\/\//.test(s)) return null;
  try { return new URL(/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(s) ? s : `https://${s}`); } catch { return null; }
}
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/\.+$/, "");
const under = (host: string, list: Iterable<string>) => { for (const d of list) if (host === d || host.endsWith(`.${d}`)) return true; return false; };
// Why a link is held, or null for one that passes. link: as found in the text (a link with no scheme is
// read as https: Discord doesn't make it a link, but he could still copy it).
export function linkProblem(link: string): LinkWhy | null {
  const s = normalLink(link);
  if (/^\/\//.test(s)) return "relative";
  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(s)?.[1]?.toLowerCase();
  if (scheme && !(scheme === "https" || scheme === "http") && !(/^\d+$/.test(s.slice(scheme.length + 1, scheme.length + 2)) && !/:\/\//.test(s))) return "scheme";
  // The raw authority, before the parser tidies it: a user name or password before the host.
  const auth = /^(?:[A-Za-z][A-Za-z0-9+.\-]*:)?\/*([^/?#]*)/.exec(s)?.[1] ?? "";
  if (auth.includes("@") || /%40/i.test(auth)) return "userinfo";
  const u = parseLink(s);
  if (!u) return "scheme";
  if (u.username || u.password) return "userinfo";
  const host = hostOf(u);
  if (!host || /^\[/.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return "ip";
  if (host.split(".").some((l) => l.startsWith("xn--")) || /[^\x00-\x7f]/.test(host)) return "punycode";
  if (under(host, SHORTENERS)) return "shortener";
  if (u.protocol !== "https:") return scheme ? "scheme" : null;
  if (u.port && u.port !== "443") return "port";
  return null;
}
const LINK_WORDS: Record<LinkWhy, string> = {
  ip: "a bare IP address", punycode: "a punycode or non-ASCII host", shortener: "a link shortener", userinfo: "a user name or password in it",
  scheme: "not an https link", port: "a port other than 443", relative: "a link with no scheme", masked: "link text naming another site",
};
// Every link in his words: bare and schemed links, the targets of masked links, scheme-relative ones and links
// in schemes with no "//". Each found once.
export interface LinkFound { at: number; end: number; link: string; shown?: string }
export function linksIn(text: string): LinkFound[] {
  // Backslashes read as slashes, as a browser reads them in a link ("https:\\host" is "https://host").
  const t = String(text ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\\/g, "/");
  const out: LinkFound[] = [];
  const add = (at: number, end: number, link: string, shown?: string) => {
    if (out.some((f) => f.at < end && at < f.end)) return;
    out.push({ at, end, link, ...(shown !== undefined ? { shown } : {}) });
  };
  for (const m of t.matchAll(/\[([^\]\n]{0,300})\]\(\s*(<[^>\n]*>|[^)\s]+)[^)\n]*\)/g)) {
    const at = m.index! + m[1].length + 3;
    add(at, at + m[2].length, m[2], m[1]);
  }
  // Scheme-relative and odd-scheme links before the plain ones, so "//host/x" isn't taken as "host/x".
  for (const m of t.matchAll(/(?<=^|[\s(<"'])\/\/[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+[^\s)>]*/g)) add(m.index!, m.index! + m[0].length, m[0]);
  for (const m of t.matchAll(new RegExp(`(?<![A-Za-z0-9+.\\-])(?:${ODD_SCHEMES}):[^\\s)>\\]]+`, "gi"))) add(m.index!, m.index! + m[0].length, m[0]);
  for (const [a, b] of linkSpans(t)) add(a, b, t.slice(a, b));
  return out.sort((x, y) => x.at - y.at);
}
// The one link detector (third round): the reply hook's hold, the gate's links rule and the after-post
// note (hooks/discord-sent.ts) all ask this, so nothing the gate would hold slips past the hook.
export const hasLink = (text: string): boolean => linksIn(text).length > 0;
// Whether a masked link's visible text is itself an address on another host than where the tap goes.
export function maskedElsewhere(shown: string, target: string): boolean {
  const v = normalLink(shown);
  if (/\s/.test(v) || !/^(?:[A-Za-z][A-Za-z0-9+.\-]*:\/\/)?(?:[A-Za-z0-9\-]+\.)+[A-Za-z]{2,}(?:[:/?#]|$)/.test(v)) return false;
  const a = parseLink(v), b = parseLink(target);
  if (!a || !b) return !!a;
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(hostOf(a)) !== strip(hostOf(b));
}
// The gate report's words for a link to a host off the list (third round): the list is the known hosts,
// noted not blocked, and a link to an unknown host is never held.
export const UNKNOWN_HOST = "unknown host (known hosts, noted not blocked)";
// The hits for his words: each held link ("refuse"), and each https link to a host off the list, a notice only
// ("note": logged, never held). hosts: the list (LINK_HOSTS and what was added); not given: notices off.
export function linksHits(text: string, hosts?: ReadonlySet<string> | readonly string[] | null): CainHit[] {
  const out: CainHit[] = [];
  for (const f of linksIn(text)) {
    const why = linkProblem(f.link) ?? (f.shown !== undefined && maskedElsewhere(f.shown, f.link) ? "masked" : null);
    if (why) { out.push({ rule: "links", result: "refuse", at: f.at, end: f.end, around: `${LINK_WORDS[why]}: ${f.link.slice(0, 60)}` }); continue; }
    const u = parseLink(f.link);
    if (hosts && u && !under(hostOf(u), hosts)) out.push({ rule: "links", result: "note", at: f.at, end: f.end, around: `${UNKNOWN_HOST}: ${hostOf(u).slice(0, 60)}` });
  }
  return out;
}
// The list as kept: LINK_HOSTS and one host a line from the file (# for notes), lower case.
export function readHostList(text: string | null): Set<string> {
  const set = new Set(LINK_HOSTS);
  for (const line of String(text ?? "").split("\n")) {
    const h = line.replace(/#.*/, "").trim().toLowerCase().replace(/\.+$/, "");
    if (/^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(h)) set.add(h);
  }
  return set;
}

// -- what each asks of him, for the line that says why his words were held back -----------------
export const LINKS_WHY = "a link he can't judge by its look (a bare IP address, a punycode host, a link shortener, a user name or password in it, anything but plain https on its usual port, or link text naming another site) is held: link to the named site itself, over https";
export const LINKS_KEEPER_WHY = "send links through the keeper: /opt/cain/keeper.sh reply [--reply-to <id>] \"<text>\" posts it with its preview off";
export const CODES_WHY = "name it by what it does for him, not by its record code: he can't tell what those are";
export const SHIP_WORDS_WHY = "on a Ship card your line says only what he'll notice: no checks, tests, builds, CI, GitHub, jobs or status, no results (passed, green, success, failed), and no reviews, verdicts or AI names, since the link adds those lines itself";
export const REVIEWED_UNSURE = "reviews can't be checked right now: leave the Reviewed line out, or send it in a minute";
// n: how many of the service's newest lines to offer (each with its review id).
export function reviewedWhy(published: readonly Reviewed[] | null | undefined, n = 3): string {
  const real = (published ?? []).slice(0, Math.max(1, n));
  const how = "a review's verdict goes only as the review service's line, word for word, or not at all, and a seat or a review with a verdict word (approved, rejected, signed off) counts as one, so say anything else without those words";
  return real.length ? `${how} (${real.map((p) => `review ${p.id}: "${p.line}"`).join("; ")})` : `${how}; the service has given no line yet`;
}
export function cainWhy(h: Pick<CainHit, "rule" | "result">, published?: readonly Reviewed[] | null, n = 3): string {
  if (h.rule === "ship words") return SHIP_WORDS_WHY;
  if (h.rule === "codes") return CODES_WHY;
  if (h.rule === "links") return LINKS_WHY;
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
