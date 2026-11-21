// Cain 0.17.0: the usage guard reads the week's allowance (plan-usage.ts, guard.ts), the plan reader
// counts right, the cap build's follow-ups at the link (link/cap.ts, link/core.ts) and the Healthchecks
// key (link/healthchecks.ts, keeper.sh hc-check and hc-set).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countFile, lineUsage, MAX_FILES, readPlanUsage, weekStart } from "../rootfs/opt/cain/plan-usage.ts";
import { decide as guardDecide, DEFAULT_WEEKLY_ALLOWANCE, guardLines, LINK_DECIDES_BUILDS, readings } from "../rootfs/opt/cain/guard.ts";
import { configFromEnv } from "../rootfs/opt/cain/review/config.ts";
import { DEFAULTS, Runner, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { BUILD, decideWithGuard } from "../rootfs/opt/cain/hooks/remote-trigger.ts";
import { capPaths } from "../rootfs/opt/cain/capfiles.ts";
import { capStateFor, DecisionsPaused, HOLD, holdLogged, holdLogTrouble, HoldLogUnreadable, markHoldWritten, readDecided, readReset,
  recordDecision, resetOf, RISK, unreadableDecisions } from "../rootfs/opt/cain/link/cap.ts";
import { DECISIONS_PAUSED, HOLDS_PER_MINUTE, REPLACED, RESET_TAP, UNREADABLE_LINE } from "../rootfs/opt/cain/link/core.ts";
import { CAIN_ROUTES } from "../rootfs/opt/cain/link/auth.ts";
import { hcCall } from "../rootfs/opt/cain/link/healthchecks.ts";
import { keeperHolds, PR, rig } from "./link-rig";

const TZ = "America/New_York";
// Saturday Nov 21, 2026, 10:00 AM New York. The week started Sunday Nov 15 00:00 EST = 05:00Z.
const NOW = new Date("2026-11-21T15:00:00Z");
const WEEK = "2026-11-15T05:00:00.000Z";
const msg = (ts: string, id: string | null, input: number, output: number, cacheRead = 0) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { ...(id ? { id } : {}), role: "assistant",
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } } });
const projects = () => { const home = mkdtempSync(join(tmpdir(), "plan-")); const dir = join(home, "projects"); mkdirSync(join(dir, "p"), { recursive: true }); return dir; };
const trustAll = () => true;

describe("A: the plan's week starts Sunday 00:00 in the App's time zone", () => {
  test("the week's start, across days and a DST change", () => {
    expect(weekStart(NOW, TZ).toISOString()).toBe(WEEK);
    expect(weekStart(new Date("2026-11-15T05:00:00Z"), TZ).toISOString()).toBe(WEEK);            // Sunday 00:00 itself
    expect(weekStart(new Date("2026-11-15T04:59:59Z"), TZ).toISOString()).toBe("2026-11-08T05:00:00.000Z");   // Saturday 23:59:59
    // DST ended Sunday Nov 1, 2026 at 2 AM: that week started at 00:00 EDT (04:00Z).
    expect(weekStart(new Date("2026-11-04T12:00:00Z"), TZ).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    // DST began Sunday Mar 8, 2026: 00:00 that Sunday was still EST (05:00Z).
    expect(weekStart(new Date("2026-03-10T12:00:00Z"), TZ).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  test("a timestamp just before Sunday 00:00 local doesn't count, one just after does", () => {
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), [
      msg("2026-11-15T04:59:59.999Z", "msg_before", 1000, 0),
      msg("2026-11-15T05:00:00.000Z", "msg_at", 10, 0),
      msg("2026-11-15T05:00:00.001Z", "msg_after", 1, 0),
    ].join("\n") + "\n");
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 100, cacheFile: null });
    expect(r).toMatchObject({ tokens_week: 11, week_start: WEEK, files: 1, skipped: 0, complete: true });
    expect(r.fraction).toBeCloseTo(0.11);
  });

  test("the allowance divides the week's tokens; 0 means not set and the reading is unknown", () => {
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    expect(readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: null })).toMatchObject({ fraction: 0.4, tokens_week: 400, allowance: 1000 });
    const unset = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 0, cacheFile: null });
    expect(unset).toMatchObject({ fraction: null, tokens_week: 400 });
    expect(unset.reason).toContain("plan_weekly_allowance_tokens is 0");
    expect(readPlanUsage({ dir: join(dir, "none"), now: NOW, tz: TZ, allowance: 1000, cacheFile: null })).toMatchObject({ fraction: null, tokens_week: null });
  });

  test("the runner writes the allowance it uses, from the App's option, and the readers use the runner's number", () => {
    expect(configFromEnv({}).weeklyAllowance).toBe(DEFAULT_WEEKLY_ALLOWANCE);
    expect(DEFAULT_WEEKLY_ALLOWANCE).toBe(4_200_000_000);
    expect(configFromEnv({ PLAN_WEEKLY_ALLOWANCE_TOKENS: "0" }).weeklyAllowance).toBe(0);
    expect(configFromEnv({ PLAN_WEEKLY_ALLOWANCE_TOKENS: "123456" }).weeklyAllowance).toBe(123456);
    const d = mkdtempSync(join(tmpdir(), "allow-"));
    const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(d, "q"), spendFile: join(d, "spend.json"), healthFile: join(d, "h.json"),
      termsFile: join(d, "t.txt"), recordQueue: join(d, "rq"), relayFile: join(d, "relay"), settingsFile: join(d, "settings.json"), weeklyAllowance: 2000 };
    new Runner(cfg, { seats: {}, now: () => NOW, log: () => {} } as any).writeSettings();
    expect(JSON.parse(readFileSync(cfg.settingsFile!, "utf8")).weekly_allowance_tokens).toBe(2000);
    // readings() reads it from that file: 400 of 2000 is 20% used, 80% left.
    const dir = projects();
    writeFileSync(join(dir, "p", "a.jsonl"), msg("2026-11-20T10:00:00Z", "m1", 300, 100) + "\n");
    writeFileSync(cfg.spendFile, "{}");
    const r = readings({ settingsFile: cfg.settingsFile!, spendFile: cfg.spendFile, tz: TZ, now: NOW, cacheFile: null,
      plan: () => readPlanUsage({ dir, now: NOW, tz: TZ, allowance: JSON.parse(readFileSync(cfg.settingsFile!, "utf8")).weekly_allowance_tokens, cacheFile: null }) });
    expect(r.plan.fraction).toBeCloseTo(0.2);
    const [plan, rest] = guardLines(r, NOW);
    expect(plan).toContain("Plan: 80% of the week's allowance left");
    expect(plan).toContain(`400 tokens counted since ${WEEK}`);
    expect(plan).toContain("1 transcript file read, 0 skipped");
    expect(rest).toContain("other work may run");
    // A settings file with no allowance (from 0.16.0): unknown, held.
    const old = JSON.parse(readFileSync(cfg.settingsFile!, "utf8")); delete old.weekly_allowance_tokens;
    writeFileSync(cfg.settingsFile!, JSON.stringify(old));
    const r2 = readings({ settingsFile: cfg.settingsFile!, spendFile: cfg.spendFile, tz: TZ, now: NOW, cacheFile: null });
    expect(r2.plan.fraction).toBeNull();
  });

  test("the run script passes the option to the runner alone, and config.yaml declares it", () => {
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    expect(run).toContain('PLAN_WEEKLY_ALLOWANCE_TOKENS="$(opt plan_weekly_allowance_tokens)"');
    const cfg = readFileSync(join(import.meta.dir, "../config.yaml"), "utf8");
    expect(cfg).toContain("  plan_weekly_allowance_tokens: 4200000000\n");
    expect(cfg).toContain("  plan_weekly_allowance_tokens: int(0,1000000000000)\n");
  });
});

describe("B: the reader counts each message once, reads every file this week, and caches", () => {
  test("repeated lines for one message id count once, the largest usage seen", () => {
    const dir = projects();
    // One message written as three content blocks while it streamed: output grows 5, 40, 90.
    writeFileSync(join(dir, "p", "a.jsonl"), [
      msg("2026-11-20T10:00:00Z", "msg_A", 1000, 5, 20000),
      msg("2026-11-20T10:00:01Z", "msg_A", 1000, 40, 20000),
      msg("2026-11-20T10:00:02Z", "msg_A", 1000, 90, 20000),
      msg("2026-11-20T10:01:00Z", "msg_B", 7, 3),
      JSON.stringify({ type: "user", timestamp: "2026-11-20T10:00:00Z", message: { role: "user", content: "hi" } }),
      "not json", "{}",
    ].join("\n") + "\n");
    // A resumed session repeats msg_A in another file: still once.
    writeFileSync(join(dir, "p", "b.jsonl"), msg("2026-11-20T10:00:02Z", "msg_A", 1000, 90, 20000) + "\n");
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1_000_000, cacheFile: null });
    expect(r.tokens_week).toBe(1000 + 90 + 20000 + 7 + 3);
    expect(r.files).toBe(2);
    expect(lineUsage(msg("2026-11-20T10:00:00Z", "x", 1, 2), 0)).toEqual({ id: "x", tokens: 3 });
  });

  test("subagent transcripts under the same folder count", () => {
    const dir = projects();
    mkdirSync(join(dir, "p", "session-1", "subagents"), { recursive: true });
    writeFileSync(join(dir, "p", "session-1.jsonl"), msg("2026-11-20T10:00:00Z", "main", 10, 0) + "\n");
    writeFileSync(join(dir, "p", "session-1", "subagents", "agent-a.jsonl"), msg("2026-11-20T10:00:00Z", "sub", 5, 0) + "\n");
    expect(readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 100, cacheFile: null })).toMatchObject({ tokens_week: 15, files: 2 });
  });

  test("a big file is read whole, line by line: no byte bound stops the count", () => {
    const dir = projects();
    const f = join(dir, "p", "big.jsonl");
    const pad = "x".repeat(3000);
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) lines.push(JSON.stringify({ timestamp: "2026-11-20T10:00:00Z", message: { id: `m${i}`, usage: { input_tokens: 1, output_tokens: 1 } }, pad }));
    writeFileSync(f, lines.join("\n") + "\n");                                  // about 12 MB, read in 1 MB chunks
    expect(statSync(f).size).toBeGreaterThan(10_000_000);
    expect(readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1_000_000, cacheFile: null })).toMatchObject({ tokens_week: 8000, complete: true });
  });

  test("files past the bound are skipped, and a skipped file makes the reading incomplete and unknown", () => {
    const dir = projects();
    for (let i = 0; i < 4; i++) {
      const f = join(dir, "p", `f${i}.jsonl`);
      writeFileSync(f, msg("2026-11-20T10:00:00Z", `m${i}`, 10, 0) + "\n");
      const t = new Date(NOW.getTime() - (i + 1) * 60_000);
      utimesSync(f, t, t);
    }
    // An old file (changed before the week's start) isn't a candidate at all.
    const old = join(dir, "p", "old.jsonl");
    writeFileSync(old, msg("2026-11-01T10:00:00Z", "old", 5000, 0) + "\n");
    utimesSync(old, new Date("2026-11-02"), new Date("2026-11-02"));
    const r = readPlanUsage({ dir, now: NOW, tz: TZ, allowance: 1000, cacheFile: null, maxFiles: 3 });
    expect(r).toMatchObject({ fraction: null, files: 3, skipped: 1, complete: false, tokens_week: 30 });
    expect(r.reason).toContain("1 transcript file changed this week wasn't counted");
    expect(guardDecide("other", { plan: r, seats: [], floor: 25 }, NOW)).toMatchObject({ ok: false, floor: "plan" });
    expect(guardLines({ plan: r, seats: [], floor: 25 }, NOW)[0]).toContain("3 transcript files read, 1 skipped");
    // Even a reading with a fraction, if marked incomplete, holds other work.
    expect(guardDecide("other", { plan: { ...r, fraction: 0.1 }, seats: [], floor: 25 }, NOW)).toMatchObject({ ok: false, floor: "plan" });
    expect(MAX_FILES).toBe(1000);
  });

  test("the cache: an unchanged file is not read again, a grown one is read on, a rewritten one is read whole", () => {
    const dir = projects();
    const cache = join(dir, "..", "cache.json");
    const f = join(dir, "p", "a.jsonl");
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "m1", 100, 0) + "\n");
    const o = { dir, now: NOW, tz: TZ, allowance: 10_000, cacheFile: cache, saveCache: true, trustCache: trustAll };
    expect(readPlanUsage(o).tokens_week).toBe(100);
    const kept = JSON.parse(readFileSync(cache, "utf8"));
    expect(kept.files[f]).toMatchObject({ size: statSync(f).size, msgs: { m1: 100 } });
    // Same size and mtime, different bytes: the cached count is used, so the file wasn't read.
    const st = statSync(f);
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "m9", 900, 0) + "\n");
    utimesSync(f, st.atime, st.mtime);
    expect(readPlanUsage(o).tokens_week).toBe(100);
    // Put it back, then let it grow: read on from where the cache stopped.
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "m1", 100, 0) + "\n");
    appendFileSync(f, msg("2026-11-20T11:00:00Z", "m2", 5, 0) + "\n");
    expect(readPlanUsage(o).tokens_week).toBe(105);
    // A half-written last line waits for its new line.
    appendFileSync(f, msg("2026-11-20T12:00:00Z", "m3", 1, 0).slice(0, 20));
    expect(readPlanUsage(o).tokens_week).toBe(105);
    appendFileSync(f, msg("2026-11-20T12:00:00Z", "m3", 1, 0).slice(20) + "\n");
    expect(readPlanUsage(o).tokens_week).toBe(106);
    // Rewritten (the bytes before the cached point differ): read whole.
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "z1", 7, 0) + "\n" + msg("2026-11-20T10:00:00Z", "z2", 7, 0) + "\n".repeat(400));
    expect(readPlanUsage(o).tokens_week).toBe(14);
    // A cache Cain's user could write is never trusted (the default check wants root's and no other writer).
    writeFileSync(cache, JSON.stringify({ format: 1, week: Date.parse(WEEK), files: { [f]: { ...kept.files[f], size: statSync(f).size, mtime: statSync(f).mtimeMs, msgs: { fake: 1 } } } }));
    chmodSync(cache, 0o666);
    expect(readPlanUsage({ ...o, trustCache: undefined, saveCache: false }).tokens_week).toBe(14);
  });

  test("countFile keeps the largest usage per id when reading on", () => {
    const dir = projects();
    const f = join(dir, "p", "a.jsonl");
    writeFileSync(f, msg("2026-11-20T10:00:00Z", "m", 1, 5) + "\n");
    const first = countFile(f, 0);
    appendFileSync(f, msg("2026-11-20T10:00:00Z", "m", 1, 50) + "\n" + msg("2026-11-20T10:00:00Z", "m", 1, 2) + "\n");
    expect(countFile(f, 0, first).msgs).toEqual({ m: 51 });
  });

  test("the cache's path is a constant, moved only in test mode", () => {
    expect(capPaths({ REVIEW_PLAN_CACHE: "/tmp/x" }).planCache).toBe("/data/review-plan-cache.json");
    expect(capPaths({ REVIEW_PLAN_CACHE: "/tmp/x", CAIN_TEST_MODE: "1" }).planCache).toBe("/tmp/x");
  });
});

describe("the link decides every other-labelled Build run", () => {
  const holds = keeperHolds({ P1: { holder: "cain", branches: ["claude/x"] } });
  const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text: "Branch: claude/x\nLabel: other\nDo it." } } };
  const env = { stop: { stopped: false, at: null } };
  const pass = () => ({ ok: true as const });

  test("LINK_DECIDES_BUILDS is on, and the hook asks the link even when its own reading passes", async () => {
    expect(LINK_DECIDES_BUILDS).toBe(true);
    let asked = 0;
    expect(await decideWithGuard(call, holds, env, pass, async () => { asked++; return { logged: false, passes: true }; })).toBe("");
    expect(asked).toBe(1);
    // The link's reading holds it: refused, on the guard's log.
    const held = await decideWithGuard(call, holds, env, pass, async () => ({ logged: true, why: "the plan has 10% left" }));
    expect(held).toContain("Held by the usage guard");
    expect(held).toContain("the link's reading holds it");
    expect(held).toContain("It's on the guard's log");
    // The link didn't answer: refused (fail closed), saying it isn't logged.
    const silent = await decideWithGuard(call, holds, env, pass, async () => ({ logged: false, why: "no answer" }));
    expect(silent).toContain("Held by the usage guard");
    expect(silent).toContain("could not be logged");
  });

  test("core, commitment and necessary-fix runs never ask the link", async () => {
    let asked = 0;
    const c = { ...call, tool_input: { ...call.tool_input, body: { text: "Branch: claude/x\nLabel: necessary-fix\nDo it." } } };
    expect(await decideWithGuard(c, holds, env, () => ({ ok: false, floor: "plan", why: "x" }), async () => { asked++; return { logged: false }; })).toBe("");
    expect(asked).toBe(0);
  });
});

// -- C: the cap build's follow-ups ----------------------------------------------------------------
const DEC = { id: "pr-5#3", key: "pr-5", round: 3, serious: 1, topic: "The round cap in code", finding: "a crash loses his tap", item: null, pr: PR, state: "owed" as const, at: "x" };
const ROUNDS = { format: 1, changes: { "pr-5": { rounds: [], decision: { ...DEC, state: "posted" as const } } } };
const decisionRig = (file: string, extra: Record<string, unknown> = {}) => {
  const r = rig({ holds: keeperHolds({}) });
  const lines: string[] = [], alarms: [string, string][] = [];
  Object.assign((r.link as any).d, {
    armed: () => JSON.stringify({ armed: { cain: "t" } }),                 // not armed for Harness: a risk tap is held
    decided: (id: string, c: string, at: number) => recordDecision(file, id, c, at, { sync: () => {} }),
    holdWritten: (id: string) => markHoldWritten(file, id, { sync: () => {} }),
    decisionsReset: () => readReset(file),
    holdLog: (l: string) => { lines.push(l); },
    hasHold: (tag: string, what: string) => lines.some((l) => l.split("\t")[1] === tag && l.split("\t")[2] === what),
    alarm: (k: string, c: string) => alarms.push([k, c]),
    rounds: () => ROUNDS,
    ...extra,
  });
  return { r, lines, alarms };
};
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "c-")), "review-decisions.json");

describe("C1: a stored choice outside the card's options fails closed", () => {
  test("no relay, no hold line, the card marked unreadable, an alarm naming the decision", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ "pr-5#3": { choice: "Ship it anyway", at: 1 } }));       // hand-edited
    const t = decisionRig(file);
    const res = await t.r.link.decision(DEC) as any;
    const [hold] = t.r.ids(res.message);
    expect(await (t.r.tap(t.r.msg(res.message), hold))).toBeDefined();
    expect(t.r.relayed.filter((l) => l.includes("Dane tapped"))).toEqual([]);
    expect(t.lines).toEqual([]);
    expect(String(t.r.msg(res.message).content)).toEndWith(UNREADABLE_LINE);
    expect(t.r.state().messages[res.message]).toMatchObject({ outcome: "expired", why: "stored answer unreadable" });
    expect(t.r.state().messages[res.message].q!.used).toBe(true);
    expect(t.alarms).toEqual([["review-decision", "the decision for pr-5 (pr-5#3)"]]);
    // The file is left as it was, and the cap's state for the change is unknown (no Ship card).
    expect(readDecided(file)).toEqual({ "pr-5#3": { choice: "Ship it anyway", at: 1 } });
    expect(capStateFor(PR, ROUNDS, readDecided(file))).toMatchObject({ state: "unknown" });
    expect(unreadableDecisions(readDecided(file))).toEqual(["pr-5#3"]);
    expect(unreadableDecisions({ a: { choice: HOLD, at: 1 }, b: { choice: RISK, at: 1 } })).toEqual([]);
  });
});

describe("C2: the hold line's duplicate check", () => {
  test("a guard log that can't be read raises an alarm and writes nothing on a guess", async () => {
    const file = tmpFile();
    recordDecision(file, "pr-5#3", RISK, 1, { sync: () => {} });               // kept before a crash, card never marked
    const t = decisionRig(file, { hasHold: () => { throw new HoldLogUnreadable("/data/review-guard.log can't be read (EACCES)"); } });
    const res = await t.r.link.decision(DEC) as any;
    const [, risk] = t.r.ids(res.message);
    await t.r.tap(t.r.msg(res.message), risk);
    expect(t.lines).toEqual([]);
    expect(t.alarms.map((a) => a[0])).toEqual(["review-holdlog"]);
    const relay = t.r.relayed.filter((l) => l.includes("Dane tapped"));
    expect(relay.length).toBe(1);
    expect(relay[0]).toContain("The guard's log can't be read");
  });

  test("the hold-written flag on the record stops a second line, even when the log can't tell", async () => {
    const file = tmpFile();
    const t = decisionRig(file, { hasHold: () => false });                     // the log never tells
    const res = await t.r.link.decision(DEC) as any;
    const [, risk] = t.r.ids(res.message);
    await t.r.tap(t.r.msg(res.message), risk);
    expect(t.lines.length).toBe(1);
    expect(readDecided(file)!["pr-5#3"]).toMatchObject({ choice: RISK, hold_written: true });
    // A retried tap after a crash (the card unmarked again): no second line.
    const s = t.r.state(); s.messages[res.message].q!.used = false; (t.r.link as any).d.save(s);
    await t.r.tap(t.r.msg(res.message), risk);
    expect(t.lines.length).toBe(1);
    expect(recordDecision(file, "pr-5#3", HOLD, 9, { sync: () => {} })).toEqual({ choice: RISK, at: expect.any(Number), existed: true, hold_written: true });
  });

  test("holdLogged throws on an unreadable log; a missing one is just empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "c2-"));
    const log = join(dir, "guard.log");
    expect(holdLogged(log, "review-cap", "x")).toBe(false);
    expect(holdLogTrouble(log)).toBeNull();
    mkdirSync(log);                                                            // a folder where the log should be: EISDIR
    expect(() => holdLogged(log, "review-cap", "x")).toThrow(HoldLogUnreadable);
    expect(holdLogTrouble(log)).toContain("can't be read");
  });

  test("notice.sh knows the two new alarms and their clearing", () => {
    const sh = join(import.meta.dir, "../rootfs/opt/cain/notice.sh");
    const text = (k: string) => spawnSync("bash", [sh, "text", k, "the decision for pr-5"], { encoding: "utf8" }).stdout;
    expect(text("review-decision")).toContain("isn't one of that card's two choices");
    expect(text("review-holdlog")).toContain("couldn't be read");
    for (const k of ["review-decision", "review-holdlog"]) expect(text(k)).not.toContain("—");
  });
});

describe("C3: while a moved-aside file stands, and after writes resume on a fresh one", () => {
  test("a tap while the moved-aside copy stands says decisions are paused and points to the alarm", async () => {
    const file = tmpFile();
    writeFileSync(file, "{not json");
    const t = decisionRig(file, { decisionsReset: () => null });
    const res = await t.r.link.decision(DEC) as any;
    const [hold] = t.r.ids(res.message);
    await t.r.tap(t.r.msg(res.message), hold);                                 // moves it aside
    expect(t.r.ephemerals().map((e) => e.content)).toEqual([DECISIONS_PAUSED]);
    await t.r.tap(t.r.msg(res.message), hold);                                 // the copy stands
    expect(t.r.ephemerals().map((e) => e.content)).toEqual([DECISIONS_PAUSED, DECISIONS_PAUSED]);
    expect(DECISIONS_PAUSED).toContain("alarm");
    expect(t.r.state().messages[res.message].q!.used).toBe(false);
    expect(t.r.relayed.filter((l) => l.includes("Dane tapped"))).toEqual([]);
    expect(() => recordDecision(file, "pr-5#3", HOLD, 1, { sync: () => {} })).toThrow(DecisionsPaused);
    // The link's own reading of the reset mark says paused (NaN) while a copy stands (main.ts).
    expect(readReset(file)).toBeGreaterThan(0);
  });

  test("after the copy is gone, a card from before the move-aside is refused and posted again", async () => {
    const file = tmpFile();
    const t = decisionRig(file);
    const res = await t.r.link.decision(DEC) as any;                           // the card goes up
    t.r.later(60_000);
    writeFileSync(file, "{not json");
    expect(() => recordDecision(file, "x#1", HOLD, 1, { sync: () => {}, now: () => (t.r as any).t.now })).toThrow(DecisionsPaused);
    expect(readReset(file)).toBe((t.r as any).t.now);
    // The owner removes the copy as the alarm says: writes resume on a fresh file.
    for (const n of require("node:fs").readdirSync(join(file, ".."))) if (n.includes(".corrupt-")) renameSync(join(file, "..", n), join(file, "..", `old-${n.slice(-6)}`));
    t.r.later(60_000);
    const before = t.r.posts();
    const [hold] = t.r.ids(res.message);
    await t.r.tap(t.r.msg(res.message), hold);
    // Not kept, the old card marked replaced, a new card up, his tap told so.
    expect(readDecided(file)).toEqual({});
    expect(String(t.r.msg(res.message).content)).toEndWith(REPLACED);
    expect(t.r.state().messages[res.message]).toMatchObject({ outcome: "replaced", why: "decisions reset" });
    expect(t.r.state().messages[res.message].decision).toBeUndefined();
    expect(t.r.posts()).toBe(before + 1);
    expect(t.r.ephemerals().map((e) => e.content)).toEqual([RESET_TAP]);
    expect(t.r.relayed.filter((l) => l.includes("Dane tapped"))).toEqual([]);
    // The new card takes his tap.
    const fresh = Object.entries(t.r.state().messages).find(([, m]) => m.decision?.id === "pr-5#3")![0];
    expect(fresh).not.toBe(res.message);
    await t.r.tap(t.r.msg(fresh), t.r.ids(fresh)[0]);
    expect(readDecided(file)).toMatchObject({ "pr-5#3": { choice: HOLD } });
    expect(t.r.relayed.filter((l) => l.includes(`Dane tapped "${HOLD}"`)).length).toBe(1);
  });

  test("the reset mark: none, a time, or unreadable (paused)", () => {
    const file = tmpFile();
    expect(readReset(file)).toBeNull();
    writeFileSync(resetOf(file), "garbage");
    expect(readReset(file)).toBeNaN();
    writeFileSync(resetOf(file), "1234");
    expect(readReset(file)).toBe(1234);
  });
});

describe("C4: a schema-invalid hold call is refused before it counts", () => {
  test(`bad calls don't use up the ${HOLDS_PER_MINUTE} a minute`, async () => {
    const r = rig({ holds: keeperHolds({}) });
    const lines: string[] = [];
    Object.assign((r.link as any).d, { guardHold: () => ({ ok: false, floor: "plan", why: "low" }), holdLog: (l: string) => { lines.push(l); } });
    const hold = (b: any) => (r.link as any).guardHoldFor(b, "cain");
    for (let i = 0; i < HOLDS_PER_MINUTE * 3; i++) {
      await expect(hold({ label: "bogus", what: "x" })).rejects.toThrow("names its label");
      await expect(hold({ label: "other" })).rejects.toThrow("says what was refused");
      await expect(hold({ label: "other", what: { not: "text" } })).rejects.toThrow("says what was refused");
      await expect(hold({ label: 7, what: "x" })).rejects.toThrow("names its label");
      await expect(hold({ label: "other", what: "x", hook: "anything" })).rejects.toThrow("a hook's hold is one of");
    }
    for (let i = 0; i < HOLDS_PER_MINUTE; i++) expect((await hold({ label: "other", what: `Build ${i}` })).status).toBe("held");
    await expect(hold({ label: "other", what: "Build 99" })).rejects.toThrow("in a minute");
    expect(lines.length).toBe(HOLDS_PER_MINUTE);
  });
});

// -- D: the Healthchecks key ---------------------------------------------------------------------
const CHECK = { name: "cain heartbeat", grace: 900, timeout: 300, status: "up", last_ping: "2026-11-21T14:55:00+00:00",
  ping_url: "https://hc-ping.com/11111111-2222-3333-4444-555555555555", update_url: "https://healthchecks.io/api/v3/checks/11111111-2222-3333-4444-555555555555" };
function fakeHc(o: { status?: number; checks?: any[] } = {}) {
  const calls: { method: string; url: string; key: string | null; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, key: init.headers["x-api-key"] ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET") return new Response(JSON.stringify({ checks: o.checks ?? [CHECK] }), { status: o.status ?? 200 });
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify({ ...CHECK, grace: b.grace, timeout: b.timeout ?? CHECK.timeout }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("D: hc-check and hc-set through the link", () => {
  test("no key set", async () => {
    const h = fakeHc();
    const r = await hcCall({ cmd: "check", name: "cain heartbeat" }, { key: () => "", fetch: h.f, logFile: null });
    expect(r).toMatchObject({ status: "refused" });
    expect(r.said).toContain("no key set");
    expect(h.calls).toEqual([]);
  });

  test("hc-check prints grace, period, status and last ping, never the ping URL or the key", async () => {
    const h = fakeHc();
    const r = await hcCall({ cmd: "check", name: "cain heartbeat" }, { key: () => "k-secret", fetch: h.f, logFile: null });
    expect(r.status).toBe("ok");
    expect(r.said).toBe("cain heartbeat: grace 900 s, period 300 s, status up, last ping 2026-11-21T14:55:00+00:00");
    expect(JSON.stringify(r)).not.toContain("hc-ping.com");
    expect(JSON.stringify(r)).not.toContain("k-secret");
    expect(h.calls).toEqual([{ method: "GET", url: "https://healthchecks.io/api/v3/checks/", key: "k-secret", body: null }]);
  });

  test("hc-set sends only grace and timeout, prints what the service answered, and logs the set", async () => {
    const h = fakeHc();
    const dir = mkdtempSync(join(tmpdir(), "hc-"));
    const logFile = join(dir, "healthchecks.log");
    const logs: string[] = [];
    const r = await hcCall({ cmd: "set", name: "cain heartbeat", grace: "600", period: 300 }, { key: () => "k", fetch: h.f, logFile, log: (l) => logs.push(l), now: () => NOW.getTime() });
    expect(r).toMatchObject({ status: "ok", check: { grace: 600, period: 300 } });
    expect(r.said).toContain("Healthchecks.io answered: cain heartbeat: grace 600 s, period 300 s");
    expect(h.calls[1]).toEqual({ method: "POST", url: CHECK.update_url, key: "k", body: { grace: 600, timeout: 300 } });
    expect(logs).toEqual(["healthchecks: set cain heartbeat: grace 900 to 600, period 300 to 300: Healthchecks.io answered 200"]);
    expect(JSON.parse(readFileSync(logFile, "utf8"))).toMatchObject({ name: "cain heartbeat", asked: { grace: 600, period: 300 }, before: { grace: 900, period: 300 }, status: 200 });
    // Grace alone.
    const h2 = fakeHc();
    await hcCall({ cmd: "set", name: "cain heartbeat", grace: 720 }, { key: () => "k", fetch: h2.f, logFile: null, log: () => {} });
    expect(h2.calls[1].body).toEqual({ grace: 720 });
  });

  test("any other field, a bad number, an unknown or doubled name is refused before anything changes", async () => {
    const h = fakeHc();
    const d = { key: () => "k", fetch: h.f, logFile: null, log: () => {} };
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600, tz: "UTC" }, d)).said).toContain("refused: tz");
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600, channels: "*" }, d)).said).toContain("refused: channels");
    expect((await hcCall({ cmd: "set", name: "cain heartbeat" }, d)).said).toContain("--grace is needed");
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 5 }, d)).said).toContain("--grace is needed");
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600, period: "1e3" }, d)).said).toContain("--period");
    expect((await hcCall({ cmd: "check", name: "cain heartbeat", grace: 600 }, d)).said).toContain("hc-check reads only");
    expect((await hcCall({ cmd: "delete", name: "cain heartbeat" }, d)).said).toContain("check or set");
    expect(h.calls.length).toBe(0);
    expect((await hcCall({ cmd: "set", name: "nope", grace: 600 }, d)).said).toContain('no check named "nope"; the checks are: cain heartbeat');
    const two = fakeHc({ checks: [CHECK, CHECK] });
    expect((await hcCall({ cmd: "set", name: "cain heartbeat", grace: 600 }, { ...d, fetch: two.f })).said).toContain("more than one check");
    expect(two.calls.every((c) => c.method === "GET")).toBe(true);
    const bad = fakeHc({ status: 401 });
    expect((await hcCall({ cmd: "check", name: "cain heartbeat" }, { ...d, fetch: bad.f })).said).toContain("refused the key (401)");
  });

  test("the route is Cain's, the key reaches only the link's process, and keeper.sh sends exactly the fields", () => {
    expect(CAIN_ROUTES.has("/hc")).toBe(true);
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    const at = run.indexOf('hc_key="$(bashio::config');
    expect(at).toBeGreaterThan(0);
    const sub = run.slice(at, run.indexOf("\n) &", at));
    expect(sub).toContain('bun "$OPT/link/main.ts"');
    expect(sub).toContain("mkdir -m 0700 /run/cain-hc");
    expect(sub).toContain("umask 077; printf '%s' \"$hc_key\" > /run/cain-hc/key");
    expect(sub).toContain("unset hc_key");
    expect(run).not.toContain("export HEALTHCHECKS_API_KEY");                  // round 2: never in an environment
    expect(run.split("bashio::config 'healthchecks_api_key'").length).toBe(2); // read from the options in one place only
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toContain("const HC_KEY = takeKey();");
    const cfg = readFileSync(join(import.meta.dir, "../config.yaml"), "utf8");
    expect(cfg).toContain("  healthchecks_api_key: password?\n");
  });

  test("keeper.sh hc-check and hc-set: the bodies they send, and refusals of other flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hck-"));
    writeFileSync(join(dir, "cain.key"), "testkey");
    writeFileSync(join(dir, "mode"), "own");
    const port = 18000 + Math.floor(Math.random() * 1000);
    const got = join(dir, "got.json");
    const keeper = join(import.meta.dir, "../rootfs/opt/cain/keeper.sh");
    const env = { ...process.env, CAIN_KEYS: dir, CAIN_MODE_FILE: join(dir, "mode"), CAIN_LINK: `http://127.0.0.1:${port}`, CAIN_CARDS: join(dir, "none.json") };
    // Flags refused locally, before any call.
    const r1 = spawnSync("bash", [keeper, "hc-set", "cain heartbeat", "--grace", "600", "--tz", "UTC"], { env, encoding: "utf8" });
    expect(r1.status).toBe(2);
    expect(r1.stdout).toContain("only --grace and --period can be set; refused: --tz");
    const r2 = spawnSync("bash", [keeper, "hc-set", "cain heartbeat"], { env, encoding: "utf8" });
    expect(r2.stdout).toContain("usage: keeper.sh hc-set");
    const r3 = spawnSync("bash", [keeper, "hc-check"], { env, encoding: "utf8" });
    expect(r3.stdout).toContain("usage: keeper.sh hc-check");
    // With a link: the body and path it posts.
    const srv = Bun.spawn(["bun", "-e", `Bun.serve({ port: ${port}, async fetch(req) { await Bun.write(${JSON.stringify(got)}, JSON.stringify({ path: new URL(req.url).pathname, key: req.headers.get("x-harness-key"), body: await req.json() })); return Response.json({ status: "ok", said: "fine" }); } }); setTimeout(() => process.exit(0), 8000);`]);
    try {
      Bun.sleepSync(400);
      const r4 = spawnSync("bash", [keeper, "hc-set", "cain heartbeat", "--grace", "600", "--period", "300"], { env, encoding: "utf8" });
      expect(r4.stdout).toContain('"status":"ok"');
      expect(JSON.parse(readFileSync(got, "utf8"))).toEqual({ path: "/hc", key: "testkey", body: { cmd: "set", name: "cain heartbeat", grace: "600", period: "300" } });
      const r5 = spawnSync("bash", [keeper, "hc-check", "cain heartbeat"], { env, encoding: "utf8" });
      expect(r5.stdout).toContain('"status":"ok"');
      expect(JSON.parse(readFileSync(got, "utf8")).body).toEqual({ cmd: "check", name: "cain heartbeat" });
    } finally { srv.kill(); }
  });
});
