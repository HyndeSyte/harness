// Dane's go for one paid model trial run (Cain 0.19.0, fifth round). The same shape as the Ship token
// (ship-token.ts): when he taps "Allow this run" on Cain's trial card, Cain's link signs the suite, the
// exact plan (its hash, as `trial.sh plan` prints it), the run's cap in cents, a random nonce and an expiry
// 2 hours on, with its own Ed25519 trial key (link/trial.key, a key of its own, so a trial approval can
// never pass as a Ship token or the other way round). Cain passes the token to `trial.sh run` or
// `trial.sh preflight`; the trials runner (as root) checks it against the public half, checks the plan and
// the cap are the ones it would run, and consumes the nonce atomically before anything is dispatched.
//
// A token is "trial1.<payload>.<signature>", both base64url; the signature covers "trial1.<payload>".
import { createPublicKey, randomBytes, verify as edVerify, type KeyObject } from "node:crypto";

export const TRIAL_PREFIX = "trial1";
export const TRIAL_TTL_S = 2 * 3600;          // good for 2 hours after his tap
const SKEW_S = 5 * 60;
export const TRIAL_SUITES = ["review-seats", "research", "preflight"] as const;
export type TrialTarget = (typeof TRIAL_SUITES)[number];
export const TRIAL_TOKEN = /(?<![A-Za-z0-9_.-])trial1\.[A-Za-z0-9_-]{20,800}\.[A-Za-z0-9_-]{86}(?![A-Za-z0-9_-])/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
// The most a single approval may name (the trials budget option's own ceiling, in cents).
export const TRIAL_CAP_MAX_CENTS = 50_000;

export interface TrialClaim { v: 1; kind: "trial"; suite: TrialTarget; plan: string; cap_cents: number; nonce: string; exp: number }

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
export const centsOf = (usd: number) => Math.round(usd * 100);

// The claim for his tap on a trial card: null when the card's suite, plan or cap isn't well formed.
export function trialClaimFor(t: { suite: string; plan: string; capUsd: number }, nowMs: number, nonce = randomBytes(16).toString("hex")): TrialClaim | null {
  const cents = centsOf(t.capUsd);
  if (!(TRIAL_SUITES as readonly string[]).includes(t.suite) || !HASH.test(t.plan) || !Number.isSafeInteger(cents) || cents <= 0 || cents > TRIAL_CAP_MAX_CENTS || !NONCE.test(nonce)) return null;
  return { v: 1, kind: "trial", suite: t.suite as TrialTarget, plan: t.plan, cap_cents: cents, nonce, exp: Math.floor(nowMs / 1000) + TRIAL_TTL_S };
}

export function makeTrialToken(c: TrialClaim, sign: (data: Buffer) => Buffer): string {
  const payload = b64url(Buffer.from(JSON.stringify(c), "utf8"));
  return `${TRIAL_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${TRIAL_PREFIX}.${payload}`, "utf8")))}`;
}

export function trialPublicKey(spkiB64: string): KeyObject {
  const k = createPublicKey({ key: Buffer.from(spkiB64.trim(), "base64"), format: "der", type: "spki" });
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return k;
}

export type TrialChecked = { ok: true; claim: TrialClaim } | { ok: false; why: string };
// Signed by this key, well formed, and not expired at nowMs.
export function readTrialToken(token: string, key: KeyObject, nowMs: number): TrialChecked {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== TRIAL_PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return { ok: false, why: "it isn't a trial approval" };
  const sig = unb64url(parts[2]);
  let good = false;
  try { good = sig.length === 64 && edVerify(null, Buffer.from(`${TRIAL_PREFIX}.${parts[1]}`, "utf8"), key, sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its signature doesn't match the link's trial key" };
  let c: any;
  try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its claim can't be read" }; }
  if (!c || c.v !== 1 || c.kind !== "trial" || !(TRIAL_SUITES as readonly string[]).includes(c.suite) || typeof c.plan !== "string" || !HASH.test(c.plan)
    || !Number.isSafeInteger(c.cap_cents) || c.cap_cents <= 0 || c.cap_cents > TRIAL_CAP_MAX_CENTS || typeof c.nonce !== "string" || !NONCE.test(c.nonce) || !Number.isSafeInteger(c.exp))
    return { ok: false, why: "its claim isn't a trial approval" };
  if (c.exp * 1000 <= nowMs) return { ok: false, why: "it expired (an approval lasts 2 hours after his tap)" };
  if (c.exp * 1000 > nowMs + (TRIAL_TTL_S + SKEW_S) * 1000) return { ok: false, why: "its expiry is further off than an approval lasts" };
  return { ok: true, claim: { v: 1, kind: "trial", suite: c.suite, plan: c.plan, cap_cents: c.cap_cents, nonce: c.nonce, exp: c.exp } };
}
export const findTrialToken = (text: string): string | null => TRIAL_TOKEN.exec(text)?.[0] ?? null;
