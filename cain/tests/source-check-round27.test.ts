// Source checks, twenty-seventh review round (0.13.0): five fixes from the twenty-sixth outside review, each on the
// consumed-key log's loss handling. Loss is detected against a durable high-water record count (every record, tombstones
// included), not the consumed count; the rebuild carries every intact tombstone forward, rebuilds consumptions only from
// refs fetched from GitHub and withdraws (or holds) local commits whose tap key GitHub doesn't have; the created flag is set
// and fsynced first on any start that finds the log or a trailer, a fresh start included, and the state serialiser never
// writes it false; the pristine first start needs real proof (a whole copy, every remote ref fetched this round, the full
// history scanned); the rebuild's mark is durable before its first write and the log is rewritten through a temporary file.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
// New exports are read through the module namespace, so on a keeper without them only the tests that need them fail.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, crashSpy, readLog, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import * as K from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const { abandonCommits, cycle, forgetRebuild, GUARD_WHY, pushedTombstoned, readConsumed, tapsLogFile } = K;
const M: any = K;
const realLog = console.log;
afterEach(() => { console.log = realLog; crashSpy.on = null; });
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
type R = ReturnType<typeof keeperRig>;
const state = (k: R) => JSON.parse(readFileSync(k.cfg.holds!, "utf8"));
const setState = (k: R, f: (j: any) => void) => { const j = state(k); f(j); writeFileSync(k.cfg.holds!, JSON.stringify(j)); };
const linkLog = (k: R) => join(k.root, "pi/link-issued.log");
const quiet = () => { console.log = () => {}; };
const run = (k: R) => { quiet(); try { return cycle(k.cfg); } finally { console.log = realLog; } };
const addTap = (k: R, kid: string, id: string, n = 7) => {
  const at = k.cfg.now!().getTime(), card = sf(at, n);
  appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + DAY, life: DAY });
  const f = join(k.root, "pi/link/state.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  st.issued = { ...(st.issued ?? {}), [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } };
  writeFileSync(f, JSON.stringify(st));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text: `his tap ${id}` }] }, { issue: false });
};
const fresh = () => { const k = keeperRig(); k.cain({ id: "cain-r27-start", ops: [{ op: "note", item: "P44", text: "a first round" }] }); expect(run(k).ok).toBe(true); return k; };
const pushesOff = (k: R) => { k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); }; };
const fetchFails = (k: R) => { k.cfg.gitHook = (a) => { if (a[0] === "fetch") throw new Error("fatal: unable to access the remote (injected)"); }; };
const dropQueued = (k: R, id: string) => { for (const n of readdirSync(k.cfg.queue)) if (readFileSync(join(k.cfg.queue, n), "utf8").includes(`"${id}"`)) rmSync(join(k.cfg.queue, n)); };
const tomb = (k: R, tap: string, id: string) => appendLog(tapsLogFile(k.cfg), { t: "dropped", tap, id, unlanded: true, why: "test", at: "x" });
const g = (k: R, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: k.cfg.dir }).stdout.toString();
const localKeys = (k: R) => g(k, "log", "--format=%(trailers:key=Tap-Key,valueonly)", "refs/remotes/origin/main..HEAD");
const remoteRequests = (k: R, kid: string) => {
  const p = Bun.spawnSync(["git", "log", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)", "main"], { cwd: k.remote });
  return p.stdout.toString().split("\x1e").map((l) => l.split("\x1f").map((x) => x.trim())).filter(([t]) => t === kid).map(([, id]) => id);
};
const logRecs = (k: R) => readLog<any>(tapsLogFile(k.cfg), { repair: false }).records;
// A tap consumed by the keeper with its commit kept local (pushes off), its request then out of the queue, as for a drop.
const localDropped = (k: R, kid: string, id: string) => {
  addTap(k, kid, id); pushesOff(k); run(k);
  expect(localKeys(k)).toContain(kid);
  dropQueued(k, id);
};

describe("1. loss is detected against the high-water record count, not the consumed count (invariants: the consumed-key log, the keeper state)", () => {
  test("a tombstone-only log lost, then an append, then a push of the dropped commit: refused, the commit never reaches GitHub", () => {
    const k = fresh();
    localDropped(k, "tap-00000027aa01", "cain-r27-1-a");
    // The log holds only the drop's tombstone for that commit (consumed count 0), the state saying one record was written.
    writeLogForTest(tapsLogFile(k.cfg), [{ t: "dropped", tap: "tap-00000027aa01", id: "cain-r27-1-a", unlanded: true, why: "test", at: "x" }]);
    setState(k, (j) => { j.logHigh = { ...(j.logHigh ?? {}), consumed: 0 }; j.tapsLogBorn = true; j.tapsLogLen = 1; });
    rmSync(tapsLogFile(k.cfg));                                         // the tombstone-only log is lost
    addTap(k, "tap-00000027aa02", "cain-r27-1-b");                      // a new tap: the round appends to the log
    k.cfg.beforePush = undefined;
    run(k);
    expect(remoteRequests(k, "tap-00000027aa01")).toEqual([]);          // the dropped commit was never pushed
    expect(localKeys(k)).not.toContain("tap-00000027aa01");
    expect(readConsumed(k.cfg).has("tap-00000027aa01")).toBe(false);
    run(k);
    expect(remoteRequests(k, "tap-00000027aa01")).toEqual([]);
  }, 90_000);

  test("an append after a loss the round hasn't seen yet: the strict reader finds the shortfall and the guard refuses", () => {
    const k = fresh();
    addTap(k, "tap-00000027aa03", "cain-r27-1-c"); run(k);
    expect(state(k).tapsLogLen).toBeGreaterThan(0);
    const n = state(k).tapsLogLen;
    writeLogForTest(tapsLogFile(k.cfg), [{ t: "landed", tap: "tap-00000027aa03", id: "cain-r27-1-c", at: "x" }]);   // cut short to one record
    expect(n).toBeGreaterThan(1);
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log", refused: GUARD_WHY.log });
    expect(pushedTombstoned(k.cfg, null, "x").incomplete).toBeDefined();
  }, 60_000);
});

describe("2. the rebuild preserves tombstones and rebuilds consumptions only from GitHub (invariants: the consumed-key log, the record trailers)", () => {
  test("a shortened log keeping a tombstone for an unabandoned local commit: the tombstone carried, the commit withdrawn, never pushed", () => {
    const k = fresh();
    addTap(k, "tap-00000027bb01", "cain-r27-2-a"); run(k);               // on GitHub
    expect(remoteRequests(k, "tap-00000027bb01")).toEqual(["cain-r27-2-a"]);
    localDropped(k, "tap-00000027bb02", "cain-r27-2-b");                // local only, its request no longer queued
    tomb(k, "tap-00000027bb02", "cain-r27-2-b");                        // its tombstone (not abandoned yet)
    appendLog(tapsLogFile(k.cfg), { t: "landed", tap: "tap-00000027bb01", id: "cain-r27-2-a", at: "x" });
    run(k);                                                             // pushes still off: the count takes the records in
    expect(localKeys(k)).toContain("tap-00000027bb02");
    const recs = logRecs(k);
    writeLogForTest(tapsLogFile(k.cfg), recs.slice(0, -1));             // the log loses its last record
    fetchFails(k); run(k);                                              // the loss is seen; GitHub doesn't answer
    expect(state(k).tapsLogRebuild).toBeDefined();
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log" });
    k.cfg.gitHook = undefined; k.cfg.beforePush = undefined;
    run(k);                                                             // GitHub answers: the rebuild
    expect(state(k).tapsLogRebuild).toBeUndefined();
    expect(logRecs(k).some((r) => r.t === "dropped" && r.unlanded === true && r.tap === "tap-00000027bb02" && r.id === "cain-r27-2-b")).toBe(true);
    expect(readConsumed(k.cfg).has("tap-00000027bb02")).toBe(false);    // never brought back from the local commit
    expect(readConsumed(k.cfg).get("tap-00000027bb01")).toBe("cain-r27-2-a");
    expect(localKeys(k)).not.toContain("tap-00000027bb02");
    run(k);
    expect(remoteRequests(k, "tap-00000027bb02")).toEqual([]);
  }, 120_000);

  test("a local commit whose key GitHub lacks and whose request isn't queued gets a tombstone and is never pushed", () => {
    const k = fresh();
    localDropped(k, "tap-00000027bb03", "cain-r27-2-c");                // not queued: withdrawn
    rmSync(tapsLogFile(k.cfg));
    k.cfg.beforePush = undefined;
    run(k);
    expect(state(k).tapsLogRebuild).toBeUndefined();
    expect(logRecs(k).some((r) => r.t === "dropped" && r.tap === "tap-00000027bb03" && r.why === M.TAPS_REBUILD_DROP_WHY)).toBe(true);
    expect(logRecs(k).some((r) => r.t === undefined && r.tap === "tap-00000027bb03")).toBe(false);
    expect(remoteRequests(k, "tap-00000027bb03")).toEqual([]);
  }, 90_000);
});

describe("3. the created flag first, on every start, and a serialiser that never writes it false (invariants: the keeper state, the consumed-key log)", () => {
  test("the log lost in the round after a fresh start: the flag was written first, so the loss is caught and the dropped commit never pushed", () => {
    const k = fresh();
    localDropped(k, "tap-00000027cc01", "cain-r27-3-a");
    tomb(k, "tap-00000027cc01", "cain-r27-3-a");
    rmSync(k.cfg.holds!);                                               // a fresh start: no keeper state
    forgetRebuild(k.cfg);
    let lost = false;
    k.cfg.gitHook = (a) => { if (a[0] === "fetch" && !lost) { lost = true; rmSync(tapsLogFile(k.cfg), { force: true }); } };
    run(k);                                                             // the log is lost during that first round
    expect(lost).toBe(true);
    expect(state(k).tapsLogBorn).toBe(true);
    k.cfg.gitHook = undefined; k.cfg.beforePush = undefined;
    run(k); run(k);
    expect(remoteRequests(k, "tap-00000027cc01")).toEqual([]);
  }, 120_000);

  test("the flag is on disk before anything else at a fresh start that finds the log", () => {
    const k = fresh();
    addTap(k, "tap-00000027cc02", "cain-r27-3-b"); run(k);
    rmSync(k.cfg.holds!);
    forgetRebuild(k.cfg);
    let first: any = undefined;
    k.cfg.gitHook = () => { if (first === undefined) first = existsSync(k.cfg.holds!) ? state(k) : null; };
    run(k);
    expect(first).toMatchObject({ tapsLogBorn: true });
    expect(first.tapsLogLen).toBeGreaterThan(0);
  }, 60_000);

  test("every state-write site goes through the one serialiser, and no write lowers the flag (property: every write of a run, and random states)", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    // Only writeState and the rebuild's own write touch the state file; every other site calls writeState.
    expect(src.match(/writeAtomic\(stateFile\(cfg\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/writeFileSync\(stateFile|writeAtomic\(file, JSON\.stringify\(st\)\)/);
    expect(src.match(/writeState\(cfg, /g)!.length).toBeGreaterThanOrEqual(8);
    // Every write of the state in a run that loses its log, starts fresh and rebuilds: once the flag is true it stays.
    const k = fresh();
    let seen = false, writes = 0;
    const bad: string[] = [];
    crashSpy.on = (file) => {
      if (file !== k.cfg.holds) return;
      const j = JSON.parse(readFileSync(`${file}.${process.pid}.tmp`, "utf8"));
      writes++;
      if (j.tapsLogBorn === true) seen = true; else if (seen) bad.push(JSON.stringify(j).slice(0, 80));
    };
    addTap(k, "tap-00000027cc03", "cain-r27-3-c"); run(k);
    rmSync(tapsLogFile(k.cfg)); run(k);
    rmSync(k.cfg.holds!); forgetRebuild(k.cfg); run(k);
    pushesOff(k); addTap(k, "tap-00000027cc04", "cain-r27-3-d"); run(k);
    k.cfg.beforePush = undefined; run(k);
    crashSpy.on = null;
    expect(seen).toBe(true);
    expect(writes).toBeGreaterThan(5);
    expect(bad).toEqual([]);
    // Random states: the serialiser keeps the flag, the count's high-water mark and the rebuild mark of the file.
    const d = mkdtempSync(join(tmpdir(), "r27-ser-"));
    const cfg: any = { queue: join(d, "queue"), holds: join(d, "holds.json"), tapsLog: join(d, "taps.jsonl"), dir: join(d, "record"), branch: "main" };
    let seed = 27;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 300; i++) {
      const pick = (): any => { const r = rnd() % 4; return r === 0 ? undefined : r === 1 ? false : r === 2 ? true : "yes"; };
      const was: any = { holds: {}, waiting: [], downtime: [], tapsLogBorn: pick(), tapsLogLen: rnd() % 5 === 0 ? undefined : rnd() % 50, ...(rnd() % 3 === 0 ? { tapsLogRebuild: { since: "x", why: "y" } } : {}) };
      writeFileSync(cfg.holds, JSON.stringify(was));
      const next: any = { holds: {}, waiting: [], downtime: [], tapsLogBorn: pick(), tapsLogLen: rnd() % 5 === 0 ? undefined : rnd() % 50 };
      M.writeState(cfg, JSON.stringify(next));
      const out = JSON.parse(readFileSync(cfg.holds, "utf8"));
      if (was.tapsLogBorn === true) expect(out.tapsLogBorn).toBe(true);
      if (Number.isInteger(was.tapsLogLen)) expect(out.tapsLogLen).toBeGreaterThanOrEqual(was.tapsLogLen);
      if (was.tapsLogRebuild) expect(out.tapsLogRebuild).toEqual(was.tapsLogRebuild);
    }
  }, 180_000);
});

describe("4. the pristine first start only with real proof (invariants: the consumed-key log, the record trailers)", () => {
  const remoteWith = (trailer: boolean) => {
    const d = mkdtempSync(join(tmpdir(), "r27-pristine-"));
    const seed = join(d, "seed"), remote = join(d, "remote.git");
    const sh = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }); if (p.exitCode) throw new Error(p.stderr.toString()); };
    mkdirSync(seed, { recursive: true });
    sh(seed, "init", "--quiet", "-b", "main");
    writeFileSync(join(seed, "a.md"), "a\n"); sh(seed, "add", "-A");
    sh(seed, "commit", "--quiet", "-m", trailer ? "an old tap\n\nTap-Key: tap-00000027dd01\nTap-Request: cain-r27-4" : "first");
    for (let i = 0; i < 3; i++) { writeFileSync(join(seed, "a.md"), `a${i}\n`); sh(seed, "commit", "--quiet", "-am", `later ${i}`); }
    sh(d, "clone", "--quiet", "--bare", seed, remote);
    sh(remote, "config", "uploadpack.allowFilter", "true");
    const cfg: any = { queue: join(d, "queue"), holds: join(d, "holds.json"), tapsLog: join(d, "taps.jsonl"), dir: join(d, "record"), branch: "main", remote };
    return { d, cfg, remote, sh };
  };
  test("a full clone of a history with no tap key, fetched this round: the first start counts as pristine", () => {
    const { d, cfg, remote, sh } = remoteWith(false);
    sh(d, "clone", "--quiet", `file://${remote}`, cfg.dir);
    M.fetchedThisRound(cfg, true);
    expect(pushedTombstoned(cfg, null, "x")).toEqual({ alarms: [] });
  });
  test("a shallow clone: no proof, its old tap key unseen", () => {
    const { d, cfg, remote, sh } = remoteWith(true);
    sh(d, "clone", "--quiet", "--depth", "1", `file://${remote}`, cfg.dir);
    M.fetchedThisRound?.(cfg, true);
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
  });
  test("a clone with a partial-clone filter: no proof", () => {
    const { d, cfg, remote, sh } = remoteWith(false);
    sh(d, "clone", "--quiet", "--filter=blob:none", `file://${remote}`, cfg.dir);
    M.fetchedThisRound?.(cfg, true);
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
  });
  test("a copy whose fetch failed this round, and one with a remote ref this round didn't fetch: no proof", () => {
    const { d, cfg, remote, sh } = remoteWith(false);
    sh(d, "clone", "--quiet", `file://${remote}`, cfg.dir);
    M.fetchFailed?.(cfg);                                              // GitHub didn't answer this round
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
    M.fetchedThisRound?.(cfg, false);                                  // the branch fetched, but another remote ref wasn't
    sh(cfg.dir, "update-ref", "refs/remotes/origin/other", "HEAD");
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();
  });
});

describe("5. the rebuilding mark is durable and the log rewritten through a temporary file (invariants: the keeper state, the consumed-key log)", () => {
  for (const point of ["detect", "mark", "write", "fsync", "clear"]) {
    test(`a crash at the rebuild's ${point} step: after a restart pushes stay refused until the rebuild completes`, () => {
      const k = fresh();
      addTap(k, `tap-00000027ee0${["detect", "mark", "write", "fsync", "clear"].indexOf(point)}`, `cain-r27-5-${point}`); run(k);
      rmSync(tapsLogFile(k.cfg));                                       // the log is lost
      let hit = false;
      k.cfg.crashPoint = (w) => { if (w === `taps-rebuild-${point}`) { hit = true; throw new Error(`crash point: ${w}`); } };
      quiet(); try { cycle(k.cfg); } catch { /* the crash */ } finally { console.log = realLog; }
      k.cfg.crashPoint = undefined;
      expect(hit).toBe(true);
      forgetRebuild(k.cfg);                                             // the restart
      expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log", refused: GUARD_WHY.log });
      fetchFails(k); run(k);                                            // GitHub out of reach: still refused
      expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log" });
      k.cfg.gitHook = undefined;
      run(k);                                                           // the rebuild completes
      expect(state(k).tapsLogRebuild).toBeUndefined();
      expect(abandonCommits(k.cfg).refused).toBeUndefined();
      expect(existsSync(`${tapsLogFile(k.cfg)}.rebuild.tmp`)).toBe(false);
    }, 90_000);
  }

  test("no in-process cache of the flag: the state is read at every append and every guarded push", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    expect(src).not.toContain("bornSeen");
    expect(src).toMatch(/function tombstonesStrict\(cfg: Config\): Set<string> \{\n\s+const out = new Set<string>\(\);\n\s+const j = rawState\(cfg\);/);
  });
});
