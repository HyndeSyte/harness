// The snapshot's one canonical form, used by the exporter, the Worker and the app alike
// (the app's Metro config watches this folder). Plain TypeScript with no runtime imports:
// UTF-8 comes from the standard TextEncoder, which Bun, Workers, browsers and Hermes all have.

// Sorted keys at every level, no whitespace. JSON.stringify writes strings and numbers.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) throw new Error("canonical: value has no JSON form");
    return out;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

// The signed format's version. Bumped on every change to the signed fields or a thread's fields
// (SCHEMA below; a test pins each version to its schema's fingerprint), and the app and the Worker
// refuse any version they don't know. Version 2 was never deployed, so the seventh round settled its
// fields (key_id and revision joined the signed bytes) without a new number; version 1 is refused.
export const SNAPSHOT_VERSION = 2;
// Fixed identifiers inside the signed bytes: which app the bytes are for and what they are for. A
// later command envelope gets its own purpose (and its own key), so a snapshot's signature can never
// be replayed as a command, nor a command's as a snapshot.
export const APP_ID = "harness-surface";
export const PURPOSE_SNAPSHOT = "in-motion-snapshot";

// The fields the signature covers, in this order of meaning (the canonical form sorts them). The key
// id is signed too, so a signature can't be moved under another listed key's id. `revision` is the
// record's commit when the exporter knows it ({seq, commit}: seq the commit's count of ancestors,
// commit its hash), else null.
export const SIGNED_FIELDS = ["version", "app", "purpose", "key_id", "made_at", "revision", "threads", "excluded_rows", "skipped_rows"] as const;
// A thread's fields, every one of them signed.
export const THREAD_FIELDS = ["id", "title", "area", "who", "step", "waits_for", "outcome", "last_moved", "state"] as const;
// A revision's fields.
export const REVISION_FIELDS = ["seq", "commit"] as const;
// What a version stands for: its signed fields, its thread fields and its revision fields.
export const SCHEMA = { version: SNAPSHOT_VERSION, signed: SIGNED_FIELDS, thread: THREAD_FIELDS, revision: REVISION_FIELDS } as const;

// The version and the two identifiers, checked before a signature is: an unknown version is
// refused whatever it carries, since its signed fields may not be these.
export function knownEnvelope(s: Record<string, unknown>): boolean {
  return s.version === SNAPSHOT_VERSION && s.app === APP_ID && s.purpose === PURPOSE_SNAPSHOT;
}

export interface Revision {
  seq: number;
  commit: string;
}

// A revision as the signed bytes carry it: exactly {seq, commit}, seq a whole number from 1, commit
// a full git hash (40 hex digits, or 64 for a SHA-256 repository), lower case.
export function isRevision(v: unknown): v is Revision {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.every((k) => (REVISION_FIELDS as readonly string[]).includes(k))) return false;
  const r = v as Record<string, unknown>;
  return typeof r.seq === "number" && Number.isSafeInteger(r.seq) && r.seq >= 1 &&
    typeof r.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.commit);
}

// A time exactly as Date.toISOString writes it (the only form the exporter signs).
export function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && !Number.isNaN(Date.parse(v)) &&
    new Date(Date.parse(v)).toISOString() === v;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export type SignedFields = { [K in (typeof SIGNED_FIELDS)[number]]: unknown };

// What the signature covers: exactly the signed fields of the snapshot as received.
export function signedBytes(s: SignedFields): Uint8Array {
  const picked: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) picked[k] = s[k];
  return new TextEncoder().encode(canonical(picked));
}

// The signed fields of any received value (missing ones undefined, so they drop out of the bytes).
export function signedBytesOf(s: object): Uint8Array {
  const picked: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) picked[k] = Reflect.get(s, k);
  return new TextEncoder().encode(canonical(picked));
}

export const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// A received snapshot's shape before its signature: exactly the signed fields and sig (no other
// field), a known version, app and purpose, a 16-hex key id, an exact ISO made_at, a revision or
// null, a list of threads and two counts. The Worker and the app both check it.
export function wellFormed(s: unknown): s is { sig: string; key_id: string; made_at: string; threads: unknown[]; revision: Revision | null } & Record<string, unknown> {
  if (!isPlainObject(s)) return false;
  const keys = Object.keys(s);
  const allowed: readonly string[] = [...SIGNED_FIELDS, "sig"];
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) return false;
  if (!knownEnvelope(s)) return false;
  if (typeof s.sig !== "string" || typeof s.key_id !== "string" || !/^[0-9a-f]{16}$/.test(s.key_id)) return false;
  if (!isIsoTime(s.made_at) || !Array.isArray(s.threads)) return false;
  if (s.revision !== null && !isRevision(s.revision)) return false;
  return isCount(s.excluded_rows) && isCount(s.skipped_rows);
}

// --- the key lists ------------------------------------------------------------------------------

// One key in the Worker's SNAPSHOT_PUBLIC_KEYS or the app's EXPO_PUBLIC_SURFACE_PUBLIC_KEY:
// `<key id>:<raw public key, base64>`, with `:retired` after a key that may no longer sign. The key id
// is the first 16 hex digits of the SHA-256 of the raw key (each runtime checks it). Entries are
// comma-separated.
export interface KeyEntry {
  id: string;
  raw: Uint8Array;
  retired: boolean;
}

// The entries in a key list, or null when any entry is malformed or an id is listed twice: a list
// with a mistake in it is no list (the Worker then refuses every upload, the app every snapshot).
export function parseKeyEntries(text: string): KeyEntry[] | null {
  const out: KeyEntry[] = [];
  for (const part of (text || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^([0-9a-f]{16}):([A-Za-z0-9+/]+={0,2})(?::(retired))?$/.exec(p);
    if (!m) return null;
    let raw: Uint8Array;
    try {
      raw = fromBase64(m[2]);
    } catch {
      return null;
    }
    if (raw.length !== 32 || out.some((e) => e.id === m[1])) return null;
    out.push({ id: m[1], raw, retired: m[3] === "retired" });
  }
  return out;
}

export function keyEntryText(e: { id: string; raw: Uint8Array; retired?: boolean }): string {
  return `${e.id}:${toBase64(e.raw)}${e.retired ? ":retired" : ""}`;
}

// Cuts text to at most `max` whole characters; a cut text ends in an ellipsis, counted in the
// limit. Where Intl.Segmenter exists a character is a grapheme cluster, so a joiner sequence
// (a family emoji), a flag or a letter with its combining mark is never split; elsewhere it is
// a code point, so a surrogate pair is never split.
export function cutCodePoints(text: string, max: number): string {
  const points = characters(text);
  if (points.length <= max) return text;
  return points.slice(0, max - 1).join("").trimEnd() + "…";
}

function characters(text: string): string[] {
  const Segmenter = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl?.Segmenter;
  if (typeof Segmenter === "function") {
    const out: string[] = [];
    for (const s of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) out.push(s.segment);
    return out;
  }
  return Array.from(text);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += b === undefined ? "=" : ALPHABET[(n >> 6) & 63];
    out += c === undefined ? "=" : ALPHABET[n & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.trim().replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error("not base64");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | ALPHABET.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
