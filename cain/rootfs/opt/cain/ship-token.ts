// Dane's Ship approval, signed (wave 1, piece B). When he taps Ship on a Ship card,
// Cain's link signs the repository, the pull request, its head commit and an expiry
// with its own Ed25519 key, which nothing else on the box may read. Cain's Ship job
// carries that token: the RemoteTrigger hook checks it before a Ship run starts, and
// the job posts it on the pull request, where GitHub's ship check verifies it against
// the public key kept on main. So the approval is his tap, checked in code, not a
// sentence Cain writes.
//
// A token is "ship1.<payload>.<signature>", both base64url; the payload is the claim as
// JSON, and the signature covers "ship1.<payload>". This file holds no key: signing is
// passed in, and checking needs only the public key (SPKI DER, base64).
import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

export const PREFIX = "ship1";
export const TTL_S = 30 * 60;                    // an approval is good for 30 minutes after his tap
export const TOKEN = /(?<![A-Za-z0-9_.-])ship1\.[A-Za-z0-9_-]{20,600}\.[A-Za-z0-9_-]{86}(?![A-Za-z0-9_-])/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
export const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

export interface Claim { v: 1; repo: string; pr: number; head: string; exp: number }

export function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// The claim for his tap on a Ship card for this pull request address and head.
export function claimFor(pull: string, head: string, nowMs: number): Claim | null {
  const m = PULL_URL.exec(pull);
  const h = head.toLowerCase();
  if (!m || !SHA.test(h)) return null;
  return { v: 1, repo: m[1], pr: Number(m[2]), head: h, exp: Math.floor(nowMs / 1000) + TTL_S };
}

export function makeToken(claim: Claim, sign: (data: Buffer) => Buffer): string {
  const payload = b64url(Buffer.from(JSON.stringify(claim), "utf8"));
  return `${PREFIX}.${payload}.${b64url(sign(Buffer.from(`${PREFIX}.${payload}`, "utf8")))}`;
}

// The public key from its base64 (SPKI DER); throws unless it's an Ed25519 key.
export function publicKey(spkiB64: string): KeyObject {
  const k = createPublicKey({ key: Buffer.from(spkiB64.trim(), "base64"), format: "der", type: "spki" });
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return k;
}

export type Checked = { ok: true; claim: Claim } | { ok: false; why: string };

// A token, checked: signed by this key, well formed, and not expired at nowMs.
export function readToken(token: string, key: KeyObject, nowMs: number): Checked {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2]))
    return { ok: false, why: "it isn't a Ship token" };
  const sig = unb64url(parts[2]);
  let good = false;
  try { good = sig.length === 64 && edVerify(null, Buffer.from(`${PREFIX}.${parts[1]}`, "utf8"), key, sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its signature doesn't match the Ship key" };
  let c: any;
  try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its claim can't be read" }; }
  if (!c || c.v !== 1 || typeof c.repo !== "string" || !REPO.test(c.repo) || !Number.isSafeInteger(c.pr) || c.pr < 1
    || typeof c.head !== "string" || !SHA.test(c.head) || !Number.isSafeInteger(c.exp))
    return { ok: false, why: "its claim isn't a Ship approval" };
  if (c.exp * 1000 <= nowMs) return { ok: false, why: "it expired (an approval lasts 30 minutes after his tap)" };
  return { ok: true, claim: { v: 1, repo: c.repo, pr: c.pr, head: c.head, exp: c.exp } };
}

// The first Ship token standing on its own in a text, or null.
export function findToken(text: string): string | null {
  return TOKEN.exec(text)?.[0] ?? null;
}

export function pullOf(c: Claim): string { return `https://github.com/${c.repo}/pull/${c.pr}`; }
