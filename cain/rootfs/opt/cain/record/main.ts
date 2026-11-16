// Cain's record keeper: the one writer of the record (the private org repo).
// Keeps a copy of the record on the Pi (/data/record, so Home Assistant's
// backups carry it off the box), applies requests one at a time, commits each,
// pushes, and runs the nightly check. Requests come from:
//   - Cain, through /opt/cain/record.sh (a local queue folder), and
//   - the record's own inbox/ folder (Dane's page and laptop sessions).
// Safety rules: a request leaves its queue only after the commit carrying it is
// confirmed on GitHub; a request id is applied at most once; nothing is written
// through a link. A push that fails never resets the keeper's copy: its local commits
// stay, the outcomes it already wrote stay valid, and the next round rebases them onto
// GitHub's copy and pushes again. Only when that can't be done (the rebase conflicts, or
// the copy has to be cloned again) is the copy reset, and then the link refuses asks and
// taps until the next push lands (the status file below says so).
// Holds (who holds which item) are the keeper's own: its copy in /data is the one
// that counts, and the record's state/holds.json is put back to it if it drifts.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRequest, plan, hygiene, hygieneReport, clean, expired, idleMs, holdsText, parseHolds, HOLDS_PATH, HOLD_IDLE_MS,
  maxCheckDays, oneOffAudit, ONE_OFF_AUDIT_PATH, ONE_OFF_SUMMARY, PENDING_PATH, upkeep, generationOf, CHECKS_PATH, checksText, parseChecks, type OneOff, type WaitTimeout,
  type Downtime, type Holds, type Outcome, type Plan, type Request, type Tree } from "./core.ts";
import { projectChecked, TAP_KEY, tapDerived, tapIssuedProblem, voidChecks, type IssuedTap } from "./core.ts";
import { dateHeaderReading, localReadings, verdict, verdictKey, type Reading, type Verdict } from "../clock.ts";
import { teeConsole } from "../logfile.ts";
import { appendLog, readLog, syncDir } from "../applog.ts";
import { installState } from "../installflag.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; relay: string;
  branch: string; token?: string; hygieneAt: string; tz: string; now?: () => Date;
  holds?: string;   // the keeper's own copy of the holds; default /data/record-holds.json (next to the queue)
  maxCheckDays?: number;   // the App's source_check_max_days (default 7): a check's stale_after, and the Checked cells
  clockSynced?: () => boolean;   // the tests' stand-in for the clock sources: one reading, synced or not
  // The clock sources, given the Date header of this round's GitHub fetch (null: none) and the
  // system time it ended at (default: ../clock.ts, the box's three sources then that header).
  clockReadings?: (dateHeader: string | null, at: number) => Reading[];
  status?: string;         // the keeper's status for the link (default /data/record-ledger.json, next to the queue)
  blockPush?: string;      // the smoke test's switch: while this file exists, a round pushes to a wrong remote (default /data/record-block-push);
                           // empty, for one round; holding a time (ms since 1970), for every round until then
  clockTest?: string;      // the smoke test's clock switch (default /data/record-clock-test): "header-only" (one round with the box's
                           // own sources left out, so GitHub's Date header decides), "none" (no source says synchronized), or
                           // "step:-600" (the keeper's clock reads that many seconds off), the last two while the file exists
  forceConflict?: string;  // the smoke test's switch (default /data/record-force-conflict): the next round with local commits
                           // GitHub doesn't have treats their rebase as a conflict and resets the copy, as a real one would
  linkState?: string;      // the link's own state (default /data/link/state.json, next to the queue), read only: the highest ledger generation
                           // it posted on a card is a floor for the keeper's, so a re-clone with its state file lost never goes below it
  checkin?: string;        // where new audit lines wait for Cain's next check-in (default /data/record-checkin.txt, next to the queue)
  waits?: string;          // the link's wait timeouts (default /data/record-waits.jsonl, next to the queue)
  beforePush?: () => void; // the tests' hook: runs right before the push
  fetchDate?: () => string | null;   // the tests' stand-in for GitHub's Date header on a fetch from a local remote
  leakCheck?: string;      // the smoke test's leak check (default /data/record-leak-check): see leakCheck()
  logFile?: string;        // the keeper's log copy (RECORD_LOG, /data/work/record-keeper.log), which the leak check reads
  workDir?: string;        // the folder the leak check reads whole (default: the log copy's folder, /data/work)
  tapsLog?: string;        // round 11: the append-only log of consumed tap keys (default /data/record-taps.jsonl, next to the queue)
  linkIssued?: string;     // round 12: the link's issued-key log, read only (default /data/link-issued.log)
  issuedLog?: string;      // round 12: the keeper's own mirror of it (default /data/record-issued.log)
  installLog?: string;     // round 13: the install-taps log the keeper owns (default /data/record-install.log)
  recover?: string;        // round 13: the owner's accepted recover-logs line (default /data/record-recover.json)
  onItem?: (id: string) => void;   // round 13: the tests' hook, run as each request comes up for its decision
  landings?: string;       // round 14: the link's landing ledger, read only (default /data/record-landings): a key it shows started counts as consumed
  linkHeld?: string;       // round 14: the link's held-tap log, read only (default /data/link-held.log): a held tap's tap time
};
// Round 14: the reason an ordinary start's consumed set is unverified until a fresh fetch (the link reads it
// as "not a restore"; the same words are in link/core.ts).
export const KEEPER_START_WHY = "a start: the consumed tap keys are checked against the record remote before any tap counts";
// Round 14: the consumer named for a key the landing ledger shows started.
export const LEDGER_CONSUMER = "the link's landing ledger (its landing started)";

// Whether the system clock is synchronized by the box's own sources (../clock.ts: the kernel's
// flag first, then timedatectl, then timesyncd's flag file). The keeper's rounds add a fourth,
// GitHub's Date header on their fetch.
export function clockSynced(): boolean {
  return verdict(localReadings()).synced;
}

// The smoke test's clock switch, as this round reads it (null: off). header-only is used up by
// the round that reads it.
type ClockTest = { kind: "header-only" } | { kind: "none" } | { kind: "step"; ms: number };
function clockTest(cfg: Config): ClockTest | null {
  const f = cfg.clockTest ?? join(dirname(cfg.queue), "record-clock-test");
  if (!existsSync(f)) return null;
  let t = "";
  try { t = readFileSync(f, "utf8").trim(); } catch { return null; }
  if (t === "header-only") { rmSync(f, { force: true }); return { kind: "header-only" }; }
  if (t === "none") return { kind: "none" };
  const m = /^step:(-?\d{1,6})$/.exec(t);
  if (m) return { kind: "step", ms: Number(m[1]) * 1000 };
  return null;
}

// The round's clock verdict, from the configured sources (and the smoke test's switch).
function clockVerdict(cfg: Config, dateHeader: string | null, at: number, test: ClockTest | null = null): Verdict {
  if (test?.kind === "none") return verdict([{ source: "kernel", state: "unsynced", detail: "smoke test: clock-test none" },
    { source: "http-date", state: "unsynced", detail: "smoke test: clock-test none" }]);
  if (test?.kind === "header-only") return verdict([dateHeaderReading(dateHeader, at)]);
  if (cfg.clockReadings) return verdict(cfg.clockReadings(dateHeader, at));
  if (cfg.clockSynced) {
    let ok = false;
    try { ok = cfg.clockSynced() === true; } catch { ok = false; }
    return verdict([{ source: "kernel", state: ok ? "synced" : "unsynced" }, dateHeaderReading(dateHeader, at)]);
  }
  return verdict([...localReadings(), dateHeaderReading(dateHeader, at)]);
}

const MAX_RAW = 1_000_000;
const MAX_NOTE = 2_000;
const DOWN_AFTER_MS = 5 * 60_000;   // this long between good rounds counts as keeper downtime
const KEEPER = "Cain's record keeper";   // the name on the keeper's own commits
const log = (m: string) => console.log(`[record] ${m}`);

export function blobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

class GitError extends Error {}

// What git said, with the token and any credentials in a remote's address taken out, so neither
// reaches a log line, the status file or a line relayed to Cain.
export function redact(cfg: { token?: string }, text: string): string {
  let out = text;
  if (cfg.token) out = out.split(cfg.token).join("<token>");
  return out
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+@/gi, "$1<userinfo>@")
    // An Authorization header in any form, and a Basic or Bearer credential on its own.
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)(?:(basic|bearer|token)\s+)?[^\s"',;]+/gi, (_m, h: string, k?: string) => `${h}${k ? `${k} ` : ""}<redacted>`)
    .replace(/\b(basic|bearer)\s+(?!<redacted>)[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 <redacted>");
}

// The forms the leak check looks for besides the token itself: a web address's userinfo, and
// an Authorization header or a Basic or Bearer credential.
const USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/@<>'"]+@/i;
const AUTH_HEADER = /\b(?:proxy-)?authorization\s*[:=]\s*(?!<redacted>)\S+|\b(?:basic|bearer)\s+(?!<redacted>)[A-Za-z0-9._~+\/=-]{12,}/i;
export function leakForms(text: string, token?: string): { token: boolean; userinfo: boolean; header: boolean } {
  return { token: !!token && text.includes(token), userinfo: USERINFO.test(text), header: AUTH_HEADER.test(text) };
}

// GitHub's Date header, from an unauthenticated HEAD request to the remote's host (no
// credentials, no path, no git tracing): the round's fourth clock source. null when the remote
// isn't https or the host doesn't answer within 5 seconds.
export function headDate(remote: string): string | null {
  let host = "";
  try { const u = new URL(remote); if (u.protocol !== "https:") return null; host = u.host; } catch { return null; }
  try {
    const p = Bun.spawnSync(["curl", "-sSI", "-m", "5", "--proto", "=https", `https://${host}/`],
      { stdout: "pipe", stderr: "pipe", env: proxyEnv() });
    const m = /^date:\s*(.+?)\s*$/im.exec(p.stdout.toString());
    return m ? m[1] : null;
  } catch { return null; }
}

// Only what curl needs to reach the host: no token, no askpass, no git settings.
function proxyEnv(): Record<string, string> {
  const e: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const k of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]) if (process.env[k]) e[k] = process.env[k]!;
  return e;
}

// git with tracing off (nothing of the HTTP exchange is ever traced), the token only through
// the askpass helper, and what it says redacted.
function git(cfg: Config, args: string[], cwd = cfg.dir): string {
  const env: Record<string, string> = { ...process.env as any, GIT_TERMINAL_PROMPT: "0" };
  for (const k of ["GIT_TRACE", "GIT_TRACE_CURL", "GIT_TRACE_CURL_NO_DATA", "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE", "GIT_TRACE_SETUP", "GIT_CURL_VERBOSE"]) delete env[k];
  env.GIT_TRACE = "0"; env.GIT_TRACE_CURL = "0"; env.GIT_CURL_VERBOSE = "0";
  if (cfg.token) {
    // Rewritten every time, so nothing planted there is ever used.
    const ask = "/tmp/record-askpass.sh";
    writeFileSync(ask, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token;; *) echo "$RECORD_TOKEN";; esac\n', { mode: 0o700 });
    env.GIT_ASKPASS = ask; env.RECORD_TOKEN = cfg.token;
  }
  // Byte-exact files (the shas writers send are of the bytes as committed), links
  // checked out as plain files, and no hooks from the copy's own config.
  const p = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null",
    "-c", `user.name=${KEEPER}`, "-c", "user.email=HyndeSyte@users.noreply.github.com", ...args],
    { cwd, env, stdout: "pipe", stderr: "pipe" });
  let out = (p.stdout.toString() + p.stderr.toString()).trim();
  out = redact(cfg, out);
  if (p.exitCode !== 0) throw new GitError(`git ${args[0]}: ${out.split("\n")[0]}`);
  return out;
}

// The keeper's copy, brought up to GitHub's. Local commits GitHub doesn't have yet (a push
// that failed) are kept and rebased onto what GitHub has; only a rebase that conflicts resets
// the copy to GitHub's (reset says why). A fetch that fails (GitHub down) leaves the copy as
// it is, so local work goes on. date: GitHub's Date header on the fetch (null: none).
type Synced = { date: string | null; fetchedAt: number; cloned: boolean; fetched: boolean; reset: string | null };
const conflictFile = (cfg: Config) => cfg.forceConflict ?? join(dirname(cfg.queue), "record-force-conflict");
function sync(cfg: Config, now: () => number = Date.now): Synced {
  let cloned = false, reset: string | null = null;
  if (!existsSync(join(cfg.dir, ".git"))) {
    mkdirSync(dirname(cfg.dir), { recursive: true });
    rmSync(cfg.dir, { recursive: true, force: true });
    git(cfg, ["clone", "--quiet", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", cfg.remote, cfg.dir], dirname(cfg.dir));
    cloned = true;
  }
  rmSync(join(cfg.dir, ".git", "index.lock"), { force: true });   // left by a restart mid-commit
  if (existsSync(join(cfg.dir, ".git", "rebase-merge")) || existsSync(join(cfg.dir, ".git", "rebase-apply")))
    try { git(cfg, ["rebase", "--abort"]); } catch { /* nothing to abort */ }
  // What a round left half-written (never committed) goes; commits stay.
  git(cfg, ["reset", "--quiet", "--hard", "HEAD"]);
  git(cfg, ["clean", "-qfd"]);
  let fetched = true;
  try { git(cfg, ["fetch", "--quiet", "origin", cfg.branch]); }
  catch (e) { fetched = false; log(`couldn't fetch from GitHub (${(e as Error).message}); working on the local copy`); }
  const fetchedAt = now();
  if (fetched) {
    if (ahead(cfg)) {
      try {
        // The smoke test's forced conflict: this rebase counts as one that conflicted.
        if (existsSync(conflictFile(cfg))) { rmSync(conflictFile(cfg), { force: true }); throw new GitError("git rebase: conflict forced by the smoke test (record.sh force-conflict)"); }
        git(cfg, ["rebase", "--quiet", `origin/${cfg.branch}`]);
      }
      catch (e) {
        try { git(cfg, ["rebase", "--abort"]); } catch { /* none in progress */ }
        reset = `its local commits couldn't be rebased onto GitHub's copy (${clean((e as Error).message, 160)})`;
        git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);
        git(cfg, ["clean", "-qfd"]);
      }
    } else git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);   // a fast-forward: nothing local is lost
  }
  // The Date header comes from its own unauthenticated HEAD request, never from git's exchange.
  const date = fetched ? (cfg.fetchDate ? cfg.fetchDate() : headDate(cfg.remote)) : null;
  return { date, fetchedAt: date && !cfg.fetchDate ? now() : fetchedAt, cloned, fetched, reset };
}

// The copy has commits GitHub doesn't (as last fetched).
function ahead(cfg: Config): boolean {
  try { git(cfg, ["merge-base", "--is-ancestor", "HEAD", `origin/${cfg.branch}`]); return false; } catch { return true; }
}

// No part of the path may be a link, so a write can't land outside the record.
function linkFree(cfg: Config, path: string): boolean {
  let at = cfg.dir;
  for (const part of path.split("/")) {
    at = join(at, part);
    if (!existsSync(at)) return true;
    if (lstatSync(at).isSymbolicLink()) return false;
  }
  return true;
}

function tree(cfg: Config): Tree {
  const read = (p: string) => {
    const f = join(cfg.dir, p);
    if (!existsSync(f) || !linkFree(cfg, p)) return null;
    return lstatSync(f).isFile() ? readFileSync(f, "utf8") : null;
  };
  // An earlier version of a file, by the blob sha a writer read it at.
  const blob = (sha: string) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const p = Bun.spawnSync(["git", "cat-file", "blob", sha], { cwd: cfg.dir, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  };
  return { read, sha: (p) => { const t = read(p); return t === null ? null : blobSha(t); }, blob,
    isDir: (p) => { const f = join(cfg.dir, p); return existsSync(f) && lstatSync(f).isDirectory(); } };
}

type Pending = { req?: Request; error?: string; local?: string; repoPath?: string; name: string };

function readRequest(file: string): { req?: Request; error?: string } {
  const st = lstatSync(file);
  if (!st.isFile()) return { error: "not a file" };
  if (st.size > MAX_RAW) return { error: "over 1 MB" };
  return parseRequest(readFileSync(file, "utf8"));
}

const jsonNames = (d: string) => readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();

function pending(cfg: Config): Pending[] {
  const out: Pending[] = [];
  mkdirSync(cfg.queue, { recursive: true });
  // Names starting with "." are still being written (record.sh copies, then renames).
  for (const name of jsonNames(cfg.queue)) {
    const local = join(cfg.queue, name);
    const r = readRequest(local);
    // The local queue is Cain's alone: what's in it is from Cain, never a note from Dane.
    if (r.req && r.req.from !== "cain") r.error = "the local queue only takes requests from cain";
    else if (r.req?.kind === "note") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), local, name });
  }
  const inbox = join(cfg.dir, "inbox");
  if (existsSync(inbox) && linkFree(cfg, "inbox")) for (const name of jsonNames(inbox)) {
    const r = readRequest(join(inbox, name));
    if (r.req && (r.req.from === "cain" || r.req.id.startsWith("cain-"))) r.error = "requests in inbox/ can't speak for Cain";
    else if (r.req?.kind === "note" && r.req.from !== "page") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), repoPath: `inbox/${name}`, name });
  }
  return out;
}

// Cain's queue has something in it (cheap: no git).
export function queued(cfg: Config): boolean {
  return existsSync(cfg.queue) && jsonNames(cfg.queue).some((n) => !appliedNames.has(n));
}

// Every request id in log/requests, with the last outcome logged for it.
function logbook(cfg: Config): Map<string, Outcome> {
  const last = new Map<string, Outcome>();
  const d = join(cfg.dir, "log", "requests");
  if (!existsSync(d)) return last;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl")).sort())
    for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
      try { const o = JSON.parse(line); if (o?.id) last.set(o.id, o); } catch { /* skip */ }
    }
  return last;
}

function relay(cfg: Config, text: string) {
  appendFileSync(cfg.relay, JSON.stringify({ text: clean(text, 2400) }) + "\n");
}

function logOutcome(cfg: Config, o: Outcome) {
  const p = join(cfg.dir, "log", "requests", `${o.at.slice(0, 7)}.jsonl`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(o) + "\n");
}

const outcomeFile = (cfg: Config, id: string) => join(cfg.outcomes, `${id.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`);

// ---- The keeper's own state, in /data: the holds, takes waiting behind Cain's
// jobs, when the keeper last finished a round (for its downtime), and the last
// commit it pushed. ----

type Waiting = { req: Request; since: string; local: boolean };
// What Cain must hear about a request once GitHub has it (its status file, log lines, relayed
// lines), kept across rounds while a push fails.
type Owed = { o: Outcome; local: boolean; relay: string[]; log: string[] };
type State = { holds: Holds; waiting: Waiting[]; alive?: string; downtime: Downtime; pushed?: string;
  generation?: number;                    // the highest ledger generation the keeper has written or seen
  unpushed?: boolean;                     // local commits GitHub doesn't have: the last push failed
  pushFailed?: { at: string; why: string; since?: string };   // the last push error; since: the first of this run of them
  reset?: { at: string; why: string };    // the copy was reset (lost local commits) since the last push that landed
  lastReset?: { at: string; why: string };   // the latest reset, kept after the push that ends it (the link reports taps made before it)
  outage?: { since: string; rounds: number };   // rounds that ended unpushed or reset, since when (cleared once a push lands)
  // Takes that waited behind a job and were settled in a commit GitHub doesn't have yet: kept until
  // the push that carries them lands, so a reset runs them again like other queued requests.
  settled?: Waiting[];
  owed?: Owed[]; clockKey?: string;
  // The reset epoch (0.12.0): each reset of the copy starts a new one. Every source check the
  // ledger held when it began is void until taken again (voided: the ledger write that dropped
  // them is made), and the link refuses taps on cards whose generation is below its generation.
  epoch?: { n: number; at: string; generation: number; voided?: boolean };
  // A reset whose epoch waits (0.12.0): the link's state couldn't be read when the copy was reset,
  // so the generation of a card posted after its last good save is unknown. The epoch is completed
  // (above everything the link's state then shows) on the first round that can read it; until then
  // the reset stands, even after a push lands.
  epochWait?: { at: string; why: string };
  floorWhy?: string;                      // why the link's state couldn't be read for the floor ("" or absent: it could)
  // Tap keys already acted on (0.12.0): a request carrying a tap key (its optional tap field) is
  // taken once per key; a second request citing a consumed key is refused. Kept here, outside the
  // working copy, so no reset or re-clone forgets one. The newest TAPS_KEPT.
  taps?: Record<string, { id: string; at: string }>;
  // Round 11: the link's issued tap keys as the keeper has seen them (kept TAP_KEEP_MS, inside the link's four days), so a key
  // a restored link state no longer lists is told as lost, never silently refused; the link's run and
  // nonce last seen (a lower run, or the same run with another nonce, is a restore of its state), and the
  // latest restore seen; and the tap notices for the link (a refused or lost tap-derived request), which
  // go into the status file for it to tell him once each.
  issuedSeen?: Record<string, IssuedTap & { at: string }>;   // before round 12; the mirror log replaces it
  linkSeen?: { run: number; nonce: string };
  // Round 12: how many records each of the keeper's append-only logs held after its last round (the
  // high-water count): a log missing or shorter than that refuses the keeper's start.
  logHigh?: { consumed?: number; issued?: number; install?: number };
  linkRestore?: { at: string; why: string };
  // Round 13: a detected restore (a log missing or shorter than its high-water count, or the keeper's state
  // missing): the consumed set isn't verified until it is rebuilt from the record remote's history, which
  // needs GitHub. Meanwhile every tap-derived request is held (told: the request ids Cain heard pending for),
  // and the rebuild is tried again each round GitHub answers (tries, next: its log line's backoff).
  rebuild?: { since: string; why: string; tries: number; next?: string; told?: string[] };
  recovered?: string[];                   // round 13: the owner's recover-logs message ids already used
  historyCards?: string[];                // round 13: card message ids named by Tap-Card trailers (newest last)
  // Round 14: the owner-line nonces used (install taps on <nonce>, recover logs <nonce>): committed with an
  // Owner-Line trailer (linesDone), and as the record's history has them (historyLines); recoverLines: a
  // recover line accepted at the start check, waiting for its trailer.
  linesDone?: string[]; historyLines?: string[]; recoverLines?: { nonce: string; said: string }[];
  tapNotices?: TapNotice[] };
type TapNotice = { tap: string; why: "refused" | "lost" | "expired"; reason: string; msg?: string; at: string };
const TAPS_KEPT = 1000;
// Round 9: a consumed tap key is pruned once it is older than the longest card lifetime (an ask or
// Ship card lasts until the next morning check-in, or the one after: under two days) plus a margin.
export const TAP_KEEP_MS = 3 * 86_400_000;
// Round 10: never one whose landing the link still lists as unresolved (keep).
export function pruneTaps(taps: Record<string, { id: string; at: string }> | undefined, now: number, keep?: Set<string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(taps ?? {})) {
    if (keep?.has(k)) continue;
    const at = Date.parse(v.at);
    if (Number.isFinite(at) && now - at > TAP_KEEP_MS) { delete taps![k]; n++; }
  }
  return n;
}

const stateFile = (cfg: Config) => cfg.holds ?? join(dirname(cfg.queue), "record-holds.json");
// Round 11: consumed tap keys, in the keeper's own folder (/data/record-taps.jsonl), outside the working
// copy and apart from the link's state, so neither a reset of the copy nor a restore of the link's state
// forgets one. Never pruned. Round 12: one framed record each ({tap, id, at}: ../applog.ts), appended and
// fsynced; a torn final record is truncated at the next read and told once.
export const tapsLogFile = (cfg: Config) => cfg.tapsLog ?? join(dirname(cfg.queue), "record-taps.jsonl");
export const linkIssuedFile = (cfg: Config) => cfg.linkIssued ?? join(dirname(cfg.queue), "link-issued.log");
export const issuedMirrorFile = (cfg: Config) => cfg.issuedLog ?? join(dirname(cfg.queue), "record-issued.log");
export const installLogFile = (cfg: Config) => cfg.installLog ?? join(dirname(cfg.queue), "record-install.log");
export const recoverFile = (cfg: Config) => cfg.recover ?? join(dirname(cfg.queue), "record-recover.json");
// Round 12: an issued key counts for its whole actionable life: until consumed or tombstoned (90 days),
// plus a margin. The link keeps it as long (TAP_ISSUED_KEEP_MS).
export const ISSUED_KEEP_MS = 100 * 86_400_000;
export function readConsumed(cfg: Config): Map<string, string> {
  const out = new Map<string, string>();
  // Round 14: a request's id wins over the landing ledger's mark (the Ship take that follows a landing).
  for (const j of readLog<any>(tapsLogFile(cfg), { repair: false }).records)
    if (TAP_KEY.test(j?.tap) && typeof j.id === "string" && (!out.has(j.tap) || out.get(j.tap) === LEDGER_CONSUMER)) out.set(j.tap, j.id);
  return out;
}
// Round 14: the tap keys the link's landing ledger shows a started landing for (a claim not voided).
export const landingsDir = (cfg: Config) => cfg.landings ?? join(dirname(cfg.queue), "record-landings");
export function ledgerStarted(cfg: Config): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(landingsDir(cfg)).filter((n) => /^[0-9a-f]{32}\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    try {
      const j = JSON.parse(readFileSync(join(landingsDir(cfg), n), "utf8"));
      if (typeof j?.key === "string" && !j.settled?.voided) out.add(`tap-${createHash("sha256").update(j.key).digest("hex").slice(0, 12)}`);
    } catch { /* a file mid-write: the next round */ }
  }
  return out;
}
// Round 14: a held tap's tap time, from the link's held-tap log (null: not held there).
export const linkHeldFile = (cfg: Config) => cfg.linkHeld ?? join(dirname(cfg.queue), "link-held.log");
function heldTapTime(cfg: Config, kid: string): number | null {
  try { const r = readLog<any>(linkHeldFile(cfg), { repair: false }).records.find((x) => x?.t === "held" && x.kid === kid); return r && Number.isFinite(Number(r.at)) ? Number(r.at) : null; }
  catch { return null; }
}
function appendConsumed(cfg: Config, tap: string, id: string, at: string) { appendLog(tapsLogFile(cfg), { tap, id, at }); }

// Round 12: the issued keys the keeper knows, from the link's issued-key log and its own mirror of it,
// each with its card's item, kind, label, message id and target; keys older than ISSUED_KEEP_MS are
// stale. runs: the link's run records ({run, nonce}) in the order logged.
export type IssuedRec = IssuedTap & { kid: string; at: number; run?: number; nonce?: string; voided?: boolean; exp?: number };
export function readIssued(cfg: Config, now: number): { keys: Map<string, IssuedRec>; runs: { run: number; nonce: string }[] } {
  const keys = new Map<string, IssuedRec>(), runs: { run: number; nonce: string }[] = [];
  for (const f of [issuedMirrorFile(cfg), linkIssuedFile(cfg)]) {
    let recs: any[] = [];
    try { recs = readLog<any>(f, { repair: f === issuedMirrorFile(cfg) ? undefined : false }).records; } catch { /* unreadable: the other file */ }
    for (const r of recs) {
      if (r?.t === "run" && Number.isInteger(r.run) && typeof r.nonce === "string") { if (f === linkIssuedFile(cfg)) runs.push({ run: r.run, nonce: r.nonce }); continue; }
      if (r?.t !== "key" || !TAP_KEY.test(r.kid) || typeof r.item !== "string" || typeof r.kind !== "string") continue;
      const at = Number(r.at);
      if (Number.isFinite(at) && now - at > ISSUED_KEEP_MS) continue;
      if (!keys.has(r.kid)) keys.set(r.kid, { kid: r.kid, item: r.item, kind: r.kind, ...(typeof r.label === "string" ? { label: r.label } : {}),
        ...(typeof r.msg === "string" ? { msg: r.msg } : {}), ...(r.target && typeof r.target.item === "string" && Array.isArray(r.target.writes) ? { target: r.target } : {}),
        at: Number.isFinite(at) ? at : now, ...(Number.isInteger(r.run) ? { run: r.run } : {}), ...(typeof r.nonce === "string" ? { nonce: r.nonce } : {}),
        ...(typeof r.exp === "number" && Number.isFinite(r.exp) ? { exp: r.exp } : {}) });
    }
  }
  // Round 13: a card the link voided (its record never saved after its keys were logged): withdrawn.
  for (const f of [issuedMirrorFile(cfg), linkIssuedFile(cfg)]) {
    try { for (const r of readLog<any>(f, { repair: false }).records) if (r?.t === "void" && typeof r.msg === "string") for (const k of keys.values()) if (k.msg === r.msg) k.voided = true; }
    catch { /* unreadable: the other file */ }
  }
  return { keys, runs };
}
// Round 12: the link's issued-key records the keeper's mirror doesn't have yet, appended to it, so a
// key the link issued is remembered on both sides for its whole life. Returns how many were added.
function mirrorIssued(cfg: Config): number {
  let link: any[] = [], mine: any[] = [];
  try { link = readLog<any>(linkIssuedFile(cfg), { repair: false }).records; } catch { return 0; }
  try { mine = readLog<any>(issuedMirrorFile(cfg)).records; } catch { /* none yet */ }
  const have = new Set(mine.filter((r) => r?.t === "key").map((r) => r.kid));
  let n = 0;
  for (const r of link) if (r?.t === "key" && TAP_KEY.test(r.kid) && !have.has(r.kid)) { appendLog(issuedMirrorFile(cfg), r); have.add(r.kid); n++; }
  // Round 13: the link's void records too, once each.
  const voided = new Set(mine.filter((r) => r?.t === "void").map((r) => r.msg));
  for (const r of link) if (r?.t === "void" && typeof r.msg === "string" && !voided.has(r.msg)) { appendLog(issuedMirrorFile(cfg), r); voided.add(r.msg); n++; }
  return n;
}

// Round 12: the record remote's history of consumed tap keys: every tap-derived commit carries its key
// as a "Tap-Key: tap-<12 hex>" trailer (and its request id as "Tap-Request"). Read from the remote's
// branch and the local copy's head.
// Round 14: from every ref of the local copy (its branches, unpushed commits included, and the remote's
// branch as last fetched), and with the Owner-Line trailers (lines).
export function historyTaps(cfg: Config, o: { cards?: string[]; once?: Set<string>; refs?: string[]; lines?: Set<string> } = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of o.refs ?? ["--all"]) {
    let text = "";
    try { text = git(cfg, ["log", "--reverse", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)%x1f%h%x1f%(trailers:key=Tap-Card,valueonly,separator=%x2C)%x1f%(trailers:key=Install-Once,valueonly,separator=%x2C)%x1f%(trailers:key=Owner-Line,valueonly,separator=%x2C)", ref]); } catch { continue; }
    for (const rec of text.split("\x1e")) {
      const [k, id, sha, card, once, line] = rec.split("\x1f").map((x) => (x ?? "").trim());
      if (k && TAP_KEY.test(k) && !out.has(k)) out.set(k, id || `the commit ${sha}`);
      if (card && /^\d{15,22}$/.test(card) && o.cards && !o.cards.includes(card)) o.cards.push(card);
      if (once && TAP_KEY.test(once)) o.once?.add(once);
      const n = /^(?:install|recover) ([a-z][0-9a-f]{5})$/.exec(line ?? "");
      if (n) o.lines?.add(n[1]);
    }
  }
  return out;
}
// Round 13: with the card's message id (Tap-Card), and Install-Once when the tap was the one Ship tap an
// install-taps once allowed.
const trailer = (tap?: string, id?: string, card?: string, once?: boolean) => (tap && TAP_KEY.test(tap)
  ? `\n\nTap-Key: ${tap}\nTap-Request: ${clean(id ?? "", 120)}${card && /^\d{15,22}$/.test(card) ? `\nTap-Card: ${card}` : ""}${once ? `\nInstall-Once: ${tap}` : ""}` : "");
// Round 12: per process, the keepers (by working copy) whose consumed set was rebuilt from history.
const rebuilt = new Set<string>();
export function forgetRebuild(cfg: Config) { rebuilt.delete(cfg.dir); }

// Round 12: the keeper's start check: each of its append-only logs (consumed keys, its issued-key
// mirror; round 13: the install log) must be there and hold at least the high-water count its state kept.
// Round 13: one missing or shorter than its count is a detected restore (lost), never fatal: the keeper
// starts degraded and rebuilds. Only a case no rule explains is fatal (a log that can't be read, or with a
// damaged record before its end): then it refuses to start until the owner's recover-logs line.
export function logsCheck(cfg: Config, st: State): { lost: string[]; installLost: boolean; fatal: string | null; fatalFile?: string } {
  const want = st.logHigh ?? {};
  const out: { lost: string[]; installLost: boolean; fatal: string | null; fatalFile?: string } = { lost: [], installLost: false, fatal: null };
  const checks: [string, string, number | undefined][] = [["consumed tap keys", tapsLogFile(cfg), want.consumed],
    ["issued tap keys (the keeper's mirror)", issuedMirrorFile(cfg), want.issued], ["install taps", installLogFile(cfg), want.install]];
  for (const [what, f, high] of checks) {
    let r;
    try { r = readLog(f, { repair: false }); }
    catch (e) { if (!out.fatal) { out.fatal = `its log of ${what} (${f}) can't be read (${(e as Error).message.slice(0, 120)})`; out.fatalFile = f; } continue; }
    if (r.bad) { if (!out.fatal) { out.fatal = `its log of ${what} (${f}) has ${r.bad} damaged record(s) before its end, which no power cut explains`; out.fatalFile = f; } continue; }
    if (!high) continue;
    if (r.missing) out.lost.push(`its log of ${what} is missing, but its state says it held ${high} records`);
    else if (r.records.length < high) out.lost.push(`its log of ${what} holds ${r.records.length} records, fewer than the ${high} its state says it held`);
    else continue;
    if (f === installLogFile(cfg)) out.installLost = true;
  }
  return out;
}
// The high-water counts as the logs stand now (each record counted only once its append was fsynced).
function logCounts(cfg: Config): NonNullable<State["logHigh"]> {
  const n = (f: string) => { try { return readLog(f, { repair: false }).records.length; } catch { return 0; } };
  return { consumed: n(tapsLogFile(cfg)), issued: n(issuedMirrorFile(cfg)), install: n(installLogFile(cfg)) };
}
// Round 13: the owner's accepted recover-logs line (keeper.sh recover-logs, written by the link), under a
// day old and not used before.
function recoverAsked(cfg: Config, st: State, now: number): { said: string; nonce?: string } | null {
  try {
    const j = JSON.parse(readFileSync(recoverFile(cfg), "utf8"));
    const at = Date.parse(String(j?.at ?? ""));
    if (typeof j?.said !== "string" || !/^\d{15,22}$/.test(j.said) || !Number.isFinite(at) || now - at > 86_400_000 || (st.recovered ?? []).includes(j.said)) return null;
    return { said: j.said, ...(typeof j.nonce === "string" && /^[a-z][0-9a-f]{5}$/.test(j.nonce) ? { nonce: j.nonce } : {}) };
  } catch { return null; }
}
let refusedWhy = "";

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function revive(j: any): State | null {
  if (!j || typeof j !== "object") return null;
  const holds = parseHolds(JSON.stringify(j.holds ?? {}));
  if (!holds) return null;
  const waiting: Waiting[] = [];
  for (const w of Array.isArray(j.waiting) ? j.waiting : []) {
    const r = parseRequest(JSON.stringify(w?.req ?? null));
    if (r.req && !r.error && typeof w.since === "string") waiting.push({ req: r.req, since: w.since, local: w.local === true });
  }
  const downtime = (Array.isArray(j.downtime) ? j.downtime : [])
    .filter((d: any) => Array.isArray(d) && d.length === 2 && d.every((x: any) => typeof x === "string" && !Number.isNaN(Date.parse(x))));
  const span = (x: any) => x && typeof x.at === "string" && typeof x.why === "string" ? { at: x.at, why: x.why } : undefined;
  const owed = (Array.isArray(j.owed) ? j.owed : []).filter((w: any) => w && w.o && typeof w.o.id === "string" && Array.isArray(w.relay) && Array.isArray(w.log))
    .map((w: any) => ({ o: w.o, local: w.local === true, relay: w.relay.map(String), log: w.log.map(String) }));
  const pushFailed = span(j.pushFailed), reset = span(j.reset), lastReset = span(j.lastReset);
  if (pushFailed && typeof j.pushFailed.since === "string") (pushFailed as any).since = j.pushFailed.since;
  const settled: Waiting[] = [];
  for (const w of Array.isArray(j.settled) ? j.settled : []) {
    const r = parseRequest(JSON.stringify(w?.req ?? null));
    if (r.req && !r.error && typeof w.since === "string") settled.push({ req: r.req, since: w.since, local: w.local === true });
  }
  const outage = j.outage && typeof j.outage.since === "string" && Number.isInteger(j.outage.rounds) ? { since: j.outage.since, rounds: j.outage.rounds } : undefined;
  return { holds, waiting, alive: typeof j.alive === "string" ? j.alive : undefined, downtime,
    ...(typeof j.pushed === "string" && /^[0-9a-f]{40}$/.test(j.pushed) ? { pushed: j.pushed } : {}),
    ...(Number.isInteger(j.generation) && j.generation > 0 ? { generation: j.generation } : {}),
    ...(j.unpushed === true ? { unpushed: true } : {}), ...(pushFailed ? { pushFailed } : {}), ...(reset ? { reset } : {}),
    ...(lastReset ? { lastReset } : {}), ...(outage ? { outage } : {}), ...(settled.length ? { settled } : {}),
    ...(owed.length ? { owed } : {}), ...(typeof j.clockKey === "string" ? { clockKey: j.clockKey } : {}),
    ...(j.epoch && Number.isInteger(j.epoch.n) && typeof j.epoch.at === "string" && Number.isInteger(j.epoch.generation)
      ? { epoch: { n: j.epoch.n, at: j.epoch.at, generation: j.epoch.generation, ...(j.epoch.voided === true ? { voided: true } : {}) } } : {}),
    ...(span(j.epochWait) ? { epochWait: span(j.epochWait)! } : {}),
    ...(typeof j.floorWhy === "string" && j.floorWhy ? { floorWhy: j.floorWhy } : {}),
    ...(j.taps && typeof j.taps === "object" && !Array.isArray(j.taps)
      ? { taps: Object.fromEntries(Object.entries<any>(j.taps).filter(([k, v]) => TAP_KEY.test(k) && v && typeof v.id === "string" && typeof v.at === "string").map(([k, v]) => [k, { id: v.id, at: v.at }])) } : {}),
    ...(j.issuedSeen && typeof j.issuedSeen === "object" && !Array.isArray(j.issuedSeen)
      ? { issuedSeen: Object.fromEntries(Object.entries<any>(j.issuedSeen).filter(([k, v]) => TAP_KEY.test(k) && v && typeof v.item === "string" && typeof v.kind === "string" && typeof v.at === "string")) } : {}),
    ...(j.linkSeen && Number.isInteger(j.linkSeen.run) && typeof j.linkSeen.nonce === "string" ? { linkSeen: { run: j.linkSeen.run, nonce: j.linkSeen.nonce } } : {}),
    ...(span(j.linkRestore) ? { linkRestore: span(j.linkRestore)! } : {}),
    ...(j.logHigh && typeof j.logHigh === "object" ? { logHigh: { ...(Number.isInteger(j.logHigh.consumed) ? { consumed: j.logHigh.consumed } : {}), ...(Number.isInteger(j.logHigh.issued) ? { issued: j.logHigh.issued } : {}),
      ...(Number.isInteger(j.logHigh.install) ? { install: j.logHigh.install } : {}) } } : {}),
    ...(j.rebuild && typeof j.rebuild.since === "string" && typeof j.rebuild.why === "string" ? { rebuild: { since: j.rebuild.since, why: j.rebuild.why,
      tries: Number.isInteger(j.rebuild.tries) ? j.rebuild.tries : 0, ...(typeof j.rebuild.next === "string" ? { next: j.rebuild.next } : {}),
      ...(Array.isArray(j.rebuild.told) ? { told: j.rebuild.told.filter((x: any) => typeof x === "string").slice(-200) } : {}) } } : {}),
    ...(Array.isArray(j.recovered) ? { recovered: j.recovered.filter((x: any) => typeof x === "string").slice(-50) } : {}),
    ...(Array.isArray(j.historyCards) ? { historyCards: j.historyCards.filter((x: any) => typeof x === "string" && /^\d{15,22}$/.test(x)).slice(-1000) } : {}),
    ...(Array.isArray(j.linesDone) ? { linesDone: j.linesDone.filter((x: any) => typeof x === "string").slice(-200) } : {}),
    ...(Array.isArray(j.historyLines) ? { historyLines: j.historyLines.filter((x: any) => typeof x === "string").slice(-200) } : {}),
    ...(Array.isArray(j.recoverLines) ? { recoverLines: j.recoverLines.filter((x: any) => typeof x?.nonce === "string" && typeof x?.said === "string").slice(-50) } : {}),
    ...(Array.isArray(j.tapNotices) ? { tapNotices: j.tapNotices.filter((n: any) => n && TAP_KEY.test(n.tap) && (n.why === "refused" || n.why === "lost") && typeof n.at === "string")
      .map((n: any) => ({ tap: n.tap, why: n.why, reason: String(n.reason ?? ""), ...(typeof n.msg === "string" ? { msg: n.msg } : {}), at: n.at })) } : {}) };
}

function publishedHolds(cfg: Config): string | null {
  const f = join(cfg.dir, HOLDS_PATH);
  if (!existsSync(f) || !linkFree(cfg, HOLDS_PATH) || !lstatSync(f).isFile()) return null;
  return readFileSync(f, "utf8");
}

function publish(cfg: Config, holds: Holds) {
  if (!linkFree(cfg, HOLDS_PATH)) throw new Error(`${HOLDS_PATH} is behind a link`);
  const f = join(cfg.dir, HOLDS_PATH);
  // A folder can only be there by mistake (nothing may write under it): the file replaces it.
  if (existsSync(f) && lstatSync(f).isDirectory()) rmSync(f, { recursive: true, force: true });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, holdsText(holds));
}

function loadState(cfg: Config): State {
  const file = stateFile(cfg);
  let st: State | null = null;
  if (existsSync(file)) {
    try { st = revive(JSON.parse(readFileSync(file, "utf8"))); } catch { st = null; }
    if (!st) {
      // Set aside, and the copy the keeper last published stands in.
      renameSync(file, `${file}.bad-${Date.now()}`);
      log("the keeper's copy of the holds couldn't be read; set aside, starting from the record's copy");
      st = { holds: parseHolds(publishedHolds(cfg)) ?? {}, waiting: [], downtime: [] };
    }
  }
  // First start (a new install, or /data lost): what the keeper last published.
  st ??= { holds: parseHolds(publishedHolds(cfg)) ?? {}, waiting: [], downtime: [] };
  // A round that stopped between its push and saving this: its journal says what it
  // pushed. Kept only if that push is on GitHub; otherwise its requests are still
  // queued and run again.
  const next = `${file}.next`;
  if (existsSync(next)) {
    try {
      const j = JSON.parse(readFileSync(next, "utf8"));
      if (typeof j.commit !== "string" || !/^[0-9a-f]{40}$/.test(j.commit)) throw new Error("no commit");
      git(cfg, ["merge-base", "--is-ancestor", j.commit, `origin/${cfg.branch}`]);
      const landed = revive(j.state);
      if (landed) { st = { ...landed, pushed: j.commit }; writeAtomic(file, JSON.stringify(st)); }
    } catch { /* never landed */ }
    rmSync(next, { force: true });
  }
  // A /data restored from an older backup must not win: when the keeper itself has
  // published holds since this state's last push, its latest published copy stands.
  if (st.pushed) {
    let mine = "";
    try { mine = git(cfg, ["log", "-1", "--format=%H", `--author=${KEEPER}`, `origin/${cfg.branch}`, "--", HOLDS_PATH]); } catch { /* none */ }
    if (/^[0-9a-f]{40}$/.test(mine) && mine !== st.pushed) {
      let older = false;
      try { git(cfg, ["merge-base", "--is-ancestor", mine, st.pushed]); older = true; } catch { /* published after this state */ }
      let text: string | null = null;
      if (!older) try { text = git(cfg, ["show", `${mine}:${HOLDS_PATH}`]); } catch { text = null; }
      const theirs = parseHolds(text);
      if (theirs) {
        log("the keeper's copy of the holds is older than what it last published (restored from a backup?); starting from the published copy");
        st = { ...st, holds: theirs };
      }
    }
  }
  return st;
}

// The round that is starting. A long gap since the last round that finished is
// downtime: holds don't age through it, since nobody could renew them. Kept in
// memory; saved only when this round finishes, so a round that can't push (an
// outage) doesn't count as the keeper working.
function beat(st: State, now: Date) {
  if (st.alive && now.getTime() - Date.parse(st.alive) > DOWN_AFTER_MS) st.downtime.push([st.alive, now.toISOString()]);
  st.alive = now.toISOString();
  st.downtime = st.downtime.filter(([, b]) => now.getTime() - Date.parse(b) < 30 * 86_400_000).slice(-200);
}

// An item passed to Cain is his from now on, and he hears it at once, with the notes
// the same request left on it: a laptop's pull request goes to Dane's Ship card that
// way, without waiting for a check-in.
export function passLines(req: Request, o: Outcome): string[] {
  if (o.from === "cain") return [];
  const ops: any[] = Array.isArray(req.ops) ? req.ops : [];
  return ops.filter((p) => p?.op === "pass" && p.to === "cain").map((p) => {
    const notes = ops.filter((n) => n?.op === "note" && n.item === p.item && typeof n.text === "string").map((n) => clean(n.text, MAX_NOTE));
    const said = notes.length ? ` Its note: «${notes.join(" ")}»` : "";
    return `${o.from} passed ${clean(p.item, 20)} to you (request ${o.id}): it's yours now.${said} Read its notes with /opt/cain/record.sh notes ${clean(p.item, 20)} before you act on it.`;
  });
}

const message = (o: Outcome) => o.state === "done"
  ? `${o.summary} (request ${o.id}, from ${o.from})`
  : `Request ${o.id} ${o.state}: ${o.reason ?? "relayed to Cain"}`;

// What Cain must hear about a request once GitHub has it, worked out when it is applied (the
// request itself isn't kept) and delivered by deliver() after the push lands.
function owe(o: Outcome, local: boolean, req: Request | undefined, unreadable: boolean): Owed {
  const lines: string[] = [], logs: string[] = [];
  const relay = (_cfg: unknown, text: string) => { lines.push(text); };
  const log = (text: string) => { logs.push(text); };
  const cfg = null;
  log(`${o.id} from ${o.from}: ${o.state}${o.reason ? ` (${o.reason})` : ""}`);
  if (o.state === "done") {
    if (req) for (const line of passLines(req, o)) relay(cfg, line);
    // Applied, with rows left out (a whole-file write with a bundled row): the writer hears which.
    if (!o.reason) { /* nothing more */ }
    else if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was applied, but: ${o.reason}. Fix those rows and send them again.`);
    else if (o.from === "page") relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") was saved, but: ${o.reason}. Apply what he meant yourself, one fact per row.`);
    else log(`inbox request ${o.id} from ${o.from} left rows out; recorded in log/requests`);
  } else if (o.state === "relayed" && req?.note) {
    const about = req.note.about ? ` about ${clean(req.note.about, 120)}` : "";
    const text = clean(req.note.text, MAX_NOTE);
    relay(cfg, `Dane's page sent a note${about} (request ${o.id}). His words, as typed: «${text}»`);
  } else if (o.state === "conflict" || o.state === "rejected") {
    if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was not applied: ${o.state}, ${o.reason}. Re-read the files and send it again if it's still needed.`);
    else if (o.from === "page" && !unreadable) relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") couldn't be saved: ${o.reason}. Apply what he meant yourself and tell him it's done.`);
    else log(`inbox request ${o.id} from ${o.from} was ${o.state}; recorded in log/requests`);
  } else if (o.state === "refused") {
    if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was refused: ${o.reason}. That item has another holder; don't send it again.`);
    else if (o.from === "page") relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") wasn't saved: ${o.reason}. If the item is yours, apply what he meant yourself; if someone else holds it, file his words as a note on it.`);
    else log(`inbox request ${o.id} from ${o.from} was refused; recorded in log/requests`);
  }
  return { o, local, relay: lines, log: logs };
}

// Once GitHub has it: the status file for Cain's own requests, and what Cain must hear.
function deliver(cfg: Config, w: Owed) {
  // Status files are for Cain's own requests, so an inbox file can't overwrite one.
  if (w.local) { mkdirSync(cfg.outcomes, { recursive: true }); writeFileSync(outcomeFile(cfg, w.o.id), JSON.stringify(w.o)); }
  for (const l of w.log) log(l);
  for (const t of w.relay) relay(cfg, t);
}

// One pass: apply everything waiting, one commit per request, then push once. If the push
// fails (a lost race, GitHub down or refusing), the local commits stay: the outcomes already
// written stand, and the push is tried again, after rebasing onto GitHub's copy, within this
// round when GitHub answers and otherwise on the next round. Nothing leaves a queue until
// GitHub has the commit.
export function cycle(cfg: Config): { applied: number; ok: boolean; pushFailed?: boolean } {
  // The smoke test's clock switch, read once per round: a step moves the keeper's clock.
  const test = clockTest(cfg);
  const step = test?.kind === "step" ? test.ms : 0;
  const clock = () => new Date((cfg.now?.() ?? new Date()).getTime() + step);
  let st: State | undefined;
  let cv: Verdict | undefined;
  let was: { alive?: string; downtime: Downtime } = { downtime: [] };
  const unlanded = (x: State) => JSON.stringify({ ...x, alive: was.alive, downtime: was.downtime });
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();   // the round's own time (not the record's clock), for round_ms
    let items: Pending[] = [];
    held = new Set<string>();
    const outcomes: (Outcome | null)[] = [];
    let book = new Map<string, Outcome>();
    let synced0: Synced;
    try {
      // Round 12: a log missing or shorter than its high-water count refuses the round (and the start).
      // Round 13: one missing or shorter is a detected restore: a degraded start that rebuilds; only a case
      // no rule explains refuses, until the owner's recover-logs line.
      { const fresh = !existsSync(stateFile(cfg));
        const st0 = loadState(cfg);
        const lc = logsCheck(cfg, st0);
        const nowIso0 = clock().toISOString();
        if (lc.fatal) {
          const asked = recoverAsked(cfg, st0, clock().getTime());
          if (!asked) {
            const why = lc.fatal;
            if (why !== refusedWhy) { refusedWhy = why; log(`REFUSED TO START: ${why}`); relay(cfg, `The record keeper refuses to start: ${why}. Nothing is applied until then. Only he can accept a rebuild: tell him in one line that the record keeper needs his OK to rebuild its logs, and that if he agrees he sends exactly "recover logs" with the code the App sends him: first run keeper.sh recover-logs (it only proposes that line), then once he sends it keeper.sh recover-logs --said <that message's id> (DOCS.md, Restores). Nothing more.`); }
            return { applied: 0, ok: false, refused: why } as any;
          }
          const aside = `${lc.fatalFile}.damaged-${nowIso0.replace(/[^0-9]/g, "").slice(0, 14)}`;
          try { renameSync(lc.fatalFile!, aside); syncDir(dirname(aside)); }
          catch (e) { try { rmSync(lc.fatalFile!, { recursive: true, force: true }); } catch { /* it stays: the next round refuses again */ } log(`couldn't move ${lc.fatalFile} aside (${(e as Error).message}); removed it instead`); }
          st0.recovered = [...(st0.recovered ?? []), asked.said].slice(-50);
          if (asked.nonce) st0.recoverLines = [...(st0.recoverLines ?? []), { nonce: asked.nonce, said: asked.said }].slice(-50);
          rmSync(recoverFile(cfg), { force: true });
          lc.lost.push(`${lc.fatal}; moved aside on his recover-logs line (message ${asked.said})`);
          log(`RECOVER: the owner's recover-logs line (message ${asked.said}) accepted: ${lc.fatalFile} moved aside, rebuilding`);
        }
        refusedWhy = "";
        if (fresh || lc.lost.length) {
          const why = lc.lost.length ? lc.lost.join("; ") : "the keeper's state was missing (a first start, or a wiped or restored image)";
          st0.rebuild = { since: nowIso0, why, tries: 0 };
          // The counts reset to what the logs hold now, so the loss is detected once.
          st0.logHigh = logCounts(cfg);
          // Install taps default to off after any restore that lost install records.
          if (lc.installLost) {
            try { appendLog(installLogFile(cfg), { t: "flag", how: "off", by: "keeper", why: "a restore lost install-log records", at: nowIso0 }); st0.logHigh.install = (st0.logHigh.install ?? 0) + 1; }
            catch (e) { log(`couldn't write install taps off after the restore: ${(e as Error).message}`); }
          }
          // A keeper with no state takes its holds from the record after the sync, so its state isn't written
          // here: the rebuild mark is carried into this round's state below (startRebuild).
          if (!fresh) writeAtomic(stateFile(cfg), JSON.stringify(st0));
          startRebuild.set(cfg.dir, { rebuild: st0.rebuild!, logHigh: st0.logHigh });
          forgetRebuild(cfg);
          if (lc.lost.length) {
            log(`RESTORE DETECTED: ${why}; starting degraded: tap-derived requests wait until the consumed set is rebuilt from the record's history`);
            relay(cfg, `The record keeper detected a restore (${why}). It started degraded: it rebuilds its consumed tap keys from the record's history on GitHub and its issued keys from the surviving log, resets its counts, and holds every request that carries a tap key until that is done (each held one gets a pending line). Asks go on. Nothing to tell him.`);
          } else log(`no keeper state: the consumed set is rebuilt from the record's history before any tap-derived request is taken`);
        } }
      synced0 = sync(cfg, () => clock().getTime());
      st = loadState(cfg);
      { const sr = startRebuild.get(cfg.dir);
        if (sr) { startRebuild.delete(cfg.dir); if (!st.rebuild) st.rebuild = sr.rebuild; st.logHigh = sr.logHigh; } }
      // The generation floor: the keeper's own count (its state file, in /data outside the
      // working copy) and the highest generation the link has posted on a card, so a re-clone
      // with the state file lost never goes below a card that is up.
      // A link state that can't be read (missing, corrupt, mid-write) never lowers it: the keeper
      // keeps its own floor, says so loudly once per change, and its status tells the link to
      // post no new card until the state can be read again.
      const lf = readLinkFloor(cfg);
      if (lf.floor > (st.generation ?? 0)) st.generation = lf.floor;
      if ((lf.why ?? "") !== (st.floorWhy ?? "")) {
        log(lf.why ? `FLOOR: the link's state can't be read (${lf.why}); keeping the keeper's own generation floor ${st.generation ?? 0} and refusing new cards until it can`
          : "floor: the link's state can be read again; new cards go on");
        if (lf.why) st.floorWhy = lf.why; else delete st.floorWhy;
      }
      // A reset of the copy (a rebase that conflicted, or a copy cloned again after the keeper
      // had written a ledger or the link had posted a card on one): lost local commits. Asks and
      // taps wait for the next push.
      const lost = synced0.reset ?? (synced0.cloned && ((st.generation ?? 0) > 0 || st.unpushed) ? "the keeper's copy of the record was missing and was cloned again from GitHub" : null);
      if (lost) resetCopy(cfg, st, lost, clock(), lf);
      // A reset whose epoch waited on an unreadable link state completes once the state reads.
      if (st.epochWait && !lf.why) completeEpoch(st, lf.floor, clock());
      // A round counts as the keeper working only once its push lands: until then the state
      // is saved with the last good round's time, so a push outage is downtime.
      was = { alive: st.alive, downtime: [...st.downtime] };
      beat(st, clock());
      cv = clockVerdict(cfg, synced0.date, synced0.fetchedAt, test);
      if (cv.synced !== true) cv = { ...cv, synced: false };
      noteClock(st, cv);
      // The measured offset against GitHub's Date header, every round that has one.
      if (synced0.date) { const r = dateHeaderReading(synced0.date, synced0.fetchedAt); log(`clock: offset against GitHub's Date header ${r.detail ?? r.state}`); }
      if (test) log(`clock: the smoke test's clock switch is on (${test.kind === "step" ? `step ${test.ms / 1000} s` : test.kind})`);
      items = pending(cfg);
      if (items.length || st.waiting.length) book = logbook(cfg);
      // A take that has its final outcome in the log already (a /data restored from
      // a backup) isn't waiting any more.
      st.waiting = st.waiting.filter((w) => (book.get(w.req.id)?.state ?? "waiting") === "waiting");
      const seen = new Set(book.keys());
      const t = tree(cfg);
      let commits = 0;
      // One commit, when there is something to commit.
      const commit = (msg: string): string | undefined => {
        git(cfg, ["add", "-A"]);
        try { git(cfg, ["diff", "--cached", "--quiet"]); return undefined; } catch { /* staged changes */ }
        git(cfg, ["commit", "--quiet", "-m", msg]);
        commits++;
        return git(cfg, ["rev-parse", "--short", "HEAD"]);
      };
      const undo = () => { git(cfg, ["checkout", "--quiet", "--", "."]); git(cfg, ["clean", "-qfd", "--", "areas", "state", "archive", "rules", "projects", "reviews"]); };
      const S = st;
      // The ledger's generation never comes down: each write is one above both the file's and
      // the keeper's own count.
      const generation = () => Math.max(S.generation ?? 0, generationOf(t.read(CHECKS_PATH)));
      const ctx = (at: Date) => ({ at, holds: S.holds, downtime: S.downtime, tz: cfg.tz, maxCheckDays: maxCheckDays(cfg.maxCheckDays),
        clockSynced: cv!.synced, ...(cv!.source ? { clockSource: cv!.source } : { clockWhy: cv!.diagnostic }), generation: generation() });
      const outcomeOf = (req: Request, at: Date) => ({ id: req.id, from: clean(req.from, 80), kind: req.kind, summary: clean(req.summary, 200), at: at.toISOString() });
      // A planned change: its files, then its holds. A failed write, the holds' included,
      // undoes this request only; the others stand.
      const apply = (p: Extract<Plan, { state: "ok" }>, base: Omit<Outcome, "state">): Outcome => {
        if ([...p.writes.keys()].some((path) => !linkFree(cfg, path))) return { ...base, state: "rejected", reason: "writes through a link" };
        try {
          for (const [path, content] of p.writes) {
            const f = join(cfg.dir, path);
            if (content === null) rmSync(f, { force: true });
            else writeWhole(f, content);
          }
          if (p.holdsChanged) publish(cfg, p.holds);
        } catch (e) {
          undo();
          return { ...base, state: "rejected", reason: clean(`couldn't write: ${(e as Error).message}`) };
        }
        if (p.holdsChanged) S.holds = p.holds;
        return { ...base, state: "done" };
      };
      // The keeper's own files written alongside a refusal (the ledger's pending rewrite).
      const side = (writes: Map<string, string | null>) => {
        if ([...writes.keys()].some((path) => !linkFree(cfg, path))) return;
        try { for (const [path, content] of writes) if (content !== null) writeWhole(join(cfg.dir, path), content); }
        catch (e) { undo(); log(`couldn't write the ledger with a refusal: ${(e as Error).message}`); }
      };
      const decide = (req: Request, local: boolean, base: Omit<Outcome, "state">): Outcome => {
        const p = plan(req, t, ctx(new Date(base.at)));
        if (p.state === "ok") {
          for (const w of p.warnings ?? []) log(`warning: ${req.id}: ${clean(w, 200)}`);
          const o = apply(p, base);
          if (o.state === "done" && p.declared) { log(`one-off ${req.id} re-declared: ${clean(p.declared, 300)}`); o.declared = p.declared; }
          return o.state === "done" && p.errors?.length ? { ...o, reason: clean(p.errors.join("; "), 600) } : o;
        }
        if (p.state === "waiting") S.waiting.push({ req, since: base.at, local });
        if (p.writes) side(p.writes);
        // Refusals of source checks and one-offs, in the keeper's log too, for tuning the rules.
        if (req.ops?.some((o) => o.op === "check" || o.op === "one-off")) log(`refused for tuning: ${req.id}: ${clean(p.reason, 400)}`);
        return { ...base, state: p.state, reason: clean(p.reason, 600) };
      };
      const owed: Owed[] = [];
      // Takes waiting behind one of Cain's jobs, planned again now; in the order they came.
      const settle = () => {
        for (let i = 0; i < S.waiting.length;) {
          const w = S.waiting[i], at = clock();
          // A take's id is its request id: one whose final outcome is in the log already (it
          // landed before a reset, or a rerun after one) is never applied again.
          const prior = book.get(w.req.id);
          if (prior && prior.state !== "waiting") { S.waiting.splice(i, 1); log(`take ${w.req.id} already ${prior.state} in the log; not applied again`); continue; }
          const p = plan(w.req, t, ctx(at));
          const waited = idleMs({ renewed: w.since } as any, at, S.downtime);
          if (p.state === "waiting" && waited <= HOLD_IDLE_MS) { i++; continue; }
          S.waiting.splice(i, 1);
          // Kept until the push carrying it lands: a reset runs it again.
          (S.settled ??= []).push(w);
          const base = outcomeOf(w.req, at);
          const o: Outcome = p.state === "ok" ? apply(p, base)
            : p.state === "waiting" ? { ...base, state: "refused", reason: clean(`waited a day: ${p.reason}`) }
            : { ...base, state: p.state, reason: clean(p.reason) };
          logOutcome(cfg, o);
          o.commit = commit(message(o) + (o.state === "done" ? trailer(w.req.tap, w.req.id) : ""));
          owed.push(owe(o, w.local, w.req, false));
        }
      };
      // The keeper's own copy of the holds into the record. If that can't be written
      // the round goes on: the next round tries again.
      const republish = (msg: string) => {
        try { publish(cfg, S.holds); commit(msg); }
        catch (e) { undo(); log(`couldn't publish the holds (${(e as Error).message}); trying again next round`); }
      };

      // Holds that went a day without a word from their holder end.
      const now = clock();
      const ended = Object.keys(S.holds).filter((k) => expired(S.holds[k], now, S.downtime));
      if (ended.length) {
        const who = ended.map((k) => `${k} (${S.holds[k].holder})`).join(", ");
        for (const k of ended) delete S.holds[k];
        republish(`Holds: ${who} ended after a day without a word from the holder`);
      }
      if (S.waiting.length) settle();
      // The ledger kept in step: rows changed outside the keeper get a new version, checks
      // past their stale_after are aged out (only while the clock is synchronized), and checks
      // dated later than the clock now reads (it stepped back) never count again.
      try {
        const u = upkeep(t, { at: now, tz: cfg.tz, maxCheckDays: maxCheckDays(cfg.maxCheckDays), clockSynced: cv.synced, generation: generation() });
        if (u && [...u.writes.keys()].every((path) => linkFree(cfg, path))) {
          for (const [path, content] of u.writes) writeWhole(join(cfg.dir, path), content);
          const what = [...(u.bumped.length ? [`${u.bumped.join(", ")} changed outside the keeper`] : []), ...(u.aged.length ? [`${u.aged.join(", ")} aged out`] : []),
            ...(u.stepped.length ? [`${u.stepped.join(", ")} dated after the clock stepped back`] : [])];
          if (u.stepped.length) log(`the clock reads earlier than the source checks on ${u.stepped.join(", ")}: they no longer count`);
          commit(`Source checks: ${what.join("; ")}`);
        }
      } catch (e) { undo(); log(`couldn't keep the ledger in step (${(e as Error).message}); trying again next round`); }
      // A new reset epoch: every check the ledger holds was accepted before it, so each is dropped
      // (its Checked cell says pending re-check) until it is taken again.
      if (S.epoch && !S.epoch.voided) {
        try {
          const raw = t.read(CHECKS_PATH), list = t.read(PENDING_PATH);
          if (raw === null) S.epoch.voided = true;
          else if (linkFree(cfg, CHECKS_PATH) && linkFree(cfg, PENDING_PATH)) {
            const v = voidChecks(parseChecks(raw), S.epoch.at);
            if (v.dropped.length) {
              writeWhole(join(cfg.dir, CHECKS_PATH), checksText(v.ledger, Math.max(S.generation ?? 0, generationOf(raw)) + 1));
              if (list !== null) { const shown = projectChecked(list, v.ledger, cfg.tz, maxCheckDays(cfg.maxCheckDays)); if (shown !== list) writeWhole(join(cfg.dir, PENDING_PATH), shown); }
              commit(`Source checks: ${v.dropped.join(", ")} dropped by reset epoch ${S.epoch.n}, pending re-check`);
              log(`reset epoch ${S.epoch.n}: source checks on ${v.dropped.join(", ")} were accepted before it and are void until taken again`);
            }
            // The re-check queue, to Cain: items whose card was up or held first (the link takes
            // those cards' buttons off), then the others whose check was dropped.
            const carded = linkCardItems(cfg);
            const queue = [...carded, ...v.dropped.filter((x) => !carded.includes(x))];
            if (queue.length)
              relay(cfg, `Re-check queue after the record's reset (epoch ${S.epoch.n}): ${queue.map((x) => carded.includes(x) ? `${x} (a card of yours was up or held)` : x).join(", ")}. Every source check from before the reset no longer counts: check each at its source, in this order, and ask again with --checked if it still needs Dane. Asks are taken again once the record's next push lands.`);
            S.epoch.voided = true;
          }
        } catch (e) { undo(); log(`couldn't drop the checks from before the reset (${(e as Error).message}); trying again next round`); }
      }
      // The ledger's generation never comes down, even after a reset or a re-clone put an older
      // ledger in the copy: it is written again above the keeper's count.
      try {
        const raw = t.read(CHECKS_PATH);
        if (raw !== null && generationOf(raw) < (S.generation ?? 0) && linkFree(cfg, CHECKS_PATH)) {
          writeWhole(join(cfg.dir, CHECKS_PATH), checksText(parseChecks(raw), (S.generation ?? 0) + 1));
          commit(`Source checks: generation ${(S.generation ?? 0) + 1}, above the ${generationOf(raw)} the copy came back with`);
        }
      } catch (e) { undo(); log(`couldn't raise the ledger's generation (${(e as Error).message}); trying again next round`); }
      // The record's copy is the keeper's: put back if anyone else changed it.
      const published = publishedHolds(cfg);
      if (published === null ? Object.keys(S.holds).length > 0 : published !== holdsText(S.holds))
        republish(`Holds: ${HOLDS_PATH} put back to the keeper's copy`);

      // Consumed tap keys older than TAP_KEEP_MS go (round 9).
      // Round 10: the link's issued tap keys, read once for the round, and never a key whose landing is unresolved.
      let linkTaps = readLinkTaps(cfg);
      { const pruned = pruneTaps(S.taps, clock().getTime(), linkTaps?.unresolved); if (pruned) log(`pruned ${pruned} consumed tap key(s) older than ${TAP_KEEP_MS / 86_400_000} days`); }
      let tapWhy: string | null = null;
      // Round 11: consumed keys from the append-only log (never pruned). Round 12: a torn final record
      // truncated and told; the link's issued-key log mirrored into the keeper's own; a restore of the
      // link's state told by a run number logged twice with another nonce (or, with no run records, its
      // run going down, or the same run with another nonce); and at the keeper's start, after its state
      // or copy was lost, and after a detected restore, the consumed set rebuilt from the record remote's
      // history (Tap-Key trailers), each key not in the log appended to it.
      const nowIso = clock().toISOString();
      for (const [what, f] of [["consumed tap keys", tapsLogFile(cfg)], ["issued tap keys (the keeper's mirror)", issuedMirrorFile(cfg)]] as const) {
        try {
          const r = readLog(f);
          if (r.torn) { log(`TORN: a torn final record (${r.tornBytes} bytes) in the log of ${what} was truncated; the records before it stand`); relay(cfg, `The record keeper found a torn final record in its log of ${what} (a write cut short, as by a power cut) and truncated it; every record before it stands. Nothing to tell him.`); }
        } catch (e) { log(`couldn't read the log of ${what}: ${(e as Error).message}`); }
      }
      try { const n = mirrorIssued(cfg); if (n) log(`mirrored ${n} issued tap key(s) from the link's issued-key log`); }
      catch (e) { log(`couldn't mirror the link's issued-key log: ${(e as Error).message}`); }
      let reg = readIssued(cfg, clock().getTime());
      let restored = false;
      if (linkTaps && linkTaps.run !== null) {
        const nonce = linkTaps.nonce ?? "";
        const twice = reg.runs.find((x) => x.run === linkTaps.run && x.nonce !== nonce);
        const seen = S.linkSeen;
        const fresh = !seen || seen.run !== linkTaps.run || seen.nonce !== nonce;
        let why: string | null = null;
        if (twice && !reg.runs.some((x) => x.run === linkTaps.run && x.nonce === nonce)) why = `its run ${linkTaps.run} is in the issued-key log already, with another nonce`;
        else if (!reg.runs.length && seen && (linkTaps.run < seen.run || (linkTaps.run === seen.run && nonce !== seen.nonce)))
          why = `its run went from ${seen.run} to ${linkTaps.run}${linkTaps.run === seen.run ? " with a new nonce" : ""}`;
        if (why && fresh) {
          S.linkRestore = { at: nowIso, why };
          restored = true;
          log(`the link's state was restored from an older copy (${why}): tap requests whose keys it no longer lists are lost, and told`);
        }
        S.linkSeen = { run: linkTaps.run, nonce };
      }
      // Round 13: after a detected restore (S.rebuild) the rebuild counts only against a fresh fetch of the
      // record remote; until then the consumed set is unverified and tap-derived requests are held. A plain
      // restart rebuilds best effort from the local copy as before.
      // Round 14: every start of the keeper treats its consumed set as unverified until a fresh fetch has
      // merged the record remote's trailers: tap-derived requests are held meanwhile, as after a restore.
      if (!rebuilt.has(cfg.dir) && !S.rebuild) S.rebuild = { since: nowIso, why: KEEPER_START_WHY, tries: 0 };
      if (S.rebuild || restored || synced0.reset || synced0.cloned || !rebuilt.has(cfg.dir)) {
        if (S.rebuild && !synced0.fetched) {
          const tries = S.rebuild.tries + 1;
          const due = !S.rebuild.next || Date.parse(S.rebuild.next) <= clock().getTime();
          S.rebuild = { ...S.rebuild, tries, ...(due ? { next: new Date(clock().getTime() + Math.min(30, 2 ** Math.min(tries - 1, 5)) * 60_000).toISOString() } : {}) };
          if (due) log(`rebuild waits: GitHub didn't answer (try ${tries}); tap-derived requests stay held, and it tries again each round GitHub answers`);
        } else try {
          const have = readConsumed(cfg);
          const cards = [...(S.historyCards ?? [])], once = new Set<string>(), lines = new Set<string>(S.historyLines ?? []);
          let n = 0;
          // Round 14: the union of the local copy's trailers on every ref (unpushed commits included), the
          // remote's (just fetched) and the link's landing ledger (a started landing consumes its key).
          for (const [k, id] of historyTaps(cfg, { cards, once, lines })) if (!have.has(k)) { appendConsumed(cfg, k, id, nowIso); have.set(k, id); n++; }
          for (const k of ledgerStarted(cfg)) if (!have.has(k)) { appendConsumed(cfg, k, LEDGER_CONSUMER, nowIso); have.set(k, LEDGER_CONSUMER); n++; }
          S.historyCards = cards.slice(-1000);
          S.historyLines = [...lines].slice(-200);
          // The one Ship tap an install-taps once let through, as the remote's Install-Once trailers have it.
          const used = new Set(installState(installLogFile(cfg)).onceUsed);
          for (const k of once) if (!used.has(k)) appendLog(installLogFile(cfg), { t: "once-used", kid: k, by: "keeper", why: "rebuilt from the record's history", at: nowIso });
          rebuilt.add(cfg.dir);
          log(`rebuilt the consumed tap keys from the record's history${n ? `: ${n} key(s) not in the log added` : ": nothing missing"}`);
          if (S.rebuild) {
            const was = S.rebuild;
            delete S.rebuild;
            S.logHigh = logCounts(cfg);
            log(`REBUILD COMPLETE: the consumed set is verified against the record remote (${n} key(s) added, after ${was.tries} wait(s)); held tap-derived requests are decided now`);
            if (was.tries || was.told?.length || n || (was.why !== "the keeper's state was missing (a first start, or a wiped or restored image)" && was.why !== KEEPER_START_WHY))
              relay(cfg, `The record keeper's rebuild is complete: its consumed tap keys are verified against the record's history on GitHub (${n} added), so requests that carry a tap key are decided again, the held ones first. Nothing to tell him.`);
          }
        } catch (e) {
          log(`couldn't rebuild the consumed tap keys from the record's history: ${(e as Error).message}`);
          if (S.rebuild) S.rebuild = { ...S.rebuild, tries: S.rebuild.tries + 1 };
        }
      }
      const consumed = readConsumed(cfg);
      delete S.issuedSeen;
      S.tapNotices = (S.tapNotices ?? []).filter((n) => clock().getTime() - Date.parse(n.at) <= TAP_KEEP_MS + 86_400_000);
      const notice = (n: Omit<TapNotice, "at">) => { if (!S.tapNotices!.some((x) => x.tap === n.tap && x.why === n.why)) S.tapNotices!.push({ ...n, at: nowIso }); };
      for (const it of items) {
        const at = clock();
        const id = it.req?.id ?? `unreadable-${it.name}`;
        // Cain's request already applied (in a round whose push hasn't landed yet, or whose
        // reply was lost, or before a restart): never apply twice.
        if (it.local && it.req && seen.has(id) && !it.error) { outcomes.push(null); continue; }
        const base = { id, from: clean(it.req?.from ?? "unknown", 80), kind: it.req?.kind ?? "unknown",
          summary: clean(it.req?.summary ?? "(unreadable request)", 200), at: at.toISOString() };
        cfg.onItem?.(id);
        const tapK = it.req && !it.error && typeof it.req.tap === "string" && TAP_KEY.test(it.req.tap) ? it.req.tap : null;
        // Round 13: while the consumed set is unverified (a detected restore not yet rebuilt), a request that
        // carries a tap key is held, untouched in its queue, with one pending line to Cain; it is decided once
        // the rebuild completes.
        if (tapK && S.rebuild && !seen.has(id)) {
          held.add(it.name);
          outcomes.push(null);
          const told = S.rebuild.told ?? (S.rebuild.told = []);
          if (!told.includes(id)) {
            told.push(id);
            log(`held ${id} (tap key ${tapK}): the consumed set is unverified until its rebuild from the record's history completes`);
            if (it.local) relay(cfg, `Pending: your request ${id} carries tap key ${tapK}, and the record keeper can't verify yet that it wasn't already acted on (${S.rebuild.why}; the rebuild needs GitHub). It is held, not refused, and decided by itself once the rebuild completes. Send nothing again. Nothing to tell him.`);
          }
          continue;
        }
        // Round 13: a key that misses the mirror (or the link's state) is looked up again, synchronously, in
        // the link's issued-key log up to its current length (and the state re-read), before deciding: a
        // card posted within this round is known.
        if (tapK && (!reg.keys.has(tapK) || (linkTaps && !linkTaps.issued[tapK]))) {
          try { if (mirrorIssued(cfg)) reg = readIssued(cfg, clock().getTime()); } catch (e) { log(`couldn't read the link's issued-key log again: ${(e as Error).message}`); }
          linkTaps = readLinkTaps(cfg) ?? linkTaps;
        }
        let o: Outcome;
        if (it.error) o = { ...base, state: "rejected", reason: clean(it.error) };
        else if (seen.has(id)) o = { ...base, state: "rejected", reason: "an id that was already used" };
        else if (it.req!.tap && TAP_KEY.test(it.req!.tap) && (S.taps?.[it.req!.tap] ?? consumed.get(it.req!.tap)) !== undefined
          && (S.taps?.[it.req!.tap]?.id ?? consumed.get(it.req!.tap)) !== id
          // Round 14: a key the landing ledger consumed still takes its Ship take once: the landing's own write.
          && !(!S.taps?.[it.req!.tap] && consumed.get(it.req!.tap) === LEDGER_CONSUMER && tapDerived({ ops: it.req!.ops as any[] }).ship))
          o = { ...base, state: "rejected", reason: `tap key ${it.req!.tap} was already acted on by request ${S.taps?.[it.req!.tap]?.id ?? consumed.get(it.req!.tap)}; act on a tap key once` };
        else if (tapK && typeof reg.keys.get(tapK)?.exp === "number" && (heldTapTime(cfg, tapK) ?? linkTaps?.issued[tapK]?.at ?? clock().getTime()) > reg.keys.get(tapK)!.exp!) {
          // Round 14: the keeper enforces expiry: a key tapped after the expiry its issued record carries is
          // refused without being used up, whatever the card's buttons showed; judged by its tap time (a held
          // tap's, from the link's held-tap log), and he is told on the card that it expired.
          const r = reg.keys.get(tapK)!;
          o = { ...base, state: "rejected", reason: `tap key ${tapK} is from a card that had expired when he tapped it, so nothing was recorded from it and the key isn't used up: record nothing from it, and ask again with --checked if it still needs him` };
          notice({ tap: tapK, why: "expired", reason: o.reason!, ...(r.msg ? { msg: r.msg } : {}) });
          log(`tap key ${tapK} refused: tapped after its card's expiry`);
        }
        else if (tapK && reg.keys.get(tapK)?.voided) {
          // Round 13: a key of a card the link withdrew (its record never saved): told, never used up.
          o = { ...base, state: "rejected", reason: `tap key ${tapK} is from a card the link withdrew (its record couldn't be saved after its keys were logged), so no tap on it counts: record nothing from it, and ask again with --checked if it still needs him` };
        }
        else if (it.req!.tap && TAP_KEY.test(it.req!.tap) && linkTaps && !linkTaps.issued[it.req!.tap] && reg.keys.has(it.req!.tap)) {
          // Round 11: a key the keeper saw issued that the link's state no longer lists: lost, told to him
          // (on the card's thread, by the link) and to Cain (this line), never silently refused. Round 12:
          // issued means in the issued-key log (the link's or the keeper's mirror), for the key's whole life.
          const k = it.req!.tap, seen = reg.keys.get(k)!;
          o = { ...base, state: "rejected", reason: clean(`tap key ${k} was lost: the link's state was restored from an older copy${S.linkRestore ? ` (${S.linkRestore.why})` : ""} and no longer lists it, so nothing was recorded from it. He is told on the card; record nothing from that tap, and once ${seen.item === "NONE" ? "it" : `${seen.item}'s re-check`} is accepted ask again with --checked if it still needs him`) };
          notice({ tap: k, why: "lost", reason: o.reason!, ...(seen.msg ? { msg: seen.msg } : {}) });
          log(`tap key ${k} lost to a restore of the link's state: request ${id} told as lost`);
        }
        else if ((tapWhy = tapIssuedProblem(it.req!, Object.fromEntries(reg.keys)))) {
          // Round 12: a target mismatch doesn't use the key up: Cain sends the right write with the same
          // key, or routes any other write as an ordinary request ("tap": "none") with its check redone.
          const k = it.req!.tap!, r = reg.keys.get(k);
          o = { ...base, state: "rejected", reason: clean(r ? `${tapWhy}. The tap key isn't used up: send the write its card allows with the same tap key, or route any other write as an ordinary request with "tap": "none" and its source check redone` : tapWhy, 600) };
          // Round 11: a request whose target doesn't match its key's: he hears one line on the card.
          if (r) notice({ tap: k, why: "refused", reason: o.reason!, ...(r.msg ? { msg: r.msg } : {}) });
        }
        else if (it.req!.kind === "note") o = { ...base, state: "relayed" };
        else o = decide(it.req!, !!it.local, base);
        if (it.repoPath && existsSync(join(cfg.dir, it.repoPath))) rmSync(join(cfg.dir, it.repoPath), { force: true });
        logOutcome(cfg, o);
        seen.add(id);
        // Round 12: a tap-derived request that is done carries its key in a commit trailer.
        { const card = tapK ? reg.keys.get(tapK)?.msg : undefined;
          const once = !!tapK && o.state === "done" && installState(installLogFile(cfg)).onceUsed.includes(tapK);
          o.commit = commit(message(o) + (o.state === "done" ? trailer(it.req?.tap, id, card, once) : ""));
          if (o.state === "done" && card && /^\d{15,22}$/.test(card)) S.historyCards = [...(S.historyCards ?? []).filter((c) => c !== card), card].slice(-1000); }
        outcomes.push(o);
        owed.push(owe(o, !!it.local, it.req, !!it.error));
        if (o.state === "done" && it.req?.tap && TAP_KEY.test(it.req.tap)) {
          S.taps = { ...(S.taps ?? {}), [it.req.tap]: { id, at: at.toISOString() } };
          try { appendConsumed(cfg, it.req.tap, id, at.toISOString()); }
          catch (e) { log(`couldn't append consumed tap key ${it.req.tap} to its log (${(e as Error).message}); the state keeps it`); }
          const keys = Object.keys(S.taps);
          if (keys.length > TAPS_KEPT) for (const k of keys.slice(0, keys.length - TAPS_KEPT)) delete S.taps[k];
        }
        // A hold that ended or moved may let a waiting take through, before anything newer.
        if (o.state === "done" && S.waiting.length) settle();
      }
      // Round 14: each use of an owner line (install taps on <nonce> in the install log, recover logs <nonce>
      // accepted at the start check) goes into the record in its own commit with an Owner-Line trailer, so the
      // used lines are rebuilt from the history after any restore.
      { const uses: { kind: string; nonce: string; said: string; at: string }[] = [];
        try { for (const r of readLog<any>(installLogFile(cfg), { repair: false }).records)
          if (r?.t === "flag" && r.how === "on" && r.by === "owner" && typeof r.nonce === "string" && /^[a-z][0-9a-f]{5}$/.test(r.nonce)) uses.push({ kind: "install", nonce: r.nonce, said: String(r.said ?? ""), at: String(r.at ?? nowIso) }); }
        catch { /* none */ }
        for (const r of S.recoverLines ?? []) uses.push({ kind: "recover", nonce: r.nonce, said: r.said, at: nowIso });
        for (const u of uses) {
          if ((S.linesDone ?? []).includes(u.nonce)) continue;
          try {
            const f = join(cfg.dir, "log/owner-lines.md");
            mkdirSync(dirname(f), { recursive: true });
            if (!existsSync(f)) writeFileSync(f, "# Owner lines\n\nEach line the owner sent to allow what only he may (install taps on, recover logs), once each.\n\n");
            appendFileSync(f, `- ${u.at}: ${u.kind === "install" ? "install taps on" : "recover logs"}, code ${u.nonce}, his message ${clean(u.said, 30)}\n`);
            commit(`Owner line: ${u.kind === "install" ? "install taps on" : "recover logs"} used once\n\nOwner-Line: ${u.kind} ${u.nonce}`);
            S.linesDone = [...(S.linesDone ?? []), u.nonce].slice(-200);
            log(`owner line ${u.kind} ${u.nonce} recorded with its Owner-Line trailer`);
          } catch (e) { undo(); log(`couldn't record owner line ${u.kind} ${u.nonce} (${(e as Error).message}); trying again next round`); }
        }
        if (S.recoverLines?.length) S.recoverLines = S.recoverLines.filter((r) => !(S.linesDone ?? []).includes(r.nonce)); }
      // The one-off audit: the past week's one-offs matched loosely against the open rows, and
      // the link's wait and tap timeouts.
      if (items.length) audit(cfg, clock(), commit);
      // The link's own requests (a source check, a one-off) have their outcome now, once the
      // local commit and the ledger are written: the link waits on this, never on the push
      // below. round_ms is this round's local work, up to here. Cain's other requests still
      // hear done only once GitHub has them (deliver, after the push).
      const round_ms = Math.round(performance.now() - started);
      const waited = waitsBy(cfg);
      const linkOwn = (req?: Request) => !!req?.ops?.some((o) => o.op === "check" || o.op === "one-off");
      items.forEach((it, i) => { const o = outcomes[i]; if (o && it.local && linkOwn(it.req)) local(cfg, o, round_ms, waited); });
      S.generation = generation();
      S.owed = [...(S.owed ?? []), ...owed];
      // Round 12: the logs' high-water counts, kept in the state. Round 13: counted from the logs after
      // every append of the round returned (each append is fsynced first), so a count is never ahead of
      // its records; the state carrying it is written after.
      try { S.logHigh = logCounts(cfg); }
      catch (e) { log(`couldn't count the append-only logs: ${(e as Error).message}`); }
      if (commits === 0 && !ahead(cfg)) {
        // Nothing to push: a good round all the same, in step with GitHub as last fetched.
        // Cain's requests that were already applied are let go, with their status file if it
        // was never written.
        if (synced0.fetched) landed(cfg, S, clock());
        tally(S, clock());
        finish(cfg, S, items, outcomes, book);
        writeStatus(cfg, S, cv, clock());
        return { applied: items.length, ok: true };
      }
      // Saved before the push: the holds and the ledger's generation are the local commits'.
      writeAtomic(stateFile(cfg), unlanded(S));
      appliedNames = new Set(items.filter((it) => it.local && !held.has(it.name)).map((it) => it.name));
    } catch (e) {
      log(`stopped this round, nothing let go: ${redact(cfg, (e as Error).message)}`);
      if (st && cv) { tally(st, clock()); writeStatus(cfg, st, cv, clock()); }
      return { applied: 0, ok: false };
    }
    let why = "";
    try {
      cfg.beforePush?.();
      const blocked = blockFile(cfg);
      if (existsSync(blocked)) {
        log("the smoke test's push block is on: pushing to a wrong remote this round");
        git(cfg, ["push", "--quiet", join(cfg.dir, ".git", "no-such-remote.git"), `HEAD:${cfg.branch}`]);
      } else git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]);
    } catch (e) { why = (e as Error).message; }
    if (why) {
      // A lost race, or a push GitHub refused or never answered. Confirm before deciding.
      let answered = true;
      try { git(cfg, ["fetch", "--quiet", "origin", cfg.branch]); } catch { answered = false; }
      if (!answered || ahead(cfg)) {
        st!.unpushed = true;
        if (!st!.pushFailed) log(`push didn't land (${clean(why, 200)}); the local commits stay and their outcomes stand`);
        st!.pushFailed = { at: clock().toISOString(), why: clean(why, 200), since: st!.pushFailed?.since ?? clock().toISOString() };
        // GitHub answered (a lost race): rebase and try again now. Otherwise the next round.
        const retry = answered && !existsSync(blockFile(cfg)) && attempt < 2;
        if (!retry) { tally(st!, clock()); releaseBlock(cfg, clock()); }
        writeAtomic(stateFile(cfg), unlanded(st!));
        writeStatus(cfg, st!, cv!, clock());
        if (retry) continue;
        return { applied: items.length, ok: false, pushFailed: true };
      }
    }
    // GitHub has it: the holds and waiting takes are saved, the requests can go,
    // and Cain hears what needs him.
    landed(cfg, st!, clock());
    tally(st!, clock());
    finish(cfg, st!, items, outcomes, book);
    rmSync(`${stateFile(cfg)}.next`, { force: true });
    writeStatus(cfg, st!, cv!, clock());
    return { applied: items.length, ok: true };
  }
  log("gave up this round after three tries; the local commits stay, and the next round pushes them");
  return { applied: 0, ok: false, pushFailed: true };
}

// Local queue files already applied in a round whose push hasn't landed: they don't call for
// another round by themselves (the next minute's round pushes them).
let appliedNames = new Set<string>();
// Round 13: this round's held requests (by queue name), left in their queue.
let held = new Set<string>();
// Round 13: a rebuild mark made at the start check, carried into the round's state.
const startRebuild = new Map<string, { rebuild: NonNullable<State["rebuild"]>; logHigh: State["logHigh"] }>();

const blockFile = (cfg: Config) => cfg.blockPush ?? join(dirname(cfg.queue), "record-block-push");

// The push block, after a round it blocked: an empty file was for that one round; one holding a
// time stays until then (the smoke test's push failure kept going for a few minutes).
function releaseBlock(cfg: Config, now: Date) {
  const f = blockFile(cfg);
  if (!existsSync(f)) return;
  let until = NaN;
  try { until = Number(readFileSync(f, "utf8").trim() || NaN); } catch { /* removed below */ }
  if (!(Number.isFinite(until) && now.getTime() < until)) rmSync(f, { force: true });
}

// The highest ledger generation the link has posted on a card (or is about to: it writes the
// generation it intends before it posts), from its own state file, read only. why: the file is
// missing, can't be parsed (corrupt, or caught mid-write) or is too big, and floor is then 0.
export function readLinkFloor(cfg: Config): { floor: number; why?: string } {
  const f = cfg.linkState ?? join(dirname(cfg.queue), "link", "state.json");
  let text: string;
  try {
    if (!existsSync(f)) return { floor: 0, why: "missing" };
    if (lstatSync(f).size > 20_000_000) return { floor: 0, why: "too big" };
    text = readFileSync(f, "utf8");
  } catch (e) { return { floor: 0, why: `unreadable: ${clean((e as Error).message, 80)}` }; }
  let j: any;
  try { j = JSON.parse(text); } catch { return { floor: 0, why: text.trim() ? "corrupt or mid-write" : "empty" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { floor: 0, why: "corrupt" };
  let g = Number.isInteger(j.postedGen) ? j.postedGen : 0;
  if (Number.isInteger(j.intendedGen) && j.intendedGen > g) g = j.intendedGen;
  for (const m of Object.values<any>(j.messages ?? {})) if (Number.isInteger(m?.checked?.gen) && m.checked.gen > g) g = m.checked.gen;
  return { floor: g > 0 ? g : 0 };
}
export function linkFloor(cfg: Config): number { return readLinkFloor(cfg).floor; }

// Round 10: the tap keys the link issued (its state's issued) and the short forms of the tap keys whose
// landing it lists as unresolved (its state's unresolved, by full key: hashed here the way the link's
// tapKid does). null: the link's state can't be read.
export function readLinkTaps(cfg: Config): { issued: Record<string, IssuedTap & { at?: number }>; unresolved: Set<string>; run: number | null; nonce: string | null } | null {
  const f = cfg.linkState ?? join(dirname(cfg.queue), "link", "state.json");
  try {
    if (!existsSync(f) || lstatSync(f).size > 20_000_000) return null;
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const issued: Record<string, IssuedTap & { at?: number }> = {};
    for (const [k, v] of Object.entries<any>(j.issued ?? {}))
      if (TAP_KEY.test(k) && v && typeof v.item === "string" && typeof v.kind === "string")
        issued[k] = { item: v.item, kind: v.kind, ...(typeof v.at === "number" && Number.isFinite(v.at) ? { at: v.at } : {}), ...(typeof v.label === "string" ? { label: v.label } : {}), ...(typeof v.msg === "string" ? { msg: v.msg } : {}),
          ...(v.target && typeof v.target.item === "string" && Array.isArray(v.target.writes) ? { target: { item: v.target.item, writes: v.target.writes.filter((w: any) => typeof w === "string") } } : {}) };
    // Round 11: a tombstone keeps its consumed key too.
    const unresolved = new Set([...Object.keys(j.unresolved ?? {}), ...Object.keys(j.tombstones ?? {})].map((k) => `tap-${createHash("sha256").update(k).digest("hex").slice(0, 12)}`));
    return { issued, unresolved, run: Number.isInteger(j.run) ? j.run : null, nonce: typeof j.runNonce === "string" ? j.runNonce : null };
  } catch { return null; }
}

// The run of rounds that ended with local commits unpushed or the copy reset: since when, and
// how many (the link tells Dane once it passes 30 minutes or three rounds). Cleared once clean.
function tally(st: State, now: Date) {
  if (!st.unpushed && !st.reset) { delete st.outage; return; }
  const since = [st.pushFailed?.since, st.reset?.at, now.toISOString()].filter((x): x is string => !!x).sort()[0];
  st.outage = { since: st.outage?.since && st.outage.since < since ? st.outage.since : since, rounds: (st.outage?.rounds ?? 0) + 1 };
}
const statusFile = (cfg: Config) => cfg.status ?? join(dirname(cfg.queue), "record-ledger.json");

// A whole file, written so a reader sees the old one or the new one, never half of it.
function writeWhole(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// The push landed (or there was nothing to push and the copy is GitHub's): what was owed is
// delivered, and the copy is in step again.
function landed(cfg: Config, st: State, now: Date) {
  st.pushed = git(cfg, ["rev-parse", "HEAD"]);
  if (st.unpushed || st.pushFailed) log("push landed: GitHub has the keeper's local commits");
  // A reset whose epoch still waits on the link's state stands until the epoch is completed.
  if (st.reset && !st.epochWait) log("the copy is in step with GitHub again after its reset; asks and taps go on");
  delete st.unpushed; delete st.pushFailed; delete st.settled;
  if (!st.epochWait) delete st.reset;
  appliedNames = new Set();
  for (const w of st.owed ?? []) deliver(cfg, w);
  delete st.owed;
  void now;
}

// The copy was reset: its local commits are gone. Requests still queued run again; Cain hears
// about the others, which may not have reached GitHub. The link refuses asks and taps until the
// next push lands.
function resetCopy(cfg: Config, st: State, why: string, now: Date, lf: { floor: number; why?: string } = { floor: 0 }) {
  st.reset = { at: now.toISOString(), why: clean(why, 240) };
  st.lastReset = st.reset;
  log(`reset: ${why}; asks and taps are refused until the next push to GitHub lands`);
  // A new epoch, one generation above everything the link could have posted on: cards below it
  // were posted before the reset, and checks in the ledger now were accepted before it. While the
  // link's state can't be read, a card posted after its last good save could be above any
  // generation the keeper knows, so the epoch waits (said once) for a round that can read it.
  if (lf.why) {
    if (!st.epochWait) log(`reset epoch waits: the link's state can't be read (${lf.why}), so the epoch is completed on the first round that can read it; asks and taps stay refused until then`);
    st.epochWait = { at: now.toISOString(), why: clean(lf.why, 120) };
  } else completeEpoch(st, lf.floor, now);
  const queued = new Set<string>();
  for (const p of pending(cfg)) if (p.req) queued.add(p.req.id);
  // Takes settled in the lost commits wait again, ahead of the others, and are planned again
  // this round like any queued request.
  for (const w of st.settled ?? []) queued.add(w.req.id);
  if (st.settled?.length) {
    log(`reset: ${st.settled.map((w) => w.req.id).join(", ")} settled in a commit that was lost; planned again`);
    st.waiting = [...st.settled, ...st.waiting.filter((w) => !st.settled!.some((x) => x.req.id === w.req.id))];
    delete st.settled;
  }
  // Those still queued are applied again, and owed again then.
  const lost = (st.owed ?? []).filter((w) => !queued.has(w.o.id));
  st.owed = [];
  if (lost.length) relay(cfg, `The record keeper had to reset its copy of the record (${clean(why, 160)}). These changes may not have reached GitHub: ${lost.map((w) => w.o.id).join(", ")}. Check each in /data/record and send it again if it's missing.`);
  delete st.unpushed;
  writeAtomic(stateFile(cfg), JSON.stringify(st));
}

// A new reset epoch: one generation above the keeper's count and the link's floor (both read now),
// numbered after the last. Cards whose epoch isn't this one are refused; its ledger write (the
// next round) drops every check from before it.
function completeEpoch(st: State, floor: number, now: Date) {
  const g = Math.max(st.generation ?? 0, floor) + 1;
  st.generation = g;
  st.epoch = { n: (st.epoch?.n ?? 0) + 1, at: now.toISOString(), generation: g };
  if (st.epochWait) log(`reset epoch ${st.epoch.n}: completed now that the link's state can be read (generation ${g})`);
  delete st.epochWait;
}

// The open items with a card up or held on the link (its own state, read only), for the re-check
// queue after a reset: those come first.
export function linkCardItems(cfg: Config): string[] {
  const f = cfg.linkState ?? join(dirname(cfg.queue), "link", "state.json");
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const out = new Set<string>();
    for (const m of Object.values<any>(j?.messages ?? {}))
      if (m && (m.kind === "ask" || m.kind === "ship") && typeof m.item === "string" && m.item !== "none" && (m.buttons || m.why === "record reset")) out.add(m.item.toUpperCase());
    for (const h of Array.isArray(j?.held) ? j.held : []) if (typeof h?.item === "string" && h.item !== "none") out.add(h.item.toUpperCase());
    return [...out];
  } catch { return []; }
}

// The landing ledger (/data/record-landings) is the link's alone (link/landings.ts): the keeper never
// writes, reads or cleans it.

// The clock's verdict changed (synchronized or not, by which source, each source's state):
// one log line naming what each source returned, instead of a refusal per check.
function noteClock(st: State, v: Verdict) {
  const key = verdictKey(v);
  if (st.clockKey === key) return;
  st.clockKey = key;
  log(v.synced ? `clock: ${v.diagnostic}` : `clock: not synchronized, so no source check is taken: ${v.diagnostic}`);
}

// The keeper's status for the link (written whole, every round): the ledger's generation, whether
// local commits wait for a push (and the last push error), whether the copy was reset since the
// last push landed, and the clock's verdict with the source that satisfied it.
function writeStatus(cfg: Config, st: State, v: Verdict, now: Date) {
  try {
    writeAtomic(statusFile(cfg), JSON.stringify({
      at: now.toISOString(), generation: st.generation ?? 0, unpushed: st.unpushed === true,
      ...(st.pushFailed ? { push_failed: st.pushFailed } : {}), ...(st.reset ? { reset: st.reset } : {}),
      ...(st.lastReset ? { last_reset: st.lastReset } : {}), ...(st.outage ? { outage: st.outage } : {}),
      ...(st.epoch ? { epoch: { n: st.epoch.n, at: st.epoch.at, generation: st.epoch.generation, voided: st.epoch.voided === true } } : {}),
      ...(st.floorWhy ? { link_state: { readable: false, why: st.floorWhy } } : {}),
      ...(st.epochWait ? { epoch_wait: st.epochWait } : {}),
      ...(st.tapNotices?.length ? { tap_notices: st.tapNotices } : {}),
      ...(st.linkRestore ? { link_restore: st.linkRestore } : {}),
      ...(st.rebuild ? { consumed_unverified: { since: st.rebuild.since, why: st.rebuild.why, tries: st.rebuild.tries } } : {}),
      ...(st.historyCards?.length ? { history_cards: st.historyCards.slice(-500) } : {}),
      ...((st.linesDone?.length || st.historyLines?.length) ? { used_lines: [...new Set([...(st.linesDone ?? []), ...(st.historyLines ?? [])])].slice(-200) } : {}),
      recheck_pending: recheckPending(cfg),
      clock: { synced: v.synced, source: v.source, diagnostic: v.diagnostic, at: now.toISOString() },
    }) + "\n");
  } catch (e) { log(`couldn't write the status for the link: ${(e as Error).message}`); }
}

// Whether a request is in log/requests on the copy at dir with done as its last outcome (a check a tap
// rested on survived a reset); null when the log can't be read.
export function requestLoggedIn(dir: string, id: string): boolean | null {
  const d = join(dir, "log", "requests");
  try {
    if (!existsSync(d)) return false;
    let last: string | null = null;
    for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl")).sort())
      for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
        if (!line.includes(id)) continue;
        try { const o = JSON.parse(line); if (o?.id === id && typeof o.state === "string") last = o.state; } catch { /* skip */ }
      }
    return last === "done";
  } catch { return null; }
}

// How many rows of the ledger in the keeper's copy are pending re-check after a reset.
function recheckPending(cfg: Config): number {
  try { return Object.values(parseChecks(readFileSync(join(cfg.dir, CHECKS_PATH), "utf8"))).filter((e) => !!e.recheck).length; } catch { return 0; }
}

// The past week's one-off asks (from log/requests) against the open rows, loosely: hits go
// to the keeper's log and to state/one-off-audit.md, which Cain reads. Written only when it
// changes. A failure here never stops the round.
function audit(cfg: Config, now: Date, commit: (msg: string) => string | undefined) {
  try {
    const oneOffs: OneOff[] = [];
    for (const o of logbook(cfg).values())
      if (o.id.startsWith("link-oneoff-") && o.state === "done" && o.summary.startsWith(ONE_OFF_SUMMARY))
        oneOffs.push({ id: o.id, at: o.at, text: o.summary.slice(ONE_OFF_SUMMARY.length), ...(o.declared ? { declared: o.declared } : {}) });
    const waits: WaitTimeout[] = [...waitsBy(cfg).values()].map((w) => ({ ...w, round_ms: w.kind === "tap" ? null : roundOf(cfg, w.id) }));
    const p = join(cfg.dir, PENDING_PATH), f = join(cfg.dir, ONE_OFF_AUDIT_PATH);
    const pending = existsSync(p) ? readFileSync(p, "utf8") : null;
    const was = existsSync(f) ? readFileSync(f, "utf8") : null;
    if (!oneOffs.length && !waits.length && was === null) return;
    const a = oneOffAudit(oneOffs, pending, now, cfg.tz, waits);
    if (a.text === was) return;
    // Lines not in the file before reach Cain at his next check-in (checkin.sh reads them).
    const fresh = a.hits.filter((h) => !(was ?? "").includes(`- ${h}\n`));
    for (const h of fresh) log(`one-off audit: ${clean(h, 300)}`);
    if (fresh.length) appendFileSync(checkinFile(cfg), fresh.map((h) => clean(h, 400)).join("\n") + "\n");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, a.text);
    commit(`One-off audit: ${a.hits.length} to look over`);
  } catch (e) {
    log(`one-off audit didn't finish: ${(e as Error).message}`);
  }
}

const checkinFile = (cfg: Config) => cfg.checkin ?? join(dirname(cfg.queue), "record-checkin.txt");
const waitsFile = (cfg: Config) => cfg.waits ?? join(dirname(cfg.queue), "record-waits.jsonl");

// The link's wait timeouts (one JSON line each: id, at, waited_ms), by request id. The audit
// counts the past week's.
function waitsBy(cfg: Config): Map<string, Omit<WaitTimeout, "round_ms">> {
  const out = new Map<string, Omit<WaitTimeout, "round_ms">>();
  const f = waitsFile(cfg);
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    try {
      const w = JSON.parse(line);
      if (typeof w?.id === "string" && typeof w.at === "string" && !Number.isNaN(Date.parse(w.at)) && Number.isFinite(w.waited_ms))
        out.set(w.id, { id: clean(w.id, 80), at: w.at, waited_ms: Number(w.waited_ms), ...(w.kind === "tap" ? { kind: "tap" as const } : {}) });
    } catch { /* skip */ }
  }
  return out;
}
// The keeper's local time for a request's round, from its outcome file (null: none yet).
function roundOf(cfg: Config, id: string): number | null {
  try { const o = JSON.parse(readFileSync(outcomeFile(cfg, id), "utf8")); return Number.isFinite(o?.round_ms) ? o.round_ms : null; }
  catch { return null; }
}
// One of Cain's own requests, settled locally: its outcome file, before the push. A request
// the link gave up waiting on is logged with this round's time.
function local(cfg: Config, o: Outcome, round_ms: number, waited: Map<string, Omit<WaitTimeout, "round_ms">>) {
  o.round_ms = round_ms;
  mkdirSync(cfg.outcomes, { recursive: true });
  writeFileSync(outcomeFile(cfg, o.id), JSON.stringify(o));
  const w = waited.get(o.id);
  if (w) log(`wait timeout: ${o.id} was refused by the link after ${w.waited_ms} ms; its round's local work took ${round_ms} ms (${o.state})`);
}

// A round that finished: its state saved (so it counts as the keeper working), and
// Cain's queued requests let go. One that was applied in an earlier round that
// stopped before writing its status file gets that file from the log.
function finish(cfg: Config, st: State, items: Pending[], outcomes: (Outcome | null)[], book: Map<string, Outcome>) {
  writeAtomic(stateFile(cfg), JSON.stringify(st));
  mkdirSync(cfg.outcomes, { recursive: true });
  items.forEach((it, i) => {
    if (!it.local || held.has(it.name)) return;   // round 13: a held request stays in the queue
    rmSync(it.local, { force: true });
    const before = !outcomes[i] && it.req ? book.get(it.req.id) : undefined;
    if (before && !existsSync(outcomeFile(cfg, before.id))) writeFileSync(outcomeFile(cfg, before.id), JSON.stringify(before));
  });
}

// The smoke test's leak check (record.sh leak-check): while its flag file exists, the keeper, which
// alone holds the token, reads every file under /data/work (its log copy, the link's log copy, the
// link's rendered notices, the gate's reports, and the rest), its own state and status files, the
// link's state, the relay queue, its audit files and any files the flag lists (the refusal line Cain
// saved), and says per file whether the token, a web address's userinfo, or an Authorization header
// or Basic or Bearer credential is in it. Never the match itself: only yes or no. The result goes to
// <flag>.json and one log line; the flag is removed.
export function leakCheck(cfg: Config): { clean: boolean; files: { path: string; token: boolean; userinfo: boolean; header: boolean }[] } | null {
  const flag = cfg.leakCheck ?? join(dirname(cfg.queue), "record-leak-check");
  if (!existsSync(flag)) return null;
  let extra: string[] = [];
  try { extra = readFileSync(flag, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")); } catch { /* none */ }
  rmSync(flag, { force: true });
  const work = cfg.workDir ?? (cfg.logFile ? dirname(cfg.logFile) : undefined);
  const under: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6 || under.length > 2_000) return;
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const f = join(d, n);
      try { const l = lstatSync(f); if (l.isDirectory()) walk(f, depth + 1); else if (l.isFile()) under.push(f); } catch { /* gone */ }
    }
  };
  if (work) walk(work, 0);
  const linkState = cfg.linkState ?? join(dirname(cfg.queue), "link", "state.json");
  const all = [...under, cfg.logFile, `${cfg.logFile ?? ""}.1`, stateFile(cfg), statusFile(cfg), linkState, cfg.relay, waitsFile(cfg), checkinFile(cfg), ...extra];
  const paths = [...new Set(all.filter((p): p is string => !!p && p !== ".1"))].filter((p) => { try { return existsSync(p) && lstatSync(p).isFile(); } catch { return false; } });
  const files = paths.map((path) => {
    let t = "";
    try { const b = readFileSync(path); t = b.subarray(Math.max(0, b.length - 5_000_000)).toString("utf8"); } catch { /* unreadable: nothing found */ }
    return { path, ...leakForms(t, cfg.token) };
  });
  const clean = files.every((f) => !f.token && !f.userinfo && !f.header);
  const out = { at: new Date().toISOString(), clean, files };
  try { writeAtomic(`${flag}.json`, JSON.stringify(out) + "\n"); } catch { /* the log line says it */ }
  log(clean ? `leak check: clean (${files.length} files, no token, no userinfo, no Authorization or Basic form)`
    : `leak check: FOUND in ${files.filter((f) => f.token || f.userinfo || f.header).map((f) => `${f.path} (${[f.token && "token", f.userinfo && "userinfo", f.header && "header"].filter(Boolean).join(", ")})`).join(", ")}`);
  return { clean, files };
}

// Once a day: the deterministic check, written to state/record-check.md.
export function nightly(cfg: Config): boolean {
  try {
    // Local commits waiting for a push are the rounds' to push (and to rebase, or reset with
    // the link told): the check waits for them.
    if (existsSync(join(cfg.dir, ".git")) && ahead(cfg)) { log("nightly check waits: local commits are waiting for a push"); return false; }
    const synced = sync(cfg);
    if (synced.reset || !synced.fetched) { log("nightly check waits: the copy isn't in step with GitHub"); return false; }
    const files = new Map<string, string>();
    const exists = new Set<string>();
    const walk = (rel: string, collect: boolean) => {
      const abs = rel ? join(cfg.dir, rel) : cfg.dir;
      for (const n of readdirSync(abs)) {
        if (n === ".git") continue;
        const r = rel ? `${rel}/${n}` : n;
        const st = lstatSync(join(abs, n));
        if (st.isSymbolicLink()) continue;
        exists.add(r);
        if (st.isDirectory()) walk(r, collect || ["areas", "archive", "rules", "state"].includes(r));
        else if (collect && n.endsWith(".md") && st.size <= MAX_RAW) files.set(r, readFileSync(join(abs, n), "utf8"));
      }
    };
    walk("", false);
    const findings = hygiene(files, exists);
    const day = (cfg.now?.() ?? new Date()).toLocaleDateString("en-CA", { timeZone: cfg.tz });
    const report = hygieneReport(findings, day);
    const p = join(cfg.dir, "state", "record-check.md");
    const strip = (s: string) => s.replace(/^\d{4}-\d\d-\d\d: /m, "");
    if (existsSync(p) && strip(readFileSync(p, "utf8")) === strip(report)) return true;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, report);
    git(cfg, ["add", "state/record-check.md"]);
    git(cfg, ["commit", "--quiet", "-m", `Nightly record check: ${findings.length} to look at`]);
    git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]);
    if (findings.length) relay(cfg, `Nightly record check found ${findings.length} thing(s) to fix; they're in state/record-check.md. Fix what you can, record what you did, and bring Dane only what is his to decide.`);
    log(`nightly check: ${findings.length} finding(s)`);
    return true;
  } catch (e) {
    log(`nightly check didn't finish: ${(e as Error).message}`);
    return false;
  }
}

// The keeper's loop. Cain's own queue is looked at every 2 seconds and a round runs
// as soon as it has something; GitHub's inbox gets a round every minute regardless.
// A round that fails waits for the next minute, so an outage isn't retried every
// 2 seconds.
export async function keep(cfg: Config, o: {
  pollMs?: number; fullMs?: number; stop?: () => boolean; nightly?: boolean;
  clock?: () => number; sleep?: (ms: number) => Promise<unknown>; run?: (cfg: Config) => { ok: boolean };
} = {}) {
  const pollMs = o.pollMs ?? 2_000, fullMs = o.fullMs ?? 60_000;
  const clock = o.clock ?? Date.now, sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms)), run = o.run ?? cycle;
  let due = 0, paused = false, lastNight = "", lastTry = -Infinity;
  while (!o.stop?.()) {
    if (clock() >= due || (!paused && queued(cfg))) {
      let ok = false, local = false;
      try { const r = run(cfg); ok = r.ok; local = (r as any).pushFailed === true; } catch (e) { log(`cycle error: ${redact(cfg, String(e))}`); }
      due = clock() + fullMs;
      // A round whose local work was done but whose push failed doesn't pause Cain's queue: new
      // requests still get their local outcome at once (and each tries the push again).
      paused = !ok && !local;
    }
    try { leakCheck(cfg); } catch (e) { log(`leak check didn't finish: ${(e as Error).message}`); }
    if (o.nightly !== false) {
      const now = new Date();
      const hm = now.toLocaleTimeString("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit" }).replace(":", "");
      const day = now.toLocaleDateString("en-CA", { timeZone: cfg.tz });
      // At most one try an hour if it fails, so a broken check doesn't spam.
      if (hm >= cfg.hygieneAt && lastNight !== day && Date.now() - lastTry > 3_600_000) {
        lastTry = Date.now();
        if (nightly(cfg)) lastNight = day;
      }
    }
    await sleep(pollMs);
  }
}

if (import.meta.main) {
  const cfg: Config = {
    remote: process.env.RECORD_REMOTE ?? "https://github.com/HyndeSyte/org.git",
    dir: process.env.RECORD_DIR ?? "/data/record",
    queue: process.env.RECORD_QUEUE ?? "/data/record-queue",
    outcomes: process.env.RECORD_OUTCOMES ?? "/data/record-outcomes",
    relay: process.env.RELAY_QUEUE ?? "/data/relay.queue",
    branch: process.env.RECORD_BRANCH ?? "main",
    token: process.env.RECORD_TOKEN || undefined,
    hygieneAt: process.env.RECORD_CHECK_AT ?? "0230",
    tz: process.env.CHECKIN_TZ ?? "America/New_York",
    holds: process.env.RECORD_HOLDS ?? "/data/record-holds.json",
    maxCheckDays: maxCheckDays(process.env.SOURCE_CHECK_MAX_DAYS),
    checkin: process.env.RECORD_CHECKIN ?? "/data/record-checkin.txt",
    waits: process.env.RECORD_WAITS ?? "/data/record-waits.jsonl",
    status: process.env.RECORD_STATUS ?? "/data/record-ledger.json",
    blockPush: process.env.RECORD_BLOCK_PUSH ?? "/data/record-block-push",
    clockTest: process.env.RECORD_CLOCK_TEST ?? "/data/record-clock-test",
    forceConflict: process.env.RECORD_FORCE_CONFLICT ?? "/data/record-force-conflict",
    linkState: process.env.LINK_STATE ?? "/data/link/state.json",
    leakCheck: process.env.RECORD_LEAK_CHECK ?? "/data/record-leak-check",
    logFile: process.env.RECORD_LOG ?? "/data/work/record-keeper.log",
    tapsLog: process.env.RECORD_TAPS_LOG ?? "/data/record-taps.jsonl",
    linkIssued: process.env.LINK_ISSUED_LOG ?? "/data/link-issued.log",
    issuedLog: process.env.RECORD_ISSUED_LOG ?? "/data/record-issued.log",
    installLog: process.env.RECORD_INSTALL_LOG ?? "/data/record-install.log",
    recover: process.env.RECORD_RECOVER ?? "/data/record-recover.json",
  };
  delete process.env.RECORD_TOKEN;   // kept only in cfg, handed to git per call
  teeConsole(cfg.logFile);
  if (!cfg.token) {
    log("no GitHub token in the add-on's options yet; the record keeper is waiting");
    while (true) await Bun.sleep(3_600_000);
  }
  // Round 13: the start check is each round's (cycle): a log missing or shorter than its high-water count
  // starts the keeper degraded; only a case no rule explains refuses, round by round, until the owner's
  // recover-logs line, so the keeper never has to be restarted by hand.
  log("keeping the record");
  await keep(cfg, { fullMs: Number(process.env.RECORD_INTERVAL_S ?? 60) * 1000, pollMs: Number(process.env.RECORD_POLL_MS ?? 2000) });
}
