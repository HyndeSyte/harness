// The old Healthchecks key's rotation (Cain 0.19.0, Keeper 0.1.9). While the keeper App has seen an old key in its
// options (hc_api_key), it refuses to arm until the owner attests the key was rotated. The keeper exposes that state
// (GET /rotation: whether a tap is needed, and the old key's id, a hash, never the key) and an attestation route
// (POST /rotation/attest). The link reads the state with the minute's armed read (main.ts askKeeper), posts one card
// naming that id (core.ts rotationCard), and only the owner's tap on it makes the attestation: signed here with the
// link's Ship key, which Cain can't read, so nothing Cain writes himself (a note, a message, a call of his own) ever
// satisfies it. The keeper checks the signature with the key it pinned and the owner confirmed, and where it kept
// the old key it first tries it at the alert service and needs it rejected.
//   "rot1.<payload>.<signature>", both base64url; payload {v: 1, kind: "hc-key-rotated", id, exp}, the signature
//   over "rot1.<payload>" (keeper core.ts attestRotation reads it).
import { b64url } from "../ship-token";

export const ROTATION_TTL_S = 3600;               // an attestation is good an hour after the tap
export const ROTATION_ID = /^[0-9a-f]{12}$/;      // the old key's id as the keeper gives it
export const ROTATION_KIND = "hc-key-rotated";

export function makeRotation(id: string, nowMs: number, sign: (data: Buffer) => Buffer): string {
  if (!ROTATION_ID.test(id)) throw new Error("not an old key's id");
  const payload = b64url(Buffer.from(JSON.stringify({ v: 1, kind: ROTATION_KIND, id, exp: Math.floor(nowMs / 1000) + ROTATION_TTL_S })));
  return `rot1.${payload}.${b64url(sign(Buffer.from(`rot1.${payload}`, "utf8")))}`;
}

// The keeper's GET /rotation answer, judged: the id a card is needed for, or null (none needed, the old option still
// in the keeper's options, or an answer that can't be read).
export function rotationNeeded(body: any): string | null {
  if (!body || body.needed !== true || body.old_option_present === true) return null;
  const id = typeof body.old_key_id === "string" ? body.old_key_id : "";
  return ROTATION_ID.test(id) ? id : null;
}
