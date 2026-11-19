// The snapshot's shape, shared by the exporter and the Worker. The canonical form lives in
// ./canonical.ts, the one module the exporter, the Worker and the app all import.
import { fromBase64, hex, signedBytes } from "./canonical";

export { canonical, fromBase64, signedBytes, toBase64 } from "./canonical";

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
  version: 1;
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

// Verifies with WebCrypto Ed25519 (Bun and Cloudflare Workers both have it). The public key
// is the raw 32 bytes. Returns false for anything malformed rather than throwing.
export async function verifySnapshot(snapshot: unknown, rawPublicKey: Uint8Array): Promise<boolean> {
  try {
    if (!snapshot || typeof snapshot !== "object") return false;
    const s = snapshot as Record<string, unknown>;
    if (s.version !== 1 || typeof s.sig !== "string" || typeof s.key_id !== "string") return false;
    if (typeof s.made_at !== "string" || !Array.isArray(s.threads)) return false;
    if (!isCount(s.excluded_rows) || !isCount(s.skipped_rows)) return false;
    if (s.key_id !== (await keyIdOf(rawPublicKey))) return false;
    const key = await crypto.subtle.importKey("raw", rawPublicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(s.sig), signedBytes(s as any));
  } catch {
    return false;
  }
}
