// The exporter: reads the record's open list and writes a surface-safe, signed snapshot.
// Nothing here is written by an agent at display time: it only copies typed cells and
// drops what must never leave the house. It fails closed: no private terms, no snapshot.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ID,
  cutCodePoints,
  isIsoTime,
  isPlainObject,
  isRevision,
  PURPOSE_SNAPSHOT,
  REVISION_FIELDS,
  SIGNED_FIELDS,
  signedBytes,
  SNAPSHOT_VERSION,
  THREAD_FIELDS,
  toBase64,
} from "../shared/canonical";
import { STATES, WHO, type Signed, type Snapshot, type State, type Thread, type Who } from "../shared/snapshot";

export const TITLE_MAX = 140;
export const STEP_MAX = 200;

// --- the privacy policy -------------------------------------------------------------------

// Generic stems that leave a row out whole, each with its token-boundary rule (STEM_RULES below).
// The owner's config adds more (exclude_stems, each a prefix stem); it can't take these away.
//
// The two rules. Before a stem there is never a letter, digit or underscore (so "after" doesn't hold
// "er" and "define" doesn't hold "fine"). Then:
// - prefix: any word starting with the stem ("bank" catches "banking", "therap" catches "therapist");
// - word: the stem is the whole word, or the stem with one of its listed endings, with no letter,
//   digit or underscore after ("lab" catches "lab" and "labs", never "label" or "labor").
// A stem of two words ("urgent care") matches any run of spaces between them.
export type StemRule = { stem: string; mode: "prefix" } | { stem: string; mode: "word"; endings: string[] };
const prefix = (...stems: string[]): StemRule[] => stems.map((stem) => ({ stem, mode: "prefix" }));
const word = (stem: string, ...endings: string[]): StemRule => ({ stem, mode: "word", endings });
export const STEM_RULES: readonly StemRule[] = [
  ...prefix("money", "financ", "debt", "bank", "budget", "paid", "owed", "invoice", "rent", "loan", "mortgage", "credit"),
  ...prefix("salar", "insur", "refund", "health", "therap", "doctor", "appointment", "hospital", "surgery", "mental"),
  ...prefix("psychiatr", "dentist", "dental", "orthodont", "periodont", "endodont", "denture", "tooth", "teeth"),
  ...prefix("prescri", "clinic", "pharmac", "medic", "diagnos", "bill", "price", "quote", "deposit", "venmo"),
  ...prefix("symptom", "vaccin", "pregnan", "allerg", "counsel", "refill", "biopsy", "chemo", "cancer", "rehab"),
  ...prefix("physio", "results", "urgent care", "injur", "zelle", "cheque", "tuition", "blood", "dosag", "cardiol", "ptsd"),
  word("pay", "s", "ing", "ment", "ments", "ee", "er", "roll", "check", "checks", "pal", "able", "out", "day", "slip"),
  word("irs"), word("pt"), word("gp", "s"), word("mri", "s"), word("er"), word("rx"), word("meds"),
  word("tax", "es", "ed", "ing", "able", "ation"), word("card", "s"), word("fee", "s"), word("cost", "s", "ing", "ly"),
  word("cash", "ed", "es", "ing", "back"), word("owe", "s", "d"), word("owing"), word("scan", "s", "ned", "ning", "ner"),
  word("pill", "s"), word("dose", "s", "d"), word("sick", "ness", "er", "est", "ly"),
  word("lab", "s", "work"), word("fine", "s", "d"), word("check", "s", "ed", "ing", "book", "books", "up", "ups"),
  word("wire", "s", "d"), word("ticket", "s", "ed", "ing"),
];
// The stems alone, in the order above.
export const DEFAULT_STEMS: readonly string[] = STEM_RULES.map((r) => r.stem);

// --- one normal form ----------------------------------------------------------------------

// Every check reads text in one form: NFKC (so a full-width or styled letter is the plain one)
// with the invisible formatting characters taken out (zero-width spaces and joiners, bidi
// controls, soft hyphens: Unicode's format class). The strippers and the name replacement run on
// this same text, and it is what is exported.
const INVISIBLE = /\p{Cf}/gu;
export function normalise(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

// For matching only: the normal form, case-folded, with accents taken off, so "Jünîper" is
// matched by the term "Juniper" and "MÓRGAN" by the name "Morgan".
export function fold(text: string): string {
  return normalise(text).normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
}

// Money in any form leaves the row out: a currency symbol anywhere, an ISO currency code next to
// a number ("USD 40", "40 EUR"), or a number with a currency word ("40 dollars", "5 quid").
const CURRENCY_SYMBOL = /\p{Sc}/u;
const ISO_CODES =
  "USD|EUR|GBP|AUD|NZD|CAD|JPY|CHF|CNY|RMB|HKD|SGD|INR|SEK|NOK|DKK|ISK|PLN|CZK|HUF|RON|BGN|ZAR|BRL|MXN|KRW|TRY|RUB|UAH|ILS|AED|SAR|QAR|THB|IDR|MYR|PHP|VND|TWD|ARS|CLP|COP|PEN|NGN|KES|EGP|PKR|BDT|BTC|ETH|USDT|USDC";
const ISO_AMOUNT = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${ISO_CODES})\\s?\\d|\\d\\s?(?:${ISO_CODES})(?![\\p{L}\\p{N}_])`,
  "u",
);
const NUMBER = String.raw`(?:\d[\d,.]*|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|few|couple of)`;
const CURRENCY_WORD = String.raw`(?:dollars?|bucks?|euros?|pounds?|quid|cents?|pence|penny|pennies|yen|yuan|renminbi|rupees?|francs?|kron(?:a|or|e|er)|zloty|pesos?|rand|reais|grand|sterling)`;
const AMOUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${NUMBER}\s*(?:k|m|bn|hundred|thousand|million|billion)?\s*${CURRENCY_WORD}(?![\p{L}\p{N}_])`,
  "u",
);
// A run of four or more digits that is not part of a date (YYYY-MM-DD, M/D/YYYY, or a year alone,
// 1900 to 2099) leaves the row out: a card's last four, an account or a reference number. A record
// code (one to three letters then digits, like P1040) is not such a run.
const DATE_ISO = /(?<!\p{Nd})\d{4}-\d{2}-\d{2}(?!\p{Nd})/gu;
const DATE_SLASH = /(?<!\p{Nd})\d{1,2}\/\d{1,2}\/\d{4}(?!\p{Nd})/gu;
const CODE_TOKEN = /(?<![\p{L}\p{N}_])\p{L}{1,3}\p{Nd}{1,5}(?![\p{L}\p{N}_])/gu;
const DIGIT_RUN = /\p{Nd}{4,}/gu;
export function namesLongNumber(text: string): boolean {
  const t = normalise(text).replace(DATE_ISO, " ").replace(DATE_SLASH, " ").replace(CODE_TOKEN, " ");
  for (const m of t.matchAll(DIGIT_RUN)) {
    const run = m[0];
    const year = /^\d{4}$/.test(run) && Number(run) >= 1900 && Number(run) <= 2099;
    if (!year) return true;
  }
  return false;
}

// The common currency codes in lower case too ("40 usd", "eur 12"); the rest only in capitals, since
// several are words in lower case ("try 3", "php 8").
const ISO_LOWER = "usd|eur|gbp|aud|nzd|cad|chf|jpy|inr|btc|eth";
const ISO_AMOUNT_LOWER = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${ISO_LOWER})\\s?\\d|\\d\\s?(?:${ISO_LOWER})(?![\\p{L}\\p{N}_])`,
  "u",
);
export function namesMoney(text: string): boolean {
  const n = normalise(text);
  const f = fold(text);
  return CURRENCY_SYMBOL.test(n) || ISO_AMOUNT.test(n) || ISO_AMOUNT_LOWER.test(f) || AMOUNT.test(f);
}

// Account shapes leave the row out: an IBAN (two capitals, two check digits, then groups of letters
// and digits, spaced or not, with at least six digits in all), a card number (13 to 19 digits, single
// spaces or hyphens allowed between them), a UK sort code (12-34-56), and the words that name an
// account number (acct, a/c, IBAN, BSB, ABA, routing number, sort code, account no or number).
const IBAN = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;
const CARD = /(?<![\p{N}])\d(?:[ -]?\d){12,18}(?![\p{N}])/u;
const SORT_CODE = /(?<![\p{N}-])\d{2}-\d{2}-\d{2}(?![\p{N}-])/u;
const ACCOUNT_WORD = /(?<![\p{L}\p{N}_])(?:acct|a\/c|iban|bsb|aba|routing\s+(?:no|num|number)|sort\s+code|account\s+(?:no|num|number|#))(?![\p{L}\p{N}_])/iu;
export function namesAccount(text: string): boolean {
  const n = normalise(text);
  for (const m of n.matchAll(IBAN)) if ((m[0].match(/\d/g) ?? []).length >= 6) return true;
  return CARD.test(n) || SORT_CODE.test(n) || ACCOUNT_WORD.test(fold(text));
}

// Who the owner is called in the record. The code knows only the role word; the owner's own
// name comes from config (owner_names).
export const DEFAULT_OWNER_NAMES = ["owner", "the owner"];

// Capitalised words that may stay in an exported text (see properNounGate): the bundled common
// English words (common-words.txt: function words, pronouns, common verbs, weekdays and months, no
// names) and these. The owner's config adds product and place words (allow_words).
export const DEFAULT_ALLOW_WORDS = ["I", "OK"];
// Months and weekdays: a capitalised one stays only next to a number or a date ("May 5", "on 3 June",
// "Friday 2026-11-20"), since several are names too (May, June, April, August).
export const CALENDAR_WORDS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];
// The words the exported text itself puts in: the name and identifier replacements.
const OUTPUT_WORDS = ["you", "your", "someone", "someone's", "link", "email", "address", "phone", "number", "item"];
export function parseWordList(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
// Words that are also given names or surnames (name-words.txt): never on the common list, whatever
// common-words.txt says, so a capitalised one is gated like any name. Its [common] section is the
// ones that are ordinary words too: known in lower case. Its [names] section is unknown in lower case.
export function parseNameWords(text: string): { all: Set<string>; common: Set<string> } {
  const all = new Set<string>();
  const common = new Set<string>();
  let section = "";
  for (const line of parseWordList(text)) {
    const m = /^\[(names|common)\]$/.exec(line);
    if (m) {
      section = m[1];
      continue;
    }
    if (!section) throw new Error("name-words.txt: a word before the first [names] or [common] line");
    for (const w of line.split(/\s+/).filter(Boolean)) {
      all.add(w);
      if (section === "common") common.add(w);
    }
  }
  return { all, common };
}
const NAME_LISTS = parseNameWords(readFileSync(join(import.meta.dir, "name-words.txt"), "utf8"));
export const NAME_WORDS: ReadonlySet<string> = NAME_LISTS.all;
export const NAME_WORDS_COMMON: ReadonlySet<string> = NAME_LISTS.common;
export const COMMON_WORDS_FILE: readonly string[] = parseWordList(readFileSync(join(import.meta.dir, "common-words.txt"), "utf8")).flatMap(
  (l) => l.split(/\s+/).filter(Boolean),
);
export const COMMON_WORDS: readonly string[] = COMMON_WORDS_FILE.filter(
  (w) => !NAME_WORDS.has(w.toLowerCase()) && !CALENDAR_WORDS.includes(w.toLowerCase()),
);
// Abbreviations with full stops the gate reads as one word: times of day.
const DOTTED_WORDS = ["a.m.", "p.m."];

export interface Policy {
  terms: RegExp[];
  stems: RegExp;
  // Every word that classifies a row as the owner's: the role words and the configured names.
  owners: string[];
  // The owner's configured names only, replaced by "you" in every exported text.
  ownerNames: string[];
  // Other people's names (config `names`), replaced by "someone" in every exported text.
  names: string[];
  // The only areas exported (config `areas`), folded; any other is "other".
  areas: string[];
  // Capitalised words that may stay (COMMON_WORDS, DEFAULT_ALLOW_WORDS and config `allow_words`), folded.
  allowWords: Set<string>;
  // Every word a lower-case or uncased token may be without being listed as unknown: the allow
  // words, the months and weekdays, name-words.txt's [common] section, and the words the exporter
  // itself puts in. Folded.
  vocabulary: Set<string>;
}

export interface ExporterConfig {
  owner_names?: string[];
  names?: string[];
  exclude_stems?: string[];
  areas?: string[];
  allow_words?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole word, Unicode-aware: no letter, digit or underscore on either side.
const wholeWord = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, "iu");

// A re: term that could backtrack without bound is refused at load: a quantified group that
// itself holds a quantifier ("(a+)+", "(\w*x)*"), or a backreference. Returns a reason, or null.
export function riskyPattern(body: string): string | null {
  if (/\\(?:[1-9]|k<)/.test(body)) return "a backreference";
  // One frame per open group: whether a quantifier (*, + or {n,...}) or an alternation is inside it.
  type Frame = { quant: boolean; alt: boolean };
  const stack: Frame[] = [{ quant: false, alt: false }];
  const top = () => stack[stack.length - 1];
  const quantAt = (i: number) => body[i] === "*" || body[i] === "+" || (body[i] === "{" && /^\{\d*,?\d*\}/.test(body.slice(i)));
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      // Skip the class, escapes included.
      for (i++; i < body.length && body[i] !== "]"; i++) if (body[i] === "\\") i++;
      continue;
    }
    if (c === "(") stack.push({ quant: false, alt: false });
    else if (c === "|") top().alt = true;
    else if (c === ")") {
      const inner = stack.length > 1 ? stack.pop()! : { quant: false, alt: false };
      if (quantAt(i + 1)) {
        if (inner.quant) return "a quantifier inside a quantified group";
        if (inner.alt) return "an alternation inside a quantified group";
      }
      if (inner.quant || quantAt(i + 1)) top().quant = true;
    } else if (quantAt(i)) top().quant = true;
  }
  return null;
}

// The owner's private terms file: one term a line, `re:` for a regular expression, `#` for a
// note line. Every term matches case-insensitive and as a whole word, and is compiled here, at
// load. A file with no terms, or a term that doesn't compile or could backtrack without bound,
// is refused (by line number, never the term): the exporter fails closed.
export function parseTerms(text: string, where = "the private terms file"): RegExp[] {
  return parseTermList(text, where).terms;
}

// The terms. A plain term longer than PLAIN_TERM_MAX characters is refused (no record cell is that
// long and still exported: cells are capped at MATCH_SPAN).
export const PLAIN_TERM_MAX = 2000;
export function parseTermList(text: string, where = "the private terms file"): { terms: RegExp[] } {
  const terms: RegExp[] = [];
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    if (t.startsWith("re:")) {
      const body = t.slice(3).trim();
      if (!body) throw new Error(`${where}:${i + 1}: an empty re: term`);
      let re: RegExp;
      try {
        // The body alone first: wrapped, "[x" or "a)|(b" could compile into something else.
        new RegExp(body, "iu");
        re = wholeWord(body);
      } catch {
        throw new Error(`${where}:${i + 1}: not a valid regular expression`);
      }
      const risky = riskyPattern(body);
      if (risky) throw new Error(`${where}:${i + 1}: a regular expression with ${risky} (it could run without bound)`);
      terms.push(re);
    } else {
      // The term as written, and folded when that differs (an accented term matches plain text).
      const len = Math.max(t.length, fold(t).length);
      if (len > PLAIN_TERM_MAX) throw new Error(`${where}:${i + 1}: a term longer than ${PLAIN_TERM_MAX} characters`);
      terms.push(wholeWord(escapeRe(t)));
      if (fold(t) !== t.toLowerCase()) terms.push(wholeWord(escapeRe(fold(t))));
    }
  });
  if (!terms.length) throw new Error(`${where} has no terms, so nothing is exported`);
  return { terms };
}

const list = (v: unknown, name: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`config: ${name} must be a list of words`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
};
const envList = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// The config: a JSON file (--config) and/or SURFACE_OWNER_NAMES, SURFACE_NAMES and
// SURFACE_EXCLUDE_STEMS (comma-separated). Both add to the generic defaults.
export function makePolicy(termsText: string, config: ExporterConfig = {}, env: Record<string, string | undefined> = {}): Policy {
  const extra = [...list(config.exclude_stems, "exclude_stems"), ...envList(env.SURFACE_EXCLUDE_STEMS)];
  // The role words are never name parts ("the" would otherwise become "you" everywhere).
  const ownerNames = [...list(config.owner_names, "owner_names"), ...envList(env.SURFACE_OWNER_NAMES)].filter(
    (n) => !DEFAULT_OWNER_NAMES.includes(fold(n)),
  );
  const names = [...list(config.names, "names"), ...envList(env.SURFACE_NAMES)];
  const areas = list(config.areas, "areas").map(fold);
  const allow = [...COMMON_WORDS, ...DEFAULT_ALLOW_WORDS, ...DOTTED_WORDS, ...list(config.allow_words, "allow_words")].map(fold);
  const { terms } = parseTermList(termsText);
  return {
    terms,
    stems: stemPattern([...STEM_RULES, ...extra.map((stem): StemRule => ({ stem, mode: "prefix" }))]),
    owners: [...DEFAULT_OWNER_NAMES, ...ownerNames].map(fold),
    ownerNames,
    names,
    areas,
    allowWords: new Set(allow),
    vocabulary: new Set([...allow, ...CALENDAR_WORDS, ...OUTPUT_WORDS, ...NAME_WORDS_COMMON]),
  };
}

// The stems' one pattern, each by its rule (STEM_RULES above), matched on the folded text. A stem of
// more than one word matches any run of spaces between its words.
export function stemPattern(rules: readonly StemRule[]): RegExp {
  const body = (x: string) => fold(x).split(/\s+/).map(escapeRe).join("\\s+");
  const alts = rules.map((r) =>
    r.mode === "prefix"
      ? body(r.stem)
      : `${body(r.stem)}(?:${r.endings.map(escapeRe).join("|")})?(?![\\p{L}\\p{N}_])`,
  );
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.map((a) => `(?:${a})`).join("|")})`, "iu");
}

// The config's own checks, before anything is read, written or sent. Returns a one-line reason,
// or null. The owner must be named for real (the role words alone don't count), and `names` must
// be there (an empty list is allowed: no one else is named in the record).
export function configProblem(config: unknown, env: Record<string, string | undefined> = {}): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "the config is not a JSON object";
  const c = config as ExporterConfig;
  try {
    for (const k of ["owner_names", "names", "exclude_stems", "areas", "allow_words"] as const) list(c[k], k);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  if (!("names" in c)) return 'config: "names" is missing (an empty list is allowed)';
  // The areas are the fixed list area names come from: plain folder words only.
  if (list(c.areas, "areas").some((a) => !/^[a-z0-9][a-z0-9_-]*$/.test(fold(a)) || fold(a) === "other"))
    return "config: an area must be a plain folder name (letters, digits, - or _), and not \"other\"";
  const owners = [...list(c.owner_names, "owner_names"), ...envList(env.SURFACE_OWNER_NAMES)].filter(
    (n) => !DEFAULT_OWNER_NAMES.includes(fold(n)),
  );
  if (!owners.length) return "config: no owner name (owner_names, or SURFACE_OWNER_NAMES); the role words alone don't count";
  return null;
}

// A word, with any parts joined to it by a hyphen or an apostrophe ("Vale-Smith", "O'Neill",
// "Robin's"): one token, so a name joined to another word goes whole.
const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:[-'\u2019][\p{L}\p{M}\p{N}_]+)*/gu;
const partsOf = (names: string[]) =>
  new Set(names.flatMap((n) => fold(n).split(/[\s\-'\u2019]+/)).filter(Boolean));

// Names never leave. After a row is classified, each part of a configured name (first, last) is
// replaced on its own, whole word, any case and any accent: the owner's become "you" ("your" for
// "<name>'s"), everyone else's "someone" ("someone's"). A word joined to a name part by a hyphen
// or an apostrophe goes with it, so a double name is one "someone", never "someone-X"; a full
// name written out ("Morgan Vale") is one "someone" too. A name inside a longer word is left.
export function replaceNames(text: string, policy: Pick<Policy, "ownerNames" | "names">): string {
  const owner = partsOf(policy.ownerNames);
  const other = partsOf(policy.names);
  // Placeholders first, so the runs of a full name can be joined.
  const [YOU, YOUR, SOME, SOMES] = ["\u0001", "\u0002", "\u0003", "\u0004"];
  const out = text.replace(/[\u0001-\u0004]/g, "").replace(TOKEN, (tok) => {
    let parts = tok.split(/[-'\u2019]/);
    let poss = false;
    if (parts.length > 1 && /['\u2019][sS]$/.test(tok)) {
      parts = parts.slice(0, -1);
      poss = true;
    }
    const f = parts.map(fold);
    if (f.some((p) => other.has(p))) return poss ? SOMES : SOME;
    if (f.some((p) => owner.has(p))) return poss ? YOUR : YOU;
    return tok;
  });
  return out
    .replace(/\u0003(?:\s+\u0003)*(?:\s+\u0004)?|\u0004/g, (m) => (m.endsWith(SOMES) ? "someone's" : "someone"))
    .replace(/\u0001(?:\s+\u0001)*(?:\s+\u0002)?|\u0002/g, (m) => (m.endsWith(YOUR) ? "your" : "you"));
}

// --- the gate's words ------------------------------------------------------------------------

// The gate's tokens: runs of Unicode letters (with their combining marks), joined by an apostrophe or
// a hyphen ("O'Neill", "Vale-Smith", "don't"), or a run of initials ("J.R.R.", "a.m."). Digits,
// underscores and every other character split tokens.
const GATE_TOKEN = /(?:\p{L}\.){2,}|\p{L}[\p{L}\p{M}]*(?:['\u2019-]\p{L}[\p{L}\p{M}]*)*/gu;
// Apostrophe forms taken off before a lookup: the possessive ('s, and a bare ' after s), and the
// contractions 'd, 'll, 're, 've, 'm and n't.
const CONTRACTED: Record<string, string> = { "can't": "can", "won't": "will", "shan't": "shall", "ain't": "am" };

export interface GateToken {
  text: string;
  at: number;
  end: number;
  // Starts with a capital (an all-caps word included).
  capital: boolean;
  // A possessive ('s, or ' after s).
  possessive: boolean;
  // A run of initials, or one capital letter on its own.
  initials: boolean;
  // A letter run that touches a digit ("v2", "x86"): a code, not a word.
  touchesDigit: boolean;
  // The forms looked up, folded: the token, then without its possessive or contraction.
  forms: string[];
}

export function gateTokens(text: string): GateToken[] {
  const out: GateToken[] = [];
  for (const m of text.matchAll(GATE_TOKEN)) {
    const tok = m[0];
    const at = m.index!;
    const end = at + tok.length;
    const f = fold(tok).replace(/\u2019/g, "'");
    const forms = [f];
    let possessive = false;
    if (CONTRACTED[f]) forms.push(CONTRACTED[f]);
    else if (/'s$/.test(f)) {
      forms.push(f.slice(0, -2));
      possessive = true;
    } else if (/s'$/.test(f)) {
      forms.push(f.slice(0, -1));
      possessive = true;
    } else if (/n't$/.test(f)) forms.push(f.slice(0, -3));
    else if (/'(?:d|ll|re|ve|m)$/.test(f)) forms.push(f.replace(/'(?:d|ll|re|ve|m)$/, ""));
    // A bare trailing apostrophe after s ("James' car") was not taken by the token pattern: it is
    // taken here, so the whole possessive is replaced.
    let stop = end;
    if (!possessive && /s$/i.test(tok) && /^['\u2019](?![\p{L}])/u.test(text.slice(end))) {
      possessive = true;
      stop = end + 1;
    }
    out.push({
      text: text.slice(at, stop),
      at,
      end: stop,
      capital: /^\p{Lu}/u.test(tok),
      possessive,
      initials: /^(?:\p{L}\.){2,}$/u.test(tok) || /^\p{Lu}$/u.test(tok),
      touchesDigit: /\p{N}/u.test(text[at - 1] ?? "") || /\p{N}/u.test(text[end] ?? ""),
      forms,
    });
  }
  return out;
}

// A word is known when any of its forms, or every part of its hyphenated form, is in the set.
function knownIn(t: GateToken, set: Set<string>): boolean {
  if (t.forms.some((f) => set.has(f))) return true;
  const last = t.forms[t.forms.length - 1];
  const parts = last.split("-");
  return parts.length > 1 && parts.every((p) => set.has(p));
}

// Titles before a name, and words that put a person after them: a month or weekday after one of
// these is a name, whatever number follows ("ask May 5 questions", "Mr. June 3").
export const HONORIFICS = ["mr", "mrs", "ms", "mx", "miss", "dr", "prof", "sir", "dame"];
export const PERSON_CUES = [
  "ask", "asks", "asked", "tell", "tells", "told", "call", "calls", "called", "text", "texts", "texted",
  "email", "emails", "emailed", "message", "messaged", "ping", "pinged", "meet", "meets", "met", "thank",
  "thanks", "remind", "reminded", "with", "from", "dear", "hi", "hey", "cc",
];

// The proper-noun gate: in an exported text, every capitalised word (an all-caps one included), at
// the start of a sentence or not, becomes "someone" (its possessive "someone's") unless it is on the
// allow list (the bundled common words, DEFAULT_ALLOW_WORDS and config allow_words), looked up with
// its possessive or contraction taken off. A hyphenated word stays only when the whole of it, or each
// part, is on the list. A run of initials ("J.R.R.") is one word, and a lone capital other than "I"
// and "A" is an initial. A month or weekday stays only next to a number or a date, and only when no
// other name signal is there: a possessive, a title or a person cue before it, or a gated or
// replaced name next to it. It runs on the case-preserved normal form; a lower-case or uncased name
// is caught only by the names list, the terms file and the unknown-word check. Returns the text and
// the words it replaced.
export function properNounGate(text: string, allow: Set<string>): { text: string; words: string[] } {
  const tokens = gateTokens(text);
  // First every word but the months and weekdays, then those, which read their neighbours.
  const gated = tokens.map((t) => {
    if (!t.capital) return false;
    if (knownIn(t, allow)) return false;
    if (t.initials) return true;
    if (!t.possessive && CALENDAR_WORDS.includes(t.forms[t.forms.length - 1])) return null;
    return true;
  });
  tokens.forEach((t, i) => {
    if (gated[i] !== null) return;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const near = (o: GateToken | undefined, j: number) =>
      !!o && (gated[j] === true || o.forms.some((f) => f === "someone" || f === "someone's"));
    const signal =
      (!!prev && (HONORIFICS.includes(prev.forms[0]) || PERSON_CUES.includes(prev.forms[0]))) ||
      near(prev, i - 1) || near(next, i + 1);
    gated[i] = signal || !nextToNumber(text, t.at, t.text.length);
  });
  const words: string[] = [];
  let out = "";
  let last = 0;
  tokens.forEach((t, i) => {
    if (!gated[i]) return;
    words.push(t.text);
    out += text.slice(last, t.at) + (t.possessive ? "someone's" : "someone");
    last = t.end;
  });
  return { text: out + text.slice(last), words };
}

// A number or a date right before ("3 May", "the 3rd of May", "2026-11-20, Friday") or right after
// ("May 5", "June 2026", "Friday, the 20th") a word at text[at, at + len).
export function nextToNumber(text: string, at: number, len: number): boolean {
  const before = text.slice(Math.max(0, at - 40), at);
  const after = text.slice(at + len, at + len + 40);
  return /\p{Nd}(?:st|nd|rd|th)?(?:\s+of)?[\s,]*$/iu.test(before) || /^[\s,]*(?:the\s+)?\p{Nd}/iu.test(after);
}

// The plain forms a lower-case word may be an inflection of, for the unknown-word check only (never
// for the capitalised allow list): "brings" is "bring", "carried" is "carry", "fixing" is "fix",
// "stopped" is "stop".
export function inflections(w: string): string[] {
  const out: string[] = [];
  const add = (x: string) => x.length >= 2 && out.push(x);
  if (/ies$/.test(w)) add(w.slice(0, -3) + "y");
  if (/ied$/.test(w)) add(w.slice(0, -3) + "y");
  if (/es$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ed$/.test(w)) add(w.slice(0, -2)), add(w.slice(0, -1));
  if (/ing$/.test(w)) add(w.slice(0, -3)), add(w.slice(0, -3) + "e");
  if (/([b-df-hj-np-tv-z])\1(?:ed|ing)$/.test(w)) add(w.replace(/([b-df-hj-np-tv-z])\1(?:ed|ing)$/, "$1"));
  return out;
}

// What the unknown-word check found in a text: words not in the vocabulary (lower-case or uncased,
// looked up with their possessive or contraction taken off; under --strict any of them fails the run,
// in every field), and words known only as name-words.txt's [common] words (reported, not a failure).
export function unknownTokens(text: string, vocabulary: Set<string>): string[] {
  return wordCheck(text, vocabulary).unknown;
}
export function wordCheck(text: string, vocabulary: Set<string>): { unknown: string[]; nameLike: string[] } {
  const unknown: string[] = [];
  const nameLike: string[] = [];
  for (const t of gateTokens(text)) {
    if (t.capital || t.touchesDigit) continue;
    if (!knownIn(t, vocabulary) && !inflections(t.forms[t.forms.length - 1]).some((f) => vocabulary.has(f))) unknown.push(t.text);
    else if (t.forms.some((f) => NAME_WORDS_COMMON.has(f))) nameLike.push(t.text);
  }
  return { unknown, nameLike };
}

// The private marker: a `#private` tag anywhere in the row, or a Private column whose cell is
// yes, y, true, x or private. It is final: such a row never exports.
const PRIVATE_TAG = /(?<![\p{L}\p{N}_])#private(?![\p{L}\p{N}_])/iu;
export function markedPrivate(cells: Record<string, string>, raw: string): boolean {
  if (PRIVATE_TAG.test(raw)) return true;
  const col = (cells["private"] ?? "").trim().toLowerCase();
  return ["yes", "y", "true", "x", "private"].includes(col);
}

// A row is left out when any text, in its normal form and folded, has a stem, a private term, money,
// an account shape or a long number in it. A text longer than MATCH_SPAN (in its normal form or
// folded) fails closed: it is left out. Every check runs over the whole cell, never in chunks.
export function isExcluded(policy: Policy, ...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => {
    if (!t) return false;
    if (oversize(t)) return true;
    const n = normalise(t);
    const f = fold(t);
    return (
      policy.stems.test(f) ||
      policy.terms.some((re) => re.test(n) || re.test(f)) ||
      namesMoney(t) ||
      namesAccount(t) ||
      namesLongNumber(t)
    );
  });
}

// Every cell is capped: a cell longer than this, in its normal form or folded, is left out whole and
// named as a warning, so every term and pattern runs over at most this many characters, whole.
export const MATCH_SPAN = 4000;
export const oversize = (t: string) => normalise(t).length > MATCH_SPAN || fold(t).length > MATCH_SPAN;

// --- strippers ----------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()|]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A run of digits and separators with at least nine digits, not a date.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d[\d\s.-]{6,}\d/g;
const STREET_SUFFIX =
  "Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Crescent|Close|Parade|Highway|Hwy";
const ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,5}[A-Za-z]?(?:\s+[A-Z][A-Za-z'-]*){1,4}\s+(?:${STREET_SUFFIX})\b`,
  "g",
);
// A record code: one to three capitals then digits, like P40.
const CODE_RE = /\b[A-Z]{1,3}\d{1,5}\b/g;

function digits(s: string): number {
  return (s.match(/\d/g) || []).length;
}

export function strip(text: string): string {
  let out = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links keep their text
    .replace(/[`*_]{1,3}([^`*_]+)[`*_]{1,3}/g, "$1")
    .replace(URL_RE, "a link")
    .replace(EMAIL_RE, "an email address")
    .replace(PHONE_RE, (m) => (digits(m) >= 9 && !/\d{4}-\d{2}-\d{2}/.test(m) ? "a phone number" : m))
    .replace(ADDRESS_RE, "an address")
    .replace(CODE_RE, "another item");
  return out.replace(/\s+/g, " ").trim();
}

// --- small text helpers -------------------------------------------------------------------

// A sentence never ends after these (with or without the full stop): "waiting on Mr. Vale".
export const ABBREVIATIONS = ["mr", "mrs", "ms", "dr", "st"];
export function firstSentence(text: string, max: number): string {
  const t = text.trim();
  const end = /[.!?](?=\s|$)/g;
  let cut = t.length;
  for (const m of t.matchAll(end)) {
    const word = t.slice(0, m.index).match(/[\p{L}]+$/u)?.[0] ?? "";
    if (m[0] === "." && ABBREVIATIONS.includes(word.toLowerCase())) continue;
    cut = m.index! + 1;
    break;
  }
  return cutCodePoints(t.slice(0, cut).trim(), max);
}

function empty(cell: string | undefined): boolean {
  const c = (cell ?? "").trim();
  return c === "" || c === "-" || c === "—" || c === "–" || /^n\/?a$/i.test(c) || /^none$/i.test(c);
}

// --- markdown tables ----------------------------------------------------------------------

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < l.length; i++) {
    if (l[i] === "\\" && l[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (l[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += l[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));

export interface TableRow {
  cells: Record<string, string>; // keyed by header name, lowercased
  line: number; // 1-based line in the file
  raw: string;
}

export interface Table {
  header: string[];
  rows: TableRow[];
}

// Every table in the text.
export function tables(text: string): Table[] {
  const out: Table[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSeparator(splitRow(lines[i + 1]))) {
      const header = splitRow(lines[i]).map((h) => h.toLowerCase());
      const rows: TableRow[] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitRow(lines[i]);
        const row: Record<string, string> = {};
        header.forEach((h, k) => (row[h] = cells[k] ?? ""));
        rows.push({ cells: row, line: i + 1, raw: lines[i] });
        i++;
      }
      out.push({ header, rows });
    } else i++;
  }
  return out;
}

const OPEN_COLUMNS = ["id", "item", "who", "next step", "waits for", "done when", "since"];

export interface OpenRow {
  id: string;
  item: string;
  who: string;
  next: string;
  waits: string | null;
  done_when: string;
  since: string;
  line: number;
  cells: Record<string, string>;
  raw: string;
}

const ID_RE = /^[A-Za-z]{1,3}\d+$/;

// The open table: the first one carrying every open column (the Done table has a Done column instead).
export function openTable(pending: string): Table {
  const t = tables(pending).find((tb) => OPEN_COLUMNS.every((c) => tb.header.includes(c)));
  if (!t) throw new Error("PENDING.md has no open table with columns " + OPEN_COLUMNS.join(", "));
  return t;
}

export function toOpenRow(r: TableRow): OpenRow {
  const c = r.cells;
  return {
    id: c["id"].trim(),
    item: c["item"],
    who: c["who"].trim(),
    next: c["next step"],
    waits: empty(c["waits for"]) ? null : c["waits for"],
    done_when: c["done when"],
    since: c["since"].trim(),
    line: r.line,
    cells: c,
    raw: r.raw,
  };
}

// The open rows with a well-formed id (the others are reported by buildSnapshot).
export function openRows(pending: string): OpenRow[] {
  return openTable(pending).rows.filter((r) => ID_RE.test(r.cells["id"].trim())).map(toOpenRow);
}

// --- holds and notes ----------------------------------------------------------------------

export interface Hold {
  holder?: string;
  for?: string;
  branches?: string[];
  job?: string;
  taken?: string;
  renewed?: string;
}

function readHolds(record: string): Record<string, Hold> {
  const p = join(record, "state", "holds.json");
  if (!existsSync(p)) return {};
  const data = JSON.parse(readFileSync(p, "utf8"));
  return data && typeof data === "object" ? data : {};
}

function noteTimes(record: string, id: string): string[] {
  const p = join(record, "state", "notes", `${id}.md`);
  if (!existsSync(p)) return [];
  const times: string[] = [];
  for (const t of tables(readFileSync(p, "utf8")))
    for (const r of t.rows) if (r.cells["when"]) times.push(r.cells["when"].trim());
  return times;
}

function toTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() + "T00:00:00Z" : s.trim());
  return Number.isNaN(t) ? null : t;
}

// --- one row to one thread ----------------------------------------------------------------

const isOwner = (cell: string, owners: string[]) => owners.includes(fold(cell).trim());
const namesOwner = (s: string | null, owners: string[]) =>
  !!s && owners.some((o) => wholeWord(escapeRe(o) + "(?:['\u2019]s)?").test(fold(s)));

// The assistant's own Who cell; any other person is "someone".
const ASSISTANT = ["cain", "the assistant", "assistant"];

// Who has it, as one of the fixed words in WHO; never the Who cell itself.
export function whoOf(row: OpenRow, hold: Hold | undefined, owners: string[] = DEFAULT_OWNER_NAMES): Who {
  const cell = fold(row.who).trim();
  if (hold?.job) return "a build job";
  if (isOwner(cell, owners)) return "you";
  if (cell === "at his pc") return "at his PC";
  if (cell.startsWith("laptop") || hold?.holder?.startsWith("laptop:")) return "a laptop session";
  if (cell === "build") return "a build job";
  if (ASSISTANT.includes(cell)) return "the assistant";
  return "someone";
}

export function stateOf(row: OpenRow, hold: Hold | undefined, owners: string[] = DEFAULT_OWNER_NAMES): State {
  if (hold?.job) return "running";
  if (isOwner(row.who, owners) || namesOwner(row.waits, owners)) return "waiting on you";
  if (fold(row.who).trim() === "at his pc") return "at his PC";
  return "moving";
}

// The area: the project folder the Item names, only when it passes the same checks as the cells
// (the private marker, the stems and terms, money) and is on the config's `areas` list; any other
// folder, or none, is "other". The name exported is the list's own entry, never the record's text:
// area names come from that fixed list.
export function areaOf(item: string, policy?: Policy): GatedText {
  const m = normalise(item).match(/\bprojects\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (!m || !policy) return gateArea("other", policy);
  const folder = m[1];
  // A folder name that is itself an identifier (a code, a number) is not shown.
  if (strip(folder) !== folder || /^[a-z]{1,3}\d+$/i.test(folder) || /\d{3,}/.test(folder)) return gateArea("other", policy);
  if (PRIVATE_TAG.test(folder) || isExcluded(policy, folder, folder.replace(/[-_]+/g, " "))) return gateArea("other", policy);
  const f = fold(folder);
  const listed = policy.areas.find((a) => a === f);
  return gateArea(listed ?? "other", policy);
}

// --- one sanitise pipeline, and the gated type ------------------------------------------------

// Every string the exporter signs is a GatedText, made only here: free text through sanitise, the
// rest from fixed lists or checked shapes. The brand is a compile-time aid only; what holds at run
// time is checkSigned below, which signSnapshot runs on every call: it walks the whole object against
// a closed schema and checks every string again.
declare const GATED: unique symbol;
export type GatedText = string & { readonly [GATED]: true };
function mark(s: string): GatedText {
  return s as GatedText;
}
// Every text sanitise returned, kept so checkSigned can tell a sanitised text at once.
const sanitisedTexts = new Set<string>();

// A record code for the id field, checked against its shape.
export function gateId(id: string): GatedText {
  if (!ID_RE.test(id)) throw new Error("gateId: not a record code");
  return mark(id);
}
// A time, as the ISO form of a Date.
export function gateTime(ms: number): GatedText {
  return mark(new Date(ms).toISOString());
}
// One of the fixed words: a who, a state, the app or the purpose.
const FIXED: readonly string[] = [...WHO, ...STATES, APP_ID, PURPOSE_SNAPSHOT];
export function gateFixed<T extends string>(word: T): T & GatedText {
  if (!FIXED.includes(word)) throw new Error("gateFixed: not a fixed word");
  return mark(word) as T & GatedText;
}
// An area: "other" or an entry of the config's areas list.
export function gateArea(area: string, policy?: Pick<Policy, "areas">): GatedText {
  if (area !== "other" && !policy?.areas.includes(area)) throw new Error("gateArea: not on the areas list");
  return mark(area);
}
// The record's revision: a commit hash, checked against its shape.
export function gateRevision(seq: number, commit: string): { seq: number; commit: GatedText } {
  const r = { seq, commit };
  if (!isRevision(r)) throw new Error("gateRevision: not a revision");
  return { seq, commit: mark(commit) };
}

export type TextField = "title" | "step" | "waits_for" | "outcome";

// The one pipeline for free text: the normal form, identifiers stripped, every configured name
// replaced, cut to the first sentence when capped, the proper-noun gate, and the cap again (a
// replaced word is longer than most). Returns the text, what the gate replaced, the lower-case or
// uncased words it doesn't know, and the lower-case words known only as name-words.
export function sanitise(
  raw: string,
  policy: Policy,
  max?: number,
): { text: GatedText; capitalised: string[]; unknown: string[]; nameLike: string[] } {
  const named = replaceNames(strip(normalise(raw)), policy);
  const g = properNounGate(max ? firstSentence(named, max) : named, policy.allowWords);
  const text = max ? cutCodePoints(g.text, max) : g.text;
  sanitisedTexts.add(text);
  const words = wordCheck(text, policy.vocabulary);
  return { text: mark(text), capitalised: g.words, unknown: words.unknown, nameLike: words.nameLike };
}

// A free text passes when sanitise itself made it, or when sanitising it again returns it unchanged.
function isSanitised(v: unknown, policy: Policy, max?: number): boolean {
  if (typeof v !== "string") return false;
  if (sanitisedTexts.has(v)) return true;
  try {
    return sanitise(v, policy, max).text === v;
  } catch {
    return false;
  }
}

// An object with exactly these own keys: plain (no class, no prototype tricks), no symbol keys, no
// hidden (non-enumerable) properties, no getters. Throws, naming the path, otherwise.
function closed(v: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainObject(v)) throw new Error(`${path}: not a plain object`);
  if (Object.getOwnPropertySymbols(v).length) throw new Error(`${path}: a symbol key`);
  const own = Object.getOwnPropertyNames(v);
  for (const k of own) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable || d.get || d.set) throw new Error(`${path}.${k}: not a plain field`);
    if (!keys.includes(k)) throw new Error(`${path}.${k}: a field outside the schema`);
  }
  for (const k of keys) if (!own.includes(k)) throw new Error(`${path}.${k}: missing`);
  return v;
}

// The run-time gate, on every signing: the whole signed object against the closed schema (exactly
// the signed fields, exactly the thread fields, exactly {seq, commit}), every string checked by its
// kind: the free texts by sanitise (isSanitised), the area against the config's list (and sanitise),
// the id, times, key id and revision by their shapes, who, state, app and purpose by their fixed
// lists. Throws, naming the path only, never the value.
export function checkSigned(value: unknown, policy: Policy): void {
  const s = closed(value, SIGNED_FIELDS, "snapshot");
  if (s.version !== SNAPSHOT_VERSION) throw new Error("snapshot.version: not the version this exporter signs");
  if (s.app !== APP_ID) throw new Error("snapshot.app: not the app");
  if (s.purpose !== PURPOSE_SNAPSHOT) throw new Error("snapshot.purpose: not the purpose");
  if (typeof s.key_id !== "string" || !/^[0-9a-f]{16}$/.test(s.key_id)) throw new Error("snapshot.key_id: not a key id");
  if (!isIsoTime(s.made_at)) throw new Error("snapshot.made_at: not a time");
  if (s.revision !== null) {
    closed(s.revision, REVISION_FIELDS, "snapshot.revision");
    if (!isRevision(s.revision)) throw new Error("snapshot.revision: not a revision");
  }
  for (const k of ["excluded_rows", "skipped_rows"] as const)
    if (typeof s[k] !== "number" || !Number.isSafeInteger(s[k]) || (s[k] as number) < 0) throw new Error(`snapshot.${k}: not a count`);
  const threads = s.threads;
  if (!Array.isArray(threads) || Object.getPrototypeOf(threads) !== Array.prototype) throw new Error("snapshot.threads: not a list");
  if (Object.getOwnPropertySymbols(threads).length || Object.getOwnPropertyNames(threads).length !== threads.length + 1)
    throw new Error("snapshot.threads: a field outside the schema");
  threads.forEach((raw, i) => {
    const path = `snapshot.threads[${i}]`;
    const t = closed(raw, THREAD_FIELDS, path);
    if (typeof t.id !== "string" || !ID_RE.test(t.id)) throw new Error(`${path}.id: not a record code`);
    if (!isSanitised(t.title, policy, TITLE_MAX)) throw new Error(`${path}.title: a string that did not pass the sanitise pipeline`);
    if (!isSanitised(t.step, policy, STEP_MAX)) throw new Error(`${path}.step: a string that did not pass the sanitise pipeline`);
    if (!isSanitised(t.outcome, policy)) throw new Error(`${path}.outcome: a string that did not pass the sanitise pipeline`);
    if (t.waits_for !== null && (!isSanitised(t.waits_for, policy) || t.waits_for === ""))
      throw new Error(`${path}.waits_for: a string that did not pass the sanitise pipeline`);
    if (typeof t.area !== "string" || (t.area !== "other" && !policy.areas.includes(t.area)) || !isSanitised(t.area, policy))
      throw new Error(`${path}.area: not on the areas list`);
    if (!(WHO as readonly unknown[]).includes(t.who)) throw new Error(`${path}.who: not a fixed word`);
    if (!(STATES as readonly unknown[]).includes(t.state)) throw new Error(`${path}.state: not a fixed word`);
    if (!isIsoTime(t.last_moved)) throw new Error(`${path}.last_moved: not a time`);
  });
}

export interface ExportThread extends Thread {
  id: GatedText;
  title: GatedText;
  area: GatedText;
  who: Who & GatedText;
  step: GatedText;
  waits_for: GatedText | null;
  outcome: GatedText;
  last_moved: GatedText;
  state: State & GatedText;
}

// What the pipeline builds: every signed field but the key id, which signing adds (withKeyId).
export interface ExportSigned extends Omit<Signed, "key_id"> {
  app: typeof APP_ID & GatedText;
  purpose: typeof PURPOSE_SNAPSHOT & GatedText;
  made_at: GatedText;
  revision: { seq: number; commit: GatedText } | null;
  threads: ExportThread[];
}

// Every cell of a row, for the privacy checks: all columns, the id included.
const allCells = (row: OpenRow) => [row.raw, ...Object.values(row.cells)];

// A word found in an exported text: its field and the word, never more. A capitalised word the
// proper-noun gate replaced, or a lower-case or uncased word not in the vocabulary.
export interface Leftover {
  field: TextField;
  word: string;
}

export type Outcome =
  | { kind: "thread"; thread: ExportThread; leftovers: Leftover[]; unknowns: Leftover[]; nameLike: Leftover[] }
  | { kind: "excluded"; warning?: string }
  | { kind: "skipped"; reason: string };

export function threadOf(row: OpenRow, hold: Hold | undefined, notes: string[], policy: Policy): Outcome {
  if (markedPrivate(row.cells, row.raw)) return { kind: "excluded" };
  // A cell too long to match whole is left out, and named as a warning (so --strict fails on it).
  if (allCells(row).some(oversize)) return { kind: "excluded", warning: `a cell longer than ${MATCH_SPAN} characters` };
  if (isExcluded(policy, ...allCells(row))) return { kind: "excluded" };
  if (!ID_RE.test(row.id)) return { kind: "skipped", reason: "no valid id" };
  const since = toTime(row.since);
  if (since === null) return { kind: "skipped", reason: "no valid Since time" };
  const times = [since, ...notes.map(toTime), toTime(hold?.taken), toTime(hold?.renewed)].filter(
    (t): t is number => t !== null,
  );
  // Classified first (who and state read the names), then every text through the one pipeline.
  const leftovers: Leftover[] = [];
  const unknowns: Leftover[] = [];
  const nameLike: Leftover[] = [];
  const clean = (field: TextField, t: string, max?: number) => {
    const r = sanitise(t, policy, max);
    for (const word of r.capitalised) leftovers.push({ field, word });
    for (const word of r.unknown) unknowns.push({ field, word });
    for (const word of r.nameLike) nameLike.push({ field, word });
    return r.text;
  };
  const waits = row.waits === null ? null : clean("waits_for", row.waits) || null;
  return {
    kind: "thread",
    thread: {
      id: gateId(row.id),
      title: clean("title", row.item, TITLE_MAX),
      area: areaOf(row.item, policy),
      who: gateFixed(whoOf(row, hold, policy.owners)),
      step: clean("step", row.next, STEP_MAX),
      waits_for: waits,
      outcome: clean("outcome", row.done_when),
      last_moved: gateTime(Math.max(...times)),
      state: gateFixed(stateOf(row, hold, policy.owners)),
    },
    leftovers,
    unknowns,
    nameLike,
  };
}

// A word found, where it was: the path and row number, the field and the word.
export interface LeftoverAt extends Leftover {
  where: string;
}

export interface Built {
  snapshot: ExportSigned;
  // One line per malformed or oversized row: path and row number, never the row's text.
  warnings: string[];
  // Each capitalised word the gate replaced. Only the private dry-run report prints the word;
  // a --strict failure prints the place and the field (leftoverPlace).
  leftovers: LeftoverAt[];
  // Each lower-case or uncased word not in the vocabulary, the same way.
  unknowns: LeftoverAt[];
  // Each lower-case word known only as a name-words.txt [common] word ("will", "rose"): reported
  // in the private dry-run report, not a failure.
  nameLike: LeftoverAt[];
  // How many exported threads each area has ("other" included). Area names are on the config's list.
  areas: Record<string, number>;
}

export const leftoverPlace = (l: LeftoverAt) => `${l.where}: ${l.field}`;
export const leftoverLine = (l: LeftoverAt) => `${l.where}: ${l.field}: ${l.word}`;

// What fails a --strict run (and so every --put): a warning (a malformed or oversized row), a
// capitalised word the gate replaced, or an unknown word in any free-text field. Places only, never
// words.
export function strictProblems(b: Built): { warnings: string[]; leftovers: LeftoverAt[]; unknown: LeftoverAt[] } {
  return { warnings: b.warnings, leftovers: b.leftovers, unknown: b.unknowns };
}
export const strictFails = (b: Built) => {
  const p = strictProblems(b);
  return p.warnings.length + p.leftovers.length + p.unknown.length > 0;
};

export function buildSnapshot(
  record: string,
  policy: Policy,
  now = new Date(),
  revision: { seq: number; commit: string } | null = null,
): Built {
  const path = join(record, "state", "PENDING.md");
  const pending = readFileSync(path, "utf8");
  const holds = readHolds(record);
  const threads: ExportThread[] = [];
  const warnings: string[] = [];
  const leftovers: LeftoverAt[] = [];
  const unknowns: LeftoverAt[] = [];
  const nameLike: LeftoverAt[] = [];
  const areas: Record<string, number> = {};
  let excluded = 0;
  let skipped = 0;
  for (const r of openTable(pending).rows) {
    const row = toOpenRow(r);
    const okId = ID_RE.test(row.id);
    const out = threadOf(row, okId ? holds[row.id] : undefined, okId ? noteTimes(record, row.id) : [], policy);
    const where = `${path}:${row.line}`;
    if (out.kind === "thread") {
      threads.push(out.thread);
      areas[out.thread.area] = (areas[out.thread.area] ?? 0) + 1;
      for (const l of out.leftovers) leftovers.push({ ...l, where });
      for (const u of out.unknowns) unknowns.push({ ...u, where });
      for (const u of out.nameLike) nameLike.push({ ...u, where });
    } else if (out.kind === "excluded") {
      excluded++;
      if (out.warning) warnings.push(`${where}: row left out, ${out.warning}`);
    } else {
      skipped++;
      warnings.push(`${where}: row skipped, ${out.reason}`);
    }
  }
  return {
    snapshot: {
      version: SNAPSHOT_VERSION,
      app: gateFixed(APP_ID),
      purpose: gateFixed(PURPOSE_SNAPSHOT),
      made_at: gateTime(now.getTime()),
      revision: revision ? gateRevision(revision.seq, revision.commit) : null,
      threads,
      excluded_rows: excluded,
      skipped_rows: skipped,
    },
    warnings,
    leftovers,
    unknowns,
    nameLike,
    areas,
  };
}

// --- keys and signatures ------------------------------------------------------------------

// The raw 32-byte public key from a PEM (SPKI) file or a base64 line.
export function rawPublicKey(text: string): Uint8Array {
  const t = text.trim();
  if (t.includes("BEGIN")) {
    const jwk = createPublicKey(t).export({ format: "jwk" }) as { x?: string; crv?: string };
    if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("not an Ed25519 public key");
    return new Uint8Array(Buffer.from(jwk.x, "base64url"));
  }
  const raw = new Uint8Array(Buffer.from(t, "base64"));
  if (raw.length !== 32) throw new Error("a raw Ed25519 public key is 32 bytes of base64");
  return raw;
}

export function keyId(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// The signed object: the pipeline's fields with the key id, in the signed fields' order.
export function withKeyId(s: ExportSigned, keyIdHex: string): Signed {
  return {
    version: s.version,
    app: s.app,
    purpose: s.purpose,
    key_id: keyIdHex,
    made_at: s.made_at,
    revision: s.revision,
    threads: s.threads,
    excluded_rows: s.excluded_rows,
    skipped_rows: s.skipped_rows,
  };
}

// The snapshot's identity (the same as shared/snapshot.ts snapshotId): the SHA-256 of its signed
// bytes, in hex. It is also the approval digest: the dry run prints it, and --put signs only bytes
// with this digest (--approve).
export function snapshotIdOf(s: Signed): string {
  return createHash("sha256").update(signedBytes(s)).digest("hex");
}

export function privateKey(pem: string): KeyObject {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
  return k;
}

export function keyIdOfPrivate(key: KeyObject): string {
  return keyId(rawPublicKey(createPublicKey(key).export({ format: "pem", type: "spki" }).toString()));
}

// Signs only what passes the run-time gate: checkSigned walks the whole signed object against the
// closed schema on every call, so nothing unsanitised, unknown or extra can be signed.
export function signSnapshot(s: ExportSigned, key: KeyObject, policy: Policy): Snapshot {
  const signed = withKeyId(s, keyIdOfPrivate(key));
  // The pipeline's object itself must be closed too: a field the copy above would leave behind is
  // refused, not dropped.
  closed(s, SIGNED_FIELDS.filter((k) => k !== "key_id"), "snapshot");
  checkSigned(signed, policy);
  const sig = sign(null, signedBytes(signed), key);
  return { ...signed, sig: toBase64(new Uint8Array(sig)) };
}

// A new key pair: the private key (PEM), the public key (PEM), the raw public key in base64, and its
// key-list entry (`<key id>:<raw base64>`, what SNAPSHOT_PUBLIC_KEYS and SURFACE_PUBLIC_KEYS list).
export function makeKeyPair(): { privatePem: string; publicPem: string; publicRaw: string; publicEntry: string } {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync("ed25519");
  const publicPem = pub.export({ format: "pem", type: "spki" }).toString();
  const raw = rawPublicKey(publicPem);
  return {
    privatePem: priv.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem,
    publicRaw: toBase64(raw),
    publicEntry: `${keyId(raw)}:${toBase64(raw)}`,
  };
}

// --- the record's revision ----------------------------------------------------------------------

// The record checkout's revision, when git can say it for certain: the checkout is the top of its own
// git work tree (not a folder inside another repository, like the fixtures), and nothing under state/
// differs from its last commit. Then {seq: the commit's count of ancestors, itself included, which
// only grows along a branch; commit: its hash}. Else null, with the reason.
export function recordRevision(record: string): { revision: { seq: number; commit: string } | null; why?: string } {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", record, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  try {
    const top = git("rev-parse", "--show-toplevel");
    if (realpathSync(top) !== realpathSync(record)) return { revision: null, why: "the record is not the top of its own git work tree" };
    if (git("status", "--porcelain", "--untracked-files=all", "--", "state") !== "")
      return { revision: null, why: "the record's state/ has changes not committed" };
    const commit = git("rev-parse", "HEAD");
    const seq = Number(git("rev-list", "--count", "HEAD"));
    const r = { seq, commit };
    return isRevision(r) ? { revision: r } : { revision: null, why: "git gave no usable revision" };
  } catch {
    return { revision: null, why: "the record is not a git checkout (or git is missing)" };
  }
}
