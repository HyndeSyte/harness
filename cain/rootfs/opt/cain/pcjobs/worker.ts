// The PC side of the job queue, and the scheduled task's entry point
// (cain/docs/pc-worker/prompt.md). The worker does every check and every git operation;
// the task's model does only the browser step and hands back what it saw. The checks are
// here, in code, not left to the model: the kill switch, one run at a time, the queue's
// line endings, the owner's signed allowlist with its pinned addresses, the read-only
// action set, expiry and leases (with a small clock skew allowed), the browser preflight,
// and the typed facts of a result.
//
// Commands the scheduled task runs (its only pre-approved commands):
//   worker.ts next                     claim at most one job; prints {"run": <instruction> | null, "closed": [ids], "code"}
//   worker.ts renew <id> <attempt>     still ours? then the lease runs another 30 minutes; prints {"lease_until"}
//   worker.ts report <id> <attempt> <file>
//                                      what the model saw, checked and written as the result; prints {"state", "code"}
// Commands only the owner runs, by hand:
//   worker.ts confirm-profile          after watching the first probe pass: the Chrome profile is the right one
//   worker.ts owner-keygen --kid <id> --out <dir>      his allowlist key (passphrase in PC_OWNER_PASSPHRASE)
//   worker.ts sign-allowlist <entries.json> --key <pem> --kid <id> --out <allowlist.json>
//
// Every command takes --home <worker folder> (default PC_WORKER_HOME, else the current
// folder), which holds: queue/ (the clone, its remote on the PC's deploy key),
// allowlist.json, owner.pub, ship.pub, profile.json, and the worker's own STOP (the kill
// switch), worker.lock, heartbeat.json and worker.log.
//
// Nothing raw leaves the worker: no page text, no git or browser error text. What it
// prints, logs and pushes is fixed words, ids and reason codes. Runs on Bun, or on Node
// 22.18 or later (which runs TypeScript as is); paths are joined, never written with a
// slash, so it runs the same on Windows.
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  checkFacts, factsFor, isReadOnly, jobText, LEASE_MS, newAttempt, onPin, onSite, parseAllowlist, parseHeartbeat,
  parseJob, parseKeys, parseResult, pinFor, resultText, sanitizeUrl, signAllowlist, signerOf, SKEW_MS, stateAfter, ID, ATTEMPT, KID,
  type Allow, type Checked, type Code, type FactType, type Handoff, type Heartbeat, type Job, type Result, type Status,
} from "./core.ts";
import { publicOf } from "../link/shipkey.ts";

export interface Opts {
  home: string;
  branch?: string;
  now?: () => Date;
  attended?: boolean;                               // the owner is watching (the first probe)
  probe?: (o: Opts) => Code | null;                 // the browser preflight (chromeProbe unless a test stands in)
  sleep?: (ms: number) => void;
  rand?: () => number;
}

export class WorkerError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const P = {
  queue: (o: Opts) => join(o.home, "queue"),
  allow: (o: Opts) => join(o.home, "allowlist.json"),
  owner: (o: Opts) => join(o.home, "owner.pub"),
  ship: (o: Opts) => join(o.home, "ship.pub"),
  profile: (o: Opts) => join(o.home, "profile.json"),
  stop: (o: Opts) => join(o.home, "STOP"),
  lock: (o: Opts) => join(o.home, "worker.lock"),
  beat: (o: Opts) => join(o.home, "heartbeat.json"),
  log: (o: Opts) => join(o.home, "worker.log"),
  report: (o: Opts) => join(o.home, "report.json"),
};

const clock = (o: Opts) => o.now?.() ?? new Date();
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- git, with retries ---------------------------------------------------------------
// Noninteractive: no prompts, no hooks, no line ending rewrites. A transient lock (an
// index.lock left by another process, a file held open by a scanner on Windows) is
// retried with a growing wait; the error text itself never leaves this function.
const TRANSIENT = /index\.lock|\.lock'?: File exists|cannot lock|unable to (create|unlink)|Permission denied|being used by another process|Resource temporarily unavailable|Device or resource busy|Could not resolve host|Connection (reset|timed out)|early EOF|remote end hung up/i;

function gitRaw(o: Opts, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=PC job worker", "-c", "user.email=HyndeSyte@users.noreply.github.com",
    "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", `core.hooksPath=${join(P.queue(o), ".git", "no-hooks")}`, ...args],
  { cwd: P.queue(o), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" } }).trim();
}

function git(o: Opts, args: string[], tries = 4): string {
  const wait = o.sleep ?? sleepSync;
  for (let i = 0; ; i++) {
    try { return gitRaw(o, args); }
    catch (e) {
      const text = String((e as any)?.stderr ?? "") + String((e as Error)?.message ?? "");
      if (i + 1 >= tries || !TRANSIENT.test(text)) throw new WorkerError("git_failed");
      wait(250 * 2 ** i);
    }
  }
}

const branch = (o: Opts) => o.branch ?? "main";

// The queue brought to the remote's state. false when the remote has no branch yet.
function update(o: Opts): boolean {
  const b = branch(o);
  if (!git(o, ["ls-remote", "--heads", "origin", b])) return false;
  git(o, ["fetch", "--quiet", "origin", b]);
  git(o, ["checkout", "--quiet", "-B", b, `origin/${b}`]);
  git(o, ["reset", "--quiet", "--hard", `origin/${b}`]);
  git(o, ["clean", "-qfd"]);
  return true;
}

// Commit what's staged and push it; if Cain's keeper pushed new jobs meanwhile, put
// this on top of them (he only ever adds new files) and try again. A rebase that clashes
// (someone else wrote the same file) is a lost race: nothing of ours is pushed.
function commitPush(o: Opts, message: string) {
  const b = branch(o);
  git(o, ["commit", "--quiet", "-m", message]);
  for (let i = 0; ; i++) {
    try { gitRaw(o, ["push", "--quiet", "origin", `HEAD:${b}`]); return; }
    catch {
      if (i >= 3) throw new WorkerError("git_failed");
      git(o, ["fetch", "--quiet", "origin", b]);
      try { gitRaw(o, ["rebase", "--quiet", `origin/${b}`]); }
      catch { try { gitRaw(o, ["rebase", "--abort"]); } catch { /* none */ } throw new WorkerError("lost_race"); }
    }
  }
}

const listed = (o: Opts, dir: string, re: RegExp) =>
  git(o, ["ls-files", "-z", dir]).split("\0").map((n) => re.exec(n)?.[1]).filter((x): x is string => !!x);

function jobs(o: Opts): Job[] {
  const out: Job[] = [];
  for (const id of listed(o, "jobs", /^jobs\/(j-\d{8}-[a-z0-9]{6})\.json$/)) {
    const j = parseJob(readFileSync(join(P.queue(o), "jobs", `${id}.json`), "utf8"));
    if (j.ok && j.value.id === id) out.push(j.value);
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
}
const cancels = (o: Opts) => new Set(listed(o, "cancels", /^cancels\/(j-\d{8}-[a-z0-9]{6})\.json$/));
const nonces = (o: Opts) => new Set(listed(o, "nonces", /^nonces\/([A-Za-z0-9_-]{22,64})\.json$/));

function put(o: Opts, rel: string[], text: string) {
  mkdirSync(join(P.queue(o), ...rel.slice(0, -1)), { recursive: true });
  writeFileSync(join(P.queue(o), ...rel), text);
  git(o, ["add", "--", rel.join("/")]);
}
const writeJob = (o: Opts, j: Job) => put(o, ["jobs", `${j.id}.json`], jobText(j));
const writeResult = (o: Opts, r: Result) => put(o, ["results", `${r.id}.json`], resultText(r));

const result = (job: Job, status: Status, code: Code, now: Date, extra: Partial<Result> = {}): Result => ({
  v: 1, id: job.id, attempt: job.attempt, status, code, handoff: null, worker_clock: now.toISOString(), final_url: null, facts: {}, ...extra,
});

// Close a job for good with this result.
function close(o: Opts, job: Job, r: Result) {
  writeResult(o, r);
  writeJob(o, { ...job, state: stateAfter(job, r), lease_until: null });
}

// The queue's .gitattributes must keep every byte as written (cain/docs/pc-worker/queue-template).
function attributesOk(o: Opts): boolean {
  try { return readFileSync(join(P.queue(o), ".gitattributes"), "utf8").split(/\r?\n/).some((l) => l.trim() === "* -text"); }
  catch { return false; }
}

// ---- The owner's allowlist --------------------------------------------------------
// Signed by his own key (owner.pub holds its public half). Where the system allows it,
// the files must also not be writable by anyone else; on Windows that is an ACL the
// setup note asks him to set, which this code can't read.
function writableByOthers(f: string): boolean {
  if (process.platform === "win32") return false;
  try { return (statSync(f).mode & 0o022) !== 0; } catch { return true; }
}

export function loadAllowlist(o: Opts): Checked<Allow[]> {
  for (const f of [P.allow(o), P.owner(o)]) if (writableByOthers(f)) return { ok: false, why: "writable by others" };
  let text = "", keys = "";
  try { text = readFileSync(P.allow(o), "utf8"); keys = readFileSync(P.owner(o), "utf8"); } catch { return { ok: false, why: "missing" }; }
  return parseAllowlist(text, parseKeys(keys));
}

// ---- The browser preflight ----------------------------------------------------------
// profile.json, written by the owner at setup:
//   {"v": 1, "user_data_dir": "C:/pc-worker/chrome", "profile_directory": "Default",
//    "profile_name": "Cain jobs", "extension_id": "<Claude in Chrome's id>",
//    "chrome_path": "C:/Program Files/Google/Chrome/Application/chrome.exe" or null,
//    "confirmed": null}
// Neither Claude in Chrome nor Claude Desktop tells a program which profile the extension
// is attached to. So the worker checks what it can: that Chrome runs on the dedicated
// user data folder (starting it there when chrome_path is set), that the profile in it is
// the named one, and that the extension is installed in it. The extension is installed
// nowhere else, so an attached extension is that profile's. Until the owner has watched
// the first probe pass and run confirm-profile, it fails closed: no unattended run.
export interface Profile { v: 1; user_data_dir: string; profile_directory: string; profile_name: string; extension_id: string;
  chrome_path: string | null; confirmed: string | null }

function readProfile(o: Opts): Profile | null {
  try {
    const p = JSON.parse(readFileSync(P.profile(o), "utf8"));
    const s = (x: unknown) => typeof x === "string" && x.length > 0 && x.length < 400;
    if (p?.v !== 1 || !s(p.user_data_dir) || !s(p.profile_directory) || !s(p.profile_name) || !/^[a-p]{32}$/.test(p.extension_id ?? "")
      || !(p.chrome_path === null || s(p.chrome_path)) || !(p.confirmed === null || s(p.confirmed))) return null;
    return p as Profile;
  } catch { return null; }
}

const exists = (f: string) => { try { lstatSync(f); return true; } catch { return false; } };
const chromeRunning = (udd: string) => ["lockfile", "SingletonLock", "SingletonSocket"].some((n) => exists(join(udd, n)));

export function chromeProbe(o: Opts): Code | null {
  const p = readProfile(o);
  if (!p) return "wrong_profile";
  const dir = join(p.user_data_dir, p.profile_directory);
  let name = "";
  try { name = JSON.parse(readFileSync(join(dir, "Preferences"), "utf8"))?.profile?.name ?? ""; } catch { /* none */ }
  if (name !== p.profile_name) return "wrong_profile";
  if (!exists(join(dir, "Extensions", p.extension_id))) return "wrong_profile";
  if (!chromeRunning(p.user_data_dir) && p.chrome_path) {
    try {
      spawn(p.chrome_path, [`--user-data-dir=${resolve(p.user_data_dir)}`, `--profile-directory=${p.profile_directory}`],
        { detached: true, stdio: "ignore" }).on("error", () => { /* stays unreachable */ }).unref();
      (o.sleep ?? sleepSync)(8_000);
    } catch { /* stays unreachable */ }
  }
  if (!chromeRunning(p.user_data_dir)) return "browser_unreachable";
  if (!p.confirmed && !o.attended) return "profile_unconfirmed";
  return null;
}

// ---- One run at a time, the heartbeat, the log ---------------------------------------
// The lock is taken by `next` when it claims a job and given back by `report`; a lock
// older than a lease (and the skew) is from a run that died, and is taken over.
function lock(o: Opts, now: Date): boolean {
  const f = P.lock(o);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
      closeSync(fd);
      return true;
    } catch {
      let at = 0;
      try { at = Date.parse(JSON.parse(readFileSync(f, "utf8")).at); } catch { at = 0; }
      if (Number.isFinite(at) && at > 0 && now.getTime() - at < LEASE_MS + SKEW_MS) return false;
      rmSync(f, { force: true });
    }
  }
  return false;
}
const unlock = (o: Opts) => rmSync(P.lock(o), { force: true });

// The local heartbeat (heartbeat.json) and log (worker.log), each a reason code and an id
// at most. The same heartbeat goes to the queue repo (worker/heartbeat.json) when its code
// changes, or once a day, so Cain can see the PC is alive and why it isn't working.
function beat(o: Opts, code: Heartbeat["code"], job: string | null, now: Date) {
  const h: Heartbeat = { v: 1, worker_clock: now.toISOString(), code, job };
  try {
    mkdirSync(o.home, { recursive: true });
    writeFileSync(P.beat(o), JSON.stringify(h) + "\n");
    const f = P.log(o);
    if (exists(f) && statSync(f).size > 200_000) writeFileSync(f, readFileSync(f, "utf8").slice(-100_000));
    appendFileSync(f, `${h.worker_clock} ${code} ${job ?? "-"}\n`);
  } catch { /* the heartbeat never stops a run */ }
  return h;
}

function stageBeat(o: Opts, h: Heartbeat): boolean {
  let old: Heartbeat | null = null;
  try { old = parseHeartbeat(readFileSync(join(P.queue(o), "worker", "heartbeat.json"), "utf8")); } catch { old = null; }
  if (old && old.code === h.code && Date.parse(h.worker_clock) - Date.parse(old.worker_clock) < 24 * 3_600_000) return false;
  put(o, ["worker", "heartbeat.json"], JSON.stringify(h, null, 2) + "\n");
  return true;
}

// ---- What the model is told, and what it may say back --------------------------------
// The outcomes the model may report, and nothing else.
export const OUTCOMES = ["seen", "already_gone", "needs_login", "blocked_captcha", "pending_email_confirmation",
  "browser_unreachable", "wrong_profile", "not_as_expected", "uncertain"] as const;

const describe = (t: FactType) => t.t === "bool" ? "true or false" : t.t === "enum" ? `one of: ${t.of.join(", ")}`
  : t.t === "date" ? "a date, YYYY-MM-DD" : `a short token, at most ${t.max} characters, no spaces unless a label`;

export interface Instruction {
  id: string; attempt: string; site: string; action: string; start_url: string; look_for: string; lease_until: string;
  facts: Record<string, string>; outcomes: readonly string[]; report_to: string;
}

const instruction = (o: Opts, j: Job): Instruction => ({
  id: j.id, attempt: j.attempt!, site: j.site, action: j.action, start_url: j.start_url, look_for: j.done_looks_like,
  lease_until: j.lease_until!, facts: Object.fromEntries(Object.entries(factsFor(j)).map(([k, t]) => [k, describe(t)])),
  outcomes: OUTCOMES, report_to: P.report(o),
});

// Why a pending job can't run here, or null when it can.
export function blocker(job: Job, allow: Checked<Allow[]>, now: Date): { status: Status; code: Code } | null {
  if (Date.parse(job.expires) + SKEW_MS <= now.getTime()) return { status: "expired", code: "expired" };
  // Read-only, enforced: an irreversible action (preview or confirm) is refused until the
  // confirm path ships.
  if (!isReadOnly(job)) return { status: "refused", code: "action_not_read_only" };
  if (!allow.ok) return { status: "refused", code: "allowlist_unverified" };
  if (!pinFor(job, allow.value)) return { status: "refused", code: "not_allowlisted" };
  return null;
}

export interface NextOut { run: Instruction | null; closed: string[]; code: Heartbeat["code"] }

export function next(o: Opts): NextOut {
  const now = clock(o);
  // The kill switch: a STOP file in the worker folder, and nothing else happens.
  if (existsSync(P.stop(o))) { beat(o, "stopped", null, now); return { run: null, closed: [], code: "stopped" }; }
  if (!lock(o, now)) { beat(o, "busy", null, now); return { run: null, closed: [], code: "busy" }; }
  let keep = false;
  try {
    if (!update(o)) { beat(o, "idle", null, now); return { run: null, closed: [], code: "idle" }; }
    if (!attributesOk(o)) { beat(o, "queue_misconfigured", null, now); return { run: null, closed: [], code: "queue_misconfigured" }; }
    const all = jobs(o), cancelled = cancels(o), allow = loadAllowlist(o);
    const closed: string[] = [];
    let candidate: Job | null = null;
    for (const j of all) {
      if (j.state === "claimed" && Date.parse(j.lease_until!) + SKEW_MS <= now.getTime()) {
        // A run that never finished. A read changed nothing; anything else may have done
        // part of its step: in doubt, never retried by itself.
        close(o, j, isReadOnly(j) ? result(j, "failed", "lease_expired", now) : result(j, "in_doubt", "lease_expired", now));
        closed.push(j.id);
        continue;
      }
      if (j.state !== "pending") continue;
      if (cancelled.has(j.id)) { close(o, j, result(j, "cancelled", "cancelled", now)); closed.push(j.id); continue; }
      const b = blocker(j, allow, now);
      if (b) { close(o, j, result(j, b.status, b.code, now)); closed.push(j.id); continue; }
      candidate ??= j;
    }
    let run: Job | null = null;
    let code: Heartbeat["code"] = "idle";
    if (candidate) {
      const pre = (o.probe ?? chromeProbe)(o);
      if (pre) code = pre;                    // nothing is claimed; the job waits for the next run
      else {
        run = { ...candidate, state: "claimed", attempt: newAttempt(o.rand),
          lease_until: new Date(now.getTime() + LEASE_MS).toISOString() };
        writeJob(o, run);
        code = "ok";
      }
    }
    const h = beat(o, code, run?.id ?? null, now);
    const beatChanged = stageBeat(o, h);
    if (run || closed.length || beatChanged) {
      const parts = [run ? `claim ${run.id}` : "", closed.length ? `close ${closed.join(", ")}` : "", !run && !closed.length ? `worker ${code}` : ""];
      commitPush(o, parts.filter(Boolean).join("; "));
    }
    keep = !!run;
    return { run: run ? instruction(o, run) : null, closed, code };
  } finally {
    if (!keep) unlock(o);
  }
}

// Before each step: the job is still ours (claimed, by this attempt, its lease not run
// out allowing for skew) and not cancelled. Otherwise the run stops at once and gives
// the lock back (only one run is ever going, so the lock is this run's).
function lost(o: Opts, id: string, now: Date): never {
  unlock(o);
  beat(o, "lease_expired", ID.test(id) ? id : null, now);
  throw new WorkerError("lost_lease");
}

function own(o: Opts, id: string, attempt: string, now: Date): Job {
  if (!ID.test(id) || !ATTEMPT.test(attempt)) throw new WorkerError("bad_arguments");
  if (!update(o)) lost(o, id, now);
  const job = jobs(o).find((j) => j.id === id);
  if (!job || job.state !== "claimed" || job.attempt !== attempt) lost(o, id, now);
  if (cancels(o).has(id)) {
    close(o, job, isReadOnly(job) ? result(job, "cancelled", "cancelled", now) : result(job, "in_doubt", "cancelled", now));
    commitPush(o, `cancel ${id}`);
    unlock(o);
    throw new WorkerError("cancelled");
  }
  if (Date.parse(job.lease_until!) - SKEW_MS <= now.getTime()) lost(o, id, now);
  return job;
}

export function renew(o: Opts, id: string, attempt: string): { lease_until: string } {
  const now = clock(o);
  const job = own(o, id, attempt, now);
  const lease_until = new Date(now.getTime() + LEASE_MS).toISOString();
  writeJob(o, { ...job, lease_until });
  commitPush(o, `renew ${id}`);
  return { lease_until };
}

// Before a confirming click (the confirm path, not run in this version): the tap's nonce
// is recorded in the queue repo first, so a token is spent once even if the click dies.
export function spendNonce(o: Opts, id: string, attempt: string, nonce: string) {
  const now = clock(o);
  own(o, id, attempt, now);
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) throw new WorkerError("nonce_spent");
  if (nonces(o).has(nonce)) throw new WorkerError("nonce_spent");
  put(o, ["nonces", `${nonce}.json`], JSON.stringify({ v: 1, nonce, job: id, attempt, worker_clock: now.toISOString() }, null, 2) + "\n");
  try { commitPush(o, `spend a tap for ${id}`); }
  catch (e) { if ((e as WorkerError).code === "lost_race") throw new WorkerError("nonce_spent"); throw e; }
}

// What the model saw, checked: {"outcome", "final_url", "facts"}, nothing else. Anything
// that breaks the shape ends the job as result_rejected, and none of it is written.
export function judge(job: Job, given: unknown, allow: Checked<Allow[]>, now: Date): Result {
  const reject = () => result(job, "failed", "result_rejected", now);
  if (!given || typeof given !== "object" || Array.isArray(given)) return reject();
  const g = given as Record<string, unknown>;
  if (Object.keys(g).some((k) => !["outcome", "final_url", "facts"].includes(k))) return reject();
  const outcome = g.outcome as typeof OUTCOMES[number];
  if (!OUTCOMES.includes(outcome)) return reject();
  const facts = g.facts ?? {};
  const url = g.final_url === undefined || g.final_url === null ? null : sanitizeUrl(g.final_url);
  if (g.final_url !== undefined && g.final_url !== null && url === null) return reject();
  if (outcome !== "seen" && (typeof facts !== "object" || facts === null || Object.keys(facts).length)) return reject();
  const onTheSite = url && onSite(url, job.site) ? url : null;
  const sideEffects = !isReadOnly(job);
  switch (outcome) {
    case "browser_unreachable": case "wrong_profile":
      return result(job, "failed", outcome, now);
    case "needs_login": case "blocked_captcha": case "pending_email_confirmation": {
      const handoff = outcome as Handoff;
      return result(job, outcome === "pending_email_confirmation" ? "done" : "failed", handoff, now, { handoff, final_url: onTheSite });
    }
    case "uncertain":
      return result(job, "in_doubt", "outcome_uncertain", now, { final_url: onTheSite });
    case "not_as_expected":
      return result(job, sideEffects ? "in_doubt" : "failed", "page_not_as_expected", now, { final_url: onTheSite });
    case "already_gone": case "seen": {
      if (!allow.ok) return result(job, "failed", "allowlist_unverified", now);
      const pin = pinFor(job, allow.value);
      if (!url || !pin || !onPin(url, pin)) return result(job, "failed", "url_drift", now, { final_url: onTheSite });
      if (outcome === "already_gone") return result(job, "done", "already_gone", now, { handoff: "already_gone", final_url: url });
      const f = checkFacts(job.action, facts);
      if (!f.ok) return reject();
      return result(job, "done", "ok", now, { final_url: url, facts: f.value });
    }
  }
  return reject();
}

export function report(o: Opts, id: string, attempt: string, file: string): { state: string; code: Code } {
  const now = clock(o);
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { raw = ""; }
  rmSync(file, { force: true });                      // what the model wrote never lingers
  const job = own(o, id, attempt, now);
  let given: unknown = null;
  try { given = raw.length <= 4_000 ? JSON.parse(raw) : null; } catch { given = null; }
  const r = judge(job, given, loadAllowlist(o), now);
  // The result is checked once more as it will be read, facts typed for its action.
  const checked = parseResult(resultText(r), job.action);
  const final = checked.ok ? checked.value : result(job, "failed", "result_rejected", now);
  close(o, job, final);
  commitPush(o, `result ${id}: ${final.status} (${final.code})`);
  unlock(o);
  beat(o, final.code, id, now);
  return { state: stateAfter(job, final), code: final.code };
}

// ---- The owner's commands ------------------------------------------------------------
export function confirmProfile(o: Opts): Profile {
  const p = readProfile(o);
  if (!p) throw new WorkerError("wrong_profile");
  const done = { ...p, confirmed: clock(o).toISOString() };
  writeFileSync(P.profile(o), JSON.stringify(done, null, 2) + "\n");
  return done;
}

export function ownerKeygen(kid: string, out: string, passphrase: string): string {
  if (!KID.test(kid)) throw new WorkerError("bad_arguments");
  if (passphrase.length < 12) throw new WorkerError("passphrase_too_short");
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "owner-key.pem"), privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase }), { mode: 0o600 });
  return `${kid} ${publicOf(privateKey)}`;
}

export function signAllowlistFile(entriesFile: string, keyFile: string, passphrase: string, kid: string): string {
  const e = JSON.parse(readFileSync(entriesFile, "utf8"));
  const allow = Array.isArray(e) ? e : e?.allow;
  const key: KeyObject = createPrivateKey({ key: readFileSync(keyFile, "utf8"), format: "pem", passphrase });
  const text = signAllowlist(kid, allow, signerOf(key));
  const check = parseAllowlist(text, new Map([[kid, createPublicKey(key)]]));
  if (!check.ok) throw new WorkerError("allowlist_unverified");
  return text;
}

// ---- The command line ----------------------------------------------------------------
function flag(args: string[], name: string, dflt?: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const isMain = (() => {
  try { return (import.meta as any).main ?? /worker\.ts$/.test(process.argv[1] ?? ""); } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const o: Opts = { home: resolve(flag(args, "--home", process.env.PC_WORKER_HOME ?? process.cwd())!), attended: args.includes("--attended") };
  const say = (x: unknown) => console.log(JSON.stringify(x));
  try {
    const [cmd, a1, a2, a3] = args;
    if (cmd === "next") say(next(o));
    else if (cmd === "renew" && a1 && a2) say(renew(o, a1, a2));
    else if (cmd === "report" && a1 && a2 && a3) say(report(o, a1, a2, a3));
    else if (cmd === "confirm-profile") say({ confirmed: confirmProfile(o).confirmed });
    else if (cmd === "owner-keygen") say({ owner_pub: ownerKeygen(flag(args, "--kid") ?? "", flag(args, "--out") ?? o.home, process.env.PC_OWNER_PASSPHRASE ?? "") });
    else if (cmd === "sign-allowlist" && a1) {
      const text = signAllowlistFile(a1, flag(args, "--key") ?? "", process.env.PC_OWNER_PASSPHRASE ?? "", flag(args, "--kid") ?? "");
      const out = flag(args, "--out");
      if (out) { writeFileSync(out, text); say({ written: out }); } else process.stdout.write(text);
    } else { console.error("usage: worker.ts next | renew <id> <attempt> | report <id> <attempt> <file> | confirm-profile | owner-keygen | sign-allowlist"); process.exit(2); }
  } catch (e) {
    say({ error: e instanceof WorkerError ? e.code : "worker_failed" });
    process.exit(1);
  }
}
