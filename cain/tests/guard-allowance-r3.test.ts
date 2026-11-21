// Cain 0.17.0, round 3 of the outside review's fixes: the link's alarms detached from its event loop
// (capfiles.ts), the high-water mark merged as the maximum under the cache's lock (plan-usage.ts), the reset
// mark's way back without a delete (link/cap.ts), the alarm for a plan reader that keeps failing (guard.ts,
// plan-read.ts, review/main.ts), a fresh reading reused with its own reason (plan-read.ts), the hook's hold
// line checked against the link's own plan state (link/core.ts), the Healthchecks set line's alarm
// (link/healthchecks.ts) and the reset mark's temp files swept (link/cap.ts).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseAlarmDetached, noticeDetached } from "../rootfs/opt/cain/capfiles.ts";
import { loadCache, lockOf, readPlanUsage, takeLock } from "../rootfs/opt/cain/plan-usage.ts";
import { PlanCacheAlarm, READ_STUCK_MS, readFailure } from "../rootfs/opt/cain/guard.ts";
import { FRESH_MS, PlanRefresher } from "../rootfs/opt/cain/plan-read.ts";
import { planWarmer } from "../rootfs/opt/cain/review/main.ts";
import { ACTIVE_TEMP_MS, CapAlarms, HOLD, readDecided, readReset, recordDecision, RESET_MARK_COMMAND, resetOf, rewriteResetMark, sweepTemps } from "../rootfs/opt/cain/link/cap.ts";
import { HOLDS_PER_MINUTE, REPLACED, RESET_TAP } from "../rootfs/opt/cain/link/core.ts";
import { HcAnnounceAlarm, hcCall, lineTrouble, setLine } from "../rootfs/opt/cain/link/healthchecks.ts";
import { keeperHolds, PR, rig } from "./link-rig";

const TZ = "America/New_York";
const NOW = new Date("2026-11-21T15:00:00Z");
const WEEK = "2026-11-15T05:00:00.000Z";
const S = join(import.meta.dir, "..", "rootfs", "opt", "cain");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const msg = (ts: string, id: string, input: number, output: number) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, role: "assistant", usage: { input_tokens: input, output_tokens: output } } });
const projects = () => { const dir = join(tmp("plan3-"), "projects"); mkdirSync(join(dir, "p"), { recursive: true }); return dir; };
const trustAll = () => true;
const reading = (o: Record<string, unknown>) => ({ fraction: 0.1, at: NOW.toISOString(), reason: "x", tokens_week: 10, files: 1, skipped: 0, complete: true, week_start: WEEK, ...o });
// A child the test steers: it sleeps the seconds in one file, then prints the other (or exits with its code).
const steered = () => {
  const d = tmp("child-");
  const out = join(d, "out.json"), wait = join(d, "wait"), code = join(d, "code");
  writeFileSync(wait, "0"); writeFileSync(code, "0");
  return { cmd: ["bash", "-c", `sleep "$(cat ${wait})"; c="$(cat ${code})"; [ "$c" = 0 ] || exit "$c"; cat ${out}`],
    set: (o: { out?: unknown; wait?: number; code?: number }) => {
      if (o.out !== undefined) writeFileSync(out, JSON.stringify(o.out));
      if (o.wait !== undefined) writeFileSync(wait, String(o.wait));
      if (o.code !== undefined) writeFileSync(code, String(o.code));
    } };
};
const DEC = { id: "pr-5#3", key: "pr-5", round: 3, serious: 1, topic: "The round cap in code", finding: "a crash loses his tap", item: null, pr: PR, state: "owed" as const, at: "x" };
const ROUNDS = { format: 1, changes: { "pr-5": { rounds: [], decision: { ...DEC, state: "posted" as const } } } };
const tmpFile = () => join(tmp("c3r-"), "review-decisions.json");
const asideIn = (file: string) => readdirSync(join(file, "..")).some((n) => n.includes(".corrupt-"));
const decisionRig = (file: string) => {
  const r = rig({ holds: keeperHolds({}) });
  const lines: string[] = [];
  Object.assign((r.link as any).d, {
    armed: () => JSON.stringify({ armed: { cain: "t", harness: "t" } }),
    decided: (id: string, c: string, at: number) => recordDecision(file, id, c, at, { sync: () => {} }),
    decisionsReset: () => (asideIn(file) ? NaN : readReset(file)),
    holdLog: (l: string) => { lines.push(l); },
    rounds: () => ROUNDS,
  });
  return { r, lines };
};

// -- 1 --------------------------------------------------------------------------------------------------
describe("fix 1: the link's alarms never block its event loop", () => {
  test("a tap is answered in under a second while an alarm's notice script sleeps 5 seconds, raised by a completed child reading", async () => {
    const d = tmp("notice-");
    const started = join(d, "started"), done = join(d, "done");
    const bin = join(d, "notice.sh");
    writeFileSync(bin, `#!/bin/bash\necho "$@" > ${started}\nsleep 5\necho done > ${done}\n`);
    chmodSync(bin, 0o755);
    const logs: string[] = [];
    // As the link wires it (main.ts): the plan alarm raises through the detached form.
    const alarm = new PlanCacheAlarm({ log: (m) => logs.push(m), raise: (k, c) => raiseAlarmDetached(c, (m) => logs.push(m), k, bin), clear: () => {} });
    const child = steered();
    child.set({ out: reading({ cache_write: "the plan reader's cache /data/review-plan-cache.json couldn't be written (ENOSPC)" }) });
    const plan = new PlanRefresher({ cmd: child.cmd, budgetMs: 4000, tz: TZ, log: () => {}, onReading: (p) => alarm.saw(p), onAsk: () => alarm.asked() });
    const file = tmpFile();
    const t = decisionRig(file);
    const res = await t.r.link.decision(DEC) as any;
    const t0 = performance.now();
    await plan.read();                                                         // the child finished: its reading raised the alarm
    expect(performance.now() - t0).toBeLessThan(1500);
    for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(20);
    expect(readFileSync(started, "utf8")).toContain("tell review-plancache");  // notice.sh is running now
    const t1 = performance.now();
    await t.r.tap(t.r.msg(res.message), t.r.ids(res.message)[0]);
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(existsSync(done)).toBe(false);                                      // the notice is still asleep
    expect(readDecided(file)).toMatchObject({ "pr-5#3": { choice: HOLD } });   // his tap was kept and answered
    expect(t.r.answers().length).toBeGreaterThan(0);
  });

  test("a notice that fails is logged when it ends, and the call never waits for it", async () => {
    const logs: string[] = [];
    const t0 = performance.now();
    expect(noticeDetached(["tell", "review-files", "x"], "the alarm (review-files)", (m) => logs.push(m), join(tmp("none-"), "no-such-notice.sh"))).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
    for (let i = 0; i < 100 && !logs.length; i++) await Bun.sleep(20);
    expect(logs[0]).toContain("the alarm (review-files) didn't go yet (notice.sh 127)");
  });

  test("the link raises and clears every alarm through the detached forms, the plan alarm and the self-check included", () => {
    const main = readFileSync(join(S, "link", "main.ts"), "utf8");
    expect(main).toContain('import { clearAlarmDetached, raiseAlarmDetached, selfCheck } from "../capfiles";');
    expect(main).not.toMatch(/import \{[^}]*\b(raiseAlarm|clearAlarm)\b[^}]*\} from "\.\.\/capfiles"/);
    expect(main).toContain("new PlanCacheAlarm({ log: capLog, raise: (kind, cause) => raiseAlarm(cause, capLog, kind), clear: (group) => clearAlarm(capLog, group) })");
    expect(main).toContain("selfCheck({ log: capLog, ...selfAlarm })");
    expect(main).toContain("selfCheck({ log: capLog, prev: capOff, ...selfAlarm })");
    expect(main).not.toContain("spawnSync");
    const cap = readFileSync(join(S, "capfiles.ts"), "utf8");
    expect(cap).toContain('spawn("timeout", ["-k", "2", String(NOTICE_LIMIT_S), bin, ...args], { detached: true');
    expect(cap).toContain("c.unref();");
  });
});

// -- 2 --------------------------------------------------------------------------------------------------
describe("fix 2: the high-water mark is the maximum of every writer's, under the cache's lock", () => {
  test("two writers finishing out of order never lower the mark, and the one behind is unknown", () => {
    const dir = projects();
    const f = join(dir, "p", "a.jsonl");
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    const cache = join(dir, "..", "cache.json");
    const o = { dir, now: NOW, tz: TZ, allowance: 10_000, cacheFile: cache, saveCache: true, trustCache: trustAll };
    let second: any = null;
    // Writer one counts 400; before it writes, the transcript grows and writer two counts 900 and writes first.
    const first = readPlanUsage({ ...o, beforeSave: () => {
      appendFileSync(f, msg("2026-11-20T11:00:00Z", "m2", 400, 100) + "\n");
      second = readPlanUsage(o);
    } });
    expect(second).toMatchObject({ tokens_week: 900, fraction: 0.09, cache_write: "ok" });
    expect(loadCache(cache, Date.parse(WEEK), trustAll).cache.hwm).toEqual({ tokens: 900, files: 1 });
    expect(first.tokens_week).toBe(400);
    expect(first.fraction).toBeNull();                                         // below the durable mark: held
    expect(first.reason).toContain("behind a newer one");
    expect(first.shrank).toBeUndefined();                                      // a race, not a shrink: no alarm
    expect(loadCache(cache, Date.parse(WEEK), trustAll).cache.hwm).toEqual({ tokens: 900, files: 1 });   // still 900
    // The next reading catches up.
    expect(readPlanUsage(o)).toMatchObject({ tokens_week: 900, fraction: 0.09 });
  });

  test("the lock: a held lock makes a writer wait and give up, a stale one is taken over, and it's released", () => {
    const cache = join(tmp("lock-"), "cache.json");
    const release = takeLock(cache) as () => void;
    expect(typeof release).toBe("function");
    let t = 0;
    expect(takeLock(cache, { waitMs: 50, now: () => (t += 10), sleep: () => {} })).toBeNull();
    release();
    expect(existsSync(lockOf(cache))).toBe(false);
    writeFileSync(lockOf(cache), "dead.writer");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockOf(cache), old, old);
    const again = takeLock(cache, { waitMs: 50 }) as () => void;
    expect(typeof again).toBe("function");
    expect(readFileSync(lockOf(cache), "utf8")).not.toBe("dead.writer");
    again();
    expect(readdirSync(join(cache, ".."))).toEqual([]);                        // nothing left behind
    // A writer that can't have the lock writes nothing and says so.
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 3, 1) + "\n");
    const c2 = join(dir, "..", "c2.json");
    writeFileSync(lockOf(c2), "live");
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 100, cacheFile: c2, saveCache: true, trustCache: trustAll });
    expect(r.cache_write).toContain("couldn't be locked");
    expect(existsSync(c2)).toBe(false);
  });
});

// -- 3 --------------------------------------------------------------------------------------------------
describe("fix 3: the way back from an unreadable reset mark keeps the boundary", () => {
  for (const way of ["the sweep", "the root command"] as const) {
    test(`${way} writes the mark again with now; a card from before the reset is still refused and replaced`, async () => {
      const file = tmpFile();
      const t = decisionRig(file);
      const res = await t.r.link.decision(DEC) as any;                         // the old card
      t.r.later(60_000);
      writeFileSync(file, "{not json");
      const now = () => (t.r as any).t.now;
      expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {}, now })).toThrow();   // marked and moved aside
      expect(asideIn(file)).toBe(true);
      writeFileSync(resetOf(file), "garbage");                                 // the mark is corrupted
      expect(readReset(file)).toBeNaN();
      if (way === "the sweep") {
        const raised: string[] = [];
        new CapAlarms({ decided: file, guardLog: join(file, "..", "guard.log"), raise: (k) => raised.push(k), clear: () => {}, now }).sweep();
        expect(raised).toEqual([]);                                            // written again, no alarm
      } else {
        const r = spawnSync("bun", [join(S, "link", "cap.ts"), "reset-mark"], { encoding: "utf8",
          env: { ...process.env, CAIN_TEST_MODE: "1", CAIN_REVIEW_DECISIONS: file } });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("written again with the current time");
      }
      expect(readReset(file)).toBeGreaterThan(Number(t.r.msg(res.message).timestamp ? Date.parse(t.r.msg(res.message).timestamp) : 0));
      expect(existsSync(resetOf(file))).toBe(true);
      // The owner removes the moved-aside copy; the old card's tap is refused and replaced, not recorded.
      for (const n of readdirSync(join(file, ".."))) if (n.includes(".corrupt-")) rmSync(join(file, "..", n));
      t.r.later(60_000);
      await t.r.tap(t.r.msg(res.message), t.r.ids(res.message)[0]);
      expect(readDecided(file)).toEqual({});
      expect(String(t.r.msg(res.message).content)).toEndWith(REPLACED);
      expect(t.r.ephemerals().map((e) => e.content)).toEqual([RESET_TAP]);
      expect(t.r.relayed.filter((l) => l.includes("Dane tapped"))).toEqual([]);
    });
  }

  test("a mark the sweep can't write again raises the alarm, whose text names the command and never a delete", () => {
    const file = tmpFile();
    writeFileSync(resetOf(file), "garbage");
    const raised: [string, string][] = [];
    const a = new CapAlarms({ decided: file, guardLog: join(file, "..", "guard.log"), raise: (k, c) => raised.push([k, c]), clear: () => {},
      rewriteMark: () => { throw new Error("EROFS"); } });
    a.sweep(); a.sweep();
    expect(raised).toEqual([["review-resetmark", resetOf(file)]]);
    expect(readFileSync(resetOf(file), "utf8")).toBe("garbage");               // never removed
    const out = spawnSync("bash", [join(S, "notice.sh"), "text", "review-resetmark", resetOf(file)], { encoding: "utf8" }).stdout;
    expect(out).toContain(RESET_MARK_COMMAND);
    expect(out).toContain("Never remove the mark file");
    expect(out).not.toContain("rm /data/link/review-decisions.json.reset");
    expect(out).not.toContain("—");
    rewriteResetMark(file, 1234);
    expect(readReset(file)).toBe(1234);
  });
});

// -- 4 --------------------------------------------------------------------------------------------------
describe("fix 4: a plan reader that keeps failing raises its alarm", () => {
  test("an always-crashing child raises it after two in a row; a complete reading clears it", async () => {
    const raised: [string, string][] = [], cleared: string[] = [];
    const alarm = new PlanCacheAlarm({ raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g), log: () => {} });
    const child = steered();
    child.set({ code: 3 });
    const plan = new PlanRefresher({ cmd: child.cmd, budgetMs: 4000, tz: TZ, now: () => NOW, log: () => {}, onReading: (p) => alarm.saw(p), onAsk: () => alarm.asked() });
    const one = await plan.read();
    expect(one.failed).toContain("didn't finish");
    expect(raised).toEqual([]);
    await plan.read();
    expect(raised.map((x) => x[0])).toEqual(["review-planread"]);
    expect(raised[0][1]).toContain("2 plan readings in a row failed");
    expect(raised[0][1]).toContain("didn't finish");
    await plan.read();
    expect(raised.length).toBe(1);                                             // rate-limited
    child.set({ code: 0, out: reading({}) });
    await plan.read();
    expect(cleared).toContain("planread");
  });

  test("readings that are always out of time or incomplete count too, and half an hour of asking with none complete raises it", () => {
    expect(readFailure(reading({ not_ready: "out of time", fraction: null }))?.kind).toBe("time");
    expect(readFailure(reading({ complete: false, skipped: 3, fraction: null }))?.kind).toBe("incomplete");
    expect(readFailure(reading({}))).toBeNull();
    const raised: [string, string][] = [];
    let t = 0;
    const alarm = new PlanCacheAlarm({ raise: (k, c) => raised.push([k, c]), clear: () => {}, log: () => {}, now: () => t });
    alarm.asked();
    t += READ_STUCK_MS - 1; alarm.asked();
    expect(raised).toEqual([]);
    t += 2; alarm.asked();
    expect(raised.map((x) => x[0])).toEqual(["review-planread"]);
    expect(raised[0][1]).toContain("no complete plan reading");
  });

  test("the runner's warm counts a reader that throws, and a complete warm clears it", () => {
    const raised: string[] = [], cleared: string[] = [];
    const alarm = new PlanCacheAlarm({ raise: (k) => raised.push(k), clear: (g) => cleared.push(g), log: () => {} });
    let t = NOW.getTime(), fail = true;
    const warm = planWarmer({ settingsFile: "/nonexistent", cacheFile: "/nonexistent", tz: TZ, alarm, log: () => {}, now: () => new Date(t),
      read: (() => { if (fail) throw new Error("EIO"); return reading({ cache_write: "ok" }); }) as any });
    warm(true); warm(true);
    expect(raised).toEqual(["review-planread"]);
    fail = false; warm(true);
    expect(cleared).toContain("planread");
    const sh = readFileSync(join(S, "notice.sh"), "utf8");
    expect(sh).toContain("review-planread) echo planread ;;");
    const text = spawnSync("bash", [join(S, "notice.sh"), "text", "review-planread", "the cause"], { encoding: "utf8" }).stdout;
    expect(text).toContain("keeps failing");
    expect(text).not.toContain("—");
    expect(readFileSync(join(S, "link", "main.ts"), "utf8")).toContain("onAsk: () => planAlarm.asked()");
  });
});

// -- 5 --------------------------------------------------------------------------------------------------
describe("fix 5: a fresh reading is reused with its own reason", () => {
  test("an unknown reading's own reason during a long refresh; a numeric one still passes; nothing older than 2 minutes", async () => {
    let now = NOW.getTime();
    const child = steered();
    const unknown = reading({ fraction: null, reason: "the week's allowance isn't set (the App's option plan_weekly_allowance_tokens is 0)" });
    child.set({ out: unknown });
    const plan = new PlanRefresher({ cmd: child.cmd, budgetMs: 4000, tz: TZ, now: () => new Date(now), log: () => {} });
    expect((await plan.read()).reason).toContain("allowance isn't set");
    child.set({ wait: 1 });
    const during = await plan.read(100);                                       // the new one runs long
    expect(during.reason).toContain("allowance isn't set");
    expect(during.not_ready).toBeUndefined();
    await Bun.sleep(1200);
    child.set({ wait: 0, out: reading({}) });
    expect((await plan.read()).fraction).toBe(0.1);
    child.set({ wait: 1 });
    expect((await plan.read(100)).fraction).toBe(0.1);                         // a numeric one still passes
    await Bun.sleep(1200);
    expect((await plan.read()).fraction).toBe(0.1);                            // (settles the child)
    now += FRESH_MS + 1;
    const late = await plan.read(100);
    expect(late.not_ready).toBe("out of time");                                // older than 2 minutes: not reused
    expect(FRESH_MS).toBe(120_000);
    await Bun.sleep(1200);
  });
});

// -- 6 --------------------------------------------------------------------------------------------------
describe("fix 6: the hook's hold line only when the link's own plan state agrees", () => {
  test("the same not-ready state this week: written and counted as a hold", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const lines: string[] = [];
    Object.assign((r.link as any).d, { guardHold: () => ({ ok: true }), holdLog: (l: string) => { lines.push(l); }, planNotReady: async () => "cache cold" });
    const v = await (r.link as any).guardHoldFor({ label: "other", what: "Build on claude/x", hook: "cache cold" }, "cain");
    expect(v.status).toBe("held");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("plan reading not ready: cache cold");
  });

  test("a ready reading or another state: refused, logged, nothing written or counted, no alarm", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const lines: string[] = [], logs: string[] = [], alarms: string[] = [];
    let state: string | null = null;
    Object.assign((r.link as any).d, { guardHold: () => ({ ok: false, floor: "plan", why: "low" }), holdLog: (l: string) => { lines.push(l); },
      planNotReady: async () => state, alarm: (k: string) => alarms.push(k) });
    (r.link as any).log = (m: string) => logs.push(m);
    const hook = (h: string, i: number) => (r.link as any).guardHoldFor({ label: "other", what: `Build ${i}`, hook: h }, "cain");
    for (let i = 0; i <= HOLDS_PER_MINUTE; i++) await expect(hook("cache cold", i)).rejects.toThrow("the link's own plan reading is ready this week");
    state = "out of time";
    await expect(hook("cache cold", 99)).rejects.toThrow('is not ready as "out of time", not "cache cold"');
    expect(lines).toEqual([]);
    expect(alarms).toEqual([]);
    expect(logs.some((l) => l.includes("refused a hook's \"cache cold\" hold"))).toBe(true);
    // Nothing was counted toward the holds' cap: a real hold now is written.
    expect((await (r.link as any).guardHoldFor({ label: "other", what: "Real hold" }, "cain")).status).toBe("held");
    expect(lines.length).toBe(1);
  });

  test("the refresher reports its own not-ready state for this week, and the link asks it", async () => {
    const child = steered();
    child.set({ wait: 1, out: reading({}) });
    const plan = new PlanRefresher({ cmd: child.cmd, budgetMs: 100, tz: TZ, now: () => NOW, log: () => {} });
    expect(await plan.notReadyNow()).toBe("cache cold");
    await Bun.sleep(1200);
    expect(await plan.notReadyNow()).toBeNull();
    await Bun.sleep(1200);
    expect(readFileSync(join(S, "link", "main.ts"), "utf8")).toContain("planNotReady: () => plan.notReadyNow(),");
  });
});

// -- 7 --------------------------------------------------------------------------------------------------
const CHECK = { name: "cain heartbeat", grace: 900, timeout: 300, status: "up", last_ping: null,
  ping_url: "https://hc-ping.com/11111111-2222-3333-4444-555555555555", update_url: "https://healthchecks.io/api/v3/checks/11111111-2222-3333-4444-555555555555" };
const hcFetch = (name = CHECK.name) => (async (_u: string, i: any) => i.method === "GET"
  ? new Response(JSON.stringify({ checks: [{ ...CHECK, name }] }))
  : new Response(JSON.stringify({ ...CHECK, name, grace: 600 }))) as unknown as typeof fetch;

describe("fix 7: a Healthchecks set line that can't be posted raises an alarm", () => {
  test("the set line passes the message gate's own rules: no em dash, no ISO time, no ids", () => {
    const line = setLine("cain heartbeat", { grace: 900, period: 300 }, { grace: 600, period: 300 });
    expect(lineTrouble(line)).toBeNull();
    expect(line).not.toContain("—");
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(lineTrouble("Set at 2026-11-21T15:00:00Z.")).toContain("machine");
    expect(lineTrouble("Cain set it — now.")).toContain("dash");
    expect(lineTrouble("Discord message 123456789012345678 was set.")).toContain("machine");
  });

  test("a failed post raises the alarm naming the check, at most hourly; a posted line clears it", async () => {
    const raised: [string, string][] = [], cleared: string[] = [];
    let t = 0;
    const alarm = new HcAnnounceAlarm({ raise: (k, c) => raised.push([k, c]), clear: (g) => cleared.push(g), now: () => t });
    let fail = true;
    const d = { key: () => "k", fetch: hcFetch(), logFile: null, log: () => {},
      announce: async () => { if (fail) throw new Error("Discord didn't answer"); },
      announceFailed: (n: string, w: string) => alarm.failed(n, w), announced: () => alarm.posted() };
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, d)).status).toBe("ok");   // the set stands
    expect(raised).toEqual([["hc-announce", expect.stringContaining('the check "cain heartbeat": the link couldn\'t post its line')]]);
    t += 60_000;
    await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, d);
    expect(raised.length).toBe(1);                                             // rate-limited
    fail = false;
    await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, d);
    expect(cleared).toEqual(["hcset"]);
  });

  test("a line the gate's rules refuse isn't posted and raises the alarm", async () => {
    const posted: string[] = [], raised: string[] = [];
    const d = { key: () => "k", fetch: hcFetch("check 123456789012345678"), logFile: null, log: () => {},
      announce: async (l: string) => { posted.push(l); }, announceFailed: (_n: string, w: string) => raised.push(w) };
    await hcCall({ cmd: "set", name: "check 123456789012345678", grace: 600 }, d);
    expect(posted).toEqual([]);
    expect(raised[0]).toContain("the message gate's rules refuse its line (machine)");
    const main = readFileSync(join(S, "link", "main.ts"), "utf8");
    expect(main).toContain("announceFailed: (name, why) => hcAlarm.failed(name, why), announced: () => hcAlarm.posted()");
    const text = spawnSync("bash", [join(S, "notice.sh"), "text", "hc-announce", 'the check "cain heartbeat": x'], { encoding: "utf8" }).stdout;
    expect(text).toContain("cain heartbeat");
    expect(text).not.toContain("—");
  });
});

// -- 8 --------------------------------------------------------------------------------------------------
describe("fix 8: the sweep removes the reset mark's stale temp files, never an active write's", () => {
  test("stale ones of the decisions file and of its reset mark go; this process's, a live process's and a fresh one stay", () => {
    const file = tmpFile();
    const dir = join(file, "..");
    const dead = 999_999_9;
    const old = (Date.now() - ACTIVE_TEMP_MS - 60_000) / 1000;
    const make = (name: string, aged = true) => { const p = join(dir, name); writeFileSync(p, "x"); if (aged) utimesSync(p, old, old); return name; };
    make(`.review-decisions.json.reset.${dead}.tmp`);
    make(`.review-decisions.json.${dead}.tmp`);
    const mine = make(`.review-decisions.json.reset.${process.pid}.tmp`);
    const live = make(`.review-decisions.json.reset.${process.ppid}.tmp`);
    const fresh = make(`.review-decisions.json.reset.${dead + 1}.tmp`, false);
    const other = make(`.other.json.reset.${dead}.tmp`);
    expect(sweepTemps(file, () => {}, { alive: (pid) => pid === process.ppid })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([mine, live, fresh, other].sort());
    expect(readFileSync(join(S, "link", "main.ts"), "utf8")).toContain("selfCheck({ log: capLog, prev: capOff, ...selfAlarm });\n  sweepTemps(DECIDED, capLog);");
  });
});
