// Cain 0.17.0, round 2 of the outside review's fixes: the plan reading off the link's event loop
// (plan-read.ts), the Build hook's budget and cold cache (hooks/remote-trigger.ts), the trust statement
// and the week's high-water mark (plan-usage.ts), the reset mark written first (link/cap.ts), the sweep's
// alarms (CapAlarms), the hold route's two counters (link/core.ts) and the Healthchecks ceilings
// (link/healthchecks.ts).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, readPlanUsage, writeCache } from "../rootfs/opt/cain/plan-usage.ts";
import { DEFAULT_ALLOWANCE_DERIVATION, DEFAULT_ALLOWANCE_SET_ON, decide as guardDecide, guardLines, PlanCacheAlarm, readings } from "../rootfs/opt/cain/guard.ts";
import { childEnv, PlanRefresher } from "../rootfs/opt/cain/plan-read.ts";
import { planWarmer } from "../rootfs/opt/cain/review/main.ts";
import { configFromEnv } from "../rootfs/opt/cain/review/config.ts";
import { DEFAULTS, Runner, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { BUILD, decideWithGuard, HOOK_BUDGET_MS } from "../rootfs/opt/cain/hooks/remote-trigger.ts";
import { CapAlarms, DecisionsPaused, HOLD, readDecided, readReset, recordDecision, resetOf } from "../rootfs/opt/cain/link/cap.ts";
import { CHECKS_PER_MINUTE, HOLDS_PER_MINUTE, REPLACED, RESET_TAP } from "../rootfs/opt/cain/link/core.ts";
import { routeAllowed } from "../rootfs/opt/cain/link/auth.ts";
import { linkRoutes } from "../rootfs/opt/cain/link/http.ts";
import { HC_CEILING_S, hcCall, setLine } from "../rootfs/opt/cain/link/healthchecks.ts";
import { keeperHolds, PR, rig } from "./link-rig";

const TZ = "America/New_York";
const NOW = new Date("2026-11-21T15:00:00Z");
const S = join(import.meta.dir, "..", "rootfs", "opt", "cain");
const msg = (ts: string, id: string, input: number, output: number) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, role: "assistant", usage: { input_tokens: input, output_tokens: output } } });
const projects = () => { const home = mkdtempSync(join(tmpdir(), "plan2-")); const dir = join(home, "projects"); mkdirSync(join(dir, "p"), { recursive: true }); return dir; };
const trustAll = () => true;
const reading = (o: Record<string, unknown>) => ({ fraction: 0.1, at: NOW.toISOString(), reason: "x", tokens_week: 10, files: 1, skipped: 0, complete: true, ...o }) as any;

// -- 1: the link's reading is off its event loop -----------------------------------------------------
const slowChild = (ms: number, out: Record<string, unknown>) => ["bun", "-e", `await Bun.sleep(${ms}); process.stdout.write(${JSON.stringify(JSON.stringify(out))});`];
const DEC = { id: "pr-5#3", key: "pr-5", round: 3, serious: 1, topic: "The round cap in code", finding: "a crash loses his tap", item: null, pr: PR, state: "owed" as const, at: "x" };
const ROUNDS = { format: 1, changes: { "pr-5": { rounds: [], decision: { ...DEC, state: "posted" as const } } } };
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "c2r-")), "review-decisions.json");

describe("fix 1: the link reads the plan in a child, with a time budget", () => {
  test("a tap is answered while a slow read is in flight", async () => {
    // Cain 0.19.1 retired the review cap's decision card, so the tap is on an ordinary ask card.
    const plan = new PlanRefresher({ cmd: slowChild(1500, reading({})), budgetMs: 4000, tz: TZ, log: () => {} });
    const r = rig({ holds: keeperHolds({}) });
    Object.assign((r.link as any).d, {
      guardHold: async () => { const p = await plan.read(); return p.fraction !== null && p.fraction < 0.5 ? { ok: true } : { ok: false, floor: "plan", why: p.reason }; },
    });
    const res: any = await r.link.ask({ text: "Pause the garden plan?", options: ["One", "Two"], item: "none" });
    expect(res.status).toBe("posted");
    let settled = false;
    const check = (r.link as any).guardHoldFor({ label: "other", what: "Build on claude/x" }, "cain").then((v: any) => { settled = true; return v; });
    await Bun.sleep(50);                                                       // the child is running now
    const t0 = performance.now();
    await r.tap(r.msg(res.message), r.ids(res.message)[0]);
    const took = performance.now() - t0;
    expect(settled).toBe(false);                                               // the read is still in flight
    expect(took).toBeLessThan(1000);
    expect(r.relayed.filter((l) => l.includes('Dane tapped "One"')).length).toBe(1);   // his tap was answered and relayed
    expect(await check).toEqual({ status: "passes" });
    expect(plan.started).toBe(1);
  });

  test("a read past its budget is not ready (held), goes on in the background, and the next call gets it", async () => {
    const plan = new PlanRefresher({ cmd: slowChild(700, reading({ week_start: "2026-11-15T05:00:00.000Z" })), budgetMs: 100, tz: TZ, now: () => NOW, log: () => {} });
    const first = await plan.read();
    expect(first).toMatchObject({ fraction: null, not_ready: "cache cold", complete: false });
    expect(first.reason).toStartWith("plan reading not ready: cache cold");
    expect(guardDecide("other", { plan: first, seats: [], floor: 25 }, NOW)).toMatchObject({ ok: false, notReady: "cache cold" });
    await Bun.sleep(900);
    expect((await plan.read()).fraction).toBe(0.1);                            // the child finished meanwhile: its reading
    expect(plan.started).toBe(2);                                              // (a new one was started, and runs long)
  });

  test("concurrent reads share one child", async () => {
    const plan = new PlanRefresher({ cmd: slowChild(300, reading({})), budgetMs: 3000, tz: TZ, log: () => {} });
    const all = await Promise.all([plan.read(), plan.read(), plan.read()]);
    expect(all.map((p) => p.fraction)).toEqual([0.1, 0.1, 0.1]);
    expect(plan.started).toBe(1);
    await plan.read();
    expect(plan.started).toBe(2);                                              // a later call starts a new one
  });

  test("a child that fails answers unknown; the child's environment has only the names it needs", async () => {
    const plan = new PlanRefresher({ cmd: ["bun", "-e", "process.exit(3)"], budgetMs: 3000, tz: TZ, log: () => {} });
    expect((await plan.read()).reason).toContain("didn't finish");
    expect(childEnv({ PATH: "/bin", HEALTHCHECKS_API_KEY: "k", REVIEW_GEMINI_KEY: "g", CHECKIN_TZ: TZ })).toEqual({ PATH: "/bin", CHECKIN_TZ: TZ });
  });

  test("the child itself: plan-read.ts prints a reading and keeps the cache", () => {
    const dir = projects();
    const home = join(dir, "..");
    mkdirSync(join(home, "h", ".claude"), { recursive: true });
    renameSync(dir, join(home, "h", ".claude", "projects"));
    writeFileSync(join(home, "h", ".claude", "projects", "p", "a.jsonl"), msg(new Date().toISOString(), "m1", 30, 10) + "\n");
    const settings = join(home, "settings.json"), cache = join(home, "cache.json");
    writeFileSync(settings, JSON.stringify({ format: 1, written_at: "x", round_cap: 3, reserve_percent: 25, caps: {}, review_limit: 1, weekly_allowance_tokens: 400 }));
    const r = spawnSync("bun", [join(S, "plan-read.ts")], { encoding: "utf8",
      env: { PATH: process.env.PATH!, CAIN_TEST_MODE: "1", CAIN_HOME: join(home, "h"), REVIEW_SETTINGS: settings, REVIEW_PLAN_CACHE: cache, CHECKIN_TZ: TZ } });
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ tokens_week: 40, fraction: 0.1, files: 1 });
    expect(existsSync(cache)).toBe(process.getuid?.() === 0);                 // root's parts keep it
  });

  test("the runner warms the cache at its start and when the week turns, and every 15 minutes between", () => {
    const calls: Date[] = [];
    let t = new Date("2026-11-21T15:00:00Z");
    const warm = planWarmer({ settingsFile: "/none", cacheFile: "/none/c.json", tz: TZ, alarm: new PlanCacheAlarm({ raise: () => {}, clear: () => {} }), log: () => {},
      now: () => t, read: ((o: any) => { calls.push(o.now); return reading({ cache_write: "ok" }); }) as any });
    expect(warm(true)).toBe(true);
    t = new Date(t.getTime() + 60_000);
    expect(warm()).toBe(false);
    t = new Date("2026-11-22T05:00:01Z");                                      // Sunday 00:00:01 New York: the week turned
    expect(warm()).toBe(true);
    t = new Date(t.getTime() + 15 * 60_000);
    expect(warm()).toBe(true);
    expect(calls.length).toBe(3);
    const main = readFileSync(join(S, "review", "main.ts"), "utf8");
    expect(main.indexOf("warm(true);")).toBeGreaterThan(0);
    expect(main.indexOf("warm(true);")).toBeLessThan(main.indexOf("while (true)"));
  });

  test("the link's wiring: the plan read through the refresher, its first reading at the start, the hold route awaited", () => {
    const main = readFileSync(join(S, "link", "main.ts"), "utf8");
    expect(main).toContain("const reading = label === \"other\" ? await plan.read() : null;");
    expect(main).toContain("void plan.read()");
    expect(readFileSync(join(S, "link", "http.ts"), "utf8")).toContain("json(await link.guardHoldFor(b, caller))");
  });
});

// -- 2: the Build hook on a cold cache ----------------------------------------------------------------
describe("fix 2: the Build hook's budget and a cold cache", () => {
  const holds = keeperHolds({ P1: { holder: "cain", branches: ["claude/x"] } });
  const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text: "Branch: claude/x\nLabel: other\nDo it." } } };
  const env = { stop: { stopped: false, at: null } };

  test("a part run as Cain reads nothing on a cold or missing cache; a warm one it reads", () => {
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    const cache = join(dir, "..", "cache.json");
    const cold = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: cache, coldOk: false, trustCache: trustAll });
    expect(cold).toMatchObject({ fraction: null, not_ready: "cache cold", files: 0 });
    expect(cold.reason).toStartWith("plan reading not ready: cache cold");
    // Root warms it; then the part run as Cain reads.
    expect(readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: cache, saveCache: true, trustCache: trustAll }).cache_write).toBe("ok");
    expect(readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: cache, coldOk: false, trustCache: trustAll })).toMatchObject({ fraction: 0.4 });
    // A cache the trust check refuses is cold too, and says why.
    const refused = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: cache, coldOk: false, trustCache: () => "owned by 1000:1000" });
    expect(refused).toMatchObject({ not_ready: "cache cold", cache_untrusted: `${cache}: owned by 1000:1000` });
  });

  test("a cold cache gives the named reason and a hold line, after asking the link first", async () => {
    const posts: (string | undefined)[] = [];
    const cold = () => ({ ok: false as const, floor: "plan", notReady: "cache cold", why: "plan reading not ready: cache cold (the cache is missing), which counts as below the 25% reserve floor" });
    const why = await decideWithGuard(call, holds, env, cold, async (_l, _w, hook) => { posts.push(hook); return hook ? { logged: true } : { logged: false, passes: true }; });
    expect(posts).toEqual([undefined, "cache cold"]);                          // the link first, then the hook's hold line
    expect(why).toContain("Held by the usage guard");
    expect(why).toContain("plan reading not ready: cache cold");
    expect(why).toContain("It's on the guard's log");
    expect(why).not.toContain("nothing bypasses");
  });

  test("after the link warms it, the hook's second reading lets it run; the link holding it is logged as the link's", async () => {
    let n = 0;
    const warming = () => (n++ === 0 ? { ok: false as const, floor: "plan", notReady: "cache cold", why: "plan reading not ready: cache cold" } : { ok: true as const });
    expect(await decideWithGuard(call, holds, env, warming, async () => ({ logged: false, passes: true }))).toBe("");
    const held = await decideWithGuard(call, holds, env, () => ({ ok: false, floor: "plan", notReady: "cache cold", why: "plan reading not ready: cache cold" }),
      async () => ({ logged: true, why: "the link's own" }));
    expect(held).toContain("plan reading not ready: cache cold");
    expect(held).toContain("It's on the guard's log");
    // The link silent: refused, not logged.
    const silent = await decideWithGuard(call, holds, env, () => ({ ok: false, floor: "plan", notReady: "cache cold", why: "plan reading not ready: cache cold" }),
      async () => ({ logged: false, why: "no answer" }));
    expect(silent).toContain("could not be logged");
  });

  test("the link writes the hook's hold line with its reason, without its own reading, and counts it as a hold", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const lines: string[] = [];
    let read = 0;
    // Round 3: only while the link's own refresher reports the same not-ready state (guard-allowance-r3.test.ts).
    Object.assign((r.link as any).d, { guardHold: () => { read++; return { ok: true }; }, holdLog: (l: string) => { lines.push(l); }, planNotReady: async () => "cache cold" });
    const v = await (r.link as any).guardHoldFor({ label: "other", what: "Build on claude/x", hook: "cache cold" }, "cain");
    expect(v.status).toBe("held");
    expect(read).toBe(0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("plan reading not ready: cache cold");
    await expect((r.link as any).guardHoldFor({ label: "core", what: "x", hook: "cache cold" }, "cain")).rejects.toThrow("only an other-labelled");
  });

  test("the hook's budget is under Claude Code's 15 seconds, and its reading asks for a warm cache", () => {
    expect(HOOK_BUDGET_MS).toBeLessThan(15_000);
    const settings = JSON.parse(readFileSync(join(S, "settings.json"), "utf8"));
    const t = JSON.stringify(settings.hooks).match(/remote-trigger\.ts[^}]*"timeout":\s*(\d+)/);
    expect(Number(t![1]) * 1000).toBeGreaterThan(HOOK_BUDGET_MS);
    const hook = readFileSync(join(S, "hooks", "remote-trigger.ts"), "utf8");
    expect(hook).toContain("coldOk: false");
    expect(hook).not.toContain("nothing bypasses it");
  });

  test("a failed cache write raises the alarm, at most hourly, and a good write clears it", () => {
    const raised: [string, string][] = [], cleared: string[] = [];
    let t = 0;
    const a = new PlanCacheAlarm({ raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g), log: () => {}, now: () => t });
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 3, 1) + "\n");
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 100, cacheFile: join(dir, "no-such-folder", "cache.json"), saveCache: true, trustCache: trustAll });
    expect(r.cache_write).toContain("couldn't be written");
    a.saw(r);
    expect(raised.map((x) => x[0])).toEqual(["review-plancache"]);
    expect(raised[0][1]).toContain("no-such-folder");
    t += 60_000; a.saw(r);
    expect(raised.length).toBe(1);                                             // rate-limited
    t += 3_600_000; a.saw(r);
    expect(raised.length).toBe(2);                                             // again after an hour
    a.saw({ cache_write: "ok", complete: true });
    expect(cleared).toContain("plancache");
    // The trust check refusing the cache raises it too.
    a.saw({ cache_untrusted: "/data/review-plan-cache.json: it is owned by 1000:1000, mode 0644, not 0:1000 0640" });
    expect(raised[2]).toEqual(["review-plancache", expect.stringContaining("trust check")]);
    // writeCache itself says why it failed, and writes whole otherwise.
    expect(writeCache(join(dir, "nope", "c.json"), { format: 1, week: 0, files: {} })).toContain("couldn't be written");
    expect(writeCache(join(dir, "c.json"), { format: 1, week: 0, files: {} }, () => {})).toBeNull();
  });

  test("notice.sh knows the plan cache and shrink alarms and their clearing", () => {
    const sh = join(S, "notice.sh");
    const text = (k: string) => spawnSync("bash", [sh, "text", k, "the cause"], { encoding: "utf8" }).stdout;
    expect(text("review-plancache")).toContain("couldn't keep its count");
    expect(text("review-planshrink")).toContain("went down");
    for (const k of ["review-plancache", "review-planshrink", "review-resetmark", "review-resetwrite"]) expect(text(k)).not.toContain("—");
  });
});

// -- 3: the trust statement, the high-water mark and the derivation ------------------------------------
describe("fix 3: what the count can be trusted for", () => {
  test("the trust statement is in plan-usage.ts, guard.ts and DOCS.md, and no 'nothing bypasses it' is left", () => {
    const plan = readFileSync(join(S, "plan-usage.ts"), "utf8");
    const guard = readFileSync(join(S, "guard.ts"), "utf8");
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    for (const t of [plan, guard, docs]) {
      expect(t).toMatch(/root's/);
      expect(t).toMatch(/not (being )?altered/);
      expect(t).toMatch(/this device's share/);
      expect(t.toLowerCase()).not.toContain("nothing bypasses");
      expect(t).not.toContain("no tap or flag that bypasses");
      expect(t).not.toContain("There's no tap or flag that gets around it");
    }
    expect(readFileSync(join(S, "CLAUDE.md"), "utf8")).not.toContain("nothing bypasses it");
  });

  test("a reading below the week's high-water mark is unknown, names what shrank, raises an alarm; the mark isn't lowered", () => {
    const dir = projects();
    const cache = join(dir, "..", "cache.json");
    writeFileSync(join(dir, "p", "a.jsonl"), [msg("2026-11-20T10:00:00Z", "m1", 300, 100), msg("2026-11-20T11:00:00Z", "m2", 50, 50)].join("\n") + "\n");
    writeFileSync(join(dir, "p", "b.jsonl"), msg("2026-11-20T12:00:00Z", "m3", 10, 0) + "\n");
    const o = { dir, now: NOW, tz: TZ, allowance: 10_000, cacheFile: cache, saveCache: true, trustCache: trustAll };
    expect(readPlanUsage(o)).toMatchObject({ tokens_week: 510, fraction: 0.051 });
    expect(loadCache(cache, Date.parse("2026-11-15T05:00:00.000Z"), trustAll).cache.hwm).toEqual({ tokens: 510, files: 2 });
    // Truncated: the tokens shrank.
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    const r = readPlanUsage(o);
    expect(r).toMatchObject({ fraction: null, tokens_week: 410 });
    expect(r.shrank).toContain("the tokens counted (410, below this week's mark of 510)");
    expect(guardDecide("other", { plan: r, seats: [], floor: 25 }, NOW)).toMatchObject({ ok: false });
    const raised: [string, string][] = [], cleared: string[] = [];
    const a = new PlanCacheAlarm({ raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g), log: () => {} });
    a.saw(r);
    expect(raised).toEqual([["review-planshrink", expect.stringContaining("tokens counted")]]);
    expect(loadCache(cache, Date.parse("2026-11-15T05:00:00.000Z"), trustAll).cache.hwm).toEqual({ tokens: 510, files: 2 });
    // A file deleted: the files seen shrank too.
    unlinkSync(join(dir, "p", "b.jsonl"));
    expect(readPlanUsage(o).shrank).toContain("the transcript files seen this week (1, below this week's mark of 2)");
    // Put back as it was: the count is back at its mark, and the alarm clears.
    writeFileSync(join(dir, "p", "a.jsonl"), [msg("2026-11-20T10:00:00Z", "m1", 300, 100), msg("2026-11-20T11:00:00Z", "m2", 50, 50)].join("\n") + "\n");
    writeFileSync(join(dir, "p", "b.jsonl"), msg("2026-11-20T12:00:00Z", "m3", 10, 0) + "\n");
    const back = readPlanUsage(o);
    expect(back.shrank).toBeUndefined();
    a.saw(back);
    expect(cleared).toContain("planshrink");
    // A new week starts a new mark.
    const nextWeek = readPlanUsage({ ...o, now: new Date("2026-11-23T15:00:00Z") });
    expect(nextWeek.shrank).toBeUndefined();
  });

  test("a part run as Cain reads the mark from the root-kept cache and holds a shrunk count too", () => {
    const dir = projects();
    const cache = join(dir, "..", "cache.json");
    writeFileSync(join(dir, "p", "a.jsonl"), [msg("2026-11-20T10:00:00Z", "m1", 300, 100), msg("2026-11-20T11:00:00Z", "m2", 50, 50)].join("\n") + "\n");
    readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 10_000, cacheFile: cache, saveCache: true, trustCache: trustAll });
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 10_000, cacheFile: cache, coldOk: false, trustCache: trustAll });
    expect(r.fraction).toBeNull();
    expect(r.shrank).toContain("tokens counted");
  });

  test("the settings record when and how the allowance was set, and review.sh guard prints both", () => {
    expect(configFromEnv({}).allowanceSetOn).toBe("2026-11-21");
    expect(DEFAULT_ALLOWANCE_DERIVATION).toBe("35 percent of the week used on the usage page against about 1.47 billion tokens since Sunday on this device");
    expect(configFromEnv({ PLAN_ALLOWANCE_SET_ON: "2026-12-06", PLAN_ALLOWANCE_DERIVATION: "40 percent\nagainst 2 billion" })).toMatchObject({ allowanceSetOn: "2026-12-06", allowanceDerivation: "40 percent against 2 billion" });
    expect(configFromEnv({ PLAN_ALLOWANCE_SET_ON: "Dec 6" }).allowanceSetOn).toBe(DEFAULT_ALLOWANCE_SET_ON);
    const d = mkdtempSync(join(tmpdir(), "der-"));
    const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(d, "q"), spendFile: join(d, "spend.json"), healthFile: join(d, "h.json"),
      termsFile: join(d, "t.txt"), recordQueue: join(d, "rq"), relayFile: join(d, "relay"), settingsFile: join(d, "settings.json") };
    new Runner(cfg, { seats: {}, now: () => NOW, log: () => {} } as any).writeSettings();
    expect(JSON.parse(readFileSync(cfg.settingsFile!, "utf8"))).toMatchObject({ weekly_allowance_tokens: 4_200_000_000, allowance_set_on: "2026-11-21",
      allowance_derivation: DEFAULT_ALLOWANCE_DERIVATION });
    writeFileSync(cfg.spendFile, "{}");
    const r = readings({ settingsFile: cfg.settingsFile!, spendFile: cfg.spendFile, tz: TZ, now: NOW, cacheFile: null,
      plan: () => reading({ fraction: 0.35, tokens_week: 1_470_000_000, allowance: 4_200_000_000, week_start: "2026-11-15T05:00:00.000Z" }) });
    const [first] = guardLines(r, NOW);
    expect(first).toContain("65% of the week's allowance left");
    expect(first).toContain(`the allowance was set 2026-11-21, from ${DEFAULT_ALLOWANCE_DERIVATION}`);
    // The run script hands both options to the runner alone, and config.yaml declares them.
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    expect(run).toContain('PLAN_ALLOWANCE_SET_ON="$(opt plan_allowance_set_on)"');
    expect(run).toContain('PLAN_ALLOWANCE_DERIVATION="$(opt plan_allowance_derivation)"');
    const yaml = readFileSync(join(import.meta.dir, "../config.yaml"), "utf8");
    expect(yaml).toContain('  plan_allowance_set_on: "2026-11-21"\n');
    expect(yaml).toContain("  plan_allowance_derivation: str?\n");
  });
});

// -- 4 and 5: the reset mark ---------------------------------------------------------------------------
const decisionRig = (file: string, extra: Record<string, unknown> = {}) => {
  const r = rig({ holds: keeperHolds({}) });
  const lines: string[] = [];
  Object.assign((r.link as any).d, {
    armed: () => JSON.stringify({ armed: { cain: "t", harness: "t" } }),
    decided: (id: string, c: string, at: number) => recordDecision(file, id, c, at, { sync: () => {} }),
    decisionsReset: () => (readdirSync(join(file, "..")).some((n) => n.includes(".corrupt-")) ? NaN : readReset(file)),
    holdLog: (l: string) => { lines.push(l); },
    rounds: () => ROUNDS,
    ...extra,
  });
  return { r, lines };
};
const removeAside = (file: string) => { for (const n of readdirSync(join(file, ".."))) if (n.includes(".corrupt-")) rmSync(join(file, "..", n)); };

describe("fix 4: the reset mark is written whole before the move-aside", () => {
  // Cain 0.19.1 retired the decision card (a tap on an old one writes nothing: cap-retired.test.ts), so this is
  // the file's rule alone: a crash on either side of the rename leaves the mark, and writes resume after.
  for (const side of ["before", "after"] as const) {
    test(`a crash ${side} the rename leaves the mark, and writes resume once the copy is gone`, () => {
      const file = tmpFile();
      writeFileSync(file, "{not json");
      const at = 1_700_000_000_000;
      const now = () => at;
      const crash = (from: string, to: string) => { if (side === "after") renameSync(from, to); throw new Error("crash"); };
      expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {}, now, moveAside: crash })).toThrow();
      expect(readReset(file)).toBe(at);                                        // the mark is there either way
      if (side === "before") {
        // The next write after the restart marks again and moves it aside.
        expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {}, now })).toThrow(DecisionsPaused);
        expect(readReset(file)).toBe(at);
      }
      removeAside(file);
      expect(recordDecision(file, "y#1", HOLD, 2, { sync: () => {} })).toMatchObject({ choice: HOLD, existed: false });
      expect(readReset(file)).toBe(at);
    });
  }

  test("a mark that can't be written leaves the file where it is and raises an alarm that says so", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json");
    const failed: string[] = [];
    const rename = (from: string, to: string) => { if (to === resetOf(file)) throw new Error("ENOSPC"); renameSync(from, to); };
    expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {}, rename, onMarkFailed: (w) => failed.push(w) })).toThrow("wasn't moved aside");
    expect(readFileSync(file, "utf8")).toBe("{not json");                     // still in place
    expect(readdirSync(join(file, "..")).filter((n) => n.includes(".corrupt-") || n.endsWith(".tmp"))).toEqual([]);
    expect(readReset(file)).toBeNull();
    expect(failed.length).toBe(1);
    expect(failed[0]).toContain(".reset couldn't be written");
    // CapAlarms raises it at once, and its sweep clears it once the file was moved aside.
    const raised: [string, string][] = [], cleared: string[] = [];
    const a = new CapAlarms({ decided: file, guardLog: join(file, "..", "guard.log"), raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g) });
    a.markFailed(failed[0]);
    expect(raised).toEqual([["review-resetwrite", failed[0]]]);
    a.sweep();
    expect(cleared).not.toContain("resetwrite");                               // the file still doesn't parse
    expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {} })).toThrow(DecisionsPaused);   // now it moves
    a.sweep();
    expect(cleared).toContain("resetwrite");
  });

  test("the order in the code: the mark, then the move", () => {
    const cap = readFileSync(join(S, "link", "cap.ts"), "utf8");
    const fn = cap.slice(cap.indexOf("export function recordDecision"));
    expect(fn.indexOf("writeWhole(resetOf(path)")).toBeLessThan(fn.indexOf("(o.moveAside ?? renameSync)(path, to)"));
  });
});

describe("fix 5: the sweep raises and clears the three alarms", () => {
  test("an unreadable decision, an unreadable hold log and an unreadable mark, each raised once and cleared once fixed", () => {
    const file = tmpFile();
    const log = join(file, "..", "review-guard.log");
    const raised: [string, string][] = [], cleared: string[] = [];
    // Round 3: the sweep first writes an unreadable mark again; here that write fails, so the alarm stands.
    const a = new CapAlarms({ decided: file, guardLog: log, raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g),
      rewriteMark: () => { throw new Error("EROFS"); } });
    a.sweep();                                                                 // all fine: each group cleared once at the start
    expect(raised).toEqual([]);
    expect(cleared.sort()).toEqual(["decision", "holdlog", "resetmark", "resetwrite"]);
    cleared.length = 0;
    writeFileSync(file, JSON.stringify({ "pr-5#3": { choice: "Ship it anyway", at: 1 } }));
    mkdirSync(log);                                                            // the log can't be read
    writeFileSync(resetOf(file), "garbage");
    a.sweep(); a.sweep();
    expect(raised.map((x) => x[0]).sort()).toEqual(["review-decision", "review-holdlog", "review-resetmark"]);
    expect(raised.find((x) => x[0] === "review-resetmark")![1]).toBe(resetOf(file));   // it names the mark file
    expect(raised.find((x) => x[0] === "review-decision")![1]).toBe("the decision pr-5#3");
    expect(cleared).toEqual([]);
    writeFileSync(file, JSON.stringify({ "pr-5#3": { choice: HOLD, at: 1 } }));
    rmSync(log, { recursive: true });
    unlinkSync(resetOf(file));                                                 // gone: decisions resume
    a.sweep(); a.sweep();
    expect(cleared.sort()).toEqual(["decision", "holdlog", "resetmark"]);
    // A mark that reads again clears it as well.
    writeFileSync(resetOf(file), "x"); a.sweep();
    writeFileSync(resetOf(file), "1234"); a.sweep();
    expect(cleared.filter((g) => g === "resetmark").length).toBe(2);
  });

  test("notice.sh's mark alarm names the file and how to clear it", () => {
    const out = spawnSync("bash", [join(S, "notice.sh"), "text", "review-resetmark", "/data/link/review-decisions.json.reset"], { encoding: "utf8" }).stdout;
    expect(out).toContain("/data/link/review-decisions.json.reset");
    // Round 3: never a delete; the command that writes it again (guard-allowance-r3.test.ts).
    expect(out).toContain("bun /opt/cain/link/cap.ts reset-mark");
    expect(out).toContain("clears once the mark reads again");
    const main = readFileSync(join(S, "link", "main.ts"), "utf8");
    expect(main).toContain("capAlarms.sweep();");
    expect(main).toContain("onMarkFailed: (why) => capAlarms.markFailed(why)");
  });
});

// -- 6: the hold route's two counters ------------------------------------------------------------------
describe("fix 6: only real holds count against the holds' cap", () => {
  test("seven passing checks in a minute pass and raise nothing", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const alarms: [string, string][] = [];
    Object.assign((r.link as any).d, { guardHold: () => ({ ok: true }), holdLog: () => {}, alarm: (k: string, c: string) => alarms.push([k, c]) });
    for (let i = 0; i < HOLDS_PER_MINUTE + 1; i++) expect(await (r.link as any).guardHoldFor({ label: "other", what: `Build ${i}` }, "cain")).toEqual({ status: "passes" });
    expect(alarms).toEqual([]);
  });

  test("checks have their own, higher limit and reason, with no alarm; real holds keep theirs", async () => {
    expect(CHECKS_PER_MINUTE).toBeGreaterThan(HOLDS_PER_MINUTE);
    const r = rig({ holds: keeperHolds({}) });
    const alarms: [string, string][] = [], lines: string[] = [];
    let ok = true;
    Object.assign((r.link as any).d, { guardHold: () => ok ? { ok: true } : { ok: false, floor: "plan", why: "low" }, holdLog: (l: string) => { lines.push(l); },
      alarm: (k: string, c: string) => alarms.push([k, c]) });
    const hold = (what: string) => (r.link as any).guardHoldFor({ label: "other", what }, "cain");
    for (let i = 0; i < CHECKS_PER_MINUTE; i++) await hold(`Build ${i}`);
    await expect(hold("one more")).rejects.toThrow(`more than ${CHECKS_PER_MINUTE} guard checks in a minute`);
    expect(alarms).toEqual([]);
    r.later(61_000);
    ok = false;
    for (let i = 0; i < HOLDS_PER_MINUTE; i++) expect((await hold(`Held ${i}`)).status).toBe("held");
    await expect(hold("Held 99")).rejects.toThrow(`more than ${HOLDS_PER_MINUTE} holds in a minute`);
    expect(lines.length).toBe(HOLDS_PER_MINUTE);
    expect(alarms.map((a) => a[0])).toEqual(["review-holds"]);
  });
});

// -- 7: the Healthchecks ceilings and the set line -----------------------------------------------------
const CHECK = { name: "cain heartbeat", grace: 900, timeout: 300, status: "up", last_ping: null,
  ping_url: "https://hc-ping.com/11111111-2222-3333-4444-555555555555", update_url: "https://healthchecks.io/api/v3/checks/11111111-2222-3333-4444-555555555555" };
const listing = () => new Response(JSON.stringify({ checks: [CHECK] }), { status: 200 });

describe("fix 7: the Healthchecks route, its ceilings and its set line", () => {
  test("the route refuses the specialist and root callers, and says no key set without one", async () => {
    expect(routeAllowed("specialist", "/hc")).toBe(false);
    expect(routeAllowed("root", "/hc")).toBe(false);
    expect(routeAllowed("cain", "/hc")).toBe(true);
    const r = rig({ holds: keeperHolds({}) });
    let asked = 0;
    const routes = linkRoutes({ link: r.link, toHarness: async () => true, hc: async () => { asked++; return { status: "ok", said: "x" }; } });
    const body = JSON.stringify({ cmd: "check", name: "cain heartbeat" });
    for (const caller of ["specialist", "root"] as const) {
      const res = await routes(new Request("http://l/hc", { method: "POST", body }), new URL("http://l/hc"), caller, body);
      expect(res.status).toBe(403);
    }
    expect(asked).toBe(0);
    const none = linkRoutes({ link: r.link, toHarness: async () => true });
    expect(await (await none(new Request("http://l/hc", { method: "POST", body }), new URL("http://l/hc"), "cain", body)).json()).toMatchObject({ said: "no key set" });
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, { key: () => "", logFile: null })).said).toContain("no key set");
  });

  test("grace and period each at most one hour: above it is refused with the ceiling named, before any call", async () => {
    expect(HC_CEILING_S).toBe(3600);
    let calls = 0;
    const f = (async () => { calls++; return listing(); }) as unknown as typeof fetch;
    const d = { key: () => "k", fetch: f, logFile: null, log: () => {} };
    const g = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 3601 }, d);
    expect(g).toMatchObject({ status: "refused" });
    expect(g.said).toContain("--grace is at most 3600 seconds (one hour)");
    const p = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600, period: "86400" }, d);
    expect(p.said).toContain("--period is at most 3600 seconds (one hour)");
    expect(calls).toBe(0);
    const ok = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 3600, period: 3600 },
      { ...d, fetch: (async (_u: string, i: any) => i.method === "GET" ? listing() : new Response(JSON.stringify({ ...CHECK, grace: 3600, timeout: 3600 }))) as any });
    expect(ok.status).toBe("ok");
  });

  test("a set the service takes is announced as one plain line with the name and the old and new values", async () => {
    const lines: string[] = [];
    const f = (async (_u: string, i: any) => i.method === "GET" ? listing() : new Response(JSON.stringify({ ...CHECK, grace: 600, timeout: 300 }))) as unknown as typeof fetch;
    await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, { key: () => "k", fetch: f, logFile: null, log: () => {}, announce: (l) => { lines.push(l); } });
    expect(lines).toEqual(['Cain set the Healthchecks.io check "cain heartbeat": grace 900 to 600 seconds, period 300 to 300 seconds.']);
    expect(setLine("odd—name\nx", { grace: 1, period: 2 }, { grace: 3, period: 4 })).toBe('Cain set the Healthchecks.io check "odd?name?x": grace 1 to 3 seconds, period 2 to 4 seconds.');
    const main = readFileSync(join(S, "link", "main.ts"), "utf8");
    expect(main).toContain("announce: async (line) => { link.relayLine(");
    expect(main).toContain("await link.notice(line, NOTICE_TIMEOUT_MS);");
  });

  test("the set call's failure paths: the service answering an error, the fetch throwing, a redirect; none is announced", async () => {
    const lines: string[] = [];
    const d = { key: () => "k", logFile: null, log: () => {}, announce: (l: string) => { lines.push(l); } };
    const err = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 },
      { ...d, fetch: (async (_u: string, i: any) => i.method === "GET" ? listing() : new Response(JSON.stringify({ error: "bad grace" }), { status: 400 })) as any });
    expect(err).toEqual({ status: "error", said: "Healthchecks.io answered 400 to the change: bad grace" });
    const thrown = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 },
      { ...d, fetch: (async (_u: string, i: any) => { if (i.method === "GET") return listing(); throw new Error("ECONNRESET"); }) as any });
    expect(thrown.status).toBe("error");
    expect(thrown.said).toContain("didn't answer the change");
    expect((await hcCall({ cmd: "check", name: "cain heartbeat" }, { ...d, fetch: (async () => { throw new Error("offline"); }) as any })).said).toContain("didn't answer");
    // A redirect, from a real server, with the real fetch: refused (redirect: "error"), never followed.
    let followed = 0;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
      if (new URL(req.url).pathname === "/elsewhere") { followed++; return listing(); }
      return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
    } });
    try {
      const red = await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, { ...d, api: `http://127.0.0.1:${srv.port}/api/v3` });
      expect(red.status).toBe("error");
      expect(red.said).toContain("didn't answer");
      expect(followed).toBe(0);
    } finally { srv.stop(true); }
    expect(lines).toEqual([]);
  });

  test("a child process the link starts has no key in its environment", () => {
    // Bun hands a child the environment its process started with, whatever is deleted later: that is why
    // the key comes from a root-only file. The link takes it, then starts children the ways it does.
    const dir = mkdtempSync(join(tmpdir(), "hckey-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "hc-secret-key\n", { mode: 0o600 });
    const script = `import { takeKey } from ${JSON.stringify(join(S, "link", "healthchecks.ts"))};
      import { runBounded } from ${JSON.stringify(join(S, "link", "spawn.ts"))};
      const k = takeKey(${JSON.stringify(keyFile)});
      const show = ["bun", "-e", "process.stdout.write(process.env.HEALTHCHECKS_API_KEY ?? 'none')"];
      const a = Bun.spawnSync(show).stdout.toString();
      const b = (await runBounded(show, process.env as any, 10000)).out;
      const c = require("node:child_process").execSync("printf %s \${HEALTHCHECKS_API_KEY:-none}").toString();
      process.stdout.write(JSON.stringify({ took: k === "hc-secret-key", a, b, c }));`;
    writeFileSync(join(dir, "s.ts"), script);
    const env = { ...process.env };
    delete env.HEALTHCHECKS_API_KEY;
    const r = spawnSync("bun", [join(dir, "s.ts")], { encoding: "utf8", env });
    expect(JSON.parse(r.stdout)).toEqual({ took: true, a: "none", b: "none", c: "none" });
    expect(r.stdout + r.stderr).not.toContain("hc-secret-key");
    // Even a name left in the environment is dropped from process.env (a missing file is no key).
    const e2: Record<string, string | undefined> = { HEALTHCHECKS_API_KEY: "x" };
    const { takeKey } = require("../rootfs/opt/cain/link/healthchecks.ts");
    expect(takeKey(join(dir, "none"), e2)).toBe("");
    expect(e2.HEALTHCHECKS_API_KEY).toBeUndefined();
  });
});
