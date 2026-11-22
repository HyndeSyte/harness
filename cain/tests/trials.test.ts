// The model trials (Cain 0.19.0, with the first review's fixes): the spend bound (hard ceilings in every
// request, one atomic check-and-reserve on disk, task holds), the private-terms check on the final request,
// Codex isolation, the Perplexity contract, Codex model discovery, blind grading, real reviews first, the
// price table and the checks before any spend, the inbox's trust, and the research suite's design.
// No live provider call: every provider is a fake, or a real adapter over a fake fetch or exec.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FINAL, SeatError, newReview, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, saveReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import type { SeatFn } from "../rootfs/opt/cain/review/seats/common.ts";
import {
  GRADERS, LIMITS, REVIEW_CONFIGS, RESEARCH_CONFIGS, SELF_NAMES, TRIAL_PRICES, blindViolations, callShape, callsFor, ceilingOf, ceilingPrice, checkQuestions,
  datedPrice, disagreements, gradePrompt, makeLabels, normalizeCandidate, parseBriefTxt, parseGrades, pickReviewTasks, planOf, worstOf, worstOfCeiling,
  type ReviewDir, type Suite,
} from "../rootfs/opt/cain/trials/core.ts";
import { RESEARCH_APPROVAL, RESEARCH_QUESTIONS, TrialRunner, latestRun, paths, readBudget, requestError, reviewDirs, type TrialDeps } from "../rootfs/opt/cain/trials/runner.ts";
import { buildReport } from "../rootfs/opt/cain/trials/report.ts";
import {
  CLAUDE_FETCH_TOOL, CLAUDE_SEARCH_TOOL, CODEX_NO_MODEL, claudeProvider, codexProvider, geminiProvider, modelsFromCatalog, perplexityProvider,
  type AskFn, type AskInput, type AskResult, type CodexProvider, type Provider,
} from "../rootfs/opt/cain/trials/calls.ts";
import { Ledger } from "../rootfs/opt/cain/trials/ledger.ts";
import { PrivacyBlock, makeWire } from "../rootfs/opt/cain/trials/guard.ts";

const CLI = join(import.meta.dir, "../rootfs/opt/cain/trials/cli.ts");
const LEDGER = join(import.meta.dir, "../rootfs/opt/cain/trials/ledger.ts");
const TERMS = "# terms\nAcme Corp\nPat\n";
const DAY = "2026-11-22";
const sig = () => new AbortController().signal;

const briefTxt = (topic: string, body: string, facts = false) =>
  `Topic: ${topic}\nQuestion: Is this plan sound?\nNeeds current facts: ${facts ? "yes" : "no"}. Consequential: no.\n\n${body}\n`;
const resultJson = (id: string, created: string, over: any = {}) => JSON.stringify({ id, topic: "t", status: "done", created_at: created,
  seats: [{ seat: "openai", state: "done", model: "gpt-x", verdict: "approve_with_changes", findings: [{ rank: 1, problem: "the lock can leak", fix: "release it" }] },
    { seat: "gemini", state: "failed", findings: [] }], ...over });

function writeRecord(recordDir: string, n: number, extra: (i: number) => Partial<{ body: string; id: string; noAdopted: boolean; result: any; adopted: string }> = () => ({})) {
  for (let i = 0; i < n; i++) {
    const e = extra(i);
    const id = e.id ?? `2026-11-${String(10 + i).padStart(2, "0")}-plan-${i}`;
    const d = join(recordDir, "reviews", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "brief.txt"), briefTxt(`Plan ${i}`, e.body ?? `Run step ${i} as its own user and keep the keys root's.`));
    writeFileSync(join(d, "result.json"), e.result ?? resultJson(id, `2026-11-${String(10 + i).padStart(2, "0")}T12:00:00Z`));
    if (!e.noAdopted) writeFileSync(join(d, "adopted.md"), e.adopted ?? "- release the lock on every path\n- log the failure\n");
  }
}
const QUESTIONS = Array.from({ length: 30 }, (_, i) => ({ kind: i < 15 ? "fact" : "listing", question: `Cain's own note ${i + 1}: SECRET-CONTEXT-${i}`,
  sent_text: `What is the current release of tool number ${i + 1}?`, as_of: "2026-11-20", must_contain: "the current version and its source",
  sources: [{ url: "https://example.com/releases", read_on: "2026-11-19" }], no_reliable_answer: i < 3 }));
function writeQuestions(recordDir: string, questions: any = { questions: QUESTIONS }, approve: boolean | object = true) {
  const text = JSON.stringify(questions);
  mkdirSync(join(recordDir, "projects/harness/trials"), { recursive: true });
  writeFileSync(join(recordDir, RESEARCH_QUESTIONS), text);
  if (approve) writeFileSync(join(recordDir, RESEARCH_APPROVAL), JSON.stringify({ questions_sha256: createHash("sha256").update(text).digest("hex"),
    approved_by: "owner", approved_on: "2026-11-21", ...(typeof approve === "object" ? approve : {}) }));
}

// ---- fakes ----
type Spy = Provider & { calls: AskInput[] };
type FakeOpts = { seat: string; cost?: number | null; how?: "billed" | "estimated"; served?: (i: AskInput) => string;
  impl?: (i: AskInput) => Promise<AskResult | void>; text?: (i: AskInput) => string; findings?: (i: AskInput) => { problem: string; fix: string }[] };
function fake(o: FakeOpts): Spy {
  const calls: AskInput[] = [];
  const ask: AskFn = async (input) => {
    calls.push(input);
    // Every fake sends what it was given through the call's wire, as a real adapter does.
    await input.wire.fetch(`https://fake-${o.seat}.example/v1`, { method: "POST", body: JSON.stringify({ system: input.system, user: input.user, brief: input.brief, model: input.model }) });
    const custom = o.impl ? await o.impl(input) : undefined;
    if (custom) return custom;
    const bill = o.cost === null ? null : { usd: o.cost ?? 0.01, how: o.how ?? ("estimated" as const) };
    const served = o.served?.(input) ?? (input.model || `${o.seat}-default`);
    const base = { urls: [] as string[], served, bill, tokens: { input: 10, output: 10 }, searches: 0 };
    if (input.brief) return { ...base, text: "{}", answer: { verdict: "approve_with_changes", findings: (o.findings?.(input) ?? [{ problem: "a real problem", fix: "fix it" }]).map((f, i) => ({ rank: i + 1, ...f })) } };
    if (input.schema) {
      const labels = [...(input.user ?? "").matchAll(/<candidate label="([A-Z]\d\d)">/g)].map((m) => m[1]);
      const research = (input.user ?? "").includes("<question>");
      const outputs = labels.map((label) => research
        ? { label, outcome: "correct", score: 4, reason: "ok", correct: true, complete: true, current: true, citations_checked: 1, citations_supported: 1, acceptable: true }
        : { label, score: 4, reason: "ok", findings: [{ n: 1, real: true, severity: "serious", also_found_by: [], reason: "real" }], adopted_covered: [1] });
      return { ...base, text: JSON.stringify({ outputs }), json: { outputs } };
    }
    return { ...base, text: o.text?.(input) ?? "The answer is 42. https://example.com/a", urls: ["https://example.com/a"] };
  };
  const validate = async (input: any) => { await input.wire.fetch(`https://fake-${o.seat}.example/validate`, { method: "POST", body: JSON.stringify({ model: input.model }) }); return { bill: { usd: 0.0001, how: "estimated" as const } }; };
  return { ask, validate, calls };
}
function fakeCodex(o: Partial<FakeOpts> & { models?: string[] | null; version?: string } = {}): Spy & CodexProvider {
  const f = fake({ seat: "codex", cost: 0, how: "billed", ...o });
  return Object.assign(f, { validate: undefined, version: async () => o.version ?? "codex-cli 0.130.0", models: async () => (o.models === undefined ? ["gpt-6.2-sol", "gpt-6.2-astra"] : o.models) });
}

function rig(o: { budget?: number; reviews?: number; terms?: string; caps?: Partial<RunnerConfig["caps"]>; record?: (i: number) => any;
  providers?: Partial<TrialDeps["providers"]>; stopped?: () => boolean; fetchBody?: any; fetch?: TrialDeps["fetch"]; exec?: TrialDeps["exec"];
  questions?: boolean | object; reviewSeats?: Partial<Record<string, SeatFn>>; inbox?: boolean; timeoutScale?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trials-"));
  const cfg: RunnerConfig = { ...DEFAULTS, caps: { ...DEFAULTS.caps, ...(o.caps ?? {}) }, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), reservePercent: 25 };
  writeFileSync(cfg.termsFile, o.terms ?? TERMS);
  const recordDir = join(dir, "record");
  writeRecord(recordDir, o.reviews ?? 2, o.record);
  if (o.questions) writeQuestions(recordDir, { questions: QUESTIONS }, o.questions);
  let clock = new Date("2026-11-22T15:00:00Z");
  const review = new Runner(cfg, { seats: (o.reviewSeats ?? {}) as any, now: () => clock, rand: () => 0.5, log: () => {}, stopped: o.stopped ?? (() => false) });
  const providers = { claude: fake({ seat: "claude", cost: 0.05 }), gemini: fake({ seat: "gemini", cost: 0.01 }), perplexity: fake({ seat: "perplexity", cost: 0.003, how: "billed" }),
    codex: fakeCodex(), ...(o.providers ?? {}) } as any;
  let seq = 0;
  const fetched: { url: string; body: string }[] = [];
  const deps: TrialDeps = {
    review, providers,
    fetch: o.fetch ?? (async (url: string, init: any) => { fetched.push({ url, body: String(init?.body ?? "") }); return new Response(JSON.stringify(o.fetchBody ?? {}), { status: 200 }); }) as any,
    exec: o.exec,
    now: () => clock, rand: () => ((seq = (seq * 9301 + 49297) % 233280) / 233280), log: () => {},
  };
  const tdir = join(dir, "trials");
  const inboxDir = join(dir, "inbox");
  const trials = new TrialRunner({ dir: tdir, recordDir, budgetUsd: o.budget ?? 40, seatGapMs: 0, timeoutScale: o.timeoutScale, ...(o.inbox ? { inboxDir, inboxUid: process.getuid!() } : {}) }, deps);
  const runAll = async (suite: "review-seats" | "research" = "review-seats", max = 3000) => {
    for (let i = 0; i < max; i++) {
      const ticked = await trials.tick();
      const st = latestRun(tdir, suite);
      if (st?.status !== "running") break;
      if (!ticked) clock = new Date(clock.getTime() + 16 * 60_000);
    }
  };
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  return { dir, tdir, cfg, recordDir, review, trials, deps, providers, fetched, runAll, relays, inboxDir,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}
const outputCalls = (t: ReturnType<typeof rig>) => ["gemini", "codex", "perplexity"].reduce((a, s) => a + t.providers[s].calls.filter((c: AskInput) => !c.schema && c.user !== "ready?").length, 0);
const graderCalls = (t: ReturnType<typeof rig>) => t.providers.claude.calls.filter((c: AskInput) => c.schema).length + t.providers.codex.calls.filter((c: AskInput) => c.schema).length;
const suiteOf = (t: ReturnType<typeof rig>, name = "review-seats"): Suite => JSON.parse(readFileSync(paths(t.tdir).suite(name), "utf8"));

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
    const { tasks, skipped } = pickReviewTasks(dirs);
    expect(tasks.length).toBe(12);
    expect(tasks[0].id).toBe("2026-11-16-r15");
    expect(skipped.join(" ")).toContain("about this trial");
    expect(skipped.join(" ")).toContain("fix-only");
  });
});

describe("the spend bound: hard ceilings in every request", () => {
  test("worst case = steps x (context ceiling at the input price + output cap at the output price) + tool fees, at the dearest list price", () => {
    const t = { id: "q", kind: "fact" as const, sent_text: "x".repeat(300), as_of: DAY, must_contain: "m", sources: [], no_reliable_answer: false };
    const shape = callShape("research", { id: "o", kind: "output", task: "q", config: "claude:claude-opus-5-5+search" }, t);
    const c = ceilingOf(shape, 3_000)!;
    expect(c.steps).toBe(LIMITS.claudeAnswerSearches + 1);
    expect(c.maxOut).toBe(LIMITS.claudeAnswerOut);
    expect(worstOfCeiling(c)).toBeCloseTo(c.steps * (c.contextTokens * 4 + c.maxOut * 20) / 1e6 + 3 * 0.01, 9);
    // Gemini: the thinking budget counts at the output price, and Argon is bounded at its December price in November.
    const g = callShape("review-seats", { id: "o", kind: "output", task: "q", config: "gemini:gemini-4-argon" }, { id: "q", kind: "review", brief: { topic: "t", question: "q", body: "b", needs_facts: false, consequential: false }, originals: [] });
    const gc = ceilingOf(g, 1_000)!;
    expect(gc.maxOut).toBe(LIMITS.geminiReviewOut + LIMITS.geminiThinking);
    expect(gc.price).toEqual({ in: 4, out: 20 });
    // A configuration that can't be given a ceiling is refused.
    expect(ceilingOf({ ...g, thinking: undefined }, 1_000)).toBeNull();
    expect(ceilingOf({ ...callShape("research", { id: "o", kind: "output", task: "q", config: "perplexity:low" }, t), maxSteps: 0 }, 1_000)).toBeNull();
    // Codex: no dollars, one run.
    expect(ceilingOf(callShape("review-seats", { id: "o", kind: "output", task: "q", config: "codex:default" }, { id: "q", kind: "review", brief: { topic: "t", question: "q", body: "b", needs_facts: true, consequential: false }, originals: [] }), 99_999))
      .toMatchObject({ runs: 1, price: { in: 0, out: 0 } });
  });

  test("Claude's request carries max_tokens, max_uses on search and fetch, the current tool types and direct callers", async () => {
    const seen: any[] = [];
    const wire = makeWire({ terms: () => TERMS, exec: null as any, fetch: (async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } },
        content: [{ type: "server_tool_use", name: "web_search", input: { query: "tool releases" } }, { type: "text", text: "Answer.", citations: [{ url: "https://a.example/x" }] }] }), { status: 200 }); }) as any });
    const r = await claudeProvider({ key: "sk-test-key-123456" }).ask({ wire, signal: sig(), day: DAY, model: "claude-opus-5-5", system: "s", user: "u", maxOut: 500, search: true, maxSearches: 3, fetch: true, maxFetches: 2, allowedDomains: ["a.example"] });
    const body = seen[0].body;
    expect(body.max_tokens).toBe(500);
    expect(body.tools).toEqual([
      { type: CLAUDE_SEARCH_TOOL, name: "web_search", max_uses: 3, allowed_callers: ["direct"] },
      { type: CLAUDE_FETCH_TOOL, name: "web_fetch", max_uses: 2, max_content_tokens: LIMITS.claudeFetchTokens, allowed_callers: ["direct"], allowed_domains: ["a.example"] },
    ]);
    expect(CLAUDE_SEARCH_TOOL).toBe("web_search_20260318");
    expect(CLAUDE_FETCH_TOOL).toBe("web_fetch_20260318");
    expect(r.bill).toEqual({ usd: (1000 * 4 + 100 * 20) / 1e6 + 0.02, how: "estimated" });
    expect(r.urls).toEqual(["https://a.example/x"]);
    expect(wire.queries).toEqual(["tool releases"]);
    // A key never comes back in an error.
    const bad = makeWire({ terms: () => TERMS, exec: null as any, fetch: (async () => new Response(JSON.stringify({ error: { message: "bad key sk-test-key-123456" } }), { status: 401 })) as any });
    await expect(claudeProvider({ key: "sk-test-key-123456" }).ask({ wire: bad, signal: sig(), day: DAY, model: "claude-opus-5-5", system: "s", user: "u", maxOut: 5 })).rejects.toThrow(/HTTP 401/);
  });

  test("Gemini's request carries maxOutputTokens and a thinking budget; a grounding redirect gives way to its page's domain", async () => {
    const seen: any[] = [];
    const wire = makeWire({ terms: () => TERMS, exec: null as any, fetch: (async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ modelVersion: "gemini-3.8-flash-002", usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
        candidates: [{ content: { parts: [{ text: "Answer." }] }, groundingMetadata: { webSearchQueries: ["q1"], groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "example.org" } }] } }] }), { status: 200 }); }) as any });
    const r = await geminiProvider({ key: "g-test-key-123456" }).ask({ wire, signal: sig(), day: DAY, model: "gemini-3.8-flash", system: "s", user: "u", maxOut: 6000, thinking: 4096, search: true });
    expect(seen[0].body.generationConfig).toMatchObject({ maxOutputTokens: 6000, thinkingConfig: { thinkingBudget: 4096 } });
    expect(seen[0].body.tools).toEqual([{ googleSearch: {} }]);
    expect(r.urls).toEqual(["https://example.org"]);
    expect(r.bill!.usd).toBeCloseTo((100 * 0.75 + 70 * 3.75) / 1e6 + 0.014, 9);
    expect(wire.queries).toEqual(["q1"]);
  });

  test("Codex runs with no config, no web search, a read-only sandbox, in a fresh empty folder", async () => {
    let cmd: string[] = [];
    const exec = async (c: string[]) => { cmd = c; writeFileSync(c[c.indexOf("-o") + 1], JSON.stringify({ verdict: "approve", findings: [] })); return { code: 0, stdout: "", stderr: "" }; };
    const home = mkdtempSync(join(tmpdir(), "codex-home-")); writeFileSync(join(home, "auth.json"), "{}");
    const wire = makeWire({ terms: () => TERMS, fetch: null as any, exec: exec as any });
    await codexProvider({ home }).ask({ wire, signal: sig(), day: DAY, model: "gpt-6.2-sol", brief: { topic: "t", question: "q", body: "b", needs_facts: true, consequential: false }, maxOut: 0 });
    expect(cmd).toContain("--ignore-user-config");
    expect(cmd.join(" ")).toContain('web_search="disabled"');
    expect(cmd.join(" ")).toContain("--sandbox read-only");
    expect(cmd.join(" ")).toContain(`model_context_window=${LIMITS.codexContextWindow}`);
    expect(cmd.join(" ")).not.toContain('web_search="live"');
  });
});

describe("the spend bound: one atomic check-and-reserve", () => {
  test("a run that would pass the budget makes no call at all, stops, and says so", async () => {
    const t = rig({ budget: 0.3 });
    expect(t.trials.request({ kind: "run", suite: "review-seats" })).toBeNull();
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.status).toBe("stopped");
    expect(st.stop!.reason).toBe("budget");
    expect(st.stop!.detail).toContain("wasn't started");
    expect(outputCalls(t)).toBe(0);
    expect(readBudget(t.tdir).spent_usd).toBeLessThanOrEqual(0.3);
    expect(t.relays().some((r) => r.includes("stopped") && r.includes("trials budget"))).toBe(true);
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(outputCalls(t)).toBe(0);
  });

  test("concurrent admission from two processes admits only what fits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const script = join(dir, "reserve.ts");
    writeFileSync(script, `import { existsSync } from "node:fs";\nimport { Ledger } from ${JSON.stringify(LEDGER)};\nconst [d, go, who] = process.argv.slice(2);\nwhile (!existsSync(go)) await Bun.sleep(1);\nconst r = new Ledger(d).reserve({ suite: "s", run: who, call: "c", attempt: 1, seat: null, usd: 0.3, runs: 0 }, 1.0);\nconsole.log(JSON.stringify(r));\n`);
    const go = join(dir, "go");
    const procs = ["a", "b", "c", "d", "e"].map((w) => Bun.spawn(["bun", script, join(dir, "t"), go, w], { stdout: "pipe", stderr: "pipe" }));
    await Bun.sleep(300);
    writeFileSync(go, "");
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const results = outs.map((o) => JSON.parse(o.trim()));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(results.filter((r) => !r.ok).every((r) => r.reason === "budget")).toBe(true);
    const b = new Ledger(join(dir, "t")).read();
    expect(Object.keys(b.reservations).length).toBe(3);
  });

  test("the reservation is on disk, fsynced and marked dispatched, before the call is sent", async () => {
    let seenState = "";
    const t = rig({ reviews: 1 });
    const gem = fake({ seat: "gemini", impl: async (i) => { if (i.brief) { const b = JSON.parse(readFileSync(paths(t.tdir).budget, "utf8")); seenState = Object.values<any>(b.reservations).map((r) => r.state).join(","); } } });
    t.deps.providers.gemini = gem;
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(seenState).toBe("dispatched");
  });

  test("a crash just before dispatch charges nothing; just after, its worst case once, and the call runs again", async () => {
    const t = rig({ reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    const st = latestRun(t.tdir, "review-seats")!;
    const [first, second] = callsFor(suiteOf(t));
    const dead = new Ledger(t.tdir, `${process.pid}:dead`);
    expect(dead.reserve({ suite: "review-seats", run: st.run, call: first.id, attempt: 1, seat: "gemini", usd: 0.4, runs: 0 }, 40).ok).toBe(true);   // reserved, never dispatched
    const r2 = dead.reserve({ suite: "review-seats", run: st.run, call: second.id, attempt: 1, seat: "gemini", usd: 0.25, runs: 0 }, 40);
    expect(r2.ok).toBe(true); dead.dispatched((r2 as any).id);                                                                                     // dispatched, then the crash
    const fresh = new TrialRunner(t.trials.cfg, t.deps);
    await fresh.tick();
    const b = readBudget(t.tdir);
    expect(Object.keys(b.reservations).length).toBe(0);
    expect(b.entries.filter((e) => e.how === "worst case (cut off)").map((e) => [e.call, e.usd])).toEqual([[second.id, 0.25]]);
    expect(b.entries.some((e) => e.call === first.id)).toBe(false);
    for (let i = 0; i < 500; i++) if (!(await fresh.tick()) && latestRun(t.tdir, "review-seats")!.status !== "running") break;
    const end = latestRun(t.tdir, "review-seats")!;
    expect(end.calls[second.id].status).toBe("done");
    expect(readBudget(t.tdir).entries.filter((e) => e.how === "worst case (cut off)").length).toBe(1);
  });

  test("a missing billed figure keeps the full reservation; a retry reserves again", async () => {
    let n = 0;
    const gem = fake({ seat: "gemini", cost: null, impl: async (i) => { if (i.brief && i.model === "gemini-4-neon" && n++ === 0) throw new SeatError("transient", "HTTP 503: the service had an error"); } });
    const t = rig({ reviews: 1, providers: { gemini: gem } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const b = readBudget(t.tdir);
    const neon = Object.keys(st.calls).find((k) => k.endsWith("gemini:gemini-4-neon"))!;
    const entries = b.entries.filter((e) => e.call === neon);
    expect(entries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(entries.every((e) => e.how === "reserved (no bill)" && Math.abs(e.usd - st.calls[neon].worst_usd!) < 1e-6)).toBe(true);
    expect(st.calls[neon].how).toBe("reserved (no bill)");
  });

  test("a stream cut off after it was sent keeps its worst case", async () => {
    const t = rig({ reviews: 1, providers: { gemini: geminiProvider({ key: "g-test-key-123456" }) },
      fetch: (async (url: string) => {
        if (url.includes(":generateContent") && !url.includes("x")) { /* falls through */ }
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"candidates\":")); c.error(new Error("reset")); } });
        return new Response(body, { status: 200 });
      }) as any });
    // The checks before any spend can't finish against a server that cuts off: the run stops, each cut-off check held at its worst case.
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const b = readBudget(t.tdir);
    expect(b.entries.length).toBeGreaterThan(0);
    expect(b.entries.every((e) => e.how === "reserved (no bill)" && e.usd > 0)).toBe(true);
    expect(latestRun(t.tdir, "review-seats")!.stop!.reason).toBe("unavailable");
  });

  test("both graders are held before a task's first call: grading still runs when outputs run out of budget", async () => {
    const t0 = rig({ reviews: 2 });
    t0.trials.request({ kind: "run", suite: "review-seats" });
    const s = suiteOf(t0);
    const shape = callShape("review-seats", { id: "g", kind: "grade", task: s.tasks[0].id, grader: "claude" }, s.tasks[0]);
    const { gradeCharsBound } = await import("../rootfs/opt/cain/trials/core.ts");
    const hold = worstOf(shape, gradeCharsBound(s, s.tasks[0]))!;
    const t = rig({ reviews: 2, budget: hold + 0.06 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const task1 = suiteOf(t).tasks[0].id, task2 = suiteOf(t).tasks[1].id;
    expect(st.stop!.reason).toBe("budget");
    expect(st.stop!.detail).toContain(task2);
    expect(Object.entries(st.calls).some(([id, c]) => id.startsWith(`out|${task1}`) && c.status === "skipped" && /trials budget/.test(c.error ?? ""))).toBe(true);
    expect(st.calls[`grade|${task1}|claude`].status).toBe("done");
    expect(st.calls[`grade|${task1}|codex`].status).toBe("done");
    expect(Object.keys(st.calls).some((id) => id.startsWith(`out|${task2}|`) && !id.includes("original"))).toBe(false);
    expect(readBudget(t.tdir).spent_usd).toBeLessThanOrEqual(hold + 0.06 + 1e-9);
    expect(Object.keys(readBudget(t.tdir).holds).length).toBe(0);
  });

  test("grading spend counts against the budget and reaches the review service's ledger", async () => {
    const t = rig({ reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(latestRun(t.tdir, "review-seats")!.status).toBe("done");
    const b = readBudget(t.tdir);
    expect(b.entries.find((e) => e.call.endsWith("|claude") && e.call.startsWith("grade|"))!.usd).toBeCloseTo(0.05, 6);
    expect(b.spent_usd).toBeCloseTo(b.entries.reduce((a, e) => a + e.usd, 0), 6);
    const ledger = JSON.parse(readFileSync(t.cfg.spendFile, "utf8"))["2026-11"];
    expect(ledger.claude.usd).toBeGreaterThan(0.05);
    expect(ledger.openai.runs).toBeGreaterThan(0);
  });

  test("trials never spend into the reserve kept for real reviews", async () => {
    // Gemini's cap of $0.30 with a 25% reserve leaves $0.225: Argon's and Carbon's worst cases (about $0.25) don't fit.
    const t = rig({ caps: { gemini: 0.3 }, reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(Object.values(st.calls).some((c) => c.status === "held")).toBe(true);
    expect(st.stop!.reason).toBe("caps");
    const used = JSON.parse(readFileSync(t.cfg.spendFile, "utf8"))["2026-11"].gemini.usd;
    expect(used).toBeLessThanOrEqual(0.225);
  });

  test("nothing is sent while Dane's Stop holds", async () => {
    const t = rig({ stopped: () => true });
    t.trials.request({ kind: "run", suite: "review-seats" });
    for (let i = 0; i < 5; i++) await t.trials.tick();
    expect(t.fetched.length).toBe(0);
  });
});

describe("the private-terms check on the final request", () => {
  test("the wire blocks a term anywhere in the serialized body (tool arguments, escapes) and in Codex's command, files and environment", async () => {
    let sent = 0;
    const w = makeWire({ terms: () => TERMS, fetch: (async () => { sent++; return new Response("{}"); }) as any, exec: (async () => { sent++; return { code: 0, stdout: "", stderr: "" }; }) as any });
    await expect(w.fetch("https://x.example", { method: "POST", body: JSON.stringify({ tools: [{ input: { query: "where does Pat work" } }] }) })).rejects.toBeInstanceOf(PrivacyBlock);
    await expect(w.fetch("https://x.example", { method: "POST", body: '{"a":"Acme\\u0020Corp"}' })).rejects.toBeInstanceOf(PrivacyBlock);
    const f = join(mkdtempSync(join(tmpdir(), "wire-")), "schema.json"); writeFileSync(f, "{\"title\": \"for Pat\"}");
    await expect(w.exec(["codex", "exec", "--output-schema", f, "hello"], { env: {}, signal: sig() })).rejects.toBeInstanceOf(PrivacyBlock);
    await expect(w.exec(["codex", "exec", "hello"], { env: { X: "Acme Corp" }, signal: sig() })).rejects.toBeInstanceOf(PrivacyBlock);
    expect(sent).toBe(0);
    await w.fetch("https://x.example", { method: "POST", body: JSON.stringify({ a: "fine" }) });
    expect(sent).toBe(1);
  });

  test("a term added only at assembly (an adapter's own text) is caught on the wire: nothing sent, nothing charged", async () => {
    const gem = fake({ seat: "gemini", impl: async () => undefined });
    const leaky: Spy = { ...gem, ask: async (i) => { gem.calls.push(i); await i.wire.fetch("https://g.example", { method: "POST", body: JSON.stringify({ systemInstruction: "Remember Pat." }) }); throw new Error("unreachable"); } };
    const t = rig({ reviews: 1, providers: { gemini: leaky } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const blocked = Object.entries(st.calls).filter(([id, c]) => id.includes("|gemini:") && c.status === "blocked");
    expect(blocked.length).toBe(5);
    expect(blocked.every(([, c]) => /on the wire/.test(c.error!) && c.cost_usd === 0)).toBe(true);
    expect(t.fetched.some((f) => f.url === "https://g.example")).toBe(false);
    expect(readBudget(t.tdir).entries.some((e) => e.call.includes("|gemini:"))).toBe(false);
  });

  test("stored briefs and adopted notes are checked when the suite is built", async () => {
    const t = rig({ reviews: 2, record: (i) => (i === 0 ? { body: "Ask Pat about the lock." } : i === 1 ? { adopted: "- tell Acme Corp\n" } : {}) });
    t.trials.request({ kind: "run", suite: "review-seats" });
    const s = suiteOf(t);
    const t0 = s.tasks.find((x) => x.id.includes("plan-0"))! as any, t1 = s.tasks.find((x) => x.id.includes("plan-1"))! as any;
    expect(t0.notes.join(" ")).toContain("calls are blocked");
    expect(t1.adopted).toBeNull();
    expect(t1.notes.join(" ")).toContain("recall isn't graded");
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    for (const [id, c] of Object.entries(st.calls)) if (id.startsWith("out|") && id.includes("plan-0") && !id.includes("original")) expect(c.status).toBe("blocked");
    for (const [id, c] of Object.entries(st.calls)) if (id.startsWith("grade|") && id.includes("plan-0")) expect(c.status).not.toBe("done");
    for (const f of t.fetched) { expect(f.body).not.toContain("Pat"); expect(f.body).not.toContain("Acme"); }
  });

  test("a model output carrying a private term blocks its task's grading", async () => {
    const t = rig({ reviews: 1, providers: { perplexity: fake({ seat: "perplexity", findings: () => [{ problem: "Acme Corp is named", fix: "x" }] }) } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(Object.entries(st.calls).filter(([id]) => id.startsWith("grade|")).every(([, c]) => c.status === "blocked")).toBe(true);
    expect(graderCalls(t)).toBe(0);
  });

  test("research: only the checked sent text leaves; a question whose text carries a term isn't kept", async () => {
    const t = rig({ questions: true });
    expect(t.trials.request({ kind: "run", suite: "research" })).toBeNull();
    await t.runAll("research");
    expect(t.fetched.length).toBeGreaterThan(0);
    for (const f of t.fetched) expect(f.body).not.toContain("SECRET-CONTEXT");
    const t2 = rig();
    writeQuestions(t2.recordDir, { questions: QUESTIONS.map((q, i) => (i === 7 ? { ...q, sent_text: "What does Acme Corp charge?" } : q)) });
    expect(t2.trials.request({ kind: "run", suite: "research" })).toContain("blocked: privacy");
    expect(existsSync(paths(t2.tdir).suite("research"))).toBe(false);
  });

  test("a provider's own search queries are logged and checked: a hit raises an alarm and stops the run", async () => {
    const t = rig({ reviews: 1, fetchBody: { candidates: [{ groundingMetadata: { webSearchQueries: ["Pat lock policy"] } }] } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.stop!.reason).toBe("privacy");
    expect(t.relays().some((r) => r.startsWith("Trials alarm") && r.includes("search queries"))).toBe(true);
    const outFile = readdirSync(join(paths(t.tdir).run("review-seats", st.run), "outputs")).map((f) => JSON.parse(readFileSync(join(paths(t.tdir).run("review-seats", st.run), "outputs", f), "utf8"))).find((o) => o.queries?.length);
    expect(outFile.queries).toContain("Pat lock policy");
  });

  test("with no private-terms list nothing leaves", async () => {
    const t = rig({ reviews: 1 });
    writeFileSync(t.cfg.termsFile, "");
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(t.fetched.length).toBe(0);
  });
});

describe("Codex isolation", () => {
  test("canary: a key.json and a private term beside the working folder never reach Codex", async () => {
    const t = rig({ reviews: 1 });
    // The trials folder holds the blind key and a private note, as in production.
    mkdirSync(t.tdir, { recursive: true });
    writeFileSync(join(t.tdir, "key.json"), JSON.stringify({ A10: "CANARY-KEY-7f3a" }));
    writeFileSync(join(t.tdir, "note.txt"), "Pat CANARY-NOTE-91b2");
    const home = mkdtempSync(join(tmpdir(), "codex-home-")); writeFileSync(join(home, "auth.json"), "{}");
    const seen: { cmd: string[]; env: Record<string, string>; workEntries: string[]; files: string[] }[] = [];
    const exec = async (cmd: string[], o: { env: Record<string, string> }) => {
      const files: string[] = [];
      for (const a of cmd) try { if (a.startsWith("/") && statSync(a).isFile()) files.push(readFileSync(a, "utf8")); } catch { /* not a file */ }
      const work = cmd.includes("-C") ? cmd[cmd.indexOf("-C") + 1] : "";
      seen.push({ cmd, env: o.env, workEntries: work ? readdirSync(work) : [], files });
      if (cmd[1] === "--version") return { code: 0, stdout: "codex-cli 0.130.0\n", stderr: "" };
      if (cmd[1] === "debug") return { code: 0, stdout: JSON.stringify({ models: [{ slug: "gpt-6.2-sol" }, { slug: "gpt-6.2-astra" }] }), stderr: "" };
      const out = cmd[cmd.indexOf("-o") + 1];
      const schema = cmd.includes("--output-schema") ? readFileSync(cmd[cmd.indexOf("--output-schema") + 1], "utf8") : "";
      if (schema.includes("adopted_covered")) {
        const labels = [...cmd[cmd.length - 1].matchAll(/<candidate label="([A-Z]\d\d)">/g)].map((m) => m[1]);
        writeFileSync(out, JSON.stringify({ outputs: labels.map((label) => ({ label, score: 3, reason: "ok", findings: [], adopted_covered: [] })) }));
      } else writeFileSync(out, JSON.stringify({ verdict: "approve", findings: [{ rank: 1, problem: "p", fix: "f" }] }));
      return { code: 0, stdout: "", stderr: "" };
    };
    t.deps.exec = exec as any;
    t.deps.providers.codex = codexProvider({ home });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    expect(latestRun(t.tdir, "review-seats")!.status).toBe("done");
    const asks = seen.filter((s) => s.cmd[1] === "exec");
    expect(asks.length).toBe(4);   // three review configurations and one grading call
    for (const s of seen) {
      const all = [...s.cmd, ...Object.values(s.env), ...s.files].join("\n");
      for (const canary of ["CANARY-KEY-7f3a", "CANARY-NOTE-91b2", "Pat", t.tdir, "/data/"]) expect(all).not.toContain(canary);
      expect(s.workEntries).toEqual([]);
      expect(Object.keys(s.env).sort()).toEqual(["CODEX_HOME", "HOME", "LANG", "PATH"]);
    }
    for (const s of asks) {
      expect(s.cmd).toContain("--ignore-user-config");
      expect(s.cmd).toContain('web_search="disabled"');
      expect(s.cmd[s.cmd.indexOf("--sandbox") + 1]).toBe("read-only");
    }
  });

  test("a Codex answer that used a tool isn't kept", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-")); writeFileSync(join(home, "auth.json"), "{}");
    const exec = async (cmd: string[]) => { writeFileSync(cmd[cmd.indexOf("-o") + 1], "{\"verdict\":\"approve\",\"findings\":[]}");
      return { code: 0, stdout: `${JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "cat /data/x" } })}\n`, stderr: "" }; };
    const wire = makeWire({ terms: () => TERMS, fetch: null as any, exec: exec as any });
    await expect(codexProvider({ home }).ask({ wire, signal: sig(), day: DAY, model: "", brief: { topic: "t", question: "q", body: "b", needs_facts: false, consequential: false }, maxOut: 0 }))
      .rejects.toThrow(/used a tool/);
  });
});

describe("the Perplexity contract", () => {
  test("a preset by name, the model pinned, hard limits, its own bill, output message items, the served model and its queries", async () => {
    const seen: any[] = [];
    const wire = makeWire({ terms: () => TERMS, exec: null as any, fetch: (async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: "completed", model: "perplexity/sonar-pro",
        output: [{ type: "search_results", queries: ["tool release 2026"], results: [{ url: "https://c.example/r" }] },
          { type: "message", content: [{ type: "output_text", text: "Answer https://b.example/y", annotations: [{ type: "citation", url: "https://b.example/y" }] }] }],
        usage: { input_tokens: 10, output_tokens: 10, cost: { currency: "USD", total_cost: 0.0123 } } }), { status: 200 }); }) as any });
    const r = await perplexityProvider({ key: "pplx-test-key-123" }).ask({ wire, signal: sig(), day: DAY, model: "perplexity/sonar", setting: "low", system: "s", user: "u", maxOut: 400, maxSteps: 3, search: true });
    const body = seen[0].body;
    expect(body.preset).toBe("low");
    expect(body.model).toBe("perplexity/sonar");
    expect(body.max_steps).toBe(3);
    expect(body.max_output_tokens).toBe(400);
    expect(body.tools).toEqual([{ type: "web_search", max_tokens: LIMITS.perplexitySearchTokens }]);
    expect(JSON.stringify(body)).not.toContain("fetch_url");
    expect(r.bill).toEqual({ usd: 0.0123, how: "billed" });
    expect(r.text).toBe("Answer https://b.example/y");
    expect(r.served).toBe("perplexity/sonar-pro");
    expect(r.urls.sort()).toEqual(["https://b.example/y", "https://c.example/r"]);
    expect(wire.queries).toEqual(["tool release 2026"]);
  });

  test("without the owner's approval the levels are pinned to Perplexity's own model", async () => {
    const t = rig({ questions: true });
    t.trials.request({ kind: "run", suite: "research" });
    await t.runAll("research");
    const asks = t.providers.perplexity.calls as AskInput[];
    expect(asks.length).toBe(90);
    expect(asks.every((c) => c.model === "perplexity/sonar")).toBe(true);
    expect([...new Set(asks.map((c) => c.setting))].sort()).toEqual(["fast", "low", "medium"]);
  });

  test("an output served by another lab's model is labelled so, and that lab's grader never reads it", async () => {
    const pp = fake({ seat: "perplexity", cost: 0.004, how: "billed", served: (i) => (i.setting === "medium" ? "openai/gpt-6.2-sol" : "perplexity/sonar") });
    const t = rig({ questions: { perplexity_third_party_routing: true }, providers: { perplexity: pp } });
    t.trials.request({ kind: "run", suite: "research" });
    await t.runAll("research");
    const st = latestRun(t.tdir, "research")!;
    expect(st.status).toBe("done");
    expect((pp.calls as AskInput[]).every((c) => c.model === "")).toBe(true);   // approved: unpinned
    const key = JSON.parse(readFileSync(paths(t.tdir).key("research", st.run), "utf8"));
    for (const c of t.providers.codex.calls as AskInput[]) {
      if (!c.schema) continue;
      const task = /As of [\d-]+: What is the current release of tool number (\d+)/.exec(c.user!)![1];
      const labels = [...c.user!.matchAll(/<candidate label="([A-Z]\d\d)">/g)].map((m) => m[1]);
      const tk = key[`q${String(task).padStart(2, "0")}`];
      for (const l of labels) expect(tk[l]).not.toContain("perplexity:medium");
    }
    for (const c of t.providers.claude.calls as AskInput[]) {
      if (!c.schema) continue;
      const labels = [...c.user!.matchAll(/<candidate label="([A-Z]\d\d)">/g)].map((m) => m[1]);
      const task = /tool number (\d+)/.exec(c.user!)![1];
      for (const l of labels) expect(key[`q${task.padStart(2, "0")}`][l]).not.toContain("claude:");
    }
    const report = buildReport(t.tdir, "research", 40);
    expect(report).toContain("perplexity:medium (served by openai/gpt-6.2-sol) [another lab's model: openai]");
    expect(report).toContain("own family, not graded");
  });
});

describe("Codex model discovery", () => {
  test("a model the catalog doesn't list is skipped as not listed; with no catalog, a tiny probe decides, refused said apart", async () => {
    const t = rig({ reviews: 1, providers: { codex: fakeCodex({ models: ["gpt-6.2-sol"] }) } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.preflight!.codex_version).toBe("codex-cli 0.130.0");
    expect(st.preflight!.skip["codex:gpt-6.2-astra"]).toContain("not listed");
    expect(Object.entries(st.calls).find(([id]) => id.endsWith("codex:gpt-6.2-astra"))![1].error).toContain("not listed");
    expect(buildReport(t.tdir, "review-seats", 40)).toContain("codex-cli 0.130.0");

    const probe = fakeCodex({ models: null, impl: async (i) => { if (i.model === "gpt-6.2-astra") throw new SeatError("refused", "Codex: error: model 'gpt-6.2-astra' is not supported"); } });
    const t2 = rig({ reviews: 1, providers: { codex: probe } });
    t2.trials.request({ kind: "run", suite: "review-seats" });
    await t2.runAll();
    const st2 = latestRun(t2.tdir, "review-seats")!;
    expect(st2.preflight!.skip["codex:gpt-6.2-astra"]).toContain("refused by the installed Codex");
    expect(st2.preflight!.skip["codex:gpt-6.2-sol"]).toBeUndefined();
    expect((probe.calls as AskInput[]).filter((c) => c.user === "ready?").map((c) => c.model).sort()).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
    // Each probe counted one Codex run.
    expect(JSON.parse(readFileSync(t2.cfg.spendFile, "utf8"))["2026-11"].openai.runs).toBeGreaterThanOrEqual(2);
    expect(CODEX_NO_MODEL.test("unknown model foo")).toBe(true);
  });
  test("the catalog is read whatever its nesting", () => {
    expect(modelsFromCatalog({ models: [{ slug: "gpt-6.2-sol" }, { slug: "gpt-6.2-astra", display_name: "Astra" }] })!.sort()).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
    expect(modelsFromCatalog({ models: { "gpt-6.2-sol": {}, "o9": {} } })).toContain("o9");
    expect(modelsFromCatalog({})).toBeNull();
  });
});

describe("blind grading made blind", () => {
  const DIRTY = "As Gemini from Google, I found [1] and [2, 3] 【4†source】[^1] a problem. See https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc and https://developers.google.com/x\ntool: web_search {\"q\":\"x\"}\ntokens used: 1234\nGPT-6.2 and Claude Opus agree; Perplexity Sonar, OpenAI Codex and Anthropic too.";
  test("normalization strips envelopes, markers, traces, CLI lines and self-naming, and keeps real URLs", () => {
    const n = normalizeCandidate(DIRTY);
    expect(n).not.toMatch(/\[\d/);
    expect(n).not.toContain("【");
    expect(n).not.toContain("grounding-api-redirect");
    expect(n).not.toContain("tokens used");
    expect(n).not.toContain("tool:");
    expect(n).toContain("https://developers.google.com/x");
    expect(blindViolations(n)).toEqual([]);
    expect(blindViolations(DIRTY).length).toBeGreaterThan(3);
  });

  test("every grader prompt is free of model and provider names and marker patterns, holds the untrusted-data rule, and orders candidates on its own", async () => {
    const dirty = (seat: string) => fake({ seat, cost: seat === "codex" ? 0 : 0.01, findings: () => [{ problem: DIRTY, fix: "Ask Claude [7]" }], text: () => DIRTY });
    const t = rig({ reviews: 2, providers: { gemini: dirty("gemini"), perplexity: dirty("perplexity"), codex: Object.assign(fakeCodex(), { ask: dirty("codex").ask }) },
      record: (i) => ({ body: `Gemini and OpenAI review seats, plan ${i} [3].` }) });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const prompts = [...t.providers.claude.calls].filter((c: AskInput) => c.schema).map((c: AskInput) => `${c.system}\n${c.user}`);
    expect(prompts.length).toBe(2);
    for (const p of prompts) {
      const bare = p.replace(/https?:\/\/\S+/g, " ");
      expect(bare.match(SELF_NAMES)).toBeNull();
      expect(bare).not.toMatch(/\[\d+(?:\s*,\s*\d+)*\]|【|\[\^\d+\]|grounding-api-redirect|tokens used/);
      expect(blindViolations(p)).toEqual([]);
      expect(p).toContain("untrusted data");
    }
    // The key never reaches a grader.
    const st = latestRun(t.tdir, "review-seats")!;
    const keyText = readFileSync(paths(t.tdir).key("review-seats", st.run), "utf8");
    for (const p of prompts) { expect(p).not.toContain(keyText); for (const c of REVIEW_CONFIGS) expect(p).not.toContain(c.id); }
  });

  test("candidate order is shuffled for each grader call on its own", () => {
    const task = { id: "t", kind: "review" as const, brief: { topic: "t", question: "q", body: "b", needs_facts: false, consequential: false }, originals: [] };
    const outs = ["A10", "B20", "C30", "D40", "E50", "F60"].map((label, i) => ({ label, output: { call: "", config: "", verdict: "approve", findings: [{ problem: `p${i}`, fix: "f" }] } }));
    const { shuffled } = require("../rootfs/opt/cain/trials/core.ts");
    let s = 7; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const a = gradePrompt(task, shuffled(outs, rand)).user, b = gradePrompt(task, shuffled(outs, rand)).user;
    const order = (u: string) => [...u.matchAll(/label="([A-Z]\d\d)"/g)].map((m) => m[1]).join(",");
    expect(order(a)).not.toBe(order(b));
  });

  test("no grader grades its own family; the report shows each grader beside the combined score", async () => {
    const t = rig({ reviews: 1 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    const key = JSON.parse(readFileSync(paths(t.tdir).key("review-seats", st.run), "utf8"));
    const task = Object.keys(key)[0];
    const codexGrade = (t.providers.codex.calls as AskInput[]).find((c) => c.schema)!;
    const codexLabels = [...codexGrade.user!.matchAll(/<candidate label="([A-Z]\d\d)">/g)].map((m) => key[task][m[1]]);
    expect(codexLabels.some((c: string) => c.includes("codex:") || c.includes("original:openai"))).toBe(false);
    expect(codexLabels.some((c: string) => c.includes("gemini:"))).toBe(true);
    const report = buildReport(t.tdir, "review-seats", 40);
    expect(report).toContain("| Score, Claude | Score, OpenAI | Combined (all tasks) | Combined (matched) |");
    expect(report).toMatch(/codex:default[^\n]*own family, not graded/);
    expect(report).toContain("Recall of adopted notes");
  });

  test("labels are random and unique; grades keep only given labels and every field is checked", () => {
    let s = 1; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const key = makeLabels(["a", "b", "c", "d"], rand);
    expect(Object.keys(key).length).toBe(4);
    const ok = parseGrades({ outputs: [{ label: "A10", score: 3, reason: "x", findings: [], adopted_covered: [1, 9] }, { label: "Z99", score: 5 }] }, "review", ["A10"], 2);
    expect(ok.grades!.map((g) => g.label)).toEqual(["A10"]);
    expect(ok.grades![0].adopted_covered).toEqual([1]);
    expect(parseGrades({ outputs: [{ label: "A10", score: 9 }] }, "review", ["A10"]).error).toContain("score");
    expect(parseGrades({ outputs: [{ label: "A10", score: 3 }] }, "fact", ["A10"]).error).toContain("outcome");
    const a = { label: "A10", score: 5, reason: "", findings: [{ n: 1, real: true, severity: "serious" as const, also_found_by: [], reason: "" }] };
    expect(disagreements(a, { ...a, score: 2, findings: [{ ...a.findings[0], severity: "wrong" as const }] })).toEqual(["scores 5 and 2", "finding 1: serious and wrong"]);
  });
});

describe("real reviews first", () => {
  const brief = (id: string): Brief => ({ id, topic: "A plan", question: "Sound?", body: "Run it as its own user.", needs_facts: false, consequential: false });
  const seat: SeatFn = async () => ({ verdict: "approve", findings: [], model: "m", cost_usd: 0.001 });
  async function toPreflightDone(t: ReturnType<typeof rig>) {
    for (let i = 0; i < 50; i++) { await t.trials.tick(); if (latestRun(t.tdir, "review-seats")!.preflight?.done) return; }
    throw new Error("preflight didn't finish");
  }
  test("a hung trial call is aborted at its deadline and doesn't delay a queued review", async () => {
    const hung = fake({ seat: "gemini", impl: (i) => (i.brief ? new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new SeatError("timeout", "aborted")))) : Promise.resolve(undefined)) });
    const t = rig({ reviews: 1, providers: { gemini: hung }, reviewSeats: { openai: seat, gemini: seat, perplexity: seat, claude: seat }, timeoutScale: 0.002 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await toPreflightDone(t);
    let trialDone = false;
    const tp = t.trials.tick().then(() => { trialDone = true; });
    saveReview(t.cfg.queueDir, newReview(brief("2026-11-22-hung"), t.now()));
    await t.review.tick();
    expect(FINAL).toContain(loadReview(t.cfg.queueDir, "2026-11-22-hung")!.status);
    expect(trialDone).toBe(false);
    await tp;
    const st = latestRun(t.tdir, "review-seats")!;
    expect(Object.values(st.calls).some((c) => /timeout/.test(c.error ?? ""))).toBe(true);
  });

  test("a review arriving mid-trial runs first; the trial goes on after it", async () => {
    const t = rig({ reviews: 1, reviewSeats: { openai: seat, gemini: seat, perplexity: seat, claude: seat } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await toPreflightDone(t);
    await t.trials.tick();
    const before = outputCalls(t);
    saveReview(t.cfg.queueDir, newReview(brief("2026-11-22-mid"), t.now()));
    expect(await t.trials.tick()).toBe(false);
    expect(await t.trials.tick()).toBe(false);
    expect(outputCalls(t)).toBe(before);
    await t.review.tick();
    expect(await t.trials.tick()).toBe(true);
    expect(outputCalls(t)).toBe(before + 1);
  });

  test("a 429 on a seat cools it; the other seats go on", async () => {
    let n = 0;
    const gem = fake({ seat: "gemini", impl: async (i) => { if (i.brief && n++ === 0) throw new SeatError("quota", "HTTP 429: rate limited"); } });
    const t = rig({ reviews: 1, providers: { gemini: gem } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await toPreflightDone(t);
    await t.trials.tick();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.cool.gemini).toBeDefined();
    const geminiBefore = gem.calls.length;
    for (let i = 0; i < 4; i++) await t.trials.tick();
    expect(gem.calls.length).toBe(geminiBefore);
    expect(outputCalls(t)).toBeGreaterThan(geminiBefore);
    expect(readBudget(t.tdir).entries.some((e) => e.call.endsWith("gemini:gemini-4-argon"))).toBe(false);   // a 429 isn't billed
  });
});

describe("prices and the checks before any spend", () => {
  test("the Nov 2026 list prices", () => {
    expect(TRIAL_PRICES["claude-opus-5-5"]).toEqual([{ in: 4, out: 20 }]);
    expect(datedPrice("gemini-4-argon", "2026-11-30")).toMatchObject({ in: 2, out: 10 });
    expect(datedPrice("gemini-4-carbon", "2026-12-01")).toMatchObject({ in: 4, out: 20 });
    expect(datedPrice("gemini-4-neon", DAY)).toMatchObject({ in: 3, out: 15 });
    expect(datedPrice("gemini-4-hydrogen", DAY)).toMatchObject({ in: 1.5, out: 7.5 });
    expect(datedPrice("gemini-3.8-flash", DAY)).toMatchObject({ in: 0.75, out: 3.75 });
    expect(datedPrice("gpt-6.2-sol", DAY)).toMatchObject({ in: 2, out: 10 });
    expect(datedPrice("gpt-6.2-astra", DAY)).toMatchObject({ in: 8, out: 40 });
    expect(ceilingPrice("gemini-4-argon")).toEqual({ in: 4, out: 20 });
    expect(ceilingPrice("someone-new")).toEqual({ in: 10, out: 50 });
  });

  test("Claude refusing the tool setup stops the run before any trial call", async () => {
    const claude = fake({ seat: "claude" });
    claude.validate = async () => { throw new SeatError("refused", "HTTP 400: the service refused the request"); };
    const t = rig({ reviews: 1, providers: { claude } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.stop!.reason).toBe("unavailable");
    expect(st.stop!.detail).toContain("Claude refused");
    expect(outputCalls(t)).toBe(0);
  });

  test("a Gemini model not served is skipped; today's default not served stops the run before any spend", async () => {
    const gem = fake({ seat: "gemini" });
    gem.validate = async (i: any) => { if (i.model === "gemini-4-neon") throw new SeatError("refused", "HTTP 404: the service refused the request"); return { bill: { usd: 0.0001, how: "estimated" as const } }; };
    const t = rig({ reviews: 1, providers: { gemini: gem } });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st = latestRun(t.tdir, "review-seats")!;
    expect(st.status).toBe("done");
    expect(st.preflight!.skip["gemini:gemini-4-neon"]).toContain("isn't served");
    expect(gem.calls.some((c) => c.model === "gemini-4-neon")).toBe(false);

    const gem2 = fake({ seat: "gemini" });
    gem2.validate = async (i: any) => { if (i.model === "gemini-3.8-flash") throw new SeatError("refused", "HTTP 404: the service refused the request"); return { bill: { usd: 0.0001, how: "estimated" as const } }; };
    const t2 = rig({ reviews: 1, providers: { gemini: gem2 } });
    t2.trials.request({ kind: "run", suite: "review-seats" });
    await t2.runAll();
    const st2 = latestRun(t2.tdir, "review-seats")!;
    expect(st2.stop!.detail).toContain("today's default Gemini model");
    expect(outputCalls(t2)).toBe(0);
  });
});

describe("inbox trust", () => {
  test("only a known suite and the command: no budget, no configurations, no path", () => {
    expect(requestError({ kind: "run", suite: "review-seats" })).toBeNull();
    expect(requestError({ kind: "run", suite: "review-seats", mode: "retry" })).toBeNull();
    expect(requestError({ kind: "run", suite: "../../etc/passwd" })).toContain("not a suite");
    expect(requestError({ kind: "run", suite: "research/../review-seats" })).toContain("not a suite");
    expect(requestError({ kind: "run", suite: "review-seats", budget_usd: 500 })).toContain("may not");
    expect(requestError({ kind: "run", suite: "review-seats", configs: ["x"] })).toContain("may not");
    expect(requestError({ kind: "run", suite: "review-seats", run: "../x" })).toContain("may not");
    expect(requestError({ kind: "run", suite: "review-seats", questions: [] })).toContain("may not");
    expect(requestError({ kind: "run", suite: "review-seats", mode: "../x" })).toContain("mode");
  });
  test("a request with a budget field is refused at the inbox and starts nothing", async () => {
    const t = rig({ reviews: 1, inbox: true });
    mkdirSync(t.inboxDir, { recursive: true });
    writeFileSync(join(t.inboxDir, "1-run.json"), JSON.stringify({ kind: "run", suite: "review-seats", budget_usd: 500 }));
    writeFileSync(join(t.inboxDir, "2-run.json"), JSON.stringify({ kind: "run", suite: "../../trials" }));
    await t.trials.tick();
    expect(latestRun(t.tdir, "review-seats")).toBeNull();
    expect(existsSync(paths(t.tdir).suite("review-seats"))).toBe(false);
    expect(t.relays().filter((r) => r.includes("wasn't taken")).length).toBe(2);
    expect(readdirSync(t.inboxDir).length).toBe(0);
    expect(t.trials.budget).toBe(40);
  });
});

describe("the research suite's design", () => {
  test("questions are time-anchored, with dated sources for their answer notes", () => {
    expect(checkQuestions({ questions: QUESTIONS }).tasks!.length).toBe(30);
    expect(checkQuestions({ questions: QUESTIONS.slice(1) }).error).toContain("15 fact");
    expect(checkQuestions({ questions: QUESTIONS.map((q, i) => (i === 2 ? { ...q, as_of: undefined } : q)) }).error).toContain("as_of");
    expect(checkQuestions({ questions: QUESTIONS.map((q, i) => (i === 2 ? { ...q, sources: [{ url: "https://x.example" }] } : q)) }).error).toContain("read_on");
    expect(checkQuestions({ questions: QUESTIONS.map((q, i) => (i === 2 ? { ...q, sent_text: "" } : q)) }).error).toContain("sent_text");
    expect(checkQuestions({ questions: QUESTIONS.map((q) => ({ ...q, no_reliable_answer: false })) }).error).toContain("at least 3");
  });

  test("the runner refuses the suite until the owner's approval names the questions, and stops if they change", async () => {
    const t = rig();
    writeQuestions(t.recordDir, { questions: QUESTIONS }, false);
    expect(t.trials.request({ kind: "run", suite: "research" })).toContain("hasn't approved");
    writeQuestions(t.recordDir, { questions: QUESTIONS }, { approved_by: "cain" });
    expect(t.trials.request({ kind: "run", suite: "research" })).toContain("owner approved");
    writeQuestions(t.recordDir);
    expect(t.trials.request({ kind: "run", suite: "research" })).toBeNull();
    // The questions change after the suite is frozen: nothing is sent.
    writeFileSync(join(t.recordDir, RESEARCH_QUESTIONS), JSON.stringify({ questions: QUESTIONS.slice().reverse() }));
    await t.runAll("research");
    const st = latestRun(t.tdir, "research")!;
    expect(st.stop!.reason).toBe("approval");
    expect(t.fetched.length).toBe(0);
  });

  test("the abstention rubric, matched sets, coverage, denominators, and no difference within the noise", async () => {
    const claudeAnswers = fake({ seat: "claude", cost: 0.05 });
    const t = rig({ questions: true, providers: { claude: claudeAnswers } });
    t.trials.request({ kind: "run", suite: "research" });
    await t.runAll("research");
    const st = latestRun(t.tdir, "research")!;
    expect(st.status).toBe("done");
    // Graders are told the date and the abstention outcomes.
    const g = (claudeAnswers.calls as AskInput[]).find((c) => c.schema)!;
    expect(g.system).toContain("as of 2026-11-20");
    expect(g.system).toContain("right_abstention");
    expect(g.system).toContain("confident_wrong");
    expect(g.fetch).toBe(true);
    expect(g.allowedDomains).toEqual(["example.com"]);
    const report = buildReport(t.tdir, "research", 40);
    expect(report).toContain("matched set: the 30 tasks");
    expect(report).toContain("Rubric points: correct 2");
    expect(report).toContain("no clear difference");
    // Perplexity is billed: a cost per acceptable answer with its denominators. Gemini and Claude are estimates: none.
    expect(report).toMatch(/perplexity:fast[^\n]*\(\$0\.0900 billed over 30 acceptable of 30 graded\)/);
    expect(report).toMatch(/gemini:gemini-3\.8-flash\+search[^\n]*not given: some costs are estimates/);
    expect(report).toMatch(/30\/30; grades claude 30, codex 30; missing 0/);
  });
});

describe("the plan and trial.sh", () => {
  test("planOf lists every call with its ceilings and worst case, and makes no call", () => {
    const t = rig({ reviews: 2 });
    const { tasks } = pickReviewTasks(reviewDirs(t.recordDir));
    const suite: Suite = { format: 2, name: "review-seats", created_at: "", tasks, skipped: [] };
    const p = planOf(suite);
    expect(p.lines.length).toBe(2 * (REVIEW_CONFIGS.length + GRADERS.length));
    expect(p.refused).toEqual([]);
    expect(p.lines.find((l) => l.who === "gemini:gemini-4-argon")!.limits).toContain("thinkingBudget");
    expect(p.lines.find((l) => l.who === "perplexity:sonar")!.limits).toContain("max_steps 3");
    expect(t.fetched.length).toBe(0);
    expect(RESEARCH_CONFIGS.find((c) => c.id === "perplexity:fast")!.setting).toBe("fast");
  });

  test("trial.sh plan prints the ceilings and the total and leaves nothing; run leaves only the suite and the command", () => {
    const t = rig({ reviews: 2 });
    const env = { ...process.env, TRIALS_DIR: t.tdir, TRIALS_INBOX: join(t.dir, "inbox"), RECORD_DIR: t.recordDir, CAIN_STOP_FILE: join(t.dir, "stop.json") };
    const r = spawnSync("bun", [CLI, "plan", "review-seats"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No call is made");
    expect(r.stdout).toContain("max_tokens 16000 (thinking included)");
    expect(r.stdout).toContain("Total worst case");
    expect(existsSync(join(t.dir, "inbox"))).toBe(false);
    const r2 = spawnSync("bun", [CLI, "run", "research"], { encoding: "utf8", env });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("questions file");
    writeQuestions(t.recordDir);
    const r3 = spawnSync("bun", [CLI, "plan", "research"], { encoding: "utf8", env });
    expect(r3.stdout).toContain("approved by the owner");
    expect(r3.stdout).toContain("pinned to Perplexity's own model");
    const r4 = spawnSync("bun", [CLI, "run", "review-seats", "--retry"], { encoding: "utf8", env });
    expect(r4.status).toBe(0);
    const files = readdirSync(join(t.dir, "inbox"));
    expect(files.length).toBe(1);
    expect(JSON.parse(readFileSync(join(t.dir, "inbox", files[0]), "utf8"))).toEqual({ kind: "run", suite: "review-seats", mode: "retry" });
  });
});

describe("resumption", () => {
  test("a stopped suite resumes without re-running finished calls or counting spend twice", async () => {
    const t0 = rig({ reviews: 2 });
    t0.trials.request({ kind: "run", suite: "review-seats" });
    const s = suiteOf(t0);
    const { gradeCharsBound } = await import("../rootfs/opt/cain/trials/core.ts");
    const hold = worstOf(callShape("review-seats", { id: "g", kind: "grade", task: s.tasks[0].id, grader: "claude" }, s.tasks[0]), gradeCharsBound(s, s.tasks[0]))!;
    const t = rig({ reviews: 2, budget: hold + 0.06 });
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st1 = latestRun(t.tdir, "review-seats")!;
    expect(st1.stop!.reason).toBe("budget");
    const made1 = outputCalls(t);
    t.trials.cfg.budgetUsd = 40;
    t.trials.request({ kind: "run", suite: "review-seats" });
    await t.runAll();
    const st2 = latestRun(t.tdir, "review-seats")!;
    expect(st2.run).toBe(st1.run);
    expect(st2.status).toBe("done");
    const b = readBudget(t.tdir);
    const ids = b.entries.map((e) => `${e.call}|${e.attempt}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.spent_usd).toBeCloseTo(b.entries.reduce((a, e) => a + e.usd, 0), 6);
    const outs = t.providers.gemini.calls.filter((c: AskInput) => c.brief).map((c: AskInput) => `${c.brief!.topic}|${c.model}`);
    expect(outs.filter((m: string, i: number, a: string[]) => a.indexOf(m) !== i)).toEqual([]);
    expect(outputCalls(t)).toBeGreaterThan(made1);
  });
});
