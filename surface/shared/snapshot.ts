// The snapshot's shape, shared by the exporter and the Worker. The canonical form lives in
// ./canonical.ts, the one module the exporter, the Worker and the app all import.
import { APP_ID, fromBase64, hex, knownEnvelope, PURPOSE_SNAPSHOT, signedBytes, SNAPSHOT_VERSION } from "./canonical";

export { APP_ID, canonical, fromBase64, PURPOSE_SNAPSHOT, SCHEMA, signedBytes, SNAPSHOT_VERSION, toBase64 } from "./canonical";

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
  made_at: string;
  threads: Thread[];
  // Rows left out on purpose (private terms, stems, the private marker), and rows skipped
  // as malformed (no valid id or time). Signed, so the app can say how many it doesn't show.
  excluded_rows: number;
  skipped_rows: number;
}

export interface Snapshot extends Signed {
  sig: string;
  key_id: string;
}

export async function keyIdOf(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return hex(digest.slice(0, 8));
}

export const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// The snapshot's identity: the first 32 hex digits of the SHA-256 of its signed bytes. The Worker
// answers every PUT with the identity it holds, so an uploader that lost a response can tell whether
// its own snapshot is the one stored.
export async function snapshotId(s: Record<string, unknown>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signedBytes(s as any)));
  return hex(digest).slice(0, 32);
}

// Verifies with WebCrypto Ed25519 (Bun and Cloudflare Workers both have it). The public keys are
// raw 32 bytes each: the one whose key id the snapshot names is used (so a key can be rotated by
// listing the new one beside the old). Returns false for anything malformed rather than throwing,
// for an unknown version, app or purpose, and for a key id none of the keys has.
export async function verifySnapshot(snapshot: unknown, rawPublicKeys: Uint8Array | Uint8Array[]): Promise<boolean> {
  try {
    if (!snapshot || typeof snapshot !== "object") return false;
    const s = snapshot as Record<string, unknown>;
    if (!knownEnvelope(s)) return false;
    if (typeof s.sig !== "string" || typeof s.key_id !== "string") return false;
    if (typeof s.made_at !== "string" || !Array.isArray(s.threads)) return false;
    if (!isCount(s.excluded_rows) || !isCount(s.skipped_rows)) return false;
    const keys = Array.isArray(rawPublicKeys) ? rawPublicKeys : [rawPublicKeys];
    let raw: Uint8Array | undefined;
    for (const k of keys) if (k.length === 32 && (await keyIdOf(k)) === s.key_id) raw = k;
    if (!raw) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(s.sig), signedBytes(s as any));
  } catch {
    return false;
  }
}

// A comma-separated list of raw base64 public keys (the Worker's SNAPSHOT_PUBLIC_KEYS, the app's
// EXPO_PUBLIC_SURFACE_PUBLIC_KEY): the 32-byte ones, in order. Anything else in it is left out.
export function parseKeyList(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const part of (text || "").split(",")) {
    try {
      const k = fromBase64(part.trim());
      if (k.length === 32) out.push(k);
    } catch {}
  }
  return out;
}
