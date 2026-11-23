// The trials runner: runs inside the review runner's process (../review/main.ts), which holds the API
// keys, in a loop of its own so a long trial never holds up a real review. One call at a time.
//
// Cain asks with trial.sh (cli.ts), which leaves a request in /data/trials-inbox: a known suite and the
// command, nothing else (no budget, no configurations, no run id). Only this runner, as root, writes
// /data/trials, so the tasks, the spend and the blind key are the runner's alone. Everything there is
// readable by Cain's group.
//
// The inbox (second review round): a request file is opened with O_NOFOLLOW (and O_NONBLOCK, so a FIFO can't
// hang the runner), taken only if it is a regular file of a few KB, with one link, owned by a uid on the
// runner's allow-list (Cain's user); it is then moved into a folder only the runner writes
// (/data/trials/inbox-taken), checked to be the very file opened, and parsed from that same descriptor. A paid
// run or a resume starts only from such a file.
//
// The owner's say (fourth round): a paid run, a resume and the preflight start only while the owner's run
// allowance covers their cap (the App option trials_run_allowance_usd, default 0, read only from root's options
// file like the research approval; ledger.ts grant). The assistant's inbox is a submission channel only: a request
// there asks, the allowance decides. And no paid suite runs on a build until `trial.sh preflight` has written its
// record for this build on this machine (/data/trials/preflight.json): its checks, with no owner text, under a cap
// of a few dollars. A configuration whose check failed there stays disabled, named.
//
// Fifth round:
// - His go per paid run: a run, a resume and the preflight start only with a one-time approval from his tap on Cain's
//   trial card (../trial-token.ts), signed by the link's trial key, bound to that exact plan (its hash: planHash, the
//   one trial.sh plan prints) and its cap, good for 2 hours, and consumed here (an exclusive create of its nonce under
//   /data/trials/approvals-used) before anything is dispatched. The allowance stays the ceiling over them all.
// - Trial keys of their own: the App options trials_*_api_key, never the review service's. Every paid start and step
//   refuses while any is empty or equals the review key for that provider, naming it (keyProblems).
// - SUPERVISOR_TOKEN in this process's own environment (or its /proc environ) means no paid dispatch at all.
// - The preflight record is keyed on the trials code, the installed Codex, the configured models and the trials
//   options, and lasts 7 days (preflightError); a Gemini check that showed no thinking leaves its model disabled.
//
// Approvals (second review round): the research approval (the hashes of the questions file, its answer notes
// and the rubric) and Perplexity's third-party routing are read only from the App's options
// (/data/options.json, root's file, set in Home Assistant), never from a file Cain's user or the inbox group
// can write.
//
//   /data/trials/budget.json                 the one budget (ledger.ts): spent, reservations out, task holds, grants
//   /data/trials/preflight.json              the preflight's record: build, machine, each check, what is disabled
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
// aborted at it (Codex's whole process group is killed).
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { centsOf, readTrialToken, trialPublicKey, type TrialAction, type TrialTarget } from "../trial-token.ts";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { FINAL, SeatError, textCheck, type ErrorKind } from "../review/core.ts";
import { loadReview, type Runner } from "../review/runner.ts";
import type { Fetch } from "../review/seats/common.ts";
import type { Exec } from "../review/seats/openai.ts";
import { CAIN_UID } from "../owned.ts";
import {
  DEFAULT_BUDGET_USD, GEMINI_MODELS, PREFLIGHT_CAP_USD, modelsId, planHash, preflightCap, preflightPlanHash, runCap, GRADERS, LIMITS, PERPLEXITY_OWN_MODEL, SEAT_LIMITS, blindViolations, callShape, callsFor, ceilingOf, checkQuestions, configById, configsFor,
  familyOf, fetchAllowed, gradeCharsBound, gradePrompt, isSuite, ledgerCap, ledgerMargin, makeLabels, noteFetchUrls, notesSha, panelFor, parseGrades, pickReviewTasks, planOf, researchPrivacy, researchPrompt, reviewOutput, rubricSha,
  seatOfConfig, shuffled, taskChars, thinkingAllowance, toolViolation, tokensOf, ceilingPrice, worstOf, worstOfCeiling, trialAllowance,
  type CallShape, type CallSpec, type CitedPage, type Config, type GraderId, type Labelled, type Output, type OutputGrade,
  type ResearchTask, type ReviewDir, type ReviewSeatName, type ReviewTask, type SeatLimit, type Suite, type SuiteName, type Task,
} from "./core.ts";
import { CODEX_NO_MODEL, CODEX_ROOT, CodexToolUse, CodexWebSearch, usageOf, type AskResult, type CodexProvider, type Provider, type ThinkingSeen } from "./calls.ts";
import { Ledger, ownerAlive, readBudgetFile, type Budget, type How, type SeatWindow, type Spend } from "./ledger.ts";
import { PrivacyBlock, makeWire, type Wire } from "./guard.ts";
import { CODEX_MIN_VERSION, codexIdentity, codexVersionOf, groupExec, versionAtLeast, which, type Isolation } from "./sandbox.ts";
import { fetchCitedPage, type PageFetch } from "./pages.ts";
import { writeReport } from "./report.ts";

export type TrialsConfig = {
  dir: string;                 // /data/trials
  inboxDir?: string;           // /data/trials-inbox (none: no paid run can start)
  inboxUids?: number[];        // the senders allowed: Cain's user
  recordDir: string;           // /data/record, the record keeper's copy
  budgetUsd: number;           // the App option trials_budget_usd, and nothing else
  optionsFile?: string;        // /data/options.json: the App's options, root's file (the approvals)
  optionsUid?: number;         // its owner (root)
  build?: string;              // tests only: this build's id (default: buildId())
  machine?: string;            // tests only: this machine's id (default: machineId())
  seatLimits?: Partial<Record<ReviewSeatName, SeatLimit>>;   // tests only: the trial allowance per window
  timeoutScale?: number;       // tests only: shortens every call's wall-clock limit
  coolMs?: number;             // a seat's cooling after a 429 or usage limit (default 15 minutes)
  seatGapMs?: number;          // the least time between two trial calls on one seat (default 10 seconds)
  // Fifth round:
  approvalPub?: string;        // the link's trial key, public half (default /data/trust/trial.pub, root's)
  approvalPubUid?: number;     // its owner (root)
  keyCheck?: KeyCheck;         // the trial keys against the review keys (trialKeyCheck); none: every provider refused
  keyPrint?: string;           // a hash of the trial keys together, for the preflight's key (never a key itself)
  supervisorSeen?: () => boolean;   // tests only: whether SUPERVISOR_TOKEN is in this process's environment
  codexId?: string;            // tests only: the installed Codex (default: a hash of its binary)
  tallyUid?: number;           // the allowance tally's owner (default: this process's uid, root on the Pi)
  // Sixth round:
  privateDir?: string;         // the tally, the used approvals and the has-history marker (default <dir>-private, 0700)
  linkKey?: string;            // the link's private trial key (default /data/link/trial.key): readable by its owner only
  linkKeyUid?: number;         // the link's uid (root)
  tokenFiles?: string[];       // the init's token sources (default TOKEN_FILES): none may be readable by the assistant or the runner
  assistantUid?: number;       // the assistant's uid (Cain's user)
  assistantGids?: number[];    // its groups (default: read from /etc/passwd and /etc/group)
  runnerUid?: number;          // tests only: the runner's uid (default: this process's)
  codexIdentity?: string | null;        // tests only: the trials' Codex sign-in's identity (default: from its home)
  reviewCodexIdentity?: string | null;  // tests only: the review service's Codex sign-in's identity
  codexHome?: string;          // the trials' own Codex home (its sign-in), apart from the review service's
  reviewCodexHome?: string;    // the review service's Codex home (/data/codex)
  startedAt?: number;          // when this runner started (the options-file line); default now
};
// The init's token sources (sixth round): s6's saved container environment and init's own environment.
export const TOKEN_FILES = ["/run/s6/container_environment/SUPERVISOR_TOKEN", "/run/s6/container_environment/HASSIO_TOKEN", "/proc/1/environ"];
// Whether a uid (with its groups) could read a file, by the mode bits of the file and of every folder above it. Root reads
// anything. A file that isn't there can't be read.
export function readableBy(path: string, uid: number, gids: number[]): boolean {
  if (uid === 0) return existsSync(path);
  const can = (st: { uid: number; gid: number; mode: number }, bits: { u: number; g: number; o: number }) =>
    st.uid === uid ? !!(st.mode & bits.u) : gids.includes(st.gid) ? !!(st.mode & bits.g) : !!(st.mode & bits.o);
  let st;
  try { st = statSync(path); } catch { return false; }
  if (!can(st, { u: 0o400, g: 0o040, o: 0o004 })) return false;
  for (let d = dirname(path); ; d = dirname(d)) {
    try { if (!can(statSync(d), { u: 0o100, g: 0o010, o: 0o001 })) return false; } catch { return false; }
    if (d === dirname(d)) break;
  }
  return true;
}
// A user's groups from /etc/passwd and /etc/group.
export function groupsOf(uid: number, passwd = "/etc/passwd", group = "/etc/group"): number[] {
  const out = new Set<number>();
  let name = "";
  try { for (const l of readFileSync(passwd, "utf8").split("\n")) { const f = l.split(":"); if (Number(f[2]) === uid) { name = f[0]; out.add(Number(f[3])); } } } catch { /* none */ }
  try { for (const l of readFileSync(group, "utf8").split("\n")) { const f = l.split(":"); if (name && (f[3] ?? "").split(",").includes(name)) out.add(Number(f[2])); } } catch { /* none */ }
  return [...out].filter(Number.isInteger);
}
// The go/no-go lines of the preflight report (sixth round), by name.
export const GO_LINES = {
  bwrap: "bubblewrap starts in the container",
  config: "the requirements file is read and honoured inside the wrapper (the effective config check)",
  probes: "the credential, environ and network probes are refused",
  options: "saving options rewrites the options file without a restart",
  thinking: "each Gemini model emits thinking on its check",
  discord: "the trial card and its tap arrive on real Discord",
} as const;
export type GoLineName = keyof typeof GO_LINES;
export type GoStatus = { status: "go" | "no-go" | "not checked"; detail: string };
// ---- the trial keys (fifth round) ----
export type KeyName = "anthropic" | "gemini" | "perplexity";
export type KeyCheck = Record<KeyName, "ok" | "empty" | "same">;
export const KEY_NAMES: Record<KeyName, string> = { anthropic: "Anthropic", gemini: "Google (Gemini)", perplexity: "Perplexity" };
export const KEY_OPTIONS: Record<KeyName, string> = { anthropic: "trials_anthropic_api_key", gemini: "trials_gemini_api_key", perplexity: "trials_perplexity_api_key" };
export function trialKeyCheck(trial: Partial<Record<KeyName, string>>, review: Partial<Record<KeyName, string>>): KeyCheck {
  const one = (k: KeyName) => { const t = (trial[k] ?? "").trim(); return !t ? "empty" as const : t === (review[k] ?? "").trim() ? "same" as const : "ok" as const; };
  return { anthropic: one("anthropic"), gemini: one("gemini"), perplexity: one("perplexity") };
}
// Each provider whose trial key isn't right, named. No check at all counts as every key missing.
export function keyProblems(k?: KeyCheck | null): string[] {
  return (Object.keys(KEY_NAMES) as KeyName[]).flatMap((n) => {
    const v = k?.[n] ?? "empty";
    return v === "ok" ? [] : [v === "same" ? `${KEY_NAMES[n]}'s trial key (${KEY_OPTIONS[n]}) is the review service's own key` : `${KEY_NAMES[n]} has no trial key of its own (${KEY_OPTIONS[n]} is empty)`];
  });
}
export const keyPrintOf = (keys: Partial<Record<KeyName, string>>) => createHash("sha256").update(JSON.stringify([keys.anthropic ?? "", keys.gemini ?? "", keys.perplexity ?? ""])).digest("hex").slice(0, 16);
// SUPERVISOR_TOKEN in a process's own environment: in its env, or in its /proc environ (fifth round).
export function supervisorTokenSeen(env: Record<string, string | undefined> = process.env, environFile = "/proc/self/environ"): boolean {
  if (Object.keys(env).some((k) => k === "SUPERVISOR_TOKEN")) return true;
  try { return readFileSync(environFile).toString("latin1").split("\0").some((e) => e.startsWith("SUPERVISOR_TOKEN=")); } catch { return false; }
}
// The installed Codex: a hash of its binary (fifth round), or "none".
export function codexInstalledId(bin = process.env.CODEX_BIN ?? "codex"): string {
  const p = which(bin);
  if (!p) return "none";
  try { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16); } catch { return "unreadable"; }
}
export type TrialDeps = {
  review: Runner;              // its ledger and caps, the guard's reserve, the private terms, Stop, relay, its queue
  providers: { claude?: Provider; gemini?: Provider; perplexity?: Provider; codex?: CodexProvider };
  fetch?: Fetch; exec?: Exec;  // what each call's Wire sends through (default: fetch, and Codex in its own process group)
  pageFetch?: PageFetch;       // the research grader's cited pages (sixth round; default: fetch)
  now?: () => Date; rand?: () => number; log?: (m: string) => void; owner?: string;
};

export type CallStatus = "done" | "failed" | "skipped" | "blocked" | "interrupted" | "held";
export type CallRec = {
  status: CallStatus; attempts: number; final?: boolean; cost_usd: number; how?: How; worst_usd?: number;
  ms?: number; tokens?: { input: number; output: number }; searches?: number; model?: string; served?: string; family?: string;
  queries?: number; error?: string; at: string; next_at?: string;
  // Every attempt's cost, by how it is known (failed and retried attempts included); unresolved is what was
  // charged at its worst case for want of a bill; plan_calls counts Codex calls (no dollars).
  spend?: { billed: number; estimated: number; unresolved: number; plan_calls: number };
};
export type Stop = { reason: "budget" | "caps" | "unavailable" | "privacy" | "approval" | "model" | "allowance" | "preflight" | "keys"; detail: string; at: string };
export type Preflight = { done: boolean; at: string; tries: number; codex_version?: string | null; codex_models?: string[] | null;
  checked: Record<string, string>; skip: Record<string, string>; third_party_routing: boolean;
  graders_off?: Record<string, string>;      // a grader whose check failed, or Codex not isolated
  served?: Record<string, string>;           // Perplexity: the model each level's check was served by
  codex_isolation?: Isolation;               // the run's sandbox self-test
  ids?: Record<string, string>;              // the exact model and tool ids each check used
  thinking?: Record<string, "yes" | "no" | "unknown">;   // Gemini: whether the model's output cap covered its thinking
  seeded?: boolean;                          // the build's preflight record seeded these checks
};
export type RunState = {
  format: 2; suite: SuiteName; run: string; status: "running" | "stopped" | "done";
  created_at: string; updated_at: string; stop?: Stop; stops: Stop[]; calls: Record<string, CallRec>; notes: string[];
  preflight?: Preflight; held: Record<string, true>; cool: Record<string, string>;
  kind?: "preflight";          // one suite's half of the build's preflight, not a run
  approved?: { nonce: string; plan: string; cap_cents: number; at: string };   // fifth round: the approval it started (or resumed) on
};
export type Mode = "resume" | "retry" | "new";
export type Request = { kind: "run"; suite: SuiteName; mode?: Mode; approval: string } | { kind: "report"; suite: SuiteName } | { kind: "preflight"; approval: string };

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
  preflight: join(dir, "preflight.json"),
  preflightReport: join(dir, "preflight.md"),
  pages: (s: string, r: string, task: string) => join(dir, s, r, "pages", fileOf(task)),
  // Sixth round: in the private folder, the runner's alone.
  privateDir: `${dir.replace(/\/+$/, "")}-private`,
  used: join(`${dir.replace(/\/+$/, "")}-private`, "approvals-used"),
});

// ---- the preflight's record (fourth round) ----
// This build: the trials' own source files (what decides every request) and the App's version when it is
// known. This machine: its machine id, or its host name. A record counts only for both.
export { PREFLIGHT_CAP_USD };
export function buildId(env = process.env): string {
  const h = createHash("sha256");
  const dir = import.meta.dir;
  for (const f of ["core.ts", "calls.ts", "guard.ts", "ledger.ts", "runner.ts", "sandbox.ts", "pages.ts", "plan.ts"]) { try { h.update(f); h.update(readFileSync(join(dir, f))); } catch { h.update(`${f}:missing`); } }
  return `${env.CAIN_VERSION ? `${String(env.CAIN_VERSION).replace(/[^\w.-]/g, "").slice(0, 20)}-` : ""}${h.digest("hex").slice(0, 16)}`;
}
export function machineId(): string {
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) { try { const t = readFileSync(f, "utf8").trim(); if (/^[0-9a-f]{16,64}$/i.test(t)) return createHash("sha256").update(t).digest("hex").slice(0, 16); } catch { /* none */ } }
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}
export type PreflightSuite = { run: string; checked: Record<string, string>; skip: Record<string, string>; graders_off: Record<string, string>; served: Record<string, string>;
  ids: Record<string, string>; thinking: Record<string, string>; codex_isolation?: Isolation; codex_version?: string | null; codex_models?: string[] | null };
export type PreflightKey = { code: string; machine: string; codex: string; models: string; options: string; codex_identity?: string };
export type PreflightRecord = { format: 1; id: string; status: "running" | "done" | "stopped"; build: string; machine: string; started_at: string; finished_at?: string;
  cap_usd: number; suites: Partial<Record<SuiteName, PreflightSuite>>; disabled: Record<string, string>; codex_daemon?: string; stop?: string;
  key?: PreflightKey;
  // Sixth round: the go/no-go lines, the installed Codex's version, what is known of key separation, and the approval.
  golines?: Partial<Record<GoLineName, GoStatus>>; codex_version?: string | null; key_separation?: string; approved_at?: string };
export const KEY_SEPARATION = "unverified beyond the string check: no provider the trials use exposes an organisation or workspace id per API key, so the trial keys are known only to differ from the review keys as strings";
export const PREFLIGHT_TTL_MS = 7 * 24 * 3_600_000;
const KEY_WHAT: Record<keyof PreflightKey, string> = { code: "the trials code", machine: "the machine", codex: "the installed Codex", models: "the configured models", options: "the trials options", codex_identity: "the trials' Codex sign-in" };
export function readPreflight(dir: string): PreflightRecord | null {
  const r = readJson<PreflightRecord | null>(paths(dir).preflight, null);
  return r && r.format === 1 && typeof r.build === "string" ? r : null;
}
// Whether a paid suite may run here: a finished preflight record under the same key (the trials code, the machine, the
// installed Codex, the configured models and the trials options), under 7 days old. The reason if not. A null key
// (trial.sh, before the runner has said) checks only the record's own state and age.
export function preflightError(rec: PreflightRecord | null, key: PreflightKey | null, nowMs: number): string | null {
  if (!rec) return "no preflight has run on this build: run trial.sh preflight first (a few dollars of checks, no owner text)";
  if (key) {
    if (!rec.key) return "the preflight on record has no key (it is from before the fifth round): run trial.sh preflight again";
    const changed = (Object.keys(KEY_WHAT) as (keyof PreflightKey)[]).filter((k) => rec.key![k] !== key[k]).map((k) => KEY_WHAT[k]);
    if (changed.length) return `the preflight on record doesn't match: ${changed.join(", ")} changed since it ran: run trial.sh preflight again`;
  }
  if (rec.status === "running") return "the preflight is still running: wait for it to finish";
  if (rec.status !== "done") return `the preflight didn't finish (${rec.stop ?? "stopped"}): run trial.sh preflight again`;
  const at = Date.parse(rec.finished_at ?? "");
  if (!Number.isFinite(at) || nowMs - at > PREFLIGHT_TTL_MS) return "the preflight on record is more than 7 days old: run trial.sh preflight again";
  return null;
}
// Whether a Gemini check showed the output cap covering thinking: thought and answer tokens never above the cap.
export function thinkingCover(t?: ThinkingSeen): "yes" | "no" | "unknown" {
  if (!t || !(t.thoughts > 0)) return "unknown";
  return t.thoughts + t.answer <= t.maxOut ? "yes" : "no";
}
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

// The research questions are in the record; the owner's approval of them is in the App's options only:
// trials_research_questions_sha256 (the questions file as it is), trials_research_notes_sha256 (its answer
// notes), trials_research_rubric_sha256 (the rubric), and trials_perplexity_third_party_routing. The options
// file is root's (set in Home Assistant): it must be a regular file owned by optionsUid that neither the group
// nor others can write, opened without following a link. A file anywhere else (the record, the inbox) never
// counts, so an approval written as Cain's user is ignored.
export const RESEARCH_QUESTIONS = "projects/harness/trials/research-questions.json";
export const OPTIONS_FILE = "/data/options.json";
export type AppOptions = { questions: string; notes: string; rubric: string; thirdParty: boolean; allowanceUsd: number; budgetUsd: number };
export function readOptions(path = OPTIONS_FILE, uid = 0): { ok: true; o: AppOptions } | { ok: false; why: string } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e: any) { return { ok: false, why: e?.code === "ELOOP" ? "the App's options file is a link" : "the App's options can't be read" }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1 << 20) return { ok: false, why: "the App's options file isn't a plain file" };
    if (st.uid !== uid || (st.mode & 0o022)) return { ok: false, why: "the App's options file isn't root's alone, so its approvals don't count" };
    const buf = Buffer.alloc(st.size); let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    const j = JSON.parse(buf.subarray(0, off).toString("utf8"));
    const h = (k: string) => (typeof j?.[k] === "string" && /^[0-9a-f]{64}$/.test(j[k]) ? j[k] : "");
    return { ok: true, o: { questions: h("trials_research_questions_sha256"), notes: h("trials_research_notes_sha256"), rubric: h("trials_research_rubric_sha256"),
      thirdParty: j?.trials_perplexity_third_party_routing === true,
      allowanceUsd: typeof j?.trials_run_allowance_usd === "number" && Number.isFinite(j.trials_run_allowance_usd) && j.trials_run_allowance_usd > 0 ? j.trials_run_allowance_usd : 0,
      budgetUsd: typeof j?.trials_budget_usd === "number" && Number.isFinite(j.trials_budget_usd) && j.trials_budget_usd >= 0 ? j.trials_budget_usd : DEFAULT_BUDGET_USD } };
  } catch { return { ok: false, why: "the App's options can't be read" }; }
  finally { try { closeSync(fd); } catch { /* closed */ } }
}
export type Hashes = { questions: string; notes: string; rubric: string };
export type Approval = { ok: true; sha: string; third_party: boolean; questions: unknown; tasks: ResearchTask[]; hashes: Hashes }
  | { ok: false; why: string; third_party: false; hashes?: Hashes };
// The three hashes of what is in the record now (trial.sh plan research prints them for the owner).
export function researchHashes(recordDir: string): { hashes?: Hashes; questions?: unknown; tasks?: ResearchTask[]; why?: string } {
  let text: string;
  try { text = readFileSync(join(recordDir, RESEARCH_QUESTIONS), "utf8"); } catch { return { why: `there is no questions file in the record (${RESEARCH_QUESTIONS})` }; }
  let questions: unknown;
  try { questions = JSON.parse(text); } catch { return { why: "the questions file isn't JSON" }; }
  const q = checkQuestions(questions);
  if (!q.tasks) return { why: `the questions aren't right: ${q.error}` };
  return { hashes: { questions: createHash("sha256").update(text).digest("hex"), notes: notesSha(q.tasks), rubric: rubricSha() }, questions, tasks: q.tasks };
}
export function readApproval(recordDir: string, optionsFile = OPTIONS_FILE, optionsUid = 0): Approval {
  const r = researchHashes(recordDir);
  if (!r.hashes) return { ok: false, why: r.why!, third_party: false };
  const opt = readOptions(optionsFile, optionsUid);
  if (!opt.ok) return { ok: false, why: `${(opt as { why: string }).why}; the owner's approval is read only from them`, third_party: false, hashes: r.hashes };
  const o = (opt as { o: AppOptions }).o;
  if (!o.questions || !o.notes || !o.rubric) return { ok: false, why: "the owner hasn't approved the questions, their answer notes and the rubric in the App's options", third_party: false, hashes: r.hashes };
  const changed = [o.questions !== r.hashes.questions ? "the questions" : "", o.notes !== r.hashes.notes ? "the answer notes" : "", o.rubric !== r.hashes.rubric ? "the rubric" : ""].filter(Boolean);
  if (changed.length) return { ok: false, why: `${changed.join(", ")} changed since the owner approved them in the App's options`, third_party: false, hashes: r.hashes };
  return { ok: true, sha: r.hashes.questions, third_party: o.thirdParty, questions: r.questions, tasks: r.tasks!, hashes: r.hashes };
}

// ---- the inbox ----
export const INBOX_MAX_BYTES = 4 * 1024;
export type TakenFile = { ok: true; text: string; moved: string } | { ok: false; why: string };
// Open without following, check the descriptor, move the file into the runner's own folder, check the moved
// file is the one opened, and read from that same descriptor. Anything else is removed from the inbox untaken.
export function takeInboxFile(path: string, takenDir: string, uids: number[], maxBytes = INBOX_MAX_BYTES): TakenFile {
  const drop = () => { try { unlinkSync(path); } catch { /* gone */ } };
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e: any) { drop(); return { ok: false, why: e?.code === "ELOOP" ? "it is a link" : "it can't be opened" }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) { drop(); return { ok: false, why: "it isn't a regular file" }; }
    if (st.size > maxBytes) { drop(); return { ok: false, why: `it is larger than ${maxBytes} bytes` }; }
    if (!uids.includes(st.uid)) { drop(); return { ok: false, why: "it isn't from a sender the runner takes requests from" }; }
    if (st.nlink !== 1) { drop(); return { ok: false, why: "it has more than one link" }; }
    mkdirSync(takenDir, { recursive: true, mode: 0o750 });
    const moved = join(takenDir, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
    try { renameSync(path, moved); } catch { drop(); return { ok: false, why: "it couldn't be moved out of the inbox" }; }
    let same = false;
    try { const l = lstatSync(moved); same = l.isFile() && l.ino === st.ino && l.dev === st.dev; } catch { /* gone */ }
    if (!same) { try { unlinkSync(moved); } catch { /* gone */ } return { ok: false, why: "it was swapped while it was being taken" }; }
    const buf = Buffer.alloc(maxBytes + 1); let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    if (off > maxBytes) return { ok: false, why: `it is larger than ${maxBytes} bytes` };
    return { ok: true, text: buf.subarray(0, off).toString("utf8"), moved };
  } finally { try { closeSync(fd); } catch { /* closed */ } }
}
// Only a request taken from the inbox by takeInboxFile carries this: request() starts a paid run or a resume
// only with it.
const FROM_INBOX: unique symbol = Symbol("taken from the inbox");

const REQUEST_KEYS = new Set(["kind", "suite", "mode", "approval"]);
const APPROVAL = /^trial1\.[A-Za-z0-9_-]{20,800}\.[A-Za-z0-9_-]{86}$/;
const NEEDS_APPROVAL = "a paid run, a resume or the preflight needs the owner's one-time approval from his tap on Cain's trial card (keeper.sh trial-approve), passed as --approval to trial.sh.";
// A request from the inbox: a known suite and the command, nothing else. The reason it isn't one, or null.
export function requestError(j: any): string | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return "not a request.";
  for (const k of Object.keys(j)) if (!REQUEST_KEYS.has(k)) return `it carries a field a request may not (${k.slice(0, 20).replace(/[^\w-]/g, "?")}); the budget is the App's option and the configurations are the runner's.`;
  if (j.approval !== undefined && (typeof j.approval !== "string" || !APPROVAL.test(j.approval))) return "its approval isn't a trial approval.";
  // A paid request without an approval is well formed: request() refuses it once its other checks have spoken (useApproval).
  if (j.kind === "preflight") return Object.keys(j).some((k) => k !== "kind" && k !== "approval") ? "a preflight request carries only its kind and its approval." : null;
  if (!isSuite(j.suite)) return "not a suite this runner knows (review-seats or research).";
  if (j.kind !== "run" && j.kind !== "report") return "a request is a run or a report.";
  if (j.mode !== undefined && (j.kind !== "run" || !["resume", "retry", "new"].includes(j.mode))) return "its mode isn't resume, retry or new.";
  if (j.kind === "report" && j.approval !== undefined) return "a report carries no approval.";
  return null;
}

type Exchange =
  | { kind: "ok"; res: AskResult; usd: number; how: How; queries: string[]; overrun: boolean; queryHit: string[] }
  | { kind: "denied"; reason: "budget" | "seat" | "busy" | "window" | "gone" | "allowance"; detail: string; retryAt?: string }
  | { kind: "error"; err: SeatError; usd: number; how: How | null; released: boolean; queries: string[]; overrun: boolean; queryHit: string[] };

export class TrialRunner {
  private now: () => Date; private rand: () => number; private log: (m: string) => void;
  private recovered = false;
  private startedAt: number;
  readonly ledger: Ledger;
  private lastCall: Record<string, number> = {};
  constructor(public cfg: TrialsConfig, public deps: TrialDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rand = deps.rand ?? Math.random;
    this.log = deps.log ?? ((m) => console.log(`[trials] ${m}`));
    this.ledger = new Ledger(cfg.dir, deps.owner, this.now, cfg.tallyUid, cfg.privateDir);
    this.startedAt = cfg.startedAt ?? Date.now();
  }
  get budget(): number { const b = this.cfg.budgetUsd; return Number.isFinite(b) && b >= 0 ? b : DEFAULT_BUDGET_USD; }
  private p = () => paths(this.cfg.dir);
  private relay(text: string) { try { this.deps.review.relay(text); } catch (e) { this.log(`couldn't relay: ${(e as Error).message}`); } }
  private iso = () => this.now().toISOString();
  private alarm(text: string) { this.log(`ALARM: ${text}`); this.relay(`Trials alarm: ${text} Nothing to tell him unless it needs his word.`); }

  committed(): number { const b = readBudget(this.cfg.dir); return b.spent_usd; }
  approval(): Approval { return readApproval(this.cfg.recordDir, this.cfg.optionsFile ?? OPTIONS_FILE, this.cfg.optionsUid ?? 0); }
  // The owner's run allowance, read now from root's options file (0 when it can't be read).
  allowance(): number { const o = readOptions(this.cfg.optionsFile ?? OPTIONS_FILE, this.cfg.optionsUid ?? 0); return o.ok ? (o as { o: AppOptions }).o.allowanceUsd : 0; }
  get build(): string { return this.cfg.build ?? (this.builtId ??= buildId()); }
  // ---- fifth round: the keys, the Supervisor token, the preflight's key, the owner's approval ----
  // Why nothing paid may go out now (the trial keys, SUPERVISOR_TOKEN in this process's environment), or null.
  paidGate(): string | null {
    const k = keyProblems(this.cfg.keyCheck);
    if (k.length) return `the trials can't spend: ${k.join("; ")}. Only the owner sets the trial keys, in the App's options`;
    if ((this.cfg.supervisorSeen ?? (() => supervisorTokenSeen()))()) return "the trials can't spend: SUPERVISOR_TOKEN is in the runner's own environment, so nothing paid is dispatched until the App starts without it";
    // Sixth round: the private folder, the link's private trial key, and the init's token files.
    const pp = this.ledger.privateProblem();
    if (pp) return `the trials can't spend: ${pp}`;
    const lk = this.linkKeyProblem();
    if (lk) return `the trials can't spend: ${lk}`;
    const tf = this.tokenFileProblem();
    if (tf) return `the trials can't spend: ${tf}`;
    return null;
  }
  // The link's private trial key must be readable by the link's uid alone (sixth round).
  linkKeyProblem(): string | null {
    const path = this.cfg.linkKey ?? "/data/link/trial.key";
    let st;
    try { st = lstatSync(path); } catch { return `the link's private trial key (${path}) can't be found, so its approvals can't be trusted`; }
    if (!st.isFile()) return "the link's private trial key isn't a plain file";
    if (st.uid !== (this.cfg.linkKeyUid ?? 0)) return "the link's private trial key isn't the link's";
    if (st.mode & 0o077) return "the link's private trial key can be read by others than the link";
    return null;
  }
  // The init's token sources (sixth round): none may be readable by the assistant's uid, nor by the runner's when the
  // runner isn't root (root reads every file, so as root its check is that the file is readable by no one but root).
  tokenFileProblem(): string | null {
    const files = this.cfg.tokenFiles ?? TOKEN_FILES;
    const auid = this.cfg.assistantUid ?? CAIN_UID;
    const agids = this.cfg.assistantGids ?? (this.gidsSeen ??= groupsOf(auid));
    const ruid = this.cfg.runnerUid ?? (process.getuid ? process.getuid() : 0);
    for (const f of files) {
      if (readableBy(f, auid, agids)) return `the init's token file ${f} can be read by the assistant's user, so nothing paid is dispatched (DOCS.md, the token files)`;
      if (ruid !== 0 && readableBy(f, ruid, groupsOf(ruid))) return `the init's token file ${f} can be read by the runner's user, so nothing paid is dispatched`;
      if (ruid === 0) { try { const st = statSync(f); if (st.uid !== 0 || (st.mode & 0o077)) return `the init's token file ${f} can be read by others than root, so nothing paid is dispatched`; } catch { /* not there: fine */ } }
    }
    return null;
  }
  private gidsSeen?: number[];
  // The trials' and the review service's Codex sign-ins, by identity (hashed ids; never a token).
  codexIdentities(): { trials: string | null; review: string | null } {
    return { trials: this.cfg.codexIdentity !== undefined ? this.cfg.codexIdentity : this.cfg.codexHome ? codexIdentity(this.cfg.codexHome) : null,
      review: this.cfg.reviewCodexIdentity !== undefined ? this.cfg.reviewCodexIdentity : this.cfg.reviewCodexHome ? codexIdentity(this.cfg.reviewCodexHome) : null };
  }
  preflightKey(): PreflightKey {
    const o = readOptions(this.cfg.optionsFile ?? OPTIONS_FILE, this.cfg.optionsUid ?? 0);
    const oo = o.ok ? (o as { o: AppOptions }).o : null;
    const options = createHash("sha256").update(JSON.stringify({ budget: this.budget, third: oo?.thirdParty ?? null, q: oo?.questions ?? null, n: oo?.notes ?? null, r: oo?.rubric ?? null,
      keys: this.cfg.keyPrint ?? null, readable: o.ok })).digest("hex").slice(0, 16);
    return { code: this.build, machine: this.machine, codex: this.cfg.codexId ?? (this.codexSeen ??= codexInstalledId()), models: modelsId(), options,
      codex_identity: this.codexIdentities().trials ?? "none" };
  }
  private codexSeen?: string;
  pfError(): string | null { return preflightError(readPreflight(this.cfg.dir), this.preflightKey(), this.now().getTime()); }
  // The link's trial key, public half: root's file, a plain file only root can write.
  private trialKey(): { ok: true; key: KeyObject } | { ok: false; why: string } {
    const path = this.cfg.approvalPub ?? "/data/trust/trial.pub";
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return { ok: false, why: "the link's trial key can't be read, so no approval counts" }; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 4096 || st.uid !== (this.cfg.approvalPubUid ?? 0) || (st.mode & 0o022)) return { ok: false, why: "the link's trial key file isn't root's alone, so no approval counts" };
      return { ok: true, key: trialPublicKey(readFileSync(fd, "utf8")) };
    } catch { return { ok: false, why: "the link's trial key can't be read, so no approval counts" }; }
    finally { try { closeSync(fd); } catch { /* closed */ } }
  }
  // What an approval for this target must name: the plan hash and the cap, as trial.sh plan prints them.
  approvalTarget(target: TrialTarget, suite?: Suite, pinned = true): { plan: string; cap: number } {
    if (target === "preflight") { const cap = preflightCap(this.budget); return { plan: preflightPlanHash(cap), cap }; }
    const cap = this.runCapFor(suite!, pinned);
    return { plan: planHash(suite!, pinned, cap), cap };
  }
  // The owner's approval checked (sixth round: not yet spent): signed by the link's trial key, for this target, this exact
  // plan, cap and action (a preflight, a start or a resume, as the link's card said), not expired, and not used before. It
  // is spent by the grant it starts (ledger.ts grant), in one durable step under the ledger's lock. The reason it doesn't
  // count, or what the grant spends.
  verifyApproval(token: unknown, target: TrialTarget, want: { plan: string; cap: number; action: TrialAction }): { why: string } | { spend: Spend; approved: { nonce: string; plan: string; cap_cents: number; at: string; action: TrialAction } } {
    if (typeof token !== "string" || !token) return { why: NEEDS_APPROVAL };
    const key = this.trialKey();
    if (!key.ok) return { why: `${(key as { why: string }).why}.` };
    const r = readTrialToken(token, (key as { key: KeyObject }).key, this.now().getTime());
    if (!r.ok) return { why: `its approval doesn't count: ${(r as { why: string }).why}.` };
    const c = r.claim;
    if (this.ledger.nonceUsed(c.nonce)) return { why: "its approval was already used: one tap allows one run. Ask him again with a new trial card." };
    if (c.suite !== target) return { why: `its approval is for ${c.suite}, not ${target}.` };
    if (c.action !== want.action) return { why: `its approval is for ${c.action === "resume" ? "a resume" : c.action === "start" ? "a new run" : "the preflight"}, and this would be ${want.action === "resume" ? "a resume" : want.action === "start" ? "a new run" : "the preflight"}: ask him again with a new trial card.` };
    if (c.plan !== want.plan) return { why: "its approval is for another plan than the one this run would make (the suite, its calls, its cap or what it sends changed since trial.sh plan printed it): run trial.sh plan again and ask him again." };
    if (c.cap_cents !== centsOf(want.cap)) return { why: `its approval names a cap of $${(c.cap_cents / 100).toFixed(2)}, and this run's cap is $${want.cap.toFixed(2)}.` };
    if (this.ledger.nonceUsed(c.nonce)) return { why: "its approval was already used: one tap allows one run. Ask him again with a new trial card." };
    return { spend: { nonce: c.nonce, suite: c.suite, plan: c.plan, cap_cents: c.cap_cents }, approved: { nonce: c.nonce, plan: c.plan, cap_cents: c.cap_cents, at: this.iso(), action: c.action } };
  }
  get machine(): string { return this.cfg.machine ?? (this.machineSeen ??= machineId()); }
  private builtId?: string; private machineSeen?: string;
  grantKey = (st: { suite: string; run: string; kind?: string }) => (st.kind === "preflight" ? `preflight|${st.run}` : `${st.suite}|${st.run}`);
  // A run's cap: its plan's worst case plus its own checks, never above the ledger's cap.
  runCapFor(suite: Suite, pinned = true): number { return runCap(this.budget, planOf(suite, pinned).total); }
  // The grant a run or the preflight goes on under, checked against the allowance as it is now.
  private grantFor(st: { suite: string; run: string; kind?: string }, cap: number, spend?: Spend) {
    const key = this.grantKey(st);
    return this.ledger.grant(key, { suite: st.kind === "preflight" ? "preflight" : st.suite, run: st.run }, cap, this.allowance(), spend);
  }
  // A seat's trial allowance per window (core.ts SEAT_LIMITS).
  window = (seat: ReviewSeatName): SeatWindow | null => {
    const l = { ...SEAT_LIMITS, ...(this.cfg.seatLimits ?? {}) }[seat];
    return l ? { ms: l.windowMin * 60_000, allowance: trialAllowance(l) } : null;
  };
  // The overrun margin (fourth round): a fixed 10 percent of the budget option (core.ts ledgerMargin), so the
  // ledger's cap sits that far below the budget whatever the worst-case guesses say.
  marginFor(_suite?: Suite, _st?: RunState): number { return ledgerMargin(this.budget); }

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
      if (sent) addSpend(c, x.usd, "worst case (cut off)");
      Object.assign(c, { status: "interrupted", cost_usd: (c.cost_usd ?? 0) + (sent ? x.usd : 0), ...(sent ? { how: "worst case (cut off)" as How } : {}),
        error: sent ? "cut off by a restart after it was sent; counted at its worst case" : "cut off by a restart before it was sent; nothing was charged" });
      writeAtomic(this.p().state(x.suite, x.run), JSON.stringify(st, null, 1));
    }
    if (r.charged.length) this.log(`${r.charged.length} call(s) cut off by a restart after they were sent were counted at their worst case`);
  }

  // ---- requests ----
  // Each inbox file, taken as takeInboxFile says, then parsed and acted on. What became of each.
  ingest(): { name: string; why: string | null }[] {
    const dir = this.cfg.inboxDir;
    const done: { name: string; why: string | null }[] = [];
    if (!dir) return done;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch { return done; }
    for (const name of names) {
      const shown = name.slice(0, 60).replace(/[^\w.-]/g, "?");
      const got = takeInboxFile(join(dir, name), join(this.cfg.dir, "inbox-taken"), this.cfg.inboxUids ?? [CAIN_UID]);
      if (!got.ok) { const why = `it wasn't taken (${(got as { why: string }).why})`; done.push({ name, why }); this.relay(`A trial request (${shown}) wasn't taken: ${why}. Nothing to tell him.`); continue; }
      let j: any; try { j = JSON.parse(got.text); } catch { done.push({ name, why: "not JSON" }); this.relay(`A trial request (${shown}) wasn't JSON. Nothing to tell him.`); continue; }
      const why = this.request(j, FROM_INBOX);
      done.push({ name, why });
      this.relay(why ? `A trial request wasn't taken: ${why} Nothing to tell him.`
        : `Trial request taken: ${j.kind} ${j.suite}${j.mode ? ` (${j.mode})` : ""}. trial.sh status shows it. Nothing to tell him.`);
    }
    return done;
  }
  request(j: any, origin?: symbol): string | null {
    const bad = requestError(j);
    if (bad) return bad;
    if (j.kind === "report") { writeReport(this.cfg.dir, j.suite, this.budget); return null; }
    if (origin !== FROM_INBOX) return "a paid run, a resume or the preflight starts only from a request file taken from the trials inbox.";
    const gate = this.paidGate();
    if (gate) return `${gate}.`;
    if (j.kind === "preflight") return this.startPreflight(j.approval);
    const suite: SuiteName = j.suite;
    const mode: Mode = j.mode ?? "resume";
    let s = readSuite(this.cfg.dir, suite);
    if (suite === "research") {
      const a = this.approval();
      if (!a.ok) return `the research suite can't run: ${(a as { why: string }).why}.`;
      if (s && s.questions_sha256 !== a.sha) return "the research suite was frozen from other questions than the ones the owner approved.";
    }
    const pfErr = this.pfError();
    if (pfErr) return `${pfErr}.`;
    let fresh = false;
    if (!s) {
      const built = this.buildSuite(suite);
      if (!built.suite) return built.error!;
      s = built.suite; fresh = true;
    }
    const last = latestRun(this.cfg.dir, suite);
    const resuming = !!(last && last.status !== "done" && mode !== "new");
    if (!resuming && last && last.status === "running") return "its newest run is still running; it can't start a new one beside it.";
    // His one-time approval, for exactly the plan and action this start would run, spent by its grant before anything is
    // frozen or sent.
    const pinned = resuming ? !last!.preflight?.third_party_routing : !(suite === "research" && (() => { const a = this.approval(); return a.ok && a.third_party; })());
    const v = this.verifyApproval(j.approval, suite, { ...this.approvalTarget(suite, s, pinned), action: resuming ? "resume" : "start" });
    if ("why" in v) return v.why;
    const used = v.approved;
    if (resuming && last) {
      const g = this.grantFor(last, this.runCapFor(s, !last.preflight?.third_party_routing), v.spend);
      if (!g.ok) return (g as { reason: string }).reason === "used" ? (g as { detail: string }).detail : `the run can't resume: ${(g as { detail: string }).detail}.`;
      if (fresh) writeAtomic(this.p().suite(suite), JSON.stringify(s, null, 1));
      last.status = "running"; delete last.stop; last.approved = used;
      for (const c of Object.values(last.calls)) {
        if (c.status === "held") c.status = "interrupted";
        if (mode === "retry" && c.status === "failed" && c.final && !/no key|isn't signed in|isn't served|not listed|refused|not isolated/.test(c.error ?? "")) { c.final = false; c.attempts = Math.min(c.attempts, 1); }
      }
      // The checks before any spend run again on a resume (a model may have come or gone).
      if (last.preflight) last.preflight.done = false;
      last.updated_at = this.iso();
      writeAtomic(this.p().state(suite, last.run), JSON.stringify(last, null, 1));
      return null;
    }
    const d = this.now();
    const run = `r${d.toISOString().slice(0, 10).replace(/-/g, "")}-${d.toISOString().slice(11, 19).replace(/:/g, "")}`;
    if (existsSync(this.p().run(suite, run))) return "a run started this very second; ask again.";
    const g = this.grantFor({ suite, run }, this.runCapFor(s, pinned), v.spend);
    if (!g.ok) return (g as { reason: string }).reason === "used" ? (g as { detail: string }).detail : `the run can't start: ${(g as { detail: string }).detail}.`;
    if (fresh) writeAtomic(this.p().suite(suite), JSON.stringify(s, null, 1));
    const st: RunState = { format: 2, suite, run, status: "running", created_at: this.iso(), updated_at: this.iso(), stops: [], calls: {},
      notes: [...s.skipped], held: {}, cool: {}, approved: used };
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
    const a = this.approval();
    if (!a.ok) return { error: `the research suite can't run: ${(a as { why: string }).why}.` };
    const q = { tasks: a.tasks };
    const bad = researchPrivacy(q.tasks, terms);
    if (bad.length) return { error: `blocked: privacy in ${bad.map((x) => `${x.id} (${x.why.join("; ")})`).join(", ")}. Fix those, have them approved again, and ask again.` };
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

  // ---- the build's preflight (fourth round) ----
  // `trial.sh preflight`: the checks before any spend for every configuration of both suites, with no owner text
  // and Perplexity pinned to its own model at every level, under its own cap (PREFLIGHT_CAP_USD) and a grant from
  // the owner's allowance. Its record is what lets a paid suite run on this build on this machine.
  startPreflight(approval?: unknown): string | null {
    const cur = readPreflight(this.cfg.dir);
    if (cur?.status === "running") return "the preflight is already running.";
    const d = this.now();
    const id = `p${d.toISOString().slice(0, 10).replace(/-/g, "")}-${d.toISOString().slice(11, 19).replace(/:/g, "")}`;
    if (cur?.id === id) return "a preflight started this very second; ask again.";
    // Sixth round: the trials' Codex sign-in must not be the review service's own.
    const ids = this.codexIdentities();
    if (ids.trials && ids.review && ids.trials === ids.review) return "the preflight can't start: the trials' Codex sign-in is the review service's own ChatGPT account or workspace; Codex in the trials needs a sign-in of its own (DOCS.md).";
    const v = this.verifyApproval(approval, "preflight", { ...this.approvalTarget("preflight"), action: "preflight" });
    if ("why" in v) return v.why;
    const g = this.grantFor({ suite: "preflight", run: id, kind: "preflight" }, preflightCap(this.budget), v.spend);
    if (!g.ok) return (g as { reason: string }).reason === "used" ? (g as { detail: string }).detail : `the preflight can't start: ${(g as { detail: string }).detail}.`;
    for (const suite of ["review-seats", "research"] as SuiteName[]) {
      const st: RunState = { format: 2, suite, run: id, status: "running", created_at: this.iso(), updated_at: this.iso(), stops: [], calls: {}, notes: [], held: {}, cool: {}, kind: "preflight" };
      this.save(st);
    }
    const rec: PreflightRecord = { format: 1, id, status: "running", build: this.build, machine: this.machine, started_at: this.iso(), cap_usd: (g as { cap: number }).cap, suites: {}, disabled: {},
      key: this.preflightKey(), key_separation: KEY_SEPARATION, approved_at: v.approved.at };
    writeAtomic(this.p().preflight, JSON.stringify(rec, null, 1));
    return null;
  }
  // The preflight's named go/no-go lines (sixth round), from what its checks recorded.
  goLines(rec: PreflightRecord): Record<GoLineName, GoStatus> {
    const iso = rec.suites["review-seats"]?.codex_isolation ?? rec.suites.research?.codex_isolation;
    const codexLine = (k: "bwrap" | "config" | "probes"): GoStatus => {
      const l = iso?.lines?.[k];
      if (l) return { status: l.ok ? "go" : "no-go", detail: l.detail };
      return { status: "not checked", detail: iso ? `the self-test stopped before this line (${iso.detail})`.slice(0, 300) : "Codex's self-test didn't run (no sign-in or no Codex)" };
    };
    let options: GoStatus;
    try {
      const m = statSync(this.cfg.optionsFile ?? OPTIONS_FILE).mtimeMs;
      options = m > this.startedAt ? { status: "go", detail: "the App's options file was rewritten while the runner ran, and the runner read it without a restart" }
        : { status: "not checked", detail: "the options file hasn't changed since the runner started: save the App's options once while it runs, then run the preflight again" };
    } catch { options = { status: "no-go", detail: "the App's options file can't be read" }; }
    const thinking: Record<string, string> = {};
    for (const one of Object.values(rec.suites)) Object.assign(thinking, one?.thinking ?? {});
    const models = Object.keys(thinking);
    const bad = models.filter((m) => thinking[m] !== "yes");
    const think: GoStatus = !models.length ? { status: "not checked", detail: "no Gemini model was checked (no trial key for Gemini, or each was refused first)" }
      : bad.length ? { status: "no-go", detail: `no thinking shown within the cap on its check: ${bad.join(", ")} (left disabled)` }
      : { status: "go", detail: `each checked Gemini model thought within its cap: ${models.join(", ")}` };
    const discord: GoStatus = rec.approved_at ? { status: "go", detail: "this preflight started on an approval the link signs only after his tap on the trial card in Discord" }
      : { status: "not checked", detail: "this preflight carries no record of its approval" };
    return { bwrap: codexLine("bwrap"), config: codexLine("config"), probes: codexLine("probes"), options, thinking: think, discord };
  }
  private finishPreflight(rec: PreflightRecord, status: "done" | "stopped", why?: string) {
    rec.status = status; rec.finished_at = this.iso();
    if (why) rec.stop = why.slice(0, 400);
    rec.golines = this.goLines(rec);
    rec.codex_version = rec.suites["review-seats"]?.codex_version ?? rec.suites.research?.codex_version ?? null;
    rec.key_separation ??= KEY_SEPARATION;
    writeAtomic(this.p().preflight, JSON.stringify(rec, null, 1));
    try { writeAtomic(this.p().preflightReport, preflightReport(rec)); } catch (e) { this.log(`preflight report: ${(e as Error).message}`); }
    const spent = this.committed();
    this.relay(status === "done"
      ? `The trials preflight finished on this build${Object.keys(rec.disabled).length ? `; left disabled: ${Object.entries(rec.disabled).map(([c, w]) => `${c} (${w})`).join("; ").slice(0, 600)}` : "; every configuration passed its check"}. Trials have spent $${spent.toFixed(2)} of $${this.budget.toFixed(2)}. Paid suites can run now, within the owner's run allowance. Nothing to tell him unless it needs his word.`
      : `The trials preflight stopped: ${why ?? "unknown"}. No paid suite runs on this build until a preflight finishes. Nothing to tell him unless it needs his word.`);
  }
  async stepPreflight(rec: PreflightRecord): Promise<boolean> {
    if (this.deps.review.isStopped()) return false;
    if (rec.build !== this.build || rec.machine !== this.machine) { this.finishPreflight(rec, "stopped", "it was started on another build or machine"); return false; }
    const gate = this.paidGate();
    if (gate) {
      for (const suite of ["review-seats", "research"] as SuiteName[]) { const st = readJson<RunState | null>(this.p().state(suite, rec.id), null); if (st && st.status === "running") this.end(st, "stopped", { reason: "keys", at: this.iso(), detail: gate }); }
      this.finishPreflight(rec, "stopped", gate); return false;
    }
    for (const suite of ["review-seats", "research"] as SuiteName[]) {
      const st = readJson<RunState | null>(this.p().state(suite, rec.id), null);
      if (!st) { this.finishPreflight(rec, "stopped", `its ${suite} checks can't be read`); return false; }
      if (st.status === "stopped") { this.finishPreflight(rec, "stopped", st.stop?.detail ?? "a check stopped it"); return false; }
      if (st.preflight?.done) continue;
      const g = this.grantFor(st, rec.cap_usd);
      if (!g.ok) {
        if ((g as { reason: string }).reason === "busy") return false;
        this.end(st, "stopped", { reason: "allowance", at: this.iso(), detail: (g as { detail: string }).detail });
        this.finishPreflight(rec, "stopped", (g as { detail: string }).detail); return false;
      }
      return this.preflight(st, { format: 2, name: suite, created_at: rec.started_at, tasks: [], skipped: [] });
    }
    for (const suite of ["review-seats", "research"] as SuiteName[]) {
      const st = readJson<RunState | null>(this.p().state(suite, rec.id), null)!;
      const pf = st.preflight!;
      rec.suites[suite] = { run: rec.id, checked: { ...pf.checked }, skip: { ...pf.skip }, graders_off: { ...(pf.graders_off ?? {}) }, served: { ...(pf.served ?? {}) },
        ids: { ...(pf.ids ?? {}) }, thinking: { ...(pf.thinking ?? {}) }, codex_isolation: pf.codex_isolation, codex_version: pf.codex_version ?? null, codex_models: pf.codex_models ?? null };
      for (const [c, why] of Object.entries(pf.skip)) rec.disabled[c] ??= why;
      for (const [g, why] of Object.entries(pf.graders_off ?? {})) rec.disabled[`grader:${g}`] ??= why;
      if (pf.checked.codex_daemon) rec.codex_daemon = pf.checked.codex_daemon;
      st.status = "done"; this.save(st);
    }
    this.finishPreflight(rec, "done");
    return true;
  }

  // ---- the loop ----
  // One step: a request, or one call of the first running run. true when a call was made or settled.
  async tick(): Promise<boolean> {
    this.recover();
    this.ingest();
    if (!this.recovered) return false;
    const rb = this.reviewBusy();
    if (rb.busy) return false;
    const pf = readPreflight(this.cfg.dir);
    if (pf?.status === "running") return this.stepPreflight(pf);
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
    if (st.kind === "preflight") return;   // the preflight's own record says how it ended (stepPreflight)
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
    // The owner's say, every step: the build's preflight on record, and his allowance still covering this run.
    const gate = this.paidGate();
    if (gate) { this.end(st, "stopped", { reason: "keys", at: this.iso(), detail: `${gate}; nothing more was sent.` }); return false; }
    const pfErr = this.pfError();
    if (pfErr) { this.end(st, "stopped", { reason: "preflight", at: this.iso(), detail: `${pfErr}; nothing more was sent.` }); return false; }
    const g = this.grantFor(st, this.runCapFor(suite, !st.preflight?.third_party_routing));
    if (!g.ok) {
      if ((g as { reason: string }).reason === "busy") return false;
      this.end(st, "stopped", { reason: "allowance", at: this.iso(), detail: `${(g as { detail: string }).detail}; nothing more was sent.` }); return false;
    }
    if (suite.name === "research") {
      const a = this.approval();
      if (!a.ok || a.sha !== suite.questions_sha256) {
        this.end(st, "stopped", { reason: "approval", at: this.iso(), detail: `the owner's approval of the research questions doesn't stand (${a.ok ? "the questions changed since the suite was frozen" : (a as { why: string }).why}), so nothing was sent.` });
        return false;
      }
    }
    if (!st.preflight?.done) return this.preflight(st, suite);
    const specs = callsFor(suite);
    const nowMs = this.now().getTime(), nowIso = this.iso();
    let waiting = 0, capHeld = 0;
    // One task at a time: a task's hold is taken only once every task before it has settled, so a seat waiting
    // for its window never leaves holds piling up for later tasks. A task held up by a seat's cap ends the run.
    const open = specs.find((x) => !this.settled(st.calls[x.id]))?.task;
    for (const spec of specs) {
      const rec = st.calls[spec.id];
      if (this.settled(rec)) continue;
      if (spec.task !== open && !st.held[spec.task]) continue;
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
  // The graders this run can use: a provider, a passed check, and for Codex a passed sandbox self-test.
  availableGraders(st: RunState): GraderId[] {
    const p = this.deps.providers, off = st.preflight?.graders_off ?? {};
    return GRADERS.filter((g) => !off[g.id] && (g.id === "claude" ? !!p.claude : g.id === "gemini" ? !!p.gemini : !!p.codex && !!st.preflight?.codex_isolation?.ok)).map((g) => g.id);
  }
  private holdTask(st: RunState, suite: Suite, task: Task): "ok" | "busy" | string {
    let usd = 0;
    const avail = this.availableGraders(st);
    for (const g of GRADERS) {
      const id = `grade|${task.id}|${g.id}`;
      if (this.settled(st.calls[id]) || !avail.includes(g.id)) continue;
      const shape = callShape(suite.name, { id, kind: "grade", task: task.id, grader: g.id }, task);
      usd += worstOf(shape, gradeCharsBound(suite, task)) ?? 0;
    }
    const cap = this.ledger.grantOf(this.grantKey(st))?.cap_usd;
    const r = this.ledger.hold(this.holdKey(st, task.id), { suite: st.suite, run: st.run, task: task.id }, usd, this.budget, this.marginFor(suite, st), cap ?? 0);
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
  private async exchange(st: RunState, o: { call: string; attempt: number; seat: ReviewSeatName | null; worst: number; runs: number; hold?: string; timeoutS: number; margin: number; plan?: boolean },
    fn: (wire: Wire, signal: AbortSignal) => Promise<AskResult>): Promise<Exchange> {
    // Every paid exchange goes under its run's grant from the owner's allowance, and never past that grant's cap.
    const gate = this.paidGate();
    if (gate) return { kind: "denied", reason: "allowance", detail: gate };
    const grant = this.ledger.grantOf(this.grantKey(st));
    if (!grant) return { kind: "denied", reason: "allowance", detail: "no grant from the owner's run allowance covers this run" };
    const who = st.kind === "preflight" ? { suite: "preflight", run: st.run } : { suite: st.suite, run: st.run };
    const res = this.ledger.reserve({ ...who, call: o.call, attempt: o.attempt, seat: o.seat, usd: o.worst, runs: o.runs, hold: o.hold },
      this.budget, this.seatCheck, { marginUsd: o.margin, window: this.window, runCapUsd: grant.cap_usd });
    if (!res.ok) { const d = res as Extract<typeof res, { ok: false }>; return { kind: "denied", reason: d.reason, detail: d.detail, retryAt: d.retryAt }; }
    // Marked sent under the ledger's lock; a reservation gone meanwhile (taken back by a restart that judged
    // this process gone) means nothing is sent.
    if (!this.ledger.dispatched(res.id)) return { kind: "denied", reason: "gone", detail: "its reservation was gone when it was to be sent, so nothing was sent" };
    if (o.seat) this.lastCall[o.seat] = this.now().getTime();
    const wire = makeWire({ terms: () => this.deps.review.terms(), fetch: this.deps.fetch ?? fetch, exec: this.deps.exec ?? groupExec });
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
      const usd = o.plan ? 0 : a.bill ? a.bill.usd : o.worst;
      const how: How = o.plan ? "plan call" : a.bill ? a.bill.how : "reserved (no bill)";
      this.ledger.settle(res.id, usd, how);
      if (o.seat) this.deps.review.addSpend(o.seat, usd, a.answer?.findings.length ?? 0, 0);
      return { kind: "ok", res: a, usd, how, ...after(usd) };
    } catch (e) {
      const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
      // Released with no charge only on an authoritative zero: nothing left at all (a privacy block on the wire,
      // or nothing sent), an HTTP 4xx with no usage in it, or a usage block showing zero. Anything else keeps the
      // reservation: its measured cost, or the whole worst case when there's no usable figure (a timeout, a
      // cut-off answer, a 5xx, a 200 with no usage).
      const nothingLeft = err instanceof PrivacyBlock || (wire.sent === 0 && err.kind !== "timeout");
      const usage = usageOf(err);
      const http4xx = /^HTTP 4\d\d/.test(err.message) && usage === "none";
      if (nothingLeft || http4xx || usage === "zero") {
        this.ledger.release(res.id);
        return { kind: "error", err, usd: 0, how: null, released: true, ...after(0) };
      }
      if (o.plan) {   // Codex ran: one call of the plan, no dollars
        this.ledger.settle(res.id, 0, "plan call");
        if (o.seat) this.deps.review.addSpend(o.seat, 0, 0, 0);
        return { kind: "error", err, usd: 0, how: "plan call", released: false, ...after(0) };
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
  // From the installed build, each provider and the tool paths the suite really uses, once, with no owner text:
  // - Gemini: one tiny call per model (every configuration's and the Gemini grader's), with the model's own
  //   generation settings. Not served, or refusing the settings: those configurations are skipped (the
  //   grader too); today's default model not usable stops the run.
  // - Claude: one call with the suite's tools (research: web search max_uses 1 and the grader's fetch max_uses
  //   1) and a tiny output cap. A refusal disables Claude's configurations and its grader, named in the report.
  // - Perplexity: one tiny call per level, with the pinned model; response.model must be the pinned model, or
  //   that level is disabled. An unpinned level without the owner's approval is disabled without a call.
  // - Codex: the sandbox self-test (sandbox.ts), counted as one plan call; not isolated means every Codex
  //   configuration is skipped and Codex never grades. Then its version and model list (best effort), and a
  //   tiny probe per optional model the list can't answer for.
  async preflight(st: RunState, suite: Suite): Promise<boolean> {
    const pf: Preflight = st.preflight ?? { done: false, at: this.iso(), tries: 0, checked: {}, skip: {}, third_party_routing: false };
    st.preflight = pf;
    pf.graders_off ??= {}; pf.served ??= {}; pf.ids ??= {}; pf.thinking ??= {};
    const machine = st.kind === "preflight";
    const approval = suite.name === "research" && !machine ? this.approval() : null;
    pf.third_party_routing = !!(approval && approval.ok && approval.third_party);
    // A run starts from the build's preflight record: what it disabled stays disabled, named, and what it checked
    // isn't paid for again (with the same Perplexity pinning); the Codex self-test runs again for every run.
    if (!machine && !pf.seeded) {
      const rec = readPreflight(this.cfg.dir);
      const one = rec?.suites?.[suite.name];
      if (rec && one) {
        for (const [k, v] of Object.entries(one.checked)) if (!k.startsWith("codex") && !(k.startsWith("perplexity") && pf.third_party_routing)) pf.checked[k] = v;
        for (const [k, v] of Object.entries(one.skip)) if (!k.startsWith("codex") && !(k.startsWith("perplexity") && pf.third_party_routing && !v.startsWith("skipped: no"))) pf.skip[k] = `${v} (at the build's preflight)`;
        for (const [k, v] of Object.entries(one.graders_off)) if (k !== "codex") pf.graders_off[k] = v;
        Object.assign(pf.served, one.served); Object.assign(pf.ids, one.ids); Object.assign(pf.thinking, one.thinking);
      }
      for (const [c, why] of Object.entries(rec?.disabled ?? {})) if (configById(suite.name, c) && !c.startsWith("codex")) pf.skip[c] ??= `${why} (at the build's preflight)`;
      pf.seeded = true;
      // Today's default Gemini model disabled at the preflight stops the run, as it would at its own check.
      const def = configsFor(suite.name).find((c) => c.seat === "gemini" && c.defaultModel && pf.skip[c.id] && !/no Gemini key/.test(pf.skip[c.id]));
      if (def && this.deps.providers.gemini) {
        this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `today's default Gemini model, ${def.model}, isn't usable (${pf.skip[def.id]}), so the run stopped before any spend on the trial itself.` });
        return false;
      }
    }
    const configs = configsFor(suite.name);
    const day = this.deps.review.day();
    const margin = this.marginFor(suite, st);
    const retryLater = (why: string): boolean => {
      pf.tries++;
      if (pf.tries >= 3) { this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `the checks before any spend couldn't finish (${why}).` }); return false; }
      this.save(st); return false;
    };
    const tiny = (price: { in: number; out: number }, outTokens: number, fees = 0, ctx = tokensOf(400), steps = 1) =>
      worstOfCeiling({ steps, contextTokens: ctx, maxOut: outTokens, toolFeesUsd: fees, price, runs: 0 });
    const preCall = async (id: string, seat: ReviewSeatName, worst: number, runs: number, fn: (w: Wire, s: AbortSignal) => Promise<AskResult>, plan = false) => {
      const rec = st.calls[id] ?? { status: "interrupted" as CallStatus, attempts: 0, cost_usd: 0, at: this.iso() };
      st.calls[id] = rec; rec.attempts++; rec.worst_usd = worst; this.save(st);
      const x = await this.exchange(st, { call: id, attempt: rec.attempts, seat, worst, runs, timeoutS: 180, margin, plan }, fn);
      if (x.kind === "denied") { rec.attempts--; Object.assign(rec, { status: "held", error: x.detail, at: this.iso() }); this.save(st); return x; }
      if (x.how) addSpend(rec, x.usd, x.how);
      Object.assign(rec, { status: x.kind === "ok" ? "done" : "failed", final: true, cost_usd: rec.cost_usd + x.usd, how: x.how ?? undefined, at: this.iso(),
        ...(x.kind === "error" ? { error: `${x.err.kind}: ${x.err.message}`.slice(0, 300) } : {}) });
      this.save(st);
      return x;
    };
    const denied = (x: { reason: string; detail: string }, what: string): boolean =>
      x.reason === "busy" || x.reason === "gone" || x.reason === "window" ? false : this.denyStop(st, x, what);
    const asAsk = (v: { bill: any; served?: string; usage?: any }): AskResult => ({ text: "", urls: [], served: v.served ?? "", bill: v.bill, tokens: { input: 0, output: 0 }, searches: 0, usage: v.usage });

    // Gemini: one tiny call per model.
    const gem = this.deps.providers.gemini;
    const grader = GRADERS.find((g) => g.id === "gemini")!;
    const gemModels = [...new Set([...configs.filter((x) => x.seat === "gemini").map((c) => c.model), grader.model])];
    for (const model of gemModels) {
      if (pf.checked[`gemini:${model}`]) continue;
      if (!gem?.validate) pf.checked[`gemini:${model}`] = "skipped: no Gemini key in the App";
      else {
        let seen: ThinkingSeen | undefined;
        const x = await preCall(`pre|gemini|${model}`, "gemini", tiny(ceilingPrice(model), LIMITS.validateOut + thinkingAllowance(model)), 0,
          async (wire, signal) => { const v = await gem.validate!({ wire, signal, day, model }); seen = v.thinking; return asAsk(v); });
        if (x.kind === "denied") return denied(x, "the check of Gemini's models");
        if (x.kind === "error") {
          const http = /^HTTP (\d+)/.exec(x.err.message)?.[1];
          if (http === "404" || /not found|not served/i.test(x.err.message)) pf.checked[`gemini:${model}`] = `skipped: ${model} isn't served (${x.err.message})`;
          else if (x.err.kind === "refused" || http === "400") pf.checked[`gemini:${model}`] = `skipped: ${model} refused the trial's settings (${x.err.message})`;
          else return retryLater(`Gemini answered ${x.err.message}`);
        } else {
          // Its thinking field was taken (no 400); whether its output cap covered its thinking is recorded, and a model
          // listed as covered whose check shows otherwise is disabled: its reservation would be too small.
          const cover = thinkingCover(seen);
          pf.thinking![model] = cover;
          const listed = GEMINI_MODELS[model]?.outCoversThinking === true;
          if (listed && cover === "no") pf.checked[`gemini:${model}`] = `disabled: ${model}'s output cap didn't cover its thinking at the check (${seen!.thoughts} thought and ${seen!.answer} answer tokens against a cap of ${seen!.maxOut}), so its worst case can't be bounded`;
          // Fifth round: a check that showed no thinking at all is inconclusive: the model stays disabled, never estimated.
          else if (cover === "unknown") pf.checked[`gemini:${model}`] = `disabled: ${model}'s check was inconclusive (it produced no thinking, so whether its output cap covers thinking wasn't shown); run the preflight again to retry it`;
          else { pf.checked[`gemini:${model}`] = "ok"; pf.ids[`gemini:${model}`] = `${x.res.served || model}, thinking ${"level" in (GEMINI_MODELS[model]?.thinking ?? { level: "low" }) ? "level" : "budget"} field, output cap covers thinking: ${cover}`; }
        }
      }
      const verdict = pf.checked[`gemini:${model}`];
      if (verdict !== "ok") {
        for (const c of configs.filter((x) => x.seat === "gemini" && x.model === model)) {
          pf.skip[c.id] = verdict;
          if (c.defaultModel && gem && !machine) { this.end(st, "stopped", { reason: "unavailable", at: this.iso(), detail: `today's default Gemini model, ${model}, isn't usable (${verdict}), so the run stopped before any spend on the trial itself.` }); return false; }
        }
        if (model === grader.model) pf.graders_off.gemini = `the Gemini grader is off: ${verdict}`;
      }
      this.save(st); return true;
    }
    // Claude: the suite's tool paths, once.
    const claude = this.deps.providers.claude;
    const claudeConfigs = configs.filter((x) => x.seat === "claude");
    if (!pf.checked.claude) {
      if (!claude?.validate) {
        pf.checked.claude = "skipped: no Anthropic key in the App";
        for (const c of claudeConfigs) pf.skip[c.id] = pf.checked.claude;
        pf.graders_off.claude = `the Claude grader is off: ${pf.checked.claude}`;
        this.save(st); return true;
      }
      const research = suite.name === "research";
      const worst = research
        ? tiny(ceilingPrice("claude-opus-5-5"), LIMITS.validateOut, 0.01, tokensOf(400) + 20_000 + LIMITS.claudeFetchTokens, 3)
        : tiny(ceilingPrice("claude-opus-5-5"), LIMITS.validateOut);
      const x = await preCall("pre|claude", "claude", worst, 0,
        async (wire, signal) => asAsk(await claude.validate!({ wire, signal, day, model: GRADERS[0].model, search: research, maxSearches: 1, fetch: false, maxFetches: 0 })));
      if (x.kind === "denied") return denied(x, "the check of Claude's setup");
      if (x.kind === "error") {
        if (!(x.err.kind === "refused" || /^HTTP 4/.test(x.err.message))) return retryLater(`Claude answered ${x.err.message}`);
        pf.checked.claude = `disabled: Claude refused the trial's setup (a model or tool type it doesn't take: ${x.err.message})`;
        for (const c of claudeConfigs) pf.skip[c.id] = pf.checked.claude;
        pf.graders_off.claude = `the Claude grader is off: ${pf.checked.claude}`;
      } else { pf.checked.claude = "ok"; pf.ids.claude = `${x.res.served || GRADERS[0].model}${research ? ", web_search_20260318 max_uses 1 (no fetch tool: the runner fetches the cited pages)" : ", no tools"}`; }
      this.save(st); return true;
    }
    // Perplexity: one tiny call per level, pinned.
    const pp = this.deps.providers.perplexity;
    for (const c of configs.filter((x) => x.seat === "perplexity")) {
      if (pf.skip[c.id] || pf.checked[c.id]) continue;
      const model = c.model || (pf.third_party_routing ? "" : PERPLEXITY_OWN_MODEL);
      if (!pp?.validate) { pf.checked[c.id] = pf.skip[c.id] = "skipped: no Perplexity key in the App"; this.save(st); return true; }
      if (!model && !(approval?.ok && approval.third_party)) { pf.checked[c.id] = pf.skip[c.id] = "disabled: an unpinned level needs the owner's approval in the App's options"; this.save(st); return true; }
      const search = c.search !== "never" && suite.name === "research";
      const worst = tiny(ceilingPrice(model || "unpinned-preset"), LIMITS.validateOut, search ? 0.0025 : 0, tokensOf(400) + (search ? LIMITS.perplexityValidateSearchTokens : 0) + 4_000);
      const x = await preCall(`pre|perplexity|${c.id}`, "perplexity", c.setting === "fast" ? worst * 2 : worst, 0,
        async (wire, signal) => asAsk(await pp.validate!({ wire, signal, day, model, setting: c.setting, search })));
      if (x.kind === "denied") return denied(x, "the check of Perplexity's levels");
      if (x.kind === "error") {
        if (!(x.err.kind === "refused" || /^HTTP 4/.test(x.err.message))) return retryLater(`Perplexity answered ${x.err.message}`);
        pf.checked[c.id] = pf.skip[c.id] = `disabled: Perplexity refused ${model || "the unpinned level"}${c.setting ? ` at effort ${c.setting}` : ""} (${x.err.message})`;
      } else {
        const served = x.res.served;
        if (model && served !== model) pf.checked[c.id] = pf.skip[c.id] = `disabled: served by ${served || "an unnamed model"}, not the pinned ${model}`;
        else { pf.checked[c.id] = "ok"; pf.served[c.id] = served; pf.ids[c.id] = `${served}${c.setting ? ` at effort ${c.setting}` : ""}${search ? ", web_search" : ""}`; }
      }
      this.save(st); return true;
    }
    // Codex: the sandbox self-test first; then its version, its model list, and a probe per unlisted model.
    const codex = this.deps.providers.codex;
    const codexConfigs = configs.filter((x) => x.seat === "codex");
    if (!pf.checked.codex) {
      if (!codex) {
        for (const c of codexConfigs) pf.skip[c.id] = "skipped: Codex isn't set up";
        pf.graders_off.codex = "Codex isn't set up"; pf.checked.codex = "none"; this.save(st); return true;
      }
      const x = await preCall("pre|codex|isolation", "openai", 0, 1, async (wire, signal) => {
        pf.codex_isolation = await codex.isolation(wire, signal);
        return { text: "", urls: [], served: "", bill: { usd: 0, how: "plan call" }, tokens: { input: 0, output: 0 }, searches: 0 };
      }, true);
      if (x.kind === "denied") return denied(x, "Codex's sandbox self-test");
      if (x.kind === "error") pf.codex_isolation = { ok: false, mode: "none", detail: `the self-test didn't run: ${x.err.message}`.slice(0, 300), at: this.iso() };
      const iso = pf.codex_isolation!;
      if (iso.ok && iso.mode !== "bwrap") { iso.ok = false; iso.detail = `not under bubblewrap (${iso.mode}): Codex runs only under it`; }
      // Sixth round: Codex stays disabled until its three go/no-go lines pass (bubblewrap starts, the effective config
      // check, the probes refused).
      const failed = (["bwrap", "config", "probes"] as const).filter((k) => !iso.lines?.[k]?.ok);
      if (iso.ok && failed.length) { iso.ok = false; iso.detail = `its go/no-go lines didn't all pass (${failed.map((k) => GO_LINES[k]).join("; ")})`; }
      if (!iso.ok) {
        for (const c of codexConfigs) pf.skip[c.id] = `skipped: not isolated (${iso.detail})`.slice(0, 300);
        pf.graders_off.codex = `Codex never grades: not isolated (${iso.detail})`.slice(0, 300);
        pf.checked.codex = "not isolated";
        this.save(st); return true;
      }
      const wire = makeWire({ terms: () => this.deps.review.terms(), fetch: this.deps.fetch ?? fetch, exec: this.deps.exec ?? groupExec });
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60_000 * (this.cfg.timeoutScale ?? 1));
      try {
        pf.codex_version = await codex.version(wire, ctl.signal);
        pf.codex_models = await codex.models(wire, ctl.signal);
      } catch (e) { if (e instanceof PrivacyBlock) { this.end(st, "stopped", { reason: "privacy", at: this.iso(), detail: e.message }); return false; } }
      finally { clearTimeout(t); }
      // Sixth round: at least CODEX_MIN_VERSION, named in the preflight record.
      const ver = codexVersionOf(pf.codex_version ?? "") ?? pf.codex_isolation?.version ?? null;
      if (!versionAtLeast(ver, CODEX_MIN_VERSION)) {
        const why = `skipped: the installed Codex is ${ver ?? "of an unreadable version"}; the trials need at least ${CODEX_MIN_VERSION}`;
        for (const c of codexConfigs) pf.skip[c.id] = why;
        pf.graders_off.codex = `Codex never grades: ${why.slice(9)}`;
        pf.checked.codex = "too old";
        this.save(st); return true;
      }
      pf.checked.codex = "listed";
      pf.checked.codex_daemon = CODEX_ROOT.includes("features.daemon_auto_start=false") && CODEX_ROOT.includes('web_search="disabled"')
        ? "off: every invocation passes features.daemon_auto_start=false and web_search disabled, inside bubblewrap's own pid namespace with --die-with-parent"
        : "not off";
      this.save(st); return true;
    }
    const mode = pf.codex_isolation?.ok && pf.codex_isolation.mode === "bwrap" ? "bwrap" as const : undefined;
    for (const c of codexConfigs.filter((x) => x.optional && x.model)) {
      if (!mode || pf.skip[c.id] || pf.checked[`codex:${c.model}`]) continue;
      if (pf.codex_models) {
        pf.checked[`codex:${c.model}`] = pf.codex_models.includes(c.model) ? "ok" : "not listed";
        if (!pf.codex_models.includes(c.model)) pf.skip[c.id] = `skipped: not listed by the installed Codex (${pf.codex_version ?? "version unknown"})`;
        continue;
      }
      const x = await preCall(`pre|codex|${c.model}`, "openai", 0, 1,
        (wire, signal) => codex!.ask({ wire, signal, day, model: c.model, system: "Reply with the word ready.", user: "ready?", maxOut: 0, codexMode: mode }), true);
      if (x.kind === "denied") return denied(x, "the Codex model probe");
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
    else if (x.reason === "allowance") this.end(st, "stopped", { reason: "allowance", at: this.iso(), detail: `${what} wasn't made: ${x.detail}.` });
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
    const pf = st.preflight!;
    const codexMode = pf.codex_isolation?.ok && pf.codex_isolation.mode === "bwrap" ? "bwrap" as const : undefined;
    // Provider tools only on checked research text; the grader's fetch only on research.
    const tv = toolViolation(suite.name, spec, shape);
    if (tv) return settle("blocked", `blocked: ${tv}; nothing was sent`);
    // An unpinned Perplexity call needs the owner's approval, read from the App's options.
    if (shape.seat === "perplexity" && !shape.model) {
      const a = this.approval();
      if (!(a.ok && a.third_party)) return settle("blocked", "blocked: an unpinned Perplexity call needs the owner's research approval and third-party routing in the App's options; nothing was sent");
    }
    if (shape.seat === "codex" && !codexMode) return settle("skipped", "skipped: Codex isn't isolated this run, so it isn't started");
    if (spec.kind === "output") {
      const prov = this.providerFor(c!);
      if (!prov) return settle("skipped", `skipped: no ${c!.seat} key or sign-in in the App`);
      if (task.kind === "review") {
        const b = task.brief;
        text = `${b.topic}\n${b.question}\n${b.body}`; chars = taskChars(task);
        send = (wire, signal) => prov.ask({ wire, signal, day, model: shape.model, brief: b, maxOut: shape.maxOut, thinking: shape.thinking,
          search: shape.search, maxSteps: shape.maxSteps, setting: shape.setting, codexMode });
      } else {
        const p = researchPrompt(task);
        text = `${p.system}\n${p.user}`; chars = taskChars(task);
        send = (wire, signal) => prov.ask({ wire, signal, day, model: shape.model, system: p.system, user: p.user, maxOut: shape.maxOut, thinking: shape.thinking,
          search: shape.search, maxSearches: shape.maxSearches, maxSteps: shape.maxSteps, setting: shape.setting, codexMode });
      }
    } else {
      const g = GRADERS.find((x) => x.id === spec.grader)!;
      const prov = g.id === "claude" ? this.deps.providers.claude : g.id === "gemini" ? this.deps.providers.gemini : this.deps.providers.codex;
      const avail = this.availableGraders(st);
      if (!prov || !avail.includes(g.id)) return settle("skipped", `skipped: ${pf.graders_off?.[g.id] ?? (g.id === "claude" ? "no Anthropic key in the App" : g.id === "gemini" ? "no Gemini key in the App" : "Codex isn't set up")}`);
      const outputs = this.outputsOf(st, task.id);
      if (!outputs.length) return settle("skipped", "skipped: no output of this task to grade");
      const key = this.labelsFor(st, task.id, outputs);
      const byCall = Object.fromEntries(Object.entries(key).map(([l, call]) => [call, l]));
      // Each output's panel: the first two available graders from outside its family; no grader reads its own.
      const mine = outputs.filter((o) => byCall[o.call] && panelFor(familyOf(seatOfConfig(o.config), o.served_model ?? o.model ?? ""), avail).includes(g.id));
      if (!mine.length) return settle("skipped", "skipped: no output of this task has this grader on its panel");
      // Order shuffled for each grader call on its own; the grader gets the output's own words only.
      const labelled: Labelled[] = shuffled(mine.map((o) => ({ label: byCall[o.call],
        output: { call: "", config: "", verdict: o.verdict, findings: o.findings, text: o.text, urls: o.urls } as Output })), () => this.rand());
      labels = labelled.map((x) => x.label);
      // Sixth round: the research grader reads the cited pages' text, fetched by the runner (pages.ts), and has no fetch tool.
      const cited = task.kind !== "review" ? await this.pagesFor(st, task as ResearchTask) : [];
      const gp = gradePrompt(task, labelled, cited);
      adoptedCount = task.kind === "review" ? (/<adopted>\n([\s\S]*?)\n<\/adopted>/.exec(gp.user)?.[1].split("\n").length ?? 0) : 0;
      const blind = blindViolations(`${gp.system}\n${gp.user}`);
      if (blind.length) return settle("blocked", `blocked: the grading prompt wasn't blind (${blind.join("; ")}); nothing was sent`);
      text = `${gp.system}\n${gp.user}`; chars = text.length;
      // No fetch tool goes to any grader; a fetch the provider reports anyway is outside the notes, and its grades aren't kept.
      send = async (wire, signal) => {
        const a = await prov.ask({ wire, signal, day, model: shape.model, system: gp.system, user: gp.user, schema: gp.schema, maxOut: shape.maxOut,
          thinking: shape.thinking, fetch: false, maxFetches: 0, codexMode });
        if (wire.fetched.length) throw new GraderFetchOutside(wire.fetched.length, a.bill?.usd ?? 0);
        return a;
      };
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
    const x = await this.exchange(st, { call: spec.id, attempt: rec.attempts + 1, seat: shape.reviewSeat, worst, runs: ceiling.runs, ...(spec.kind === "grade" ? { hold: this.holdKey(st, task.id) } : {}),
      timeoutS: shape.timeoutS, margin: this.marginFor(suite, st), plan: shape.seat === "codex" },
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
      if (x.reason === "busy" || x.reason === "gone") return "wait";
      if (x.reason === "window") { Object.assign(rec, { next_at: x.retryAt, error: x.detail, worst_usd: worst, at: this.iso() }); this.save(st); return "wait"; }
      if (x.reason === "seat") { Object.assign(rec, { status: "held", error: x.detail, worst_usd: worst, at: this.iso() }); this.save(st); return "held"; }
      if (x.reason === "allowance") { this.end(st, "stopped", { reason: "allowance", at: this.iso(), detail: `the next call (${shape.label} on ${task.id}) wasn't made: ${x.detail}.` }); return "stop"; }
      // Inside a task already held, an output that no longer fits is skipped and the task is still graded.
      if (spec.kind === "output" && st.held[task.id]) return settle("skipped", `skipped: the trials budget: ${x.detail}`);
      this.end(st, "stopped", { reason: "budget", at: this.iso(), detail: `the next call (${shape.label} on ${task.id}) wasn't made: ${x.detail}.` });
      return "stop";
    }
    rec.attempts++;
    if (x.how) addSpend(rec, x.usd, x.how);
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
      // Perplexity: the model must stay the one its check was served by (the pinned one); a change stops the run.
      if (spec.kind === "output" && c!.seat === "perplexity") {
        const expected = shape.model || pf.served?.[c!.id] || "";
        if (expected && served !== expected) {
          this.save(st);
          this.end(st, "stopped", { reason: "model", at: this.iso(), detail: `Perplexity answered ${c!.id} with ${served || "an unnamed model"}, not ${expected}, so the run stopped.` });
          return "stop";
        }
      }
    } else {
      const err = x.err;
      if (x.how) rec.how = x.how;
      if (err instanceof PrivacyBlock) { Object.assign(rec, { status: "blocked", final: true, error: err.message }); delete rec.next_at; }
      else if (err instanceof CodexWebSearch) {
        Object.assign(rec, { status: "failed", final: true, error: err.message }); delete rec.next_at;
        this.alarm(`Codex ran a web search on ${spec.id.split("|").slice(0, 2).join(" ")} although search is off on every call; the call was stopped and counted at its worst case.`);
      }
      else if (err instanceof GraderFetchOutside) {
        Object.assign(rec, { status: "blocked", final: true, error: err.message }); delete rec.next_at;
        this.alarm(`a grader fetched ${err.count} page${err.count === 1 ? "" : "s"} outside the answer notes on ${task.id}; its grades aren't kept.`);
      }
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
  // The cited pages of a research task, fetched once per run by the runner (pages.ts) and kept beside its grades, so every
  // grader of the task reads the same text and a resume doesn't fetch again. Each address is checked against the private
  // terms before it is fetched.
  async pagesFor(st: RunState, task: ResearchTask): Promise<CitedPage[]> {
    const file = this.p().pages(st.suite, st.run, task.id);
    const kept = readJson<CitedPage[] | null>(file, null);
    if (Array.isArray(kept)) return kept;
    const out: CitedPage[] = [];
    const fetchFn = (this.deps.pageFetch ?? this.deps.fetch ?? fetch) as PageFetch;
    for (const u of noteFetchUrls(task)) {
      const priv = textCheck(u, this.deps.review.terms());
      if (!priv.ok) { out.push({ url: u, why: "its address matched the private-terms list, so it wasn't fetched" }); continue; }
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30_000 * (this.cfg.timeoutScale ?? 1));
      try { out.push(await fetchCitedPage(u, fetchFn, ctl.signal)); } finally { clearTimeout(t); }
    }
    writeAtomic(file, JSON.stringify(out, null, 1));
    return out;
  }
  private providerFor(c: Config): Provider | undefined {
    const p = this.deps.providers;
    return c.seat === "claude" ? p.claude : c.seat === "gemini" ? p.gemini : c.seat === "perplexity" ? p.perplexity : c.seat === "codex" ? p.codex : undefined;
  }
}

// A grader that fetched a page beyond the exact ones cited in the answer notes: its grades aren't kept.
export class GraderFetchOutside extends SeatError {
  constructor(public count: number, cost: number) { super("refused", `the grader fetched ${count} page${count === 1 ? "" : "s"} not cited in the answer notes; its grades aren't kept`, cost); }
}

// One attempt's cost, by how it is known.
export function addSpend(rec: CallRec, usd: number, how: How) {
  const sp = rec.spend ??= { billed: 0, estimated: 0, unresolved: 0, plan_calls: 0 };
  const r = (n: number) => Number(n.toFixed(6));
  if (how === "billed") sp.billed = r(sp.billed + usd);
  else if (how === "estimated") sp.estimated = r(sp.estimated + usd);
  else if (how === "plan call") sp.plan_calls++;
  else sp.unresolved = r(sp.unresolved + usd);
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

// The preflight's report (sixth round): its named go/no-go lines, the installed Codex, key separation, what it disabled.
export function preflightReport(rec: PreflightRecord): string {
  const out = [`# Trials preflight ${rec.id}`, "", `Status: ${rec.status}${rec.stop ? ` (${rec.stop})` : ""}. Build ${rec.build}, finished ${rec.finished_at ?? "not yet"}.`, "", "## Go/no-go", ""];
  for (const [k, name] of Object.entries(GO_LINES) as [GoLineName, string][]) {
    const g = rec.golines?.[k];
    out.push(`- ${name}: ${g ? `${g.status.toUpperCase()}. ${g.detail}` : "NOT CHECKED"}`);
  }
  out.push("", `Codex installed: ${rec.codex_version ?? "unknown"} (at least ${CODEX_MIN_VERSION} needed). Codex stays disabled until its first three lines are GO.`);
  out.push(`Key separation: ${rec.key_separation ?? KEY_SEPARATION}.`);
  const dis = Object.entries(rec.disabled ?? {});
  out.push("", "## Disabled", "", ...(dis.length ? dis.map(([c, w]) => `- ${c}: ${w}`) : ["- nothing"]));
  return `${out.join("\n")}\n`;
}
