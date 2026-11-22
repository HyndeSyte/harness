// trial.sh: Cain's way to run a model trial and read it back. It runs as Cain's user: it reads the record
// and /data/trials, and leaves requests in /data/trials-inbox for the trials runner (runner.ts, in the
// review runner's process, which holds the keys). It never calls a model. A request carries a suite and the
// command only: the budget is the App's option, the configurations and run ids are the runner's.
//   plan <suite> [questions.json]          every call the suite would make, its ceilings, its worst-case cost,
//                                          the total (research: the record's questions, or a file to preview)
//   run <suite> [--retry] [--new]          start the suite, or resume its newest run (--new: a fresh run;
//                                          --retry: try again calls that failed for good)
//   status                                 each suite's newest run, and the trials budget
//   result <suite>                         the newest run's state: every call, its cost, tokens and time
//   report <suite>                         the report (the runner also writes it to /data/trials/<suite>/report.md)
// Suites: review-seats (tasks from the record's past reviews), research (Cain's 30 questions in the record
// at projects/harness/trials/research-questions.json, run only once the owner's approval file names them).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStop } from "../stop.ts";
import { DEFAULT_BUDGET_USD, checkQuestions, isSuite, pickReviewTasks, planOf, type Suite, type SuiteName } from "./core.ts";
import { RESEARCH_QUESTIONS, latestRun, readApproval, readBudget, readSuite, reviewDirs } from "./runner.ts";
import { committedOf } from "./ledger.ts";
import { buildReport } from "./report.ts";

const env = process.env;
const dir = env.TRIALS_DIR ?? "/data/trials";
const inbox = env.TRIALS_INBOX ?? "/data/trials-inbox";
const recordDir = env.RECORD_DIR ?? "/data/record";
const out = (s: string) => console.log(s);
const fail = (s: string, code = 2): never => { console.error(s); process.exit(code); };
// The budget the runner really uses, as it wrote it (root's file), never this process's environment.
const budget = (): number => { try { const j = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); if (Number.isFinite(j?.budget_usd)) return j.budget_usd; } catch { /* none yet */ } return DEFAULT_BUDGET_USD; };
const money = (n: number) => `$${n.toFixed(2)}`;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [cmd, a1, a2] = args.filter((a) => !a.startsWith("--"));

function suiteArg(): SuiteName { if (!isSuite(a1)) fail("name a suite: review-seats or research"); return a1 as SuiteName; }
// The suite as it is frozen, or as a first run would build it.
function suiteFor(name: SuiteName, file?: string): { suite: Suite; thirdParty: boolean; approval: string } {
  const frozen = readSuite(dir, name);
  const a = name === "research" ? readApproval(recordDir) : null;
  const approval = !a ? "" : a.ok ? "approved by the owner" : `NOT approved: ${(a as { why: string }).why}`;
  const thirdParty = !!(a && a.ok && a.third_party);
  if (frozen && !file) return { suite: frozen, thirdParty, approval };
  const now = new Date().toISOString();
  if (name === "review-seats") {
    const { tasks, skipped } = pickReviewTasks(reviewDirs(recordDir));
    if (!tasks.length) fail(`no past review in ${recordDir}/reviews has brief.txt, result.json and adopted.md`);
    return { suite: { format: 2, name, created_at: now, tasks, skipped }, thirdParty, approval };
  }
  let questions: unknown;
  const path = file ?? join(recordDir, RESEARCH_QUESTIONS);
  try { questions = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`can't read ${path} as JSON`); }
  const q = checkQuestions(questions);
  if (!q.tasks) fail(`the questions aren't right: ${q.error}`);
  return { suite: { format: 2, name, created_at: now, tasks: q.tasks!, skipped: [] }, thirdParty, approval: file ? "a preview of a file, not the record's approved questions" : approval };
}
function leave(req: { kind: string; suite: string; mode?: string }, name: string) {
  mkdirSync(inbox, { recursive: true });
  const f = join(inbox, `${Date.now()}-${name}.json`);
  const tmp = join(inbox, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(req), { mode: 0o640 });
  renameSync(tmp, f);
}

switch (cmd) {
  case "plan": {
    const name = suiteArg();
    const { suite: s, thirdParty, approval } = suiteFor(name, a2);
    const p = planOf(s, !thirdParty);
    out(`Suite ${name}: ${s.tasks.length} tasks${readSuite(dir, name) && !a2 ? " (fixed at its first run)" : " (as a first run would take them)"}${approval ? `; questions ${approval}` : ""}. No call is made by this plan.`);
    out("task | who | seat | model | setting | search | ceilings in the request | worst case");
    for (const l of p.lines) out(`${l.task} | ${l.who} | ${l.seat} | ${l.model || "-"} | ${l.setting || "-"} | ${l.search ? "yes" : "no"} | ${l.limits} | ${l.worst_usd === null ? "refused" : money(l.worst_usd)}${l.note ? ` | ${l.note}` : ""}`);
    if (p.originals) out(`plus ${p.originals} original seat answers from the record, graded with no new call`);
    const b = readBudget(dir);
    out(`Total worst case: ${money(p.total)} over ${p.lines.length} calls. Trials budget: ${money(Number.isFinite(b.spent_usd) ? committedOf(b) : NaN)} spent or reserved of ${money(budget())}.`);
    out("Worst case: steps x (the context ceiling at the input price + the output cap, thinking included, at the output price) + the most tool fees, at the dearest list price the model has (an unlisted model is priced high). Codex runs on the ChatGPT plan ($0, one run each). Before any spend the runner makes a near-free check of each model and tool type.");
    if (name === "research") out(thirdParty ? "Perplexity's levels may route to another lab's model: the owner approved that." : "Perplexity's levels are pinned to Perplexity's own model: routing to another lab's model needs the owner's approval first.");
    if (p.refused.length) out(`refused (no hard ceiling): ${p.refused.join(", ")}`);
    for (const n of s.skipped) out(`left out: ${n}`);
    break;
  }
  case "run": {
    const name = suiteArg();
    if (a2) fail("a run takes no file: the research questions come from the record, once the owner has approved them");
    if (name === "research" && !readSuite(dir, name)) {
      const a = readApproval(recordDir);
      if (!a.ok) fail(`the research suite can't run: ${(a as { why: string }).why}`);
    }
    const mode = flags.has("--new") ? "new" : flags.has("--retry") ? "retry" : undefined;
    leave({ kind: "run", suite: name, ...(mode ? { mode } : {}) }, `run-${name}`);
    const stopped = readStop().stopped;
    out(`left for the trials runner: run ${name}${mode === "new" ? " (a fresh run)" : ""}. It takes it within a minute${stopped ? "; everything is stopped now, so nothing is sent until Dane turns it back on" : ""}; a real review always goes first. trial.sh status shows it.`);
    break;
  }
  case "status": {
    const b = readBudget(dir);
    out(`Trials budget: ${money(b.spent_usd)} spent of ${money(budget())}${Object.keys(b.reservations ?? {}).length ? `; ${money(Object.values(b.reservations).reduce((a, r) => a + r.usd, 0))} reserved for calls out` : ""}${Object.keys(b.holds ?? {}).length ? `; ${money(Object.values(b.holds).reduce((a, h) => a + h.usd, 0))} held for grading` : ""}.`);
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
    fail("usage: trial.sh plan <review-seats|research> [questions.json] | run <suite> [--retry] [--new] | result <suite> | report <suite> | status");
}
