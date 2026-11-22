// The model trials (Cain 0.19.0): the spend stop, blind grading, the private-terms check on every outgoing
// call, the plan making no call, and resumption. No live provider call: every seat and grader is a fake.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatError, type Outbound } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import {
  GRADERS, REVIEW_CONFIGS, budgetAllows, callsFor, checkQuestions, disagreements, makeLabels, parseBriefTxt, parseGrades, pickReviewTasks,
  planOf, seatRoom, worstCase, type ReviewDir,
} from "../rootfs/opt/cain/trials/core.ts";
import { TrialRunner, latestRun, paths, readBudget, type TrialDeps } from "../rootfs/opt/cain/trials/runner.ts";
import { buildReport } from "../rootfs/opt/cain/trials/report.ts";
import { CODEX_NO_MODEL, claudeAsk, perplexityAsk, type AskFn, type AskInput } from "../rootfs/opt/cain/trials/calls.ts";

const CLI = join(import.meta.dir, "../rootfs/opt/cain/trials/cli.ts");
const TERMS = "# terms\nAcme Corp\nPat\n";
const DAY = "2026-11-22";

const briefTxt = (topic: string, body: string, facts = false) =>
  `Topic: ${topic}\nQuestion: Is this plan sound?\nNeeds current facts: ${facts ? "yes" : "no"}. Consequential: no.\n\n${body}\n`;
const resultJson = (id: string, created: string, over: any = {}) => JSON.stringify({ id, topic: "t", status: "done", created_at: created,
  seats: [{ seat: "openai", state: "done", model: "gpt-x", verdict: "approve_with_changes", findings: [{ rank: 1, problem: "the lock can leak", fix: "release it" }] },
    { seat: "gemini", state: "failed", findings: [] }], ...over });

function writeRecord(recordDir: string, n: number, extra: (i: number) => Partial<{ body: string; id: string; noAdopted: boolean; result: any }> = () => ({})) {
  for (let i = 0; i < n; i++) {
    const e = extra(i);
    const id = e.id ?? `2026-11-${String(10 + i).padStart(2, "0")}-plan-${i}`;
    const d = join(recordDir, "reviews", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "brief.txt"), briefTxt(`Plan ${i}`, e.body ?? `Run step ${i} as its own user and keep the keys root's.`));
    writeFileSync(join(d, "result.json"), e.result ?? resultJson(id, `2026-11-${String(10 + i).padStart(2, "0")}T12:00:00Z`));
    if (!e.noAdopted) writeFileSync(join(d, "adopted.md"), "adopted\n");
  }
}

type Spy<F> = F & { calls: any[] };
const answer = (over: Partial<SeatAnswer> = {}): SeatAnswer => ({ verdict: "approve_with_changes", findings: [{ rank: 1, problem: "a real problem", fix: "fix it" }],
  model: "fake", cost_usd: 0.01, ...over });
function seatSpy(impl: (i: SeatInput, model: string) => Promise<SeatAnswer> = async () => answer()): { make: (m: string) => SeatFn; calls: { model: string; input: SeatInput }[] } {
  const calls: { model: string; input: SeatInput }[] = [];
  return { calls, make: (m) => async (i) => { calls.push({ model: m, input: i }); return impl(i, m); } };
}
// A grader that grades every label it is given, and remembers what it was sent.
function graderSpy(cost = 0.05, kind: "review" | "research" = "review"): Spy<AskFn> {
  const calls: { model: string; input: AskInput }[] = [];
  const fn: AskFn = async (model, input) => {
    calls.push({ model, input });
    const labels = [...input.user.matchAll(/<output label="([A-Z]\d\d)">/g)].map((m) => m[1]);
    const outputs = labels.map((label) => kind === "review"
      ? { label, score: 4, reason: "ok", findings: [{ n: 1, real: true, severity: "serious", also_found_by: [], reason: "real" }] }
      : { label, score: 4, reason: "ok", correct: true, complete: true, current: true, citations_checked: 1, citations_supported: 1, says_no_reliable_answer: false, acceptable: true });
    return { text: JSON.stringify({ outputs }), json: { outputs }, urls: [], model: model || "codex-default", cost_usd: cost, billed: cost === 0, tokens: { input: 10, output: 10 }, searches: 0 };
  };
  return Object.assign(fn, { calls });
}
function askSpy(cost = 0.02): Spy<AskFn> {
  const calls: { model: string; input: AskInput }[] = [];
  const fn: AskFn = async (model, input) => { calls.push({ model, input });
    return { text: "The answer is 42. https://example.com/a", urls: ["https://example.com/a"], model, cost_usd: cost, billed: false, tokens: { input: 5, output: 5 }, searches: 1 }; };
  return Object.assign(fn, { calls });
}

function rig(o: { budget?: number; reviews?: number; terms?: string; caps?: Partial<RunnerConfig["caps"]>; record?: (i: number) => any;
  seats?: Partial<TrialDeps["seats"]>; asks?: Partial<TrialDeps["asks"]>; stopped?: () => boolean; } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trials-"));
  const cfg: RunnerConfig = { ...DEFAULTS, caps: { ...DEFAULTS.caps, ...(o.caps ?? {}) }, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), reservePercent: 25 };
  writeFileSync(cfg.termsFile, o.terms ?? TERMS);
  const recordDir = join(dir, "record");
  writeRecord(recordDir, o.reviews ?? 2, o.record);
  let clock = new Date("2026-11-22T15:00:00Z");
  const review = new Runner(cfg, { seats: {}, now: () => clock, rand: () => 0.5, log: () => {}, stopped: o.stopped ?? (() => false) });
  const gemini = seatSpy(), codex = seatSpy(async () => answer({ cost_usd: 0 })), pplx = seatSpy(async () => answer({ cost_usd: 0.003 }));
  const claude = graderSpy(0.05), codexGrader = graderSpy(0);
  let seq = 0;
  const deps: TrialDeps = {
    review,
    seats: { gemini: gemini.make, codex: codex.make, perplexity: pplx.make("perplexity/sonar"), ...(o.seats ?? {}) },
    asks: { claude, codex: codexGrader, ...(o.asks ?? {}) },
    now: () => clock, rand: () => ((seq = (seq * 9301 + 49297) % 233280) / 233280), log: () => {},
  };
  const tdir = join(dir, "trials");
  const trials = new TrialRunner({ dir: tdir, recordDir, budgetUsd: o.budget ?? 40 }, deps);
  const runAll = async (max = 500) => { for (let i = 0; i < max; i++) { if (!(await trials.tick())) { const st = latestRun(tdir, "review-seats") ?? latestRun(tdir, "research"); if (st?.status !== "running") break; } } };
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  return { dir, tdir, cfg, recordDir, review, trials, deps, gemini, codex, pplx, claude, codexGrader, runAll, relays,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
const outputCallsMade = (t: ReturnType<typeof rig>) => t.gemini.calls.length + t.codex.calls.length + t.pplx.calls.length;

const QUESTIONS = Array.from({ length: 30 }, (_, i) => ({ kind: i < 15 ? "fact" : "listing", question: `Question number ${i + 1} about a tool?`,
  must_contain: "the current version and its source", no_reliable_answer: i < 3 }));

describe("tasks", () => {
  test("a brief.txt reads back into what was sent", () => {
    const b = parseBriefTxt(briefTxt("Desk", "Body line one\nline two", true))!;
    expect(b).toEqual({ topic: "Desk", question: "Is this plan sound?", needs_facts: true, consequential: false, body: "Body line one\nline two" });
    expect(parseBriefTxt("nope")).toBeNull();
  });
  test("the 12 newest full reviews with result.json and adopted.md, none about this trial", () => {
    const dirs: ReviewDir[] = [];
    for (let i = 0; i < 16; i++) dirs.push({ id: `2026-11-${String(i + 1).padStart(2, "0")}-r${i}`, brief: briefTxt("x", "y"), result: { status: "done" }, adopted: true, created: `2026-11-${String(i + 1).padStart(2, "0")}` });
    dirs.push({ id: "2026-11-21-model-roles", brief: briefTxt("x", "y"), result: {}, adopted: true, created: "2026-11-21" });
    dirs.push({ id: "2026-11-20-fixes", brief: briefTxt("x", "y"), result: { round_kind: "fixes" }, adopted: true, created: "2026-11-20" });
    dirs.push({ id: "2026-11-19-unadopted", brief: briefTxt("x", "y"), result: {}, adopted: false, created: "2026-11-19" });
    const { tasks, skipped } = pickReviewTasks(dirs);
    expect(tasks.length).toBe(12);
    expect(tasks[0].id).toBe("2026-11-16-r15");
    expect(tasks.map((t) => t.id)).not.toContain("2026-11-21-model-roles");
    expect(skipped.join(" ")).toContain("about this trial");
    expect(skipped.join(" ")).toContain("fix-only");
    expect(tasks.map((t) => t.id)).not.toContain("2026-11-19-unadopted");
  });
  test("research questions: 15 facts, 15 listings, at least 3 with no reliable answer", () => {
    expect(checkQuestions({ questions: QUESTIONS }).tasks!.length).toBe(30);
    expect(checkQuestions({ questions: QUESTIONS.slice(1) }).error).toContain("15 fact");
    expect(checkQuestions({ questions: QUESTIONS.map((q) => ({ ...q, no_reliable_answer: false })) }).error).toContain("at least 3");
    expect(checkQuestions({ questions: QUESTIONS.map((q, i) => (i === 4 ? { ...q, must_contain: "" } : q)) }).error).toContain("must contain");
  });
});

describe("the spend stop", () => {
  test("worst case is the output cap at the output price, never less than a measured call", () => {
    // gemini-3.8-flash: $0.75 in, $3.75 out per 1M until Dec 31.
    const w = worstCase({ seat: "gemini", model: "gemini-3.8-flash", search: false, maxOut: 8_192, inputChars: 3_000 }, DAY);
    expect(w).toBeCloseTo((1_500 * 0.75 + 8_192 * 3.75) / 1e6, 8);
    // A model missing from the price table is priced high.
    expect(worstCase({ seat: "gemini", model: "gemini-4-neon", search: false, maxOut: 8_192, inputChars: 3_000 }, DAY)).toBeGreaterThan(0.4);
    expect(worstCase({ seat: "codex", model: "", search: true, maxOut: 0, inputChars: 99_999 }, DAY)).toBe(0);
    expect(budgetAllows(39.9, 0.1, 40)).toBe(true);
    expect(budgetAllows(39.9, 0.11, 40)).toBe(false);
    expect(seatRoom(8, 25, 5)).toBe(1);
  });

  test("a run that would pass the budget makes no further call, stops, and says so", async () => {
    // Each Gemini call's worst case is about $0.42 (an unpriced model) or $0.03 (Flash); a $0.50 budget fits one or two.
    const t = rig({ budget: 0.5 });
    expect(t.trials.request({ kind: "run", suite: "review-seats" })).toBeNull();
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.status).toBe("stopped");
    expect(st.stop!.reason).toBe("budget");
    expect(st.stop!.detail).toContain("wasn't made");
    const b = readBudget(t.tdir);
    expect(b.spent_usd).toBeLessThanOrEqual(0.5);
    const made = outputCallsMade(t);
    // Asked again, it stops again at once, with no call.
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(outputCallsMade(t)).toBe(made);
    expect(latestRun(t.tdir, "review-seats")!.stop!.reason).toBe("budget");
    expect(t.relays().some((r) => r.includes("stopped") && r.includes("trials budget"))).toBe(true);
    expect(buildReport(t.tdir, "review-seats", 0.5)).toContain("stopped");
  });

  test("grading spend counts against the budget", async () => {
    const t = rig({ budget: 40, reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.status).toBe("done");
    const b = readBudget(t.tdir);
    const grade = b.entries.filter((e) => e.call.startsWith("grade|"));
    expect(grade.length).toBe(2);
    expect(grade.find((e) => e.call.endsWith("|claude"))!.usd).toBeCloseTo(0.05, 6);
    const sum = b.entries.reduce((a, e) => a + e.usd, 0);
    expect(b.spent_usd).toBeCloseTo(sum, 6);
    expect(sum).toBeGreaterThan(0.05);
    // And it reaches the review service's ledger, so the monthly caps see it.
    const ledger = JSON.parse(readFileSync(t.cfg.spendFile, "utf8"))["2026-11"];
    expect(ledger.claude.usd).toBeCloseTo(0.05, 6);
    expect(ledger.openai.runs).toBeGreaterThan(0);
  });

  test("a stop when only the grading would pass the budget", async () => {
    // Outputs are cheap and Codex is free, but the Claude grader's worst case is its 16,000 token cap at $20 per 1M.
    const t = rig({ budget: 0.3, reviews: 1, seats: { gemini: undefined } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.stop?.reason).toBe("budget");
    expect(st.stop!.detail).toContain("grader Claude");
    expect(t.claude.calls.length).toBe(0);
  });

  test("trials never spend into the reserve kept for real reviews", async () => {
    // Gemini's cap of $0.50 with a 25% reserve leaves $0.375, less than an unpriced model's worst case.
    const t = rig({ caps: { gemini: 0.5 }, reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const held = Object.entries(st.calls).filter(([, c]) => c.status === "held").map(([id]) => id);
    expect(held.some((id) => id.includes("gemini-4-neon"))).toBe(true);
    expect(t.gemini.calls.map((c) => c.model).sort()).toEqual(["gemini-3.8-flash", "gemini-4-argon"]);
    expect(st.status).toBe("stopped");
    expect(st.stop!.reason).toBe("caps");
  });

  test("nothing is sent while Dane's Stop holds", async () => {
    const t = rig({ stopped: () => true });
    t.trials.request({ kind: "run", suite: "review-seats" });
    for (let i = 0; i < 5; i++) await t.trials.tick();
    expect(outputCallsMade(t)).toBe(0);
    expect(latestRun(t.tdir, "review-seats")!.status).toBe("running");
  });
});

describe("blind grading", () => {
  test("graders never receive the key, a configuration or a model name", async () => {
    const t = rig({ reviews: 2 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.status).toBe("done");
    const keyText = readFileSync(paths(t.tdir).key("review-seats", st.run), "utf8");
    const key = JSON.parse(keyText);
    expect(Object.keys(key).length).toBe(2);
    const sent = [...t.claude.calls, ...t.codexGrader.calls].map((c) => `${c.input.system}\n${c.input.user}`);
    expect(sent.length).toBe(4);
    for (const s of sent) {
      expect(s).not.toContain(keyText);
      for (const c of REVIEW_CONFIGS) expect(s).not.toContain(c.id);
      for (const m of ["gemini-4-argon", "gemini-3.8-flash", "perplexity/sonar", "gpt-x", "original:", "out|"]) expect(s).not.toContain(m);
      // Each label in the key appears, and only labels.
      const labels = [...s.matchAll(/<output label="([A-Z]\d\d)">/g)].map((m) => m[1]);
      expect(labels.length).toBeGreaterThan(5);
    }
    // The originals from the record are outputs too, with no call.
    const originals = Object.keys(st.calls).filter((id) => id.includes("|original:"));
    expect(originals.length).toBe(2);
    for (const task of Object.keys(key)) expect(Object.values(key[task]).some((c: any) => c.includes("original:openai"))).toBe(true);
    // Both graders' scores are stored per output.
    expect(readdirSync(join(paths(t.tdir).run("review-seats", st.run), "grades")).length).toBe(4);
    const report = buildReport(t.tdir, "review-seats", 40);
    expect(report).toContain("gemini:gemini-4-argon");
    expect(report).toContain("Graders' agreement");
  });

  test("labels are random and unique; grades keep only given labels and every field is checked", () => {
    let s = 1; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const key = makeLabels(["a", "b", "c", "d"], rand);
    expect(Object.keys(key).length).toBe(4);
    for (const l of Object.keys(key)) expect(l).toMatch(/^[A-Z]\d\d$/);
    const ok = parseGrades({ outputs: [{ label: "A10", score: 3, reason: "x", findings: [] }, { label: "Z99", score: 5 }] }, "review", ["A10"]);
    expect(ok.grades!.map((g) => g.label)).toEqual(["A10"]);
    expect(parseGrades({ outputs: [{ label: "A10", score: 9 }] }, "review", ["A10"]).error).toContain("score");
    expect(parseGrades({ outputs: [] }, "review", ["A10"]).error).toContain("left out");
  });

  test("disagreements by more than one rubric step are flagged", () => {
    const a = { label: "A10", score: 5, reason: "", findings: [{ n: 1, real: true, severity: "serious" as const, also_found_by: [], reason: "" }] };
    const b = { label: "A10", score: 2, reason: "", findings: [{ n: 1, real: false, severity: "wrong" as const, also_found_by: [], reason: "" }] };
    expect(disagreements(a, b)).toEqual(["scores 5 and 2", "finding 1: serious and wrong"]);
    expect(disagreements(a, { ...a, score: 4 })).toEqual([]);
  });
});

describe("the private-terms check on every outgoing task", () => {
  test("a task with a private term is never sent to any seat or grader", async () => {
    const t = rig({ reviews: 2, record: (i) => (i === 0 ? { body: "Ask Pat about the lock." } : {}) });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const blocked = Object.entries(st.calls).filter(([, c]) => c.status === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    for (const [id, c] of blocked) { expect(id).toContain("plan-0"); expect(c.error).toContain("private term"); }
    for (const c of [...t.gemini.calls, ...t.codex.calls, ...t.pplx.calls]) expect(c.input.brief.body).not.toContain("Pat");
    for (const c of [...t.claude.calls, ...t.codexGrader.calls]) expect(c.input.user).not.toContain("Pat");
  });

  test("a model output carrying a private term blocks its task's grading", async () => {
    const t = rig({ reviews: 1, seats: { perplexity: async () => answer({ findings: [{ rank: 1, problem: "Acme Corp is named", fix: "x" }] }) } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(Object.entries(st.calls).filter(([id]) => id.startsWith("grade|")).every(([, c]) => c.status === "blocked")).toBe(true);
    expect(t.claude.calls.length + t.codexGrader.calls.length).toBe(0);
  });

  test("research questions pass the check before they are kept", () => {
    const t = rig();
    const bad = QUESTIONS.map((q, i) => (i === 7 ? { ...q, question: "What does Acme Corp charge?" } : q));
    expect(t.trials.request({ kind: "run", suite: "research", questions: { questions: bad } })).toContain("blocked: privacy");
    expect(existsSync(paths(t.tdir).suite("research"))).toBe(false);
  });

  test("with no private-terms list nothing leaves", async () => {
    const t = rig({ reviews: 1 });
    writeFileSync(t.cfg.termsFile, "");
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(outputCallsMade(t)).toBe(0);
  });
});

describe("the plan makes no call", () => {
  test("planOf lists every call with its seat, model, setting and worst case", () => {
    const t = rig({ reviews: 2 });
    const { tasks } = pickReviewTasks((require("../rootfs/opt/cain/trials/runner.ts") as any).reviewDirs(t.recordDir));
    const suite = { format: 1 as const, name: "review-seats" as const, created_at: "", tasks, skipped: [] };
    const p = planOf(suite, DAY);
    expect(p.lines.length).toBe(callsFor(suite).length);
    expect(p.lines.length).toBe(2 * (REVIEW_CONFIGS.length + GRADERS.length));
    expect(p.total).toBeGreaterThan(0);
    expect(p.lines.find((l) => l.who === "codex:gpt-6.2-sol")!.note).toContain("only if");
    expect(outputCallsMade(t) + t.claude.calls.length).toBe(0);
  });

  test("trial.sh plan prints the calls and the total, and leaves nothing for the runner", () => {
    const t = rig({ reviews: 2 });
    const env = { ...process.env, TRIALS_DIR: t.tdir, TRIALS_INBOX: join(t.dir, "inbox"), RECORD_DIR: t.recordDir, CAIN_STOP_FILE: join(t.dir, "stop.json") };
    const r = spawnSync("bun", [CLI, "plan", "review-seats"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No call is made");
    expect(r.stdout).toContain("gemini:gemini-4-carbon");
    expect(r.stdout).toContain("Total worst case");
    expect(existsSync(join(t.dir, "inbox"))).toBe(false);
    const q = join(t.dir, "q.json"); writeFileSync(q, JSON.stringify({ questions: QUESTIONS }));
    const r2 = spawnSync("bun", [CLI, "plan", "research", q], { encoding: "utf8", env });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("perplexity:medium");
    expect(r2.stdout).toContain("30 tasks");
    // run leaves a request; the runner takes it.
    const r3 = spawnSync("bun", [CLI, "run", "review-seats"], { encoding: "utf8", env });
    expect(r3.status).toBe(0);
    expect(readdirSync(join(t.dir, "inbox")).length).toBe(1);
  });
});

describe("resumption", () => {
  test("a stopped suite resumes without re-running finished calls or counting spend twice", async () => {
    const t = rig({ budget: 0.3, reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st1 = latestRun(t.tdir, "review-seats")!;
    expect(st1.stop!.reason).toBe("budget");
    const done1 = Object.entries(st1.calls).filter(([, c]) => c.status === "done").map(([id]) => id);
    const made1 = outputCallsMade(t);
    const spent1 = readBudget(t.tdir).spent_usd;
    // The owner raises the budget; the same run resumes.
    t.trials.cfg.budgetUsd = 40;
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st2 = latestRun(t.tdir, "review-seats")!;
    expect(st2.run).toBe(st1.run);
    expect(st2.status).toBe("done");
    const b = readBudget(t.tdir);
    // Every call is charged exactly once.
    const ids = b.entries.map((e) => e.call);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of done1) expect(ids.filter((x) => x === id).length).toBeLessThanOrEqual(1);
    expect(b.spent_usd).toBeCloseTo(b.entries.reduce((a, e) => a + e.usd, 0), 6);
    expect(b.spent_usd).toBeGreaterThanOrEqual(spent1);
    // Calls finished before the stop weren't made again.
    const configsMadeTwice = [...t.gemini.calls.map((c) => c.model)].filter((m, i, a) => a.indexOf(m) !== i);
    expect(configsMadeTwice).toEqual([]);
    expect(outputCallsMade(t)).toBeGreaterThan(made1);
  });

  test("a call cut off by a restart counts at its worst case once, and runs again", async () => {
    const t = rig({ reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    const st = latestRun(t.tdir, "review-seats")!;
    // As if the process died mid-call: pending in the budget, nothing settled.
    const first = callsFor({ format: 1, name: "review-seats", created_at: "", tasks: (JSON.parse(readFileSync(paths(t.tdir).suite("review-seats"), "utf8"))).tasks, skipped: [] })[0];
    const bfile = paths(t.tdir).budget;
    writeFileSync(bfile, JSON.stringify({ format: 1, spent_usd: 0, entries: [], pending: { [first.id]: { suite: "review-seats", run: st.run, call: first.id, worst_usd: 0.42, at: "x" } } }));
    st.calls[first.id] = { status: "interrupted", attempts: 1, cost_usd: 0, at: "x" };
    writeFileSync(paths(t.tdir).state("review-seats", st.run), JSON.stringify(st));
    const fresh = new TrialRunner(t.trials.cfg, t.deps);
    await fresh.tick();
    const b = readBudget(t.tdir);
    expect(Object.keys(b.pending).length).toBe(0);
    expect(b.entries.filter((e) => e.call === first.id && e.how === "worst case (cut off)").length).toBe(1);
    for (let i = 0; i < 300; i++) if (!(await fresh.tick()) && latestRun(t.tdir, "review-seats")!.status !== "running") break;
    expect(latestRun(t.tdir, "review-seats")!.calls[first.id].status).toBe("done");
    expect(readBudget(t.tdir).entries.filter((e) => e.how === "worst case (cut off)").length).toBe(1);
  });
});

describe("configurations", () => {
  test("a Codex model the installed CLI doesn't offer is skipped and said so", async () => {
    const codex = seatSpy(async (_i, m) => { if (m === "gpt-6.2-astra") throw new SeatError("transient", "Codex: error: model 'gpt-6.2-astra' is not supported"); return answer({ cost_usd: 0 }); });
    const t = rig({ reviews: 1, seats: { codex: codex.make } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const c = Object.entries(st.calls).find(([id]) => id.endsWith("codex:gpt-6.2-astra"))![1];
    expect(c.status).toBe("skipped");
    expect(c.error).toContain("doesn't offer gpt-6.2-astra");
    expect(codex.calls.filter((x) => x.model === "gpt-6.2-astra").length).toBe(1);
    expect(CODEX_NO_MODEL.test("unknown model foo")).toBe(true);
    expect(buildReport(t.tdir, "review-seats", 40)).toContain("doesn't offer gpt-6.2-astra");
  });

  test("each Gemini configuration asks for its own model, with search only when the brief needs facts", async () => {
    const t = rig({ reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(t.gemini.calls.map((c) => c.model).sort()).toEqual(["gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"]);
    expect(t.codex.calls.map((c) => c.model).sort()).toEqual(["", "gpt-6.2-astra", "gpt-6.2-sol"]);
  });

  test("the research suite runs every configuration, and graders fetch the cited pages", async () => {
    const claudeOut = askSpy(0.03), gem = askSpy(0.01), pp = askSpy(0.004);
    const claudeGrader = graderSpy(0.05, "research"), codexGrader = graderSpy(0, "research");
    // One Claude for both answers and grades: route by the schema.
    const claude: AskFn = (m, i) => (i.schema ? claudeGrader(m, i) : claudeOut(m, i));
    const t = rig({ asks: { claude, gemini: gem, perplexity: pp, codex: codexGrader } });
    expect(t.trials.request({ kind: "run", suite: "research", questions: { questions: QUESTIONS.slice(0, 30) } })).toBeNull();
    for (let i = 0; i < 2000; i++) { if (!(await t.trials.tick()) && latestRun(t.tdir, "research")!.status !== "running") break; }
    const st = latestRun(t.tdir, "research")!;
    expect(st.status).toBe("done");
    expect(pp.calls.map((c) => c.model).filter((m, i, a) => a.indexOf(m) === i).sort()).toEqual(["fast", "low", "medium"]);
    expect(gem.calls.every((c) => c.input.search)).toBe(true);
    expect(claudeOut.calls.every((c) => c.input.search && c.model === "claude-opus-5-5")).toBe(true);
    expect(claudeGrader.calls.every((c) => c.input.fetch)).toBe(true);
    expect(claudeGrader.calls.length).toBe(30);
    const report = buildReport(t.tdir, "research", 40);
    expect(report).toContain("Cost per acceptable answer");
    expect(report).toContain("perplexity:low");
  });
});

describe("the calls", () => {
  const okFetch = (body: any, seen: any[]) => (async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(body), { status: 200 }); }) as any;
  test("Claude: the web tools when asked, the citations kept, the key never in an error", async () => {
    const seen: any[] = [];
    const ask = claudeAsk({ key: "sk-test-key-123456", fetch: okFetch({ model: "claude-opus-5-5", stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } },
      content: [{ type: "text", text: "Answer.", citations: [{ url: "https://a.example/x" }] }] }, seen) });
    const r = await ask("claude-opus-5-5", { system: "s", user: "u", maxOut: 500, signal: new AbortController().signal, day: DAY, search: true, fetch: true });
    expect(seen[0].body.tools.map((t: any) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(r.urls).toEqual(["https://a.example/x"]);
    expect(r.cost_usd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6 + 0.02, 8);
    const bad = claudeAsk({ key: "sk-test-key-123456", fetch: (async () => new Response(JSON.stringify({ error: { message: "bad key sk-test-key-123456" } }), { status: 401 })) as any });
    await expect(bad("claude-opus-5-5", { system: "s", user: "u", maxOut: 5, signal: new AbortController().signal, day: DAY })).rejects.toThrow(/HTTP 401/);
  });
  test("Perplexity: a preset by name, and its own bill", async () => {
    const seen: any[] = [];
    const ask = perplexityAsk({ key: "pplx-test-key-123", fetch: okFetch({ status: "completed", model: "openai/gpt-5.6-luna", output_text: "Answer https://b.example/y",
      usage: { input_tokens: 10, output_tokens: 10, cost: { total_cost: 0.0123 } } }, seen) });
    const r = await ask("low", { system: "s", user: "u", maxOut: 400, signal: new AbortController().signal, day: DAY });
    expect(seen[0].body.preset).toBe("low");
    expect(r.cost_usd).toBe(0.0123);
    expect(r.billed).toBe(true);
    expect(r.urls).toContain("https://b.example/y");
  });
});
