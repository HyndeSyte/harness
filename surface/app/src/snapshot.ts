// Reads the snapshot, checks its signature, and keeps only the fields the screen knows.
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { fromBase64, hex, signedBytes } from "../../shared/canonical";

ed.hashes.sha512 = sha512;

export const WHO = ["you", "cain", "a build job", "a laptop session", "at his PC"] as const;
export const STATES = ["running", "waiting on you", "at his PC", "moving"] as const;
// A who or state the app doesn't know shows as a plain "other" label, never dropped.
export type Who = (typeof WHO)[number] | "other";
export type State = (typeof STATES)[number] | "other";

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

export interface Snapshot {
  made_at: string;
  threads: Thread[];
  // Rows not shown: the exporter's signed counts (left out, skipped) and threads dropped here.
  hidden: number;
}

// signin: the read was redirected or blocked, as when the Access session has expired.
export type Loaded = { ok: true; snapshot: Snapshot } | { ok: false; reason: "unreadable" | "unverified" | "signin" };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function verify(raw: unknown, publicKeyB64: string): boolean {
  try {
    if (!raw || typeof raw !== "object") return false;
    const s = raw as Record<string, unknown>;
    if (s.version !== 1 || typeof s.sig !== "string" || typeof s.key_id !== "string") return false;
    if (typeof s.made_at !== "string" || !Array.isArray(s.threads)) return false;
    if (!isCount(s.excluded_rows) || !isCount(s.skipped_rows)) return false;
    const pub = fromBase64(publicKeyB64);
    if (pub.length !== 32) return false;
    if (s.key_id !== hex(sha256(pub)).slice(0, 16)) return false;
    return ed.verify(fromBase64(s.sig), signedBytes(s as any), pub);
  } catch {
    return false;
  }
}

const str = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is string => str(v) && !Number.isNaN(Date.parse(v));

// Only the known fields, each checked; a thread that doesn't fit is left out and counted.
export function sanitize(raw: { made_at: string; threads: unknown[]; excluded_rows?: number; skipped_rows?: number }): Snapshot {
  const threads: Thread[] = [];
  let dropped = 0;
  for (const t of raw.threads) {
    const r = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    if (
      !str(r.id) || !str(r.title) || !str(r.area) || !str(r.step) || !str(r.outcome) ||
      !isTime(r.last_moved) || (r.waits_for !== null && !str(r.waits_for))
    ) {
      dropped++;
      continue;
    }
    threads.push({
      id: r.id,
      title: r.title,
      area: r.area,
      who: (WHO as readonly unknown[]).includes(r.who) ? (r.who as Who) : "other",
      step: r.step,
      waits_for: (r.waits_for as string | null) || null,
      outcome: r.outcome,
      last_moved: r.last_moved,
      state: (STATES as readonly unknown[]).includes(r.state) ? (r.state as State) : "other",
    });
  }
  const hidden = (isCount(raw.excluded_rows) ? raw.excluded_rows : 0) + (isCount(raw.skipped_rows) ? raw.skipped_rows : 0) + dropped;
  return { made_at: raw.made_at, threads: sortThreads(threads), hidden };
}

// Newest move first; ties keep the record's order.
export function sortThreads(threads: Thread[]): Thread[] {
  return threads
    .map((t, i) => ({ t, i, at: Date.parse(t.last_moved) }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map((x) => x.t);
}

export function check(raw: unknown, publicKeyB64: string): Loaded {
  if (!verify(raw, publicKeyB64)) return { ok: false, reason: "unverified" };
  const s = raw as { made_at: string; threads: unknown[] };
  if (!isTime(s.made_at)) return { ok: false, reason: "unverified" };
  return { ok: true, snapshot: sanitize(s) };
}

type FetchLike = (
  u: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; type?: string; redirected?: boolean; json(): Promise<unknown> }>;

// The snapshot is read from the app's own origin. A redirect (Access sending an expired session
// to sign in) is never followed: it, an Access refusal, or a request the browser blocks all mean
// the owner should sign in again. Anything else that fails is unreadable.
export async function loadSnapshot(url: string, publicKeyB64: string, fetchImpl: FetchLike = (u, init) => fetch(u, init)): Promise<Loaded> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
  } catch {
    return { ok: false, reason: "signin" };
  }
  if (res.type === "opaqueredirect" || res.redirected || res.status === 0 || res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400))
    return { ok: false, reason: "signin" };
  if (!res.ok) return { ok: false, reason: "unreadable" };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return check(raw, publicKeyB64);
}
