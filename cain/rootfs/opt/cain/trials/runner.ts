// The trials runner: runs inside the review runner's process (../review/main.ts), which holds the API
// keys, in a loop of its own so a long trial never holds up a real review. One call at a time.
//
// Cain asks with trial.sh (cli.ts), which leaves a request in /data/trials-inbox: a known suite and the
// command, nothing else (no budget, no configurations, no run id). Only this runner, as root, writes
// /data/trials, so the tasks, the spend and the blind key are the runner's alone. Everything there is
// readable by Cain's group.
//
//   /data/trials/budget.json                 the one budget (ledger.ts): spent, reservations out, task holds
//   /data/trials/<suite>/suite.json          the tasks, frozen at the suite's first run
//   /data/trials/<suite>/<run>/state.json    each call's state, cost (billed or estimated), tokens and time;
//                                            the checks before any spend; the stop, if any
//   /data/trials/<suite>/<run>/outputs/      each output, with its task, configuration, served model and the
//                                            search queries the provider said it ran
//   /data/trials/<suite>/<run>/grades/       each grader's grades, by label only
//   /data/trials/<suite>/<run>/key.json      labels to configurations: never sent to a grader
//   /data/trials/<suite>/report.md           trial.sh report (rewritten when a run stops or ends)
//
// Real reviews first: while a real review is queued or running (or waiting in the review inbox), no trial
// call starts; after a 429 or usage-limit answer on a seat (a trial's or a real review's) that seat cools
// for 15 minutes; trial calls on one seat are spaced out. Every call has a hard wall-clock timeout and is
// aborted at it (Codex's child process is killed).
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FINAL, SeatError, textCheck, type ErrorKind } from "../review/core.ts";
import { loadReview, type Runner } from "../review/runner.ts";
import type { Fetch } from "../review/seats/common.ts";
import { bunExec, type Exec } from "../review/seats/openai.ts";
import { CAIN_UID, readOwned } from "../owned.ts";
import {
  DEFAULT_BUDGET_USD, GRADERS, LIMITS, blindViolations, callShape, callsFor, ceilingOf, checkQuestions, configById, configsFor, familyOf, gradeCharsBound,
  gradePrompt, isSuite, makeLabels, parseGrades, pickReviewTasks, researchPrompt, reviewOutput, seatOfConfig, shuffled, taskChars,
  tokensOf, ceilingPrice, worstOf, worstOfCeiling, type CallShape, type CallSpec, type Config, type Labelled, type Output, type OutputGrade,
  type ReviewDir, type ReviewSeatName, type ReviewTask, type Suite, type SuiteName, type Task,
} from "./core.ts";
import { CODEX_NO_MODEL, CodexToolUse, type AskInput, type AskResult, type CodexProvider, type Provider } from "./calls.ts";
import { Ledger, ownerAlive, readBudgetFile, type Budget, type How } from "./ledger.ts";
import { PrivacyBlock, makeWire, type Wire } from "./guard.ts";
import { writeReport } from "./report.ts";

export type TrialsConfig = {
  dir: string;                 // /data/trials
  inboxDir?: string;           // /data/trials-inbox (none: requests only through request())
  inboxUid?: number;
  recordDir: string;           // /data/record, the record keeper's copy
  budgetUsd: number;           // the App option trials_budget_usd, and nothing else
  timeoutScale?: number;       // tests only: shortens every call's wall-clock limit
  coolMs?: number;             // a seat's cooling after a 429 or usage limit (default 15 minutes)
  seatGapMs?: number;          // the least time between two trial calls on one seat (default 10 seconds)
};
export type TrialDeps = {
  review: Runner;              // its ledger and caps, the guard's reserve, the private terms, Stop, relay, its queue
  providers: { claude?: Provider; gemini?: Provider; perplexity?: Provider; codex?: CodexProvider };
  fetch?: Fetch; exec?: Exec;  // what each call's Wire sends through (default: fetch, and Codex's child process)
  now?: () => Date; rand?: () => number; log?: (m: string) => void; owner?: string;
};

export type CallStatus = "done" | "failed" | "skipped" | "blocked" | "interrupted" | "held";
export type CallRec = {
  status: CallStatus; attempts: number; final?: boolean; cost_usd: number; how?: How; worst_usd?: number;
  ms?: number; tokens?: { input: number; output: number }; searches?: number; model?: string; served?: string; family?: string;
  queries?: number; error?: string; at: string; next_at?: string;
};
export type Stop = { reason: "budget" | "caps" | "unavailable" | "privacy" | "approval"; detail: string; at: string };
export type Preflight = { done: boolean; at: string; tries: number; codex_version?: string | null; codex_models?: string[] | null;
  checked: Record<string, string>; skip: Record<string, string>; third_party_routing: boolean };
export type RunState = {
  format: 2; suite: SuiteName; run: string; status: "running" | "stopped" | "done";
  created_at: string; updated_at: string; stop?: Stop; stops: Stop[]; calls: Record<string, CallRec>; notes: string[];
  preflight?: Preflight; held: Record<string, true>; cool: Record<string, string>;
};
export type Mode = "resume" | "retry" | "new";
export type Request = { kind: "run"; suite: SuiteName; mode?: Mode } | { kind: "report"; suite: SuiteName };

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
  try { return readBudgetFile(paths(dir).budget); } catch { return { format: 2, spent_usd: NaN, entries: [], reservations: {}, holds: {} }; }
}
export function latestRun(dir: string, suite: string): RunState | null {
  let names: string[] = [];
  try { names = readdirSync(join(dir, suite)).filter((n) => RUN_ID.test(n)).sort(); } catch { return null; }
  for (const n of names.reverse()) { const s = readJson<RunState | null>(paths(dir).state(suite, n), null); if (s?.run === n) return { held: {}, cool: {}, ...s }; }
  return null;
}
export function readSuite(dir: string, suite: string): Suite | null {
  const s = readJson<Suite | null>(paths(dir).suite(suite), null);
  return s && s.name === suite && Array.isArray(s.tasks) ? s : null;
}

// The record's past reviews, as pickReviewTasks reads them (adopted notes and a kept diff included).
export function reviewDirs(recordDir: string): ReviewDir[] {
  const root = join(recordDir, "reviews");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: ReviewDir[] = [];
  const read = (p: string, max = 200_000) => { try { const t = readFileSync(p, "utf8"); return t.length <= max ? t : t.slice(0, max); } catch { return null; } };
  for (const id of names) {
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) continue;
    const d = join(root, id);
    const brief = read(join(d, "brief.txt"));
    let result: any = null;
    try { result = JSON.parse(readFileSync(join(d, "result.json"), "utf8")); } catch { /* none */ }
    const adoptedText = read(join(d, "adopted.md"), 20_000);
    const created = String(result?.created_at ?? (/^\d{4}-\d\d-\d\d/.exec(id)?.[0] ?? ""));
    out.push({ id, brief, result, adopted: adoptedText !== null, adoptedText, diff: read(join(d, "diff.patch"), 60_000), created });
  }
  return out;
}

// The research questions and the owner's approval of them, in the record: the questions file, and a flag
// file that names its SHA-256, says the owner approved it, and whether he approved routing Perplexity's
// levels to another lab's model. Without it the research suite doesn't run.
export const RESEARCH_QUESTIONS = "projects/harness/trials/research-questions.json";
export const RESEARCH_APPROVAL = "projects/harness/trials/research-approved.json";
export type Approval = { ok: true; sha: string; third_party: boolean; questions: unknown } | { ok: false; why: string };
export function readApproval(recordDir: string): Approval {
  let text: string;
  try { text = readFileSync(join(recordDir, RESEARCH_QUESTIONS), "utf8"); } catch { return { ok: false, why: `there is no questions file in the record (${RESEARCH_QUESTIONS})` }; }
  const sha = createHash("sha256").update(text).digest("hex");
  let questions: unknown;
  try { questions = JSON.parse(text); } catch { return { ok: false, why: "the questions file isn't JSON" }; }
  const a = readJson<any>(join(recordDir, RESEARCH_APPROVAL), null);
  if (!a) return { ok: false, why: `the owner hasn't approved the questions and their answer notes (no ${RESEARCH_APPROVAL})` };
  if (a.approved_by !== "owner" || typeof a.approved_on !== "string" || !/^\d{4}-\d\d-\d\d$/.test(a.approved_on)) return { ok: false, why: "the approval file doesn't say the owner approved it, with the date" };
  if (a.questions_sha256 !== sha) return { ok: false, why: "the questions file changed since the owner approved it" };
  return { ok: true, sha, third_party: a.perplexity_third_party_routing === true, questions };
}

const REQUEST_KEYS = new Set(["kind", "suite", "mode"]);
// A request from the inbox: a known suite and the command, nothing else. The reason it isn't one, or null.
export function requestError(j: any): string | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return "not a request.";
  for (const k of Object.keys(j)) if (!REQUEST_KEYS.has(k)) return `it carries a field a request may not (${k.slice(0, 20).replace(/[^\w-]/g, "?")}); the budget is the App's option and the configurations are the runner's.`;
  if (!isSuite(j.suite)) return "not a suite this runner knows (review-seats or research).";
  if (j.kind !== "run" && j.kind !== "report") return "a request is a run or a report.";
  if (j.mode !== undefined && (j.kind !== "run" || !["resume", "retry", "new"].includes(j.mode))) return "its mode isn't resume, retry or new.";
  return null;
}

type Exchange =
  | { kind: "ok"; res: AskResult; usd: number; how: How; queries: string[]; overrun: boolean; queryHit: string[] }
  | { kind: "denied"; reason: "budget" | "seat" | "busy"; detail: string }
  | { kind: "error"; err: SeatError; usd: number; how: How | null; released: boolean; queries: string[]; overrun: boolean; queryHit: string[] };

export class TrialRunner {
  private now: () => Date; private rand: () => number; private log: (m: string) => void;
  private recovered = false;
  readonly ledger: Ledger;
  private lastCall: Record<string, number> = {};
  constructor(public cfg: TrialsConfig, public deps: TrialDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rand = deps.rand ?? Math.random;
    this.log = deps.log ?? ((m) => console.log(`[trials] ${m}`));
    this.ledger = new Ledger(cfg.dir, deps.owner, this.now);
  }
  get budget(): number { const b = this.cfg.budgetUsd; return Number.isFinite(b) && b >= 0 ? b : DEFAULT_BUDGET_USD; }
  private p = () => paths(this.cfg.dir);
  private relay(text: string) { try { this.deps.review.relay(text); } catch (e) { this.log(`couldn't relay: ${(e as Error).message}`); } }
  private iso = () => this.now().toISOString();
  private alarm(text: string) { this.log(`ALARM: ${text}`); this.relay(`Trials alarm: ${text} Nothing to tell him unless it needs his word.`); }

  committed(): number { const b = readBudget(this.cfg.dir); return b.spent_usd; }

  // ---- after a restart ----
  recover(): void {
    if (this.recovered) return;
    const r = this.ledger.recover(ownerAlive(this.ledger.owner));
    if ("busy" in r) return;   // tried again next tick
    this.recovered = true;
    for (const x of [...r.charged, ...r.released]) {
      const st = readJson<RunState | null>(this.p().state(x.suite, x.run), null);
      const c = st?.calls[x.call];
      if (!st || !c || c.status === "done") continue;
      const sent = r.charged.includes(x);
      Object.assign(c, { status: "interrupted", cost_usd: (c.cost_usd ?? 0) + (sent ? x.usd : 0), ...(sent ? { how: "worst case (cut off)" as How } : {}),
        error: sent ? "cut off by a restart after it was sent; counted at its worst case" : "cut off by a restart before it was sent; nothing was charged" });
      writeAtomic(this.p().state(x.suite, x.run), JSON.stringify(st, null, 1));
    }
    if (r.charged.length) this.log(`${r.charged.length} call(s) cut off by a restart after they were sent were counted at their worst case`);
  }

  // ---- requests ----
  ingest(): void {
    const dir = this.cfg.inboxDir;
    if (!dir) return;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const shown = name.slice(0, 60).replace(/[^\w.-]/g, "?");
      const got = readOwned(path, this.cfg.inboxUid ?? CAIN_UID, 16 * 1024);
      try { unlinkSync(path); } catch { /* gone */ }
      if (!got.ok) { this.relay(`A trial request (${shown}) wasn't taken (${(got as { why: string }).why}). Nothing to tell him.`); continue; }
      let j: any; try { j = JSON.parse(got.text); } catch { this.relay(`A trial request (${shown}) wasn't JSON. Nothing to tell him.`); continue; }
      const why = this.request(j);
      this.relay(why ? `A trial request wasn't taken: ${why} Nothing to tell him.`
        : `Trial request taken: ${j.kind} ${j.suite}${j.mode ? ` (${j.mode})` : ""}. trial.sh status shows it. Nothing to tell him.`);
    }
  }
  request(j: any): string | null {
    const bad = requestError(j);
    if (bad) return bad;
    const suite: SuiteName = j.suite;
    if (j.kind === "report") { writeReport(this.cfg.dir, suite, this.budget); return null; }
    const mode: Mode = j.mode ?? "resume";
    let s = readSuite(this.cfg.dir, suite);
    if (!s) {
      const built = this.buildSuite(suite);
      if (!built.suite) return built.error!;
      s = built.suite;
      writeAtomic(this.p().suite(suite), JSON.stringify(s, null, 1));
    }
    const last = latestRun(this.cfg.dir, suite);
    if (last && last.status !== "done" && mode !== "new") {
      last.status = "running"; delete last.stop;
      for (const c of Object.values(last.calls)) {
        if (c.status === "held") c.status = "interrupted";
        if (mode === "retry" && c.status === "failed" && c.final && !/no key|isn't signed in|isn't served|not listed|refused/.test(c.error ?? "")) { c.final = false; c.attempts = Math.min(c.attempts, 1); }
      }
      // The checks before any spend run again on a resume (a model may have come or gone).
      if (last.preflight) last.preflight.done = false;
      last.updated_at = this.iso();
      writeAtomic(this.p().state(suite, last.run), JSON.stringify(last, null, 1));
      return null;
    }
    if (last && last.status === "running") return "its newest run is still running; it can't start a new one beside it.";
    const d = this.now();
    const run = `r${d.toISOString().slice(0, 10).replace(/-/g, "")}-${d.toISOString().slice(11, 19).replace(/:/g, "")}`;
    if (existsSync(this.p().run(suite, run))) return "a run started this very second; ask again.";
    const st: RunState = { format: 2, suite, run, status: "running", created_at: this.iso(), updated_at: this.iso(), stops: [], calls: {},
      notes: [...s.skipped], held: {}, cool: {} };
    // The original seats' answers kept in each review are outputs too, with no call.
    for (const t of s.tasks) if (t.kind === "review") for (const o of t.originals) {
      const id = `out|${t.id}|original:${o.seat}`;
      st.calls[id] = { status: "done", attempts: 0, cost_usd: 0, model: o.model, served: o.model, family: familyOf(`original:${o.seat}`, o.model), at: this.iso(), ms: 0 };
      writeAtomic(this.p().output(suite, run, id), JSON.stringify({ call: id, config: `original:${o.seat}`, task: t.id, model: o.model, served_model: o.model,
        verdict: o.verdict, findings: o.findings }, null, 1));
    }
    writeAtomic(this.p().state(suite, run), JSON.stringify(st, null, 1));
    return null;
  }
  // The suite's tasks, frozen at its first run, with the stored briefs, adopted notes and diffs checked
  // against the private terms now (and again on the wire before every call).
  buildSuite(suite: SuiteName): { suite?: Suite; error?: string } {
    const terms = this.deps.review.terms();
    if (suite === "review-seats") {
      const { tasks, skipped } = pickReviewTasks(reviewDirs(this.cfg.recordDir));
      if (!tasks.length) return { error: `no past review in the record (${this.cfg.recordDir}/reviews) has brief.txt, result.json and adopted.md.` };
      const notes = tasks.length < 12 ? [`only ${tasks.length} past reviews qualify, not 12`] : [];
      for (const t of tasks) checkReviewTask(t, terms);
      return { suite: { format: 2, name: suite, created_at: this.iso(), tasks, skipped: [...notes, ...skipped.map((s) => `task left out: ${s}`)] } };
    }
    const a = readApproval(this.cfg.recordDir);
    if (!a.ok) return { error: `the research suite can't run: ${(a as { why: string }).why}.` };
    const q = checkQuestions(a.questions);
    if (!q.tasks) return { error: `the questions aren't right: ${q.error}.` };
    const bad = q.tasks.map((t) => ({ t, c: textCheck(`${t.sent_text}\n${t.must_contain}\n${t.sources.map((s) => s.url).join("\n")}`, terms) })).filter((x) => !x.c.ok);
    if (bad.length) return { error: `blocked: privacy in ${bad.map((x) => `${x.t.id} (${(x.c as any).why.join("; ")})`).join(", ")}. Fix those, have them approved again, and ask again.` };
    return { suite: { format: 2, name: suite, created_at: this.iso(), tasks: q.tasks, skipped: [], questions_sha256: a.sha } };
  }

  // ---- real reviews first ----
  // A real review queued, running or waiting in the inbox pauses every trial call; a seat that answered 429
  // or a usage limit in a real review lately cools for the trials too.
  reviewBusy(): { busy: boolean; cooling: Record<string, number> } {
    const rc = this.deps.review.cfg;
    const cooling: Record<string, number> = {};
    let busy = false;
    try { if (rc.inboxDir && readdirSync(rc.inboxDir).some((n) => n.endsWith(".json") && !n.startsWith("."))) busy = true; } catch { /* none */ }
    let names: string[] = [];
    try { names = readdirSync(rc.queueDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")); } catch { /* none */ }
    const nowMs = this.now().getTime(), cool = this.cfg.coolMs ?? 15 * 60_000;
    for (const n of names) {
      // A review untouched for more than a day and a bit is settled or long given up: not read every tick.
      try { if (Date.now() - statSync(join(rc.queueDir, n)).mtimeMs > 26 * 3_600_000) continue; } catch { continue; }
      const r = loadReview(rc.queueDir, n.slice(0, -5));
      if (!r) continue;
      if (!FINAL.includes(r.status)) busy = true;
      for (const s of r.seats ?? []) if (s.error?.kind === "quota") {
        const at = Date.parse(s.finished_at ?? r.updated_at ?? "");
        if (Number.isFinite(at) && nowMs - at < cool) cooling[s.seat] = Math.max(cooling[s.seat] ?? 0, at + cool);
      }
    }
    return { busy, cooling };
  }

  // ---- the loop ----
  // One step: a request, or one call of the first running run. true when a call was made or settled.
  async tick(): Promise<boolean> {
    this.recover();
    this.ingest();
    if (!this.recovered) return false;
    const rb = this.reviewBusy();
    if (rb.busy) return false;
    for (const suite of ["review-seats", "research"] as SuiteName[]) {
      const st = latestRun(this.cfg.dir, suite);
      if (st?.status !== "running") continue;
      return this.step(st, rb.cooling);
    }
    return false;
  }

  private save(st: RunState) { st.updated_at = this.iso(); writeAtomic(this.p().state(st.suite, st.run), JSON.stringify(st, null, 1)); }
  private settled = (c?: CallRec) => !!c && (c.status === "done" || c.status === "skipped" || c.status === "blocked" || (c.status === "failed" && !!c.final));
  private holdKey = (st: RunState, task: string) => `${st.suite}|${st.run}|${task}`;
  private end(st: RunState, status: "stopped" | "done", stop?: Stop) {
    st.status = status;
    if (stop) { st.stop = stop; st.stops.push(stop); }
    this.ledger.releaseHolds((_, h) => h.suite === st.suite && h.run === st.run);
    st.held = {};
    this.save(st);
    try { writeReport(this.cfg.dir, st.suite, this.budget); } catch (e) { this.log(`report: ${(e as Error).message}`); }
    const spent = this.committed();
    this.relay(status === "done"
      ? `Trial suite ${st.suite} finished (run ${st.run}); trials have spent $${spent.toFixed(2)} of $${this.budget.toFixed(2)}. The report is /data/trials/${st.suite}/report.md: file it in the record under projects/harness/trials/. Nothing to tell him yet.`
      : `Trial suite ${st.suite} stopped (run ${st.run}): ${stop!.detail} Trials have spent $${spent.toFixed(2)} of $${this.budget.toFixed(2)}. The report so far is /data/trials/${st.suite}/report.md. trial.sh run ${st.suite} resumes it once that changes. Nothing to tell him unless it needs his word.`);
  }

  private outputsOf(st: RunState, task: string): Output[] {
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
    const have = new Set(Object.values(key[task] ?? {}));
    const missing = outputs.filter((o) => !have.has(o.call));
    if (!key[task] || missing.length) {
      const used = new Set(Object.keys(key[task] ?? {}));
      const fresh = makeLabels(missing.map((o) => o.call), () => this.rand());
      const merged = { ...(key[task] ?? {}) };
      for (const [l, c] of Object.entries(fresh)) { let label = l; while (used.has(label)) label = `${label[0]}${Math.floor(this.rand() * 90 + 10)}`; used.add(label); merged[label] = c; }
      key[task] = merged;
      writeAtomic(file, JSON.stringify(key, null, 1));
    }
    return key[task];
  }

  async step(st: RunState, cooling: Record<string, number> = {}): Promise<boolean> {
    if (this.deps.review.isStopped()) return false;            // Dane's Stop: nothing is sent
    const suite = readSuite(this.cfg.dir, st.suite);
    if (!suite) { this.end(st, "stopped", { reason: "unavailable", detail: "the suite's tasks can't be read.", at: this.iso() }); return false; }
    if (suite.name === "research") {
      const a = readApproval(this.cfg.recordDir);
      if (!a.ok || a.sha !== suite.questions_sha256) {
        this.end(st, "stopped", { reason: "approval", at: this.iso(), detail: `the owner's approval of the research questions doesn't stand (${a.ok ? "the questions changed since the suite was frozen" : (a as { why: string }).why}), so nothing was sent.` });
        return false;
      }
    }
    if (!st.preflight?.done) return this.preflight(st, suite);
    const specs = callsFor(suite);
    const nowMs = this.now().getTime(), nowIso = this.iso();
    let waiting = 0, capHeld = 0;
    for (const spec of specs) {
      const rec = st.calls[spec.id];
      if (this.settled(rec)) continue;
      if (rec?.next_at && rec.next_at > nowIso) { waiting++; continue; }
      if (spec.kind === "output") {
        const skip = st.preflight!.skip[spec.config];
        if (skip) { this.mark(st, spec.id, "skipped", skip); return true; }
      }
      // A grading call waits for every output of its task.
      if (spec.kind === "grade" && specs.some((x) => x.kind === "output" && x.task === spec.task && !this.settled(st.calls[x.id]))) continue;
      const task = suite.tasks.find((t) => t.id === spec.task)!;
      const shape = callShape(suite.name, spec, task, !st.preflight!.third_party_routing);
      // Real reviews first: a cooling seat, or one called a moment ago, waits.
      if (shape.reviewSeat) {
        const coolUntil = Math.max(cooling[shape.reviewSeat] ?? 0, Date.parse(st.cool[shape.reviewSeat] ?? "") || 0);
        if (coolUntil > nowMs) { waiting++; continue; }
        if (nowMs - (this.lastCall[shape.reviewSeat] ?? -Infinity) < (this.cfg.seatGapMs ?? 10_000)) { waiting++; continue; }
      }
      // The task is one unit: both graders' worst case is held before its first call.
      if (!st.held[task.id]) {
        const h = this.holdTask(st, suite, task);
        if (h === "busy") return false;
        if (h !== "ok") { this.end(st, "stopped", { reason: "budget", at: this.iso(), detail: `the next task (${task.id}) wasn't started: ${h}, so nothing of it was sent.` }); return false; }
      }
      const r = await this.attempt(st, suite, spec, task, shape);
      if (r === "stop") return false;
      if (r === "wait") { waiting++; continue; }
      if (r === "held") { capHeld++; continue; }
      this.releaseIfTaskDone(st, specs, task.id);
      return true;
    }
    if (waiting) return false;
    if (capHeld) {
      this.end(st, "stopped", { reason: "caps", at: this.iso(),
        detail: `what is left would spend into a review seat's monthly cap or the reserve kept for real reviews (${[...new Set(Object.values(st.calls).filter((c) => c.status === "held").map((c) => c.error))].join("; ")}).` });
      return false;
    }
    this.end(st, "done");
    return false;
  }
  private mark(st: RunState, id: string, status: CallStatus, error: string) {
    const rec = st.calls[id] ?? { status, attempts: 0, cost_usd: 0, at: this.iso() };
    Object.assign(rec, { status, final: true, error, at: this.iso() }); delete rec.next_at;
    st.calls[id] = rec; this.save(st);
  }
  private holdTask(st: RunState, suite: Suite, task: Task): "ok" | "busy" | string {
    let usd = 0;
    for (const g of GRADERS) {
      const id = `grade|${task.id}|${g.id}`;
      if (this.settled(st.calls[id])) continue;
      const shape = callShape(suite.name, { id, kind: "grade", task: task.id, grader: g.id }, task);
      if (g.id === "claude" && !this.deps.providers.claude) continue;
      if (g.id === "codex" && !this.deps.providers.codex) continue;
      usd += worstOf(shape, gradeCharsBound(suite, task)) ?? 0;
    }
    const r = this.ledger.hold(this.holdKey(st, task.id), { suite: st.suite, run: st.run, task: task.id }, usd, this.budget);
    if (r.ok) { st.held[task.id] = true; this.save(st); return "ok"; }
    const d = r as Extract<typeof r, { ok: false }>;
    return d.reason === "busy" ? "busy" : d.detail;
  }
  private releaseIfTaskDone(st: RunState, specs: CallSpec[], task: string) {
    if (!specs.filter((x) => x.task === task).every((x) => this.settled(st.calls[x.id]))) return;
    this.ledger.releaseHolds((k) => k === this.holdKey(st, task));
  }

  // ---- one paid exchange: reserve, mark dispatched, send through a fresh Wire, settle ----
  private seatCheck = (seat: ReviewSeatName, out: { usd: number; runs: number }, need: { usd: number; runs: number }): string | null => {
    const r = this.deps.review;
    const caps = r.cfg.caps, reserve = Math.min(100, Math.max(0, r.cfg.reservePercent ?? 25));
    const row = r.ledger()[r.month()]?.[seat];
    const share = 1 - reserve / 100;
    if (seat === "openai") {
      const room = caps.openaiRuns * share - (row?.runs ?? 0) - out.runs;
      return room < need.runs ? `Codex has no runs left this month outside the ${reserve}% kept for real reviews (cap ${caps.openaiRuns})` : null;
    }
    const cap = (caps as any)[seat] as number;
    const room = cap * share - (row?.usd ?? 0) - out.usd;
    return need.usd > room + 1e-9 ? `${seat} has $${Math.max(0, room).toFixed(2)} left this month outside the ${reserve}% kept for real reviews (cap $${cap}), and this call could cost $${need.usd.toFixed(2)}` : null;
  };
  private async exchange(st: RunState, o: { call: string; attempt: number; seat: ReviewSeatName | null; worst: number; runs: number; hold?: string; timeoutS: number },
    fn: (wire: Wire, signal: AbortSignal) => Promise<AskResult>): Promise<Exchange> {
    const res = this.ledger.reserve({ suite: st.suite, run: st.run, call: o.call, attempt: o.attempt, seat: o.seat, usd: o.worst, runs: o.runs, hold: o.hold },
      this.budget, this.seatCheck);
    if (!res.ok) { const d = res as Extract<typeof res, { ok: false }>; return { kind: "denied", reason: d.reason, detail: d.detail }; }
    this.ledger.dispatched(res.id);
    if (o.seat) this.lastCall[o.seat] = this.now().getTime();
    const wire = makeWire({ terms: () => this.deps.review.terms(), fetch: this.deps.fetch ?? fetch, exec: this.deps.exec ?? bunExec });
    const ctl = new AbortController();
    const ms = Math.max(50, o.timeoutS * 1000 * (this.cfg.timeoutScale ?? 1));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SeatError("timeout", `no answer within ${Math.round(ms / 1000)} s; it was aborted`)); }, ms); });
    const after = (usd: number) => {
      const queryHit = this.checkQueries(wire.queries);
      const overrun = usd > o.worst + 1e-9;
      return { queries: wire.queries.slice(0, 50), queryHit, overrun };
    };
    try {
      const a = await Promise.race([fn(wire, ctl.signal), deadline]);
      const usd = a.bill ? a.bill.usd : o.worst;
      const how: How = a.bill ? a.bill.how : "reserved (no bill)";
      this.ledger.settle(res.id, usd, how);
      if (o.seat) this.deps.review.addSpend(o.seat, usd, a.answer?.findings.length ?? 0, 0);
      return { kind: "ok", res: a, usd, how, ...after(usd) };
    } catch (e) {
      const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
      // Released with no charge only when nothing left (a privacy block on the wire, or nothing sent at all)
      // or the provider refused outright before any work (HTTP 4xx); otherwise its measured cost, or the
      // whole reservation when there's no usable figure (a timeout, a cut-off answer, a 5xx).
      const outright = ["auth", "credit", "quota", "unconfigured"].includes(err.kind) || (err.kind === "refused" && /^HTTP 4\d\d/.test(err.message));
      if (err instanceof PrivacyBlock || (wire.sent === 0 && err.kind !== "timeout") || (outright && err.cost_usd === 0)) {
        this.ledger.release(res.id);
        return { kind: "error", err, usd: 0, how: null, released: true, ...after(0) };
      }
      const usd = err.cost_usd > 0 ? err.cost_usd : o.worst;
      const how: How = err.cost_usd > 0 ? "estimated" : "reserved (no bill)";
      this.ledger.settle(res.id, usd, how);
      if (o.seat) this.deps.review.addSpend(o.seat, usd, 0, 0);
      return { kind: "error", err, usd, how, released: false, ...after(usd) };
    } finally { clearTimeout(timer); }
  }
  // The queries a provider said it ran, checked after the fact: a private term there is an alarm.
  private checkQueries(queries: string[]): string[] {
    if (!queries.length) return [];
    const c = textCheck(queries.join("\n"), this.deps.review.terms());
    return c.ok ? [] : (c as { why: string[] }).why;
  }

  // ---- the checks before any spend ----
  // Near-free calls that make an unknown model or tool type fail before the trial spends: each Gemini model
  // with the trial's own settings (not served or refused: that configuration is skipped; today's default
  // not served: the run stops), Claude with the tool types the suite uses, and Codex's version, its model
  // list (or, when that can't be read, a tiny probe per model), each skip saying why.
  async preflight(st: RunState, suite: Suite): Promise<boolean> {
    const pf: Preflight = st.preflight ?? { done: false, at: this.iso(), tries: 0, checked: {}, skip: {}, third_party_routing: false };
    st.preflight = pf;
    if (suite.name === "research") { const a = readApproval(this.cfg.recordDir); pf.third_party_routing = a.ok && a.third_party; }
    const configs = configsFor(suite.name);
    const day = this.deps.review.day();
    const retryLater = (why: string): boolean => {
      pf.tries++;
      if (pf.tries >= 3) { this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `the checks before any spend couldn't finish (${why}).` }); return false; }
      this.save(st); return false;
    };
    const tiny = (model: string, outTokens: number, fees = 0) => worstOfCeiling({ steps: 1, contextTokens: tokensOf(400), maxOut: outTokens, toolFeesUsd: fees, price: ceilingPrice(model), runs: 0 });
    const preCall = async (id: string, seat: ReviewSeatName, worst: number, runs: number, fn: (w: Wire, s: AbortSignal) => Promise<AskResult>) => {
      const rec = st.calls[id] ?? { status: "interrupted" as CallStatus, attempts: 0, cost_usd: 0, at: this.iso() };
      st.calls[id] = rec; rec.attempts++; rec.worst_usd = worst; this.save(st);
      const x = await this.exchange(st, { call: id, attempt: rec.attempts, seat, worst, runs, timeoutS: 120 }, fn);
      if (x.kind === "denied") { Object.assign(rec, { status: "held", error: x.detail, at: this.iso() }); this.save(st); return x; }
      Object.assign(rec, { status: x.kind === "ok" ? "done" : "failed", final: true, cost_usd: rec.cost_usd + x.usd, how: x.kind === "ok" ? x.how : (x.how ?? undefined), at: this.iso(),
        ...(x.kind === "error" ? { error: `${x.err.kind}: ${x.err.message}`.slice(0, 300) } : {}) });
      this.save(st);
      return x;
    };
    // Gemini: one tiny call per model.
    const gem = this.deps.providers.gemini;
    for (const c of configs.filter((x) => x.seat === "gemini")) {
      if (pf.skip[c.id] || pf.checked[c.model] === "ok") continue;
      if (pf.checked[c.model]) { pf.skip[c.id] = pf.checked[c.model]; continue; }
      if (!gem?.validate) { pf.skip[c.id] = "skipped: no Gemini key in the App"; continue; }
      const x = await preCall(`pre|gemini|${c.model}`, "gemini", tiny(c.model, LIMITS.validateOut + LIMITS.geminiThinking), 0,
        (wire, signal) => gem.validate!({ wire, signal, day, model: c.model, thinking: LIMITS.geminiThinking }) as any);
      if (x.kind === "denied") { if (x.reason === "busy") return false; return this.denyStop(st, x, "the check of Gemini's models"); }
      if (x.kind === "error") {
        const http = /^HTTP (\d+)/.exec(x.err.message)?.[1];
        if (http === "404" || /not found|not served/i.test(x.err.message)) pf.checked[c.model] = `skipped: ${c.model} isn't served (${x.err.message})`;
        else if (x.err.kind === "refused" || http === "400") pf.checked[c.model] = `skipped: ${c.model} refused the trial's settings (${x.err.message})`;
        else return retryLater(`Gemini answered ${x.err.message}`);
        pf.skip[c.id] = pf.checked[c.model];
        if (c.defaultModel) { this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `today's default Gemini model, ${c.model}, isn't usable (${pf.checked[c.model]}), so the run stopped before any spend on the trial itself.` }); return false; }
      } else pf.checked[c.model] = "ok";
      this.save(st); return true;
    }
    // Claude: the tool types this suite uses, before any spend.
    const claude = this.deps.providers.claude;
    if (claude?.validate && !pf.checked.claude) {
      const research = suite.name === "research";
      // With the tools on, one search or fetch could still happen inside the 16 tokens: its results are allowed for.
      const worst = research ? worstOfCeiling({ steps: 3, contextTokens: tokensOf(400) + 20_000 + LIMITS.claudeFetchTokens, maxOut: LIMITS.validateOut, toolFeesUsd: 0.01, price: ceilingPrice("claude-opus-5-5"), runs: 0 })
        : tiny("claude-opus-5-5", LIMITS.validateOut);
      const x = await preCall("pre|claude", "claude", worst, 0,
        (wire, signal) => claude.validate!({ wire, signal, day, model: GRADERS[0].model, search: research, maxSearches: 1, fetch: research, maxFetches: 1 }) as any);
      if (x.kind === "denied") { if (x.reason === "busy") return false; return this.denyStop(st, x, "the check of Claude's setup"); }
      if (x.kind === "error") {
        if (x.err.kind === "refused" || /^HTTP 4/.test(x.err.message)) { this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `Claude refused the trial's setup (a model or tool type it doesn't take: ${x.err.message}), so nothing else was sent.` }); return false; }
        return retryLater(`Claude answered ${x.err.message}`);
      }
      pf.checked.claude = "ok"; this.save(st); return true;
    }
    // Codex: its version, its model list (best effort), and a tiny probe per model it doesn't list.
    const codex = this.deps.providers.codex;
    const codexConfigs = configs.filter((x) => x.seat === "codex");
    if (codexConfigs.length && !pf.checked.codex) {
      if (!codex) { for (const c of codexConfigs) pf.skip[c.id] = "skipped: Codex isn't set up"; pf.checked.codex = "none"; this.save(st); return true; }
      const wire = makeWire({ terms: () => this.deps.review.terms(), fetch: this.deps.fetch ?? fetch, exec: this.deps.exec ?? bunExec });
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60_000 * (this.cfg.timeoutScale ?? 1));
      try {
        pf.codex_version = await codex.version(wire, ctl.signal);
        pf.codex_models = await codex.models(wire, ctl.signal);
      } catch (e) { if (e instanceof PrivacyBlock) { this.end(st, "stopped", { reason: "privacy", at: this.iso(), detail: e.message }); return false; } }
      finally { clearTimeout(t); }
      pf.checked.codex = "listed";
      this.save(st); return true;
    }
    for (const c of codexConfigs.filter((x) => x.optional && x.model)) {
      if (pf.skip[c.id] || pf.checked[`codex:${c.model}`]) continue;
      if (pf.codex_models) {
        pf.checked[`codex:${c.model}`] = pf.codex_models.includes(c.model) ? "ok" : "not listed";
        if (!pf.codex_models.includes(c.model)) pf.skip[c.id] = `skipped: not listed by the installed Codex (${pf.codex_version ?? "version unknown"})`;
        continue;
      }
      const x = await preCall(`pre|codex|${c.model}`, "openai", 0, 1,
        (wire, signal) => codex!.ask({ wire, signal, day, model: c.model, system: "Reply with the word ready.", user: "ready?", maxOut: 0 }));
      if (x.kind === "denied") { if (x.reason === "busy") return false; return this.denyStop(st, x, "the Codex model probe"); }
      if (x.kind === "error") {
        if (CODEX_NO_MODEL.test(x.err.message) || x.err.kind === "refused") { pf.checked[`codex:${c.model}`] = "refused"; pf.skip[c.id] = `skipped: refused by the installed Codex (${pf.codex_version ?? "version unknown"}): ${x.err.message}`.slice(0, 300); }
        else return retryLater(`Codex answered ${x.err.message}`);
      } else pf.checked[`codex:${c.model}`] = "ok";
      this.save(st); return true;
    }
    pf.done = true; pf.at = this.iso();
    this.save(st);
    return true;
  }
  private denyStop(st: RunState, x: { reason: string; detail: string }, what: string): boolean {
    if (x.reason === "budget") this.end(st, "stopped", { reason: "budget", at: this.iso(), detail: `${what} wasn't made: ${x.detail}.` });
    else this.end(st, "stopped", { reason: "caps", at: this.iso(), detail: `${what} wasn't made: ${x.detail}.` });
    return false;
  }

  // ---- one call ----
  async attempt(st: RunState, suite: Suite, spec: CallSpec, task: Task, shape: CallShape): Promise<"settled" | "stop" | "wait" | "held"> {
    const rec: CallRec = st.calls[spec.id] ?? { status: "interrupted", attempts: 0, cost_usd: 0, at: this.iso() };
    st.calls[spec.id] = rec;
    const settle = (status: CallStatus, error: string) => { Object.assign(rec, { status, final: true, error, at: this.iso() }); delete rec.next_at; this.save(st); return "settled" as const; };
    const day = this.deps.review.day();
    const terms = this.deps.review.terms();

    // What leaves, built first: the plan-time check reads all of it (the wire check reads it again as sent).
    let text = "", chars = 0;
    let send: (wire: Wire, signal: AbortSignal) => Promise<AskResult>;
    let labels: string[] = [];
    let adoptedCount = 0;
    const c = spec.kind === "output" ? configById(suite.name, spec.config)! : undefined;
    if (spec.kind === "output") {
      const prov = this.providerFor(c!);
      if (!prov) return settle("skipped", `skipped: no ${c!.seat} key or sign-in in the App`);
      if (task.kind === "review") {
        const b = task.brief;
        text = `${b.topic}\n${b.question}\n${b.body}`; chars = taskChars(task);
        send = (wire, signal) => prov.ask({ wire, signal, day, model: shape.model, brief: b, maxOut: shape.maxOut, thinking: shape.thinking,
          search: shape.search, maxSteps: shape.maxSteps, setting: shape.setting });
      } else {
        const p = researchPrompt(task);
        text = `${p.system}\n${p.user}`; chars = taskChars(task);
        send = (wire, signal) => prov.ask({ wire, signal, day, model: shape.model, system: p.system, user: p.user, maxOut: shape.maxOut, thinking: shape.thinking,
          search: shape.search, maxSearches: shape.maxSearches, maxSteps: shape.maxSteps, setting: shape.setting });
      }
    } else {
      const g = GRADERS.find((x) => x.id === spec.grader)!;
      const prov = g.id === "claude" ? this.deps.providers.claude : this.deps.providers.codex;
      if (!prov) return settle("skipped", g.id === "claude" ? "skipped: no Anthropic key in the App" : "skipped: Codex isn't set up");
      const outputs = this.outputsOf(st, task.id);
      if (!outputs.length) return settle("skipped", "skipped: no output of this task to grade");
      const key = this.labelsFor(st, task.id, outputs);
      const byCall = Object.fromEntries(Object.entries(key).map(([l, call]) => [call, l]));
      // No grader reads an output its own family served.
      const mine = outputs.filter((o) => byCall[o.call] && familyOf(seatOfConfig(o.config), o.served_model ?? o.model ?? "") !== g.family);
      if (!mine.length) return settle("skipped", "skipped: every output of this task was served by the grader's own family");
      // Order shuffled for each grader call on its own; the grader gets the output's own words only.
      const labelled: Labelled[] = shuffled(mine.map((o) => ({ label: byCall[o.call],
        output: { call: "", config: "", verdict: o.verdict, findings: o.findings, text: o.text, urls: o.urls } as Output })), () => this.rand());
      labels = labelled.map((x) => x.label);
      const gp = gradePrompt(task, labelled);
      adoptedCount = task.kind === "review" ? (/<adopted>\n([\s\S]*?)\n<\/adopted>/.exec(gp.user)?.[1].split("\n").length ?? 0) : 0;
      const blind = blindViolations(`${gp.system}\n${gp.user}`);
      if (blind.length) return settle("blocked", `blocked: the grading prompt wasn't blind (${blind.join("; ")}); nothing was sent`);
      text = `${gp.system}\n${gp.user}`; chars = text.length;
      const domains = task.kind !== "review" ? [...new Set(mine.flatMap((o) => (o.urls ?? []).map((u) => { try { return new URL(u).hostname; } catch { return ""; } })).filter(Boolean))] : [];
      send = (wire, signal) => prov.ask({ wire, signal, day, model: shape.model, system: gp.system, user: gp.user, schema: gp.schema, maxOut: shape.maxOut,
        fetch: shape.fetch && domains.length > 0, maxFetches: shape.maxFetches, allowedDomains: domains });
    }

    // 1. The private-terms check on what was assembled (and again on the wire as it is sent).
    const priv = textCheck(text, terms);
    if (!priv.ok) return settle("blocked", `blocked: privacy (${(priv as { why: string[] }).why.join("; ")}); nothing was sent`);
    // 2. Its hard ceiling; a call that can't be given one isn't run.
    const ceiling = ceilingOf(shape, chars);
    if (!ceiling) return settle("skipped", "skipped: no hard ceiling can be put on this configuration, so it isn't run");
    const worst = worstOfCeiling(ceiling);
    rec.worst_usd = worst;
    const started = Date.now();
    const x = await this.exchange(st, { call: spec.id, attempt: rec.attempts + 1, seat: shape.reviewSeat, worst, runs: ceiling.runs, ...(spec.kind === "grade" ? { hold: this.holdKey(st, task.id) } : {}), timeoutS: shape.timeoutS },
      async (wire, signal) => {
        const a = await send(wire, signal);
        if (spec.kind === "grade") {
          const parsed = parseGrades(a.json, task.kind, labels, adoptedCount);
          if (!parsed.grades) throw new SeatError("bad_output", parsed.error!, a.bill?.usd ?? 0);
          (a as any).grades = parsed.grades;
        }
        return a;
      });
    if (x.kind === "denied") {
      if (x.reason === "busy") return "wait";
      if (x.reason === "seat") { Object.assign(rec, { status: "held", error: x.detail, worst_usd: worst, at: this.iso() }); this.save(st); return "held"; }
      // Inside a task already held, an output that no longer fits is skipped and the task is still graded.
      if (spec.kind === "output" && st.held[task.id]) return settle("skipped", `skipped: the trials budget: ${x.detail}`);
      this.end(st, "stopped", { reason: "budget", at: this.iso(), detail: `the next call (${shape.label} on ${task.id}) wasn't made: ${x.detail}.` });
      return "stop";
    }
    rec.attempts++;
    Object.assign(rec, { cost_usd: rec.cost_usd + x.usd, ms: Date.now() - started, at: this.iso(), queries: x.queries.length });
    if (x.kind === "ok") {
      const a = x.res;
      const served = a.served;
      const family = spec.kind === "output" ? familyOf(c!.seat, served) : GRADERS.find((g) => g.id === (spec as any).grader)!.family;
      if (spec.kind === "output") {
        const out: Output = task.kind === "review" && a.answer
          ? { ...reviewOutput(spec.id, c!.id, a.answer), task: task.id, model: shape.model || served, served_model: served, queries: x.queries }
          : { call: spec.id, config: c!.id, task: task.id, model: shape.model || served, served_model: served, text: a.text, urls: a.urls, queries: x.queries };
        writeAtomic(this.p().output(st.suite, st.run, spec.id), JSON.stringify(out, null, 1));
      } else writeAtomic(this.p().grade(st.suite, st.run, spec.id), JSON.stringify({ call: spec.id, task: task.id, grader: (spec as any).grader,
        family, model: served, queries: x.queries, grades: (a as any).grades as OutputGrade[] }, null, 1));
      Object.assign(rec, { status: "done", final: true, how: x.how, tokens: a.tokens, searches: a.searches, model: shape.model || served, served, family });
      delete rec.error; delete rec.next_at;
    } else {
      const err = x.err;
      if (x.how) rec.how = x.how;
      if (err instanceof PrivacyBlock) { Object.assign(rec, { status: "blocked", final: true, error: err.message }); delete rec.next_at; }
      else if (err instanceof CodexToolUse) { Object.assign(rec, { status: "failed", final: true, error: err.message }); delete rec.next_at; }
      else if (c && (c.optional || c.seat === "perplexity") && (CODEX_NO_MODEL.test(err.message) || (err.kind === "refused" && /^HTTP 4/.test(err.message)))) {
        Object.assign(rec, { status: "skipped", final: true, error: `skipped: refused by the provider (${err.message})`.slice(0, 300) }); delete rec.next_at;
      } else {
        if (err.kind === "quota" && shape.reviewSeat) st.cool[shape.reviewSeat] = new Date(this.now().getTime() + (this.cfg.coolMs ?? 15 * 60_000)).toISOString();
        const again = rec.attempts < 2 && (["transient", "timeout", "quota", "bad_output"] as ErrorKind[]).includes(err.kind);
        Object.assign(rec, { status: "failed", final: !again, error: `${err.kind}: ${err.message}`.slice(0, 300) });
        if (again) rec.next_at = new Date(this.now().getTime() + (err.kind === "quota" ? (this.cfg.coolMs ?? 15 * 60_000) : 120_000)).toISOString();
        else delete rec.next_at;
      }
    }
    this.save(st);
    if (x.queryHit.length) {
      this.alarm(`the search queries a provider ran for ${spec.id.split("|").slice(0, 2).join(" ")} matched the private-terms list (${x.queryHit.join("; ")}). The run is stopped; check the queries logged with that call.`);
      this.end(st, "stopped", { reason: "privacy", at: this.iso(), detail: `a provider's own search queries matched the private-terms list (${x.queryHit.join("; ")}).` });
      return "stop";
    }
    if (x.overrun) {
      this.alarm(`a trial call (${shape.label}) cost $${x.usd.toFixed(4)}, more than its reserved worst case of $${worst.toFixed(4)}. The run is stopped; the ceilings need a look before it resumes.`);
      this.end(st, "stopped", { reason: "budget", at: this.iso(), detail: `a call cost more than its ceiling ($${x.usd.toFixed(4)} against $${worst.toFixed(4)}).` });
      return "stop";
    }
    return "settled";
  }
  private providerFor(c: Config): Provider | undefined {
    const p = this.deps.providers;
    return c.seat === "claude" ? p.claude : c.seat === "gemini" ? p.gemini : c.seat === "perplexity" ? p.perplexity : c.seat === "codex" ? p.codex : undefined;
  }
}

// A stored review task's texts checked now: a brief with a private term keeps the task, whose every call
// is then blocked; adopted notes or a diff with one are left out (recall, or the diff, then isn't graded).
export function checkReviewTask(t: ReviewTask, terms: string | null) {
  t.notes = [];
  const b = textCheck(`${t.brief.topic}\n${t.brief.question}\n${t.brief.body}`, terms);
  if (!b.ok) t.notes.push(`the brief matched the private-terms list (${(b as any).why.join("; ")}): its calls are blocked`);
  if (t.adopted) { const a = textCheck(t.adopted, terms); if (!a.ok) { t.adopted = null; t.notes.push("the adopted notes matched the private-terms list: left out, so recall isn't graded"); } }
  if (t.diff) { const d = textCheck(t.diff, terms); if (!d.ok) { t.diff = null; t.notes.push("the diff matched the private-terms list: left out"); } }
  for (const o of t.originals) {
    const oc = textCheck(o.findings.map((f) => `${f.problem}\n${f.fix}`).join("\n"), terms);
    if (!oc.ok) t.notes.push(`the original answer of ${o.seat} matched the private-terms list: the task's grading is blocked`);
  }
}
