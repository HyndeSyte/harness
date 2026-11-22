// The keeper of installs (Keeper 0.1.0; review fixes 0.1.1, 0.1.2, 0.1.3 and 0.1.4): a check after every
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
// The life of an attempt (one install of one App, registered just before the install):
//   verifying    the registration was taken; its backup is being made and checked (the answer waits)
//   unprotected  the backup (or the registration) failed a check: nothing is ever restored for it
//   accepted     the backup holds that App alone at from_version: "accepting ..." is logged and answered
//   watching     to_version was seen in the App's info (the acceptance consumed): 15 minutes from then
//   restoring    a fail: marked before the restore starts, so the version change it causes is this
//                attempt's recovery and never a new attempt, across restarts
//   unresolved   the restore's outcome isn't established: fenced (nothing is sent again, ever),
//                reconciled read only on every poll, and moved on (one follow-up line) once known
//   passed       the watch ended with every pass condition held
//   rolled back  the restore job finished without errors and from_version is started and live again
//   gave up      the restore failed, or the App didn't come back
//   never started  the install deadline passed without to_version ever seen (nothing restored)
import { createHash, createPublicKey, timingSafeEqual, verify as edVerify, type KeyObject } from "node:crypto";

export const PROTOCOL = 1;                       // the verdict protocol version, bound into the armed state
export const BACKUP_SCOPE = "app-only";          // the backup scope bound into the armed state
export const REGISTRAR = "0fcc2575_cain";        // (0.1.3) the only App whose token may register an install
export const POLL_MS = 30_000;
export const WATCH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 60_000;              // the heartbeat time in /data, /armed's timestamp, the dead-man ping
export const HC_HEARTBEAT_MS = 5 * 60_000;       // the ping to hc_done, and the log ping to each alert check
export const REGISTER_WAIT_MS = 4 * 60_000;      // (0.1.4) the registration's answer waits this long for the backup
export const BACKUP_DATE_SKEW_MS = 60_000;       // (0.1.4) the backup's date may read this much before the token's issue
export const INSTALL_MS = 60 * 60_000;           // (0.1.3) a registration's install deadline, from its registration
export const RESTORE_LIMIT_MS = 15 * 60_000;     // the restore's whole limit, refusals included, from the fail
export const CONFIRM_MS = 5 * 60_000;            // after the restore job: from_version started and live within this
export const REWIND_MS = 10 * 60_000;            // a heartbeat gap at start over this drops the drill records
export const ARMED_MAX_MS = 60 * 86_400_000;     // drill records last 60 days
export const PHONE_MAX_MS = 30 * 86_400_000;     // (0.1.4) the phone test lasts 30 days
export const LOOP_FRESH_MS = 3 * 60_000;         // (0.1.4) the dead-man ping goes only while a poll completed within this
export const DELIVERY_MS = 10 * 60_000;          // armed only while the heartbeat, dead-man and log pings were delivered within this
export const STUCK_FAIL_MS = 2 * 60_000;         // a fail ping undelivered for longer than this disarms
export const PHONE_WINDOW_MS = 60 * 60_000;      // (0.1.3) a phone test is confirmed within an hour of its page
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
  return {
    watch, health: pairs(o.health), tokens: pairs(o.tokens), hc_done: s(o.hc_done), hc_deadman: s(o.hc_deadman), hc_failed: parseAlerts(o.hc_failed),
    health_grace_s: Number.isFinite(grace) && grace >= 0 && grace <= 900 ? Math.floor(grace) : DEFAULT_HEALTH_GRACE_S,
    ship_public_key: s(o.ship_public_key).replace(/\s+/g, ""),
  };
}
const sortedRec = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
// The options' hash, canonical, so an options change re-binds (and drops) the drill records.
export function optionsHash(o: Options): string {
  const canon = JSON.stringify({ watch: [...o.watch].sort(), health: sortedRec(o.health), tokens: sortedRec(o.tokens),
    hc_done: o.hc_done, hc_deadman: o.hc_deadman, hc_failed: sortedRec(o.hc_failed), health_grace_s: o.health_grace_s, ship_public_key: o.ship_public_key });
  return sha(canon).slice(0, 16);
}
export const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const HTTPS = /^https:\/\/\S+$/;
// (0.1.4) The Healthchecks options' hash: a phone test counts only under the options it was made with.
export const hcHash = (o: Options) => sha(JSON.stringify({ hc_done: o.hc_done, hc_deadman: o.hc_deadman, hc_failed: sortedRec(o.hc_failed) })).slice(0, 16);
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

export const SLUG = /^[a-z0-9_]{1,64}$/;
// (0.1.4) Kinds of line that page and clear themselves, leaving no incident open.
const NOTICES = new Set(["phone test", "key pinned", "key changed", "degraded"]);
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
export type Status = "verifying" | "unprotected" | "accepted" | "watching" | "restoring" | "passed" | "rolled back" | "gave up" | "never started" | "unresolved";
export const OPEN: Status[] = ["verifying", "accepted", "watching", "restoring"];
export type TriggerKind = "state-error" | "not-started" | "health" | "verdict" | "deadline" | "version-moved" | "watch-end";
export interface Attempt {
  id: string; app: string; from: string; to: string; backup: string; deadline: number;
  auth: "ship" | "drill"; authHash: string; pr: number; head: string; authExpires: number; probeHash: string;
  registeredAt: number; status: Status; why?: string;
  backupAsked?: number;                          // (0.1.3) the keeper's own backup, asked at
  issuedAt?: number;                             // (0.1.4) the token's issue (ms): the backup must be made after it
  acceptedAt?: number; consumedAt?: number;      // (0.1.4) the acceptance, and its single use
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
  // to reconcile; refused (0.1.3) a 4xx answer waiting for the jobs list to show no restore of the backup;
  // resent (0.1.4) once a 4xx was sent again (at most once, and only with a drill's restore job name);
  // down once the App was seen not started after the call; called once the job finished without errors.
  restore?: { tries: number; nextTry: number; limit: number; inflight: boolean; called: boolean; doneAt?: number; confirmUntil?: number; result?: string;
    job?: string | null; sentAt?: number; pending?: boolean; said?: string; lastState?: string; restarts?: number; down?: boolean;
    refused?: { status: number; why: string; at: number }; resent?: boolean };
  endedAt?: number; lineDelivered?: boolean; drillRecorded?: boolean;
}
export interface Binding { protocol: number; probe_hash: string; keeper_version: string; options_hash: string; backup_scope: string }
export interface DrillRec { attempt: string; kind: "fail-verdict" | "exits-on-start"; trigger: string; restoredAt: number; lineDeliveredAt: number; binding: Binding; at: number }
// (0.1.3) The phone test drill, per check (0.1.4: its check id; every watched App's alert check and the
// dead-man check): the page sent, delivered, and the owner's confirmation that it reached his phone.
export interface PhoneRec { sentAt: number; deliveredAt?: number; confirmedAt?: number }
export interface LastLine { id: string; kind: string; line: string; at: number }
export interface QueueItem { key: string; to: "done" | "failed" | "deadman"; fail: boolean; body: string; app: string; attempt?: string; kind?: string; tries: number; next: number; at: number }
// A spent Ship token, per App: its id (a hash), the attempt it registered.
export interface Spent { id: string; auth: string; app: string; at: number }
// (0.1.4) The pinned Ship key, and the restore job name a device drill recorded.
export interface Pinned { key: string; fp: string; at: number }
export interface RestoreJobRec { name: string; attempt: string; at: number }
export interface State {
  format: 1;
  createdAt: number;                             // (0.1.4) when this state was created: older tokens are refused
  heartbeat: number;                             // ms, written every minute
  lastSeen: Record<string, string>;              // slug -> version
  attempts: Record<string, Attempt>;
  spent: Spent[];
  probeHash: Record<string, string>;             // slug -> the probe_hash of its newest registration
  outstanding: Record<string, boolean>;          // slug -> a fail ping delivered to its alert check, its success ping owed
  last: Record<string, LastLine>;
  drills: Record<string, Partial<Record<DrillRec["kind"], DrillRec>>>;
  phone: Record<string, PhoneRec>;
  phoneHc?: string;                              // (0.1.4) the Healthchecks options' hash at the phone test
  pinnedKey?: Pinned;                            // (0.1.4) the Ship key pinned on first use
  keyChangeSaid?: string;                        // (0.1.4) the fingerprint of a changed key already paged
  restoreJob?: RestoreJobRec;                    // (0.1.4) the restore job's name, recorded by a device drill
  queue: QueueItem[];
  hcPinged: number;
  hcDelivered: number;                           // the last heartbeat ping Healthchecks answered 2xx
  deadmanDelivered: number;                      // (0.1.3) the last dead-man ping Healthchecks answered 2xx
  logPinged: Record<string, number>;             // per alert check (its URL's hash): the last log ping tried
  logDelivered: Record<string, number>;          // per alert check: the last log ping Healthchecks answered 2xx
  lines: number;                                 // a counter for line ids
}
export const emptyState = (): State => ({ format: 1, createdAt: 0, heartbeat: 0, lastSeen: {}, attempts: {}, spent: [], probeHash: {}, outstanding: {}, last: {},
  drills: {}, phone: {}, queue: [], hcPinged: 0, hcDelivered: 0, deadmanDelivered: 0, logPinged: {}, logDelivered: {}, lines: 0 });
// Loads a saved state. Anything an earlier version kept that 0.1.3 no longer uses (the kept tokens and
// URLs, the settings hold) is dropped here, never read.
export function loadState(raw: unknown): State {
  const e = emptyState();
  if (!raw || typeof raw !== "object" || (raw as any).format !== 1) return e;
  const r = raw as any;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const pin = r.pinnedKey && typeof r.pinnedKey.key === "string" && typeof r.pinnedKey.fp === "string" ? { key: r.pinnedKey.key, fp: r.pinnedKey.fp, at: Number(r.pinnedKey.at) || 0 } : undefined;
  const rj = r.restoreJob && typeof r.restoreJob.name === "string" && r.restoreJob.name ? { name: r.restoreJob.name, attempt: s(r.restoreJob.attempt), at: Number(r.restoreJob.at) || 0 } : undefined;
  return { ...e, createdAt: Number(r.createdAt) || 0, heartbeat: Number(r.heartbeat) || 0,
    ...(pin ? { pinnedKey: pin } : {}), ...(rj ? { restoreJob: rj } : {}),
    ...(typeof r.phoneHc === "string" ? { phoneHc: r.phoneHc } : {}), ...(typeof r.keyChangeSaid === "string" ? { keyChangeSaid: r.keyChangeSaid } : {}), lastSeen: obj(r.lastSeen) as any, attempts: obj(r.attempts) as any, probeHash: obj(r.probeHash) as any,
    outstanding: obj(r.outstanding) as any, last: obj(r.last) as any, drills: obj(r.drills) as any, phone: obj(r.phone) as any,
    queue: Array.isArray(r.queue) ? r.queue.map((q: any) => ({ ...q, at: Number(q?.at) || 0 })) : [], hcPinged: Number(r.hcPinged) || 0, lines: Number(r.lines) || 0,
    spent: Array.isArray(r.spent) ? r.spent.filter((x: any) => x && typeof x.id === "string").map((x: any) => ({ id: x.id, auth: s(x.auth), app: s(x.app), at: Number(x.at) || 0 })).slice(-500) : [],
    hcDelivered: Number(r.hcDelivered) || 0, deadmanDelivered: Number(r.deadmanDelivered) || 0,
    logPinged: obj(r.logPinged) as any, logDelivered: obj(r.logDelivered) as any };
}

// -- the parts it is given ------------------------------------------------------------------------
export interface AppInfo { version: string; state: string }
export interface BackupInfo { homeassistant: unknown; addons: { slug: string; version: string }[]; folders: unknown[]; protected?: unknown; date?: string }
// The restore call's answer (0.1.3): started (the Supervisor took it; its job id when it gave one),
// refused (a 4xx: the Supervisor turned it down before running it; retry false for a missing backup or a
// refused permission), or unknown (a 5xx, no answer, or an answer that isn't one: it may have run).
export type RestoreResult =
  | { kind: "started"; job: string | null }
  | { kind: "refused"; status: number; retry: boolean; why: string }
  | { kind: "unknown"; why: string };
// A restore job, by its id, as the Supervisor's jobs list shows it.
export type JobState = { found: false } | { found: true; uuid: string; done: boolean; errors: number; name?: string; reference?: string };
// (0.1.4) The jobs list read for one backup against the recorded restore job name: jobs of exactly that
// name for the backup, and jobs that look like a restore (or have no name) it can't classify.
export interface RestoreJobsSeen { matching: number; unclassified: number }
export interface Deps {
  now: () => number;
  version: string;                               // the keeper's own version
  self: string;                                  // the keeper's own slug
  appInfo: (slug: string) => Promise<AppInfo | null>;
  backupInfo: (slug: string) => Promise<BackupInfo | null>;
  makeBackup: (app: string, name: string) => Promise<{ slug: string } | { why: string }>;   // (0.1.3) that App alone, no password
  restore: (backup: string, app: string) => Promise<RestoreResult>;
  job: (uuid: string) => Promise<JobState | null>;          // by its id only; null: the jobs list can't be read
  restoreJobs: (backup: string, name: string) => Promise<RestoreJobsSeen | null>;  // (0.1.4) null: unreadable
  live: (hostPort: string) => Promise<boolean>;             // the App's liveness, the host's /health
  ready: (hostPort: string) => Promise<boolean>;            // its readiness address (Cain's /ready): reported only
  ping: (url: string, body: string) => Promise<boolean>;
  options: () => unknown | Promise<unknown>;      // the keeper's options, re-read each poll (null: unreadable)
  save: (s: State) => void;
  log: (line: string) => void;
  timer?: (ms: number) => Promise<void>;          // (0.1.4) the registration's wait for its backup (tests: a fake)
}
export type Answer = { status: number; body: Record<string, unknown> };

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
  constructor(private d: Deps, saved: unknown) {
    this.st = loadState(saved);
    if (!this.st.createdAt) { this.st.createdAt = d.now(); d.log(`state created at ${new Date(this.st.createdAt).toISOString()}: Ship tokens issued before it are refused`); }
  }

  save(): void { this.d.save(this.st); }
  private now(): number { return this.d.now(); }

  // The options in force. 0.1.3: taken as they are, never filled in from a kept copy; a poll whose
  // options can't be read keeps the last ones read in this process.
  useOptions(raw: unknown): void {
    this.opts = parseOptions(raw);
    const why = this.armableWhy();
    if (why !== this.armableSaid) { if (why) this.d.log(`not armable: ${why}`); this.armableSaid = why; }
    if (this.st.phoneHc && this.st.phoneHc !== hcHash(this.opts)) this.phoneLapse("a Healthchecks option changed");
    this.pinKey();
  }
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
      this.d.log(`pinned the Ship public key, fingerprint ${fp} (trust on first use): a different key in the options is refused until it is confirmed at the device with key-confirm`);
      this.notice(this.d.self, "key pinned", `Keeper pinned Cain's link's Ship key, fingerprint ${fp}. A different key in its options is refused until you confirm it at the device.`,
        "Keeper's Ship key notice done.");
      this.save();
      return;
    }
    if (pin.key === o) { if (this.st.keyChangeSaid) { delete this.st.keyChangeSaid; this.save(); } return; }
    const fp = keyFp(o);
    if (this.st.keyChangeSaid === fp) return;
    this.st.keyChangeSaid = fp;
    this.d.log(`ship_public_key changed to a key with fingerprint ${fp}; Keeper keeps the pinned key (fingerprint ${pin.fp}) and refuses every registration until the new one is confirmed: key-confirm ${fp}`);
    this.notice(this.d.self, "key changed", `Keeper's Ship key option changed (new fingerprint ${fp}, pinned ${pin.fp}). Keeper refuses every install registration until you confirm the new key at the device. If you didn't change it, put the old one back.`,
      "Keeper's Ship key notice done.");
    this.save();
  }
  // (0.1.4) The owner's confirmation of a changed Ship key, from inside the keeper's container only
  // (keeper key-confirm <fingerprint>): the fingerprint must be the options' key's.
  keyConfirm(fp: string): { ok: boolean; why: string } {
    const o = this.opts.ship_public_key;
    if (!shipKey(o)) return { ok: false, why: "ship_public_key in the options isn't an Ed25519 public key" };
    const cur = keyFp(o);
    if (s(fp).toLowerCase() !== cur) return { ok: false, why: `that fingerprint isn't the options' key's (${cur})` };
    if (this.st.pinnedKey?.key === o) return { ok: true, why: "" };
    const was = this.st.pinnedKey?.fp ?? "none";
    this.st.pinnedKey = { key: o, fp: cur, at: this.now() };
    delete this.st.keyChangeSaid;
    this.d.log(`the owner confirmed the Ship key with fingerprint ${cur} at the device (it replaces ${was})`);
    this.save();
    return { ok: true, why: "" };
  }

  start(): void {
    const now = this.now();
    if (this.st.heartbeat && now - this.st.heartbeat > REWIND_MS) {
      const mins = Math.round((now - this.st.heartbeat) / 60_000);
      if (Object.keys(this.st.drills).length || Object.keys(this.st.phone).length)
        this.d.log(`the keeper's heartbeat stopped for ${mins} minutes (a rewind, a restore or a long stop): the drill records are dropped`);
      this.st.drills = {}; this.st.phone = {}; delete this.st.phoneHc;
      // (0.1.4) a rewound state may lack recently spent tokens: tokens issued before now are refused.
      this.st.createdAt = now;
    }
    for (const a of this.open()) this.d.log(`resuming ${a.id} ${a.app} (${a.status})`);
    for (const a of this.unresolvedOf()) this.d.log(`reconciling ${a.id} ${a.app} on every poll (unresolved: nothing is sent again)`);
    this.st.heartbeat = now;
    this.save();
  }
  open(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => OPEN.includes(a.status) && (!app || a.app === app)); }
  private unresolvedOf(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => a.status === "unresolved" && a.restore && (!app || a.app === app)); }
  binding(app: string): Binding {
    return { protocol: PROTOCOL, probe_hash: this.st.probeHash[app] ?? "", keeper_version: this.d.version, options_hash: optionsHash(this.opts), backup_scope: BACKUP_SCOPE };
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
  armableWhy(): string {
    const o = this.opts;
    if (!HTTPS.test(o.hc_done)) return "hc_done (the heartbeat check) isn't set";
    if (!HTTPS.test(o.hc_deadman)) return "hc_deadman (the dead-man check) isn't set";
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
    return "";
  }
  armable(): boolean { return !this.armableWhy(); }

  // One poll: options re-read, each watched App read, every open attempt judged.
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const raw = await Promise.resolve(this.d.options()).catch(() => null);
      if (raw !== null && raw !== undefined) this.useOptions(raw);
      else this.d.log("the keeper's options can't be read this poll: the last ones read stay in force");
      const now = this.now();
      for (const a of this.open().filter((x) => x.status === "verifying")) this.verifyLeft(a);
      const apps = new Set([...this.opts.watch, ...this.open().map((a) => a.app), ...this.unresolvedOf().map((a) => a.app)]);
      for (const app of apps) await this.pollApp(app);
      await this.tickHeartbeat(now);
      this.arm();
      this.save();
      await this.flush();
      this.arm();
      this.save();
      this.loopDone = this.now();
    } finally { this.busy = false; }
  }

  // -- registration (0.1.3: POST /attempt, Cain's token; 0.1.4: answered only after the backup) ------
  // The body: {token, app, pr, head, from_version, to_version, probe_hash, kind?: "ship" | "drill"}. The
  // token is the owner's Ship token as the link signed it; it is verified here with the pinned key and
  // never kept (only its id, a hash). The keeper always makes the App-only backup itself (0.1.4: a body
  // naming one is refused), and the answer waits until that backup is complete and verified: 200
  // {status: "accepted", id, backup, ...}, or a refusal (the install is then "unprotected", paged).
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
      return { status, body: { status: "refused", why } };
    };
    if (caller !== REGISTRAR) return refuse(`only ${appName(REGISTRAR)}'s App registers installs`, 403);
    const pin = this.st.pinnedKey;
    if (!pin) return refuse(this.opts.ship_public_key ? "ship_public_key isn't an Ed25519 public key" : "ship_public_key isn't set, so no Ship token can be verified");
    if (this.opts.ship_public_key !== pin.key) {
      const fp = shipKey(this.opts.ship_public_key) ? keyFp(this.opts.ship_public_key) : "";
      return refuse(`ship_public_key in the options ${fp ? `(fingerprint ${fp}) ` : ""}isn't the key Keeper pinned (fingerprint ${pin.fp}); a new key counts only once confirmed at the device with key-confirm`);
    }
    const key = shipKey(pin.key);
    if (!key) return refuse("the pinned Ship key can't be read");
    if (!token) return refuse("it carries no Ship token");
    const t = readShipToken(token, key, now);
    if (!t.ok) return refuse(t.why);
    const c = t.claim;
    const issued = (c.exp - SHIP_TTL_S) * 1000;
    if (issued + 1000 <= this.st.createdAt) return refuse("its token was issued before Keeper's state was created (a fresh or restored state can't know which tokens were spent)");
    if (pr !== c.pr || head !== c.head) return refuse(`its pull request or head (${Number.isSafeInteger(pr) ? pr : "?"}, ${head.slice(0, 12) || "?"}) aren't the token's`);
    if (kind !== "ship" && kind !== "drill") return refuse("its kind isn't ship or drill");
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
    const a: Attempt = {
      id, app, from, to, backup: "", deadline: now + INSTALL_MS, issuedAt: issued,
      auth: kind as "ship" | "drill", authHash: tid, pr: c.pr, head: c.head, authExpires: c.exp * 1000,
      probeHash: probe, registeredAt: now, status: "verifying",
      notStarted: 0, healthFails: 0, startedEveryPoll: true, health: [],
    };
    this.st.attempts[id] = a;
    this.st.probeHash[app] = probe;
    this.d.log(`registered ${id} ${app} ${from} to ${to} (pull request ${c.pr}, head ${c.head.slice(0, 12)}): making its backup; the answer waits for it`);
    this.save();
    await this.backupFor(a);
    if (a.status !== "accepted") return { status: 409, body: { status: "refused", id, why: a.why ?? "its backup wasn't accepted" } };
    return { status: 200, body: { status: "accepted", id, app, from_version: from, to_version: to, backup: a.backup, until: new Date(a.deadline).toISOString() } };
  }
  // (0.1.4) The keeper's own backup, made once and awaited (up to REGISTER_WAIT_MS), then verified. A
  // backup that fails, doesn't complete in time, or (after a restart) has an unknown outcome leaves the
  // install unprotected: paged, and the registration's answer is a refusal.
  private async backupFor(a: Attempt): Promise<void> {
    const info = await this.d.appInfo(a.app).catch(() => null);
    if (!info) return this.unprotected(a, `the Supervisor didn't answer for ${a.app}`);
    if (info.version !== a.from) return this.unprotected(a, `${a.app} is at ${info.version}, not ${a.from}`);
    a.backupAsked = this.now();
    this.backups.add(a.id);
    this.save();                                           // asked once, before the call
    const timer = this.d.timer ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as any)?.unref?.(); }));
    const made = this.d.makeBackup(a.app, `Keeper ${a.id}`).catch((e) => ({ why: String((e as Error)?.message ?? e).slice(0, 80) }));
    const res = await Promise.race([made, timer(REGISTER_WAIT_MS).then(() => ({ late: true as const }))]);
    this.backups.delete(a.id);
    if ("late" in res) {
      void made.then((r) => this.d.log(`${a.id}: the keeper's backup ${"slug" in r ? `${r.slug} ` : ""}ended after its registration was refused; it is not used`));
      return this.unprotected(a, `the keeper's backup of ${a.app} didn't complete within ${REGISTER_WAIT_MS / 60_000} minutes`);
    }
    if (!("slug" in res) || !BACKUP.test(res.slug)) return this.unprotected(a, `the keeper's backup of ${a.app} failed (${"why" in res ? res.why : "no backup slug in its answer"})`);
    a.backup = res.slug;
    this.d.log(`${a.id}: the keeper made backup ${res.slug} of ${a.app} alone`);
    let b: BackupInfo | null = null;
    for (let i = 0; i < 3 && !b; i++) b = await this.d.backupInfo(a.backup).catch(() => null);
    if (!b) return this.unprotected(a, "the Supervisor didn't answer for its backup");
    const addons = Array.isArray(b.addons) ? b.addons : [];
    const made_at = typeof b.date === "string" ? Date.parse(b.date) : NaN;
    const why = (b.homeassistant !== null && b.homeassistant !== false && b.homeassistant !== undefined && b.homeassistant !== "") ? "its backup holds Home Assistant"
      : addons.length !== 1 ? `its backup holds ${addons.length} Apps, not ${a.app} alone`
      : addons[0].slug !== a.app ? `its backup holds ${addons[0].slug}, not ${a.app}`
      : Array.isArray(b.folders) && b.folders.length ? "its backup holds folders"
      : addons[0].version !== a.from ? `its backup holds ${a.app} ${addons[0].version}, not ${a.from}`
      : b.protected !== false ? "its backup isn't shown as made without a password (protected false), and the keeper restores only such a backup"
      : !Number.isFinite(made_at) ? "its backup's date can't be read"
      : made_at < (a.issuedAt ?? 0) - BACKUP_DATE_SKEW_MS || made_at < a.registeredAt - BACKUP_DATE_SKEW_MS ? "its backup is dated before the Ship token was issued"
      : null;
    if (why) return this.unprotected(a, why);
    if (a.status !== "verifying") return;                  // the install was seen before the answer: unprotected already
    const now_ = await this.d.appInfo(a.app).catch(() => null);
    if (!now_ || now_.version !== a.from) return this.unprotected(a, now_ ? `${a.app} moved to ${now_.version} while its backup was made` : `the Supervisor didn't answer for ${a.app} after its backup`);
    if ((a.status as Status) !== "verifying") return;
    a.status = "accepted"; a.acceptedAt = this.now();
    this.d.log(`accepting ${a.id} ${a.app} ${a.from} to ${a.to} backup ${a.backup} until ${new Date(a.deadline).toISOString()}`);
    this.save();
  }
  // A registration left verifying by a restart (its backup's outcome unknown) is unprotected.
  private verifyLeft(a: Attempt): void {
    if (this.backups.has(a.id)) return;
    this.unprotected(a, "the keeper restarted while it made the backup, so that backup's outcome is unknown");
  }
  private unprotected(a: Attempt, why: string): void {
    if (a.status === "unprotected") return;
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
    if (info) this.versionChange(app, info.version);
    for (const a of this.open(app)) {
      // (0.1.4) the install seen while its registration still waits for the backup: never accepted
      if (a.status === "verifying" && info?.version === a.to) { this.unprotected(a, "the install began before Keeper accepted it (its backup wasn't complete)"); continue; }
      if (started) a.chat = chat;
      if (a.status === "restoring") { this.observe(a, info); await this.restoring(a, info, live); }
      else if (a.status === "accepted" || a.status === "watching") this.judge(a, info, live, now);
    }
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
    // acceptance covers to_version only once: while accepted, before its consumption.
    const early = recent.find((a) => a.status === "verifying" && a.to === v);
    if (early) { this.d.log(`${app} is at ${v} (was ${was}) before Keeper accepted ${early.id}`); return this.unprotected(early, "the install began before Keeper accepted it (its backup wasn't complete)"); }
    const covered = recent.some((a) => (a.to === v && a.status === "accepted" && !a.consumedAt) || (a.from === v && ["restoring", "rolled back", "gave up", "unresolved"].includes(a.status)));
    if (covered) { this.d.log(`${app} is at ${v} (was ${was})`); return; }
    this.d.log(`unregistered change ${app} ${was} to ${v}: no attempt was registered for it, so nothing is restored`);
    this.owner(app, "unregistered change", `${appName(app)} changed from ${was} to ${v} with no install registered with Keeper. Nothing was rolled back.`, true);
  }
  // live: the App's liveness (/health) this poll. Readiness never enters it.
  judge(a: Attempt, info: AppInfo | null, live: boolean, now: number): void {
    if (info && a.status === "accepted" && info.version === a.to) {
      a.status = "watching"; a.firstSeenTo = now; a.watchEnd = now + WATCH_MS; a.consumedAt = now;
      this.d.log(`consumed ${a.id}: ${a.app} ${a.to} seen; this acceptance is spent and covers no other install`);
      this.d.log(`watching ${a.id}: ${a.app} ${a.to} seen, 15 minutes from now`);
    }
    if (!a.firstStartedTo && now > a.deadline) {
      if (!a.firstSeenTo) {
        a.status = "never started"; a.endedAt = now; a.why = "the install deadline passed without the registered version seen";
        this.d.log(`${a.id}: install never started (${a.app} at ${info?.version ?? "unknown"}, not ${a.to})`);
        this.owner(a.app, "install never started", `${appName(a.app)} ${a.to} never started before its install deadline. Nothing was rolled back.`, true, a.id);
        return;
      }
      return this.fail(a, "deadline", `the install deadline passed with ${a.to} never started`);
    }
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
    a.trigger = { kind, words, at: now };
    a.status = "restoring";
    a.restore = { tries: 0, nextTry: now, limit: now + RESTORE_LIMIT_MS, inflight: false, called: false, job: null };
    this.d.log(`${a.id}: fail (${words}); restoring ${a.app} from backup ${a.backup}`);
    this.owner(a.app, "rolling back", `Keeper is rolling back ${appName(a.app)} from ${a.to} to ${a.from}: ${words}.`, true, a.id);
    this.save();
  }

  // -- the restore (0.1.3) --------------------------------------------------------------------------
  // The in-flight fence is saved before the first call, and the job id from its answer before anything
  // else. A second call goes out only after an answer that proves the first was never accepted: a 4xx
  // before any job, with the Supervisor's jobs list then showing no restore of that backup. A 5xx, a
  // timeout, an unclear answer, or a restart with a call out is unresolved: fenced, reconciled read only.
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
      if (r.refused) return this.afterRefusal(a, now);
      if (r.inflight || r.pending) return this.reconcile(a, info);
      if (now < r.nextTry) return;
      if (now >= r.limit) return this.gaveUp(a, "the Supervisor refused the restore until past its limit (nothing ran: its jobs list showed no restore of the backup)");
      r.inflight = true; r.tries++; r.sentAt = now; r.job = null; r.down = false; delete r.said;
      this.save();                                         // the fence, before the call
      const res: RestoreResult = await this.d.restore(a.backup, a.app).catch((e) => ({ kind: "unknown" as const, why: String((e as Error)?.message ?? e).slice(0, 120) }));
      const t = this.now();
      r.inflight = false;
      if (res.kind === "refused") {
        if (!res.retry) { r.pending = true; return this.gaveUp(a, `the Supervisor refused the restore (${res.why}); it is never sent again`); }
        r.refused = { status: res.status, why: res.why, at: t };
        this.save();
        return this.afterRefusal(a, t);
      }
      r.pending = true;
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
  // A 4xx answer (0.1.4). Without a restore job name recorded by a device drill (state restoreJob), it is
  // unresolved at once: nothing proves the refused call never ran. With one, it is sent again once, only
  // when the jobs list shows no job of exactly that name for the backup and no restore-like job it can't
  // classify (that counts as unreadable: nothing is sent, and it is unresolved at the limit).
  private async afterRefusal(a: Attempt, t: number): Promise<void> {
    const r = a.restore!;
    const ref = r.refused!;
    const rec = this.st.restoreJob;
    if (!rec) { delete r.refused; r.pending = true; return this.unresolved(a, `the Supervisor refused the restore (${ref.why}); no device drill has recorded a restore job's name yet, so Keeper can't show the refused call never ran and sends nothing again`); }
    if (r.resent) { delete r.refused; r.pending = true; return this.unresolved(a, `the Supervisor refused the restore again (${ref.why}); a refused restore is sent again only once`); }
    const n = await this.d.restoreJobs(a.backup, rec.name).catch(() => null);
    if (n === null || n.unclassified > 0) {
      const what = n === null ? "its jobs list couldn't be read" : `its jobs list shows ${n.unclassified} restore-like job${n.unclassified === 1 ? "" : "s"} Keeper can't classify`;
      if (t >= r.limit) { delete r.refused; r.pending = true; return this.unresolved(a, `the Supervisor refused the restore (${ref.why}) and ${what}, so nothing shows it never ran`); }
      return this.say(a, `the Supervisor refused the restore (${ref.why}); ${what}: nothing is sent again until it shows no ${rec.name} job of backup ${a.backup}`);
    }
    delete r.refused;
    if (n.matching > 0) { r.pending = true; return this.unresolved(a, `the Supervisor refused the restore (${ref.why}) but its jobs list shows a ${rec.name} job of backup ${a.backup}`); }
    r.resent = true;
    return this.again(a, `the Supervisor refused the restore before running it (${ref.why}) and its jobs list shows no ${rec.name} job of backup ${a.backup}`, t);
  }
  // (0.1.4) A drill's restore job seen finished without errors records the Supervisor's real restore job
  // name (its reference must be the drill's backup): the only name a later 4xx is checked against.
  private noteJob(a: Attempt, j: JobState | null | undefined): void {
    if (a.auth !== "drill" || !j?.found || !j.done || j.errors !== 0 || !j.name || j.reference !== a.backup) return;
    if (this.st.restoreJob?.name === j.name) return;
    this.st.restoreJob = { name: j.name, attempt: a.id, at: this.now() };
    this.d.log(`drill ${a.id} recorded the Supervisor's restore job name "${j.name}" (reference: its backup): a refused restore may now be sent again once, checked against it`);
    this.save();
  }
  private landed(a: Attempt, t: number, words: string): void {
    const r = a.restore!;
    r.called = true; r.pending = false; r.inflight = false; r.doneAt = t; r.confirmUntil = t + CONFIRM_MS; r.restarts = 0; delete r.lastState; delete r.said;
    this.d.log(`${a.id}: ${words}; confirming ${a.from} comes back started and live for 5 minutes`);
    this.save();
  }
  private again(a: Attempt, why: string, t: number): void {
    const r = a.restore!;
    r.pending = false; r.job = null; delete r.said;
    if (t + this.backoff(r.tries) < r.limit) {
      r.nextTry = t + this.backoff(r.tries);
      this.d.log(`${a.id}: ${why}; the restore is tried again in ${Math.round(this.backoff(r.tries) / 1000)} seconds`);
      this.save();
      return;
    }
    this.gaveUp(a, `${why}, until past its limit`);
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
  backoff(tries: number): number { return Math.min(240_000, POLL_MS * 2 ** Math.max(0, tries - 1)); }
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
  openAttempt(app: string): Attempt | null { return this.open(app).find((a) => a.status === "accepted" || a.status === "watching") ?? null; }
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
  private phoneLapse(why: string): void {
    if (!Object.keys(this.st.phone).length && !this.st.phoneHc) return;
    this.st.phone = {}; delete this.st.phoneHc;
    this.d.log(`the phone test lapsed: ${why}; arming needs a new one (phone-test, then phone-confirm)`);
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
      const base = q.to === "done" ? this.opts.hc_done : q.to === "deadman" ? this.opts.hc_deadman : this.alertUrl(q.app);
      const behind = !q.fail && keep.some((k) => k.app === q.app && k.fail && k.to === q.to);
      const shared = !q.fail && q.to === "failed" && HTTPS.test(base) ? this.incidentOn(base, q.app, keep) : null;
      if (shared && q.next !== -1) { this.d.log(`a success ping for ${q.app} waits: ${shared} shares its alert check and has an incident open`); q.next = -1; }
      if (behind || shared || (q.next > 0 && now < q.next) || !HTTPS.test(base)) { keep.push(q); continue; }
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
      if (q.fail) this.phoneLapse(`a page (${q.kind ?? "a line"}) wasn't delivered to Healthchecks`);
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
    if (now - this.st.hcPinged >= HC_HEARTBEAT_MS && HTTPS.test(this.opts.hc_done)) {
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
      if (!ok) this.phoneLapse("a dead-man page wasn't delivered to Healthchecks");
      return false;
    }
    const ok = await this.d.ping(this.opts.hc_deadman, "keeper alive").catch(() => false);
    if (ok) this.st.deadmanDelivered = this.now();
    return ok;
  }
  loopStalled(now = this.now()): boolean { return now - this.loopDone > LOOP_FRESH_MS; }
  delivered(now = this.now()): boolean { return this.st.hcDelivered > 0 && now - this.st.hcDelivered <= DELIVERY_MS; }

  // -- drills and arming ----------------------------------------------------------------------------
  drillRecord(id: string): { ok: boolean; why: string } {
    const a = this.st.attempts[id];
    const kind: DrillRec["kind"] | null = a?.trigger?.kind === "verdict" ? "fail-verdict"
      : a?.trigger?.kind === "state-error" || a?.trigger?.kind === "not-started" ? "exits-on-start" : null;
    const why = !a ? "no such attempt"
      : a.auth !== "drill" ? "it wasn't a drill"
      : a.status !== "rolled back" ? `it ended ${a.status}, not rolled back`
      : !a.restore?.called || !a.restore.doneAt ? "no restore of its backup ran"
      : !kind ? `its trigger (${a.trigger?.kind ?? "none"}) is neither a FAIL verdict nor an exit on start`
      : !a.lineDelivered ? "its owner line wasn't delivered"
      : a.probeHash !== this.st.probeHash[a.app] ? "a newer registration changed the probe since"
      : null;
    if (why) return { ok: false, why };
    (this.st.drills[a!.app] ??= {})[kind!] = { attempt: a!.id, kind: kind!, trigger: a!.trigger!.words, restoredAt: a!.restore!.doneAt!,
      lineDeliveredAt: this.now(), binding: { ...this.binding(a!.app), probe_hash: a!.probeHash }, at: this.now() };
    a!.drillRecorded = true;
    this.d.log(`drill recorded for ${a!.app}: ${kind} (${a!.id})`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
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
    const why = this.armableWhy();
    if (why) return { ok: false, why: `not armable: ${why}` };
    const busy = this.opts.watch.find((a) => this.st.outstanding[a] || this.open(a).length || this.unresolvedOf(a).length || this.st.queue.some((q) => q.app === a));
    if (busy) return { ok: false, why: `${appName(busy)} has an incident or a line still going out: test the phone once it has cleared` };
    this.st.phone = {}; this.st.phoneHc = hcHash(this.opts);
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
    this.d.log(`phone test sent to the alert check of ${this.opts.watch.join(", ")} and to the dead-man check`);
    this.save();
    return { ok: true, why: "" };
  }
  phoneConfirm(): { ok: boolean; why: string } {
    const now = this.now();
    const done: string[] = [];
    const checks: [string, string][] = [...this.opts.watch.map((app) => [`${app}'s alert check`, this.alertUrl(app)] as [string, string]), ["the dead-man check", this.opts.hc_deadman]];
    for (const [name, u] of checks) {
      const p = this.st.phone[checkId(u)];
      if (p?.deliveredAt && now - p.deliveredAt <= PHONE_WINDOW_MS) { p.confirmedAt = now; done.push(name); }
    }
    if (!done.length) return { ok: false, why: "no phone test page was delivered in the last hour: run keeper phone-test first" };
    this.d.log(`phone test confirmed by the owner for ${done.join(", ")}`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  // (0.1.4) Confirmed within 30 days, under the current Healthchecks options, for the App's alert check
  // and the dead-man check.
  private phoneOk(app: string, now: number): boolean {
    if (this.st.phoneHc !== hcHash(this.opts)) return false;
    return [this.alertUrl(app), this.opts.hc_deadman].every((u) => { const p = this.st.phone[checkId(u)]; return !!p?.confirmedAt && now - p.confirmedAt <= PHONE_MAX_MS; });
  }
  arm(): void {
    const now = this.now();
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
    const why = armable ? `the keeper is not armable: ${armable}`
      : valid.length < 2 ? `no drills on record for ${app} under the current binding`
      : !this.phoneOk(app, now) ? `no phone test drill confirmed for ${app}'s alert check and the dead-man check in the last 30 days, under the current Healthchecks options`
      : !this.delivered(now) ? "no heartbeat ping was delivered to Healthchecks in the last 10 minutes"
      : !this.st.deadmanDelivered || now - this.st.deadmanDelivered > DELIVERY_MS ? "no dead-man ping was delivered to Healthchecks in the last 10 minutes"
      : this.loopStalled(now) ? "Keeper's poll loop hasn't completed in the last 3 minutes"
      : stale.length ? "an alert check's log ping wasn't delivered to Healthchecks in the last 10 minutes"
      : stuck ? "a fail ping has waited undelivered for more than 2 minutes"
      : "";
    return { armed: !why, why, at: valid.length === 2 ? Math.max(...valid.map((r) => r!.at)) : null };
  }
  armedView(app: string): { app: string; armed: boolean; why: string; armed_at: string | null; binding: Binding; keeper_version: string; at: string } {
    const v = this.armedState(app);
    return { app, armed: v.armed, why: v.why, armed_at: v.armed && v.at ? new Date(v.at).toISOString() : null, binding: this.binding(app),
      keeper_version: this.d.version, at: new Date(this.st.heartbeat || this.now()).toISOString() };
  }
}
