// The trials runner: runs inside the review runner's process (../review/main.ts), which holds the API
// keys, in a loop of its own so a long trial never holds up a real review. One call at a time.
//
// Cain asks with trial.sh (cli.ts), which leaves a request in /data/trials-inbox, as review.sh does for
// briefs: only this runner, as root, writes /data/trials, so the tasks, the spend and the blind key are
// the runner's alone. Everything there is readable by Cain's group.
//
//   /data/trials/budget.json                 one budget for every suite: what each call cost, by how it
//                                            was known (billed, measured, or counted at its worst case)
//   /data/trials/<suite>/suite.json          the tasks, frozen at the suite's first run
//   /data/trials/<suite>/<run>/state.json    each call's state, cost, tokens and time; the stop, if any
//   /data/trials/<suite>/<run>/outputs/      each output, with its task and configuration
//   /data/trials/<suite>/<run>/grades/       each grader's grades, by label only
//   /data/trials/<suite>/<run>/key.json      labels to configurations: never sent to a grader
//   /data/trials/<suite>/report.md           trial.sh report (rewritten when a run stops or ends)
//
// The spend stop (core.ts budgetAllows): before every call, what is spent plus the call's worst case
// must stay within the budget; otherwise nothing is sent and the run stops, saying why. A call is noted as
// pending before it is sent, so one cut off by a restart is counted at its worst case (its real cost is
// unknown) and then run again; a call that finished is never run again, and never counted twice.
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SeatError, textCheck, type ErrorKind, type Outbound } from "../review/core.ts";
import type { Runner } from "../review/runner.ts";
import type { SeatFn } from "../review/seats/common.ts";
import { CAIN_UID, readOwned } from "../owned.ts";
import {
  DEFAULT_BUDGET_USD, GRADERS, budgetAllows, callShape, callsFor, checkQuestions, configById, gradePrompt, isSuite, makeLabels, parseGrades,
  pickReviewTasks, researchPrompt, reviewOutput, seatRoom, shuffled, worstOf,
  type CallSpec, type Output, type OutputGrade, type ReviewDir, type Suite, type SuiteName, type Task,
} from "./core.ts";
import { CODEX_NO_MODEL, type AskFn } from "./calls.ts";
import { writeReport } from "./report.ts";

export type TrialsConfig = {
  dir: string;                 // /data/trials
  inboxDir?: string;           // /data/trials-inbox (none: requests only through request())
  inboxUid?: number;
  recordDir: string;           // /data/record, the record keeper's copy
  budgetUsd: number;           // the App option trials_budget_usd
};
export type TrialDeps = {
  review: Runner;              // its ledger and caps, the guard's reserve, the private terms, Stop, relay
  seats: { gemini?: (model: string) => SeatFn | undefined; codex?: (model: string) => SeatFn | undefined; perplexity?: SeatFn };
  asks: { claude?: AskFn; gemini?: AskFn; perplexity?: AskFn; codex?: AskFn };
  now?: () => Date; rand?: () => number; log?: (m: string) => void;
};

export type CallStatus = "done" | "failed" | "skipped" | "blocked" | "interrupted" | "held";
export type CallRec = {
  status: CallStatus; attempts: number; final?: boolean; cost_usd: number; worst_usd?: number;
  ms?: number; tokens?: { input: number; output: number }; searches?: number; model?: string; billed?: boolean;
  error?: string; at: string; next_at?: string;
};
export type Stop = { reason: "budget" | "caps" | "unavailable"; detail: string; at: string };
export type RunState = {
  format: 1; suite: SuiteName; run: string; status: "running" | "stopped" | "done";
  created_at: string; updated_at: string; stop?: Stop; stops: Stop[]; calls: Record<string, CallRec>; notes: string[];
};
export type BudgetEntry = { suite: string; run: string; call: string; usd: number; how: "billed" | "measured" | "worst case (cut off)"; at: string };
export type Budget = { format: 1; spent_usd: number; entries: BudgetEntry[];
  pending: Record<string, { suite: string; run: string; call: string; worst_usd: number; at: string }> };
export type Request = { kind: "run"; suite: SuiteName; questions?: unknown; retry?: boolean; fresh?: boolean } | { kind: "report"; suite: SuiteName };

export function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, text, { mode: 0o640 });
  try { const s = statSync(path); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* a new file */ }
  renameSync(tmp, path);
}
const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
export const fileOf = (id: string) => `${id.replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 80)}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}.json`;
const RUN_ID = /^r\d{8}-\d{6}$/;

export const paths = (dir: string) => ({
  budget: join(dir, "budget.json"),
  suite: (s: string) => join(dir, s, "suite.json"),
  run: (s: string, r: string) => join(dir, s, r),
  state: (s: string, r: string) => join(dir, s, r, "state.json"),
  output: (s: string, r: string, call: string) => join(dir, s, r, "outputs", fileOf(call)),
  grade: (s: string, r: string, call: string) => join(dir, s, r, "grades", fileOf(call)),
  key: (s: string, r: string) => join(dir, s, r, "key.json"),
  report: (s: string) => join(dir, s, "report.md"),
});
export function readBudget(dir: string): Budget {
  const b = readJson<Budget | null>(paths(dir).budget, null);
  return b && b.format === 1 && Array.isArray(b.entries) ? { ...b, pending: b.pending ?? {} } : { format: 1, spent_usd: 0, entries: [], pending: {} };
}
// The newest run of a suite, if any.
export function latestRun(dir: string, suite: string): RunState | null {
  let names: string[] = [];
  try { names = readdirSync(join(dir, suite)).filter((n) => RUN_ID.test(n)).sort(); } catch { return null; }
  for (const n of names.reverse()) { const s = readJson<RunState | null>(paths(dir).state(suite, n), null); if (s?.run === n) return s; }
  return null;
}
export function readSuite(dir: string, suite: string): Suite | null {
  const s = readJson<Suite | null>(paths(dir).suite(suite), null);
  return s && s.name === suite && Array.isArray(s.tasks) ? s : null;
}

// The record's past reviews, as pickReviewTasks reads them.
export function reviewDirs(recordDir: string): ReviewDir[] {
  const root = join(recordDir, "reviews");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: ReviewDir[] = [];
  for (const id of names) {
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) continue;
    const d = join(root, id);
    let brief: string | null = null, result: any = null;
    try { brief = readFileSync(join(d, "brief.txt"), "utf8"); } catch { /* none */ }
    try { result = JSON.parse(readFileSync(join(d, "result.json"), "utf8")); } catch { /* none */ }
    const created = String(result?.created_at ?? (/^\d{4}-\d\d-\d\d/.exec(id)?.[0] ?? ""));
    out.push({ id, brief, result, adopted: existsSync(join(d, "adopted.md")), created });
  }
  return out;
}

export class TrialRunner {
  private now: () => Date; private rand: () => number; private log: (m: string) => void;
  private recovered = false;
  constructor(public cfg: TrialsConfig, public deps: TrialDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rand = deps.rand ?? Math.random;
    this.log = deps.log ?? ((m) => console.log(`[trials] ${m}`));
  }
  get budget(): number { const b = this.cfg.budgetUsd; return Number.isFinite(b) && b >= 0 ? b : DEFAULT_BUDGET_USD; }
  private p = () => paths(this.cfg.dir);
  private relay(text: string) { try { this.deps.review.relay(text); } catch (e) { this.log(`couldn't relay: ${(e as Error).message}`); } }
  private iso = () => this.now().toISOString();

  // ---- the budget ----
  committed(): number { return readBudget(this.cfg.dir).spent_usd; }
  private charge(b: Budget, e: BudgetEntry) { b.entries.push(e); b.spent_usd = Number((b.spent_usd + e.usd).toFixed(6)); }
  // A call left pending by a restart: its cost is unknown, so its worst case counts as spent, once; the
  // call goes back in line.
  recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    const b = readBudget(this.cfg.dir);
    const keys = Object.keys(b.pending);
    if (!keys.length) return;
    for (const k of keys) {
      const x = b.pending[k];
      this.charge(b, { suite: x.suite, run: x.run, call: x.call, usd: x.worst_usd, how: "worst case (cut off)", at: this.iso() });
      delete b.pending[k];
      const st = readJson<RunState | null>(this.p().state(x.suite, x.run), null);
      if (st?.calls[x.call] && st.calls[x.call].status !== "done") {
        Object.assign(st.calls[x.call], { status: "interrupted", cost_usd: (st.calls[x.call].cost_usd ?? 0) + x.worst_usd,
          error: "cut off by a restart; counted at its worst case" });
        writeAtomic(this.p().state(x.suite, x.run), JSON.stringify(st, null, 1));
      }
    }
    writeAtomic(this.p().budget, JSON.stringify(b, null, 1));
    this.log(`${keys.length} call(s) cut off by a restart were counted at their worst case`);
  }

  // ---- requests ----
  ingest(): void {
    const dir = this.cfg.inboxDir;
    if (!dir) return;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const got = readOwned(path, this.cfg.inboxUid ?? CAIN_UID, 512 * 1024);
      try { unlinkSync(path); } catch { /* gone */ }
      if (!got.ok) { this.relay(`A trial request (${name.slice(0, 60)}) wasn't taken (${(got as { why: string }).why}). Nothing to tell him.`); continue; }
      let j: any; try { j = JSON.parse(got.text); } catch { this.relay(`A trial request (${name.slice(0, 60)}) wasn't JSON. Nothing to tell him.`); continue; }
      const why = this.request(j);
      this.relay(why ? `Trial request for ${String(j?.suite).slice(0, 30)} wasn't taken: ${why} Nothing to tell him.`
        : `Trial request taken: ${j.kind} ${j.suite}. trial.sh status shows it. Nothing to tell him.`);
    }
  }
  // A run (new, or the newest one resumed) or a report; the reason it wasn't taken, or null.
  request(j: any): string | null {
    if (!j || typeof j !== "object" || !isSuite(j.suite)) return "not a suite this runner knows (review-seats or research).";
    const suite: SuiteName = j.suite;
    if (j.kind === "report") { writeReport(this.cfg.dir, suite, this.budget); return null; }
    if (j.kind !== "run") return "a request is a run or a report.";
    let s = readSuite(this.cfg.dir, suite);
    if (!s) {
      const built = this.buildSuite(suite, j.questions);
      if (!built.suite) return built.error!;
      s = built.suite;
      writeAtomic(this.p().suite(suite), JSON.stringify(s, null, 1));
    } else if (j.questions !== undefined) return "this suite's questions are already fixed (written before its first run); they can't change.";
    const last = latestRun(this.cfg.dir, suite);
    if (last && last.status !== "done" && !j.fresh) {
      last.status = "running"; delete last.stop;
      for (const c of Object.values(last.calls)) {
        if (c.status === "held") c.status = "interrupted";
        if (j.retry && c.status === "failed" && c.final && !/no key|isn't signed in|doesn't offer/.test(c.error ?? "")) { c.final = false; c.attempts = Math.min(c.attempts, 1); }
      }
      last.updated_at = this.iso();
      writeAtomic(this.p().state(suite, last.run), JSON.stringify(last, null, 1));
      return null;
    }
    const d = this.now();
    const run = `r${d.toISOString().slice(0, 10).replace(/-/g, "")}-${d.toISOString().slice(11, 19).replace(/:/g, "")}`;
    if (existsSync(this.p().run(suite, run))) return "a run started this very second; ask again.";
    const st: RunState = { format: 1, suite, run, status: "running", created_at: this.iso(), updated_at: this.iso(), stops: [], calls: {}, notes: [...s.skipped] };
    // The original seats' answers kept in each review are outputs too, with no call.
    for (const t of s.tasks) if (t.kind === "review") for (const o of t.originals) {
      const id = `out|${t.id}|original:${o.seat}`;
      st.calls[id] = { status: "done", attempts: 0, cost_usd: 0, model: o.model, at: this.iso(), ms: 0 };
      writeAtomic(this.p().output(suite, run, id), JSON.stringify({ call: id, config: `original:${o.seat}`, task: t.id, model: o.model,
        verdict: o.verdict, findings: o.findings }, null, 1));
    }
    writeAtomic(this.p().state(suite, run), JSON.stringify(st, null, 1));
    return null;
  }
  buildSuite(suite: SuiteName, questions: unknown): { suite?: Suite; error?: string } {
    if (suite === "review-seats") {
      const { tasks, skipped } = pickReviewTasks(reviewDirs(this.cfg.recordDir));
      if (!tasks.length) return { error: `no past review in the record (${this.cfg.recordDir}/reviews) has brief.txt, result.json and adopted.md.` };
      const note = tasks.length < 12 ? [`only ${tasks.length} past reviews qualify, not 12`] : [];
      return { suite: { format: 1, name: suite, created_at: this.iso(), tasks, skipped: [...note, ...skipped.map((s) => `task left out: ${s}`)] } };
    }
    const q = checkQuestions(questions);
    if (!q.tasks) return { error: `the questions aren't right: ${q.error}.` };
    // Every question passes the private-terms check before it is kept (and again before every call).
    const terms = this.deps.review.terms();
    const bad = q.tasks.map((t) => ({ t, c: textCheck(`${t.question}\n${t.must_contain}`, terms) })).filter((x) => !x.c.ok);
    if (bad.length) return { error: `blocked: privacy in ${bad.map((x) => `${x.t.id} (${(x.c as any).why.join("; ")})`).join(", ")}. Fix those and ask again.` };
    return { suite: { format: 1, name: suite, created_at: this.iso(), tasks: q.tasks, skipped: [] } };
  }

  // ---- the loop ----
  // One step: a request, or one call of the first running run. true when a call was made or settled.
  async tick(): Promise<boolean> {
    this.recover();
    this.ingest();
    for (const suite of ["review-seats", "research"] as SuiteName[]) {
      const st = latestRun(this.cfg.dir, suite);
      if (st?.status !== "running") continue;
      return this.step(st);
    }
    return false;
  }

  private save(st: RunState) { st.updated_at = this.iso(); writeAtomic(this.p().state(st.suite, st.run), JSON.stringify(st, null, 1)); }
  private settled = (c?: CallRec) => !!c && (c.status === "done" || c.status === "skipped" || c.status === "blocked" || (c.status === "failed" && !!c.final));
  private end(st: RunState, status: "stopped" | "done", stop?: Stop) {
    st.status = status;
    if (stop) { st.stop = stop; st.stops.push(stop); }
    this.save(st);
    try { writeReport(this.cfg.dir, st.suite, this.budget); } catch (e) { this.log(`report: ${(e as Error).message}`); }
    const spent = this.committed();
    this.relay(status === "done"
      ? `Trial suite ${st.suite} finished (run ${st.run}); trials have spent $${spent.toFixed(2)} of $${this.budget.toFixed(2)}. The report is /data/trials/${st.suite}/report.md: file it in the record under projects/harness/trials/. Nothing to tell him yet.`
      : `Trial suite ${st.suite} stopped (run ${st.run}): ${stop!.detail} Trials have spent $${spent.toFixed(2)} of $${this.budget.toFixed(2)}. The report so far is /data/trials/${st.suite}/report.md. trial.sh run ${st.suite} resumes it once that changes. Nothing to tell him unless it needs his word.`);
  }

  private outputsOf(st: RunState, suite: Suite, task: string): Output[] {
    const out: Output[] = [];
    for (const [id, c] of Object.entries(st.calls)) {
      if (c.status !== "done" || !id.startsWith(`out|${task}|`)) continue;
      const o = readJson<Output | null>(this.p().output(st.suite, st.run, id), null);
      if (o) out.push(o);
    }
    return out.sort((a, b) => a.call.localeCompare(b.call));
  }
  // The key: labels to output calls, made once per task and written apart from what graders get.
  labelsFor(st: RunState, task: string, outputs: Output[]): Record<string, string> {
    const file = this.p().key(st.suite, st.run);
    const key = readJson<Record<string, Record<string, string>>>(file, {});
    if (!key[task]) { key[task] = makeLabels(outputs.map((o) => o.call), this.rand); writeAtomic(file, JSON.stringify(key, null, 1)); }
    return key[task];
  }

  async step(st: RunState): Promise<boolean> {
    if (this.deps.review.isStopped()) return false;            // Dane's Stop: nothing is sent
    const suite = readSuite(this.cfg.dir, st.suite);
    if (!suite) { this.end(st, "stopped", { reason: "unavailable", detail: "the suite's tasks can't be read.", at: this.iso() }); return false; }
    const specs = callsFor(suite);
    const nowIso = this.iso();
    let held = 0;
    for (const spec of specs) {
      const rec = st.calls[spec.id];
      if (this.settled(rec)) continue;
      if (rec?.next_at && rec.next_at > nowIso) { held++; continue; }
      // A grading call waits for every output of its task.
      if (spec.kind === "grade" && specs.some((x) => x.kind === "output" && x.task === spec.task && !this.settled(st.calls[x.id]))) continue;
      const r = await this.attempt(st, suite, spec);
      if (r === "budget") return false;
      if (r === "held") { held++; continue; }
      return true;
    }
    if (held) {
      // Only calls waiting on a retry's time, or on a seat's cap, are left. A retry is waited for; calls
      // held only by caps stop the run, saying so.
      const waiting = Object.values(st.calls).some((c) => c.status !== "held" && !!c.next_at && c.next_at > nowIso);
      if (!waiting) this.end(st, "stopped", { reason: "caps", at: this.iso(),
        detail: `what is left would spend into a review seat's monthly cap or the reserve kept for real reviews (${[...new Set(Object.values(st.calls).filter((c) => c.status === "held").map((c) => c.error))].join("; ")}).` });
      return false;
    }
    this.end(st, "done");
    return false;
  }

  // ---- one call ----
  private task(suite: Suite, id: string): Task { return suite.tasks.find((t) => t.id === id)!; }
  async attempt(st: RunState, suite: Suite, spec: CallSpec): Promise<"done" | "budget" | "held" | "settled"> {
    const task = this.task(suite, spec.task);
    const shape = callShape(suite.name, spec, task);
    const rec: CallRec = st.calls[spec.id] ?? { status: "interrupted", attempts: 0, cost_usd: 0, at: this.iso() };
    st.calls[spec.id] = rec;
    const settle = (status: CallStatus, error: string) => { Object.assign(rec, { status, final: true, error, at: this.iso() }); delete rec.next_at; this.save(st); return "settled" as const; };

    // What leaves, built first: the private-terms check reads all of it.
    let outbound: { text: string; run: (signal: AbortSignal) => Promise<{ output?: Output; grades?: OutputGrade[]; cost: number; searches: number; findings: number;
      model: string; billed: boolean; tokens?: { input: number; output: number } }> } | null = null;
    let labels: string[] = [];
    if (spec.kind === "output") {
      const c = configById(suite.name, spec.config)!;
      const day = this.deps.review.day();
      if (task.kind === "review") {
        const b: Outbound = task.brief;
        const fn = c.seat === "gemini" ? this.deps.seats.gemini?.(c.model) : c.seat === "codex" ? this.deps.seats.codex?.(c.model) : c.seat === "perplexity" ? this.deps.seats.perplexity : undefined;
        if (!fn) return settle("skipped", `no ${c.seat} key or sign-in in the App`);
        outbound = { text: `${b.topic}\n${b.question}\n${b.body}`, run: async (signal) => {
          const a = await fn({ brief: b, role: "reviewer", signal, maxOutputTokens: shape.maxOut, day });
          return { output: { ...reviewOutput(spec.id, c.id, a), task: task.id, model: a.model } as Output, cost: a.cost_usd, searches: a.searches ?? 0,
            findings: a.findings.length, model: a.model, billed: c.seat === "perplexity" || c.seat === "codex", tokens: a.tokens };
        } };
      } else {
        const ask = c.seat === "claude" ? this.deps.asks.claude : c.seat === "gemini" ? this.deps.asks.gemini : c.seat === "perplexity" ? this.deps.asks.perplexity : undefined;
        if (!ask) return settle("skipped", `no ${c.seat} key in the App`);
        const p = researchPrompt(task);
        outbound = { text: `${p.system}\n${p.user}`, run: async (signal) => {
          const a = await ask(c.setting ?? c.model, { ...p, maxOut: shape.maxOut, signal, day, search: shape.search });
          return { output: { call: spec.id, config: c.id, task: task.id, model: a.model, text: a.text, urls: a.urls } as Output, cost: a.cost_usd,
            searches: a.searches, findings: 0, model: a.model, billed: a.billed, tokens: a.tokens };
        } };
      }
    } else {
      const outputs = this.outputsOf(st, suite, task.id);
      if (!outputs.length) return settle("skipped", "no output of this task to grade");
      const key = this.labelsFor(st, task.id, outputs);
      const byCall = Object.fromEntries(Object.entries(key).map(([l, c]) => [c, l]));
      const labelled = shuffled(outputs.filter((o) => byCall[o.call]).map((o) => ({ label: byCall[o.call],
        // The graders get the output's own words only: no configuration, model or call id.
        output: { call: "", config: "", verdict: o.verdict, findings: o.findings, text: o.text, urls: o.urls } as Output })), this.rand);
      labels = labelled.map((x) => x.label);
      const today = this.deps.review.day();
      const gp = gradePrompt(task, labelled, today);
      const ask = spec.grader === "claude" ? this.deps.asks.claude : this.deps.asks.codex;
      if (!ask) return settle("skipped", spec.grader === "claude" ? "no Anthropic key in the App" : "Codex isn't set up");
      const g = GRADERS.find((x) => x.id === spec.grader)!;
      outbound = { text: `${gp.system}\n${gp.user}`, run: async (signal) => {
        const a = await ask(g.model, { system: gp.system, user: gp.user, schema: gp.schema, maxOut: shape.maxOut, signal, day: today, search: shape.search, fetch: shape.fetch });
        const parsed = parseGrades(a.json, task.kind, labels);
        if (!parsed.grades) throw new SeatError("bad_output", parsed.error!, a.cost_usd);
        return { grades: parsed.grades, cost: a.cost_usd, searches: a.searches, findings: 0, model: a.model, billed: a.billed, tokens: a.tokens };
      } };
    }

    // 1. The private-terms check, on everything that would leave.
    const priv = textCheck(outbound.text, this.deps.review.terms());
    if (!priv.ok) return settle("blocked", `blocked: privacy (${(priv as { why: string[] }).why.join("; ")}); nothing was sent`);
    // 2. The trials budget: what is spent plus this call's worst case.
    const worst = worstOf(shape, outbound.text.length, this.deps.review.day());
    const spent = this.committed();
    if (!budgetAllows(spent, worst, this.budget)) {
      rec.worst_usd = worst;
      this.end(st, "stopped", { reason: "budget", at: this.iso(),
        detail: `the next call (${shape.label} on ${task.id}) could cost up to $${worst.toFixed(2)}, and with $${spent.toFixed(2)} spent that would pass the trials budget of $${this.budget.toFixed(2)}, so it wasn't made.` });
      return "budget";
    }
    // 3. The review seat's monthly cap, less the reserve kept for real reviews.
    const why = this.capWhy(shape.reviewSeat, worst);
    if (why) { Object.assign(rec, { status: "held", error: why, worst_usd: worst, at: this.iso() }); this.save(st); return "held"; }

    // 4. Noted as pending, then sent.
    const b = readBudget(this.cfg.dir);
    b.pending[spec.id] = { suite: st.suite, run: st.run, call: spec.id, worst_usd: worst, at: this.iso() };
    writeAtomic(this.p().budget, JSON.stringify(b, null, 1));
    rec.attempts++; rec.worst_usd = worst; this.save(st);
    const started = Date.now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SeatError("timeout", `no answer within ${shape.timeoutS} s`)); }, shape.timeoutS * 1000); });
    let usd = 0, how: BudgetEntry["how"] = "measured";
    try {
      const a = await Promise.race([outbound.run(ctl.signal), deadline]);
      usd = shape.reviewSeat ? this.deps.review.addSpend(shape.reviewSeat, a.cost, a.findings, a.searches) : a.cost;
      how = a.billed ? "billed" : "measured";
      if (a.output) writeAtomic(this.p().output(st.suite, st.run, spec.id), JSON.stringify(a.output, null, 1));
      if (a.grades) writeAtomic(this.p().grade(st.suite, st.run, spec.id), JSON.stringify({ call: spec.id, task: task.id, grader: (spec as any).grader,
        model: a.model, grades: a.grades }, null, 1));
      Object.assign(rec, { status: "done", final: true, cost_usd: rec.cost_usd + usd, ms: Date.now() - started, tokens: a.tokens, searches: a.searches,
        model: a.model, billed: a.billed, at: this.iso() });
      delete rec.error; delete rec.next_at;
    } catch (e) {
      const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
      usd = shape.reviewSeat ? this.deps.review.addSpend(shape.reviewSeat, err.cost_usd, 0) : err.cost_usd;
      const c = spec.kind === "output" ? configById(suite.name, spec.config) : undefined;
      Object.assign(rec, { cost_usd: rec.cost_usd + usd, ms: Date.now() - started, at: this.iso() });
      if (c?.seat === "codex" && CODEX_NO_MODEL.test(err.message)) {
        Object.assign(rec, { status: "skipped", final: true, error: `the installed Codex doesn't offer ${c.model || "that model"}` });
      } else {
        const again = rec.attempts < 2 && (["transient", "timeout", "quota", "bad_output"] as ErrorKind[]).includes(err.kind);
        Object.assign(rec, { status: "failed", final: !again, error: `${err.kind}: ${err.message}`.slice(0, 300) });
        if (again) rec.next_at = new Date(this.now().getTime() + 120_000).toISOString();
      }
    } finally { clearTimeout(timer); }
    // 5. What it cost, in place of its worst case.
    const b2 = readBudget(this.cfg.dir);
    delete b2.pending[spec.id];
    this.charge(b2, { suite: st.suite, run: st.run, call: spec.id, usd: Number(usd.toFixed(6)), how, at: this.iso() });
    writeAtomic(this.p().budget, JSON.stringify(b2, null, 1));
    this.save(st);
    return "done";
  }

  // The seat's room this month: its cap less the guard's reserve, against this call's worst case.
  capWhy(seat: string | null, worst: number): string | null {
    if (!seat) return null;
    const r = this.deps.review;
    const caps = r.cfg.caps, reserve = r.cfg.reservePercent ?? 25;
    const row = r.ledger()[r.month()]?.[seat as "gemini"];
    if (seat === "openai") {
      const room = seatRoom(caps.openaiRuns, reserve, row?.runs ?? 0);
      return room < 1 ? `Codex has no runs left this month outside the ${reserve}% kept for real reviews (cap ${caps.openaiRuns})` : null;
    }
    const cap = (caps as any)[seat] as number;
    const room = seatRoom(cap, reserve, row?.usd ?? 0);
    return worst > room + 1e-9 ? `${seat} has $${Math.max(0, room).toFixed(2)} left this month outside the ${reserve}% kept for real reviews (cap $${cap}), and this call could cost $${worst.toFixed(2)}` : null;
  }
}
