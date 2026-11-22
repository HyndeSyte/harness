// trial.sh report: a plain table per configuration from a suite's newest run (the graders' scores, unique
// serious findings or acceptable answers, false alarms, cost and time per task), the graders' agreement,
// and what was skipped and why. Written to /data/trials/<suite>/report.md by the runner; trial.sh prints
// the same text. Only labels reach the graders; here the key turns them back into configurations.
import { readFileSync } from "node:fs";
import { configsFor, disagreements, type OutputGrade, type SuiteName } from "./core.ts";
import { latestRun, paths, readBudget, readSuite, writeAtomic } from "./runner.ts";

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const money = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const cell = (s: string) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();

type Row = { config: string; outputs: number; cost: number; ms: number; calls: number; scores: Record<string, number[]>;
  uniqueBoth: number; uniqueEither: number; falseAlarms: Record<string, number>; acceptable: number; findings: number };

export function buildReport(dir: string, suiteName: SuiteName, budget: number): string {
  const suite = readSuite(dir, suiteName);
  const st = latestRun(dir, suiteName);
  if (!suite || !st) return `# Model trial: ${suiteName}\n\nNo run yet.\n`;
  const p = paths(dir);
  const key = readJson<Record<string, Record<string, string>>>(p.key(st.suite, st.run), {});
  const graders: Record<string, Record<string, OutputGrade[]>> = {};   // task -> grader -> grades
  let gradeCost = 0, gradeMs = 0;
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("grade|")) continue;
    gradeCost += c.cost_usd ?? 0; gradeMs += c.ms ?? 0;
    if (c.status !== "done") continue;
    const g = readJson<any>(p.grade(st.suite, st.run, id), null);
    if (g?.grades) (graders[g.task] ??= {})[g.grader] = g.grades;
  }
  const configOf = (call: string) => call.split("|")[2] ?? call;
  const rows = new Map<string, Row>();
  const row = (config: string) => { let r = rows.get(config); if (!r) { r = { config, outputs: 0, cost: 0, ms: 0, calls: 0, scores: {}, uniqueBoth: 0, uniqueEither: 0,
    falseAlarms: {}, acceptable: 0, findings: 0 }; rows.set(config, r); } return r; };
  for (const c of configsFor(suiteName)) row(c.id);
  for (const [id, c] of Object.entries(st.calls)) {
    if (!id.startsWith("out|")) continue;
    const r = row(configOf(id));
    r.cost += c.cost_usd ?? 0;
    if (c.status === "done") { r.outputs++; r.ms += c.ms ?? 0; if (!configOf(id).startsWith("original:")) r.calls++; }
  }
  let compared = 0, agreed = 0;
  const flagged: string[] = [];
  for (const [task, byGrader] of Object.entries(graders)) {
    const labels = key[task] ?? {};
    const gs = Object.entries(byGrader);
    for (const [label, call] of Object.entries(labels)) {
      const r = row(configOf(call));
      const mine = gs.map(([g, list]) => [g, list.find((x) => x.label === label)] as const).filter(([, x]) => !!x) as [string, OutputGrade][];
      for (const [g, x] of mine) {
        (r.scores[g] ??= []).push(x.score);
        if (suiteName === "review-seats") r.falseAlarms[g] = (r.falseAlarms[g] ?? 0) + (x.findings ?? []).filter((f) => !f.real || f.severity === "wrong").length;
      }
      if (suiteName === "review-seats") {
        const out = readJson<any>(p.output(st.suite, st.run, call), null);
        const n = Array.isArray(out?.findings) ? out.findings.length : 0;
        r.findings += n;
        for (let i = 1; i <= n; i++) {
          const marks = mine.map(([, x]) => (x.findings ?? []).find((f) => f.n === i)).filter(Boolean);
          const uniqueSerious = (f: any) => f.real && f.severity === "serious" && f.also_found_by.length === 0;
          if (marks.length === mine.length && mine.length >= 2 && marks.every(uniqueSerious)) r.uniqueBoth++;
          if (marks.some(uniqueSerious)) r.uniqueEither++;
        }
      } else if (mine.length >= 2 && mine.every(([, x]) => x.acceptable)) r.acceptable++;
      if (mine.length >= 2) {
        compared++;
        const d = disagreements(mine[0][1], mine[1][1]);
        if (d.length) flagged.push(`${task}, ${configOf(call)}: ${d.join("; ")}`); else agreed++;
      }
    }
  }
  const mean = (xs?: number[]) => (xs?.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-");
  const b = readBudget(dir);
  const settled = Object.values(st.calls).filter((c) => c.status !== "interrupted" && c.status !== "held").length;
  const lines: string[] = [
    `# Model trial: ${suiteName} (run ${st.run})`, "",
    `Status: ${st.status}${st.stop ? `, stopped: ${st.stop.detail}` : ""}. Tasks: ${suite.tasks.length}. Calls settled: ${settled}.`,
    `Trials budget: ${money(b.spent_usd)} spent of ${money(budget)} across every suite. This run: ${money(Object.values(st.calls).reduce((a, c) => a + (c.cost_usd ?? 0), 0))}, grading ${money(gradeCost)}.`,
    "Graders: Claude (claude-opus-5-5) and OpenAI (Codex, its default model), blind to which configuration wrote each output.", "",
  ];
  if (suiteName === "review-seats") {
    lines.push("| Configuration | Outputs | Score, Claude | Score, OpenAI | Unique serious (both / either) | False alarms (Claude / OpenAI) | Findings | Cost per task | Time per task |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows.values()) lines.push(`| ${cell(r.config)} | ${r.outputs} | ${mean(r.scores.claude)} | ${mean(r.scores.codex)} | ${r.uniqueBoth} / ${r.uniqueEither} | ${r.falseAlarms.claude ?? 0} / ${r.falseAlarms.codex ?? 0} | ${r.findings} | ${r.outputs ? money(r.cost / r.outputs) : "-"} | ${r.calls ? `${Math.round(r.ms / r.calls / 1000)} s` : "-"} |`);
    lines.push("", "Unique serious: findings no other output found that the graders judged real and serious (both graders, or either). Originals are the answers the review seats gave at the time (no new call; their cost is not counted here).");
  } else {
    lines.push("| Configuration | Answers | Score, Claude | Score, OpenAI | Acceptable (both graders) | Cost per task | Cost per acceptable answer | Time per task |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows.values()) lines.push(`| ${cell(r.config)} | ${r.outputs} | ${mean(r.scores.claude)} | ${mean(r.scores.codex)} | ${r.acceptable} | ${r.outputs ? money(r.cost / r.outputs) : "-"} | ${r.acceptable ? money(r.cost / r.acceptable) : "-"} | ${r.outputs ? `${Math.round(r.ms / r.outputs / 1000)} s` : "-"} |`);
    lines.push("", "Cost includes search fees. Acceptable: both graders say the owner could act on it as it is.");
  }
  lines.push("", `## Graders' agreement`, "", compared ? `${agreed} of ${compared} outputs graded by both within one rubric step (${Math.round((agreed / compared) * 100)}%).` : "No output graded by both yet.");
  if (flagged.length) lines.push("", "Flagged (more than one step apart):", ...flagged.slice(0, 60).map((f) => `- ${cell(f)}`), ...(flagged.length > 60 ? [`- (${flagged.length - 60} more in the grades files)`] : []));
  const skipped = Object.entries(st.calls).filter(([, c]) => ["skipped", "blocked", "failed", "held", "interrupted"].includes(c.status) && (c.status !== "failed" || c.final))
    .map(([id, c]) => `- ${cell(id.replace(/^out\||^grade\|/, ""))}: ${c.status}, ${cell(c.error ?? "")}`);
  lines.push("", "## Skipped, and why", "", ...(st.notes.length ? st.notes.map((n) => `- ${cell(n)}`) : []), ...(skipped.length ? skipped : []),
    ...(!st.notes.length && !skipped.length ? ["Nothing."] : []));
  if (st.stops.length) lines.push("", "## Stops", "", ...st.stops.map((s) => `- ${s.at.slice(0, 16).replace("T", " ")} UTC, ${s.reason}: ${cell(s.detail)}`));
  return lines.join("\n") + "\n";
}

export function writeReport(dir: string, suite: SuiteName, budget: number): string {
  const text = buildReport(dir, suite, budget);
  writeAtomic(paths(dir).report(suite), text);
  return text;
}
