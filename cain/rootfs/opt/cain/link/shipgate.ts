// The Windows Ship gate, read without acting (0.12.0, seventeenth round): keeper.sh ship-gate.
// For one head of this repository it makes the very reading the landing and the Ship card make
// (merge.ts gateReport) and prints what the gate would decide and why, with the workflow file it
// read and every pcjobs-windows attempt it saw. It reads GitHub's public API only, without a key
// (the link's own 60 reads an hour from this address are shared with it), and changes nothing:
// no card, no landing, nothing written to GitHub.
//   bun shipgate.ts <full head sha>            one report, now (the dry run)
//   bun shipgate.ts <full head sha> --watch    the probe's ship_gate step: a report now, then one
//                                              every --every minutes (default 10) for up to --hours
//                                              (default and most 2), judged (merge.ts judgeShipGate),
//                                              and kept in /data/work/ship-gate-<head>.json
//   bun shipgate.ts --pr <number> --head <full sha> --watch
//                                              the same, started before the push, for the exact sha the
//                                              pusher is about to push (twentieth round): it waits until
//                                              the pull request's head equals that sha, reads and accepts
//                                              only it, and fails by name (other_head, head_moved) if a
//                                              different head appears or the head moves away; kept by
//                                              sha in /data/work/ship-gate-<sha>.json, with the pull
//                                              request, where the Ship card reads it
//   bun shipgate.ts --supersede <full sha>     records that the acceptance kept for that sha is replaced
//                                              (after a rebase), so a card for the pull request's new
//                                              head can go once a new watch accepts it
//   bun shipgate.ts --recover-generation <n> [--floor <number>]
//                                              rewrites pull request n's watch generation above every one recorded,
//                                              under the gate lock (twenty-seventh round)
//   bun shipgate.ts --quarantine <full sha> [--pr <number>]
//                                              sets aside a record that can't be read or doesn't parse, under the gate
//                                              lock, recorded (twenty-eighth round: renamed first, logged after)
//   bun shipgate.ts --quarantine-lock <n>      sets aside pull request n's lock files that don't parse (twenty-eighth round)
//   bun shipgate.ts --set-aside <file> --pr <n>
//                                              moves a set-aside file that the quarantine log doesn't record and whose name
//                                              names no pull request to the archive folder (ship-gate-set-aside/), logged,
//                                              never deleted, under pull request n's gate lock (0.12.2)
// Every watch ends with a named failure past its caps (merge.ts): one wait GitHub asks for over 15
// minutes (rate_wait_cap), or 2 hours in all (watch_cap).
// Every GitHub API read here goes through one wrapper (ghGet, twenty-seventh round). Without a token GitHub allows 60
// reads an hour from this address, shared with the link: a watch reads about 4 to 8 pages every 10 minutes (the pull
// request's head, the head's check runs and the workflow's runs), so a watch running beside the link's own reads can
// expect a rate-limit refusal now and then in a busy hour; each is told apart (a hold, or head_not_current naming the
// rate limit, or an owed supersede), never read as a moved head or a failed check.
import { appendFileSync, closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { GATE_RECORD_FORMAT, gateReport, shaBound, watchAccepted, watchFile, watchShipGate, type MergeDeps, type WatchLine } from "./merge";

export const SHIP_REPO = "HyndeSyte/harness";
export const WATCH_DIR = "/data/work";
const SHA = /^[0-9a-f]{40}$/;
// Twenty-seventh round: every GitHub API read this file makes (the watch's gate reports and head reads, the
// acceptance's head checks, the supersede's head read) goes through the one request wrapper, ghGet below, so a rate
// limit is classified and retried the same way everywhere. api is that wrapper for merge.ts's readers.
// Twenty-eighth round: without a token (60 reads an hour from this address, shared with the link) a page read is never
// retried (pageRetries): a refused page holds the gate's reading as before, and the refusal says how many reads are left.
export const pageRetries = (env = process.env): number => githubToken(env) ? HEAD_READ_RETRIES : 0;
export const ghPage = (path: string, o: { base?: string; env?: NodeJS.ProcessEnv; curl?: string } = {}) =>
  ghGet(path, { token: githubToken(o.env), maxS: API_READ_S, retries: pageRetries(o.env), ...(o.base ? { base: o.base } : {}), ...(o.curl ? { curl: o.curl } : {}) });
// Twenty-ninth round: a read that failed on the Pi's side (curl missing, older than 7.32, or failing before it reached
// GitHub) is named as that, never as GitHub not answering (missWords).
export const pageApi = (o: { base?: string; env?: NodeJS.ProcessEnv; curl?: string } = {}) => async (path: string): Promise<{ status: number; body: any; headers: Record<string, string> }> => {
  const r = ghPage(path, o);
  if ("miss" in r) throw new Error(missWords(r));
  return { status: r.status, body: r.body, headers: r.headers };
};
const api = pageApi();
// Every unsuperseded acceptance a watch of this pull request kept (ship-gate-<sha>.json), as the
// Ship card reads them (link/main.ts gateWatch). An unreadable file counts as none.
// Twenty-fifth round: only those written under the pull request's generation as it is now (merge.ts
// watchAccepted with readGen): an acceptance written by a holder that was taken over is no acceptance at once,
// and a generation file that can't be read leaves none.
// Twenty-sixth round: the gate's state as a result of its own. "unknown" (refusing the card by name, never read as
// no acceptance) when the generation can't be read (unreadable, or missing while any lock or record of the pull
// request carries a generation), the folder can't be listed, or a kept record can't be read or parsed.
// Twenty-eighth round: a live acceptance whose record carries an owed supersede (supersede_owed: the supersede was stopped
// by GitHub's rate limit) is still the pull request's one live acceptance for the watch's rules, but it is not current
// for the Ship card: owed names it with its wait, and the card refuses on it. late: the deadline given passed between two
// records (the watch's critical section, checked per file), told apart from an unreadable state.
export type GateState = { heads: string[]; owed?: string } | { unknown: string; late?: true };
export const owedWhy = (sha: string, o: any) => {
  const m = Number.isInteger(o?.wait_minutes) && o.wait_minutes > 0 ? o.wait_minutes : null;
  return `the acceptance of ${sha} has a supersede owed: GitHub's rate limit stopped it${m !== null ? ` (it asked to wait about ${m} minutes)` : ""}, so that acceptance is not current; once the wait is over run: /opt/cain/keeper.sh ship-gate --supersede ${sha}, then watch the pull request's head again`;
};
const PAST_DEADLINE = "the watch's time under its lock ran out while it read the gate's records";
// Twenty-seventh round: which pull request a record belongs to. Parsed, its pr; a record that doesn't parse, the
// "pr" its text still shows; else unknown (null). A record that can't be read or parsed counts against a pull
// request only when it is that pull request's own or can't be told apart (one garbled record of another pull
// request never blocks this one), and the refusal names it with its recovery (quarantineRecord).
const prInText = (text: string): number | null => { const m = /"pr"\s*:\s*(\d{1,7})\b/.exec(text); return m ? Number(m[1]) : null; };
export const recordName = /^ship-gate-([0-9a-f]{40})\.json$/;
// 0.12.2: a record set aside by the quarantine: ship-gate-<sha>.json.quarantined-pr<n>-<random> (the pull request in its
// name), or, made by an earlier version, any other ship-gate-<sha>.json.quarantined-<suffix> (no pull request: group 2 unset).
export const quarantinedName = /^ship-gate-([0-9a-f]{40})\.json\.quarantined-(?:pr(\d{1,7})-[0-9a-f]+|.+)$/;
export const quarantineWhy = (f: string, sha: string, how: string, pr?: number) =>
  `a record of the gate (${f}) ${how}, and it may be this pull request's: once no watch runs, set it aside with: /opt/cain/keeper.sh ship-gate --quarantine ${sha}${pr !== undefined ? ` --pr ${pr}` : ""}, then try again`;
export const lockQuarantineWhy = (f: string, pr: number, how: string) =>
  `the pull request's watch lock (${f}) ${how}: once no watch of it runs, set it aside with: /opt/cain/keeper.sh ship-gate --quarantine-lock ${pr}, then try again`;
export function gateState(dir: string, pr: number, deadline?: number): GateState {
  const late = () => deadline !== undefined && Date.now() > deadline;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { heads: [] } : { unknown: `the folder of the gate's records (${dir}) can't be listed` }; }
  const gen = readGen(dir, pr);
  if (gen === null) return { unknown: genUnreadable(dir, pr) };
  // Twenty-ninth round: a missing record is a refusal, not "no gate". While a quarantine or a generation recovery of this
  // pull request holds its lock, a record may be away from its path (between the quarantine's rename and its put-back),
  // so the gate's state is unknown; and a record set aside under a quarantine name that the quarantine log doesn't
  // name (a quarantine cut off between its rename and its log entry or put-back) keeps it unknown, with its restore.
  const busy = recoveryRunning(dir, pr);
  if (busy) return { unknown: busy };
  // 0.12.2: a quarantine log that can't be read refuses by name, with no restore command (which files it records can't
  // be told, so a restore could bring back a record set aside on purpose).
  const ql = quarantined(dir);
  if ("unreadable" in ql) return { unknown: ql.unreadable };
  const logged = new Set(quarantineEntries(ql).map((q) => q.as).filter((a): a is string => a !== null));
  for (const n of names) {
    const q = quarantinedName.exec(n);
    if (!q || logged.has(`${dir}/${n}`)) continue;
    // 0.12.2: the pull request is the one the quarantine's file name carries (quarantineRecord names it), never what the
    // set-aside text shows. A name that carries none (one an earlier version made) can't be told apart: it refuses every
    // pull request, with the command that moves it to the archive folder (setAside), never a restore.
    const p = q[2] !== undefined ? Number(q[2]) : null;
    if (p !== null && p !== pr) continue;
    if (p === null) return { unknown: `a file set aside from the gate's records (${dir}/${n}) was not recorded, and its name names no pull request, so it can't be told whose it is: once no watch runs, move it to the archive folder with: /opt/cain/keeper.sh ship-gate --set-aside ${dir}/${n} --pr ${pr}, then try again` };
    return { unknown: `a record of the gate was set aside (${dir}/${n}) without being recorded or put back (a quarantine was cut off): ${restoreCmd(`${dir}/${n}`, `${dir}/ship-gate-${q[1]}.json`)}, then try again` };
  }
  const out: string[] = [];
  let owed: string | undefined;
  for (const n of names) {
    const m = recordName.exec(n);
    if (!m) continue;
    // Twenty-eighth round: the deadline checked before each record is read and parsed, so a slow disk overshoots it by
    // at most one file's read.
    if (late()) return { unknown: PAST_DEADLINE, late: true };
    let text: string;
    try { text = readFileSync(`${dir}/${n}`, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; return { unknown: quarantineWhy(`${dir}/${n}`, m[1], "can't be read", pr) }; }
    let x: any;
    try { x = JSON.parse(text); } catch { const p = prInText(text); if (p !== null && p !== pr) continue; return { unknown: quarantineWhy(`${dir}/${n}`, m[1], "doesn't parse", pr) }; }
    const a = watchAccepted(text, gen);
    if (a && a.pr === pr && a.head === m[1]) { out.push(a.head); if (x?.supersede_owed) owed ??= owedWhy(a.head, x.supersede_owed); }
  }
  if (late()) return { unknown: PAST_DEADLINE, late: true };
  return { heads: out.sort(), ...(owed ? { owed } : {}) };
}
// Twenty-seventh round: no lossy mapping. The live acceptances of a pull request, or the gate state unknown, tagged:
// every caller handles the unknown answer itself (Accepted is GateState's own shape with the heads as a plain list).
export type Accepted = string[] | { unknown: string };
export function acceptedFor(dir: string, pr: number, deadline?: number): Accepted {
  const st = gateState(dir, pr, deadline);
  if ("heads" in st) return st.heads;
  if ("unknown" in st) return { unknown: st.unknown };
  return unreachable(st);
}
export function unreachable(x: never): never { throw new Error(`ship gate: an answer no caller handles (${JSON.stringify(x)})`); }
// One live acceptance per pull request (0.12.0, twenty-first round): the live (not superseded)
// acceptances of a pull request other than this head. A watch refuses to accept while any stands
// (live_acceptance, naming it), so the Ship card always reads exactly one. Twenty-seventh round: or the gate state
// unknown, which the caller must handle (a watch accepts nothing on it).
export const otherLive = (dir: string, pr: number, head: string, deadline?: number): Accepted => { const a = acceptedFor(dir, pr, deadline); return Array.isArray(a) ? a.filter((h) => h !== head) : a; };
export const liveWhy = (other: string[]) =>
  `another live acceptance of this pull request stands (${other.join(", ")}): supersede it first (keeper.sh ship-gate --supersede ${other[0]}, once the pull request's head has moved past it), then watch again`;
// The watch's line as it is kept: an acceptance is kept only when no other live acceptance of its pull
// request stands, read again as it is written; otherwise it is kept as a failure (live_acceptance).
// Twenty-second round: the check and the write happen under the pull request's own lock file
// (ship-gate-pr-<n>.lock, made exclusively), so two watches of one pull request finishing together can't
// both pass the check before either writes: the second waits for the lock (o.waitMs, default 10 seconds),
// then checks again and sees the first; a lock another watch still held at that time keeps its line as a failure
// (live_acceptance), never an acceptance, and one that couldn't be read keeps it as lock_unavailable, with a notice.
// Twenty-third round, the lock made true:
// - the lock holds a token of its holder ({pid, token, at}); its time is refreshed at the check and before the write
//   (beat; not periodically), and the holder checks it still holds its own token before it
//   writes and before it lets go, so it never writes on, or removes, a lock that isn't its own;
// - a lock whose time is older than LOCK_STALE_MS (a watch killed holding it) is taken over only by an atomic
//   rename of it to a name of the taker's own, then the exclusive create again: exactly one contender proceeds (the
//   renamer may lose the exclusive create to another watch, which is fine: that watch holds it), and it checks
//   the live acceptances again after it has the lock (keepWatch). A rename that turns out to have caught a fresh lock
//   (one made between the stat and the rename) puts it back where it was, and backs off;
// - the critical section is bounded far below LOCK_STALE_MS. Twenty-seventh round: by one deadline for the whole
//   section, CRITICAL_MAX_MS from the moment the lock is held, not by a check before the head reads. Both head reads
//   (before and after the write) take their curl time and their rate-limit waits from what is left of it (never per
//   try), and after the head reads, immediately before the fenced write, the elapsed bound, the lock's token and the
//   generation are checked again; past the deadline nothing is accepted (lock_unavailable, criticalNotice), and an
//   acceptance already written is taken back.
//   Twenty-eighth round, the bound said as it is: what is bounded is the acceptance window (nothing is accepted past
//   CRITICAL_MAX_MS from taking the lock), not how long the lock is held. A live holder normally lets go within
//   CRITICAL_MAX_MS + CRITICAL_SLACK_MS (11 seconds), a quarter of LOCK_STALE_MS (asserted below), but the synchronous
//   file reads and writes can't be interrupted, so under a disk stall the holding is unbounded. The deadline is checked
//   before each record is parsed and before each live check (gateState), so the overshoot is one file's read; a head
//   read's overshoot is bounded by its curl limit plus the process-side kill (CURL_KILL_MARGIN_MS). A holder stalled past
//   LOCK_STALE_MS is taken over, and the takeover fences it: the token check and the generation make every later write
//   and take-back of the stalled holder count for nothing;
// - a lock that can't be read (its time or its holder) counts as held: the taker backs off until its deadline,
//   then fails lock_unavailable with a notice.
export const LOCK_STALE_MS = 60_000;
export const CRITICAL_MAX_MS = 10_000;
export const CRITICAL_SLACK_MS = 1_000;
if ((CRITICAL_MAX_MS + CRITICAL_SLACK_MS) * 4 > LOCK_STALE_MS) throw new Error("ship gate: the lock's stale threshold must be at least four times its critical section's worst case");
const lockFile = (dir: string, pr: number) => `${dir}/ship-gate-pr-${pr}.lock`;
// Twenty-ninth round: a current lock of the pull request taken in recovery mode (a quarantine or a generation recovery
// at work), named for the Ship card's refusal; null otherwise (no lock, a watch's own lock, or a stale one).
function recoveryRunning(dir: string, pr: number): string | null {
  const f = lockFile(dir, pr);
  try {
    if (Date.now() - statSync(f).mtimeMs > LOCK_STALE_MS) return null;
    return JSON.parse(readFileSync(f, "utf8"))?.recovery === true ? `a quarantine or a generation recovery of this pull request is at work (its lock, ${f}, is current), so a record may be away from its place: try again in a minute` : null;
  } catch { return null; }
}
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Twenty-fifth round, the generation (a fencing token): the pull request's watch generation is kept beside its lock
// (ship-gate-pr-<n>.gen, a whole number written whole: a temporary file, then renamed; twenty-sixth round: a missing
// file is fail-closed while any lock or record carries a generation, and new files start at 1, genOf below). Each
// takeover of a stale lock moves it on by one before the lock is made again, every lock records the generation it
// was made under, and every acceptance records the lock's generation (gen). The Ship card (acceptedFor) and the
// watch's own checks count an acceptance only under the generation as it is now, so a holder taken over can't make
// a live acceptance by writing late: what it writes is no acceptance from the moment of the takeover.
export const genFile = (dir: string, pr: number) => `${dir}/ship-gate-pr-${pr}.gen`;
const genOfLock = (f: string) => f.replace(/\.lock$/, ".gen");
// Twenty-sixth round, the generation never resets. A missing generation file is fail-closed (null: nothing counts)
// whenever any lock or record of the pull request carries a generation; only when none does (a pull request never
// watched under this round, or only records from before it, which never count) does it read as 0, and the next lock
// starts the file at 1. The recovery for a missing or unreadable file (recoverGen, keeper.sh ship-gate
// --recover-generation <number>) rewrites it whole with a number above any generation recorded, never deletes it.
type GenRaw = number | "missing" | null;
function genRaw(f: string): GenRaw {
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null; }
  return /^\d{1,15}\n?$/.test(text) ? Number(text.trim()) : null;
}
// What the pull request's locks and records say about its generations: whether any carries one (or can't be read, so
// might), and the highest recorded (a record's gen, or gen_floor: the generation a watch knew when it wrote its line).
// Twenty-seventh round: only this round's records (GATE_RECORD_FORMAT) and locks make a missing file fail closed;
// records from before it never count (watchAccepted) and so never block, though their numbers still raise max. A
// record that can't be read or parsed counts only when it is this pull request's own or can't be told apart, and is
// named (blocker), with its recovery: set it aside (quarantineRecord). Quarantined records' numbers raise max too.
export function genRecorded(dir: string, pr: number): { any: boolean; max: number; blocker?: string } {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { return { any: (e as NodeJS.ErrnoException).code !== "ENOENT", max: 0 }; }
  let any = false, max = 0, blocker: string | undefined;
  const num = (v: unknown, counts: boolean) => { if (Number.isInteger(v) && (v as number) >= 1) { if (counts) any = true; max = Math.max(max, v as number); } };
  const lock = `ship-gate-pr-${pr}.lock`;
  for (const n of names) {
    const isLock = n === lock || (n.startsWith(`${lock}.stale-`) && !n.includes(".quarantined-"));
    const rec = recordName.exec(n);
    if (!isLock && !rec) continue;
    let text: string;
    try { text = readFileSync(`${dir}/${n}`, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") { any = true; blocker ??= rec ? quarantineWhy(`${dir}/${n}`, rec[1], "can't be read", pr) : lockQuarantineWhy(`${dir}/${n}`, pr, "can't be read"); } continue; }
    if (isLock && text.trim() === "") continue;                   // the twenty-second round's empty lock: no generation
    let x: any;
    try { x = JSON.parse(text); }
    catch {
      if (isLock) { any = true; blocker ??= lockQuarantineWhy(`${dir}/${n}`, pr, "doesn't parse"); continue; }
      const p = prInText(text);
      if (p !== null && p !== pr) continue;                       // another pull request's garbled record
      any = true; blocker ??= quarantineWhy(`${dir}/${n}`, rec![1], "doesn't parse", pr);
      continue;
    }
    if (rec && x?.pr !== pr) continue;
    const counts = isLock || x?.format === GATE_RECORD_FORMAT;
    num(x?.gen, counts); num(x?.gen_floor, counts);
  }
  // 0.12.2: a quarantine log that can't be read may hold a generation above every one here: it blocks the recovery
  // (unless a floor is given) and makes a missing generation file fail closed.
  const ql = quarantined(dir);
  if ("unreadable" in ql) { any = true; blocker ??= ql.unreadable; }
  for (const q of quarantineEntries(ql)) if (q.pr === null || q.pr === pr) num(q.gen_max, false);
  return { any, max, ...(blocker ? { blocker } : {}) };
}
function genOf(f: string): number | null {
  const raw = genRaw(f);
  if (raw !== "missing") return raw;
  const m = /ship-gate-pr-(\d+)\.gen$/.exec(f);
  return m && genRecorded(dirname(f), Number(m[1])).any ? null : 0;
}
export const readGen = (dir: string, pr: number) => genOf(genFile(dir, pr));
export function genUnreadable(dir: string, pr: number): string {
  const recover = `once no watch of this pull request is running, rewrite it with: /opt/cain/keeper.sh ship-gate --recover-generation ${pr}, then watch the pull request's head again`;
  if (genRaw(genFile(dir, pr)) === "missing") {
    const r = genRecorded(dir, pr);
    if (r.blocker) return `the pull request's watch generation (${genFile(dir, pr)}) is missing and ${r.blocker}; if the refusal then names the generation file, ${recover}`;
  }
  return `the pull request's watch generation (${genFile(dir, pr)}) can't be read, or is missing while its locks or records carry one, so no acceptance counts; ${recover}`;
}
function writeGen(f: string, n: number, exclusive = false): boolean {
  const tmp = `${f}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, `${n}\n`);
    if (exclusive) linkSync(tmp, f); else renameSync(tmp, f);
    return true;
  } catch { return false; } finally { rmSync(tmp, { force: true }); }
}
// The generation a new lock is made under: the file's number; a missing file with no generation recorded anywhere
// starts at 1 (made exclusively: a file someone else made meanwhile is read instead); anything else is null.
function genForLock(f: string): number | null {
  const g = genOf(f);
  if (g === null || g >= 1) return g;
  if (genRaw(f) !== "missing") return null;                        // a file that reads 0 (written before this round)
  if (writeGen(f, 1, true)) return 1;
  const again = genRaw(f);
  return typeof again === "number" && again >= 1 ? again : null;
}
function bumpGen(f: string): boolean {
  const g = genOf(f);
  if (g === null) return false;
  return writeGen(f, g + 1);
}
// keeper.sh ship-gate --quarantine <sha> (twenty-seventh round): the recovery for a record that can't be read or
// doesn't parse. It is set aside by rename (ship-gate-<sha>.json.quarantined-<random>, which no reader takes for a
// record), and the quarantine is recorded in ship-gate-quarantine.jsonl with the pull request its text still shows
// and the highest generation its text still shows, so a later recovery of the generation starts above it. A record
// that reads and parses is never set aside.
export const quarantineLog = (dir: string) => `${dir}/ship-gate-quarantine.jsonl`;
// 0.12.2: the log read in three states. entries: what it records (a torn line is skipped, as before); absent: no log
// (nothing was ever set aside); unreadable: a log that is there but can't be read, named (quarantineLogWhy). Every
// caller handles unreadable itself: the gate's state is unknown (never a reading in which nothing was set aside), and
// no restore command is offered, since which files the log records can't be told.
export type QuarantineEntry = { file: string; as: string | null; pr: number | null; gen_max: number | null };
export type QuarantineLogRead = { entries: QuarantineEntry[] } | { absent: true } | { unreadable: string };
export function quarantined(dir: string): QuarantineLogRead {
  let text = "";
  try { text = readFileSync(quarantineLog(dir), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { absent: true } : { unreadable: quarantineLogWhy(dir) }; }
  const out: QuarantineEntry[] = [];
  for (const l of text.split("\n")) { try { const x = JSON.parse(l); if (typeof x?.file === "string") out.push({ file: x.file, as: typeof x.as === "string" ? x.as : null, pr: Number.isInteger(x.pr) ? x.pr : null, gen_max: Number.isInteger(x.gen_max) ? x.gen_max : null }); } catch { /* a torn line */ } }
  return { entries: out };
}
export const quarantineEntries = (r: QuarantineLogRead): QuarantineEntry[] => "entries" in r ? r.entries : [];
export const quarantineLogWhy = (dir: string) =>
  `the gate's quarantine log (${quarantineLog(dir)}) is there but can't be read, so which records were set aside can't be told: make that file readable again (never delete it), then try again`;
// Twenty-eighth round, the quarantine made safe against a watch: it takes the pull request's gate lock through the same
// takeover as the recovery (a lock that looks current refuses it: a watch is running), checks again under the lock that
// the record still can't be read or parsed, renames first, then reads what it actually moved: a record that parses
// after all (written meanwhile) is put back and nothing is set aside. Only after the rename does it append its log
// entry, with the pull request and the generations of the contents it moved; a log entry that can't be written puts
// the record back, so the log never names a file that wasn't moved and no moved file goes unlogged. The pull request
// is the one the record's text shows, or (a record that names none) the one given with --pr.
export interface QuarantineOpts { pr?: number; staleMs?: number; waitMs?: number; beforeRename?: () => void; rename?: (from: string, to: string) => void }
const gensIn = (text: string | null) => text === null ? [] : [...text.matchAll(/"gen(?:_floor)?"\s*:\s*(\d{1,15})\b/g)].map((m) => Number(m[1]));
const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };
type ReadText = { text: string } | { gone: true } | { unreadable: true };
const readText = (f: string): ReadText => { try { return { text: readFileSync(f, "utf8") }; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { gone: true } : { unreadable: true }; } };
// Twenty-ninth round: a put-back that fails (a newer file stands at the destination, or the link itself fails) never
// deletes what was moved: it stays under its quarantine name, the caller logs it with the failure, and the restore
// command is printed. Only a put-back that linked the file into place removes the moved name.
const putBack = (as: string, f: string): string | null => {
  try { linkSync(as, f); } catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === "EEXIST" ? `a newer file now stands at ${f}` : `the link back failed (${c ?? "an error"})`; }
  rmSync(as, { force: true });
  return null;
};
export const restoreCmd = (as: string, f: string) => `once no watch of this pull request runs, and after setting aside or removing whatever now stands at ${f}, restore it with: mv -n ${as} ${f}`;
const logPutBackFailed = (dir: string, e: { file: string; as: string; pr: number | null; text: string | null; why: string }): boolean => {
  const g = gensIn(e.text);
  try { appendFileSync(quarantineLog(dir), JSON.stringify({ file: e.file, as: e.as, pr: e.pr, gen_max: g.length ? Math.max(...g) : null, put_back_failed: e.why, at: new Date().toISOString() }) + "\n"); return true; } catch { return false; }
};
export function quarantineRecord(dir: string, sha: string, o: QuarantineOpts = {}): { ok: true; as: string } | { ok: false; why: string } {
  if (!SHA.test(sha)) return { ok: false, why: "that isn't a full commit sha" };
  const f = watchFile(dir, sha);
  const first = readText(f);
  if ("gone" in first) return { ok: false, why: `no record is kept for ${sha} (${f})` };
  if ("text" in first && parses(first.text)) return { ok: false, why: `the record kept for ${sha} (${f}) reads and parses: it is never set aside` };
  const shown = "text" in first ? prInText(first.text) : null;
  if (shown !== null && o.pr !== undefined && shown !== o.pr) return { ok: false, why: `the record kept for ${sha} (${f}) shows pull request ${shown}, not ${o.pr}: nothing was changed` };
  const pr = shown ?? o.pr;
  if (pr === undefined) return { ok: false, why: `the record kept for ${sha} (${f}) names no pull request: name the one whose refusal gave this command with --pr <number>; nothing was changed` };
  const lock = lockFile(dir, pr);
  const got = takeLock(lock, o.waitMs ?? 2_000, { staleMs: o.staleMs, recovery: true });
  if (!("token" in got)) return { ok: false, why: got.miss === "held"
    ? `a watch of pull request ${pr} looks to be running (its lock, ${lock}, is current): run this again once it is done; nothing was changed`
    : `the pull request's watch lock (${lock}) can't be read or taken: nothing was changed` };
  try {
    // Under the lock, the record again: still there, and still not a record that parses.
    const again = readText(f);
    if ("gone" in again) return { ok: false, why: `no record is kept for ${sha} (${f}) any more: nothing was changed` };
    if ("text" in again && parses(again.text)) return { ok: false, why: `the record kept for ${sha} (${f}) was rewritten and now reads and parses: it is never set aside; nothing was changed` };
    o.beforeRename?.();
    // 0.12.2: the quarantine's name carries the pull request (quarantinedName), which the gate's state reads from it.
    const as = `${f}.quarantined-pr${pr}-${randomBytes(4).toString("hex")}`;
    try { (o.rename ?? renameSync)(f, as); } catch { return { ok: false, why: `the record (${f}) couldn't be set aside: nothing was changed` }; }
    const moved = readText(as);
    if ("text" in moved && parses(moved.text)) {
      const failed = putBack(as, f);
      if (failed) {
        const logged = logPutBackFailed(dir, { file: f, as, pr, text: moved.text, why: failed });
        return { ok: false, why: `the record kept for ${sha} (${f}) was rewritten while it was being set aside and now reads and parses, but it couldn't be put back (${failed}): it was left as ${as}${logged ? `, recorded in ${quarantineLog(dir)}` : ", and that couldn't be recorded either"}; ${restoreCmd(as, f)}` };
      }
      return { ok: false, why: `the record kept for ${sha} (${f}) was rewritten while it was being set aside and now reads and parses: it was put back, and nothing was set aside` };
    }
    const text = "text" in moved ? moved.text : null;
    const gens = gensIn(text);
    try { appendFileSync(quarantineLog(dir), JSON.stringify({ file: f, as, pr: text === null ? pr : prInText(text) ?? pr, gen_max: gens.length ? Math.max(...gens) : null, at: new Date().toISOString() }) + "\n"); }
    catch {
      const failed = putBack(as, f);
      return { ok: false, why: failed
        ? `the quarantine couldn't be recorded (${quarantineLog(dir)}), and the record couldn't be put back (${failed}): it was left as ${as}; ${restoreCmd(as, f)}`
        : `the quarantine couldn't be recorded (${quarantineLog(dir)}): the record was put back, and nothing was changed` };
    }
    return { ok: true, as };
  } finally { letGo(got); }
}
// keeper.sh ship-gate --set-aside <file> --pr <number> (0.12.2): the recovery for a file set aside from the gate's
// records that the quarantine log doesn't record and whose name names no pull request (one an earlier version made),
// which refuses every pull request's card. It never deletes: under the gate lock of the pull request whose refusal gave
// the command (taken as the quarantines take it, in recovery mode), the file is linked into the archive folder
// (ship-gate-set-aside/, under a name of its own), the move is logged in the quarantine log with the generations its
// text shows, and only then is its old name removed. Cut off before the log entry, the file still stands where it was
// (run it again); a log entry that can't be written removes the archive's name again, and nothing was changed.
export const setAsideDir = (dir: string) => `${dir}/ship-gate-set-aside`;
export function setAside(dir: string, file: string, pr: number, o: { staleMs?: number; waitMs?: number } = {}): { ok: true; as: string } | { ok: false; why: string } {
  const name = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
  const q = name !== null && !name.includes("/") ? quarantinedName.exec(name) : null;
  if (!q) return { ok: false, why: `${file} isn't a file set aside from the gate's records in ${dir}: nothing was changed` };
  if (q[2] !== undefined) return { ok: false, why: `${file} names pull request ${q[2]}: restore it as the refusal says, or quarantine it again; nothing was changed` };
  const lock = lockFile(dir, pr);
  const got = takeLock(lock, o.waitMs ?? 2_000, { staleMs: o.staleMs, recovery: true });
  if (!("token" in got)) return { ok: false, why: got.miss === "held"
    ? `a watch of pull request ${pr} looks to be running (its lock, ${lock}, is current): run this again once it is done; nothing was changed`
    : `the pull request's watch lock (${lock}) can't be read or taken: nothing was changed` };
  try {
    const t = readText(file);
    if ("gone" in t) return { ok: false, why: `${file} is no longer there: nothing was changed` };
    const ql = quarantined(dir);
    if ("unreadable" in ql) return { ok: false, why: `${ql.unreadable}; nothing was changed` };
    const as = `${setAsideDir(dir)}/${name}.set-aside-${randomBytes(4).toString("hex")}`;
    try { mkdirSync(setAsideDir(dir), { recursive: true }); linkSync(file, as); } catch { return { ok: false, why: `${file} couldn't be moved to ${setAsideDir(dir)}: nothing was changed` }; }
    const g = gensIn("text" in t ? t.text : null);
    try { appendFileSync(quarantineLog(dir), JSON.stringify({ file, as, pr: null, gen_max: g.length ? Math.max(...g) : null, set_aside: true, at: new Date().toISOString() }) + "\n"); }
    catch { rmSync(as, { force: true }); return { ok: false, why: `the move couldn't be recorded (${quarantineLog(dir)}): ${file} stays where it was, and nothing was changed` }; }
    try { rmSync(file); } catch { return { ok: false, why: `${file} was linked into ${as} and recorded, but its old name couldn't be removed: run this again` }; }
    return { ok: true, as };
  } finally { letGo(got); }
}
// keeper.sh ship-gate --quarantine-lock <number> (twenty-eighth round): a lock file of the pull request whose text
// doesn't parse (its lock, or a takeover's leftover ship-gate-pr-<n>.lock.stale-<token>) blocks the pull request by
// name; this sets each aside, under the pull request's lock, and each file moved is logged with any generation its text
// shows, so a later recovery of the generation starts above it.
// 0.12.2: the lock is taken in recovery mode before anything is moved, and the pull request's own lock, when it doesn't
// parse, is moved aside by that takeover itself (takeLock with garbled): its rename is the move, so it is fenced like every
// takeover (one renamer wins, what was moved is checked and a lock that parses after all is put back, never deleted, and
// the generation moves on before this taker's exclusive create). The exception, said as it is: a lock that doesn't
// parse stands at the lock's path, so it can't be held before it is moved; as in every takeover the move comes first,
// and its log entry is written once the lock is held. Unlike a stale lock it is taken at any age: no holder can pass a
// fence check on it (ownsLock reads its token), and the generation's move fences one that passed its last check before.
export function quarantineLock(dir: string, pr: number, o: { staleMs?: number; waitMs?: number } = {}): { ok: true; moved: string[] } | { ok: false; why: string } {
  const lock = lockFile(dir, pr);
  const base = lock.slice(dir.length + 1);
  let names: string[];
  try { names = readdirSync(dir); } catch { return { ok: false, why: `the folder of the gate's records (${dir}) can't be listed: nothing was changed` }; }
  const moved: LockAside[] = [];
  const log = (): boolean => {
    try {
      for (const m of moved) { const g = gensIn(m.text); appendFileSync(quarantineLog(dir), JSON.stringify({ file: m.file, as: m.as, pr, gen_max: g.length ? Math.max(...g) : null, ...(m.failed ? { put_back_failed: m.failed } : {}), at: new Date().toISOString() }) + "\n"); }
      return true;
    } catch { return false; }
  };
  const lockBad = names.includes(base) && lockGarbled(lock);
  const leftovers = names.filter((n) => n.startsWith(`${base}.stale-`) && !n.includes(".quarantined-"));
  if (!lockBad && !leftovers.some((n) => lockGarbled(`${dir}/${n}`))) return { ok: false, why: `no lock file of pull request ${pr} fails to parse (${lock}): nothing was changed` };
  // 0.12.2: the lock is taken first, in recovery mode; a lock that doesn't parse is moved aside by that takeover.
  const got = takeLock(lock, o.waitMs ?? 2_000, { staleMs: o.staleMs, recovery: true, garbled: true });
  if (got.setAside) moved.push(got.setAside);
  if (!("token" in got)) {
    const logged = log();
    const set = moved.some((m) => !m.failed);
    return { ok: false, why: got.miss === "unreadable" && !set && lockGarbled(lock)
      ? `the lock that didn't parse (${lock}) couldn't be set aside: the pull request's watch generation (${genFile(dir, pr)}) couldn't be moved on, so the lock was left where it was; run this again`
      : `${set ? `the lock that didn't parse was set aside${logged ? "" : ", but its quarantine couldn't be recorded"}; ` : ""}a watch of pull request ${pr} took the lock meanwhile (${lock}): run this again once it is done` };
  }
  try {
    for (const n of leftovers) if (lockGarbled(`${dir}/${n}`)) { const m = lockAside(`${dir}/${n}`); if (m) moved.push(m); }
    if (!log()) return { ok: false, why: `the quarantine couldn't be recorded (${quarantineLog(dir)}): the files were set aside as ${moved.map((m) => m.as).join(", ")}` };
    return { ok: true, moved: moved.filter((m) => !m.failed).map((m) => m.as) };
  } finally { letGo(got); }
}
// A lock file that doesn't parse (or can't be read), and its move aside by rename (twenty-eighth round; 0.12.2: shared
// with the takeover in takeLock): a lock that parses after all is put back, and one whose put-back fails is kept under
// its quarantine name with the failure (twenty-ninth round), never deleted. null: nothing was set aside.
type LockAside = { file: string; as: string; text: string | null; failed?: string };
const lockGarbled = (f: string) => { const r = readText(f); return "unreadable" in r || ("text" in r && r.text.trim() !== "" && !parses(r.text)); };
function lockAside(f: string): LockAside | null {
  const as = `${f}.quarantined-${randomBytes(4).toString("hex")}`;
  try { renameSync(f, as); } catch { return null; }
  const r = readText(as);
  if ("text" in r && (r.text.trim() === "" || parses(r.text))) {
    const failed = putBack(as, f);
    if (failed) { console.error(`ship gate: ${f} parsed after all but couldn't be put back (${failed}): it was left as ${as}; ${restoreCmd(as, f)}`); return { file: f, as, text: r.text, failed }; }
    return null;
  }
  return { file: f, as, text: "text" in r ? r.text : null };
}
// keeper.sh ship-gate --recover-generation <number> [--floor <number>]: the documented recovery for a generation file
// that is missing (while records carry one) or can't be read. Twenty-seventh round: it takes the gate lock itself,
// through the same rename-then-exclusive-create takeover as a watch (a lock that looks current refuses it: a watch is
// running), so a watch taking over a stale lock at the same moment can't read the old generation while this renames a
// higher one into place. Holding it, it reads the highest generation the file, the pull request's locks (the one it
// took over included), its records and its quarantined records hold, writes one above it (and above --floor, an
// explicit floor for what can't be read) whole, a temporary file renamed into place, then reads the file, the locks
// and the records again and fails if anything is above what it wrote (run it again), and lets go. A record of the
// pull request that can't be read or parsed refuses it until that record is set aside (quarantineRecord), unless a
// floor is given.
export function recoverGen(dir: string, pr: number, o: { staleMs?: number; waitMs?: number; floor?: number; afterWrite?: () => void; afterTakeover?: () => void } = {}): { ok: true; gen: number } | { ok: false; why: string } {
  const lock = lockFile(dir, pr);
  try { mkdirSync(dir, { recursive: true }); } catch { return { ok: false, why: `the folder of the gate's records (${dir}) can't be made: nothing was changed` }; }
  const got = takeLock(lock, o.waitMs ?? 2_000, { staleMs: o.staleMs, recovery: true, afterTakeover: o.afterTakeover });
  if (!("token" in got)) return { ok: false, why: got.miss === "held"
    ? `a watch of pull request ${pr} looks to be running (its lock, ${lock}, is current): run this again once it is done`
    : `the pull request's watch lock (${lock}) can't be read or taken: nothing was changed` };
  try {
    // Twenty-eighth round: temporary files a cut-off write of the generation left behind are deleted here.
    try { for (const n of readdirSync(dir)) if (n.startsWith(`ship-gate-pr-${pr}.gen.tmp-`)) rmSync(`${dir}/${n}`, { force: true }); } catch { /* the listing is read again below */ }
    const rec = genRecorded(dir, pr);
    if (rec.blocker && o.floor === undefined) return { ok: false, why: `${rec.blocker}; nothing was changed` };
    const raw = genRaw(genFile(dir, pr));
    const n = Math.max(rec.max, typeof raw === "number" ? raw : 0, got.seen ?? 0, o.floor ?? 0) + 1;
    if (!writeGen(genFile(dir, pr), n)) return { ok: false, why: `the generation file (${genFile(dir, pr)}) couldn't be written: nothing was changed` };
    o.afterWrite?.();
    const now = genRaw(genFile(dir, pr)), again = genRecorded(dir, pr);
    if (now !== n || again.max > n || !ownsLock(got))
      return { ok: false, why: `something moved the pull request's watch generation while it was being recovered (the file now reads ${typeof now === "number" ? now : "unreadable"}, the highest recorded is ${again.max}, written ${n}): run this again` };
    return { ok: true, gen: n };
  } finally { letGo(got); }
}
// gen: the generation the lock was made under (null for the recovery's own lock, which makes none); seen: the highest
// generation a lock this taker took over carried (twenty-seventh round, for the recovery).
// setAside (0.12.2, the lock quarantine's takeover): the lock that didn't parse, as this taker moved it aside.
export interface HeldLock { file: string; token: string; since: number; gen: number; seen?: number; setAside?: LockAside }
// Twenty-fourth round, the legacy rule: a lock with no token (the empty file the twenty-second round made, or
// JSON without a token) is "legacy". Older than the stale bound, it is taken over through the same rename then
// exclusive create, with a loud log line; one that looks current still counts as held. A file whose content
// fails to parse, or that can't be read at all, counts as held ("unreadable"), whatever its age.
type LockRead = { kind: "gone" } | { kind: "unreadable" } | { kind: "held"; mtimeMs: number; token: string } | { kind: "legacy"; mtimeMs: number };
function readLock(f: string): LockRead {
  let mtimeMs: number;
  try { mtimeMs = statSync(f).mtimeMs; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable" }; }
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable" }; }
  if (text.trim() === "") return { kind: "legacy", mtimeMs };
  let x: any;
  try { x = JSON.parse(text); } catch { return { kind: "unreadable" }; }
  if (x && typeof x === "object" && !Array.isArray(x) && typeof x.token === "string" && x.token) return { kind: "held", mtimeMs, token: x.token };
  return x && typeof x === "object" && !Array.isArray(x) && !("token" in x) ? { kind: "legacy", mtimeMs } : { kind: "unreadable" };
}
export type LockMiss = { miss: "held" | "unreadable" | "error"; setAside?: LockAside };
// How long ago, as people say it (twenty-fifth round: the takeover line carries no ISO time).
export function agoWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 2) return "about a minute ago";
  if (m < 90) return `about ${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `about ${h} hours ago`;
  return `about ${Math.round(h / 24)} days ago`;
}
// Twenty-seventh round, recovery: the generation recovery takes the lock the same way, but makes it under no
// generation (it writes the generation itself); when it takes a stale lock over it notes the generation that lock
// carried (seen) and writes above it. Twenty-ninth round: and, like every takeover, moves the generation on first.
// afterTakeover (tests, twenty-eighth round): runs between a takeover's rename and this taker's own exclusive create.
// 0.12.2, garbled (the lock quarantine only, in recovery mode): a lock that doesn't parse or can't be read is taken over
// too, at any age, by moving it aside under a quarantine name (lockAside: one renamer wins, and a lock that parses after
// all is put back), with the generation moved on as at every takeover; the taker reports what it moved (setAside), on a
// miss too, for the quarantine's log. A generation that reads but can't be moved on puts the lock back and misses.
export function takeLock(f: string, waitMs: number, o: { staleMs?: number; recovery?: boolean; garbled?: boolean; afterTakeover?: () => void } = {}): HeldLock | LockMiss {
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  const until = Date.now() + waitMs;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let last: "held" | "unreadable" = "held";
  let seen = 0;
  let setAside: LockAside | undefined;
  const miss = (m: LockMiss["miss"]): LockMiss => ({ miss: m, ...(setAside ? { setAside } : {}) });
  for (;;) {
    try {
      const fd = openSync(f, "wx");
      // The generation this lock is made under, read once it is this holder's: a takeover that moved it on
      // meanwhile is seen by the holder's own checks (keepWatch), which then accept nothing.
      const gen = o.recovery ? null : genForLock(genOfLock(f));
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, gen, ...(o.recovery ? { recovery: true } : {}), at: new Date().toISOString() })); } finally { closeSync(fd); }
      if (o.recovery) return { file: f, token, since: Date.now(), gen: 0, ...(seen ? { seen } : {}), ...(setAside ? { setAside } : {}) };
      if (gen === null) { rmSync(f, { force: true }); return { miss: "unreadable" }; }
      return { file: f, token, since: Date.now(), gen };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return miss("error");
    }
    const r = readLock(f);
    if (r.kind === "gone") continue;
    last = r.kind === "held" ? "held" : "unreadable";
    if (o.recovery && o.garbled && r.kind === "unreadable" && !setAside && lockGarbled(f)) {
      const m = lockAside(f);
      if (m && !m.failed) {
        const g = gensIn(m.text).filter((n) => n >= 1);
        if (g.length) seen = Math.max(seen, ...g);
        if (genOf(genOfLock(f)) !== null && !bumpGen(genOfLock(f))) {
          // The generation can't be moved on: the lock goes back where it was (never deleted), and nothing is taken.
          const failed = putBack(m.as, f);
          if (failed) { setAside = { ...m, failed }; console.error(`ship gate: ${f} couldn't be put back (${failed}): it was left as ${m.as}; ${restoreCmd(m.as, f)}`); }
          return miss("unreadable");
        }
        setAside = m;
        console.error(`ship gate: took over a watch lock that doesn't parse (${f}), moved aside as ${m.as}: acceptances kept before it no longer count; run the watch again for the pull request's head`);
        o.afterTakeover?.();
        continue;
      }
      if (m) { setAside = m; continue; }                            // parsed after all, and its put-back failed: kept, logged
    }
    if ((r.kind === "held" || r.kind === "legacy") && Date.now() - r.mtimeMs > staleMs) {
      // The takeover: rename the stale lock to a name of this taker's own. Only one rename can succeed.
      const aside = `${f}.stale-${token}`;
      let moved = false;
      try { renameSync(f, aside); moved = true; } catch { moved = false; }
      if (moved) {
        const caught = readLock(aside);
        const same = r.kind === "held" ? caught.kind === "held" && caught.token === r.token : caught.kind === "legacy" && caught.mtimeMs === r.mtimeMs;
        if (same && Date.now() - (caught as { mtimeMs: number }).mtimeMs > staleMs) {
          // The fence: the generation moves on before the lock can be made again, so whatever the holder taken
          // over writes from now on is no acceptance. A generation that can't be moved on puts the lock back.
          // Twenty-ninth round: every takeover moves it on, the recovery's and both quarantines' included (they take the
          // lock in recovery mode), so a holder stalled past the stale bound after its last fence check, that writes
          // after the takeover and dies before its take-back, leaves no acceptance under the generation that counts.
          // In recovery mode a generation that can't be read is left as it is (no acceptance counts under it, and the
          // recovery writes above everything it finds); one that reads but can't be moved on puts the lock back.
          if (o.recovery) {
            try { const g = JSON.parse(readFileSync(aside, "utf8"))?.gen; if (Number.isInteger(g) && g > seen) seen = g; } catch { /* a legacy lock: no generation */ }
          }
          if ((!o.recovery || genOf(genOfLock(f)) !== null) && !bumpGen(genOfLock(f))) {
            try { linkSync(aside, f); } catch { /* a newer lock stands */ }
            rmSync(aside, { force: true });
            return miss("unreadable");
          }
          const age = agoWords(Date.now() - r.mtimeMs);
          if (r.kind === "legacy") console.error(`ship gate: WARNING: took over a watch lock left by an earlier version of the watch, with no holder token (${f}), last changed ${age}, past the ${Math.round(staleMs / 1000)} second stale bound. Acceptances kept before it no longer count: run the watch again for the pull request's head`);
          else console.error(`ship gate: took over a stale watch lock (${f}), last changed ${age}: its holder stopped. Acceptances kept before it no longer count: run the watch again for the pull request's head`);
          rmSync(aside, { force: true });
          o.afterTakeover?.();
          continue;
        }
        // A fresh lock made between the stat and the rename: put it back (never over a newer one), and back off.
        try { linkSync(aside, f); } catch { /* a newer lock stands: that holder goes on */ }
        rmSync(aside, { force: true });
      }
    }
    if (Date.now() >= until) return miss(last);
    pause(50);
  }
}
const ownsLock = (l: HeldLock) => { const r = readLock(l.file); return r.kind === "held" && r.token === l.token; };
// The heartbeat: the lock's time refreshed, only while it is still this holder's own.
export function beat(l: HeldLock): boolean {
  if (!ownsLock(l)) return false;
  try { const t = new Date(); utimesSync(l.file, t, t); return true; } catch { return false; }
}
export function letGo(l: HeldLock): void { if (ownsLock(l)) rmSync(l.file, { force: true }); }
export const lockNotice = (f: string) => { const pr = /ship-gate-pr-(\d+)\.lock$/.exec(f)?.[1];
  return `the pull request's watch lock (${f}) couldn't be taken or kept in time (another watch held it, or it couldn't be read): nothing was accepted; run the watch again once no other watch of this pull request is running, and if this repeats with no watch running, ${pr ? `set a lock that doesn't parse aside with: /opt/cain/keeper.sh ship-gate --quarantine-lock ${pr}, or ` : ""}remove the lock with: rm -f ${f}`; };
// The take-back (twenty-fifth round, said outright): a holder that finds, after its write, that it lost the lock (or
// the generation moved on) has written no acceptance that counts; it rewrites its record as a failure, and the watch
// must be run again for this head.
export const takeBackNotice = (f: string) => `the pull request's watch lock (${f}) was taken over while this watch was keeping its acceptance: no acceptance stands for this head, and the watch must be run again for it`;
// The pull request's head as GitHub has it now, read synchronously (the watch's checks run under its lock, which is
// held only briefly): one GET of the pull request through curl.
// Twenty-sixth round, the real request wrapper: authenticated with a GitHub token when one is given (on curl's standard
// input, never its command line, and never printed); a refused read (403 with GitHub's rate-limit signs, or 429) is
// tried again at most HEAD_READ_RETRIES times, each wait as GitHub's Retry-After or rate-limit reset asks, but only
// while that wait fits HEAD_RETRY_WAIT_MS; otherwise it comes back as a rate limit, told apart from a head that moved
// and from a read that failed (a 5xx, malformed JSON, no answer). curl missing comes back as its own answer, and the
// watch checks for curl before it starts (curlPresent).
// Twenty-seventh round: the one wrapper for every GitHub API read here (ghGet; ghHeadRead and api are built on it), and
// a deadline: under the lock the read takes its curl time and its waits from what is left of the critical section
// (o.deadline), never per try. Each try's curl limit is the smaller of HEAD_READ_S and the time left; a wait that
// doesn't fit the time left, or a try with too little time left to make, ends the read as { miss: "deadline" }, which
// the watch treats as its section running out (lock_unavailable), never as a moved head.
// Twenty-eighth round, curl's own time limit is not trusted alone. Fractional limits need curl 7.32 or newer (the watch
// refuses to start below it, curlVersionOk), a limit under one second is never handed to curl (the try is skipped as
// the deadline: MIN_TRY_MS), and the curl child is killed from this side (SIGKILL) at its limit plus CURL_KILL_MARGIN_MS,
// whatever curl's own timer does, so a read under the lock can't run past the deadline by more than that margin.
export const HEAD_READ_S = 3;
export const HEAD_READ_RETRIES = 2;
export const HEAD_RETRY_WAIT_MS = 2_000;
export const API_READ_S = 15;
export const MIN_TRY_MS = 1_000;
export const CURL_KILL_MARGIN_MS = 250;
export const CURL_MIN_VERSION: readonly [number, number] = [7, 32];
// curl's version, read from curl --version: [major, minor, patch], or null (no curl, or a version line that can't be read).
export function curlVersion(bin = "curl"): [number, number, number] | null {
  let p: ReturnType<typeof Bun.spawnSync>;
  try { p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL" }); } catch { return null; }
  const m = /^curl (\d+)\.(\d+)(?:\.(\d+))?/.exec(p.stdout?.toString() ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
export const curlVersionOk = (v: [number, number, number] | null): boolean =>
  !!v && (v[0] > CURL_MIN_VERSION[0] || (v[0] === CURL_MIN_VERSION[0] && v[1] >= CURL_MIN_VERSION[1]));
export const curlRefusal = (v: [number, number, number] | null): string | null => curlVersionOk(v) ? null : v
  ? `ship gate: curl ${v.join(".")} is older than ${CURL_MIN_VERSION.join(".")}, which the gate's reads need for their time limits: nothing is read or changed; update curl on the Pi`
  : "ship gate: curl isn't installed or its version can't be read, so the pull request's head can't be read from GitHub: nothing is read or changed";
// GitHub's quota for reads, as its last answer gave it (x-ratelimit-remaining and -limit), for the refusals' words.
let lastQuota: { remaining: number; limit: number } | null = null;
export const quotaNote = (env = process.env): string => githubToken(env) ? "" : lastQuota
  ? ` (reads without a GitHub token: ${lastQuota.remaining} of ${lastQuota.limit} left this hour)`
  : " (reads without a GitHub token: how many are left this hour isn't known yet)";
export const resetQuota = () => { lastQuota = null; };
export type HeadMiss = { miss: "rate_limit"; wait_ms: number | null } | { miss: "unreadable"; why: string } | { miss: "no_curl" } | { miss: "deadline" } | { miss: "local"; why: string };
export type HeadRead = string | HeadMiss;
export const curlPresent = (): boolean => Bun.which("curl") !== null;
function splitHttp(out: string): { status: number; headers: Record<string, string>; body: string } | null {
  let rest = out, status = 0;
  const headers: Record<string, string> = {};
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    const cut = rest.search(/\r?\n\r?\n/);
    if (cut < 0) return null;
    const block = rest.slice(0, cut).split(/\r?\n/);
    status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(block[0])![1]);
    for (const k of Object.keys(headers)) delete headers[k];
    for (const l of block.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    rest = rest.slice(cut).replace(/^\r?\n\r?\n/, "");
  }
  return status ? { status, headers, body: rest } : null;
}
export interface GhOpts { token?: string; base?: string; retries?: number; retryWaitMs?: number; sleep?: (ms: number) => void; now?: () => number; deadline?: number; maxS?: number; curl?: string }
export type GhMiss = { miss: "no_answer" | "unparsed" | "no_curl" | "deadline" } | { miss: "local"; why: string };
export type GhAnswer = { status: number; body: any; text: string; headers: Record<string, string> } | GhMiss;
// Twenty-ninth round: the version check and the child kill belong to the wrapper, so every gate read has them (the
// watch's head reads, the supersede's, and the page reads of the gate's report). curl's version is read once per binary;
// below 7.32 (or unreadable) no read is made and the miss names the local cause. A curl that exits with one of its own
// local failures (an option it doesn't know, a bad argument, a failed start) is named as that too, never as GitHub not
// answering. Only an exit of 0 is ever parsed: a curl killed at its limit, or one that failed, has its output dropped.
export const CURL_LOCAL_EXITS: Record<number, string> = { 1: "an unsupported protocol", 2: "it failed to start", 4: "a feature it wasn't built with",
  26: "it couldn't read its own input", 27: "it ran out of memory", 43: "a bad internal argument", 48: "an option it doesn't know" };
let lastLocal: string | null = null;
export const localCause = (): string | null => lastLocal;
const curlSeen = new Map<string, [number, number, number] | null>();
export const resetCurlSeen = () => curlSeen.clear();
// 0.12.2: the version read once per binary is forgotten again whenever a read fails on the Pi's side (ghSteps below), so
// a curl replaced on the Pi is read anew at the next read rather than trusted for the rest of the process.
export function curlOf(bin: string): [number, number, number] | null {
  if (!curlSeen.has(bin)) curlSeen.set(bin, curlVersion(bin));
  return curlSeen.get(bin)!;
}
// 0.12.2: curl's version read without blocking, for the link (one long-lived process): read anew on every read it makes.
export async function curlVersionAsync(bin = "curl"): Promise<[number, number, number] | null> {
  try {
    const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const m = /^curl (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  } catch { return null; }
}
export const missWords = (m: GhMiss): string => m.miss === "local" ? m.why : m.miss === "no_curl" ? "curl isn't installed on the Pi, so GitHub can't be read"
  : m.miss === "deadline" ? "the read's time ran out" : m.miss === "unparsed" ? "GitHub's answer couldn't be read" : "GitHub didn't answer";
// GitHub's rate-limit signs on a refused answer (429, or a 403 with them), and the wait it asked for.
export const limitedOf = (r: { status: number; headers: Record<string, string>; text: string }) =>
  r.status === 429 || (r.status === 403 && (r.headers["x-ratelimit-remaining"] === "0" || r.headers["retry-after"] !== undefined || /secondary rate limit/i.test(r.text)));
const waitOf = (h: Record<string, string>, now: number): number | null => {
  const ra = Number(h["retry-after"]), reset = Number(h["x-ratelimit-reset"]);
  return Number.isFinite(ra) && ra >= 0 && h["retry-after"] !== undefined ? ra * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : null;
};
// 0.12.2: the wrapper's steps, shared by the blocking reader (ghGet: the watch, the supersede, the dry run) and the
// link's non-blocking one (ghGetAsync: the Ship card's read of the gate's head), so both make the same reads, with the
// same version check, limits, kill, local causes and rate-limit retries. Each step asks its driver to run curl (null back:
// curl couldn't be started) or to sleep.
type CurlRun = { exitCode: number | null; signalCode: string | null; stdout: string } | null;
type GhStep = { conf: string; timeoutMs: number } | { sleep: number };
function* ghSteps(path: string, o: GhOpts, v: [number, number, number] | null): Generator<GhStep, GhAnswer, CurlRun | undefined> {
  const base = o.base ?? "https://api.github.com";
  const now = o.now ?? Date.now;
  const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const retries = o.retries ?? HEAD_READ_RETRIES;
  if (!curlVersionOk(v)) { lastLocal = v ? `curl ${v.join(".")} on the Pi is older than ${CURL_MIN_VERSION.join(".")}, which the gate's reads need for their time limits; update curl on the Pi` : "curl isn't installed on the Pi, or its version can't be read";
    curlSeen.delete(o.curl ?? "curl");                               // 0.12.2: read its version again next time
    return v ? { miss: "local", why: lastLocal } : { miss: "no_curl" }; }
  for (let i = 0; ; i++) {
    const left = o.deadline !== undefined ? o.deadline - now() : Infinity;
    if (left < MIN_TRY_MS) return { miss: "deadline" };
    const maxS = Math.min(o.maxS ?? HEAD_READ_S, left / 1000);
    const conf = [`url = ${q(`${base}${path}`)}`, `header = "accept: application/vnd.github+json"`, `header = "user-agent: cain-link"`,
      `header = "x-github-api-version: 2022-11-28"`, ...(o.token ? [`header = ${q(`authorization: Bearer ${o.token}`)}`] : []),
      `max-time = ${maxS.toFixed(2)}`, `silent`, `include`, ...(base.startsWith("http://127.0.0.1") ? [`noproxy = "127.0.0.1"`] : [])].join("\n") + "\n";
    const p = yield { conf, timeoutMs: Math.ceil(maxS * 1000) + CURL_KILL_MARGIN_MS };
    if (!p) { curlSeen.delete(o.curl ?? "curl"); return { miss: "no_curl" }; }
    if (p.exitCode !== 0 || p.signalCode) {
      if (p.exitCode !== null && Object.hasOwn(CURL_LOCAL_EXITS, p.exitCode)) {
        lastLocal = `curl on the Pi failed before it reached GitHub (its exit code ${p.exitCode}: ${CURL_LOCAL_EXITS[p.exitCode]})`;
        curlSeen.delete(o.curl ?? "curl");                             // 0.12.2: a local failure: read its version again next time
        return { miss: "local", why: lastLocal };
      }
      return o.deadline !== undefined && o.deadline - now() < MIN_TRY_MS ? { miss: "deadline" } : { miss: "no_answer" };
    }
    const r = splitHttp(p.stdout);
    if (!r) return { miss: "unparsed" };
    const rem = Number(r.headers["x-ratelimit-remaining"]), lim = Number(r.headers["x-ratelimit-limit"]);
    if (r.headers["x-ratelimit-remaining"] !== undefined && Number.isInteger(rem) && rem >= 0) lastQuota = { remaining: rem, limit: Number.isInteger(lim) && lim > 0 ? lim : 60 };
    let body: any = null;
    try { body = JSON.parse(r.body); } catch { body = null; }
    const a = { status: r.status, body, text: r.body, headers: r.headers };
    if (!limitedOf(a)) return a;
    const wait = waitOf(r.headers, now());
    if (i >= retries || wait === null || wait > (o.retryWaitMs ?? HEAD_RETRY_WAIT_MS)) return a;
    if (o.deadline !== undefined && wait > o.deadline - now() - MIN_TRY_MS) return { miss: "deadline" };
    yield { sleep: wait };
  }
}
export function ghGet(path: string, o: GhOpts = {}): GhAnswer {
  const bin = o.curl ?? "curl";
  const steps = ghSteps(path, o, curlOf(bin));
  let step = steps.next();
  while (!step.done) {
    const s = step.value;
    if ("sleep" in s) { (o.sleep ?? pause)(s.sleep); step = steps.next(undefined); continue; }
    let run: CurlRun;
    try {
      const p = Bun.spawnSync([bin, "-q", "-K", "-"], { stdin: Buffer.from(s.conf), stdout: "pipe", stderr: "ignore", timeout: s.timeoutMs, killSignal: "SIGKILL" });
      run = { exitCode: p.exitCode, signalCode: p.signalCode ?? null, stdout: p.stdout?.toString() ?? "" };
    } catch { run = null; }
    step = steps.next(run);
  }
  return step.value;
}
// 0.12.2: the same reads without blocking the link's event loop. curl's version is read anew on every call (the link
// runs for weeks: a curl replaced meanwhile is never trusted from an earlier read). A wait GitHub asks for is slept
// without blocking; o.sleep is not used here.
export async function ghGetAsync(path: string, o: GhOpts = {}): Promise<GhAnswer> {
  const bin = o.curl ?? "curl";
  const steps = ghSteps(path, o, await curlVersionAsync(bin));
  let step = steps.next();
  while (!step.done) {
    const s = step.value;
    if ("sleep" in s) { await Bun.sleep(s.sleep); step = steps.next(undefined); continue; }
    let run: CurlRun;
    try {
      const p = Bun.spawn([bin, "-q", "-K", "-"], { stdin: Buffer.from(s.conf), stdout: "pipe", stderr: "ignore", timeout: s.timeoutMs, killSignal: "SIGKILL" });
      const stdout = await new Response(p.stdout).text();
      await p.exited;
      run = { exitCode: p.exitCode, signalCode: p.signalCode ?? null, stdout };
    } catch { run = null; }
    step = steps.next(run);
  }
  return step.value;
}
const headOfAnswer = (r: GhAnswer, o: GhOpts): HeadRead => {
  if ("miss" in r) return r.miss === "no_curl" ? { miss: "no_curl" } : r.miss === "deadline" ? { miss: "deadline" } : r.miss === "local" ? { miss: "local", why: r.why }
    : { miss: "unreadable", why: r.miss === "no_answer" ? "GitHub didn't answer" : "GitHub's answer couldn't be read" };
  if (r.status === 200) {
    if (r.body === null) return { miss: "unreadable", why: "GitHub's answer wasn't JSON" };
    const h = r.body?.head?.sha;
    return typeof h === "string" && SHA.test(h.toLowerCase()) ? h.toLowerCase() : { miss: "unreadable", why: "GitHub's answer named no head" };
  }
  if (limitedOf(r)) return { miss: "rate_limit", wait_ms: waitOf(r.headers, (o.now ?? Date.now)()) };
  return { miss: "unreadable", why: r.status >= 500 ? `GitHub answered with a server error (${r.status})` : `GitHub refused the read (${r.status})` };
};
export function ghHeadRead(repo: string, pr: number, o: GhOpts = {}): HeadRead { return headOfAnswer(ghGet(`/repos/${repo}/pulls/${pr}`, o), o); }
export async function ghHeadReadAsync(repo: string, pr: number, o: GhOpts = {}): Promise<HeadRead> { return headOfAnswer(await ghGetAsync(`/repos/${repo}/pulls/${pr}`, o), o); }
// 0.12.2: the Ship card's read of the gate's head (link/main.ts gateHead), through the wrapper, never another client: the
// head, or the gate's state unknown, named. A read stopped at its time limit (its deadline, or curl killed or timing out
// at it) is named as a timeout (GATE_HEAD_TIMEOUT), and so is the card's own wait running out (core.ts).
// SHIP_GATE_GITHUB_TOKEN (githubToken) authenticates it, and is the recommended default: without it the link's reads
// share GitHub's 60 an hour from this address with every watch, and a refused read refuses the card.
export const GATE_HEAD_TIMEOUT = "the read of the pull request's head from GitHub was stopped at its time limit (a timeout)";
export async function gateHeadRead(repo: string, pr: number, o: { ms: number; token?: string; base?: string; curl?: string }): Promise<string | { unknown: string }> {
  const t0 = Date.now();
  const r = await ghHeadReadAsync(repo, pr, { token: o.token ?? githubToken(), maxS: Math.max(1, o.ms / 1000), deadline: t0 + o.ms,
    ...(o.base ? { base: o.base } : {}), ...(o.curl ? { curl: o.curl } : {}) });
  if (typeof r === "string") return r;
  if (r.miss === "deadline" || (r.miss === "unreadable" && r.why === "GitHub didn't answer" && Date.now() - t0 >= o.ms)) return { unknown: GATE_HEAD_TIMEOUT };
  return { unknown: headMissWords(r) };
}
// The watch's head read (twenty-fifth round's name kept): the head, or null with the reason left out. keepWatch takes
// ghHeadRead's whole answer, to word a rate limit apart from a moved head.
export function ghHeadSync(repo: string, pr: number, token?: string): string | null { const r = ghHeadRead(repo, pr, { token }); return typeof r === "string" ? r : null; }
// The token for that read: the link has no GitHub API token of its own today (it reaches GitHub with its SSH deploy
// key, which the API doesn't take), so this reads one only where the environment hands it in (SHIP_GATE_GITHUB_TOKEN),
// and is otherwise unauthenticated, as before. Never printed or logged.
export const githubToken = (env = process.env): string | undefined => { const t = (env.SHIP_GATE_GITHUB_TOKEN ?? "").trim(); return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : undefined; };
export const headMissWords = (m: HeadMiss | null) => !m ? "the pull request's head couldn't be read from GitHub"
  : m.miss === "rate_limit" ? `GitHub's rate limit stopped the read of the pull request's head${m.wait_ms !== null ? ` (it asked to wait about ${Math.max(1, Math.ceil(m.wait_ms / 60_000))} minutes)` : ""}, so the head isn't known to have moved`
  : m.miss === "no_curl" ? "curl isn't installed, so the pull request's head couldn't be read from GitHub"
  : m.miss === "deadline" ? "the watch's time under its lock ran out while it read the pull request's head from GitHub"
  : m.miss === "local" ? `the pull request's head couldn't be read: the cause is on the Pi, not GitHub (${m.why})`
  : `the pull request's head couldn't be read from GitHub (${m.why})`;
export interface KeepOpts {
  // The pull request's head from GitHub at check time (ghHeadRead in the watch). deadline: when the critical section
  // ends (twenty-seventh round), for the read to take its time and waits from.
  headNow: (pr: number, checking: string, deadline: number) => string | null | HeadMiss;
  waitMs?: number; staleMs?: number; criticalMs?: number; beforeWrite?: () => void; atWrite?: () => void; afterWrite?: () => void;
}
// The critical section past its deadline (twenty-seventh round), named.
export const criticalNotice = (f: string, ms: number, after = false) => after
  ? `the watch's work under the pull request's watch lock (${f}) ran past its ${Math.round(ms / 1000)} second bound just after its acceptance was written: it is taken back, and no acceptance stands for this head; run the watch again`
  : `the watch's work under the pull request's watch lock (${f}) ran past its ${Math.round(ms / 1000)} second bound before its acceptance was written: nothing was accepted; run the watch again`;
export function keepWatch(dir: string, line: WatchLine, out: string, o: KeepOpts): WatchLine {
  let kept = line;
  mkdirSync(dirname(out), { recursive: true });
  // A record of this very sha that was superseded is never written over (twenty-fifth round): a failure line in its
  // place would read as no acceptance, and a later watch of the sha could then make it live again.
  const sha = line.accepted_head ?? line.bound_head ?? line.head;
  // 0.12.2: publish, when given, is asked after the temporary file is written and before the rename that makes the
  // record visible; false leaves nothing published (the temporary file is removed) and write answers "late".
  const write = (l: WatchLine, publish?: () => boolean): "kept" | "left" | "late" => {
    let was: any = null;
    try { was = JSON.parse(readFileSync(out, "utf8")); } catch { was = null; }
    if (was?.superseded && was.accepted_head === sha) { console.error(`ship gate: the record kept for this sha was superseded; it is left as it is (${out})`); return "left"; }
    // Twenty-sixth round: every line kept for a pull request carries the generation the watch knew (gen_floor), so a
    // generation file deleted later is fail-closed and its recovery starts above it.
    // Twenty-seventh round: and the record format (format), without which no record is ever current.
    const floor = held ? held.gen : l.pr !== null ? readGen(dir, l.pr) : null;
    const stamped = { ...l, format: GATE_RECORD_FORMAT, ...(floor !== null && floor >= 1 ? { gen_floor: floor } : {}) };
    writeFileSync(`${out}.tmp`, JSON.stringify(stamped, null, 2) + "\n");
    if (publish && !publish()) { rmSync(`${out}.tmp`, { force: true }); return "late"; }
    renameSync(`${out}.tmp`, out);
    return "kept";
  };
  const lockPath = line.pr !== null && line.accepted_head ? lockFile(dir, line.pr) : null;
  if (lockPath) mkdirSync(dir, { recursive: true });
  const got = lockPath ? takeLock(lockPath, o.waitMs ?? 10_000, { staleMs: o.staleMs }) : null;
  const held = got && "token" in got ? got : null;
  const criticalMs = o.criticalMs ?? CRITICAL_MAX_MS;
  const deadline = held ? held.since + criticalMs : 0;
  const unavailable = (why = lockNotice(lockPath!)): WatchLine => ({ ...line, accepted_head: null, passed: false, failure: "lock_unavailable", failure_why: why });
  const refuse = (failure: WatchLine["failure"], why: string): WatchLine => ({ ...line, accepted_head: null, passed: false, failure, failure_why: why });
  const unknownWhy = (u: { unknown: string }) => held && Date.now() > deadline ? criticalNotice(lockPath!, criticalMs) : `the Ship gate's state can't be read (${u.unknown}): nothing was accepted`;
  // Twenty-eighth round: the deadline checked before each live check too (and per record inside it, gateState).
  const pastDeadline = () => !!held && Date.now() > deadline;
  if (lockPath && !held) {
    // Another watch's readable lock held to the deadline: that watch is being kept (live_acceptance, as before);
    // a lock that couldn't be read, or made: lock_unavailable.
    kept = got && "miss" in got && got.miss === "held" ? refuse("live_acceptance",
      `another watch of this pull request was being kept at the same moment (its lock, ${lockPath}, stayed held): run the watch again once it is done`)
      : unavailable(line.pr !== null && readGen(dir, line.pr) === null ? `${lockNotice(lockPath)}. Also, ${genUnreadable(dir, line.pr)}` : undefined);
    console.error(`ship gate: ${kept.failure_why}`);
    write(kept);
    return kept;
  }
  // Still this holder's: its own token on the lock, and the generation it was made under still the current one.
  const fenced = (l: HeldLock) => ownsLock(l) && readGen(dir, line.pr!) === l.gen;
  try {
    if (line.pr !== null && line.accepted_head) {
      const other = pastDeadline() ? { unknown: PAST_DEADLINE } : otherLive(dir, line.pr, line.accepted_head, held ? deadline : undefined);
      if (!Array.isArray(other)) kept = unavailable(unknownWhy(other));
      else if (other.length) kept = refuse("live_acceptance", liveWhy(other));
    }
    if (held) beat(held);
    o.beforeWrite?.();
    // Still this watch's own lock, refreshed, and the section within its bound: otherwise nothing is accepted.
    if (held && kept.accepted_head && (Date.now() > deadline || !beat(held))) {
      kept = unavailable(Date.now() > deadline ? criticalNotice(lockPath!, criticalMs) : undefined);
      console.error(`ship gate: ${kept.failure_why}`);
    }
    if (!held || !kept.accepted_head || kept.pr === null) { write(kept); return kept; }
    const pr = kept.pr, head = kept.accepted_head;
    // The fenced write (twenty-fourth round), made under the generation (twenty-fifth round). Before the write: the
    // lock still this holder's at its generation; the sha-bound check (merge.ts shaBound) on this sha's record (a live
    // acceptance of it: this write is a no-op; a superseded one: refused, never read as none); the pull request's head
    // from GitHub now, which must be this sha (head_not_current otherwise); and no live acceptance of another head.
    if (!fenced(held)) { kept = unavailable(readGen(dir, pr) === null ? genUnreadable(dir, pr) : undefined); console.error(`ship gate: ${kept.failure_why}`); write(kept); return kept; }
    // Twenty-sixth round: a gate state that can't be read (a record that doesn't parse, say) accepts nothing.
    const st = pastDeadline() ? { unknown: PAST_DEADLINE } : gateState(dir, pr, deadline);
    if ("unknown" in st) { kept = unavailable(unknownWhy(st)); console.error(`ship gate: ${kept.failure_why}`); write(kept); return kept; }
    const textOf = () => { try { return readFileSync(out, "utf8"); } catch { return null; } };
    const pre = shaBound(textOf(), pr, head, held.gen);
    if (pre === "kept") return JSON.parse(textOf()!) as WatchLine;
    if (pre === "superseded") {
      kept = refuse("superseded", `the acceptance of ${head} was superseded: a superseded head is never accepted again; watch the pull request's current head`);
      console.error(`ship gate: ${kept.failure_why}`);
      return kept;
    }
    const now1 = o.headNow(pr, head, deadline);
    if (now1 !== null && typeof now1 === "object" && now1.miss === "deadline") {
      kept = unavailable(criticalNotice(lockPath!, criticalMs)); console.error(`ship gate: ${kept.failure_why}`); write(kept); return kept;
    }
    if (now1 !== head) {
      kept = refuse("head_not_current", typeof now1 === "string" ? `the pull request's head on GitHub is now ${now1}, not ${head}: nothing is accepted; watch its current head`
        : `${headMissWords(now1)} just before the acceptance was kept: nothing is accepted; run the watch again`);
      console.error(`ship gate: ${kept.failure_why}`);
      write(kept);
      return kept;
    }
    const other = pastDeadline() ? { unknown: PAST_DEADLINE } : otherLive(dir, pr, head, deadline);
    if (!Array.isArray(other)) { kept = unavailable(unknownWhy(other)); console.error(`ship gate: ${kept.failure_why}`); write(kept); return kept; }
    if (other.length) { kept = refuse("live_acceptance", liveWhy(other)); write(kept); return kept; }
    // Twenty-seventh round: after the head read, immediately before the fenced write, the elapsed bound, the lock's
    // token and the generation once more; past the deadline, or no longer this holder's, nothing is accepted. (What
    // can still happen between this check and the write is what the post-write checks below take back.)
    if (Date.now() > deadline || !fenced(held) || !beat(held)) {
      kept = unavailable(Date.now() > deadline ? criticalNotice(lockPath!, criticalMs) : readGen(dir, pr) === null ? genUnreadable(dir, pr) : undefined);
      console.error(`ship gate: ${kept.failure_why}`);
      write(kept);
      return kept;
    }
    o.atWrite?.();
    kept = { ...kept, gen: held.gen } as WatchLine;
    // 0.12.2: the deadline checked once more after the record is written to its temporary file and before the rename
    // that publishes it: past it, the acceptance is never visible (the post-write take-back below stays as the backstop
    // for a rename that itself runs late).
    if (write(kept, () => Date.now() <= deadline) === "late") {
      kept = unavailable(criticalNotice(lockPath!, criticalMs));
      console.error(`ship gate: ${kept.failure_why}`);
      write(kept);
      return kept;
    }
    o.afterWrite?.();
    // After the write: the same checks again. A holder taken over (or whose generation moved on) between its checks
    // and its write has written no acceptance that counts (the consumer reads it under the new generation already);
    // it rewrites its record as a failure, saying so. A head that moved meanwhile takes it back too, and so (twenty-
    // seventh round) does the section running out of time during or before this second head read.
    const post = fenced(held) ? shaBound(textOf(), pr, head, held.gen) : "stale";
    // Twenty-ninth round: the deadline re-checked at once after the fenced write and the post-write sha check, before
    // any further read: a write that couldn't be interrupted and finished past the window voids the acceptance under the
    // same generation (the take-back below) and reports the deadline, without reading GitHub again.
    const lateWrite = post === "kept" && Date.now() > deadline;
    const now2 = post === "kept" && !lateWrite ? o.headNow(pr, head, deadline) : head;
    const late = post === "kept" && (lateWrite || (now2 !== null && typeof now2 === "object" && now2.miss === "deadline") || Date.now() > deadline);
    if (post !== "kept" || late || now2 !== head) {
      kept = post !== "kept" ? unavailable(takeBackNotice(lockPath!)) : late ? unavailable(criticalNotice(lockPath!, criticalMs, true)) : refuse("head_not_current", typeof now2 === "string"
        ? `the pull request's head on GitHub moved to ${now2} while the acceptance of ${head} was being kept: it is taken back, and no acceptance stands for this head`
        : `${headMissWords(now2)} just after the acceptance was kept: it is taken back, and no acceptance stands for this head; run the watch again`);
      console.error(`ship gate: ${kept.failure_why}`);
      // A live acceptance of this same sha written meanwhile by the watch that took over is that watch's: left alone.
      const live = watchAccepted(textOf(), readGen(dir, pr));
      if (!(live && live.head === head && live.gen !== held.gen)) write(kept);
    }
  } finally { if (held) letGo(held); }
  return kept;
}
// keeper.sh ship-gate --supersede <sha>: the acceptance kept for that sha is marked replaced, with
// when; the file stays, as the record of what was accepted. Written whole, then renamed into place.
// Only once the pull request's head has moved past it (twenty-first round): headOf reads the pull
// request's current head; the same sha, or a head that can't be read, refuses, naming it.
// Twenty-seventh round: headOf is the one request wrapper's head read (ghHeadRead), so a rate limit is told apart from
// a failed read. A rate-limited read never leaves a silent no-op: the record keeps the supersede as owed
// (supersede_owed, with the wait GitHub asked for, in minutes), the answer says so (owed), and the command exits with
// its own status; a later supersede that goes through removes it.
// Twenty-ninth round: an owed supersede re-run after the wait while the pull request's head still equals the sha being
// replaced is no longer owed: under the gate lock, when the live acceptance is for that very head, the mark is cleared
// and logged on the record (owed_cleared, "no longer owed: head unchanged"), and the answer says so (cleared), so the
// card's owed rule never refuses a valid current acceptance for good.
// 0.12.2: the head is read again under the gate lock before the mark is cleared (within the lock's critical bound,
// headOf's deadline): a head that moved meanwhile, or one that can't be read, keeps the mark and the command exits
// non-zero; so does a lock that is no longer this command's own after the read.
export const OWED_CLEARED = "no longer owed: head unchanged";
export type SupersedeAnswer = { ok: true; pr: number | null } | { ok: false; why: string; owed?: true; cleared?: true };
export async function supersede(dir: string, sha: string, headOf: (pr: number, deadline?: number) => Promise<string | null | HeadMiss>, now = () => new Date(), o: { criticalMs?: number } = {}): Promise<SupersedeAnswer> {
  if (!SHA.test(sha)) return { ok: false, why: "that isn't a full commit sha" };
  const f = watchFile(dir, sha);
  let x: any;
  try { x = JSON.parse(readFileSync(f, "utf8")); } catch { return { ok: false, why: `no watch is kept for ${sha} (${f})` }; }
  if (x?.accepted_head !== sha) return { ok: false, why: `the watch kept for ${sha} accepted nothing: there is nothing to supersede` };
  if (x.superseded) return { ok: true, pr: typeof x.pr === "number" ? x.pr : null };
  if (typeof x.pr !== "number") return { ok: false, why: `the watch kept for ${sha} names no pull request, so its head can't be checked: nothing is superseded` };
  const read = await headOf(x.pr).catch((): HeadMiss => ({ miss: "unreadable", why: "the read failed" }));
  const keep = (y: any) => { writeFileSync(`${f}.tmp`, JSON.stringify(y, null, 2) + "\n"); renameSync(`${f}.tmp`, f); };
  if (read !== null && typeof read === "object" && read.miss === "rate_limit") {
    const minutes = read.wait_ms !== null ? Math.max(1, Math.ceil(read.wait_ms / 60_000)) : null;
    try { keep({ ...x, supersede_owed: { reason: "rate_limit", ...(minutes !== null ? { wait_minutes: minutes } : {}) } }); } catch { /* the answer still says it is owed */ }
    return { ok: false, owed: true, why: `GitHub's rate limit stopped the read of pull request ${x.pr}'s head${minutes !== null ? ` (it asked to wait about ${minutes} minutes)` : ""}: nothing is superseded yet, and the supersede is owed (kept on ${f}); run this again once the wait is over` };
  }
  const now_head = typeof read === "string" ? read : null;
  if (!now_head || !SHA.test(now_head.toLowerCase())) return { ok: false, why: `${read !== null && typeof read === "object" ? headMissWords(read) : "the pull request's head couldn't be read from GitHub"}: nothing is superseded on pull request ${x.pr}; try again` };
  if (now_head.toLowerCase() === sha) {
    const still = `pull request ${x.pr}'s head is still ${now_head.toLowerCase()}, the sha being replaced: supersede only once a new head has been pushed`;
    if (!x.supersede_owed) return { ok: false, why: still };
    const lock = lockFile(dir, x.pr);
    const got = takeLock(lock, 2_000);
    if (!("token" in got)) return { ok: false, why: `${still}; its owed mark stays, because the pull request's watch lock (${lock}) couldn't be taken (a watch may be running): run this again in a minute` };
    try {
      let y: any;
      try { y = JSON.parse(readFileSync(f, "utf8")); } catch { return { ok: false, why: `${still}; the record (${f}) couldn't be read again under the lock, so its owed mark stays` }; }
      const live = watchAccepted(JSON.stringify(y), readGen(dir, x.pr));
      if (!y.supersede_owed) return { ok: false, why: `${still}; its supersede is no longer owed` };
      if (!live || live.head !== sha || live.pr !== x.pr) return { ok: false, why: `${still}; the acceptance of ${sha} no longer counts (a takeover moved the generation on), so watch the pull request's head again` };
      const again = await headOf(x.pr, got.since + (o.criticalMs ?? CRITICAL_MAX_MS)).catch((): HeadMiss => ({ miss: "unreadable", why: "the read failed" }));
      if (typeof again === "string" && again.toLowerCase() !== sha)
        return { ok: false, why: `pull request ${x.pr}'s head moved to ${again.toLowerCase()} while its owed mark was being cleared: the mark stays; run this again to supersede the acceptance of ${sha}` };
      if (typeof again !== "string")
        return { ok: false, why: `${again !== null ? headMissWords(again) : "the pull request's head couldn't be read from GitHub"} when it was read again under the lock: the owed mark stays; run this again` };
      if (!ownsLock(got)) return { ok: false, why: `the pull request's watch lock (${lock}) was taken over while the head was read again: the owed mark stays; run this again` };
      const { supersede_owed: _o, ...kept } = y;
      try { keep({ ...kept, owed_cleared: { why: OWED_CLEARED, at: now().toISOString() } }); } catch { return { ok: false, why: `${still}; the record (${f}) couldn't be written, so its owed mark stays: run this again` }; }
      console.error(`ship gate: the supersede owed on ${f} is ${OWED_CLEARED}`);
      return { ok: false, cleared: true, why: `${still}. The supersede that was owed is ${OWED_CLEARED}: the mark is cleared, and the acceptance of ${sha} stands as the pull request's current one` };
    } finally { letGo(got); }
  }
  const { supersede_owed: _owed, ...rest } = x;
  keep({ ...rest, superseded: { at: now().toISOString() } });
  return { ok: true, pr: typeof x.pr === "number" ? x.pr : null };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dir = flag("--dir") ?? WATCH_DIR;
  const usage = () => {
    console.error("usage: shipgate.ts <full head sha> [--watch [--every <minutes>] [--hours <hours>] [--out <file>]] [--repo owner/name]\n       shipgate.ts --pr <number> --head <full sha> --watch [...]\n       shipgate.ts --supersede <full sha>\n       shipgate.ts --recover-generation <pull request number> [--floor <number>]\n       shipgate.ts --quarantine <full sha> [--pr <number>]\n       shipgate.ts --quarantine-lock <pull request number>\n       shipgate.ts --set-aside <file> --pr <pull request number>");
    process.exit(2);
  };
  const quarLock = flag("--quarantine-lock");
  if (quarLock !== undefined) {
    if (!/^\d{1,7}$/.test(quarLock)) usage();
    const r = quarantineLock(dir, Number(quarLock));
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(`the lock files that didn't parse were set aside as ${r.moved.join(", ")} (recorded in ${quarantineLog(dir)}); run the refused command again`);
    process.exit(0);
  }
  // 0.12.2: a set-aside file the log doesn't record and whose name names no pull request, moved to the archive folder.
  const aside = flag("--set-aside");
  if (aside !== undefined) {
    const ap = flag("--pr");
    if (ap === undefined || !/^\d{1,7}$/.test(ap)) usage();
    const r = setAside(dir, aside, Number(ap));
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(`the file was moved to ${r.as} (recorded in ${quarantineLog(dir)}); nothing was deleted; run the refused command again`);
    process.exit(0);
  }
  const quar = flag("--quarantine");
  if (quar !== undefined) {
    const qp = flag("--pr");
    if (qp !== undefined && !/^\d{1,7}$/.test(qp)) usage();
    const r = quarantineRecord(dir, quar.toLowerCase(), qp !== undefined ? { pr: Number(qp) } : {});
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(`the record was set aside as ${r.as} (recorded in ${quarantineLog(dir)}); run the refused command again`);
    process.exit(0);
  }
  const rec = flag("--recover-generation");
  if (rec !== undefined) {
    const fl = flag("--floor");
    if (!/^\d{1,7}$/.test(rec) || (fl !== undefined && !/^\d{1,15}$/.test(fl))) usage();
    const r = recoverGen(dir, Number(rec), fl !== undefined ? { floor: Number(fl) } : {});
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(`the watch generation of pull request ${rec} is now ${r.gen}: every acceptance kept before it no longer counts; watch the pull request's head again`);
    process.exit(0);
  }
  const sup = flag("--supersede");
  // Twenty-ninth round: every mode that reads GitHub (the supersede, the dry run and the watch) refuses to start with curl
  // missing or older than 7.32, by name; the wrapper checks again on every read (ghGet).
  { const why = curlRefusal(curlVersion()); if (why) { console.error(why); process.exit(1); } }
  if (sup !== undefined) {
    // 0.12.2: the read again under the gate lock (an owed mark being cleared) takes its time from the lock's bound.
    const headOf = async (n: number, deadline?: number) => ghHeadRead(flag("--repo") ?? SHIP_REPO, n, { token: githubToken(), maxS: API_READ_S, ...(deadline !== undefined ? { deadline } : {}) });
    const r = await supersede(dir, sup.toLowerCase(), headOf);
    if (!r.ok && r.cleared) { console.log(r.why); process.exit(0); }
    if (!r.ok) { console.error(`${r.why}${r.owed ? quotaNote() : ""}`); process.exit(r.owed ? 3 : 1); }
    console.log(JSON.stringify({ superseded: sup.toLowerCase(), pr: r.pr }, null, 2));
    process.exit(0);
  }
  const prArg = flag("--pr");
  const pr = prArg !== undefined && /^\d{1,7}$/.test(prArg) ? Number(prArg) : null;
  const head = (prArg !== undefined ? flag("--head") ?? "" : args[0] ?? "").toLowerCase();
  const repo = flag("--repo") ?? SHIP_REPO;
  const d: Pick<MergeDeps, "api"> = { api };
  // Twenty-sixth round: the head read at the acceptance goes through curl; without it no acceptance could be checked.
  // Twenty-eighth round: and curl must be 7.32 or newer, for the fractional time limits the deadline hands it (twenty-
  // ninth round: checked above for every mode that reads GitHub, and again by the wrapper on every read).
  if (!SHA.test(head) || (prArg !== undefined && (pr === null || !args.includes("--watch"))) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) usage();
  // One live acceptance per pull request: a watch doesn't start while another stands.
  if (pr !== null) {
    const other = otherLive(dir, pr, head);
    if (!Array.isArray(other)) { console.error(`the Ship gate's state can't be read (${other.unknown}): nothing is watched`); process.exit(1); }
    if (other.length) { console.error(liveWhy(other)); process.exit(1); }
  }
  if (!args.includes("--watch")) {
    const rep = await gateReport(d, repo, head);
    console.log(JSON.stringify({ ...rep, ...(rep.decision !== "accept" && localCause() ? { local_cause: localCause() } : {}) }, null, 2));
  } else {
    const every = Math.min(Math.max(Number(flag("--every") ?? 10), 2), 60) * 60_000;
    const hours = Math.min(Math.max(Number(flag("--hours") ?? 2), 0.1), 2) * 3_600_000;
    const out = flag("--out") ?? watchFile(dir, head);
    const watched = await watchShipGate(d, repo, pr !== null ? { pr, head } : head, { everyMs: every, untilMs: hours,
      each: (r) => console.log(JSON.stringify({ at: r.at, decision: r.decision, why: r.why, ...(r.decision !== "accept" && localCause() ? { local_cause: localCause() } : {}), windows: r.windows, attempts: r.attempts.length })) });
    let line = watched;
    // Twenty-fifth round: the acceptance is checked against the pull request's head as GitHub has it at check time.
    // A watch that couldn't keep its line at all accepted nothing (never the unkept acceptance).
    try { line = keepWatch(dir, watched, out, { headNow: (n, _h, deadline) => ghHeadRead(repo, n, { token: githubToken(), deadline }) }); }
    catch { line = watched.accepted_head ? { ...watched, accepted_head: null, passed: false, failure: "lock_unavailable", failure_why: "the watch's line couldn't be kept: nothing was accepted; run the watch again" } : watched; }
    // Twenty-eighth round: every refusal says how many GitHub reads are left this hour when the watch has no token.
    const why = line.failure_why ? `${line.failure_why}${quotaNote()}` : line.failure_why;
    console.log(JSON.stringify({ step: line.step, pr: line.pr, head: line.bound_head, accepted_head: line.accepted_head, passed: line.passed, failure: line.failure, failure_why: why,
      refused_while_pending: line.refused_while_pending, accepted_early: line.accepted_early, accepted_after_pass: line.accepted_after_pass, attempts_seen: line.attempts_seen, kept: out }, null, 2));
    if (line.failure) process.exit(1);
  }
}
