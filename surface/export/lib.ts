// The exporter: reads the record's open list and writes a surface-safe, signed snapshot.
// Nothing here is written by an agent at display time: it only copies typed cells and
// drops what must never leave the house. It fails closed: no private terms, no snapshot.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cutCodePoints, signedBytes, toBase64 } from "../shared/canonical";
import type { Signed, Snapshot, State, Thread, Who } from "../shared/snapshot";

export const TITLE_MAX = 140;
export const STEP_MAX = 200;

// --- the privacy policy -------------------------------------------------------------------

// Generic stems that leave a row out whole. Each matches at the start of a word, any case:
// "bank" also catches "banking", "therap" catches "therapist". The owner's config adds more
// (exclude_stems); it can't take these away.
export const DEFAULT_STEMS = [
  "money", "financ", "debt", "bank", "budget", "pay", "invoice", "tax", "rent", "loan", "salar",
  "insur", "refund", "health", "therap", "pt", "doctor", "dentist", "prescri", "clinic",
  "pharmac", "medic", "diagnos",
];

// Who the owner is called in the record. The code knows only the role word; the owner's own
// name comes from config (owner_names).
export const DEFAULT_OWNER_NAMES = ["owner", "the owner"];

export interface Policy {
  terms: RegExp[];
  stems: RegExp;
  owners: string[];
}

export interface ExporterConfig {
  owner_names?: string[];
  exclude_stems?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole word, Unicode-aware: no letter, digit or underscore on either side.
const wholeWord = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, "iu");

// The owner's private terms file: one term a line, `re:` for a regular expression, `#` for a
// note line. Every term matches case-insensitive and as a whole word. A file with no terms
// is refused: the exporter fails closed rather than export with no list.
export function parseTerms(text: string, where = "the private terms file"): RegExp[] {
  const terms: RegExp[] = [];
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    if (t.startsWith("re:")) {
      const body = t.slice(3).trim();
      if (!body) throw new Error(`${where}:${i + 1}: an empty re: term`);
      try {
        terms.push(wholeWord(body));
      } catch {
        throw new Error(`${where}:${i + 1}: not a valid regular expression`);
      }
    } else terms.push(wholeWord(escapeRe(t)));
  });
  if (!terms.length) throw new Error(`${where} has no terms, so nothing is exported`);
  return terms;
}

const list = (v: unknown, name: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`config: ${name} must be a list of words`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
};
const envList = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// The config: a JSON file (--config) and/or SURFACE_OWNER_NAMES and SURFACE_EXCLUDE_STEMS
// (comma-separated). Both add to the generic defaults.
export function makePolicy(termsText: string, config: ExporterConfig = {}, env: Record<string, string | undefined> = {}): Policy {
  const stems = [...DEFAULT_STEMS, ...list(config.exclude_stems, "exclude_stems"), ...envList(env.SURFACE_EXCLUDE_STEMS)];
  const owners = [...DEFAULT_OWNER_NAMES, ...list(config.owner_names, "owner_names"), ...envList(env.SURFACE_OWNER_NAMES)];
  return {
    terms: parseTerms(termsText),
    stems: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${stems.map(escapeRe).join("|")})`, "iu"),
    owners: owners.map((o) => o.toLowerCase()),
  };
}

// The private marker: a `#private` tag anywhere in the row, or a Private column whose cell is
// yes, y, true, x or private. It is final: such a row never exports.
const PRIVATE_TAG = /(?<![\p{L}\p{N}_])#private(?![\p{L}\p{N}_])/iu;
export function markedPrivate(cells: Record<string, string>, raw: string): boolean {
  if (PRIVATE_TAG.test(raw)) return true;
  const col = (cells["private"] ?? "").trim().toLowerCase();
  return ["yes", "y", "true", "x", "private"].includes(col);
}

export function isExcluded(policy: Policy, ...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && (policy.stems.test(t) || policy.terms.some((re) => re.test(t))));
}

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

export function firstSentence(text: string, max: number): string {
  const t = text.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return cutCodePoints((m ? m[0] : t).trim(), max);
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

const isOwner = (cell: string, owners: string[]) => owners.includes(cell.trim().toLowerCase());
const namesOwner = (s: string | null, owners: string[]) =>
  !!s && owners.some((o) => wholeWord(escapeRe(o) + "(?:'s)?").test(s));

export function whoOf(row: OpenRow, hold: Hold | undefined, owners: string[] = DEFAULT_OWNER_NAMES): Who {
  const cell = row.who.toLowerCase();
  if (hold?.job) return "a build job";
  if (isOwner(cell, owners)) return "you";
  if (cell === "at his pc") return "at his PC";
  if (cell.startsWith("laptop") || hold?.holder?.startsWith("laptop:")) return "a laptop session";
  if (cell === "build") return "a build job";
  return "cain";
}

export function stateOf(row: OpenRow, hold: Hold | undefined, owners: string[] = DEFAULT_OWNER_NAMES): State {
  if (hold?.job) return "running";
  if (isOwner(row.who, owners) || namesOwner(row.waits, owners)) return "waiting on you";
  if (row.who.toLowerCase() === "at his pc") return "at his PC";
  return "moving";
}

export function areaOf(item: string): string {
  const m = item.match(/\bprojects\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (!m) return "other";
  // A folder name that is itself an identifier (a code, a number) is not shown.
  if (strip(m[1]) !== m[1] || /^[a-z]{1,3}\d+$/i.test(m[1]) || /\d{3,}/.test(m[1])) return "other";
  return m[1].toLowerCase();
}

// Every cell of a row, for the privacy checks: all columns, the id included.
const allCells = (row: OpenRow) => [row.raw, ...Object.values(row.cells)];

export type Outcome =
  | { kind: "thread"; thread: Thread }
  | { kind: "excluded" }
  | { kind: "skipped"; reason: string };

export function threadOf(row: OpenRow, hold: Hold | undefined, notes: string[], policy: Policy): Outcome {
  if (markedPrivate(row.cells, row.raw)) return { kind: "excluded" };
  if (isExcluded(policy, ...allCells(row))) return { kind: "excluded" };
  if (!ID_RE.test(row.id)) return { kind: "skipped", reason: "no valid id" };
  const since = toTime(row.since);
  if (since === null) return { kind: "skipped", reason: "no valid Since time" };
  const times = [since, ...notes.map(toTime), toTime(hold?.taken), toTime(hold?.renewed)].filter(
    (t): t is number => t !== null,
  );
  const waits = row.waits === null ? null : strip(row.waits) || null;
  return {
    kind: "thread",
    thread: {
      id: row.id,
      title: firstSentence(strip(row.item), TITLE_MAX),
      area: areaOf(row.item),
      who: whoOf(row, hold, policy.owners),
      step: firstSentence(strip(row.next), STEP_MAX),
      waits_for: waits,
      outcome: strip(row.done_when),
      last_moved: new Date(Math.max(...times)).toISOString(),
      state: stateOf(row, hold, policy.owners),
    },
  };
}

export interface Built {
  snapshot: Signed;
  // One line per malformed row: path and row number, never the row's text.
  warnings: string[];
}

export function buildSnapshot(record: string, policy: Policy, now = new Date()): Built {
  const path = join(record, "state", "PENDING.md");
  const pending = readFileSync(path, "utf8");
  const holds = readHolds(record);
  const threads: Thread[] = [];
  const warnings: string[] = [];
  let excluded = 0;
  let skipped = 0;
  for (const r of openTable(pending).rows) {
    const row = toOpenRow(r);
    const okId = ID_RE.test(row.id);
    const out = threadOf(row, okId ? holds[row.id] : undefined, okId ? noteTimes(record, row.id) : [], policy);
    if (out.kind === "thread") threads.push(out.thread);
    else if (out.kind === "excluded") excluded++;
    else {
      skipped++;
      warnings.push(`${path}:${row.line}: row skipped, ${out.reason}`);
    }
  }
  return {
    snapshot: { version: 1, made_at: now.toISOString(), threads, excluded_rows: excluded, skipped_rows: skipped },
    warnings,
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

export function privateKey(pem: string): KeyObject {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
  return k;
}

export function signSnapshot(s: Signed, key: KeyObject): Snapshot {
  const pub = rawPublicKey(createPublicKey(key).export({ format: "pem", type: "spki" }).toString());
  const sig = sign(null, signedBytes(s), key);
  return { ...s, sig: toBase64(new Uint8Array(sig)), key_id: keyId(pub) };
}

export function makeKeyPair(): { privatePem: string; publicPem: string; publicRaw: string } {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync("ed25519");
  const publicPem = pub.export({ format: "pem", type: "spki" }).toString();
  return {
    privatePem: priv.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem,
    publicRaw: toBase64(rawPublicKey(publicPem)),
  };
}
