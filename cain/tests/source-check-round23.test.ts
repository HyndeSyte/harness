// Source checks, twenty-third review round (0.12.0): defects in the twenty-second round's own additions, fixed. Pushes go
// again only after a confirmed push; the push runs under a hard timeout with the flock released whatever it did, and a
// timeout is an unknown outcome; the nightly check's refusals share the round's record; the alarm check fails closed;
// the hold's remedy is a shipped switch (record.sh reset-copy); git's text stays in the keeper's log; the start probe's
// helper runs under the entry point's own runtime; the drop reads GitHub afresh under the lock; an unknown boot id
// re-bases the landing window; a lock timeout at one landing mark skips only that record; the whole source tree's lock
// sites are listed; unresolved rows carry their kind.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendLog, LOCK_CALLERS, LOCK_SITES, LOCK_WAIT_MS, lockTest, lockWait, probeHelperArgv, probeLock, readLog, resetFlockForTest, shortWriteSpy, withLogLock } from "../rootfs/opt/cain/applog.ts";
import { keeperPushRows, outageWhy, plainPush } from "../rootfs/opt/cain/link/core";
import { alarmCheckLine, consumedWait, cycle, dropUnlanded, GUARD_WHY, LANDED_MIN_ROUNDS, LANDED_WINDOW_MS, nightly, openIntents, pushAlarmLine, pushedTombstoned, pushRefusedLine, PUSHES_AGAIN_LINE, PUSH_TIMEOUT_MS, readConsumed, RESET_COPY_CMD, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; lockTest.names = null; lockTest.call = null; lockTest.errnoSyms = null; lockTest.helper = null; lockWait.ms = LOCK_WAIT_MS; shortWriteSpy.on = null; resetFlockForTest(); });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
const holds = (doc: string, phrase: string) => expect(doc.includes(phrase) ? phrase : `missing: ${phrase}`).toBe(phrase);
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
const ROOT = join(import.meta.dir, "../rootfs/opt/cain");
const MAIN = JSON.stringify(join(ROOT, "record/main.ts"));

type K = ReturnType<typeof keeperRig>;
const keeperStatus = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const keeperState = (k: K) => JSON.parse(readFileSync(k.cfg.holds!, "utf8"));
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const round = (k: K, id: string) => { k.cain({ id, ops: [{ op: "note", item: "P44", text: `a round ${id}` }] }); return cycle(k.cfg); };
const told = (k: K, s: string) => k.relayed().split(" / ").filter((l) => l.includes(s)).length;
// A tap key the link issued for an ask on P11, and Cain's request for it queued.
const addTap = (k: K, kid: string, id: string, text = "his tap", n = 7) => {
  const at = k.cfg.now!().getTime(), card = sf(at, n);
  appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + DAY, life: DAY });
  const f = join(k.root, "pi/link/state.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  st.issued = { ...(st.issued ?? {}), [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } };
  writeFileSync(f, JSON.stringify(st));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text }] }, { issue: false });
};
const keeperWithKey = (kid: string, id: string, text = "his tap") => {
  const k = keeperRig();
  expect(round(k, `${id}-0`).ok).toBe(true);
  addTap(k, kid, id, text);
  return { k };
};
const g = (k: K, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: k.cfg.dir });
const dropQueued = (k: K, id: string) => { for (const n of readdirSync(k.cfg.queue)) if (readFileSync(join(k.cfg.queue, n), "utf8").includes(`"${id}"`)) rmSync(join(k.cfg.queue, n)); };
const remoteRequests = (k: K, kid: string) => {
  const p = Bun.spawnSync(["git", "log", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)", "main"], { cwd: k.remote });
  return p.stdout.toString().split("\x1e").map((l) => l.split("\x1f").map((x) => x.trim())).filter(([t]) => t === kid).map(([, id]) => id);
};
const remoteHas = (k: K, text: string) => Bun.spawnSync(["git", "grep", "-l", "-F", text, "main"], { cwd: k.remote }).stdout.toString().trim() !== "";
const remoteTipOf = (k: K) => Bun.spawnSync(["git", "rev-parse", "main"], { cwd: k.remote }).stdout.toString().trim();
const localTrack = (k: K) => g(k, "rev-parse", "refs/remotes/origin/main").stdout.toString().trim();
const tomb = (k: K, tap: string, id: string) => appendLog(tapsLogFile(k.cfg), { t: "dropped", tap, id, unlanded: true, why: "test", at: "x" });
const pushOff = (k: K) => { k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); }; };
const quiet = () => { const lines: string[] = []; console.log = (...a: any[]) => { lines.push(a.join(" ")); }; return lines; };
// Assistant- and owner-facing text: no hex run of seven or more (tap keys, which Cain's lines carry by design, aside),
// and no ref or path fragment (the documented command aside).
const clean = (text: string) => {
  const t = text.replaceAll(RESET_COPY_CMD, "").replace(/\btap-[0-9a-f]{12}\b/g, "");
  expect(t).not.toMatch(/[0-9a-f]{7,}/i);
  expect(t).not.toMatch(/refs\/|origin\/|\.git\b|HEAD|\b[\w.-]+\/[\w.-]+\.\w+|\/[\w.-]+\//);
};
// One keeper run in its own process (a restart): cycles with the given monotonic readings and boot id, against the same
// state file. hook: a gitHook's body (source), for a run that must still fail the same way.
const childRun = (k: K, o: { monos?: number[]; boot?: string; hook?: string; cycles?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "r23-run-")), script = join(dir, "run.ts");
  const cfg = JSON.stringify({ ...k.cfg, now: undefined, clockSynced: undefined, beforePush: undefined, gitHook: undefined, mono: undefined, bootId: undefined });
  const monos = o.monos ?? Array(o.cycles ?? 1).fill(0);
  writeFileSync(script, `import { cycle } from ${MAIN};\nconst cfg: any = ${cfg};\nconst NOW = ${k.cfg.now!().getTime()};\nconst monos = ${JSON.stringify(monos)};\nlet i = 0;\n`
    + `cfg.now = () => new Date(NOW); cfg.clockSynced = () => true; cfg.mono = () => monos[Math.min(i, monos.length - 1)];\n`
    + (o.boot ? `cfg.bootId = () => ${JSON.stringify(o.boot)};\n` : "")
    + (o.hook ? `cfg.gitHook = (a: string[]) => { ${o.hook} };\n` : "")
    + `const out = [];\nfor (i = 0; i < monos.length; i++) out.push(cycle(cfg).ok);\nconsole.log("RESULT " + JSON.stringify(out));\n`);
  const p = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const m = /RESULT (.*)/.exec(p.stdout.toString());
  if (!m) throw new Error(`the child run failed: ${p.stderr.toString().slice(-800)}`);
  return JSON.parse(m[1]) as boolean[];
};
const holdLockAsync = async (file: string, ms: number) => {
  const dir = mkdtempSync(join(tmpdir(), "r23-holder-")), script = join(dir, "holder.ts"), flag = join(dir, "in");
  writeFileSync(script, `import { withLogLock } from ${JSON.stringify(join(ROOT, "applog.ts"))};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < Number(process.argv[4])) {} });\n`);
  const done = new Promise<number>((ok) => spawn("bun", [script, file, flag, String(ms)], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
  for (let i = 0; i < 500 && !existsSync(flag); i++) await new Promise((ok) => setTimeout(ok, 10));
  expect(existsSync(flag)).toBe(true);
  return { done };
};
// The same, started from synchronous code (a git hook) and waited for there.
const holdLockSync = (file: string, ms: number) => {
  const dir = mkdtempSync(join(tmpdir(), "r23-holder-")), script = join(dir, "holder.ts"), flag = join(dir, "in");
  writeFileSync(script, `import { withLogLock } from ${JSON.stringify(join(ROOT, "applog.ts"))};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < Number(process.argv[4])) {} });\n`);
  const p = Bun.spawn(["bun", script, file, flag, String(ms)], { stdio: ["ignore", "ignore", "ignore"] });
  const t = Date.now();
  while (!existsSync(flag) && Date.now() - t < 10_000) Bun.sleepSync(10);
  expect(existsSync(flag)).toBe(true);
  return p;
};

describe("1. pushes go again only after a confirmed push (invariants: the keeper status, the consumed-key log)", () => {
  test("the push blocked after the guard passes: the refused-push record stays, nothing said; a confirmed push clears it and says so once", () => {
    const kid = "tap-0000003f2301";
    const { k } = keeperWithKey(kid, "cain-r23-1-a");
    pushOff(k); cycle(k.cfg);
    tomb(k, "tap-00000099aaaa", "cain-some-other-request");
    k.cfg.beforePush = () => { g(k, "update-ref", "-d", "refs/remotes/origin/main"); };
    expect(cycle(k.cfg).ok).toBe(false);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote", told: true });
    // The guard passes now, but the push itself fails on the network.
    k.cfg.beforePush = undefined;
    k.cfg.gitHook = (a) => { if (a[0] === "push") throw new Error("fatal: unable to access the remote: Could not resolve host (injected)"); };
    expect(cycle(k.cfg).ok).toBe(false);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote" });
    expect(told(k, "go again")).toBe(0);
    // The push goes but GitHub's branch can't be read back: still not counted as going again.
    k.cfg.gitHook = (a) => { if (a[0] === "ls-remote") throw new Error("ls-remote: no answer (injected)"); };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r23-1-a"]);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote" });
    expect(told(k, "go again")).toBe(0);
    // A fresh fetch finds the copy in step with GitHub (or the next push reads back equal): cleared, said once.
    k.cfg.gitHook = undefined;
    expect(round(k, "cain-r23-1-a2").ok).toBe(true);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(told(k, "go again")).toBe(1);
    expect(k.relayed()).toContain(PUSHES_AGAIN_LINE);
    cycle(k.cfg);
    expect(told(k, "go again")).toBe(1);
  }, 90_000);

  test("a confirmed push clears it at once: the remote's branch read back equals the pushed head", () => {
    const kid = "tap-0000003f2302";
    const { k } = keeperWithKey(kid, "cain-r23-1-b");
    pushOff(k); cycle(k.cfg);
    tomb(k, "tap-00000099aaab", "cain-some-other-request");
    k.cfg.beforePush = () => { g(k, "update-ref", "-d", "refs/remotes/origin/main"); };
    cycle(k.cfg);
    k.cfg.beforePush = undefined;
    const lines = quiet();
    expect(cycle(k.cfg).ok).toBe(true);
    console.log = realLog;
    expect(lines.some((l) => l.includes("pushes go again (a round push confirmed on GitHub"))).toBe(true);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(told(k, "go again")).toBe(1);
  }, 60_000);
});

describe("2. the push runs under a hard timeout and the flock is released (invariants: the consumed-key log, every append-only log)", () => {
  test("a push that never returns: killed at its timeout, an unknown outcome kept and listed, taps still consume on later rounds", () => {
    expect(PUSH_TIMEOUT_MS).toBeLessThan(consumedWait());
    const k = keeperRig();
    expect(round(k, "cain-r23-2-0").ok).toBe(true);
    k.cfg.pushTimeoutMs = 1500;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");             // GitHub never answers the push
    let failFetch = false;
    k.cfg.gitHook = (a) => { if (a[0] === "push") failFetch = true; else if (a[0] === "fetch" && failFetch) throw new Error("fetch: no answer (injected)"); };
    let t = performance.now();
    expect(round(k, "cain-r23-2-a").ok).toBe(false);
    expect(performance.now() - t).toBeLessThan(10_000);
    // The flock is free again: a non-blocking try takes it.
    expect(() => withLogLock(tapsLogFile(k.cfg), () => undefined, { wait: 0 })).not.toThrow();
    expect(keeperStatus(k).push_unknown).toMatchObject({ why: expect.stringContaining("no answer within its time limit") });
    const rows = keeperPushRows(keeperStatus(k));
    expect(rows.map((r) => r.row)).toContain("push-unknown");
    // A tap on a later round consumes within the timeout, though the push still hangs.
    const kid = "tap-0000003f2311";
    addTap(k, kid, "cain-r23-2-b");
    failFetch = false;
    t = performance.now();
    cycle(k.cfg);
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-2-b");
    expect(keeperStatus(k).push_unknown.keys).toContain(kid);
    // A drop of that key waits: GitHub can't be read afresh.
    failFetch = true;
    expect(dropUnlanded(k.cfg, kid, "cain-r23-2-b", "the test's drop", "x")).toBe("retry");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.some((x) => x.t === "dropped" && x.tap === kid)).toBe(false);
    // GitHub answers again: pushed, and the unknown outcome settled by the fresh fetch.
    g(k, "config", "--unset", "remote.origin.receivepack");
    k.cfg.gitHook = undefined;
    expect(cycle(k.cfg).ok).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r23-2-b"]);
    cycle(k.cfg);
    expect(keeperStatus(k).push_unknown).toBeUndefined();
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-2-b");
  }, 120_000);

  test("a push that times out with GitHub answering a fetch after it is settled at once and not tried again that round", () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-2-c0").ok).toBe(true);
    k.cfg.pushTimeoutMs = 1000;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");
    let pushes = 0;
    k.cfg.gitHook = (a) => { if (a[0] === "push") pushes++; };
    const lines = quiet();
    expect(round(k, "cain-r23-2-c").ok).toBe(false);
    console.log = realLog;
    expect(pushes).toBe(1);
    expect(lines.some((l) => l.includes("push outcome unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("settled by a fresh fetch: it didn't land"))).toBe(true);
    expect(keeperStatus(k).push_unknown).toBeUndefined();
  }, 60_000);
});

describe("3. the nightly check's refusals share the round's record (invariants: the keeper status)", () => {
  test("a nightly refusal followed by a restart: kept in state and status, told once, retried by the rounds, and cleared once confirmed", () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-3-0").ok).toBe(true);
    tomb(k, "tap-00000099aaac", "cain-some-other-request");
    const hook = `if (a[0] === "rev-parse" && a.includes("refs/remotes/origin/main") && a.includes("--quiet")) throw new Error("rev-parse: unknown (injected)");`;
    k.cfg.gitHook = new Function("a", hook) as (a: string[]) => void;
    expect(nightly(k.cfg)).toBe(false);
    expect(keeperState(k).pushRefused).toMatchObject({ kind: "unknown-remote", by: ["nightly"], told: true });
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote", by: ["nightly"] });
    expect(told(k, "holding back its pushes")).toBe(1);
    // A restart (its own process), still refused: the same record, not told again.
    k.cfg.gitHook = undefined;
    expect(childRun(k, { hook })).toEqual([false]);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote", tries: 2, by: ["nightly", "round"] });
    expect(told(k, "holding back its pushes")).toBe(1);
    // Another restart, the remote known again: the nightly commit pushed and confirmed, the record cleared, said once.
    expect(childRun(k, {})).toEqual([true]);
    expect(remoteHas(k, "Record check")).toBe(true);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(told(k, "go again")).toBe(1);
  }, 120_000);
});

describe("4. the alarm check fails closed (invariants: the record trailers, the keeper status)", () => {
  const pushedWithTomb = (kid: string, id: string) => {
    const { k } = keeperWithKey(kid, id);
    pushOff(k); cycle(k.cfg);
    k.cfg.beforePush = undefined;
    tomb(k, "tap-00000099aaad", "cain-some-other-request");
    return k;
  };
  const incompleteThenClean = (k: K, why: string) => {
    expect(keeperStatus(k).alarm_check).toMatchObject({ why: expect.stringContaining(why), told: true });
    expect(keeperStatus(k).push_alarms).toBeUndefined();
    expect(told(k, "Push alarm check incomplete")).toBe(1);
    expect(keeperPushRows(keeperStatus(k)).map((r) => r.row)).toContain("alarm-check");
    for (const l of k.relayed().split(" / ").filter((x) => x.includes("Push alarm check"))) clean(l);
    k.cfg.gitHook = undefined;
    cycle(k.cfg);
    expect(keeperStatus(k).alarm_check).toBeUndefined();
    expect(told(k, "Push alarm check complete: no withdrawn change reached GitHub")).toBe(1);
    expect(told(k, "Push alarm check incomplete")).toBe(1);
  };

  test("an unreadable tombstone log after the push: incomplete, kept, listed and told; a clean scan the next round clears it", () => {
    const k = pushedWithTomb("tap-0000003f2341", "cain-r23-4-a");
    const f = tapsLogFile(k.cfg);
    expect(pushedTombstoned({ ...k.cfg, tapsLog: join(k.root, "no-such-dir", "x") } as any, null, "x").incomplete).toBeUndefined();   // a missing log is no tombstones
    let swapped = false;
    k.cfg.gitHook = (a) => { if (a[0] === "push" && !swapped) { swapped = true; renameSync(f, `${f}.aside`); mkdirSync(f); } };
    cycle(k.cfg);
    rmSync(f, { recursive: true }); renameSync(`${f}.aside`, f);
    incompleteThenClean(k, "consumed-key log couldn't be read");
  }, 60_000);

  test("GitHub's branch unknown after the push: incomplete, never verified absence; then clean", () => {
    const k = pushedWithTomb("tap-0000003f2342", "cain-r23-4-b");
    let pushed = false, once = false;
    k.cfg.gitHook = (a) => {
      if (a[0] === "push") pushed = true;
      else if (pushed && !once && a[0] === "rev-parse" && a.includes("refs/remotes/origin/main")) { once = true; throw new Error("rev-parse: unknown (injected)"); }
    };
    cycle(k.cfg);
    incompleteThenClean(k, "isn't known");
  }, 60_000);

  test("a git failure in the scan: incomplete; then clean", () => {
    const k = pushedWithTomb("tap-0000003f2343", "cain-r23-4-c");
    let pushed = false, once = false;
    k.cfg.gitHook = (a) => {
      if (a[0] === "push") pushed = true;
      else if (pushed && !once && a[0] === "log" && a.some((x) => x.includes(".."))) { once = true; throw new Error("git log: fatal: bad object 1a2b3c4d5e6f (injected)"); }
    };
    cycle(k.cfg);
    incompleteThenClean(k, "couldn't be listed");
  }, 60_000);
});

describe("5. the hold's remedy is a shipped switch, record.sh reset-copy (invariants: the consumed-key log, the keeper status)", () => {
  test("an actual removal conflict: told with the remedy; resolved only through record.sh reset-copy, pushes then go again", () => {
    const kid = "tap-0000003f2351";
    const { k } = keeperWithKey(kid, "cain-r23-5-a", "his first answer");
    pushOff(k); cycle(k.cfg);
    k.cain({ id: "cain-r23-5-later", ops: [{ op: "note", item: "P11", text: "a later note on the same item" }] });
    cycle(k.cfg);
    tomb(k, kid, "cain-r23-5-a");
    dropQueued(k, "cain-r23-5-a");                                     // a dropped request has left the queue
    k.cfg.beforePush = undefined;
    expect(cycle(k.cfg).ok).toBe(false);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "conflict" });
    const line = k.relayed().split(" / ").find((l) => l.includes("can't be taken out cleanly"))!;
    expect(line).toContain(RESET_COPY_CMD);
    clean(line);
    // The documented path: the script itself, as Cain runs it.
    const sh = Bun.spawnSync(["bash", join(ROOT, "record.sh"), "reset-copy"], { env: { ...process.env, RECORD_FORCE_CONFLICT: join(dirname(k.cfg.queue), "record-force-conflict") }, stdout: "pipe", stderr: "pipe" });
    expect(sh.exitCode).toBe(0);
    expect(sh.stdout.toString()).toContain("resets its copy");
    for (let n = 0; n < 3 && keeperStatus(k).push_refused; n++) cycle(k.cfg);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(remoteHas(k, "a later note on the same item")).toBe(true);
    expect(remoteHas(k, "his first answer")).toBe(false);
    expect(told(k, "go again")).toBe(1);
    expect(flat("../rootfs/opt/cain/record.sh")).toContain("record.sh reset-copy");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain(RESET_COPY_CMD);
  }, 120_000);
});

describe("6. git's text stays in the keeper's log (invariants: the keeper status)", () => {
  test("a conflict's reason is the fixed words; git's text (abbreviated ids, paths) is in the log only", () => {
    const kid = "tap-0000003f2361";
    const { k } = keeperWithKey(kid, "cain-r23-6-a", "his first answer");
    pushOff(k); cycle(k.cfg);
    k.cain({ id: "cain-r23-6-later", ops: [{ op: "note", item: "P11", text: "a later note on the same item" }] });
    cycle(k.cfg);
    tomb(k, kid, "cain-r23-6-a");
    k.cfg.beforePush = undefined;
    const lines = quiet();
    cycle(k.cfg);
    console.log = realLog;
    expect(keeperStatus(k).push_refused.why).toBe(GUARD_WHY.conflict);
    clean(keeperStatus(k).push_refused.why);
    for (const l of k.relayed().split(" / ").filter((x) => x.includes("holding back"))) clean(l);
    expect(lines.some((l) => l.includes("push guard (conflict)") && /[0-9a-f]{7,}/.test(l))).toBe(true);
  }, 90_000);

  test("every fixed reason and every line made from them is clean", () => {
    for (const w of Object.values(GUARD_WHY)) { clean(w); clean(plainPush(w, false)); }
    for (const kind of Object.keys(GUARD_WHY) as (keyof typeof GUARD_WHY)[]) clean(pushRefusedLine({ kind, why: GUARD_WHY[kind], since: "s", tries: 1 }));
    clean(alarmCheckLine({ before: null, since: "s", why: "the commits the push carried couldn't be listed to check them", tries: 1 }));
    clean(pushAlarmLine({ tap: "tap-000000000002", id: "cain-y", at: "x", why: "a push carried the change of a request that was dropped as not landed", item: "P11" }));
    clean(PUSHES_AGAIN_LINE);
  });
});

describe("7. the start probe's helper runs under the entry point's runtime (invariants: every append-only log)", () => {
  test("the helper is started with the running executable, its runtime flags and the log module's file", () => {
    expect(probeHelperArgv()).toEqual([process.execPath, ...process.execArgv, join(ROOT, "applog.ts")]);
  });
  test("a helper that can't be spawned, or exits before it takes the lock, is refused as failed to start", () => {
    lockTest.helper = [join(tmpdir(), "no-such-runtime-r23")];
    expect(probeLock(mkdtempSync(join(tmpdir(), "r23-probe-")))).toContain("helper process failed to start");
    lockTest.helper = [process.execPath, "-e", "process.exit(3)"];
    const why = probeLock(mkdtempSync(join(tmpdir(), "r23-probe-")))!;
    expect(why).toContain("failed to start (it exited before taking the probe lock");
    expect(why).not.toContain("doesn't exclude other writers");
  }, 20_000);
  test("a helper that runs but can't take the lock is its own reason", () => {
    lockTest.helper = [process.execPath, "-e", "await Bun.sleep(8000)"];
    expect(probeLock(mkdtempSync(join(tmpdir(), "r23-probe-")))).toContain("started but couldn't take the probe lock");
  }, 20_000);
  test("the real keeper entry file, launched the way the image does (bun <file>), passes the gate and starts", async () => {
    const k = keeperRig();
    const d = mkdtempSync(join(tmpdir(), "r23-entry-"));
    const env: Record<string, string> = { ...process.env as any, RECORD_TOKEN: "not-a-real-token", RECORD_REMOTE: k.remote, RECORD_DIR: join(d, "record"), RECORD_QUEUE: join(d, "queue"),
      RECORD_OUTCOMES: join(d, "outcomes"), RELAY_QUEUE: join(d, "relay.queue"), RECORD_HOLDS: join(d, "holds.json"), RECORD_CHECKIN: join(d, "checkin.txt"), RECORD_WAITS: join(d, "waits.jsonl"),
      RECORD_STATUS: join(d, "ledger.json"), RECORD_BLOCK_PUSH: join(d, "block"), RECORD_CLOCK_TEST: join(d, "clock"), RECORD_FORCE_CONFLICT: join(d, "fc"), LINK_STATE: join(d, "link/state.json"),
      RECORD_LEAK_CHECK: join(d, "leak"), RECORD_LOG: join(d, "work/record-keeper.log"), RECORD_TAPS_LOG: join(d, "taps.jsonl"), LINK_ISSUED_LOG: join(d, "link-issued.log"),
      RECORD_ISSUED_LOG: join(d, "issued.log"), RECORD_INSTALL_LOG: join(d, "install.log"), RECORD_RECOVER: join(d, "recover.json"), RECORD_INTERVAL_S: "3600", RECORD_POLL_MS: "60000" };
    mkdirSync(join(d, "queue"), { recursive: true });
    const p = Bun.spawn(["bun", join(ROOT, "record/main.ts")], { env, stdout: "pipe", stderr: "pipe" });
    let out = "";
    const reader = (async () => { for await (const c of p.stdout as any) { out += Buffer.from(c).toString(); if (out.includes("keeping the record")) break; } })();
    await Promise.race([reader, Bun.sleep(30_000)]);
    p.kill("SIGKILL");
    expect(out).not.toContain("REFUSED TO START");
    expect(out).toContain("keeping the record");
  }, 45_000);
});

describe("8. the drop reads GitHub afresh under the lock (invariants: the consumed-key log, the record trailers)", () => {
  test("a push that errored but landed, with a failing fetch: no drop (a retry), then marked landed once GitHub reads", () => {
    const kid = "tap-0000003f2381";
    const { k } = keeperWithKey(kid, "cain-r23-8-a");
    pushOff(k); cycle(k.cfg);
    k.cfg.beforePush = undefined;
    let failFetch = false;
    k.cfg.gitHook = (a) => {
      if (a[0] === "push" && !failFetch) { failFetch = true; g(k, "push", "--quiet", k.remote, "HEAD:main"); throw new Error("fatal: the remote end hung up unexpectedly (injected)"); }
      if ((a[0] === "fetch" || a[0] === "ls-remote") && failFetch) throw new Error("fetch: no answer (injected)");
    };
    cycle(k.cfg);
    expect(remoteRequests(k, kid)).toEqual(["cain-r23-8-a"]);           // it landed
    expect(localTrack(k)).not.toBe(remoteTipOf(k));                    // the copy doesn't know it
    expect(keeperStatus(k).push_unknown.keys).toContain(kid);
    expect(dropUnlanded(k.cfg, kid, "cain-r23-8-a", "the test's drop", "x")).toBe("retry");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.some((x) => x.t === "dropped" && x.tap === kid)).toBe(false);
    k.cfg.gitHook = undefined;
    expect(dropUnlanded(k.cfg, kid, "cain-r23-8-a", "the test's drop", "x")).toBe("landed");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "landed" && x.tap === kid)).toHaveLength(1);
    cycle(k.cfg);
    expect(keeperStatus(k).push_unknown).toBeUndefined();
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-8-a");
  }, 60_000);
});

// The landing window's setup: a consumed record whose commit is on a local branch but not on GitHub, the copy in step.
const watchSetup = (kid: string, id: string) => {
  const { k } = keeperWithKey(kid, id);
  k.cfg.mono = () => 1_000; k.cfg.bootId = () => "boot-a";
  pushOff(k); cycle(k.cfg);
  k.cfg.beforePush = undefined;
  g(k, "branch", "-f", "late", "HEAD");
  g(k, "fetch", "--quiet", "origin", "main");
  g(k, "reset", "--quiet", "--hard", "origin/main");
  dropQueued(k, id);
  return k;
};

describe("9. an unknown boot id re-bases the landing window (invariants: the consumed-key log, the keeper state)", () => {
  test("a reboot whose new uptime exceeds the saved first-seen reading: not dropped early; dropped once a whole window has passed in the new run", () => {
    const kid = "tap-0000003f2391";
    const k = watchSetup(kid, "cain-r23-9-a");
    expect(childRun(k, { boot: "unknown", monos: [1_000, 1_000 + MIN, 1_000 + 2 * MIN, 1_000 + 3 * MIN] })).toEqual([true, true, true, true]);
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ since: 1_000, boot: "unknown" });
    // A reboot: the new uptime is already past the saved first sighting plus the window.
    const m = 1_000 + LANDED_WINDOW_MS + 30 * MIN;
    expect(childRun(k, { boot: "unknown", monos: [m, m + MIN, m + 2 * MIN] })).toEqual([true, true, true]);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-9-a");        // never shorter
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ since: m });
    childRun(k, { boot: "unknown", monos: [m + LANDED_WINDOW_MS + MIN, m + LANDED_WINDOW_MS + 2 * MIN, m + LANDED_WINDOW_MS + 3 * MIN, m + LANDED_WINDOW_MS + 4 * MIN, m + LANDED_WINDOW_MS + 5 * MIN] });
    // Each run starts the window again, so this run's own window hasn't passed either.
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-9-a");
  }, 180_000);

  test("within one run with the boot id unknown, the window passes and it is dropped", () => {
    const kid = "tap-0000003f2392";
    const k = watchSetup(kid, "cain-r23-9-b");
    const ms = [5_000, 5_000 + MIN, 5_000 + 2 * MIN];
    for (let n = 1; n <= LANDED_MIN_ROUNDS + 1; n++) ms.push(5_000 + LANDED_WINDOW_MS + n * MIN);
    childRun(k, { boot: "unknown", monos: ms });
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 120_000);
});

describe("10. a lock timeout at one landing mark skips only that record (invariants: the consumed-key log)", () => {
  test("the first mark cut short: that record is skipped and listed with its cause, the other marked; the next round marks it", () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-10-0").ok).toBe(true);
    addTap(k, "tap-0000003f23a1", "cain-r23-10-a", "first", 7);
    addTap(k, "tap-0000003f23a2", "cain-r23-10-b", "second", 8);
    expect(cycle(k.cfg).ok).toBe(true);
    const f = tapsLogFile(k.cfg);
    let cut = 0;
    shortWriteSpy.on = (file) => (file === f && cut++ === 0 ? 3 : null);
    cycle(k.cfg);
    shortWriteSpy.on = null;
    const landed = () => readLog<any>(f).records.filter((x) => x.t === "landed").map((x) => x.tap);
    expect(landed()).toHaveLength(1);
    expect(keeperStatus(k).landing_skipped).toEqual([expect.objectContaining({ why: expect.stringContaining("written short") })]);
    cycle(k.cfg);
    expect(landed().sort()).toEqual(["tap-0000003f23a1", "tap-0000003f23a2"]);
    expect(keeperStatus(k).landing_skipped).toBeUndefined();
  }, 90_000);

  test("the consumed-key log held past the timeout: each record skipped with the lock as its cause, the round goes on", async () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-10-c0").ok).toBe(true);
    addTap(k, "tap-0000003f23a3", "cain-r23-10-c", "third", 9);
    expect(cycle(k.cfg).ok).toBe(true);
    lockWait.ms = 50;
    const h = (await holdLockAsync(tapsLogFile(k.cfg), 2500)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(keeperStatus(k).landing_skipped).toEqual([expect.objectContaining({ tap: "tap-0000003f23a3", why: expect.stringContaining("locked by another writer") })]);
    expect(await h).toBe(0);
    cycle(k.cfg);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "landed" && x.tap === "tap-0000003f23a3")).toHaveLength(1);
  }, 60_000);
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });

describe("11. every lock site in the whole source tree is listed, and the intent-log callers hold on a timeout (invariants: every append-only log)", () => {
  test("a scan of every source file finds no unlisted lock-acquire call or repair-on-read", () => {
    const sites = Object.entries(LOCK_SITES).flatMap(([key, by]) => Object.entries(by).flatMap(([f, frags]) => frags.map((s) => ({ key, f, s }))));
    expect(Object.keys(LOCK_SITES).sort()).toEqual(Object.keys(LOCK_CALLERS).sort());
    const files = walk(ROOT).map((p) => p.slice(ROOT.length + 1));
    expect(files.length).toBeGreaterThan(20);
    for (const x of sites) expect(readFileSync(join(ROOT, x.f), "utf8").includes(x.s) ? x.s : `not in ${x.f}: ${x.s}`).toBe(x.s);
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8").split("\n");
      for (const l of src.filter((l) => /\b(appendLog|appendLogHeld|appendInstall|withLogLock)\(/.test(l) && !/^\s*(import|export function|function|\/\/|["'])/.test(l))) {
        seen++;
        expect(sites.some((x) => x.f === f && l.includes(x.s)) ? "listed" : `unlisted in ${f}: ${l.trim().slice(0, 140)}`).toBe("listed");
      }
      for (const l of src.filter((l) => /readLog\([^)]*repair: (true|"try"|f === )/.test(l) && !/^\s*["']/.test(l)))
        expect(sites.some((x) => x.f === f && l.includes(x.s)) ? "listed" : `unlisted repair in ${f}: ${l.trim().slice(0, 140)}`).toBe("listed");
    }
    expect(seen).toBeGreaterThan(30);
  });

  test("the consuming intent held past the timeout: the request stays queued, nothing consumed; then it is once", async () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-11-0").ok).toBe(true);
    const kid = "tap-0000003f23b1";
    addTap(k, kid, "cain-r23-11-a");
    lockWait.ms = 50;
    const h = (await holdLockAsync(tapsLogFile(k.cfg), 2500)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(readdirSync(k.cfg.queue).some((n) => readFileSync(join(k.cfg.queue, n), "utf8").includes("cain-r23-11-a"))).toBe(true);
    expect(await h).toBe(0);
    cycle(k.cfg); cycle(k.cfg);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-11-a");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === undefined && x.tap === kid)).toHaveLength(1);
  }, 60_000);

  test("the consumed record held past the timeout: the intent stays open and is resolved from the commit's trailers; consumed once", () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-11-b0").ok).toBe(true);
    const kid = "tap-0000003f23b2";
    addTap(k, kid, "cain-r23-11-b");
    lockWait.ms = 50;
    let holder: ReturnType<typeof Bun.spawn> | null = null;
    k.cfg.gitHook = (a) => { if (a[0] === "commit" && !holder) holder = holdLockSync(tapsLogFile(k.cfg), 2500); };
    expect(() => cycle(k.cfg)).not.toThrow();
    k.cfg.gitHook = undefined;
    expect(holder).not.toBeNull();
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === undefined && x.tap === kid)).toHaveLength(0);
    const t = Date.now();
    while ((holder as any).exitCode === null && Date.now() - t < 10_000) Bun.sleepSync(20);
    cycle(k.cfg); cycle(k.cfg);
    expect(openIntents(k.cfg).has(kid)).toBe(false);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-11-b");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === undefined && x.tap === kid)).toHaveLength(1);
  }, 60_000);

  test("the dropped intent held past the timeout: the intent stays open; then it is dropped once", async () => {
    const k = keeperRig();
    expect(round(k, "cain-r23-11-c0").ok).toBe(true);
    const kid = "tap-0000003f23b3";
    appendLog(tapsLogFile(k.cfg), { t: "consuming", tap: kid, id: "cain-r23-11-c", at: "2026-11-11T13:00:00.000Z" });
    lockWait.ms = 50;
    const h = (await holdLockAsync(tapsLogFile(k.cfg), 2500)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(openIntents(k.cfg).has(kid)).toBe(true);
    expect(await h).toBe(0);
    cycle(k.cfg);
    expect(openIntents(k.cfg).has(kid)).toBe(false);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "dropped" && x.tap === kid)).toHaveLength(1);
  }, 60_000);
});

describe("12. unresolved rows carry their kind (invariants: the keeper status, the landing ledger)", () => {
  const mixed = (at: string) => ({
    push_refused: { kind: "conflict", why: GUARD_WHY.conflict, since: at, tries: 2, told: true },
    push_alarms: [{ tap: "tap-000000000002", id: "cain-y", at, why: "a push carried the change of a request that was dropped as not landed", item: "P41" }],
    alarm_check: { since: at, why: "the commits the push carried couldn't be listed to check them", tries: 1, told: true },
    push_unknown: { since: at, why: "the push got no answer within its time limit and was stopped", keys: ["tap-000000000003"], tries: 1 },
  });
  test("keeper.sh clock's rows: a landing row and every keeper row kind, each with row set", () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
    const at = new Date(r.t.now).toISOString();
    r.setState({ ...r.state(), unresolved: { "ship-key-1": { since: r.t.now - 60 * MIN, fails: 3, last: "GitHub didn't answer", what: "orphan", next: r.t.now + MIN } } as any });
    r.keeperVerified(mixed(at));
    const rows = (r.link.clockReport() as any).unresolved_landings;
    expect(rows.map((x: any) => x.row)).toEqual(["landing", "push-refused", "push-alarm", "alarm-check", "push-unknown"]);
    expect(rows[2]).toMatchObject({ item: "P41" });
  });
  test("the owner's outage notice over mixed rows: the reason from the refused push, no ids or shas", async () => {
    const r = linkRig({ pending: pendingWith(["P08"], []) });
    const at = new Date(r.t.now).toISOString();
    r.keeperVerified({ unpushed: true, push_failed: { at, why: GUARD_WHY.conflict, since: new Date(r.t.now - 40 * MIN).toISOString() },
      outage: { since: new Date(r.t.now - 40 * MIN).toISOString(), rounds: 40 }, ...mixed(at) });
    await r.link.sweep();
    const n = r.cards().filter((m: any) => String(m.content).startsWith("Cain's record hasn't saved"));
    expect(n).toHaveLength(1);
    expect(n[0].content).toContain("a change that was withdrawn is held back from GitHub until the box can take it out");
    expect(n[0].content).not.toMatch(/[0-9a-f]{7,}|tap-|cain-|P41|cse_/);
    expect(n[0].content).not.toMatch(/tap again|send .* again|answer again/i);
    // Only an unknown push: GitHub didn't answer. Only alarms: the push error decides.
    const st = { push_failed: { at, why: "git push: fatal: unable to access: Could not resolve host", since: at } } as any;
    expect(outageWhy(keeperPushRows({ push_unknown: mixed(at).push_unknown } as any), st)).toBe("GitHub didn't answer");
    expect(outageWhy(keeperPushRows({ push_alarms: mixed(at).push_alarms, alarm_check: mixed(at).alarm_check } as any), st)).toBe("GitHub didn't answer");
  });
});

describe("13. the landing watch's restart and reboot cases run as separate processes (invariants: the consumed-key log, the keeper state)", () => {
  test("restarted every 40 minutes, each restart its own process against the same state file: dropped once the window and rounds pass", () => {
    const kid = "tap-0000003f23d1";
    const k = watchSetup(kid, "cain-r23-13-a");
    let mono = 1_000, n = 0;
    const restarts = Math.ceil(LANDED_WINDOW_MS / (40 * MIN)) + LANDED_MIN_ROUNDS + 2;
    for (; n < restarts && readConsumed(k.cfg).has(kid); n++) { mono += 40 * MIN; childRun(k, { boot: "boot-a", monos: [mono] }); }
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(n).toBeGreaterThan(LANDED_MIN_ROUNDS);
    expect(keeperState(k).landWatch).toBeUndefined();
  }, 240_000);

  test("a reboot, its own process: the box's monotonic clock starts over and the window starts again", () => {
    const kid = "tap-0000003f23d2";
    const k = watchSetup(kid, "cain-r23-13-b");
    childRun(k, { boot: "boot-a", monos: [1_000, 1_000 + LANDED_WINDOW_MS - 10 * MIN, 1_000 + LANDED_WINDOW_MS - 9 * MIN, 1_000 + LANDED_WINDOW_MS - 8 * MIN] });
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ boot: "boot-a", since: 1_000 });
    childRun(k, { boot: "boot-b", monos: [50 + 20 * MIN] });
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r23-13-b");
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ boot: "boot-b", rounds: 1 });
  }, 120_000);
});

describe("14. the docs say what round 23 changed", () => {
  test("DOCS.md, the table, Cain's rules, keeper.sh, record.sh and the CHANGELOG name the round-23 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), table = flat(INVARIANTS);
    holds(docs, "Round 23");
    holds(table, "source-check-round23.test.ts");
    for (const p of ["PUSH_TIMEOUT_MS", "confirmed push", "alarm check incomplete", "reset-copy", "fresh fetch under the lock", "row kind"]) holds(table, p);
    holds(rules, "Push alarm check incomplete");
    holds(rules, RESET_COPY_CMD);
    holds(flat("../rootfs/opt/cain/keeper.sh"), "Round 23");
    holds(flat("../rootfs/opt/cain/record.sh"), "reset-copy");
    holds(flat("../CHANGELOG.md"), "a push that hangs");
  });
  test("nothing the owner sees carries a job id or a sha, or asks him to send or tap again", () => {
    for (const w of Object.values(GUARD_WHY)) {
      const line = plainPush(w, false);
      expect(line).not.toMatch(/\b[0-9a-f]{7,40}\b|tap-|cse_|session/i);
      expect(line).not.toMatch(/tap again|send .* again|answer again/i);
    }
  });
});
