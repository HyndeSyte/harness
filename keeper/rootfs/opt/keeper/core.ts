// The keeper of installs (Keeper 0.1.0; review fixes 0.1.1, 0.1.2, 0.1.3, 0.1.4, 0.1.5, 0.1.6, 0.1.7 and 0.1.8): a check after every
// install of a watched App, and an automatic rollback of a bad one from the App-only backup taken just
// before it.
//
// Everything here is plain logic over injected parts (the Supervisor, the network, the clock and the
// store), so the tests drive it with fakes. main.ts wires the real ones. The keeper never writes its
// own options: it only reads them.
//
// 0.1.3 (the third review's fixes):
//   1. A registration carries the owner's Ship token itself, and the keeper verifies its Ed25519
//      signature with the link's public key (option ship_public_key) before it accepts anything: the
//      repository, the pull request and head named must be the token's, it must not have expired, and
//      a token is spent once per App (its id, a hash, kept in the state). No token is ever stored.
//   2. A restore is sent again only after an answer that proves it was never accepted: a 4xx before
//      any job, with the Supervisor's jobs list showing no restore of that backup. A 5xx, a timeout or
//      any unclear answer is unresolved (fenced, reconciled read only). "Rolled back" needs the restore
//      job (by the id its answer gave) seen finished without errors; the App seen stopping and coming
//      back at the old version without that is unresolved, said to the owner as such. A job that
//      ended with errors is gave up, never sent again (it may already have changed the App's data).
//   3. With more than one App watched, each needs its own alert check (a shared one refuses arming);
//      a success ping to an alert check waits while another App on the same check has an incident
//      open; a dead-man check (hc_deadman) is pinged from the keeper's own process timer; and arming
//      needs a phone test drill the owner confirmed within 60 days.
//   4. Registration is a POST /attempt to the keeper's own service (Cain's token), never an options
//      write; the keeper keeps no copy of its settings (nothing refills options from a snapshot).
//   5. The install check and the rollback's confirmation decide on local evidence only: the App's state,
//      its version and its liveness (/health). Readiness (Cain's /ready, his Discord gateway) is only
//      reported, "chat connected" or "chat not connected (degraded)".
//
// 0.1.4 (the fourth review's fixes):
//   1. Acceptance before the install. POST /attempt answers only once the keeper's own backup is complete
//      and verified (that App alone at from_version, made after the token was issued), with its slug, or
//      refuses (a failed, interrupted or slow backup is "unprotected", paged). The acceptance is single
//      use: consumed when the keeper first sees to_version ("consumed <id>" in its log), and a version
//      change to to_version before acceptance or after consumption is never covered by it. No caller
//      names a backup any more.
//   2. No automatic resend of a restore until a device drill has recorded the Supervisor's real restore
//      job name (state restoreJob); every 4xx before that is unresolved. With it, a 4xx may be sent again
//      once, only when the jobs list shows no job of exactly that name for the backup and nothing
//      restore-like it can't classify.
//   3. The Ship key is pinned in the keeper's state on first use (logged and paged with its fingerprint);
//      a changed option is refused until the owner confirms it at the device (key-confirm <fingerprint>).
//   4. Checks are told apart by the check id in their ping URL's path; the dead-man ping goes only while
//      the poll loop completed within 3 minutes (else its /fail); the phone test pages the dead-man check
//      too, and lapses after 30 days, on any Healthchecks option change and on any page not delivered.
//   Follow-ups: a token issued before the keeper's state was created is refused; an install that passed
//   with chat down for most of its window pages the owner (no restore) so he can roll back by hand.
//
// 0.1.5 (the fifth review's fixes):
//   1. No resend, ever. A restore is called at most once per attempt; a refused (4xx), failed (5xx),
//      timed out or unclear call is unresolved: fenced, reconciled read only by its job id, paged. A drill
//      still records the restore job's name and how long a finished job stays listed, taken only from the
//      job id its own restore call returned (never matched on the reference), for a later version to
//      decide on; nothing here acts on it.
//   2. The claim at the install. An acceptance lasts 30 minutes and covers an install only once claimed
//      (POST /attempt/<id>/claim, Cain's link, bound to the attempt, App, versions and backup slug): atomic
//      (checked and set with no await between), saved durably before the answer, single claimant, valid
//      30 minutes. An acceptance that expires unclaimed, or a claim that expires with no version change,
//      ends with an "ended" line; a version change seen outside a live claim is unprotected (paged). The
//      link cancels a registration it gives up on (POST /attempt/<id>/cancel).
//   3. Enrollment of the Ship key. A first pin, like a rotation, accepts no registration until the owner
//      confirms it at the device (key-confirm); a rewound state needs it again. Acceptance and claim
//      answers report the pinned fingerprint, the confirmation time and the state's creation time, which
//      the link checks against the fingerprint committed in the repository (cain/SHIP_KEY_FINGERPRINT).
//   4. The alert gate. With hc_api_key (a Healthchecks API key) the keeper reads each check's period,
//      grace, status and channels and refuses to arm outside set bounds, with no channel, paused, or with
//      settings changed since the phone test; no key, not armable. The phone test lasts 14 days, and a
//      page with no acknowledgment (a 2xx) from Healthchecks within 10 minutes closes the gate until a
//      new phone test.
//   Follow-up: register-then-poll. POST /attempt answers 202 at once; the backup is made in the
//   background and the link polls GET /attempt/<id> until accepted or refused.
//
// 0.1.6 (the sixth review's fixes):
//   1. A read-only Healthchecks key only. A key whose answer shows ping URLs can write (pause checks,
//      change grace and period, reroute channels): refused for arming, logged and paged once with the
//      swap to make. A read-only key that hides channels doesn't refuse: the owner confirms each check's
//      page on the phone (phone-confirm names each check; the heartbeat check by the missed-heartbeat
//      drill), and arming takes that record in place of the API's channel list. A slug that matches more
//      than one check refuses.
//   2. The missed-heartbeat drill: the heartbeat ping to hc_done stops for the check's period plus grace
//      (read from the API) plus 2 minutes, Healthchecks must show it down, and the owner confirms the page
//      within an hour. Arming needs it within 14 days; it lapses with the phone test.
//   3. The claim's deadline bounds the start, not the watch: an install first seen inside its claim is
//      watched its 15 minutes past the deadline. A version change during a live claim to a version other
//      than the claimed one is uncertain (unprotected, paged, never restored).
//   4. The confirms (key-confirm, phone-confirm, missed-heartbeat-confirm) are served only on the
//      container's own loopback listener (127.0.0.1:8096, never the App network) and need the one-time
//      code Keeper prints in its log at the pin, at each phone test and at the drill.
//   5. Orphan backups: the backup of a registration cancelled, or of an acceptance that expired unclaimed,
//      is deleted (logged by its slug; one that can't be deleted is named in the log, left for the owner).
//
// 0.1.7 (the seventh review's fixes):
//   Accepted limits. Two limits of the design are written in DOCS.md ("Accepted limits", text version
//      LIMITS_VERSION) and the owner accepts them at the device (accept-limits <code>); arming needs that
//      acceptance, and it lapses when the text's version changes.
//   1. The Healthchecks key leaves the options: entered once through hc-key <code> (the key on standard
//      input), checked read-only and seeing the configured checks before it is kept, kept root-only (0600) in
//      the data folder and excluded from the keeper's own backups (config.yaml backup_exclude). A refused key
//      is never kept; an old hc_api_key option still present gets a line at every start.
//   2. The claim record: claim, cancel and consume serialized under one lock (record()), idempotent (a retry
//      with the same request reads the recorded outcome). A claim that expires with no version change is
//      unused: its backup is deleted after the jobs list shows no active install or update of the App.
//      A cancel after the claim was handed to a started run (a version change seen) is refused.
//   Follow-ups: one drill at a time (unarmed, registrations refused; a restart or a registration interrupts
//   it); each one-time code bound to its challenge and consumed at once; the phone test confirmed whole, in
//   one call; an enrollment id and a monotonic counter in every enrollment; the missed-heartbeat drill polls
//   Healthchecks until it shows the check down (capped) and refuses a schedule check; an attempt-specific
//   backup name kept before the backup call, reconciled after a restart; explicit unique keys per check
//   (option hc_unique_keys) when the derived one doesn't match.
//
// 0.1.8 (the eighth review's fixes):
//   1. The accepted limits' text is version 2 (LIMITS_VERSION): an acceptance of version 1 lapses. Every claim's
//      start and end is logged with its deadline, one line each; option drill_days (1 to 14, default 14) sets how
//      long a phone test and a missed-heartbeat drill count, with a log reminder before each is due.
//   2. The old option hc_api_key, while the Supervisor still holds it in the options, refuses arming and the hc-key
//      entry (OLD_KEY_WHY). The key file is written 0600 from its first byte (main.ts hcKeyStore).
//   3. The cancel reads the Supervisor's jobs list under the claim record's lock: an active install, update,
//      rebuild or restore of the App, an active job on the App whose name isn't recognized, or a list that can't
//      be read refuses it (the claim and its backup kept). A claim expired unused keeps its backup until one more
//      poll after the deadline shows no version change.
//   Follow-ups: every external call under the lock is bounded (LOCK_CALL_MS), a step that throws or runs past
//   LOCK_STEP_MS is logged and the lock released, and the deadline is read again under the lock right before a
//   claim or a consume commits; /armed is answered under the lock and only once its counter is saved; a cancel
//   that says the link refused the enrollment logs it and prints a key code (otherwise printed at start only
//   while unenrolled, or on demand with key-code).
//
// 0.1.9 (the ninth review's fixes, a scoped round):
//   A1. The lock's generation (Fence): each step under the claim record's lock gets its own generation; every commit,
//       delete or state write checks it first, synchronously, in the same tick as the write (fence.live()), and an
//       external write runs through fence.write(), so a write in flight when the step times out keeps the lock until
//       it ends; a step that resumes after its time ran out changes nothing.
//   A2. The key file's temporary file has a fixed prefix the backup exclusion covers (main.ts HC_KEY_TMP_PREFIX);
//       leftovers, the earlier builds' temporary names included, are removed and logged at every start.
//   A3. A cancel or an unused expiry ends the claim and never deletes its backup: "ended; backup kept: <reason>",
//       naming the backup, kept for the bounded cleanup (B), bound to the attempt's generation.
//   B.  The bounded cleanup of kept backups (cleanup()): only Keeper's own (its name and a generation record), at start,
//       before a new backup and on a daily tick, under the lock, never beside an open attempt or an install job, 2 hours
//       after the claim ended, 48 hours at most (plus one tick), at most two kept; a free-space reserve before every
//       new backup (the last one's size and a half), refused, logged and paged when it can't fit.
//   C.  Hard refusals: hc-key is refused until the backup check passed on the device (backupCheck: a test backup of
//       Keeper omits every key name and holds no key value, fingerprint or sentinel); arming is refused until the old
//       key's rotation is attested by the owner's tap (POST /rotation/attest, signed by the link), the old key first
//       tried and rejected where it was kept; an options read that fails or times out counts as the old option present;
//       every role needs its check's unique key in hc_unique_keys; the backup check must have passed.
//   D.  The enrollment code (key-confirm's) is printed only on demand (key-code), never at start; codes printed by
//       earlier builds are void at this build's first start.
//
// The life of an attempt (one install of one App, registered just before the install):
//   verifying    the registration was taken (answered 202); its backup is being made and checked
//   unprotected  the backup (or the registration) failed a check, or the install was seen outside a
//                live claim: nothing is ever restored for it
//   accepted     the backup holds that App alone at from_version: "accepting ..." is logged; 30 minutes
//                to be claimed
//   claimed      (0.1.5) Cain's link claimed it as the Ship run started: "claimed ..." is logged; 30
//                minutes for to_version to show
//   ended        (0.1.5) the acceptance expired unclaimed, the claim expired with no version change, or
//                the link cancelled it: nothing is restored for it
//   watching     to_version was seen in the App's info within the claim (consumed): 15 minutes from then
//   restoring    a fail: marked before the restore starts, so the version change it causes is this
//                attempt's recovery and never a new attempt, across restarts
//   unresolved   the restore's outcome isn't established, or it was refused: fenced (nothing is sent again, ever),
//                reconciled read only on every poll, and moved on (one follow-up line) once known
//   passed       the watch ended with every pass condition held
//   rolled back  the restore job finished without errors and from_version is started and live again
//   gave up      the restore failed, or the App didn't come back
//   never started  (before 0.1.5) the install deadline passed without to_version ever seen
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify, type KeyObject } from "node:crypto";
import { scanBackup } from "./scan.ts";

export const PROTOCOL = 1;                       // the verdict protocol version, bound into the armed state
export const BACKUP_SCOPE = "app-only";          // the backup scope bound into the armed state
export const REGISTRAR = "0fcc2575_cain";        // (0.1.3) the only App whose token may register an install
export const POLL_MS = 30_000;
export const WATCH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 60_000;              // the heartbeat time in /data, /armed's timestamp, the dead-man ping
export const HC_HEARTBEAT_MS = 5 * 60_000;       // the ping to hc_done, and the log ping to each alert check
export const REGISTER_WAIT_MS = 4 * 60_000;      // (0.1.4) the keeper's backup must complete within this (0.1.5: in the background)
export const BACKUP_DATE_SKEW_MS = 60_000;       // (0.1.4) the backup's date may read this much before the token's issue
export const ACCEPT_MS = 30 * 60_000;            // (0.1.5) an acceptance must be claimed within this
export const CLAIM_MS = 30 * 60_000;             // (0.1.5) a claim is valid this long: to_version must show within it
export const RESTORE_LIMIT_MS = 15 * 60_000;     // the restore's whole limit, refusals included, from the fail
export const CONFIRM_MS = 5 * 60_000;            // after the restore job: from_version started and live within this
export const REWIND_MS = 10 * 60_000;            // a heartbeat gap at start over this drops the drill records
export const ARMED_MAX_MS = 60 * 86_400_000;     // drill records last 60 days
export const PHONE_MAX_MS = 14 * 86_400_000;     // (0.1.5) the phone test lasts 14 days (30 in 0.1.4)
export const PAGE_ACK_MS = 10 * 60_000;          // (0.1.5) a page with no 2xx from Healthchecks within this closes the gate
export const HC_READ_MS = 60_000;                // (0.1.5) the Healthchecks settings read, at most this often
export const HC_READ_FRESH_MS = 3 * 60_000;      // (0.1.5) arming needs a settings read this recent
export const HC_DONE_PERIOD_MAX_S = 300, HC_DONE_GRACE_MAX_S = 600;     // (0.1.5) the heartbeat check's bounds
export const HC_DEADMAN_PERIOD_S = 60, HC_DEADMAN_GRACE_MAX_S = 300;    // (0.1.5) the dead-man check's bounds
export const JOB_LISTING_MAX_MS = 2 * 86_400_000; // (0.1.5) a drill's restore job is watched this long for how long it stays listed
export const LOOP_FRESH_MS = 3 * 60_000;         // (0.1.4) the dead-man ping goes only while a poll completed within this
export const DELIVERY_MS = 10 * 60_000;          // armed only while the heartbeat, dead-man and log pings were delivered within this
export const STUCK_FAIL_MS = 2 * 60_000;         // a fail ping undelivered for longer than this disarms
export const PHONE_WINDOW_MS = 60 * 60_000;      // (0.1.3) a phone test is confirmed within an hour of its page
export const KEY_CODE_MS = 24 * 3_600_000;       // (0.1.6) the key-confirm code lasts this long (a restart prints a new one)
export const MHB_MAX_MS = 14 * 86_400_000;       // (0.1.6) arming needs a missed-heartbeat drill confirmed within this
export const MHB_CAP_MS = 30 * 60_000;           // (0.1.7) the missed-heartbeat drill's silence ends here at the latest
export const LIMITS_VERSION = 6;                 // (0.1.7) the version of DOCS.md's "Accepted limits" text the owner accepts (0.1.8: 2; 0.1.9: 3; 0.1.10: 4; 0.1.11: 5; 0.1.12: 6)
export const LOCK_CALL_MS = 10_000;              // (0.1.8) each external call under the claim record's lock is bounded by this
export const LOCK_STEP_MS = 30_000;              // (0.1.8) a step under the lock that runs past this is logged and the lock released
// (0.1.11) A step's external write whose outcome stays unknown holds the lock at most this long: then the write is marked late
// (reconciled later by its pre-chosen name or id), the lock is released, and the owner is paged once.
export const PENDING_CEILING_MS = 3 * 60_000;
// (0.1.10) The hook's bound: its 10-second pass budget and a pending pass started again a minute apart, up to 6 times, rounded
// up. The kept backups' grace is strictly longer than the Ship token's life plus this, so no backup a still-valid token's run
// could reach is ever deleted.
export const HOOK_BOUND_MS = 10 * 60_000;
export const KEPT_GRACE_MS = 150 * 60_000;       // (0.1.9) a kept backup is never touched within this of its claim's end (0.1.10: 2 hours 30 minutes)
export const KEPT_MAX_MS = 48 * 3_600_000;       // (0.1.9) and kept at most this long (plus one cleanup tick)
export const CLEANUP_TICK_MS = 24 * 3_600_000;   // (0.1.9) the cleanup's daily tick
export const KEPT_MAX_COUNT = 2;                 // (0.1.9) at most this many unclaimed backups kept
export const SPACE_RESERVE_BYTES = 1024 ** 3;    // (0.1.9) free space kept beyond the projected backup
export const FIRST_BACKUP_BYTES = 2 * 1024 ** 3;   // (0.1.10) the reserve floor for a first backup (no last size) when the App's image size isn't known
export const ROTATION_CHALLENGE_MS = 10 * 60_000; // (0.1.10) a rotation challenge is good this long, and used once
// (0.1.10) The backup exclusion as this build ships it (config.yaml backup_exclude, checked equal by the tests): a backup
// check's pass is tied to its hash, so a change of the exclusion voids the pass.
// 0.1.12: and the backup key store, backup-keys in the data folder, the folder and everything in it (its temporary files too).
export const BACKUP_EXCLUDE = ["hc-key*", "*/hc-key*", "backup-keys", "*/backup-keys", "backup-keys/*", "*/backup-keys/*"];
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
export const excludedName = (name: string) => BACKUP_EXCLUDE.some((g) => globRe(g).test(name));
export const EXCLUDE_HASH = createHash("sha256").update(JSON.stringify(BACKUP_EXCLUDE)).digest("hex").slice(0, 12);
export const CHECK_CONTROL_FILE = "backup-check-control";   // (0.1.10) the positive control's file: NOT in the exclusion
export const CODE_EPOCH = 9;                     // (0.1.9) codes printed by builds before this one are void
export const ROTATION_TTL_S = 3600;              // (0.1.9) a rotation attestation is good this long after the tap
export const ROTATION_PROOF_TAP = "attested by your tap only";   // (0.1.10) no old key was kept, so nothing was tried
export const ROTATION_PROOF_TRIED = "your tap, and the alert service turning the old key down";
// (0.1.10) The old key's try judged: revoked only on a 401, or the alert service's documented invalid-key answer
// ({"error": "wrong api key"}, Healthchecks' API docs); valid on a 200; anything else, a bare 403 included, proves nothing.
export function revocation(r: { status: number; error?: string } | null): { state: "revoked" | "valid" | "unknown"; why: string } {
  if (!r) return { state: "unknown", why: "no answer" };
  if (r.status === 401) return { state: "revoked", why: "401" };
  if (r.status >= 400 && r.status < 500 && /^wrong api key$/i.test(s(r.error))) return { state: "revoked", why: `${r.status} wrong api key` };
  if (r.status === 200) return { state: "valid", why: "200" };
  if (r.status === 403) return { state: "unknown", why: "a bare 403, which doesn't prove the key revoked" };
  return { state: "unknown", why: `an answer of ${r.status}` };
}
// (0.1.9) The key file's names: the kept key, the old key (kept only to try it once), the temporary files' fixed prefix,
// and the earlier builds' temporary names. config.yaml's backup_exclude covers every one ("hc-key*").
export const KEY_FILE = "hc-key", OLD_KEY_FILE = "hc-key-old", KEY_TMP_PREFIX = "hc-key.tmp-";
export const LEGACY_KEY_TMP = /^hc-key\.\d+\.[0-9a-f]{12}\.tmp$/;
// 0.1.12: a name in the backup key store is one too (the scan finds data/backup-keys and anything under it)
export const KEY_NAME = /(^|\/)(hc-key|backup-keys(\/|$))/;
// (0.1.12) The backup key store: one file per backup Keeper makes of a watched App, named by that backup's name, holding the
// backup's password (BACKUP_KEY_BYTES random bytes, base64url), root-only, never in the options, the state or a log line. Its
// temporary files have the fixed prefix BACKUP_KEY_TMP_PREFIX; the backup check's sentinel goes in BACKUP_KEY_SENTINEL there.
export const BACKUP_KEYS_DIR = "backup-keys", BACKUP_KEY_TMP_PREFIX = "tmp-", BACKUP_KEY_SENTINEL = "backup-check-sentinel";
export const BACKUP_KEY_BYTES = 32;
// (0.1.9) Keeper's own backup name, bound to an attempt (with an 8 hex nonce); a backup check's own name.
export const KEEPER_BACKUP = /^Keeper ((?:ship|drill)-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}) [0-9a-f]{8}$/;
export const DRILL_DAYS_DEFAULT = 14;            // (0.1.8) option drill_days: how long a phone test and a missed-heartbeat drill count
// (0.1.8) The old option, while the Supervisor still holds it: arming and the hc-key entry are refused with this line.
export const OLD_KEY_WHY = "the old option hc_api_key is still in Keeper's options: remove it, then rotate that key in the alert service";
// (0.1.9) An options read that fails or doesn't answer in time counts as the old option present.
export const OPTIONS_UNKNOWN_WHY = "Keeper's options couldn't be read through the Supervisor (or the read timed out), so the old option hc_api_key counts as present: not armable, and hc-key is refused";
export const BACKUP_CHECK_WHY = "the backup check hasn't passed on the device (backup-check: a test backup of Keeper must leave out every key file and hold no key)";
// (0.1.8) The link's cancel when it refused the keeper's enrollment (cain link/ship-pass.ts), and Keeper's line for it.
export const ENROLL_BEHIND = "enrollment counter behind the link";
export const ENROLL_REFUSED = "enrollment refused by the link";
export const HC_KEY_CODE_MS = 24 * 3_600_000;    // (0.1.7) the hc-key and accept-limits codes last this long
export const DROP_TRIES = 3;                     // (0.1.6) an orphan backup's delete is tried this often
export const RESTARTS_MAX = 2;                   // more stops than this after a restore, in the confirm window: gave up
export const SHIP_TTL_S = 2 * 3600;              // a Ship token lasts 2 hours after the tap (cain/rootfs/opt/cain/ship-token.ts)
export const SHIP_SKEW_S = 5 * 60;
export const SHIP_REPOS = new Set(["hyndesyte/harness"]);
export const DEFAULT_HEALTH_GRACE_S = 180;

// -- options --------------------------------------------------------------------------------------
export interface Options {
  watch: string[];
  health: Record<string, string>;                // slug -> "host:port" or "host:port/path"
  tokens: Record<string, string>;                // slug -> token
  hc_done: string;
  hc_deadman: string;                            // (0.1.3) the dead-man check's ping URL
  hc_failed: Record<string, string>;             // slug -> alert check URL; "*" for every App (a single URL)
  health_grace_s: number;
  ship_public_key: string;                       // (0.1.3) the link's Ship key, public half (SPKI DER, base64)
  // (0.1.7) hc_api_key is gone from the options: the key is entered with hc-key and kept in the data folder.
  hc_unique_keys: Record<string, string>;        // (0.1.7) role (done, deadman, or an App slug) -> the check's unique key
  drill_days: number;                            // (0.1.8) 1 to 14: how long a phone test and a missed-heartbeat drill count
  // (0.1.14) true (the default) while the drill plan's follow-up items are open: Keeper reads not armed whatever the drills
  // recorded, so arming can't complete on the runbook alone. The owner sets it false once they have landed. Not in the
  // options' hash, so clearing it never drops the drill records.
  drill_followups_open: boolean;
}
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const pairs = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const x of Array.isArray(v) ? v : []) {
    const t = s(x); const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
// hc_failed: a single URL (every App's alert check), or per App: a map of slug to URL, or the option's
// list form, entries "slug=URL" and at most one plain URL (every other App).
export function parseAlerts(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const one = (t: string) => {
    const i = t.indexOf("=");
    const k = i > 0 ? t.slice(0, i).trim() : "";
    if (k && SLUG.test(k)) { const u = t.slice(i + 1).trim(); if (u) out[k] = u; }
    else if (t) out["*"] = t;
  };
  if (typeof v === "string") one(v.trim());
  else if (Array.isArray(v)) for (const x of v) one(s(x));
  else if (v && typeof v === "object") for (const [k, u] of Object.entries(v)) if ((SLUG.test(k) || k === "*") && s(u)) out[k] = s(u);
  return out;
}
export function parseOptions(raw: unknown): Options {
  const o: any = raw && typeof raw === "object" ? raw : {};
  const watch = (Array.isArray(o.watch) ? o.watch : []).map(s).filter((x: string) => SLUG.test(x));
  const grace = Number(o.health_grace_s);
  const days = Number(o.drill_days);
  return {
    drill_days: Number.isInteger(days) && days >= 1 && days <= 14 ? days : DRILL_DAYS_DEFAULT,
    drill_followups_open: o.drill_followups_open !== false,
    watch, health: pairs(o.health), tokens: pairs(o.tokens), hc_done: s(o.hc_done), hc_deadman: s(o.hc_deadman), hc_failed: parseAlerts(o.hc_failed),
    health_grace_s: Number.isFinite(grace) && grace >= 0 && grace <= 900 ? Math.floor(grace) : DEFAULT_HEALTH_GRACE_S,
    ship_public_key: s(o.ship_public_key).replace(/\s+/g, ""),
    hc_unique_keys: Object.fromEntries(Object.entries(pairs(o.hc_unique_keys)).map(([k, v]) => [k, v.toLowerCase()]).filter(([k, v]) => (k === "done" || k === "deadman" || SLUG.test(k)) && /^[0-9a-f]{40}$/.test(v))),
  };
}
const sortedRec = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
// The options' hash, canonical, so an options change re-binds (and drops) the drill records.
// (0.1.7) The kept Healthchecks key counts as an option here (its hash), though it isn't one any more.
export function optionsHash(o: Options, hcKey = ""): string {
  const canon = JSON.stringify({ watch: [...o.watch].sort(), health: sortedRec(o.health), tokens: sortedRec(o.tokens),
    hc_done: o.hc_done, hc_deadman: o.hc_deadman, hc_failed: sortedRec(o.hc_failed), health_grace_s: o.health_grace_s, ship_public_key: o.ship_public_key,
    hc_api_key: hcKey ? sha(hcKey).slice(0, 16) : "", hc_unique_keys: sortedRec(o.hc_unique_keys) });
  return sha(canon).slice(0, 16);
}
export const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const HTTPS = /^https:\/\/\S+$/;
// (0.1.4) The Healthchecks options' hash: a phone test counts only under the options it was made with.
export const hcHash = (o: Options, hcKey = "") => sha(JSON.stringify({ hc_done: o.hc_done, hc_deadman: o.hc_deadman, hc_failed: sortedRec(o.hc_failed), hc_api_key: hcKey ? sha(hcKey) : "", hc_unique_keys: sortedRec(o.hc_unique_keys) })).slice(0, 16);
// (0.1.4) A check's identity: the check id in its ping URL's path, the Healthchecks uuid
// (https://hc-ping.com/<uuid>) or slug (https://hc-ping.com/<ping key>/<slug>), lower case. Two URLs naming
// the same check (a trailing slash, a query, another host spelling) are the same check. "" when the path
// names none, or ends in a ping's own suffix (/fail, /log, /start, an exit code).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function checkId(url: string): string {
  if (!HTTPS.test(url)) return "";
  let path: string;
  try { path = new URL(url).pathname; } catch { return ""; }
  const segs = path.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x).toLowerCase(); } catch { return x.toLowerCase(); } });
  const last = segs[segs.length - 1] ?? "";
  if (!last || /^(fail|log|start|\d+)$/.test(last)) return "";
  const uuid = segs.find((x) => UUID.test(x));
  return uuid ?? last;
}

// (0.1.5) The Healthchecks checks' settings judged for arming (Keeper.readHc): ok, why not, and the hash
// of the settings that count (each role's check: period, grace, channels, schedule). 0.1.6: an answer that
// shows any ping URL comes from a key that can write (rw: refused, never armed on); a check whose channels
// the read-only key hides is listed in hidden (hand-confirmed at the phone test and the missed-heartbeat
// drill); a slug that matches more than one check refuses. done: the heartbeat check's period, grace and
// status (the missed-heartbeat drill reads them).
export interface HcJudged { ok: boolean; why: string; hash: string; rw?: boolean; hidden?: string[]; done?: { period: number; grace: number; status: string; schedule?: string } }
export const HC_RW_WHY = "the kept Healthchecks key can write (the Healthchecks API answered it with ping URLs, which only a read-write key sees): enter the project's read-only API key with hc-key";
export const hcCanWrite = (list: HcCheck[]) => list.some((c) => typeof c.ping_url === "string" && c.ping_url);
// (0.1.7) The checks the options name, by role: the heartbeat check (done), the dead-man check (deadman) and
// each watched App's alert check (its slug), each with the unique key the owner set for it, if any.
export function hcRoles(o: Options): [string, string, "done" | "deadman" | "alert", string][] {
  return [["hc_done (the heartbeat check)", o.hc_done, "done", "done"], ["hc_deadman (the dead-man check)", o.hc_deadman, "deadman", "deadman"],
    ...o.watch.map((a) => [`${appName(a)}'s alert check`, o.hc_failed[a] ?? o.hc_failed["*"] ?? "", "alert", a] as [string, string, "alert", string])];
}
// (0.1.7) A check found in the API's list: by the unique key the owner set for its role (hc_unique_keys) when
// there is one, else by the id in its ping URL (a uuid's unique key, or the slug). A string says why not.
export function hcFind(o: Options, list: HcCheck[], url: string, role: string): HcCheck | string | undefined {
  const explicit = o.hc_unique_keys[role];
  if (explicit) return list.find((c) => typeof c.unique_key === "string" && c.unique_key.toLowerCase() === explicit);
  const id = checkId(url);
  if (!id) return undefined;
  if (UUID.test(id)) {
      const keys = [sha1(id), sha1(id.replace(/-/g, ""))];
    return list.find((c) => typeof c.unique_key === "string" && keys.includes(c.unique_key.toLowerCase()));
  }
  const hits = list.filter((c) => typeof c.slug === "string" && c.slug.toLowerCase() === id);
  return hits.length > 1 ? `its slug ${id} matches ${hits.length} checks the key can read (give each check its own slug, use its uuid ping URL, or set its unique key in hc_unique_keys)` : hits[0];
}
export function judgeHc(o: Options, list: HcCheck[]): HcJudged {
  if (hcCanWrite(list)) return { ok: false, why: HC_RW_WHY, hash: "", rw: true };
  const seen: unknown[] = [];
  const hidden: string[] = [];
  let done: HcJudged["done"];
  for (const [name, url, role, key] of hcRoles(o)) {
    const c = hcFind(o, list, url, key);
    if (typeof c === "string") return { ok: false, why: `${name}: ${c}`, hash: "" };
    if (!c) return { ok: false, why: `${name} isn't among the checks the kept Healthchecks key can read${o.hc_unique_keys[key] ? " (by the unique key set in hc_unique_keys)" : ""}`, hash: "" };
    const period = typeof c.timeout === "number" ? c.timeout : NaN, grace = typeof c.grace === "number" ? c.grace : NaN;
    if (role === "done") done = { period, grace, status: String(c.status ?? ""), ...(c.schedule ? { schedule: c.schedule } : {}) };
    const shown = typeof c.channels === "string";
    if (!shown) hidden.push(checkId(url));
    else if (!c.channels!.split(",").map((x) => x.trim()).filter(Boolean).length) return { ok: false, why: `${name} has no notification channel assigned`, hash: "", done };
    if (c.status === "paused") return { ok: false, why: `${name} is paused`, hash: "", done };
    if (role !== "alert" && c.status === "down") return { ok: false, why: `${name} is down`, hash: "", done };
    if (role === "done" && (c.schedule || !(period > 0 && period <= HC_DONE_PERIOD_MAX_S) || !(grace >= 0 && grace <= HC_DONE_GRACE_MAX_S)))
      return { ok: false, why: `${name} needs a simple period of at most 5 minutes and a grace of at most 10 (it has ${c.schedule ? "a schedule" : `period ${period}s, grace ${grace}s`})`, hash: "", done };
    if (role === "deadman" && (c.schedule || period !== HC_DEADMAN_PERIOD_S || !(grace >= 0 && grace <= HC_DEADMAN_GRACE_MAX_S)))
      return { ok: false, why: `${name} needs a simple period of 1 minute and a grace of at most 5 (it has ${c.schedule ? "a schedule" : `period ${period}s, grace ${grace}s`})`, hash: "", done };
    seen.push([role, url ? checkId(url) : "", period, grace, shown ? c.channels!.split(",").map((x) => x.trim()).sort().join(",") : "(hidden)", c.schedule ?? ""]);
  }
  return { ok: true, why: "", hash: sha(JSON.stringify(seen)).slice(0, 16), hidden, done };
}
const sha1 = (t: string) => createHash("sha1").update(t).digest("hex");
const mb = (n: number) => Math.round(n / (1024 * 1024));

export const SLUG = /^[a-z0-9_]{1,64}$/;
const OUTSIDE_CLAIM = "the install was seen outside a live claim (the acceptance unclaimed, its claim expired, or the attempt ended), so it is uncertain";
// (0.1.4) Kinds of line that page and clear themselves, leaving no incident open.
const NOTICES = new Set(["phone test", "key pinned", "key changed", "degraded", "ended", "hc key"]);
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const BACKUP = /^[A-Za-z0-9_-]{1,64}$/;
const PROBE_HASH = /^[0-9a-f]{12,64}$/;
const HEAD = /^[0-9a-f]{40}$/;
// A health address with a path other than /health names a readiness endpoint (Cain's /ready): reported
// as chat connected or not, never deciding anything (0.1.3). Liveness is always the host's /health.
export const hasReadiness = (hp: string | undefined) => !!hp && /\/[A-Za-z0-9._/-]+$/.test(hp) && !/\/health$/.test(hp);
export const chatWords = (c: boolean | null | undefined) => (c === true ? "chat connected" : c === false ? "chat not connected (degraded)" : "");

// -- the Ship token (0.1.3) -----------------------------------------------------------------------
// "ship1.<payload>.<signature>", both base64url; the payload is the claim {v: 1, repo, pr, head, exp}
// as JSON and the Ed25519 signature covers "ship1.<payload>" (cain/rootfs/opt/cain/ship-token.ts, which
// signs it with the link's own key; only its public half is here).
export interface ShipClaim { repo: string; pr: number; head: string; exp: number }
const B64URL = /^[A-Za-z0-9_-]+$/;
const unb64url = (t: string) => Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
export function shipKey(spkiB64: string): KeyObject | null {
  if (!spkiB64) return null;
  try {
    const k = createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch { return null; }
}
const SHIP_CLAIM_KEYS = ["exp", "head", "pr", "repo", "v"];
export const shipClaimShape = (c: any): boolean => {
  const keys = Object.keys(c).sort();
  return (c.kind === undefined ? JSON.stringify(keys) === JSON.stringify(SHIP_CLAIM_KEYS) : c.kind === "ship" && JSON.stringify(keys) === JSON.stringify([...SHIP_CLAIM_KEYS, "kind"].sort()));
};
export function readShipToken(token: string, key: KeyObject, nowMs: number): { ok: true; claim: ShipClaim } | { ok: false; why: string } {
  const parts = token.trim().split(".");
  if (token.length > 1000 || parts.length !== 3 || parts[0] !== "ship1" || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return { ok: false, why: "its token isn't a Ship token" };
  const sig = unb64url(parts[2]);
  let good = false;
  try { good = sig.length === 64 && edVerify(null, Buffer.from(`ship1.${parts[1]}`, "utf8"), key, sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its token's signature doesn't verify with the link's public key" };
  let c: any;
  try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its token's claim can't be read" }; }
  if (!c || c.v !== 1 || typeof c.repo !== "string" || !Number.isSafeInteger(c.pr) || c.pr < 1 || typeof c.head !== "string" || !HEAD.test(c.head) || !Number.isSafeInteger(c.exp))
    return { ok: false, why: "its token's claim isn't a Ship approval" };
  // (0.1.14) the payload's kind, exactly: a Ship approval's keys and nothing else, and a kind (if any) of "ship"; a drill flag or
  // any other signed payload of the link's is never a Ship token, whatever its prefix
  if (!shipClaimShape(c)) return { ok: false, why: "its token's payload kind isn't a Ship approval" };
  if (!SHIP_REPOS.has(c.repo.toLowerCase())) return { ok: false, why: "its token is for another repository" };
  if (c.exp * 1000 <= nowMs) return { ok: false, why: "its token has expired" };
  if (c.exp * 1000 > nowMs + (SHIP_TTL_S + SHIP_SKEW_S) * 1000) return { ok: false, why: "its token's expiry is further off than a Ship token lasts" };
  return { ok: true, claim: { repo: c.repo, pr: c.pr, head: c.head, exp: c.exp } };
}
// A token's id: a hash, so the state never holds the token.
export const tokenId = (token: string) => sha(`keeper-spent-v1\n${token.trim()}`).slice(0, 32);
// (0.1.4) A public key's fingerprint: the first 16 hex digits of the SHA-256 of its DER bytes.
export const keyFp = (spkiB64: string) => createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex").slice(0, 16);

export const appName = (slug: string) => { const b = slug.replace(/^[0-9a-f]{8}_/, ""); return b ? b[0].toUpperCase() + b.slice(1) : slug; };

// -- state ----------------------------------------------------------------------------------------
export type Status = "verifying" | "unprotected" | "accepted" | "claimed" | "ended" | "watching" | "restoring" | "passed" | "rolled back" | "gave up" | "never started" | "unresolved";
export const OPEN: Status[] = ["verifying", "accepted", "claimed", "watching", "restoring"];
export type TriggerKind = "state-error" | "not-started" | "health" | "verdict" | "deadline" | "version-moved" | "watch-end";
export interface Attempt {
  id: string; app: string; from: string; to: string; backup: string; deadline: number;
  auth: "ship" | "drill"; authHash: string; pr: number; head: string; authExpires: number; probeHash: string;
  registeredAt: number; status: Status; why?: string;
  backupAsked?: number;                          // (0.1.3) the keeper's own backup, asked at
  issuedAt?: number;                             // (0.1.4) the token's issue (ms): the backup must be made after it
  acceptedAt?: number; consumedAt?: number;      // (0.1.4) the acceptance, and its single use
  acceptUntil?: number;                          // (0.1.5) the acceptance must be claimed before this
  claim?: { id: string; at: number; until: number; request?: string };   // (0.1.5) the link's claim, made as the Ship run started (0.1.7: its request id)
  cancel?: { at: number; request?: string; why: string };   // (0.1.7) the link's cancel, as recorded (a retry reads it)
  backupName?: string;                           // (0.1.7) the attempt-specific backup name, kept before the backup call
  chatPolls?: number; chatDown?: number;         // (0.1.4) readiness polls in the watch, and how many were down
  firstSeenTo?: number; firstStartedTo?: number; watchEnd?: number;
  notStarted: number; healthFails: number; startedEveryPoll: boolean;
  liveSeen?: boolean;                            // one liveness 200 since the App's start: only then do failures count
  chat?: boolean | null;                         // (0.1.3) readiness, reported only
  health: { at: number; ok: boolean }[];         // the last three liveness polls while started
  verdict?: { result: "PASS" | "FAIL"; reason: string; at: number };
  trigger?: { kind: TriggerKind; words: string; at: number };
  // The restore: inflight while a call is out and its answer not yet kept; job the job id from the
  // Supervisor's answer (the only job whose result ever counts); pending once an answer left the outcome
  // to reconcile (0.1.5: a refusal too; nothing is ever sent twice); down once the App was seen not
  // started after the call; called once the job finished without errors.
  restore?: { tries: number; nextTry: number; limit: number; inflight: boolean; called: boolean; doneAt?: number; confirmUntil?: number; result?: string;
    job?: string | null; sentAt?: number; pending?: boolean; said?: string; lastState?: string; restarts?: number; down?: boolean };
  endedAt?: number; lineDelivered?: boolean; drillRecorded?: boolean;
  dropBackup?: boolean; backupDropped?: boolean; dropTries?: number;   // (0.1.6) an orphan backup to delete, deleted, tries
  dropCheck?: boolean;                           // (0.1.7) a claim expired unused: the jobs list is read before the delete
  dropKept?: string;                             // (0.1.7) kept, not deleted, and why
  claimEndSaid?: boolean;                        // (0.1.8) the claim's end logged (one line)
  quietAt?: number;                              // (0.1.8) a poll after an unused claim's deadline saw no version change
  gen?: number;                                  // (0.1.9) the generation its backup is bound to (State.gen, never reused)
  code?: "no_space";                             // (0.1.10) why it was refused, as a code the link reads (no room for its backup)
  lateBackup?: number;                           // (0.1.10) its backup's create outran its bound: looked up by its name under the lock
  // (0.1.11) its backup was adopted late (lateBackup): retention-only. A consume never uses it and a restore never runs from it,
  // unless lateProof holds the Supervisor's recorded completion of that backup before the install job's start.
  retentionOnly?: boolean;
  lateProof?: { backupDoneAt: number; installStartedAt: number };
  // (0.1.14) a drill's mode as the link registered it (the owner's flag), the flag's nonce, and the link's confirmation that it
  // wrote the signed drill mark for this attempt (its hash): the drill record needs both the mark and the failure its mode names
  drillMode?: DrillMode; drillNonce?: string; markAt?: number; markHash?: string;
}
// (0.1.11) An operation whose external write outlived its step under the lock: its stable id (the 202 pending answer carries it),
// and its recorded outcome: pending (the write is out, the lock held), done (it ended within the ceiling), late (it passed the
// ceiling: the lock was released and the write is reconciled later by its pre-chosen name or id).
export interface OpRec { id: string; op: string; at: number; state: "pending" | "done" | "late"; writes: string[]; settledAt?: number }
// (0.1.9) A backup kept after its attempt ended unused (a cancel, an expiry): bound to the attempt and its generation,
// left for the bounded cleanup only.
export interface KeptRec { slug: string; name: string; attempt: string; gen: number; endedAt: number; reason: string }
export interface Binding { protocol: number; probe_hash: string; keeper_version: string; options_hash: string; backup_scope: string }
export interface DrillRec { attempt: string; kind: "fail-verdict" | "exits-on-start"; trigger: string; restoredAt: number; lineDeliveredAt: number; binding: Binding; at: number;
  mode?: DrillMode; markAt?: number; markHash?: string }   // (0.1.14) the evidence: the drill's mode and the mark the link confirmed
// (0.1.14) The drill modes (the owner's drill flag, cain link/drill.ts) and the failure each must show for a drill record.
export const DRILL_MODES = ["exit-on-start", "verdict-fail"] as const;
export type DrillMode = typeof DRILL_MODES[number];
export const DRILL_KIND_OF: Record<DrillMode, DrillRec["kind"]> = { "exit-on-start": "exits-on-start", "verdict-fail": "fail-verdict" };
const NONCE = /^[0-9a-f]{16}$/;
export const NONCES_MAX = 500;                   // (0.1.14) drill flag nonces kept, newest last: a nonce registers once
// (0.1.14) Why Keeper reads not armed while option drill_followups_open is set (DOCS.md, "The drill runbook").
export const FOLLOWUPS_WHY = "the drill plan's follow-up items are still open (the Ship token's causal link to the install, late jobs racing a backup delete, "
  + "the secret scanner's coverage, a bare 401 taken as a revocation, the pending claim in the hook, the pending lock's bound): the owner sets "
  + "drill_followups_open to false in Keeper's options once they have landed";
// (0.1.3) The phone test drill, per check (0.1.4: its check id; every watched App's alert check and the
// dead-man check): the page sent, delivered, and the owner's confirmation that it reached his phone.
export interface PhoneRec { sentAt: number; deliveredAt?: number; confirmedAt?: number }
export interface LastLine { id: string; kind: string; line: string; at: number }
export interface QueueItem { key: string; to: "done" | "failed" | "deadman"; fail: boolean; body: string; app: string; attempt?: string; kind?: string; tries: number; next: number; at: number }
// A spent Ship token, per App: its id (a hash), the attempt it registered.
export interface Spent { id: string; auth: string; app: string; at: number }
// (0.1.4) The pinned Ship key (0.1.5: confirmed, the owner's key-confirm, before any registration counts),
// and (0.1.5) what a device drill's own restore job showed: its name, its reference as reported, and how
// long it stayed in the jobs list after it finished. Recorded for a later version; nothing acts on it.
export interface Pinned { key: string; fp: string; at: number; confirmed?: number; enrollId?: string }   // (0.1.7) each confirm's own id
// (0.1.6) A one-time code the keeper printed in its log (kept as a hash), and the missed-heartbeat drill:
// running or ended awaiting the owner's confirm (mhb), and its confirmed record (mhbRec).
// (0.1.7) bound to its challenge (the fingerprint, the phone test's id, the drill's id, the limits' version).
export type CodeKind = "key" | "phone" | "heartbeat" | "limits" | "hckey";
export interface CodeRec { hash: string; at: number; until: number; challenge?: string }
// (0.1.7) The drill's silence lasts until Healthchecks shows the heartbeat check down (sawDown), capped at
// cap; then the ping resumes and the check must be seen up again (sawUp): one down-to-up cycle.
export interface MhbRun { id: string; startedAt: number; cap: number; api: string; sawDown?: number; resumedAt?: number; sawUp?: number }
export interface MhbRec { confirmedAt: number; hc: string; api: string }
export interface RestoreJobRec { name: string; attempt: string; at: number; job?: string; reference?: string; doneSeenAt?: number; goneAt?: number; listedMs?: number }
// (0.1.5) A check as the Healthchecks management API lists it (GET /api/v3/checks/). A read-only key gives
// unique_key in place of ping_url.
export interface HcCheck { name?: string; slug?: string; ping_url?: string; unique_key?: string; timeout?: number; grace?: number; status?: string; channels?: string; schedule?: string }
export interface State {
  format: 1;
  createdAt: number;                             // (0.1.4) when this state was created: older tokens are refused
  heartbeat: number;                             // ms, written every minute
  lastSeen: Record<string, string>;              // slug -> version
  attempts: Record<string, Attempt>;
  spent: Spent[];
  drillNonces?: { nonce: string; attempt: string; at: number }[];   // (0.1.14) every drill flag nonce registered: never twice
  probeHash: Record<string, string>;             // slug -> the probe_hash of its newest registration
  outstanding: Record<string, boolean>;          // slug -> a fail ping delivered to its alert check, its success ping owed
  last: Record<string, LastLine>;
  drills: Record<string, Partial<Record<DrillRec["kind"], DrillRec>>>;
  phone: Record<string, PhoneRec>;
  phoneHc?: string;                              // (0.1.4) the Healthchecks options' hash at the phone test
  pinnedKey?: Pinned;                            // (0.1.4) the Ship key pinned on first use
  keyChangeSaid?: string;                        // (0.1.4) the fingerprint of a changed key already paged
  restoreJob?: RestoreJobRec;                    // (0.1.4) the restore job's name, recorded by a device drill
  phoneHcApi?: string;                           // (0.1.5) the checks' settings (period, grace, channels) at the phone test
  deadmanFailSince?: number;                     // (0.1.5) the dead-man /fail ping undelivered since
  codes?: Partial<Record<CodeKind, CodeRec>>;    // (0.1.6) the one-time codes, hashed
  phoneRun?: { id: string; at: number };          // (0.1.7) the phone test that runs, awaiting its confirm
  limits?: { version: number; at: number };       // (0.1.7) the owner's acceptance of DOCS.md's "Accepted limits"
  counter: number;                                // (0.1.7) bumped on each armed read and state write, never down
  enrollRefused?: number;                         // (0.1.8) the link refused the enrollment (its cancel said so): a key code at start
  drillDue?: { phone?: number; mhb?: number };    // (0.1.8) the confirm time each drill's due reminder was logged for
  gen?: number;                                   // (0.1.9) the backups' generation counter, never down
  keptBackups?: Record<string, KeptRec>;                 // (0.1.9) kept backups by slug, for the bounded cleanup
  ops?: Record<string, OpRec>;                    // (0.1.11) operations whose write outlived their step, by operation name
  cleanupAt?: number;                             // (0.1.9) the cleanup's last run (the daily tick)
  lastBackupBytes?: number;                       // (0.1.9) the last backup's size: the projection for the next
  backupCheck?: { at: number; names: string[]; slug: string; exclude?: string };   // (0.1.9) the backup check that passed on the device (0.1.10: tied to the exclusion's hash)
  backupCheckRun?: { name: string; at: number; slug?: string };   // (0.1.10) a backup check's test backup, its name recorded before it is made
  rotationChallenge?: { value: string; at: number; until: number; enroll: string; id: string };   // (0.1.10) the single-use challenge a rotation attestation must carry
  oldKey?: { id: string; seenAt: number };        // (0.1.9) the old hc_api_key option's id (a hash), once seen
  rotation?: { id: string; attestedAt: number; tried: string; tok: string; proof?: string };   // (0.1.9) its rotation, attested by the owner's tap (0.1.10: proof)
  codeEpoch?: number;                             // (0.1.9) the build epoch the kept codes were printed under
  mhb?: MhbRun;                                  // (0.1.6) the missed-heartbeat drill, running or awaiting its confirm
  mhbRec?: MhbRec;                               // (0.1.6) the missed-heartbeat drill, confirmed
  hcRwSaid?: string;                             // (0.1.6) the read-write key already paged (its hash)
  queue: QueueItem[];
  hcPinged: number;
  hcDelivered: number;                           // the last heartbeat ping Healthchecks answered 2xx
  deadmanDelivered: number;                      // (0.1.3) the last dead-man ping Healthchecks answered 2xx
  logPinged: Record<string, number>;             // per alert check (its URL's hash): the last log ping tried
  logDelivered: Record<string, number>;          // per alert check: the last log ping Healthchecks answered 2xx
  lines: number;                                 // a counter for line ids
}
export const emptyState = (): State => ({ format: 1, createdAt: 0, heartbeat: 0, lastSeen: {}, attempts: {}, spent: [], probeHash: {}, outstanding: {}, last: {},
  drills: {}, phone: {}, queue: [], hcPinged: 0, hcDelivered: 0, deadmanDelivered: 0, logPinged: {}, logDelivered: {}, lines: 0, counter: 0 });
// Loads a saved state. Anything an earlier version kept that 0.1.3 no longer uses (the kept tokens and
// URLs, the settings hold) is dropped here, never read.
export function loadState(raw: unknown): State {
  const e = emptyState();
  if (!raw || typeof raw !== "object" || (raw as any).format !== 1) return e;
  const r = raw as any;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const pin = r.pinnedKey && typeof r.pinnedKey.key === "string" && typeof r.pinnedKey.fp === "string" ? { key: r.pinnedKey.key, fp: r.pinnedKey.fp, at: Number(r.pinnedKey.at) || 0,
    ...(Number(r.pinnedKey.confirmed) > 0 ? { confirmed: Number(r.pinnedKey.confirmed) } : {}), ...(typeof r.pinnedKey.enrollId === "string" ? { enrollId: r.pinnedKey.enrollId } : {}) } : undefined;
  const num = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
  const rj = r.restoreJob && typeof r.restoreJob.name === "string" && r.restoreJob.name ? JSON.parse(JSON.stringify({ name: r.restoreJob.name, attempt: s(r.restoreJob.attempt), at: Number(r.restoreJob.at) || 0,
    job: s(r.restoreJob.job) || undefined, reference: s(r.restoreJob.reference) || undefined, doneSeenAt: num(r.restoreJob.doneSeenAt), goneAt: num(r.restoreJob.goneAt), listedMs: num(r.restoreJob.listedMs) })) : undefined;
  return { ...e, createdAt: Number(r.createdAt) || 0, heartbeat: Number(r.heartbeat) || 0,
    ...(pin ? { pinnedKey: pin } : {}), ...(rj ? { restoreJob: rj } : {}),
    ...(typeof r.phoneHc === "string" ? { phoneHc: r.phoneHc } : {}), ...(typeof r.phoneHcApi === "string" ? { phoneHcApi: r.phoneHcApi } : {}),
    ...(Number(r.deadmanFailSince) > 0 ? { deadmanFailSince: Number(r.deadmanFailSince) } : {}),
    ...(r.codes && typeof r.codes === "object" ? { codes: obj(r.codes) as any } : {}), ...(r.mhb && Number(r.mhb.cap) > 0 && typeof r.mhb.id === "string" ? { mhb: r.mhb } : {}),
    ...(r.phoneRun && typeof r.phoneRun.id === "string" ? { phoneRun: { id: r.phoneRun.id, at: Number(r.phoneRun.at) || 0 } } : {}),
    ...(r.limits && Number(r.limits.version) > 0 ? { limits: { version: Number(r.limits.version), at: Number(r.limits.at) || 0 } } : {}), counter: Number(r.counter) > 0 ? Math.floor(Number(r.counter)) : 0,
    ...(Number(r.enrollRefused) > 0 ? { enrollRefused: Number(r.enrollRefused) } : {}), ...(r.drillDue && typeof r.drillDue === "object" ? { drillDue: obj(r.drillDue) as any } : {}),
    ...(Number(r.gen) > 0 ? { gen: Math.floor(Number(r.gen)) } : {}), ...(r.keptBackups && typeof r.keptBackups === "object" ? { keptBackups: obj(r.keptBackups) as any } : {}),
    ...(Number(r.cleanupAt) > 0 ? { cleanupAt: Number(r.cleanupAt) } : {}), ...(r.ops && typeof r.ops === "object" && !Array.isArray(r.ops) ? { ops: obj(r.ops) as any } : {}), ...(Number(r.lastBackupBytes) > 0 ? { lastBackupBytes: Number(r.lastBackupBytes) } : {}),
    ...(r.backupCheck && Number(r.backupCheck.at) > 0 ? { backupCheck: r.backupCheck } : {}),
    ...(r.backupCheckRun && typeof r.backupCheckRun.name === "string" ? { backupCheckRun: r.backupCheckRun } : {}),
    ...(r.rotationChallenge && typeof r.rotationChallenge.value === "string" ? { rotationChallenge: r.rotationChallenge } : {}), ...(r.oldKey && typeof r.oldKey.id === "string" ? { oldKey: r.oldKey } : {}),
    ...(r.rotation && typeof r.rotation.id === "string" ? { rotation: r.rotation } : {}), ...(Number(r.codeEpoch) > 0 ? { codeEpoch: Number(r.codeEpoch) } : {}),
    ...(r.mhbRec && Number(r.mhbRec.confirmedAt) > 0 ? { mhbRec: r.mhbRec } : {}), ...(typeof r.hcRwSaid === "string" ? { hcRwSaid: r.hcRwSaid } : {}), ...(typeof r.keyChangeSaid === "string" ? { keyChangeSaid: r.keyChangeSaid } : {}), lastSeen: obj(r.lastSeen) as any, attempts: obj(r.attempts) as any, probeHash: obj(r.probeHash) as any,
    outstanding: obj(r.outstanding) as any, last: obj(r.last) as any, drills: obj(r.drills) as any, phone: obj(r.phone) as any,
    queue: Array.isArray(r.queue) ? r.queue.map((q: any) => ({ ...q, at: Number(q?.at) || 0 })) : [], hcPinged: Number(r.hcPinged) || 0, lines: Number(r.lines) || 0,
    ...(Array.isArray(r.drillNonces) ? { drillNonces: r.drillNonces.filter((x: any) => x && NONCE.test(String(x.nonce))).map((x: any) => ({ nonce: String(x.nonce), attempt: s(x.attempt), at: Number(x.at) || 0 })).slice(-NONCES_MAX) } : {}),
    spent: Array.isArray(r.spent) ? r.spent.filter((x: any) => x && typeof x.id === "string").map((x: any) => ({ id: x.id, auth: s(x.auth), app: s(x.app), at: Number(x.at) || 0 })).slice(-500) : [],
    hcDelivered: Number(r.hcDelivered) || 0, deadmanDelivered: Number(r.deadmanDelivered) || 0,
    logPinged: obj(r.logPinged) as any, logDelivered: obj(r.logDelivered) as any };
}

// -- the parts it is given ------------------------------------------------------------------------
export interface AppInfo { version: string; state: string }
export interface BackupInfo { homeassistant: unknown; addons: { slug: string; version: string }[]; folders: unknown[]; protected?: unknown; date?: string; size?: number;
  sizeMb?: number; sizeBytes?: number }   // (0.1.10) the size as reported (MB, two decimals), and in bytes where the Supervisor gives it
// The restore call's answer (0.1.3): started (the Supervisor took it; its job id when it gave one),
// refused (a 4xx), or unknown (a 5xx, no answer, or an answer that isn't one: it may have run). 0.1.5:
// refused and unknown are handled alike (unresolved, never sent again); retry is only reported.
export type RestoreResult =
  | { kind: "started"; job: string | null }
  | { kind: "refused"; status: number; retry: boolean; why: string }
  | { kind: "unknown"; why: string };
// A restore job, by its id, as the Supervisor's jobs list shows it.
export type JobState = { found: false } | { found: true; uuid: string; done: boolean; errors: number; name?: string; reference?: string };
// (0.1.8) The App's active jobs judged, for a cancel and an unused claim's backup: "" when none stands in the way.
// An install, update, rebuild or restore of the App, or any job on it whose name isn't a recognized one (a backup's),
// stands in the way; so does a list that can't be read (null).
export const INSTALL_JOB = /install|update|rebuild|restore/i;
export const KNOWN_JOB = /backup/i;
export function jobsWhy(app: string, jobs: string[] | null): string {
  if (jobs === null) return "the Supervisor's jobs list couldn't be read (an install may be running)";
  const install = jobs.filter((n) => INSTALL_JOB.test(n));
  if (install.length) return `an install or update of ${app} is running (${install.join(", ").slice(0, 120)})`;
  const unknown = jobs.filter((n) => !KNOWN_JOB.test(n));
  if (unknown.length) return `an active job on ${app} that Keeper doesn't recognize is running (${unknown.join(", ").slice(0, 120)})`;
  return "";
}
export interface Deps {
  now: () => number;
  version: string;                               // the keeper's own version
  self: string;                                  // the keeper's own slug
  appInfo: (slug: string) => Promise<AppInfo | null>;
  backupInfo: (slug: string) => Promise<BackupInfo | null>;
  // (0.1.3) that App alone; 0.1.12: protected with password when one is given (every backup of a watched App; the backup
  // check's test backup has none, so its scan can read it)
  makeBackup: (app: string, name: string, password?: string) => Promise<{ slug: string } | { why: string }>;
  restore: (backup: string, app: string, password?: string) => Promise<RestoreResult>;   // 0.1.12: with the backup's own password
  // (0.1.12) the backup key store (/data/backup-keys): store writes a backup's password (0600, atomically), load reads it
  // (null: missing or unreadable), drop removes it (true when a file was removed), list names every file there
  backupKeys?: { store: (name: string, key: string) => boolean; load: (name: string) => string | null; drop: (name: string) => boolean; list: () => string[] };
  deleteBackup?: (backup: string) => Promise<boolean>;     // (0.1.6) an orphan backup's delete; false: not deleted
  backups?: () => Promise<{ slug: string; name: string }[] | null>;   // (0.1.7) the Supervisor's backups list; null: unreadable
  activeJobs?: (app: string) => Promise<string[] | null>;  // (0.1.7) active jobs on that App (0.1.8: every name, judged by jobsWhy); null: unreadable
  hcKeyStore?: { load: () => string; store: (key: string) => boolean };   // (0.1.7) the kept Healthchecks key (a 0600 file)
  job: (uuid: string) => Promise<JobState | null>;          // by its id only; null: the jobs list can't be read
  hcChecks?: (apiKey: string) => Promise<HcCheck[] | null>;   // (0.1.5) the Healthchecks checks; null: unreadable
  live: (hostPort: string) => Promise<boolean>;             // the App's liveness, the host's /health
  ready: (hostPort: string) => Promise<boolean>;            // its readiness address (Cain's /ready): reported only
  ping: (url: string, body: string) => Promise<boolean>;
  options: () => unknown | Promise<unknown>;      // the keeper's options, re-read each poll (null: unreadable)
  save: (s: State) => boolean | void;            // (0.1.5) false: not saved (a claim is then refused)
  log: (line: string) => void;
  timer?: (ms: number) => Promise<void>;          // (0.1.4) the registration's wait for its backup (tests: a fake)
  diskFree?: () => Promise<number | null>;        // (0.1.9) free bytes where backups go; null: unreadable
  // (0.1.9) the backup check: place a sentinel in every key file name (current and legacy, the real key's files left as
  // they are), clear them again, and download a backup's archive (null: unreadable)
  // 0.1.10: place never writes over a name in skip (a kept key's file); read reads a placed file back; control writes the
  // positive control in a file outside the exclusion and answers its name; clear removes it too.
  keyFiles?: { place: (sentinel: string, skip?: string[]) => string[]; read?: (name: string) => string | null; control?: (value: string) => string | null; clear: () => void; sweep: () => string[] };
  download?: (slug: string) => Promise<Uint8Array | null>;
  archives?: { sweep: () => string[] };            // (0.1.10) downloaded archives left behind by an interrupted check: removed, named
  // (0.1.9) the old key, to try it once; 0.1.10: name, its file's name in the data folder (checked inside the exclusion first)
  oldKeyStore?: { load: () => string; store: (key: string) => boolean; drop: () => void; name?: string };
  // (0.1.9) the Healthchecks API with that key, a read-only GET of the checks list; 0.1.10: its status and its error text, judged
  // by revocation() (null: no answer)
  hcTry?: (key: string) => Promise<{ status: number; error?: string } | null>;
  imageBytes?: (app: string) => Promise<number | null>;   // (0.1.10) the App's image size, when known: the first backup's reserve
  lockCallMs?: number; lockStepMs?: number;       // (0.1.8) the lock's bounds (LOCK_CALL_MS, LOCK_STEP_MS; tests: shorter)
  pendingCeilingMs?: number;                      // (0.1.11) the pending write's ceiling (PENDING_CEILING_MS; tests: shorter)
  // (0.1.11) read from the Supervisor for a retention-only backup: when that backup completed, and when the App's install job
  // started (ms); null when the Supervisor doesn't say. Either missing keeps the backup retention-only.
  backupDoneAt?: (slug: string) => Promise<number | null>;
  installStartedAt?: (app: string) => Promise<number | null>;
}
export type Answer = { status: number; body: Record<string, unknown> };
// (0.1.9) A step's generation under the claim record's lock: live() is checked right before every commit (in the same
// tick as the write); write() runs an external write (a delete) only while live, and holds the lock until it ends.
export interface Fence { gen: number; live(): boolean; write<V>(what: string, call: () => Promise<V> | V, after?: (v: V) => void): Promise<V | null> }

// -- the keeper -----------------------------------------------------------------------------------
export class Keeper {
  st: State;
  opts: Options = parseOptions({});
  private appHealth: Record<string, boolean[]> = {};   // per App, the last three liveness polls (for clearing a fail)
  private appState: Record<string, string> = {};
  private chatSaid: Record<string, boolean | null> = {};
  private armedSaid: Record<string, boolean> = {};     // per App, the armed state last logged
  private armableSaid = "";
  private backups = new Set<string>();                 // attempts whose backup call is out in this process
  private busy = false;
  private loopDone = 0;                                // (0.1.4) the last poll that completed, in this process
  private settling = new Map<string, Promise<void>>(); // (0.1.5) registrations whose backup is being made in the background
  hcSeen: ({ at: number } & HcJudged) | null = null;  // (0.1.5) the last Healthchecks settings read
  private hcSaid = "";
  hcKey = "";                                          // (0.1.7) the kept Healthchecks read-only key (never logged)
  private oldKeyOption = false;                        // (0.1.7) the old hc_api_key option seen in the options
  private lock: Promise<unknown> = Promise.resolve();  // (0.1.7) the claim record's lock
  private lockGen = 0;                                 // (0.1.9) the lock's step generation (Fence)
  private optionsUnknown = false;                      // (0.1.9) the last options read failed or timed out
  private cleanupDue = true;                           // (0.1.9) the cleanup at start (the first poll)
  private lateProofs = new Map<string, string>();     // (0.1.11) this poll's proof for a retention-only backup ("" proven, else why not)
  private checking = false;                            // (0.1.10) a backup check runs
  constructor(private d: Deps, saved: unknown) {
    this.st = loadState(saved);
    if (!this.st.createdAt) { this.st.createdAt = d.now(); d.log(`state created at ${new Date(this.st.createdAt).toISOString()}: Ship tokens issued before it are refused`); }
    try { this.hcKey = s(d.hcKeyStore?.load() ?? ""); } catch { this.hcKey = ""; }
  }

  // (0.1.7) Every state write moves the enrollment counter on.
  save(): boolean { this.st.counter++; return this.d.save(this.st) !== false; }
  // (0.1.7) The claim record's lock: claim, cancel and consume (and expiry) run one at a time, in order.
  // 0.1.8: a step that throws, or runs past LOCK_STEP_MS, is logged and the lock released for the next one (fallback
  // answers for it when given, else the error goes to the caller); each external call inside is bounded (bounded()).
  // 0.1.9: each step gets its own generation (Fence). Its commits check fence.live() first, in the same tick as the
  // write; an external write goes through fence.write(), and one in flight when the step runs out keeps the lock until
  // it ends (its own bookkeeping included); after that the step's generation is over and it changes nothing.
  // 0.1.10: a step that runs out with an external write still in flight answers at once through fallback with pending true
  // (a route says "pending"), while the lock stays held until that write's outcome is known; op names the operation, and a
  // retry of the same op meanwhile answers pending again without starting it twice; once the write ended, a retry runs the
  // step afresh, which reads the recorded outcome (reconciles the same operation).
  // 0.1.11: that hold has a hard ceiling (PENDING_CEILING_MS): a write whose outcome is still unknown then is marked late (its
  // bookkeeping skipped; it is reconciled later by the backup's pre-chosen name or slug, as late backups are), the lock is
  // released and the owner paged once, so later claim, cancel and attestation calls are never wedged behind it. The pending
  // answer carries the operation's stable id (OpRec, kept in the state), and a retry of that operation reports its recorded
  // outcome (pending or late) without starting it again; once its write ended, a retry runs the step afresh.
  record<T>(fn: (f: Fence) => T | Promise<T>, fallback?: (why: string, pending: boolean, op?: OpRec) => T, op?: string): Promise<T> {
    const stepMs = this.d.lockStepMs ?? LOCK_STEP_MS;
    const seen = op ? this.st.ops?.[op] : undefined;
    if (op && seen && fallback && (seen.state === "pending" || seen.state === "late")) {
      this.d.log(`a retry of ${op} (operation ${seen.id}): its recorded outcome is ${seen.state}; nothing started again`);
      return Promise.resolve(fallback(seen.state === "late" ? "its write passed the ceiling and is marked late" : "its write is still in flight", true, seen));
    }
    if (op && seen) { delete this.st.ops![op]; this.save(); }
    let hold: Promise<unknown> | null = null;
    const step = async (): Promise<T> => {
      const gen = ++this.lockGen;
      let expired = false, late = false;
      const inflight = new Set<Promise<unknown>>();
      const writes: string[] = [];
      const f: Fence = {
        gen,
        live: () => !expired && this.lockGen === gen,
        write: async <V>(what: string, call: () => Promise<V> | V, after?: (v: V) => void): Promise<V | null> => {
          if (!f.live()) { this.d.log(`${what} not done: its step's generation ${gen} under the claim record's lock is over`); return null; }
          writes.push(what);
          const p = (async () => {
            const v = await call();
            // (0.1.11) past the ceiling the lock is gone: its outcome is reconciled by name or id, never written here
            if (late) this.d.log(`${what} ended after its ceiling: not recorded here; it is reconciled by its name or id`);
            else after?.(v);
            return v;
          })();
          inflight.add(p);
          try { return await p; } finally { inflight.delete(p); }
        },
      };
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.resolve().then(() => fn(f)),
          new Promise<never>((_, no) => { t = setTimeout(() => { expired = true; no(new Error(`it ran past ${stepMs / 1000} seconds`)); }, stepMs); (t as any)?.unref?.(); })]);
      } catch (e) {
        expired = true;
        const why = String((e as Error)?.message ?? e).slice(0, 120);
        if (inflight.size) {
          const ceilMs = this.d.pendingCeilingMs ?? PENDING_CEILING_MS;
          const rec: OpRec = { id: `op-${randomBytes(8).toString("hex")}`, op: op ?? "a step", at: this.now(), state: "pending", writes: [...writes] };
          if (op) { const ops = (this.st.ops ??= {}); ops[op] = rec; const keys = Object.keys(ops); if (keys.length > 50) delete ops[keys[0]]; this.save(); }
          this.d.log(`a step under the claim record's lock failed (${why}) with a write in flight: the lock is held until that write ends, at most ${ceilMs / 60_000} minutes${op ? `, and ${op} answers pending meanwhile (operation ${rec.id})` : ""}`);
          let ended = false;
          const settled = Promise.allSettled([...inflight]).then(() => {
            ended = true;
            rec.settledAt = this.now();
            if (late) { this.d.log(`${rec.op} (operation ${rec.id}): its late write ended; its outcome is reconciled by its name or id`); return; }
            rec.state = "done";
            if (op) this.save();
            this.d.log(`${rec.op}: its write in flight ended; the lock is released, and a retry reconciles it`);
          });
          let c: ReturnType<typeof setTimeout> | undefined;
          const ceiling = new Promise<void>((res) => { c = setTimeout(() => {
            if (ended) return res();
            late = true; rec.state = "late";
            this.d.log(`${rec.op} (operation ${rec.id}): its write (${rec.writes.join(", ") || "an external write"}) still has no outcome after ${ceilMs / 60_000} minutes: marked late, reconciled by its name or id; the lock is released`);
            this.owner(this.d.self, "late write", `Keeper released its lock after ${ceilMs / 60_000} minutes with a write still unanswered (${(rec.writes[0] ?? "an external write").slice(0, 80)}). It is marked late and checked again by its name; nothing is sent again.`, true);
            this.save();
            res();
          }, ceilMs); (c as any)?.unref?.(); });
          hold = Promise.race([settled, ceiling]).finally(() => { if (c) clearTimeout(c); });
          if (fallback) return fallback(why, true, op ? rec : undefined);
          throw e;
        }
        this.d.log(`a step under the claim record's lock failed (${why}): the lock is released for the next one, and that step's generation ${gen} changes nothing more`);
        if (fallback) return fallback(why, false);
        throw e;
      } finally { if (t) clearTimeout(t); }
    };
    const run = this.lock.then(step, step);
    this.lock = run.catch(() => undefined).then(() => hold ?? undefined);
    return run;
  }
  // (0.1.8) An external call under the lock, bounded: null when it throws or doesn't answer within LOCK_CALL_MS.
  async bounded<T>(call: () => Promise<T> | T, what: string): Promise<T | null> {
    const ms = this.d.lockCallMs ?? LOCK_CALL_MS;
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(call),
        new Promise<null>((ok) => { t = setTimeout(() => { this.d.log(`${what} didn't answer within ${ms / 1000} seconds: taken as unreadable`); ok(null); }, ms); (t as any)?.unref?.(); })]);
    } catch (e) {
      this.d.log(`${what} failed (${String((e as Error)?.message ?? e).slice(0, 80)}): taken as unreadable`);
      return null;
    } finally { if (t) clearTimeout(t); }
  }
  private now(): number { return this.d.now(); }

  // The options in force. 0.1.3: taken as they are, never filled in from a kept copy; a poll whose
  // options can't be read keeps the last ones read in this process.
  useOptions(raw: unknown): void {
    this.opts = parseOptions(raw);
    this.optionsUnknown = false;
    // (0.1.8) as each read of the options holds it: the gate (OLD_KEY_WHY) lifts once the option is gone
    this.oldKeyOption = !!raw && typeof raw === "object" && "hc_api_key" in (raw as object);
    // (0.1.9) the old key's id (a hash, never the key) once seen; the key itself kept only to try it once at the
    // rotation's attestation (a 0600 file the backup exclusion covers). Arming waits for that attestation.
    const old = this.oldKeyOption ? s((raw as any).hc_api_key) : "";
    if (old) {
      const id = sha(`hc-old-key\n${old}`).slice(0, 12);
      if (this.st.oldKey?.id !== id) {
        this.st.oldKey = { id, seenAt: this.now() };
        let kept = false;
        // (0.1.10) written only once its file's name is checked inside the backup exclusion
        const file = this.d.oldKeyStore?.name ?? OLD_KEY_FILE;
        if (this.d.oldKeyStore && !excludedName(file)) this.d.log(`the old key isn't kept: its file ${file} isn't inside the backup exclusion (${BACKUP_EXCLUDE.join(", ")}), so its rotation is attested by your tap only`);
        else { try { kept = this.d.oldKeyStore?.store(old) ?? false; } catch { kept = false; } }
        this.d.log(`the old option hc_api_key holds a key with id ${id}: arming waits until its rotation is attested by the owner's tap on the card Cain's link posts naming that id${kept ? " (the old key is kept root-only to try it once then, and the alert service must reject it)" : ""}`);
        this.save();
      }
    }
    const why = this.armableWhy();
    if (why !== this.armableSaid) { if (why) this.d.log(`not armable: ${why}`); this.armableSaid = why; }
    if (this.st.phoneHc && this.st.phoneHc !== this.hcH()) this.phoneLapse("a Healthchecks option changed");
    this.pinKey();
  }
  // (0.1.9) An options read that failed or timed out: the old option counts as present until a read answers.
  optionsUnreadable(): void {
    if (!this.optionsUnknown) this.d.log(`not armable: ${OPTIONS_UNKNOWN_WHY}`);
    this.optionsUnknown = true;
  }
  // (0.1.7) The Healthchecks options' hash, the kept key's hash included.
  private hcH(): string { return hcHash(this.opts, this.hcKey); }
  // (0.1.4) The Ship key, pinned on first use: the first valid key seen in the options is kept in the
  // state, logged and paged with its fingerprint. A different key in the options is never used: it is
  // logged and paged once, and registrations are refused until the owner confirms it (keyConfirm).
  private pinKey(): void {
    const o = this.opts.ship_public_key;
    if (!shipKey(o)) return;
    const pin = this.st.pinnedKey;
    if (!pin) {
      const fp = keyFp(o);
      this.st.pinnedKey = { key: o, fp, at: this.now() };
      this.d.log(`pinned the Ship public key, fingerprint ${fp}, unconfirmed (0.1.5): no registration is accepted until the owner confirms it at the device: key-code for a code (0.1.9: never printed at start), then key-confirm ${fp} <code>`);
      this.notice(this.d.self, "key pinned", `Keeper pinned Cain's link's Ship key, fingerprint ${fp}. It accepts no install until you confirm that fingerprint at the device (key-confirm), checked against cain/SHIP_KEY_FINGERPRINT in the repository.`,
        "Keeper's Ship key notice done.");
      this.save();
      return;
    }
    if (pin.key === o) { if (this.st.keyChangeSaid) { delete this.st.keyChangeSaid; this.save(); } return; }
    const fp = keyFp(o);
    if (this.st.keyChangeSaid === fp) return;
    this.st.keyChangeSaid = fp;
    this.d.log(`ship_public_key changed to a key with fingerprint ${fp}; Keeper keeps the pinned key (fingerprint ${pin.fp}) and refuses every registration until the new one is confirmed: key-code, then key-confirm ${fp} <code>`);
    this.notice(this.d.self, "key changed", `Keeper's Ship key option changed (new fingerprint ${fp}, pinned ${pin.fp}). Keeper refuses every install registration until you confirm the new key at the device. If you didn't change it, put the old one back.`,
      "Keeper's Ship key notice done.");
    this.save();
  }
  // (0.1.4) The owner's confirmation of a Ship key, from inside the keeper's container only (keeper
  // key-confirm <fingerprint>): the fingerprint must be the options' key's. 0.1.5: the first pin needs it
  // too (enrollment), and so does a state rewound or created anew; a rotation is the same command.
  // 0.1.6: with the one-time code Keeper printed in its log at the pin (or at a start while the pin waits
  // for its confirm); a wrong or stale code is refused, and a code is used once.
  // 0.1.7: a key already confirmed is confirmed again with a fresh code (the re-enrollment after a restore or a
  // clock correction): each confirm gets its own enrollment id, which the link records; an earlier one it saw
  // replayed is refused there. The code is bound to the fingerprint it was printed for.
  keyConfirm(fp: string, code: string): { ok: boolean; why: string } {
    const o = this.opts.ship_public_key;
    if (!shipKey(o)) return { ok: false, why: "ship_public_key in the options isn't an Ed25519 public key" };
    const cur = keyFp(o);
    if (s(fp).toLowerCase() !== cur) return { ok: false, why: `that fingerprint isn't the options' key's (${cur})` };
    const bad = this.useCode("key", code, cur);
    if (bad) return { ok: false, why: bad };
    const p = this.st.pinnedKey;
    const was = p?.key === o ? (p.confirmed ? "its earlier confirm (a re-enrollment)" : "its unconfirmed pin") : p?.fp ?? "none";
    const now = this.now();
    this.st.pinnedKey = { key: o, fp: cur, at: p?.key === o ? p.at : now, confirmed: now, enrollId: randomBytes(8).toString("hex") };
    delete this.st.keyChangeSaid; delete this.st.enrollRefused;
    this.d.log(`the owner confirmed the Ship key with fingerprint ${cur} at the device (it replaces ${was}); enrollment ${this.st.pinnedKey.enrollId}, state created ${new Date(this.st.createdAt).toISOString()}`);
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.8) Enrolled: the options' key is the pinned one and the owner confirmed it.
  enrolled(): boolean { const p = this.st.pinnedKey; return !!p?.confirmed && p.key === this.opts.ship_public_key; }
  // (0.1.8) key-code: a fresh key-confirm code on demand (the loopback command), for a re-enrollment while enrolled.
  keyCode(): { ok: boolean; why: string } {
    const o = this.opts.ship_public_key;
    if (!shipKey(o)) return { ok: false, why: "ship_public_key in the options isn't an Ed25519 public key" };
    this.d.log(`the owner asked for a key-confirm code (key-code) for the key with fingerprint ${keyFp(o)}`);
    this.issueCode("key", KEY_CODE_MS, keyFp(o));
    return { ok: true, why: "the code is in Keeper's log" };
  }
  // (0.1.6) One-time codes: printed once in Keeper's log, kept only as a hash, good until `until`. Each new
  // code of a kind replaces the last one. useCode answers "" when the code is good.
  // 0.1.7: each code is bound to its exact challenge (hashed with it, and the challenge kept beside it), and is
  // spent by its first good use, checked and deleted with no await between (so two uses can't both pass).
  static CMD: Record<CodeKind, string> = { key: "key-confirm", phone: "phone-confirm", heartbeat: "missed-heartbeat-confirm", limits: "accept-limits", hckey: "hc-key" };
  issueCode(kind: CodeKind, ms: number, challenge: string): void {
    const code = randomBytes(5).toString("hex");
    const now = this.now();
    (this.st.codes ??= {})[kind] = { hash: sha(`keeper-code-v2\n${kind}\n${challenge}\n${code}`), at: now, until: now + ms, challenge };
    this.d.log(`one-time code for ${Keeper.CMD[kind]}: ${code} (good until ${new Date(now + ms).toISOString()}; a newer code replaces it)`);
    this.save();
  }
  private useCode(kind: CodeKind, code: string, challenge: string): string {
    const c = this.st.codes?.[kind];
    if (!c || !s(code)) return "no one-time code given, or none issued: use the code Keeper printed in its log";
    const given = sha(`keeper-code-v2\n${kind}\n${challenge}\n${s(code).toLowerCase()}`);
    if (c.challenge !== challenge) { this.d.log(`refused a ${Keeper.CMD[kind]}: its one-time code was printed for another challenge`); return "that one-time code was printed for another challenge (another key, test or drill): use the code Keeper printed for this one"; }
    if (!timingSafeEqual(Buffer.from(c.hash), Buffer.from(given))) { this.d.log(`refused a ${Keeper.CMD[kind]}: a wrong one-time code`); return "that one-time code is wrong: use the newest code Keeper printed in its log"; }
    if (this.now() > c.until) { this.d.log(`refused a ${Keeper.CMD[kind]}: a stale one-time code`); return "that one-time code is stale: get a new one (a restart prints new key, hc-key and limits codes; a new phone test or drill prints its own)"; }
    delete this.st.codes![kind];
    return "";
  }
  // (0.1.5) What the link checks in every acceptance and claim answer: the pinned fingerprint, when the
  // owner confirmed it, and when this state was created. 0.1.7: the confirm's own enrollment id and the
  // state's counter, which only goes up (the link refuses a lower one: an older state).
  enrollment(): { key_fp: string; key_confirmed_at: string | null; state_created: string; enroll_id: string; counter: number } {
    const p = this.st.pinnedKey;
    return { key_fp: p?.fp ?? "", key_confirmed_at: p?.confirmed ? new Date(p.confirmed).toISOString() : null, state_created: new Date(this.st.createdAt).toISOString(),
      enroll_id: p?.confirmed ? p.enrollId ?? "" : "", counter: this.st.counter };
  }
  // (0.1.7) The owner's acceptance of the two accepted limits (DOCS.md, "Accepted limits"), with the code
  // printed at start while it is missing or for an older text.
  limitsOk(): boolean { return this.st.limits?.version === LIMITS_VERSION; }
  acceptLimits(code: string): { ok: boolean; why: string } {
    if (this.limitsOk()) return { ok: true, why: "already accepted" };
    const bad = this.useCode("limits", code, `limits-v${LIMITS_VERSION}`);
    if (bad) return { ok: false, why: bad };
    this.st.limits = { version: LIMITS_VERSION, at: this.now() };
    this.d.log(`the owner accepted the limits in Keeper's DOCS (Accepted limits, text version ${LIMITS_VERSION})`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.7) The Healthchecks key, entered once at the device (hc-key <code>, the key on standard input): the
  // code is checked and spent first; then the key must read the checks (a key whose answer shows ping URLs
  // can write: refused), and see every check the options name; only then is it kept (a 0600 file, never the
  // options, excluded from the keeper's backups). A refused key is never kept; a new code is printed.
  async hcKeyEnter(code: string, key: string): Promise<{ ok: boolean; why: string }> {
    const k = s(key);
    // (0.1.8) refused while the old option is still held, before the code is spent
    if (this.oldKeyOption) { this.d.log(`refused the Healthchecks key entered: ${OLD_KEY_WHY}; nothing was kept`); return { ok: false, why: OLD_KEY_WHY }; }
    // (0.1.9) refused while the options can't be read, and until the backup check passed on the device
    if (this.optionsUnknown) { this.d.log(`refused the Healthchecks key entered: ${OPTIONS_UNKNOWN_WHY}; nothing was kept`); return { ok: false, why: OPTIONS_UNKNOWN_WHY }; }
    if (!this.checkPassed()) { const w = this.checkWhy(); this.d.log(`refused the Healthchecks key entered: ${w}; nothing was kept`); return { ok: false, why: `${w}: run backup-check first` }; }
    const bad = this.useCode("hckey", code, "hc-key");
    if (bad) return { ok: false, why: bad };
    const refuse = (why: string) => {
      this.d.log(`refused the Healthchecks key entered: ${why}; nothing was kept`);
      this.issueCode("hckey", HC_KEY_CODE_MS, "hc-key");
      return { ok: false, why };
    };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(k)) return refuse("that isn't a Healthchecks API key");
    if (!this.d.hcChecks || !this.d.hcKeyStore) return refuse("this Keeper can't read Healthchecks or keep a key");
    const list = await this.d.hcChecks(k).catch(() => null);
    if (!list) return refuse("the Healthchecks API couldn't be read with that key");
    if (hcCanWrite(list)) return refuse("that key can write (its answer shows ping URLs): enter the project's read-only API key (Project Settings, API Access)");
    const set = this.armableWhy(true);
    if (set) return refuse(`set the checks first: ${set}`);
    for (const [name, url, , role] of hcRoles(this.opts)) {
      const c = hcFind(this.opts, list, url, role);
      if (typeof c === "string") return refuse(`${name}: ${c}`);
      if (!c) return refuse(`that key doesn't see ${name}`);
    }
    let kept = false;
    try { kept = this.d.hcKeyStore.store(k); } catch { kept = false; }
    if (!kept) return refuse("Keeper couldn't write the key to its data folder");
    this.hcKey = k; this.hcSeen = null; this.hcSaid = ""; delete this.st.hcRwSaid;
    this.d.log(`kept the Healthchecks read-only key (its hash ${sha(`hc-key\n${k}`).slice(0, 8)}), root-only in Keeper's data folder, never in its options or its backups`);
    this.save();
    return { ok: true, why: "" };
  }

  // (0.1.9) The backup check, on the device (the loopback command backup-check): a sentinel placed in every key file name,
  // current and legacy (the real key's own files left as they are), a test backup of Keeper itself made, downloaded and
  // scanned: it must leave out every key file name and hold no key value, no key's fingerprint and no sentinel. The
  // sentinels and the test backup are removed whatever happens. hc-key is refused, and arming too, until it passes.
  // 0.1.10: it fails closed. Before the test backup every sentinel is read back where it was meant to go (the current key
  // name, the temporary prefix, the legacy temporary name, the old key's file), each inside the exclusion, a kept key's file
  // never written over (its value and fingerprint are searched for instead), and a positive control is placed in a file
  // the exclusion doesn't cover. The test backup's name is recorded before it is made. After the download the archive's
  // size must match the Supervisor's, every entry and nested archive is read (scan.ts fails on anything it can't read),
  // and the control must be found exactly once. Any error fails it; an interrupted check counts as failed, and its test
  // backup is deleted at the next start. A pass is tied to the exclusion's hash (EXCLUDE_HASH).
  async backupCheck(): Promise<{ ok: boolean; why: string }> {
    const kf = this.d.keyFiles, dl = this.d.download;
    if (!kf || !dl || !this.d.deleteBackup || !kf.read || !kf.control || !this.d.backups) return { ok: false, why: "this Keeper can't place key files, download, list or delete a backup" };
    if (this.checking) return { ok: false, why: "a backup check is already running" };
    const open = this.open();
    if (open.length) return { ok: false, why: `${open[0].id} is ${open[0].status}: run the backup check once no install is open` };
    this.checking = true;
    const sentinel = `keeper-sentinel-${randomBytes(12).toString("hex")}`;
    const control = `keeper-control-${randomBytes(12).toString("hex")}`;
    const needles = [sentinel, sha(sentinel).slice(0, 16)];
    let oldKept = "";
    try { oldKept = s(this.d.oldKeyStore?.load() ?? ""); } catch { oldKept = ""; }
    for (const k of [this.hcKey, oldKept].filter(Boolean)) needles.push(k, sha(`hc-key\n${k}`).slice(0, 8), sha(`hc-key\n${k}`).slice(0, 16), sha(`hc-old-key\n${k}`).slice(0, 12));
    let placed: string[] = [];
    let slug = "";
    const name = `Keeper backup check ${randomBytes(4).toString("hex")}`;
    try {
      const left = await this.leftoverCheck("before a new backup check");
      if (left) return this.backupCheckFailed(left);
      // never over a kept key: its file is skipped, and its value searched for
      const skip = [...(this.hcKey ? [KEY_FILE] : []), ...(oldKept ? [this.d.oldKeyStore?.name ?? OLD_KEY_FILE] : [])];
      placed = kf.place(sentinel, skip);
      const roles: [string, (n: string) => boolean, boolean][] = [
        ["the key file", (n) => n === KEY_FILE, !!this.hcKey], ["the old key's file", (n) => n === OLD_KEY_FILE, !!oldKept],
        ["a temporary file with the current prefix", (n) => n.startsWith(KEY_TMP_PREFIX), false], ["a temporary file with the legacy name", (n) => LEGACY_KEY_TMP.test(n), false],
        // (0.1.12) the backup key store, and a temporary file there
        ["the backup key store", (n) => n === `${BACKUP_KEYS_DIR}/${BACKUP_KEY_SENTINEL}`, false], ["a temporary file in the backup key store", (n) => n.startsWith(`${BACKUP_KEYS_DIR}/${BACKUP_KEY_TMP_PREFIX}`), false]];
      for (const [what, is, keptKey] of roles) {
        const n = placed.find(is);
        if (!n) { if (keptKey) continue; return this.backupCheckFailed(`the sentinel for ${what} wasn't written (nothing was placed under that name)`); }
        if (keptKey && n) return this.backupCheckFailed(`a sentinel was written over ${what}, which holds a kept key`);
        if (!excludedName(n)) return this.backupCheckFailed(`${what} (${n}) isn't inside the backup exclusion (${BACKUP_EXCLUDE.join(", ")})`);
        let back: string | null = null; try { back = kf.read(n); } catch { back = null; }
        if (s(back ?? "") !== sentinel) return this.backupCheckFailed(`the sentinel for ${what} (${n}) didn't read back where it was written`);
      }
      const ctl = kf.control(control);
      if (!ctl) return this.backupCheckFailed("the positive control couldn't be placed");
      if (excludedName(ctl)) return this.backupCheckFailed(`the positive control's file (${ctl}) is inside the backup exclusion, so it proves nothing`);
      let ctlBack: string | null = null; try { ctlBack = kf.read(ctl); } catch { ctlBack = null; }
      if (s(ctlBack ?? "") !== control) return this.backupCheckFailed(`the positive control (${ctl}) didn't read back where it was written`);
      // the test backup's name, recorded before it is made: an interrupted check's backup is found and deleted at the next start
      this.st.backupCheckRun = { name, at: this.now() };
      if (!this.save()) return this.backupCheckFailed("Keeper couldn't record the test backup's name before making it");
      this.d.log(`backup check: a sentinel placed in ${placed.join(", ")}${skip.length ? ` (not over ${skip.join(", ")}, which hold a kept key: its value is searched for)` : ""}, the positive control in ${ctl}; making a test backup of Keeper ("${name}")`);
      const made = await this.d.makeBackup(this.d.self, name).catch((e) => ({ why: String(e).slice(0, 80) }));
      if (!("slug" in made)) return this.backupCheckFailed(`the test backup couldn't be made (${made.why})`);
      slug = made.slug;
      this.st.backupCheckRun.slug = slug; this.save();
      const info = await this.d.backupInfo(slug).catch(() => null);
      const bytes = await dl(slug).catch(() => null);
      if (!bytes) return this.backupCheckFailed(`the test backup ${slug} couldn't be downloaded`);
      const size = Keeper.sizeWhy(bytes.length, info);
      if (size) return this.backupCheckFailed(`the test backup ${slug}'s download ${size}`);
      const r = scanBackup(bytes, KEY_NAME, needles, { control });
      if (!r.ok) return this.backupCheckFailed(r.why);
      this.st.backupCheck = { at: this.now(), names: placed, slug, exclude: EXCLUDE_HASH };
      this.d.log(`backup check passed: test backup ${slug} (${r.members} files read, ${bytes.length} bytes as the Supervisor reported) leaves out every key file (${placed.join(", ")}), holds no key value, fingerprint or sentinel, and holds the positive control exactly once; tied to the backup exclusion ${EXCLUDE_HASH}`);
      this.save();
      return { ok: true, why: "" };
    } finally {
      try { kf.clear(); } catch (e) { this.d.log(`backup check: couldn't remove the sentinels (${String(e).slice(0, 80)}); they are removed at the next start`); }
      if (slug) {
        const gone = await this.d.deleteBackup(slug).catch(() => false);
        this.d.log(gone ? `backup check: test backup ${slug} deleted` : `backup check: couldn't delete test backup ${slug} ("${name}"): it is deleted at the next start`);
        if (gone) { delete this.st.backupCheckRun; this.save(); }
      } else if (this.st.backupCheckRun?.name === name) {
        // never made, or its answer lost: it is looked up by its name at the next start
        this.save();
      }
      this.checking = false;
    }
  }
  // (0.1.10) The archive's size against the Supervisor's: exact in bytes where given, else within the MB figure's rounding.
  static sizeWhy(got: number, info: BackupInfo | null): string {
    if (!info) return "can't be checked: the Supervisor didn't answer for its size";
    if (Number.isSafeInteger(info.sizeBytes)) return info.sizeBytes === got ? "" : `is ${got} bytes, but the Supervisor reports ${info.sizeBytes}`;
    const mb = Number(info.sizeMb ?? info.size);
    if (!Number.isFinite(mb) || mb < 0) return "can't be checked: the Supervisor didn't report its size";
    return Math.abs(got / 1024 ** 2 - mb) <= 0.005 + 1e-9 ? "" : `is ${(got / 1024 ** 2).toFixed(3)} MB, but the Supervisor reports ${mb} MB`;
  }
  // (0.1.10) An interrupted backup check: it counts as failed, and its test backup (by its recorded name or slug) is deleted
  // and logged. "" once nothing is left, else why it couldn't be.
  async leftoverCheck(when: string): Promise<string> {
    const run = this.st.backupCheckRun;
    if (!run) return "";
    if (this.st.backupCheck) { delete this.st.backupCheck; this.d.log("the backup check's earlier pass no longer counts: a later check was interrupted"); }
    const list = this.d.backups ? await this.bounded(() => this.d.backups!(), "the Supervisor's backups list") : null;
    if (!list) { this.save(); return `the interrupted backup check's test backup "${run.name}" can't be looked up (the backups list couldn't be read)`; }
    const hits = list.filter((b) => b.name === run.name || (!!run.slug && b.slug === run.slug));
    let all = true;
    for (const b of hits) {
      const gone = this.d.deleteBackup ? await this.bounded(() => this.d.deleteBackup!(b.slug), `the delete of backup ${b.slug}`) : false;
      this.d.log(gone ? `${when}: deleted the test backup ${b.slug} ("${b.name}") an interrupted backup check left behind` : `${when}: couldn't delete the test backup ${b.slug} ("${b.name}") an interrupted backup check left behind: tried again at the next start`);
      if (!gone) all = false;
    }
    if (!hits.length) this.d.log(`${when}: the interrupted backup check's test backup "${run.name}" isn't in the backups list (never made, or deleted)`);
    if (all) delete this.st.backupCheckRun;
    this.save();
    return all ? "" : `the interrupted backup check's test backup "${run.name}" couldn't be deleted`;
  }
  // (0.1.10) The backup check's pass, as it counts now: tied to this build's exclusion.
  checkPassed(): boolean { return !!this.st.backupCheck && this.st.backupCheck.exclude === EXCLUDE_HASH && !this.st.backupCheckRun; }
  private checkWhy(): string {
    if (this.st.backupCheckRun) return `${BACKUP_CHECK_WHY}: a backup check was interrupted and counts as failed (its test backup "${this.st.backupCheckRun.name}" is deleted at the next start)`;
    if (this.st.backupCheck && this.st.backupCheck.exclude !== EXCLUDE_HASH) return `${BACKUP_CHECK_WHY}: the backup exclusion changed since it passed (now ${EXCLUDE_HASH}), so run it again`;
    return BACKUP_CHECK_WHY;
  }
  private backupCheckFailed(why: string): { ok: boolean; why: string } {
    delete this.st.backupCheck;
    this.d.log(`backup check FAILED: ${why}; hc-key and arming stay refused`);
    this.save();
    return { ok: false, why };
  }
  // (0.1.9) The old key's rotation, for Cain's link (GET /rotation): whether a tap is needed, and the old key's id.
  // 0.1.10: with what the tap proves (old_key_kept false: "attested by your tap only"), the enrollment it must be bound to,
  // and a single-use challenge Keeper issues (kept until used or 10 minutes old), which the link's signed attestation carries.
  rotationView(caller: string | null): Answer {
    if (caller !== REGISTRAR) return { status: 403, body: { status: "refused" } };
    const o = this.st.oldKey, r = this.st.rotation;
    const attested = !!o && r?.id === o.id;
    const kept = this.oldKeyKept();
    const pin = this.st.pinnedKey;
    const needed = !!o && !attested;
    let challenge: string | null = null;
    if (needed && pin?.confirmed && pin.enrollId) {
      const now = this.now(), c = this.st.rotationChallenge;
      if (!c || now > c.until || c.enroll !== pin.enrollId || c.id !== o!.id) {
        this.st.rotationChallenge = { value: randomBytes(12).toString("hex"), at: now, until: now + ROTATION_CHALLENGE_MS, enroll: pin.enrollId, id: o!.id };
        this.save();
      }
      challenge = this.st.rotationChallenge!.value;
    }
    return { status: 200, body: { needed, old_key_id: o?.id ?? null, attested_at: attested ? new Date(r!.attestedAt).toISOString() : null, old_option_present: this.oldKeyOption || this.optionsUnknown,
      old_key_kept: kept, proof: needed ? (kept ? ROTATION_PROOF_TRIED : ROTATION_PROOF_TAP) : attested ? r!.proof ?? r!.tried : null,
      enroll_id: needed ? pin?.enrollId ?? null : null, challenge } };
  }
  private oldKeyKept(): boolean { try { return !!s(this.d.oldKeyStore?.load() ?? ""); } catch { return false; } }
  // (0.1.9) POST /rotation/attest, Cain's link: the owner's tap on the card naming the old key's id, as an attestation
  // the link signs with its Ship key ("rot1.<payload>.<signature>"), verified here with the pinned, confirmed key, so
  // nothing Cain writes himself satisfies it. The old option must be gone from the options. Under the claim record's lock.
  // 0.1.10: the payload is {v: 2, kind: "hc-key-rotated", id, enroll, challenge, exp}: bound to the current enrollment, the
  // old key's id and the single-use challenge from GET /rotation (spent by this call, whatever its outcome). Where the old
  // key was kept, it is tried once at a read-only endpoint it was allowed to use (the checks list), and only a 401 or the
  // alert service's documented invalid-key answer proves it revoked (never a bare 403); the kept key is deleted as soon as
  // that passes. Where none was kept, the rotation is "attested by your tap only", and the state says so.
  attestRotation(caller: string | null, body: any): Promise<Answer> {
    return this.record(async (f) => {
      const no = (why: string, status = 409): Answer => { this.d.log(`refused a rotation attestation: ${why}`); return { status, body: { status: "refused", why } }; };
      if (caller !== REGISTRAR) return no(`only ${appName(REGISTRAR)}'s link attests a rotation`, 403);
      const o = this.st.oldKey;
      if (!o) return no("no old key was ever seen, so no rotation is needed");
      if (this.st.rotation?.id === o.id) return { status: 200, body: { status: "attested", id: o.id, recorded: true, proof: this.st.rotation.proof ?? this.st.rotation.tried } };
      if (this.oldKeyOption || this.optionsUnknown) return no(this.optionsUnknown ? OPTIONS_UNKNOWN_WHY : OLD_KEY_WHY);
      const pin = this.st.pinnedKey, key = pin?.confirmed ? shipKey(pin.key) : null;
      if (!key) return no("the pinned Ship key isn't confirmed, so the link's attestation can't be verified");
      const tok = s(body?.attestation), parts = tok.split(".");
      let ok = false;
      if (tok.length <= 1000 && parts.length === 3 && parts[0] === "rot1" && B64URL.test(parts[1]) && B64URL.test(parts[2])) {
        try { const sig = unb64url(parts[2]); ok = sig.length === 64 && edVerify(null, Buffer.from(`rot1.${parts[1]}`, "utf8"), key, sig); } catch { ok = false; }
      }
      if (!ok) return no("its attestation isn't signed by the link's Ship key (Cain's own note never counts)");
      let c: any; try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { c = null; }
      const now = this.now();
      if (!c || c.v !== 2 || c.kind !== "hc-key-rotated" || typeof c.id !== "string" || typeof c.enroll !== "string" || typeof c.challenge !== "string" || !Number.isSafeInteger(c.exp)) return no("its attestation isn't a rotation attestation bound to an enrollment and a challenge (version 2)");
      if (c.id !== o.id) return no(`its attestation names key ${c.id}, not the old key ${o.id}`);
      if (c.exp * 1000 <= now || c.exp * 1000 > now + (ROTATION_TTL_S + SHIP_SKEW_S) * 1000) return no("its attestation has expired, or lasts longer than one does");
      if (!pin!.enrollId || c.enroll !== pin!.enrollId) return no(`its attestation is bound to enrollment ${String(c.enroll).slice(0, 20)}, not the current one ${pin!.enrollId ?? "(none)"}`);
      const ch = this.st.rotationChallenge;
      if (!ch || ch.value !== c.challenge || ch.id !== o.id || ch.enroll !== pin!.enrollId) return no("its challenge isn't the one Keeper issued for this key and enrollment, or it was used already: tap again");
      // single use: spent here, before anything is awaited
      delete this.st.rotationChallenge;
      if (now > ch.until) { this.save(); return no("its challenge is over 10 minutes old: tap again"); }
      this.save();
      const tid = sha(`keeper-rotation-v1\n${tok}`).slice(0, 32);
      const old = (() => { try { return s(this.d.oldKeyStore?.load() ?? ""); } catch { return ""; } })();
      let tried = ROTATION_PROOF_TAP;
      if (old) {
        const r = this.d.hcTry ? await this.bounded(() => this.d.hcTry!(old), "the old key's try at the alert service") : null;
        if (!f.live()) return no("the attestation's step ran out of time");
        const v = revocation(r);
        if (v.state === "valid") return no(`the alert service still accepts the old key ${o.id}: revoke it there (Project Settings, API Access), then tap again`);
        if (v.state !== "revoked") return no(`the old key's try doesn't prove it revoked (${v.why}): tap again later`);
        // the kept old key is deleted as soon as its revocation check passed
        try { this.d.oldKeyStore?.drop(); this.d.log(`the kept old key ${o.id} is deleted: the alert service answered ${v.why}`); } catch { this.d.log(`couldn't delete the kept old key ${o.id}: it is removed at the next start`); }
        tried = `rejected by the alert service (${v.why})`;
      }
      if (!f.live()) return no("the attestation's step ran out of time");
      this.st.rotation = { id: o.id, attestedAt: now, tried, tok: tid, proof: old ? ROTATION_PROOF_TRIED : ROTATION_PROOF_TAP };
      this.d.log(`the old Healthchecks key ${o.id} is attested as rotated by the owner's tap (the link's signed attestation, enrollment ${pin!.enrollId}; ${old ? `the old key ${tried}` : "no old key was kept: attested by your tap only"})`);
      this.arm();
      this.save();
      return { status: 200, body: { status: "attested", id: o.id, proof: this.st.rotation.proof } };
    }, (why, pending, op) => pending ? Keeper.pendingAnswer("rotation", why, op) : ({ status: 503, body: { status: "refused", why: `Keeper's attestation step failed (${why})` } }), "rotation");
  }

  start(): void {
    const now = this.now();
    // (0.1.11) an operation left pending by a restart: its write's outcome is unknown, so it is late (reconciled by name or id)
    for (const o of Object.values(this.st.ops ?? {})) if (o.state === "pending") { o.state = "late"; this.d.log(`${o.op} (operation ${o.id}): left pending by a restart: marked late, reconciled by its name or id`); }
    if (this.st.heartbeat && now - this.st.heartbeat > REWIND_MS) {
      const mins = Math.round((now - this.st.heartbeat) / 60_000);
      if (Object.keys(this.st.drills).length || Object.keys(this.st.phone).length)
        this.d.log(`the keeper's heartbeat stopped for ${mins} minutes (a rewind, a restore or a long stop): the drill records are dropped`);
      this.st.drills = {}; this.st.phone = {}; delete this.st.phoneHc; delete this.st.phoneHcApi; delete this.st.mhb; delete this.st.mhbRec; delete this.st.phoneRun;
      // (0.1.4) a rewound state may lack recently spent tokens: tokens issued before now are refused.
      this.st.createdAt = now;
      // (0.1.5) and the Ship key must be confirmed again at the device before any registration counts.
      if (this.st.pinnedKey?.confirmed) { delete this.st.pinnedKey.confirmed; this.d.log("the pinned Ship key needs the owner's key-confirm again (a rewound state)"); }
    }
    // (0.1.7) a drill that ran when Keeper stopped is interrupted: its code no longer counts
    const running = this.drillRunning(now);
    if (running) this.interruptDrill(running, "Keeper restarted");
    // (0.1.9) codes printed by earlier builds are void at this build's first start
    if ((this.st.codeEpoch ?? 0) < CODE_EPOCH) {
      if (this.st.codes && Object.keys(this.st.codes).length) this.d.log(`the one-time codes printed by an earlier build are void (${Object.keys(this.st.codes).join(", ")}): ask for new ones`);
      delete this.st.codes; this.st.codeEpoch = CODE_EPOCH;
    }
    // (0.1.9) the key file's leftovers (a crash between write and rename), the earlier builds' temporary names included
    try { for (const n of this.d.keyFiles?.sweep() ?? []) this.d.log(`removed a leftover key file ${n} (a temporary file from an interrupted write)`); } catch (e) { this.d.log(`couldn't sweep the key file's leftovers: ${String(e).slice(0, 80)}`); }
    // (0.1.10) a backup check that was running when Keeper stopped counts as failed; its test backup is deleted at the first
    // poll (by its recorded name), and a downloaded archive left behind is removed now
    if (this.st.backupCheckRun) { if (this.st.backupCheck) delete this.st.backupCheck; this.d.log(`a backup check was interrupted (its test backup "${this.st.backupCheckRun.name}"): it counts as failed, and its test backup is deleted at the first poll`); }
    try { for (const n of this.d.archives?.sweep() ?? []) this.d.log(`removed a downloaded archive an interrupted backup check left behind: ${n}`); } catch (e) { this.d.log(`couldn't sweep downloaded archives: ${String(e).slice(0, 80)}`); }
    // (0.1.6) a pin waiting for its confirm; 0.1.9: the enrollment code is printed only on demand (key-code), never here
    if (shipKey(this.opts.ship_public_key) && (!this.enrolled() || this.st.enrollRefused)) {
      if (this.st.enrollRefused) this.d.log(`the link refused Keeper's enrollment at ${new Date(this.st.enrollRefused).toISOString()}: re-enroll with key-code, then key-confirm`);
      else this.d.log("the Ship key isn't enrolled: key-code prints a code on demand, then key-confirm <fingerprint> <code>");
    }
    // (0.1.7) the Healthchecks key is entered (or replaced) with a code printed at every start
    this.issueCode("hckey", HC_KEY_CODE_MS, "hc-key");
    if (!this.hcKey) this.d.log("no Healthchecks read-only key is kept: enter it once with hc-key <code> (the key on standard input; DOCS, What you must set)");
    // (0.1.7) the accepted limits: a code while they aren't accepted for this text
    if (!this.limitsOk()) {
      this.d.log(this.st.limits ? `the accepted limits' text changed (version ${this.st.limits.version} accepted, now ${LIMITS_VERSION}): arming needs accept-limits <code> again`
        : `the limits in Keeper's DOCS (Accepted limits, text version ${LIMITS_VERSION}) aren't accepted yet: arming needs accept-limits <code>`);
      this.issueCode("limits", HC_KEY_CODE_MS, `limits-v${LIMITS_VERSION}`);
    }
    // (0.1.7) the old option, at every start while it is there
    if (this.oldKeyOption) this.d.log("the old option hc_api_key is still in Keeper's options: remove it (Keeper ignores it; the key is entered once with hc-key and kept outside the options), then rotate that key in the alert service, since earlier backups may hold it; until then Keeper doesn't arm and refuses hc-key");
    for (const a of this.open()) this.d.log(`resuming ${a.id} ${a.app} (${a.status})`);
    for (const a of this.unresolvedOf()) this.d.log(`reconciling ${a.id} ${a.app} on every poll (unresolved: nothing is sent again)`);
    this.st.heartbeat = now;
    this.save();
  }
  open(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => OPEN.includes(a.status) && (!app || a.app === app)); }
  private unresolvedOf(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => a.status === "unresolved" && a.restore && (!app || a.app === app)); }
  binding(app: string): Binding {
    return { protocol: PROTOCOL, probe_hash: this.st.probeHash[app] ?? "", keeper_version: this.d.version, options_hash: optionsHash(this.opts, this.hcKey), backup_scope: BACKUP_SCOPE };
  }
  // (0.1.7) One drill at a time: which runs now ("" for none). The missed-heartbeat drill runs from its start
  // until its confirm or an hour after its ping resumed; the phone test from its pages until its confirm or
  // its code's end.
  drillRunning(now = this.now()): string {
    const m = this.st.mhb;
    if (m && now <= (m.resumedAt ?? m.cap) + PHONE_WINDOW_MS) return "the missed-heartbeat drill";
    const p = this.st.phoneRun, c = this.st.codes?.phone;
    if (p && c && c.challenge === p.id && now <= c.until) return "the phone test";
    return "";
  }
  // (0.1.7) A drill interrupted (a restart, or a registration meanwhile): its code no longer counts, and it needs
  // a fresh run (for the missed-heartbeat drill, a fresh down-to-up cycle).
  private interruptDrill(which: string, why: string): void {
    if (which === "the missed-heartbeat drill") { delete this.st.mhb; delete this.st.codes?.heartbeat; }
    else { delete this.st.phoneRun; delete this.st.codes?.phone; }
    this.d.log(`${which} was interrupted (${why}): its code no longer counts; run it again from the start`);
    this.save();
  }
  // The alert check of an App: its own, else the one for every App. The keeper's own lines go to the one
  // for every App, else to the first watched App's.
  alertUrl(app: string): string {
    const m = this.opts.hc_failed;
    return m[app] ?? m["*"] ?? (app === this.d.self && this.opts.watch.length ? m[this.opts.watch[0]] ?? "" : "");
  }
  private alertUrls(): string[] { return [...new Set(Object.values(this.opts.hc_failed).filter((u) => HTTPS.test(u)))]; }
  // (0.1.3) Watched Apps that share one alert check, when more than one App is watched (0.1.4: the same
  // check id in the ping URL's path, not the same text).
  sharedAlert(): string {
    if (this.opts.watch.length < 2) return "";
    const by: Record<string, string[]> = {};
    for (const a of this.opts.watch) { const id = checkId(this.alertUrl(a)); if (id) (by[id] ??= []).push(a); }
    const shared = Object.values(by).find((x) => x.length > 1);
    return shared ? `${shared.map(appName).join(" and ")} share one alert check; each watched App needs its own (hc_failed, slug=URL)` : "";
  }
  // Armable: the heartbeat check, the dead-man check and an alert check of its own for every watched App,
  // (0.1.4) each a distinct check by the id in its ping URL's path.
  // 0.1.7: checksOnly leaves out the kept key (hc-key checks the checks before any key is kept).
  armableWhy(checksOnly = false): string {
    const o = this.opts;
    if (this.optionsUnknown) return OPTIONS_UNKNOWN_WHY;   // (0.1.9)
    if (this.oldKeyOption) return OLD_KEY_WHY;          // (0.1.8)
    if (!HTTPS.test(o.hc_done)) return "hc_done (the heartbeat check) isn't set";
    if (!HTTPS.test(o.hc_deadman)) return "hc_deadman (the dead-man check) isn't set";
    if (!this.hcKey && !checksOnly) return "no Healthchecks read-only key is kept (enter it once with hc-key <code>, to read each check's period, grace and channels)";
    if (!o.watch.length) return "no App is watched";
    const missing = o.watch.find((a) => !HTTPS.test(this.alertUrl(a)));
    if (missing) return `${appName(missing)} has no alert check (hc_failed)`;
    const named: [string, string][] = [["hc_done", o.hc_done], ["hc_deadman", o.hc_deadman], ...o.watch.map((a) => [`${appName(a)}'s alert check`, this.alertUrl(a)] as [string, string])];
    const bad = named.find(([, u]) => !checkId(u));
    if (bad) return `${bad[0]} isn't a Healthchecks ping URL whose path names its check (a uuid or a slug)`;
    const shared = this.sharedAlert();
    if (shared) return shared;
    const seen: Record<string, string> = {};
    for (const [n, u] of named) {
      const id = checkId(u);
      if (seen[id]) return `${seen[id]} and ${n} are the same Healthchecks check; each needs its own`;
      seen[id] ??= n;
    }
    // (0.1.9) the device checks before arming, as refusals: each check's identity set by its unique key, the backup
    // check passed, and the old key's rotation attested by the owner's tap
    const unkeyed = hcRoles(o).filter(([, , , role]) => !o.hc_unique_keys[role]).map(([name, , , role]) => `${name} (${role})`);
    if (unkeyed.length) return `every check's identity must be set by its unique key in hc_unique_keys, verified against the live service; missing: ${unkeyed.join(", ")}`;
    if (checksOnly) return "";
    if (!this.checkPassed()) return this.checkWhy();
    const r = this.rotationWhy();
    if (r) return r;
    return "";
  }
  // (0.1.9) "" once no old key was ever seen, or its rotation was attested by the owner's tap.
  rotationWhy(): string {
    const ok = this.st.oldKey && this.st.rotation?.id === this.st.oldKey.id;
    return !this.st.oldKey || ok ? "" : `the old Healthchecks key (id ${this.st.oldKey.id}) isn't attested as rotated: tap the card Cain's link posts naming that id, once you revoked it in the alert service`;
  }
  armable(): boolean { return !this.armableWhy(); }

  // One poll: options re-read, each watched App read, every open attempt judged.
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // (0.1.9) bounded: a read that fails or doesn't answer in time counts as the old option present (not armable)
      const raw = await this.bounded(() => Promise.resolve(this.d.options()), "the keeper's options read");
      if (raw !== null && raw !== undefined) this.useOptions(raw);
      else { this.d.log("the keeper's options can't be read this poll: the last ones read stay in force, and the old option counts as present"); this.optionsUnreadable(); }
      const now = this.now();
      for (const a of this.open().filter((x) => x.status === "verifying")) this.verifyLeft(a);
      const apps = new Set([...this.opts.watch, ...this.open().map((a) => a.app), ...this.unresolvedOf().map((a) => a.app)]);
      for (const app of apps) await this.pollApp(app);
      await this.watchJobListing();
      // (0.1.10) an interrupted backup check's test backup, deleted (at start, and until it is gone)
      if (this.st.backupCheckRun && !this.checking) await this.leftoverCheck(this.cleanupDue ? "at start" : "a poll");
      // (0.1.10) a backup whose create outran its bound: looked up by its name under the next lock holder
      if (Object.values(this.st.attempts).some((x) => x.lateBackup && !x.backup && !OPEN.includes(x.status)))
        await this.record((f) => this.settleLate(f), () => undefined).catch(() => undefined);
      // (0.1.9) the bounded cleanup: at start (the first poll) and on its daily tick, under the lock
      if (this.cleanupDue || now - (this.st.cleanupAt ?? 0) >= CLEANUP_TICK_MS) {
        const when = this.cleanupDue ? "at start" : "the daily tick";
        this.cleanupDue = false;
        await this.record((f) => this.cleanup(when, f), () => undefined).catch(() => undefined);
        // (0.1.12) at start: key files whose backup is gone
        if (when === "at start") await this.record((f) => this.sweepBackupKeys(f), () => undefined).catch(() => undefined);
      }
      await this.readHc();
      await this.tickHeartbeat(now);
      this.arm();
      this.save();
      await this.flush();
      this.arm();
      this.save();
      this.loopDone = this.now();
    } finally { this.busy = false; }
  }

  // -- registration (0.1.3: POST /attempt, Cain's token; 0.1.5: answered 202 at once, then polled) ------
  // The body: {token, app, pr, head, from_version, to_version, probe_hash, kind?: "ship" | "drill"}. The
  // token is the owner's Ship token as the link signed it; it is verified here with the pinned key, which
  // the owner must have confirmed (0.1.5), and never kept (only its id, a hash). The keeper always makes
  // the App-only backup itself (a body naming one is refused). 0.1.5: a registration that passes these
  // checks is answered 202 {status: "pending", id} at once, the backup is made in the background, and the
  // link polls GET /attempt/<id> (attemptView) until it is accepted or refused; no request is held open
  // through the backup.
  async registerAttempt(caller: string | null, body: any): Promise<Answer> {
    const app = s(body?.app), token = s(body?.token), kind = s(body?.kind) || "ship";
    const pr = Number(body?.pr), head = s(body?.head).toLowerCase();
    const from = s(body?.from_version), to = s(body?.to_version), probe = s(body?.probe_hash);
    const now = this.now();
    // Every refusal is logged and paged, but one for an App the keeper doesn't watch (not its business).
    const refuse = (why: string, status = 409, page = true): Answer => {
      this.d.log(`refusing a registration${SLUG.test(app) ? ` for ${app}` : ""}: ${why}`);
      if (page) this.owner(SLUG.test(app) && app !== this.d.self ? app : this.d.self, "unprotected",
        `Keeper refused a registration${SLUG.test(app) ? ` for ${appName(app)}` : ""}: ${why}. Nothing will be rolled back for it.`, true);
      this.save();
      return { status, body: { status: "refused", why, ...this.enrollment() } };
    };
    if (caller !== REGISTRAR) return refuse(`only ${appName(REGISTRAR)}'s App registers installs`, 403);
    const pin = this.st.pinnedKey;
    if (!pin) return refuse(this.opts.ship_public_key ? "ship_public_key isn't an Ed25519 public key" : "ship_public_key isn't set, so no Ship token can be verified");
    if (this.opts.ship_public_key !== pin.key) {
      const fp = shipKey(this.opts.ship_public_key) ? keyFp(this.opts.ship_public_key) : "";
      return refuse(`ship_public_key in the options ${fp ? `(fingerprint ${fp}) ` : ""}isn't the key Keeper pinned (fingerprint ${pin.fp}); a new key counts only once confirmed at the device with key-confirm`);
    }
    if (!pin.confirmed) return refuse(`the pinned Ship key (fingerprint ${pin.fp}) isn't confirmed yet: the owner confirms it at the device with key-confirm ${pin.fp} (a first pin and a new state need it, like a rotation)`);
    const key = shipKey(pin.key);
    if (!key) return refuse("the pinned Ship key can't be read");
    if (!token) return refuse("it carries no Ship token");
    const t = readShipToken(token, key, now);
    if (!t.ok) return refuse(t.why);
    const c = t.claim;
    const issued = (c.exp - SHIP_TTL_S) * 1000;
    if (issued + 1000 <= this.st.createdAt) return refuse("its token was issued before Keeper's state was created (a fresh or restored state can't know which tokens were spent)");
    if (pr !== c.pr || head !== c.head) return refuse(`its pull request or head (${Number.isSafeInteger(pr) ? pr : "?"}, ${head.slice(0, 12) || "?"}) aren't the token's`);
    // (0.1.7) one drill at a time: no registration while a drill runs, and the drill is void after it
    const drill = this.drillRunning(now);
    if (drill) { this.interruptDrill(drill, "a registration arrived"); return refuse(`${drill} was running, and Keeper takes no registration during a drill (that drill is void now: run it again once the install is done)`); }
    if (kind !== "ship" && kind !== "drill") return refuse("its kind isn't ship or drill");
    // (0.1.14) a drill carries the owner's flag's mode and nonce; a nonce registers once, ever (kept here, outside Cain's backups,
    // so a restore of Cain that brings an old flag back can't register it again); a ship carries neither
    const mode = s(body?.drill_mode), nonce = s(body?.drill_nonce);
    if (kind === "drill" && !(DRILL_MODES as readonly string[]).includes(mode)) return refuse("a drill registration names no drill mode (exit-on-start or verdict-fail)");
    if (kind === "drill" && !NONCE.test(nonce)) return refuse("a drill registration carries no drill flag nonce");
    if (kind === "ship" && (mode || nonce)) return refuse("a ship registration carries a drill mode or nonce");
    const usedNonce = kind === "drill" ? (this.st.drillNonces ?? []).find((x) => x.nonce === nonce) : undefined;
    if (usedNonce) return refuse(`a replay: that drill flag's nonce was registered under ${usedNonce.attempt}`);
    if (!SLUG.test(app)) return refuse("its app isn't an App slug");
    if (body?.backup_slug !== undefined) return refuse("it names a backup; Keeper always makes the backup itself");
    const tid = tokenId(token);
    const prior = this.st.spent.find((x) => x.auth === tid && x.app === app);
    if (prior) return refuse(`a replay: that Ship token was spent for ${app} under ${prior.id}`);
    const id = `${kind}-${c.pr}-${app.replace(/^[0-9a-f]{8}_/, "")}-${c.head.slice(0, 8)}`;
    const why = this.st.attempts[id] ? `a replay: ${id} was registered before`
      : app === this.d.self ? "the keeper doesn't watch its own install (it refuses to update itself while it watches)"
      : !this.opts.watch.includes(app) ? `${app} isn't in the keeper's watch list`
      : !VERSION.test(from) || !VERSION.test(to) ? "its versions aren't versions"
      : from === to ? "from_version and to_version are the same"
      : !PROBE_HASH.test(probe) ? "its probe_hash isn't a hash"
      : this.open(app).length ? `another attempt for ${app} is open (${this.open(app)[0].id})`
      : null;
    if (why) return refuse(why, 409, why !== `${app} isn't in the keeper's watch list`);
    this.st.spent.push({ id, auth: tid, app, at: now }); if (this.st.spent.length > 500) this.st.spent.shift();
    if (kind === "drill") { (this.st.drillNonces ??= []).push({ nonce, attempt: id, at: now }); if (this.st.drillNonces.length > NONCES_MAX) this.st.drillNonces.shift(); }
    const a: Attempt = {
      id, app, from, to, backup: "", deadline: now + REGISTER_WAIT_MS + 60_000, issuedAt: issued,
      auth: kind as "ship" | "drill", authHash: tid, pr: c.pr, head: c.head, authExpires: c.exp * 1000,
      probeHash: probe, registeredAt: now, status: "verifying",
      notStarted: 0, healthFails: 0, startedEveryPoll: true, health: [],
      ...(kind === "drill" ? { drillMode: mode as DrillMode, drillNonce: nonce } : {}),
    };
    this.st.attempts[id] = a;
    this.st.probeHash[app] = probe;
    this.d.log(`registered ${id} ${app} ${from} to ${to} (pull request ${c.pr}, head ${c.head.slice(0, 12)}): making its backup in the background; poll GET /attempt/${id}`);
    this.save();
    this.settling.set(id, this.backupFor(a).catch((e) => this.unprotected(a, `the keeper's backup failed (${String((e as Error)?.message ?? e).slice(0, 80)})`)).finally(() => this.settling.delete(id)));
    return { status: 202, body: { status: "pending", id, app, from_version: from, to_version: to, ...this.enrollment() } };
  }
  // (0.1.5) The background backup of a registration, for tests and the server: resolves once it settled.
  async whenSettled(id: string): Promise<void> { await this.settling.get(id); }
  // (0.1.5) GET /attempt/<id>, Cain's link only: where a registration stands. "pending" while its backup
  // is made, "accepted" with its backup and until, "claimed" with its claim, else "refused" (unprotected)
  // or its status, with why. Every answer carries the enrollment (the pinned fingerprint, its
  // confirmation and the state's creation time).
  attemptView(caller: string | null, id: string): Answer {
    if (caller !== REGISTRAR) return { status: 403, body: { status: "refused", why: `only ${appName(REGISTRAR)}'s App reads registrations` } };
    const a = this.st.attempts[id];
    if (!a) return { status: 404, body: { status: "unknown", id } };
    const base = { id, app: a.app, from_version: a.from, to_version: a.to, kind: a.auth, ...(a.drillMode ? { drill_mode: a.drillMode, marked: !!a.markAt } : {}), ...this.enrollment() };
    if (a.status === "verifying") return { status: 200, body: { status: "pending", ...base } };
    if (a.status === "accepted") return { status: 200, body: { status: "accepted", ...base, backup: a.backup, until: new Date(a.acceptUntil ?? a.deadline).toISOString() } };
    if (a.status === "claimed") return { status: 200, body: { status: "claimed", ...base, backup: a.backup, claim: a.claim!.id, until: new Date(a.claim!.until).toISOString() } };
    return { status: 200, body: { status: a.status === "unprotected" ? "refused" : a.status, ...base, why: a.why ?? "", ...(a.code ? { code: a.code } : {}) } };
  }
  // (0.1.14) POST /attempt/<id>/drill-mark, Cain's link only: {mode, to_version, mark}, the link's confirmation that it wrote the
  // signed drill mark (mark: its SHA-256) for this accepted drill, before any claim. It is the evidence a drill record needs that
  // the failure came from the owner's flag. Idempotent for the same mark; refused for a ship attempt, another mode or version,
  // or once the acceptance was claimed or ended. Saved before the answer.
  markAttempt(caller: string | null, id: string, body: any): Answer {
    const no = (why: string, status = 409): Answer => { this.d.log(`refused a drill mark confirmation${/^drill-[a-z0-9-]{1,90}$/.test(id) ? ` for ${id}` : ""}: ${why}`); return { status, body: { status: "refused", id, why } }; };
    if (caller !== REGISTRAR) return no(`only ${appName(REGISTRAR)}'s App confirms a drill mark`, 403);
    const a = this.st.attempts[id];
    const mark = s(body?.mark).toLowerCase();
    if (!a) return no("no such attempt", 404);
    if (a.auth !== "drill" || !a.drillMode) return no("it isn't a drill");
    if (s(body?.mode) !== a.drillMode || s(body?.to_version) !== a.to) return no("its mode or version isn't the drill's");
    if (!/^[0-9a-f]{64}$/.test(mark)) return no("its mark isn't a hash");
    if (a.markAt) return a.markHash === mark ? { status: 200, body: { status: "marked", id } } : no("another mark was confirmed for it");
    if (a.status !== "accepted") return no(`it is ${a.status}, not accepted`);
    a.markAt = this.now(); a.markHash = mark;
    if (!this.save()) { delete a.markAt; delete a.markHash; return no("Keeper couldn't save its state", 503); }
    this.d.log(`the link confirmed the drill mark of ${id} (${a.drillMode}, ${a.to}): the drill record will need it`);
    return { status: 200, body: { status: "marked", id } };
  }
  // (0.1.5) POST /attempt/<id>/claim, Cain's link only, as the RemoteTrigger hook lets the Ship run start:
  // {app, from_version, to_version, backup}, which must be the acceptance's. Atomic: checked and set with
  // no await between, so of two claimants exactly one gets it; saved before the answer (a save that fails
  // takes the claim back and refuses). Refused when already claimed, when the acceptance expired, or when
  // the pinned key isn't confirmed. The claim is valid CLAIM_MS: to_version must show within it.
  // 0.1.7: served under the claim record's lock (claim()), and idempotent: a retry carrying the same request
  // id as the recorded claim reads the recorded outcome (the same claim, or why it ended) and changes nothing.
  claimAttempt(caller: string | null, id: string, body: any): Answer {
    const now = this.now();
    const no = (why: string, status = 409): Answer => { this.d.log(`refused a claim of ${SLUG.test(id.replace(/-/g, "_")) ? id : "an attempt"}: ${why}`); return { status, body: { status: "refused", id, why, ...this.enrollment() } }; };
    if (caller !== REGISTRAR) return no(`only ${appName(REGISTRAR)}'s App claims an acceptance`, 403);
    const a = this.st.attempts[id];
    if (!a) return no("no such attempt", 404);
    const req = s(body?.request);
    const same = s(body?.app) === a.app && s(body?.from_version) === a.from && s(body?.to_version) === a.to && s(body?.backup) === a.backup;
    if (a.claim && req && a.claim.request === req && same) {
      this.d.log(`a retry of claim ${a.claim.id} of ${a.id}: the recorded outcome (${a.status})`);
      if (["claimed", "watching", "restoring", "passed", "rolled back", "gave up", "unresolved"].includes(a.status))
        return { status: 200, body: { status: "claimed", id, app: a.app, from_version: a.from, to_version: a.to, backup: a.backup, claim: a.claim.id, until: new Date(a.claim.until).toISOString(), recorded: a.status, ...this.enrollment() } };
      return no(`its claim ${a.claim.id} was recorded, and the attempt is ${a.status} since${a.why ? ` (${a.why})` : ""}`);
    }
    if (a.status === "claimed" || a.claim) return no(`it is claimed already (claim ${a.claim?.id ?? "?"}); an acceptance has one claimant`);
    if (a.status !== "accepted") return no(`it is ${a.status}, not accepted`);
    if (now > (a.acceptUntil ?? 0)) { this.ended(a, "its acceptance expired unclaimed", true, "its acceptance expired unclaimed"); return no("its acceptance expired"); }
    if (s(body?.app) !== a.app || s(body?.from_version) !== a.from || s(body?.to_version) !== a.to || s(body?.backup) !== a.backup)
      return no("its App, versions or backup aren't the acceptance's");
    if (!this.st.pinnedKey?.confirmed) return no("the pinned Ship key isn't confirmed");
    // (0.1.8) the deadline read again right before the claim commits
    if (this.now() > (a.acceptUntil ?? 0)) { this.ended(a, "its acceptance expired unclaimed", true, "its acceptance expired unclaimed"); return no("its acceptance expired"); }
    const claim = { id: `claim-${randomBytes(8).toString("hex")}`, at: now, until: now + CLAIM_MS, ...(/^[A-Za-z0-9-]{8,64}$/.test(req) ? { request: req } : {}) };
    a.claim = claim; a.status = "claimed"; a.deadline = claim.until;
    if (!this.save()) {
      delete a.claim; a.status = "accepted"; a.deadline = a.acceptUntil ?? a.deadline;
      return no("Keeper couldn't save the claim", 503);
    }
    this.d.log(`claimed ${a.id} claim ${claim.id} ${a.app} ${a.from} to ${a.to} backup ${a.backup} until ${new Date(claim.until).toISOString()}`);   // (0.1.8) the claim's start line
    return { status: 200, body: { status: "claimed", id, app: a.app, from_version: a.from, to_version: a.to, backup: a.backup, claim: claim.id, until: new Date(claim.until).toISOString(), ...this.enrollment() } };
  }
  // (0.1.5) POST /attempt/<id>/cancel, Cain's link only, when it gives up on a pass: a registration still
  // pending, accepted or claimed (no version change seen) ends at once, so no acceptance is left to use.
  // 0.1.6: its backup (one made, or one still being made) is deleted at the next poll (dropBackups).
  // 0.1.7: under the claim record's lock (cancel()), and idempotent: a cancel already recorded answers its
  // recorded outcome again. A claim already handed to a started run (a version change seen) can't be cancelled.
  // 0.1.8: jobs is the Supervisor's jobs list for the App, read under the same lock (cancel()): an active install,
  // update, rebuild or restore of it, an active job on it whose name isn't recognized, or a list that can't be read
  // (null) refuses the cancel, logged with why; the claim and its backup are kept (it then runs out by itself).
  // A cancel whose why says the link refused the enrollment logs it and prints a key-confirm code.
  cancelAttempt(caller: string | null, id: string, body: any, jobs: string[] | null): Answer {
    if (caller !== REGISTRAR) return { status: 403, body: { status: "refused", why: `only ${appName(REGISTRAR)}'s App cancels a registration` } };
    const a = this.st.attempts[id];
    if (!a) return { status: 404, body: { status: "unknown", id } };
    const why = s(body?.why).replace(/[^\x20-\x7e]/g, " ").slice(0, 160) || "it gave up on the Ship pass";
    if (why.startsWith(ENROLL_BEHIND) || why.startsWith(ENROLL_REFUSED)) this.enrollRefusedBy(why);
    if (a.cancel) { this.d.log(`a retry of the cancel of ${a.id}: the recorded outcome (ended)`); return { status: 200, body: { status: "ended", id, recorded: true } }; }
    if (a.firstSeenTo || a.consumedAt) {
      this.d.log(`refused a cancel of ${a.id}: its claim was handed to a started run (${appName(a.app)} ${a.to} seen)`);
      return { status: 409, body: { status: "refused", id, why: `its claim was handed to a started run (${appName(a.app)} ${a.to} was seen): it is ${a.status}, and a cancel can't end it now` } };
    }
    if (!["verifying", "accepted", "claimed"].includes(a.status)) return { status: 409, body: { status: "refused", id, why: `it is ${a.status}` } };
    // (0.1.9) the claim ends; its backup is never deleted here (the Supervisor may be starting an install): kept for
    // the bounded cleanup, with what the jobs list showed as its reason
    const busy = jobsWhy(a.app, jobs);
    const req = s(body?.request);
    a.cancel = { at: this.now(), why, ...(/^[A-Za-z0-9-]{8,64}$/.test(req) ? { request: req } : {}) };
    this.ended(a, `cancelled by ${appName(REGISTRAR)}'s link (${why})`, false, busy ? `cancelled while ${busy}` : "cancelled; the Supervisor may still be starting an install, so it is never deleted with the claim");
    return { status: 200, body: { status: "ended", id, backup_kept: a.backup || null } };
  }
  // (0.1.8) The link refused the keeper's enrollment (its cancel said so): logged, remembered for the next start,
  // and a key-confirm code printed for the re-enrollment.
  private enrollRefusedBy(why: string): void {
    if (why.startsWith(ENROLL_BEHIND)) this.d.log(`${ENROLL_BEHIND}: re-enroll with key-confirm (key-code prints a code)`);
    else this.d.log("the link refused Keeper's enrollment: re-enroll with key-confirm (key-code prints a code)");
    this.st.enrollRefused = this.now();
    this.save();
  }
  // (0.1.7) The routes' entry points: claim and cancel under the claim record's lock.
  // 0.1.8: the cancel reads the App's jobs list under the lock (bounded); a step that fails answers 503.
  claim(caller: string | null, id: string, body: any): Promise<Answer> {
    return this.record(() => this.claimAttempt(caller, id, body), (why, pending, op) => pending ? Keeper.pendingAnswer(id, why, op) : ({ status: 503, body: { status: "refused", id, why: `Keeper's claim step failed (${why})` } }), `claim ${id}`);
  }
  cancel(caller: string | null, id: string, body: any): Promise<Answer> {
    return this.record(async (f) => {
      const a = caller === REGISTRAR ? this.st.attempts[id] : undefined;
      const jobs = a ? await this.appJobs(a.app) : [];
      // (0.1.9) the commit, only while this step's generation is live (checked in the same tick as the write)
      if (!f.live()) return { status: 503, body: { status: "refused", id, why: "Keeper's cancel step ran out of time; nothing was cancelled" } };
      return this.cancelAttempt(caller, id, body, jobs);
    }, (why, pending, op) => pending ? Keeper.pendingAnswer(id, why, op) : ({ status: 503, body: { status: "refused", id, why: `Keeper's cancel step failed (${why}); nothing was cancelled` } }), `cancel ${id}`);
  }
  // (0.1.10) A route whose external write is still in flight at its step's timeout: pending, the lock held until the outcome is
  // known; the same call again reconciles it.
  // 0.1.11: with the operation's stable id and its recorded state (pending, or late past the ceiling).
  static pendingAnswer(id: string, why: string, op?: OpRec): Answer {
    return { status: 202, body: { status: "pending", id, ...(op ? { operation: op.id, recorded: op.state } : {}),
      why: `Keeper's step ran out (${why}) with a write still in flight: its outcome isn't known yet; send the same request again to read its recorded outcome` } };
  }
  // (0.1.8) The App's active jobs as the Supervisor lists them (their names), bounded; null when unreadable.
  private appJobs(app: string): Promise<string[] | null> {
    const f = this.d.activeJobs;
    return f ? this.bounded(() => f(app), "the Supervisor's jobs list") : Promise.resolve(null);
  }
  // (0.1.5) An attempt that ends with nothing restored and nothing installed: its "ended" line, and (but a
  // cancellation) a notice to the owner that leaves no incident open.
  // 0.1.6: drop, its backup (made for nothing) is deleted at the next poll.
  // 0.1.9: never deleted here: keep names why it is kept, and the backup is left for the bounded cleanup (cleanup()).
  private ended(a: Attempt, why: string, tell = true, keep = ""): void {
    this.claimEnd(a, `ended: ${why}`);
    a.status = "ended"; a.why = why; a.endedAt = this.now();
    this.d.log(`${a.id}: ended (${why})`);
    if (keep) this.keepBackup(a, keep);
    if (tell) this.notice(a.app, "ended", `Keeper's acceptance of the install of ${appName(a.app)} ${a.to} ended: ${why}. Nothing was installed under it and nothing was rolled back.`,
      `Keeper's notice for ${appName(a.app)} ${a.to} done.`, a.id);
    this.save();
  }
  // (0.1.9) An ended attempt's backup, kept and bound to the attempt and its generation: "ended; backup kept: <reason>"
  // with the backup's name. A backup still being made is bound when its slug comes back (backupFor).
  private keepBackup(a: Attempt, reason: string): void {
    a.dropKept = reason;                                 // a backup made later is bound and kept with it (backupFor)
    if (!a.backup && !a.backupName) return;
    if (a.backup) (this.st.keptBackups ??= {})[a.backup] = { slug: a.backup, name: a.backupName ?? "", attempt: a.id, gen: a.gen ?? 0, endedAt: this.now(), reason };
    this.d.log(`${a.id}: ended; backup kept: ${reason} (backup ${a.backup || "(still being made)"} "${a.backupName ?? ""}", generation ${a.gen ?? 0}; only the bounded cleanup may delete it)`);
  }
  // (0.1.8) A claim's end, logged once with its deadline: consumed by the install it covers, expired, cancelled, or
  // ended by the fence.
  private claimEnd(a: Attempt, how: string): void {
    if (!a.claim || a.claimEndSaid || a.status !== "claimed") return;
    a.claimEndSaid = true;
    this.d.log(`claim ${a.claim.id} of ${a.id} ended (${how}); its deadline was ${new Date(a.claim.until).toISOString()}`);
  }
  // (0.1.4) The keeper's own backup, made once and awaited (up to REGISTER_WAIT_MS), then verified. A
  // backup that fails, doesn't complete in time, or (after a restart) has an unknown outcome leaves the
  // install unprotected: paged, and the link's poll reads a refusal (0.1.5: in the background).
  // 0.1.9: the install's own claim and backup begin under the lock (prepareBackup): the bounded cleanup first, then the
  // free-space reserve, then the attempt's generation and its own backup name; the acceptance commits under the lock
  // too, bound to the slug its own call returned, so an older kept backup is never this install's rollback.
  private async backupFor(a: Attempt): Promise<void> {
    const info = await this.d.appInfo(a.app).catch(() => null);
    if (!info) return this.unprotected(a, `the Supervisor didn't answer for ${a.app}`);
    if (info.version !== a.from) return this.unprotected(a, `${a.app} is at ${info.version}, not ${a.from}`);
    if (a.status !== "verifying") return;                  // (0.1.5) cancelled before the backup was asked
    this.backups.add(a.id);                                // (0.1.9) from here, a restart's verifyLeft waits for it
    const ready = await this.record((f) => this.prepareBackup(a, f), (why) => `Keeper's backup step failed (${why})`).catch((e) => `Keeper's backup step failed (${String(e).slice(0, 80)})`);
    if (ready) { this.backups.delete(a.id); return this.unprotected(a, ready); }
    if (a.status !== "verifying") { this.backups.delete(a.id); return; }
    // (0.1.12) the backup's own password, kept in the backup key store before the call (never in the options, the state or a log)
    const password = randomBytes(BACKUP_KEY_BYTES).toString("base64url");
    let keptKey = false;
    try { keptKey = !!this.d.backupKeys?.store(a.backupName!, password); } catch { keptKey = false; }
    if (!keptKey) { this.backups.delete(a.id); return this.unprotected(a, `Keeper couldn't keep the key for its backup of ${a.app} (${BACKUP_KEYS_DIR}), so no backup was made`); }
    const timer = this.d.timer ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as any)?.unref?.(); }));
    const made = Promise.resolve().then(() => this.d.makeBackup(a.app, a.backupName!, password)).catch((e) => ({ why: String((e as Error)?.message ?? e).slice(0, 80) }));
    const res = await Promise.race([made, timer(REGISTER_WAIT_MS).then(() => ({ late: true as const }))]);
    this.backups.delete(a.id);
    // (0.1.6) the slug it made is kept on the attempt at once, so a cancellation meanwhile keeps it bound
    if (!("late" in res) && "slug" in res && BACKUP.test(res.slug)) { a.backup = res.slug; if (a.status === "ended" && a.dropKept) this.keepBackup(a, a.dropKept); }
    if ("late" in res) {
      void made.then((r) => {
        this.d.log(`${a.id}: the keeper's backup ${"slug" in r ? `${r.slug} ` : ""}ended after its registration was refused; it is not used`);
        // (0.1.9) bound and kept, so the bounded cleanup may remove it later
        if ("slug" in r && BACKUP.test(r.slug) && !a.backup) { a.backup = r.slug; a.retentionOnly = true; delete a.lateBackup; this.keepBackup(a, "its backup completed after the registration was refused"); this.save(); }
      });
      a.lateBackup = this.now();                           // (0.1.10) until its answer comes back, looked up by its name under the lock
      this.save();
      if (a.status !== "verifying") return;
      return this.unprotected(a, `the keeper's backup of ${a.app} didn't complete within ${REGISTER_WAIT_MS / 60_000} minutes`);
    }
    if (a.status !== "verifying") { this.save(); return; } // cancelled, or seen installed, meanwhile
    if (!("slug" in res) || !BACKUP.test(res.slug)) return this.unprotected(a, `the keeper's backup of ${a.app} failed (${"why" in res ? res.why : "no backup slug in its answer"})`);
    a.backup = res.slug;
    this.d.log(`${a.id}: the keeper made backup ${res.slug} of ${a.app} alone (generation ${a.gen ?? 0})`);
    let b: BackupInfo | null = null;
    for (let i = 0; i < 3 && !b; i++) b = await this.d.backupInfo(a.backup).catch(() => null);
    if (!b) return this.unprotected(a, "the Supervisor didn't answer for its backup");
    if (Number(b.size) > 0) this.st.lastBackupBytes = Math.round(Number(b.size) * 1024 * 1024);   // (0.1.9) the Supervisor reports MB
    const addons = Array.isArray(b.addons) ? b.addons : [];
    const made_at = typeof b.date === "string" ? Date.parse(b.date) : NaN;
    const why = (b.homeassistant !== null && b.homeassistant !== false && b.homeassistant !== undefined && b.homeassistant !== "") ? "its backup holds Home Assistant"
      : addons.length !== 1 ? `its backup holds ${addons.length} Apps, not ${a.app} alone`
      : addons[0].slug !== a.app ? `its backup holds ${addons[0].slug}, not ${a.app}`
      : Array.isArray(b.folders) && b.folders.length ? "its backup holds folders"
      : addons[0].version !== a.from ? `its backup holds ${a.app} ${addons[0].version}, not ${a.from}`
      : b.protected !== true ? "its backup isn't shown as protected (protected true) with Keeper's own key, and the keeper restores only such a backup"
      : !this.backupKey(a) ? `its backup's key file is missing or unreadable`
      : !Number.isFinite(made_at) ? "its backup's date can't be read"
      : made_at < (a.issuedAt ?? 0) - BACKUP_DATE_SKEW_MS || made_at < a.registeredAt - BACKUP_DATE_SKEW_MS ? "its backup is dated before the Ship token was issued"
      : null;
    if (why) return this.unprotected(a, why);
    if (a.status !== "verifying") return;                  // the install was seen before the answer: unprotected already
    const now_ = await this.d.appInfo(a.app).catch(() => null);
    if (!now_ || now_.version !== a.from) return this.unprotected(a, now_ ? `${a.app} moved to ${now_.version} while its backup was made` : `the Supervisor didn't answer for ${a.app} after its backup`);
    if ((a.status as Status) !== "verifying") return;
    // (0.1.9) the acceptance commits under the lock, bound to this attempt's own backup and generation
    const slug = a.backup;
    await this.record((f) => {
      if (!f.live() || (a.status as Status) !== "verifying" || a.backup !== slug) return;
      const t = this.now();
      a.status = "accepted"; a.acceptedAt = t; a.acceptUntil = t + ACCEPT_MS; a.deadline = a.acceptUntil;
      this.d.log(`accepting ${a.id} ${a.app} ${a.from} to ${a.to} backup ${a.backup} until ${new Date(a.acceptUntil).toISOString()}`);
      this.save();
    }, () => undefined);
    if ((a.status as Status) === "verifying") this.unprotected(a, "Keeper couldn't commit its acceptance under the claim record's lock");
  }
  // (0.1.9) Under the lock, before a new backup: the bounded cleanup, the free-space reserve, then the attempt's own
  // generation and backup name, saved before the backup call. "" when the backup may be made, else why not.
  private async prepareBackup(a: Attempt, f: Fence): Promise<string> {
    await this.cleanup("before a new backup", f, a.id);
    // (0.1.10) with no last size (a first backup) the reserve floor is 1 GB plus the App's image size when known, else 2 GB
    const last = this.st.lastBackupBytes;
    const image = !last && this.d.imageBytes ? await this.bounded(() => this.d.imageBytes!(a.app), "the App's image size") : null;
    const projected = last ? Math.round(last * 1.5) : 0;
    const need = last ? projected + SPACE_RESERVE_BYTES : image && image > 0 ? SPACE_RESERVE_BYTES + image : FIRST_BACKUP_BYTES;
    const free = this.d.diskFree ? await this.bounded(() => this.d.diskFree!(), "the Supervisor's free space") : null;
    if (!f.live()) return "Keeper's backup step ran out of time";
    if (free === null || free < need) {
      a.code = "no_space";
      const words = free === null ? "the free space for backups couldn't be read"
        : last ? `only ${mb(free)} MB is free for backups, and its backup needs about ${mb(projected)} MB plus a reserve of ${mb(SPACE_RESERVE_BYTES)} MB`
        : `only ${mb(free)} MB is free for backups, under the first backup's reserve floor of ${mb(need)} MB (${image && image > 0 ? "1 GB plus the App's image size" : "2 GB, the App's image size not known"})`;
      const kept = Object.keys(this.st.keptBackups ?? {}).length;
      this.d.log(`refused a new backup for ${a.id}: ${words}${kept ? `; the cleanup couldn't free enough (${kept} kept backup${kept === 1 ? "" : "s"} still inside their bound)` : ""}`);
      return `no room for its backup: ${words} (delete old backups in Home Assistant, Settings, System, Backups)`;
    }
    if (a.status !== "verifying") return "";
    a.gen = this.st.gen = (this.st.gen ?? 0) + 1;
    a.backupAsked = this.now();
    a.backupName = `Keeper ${a.id} ${randomBytes(4).toString("hex")}`;   // (0.1.7) its own name, kept before the call
    this.save();                                           // asked once, before the call
    return "";
  }
  // (0.1.9) The bounded cleanup of kept backups, under the lock (f): only at start, before a new backup (except: that
  // attempt) and on the daily tick. It touches only Keeper's own backups (a name Keeper gives and a kept record with its
  // generation), never the owner's or a drill's. 0.1.10: its limits hold only while cleanup is eligible: it runs only with
  // no other attempt open and no install job on any watched App (a jobs list that can't be read stops it), and while it is
  // blocked a kept backup past a limit stays, logged. When eligible, it deletes a kept backup 48 hours after its claim's
  // recorded end (the claim's deadline alone never counts as its end), and the oldest past the grace while more than two
  // are kept; the grace (2 hours 30 minutes, longer than a Ship token's life plus the hook's bound) is a floor the cap never
  // overrides: a third backup inside it is kept and logged. Right before each delete the jobs list, the attempt and its
  // generation are read again. Every deletion is logged. A backup whose create outran its bound is looked up by its name here
  // too (settleLate).
  async cleanup(when: string, f: Fence, except?: string): Promise<void> {
    const now = this.now();
    if (when !== "before a new backup") this.st.cleanupAt = now;
    const kept = this.st.keptBackups ?? {};
    const limits = () => {
      const recs = Object.values(kept);
      const old = recs.filter((r) => now - r.endedAt >= KEPT_MAX_MS).length, over = Math.max(0, recs.length - KEPT_MAX_COUNT);
      return old || over ? [old ? `${old} past the 48-hour limit` : "", over ? `${over} over the two-backup cap` : ""].filter(Boolean).join(", ") : "";
    };
    const skip = (why: string) => {
      this.d.log(`the cleanup of kept backups (${when}) didn't run: ${why}`);
      const lim = limits();
      if (lim) this.d.log(`the cleanup is blocked past its limits (${lim}): those backups stay until cleanup is eligible again`);
      if (f.live()) this.save();
    };
    const busy = (x: Attempt) => x.id !== except && OPEN.includes(x.status);
    const late = Object.values(this.st.attempts).some((x) => x.lateBackup && !x.backup && x.backupName);
    if (!Object.keys(kept).length && !late && !Object.values(this.st.attempts).some((x) => x.status === "ended" && x.dropKept && !x.backup && x.backupName)) { if (f.live()) this.save(); return; }
    const open = Object.values(this.st.attempts).find(busy);
    if (open) return skip(`${open.id} is ${open.status} (never beside a live or expiring claim)`);
    if (!this.d.backups || !this.d.deleteBackup) return skip("this Keeper can't list or delete backups");
    const installWhy = async (): Promise<string> => {
      for (const app of this.opts.watch) {
        const jobs = await this.appJobs(app);
        const w = jobs === null ? "the Supervisor's jobs list couldn't be read" : jobs.filter((n) => INSTALL_JOB.test(n)).length ? `an install or update of ${app} is running` : "";
        if (w) return w;
      }
      return "";
    };
    const install = await installWhy();
    if (!f.live()) return;
    if (install) return skip(install);
    const list = await this.bounded(() => this.d.backups!(), "the Supervisor's backups list");
    if (!f.live()) return;
    if (!list) return skip("the Supervisor's backups list couldn't be read");
    await this.settleLate(f, list);
    if (!f.live()) return;
    // an ended attempt whose slug a restart lost: bound by its exact own name
    for (const x of Object.values(this.st.attempts)) if (x.status === "ended" && x.dropKept && !x.backup && x.backupName) {
      const hit = list.find((b) => b.name === x.backupName);
      if (hit && BACKUP.test(hit.slug)) { x.backup = hit.slug; this.keepBackup(x, x.dropKept); this.d.log(`${x.id}: found its backup ${hit.slug} by its own name "${x.backupName}"`); }
    }
    const listed = new Map(list.map((b) => [b.slug, b.name]));
    for (const r of Object.values(kept)) if (!listed.has(r.slug)) { delete kept[r.slug]; this.d.log(`kept backup ${r.slug} ("${r.name}") of ${r.attempt} is gone from the backups list: its record is dropped`); }
    // ended: a recorded end, never a deadline: the attempt ended (or was refused) with its time kept, and a claim's end logged
    const ended = (x: Attempt | undefined) => !!x && (x.status === "ended" || x.status === "unprotected") && Number(x.endedAt) > 0 && (!x.claim || !!x.claimEndSaid || x.status === "unprotected");
    const mine = (r: KeptRec) => {
      const x = this.st.attempts[r.attempt];
      const m = KEEPER_BACKUP.exec(r.name);
      return !!x && x.auth !== "drill" && !!m && m[1] === r.attempt && listed.get(r.slug) === r.name && x.backup === r.slug && (x.gen ?? 0) === r.gen && r.gen > 0 && ended(x);
    };
    const since = (r: KeptRec) => now - Math.max(r.endedAt, this.st.attempts[r.attempt]?.endedAt ?? Infinity);
    for (const r of Object.values(kept)) if (!mine(r) && this.st.attempts[r.attempt] && !ended(this.st.attempts[r.attempt]) && now - r.endedAt >= KEPT_MAX_MS)
      this.d.log(`kept backup ${r.slug} of ${r.attempt} stays past its limit: its attempt has no recorded end (a deadline alone never counts as one)`);
    const past = Object.values(kept).filter((r) => mine(r) && since(r) >= KEPT_GRACE_MS).sort((p, q) => p.endedAt - q.endedAt);
    const go = new Set(past.filter((r) => since(r) >= KEPT_MAX_MS).map((r) => r.slug));
    let left = Object.keys(kept).length - go.size;
    for (const r of past) { if (left <= KEPT_MAX_COUNT) break; if (!go.has(r.slug)) { go.add(r.slug); left--; } }
    if (left > KEPT_MAX_COUNT) {
      const inside = Object.values(kept).filter((r) => !go.has(r.slug) && since(r) < KEPT_GRACE_MS).map((r) => r.slug);
      this.d.log(`${left} kept backups are over the two-backup cap, but ${inside.join(", ") || "none"} ${inside.length === 1 ? "is" : "are"} inside the 2 hours 30 minutes grace: kept (the grace is a floor the cap never overrides)`);
    }
    for (const slug of go) {
      const r = kept[slug];
      // the jobs list, the attempt and the generation read again right before the delete
      const again = await installWhy();
      const x = this.st.attempts[r.attempt];
      if (!f.live()) return;
      if (again) { this.d.log(`the cleanup left backup ${slug}: ${again} (read again right before its delete)`); continue; }
      if (!mine(r) || Object.values(this.st.attempts).some(busy)) { this.d.log(`the cleanup left backup ${slug}: its attempt, generation or claim changed`); continue; }
      const age = Math.round(since(r) / 3_600_000);
      await f.write(`the delete of kept backup ${slug}`, () => this.bounded(() => this.d.deleteBackup!(slug), `the delete of backup ${slug}`), (ok) => {
        if (ok) { delete kept[slug]; x.backupDropped = true; this.d.log(`the cleanup deleted kept backup ${slug} ("${r.name}") of ${r.attempt}, generation ${r.gen}, ${age} hours after its claim ended (${r.reason})`); this.dropKey(r.name, "its backup was deleted"); }
        else this.d.log(`the cleanup couldn't delete kept backup ${slug} ("${r.name}"): tried again at the next cleanup`);
        this.save();
      });
    }
    // Keeper-named backups with no kept record: never deleted, named once per start
    if (when === "at start") for (const b of list) if (/^Keeper /.test(b.name) && !kept[b.slug] && !Object.values(this.st.attempts).some((x) => x.backup === b.slug || x.backupName === b.name) && b.name !== this.st.backupCheckRun?.name)
      this.d.log(`backup ${b.slug} ("${b.name}") is named like Keeper's but has no generation record here: never deleted by Keeper; delete it by hand (Settings, System, Backups) if you don't want it`);
    if (f.live()) this.save();
  }
  // (0.1.10) A backup whose create outran its bound (an answer past REGISTER_WAIT_MS, or a restart while it was made) and may
  // have completed later: under the next lock holder it is looked up by the name chosen before its call. Found with its
  // attempt's generation, it is adopted as a kept backup (bound to that attempt and generation, for the bounded cleanup);
  // found without one, it is deleted; both logged. Not found, it is looked for again until the 48-hour bound.
  async settleLate(f: Fence, given?: { slug: string; name: string }[]): Promise<void> {
    const due = Object.values(this.st.attempts).filter((x) => x.lateBackup && !x.backup && x.backupName && !OPEN.includes(x.status));
    if (!due.length) return;
    const list = given ?? (this.d.backups ? await this.bounded(() => this.d.backups!(), "the Supervisor's backups list") : null);
    if (!f.live()) return;
    if (!list) { this.d.log(`a late backup (${due.map((x) => x.id).join(", ")}) wasn't looked up: the backups list couldn't be read`); return; }
    const now = this.now();
    for (const x of due) {
      const hit = list.find((b) => b.name === x.backupName);
      if (!hit || !BACKUP.test(hit.slug)) {
        if (now - x.lateBackup! > KEPT_MAX_MS) { delete x.lateBackup; this.d.log(`${x.id}: its late backup "${x.backupName}" never showed in the backups list in 48 hours: no longer looked for`); this.save(); }
        continue;
      }
      if (!f.live()) return;
      if ((x.gen ?? 0) > 0) {
        x.backup = hit.slug; x.retentionOnly = true; delete x.lateBackup;   // (0.1.11) retention-only: never a consume's or a restore's
        if (!x.endedAt) x.endedAt = now;
        (this.st.keptBackups ??= {})[hit.slug] = { slug: hit.slug, name: x.backupName!, attempt: x.id, gen: x.gen!, endedAt: Math.max(x.endedAt, now), reason: "its create outran its bound and completed later" };
        x.dropKept = "its create outran its bound and completed later";
        this.d.log(`${x.id}: its backup's create outran its bound and completed later: found by its name "${x.backupName}" as ${hit.slug}, adopted with its generation ${x.gen} (only the bounded cleanup may delete it)`);
        this.save();
      } else {
        await f.write(`the delete of late backup ${hit.slug}`, () => this.bounded(() => this.d.deleteBackup?.(hit.slug) ?? false, `the delete of backup ${hit.slug}`), (ok) => {
          if (ok) { delete x.lateBackup; this.d.log(`${x.id}: its backup's create outran its bound and completed later as ${hit.slug} ("${x.backupName}") with no generation record: deleted`); this.dropKey(x.backupName!, "its backup was deleted"); }
          else this.d.log(`${x.id}: couldn't delete its late backup ${hit.slug} ("${x.backupName}"): tried again under the next lock holder`);
          this.save();
        });
      }
    }
  }
  // (0.1.11) Why an attempt's backup can't be used for its consume or its restore ("" when it can). A late backup is retention-only:
  // usable only with its proof (lateProof), the Supervisor's completion time for it before the install job's start.
  unusableWhy(a: Attempt): string {
    if (!a.backup) return "it has none";
    if (a.backupDropped) return `its backup ${a.backup} was deleted`;
    if (a.retentionOnly && !a.lateProof) return `its only backup ${a.backup} was adopted late and is retention-only${this.lateProofs.get(a.id) ? `: ${this.lateProofs.get(a.id)}` : ""}`;
    if (!this.backupKey(a)) return `its backup ${a.backup}'s key file is missing or unreadable`;   // (0.1.12) exactly like a missing backup
    return "";
  }
  // (0.1.11) The proof for a retention-only backup, both times read from the Supervisor (bounded): "" and lateProof set when the
  // backup's recorded completion precedes the install job's start, else why not.
  private async lateWhy(a: Attempt): Promise<string> {
    const done = this.d.backupDoneAt ? await this.bounded(() => this.d.backupDoneAt!(a.backup), "the Supervisor's completion time for a late backup") : null;
    const start = this.d.installStartedAt ? await this.bounded(() => this.d.installStartedAt!(a.app), "the Supervisor's start time for the install job") : null;
    if (!(Number(done) > 0)) return "the Supervisor gives no completion time for it";
    if (!(Number(start) > 0)) return "the Supervisor gives no start time for the install job";
    if (done! >= start!) return `it completed at ${new Date(done!).toISOString()}, not before the install job started at ${new Date(start!).toISOString()}`;
    a.lateProof = { backupDoneAt: done!, installStartedAt: start! };
    this.d.log(`${a.id}: its late backup ${a.backup} completed at ${new Date(done!).toISOString()}, before the install job started at ${new Date(start!).toISOString()}: usable`);
    return "";
  }
  // (0.1.12) An attempt's backup password from the backup key store, by the backup's name; null when missing or unreadable.
  private backupKey(a: Attempt): string | null {
    if (!a.backupName || !this.d.backupKeys) return null;
    try { const k = this.d.backupKeys.load(a.backupName); return typeof k === "string" && k.length >= 43 ? k : null; } catch { return null; }
  }
  // (0.1.12) A backup's key file removed (its backup deleted, or gone): logged by the backup's name, never the key.
  private dropKey(name: string, why: string): void {
    if (!name || !this.d.backupKeys) return;
    try { if (this.d.backupKeys.drop(name)) this.d.log(`removed the key file of backup "${name}" (${why})`); }
    catch (e) { this.d.log(`couldn't remove the key file of backup "${name}" (${String((e as Error)?.message ?? e).slice(0, 60)}): tried again at the next start`); }
  }
  // (0.1.12) At start, under the lock: a key file whose backup is gone from the backups list is removed and logged. Never one
  // whose backup is listed, nor an open attempt's, a backup being made, or a late backup still looked for.
  async sweepBackupKeys(f: Fence): Promise<void> {
    const bk = this.d.backupKeys;
    if (!bk) return;
    let names: string[] = [];
    try { names = bk.list(); } catch (e) { this.d.log(`couldn't list the backup key store: ${String((e as Error)?.message ?? e).slice(0, 60)}`); return; }
    if (!names.length) return;
    const list = this.d.backups ? await this.bounded(() => this.d.backups!(), "the Supervisor's backups list") : null;
    if (!f.live()) return;
    if (!list) { this.d.log("the backup key store wasn't swept: the backups list couldn't be read (tried again at the next start)"); return; }
    const listed = new Set(list.map((b) => b.name));
    const held = new Set(Object.values(this.st.attempts).filter((x) => x.backupName && (OPEN.includes(x.status) || this.backups.has(x.id) || (x.lateBackup && !x.backup))).map((x) => x.backupName!));
    for (const n of names) if (!listed.has(n) && !held.has(n)) this.dropKey(n, "its backup is gone from the backups list");
  }
  // A registration left verifying by a restart (its backup's outcome unknown) is unprotected.
  private verifyLeft(a: Attempt): void {
    if (this.backups.has(a.id)) return;
    if (a.backupAsked && a.backupName && !a.backup) a.lateBackup = this.now();   // (0.1.10) looked up by its name under the lock
    this.unprotected(a, "the keeper restarted while it made the backup, so that backup's outcome is unknown");
  }
  private unprotected(a: Attempt, why: string, force = false): void {
    if (a.status === "unprotected" || (a.status === "ended" && !force)) return;
    this.claimEnd(a, "the attempt is unprotected");
    a.status = "unprotected"; a.why = why; a.endedAt = this.now();
    this.d.log(`refusing ${a.id}: ${why} (UNPROTECTED: nothing will be rolled back for this install)`);
    this.owner(a.app, "unprotected", `Keeper can't protect the install of ${appName(a.app)} ${a.to || "(no version)"}: ${why}. Nothing will be rolled back for it.`, true, a.id);
    this.save();
  }

  // -- the watch (0.1.3: local evidence only) -------------------------------------------------------
  private async pollApp(app: string): Promise<void> {
    const now = this.now();
    const info = await this.d.appInfo(app).catch(() => null);
    const hp = this.opts.health[app];
    const started = info?.state === "started";
    const live = started && hp ? await this.d.live(hp).catch(() => false) : false;
    const chat = started && hasReadiness(hp) ? await this.d.ready(hp!).catch(() => false) : null;
    if (started && chat !== null && this.chatSaid[app] !== chat) { this.d.log(`${app}: ${chatWords(chat)}`); this.chatSaid[app] = chat; }
    const h = (this.appHealth[app] ??= []);
    h.push(live); if (h.length > 3) h.shift();
    if (info) this.appState[app] = info.state;
    const wasRestoring = this.open(app).filter((a) => a.status === "restoring");
    // (0.1.11) a retention-only backup's proof, read from the Supervisor before the lock (the consume decides on it)
    this.lateProofs.clear();
    for (const a of this.open(app)) if (a.status === "claimed" && a.retentionOnly && !a.lateProof && info?.version === a.to) this.lateProofs.set(a.id, await this.lateWhy(a));
    // (0.1.7) the version change, the consume and the expiries under the claim record's lock
    await this.record(() => {
      // (0.1.8) the time read under the lock: the consume and the expiries decide on it, not on the poll's start
      const t = this.now();
      if (info) this.versionChange(app, info.version);
      for (const a of this.open(app)) {
        // (0.1.4) the install seen while its registration still waits for the backup: never accepted;
        // (0.1.5) and seen while accepted but not claimed: outside a live claim
        if (a.status === "verifying" && info?.version === a.to) { this.unprotected(a, "the install began before Keeper accepted it (its backup wasn't complete)"); continue; }
        if (a.status === "accepted" && info?.version === a.to) { this.unprotected(a, OUTSIDE_CLAIM); continue; }
        if (a.status === "claimed" && info?.version === a.to && t > a.claim!.until) { this.unprotected(a, OUTSIDE_CLAIM); continue; }
        if (started) a.chat = chat;
        if (a.status === "accepted" || a.status === "claimed" || a.status === "watching") this.judge(a, info, live, t);
      }
    });
    for (const a of wasRestoring) if (a.status === "restoring") { this.observe(a, info); await this.restoring(a, info, live); }
    for (const a of this.unresolvedOf(app)) { this.observe(a, info); await this.recheck(a, info); }
    this.clearOutstanding(app);
  }
  // A version change of a watched App: an attempt's install, an attempt's recovery, or unregistered.
  private versionChange(app: string, v: string): void {
    const was = this.st.lastSeen[app];
    if (was === undefined) { this.st.lastSeen[app] = v; return; }
    if (was === v) return;
    this.st.lastSeen[app] = v;
    const recent = Object.values(this.st.attempts).filter((a) => a.app === app && this.now() - a.registeredAt < 86_400_000);
    // (0.1.4) An install seen before its acceptance (the backup not yet complete) is unprotected, and an
    // acceptance covers to_version only once. 0.1.5: only while claimed, within the claim; a version change
    // seen outside a live claim (accepted but unclaimed, the claim expired, or the attempt ended or was
    // cancelled) is uncertain: unprotected, paged, never covered.
    const early = recent.find((a) => a.status === "verifying" && a.to === v);
    if (early) { this.d.log(`${app} is at ${v} (was ${was}) before Keeper accepted ${early.id}`); return this.unprotected(early, "the install began before Keeper accepted it (its backup wasn't complete)"); }
    const now = this.now();
    const live = (a: Attempt) => a.status === "claimed" && !!a.claim && now <= a.claim.until && !a.consumedAt;
    const outside = recent.find((a) => a.to === v && !a.consumedAt && (a.status === "accepted" || (a.status === "claimed" && !live(a)) || a.status === "ended"));
    if (outside && !recent.some((a) => a.to === v && live(a))) {
      this.d.log(`${app} is at ${v} (was ${was}) outside a live claim of ${outside.id}`);
      // (0.1.8) an install happened: its backup is kept for a rollback by hand (0.1.9: under the cleanup's bound)
      const kr = outside.backup ? this.st.keptBackups?.[outside.backup] : undefined;
      if (kr) { kr.reason = `${app} moved to ${v} after it ended: a rollback by hand may need it`; this.d.log(`${outside.id}: kept its backup ${outside.backup}: ${kr.reason}`); }
      return this.unprotected(outside, OUTSIDE_CLAIM, true);
    }
    // (0.1.6) A version change during a live claim to a version other than the claimed one: uncertain.
    const wrong = recent.find((a) => live(a) && a.to !== v);
    if (wrong) { this.d.log(`${app} is at ${v} (was ${was}) during claim ${wrong.claim!.id} of ${wrong.id}, which claimed ${wrong.to}`); return this.unprotected(wrong, `${appName(app)} moved to ${v}, not the claimed ${wrong.to}, during its live claim, so the install is uncertain`); }
    const covered = recent.some((a) => (a.to === v && live(a)) || (a.from === v && ["restoring", "rolled back", "gave up", "unresolved"].includes(a.status)));
    if (covered) { this.d.log(`${app} is at ${v} (was ${was})`); return; }
    this.d.log(`unregistered change ${app} ${was} to ${v}: no attempt was registered for it, so nothing is restored`);
    this.owner(app, "unregistered change", `${appName(app)} changed from ${was} to ${v} with no install registered with Keeper. Nothing was rolled back.`, true);
  }
  // live: the App's liveness (/health) this poll. Readiness never enters it.
  judge(a: Attempt, info: AppInfo | null, live: boolean, now: number): void {
    if (info && a.status === "claimed" && info.version === a.to && now <= a.claim!.until) {
      // (0.1.10) the watch takes an install only as its own attempt's: its backup bound, and its generation the App's newest
      const newest = Math.max(0, ...Object.values(this.st.attempts).filter((x) => x.app === a.app).map((x) => x.gen ?? 0));
      if (!(a.gen && a.gen > 0) || a.gen !== newest)
        return this.unprotected(a, `the install of ${a.to} doesn't match the claimed attempt's own generation (${a.gen ?? 0}; the App's newest is ${newest}), so it isn't watched as the Ship run's`);
      // (0.1.11) its backup must be usable: there, not deleted, and not retention-only unless proven from the Supervisor's times
      const unusable = this.unusableWhy(a);
      if (unusable) return this.unprotected(a, `the install of ${a.to} has no usable backup (${unusable}), so it isn't covered`);
      this.claimEnd(a, "consumed by the install it covers");
      a.status = "watching"; a.firstSeenTo = now; a.watchEnd = now + WATCH_MS; a.consumedAt = now;
      this.d.log(`consumed ${a.id}: ${a.app} ${a.to} seen within claim ${a.claim!.id}; this acceptance is spent and covers no other install`);
      this.d.log(`watching ${a.id}: ${a.app} ${a.to} seen, 15 minutes from now`);
    }
    // (0.1.5) An acceptance unclaimed by its until, or a claim with no version change by its until, ends.
    if (a.status === "accepted" && now > (a.acceptUntil ?? a.deadline)) return this.ended(a, "its acceptance expired unclaimed", true, "its acceptance expired unclaimed");
    // 0.1.9: unused, the claim ends and its backup is kept (the Supervisor may be starting an install): the bounded cleanup only
    if (a.status === "claimed" && now > a.claim!.until) return this.ended(a, `its claim ${a.claim!.id} expired with no version change seen (unused)`, true, `its claim ${a.claim!.id} expired unused`);
    if (a.status !== "watching") return;
    if (!info) return;                                   // the Supervisor didn't answer: nothing judged this poll
    if (info.version !== a.to) return this.fail(a, "version-moved", `the App moved to ${info.version} during the watch`);
    if (info.state === "error") return this.fail(a, "state-error", "the App's state is error");
    if (info.state !== "started") {
      a.notStarted++;
      a.liveSeen = false;
      if (a.firstStartedTo) a.startedEveryPoll = false;
      if (a.notStarted >= 2) return this.fail(a, "not-started", `the App wasn't started on two polls in a row (${info.state})`);
    } else {
      a.notStarted = 0;
      a.firstStartedTo ??= now;
      const graceOver = now - a.firstStartedTo >= this.opts.health_grace_s * 1000;
      a.health.push({ at: now, ok: live }); if (a.health.length > 3) a.health.shift();
      if (typeof a.chat === "boolean") { a.chatPolls = (a.chatPolls ?? 0) + 1; if (!a.chat) a.chatDown = (a.chatDown ?? 0) + 1; }
      if (live) { a.healthFails = 0; a.liveSeen = true; }
      else if (a.liveSeen && graceOver && ++a.healthFails >= 3) return this.fail(a, "health", "its liveness address (/health) failed on three polls in a row");
    }
    if (a.verdict?.result === "FAIL") return this.fail(a, "verdict", `its probe said FAIL: ${a.verdict.reason}`);
    if (now >= (a.watchEnd ?? Infinity)) {
      const fresh = a.health.length === 3 && a.health.every((x) => x.ok && now - x.at <= 2 * POLL_MS + 15_000);
      const missing = [a.verdict?.result === "PASS" ? null : "no PASS verdict for this attempt",
        a.firstStartedTo && a.startedEveryPoll ? null : "not started on every poll since it first started",
        fresh ? null : "its liveness address (/health) wasn't 200 on the last three polls"].filter(Boolean);
      if (missing.length) return this.fail(a, "watch-end", `at the end of the watch: ${missing.join("; ")}`);
      a.status = "passed"; a.endedAt = now;
      const chat = chatWords(a.chat);
      this.d.log(`${a.id}: passed (${a.app} ${a.to}${chat ? `; ${chat}` : ""})`);
      this.lastLine(a.app, "passed", `${appName(a.app)} ${a.to} passed Keeper's check after its install${chat ? ` (${chat})` : ""}.`, a.id);
      // (0.1.4) Liveness passed but readiness was down for most of the window: paged, never restored.
      const polls = a.chatPolls ?? 0, down = a.chatDown ?? 0;
      if (polls && down * 2 > polls) {
        this.d.log(`${a.id}: passed on liveness, but chat was not connected on ${down} of ${polls} polls: the owner is paged (nothing restored)`);
        this.notice(a.app, "degraded", `${appName(a.app)} ${a.to} passed Keeper's install check on liveness, but chat wasn't connected for most of it (${down} of ${polls} polls). Nothing was rolled back. To go back, restore backup ${a.backup} by hand in Home Assistant (Settings, System, Backups).`,
          `Keeper's degraded notice for ${appName(a.app)} ${a.to} done.`, a.id);
      }
    }
  }
  private fail(a: Attempt, kind: TriggerKind, words: string): void {
    const now = this.now();
    // (0.1.11) a restore never runs from a backup that isn't usable (a retention-only one without its proof included)
    const unusable = this.unusableWhy(a);
    if (unusable) { this.d.log(`${a.id}: fail (${words}), but no restore: ${unusable}`); return this.unprotected(a, `it failed (${words}) and has no usable backup to restore (${unusable})`); }
    a.trigger = { kind, words, at: now };
    a.status = "restoring";
    a.restore = { tries: 0, nextTry: now, limit: now + RESTORE_LIMIT_MS, inflight: false, called: false, job: null };
    this.d.log(`${a.id}: fail (${words}); restoring ${a.app} from backup ${a.backup}`);
    this.owner(a.app, "rolling back", `Keeper is rolling back ${appName(a.app)} from ${a.to} to ${a.from}: ${words}.`, true, a.id);
    this.save();
  }

  // -- the restore (0.1.3; 0.1.5: one call, ever) -----------------------------------------------------
  // The in-flight fence is saved before the call, and the job id from its answer before anything else.
  // 0.1.5: there is never a second call. A refusal (4xx), a 5xx, a timeout, an unclear answer, or a
  // restart with the call out is unresolved: fenced, reconciled read only by the job id, paged.
  // A job that ended with errors is gave up (it may already have changed data): never sent again.
  // "Rolled back" needs the job by its id seen finished without errors, then from_version started and
  // live; the App seen stopping and coming back at from_version without that job result is unresolved.
  private observe(a: Attempt, info: AppInfo | null): void {
    const r = a.restore;
    if (!r || r.called || !r.sentAt || !info) return;
    if (info.state !== "started" && !r.down) { r.down = true; this.save(); }
  }
  private cameBack(a: Attempt, info: AppInfo | null): boolean {
    const newer = Object.values(this.st.attempts).some((x) => x.app === a.app && x.id !== a.id && x.registeredAt > a.registeredAt && x.status !== "unprotected");
    return !newer && !!a.restore?.down && !!info && info.state === "started" && info.version === a.from;
  }
  private async restoring(a: Attempt, info: AppInfo | null, live: boolean): Promise<void> {
    const r = a.restore!;
    const now = this.now();
    if (!r.called) {
      if (r.inflight || r.pending || r.tries > 0) return this.reconcile(a, info);   // (0.1.5) one call, ever
      if (now < r.nextTry) return;
      // (0.1.12) the backup's own password; with none, the restore is never sent (exactly like a missing backup)
      const password = this.backupKey(a);
      if (!password) return this.unprotected(a, `its backup ${a.backup}'s key file is missing or unreadable, so it can't be restored`);
      r.inflight = true; r.tries++; r.sentAt = now; r.job = null; r.down = false; delete r.said;
      this.save();                                         // the fence, before the call
      const res: RestoreResult = await this.d.restore(a.backup, a.app, password).catch((e) => ({ kind: "unknown" as const, why: String((e as Error)?.message ?? e).slice(0, 120) }));
      const t = this.now();
      r.inflight = false;
      r.pending = true;
      // (0.1.5) No refusal proves the call had no effect: fenced, reconciled read only, never sent again.
      if (res.kind === "refused") { this.save(); return this.unresolved(a, `the Supervisor refused the restore (${res.why}); Keeper sends a restore once and never again, since nothing proves a refused call had no effect`); }
      if (res.kind === "unknown") { this.save(); return this.unresolved(a, `the Supervisor's answer doesn't show whether the restore ran (${res.why})`); }
      r.job = res.job;
      this.save();                                         // the job id, before anything else
      this.d.log(res.job ? `${a.id}: the restore of backup ${a.backup} (${a.app} alone) is running as job ${res.job}`
        : `${a.id}: the Supervisor took the restore of backup ${a.backup} but gave no job id: without its job's result it can't be counted as rolled back, and it is never sent again`);
      return;
    }
    // The job finished without errors: from_version must be read started and live, and the App mustn't
    // keep restarting (started, then stopped or error, more than twice in the confirm window).
    if (info) {
      if (r.lastState === "started" && info.state !== "started") r.restarts = (r.restarts ?? 0) + 1;
      r.lastState = info.state;
      if ((r.restarts ?? 0) > RESTARTS_MAX) return this.gaveUp(a, `${a.app} keeps restarting after the restore (stopped ${r.restarts} times in its 5 minutes)`);
    }
    if (now < (r.confirmUntil ?? 0)) return;
    const back = !!info && info.version === a.from && info.state === "started";
    if (back && live) {
      a.status = "rolled back"; a.endedAt = now; r.result = "ok";
      const chat = chatWords(a.chat);
      this.d.log(`${a.id}: rolled back (${a.app} ${a.from} started and live${chat ? `, ${chat}` : ""}; trigger: ${a.trigger?.words})`);
      this.owner(a.app, "rolled back", `Keeper rolled back ${appName(a.app)} from ${a.to} to ${a.from}: ${a.trigger?.words ?? "a failed check"}.${chat ? ` It is running again, ${chat}.` : ""} What the App wrote after the backup is gone.`, false, a.id);
      return;
    }
    return this.gaveUp(a, `the restore job finished but ${a.from} wasn't started and live 5 minutes later`);
  }
  // (0.1.5) A drill's own restore job, by the id its own restore call returned (never matched on its
  // reference or name), seen finished without errors: its name and reference as reported are recorded,
  // and the job is then watched (watchJobListing) for how long it stays listed. For a later version to
  // decide on; nothing in this version acts on it.
  private noteJob(a: Attempt, j: JobState | null | undefined): void {
    if (a.auth !== "drill" || !j?.found || !j.done || j.errors !== 0 || !j.name || j.uuid !== a.restore?.job) return;
    if (this.st.restoreJob?.job === j.uuid) return;
    this.st.restoreJob = { name: j.name, attempt: a.id, at: this.now(), job: j.uuid, ...(j.reference ? { reference: j.reference } : {}), doneSeenAt: this.now() };
    this.d.log(`drill ${a.id} recorded its restore job ${j.uuid}: named "${j.name}"${j.reference ? `, reference "${j.reference}"` : ""} (recorded only; Keeper never sends a restore twice)`);
    this.save();
  }
  // (0.1.5) How long the drill's finished restore job stays in the jobs list: read by its id each poll
  // until it is gone (or for JOB_LISTING_MAX_MS), recorded as listedMs. Nothing acts on it.
  private async watchJobListing(): Promise<void> {
    const rj = this.st.restoreJob;
    if (!rj?.job || !rj.doneSeenAt || rj.goneAt) return;
    const now = this.now();
    if (now - rj.doneSeenAt > JOB_LISTING_MAX_MS) { rj.goneAt = now; rj.listedMs = now - rj.doneSeenAt; this.d.log(`the drill's restore job ${rj.job} was still listed after ${Math.round(rj.listedMs / 3_600_000)} hours: recorded as at least that`); this.save(); return; }
    const j = await this.d.job(rj.job).catch(() => null);
    if (!j || j.found) return;
    rj.goneAt = now; rj.listedMs = now - rj.doneSeenAt;
    this.d.log(`the drill's restore job ${rj.job} left the jobs list about ${Math.round(rj.listedMs / 60_000)} minutes after it was seen finished (recorded only)`);
    this.save();
  }
  private landed(a: Attempt, t: number, words: string): void {
    const r = a.restore!;
    r.called = true; r.pending = false; r.inflight = false; r.doneAt = t; r.confirmUntil = t + CONFIRM_MS; r.restarts = 0; delete r.lastState; delete r.said;
    this.d.log(`${a.id}: ${words}; confirming ${a.from} comes back started and live for 5 minutes`);
    this.save();
  }
  private say(a: Attempt, words: string): void {
    const r = a.restore!;
    if (r.said === words) return;
    r.said = words; this.d.log(`${a.id}: ${words}`); this.save();
  }
  private async evidence(a: Attempt, info: AppInfo | null): Promise<{ j: JobState | null | undefined; back: boolean; why: string }> {
    const r = a.restore!;
    const j = r.job ? await this.d.job(r.job).catch(() => null) : undefined;
    const back = this.cameBack(a, info);
    const why = j === undefined ? "the restore call left no job id"
      : j === null ? "the Supervisor's jobs can't be read"
      : !j.found ? `its restore job ${r.job} isn't listed`
      : !j.done ? `its restore job ${r.job} is still running`
      : `its restore job ${r.job} ended with ${j.errors} error${j.errors === 1 ? "" : "s"}`;
    return { j, back, why };
  }
  private static cameBackWhy(a: Attempt): string { return `the App came back at the old version (${a.from}) but the restore job's result is unknown`; }
  private async reconcile(a: Attempt, info: AppInfo | null): Promise<void> {
    const r = a.restore!;
    const now = this.now();
    const { j, back, why } = await this.evidence(a, info);
    this.noteJob(a, j);
    if (j?.found && j.done && j.errors === 0) return this.landed(a, now, `the restore job ${j.uuid} finished without errors`);
    if (j?.found && j.done) return this.gaveUp(a, `its restore job ${j.uuid} ended with ${j.errors} error${j.errors === 1 ? "" : "s"}; it is never sent again, since a failed restore may already have changed the App's data`);
    if (back && !(j?.found && !j.done)) return this.unresolved(a, Keeper.cameBackWhy(a));
    if (now >= r.limit) return this.unresolved(a, why);
    this.say(a, `the restore's outcome isn't known yet (${why}); nothing is sent again`);
  }
  private unresolved(a: Attempt, why: string): void {
    a.status = "unresolved"; a.endedAt = this.now(); a.why = why;
    if (a.restore) { a.restore.result = why; a.restore.inflight = false; a.restore.pending = true; a.restore.said = why; }
    this.d.log(`${a.id}: unresolved (${why}): nothing is restored again; every poll checks it again`);
    this.owner(a.app, "unresolved", `Keeper's rollback of ${appName(a.app)} ${a.to} to ${a.from} is unresolved: ${why}. Nothing more is restored by itself; Keeper keeps checking and tells you once it knows. Check the App and its backups in Home Assistant (Settings, System, Backups).`, true, a.id);
    this.save();
  }
  // An unresolved attempt, on every poll: its job by its id seen finished without errors goes on to the
  // confirm window; seen ended with errors is gave up; anything else stays, logged once per change.
  private async recheck(a: Attempt, info: AppInfo | null): Promise<void> {
    const now = this.now();
    const { j, why } = await this.evidence(a, info);
    this.noteJob(a, j);
    if (j?.found && j.done && j.errors === 0) {
      a.status = "restoring"; delete a.endedAt;
      this.landed(a, now, `the restore job ${j.uuid} finished without errors (found after it was unresolved)`);
      return;
    }
    if (j?.found && j.done) return this.gaveUp(a, `its restore job ${j.uuid} ended with errors (found after it was unresolved)`);
    this.say(a, `still unresolved (${a.why === Keeper.cameBackWhy(a) ? a.why : why}); nothing is sent again`);
  }
  private gaveUp(a: Attempt, why: string): void {
    a.status = "gave up"; a.endedAt = this.now(); a.why = why;
    if (a.restore) a.restore.result = why;
    this.d.log(`${a.id}: gave up (${why})`);
    this.owner(a.app, "gave up", `Keeper gave up on ${appName(a.app)} ${a.to}: ${why}. Restore its backup by hand in Home Assistant (Settings, System, Backups).`, true, a.id);
    this.save();
  }

  // -- verdicts -------------------------------------------------------------------------------------
  appOfToken(token: string | null): string | null {
    if (!token) return null;
    for (const [app, t] of Object.entries(this.opts.tokens)) {
      if (t.length >= 16 && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))) return app;
    }
    return null;
  }
  openAttempt(app: string): Attempt | null { return this.open(app).find((a) => a.status === "accepted" || a.status === "claimed" || a.status === "watching") ?? null; }
  verdict(caller: string, body: any): { ok: boolean; why: string } {
    const app = s(body?.app), id = s(body?.attempt), version = s(body?.version), result = s(body?.result), reason = s(body?.reason).slice(0, 300);
    const a = this.openAttempt(app);
    const why = app !== caller ? "its app isn't the caller's"
      : !a ? `no open attempt for ${app}`
      : a.id !== id ? "it names another attempt"
      : a.to !== version ? `it names ${version}, not ${a.to}`
      : result !== "PASS" && result !== "FAIL" ? "its result isn't PASS or FAIL"
      : a.verdict ? "this attempt has its verdict already"
      : null;
    if (why) { this.d.log(`ignored a verdict from ${caller}: ${why}`); return { ok: false, why }; }
    a!.verdict = { result: result as "PASS" | "FAIL", reason, at: this.now() };
    this.d.log(`verdict for ${a!.id}: ${result}${reason ? ` (${reason})` : ""}`);
    if (result === "FAIL" && a!.status === "watching") this.fail(a!, "verdict", `its probe said FAIL: ${reason || "no reason given"}`);
    this.save();
    return { ok: true, why: "" };
  }

  // -- the owner hears ------------------------------------------------------------------------------
  private lastLine(app: string, kind: string, line: string, _attempt?: string): LastLine {
    const l = { id: `${app}-${++this.st.lines}`, kind, line, at: this.now() };
    this.st.last[app] = l;
    return l;
  }
  owner(app: string, kind: string, line: string, fail: boolean, attempt?: string): void {
    const l = this.lastLine(app, kind, line, attempt);
    this.d.log(`owner: ${line}`);
    if (!this.armable()) this.d.log(`that line may reach no one but this log: the keeper is not armable (${this.armableWhy()})`);
    this.st.queue.push({ key: l.id, to: "failed", fail, body: line, app, attempt, kind, tries: 0, next: 0, at: this.now() });
  }
  // (0.1.4) A notice: a page (a fail ping carrying the line) followed by its own all clear, on the App's
  // alert check, that leaves no incident open (the phone test, the pinned or changed key, a degraded pass).
  notice(app: string, kind: string, line: string, clear: string, attempt?: string): void {
    const l = this.lastLine(app, kind, line, attempt);
    this.d.log(`owner: ${line}`);
    if (!this.armable()) this.d.log(`that line may reach no one but this log: the keeper is not armable (${this.armableWhy()})`);
    this.st.queue.push({ key: l.id, to: "failed", fail: true, body: line, app, attempt, kind, tries: 0, next: 0, at: this.now() });
    this.st.queue.push({ key: `${l.id}-clear`, to: "failed", fail: false, body: clear, app, attempt, kind: `${kind} clear`, tries: 0, next: 0, at: this.now() });
  }
  // (0.1.4) The phone test lapses: arming closes until a new one is confirmed.
  // 0.1.6: the missed-heartbeat drill lapses with it.
  private phoneLapse(why: string): void {
    if (!Object.keys(this.st.phone).length && !this.st.phoneHc && !this.st.phoneHcApi && !this.st.mhbRec) return;
    this.st.phone = {}; delete this.st.phoneHc; delete this.st.phoneHcApi; delete this.st.mhbRec;
    if (this.st.phoneRun) { delete this.st.phoneRun; delete this.st.codes?.phone; }   // (0.1.7) a running test is void with it
    this.d.log(`the phone test lapsed: ${why}; arming needs a new one (phone-test, then phone-confirm) and a new missed-heartbeat drill`);
    this.save();
  }
  // (0.1.3) Another App on the same alert check with an incident open: its open or unresolved attempt,
  // its owed success ping, or its fail ping still queued. The keeper's own lines don't count.
  private incidentOn(url: string, app: string, keep: QueueItem[]): string | null {
    const id = checkId(url);
    for (const b of new Set([...this.opts.watch, ...Object.keys(this.st.outstanding), ...Object.values(this.st.attempts).map((x) => x.app)])) {
      if (b === app || b === this.d.self || checkId(this.alertUrl(b)) !== id) continue;
      if (this.st.outstanding[b] || this.open(b).length || this.unresolvedOf(b).length || keep.some((k) => k.app === b && k.fail)) return b;
    }
    return null;
  }
  // Every ping is retried until delivered. A success ping waits for any earlier fail ping of its App, and
  // (0.1.3) while another App sharing its alert check has an incident open.
  async flush(): Promise<void> {
    const now = this.now();
    const keep: QueueItem[] = [];
    for (const q of this.st.queue) {
      // (0.1.5) A page still unacknowledged (no 2xx from Healthchecks) PAGE_ACK_MS after it was queued
      // closes the gate until a new phone test; before that it is retried (and disarms after 2 minutes).
      const overdue = () => { if (q.fail && now - q.at >= PAGE_ACK_MS) this.phoneLapse(`a page (${q.kind ?? "a line"}) got no acknowledgment from Healthchecks within ${PAGE_ACK_MS / 60_000} minutes`); };
      const base = q.to === "done" ? this.opts.hc_done : q.to === "deadman" ? this.opts.hc_deadman : this.alertUrl(q.app);
      const behind = !q.fail && keep.some((k) => k.app === q.app && k.fail && k.to === q.to);
      const shared = !q.fail && q.to === "failed" && HTTPS.test(base) ? this.incidentOn(base, q.app, keep) : null;
      if (shared && q.next !== -1) { this.d.log(`a success ping for ${q.app} waits: ${shared} shares its alert check and has an incident open`); q.next = -1; }
      if (behind || shared || (q.next > 0 && now < q.next) || !HTTPS.test(base)) { overdue(); keep.push(q); continue; }
      const url = q.fail ? `${base.replace(/\/+$/, "")}/fail` : base;
      const ok = await this.d.ping(url, q.body).catch(() => false);
      const notice = NOTICES.has(String(q.kind ?? "").replace(/ clear$/, ""));
      if (ok) {
        if (q.fail && q.to === "failed" && !notice) this.st.outstanding[q.app] = true;
        if (!q.fail && q.to === "failed" && !notice) delete this.st.outstanding[q.app];
        if (q.kind === "phone test") { const p = this.st.phone[checkId(base)]; if (p) p.deliveredAt = this.now(); }
        if (q.kind === "rolled back" && q.attempt && this.st.attempts[q.attempt]) this.st.attempts[q.attempt].lineDelivered = true;
        if (q.attempt) this.autoDrill(q.attempt);
        continue;
      }
      overdue();
      q.tries++; q.next = now + Math.min(600_000, 30_000 * 2 ** Math.min(q.tries, 5));
      keep.push(q);
    }
    this.st.queue = keep;
  }
  private clearOutstanding(app: string): void {
    if (!this.st.outstanding[app]) return;
    if (this.open(app).length || this.unresolvedOf(app).length || this.appState[app] !== "started") return;
    const h = this.appHealth[app] ?? [];
    if (h.length < 3 || !h.every(Boolean)) return;
    if (this.st.queue.some((q) => q.app === app && q.to === "failed")) return;
    delete this.st.outstanding[app];
    this.st.queue.push({ key: `${app}-clear-${++this.st.lines}`, to: "failed", fail: false, body: `${appName(app)} is started and live again.`, app, tries: 0, next: 0, at: this.now() });
  }
  // The poll's heartbeat: the time in /data, a ping to hc_done every 5 minutes, and a non-paging log ping
  // (the check's ping URL plus /log) to each alert check every 5 minutes. Each delivery's time is kept.
  private async tickHeartbeat(now: number): Promise<void> {
    this.st.heartbeat = now;
    // (0.1.6) the missed-heartbeat drill: no heartbeat ping to hc_done until its end
    // 0.1.7: until Healthchecks shows the check down, or the cap
    const m = this.st.mhb;
    const silent = !!m && !m.resumedAt && !m.sawDown && now < m.cap;
    if (m && !m.resumedAt && !silent) {
      m.resumedAt = now; this.st.hcPinged = 0;
      this.d.log(`missed-heartbeat drill: the heartbeat ping resumes${m.sawDown ? "" : ` (Healthchecks didn't show the heartbeat check down within ${MHB_CAP_MS / 60_000} minutes: the drill can't be confirmed; run it again)`}; once its page reached your phone and Healthchecks shows the check up again, within an hour, run missed-heartbeat-confirm <code>`);
      this.save();
    }
    if (!silent && now - this.st.hcPinged >= HC_HEARTBEAT_MS && HTTPS.test(this.opts.hc_done)) {
      const ok = await this.d.ping(this.opts.hc_done, "keeper heartbeat").catch(() => false);
      if (ok) { this.st.hcPinged = now; this.st.hcDelivered = this.now(); }
      else { this.st.hcPinged = now - HC_HEARTBEAT_MS + 60_000; this.d.log("the heartbeat ping to hc_done wasn't delivered: tried again in a minute"); }
    }
    for (const u of this.alertUrls()) {
      const key = sha(u).slice(0, 16);
      if (now - (this.st.logPinged[key] ?? 0) < HC_HEARTBEAT_MS) continue;
      const ok = await this.d.ping(`${u.replace(/\/+$/, "")}/log`, "keeper alert path check").catch(() => false);
      if (ok) { this.st.logPinged[key] = now; this.st.logDelivered[key] = this.now(); }
      else { this.st.logPinged[key] = now - HC_HEARTBEAT_MS + 60_000; this.d.log("a log ping to an alert check wasn't delivered: tried again in a minute"); }
    }
  }
  heartbeat(): void { this.st.heartbeat = this.now(); this.save(); }
  // (0.1.3) The dead-man check: pinged every minute from the keeper's own process timer (main.ts), apart
  // from the poll, so its pings stop when the keeper's process or container dies, and that pages. 0.1.4:
  // only while the poll loop completed an iteration within the last 3 minutes; otherwise the timer sends
  // the check's /fail ping (the keeper is alive but not watching), which pages at once.
  async deadman(): Promise<boolean> {
    if (!HTTPS.test(this.opts.hc_deadman)) return false;
    const now = this.now();
    if (now - this.loopDone > LOOP_FRESH_MS) {
      const mins = this.loopDone ? Math.round((now - this.loopDone) / 60_000) : null;
      const ok = await this.d.ping(`${this.opts.hc_deadman.replace(/\/+$/, "")}/fail`, `Keeper's poll loop ${mins === null ? "hasn't completed since it started" : `hasn't completed for ${mins} minutes`}: it isn't watching installs`).catch(() => false);
      // (0.1.5) the same acknowledgment deadline as every page
      if (ok) delete this.st.deadmanFailSince;
      else if (!this.st.deadmanFailSince) this.st.deadmanFailSince = now;
      else if (now - this.st.deadmanFailSince >= PAGE_ACK_MS) this.phoneLapse(`a dead-man page got no acknowledgment from Healthchecks within ${PAGE_ACK_MS / 60_000} minutes`);
      return false;
    }
    const ok = await this.d.ping(this.opts.hc_deadman, "keeper alive").catch(() => false);
    if (ok) { this.st.deadmanDelivered = this.now(); delete this.st.deadmanFailSince; }
    return ok;
  }
  loopStalled(now = this.now()): boolean { return now - this.loopDone > LOOP_FRESH_MS; }
  delivered(now = this.now()): boolean { return this.st.hcDelivered > 0 && now - this.st.hcDelivered <= DELIVERY_MS; }

  // -- the Healthchecks settings read (0.1.5) ----------------------------------------------------------
  // With hc_api_key, at most every minute: each check's period (timeout), grace, status and channels,
  // through the Healthchecks management API. A check is found by the id in its ping URL: the uuid in the
  // API's ping_url, or (a read-only key) its unique_key, or the slug. Refused (not armable now): a check
  // not found, a heartbeat check with a period over 5 minutes or a grace over 10, a dead-man check whose
  // period isn't 1 minute or whose grace is over 5, a check with no channel (or a key that doesn't show
  // channels), a paused check, a heartbeat or dead-man check that is down. Its settings' hash must equal
  // the one taken at the phone test (a change lapses the phone test).
  private async readHc(force = false): Promise<void> {
    const key = this.hcKey;
    const now = this.now();
    if (!key || !this.d.hcChecks) { this.hcSeen = null; return; }
    if (!force && this.hcSeen && now - this.hcSeen.at < HC_READ_MS) return;
    const list = await this.d.hcChecks(key).catch(() => null);
    const v: HcJudged = list ? judgeHc(this.opts, list) : { ok: false, why: "the Healthchecks API couldn't be read with the kept key", hash: "" };
    this.hcSeen = { at: this.now(), ...v };
    const said = `${v.why}|${(v.hidden ?? []).join(",")}`;
    if (said !== this.hcSaid) { this.hcSaid = said; this.d.log(v.ok ? `the Healthchecks checks' settings are within bounds${v.hidden?.length ? ` (the key hides the channels of ${v.hidden.join(", ")}: arming takes the owner's confirmations at the phone test and the missed-heartbeat drill in their place)` : ""}` : `the Healthchecks checks' settings refuse arming: ${v.why}`); }
    // (0.1.6) A key that can write is refused, and the owner is paged once per key to swap it.
    const kh = sha(`hc-key\n${key}`).slice(0, 16);
    if (v.rw && this.st.hcRwSaid !== kh) {
      this.st.hcRwSaid = kh;
      this.d.log("REFUSING the kept Healthchecks key: it can write (pause checks, change their period and grace, reroute their channels). Enter the project's read-only API key with hc-key (Healthchecks, Project Settings, API Access, the read-only key)");
      this.notice(this.d.self, "hc key", "Keeper's Healthchecks key can write. Keeper refuses to arm with it. Enter the project's read-only API key with hc-key at the device (Project Settings, API Access).", "Keeper's Healthchecks key notice done.");
      this.save();
    }
    // (0.1.6) the missed-heartbeat drill: Healthchecks seen showing the heartbeat check down during it
    const m = this.st.mhb;
    if (m && !m.sawDown && !m.resumedAt && v.done?.status === "down" && this.now() >= m.startedAt) { m.sawDown = this.now(); this.d.log("missed-heartbeat drill: Healthchecks shows the heartbeat check down; the heartbeat ping resumes"); this.save(); }
    // (0.1.7) and then up again after the ping resumed: the drill's down-to-up cycle is whole
    if (m && m.sawDown && m.resumedAt && !m.sawUp && v.done?.status === "up" && this.now() > m.resumedAt) { m.sawUp = this.now(); this.d.log("missed-heartbeat drill: Healthchecks shows the heartbeat check up again"); this.save(); }
    if (v.ok && this.st.phoneHcApi && v.hash !== this.st.phoneHcApi) this.phoneLapse("a Healthchecks check's period, grace or channels changed since the phone test");
  }
  // Why the settings read refuses arming now ("" when it doesn't).
  hcWhy(now = this.now()): string {
    if (!this.hcKey) return "no Healthchecks key is kept (hc-key), so Keeper can't read the checks' settings";
    const h = this.hcSeen;
    if (!h || now - h.at > HC_READ_FRESH_MS) return "the Healthchecks checks' settings haven't been read in the last 3 minutes";
    return h.ok ? "" : h.why;
  }

  // -- drills and arming ----------------------------------------------------------------------------
  drillRecord(id: string): { ok: boolean; why: string } {
    const a = this.st.attempts[id];
    const kind: DrillRec["kind"] | null = a?.trigger?.kind === "verdict" ? "fail-verdict"
      : a?.trigger?.kind === "state-error" || a?.trigger?.kind === "not-started" ? "exits-on-start" : null;
    const why = !a ? "no such attempt"
      : a.auth !== "drill" ? "it wasn't a drill"
      // (0.1.14) evidence, not just kind drill plus a rollback: the link confirmed it wrote the signed mark for this attempt,
      // and the failure Keeper observed is the one the drill's mode names
      : !a.drillMode ? "it carries no drill mode"
      : !a.markAt || !a.markHash ? "no evidence the drill mark was written (the link never confirmed it to Keeper)"
      : a.status !== "rolled back" ? `it ended ${a.status}, not rolled back`
      : !a.restore?.called || !a.restore.doneAt ? "no restore of its backup ran"
      : !kind ? `its trigger (${a.trigger?.kind ?? "none"}) is neither a FAIL verdict nor an exit on start`
      : DRILL_KIND_OF[a.drillMode] !== kind ? `the failure Keeper observed (${kind}) isn't the one its drill mode (${a.drillMode}) names`
      : !a.lineDelivered ? "its owner line wasn't delivered"
      : a.probeHash !== this.st.probeHash[a.app] ? "a newer registration changed the probe since"
      : null;
    if (why) return { ok: false, why };
    (this.st.drills[a!.app] ??= {})[kind!] = { attempt: a!.id, kind: kind!, trigger: a!.trigger!.words, restoredAt: a!.restore!.doneAt!,
      lineDeliveredAt: this.now(), binding: { ...this.binding(a!.app), probe_hash: a!.probeHash }, at: this.now(), mode: a!.drillMode, markAt: a!.markAt, markHash: a!.markHash };
    a!.drillRecorded = true;
    this.d.log(`drill recorded for ${a!.app}: ${kind} (${a!.id}); it counts while Keeper's version, its options, the kept Healthchecks key and ${appName(a!.app)}'s probe stay as they are now`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.13) The drill runbook's state read (DOCS.md, "The drill runbook"): for each watched App, its newest attempts (kind,
  // versions, status, trigger, whether a restore ran and whether a drill record was written), its drill records and whether
  // each still counts under the current binding, the binding itself and why it isn't armed. Read only: nothing is saved,
  // and the enrollment counter doesn't move (the local drill-state command; /armed stays the link's read).
  drillState(): { ok: true; why: string; state: Record<string, unknown> } {
    const now = this.now();
    const apps: Record<string, unknown> = {};
    for (const app of this.opts.watch) {
      const cur = JSON.stringify(this.binding(app));
      const attempts = Object.values(this.st.attempts).filter((a) => a.app === app).sort((x, y) => x.registeredAt - y.registeredAt).slice(-6)
        .map((a) => ({ id: a.id, kind: a.auth, from: a.from, to: a.to, status: a.status, trigger: a.trigger?.kind ?? null,
          restored: !!a.restore?.doneAt, drill_recorded: !!a.drillRecorded, registered: new Date(a.registeredAt).toISOString(),
          ...(a.drillMode ? { drill_mode: a.drillMode, mark_confirmed: a.markAt ? new Date(a.markAt).toISOString() : null } : {}) }));
      const d = this.st.drills[app] ?? {};
      const drills = (["exits-on-start", "fail-verdict"] as const).map((k) => d[k] ? { kind: k, attempt: d[k]!.attempt, at: new Date(d[k]!.at).toISOString(),
        counts: JSON.stringify(d[k]!.binding) === cur && now - d[k]!.at <= ARMED_MAX_MS } : { kind: k, attempt: null, at: null, counts: false });
      const v = this.armedState(app, now);
      apps[app] = { attempts, drills, armed: v.armed, why: v.why, binding: this.binding(app) };
    }
    return { ok: true, why: "", state: { keeper_version: this.d.version, at: new Date(now).toISOString(), drill_running: this.drillRunning(now) || null,
      followups_open: this.opts.drill_followups_open, apps } };
  }
  private autoDrill(id: string): void {
    const a = this.st.attempts[id];
    if (a && a.auth === "drill" && a.status === "rolled back" && !a.drillRecorded) {
      const r = this.drillRecord(id);
      if (!r.ok) this.d.log(`no drill record for ${id}: ${r.why}`);
    }
  }
  // (0.1.3) The phone test drill. phoneTest pages every watched App's alert check once ("a drill"), and
  // (0.1.4) the dead-man check too, each followed by its all clear; phoneConfirm, once the owner has seen
  // the pages on his phone, records it for each check whose page was delivered within the last hour. 0.1.4:
  // it lapses after 30 days, on any change of the Healthchecks options, and whenever a page isn't
  // delivered to Healthchecks.
  phoneTest(): { ok: boolean; why: string } {
    const why = this.armableWhy() || this.hcWhy();
    if (why) return { ok: false, why: `not armable: ${why}` };
    const drill = this.drillRunning();
    if (drill) return { ok: false, why: `${drill} is running: one drill at a time` };
    const busy = this.opts.watch.find((a) => this.st.outstanding[a] || this.open(a).length || this.unresolvedOf(a).length || this.st.queue.some((q) => q.app === a));
    if (busy) return { ok: false, why: `${appName(busy)} has an incident or a line still going out: test the phone once it has cleared` };
    this.st.phone = {}; this.st.phoneHc = this.hcH(); this.st.phoneHcApi = this.hcSeen!.hash;
    const runId = `phone-${this.now()}-${randomBytes(3).toString("hex")}`;
    this.st.phoneRun = { id: runId, at: this.now() };
    for (const app of this.opts.watch) {
      const u = this.alertUrl(app);
      this.st.phone[checkId(u)] = { sentAt: this.now() };
      const n = ++this.st.lines;
      this.st.queue.push({ key: `phone-${n}`, to: "failed", fail: true, body: `Keeper phone test (a drill) for ${appName(app)}: if this reached your phone, confirm it as Keeper's DOCS say (Arming, the phone test). Nothing is wrong.`, app, kind: "phone test", tries: 0, next: 0, at: this.now() });
      this.st.queue.push({ key: `phone-${n}-clear`, to: "failed", fail: false, body: `Keeper phone test for ${appName(app)} done.`, app, kind: "phone test clear", tries: 0, next: 0, at: this.now() });
    }
    this.st.phone[checkId(this.opts.hc_deadman)] = { sentAt: this.now() };
    const n = ++this.st.lines;
    this.st.queue.push({ key: `phone-${n}`, to: "deadman", fail: true, body: "Keeper phone test (a drill) of its dead-man check: if this reached your phone, confirm it as Keeper's DOCS say. Nothing is wrong.", app: this.d.self, kind: "phone test", tries: 0, next: 0, at: this.now() });
    this.st.queue.push({ key: `phone-${n}-clear`, to: "deadman", fail: false, body: "keeper alive", app: this.d.self, kind: "phone test clear", tries: 0, next: 0, at: this.now() });
    this.d.log(`phone test sent to the alert check of ${this.opts.watch.join(", ")} and to the dead-man check; confirm each check whose page reached your phone: phone-confirm <code> ${[...this.opts.watch.map((a) => a.replace(/^[0-9a-f]{8}_/, "")), "deadman"].join(" ")}`);
    this.issueCode("phone", PHONE_WINDOW_MS + 10 * 60_000, runId);
    this.save();
    return { ok: true, why: "" };
  }
  // 0.1.6: with the one-time code printed at the phone test, and per check: the owner names each check whose
  // page reached the phone (an App's slug or its short name for its alert check, "deadman" for the dead-man
  // check). That is also the owner's confirmation that the check's channel reaches the phone, which arming
  // takes in place of the API's channel list when a read-only key hides it.
  // 0.1.7: whole, in one call: every check is named (every watched App's alert check and the dead-man check),
  // every page was delivered within the hour, and only then is the code (bound to this test) spent, once. A
  // check whose page didn't reach the phone means the test failed: run it again.
  phoneConfirm(code: string, names: string[]): { ok: boolean; why: string } {
    const now = this.now();
    const all = [...this.opts.watch.map((a) => a.replace(/^[0-9a-f]{8}_/, "")), "deadman"];
    const want = names.map((x) => s(x).toLowerCase()).filter(Boolean);
    const checks: [string, string, string[]][] = [...this.opts.watch.map((app) => [`${app}'s alert check`, this.alertUrl(app), [app, app.replace(/^[0-9a-f]{8}_/, "")]] as [string, string, string[]]),
      ["the dead-man check", this.opts.hc_deadman, ["deadman", "hc_deadman"]]];
    const unknown = want.filter((w) => !checks.some(([, , n]) => n.includes(w)));
    if (unknown.length) return { ok: false, why: `no such check: ${unknown.join(", ")} (name ${all.join(", ")})` };
    const missing = checks.filter(([, , n]) => !n.some((x) => want.includes(x))).map(([name]) => name);
    if (missing.length) return { ok: false, why: `name every check in one call (${all.join(" ")}); not named: ${missing.join(", ")}. If a check's page didn't reach your phone, the test failed: fix that check's channel and run phone-test again` };
    const run = this.st.phoneRun;
    if (!run) return { ok: false, why: "no phone test runs: run keeper phone-test first" };
    const late = checks.filter(([, u]) => { const p = this.st.phone[checkId(u)]; return !(p?.deliveredAt && now - p.deliveredAt <= PHONE_WINDOW_MS); }).map(([name]) => name);
    if (late.length) return { ok: false, why: `no phone test page was delivered in the last hour to ${late.join(", ")}: wait for the pages, or run keeper phone-test again` };
    const bad = this.useCode("phone", code, run.id);
    if (bad) return { ok: false, why: bad };
    for (const [, u] of checks) this.st.phone[checkId(u)].confirmedAt = now;
    delete this.st.phoneRun;
    this.d.log(`phone test confirmed by the owner for ${checks.map(([n]) => n).join(", ")}: the owner's own attestation that each check's alert appeared on the phone (Keeper can't see the phone); good for ${this.opts.drill_days} days`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.6) The missed-heartbeat drill. With no incident open and the checks' settings read within bounds,
  // Keeper stops its heartbeat ping to hc_done for the heartbeat check's period plus grace (from the API)
  // plus 2 minutes, so Healthchecks marks it down and pages; the dead-man ping goes on. It then resumes, and
  // once the page reached the phone, within an hour, the owner confirms it with the code it printed
  // (missedHeartbeatConfirm). The confirm needs Healthchecks seen showing the heartbeat check down.
  // 0.1.7: the silence isn't computed from the check's settings any more: the heartbeat ping stops until a read
  // of the API shows the heartbeat check down (at most MHB_CAP_MS), then resumes, and the check must be seen
  // up again before the confirm. A check on a schedule (cron) is refused: its page time can't be judged.
  missedHeartbeat(): { ok: boolean; why: string } {
    const d0 = this.hcSeen?.done;
    if (d0?.schedule) { this.d.log("refused the missed-heartbeat drill: the heartbeat check runs on a schedule, not a period"); return { ok: false, why: "the heartbeat check (hc_done) runs on a schedule (cron), and the drill needs a simple period check: change it to a period of at most 5 minutes" }; }
    const why = this.armableWhy() || this.hcWhy();
    if (why) return { ok: false, why: `not armable: ${why}` };
    const drill = this.drillRunning();
    if (drill) return { ok: false, why: `${drill} is running: one drill at a time` };
    const busy = this.opts.watch.find((a) => this.st.outstanding[a] || this.open(a).length || this.unresolvedOf(a).length || this.st.queue.some((q) => q.app === a));
    if (busy) return { ok: false, why: `${appName(busy)} has an incident or a line still going out: run the drill once it has cleared` };
    const d = this.hcSeen?.done;
    if (!d || !(d.period > 0)) return { ok: false, why: "the heartbeat check's period can't be read from the Healthchecks API" };
    const now = this.now();
    const id = `mhb-${now}-${randomBytes(3).toString("hex")}`;
    this.st.mhb = { id, startedAt: now, cap: now + MHB_CAP_MS, api: this.hcSeen?.hash ?? "" };
    this.d.log(`missed-heartbeat drill: no heartbeat ping to hc_done until Healthchecks shows the check down (read every minute; at most until ${new Date(now + MHB_CAP_MS).toISOString()}), so Healthchecks pages you; then the ping resumes, and once the page reached your phone and the check is up again, within an hour, run missed-heartbeat-confirm <code>`);
    this.issueCode("heartbeat", MHB_CAP_MS + PHONE_WINDOW_MS, id);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  missedHeartbeatConfirm(code: string): { ok: boolean; why: string } {
    const m = this.st.mhb, now = this.now();
    if (!m) return { ok: false, why: "no missed-heartbeat drill runs: run keeper missed-heartbeat first" };
    if (!m.resumedAt) return { ok: false, why: `the drill runs until Healthchecks shows the heartbeat check down (at most until ${new Date(m.cap).toISOString()}): confirm once the ping resumed and the page reached your phone` };
    if (now - m.resumedAt > PHONE_WINDOW_MS) return { ok: false, why: "the drill ended over an hour ago: run it again" };
    if (!m.sawDown) return { ok: false, why: "Healthchecks never showed the heartbeat check down during the drill, so its page can't have been the drill's: run it again" };
    if (!m.sawUp) return { ok: false, why: "Healthchecks hasn't shown the heartbeat check up again since the ping resumed: confirm once it has (a minute or two)" };
    const bad = this.useCode("heartbeat", code, m.id);
    if (bad) return { ok: false, why: bad };
    this.st.mhbRec = { confirmedAt: now, hc: this.hcH(), api: m.api };
    delete this.st.mhb;
    this.d.log(`missed-heartbeat drill confirmed by the owner: the owner's own attestation that the missed heartbeat's alert appeared on the phone (Keeper can't see the phone); good for ${this.opts.drill_days} days`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.6) The missed-heartbeat drill confirmed within 14 days, under the current Healthchecks options and
  // checks' settings.
  private mhbOk(now: number): boolean {
    const r = this.st.mhbRec;
    if (!r || r.hc !== this.hcH() || now - r.confirmedAt > this.drillMs()) return false;
    return !(this.hcSeen?.ok && this.hcSeen.hash !== r.api);
  }
  // (0.1.4) Confirmed within 14 days (0.1.5), under the current Healthchecks options and checks' settings,
  // for the App's alert check and the dead-man check.
  private phoneOk(app: string, now: number): boolean {
    if (this.st.phoneHc !== this.hcH()) return false;
    if (!this.st.phoneHcApi || (this.hcSeen?.ok && this.hcSeen.hash !== this.st.phoneHcApi)) return false;
    return [this.alertUrl(app), this.opts.hc_deadman].every((u) => { const p = this.st.phone[checkId(u)]; return !!p?.confirmedAt && now - p.confirmedAt <= this.drillMs(); });
  }
  // (0.1.8) How long a phone test and a missed-heartbeat drill count: option drill_days (1 to 14, default 14).
  drillMs(): number { return Math.min(this.opts.drill_days, 14) * 86_400_000; }
  // (0.1.8) A log reminder before each drill is due: a day before its window ends (half the window when that is a
  // day or less), once per confirm. Arming lapses at the mark itself, when the drill isn't run again in time.
  private drillReminders(now: number): void {
    const win = this.drillMs(), lead = Math.min(86_400_000, win / 2);
    const phoneAt = Math.min(...[...this.opts.watch.map((a) => this.alertUrl(a)), this.opts.hc_deadman].map((u) => this.st.phone[checkId(u)]?.confirmedAt ?? Infinity));
    const due: [keyof NonNullable<State["drillDue"]>, number, string][] = [["phone", phoneAt, "the phone test (phone-test, then phone-confirm)"], ["mhb", this.st.mhbRec?.confirmedAt ?? Infinity, "the missed-heartbeat drill (missed-heartbeat, then missed-heartbeat-confirm)"]];
    for (const [kind, at, what] of due) {
      if (!Number.isFinite(at) || now < at + win - lead || this.st.drillDue?.[kind] === at) continue;
      (this.st.drillDue ??= {})[kind] = at;
      this.d.log(`drill due: run ${what} again before ${new Date(at + win).toISOString()} (drill_days ${this.opts.drill_days}); arming lapses at that mark if it isn't confirmed again`);
    }
  }
  arm(): void {
    const now = this.now();
    this.drillReminders(now);
    for (const app of Object.keys(this.st.drills)) {
      const cur = this.binding(app);
      const d = this.st.drills[app] ?? {};
      for (const k of Object.keys(d) as DrillRec["kind"][]) {
        const rec = d[k]!;
        if (JSON.stringify(rec.binding) !== JSON.stringify(cur) || now - rec.at > ARMED_MAX_MS) {
          this.d.log(`the ${k} drill of ${app} no longer counts (${now - rec.at > ARMED_MAX_MS ? "older than 60 days" : "its binding changed"})`);
          delete d[k];
        }
      }
      if (!Object.keys(d).length) delete this.st.drills[app];
    }
    for (const app of new Set([...Object.keys(this.st.drills), ...Object.keys(this.armedSaid)])) {
      const v = this.armedState(app, now);
      if (v.armed !== !!this.armedSaid[app]) { this.d.log(v.armed ? `armed for ${app}` : `not armed for ${app}: ${v.why}`); }
      if (v.armed) this.armedSaid[app] = true; else delete this.armedSaid[app];
    }
  }
  // Armed, computed at every read, only while all of these hold: armable (hc_done, hc_deadman, and an
  // alert check of its own for every watched App, each a distinct check); both drill records valid under
  // the current binding; the phone test confirmed within 30 days for this App's alert check and the
  // dead-man check, under the current Healthchecks options, with no page undelivered since; a heartbeat
  // ping and a dead-man ping delivered within 10 minutes; the poll loop completed within 3 minutes; each
  // alert check's log ping delivered within 10 minutes; and no fail ping waiting undelivered for more
  // than 2 minutes.
  armedState(app: string, now = this.now()): { armed: boolean; why: string; at: number | null } {
    const cur = JSON.stringify(this.binding(app));
    const d = this.st.drills[app] ?? {};
    const valid = (["fail-verdict", "exits-on-start"] as const).map((k) => d[k]).filter((r) => r && JSON.stringify(r.binding) === cur && now - r.at <= ARMED_MAX_MS);
    const stale = this.alertUrls().filter((u) => { const t = this.st.logDelivered[sha(u).slice(0, 16)] ?? 0; return !t || now - t > DELIVERY_MS; });
    const stuck = this.st.queue.some((q) => q.fail && now - q.at > STUCK_FAIL_MS);
    const armable = this.armableWhy();
    const hc = armable ? "" : this.hcWhy(now);
    const drill = this.drillRunning(now);
    const why = armable ? `the keeper is not armable: ${armable}`
      : !this.limitsOk() ? `the owner hasn't accepted the limits in Keeper's DOCS (Accepted limits, text version ${LIMITS_VERSION}): accept-limits <code>`
      : this.opts.drill_followups_open ? FOLLOWUPS_WHY
      : drill ? `${drill} is running (one drill at a time; Keeper is unarmed during a drill)`
      : valid.length < 2 ? `no drills on record for ${app} under the current binding`
      : !this.phoneOk(app, now) ? `no phone test drill confirmed for ${app}'s alert check and the dead-man check in the last ${this.opts.drill_days} days, under the current Healthchecks options and checks' settings`
      : !this.mhbOk(now) ? `no missed-heartbeat drill confirmed in the last ${this.opts.drill_days} days, under the current Healthchecks options and checks' settings`
      : !this.delivered(now) ? "no heartbeat ping was delivered to Healthchecks in the last 10 minutes"
      : !this.st.deadmanDelivered || now - this.st.deadmanDelivered > DELIVERY_MS ? "no dead-man ping was delivered to Healthchecks in the last 10 minutes"
      : this.loopStalled(now) ? "Keeper's poll loop hasn't completed in the last 3 minutes"
      : hc ? `the Healthchecks checks refuse arming: ${hc}`
      : stale.length ? "an alert check's log ping wasn't delivered to Healthchecks in the last 10 minutes"
      : stuck ? "a fail ping has waited undelivered for more than 2 minutes"
      : "";
    return { armed: !why, why, at: valid.length === 2 ? Math.max(...valid.map((r) => r!.at)) : null };
  }
  // (0.1.8) GET /armed, under the claim record's lock (armed reads one at a time, between claims and consumes).
  armed(app: string): Promise<ReturnType<Keeper["armedView"]>> {
    return this.record(() => this.armedView(app), (why) => ({ app, armed: false, why: `Keeper's armed read failed (${why})`, armed_at: null, binding: this.binding(app), keeper_version: this.d.version, at: new Date(this.now()).toISOString() }));
  }
  armedView(app: string): { app: string; armed: boolean; why: string; armed_at: string | null; binding: Binding; keeper_version: string; at: string; key_fp?: string; key_confirmed_at?: string | null; state_created?: string; enroll_id?: string; counter?: number } {
    // (0.1.7) each armed read moves the enrollment counter on, saved; 0.1.8: written whole and fsynced (main.ts
    // writeWhole) before the answer leaves, and an answer whose counter couldn't be saved carries no enrollment
    if (!this.save()) return { app, armed: false, why: "Keeper couldn't save its state, so this read carries no enrollment", armed_at: null, binding: this.binding(app),
      keeper_version: this.d.version, at: new Date(this.st.heartbeat || this.now()).toISOString() };
    const v = this.armedState(app);
    return { app, armed: v.armed, why: v.why, armed_at: v.armed && v.at ? new Date(v.at).toISOString() : null, binding: this.binding(app),
      keeper_version: this.d.version, at: new Date(this.st.heartbeat || this.now()).toISOString(), ...this.enrollment() };
  }
  // (0.1.5) The phone test reads the checks' settings first (server.ts).
  refreshHc(): Promise<void> { return this.readHc(true); }
}
