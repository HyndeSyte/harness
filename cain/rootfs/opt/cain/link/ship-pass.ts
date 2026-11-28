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

export interface Accepted { app: string; attempt: string; backup: string; from?: string; to?: string }
export interface Claimed { attempt: string; claim: string; until: string }
// (Cain 0.19.4) What a registration expects of each attempt it made, kept on the pass so a restart can pick it up again
export interface Expect { attempt: string; app: string; from: string; to: string }
type PassClaim = { repo: string; pr: number; head: string; exp: number };   // the token's claim, public data only (never the token)
export type RegResult = { ok: true; accepted: Accepted[]; said: string[]; fp?: string } | { ok: false; said: string[]; cancel?: string };   // (Keeper 0.1.8) cancel: the enrollment refusal's why
type State = "registering" | "accepted" | "claiming" | "refused" | "passed";
// (Cain 0.19.4, review round 1) a cancel kept until the Keeper confirms the attempt ended, or names a claim on it
export type PendingCancel = { attempt: string; why: string; tries: number; next: number };
type Entry = { id: string; exp: number; state: State; at: number; said?: string; accepted?: Accepted[];
  apps?: number; attempts?: string[]; fp?: string; claims?: Claimed[]; claimingAt?: number;
  // (Cain 0.19.4) a pass a restart can resume: the token's claim, the watched Apps and each attempt's App and versions, the resumes;
  // review round 1: the entry's revision (every transition moves it on, compare-and-swap), the Keeper's last "still pending" read
  // (kp), when the resumed pass's line went to Cain (relayedAt, once per pass id), and the cancels still owed
  claim?: PassClaim; watched?: string[]; expect?: Expect[]; resumedAt?: number; resumes?: number;
  rev?: number; kp?: number; relayedAt?: number; cancels?: PendingCancel[] };
type NoteUpd = { apps?: number; watched?: string[]; attempt?: string; expect?: Expect; fp?: string };
export interface PassDeps {
  pub: () => string | null;                      // the link's public Ship key (base64 SPKI), as /data/trust/ship.pub holds it
  now: () => number;
  load: () => string | null;                     // the pass file's text (null: none yet)
  store: (text: string) => void;                 // writes it whole, durably (temp file, fsync, rename); throws on failure
  // (Cain 0.19.4, review round 1) the pass file's one lock (pass-lock.ts flockFile): taken for every transition, its release
  // answered; throws when it can't be had. Without it (the tests) the lock is this process's own.
  lock?: () => () => void;
  // the keeper registration, in the background; note(upd) keeps how many Apps and which attempts it made
  register: (token: string, claim: Claim, done: (r: RegResult) => void, note: (upd: NoteUpd) => void) => void;
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
  // (Cain 0.19.4) the resume after a restart: the token signed again from its kept claim (Ed25519 is deterministic, so it is the
  // same token), the line to Cain (written whole or not at all: it throws rather than cut a line), and the poll's pause
  sign?: (claim: Claim) => string | null;
  relay?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  log: (line: string) => void;
}
export type PassAnswer = { status: "ok"; pr: number; head: string; accepted: Accepted[]; claims: Claimed[] } | { status: "pending" | "spent" | "refused"; said: string }
  | { status: "token"; token: string };   // (Cain 0.19.4, review round 1) the resumed pass's token, to the Ship run's hook only
export const PENDING_SAID = "the keeper is taking the backup before this install; nothing has run and the tap still counts: start the same Ship run again in a minute";

// (Cain 0.19.4, review round 1) The bounds of a pass. Its pending deadline is fixed from when it was registered, never from a restart
// or a resume: the registration's wait, plus one bounded grace once a restart resumed it, and never past its token's expiry less a
// margin (the hard cap). While the Keeper says its backup is still running (a read within KEEPER_PENDING_FRESH_MS) the pass may keep
// waiting past the deadline up to the hard cap, and no further. No claim is made on a backup older than BACKUP_MAX_AGE_MS: the
// backup is made after the registration, so its age is at most the time since it.
export const RESTART_GRACE_MS = 5 * 60_000;
export const TOKEN_MARGIN_MS = CLAIM_START_MIN_MS;
export const BACKUP_MAX_AGE_MS = 30 * 60_000;
export const KEEPER_PENDING_FRESH_MS = 60_000;
export const CANCEL_RETRY_MS = 30_000, CANCEL_RETRY_MAX_MS = 10 * 60_000;
export const RELAY_MAX = 1_000;                   // the queue's line: written whole, or the pass is cancelled
export const hardCap = (e: { exp: number }) => e.exp * 1000 - TOKEN_MARGIN_MS;
export const pendingDeadline = (e: { at: number; apps?: number; exp: number; resumes?: number }, waitMs?: number) =>
  Math.min(e.at + passWaitMs(e.apps ?? 1, waitMs) + ((e.resumes ?? 0) > 0 ? RESTART_GRACE_MS : 0), hardCap(e));
const stillPending = (e: Entry, now: number, waitMs?: number) =>
  now <= pendingDeadline(e, waitMs) || (now <= hardCap(e) && e.kp !== undefined && now - e.kp <= KEEPER_PENDING_FRESH_MS);

function readEntries(text: string | null): Entry[] | null {
  if (text === null) return [];
  try {
    const j = JSON.parse(text);
    if ((j?.format !== 1 && j?.format !== PASS_FORMAT) || !Array.isArray(j.spent)) return null;
    return j.spent.filter((x: any) => x && typeof x.id === "string" && Number.isFinite(x.exp))
      .map((x: any) => j.format === 1 ? { id: x.id, exp: x.exp, state: "passed", at: 0 } : { ...x, state: ["registering", "accepted", "claiming", "refused", "passed"].includes(x.state) ? x.state : "refused", at: Number(x.at) || 0 });
  } catch { return null; }
}

// (Cain 0.19.4, review round 1) Every write of the pass file is one transaction: the lock taken, the file read, fn checks and
// changes the entries, and the file written whole by an atomic rename, all before the lock is let go. fn says whether to write.
// A transition moves its entry's revision on; a caller that read an entry before an await passes the revision it read, and the
// transition is refused (a compare-and-swap) when the entry moved meanwhile. States only move forward: registering, accepted,
// claiming, then passed or refused (a passed pass may still be refused, by the hook's own cancel); never back.
const RANK: Record<State, number> = { registering: 0, accepted: 1, claiming: 2, passed: 3, refused: 4 };
let held = false;
function txn<T>(d: PassDeps, fn: (spent: Entry[]) => { write: boolean; value: T }): T {
  if (held) throw new Error("a Ship pass transition inside another");
  const release = d.lock ? d.lock() : () => {};
  held = true;
  try {
    const spent = readEntries(d.load());
    if (!spent) throw new Error("the Ship passes can't be read");
    const r = fn(spent);
    if (r.write) d.store(JSON.stringify({ format: PASS_FORMAT, spent }));
    return r.value;
  } finally { held = false; release(); }
}
function move(e: Entry, to?: State): void {
  if (to && to !== e.state) {
    if (RANK[to] < RANK[e.state] || e.state === "refused") throw new Error(`a Ship pass can't move from ${e.state} back to ${to}`);
    e.state = to;
  }
  e.rev = (e.rev ?? 0) + 1;
}
const find = (spent: Entry[], id: string) => spent.find((x) => x.id === id);
const peek = (d: PassDeps, id: string) => { const s = readEntries(d.load()); return s ? find(s, id) ?? null : null; };
const keep = (e: Entry, now: number) => e.exp * 1000 > now - 86_400_000 || (e.cancels?.length ?? 0) > 0;

// The cancels a pass owes, kept on it (no state change, so no revision step). Taken off once the Keeper confirms.
function owe(d: PassDeps, id: string | undefined, ids: string[], why: string, tries = 0, next?: number): void {
  if (!id || !ids.length) return;
  try {
    txn(d, (spent) => {
      const e = find(spent, id);
      if (!e) return { write: false, value: null };
      const now = d.now();
      const have = new Set((e.cancels ?? []).map((c) => c.attempt));
      e.cancels = [...(e.cancels ?? []), ...[...new Set(ids)].filter((a) => !have.has(a)).map((attempt) => ({ attempt, why: why.slice(0, 160), tries, next: next ?? now }))];
      return { write: true, value: null };
    });
  } catch { d.log(`couldn't keep the owed cancels of ${ids.join(", ")}: each was sent once; the Keeper ends an unclaimed acceptance by itself after its bound`); }
}
function settleOwed(d: PassDeps, id: string, attempt: string, upd: Partial<PendingCancel> | null): void {
  try {
    txn(d, (spent) => {
      const e = find(spent, id);
      if (!e || !e.cancels?.some((c) => c.attempt === attempt)) return { write: false, value: null };
      e.cancels = upd === null ? e.cancels.filter((c) => c.attempt !== attempt) : e.cancels.map((c) => c.attempt === attempt ? { ...c, ...upd } : c);
      return { write: true, value: null };
    });
  } catch { d.log(`couldn't record the cancel of ${attempt}: tried again later`); }
}
// The cancel sent now (the paths that ended a pass of their own: the hook's refusal, a claim refused, a registration refused), and
// kept as owed when the pass is named, so the reaper sends it again until the Keeper confirms. view: true sends none now and leaves it
// to the reaper's drain, which reads the attempt at the Keeper first and never cancels a claimed one.
const cancelAll = (d: PassDeps, ids: string[], why: string, pass?: string, o: { view?: boolean } = {}) => {
  const all = [...new Set(ids)];
  if (!all.length) return;
  owe(d, pass, all, why, o.view ? 0 : 1, o.view ? d.now() : d.now() + CANCEL_RETRY_MS);
  if (o.view) { void drainCancels(d); return; }
  for (const a of all) {
    d.log(`cancelling the keeper's registration ${a}: ${why}`);
    try { d.dropMark?.(a); } catch { /* the mark lapses by itself */ }
    const p = d.cancel?.(a, why);
    if (p && typeof (p as Promise<unknown>).then === "function")
      void (p as Promise<{ status: number; body: any } | null>).catch(() => null).then((r) => { const v = cancelOutcome(a, r); if (v !== "retry" && pass) settleOwed(d, pass, a, null); if (v === "retry") judgeCancel(d, a, r); });
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
// (Cain 0.19.4, review round 1) What a cancel's answer settles: "ended" (it ended, or had already), "owner" (the Keeper names a claim
// handed to a started run: never cancelled), or "retry" (anything else: owed still).
const CLAIMED_ON = ["claimed", "watching", "restoring", "passed", "rolled back", "gave up", "unresolved"];
function cancelOutcome(attempt: string, r: { status: number; body: any } | null): "ended" | "owner" | "retry" {
  if (r && r.status === 200 && r.body?.status === "ended" && (r.body?.id === undefined || r.body.id === attempt)) return "ended";
  if (r && r.status === 409 && /handed to a started run/.test(String(r.body?.why ?? ""))) return "owner";
  if (r && r.status === 409 && /^it is (ended|aborted|never started|refused|unprotected)/.test(String(r.body?.why ?? ""))) return "ended";
  return "retry";
}
// (Cain 0.19.4, review round 1) The owed cancels, each read at the Keeper first: claimed (or past its claim) names an owner and is
// never cancelled; ended, aborted, refused or unknown there needs nothing more; pending or accepted is cancelled, and an answer that
// isn't a confirmation keeps it owed, tried again later (30 seconds, doubling to 10 minutes) until the Keeper confirms or names a
// claim. The owner's retry card comes once, at the first failure.
const drains = new WeakMap<PassDeps, { p: Promise<number>; again: boolean }>();
// One drain at a time per link: a drain asked while one runs makes that one go round again, and is answered when it ends.
export function drainCancels(d: PassDeps): Promise<number> {
  const cur = drains.get(d);
  if (cur) { cur.again = true; return cur.p; }
  const st = { p: Promise.resolve(0), again: false };
  st.p = (async () => {
    let n = 0;
    try { do { st.again = false; n += await drainOnce(d); } while (st.again); }
    finally { drains.delete(d); }
    return n;
  })();
  drains.set(d, st);
  return st.p;
}
async function drainOnce(d: PassDeps): Promise<number> {
  let done = 0;
  {
    const spent = readEntries(d.load()) ?? [];
    const now = d.now();
    for (const e of spent) for (const c of e.cancels ?? []) {
      if (c.next > now) continue;
      const v = d.view ? await d.view(c.attempt).catch(() => null) : null;
      const st = String(v?.body?.status ?? "");
      if (v?.status === 200 && CLAIMED_ON.includes(st)) {
        d.log(`not cancelling ${c.attempt}: the keeper has it ${st}${v.body?.claim ? ` (claim ${String(v.body.claim).slice(0, 40)})` : ""}, and a claimed attempt is never cancelled`);
        settleOwed(d, e.id, c.attempt, null); done++; continue;
      }
      if ((v?.status === 200 && ["ended", "aborted", "refused", "never started"].includes(st)) || v?.status === 404) {
        d.log(`the cancel of ${c.attempt} is settled: the keeper has it ${v.status === 404 ? "unknown" : st}`);
        settleOwed(d, e.id, c.attempt, null); done++; continue;
      }
      d.log(`cancelling the keeper's registration ${c.attempt}: ${c.why}${c.tries ? ` (try ${c.tries + 1})` : ""}`);
      try { d.dropMark?.(c.attempt); } catch { /* the mark lapses by itself */ }
      const r = await Promise.resolve(d.cancel?.(c.attempt, c.why)).catch(() => null) ?? null;
      const out = cancelOutcome(c.attempt, r);
      if (out !== "retry") { if (out === "owner") d.log(`not cancelled: the keeper names a claim on ${c.attempt} handed to a started run`); settleOwed(d, e.id, c.attempt, null); done++; continue; }
      if (c.tries === 0) judgeCancel(d, c.attempt, r);
      else d.log(`the keeper's cancel of ${c.attempt} still isn't confirmed: owed, tried again later`);
      settleOwed(d, e.id, c.attempt, { tries: c.tries + 1, next: d.now() + Math.min(CANCEL_RETRY_MAX_MS, CANCEL_RETRY_MS * 2 ** c.tries) });
    }
  }
  return done;
}

// (0.1.5) What the registration made so far, kept on its entry: the number of watched Apps (the pass's
// wait scales with it) and each attempt id (cancelled if the pass gives up).
export function noteEntry(d: PassDeps, id: string, upd: NoteUpd): void {
  let late = false;
  try {
    txn(d, (spent) => {
      const e = find(spent, id);
      if (!e) return { write: false, value: null };
      if (e.state !== "registering") { late = true; return { write: false, value: null }; }
      if (upd.apps !== undefined) e.apps = upd.apps;
      if (upd.watched) e.watched = [...upd.watched];                  // (Cain 0.19.4, review round 1) the watched Apps by slug
      if (upd.attempt) e.attempts = [...(e.attempts ?? []), upd.attempt];
      if (upd.fp) e.fp = upd.fp;                                    // (Cain 0.19.4) the fingerprint committed at the head
      if (upd.expect) e.expect = [...(e.expect ?? []), upd.expect];  // (Cain 0.19.4) the attempt's App and versions
      move(e);
      return { write: true, value: null };
    });
  } catch { d.log("couldn't keep a keeper registration's progress"); }
  if (late && upd.attempt) cancelAll(d, [upd.attempt], "its pass had already ended", id);
}

// A registration's outcome, kept on its entry (only while it is still registering). One that ends after
// its pass gave up is cancelled at the keeper, so no acceptance is left lying around.
export function settle(d: PassDeps, id: string, r: RegResult): void {
  let out: { kept: boolean; said?: string; attempts?: string[] };
  try {
    out = txn(d, (spent) => {
      const e = find(spent, id);
      if (!e || e.state !== "registering") return { write: false, value: { kept: false } };
      if (r.ok) { move(e, "accepted"); e.accepted = r.accepted; if (r.fp) e.fp = r.fp; }
      else { move(e, "refused"); e.said = `the keeper didn't accept every install: ${r.said.join("; ").slice(0, 400) || "no reason"}`; }
      return { write: true, value: { kept: true, said: e.said, attempts: e.attempts ?? [] } };
    });
  } catch { d.log("couldn't keep a keeper registration's outcome: the pass times out and is refused"); return; }
  if (!out.kept) {
    d.log("a keeper registration ended after its pass had moved on: not kept");
    if (r.ok) cancelAll(d, r.accepted.map((a) => a.attempt), "its pass had already ended", id);
    return;
  }
  d.log(r.ok ? `the keeper accepted every watched install for a Ship token (${r.accepted.map((a) => `${a.attempt} backup ${a.backup}`).join(", ") || "none watched"})` : `a Ship token's pass is refused: ${out.said}`);
  if (!r.ok) cancelAll(d, out.attempts ?? [], r.cancel ?? "the pass is refused", id);
}

// (Keeper 0.1.15) items 3 and 6: the link's reconcile at its start. A pass that passed is only read: each claimed attempt's state at
// Keeper, the Supervisor's install job Keeper tied to it included, is logged. Nothing is installed here. Answers how many it refused.
//
// (Cain 0.19.4) Cain's backup is cold, so the keeper's own backup of him stops and starts this App, and a pass left registering or
// accepted by that restart is resumed, not refused. Resumable only when the pass kept everything its registration made: the token's
// claim, the committed fingerprint, the watched Apps, and exactly one attempt per watched App with its App and versions (review round
// 1: the kept attempts' Apps are exactly the watched Apps); every attempt is a ship one; it is still inside its pending deadline (an
// accepted one: its backup under BACKUP_MAX_AGE_MS old); the token signed again from its claim is the same token; and it was resumed
// under RESUME_MAX times. The resume count and time are written (fsynced) before any poll. An accepted pass stays accepted.
// The resume reads each attempt at the Keeper: accepted and matching (kind "ship") goes on; pending keeps waiting (up to the hard cap
// while the Keeper says its backup is still running); claimed is never cancelled; anything else refuses the pass and cancels.
// A pass left claiming is reconciled with the Keeper before anything is cancelled: claims this pass made (the claim asked again with
// its own request id, which the Keeper answers with the recorded claim) are recorded and nothing else is done; an attempt claimed by
// another is left be; only an unclaimed one is cancelled.
export const RESUME_MAX = 2;
function resumable(d: PassDeps, e: Entry, now: number): { token: string } | { why: string } {
  if (!d.view || !d.sign) return { why: "the link can't read the keeper or sign the token again" };
  const ex = e.expect ?? [], w = e.watched ?? [];
  if (!e.claim || !e.fp || !ex.length || !w.length) return { why: "the pass didn't keep what its registration made (a pass from before Cain 0.19.4, or one cut off before it registered)" };
  if (e.apps !== w.length || ex.length !== w.length) return { why: "not every watched install was registered before the restart" };
  const apps = new Set(ex.map((x) => x.app));
  if (apps.size !== ex.length || new Set(w).size !== w.length || w.some((a) => !apps.has(a))) return { why: "the kept attempts' Apps aren't exactly the watched Apps, one attempt each" };
  const atts = new Set(ex.map((x) => x.attempt)), made = e.attempts ?? [];
  if (atts.size !== ex.length || made.length !== ex.length || made.some((a) => !atts.has(a))) return { why: "the attempts it made aren't exactly the ones it kept the App and versions of" };
  if (ex.some((x) => !x.attempt.startsWith("ship-") || !ATTEMPT_ID.test(x.attempt))) return { why: "a drill isn't resumed after a restart" };
  if ((e.resumes ?? 0) >= RESUME_MAX) return { why: `it was already resumed ${RESUME_MAX} times` };
  if (now >= hardCap(e) || e.claim.exp * 1000 - now < CLAIM_START_MIN_MS) return { why: "its Ship token has too little time left to start a run" };
  if (e.state === "registering" && now > pendingDeadline({ ...e, resumes: (e.resumes ?? 0) + 1 }, d.waitMs)) return { why: "its pending deadline, counted from its registration, has passed" };
  if (e.state === "accepted" && now - e.at > BACKUP_MAX_AGE_MS) return { why: `its backup may be over ${BACKUP_MAX_AGE_MS / 60_000} minutes old` };
  let token: string | null = null;
  try { token = d.sign({ v: 1, kind: "ship", ...e.claim }); } catch { token = null; }
  if (!token || passId(token) !== e.id) return { why: "its Ship token couldn't be made again" };
  return { token };
}
const pullUrl = (c: PassClaim) => `https://github.com/${c.repo}/pull/${c.pr}`;
const claimRequest = (id: string, attempt: string) => createHash("sha256").update(`ship-claim-v1\n${id}\n${attempt}`).digest("hex").slice(0, 32);
// (Cain 0.19.4, review round 1) Whether the Keeper's claim on an attempt is this pass's: the claim asked again with this pass's own
// request id, which the Keeper answers with the recorded claim when it is (and refuses, changing nothing, when it is another's).
async function ownClaim(d: PassDeps, id: string, a: Accepted, seen: string): Promise<Claimed | null> {
  if (!d.claim) return null;
  const r = await d.claim(a, claimRequest(id, a.attempt)).catch(() => null);
  const j = r?.body ?? {};
  return r?.status === 200 && j.status === "claimed" && j.id === a.attempt && j.claim === seen && CLAIM_ID.test(String(j.claim)) && Number.isFinite(Date.parse(String(j.until)))
    ? { attempt: a.attempt, claim: j.claim, until: new Date(Date.parse(String(j.until))).toISOString() } : null;
}
const matches = (j: any, x: Expect) => j.id === x.attempt && j.app === x.app && j.from_version === x.from && j.to_version === x.to && j.kind === "ship";

// (Cain 0.19.4) The resumed registration: each attempt read at the keeper until it isn't pending (or the hard cap), then the pass
// moved on by compare-and-swap at the revision the resume wrote; a pass that moved meanwhile (the hook's own write) is left as it is.
export async function resumePass(d: PassDeps, id: string, rev: number): Promise<void> {
  const e0 = peek(d, id);
  if (!e0 || e0.rev !== rev || (e0.state !== "registering" && e0.state !== "accepted") || !e0.claim || !e0.expect || !e0.fp) return;
  const claim = e0.claim, fp = e0.fp, cap = hardCap(e0);
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pub = d.pub();
  const linkFp = pub ? keyFingerprint(pub) : null;
  const accepted: Accepted[] = [], said: string[] = [], cancel: string[] = [];
  let cancelWhy: string | undefined, moved = false;
  for (const x of e0.expect) {
    let last: { status: number; body: any } | null = null, j: any = {}, before: Enrollment | null = null;
    for (;;) {
      const cur = peek(d, id);
      if (!cur || cur.state !== e0.state || cur.rev !== rev) { moved = true; break; }   // the still-pending note moves no revision
      before = d.enrollment?.load() ?? null;
      last = await d.view!(x.attempt).catch(() => null);
      j = last?.body ?? {};
      if (last?.status === 200 && j.status !== "pending") break;
      if (d.now() >= cap) break;
      // (review round 1, item 7) the Keeper says its backup is still running: noted (no revision step), so the pass keeps waiting
      if (last?.status === 200) {
        try { txn(d, (spent) => { const e = find(spent, id); if (!e || e.state !== e0.state) return { write: false, value: null }; e.kp = d.now(); return { write: true, value: null }; }); }
        catch { /* the deadline then counts alone */ }
      }
      await sleep(d.pollMs ?? POLL_MS);
    }
    if (moved) break;
    if (last?.status === 200 && j.status === "accepted" && matches(j, x) && typeof j.backup === "string" && BACKUP_SLUG.test(j.backup)) {
      const en = enrollmentCheckNow(j, fp, linkFp, before, d.enrollment);
      if (en.record) noteRecord(d.enrollment, en.record, d.log);
      if (!en.ok) { cancelWhy ??= en.cancel; cancel.push(x.attempt); said.push(`the keeper accepted ${x.attempt}, but its enrollment is refused: ${en.why}`); continue; }
      accepted.push({ app: x.app, attempt: x.attempt, backup: j.backup, from: x.from, to: x.to });
      d.log(`the resumed pass: the keeper accepted ${x.attempt} ${x.app} ${x.from} to ${x.to}, backup ${j.backup}, unclaimed`);
    } else if (last?.status === 200 && CLAIMED_ON.includes(String(j.status))) {
      // never cancelled: a claim on it isn't this pass's (a registering or accepted pass sent none)
      said.push(`the keeper has ${x.attempt} ${String(j.status).slice(0, 30)}, claimed by another run (left be, not cancelled)`);
    } else {
      cancel.push(x.attempt);
      said.push(!last ? `the keeper didn't answer for ${x.attempt}` : last.status === 200 && j.status === "pending" ? `the keeper was still taking the backup for ${x.attempt} when its Ship token's time ran short`
        : last.status === 200 && j.status === "accepted" ? `the keeper's acceptance of ${x.attempt} isn't for that App, those versions and a ship install`
        : `the keeper has ${x.attempt} as ${String(j.status ?? last.status).slice(0, 30)}, not accepted and unclaimed${j.why ? ` (${String(j.why).slice(0, 120)})` : ""}`);
    }
  }
  if (moved) { d.log(`the resumed pass ${id.slice(0, 8)} moved on while it read the keeper: left as it is`); return; }
  const what = `pull request ${pullUrl(claim)}, landed in main at ${claim.head}`;
  const ok = !said.length;
  const line = ok
    ? `The App restarted while the Keeper backed it up before installing ${what}, and the Keeper has accepted that install since: his Ship tap still counts, nothing is installed yet. Start the same Ship run again now, its text: "Install ${what}. Ship pass: ${id}." The hook puts his Ship token in. Nothing to tell him unless it isn't installed in the end.`
    : "";
  // the compare-and-swap: only from the revision this resume wrote (an owed-cancel or still-pending note moves no revision)
  let r: { done: boolean; why?: string };
  try {
    r = txn(d, (spent) => {
      const e = find(spent, id);
      if (!e || e.rev !== rev || e.state !== e0.state) return { write: false, value: { done: false } };
      delete e.kp;
      if (ok && line.length <= RELAY_MAX && !/[\r\n\t]/.test(line)) {
        if (e.state === "registering") move(e, "accepted"); else move(e);
        e.accepted = accepted; e.fp = fp;
        if (e.relayedAt !== undefined) return { write: true, value: { done: true, why: "relayed" } };
        e.relayedAt = d.now();                      // once per pass id: marked before the line is written
        return { write: true, value: { done: true } };
      }
      move(e, "refused");
      e.said = ok ? "the line to Cain couldn't be written whole" : `the keeper didn't accept every install after the restart: ${said.join("; ").slice(0, 400)}`;
      return { write: true, value: { done: true, why: e.said } };
    });
  } catch { d.log("the resumed pass couldn't be recorded: nothing more is done; the reaper refuses it at its deadline"); return; }
  if (!r.done) { d.log(`the resumed pass ${id.slice(0, 8)} moved on before it was recorded: left as it is`); return; }
  if (r.why === "relayed") { d.log(`the resumed pass ${id.slice(0, 8)} was already relayed to Cain: not again`); return; }
  if (!r.why) {
    try { d.relay?.(line); d.log(`the resumed pass ${id.slice(0, 8)} is accepted again: Cain is told to start the same Ship run by its pass id`); return; }
    catch {
      // (review round 1, item 4) the line can't be written: the pass is cancelled at once
      try { txn(d, (spent) => { const e = find(spent, id); if (!e || e.state !== "accepted") return { write: false, value: null }; move(e, "refused"); e.said = "the line to Cain couldn't be written"; return { write: true, value: null }; }); }
      catch { /* the reaper refuses it at its deadline */ }
      d.log("the resumed pass's line to Cain couldn't be written: the pass is refused and cancelled");
      cancelAll(d, accepted.map((a) => a.attempt), "the link couldn't tell Cain to start the Ship run", id);
      return;
    }
  }
  d.log(`a resumed Ship pass is refused: ${r.why}`);
  // a line that can't be written whole cancels at once; a refusal on the Keeper's answers goes through the owed cancels, read first
  if (ok) cancelAll(d, accepted.map((a) => a.attempt), "the link couldn't tell Cain to start the Ship run", id);
  else cancelAll(d, cancel, cancelWhy ?? "the link restarted before its Ship run started", id, { view: true });
  const told = `The App restarted while the Keeper backed it up before installing ${what}, and that install can't go on (${String(r.why).slice(0, 200)}). Nothing was installed: tell him in one line, then show a new Ship card for the same pull request and head.`;
  try { d.relay?.(told.length <= RELAY_MAX ? told : "The App restarted while the Keeper backed it up before an install, and that install can't go on. Nothing was installed: tell him in one line, then show a new Ship card for the same pull request and head."); }
  catch { d.log("couldn't tell Cain the resumed pass was refused"); }
}

// (Cain 0.19.4, review round 1) A pass left claiming by a restart, reconciled with the Keeper before anything is cancelled.
async function reconcileClaiming(d: PassDeps, id: string, rev: number): Promise<void> {
  const e0 = peek(d, id);
  if (!e0 || e0.rev !== rev || e0.state !== "claiming") return;
  const mine: Claimed[] = [], cancel: string[] = [], other: string[] = [];
  for (const a of e0.accepted ?? []) {
    const v = d.view ? await d.view(a.attempt).catch(() => null) : null;
    const st = String(v?.body?.status ?? "");
    if (v?.status === 200 && CLAIMED_ON.includes(st)) {
      const k = typeof v.body?.claim === "string" ? await ownClaim(d, id, a, v.body.claim) : null;
      if (k) mine.push(k); else other.push(a.attempt);
    } else if (v?.status === 200 && ["ended", "aborted", "refused", "never started"].includes(st)) { /* ended there already */ }
    else cancel.push(a.attempt);
  }
  const all = (e0.accepted ?? []).length > 0 && mine.length === (e0.accepted ?? []).length;
  try {
    const ok = txn(d, (spent) => {
      const e = find(spent, id);
      if (!e || e.rev !== rev || e.state !== "claiming") return { write: false, value: false };
      if (all) { move(e, "passed"); e.claims = mine; e.said = "its claims were found at the keeper after a restart: recorded, no Ship run started from them"; }
      else { move(e, "refused"); e.said = "the link restarted while it claimed the keeper's acceptance, so the pass was refused at its next start"; if (mine.length) e.claims = mine; }
      return { write: true, value: true };
    });
    if (!ok) return;
  } catch { d.log("the reconcile at start couldn't record a pass left claiming: nothing is cancelled"); return; }
  for (const k of mine) d.log(`the reconcile at start found ${k.attempt} claimed by this pass (claim ${k.claim} until ${k.until}): recorded, nothing else done`);
  for (const a of other) d.log(`the reconcile at start found ${a} claimed by another run: left be, never cancelled`);
  if (all) return;
  d.log(`the reconcile at start refused a pass left claiming by a restart: nothing was installed`);
  cancelAll(d, cancel, "the link restarted before its Ship run started", id, { view: true });
  if (e0.claim) relayQuiet(d, `The App restarted before the Ship run for pull request ${pullUrl(e0.claim)} started, and the link couldn't pick it up again. Nothing was installed: tell him in one line, then show a new Ship card for the same pull request and head.`);
}
const relayQuiet = (d: PassDeps, line: string) => { try { d.relay?.(line); } catch { d.log("couldn't tell Cain a pass was refused"); } };

export async function reconcilePasses(d: PassDeps): Promise<number> {
  type Plan = { refused: { id: string; ids: string[]; claim?: PassClaim }[]; resumed: { id: string; rev: number }[]; claiming: { id: string; rev: number }[]; passed: Claimed[] };
  let plan: Plan;
  try {
    plan = txn(d, (spent) => {
      const now = d.now();
      const p: Plan = { refused: [], resumed: [], claiming: [], passed: [] };
      for (const e of spent) {
        if (e.exp * 1000 <= now - 86_400_000) continue;
        if (e.state === "registering" || e.state === "accepted") {
          const r = resumable(d, e, now);
          if ("token" in r) {
            e.resumedAt = now; e.resumes = (e.resumes ?? 0) + 1; delete e.kp;
            move(e);                                // the same state: an accepted pass stays accepted
            p.resumed.push({ id: e.id, rev: e.rev! });
            d.log(`the reconcile at start resumed a pass left ${e.state} by a restart (${(e.expect ?? []).map((x) => x.attempt).join(", ")}): reading the keeper again, nothing installed yet`);
            continue;
          }
          d.log(`the reconcile at start can't resume a pass left ${e.state} by a restart: ${r.why}`);
          const was = e.state;
          const ids = [...new Set([...(e.attempts ?? []), ...(e.accepted ?? []).map((a) => a.attempt)])];
          move(e, "refused"); e.said = "the link restarted before its Ship run started, so the pass was refused at its next start";
          p.refused.push({ id: e.id, ids, claim: e.claim });
          d.log(`the reconcile at start refused a pass left ${was} by a restart (${ids.join(", ") || "no attempt registered yet"}): nothing was installed`);
          continue;
        }
        if (e.state === "claiming") { p.claiming.push({ id: e.id, rev: e.rev ?? 0 }); continue; }
        if (e.state === "passed") p.passed.push(...(e.claims ?? []));
      }
      return { write: p.refused.length + p.resumed.length > 0, value: p };
    });
  } catch {
    d.log("the reconcile at start couldn't read or record the Ship passes: nothing was resumed; the reaper refuses what waits at its deadline");
    return 0;
  }
  if (d.view) for (const k of plan.passed) {
    const v = await d.view(k.attempt).catch(() => null);
    const b = v?.body ?? {};
    d.log(!v ? `the reconcile at start couldn't read ${k.attempt} at Keeper` : `the reconcile at start read ${k.attempt} at Keeper: ${String(b.status ?? v.status).slice(0, 30)}, `
      + (b.install_job ? `tied to the Supervisor's install job ${String(b.install_job).slice(0, 64)} made ${String(b.install_job_at ?? "?").slice(0, 30)}` : "no install job tied to it"));
  }
  for (const r of plan.refused) {
    cancelAll(d, r.ids, "the link restarted before its Ship run started", r.id, { view: true });
    if (r.claim) relayQuiet(d, `The App restarted before the Ship run for pull request ${pullUrl(r.claim)} started, and the link couldn't pick it up again. Nothing was installed: tell him in one line, then show a new Ship card for the same pull request and head.`);
  }
  for (const c of plan.claiming) await reconcileClaiming(d, c.id, c.rev).catch((err) => d.log(`the reconcile of a pass left claiming failed: ${String(err).slice(0, 80)}`));
  // (Cain 0.19.4) the resumed passes, polled after the passed ones were read
  await Promise.all(plan.resumed.map((r) => resumePass(d, r.id, r.rev).catch((err) => d.log(`the resumed pass failed: ${String(err).slice(0, 80)}`))));
  await drainCancels(d);
  return plan.refused.length + plan.claiming.filter((c) => peek(d, c.id)?.state === "refused").length;
}

// (Cain 0.19.4, review round 1, item 3) The one deadline-driven reaper, run every half minute: a pass still registering or accepted
// past its pending deadline (or its backup's maximum age, or its token's hard cap) without a claim is refused, and its attempts
// cancelled at the Keeper through the owed cancels (read first: a claimed one is never cancelled); then every owed cancel due is sent.
export async function reapPasses(d: PassDeps): Promise<number> {
  let reaped: { id: string; ids: string[]; claim?: PassClaim; why: string }[] = [];
  try {
    reaped = txn(d, (spent) => {
      const now = d.now();
      const out: { id: string; ids: string[]; claim?: PassClaim; why: string }[] = [];
      for (const e of spent) {
        let why = "";
        if (e.state === "registering" && !stillPending(e, now, d.waitMs)) why = `the keeper didn't accept every install within ${Math.round((pendingDeadline(e, d.waitMs) - e.at) / 60_000)} minutes of its registration`;
        if (e.state === "accepted" && (now - e.at > BACKUP_MAX_AGE_MS || now > hardCap(e))) why = "its acceptance wasn't claimed in time";
        if (!why) continue;
        move(e, "refused"); e.said = why;
        out.push({ id: e.id, ids: [...new Set([...(e.attempts ?? []), ...(e.accepted ?? []).map((a) => a.attempt)])], claim: e.claim, why });
      }
      const before = spent.length;
      const kept = spent.filter((e) => keep(e, now));
      spent.splice(0, spent.length, ...kept);
      return { write: out.length > 0 || kept.length !== before, value: out };
    });
  } catch (e) { d.log(`the reaper couldn't read or record the Ship passes: ${String(e).slice(0, 80)}`); }
  for (const r of reaped) {
    d.log(`the reaper refused a Ship pass: ${r.why}; nothing was installed`);
    owe(d, r.id, r.ids, r.why);
    if (r.claim && peek(d, r.id)?.relayedAt !== undefined) relayQuiet(d, `The Ship run for pull request ${pullUrl(r.claim)} didn't start in time after the App's restart, so the Keeper's acceptance is cancelled. Nothing was installed: tell him in one line, then show a new Ship card for the same pull request and head.`);
  }
  await drainCancels(d);
  return reaped.length;
}

// (Cain 0.19.4, review round 1, item 4) The resumed pass's token, handed to the Ship run's hook only (POST /ship-pass {fetch: <pass
// id>}): never put in Cain's queue. Only for a pass accepted again after a restart, relayed to Cain, not past its hard cap.
export function fetchToken(d: PassDeps, id: string): PassAnswer {
  if (!/^[0-9a-f]{32}$/.test(id)) return { status: "refused", said: "that isn't a Ship pass id" };
  const e = peek(d, id);
  const now = d.now();
  if (!e) return { status: "refused", said: "no pass with that id" };
  if (e.state !== "accepted" || !e.resumes || e.relayedAt === undefined || !e.claim) return { status: "refused", said: `that pass is ${e.state}, not one accepted again after a restart` };
  if (now > hardCap(e) || now - e.at > BACKUP_MAX_AGE_MS) return { status: "refused", said: "that pass ran out of time" };
  let token: string | null = null;
  try { token = d.sign ? d.sign({ v: 1, kind: "ship", ...e.claim }) : null; } catch { token = null; }
  if (!token || passId(token) !== id) return { status: "refused", said: "its Ship token couldn't be made again" };
  d.log(`handed the resumed pass ${id.slice(0, 8)}'s Ship token to the Ship run's hook`);
  return { status: "token", token };
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
  const id = passId(token);
  const said = `the hook refused the Ship run: ${String(why).replace(/[^\x20-\x7e]/g, " ").slice(0, 200)}`;
  let ids: string[] | null = null;
  try {
    ids = txn(d, (spent) => {
      const e = find(spent, id);
      if (!e) return { write: false, value: null };
      const all = [...(e.claims ?? []).map((k) => k.attempt), ...(e.accepted ?? []).map((a) => a.attempt), ...(e.attempts ?? [])];
      if (e.state !== "refused") { move(e, "refused"); e.said = said; }
      return { write: true, value: all };
    });
  } catch {
    const e = peek(d, id);
    if (!e) return { status: "refused", said: "no pass for that Ship token" };
    d.log("couldn't record a cancelled pass: its claims are cancelled anyway");
    ids = [...(e.claims ?? []).map((k) => k.attempt), ...(e.accepted ?? []).map((a) => a.attempt), ...(e.attempts ?? [])];
  }
  if (!ids) return { status: "refused", said: "no pass for that Ship token" };
  d.log(`a Ship token's pass is cancelled: ${said}`);
  cancelAll(d, ids, "the hook refused the Ship run", id);
  return { status: "refused", said: `${said}. Nothing was installed; start again with a new Ship card for the same pull request and head` };
}

export async function shipPass(d: PassDeps, body: any, depth = 0): Promise<PassAnswer> {
  if (typeof body?.fetch === "string") return fetchToken(d, body.fetch);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "refused", said: "no Ship token" };
  if (typeof body?.cancel === "string" && body.cancel) return cancelPass(d, token, body.cancel);
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  const spent = readEntries(d.load());
  if (!spent) return { status: "refused", said: "the link's record of spent Ship tokens can't be read, so no Ship run starts: log a Build item" };
  const id = passId(token);
  const now = d.now();
  const e = find(spent, id);
  const where = `pull request ${c.claim.pr} at ${c.claim.head.slice(0, 12)}`;
  const again = "Nothing was installed; a new Ship card for the same pull request and head tries again";
  if (!e) {
    const claim = c.claim;
    let made = false;
    try {
      made = txn(d, (all) => {
        if (find(all, id)) return { write: false, value: false };
        const kept = all.filter((x) => keep(x, now));
        all.splice(0, all.length, ...kept, { id, exp: claim.exp, state: "registering", at: now, rev: 1, claim: { repo: claim.repo, pr: claim.pr, head: claim.head, exp: claim.exp } });
        return { write: true, value: true };
      });
    } catch { return { status: "refused", said: "the link couldn't record the Ship token, so no Ship run starts: try again in a minute" }; }
    if (made) {
      d.log(`registering the installs of ${where} with the keeper; the Ship run waits for its acceptance`);
      d.register(token, claim, (r) => settle(d, id, r), (upd) => noteEntry(d, id, upd));
    }
    return depth ? { status: "pending", said: PENDING_SAID } : shipPass(d, body, 1);
  }
  const refuseFor = (said: string, cancel: string[], cancelWhy = "the pass is refused"): PassAnswer => {
    try {
      txn(d, (all) => {
        const cur = find(all, id);
        if (!cur || cur.state === "refused") return { write: false, value: null };
        move(cur, "refused"); cur.said = said;
        return { write: true, value: null };
      });
    } catch { /* refused either way */ }
    d.log(`a Ship token's pass is refused: ${said}`);
    cancelAll(d, cancel, cancelWhy, id);
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
    // (Cain 0.19.4, review round 1, item 6) the deadline from the registration, never reset by a resume
    if (stillPending(e, now, d.waitMs)) return { status: "pending", said: PENDING_SAID };
    return refuseFor(`the keeper didn't accept every install within ${Math.round((pendingDeadline(e, d.waitMs) - e.at) / 60_000)} minutes`, e.attempts ?? []);
  }
  if (e.state === "claiming") {
    if (now - (e.claimingAt ?? 0) <= CLAIMING_STUCK_MS) return { status: "pending", said: "the link is claiming the keeper's acceptance: start the same Ship run again in a minute" };
    return refuseFor("the link stopped while it claimed the keeper's acceptance", (e.accepted ?? []).map((a) => a.attempt));
  }
  // accepted: claim each acceptance at the keeper, then pass. (review round 1, item 6) never on a backup that may be older than
  // BACKUP_MAX_AGE_MS. "claiming" is written durably first, by compare-and-swap at the revision read, so two asks at once claim
  // once, and a restart mid-claim is reconciled with the Keeper rather than claiming twice.
  const accepted = e.accepted ?? [];
  if (now - e.at > BACKUP_MAX_AGE_MS) return refuseFor(`the keeper's backup for it may be over ${BACKUP_MAX_AGE_MS / 60_000} minutes old`, accepted.map((a) => a.attempt));
  let claimingRev: number | null;
  try {
    claimingRev = txn(d, (all) => {
      const cur = find(all, id);
      if (!cur || cur.state !== "accepted" || (cur.rev ?? 0) !== (e.rev ?? 0)) return { write: false, value: null };
      move(cur, "claiming"); cur.claimingAt = now;
      return { write: true, value: cur.rev! };
    });
  } catch { return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  if (claimingRev === null) return { status: "pending", said: "the link's pass moved while it was asked: start the same Ship run again in a minute" };
  const claims: Claimed[] = [];
  for (const a of accepted) {
    // Keeper 0.1.7: the record as it stood before the claim was sent, and the claim's own request id; a claim that
    // got no answer is asked once more with the same id, and the keeper answers that with the recorded claim
    const before = d.enrollment?.load() ?? null;
    const request = claimRequest(id, a.attempt);
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
  let passed: boolean;
  try {
    passed = txn(d, (all) => {
      const cur = find(all, id);
      if (!cur || cur.state !== "claiming" || cur.rev !== claimingRev) return { write: false, value: false };
      move(cur, "passed"); cur.claims = claims;
      return { write: true, value: true };
    });
  } catch { cancelAll(d, accepted.map((a) => a.attempt), "the pass couldn't be recorded", id); return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  if (!passed) { cancelAll(d, accepted.map((a) => a.attempt), "the pass changed while it claimed", id); return { status: "refused", said: `the pass changed while the link claimed. ${again}` }; }
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
  note?: (upd: NoteUpd) => void;
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
  d.note?.({ apps: watched.length, watched: watched.map((b) => APP_SLUGS[b.app]) });   // (Cain 0.19.4, review round 1) the watched Apps by slug
  if (!watched.length) return { ok: true, accepted, said };
  const fpFile = await fileAt(d, c.repo, FINGERPRINT_FILE, c.head);
  const committed = fpFile && fpFile !== "missing" ? readFingerprintFile(fpFile.toString("utf8")) : "";
  if (!committed) { say(`${FINGERPRINT_FILE} at the head ${fpFile === null ? "couldn't be read" : "holds no fingerprint"} (the Build run when the link's Ship key is made writes it), so nothing was registered`); return { ok: false, said }; }
  if (d.linkFp && committed !== d.linkFp) { say(`${FINGERPRINT_FILE} at the head (${committed}) isn't the link's own Ship key (${d.linkFp}), so nothing was registered`); return { ok: false, said }; }
  d.note?.({ fp: committed });                          // (Cain 0.19.4) kept for a resume after a restart
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
    const r = await d.post({ token, app: slug, pr: c.pr, head: c.head, from_version: from, to_version: b.version, kind: drill ? "drill" : "ship",
      ...(drill ? { drill_mode: drill, drill_nonce: nonce } : {}),
      probe_hash: createHash("sha256").update(probe).digest("hex").slice(0, 16) }).catch(() => null);
    let j = r?.body ?? {};
    if (!r || r.status !== 202 || j.status !== "pending" || typeof j.id !== "string" || !ATTEMPT_ID.test(j.id)) {
      say(!r ? `the keeper didn't answer for ${b.app} ${b.version}` : r.status === 202 || r.status === 200 ? `the keeper's answer for ${b.app} ${b.version} isn't a registration of it`
        : `the keeper refused ${b.app} ${b.version}: ${String(j?.why ?? r.status).slice(0, 160)}`);
      notAccepted("the keeper didn't take its registration");
      continue;
    }
    const attempt = j.id;
    d.note?.({ attempt, expect: { attempt, app: slug, from, to: b.version } });
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
      accepted.push({ app: slug, attempt, backup: j.backup, from, to: b.version });
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
