// Source checks, twenty-fourth review round (0.12.0): defects in the twenty-third round's own additions, fixed. Every
// network call runs under the timed, no-prompt, session-killed wrapper (the opening fetch and the Date header's read too),
// and a timeout is a hiccup round kept in the state; a failing resolver of a push of unknown outcome counts its tries,
// tells once and falls back to a strict scan of GitHub's history; a missing consumed-key log is verified absence only when
// the keeper's state proves it never existed; a landing skip's cause is fixed words; record.sh reset-copy is stamped with
// the hold it was made for and used up by the next round; one lock timeout skips the rest of the landing loop; hiccup
// rounds count on the push-refused hold; the push's wall-clock limit is a ceiling over git's low-speed abort; the session
// tool is checked at start; re-bases of a landing watch show as a row; the lock primitives can't be aliased, and the
// link's real entry file starts.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendLog, LockTimeout, lockTest, lockWait, LOCK_WAIT_MS, readLog, resetFlockForTest, shortWriteSpy, withLogLock } from "../rootfs/opt/cain/applog.ts";
import { keeperPushRows, outageWhy } from "../rootfs/opt/cain/link/core";
import { abandonCommits, consumedWait, cycle, FETCH_HICCUP_WHY, keeperLockProbe, LAND_HELD_WHY, LAND_REBASE_ROW_AFTER, LAND_SKIP_WHY, landSkipCause, NET_SESSION_WHY,
  netRun, netTest, netTimeout, PUSH_HICCUP_TELL_AFTER, PUSH_SLOW_AFTER, PUSH_SLOW_WHY, PUSH_TIMEOUT_MS, PUSH_UNKNOWN_FALLBACK_TRIES, PUSH_UNKNOWN_STUCK_WHY, pushedTombstoned,
  readConsumed, RESET_COPY_CMD, RESET_COPY_WHY, tapsLogFile, unlandedConsumes } from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
const realEnv = process.env.RECORD_PUSH_TIMEOUT_S;
afterEach(() => {
  console.log = realLog; lockTest.names = null; lockTest.call = null; lockTest.errnoSyms = null; lockTest.helper = null; lockWait.ms = LOCK_WAIT_MS; shortWriteSpy.on = null;
  if (netTest) netTest.setsid = null; resetFlockForTest();
  if (realEnv === undefined) delete process.env.RECORD_PUSH_TIMEOUT_S; else process.env.RECORD_PUSH_TIMEOUT_S = realEnv;
});
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
const holds = (doc: string, phrase: string) => expect(doc.includes(phrase) ? phrase : `missing: ${phrase}`).toBe(phrase);
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
const ROOT = join(import.meta.dir, "../rootfs/opt/cain");
const MAIN = JSON.stringify(join(ROOT, "record/main.ts"));
const HEX40 = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

type K = ReturnType<typeof keeperRig>;
const keeperStatus = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const keeperState = (k: K) => JSON.parse(readFileSync(k.cfg.holds!, "utf8"));
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const round = (k: K, id: string) => { k.cain({ id, ops: [{ op: "note", item: "P44", text: `a round ${id}` }] }); return cycle(k.cfg); };
const told = (k: K, s: string) => k.relayed().split(" / ").filter((l) => l.includes(s)).length;
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
const tomb = (k: K, tap: string, id: string) => appendLog(tapsLogFile(k.cfg), { t: "dropped", tap, id, unlanded: true, why: "test", at: "x" });
const pushOff = (k: K) => { k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); }; };
const quiet = () => { const lines: string[] = []; console.log = (...a: any[]) => { lines.push(a.join(" ")); }; return lines; };
const forceFile = (k: K) => join(dirname(k.cfg.queue), "record-force-conflict");
const recordSh = (k: K, ...a: string[]) => Bun.spawnSync(["bash", join(ROOT, "record.sh"), ...a], { env: { ...process.env, RECORD_FORCE_CONFLICT: forceFile(k), RECORD_HOLDS: k.cfg.holds! }, stdout: "pipe", stderr: "pipe" });
// Assistant- and owner-facing text, and every status field: no hex run of seven or more (tap keys aside), and no ref or
// path fragment (the documented command aside).
const clean = (text: string) => {
  const t = text.replaceAll(RESET_COPY_CMD, "").replace(/\btap-[0-9a-f]{12}\b/g, "");
  expect(t).not.toMatch(/[0-9a-f]{7,}/i);
  expect(t).not.toMatch(/refs\/|origin\/|\.git\b|HEAD|\b[\w.-]+\/[\w.-]+\.\w+|\/[\w.-]+\//);
};
const PUSH_FIELDS = ["push_refused", "push_alarms", "alarm_check", "push_unknown", "landing_skipped", "landing_held", "fetch_hiccup", "push_slow"];
const cleanStatus = (k: K) => { const st = keeperStatus(k); for (const f of PUSH_FIELDS) if (st[f] !== undefined) clean(JSON.stringify(st[f]).replace(/"(since|at|hiccupSince|hiccup_since)":"[^"]*"/g, "")); };
const childRun = (k: K, o: { monos?: number[]; boot?: string; cycles?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "r24-run-")), script = join(dir, "run.ts");
  const cfg = JSON.stringify({ ...k.cfg, now: undefined, clockSynced: undefined, beforePush: undefined, gitHook: undefined, mono: undefined, bootId: undefined });
  const monos = o.monos ?? Array(o.cycles ?? 1).fill(0);
  writeFileSync(script, `import { cycle } from ${MAIN};\nconst cfg: any = ${cfg};\nconst NOW = ${k.cfg.now!().getTime()};\nconst monos = ${JSON.stringify(monos)};\nlet i = 0;\n`
    + `cfg.now = () => new Date(NOW); cfg.clockSynced = () => true; cfg.mono = () => monos[Math.min(i, monos.length - 1)];\n`
    + (o.boot ? `cfg.bootId = () => ${JSON.stringify(o.boot)};\n` : "")
    + `const out = [];\nfor (i = 0; i < monos.length; i++) out.push(cycle(cfg).ok);\nconsole.log("RESULT " + JSON.stringify(out));\n`);
  const p = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const m = /RESULT (.*)/.exec(p.stdout.toString());
  if (!m) throw new Error(`the child run failed: ${p.stderr.toString().slice(-800)}`);
  return JSON.parse(m[1]) as boolean[];
};
const holdLockAsync = async (file: string, ms: number) => {
  const dir = mkdtempSync(join(tmpdir(), "r24-holder-")), script = join(dir, "holder.ts"), flag = join(dir, "in");
  writeFileSync(script, `import { withLogLock } from ${JSON.stringify(join(ROOT, "applog.ts"))};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < Number(process.argv[4])) {} });\n`);
  const done = new Promise<number>((ok) => spawn("bun", [script, file, flag, String(ms)], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
  for (let i = 0; i < 500 && !existsSync(flag); i++) await new Promise((ok) => setTimeout(ok, 10));
  expect(existsSync(flag)).toBe(true);
  return { done };
};
// A push-refused hold of kind unknown-remote (the guard can't see GitHub's branch), told at once.
const unknownRemoteHold = (kid: string, id: string) => {
  const { k } = keeperWithKey(kid, id);
  pushOff(k); cycle(k.cfg);
  tomb(k, "tap-00000099bbbb", "cain-some-other-request");
  k.cfg.beforePush = () => { g(k, "update-ref", "-d", "refs/remotes/origin/main"); };
  expect(cycle(k.cfg).ok).toBe(false);
  expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote" });
  k.cfg.beforePush = undefined;
  return k;
};

describe("1. every network call is timed, and a timeout is a hiccup round (invariants: the keeper state, the keeper status, the record trailers)", () => {
  test("a never-answering upload-pack on the opening fetch: the round completes, nothing consumed wrongly, kept as a fetch hiccup; the next round retries and clears it", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-1-0").ok).toBe(true);
    k.cfg.pushTimeoutMs = 1500;
    g(k, "config", "remote.origin.uploadpack", "sleep 600; true");          // GitHub never answers a fetch (or a read-back)
    const kid = "tap-0000003f2401";
    addTap(k, kid, "cain-r24-1-a");
    const t = performance.now();
    cycle(k.cfg);
    expect(performance.now() - t).toBeLessThan(20_000);
    // Round 25: a hiccup round holds the tap-derived request (nothing consumed); it is decided once a fetch answers.
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.some((x) => x.t === "dropped")).toBe(false);
    expect(keeperState(k).fetchHiccup).toMatchObject({ rounds: 1, cause: "fetch-timeout" });
    expect(keeperStatus(k).fetch_hiccup).toMatchObject({ rounds: 1, why: FETCH_HICCUP_WHY["fetch-timeout"] });
    expect(keeperPushRows(keeperStatus(k)).map((r) => r.row)).toContain("fetch-hiccup");
    cleanStatus(k);
    // GitHub answers again: the next round fetches, the hiccup is cleared, the request is on GitHub once.
    g(k, "config", "--unset", "remote.origin.uploadpack");
    cycle(k.cfg);
    expect(keeperState(k).fetchHiccup).toBeUndefined();
    expect(keeperStatus(k).fetch_hiccup).toBeUndefined();
    expect(remoteRequests(k, kid)).toEqual(["cain-r24-1-a"]);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r24-1-a");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.tap === kid && x.t === undefined)).toHaveLength(1);
  }, 90_000);

  test("past its threshold a run of fetch hiccups is told once, in fixed words; the fetch answering again is told once", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-1-b0").ok).toBe(true);
    k.cfg.gitHook = (a) => { if (a[0] === "fetch") throw new Error(`fatal: unable to access the remote at /data/x/${HEX40} (injected)`); };
    for (let n = 0; n < 6; n++) cycle(k.cfg);
    expect(keeperState(k).fetchHiccup).toMatchObject({ rounds: 6, cause: "fetch-failed", told: true });
    expect(told(k, "can't read GitHub")).toBe(1);
    for (const l of k.relayed().split(" / ").filter((x) => x.includes("GitHub"))) clean(l);
    cleanStatus(k);
    k.cfg.gitHook = undefined;
    cycle(k.cfg);
    expect(keeperState(k).fetchHiccup).toBeUndefined();
    expect(told(k, "reads GitHub again")).toBe(1);
  }, 90_000);

  test("the wrapper stops a command that never answers, with its whole session; the Date header's read goes through it", () => {
    const t = performance.now();
    const r = netRun(["sleep", "30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(performance.now() - t).toBeLessThan(5_000);
    const src = readFileSync(join(ROOT, "record/main.ts"), "utf8");
    expect(src).toMatch(/const p = netRun\(\["curl"/);
    expect(src).toContain('git(cfg, ["fetch", "--quiet", "origin", cfg.branch], cfg.dir, netTimeout(cfg)); }\n  catch (e) { fetched = false;');
    // Every network git call in the keeper carries the timed wrapper.
    // Round 25: the push and its read-back take their limit from the guarded section's deadline (net, { timeoutMs: limit }).
    for (const line of src.split("\n").filter((l) => /git\(cfg, \["(fetch|ls-remote|clone|push)"/.test(l))) expect(/netTimeout\(cfg\)\)|, net\);|\{ timeoutMs: limit \}\)/.test(line) ? "timed" : line.trim()).toBe("timed");
  }, 20_000);
});

describe("2. a failing resolver of a push of unknown outcome counts and falls back (invariants: the keeper status, the consumed-key log)", () => {
  test("an injected listing failure: tries counted, the row kept with a fixed cause, told once; after the fallback tries a clean scan settles it as not landed", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-2-0").ok).toBe(true);
    const kid = "tap-0000003f2421";
    addTap(k, kid, "cain-r24-2-a");
    k.cfg.pushTimeoutMs = 1000;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");
    k.cfg.gitHook = (a) => { if (a[0] === "rev-list" && a.includes("--count")) throw new Error(`git rev-list: fatal: bad object ${HEX40} in /data/record/.git (injected)`); };
    expect(cycle(k.cfg).ok).toBe(false);
    expect(keeperStatus(k).push_unknown).toMatchObject({ why: PUSH_UNKNOWN_STUCK_WHY, resolver_fails: 1, told: true });
    expect(keeperStatus(k).push_unknown.keys).toContain(kid);
    expect(told(k, "Push outcome unsettled")).toBe(1);
    cleanStatus(k);
    g(k, "config", "--unset", "remote.origin.receivepack");
    pushOff(k);
    for (let n = 1; n < PUSH_UNKNOWN_FALLBACK_TRIES - 1; n++) { cycle(k.cfg); expect(keeperStatus(k).push_unknown).toMatchObject({ resolver_fails: n + 1 }); }
    expect(told(k, "Push outcome unsettled")).toBe(1);
    cycle(k.cfg);                                                       // the fallback: neither the head nor the key is on GitHub
    expect(keeperStatus(k).push_unknown).toBeUndefined();
    expect(told(k, "Push outcome settled")).toBe(1);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r24-2-a");
    k.cfg.gitHook = undefined; k.cfg.beforePush = undefined;
    expect(cycle(k.cfg).ok).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r24-2-a"]);
  }, 90_000);

  test("a head the copy no longer has: the strict scan of GitHub's history runs at once", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-2-b0").ok).toBe(true);
    const st = keeperState(k);
    // Round 25: keysOk, the key extraction behind the record succeeded (needed for "not landed").
    st.pushUnknown = { at: new Date(k.cfg.now!().getTime()).toISOString(), head: "e".repeat(40), before: null, keys: ["tap-0000003f2422"], keysOk: true, why: "the push got no answer within its time limit and was stopped", tries: 1 };
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    cycle(k.cfg);
    expect(keeperStatus(k).push_unknown).toBeUndefined();
    expect(keeperState(k).pushUnknown).toBeUndefined();
  }, 60_000);
});

describe("3. a missing consumed-key log is verified absence only when the keeper's state proves it never existed (invariants: the consumed-key log, the record trailers)", () => {
  const pushedWithTomb = (kid: string, id: string) => {
    const { k } = keeperWithKey(kid, id);
    pushOff(k); cycle(k.cfg);
    k.cfg.beforePush = undefined;
    tomb(k, "tap-00000099bbbc", "cain-some-other-request");
    return k;
  };
  test("the log deleted after tombstones exist: the alarm check is incomplete and the push guard refuses", () => {
    const k = pushedWithTomb("tap-0000003f2431", "cain-r24-3-a");
    expect(keeperState(k).tapsLogBorn).toBe(true);
    rmSync(tapsLogFile(k.cfg));
    expect(pushedTombstoned(k.cfg, null, "x").incomplete).toBe("the consumed-key log couldn't be read to check what the push carried");
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log" });
  }, 60_000);
  test("a log path that isn't there, with the state showing the log existed: incomplete", () => {
    const k = pushedWithTomb("tap-0000003f2432", "cain-r24-3-b");
    expect(pushedTombstoned({ ...k.cfg, tapsLog: join(k.root, "no-such-dir", "x") } as any, null, "x").incomplete).toBeDefined();
  }, 60_000);
  test("a keeper whose state proves the log never existed: no tombstones, verified (round 25: no state at all needs independent proof)", () => {
    const d = mkdtempSync(join(tmpdir(), "r24-pristine-"));
    const cfg: any = { queue: join(d, "queue"), holds: join(d, "holds.json"), tapsLog: join(d, "taps.jsonl"), dir: join(d, "record"), branch: "main" };
    // Round 25: no state and no copy is no proof of a first start (source-check-round25.test.ts covers the proof).
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
    writeFileSync(cfg.holds, JSON.stringify({ holds: {}, waiting: [], downtime: [], logHigh: { consumed: 0 } }));
    expect(pushedTombstoned(cfg, null, "x")).toEqual({ alarms: [] });
    writeFileSync(cfg.holds, JSON.stringify({ holds: {}, waiting: [], downtime: [], logHigh: { consumed: 2 } }));
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
    writeFileSync(cfg.holds, "{ not json");
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
  });
});

describe("4. a landing skip's cause is fixed words (invariants: the consumed-key log, the keeper status)", () => {
  test("an error carrying a path and a full sha: the row says 'other' in fixed words, the raw text only in the keeper's log; every status field clean", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-4-0").ok).toBe(true);
    addTap(k, "tap-0000003f2441", "cain-r24-4-a", "first", 7);
    expect(cycle(k.cfg).ok).toBe(true);
    const raw = `open /data/record-taps.jsonl failed at ${HEX40} on refs/remotes/origin/main`;
    k.cfg.crashPoint = (w) => { if (w === "landing-mark") throw new Error(raw); };
    const lines = quiet();
    cycle(k.cfg);
    console.log = realLog;
    k.cfg.crashPoint = undefined;
    expect(keeperStatus(k).landing_skipped).toEqual([{ tap: "tap-0000003f2441", id: "cain-r24-4-a", cause: "other", why: LAND_SKIP_WHY.other }]);
    cleanStatus(k);
    expect(lines.some((l) => l.includes(HEX40) && l.includes("landing check"))).toBe(true);
    cycle(k.cfg);
    expect(keeperStatus(k).landing_skipped).toBeUndefined();
  }, 60_000);
  test("each cause maps to its fixed words, and none carries a hex run, ref or path", () => {
    expect(landSkipCause(new LockTimeout("/data/record-taps.jsonl", 30_000))).toBe("lock-timeout");
    expect(landSkipCause(Object.assign(new Error(`EACCES: /data/x/${HEX40}`), { code: "EACCES" }))).toBe("read-failed");
    expect(landSkipCause(new Error(`fatal ${HEX40}`))).toBe("other");
    for (const w of Object.values(LAND_SKIP_WHY)) clean(w);
  });
});

describe("5. record.sh reset-copy is stamped with its hold and used up by the next round (invariants: the keeper state, the consumed-key log)", () => {
  test("refused while no push-refused hold is recorded; nothing is written", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-5-0").ok).toBe(true);
    const sh = recordSh(k, "reset-copy");
    expect(sh.exitCode).toBe(1);
    expect(sh.stderr.toString()).toContain("refused");
    expect(existsSync(forceFile(k))).toBe(false);
  }, 60_000);
  test("a stale stamp (its hold no longer recorded): used up without acting, a later round's local commits pushed, never discarded", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-5-b0").ok).toBe(true);
    pushOff(k);
    round(k, "cain-r24-5-b1");                                          // local commits GitHub doesn't have
    k.cfg.beforePush = undefined;
    writeFileSync(forceFile(k), JSON.stringify({ by: "reset-copy", hold: "hold-99", epoch: 0, at: "x" }));
    const lines = quiet();
    expect(cycle(k.cfg).ok).toBe(true);
    console.log = realLog;
    expect(existsSync(forceFile(k))).toBe(false);
    expect(lines.some((l) => l.includes(RESET_COPY_WHY.stale))).toBe(true);
    expect(remoteHas(k, "a round cain-r24-5-b1")).toBe(true);
    expect(keeperState(k).lastReset).toBeUndefined();
    // With nothing local at all it is used up too.
    writeFileSync(forceFile(k), JSON.stringify({ by: "reset-copy", hold: "hold-98", epoch: 0, at: "x" }));
    cycle(k.cfg);
    expect(existsSync(forceFile(k))).toBe(false);
    // An unstamped request (the old empty-file form is the smoke test's switch; anything else) never acts.
    pushOff(k); round(k, "cain-r24-5-b2"); k.cfg.beforePush = undefined;
    writeFileSync(forceFile(k), JSON.stringify({ by: "reset-copy" }));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(existsSync(forceFile(k))).toBe(false);
    expect(remoteHas(k, "a round cain-r24-5-b2")).toBe(true);
    expect(keeperState(k).lastReset).toBeUndefined();
  }, 90_000);
  test("the hold still recorded: stamped with its id and epoch, the copy reset, the discarded commits and their keys logged in fixed words", () => {
    const kid = "tap-0000003f2451";
    const { k } = keeperWithKey(kid, "cain-r24-5-a", "his first answer");
    pushOff(k); cycle(k.cfg);
    k.cain({ id: "cain-r24-5-later", ops: [{ op: "note", item: "P11", text: "a later note on the same item" }] });
    cycle(k.cfg);
    tomb(k, kid, "cain-r24-5-a");
    dropQueued(k, "cain-r24-5-a");
    k.cfg.beforePush = undefined;
    expect(cycle(k.cfg).ok).toBe(false);
    const hold = keeperState(k).pushRefused;
    expect(hold).toMatchObject({ kind: "conflict", id: expect.stringMatching(/^hold-\d+$/) });
    const sh = recordSh(k, "reset-copy");
    expect(sh.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(forceFile(k), "utf8"))).toMatchObject({ by: "reset-copy", hold: hold.id, epoch: keeperState(k).epoch?.n ?? 0 });
    const lines = quiet();
    cycle(k.cfg);
    console.log = realLog;
    expect(existsSync(forceFile(k))).toBe(false);
    const acted = lines.find((l) => l.includes(RESET_COPY_WHY.acted))!;
    expect(acted).toMatch(/: \d+ local commit\(s\) discarded, carrying \d+ consumed tap key\(s\)/);
    expect(acted).toContain(kid);
    expect(keeperState(k).lastReset).toBeDefined();
    for (let n = 0; n < 3 && keeperStatus(k).push_refused; n++) cycle(k.cfg);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(remoteHas(k, "a later note on the same item")).toBe(true);
    expect(remoteHas(k, "his first answer")).toBe(false);
  }, 120_000);
});

describe("6. one lock timeout skips the rest of the landing loop (invariants: the consumed-key log)", () => {
  test("three records to mark and the lock held elsewhere: all three skipped as lock-timeout within about one wait", async () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-6-0").ok).toBe(true);
    addTap(k, "tap-0000003f2461", "cain-r24-6-a", "first", 7);
    addTap(k, "tap-0000003f2462", "cain-r24-6-b", "second", 8);
    addTap(k, "tap-0000003f2463", "cain-r24-6-c", "third", 9);
    expect(cycle(k.cfg).ok).toBe(true);
    lockWait.ms = 100;                                                  // each wait: consumedWait(), 1.8 seconds
    const h = (await holdLockAsync(tapsLogFile(k.cfg), 9000)).done;
    const t = performance.now();
    const r = unlandedConsumes(k.cfg, { fetched: true, inStep: true, now: k.cfg.now!().getTime(), watch: {} });
    const took = performance.now() - t;
    expect(r.skipped.map((s) => s.cause)).toEqual(["lock-timeout", "lock-timeout", "lock-timeout"]);
    expect(took).toBeLessThan(consumedWait() * 1.7);
    expect(await h).toBe(0);
  }, 60_000);
});

describe("7. hiccup rounds count on the push-refused hold (invariants: the keeper status)", () => {
  test("the read-back keeps failing: each unconfirmed round counted with its age, told once past the threshold; a later fetch with nothing to push clears it", () => {
    const k = unknownRemoteHold("tap-0000003f2471", "cain-r24-7-a");
    k.cfg.gitHook = (a) => { if (a[0] === "ls-remote") throw new Error("ls-remote: no answer (injected)"); };
    for (let n = 1; n <= PUSH_HICCUP_TELL_AFTER; n++) {
      round(k, `cain-r24-7-r${n}`);
      expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote", hiccups: n, hiccup_age_min: expect.any(Number) });
    }
    expect(told(k, "still aren't confirmed")).toBe(1);
    round(k, "cain-r24-7-more");
    expect(told(k, "still aren't confirmed")).toBe(1);
    const rows = keeperPushRows(keeperStatus(k)) as any[];
    expect(rows.find((r) => r.row === "push-refused")).toMatchObject({ hiccups: PUSH_HICCUP_TELL_AFTER + 1 });
    cleanStatus(k);
    cycle(k.cfg);                                                       // nothing to push, the copy in step with a fresh fetch
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(told(k, "pushes to GitHub go again")).toBe(1);
  }, 120_000);
});

describe("8. the push's wall-clock limit is a ceiling over git's low-speed abort (invariants: the consumed-key log, the keeper status)", () => {
  test("the ceiling is 60 to 90 seconds, configurable, and kept below the consumed-key log's wait", () => {
    expect(PUSH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(PUSH_TIMEOUT_MS).toBeLessThanOrEqual(90_000);
    expect(PUSH_TIMEOUT_MS).toBeLessThan(consumedWait());
    const cfg: any = {};
    expect(netTimeout(cfg).timeoutMs).toBe(PUSH_TIMEOUT_MS);
    process.env.RECORD_PUSH_TIMEOUT_S = "60";
    expect(netTimeout(cfg).timeoutMs).toBe(60_000);
    process.env.RECORD_PUSH_TIMEOUT_S = "600";
    expect(netTimeout(cfg).timeoutMs).toBeLessThan(consumedWait());
    const src = readFileSync(join(ROOT, "record/main.ts"), "utf8");
    expect(src).toContain("http.lowSpeedLimit=${NET_LOW_SPEED_BYTES}");
    expect(flat("../rootfs/etc/services.d/cain/run")).toContain("export RECORD_PUSH_TIMEOUT_S=75");
  });
  test("pushes stopped at the limit three times in a row: a push-slow row in fixed words, told once; a push within the limit clears it; durations logged", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-8-0").ok).toBe(true);
    k.cfg.pushTimeoutMs = 700;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");
    const lines = quiet();
    for (let n = 1; n <= PUSH_SLOW_AFTER; n++) round(k, `cain-r24-8-${n}`);
    console.log = realLog;
    expect(lines.filter((l) => /push took \d+ ms \(limit 700 ms\), stopped at the limit/.test(l)).length).toBe(PUSH_SLOW_AFTER);
    expect(keeperStatus(k).push_slow).toMatchObject({ count: PUSH_SLOW_AFTER, why: PUSH_SLOW_WHY });
    const rows = keeperPushRows(keeperStatus(k));
    expect(rows.map((r) => r.row)).toContain("push-slow");
    expect(outageWhy(rows.filter((r) => r.row === "push-slow"), {} as any)).toContain("too slow");
    expect(told(k, "too slow for a push")).toBe(1);
    cleanStatus(k);
    g(k, "config", "--unset", "remote.origin.receivepack");
    cycle(k.cfg);
    expect(keeperStatus(k).push_slow).toBeUndefined();
  }, 90_000);
});

describe("9. the session tool is checked at start, and no child of a killed push survives (invariants: every append-only log)", () => {
  test("without the session tool the start probe refuses with the fixed reason", () => {
    const k = keeperRig();
    netTest.setsid = "";
    expect(keeperLockProbe(k.cfg)).toBe(NET_SESSION_WHY);
    netTest.setsid = null;
    expect(keeperLockProbe(k.cfg)).toBeNull();
  }, 30_000);
  test("a push killed at its limit leaves no process behind", () => {
    const k = keeperRig();
    expect(round(k, "cain-r24-9-0").ok).toBe(true);
    k.cfg.pushTimeoutMs = 1000;
    g(k, "config", "remote.origin.receivepack", "sleep 6247; true");
    round(k, "cain-r24-9-a");
    Bun.sleepSync(300);
    const ps = Bun.spawnSync(["ps", "-eo", "args"], { stdout: "pipe" }).stdout.toString();
    expect(ps.split("\n").filter((l) => l.includes("sleep 6247") && !l.includes("ps -eo"))).toEqual([]);
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

describe("10. re-bases of a landing watch show as a row (invariants: the consumed-key log, the keeper state)", () => {
  test("the boot id unreadable and the keeper restarted each time: re-bases counted, a landing-held row past the threshold", () => {
    const kid = "tap-0000003f24a1";
    const k = watchSetup(kid, "cain-r24-10-a");
    for (let n = 0; n <= LAND_REBASE_ROW_AFTER; n++) childRun(k, { boot: "unknown", monos: [10_000 + n * 40 * MIN] });
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ rebases: LAND_REBASE_ROW_AFTER });
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r24-10-a");
    expect(keeperStatus(k).landing_held).toEqual([{ tap: kid, id: "cain-r24-10-a", rebases: LAND_REBASE_ROW_AFTER, why: LAND_HELD_WHY }]);
    expect(keeperPushRows(keeperStatus(k)).find((r) => r.row === "landing-held")).toMatchObject({ tap_key: kid, failures: LAND_REBASE_ROW_AFTER });
    cleanStatus(k);
  }, 180_000);
});

// Round 25: the textual lock lint that was here is replaced by the TypeScript-compiler AST check in
// source-check-round25.test.ts (lockLintAst), which also matches every lock-taking call against the lock-site scan.
describe("11. the link's real entry file starts (invariants: every append-only log)", () => {
  test("the link's real entry file, launched the way the image does (bun <file>), passes the start gate and listens", async () => {
    const d = mkdtempSync(join(tmpdir(), "r24-link-"));
    mkdirSync(join(d, "work"), { recursive: true });
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const env: Record<string, string> = { ...process.env as any, CAIN_TRUST_DIR: join(d, "trust"), CAIN_CARDS: join(d, "trust/cards.json"), CAIN_STOP_FILE: join(d, "trust/stop.json"), CAIN_SHIP_PUB: join(d, "trust/ship.pub"),
      CAIN_GATE_REPLAY: join(d, "work/gate-replay.json"), CAIN_TRANSCRIPTS: join(d, "transcripts"), CAIN_REVIEWED: join(d, "reviewed"), CAIN_GATE_LOG: join(d, "work/gate.jsonl"),
      INSTALL_RESULTS: join(d, "work/install-tests.json"), LINK_DIR: join(d, "link"), LINK_ENV: join(d, "discord.env"), LINK_EXPIRED_LOG: join(d, "link-expired.log"), LINK_HELD_LOG: join(d, "link-held.log"),
      LINK_ISSUED_LOG: join(d, "link-issued.log"), LINK_LOG: join(d, "work/link.log"), LINK_NOTICES: join(d, "work/notices.jsonl"), LINK_STRIP_LOG: join(d, "link-strip.log"),
      RECORD_DIR: join(d, "record"), RECORD_HOLDS: join(d, "holds.json"), RECORD_INSTALL_LOG: join(d, "install.log"), RECORD_ISSUED_LOG: join(d, "issued.log"), RECORD_LANDINGS: join(d, "landings"),
      RECORD_OUTCOMES: join(d, "outcomes"), RECORD_QUEUE: join(d, "queue"), RECORD_RECOVER: join(d, "recover.json"), RECORD_STATUS: join(d, "ledger.json"), RECORD_TAPS_LOG: join(d, "taps.jsonl"),
      RECORD_WAITS: join(d, "waits.jsonl"), RELAY_PORT: port, RELAY_QUEUE: join(d, "relay.queue"), SOURCE_CHECK_TUNING: join(d, "work/tuning.jsonl") };
    const p = Bun.spawn(["bun", join(ROOT, "link/main.ts")], { env, stdout: "pipe", stderr: "pipe" });
    let out = "";
    const reader = (async () => { for await (const c of p.stdout as any) { out += Buffer.from(c).toString(); if (out.includes("link listening on")) break; } })();
    await Promise.race([reader, Bun.sleep(30_000)]);
    p.kill("SIGKILL");
    expect(out).not.toContain("REFUSED TO START");
    expect(out).toContain(`link listening on ${port}`);
  }, 45_000);
});

describe("12. the docs say what round 24 changed", () => {
  test("DOCS.md, the table, Cain's rules, keeper.sh, record.sh and the CHANGELOG name the round-24 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), table = flat(INVARIANTS);
    holds(docs, "Round 24");
    holds(table, "source-check-round24.test.ts");
    for (const p of ["opening fetch", "netRun", "fetch_hiccup", "resolver", "tapsLogBorn", "lock-timeout, read-failed, git-failed", "stamped with", "hiccups", "push_slow", "NET_SESSION_WHY", "landing_held", "lockLint"]) holds(table, p);
    holds(rules, "Push outcome unsettled");
    holds(rules, "can't read GitHub");
    holds(rules, "too slow for a push");
    holds(flat("../rootfs/opt/cain/keeper.sh"), "Round 24");
    holds(flat("../rootfs/opt/cain/record.sh"), "Round 24");
    holds(flat("../CHANGELOG.md"), "a slow connection");
  });
  test("nothing the owner or Cain hears from this round carries a job id or a sha, or asks him to send or tap again", async () => {
    const m = await import("../rootfs/opt/cain/record/main.ts");
    for (const line of [m.PUSH_HICCUP_LINE, m.FETCH_HICCUP_LINE, m.FETCH_AGAIN_LINE, m.PUSH_SLOW_LINE, m.pushUnknownStuckLine, m.PUSH_UNKNOWN_STUCK_WHY, m.LAND_HELD_WHY, m.PUSH_SLOW_WHY, m.NET_SESSION_WHY, ...Object.values(m.FETCH_HICCUP_WHY), ...Object.values(m.RESET_COPY_WHY)]) {
      clean(line);
      expect(line).not.toMatch(/tap again|send .* again|answer again|cse_|session_/i);
    }
  });
});
