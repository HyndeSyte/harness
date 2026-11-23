// trial.sh: Cain's way to run a model trial and read it back. It runs as Cain's user: it reads the record
// and /data/trials, and leaves requests in /data/trials-inbox for the trials runner (runner.ts, in the
// review runner's process, which holds the keys). It never calls a model. A request carries a suite and the
// command only: the budget is the App's option, the configurations and run ids are the runner's.
//   plan <suite> [questions.json]          every call the suite would make, its ceilings, its worst-case cost,
//                                          the total, the run's cap and its plan hash (research: the record's
//                                          questions, or a file to preview, and what is sent to third-party search)
//   plan preflight                         the preflight's plan hash and cap
//   preflight --approval <token>           the checks before any spend for every configuration, with no owner
//                                          text, under a cap of a few dollars; no paid suite runs until its record
//                                          exists under the same key (code, Codex, models, options), under 7 days old
//   run <suite> --approval <token> [--retry] [--new]
//                                          start the suite, or resume its newest run (--new: a fresh run;
//                                          --retry: try again calls that failed for good). Fifth round: only with
//                                          the owner's one-time approval from his tap on Cain's trial card
//                                          (keeper.sh trial-approve --plan <hash> --cap <usd>), for that exact plan
//                                          and cap, and only while his run allowance (an App option) covers it
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
import { DEFAULT_BUDGET_USD, LEDGER_MARGIN_PCT, PREFLIGHT_CAP_USD, checkQuestions, isSuite, ledgerCap, pickReviewTasks, planHash, planOf, preflightCap, preflightPlanHash, researchDisclosure, researchPrivacy, runCap, type ResearchTask, type Suite, type SuiteName } from "./core.ts";
import { GO_LINES, RESEARCH_QUESTIONS, checkReviewTask, latestRun, preflightError, readBudget, readPreflight, readSuite, researchHashes, reviewDirs, supervisorTokenSeen, type PreflightKey } from "./runner.ts";
import { committedOf, tallyGranted } from "./ledger.ts";
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
// The preflight's key as the runner itself reported it (it computes it as root: the code, the machine, the installed
// Codex, the configured models, the trials options), or null when it hasn't said yet. The runner checks again.
const runnerKey = (): PreflightKey | null => { const k = settings()?.preflight_key; return k && typeof k === "object" && typeof k.code === "string" ? k : null; };
const pfError = () => preflightError(readPreflight(dir), runnerKey(), Date.now());
// What the runner said of the trial keys (fifth round): each provider whose trial key isn't right.
const keysSeen = (): string[] | null => { const k = settings()?.trial_keys; return Array.isArray(k) ? k.map(String) : null; };
// The owner's run allowance as the runner last read it from the App's options (trial.sh can't read them).
const allowanceSeen = (): number | null => { const a = settings()?.run_allowance_usd; return typeof a === "number" && Number.isFinite(a) ? a : null; };

const argv = process.argv.slice(2);
// --approval <token>: the owner's one-time approval, relayed to Cain on his tap.
let approval: string | undefined;
const args: string[] = [];
for (let i = 0; i < argv.length; i++) { if (argv[i] === "--approval") { approval = argv[++i] ?? ""; continue; } args.push(argv[i]); }
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [cmd, a1, a2] = args.filter((a) => !a.startsWith("--"));
const APPROVAL = /^trial1\.[A-Za-z0-9_-]{20,800}\.[A-Za-z0-9_-]{86}$/;
// The paid starts: an approval of the right shape, and no SUPERVISOR_TOKEN in this session's environment.
function paidChecks(what: string) {
  if (supervisorTokenSeen()) fail(`${what} can't start: SUPERVISOR_TOKEN is in this session's environment, so nothing paid is asked for until the App starts the session without it`);
  if (!approval) fail(`${what} needs the owner's one-time approval: run trial.sh plan, ask him with keeper.sh trial-approve --plan <hash> --cap <usd>, and pass the approval his tap gives with --approval`);
  if (!APPROVAL.test(approval)) fail("--approval takes the trial approval exactly as it was relayed (trial1.<...>.<...>)");
}

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
    // As the runner freezes them (the private terms checked now), so the plan hash is the one it computes.
    for (const t of tasks) checkReviewTask(t, terms());
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
function leave(req: { kind: string; suite?: string; mode?: string; approval?: string }, name: string) {
  mkdirSync(inbox, { recursive: true });
  const f = join(inbox, `${Date.now()}-${name}.json`);
  const tmp = join(inbox, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(req), { mode: 0o640 });
  renameSync(tmp, f);
}

switch (cmd) {
  case "plan": {
    if (a1 === "preflight") {
      const cap = preflightCap(budget());
      out(`The preflight: one tiny check of every configuration of both suites and of each grader, with no owner text, Perplexity pinned to its own model. Its cap: ${money(cap)}.`);
      out(`Plan hash: ${preflightPlanHash(cap)}`);
      out(`For his go: keeper.sh trial-approve --suite preflight --plan ${preflightPlanHash(cap)} --cap ${cap.toFixed(2)} "<what it checks, in one line>"`);
      break;
    }
    const name = suiteArg();
    const { suite: s, thirdParty: routed, approval } = suiteFor(name, a2);
    // A start or a resume, as the runner (and the link's card) will judge it: a stopped run resumes unless --new.
    const last = latestRun(dir, name);
    const resuming = !a2 && !!(last && last.status !== "done" && !flags.has("--new"));
    const thirdParty = resuming ? !!last!.preflight?.third_party_routing : routed;
    const p = planOf(s, !thirdParty);
    out(`Suite ${name}: ${s.tasks.length} tasks${readSuite(dir, name) && !a2 ? " (fixed at its first run)" : " (as a first run would take them)"}${approval ? `; questions ${approval}` : ""}. No call is made by this plan.`);
    out("task | who | seat | model | setting | search | ceilings in the request | worst case");
    for (const l of p.lines) out(`${l.task} | ${l.who} | ${l.seat} | ${l.model || "-"} | ${l.setting || "-"} | ${l.search ? "yes" : "no"} | ${l.limits} | ${l.worst_usd === null ? "refused" : money(l.worst_usd)}${l.note ? ` | ${l.note}` : ""}`);
    if (p.originals) out(`plus ${p.originals} original seat answers from the record, graded with no new call`);
    const b = readBudget(dir);
    out(`Total worst case: ${money(p.total)} over ${p.lines.length} calls. Trials budget: ${money(Number.isFinite(b.spent_usd) ? committedOf(b) : NaN)} spent or reserved of ${money(budget())}.`);
    out(`Worst case: steps x (the context ceiling at the input price + the output cap, and a thinking allowance where it isn't covered, at the output price) + the most tool fees, at the dearest list price the model has (an unlisted model is priced high; Perplexity's fast level at the priority rate; Gemini grounding at a conservative allowance of queries). Search results, Gemini's thinking level and grounding's query count have no provider cap, so a call can pass its own reservation. The bound is this run's cap, enforced before every dispatch: each call's worst case is reserved first, a call whose usage is missing or unresolved stays charged at its reservation, and the ledger stops at ${money(ledgerCap(budget()))}, a fixed ${LEDGER_MARGIN_PCT}% below the budget. Provider spend limits on the trials' own keys are only a backstop: they are monthly, enforced late, and can be exceeded. Codex runs on a ChatGPT sign-in of its own: no dollars, each call counted against its trial allowance, and only under bubblewrap once its go/no-go lines passed.`);
    const al = allowanceSeen(), cap = runCap(budget(), p.total), granted = tallyGranted(dir);
    out(`A run of this suite takes ${money(cap)} of the owner's run allowance (its worst case plus its checks, at most the ledger's cap); the allowance ${al === null ? "isn't known yet (the runner hasn't said)" : `is ${money(al)}, ${granted === null ? "with its tally missing or unreadable (counts as fully spent)" : `${money(granted)} granted so far`}`}.`);
    if (name === "research" && !a2) { out(""); out(researchDisclosure(s.tasks as ResearchTask[])); out(""); }
    const hash = planHash(s, !thirdParty, cap);
    out(`Plan hash: ${hash}`);
    out(`Cap: ${cap.toFixed(2)}`);
    if (!a2) {
      out(`This would be ${resuming ? `a resume of run ${last!.run}` : "a new run"}${!resuming && last && last.status !== "done" ? " (--new)" : ""}${resuming ? "; trial.sh plan --new shows a new run instead" : ""}.`);
      out(`For his go: keeper.sh trial-approve --suite ${name} --plan ${hash} --cap ${cap.toFixed(2)}${flags.has("--new") ? " --new" : ""} "<what it tests, in one line>". The link computes the plan itself and puts it on his card; his tap allows one ${resuming ? "resume" : "run"} of exactly this plan${name === "research" ? ", including what is sent to third-party search above" : ""}, for 2 hours.`);
    }
    const pfe = pfError();
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
    if (a1) fail("trial.sh preflight takes only --approval <token>");
    paidChecks("the preflight");
    const cur = readPreflight(dir);
    if (cur?.status === "running") fail("the preflight is already running: trial.sh status shows it");
    leave({ kind: "preflight", approval }, "preflight");
    out(`left for the trials runner: the preflight, the checks before any spend for every configuration (no owner text), under a cap of ${money(preflightCap(budget()))} from the owner's run allowance, on his approval (spent once the runner takes it). It takes it within a minute; trial.sh status shows how it went.`);
    break;
  }
  case "run": {
    const name = suiteArg();
    if (a2) fail("a run takes no file: the research questions come from the record, once the owner has approved them");
    // No paid suite runs until the preflight's record stands under the same key (the runner checks again).
    const pfe = pfError();
    if (pfe) fail(`the ${name} suite can't run: ${pfe}`);
    if (name === "research") {
      const a = approvalSeen();
      if (!a.ok) fail(`the research suite can't run: ${a.why}`);
    }
    paidChecks(`the ${name} suite`);
    const mode = flags.has("--new") ? "new" : flags.has("--retry") ? "retry" : undefined;
    leave({ kind: "run", suite: name, ...(mode ? { mode } : {}), approval }, `run-${name}`);
    const stopped = readStop().stopped;
    out(`left for the trials runner: run ${name}${mode === "new" ? " (a fresh run)" : ""}. It takes it within a minute${stopped ? "; everything is stopped now, so nothing is sent until Dane turns it back on" : ""}; a real review always goes first. trial.sh status shows it.`);
    break;
  }
  case "status": {
    const b = readBudget(dir);
    const pr = readPreflight(dir), pfe = pfError();
    out(`Preflight: ${pfe ? pfe : `done under this key${Object.keys(pr!.disabled).length ? `; disabled: ${Object.entries(pr!.disabled).map(([c, w]) => `${c} (${w})`).join("; ")}` : "; nothing disabled"}`}.`);
    // Sixth round: its named go/no-go lines, the installed Codex and what is known of key separation.
    if (pr?.golines) {
      for (const [k, name] of Object.entries(GO_LINES)) { const g = (pr.golines as any)[k]; out(`  ${g ? g.status.toUpperCase() : "NOT CHECKED"}: ${name}${g ? ` (${g.detail})` : ""}`); }
      out(`  Codex installed: ${pr.codex_version ?? "unknown"}. Key separation: ${pr.key_separation ?? "unverified beyond the string check"}.`);
    }
    const ks = keysSeen();
    out(`Trial keys: ${ks === null ? "not known yet (the runner hasn't said)" : ks.length ? `refused: ${ks.join("; ")}` : "each provider has its own"}.`);
    const al = allowanceSeen(), granted = tallyGranted(dir);
    out(`Owner's run allowance: ${al === null ? "not known yet" : money(al)}; granted to runs so far: ${granted === null ? "the tally is missing or unreadable, so it counts as fully spent" : money(granted)}.`);
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
    fail("usage: trial.sh plan <review-seats|research|preflight> [questions.json] | preflight --approval <token> | run <suite> --approval <token> [--retry] [--new] | result <suite> | report <suite> | status");
}
