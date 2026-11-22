// trial.sh: Cain's way to run a model trial and read it back. It runs as Cain's user: it reads the record
// and /data/trials, and leaves requests in /data/trials-inbox for the trials runner (runner.ts, in the
// review runner's process, which holds the keys). It never calls a model. A request carries a suite and the
// command only: the budget is the App's option, the configurations and run ids are the runner's.
//   plan <suite> [questions.json]          every call the suite would make, its ceilings, its worst-case cost,
//                                          the total (research: the record's questions, or a file to preview)
//   preflight                              the checks before any spend for every configuration, with no owner
//                                          text, under a cap of a few dollars; no paid suite runs on a build
//                                          until its record exists for this build on this machine
//   run <suite> [--retry] [--new]          start the suite, or resume its newest run (--new: a fresh run;
//                                          --retry: try again calls that failed for good). It starts only while
//                                          the owner's run allowance (an App option) covers its cap
//   status                                 each suite's newest run, and the trials budget
//   result <suite>                         the newest run's state: every call, its cost, tokens and time
//   report <suite>                         the report (the runner also writes it to /data/trials/<suite>/report.md)
// Suites: review-seats (tasks from the record's past reviews), research (Cain's 30 questions in the record
// at projects/harness/trials/research-questions.json, run only once the owner has entered their three hashes,
// which `plan research` prints, in the App's options in Home Assistant; trial.sh can't read those options, so
// it shows what the runner found there, from /data/trials/settings.json).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStop } from "../stop.ts";
import { DEFAULT_BUDGET_USD, LEDGER_MARGIN_PCT, checkQuestions, isSuite, ledgerCap, pickReviewTasks, planOf, researchPrivacy, type ResearchTask, type Suite, type SuiteName } from "./core.ts";
import { PREFLIGHT_CAP_USD, RESEARCH_QUESTIONS, buildId, latestRun, machineId, preflightError, readBudget, readPreflight, readSuite, researchHashes, reviewDirs } from "./runner.ts";
import { committedOf, grantedOf } from "./ledger.ts";
import { buildReport } from "./report.ts";

const env = process.env;
const dir = env.TRIALS_DIR ?? "/data/trials";
const inbox = env.TRIALS_INBOX ?? "/data/trials-inbox";
const recordDir = env.RECORD_DIR ?? "/data/record";
const termsFile = env.REVIEW_TERMS ?? "/data/review-private-terms.txt";
const terms = (): string | null => { try { return readFileSync(termsFile, "utf8"); } catch { return null; } };
const out = (s: string) => console.log(s);
const fail = (s: string, code = 2): never => { console.error(s); process.exit(code); };
// The budget the runner really uses, as it wrote it (root's file), never this process's environment.
const settings = (): any => { try { return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); } catch { return {}; } };
const budget = (): number => { const j = settings(); return Number.isFinite(j?.budget_usd) ? j.budget_usd : DEFAULT_BUDGET_USD; };
// What the runner found in the App's options when it started (the App restarts when they change).
const approvalSeen = (): { ok: boolean; why: string; third: boolean } => {
  const a = settings()?.research_approval;
  return a && typeof a === "object" ? { ok: a.ok === true, why: String(a.why ?? ""), third: a.third_party === true } : { ok: false, why: "the runner hasn't said yet", third: false };
};
const money = (n: number) => `$${n.toFixed(2)}`;
// This build and machine as the runner itself reported them (it computes them as root, from its own files), or
// as this process computes them when the runner hasn't said yet. The runner checks the preflight record again.
const runnerBuild = (): string => { const b = settings()?.build; return typeof b === "string" && b ? b : buildId(); };
const runnerMachine = (): string => { const m = settings()?.machine; return typeof m === "string" && m ? m : machineId(); };
// The owner's run allowance as the runner last read it from the App's options (trial.sh can't read them).
const allowanceSeen = (): number | null => { const a = settings()?.run_allowance_usd; return typeof a === "number" && Number.isFinite(a) ? a : null; };

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [cmd, a1, a2] = args.filter((a) => !a.startsWith("--"));

function suiteArg(): SuiteName { if (!isSuite(a1)) fail("name a suite: review-seats or research"); return a1 as SuiteName; }
// The suite as it is frozen, or as a first run would build it.
function suiteFor(name: SuiteName, file?: string): { suite: Suite; thirdParty: boolean; approval: string } {
  const frozen = readSuite(dir, name);
  const a = name === "research" ? approvalSeen() : null;
  const approval = !a ? "" : a.ok ? "approved by the owner in the App's options" : `NOT approved: ${a.why}`;
  const thirdParty = !!(a && a.ok && a.third);
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
  // The plan step refuses questions or answer notes that match the review service's private-terms list.
  const bad = researchPrivacy(q.tasks as ResearchTask[], terms());
  if (bad.length) fail(`refused: these research questions or their answer notes match the private-terms list (${termsFile}), so no plan is shown and nothing can run: ${bad.map((b) => `${b.id} (${b.why.join("; ")})`).join(", ")}. Fix them, then have the owner approve the new hashes.`);
  return { suite: { format: 2, name, created_at: now, tasks: q.tasks!, skipped: [] }, thirdParty, approval: file ? "a preview of a file, not the record's approved questions" : approval };
}
function leave(req: { kind: string; suite?: string; mode?: string }, name: string) {
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
    out(`Worst case: steps x (the context ceiling at the input price + the output cap, and a thinking allowance where it isn't covered, at the output price) + the most tool fees, at the dearest list price the model has (an unlisted model is priced high; Perplexity's fast level at the priority rate; Gemini grounding at a conservative allowance of queries). It is a soft bound: search results, Gemini's thinking level and grounding's query count have no provider cap. The ledger stops at ${money(ledgerCap(budget()))}, a fixed ${LEDGER_MARGIN_PCT}% below the budget. The hard stop is a prepaid balance or workspace limit on the API keys in the App's options. Codex runs on the ChatGPT plan: no dollars, each call counted against its trial allowance, and only under bubblewrap once its self-test passed.`);
    const al = allowanceSeen(), cap = Math.min(ledgerCap(budget()), p.total + PREFLIGHT_CAP_USD);
    out(`A run of this suite takes ${money(cap)} of the owner's run allowance (its worst case plus its checks, at most the ledger's cap); the allowance ${al === null ? "isn't known yet (the runner hasn't said)" : `is ${money(al)}, ${money(grantedOf(readBudget(dir)) || 0)} granted so far`}.`);
    const pfe = preflightError(readPreflight(dir), runnerBuild(), runnerMachine());
    if (pfe) out(`Before any run: ${pfe}.`);
    if (name === "research") {
      out(thirdParty ? "Perplexity's levels may route to another lab's model: the owner approved that." : "Perplexity's levels are pinned to Perplexity's own model: routing to another lab's model needs the owner's approval first.");
      const h = researchHashes(recordDir);
      if (h.hashes && !a2) out(`For the owner's approval, in the App's options in Home Assistant: trials_research_questions_sha256 ${h.hashes.questions}, trials_research_notes_sha256 ${h.hashes.notes}, trials_research_rubric_sha256 ${h.hashes.rubric} (and trials_perplexity_third_party_routing only if he says so).`);
    }
    if (p.refused.length) out(`refused (no hard ceiling): ${p.refused.join(", ")}`);
    for (const n of s.skipped) out(`left out: ${n}`);
    break;
  }
  case "preflight": {
    if (a1) fail("trial.sh preflight takes nothing more");
    const cur = readPreflight(dir);
    if (cur?.status === "running") fail("the preflight is already running: trial.sh status shows it");
    leave({ kind: "preflight" }, "preflight");
    out(`left for the trials runner: the preflight, the checks before any spend for every configuration (no owner text), under a cap of ${money(PREFLIGHT_CAP_USD)} from the owner's run allowance. It takes it within a minute; trial.sh status shows how it went.`);
    break;
  }
  case "run": {
    const name = suiteArg();
    if (a2) fail("a run takes no file: the research questions come from the record, once the owner has approved them");
    // No paid suite runs until the preflight's record exists for this build on this machine (the runner checks again).
    const pfe = preflightError(readPreflight(dir), runnerBuild(), runnerMachine());
    if (pfe) fail(`the ${name} suite can't run: ${pfe}`);
    if (name === "research") {
      const a = approvalSeen();
      if (!a.ok) fail(`the research suite can't run: ${a.why}`);
    }
    const mode = flags.has("--new") ? "new" : flags.has("--retry") ? "retry" : undefined;
    leave({ kind: "run", suite: name, ...(mode ? { mode } : {}) }, `run-${name}`);
    const stopped = readStop().stopped;
    out(`left for the trials runner: run ${name}${mode === "new" ? " (a fresh run)" : ""}. It takes it within a minute${stopped ? "; everything is stopped now, so nothing is sent until Dane turns it back on" : ""}; a real review always goes first. trial.sh status shows it.`);
    break;
  }
  case "status": {
    const b = readBudget(dir);
    const pr = readPreflight(dir), pfe = preflightError(pr, runnerBuild(), runnerMachine());
    out(`Preflight: ${pfe ? pfe : `done on this build${Object.keys(pr!.disabled).length ? `; disabled: ${Object.entries(pr!.disabled).map(([c, w]) => `${c} (${w})`).join("; ")}` : "; nothing disabled"}`}.`);
    const al = allowanceSeen();
    out(`Owner's run allowance: ${al === null ? "not known yet" : money(al)}; granted to runs so far: ${money(grantedOf(b) || 0)}.`);
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
    fail("usage: trial.sh plan <review-seats|research> [questions.json] | preflight | run <suite> [--retry] [--new] | result <suite> | report <suite> | status");
}
