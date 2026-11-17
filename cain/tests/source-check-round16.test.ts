// Source checks, sixteenth review round (0.12.0): the fifteenth round's additions made whole. No owner line and no
// held tap is judged against the Pi's clock (a Pi has no real-time clock, so after a power cut it can be hours
// off until time sync): his recover line's liveness is Discord's snowflakes alone, a held tap is judged snowflake
// against snowflake, and when the Pi's clock is the outlier he is told so plainly. The keeper's verified status is
// bound to its current start and the link's current run; a recover line never verifies anything, and his
// install-on line waits for a fresh fetch; verification first observed re-runs the arming checks before any
// waiting line clears; held releases resolve only once verified, a flagged replay with no keeper request in 10
// minutes asks him again; history reads draw no reply; the restore sweep keeps a durable cursor and honours
// Retry-After; the keeper floors a held tap by its durable held record; and a restore takes older Ship cards'
// buttons off until they are reissued.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLog, readLog } from "../rootfs/opt/cain/applog.ts";
import { CARD_CHECKING, CARD_LOST_RESTORE, CARD_WITHDRAWN, CLOCK_TOLERANCE_MS, clockOffLine, EXPIRED, INSTALL_LINE, KEEPER_START_WHY, OWNER_LINE_MS,
  RECOVER_LINE, REPLAY_WAIT_MS, SHIP_CHECKING, SHIP_RESTORE_REISSUE, TAP_EXPIRED, TAP_HOLD_FLOOR, TAP_REPLAY_AGAIN } from "../rootfs/opt/cain/link/core";
import { cycle, forgetRebuild, linkHeldFile, readConsumed, recoverFile, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig, sh } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const WORDS = "Stop stays within reach of your newest message.";

type R = ReturnType<typeof linkRig>;
type K = ReturnType<typeof keeperRig>;
const shipRig = (o: Parameters<typeof linkRig>[0] = {}) => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []), ...o });
let checks = 0;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: `the county portal, read at 8 (${++checks})` }) as any).message as string;
const shipCard = async (r: R, head = SHA1) =>
  (await r.link.ship({ item: "P41", pr: PR, head, text: WORDS, checked: `the pull request on GitHub, open at that head, read at 8 (${++checks})` }) as any).message as string;
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const logged = (r: R) => readLog<any>(r.issuedLog!, { repair: false }).records;
const side = (r: R, name: string) => join(dirname(r.issuedLog!), name);
const clock = (r: R) => ({ clock: { synced: true, source: "the rig", diagnostic: "", at: new Date(r.t.now).toISOString() } });
const unverified = (r: R, why = KEEPER_START_WHY, extra: Record<string, unknown> = {}) =>
  { r.files.status = JSON.stringify({ ...clock(r), consumed_unverified: { since: new Date(r.t.now - MIN).toISOString(), why, tries: 0 }, ...extra }); };
const tapLines = (r: R) => r.relayed.filter((x) => x.includes("Dane tapped") && x.includes("Tap key"));
const proposed = (r: R, words: string) => /```\n([a-z ]+ [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().filter((m: any) => String(m.content).includes(words)).at(-1)!.content))![1];
const passResults = (r: R) => writeFileSync(r.installResults, JSON.stringify({ head: "b".repeat(40),
  smoke: { pass: true, at: new Date(r.t.now - DAY).toISOString() }, resilience: { pass: true, at: new Date(r.t.now - DAY / 2).toISOString() } }));
const unarmedAsk = async (r: R) => {
  await r.link.sweep();
  r.failing.add(`PATCH /channels/${DM}/messages/`);
  const id = await askCard(r);
  r.failing.clear();
  expect(r.buttons(id)).toEqual([]);
  return id;
};
const kidOf = (r: R, id: string, i = 0) => logged(r).filter((x) => x.t === "key" && x.msg === id)[i].kid as string;
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));

// The keeper's side.
const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const remoteDown = (k: K) => renameSync(k.remote, `${k.remote}.away`);
const remoteBack = (k: K) => renameSync(`${k.remote}.away`, k.remote);
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const localLog = (k: K, n = 8) => sh(["git", "log", "--format=%B", `-${n}`], k.cfg.dir);
const shipTake = (id: string, tap: string) => ({ id, tap, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
const linkRun = (k: K, nonce: string, run?: number) => {
  const f = join(k.root, "pi/link/state.json");
  let j: any = { messages: {}, issued: {} };
  try { j = JSON.parse(readFileSync(f, "utf8")); } catch { /* none yet */ }
  writeFileSync(f, JSON.stringify({ ...j, run: run ?? (j.run ?? 2) + 1, runNonce: nonce }));
};

describe("1. nothing an owner line or a held tap counts on is judged against the Pi's clock", () => {
  for (const [dir, off] of [["hours ahead", 5 * HOUR], ["hours behind", -5 * HOUR]] as const) {
    test(`the Pi's clock ${dir} at a degraded start with the remote away: the recover line counts, he is told the clock is off, and nothing turns verified until the fetch`, async () => {
      const k = keeperRig();
      k.cain(shipTake("cain-r16-0", "tap-00000000d100"));
      expect(cycle(k.cfg).ok).toBe(true);
      rmSync(tapsLogFile(k.cfg));                                      // a restore lost the consumed-key log: a degraded start
      forgetRebuild(k.cfg);
      remoteDown(k);
      k.cain({ id: "cain-r16-held", tap: "tap-00000000d101", ops: [{ op: "note", item: "P44", text: "his tap" }] });
      cycle(k.cfg);
      expect(status(k).consumed_unverified).toBeDefined();

      // The link, its clock hours off Discord's, reading that status.
      const r = shipRig({ installTaps: false });
      r.t.discord = -off;
      const card = await unarmedAsk(r);                                // a card whose buttons wait for a start
      r.files.status = JSON.stringify(status(k));
      r.restart();
      await r.link.sweep();
      expect(await r.link.recoverLogs({})).toMatchObject({ status: "proposed" });
      const line = proposed(r, RECOVER_LINE);
      r.t.now += 3 * MIN;
      const his = r.his(line);
      const out = await r.link.recoverLogs({ said: his.id });
      expect(out).toMatchObject({ status: "ok" });
      expect(out.said).toContain("The Pi's clock is off by about 300 minutes");
      expect(r.cards().filter((m: any) => String(m.content).startsWith("The Pi's clock is off by about 300 minutes")).length).toBe(1);
      expect(r.cards().some((m: any) => String(m.content).includes("didn't count"))).toBe(false);   // no fresh code that fails the same way

      // The keeper takes it: the damaged state is cleared and the rebuild runs again, but nothing is verified.
      writeFileSync(recoverFile(k.cfg), readFileSync(r.recoverFile));
      cycle(k.cfg);
      expect(k.kept().recovered).toContain(his.id);
      const st = status(k);
      expect(st.consumed_unverified).toBeDefined();
      expect(st.verified).toBeUndefined();
      r.files.status = JSON.stringify(st);
      await r.link.sweep();
      expect(r.buttons(card)).toEqual([]);                             // no card re-armed
      expect(r.msg(card).content).toContain(CARD_CHECKING);
      // His install-on line waits for the fetch too.
      passResults(r);
      await expect(r.link.installTaps({ how: "on" })).rejects.toThrow("consumed set isn't verified by a fresh fetch yet");

      // The remote back: a fresh fetch verifies, for the keeper's start and the link's current run.
      remoteBack(k);
      linkRun(k, r.state().runNonce!, r.state().run);
      expect(cycle(k.cfg).ok).toBe(true);
      const ok = status(k);
      expect(ok.consumed_unverified).toBeUndefined();
      expect(ok.verified).toMatchObject({ start: ok.start.nonce, link: r.state().runNonce });
      expect(k.states("cain-r16-held")).toEqual(["done"]);
      r.files.status = JSON.stringify(ok);
      await r.link.sweep();
      expect(r.buttons(card)).toEqual(["Filed", "Not filed"]);
      expect(await r.link.installTaps({ how: "on" })).toMatchObject({ status: "proposed" });
      r.t.now += MIN;
      expect(await r.link.installTaps({ how: "on", said: r.his(proposed(r, INSTALL_LINE)).id })).toMatchObject({ status: "ok" });
    }, 60_000);
  }

  test("a line past 30 minutes after its code, by Discord's two times alone, is told to him with both times and a fresh code", async () => {
    const r = shipRig();
    r.t.discord = 4 * HOUR;                                            // the Pi's clock far behind: it plays no part
    await r.link.sweep();
    await r.link.recoverLogs({});
    const line = proposed(r, RECOVER_LINE);
    r.t.discord += OWNER_LINE_MS + MIN;
    const out = await r.link.recoverLogs({ said: r.his(line).id });
    expect(out).toMatchObject({ status: "proposed" });
    const told = r.cards().filter((m: any) => String(m.content).startsWith("Your recover line didn't count: by Discord's times the code went out at "));
    expect(told).toHaveLength(1);
    expect(String(told[0].content)).toContain("and your line came at");
    const fresh = proposed(r, RECOVER_LINE);
    expect(fresh).not.toBe(line);
    expect(await r.link.recoverLogs({ said: r.his(fresh).id })).toMatchObject({ status: "ok" });
  });

  for (const [dir, off] of [["ahead", 3 * HOUR], ["behind", -3 * HOUR]] as const) {
    test(`a held tap with the Pi's clock hours ${dir}: judged by snowflakes, it acts before expiry and is told the clock is off; one after expiry is not acted`, async () => {
      const r = shipRig();
      r.t.discord = -off;
      const id = await askCard(r);
      const E = r.state().messages[id].expires!;
      r.t.now = E - 10 * MIN;
      unverified(r);
      expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
      r.keeperVerified();
      await r.link.sweep();
      expect(tapLines(r)).toHaveLength(1);
      expect(onThread(r, id, clockOffLine(off))).toHaveLength(1);
      expect(onThread(r, id, TAP_EXPIRED)).toHaveLength(0);

      // After expiry by Discord's time: the Pi's clock skew makes no difference.
      const r2 = shipRig();
      r2.t.discord = -off;
      const id2 = await askCard(r2);
      const E2 = r2.state().messages[id2].expires!;
      r2.t.now = E2 - 10 * MIN;
      unverified(r2);
      const late = r2.snowflake(E2 - off + 5 * MIN);                    // Discord: five minutes past the card's expiry
      // Round 17: a live tap's expiry is Discord's time too, so it is refused as expired at once, never held.
      expect(await r2.tap(structuredClone(r2.msg(id2)), r2.ids(id2)[0], { id: late })).toBe("dead: expired");
      r2.keeperVerified();
      await r2.link.sweep();
      expect(tapLines(r2)).toHaveLength(0);
    });
  }

  test("the keeper: a held tap under a Pi clock hours ahead is judged by snowflakes alone", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime(), PI = at + 4 * HOUR;               // the Pi's clock, four hours ahead of Discord's
    k.cain({ id: "cain-k16-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const card = sf(at);
    const key = (kid: string) => ({ t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at: PI, exp: PI + 10 * MIN });
    const state: any = { messages: {}, issued: {} };
    for (const [kid, discordAt] of [["tap-00000000d201", at + 9 * MIN], ["tap-00000000d202", at + 11 * MIN]] as const) {
      appendLog(linkLog(k), key(kid));
      state.issued[kid] = { item: "P11", kind: "ask", label: "Filed", msg: card, at: PI + 5 * MIN };
      appendLog(linkHeldFile(k.cfg), { t: "held", kid, msg: card, at: PI + 5 * MIN, it: sf(discordAt, 9) });
    }
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(state));
    k.at(new Date(PI + 60 * MIN));
    k.cain({ id: "cain-k16-1", tap: "tap-00000000d201", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    k.cain({ id: "cain-k16-2", tap: "tap-00000000d202", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-k16-1")).toEqual(["done"]);
    expect(k.reason("cain-k16-2")).toContain("had expired when he tapped it");
  }, 60_000);
});

describe("2. the keeper's verified status is bound to its current start and the link's run", () => {
  test("a stale verified status from before a restart, or restored with the image, re-arms nothing and clears no waiting line until a fresh fetch", async () => {
    const r = shipRig();
    const card = await unarmedAsk(r);
    const ship = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);          // a Ship tap while unverified: the waiting line
    expect(r.msg(ship).content).toContain(SHIP_CHECKING);
    r.keeperVerified();
    const stale = r.files.status;                                       // verified for the run before the restart
    r.restart();
    for (const s of [stale, JSON.stringify({ ...JSON.parse(stale!), verified: { ...JSON.parse(stale!).verified, start: "another" } })]) {
      (r.files as any).status = s;
      await r.link.sweep();
      expect(r.buttons(card)).toEqual([]);
      expect(r.msg(card).content).toContain(CARD_CHECKING);
      expect(r.msg(ship).content).toContain(SHIP_CHECKING);
      expect((r.link.clockReport() as any).consumed_verified).toBe(false);
    }
    r.keeperVerified();                                                // the keeper's fresh fetch in its current start, this run
    await r.link.sweep();
    expect(r.buttons(card)).toEqual(["Filed", "Not filed"]);
    expect(r.msg(ship).content).not.toContain(SHIP_CHECKING);
  });

  test("the keeper marks each start in its status at once, and only a fresh fetch in it, seeing the link's run, verifies", () => {
    const k = keeperRig();
    linkRun(k, "aaaa0001");
    expect(cycle(k.cfg).ok).toBe(true);
    const one = status(k);
    expect(one.verified).toMatchObject({ start: one.start.nonce, link: "aaaa0001", fetches: 1 });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).verified.fetches).toBe(2);
    // A restart with the remote away: a new start, unverified, the old verified gone.
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain({ id: "cain-r16-s1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    const two = status(k);
    expect(two.start.nonce).not.toBe(one.start.nonce);
    expect(two.verified).toBeUndefined();
    expect(two.consumed_unverified).toBeDefined();
    remoteBack(k);
    linkRun(k, "aaaa0002");
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).verified).toMatchObject({ start: two.start.nonce, link: "aaaa0002", fetches: 1 });
  }, 60_000);
});

describe("4. verification first observed re-runs the arming checks before any waiting line clears", () => {
  test("a waiting-line Ship card whose key was consumed only on the remote ends withdrawn, with no buttons", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    expect(r.msg(ship).content).toContain(SHIP_CHECKING);
    const consumed = side(r, "record-taps.jsonl");
    appendLog(consumed, { tap: kidOf(r, ship), id: "cain-on-the-remote", at: "x" });
    r.deps.consumedLog = consumed;
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(ship)).toEqual([]);
    expect(r.msg(ship).content).toContain(CARD_WITHDRAWN);
    expect(r.msg(ship).content).not.toContain(SHIP_CHECKING);
    expect(r.github.landings).toHaveLength(0);
  });

  test("a clean waiting-line Ship card has its line cleared and lands once", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    r.keeperVerified();
    await r.link.sweep();
    expect(r.msg(ship).content).not.toContain(SHIP_CHECKING);
    expect(r.buttons(ship)).toEqual(["Ship", "Not now"]);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    await r.link.whenLanded();
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
  });
});

describe("5. held releases resolve only once verified, and a replay with no keeper request asks again", () => {
  test("the crash point with the remote down at restart: nothing resolved, the held line kept; then resolved once after the fetch", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
    r.keeperVerified();
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    expect(tapLines(r)).toHaveLength(1);
    r.restart();
    unverified(r);                                                     // the remote down at the restart
    await r.link.sweep();
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
    expect(r.msg(id).content).toContain("You answered: Filed");
    expect(readLog<any>(side(r, "link-held.log")).records.map((x) => x.t)).toEqual(["held", "releasing"]);
    r.keeperVerified();
    await r.link.sweep();
    const lines = tapLines(r);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith(`Replay of held tap key ${kidOf(r, id)}`);
    expect(lines[1]).toContain("look tap key");
    expect(lines[1]).toContain("act only if it is in none of them, never from memory");
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(2);
    // No keeper request for the key within the bound: one line on the card asking for a fresh tap.
    r.t.now += REPLAY_WAIT_MS + MIN;
    await r.link.sweep();
    // Round 18: the line waits for the keeper's status to show the supersede mirrored.
    const sup = readLog<any>(r.issuedLog!, { repair: false }).records.find((x) => x.t === "supersede");
    r.keeperVerified({ superseded: [sup.kid], replay_keys: { [sup.kid]: { mirrored: true, consumed: "no" } } });   // round 19: the per-key answer
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(1);
    expect(r.relayed.filter((x) => x.startsWith("No request came for replayed held tap key"))).toHaveLength(1);
  });

  test("a replay the keeper took a request for asks nothing more", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.keeperVerified();
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    const consumed = side(r, "record-taps.jsonl");
    appendLog(consumed, { tap: kidOf(r, id), id: "cain-replayed", at: "x" });
    r.deps.consumedLog = consumed;
    r.t.now += REPLAY_WAIT_MS + MIN;
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
  });

  test("Cain's rules: a flagged replay is looked up, never acted from memory", () => {
    const rules = flat("../rootfs/opt/cain/CLAUDE.md");
    for (const t of ["Replay of held tap key", "consumed-key log and request log", "state/decisions.md", "never from memory", "answer again on the fresh card"]) expect(rules).toContain(t);
  });
});

describe("6. only live messages are answered as commands", () => {
  test("the restore sweep pages past an old recover line and nothing is posted; the old line itself draws no code", async () => {
    const r = shipRig();
    await r.link.sweep();
    await r.link.recoverLogs({});
    const old = r.his(proposed(r, RECOVER_LINE));                      // sent before the restart
    for (let i = 0; i < 120; i++) r.his(`message ${i}`);
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    const posts = r.posts();
    await r.link.sweep();
    expect(r.reads()).toBeGreaterThanOrEqual(2);
    expect(r.posts()).toBe(posts);
    // Round 17: this old line answers a proposal still within 30 minutes of it by Discord's times, so it is answered
    // once (sent while the App was offline, with a fresh code); it never acts, and a second run draws nothing.
    expect(await r.link.recoverLogs({ said: old.id })).toMatchObject({ status: "proposed" });
    expect(r.posts()).toBe(posts + 1);
    await expect(r.link.recoverLogs({ said: old.id })).rejects.toThrow("it is history, not a live line");
    expect(r.posts()).toBe(posts + 1);
    expect(existsSync(r.recoverFile)).toBe(false);
  });
});

describe("7. the restore sweep keeps a durable cursor and honours Retry-After", () => {
  test("a failure at the second page, resumed after a restart from the cursor, finds the card behind 150 messages; a second completed sweep reads nothing", async () => {
    const r = shipRig();
    await r.link.sweep();
    const st0 = r.state(), log0 = readFileSync(r.issuedLog!);
    const lost = await askCard(r);
    for (let i = 0; i < 150; i++) r.his(`message ${i}`);
    r.setState(st0);
    writeFileSync(r.issuedLog!, log0);
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    r.failing.add(`GET /channels/${DM}/messages?limit=100&before=`);   // the second page fails
    await r.link.sweep();
    expect(r.buttons(lost)).toEqual(["Filed", "Not filed"]);
    const cursor = JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"));
    expect(cursor).toMatchObject({ done: false });
    expect(cursor.before).toMatch(/^\d+$/);
    r.failing.clear();
    r.restart();
    (r.link as any).noteStamp(r.snowflake());                         // round 18: a Discord stamp compared in this run
    const from = r.calls.length;
    await r.link.sweep();
    const reads = r.calls.slice(from).filter((c) => c.method === "GET" && c.path.startsWith(`/channels/${DM}/messages?`));
    expect(reads[0].path).toContain(`before=${cursor.before}`);           // resumed, not from the newest
    expect(r.buttons(lost)).toEqual([]);
    expect(r.msg(lost).content).toContain(CARD_LOST_RESTORE);
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"))).toMatchObject({ done: true });
    r.restart();
    const n = r.reads();
    await r.link.sweep();
    expect(r.reads()).toBe(n);
  });

  test("a 429 waits its Retry-After and the page is read again", async () => {
    const r = shipRig();
    await r.link.sweep();
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    (r.link as any).noteStamp(r.snowflake());                         // round 18: a Discord stamp compared in this run
    r.limitN[`GET /channels/${DM}/messages?limit=100`] = 1;
    const waits = r.keeper.waits;
    await r.link.sweep();
    expect(r.keeper.waits).toBe(waits + 1);
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"))).toMatchObject({ done: true });
  });
});

describe("8. the keeper floors a held tap by its durable held record, not its own restart", () => {
  test("a keeper restart between the hold and the release: the tap still acts", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime(), card = sf(at);
    k.cain({ id: "cain-k8-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000d801", item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + 10 * MIN });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { "tap-00000000d801": { item: "P11", kind: "ask", label: "Filed", msg: card, at: at + 5 * MIN } } }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: "tap-00000000d801", msg: card, at: at + 5 * MIN, it: sf(at + 5 * MIN, 9), hold: { period: "k-start-1", id: sf(at + 4 * MIN, 8), from: "interaction" } });   // round 17: a Discord-stamped hold start
    // The keeper restarts at +20 minutes with the remote away, then the remote returns.
    k.at(new Date(at + 20 * MIN));
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain({ id: "cain-k8-1", ops: [{ op: "note", item: "P44", text: "another round" }] });
    cycle(k.cfg);
    remoteBack(k);
    k.cain({ id: "cain-k8-2", tap: "tap-00000000d801", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-k8-2")).toEqual(["done"]);
  }, 60_000);

  test("a hold its record says began after the card expired is refused, the key kept, and the card names the restart", async () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime(), card = sf(at);
    k.cain({ id: "cain-k8b-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000d802", item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + 10 * MIN });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { "tap-00000000d802": { item: "P11", kind: "ask", label: "Filed", msg: card, at: at + 5 * MIN } } }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: "tap-00000000d802", msg: card, at: at + 5 * MIN, it: sf(at + 5 * MIN, 9), hold: { period: "k-start-1", id: sf(at + 12 * MIN, 8), from: "interaction" } });   // round 17: a Discord-stamped hold start
    k.cain({ id: "cain-k8b-1", tap: "tap-00000000d802", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-k8b-1")).toContain("held across a restart");
    expect(readConsumed(k.cfg).has("tap-00000000d802")).toBe(false);
    const notice = status(k).tap_notices.find((n: any) => n.tap === "tap-00000000d802");
    expect(notice).toMatchObject({ why: "hold" });

    const r = shipRig();
    const id = await askCard(r);
    r.keeperVerified({ tap_notices: [{ ...notice, tap: kidOf(r, id), msg: id }] });
    await r.link.sweep();
    expect(onThread(r, id, TAP_HOLD_FLOOR)).toHaveLength(1);
  }, 60_000);

  test("the link writes the hold's start into the held record, as a Discord-stamped id (round 17)", async () => {
    const r = shipRig();
    r.t.discord = -2 * HOUR;
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const h = readLog<any>(side(r, "link-held.log")).records[0];
    // Round 17: the hold's start is the first held interaction's own id (Discord's stamp), never the keeper's
    // status time: no Pi clock reading in it.
    expect(h.hold).toEqual({ period: JSON.parse(r.files.status!).consumed_unverified.since, id: h.it, from: "interaction" });
  });
});

describe("9. a restore takes older Ship cards' buttons off until they are reissued", () => {
  test("a detected restore with a Ship card from before it: buttonless, with the line, and Cain told; a question card keeps its buttons", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    const ask = await askCard(r);
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    await r.link.sweep();
    expect(r.buttons(ship)).toEqual([]);
    expect(r.msg(ship).content).toContain(SHIP_RESTORE_REISSUE);
    expect(r.relayed.some((x) => x.includes("a Ship card from before the restore isn't tappable"))).toBe(true);
    expect(r.buttons(ask)).toEqual(["Filed", "Not filed"]);
    expect(await r.tap(structuredClone(r.msg(ship)), "q:0000000000:0")).not.toBe("to Cain");
    expect(r.github.landings).toHaveLength(0);
  });
});

describe("10. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md"), sh2 = flat("../rootfs/opt/cain/keeper.sh");
    for (const t of ["the Pi's clock is off by about", "snowflake", "30 minutes", "the keeper's current start", "this link run", "never marks the consumed set verified",
      "install-on line waits", "arming checks again", "Replay of held tap key", "10 minutes", "only live messages", "durable cursor", "Retry-After",
      "the hold start the held record carries", "until it is reissued", "one landing per head", "recover line with the Pi's clock hours off"]) expect(docs).toContain(t);
    for (const t of ["The Pi's clock is off", "consumed-key log and request log", "never from memory", "30 minutes"]) expect(rules).toContain(t);
    for (const t of ["30 minutes", "the Pi's clock", "fresh fetch"]) expect(sh2).toContain(t);
    for (const t of ["the Pi's clock", "Ship card from before"]) expect(log).toContain(t);
  });
});
