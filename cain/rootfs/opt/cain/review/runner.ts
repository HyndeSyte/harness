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
  FINAL, JUDGES, LABEL, SEATS, SeatError, backoffMs, earlierCheck, readMark, estimate, fixFor, independent, markBlocked, oneLine, outbound, recordRequest,
  newReview, parseBrief, relayLine, reviewCheck, safeId, sayLine, seatName, seriousLeft, shownId, retryLimit, seatRun, type Brief, type ErrorKind, type Outbound, type Review, type SeatName, type SeatRun,
} from "./core.ts";
import type { SeatFn } from "./seats/common.ts";
import { DEFAULT_ROUND_CAP, RoundsBusy, addRound, admit, countedRounds, decisionOf, readRounds, withRoundsLock, writeRounds, type DecisionRec, type LegacyCard, type Rounds } from "./rounds.ts";
import { effectiveCap, grantWords, readGrants, STALE_LONG, staleWords, sweepLegacy, type GrantRec, type Grants, type StaleWhy } from "./grants.ts";
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
  // 0.18.1 (fifth review): how long one tick waits on a GitHub read before it goes on with the other briefs
  // (the read goes on in the background; default 2 seconds).
  hostWaitMs?: number;
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
  // Cain 0.16.0: the owner's decision card at the review cap, posted through the link (its root socket);
  // the message id, or null when it didn't go (tried again next tick). Absent: never posted.
  postDecision?: (d: DecisionRec) => Promise<string | null>;
  plan?: () => PlanReading;                        // the plan-usage reading (../plan-usage.ts), for the guard
  // Cain 0.18.1 (fourth review): a pull request as GitHub has it now (../pullnow.ts, the link's own read), for
  // the head a round that claims a grant is pinned to. null, or a null head: can't tell (the brief waits).
  pull?: (pr: string) => Promise<{ head: string | null } | null>;
  // Fifth review: GitHub's compare of two commits of the pull request's repository (../pullnow.ts compareHeads):
  // "ahead" when head is a descendant of base. null: can't tell. The proof a grant's bound head is superseded.
  compare?: (pr: string, base: string, head: string) => Promise<"ahead" | "behind" | "diverged" | "identical" | null>;
  // Fifth review: the owner's Keep or Drop card for a 0.18.0 grant's unused allowance, posted through the link (its
  // root socket); the message id, or null when it didn't go (tried again next tick). Absent: never posted.
  postLegacy?: (c: LegacyCard) => Promise<string | null>;
};

// The code host's read for a brief that would claim a grant (fifth review): a failure or rate limit backs off, from
// a minute, doubling to 15 minutes; after 15 minutes of waiting Cain is told once, and after 24 hours the brief is
// refused and the runner stops reading for it.
export const HOST_BACKOFF_MIN_MS = 60_000, HOST_BACKOFF_MAX_MS = 15 * 60_000;
export const HOST_NOTICE_MS = 15 * 60_000, HOST_GIVE_UP_MS = 24 * 3_600_000;

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
  // Cain 0.18.1 (fourth review): a brief whose round would claim a grant of the owner's waits in the inbox,
  // untaken, while GitHub's head for its pull request can't be read; it is taken once the head is read, and the
  // claim is pinned to that head (admitAndQueue). Fifth review: that read never holds up the other briefs (a tick
  // waits at most hostWaitMs for it, then goes on; the read finishes in the background and the next tick uses it),
  // a failed read backs off (a minute, doubling to 15 minutes, never every tick), Cain is told once after 15 minutes
  // of waiting, and after 24 hours the brief is refused and no longer read for. The wait is counted from when this
  // runner first found the brief waiting.
  private waitingBriefs = new Map<string, { since: number; next: number; delay: number; told: boolean;
    read?: { p: Promise<string | null>; done: boolean; head: string | null } }>();
  async ingest(): Promise<void> {
    const dir = this.cfg.inboxDir;
    if (!dir) return;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); }
    catch { return; }
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const path = join(dir, name);
      const got = readOwned(path, this.cfg.inboxUid ?? CAIN_UID, 256 * 1024);
      const p = got.ok ? parseBrief(got.text) : null;
      const b = p?.brief && !existsReview(this.cfg.queueDir, p.brief.id) ? p.brief : null;
      let gh: string | undefined;
      if (b && this.claimInView(b)) {
        const h = await this.hostHead(name, b);
        if (h === "wait") continue;
        if (h === "stop") {
          try { unlinkSync(path); } catch { /* already gone */ }
          this.waitingBriefs.delete(name);
          this.relay(`Review brief ${b.id} wasn't taken: its round would claim the owner's grant, and GitHub's head for its pull request couldn't be read for 24 hours, so the runner stopped trying. Send it again once GitHub answers. No grant was claimed or voided. Nothing to tell him.`);
          continue;
        }
        gh = h;
      }
      this.waitingBriefs.delete(name);
      if (got.ok && p!.brief && !existsReview(this.cfg.queueDir, p!.brief.id)) {
        let why: string | null;
        try { why = this.admitAndQueue(p!.brief, gh); }
        catch (e) {
          if (!(e instanceof RoundsBusy)) throw e;
          this.log(`review brief ${p!.brief.id} stays in the inbox for now: ${e.message}`);
          continue;
        }
        try { unlinkSync(path); } catch { /* already gone */ }
        if (why) this.relay(`Review brief ${p!.brief.id} wasn't taken: ${why} Nothing to tell him.`);
        continue;
      }
      try { unlinkSync(path); } catch { /* already gone */ }
      if (!got.ok) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken (${got.why}). Submit it again with review.sh. Nothing to tell him.`); continue; }
      if (!p!.brief) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken: not a brief: ${p!.error}. Nothing to tell him.`); continue; }
      this.relay(`Review brief ${p!.brief.id} wasn't taken: a review with that id already exists; use a new id. Nothing to tell him.`);
    }
    for (const name of [...this.waitingBriefs.keys()]) if (!seen.has(name)) this.waitingBriefs.delete(name);
  }
  // GitHub's head for a waiting brief, through the backoff: the head, "wait" (not read yet, or backing off), or
  // "stop" (24 hours without a read).
  private async hostHead(name: string, b: Brief): Promise<string | "wait" | "stop"> {
    const now = this.now().getTime();
    let w = this.waitingBriefs.get(name);
    if (!w) { w = { since: now, next: now, delay: 0, told: false }; this.waitingBriefs.set(name, w); }
    if (now - w.since >= HOST_GIVE_UP_MS) return "stop";
    if (!w.read && now >= w.next) {
      const r: NonNullable<typeof w.read> = { p: this.readHead(b), done: false, head: null };
      r.p.then((h) => { r.done = true; r.head = h; }, () => { r.done = true; r.head = null; });
      w.read = r;
    }
    if (w.read) {
      const r = w.read;
      if (!r.done) await Promise.race([r.p.catch(() => null), Bun.sleep(this.cfg.hostWaitMs ?? 2000)]);
      if (r.done) {
        w.read = undefined;
        if (r.head) return r.head;
        w.delay = Math.min(Math.max(HOST_BACKOFF_MIN_MS, w.delay * 2), HOST_BACKOFF_MAX_MS);
        w.next = now + w.delay;
        this.log(`review brief ${b.id} waits in the inbox: its round would claim the owner's grant, and GitHub's head for ${b.pr} can't be read now; read again in ${Math.round(w.delay / 1000)} seconds`);
      }
    }
    if (!w.told && now - w.since >= HOST_NOTICE_MS) {
      w.told = true;
      this.relay(`Review brief ${b.id} waits: its round would claim the owner's grant, and GitHub's head for its pull request hasn't been readable for 15 minutes. The runner keeps trying, backing off up to 15 minutes between reads, and refuses the brief after 24 hours. Other briefs aren't held up. Nothing to tell him.`);
    }
    return "wait";
  }

  // Whether the brief's round would claim a grant (so GitHub's head must be read for it first).
  private claimInView(b: Brief): boolean {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !b.pr || !b.head) return false;
    const rounds = readRounds(file);
    if (!rounds) return false;
    const a = admit(rounds, b, this.roundCap, this.grants(), this.cfg.tz, true);
    return a.ok && a.claims.length > 0;
  }
  // GitHub's head for the brief's pull request, read by the runner itself, when its round would claim a grant
  // (fourth review): undefined when no claim is in view (nothing to read), null when GitHub can't be read now.
  async githubHead(b: Brief): Promise<string | null | undefined> {
    return this.claimInView(b) ? this.readHead(b) : undefined;
  }
  // Fifth review: a grant is voided for its head only when that head is provably superseded: GitHub's compare says
  // the bound head is an ancestor of the head read now, or (when the compare can't tell, or the history was
  // rewritten) two reads at least one tick apart agree on the newer head. Each read is noted here, with the proof
  // for each grant bound to another head; admitAndQueue refuses the brief, voiding nothing, without it.
  private tickNo = 0;
  private headSeen = new Map<string, { head: string; tick: number }>();
  private headProof = new Map<string, string>();
  private async readHead(b: Brief): Promise<string | null> {
    if (!this.deps.pull || !b.pr) return null;
    let head: string | null = null;
    try { const p = await this.deps.pull(b.pr); head = p?.head && /^[0-9a-f]{40}$/.test(p.head) ? p.head : null; } catch { head = null; }
    if (!head) return null;
    const prev = this.headSeen.get(b.pr);
    const agreed = !!prev && prev.head === head && prev.tick < this.tickNo;
    if (!prev || prev.head !== head) this.headSeen.set(b.pr, { head, tick: this.tickNo });
    const file = this.cfg.roundsFile;
    const rounds = file ? readRounds(file) : null;
    if (rounds) {
      const a = admit(rounds, { ...b, head }, this.roundCap, this.grants(), this.cfg.tz);
      for (const { rec, why } of a.stale ?? []) {
        if (why !== "head" || rounds.grants_void?.[rec.id] || !rec.bound?.head) continue;
        let cmp: Awaited<ReturnType<NonNullable<RunnerDeps["compare"]>>> = null;
        try { cmp = (await this.deps.compare?.(b.pr, rec.bound.head, head)) ?? null; } catch { cmp = null; }
        const proven = cmp === "ahead" || ((cmp === null || cmp === "diverged") && agreed);
        if (proven) this.headProof.set(rec.id, head); else this.headProof.delete(rec.id);
        this.log(`the owner's grant ${rec.id} is bound to another head than GitHub's now: ${proven ? `proven superseded (${cmp === "ahead" ? "GitHub's compare shows the granted commit as an ancestor" : "two reads a tick apart agree"})` : `not proven superseded (${cmp ?? "the compare can't tell"}${agreed ? "" : ", one read only"}), so it's left as it is`}`);
      }
    }
    return head;
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
  // gh (0.18.1, fourth review): the pull request's head as the runner read it from GitHub (githubHead) for this
  // brief, or undefined when it wasn't read. From here to the write of the rounds file nothing awaits: the
  // rounds and grants are read afresh, and the decision, round count and prior cap are checked in the same
  // step that records the claim (one write of the rounds file; the runner is its only writer, one tick at a time).
  // A round that would claim a grant is pinned to GitHub's head: the brief's head must be that head, or the brief
  // is refused and no grant is claimed or voided. A grant is voided only by checks against GitHub's head and the
  // runner's own records, never against a brief's claim.
  // Fifth review: one read, check and write of the rounds file under its lock (rounds.ts withRoundsLock), since the
  // link writes the owner's Keep or Drop into it; RoundsBusy when the lock can't be had (the inbox keeps the brief).
  admitAndQueue(b: Brief, gh?: string): string | null {
    const file = this.cfg.roundsFile;
    if (!file) { saveReview(this.cfg.queueDir, newReview(b, this.now())); return null; }
    return withRoundsLock(file, () => this.admitLocked(file, b, gh));
  }
  private admitLocked(file: string, b: Brief, gh?: string): string | null {
    if (this.capOff) return `the review cap's files aren't right (${this.capOff}), so no round can be counted: the App's alarm says so, and it's logged for a Build item. Nothing was queued.`;
    const rounds = readRounds(file);
    if (!rounds) return "the review rounds file (/data/review-rounds.json) can't be read, so no round can be counted: it's logged for a Build item. Nothing was queued.";
    const grants = this.grants();
    if (gh !== undefined && (b.head ?? "").toLowerCase() !== gh.toLowerCase())
      return "the pull request's head on GitHub is not the one the brief names; send it again with the current head. No grant was claimed or voided. Nothing was queued.";
    // With GitHub's head: the brief's head, now verified. Without it: the head isn't checked at all (a brief with a
    // pull request and no head still waits on one, as before), so no grant is voided for a head.
    const headless = !!b.pr && !b.head;
    const a = admit(rounds, b, this.roundCap, grants, this.cfg.tz, gh === undefined && !headless);
    if (a.ok && a.claims.length && b.pr && gh === undefined)
      return "its round would claim the owner's grant, and the pull request's head on GitHub wasn't read for it; send it again. No grant was claimed or voided. Nothing was queued.";
    // Fifth review: a grant is voided for its head only on proof that its head is superseded (readHead); without it
    // the brief is refused and nothing is voided or claimed.
    const unproven = (a.stale ?? []).filter((x) => x.why === "head" && !rounds.grants_void?.[x.rec.id] && this.headProof.get(x.rec.id) !== gh);
    if (unproven.length)
      return "GitHub's head for the pull request isn't the one the owner's grant was bound to, and it isn't proven newer yet (GitHub's compare didn't show the granted commit as its ancestor, and no second read a tick later agreed): send it again in a minute. No grant was claimed or voided. Nothing was queued.";
    // 0.18.1: grants no longer bound to the change as it is are kept as void (in the rounds file, the
    // runner's own) and told to Cain once, whether this round is refused or runs under other grants.
    if (a.key && a.stale?.length && this.voidGrants(rounds, a.key, a.stale)) writeRounds(file, rounds);
    if (!a.ok) return a.why;
    const label = labelOf(b.label)!;
    if (this.cfg.settingsFile && this.cfg.guardLog && this.cfg.spendFile) {
      const g = guard(label, `review ${b.id} (${a.key}, round ${a.round})`, { settingsFile: this.cfg.settingsFile, spendFile: this.cfg.spendFile,
        logFile: this.cfg.guardLog, tz: this.cfg.tz, now: this.now(), plan: this.deps.plan });
      if (!g.ok) return `held by the usage guard: it's labelled ${label}, and ${g.why}. Core, commitment and necessary-fix work still run; this is on the guard's log (review.sh guard). Nothing was queued.`;
    }
    const r = newReview(b, this.now());
    Object.assign(r, { change: a.key, round: a.round, cap: a.cap, round_kind: a.kind,
      ...(a.granted.length ? { granted: a.granted.map((g) => ({ rounds: g.rounds, at: g.at })), base_cap: this.roundCap } : {}),
      ...(a.stale.length ? { stale_grants: staleWords(a) } : {}) });
    if (a.kind === "fixes") r.earlier = this.earlierFindings(rounds, a.key);
    // The round is kept before the review is queued: a stop between the two counts a round that never
    // ran (fails safe), never runs one that wasn't counted.
    addRound(rounds, b, a, this.now().toISOString());
    writeRounds(file, rounds);
    saveReview(this.cfg.queueDir, r);
    if (a.claims.length) this.log(`review ${b.id} (${a.key}, round ${a.round}) claimed the owner's grant${a.claims.length === 1 ? "" : "s"} ${a.claims.join(", ")}${gh ? ` at GitHub's head ${gh}` : ""}`);
    return null;
  }
  // Grants found not to count, kept under grants_void once each, logged and told to Cain once (the link
  // delivers the relay queue). True when any was new (the caller writes the rounds file).
  private voidGrants(rounds: Rounds, key: string, stale: { rec: GrantRec; why: StaleWhy }[]): boolean {
    const v = rounds.grants_void ??= {};
    let any = false;
    for (const { rec, why } of stale) {
      // A grant from 0.18.0 (no binding) is never voided: the upgrade's replay credits it or leaves it pending.
      if (v[rec.id] || why === "unbound") continue;
      v[rec.id] = { why, at: this.now().toISOString(), key: rec.key };
      any = true;
      const n = rec.rounds;
      this.log(`the owner's grant ${rec.id} (${n} round${n === 1 ? "" : "s"} for ${rec.key}) doesn't count: ${why}`);
      this.relay(`Dane's grant of ${n} more review round${n === 1 ? "" : "s"} for ${rec.key} (${grantWords([rec], this.cfg.tz).replace(/^\d+ /, "")}) no longer counts: ${STALE_LONG[why]}. `
        + `So a round past ${key}'s cap is refused. If the change still needs more fix rounds, ask him for a fresh grant with keeper.sh review-grant once its last round is done; the old grant stays on file and never counts. Nothing else to tell him.`);
    }
    return any;
  }
  // 0.18.1 (fifth review): grants written by 0.18.0 carry no binding and 0.18.0 recorded no claims. Once, at the
  // runner's start (retried each tick until both files read): each change group's rounds are replayed against the
  // allowance in effect at each round, and only the rounds that needed a grant are credited (claims on those rounds);
  // what a grant has left is pending until the owner's Keep or Drop card (grants.ts sweepLegacy), one card per
  // change, owed here and posted through the link. Nothing is voided. Each decision logged once; Cain told once a
  // change. Idempotent: a grant the replay handled already is passed over, so a restart changes nothing.
  private swept = false;
  sweepUnbound(): void {
    const file = this.cfg.roundsFile;
    if (this.swept || !file || this.capOff || !this.cfg.grantsFile) return;
    const g = this.grants();
    if (!g) return;
    let done: ReturnType<typeof sweepLegacy> = [];
    let cards: LegacyCard[] = [];
    try {
      const ok = withRoundsLock(file, () => {
        const rounds = readRounds(file);
        if (!rounds) return false;
        done = sweepLegacy(rounds, g, this.roundCap, this.now().toISOString());
        cards = this.oweLegacyCards(rounds, done);
        if (done.length) writeRounds(file, rounds);
        return true;
      });
      if (!ok) return;
    } catch (e) {
      if (e instanceof RoundsBusy) { this.log(`the upgrade's sweep of earlier grants waits: ${e.message}`); return; }
      throw e;
    }
    this.swept = true;
    const byKey = new Map<string, typeof done>();
    for (const d of done) {
      const n = d.rec.rounds, c = d.credited.length;
      this.log(`the owner's grant ${d.rec.id} (${n} round${n === 1 ? "" : "s"} for ${d.rec.key}, given before grants were bound): replayed: `
        + `${c ? `credited with the round${c === 1 ? "" : "s"} that needed it (${d.credited.join(", ")})` : "no round needed it"}`
        + `${d.unused ? `; ${d.unused} unused, pending the owner's Keep or Drop card` : ""}`);
      byKey.set(d.rec.key, [...(byKey.get(d.rec.key) ?? []), d]);
    }
    for (const [key, list] of byKey) {
      const granted = list.reduce((n, d) => n + d.rec.rounds, 0), credited = list.reduce((n, d) => n + d.credited.length, 0);
      const unused = list.reduce((n, d) => n + d.unused, 0);
      const card = cards.find((c) => c.key === key);
      this.relay(`The review runner replayed Dane's earlier grants for ${key} (given before grants were bound to a commit) through the update: `
        + `${granted} round${granted === 1 ? "" : "s"} granted, ${credited} credited to rounds that went past the cap and needed ${credited === 1 ? "it" : "them"}`
        + `${unused ? `, ${unused} unused. The unused ${unused === 1 ? "round doesn't" : "rounds don't"} count until he confirms on the review service's Keep or Drop card, which ${card ? "goes to him by itself" : "couldn't be owed"}; don't ask him about it yourself, and his tap comes to you like any tap.` : "."} None was voided. Nothing to tell him.`);
    }
  }
  // One Keep or Drop card per change with a pending allowance, owed in the rounds file (posted by postOwedLegacy).
  private oweLegacyCards(rounds: Rounds, done: { rec: GrantRec; unused: number }[]): LegacyCard[] {
    const out: LegacyCard[] = [];
    const byKey = new Map<string, { rec: GrantRec; unused: number }[]>();
    for (const d of done) if (d.unused > 0) byKey.set(d.rec.key, [...(byKey.get(d.rec.key) ?? []), d]);
    for (const [key, list] of byKey) {
      if (rounds.legacy_cards?.[key]) continue;
      const c = rounds.changes[key];
      const card: LegacyCard = { key, ids: list.map((d) => d.rec.id), granted: list.reduce((n, d) => n + d.rec.rounds, 0),
        unused: list.reduce((n, d) => n + d.unused, 0), item: list.find((d) => d.rec.item)?.rec.item ?? null,
        pr: list.find((d) => d.rec.pr)?.rec.pr ?? c?.pr ?? null, topic: oneLine(c?.topic ?? key, 120), state: "owed", at: this.now().toISOString() };
      (rounds.legacy_cards ??= {})[key] = card;
      out.push(card);
    }
    return out;
  }
  // Owed Keep or Drop cards, through the link; once posted never posted again.
  async postOwedLegacy(): Promise<void> {
    const file = this.cfg.roundsFile;
    if (!file || !this.deps.postLegacy || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;
    for (const [key, c] of Object.entries(rounds.legacy_cards ?? {})) {
      if (c.state !== "owed") continue;
      let msg: string | null = null;
      try { msg = await this.deps.postLegacy(c); } catch (e) { this.log(`the Keep or Drop card for ${key} didn't go: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
      try {
        withRoundsLock(file, () => {
          const now = readRounds(file);
          const cur = now?.legacy_cards?.[key];
          if (!now || !cur || cur.state !== "owed") return;
          if (msg) Object.assign(cur, { state: "posted", message: msg }); else cur.tries = (cur.tries ?? 0) + 1;
          writeRounds(file, now);
        });
      } catch (e) { if (!(e instanceof RoundsBusy)) throw e; this.log(`the Keep or Drop card for ${key}: ${e.message}`); }
      if (msg) this.log(`the owner's Keep or Drop card for ${key}'s earlier grant is up`);
    }
  }
  // The findings of the change's latest round that answered, for a fix-only round to check the fixes against.
  private earlierFindings(rounds: Rounds, key: string): string[] {
    const done = countedRounds(rounds, key).reverse();
    for (const x of done) {
      const prev = loadReview(this.cfg.queueDir, x.id);
      if (!prev || prev.status === "blocked: privacy") continue;
      const list = prev.seats.filter((s) => s.state === "done").flatMap((s) => (s.findings ?? []).map((f) =>
        `${seatName(s)}${f.severity ? ` [${f.severity}]` : ""}: ${oneLine(f.problem, 400)}`));
      if (list.length) return list.slice(0, 30);
    }
    return [];
  }
  // A finished round, kept in the rounds file once: answered, or lost (no seat answered: it still counts);
  // a round blocked for privacy sent nothing and doesn't count. The cap's last round owes the owner one
  // decision card for the change when it left a serious finding, or when it was lost (round 2).
  private settleRound(r: Review): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !r.change || r.rounded || !FINAL.includes(r.status)) return;
    // Fifth review: under the rounds file's lock; busy, it's settled next tick.
    try { withRoundsLock(file, () => this.settleLocked(file, r)); }
    catch (e) { if (!(e instanceof RoundsBusy)) throw e; this.log(`review ${shownId(r)}'s round is settled next tick: ${e.message}`); }
  }
  private settleLocked(file: string, r: Review): void {
    if (!r.change) return;
    const rounds = readRounds(file);
    if (!rounds) { this.log(`the rounds file can't be read; review ${shownId(r)}'s round is settled next tick`); return; }
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
  }
  // The owner's grants (0.18.0), read fresh each time; none count when the file can't be read (fail closed).
  grants(): Grants | null { return this.cfg.grantsFile ? readGrants(this.cfg.grantsFile) : null; }
  capFor(rounds: Rounds, key: string): number { return effectiveCap(this.roundCap, rounds, this.grants(), key); }
  // The decision card, owed once per change group and round, when the group is at its cap (the base cap
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
    this.log(`${what}: the round cap is reached for ${key} ${d.lost ? "and its last round was lost" : `with ${d.serious} serious finding(s) left`}; the owner's decision card is owed`);
  }
  // A round counted at intake whose review never reached the queue (the runner stopped between the
  // two writes) is lost, found once at the runner's start: it still counts, Cain hears it named, and
  // at the cap it owes the decision card.
  private recovered = false;
  recoverLost(): void {
    const file = this.cfg.roundsFile;
    if (this.recovered || !file || this.capOff) return;
    try { withRoundsLock(file, () => this.recoverLocked(file)); }
    catch (e) { if (!(e instanceof RoundsBusy)) throw e; this.log(`the check for lost rounds waits: ${e.message}`); }
  }
  private recoverLocked(file: string): void {
    const rounds = readRounds(file);
    if (!rounds) return;                               // tried again next tick
    this.recovered = true;
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
  }
  // Owed decision cards, through the link. Exactly one per change: once posted it's never posted again.
  async postOwed(): Promise<void> {
    const file = this.cfg.roundsFile;
    if (!file || !this.deps.postDecision || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds) return;
    for (const [key, c] of Object.entries(rounds.changes)) {
      const d = c.decision;
      if (!d || d.state !== "owed") continue;
      let msg: string | null = null;
      try { msg = await this.deps.postDecision(d); } catch (e) { this.log(`the decision card for ${key} didn't go: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
      const told = withRoundsLock(file, () => {
        const now = readRounds(file);
        if (!now?.changes[key]?.decision) return false;
        const cur = now.changes[key].decision!;
        if (msg) Object.assign(cur, { state: "posted", message: msg }); else cur.tries = (cur.tries ?? 0) + 1;
        writeRounds(file, now);
        return !!msg;
      });
      if (told) {
        this.relay(`The review cap is reached for ${key}: ${d.lost ? "its last round was lost (it never produced a result)" : `its last round left ${d.serious} serious finding${d.serious === 1 ? "" : "s"}`}, so the review service put one decision in front of Dane (ship it with that risk, or hold it). Start no other round for it, and don't ask him about it yourself; his tap comes to you like any tap. If it's a critical change whose fix needs more rounds, the only way is a grant: keeper.sh review-grant asks him, and only his tap grants them. Nothing to tell him.`);
      }
    }
  }

  async tick(): Promise<void> {
    this.tickNo++;
    try { this.recoverLost(); this.sweepUnbound(); await this.ingest(); await this.reviews(); }
    finally {
      if (this.publishOwed) this.publishReviewed();
      try { await this.postOwed(); } catch (e) { this.log(`owed decision cards: ${(e as Error).message}`); }
      try { await this.postOwedLegacy(); } catch (e) { this.log(`owed Keep or Drop cards: ${(e as Error).message}`); }
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
    const e = earlierCheck(r.round_kind === "fixes" ? r.earlier : undefined, this.terms());
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
