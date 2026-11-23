// What his trial card shows, computed by the link itself (Cain 0.19.0, sixth round). The link (root) reads the suite file
// (or, before a suite's first run, the record it would be built from: the past reviews, or the research questions and
// their notes), the App's options (the budget, the research approval, third-party routing, the run allowance) and the
// newest run, and computes the plan hash the same way the runner does (core.ts planHash, from the same functions). The
// card renders the suite, whether it is a preflight, a start or a resume, the cap, the worst case, each provider called
// and, for research, the full "Sent to third-party search" list; his Allow tap signs the hash computed here. A keeper.sh
// trial-approve whose carried hash differs is refused.
import { DEFAULT_BUDGET_USD, isSuite, planHash, planOf, preflightCap, preflightPlanHash, researchDisclosure, researchPrivacy, runCap, pickReviewTasks,
  type ResearchTask, type Suite, type SuiteName } from "./core.ts";
import { checkReviewTask, latestRun, readApproval, readOptions, readSuite, reviewDirs } from "./runner.ts";
import { tallyGranted } from "./ledger.ts";
import type { TrialAction, TrialTarget } from "../trial-token.ts";

export type PlanView = {
  target: TrialTarget; action: TrialAction; plan: string; cap: number; worst: number; calls: number;
  providers: string[]; disclosure: string | null; granted: number | null; allowance: number; budget: number; tasks: number;
};
const PROVIDER: Record<string, string> = { claude: "Anthropic (Claude)", gemini: "Google (Gemini)", perplexity: "Perplexity", codex: "OpenAI (Codex, on the ChatGPT plan)" };
export const PREFLIGHT_PROVIDERS = [PROVIDER.gemini, PROVIDER.claude, PROVIDER.perplexity, PROVIDER.codex];

export function planView(o: { dir: string; recordDir: string; terms: string | null; optionsFile: string; optionsUid: number; target: string; fresh?: boolean }): PlanView | { error: string } {
  const opt = readOptions(o.optionsFile, o.optionsUid);
  if (!opt.ok) return { error: `${(opt as { why: string }).why}, so the link can't compute the plan` };
  const oo = (opt as { o: any }).o;
  const budget = Number.isFinite(oo.budgetUsd) ? oo.budgetUsd : DEFAULT_BUDGET_USD;
  const granted = tallyGranted(o.dir);
  if (o.target === "preflight") {
    const cap = preflightCap(budget);
    return { target: "preflight", action: "preflight", plan: preflightPlanHash(cap), cap, worst: cap, calls: 0, providers: PREFLIGHT_PROVIDERS, disclosure: null, granted, allowance: oo.allowanceUsd, budget, tasks: 0 };
  }
  if (!isSuite(o.target)) return { error: "suite must be review-seats, research or preflight" };
  const name = o.target as SuiteName;
  let s: Suite | null = readSuite(o.dir, name);
  const approval = name === "research" ? readApproval(o.recordDir, o.optionsFile, o.optionsUid) : null;
  if (name === "research") {
    if (!approval!.ok) return { error: `the research suite can't run: ${(approval as { why: string }).why}` };
    if (s && s.questions_sha256 !== (approval as { sha: string }).sha) return { error: "the research suite was frozen from other questions than the ones the owner approved" };
  }
  if (!s) {
    if (name === "review-seats") {
      const { tasks } = pickReviewTasks(reviewDirs(o.recordDir));
      if (!tasks.length) return { error: "no past review in the record has brief.txt, result.json and adopted.md" };
      for (const t of tasks) checkReviewTask(t, o.terms);
      s = { format: 2, name, created_at: "", tasks, skipped: [] };
    } else {
      const tasks = (approval as { tasks: ResearchTask[] }).tasks;
      const bad = researchPrivacy(tasks, o.terms);
      if (bad.length) return { error: `research questions match the private-terms list (${bad.map((b) => b.id).join(", ")})` };
      s = { format: 2, name, created_at: "", tasks, skipped: [], questions_sha256: (approval as { sha: string }).sha };
    }
  }
  const last = latestRun(o.dir, name);
  const resuming = !!(last && last.status !== "done" && !o.fresh);
  if (!resuming && last?.status === "running") return { error: "its newest run is still running; a new one can't start beside it" };
  const pinned = resuming ? !last!.preflight?.third_party_routing : !(name === "research" && approval?.ok && approval.third_party);
  const p = planOf(s, pinned);
  const cap = runCap(budget, p.total);
  const seats = [...new Set(p.lines.map((l) => l.seat).filter((x) => x !== "original"))];
  return {
    target: name, action: resuming ? "resume" : "start", plan: planHash(s, pinned, cap), cap, worst: Number(p.total.toFixed(2)), calls: p.lines.length,
    providers: seats.map((x) => PROVIDER[x] ?? x), disclosure: name === "research" ? researchDisclosure(s.tasks as ResearchTask[]) : null,
    granted, allowance: oo.allowanceUsd, budget, tasks: s.tasks.length,
  };
}
