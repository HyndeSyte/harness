// The snapshot's shape and its canonical form, shared by the exporter and the Worker.
// The app keeps its own copy of the canonical form (surface/app/src/canonical.ts): Metro
// bundles only what is under the app, and a test there checks a snapshot this exporter signed.

export const WHO = ["you", "cain", "a build job", "a laptop session", "at his PC"] as const;
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
}

export interface Snapshot extends Signed {
  sig: string;
  key_id: string;
}

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

// What the signature covers: exactly these three fields of the snapshot as received.
export function signedBytes(s: { version: unknown; made_at: unknown; threads: unknown }): Uint8Array {
  return new TextEncoder().encode(canonical({ version: s.version, made_at: s.made_at, threads: s.threads }));
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function keyIdOf(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Verifies with WebCrypto Ed25519 (Bun and Cloudflare Workers both have it). The public key
// is the raw 32 bytes. Returns false for anything malformed rather than throwing.
export async function verifySnapshot(snapshot: unknown, rawPublicKey: Uint8Array): Promise<boolean> {
  try {
    if (!snapshot || typeof snapshot !== "object") return false;
    const s = snapshot as Record<string, unknown>;
    if (s.version !== 1 || typeof s.sig !== "string" || typeof s.key_id !== "string") return false;
    if (typeof s.made_at !== "string" || !Array.isArray(s.threads)) return false;
    if (s.key_id !== (await keyIdOf(rawPublicKey))) return false;
    const key = await crypto.subtle.importKey("raw", rawPublicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(s.sig), signedBytes(s as any));
  } catch {
    return false;
  }
}
