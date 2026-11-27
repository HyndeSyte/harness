// The review runner: one record per review in /data/review-queue, moved forward
// one tick at a time. Seats run independently and in parallel; a down seat is
// retried with backoff, then stood in for by Claude (marked substituted, never
// counted as independent); a consequential review waits for two non-Claude
// families, retrying hourly for up to a day. Every step re-runs the privacy gate.
// Each finished review's Reviewed line is published to /data/trust/reviewed.json
// (../reviewed.ts) before Cain hears it's done, and the file is rebuilt from the queue
// at start, so it survives a restart.
import { appendFileSync, chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAIN_UID, readOwned } from "../owned.ts";
import { keptReviewed, type Reviewed, writeReviewed } from "../reviewed.ts";
import {
  CUT_CHECK, CUT_SEATS, FINAL, JUDGES, LABEL, MIN_ESSENTIALS, SEATS, SeatError, allRaised, backoffMs, checkBrief, cutResult, downgraded, earlierCheck, findingRef, readMark, estimate, fixFor, independent, markBlocked, oneLine, outbound, recordRequest,
  newReview, parseBrief, relayLine, reviewCheck, safeId, sayLine, seatName, seriousLeft, shownId, sortOutbound, panelOf, retryLimit, seatRun, wroteCut, type Brief, type ErrorKind, type Outbound, type Review, type SeatName, type SeatRun, type SortRec,
} from "./core.ts";
import type { SeatFn } from "./seats/common.ts";
import { CUT_TRANSPORT_MAX, DEFAULT_ROUND_CAP, addRound, admit, admitCut, checkDecision, countedRounds, decideWhy, cutOf, decisionOf, essentialsOf, groupOf, heldOf, lastRound, purposeOf, purposeText,
  readRounds, releaseCut, reserveCut, rootOf, writeRounds, type OwnerOutcome, type PurposeRec, type Rounds } from "./rounds.ts";
import { gitCutDiff, verifyFetch, type CutDiffFn } from "./cutdiff.ts";
import { DEFAULT_RESERVE_PERCENT, SETTINGS_FORMAT, guard, labelOf } from "../guard.ts";
import type { PlanReading } from "../plan-usage.ts";

export type RunnerConfig = {
  queueDir: string; spendFile: string; healthFile: string; termsFile: string; recordQueue: string; relayFile: string;
  reviewedFile?: string;             // where the Reviewed lines are published (configFromEnv); none: not published
  // Where Cain's briefs wait (C1): review.sh, run as his user, writes there and never in the
  // queue, so only the runner writes the files the Reviewed lines are published from.
  // None: no inbox (the tests that queue directly).
  inboxDir?: string;
  inboxUid?: number;                 // whose files the inbox takes (default his user, ../owned.ts)
  spendDaysFile?: string;            // spend per day and seat, for the security watch (none: beside spendFile)
  caps: { gemini: number; perplexity: number; claude: number; openaiRuns: number };
  reviewLimit: number;
  timeoutS: Record<SeatName, number>;
  maxOut: Record<SeatName, number>;
  models: { gemini: string; geminiBig: string; perplexity: string; claude: string };
  hourlyS: number; tz: string;
  // Cain 0.16.0: the review-round cap and the usage guard's reserve floor (the App's options, root's),
  // where the rounds are kept, where the runner writes the settings it really uses (for review.sh and
  // the Build hook), and the guard's log. Absent files: the cap and guard aren't kept (tests that queue directly).
  roundCap?: number; reservePercent?: number;
  roundsFile?: string; settingsFile?: string; guardLog?: string;
  // Round 1 fixes: the runner's own bare copy of the repository for cut diffs, and where it fetches from.
  cutRepo?: string; cutRemote?: string;
  // Round 2 fixes: the runner's GitHub token (the App's option review_github_token), for the cut diff's fetch and the
  // pull request's description; none: both go without one. Never logged.
  githubToken?: string;
};

export const DEFAULTS: Omit<RunnerConfig, "queueDir" | "spendFile" | "healthFile" | "termsFile" | "recordQueue" | "relayFile"> = {
  caps: { gemini: 8, perplexity: 4, claude: 30, openaiRuns: 200 },
  reviewLimit: 1.5,
  timeoutS: { openai: 600, gemini: 240, perplexity: 180, claude: 420 },
  maxOut: { openai: 0, gemini: 8_192, perplexity: 4_000, claude: 16_000 },
  models: { gemini: "gemini-3.8-flash", geminiBig: "gemini-4-argon", perplexity: "perplexity/sonar", claude: "claude-opus-5-5" },
  hourlyS: 3_600, tz: "America/New_York",
  roundCap: DEFAULT_ROUND_CAP, reservePercent: DEFAULT_RESERVE_PERCENT,
};

export type Unavailable = { kind: ErrorKind; detail: string } | null;
export type RunnerDeps = {
  seats: Partial<Record<SeatName, SeatFn>>;
  unavailable?: (seat: SeatName) => Unavailable;   // e.g. Codex not signed in
  now?: () => Date; rand?: () => number; log?: (m: string) => void;
  stopped?: () => boolean;                         // Dane's Stop (../stop.ts): nothing is sent while it holds
  plan?: () => PlanReading;                        // the plan-usage reading (../plan-usage.ts), for the guard
  // Round 1 fixes: the cut diff, derived through git (cutdiff.ts; default: gitCutDiff on cutRepo and cutRemote),
  // and the owner's one plain line at the cap through the link (its root socket): the message id once the link
  // confirms it, null while it doesn't (tried again next tick). Absent: lines stay owed.
  cutDiff?: CutDiffFn;
  postLine?: (l: OwnerLine) => Promise<string | null>;
  // Round 2 fixes: the pull request's description as GitHub has it (default: its API, with the runner's token when
  // there is one), for the purpose record; and the fetch check at the runner's start (default: cutdiff.ts verifyFetch).
  prBody?: (pr: string) => Promise<{ ok: true; body: string } | { ok: false; why: string }>;
  verifyFetch?: () => { ok: boolean; detail: string };
};
// One plain line to the owner (no card, no buttons, no question): the link builds its words from these fields.
export type OwnerLine = { id: string; outcome: OwnerOutcome; topic: string; serious?: number; why?: string };
export const REMIND_MS = 3_600_000, UNDECIDED_MS = 86_400_000;

export type SpendRow = { usd: number; runs: number; findings: number; searches: number };
export type Ledger = Record<string, Partial<Record<SeatName, SpendRow>>>;
// Spend per day (YYYY-MM-DD in the runner's time zone) and seat, kept 62 days: the security
// watch's daily lines and its jump rule read it (../security/core.ts).
export type DayRow = { usd: number; runs: number };
export type DayLedger = Record<string, Partial<Record<SeatName, DayRow>>>;
export const DAYS_KEPT = 62;
// Whether a seat's monthly cap is reached already (runs for Codex, dollars for the others):
// review.sh refuses a review whose seats are all there, and the security watch says so.
export function atCap(ledger: Ledger, month: string, caps: RunnerConfig["caps"], seat: SeatName): boolean {
  const row = ledger[month]?.[seat];
  if (seat === "openai") return (row?.runs ?? 0) >= caps.openaiRuns;
  return (row?.usd ?? 0) >= caps[seat];
}
export const daysFileOf = (cfg: Pick<RunnerConfig, "spendFile" | "spendDaysFile">) =>
  cfg.spendDaysFile ?? join(dirname(cfg.spendFile), "review-spend-days.json");
export type SeatHealth = { ok: boolean; at: string; kind?: ErrorKind; detail?: string; fix?: string };
// Round 1 fixes: per seat, each round's count of findings with a valid SERIOUS or FOLLOW-UP label (the newest 50).
export type LabelRow = { id: string; round?: number; labelled: number; total: number; at: string };
// fetch (round 2 fixes): whether the runner could fetch the repository at its start, for the cut diff.
export type Health = Partial<Record<SeatName, SeatHealth>> & { labels?: Partial<Record<SeatName, LabelRow[]>>; fetch?: { ok: boolean; at: string; detail: string } };

// The opening of a pull request description's "What changed" section as the owner reads it (round 2 fixes): its
// first paragraph, at most 1,200 characters; null when there is none.
export function whatChangedOpening(body: string): string | null {
  const lines = String(body ?? "").replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) => /^##\s+What changed\s*$/i.test(l.trim()));
  if (at < 0) return null;
  const para: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(l.trim())) break;
    if (!l.trim()) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  const t = oneLine(para.join(" "), 1_200);
  return t || null;
}
// The pull request's description through GitHub's API (round 2 fixes), with the token when there is one.
export function githubPrBody(token?: string, fetcher: typeof fetch = fetch) {
  return async (pr: string): Promise<{ ok: true; body: string } | { ok: false; why: string }> => {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/i.exec(pr);
    if (!m) return { ok: false, why: "not a pull request address" };
    try {
      const res = await fetcher(`https://api.github.com/repos/${m[1]}/pulls/${m[2]}`, { headers: { accept: "application/vnd.github+json", "user-agent": "cain-review-runner",
        ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 200) return { ok: false, why: `GitHub answered ${res.status}` };
      const j: any = await res.json();
      return typeof j?.body === "string" ? { ok: true, body: j.body } : { ok: false, why: "the pull request has no description" };
    } catch (e) { return { ok: false, why: `GitHub couldn't be reached (${String((e as Error)?.message ?? e).slice(0, 80)})` }; }
  };
}
export const LABEL_ROWS = 50;
// The parse rate of a seat's labels over the rows kept: labelled findings of all findings, null with none.
export function labelRate(rows: LabelRow[] | undefined): { labelled: number; total: number; rate: number | null } {
  const labelled = (rows ?? []).reduce((n, r) => n + r.labelled, 0), total = (rows ?? []).reduce((n, r) => n + r.total, 0);
  return { labelled, total, rate: total ? labelled / total : null };
}

const GROUNDING_FREE = 5_000, GROUNDING_USD = 0.014;   // Gemini 3+: 5,000 grounded searches a month free, then $14 / 1,000

export const SELFTEST: Brief = {
  id: "nightly-self-test", topic: "Nightly self-test", question: "Is the claim correct?",
  body: "Claim: 2 + 2 = 4. Approve if it is correct, with no findings.", needs_facts: false, consequential: false,
};

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  // Readable by the folder's group (C1: his user's group), so review.sh can show status and
  // results to him; only root writes here. A file already there keeps its group and mode: in
  // /data (no setgid) a new one would come out root:root, and lock.sh's root:cain on the spend
  // and health files was lost at the first rewrite (Cain 0.13.5).
  writeFileSync(tmp, text, { mode: 0o640 });
  try { const s = statSync(path); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* a new file */ }
  renameSync(tmp, path);
}
function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// Only a safe id names a file, so no id can reach outside the queue folder.
export const reviewFile = (dir: string, id: string) => {
  if (!safeId(id)) throw new Error("not a safe review id");
  return join(dir, `${id}.json`);
};
// A file whose review names a different id than its own is not read at all.
export function loadReview(dir: string, id: string): Review | null {
  if (!safeId(id)) return null;
  const r = readJson<Review | null>(reviewFile(dir, id), null);
  return r && typeof r === "object" && r.id === id ? r : null;
}
export function saveReview(dir: string, r: Review) { writeAtomic(reviewFile(dir, r.id), JSON.stringify(r, null, 1)); }

// The sorting step's label of one listed finding: "SERIOUS (<arm>) [n]:" or "FOLLOW-UP (<arm>) [n]:".
const SORT_MARK = /^\s*\**\s*\[?\s*(serious|follow[- ]?up)\s*\]?\s*(?:\(\s*([^)]{1,80}?)\s*\))?\s*\[\s*(\d{1,2})\s*\]\s*\**\s*[:.\-]\s*/i;

export class Runner {
  private now: () => Date; private rand: () => number; private log: (m: string) => void;
  constructor(public cfg: RunnerConfig, public deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rand = deps.rand ?? Math.random;
    this.log = deps.log ?? ((m) => console.log(`[review] ${m}`));
  }

  // ---- reading and writing ----
  terms(): string | null { try { return readFileSync(this.cfg.termsFile, "utf8"); } catch { return null; } }
  month(): string { return this.now().toLocaleDateString("en-CA", { timeZone: this.cfg.tz }).slice(0, 7); }
  day(): string { return this.now().toLocaleDateString("en-CA", { timeZone: this.cfg.tz }); }
  ledger(): Ledger { return readJson<Ledger>(this.cfg.spendFile, {}); }
  health(): Health { return readJson<Health>(this.cfg.healthFile, {}); }
  relay(text: string) { mkdirSync(dirname(this.cfg.relayFile), { recursive: true }); appendFileSync(this.cfg.relayFile, JSON.stringify({ text }) + "\n"); }

  addSpend(seat: SeatName, usd: number, findings: number, searches = 0): number {
    const l = this.ledger(), m = this.month();
    const row = (l[m] ??= {})[seat] ??= { usd: 0, runs: 0, findings: 0, searches: 0 };
    let extra = 0;
    if (seat === "gemini" && searches) {
      const over = Math.max(0, row.searches + searches - Math.max(GROUNDING_FREE, row.searches));
      extra = over * GROUNDING_USD;
    }
    row.usd = Number((row.usd + usd + extra).toFixed(6)); row.runs++; row.findings += findings; row.searches += searches;
    writeAtomic(this.cfg.spendFile, JSON.stringify(l, null, 1));
    try {
      const file = daysFileOf(this.cfg), d = this.day();
      const days = readJson<DayLedger>(file, {});
      const r = (days[d] ??= {})[seat] ??= { usd: 0, runs: 0 };
      r.usd = Number((r.usd + usd + extra).toFixed(6)); r.runs++;
      const oldest = new Date(Date.parse(`${d}T12:00:00Z`) - DAYS_KEPT * 86_400_000).toISOString().slice(0, 10);
      for (const k of Object.keys(days)) if (k < oldest) delete days[k];
      writeAtomic(file, JSON.stringify(days, null, 1));
    } catch (e) { this.log(`couldn't keep the day's spend: ${(e as Error).message.slice(0, 80)}`); }
    return usd + extra;
  }

  private fnFor(seat: SeatName): SeatFn | undefined { return this.deps.seats[seat]; }
  unavailable(seat: SeatName): Unavailable {
    if (!this.fnFor(seat)) return { kind: "unconfigured", detail: `no ${LABEL[seat]} key in the add-on's options` };
    return this.deps.unavailable?.(seat) ?? null;
  }
  private estModel(seat: SeatName, b: Outbound): string {
    const m = this.cfg.models;
    return seat === "gemini" ? (b.consequential ? m.geminiBig : m.gemini) : seat === "perplexity" ? m.perplexity : m.claude;
  }
  // Monthly caps per seat, and the per-review limit, checked before every call.
  capCheck(seat: SeatName, b: Outbound, spentThisReview: number, selftest = false): Unavailable {
    const row = this.ledger()[this.month()]?.[seat];
    if (seat === "openai") {
      return (row?.runs ?? 0) >= this.cfg.caps.openaiRuns ? { kind: "cap", detail: `the monthly cap of ${this.cfg.caps.openaiRuns} Codex runs is reached` } : null;
    }
    const est = estimate(seat, this.estModel(seat, b), b, selftest ? 2_048 : this.cfg.maxOut[seat], this.day());
    const cap = this.cfg.caps[seat];
    if ((row?.usd ?? 0) + est > cap) return { kind: "cap", detail: `the monthly cap of $${cap} for ${LABEL[seat]} is reached` };
    if (!selftest && spentThisReview + est > this.cfg.reviewLimit) return { kind: "cap", detail: `over the per-review limit of $${this.cfg.reviewLimit}` };
    return null;
  }

  // Dane's Stop: nothing goes out to an outside model while it holds. A state that can't
  // be read counts as stopped.
  isStopped(): boolean {
    try { return this.deps.stopped?.() ?? false; } catch { return true; }
  }

  // ---- the Reviewed lines, for the link and the reply hooks (../reviewed.ts) ----
  // Rebuilt whole from the queue: every review that's done and has a line, with the pull
  // request and head it was of, never one blocked for privacy, from the last 30 days, at most
  // 200. also: a review that changed and isn't saved yet. A queue file that can't be read is
  // left out, said once; a write that fails is tried again at the end of each tick until it lands.
  private publishOwed = false;
  private unreadable = new Set<string>();
  publishReviewed(also?: Review): boolean {
    const path = this.cfg.reviewedFile;
    if (!path) return true;
    try {
      mkdirSync(this.cfg.queueDir, { recursive: true });
      const list: Reviewed[] = [];
      const ids = readdirSync(this.cfg.queueDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => n.slice(0, -5));
      for (const id of new Set([...ids, ...(also ? [also.id] : [])])) {
        try {
          const r = also?.id === id ? also : loadReview(this.cfg.queueDir, id);
          if (!r) throw new Error("it can't be read as a review");
          if (r.status !== "done" || r.id_private || !safeId(r.id) || !r.finished_at) continue;
          const line = sayLine(r);
          if (line) list.push({ id: r.id, line, finished_at: r.finished_at, pr: r.brief?.pr ?? null, head: r.brief?.head ?? null });
        } catch (e) {
          if (this.unreadable.has(id)) continue;
          this.unreadable.add(id);
          this.log(`a queue file was left out of the Reviewed lines: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        }
      }
      writeReviewed(keptReviewed(list, this.now().getTime()), path);
      this.publishOwed = false;
      return true;
    } catch (e) {
      this.publishOwed = true;
      this.log(`couldn't publish the reviews' lines; tried again next tick: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      return false;
    }
  }

  // ---- the loop ----
  // Cain's briefs, from his inbox into the queue. Only the brief's own fields are read
  // (parseBrief refuses any other), and the review is made here, fresh: nothing in his file
  // can make a review look run, or put a line on a Ship card. Each file is taken once and
  // removed, whatever it held; one that isn't a plain file of his, or isn't a brief, is
  // refused and he hears why.
  ingest(): void {
    const dir = this.cfg.inboxDir;
    if (!dir) return;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); }
    catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const got = readOwned(path, this.cfg.inboxUid ?? CAIN_UID, 256 * 1024);
      try { unlinkSync(path); } catch { /* already gone */ }
      if (!got.ok) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken (${got.why}). Submit it again with review.sh. Nothing to tell him.`); continue; }
      const p = parseBrief(got.text);
      if (!p.brief) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken: not a brief: ${p.error}. Nothing to tell him.`); continue; }
      if (existsReview(this.cfg.queueDir, p.brief.id)) { this.relay(`Review brief ${p.brief.id} wasn't taken: a review with that id already exists; use a new id. Nothing to tell him.`); continue; }
      const why = this.admitAndQueue(p.brief);
      if (why) this.relay(`Review brief ${p.brief.id} wasn't taken: ${why} Nothing to tell him.`);
    }
  }

  // ---- the review-round cap and the usage guard (Cain 0.16.0; rounds.ts, ../guard.ts) ----
  get roundCap(): number { const c = this.cfg.roundCap; return Number.isInteger(c) && c! >= 1 ? c! : DEFAULT_ROUND_CAP; }
  // What the runner really uses, for review.sh and the Build hook, which run as Cain.
  writeSettings(): void {
    if (!this.cfg.settingsFile) return;
    writeAtomic(this.cfg.settingsFile, JSON.stringify({ format: SETTINGS_FORMAT, written_at: this.now().toISOString(), round_cap: this.roundCap,
      reserve_percent: this.cfg.reservePercent ?? DEFAULT_RESERVE_PERCENT, caps: this.cfg.caps, review_limit: this.cfg.reviewLimit }, null, 1));
  }
  // A brief of Cain's into the queue, as a new round of its change, or the reason it isn't (null: queued).
  // The install-time self-check's finding (../capfiles.ts, main.ts): while set, the cap and guard are off,
  // so no brief is taken (fail closed) and no round is settled.
  capOff: string | null = null;
  admitAndQueue(given: Brief): string | null {
    // Only a brief's own fields go in (Cain 0.18.1): a brief carrying anything else, earlier findings
    // included, is refused whole, so the findings a fix-only round sends are only ever the ones the
    // runner loads itself from its own record of the change's previous round (earlierFindings).
    const c = checkBrief(given);
    if (!c.brief) return `not a brief: ${c.error}. Nothing was queued.`;
    const b = c.brief;
    const file = this.cfg.roundsFile;
    if (!file) { saveReview(this.cfg.queueDir, newReview(b, this.now())); return null; }
    if (this.capOff) return `the review cap's files aren't right (${this.capOff}), so no round can be counted: the App's alarm says so, and it's logged for a Build item. Nothing was queued.`;
    const rounds = readRounds(file);
    if (!rounds) return "the review rounds file (/data/review-rounds.json) can't be read, so no round can be counted: it's logged for a Build item. Nothing was queued.";
    if (b.kind === CUT_CHECK) return this.admitCutCheck(rounds, file, b);
    const a = admit(rounds, b, this.roundCap);
    if (!a.ok) return a.why;
    // A round id is one change's (Cain 0.18.1): an id already kept as a round of another change is refused,
    // so no round's record can stand for two changes and a fix-only round never reads another's findings.
    const other = Object.entries(rounds.changes).find(([k, c]) => k !== a.key && c.rounds.some((x) => x.id === b.id));
    if (other) return `refused: the id ${b.id} is already a round of another change, so it can't be a round of ${a.key}: give this round a new id. Nothing was queued.`;
    const label = labelOf(b.label)!;
    if (this.cfg.settingsFile && this.cfg.guardLog && this.cfg.spendFile) {
      const g = guard(label, `review ${b.id} (${a.key}, round ${a.round})`, { settingsFile: this.cfg.settingsFile, spendFile: this.cfg.spendFile,
        logFile: this.cfg.guardLog, tz: this.cfg.tz, now: this.now(), plan: this.deps.plan });
      if (!g.ok) return `held by the usage guard: it's labelled ${label}, and ${g.why}. Core, commitment and necessary-fix work still run; this is on the guard's log (review.sh guard). Nothing was queued.`;
    }
    const r = newReview(b, this.now());
    Object.assign(r, { change: a.key, round: a.round, cap: a.cap, round_kind: a.kind });
    if (a.kind === "fixes") r.earlier = this.earlierFindings(rounds, a.key);
    // The round is kept before the review is queued: a stop between the two counts a round that never
    // ran (fails safe), never runs one that wasn't counted.
    addRound(rounds, b, a, this.now().toISOString());
    writeRounds(file, rounds);
    saveReview(this.cfg.queueDir, r);
    return null;
  }
  // The change's one cut check (0.20.0): not a round, so it isn't counted; refused unless the change is at its
  // cap with something serious left, isn't held, and has had none. Round 1 fixes: the runner chooses its seat
  // (chooseCutSeat: an outside model, never Claude or a stand-in, whatever seat the brief names), reserves the
  // one check atomically before anything is dispatched (rounds.ts reserveCut), records Cain's decision to cut,
  // and loads the serious findings, the head they were found at and the piece's purpose from its own record,
  // never from the brief. The cut diff is derived through git when the check runs (advance).
  private admitCutCheck(rounds: Rounds, file: string, given: Brief): string | null {
    const a = admitCut(rounds, given, this.roundCap);
    if (!a.ok) return a.why;
    const other = Object.values(rounds.changes).some((c) => c.rounds.some((x) => x.id === given.id) || c.cut?.id === given.id);
    if (other) return `refused: the id ${given.id} is already a round or a cut check: give the cut check a new id. Nothing was queued.`;
    const label = labelOf(given.label)!;
    if (this.cfg.settingsFile && this.cfg.guardLog && this.cfg.spendFile) {
      const g = guard(label, `cut check ${given.id} (${a.key})`, { settingsFile: this.cfg.settingsFile, spendFile: this.cfg.spendFile,
        logFile: this.cfg.guardLog, tz: this.cfg.tz, now: this.now(), plan: this.deps.plan });
      if (!g.ok) return `held by the usage guard: it's labelled ${label}, and ${g.why}. Core, commitment and necessary-fix work still run; this is on the guard's log (review.sh guard). Nothing was queued.`;
    }
    const prev = this.lastReview(a.last);
    const serious = prev ? seriousLeft(prev).slice(0, 30).map((f) => `${f.arm ? `[serious: ${oneLine(f.arm, 80)}] ` : "[serious] "}${oneLine(f.problem, 400)}`) : [];
    if (!serious.length) return `refused: the serious findings of ${a.key}'s last round can't be read from the runner's record, so there's nothing to check the cut against: it's logged for a Build item. Nothing was queued.`;
    // Round 2 fixes: the purpose record is read when the check runs (prepareCut); a missing one fails the cut there.
    const seat = this.chooseCutSeat(prev!);
    const root = rootOf(rounds, a.key);
    const queued = (id: string) => existsReview(this.cfg.queueDir, id);
    if (!reserveCut(file, root, given.id, (held, age) => age > 10 * 60_000 && !queued(held) && cutOf(rounds, a.key)?.id !== held))
      return `refused: ${a.key} already has its one cut check (another was reserved first). There is no second cut and no second check. Nothing was queued.`;
    const b: Brief = { ...given, seats: [seat], consequential: false };
    const r = newReview(b, this.now());
    Object.assign(r, { change: a.key, kind: CUT_CHECK, earlier: serious, cut_base: a.base });
    const c = rounds.changes[a.key] ??= { rounds: [] };
    c.cut = { id: b.id, at: this.now().toISOString(), head: b.head!, pr: b.pr!, seat, base: a.base, state: "started" };
    // Submitting the cut check is Cain's decision to cut (review.sh decide cut says the same).
    if (!decisionOf(rounds, a.key)) (rounds.changes[root] ??= { rounds: [] }).decided = { choice: "cut", at: this.now().toISOString() };
    writeRounds(file, rounds);
    saveReview(this.cfg.queueDir, r);
    return null;
  }
  // The cut check's seat (round 1 fixes): an outside judge (OpenAI or Gemini; every cut is written by Build, a
  // Claude session, so no outside seat wrote it), preferring one whose serious findings the sorting step
  // downgraded, then one whose serious findings stand, then OpenAI; one that is down now is passed over while
  // another is up. Never Claude, never a stand-in, never the seat a brief names.
  chooseCutSeat(prev: Review): SeatName {
    const raised = allRaised(prev);
    const down = new Set(raised.filter((x) => downgraded(prev, x)).map((x) => x.seat.seat));
    const stands = new Set(seriousLeft(prev).length ? raised.filter((x) => x.f.severity === "serious").map((x) => x.seat.seat) : []);
    const order = [...CUT_SEATS].sort((x, y) => (down.has(y) ? 2 : stands.has(y) ? 1 : 0) - (down.has(x) ? 2 : stands.has(x) ? 1 : 0));
    return order.find((x) => !this.unavailable(x)) ?? order[0];
  }
  // The change's last round's own queue record; null when it can't be read.
  private lastReview(last: { id: string; key: string }): Review | null {
    const prev = loadReview(this.cfg.queueDir, last.id);
    if (!prev || prev.id !== last.id || prev.change !== last.key || prev.status === "blocked: privacy") return null;
    return prev;
  }
  // The findings of the change's latest round that answered, for a fix-only round to check the fixes against.
  // Read only from the runner's own files: the rounds recorded under this change's own key in the rounds file
  // (each round by its id; Cain 0.18.1: not a linked change's) and the queue record that round left, which
  // must be that round of this change. Nothing a brief or request carries reaches them.
  private earlierFindings(rounds: Rounds, key: string): string[] {
    const own = (rounds.changes[key]?.rounds ?? []).filter((x) => !x.blocked).sort((a, b) => a.at.localeCompare(b.at)).reverse();
    for (const x of own) {
      const prev = loadReview(this.cfg.queueDir, x.id);
      if (!prev || prev.id !== x.id || prev.change !== key || prev.status === "blocked: privacy") continue;
      const list = prev.seats.filter((s) => s.state === "done").flatMap((s) => (s.findings ?? []).map((f) =>
        `${seatName(s)}${f.severity ? ` [${f.severity}]` : ""}: ${oneLine(f.problem, 400)}`));
      if (list.length) return list.slice(0, 30);
    }
    return [];
  }
  // A finished round, kept in the rounds file once: answered, or lost (no seat answered: it still counts);
  // a round blocked for privacy sent nothing and doesn't count. Nothing goes to the owner from here (0.20.0):
  // the done line says "at its cap" and the serious count, and Cain decides by the owner's rule.
  private settleRound(r: Review): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !r.change || r.rounded || !FINAL.includes(r.status)) return;
    const rounds = readRounds(file);
    if (!rounds) { this.log(`the rounds file can't be read; review ${shownId(r)}'s round is settled next tick`); return; }
    if (r.kind === CUT_CHECK) {
      const c = rounds.changes[r.change];
      if (c?.cut?.id === r.id) {
        // Blocked for privacy, or refused (round 1 fixes: the cut head doesn't descend from the last-reviewed
        // head): nothing was sent, so it wasn't the check, its reservation is released, and another may be
        // submitted. Otherwise anything but a clear pass is a fail (cutResult), and the owner hears one line.
        // Round 2 fixes: a change held meanwhile (its cut could not be checked) stays held, whatever came back late:
        // its check is lost, and no second line goes to the owner.
        if (heldOf(rounds, r.change)) { if (c.cut.state === "started") c.cut.state = "lost"; }
        else if (r.status === "blocked: privacy" || r.cut_refused) { delete c.cut; releaseCut(file, rootOf(rounds, r.change)); }
        else {
          c.cut.state = cutResult(r) ?? "fail";
          this.owe(rounds, r.change, c.cut.state === "pass" ? "cut-pass" : "cut-fail", {});
        }
        this.log(`cut check ${shownId(r)} for ${r.change}: ${c.cut?.state ?? "not sent, not counted"}`);
      }
      writeRounds(file, rounds);
      r.rounded = true;
      return;
    }
    const rec = rounds.changes[r.change]?.rounds.find((x) => x.id === r.id);
    const serious = seriousLeft(r);
    if (rec) {
      rec.done = true;
      if (r.status === "blocked: privacy") rec.blocked = true;
      else rec.state = r.seats.some((s) => s.state === "done") ? "answered" : "lost";
      // The serious count by the owner's rule (0.20.0), every round: what the link's Ship card reads at the cap.
      if (rec.state === "answered") rec.serious = serious.length;
      // Round 2 fixes: round 1 freezes the change's purpose record.
      if (r.round === 1 && !rec.blocked) this.freezePurpose(rounds, r);
    }
    // At the cap (round 1 fixes) the owner hears one plain line, from code: nothing serious left (its Ship card
    // follows), the last round lost (held), or the serious count and that Cain now holds or cuts it; the cap's
    // time is kept for Cain's reminder and the owner's undecided line.
    if (rec && !rec.blocked && countedRounds(rounds, r.change).length >= this.roundCap) {
      this.log(`review ${shownId(r)}: ${r.change} is at its cap ${rec.state === "lost" ? "and its last round was lost" : `with ${serious.length} serious finding(s) left`}; Cain decides by the owner's rule`);
      if (rec.state === "lost") this.owe(rounds, r.change, "lost", {});
      else if (!serious.length) this.owe(rounds, r.change, "clean", {});
      else {
        this.owe(rounds, r.change, "cap", { serious: serious.length });
        const root = rootOf(rounds, r.change);
        (rounds.changes[root] ??= { rounds: [] }).capped ??= { at: this.now().toISOString(), id: r.id, serious: serious.length };
      }
    }
    writeRounds(file, rounds);
    r.rounded = true;
  }
  // The purpose record (round 2 fixes), frozen when round 1 settles: the opening of the pull request description's
  // "What changed" section (read once at round 1) and each round 1 outside seat's own statement of what the piece must
  // do. Never written again.
  private freezePurpose(rounds: Rounds, r: Review): void {
    const c = rounds.changes[r.change!];
    if (!c) return;
    const had = purposeOf(rounds, r.change!);
    if (had?.frozen) return;
    const statements = r.seats.filter((x) => x.state === "done" && x.counts && x.seat !== "claude" && x.purpose)
      .map((x) => ({ seat: LABEL[x.seat], text: oneLine(x.purpose!, 1_200) }));
    c.purpose = { topic: had?.topic ?? r.brief?.topic ?? r.topic, question: had?.question ?? r.brief?.question ?? "", what_changed: r.what_changed ?? null,
      statements, source: "round 1", frozen: this.now().toISOString() };
  }
  // A round counted at intake whose review never reached the queue (the runner stopped between the
  // two writes) is lost, found once at the runner's start: it still counts, and Cain hears it named. A cut
  // check kept the same way is lost too: it was the change's one check.
  private recovered = false;
  recoverLost(): void {
    const file = this.cfg.roundsFile;
    if (this.recovered || !file || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;                               // tried again next tick
    this.recovered = true;
    const lines: string[] = [];
    for (const [key, c] of Object.entries(rounds.changes)) {
      for (const x of c.rounds) {
        if (x.done || x.blocked || x.state === "lost" || x.state === "answered" || existsReview(this.cfg.queueDir, x.id)) continue;
        x.state = "lost"; x.done = true;
        const n = countedRounds(rounds, key).findIndex((y) => y.id === x.id && y.key === key) + 1;
        lines.push(`Round ${n} of ${this.roundCap} for ${key} was lost: the review runner stopped before its review was queued, so it never ran. It still counts${n >= this.roundCap ? ", and it was the last: by the owner's rule it is held" : ""}.`);
      }
      // A cut check kept but never queued (a stop between the two writes) never ran: nothing was sent, so its
      // reservation is released and Cain may submit it again (round 1 fixes: an infrastructure failure never
      // consumes the check).
      if (c.cut?.state === "started" && !existsReview(this.cfg.queueDir, c.cut.id)) {
        lines.push(`The cut check ${c.cut.id} for ${key} never ran: the review runner stopped before it was queued. Nothing was sent, so it isn't used up: submit it again under a new id.`);
        delete c.cut;
        releaseCut(file, rootOf(rounds, key));
      }
    }
    if (!lines.length) return;
    writeRounds(file, rounds);
    for (const l of lines) this.relay(`${l} Nothing to tell him.`);
  }
  // At the runner's start (round 2 fixes): the fetch the cut diff needs is checked, with the token when there is one,
  // and kept for review.sh health; then every line owed to the owner (kept on disk before any post) is drained.
  async start(): Promise<void> {
    try {
      const v = this.deps.verifyFetch ?? (this.cfg.cutRemote ? () => verifyFetch({ remote: this.cfg.cutRemote!, token: this.cfg.githubToken }) : null);
      if (v) {
        const got = v();
        const h = this.health();
        h.fetch = { ok: got.ok, at: this.now().toISOString(), detail: got.detail };
        writeAtomic(this.cfg.healthFile, JSON.stringify(h, null, 1));
        if (!got.ok) this.log(`the cut diff's fetch doesn't work: ${got.detail}`);
      }
    } catch (e) { this.log(`couldn't check the cut diff's fetch: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    try { await this.postLines(); } catch (e) { this.log(`owed lines to the owner: ${(e as Error).message}`); }
  }
  async tick(): Promise<void> {
    try { this.recoverLost(); this.ingest(); this.ingestDecisions(); await this.reviews(); this.remind(); }
    finally {
      if (this.publishOwed) this.publishReviewed();
      try { await this.postLines(); } catch (e) { this.log(`owed lines to the owner: ${(e as Error).message}`); }
    }
  }

  // ---- the owner's one line at the cap, and Cain's decision (round 1 fixes) ----
  // One line owed per change group and outcome, kept in the rounds file under the group's first key until the
  // link confirms it (postLines), and never owed twice: a repeat of the same outcome owes nothing.
  owe(rounds: Rounds, key: string, outcome: OwnerOutcome, o: { serious?: number; why?: string }): boolean {
    const root = rootOf(rounds, key);
    for (const k of groupOf(rounds, key)) if (rounds.changes[k]?.lines?.[outcome]) return false;
    const c = rounds.changes[root] ??= { rounds: [] };
    (c.lines ??= {})[outcome] = { state: "owed", at: this.now().toISOString(), ...o };
    return true;
  }
  // Each owed line, through the link; marked sent only on its confirmation, tried again every tick until then.
  async postLines(): Promise<void> {
    const file = this.cfg.roundsFile;
    if (!file || !this.deps.postLine || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;
    for (const [key, c] of Object.entries(rounds.changes)) {
      for (const [outcome, l] of Object.entries(c.lines ?? {}) as [OwnerOutcome, NonNullable<typeof c.lines>[OwnerOutcome]][]) {
        if (!l || l.state !== "owed") continue;
        const topic = oneLine(purposeOf(rounds, key)?.topic ?? c.topic ?? "A change", 120);
        let msg: string | null = null;
        try { msg = await this.deps.postLine({ id: `${key}#${outcome}`, outcome, topic, ...(l.serious !== undefined ? { serious: l.serious } : {}), ...(l.why ? { why: l.why } : {}) }); }
        catch (e) { this.log(`the line to the owner for ${key} (${outcome}) didn't go: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
        const now = readRounds(file);
        const cur = now?.changes[key]?.lines?.[outcome];
        if (!now || !cur) continue;
        if (msg) Object.assign(cur, { state: "sent", message: msg });
        else cur.tries = (cur.tries ?? 0) + 1;
        writeRounds(file, now);
      }
    }
  }
  // A capped change with something serious left and no decision (no hold, no cut): one reminder to Cain after an
  // hour, in his relayed lines, and one line to the owner after a day saying it is still undecided.
  remind(): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;
    let changed = false;
    const now = this.now().getTime();
    for (const [key, c] of Object.entries(rounds.changes)) {
      const cap = c.capped;
      if (!cap || decisionOf(rounds, key) || cutOf(rounds, key) || heldOf(rounds, key)) continue;
      const age = now - Date.parse(cap.at);
      if (age >= REMIND_MS && !cap.reminded) {
        cap.reminded = this.now().toISOString(); changed = true;
        this.relay(`${key} reached its review cap an hour ago with ${cap.serious} serious finding${cap.serious === 1 ? "" : "s"} left and is still undecided. By the owner's rule decide now: review.sh decide ${key} hold "<why, in one line>", or cut those parts and submit one cut check. Nothing to tell him.`);
      }
      if (age >= UNDECIDED_MS && this.owe(rounds, key, "undecided", { serious: cap.serious })) changed = true;
    }
    // Round 2 fixes: every non-terminal state after a cut decision has a deadline. A cut decided with no cut check
    // yet, or a cut check with no result (its seat in transport retry, or not answering), gets one reminder to Cain
    // after an hour and, after a day, the change is held with the owner's one "the cut could not be checked" line.
    for (const [key, c] of Object.entries(rounds.changes)) {
      if (rootOf(rounds, key) !== key || heldOf(rounds, key)) continue;
      const dec = decisionOf(rounds, key), cut = cutOf(rounds, key);
      if (cut ? cut.state !== "started" : dec?.choice !== "cut") continue;
      const since = Date.parse(cut?.at ?? dec!.at);
      if (!Number.isFinite(since)) continue;
      const age = now - since;
      if (age >= UNDECIDED_MS) {
        this.holdUnchecked(rounds, key, cut ? "its cut check had no result a day after it was submitted" : "no cut check came a day after the decision to cut");
        changed = true;
      } else if (age >= REMIND_MS && !c.cut_reminded) {
        c.cut_reminded = this.now().toISOString(); changed = true;
        this.relay(cut
          ? `${key}'s cut check ${cut.id} has no result an hour on (${(cut.attempts ?? []).length} attempt${(cut.attempts ?? []).length === 1 ? "" : "s"} with no answer). It keeps trying; a day after it was submitted the change is held and he hears that the cut could not be checked. Nothing to tell him.`
          : `${key} was decided to be cut an hour ago and has no cut check yet. Cut those parts through Build and submit its one cut check; a day after the decision it is held and he hears that the cut could not be checked. Nothing to tell him.`);
      }
    }
    if (changed) writeRounds(file, rounds);
  }
  // The change held by the runner (round 2 fixes): its cut could not be checked. Final: no later cut or decision is
  // kept (rounds.ts admitCut, decideWhy), its cut check if any is lost, and the owner hears one line.
  holdUnchecked(rounds: Rounds, key: string, why: string): void {
    const root = rootOf(rounds, key);
    if (heldOf(rounds, key)) return;
    (rounds.changes[root] ??= { rounds: [] }).held = { at: this.now().toISOString(), why: `the cut could not be checked: ${why}` };
    const cut = cutOf(rounds, key);
    if (cut && cut.state === "started") rounds.changes[cut.key].cut!.state = "lost";
    this.owe(rounds, key, "unchecked", {});
    this.log(`${key} is held: the cut could not be checked (${why})`);
    this.relay(`${key} is held: the cut could not be checked (${why}). He hears one line saying so, from the link; no later cut or decision is kept. Nothing to tell him.`);
  }
  // One transport attempt of a cut check (round 2 fixes), kept under the change in the rounds file. Returns how many
  // there have been, or null when the rounds file can't be read (then the check waits: nothing is sent unrecorded).
  private noteCutAttempt(r: Review, kind: string, detail: string): number | null {
    const file = this.cfg.roundsFile;
    const at = { at: this.now().toISOString(), kind, detail: oneLine(detail, 160) };
    (r.cut_attempts ??= []).push(at);
    if (!file || !r.change) return r.cut_attempts.length;
    const rounds = readRounds(file);
    if (!rounds) return null;
    const c = rounds.changes[r.change]?.cut;
    if (c?.id === r.id) {
      (c.attempts ??= []).push(at);
      if (c.attempts.length >= CUT_TRANSPORT_MAX) {
        r.cut_unchecked = `its seat gave no answer in ${c.attempts.length} tries (the last: ${at.kind}, ${at.detail})`;
        this.holdUnchecked(rounds, r.change, r.cut_unchecked);
      }
      writeRounds(file, rounds);
      return c.attempts.length;
    }
    return r.cut_attempts.length;
  }
  // Cain's decision at the cap (review.sh decide), from his inbox: a ".decision" file of his, {change, choice, why}.
  // Kept only for a change at its cap whose last round left something serious and that has no decision or cut
  // check yet. A hold owes the owner's one "held: <why>" line. Each file is taken once and removed.
  ingestDecisions(): void {
    const dir = this.cfg.inboxDir, file = this.cfg.roundsFile;
    if (!dir || !file) return;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".decision") && !n.startsWith(".")).sort(); }
    catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const got = readOwned(path, this.cfg.inboxUid ?? CAIN_UID, 8 * 1024);
      try { unlinkSync(path); } catch { /* already gone */ }
      const said = (why: string) => this.relay(`A decision in the review inbox (${name.slice(0, 80)}) wasn't kept: ${why} Nothing to tell him.`);
      if (!got.ok) { said(`${got.why}.`); continue; }
      let d: any;
      try { d = JSON.parse(got.text); } catch { said("it isn't JSON."); continue; }
      const v = checkDecision(d);
      if (typeof v === "string") { said(v); continue; }
      if (this.capOff) { said(`the review cap's files aren't right (${this.capOff}).`); continue; }
      const rounds = readRounds(file);
      if (!rounds) { said("the review rounds file can't be read; decide again in a minute."); continue; }
      const why = decideWhy(rounds, v.change, this.roundCap);
      if (why) { said(why); continue; }
      const root = rootOf(rounds, v.change);
      (rounds.changes[root] ??= { rounds: [] }).decided = { choice: v.choice, at: this.now().toISOString(), ...(v.why ? { why: v.why } : {}) };
      if (v.choice === "hold") this.owe(rounds, v.change, "held", { why: v.why });
      writeRounds(file, rounds);
      this.relay(`Decision kept: ${v.change} is ${v.choice === "hold" ? "held; he hears one line saying so, from the link" : "to be cut: cut those parts through Build and submit one cut check"}. Nothing to tell him.`);
    }
  }

  private async reviews(): Promise<void> {
    mkdirSync(this.cfg.queueDir, { recursive: true });
    for (const name of readdirSync(this.cfg.queueDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const r = loadReview(this.cfg.queueDir, name.slice(0, -5));
      if (!r) continue;
      // While stopped, an open review waits where it is: nothing is sent, nothing is given
      // up. Asked again for each review, since a seat's call can take minutes.
      if (!FINAL.includes(r.status) && this.isStopped()) continue;
      try {
        if (FINAL.includes(r.status)) {
          // Saved only when after() changed it (recorded, relayed, or blocked at the record gate).
          const before = JSON.stringify(r);
          this.after(r);
          if (JSON.stringify(r) !== before) { r.updated_at = this.now().toISOString(); saveReview(this.cfg.queueDir, r); }
          continue;
        }
        // A tick finishes every call it starts, so "running" here means the add-on
        // restarted mid-call: that try counts, and the seat goes back in line.
        for (const s of r.seats) if (s.state === "running") {
          s.state = "queued";
          s.error = { kind: "transient", detail: "interrupted by a restart", fix: fixFor(s.seat, "transient") };
          s.next_at = new Date(this.now().getTime() + backoffMs(Math.max(1, s.attempts), this.rand)).toISOString();
          // A cut check's seat is tried again however often (round 1 fixes): a restart never uses up the check.
          if (s.attempts > retryLimit("transient") && r.kind !== CUT_CHECK) { s.state = "failed"; delete s.next_at; s.finished_at = this.now().toISOString(); }
        }
        if (r.seats.some((s) => s.state === "failed" && s.error?.detail === "interrupted by a restart")) this.substitute(r);
        await this.advance(r);
      } catch (e) { this.log(`review ${shownId(r)}: ${(e as Error).message}`); }
      r.updated_at = this.now().toISOString();
      saveReview(this.cfg.queueDir, r);
    }
  }

  async advance(r: Review): Promise<void> {
    // A queued brief is read back from disk, so it is checked again in full: the
    // allowlist (an old or edited brief with any other field is refused, not
    // sent), the id (safe, and the brief's own), then the terms. No brief at all
    // on an open review is refused too.
    const g = reviewCheck(r, this.terms());
    if (!g.ok) return this.block(r, g.why);
    // Round 2 fixes: a cut check of a change held meanwhile (its cut could not be checked) ends here, sending nothing.
    if (r.kind === CUT_CHECK && r.change && this.cfg.roundsFile) {
      const rounds = readRounds(this.cfg.roundsFile);
      const h = rounds ? heldOf(rounds, r.change) : null;
      if (h) { r.cut_unchecked ??= h.why.replace(/^the cut could not be checked: /, ""); for (const s of r.seats) if (s.state === "queued") s.state = "failed"; this.finish(r, "incomplete"); return; }
    }
    // A cut check (round 1 fixes): its diff derived through git first, once; the same diff on every later try.
    if (r.kind === CUT_CHECK && !(await this.prepareCut(r))) return;
    // Round 2 fixes: round 1 of a pull request reads its description once, for the purpose record.
    if (r.round === 1 && r.kind !== CUT_CHECK && r.brief?.pr && r.what_changed === undefined) await this.readWhatChanged(r);
    const e = earlierCheck(r.round_kind === "fixes" ? r.earlier
      : r.kind === CUT_CHECK ? [...(r.earlier ?? []), r.purpose ?? "", ...(r.cut_essentials ?? []), r.cut_diff ?? "", r.cut_context ?? ""] : undefined, this.terms());
    if (!e.ok) return this.block(r, e.why);
    for (let pass = 0; pass < 4; pass++) {
      if (this.isStopped()) break;                       // Stop between passes: the rest waits
      const now = this.now().toISOString();
      const due = r.seats.filter((s) => this.isDue(r, s, now));
      if (due.length === 0) break;
      r.status = "running";
      await Promise.all(due.map((s) => this.runSeat(r, s)));
      this.substitute(r);
    }
    // Round 2 fixes: a round never settles unsorted because of a Stop: it waits, and sorts once nothing is stopped.
    if (this.settlesNow(r) && !r.sorted) { if (this.isStopped()) return; await this.sortPass(r); }
    this.settle(r);
  }

  // The cut diff, from the last-reviewed head to the cut head, through git (cutdiff.ts). true: the check may go on
  // to its seat. Round 2 fixes: a git failure before dispatch is a transport attempt (kept under the change, at most
  // CUT_TRANSPORT_MAX, then the change is held: the cut could not be checked); a cut head that doesn't descend from the
  // last-reviewed head is refused (not consumed); a diff that adds code, a missing purpose record or too few essential
  // behaviours fail the check with no seat asked; a judge whose model wrote any commit of the cut is refused, and with
  // no judge left the cut could not be checked.
  private async prepareCut(r: Review): Promise<boolean> {
    if (r.cut_diff !== undefined) return true;
    if (r.cut_next && this.now().toISOString() < r.cut_next) { r.status = "queued"; return false; }
    const fn = this.deps.cutDiff ?? (this.cfg.cutRepo && this.cfg.cutRemote ? gitCutDiff({ repo: this.cfg.cutRepo, remote: this.cfg.cutRemote, token: this.cfg.githubToken }) : null);
    const b = r.brief!;
    if (!fn || !r.cut_base || !b.pr || !b.head) {
      r.cut_refused = !fn ? "the runner has no copy of the repository to derive the cut diff from" : "the cut check names no last-reviewed head or cut head";
      this.finish(r, "incomplete");
      return false;
    }
    const wait = (kind: string, why: string): false => {
      const n = this.noteCutAttempt(r, kind, why);
      if (r.cut_unchecked) { this.finish(r, "incomplete"); return false; }
      r.cut_tries = n ?? (r.cut_tries ?? 0) + 1;
      r.cut_next = new Date(this.now().getTime() + Math.min(3_600_000, backoffMs(r.cut_tries, this.rand))).toISOString();
      r.status = "queued";
      this.log(`cut check ${shownId(r)}: ${why}; tried again with the same heads, nothing used up`);
      return false;
    };
    // The purpose record, frozen at round 1; for a change past round 1 when records began, built now from the pull
    // request's description only, and kept, saying so.
    const file = this.cfg.roundsFile;
    let purpose: PurposeRec | null = null;
    if (file && r.change) {
      const rounds = readRounds(file);
      if (!rounds) return wait("rounds", "the rounds file can't be read");
      purpose = purposeOf(rounds, r.change);
      if (purpose && !purpose.frozen) {
        const got = await this.prBody()(b.pr);
        if (!got.ok) return wait("github", `the pull request's description couldn't be read (${got.why})`);
        const fresh = readRounds(file);
        if (!fresh) return wait("rounds", "the rounds file can't be read");
        const first = countedRounds(fresh, r.change)[0];
        const k = first?.key ?? r.change;
        purpose = { topic: purpose.topic, question: purpose.question, what_changed: whatChangedOpening(got.body), statements: [], source: "description only", frozen: this.now().toISOString() };
        (fresh.changes[k] ??= { rounds: [] }).purpose = purpose;
        writeRounds(file, fresh);
      }
    }
    const got = await fn({ pr: b.pr, base: r.cut_base, head: b.head });
    if (!got.ok && got.kind === "infra") return wait("git", `the cut diff couldn't be derived (${got.why})`);
    if (!got.ok) { r.cut_refused = got.why; this.finish(r, "incomplete"); return false; }
    delete r.cut_next;
    r.cut_diff = got.diff;
    r.cut_context = got.context ?? "";
    if (got.headFiles) r.cut_head_files = got.headFiles;
    r.purpose = purposeText(purpose);
    r.cut_essentials = essentialsOf(purpose);
    if (!got.judged.ok) { r.cut_added = got.judged.why; this.finish(r, "incomplete"); return false; }
    if (!purpose) { r.cut_added = "the change has no purpose record, so what the cut must keep can't be checked"; this.finish(r, "incomplete"); return false; }
    if (r.cut_essentials.length < MIN_ESSENTIALS)
      { r.cut_added = `the change's purpose record gives ${r.cut_essentials.length} essential behaviour${r.cut_essentials.length === 1 ? "" : "s"}, fewer than the ${MIN_ESSENTIALS} a cut check needs`; this.finish(r, "incomplete"); return false; }
    if (!got.headFiles) { r.cut_added = "the cut head's files couldn't be listed, so the judge's evidence can't be checked"; this.finish(r, "incomplete"); return false; }
    // The judge's independence, from the commit authorship the runner reads itself: the chosen seat, or the other
    // outside judge, whose model family is named in no commit of the cut range.
    if (!got.commits) return this.unchecked(r, "the cut's commits couldn't be read, so the judge's independence can't be checked");
    const chosen = r.seats[0]?.seat;
    const order = [chosen, ...CUT_SEATS.filter((x) => x !== chosen)].filter((x): x is SeatName => !!x && CUT_SEATS.includes(x));
    const wrote = order.map((x) => ({ seat: x, line: wroteCut(x, got.commits!) }));
    const ok = wrote.find((x) => !x.line && !this.unavailable(x.seat)) ?? wrote.find((x) => !x.line);
    if (!ok) return this.unchecked(r, `every outside judge's model is named in the cut's commits (${wrote.map((x) => `${LABEL[x.seat]}: ${x.line}`).join("; ")})`);
    if (ok.seat !== chosen) {
      r.cut_refused_seats = wrote.filter((x) => x.line).map((x) => ({ seat: x.seat, line: x.line! }));
      r.seats = [seatRun(ok.seat, "reviewer")];
      if (file && r.change) {
        const rounds = readRounds(file);
        const c = rounds?.changes[r.change]?.cut;
        if (rounds && c?.id === r.id) { c.seat = ok.seat; writeRounds(file, rounds); }
      }
      this.log(`cut check ${shownId(r)}: ${LABEL[chosen!]} is refused as its judge (its model is named in the cut's commits); ${LABEL[ok.seat]} judges it`);
    }
    return true;
  }
  // The cut could not be checked (round 2 fixes): the change is held, the owner hears one line, nothing is sent.
  private unchecked(r: Review, why: string): false {
    r.cut_unchecked = why;
    const file = this.cfg.roundsFile;
    const rounds = file ? readRounds(file) : null;
    if (rounds && r.change) { this.holdUnchecked(rounds, r.change, why); writeRounds(file!, rounds); }
    for (const s of r.seats) if (s.state === "queued") s.state = "failed";
    this.finish(r, "incomplete");
    return false;
  }
  // The pull request's description: the dep, or GitHub's API only where the runner is set up to reach GitHub (cutRemote).
  private prBody(): (pr: string) => Promise<{ ok: true; body: string } | { ok: false; why: string }> {
    return this.deps.prBody ?? (this.cfg.cutRemote ? githubPrBody(this.cfg.githubToken) : async () => ({ ok: false, why: "the runner has no way to reach GitHub" }));
  }
  // Round 1's read of the pull request description (round 2 fixes): its "What changed" opening, or null when it
  // can't be read (the record says so; the seats' statements still stand).
  private async readWhatChanged(r: Review): Promise<void> {
    const got = await this.prBody()(r.brief!.pr!).catch(() => ({ ok: false as const, why: "error" }));
    r.what_changed = got.ok ? whatChangedOpening(got.body) : null;
    if (!got.ok) this.log(`review ${shownId(r)}: the pull request's description couldn't be read for the purpose record (${got.why})`);
  }

  // Whether settle() would finish the review now (the seats are through and it waits for none).
  private settlesNow(r: Review): boolean {
    if (r.seats.some((s) => s.state === "queued" || s.state === "running")) return false;
    if (!r.consequential) return true;
    return independent(r).length >= 2 || !(r.wait_until && this.now().toISOString() < r.wait_until);
  }

  // The sorting step (0.20.0), once, at the cap's last round. Round 1 fixes: every finding of the round, whatever
  // its own seat labelled it (so a seat that labels all its own findings follow-up hides none), goes to each
  // outside seat that answered as itself (never Claude, never a stand-in), its own findings included, so the
  // raiser can reaffirm one. isSerious (core.ts) then counts: a finding any seat labels serious stays serious
  // unless every other outside seat that sorted it labelled it follow-up naming a valid arm. One it can't sort (a
  // seat down, over a cap, Stop, the privacy backstop) stays as labelled. Not a new round: the same round's work.
  async sortPass(r: Review): Promise<void> {
    r.sorted = true;
    if (r.kind === CUT_CHECK || !r.change || !r.round || !r.cap || r.round < r.cap || !r.brief) return;
    const raised = allRaised(r).slice(0, 40);
    if (!raised.length) return;
    // Round 2 fixes: the panel is fixed here, before anything is sent: every outside seat of the round that is not a
    // Claude stand-in, whatever its review did. A panel seat that gives no valid sort votes serious (core.ts isSerious).
    const panel = panelOf(r);
    r.sort_panel = panel;
    const failed = new Set<string>(panel);
    const sorts: SortRec[] = [];
    const done = () => { r.sorts = sorts; r.sort_failed = panel.filter((k) => failed.has(k)); };
    const text = raised.map((x) => `[${x.f.severity ?? "serious"}${x.f.arm ? `: ${oneLine(x.f.arm, 80)}` : ""}] ${oneLine(x.f.problem, 600)} (its fix: ${oneLine(x.f.fix, 300)})`);
    const g = earlierCheck(text, this.terms());
    if (!g.ok) { this.log(`review ${shownId(r)}: the sorting step sent nothing: the findings matched the privacy backstop; every finding counts as serious`); return done(); }
    for (const key of panel) {
      const by = r.seats.find((z) => z.key === key);
      if (!by) continue;
      if (this.isStopped()) break;
      const fn = this.fnFor(by.seat);
      const out = sortOutbound(r.brief, text);
      const down = this.unavailable(by.seat) ?? this.capCheck(by.seat, out, r.cost_usd);
      if (down || !fn) { this.log(`review ${shownId(r)}: no sorting step from ${LABEL[by.seat]} (${down?.detail ?? "not set up"}); it votes serious on every finding`); continue; }
      const ms = this.cfg.timeoutS[by.seat] * 1000;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const a = await Promise.race([fn({ brief: out, role: "reviewer", signal: ctl.signal, maxOutputTokens: this.cfg.maxOut[by.seat], day: this.day() }),
          new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SeatError("timeout", `no answer within ${ms / 1000} s`)); }, ms); })]);
        const cost = this.addSpend(by.seat, a.cost_usd, 0, a.searches ?? 0);
        by.cost_usd += cost; r.cost_usd += cost;
        const seen = new Set<number>();
        for (const raw of a.findings) {
          // "FOLLOW-UP (<arm>) [n]: why" as asked, or the number after the mark ("FOLLOW-UP (<arm>): [n] why").
          const whole = SORT_MARK.exec(raw.problem);
          const f: { severity?: "serious" | "follow-up"; arm?: string; problem: string } = whole
            ? { severity: /^serious$/i.test(whole[1]) ? "serious" : "follow-up", ...(whole[2] ? { arm: oneLine(whole[2], 80) } : {}), problem: `[${whole[3]}] ${raw.problem.slice(whole[0].length)}` }
            : readMark(raw);
          const m = /^\s*\[?\s*(\d{1,2})\s*\]?\s*[:.\-]?\s*/.exec(f.problem);
          const n = m ? Number(m[1]) : NaN;
          if (!f.severity || !Number.isInteger(n) || n < 1 || n > raised.length || seen.has(n)) continue;
          seen.add(n);
          const reason = oneLine(f.problem.slice(m![0].length), 600);
          const x = raised[n - 1];
          sorts.push({ by: by.key, ref: findingRef(x.seat, x.i), label: f.severity, ...(f.arm ? { arm: f.arm } : {}), reason });
        }
        if (seen.size) failed.delete(key);
        else this.log(`review ${shownId(r)}: the sorting step from ${LABEL[by.seat]} gave no label that could be read; it votes serious on every finding`);
      } catch (e) {
        const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
        if (err.cost_usd) { const c = this.addSpend(by.seat, err.cost_usd, 0); by.cost_usd += c; r.cost_usd += c; }
        else if (by.seat === "openai") this.addSpend("openai", 0, 0);
        this.log(`review ${shownId(r)}: the sorting step from ${LABEL[by.seat]} failed (${err.kind}); it votes serious on every finding`);
      } finally { clearTimeout(timer); }
    }
    done();
  }

  private isDue(r: Review, s: SeatRun, now: string): boolean {
    if (s.state === "queued") return !s.next_at || s.next_at <= now;
    // Hourly retries: only a consequential review's judges, while it may still wait.
    return ["failed", "substituted", "blocked"].includes(s.state) && !!s.next_at && s.next_at <= now
      && r.consequential && JUDGES.includes(s.seat) && !s.stands_in_for;
  }

  async runSeat(r: Review, s: SeatRun): Promise<void> {
    const hourly = s.state !== "queued";
    const fn = this.fnFor(s.seat);
    const b = r.brief!;
    const out = outbound(b, r.kind === CUT_CHECK ? { earlier: r.earlier ?? [], check: "cut", purpose: r.purpose ?? "", diff: r.cut_diff ?? "",
      essentials: r.cut_essentials ?? [], context: r.cut_context ?? "" }
      : r.round_kind === "fixes" ? { earlier: r.earlier ?? [] } : undefined);   // throws on a wrong kind: nothing is sent
    // Round 2 fixes: round 1 asks each outside seat for its own statement of what the piece must do.
    const asksPurpose = r.round === 1 && !!r.change && r.kind !== CUT_CHECK && r.round_kind !== "fixes" && s.counts && s.seat !== "claude";
    if (asksPurpose) out.purpose_ask = true;
    const down = this.unavailable(s.seat) ?? this.capCheck(s.seat, out, r.cost_usd);
    if (down || !fn) return this.fail(r, s, down?.kind ?? "unconfigured", down?.detail ?? "not set up", hourly, 0);
    let began = false;
    s.started_at = this.now().toISOString();
    s.attempts++;
    const prev = s.state;
    s.state = "running";
    saveReview(this.cfg.queueDir, r);
    const ms = this.cfg.timeoutS[s.seat] * 1000;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SeatError("timeout", `no answer within ${ms / 1000} s`)); }, ms); });
    try {
      const a = await Promise.race([fn({ brief: out, role: s.role, signal: ctl.signal, maxOutputTokens: this.cfg.maxOut[s.seat], day: this.day(),
        onBody: () => { began = true; } }), deadline]);
      if (asksPurpose) {
        const isPurpose = (f: { problem: string }) => /^\s*[*_]*\s*purpose\s*[*_]*\s*:/i.test(String(f.problem ?? ""));
        const stated = a.findings.find(isPurpose);
        if (stated) s.purpose = oneLine(String(stated.problem).replace(/^\s*[*_]*\s*purpose\s*[*_]*\s*:\s*/i, ""), 1_200);
        a.findings = a.findings.filter((f) => !isPurpose(f)).map((f, i) => ({ ...f, rank: i + 1 }));
      }
      const cost = this.addSpend(s.seat, a.cost_usd, a.findings.length, a.searches ?? 0);
      // A finding a seat didn't label by the rule's test counts as serious, in every round (0.20.0): it fails safe.
      // Round 1 fixes: how many carried a valid label is kept, per seat and round, for review.sh health.
      const marked = a.findings.map((f) => readMark(f));
      const labels = { labelled: marked.filter((m) => !!m.severity).length, total: marked.length };
      a.findings = marked.map((m) => m.severity ? m : { ...m, severity: "serious" as const });
      Object.assign(s, { state: "done", verdict: a.verdict, findings: a.findings, model: a.model, tokens: a.tokens,
        cost_usd: s.cost_usd + cost, finished_at: this.now().toISOString(), labels });
      this.noteLabels(s.seat, r, labels);
      delete s.error; delete s.next_at;
      r.cost_usd += cost;
      this.markHealth(s.seat, null, true);
    } catch (e) {
      const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
      if (err.cost_usd) { const c = this.addSpend(s.seat, err.cost_usd, 0); s.cost_usd += c; r.cost_usd += c; }
      else if (s.seat === "openai") this.addSpend("openai", 0, 0);   // a Codex run counts against the run cap either way
      s.state = prev;
      // A cut check (round 2 fixes): an answer that began (any response came back), or one that came back unreadable or
      // refused, is the check's answer, and it fails; only no response at all is a transport failure.
      this.fail(r, s, err.kind, err.message, hourly, s.attempts, r.kind === CUT_CHECK && (began || err.body || err.kind === "bad_output" || err.kind === "refused"));
    } finally { clearTimeout(timer); }
  }

  private fail(r: Review, s: SeatRun, kind: ErrorKind, detail: string, hourly: boolean, attempts: number, terminal = false) {
    const now = this.now();
    s.error = { kind, detail, fix: fixFor(s.seat, kind, detail) };
    // A cut check's seat (round 2 fixes). Only a transport failure (no response at all: the seat down, unreachable or
    // over a cap, a timeout before any response) is tried again, never with a stand-in, each attempt kept under the
    // change; after CUT_TRANSPORT_MAX the change is held (the cut could not be checked). Anything the seat answered
    // that isn't a clear pass (unreadable, partial, refused, cut off after it began) uses the check up, and it fails.
    if (r.kind === CUT_CHECK) {
      if (["auth", "credit", "unconfigured"].includes(kind)) this.markHealth(s.seat, s.error, true);
      if (terminal) {
        s.state = "failed"; delete s.next_at; s.finished_at = now.toISOString();
        r.cut_terminal = `${LABEL[s.seat]} answered, but not with a clear pass (${kind}: ${oneLine(detail, 120)})`;
        return;
      }
      const n = this.noteCutAttempt(r, kind, detail);
      if (r.cut_unchecked) { s.state = "failed"; delete s.next_at; s.finished_at = now.toISOString(); return; }
      s.state = "queued";
      s.next_at = new Date(now.getTime() + Math.min(3_600_000, backoffMs(Math.max(1, n ?? attempts), this.rand))).toISOString();
      return;
    }
    if (!hourly && attempts > 0 && attempts <= retryLimit(kind)) {
      s.state = "queued";
      s.next_at = new Date(now.getTime() + backoffMs(attempts, this.rand)).toISOString();
      return;
    }
    if (!hourly) s.state = kind === "cap" ? "blocked" : "failed";
    s.finished_at = now.toISOString();
    delete s.next_at;
    if (r.consequential && JUDGES.includes(s.seat) && !s.stands_in_for && r.wait_until && now.toISOString() < r.wait_until)
      s.next_at = new Date(now.getTime() + this.cfg.hourlyS * 1000).toISOString();
    if (["auth", "credit", "unconfigured"].includes(kind)) this.markHealth(s.seat, s.error, true);
  }

  // A stand-in only when a seat is down, once per seat, and only from Claude.
  substitute(r: Review) {
    if (r.kind === CUT_CHECK) return;   // a cut check is one outside seat's: never a Claude stand-in (0.20.0)
    for (const s of [...r.seats]) {
      if (s.seat === "claude" || !(s.state === "failed" || s.state === "blocked")) continue;
      if (r.seats.some((x) => x.stands_in_for === s.seat)) continue;
      if (this.unavailable("claude")) continue;
      if (s.state === "failed") s.state = "substituted";
      r.seats.push(seatRun("claude", s.seat === "perplexity" ? "facts-stand-in" : "stand-in", s.seat));
      this.log(`review ${shownId(r)}: ${LABEL[s.seat]} is down (${s.error?.kind}); Claude stands in, marked substituted`);
    }
  }

  settle(r: Review) {
    const now = this.now().toISOString();
    if (r.seats.some((s) => s.state === "queued" || s.state === "running")) {
      r.status = r.seats.some((s) => s.attempts > 0) ? "running" : "queued";
      return;
    }
    if (r.consequential) {
      if (independent(r).length >= 2) return this.finish(r, "done");
      if (r.wait_until && now < r.wait_until) {
        r.status = "waiting for seats";
        for (const s of r.seats) if (JUDGES.includes(s.seat) && !s.stands_in_for && s.state !== "done" && !s.next_at)
          s.next_at = new Date(this.now().getTime() + this.cfg.hourlyS * 1000).toISOString();
        return;
      }
      return this.finish(r, "incomplete");
    }
    this.finish(r, r.seats.some((s) => s.state === "done") ? "done" : "incomplete");
  }

  private finish(r: Review, status: "done" | "incomplete") {
    r.status = status;
    r.finished_at = this.now().toISOString();
    for (const s of r.seats) delete s.next_at;
    this.after(r);
    this.log(`review ${shownId(r)}: ${status}`);
  }

  // Record first, then Cain's one line. Each happens once, even across restarts. Its
  // Reviewed line is published before he hears it, so a Ship card naming the review finds it:
  // while publishing fails he hears nothing yet, and the next tick tries both again (a final
  // review is looked at on every tick until it's relayed).
  private after(r: Review) {
    this.settleRound(r);
    if (!r.recorded && r.brief && (r.status === "done" || r.status === "incomplete")) {
      // The same gate again before anything reaches the record: a review read
      // back as final may never have passed it, or the list may have grown.
      const g = reviewCheck(r, this.terms());
      if (!g.ok) return this.block(r, g.why);
      const req = recordRequest(r);
      const stamp = this.now().toISOString().replace(/[-:]/g, "").slice(0, 15);
      writeAtomic(join(this.cfg.recordQueue, `${stamp}-${req.id}.json`), JSON.stringify(req));
      r.recorded = true;
      r.record_dir = req.ops[0].path.split("/").slice(0, 2).join("/");
    }
    if (!r.relayed) {
      if (sayLine(r) && !this.publishReviewed(r)) return;
      this.relay(relayLine(r));
      r.relayed = true;
    }
  }

  block(r: Review, why: string[]) {
    // Never sent, never recorded: the brief itself is dropped from the queue too.
    markBlocked(r, why, this.now().toISOString());
    this.log(`review ${shownId(r)}: blocked: privacy (${why.join("; ")})`);
    this.after(r);
  }

  // ---- seat health ----
  // Round 1 fixes: a seat's label count for one round, kept in the health file (the newest LABEL_ROWS per seat).
  noteLabels(seat: SeatName, r: Review, l: { labelled: number; total: number }) {
    try {
      const h = this.health();
      const rows = ((h.labels ??= {})[seat] ??= []).filter((x) => x.id !== r.id);
      rows.push({ id: r.id, ...(r.round ? { round: r.round } : {}), labelled: l.labelled, total: l.total, at: this.now().toISOString() });
      h.labels[seat] = rows.slice(-LABEL_ROWS);
      writeAtomic(this.cfg.healthFile, JSON.stringify(h, null, 1));
    } catch (e) { this.log(`couldn't keep ${LABEL[seat]}'s label count: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
  }
  markHealth(seat: SeatName, err: { kind: ErrorKind; detail: string; fix: string } | null, quiet: boolean) {
    const h = this.health();
    const prev = h[seat];
    const at = this.now().toISOString();
    h[seat] = err ? { ok: false, at, kind: err.kind, detail: err.detail, fix: err.fix } : { ok: true, at };
    writeAtomic(this.cfg.healthFile, JSON.stringify(h, null, 1));
    if (quiet) return;
    // Reported once per failure, with the fix; again only if the reason changes.
    if (err && (!prev || prev.ok || prev.kind !== err.kind))
      this.relay(`Review seat ${LABEL[seat]} failed its nightly check (${err.kind}): ${err.fix}.`);
    else if (!err && prev && !prev.ok) this.relay(`Review seat ${LABEL[seat]} passed its nightly check again.`);
  }

  async selftest(): Promise<Health> {
    // Not done, so it's tried again within the hour, and runs once he turns it back on.
    for (const seat of SEATS) {
      if (this.isStopped()) throw new Error("everything is stopped, so no seat is called");
      const down = this.unavailable(seat) ?? this.capCheck(seat, SELFTEST, 0, true);
      if (down) { this.markHealth(seat, { ...down, fix: fixFor(seat, down.kind, down.detail) }, false); continue; }
      const ctl = new AbortController();
      const ms = Math.min(this.cfg.timeoutS[seat], 300) * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const a = await Promise.race([
          this.fnFor(seat)!({ brief: outbound(SELFTEST), role: "reviewer", signal: ctl.signal, maxOutputTokens: 2_048, day: this.day(), selftest: true }),
          new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SeatError("timeout", "no answer in time")); }, ms); }),
        ]);
        this.addSpend(seat, a.cost_usd, 0);
        this.markHealth(seat, null, false);
      } catch (e) {
        const err = e instanceof SeatError ? e : new SeatError("transient", String(e).slice(0, 200));
        this.addSpend(seat, err.cost_usd, 0);
        this.markHealth(seat, { kind: err.kind, detail: err.message, fix: fixFor(seat, err.kind, err.message) }, false);
      } finally { clearTimeout(timer); }
    }
    return this.health();
  }
}

export function existsReview(dir: string, id: string): boolean { return existsSync(reviewFile(dir, id)); }
