// Source checks, twenty-fifth review round (0.12.0): defects in the twenty-fourth round's own additions, fixed. The
// consumed-key log's created flag is monotonic, written before the log's first append, and a lost log is "lost, rebuilding"
// (every push refused) until the rebuild has rewritten it; a failed tap-key extraction is its own error and never supports
// "not landed"; the drop phase stops at its first network failure; the network wrapper refuses without the session tool;
// the lock lint is a TypeScript-compiler AST check; the guarded push runs under one deadline below the consumed-key log's
// wait; a hiccup round holds tap-derived requests; the trust folder's override is honoured only under the test root; a
// reset-copy writes its settled intents and tombstones before its discard and is used up only after it; the link's entry
// file is launched as a non-root user.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendLog, LOCK_SITES, lockTest, lockWait, LOCK_WAIT_MS, readLog, resetFlockForTest } from "../rootfs/opt/cain/applog.ts";
import { abandonCommits, consumedWait, cycle, fetchedThisRound, GUARD_WHY, LAND_SKIP_WHY, lockedBound, NET_SESSION_WHY, netRun, netTest, openIntents, pushedTombstoned, rangeTapKeys,
  readConsumed, RESET_COPY_DROP_WHY, RESET_COPY_WHY, TapKeysError, TAPS_LOG_REBUILDING, tapsLogFile, unlandedConsumes } from "../rootfs/opt/cain/record/main.ts";
import { TRUST_DIR_WHY, trustDirFrom } from "../rootfs/opt/cain/stop.ts";
import { DAY, MIN } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => {
  console.log = realLog; lockTest.names = null; lockTest.call = null; lockTest.errnoSyms = null; lockTest.helper = null; lockWait.ms = LOCK_WAIT_MS;
  netTest.setsid = null; resetFlockForTest();
});
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
const holds = (doc: string, phrase: string) => expect(doc.includes(phrase) ? phrase : `missing: ${phrase}`).toBe(phrase);
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
const ROOT = join(import.meta.dir, "../rootfs/opt/cain");
const MAIN_TS = "record/main.ts";

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
const queuedHas = (k: K, id: string) => readdirSync(k.cfg.queue).some((n) => readFileSync(join(k.cfg.queue, n), "utf8").includes(`"${id}"`));
const remoteRequests = (k: K, kid: string) => {
  const p = Bun.spawnSync(["git", "log", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)", "main"], { cwd: k.remote });
  return p.stdout.toString().split("\x1e").map((l) => l.split("\x1f").map((x) => x.trim())).filter(([t]) => t === kid).map(([, id]) => id);
};
const tomb = (k: K, tap: string, id: string) => appendLog(tapsLogFile(k.cfg), { t: "dropped", tap, id, unlanded: true, why: "test", at: "x" });
const pushOff = (k: K) => { k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); }; };
const quiet = () => { const lines: string[] = []; console.log = (...a: any[]) => { lines.push(a.join(" ")); }; return lines; };
const forceFile = (k: K) => join(dirname(k.cfg.queue), "record-force-conflict");
const recordSh = (k: K, ...a: string[]) => Bun.spawnSync(["bash", join(ROOT, "record.sh"), ...a], { env: { ...process.env, RECORD_FORCE_CONFLICT: forceFile(k), RECORD_HOLDS: k.cfg.holds! }, stdout: "pipe", stderr: "pipe" });
const clean = (text: string) => {
  const t = text.replace(/\btap-[0-9a-f]{12}\b/g, "");
  expect(t).not.toMatch(/[0-9a-f]{7,}/i);
  expect(t).not.toMatch(/refs\/|origin\/|\.git\b|HEAD|\b[\w.-]+\/[\w.-]+\.\w+/);
};
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });

describe("1. the consumed-key log's created flag is monotonic and written before its first append (invariants: the consumed-key log, the keeper state)", () => {
  test("a lost log, then the rebuild during a fetch hiccup, then a push attempt: refused, the flag kept, the log marked lost and rebuilding; once GitHub answers the rebuild rewrites it", () => {
    const { k } = keeperWithKey("tap-0000003f2511", "cain-r25-1-a");
    pushOff(k); cycle(k.cfg);                                          // consumed, its commit local only
    k.cfg.beforePush = undefined;
    tomb(k, "tap-00000099cccc", "cain-some-other-request");           // a withdrawn change's tombstone
    cycle(k.cfg);
    expect(keeperState(k).tapsLogBorn).toBe(true);
    rmSync(tapsLogFile(k.cfg));                                        // the log is lost
    k.cfg.gitHook = (a) => { if (a[0] === "fetch") throw new Error("fatal: unable to access the remote (injected)"); };
    quiet();
    cycle(k.cfg);                                                      // the detected loss, the rebuild waiting on GitHub
    console.log = realLog;
    expect(existsSync(tapsLogFile(k.cfg))).toBe(false);
    expect(keeperState(k).tapsLogBorn).toBe(true);                     // never cleared
    expect(keeperState(k).tapsLogRebuild).toMatchObject({ why: TAPS_LOG_REBUILDING });
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log", refused: GUARD_WHY.log });   // the push is refused
    expect(pushedTombstoned(k.cfg, null, "x").incomplete).toBeDefined();
    // GitHub answers: the rebuild rewrites the log from the history, fsynced, and the mark is cleared.
    k.cfg.gitHook = undefined;
    cycle(k.cfg);
    expect(existsSync(tapsLogFile(k.cfg))).toBe(true);
    expect(keeperState(k).tapsLogRebuild).toBeUndefined();
    expect(keeperState(k).tapsLogBorn).toBe(true);
    expect(abandonCommits(k.cfg).refused).toBeUndefined();
  }, 90_000);

  test("a crash between the log's first append and the round's state write: the flag was already on disk, so the lost log is never read as clean", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-1-b0").ok).toBe(true);
    // A keeper whose consumed-key log never existed (as on a box from before the flag): no file, no flag, no count.
    rmSync(tapsLogFile(k.cfg), { force: true });
    const st = keeperState(k);
    delete st.tapsLogBorn; st.logHigh = { ...(st.logHigh ?? {}), consumed: 0 };
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    expect(pushedTombstoned(k.cfg, null, "x")).toEqual({ alarms: [] });
    addTap(k, "tap-0000003f2512", "cain-r25-1-b");
    let seen: { born: unknown; log: boolean } | null = null;
    k.cfg.crashPoint = (w) => {
      if (w !== "taps-append" || seen) return;
      seen = { born: keeperState(k).tapsLogBorn, log: existsSync(tapsLogFile(k.cfg)) };
      throw new Error("crash point: after the first append");
    };
    quiet();
    try { cycle(k.cfg); } catch { /* the crash */ }
    console.log = realLog;
    k.cfg.crashPoint = undefined;
    expect(seen).toEqual({ born: true, log: true });
    rmSync(tapsLogFile(k.cfg));
    expect(pushedTombstoned(k.cfg, null, "x").incomplete).toBeDefined();
    expect(abandonCommits(k.cfg)).toMatchObject({ kind: "log" });
  }, 60_000);

  test("no keeper state counts as a first start only with independent proof: a readable copy whose history carries no tap key", () => {
    const d = mkdtempSync(join(tmpdir(), "r25-pristine-"));
    const cfg: any = { queue: join(d, "queue"), holds: join(d, "holds.json"), tapsLog: join(d, "taps.jsonl"), dir: join(d, "record"), branch: "main" };
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();          // no copy: no proof
    const sh = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: cfg.dir });
    // Round 27: the proof needs a whole copy with every remote ref fetched this round: a clone of a remote, marked fetched.
    const seed = join(d, "seed");
    mkdirSync(seed, { recursive: true });
    const at = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    at(seed, "init", "--quiet", "-b", "main"); at(seed, "commit", "--quiet", "--allow-empty", "-m", "first");
    at(d, "clone", "--quiet", seed, cfg.dir);
    fetchedThisRound(cfg, true);
    expect(pushedTombstoned(cfg, null, "x")).toEqual({ alarms: [] });            // a copy with no tap key ever
    sh("commit", "--quiet", "--allow-empty", "-m", "a tap\n\nTap-Key: tap-0000003f2513\nTap-Request: cain-r25-1-c");
    expect(pushedTombstoned(cfg, null, "x").incomplete).toBeDefined();          // a consumed record must have existed
  });
});

describe("2. a failed tap-key extraction never supports 'not landed' (invariants: the consumed-key log, the keeper status)", () => {
  const unknownSetup = (kid: string, id: string) => {
    const { k } = keeperWithKey(kid, id);
    k.cfg.pushTimeoutMs = 1000;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");
    return k;
  };
  test("the extraction is its own error, never an empty list", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-2-0").ok).toBe(true);
    expect(() => rangeTapKeys(k.cfg, "e".repeat(40), "HEAD")).toThrow(TapKeysError);
  }, 30_000);

  test("the extraction fails on a push of unknown outcome: with its head gone the fallback keeps it unresolved and counts a try", () => {
    const kid = "tap-0000003f2521";
    const k = unknownSetup(kid, "cain-r25-2-a");
    // The extraction fails, and GitHub can't be read after the push either, so the outcome stays unknown.
    let pushed = false;
    k.cfg.beforePush = () => { pushed = true; };
    k.cfg.gitHook = (a) => {
      if (a[0] === "log" && a[1] === "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)") throw new Error("git log: injected failure");
      if (pushed && a[0] === "fetch") throw new Error("fatal: unable to access the remote (injected)");
    };
    quiet();
    expect(cycle(k.cfg).ok).toBe(false);                               // the push timed out: an unknown outcome
    console.log = realLog;
    k.cfg.gitHook = undefined;
    g(k, "config", "--unset", "remote.origin.receivepack");
    const st = keeperState(k);
    expect(st.pushUnknown).toBeDefined();
    expect(st.pushUnknown.keysOk).toBeUndefined();
    st.pushUnknown.head = "e".repeat(40);                              // its head pruned from the copy
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    pushOff(k);
    cycle(k.cfg);
    expect(keeperState(k).pushUnknown).toMatchObject({ fails: 1 });     // unresolved: no evidence it didn't land
    expect(keeperStatus(k).push_unknown).toBeDefined();
  }, 60_000);

  test("its keys present on GitHub with its head absent: unresolved", () => {
    const kid = "tap-0000003f2522";
    const { k } = keeperWithKey(kid, "cain-r25-2-b");
    expect(cycle(k.cfg).ok).toBe(true);                                // the key's commit is on GitHub
    expect(remoteRequests(k, kid)).toEqual(["cain-r25-2-b"]);
    const st = keeperState(k);
    st.pushUnknown = { at: k.cfg.now!().toISOString(), head: "e".repeat(40), before: null, keys: [kid], keysOk: true, why: "the push got no answer within its time limit and was stopped", tries: 1 };
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    cycle(k.cfg);
    expect(keeperState(k).pushUnknown).toMatchObject({ fails: 1, keys: [kid] });
  }, 60_000);

  test("an extraction that succeeded but read no keys: unresolved, never 'not landed'", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-2-c0").ok).toBe(true);
    const st = keeperState(k);
    st.pushUnknown = { at: k.cfg.now!().toISOString(), head: "e".repeat(40), before: null, keys: [], keysOk: true, why: "the push got no answer within its time limit and was stopped", tries: 1 };
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    cycle(k.cfg);
    expect(keeperState(k).pushUnknown).toMatchObject({ fails: 1 });
  }, 60_000);
});

describe("3. the drop phase stops at its first network failure (invariants: the consumed-key log, the keeper status)", () => {
  test("three records due and an upload-pack that never answers: one ceiling, all three skipped as fetch-failed, retried next round", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-3-0").ok).toBe(true);
    const taps = [["tap-0000003f2531", "cain-r25-3-a"], ["tap-0000003f2532", "cain-r25-3-b"], ["tap-0000003f2533", "cain-r25-3-c"]];
    taps.forEach(([kid, id], i) => addTap(k, kid, id, `tap ${i}`, 7 + i));
    pushOff(k); quiet(); cycle(k.cfg); console.log = realLog;
    k.cfg.beforePush = undefined;
    for (const [kid, id] of taps) { expect(readConsumed(k.cfg).get(kid)).toBe(id); dropQueued(k, id); }
    g(k, "fetch", "--quiet", "origin", "main");
    g(k, "reset", "--quiet", "--hard", "origin/main");                 // their commits are on no ref: all three due
    k.cfg.pushTimeoutMs = 1500;
    g(k, "config", "remote.origin.uploadpack", "sleep 600; true");
    quiet();
    const t = performance.now();
    const r = unlandedConsumes(k.cfg, { fetched: true, inStep: true, now: k.cfg.now!().getTime(), watch: {} });
    const took = performance.now() - t;
    console.log = realLog;
    expect(r.skipped.map((s) => s.cause)).toEqual(["fetch-failed", "fetch-failed", "fetch-failed"]);
    expect(r.skipped[0].why).toBe(LAND_SKIP_WHY["fetch-failed"]);
    expect(took).toBeLessThan(2 * 1500 + 1000);
    for (const [kid, id] of taps) expect(readConsumed(k.cfg).get(kid)).toBe(id);   // nothing dropped
  }, 60_000);
});

describe("4. the network wrapper refuses without the session tool (invariants: every append-only log)", () => {
  test("no session tool: the command never runs, the fixed reason comes back", () => {
    const d = mkdtempSync(join(tmpdir(), "r25-net-")), f = join(d, "ran");
    netTest.setsid = "";
    const r = netRun(["sh", "-c", `touch ${f}`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 5000 });
    expect(r.refused).toBe(true);
    expect(r.out).toBe(NET_SESSION_WHY);
    expect(existsSync(f)).toBe(false);
    netTest.setsid = null;
    expect(netRun(["sh", "-c", `touch ${f}`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 5000 }).refused).toBeUndefined();
    expect(existsSync(f)).toBe(true);
  });
  test("the image build fails without the session tool", () => {
    expect(flat("../Dockerfile")).toContain('test -x /usr/bin/setsid || test -x /bin/setsid || { echo "the session tool (setsid) is missing');
    expect(readFileSync(join(ROOT, MAIN_TS), "utf8")).not.toContain("sid ? [sid, ...argv] : argv");
  });
});

// Round 25's lock lint, on the TypeScript compiler's syntax tree: every reference to a lock primitive (and to readLog, the
// repairing read) is the callee of a direct, non-optional call; any other reference fails, comments never hide one; and
// every lock-taking call (a locker, or a readLog whose repair isn't the literal false) is matched by a LOCK_SITES fragment
// on its line or in its text.
const LOCKERS = new Set(["appendLog", "appendLogHeld", "appendInstall", "withLogLock"]);
const PRIMS = new Set([...LOCKERS, "readLog"]);
async function lockLintAst(file: string, src: string): Promise<{ bad: string[]; calls: { line: string; text: string; locks: boolean }[] }> {
  const ts = (await import("typescript")).default;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bad: string[] = [], calls: { line: string; text: string; locks: boolean }[] = [];
  const lines = src.split("\n");
  const where = (n: any) => `line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  // A repair that takes the lock: anything but false or "mirror" (the keeper's single-writer mirror repairs without it),
  // a conditional counting when either branch does; an options value it can't read counts as locking.
  const locking = (e: any): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isStringLiteralLike(e) && e.text === "mirror") return false;
    if (ts.isConditionalExpression(e)) return locking(e.whenTrue) || locking(e.whenFalse);
    return true;
  };
  const repairs = (call: any): boolean => {
    const o = call.arguments[1];
    if (!o) return false;
    if (!ts.isObjectLiteralExpression(o)) return true;
    const p = o.properties.find((x: any) => x.name && ts.isIdentifier(x.name) && x.name.text === "repair");
    if (!p) return o.properties.some((x: any) => ts.isSpreadAssignment(x));
    if (!ts.isPropertyAssignment(p)) return true;
    return locking(p.initializer);
  };
  const visit = (n: any) => {
    if (ts.isIdentifier(n) && PRIMS.has(n.text)) {
      const p = n.parent;
      // Declared only where it is defined: the log module, and installflag.ts's appendInstall.
      const declared = ts.isFunctionDeclaration(p) && p.name === n && (file === "applog.ts" || (file === "installflag.ts" && n.text === "appendInstall"));
      const imported = ts.isImportSpecifier(p) && !p.propertyName && p.name === n;
      const called = ts.isCallExpression(p) && p.expression === n && !p.questionDotToken;
      if (!declared && !imported && !called) bad.push(`${n.text} used other than as a direct call at ${where(n)}: ${lines[sf.getLineAndCharacterOfPosition(n.getStart()).line].trim().slice(0, 120)}`);
      if (called) {
        const locks = LOCKERS.has(n.text) || repairs(p);
        calls.push({ line: lines[sf.getLineAndCharacterOfPosition(p.getStart()).line], text: p.getText(), locks });
      }
    }
    // A property or binding named like a primitive (obj.appendLog, { appendLog: x }) is another way to reach it.
    if ((ts.isPropertyAccessExpression(n) && PRIMS.has(n.name.text)) || (ts.isBindingElement(n) && n.propertyName && ts.isIdentifier(n.propertyName) && PRIMS.has(n.propertyName.text))
      || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && PRIMS.has(n.argumentExpression.text)))
      bad.push(`a primitive reached through a property or binding at ${where(n)}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { bad, calls };
}
const sitesOf = (f: string) => Object.values(LOCK_SITES).flatMap((by) => by[f] ?? []);
async function lintFile(f: string, src: string): Promise<string[]> {
  const { bad, calls } = await lockLintAst(f, src);
  const frags = sitesOf(f);
  for (const c of calls) if (c.locks && !frags.some((s) => c.line.includes(s) || c.text.includes(s))) bad.push(`an unlisted lock-taking call in ${f}: ${c.line.trim().slice(0, 120)}`);
  return bad;
}

describe("5. the lock lint is a TypeScript-compiler AST check (invariants: every append-only log)", () => {
  test("each form the textual lint missed fails: call, apply and bind, a destructuring alias, an optional call, a call around a block comment", async () => {
    const pre = 'import { appendLog, withLogLock, readLog } from "../applog.ts";\n';
    for (const bad of ["withLogLock.call(null, f, () => 1);", "appendLog.apply(null, [f, r]);", "const put = appendLog.bind(null);", "const { appendLog: put } = mod;",
      "appendLog?.(f, r);", "readLog?.(f, { repair: true });", "appendLog /* the record */ (f, r);", "withLogLock/**/(f, () => 1);", "const r = readLog;", "export { appendLog };",
      'mod["withLogLock"](f, () => 1);', "readLog(f, { repair: true });", "readLog(f, opts);"]) {
      expect((await lintFile(MAIN_TS, pre + bad)).length).toBeGreaterThan(0);
    }
    // Permitted: a listed direct call, a generic one, a read that doesn't repair, and the imports.
    for (const ok of ["appendLog(issuedMirrorFile(cfg), r);", "readLog<any>(f, { repair: false });", "readLog(f);", "withLogLock(tapsLogFile(cfg), () => { // guardedPush\n});"])
      expect(await lintFile(MAIN_TS, pre + ok)).toEqual([]);
  });

  test("the whole source tree passes, and every lock-taking call is in the lock-site scan", async () => {
    const files = walk(ROOT).map((p) => p.slice(ROOT.length + 1));
    expect(files.length).toBeGreaterThan(20);
    const bad: string[] = [];
    let locking = 0;
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      bad.push(...(await lintFile(f, src)));
      locking += (await lockLintAst(f, src)).calls.filter((c) => c.locks).length;
    }
    expect(bad).toEqual([]);
    expect(locking).toBeGreaterThan(30);
  });
});

describe("6. the guarded push runs under one deadline below the consumed-key log's wait (invariants: the consumed-key log, the keeper status)", () => {
  test("slow checks before a push that hangs: the lock is held under the bound, logged, never as long as a writer waits", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-6-0").ok).toBe(true);
    lockWait.ms = 100;                                                  // the writers wait 1.8 seconds, the bound 1.6
    expect(lockedBound()).toBeLessThan(consumedWait());
    k.cfg.pushTimeoutMs = 5000;
    g(k, "config", "remote.origin.receivepack", "sleep 600; true");
    k.cfg.crashPoint = (w) => { if (w === "push-guard-checked") Bun.sleepSync(700); };
    const lines = quiet();
    round(k, "cain-r25-6-a");
    console.log = realLog;
    const held = lines.map((l) => /held the consumed-key log's lock for (\d+) ms/.exec(l)).filter(Boolean).map((m) => Number(m![1]));
    expect(held.length).toBeGreaterThan(0);
    for (const ms of held) expect(ms).toBeLessThan(consumedWait());
  }, 60_000);

  test("checks that leave too little of the bound: nothing pushed, refused in fixed words", () => {
    const k = keeperRig();
    expect(round(k, "cain-r25-6-b0").ok).toBe(true);
    lockWait.ms = 100;
    k.cfg.crashPoint = (w) => { if (w === "push-guard-checked") Bun.sleepSync(1400); };
    quiet();
    round(k, "cain-r25-6-b");
    console.log = realLog;
    expect(keeperStatus(k).push_refused).toMatchObject({ kind: "deadline", why: GUARD_WHY.deadline });
    clean(GUARD_WHY.deadline);
    k.cfg.crashPoint = undefined;
    lockWait.ms = LOCK_WAIT_MS;
    round(k, "cain-r25-6-b1");
    expect(keeperStatus(k).push_refused).toBeUndefined();
  }, 60_000);
});

describe("7. a hiccup round holds tap-derived requests (invariants: the consumed-key log, the source-check ledger)", () => {
  test("a round whose fetch fails: the tap's request stays queued with no intent and nothing consumed; the next round that fetches consumes it once", () => {
    const kid = "tap-0000003f2571";
    const { k } = keeperWithKey(kid, "cain-r25-7-a");
    k.cfg.gitHook = (a) => { if (a[0] === "fetch") throw new Error("fatal: unable to access the remote (injected)"); };
    quiet();
    cycle(k.cfg);
    console.log = realLog;
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(openIntents(k.cfg).has(kid)).toBe(false);
    expect(queuedHas(k, "cain-r25-7-a")).toBe(true);
    k.cfg.gitHook = undefined;
    cycle(k.cfg);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r25-7-a");
    expect(remoteRequests(k, kid)).toEqual(["cain-r25-7-a"]);
  }, 60_000);
});

describe("8. the trust folder's override is honoured only under the test root (invariants: other files under /data)", () => {
  test("unset: /data/trust; under /tmp: honoured; anywhere else, through .. or a link out of /tmp: refused with the fixed reason", () => {
    expect(trustDirFrom(undefined)).toEqual({ dir: "/data/trust", refused: null });
    const d = mkdtempSync("/tmp/r25-trust-");
    expect(trustDirFrom(join(d, "trust")).refused).toBeNull();
    expect(trustDirFrom("/data/elsewhere")).toEqual({ dir: "/data/trust", refused: TRUST_DIR_WHY });
    expect(trustDirFrom("/tmp/../etc/trust").refused).toBe(TRUST_DIR_WHY);
    expect(trustDirFrom("").refused).toBe(TRUST_DIR_WHY);
    const out = mkdtempSync(join("/var/tmp", "r25-out-"));
    symlinkSync(out, join(d, "link"));
    expect(trustDirFrom(join(d, "link", "trust")).refused).toBe(TRUST_DIR_WHY);
    clean(TRUST_DIR_WHY.replace("/data/trust", ""));
  });
});

describe("9. a reset-copy writes its settled intents and tombstones before its discard, and is used up after it (invariants: the record trailers, the consumed-key log)", () => {
  test("a crash between the written tombstones and the discard: the request kept, the commits kept; the next round discards them, uses the request up and tells the dropped tap", () => {
    const kid = "tap-0000003f2591", kid2 = "tap-0000003f2592";
    const { k } = keeperWithKey(kid, "cain-r25-9-a", "his first answer");
    pushOff(k); cycle(k.cfg);
    k.cain({ id: "cain-r25-9-later", ops: [{ op: "note", item: "P11", text: "a later note on the same item" }] });
    cycle(k.cfg);
    tomb(k, kid, "cain-r25-9-a");
    dropQueued(k, "cain-r25-9-a");
    k.cfg.beforePush = undefined;
    expect(cycle(k.cfg).ok).toBe(false);                               // the conflict hold
    addTap(k, kid2, "cain-r25-9-b", "a second answer", 9);
    cycle(k.cfg);                                                      // consumed, its commit held locally
    expect(readConsumed(k.cfg).get(kid2)).toBe("cain-r25-9-b");
    dropQueued(k, "cain-r25-9-b");                                     // its request no longer queued: tombstoned on the reset
    expect(recordSh(k, "reset-copy").exitCode).toBe(0);
    let crashed = false;
    k.cfg.crashPoint = (w) => { if (w === "reset-copy-written" && !crashed) { crashed = true; throw new Error("crash point: before the discard"); } };
    quiet();
    try { cycle(k.cfg); } catch { /* the crash */ }
    console.log = realLog;
    expect(crashed).toBe(true);
    expect(existsSync(forceFile(k))).toBe(true);                        // not used up
    expect(g(k, "rev-list", "--count", "origin/main..HEAD").stdout.toString().trim()).not.toBe("0");   // nothing discarded
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "dropped" && x.tap === kid2 && x.why === RESET_COPY_DROP_WHY)).toHaveLength(1);
    expect(openIntents(k.cfg).size).toBe(0);
    k.cfg.crashPoint = undefined;
    const lines = quiet();
    cycle(k.cfg);
    console.log = realLog;
    expect(lines.some((l) => l.includes(RESET_COPY_WHY.acted))).toBe(true);
    expect(existsSync(forceFile(k))).toBe(false);
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "dropped" && x.tap === kid2 && x.why === RESET_COPY_DROP_WHY)).toHaveLength(1);
    expect(told(k, `Tap not landed: the change from tap key ${kid2}`)).toBe(1);
    for (let n = 0; n < 3 && keeperStatus(k).push_refused; n++) cycle(k.cfg);
    expect(remoteRequests(k, kid2)).toEqual([]);
    expect(remoteRequests(k, kid)).toEqual([]);
  }, 120_000);
});

// Launches a command as a non-root user: the image runs as root, which would create any /data path the test forgot to
// move, so the entry file's launch runs as nobody (65534) whenever the tests run as root (the arm64 container, a root
// sandbox), with Bun copied where that user can run it. Already non-root (GitHub's runner): as it is.
const nonRoot = (argv: string[], d: string): string[] => {
  if (process.getuid?.() !== 0) return argv;
  const bin = mkdtempSync("/tmp/r25-bun-");
  copyFileSync(process.execPath, join(bin, "bun"));
  chmodSync(bin, 0o755); chmodSync(join(bin, "bun"), 0o755);
  chmodSync(d, 0o777);
  const run = [join(bin, "bun"), ...argv.slice(1)];
  const has = (t: string) => Bun.spawnSync(["sh", "-c", `command -v ${t}`]).exitCode === 0;
  if (has("setpriv")) return ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", ...run];
  if (has("runuser")) return ["runuser", "-u", "nobody", "--", ...run];
  return ["su", "-s", "/bin/sh", "nobody", "-c", run.map((x) => `'${x}'`).join(" ")];
};
const linkEnv = (d: string, port: string, extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: d,
  CAIN_TRUST_DIR: join(d, "trust"), CAIN_CARDS: join(d, "trust/cards.json"), CAIN_STOP_FILE: join(d, "trust/stop.json"), CAIN_SHIP_PUB: join(d, "trust/ship.pub"),
  CAIN_GATE_REPLAY: join(d, "work/gate-replay.json"), CAIN_TRANSCRIPTS: join(d, "transcripts"), CAIN_REVIEWED: join(d, "reviewed"), CAIN_GATE_LOG: join(d, "work/gate.jsonl"),
  INSTALL_RESULTS: join(d, "work/install-tests.json"), LINK_DIR: join(d, "link"), LINK_ENV: join(d, "discord.env"), LINK_EXPIRED_LOG: join(d, "link-expired.log"), LINK_HELD_LOG: join(d, "link-held.log"),
  LINK_ISSUED_LOG: join(d, "link-issued.log"), LINK_LOG: join(d, "work/link.log"), LINK_NOTICES: join(d, "work/notices.jsonl"), LINK_STRIP_LOG: join(d, "link-strip.log"),
  RECORD_DIR: join(d, "record"), RECORD_HOLDS: join(d, "holds.json"), RECORD_INSTALL_LOG: join(d, "install.log"), RECORD_ISSUED_LOG: join(d, "issued.log"), RECORD_LANDINGS: join(d, "landings"),
  RECORD_OUTCOMES: join(d, "outcomes"), RECORD_QUEUE: join(d, "queue"), RECORD_RECOVER: join(d, "recover.json"), RECORD_STATUS: join(d, "ledger.json"), RECORD_TAPS_LOG: join(d, "taps.jsonl"),
  RECORD_WAITS: join(d, "waits.jsonl"), RELAY_PORT: port, RELAY_QUEUE: join(d, "relay.queue"), SOURCE_CHECK_TUNING: join(d, "work/tuning.jsonl"), ...extra });
const launchLink = async (env: Record<string, string>, d: string, until: string) => {
  const p = Bun.spawn(nonRoot(["bun", join(ROOT, "link/main.ts")], d), { env, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const reader = (async () => { for await (const c of p.stdout as any) { out += Buffer.from(c).toString(); if (out.includes(until)) break; } })();
  await Promise.race([reader, Bun.sleep(30_000)]);
  p.kill("SIGKILL");
  return out;
};

describe("10. the link's real entry file starts as a non-root user (invariants: every append-only log)", () => {
  test("non-root: the link's entry file, launched as the image does (bun <file>) by a user that can't write /data, passes the start gate and listens", async () => {
    const d = mkdtempSync("/tmp/r25-link-");
    mkdirSync(join(d, "work"), { recursive: true });
    chmodSync(join(d, "work"), 0o777);
    // The launch's user can't be root (and so can't create /data).
    const uid = process.getuid?.() === 0 ? Bun.spawnSync(nonRoot(["bun", "-e", "console.log(process.getuid())"], d), { stdout: "pipe" }).stdout.toString().trim() : String(process.getuid?.());
    expect(uid).not.toBe("0");
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const out = await launchLink(linkEnv(d, port), d, "link listening on");
    expect(out).not.toContain("REFUSED TO START");
    expect(out).not.toContain("EACCES");
    expect(out).toContain(`link listening on ${port}`);
  }, 45_000);

  test("non-root: a trust folder moved outside the test root refuses the start with the fixed reason", async () => {
    const d = mkdtempSync("/tmp/r25-link-");
    mkdirSync(join(d, "work"), { recursive: true });
    chmodSync(join(d, "work"), 0o777);
    const port = String(20_000 + Math.floor(Math.random() * 20_000));
    const out = await launchLink(linkEnv(d, port, { CAIN_TRUST_DIR: "/var/tmp/r25-not-the-test-root" }), d, "REFUSED TO START");
    expect(out).toContain(`REFUSED TO START: ${TRUST_DIR_WHY}`);
    expect(out).not.toContain("link listening on");
  }, 45_000);
});

describe("11. the docs say what round 25 changed", () => {
  test("DOCS.md, the table, Cain's rules, keeper.sh, record.sh and the CHANGELOG name the round-25 behaviour", () => {
    const docs = flat("../DOCS.md"), table = flat(INVARIANTS);
    holds(docs, "Round 25");
    holds(table, "source-check-round25.test.ts");
    for (const p of ["Round 25", "tapsLogRebuild", "tapsLogBornFirst", "TapKeysError", "keysOk", "fetch-failed", "lockedBound", "heldMs", "TRUST_DIR_WHY", "tombstoneDiscarded",
      "only writer", "lockLintAst", "non-root"]) holds(table, p);
    holds(flat("../rootfs/opt/cain/CLAUDE.md"), "Round 25");
    holds(flat("../rootfs/opt/cain/keeper.sh"), "Round 25");
    holds(flat("../rootfs/opt/cain/record.sh"), "Round 25");
    holds(flat("../CHANGELOG.md"), "loses its list of taps");
  });
  test("nothing the owner or Cain hears from this round carries a job id or a sha, or asks him to send or tap again", () => {
    for (const line of [GUARD_WHY.deadline, LAND_SKIP_WHY["fetch-failed"], TAPS_LOG_REBUILDING, RESET_COPY_WHY.waits, RESET_COPY_DROP_WHY.replace("record.sh", "")]) {
      clean(line);
      expect(line).not.toMatch(/tap again|send .* again|answer again|cse_|session_/i);
    }
  });
});
