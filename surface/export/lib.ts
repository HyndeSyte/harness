// The exporter: reads the record's open list and writes a surface-safe, signed snapshot.
// Nothing here is written by an agent at display time: it only copies typed cells and
// drops what must never leave the house.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { signedBytes, toBase64, type Signed, type Snapshot, type State, type Thread, type Who } from "../shared/snapshot";

export const TITLE_MAX = 140;
export const STEP_MAX = 200;

// Rows that never leave the house. Whole words or prefixes, any case: "bank" also catches
// "banking", and the stems catch "financial", "therapist", "medical", "diagnosed".
const EXCLUDED = /\b(?:money|financ|debt|bank|budget|health|therap|pt|doctor|medic|diagnos)\w*/i;

export function isExcluded(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && EXCLUDED.test(t));
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
  let s = (m ? m[0] : t).trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
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

// Every table in the text as a list of rows keyed by header name (lowercased).
export function tables(text: string): Record<string, string>[][] {
  const out: Record<string, string>[][] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSeparator(splitRow(lines[i + 1]))) {
      const header = splitRow(lines[i]).map((h) => h.toLowerCase());
      const rows: Record<string, string>[] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitRow(lines[i]);
        const row: Record<string, string> = {};
        header.forEach((h, k) => (row[h] = cells[k] ?? ""));
        rows.push(row);
        i++;
      }
      out.push(rows.length ? rows : []);
      (out[out.length - 1] as any).header = header;
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
}

// The open table: the first one carrying every open column (the Done table has a Done column instead).
export function openRows(pending: string): OpenRow[] {
  const t = tables(pending).find((rows) => OPEN_COLUMNS.every((c) => ((rows as any).header as string[]).includes(c)));
  if (!t) throw new Error("PENDING.md has no open table with columns " + OPEN_COLUMNS.join(", "));
  return t
    .filter((r) => /^[A-Za-z]{1,3}\d+$/.test(r["id"].trim()))
    .map((r) => ({
      id: r["id"].trim(),
      item: r["item"],
      who: r["who"].trim(),
      next: r["next step"],
      waits: empty(r["waits for"]) ? null : r["waits for"],
      done_when: r["done when"],
      since: r["since"].trim(),
    }));
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
    for (const r of t) if (r["when"]) times.push(r["when"].trim());
  return times;
}

function toTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() + "T00:00:00Z" : s.trim());
  return Number.isNaN(t) ? null : t;
}

// --- one row to one thread ----------------------------------------------------------------

const namesDane = (s: string | null) => !!s && /\bDane\b|\bDane's\b/i.test(s);

export function whoOf(row: OpenRow, hold: Hold | undefined): Who {
  const cell = row.who.toLowerCase();
  if (hold?.job) return "a build job";
  if (cell === "dane") return "you";
  if (cell === "at his pc") return "at his PC";
  if (cell.startsWith("laptop") || hold?.holder?.startsWith("laptop:")) return "a laptop session";
  if (cell === "build") return "a build job";
  return "cain";
}

export function stateOf(row: OpenRow, hold: Hold | undefined): State {
  if (hold?.job) return "running";
  if (row.who.toLowerCase() === "dane" || namesDane(row.waits)) return "waiting on you";
  if (row.who.toLowerCase() === "at his pc") return "at his PC";
  return "moving";
}

export function areaOf(item: string): string {
  const m = item.match(/\bprojects\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  return m ? m[1].toLowerCase() : "other";
}

export function threadOf(row: OpenRow, hold: Hold | undefined, notes: string[]): Thread | null {
  if (isExcluded(row.id, row.item, row.next, row.waits, row.done_when)) return null;
  const times = [toTime(row.since), ...notes.map(toTime), toTime(hold?.taken), toTime(hold?.renewed)].filter(
    (t): t is number => t !== null,
  );
  if (!times.length) return null;
  const waits = row.waits === null ? null : strip(row.waits) || null;
  return {
    id: row.id,
    title: firstSentence(strip(row.item), 140),
    area: areaOf(row.item),
    who: whoOf(row, hold),
    step: firstSentence(strip(row.next), 200),
    waits_for: waits,
    outcome: strip(row.done_when),
    last_moved: new Date(Math.max(...times)).toISOString(),
    state: stateOf(row, hold),
  };
}

export function buildSnapshot(record: string, now = new Date()): Signed {
  const pending = readFileSync(join(record, "state", "PENDING.md"), "utf8");
  const holds = readHolds(record);
  const threads: Thread[] = [];
  for (const row of openRows(pending)) {
    const t = threadOf(row, holds[row.id], noteTimes(record, row.id));
    if (t) threads.push(t);
  }
  return { version: 1, made_at: now.toISOString(), threads };
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
