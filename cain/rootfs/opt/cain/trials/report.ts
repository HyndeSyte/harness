// trial.sh report: per configuration, from a suite's newest run. Labelled by the model that actually served
// each configuration (a pinned Perplexity level as "<model> at effort <level>"); each grader's scores beside
// the combined score (three graders, one per family; each output is graded by the two from outside its own
// family that the run could use, its panel); coverage and missing grades; headline comparisons on the matched
// set of tasks, ranked only among configurations the same panel scored, and the ranking across panels flagged;
// every attempt's cost (failed, retried and ungraded ones included) in the cost numerator, with estimates
// marked and unresolved billing (charged at its worst case for want of a bill) reported apart; Codex calls
// counted against the plan's call allowance, never as dollars; differences within the noise reported as no
// clear difference.
import { readFileSync } from "node:fs";
import {
  GRADERS, PERPLEXITY_OWN_MODEL, POINTS, configLabel, configsFor, differs, disagreements, familyOf, meanSe, seatOfConfig, type OutputGrade, type SuiteName,
} from "./core.ts";
import { latestRun, paths, readBudget, readSuite, writeAtomic } from "./runner.ts";

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const money = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const cell = (s: string) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const fmt = (x: { mean: number; se: number; n: number } | null, d = 2) => (x ? `${x.mean.toFixed(d)} (n ${x.n})` : "-");

type Row = {
  config: string; served: Set<string>; families: Set<string>; tasks: number; outputs: number; ms: number; calls: number;
  billed: number; estimated: number; reserved: number; planCalls: number; attempts: number;
  byGrader: Record<string, Map<string, OutputGrade>>;   // grader -> task -> grade
  combined: Map<string, number>;                         // task -> mean score of the graders that graded it
  points: Map<string, number>;                           // research: task -> mean rubric points
  acceptable: Map<string, boolean>;                      // research: task -> every grader said acceptable
  uniqueSerious: number; falseAlarms: Record<string, number>; findings: number; recallHit: number; recallOf: number;
};

export function buildReport(dir: string, suiteName: SuiteName, budget: number): string {
  const suite = readSuite(dir, suiteName);
  const st = latestRun(dir, suiteName);
  if (!suite || !st) return `# Model trial: ${suiteName}\n\nNo run yet.\n`;
  const p = paths(dir);
  const key = readJson<Record<string, Record<string, string>>>(p.key(st.suite, st.run), {});
  const graders: Record<string, Record<string, OutputGrade[]>> = {};   // task -> grader -> grades
  let gradeBilled = 0, gradeEst = 0, gradeRes = 0, gradePlan = 0;
  const graderServed: Record<string, Set<string>> = {};
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("grade|")) continue;
    const g = id.split("|")[2];
    const sp = spendOf(c);
    gradeBilled += sp.billed; gradeEst += sp.estimated; gradeRes += sp.unresolved; gradePlan += sp.plan_calls;
    if (c.status !== "done") continue;
    (graderServed[g] ??= new Set()).add(c.served ?? c.model ?? "");
    const gf = readJson<any>(p.grade(st.suite, st.run, id), null);
    if (gf?.grades) (graders[gf.task] ??= {})[gf.grader] = gf.grades;
  }
  const configOf = (call: string) => call.split("|")[2] ?? call;
  const rows = new Map<string, Row>();
  const row = (config: string) => {
    let r = rows.get(config);
    if (!r) { r = { config, served: new Set(), families: new Set(), tasks: suite.tasks.length, outputs: 0, ms: 0, calls: 0, billed: 0, estimated: 0, reserved: 0, planCalls: 0, attempts: 0,
      byGrader: {}, combined: new Map(), points: new Map(), acceptable: new Map(), uniqueSerious: 0, falseAlarms: {}, findings: 0, recallHit: 0, recallOf: 0 }; rows.set(config, r); }
    return r;
  };
  for (const c of configsFor(suiteName)) row(c.id);
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("out|")) continue;
    const r = row(configOf(id));
    // Every attempt counts: failed, retried and ungraded ones too.
    const sp = spendOf(c);
    r.billed += sp.billed; r.estimated += sp.estimated; r.reserved += sp.unresolved; r.planCalls += sp.plan_calls; r.attempts += c.attempts ?? 0;
    if (c.status === "done") {
      r.outputs++; r.ms += c.ms ?? 0; if (!configOf(id).startsWith("original:")) r.calls++;
      if (c.served) r.served.add(c.served);
      r.families.add(c.family ?? familyOf(seatOfConfig(configOf(id)), c.served ?? ""));
    }
  }
  let compared = 0, agreed = 0;
  const flagged: string[] = [];
  for (const [task, byGrader] of Object.entries(graders)) {
    const labels = key[task] ?? {};
    const t = suite.tasks.find((x) => x.id === task);
    const adoptedN = t && t.kind === "review" && t.adopted ? t.adopted.split(/\n+/).filter((l) => l.trim()).slice(0, 40).length : 0;
    for (const [label, call] of Object.entries(labels)) {
      const r = row(configOf(call));
      const mine = Object.entries(byGrader).map(([g, list]) => [g, list.find((x) => x.label === label)] as const).filter(([, x]) => !!x) as [string, OutputGrade][];
      if (!mine.length) continue;
      for (const [g, x] of mine) {
        (r.byGrader[g] ??= new Map()).set(task, x);
        if (suiteName === "review-seats") r.falseAlarms[g] = (r.falseAlarms[g] ?? 0) + (x.findings ?? []).filter((f) => !f.real || f.severity === "wrong").length;
      }
      r.combined.set(task, mine.reduce((a, [, x]) => a + x.score, 0) / mine.length);
      if (suiteName === "review-seats") {
        const out = readJson<any>(p.output(st.suite, st.run, call), null);
        const n = Array.isArray(out?.findings) ? out.findings.length : 0;
        r.findings += n;
        for (let i = 1; i <= n; i++) {
          const marks = mine.map(([, x]) => (x.findings ?? []).find((f) => f.n === i)).filter(Boolean);
          if (marks.length && marks.every((f: any) => f.real && f.severity === "serious" && f.also_found_by.length === 0)) r.uniqueSerious++;
        }
        // Recall of the owner's adopted notes: counted apart, never part of a score.
        if (adoptedN) { const covered = new Set(mine.flatMap(([, x]) => x.adopted_covered ?? [])); r.recallHit += covered.size; r.recallOf += adoptedN; }
      } else {
        r.points.set(task, mine.reduce((a, [, x]) => a + (x.outcome ? POINTS[x.outcome] : 0), 0) / mine.length);
        r.acceptable.set(task, mine.every(([, x]) => x.acceptable));
      }
      if (mine.length >= 2) {
        compared++;
        const d = disagreements(mine[0][1], mine[1][1]);
        if (d.length) flagged.push(`${task}, ${configOf(call)}: ${d.join("; ")}`); else agreed++;
      }
    }
  }
  const all = [...rows.values()];
  const pinned = !st.preflight?.third_party_routing ? PERPLEXITY_OWN_MODEL : "";
  const label = (r: Row) => {
    const c = configsFor(suiteName).find((x) => x.id === r.config);
    const name = c ? configLabel(c, pinned) : r.config;
    const served = [...r.served].filter((s) => s && !r.config.endsWith(s) && !r.config.includes(`:${s}`) && !name.startsWith(s));
    const third = [...r.families].filter((f) => r.config.startsWith("perplexity") && f !== "perplexity");
    return `${name}${served.length ? ` (served by ${served.slice(0, 3).join(", ")})` : ""}${third.length ? ` [another lab's model: ${third.join(", ")}]` : ""}`;
  };
  const ownFamily = (r: Row, g: string) => { const gf = GRADERS.find((x) => x.id === g)!.family; return r.families.has(gf); };
  // Panels: the graders that scored a configuration. Rankings are only among configurations one panel scored.
  const panelOf = (r: Row) => GRADERS.map((g) => g.id).filter((g) => (r.byGrader[g]?.size ?? 0) > 0).join("+") || "none";
  const metric = (r: Row) => (suiteName === "research" ? r.points : r.combined);
  const compareRows = all.filter((r) => metric(r).size > 0);
  const panels = [...new Set(compareRows.map(panelOf))];
  // The matched set, per panel: tasks every configuration that panel scored has a score for.
  const matchedOf = (panel: string) => { const rs = compareRows.filter((r) => panelOf(r) === panel); return suite.tasks.map((t) => t.id).filter((t) => rs.every((r) => metric(r).has(t))); };
  const matchedBy: Record<string, string[]> = Object.fromEntries(panels.map((p) => [p, matchedOf(p)]));
  const onMatched = (r: Row) => meanSe((matchedBy[panelOf(r)] ?? []).map((t) => metric(r).get(t)!).filter((x) => x !== undefined));
  const topOf = (panel: string) => compareRows.filter((r) => panelOf(r) === panel).map((r) => ({ r, m: onMatched(r) })).filter((x) => x.m).sort((a, b) => b.m!.mean - a.m!.mean)[0];
  const tops: Record<string, ReturnType<typeof topOf>> = Object.fromEntries(panels.map((p) => [p, topOf(p)]));
  const graderName = (g: string) => (g === "claude" ? "Claude" : g === "codex" ? "OpenAI" : "Google");
  const panelName = (p: string) => p.split("+").map(graderName).join(" and ");

  const b = readBudget(dir);
  const settled = Object.values(st.calls).filter((c) => c.status !== "interrupted" && c.status !== "held").length;
  const runCost = Object.values(st.calls).reduce((a, c) => a + (c.cost_usd ?? 0), 0);
  const pf = st.preflight;
  const lines: string[] = [
    `# Model trial: ${suiteName} (run ${st.run})`, "",
    `Status: ${st.status}${st.stop ? `, stopped: ${st.stop.detail}` : ""}. Tasks: ${suite.tasks.length}. Calls settled: ${settled}.`,
    `Trials budget: ${money(b.spent_usd)} spent of ${money(budget)} across every suite. This run: ${money(runCost)}; grading billed ${money(gradeBilled)}, estimated ${money(gradeEst)}; unresolved billing (charged at its worst case for want of a bill) in grading ${money(gradeRes)}.`,
    `Graders: Claude (${[...(graderServed.claude ?? new Set(["claude-opus-5-5"]))].join(", ")}), OpenAI (Codex: ${[...(graderServed.codex ?? new Set(["its default model"]))].join(", ")}) and Google (${[...(graderServed.gemini ?? new Set(["gemini-4-argon"]))].join(", ")}), blind; each output is graded by the two from outside its own family the run could use.${Object.keys(pf?.graders_off ?? {}).length ? ` Off this run: ${Object.values(pf!.graders_off!).join("; ")}.` : ""}`,
    `Codex installed: ${pf?.codex_version ?? "version not read"}; isolation: ${pf?.codex_isolation ? (pf.codex_isolation.ok ? `${pf.codex_isolation.mode} (${pf.codex_isolation.detail})` : `not isolated (${pf.codex_isolation.detail})`) : "not tested"}.`,
    `Codex calls count against the plan's call allowance, never as dollars: ${all.reduce((a, r) => a + r.planCalls, 0) + gradePlan} call${all.reduce((a, r) => a + r.planCalls, 0) + gradePlan === 1 ? "" : "s"} this run.`, "",
    `Headline comparisons rank only configurations scored by the same graders (a panel), each on its own matched set: the tasks every configuration of that panel answered and had graded. ${panels.map((p) => `${panelName(p)}: ${matchedBy[p].length} task${matchedBy[p].length === 1 ? "" : "s"}${tops[p] ? `, the top is ${label(tops[p]!.r)}` : ""}`).join("; ") || "No graded output yet"}. A gap within twice the combined standard error is reported as no clear difference.`,
    ...(panels.length > 1 ? ["", `Flagged: the panels differ (${panels.map(panelName).join("; ")}), so the combined scores across panels are not a like-for-like ranking; compare within a panel only.`] : []), "",
  ];
  const vsTop = (r: Row) => { const top = tops[panelOf(r)]; const m = onMatched(r); if (!top || !m) return "-"; if (r === top.r) return "top of its panel"; return differs(m, top.m!) ? "below the top" : "no clear difference"; };
  const graderCols = (r: Row) => GRADERS.map((g) => (ownFamily(r, g.id) && !r.byGrader[g.id]?.size ? "own family, not graded" : fmt(meanSe([...(r.byGrader[g.id]?.values() ?? [])].map((x) => x.score))))).join(" | ");
  const coverage = (r: Row) => `${r.outputs}/${r.tasks}; grades ${GRADERS.map((g) => `${g.id} ${r.byGrader[g.id]?.size ?? 0}`).join(", ")}; missing ${Math.max(0, r.outputs - r.combined.size)}`;
  const costs = (r: Row) => `billed ${money(r.billed)}, estimated ${money(r.estimated)}${r.planCalls ? `, Codex plan calls ${r.planCalls}` : ""}`;
  const unresolved = (r: Row) => (r.reserved ? money(r.reserved) : "-");
  if (suiteName === "review-seats") {
    lines.push("| Configuration | Panel | Coverage | Score, Claude | Score, OpenAI | Score, Google | Combined (all tasks) | Combined (matched) | Against the top | Unique serious | False alarms (Claude / OpenAI / Google) | Recall of adopted notes | Cost, every attempt | Unresolved billing | Time per call |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of all) lines.push(`| ${cell(label(r))} | ${panelName(panelOf(r))} | ${cell(coverage(r))} | ${graderCols(r)} | ${fmt(meanSe([...r.combined.values()]))} | ${fmt(onMatched(r))} | ${vsTop(r)} | ${r.uniqueSerious} | ${r.falseAlarms.claude ?? 0} / ${r.falseAlarms.codex ?? 0} / ${r.falseAlarms.gemini ?? 0} | ${r.recallOf ? `${r.recallHit} of ${r.recallOf}` : "-"} | ${cell(costs(r))} | ${unresolved(r)} | ${r.calls ? `${Math.round(r.ms / r.calls / 1000)} s` : "-"} |`);
    lines.push("", "Unique serious: findings no other output found that every grader who read it judged real and serious. Recall counts the owner's adopted notes an output also found; it is never part of a score. Originals are the answers the review seats gave at the time (no new call, no cost here).");
  } else {
    lines.push("| Configuration | Panel | Coverage | Score, Claude | Score, OpenAI | Score, Google | Rubric points (matched) | Against the top | Acceptable | Cost, every attempt | Unresolved billing | Cost per acceptable answer | Time per call |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of all) {
      const acc = [...r.acceptable.values()].filter(Boolean).length;
      const known = r.billed + r.estimated;
      const perAcc = !acc ? "-" : `${money(known / acc)} (${money(known)} over ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}, failed, retried and ungraded included, for ${acc} acceptable of ${r.acceptable.size} graded${r.estimated ? "; includes estimates" : ""}${r.reserved ? `; ${money(r.reserved)} unresolved billing not in it` : ""})`;
      lines.push(`| ${cell(label(r))} | ${panelName(panelOf(r))} | ${cell(coverage(r))} | ${graderCols(r)} | ${fmt(onMatched(r))} | ${vsTop(r)} | ${acc} of ${r.acceptable.size} graded | ${cell(costs(r))} | ${unresolved(r)} | ${cell(perAcc)} | ${r.calls ? `${Math.round(r.ms / r.calls / 1000)} s` : "-"} |`);
    }
    lines.push("", `Rubric points: correct ${POINTS.correct}, partial ${POINTS.partial}, a right "no reliable answer" ${POINTS.right_abstention}, a wrong one ${POINTS.wrong_abstention}, wrong but hedged ${POINTS.hedged_wrong}, confidently wrong ${POINTS.confident_wrong}. Acceptable: every grader who read it said the owner could act on it as it is. The cost per acceptable answer counts every attempt of the configuration (failed, retried and ungraded ones too), billed and estimated; unresolved billing (charged at its worst case for want of a bill) is reported apart and left out of it.`);
  }
  lines.push("", `## Graders' agreement`, "", compared ? `${agreed} of ${compared} outputs graded by both within one rubric step (${Math.round((agreed / compared) * 100)}%).` : "No output graded by both yet (own-family outputs go to one grader only).");
  if (flagged.length) lines.push("", "Flagged (more than one step apart):", ...flagged.slice(0, 60).map((f) => `- ${cell(f)}`), ...(flagged.length > 60 ? [`- (${flagged.length - 60} more in the grades files)`] : []));
  const skipped = Object.entries(st.calls).filter(([, c]) => ["skipped", "blocked", "failed", "held", "interrupted"].includes(c.status) && (c.status !== "failed" || c.final))
    .map(([id, c]) => `- ${cell(id.replace(/^out\||^grade\||^pre\|/, ""))}: ${c.status}, ${cell(c.error ?? "")}`);
  const pfSkips = Object.entries(pf?.skip ?? {}).map(([c, why]) => `- ${cell(c)}: ${cell(why)}`);
  const taskNotes = suite.tasks.flatMap((t) => (t.kind === "review" ? (t.notes ?? []).map((n) => `- ${cell(t.id)}: ${cell(n)}`) : []));
  lines.push("", "## Skipped, and why", "", ...st.notes.map((n) => `- ${cell(n)}`), ...pfSkips, ...taskNotes, ...skipped,
    ...(!st.notes.length && !skipped.length && !pfSkips.length && !taskNotes.length ? ["Nothing."] : []));
  if (st.stops.length) lines.push("", "## Stops", "", ...st.stops.map((s) => `- ${s.at.slice(0, 16).replace("T", " ")} UTC, ${s.reason}: ${cell(s.detail)}`));
  return lines.join("\n") + "\n";
}

// An attempt's costs, by how they are known (older records: the call's total under its last label).
export function spendOf(c: { spend?: { billed: number; estimated: number; unresolved: number; plan_calls: number }; cost_usd?: number; how?: string }) {
  if (c.spend) return c.spend;
  const usd = c.cost_usd ?? 0;
  return { billed: c.how === "billed" ? usd : 0, estimated: c.how === "estimated" ? usd : 0, unresolved: c.how === "billed" || c.how === "estimated" || c.how === "plan call" ? 0 : usd, plan_calls: c.how === "plan call" ? 1 : 0 };
}

export function writeReport(dir: string, suite: SuiteName, budget: number): string {
  const text = buildReport(dir, suite, budget);
  writeAtomic(paths(dir).report(suite), text);
  return text;
}
