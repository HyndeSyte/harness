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

// Keeper 0.1.10: version 2, bound to the keeper's current enrollment, the old key's id and the single-use challenge its
// GET /rotation issued: {v: 2, kind, id, enroll, challenge, exp}. The tap's flow (attestFlow) reads /rotation fresh at the
// tap, so the challenge is the keeper's newest, and the link signs only for the id the card named.
export const ROTATION_TTL_S = 3600;               // an attestation is good an hour after the tap
export const ROTATION_ID = /^[0-9a-f]{12}$/;      // the old key's id as the keeper gives it
export const ROTATION_KIND = "hc-key-rotated";
export const ROTATION_PROOF_TAP = "attested by your tap only";   // the keeper kept no old key, so nothing can be tried
const ENROLL = /^[0-9a-f]{16}$/, CHALLENGE = /^[0-9a-f]{24}$/;

export function makeRotation(id: string, enroll: string, challenge: string, nowMs: number, sign: (data: Buffer) => Buffer): string {
  if (!ROTATION_ID.test(id)) throw new Error("not an old key's id");
  if (!ENROLL.test(enroll) || !CHALLENGE.test(challenge)) throw new Error("no enrollment or challenge from the keeper");
  const payload = b64url(Buffer.from(JSON.stringify({ v: 2, kind: ROTATION_KIND, id, enroll, challenge, exp: Math.floor(nowMs / 1000) + ROTATION_TTL_S })));
  return `rot1.${payload}.${b64url(sign(Buffer.from(`rot1.${payload}`, "utf8")))}`;
}

// The keeper's GET /rotation answer, judged: the id a card is needed for, whether the keeper kept the old key (false: the
// card says "attested by your tap only"), and the enrollment and challenge a tap's attestation is bound to; or null (none
// needed, the old option still in the keeper's options, or an answer that can't be read).
export interface RotationNeed { id: string; kept: boolean; enroll: string | null; challenge: string | null }
export function rotationNeeded(body: any): RotationNeed | null {
  if (!body || body.needed !== true || body.old_option_present === true) return null;
  const id = typeof body.old_key_id === "string" ? body.old_key_id : "";
  if (!ROTATION_ID.test(id)) return null;
  return { id, kept: body.old_key_kept !== false, enroll: ENROLL.test(String(body.enroll_id ?? "")) ? body.enroll_id : null, challenge: CHALLENGE.test(String(body.challenge ?? "")) ? body.challenge : null };
}

// His tap's attestation: /rotation read fresh, the id must still be the card's, then signed with that enrollment and
// challenge and posted. The signing happens only here, after the link checked the tap is his (core.ts rotationTap).
export interface AttestDeps {
  get: (path: string) => Promise<{ status: number; body: any } | null>;
  post: (path: string, body: unknown) => Promise<{ status: number; body: any } | null>;
  sign: (data: Buffer) => Buffer;
  now: () => number;
}
export async function attestFlow(d: AttestDeps, id: string): Promise<{ ok: boolean; why: string }> {
  const v = await d.get("/rotation").catch(() => null);
  if (!v || v.status !== 200) return { ok: false, why: "the keeper didn't answer for the rotation's challenge" };
  const need = rotationNeeded(v.body);
  if (!need) return { ok: false, why: v.body?.old_option_present === true ? "the old option is still in the keeper's options" : "the keeper says no rotation is needed now" };
  if (need.id !== id) return { ok: false, why: `the keeper now names old key ${need.id}, not the card's ${id}` };
  if (!need.enroll || !need.challenge) return { ok: false, why: "the keeper gave no enrollment or challenge (its Ship key isn't enrolled)" };
  const r = await d.post("/rotation/attest", { attestation: makeRotation(id, need.enroll, need.challenge, d.now(), d.sign) }).catch(() => null);
  if (!r) return { ok: false, why: "the keeper didn't answer" };
  return r.status === 200 ? { ok: true, why: "" } : { ok: false, why: typeof r.body?.why === "string" ? r.body.why : `the keeper answered ${r.status}` };
}
