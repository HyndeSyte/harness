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
import { createHmac } from "node:crypto";
import { reuseOk, REUSE_SHAPE, unapprovedValues, normalUrl, reportValues, resultLines, ID, isReadOnly, jobFromAsk, jobText, listLine, newId, parseHeartbeat, parseJob, parseResult, resultText, stateAfter,
  DEFAULT_REPO, QUEUE_ATTRIBUTES, SKEW_MS, TERMINAL, type Heartbeat, type Job, type OwnerReuse, type Result } from "./core.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; branch: string;
  token?: string; pub: string; now?: () => Date; rand?: () => number;
  link?: string;                 // Cain's link, for owner_reuse proofs (default http://127.0.0.1:8097)
  discordEnv?: string;           // the bot token's file, for the link's key (the token itself is never kept or printed)
  verifyReuse?: ReuseCheck;      // the tests' stand-in for the link
  used?: string;                 // the append-only file of the owner-reuse taps already spent (default /data/pc-jobs-reuse-used.jsonl)
  afterPush?: () => void;        // the tests' stand-in for the keeper being killed between the push and the finalise
  pushWaitMs?: number;           // the wait between push tries (default PUSH_WAIT_MS; the tests' shorter)
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
// afresh or a crash at any point doesn't free a tap for a second job (0.12.0, seventeenth round):
//   1. before the job is pushed, the tap goes in as pending, with its job id, its request id and
//      the keeper's commit that carries the job; a tap that can't be written so stops the round:
//      nothing is pushed;
//   2. the job is pushed, tried up to PUSH_TRIES times with short waits (PUSH_WAIT_MS);
//   3. the tap is finalised (final).
// A pending tap counts as spent. At the start of each round, once the queue copy is brought up
// to date from GitHub (sync, whose every error stops the round), every pending tap is settled
// against the queue as that fetch gave it (0.12.0, eighteenth round). It rolls back only on
// positive evidence that its push never reached GitHub, all of:
//   - the queue's branch was fetched whole this round (sync), and the keeper's push commit
//     named in the tap is not in that branch's history;
//   - nothing in the queue names the job id or the request id: no job file, no report, no
//     worker record, nothing else in the copy.
// Then the request, still waiting, is checked afresh. Anything else keeps the tap spent: the
// commit in the branch, or the job or request named anywhere in the queue (the worker took the
// job, or moved it into a report), finalises it (and its request, if still waiting, gets its
// "queued" outcome); a sync that failed, a branch that wasn't there to fetch, a git answer that
// says neither yes nor no, or a pending line without its commit stops the round and leaves the
// tap pending. The keeper deletes no job file, so no keep-list can drop one whose tap isn't final.
// A line without a state (written before 0.12.0's seventeenth round) is final.
// The file's folder is flushed to disk (fsync) too whenever the file or a folder above it is
// made, so the file's own entry survives a power cut; the file is only appended to, never
// renamed or rewritten. A folder that can't be flushed throws (the round stops before the push),
// except on Windows, where a folder can't be opened to flush (the Pi runs Linux).
export const USED_REUSE = "/data/pc-jobs-reuse-used.jsonl";
export const PUSH_TRIES = 3;
export const PUSH_WAIT_MS = 2_000;
export type ReuseState = "pending" | "final" | "rolled_back";
export interface ReuseLine { m: string; job: string; state: ReuseState; rid?: string; commit?: string }
const COMMIT = /^[0-9a-f]{40}$/;
// Every tap's latest line, by message id.
export function reuseLedger(cfg: Pick<Config, "used">): Map<string, ReuseLine> {
  const out = new Map<string, ReuseLine>();
  let text = "";
  try { text = readFileSync(cfg.used ?? USED_REUSE, "utf8"); } catch { return out; }
  for (const l of text.split("\n")) {
    try {
      const o = JSON.parse(l);
      if (typeof o?.m !== "string" || typeof o?.job !== "string") continue;
      const state: ReuseState = o.state === undefined ? "final" : o.state;
      if (!["pending", "final", "rolled_back"].includes(state)) continue;
      out.set(o.m, { m: o.m, job: o.job, state, ...(typeof o.rid === "string" ? { rid: o.rid } : {}), ...(typeof o.commit === "string" && COMMIT.test(o.commit) ? { commit: o.commit } : {}) });
    } catch { /* a torn line */ }
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
export function recordReuse(cfg: Pick<Config, "used">, m: string, job: string, state: ReuseState = "final", rid?: string, commit?: string): void {
  const f = cfg.used ?? USED_REUSE;
  const fresh = !existsSync(f);
  // The folders made for it, outermost first: each one's parent is flushed once it holds them.
  const made: string[] = [];
  for (let d = dirname(f); !existsSync(d) && dirname(d) !== d; d = dirname(d)) made.unshift(d);
  mkdirSync(dirname(f), { recursive: true });
  const fd = openSync(f, "a");
  try { writeSync(fd, JSON.stringify({ m, job, state, ...(rid ? { rid } : {}), ...(commit ? { commit } : {}) }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  if (fresh) { for (const d of made) fsyncDir(dirname(d)); fsyncDir(dirname(f)); }
}
// Whether the queue as fetched this round says the tap's push reached GitHub: "landed" (its
// commit is in the branch, or the job or request is named anywhere in the queue), "absent" (the
// positive evidence that it never did, above), or "unknown" (anything else).
export type PushSeen = "landed" | "absent" | "unknown";
export function pushSeen(cfg: Config, l: ReuseLine, fetched: string | null): PushSeen {
  if (named(cfg.dir, [l.job, ...(l.rid ? [l.rid] : [])], resolve(cfg.used ?? USED_REUSE))) return "landed";
  if (!fetched || !l.commit) return "unknown";
  // Is the keeper's commit in the branch as fetched? git answers 0 (yes) or 1 (no) for a commit it
  // has; one it doesn't have at all was never fetched, so it is in no part of the branch.
  const has = Bun.spawnSync(["git", "cat-file", "-e", `${l.commit}^{commit}`], { cwd: cfg.dir, stdout: "ignore", stderr: "ignore" });
  if (has.exitCode !== 0) {
    // Not here: the fetch brought the branch's whole history, so the branch doesn't hold it, as
    // long as the copy is a full clone (a shallow one can't tell).
    return existsSync(join(cfg.dir, ".git", "shallow")) ? "unknown" : "absent";
  }
  const a = Bun.spawnSync(["git", "merge-base", "--is-ancestor", l.commit, fetched], { cwd: cfg.dir, stdout: "ignore", stderr: "ignore" });
  return a.exitCode === 0 ? "landed" : a.exitCode === 1 ? "absent" : "unknown";
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
// Step 0 of a round, after sync: every pending tap settled against the queue as GitHub has it.
// fetched: the branch's commit this round's fetch brought (sync), or null when it brought none.
// A tap that can't be settled either way throws ReuseUnsettled: the round stops, the tap stays pending.
export function reconcileReuse(cfg: Config, jobs: Job[], fetched: string | null = null): { finalised: string[]; rolledBack: string[] } {
  const finalised: string[] = [], rolledBack: string[] = [];
  for (const l of reuseLedger(cfg).values()) {
    if (l.state !== "pending") continue;
    const seen = jobs.some((j) => j.id === l.job && j.owner_reuse?.message_id === l.m) ? "landed" : pushSeen(cfg, l, fetched);
    if (seen === "landed") {
      recordReuse(cfg, l.m, l.job, "final", l.rid, l.commit);
      finalised.push(l.job);
      if (l.rid && RID.test(l.rid) && existsSync(join(cfg.queue, `${l.rid}.json`))) {
        writeOutcome(cfg, { request: l.rid, state: "queued", id: l.job });
        rmSync(join(cfg.queue, `${l.rid}.json`), { force: true });
      }
      log(`settled the reuse tap for ${l.job}: its push reached the queue`);
    } else if (seen === "absent") {
      recordReuse(cfg, l.m, l.job, "rolled_back", l.rid, l.commit);
      rolledBack.push(l.job);
      log(`rolled back the reuse tap for ${l.job}: its commit isn't in the queue and nothing there names it`);
    } else {
      throw new ReuseUnsettled(`the reuse tap for ${l.job} can't be settled yet (the queue doesn't show whether its push landed); it stays pending, so spent`);
    }
  }
  return { finalised, rolledBack };
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

// The queue copy brought up to date from GitHub: the branch's commit as fetched, or null when
// the remote has no branch yet (nothing to fetch). Every git error throws.
export function sync(cfg: Config): string | null {
  if (!existsSync(join(cfg.dir, ".git"))) {
    mkdirSync(dirname(cfg.dir), { recursive: true });
    git(cfg, ["clone", "--quiet", "-c", "core.symlinks=false", cfg.remote, cfg.dir], dirname(cfg.dir));
  }
  rmSync(join(cfg.dir, ".git", "index.lock"), { force: true });
  // A queue that is still empty has no branch yet: nothing to fetch.
  const has = git(cfg, ["ls-remote", "--heads", "origin", cfg.branch]).length > 0;
  if (!has) return null;
  git(cfg, ["fetch", "--quiet", "origin", cfg.branch]);
  git(cfg, ["checkout", "--quiet", "-B", cfg.branch, `origin/${cfg.branch}`]);
  git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);
  git(cfg, ["clean", "-qfd"]);
  const at = git(cfg, ["rev-parse", "--verify", `origin/${cfg.branch}^{commit}`]).trim();
  if (!COMMIT.test(at)) throw new GitError("git rev-parse: no commit for the fetched branch");
  return at;
}

// The push, tried up to PUSH_TRIES times with a short wait between (the same commit each time).
export function push(cfg: Config): void {
  for (let i = 1; ; i++) {
    try { git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]); return; } catch (e) {
      if (i >= PUSH_TRIES) throw e;
      log(`push ${i} of ${PUSH_TRIES} didn't go through, trying again: ${(e as Error).message}`);
      const ms = cfg.pushWaitMs ?? PUSH_WAIT_MS;
      if (ms > 0) Bun.sleepSync(ms);
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
    return "The PC stopped taking jobs because Chrome has a Claude in Chrome update waiting. At the PC: restart the Cain jobs Chrome; the next run then asks for a new probe.";
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
    return "The PC isn't taking jobs because the Cain jobs Chrome has another extension turned on. At the PC: remove it there (worker.ts check-host lists them).";
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
    const used = jobs.find((j) => j.owner_reuse?.message_id === reuse.message_id)?.id ?? usedReuse(cfg).get(reuse.message_id);
    if (used) return { why: `owner_reuse refused: that tap of his already answered for ${used}; ask him again for this job` };
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
  const names = existsSync(cfg.queue) ? readdirSync(cfg.queue).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort() : [];
  try {
    const fetched = sync(cfg);
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
    // Every reuse tap left pending by a round that didn't finish, settled against the queue as GitHub has it.
    // A tap that can't be settled stops the round here (it stays pending, so spent).
    reconcileReuse(cfg, readJobs(cfg.dir), fetched);
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
    // Each reuse tap spent before the push, flushed to disk, with the commit that carries its job
    // (a failure here stops the round: nothing is pushed).
    const commit = git(cfg, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    for (const m of made) if (m.job?.owner_reuse) recordReuse(cfg, m.job.owner_reuse.message_id, m.job.id, "pending", m.rid, commit);
    push(cfg);
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
  } else if (cmd === "list") {
    console.log(heartbeatLine(readHeartbeat(cfg.dir)));
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
