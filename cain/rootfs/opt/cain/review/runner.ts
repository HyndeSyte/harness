// The review runner: one record per review in /data/review-queue, moved forward
// one tick at a time. Seats run independently and in parallel; a down seat is
// retried with backoff, then stood in for by Claude (marked substituted, never
// counted as independent); a consequential review waits for two non-Claude
// families, retrying hourly for up to a day. Every step re-runs the privacy gate.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FINAL, JUDGES, LABEL, SEATS, STORED_BAD, SeatError, backoffMs, estimate, fixFor, independent, outbound, privacyCheck, recordRequest,
  relayLine, retryLimit, seatRun, type Brief, type ErrorKind, type Review, type SeatName, type SeatRun,
} from "./core.ts";
import type { SeatFn } from "./seats/common.ts";

export type RunnerConfig = {
  queueDir: string; spendFile: string; healthFile: string; termsFile: string; recordQueue: string; relayFile: string;
  caps: { gemini: number; perplexity: number; claude: number; openaiRuns: number };
  reviewLimit: number;
  timeoutS: Record<SeatName, number>;
  maxOut: Record<SeatName, number>;
  models: { gemini: string; geminiBig: string; perplexity: string; claude: string };
  hourlyS: number; tz: string;
};

export const DEFAULTS: Omit<RunnerConfig, "queueDir" | "spendFile" | "healthFile" | "termsFile" | "recordQueue" | "relayFile"> = {
  caps: { gemini: 8, perplexity: 4, claude: 30, openaiRuns: 200 },
  reviewLimit: 1.5,
  timeoutS: { openai: 600, gemini: 240, perplexity: 180, claude: 420 },
  maxOut: { openai: 0, gemini: 8_192, perplexity: 4_000, claude: 16_000 },
  models: { gemini: "gemini-3.8-flash", geminiBig: "gemini-4-argon", perplexity: "perplexity/sonar", claude: "claude-opus-5-5" },
  hourlyS: 3_600, tz: "America/New_York",
};

export type Unavailable = { kind: ErrorKind; detail: string } | null;
export type RunnerDeps = {
  seats: Partial<Record<SeatName, SeatFn>>;
  unavailable?: (seat: SeatName) => Unavailable;   // e.g. Codex not signed in
  now?: () => Date; rand?: () => number; log?: (m: string) => void;
};

export type SpendRow = { usd: number; runs: number; findings: number; searches: number };
export type Ledger = Record<string, Partial<Record<SeatName, SpendRow>>>;
export type Health = Partial<Record<SeatName, { ok: boolean; at: string; kind?: ErrorKind; detail?: string; fix?: string }>>;

const GROUNDING_FREE = 5_000, GROUNDING_USD = 0.014;   // Gemini 3+: 5,000 grounded searches a month free, then $14 / 1,000

export const SELFTEST: Brief = {
  id: "nightly-self-test", topic: "Nightly self-test", question: "Is the claim correct?",
  body: "Claim: 2 + 2 = 4. Approve if it is correct, with no findings.", needs_facts: false, consequential: false,
};

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export const reviewFile = (dir: string, id: string) => join(dir, `${id}.json`);
export function loadReview(dir: string, id: string): Review | null { return readJson<Review | null>(reviewFile(dir, id), null); }
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
    return usd + extra;
  }

  private fnFor(seat: SeatName): SeatFn | undefined { return this.deps.seats[seat]; }
  unavailable(seat: SeatName): Unavailable {
    if (!this.fnFor(seat)) return { kind: "unconfigured", detail: `no ${LABEL[seat]} key in the add-on's options` };
    return this.deps.unavailable?.(seat) ?? null;
  }
  private estModel(seat: SeatName, b: Brief): string {
    const m = this.cfg.models;
    return seat === "gemini" ? (b.consequential ? m.geminiBig : m.gemini) : seat === "perplexity" ? m.perplexity : m.claude;
  }
  // Monthly caps per seat, and the per-review limit, checked before every call.
  capCheck(seat: SeatName, b: Brief, spentThisReview: number, selftest = false): Unavailable {
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

  // ---- the loop ----
  async tick(): Promise<void> {
    mkdirSync(this.cfg.queueDir, { recursive: true });
    for (const name of readdirSync(this.cfg.queueDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const r = loadReview(this.cfg.queueDir, name.slice(0, -5));
      if (!r) continue;
      try {
        if (FINAL.includes(r.status)) { this.after(r); continue; }
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
      } catch (e) { this.log(`review ${r.id}: ${(e as Error).message}`); }
      r.updated_at = this.now().toISOString();
      saveReview(this.cfg.queueDir, r);
    }
  }

  async advance(r: Review): Promise<void> {
    // A queued brief is read back from disk, so it is checked again in full: the
    // allowlist (an old or edited brief with any other field is refused, not
    // sent), then the terms. No brief at all on an open review is refused too.
    if (!r.brief) return this.block(r, [STORED_BAD]);
    const g = privacyCheck(r.brief, this.terms());
    if (!g.ok) return this.block(r, g.why);
    for (let pass = 0; pass < 4; pass++) {
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
    const down = this.unavailable(s.seat) ?? this.capCheck(s.seat, b, r.cost_usd);
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
      const a = await Promise.race([fn({ brief: outbound(b), role: s.role, signal: ctl.signal, maxOutputTokens: this.cfg.maxOut[s.seat], day: this.day() }), deadline]);
      const cost = this.addSpend(s.seat, a.cost_usd, a.findings.length, a.searches ?? 0);
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
      this.log(`review ${r.id}: ${LABEL[s.seat]} is down (${s.error?.kind}); Claude stands in, marked substituted`);
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
    this.log(`review ${r.id}: ${status}`);
  }

  // Record first, then Cain's one line. Each happens once, even across restarts.
  private after(r: Review) {
    if (!r.recorded && r.brief && (r.status === "done" || r.status === "incomplete")) {
      const req = recordRequest(r);
      const stamp = this.now().toISOString().replace(/[-:]/g, "").slice(0, 15);
      writeAtomic(join(this.cfg.recordQueue, `${stamp}-${req.id}.json`), JSON.stringify(req));
      r.recorded = true;
      r.record_dir = req.ops[0].path.split("/").slice(0, 2).join("/");
    }
    if (!r.relayed) { this.relay(relayLine(r)); r.relayed = true; }
  }

  block(r: Review, why: string[]) {
    // Never sent, never recorded: the brief itself is dropped from the queue too.
    r.status = "blocked: privacy";
    r.blocked_why = why;
    r.brief = null;
    for (const s of r.seats) if (s.state !== "done") { s.state = "blocked"; delete s.next_at; }
    r.finished_at = this.now().toISOString();
    this.log(`review ${r.id}: blocked: privacy (${why.join("; ")})`);
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
    for (const seat of SEATS) {
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
