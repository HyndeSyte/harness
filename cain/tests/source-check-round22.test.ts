// Source checks, twenty-second review round (0.12.0): defects in the twenty-first round's own additions, fixed. The push
// path's tombstone check fails closed; the drop and the push are serialised by the consumed-key flock, with an alarm on a
// pushed tombstone; the state reviver keeps a waiting notice's request id and episode; every lock caller is listed and
// holds on a timeout; the landing window's first sighting and round count live in the keeper state per boot; a push
// refused on conflict is told and retried; the start probe needs errno and passes a contention self-test; the start gate
// is an imported module; the per-round torn check is a try-lock.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendLog, frame, LOCK_CALLERS, LOCK_SITES, LOCK_WAIT_MS, LockTimeout, lockTest, lockWait, lockRefusal, probeLock, readLog, resetFlockForTest, withLogLock, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import { appendInstall } from "../rootfs/opt/cain/installflag.ts";
import { plainPush, TAP_REPLAY_WAITING } from "../rootfs/opt/cain/link/core";
import { lockGate, LOCK_RETRY_MS } from "../rootfs/opt/cain/startgate.ts";
import { abandonCommits, cycle, dropUnlanded, INTENT_STUCK_ROUNDS, issuedMirrorFile, LANDED_MIN_ROUNDS, LANDED_WINDOW_MS, openIntents, pushAlarmLine, pushRefusedLine, readConsumed, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN, PR, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; lockTest.names = null; lockTest.call = null; lockTest.errnoSyms = null; lockWait.ms = LOCK_WAIT_MS; resetFlockForTest(); });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
const holds = (doc: string, phrase: string) => expect(doc.includes(phrase) ? phrase : `missing: ${phrase}`).toBe(phrase);
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));

type K = ReturnType<typeof keeperRig>;
const keeperStatus = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const keeperState = (k: K) => JSON.parse(readFileSync(k.cfg.holds!, "utf8"));
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const round = (k: K, id: string) => { k.cain({ id, ops: [{ op: "note", item: "P44", text: `a round ${id}` }] }); return cycle(k.cfg); };
const keeperWithKey = (kid: string, id: string, text = "his tap") => {
  const k = keeperRig();
  expect(round(k, `${id}-0`).ok).toBe(true);
  const at = k.cfg.now!().getTime(), card = sf(at);
  appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + DAY, life: DAY });
  writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } } }));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text }] }, { issue: false });
  return { k, card, at };
};
const g = (k: K, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: k.cfg.dir });
const dropQueued = (k: K, id: string) => { for (const n of readdirSync(k.cfg.queue)) if (readFileSync(join(k.cfg.queue, n), "utf8").includes(`"${id}"`)) rmSync(join(k.cfg.queue, n)); };
const remoteRequests = (k: K, kid: string) => {
  const p = Bun.spawnSync(["git", "log", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)", "main"], { cwd: k.remote });
  return p.stdout.toString().split("\x1e").map((l) => l.split("\x1f").map((x) => x.trim())).filter(([t]) => t === kid).map(([, id]) => id);
};
const remoteHas = (k: K, text: string) => Bun.spawnSync(["git", "grep", "-l", "-F", text, "main"], { cwd: k.remote }).stdout.toString().trim() !== "";
const remoteTipOf = (k: K) => Bun.spawnSync(["git", "rev-parse", "main"], { cwd: k.remote }).stdout.toString().trim();
const tomb = (k: K, tap: string, id: string) => appendLog(tapsLogFile(k.cfg), { t: "dropped", tap, id, unlanded: true, why: "test", at: "x" });
const pushOff = (k: K) => { k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); }; };
// A keeper with one unpushed commit (the tap's request, consumed) and one other tombstone in its log, so the guard has
// something to check.
const unpushedWithTomb = (kid: string, id: string) => {
  const w = keeperWithKey(kid, id);
  pushOff(w.k);
  cycle(w.k.cfg);
  expect(readConsumed(w.k.cfg).get(kid)).toBe(id);
  tomb(w.k, "tap-00000099aaaa", "cain-some-other-request");
  w.k.cfg.beforePush = undefined;
  return w;
};

describe("1. the push path's tombstone check fails closed (invariants: the consumed-key log, the record trailers)", () => {
  test("the remote branch unknown: no push, logged with the cause, listed under unresolved landings; a retry after recovery pushes", () => {
    const kid = "tap-0000002f2201";
    const { k } = unpushedWithTomb(kid, "cain-r22-1-a");
    const tip = remoteTipOf(k);
    k.cfg.beforePush = () => { g(k, "update-ref", "-d", "refs/remotes/origin/main"); };
    expect(cycle(k.cfg).ok).toBe(false);
    expect(remoteTipOf(k)).toBe(tip);                                  // nothing pushed
    expect(remoteRequests(k, kid)).toEqual([]);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "unknown-remote", tries: 1 });
    expect(k.relayed()).toContain("holding back its pushes to GitHub");
    k.cfg.beforePush = undefined;                                      // the next round's fetch knows the remote again
    expect(cycle(k.cfg).ok).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r22-1-a"]);
    expect(keeperStatus(k).push_refused).toBeUndefined();
    expect(k.relayed()).toContain("pushes to GitHub go again");
  }, 60_000);

  test("a git failure while listing the unpushed commits: no push; a retry after recovery pushes", () => {
    const kid = "tap-0000002f2202";
    const { k } = unpushedWithTomb(kid, "cain-r22-1-b");
    const tip = remoteTipOf(k);
    k.cfg.gitHook = (a) => { if (a[0] === "log" && a.some((x) => x.endsWith("..HEAD"))) throw new Error("git log: fatal: bad object (injected)"); };
    expect(cycle(k.cfg).ok).toBe(false);
    expect(remoteTipOf(k)).toBe(tip);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "git" });
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "git" });
    k.cfg.gitHook = undefined;
    expect(cycle(k.cfg).ok).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r22-1-b"]);
  }, 60_000);

  test("an actual removal conflict: no push, the rebase undone, refused each round, Cain told once; after a reset of the copy pushes resume", () => {
    const kid = "tap-0000002f2203";
    const { k } = keeperWithKey(kid, "cain-r22-1-c", "his first answer");
    pushOff(k);
    cycle(k.cfg);
    // A later commit on the same note, so taking the first out conflicts.
    k.cain({ id: "cain-r22-1-later", ops: [{ op: "note", item: "P11", text: "a later note on the same item" }] });
    cycle(k.cfg);
    tomb(k, kid, "cain-r22-1-c");
    k.cfg.beforePush = undefined;
    const tip = remoteTipOf(k);
    expect(cycle(k.cfg).ok).toBe(false);
    expect(remoteTipOf(k)).toBe(tip);
    expect(existsSync(join(k.cfg.dir, ".git", "rebase-merge")) || existsSync(join(k.cfg.dir, ".git", "rebase-apply"))).toBe(false);
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "conflict" });
    expect(cycle(k.cfg).ok).toBe(false);                               // retried each round, still refused
    expect(keeperStatus(k).push_refused.tries).toBeGreaterThanOrEqual(2);
    const told = k.relayed().split(" / ").filter((l) => l.includes("can't be taken out cleanly"));
    expect(told).toHaveLength(1);
    expect(told[0]).not.toMatch(/\b[0-9a-f]{40}\b|cse_/);
    // The copy reset to GitHub's (the dropped request has left the queue): later landings resume.
    dropQueued(k, "cain-r22-1-c");
    g(k, "fetch", "--quiet", "origin", "main");
    g(k, "reset", "--quiet", "--hard", "origin/main");
    expect(round(k, "cain-r22-1-after").ok).toBe(true);
    expect(remoteHas(k, "a round cain-r22-1-after")).toBe(true);
    expect(remoteHas(k, "his first answer")).toBe(false);
    expect(keeperStatus(k).push_refused).toBeUndefined();
  }, 90_000);

  test("the link lists a refused push and an alarm under unresolved landings, in plain words for him", () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
    const at = new Date(r.t.now).toISOString();
    r.keeperVerified({ push_refused: { kind: "conflict", why: "an unpushed commit carries dropped request cain-x (tap key tap-000000000001)", since: at, tries: 2, told: true },
      push_alarms: [{ tap: "tap-000000000002", id: "cain-y", at, why: "a push carried the commit of request cain-y (tap key tap-000000000002), which was dropped as not landed" }] });
    const c = r.link.clockReport() as any;
    expect(c.unresolved_landings.map((u: any) => u.what)).toEqual(["record push refused", "record push alarm"]);
    expect(c.unresolved_pushes).toHaveLength(2);
    expect(plainPush("an unpushed commit carries dropped request cain-x (tap key tap-000000000001) and couldn't be taken out (a conflict: x)", false)).toBe("a change that was withdrawn is held back from GitHub until the box can take it out");
    void PR;
  });
});

const MAIN = JSON.stringify(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"));
const APPLOG = JSON.stringify(join(import.meta.dir, "../rootfs/opt/cain/applog.ts"));
// A child process that waits for the flag "go", then runs dropUnlanded (lock wait long), writing its answer to "out".
const dropper = (k: K, dir: string, tap: string, id: string) => {
  const script = join(dir, "dropper.ts");
  const cfg = JSON.stringify({ ...k.cfg, now: undefined, clockSynced: undefined, beforePush: undefined, gitHook: undefined });
  writeFileSync(script, `import { dropUnlanded } from ${MAIN};\nimport { lockWait } from ${APPLOG};\nimport { existsSync, writeFileSync } from "node:fs";\n`
    + `const dir = ${JSON.stringify(dir)};\nwhile (!existsSync(dir + "/go")) await Bun.sleep(10);\nlockWait.ms = 30000;\nwriteFileSync(dir + "/trying", "1");\n`
    + `const r = dropUnlanded(${cfg}, ${JSON.stringify(tap)}, ${JSON.stringify(id)}, "the test's drop", "2026-11-17T00:00:00.000Z");\nwriteFileSync(dir + "/out", r);\n`);
  return new Promise<number>((ok) => spawn("bun", [script], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
};
const spin = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* blocked */ } };

describe("2. the drop and the push are serialised, and a pushed tombstone raises an alarm (invariants: the consumed-key log, the record trailers)", () => {
  test("a drop while a push is blocked mid-flight waits for the push, then finds the commit landed: no tombstone, no alarm", async () => {
    const kid = "tap-0000002f2211";
    const { k } = keeperWithKey(kid, "cain-r22-2-a");
    pushOff(k);
    cycle(k.cfg);
    k.cfg.beforePush = undefined;
    const dir = mkdtempSync(join(tmpdir(), "r22-drop-"));
    const child = dropper(k, dir, kid, "cain-r22-2-a");
    let blocked = false;
    k.cfg.gitHook = (a) => {
      if (a[0] !== "push" || blocked) return;
      blocked = true;
      writeFileSync(join(dir, "go"), "1");                            // the push is in flight: the child tries its drop now
      const t = Date.now();
      while (!existsSync(join(dir, "trying")) && Date.now() - t < 15_000) spin(10);
      spin(700);                                                       // the child is blocked on the flock meanwhile
      expect(existsSync(join(dir, "out"))).toBe(false);
    };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(blocked).toBe(true);
    expect(await child).toBe(0);
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("landed");
    const recs = readLog<any>(tapsLogFile(k.cfg)).records;
    expect(recs.some((x) => x.t === "dropped" && x.tap === kid && x.unlanded === true)).toBe(false);
    expect(recs.some((x) => x.t === "landed" && x.tap === kid)).toBe(true);
    expect(remoteRequests(k, kid)).toEqual(["cain-r22-2-a"]);
    expect(keeperStatus(k).push_alarms).toBeUndefined();
  }, 60_000);

  test("a tombstone written behind the lock's back during a push: the pushed range is checked and an alarm goes to Cain, listed", () => {
    const kid = "tap-0000002f2212";
    const { k } = keeperWithKey(kid, "cain-r22-2-b");
    pushOff(k);
    cycle(k.cfg);
    k.cfg.beforePush = undefined;
    k.cfg.gitHook = (a) => { if (a[0] === "push") { k.cfg.gitHook = undefined; appendFileSync(tapsLogFile(k.cfg), frame({ t: "dropped", tap: kid, id: "cain-r22-2-b", unlanded: true, why: "behind the lock", at: "x" })); } };
    cycle(k.cfg);
    expect(keeperStatus(k).push_alarms).toEqual([expect.objectContaining({ tap: kid, id: "cain-r22-2-b" })]);
    const alarm = k.relayed().split(" / ").filter((l) => l.startsWith("Push alarm:"));
    expect(alarm).toHaveLength(1);
    cycle(k.cfg);
    expect(k.relayed().split(" / ").filter((l) => l.startsWith("Push alarm:"))).toHaveLength(1);   // told once
    expect(pushAlarmLine({ tap: kid, id: "x", at: "y", why: "w" })).not.toMatch(/\b[0-9a-f]{40}\b/);
  }, 60_000);

  test("a drop that can't get the lock writes nothing and drops nothing; it is done once the lock is free", () => {
    const kid = "tap-0000002f2213";
    const { k } = keeperWithKey(kid, "cain-r22-2-c");
    pushOff(k);
    cycle(k.cfg);
    lockWait.ms = 50;
    const before = readFileSync(tapsLogFile(k.cfg), "utf8");
    let err: unknown = null;
    withLogLock(tapsLogFile(k.cfg), () => { try { dropUnlanded(k.cfg, kid, "cain-r22-2-c", "w", "x"); } catch (e) { err = e; } });
    expect(err).toBeInstanceOf(LockTimeout);
    expect(readFileSync(tapsLogFile(k.cfg), "utf8")).toBe(before);
    expect(dropUnlanded(k.cfg, kid, "cain-r22-2-c", "w", "x")).toBe("dropped");
    expect(abandonCommits(k.cfg).abandoned).toHaveLength(0);           // taken out by the drop itself
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 60_000);
});

describe("3. the reviver keeps a waiting notice's request id and episode (invariants: the keeper status, the consumed-key log)", () => {
  test("stuck past the threshold for more rounds, across state reloads and an old-shape migration: one relay per episode", () => {
    const kid = "tap-0000002f2221";
    const { k, card } = keeperWithKey(kid, "cain-r22-3-a");
    const f = tapsLogFile(k.cfg);
    const block = () => { rmSync(`${f}.flock`, { force: true, recursive: true }); mkdirSync(`${f}.flock`); };
    const unblock = () => rmSync(`${f}.flock`, { recursive: true, force: true });
    const told = () => k.relayed().split(" / ").filter((l) => l.includes(`couldn't resolve whether 1 tap request(s) were acted on (tap key ${kid})`)).length;
    const waiting = () => (keeperStatus(k).tap_notices ?? []).filter((x: any) => x.why === "waiting" && x.tap === kid);
    appendLog(f, { t: "consuming", tap: kid, id: "cain-r22-3-a", at: "2026-11-11T13:00:00.000Z" });
    block();
    for (let n = 0; n < INTENT_STUCK_ROUNDS + 3; n++) cycle(k.cfg);   // each round loads the state the last one saved
    expect(told()).toBe(1);
    expect(waiting()).toEqual([expect.objectContaining({ id: "cain-r22-3-a", ep: 1, msg: card })]);
    expect(keeperState(k).tapNotices.find((x: any) => x.why === "waiting")).toMatchObject({ id: "cain-r22-3-a", ep: 1 });
    // An old-shape notice (as the reviver before this round saved it): migrated once, not told again.
    const st = keeperState(k);
    st.tapNotices = st.tapNotices.map((x: any) => (x.why === "waiting" ? { tap: x.tap, why: x.why, reason: x.reason, msg: x.msg, at: x.at } : x));
    delete st.noticeShape;
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    for (let n = 0; n < 3; n++) cycle(k.cfg);
    expect(told()).toBe(1);
    expect(waiting()).toEqual([expect.objectContaining({ id: "cain-r22-3-a", ep: 1 })]);
    unblock();
    cycle(k.cfg);
    expect(openIntents(k.cfg).size).toBe(0);
    expect(waiting()).toEqual([]);
    // A later episode on the same key: told once more, however many rounds it stays stuck.
    appendLog(f, { t: "consuming", tap: kid, id: "cain-r22-3-b", at: "2026-11-11T14:00:00.000Z" });
    block();
    for (let n = 0; n < INTENT_STUCK_ROUNDS + 3; n++) cycle(k.cfg);
    expect(told()).toBe(2);
    expect(waiting()).toEqual([expect.objectContaining({ id: "cain-r22-3-b", ep: 2 })]);
    unblock();
  }, 120_000);
});

const holdLock = async (file: string, ms: number) => {
  const dir = mkdtempSync(join(tmpdir(), "r22-holder-")), script = join(dir, "holder.ts"), flag = join(dir, "in");
  writeFileSync(script, `import { withLogLock } from ${APPLOG};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < Number(process.argv[4])) {} });\n`);
  const done = new Promise<number>((ok) => spawn("bun", [script, file, flag, String(ms)], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
  for (let i = 0; i < 500 && !existsSync(flag); i++) await new Promise((ok) => setTimeout(ok, 10));
  expect(existsSync(flag)).toBe(true);
  return { done };
};
const SRC = (f: string) => readFileSync(join(import.meta.dir, "../rootfs/opt/cain", f), "utf8");

describe("4. every lock caller is listed, and each holds on a timeout (invariants: every append-only log)", () => {
  test("every call site of appendLog, appendLogHeld, appendInstall and withLogLock matches a listed caller, and every listed site is in the source", () => {
    const files = ["record/main.ts", "link/core.ts", "link/landings.ts", "installflag.ts", "link/main.ts"];
    const sites = Object.entries(LOCK_SITES).flatMap(([k, by]) => Object.entries(by).flatMap(([f, frags]) => frags.map((s) => ({ k, f, s }))));
    expect(Object.keys(LOCK_SITES).sort()).toEqual(Object.keys(LOCK_CALLERS).sort());
    for (const x of sites) expect(SRC(x.f).includes(x.s) ? x.s : `not in ${x.f}: ${x.s}`).toBe(x.s);
    for (const f of files) {
      const lines = SRC(f).split("\n").filter((l) => /\b(appendLog|appendLogHeld|appendInstall|withLogLock)\(/.test(l) && !/^\s*(import|export function|function|\/\/)/.test(l));
      for (const l of lines) expect(sites.some((x) => x.f === f && l.includes(x.s)) ? "listed" : `unlisted in ${f}: ${l.trim().slice(0, 140)}`).toBe("listed");
    }
    // The repair-on-read callers: every readLog with repair true or try is listed too.
    for (const f of files) for (const l of SRC(f).split("\n").filter((l) => /readLog\([^)]*repair: (true|"try"|f === )/.test(l)))
      expect(sites.some((x) => x.f === f && l.includes(x.s)) ? "listed" : `unlisted repair in ${f}: ${l.trim().slice(0, 140)}`).toBe("listed");
  });

  test("the keeper's mirror of the issued-key log locked past the timeout: the round goes on, nothing is mirrored, then it is once", async () => {
    const k = keeperRig();
    expect(round(k, "cain-r22-4-a").ok).toBe(true);
    const at = k.cfg.now!().getTime();
    appendLog(linkLog(k), { t: "key", kid: "tap-0000002f2241", item: "P11", kind: "ask", label: "Filed", msg: sf(at), target: { item: "P11", writes: ["decision"] }, at, exp: at + DAY, life: DAY });
    lockWait.ms = 100;
    const mirrored = () => readLog<any>(issuedMirrorFile(k.cfg), { repair: false }).records.filter((x) => x.kid === "tap-0000002f2241").length;
    const h = (await holdLock(issuedMirrorFile(k.cfg), 2500)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(mirrored()).toBe(0);
    expect(await h).toBe(0);
    cycle(k.cfg); cycle(k.cfg);
    expect(mirrored()).toBe(1);
  }, 60_000);

  test("the consumed-key log locked past the timeout at the landing check and the push: no landed mark, no push, nothing lost; then once", async () => {
    const kid = "tap-0000002f2242";
    const { k } = keeperWithKey(kid, "cain-r22-4-b");
    pushOff(k);
    cycle(k.cfg);
    k.cfg.beforePush = undefined;
    lockWait.ms = 100;
    const tip = remoteTipOf(k);
    const h = (await holdLock(tapsLogFile(k.cfg), 3000)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(remoteTipOf(k)).toBe(tip);                                  // the push guard couldn't lock: nothing pushed
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "lock" });
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "landed")).toHaveLength(0);
    expect(await h).toBe(0);
    expect(cycle(k.cfg).ok).toBe(true);
    cycle(k.cfg);
    expect(remoteRequests(k, kid)).toEqual(["cain-r22-4-b"]);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "landed" && x.tap === kid)).toHaveLength(1);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === undefined && x.tap === kid)).toHaveLength(1);
    expect(keeperStatus(k).push_refused).toBeUndefined();
  }, 60_000);

  test("the install log locked past the timeout: appendInstall throws a LockTimeout with nothing written; then it writes once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r22-install-")), f = join(dir, "record-install.log");
    appendInstall(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    lockWait.ms = 100;
    const h = (await holdLock(f, 1500)).done;
    expect(() => appendInstall(f, { t: "flag", how: "on", by: "link", at: "y" })).toThrow(LockTimeout);
    expect(readLog<any>(f).records).toHaveLength(1);
    expect(await h).toBe(0);
    appendInstall(f, { t: "flag", how: "on", by: "link", at: "y" });
    expect(readLog<any>(f).records).toHaveLength(2);
  }, 30_000);

  test("the link's issued-key log locked past the timeout at an ask: no key is logged and no card is tappable; then a new ask works", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
    r.keeperVerified();
    lockWait.ms = 100;
    const h = (await holdLock(r.issuedLog!, 2500)).done;
    const out = await (r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: "the county portal, read at 8 (r22-4)" }) as Promise<any>).catch((e) => ({ refused: String(e) }));
    if (out.refused) expect(out.refused).toContain("couldn't be written to the link's issued-key log");
    const keys = () => readLog<any>(r.issuedLog!, { repair: false }).records.filter((x) => x.t === "key");
    expect(keys()).toHaveLength(0);
    if (out.message) expect(r.buttons(out.message)).toEqual([]);
    expect(await h).toBe(0);
    const again = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: "the county portal, read at 8 (r22-4b)" }) as any;
    expect(r.buttons(again.message)).toEqual(["Filed", "Not filed"]);
    expect(keys().length).toBeGreaterThan(0);
  }, 30_000);

  test("the table and LOCK_CALLERS list the issued-key log, the strip queue, the expired index, the mirror, the install log and the push guard", () => {
    const doc = flat(INVARIANTS);
    for (const k of ["issued-key log: key", "strip queue", "expired-key index", "keeper's mirror", "install log", "the push guard"]) {
      expect(Object.keys(LOCK_CALLERS).some((x) => x.includes(k))).toBe(true);
    }
    holds(doc, "LOCK_SITES");
    for (const p of ["issued-key log's key record", "the expired-key index and the strip queue", "mirror and the install log", "the push guard"]) holds(doc, p);
  });
});

describe("5. the landing window's first sighting and round count live in the keeper state, per boot (invariants: the consumed-key log, the keeper state)", () => {
  const setup = (kid: string, id: string) => {
    const { k } = keeperWithKey(kid, id);
    let mono = 1_000, boot = "boot-a";
    k.cfg.mono = () => mono;
    k.cfg.bootId = () => boot;
    pushOff(k);
    cycle(k.cfg);
    k.cfg.beforePush = undefined;
    g(k, "branch", "-f", "late", "HEAD");
    g(k, "fetch", "--quiet", "origin", "main");
    g(k, "reset", "--quiet", "--hard", "origin/main");
    dropQueued(k, id);
    return { k, step: (ms: number) => { mono += ms; }, reboot: (b: string, m: number) => { boot = b; mono = m; } };
  };
  test("restarted every 40 minutes across the window: dropped once the window and the rounds have passed", () => {
    const kid = "tap-0000002f2251";
    const { k, step } = setup(kid, "cain-r22-5-a");
    const restarts = Math.ceil(LANDED_WINDOW_MS / (40 * MIN)) + LANDED_MIN_ROUNDS + 2;
    for (let n = 0; n < restarts && readConsumed(k.cfg).has(kid); n++) {
      // A restart of the keeper: a new process (nothing in memory), the box's monotonic time going on.
      step(40 * MIN);
      expect(round(k, `cain-r22-5-a${n}`).ok).toBe(true);
    }
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(keeperState(k).landWatch).toBeUndefined();                  // gone with the record it watched
  }, 120_000);

  test("the watch is kept in the state with its boot id; a new boot starts it again", () => {
    const kid = "tap-0000002f2252";
    const { k, step, reboot } = setup(kid, "cain-r22-5-b");
    expect(round(k, "cain-r22-5-b0").ok).toBe(true);
    const w = Object.values(keeperState(k).landWatch ?? {}) as any[];
    expect(w).toEqual([expect.objectContaining({ tap: kid, id: "cain-r22-5-b", since: 1_000, boot: "boot-a" })]);
    step(LANDED_WINDOW_MS - 10 * MIN);
    for (let n = 1; n <= LANDED_MIN_ROUNDS; n++) expect(round(k, `cain-r22-5-b${n}`).ok).toBe(true);
    reboot("boot-b", 50);                                              // a reboot: the box's monotonic clock starts over
    step(20 * MIN);
    expect(round(k, "cain-r22-5-b9").ok).toBe(true);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r22-5-b");        // never shorter: the window starts again on a new boot
    expect((Object.values(keeperState(k).landWatch) as any[])[0]).toMatchObject({ boot: "boot-b", rounds: 1 });
  }, 120_000);
});

describe("7. the start probe needs errno and passes a contention self-test (invariants: every append-only log)", () => {
  test("on this box: errno resolves, and a child holding the probe lock makes the probe's try answer would-block", () => {
    expect(probeLock(mkdtempSync(join(tmpdir(), "r22-probe-")))).toBeNull();
  }, 20_000);

  test("libc loads but no errno symbol resolves: the probe refuses with that reason", () => {
    lockTest.errnoSyms = ["no_such_errno_symbol"];
    resetFlockForTest();
    const why = probeLock(mkdtempSync(join(tmpdir(), "r22-probe-")))!;
    expect(why).toContain("errno couldn't be resolved");
    expect(why).toContain("no_such_errno_symbol");
    expect(lockRefusal("link", why)).toContain("can't lock its logs on this box");
  });

  test("a flock that never contends (the self-test takes a lock another process holds): the probe refuses", () => {
    lockTest.call = () => [0, 0];
    expect(probeLock(mkdtempSync(join(tmpdir(), "r22-probe-")))).toContain("doesn't exclude other writers");
  }, 20_000);
});

describe("8. the start gate is an imported module (invariants: every append-only log)", () => {
  test("refuses, tells once, probes again each hour, and starts once the probe passes", async () => {
    const lines: string[] = [], told: string[] = [], slept: number[] = [];
    let n = 0;
    const r = await lockGate({ probe: () => (++n < 4 ? "flock couldn't be loaded from libc" : null), log: (l) => lines.push(l), tell: (w) => { told.push(w); }, sleep: async (ms) => { slept.push(ms); } });
    expect(r).toEqual({ refused: true, tries: 4 });
    expect(told).toEqual(["flock couldn't be loaded from libc"]);
    expect(slept).toEqual([LOCK_RETRY_MS, LOCK_RETRY_MS, LOCK_RETRY_MS]);
    expect(lines.filter((l) => l.startsWith("REFUSED TO START"))).toHaveLength(3);
    expect(lines.at(-1)).toBe("its logs can be locked now; starting");
  });
  test("a probe that passes starts at once, telling nothing; a failing tell doesn't stop the gate", async () => {
    expect(await lockGate({ probe: () => null, log: () => {}, tell: () => { throw new Error("no"); }, sleep: async () => {} })).toEqual({ refused: false, tries: 1 });
    let n = 0;
    expect(await lockGate({ probe: () => (++n < 2 ? "x" : null), log: () => {}, tell: () => { throw new Error("Discord down"); }, sleep: async () => {} })).toEqual({ refused: true, tries: 2 });
  });
  test("both entry files go through it", () => {
    expect(SRC("link/main.ts")).toContain("await lockGate({");
    expect(SRC("record/main.ts")).toContain("await lockGate({");
    const doc = flat("../DOCS.md");
    holds(doc, "user-mode emulation");
    holds(doc, "the real arm64 gate");
    holds(flat(INVARIANTS), "the real arm64 gate");
  });
});

describe("9. the per-round torn check is a try-lock (invariants: every append-only log)", () => {
  test("a writer holding the consumed-key lock: the round doesn't wait for it and skips the repair to the next round", async () => {
    const k = keeperRig();
    expect(cycle(k.cfg).ok).toBe(true);
    const f = tapsLogFile(k.cfg);
    writeLogForTest(f, [{ tap: "tap-000000000001", id: "a", at: "x" }, { t: "landed", tap: "tap-000000000001", id: "a", at: "x" }], '9:00000000:{"x"');
    const torn = readFileSync(f, "utf8");
    const h = (await holdLock(f, 4000)).done;
    const lines: string[] = [];
    console.log = (...a: any[]) => { lines.push(a.join(" ")); };
    const t0 = performance.now();
    cycle(k.cfg);                                                       // nothing to push: only the torn check touches the lock
    const took = performance.now() - t0;
    console.log = realLog;
    expect(took).toBeLessThan(3000);
    expect(readFileSync(f, "utf8")).toBe(torn);                        // not repaired under a writer
    expect(lines.some((l) => l.includes("torn check is skipped to the next round"))).toBe(true);
    expect(await h).toBe(0);
    cycle(k.cfg);
    expect(readFileSync(f, "utf8")).not.toBe(torn);                    // repaired the next round
  }, 60_000);
});

describe("10. wall-clock housekeeping is tracked in the table (invariants: the wall-clock housekeeping)", () => {
  test("notice pruning, landing prune, unresolved reminders and the push alarms' listing are named with what each decides", () => {
    const doc = flat(INVARIANTS).toLowerCase();
    for (const p of ["notice pruning", "landing prune", "unresolved reminders", "push alarms' listing", "decides only"]) holds(doc, p);
  });
});

describe("6 and 11. a refused push is told without ids, and the docs say what round 22 changed", () => {
  test("nothing the owner sees carries a job id or a sha, or asks him to send or tap again", () => {
    const lines = [plainPush("an unpushed commit carries dropped request cain-x (tap key tap-000000000001)", false), plainPush("the consumed-key log couldn't be locked for the push (x)", false), lockRefusal("link", "flock loaded from libc, but errno couldn't be resolved (tried __errno_location, __error)"), TAP_REPLAY_WAITING];
    for (const line of lines) {
      expect(line).not.toMatch(/\b[0-9a-f]{7,40}\b|tap-|cse_|session/i);
      expect(line).not.toMatch(/tap again|send .* again|answer again/i);
    }
    for (const r of [pushRefusedLine({ kind: "conflict", why: "w", since: "s", tries: 1 }), pushRefusedLine({ kind: "git", why: "w", since: "s", tries: 1 })]) expect(r).not.toMatch(/\b[0-9a-f]{40}\b|cse_/);
  });
  test("DOCS.md, Cain's rules, keeper.sh and the CHANGELOG name the round-22 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    holds(docs, "Round 22");
    holds(rules, "holding back its pushes");
    holds(rules, "Push alarm");
    holds(flat("../rootfs/opt/cain/keeper.sh"), "Round 22");
    holds(flat("../CHANGELOG.md"), "never pushed after it was withdrawn");
    holds(flat(INVARIANTS), "source-check-round22.test.ts");
  });
});

void dirname; void PR;
