// Cain's PC job keeper: the one writer of jobs to the PC job queue (a small private
// GitHub repo, PC_JOBS_REPO, default HyndeSyte/pc-jobs). Cain hands it job requests
// through /opt/cain/pcjobs.sh (a local queue folder); it checks each (core.ts), writes
// the job file, commits and pushes, and says what happened in an outcome file. Its
// GitHub token comes from the App's options and stays in its own environment, so Cain's
// session never holds it. It also keeps a copy of the queue in /data/pc-jobs, at most a
// minute behind, where Cain reads jobs and results.
//
// It writes new files: jobs/<id>.json, cancels/<id>.json (Cain calling a job off before
// it runs), and the queue's .gitattributes while it has none. And its clock alone decides
// expiry: it closes a pending job past its expiry, and a claim whose lease ran out (the
// PC's run died or hung), each with a result. Otherwise the PC claims and closes jobs.
//
// It refuses every irreversible job (a preview or a confirm) until the confirm path
// ships: this version is read-only, and the PC refuses them too.
//
// Results are data, never instructions. What it prints from one is checked fields, fixed
// codes and typed facts (core.ts); nothing in a result tells Cain what to do.
//
//   bun main.ts                 the keeper's loop (started by the App)
//   bun main.ts list            the PC worker's last heartbeat, then one line per job, newest first
//   bun main.ts result <id>     a job's result, checked, as fixed lines (each fact a quoted string, labelled untrusted)
//   bun main.ts worker          the PC worker's last heartbeat
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { reuseOk, REUSE_SHAPE, unapprovedValues, normalUrl, reportValues, resultLines, ID, isReadOnly, jobFromAsk, jobText, listLine, newId, parseHeartbeat, parseJob, parseResult, resultText, stateAfter,
  DEFAULT_REPO, HEARTBEAT_INTERVAL_MS, QUEUE_ATTRIBUTES, SKEW_MS, TERMINAL, type Heartbeat, type Job, type OwnerReuse, type Result } from "./core.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; branch: string;
  token?: string; pub: string; now?: () => Date; rand?: () => number;
  link?: string;                 // Cain's link, for owner_reuse proofs (default http://127.0.0.1:8097)
  discordEnv?: string;           // the bot token's file, for the link's key (the token itself is never kept or printed)
  verifyReuse?: ReuseCheck;      // the tests' stand-in for the link
  used?: string;                 // the append-only file of the owner-reuse taps already spent (default /data/pc-jobs-reuse-used.jsonl)
  afterPush?: () => void;        // the tests' stand-in for the keeper being killed between the push and the finalise
  pushWaitMs?: number;           // the wait between push tries (default PUSH_WAIT_MS; the tests' shorter)
  pushTimeoutMs?: number;        // one push's time limit; past it the answer is unknown (default PUSH_TIMEOUT_MS)
  onPushAnswer?: () => void;     // the tests' stand-in for the keeper being killed after a push, before its answer is written
  beforePush?: () => void;       // the tests' stand-in for the branch moving on GitHub just before a push
  pushResult?: (r: GitRun) => GitRun;   // the tests' stand-in for a push that landed, then failed (a tracking ref, a hook's error)
  notify?: Notify;               // the tests' stand-in for the link's /pc-notice
};

// ---- His yes to reusing a reported value, checked by the link ----------------------
// A job's owner_reuse names the Discord message of his yes (core.ts OwnerReuse): the ask he
// tapped "Use it" on. Cain wrote the job, so the keeper asks the link, which alone hears his
// taps (link/core.ts reuseProof): his recorded tap on the "Use it" button of one of Cain's
// asks that quoted exactly these values when it was posted. A message he typed never counts,
// even one quoting the value: the link refuses it, and so does the keeper, which takes only
// an answer that says "tap". Fail closed: no key, the link down or slow, a refusal, or an
// answer that isn't a plain tap for this message and these values, refuses the job.
export type ReuseCheck = (r: OwnerReuse) => { ok: true; via: string } | { ok: false; why: string };
export const LINK = "http://127.0.0.1:8097";
export const DISCORD_ENV = "/data/.claude/channels/discord/.env";
// The link's answer, read strictly: status ok, this very message, these very values.
export function reuseAnswer(r: OwnerReuse, text: string): { ok: true; via: string } | { ok: false; why: string } {
  let a: any;
  try { a = JSON.parse(text); } catch { return { ok: false, why: "the link didn't answer" }; }
  if (a?.status === "refused" && typeof a.said === "string") return { ok: false, why: `the link says ${a.said.replace(/[\u0000-\u001f]+/g, " ").slice(0, 200)}` };
  if (a?.status !== "ok" || a.message !== r.message_id || a.via !== "tap" || a.ask !== r.message_id
    || !Array.isArray(a.values) || a.values.length !== r.values.length || a.values.some((v: unknown, i: number) => v !== r.values[i]))
    return { ok: false, why: "the link couldn't check it" };
  return { ok: true, via: a.via };
}
// The real check: one POST to the link's /reuse, keyed as keeper.sh keys it, through curl
// (the keeper's round is synchronous). The key and body go in on curl's standard input
// (its config), never on a command line another process could read.
export function linkReuse(cfg: Pick<Config, "link" | "discordEnv">): ReuseCheck {
  return (r) => {
    let tok = "";
    try { tok = readFileSync(cfg.discordEnv ?? DISCORD_ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? ""; } catch { /* none */ }
    if (!tok) return { ok: false, why: "no bot token here, so the link can't be asked" };
    const key = createHmac("sha256", tok).update("harness-relay-v1").digest("hex");
    const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const conf = [`url = ${q(`${cfg.link ?? LINK}/reuse`)}`, `header = ${q(`X-Harness-Key: ${key}`)}`, `header = "Content-Type: application/json"`,
      `data-binary = ${q(JSON.stringify({ m: r.message_id, values: r.values }))}`, `max-time = 40`, `noproxy = "*"`, `silent`].join("\n") + "\n";
    const p = Bun.spawnSync(["curl", "-q", "-K", "-"], { stdin: Buffer.from(conf), stdout: "pipe", stderr: "ignore",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    if (p.exitCode !== 0) return { ok: false, why: "the link didn't answer" };
    return reuseAnswer(r, p.stdout.toString());
  };
}

// ---- The taps already spent on a reuse: an append-only file, written before the push ---------
// One "Use it" tap answers for one job. The keeper keeps every tap it accepted in a file of its
// own outside the queue copy (which is rebuilt from GitHub), one JSON line each, only ever
// appended to and flushed to disk (fsync) line by line, so a keeper restart, a queue copy made
// afresh or a crash at any point doesn't free a tap for a second job.
//
// The evidence rule (0.12.0, nineteenth round): a tap rolls back only on a positive record that
// no push of its job ever succeeded; absence of evidence never frees it.
//   1. Before each push attempt, the keeper appends a pending line naming the commit that attempt
//      will push (the first such line is the tap's pending line; a commit rebased or remade after a
//      non-fast-forward refusal is recorded by the attempt that pushes it).
//   2. After each attempt it appends the remote's answer: ok, refused (with the remote's words), or
//      unknown (a timeout, a broken connection, an answer it can't read).
//   3. Once a push is ok, the tap is finalised (final).
// A pending tap counts as spent. At the start of each round, once the queue copy is brought up to
// date from GitHub (sync), every pending tap is settled against the queue as that fetch gave it:
//   - landed (final): checked first, in this order: any recorded commit is in the fetched branch,
//     any job, report or worker record in the queue names the job id or the request id, or an
//     attempt was answered ok;
//   - rolled back: none of that, and every recorded attempt has a refused answer (git's porcelain
//     "!" line for the exact ref, nothing else) and none is unknown or unanswered; the request,
//     still waiting, is then checked afresh. After a third refused push this is the very next
//     round (within a minute), once its fetch shows none of the recorded commits in the branch;
//   - spent (final, settled "spent"): none of that either (an unknown or missing answer, a branch
//     rewritten, a report pruned): the tap stays used for good, and its request, still waiting, is
//     refused with that reason;
//   - unsettled: a shallow copy, or a git answer that is neither yes nor no: that tap alone stays
//     pending (spent) and its request waits; the round goes on for unrelated requests.
// A pending line without a commit (written by the seventeenth round's keeper) is legacy: it gets
// the same record check (a job, report or worker record naming its job or request: landed, final
// with a migration mark); with no record it is spent, finalised with one migration line, and the
// owner is told once.
// A line without a state (written before the seventeenth round) is final.
// Each stop condition (a shallow copy, a missing branch, an empty remote with a pending tap, an
// unreadable store, a tap that can't be settled, a push refused on every try) posts the owner one
// Discord line through the link, naming it and the recovery step (cain/docs/pc-jobs.md,
// Troubleshooting), at most once while it lasts (the notice file beside the store, below).
// The file's folder is flushed to disk (fsync) too whenever the file or a folder above it is
// made, so the file's own entry survives a power cut; the file is only appended to, never
// renamed or rewritten. A folder that can't be flushed throws (the round stops before the push),
// except on Windows, where a folder can't be opened to flush (the Pi runs Linux).
export const USED_REUSE = "/data/pc-jobs-reuse-used.jsonl";
export const PUSH_TRIES = 3;
export const PUSH_WAIT_MS = 2_000;
export const PUSH_TIMEOUT_MS = 60_000;
export type ReuseState = "pending" | "final" | "rolled_back";
export type PushAnswer = "ok" | "refused" | "unknown";
export interface PushAttempt { commit: string; answer?: PushAnswer; said?: string }
export interface ReuseLine { m: string; job: string; state: ReuseState; rid?: string; commit?: string; attempts: PushAttempt[]; legacy: boolean; settled?: string;
  site?: string; action?: string }       // what the job does, for the owner's line (twenty-second round: never its id)
const COMMIT = /^[0-9a-f]{40}$/;
export class StoreUnreadable extends Error {}
// Every tap's latest state, by message id, with every push attempt recorded for its job.
// A store that exists but can't be read throws StoreUnreadable (never read as empty).
export function reuseLedger(cfg: Pick<Config, "used">): Map<string, ReuseLine> {
  const out = new Map<string, ReuseLine>();
  let text = "";
  try { text = readFileSync(cfg.used ?? USED_REUSE, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw new StoreUnreadable(`the used-tap store can't be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  for (const l of text.split("\n")) {
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }                                    // a torn line
    if (typeof o?.m !== "string" || typeof o?.job !== "string") continue;
    const state: ReuseState = o.state === undefined ? "final" : o.state;
    if (!["pending", "final", "rolled_back"].includes(state)) continue;
    const commit = typeof o.commit === "string" && COMMIT.test(o.commit) ? o.commit : undefined;
    const rid = typeof o.rid === "string" ? o.rid : undefined;
    const cur = out.get(o.m);
    const same = cur && cur.state === "pending" && cur.job === o.job;
    const what = typeof o.site === "string" && typeof o.action === "string" ? { site: o.site, action: o.action } : cur?.job === o.job && cur.site && cur.action ? { site: cur.site, action: cur.action } : {};
    if (state === "pending" && same && o.ev === "answer") {
      const a = cur!.attempts.at(-1);
      if (a && !a.answer && ["ok", "refused", "unknown"].includes(o.answer)) { a.answer = o.answer; if (typeof o.said === "string") a.said = o.said; }
      continue;
    }
    if (state === "pending" && same && o.ev === "push" && commit) { cur!.attempts.push({ commit }); cur!.commit ??= commit; Object.assign(cur!, what); continue; }
    if (state === "pending") {
      out.set(o.m, { m: o.m, job: o.job, state, ...(rid ? { rid } : {}), ...(commit ? { commit } : {}), attempts: commit ? [{ commit }] : [], legacy: !commit, ...what });
      continue;
    }
    out.set(o.m, { m: o.m, job: o.job, state, ...(rid ? { rid } : {}), ...(cur?.job === o.job && cur.commit ? { commit: cur.commit } : commit ? { commit } : {}),
      attempts: cur?.job === o.job ? cur.attempts : [], legacy: false, ...(typeof o.settled === "string" ? { settled: o.settled } : {}), ...what });
  }
  return out;
}
// The taps spent (pending or final), with the job each answered for.
export function usedReuse(cfg: Pick<Config, "used">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [m, l] of reuseLedger(cfg)) if (l.state !== "rolled_back") out.set(m, l.job);
  return out;
}
// A folder's entries flushed to disk.
export function fsyncDir(d: string, plat = process.platform): void {
  if (plat === "win32") return;
  const fd = openSync(d, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// One line, appended and flushed to disk before it returns; it throws when it can't be.
function appendLine(cfg: Pick<Config, "used">, o: Record<string, unknown>): void {
  const f = cfg.used ?? USED_REUSE;
  const fresh = !existsSync(f);
  // The folders made for it, outermost first: each one's parent is flushed once it holds them.
  const made: string[] = [];
  for (let d = dirname(f); !existsSync(d) && dirname(d) !== d; d = dirname(d)) made.unshift(d);
  mkdirSync(dirname(f), { recursive: true });
  const fd = openSync(f, "a");
  try { writeSync(fd, JSON.stringify(o) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  if (fresh) { for (const d of made) fsyncDir(dirname(d)); fsyncDir(dirname(f)); }
}
export function recordReuse(cfg: Pick<Config, "used">, m: string, job: string, state: ReuseState = "final", rid?: string, commit?: string, extra: Record<string, string> = {}): void {
  appendLine(cfg, { m, job, state, ...(rid ? { rid } : {}), ...(commit ? { commit } : {}), ...extra });
}
// One push attempt of a tap's job: the commit it will push (before), and the remote's answer (after).
export type Tap = { m: string; job: string; rid: string; site?: string; action?: string };
export function recordAttempt(cfg: Pick<Config, "used">, t: Tap, commit: string): void {
  appendLine(cfg, { m: t.m, job: t.job, state: "pending", rid: t.rid, ev: "push", commit, ...(t.site && t.action ? { site: t.site, action: t.action } : {}) });
}
export function recordAnswer(cfg: Pick<Config, "used">, t: Tap, answer: PushAnswer, said?: string): void {
  appendLine(cfg, { m: t.m, job: t.job, state: "pending", rid: t.rid, ev: "answer", answer, ...(said ? { said: said.slice(0, 300) } : {}) });
}

// ---- One line to the owner, through the link, once while its condition lasts --------------
// The keeper sends only a code; the link posts its own fixed words for it (link/core.ts
// PC_NOTICES), so nothing from the queue reaches Discord. Delivery and persistence (0.12.0,
// twentieth round):
//   - which notices went out lives in a small file of its own beside the tap store,
//     `<store>.told.json` (default /data/pc-jobs-reuse-used.jsonl.told.json), never in the store
//     itself, so an unreadable store doesn't lose it and the store stays append-only; it is a
//     JSON list of keys, written whole to a temporary file and renamed;
//   - a notice is marked sent only once the link acknowledges the post (its answer says
//     "posted"); no answer, a refusal or an error leaves it unmarked, so the next round tries again;
//   - a mark is removed when its condition is seen clear (the store read, the branch back, the tap
//     settled), so the condition coming back is told again;
//   - a notice file that can't be read counts as nothing told (a notice may then go out again,
//     never be lost).
//   - twenty-first round: a mark is removed only once its condition has been seen clear for
//     CLEAR_ROUNDS (3) rounds in a row (a flapping condition is told once); every notice carries a
//     notice id, kept with its key before the post, so a post whose acknowledgement was lost is sent
//     again with the same id and the link, which deduplicates on it, doesn't post it twice;
//   - twenty-first round: two waits are bounded with a notice: a legacy pending line whose record
//     can't be read, and a third-refusal settle whose round couldn't fetch from GitHub. After
//     WAIT_ROUNDS (3) such rounds for one tap, a once-only notice names the job and the code. The legacy
//     line's notice was told at once before (reuse_unsettled); it became this third-round notice;
//   - twenty-second round: the notice names the job by what it does (its site and action), never by its
//     queue id, and the notice id stays in the payload, never in the words; a mark whose post was never
//     acknowledged is never cleared: it is sent again with its saved id until the link answers posted;
//     a round that can't fetch and can't read the tap store counts toward the store's own notice
//     (reuse_store_unreadable, after three such rounds).
//   - twenty-third round: a one-time migration (notice file version 3) gives every mark of an earlier keeper
//     its code: the per-record marks (record:<tap>, fetch:<tap>, ...) by their key's prefix, with the job read
//     back from the tap ledger; a mark never posted whose code can't be told goes out as notice_undelivered
//     ("an earlier notice could not be delivered") and is logged, never a silent orphan. Each round first sends
//     every mark still owed (resendOwed), whatever its key. A permanent refusal by the link (its answer
//     "refused", a client error other than already posted) is capped: the mark is kept as refused, never
//     sent again, logged loudly, and shown on the keeper's status (pcjobs.sh worker and list, noticeTrouble);
//   - twenty-third round: every caller names the job by its site and action, or, when the keeper can't say
//     them, by when it was queued ({queued}: the job's created time, else the day in its id); the link words
//     that "a PC browser job seen by the keeper at ..." (twenty-fifth round wording). A job given any other way (a string, a queue id) is a bug: logged
//     as an error, and the notice still goes, named by when it was queued where the id says so.
//   - twenty-seventh round: hold_clear_unrecorded, told while the PC worker's heartbeat says a version hold clear was
//     refused because its record couldn't be written (holdClearNotice), under the same once-per-round rules; every mark
//     keeps when it was first made (since), so the attention line gives the age of the oldest notice still owed, and
//     rounds in a row with no answer at all from the link are counted (silent) and, past SILENT_ROUNDS, shown on the
//     keeper's own status as a local escalation (never through the link).
//   - twenty-seventh round, delivery across a restart: the per-round attempted set lives in the keeper's memory only. A
//     keeper restarted mid-round starts a new round, so a mark tried just before the restart is tried once more after
//     it: delivery is at least once, and the retry carries the mark's saved notice id, on which the link deduplicates,
//     so the owner never sees it twice.
export type PcNotice = "reuse_migrated" | "reuse_shallow" | "queue_branch_missing" | "queue_empty_pending" | "reuse_store_unreadable" | "reuse_unsettled" | "reuse_push_refused"
  | "reuse_record_unreadable" | "reuse_fetch_failed" | "notice_undelivered" | "hold_clear_unrecorded" | "worker_start_refused" | "worker_not_starting" | "worker_not_starting_unconfirmed" | "queue_unreachable" | "queue_unreachable_again";
const PC_NOTICE_CODES: readonly PcNotice[] = ["reuse_migrated", "reuse_shallow", "queue_branch_missing", "queue_empty_pending", "reuse_store_unreadable", "reuse_unsettled",
  "reuse_push_refused", "reuse_record_unreadable", "reuse_fetch_failed", "notice_undelivered", "hold_clear_unrecorded", "worker_start_refused", "worker_not_starting", "worker_not_starting_unconfirmed", "queue_unreachable", "queue_unreachable_again"];
// The job a notice is about, by what it does (twenty-second round): its site and action, never its id; or,
// when those can't be told (twenty-third round), when it was queued.
export type JobWhat = { site: string; action: string } | { queued: string };
// repeat (twenty-eighth round): the notice was re-minted with a new id because its first id may have outlived the
// link's record of the ids it posted (NOTICE_DEDUP_MS), so the link words it as a repeat.
export interface NoticeSend { id: string; job?: JobWhat; repeat?: true }
// What the link answered: true (posted, or already posted), false (no answer or a passing error: try again),
// "refused" (a permanent refusal: never sent again), and (twenty-fourth round) "config" (401 or 403: the link
// won't take the keeper's key or setup: no more sends this process, shown on the status) or "server" (a 5xx:
// retried with backoff, counted on the status).
// Twenty-sixth round: "http", an HTTP answer from the link that is none of those (try again). false is reserved for no
// answer at all (the link unreachable, a timeout, no key to send with): only a definitive HTTP answer other than 401
// or 403 clears the keeper's configuration refusal.
export type NoticeAnswer = boolean | "refused" | "config" | "server" | "http";
export type Notify = (code: PcNotice, n?: NoticeSend) => NoticeAnswer;
export const CLEAR_ROUNDS = 3;
export const WAIT_ROUNDS = 3;
// A mark keeps its code and job (twenty-second round), so a post whose acknowledgement was lost is sent
// again with its saved id until the link confirms it, whether or not its condition is still here.
// fails: server errors in a row; skip: rounds still to wait before the next try (twenty-fourth round, the backoff).
// (The twenty-fourth round's per-mark config flag is read once into the file's own config, below, and dropped.)
// minted (twenty-eighth round): when the mark's current id was made, if not at since; repeat: the id was re-minted.
interface ToldMark { id: string; posted: boolean; clear: number; code?: PcNotice; job?: JobWhat; refused?: boolean; fails?: number; skip?: number; since?: string; minted?: string; repeat?: true }
// Twenty-fourth round, kept for this process: the link refused the keeper's key or setup (no more sends until the
// keeper starts again), and whether the notice file's upgrade couldn't be saved (logged once, shown on the status).
let configStopped = false;
let migrationUnsaved = false;
export const SERVER_FAILS_SHOWN = 3;
export const BACKOFF_MAX_ROUNDS = 32;
export function resetNoticeProcess(): void { configStopped = false; migrationUnsaved = false; silentCounted = false; answeredThisRound = false; }
// config (twenty-fifth round): the link refused the keeper's key or setup (401 or 403), kept in the notice file as
// delivery state for the whole keeper, not on the one mark that got the answer: every mark still owed stays owed
// (pending, never flagged or dropped), the status line counts them all from this file, and the flag goes only once
// the link answers a send with anything else (after the fix and a restart, when sends start again).
// fetchFails (twenty-ninth round): the queue's fetch failing in rounds in a row, counted on its own, whatever the sends do.
// 0.12.2: kept while the queue-unreachable notice stands, so a good fetch between failures doesn't end it (queueFetch);
// queueBack: when that notice last cleared, so one raised again within QUEUE_AGAIN_MS is worded as coming back.
// quietPending (0.12.2, fourth pass): a worker-not-starting condition held back (a heartbeat that looked fresh, or the
// queue's fetch failing): since when, and the jobs it is for. Kept across restarts until a job is acknowledged, or told.
// held (0.12.2, seventh pass): per held job, when it was held (the keeper's clock) and the queue time it had then, so a
// heartbeat stamped before the hold, or a requeued job under the same id, never clears it.
// beat (0.12.2, eighth pass): the PC worker's heartbeat as the keeper last saw it (key, a hash of its fields) and when it
// arrived by the keeper's own clock (seen); null when it was first seen with no earlier record (an upgrade, a new notice
// file), so a heartbeat already there never counts as arriving after anything.
interface QuietPending { since: string; jobs: string[]; held?: Record<string, { at: string; created: string }> }
interface Beat { key: string; seen: string | null }
interface Told { told: Record<string, ToldMark>; waits: Record<string, number>; config?: true; silent?: number; fetchFails?: number; queueBack?: string; quietPending?: QuietPending; beat?: Beat }
export const SILENT_ROUNDS = 30;
// Twenty-eighth round, the bound on exactly-once display: the link remembers the notice ids it posted for
// PC_NOTICE_RETAIN_MS (link/core.ts, 30 days). A mark still owed whose id is older than that is re-minted before its
// next send (a new id, sent as a repeat, which the link words as one), so a post whose acknowledgement was lost long
// ago is never shown twice as if new. Twenty-ninth round: a mark whose age isn't known (no minted or since time) is taken
// as past the retention and re-minted once, its mint time stamped then.
export const NOTICE_DEDUP_MS = 30 * 86_400_000;
const toldFile = (cfg: Pick<Config, "used">) => `${cfg.used ?? USED_REUSE}.told.json`;
const NOTICE_ID = /^[0-9a-f]{16,64}$/;
const SITE = /^(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const ACTION = /^[a-z][a-z0-9_]{2,39}$/;
const QUEUED = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const jobWhat = (x: any): JobWhat | undefined =>
  !x || typeof x !== "object" || Array.isArray(x) ? undefined
    : typeof x.site === "string" && typeof x.action === "string" && SITE.test(x.site) && ACTION.test(x.action) ? { site: x.site, action: x.action }
    : typeof x.queued === "string" && QUEUED.test(x.queued) && Number.isFinite(Date.parse(x.queued.length === 10 ? `${x.queued}T00:00:00Z` : x.queued)) ? { queued: x.queued }
    : undefined;
const isCode = (x: unknown): x is PcNotice => typeof x === "string" && (PC_NOTICE_CODES as readonly string[]).includes(x);
// An earlier keeper's mark key, by its prefix (or the whole key), to its code.
const KEY_CODES: Record<string, PcNotice> = { record: "reuse_record_unreadable", fetch: "reuse_fetch_failed", migrated: "reuse_migrated", shallow: "reuse_shallow",
  unsettled: "reuse_unsettled", refused: "reuse_push_refused", store: "reuse_store_unreadable", empty: "queue_empty_pending", branch: "queue_branch_missing" };
const codeOfKey = (k: string): PcNotice | undefined => isCode(k) ? k : KEY_CODES[k.split(":")[0]];
// The notice file as read: version 3; version 2 ({v, told, waits}) or the twentieth round's list of keys (each
// read as posted, with a fresh id) are migrated once (migrateTold) and written back as version 3.
// Unreadable: nothing told, no waits.
function readTold(cfg: Pick<Config, "used"> & Partial<Pick<Config, "queue" | "dir">>): Told {
  let a: any;
  try { a = JSON.parse(readFileSync(toldFile(cfg), "utf8")); } catch { return { told: {}, waits: {} }; }
  if (Array.isArray(a)) {
    const t: Told = { told: Object.fromEntries(a.filter((x) => typeof x === "string").map((k) => [k, { id: newNoticeId(), posted: true, clear: 0, ...(codeOfKey(k) ? { code: codeOfKey(k)! } : {}) }])), waits: {} };
    saveTold(cfg, t);
    return t;
  }
  const told: Record<string, ToldMark> = {}, waits: Record<string, number> = {};
  let config = a && typeof a === "object" && a.config === true;
  if (a && typeof a === "object" && a.told && typeof a.told === "object")
    for (const [k, m] of Object.entries(a.told as Record<string, any>))
      if (m && typeof m.id === "string" && NOTICE_ID.test(m.id)) {
        if (m.config === true && m.posted !== true) config = true;          // the twenty-fourth round's per-mark flag
        const code = isCode(m.code) ? m.code : undefined;
        const job = jobWhat(m.job);
        const n = (v: unknown) => Number.isInteger(v) && (v as number) > 0 ? { v: v as number } : null;
        told[k] = { id: m.id, posted: m.posted === true, clear: Number.isInteger(m.clear) && m.clear >= 0 ? m.clear : 0, ...(code ? { code } : {}), ...(job ? { job } : {}),
          ...(m.refused === true ? { refused: true } : {}), ...(typeof m.since === "string" && Number.isFinite(Date.parse(m.since)) ? { since: m.since } : {}),
          ...(typeof m.minted === "string" && Number.isFinite(Date.parse(m.minted)) ? { minted: m.minted } : {}), ...(m.repeat === true ? { repeat: true as const } : {}),
          ...(n(m.fails) ? { fails: n(m.fails)!.v } : {}), ...(n(m.skip) ? { skip: Math.min(n(m.skip)!.v, BACKOFF_MAX_ROUNDS) } : {}) };
      }
  if (a && typeof a === "object" && a.waits && typeof a.waits === "object")
    for (const [k, n] of Object.entries(a.waits as Record<string, unknown>)) if (Number.isInteger(n) && (n as number) > 0) waits[k] = n as number;
  const t: Told = { told, waits, ...(config ? { config: true as const } : {}), ...(Number.isInteger(a?.silent) && a.silent > 0 ? { silent: a.silent } : {}),
    ...(Number.isInteger(a?.fetchFails) && a.fetchFails > 0 ? { fetchFails: a.fetchFails } : {}),
    ...(typeof a?.queueBack === "string" && Number.isFinite(Date.parse(a.queueBack)) ? { queueBack: a.queueBack } : {}),
    ...(quietPendingOf(a?.quietPending) ? { quietPending: quietPendingOf(a.quietPending)! } : {}),
    ...(beatOf(a?.beat) ? { beat: beatOf(a.beat)! } : {}) };
  if (a?.v !== 3) {
    migrateTold(cfg, t);
    if (!saveTold(cfg, t, true)) {
      if (!migrationUnsaved) log(`ERROR: the notice file's one-time upgrade couldn't be saved (${toldFile(cfg)}): it is tried again each round, and notices still go; the keeper's status shows it`);
      migrationUnsaved = true;
    } else migrationUnsaved = false;
  }
  return t;
}
// The one-time migration of an earlier keeper's marks (twenty-third round): each gets its code from its key;
// a tap's mark gets its job from the tap ledger (what it does, else when it was queued). A mark never posted
// whose code can't be told becomes notice_undelivered, logged, so it is still sent (resendOwed).
function migrateTold(cfg: Pick<Config, "used"> & Partial<Pick<Config, "queue" | "dir">>, t: Told): void {
  let ledger: Map<string, ReuseLine> | null = null;
  try { ledger = reuseLedger(cfg); } catch { ledger = null; }
  for (const [k, m] of Object.entries(t.told)) {
    if (!m.code) {
      const c = codeOfKey(k);
      if (c) m.code = c;
      else if (!m.posted) { m.code = "notice_undelivered"; log(`error: an earlier keeper's notice (${k.replace(/[^\w:.-]/g, "?").slice(0, 60)}) was never delivered and its code can't be told: sending the generic line that an earlier notice could not be delivered`); }
    }
    const tap = k.includes(":") ? ledger?.get(k.slice(k.indexOf(":") + 1)) : undefined;
    if (!m.job && tap && m.code !== "notice_undelivered") { const w = cfg.queue !== undefined && cfg.dir !== undefined ? whatOf(cfg as Config, tap) : jobWhat(tap) ?? queuedOf(cfg, tap.job); if (w) m.job = w; }
  }
}
const newNoticeId = () => randomBytes(12).toString("hex");
// A held worker-not-starting condition as the notice file keeps it; a garbled one with a readable time keeps its time
// (its deadline still runs), with no jobs, so it is told at its deadline.
function quietPendingOf(x: any): QuietPending | null {
  if (!x || typeof x !== "object" || typeof x.since !== "string" || !Number.isFinite(Date.parse(x.since))) return null;
  const jobs: string[] = Array.isArray(x.jobs) ? x.jobs.filter((j: unknown): j is string => typeof j === "string").slice(0, 200) : [];
  const held: Record<string, { at: string; created: string }> = {};
  if (x.held && typeof x.held === "object" && !Array.isArray(x.held))
    for (const k of jobs) {
      const v = x.held[k];
      if (v && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) && typeof v.created === "string") held[k] = { at: v.at, created: v.created };
    }
  return { since: x.since, jobs, ...(Object.keys(held).length ? { held } : {}) };
}
// The heartbeat arrival record as the notice file keeps it, or null.
function beatOf(x: any): Beat | null {
  if (!x || typeof x !== "object" || typeof x.key !== "string" || !/^[0-9a-f]{16,64}$/.test(x.key)) return null;
  return { key: x.key, seen: typeof x.seen === "string" && Number.isFinite(Date.parse(x.seen)) ? x.seen : null };
}
// Twenty-fifth round: written only when its content changes (a round that only finds the same marks still owed
// leaves the file alone), and then whole: a temporary file, then renamed into place.
function saveTold(cfg: Pick<Config, "used">, t: Told, quiet = false): boolean {
  const text = JSON.stringify({ v: 3, told: t.told, waits: t.waits, ...(t.config ? { config: true } : {}), ...(t.silent ? { silent: t.silent } : {}), ...(t.fetchFails ? { fetchFails: t.fetchFails } : {}), ...(t.queueBack ? { queueBack: t.queueBack } : {}), ...(t.quietPending ? { quietPending: t.quietPending } : {}), ...(t.beat ? { beat: t.beat } : {}) });
  try { if (readFileSync(toldFile(cfg), "utf8") === text) return true; } catch { /* not there yet, or unreadable: written */ }
  try {
    mkdirSync(dirname(toldFile(cfg)), { recursive: true });
    writeFileSync(`${toldFile(cfg)}.tmp`, text);
    renameSync(`${toldFile(cfg)}.tmp`, toldFile(cfg));
    return true;
  } catch (e) { if (!quiet) log(`couldn't keep which notices went out: ${(e as Error).message}`); return false; }
}
// One send of a mark, with its saved id: "posted" once the link confirms it posted (or had already posted it),
// "refused" on a permanent refusal (logged loudly, never sent again), "retry" otherwise.
// Twenty-fourth round: a mark waiting out its backoff is not sent this round (its skip counted down); once the link
// refused the keeper's key or setup (401 or 403), nothing more is sent this process; a 5xx answer doubles the wait
// (the next 0, 1, 3, 7, 15, 31 tries skipped, then 31 each time: BACKOFF_MAX_ROUNDS - 1) and is counted; any other
// answer resets both. Twenty-fifth round: the configuration refusal is the notice file's own state (t.config), so
// every owed mark counts on the status, and it clears only when the link answers a send with anything else.
function send(cfg: Config, t: Told, m: ToldMark, code: PcNotice): "posted" | "retry" | "refused" {
  if (configStopped) return "retry";
  if (m.skip && m.skip > 0) { m.skip -= 1; return "retry"; }
  // Twenty-eighth round: an id older than the link's record of posted ids is re-minted, and the notice goes as a repeat.
  // Twenty-ninth round: an unknown age (a mark from before the age was kept, with no minted or since time) counts as
  // past that retention: it is re-minted once as a repeat, and its mint time stamped then is what later renewals use.
  // 0.12.2: the new id and its mint time are kept in the notice file before the send; if that write fails, the mark
  // keeps its old id and nothing is sent this round (a send under an id the file doesn't hold could be shown twice).
  const born = Date.parse(m.minted ?? m.since ?? "");
  if (!Number.isFinite(born) || Date.now() - born > NOTICE_DEDUP_MS) {
    const was = { id: m.id, minted: m.minted, repeat: m.repeat };
    m.id = newNoticeId(); m.minted = new Date().toISOString(); m.repeat = true;
    if (!saveTold(cfg, t)) {
      m.id = was.id;
      if (was.minted === undefined) delete m.minted; else m.minted = was.minted;
      if (was.repeat === undefined) delete m.repeat; else m.repeat = was.repeat;
      log(`ERROR: notice ${code} needs a new id (owed longer than the link remembers posted notices, or of unknown age), but the new id couldn't be kept in the notice file (${toldFile(cfg)}): it isn't sent this round, and is tried again next round`);
      return "retry";
    }
    log(`notice ${code} was owed ${Number.isFinite(born) ? "longer than the link remembers posted notices" : "since before its age was kept, so possibly longer than the link remembers posted notices"}: it goes again under a new id, worded as a repeat`);
  }
  let a: NoticeAnswer = false;
  let job = m.job === undefined ? undefined : jobWhat(m.job);
  if (m.job !== undefined && !job) { log(`error: notice ${code} carries a job that isn't a site and action or a queued time: named by the time instead`); job = m.job = queuedNow(); }
  try { a = (cfg.notify ?? linkNotify(cfg))(code, { id: m.id, ...(job ? { job } : {}), ...(m.repeat ? { repeat: true as const } : {}) }); } catch { a = false; }
  if (a === false) {
    // Twenty-seventh round: one more round with no answer at all from the link, counted once a round.
    silentRound(t);
    log(`couldn't tell the owner (${code}): the link didn't answer; trying again next round, with the same notice id`);
    return "retry";
  }
  answeredThisRound = true;
  delete t.silent;
  if (a === "config") {
    configStopped = true;
    t.config = true;
    log(`ERROR: the link refused the keeper's notice ${code} as not allowed (HTTP 401 or 403: its key or setup): no more notices are sent until the keeper starts again; the keeper's status shows it`);
    return "retry";
  }
  delete t.config;
  if (a === "server") {
    m.fails = (m.fails ?? 0) + 1;
    m.skip = Math.min(2 ** (m.fails - 1), BACKOFF_MAX_ROUNDS) - 1;
    log(`couldn't tell the owner (${code}): the link answered with a server error (${m.fails} in a row); the next ${m.skip} tr${m.skip === 1 ? "y is" : "ies are"} skipped, then it goes again with the same notice id`);
    return "retry";
  }
  delete m.fails; delete m.skip;
  if (a === "refused") {
    log(`ERROR: the link refused notice ${code} for good (not a passing error): it won't be sent again; the keeper's status shows it until its condition clears`);
    return "refused";
  }
  if (a !== true) { log(`couldn't tell the owner (${code}): the link answered without posting it; trying again next round, with the same notice id`); return "retry"; }
  return "posted";
}
// The fallback name of a job the keeper was handed in a shape it can't read (twenty-fourth round): the time the
// keeper noticed it, to the minute, worded by the link as "a PC browser job seen by the keeper at <time>". Never a bare line.
const queuedNow = (): JobWhat => ({ queued: new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00Z") });
// The job a caller passed, checked (twenty-third round): a site and action, or a queued time. A string (a queue
// id, or anything else) is a bug: logged as an error, named by when it was queued where the id says so.
function checkedJob(cfg: Pick<Config, "used"> & Partial<Pick<Config, "dir">>, code: PcNotice, job: unknown): JobWhat | undefined {
  if (job === undefined || job === null) return undefined;
  const w = jobWhat(job);
  if (w) return w;
  log(`error: notice ${code} was given its job ${typeof job === "string" ? "as a string" : "in a shape that isn't a site and action"}: a bug in the keeper; the notice goes, named by when its job was queued where that can be told, else by the time now`);
  return (typeof job === "string" && ID.test(job) ? queuedOf(cfg, job) : undefined) ?? queuedNow();
}
// The condition is here this round: told once (its id kept before the post), and its clear count reset.
export function tell(cfg: Config, code: PcNotice, key: string = code, job?: JobWhat): void {
  const t = readTold(cfg);
  let m = t.told[key];
  if (m?.posted || m?.refused) { if (m.clear) { m.clear = 0; saveTold(cfg, t); } return; }
  // Twenty-fifth round: one try per mark per round. A mark resendOwed already tried (or counted down) this round
  // isn't sent again by the condition's own tell, so the backoff counts rounds, not calls.
  // Twenty-sixth round: the same attempted set for every path (resend, tell, cleared), recorded before the send, so a
  // mark the direct tell made and sent isn't tried again by a second tell or the resend in the same round.
  if (m && triedThisRound.has(`${toldFile(cfg)}\0${key}`)) { if (m.clear) { m.clear = 0; saveTold(cfg, t); } return; }
  const what = checkedJob(cfg, code, job);
  if (!m) { m = t.told[key] = { id: newNoticeId(), posted: false, clear: 0, code, ...(what ? { job: what } : {}), since: new Date().toISOString() }; saveTold(cfg, t); }
  triedThisRound.add(`${toldFile(cfg)}\0${key}`);
  m.clear = 0;
  m.code ??= code;
  if (!m.job && what) m.job = what;
  const a = send(cfg, t, m, m.code);
  if (a === "posted") m.posted = true;
  if (a === "refused") m.refused = true;
  saveTold(cfg, t);
}
// Every mark still owed (never acknowledged, never refused), whatever its key: sent again with its saved id,
// once per round, so no mark is left unsent because no round looks at its key any more.
// A mark acknowledged by this round's resend starts its clear count only at the next round, as when cleared sends it.
const ackedThisRound = new Set<string>();
const triedThisRound = new Set<string>();
// A new round of the keeper (twenty-sixth round, named): the attempted and acknowledged sets start empty. resendOwed
// starts one unless told it runs inside a round already started (fresh false).
let silentCounted = false;
let answeredThisRound = false;
export function noticeRound(): void { ackedThisRound.clear(); triedThisRound.clear(); silentCounted = false; answeredThisRound = false; }
// Twenty-eighth round: a silent round is one in which any contact the keeper makes (a send to the link, or the queue's
// fetch) gets no answer and no send got one; counted once a round, whichever contact found it.
function silentRound(t: Told): boolean {
  if (silentCounted || answeredThisRound) return false;
  silentCounted = true; t.silent = (t.silent ?? 0) + 1;
  return true;
}
export function fetchUnanswered(cfg: Config): void {
  const t = readTold(cfg);
  if (silentRound(t)) saveTold(cfg, t);
  queueFetch(cfg, false);
}
// Twenty-ninth round, the queue unreachable: the fetch's failures counted as their own streak, independent of whether
// any send was answered (the silent-round rule lets a queue that stays unreachable go unescalated while the link still
// answers some notice). After FETCH_FAIL_ROUNDS failed fetches in a row, an owed queue_unreachable notice goes to the
// owner through the link, under the usual mark rules (told once, cleared after three rounds with a fetch that worked).
// 0.12.2, hysteresis: once raised, the notice clears only after QUEUE_CLEAR_FETCHES good fetches in a row (the mark's
// CLEAR_ROUNDS clear rounds), and the failure streak is kept until then, so one good fetch between failures neither
// drops the notice nor starts a fresh one. Raised again within QUEUE_AGAIN_MS of clearing, it goes as
// queue_unreachable_again, which the link words as the queue being unreachable again.
export const FETCH_FAIL_ROUNDS = 30;
export const QUEUE_CLEAR_FETCHES = CLEAR_ROUNDS;
export const QUEUE_AGAIN_MS = 24 * 3_600_000;
export const QUEUE_UNREACHABLE_KEY = "queueunreachable";
export function queueFetch(cfg: Config, ok: boolean): void {
  const t = readTold(cfg);
  if (ok) {
    const had = !!t.told[QUEUE_UNREACHABLE_KEY];
    cleared(cfg, QUEUE_UNREACHABLE_KEY);
    const after = readTold(cfg);
    let changed = false;
    if (had && !after.told[QUEUE_UNREACHABLE_KEY]) { after.queueBack = new Date().toISOString(); changed = true; }
    if (after.fetchFails && !after.told[QUEUE_UNREACHABLE_KEY]) { delete after.fetchFails; changed = true; }
    if (changed) saveTold(cfg, after);
    return;
  }
  t.fetchFails = (t.fetchFails ?? 0) + 1;
  saveTold(cfg, t);
  if (t.fetchFails >= FETCH_FAIL_ROUNDS) {
    const back = Date.parse(t.queueBack ?? "");
    const again = !t.told[QUEUE_UNREACHABLE_KEY] && Number.isFinite(back) && Date.now() - back <= QUEUE_AGAIN_MS;
    if (again) tell(cfg, "queue_unreachable_again", QUEUE_UNREACHABLE_KEY);
    else tell(cfg, "queue_unreachable", QUEUE_UNREACHABLE_KEY);
  }
}
export function resendOwed(cfg: Config, fresh = true): void {
  if (fresh) noticeRound();
  const t = readTold(cfg);
  let changed = false;
  for (const [k, m] of Object.entries(t.told)) {
    if (m.posted || m.refused || !m.code || triedThisRound.has(`${toldFile(cfg)}\0${k}`)) continue;
    triedThisRound.add(`${toldFile(cfg)}\0${k}`);
    const a = send(cfg, t, m, m.code);
    changed = true;                                                   // a backoff count or a refusal flag may have moved
    if (a === "posted") { m.posted = true; m.clear = 0; ackedThisRound.add(`${toldFile(cfg)}\0${k}`); }
    if (a === "refused") { m.refused = true; changed = true; }
  }
  if (changed) saveTold(cfg, t);
}
// The keeper's status lines about its notices (pcjobs.sh worker and list), read from the notice file alone (never
// the relay key): a refusal of the keeper's key or setup first, each notice the link refused for good, server errors
// past SERVER_FAILS_SHOWN in a row, and a notice file whose upgrade couldn't be saved.
export function noticeTrouble(cfg: Pick<Config, "used">): string[] {
  const t = readTold(cfg);
  const marks = Object.values(t.told);
  const out: string[] = [];
  // Twenty-fifth round: every mark still owed counts (never posted, never refused for good), not only the one that
  // got the answer; read from the notice file, so a restarted keeper shows it until a send gets through.
  const owed = marks.filter((m) => !m.posted && !m.refused && m.code);
  // Twenty-seventh round: the count and the age of the oldest notice still owed, in words.
  const oldest = owed.map((m) => Date.parse(m.since ?? "")).filter(Number.isFinite).sort((x, y) => x - y)[0];
  // Twenty-eighth round: a mark from before the twenty-seventh round has no since: its age is said to be unknown.
  const unknownAge = owed.some((m) => !Number.isFinite(Date.parse(m.since ?? "")));
  const waiting = `${owed.length} notice${owed.length === 1 ? "" : "s"} for Dane wait${owed.length === 1 ? "s" : ""}${owed.length ? ` (${[...new Set(owed.map((m) => m.code))].join(", ")})` : ""}${oldest !== undefined ? `, the oldest for ${ageWords(Date.now() - oldest)}` : ""}${unknownAge ? `${oldest !== undefined ? ";" : ","} age unknown for ${owed.filter((m) => !Number.isFinite(Date.parse(m.since ?? ""))).length} from before the age was kept` : ""}`;
  if (t.config) out.push(`Keeper: ATTENTION: the link refused the keeper's notices as not allowed (its key or setup); ${waiting}. Check the link and the keeper share the relay key, then restart the App: they go then.`);
  // Twenty-seventh round, the local escalation: the link hasn't answered at all for SILENT_ROUNDS rounds in a row.
  // Twenty-eighth round: a round counts when the link didn't answer a notice or the queue's fetch got no answer.
  if ((t.silent ?? 0) >= SILENT_ROUNDS) out.push(`Keeper: ATTENTION: the keeper has had no answer for ${t.silent} rounds in a row (the link didn't answer its notices, or the queue couldn't be fetched from GitHub); ${waiting}. Check the link is running and the Pi reaches GitHub; they go once the link answers.`);
  out.push(...marks.filter((m) => m.refused && m.code).map((m) =>
    `Keeper: the link refused a notice for Dane for good (${m.code}); it isn't sent again. The keeper's log says why; tell him in your own words if it matters.`));
  out.push(...marks.filter((m) => !m.posted && m.code && (m.fails ?? 0) >= SERVER_FAILS_SHOWN).map((m) =>
    `Keeper: the link answered a notice for Dane with a server error ${m.fails} times in a row (${m.code}); it is tried again less often until the link answers.`));
  if (migrationUnsaved) out.push("Keeper: the notice file's one-time upgrade couldn't be saved; it is tried again each round, and notices still go. The keeper's log says why.");
  return out;
}
// How long ago, as people say it (twenty-seventh round, for the attention line: never an ISO time).
export function ageWords(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000);
  if (m < 2) return "about a minute";
  if (m < 90) return `about ${m} minutes`;
  const h = Math.round(m / 60);
  return h < 36 ? `about ${h} hours` : `about ${Math.round(h / 24)} days`;
}
// The floorless hold clear refused as unrecorded (twenty-seventh round): told to the owner through the link while the
// PC worker's heartbeat says so (version_hold_unwritable for hold_clear_unrecorded), once, under the same attempted-set
// and clear-round rules as every notice; seen clear otherwise.
export const HOLD_CLEAR_KEY = "holdclear";
export function holdClearNotice(cfg: Config, h: Heartbeat | null): void {
  if (h?.code === "version_hold_unwritable" && h.reason === "hold_clear_unrecorded") tell(cfg, "hold_clear_unrecorded", HOLD_CLEAR_KEY);
  else cleared(cfg, HOLD_CLEAR_KEY);
}
// Twenty-eighth round: the worker refused to start (start_refused: the tests' variable, or a preload or loader flag, set
// where it runs), told to the owner the same way.
export const START_REFUSED_KEY = "startrefused";
export function startRefusedNotice(cfg: Config, h: Heartbeat | null): void {
  if (h?.code === "start_refused") tell(cfg, "worker_start_refused", START_REFUSED_KEY);
  else cleared(cfg, START_REFUSED_KEY);
}
// Twenty-eighth round: the notices the PC's heartbeat owes, read from the queue copy as it stands, before the round's
// fetch and whatever it does, so a fetch that fails never keeps them from being recorded and tried.
export function heartbeatNotices(cfg: Config, h: Heartbeat | null): void {
  holdClearNotice(cfg, h); startRefusedNotice(cfg, h);
  let jobs: Job[] = [];
  try { jobs = readJobs(cfg.dir); } catch { jobs = []; }
  workerQuietNotice(cfg, h, jobs, cfg.now?.() ?? new Date());
}
// Twenty-ninth round, the worker not starting: a runtime that dies before the worker's entry (Bun on Windows under a
// preload in its options variable) writes neither the refusal heartbeat nor a notice, so the keeper raises one itself,
// worker_not_starting, owed while the heartbeat is older than WORKER_QUIET_MS (or there is none) and a job has waited
// at least that long, under the usual mark rules; seen clear once the worker is heard from or nothing waits that long.
// A heartbeat that already says the start was refused is told by its own notice instead.
// 0.12.2: a job's bound is min(WORKER_QUIET_MS, its life from created to expires), so a short job that expires first
// still raises it: a pending job that has waited its bound, or one the keeper closed as expired without it ever being
// claimed (failed, no attempt) within the last WORKER_QUIET_MS, each judged at min(now, its expiry), with the
// heartbeat missing or not fresh there. Held, neither told nor seen clear, while the queue's fetch is failing
// (fetchFails): the keeper's copy of the heartbeat is then old because of the outage, not the worker.
// 0.12.2, fourth pass: a heartbeat is fresh for three heartbeat intervals (HEARTBEAT_FRESH_MS), not WORKER_QUIET_MS, and
// a heartbeat after a job was queued (by more than SKEW_MS, fifth pass) means the worker started since: that job isn't waiting on a
// worker that won't start. A condition held back, because the heartbeat before the job looked fresh (the worker may have
// died right after it) or because the queue's fetch is failing, isn't dropped: it stays pending (quietPending, in the
// notice file, so it survives a restart) until each of its jobs is acknowledged (claimed, so it has an attempt, whatever
// result it then has, a heartbeat more than SKEW_MS after it was queued, or (sixth pass) a heartbeat whose job field names
// it, even inside the margin), or until QUIET_PENDING_MAX_MS from when it was first
// held (12 hours worst case, any queue hold included): then it is told, as worker_not_starting_unconfirmed while the
// queue's fetch is failing, worker_not_starting otherwise. A told mark stays owed until the link acknowledges it (resent
// each round with its saved id), never sent once and forgotten.
export const WORKER_QUIET_MS = 6 * 3_600_000;
export const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS;
export const QUIET_PENDING_MAX_MS = 12 * 3_600_000;
export const WORKER_QUIET_KEY = "workerquiet";
const NO_BEAT = "0".repeat(32);
export function workerQuietNotice(cfg: Config, h: Heartbeat | null, jobs: Job[], now: Date): void {
  const heard = h ? Date.parse(h.worker_clock) : NaN;
  const keyOf = (j: Job) => typeof j.id === "string" ? j.id : String(j.created);
  // When a job has waited its bound (pending, or closed as expired without ever being claimed within the last
  // WORKER_QUIET_MS), the time it is judged at: min(now, its expiry); null otherwise.
  const waitedAt = (j: Job): number | null => {
    const created = Date.parse(j.created), expires = Date.parse(j.expires);
    const life = Number.isFinite(expires) && Number.isFinite(created) ? Math.max(0, expires - created) : WORKER_QUIET_MS;
    const bound = Math.min(WORKER_QUIET_MS, life);
    const at = Number.isFinite(expires) ? Math.min(now.getTime(), expires) : now.getTime();
    const unclaimedExpiry = j.state === "failed" && !j.attempt && Number.isFinite(expires) && expires + SKEW_MS <= now.getTime() && now.getTime() - expires <= WORKER_QUIET_MS;
    if (j.state !== "pending" && !unclaimedExpiry) return null;
    return at - created >= bound ? at : null;
  };
  // 0.12.2, fifth pass: the clocks may differ by SKEW_MS either way, so a heartbeat counts as after the job was queued
  // only when it is more than SKEW_MS after it; one within the margin, before or after, doesn't show the worker started.
  // 0.12.2, sixth pass: a heartbeat whose job field names the job shows the worker has it, whatever the clocks say, so it
  // counts even inside the margin.

  // 0.12.2, seventh pass: a held job clears only on its own acknowledgment after the hold. A heartbeat counts only when
  // it was stamped more than SKEW_MS after the job was held (a stale heartbeat naming the job, one the keeper may simply
  // not have seen at the hold, never does); a job under the same id with another queue time (requeued) is another job
  // and never clears the held one.
  // 0.12.2, eighth pass: heartbeats are timed by the keeper's clock, never the PC's. Each round the keeper keeps the
  // heartbeat it sees (a hash of its fields) and, when it differs from the last one kept, stamps its arrival with its own
  // clock; the first one seen with no earlier record has no arrival time. A held job clears only on a heartbeat that
  // arrived after the hold began (by the keeper's clock, whatever the PC's stamp says, so a pre-hold heartbeat stamped by a
  // fast PC clock never clears it), or on a claim of that same job: the same id and the same queue time, the identity the
  // hold was made under. A hold kept without its queue time (an older notice file) is never cleared by a claim.
  const t = readTold(cfg);
  // No heartbeat at all is kept as NO_BEAT, so the first one after it is an arrival.
  const beatKey = h ? createHash("sha256").update(JSON.stringify(h)).digest("hex").slice(0, 32) : NO_BEAT;
  const beat: Beat = t.beat?.key === beatKey ? t.beat : { key: beatKey, seen: t.beat && h ? now.toISOString() : null };
  const arrived = beat?.seen ? Date.parse(beat.seen) : NaN;
  // Eighth pass: a heartbeat counts as after a job was queued only when it arrived more than SKEW_MS after the queue time by
  // the keeper's clock (the clock the queue time is on) as well as being stamped that late by the PC's, so a fast PC clock
  // alone can't make a heartbeat written before the job look like the worker started since.
  const acked = (j: Job) => !!j.attempt || (!!h?.job && h.job === j.id)
    || (Number.isFinite(arrived) && arrived - Date.parse(j.created) > SKEW_MS && Number.isFinite(heard) && heard - Date.parse(j.created) > SKEW_MS);
  const ackedSince = (j: Job, mark: { at: string; created?: string }) => {
    if (mark.created === undefined || String(j.created) !== mark.created) return mark.created === undefined && Number.isFinite(arrived) && arrived > Date.parse(mark.at);
    if (j.attempt) return true;
    return Number.isFinite(arrived) && arrived > Date.parse(mark.at);
  };
  const held = !!t.fetchFails;
  // A start refusal is told by its own notice: nothing held for it here.
  const refused = h?.code === "start_refused";
  const live = refused ? [] : jobs.map((j) => ({ j, at: waitedAt(j) })).filter((x): x is { j: Job; at: number } => x.at !== null && !acked(x.j));
  const quiet = live.filter((x) => !Number.isFinite(heard) || x.at - heard > HEARTBEAT_FRESH_MS + SKEW_MS);
  const looksFresh = live.filter((x) => !quiet.includes(x));
  let pend: QuietPending | undefined = t.quietPending ? { since: t.quietPending.since, jobs: [...t.quietPending.jobs], ...(t.quietPending.held ? { held: { ...t.quietPending.held } } : {}) } : undefined;
  if (pend && refused) pend = undefined;
  if (pend) {
    const byKey = new Map(jobs.map((j) => [keyOf(j), j] as const));
    const p0 = pend;
    const left = p0.jobs.filter((k) => { const j = byKey.get(k); return !(j && ackedSince(j, p0.held?.[k] ?? { at: p0.since })); });
    const held = Object.fromEntries(Object.entries(p0.held ?? {}).filter(([k]) => left.includes(k)));
    pend = left.length || !p0.jobs.length ? { since: p0.since, jobs: left, ...(Object.keys(held).length ? { held } : {}) } : undefined;
  }
  const hold = (xs: { j: Job }[]) => {
    for (const { j } of xs) {
      pend ??= { since: now.toISOString(), jobs: [] };
      if (pend.jobs.includes(keyOf(j))) continue;
      pend.jobs.push(keyOf(j));
      (pend.held ??= {})[keyOf(j)] = { at: now.toISOString(), created: String(j.created) };
    }
  };
  hold(held ? live : looksFresh);
  let code: "worker_not_starting" | "worker_not_starting_unconfirmed" | null = null;
  if (!held && quiet.length) code = "worker_not_starting";
  else if (pend && now.getTime() - Date.parse(pend.since) >= QUIET_PENDING_MAX_MS) code = held ? "worker_not_starting_unconfirmed" : "worker_not_starting";
  if (code) pend = undefined;
  if (JSON.stringify(pend ?? null) !== JSON.stringify(t.quietPending ?? null) || JSON.stringify(beat) !== JSON.stringify(t.beat ?? null)) {
    if (pend) t.quietPending = pend; else delete t.quietPending;
    t.beat = beat;
    saveTold(cfg, t);
  }
  if (code === "worker_not_starting_unconfirmed") tell(cfg, "worker_not_starting_unconfirmed", WORKER_QUIET_KEY);
  else if (code) tell(cfg, "worker_not_starting", WORKER_QUIET_KEY);
  else if (!held && !pend) cleared(cfg, WORKER_QUIET_KEY);
}
// A condition seen clear this round. A mark whose post was never acknowledged (posted false) is never
// counted down or deleted (twenty-second round): it is sent again with its saved id until the link answers
// posted or already posted, and only then does its clear count start. A posted mark, or one the link refused
// for good, goes after CLEAR_ROUNDS clear rounds in a row, so a condition that comes back after that is told
// again, and one that flaps is told once.
export function cleared(cfg: Config, key: string): void {
  const t = readTold(cfg);
  let changed = false;
  const m = t.told[key];
  if (m && !m.posted && !m.refused) {
    const tried = triedThisRound.has(`${toldFile(cfg)}\0${key}`);
    if (m.code && !tried) triedThisRound.add(`${toldFile(cfg)}\0${key}`);
    const a = m.code && !tried ? send(cfg, t, m, m.code) : "retry";
    if (m.code) changed = true;
    if (a === "posted") { m.posted = true; m.clear = 0; changed = true; }
    if (a === "refused") { m.refused = true; changed = true; }
  } else if (m && !ackedThisRound.delete(`${toldFile(cfg)}\0${key}`)) { m.clear += 1; if (m.clear >= CLEAR_ROUNDS) delete t.told[key]; changed = true; }
  if (t.waits[key] !== undefined) { delete t.waits[key]; changed = true; }
  if (changed) saveTold(cfg, t);
}
// One more round a bounded wait lasted (its key): at WAIT_ROUNDS, the once-only notice naming the job by
// what it does (when the keeper knows it).
export function waited(cfg: Config, code: PcNotice, key: string, job?: JobWhat): number {
  const t = readTold(cfg);
  const n = (t.waits[key] ?? 0) + 1;
  t.waits[key] = n;
  saveTold(cfg, t);
  if (n >= WAIT_ROUNDS) tell(cfg, code, key, job);
  return n;
}
// When a job was queued, for the owner's line when its site and action can't be told (twenty-third round):
// the job file's created time in the queue copy, else the day its id names. Never the id itself.
export function queuedOf(cfg: Partial<Pick<Config, "dir">>, job: string): JobWhat | undefined {
  if (!ID.test(job)) return undefined;
  if (cfg.dir) {
    try {
      const c = JSON.parse(readFileSync(join(cfg.dir, "jobs", `${job}.json`), "utf8"))?.created;
      if (typeof c === "string" && Number.isFinite(Date.parse(c))) return { queued: new Date(Date.parse(c)).toISOString().replace(/\.\d{3}Z$/, "Z") };
    } catch { /* the day in its id */ }
  }
  const d = /^j-(\d{4})(\d{2})(\d{2})-/.exec(job);
  return d ? jobWhat({ queued: `${d[1]}-${d[2]}-${d[3]}` }) : undefined;
}
// What a tap's job does, for the owner's line: the ledger's own record of it, else the request still
// waiting in the queue folder, else the job file in the queue copy; failing all of those, when it was queued
// (twenty-third round). Never its id.
export function whatOf(cfg: Config, l: Pick<ReuseLine, "job" | "rid" | "site" | "action">): JobWhat | undefined {
  const own = jobWhat(l);
  if (own) return own;
  const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
  if (l.rid && RID.test(l.rid)) { const r = jobWhat(read(join(cfg.queue, `${l.rid}.json`))?.job); if (r && "site" in r) return r; }
  if (ID.test(l.job)) { const r = jobWhat(read(join(cfg.dir, "jobs", `${l.job}.json`))); if (r && "site" in r) return r; }
  return queuedOf(cfg, l.job);
}
// The real send: one POST to the link's /pc-notice, keyed as linkReuse keys it.
export function linkNotify(cfg: Pick<Config, "link" | "discordEnv">): Notify {
  return (code, n) => {
    let tok = "";
    try { tok = readFileSync(cfg.discordEnv ?? DISCORD_ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? ""; } catch { /* none */ }
    if (!tok) return false;
    const key = createHmac("sha256", tok).update("harness-relay-v1").digest("hex");
    const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const conf = [`url = ${q(`${cfg.link ?? LINK}/pc-notice`)}`, `header = ${q(`X-Harness-Key: ${key}`)}`, `header = "Content-Type: application/json"`,
      `data-binary = ${q(JSON.stringify({ code, ...(n?.id ? { id: n.id } : {}), ...(n?.job ? { job: "site" in n.job ? { site: n.job.site, action: n.job.action } : { queued: n.job.queued } } : {}), ...(n?.repeat ? { repeat: true } : {}) }))}`,
      `max-time = 40`, `noproxy = "*"`, `silent`, `write-out = "\\n%{http_code}"`].join("\n") + "\n";
    const p = Bun.spawnSync(["curl", "-q", "-K", "-"], { stdin: Buffer.from(conf), stdout: "pipe", stderr: "ignore",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    if (p.exitCode !== 0) return false;
    // "posted" (with duplicate when it was already posted) is the acknowledgement; "refused" is the link's own
    // permanent answer to a request it won't post (a client error); anything else is passing.
    const out = p.stdout.toString(), cut = out.lastIndexOf("\n");
    const http = Number(out.slice(cut + 1).trim());
    // Twenty-fourth round: the status code first, whatever the body: 401 and 403 are a refusal of the keeper's key
    // or setup; a 5xx is the link's own trouble.
    if (http === 401 || http === 403) return "config";
    if (http >= 500 && http <= 599) return "server";
    let st: unknown;
    try { st = JSON.parse(out.slice(0, cut))?.status; } catch { st = undefined; }
    if (!(http >= 100 && http <= 599)) return false;                 // no status line: no answer
    if (http === 200 && st === "posted") return true;
    if (http === 400 && st === "refused") return "refused";
    return "http";
  };
}

// Whether the queue as fetched this round shows a tap's push reached GitHub: "landed" (a recorded
// commit is in the branch, the job or request is named anywhere in the queue, or an attempt was
// answered ok), "absent" (none of that, in a full copy whose answers are all clear), "shallow" (a
// shallow copy can't tell), or "unknown" (git said neither yes nor no, or a file couldn't be read).
// The landed checks run first, in this order (0.12.0, twentieth round): (1) any recorded commit in
// the fetched branch, (2) any job, report or worker record naming the job or the request, (3) an ok
// answer. Only once none shows it does an ambiguity (shallow, unknown) or "absent" come back, and
// only "absent" lets the caller weigh a rollback.
export type PushSeen = "landed" | "absent" | "shallow" | "unknown";
export function pushSeen(cfg: Config, l: ReuseLine, fetched: string | null): PushSeen {
  // (1) The recorded commits, against the branch as this round's fetch gave it.
  const inBranch = commitsSeen(cfg, l, fetched);
  if (inBranch === "landed") return "landed";
  // (2) Any record in the queue copy naming the job or its request.
  let recorded: boolean | null;
  try { recorded = named(cfg.dir, [l.job, ...(l.rid ? [l.rid] : [])], resolve(cfg.used ?? USED_REUSE)); } catch { recorded = null; }
  if (recorded) return "landed";
  // (3) GitHub's own ok to a push of it.
  if (l.attempts.some((a) => a.answer === "ok")) return "landed";
  if (recorded === null) return "unknown";
  return inBranch;
}
// Whether any recorded commit of a tap is in the fetched branch: landed, absent (a full copy, every
// answer clear), shallow, or unknown (no fetch, or git said neither yes nor no).
function commitsSeen(cfg: Config, l: ReuseLine, fetched: string | null): PushSeen {
  if (!fetched) return "unknown";
  const shallow = existsSync(join(cfg.dir, ".git", "shallow"));
  let unclear: PushSeen | null = null;
  for (const a of l.attempts) {
    // Is the commit in the branch as fetched? git answers 0 (yes) or 1 (no) for a commit it has;
    // one it doesn't have at all was never fetched, so in a full copy it is in no part of the branch.
    const has = Bun.spawnSync(["git", "cat-file", "-e", `${a.commit}^{commit}`], { cwd: cfg.dir, stdout: "ignore", stderr: "ignore" });
    if (has.exitCode !== 0) { if (shallow) unclear ??= "shallow"; continue; }
    const x = Bun.spawnSync(["git", "merge-base", "--is-ancestor", a.commit, fetched], { cwd: cfg.dir, stdout: "ignore", stderr: "ignore" });
    if (x.exitCode === 0) return "landed";
    if (x.exitCode !== 1) unclear ??= "unknown";
    else if (shallow) unclear ??= "shallow";
  }
  return unclear ?? "absent";
}
// Whether any file of the queue copy (the job files, reports, worker records, cancels, anything
// but git's own folder) names one of these ids. A file that can't be read is an ambiguity: it throws.
function named(dir: string, ids: string[], skip: string): boolean {
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (resolve(p) === skip) continue;                 // the used-tap store itself, were it ever kept in the copy
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (ids.some((id) => e.name.includes(id))) return true;
      const t = readFileSync(p, "utf8");
      if (ids.some((id) => t.includes(id))) return true;
    }
    return false;
  };
  return existsSync(dir) ? walk(dir) : false;
}
export class ReuseUnsettled extends Error {}
// The status a pending tap's replay is refused with, and the line the owner hears after a push
// refused on every try: the same words.
export const PENDING_STATUS = "pending: whether its job reached the PC's queue is settled at the keeper's next round with a successful fetch from GitHub (within a minute while GitHub answers), and until then the tap stays used";
export const SPENT_WHY = "the keeper can't show whether the job made from that tap reached the PC's queue, so the tap counts as used for good; ask him again";
// Step 0 of a round, after sync: every pending tap settled against the queue as GitHub has it.
// fetched: the branch's commit this round's fetch brought (sync), or null when it brought none.
// A tap that can't be settled stays pending (spent) and is listed in unsettled; the round goes on.
export function reconcileReuse(cfg: Config, jobs: Job[], fetched: string | null = null): { finalised: string[]; rolledBack: string[]; spent: string[]; unsettled: string[] } {
  const finalised: string[] = [], rolledBack: string[] = [], spent: string[] = [], unsettled: string[] = [];
  const waiting = (l: ReuseLine) => !!(l.rid && RID.test(l.rid) && existsSync(join(cfg.queue, `${l.rid}.json`)));
  for (const l of reuseLedger(cfg).values()) {
    if (l.state !== "pending") continue;
    if (l.legacy) {
      // The seventeenth round's keeper wrote no commit. The same record check first (0.12.0, twentieth
      // round): a job, report or worker record naming its job or request means it landed. With no
      // such record, nothing could ever prove it absent, so it is spent. A record that can't be read
      // leaves it pending (spent) for a later round.
      let rec: boolean | null;
      try { rec = jobs.some((j) => j.id === l.job) || named(cfg.dir, [l.job, ...(l.rid ? [l.rid] : [])], resolve(cfg.used ?? USED_REUSE)); } catch { rec = null; }
      if (rec === null) {
        unsettled.push(l.job);
        const n = waited(cfg, "reuse_record_unreadable", `record:${l.m}`, whatOf(cfg, l));
        log(`the reuse tap for ${l.job} (written by an older keeper) can't be settled yet: a file in the queue copy can't be read (round ${n}; the owner is told after ${WAIT_ROUNDS})`);
        continue;
      }
      if (rec) {
        recordReuse(cfg, l.m, l.job, "final", l.rid, undefined, { migrated: "round17_pending" });
        finalised.push(l.job);
        if (waiting(l)) { writeOutcome(cfg, { request: l.rid!, state: "queued", id: l.job }); rmSync(join(cfg.queue, `${l.rid}.json`), { force: true }); }
        cleared(cfg, `unsettled:${l.m}`); cleared(cfg, `record:${l.m}`);
        log(`migrated the reuse tap for ${l.job} (written by an older keeper, no commit): a record in the queue names it, so it landed`);
        continue;
      }
      recordReuse(cfg, l.m, l.job, "final", l.rid, undefined, { settled: "spent", migrated: "round17_pending" });
      cleared(cfg, `unsettled:${l.m}`); cleared(cfg, `record:${l.m}`);
      spent.push(l.job);
      if (waiting(l)) { writeOutcome(cfg, { request: l.rid!, state: "refused", reason: `owner_reuse refused: ${SPENT_WHY}` }); rmSync(join(cfg.queue, `${l.rid}.json`), { force: true }); }
      tell(cfg, "reuse_migrated", `migrated:${l.m}`, whatOf(cfg, l));
      log(`migrated the reuse tap for ${l.job} (written by an older keeper, no commit): spent`);
      continue;
    }
    // Every landed check runs before any rollback decision: pushSeen's (commits, records, an ok answer), then the jobs as read.
    let seen = pushSeen(cfg, l, fetched);
    if (seen !== "landed" && jobs.some((j) => j.id === l.job && j.owner_reuse?.message_id === l.m)) seen = "landed";
    if (seen === "landed") {
      recordReuse(cfg, l.m, l.job, "final", l.rid, l.commit);
      finalised.push(l.job);
      if (waiting(l)) {
        writeOutcome(cfg, { request: l.rid!, state: "queued", id: l.job });
        rmSync(join(cfg.queue, `${l.rid}.json`), { force: true });
      }
      cleared(cfg, `shallow:${l.m}`); cleared(cfg, `unsettled:${l.m}`); cleared(cfg, `refused:${l.m}`); cleared(cfg, `fetch:${l.m}`);
      log(`settled the reuse tap for ${l.job}: its push reached the queue`);
    } else if (seen === "absent") {
      const allRefused = l.attempts.length > 0 && l.attempts.every((a) => a.answer === "refused");
      if (allRefused) {
        recordReuse(cfg, l.m, l.job, "rolled_back", l.rid, l.commit);
        rolledBack.push(l.job);
        // The refusal notice stays marked for this tap: a rolled-back tap refused again is the same condition, not told twice.
        log(`rolled back the reuse tap for ${l.job}: GitHub refused every push of it (${l.attempts.length}), and this round's fetch shows none of its commits in the branch and no record of it`);
      } else {
        cleared(cfg, `refused:${l.m}`);
        recordReuse(cfg, l.m, l.job, "final", l.rid, l.commit, { settled: "spent" });
        spent.push(l.job);
        if (waiting(l)) { writeOutcome(cfg, { request: l.rid!, state: "refused", reason: `owner_reuse refused: ${SPENT_WHY}` }); rmSync(join(cfg.queue, `${l.rid}.json`), { force: true }); }
        log(`the reuse tap for ${l.job} stays spent: no record shows every push of it refused, and the queue doesn't show it`);
      }
      cleared(cfg, `shallow:${l.m}`); cleared(cfg, `unsettled:${l.m}`); cleared(cfg, `fetch:${l.m}`);
    } else {
      unsettled.push(l.job);
      tell(cfg, seen === "shallow" ? "reuse_shallow" : "reuse_unsettled", `${seen === "shallow" ? "shallow" : "unsettled"}:${l.m}`, whatOf(cfg, l));
      log(`the reuse tap for ${l.job} can't be settled yet (${seen === "shallow" ? "the queue copy is shallow" : "git gave no clear answer"}); it stays pending, so spent, and the round goes on`);
    }
  }
  return { finalised, rolledBack, spent, unsettled };
}

const KEEPER = "Cain's PC job keeper";
const log = (m: string) => console.log(`[pc-jobs] ${m}`);

class GitError extends Error {}

function git(cfg: Config, args: string[], cwd = cfg.dir): string {
  const env: Record<string, string> = { ...process.env as any, GIT_TERMINAL_PROMPT: "0" };
  if (cfg.token) {
    // Rewritten every time, so nothing planted there is ever used.
    const ask = "/tmp/pc-jobs-askpass.sh";
    writeFileSync(ask, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token;; *) echo "$PC_JOBS_TOKEN";; esac\n', { mode: 0o700 });
    env.GIT_ASKPASS = ask; env.PC_JOBS_TOKEN = cfg.token;
  }
  const p = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null",
    "-c", `user.name=${KEEPER}`, "-c", "user.email=HyndeSyte@users.noreply.github.com", ...args],
    { cwd, env, stdout: "pipe", stderr: "pipe" });
  let out = (p.stdout.toString() + p.stderr.toString()).trim();
  if (cfg.token) out = out.split(cfg.token).join("<token>");
  if (p.exitCode !== 0) throw new GitError(`git ${args[0]}: ${out.split("\n")[0]}`);
  return out;
}

// git with a time limit, its answer returned whatever it was (the push reads it itself).
function gitRun(cfg: Config, args: string[], timeoutMs: number): { exitCode: number | null; out: string; timedOut: boolean } {
  const env: Record<string, string> = { ...process.env as any, GIT_TERMINAL_PROMPT: "0" };
  if (cfg.token) {
    const ask = "/tmp/pc-jobs-askpass.sh";
    writeFileSync(ask, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token;; *) echo "$PC_JOBS_TOKEN";; esac\n', { mode: 0o700 });
    env.GIT_ASKPASS = ask; env.PC_JOBS_TOKEN = cfg.token;
  }
  const p = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null",
    "-c", `user.name=${KEEPER}`, "-c", "user.email=HyndeSyte@users.noreply.github.com", ...args],
    { cwd: cfg.dir, env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  let out = (p.stdout.toString() + p.stderr.toString()).trim();
  if (cfg.token) out = out.split(cfg.token).join("<token>");
  const timedOut = p.exitCode === null || !!(p as any).signalCode;
  return { exitCode: timedOut ? null : p.exitCode, out, timedOut };
}

// The queue copy brought up to date from GitHub: the branch's commit as fetched, or null when
// the remote has no such branch (nothing to fetch). Every git error throws. remoteHeads says
// whether the remote has any branch at all (an empty remote has none).
export function sync(cfg: Config, seen: { remoteHeads?: boolean } = {}): string | null {
  if (!existsSync(join(cfg.dir, ".git"))) {
    mkdirSync(dirname(cfg.dir), { recursive: true });
    git(cfg, ["clone", "--quiet", "-c", "core.symlinks=false", cfg.remote, cfg.dir], dirname(cfg.dir));
  }
  rmSync(join(cfg.dir, ".git", "index.lock"), { force: true });
  // A queue that is still empty has no branch yet: nothing to fetch.
  const heads = git(cfg, ["ls-remote", "--heads", "origin"]);
  seen.remoteHeads = heads.trim().length > 0;
  const has = heads.split("\n").some((l) => l.trim().endsWith(`refs/heads/${cfg.branch}`));
  if (!has) return null;
  git(cfg, ["fetch", "--quiet", "origin", cfg.branch]);
  git(cfg, ["checkout", "--quiet", "-B", cfg.branch, `origin/${cfg.branch}`]);
  git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);
  git(cfg, ["clean", "-qfd"]);
  const at = git(cfg, ["rev-parse", "--verify", `origin/${cfg.branch}^{commit}`]).trim();
  if (!COMMIT.test(at)) throw new GitError("git rev-parse: no commit for the fetched branch");
  return at;
}

// One push's answer, read from git (0.12.0, twentieth round). Only `git push --porcelain`'s own
// line for the exact ref decides a refusal: that line flagged "!" ([rejected] or [remote rejected])
// is refused, the remote's words kept. A zero exit is ok. Everything else is unknown, never
// refused: a timeout, a broken connection, an answer with no line for that ref, and a non-zero exit
// whose line for the ref shows it updated (a post-push failure: the local tracking ref couldn't be
// written, a hook's error printed after the update). An unknown answer never frees a tap.
export type GitRun = { exitCode: number | null; out: string; timedOut: boolean };
export function pushAnswer(exitCode: number | null, out: string, timedOut: boolean, ref = "refs/heads/main"): { answer: PushAnswer; said: string; nonFastForward: boolean } {
  const said = out.replace(/\s+/g, " ").trim().slice(0, 300);
  if (timedOut || exitCode === null) return { answer: "unknown", said: "no answer in time", nonFastForward: false };
  if (exitCode === 0) return { answer: "ok", said: "", nonFastForward: false };
  // Porcelain: one line per ref, "<flag>\t<from>:<to>\t<summary>".
  const line = out.split(/\r?\n/).find((l) => { const f = l.split("\t"); return f.length >= 3 && f[0].length === 1 && f[1].endsWith(`:${ref}`); });
  if (!line?.startsWith("!")) return { answer: "unknown", said, nonFastForward: false };
  const nonFastForward = /\[rejected\].*\((?:non-fast-forward|fetch first)\)/.test(line);
  return { answer: "refused", said, nonFastForward };
}
export class PushRefused extends Error { constructor(m: string, readonly answers: PushAnswer[]) { super(m); } }
// The push, tried up to PUSH_TRIES times with a short wait between. Before each attempt every
// tap riding on it records the commit that attempt pushes; after it, the remote's answer. A
// non-fast-forward refusal brings the branch down again and rebases the keeper's commit onto it,
// so the next attempt pushes (and records) the rebased commit.
export function push(cfg: Config, taps: Tap[] = []): void {
  const answers: PushAnswer[] = [];
  for (let i = 1; ; i++) {
    cfg.beforePush?.();
    const commit = git(cfg, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    for (const t of taps) recordAttempt(cfg, t, commit);
    const ref = `refs/heads/${cfg.branch}`;
    let p = gitRun(cfg, ["push", "--porcelain", "origin", `HEAD:${ref}`], cfg.pushTimeoutMs ?? PUSH_TIMEOUT_MS);
    if (cfg.pushResult) p = cfg.pushResult(p);
    cfg.onPushAnswer?.();
    const a = pushAnswer(p.exitCode, p.out, p.timedOut, ref);
    answers.push(a.answer);
    for (const t of taps) recordAnswer(cfg, t, a.answer, a.said);
    if (a.answer === "ok") return;
    if (i >= PUSH_TRIES) {
      // Told once per tap (not per job made from it), so a tap rolled back and refused again isn't told twice.
      if (taps.length && answers.every((x) => x === "refused")) for (const t of taps) tell(cfg, "reuse_push_refused", `refused:${t.m}`, whatOf(cfg, t));
      throw new PushRefused(`git push: ${a.answer}${a.said ? ` (${a.said})` : ""}`, answers);
    }
    log(`push ${i} of ${PUSH_TRIES} didn't go through (${a.answer}), trying again: ${a.said}`);
    const ms = cfg.pushWaitMs ?? PUSH_WAIT_MS;
    if (ms > 0) Bun.sleepSync(ms);
    if (a.nonFastForward) {
      // The branch moved on GitHub: bring it down and replay the keeper's commit on top.
      git(cfg, ["fetch", "--quiet", "origin", cfg.branch]);
      try { git(cfg, ["rebase", "--quiet", `origin/${cfg.branch}`]); }
      catch (e) { try { git(cfg, ["rebase", "--abort"]); } catch { /* nothing to abort */ } throw e; }
    }
  }
}

// Every job file in the copy that parses; the rest are left out.
export function readJobs(dir: string): Job[] {
  const d = join(dir, "jobs");
  if (!existsSync(d)) return [];
  const out: Job[] = [];
  for (const n of readdirSync(d)) {
    if (!/^j-\d{8}-[a-z0-9]{6}\.json$/.test(n)) continue;
    try { const j = parseJob(readFileSync(join(d, n), "utf8")); if (j.ok && `${j.value.id}.json` === n) out.push(j.value); } catch { /* skip */ }
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
}

// A job's result, as data: checked against the format, its facts typed for the job's
// action. A file that breaks the format is "bad" and nothing of it is shown.
export function readResult(dir: string, id: string): Result | null | "bad" {
  if (!ID.test(id)) return "bad";
  const f = join(dir, "results", `${id}.json`);
  if (!existsSync(f)) return null;
  const job = readJobs(dir).find((j) => j.id === id);
  const r = parseResult(readFileSync(f, "utf8"), job?.action);
  return r.ok && r.value.id === id && job ? r.value : "bad";
}

// The PC worker's last heartbeat in the copy, checked, or null.
export function readHeartbeat(dir: string): Heartbeat | null {
  try { return parseHeartbeat(readFileSync(join(dir, "worker", "heartbeat.json"), "utf8")); } catch { return null; }
}

// When a version stopped runs, the one line Cain tells Dane, naming what to run at the PC
// (cain/docs/pc-jobs.md, "Supported versions"). null when there's nothing for him to do.
export const REPROBE = "worker.ts probe --attended, then worker.ts confirm-profile --accept-boundary";
export function heartbeatNotice(h: Heartbeat | null): string | null {
  if (h?.code === "update_pending")
    return `The PC stopped taking jobs because Chrome has a Claude in Chrome update waiting, and an auto-update needs a new probe. At the PC: restart the Cain jobs Chrome, then run ${REPROBE}.`;
  if (h?.code === "extension_versions_ambiguous")
    return `The PC stopped taking jobs because the Cain jobs profile holds more than one Claude in Chrome version, so the one Chrome runs can't be bound to the probe. At the PC: restart the Cain jobs Chrome, then run ${REPROBE}.`;
  if (h?.code === "chrome_version_timeout")
    return "The PC didn't take jobs because its worker couldn't read Chrome's version in time. At the PC: close heavy programs or restart the PC, then start a run.";
  if (h?.code === "chrome_version_unreadable")
    return `The PC didn't take jobs because its worker couldn't read Chrome's version from the PowerShell listing. At the PC: run ${REPROBE}; if its chrome_listing step refuses, follow that row in Troubleshooting.`;
  if (h?.code === "versions_changed")
    return `The PC stopped taking jobs because Claude in Chrome or Chrome changed version during a run, and a version change needs a new probe. At the PC: restart the Cain jobs Chrome, then run ${REPROBE}.`;
  if (h?.code === "start_refused")
    return "The PC isn't taking jobs because its worker refused to start: a setting meant only for its tests (the PC_WORKER_TEST_BUILD variable, or a preload, require, import or loader flag in NODE_OPTIONS or BUN_OPTIONS, or a bunfig.toml preload) is set where it runs. At the PC: remove it as the worker's own refusal says, open a new terminal, then start a run.";
  if (h?.code === "version_hold_unwritable" && h.reason === "hold_clear_unrecorded")
    return "The PC isn't taking jobs because its worker couldn't write its record of clearing a version hold (version-hold-cleared.json in the worker folder), so the hold stays. At the PC: free disk space or fix the worker folder's permissions so that file can be written, then start a run.";
  if (h?.code === "version_hold_unwritable")
    return "The PC stopped taking jobs because its worker couldn't write a note that Claude in Chrome's version changed. At the PC: free disk space or check the worker folder can be written, then start a run; it then asks for a new probe.";
  if (h?.code === "version_hold_cannot_invalidate")
    return "The PC stopped taking jobs because its worker couldn't write a note that Claude in Chrome's or Chrome's version changed, and couldn't set its old confirmation aside either. At the PC: free disk space or fix the worker folder's permissions, then start a run; it then asks for a new probe.";
  if (h?.code === "worker_signin_missing")
    return "The PC isn't taking jobs because the worker's own Claude Code isn't signed in. At the PC: run the setup step that signs in claude-config, then start a run.";
  if (h?.code === "session_cleanup_failed")
    return "The PC stopped taking jobs because it couldn't delete a session's transcripts. At the PC: run worker.ts check-cli and follow its Troubleshooting row.";
  if (h?.code === "containment_unavailable")
    return "The PC isn't taking jobs because it couldn't build or start its Windows Job Object helper. At the PC: follow the containment_unavailable row in Troubleshooting, then start a run.";
  if (h?.code === "helper_compiler_missing")
    return "The PC isn't taking jobs because Windows has no C# compiler for its Job Object helper (the .NET Framework 4 feature is off). At the PC: follow the helper_compiler_missing row in Troubleshooting, then start a run.";
  if (h?.code === "helper_blocked")
    return "The PC isn't taking jobs because something on the PC, usually security software, stopped its Job Object helper from being built or started. At the PC: follow the helper_blocked row in Troubleshooting, then start a run.";
  if (h?.code === "host_parent_gone")
    return "The PC isn't taking jobs because Claude in Chrome's helper lost its Chrome. At the PC: restart the Cain jobs Chrome.";
  if (h?.code === "extra_extension")
    return "The PC isn't taking jobs because the Cain jobs Chrome has another extension turned on (Google Docs Offline counts), one a Chrome policy installs, or one whose settings or policy it can't read. At the PC: run worker.ts check-host, which names it and the fix; turn it off in that Chrome, or, if it names a policy, have that policy stop installing it.";
  if (h?.code === "prefs_disagree")
    return "The PC isn't taking jobs because Chrome's two preference files disagree about an extension in the Cain jobs profile. At the PC: restart the Cain jobs Chrome, then run worker.ts check-host.";
  if (h?.code === "unattended_unsupported")
    return "The PC isn't taking jobs because its install file asks for unattended runs, which this version doesn't allow. At the PC: set unattended to false.";
  if (h?.code === "boundary_not_accepted")
    return `The PC isn't taking jobs until you accept its stated boundary. At the PC: run ${REPROBE}.`;
  if (!h?.reason) return null;
  if (h.reason === "extension_version_changed")
    return `The PC stopped taking jobs because Claude in Chrome updated. At the PC: restart the Cain jobs Chrome, then run ${REPROBE}.`;
  if (h.reason === "cli_version_changed") return `The PC stopped taking jobs because Claude Code updated. At the PC: run ${REPROBE}.`;
  if (h.reason === "worker_changed")
    return `The PC stopped taking jobs because its worker was updated (a new Cain release). At the PC: run ${REPROBE}.`;
  if (h.reason === "chrome_version_changed")
    return `The PC stopped taking jobs because Chrome updated. At the PC: restart the Cain jobs Chrome, then run ${REPROBE}.`;
  return `The PC runs jobs only while you watch: Claude Code doesn't report Claude in Chrome's version, so unattended runs stay off. At the PC: run ${REPROBE} after the next Claude Code update.`;
}

export function heartbeatLine(h: Heartbeat | null): string {
  if (!h) return "PC worker: not seen yet";
  const extra = [h.stale_lock ? "cleared a stale lock" : "", h.skew_ms !== null && h.skew_ms > 0 ? `the Pi's clock ahead by ${Math.round(h.skew_ms / 1000)}s` : ""]
    .filter(Boolean).join(", ");
  const notice = heartbeatNotice(h);
  return `PC worker: ${h.code}${h.reason ? ` (${h.reason})` : ""} at ${h.worker_clock} (its own clock)${h.job ? ` on ${h.job}` : ""}${extra ? ` (${extra})` : ""}`
    + (notice ? `\nFor Dane: ${notice}` : "");
}

// Jobs the keeper's clock says are over: a pending job past its expiry, and a claim
// whose lease ran out (both with the skew allowed). A read that never reported changed
// nothing; anything else may have done part of its step, so it is in doubt.
export function stale(jobs: Job[], now: Date): { job: Job; result: Result }[] {
  const out: { job: Job; result: Result }[] = [];
  const at = now.toISOString();
  const r = (j: Job, status: Result["status"], code: Result["code"]): Result =>
    ({ v: 1, id: j.id, attempt: j.attempt, status, code, handoff: null, worker_clock: at, final_url: null, facts: {}, tools: [], attended: false });
  for (const j of jobs) {
    if (j.state === "pending" && Date.parse(j.expires) + SKEW_MS <= now.getTime()) out.push({ job: j, result: r(j, "expired", "expired") });
    else if (j.state === "claimed" && Date.parse(j.lease_until!) + SKEW_MS <= now.getTime())
      out.push({ job: j, result: isReadOnly(j) ? r(j, "failed", "lease_expired") : r(j, "in_doubt", "lease_expired") });
  }
  return out;
}

type Outcome = { request: string; state: "queued" | "cancel_sent" | "refused"; id?: string; reason?: string };
const RID = /^[A-Za-z0-9._:-]{1,80}$/;
const outcomeFile = (cfg: Config, rid: string) => join(cfg.outcomes, `${rid}.json`);

function writeOutcome(cfg: Config, o: Outcome) {
  mkdirSync(cfg.outcomes, { recursive: true });
  const f = outcomeFile(cfg, o.request);
  writeFileSync(`${f}.tmp`, JSON.stringify(o));
  renameSync(`${f}.tmp`, f);
}

// One request, checked against the queue as the copy has it: a job, a cancel, or why not.
export function check(cfg: Config, raw: string, jobs: Job[], now: Date): { job: Job } | { cancel: string } | { why: string } {
  let req: any;
  try { req = JSON.parse(raw); } catch { return { why: "it isn't JSON" }; }
  if (!req || typeof req !== "object" || req.from !== "cain") return { why: "only Cain's jobs are accepted" };
  if ("cancel" in req) {
    if (Object.keys(req).length !== 2 || typeof req.cancel !== "string" || !ID.test(req.cancel)) return { why: "a cancel names one job id" };
    const j = jobs.find((x) => x.id === req.cancel);
    if (!j) return { why: `${req.cancel} isn't in the queue` };
    if (TERMINAL.includes(j.state)) return { why: `${req.cancel} has ended already (${j.state})` };
    if (existsSync(join(cfg.dir, "cancels", `${j.id}.json`))) return { why: `${req.cancel} is being cancelled already` };
    return { cancel: j.id };
  }
  // A report's values never come back as queue content: a job carrying one is refused.
  // An address Cain itself wrote into a job before (any job's start address) is his own, not the page's.
  const own = new Set(jobs.map((j) => normalUrl(j.start_url, true)));
  const values = jobs.flatMap((j) => { const r = readResult(cfg.dir, j.id); return r && r !== "bad" ? reportValues(r, j) : []; })
    .filter((v) => !(/^https?:/i.test(v) && own.has(normalUrl(v, true))));
  // A mitigation, not a guarantee (core.ts): the pinned domains are the control. A value
  // the owner said yes to reusing goes through only with owner_reuse naming the Discord
  // message of his "Use it" tap, which the link checks (linkReuse, above); Cain's words and
  // the owner's typed replies never count, and one tap answers for one job, across restarts
  // (usedReuse, above, and the queue's own job files).
  const reuse = req.job && typeof req.job === "object" ? req.job.owner_reuse : undefined;
  if (reuse !== undefined && reuse !== null) {
    if (!reuseOk(reuse)) return { why: `${REUSE_SHAPE}; without his message's id it is refused` };
    const inQueue = jobs.find((j) => j.owner_reuse?.message_id === reuse.message_id)?.id;
    if (inQueue) return { why: `owner_reuse refused: that tap of his already answered for ${inQueue}; ask him again for this job` };
    let tap: ReuseLine | undefined;
    try { tap = reuseLedger(cfg).get(reuse.message_id); }
    catch { return { why: "owner_reuse refused: the keeper can't read its record of used taps, so no reuse is taken until it can (the owner was told how to fix it)" }; }
    if (tap?.state === "pending") return { why: `owner_reuse refused: that tap of his answered for ${tap.job} and is ${PENDING_STATUS}` };
    if (tap && tap.state !== "rolled_back") return { why: `owner_reuse refused: that tap of his already answered for ${tap.job}; ask him again for this job` };
    let v: ReturnType<ReuseCheck>;
    try { v = (cfg.verifyReuse ?? linkReuse(cfg))(reuse); } catch { v = { ok: false, why: "the link couldn't check it" }; }
    if (v.ok && v.via !== "tap") v = { ok: false, why: "only his \"Use it\" tap counts, never a message he typed" };
    if (!v.ok) return { why: `owner_reuse refused: ${v.why}. Reuse needs his "Use it" tap on your ask that quotes each value; a reply he types never counts` };
  }
  if (unapprovedValues(req.job, values).length) return { why: "a job can't carry a value from a PC result (an address or account a page showed): write it from the owner's words or the allowlist instead, or ask the owner and record his yes as owner_reuse with its Discord message id" };
  let id = newId(now, cfg.rand);
  while (jobs.some((j) => j.id === id)) id = newId(now, cfg.rand);
  const made = jobFromAsk(req.job, now, id);
  if (!made.ok) return { why: made.why };
  if (!isReadOnly(made.value)) return { why: "irreversible jobs (preview and confirm) are refused until the confirm path ships; only read jobs run" };
  return { job: made.value };
}

// One round: the queue brought up to date, Cain's requests checked, the good ones
// written and pushed. A request leaves its folder only once its outcome is known: a
// refusal at once, a job once GitHub has its commit.
export function round(cfg: Config): { ok: boolean; queued: number; refused: number } {
  let names = existsSync(cfg.queue) ? readdirSync(cfg.queue).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort() : [];
  // Every notice still owed goes again first (twenty-third round), whatever its key.
  try { resendOwed(cfg); } catch (e) { log(`couldn't send the notices still owed: ${(e as Error).message}`); }
  // Twenty-eighth round: the PC's heartbeat read and its notices recorded and tried before the fetch, independently of it.
  try { heartbeatNotices(cfg, readHeartbeat(cfg.dir)); } catch (e) { log(`couldn't read the PC worker's heartbeat for its notices: ${(e as Error).message}`); }
  try {
    const seen: { remoteHeads?: boolean } = {};
    let fetched: string | null;
    try { fetched = sync(cfg, seen); }
    catch (e) {
      // (fetchUnanswered also counts the fetch's own failure streak, twenty-ninth round: queueFetch.)
      // Twenty-eighth round: a fetch that got no answer counts toward the silent rounds, as a send with none does.
      try { fetchUnanswered(cfg); } catch { /* counted next round */ }
      // A round that couldn't fetch can't settle a tap whose pushes were all refused (the third-refusal
      // settle): one more round of that wait for each, told once after WAIT_ROUNDS.
      // A round whose tap store can't be read either (twenty-second round) counts too: three such rounds in a
      // row raise the store's own once-only notice (reuse_store_unreadable, its usual key).
      let taps: ReuseLine[] = [];
      try { taps = [...reuseLedger(cfg).values()].filter((l) => l.state === "pending" && !l.legacy && l.attempts.length > 0 && l.attempts.every((a) => a.answer === "refused")); cleared(cfg, "store"); }
      catch (s) { taps = []; if (s instanceof StoreUnreadable) waited(cfg, "reuse_store_unreadable", "store"); }
      for (const l of taps) waited(cfg, "reuse_fetch_failed", `fetch:${l.m}`, whatOf(cfg, l));
      throw e;
    }
    // Twenty-ninth round: a fetch that worked ends the fetch's failure streak.
    try { queueFetch(cfg, true); } catch { /* counted next round */ }
    const now = cfg.now?.() ?? new Date();
    const over = stale(readJobs(cfg.dir), now);
    if (over.length) {
      for (const { job, result } of over) {
        mkdirSync(join(cfg.dir, "results"), { recursive: true });
        writeFileSync(join(cfg.dir, "results", `${job.id}.json`), resultText(result));
        writeFileSync(join(cfg.dir, "jobs", `${job.id}.json`), jobText({ ...job, state: stateAfter(job, result), lease_until: null }));
        git(cfg, ["add", `results/${job.id}.json`, `jobs/${job.id}.json`]);
      }
      git(cfg, ["commit", "--quiet", "-m", `Cain: close ${over.map((o) => `${o.job.id} (${o.result.code})`).join(", ")}`.slice(0, 200)]);
      push(cfg);
      for (const o of over) log(`closed ${o.job.id}: ${o.result.code}`);
    }
    // Every reuse tap left pending by a round that didn't finish, settled against the queue as GitHub
    // has it. Each stop condition is told to the owner once, and scoped where it can be: a tap that
    // can't be settled waits with its request, and the round goes on for the rest.
    let ledger: Map<string, ReuseLine> | null = null;
    try { ledger = reuseLedger(cfg); cleared(cfg, "store"); }
    catch (e) {
      if (!(e instanceof StoreUnreadable)) throw e;
      tell(cfg, "reuse_store_unreadable", "store");
      log(`${e.message}: reuse requests wait, the rest go on`);
    }
    const pendingTaps = ledger ? [...ledger.values()].filter((l) => l.state === "pending") : [];
    if (fetched === null && pendingTaps.length) {
      const empty = !seen.remoteHeads;
      tell(cfg, empty ? "queue_empty_pending" : "queue_branch_missing", empty ? "empty" : "branch");
      throw new ReuseUnsettled(empty ? "the queue on GitHub is empty while a reuse tap is pending: the round stops" : `the queue's ${cfg.branch} branch is missing on GitHub while a reuse tap is pending: the round stops`);
    }
    cleared(cfg, "empty"); cleared(cfg, "branch");
    const settle = ledger ? reconcileReuse(cfg, readJobs(cfg.dir), fetched) : { unsettled: [] as string[] };
    // Requests that wait this round: those of taps still unsettled, and every reuse request while the store can't be read.
    const waitRid = new Set(ledger ? [...reuseLedger(cfg).values()].filter((l) => l.state === "pending" && settle.unsettled.includes(l.job) && l.rid).map((l) => l.rid!) : []);
    names = names.filter((n) => {
      const rid = n.replace(/\.json$/, "");
      if (waitRid.has(rid)) return false;
      if (!ledger) { try { const r = JSON.parse(readFileSync(join(cfg.queue, n), "utf8")); if (r?.job?.owner_reuse) return false; } catch { /* checked below */ } }
      return existsSync(join(cfg.queue, n));
    });
    if (!names.length) return { ok: true, queued: 0, refused: 0 };
    const jobs = readJobs(cfg.dir);
    const made: { rid: string; file: string; job?: Job; cancel?: string }[] = [];
    let refused = 0;
    for (const n of names) {
      const file = join(cfg.queue, n);
      const rid = n.replace(/\.json$/, "");
      if (!RID.test(rid)) { rmSync(file, { force: true }); continue; }
      let raw = "";
      try { raw = readFileSync(file, "utf8"); } catch { continue; }
      const c = raw.length > 8_000 ? { why: "a job request is at most 8000 bytes" } : check(cfg, raw, jobs, now);
      if ("why" in c) {
        writeOutcome(cfg, { request: rid, state: "refused", reason: c.why });
        rmSync(file, { force: true });
        refused++;
        log(`refused ${rid}: ${c.why}`);
        continue;
      }
      if ("cancel" in c) {
        if (made.some((m) => m.cancel === c.cancel)) { rmSync(file, { force: true }); continue; }
        made.push({ rid, file, cancel: c.cancel });
        continue;
      }
      jobs.push(c.job);
      made.push({ rid, file, job: c.job });
    }
    if (!made.length) return { ok: true, queued: 0, refused };
    // Structured files are text with LF line endings, on every side.
    if (!existsSync(join(cfg.dir, ".gitattributes"))) {
      writeFileSync(join(cfg.dir, ".gitattributes"), QUEUE_ATTRIBUTES);
      git(cfg, ["add", ".gitattributes"]);
    }
    for (const m of made) {
      const [sub, id] = m.job ? ["jobs", m.job.id] : ["cancels", m.cancel!];
      mkdirSync(join(cfg.dir, sub), { recursive: true });
      writeFileSync(join(cfg.dir, sub, `${id}.json`), m.job ? jobText(m.job) : JSON.stringify({ v: 1, id, from: "cain", created: now.toISOString() }, null, 2) + "\n");
      git(cfg, ["add", `${sub}/${id}.json`]);
    }
    const what = made.map((m) => m.job ? `${m.job.step} ${m.job.action} on ${m.job.site}` : `cancel ${m.cancel}`).join("; ");
    git(cfg, ["commit", "--quiet", "-m", `Cain: ${what}`.slice(0, 200)]);
    // Each reuse tap spent before the push, flushed to disk, with the commit each attempt pushes and
    // the remote's answer to it (a failure to write stops the round: nothing more is pushed).
    const taps: Tap[] = made.filter((m) => m.job?.owner_reuse).map((m) => ({ m: m.job!.owner_reuse!.message_id, job: m.job!.id, rid: m.rid, site: m.job!.site, action: m.job!.action }));
    push(cfg, taps);
    const commit = git(cfg, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    cfg.afterPush?.();
    for (const m of made) {
      if (m.job) {
        if (m.job.owner_reuse) {
          try { recordReuse(cfg, m.job.owner_reuse.message_id, m.job.id, "final", m.rid, commit); }
          catch (e) { log(`couldn't finalise the reuse tap for ${m.job.id} (it stays pending, so still spent; the next round settles it): ${(e as Error).message}`); }
        }
        writeOutcome(cfg, { request: m.rid, state: "queued", id: m.job.id });
        log(`queued ${m.job.id} (${m.job.step} ${m.job.action} on ${m.job.site})`);
      } else {
        writeOutcome(cfg, { request: m.rid, state: "cancel_sent", id: m.cancel });
        log(`cancel sent for ${m.cancel}`);
      }
      rmSync(m.file, { force: true });
    }
    return { ok: true, queued: made.filter((m) => m.job).length, refused };
  } catch (e) {
    log(`round didn't finish, will try again: ${(e as Error).message}`);
    return { ok: false, queued: 0, refused: 0 };
  }
}

export async function keep(cfg: Config, pollMs = 2_000, fullMs = 60_000) {
  let due = 0;
  while (true) {
    const waiting = existsSync(cfg.queue) && readdirSync(cfg.queue).some((n) => n.endsWith(".json") && !n.startsWith("."));
    if (Date.now() >= due || waiting) {
      round(cfg);
      due = Date.now() + fullMs;
    }
    await Bun.sleep(pollMs);
  }
}

export function configFromEnv(env = process.env): Config {
  const repo = env.PC_JOBS_REPO || DEFAULT_REPO;
  return {
    remote: env.PC_JOBS_REMOTE ?? `https://github.com/${repo}.git`,
    dir: env.PC_JOBS_DIR ?? "/data/pc-jobs",
    queue: env.PC_JOBS_QUEUE ?? "/data/pc-jobs-queue",
    outcomes: env.PC_JOBS_OUTCOMES ?? "/data/pc-jobs-outcomes",
    branch: env.PC_JOBS_BRANCH ?? "main",
    token: env.PC_JOBS_TOKEN || undefined,
    pub: env.CAIN_SHIP_PUB ?? "/data/trust/ship.pub",
    link: env.CAIN_LINK ?? LINK,
    discordEnv: env.LINK_ENV ?? DISCORD_ENV,
    used: env.PC_JOBS_REUSE_USED ?? USED_REUSE,
  };
}

if (import.meta.main) {
  const cfg = configFromEnv();
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "worker") {
    console.log(heartbeatLine(readHeartbeat(cfg.dir)));
    for (const l of noticeTrouble(cfg)) console.log(l);
  } else if (cmd === "list") {
    console.log(heartbeatLine(readHeartbeat(cfg.dir)));
    for (const l of noticeTrouble(cfg)) console.log(l);
    const jobs = readJobs(cfg.dir);
    if (!jobs.length) console.log("no jobs");
    for (const j of jobs) { const r = readResult(cfg.dir, j.id); console.log(listLine(j, r === "bad" ? null : r)); }
  } else if (cmd === "result") {
    const r = readResult(cfg.dir, arg ?? "");
    if (r === null) console.log("no result yet");
    else if (r === "bad") { console.log("no readable result (the file breaks the format)"); process.exit(1); }
    else console.log(resultLines(r).join("\n"));
  } else if (cmd) {
    console.error("usage: main.ts [list | result <id> | worker]"); process.exit(2);
  } else {
    delete process.env.PC_JOBS_TOKEN;   // kept only in cfg, handed to git per call
    if (!cfg.token) {
      log("no PC job queue token in the App's options; the PC job keeper is waiting");
      while (true) await Bun.sleep(3_600_000);
    }
    log(`keeping the PC job queue (${cfg.remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")})`);
    await keep(cfg);
  }
}
