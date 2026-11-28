// The review runner: one record per review in /data/review-queue, moved forward
// one tick at a time. Seats run independently and in parallel; a down seat is
// retried with backoff, then stood in for by Claude (marked substituted, never
// counted as independent); a consequential review waits for two non-Claude
// families, retrying hourly for up to a day. Every step re-runs the privacy gate.
// Each finished review's Reviewed line is published to /data/trust/reviewed.json
// (../reviewed.ts) before Cain hears it's done, and the file is rebuilt from the queue
// at start, so it survives a restart.
import { appendFileSync, chmodSync, chownSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAIN_UID, readOwned } from "../owned.ts";
import { keptReviewed, type Reviewed, writeReviewed } from "../reviewed.ts";
import {
  FINAL, JUDGES, LABEL, SEATS, SeatError, backoffMs, checkBrief, payloadCheck, readMark, estimate, fixFor, independent, markBlocked, oneLine, outbound, recordRequest,
  newReview, parseBrief, relayLine, reviewCheck, safeId, sayLine, seatName, seriousLeft, shownId, retryLimit, seatRun, type Brief, type ErrorKind, type Outbound, type Review, type SeatName, type SeatRun, type Finding,
} from "./core.ts";
import type { SeatFn } from "./seats/common.ts";
import { DEFAULT_ROUND_CAP, addRound, admit, countedRounds, decisionOf, readRounds, writeRounds, type DecisionRec, type Rounds } from "./rounds.ts";
import { effectiveCap, readGrants, type Grants } from "./grants.ts";
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
  // Cain 0.18.0: the owner's grants of extra rounds (grants.ts), written by the link on his tap only.
  // Absent: no grants count.
  grantsFile?: string;
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
};

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
export type Health = Partial<Record<SeatName, { ok: boolean; at: string; kind?: ErrorKind; detail?: string; fix?: string }>>;

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
// The enqueue lock (Cain 0.19.4): a brief's id is checked against the queue and the rounds record, and its
// round and queue record written, while this file is held (an exclusive create). One older than a minute is
// left by a runner that stopped mid-enqueue and is taken over (removed, then the exclusive create again, so
// one contender wins).
export const MAX_EARLIER = 30;
export const ENQUEUE_LOCK = ".enqueue.lock";
export const ENQUEUE_STALE_MS = 60_000;
export const ENQUEUE_BUSY = "another brief is being queued just now, so this one wasn't: submit it again in a minute. Nothing was queued.";

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
  // so no brief is taken (fail closed) and no round is settled or decision card posted.
  capOff: string | null = null;
  admitAndQueue(given: Brief): string | null {
    // Only a brief's own fields go in (Cain 0.18.1): a brief carrying anything else, earlier findings
    // included, is refused whole, so the findings a fix-only round sends are only ever the ones the
    // runner loads itself from its own record of the change's previous round (earlierFindings).
    const c = checkBrief(given);
    if (!c.brief) return `not a brief: ${c.error}. Nothing was queued.`;
    return this.underEnqueueLock(() => this.admitLocked(c.brief!));
  }
  private underEnqueueLock(fn: () => string | null): string | null {
    mkdirSync(this.cfg.queueDir, { recursive: true });
    const lock = join(this.cfg.queueDir, ENQUEUE_LOCK);
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (e: any) {
      if (e?.code !== "EEXIST") return `the queue's enqueue lock can't be taken (${e?.code ?? "error"}), so no id can be checked: it's logged for a Build item. Nothing was queued.`;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= ENQUEUE_STALE_MS) return ENQUEUE_BUSY;
        unlinkSync(lock);
        fd = openSync(lock, "wx", 0o600);
        this.log("took over a stale enqueue lock left by a runner that stopped mid-enqueue");
      } catch { return ENQUEUE_BUSY; }
    }
    try { return fn(); }
    finally { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(lock); } catch { /* gone */ } }
  }
  // Under the enqueue lock. A round id is immutable (Cain 0.19.4): an id the queue already holds, or the rounds
  // record already keeps under any change (this one included), is refused, so a replay of a round resolves to
  // the original record and can alter neither the findings it sends nor the round it counts.
  private admitLocked(b: Brief): string | null {
    const queued = `refused: a review with the id ${b.id} is already queued, and it stands as it was: give this brief a new id. Nothing was queued.`;
    const file = this.cfg.roundsFile;
    if (!file) { if (existsReview(this.cfg.queueDir, b.id)) return queued; saveReview(this.cfg.queueDir, newReview(b, this.now())); return null; }
    if (this.capOff) return `the review cap's files aren't right (${this.capOff}), so no round can be counted: the App's alarm says so, and it's logged for a Build item. Nothing was queued.`;
    const rounds = readRounds(file);
    if (!rounds) return "the review rounds file (/data/review-rounds.json) can't be read, so no round can be counted: it's logged for a Build item. Nothing was queued.";
    const a = admit(rounds, b, this.roundCap, this.grants(), this.cfg.tz);
    if (!a.ok) return a.why;
    // A round id is one change's (Cain 0.18.1): an id already kept as a round of another change is refused,
    // so no round's record can stand for two changes and a fix-only round never reads another's findings.
    const same = rounds.changes[a.key]?.rounds.findIndex((x) => x.id === b.id) ?? -1;
    if (same >= 0) return `refused: the id ${b.id} is already a round of ${a.key}, and that round stands as it was (its findings and its count unchanged): give this round a new id. Nothing was queued.`;
    const other = Object.entries(rounds.changes).find(([k, c]) => k !== a.key && c.rounds.some((x) => x.id === b.id));
    if (other) return `refused: the id ${b.id} is already a round of another change, so it can't be a round of ${a.key}: give this round a new id. Nothing was queued.`;
    if (existsReview(this.cfg.queueDir, b.id)) return queued;
    const label = labelOf(b.label)!;
    if (this.cfg.settingsFile && this.cfg.guardLog && this.cfg.spendFile) {
      const g = guard(label, `review ${b.id} (${a.key}, round ${a.round})`, { settingsFile: this.cfg.settingsFile, spendFile: this.cfg.spendFile,
        logFile: this.cfg.guardLog, tz: this.cfg.tz, now: this.now(), plan: this.deps.plan });
      if (!g.ok) return `held by the usage guard: it's labelled ${label}, and ${g.why}. Core, commitment and necessary-fix work still run; this is on the guard's log (review.sh guard). Nothing was queued.`;
    }
    const r = newReview(b, this.now());
    Object.assign(r, { change: a.key, round: a.round, cap: a.cap, round_kind: a.kind,
      ...(a.granted.length ? { granted: a.granted.map((g) => ({ rounds: g.rounds, at: g.at })), base_cap: this.roundCap } : {}) });
    if (a.kind === "fixes") r.earlier = this.earlierFindings(rounds, a.key);
    // The round is kept before the review is queued: a stop between the two counts a round that never
    // ran (fails safe), never runs one that wasn't counted.
    addRound(rounds, b, a, this.now().toISOString());
    writeRounds(file, rounds);
    saveReview(this.cfg.queueDir, r);
    return null;
  }
  // The findings of the change's latest round that answered, for a fix-only round to check the fixes against.
  // key: the admitted brief's validated change identity (admit, from changeKeyOf). Cain 0.19.4: the text comes
  // only from the seat answers the runner kept in the rounds record when each answer arrived (keepFindings), under
  // that round of this change's own key; the round's queue record is read only to bind it, its id and change being
  // that round's and it not blocked for privacy. Nothing in a queue record's findings, a brief or a request
  // reaches them.
  private earlierFindings(rounds: Rounds, key: string): string[] {
    const own = (rounds.changes[key]?.rounds ?? []).filter((x) => !x.blocked).sort((a, b) => a.at.localeCompare(b.at)).reverse();
    for (const x of own) {
      const prev = loadReview(this.cfg.queueDir, x.id);
      if (!prev || prev.id !== x.id || prev.change !== key || prev.status === "blocked: privacy") continue;
      const list = (Array.isArray(x.findings) ? x.findings : []).filter((f): f is string => typeof f === "string");
      if (list.length) return list.slice(0, MAX_EARLIER);
    }
    return [];
  }
  // A seat's answer's findings, kept in the rounds record under this round of its change as they arrive (Cain
  // 0.19.4): the only source a later fix-only round's earlier findings are built from. Read and written with no
  // wait between, so two seats answering in one pass don't lose each other's.
  private keepFindings(r: Review, s: SeatRun, findings: Finding[]): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !r.change || !r.round || !findings.length) return;
    const rounds = readRounds(file);
    if (!rounds) { this.log(`the rounds file can't be read; review ${shownId(r)}'s findings from ${LABEL[s.seat]} weren't kept for a later round`); return; }
    const rec = rounds.changes[r.change]?.rounds.find((x) => x.id === r.id);
    if (!rec) return;
    const lines = findings.map((f) => `${seatName(s)}${f.severity ? ` [${f.severity}]` : ""}: ${oneLine(f.problem, 400)}`);
    rec.findings = [...(rec.findings ?? []), ...lines].slice(0, MAX_EARLIER);
    writeRounds(file, rounds);
  }
  // A finished round, kept in the rounds file once: answered, or lost (no seat answered: it still counts);
  // a round blocked for privacy sent nothing and doesn't count. The cap's last round owes the owner one
  // decision card for the change when it left a serious finding, or when it was lost (round 2).
  private settleRound(r: Review): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !r.change || r.rounded || !FINAL.includes(r.status)) return;
    const rounds = readRounds(file);
    if (!rounds) { this.log(`the rounds file can't be read; review ${shownId(r)}'s round is settled next tick`); return; }
    this.heldOwed = [];                                // a line from an earlier try whose write failed is made again
    const rec = rounds.changes[r.change]?.rounds.find((x) => x.id === r.id);
    const serious = seriousLeft(r);
    if (rec) {
      rec.done = true;
      if (r.status === "blocked: privacy") rec.blocked = true;
      else rec.state = r.seats.some((s) => s.state === "done") ? "answered" : "lost";
      if (r.round_kind === "fixes" && rec.state === "answered") rec.serious = serious.length;
    }
    if (rec && !rec.blocked) {
      const b = r.brief;
      const c = rounds.changes[r.change];
      const base = { topic: oneLine(b?.topic ?? c.topic ?? r.change, 120), item: b?.item ?? null, pr: b?.pr ?? c.pr ?? null };
      if (rec.state === "lost") this.owe(rounds, r.change, { ...base, serious: 0, finding: "", lost: true }, `review ${shownId(r)}`);
      else if (r.round_kind === "fixes" && serious.length)
        this.owe(rounds, r.change, { ...base, serious: serious.length, finding: oneLine(serious[0].problem, 160) }, `review ${shownId(r)}`);
    }
    writeRounds(file, rounds);
    r.rounded = true;
    this.relayHeld();
  }
  // The owner's grants (0.18.0), read fresh each time; none count when the file can't be read (fail closed).
  grants(): Grants | null { return this.cfg.grantsFile ? readGrants(this.cfg.grantsFile) : null; }
  capFor(rounds: Rounds, key: string): number { return effectiveCap(this.roundCap, rounds, this.grants(), key); }
  // The hold at the cap (Cain 0.19.1: kept as the change's decision record, which refuses its Ship card;
  // no card goes to him). Before 0.19.1, the decision card, owed once per change group and round, when the group is at its cap (the base cap
  // plus his grants). Since 0.18.0 a granted round that leaves something serious at the raised cap owes
  // a new card, whatever he tapped on the one before (a Hold doesn't stop a granted round); the newest
  // decision is the one that counts, and the earlier one is kept under past.
  private owe(rounds: Rounds, key: string, d: Pick<DecisionRec, "topic" | "item" | "pr" | "serious" | "finding"> & { lost?: boolean }, what: string): void {
    const n = countedRounds(rounds, key).length;
    const prev = decisionOf(rounds, key);
    if (n < this.capFor(rounds, key) || (prev && prev.round >= n)) return;
    const c = rounds.changes[key];
    if (c.decision) (c.past ??= []).push(c.decision);
    c.decision = { id: `${key}#${n}`, key, round: n, ...d, ...(d.lost ? { lost: true } : {}), state: "owed", at: this.now().toISOString() };
    this.log(`${what}: the round cap is reached for ${key} ${d.lost ? "and its last round was lost" : `with ${d.serious} serious finding(s) left`}; held by the owner's review rule`);
    // Cain 0.19.1: no card to him (the owner's review rule, R-013): the change is held, and Cain tells him.
    // Relayed by the caller only after the rounds file holding the hold is written (heldOwed).
    this.heldOwed.push(`The review cap is reached for ${key}: ${d.lost ? "its last round was lost (it never produced a result)" : `its last round left ${d.serious} serious finding${d.serious === 1 ? "" : "s"}`}, so by his review rule it's held: no Ship card for it. Tell him in one line that it's held and why, with its Reviewed line, and ask him nothing about rounds, risk or cuts.`);
  }
  private heldOwed: string[] = [];
  private relayHeld(): void { for (const l of this.heldOwed.splice(0)) this.relay(l); }
  // A round counted at intake whose review never reached the queue (the runner stopped between the
  // two writes) is lost, found once at the runner's start: it still counts, Cain hears it named, and
  // at the cap it's held (Cain 0.19.1; before, it owed the decision card).
  private recovered = false;
  recoverLost(): void {
    const file = this.cfg.roundsFile;
    if (this.recovered || !file || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;                               // tried again next tick
    this.recovered = true;
    this.heldOwed = [];
    const lines: string[] = [];
    for (const [key, c] of Object.entries(rounds.changes)) {
      for (const x of c.rounds) {
        if (x.done || x.blocked || x.state === "lost" || x.state === "answered" || existsReview(this.cfg.queueDir, x.id)) continue;
        x.state = "lost"; x.done = true;
        const n = countedRounds(rounds, key).findIndex((y) => y.id === x.id && y.key === key) + 1;
        lines.push(`Round ${n} of ${this.capFor(rounds, key)} for ${key} was lost: the review runner stopped before its review was queued, so it never ran. It still counts.`);
        this.owe(rounds, key, { topic: oneLine(c.topic ?? key, 120), item: null, pr: c.pr ?? null, serious: 0, finding: "", lost: true }, `round ${x.id}`);
      }
    }
    if (!lines.length) return;
    writeRounds(file, rounds);
    for (const l of lines) this.relay(`${l} Nothing to tell him.`);
    this.relayHeld();
  }
  async tick(): Promise<void> {
    try { this.recoverLost(); this.ingest(); await this.reviews(); }
    finally {
      if (this.publishOwed) this.publishReviewed();
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
          if (s.attempts > retryLimit("transient")) { s.state = "failed"; delete s.next_at; s.finished_at = this.now().toISOString(); }
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
    // Then the payload as a seat is handed it (Cain 0.19.4): the strict rules over all of it but the earlier
    // findings' span, the findings rules over that span alone (payloadCheck).
    const e = payloadCheck(outbound(r.brief!, r.round_kind === "fixes" ? { earlier: r.earlier ?? [] } : undefined), this.terms());
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
    this.settle(r);
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
    const out = outbound(b, r.round_kind === "fixes" ? { earlier: r.earlier ?? [] } : undefined);   // throws on a wrong kind: nothing is sent
    // The exact payload this seat is handed passes payloadCheck first (advance blocked the review already if not).
    if (!payloadCheck(out, this.terms()).ok) throw new Error("the payload failed the privacy check just before sending, so nothing was sent");
    const down = this.unavailable(s.seat) ?? this.capCheck(s.seat, out, r.cost_usd);
    if (down || !fn) return this.fail(r, s, down?.kind ?? "unconfigured", down?.detail ?? "not set up", hourly, 0);
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
      const a = await Promise.race([fn({ brief: out, role: s.role, signal: ctl.signal, maxOutputTokens: this.cfg.maxOut[s.seat], day: this.day() }), deadline]);
      const cost = this.addSpend(s.seat, a.cost_usd, a.findings.length, a.searches ?? 0);
      // A fix-only round's finding a seat didn't mark counts as serious: it fails safe.
      if (r.round_kind === "fixes") a.findings = a.findings.map((f) => { const m = readMark(f); return m.severity ? m : { ...m, severity: "serious" as const }; });
      Object.assign(s, { state: "done", verdict: a.verdict, findings: a.findings, model: a.model, tokens: a.tokens,
        cost_usd: s.cost_usd + cost, finished_at: this.now().toISOString() });
      this.keepFindings(r, s, a.findings);
      delete s.error; delete s.next_at;
      r.cost_usd += cost;
      this.markHealth(s.seat, null, true);
    } catch (e) {
      const err = e instanceof SeatError ? e : new SeatError("transient", String((e as Error)?.message ?? e).slice(0, 200));
      if (err.cost_usd) { const c = this.addSpend(s.seat, err.cost_usd, 0); s.cost_usd += c; r.cost_usd += c; }
      else if (s.seat === "openai") this.addSpend("openai", 0, 0);   // a Codex run counts against the run cap either way
      s.state = prev;
      this.fail(r, s, err.kind, err.message, hourly, s.attempts);
    } finally { clearTimeout(timer); }
  }

  private fail(r: Review, s: SeatRun, kind: ErrorKind, detail: string, hourly: boolean, attempts: number) {
    const now = this.now();
    s.error = { kind, detail, fix: fixFor(s.seat, kind, detail) };
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
