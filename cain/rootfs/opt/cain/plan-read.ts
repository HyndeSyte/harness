// The plan reading off the link's event loop (Cain 0.17.0, round 2 of the review fixes). The first reading
// after an install is cold (about 100 transcripts and 250 MB on the Pi's SD card), and the reader is
// synchronous: run inside the link it would hold up Discord's taps past their 3 seconds. So the link
// (root) runs it as a child process, this file's main, and waits at most a time budget for it:
//   - a reading that runs past the budget answers "plan reading not ready" (cache cold when no reading
//     has finished yet in this link, else out of time), which the guard holds; the child goes on, warms
//     the cache, and the next call gets its reading;
//   - calls while a reading is under way share it (one child at a time); while a new reading runs past the
//     budget, a finished one from the same week and the last FRESH_MS is answered instead;
//   - the child has a hard limit (PLAN_READ_HARD_MS, 9 minutes) past which it stops reading and keeps
//     what it read in the cache, and an environment of only the few names it needs (never a key).
// Round 3 of the review fixes: while a new reading runs past the budget, the finished one from the same week
// and the last FRESH_MS is answered whatever it said (a number, or unknown with its own reason: an allowance
// of 0, a count below the mark), never relabelled "out of time"; nothing older is reused. A child that
// fails (exits with an error, is killed at its hard limit, or prints no reading) comes back marked failed,
// and every finished reading goes to onReading and every reading asked to onAsk, so the plan alarm
// (guard.ts PlanCacheAlarm) hears a reader that keeps failing.
// The review runner (root) warms the same cache at its start and whenever the plan's week turns
// (review/main.ts), so the link's first reading after an install normally finds it warm.
import { readPlanUsage, NOT_READY, weekStart, type PlanReading } from "./plan-usage.ts";
import { paths as guardPaths, readSettings } from "./guard.ts";

export const BUDGET_MS = 2_000;               // the link's wait for a reading, well inside Discord's 3 seconds
export const HARD_MS = 9 * 60_000;
export const FRESH_MS = 2 * 60_000;            // how old a finished reading may be, answered while a new one runs long
const ENV_NAMES = /^(PATH|CHECKIN_TZ|CAIN_TEST_MODE|REVIEW_SETTINGS|REVIEW_PLAN_CACHE|REVIEW_SPEND|CAIN_HOME|PLAN_READ_HARD_MS)$/;
export const childEnv = (env: Record<string, string | undefined> = process.env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => ENV_NAMES.test(k) && typeof v === "string")) as Record<string, string>;

export type RefresherOpts = {
  cmd?: string[];                              // the child's command (tests give their own)
  budgetMs?: number; hardMs?: number; freshMs?: number;
  env?: Record<string, string>;
  tz?: string;
  now?: () => Date;
  onReading?: (p: PlanReading) => void;        // each finished reading (the cache alarm)
  onAsk?: () => void;                          // round 3: each reading asked (the alarm for a reader that keeps failing)
  log?: (m: string) => void;
};

export class PlanRefresher {
  private inflight: Promise<PlanReading> | null = null;
  private last: PlanReading | null = null;
  private lastAt = 0;
  started = 0;                                 // children started (tests: concurrent calls share one)
  constructor(private o: RefresherOpts = {}) {}

  private run(): Promise<PlanReading> {
    const cmd = this.o.cmd ?? ["bun", import.meta.path];
    const hard = this.o.hardMs ?? HARD_MS;
    const at = () => (this.o.now ?? (() => new Date()))().toISOString();
    this.started++;
    return (async (): Promise<PlanReading> => {
      let p: ReturnType<typeof Bun.spawn>;
      try { p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...(this.o.env ?? childEnv()), PLAN_READ_HARD_MS: String(hard - 30_000 > 0 ? hard - 30_000 : hard) } }); }
      catch (e) {
        const why = `the plan reader couldn't start (${String(e).slice(0, 60)})`;
        return { fraction: null, at: at(), tokens_week: null, files: 0, complete: false, failed: why, reason: why };
      }
      const kill = setTimeout(() => { try { p.kill(9); } catch { /* gone */ } }, hard);
      try {
        const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]);
        const j = JSON.parse(out);
        if (code !== 0 || !j || typeof j !== "object" || typeof j.at !== "string") throw new Error(`exit ${code}`);
        return j as PlanReading;
      } catch (e) {
        const why = `the plan reader didn't finish (${String((e as Error)?.message ?? e).slice(0, 60)})`;
        return { fraction: null, at: at(), tokens_week: null, files: 0, complete: false, failed: why, reason: why };
      } finally { clearTimeout(kill); }
    })();
  }

  // A reading within the budget, or "not ready". Never blocks the event loop: the reading is a child's.
  async read(budgetMs = this.o.budgetMs ?? BUDGET_MS): Promise<PlanReading> {
    try { this.o.onAsk?.(); } catch (e) { (this.o.log ?? console.log)(`the plan reading's alarm failed: ${String(e).slice(0, 80)}`); }
    if (!this.inflight) {
      const run = this.run().then((r) => {
        this.last = r; this.lastAt = (this.o.now ?? (() => new Date()))().getTime();
        try { this.o.onReading?.(r); } catch (e) { (this.o.log ?? console.log)(`the plan reading's alarm failed: ${String(e).slice(0, 80)}`); }
        return r;
      }).finally(() => { if (this.inflight === run) this.inflight = null; });
      this.inflight = run;
    }
    const run = this.inflight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), budgetMs); });
    try {
      const r = await Promise.race([run, late]);
      if (r) return r;
    } finally { clearTimeout(timer); }
    const now = (this.o.now ?? (() => new Date()))();
    const sameWeek = !!this.last && (this.last.week_start ?? "") === weekStart(now, this.o.tz ?? guardPaths().tz).toISOString();
    // Round 3: whatever the fresh reading said, with its own reason (not only a number).
    if (sameWeek && now.getTime() - this.lastAt < (this.o.freshMs ?? FRESH_MS)) return this.last!;
    const cold = !sameWeek;
    const not_ready = cold ? "cache cold" : "out of time";
    (this.o.log ?? console.log)(`the plan reading took more than ${budgetMs} ms (${not_ready}); it goes on in the background`);
    return { fraction: null, at: now.toISOString(), tokens_week: null, files: 0, complete: false, not_ready,
      reason: `${NOT_READY}: ${not_ready} (the link's reading took more than ${Math.round(budgetMs / 100) / 10} s; it goes on and warms the cache)` };
  }

  // Round 3: the not-ready state the refresher reports now for this week ("cache cold", "out of time"), or
  // null when its reading is ready (or another week's). The link writes the Build hook's own not-ready hold
  // line only when this names the same state (link/core.ts guardHoldFor).
  async notReadyNow(budgetMs?: number): Promise<string | null> {
    const r = await this.read(budgetMs);
    if (!r.not_ready) return null;
    const week = weekStart((this.o.now ?? (() => new Date()))(), this.o.tz ?? guardPaths().tz).toISOString();
    return r.week_start === undefined || r.week_start === week ? r.not_ready : null;
  }
}

if (import.meta.main) {
  const p = guardPaths();
  const settings = readSettings(p.settings);
  const hard = Number(process.env.PLAN_READ_HARD_MS ?? HARD_MS);
  const r = readPlanUsage({ now: new Date(), tz: p.tz, allowance: Number(settings?.weekly_allowance_tokens ?? 0), cacheFile: p.cache,
    saveCache: typeof process.getuid === "function" && process.getuid() === 0, deadline: Date.now() + (Number.isFinite(hard) && hard > 0 ? hard : HARD_MS) });
  process.stdout.write(JSON.stringify(r));
}
