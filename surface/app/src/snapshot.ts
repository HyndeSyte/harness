// Reads the snapshot, checks its signature, and keeps only the fields the screen knows.
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { canonical, fromBase64, utf8 } from "./canonical";

ed.hashes.sha512 = sha512;

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

export interface Snapshot {
  made_at: string;
  threads: Thread[];
}

export type Loaded = { ok: true; snapshot: Snapshot } | { ok: false; reason: "unreadable" | "unverified" };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function verify(raw: unknown, publicKeyB64: string): boolean {
  try {
    if (!raw || typeof raw !== "object") return false;
    const s = raw as Record<string, unknown>;
    if (s.version !== 1 || typeof s.sig !== "string" || typeof s.key_id !== "string") return false;
    if (typeof s.made_at !== "string" || !Array.isArray(s.threads)) return false;
    const pub = fromBase64(publicKeyB64);
    if (pub.length !== 32) return false;
    if (s.key_id !== hex(sha256(pub)).slice(0, 16)) return false;
    const msg = utf8(canonical({ version: s.version, made_at: s.made_at, threads: s.threads }));
    return ed.verify(fromBase64(s.sig), msg, pub);
  } catch {
    return false;
  }
}

const str = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is string => str(v) && !Number.isNaN(Date.parse(v));

// Only the known fields, each checked; a thread that doesn't fit is left out.
export function sanitize(raw: { made_at: string; threads: unknown[] }): Snapshot {
  const threads: Thread[] = [];
  for (const t of raw.threads) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (!str(r.id) || !str(r.title) || !str(r.area) || !str(r.step) || !str(r.outcome)) continue;
    if (!(WHO as readonly unknown[]).includes(r.who) || !(STATES as readonly unknown[]).includes(r.state)) continue;
    if (!isTime(r.last_moved)) continue;
    if (r.waits_for !== null && !str(r.waits_for)) continue;
    threads.push({
      id: r.id,
      title: r.title,
      area: r.area,
      who: r.who as Who,
      step: r.step,
      waits_for: (r.waits_for as string | null) || null,
      outcome: r.outcome,
      last_moved: r.last_moved,
      state: r.state as State,
    });
  }
  return { made_at: raw.made_at, threads: sortThreads(threads) };
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

export async function loadSnapshot(
  url: string,
  publicKeyB64: string,
  fetchImpl: (u: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<Loaded> {
  let raw: unknown;
  try {
    const res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return { ok: false, reason: "unreadable" };
    raw = await res.json();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return check(raw, publicKeyB64);
}
