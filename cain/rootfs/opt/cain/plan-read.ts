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
      catch (e) { return { fraction: null, at: at(), tokens_week: null, files: 0, reason: `the plan reader couldn't start (${String(e).slice(0, 60)})` }; }
      const kill = setTimeout(() => { try { p.kill(9); } catch { /* gone */ } }, hard);
      try {
        const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]);
        const j = JSON.parse(out);
        if (code !== 0 || !j || typeof j !== "object" || typeof j.at !== "string") throw new Error(`exit ${code}`);
        return j as PlanReading;
      } catch (e) {
        return { fraction: null, at: at(), tokens_week: null, files: 0, reason: `the plan reader didn't finish (${String((e as Error)?.message ?? e).slice(0, 60)})` };
      } finally { clearTimeout(kill); }
    })();
  }

  // A reading within the budget, or "not ready". Never blocks the event loop: the reading is a child's.
  async read(budgetMs = this.o.budgetMs ?? BUDGET_MS): Promise<PlanReading> {
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
    if (sameWeek && this.last!.fraction !== null && now.getTime() - this.lastAt < (this.o.freshMs ?? FRESH_MS)) return this.last!;
    const cold = !sameWeek;
    const not_ready = cold ? "cache cold" : "out of time";
    (this.o.log ?? console.log)(`the plan reading took more than ${budgetMs} ms (${not_ready}); it goes on in the background`);
    return { fraction: null, at: now.toISOString(), tokens_week: null, files: 0, complete: false, not_ready,
      reason: `${NOT_READY}: ${not_ready} (the link's reading took more than ${Math.round(budgetMs / 100) / 10} s; it goes on and warms the cache)` };
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
