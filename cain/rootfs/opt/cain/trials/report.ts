// trial.sh report: per configuration, from a suite's newest run. Labelled by the model that actually served
// each configuration; each grader's scores beside the combined score (a grader never grades its own
// family's outputs, so a combined score is only ever from other families); coverage and missing grades;
// headline comparisons on the matched set of tasks every compared configuration answered and had graded;
// every cost marked billed or estimated, and a cost per acceptable answer only from billed costs, with its
// denominators; differences within the noise reported as no clear difference.
import { readFileSync } from "node:fs";
import {
  GRADERS, POINTS, configsFor, differs, disagreements, familyOf, meanSe, seatOfConfig, type OutputGrade, type SuiteName,
} from "./core.ts";
import { latestRun, paths, readBudget, readSuite, writeAtomic } from "./runner.ts";

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const money = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const cell = (s: string) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const fmt = (x: { mean: number; se: number; n: number } | null, d = 2) => (x ? `${x.mean.toFixed(d)} (n ${x.n})` : "-");

type Row = {
  config: string; served: Set<string>; families: Set<string>; tasks: number; outputs: number; ms: number; calls: number;
  billed: number; estimated: number; reserved: number;
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
  let gradeBilled = 0, gradeEst = 0, gradeRes = 0;
  const graderServed: Record<string, Set<string>> = {};
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("grade|")) continue;
    const g = id.split("|")[2];
    if (c.how === "billed") gradeBilled += c.cost_usd ?? 0; else if (c.how === "estimated") gradeEst += c.cost_usd ?? 0; else gradeRes += c.cost_usd ?? 0;
    if (c.status !== "done") continue;
    (graderServed[g] ??= new Set()).add(c.served ?? c.model ?? "");
    const gf = readJson<any>(p.grade(st.suite, st.run, id), null);
    if (gf?.grades) (graders[gf.task] ??= {})[gf.grader] = gf.grades;
  }
  const configOf = (call: string) => call.split("|")[2] ?? call;
  const rows = new Map<string, Row>();
  const row = (config: string) => {
    let r = rows.get(config);
    if (!r) { r = { config, served: new Set(), families: new Set(), tasks: suite.tasks.length, outputs: 0, ms: 0, calls: 0, billed: 0, estimated: 0, reserved: 0,
      byGrader: {}, combined: new Map(), points: new Map(), acceptable: new Map(), uniqueSerious: 0, falseAlarms: {}, findings: 0, recallHit: 0, recallOf: 0 }; rows.set(config, r); }
    return r;
  };
  for (const c of configsFor(suiteName)) row(c.id);
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("out|")) continue;
    const r = row(configOf(id));
    if (c.how === "billed") r.billed += c.cost_usd ?? 0; else if (c.how === "estimated") r.estimated += c.cost_usd ?? 0; else r.reserved += c.cost_usd ?? 0;
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
  const label = (r: Row) => {
    const served = [...r.served].filter((s) => s && !r.config.endsWith(s) && !r.config.includes(`:${s}`));
    const third = [...r.families].filter((f) => r.config.startsWith("perplexity") && f !== "perplexity");
    return `${r.config}${served.length ? ` (served by ${served.slice(0, 3).join(", ")})` : ""}${third.length ? ` [another lab's model: ${third.join(", ")}]` : ""}`;
  };
  const ownFamily = (r: Row, g: string) => { const gf = GRADERS.find((x) => x.id === g)!.family; return r.families.has(gf); };
  // The matched set: tasks every compared configuration (one with any graded output) has a combined score for.
  const metric = (r: Row) => (suiteName === "research" ? r.points : r.combined);
  const compareRows = all.filter((r) => metric(r).size > 0);
  const matched = suite.tasks.map((t) => t.id).filter((t) => compareRows.every((r) => metric(r).has(t)));
  const onMatched = (r: Row) => meanSe(matched.map((t) => metric(r).get(t)!).filter((x) => x !== undefined));
  const top = compareRows.map((r) => ({ r, m: onMatched(r) })).filter((x) => x.m).sort((a, b) => b.m!.mean - a.m!.mean)[0];

  const b = readBudget(dir);
  const settled = Object.values(st.calls).filter((c) => c.status !== "interrupted" && c.status !== "held").length;
  const runCost = Object.values(st.calls).reduce((a, c) => a + (c.cost_usd ?? 0), 0);
  const pf = st.preflight;
  const lines: string[] = [
    `# Model trial: ${suiteName} (run ${st.run})`, "",
    `Status: ${st.status}${st.stop ? `, stopped: ${st.stop.detail}` : ""}. Tasks: ${suite.tasks.length}. Calls settled: ${settled}.`,
    `Trials budget: ${money(b.spent_usd)} spent of ${money(budget)} across every suite. This run: ${money(runCost)}; grading billed ${money(gradeBilled)}, estimated ${money(gradeEst)}, held at its worst case for want of a bill ${money(gradeRes)}.`,
    `Graders: Claude (${[...(graderServed.claude ?? new Set(["claude-opus-5-5"]))].join(", ")}) and OpenAI (Codex: ${[...(graderServed.codex ?? new Set(["its default model"]))].join(", ")}), blind; neither grades an output its own family served.`,
    `Codex installed: ${pf?.codex_version ?? "version not read"}.`, "",
    `Headline comparisons use the matched set: the ${matched.length} task${matched.length === 1 ? "" : "s"} every compared configuration answered and had graded${top ? `; the top is ${top.r.config}` : ""}. A gap within twice the combined standard error is reported as no clear difference.`, "",
  ];
  const vsTop = (r: Row) => { const m = onMatched(r); if (!top || !m || r === top.r) return r === top?.r ? "top" : "-"; return differs(m, top.m!) ? "below the top" : "no clear difference"; };
  const graderCols = (r: Row) => GRADERS.map((g) => (ownFamily(r, g.id) && !r.byGrader[g.id]?.size ? "own family, not graded" : fmt(meanSe([...(r.byGrader[g.id]?.values() ?? [])].map((x) => x.score))))).join(" | ");
  const coverage = (r: Row) => `${r.outputs}/${r.tasks}; grades ${GRADERS.map((g) => `${g.id} ${r.byGrader[g.id]?.size ?? 0}`).join(", ")}; missing ${Math.max(0, r.outputs - r.combined.size)}`;
  const costs = (r: Row) => `billed ${money(r.billed)}, estimated ${money(r.estimated)}${r.reserved ? `, no bill (held at worst) ${money(r.reserved)}` : ""}`;
  if (suiteName === "review-seats") {
    lines.push("| Configuration | Coverage | Score, Claude | Score, OpenAI | Combined (all tasks) | Combined (matched) | Against the top | Unique serious | False alarms (Claude / OpenAI) | Recall of adopted notes | Cost | Time per call |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of all) lines.push(`| ${cell(label(r))} | ${cell(coverage(r))} | ${graderCols(r)} | ${fmt(meanSe([...r.combined.values()]))} | ${fmt(onMatched(r))} | ${vsTop(r)} | ${r.uniqueSerious} | ${r.falseAlarms.claude ?? 0} / ${r.falseAlarms.codex ?? 0} | ${r.recallOf ? `${r.recallHit} of ${r.recallOf}` : "-"} | ${cell(costs(r))} | ${r.calls ? `${Math.round(r.ms / r.calls / 1000)} s` : "-"} |`);
    lines.push("", "Unique serious: findings no other output found that every grader who read it judged real and serious. Recall counts the owner's adopted notes an output also found; it is never part of a score. Originals are the answers the review seats gave at the time (no new call, no cost here).");
  } else {
    lines.push("| Configuration | Coverage | Score, Claude | Score, OpenAI | Rubric points (matched) | Against the top | Acceptable | Cost | Cost per acceptable answer | Time per call |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of all) {
      const acc = [...r.acceptable.values()].filter(Boolean).length;
      const allBilled = r.estimated === 0 && r.reserved === 0 && r.billed > 0;
      const perAcc = !acc ? "-" : allBilled ? `${money(r.billed / acc)} (${money(r.billed)} billed over ${acc} acceptable of ${r.acceptable.size} graded)` : "not given: some costs are estimates";
      lines.push(`| ${cell(label(r))} | ${cell(coverage(r))} | ${graderCols(r)} | ${fmt(onMatched(r))} | ${vsTop(r)} | ${acc} of ${r.acceptable.size} graded | ${cell(costs(r))} | ${cell(perAcc)} | ${r.calls ? `${Math.round(r.ms / r.calls / 1000)} s` : "-"} |`);
    }
    lines.push("", `Rubric points: correct ${POINTS.correct}, partial ${POINTS.partial}, a right "no reliable answer" ${POINTS.right_abstention}, a wrong one ${POINTS.wrong_abstention}, wrong but hedged ${POINTS.hedged_wrong}, confidently wrong ${POINTS.confident_wrong}. Acceptable: every grader who read it said the owner could act on it as it is. A cost per acceptable answer is given only where every cost was billed.`);
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

export function writeReport(dir: string, suite: SuiteName, budget: number): string {
  const text = buildReport(dir, suite, budget);
  writeAtomic(paths(dir).report(suite), text);
  return text;
}
