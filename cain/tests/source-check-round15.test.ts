// Source checks, fifteenth review round (0.12.0): the fourteenth round's additions made whole. His recover line
// works whatever state the record keeper is in, and a stale code gets a fresh one at once; a Ship tap while the
// consumed set is unverified gets its own line on the card, cleared once verified, with nothing kept; a held
// tap's time is Discord's, bounded by the keeper's own hold start, and refused when the clocks disagree; no
// card is re-armed at a start before the consumed set is verified; a held tap's release is marked before its
// relay, so a crash repeats it flagged or not at all; the post-restore sweep pages back to the card horizon; and
// the remote-down-then-restore gap is pinned as known.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLog, readLog } from "../rootfs/opt/cain/applog.ts";
import { CARD_CHECKING, CARD_LOST_RESTORE, CARD_WITHDRAWN, CLOCK_TOLERANCE_MS, clockOffLine, INSTALL_LINE, KEEPER_START_WHY, RECOVER_LINE, SHIP_CHECKING,
  TAP_EXPIRED, TAP_TIME_DISAGREE } from "../rootfs/opt/cain/link/core";
import { cycle, forgetRebuild, issuedMirrorFile, linkHeldFile, readConsumed, recoverFile, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
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
  { r.files.status = JSON.stringify({ ...clock(r), consumed_unverified: { since: "2026-11-11T13:00:00.000Z", why, tries: 0 }, ...extra }); };
// Round 16: verified for the keeper's current start and this link run.
const verified = (r: R, extra: Record<string, unknown> = {}) => r.keeperVerified(extra);
const tapLines = (r: R) => r.relayed.filter((x) => x.includes("Dane tapped") && x.includes("Tap key"));
const proposed = (r: R, words: string) => /```\n([a-z ]+ [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().filter((m: any) => String(m.content).includes(words)).at(-1)!.content))![1];
const unarmedAsk = async (r: R) => {
  await r.link.sweep();
  r.failing.add(`PATCH /channels/${DM}/messages/`);
  const id = await askCard(r);
  r.failing.clear();
  expect(r.buttons(id)).toEqual([]);
  return id;
};
// Every edit that put buttons on a card.
const armedEdits = (r: R, id: string, from = 0) => r.calls.slice(from).filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${id}`) && (c.body?.components ?? []).length > 0);

// The keeper's side.
const shipTake = (id: string, tap: string) => ({ id, tap, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const remoteDown = (k: K) => renameSync(k.remote, `${k.remote}.away`);
const remoteBack = (k: K) => renameSync(`${k.remote}.away`, k.remote);
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const localLog = (k: K, n = 8) => sh(["git", "log", "--format=%B", `-${n}`], k.cfg.dir);

describe("1. his recover line works whatever state the keeper is in", () => {
  test("a degraded start, the remote away, the consumed set unverified: proposed, accepted, its trailer committed locally, and pushed once the remote is back", async () => {
    const k = keeperRig();
    k.cain(shipTake("cain-r15-0", "tap-00000000c100"));
    expect(cycle(k.cfg).ok).toBe(true);
    rmSync(tapsLogFile(k.cfg));                                        // a restore lost the consumed-key log: a degraded start
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain({ id: "cain-r15-held", tap: "tap-00000000c101", ops: [{ op: "note", item: "P44", text: "his tap" }] });
    cycle(k.cfg);
    const st = status(k);
    expect(st.consumed_unverified).toBeDefined();
    expect(st.consumed_unverified.why).not.toBe(KEEPER_START_WHY);

    // The link, reading that status: proposes and accepts his line; nothing waits on the consumed set.
    const r = shipRig();
    r.files.status = JSON.stringify(st);
    expect(await r.link.recoverLogs({})).toMatchObject({ status: "proposed" });
    const line = proposed(r, RECOVER_LINE);
    const his = r.his(line);
    expect(await r.link.recoverLogs({ said: his.id })).toMatchObject({ status: "ok" });
    const nonce = line.split(" ")[2];

    // The keeper takes it on its next round, the remote still away: his line's use is committed locally.
    writeFileSync(recoverFile(k.cfg), readFileSync(r.recoverFile));
    cycle(k.cfg);
    expect(existsSync(recoverFile(k.cfg))).toBe(false);
    expect(k.kept().recovered).toContain(his.id);
    expect(localLog(k)).toContain(`Owner-Line: recover ${nonce}`);
    expect(status(k).consumed_unverified).toBeDefined();              // still recoverable: held, not refused
    expect(k.outcome("cain-r15-held")).toBeNull();

    // The remote back: the rebuild completes, the held request is decided, and the trailer is on the remote.
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).consumed_unverified).toBeUndefined();
    expect(k.states("cain-r15-held")).toEqual(["done"]);
    k.pull();
    expect(k.g("log", "--format=%B", "-12")).toContain(`Owner-Line: recover ${nonce}`);
    expect(status(k).used_lines).toContain(nonce);
    // And the history's copy of it, rebuilt after another restart, still names it used.
    forgetRebuild(k.cfg);
    k.cain({ id: "cain-r15-1", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).used_lines).toContain(nonce);
  }, 60_000);

  test("a crash loop: proposed, the link restarts, his old code gets one line with the cause and a fresh code, and the fresh one counts", async () => {
    const r = shipRig();
    await r.link.recoverLogs({});
    const old = proposed(r, RECOVER_LINE);
    r.restart();
    await r.link.sweep();                                              // round 16: this start's mark in his DM
    const before = r.cards().length;
    const out = await r.link.recoverLogs({ said: r.his(old).id });
    expect(out).toMatchObject({ status: "proposed" });
    expect(out.said).toContain("the App restarted after it sent that code");
    const told = r.cards().slice(before).filter((m: any) => String(m.content).includes("Your recover line didn't count: the App restarted after it sent that code"));
    expect(told).toHaveLength(1);
    const fresh = proposed(r, RECOVER_LINE);
    expect(fresh).not.toBe(old);
    expect(existsSync(r.recoverFile)).toBe(false);                     // the old code did nothing
    // The old code read back again never counts: another fresh code, never ok.
    expect(await r.link.recoverLogs({ said: r.his(old).id })).toMatchObject({ status: "proposed" });
    const latest = proposed(r, RECOVER_LINE);
    expect(await r.link.recoverLogs({ said: r.his(latest).id })).toMatchObject({ status: "ok" });
    expect(JSON.parse(readFileSync(r.recoverFile, "utf8"))).toMatchObject({ nonce: latest.split(" ")[2] });
  });

  test("another epoch, or a code used already: the cause named and a fresh code; a made-up code is still refused", async () => {
    const r = shipRig();
    await r.link.recoverLogs({});
    const line = proposed(r, RECOVER_LINE);
    r.files.status = JSON.stringify({ epoch: { n: 2, at: "x", generation: 1 } });
    const e = await r.link.recoverLogs({ said: r.his(line).id });
    expect(e).toMatchObject({ status: "proposed" });
    expect(e.said).toContain("Cain's record was reset after the App sent that code");
    const next = proposed(r, RECOVER_LINE);
    expect(await r.link.recoverLogs({ said: r.his(next).id })).toMatchObject({ status: "ok" });
    const used = await r.link.recoverLogs({ said: r.his(next).id });
    expect(used).toMatchObject({ status: "proposed" });
    expect(used.said).toContain("that code was used already");
    await expect(r.link.recoverLogs({ said: r.his(`${RECOVER_LINE} b12345`).id })).rejects.toThrow("isn't one the App proposed");
  });
});

describe("2. a Ship tap while the consumed set is unverified: a line on the card, cleared once verified, nothing kept", () => {
  test("the line goes on at once, the buttons stay, and it is cleared once the keeper verifies; a Ship tap after acts once", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    unverified(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: record unverified");
    expect(r.msg(id).content).toContain(SHIP_CHECKING);
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    expect(r.github.landings).toHaveLength(0);
    expect(Object.values(r.state().taps ?? {}).some((t: any) => t.msg === id)).toBe(false);
    expect(existsSync(side(r, "link-held.log"))).toBe(false);
    await r.link.sweep();
    expect(r.msg(id).content).toContain(SHIP_CHECKING);              // still checking: the line stays
    verified(r);
    await r.link.sweep();
    expect(r.msg(id).content).not.toContain(SHIP_CHECKING);
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
  });

  test("a restart while it waits: the card keeps the line, no tap is recorded; cleared once verified, then a tap acts once", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.restart();
    await r.link.sweep();
    expect(r.msg(id).content).toContain(SHIP_CHECKING);
    expect(Object.values(r.state().taps ?? {}).some((t: any) => t.msg === id)).toBe(false);
    expect(r.relayed.some((x) => x.includes(`Dane tapped "Ship"`))).toBe(false);
    verified(r);
    await r.link.sweep();
    expect(r.msg(id).content).not.toContain(SHIP_CHECKING);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
  });
});

describe("3. a held tap's time is Discord's", () => {
  // The card's expiry E; Discord's time of his tap (the interaction id) and the link's skewed clock.
  const heldAt = async (link: number, discord: number) => {
    const r = shipRig();
    const id = await askCard(r);
    const E = r.state().messages[id].expires!;
    r.t.now = E + link;
    unverified(r);
    const out = await r.tap(structuredClone(r.msg(id)), r.ids(id)[0], { id: r.snowflake(E + discord) });
    return { r, id, E, out };
  };

  test("the link's clock ahead, within the tolerance: judged by the snowflake, so it acts", async () => {
    const { r, out } = await heldAt(-10_000, -100_000);               // the link says 10 s before expiry, Discord 100 s before
    expect(out).toBe("held");
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
  });

  test("the link's clock behind, within the tolerance: the snowflake says after the expiry, so it is not acted", async () => {
    const { r, id, out } = await heldAt(-60_000, 30_000);              // the link says a minute before expiry, Discord 30 s after
    expect(out).toBe("held");
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(0);
    expect(onThread(r, id, TAP_EXPIRED)).toHaveLength(1);
  });

  test("the clocks apart beyond the tolerance: round 16 judges it by Discord's time alone, so it acts, and the card says the Pi's clock is off", async () => {
    const { r, id, out } = await heldAt(-10 * MIN, -10 * MIN - CLOCK_TOLERANCE_MS - 60_000);
    expect(out).toBe("held");
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
    expect(onThread(r, id, TAP_TIME_DISAGREE)).toHaveLength(0);
    expect(onThread(r, id, clockOffLine(CLOCK_TOLERANCE_MS + 60_000))).toHaveLength(1);
  });

  test("the keeper: Discord's time, no earlier than its own hold start, and refused with a quoted line when the clocks disagree", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime();
    const sf = (ms: number) => String(((BigInt(ms) - 1420070400000n) << 22n) + 7n);
    k.cain({ id: "cain-k3-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);                               // its hold began at `at` and ended
    const exp = at + 10 * MIN;
    const key = (kid: string, msg: string) => ({ t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp });
    const cases: [string, number, number][] = [
      ["tap-00000000c301", exp + 60_000, exp - 30_000],                // the link says after expiry, Discord before: acts
      ["tap-00000000c302", exp - 60_000, exp + 30_000],                // the link says before, Discord after: expired
      ["tap-00000000c303", exp - 5 * MIN, exp - 5 * MIN + 3 * MIN],    // three minutes apart: round 16, judged by Discord's time: acts
    ];
    const state: any = { messages: {}, issued: {} };
    cases.forEach(([kid, linkAt, discordAt], i) => {
      const msg = sf(at + i);                                          // round 16: the card's post, by Discord's time
      appendLog(linkLog(k), key(kid, msg));
      state.issued[kid] = { item: "P11", kind: "ask", label: "Filed", msg, at: linkAt };
      appendLog(linkHeldFile(k.cfg), { t: "held", kid, msg, at: linkAt, it: sf(discordAt) });
    });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(state));
    k.at(new Date(at + 60 * MIN));
    cases.forEach(([kid], i) => k.cain({ id: `cain-k3-${i + 1}`, tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false }));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-k3-1") ?? "").not.toContain("expired");
    expect(k.reason("cain-k3-2")).toContain("had expired when he tapped it");
    expect(k.reason("cain-k3-3") ?? "").not.toContain("expired");
    expect(k.reason("cain-k3-3") ?? "").not.toContain("can't be judged");
    expect(readConsumed(k.cfg).has("tap-00000000c303")).toBe(true);
    expect((status(k).tap_notices ?? []).some((n: any) => n.why === "time")).toBe(false);
  }, 60_000);

  test("round 16: a keeper restart during the hold no longer moves its floor: the tap Discord dates before expiry acts", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime();
    const sf = (ms: number) => String(((BigInt(ms) - 1420070400000n) << 22n) + 9n);
    k.cain({ id: "cain-k4-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    // The keeper restarts at +20 minutes with the remote away: its hold starts then.
    k.at(new Date(at + 20 * MIN));
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain({ id: "cain-k4-1", ops: [{ op: "note", item: "P44", text: "another round" }] });
    cycle(k.cfg);
    remoteBack(k);
    // A held tap whose record claims +5 minutes on both clocks, for a card that expired at +10.
    const card = sf(at);
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000c401", item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + 10 * MIN });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { "tap-00000000c401": { item: "P11", kind: "ask", label: "Filed", msg: card, at: at + 5 * MIN } } }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: "tap-00000000c401", msg: card, at: at + 5 * MIN, it: sf(at + 5 * MIN) });
    k.cain({ id: "cain-k4-2", tap: "tap-00000000c401", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-k4-2") ?? "").not.toContain("expired");
    expect(k.states("cain-k4-2")).toEqual(["done"]);
  }, 60_000);

  test("the keeper's time notice reaches the card", async () => {
    const r = shipRig();
    const id = await askCard(r);
    const kid = logged(r).find((x) => x.t === "key" && x.msg === id)!.kid;
    verified(r, { tap_notices: [{ tap: kid, why: "time", msg: id, reason: "x", at: "2026-11-11T13:00:00.000Z" }] });
    await r.link.sweep();
    expect(onThread(r, id, TAP_TIME_DISAGREE)).toHaveLength(1);
  });

  test("round 16: his owner line dated ahead of the App's clock beyond the tolerance still counts, and he is told the Pi's clock is off", async () => {
    const r = shipRig({ installTaps: false });
    writeFileSync(r.installResults, JSON.stringify({ head: "b".repeat(40),
      smoke: { pass: true, at: new Date(r.t.now - DAY).toISOString() }, resilience: { pass: true, at: new Date(r.t.now - DAY / 2).toISOString() } }));
    r.keeperVerified();                                                // round 16: install-on waits for a verified keeper
    await r.link.installTaps({ how: "on" });
    const line = proposed(r, INSTALL_LINE);
    r.t.now += CLOCK_TOLERANCE_MS + MIN;
    const ahead = r.his(line);                                         // Discord's time for it, ahead of...
    r.t.now -= CLOCK_TOLERANCE_MS + MIN;                               // ...the App's clock
    r.keeperVerified();
    const out = await r.link.installTaps({ how: "on", said: ahead.id });
    expect(out).toMatchObject({ status: "ok" });
    expect(out.said).toContain("The Pi's clock is off by about");
    expect(r.cards().some((m: any) => String(m.content).startsWith("The Pi's clock is off by about 3 minutes"))).toBe(true);
  });
});

describe("4. no card is re-armed at a start until the consumed set is verified", () => {
  test("the remote down at a restart, a key consumed only on the remote: never any buttons; a clean card gets them after verification", async () => {
    const r = shipRig();
    const a = await unarmedAsk(r);
    // One ask is open at a time, so the clean card is a Ship card whose buttons also didn't go on.
    r.failing.add(`PATCH /channels/${DM}/messages/`);
    const b = await shipCard(r);
    r.failing.clear();
    expect(r.buttons(b)).toEqual([]);
    const consumed = side(r, "record-taps.jsonl");
    r.deps.consumedLog = consumed;
    unverified(r);
    r.restart();
    const from = r.calls.length;
    await r.link.sweep();
    await r.link.sweep();
    for (const id of [a, b]) {
      expect(r.buttons(id)).toEqual([]);
      expect(r.msg(id).content).toContain(CARD_CHECKING);
    }
    // The remote returns: the keeper's fetch merges a's consumption, and says verified.
    appendLog(consumed, { tap: logged(r).find((x) => x.t === "key" && x.msg === a)!.kid, id: "cain-on-the-remote", at: "x" });
    verified(r);
    await r.link.sweep();
    expect(armedEdits(r, a, from)).toHaveLength(0);
    expect(r.buttons(a)).toEqual([]);
    expect(r.msg(a).content).toContain(CARD_WITHDRAWN);
    expect(r.msg(a).content).not.toContain(CARD_CHECKING);
    expect(r.buttons(b)).toEqual(["Ship", "Not now"]);
    expect(r.msg(b).content).not.toContain(CARD_CHECKING);
    await r.tap(structuredClone(r.msg(b)), r.ids(b)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
  });

  test("a missing or unreadable keeper status is not verified: the card waits", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    r.files.status = undefined as any;
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    r.files.status = "{not json";
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    verified(r);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
  });
});

describe("5. a held tap's release is marked before its relay", () => {
  const heldOne = async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
    verified(r);
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    expect(tapLines(r)).toHaveLength(1);
    expect(readLog<any>(side(r, "link-held.log")).records.map((x) => x.t)).toEqual(["held", "releasing"]);
    return { r, id };
  };

  test("relayed, a crash before its released record, a restart: the second line is flagged as a replay, then nothing more", async () => {
    const { r } = await heldOne();
    r.restart();
    verified(r);                                                       // round 16: verified for the new link run
    await r.link.sweep();
    const lines = tapLines(r);
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("Replay")).toBe(false);
    expect(lines[1].startsWith("Replay of held tap key")).toBe(true);
    r.restart();
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(2);
  });

  test("the same, with the keeper already acting on its key: dropped and logged, at most one line", async () => {
    const { r } = await heldOne();
    const kid = readLog<any>(side(r, "link-held.log")).records[0].kid;
    const consumed = side(r, "record-taps.jsonl");
    appendLog(consumed, { tap: kid, id: "cain-acted", at: "x" });
    r.deps.consumedLog = consumed;
    r.restart();
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
    expect(r.logs.some((l) => l.includes(`held tap ${kid}: its release was cut off, and the record keeper already acted on its key`))).toBe(true);
  });
});

describe("6. the post-restore sweep pages back to the card horizon", () => {
  test("a lost card behind 150 newer messages is found; one past 100 days is never read; once per detected restore", async () => {
    const r = shipRig();
    await r.link.sweep();
    const st0 = r.state(), log0 = readFileSync(r.issuedLog!);
    const ancient = await askCard(r, "P41");                           // past the horizon by the sweep's time
    r.t.now += 101 * DAY;
    const lost = await askCard(r);
    for (let i = 0; i < 150; i++) r.his(`message ${i}`);
    r.setState(st0);
    writeFileSync(r.issuedLog!, log0);
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    const reads0 = r.reads();
    await r.link.sweep();
    const pages = r.reads() - reads0;
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(r.buttons(lost)).toEqual([]);
    expect(r.msg(lost).content).toContain(CARD_LOST_RESTORE);
    expect(r.buttons(ancient)).toEqual(["Filed", "Not filed"]);     // older than 100 days: left to the tap path
    await r.link.sweep();
    expect(r.reads() - reads0).toBe(pages);
  });
});

describe("7. the known gap: a consumption committed only locally, then a whole-image restore", () => {
  test("known gap: the remote down, a tap consumed locally, copy, ledger and keeper state restored to an older snapshot: a re-tap acts again", () => {
    const k = keeperRig();
    k.cain({ id: "cain-g0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const snap = join(k.root, "snap");
    const files = [k.cfg.holds!, tapsLogFile(k.cfg), issuedMirrorFile(k.cfg), linkLog(k), join(k.root, "pi/link/state.json")];
    const dirs = [k.cfg.dir, k.cfg.queue, k.cfg.outcomes];             // the copy, and the keeper's queue and outcomes: the whole image
    mkdirSync(snap);
    files.forEach((f, i) => { if (existsSync(f)) cpSync(f, join(snap, String(i))); });
    dirs.forEach((d, i) => { if (existsSync(d)) cpSync(d, join(snap, `d${i}`), { recursive: true }); });
    const T = "tap-00000000c701";
    remoteDown(k);
    k.cain(shipTake("cain-gap-1", T));
    cycle(k.cfg);
    expect(localLog(k)).toContain(`Tap-Key: ${T}`);                  // consumed, but only in the local copy
    files.forEach((f, i) => { rmSync(f, { force: true }); if (existsSync(join(snap, String(i)))) cpSync(join(snap, String(i)), f); });
    dirs.forEach((d, i) => { rmSync(d, { recursive: true, force: true }); if (existsSync(join(snap, `d${i}`))) cpSync(join(snap, `d${i}`), d, { recursive: true }); else mkdirSync(d, { recursive: true }); });
    forgetRebuild(k.cfg);
    remoteBack(k);
    k.issue(T, { item: "P33", kind: "ship", label: "Ship" });         // his card survived on Discord
    k.cain(shipTake("cain-gap-2", T), { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    // The current behaviour, pinned: exactly-once holds only for consumptions that reached the remote.
    expect(k.states("cain-gap-2")).toEqual(["done"]);
  }, 60_000);
});

describe("8. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md"), sh2 = flat("../rootfs/opt/cain/keeper.sh");
    for (const t of ["recover line works whatever state", "a fresh code at once", "Not taken yet", "interaction id", "2 minutes",
      "hold start the keeper itself saw", "until the keeper's status says its consumed set is verified", "releasing", "flagged as a replay",
      "pages back to the 100-day card horizon", "a restore that isn't detected sweeps nothing", "known gap", "reached the remote",
      "recover line under a degraded start with the remote unreachable"]) expect(docs).toContain(t);
    for (const t of ["Replay of held tap key", "a fresh code", "Not taken yet"]) expect(rules).toContain(t);
    expect(sh2).toContain("a fresh code at once");
    for (const t of ["Not taken yet", "fresh code", "known gap"]) expect(log).toContain(t);
  });
});
