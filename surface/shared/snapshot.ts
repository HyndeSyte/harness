// The snapshot's shape, shared by the exporter and the Worker. The canonical form lives in
// ./canonical.ts, the one module the exporter, the Worker and the app all import.
import {
  APP_ID,
  fromBase64,
  hex,
  parseKeyEntries,
  PURPOSE_SNAPSHOT,
  signedBytesOf,
  SNAPSHOT_VERSION,
  wellFormed,
  type KeyEntry,
  type Revision,
} from "./canonical";

export {
  isCount,
  wellFormed,
  APP_ID,
  canonical,
  fromBase64,
  keyEntryText,
  parseKeyEntries,
  PURPOSE_SNAPSHOT,
  SCHEMA,
  signedBytes,
  SNAPSHOT_VERSION,
  toBase64,
  type KeyEntry,
  type Revision,
} from "./canonical";

// Who has a thread, as one of these fixed words only: the exporter never sends the Who cell.
// "someone" is any other person.
export const WHO = ["you", "the assistant", "a build job", "a laptop session", "at his PC", "someone"] as const;
export const STATES = ["running", "waiting on you", "at his PC", "moving"] as const;

export type Who = (typeof WHO)[number];
export type State = (typeof STATES)[number];

export interface Thread {
  id: string;
  title: string;
  area: string;
  who: Who;
  step: string;
  waits_for: string | null;
  outcome: string;
  last_moved: string;
  state: State;
}

export interface Signed {
  version: typeof SNAPSHOT_VERSION;
  app: typeof APP_ID;
  purpose: typeof PURPOSE_SNAPSHOT;
  // The signing key's id, inside the signed bytes.
  key_id: string;
  made_at: string;
  // The record's commit when the exporter knows it, else null.
  revision: Revision | null;
  threads: Thread[];
  // Rows left out on purpose (private terms, stems, the private marker), and rows skipped
  // as malformed (no valid id or time). Signed, so the app can say how many it doesn't show.
  excluded_rows: number;
  skipped_rows: number;
}

export interface Snapshot extends Signed {
  sig: string;
}
// (wellFormed, in canonical.ts, checks a received value has exactly this shape.)

export async function keyIdOf(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return hex(digest.slice(0, 8));
}


// The snapshot's identity: the SHA-256 of its signed bytes, in hex (64 digits). The Worker answers
// every PUT with the identity it holds, so an uploader that lost a response can tell whether its own
// snapshot is the one stored; it is also the approval digest the dry run prints for the first upload.
export async function snapshotId(s: object): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", signedBytesOf(s))));
}

// The parsed key list with every id checked against its key, or null when the list is malformed or
// an id doesn't match its key.
export async function keyList(text: string): Promise<KeyEntry[] | null> {
  const entries = parseKeyEntries(text);
  if (!entries) return null;
  for (const e of entries) if ((await keyIdOf(e.raw)) !== e.id) return null;
  return entries;
}

// What a check of a snapshot's signature found. ok: it verifies under a listed key that isn't
// retired. retired: it verifies, but under a key the list marks retired. Anything else is bad:
// malformed, an unknown version, app or purpose, a key id none of the keys has, or a signature
// that doesn't verify.
export type Verdict = "ok" | "retired" | "bad";

// Verifies with WebCrypto Ed25519 (Bun and Cloudflare Workers both have it), under the listed key
// whose id the snapshot's signed key_id names. Never throws.
export async function verifyVerdict(snapshot: unknown, keys: KeyEntry[] | null): Promise<Verdict> {
  try {
    if (!keys || !wellFormed(snapshot)) return "bad";
    const entry = keys.find((k) => k.id === snapshot.key_id);
    if (!entry || (await keyIdOf(entry.raw)) !== snapshot.key_id) return "bad";
    const key = await crypto.subtle.importKey("raw", entry.raw, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(snapshot.sig), signedBytesOf(snapshot));
    if (!ok) return "bad";
    return entry.retired ? "retired" : "ok";
  } catch {
    return "bad";
  }
}

// True only for a snapshot that verifies under a listed key that isn't retired.
export async function verifySnapshot(snapshot: unknown, keys: KeyEntry[] | null): Promise<boolean> {
  return (await verifyVerdict(snapshot, keys)) === "ok";
}
