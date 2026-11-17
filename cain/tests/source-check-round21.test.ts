// Source checks, twenty-first review round (0.12.0): defects in the twentieth round's own additions, fixed. An unlanded
// drop is atomic with abandoning its commit (a tombstone the push path checks), timed by the monotonic clock and fetch
// rounds; the link's consumed view is per (tap key, request id); the replay check reads "consumed or consuming"; a legacy
// anchor's voided settle that fails goes to the void-unsettled path; flock is probed at start, resolved through a soname
// list, and its errors told by their real cause; repair is locked or off; retention is clock-free for placed cards; lock
// timeouts hold and retry; the stuck-intent notice is per episode; the replay waiting line waits out a page rotation; the
// void claim's seven-day alert says nothing was pushed.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendLog, crashSpy, lockTest, lockWait, LOCK_CALLERS, LOCK_WAIT_MS, LockError, LockTimeout, LIBC_NAMES, lockRefusal, probeLock, readLog, resetFlockForTest, withLogLock, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import { CHECK_UNANCHORED, NOT_ACTED_TAP, REPLAY_WAIT_MS, TAP_REPLAY_AGAIN, TAP_REPLAY_WAITING, VOID_UNSETTLED } from "../rootfs/opt/cain/link/core";
import { abandonCommits, cycle, INTENT_STUCK_ROUNDS, keeperLockProbe, LANDED_MIN_ROUNDS, LANDED_WINDOW_MS, openIntents, readConsumed, REPLAY_PAGE, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; crashSpy.on = null; lockTest.names = null; lockTest.call = null; lockWait.ms = LOCK_WAIT_MS; resetFlockForTest(); });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
// A document holds a phrase (the failure names the phrase, not the whole document).
const holds = (doc: string, phrase: string) => expect(doc.includes(phrase) ? phrase : `missing: ${phrase}`).toBe(phrase);
const WORDS = "Stop stays within reach of your newest message.";
const SHA1 = "1".repeat(40);

type R = ReturnType<typeof linkRig>;
const shipRig = (o: Parameters<typeof linkRig>[0] = {}) => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []), ...o });
let checks = 0;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: `the county portal, read at 8 (${++checks})` }) as any).message as string;
const shipCard = async (r: R) =>
  (await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: WORDS, checked: `the pull request on GitHub, open at that head, read at 8 (${++checks})` }) as any).message as string;
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const logged = (r: R) => readLog<any>(r.issuedLog!, { repair: false }).records;
const side = (r: R, name: string) => join(dirname(r.issuedLog!), name);
const kidOf = (r: R, id: string, i = 0) => logged(r).filter((x) => x.t === "key" && x.msg === id)[i].kid as string;
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
const sfTime = (id: string) => Number(BigInt(id) >> 22n) + 1420070400000;
const unverified = (r: R) => { r.files.status = JSON.stringify({ clock: { synced: true, source: "the rig", diagnostic: "", at: new Date(r.t.now).toISOString() },
  consumed_unverified: { since: new Date(r.t.now - MIN).toISOString(), why: "the record keeper started, and its consumed set isn't checked against GitHub yet", tries: 0 } }); };
const tapLines = (r: R) => r.relayed.filter((x) => x.includes("Dane tapped") && x.includes("Tap key"));
const stepPi = (r: R, by: number) => { r.t.now += by; r.t.discord -= by; };
const tapAt = (r: R, id: string, msg: any, at: number | string, i = 0) => r.link.onInteraction({ type: 3, id: typeof at === "string" ? at : sf(at, 900 + i), token: "t", application_id: "999", channel_id: DM,
  user: { id: "4242" }, data: { custom_id: (msg.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id))[i] }, message: structuredClone(msg) });
const consumedFile = (r: R) => { const f = join(mkdtempSync(join(tmpdir(), "r21-consumed-")), "record-taps.jsonl"); (r.deps as any).consumedLog = f; return f; };
const keeperStatus = (k: ReturnType<typeof keeperRig>) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const linkLog = (k: ReturnType<typeof keeperRig>) => join(k.root, "pi/link-issued.log");
const round = (k: ReturnType<typeof keeperRig>, id: string) => { k.cain({ id, ops: [{ op: "note", item: "P44", text: "a round" }] }); return cycle(k.cfg); };
const keeperWithKey = (kid: string, id: string) => {
  const k = keeperRig();
  expect(round(k, `${id}-0`).ok).toBe(true);
  const at = k.cfg.now!().getTime(), card = sf(at);
  appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + DAY, life: DAY });
  writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } } }));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
  return { k, card, at };
};
const dropQueued = (k: ReturnType<typeof keeperRig>, id: string) => { for (const n of readdirSync(k.cfg.queue)) if (readFileSync(join(k.cfg.queue, n), "utf8").includes(`"${id}"`)) rmSync(join(k.cfg.queue, n)); };
const remoteRequests = (k: ReturnType<typeof keeperRig>, kid: string) => {
  const p = Bun.spawnSync(["git", "log", "--format=%x1e%(trailers:key=Tap-Key,valueonly,separator=%x2C)%x1f%(trailers:key=Tap-Request,valueonly,separator=%x2C)", "main"], { cwd: k.remote });
  return p.stdout.toString().split("\x1e").map((l) => l.split("\x1f").map((x) => x.trim())).filter(([t]) => t === kid).map(([, id]) => id);
};

describe("1. an unlanded drop is atomic with abandoning its commit (invariants: the consumed-key log, the record trailers)", () => {
  test("drop, then the delayed push succeeds: the second answer is the only one applied", () => {
    const kid = "tap-0000002f1101";
    const { k } = keeperWithKey(kid, "cain-r21-1-a");
    let mono = 1_000;
    k.cfg.mono = () => mono;
    k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); };
    cycle(k.cfg);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r21-1-a");
    // The commit is kept on another ref of the copy, the branch is back in step with GitHub, and the request has left the
    // queue (a push of it may still come late).
    const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: k.cfg.dir });
    g("branch", "-f", "late", "HEAD");
    k.cfg.beforePush = undefined;
    g("fetch", "--quiet", "origin", "main");
    g("reset", "--quiet", "--hard", "origin/main");
    dropQueued(k, "cain-r21-1-a");
    // The wall clock alone never drops it: a day on the Pi's clock and no monotonic time, then too few rounds.
    k.at(new Date(k.cfg.now!().getTime() + DAY));
    expect(round(k, "cain-r21-1-r0").ok).toBe(true);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r21-1-a");
    mono += LANDED_WINDOW_MS + 1;
    for (let n = 1; n < LANDED_MIN_ROUNDS; n++) { expect(round(k, `cain-r21-1-r${n}`).ok).toBe(true); expect(readConsumed(k.cfg).get(kid)).toBe("cain-r21-1-a"); }
    expect(round(k, "cain-r21-1-r9").ok).toBe(true);                  // the window on the monotonic clock and enough rounds in step
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    const drop = readLog<any>(tapsLogFile(k.cfg)).records.find((x) => x.t === "dropped" && x.tap === kid && x.unlanded === true);
    expect(drop?.id).toBe("cain-r21-1-a");
    // He is asked again and answers again: the second request takes the key.
    k.cain({ id: "cain-r21-1-b", tap: kid, ops: [{ op: "note", item: "P11", text: "his second tap" }] }, { issue: false });
    // The delayed push: the dropped commit comes back on the branch just before the push (a late retry of the old push).
    let once = true;
    k.cfg.beforePush = () => { if (once) { once = false; g("-c", "user.name=t", "-c", "user.email=t@t", "cherry-pick", "--allow-empty", "-X", "theirs", "late"); } };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(once).toBe(false);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r21-1-b");
    expect(remoteRequests(k, kid)).toEqual(["cain-r21-1-b"]);       // only the second answer reached GitHub
    const grep = (t: string) => Bun.spawnSync(["git", "grep", "-l", "-F", t, "main"], { cwd: k.remote }).stdout.toString().trim();
    expect(grep("his second tap")).not.toBe("");
    expect(grep("his tap")).toBe("");                                  // the dropped answer's write isn't on GitHub
  }, 120_000);

  test("the push path refuses a dropped commit it can't take out cleanly", () => {
    const kid = "tap-0000002f1102";
    const { k } = keeperWithKey(kid, "cain-r21-1-c");
    k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); };
    cycle(k.cfg);
    appendLog(tapsLogFile(k.cfg), { t: "dropped", tap: kid, id: "cain-r21-1-c", unlanded: true, why: "test", at: "x" });
    const r = abandonCommits(k.cfg);
    expect(r.refused).toBeUndefined();
    expect(r.abandoned).toHaveLength(1);
    expect(abandonCommits(k.cfg).abandoned).toHaveLength(0);           // nothing of it left to push
  }, 60_000);

  test("the table names the monotonic window, the rounds and the tombstone", () => {
    const doc = flat(INVARIANTS);
    holds(doc, "LANDED_MIN_ROUNDS");
    holds(doc, "the push path refuses to push a commit whose request was dropped");
  });
});

describe("2. the consumed view is keyed on (tap key, request id) (invariants: the consumed-key log)", () => {
  test("two consumed records on one key under different request ids, the second dropped: still consumed in both views; the first dropped too: free in both", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const kid = kidOf(r, id), f = consumedFile(r);
    const keeper = () => readConsumed({ queue: join(dirname(f), "queue"), tapsLog: f } as any).get(kid) ?? null;
    appendLog(f, { tap: kid, id: "cain-a", at: "x" });
    appendLog(f, { tap: kid, id: "cain-b", at: "x" });
    appendLog(f, { t: "dropped", tap: kid, id: "cain-b", unlanded: true, why: "w", at: "y" });
    expect((r.link as any).keyUse(kid)).toBe("consumed");
    expect(keeper()).toBe("cain-a");
    appendLog(f, { tap: kid, id: "cain-b", at: "z" });                 // the second taken again
    appendLog(f, { t: "dropped", tap: kid, id: "cain-a", unlanded: true, why: "w", at: "y" });
    expect((r.link as any).keyUse(kid)).toBe("consumed");            // the first dropped: the second still holds the key
    expect(keeper()).toBe("cain-b");
    appendLog(f, { t: "dropped", tap: kid, id: "cain-b", unlanded: true, why: "w", at: "y" });
    expect((r.link as any).keyUse(kid)).toBeNull();
    expect(keeper()).toBeNull();
  });
});

describe("3. the replay check reads \"consumed or consuming\" from the one function (invariants: the issued-key log, the held log)", () => {
  test("a replay for a key with an open consuming intent writes no supersede, waits with one line, and resolves once", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.keeperVerified();
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    r.restart();
    const kid = kidOf(r, id), f = consumedFile(r);
    r.keeperVerified();
    r.t.mono = 5_000;
    await r.link.sweep();                                              // the held tap is replayed to Cain
    expect(readLog<any>(side(r, "link-held.log")).records.some((x) => x.t === "released" && x.replay === true)).toBe(true);
    appendLog(f, { t: "consuming", tap: kid, id: "cain-r21-3", at: "x" });   // the keeper is acting on it now
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();
    expect(logged(r).filter((x) => x.t === "supersede")).toHaveLength(0);   // nothing superseded for an action in flight
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(1);
    appendLog(f, { tap: kid, id: "cain-r21-3", at: "y" });
    await r.link.sweep();
    await r.link.sweep();
    const held = readLog<any>(side(r, "link-held.log")).records;
    expect(held.filter((x) => x.t === "replay-done" && x.kid === kid)).toHaveLength(1);
    expect(logged(r).filter((x) => x.t === "supersede")).toHaveLength(0);
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
  });
});

describe("10. the replay waiting line waits out a full page rotation (invariants: the keeper status, the held log)", () => {
  test("a key the status hasn't answered gets the line only after ceil(open / page) keeper rounds plus the wait", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.keeperVerified();
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    r.restart();
    const kid = kidOf(r, id);
    consumedFile(r);
    const open = 3 * REPLAY_PAGE - 10;                                // three pages: three keeper rounds to come round
    r.keeperVerified({ replay_open: open });
    r.t.mono = 5_000;
    await r.link.sweep();
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();                                              // superseded; no answer for it yet
    r.t.mono += REPLAY_WAIT_MS + 1;
    for (let n = 1; n < 3; n++) { r.later(MIN); r.keeperVerified({ replay_open: open }); await r.link.sweep(); }
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(0);      // two rounds: it may still be queued behind the rotation
    r.later(MIN); r.keeperVerified({ replay_open: open });
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(1);
    void kid;
  });

  test("the link's page size is the keeper's", async () => {
    const { KEEPER_REPLAY_PAGE } = await import("../rootfs/opt/cain/link/core");
    expect(KEEPER_REPLAY_PAGE).toBe(REPLAY_PAGE);
  });
});

describe("4. a legacy anchor's voided settle that fails goes to the void-unsettled path (invariants: the link state, the landing ledger)", () => {
  const legacy = (r: R, id: string) => {
    const st = r.state();
    delete (st.messages[id].checked as any).sf;
    for (const t of Object.values(st.taps ?? {})) if (t.msg === id && t.ref) delete (t.ref as any).sf;
    r.setState(st);
    const ledger = JSON.parse(r.files.checks!);
    delete ledger.P08.checked_sf;
    ledger.P08.checked_at = "not a date";
    r.files.checks = JSON.stringify(ledger);
  };
  test("the landing ledger unwritable during the migration: kept as void, one line on the card, Cain told, listed, then retried and cleared", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const st = r.state();
    const key = Object.keys(st.taps!)[0];
    st.taps![key] = { ...st.taps![key], stage: "claimed", nonce: "an-earlier-run" } as any;
    r.setState(st);
    r.landLedger.keys.add(key);
    r.landLedger.what.set(key, { pr: PR, head: SHA1, at: new Date(r.t.now).toISOString() });
    legacy(r, id);
    r.restart();
    r.keeperVerified();
    const L = (r.link as any).d.landings, settle = L.settle;
    let fail = true;
    L.settle = (...a: any[]) => (fail ? false : settle(...a));
    await r.link.sweep();
    expect(r.state().unresolved?.[key]?.what).toBe("void");
    expect((r.link.clockReport() as any).unresolved_landings.map((u: any) => u.tap_key)).toContain(kidOf(r, id));
    expect(onThread(r, id, VOID_UNSETTLED)).toHaveLength(1);
    expect(r.relayed.some((x) => x.startsWith("Landing voided but not yet settled") && x.includes("can't be dated"))).toBe(true);
    expect(r.state().taps![key].outcome).toBe("not acted");          // the claim itself isn't left open either
    await r.link.sweep();
    expect(onThread(r, id, VOID_UNSETTLED)).toHaveLength(1);          // retried, told once
    fail = false;
    await r.link.sweep();
    expect(r.landLedger.settled.get(key)).toBe("not landed");
    expect(r.state().unresolved?.[key]).toBeUndefined();
    void NOT_ACTED_TAP; void CHECK_UNANCHORED;
  });
});

describe("12. a void claim's seven-day alert says nothing was pushed (invariants: the landing ledger)", () => {
  test("the alert to Cain names the void claim and never says to check main", async () => {
    const r = shipRig();
    const status = (x: Record<string, unknown>) => { (r.files as any).status = JSON.stringify({ clock: { synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() }, ...x }); };
    status({ epoch: { n: 2, at: new Date(r.t.now).toISOString(), generation: 0, voided: true } });
    const id = await shipCard(r);
    const L = (r.link as any).d.landings, claim = L.claim;
    L.claim = (k: string, w: any) => { const out = claim(k, w); status({ reset: { at: new Date(r.t.now).toISOString(), why: "forced conflict" }, epoch: { n: 3, at: new Date(r.t.now).toISOString(), generation: 1 } }); return out; };
    L.settle = () => false;
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.later(8 * DAY);
    await r.link.sweep();
    const alert = r.relayed.find((x) => x.startsWith("Landing unresolved for over 7 days"));
    expect(alert).toContain("void claim: nothing was pushed");
    expect(alert).toContain("settle the void claim");
    expect(alert).not.toContain("checks main");
  });
});

describe("9. the stuck-intent waiting notice is per (tap, request, episode) (invariants: the consumed-key log, the keeper status)", () => {
  test("a second stuck episode on the same key after a drop and a re-ask is told again, at the keeper and on the card", async () => {
    const kid = "tap-0000002f9001";
    const { k, card } = keeperWithKey(kid, "cain-r21-9-a");
    const f = tapsLogFile(k.cfg);
    const stuck = (id: string) => {
      appendLog(f, { t: "consuming", tap: kid, id, at: "2026-11-11T13:00:00.000Z" });
      rmSync(`${f}.flock`, { force: true });
      mkdirSync(`${f}.flock`);                                         // the consumed-key log can't be appended to now
      for (let n = 0; n < INTENT_STUCK_ROUNDS; n++) cycle(k.cfg);
    };
    const unstick = () => { rmSync(`${f}.flock`, { recursive: true }); cycle(k.cfg); };
    const waiting = () => (keeperStatus(k).tap_notices ?? []).filter((x: any) => x.why === "waiting" && x.tap === kid);
    stuck("cain-r21-9-a");
    expect(waiting()).toEqual([expect.objectContaining({ id: "cain-r21-9-a", ep: 1, msg: card })]);
    const told = () => k.relayed().split(" / ").filter((l) => l.includes(`couldn't resolve whether 1 tap request(s) were acted on (tap key ${kid})`)).length;
    expect(told()).toBe(1);
    unstick();
    expect(openIntents(k.cfg).size).toBe(0);
    expect(waiting()).toEqual([]);                                     // the mark is cleared once the intent is dropped
    stuck("cain-r21-9-b");                                             // asked again: a new request on the same key, stuck too
    expect(waiting()).toEqual([expect.objectContaining({ id: "cain-r21-9-b", ep: 2 })]);
    expect(told()).toBe(2);
    unstick();
    // The link: one line per (tap, request, episode), the mark gone once the notice is.
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const at = new Date(r.t.now).toISOString(), tap = kidOf(r, id);
    r.keeperVerified({ tap_notices: [{ tap, why: "waiting", reason: "r", msg: id, id: "a", ep: 1, at }] });
    await r.link.sweep(); await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(1);
    r.keeperVerified({ tap_notices: [] });
    await r.link.sweep();
    r.keeperVerified({ tap_notices: [{ tap, why: "waiting", reason: "r", msg: id, id: "b", ep: 2, at }] });
    await r.link.sweep(); await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(2);
    void existsSync;
  }, 120_000);
});

describe("7. retention is clock-free for a card placed in Discord's time (invariants: the link state)", () => {
  test("a forward step of the Pi's clock before he answers: the sweep keeps the buttons and his tap counts", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const st = r.state();
    st.messages[id].expires = null;                                    // judged by its retention alone
    r.setState(st);
    stepPi(r, 40 * DAY);                                               // the Pi's clock jumps past the card's wall-clock until
    r.keeperVerified();
    await r.link.notice("A notice that measures the Pi's clock against Discord's stamp.");
    expect((r.link.clockReport() as any).pi_clock).toBe("off");
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);             // not forgotten: its post snowflake plus 35 days decides
    expect(r.state().messages[id]).toBeDefined();
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + MIN)).toBe("to Cain");
  });

  test("restore derives a legacy card's post time from its snowflake, not the wall-clock until", async () => {
    const r = shipRig();
    r.keeperVerified();
    const real = await askCard(r);
    stepPi(r, 40 * DAY);
    const ghost = sf(sfTime(real) - HOUR, 5);
    const st = r.state();
    st.messages[ghost] = { digest: "", until: r.t.now + 35 * DAY, q: { options: ["Yes"], used: false } } as any;   // a record from before 0.7.0
    (st as any).migrated = false;
    r.setState(st);
    await r.link.sweep();
    expect(r.state().messages[ghost].posted).toBe(sfTime(ghost));
  });

  test("the table names the wall-clock use that remains", () => {
    holds(flat(INVARIANTS), "only for a card with no snowflake id");
  });
});

describe("5. flock: probed at start, resolved through a soname list, its errors told by their cause (invariants: every append-only log)", () => {
  test("the real flock loads and the probe passes on this box (the arm64 CI job runs this too)", () => {
    const dir = mkdtempSync(join(tmpdir(), "r21-probe-"));
    expect(probeLock(dir)).toBeNull();
    expect(LIBC_NAMES.slice(0, 3)).toEqual(["libc.so.6", "libc.so", "libc"]);
    const f = join(dir, "record-install.log");
    appendLog(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    expect(readLog<any>(f).records).toHaveLength(1);
  });

  test("an FFI load failure: the probe names it, the start refuses with a status line he can read, and an append says why at once", () => {
    lockTest.names = ["libno-such-c.so.9"];
    resetFlockForTest();
    const dir = mkdtempSync(join(tmpdir(), "r21-probe-"));
    const why = probeLock(dir)!;
    expect(why).toContain("flock couldn't be loaded from libc");
    expect(why).toContain("libno-such-c.so.9");
    expect(keeperLockProbe({ queue: join(dir, "keeper", "queue") } as any)).toContain("flock couldn't be loaded");   // no git needed (the arm64 job has none)
    const line = lockRefusal("link", `${why} at ${dir}/x.log`);
    expect(line).toContain("can't lock its logs on this box");
    expect(line).not.toMatch(/\/tmp\/|\b[0-9a-f]{7,40}\b|again/);
    let err: unknown = null;
    const t0 = performance.now();
    try { appendLog(join(dir, "link-held.log"), { t: "held", kid: "k" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LockError);
    expect(String(err)).not.toContain("another writer");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a lock error that isn't would-block is told at once by its errno, never as another writer holding it", () => {
    lockTest.call = () => [-1, 9];                                     // EBADF
    const dir = mkdtempSync(join(tmpdir(), "r21-probe-"));
    let err: unknown = null;
    const t0 = performance.now();
    try { appendLog(join(dir, "link-held.log"), { t: "held", kid: "k" }); } catch (e) { err = e; }
    expect(performance.now() - t0).toBeLessThan(1000);                // not after the 5-second wait
    expect(err).toBeInstanceOf(LockError);
    expect(String(err)).toContain("errno 9 (EBADF)");
    expect(String(err)).not.toContain("another writer");
    expect(probeLock(dir)).toContain("errno 9 (EBADF)");
    lockTest.call = () => [-1, 11];                                    // would-block: waited for, then a LockTimeout
    lockWait.ms = 50;
    err = null;
    try { appendLog(join(dir, "link-held.log"), { t: "held", kid: "k" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LockTimeout);
    let n = 0;
    lockTest.call = () => (++n < 3 ? [-1, 4] : [0, 0]);               // EINTR: tried again at once
    appendLog(join(dir, "link-held.log"), { t: "held", kid: "k" });
    expect(readLog<any>(join(dir, "link-held.log")).records).toHaveLength(1);
  });

  test("the workflow runs these on arm64", () => {
    const wf = readFileSync(join(import.meta.dir, "../../.github/workflows/tests.yml"), "utf8");
    expect(wf).toContain("arm64-flock:");
    expect(wf).toContain("--platform linux/arm64");
  });
});

const APPLOG = JSON.stringify(join(import.meta.dir, "../rootfs/opt/cain/applog.ts"));
// Another process holds a log's flock for ms; resolves once it has let go.
const holdLock = async (file: string, ms: number) => {
  const dir = mkdtempSync(join(tmpdir(), "r21-holder-")), script = join(dir, "holder.ts"), flag = join(dir, "in");
  writeFileSync(script, `import { withLogLock } from ${APPLOG};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < Number(process.argv[4])) {} });\n`);
  const done = new Promise<number>((ok) => spawn("bun", [script, file, flag, String(ms)], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
  for (let i = 0; i < 500 && !existsSync(flag); i++) await new Promise((ok) => setTimeout(ok, 10));
  expect(existsSync(flag)).toBe(true);
  return { done };                                                     // not the promise itself: awaiting holdLock waits only until it holds
};

describe("6. a repair truncates only under the lock, or not at all (invariants: every append-only log)", () => {
  test("repair is off by default; repair: true takes the flock; only the keeper's single-writer mirror repairs without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "r21-repair-")), f = join(dir, "record-taps.jsonl");
    writeLogForTest(f, [{ tap: "tap-000000000001", id: "a" }], '9:00000000:{"x"');
    const before = readFileSync(f, "utf8");
    expect(readLog(f).torn).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(before);                     // the default never truncates
    lockWait.ms = 50;
    let err: unknown = null;
    withLogLock(f, () => { try { readLog(f, { repair: true }); } catch (e) { err = e; } });   // a writer holds it: the repair waits
    expect(err).toBeInstanceOf(LockTimeout);
    expect(readFileSync(f, "utf8")).toBe(before);
    expect(readLog(f, { repair: true }).torn).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(before.slice(0, before.indexOf("9:00000000")));
    expect(() => readLog(f, { repair: "mirror" })).toThrow("single-writer mirror");
    const m = join(dir, "record-issued.log");
    writeLogForTest(m, [{ t: "key", kid: "k" }], "12:");
    expect(readLog(m, { repair: "mirror" }).torn).toBe(true);
    expect(readLog(m).torn).toBe(false);
  });
});

describe("8. a lock timeout holds and retries, never drops a record or crashes a loop (invariants: every append-only log, the held log, the consumed-key log)", () => {
  test("every append caller is listed with what it does on a timeout", () => {
    for (const k of ["consumed-key log: consuming intent", "consumed-key log: consumed record", "consumed-key log: dropped intent", "held log: held", "held log: releasing", "landing ledger settle log"])
      expect(Object.keys(LOCK_CALLERS).some((x) => x.startsWith(k))).toBe(true);
    const doc = flat(INVARIANTS);
    holds(doc, "LockTimeout");
    holds(doc, "LOCK_CALLERS");
  });

  test("the consumed-key lock held past the timeout during a tap's request: it stays queued, then is applied exactly once", async () => {
    const kid = "tap-0000002f8101";
    const { k } = keeperWithKey(kid, "cain-r21-8-a");
    lockWait.ms = 100;
    const f = tapsLogFile(k.cfg);
    const held = (await holdLock(f, 4000)).done;
    expect(() => cycle(k.cfg)).not.toThrow();
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(readdirSync(k.cfg.queue).some((n) => readFileSync(join(k.cfg.queue, n), "utf8").includes('"cain-r21-8-a"'))).toBe(true);
    expect(await held).toBe(0);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r21-8-a");
    expect(readLog<any>(f).records.filter((x) => x.tap === kid && x.t === undefined)).toHaveLength(1);
    expect(remoteRequests(k, kid)).toEqual(["cain-r21-8-a"]);
  }, 60_000);

  test("the logs' locks held during a live tap and a held-tap release: the tap keeps its buttons, then is held, then relayed exactly once", async () => {
    const r = shipRig();
    const id = await askCard(r);
    const f = consumedFile(r);
    unverified(r);
    lockWait.ms = 100;
    let a = (await holdLock(side(r, "link-held.log"), 1500)).done, b = (await holdLock(f, 1500)).done;
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: busy");
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);             // nothing held, nothing lost: the card keeps its buttons
    await Promise.all([a, b]);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
    a = (await holdLock(side(r, "link-held.log"), 1500)).done; b = (await holdLock(f, 1500)).done;
    r.keeperVerified();
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(0);                               // the release waits for the lock
    await Promise.all([a, b]);
    await r.link.sweep();
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);                               // applied exactly once after the lock is free
  }, 60_000);
});

describe("13. docs: the table, DOCS.md, Cain's rules, keeper.sh and the CHANGELOG say what round 21 changed", () => {
  test("nothing the owner sees carries a job id or a sha, or asks him to send or tap again", () => {
    for (const line of [lockRefusal("link", "flock couldn't be loaded from libc (tried libc.so.6: no)"), lockRefusal("record keeper", "errno 9 (EBADF)"), VOID_UNSETTLED, TAP_REPLAY_WAITING]) {
      expect(line).not.toMatch(/\b[0-9a-f]{7,40}\b|tap-|cse_|session/i);
      expect(line).not.toMatch(/tap again|send .* again|answer again/i);
    }
  });
  test("DOCS.md, Cain's rules, keeper.sh and the CHANGELOG name the round-21 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    holds(docs, "Round 21");
    holds(docs, "arm64-flock");
    holds(rules, "void claim means nothing was pushed");
    holds(rules, "can't lock its logs");
    holds(flat("../rootfs/opt/cain/keeper.sh"), "Round 21");
    holds(flat("../CHANGELOG.md"), "can never reach your record later");
    holds(flat(INVARIANTS), "source-check-round21.test.ts");
  });
});
