// The PC side of the job queue: what the scheduled task on Dane's PC runs before and
// after it uses the browser (cain/docs/pc-worker/prompt.md). The checks are here, in
// code, not left to the task's judgment: expiry, the claim and its lease, the PC's own
// allowlist, and, for a confirm job, the job token from his tap.
//
//   worker.ts next   [--queue <clone>] [--allow <allowlist.json>] [--pub <ship.pub>]
//       Brings the queue up to date, closes what can't run (expired, off the allowlist,
//       a confirm job without a good token, a claim whose lease ran out), claims the
//       oldest job that can run and pushes the claim. Prints one line of JSON:
//       {"run": <the job>} or {"run": null}, with "closed": [ids] either way.
//   worker.ts finish <job id> <result file> [--queue <clone>]
//       Checks the result (core.ts: fixed fields, a few named facts, no page text),
//       writes results/<id>.json, moves the job on, and pushes.
//
// The clone's remote uses the PC's deploy key for that one repo. Runs on Bun, or on
// Node 22.18 or later (which runs TypeScript as is).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type KeyObject } from "node:crypto";
import { allowed, confirmWhy, LEASE_MS, parseAllowlist, parseJob, parseResult, publicKey, stateAfter, jobText, resultText,
  ID, type Job, type Result, type Handoff, type Status } from "./core.ts";

export interface Opts { queue: string; allow: string; pub: string; branch?: string; now?: () => Date }

const git = (o: Opts, args: string[]) => execFileSync("git", ["-c", "user.name=PC job worker",
  "-c", "user.email=HyndeSyte@users.noreply.github.com", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd: o.queue, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function update(o: Opts) {
  const b = o.branch ?? "main";
  git(o, ["fetch", "--quiet", "origin", b]);
  git(o, ["checkout", "--quiet", "-B", b, `origin/${b}`]);
  git(o, ["reset", "--quiet", "--hard", `origin/${b}`]);
  git(o, ["clean", "-qfd"]);
}

// Commit what's staged and push it; if Cain's keeper pushed new jobs meanwhile, put
// this on top of them (it only ever adds new job files) and try again.
function commitPush(o: Opts, message: string) {
  const b = o.branch ?? "main";
  git(o, ["commit", "--quiet", "-m", message]);
  for (let i = 0; ; i++) {
    try { git(o, ["push", "--quiet", "origin", `HEAD:${b}`]); return; }
    catch (e) {
      if (i >= 2) throw e;
      git(o, ["fetch", "--quiet", "origin", b]);
      git(o, ["rebase", "--quiet", `origin/${b}`]);
    }
  }
}

function jobs(o: Opts): Job[] {
  const d = join(o.queue, "jobs");
  if (!existsSync(d)) return [];
  const out: Job[] = [];
  for (const n of execFileSync("git", ["ls-files", "jobs"], { cwd: o.queue, encoding: "utf8" }).split("\n").filter(Boolean)) {
    const m = /^jobs\/(j-\d{8}-[a-z0-9]{6})\.json$/.exec(n);
    if (!m) continue;
    const j = parseJob(readFileSync(join(o.queue, n), "utf8"));
    if (j.ok && j.value.id === m[1]) out.push(j.value);
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
}

function writeJob(o: Opts, j: Job) {
  writeFileSync(join(o.queue, "jobs", `${j.id}.json`), jobText(j));
  git(o, ["add", `jobs/${j.id}.json`]);
}

function writeResult(o: Opts, r: Result) {
  mkdirSync(join(o.queue, "results"), { recursive: true });
  writeFileSync(join(o.queue, "results", `${r.id}.json`), resultText(r));
  git(o, ["add", `results/${r.id}.json`]);
}

const closing = (id: string, status: Status, reason: string, now: Date, handoff: Handoff | null = null): Result =>
  ({ v: 1, id, status, finished: now.toISOString(), final_url: null, facts: {}, handoff, reason });

function loadPub(o: Opts): KeyObject | null {
  try { return publicKey(readFileSync(o.pub, "utf8")); } catch { return null; }
}

// Why a pending job can't run here ("" when it can), and what it closes as.
export function blocker(job: Job, all: Job[], allow: ReturnType<typeof parseAllowlist>, key: KeyObject | null, now: Date):
  { status: Status; reason: string } | null {
  if (Date.parse(job.expires) <= now.getTime()) return { status: "expired", reason: "it expired before the PC reached it" };
  if (!allow.ok) return { status: "refused", reason: `the PC's allowlist can't be read: ${allow.why}` };
  if (!allowed(job, allow.value)) return { status: "refused", reason: `${job.step} ${job.action} on ${job.site} isn't on the PC's allowlist` };
  const why = confirmWhy(job, key, all, now.getTime());
  if (why) return { status: "refused", reason: why };
  return null;
}

export function next(o: Opts): { run: Job | null; closed: string[] } {
  const now = o.now?.() ?? new Date();
  update(o);
  const all = jobs(o);
  let allowText = "";
  try { allowText = readFileSync(o.allow, "utf8"); } catch { /* none */ }
  const allow = parseAllowlist(allowText);
  const key = loadPub(o);
  const closed: string[] = [];
  let run: Job | null = null;
  for (const j of all) {
    if (j.state === "claimed" && Date.parse(j.lease_until!) <= now.getTime()) {
      // A run that never finished may have done part of its step: say so, never guess.
      writeResult(o, closing(j.id, "failed", "its claim ran out before a result was written", now, "outcome_unknown"));
      writeJob(o, { ...j, state: "failed", lease_until: null });
      closed.push(j.id);
      continue;
    }
    if (j.state !== "pending") continue;
    const b = blocker(j, all, allow, key, now);
    if (b) {
      writeResult(o, closing(j.id, b.status, b.reason, now));
      writeJob(o, { ...j, state: "failed", lease_until: null });
      closed.push(j.id);
      continue;
    }
    if (!run) {
      run = { ...j, state: "claimed", lease_until: new Date(now.getTime() + LEASE_MS).toISOString() };
      writeJob(o, run);
    }
  }
  if (run || closed.length) {
    const parts = [run ? `claim ${run.id}` : "", closed.length ? `close ${closed.join(", ")}` : ""].filter(Boolean);
    commitPush(o, parts.join("; "));
  }
  return { run, closed };
}

// The task's result: status, final_url, facts, handoff, reason. The id and the time are
// filled in here.
export function finish(o: Opts, id: string, resultFile: string): { state: string } {
  const now = o.now?.() ?? new Date();
  if (!ID.test(id)) throw new Error("not a job id");
  update(o);
  const job = jobs(o).find((j) => j.id === id);
  if (!job) throw new Error(`${id} isn't in the queue`);
  if (job.state !== "claimed") throw new Error(`${id} isn't claimed (it's ${job.state}); nothing written`);
  let given: any;
  try { given = JSON.parse(readFileSync(resultFile, "utf8")); } catch { throw new Error("the result file isn't JSON"); }
  const r = parseResult(JSON.stringify({ v: 1, id, status: given?.status, finished: now.toISOString(),
    final_url: given?.final_url ?? null, facts: given?.facts ?? {}, handoff: given?.handoff ?? null, reason: given?.reason ?? null }));
  if (!r.ok) throw new Error(`result refused: ${r.why}`);
  const extra = Object.keys(given ?? {}).filter((k) => !["status", "final_url", "facts", "handoff", "reason"].includes(k));
  if (extra.length) throw new Error(`result refused: only status, final_url, facts, handoff and reason (not ${extra.join(", ")})`);
  const state = stateAfter(job, r.value);
  writeResult(o, r.value);
  writeJob(o, { ...job, state, lease_until: null });
  commitPush(o, `result ${id}: ${r.value.status}${r.value.handoff ? ` (${r.value.handoff})` : ""}`);
  return { state };
}

function flag(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const isMain = (() => {
  try { return (import.meta as any).main ?? process.argv[1]?.endsWith("worker.ts"); } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const here = process.env.PC_WORKER_HOME ?? process.cwd();
  const o: Opts = {
    queue: flag(args, "--queue", join(here, "queue")),
    allow: flag(args, "--allow", join(here, "allowlist.json")),
    pub: flag(args, "--pub", join(here, "ship.pub")),
  };
  try {
    if (args[0] === "next") console.log(JSON.stringify(next(o)));
    else if (args[0] === "finish" && args[1] && args[2]) console.log(JSON.stringify(finish(o, args[1], args[2])));
    else { console.error("usage: worker.ts next | finish <job id> <result file>"); process.exit(2); }
  } catch (e) {
    console.error(String((e as Error).message ?? e).split("\n")[0]);
    process.exit(1);
  }
}
