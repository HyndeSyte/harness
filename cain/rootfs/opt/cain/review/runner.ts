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
  FINAL, JUDGES, LABEL, SEATS, SeatError, backoffMs, checkBrief, earlierCheck, readMark, estimate, fixFor, independent, markBlocked, oneLine, outbound, recordRequest,
  keyOfRef, newReview, parseBrief, relayLine, reviewCheck, safeId, sayLine, seatName, seriousLeft, shownId, retryLimit, seatRun, type Brief, type ErrorKind, type Outbound, type Review, type SeatName, type SeatRun,
} from "./core.ts";
import type { SeatFn } from "./seats/common.ts";
import { DEFAULT_ROUND_CAP, addRound, admit, countedRounds, decisionOf, readRounds, writeRounds, type DecisionRec, type OwedNotice, type Rounds } from "./rounds.ts";
import { effectiveCap, grantWords, planLines, readGrants, replayUnbound, STALE_LONG, staleWords, type GrantRec, type Grants, type ReplayDecision, type StaleWhy } from "./grants.ts";
import { isFail, type Compare, type HostFail } from "../pullnow.ts";
import { CAIN_GID, ROOT_UID } from "../capfiles.ts";
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
  // (the read goes on in the background; default 2 seconds). Sixth review: each GitHub request's hard deadline
  // (default 20 seconds), and the owner of the copies kept before the one-time replay (default root:cain).
  hostWaitMs?: number; hostDeadlineMs?: number; preReplayOwner?: { uid: number; gid: number };
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
  // Cain 0.18.1 (fourth review): a pull request as GitHub has it now (../pullnow.ts pullForRunner), for the head a
  // round that claims a grant is pinned to. null, or a null head: can't tell (the brief waits). Seventh review: source
  // "api" is a fresh read of GitHub's pull request API, the only head that can void a grant; "refs" (the fallback, or
  // none given) can only admit a brief whose head equals a grant's bound head. A HostFail is classified (pullnow.ts):
  // a definitive one refuses the brief and leaves the backoff alone, a transient one moves it.
  pull?: (pr: string) => Promise<{ head: string | null; source?: "api" | "refs" } | HostFail | null>;
  // GitHub's compare of two commits of the pull request's repository (../pullnow.ts compareApi): "ahead" when head
  // is a strict descendant of base. null: can't tell (transient). The only proof a grant's bound head is superseded.
  compare?: (pr: string, base: string, head: string) => Promise<Compare | HostFail | null>;
  // Sixth review: a plain notice for the owner (a grant let go or voided, a review waiting on GitHub), posted through
  // the link in its own words (its root socket); the message id, or null when it didn't go (tried again next tick).
  postNotice?: (n: OwedNotice) => Promise<string | null>;
  // Tests only: called just before the one-time replay's commit (a throw there is a crash before it).
  crashPoint?: (where: string) => void;
};

// The code host's read for a brief that would claim a grant (sixth review): each request has a hard deadline of 20
// seconds; a failure, rate limit or deadline backs off every GitHub read, from a minute, doubling to 15 minutes;
// after 15 minutes of waiting Cain and the owner are told once, and after 24 hours the brief is refused and the
// runner stops reading for it.
export const HOST_DEADLINE_MS = 20_000;
export const HOST_BACKOFF_MIN_MS = 60_000, HOST_BACKOFF_MAX_MS = 15 * 60_000;
export const HOST_NOTICE_MS = 15 * 60_000, HOST_GIVE_UP_MS = 24 * 3_600_000;
// Seventh review: the owner's notices go through the link under a backoff of their own (link_backoff in the rounds
// file), never GitHub's: a minute, doubling to 15 minutes, cleared by any notice the link acknowledges.
export const LINK_BACKOFF_MIN_MS = 60_000, LINK_BACKOFF_MAX_MS = 15 * 60_000;
// One GitHub read for a brief that would claim a grant (seventh review): the head, whether it came from GitHub's pull
// request API (api) or the refs fallback, and the compare's answer for each grant bound to another head ("unasked"
// for a refs head: no compare is made for it; "unreadable" a definitive refusal; "transient" no answer). fresh: the
// read started and finished in the very step that admits the brief; a read from an earlier tick is cached and never
// voids a grant.
export type HostVerdict = Compare | "unreadable" | "transient" | "unasked";
export type HostRead = { head: string; api: boolean; verdicts: Map<string, HostVerdict>; fresh?: boolean };
// The copies of the rounds and grants files kept just before the one-time replay (sixth review), beside them.
export const PRE_ROUNDS = "review-rounds.pre-0.18.1.json", PRE_GRANTS = "review-grants.pre-0.18.1.json";
// A copy of a file as it is, once (an existing copy is the earliest and is kept), root:cain 0640 (tests pass their
// own owner; not root, the owner isn't set). A source not there yet is copied as nothing.
export function keepPreReplay(src: string, dst: string, owner?: { uid: number; gid: number }): void {
  if (existsSync(dst)) return;
  let text: string;
  try { text = readFileSync(src, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
  const tmp = join(dirname(dst), `.pre-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, text, { mode: 0o640 });
  const o = owner ?? (process.getuid?.() === 0 ? { uid: ROOT_UID, gid: CAIN_GID } : null);
  if (o) chownSync(tmp, o.uid, o.gid);
  chmodSync(tmp, 0o640);
  renameSync(tmp, dst);
}

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
  // claim is pinned to that head (admitAndQueue). Sixth review: that read never holds up the other briefs (a tick
  // waits at most hostWaitMs for it, then goes on; the read finishes in the background and the next tick uses it).
  // Each GitHub request (the head read and each compare) has a hard deadline (hostDeadlineMs, 20 seconds); at most
  // one read is in flight per brief, and every read carries a sequence number: an answer that isn't the latest
  // read's for a brief still being read for is discarded. A failed read (no answer, an error, a rate limit, the
  // deadline) moves the one backoff every GitHub read shares (host_backoff in the rounds file: a minute, doubling to
  // 15 minutes, its next try kept so a restart keeps it). The wait is judged on when the brief first waited
  // (host_waits in the rounds file, so a restart keeps it), every tick, whether or not a read has answered: after
  // 15 minutes Cain is told once and the owner once (a plain notice through the link), after 24 hours the brief is
  // refused and no longer read for.
  // Seventh review: the wait's start is per brief, set at its first wait and cleared by a read that answered; a clock
  // that went back is clamped (elapsed time never below zero) and the start re-anchored to now. A definitive answer
  // (the pull request isn't there) refuses the brief without moving the backoff.
  private hostReads = new Map<string, { seq: number; done: boolean; got: HostRead | HostFail | null; p: Promise<void> }>();
  private hostSeq = 0;
  private latestSeq = new Map<string, number>();
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
      let gh: HostRead | undefined;
      if (b && this.claimInView(b)) {
        const h = await this.hostHead(name, b);
        if (h === "wait") continue;
        if (h === "stop") {
          try { unlinkSync(path); } catch { /* already gone */ }
          this.relay(`Review brief ${b.id} wasn't taken: its round would claim the owner's grant, and GitHub's head for its pull request couldn't be read for 24 hours, so the runner stopped trying. Send it again once GitHub answers. No grant was claimed or voided. Nothing to tell him.`);
          continue;
        }
        if (isFail(h)) {
          this.endWait(name);
          try { unlinkSync(path); } catch { /* already gone */ }
          this.relay(`Review brief ${b.id} wasn't taken: its round would claim the owner's grant, and GitHub answered for good that its pull request can't be read (${h.why}). Check the pull request address. No grant was claimed or voided. Nothing to tell him.`);
          continue;
        }
        gh = h;
      }
      this.endWait(name);
      try { unlinkSync(path); } catch { /* already gone */ }
      if (b) {
        const why = this.admitAndQueue(b, gh);
        if (why) this.relay(`Review brief ${b.id} wasn't taken: ${why} Nothing to tell him.`);
        continue;
      }
      if (!got.ok) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken (${got.why}). Submit it again with review.sh. Nothing to tell him.`); continue; }
      if (!p!.brief) { this.relay(`A review brief in the inbox (${name.slice(0, 80)}) wasn't taken: not a brief: ${p!.error}. Nothing to tell him.`); continue; }
      this.relay(`Review brief ${p!.brief.id} wasn't taken: a review with that id already exists; use a new id. Nothing to tell him.`);
    }
    // A brief gone from the inbox no longer waits.
    const file = this.cfg.roundsFile;
    const r = file ? readRounds(file) : null;
    const gone = Object.keys(r?.host_waits ?? {}).filter((n) => !seen.has(n));
    for (const n of [...this.hostReads.keys()]) if (!seen.has(n)) this.endWait(n);
    if (file && r && gone.length) { for (const n of gone) delete r.host_waits![n]; writeRounds(file, r); }
  }
  // A brief no longer waits: its read (if any) is let go, so a late answer is discarded, and its wait record goes.
  private endWait(name: string): void {
    this.hostReads.delete(name); this.latestSeq.delete(name);
    const file = this.cfg.roundsFile;
    const r = file ? readRounds(file) : null;
    if (file && r?.host_waits?.[name]) { delete r.host_waits[name]; writeRounds(file, r); }
  }
  // GitHub's head for a waiting brief: the head, "wait" (not read yet, backing off, or GitHub didn't answer), or
  // "stop" (24 hours since it first waited).
  private async hostHead(name: string, b: Brief): Promise<HostRead | HostFail | "wait" | "stop"> {
    const file = this.cfg.roundsFile!;
    const now = this.now().getTime();
    let rounds = readRounds(file);
    if (!rounds) return "wait";
    const w = rounds.host_waits?.[name];
    if (w) {
      let since = Date.parse(w.since);
      if (!(since <= now)) {                               // the clock went back (or the start can't be read): re-anchor
        w.since = new Date(now).toISOString(); since = now;
        writeRounds(file, rounds);
        this.log(`review brief ${b.id}'s wait started after the clock's now; its start is set to now`);
      }
      if (now - since >= HOST_GIVE_UP_MS) { this.endWait(name); return "stop"; }
      if (!w.told && now - since >= HOST_NOTICE_MS) {
        w.told = true;
        this.oweNotice(rounds, { id: `cain-waits:${b.id}`, to: "cain", kind: "waits", key: keyOfRef(b.pr!) ?? b.id, pr: b.pr ?? null,
          text: `Review brief ${b.id} waits: its round would claim the owner's grant, and GitHub's head for its pull request hasn't been readable for 15 minutes. The runner keeps trying, backing off up to 15 minutes between reads, and refuses the brief after 24 hours. Other briefs aren't held up. He's told once, in the App's own words, that the review waits on GitHub. Nothing else to tell him.` });
        this.oweNotice(rounds, { id: `waits:${b.id}`, to: "owner", kind: "waits", key: keyOfRef(b.pr!) ?? b.id, pr: b.pr ?? null });
        writeRounds(file, rounds);
        this.deliverCain();
      }
    }
    let r = this.hostReads.get(name);
    let startedNow = false;
    if (!r) {
      const bo = rounds.host_backoff;
      if (!bo || now >= Date.parse(bo.next)) { r = this.startRead(name, b); startedNow = true; }
    }
    if (r && !r.done) await Promise.race([r.p, Bun.sleep(this.cfg.hostWaitMs ?? 2000)]);
    if (r?.done) {
      this.hostReads.delete(name);
      if (r.got) {
        // A read that answered ends the wait (its start is cleared): a later outage starts its own.
        rounds = readRounds(file);
        if (rounds?.host_waits?.[name]) { delete rounds.host_waits[name]; writeRounds(file, rounds); }
        return isFail(r.got) ? r.got : { ...r.got, fresh: startedNow && r.got.api };
      }
    }
    rounds = readRounds(file);
    if (rounds && !rounds.host_waits?.[name]) {
      (rounds.host_waits ??= {})[name] = { since: new Date(now).toISOString(), id: b.id, pr: b.pr! };
      writeRounds(file, rounds);
      this.log(`review brief ${b.id} waits in the inbox: its round would claim the owner's grant, and GitHub's head for ${b.pr} hasn't been read yet`);
    }
    return "wait";
  }
  private startRead(name: string, b: Brief) {
    const seq = ++this.hostSeq;
    this.latestSeq.set(name, seq);
    const r = { seq, done: false, got: null as HostRead | HostFail | null, p: Promise.resolve() };
    r.p = this.readHead(b).then((h) => {
      if (this.latestSeq.get(name) !== seq) { this.log(`a GitHub read for review brief ${b.id} answered after it was replaced; its answer was discarded`); return; }
      r.done = true; r.got = h;
    });
    this.hostReads.set(name, r);
    return r;
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
  // (fourth review): undefined when no claim is in view (nothing to read), null when GitHub can't be read now. Read
  // in the same step that admits the brief, so it is fresh (seventh review) when it came from the pull request API.
  async githubHead(b: Brief): Promise<HostRead | HostFail | null | undefined> {
    if (!this.claimInView(b)) return undefined;
    const h = await this.readHead(b);
    return h && !isFail(h) ? { ...h, fresh: h.api } : h;
  }
  // One GitHub request under its hard deadline: null when it doesn't answer in time (its late answer is discarded)
  // or fails.
  private async hostCall<T>(what: string, f: () => Promise<T | null>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    const deadline = new Promise<null>((res) => { timer = setTimeout(() => { late = true; res(null); }, this.cfg.hostDeadlineMs ?? HOST_DEADLINE_MS); });
    const call = f().then((v) => { if (late) this.log(`GitHub's answer for ${what} came after its deadline and was discarded`); return v; }, () => null);
    try { return await Promise.race([call, deadline]); }
    finally { clearTimeout(timer); }
  }
  // The shared backoff (seventh review): only a transient failure (no answer, the deadline, a 5xx, a 403 or a 429) moves
  // it; a definitive answer (404, 410, diverged, behind, identical) decides or refuses the brief and leaves it alone;
  // any answer that came (a head, or a compare's status) clears it.
  private hostFailed(why = "didn't answer"): void {
    const file = this.cfg.roundsFile;
    const r = file ? readRounds(file) : null;
    if (!file || !r) return;
    const delay = Math.min(Math.max(HOST_BACKOFF_MIN_MS, (r.host_backoff?.delay ?? 0) * 2), HOST_BACKOFF_MAX_MS);
    r.host_backoff = { next: new Date(this.now().getTime() + delay).toISOString(), delay };
    writeRounds(file, r);
    this.log(`a GitHub read ${why}; every GitHub read waits ${Math.round(delay / 1000)} seconds`);
  }
  private hostAnswered(): void {
    const file = this.cfg.roundsFile;
    const r = file ? readRounds(file) : null;
    if (file && r?.host_backoff) { delete r.host_backoff; writeRounds(file, r); }
  }
  // Sixth review: a grant is voided for its head only on positive proof that its head is superseded: GitHub's compare
  // says the bound head is a strict ancestor of the head read now ("ahead"). Seventh review: and only when that head
  // came from a fresh read of GitHub's pull request API (never the refs fallback, never a cached read): a refs head
  // asks no compare at all. A head equal to a grant's bound head asks none either: the grant is claimable as it is.
  private async readHead(b: Brief): Promise<HostRead | HostFail | null> {
    if (!this.deps.pull || !b.pr) return null;
    const pr = b.pr;
    const p = await this.hostCall(`the head of ${pr}`, () => this.deps.pull!(pr));
    if (isFail(p)) {
      if (p.fail === "transient") this.hostFailed(`was refused for now (${p.why})`);
      else this.log(`GitHub answered for good that ${pr} can't be read (${p.why}); the backoff isn't moved`);
      return p.fail === "transient" ? null : p;
    }
    const head = p?.head && /^[0-9a-f]{40}$/.test(p.head) ? p.head : null;
    if (!head) { this.hostFailed(); return null; }
    this.hostAnswered();
    const api = p!.source === "api";
    const verdicts = new Map<string, HostVerdict>();
    const file = this.cfg.roundsFile;
    const rounds = file ? readRounds(file) : null;
    if (rounds) {
      const a = admit(rounds, { ...b, head }, this.roundCap, this.grants(), this.cfg.tz);
      for (const { rec, why } of a.stale ?? []) {
        if (why !== "head" || rounds.grants_void?.[rec.id] || !rec.bound?.head) continue;
        if (!api) { verdicts.set(rec.id, "unasked"); continue; }
        const base = rec.bound.head;
        const cmp = this.deps.compare ? await this.hostCall(`the compare of two commits of ${pr}`, () => this.deps.compare!(pr, base, head)) : null;
        let v: HostVerdict;
        if (cmp === null) { v = "transient"; this.hostFailed(); }
        else if (isFail(cmp)) { v = cmp.fail === "definitive" ? "unreadable" : "transient"; if (cmp.fail === "transient") this.hostFailed(`was refused for now (${cmp.why})`); }
        else { v = cmp; this.hostAnswered(); }
        verdicts.set(rec.id, v);
        this.log(`the owner's grant ${rec.id} is bound to another head than GitHub's now: ${v === "ahead" ? "proven superseded (GitHub's compare shows the granted commit as an ancestor)" : `not proven superseded (${v === "transient" ? "the compare didn't answer" : v === "unreadable" ? "GitHub refused the compare for good" : v}), so it's left as it is`}`);
      }
    }
    return { head, api, verdicts };
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
  // runner's own records, never against a brief's claim. Seventh review: a void for head needs a fresh read of the
  // pull request API in this step and GitHub's compare saying the bound head is a strict ancestor of it; a plain head
  // (a string), a refs head or a cached read can admit only a brief whose head equals the bound head.
  // One writer per file: the runner writes the rounds file only. Claims and voids live there, keyed by grant id; the
  // grants file is the link's alone, read here and never written.
  admitAndQueue(given: Brief, gh?: string | HostRead | HostFail | null): string | null {
    // Only a brief's own fields go in (Cain 0.18.1): a brief carrying anything else, earlier findings
    // included, is refused whole, so the findings a fix-only round sends are only ever the ones the
    // runner loads itself from its own record of the change's previous round (earlierFindings).
    const c = checkBrief(given);
    if (!c.brief) return `not a brief: ${c.error}. Nothing was queued.`;
    const why = this.admitInner(c.brief, gh);
    this.deliverCain();                                // what a void owed Cain, once the rounds file has it
    return why;
  }
  private admitInner(b: Brief, read?: string | HostRead | HostFail | null): string | null {
    const file = this.cfg.roundsFile;
    if (!file) { saveReview(this.cfg.queueDir, newReview(b, this.now())); return null; }
    if (this.capOff) return `the review cap's files aren't right (${this.capOff}), so no round can be counted: the App's alarm says so, and it's logged for a Build item. Nothing was queued.`;
    if (isFail(read)) return `GitHub answered for good that the pull request can't be read (${read.why}): check its address. No grant was claimed or voided. Nothing was queued.`;
    const rd: HostRead | null = read && typeof read === "object" ? read : null;
    const gh: string | undefined = typeof read === "string" ? read : rd?.head;
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
    // A grant bound to another head than GitHub's is voided only on proof (above); without it the grant is kept as it
    // is, neither claimed nor voided. The brief is refused for it only when no other grant lets the round run.
    const proven = (id: string) => !!rd?.fresh && rd.api && rd.verdicts.get(id) === "ahead";
    const unproven = (a.stale ?? []).filter((x) => x.why === "head" && !rounds.grants_void?.[x.rec.id] && !proven(x.rec.id));
    if (unproven.length && !a.ok) {
      const vs = unproven.map((x) => rd?.verdicts.get(x.rec.id));
      const stalled = !!rd?.fresh && vs.some((v) => v === "diverged" || v === "behind" || v === "unreadable");
      if (stalled && gh && a.key) this.oweStalled(rounds, a.key, gh, unproven.map((x) => x.rec), b.pr ?? null);
      return stalled
        ? "GitHub's compare shows the pull request's head doesn't follow on from the commit the owner's grant was given for (or GitHub refused the compare for good), so the grant can't be used at this head and stays as it was. A fresh grant for the pull request as it is now is the way: he's told once, in the App's own words. No grant was claimed or voided. Nothing was queued."
        : rd && (!rd.api || !rd.fresh)
          ? "the pull request's head wasn't read freshly from GitHub's pull request API (it came from GitHub's refs or an earlier read), and only a fresh read can show the grant's commit is superseded: send it again in a minute. No grant was claimed or voided. Nothing was queued."
          : "the pull request's head isn't proven newer than the one the grant was given for (GitHub's compare didn't show the granted commit as an ancestor of the head now, or didn't answer): send it again in a minute. No grant was claimed or voided. Nothing was queued.";
    }
    // 0.18.1: grants no longer bound to the change as it is are kept as void (in the rounds file, the
    // runner's own) and told to Cain and to the owner once each, whether this round is refused or runs under
    // other grants. One bound to another head without proof is never voided.
    const toVoid = (a.stale ?? []).filter((x) => !unproven.includes(x));
    if (a.key && toVoid.length && this.voidGrants(rounds, a.key, toVoid)) writeRounds(file, rounds);
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
  // Grants found not to count, kept under grants_void once each, logged, and owed to Cain (the relay queue) and to
  // the owner (a plain notice through the link) once each, in the same write. True when any was new (the caller
  // writes the rounds file, then delivers Cain's).
  private voidGrants(rounds: Rounds, key: string, stale: { rec: GrantRec; why: StaleWhy }[]): boolean {
    const v = rounds.grants_void ??= {};
    let any = false;
    for (const { rec, why } of stale) {
      // A grant from 0.18.0 (no binding) is voided only by the one-time replay, for its unused rounds.
      if (v[rec.id] || why === "unbound") continue;
      v[rec.id] = { why, at: this.now().toISOString(), key: rec.key };
      any = true;
      const n = rec.rounds;
      this.log(`the owner's grant ${rec.id} (${n} round${n === 1 ? "" : "s"} for ${rec.key}) doesn't count: ${why}`);
      this.oweNotice(rounds, { id: `cain-void:${rec.id}`, to: "cain", kind: "void", key: rec.key, pr: rec.pr ?? rounds.changes[rec.key]?.pr ?? null, rounds: n, why,
        text: `Dane's grant of ${n} more review round${n === 1 ? "" : "s"} for ${rec.key} (${grantWords([rec], this.cfg.tz).replace(/^\d+ /, "")}) no longer counts: ${STALE_LONG[why]}. `
          + `So a round past ${key}'s cap is refused. If the change still needs more fix rounds, ask him for a fresh grant with keeper.sh review-grant once its last round is done; the old grant stays on file and never counts. He's told once, in the App's own words, that it no longer counts. Nothing else to tell him.` });
      this.oweNotice(rounds, { id: `void:${rec.id}`, to: "owner", kind: "void", key: rec.key, pr: rec.pr ?? rounds.changes[rec.key]?.pr ?? null, rounds: n, why });
    }
    return any;
  }
  // Seventh review: a change stalled at a head GitHub's compare can't place after the granted one (diverged, behind,
  // or the compare refused for good): one notice to the owner per change and head, facts only, and one to Cain, saying
  // a fresh grant is the way out. Written now (the refusal writes nothing else).
  private oweStalled(rounds: Rounds, key: string, head: string, recs: GrantRec[], pr: string | null): void {
    const id = `${key}.${head.slice(0, 12)}`;
    if (rounds.notices?.[`stalled:${id}`]) return;
    const n = recs.reduce((k, x) => k + x.rounds, 0);
    this.oweNotice(rounds, { id: `cain-stalled:${id}`, to: "cain", kind: "stalled", key, pr: pr ?? rounds.changes[key]?.pr ?? null, rounds: n,
      text: `A round for ${key} past its cap was refused: GitHub's compare can't place the pull request's head after the commit Dane's grant of ${n} more round${n === 1 ? "" : "s"} was given for (it diverged, went back, or the compare was refused for good), so that grant can't be used at this head. It isn't voided. If the change still needs rounds, ask him for a fresh grant with keeper.sh review-grant for the pull request as it is now. He's told once, in the App's own words. Nothing else to tell him.` });
    this.oweNotice(rounds, { id: `stalled:${id}`, to: "owner", kind: "stalled", key, pr: pr ?? rounds.changes[key]?.pr ?? null, rounds: n });
    writeRounds(this.cfg.roundsFile!, rounds);
    this.log(`${key} is stalled at a head GitHub's compare can't place after the granted one; the owner's notice is owed`);
  }
  // ---- what the runner owes Cain and the owner (sixth review): rounds.notices, once each by id ----
  private oweNotice(rounds: Rounds, n: Omit<OwedNotice, "state" | "at">): void {
    const all = rounds.notices ??= {};
    if (all[n.id]) return;
    all[n.id] = { ...n, state: "owed", at: this.now().toISOString() };
  }
  // Cain's owed notices into the relay queue, then marked sent (a crash between the two can say one twice, never
  // lose it). Sent notices older than 30 days are let go.
  deliverCain(): void {
    const file = this.cfg.roundsFile;
    const r = file ? readRounds(file) : null;
    if (!file || !r?.notices) return;
    let changed = false;
    const old = this.now().getTime() - 30 * 86_400_000;
    for (const [id, n] of Object.entries(r.notices)) {
      if (n.state === "sent" && Date.parse(n.at) < old) { delete r.notices[id]; changed = true; continue; }
      if (n.to !== "cain" || n.state !== "owed") continue;
      if (n.text) this.relay(n.text);
      n.state = "sent"; changed = true;
    }
    if (changed) writeRounds(file, r);
  }
  // The owner's owed notices, through the link (its words, its root socket). Seventh review: a notice stays owed in
  // the rounds file until the link acknowledges a successful chat post (its message id); owed ids are tried again
  // each tick under the link's own backoff (link_backoff: a minute, doubling to 15 minutes, cleared by any
  // acknowledgement), never GitHub's. The link keeps each id as posted only after its post succeeded and answers a
  // repeat with that message, so a retry after a lost acknowledgement, or after a restart mid-delivery, posts nothing
  // twice.
  async postOwedNotices(): Promise<void> {
    this.deliverCain();
    const file = this.cfg.roundsFile;
    if (!file || !this.deps.postNotice || this.capOff) return;
    const rounds = readRounds(file);
    if (!rounds?.notices) return;
    const bo = rounds.link_backoff;
    if (bo && this.now().getTime() < Date.parse(bo.next)) return;
    for (const [id, n] of Object.entries(rounds.notices)) {
      if (n.to !== "owner" || n.state !== "owed") continue;
      let msg: string | null = null;
      try { msg = await this.deps.postNotice(n); } catch (e) { this.log(`the notice ${id} didn't go: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
      const now = readRounds(file);
      const cur = now?.notices?.[id];
      if (!now || !cur || cur.state !== "owed") continue;
      if (msg) { Object.assign(cur, { state: "sent", message: msg }); delete now.link_backoff; }
      else {
        cur.tries = (cur.tries ?? 0) + 1;
        const delay = Math.min(Math.max(LINK_BACKOFF_MIN_MS, (now.link_backoff?.delay ?? 0) * 2), LINK_BACKOFF_MAX_MS);
        now.link_backoff = { next: new Date(this.now().getTime() + delay).toISOString(), delay };
      }
      writeRounds(file, now);
      if (msg) this.log(`the owner's notice ${id} went up`);
      else { this.log(`the link didn't acknowledge the notice ${id}; owed notices wait ${Math.round(now.link_backoff!.delay / 1000)} seconds`); return; }
    }
  }
  // 0.18.1 (sixth review): grants written by 0.18.0 carry no binding and 0.18.0 recorded no claims. Once, at the
  // runner's first tick after the update (tried again each tick until both files read): copies of both files go
  // beside them first (review-rounds.pre-0.18.1.json, review-grants.pre-0.18.1.json, root:cain 0640, for
  // review.sh sweep-dry-run), then each change group's rounds are replayed (grants.ts replayUnbound): each round
  // past the base cap debits one round from the earliest earlier pre-binding grant with rounds left, as a claim
  // on that round, and the rounds left over are let go (grants_void, why "unbound"), owed to Cain and to the owner
  // once a change. The claims, the voids, the notices owed and the done marker (replayed) are built in memory and
  // committed in one rename: a crash before it replays from scratch, and after it a restart changes nothing.
  // Seventh review: existing claims are reconciled first and never charged again or replaced; a plan that would charge
  // a round twice or meets an unclaimed round past the cap isn't committed (reported to Cain instead). The grants file
  // is only read: a grant the link writes meanwhile stays as the link wrote it.
  private replayed = false;
  replayOnce(): void {
    const file = this.cfg.roundsFile, gfile = this.cfg.grantsFile;
    if (this.replayed || !file || this.capOff || !gfile) return;
    const rounds = readRounds(file), g = this.grants();
    if (!rounds || !g) return;
    if (rounds.replayed) { this.replayed = true; return; }
    try {
      keepPreReplay(file, join(dirname(file), PRE_ROUNDS), this.cfg.preReplayOwner);
      keepPreReplay(gfile, join(dirname(gfile), PRE_GRANTS), this.cfg.preReplayOwner);
    } catch (e) { this.log(`the copies before the replay of earlier grants couldn't be written, so it waits: ${String((e as Error)?.message ?? e).slice(0, 120)}`); return; }
    const at = this.now().toISOString();
    const next = structuredClone(rounds);
    const plan = replayUnbound(next, g, this.roundCap, at);
    // The same plan the dry run (review.sh sweep-dry-run) prints, line for line.
    for (const l of planLines(plan, this.cfg.tz)) this.log(`replay plan: ${l}`);
    if (plan.refused) {
      // Seventh review: nothing is committed; reported once a start of the runner, and the dry run prints it too.
      this.replayed = true;
      this.relay(`The review runner's one-time replay of Dane's earlier grants (given before grants were bound to a commit) was not committed: ${planLines(plan, this.cfg.tz).join("; ")}. The rounds file is unchanged and those grants don't count until it's sorted out; review.sh sweep-dry-run prints the same plan. Log it as a Build item. Nothing to tell him.`);
      return;
    }
    const done = plan.decisions;
    const byKey = new Map<string, ReplayDecision[]>();
    for (const d of done) {
      byKey.set(d.rec.key, [...(byKey.get(d.rec.key) ?? []), d]);
    }
    for (const [key, list] of byKey) {
      const granted = list.reduce((n, d) => n + d.rec.rounds, 0), credited = list.reduce((n, d) => n + d.credited.length + d.claimed.length, 0);
      const unused = list.reduce((n, d) => n + d.unused, 0);
      const pr = list.find((d) => d.rec.pr)?.rec.pr ?? next.changes[key]?.pr ?? null;
      const s = (k: number) => (k === 1 ? "" : "s");
      this.oweNotice(next, { id: `cain-unbound:${key}`, to: "cain", kind: "unbound", key, pr, rounds: unused,
        text: `The review runner replayed Dane's earlier grants for ${key} (given before grants were bound to a commit) through the update: `
          + `${granted} round${s(granted)} granted, ${credited} credited to rounds past the base cap that needed ${credited === 1 ? "it" : "them"}`
          + (unused ? `, ${unused} unused and let go: they never count. He's told once, in the App's own words, that they were let go. If the change still needs rounds, ask him for a fresh grant with keeper.sh review-grant once its last round is done. Nothing else to tell him.`
            : ". Nothing was let go. Nothing to tell him.") });
      if (unused) this.oweNotice(next, { id: `unbound:${key}`, to: "owner", kind: "unbound", key, pr, rounds: unused });
    }
    next.replayed = at;
    this.deps.crashPoint?.("replay-commit");
    writeRounds(file, next);
    this.replayed = true;
    this.deliverCain();
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
  // a round blocked for privacy sent nothing and doesn't count. The cap's last round owes the owner one
  // decision card for the change when it left a serious finding, or when it was lost (round 2).
  private settleRound(r: Review): void {
    const file = this.cfg.roundsFile;
    if (!file || this.capOff || !r.change || r.rounded || !FINAL.includes(r.status)) return;
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
      const now = readRounds(file);
      if (!now?.changes[key]?.decision) continue;
      const cur = now.changes[key].decision!;
      if (msg) Object.assign(cur, { state: "posted", message: msg }); else cur.tries = (cur.tries ?? 0) + 1;
      writeRounds(file, now);
      if (msg) {
        this.relay(`The review cap is reached for ${key}: ${d.lost ? "its last round was lost (it never produced a result)" : `its last round left ${d.serious} serious finding${d.serious === 1 ? "" : "s"}`}, so the review service put one decision in front of Dane (ship it with that risk, or hold it). Start no other round for it, and don't ask him about it yourself; his tap comes to you like any tap. If it's a critical change whose fix needs more rounds, the only way is a grant: keeper.sh review-grant asks him, and only his tap grants them. Nothing to tell him.`);
      }
    }
  }

  async tick(): Promise<void> {
    try { this.recoverLost(); this.replayOnce(); await this.ingest(); await this.reviews(); }
    finally {
      if (this.publishOwed) this.publishReviewed();
      try { await this.postOwed(); } catch (e) { this.log(`owed decision cards: ${(e as Error).message}`); }
      try { await this.postOwedNotices(); } catch (e) { this.log(`owed notices: ${(e as Error).message}`); }
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
