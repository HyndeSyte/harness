// Source checks, twentieth review round (0.12.0): defects in the nineteenth round's own additions, fixed. The log lock is
// an OS advisory lock (flock); a consuming intent resolves only from a commit carrying its own request, and a consumed
// key whose commit didn't land is dropped and told; the forgetting judgement's retention is a constant; legacy anchors
// need a usable keeper date and the card's own request; the per-key replay answer reaches every open replay; a status
// without a run number is unverified; one function for "consumed or consuming"; byte-budgeted records; a measured clock
// reopens the restore sweep; the unstamped refusal for every keyed component; a hand-settle path for a voided claim.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendLog, crashSpy, fitRecord, FREE_TEXT_BUDGET, lockFile, MAX_RECORD_BYTES, readLog, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import { CHECK_UNANCHORED, NOT_ACTED_TAP, TAP_CONSUMING, TAP_REPLAY_AGAIN, TAP_REPLAY_WAITING, TAP_UNLANDED, TAP_UNSTAMPED, REPLAY_WAIT_MS, VOID_UNSETTLED } from "../rootfs/opt/cain/link/core";
import { cycle, INTENT_STUCK_ROUNDS, openIntents, readConsumed, REPLAY_PAGE, replayPage, resolveIntents, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; crashSpy.on = null; });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
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
const consumedFile = (r: R) => { const f = join(mkdtempSync(join(tmpdir(), "r20-consumed-")), "record-taps.jsonl"); (r.deps as any).consumedLog = f; return f; };
const keeperStatus = (k: ReturnType<typeof keeperRig>) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const linkLog = (k: ReturnType<typeof keeperRig>) => join(k.root, "pi/link-issued.log");
const round = (k: ReturnType<typeof keeperRig>, id: string) => { k.cain({ id, ops: [{ op: "note", item: "P44", text: "a round" }] }); return cycle(k.cfg); };
// A keeper with one tap key issued (its key record, and the link's tap record with its interaction id) and Cain's
// request for it queued.
const keeperWithKey = (kid: string, id: string) => {
  const k = keeperRig();
  expect(round(k, `${id}-0`).ok).toBe(true);
  const at = k.cfg.now!().getTime(), card = sf(at);
  appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + DAY, life: DAY });
  writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } } }));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
  return { k, card, at };
};
const run = (args: string[]) => new Promise<number>((ok) => spawn("bun", args, { stdio: "ignore" }).on("exit", (c, sig) => ok(sig === "SIGKILL" ? 137 : c ?? 1)));
const APPLOG = JSON.stringify(join(import.meta.dir, "../rootfs/opt/cain/applog.ts"));

describe("1. the log lock is an OS advisory lock (invariants: every append-only log)", () => {
  test("two waiters recover one dead holder while a third append is attempted, in separate processes: nothing lost or truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r20-lock-")), f = join(dir, "record-install.log");
    appendLog(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    // The holder takes the lock, tears a record onto the log, and dies holding it (SIGKILL): the kernel frees the lock.
    const holder = join(dir, "holder.ts");
    writeFileSync(holder, `import { withLogLock } from ${APPLOG};\nimport { appendFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { appendFileSync(process.argv[2], '90:00000000:{"t":"torn"'); process.kill(process.pid, "SIGKILL"); });\n`);
    const writer = join(dir, "writer.ts");
    writeFileSync(writer, `import { appendLog } from ${APPLOG};\nconst n = Number(process.argv[4]);\nfor (let i = 0; i < n; i++) appendLog(process.argv[2], { t: "once-used", by: process.argv[3], n: i, why: "x".repeat(700) });\n`);
    expect(await run([holder, f])).toBe(137);
    expect(existsSync(lockFile(f))).toBe(true);                        // the lock file stays; the kernel released the lock
    expect(statSync(lockFile(f)).isFile()).toBe(true);
    const codes = await Promise.all([run([writer, f, "waiter-a", "30"]), run([writer, f, "waiter-b", "30"]), run([writer, f, "third", "1"])]);
    expect(codes).toEqual([0, 0, 0]);
    const recs = readLog<any>(f, { repair: false });
    expect(recs.torn).toBe(false);
    expect(recs.bad).toBe(0);
    expect(recs.records.filter((x) => x.by === "waiter-a")).toHaveLength(30);
    expect(recs.records.filter((x) => x.by === "waiter-b")).toHaveLength(30);
    expect(recs.records.filter((x) => x.by === "third")).toHaveLength(1);
    expect(recs.records[0]).toMatchObject({ t: "flag", how: "off" });   // what was there before the dead holder stands
    expect(recs.records.some((x) => x.t === "torn")).toBe(false);
    expect(existsSync(`${f}.lock`)).toBe(false);                       // no folder lock any more
  }, 60_000);

  test("a live holder is waited for, never taken over: the append lands after it lets go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r20-lock-")), f = join(dir, "link-held.log");
    const holder = join(dir, "holder.ts");
    writeFileSync(holder, `import { withLogLock, appendLog } from ${APPLOG};\nimport { writeFileSync } from "node:fs";\nwithLogLock(process.argv[2], () => { writeFileSync(process.argv[3], "in"); const t = Date.now(); while (Date.now() - t < 1500) {} });\nappendLog(process.argv[2], { t: "held", kid: "holder" });\n`);
    const p = run([holder, f, join(dir, "in")]);
    for (let i = 0; i < 200 && !existsSync(join(dir, "in")); i++) await new Promise((ok) => setTimeout(ok, 10));
    const t0 = performance.now();
    appendLog(f, { t: "held", kid: "mine" });
    expect(performance.now() - t0).toBeGreaterThan(500);               // it waited for the holder
    expect(await p).toBe(0);
    expect(readLog<any>(f).records.map((x) => x.kid)).toContain("mine");
  }, 30_000);

  test("the table's fsync paragraph names the flock and no takeover", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("an OS advisory lock (flock)");
    expect(doc).not.toContain("taken over once its holder is gone");
  });
});

describe("2. a consuming intent resolves only from its own commit, and a consumption that didn't land is dropped and told (invariants: the consumed-key log, the record trailers)", () => {
  test("a stale commit from an earlier request on the same key does not resolve a newer intent", () => {
    const kid = "tap-0000002f2001";
    const { k } = keeperWithKey(kid, "cain-r20-2-a");
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r20-2-a");
    // The consumed-key log lost the key's records (a torn tail, say); a newer request's intent stands open on the key.
    const f = tapsLogFile(k.cfg);
    writeLogForTest(f, readLog<any>(f).records.filter((x) => x.tap !== kid));
    appendLog(f, { t: "consuming", tap: kid, id: "cain-r20-2-b", at: "2026-11-11T13:05:00.000Z" });
    resolveIntents(k.cfg, "2026-11-11T13:06:00.000Z");
    expect(openIntents(k.cfg).size).toBe(0);
    const mine = readLog<any>(f).records.filter((x) => x.tap === kid);
    expect(mine.find((x) => x.t === "dropped")?.id).toBe("cain-r20-2-b");   // the newer intent is dropped
    expect(mine.some((x) => x.t === undefined && x.id === "cain-r20-2-b")).toBe(false);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r20-2-a");               // the key stands consumed by its own commit's request
  }, 60_000);

  test("a discarded local commit: the consumption is dropped as not landed, and he and Cain are told", () => {
    const kid = "tap-0000002f2002";
    const { k, card } = keeperWithKey(kid, "cain-r20-2-c");
    k.cfg.beforePush = () => { throw new Error("remote: pushes are off"); };
    cycle(k.cfg);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r20-2-c");
    // The request has left the queue (a request still queued is applied again after a reset, so it isn't judged), and
    // the copy is reset to GitHub's main: the local commit with the trailer is gone.
    for (const n of readdirSync(k.cfg.queue)) if (readFileSync(join(k.cfg.queue, n), "utf8").includes('"cain-r20-2-c"')) rmSync(join(k.cfg.queue, n));
    k.cfg.beforePush = undefined;
    const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: k.cfg.dir });
    g("fetch", "--quiet", "origin", "main");
    g("reset", "--quiet", "--hard", "origin/main");
    expect(round(k, "cain-r20-2-c1").ok).toBe(true);
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    const drop = readLog<any>(tapsLogFile(k.cfg)).records.find((x) => x.t === "dropped" && x.tap === kid && x.unlanded === true);
    expect(drop?.id).toBe("cain-r20-2-c");
    expect(keeperStatus(k).tap_notices.find((n: any) => n.tap === kid)).toMatchObject({ why: "unlanded", msg: card });
    expect(k.relayed()).toContain(`Tap not landed: the change from tap key ${kid}`);
    expect(k.relayed()).toContain("ask again with --checked if it still needs him");
  }, 60_000);

  test("a consumption that reached the remote is marked landed and never dropped", () => {
    const kid = "tap-0000002f2003";
    const { k } = keeperWithKey(kid, "cain-r20-2-d");
    expect(cycle(k.cfg).ok).toBe(true);
    expect(round(k, "cain-r20-2-d1").ok).toBe(true);
    const recs = readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.tap === kid);
    expect(recs.map((x) => x.t ?? "consumed")).toEqual(["consuming", "consumed", "landed"]);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r20-2-d");
  }, 60_000);

  test("the link: a consumption dropped as not landed no longer counts, and the card gets one line saying it didn't land", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const kid = kidOf(r, id), f = consumedFile(r);
    appendLog(f, { tap: kid, id: "cain-x", at: "x" });
    appendLog(f, { t: "dropped", tap: kid, id: "cain-x", unlanded: true, why: "lost to a reset", at: "y" });
    expect((r.link as any).keyUse(kid)).toBeNull();
    r.keeperVerified({ tap_notices: [{ tap: kid, why: "unlanded", reason: "r", msg: id, at: new Date(r.t.now).toISOString() }] });
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, id, TAP_UNLANDED)).toHaveLength(1);
  });
});

describe("3. the forgetting judgement's retention is a constant (invariants: the link state)", () => {
  test("a clock step between the card's recordings doesn't change whether a tap is past its forgetting day", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const st = r.state(), m = st.messages[id];
    m.until = m.posted! + 60 * DAY;                                    // re-recorded after a forward step of the Pi's clock
    m.expires = null;                                                  // judged by the forgetting day alone
    r.setState(st);
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + 40 * DAY)).toBe("dead: forgetting");
    const r2 = shipRig();
    r2.keeperVerified();
    const id2 = await askCard(r2);
    const st2 = r2.state(), m2 = st2.messages[id2];
    m2.until = m2.posted! + 2 * DAY;                                   // re-recorded after a backward step
    m2.expires = null;
    r2.setState(st2);
    expect(await tapAt(r2, id2, r2.msg(id2), sfTime(id2) + 3 * DAY)).not.toBe("dead: forgetting");
    expect(r2.state().messages[id2].keep).toBe(35 * DAY);
  });

  test("the table's link state row names the constant retention", () => {
    expect(flat(INVARIANTS)).toContain("a configured constant (`REMEMBER_MS`");
  });
});

describe("4. the legacy-anchor migration needs a usable keeper date and the card's own request (invariants: the link state, the source-check ledger)", () => {
  const legacy = (r: R, id: string, o: { at?: string; req?: string } = {}) => {
    const st = r.state();
    delete (st.messages[id].checked as any).sf;
    for (const t of Object.values(st.taps ?? {})) if (t.msg === id && t.ref) delete (t.ref as any).sf;
    r.setState(st);
    const ledger = JSON.parse(r.files.checks!);
    delete ledger.P08.checked_sf;
    ledger.P08.checked_at = o.at ?? new Date(sfTime(id) - HOUR).toISOString();
    if (o.req) ledger.P08.checked_req = o.req;
    r.files.checks = JSON.stringify(ledger);
  };

  test("an unusable keeper date: the card has no trustworthy anchor and is withdrawn with the new-source-check line", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    legacy(r, id, { at: "not a date" });
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(String(r.msg(id).content)).toContain(CHECK_UNANCHORED);
  });

  test("a check whose request isn't the card's: withdrawn the same way", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    legacy(r, id, { req: "link-check-p08-another" });
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(String(r.msg(id).content)).toContain(CHECK_UNANCHORED);
    expect(r.relayed.some((x) => x.includes("can't be dated by Discord's time"))).toBe(true);
  });

  test("an open claim with no trustworthy anchor: not acted, its landing claim settled with the reason, a line to him and to Cain", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const st = r.state();
    const key = Object.keys(st.taps!)[0];
    st.taps![key] = { ...st.taps![key], stage: "claimed", nonce: "an-earlier-run" } as any;
    r.setState(st);
    r.landLedger.keys.add(key);                                       // its key's landing claim, still open
    r.landLedger.what.set(key, { pr: PR, head: SHA1, at: new Date(r.t.now).toISOString() });
    legacy(r, id, { at: "not a date" });
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(r.state().taps![key].outcome).toBe("not acted");
    expect(r.landLedger.settled.get(key)).toBe("not landed");          // no longer open, so its key isn't blocked
    expect(onThread(r, id, NOT_ACTED_TAP)).toHaveLength(1);
    expect(r.relayed.some((x) => x.startsWith("Tap not acted") && x.includes("can't be dated by Discord's time"))).toBe(true);
  });

  test("the table's link state row says when there is no trustworthy anchor", () => {
    expect(flat(INVARIANTS)).toContain("a keeper date that can't be read, or a check whose request isn't the card's");
  });
});

describe("5. the per-key replay answer reaches every open replay (invariants: the keeper status, the held log)", () => {
  test(`above ${REPLAY_PAGE} open replays, the keeper's status pages through all of them, continuing from its last page`, () => {
    const k = keeperRig();
    expect(round(k, "cain-r20-5-0").ok).toBe(true);
    const held = join(k.root, "pi/link-held.log"), kids: string[] = [];
    const recs: any[] = [];
    for (let i = 0; i < 1200; i++) { const kid = `tap-${(0x5f0000 + i).toString(16).padStart(12, "0")}`; kids.push(kid); recs.push({ t: "held", kid, at: 1 }, { t: "released", kid, replay: true, at: 1 }); }
    writeLogForTest(held, recs);
    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      expect(round(k, `cain-r20-5-${n}`).ok).toBe(true);
      const s = keeperStatus(k);
      expect(s.replay_open).toBe(1200);
      expect(Object.keys(s.replay_keys)).toHaveLength(REPLAY_PAGE);
      for (const x of Object.keys(s.replay_keys)) seen.add(x);
    }
    expect(seen.size).toBe(1200);                                    // every key answered within three rounds
  }, 120_000);

  test(`the link, above ${REPLAY_PAGE} replays: every key reaches an answer and a terminal outcome`, async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    consumedFile(r);
    const f = side(r, "link-held.log"), N = REPLAY_PAGE + 100, recs: any[] = [];
    for (let i = 0; i < N; i++) { const kid = `tap-${(0x6f0000 + i).toString(16).padStart(12, "0")}`; recs.push({ t: "held", kid, msg: id, at: 1 }, { t: "released", kid, replay: true, at: 1 }); }
    writeLogForTest(f, recs);
    // The keeper's view of it: the link's held log, and its mirror of the link's supersedes.
    const kdir = mkdtempSync(join(tmpdir(), "r20-keeper-"));
    const cfg: any = { queue: join(kdir, "queue"), linkHeld: f, issuedLog: join(kdir, "record-issued.log"), tapsLog: join(kdir, "record-taps.jsonl") };
    r.t.mono = 1_000;
    await r.link.sweep();
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();                                              // every replay superseded by now
    writeLogForTest(cfg.issuedLog, logged(r).filter((x) => x.t === "supersede"));
    let after = -1;
    for (let n = 0; n < 4; n++) {
      const p = replayPage(cfg, after);
      if (!p.open) break;
      after = p.next;
      r.keeperVerified({ replay_keys: p.keys });
      await r.link.sweep();
    }
    const done = new Set(readLog<any>(f).records.filter((x) => x.t === "replay-done").map((x) => x.kid));
    expect(done.size).toBe(N);
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(N);
  }, 120_000);
});

describe("6. a keeper status without a run number counts as unverified (invariants: the keeper status, the link state)", () => {
  test("a legacy status accepted on its nonce alone arms no card; a fresh verification naming the run does", async () => {
    const r = shipRig();
    await r.link.sweep();
    r.failing.add(`PATCH /channels/${DM}/messages/`);
    const id = await askCard(r);
    r.failing.clear();
    expect(r.buttons(id)).toEqual([]);
    unverified(r);
    r.restart();
    r.keeperVerified();
    const st = JSON.parse(r.files.status!);
    delete st.verified.run;                                            // a status as a keeper before round 19 wrote it
    r.files.status = JSON.stringify(st);
    await r.link.sweep();
    await r.link.sweep();
    expect((r.link.clockReport() as any).consumed_verified).toBe(false);
    expect(r.buttons(id)).toEqual([]);
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
  });
});

describe("7. every link path reads \"consumed or consuming\" from one function (invariants: the consumed-key log, the held log)", () => {
  test("a live tap on a key the keeper is consuming now: refused with the waiting line, the card keeps its buttons", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const f = consumedFile(r);
    appendLog(f, { t: "consuming", tap: kidOf(r, id), id: "cain-y", at: "x" });
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + MIN)).toBe("refused: consuming");
    expect(r.ephemerals().at(-1).content).toBe(TAP_CONSUMING);
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(tapLines(r)).toHaveLength(0);
  });

  test("a held tap on a key the keeper is consuming stays held until the intent resolves", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
    const f = consumedFile(r), kid = kidOf(r, id);
    appendLog(f, { t: "consuming", tap: kid, id: "cain-z", at: "x" });
    r.keeperVerified();
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(0);
    appendLog(f, { t: "dropped", tap: kid, id: "cain-z", at: "y" });
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
  });

  test(`intents unresolved for ${INTENT_STUCK_ROUNDS} rounds: a keeper notice to Cain, and one line on the card`, async () => {
    const kid = "tap-0000002f7001";
    const { k, card } = keeperWithKey(kid, "cain-r20-7-a");
    const f = tapsLogFile(k.cfg);
    appendLog(f, { t: "consuming", tap: kid, id: "cain-r20-7-a", at: "2026-11-11T13:00:00.000Z" });
    rmSync(lockFile(f), { force: true });
    mkdirSync(lockFile(f));                                             // the consumed-key log can't be appended to now
    for (let n = 0; n < INTENT_STUCK_ROUNDS; n++) cycle(k.cfg);
    expect(k.relayed()).toContain(`couldn't resolve whether 1 tap request(s) were acted on (tap key ${kid})`);
    expect(keeperStatus(k).tap_notices.find((x: any) => x.tap === kid)).toMatchObject({ why: "waiting", msg: card });
    rmSync(lockFile(f), { recursive: true });
    cycle(k.cfg);
    expect(openIntents(k.cfg).size).toBe(0);
    expect(k.kept().intentStuck).toBeUndefined();
    // The link turns the notice into its one waiting line.
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    r.keeperVerified({ tap_notices: [{ tap: kidOf(r, id), why: "waiting", reason: "r", msg: id, at: new Date(r.t.now).toISOString() }] });
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(1);
  }, 120_000);
});

describe("8. records cut to a byte budget for the whole serialised record (invariants: every append-only log)", () => {
  test("an oversize record whose cut fields hold multi-byte text: cut on code points, written whole, under the limit", () => {
    const f = join(mkdtempSync(join(tmpdir(), "r20-log-")), "settled.log");
    appendLog(f, { key: "k", how: "not landed", reason: "😀".repeat(3000), why: "é".repeat(3000), note: ["日本".repeat(2000), "short"], at: "x" });
    const raw = readFileSync(f);
    expect(raw.length).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const rec = readLog<any>(f).records[0];
    for (const v of [rec.reason, rec.why, rec.note[0]]) {
      expect(Buffer.byteLength(v)).toBeLessThanOrEqual(FREE_TEXT_BUDGET);
      expect(v.endsWith("…")).toBe(true);
      expect(/[\ud800-\udfff]/.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))).toBe(false);   // no lone surrogate
    }
    expect(rec.note[1]).toBe("short");
  });

  test("nested values are bounded, and a record too long in its other fields gets a bounded refusal, nothing written", () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(JSON.stringify(fitRecord({ deep })).length).toBeLessThan(400);
    const f = join(mkdtempSync(join(tmpdir(), "r20-log-")), "link-held.log");
    let err = "";
    try { appendLog(f, { t: "held", kid: "k".repeat(6000) }); } catch (e) { err = String(e); }
    expect(err).toContain(`over ${MAX_RECORD_BYTES} bytes`);
    expect(err.length).toBeLessThan(300);
    expect(existsSync(f) ? readFileSync(f).length : 0).toBe(0);
  });
});

describe("9. the read-back bound, and a measured clock reopening the sweep (invariants: the sweep cursor)", () => {
  test("a post that measures the Pi's clock off after the sweep was marked done clears the done mark and reopens the sweep", async () => {
    const r = shipRig();
    await r.link.sweep();
    unverified(r);
    (r.files as any).status = JSON.stringify({ ...JSON.parse(r.files.status!), consumed_unverified: { since: new Date(r.t.now).toISOString(), why: "its log of consumed tap keys is missing", tries: 0 } });
    r.restart();
    await r.link.sweep();
    const cursor = () => JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"));
    expect(cursor().done).toBe(true);                                 // a quiet restart: the read-back bound finds nothing off
    stepPi(r, HOUR);                                                   // the Pi's clock was ahead all along
    await askCard(r);                                                  // a post measures it (the keeper's restore still stands)
    expect((r.link.clockReport() as any).pi_clock).toBe("off");
    expect(cursor().done).toBe(false);
    const reads = r.reads();
    await r.link.sweep();
    expect(r.reads()).toBeGreaterThan(reads);                          // the sweep reads again
  });

  test("the comment says what the code does, and the table says an ahead clock goes undetected until measured", () => {
    const code = flat("../rootfs/opt/cain/link/core.ts");
    expect(code).not.toContain("a read alone never moves it");
    expect(flat(INVARIANTS)).toContain("a Pi clock that is ahead goes undetected until a post or a tap measures it");
  });
});

describe("10. the unstamped live-tap refusal for every keyed component (invariants: the link state)", () => {
  test("a Ship tap without Discord's time for it: refused with the line on the card, nothing lands", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await shipCard(r);
    expect(await tapAt(r, id, r.msg(id), "not-a-snowflake")).toBe("refused: unstamped");
    expect(onThread(r, id, TAP_UNSTAMPED)).toHaveLength(1);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(r.relayed.some((x) => x.startsWith("Tap not acted") && x.includes(id))).toBe(true);
  });
});

describe("11. a voided but unsettled landing claim gets a hand-settle path (invariants: the landing ledger)", () => {
  test("the void can't be marked settled: kept unresolved for his settle line, one line on the card, retried and cleared", async () => {
    const r = shipRig();
    const status = (s: Record<string, unknown>) => { (r.files as any).status = JSON.stringify({ clock: { synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() }, ...s }); };
    status({ epoch: { n: 2, at: new Date(r.t.now).toISOString(), generation: 0, voided: true } });
    const id = await shipCard(r);
    const L = (r.link as any).d.landings, claim = L.claim, settle = L.settle;
    L.claim = (k: string, w: any) => { const out = claim(k, w); status({ reset: { at: new Date(r.t.now).toISOString(), why: "forced conflict" }, epoch: { n: 3, at: new Date(r.t.now).toISOString(), generation: 1 } }); return out; };
    let fail = true;
    L.settle = (...a: any[]) => (fail ? false : settle(...a));
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    const key = [...r.landLedger.keys][0];
    expect(r.github.landings).toHaveLength(0);
    expect(r.state().unresolved?.[key]?.what).toBe("void");
    expect((r.link.clockReport() as any).unresolved_landings.map((u: any) => u.tap_key)).toContain(kidOf(r, id));   // his settle line can settle it
    expect(onThread(r, id, VOID_UNSETTLED)).toHaveLength(1);
    expect(r.relayed.some((x) => x.startsWith("Landing voided but not yet settled"))).toBe(true);
    fail = false;
    await r.link.sweep();
    expect(r.landLedger.settled.get(key)).toBe("not landed");
    expect(r.state().unresolved?.[key]).toBeUndefined();
    expect(onThread(r, id, VOID_UNSETTLED)).toHaveLength(1);
  });
});

describe("12. the table's crash-test paragraph lists the keeper state once", () => {
  test("under the child-process heading, not among the rows without one", () => {
    const doc = flat(INVARIANTS);
    const para = doc.slice(doc.indexOf("Crash-injection tests"));
    expect(para.split("the keeper state").length - 1).toBe(1);
    expect(para.slice(para.indexOf("Rows without one"))).not.toContain("the keeper state");
  });
});

describe("13. docs: the table, DOCS.md, Cain's rules and keeper.sh usage say what round 20 changed", () => {
  test("nothing the owner sees carries a job id or a sha, or asks him to send or tap again", () => {
    for (const line of [TAP_CONSUMING, TAP_UNLANDED, VOID_UNSETTLED]) {
      expect(line).not.toMatch(/\b[0-9a-f]{7,40}\b|tap-|cse_|session/i);
      expect(line).not.toMatch(/tap again|send .* again|answer again/i);
    }
  });
  test("DOCS.md, Cain's rules, keeper.sh and the CHANGELOG name the round-20 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    expect(docs).toContain("Round 20");
    expect(docs).toContain("flock");
    expect(rules).toContain("Tap not landed");
    expect(flat("../rootfs/opt/cain/keeper.sh")).toContain("replay_open");
    expect(flat("../CHANGELOG.md")).toContain("didn't land");
  });
});
