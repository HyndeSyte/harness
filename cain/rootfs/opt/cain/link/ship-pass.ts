// The Ship pass (Cain 0.19.0, with Keeper 0.1.3, 0.1.4 and 0.1.5): each Ship token starts one Ship run,
// and that run starts only once every watched App it installs is accepted by the keeper App, and claimed.
//
// Cain's RemoteTrigger hook (../hooks/remote-trigger.ts) checks a Ship run's token itself, then asks the
// link here (POST /ship-pass {token}, Cain's key) before it lets the run through. The link:
//   1. checks the token again with its own public Ship key;
//   2. refuses a token it has already let through ("spent"): one Ship run per token. The ids (hashes,
//      never the token) and each one's state are kept in root's /data/trust, which Cain can't write, until
//      the token would have expired anyway;
//   3. on a token's first ask, records it as registering and registers every watched App the tap installs
//      with the keeper App (POST /attempt on its own service, with Cain's keeper_token): the token itself,
//      the pull request and head, the App, its version at the base and at the head, and the probe hash.
//      (Keeper 0.1.5) The keeper answers 202 at once and makes the App-only backup in the background; the
//      link polls GET /attempt/<id> until it is accepted or refused (5 minutes per App), so no request is
//      held open through the backup. The pass answers "pending" meanwhile, and gives up after 5 minutes per
//      watched App plus 1 (passWaitMs), cancelling every registration it made (POST /attempt/<id>/cancel);
//   4. (Keeper 0.1.5) checks every acceptance and claim answer's enrollment: the keeper's pinned key must
//      have the fingerprint committed at the pull request's head (cain/SHIP_KEY_FINGERPRINT, which must also
//      be the link's own key's), confirmed by the owner, and the keeper's state must be no newer than the
//      one the link recorded at the last confirmed enrollment (recorded when it sees the owner's confirm);
//   5. once every watched App is accepted, at the hook's next ask, claims each acceptance (POST
//      /attempt/<id>/claim: atomic and single use at the keeper, valid 30 minutes) and answers "ok" with
//      each claim id and deadline, recording the token as passed first, and writes the ok line to its log:
//      "Ship pass ok: <attempt id> claim <claim id> until <time>". A claim refused, or anything that can't
//      be read, refuses the pass for good and cancels the rest (a new Ship card makes a new token).
//   6. (Keeper 0.1.6) refuses and cancels, rather than passes, a claim with under 20 minutes left
//      (CLAIM_START_MIN_MS); the hook checks the same deadline again in code just before it lets the run
//      start, and when it refuses it asks the link (POST /ship-pass {token, cancel}) to cancel the claims;
//   7. (Keeper 0.1.6) requires the keeper's state creation and confirm times to equal the recorded ones (an
//      older or a newer state is refused; a different state counts only through a confirm newer than the
//      record), and records the enrollment from the minute-by-minute /armed read as well as from a pass.
//   8. (Keeper 0.1.7) records the keeper's enrollment id and counter with the enrollment, and refuses any lower
//      counter (an older keeper state) and any earlier enrollment id it has seen (a replayed confirm); a new
//      enrollment id, the owner's key-confirm with a fresh code, is the explicit re-enrollment after a restore or
//      a clock correction. Each check compares against the record as it stood before the request was sent, so a
//      concurrent read's newer counter can't make an answer look old. The claim carries a request id, and a
//      claim that got no answer is asked once more with it: the keeper answers a retry with the recorded claim.
//   9. (Keeper 0.1.8) a brand-new enrollment id (one the link has never seen) sets the recorded counter to the value
//      that enrollment carries, however far below the old one (a keeper restored from a backup and re-enrolled by the
//      owner), and counters only go up within that id after; a reply for an enrollment the link has since replaced
//      (by a concurrent read) is discarded even when the record as it stood before its request allowed it. A pass
//      refused on the enrollment cancels its registrations saying so ("enrollment counter behind the link" for an
//      older keeper state, else "enrollment refused by the link"), so the keeper logs it and prints a key code. A
//      second run on a token that already passed is refused naming its claims' latest expiry while one is live.
// Why the link and not the Ship run: the Ship run is a cloud session, and the keeper's service is only
// on Home Assistant's internal App network. The Home Assistant connector can't reach it, and the link,
// on the same network, already talks to the keeper with Cain's token. So no options are written at all.
import { createHash } from "node:crypto";
import { publicKey, readToken, type Claim } from "../ship-token";
import { bumpsAt, fileAt, type MergeDeps, versionAt } from "./merge";
import { markHash, type DrillDeps, type DrillMode } from "./drill";

export const PASS_FORMAT = 2;                     // 0.1.4: entries carry their state (format 1 entries count as passed)
export const ATTEMPT_WAIT_MS = 5 * 60_000;        // (0.1.5) one App's registration polled for this long
export const passWaitMs = (apps: number, waitMs = ATTEMPT_WAIT_MS) => Math.max(1, apps) * waitMs + 60_000;   // (0.1.5) the whole pass
// (Keeper 0.1.15) item 6: the wait for Keeper's "accepted", outside the hook's 10 second bound, is the option keeper_accept_min
// (1 to 15 minutes, default 5); anything else read is the default.
export const acceptWaitMs = (v?: string | null) => { const n = Number(v); return v && Number.isInteger(n) && n >= 1 && n <= 15 ? n * 60_000 : ATTEMPT_WAIT_MS; };
export const PASS_WAIT_MS = passWaitMs(1);        // one watched App: 6 minutes
export const POLL_MS = 5_000;                     // (0.1.5) GET /attempt/<id> every 5 seconds
export const CLAIMING_STUCK_MS = 60_000;
export const CLAIM_START_MIN_MS = 20 * 60_000;    // (Keeper 0.1.6) a claim with less left than this never starts a run          // (0.1.5) a pass left "claiming" (a restart mid-claim) is refused after this
export const FINGERPRINT_FILE = "cain/SHIP_KEY_FINGERPRINT";
const FP = /^[0-9a-f]{16}$/;
const BACKUP_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
// (Keeper 0.1.13) a drill registration's attempt is "drill-...", the same shape (drill.ts)
const ATTEMPT_ID = /^(?:ship|drill)-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
const CLAIM_ID = /^claim-[0-9a-f]{16}$/;
export const PROBE_FILES: Record<string, string> = { Cain: "cain/rootfs/opt/cain/probe/keeper.ts" };
export const APP_SLUGS: Record<string, string> = { Cain: "0fcc2575_cain", Harness: "0fcc2575_harness" };
// The Apps the keeper watches, so only their installs are registered (Keeper's default watch list).
export const WATCHED = new Set(["0fcc2575_cain"]);
const CONFIGS: Record<string, string> = { Cain: "cain/config.yaml", Harness: "harness/config.yaml" };

export const passId = (token: string) => createHash("sha256").update(`ship-pass-v1\n${token.trim()}`).digest("hex").slice(0, 32);
// A public key's fingerprint, as the keeper computes it (keyFp): the first 16 hex digits of the SHA-256 of
// its DER bytes.
export const keyFingerprint = (spkiB64: string) => createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex").slice(0, 16);
// cain/SHIP_KEY_FINGERPRINT: "#" lines are comments; the first other line is the fingerprint. "" when none.
export function readFingerprintFile(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return FP.test(line.toLowerCase()) ? line.toLowerCase() : "";
}

// -- enrollment (Keeper 0.1.5) ----------------------------------------------------------------------------
// The link's record of the last confirmed enrollment it saw: the fingerprint, the keeper's state creation
// time and the owner's confirm time (ms), in root's /data/trust. Keeper 0.1.7: the confirm's enrollment id,
// the highest counter seen under it, and the earlier enrollment ids seen (a replay of one is refused).
export interface Enrollment { fp: string; stateCreated: number; confirmedAt: number; enrollId: string; counter: number; seen: string[] }
export interface EnrollmentStore { load: () => Enrollment | null; store: (e: Enrollment) => void }
const ENROLL_ID = /^[0-9a-f]{16}$/;
// (Keeper 0.1.8) The why of a cancel after an enrollment refusal, as the keeper reads it (keeper core.ts ENROLL_BEHIND,
// ENROLL_REFUSED): an older keeper state (a lower counter, an older state, an earlier enrollment), or any other refusal.
export const ENROLL_BEHIND = "enrollment counter behind the link";
export const ENROLL_REFUSED = "enrollment refused by the link";
export function parseEnrollment(text: string | null): Enrollment | null {
  try {
    const j = JSON.parse(text ?? "");
    return FP.test(j?.fp) && Number(j.stateCreated) > 0 && Number(j.confirmedAt) > 0 && ENROLL_ID.test(j.enrollId) && Number.isSafeInteger(j.counter) && j.counter >= 0
      ? { fp: j.fp, stateCreated: Number(j.stateCreated), confirmedAt: Number(j.confirmedAt), enrollId: j.enrollId, counter: j.counter,
        seen: Array.isArray(j.seen) ? j.seen.filter((x: unknown) => typeof x === "string" && ENROLL_ID.test(x)).slice(-50) : [] } : null;
  } catch { return null; }
}
// An answer from the keeper (an acceptance, a claim, or /armed) judged against the committed fingerprint
// and the recorded enrollment, as it stood before the request was sent. Keeper 0.1.7: an enrollment id the link
// hasn't seen, for the committed fingerprint and confirmed after the keeper's state was created, is the owner's
// confirm seen (a first enrollment or a re-enrollment): the record moves to it (record). The same id needs the
// same state and confirm times and a counter no lower than the record's (a higher one is recorded).
export type EnrollmentJudged = { ok: true; record?: Enrollment; superseded?: true } | { ok: false; why: string; record?: Enrollment; cancel?: string };
export function enrollmentCheck(ans: any, committed: string, linkFp: string | null, rec: Enrollment | null): EnrollmentJudged {
  const r = judgeEnrollment(ans, committed, linkFp, rec);
  if (r.ok) return r;
  // (Keeper 0.1.8) what the keeper is told with the cancel
  return { ...r, cancel: /lower than|an older keeper state|earlier confirmation the link has seen replaced/.test(r.why) ? `${ENROLL_BEHIND}: ${r.why}`.slice(0, 160) : `${ENROLL_REFUSED}: ${r.why}`.slice(0, 160) };
}
// (Keeper 0.1.8) The reply judged against the record as it stood before its request, then against the record as it
// stands now: a reply for an enrollment the link has since replaced (its id among the replaced ones) is discarded.
export function enrollmentCheckNow(ans: any, committed: string, linkFp: string | null, before: Enrollment | null, store: EnrollmentStore | undefined): EnrollmentJudged {
  const r = enrollmentCheck(ans, committed, linkFp, before);
  if (!r.ok) return r;
  let cur: Enrollment | null = null;
  try { cur = store?.load() ?? null; } catch { cur = null; }
  const eid = String(ans?.enroll_id ?? "");
  if (cur && cur.enrollId !== eid && cur.seen.includes(eid))
    return { ok: false, why: `the keeper's reply is for enrollment ${eid}, which the link has replaced (by ${cur.enrollId}) since the request was sent: discarded`, cancel: `${ENROLL_BEHIND}: a reply for a replaced enrollment` };
  // (Keeper 0.1.10) Out of order within one enrollment: a reply valid against the record before its request, whose counter is
  // below the one a later reply already recorded, is superseded: discarded, never recorded, and no refusal or re-enrollment.
  const counter = Number(ans?.counter);
  if (cur && cur.enrollId === eid && Number.isSafeInteger(counter) && counter < cur.counter) return { ok: true, superseded: true };
  return r;
}
function judgeEnrollment(ans: any, committed: string, linkFp: string | null, rec: Enrollment | null): { ok: true; record?: Enrollment } | { ok: false; why: string; record?: Enrollment } {
  if (!FP.test(committed)) return { ok: false, why: `${FINGERPRINT_FILE} at the head holds no fingerprint (the Build run when the link's Ship key is made writes it)` };
  if (linkFp && committed !== linkFp) return { ok: false, why: `${FINGERPRINT_FILE} at the head (${committed}) isn't the link's own Ship key (${linkFp})` };
  const fp = typeof ans?.key_fp === "string" ? ans.key_fp : "";
  if (fp !== committed) return { ok: false, why: `the keeper pinned the Ship key ${fp || "(none)"}, not the committed ${committed}` };
  const created = Date.parse(String(ans?.state_created ?? "")), confirmed = Date.parse(String(ans?.key_confirmed_at ?? ""));
  if (!Number.isFinite(created)) return { ok: false, why: "the keeper's answer doesn't say when its state was created" };
  if (!Number.isFinite(confirmed)) return { ok: false, why: "the keeper's pinned key isn't confirmed by the owner (key-confirm at the device)" };
  const eid = typeof ans?.enroll_id === "string" ? ans.enroll_id : "", counter = ans?.counter;
  if (!ENROLL_ID.test(eid) || !Number.isSafeInteger(counter) || counter < 0) return { ok: false, why: "the keeper's answer carries no enrollment id or counter (Keeper 0.1.7 or later is needed)" };
  const again = "the owner confirms the key at the device again (key-code at the keeper prints a fresh code, then key-confirm with it)";
  if (!rec || rec.enrollId !== eid) {
    if (rec && rec.seen.includes(eid)) return { ok: false, why: `the keeper's enrollment ${eid} is an earlier confirmation the link has seen replaced (an older keeper state, or a replay): ${again}` };
    if (confirmed < created) return { ok: false, why: "the keeper's key was confirmed before its state was created" };
    return { ok: true, record: { fp: committed, stateCreated: created, confirmedAt: confirmed, enrollId: eid, counter, seen: rec ? [...rec.seen, rec.enrollId].slice(-50) : [] } };
  }
  if (rec.fp !== committed) return { ok: false, why: `the enrollment the link recorded is for ${rec.fp}, not the committed ${committed}: ${again}` };
  if (counter < rec.counter) return { ok: false, why: `the keeper's counter (${counter}) is lower than the ${rec.counter} the link recorded: an older keeper state (a restore?) is refused; ${again}` };
  // (Keeper 0.1.6) the very state and confirm the link recorded: an older or newer state is refused too
  if (created > rec.stateCreated) return { ok: false, why: `the keeper's state was created ${new Date(created).toISOString()}, after the enrollment the link recorded (${new Date(rec.stateCreated).toISOString()}): ${again}` };
  if (created < rec.stateCreated) return { ok: false, why: `the keeper's state was created ${new Date(created).toISOString()}, before the enrollment the link recorded (${new Date(rec.stateCreated).toISOString()}): an older keeper state is refused; ${again}` };
  if (confirmed !== rec.confirmedAt) return { ok: false, why: `the keeper's key was confirmed ${new Date(confirmed).toISOString()}, not at the confirm the link recorded (${new Date(rec.confirmedAt).toISOString()}): ${again}` };
  return counter > rec.counter ? { ok: true, record: { ...rec, counter } } : { ok: true };
}
// (Keeper 0.1.6) The enrollment seen in the keeper's minute-by-minute /armed answer, judged against the
// link's own key's fingerprint: a confirm newer than the record is recorded there too, outside any pass.
// Keeper 0.1.7: before is the record as it stood before the read was sent (main.ts loads it first).
export function noteArmedEnrollment(ans: any, linkFp: string | null, e: EnrollmentStore | undefined, log: (l: string) => void, before?: Enrollment | null): void {
  if (!linkFp || !e) return;
  const en = enrollmentCheckNow(ans, linkFp, linkFp, before === undefined ? e.load() : before, e);
  if (en.ok && en.superseded) { log(`a keeper reply with counter ${ans?.counter} arrived after a newer one: superseded, discarded (the highest counter is kept)`); return; }
  if (en.record) noteRecord(e, en.record, log);
}
// Keeper 0.1.7: a counter is only ever raised (a concurrent read may have stored a higher one meanwhile), and the
// line is logged only for a new enrollment, not for each counter step.
const noteRecord = (e: EnrollmentStore | undefined, r: Enrollment | undefined, log: (l: string) => void) => {
  if (!e || !r) return;
  try {
    const cur = e.load();
    if (cur && cur.enrollId === r.enrollId) { if (r.counter > cur.counter) e.store({ ...cur, counter: r.counter }); return; }
    if (cur && cur.seen.includes(r.enrollId)) { log(`a reply for the keeper's replaced enrollment ${r.enrollId} wasn't recorded`); return; }   // (Keeper 0.1.8)
    e.store(r); log(`the owner's confirm of the keeper's Ship key ${r.fp} seen: enrollment recorded (enrollment ${r.enrollId}, keeper state created ${new Date(r.stateCreated).toISOString()}, counter ${r.counter})`);
  } catch { log("couldn't record the keeper's enrollment"); }
};

export interface Accepted { app: string; attempt: string; backup: string; from?: string; to?: string; main?: string }   // (Cain 0.19.4) main: backed up first, the tap's main commit
export interface Claimed { attempt: string; claim: string; until: string }
export type RegResult = { ok: true; accepted: Accepted[]; said: string[]; fp?: string } | { ok: false; said: string[]; cancel?: string };   // (Keeper 0.1.8) cancel: the enrollment refusal's why
type Entry = { id: string; exp: number; state: "registering" | "accepted" | "claiming" | "refused" | "passed"; at: number; said?: string; accepted?: Accepted[];
  apps?: number; attempts?: string[]; fp?: string; claims?: Claimed[]; claimingAt?: number };
export interface PassDeps {
  pub: () => string | null;                      // the link's public Ship key (base64 SPKI), as /data/trust/ship.pub holds it
  now: () => number;
  load: () => string | null;                     // the pass file's text (null: none yet)
  store: (text: string) => void;                 // writes it whole; throws on failure
  // the keeper registration, in the background; note(upd) keeps how many Apps and which attempts it made
  register: (token: string, claim: Claim, done: (r: RegResult) => void, note: (upd: { apps?: number; attempt?: string }) => void) => void;
  claim?: (a: Accepted, request: string) => Promise<{ status: number; body: any } | null>;   // (0.1.5) POST /attempt/<id>/claim (Keeper 0.1.7: with its request id)
  // (0.1.5) POST /attempt/<id>/cancel. Keeper 0.1.11: its answer judged when given: only a plain "ended" counts; anything else
  // (pending, refused, an error, no answer) is no success, logged, and the owner gets a card offering a retry (retry)
  cancel?: (attempt: string, why: string) => Promise<{ status: number; body: any } | null> | void;
  // (Keeper 0.1.11) a claim or cancel answer that isn't a plain success: the owner's card offering a retry (core.ts retryCard)
  retry?: (attempt: string, what: "claim" | "cancel", why: string) => void;
  // (Keeper 0.1.13) a cancelled attempt's drill mark removed, so the version it named starts as usual (drill.ts)
  dropMark?: (attempt: string) => void;
  enrollment?: EnrollmentStore;                                             // (0.1.5) the recorded enrollment
  waitMs?: number;                                                          // (Keeper 0.1.15) one App's wait for acceptance (acceptWaitMs)
  view?: (attempt: string) => Promise<{ status: number; body: any } | null>;   // (Keeper 0.1.15) GET /attempt/<id>, for the reconcile at start
  log: (line: string) => void;
}
export type PassAnswer = { status: "ok"; pr: number; head: string; accepted: Accepted[]; claims: Claimed[] } | { status: "pending" | "spent" | "refused"; said: string };
export const PENDING_SAID = "the keeper is taking the backup before this install; nothing has run and the tap still counts: start the same Ship run again in a minute";

function readEntries(text: string | null): Entry[] | null {
  if (text === null) return [];
  try {
    const j = JSON.parse(text);
    if ((j?.format !== 1 && j?.format !== PASS_FORMAT) || !Array.isArray(j.spent)) return null;
    return j.spent.filter((x: any) => x && typeof x.id === "string" && Number.isFinite(x.exp))
      .map((x: any) => j.format === 1 ? { id: x.id, exp: x.exp, state: "passed", at: 0 } : { ...x, state: ["registering", "accepted", "claiming", "refused", "passed"].includes(x.state) ? x.state : "refused", at: Number(x.at) || 0 });
  } catch { return null; }
}
const writeEntries = (d: PassDeps, spent: Entry[]) => d.store(JSON.stringify({ format: PASS_FORMAT, spent }));
const cancelAll = (d: PassDeps, ids: string[], why: string) => {
  for (const a of new Set(ids)) {
    d.log(`cancelling the keeper's registration ${a}: ${why}`);
    try { d.dropMark?.(a); } catch { /* the mark lapses by itself */ }
    const p = d.cancel?.(a, why);
    if (p && typeof (p as Promise<unknown>).then === "function") void (p as Promise<{ status: number; body: any } | null>).catch(() => null).then((r) => judgeCancel(d, a, r));
  }
};
// (Keeper 0.1.11) A cancel's answer: only a plain "ended" for that attempt counts as done. Pending, refused, an error or no answer
// is no success: logged, and the owner gets a card offering a retry. Nothing installs either way (the pass is refused).
export function judgeCancel(d: PassDeps, attempt: string, r: { status: number; body: any } | null): boolean {
  const ok = !!r && r.status === 200 && r.body?.status === "ended" && (r.body?.id === undefined || r.body.id === attempt);
  if (ok) return true;
  const why = !r ? "the keeper didn't answer" : r.status === 202 || r.body?.status === "pending" ? `the keeper's answer is pending${r.body?.operation ? ` (operation ${String(r.body.operation).slice(0, 40)})` : ""}`
    : `the keeper answered ${String(r.body?.status ?? r.status).slice(0, 40)}${r.body?.why ? `: ${String(r.body.why).slice(0, 120)}` : ""}`;
  d.log(`the keeper's cancel of ${attempt} isn't confirmed (${why}): no success; the owner gets a card offering a retry`);
  d.retry?.(attempt, "cancel", why);
  return false;
}

// (0.1.5) What the registration made so far, kept on its entry: the number of watched Apps (the pass's
// wait scales with it) and each attempt id (cancelled if the pass gives up).
export function noteEntry(d: PassDeps, id: string, upd: { apps?: number; attempt?: string }): void {
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === id);
  if (!spent || !e) return;
  if (e.state !== "registering") { if (upd.attempt) cancelAll(d, [upd.attempt], "its pass had already ended"); return; }
  if (upd.apps !== undefined) e.apps = upd.apps;
  if (upd.attempt) e.attempts = [...(e.attempts ?? []), upd.attempt];
  try { writeEntries(d, spent); } catch { d.log("couldn't keep a keeper registration's progress"); }
}

// A registration's outcome, kept on its entry (only while it is still registering). One that ends after
// its pass gave up is cancelled at the keeper, so no acceptance is left lying around.
export function settle(d: PassDeps, id: string, r: RegResult): void {
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === id);
  if (!spent || !e || e.state !== "registering") {
    d.log("a keeper registration ended after its pass had moved on: not kept");
    if (r.ok) cancelAll(d, r.accepted.map((a) => a.attempt), "its pass had already ended");
    return;
  }
  if (r.ok) { e.state = "accepted"; e.accepted = r.accepted; if (r.fp) e.fp = r.fp; }
  else { e.state = "refused"; e.said = `the keeper didn't accept every install: ${r.said.join("; ").slice(0, 400) || "no reason"}`; }
  try { writeEntries(d, spent); } catch { d.log("couldn't keep a keeper registration's outcome: the pass times out and is refused"); return; }
  d.log(r.ok ? `the keeper accepted every watched install for a Ship token (${r.accepted.map((a) => `${a.attempt} backup ${a.backup}`).join(", ") || "none watched"})` : `a Ship token's pass is refused: ${e.said}`);
  if (!r.ok) cancelAll(d, e.attempts ?? [], r.cancel ?? "the pass is refused");
}

// (Keeper 0.1.15) items 3 and 6: the link's reconcile at its start. A pass left registering, accepted or claiming by a crash or a
// restart never started a Ship run (the hook needs the link's "ok"), so it is refused for good and each of its attempts cancelled
// (Keeper ends an acceptance the link never claims by itself after its bound, as a terminal abort, with its backup kept). A pass that
// passed is only read: each claimed attempt's state at Keeper, the Supervisor's install job Keeper tied to it included, is logged,
// so the install the Ship run submitted (or its absence) is in the link's log before anything else happens. Nothing is installed or
// claimed here. Answers how many passes it refused.
export async function reconcilePasses(d: PassDeps): Promise<number> {
  const spent = readEntries(d.load());
  if (!spent) { d.log("the reconcile at start couldn't read the Ship passes: nothing was reconciled"); return 0; }
  const now = d.now();
  let refused = 0;
  for (const e of spent) {
    if (e.exp * 1000 <= now - 86_400_000) continue;
    if (e.state === "registering" || e.state === "accepted" || e.state === "claiming") {
      const ids = [...new Set([...(e.attempts ?? []), ...(e.accepted ?? []).map((a) => a.attempt)])];
      const was = e.state;
      e.state = "refused"; e.said = "the link restarted before its Ship run started, so the pass was refused at its next start";
      refused++;
      d.log(`the reconcile at start refused a pass left ${was} by a restart (${ids.join(", ") || "no attempt registered yet"}): nothing was installed`);
      if (ids.length) cancelAll(d, ids, "the link restarted before its Ship run started");
      continue;
    }
    if (e.state === "passed" && d.view) for (const k of e.claims ?? []) {
      const v = await d.view(k.attempt).catch(() => null);
      const b = v?.body ?? {};
      d.log(!v ? `the reconcile at start couldn't read ${k.attempt} at Keeper` : `the reconcile at start read ${k.attempt} at Keeper: ${String(b.status ?? v.status).slice(0, 30)}, `
        + (b.install_job ? `tied to the Supervisor's install job ${String(b.install_job).slice(0, 64)} made ${String(b.install_job_at ?? "?").slice(0, 30)}` : "no install job tied to it"));
    }
  }
  if (refused) { try { writeEntries(d, spent); } catch { d.log("the reconcile at start couldn't record the refused passes: the hook's next ask refuses them on their wait"); } }
  return refused;
}

// (Keeper 0.1.6) The hook refused a run the link had passed (its claim's deadline too near when it checked):
// POST /ship-pass {token, cancel: <why>}. The pass is refused for good and each claim cancelled at the keeper,
// so no claim is left live; a new Ship card for the same pull request and head starts again.
export function cancelPass(d: PassDeps, token: string, why: string): PassAnswer {
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === passId(token));
  if (!spent || !e) return { status: "refused", said: "no pass for that Ship token" };
  const ids = [...(e.claims ?? []).map((k) => k.attempt), ...(e.accepted ?? []).map((a) => a.attempt), ...(e.attempts ?? [])];
  const said = `the hook refused the Ship run: ${String(why).replace(/[^\x20-\x7e]/g, " ").slice(0, 200)}`;
  e.state = "refused"; e.said = said;
  try { writeEntries(d, spent); } catch { d.log("couldn't record a cancelled pass: its claims are cancelled anyway"); }
  d.log(`a Ship token's pass is cancelled: ${said}`);
  cancelAll(d, ids, "the hook refused the Ship run");
  return { status: "refused", said: `${said}. Nothing was installed; start again with a new Ship card for the same pull request and head` };
}

export async function shipPass(d: PassDeps, body: any, depth = 0): Promise<PassAnswer> {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "refused", said: "no Ship token" };
  if (typeof body?.cancel === "string" && body.cancel) return cancelPass(d, token, body.cancel);
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  let spent = readEntries(d.load());
  if (!spent) return { status: "refused", said: "the link's record of spent Ship tokens can't be read, so no Ship run starts: log a Build item" };
  const id = passId(token);
  const now = d.now();
  const e = spent.find((x) => x.id === id);
  const where = `pull request ${c.claim.pr} at ${c.claim.head.slice(0, 12)}`;
  const again = "Nothing was installed; a new Ship card for the same pull request and head tries again";
  if (!e) {
    spent = spent.filter((x) => x.exp * 1000 > now - 86_400_000);
    spent.push({ id, exp: c.claim.exp, state: "registering", at: now });
    try { writeEntries(d, spent); }
    catch { return { status: "refused", said: "the link couldn't record the Ship token, so no Ship run starts: try again in a minute" }; }
    d.log(`registering the installs of ${where} with the keeper; the Ship run waits for its acceptance`);
    d.register(token, c.claim, (r) => settle(d, id, r), (upd) => noteEntry(d, id, upd));
    return depth ? { status: "pending", said: PENDING_SAID } : shipPass(d, body, 1);
  }
  const refuseFor = (said: string, cancel: string[], cancelWhy = "the pass is refused"): PassAnswer => {
    const all = readEntries(d.load()) ?? spent!;
    const cur = all.find((x) => x.id === id);
    if (cur) { cur.state = "refused"; cur.said = said; try { writeEntries(d, all); } catch { /* refused either way */ } }
    d.log(`a Ship token's pass is refused: ${said}`);
    cancelAll(d, cancel, cancelWhy);
    return { status: "refused", said: `${said}. ${again}` };
  };
  if (e.state === "passed") {
    // (Keeper 0.1.8) one Ship run per attempt: while its claim is live, the refusal names the claims' latest expiry
    const live = (e.claims ?? []).map((k) => Date.parse(k.until)).filter((t) => Number.isFinite(t) && t > now);
    const until = live.length ? new Date(Math.max(...live)).toISOString() : "";
    d.log(`refused a second Ship run on the token for ${where}${until ? `: its claim is live until ${until}` : ""}`);
    return { status: "spent", said: `that Ship token already started a Ship run${until ? `, and its claim at the keeper is live until ${until}` : ""}; one tap starts one run. If the install still has to happen, show a new Ship card for the same pull request and head${until ? " once that claim has ended" : ""}` };
  }
  if (e.state === "refused") return { status: "refused", said: `${e.said ?? "the keeper didn't accept the install"}. ${again}` };
  if (e.state === "registering") {
    const wait = passWaitMs(e.apps ?? 1, d.waitMs);
    if (now - e.at <= wait) return { status: "pending", said: PENDING_SAID };
    return refuseFor(`the keeper didn't accept every install within ${wait / 60_000} minutes`, e.attempts ?? []);
  }
  if (e.state === "claiming") {
    if (now - (e.claimingAt ?? 0) <= CLAIMING_STUCK_MS) return { status: "pending", said: "the link is claiming the keeper's acceptance: start the same Ship run again in a minute" };
    return refuseFor("the link stopped while it claimed the keeper's acceptance", (e.accepted ?? []).map((a) => a.attempt));
  }
  // accepted: claim each acceptance at the keeper, then pass. "claiming" is written first, so two asks at
  // once claim once, and a restart mid-claim refuses rather than claiming twice.
  const accepted = e.accepted ?? [];
  e.state = "claiming"; e.claimingAt = now;
  try { writeEntries(d, spent); }
  catch { return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  const claims: Claimed[] = [];
  for (const a of accepted) {
    // Keeper 0.1.7: the record as it stood before the claim was sent, and the claim's own request id; a claim that
    // got no answer is asked once more with the same id, and the keeper answers that with the recorded claim
    const before = d.enrollment?.load() ?? null;
    const request = createHash("sha256").update(`ship-claim-v1\n${id}\n${a.attempt}`).digest("hex").slice(0, 32);
    let r = d.claim ? await d.claim(a, request).catch(() => null) : null;
    if (!r && d.claim) { d.log(`the keeper didn't answer the claim of ${a.attempt}: asking once more with the same request`); r = await d.claim(a, request).catch(() => null); }
    const j = r?.body ?? {};
    const okAns = r && r.status === 200 && j.status === "claimed" && j.id === a.attempt && j.app === a.app && j.backup === a.backup
      && (a.from === undefined || j.from_version === a.from) && (a.to === undefined || j.to_version === a.to)
      && typeof j.claim === "string" && CLAIM_ID.test(j.claim) && Number.isFinite(Date.parse(String(j.until)));
    const en = okAns ? enrollmentCheckNow(j, e.fp ?? "", keyFingerprint(pub), before, d.enrollment) : null;
    if (en?.record) noteRecord(d.enrollment, en.record, d.log);
    if (!okAns || !en || !en.ok) {
      // (Keeper 0.1.11) any claim answer that isn't a plain claim (pending, spent, refused, an error, no answer): no install, no
      // success, and the owner gets a card offering a retry
      d.retry?.(a.attempt, "claim", !r ? "the keeper didn't answer" : r.status === 202 || j?.status === "pending" ? "the keeper's answer is pending" : `the keeper answered ${String(j?.status ?? r.status).slice(0, 40)}`);
      return refuseFor(!r ? `the keeper didn't answer the claim of ${a.attempt}` : !okAns ? `the keeper refused the claim of ${a.attempt}: ${String(j?.why ?? r.status).slice(0, 160)}`
        : `the keeper's claim of ${a.attempt} failed the enrollment check: ${(en as any).why}`, accepted.map((x) => x.attempt), (en && !en.ok && en.cancel) || undefined);
    }
    const left = Date.parse(String(j.until)) - d.now();
    if (left < CLAIM_START_MIN_MS) return refuseFor(`the keeper's claim of ${a.attempt} has ${Math.max(0, Math.floor(left / 60_000))} minutes left, under the ${CLAIM_START_MIN_MS / 60_000} a Ship run needs to start`, accepted.map((x) => x.attempt));
    claims.push({ attempt: a.attempt, claim: j.claim, until: new Date(Date.parse(String(j.until))).toISOString() });
  }
  spent = readEntries(d.load()) ?? spent;
  const cur = spent.find((x) => x.id === id);
  if (!cur || cur.state !== "claiming") { cancelAll(d, accepted.map((a) => a.attempt), "the pass changed while it claimed"); return { status: "refused", said: `the pass changed while the link claimed. ${again}` }; }
  cur.state = "passed"; cur.claims = claims;
  try { writeEntries(d, spent); }
  catch { cancelAll(d, accepted.map((a) => a.attempt), "the pass couldn't be recorded"); return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  for (const k of claims) d.log(`Ship pass ok: ${k.attempt} claim ${k.claim} until ${k.until}`);
  d.log(`let a Ship run through for ${where} (every watched install accepted and claimed); its token is spent`);
  return { status: "ok", pr: c.claim.pr, head: c.claim.head, accepted, claims };
}

export interface RegisterDeps {
  api: MergeDeps["api"];
  post: (body: unknown) => Promise<{ status: number; body: any } | null>;   // POST /attempt on the keeper, Cain's token
  get?: (path: string) => Promise<{ status: number; body: any } | null>;    // (0.1.5) GET /attempt/<id>
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  note?: (upd: { apps?: number; attempt?: string }) => void;
  linkFp?: string | null;                                                 // the link's own Ship key's fingerprint
  enrollment?: EnrollmentStore;
  pollMs?: number; waitMs?: number;
  log: (line: string) => void;
  // (Keeper 0.1.10) a refusal for want of space: the link's card posted (Keeper 0.1.11: no button; nothing installs without the rollback)
  noSpace?: (pr: number, head: string, app: string, version: string) => void;
  // (Keeper 0.1.13) the drill switch (drill.ts): the owner's flag spent by this registration, and the accepted drill's mark
  drill?: DrillDeps;
  // (Keeper 0.1.14) POST /attempt/<id>/drill-mark on the keeper: the link's confirmation that it wrote the drill's signed mark
  markPost?: (attempt: string, body: unknown) => Promise<{ status: number; body: any } | null>;
  // (Cain 0.19.4) the used backup-first tap this token's claim stands for (backup-first.ts usedFor): its nonce and main commit go
  // with Cain's registration, and the Keeper uses the backup taken first only for that nonce
  first?: (c: Claim) => { nonce: string; main: string } | null;
}
// The registration of each watched App the tap installs (0.1.5: register, then poll): ok only when every one
// is accepted (the keeper's answer "accepted" for that App and versions, with its attempt id and backup
// slug) and passes the enrollment check against the fingerprint committed at the head. A base, a list of
// bumps, a version, a probe or the fingerprint file that can't be read, a keeper that refuses, or no
// acceptance within ATTEMPT_WAIT_MS of polling: not ok, so the pass is refused.
export async function registerInstalls(d: RegisterDeps, token: string, c: Claim): Promise<RegResult> {
  const said: string[] = [];
  const accepted: Accepted[] = [];
  let ok = true;
  let cancel: string | undefined;                       // (Keeper 0.1.8) an enrollment refusal's why, for the cancel
  const say = (l: string, bad = true) => { said.push(l); if (bad) ok = false; d.log(`keeper registration: ${l}`); };
  const now = d.now ?? Date.now, sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pull = await d.api(`/repos/${c.repo}/pulls/${c.pr}`).catch(() => null);
  const base = pull?.status === 200 ? String(pull.body?.base?.sha ?? "") : "";
  if (!/^[0-9a-f]{40}$/.test(base)) { say(`pull request ${c.pr}'s base couldn't be read, so nothing was registered`); return { ok: false, said }; }
  const bumps = await bumpsAt(d, c.repo, base, c.head);
  if (!bumps) { say("what the tap installs couldn't be read, so nothing was registered"); return { ok: false, said }; }
  const watched = bumps.filter((b) => APP_SLUGS[b.app] && WATCHED.has(APP_SLUGS[b.app]));
  d.note?.({ apps: watched.length });
  if (!watched.length) return { ok: true, accepted, said };
  const fpFile = await fileAt(d, c.repo, FINGERPRINT_FILE, c.head);
  const committed = fpFile && fpFile !== "missing" ? readFingerprintFile(fpFile.toString("utf8")) : "";
  if (!committed) { say(`${FINGERPRINT_FILE} at the head ${fpFile === null ? "couldn't be read" : "holds no fingerprint"} (the Build run when the link's Ship key is made writes it), so nothing was registered`); return { ok: false, said }; }
  if (d.linkFp && committed !== d.linkFp) { say(`${FINGERPRINT_FILE} at the head (${committed}) isn't the link's own Ship key (${d.linkFp}), so nothing was registered`); return { ok: false, said }; }
  // (Keeper 0.1.14) no registration removes a mark it doesn't own: a competing, retried or rejected one leaves an active mark be
  for (const b of watched) {
    const slug = APP_SLUGS[b.app];
    const from = await versionAt(d, c.repo, CONFIGS[b.app], base);
    const probe = await fileAt(d, c.repo, PROBE_FILES[b.app] ?? CONFIGS[b.app], c.head);
    if (!from || from === "none" || !probe || probe === "missing") { say(`${b.app}'s version at the base or its probe at the head couldn't be read: not registered`); continue; }
    // (Keeper 0.1.13) the owner's drill flag, spent here, before the keeper is asked, so it counts once whatever follows:
    // while it was set this install goes as kind drill, and it fails on purpose as the flag names (drill.ts)
    // Keeper 0.1.14: fail closed (a flag file that doesn't verify, names another version or was spent refuses the install and
    // pages); only with no flag file at all is it kind ship. A good flag's nonce is recorded before it is removed.
    // Keeper 0.1.15 item 12: the flag is bound to an App's slug and version: spent for its own App's registration only, and left be
    // (not refused) by any other App's
    let drill: DrillMode | null = null, nonce = "";
    if (d.drill) {
      const sp = d.drill.spend(b.version, slug);
      if ("error" in sp) { say(`${sp.error}: ${b.app} ${b.version} not registered`); continue; }
      drill = sp.mode;
      if (sp.mode) nonce = sp.nonce;
    }
    // (Keeper 0.1.14) a drill that won't be a definitive acceptance: the install refused (by the caller's say), the owner paged once
    const notAccepted = (why: string) => { if (drill) { d.log(`keeper registration: the spent drill flag (${drill}) installs nothing: ${why}`); d.drill!.page("accept", `accept:${nonce}`, { version: b.version }); } };
    // (Cain 0.19.4) Cain's own install carries its tap's nonce and main commit; without one the Keeper refuses it (fail closed)
    let tapFirst: { nonce: string; main: string } | null = null;
    if (!drill && slug === "0fcc2575_cain" && d.first) { try { tapFirst = d.first(c); } catch { tapFirst = null; } }
    const r = await d.post({ token, app: slug, pr: c.pr, head: c.head, from_version: from, to_version: b.version, kind: drill ? "drill" : "ship",
      ...(drill ? { drill_mode: drill, drill_nonce: nonce } : {}), ...(tapFirst ? { first_nonce: tapFirst.nonce, first_main: tapFirst.main } : {}),
      probe_hash: createHash("sha256").update(probe).digest("hex").slice(0, 16) }).catch(() => null);
    let j = r?.body ?? {};
    if (!r || r.status !== 202 || j.status !== "pending" || typeof j.id !== "string" || !ATTEMPT_ID.test(j.id)) {
      say(!r ? `the keeper didn't answer for ${b.app} ${b.version}` : r.status === 202 || r.status === 200 ? `the keeper's answer for ${b.app} ${b.version} isn't a registration of it`
        : `the keeper refused ${b.app} ${b.version}: ${String(j?.why ?? r.status).slice(0, 160)}`);
      notAccepted("the keeper didn't take its registration");
      continue;
    }
    const attempt = j.id;
    d.note?.({ attempt });
    const until = now() + (d.waitMs ?? ATTEMPT_WAIT_MS);
    let last: { status: number; body: any } | null = null;
    let before: Enrollment | null = null;
    for (;;) {
      await sleep(d.pollMs ?? POLL_MS);
      before = d.enrollment?.load() ?? null;              // (Keeper 0.1.7) the record before this read was sent
      last = d.get ? await d.get(`/attempt/${attempt}`).catch(() => null) : null;
      j = last?.body ?? {};
      if (last?.status === 200 && j.status !== "pending") break;
      if (now() >= until) break;
    }
    if (last?.status === 200 && j.status === "accepted" && j.id === attempt && j.app === slug && j.from_version === from && j.to_version === b.version
        && typeof j.backup === "string" && BACKUP_SLUG.test(j.backup)) {
      const en = enrollmentCheckNow(j, committed, d.linkFp ?? null, before, d.enrollment);
      if (en.record) noteRecord(d.enrollment, en.record, d.log);
      if (!en.ok) { cancel ??= en.cancel; say(`the keeper accepted ${b.app} ${b.version} as ${attempt}, but its enrollment is refused: ${en.why}`); notAccepted("its enrollment is refused"); continue; }
      if (drill) {
        // (Keeper 0.1.14) a definitive acceptance of this very drill only: its kind and mode as registered
        if (!attempt.startsWith("drill-") || j.kind !== "drill" || j.drill_mode !== drill) {
          say(`the keeper accepted the drill of ${b.app} ${b.version} as ${attempt}, not as this drill: not installed`); notAccepted("its acceptance isn't this drill's"); continue;
        }
        // the signed mark the drilled version reads at run time, written after the keeper's backup so no rollback restores it, then
        // confirmed to the keeper (its drill record needs that). Either failing aborts the drill: recorded, cancelled, paged.
        let text: string;
        try { text = d.drill!.mark({ version: b.version, attempt, mode: drill }); }
        catch {
          cancel = "the drill was aborted: its mark couldn't be written";
          d.drill!.aborted(attempt, b.version, "its mark couldn't be written");
          say(`the drill mark for ${attempt} couldn't be written, so ${b.app} ${b.version} wouldn't fail as the drill needs: the drill is aborted, not installed`); continue;
        }
        const conf = d.markPost ? await d.markPost(attempt, { mode: drill, to_version: b.version, mark: markHash(text) }).catch(() => null) : null;
        if (!conf || conf.status !== 200 || conf.body?.status !== "marked" || conf.body?.id !== attempt) {
          const why = !conf ? "the keeper didn't confirm its mark (no answer)" : `the keeper didn't confirm its mark (${String(conf.body?.why ?? conf.body?.status ?? conf.status).slice(0, 120)})`;
          d.drill!.drop(attempt);
          cancel = `the drill was aborted: ${why}`;
          d.drill!.aborted(attempt, b.version, why);
          say(`${why}, so ${b.app} ${b.version} is no drill Keeper can record: the drill is aborted, not installed`); continue;
        }
        say(`${b.app} ${b.version} is a drill (${drill}): it fails on purpose so the keeper rolls it back`, false);
      }
      accepted.push({ app: slug, attempt, backup: j.backup, from, to: b.version, ...(tapFirst ? { main: tapFirst.main } : {}) });
      say(`${b.app} ${from} to ${b.version} accepted as ${attempt}, backup ${j.backup}`, false);
    } else if (last?.status === 200 && j.status === "refused" && j.code === "no_space") {
      // (Keeper 0.1.10) no room for the keeper's backup: the install is refused. Keeper 0.1.11: always; the link posts one card
      // saying so, with no button that installs without the rollback (the owner clears space or chooses another path)
      say(`the keeper refused ${b.app} ${b.version}: ${String(j.why ?? "no room for its backup").slice(0, 160)}; nothing installs without the keeper's rollback, and the link posts the owner a card saying so`);
      d.noSpace?.(c.pr, c.head, slug, b.version);
      notAccepted("the keeper had no room for its backup");
    } else {
      notAccepted(last?.status === 200 && j.status === "pending" ? "the keeper's answer was still pending when the wait ended" : "the keeper didn't accept it with a confirmed backup");
      say(last?.status === 200 && j.status === "pending" ? `the keeper didn't accept ${b.app} ${b.version} within ${(d.waitMs ?? ATTEMPT_WAIT_MS) / 60_000} minutes`
      : last?.status === 200 ? `the keeper refused ${b.app} ${b.version}: ${String(j?.why || j?.status).slice(0, 160)}`
      : `the keeper didn't answer for ${b.app} ${b.version} (${attempt})`);
    }
  }
  return ok ? { ok: true, accepted, said, fp: committed } : { ok: false, said, ...(cancel ? { cancel } : {}) };
}
