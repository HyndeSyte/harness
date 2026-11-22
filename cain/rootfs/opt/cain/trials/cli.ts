// trial.sh: Cain's way to run a model trial and read it back. It runs as Cain's user: it reads the record
// and /data/trials, and leaves requests in /data/trials-inbox for the trials runner (runner.ts, in the
// review runner's process, which holds the keys). It never calls a model.
//   plan <suite> [questions.json]          every call the suite would make, its worst-case cost, the total
//   run <suite> [questions.json] [--retry] [--new]
//                                          start the suite, or resume its newest run (--new: a fresh run;
//                                          --retry: try again calls that failed for good)
//   status                                 each suite's newest run, and the trials budget
//   result <suite>                         the newest run's state: every call, its cost, tokens and time
//   report <suite>                         the report (the runner also writes it to /data/trials/<suite>/report.md)
// Suites: review-seats (tasks from the record's past reviews), research (Cain's 30 questions, from the file
// given on the first plan or run; fixed from the first run on).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStop } from "../stop.ts";
import { DEFAULT_BUDGET_USD, checkQuestions, isSuite, pickReviewTasks, planOf, type Suite, type SuiteName } from "./core.ts";
import { latestRun, readBudget, readSuite, reviewDirs } from "./runner.ts";
import { buildReport } from "./report.ts";

const env = process.env;
const dir = env.TRIALS_DIR ?? "/data/trials";
const inbox = env.TRIALS_INBOX ?? "/data/trials-inbox";
const recordDir = env.RECORD_DIR ?? "/data/record";
const tz = env.CHECKIN_TZ ?? "America/New_York";
const out = (s: string) => console.log(s);
const fail = (s: string, code = 2): never => { console.error(s); process.exit(code); };
// The budget the runner really uses, as it wrote it (root's file), never this process's environment.
const budget = (): number => { try { const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); if (Number.isFinite(j?.budget_usd)) return j.budget_usd; } catch { /* none yet */ } return DEFAULT_BUDGET_USD; };
const money = (n: number) => `$${n.toFixed(2)}`;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [cmd, a1, a2] = args.filter((a) => !a.startsWith("--"));

function suiteArg(): SuiteName { if (!isSuite(a1)) fail("name a suite: review-seats or research"); return a1 as SuiteName; }
function questionsFrom(file?: string): unknown {
  if (!file) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fail(`can't read ${file} as JSON`); }
}
// The suite as it is frozen, or as a first run would build it.
function suiteFor(name: SuiteName, file?: string): Suite {
  const frozen = readSuite(dir, name);
  if (frozen) return frozen;
  const now = new Date().toISOString();
  if (name === "review-seats") {
    const { tasks, skipped } = pickReviewTasks(reviewDirs(recordDir));
    if (!tasks.length) fail(`no past review in ${recordDir}/reviews has brief.txt, result.json and adopted.md`);
    return { format: 1, name, created_at: now, tasks, skipped };
  }
  if (!file) fail("the research suite needs its questions file on its first plan or run");
  const q = checkQuestions(questionsFrom(file));
  if (!q.tasks) fail(`the questions aren't right: ${q.error}`);
  return { format: 1, name, created_at: now, tasks: q.tasks!, skipped: [] };
}
function leave(req: object, name: string) {
  mkdirSync(inbox, { recursive: true });
  const f = join(inbox, `${Date.now()}-${name}.json`);
  const tmp = join(inbox, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(req), { mode: 0o640 });
  renameSync(tmp, f);
}

switch (cmd) {
  case "plan": {
    const name = suiteArg();
    const s = suiteFor(name, a2);
    const day = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const p = planOf(s, day);
    out(`Suite ${name}: ${s.tasks.length} tasks${readSuite(dir, name) ? " (fixed at its first run)" : " (as a first run would take them)"}. No call is made by this plan.`);
    out("task | who | seat | model | setting | search | worst case");
    for (const l of p.lines) out(`${l.task} | ${l.who} | ${l.seat} | ${l.model || "-"} | ${l.setting || "-"} | ${l.search ? "yes" : "no"} | ${money(l.worst_usd)}${l.note ? ` | ${l.note}` : ""}`);
    if (p.originals) out(`plus ${p.originals} original seat answers from the record, graded with no new call`);
    const b = readBudget(dir);
    out(`Total worst case: ${money(p.total)} over ${p.lines.length} calls. Trials budget: ${money(b.spent_usd)} spent of ${money(budget())}.`);
    out("Worst case: each call's input estimate at the input price and its output cap at the output price, with its most search fees; a model missing from the review service's price table is priced high. Codex runs on the ChatGPT plan ($0, one run each).");
    for (const n of s.skipped) out(`left out: ${n}`);
    break;
  }
  case "run": {
    const name = suiteArg();
    const frozen = readSuite(dir, name);
    if (name === "research" && !frozen && !a2) fail("the research suite needs its questions file on its first run");
    if (frozen && a2) fail("this suite's questions are already fixed (written before its first run); they can't change");
    if (!frozen) suiteFor(name, a2);   // checked here first, so Cain hears at once; the runner checks again
    leave({ kind: "run", suite: name, ...(a2 ? { questions: questionsFrom(a2) } : {}), ...(flags.has("--retry") ? { retry: true } : {}), ...(flags.has("--new") ? { fresh: true } : {}) }, `run-${name}`);
    const stopped = readStop().stopped;
    out(`left for the trials runner: run ${name}${flags.has("--new") ? " (a fresh run)" : ""}. It takes it within a minute${stopped ? "; everything is stopped now, so nothing is sent until Dane turns it back on" : ""}. trial.sh status shows it.`);
    break;
  }
  case "status": {
    const b = readBudget(dir);
    out(`Trials budget: ${money(b.spent_usd)} spent of ${money(budget())}${Object.keys(b.pending).length ? ` (a call is in flight)` : ""}.`);
    for (const name of ["review-seats", "research"] as SuiteName[]) {
      const st = latestRun(dir, name);
      if (!st) { out(`${name}: no run yet`); continue; }
      const calls = Object.values(st.calls);
      const by = (s: string) => calls.filter((c) => c.status === s).length;
      const spent = calls.reduce((a, c) => a + (c.cost_usd ?? 0), 0);
      out(`${name}: run ${st.run}, ${st.status}${st.stop ? ` (${st.stop.reason}: ${st.stop.detail})` : ""}; calls done ${by("done")}, skipped ${by("skipped")}, blocked ${by("blocked")}, failed ${by("failed")}, held ${by("held")}; ${money(spent)} this run`);
    }
    break;
  }
  case "result": {
    const name = suiteArg();
    const st = latestRun(dir, name);
    if (!st) fail(`${name}: no run yet`);
    out(JSON.stringify(st, null, 1));
    break;
  }
  case "report": {
    const name = suiteArg();
    out(buildReport(dir, name, budget()));
    leave({ kind: "report", suite: name }, `report-${name}`);
    break;
  }
  default:
    fail("usage: trial.sh plan|run|result|report <review-seats|research> [questions.json] [--retry] [--new], or trial.sh status");
}
