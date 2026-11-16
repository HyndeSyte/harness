// Source checks, seventeenth review round (0.12.0): defects in the sixteenth round's own additions, fixed. The
// hold's start is a Discord-stamped id in the held record, never the keeper's status time; a stale owner line
// always gets its fresh code (the Pi's clock line is information only); a link restart is verified by the
// keeper's next fresh fetch without a keeper restart, and a waiting line goes up when that waits on the remote; a
// card's expiry is its post snowflake plus the lifetime its key record carries; a line sent while the link was
// down that answers a proposal is answered once; the restore sweep's horizon is a snowflake; the arming re-checks
// are keyed to the verification tuple; the replay bound runs on the monotonic clock and supersedes the old key.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLog, readLog } from "../rootfs/opt/cain/applog.ts";
import { CARD_CHECKING, CARD_LOST_RESTORE, CARD_WITHDRAWN, clockOffLine, OFFLINE_CAUSE, OWNER_LINE_MS, RECOVER_LINE, REPLAY_WAIT_MS,
  SHIP_CHECKING, TAP_EXPIRED, TAP_REPLAY_AGAIN, TAP_SUPERSEDED, VERIFY_PENDING_MS, VERIFY_WAITING } from "../rootfs/opt/cain/link/core";
import { cycle, expirySf, linkHeldFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const WORDS = "Stop stays within reach of your newest message.";
const INVARIANTS = "../docs/source-check-invariants.md";

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
const unverified = (r: R, why = "the record keeper started, and its consumed set isn't checked against GitHub yet") =>
  { r.files.status = JSON.stringify({ ...clock(r), consumed_unverified: { since: new Date(r.t.now - MIN).toISOString(), why, tries: 0 } }); };
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
const kidOf = (r: R, id: string, i = 0) => logged(r).filter((x) => x.t === "key" && x.msg === id)[i].kid as string;
const sf = (ms: number, n = 7) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));

// The keeper's side.
const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const remoteDown = (k: K) => renameSync(k.remote, `${k.remote}.away`);
const remoteBack = (k: K) => renameSync(`${k.remote}.away`, k.remote);
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const linkRun = (k: K, nonce: string) => {
  const f = join(k.root, "pi/link/state.json");
  let j: any = { messages: {}, issued: {} };
  try { j = JSON.parse(readFileSync(f, "utf8")); } catch { /* none yet */ }
  writeFileSync(f, JSON.stringify({ ...j, run: (j.run ?? 2) + 1, runNonce: nonce }));
};

describe("1. the hold's start is a Discord-stamped id, never the keeper's status time (invariants: the held log)", () => {
  for (const [dir, off] of [["ahead", 5 * HOUR], ["behind", -5 * HOUR]] as const) {
    test(`the keeper, the Pi's clock hours ${dir}: a hold spanning the card's expiry acts; a hold that began after it does not`, () => {
      const k = keeperRig();
      const at = k.cfg.now!().getTime(), PI = at + off;                  // Discord's time, and the Pi's
      k.cain({ id: "cain-r17-1-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
      expect(cycle(k.cfg).ok).toBe(true);
      const card = sf(at);
      const state: any = { messages: {}, issued: {} };
      for (const [kid, holdAt] of [["tap-0000000e1001", at + 5 * MIN], ["tap-0000000e1002", at + 12 * MIN]] as const) {
        appendLog(linkLog(k), { t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg: card, target: { item: "P11", writes: ["row-close", "decision"] }, at: PI, exp: PI + 10 * MIN, life: 10 * MIN });
        state.issued[kid] = { item: "P11", kind: "ask", label: "Filed", msg: card, at: PI + 5 * MIN };
        // Both tapped at +5 minutes by Discord's times; the second's hold (its first held interaction) began at +12.
        appendLog(linkHeldFile(k.cfg), { t: "held", kid, msg: card, at: PI + 5 * MIN, it: sf(at + 5 * MIN, 9), hold: { period: `p-${kid}`, id: sf(holdAt, 8), from: "interaction" } });
      }
      writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(state));
      k.at(new Date(PI + 3 * HOUR));                                    // released hours after the card's expiry, by either clock
      k.cain({ id: "cain-r17-1-a", tap: "tap-0000000e1001", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
      k.cain({ id: "cain-r17-1-b", tap: "tap-0000000e1002", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
      expect(cycle(k.cfg).ok).toBe(true);
      expect(k.states("cain-r17-1-a")).toEqual(["done"]);
      expect(k.reason("cain-r17-1-b")).toContain("held across a restart");
      expect(status(k).tap_notices.find((n: any) => n.tap === "tap-0000000e1002")).toMatchObject({ why: "hold" });
    }, 60_000);

    test(`the link, the Pi's clock hours ${dir}: the held record carries the first held interaction's id, and a hold spanning expiry acts`, async () => {
      const r = shipRig();
      r.t.discord = -off;
      const id = await askCard(r);
      const E = r.state().messages[id].expires!;
      r.t.now = E - 10 * MIN;
      unverified(r);
      expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
      const h = readLog<any>(side(r, "link-held.log")).records[0];
      expect(h.hold).toEqual({ period: JSON.parse(r.files.status!).consumed_unverified.since, id: h.it, from: "interaction" });
      expect(JSON.stringify(h.hold)).not.toContain("since");
      r.t.now = E + 2 * HOUR;                                             // verified only long after the card's expiry
      r.keeperVerified();
      await r.link.sweep();
      expect(tapLines(r)).toHaveLength(1);
      expect(onThread(r, id, TAP_EXPIRED)).toHaveLength(0);
    });
  }
});

describe("2. a stale owner line always gets its fresh code; the Pi's clock line is information only (invariants: the link state)", () => {
  for (const off of [5 * HOUR, -5 * HOUR]) {
    test(`the Pi's clock ${off > 0 ? "behind" : "ahead"} by 5 hours, a line 31 minutes late by Discord's times: a fresh code, then accepted`, async () => {
      const r = shipRig();
      r.t.discord = off;
      await r.link.sweep();
      await r.link.recoverLogs({});
      const line = proposed(r, RECOVER_LINE);
      r.t.discord += OWNER_LINE_MS + MIN;                                 // Discord's time moves; the Pi's clock stands still
      const out = await r.link.recoverLogs({ said: r.his(line).id });
      expect(out).toMatchObject({ status: "proposed" });
      expect(r.cards().filter((m: any) => String(m.content).startsWith("Your recover line didn't count: by Discord's times"))).toHaveLength(1);
      expect(r.cards().filter((m: any) => /^The Pi's clock is off by about \d+ minutes/.test(String(m.content))).length).toBeGreaterThanOrEqual(1);
      const fresh = proposed(r, RECOVER_LINE);
      expect(fresh).not.toBe(line);
      r.t.discord += MIN;
      expect(await r.link.recoverLogs({ said: r.his(fresh).id })).toMatchObject({ status: "ok" });
      expect(existsSync(r.recoverFile)).toBe(true);
    });
  }
});

describe("3. a link restart is verified by the keeper's next fresh fetch, without a keeper restart (invariants: the keeper status, the link state)", () => {
  const setup = async () => {
    const k = keeperRig();
    const r = shipRig();
    await r.link.sweep();
    linkRun(k, r.state().runNonce!);
    expect(cycle(k.cfg).ok).toBe(true);
    const first = status(k);
    r.files.status = JSON.stringify(first);
    await r.link.sweep();
    expect((r.link.clockReport() as any).consumed_verified).toBe(true);
    const card = await unarmedAsk(r);                                     // a card whose buttons wait for the next start
    r.restart();
    await r.link.sweep();
    expect(r.msg(card).content).toContain(CARD_CHECKING);
    linkRun(k, r.state().runNonce!);                                      // the link's new run, in its state
    return { k, r, card, first };
  };

  test("the remote up: the keeper's next round verifies for the new link run, same keeper start, and the card arms", async () => {
    const { k, r, card, first } = await setup();
    expect(cycle(k.cfg).ok).toBe(true);
    const st = status(k);
    expect(st.start.nonce).toBe(first.start.nonce);                       // no keeper restart
    expect(st.verified).toMatchObject({ start: first.start.nonce, link: r.state().runNonce });
    expect(st.verify_pending).toBeUndefined();
    r.files.status = JSON.stringify(st);
    await r.link.sweep();
    expect(r.buttons(card)).toEqual(["Filed", "Not filed"]);
    expect(onThread(r, card, VERIFY_WAITING)).toHaveLength(0);
  }, 60_000);

  test("the remote away: pending in the status, one waiting line on the card after 5 minutes and Cain told once; verified when it returns", async () => {
    const { k, r, card, first } = await setup();
    remoteDown(k);
    cycle(k.cfg);
    const st = status(k);
    expect(st.verified.link).not.toBe(r.state().runNonce);
    expect(st.verify_pending).toMatchObject({ link: r.state().runNonce });
    r.files.status = JSON.stringify(st);
    await r.link.sweep();
    expect(onThread(r, card, VERIFY_WAITING)).toHaveLength(0);           // within the bound: nothing yet
    r.t.now += VERIFY_PENDING_MS + MIN;
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, card, VERIFY_WAITING)).toHaveLength(1);
    expect(r.relayed.filter((x) => x.startsWith("Verification for the link's new run is pending"))).toHaveLength(1);
    expect(r.buttons(card)).toEqual([]);
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    const ok = status(k);
    expect(ok.start.nonce).toBe(first.start.nonce);
    expect(ok.verified.link).toBe(r.state().runNonce);
    r.files.status = JSON.stringify(ok);
    await r.link.sweep();
    expect(r.buttons(card)).toEqual(["Filed", "Not filed"]);
  }, 60_000);

  test("the bound is the monotonic clock: a Pi clock step forward alone posts no waiting line", async () => {
    const { k, r, card } = await setup();
    remoteDown(k);
    cycle(k.cfg);
    r.files.status = JSON.stringify(status(k));
    r.t.mono = r.t.now;                                                   // from here the monotonic clock runs on its own
    await r.link.sweep();
    r.t.now += 2 * HOUR;                                                  // the Pi's clock steps; the monotonic clock doesn't
    await r.link.sweep();
    expect(onThread(r, card, VERIFY_WAITING)).toHaveLength(0);
    r.t.mono += VERIFY_PENDING_MS + 1;
    await r.link.sweep();
    expect(onThread(r, card, VERIFY_WAITING)).toHaveLength(1);
  }, 60_000);
});

describe("4. a card's expiry is its post snowflake plus the lifetime its key record carries (invariants: the issued-key log)", () => {
  for (const step of [2 * HOUR, -2 * HOUR]) for (const [when, d, acts] of [["just before", -MIN, true], ["just after", MIN, false]] as const) {
    test(`a clock step of ${step / HOUR} hours between the card's post and its key log; a tap ${when} the intended expiry`, async () => {
      const r = shipRig();
      await r.link.sweep();
      const T0 = r.t.now;
      // The Pi's clock steps the moment the card goes out (Discord's own time doesn't).
      r.spy.onCall = (method, path) => {
        if (method === "POST" && path === `/channels/${DM}/messages` && r.spy.onCall) { r.t.now += step; r.t.discord -= step; r.spy.onCall = null; }
      };
      const id = await askCard(r);
      const E = r.state().messages[id].expires!, life = E - T0;
      const key = logged(r).find((x) => x.t === "key" && x.msg === id);
      expect(key.life).toBe(life);
      expect(key.at - T0).toBe(step);                                       // the key log's reading is the stepped one
      expect(expirySf(key)).toBe(T0 + life);                                // the keeper's reading: post snowflake plus lifetime
      r.t.now = T0 + 5 * MIN;                                               // the Pi's clock back in step when he taps
      const out = await r.tap(structuredClone(r.msg(id)), r.ids(id)[0], { id: r.snowflake(T0 + life + d) });
      if (acts) { expect(out).toBe("to Cain"); expect(tapLines(r)).toHaveLength(1); }
      else { expect(out).toBe("dead: expired"); expect(tapLines(r)).toHaveLength(0); }
    });
  }
});

describe("5. a line sent while the link was down answers its proposal once, with a fresh code (invariants: the link state)", () => {
  test("sent during the downtime, a restart: told once that it arrived while the App was offline, a fresh code, then accepted", async () => {
    const r = shipRig();
    await r.link.sweep();
    await r.link.recoverLogs({});
    const line = proposed(r, RECOVER_LINE);
    r.t.now += 3 * MIN;
    const his = r.his(line);                                              // the link is down: nothing reads it now
    r.t.now += 2 * MIN;
    r.restart();
    await r.link.sweep();
    const posts = r.posts();
    const out = await r.link.recoverLogs({ said: his.id });
    expect(out).toMatchObject({ status: "proposed" });
    const told = r.cards().filter((m: any) => String(m.content).startsWith(`Your recover line didn't count: ${OFFLINE_CAUSE}`));
    expect(told).toHaveLength(1);
    expect(r.posts()).toBe(posts + 1);
    expect(existsSync(r.recoverFile)).toBe(false);                       // the old line never acts
    await expect(r.link.recoverLogs({ said: his.id })).rejects.toThrow("history, not a live line");   // told once
    expect(r.posts()).toBe(posts + 1);
    const fresh = proposed(r, RECOVER_LINE);
    expect(fresh).not.toBe(line);
    r.t.now += MIN;
    expect(await r.link.recoverLogs({ said: r.his(fresh).id })).toMatchObject({ status: "ok" });
    expect(existsSync(r.recoverFile)).toBe(true);
  });

  test("a history line with no matching proposal is still refused to Cain alone, nothing sent him", async () => {
    const r = shipRig();
    await r.link.sweep();
    const his = r.his(`${RECOVER_LINE} a00000`);
    r.restart();
    await r.link.sweep();
    const posts = r.posts();
    await expect(r.link.recoverLogs({ said: his.id })).rejects.toThrow("history, not a live line");
    expect(r.posts()).toBe(posts);
  });

  test("a history line past 30 minutes of its proposal by Discord's times is refused to Cain alone", async () => {
    const r = shipRig();
    await r.link.sweep();
    await r.link.recoverLogs({});
    const line = proposed(r, RECOVER_LINE);
    r.t.now += OWNER_LINE_MS + MIN;
    const his = r.his(line);
    r.restart();
    await r.link.sweep();
    const posts = r.posts();
    await expect(r.link.recoverLogs({ said: his.id })).rejects.toThrow("history, not a live line");
    expect(r.posts()).toBe(posts);
  });
});

describe("6. the restore sweep's horizon is a snowflake, and done is never written while the Pi's clock is off (invariants: the sweep cursor)", () => {
  test("the Pi's clock a year ahead still reads the full horizon; done waits until the clock is back in step", async () => {
    const r = shipRig();
    r.t.discord = -365 * DAY;                                             // the Pi a year ahead of Discord
    await r.link.sweep();
    const st0 = r.state(), log0 = readFileSync(r.issuedLog!);
    const lost = await askCard(r);
    for (let i = 0; i < 150; i++) r.his(`message ${i}`);
    r.setState(st0);
    writeFileSync(r.issuedLog!, log0);
    unverified(r, "its log of consumed tap keys is missing");
    r.restart();
    await r.link.notice("The calendar specialist is answering again.");  // a post: Discord's stamp flags the Pi's clock
    await r.link.sweep();
    expect(r.buttons(lost)).toEqual([]);
    expect(r.msg(lost).content).toContain(CARD_LOST_RESTORE);
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"))).toMatchObject({ done: false });
    // The Pi's clock back in step: the next start writes done.
    r.t.discord = 0;
    r.restart();
    await r.link.notice("The calendar specialist is answering again.");
    await r.link.sweep();
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8"))).toMatchObject({ done: true });
  });
});

describe("7. the arming re-checks are keyed to the verification tuple (invariants: the link state, the removal queue)", () => {
  test("a keeper restart between two verifications in one link run runs them again", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    r.keeperVerified();
    await r.link.sweep();
    const one = r.state().verifyChecked!;
    expect(one).toContain(JSON.parse(r.files.status!).start.nonce);
    expect(r.buttons(ship)).toEqual(["Ship", "Not now"]);
    // The key consumed on the remote; the keeper restarts and verifies again before the link sweeps.
    const consumed = side(r, "record-taps.jsonl");
    appendLog(consumed, { tap: kidOf(r, ship), id: "cain-on-the-remote", at: "x" });
    r.deps.consumedLog = consumed;
    r.keeperVerified();
    await r.link.sweep();
    expect(r.state().verifyChecked).not.toBe(one);
    expect(r.state().verifyChecked).toContain(JSON.parse(r.files.status!).start.nonce);
    expect(r.buttons(ship)).toEqual([]);
    expect(r.msg(ship).content).toContain(CARD_WITHDRAWN);
    expect(await r.tap(structuredClone(r.msg(ship)), "q:0000000000:0")).not.toBe("to Cain");
    expect(r.github.landings).toHaveLength(0);
  });

  test("a Ship card pending removal at verification counts as withdrawn: its line isn't cleared and nothing lands", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    expect(r.msg(ship).content).toContain(SHIP_CHECKING);
    appendLog(side(r, "link-strip.log"), { t: "strip", msg: ship, line: CARD_WITHDRAWN, at: r.t.now });
    r.failing.add(`PATCH /channels/${DM}/messages/${ship}`);            // its removal hasn't gone through yet
    r.keeperVerified();
    await r.link.sweep();
    expect(r.msg(ship).content).toContain(SHIP_CHECKING);                 // not cleared
    expect(r.state().messages[ship].outcome).toBe("expired");
    expect(logged(r).some((x) => x.t === "void" && x.msg === ship)).toBe(true);
    expect(await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0])).not.toBe("to Cain");
    r.failing.clear();
    await r.link.sweep();
    expect(r.buttons(ship)).toEqual([]);
    expect(r.msg(ship).content).toContain(CARD_WITHDRAWN);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
  });

  test("the status is re-read just before a clear: a tuple that changed leaves the card waiting", async () => {
    const r = shipRig();
    const ship = await shipCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    r.keeperVerified();
    // The keeper verifies again (a new start) between the re-checks and the clear: the read of the card before
    // its clear is where the status changes.
    r.spy.onCall = (method, path) => { if (method === "GET" && path === `/channels/${DM}/messages/${ship}` && r.spy.onCall) { r.spy.onCall = null; r.keeperVerified(); } };
    await r.link.sweep();
    expect(r.msg(ship).content).toContain(SHIP_CHECKING);
    await r.link.sweep();                                                  // checked again for the new tuple, then cleared
    expect(r.msg(ship).content).not.toContain(SHIP_CHECKING);
  });
});

describe("8. the replay bound is monotonic, and the prompt supersedes the old key (invariants: the held log, the issued-key log)", () => {
  test("a Pi clock step alone asks nothing; past 10 monotonic minutes the old key is superseded, and Cain acting after the prompt is refused with a line on the card", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.keeperVerified();
    r.crash.at = "held:after-relay";
    await expect(r.link.sweep()).rejects.toThrow("crash injected");
    r.restart();
    r.keeperVerified();
    r.t.mono = 5_000;
    await r.link.sweep();                                                 // the flagged replay
    r.t.now += DAY;                                                       // the Pi's clock steps a day: no prompt
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();
    const kid = kidOf(r, id);
    // Round 18: the line asking him again waits for the keeper's status to show the supersede mirrored.
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
    r.keeperVerified({ superseded: [kid] });
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(1);
    const sup = logged(r).findIndex((x) => x.t === "supersede" && x.kid === kid);
    expect(sup).toBeGreaterThan(-1);
    expect(r.relayed.some((x) => x.includes(`tap key ${kid} is superseded`))).toBe(true);

    // Cain acts after the prompt: the keeper, reading that issued-key log, refuses it without using it.
    const k = keeperRig();
    k.cain({ id: "cain-r17-8-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const key = logged(r).find((x) => x.t === "key" && x.kid === kid);
    appendLog(linkLog(k), key);
    appendLog(linkLog(k), logged(r)[sup]);
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: key.item, kind: key.kind, label: key.label, msg: id, at: key.at } } }));
    k.at(new Date(key.at + MIN));
    k.cain({ id: "cain-r17-8-1", tap: kid, ops: [{ op: "note", item: "P08", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r17-8-1")).toContain("superseded");
    const notice = status(k).tap_notices.find((n: any) => n.tap === kid);
    expect(notice).toMatchObject({ why: "superseded", msg: id });
    r.keeperVerified({ tap_notices: [notice] });
    await r.link.sweep();
    expect(onThread(r, id, TAP_SUPERSEDED)).toHaveLength(1);
  }, 60_000);
});

describe("9b. the keeper takes his recover line once, whatever the Pi's clock says (invariants: the recover file)", () => {
  test("a recover file dated two days off by the Pi's clock counts, once", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r17-9-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const f = join(k.root, "pi/record-recover.json");
    writeFileSync(f, JSON.stringify({ said: "1570000000000000977", nonce: "a12345", at: new Date(k.cfg.now!().getTime() - 2 * DAY).toISOString() }));
    k.cain({ id: "cain-r17-9-1", ops: [{ op: "note", item: "P44", text: "another round" }] });
    cycle(k.cfg);
    expect(k.kept().recovered).toContain("1570000000000000977");
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, JSON.stringify({ said: "1570000000000000977", nonce: "a12345", at: k.cfg.now!().toISOString() }));
    k.cain({ id: "cain-r17-9-2", ops: [{ op: "note", item: "P44", text: "a third round" }] });
    cycle(k.cfg);
    expect(k.kept().recovered.filter((x: string) => x === "1570000000000000977")).toHaveLength(1);
  }, 60_000);
});

describe("9. the invariant document, and the code against it", () => {
  const doc = () => readFileSync(join(import.meta.dir, INVARIANTS), "utf8");
  test("one row per durable store, with its writer, fsync point, rebuild source, what it decides and its clocks", () => {
    const d = doc();
    expect(d).toContain("| Store | File | Writer | fsync point | Rebuild after a restore | Decides | Clocks |");
    for (const f of ["/data/link-issued.log", "/data/link/state.json", "/data/link-held.log", "/data/link-strip.log", "/data/link-sweep.json",
      "/data/record-landings/", "/data/record-taps.jsonl", "/data/record-install.log", "Tap-Key", "/data/record-ledger.json", "/data/record-holds.json",
      "/data/record-issued.log", "/data/link-expired.log", "/data/record-recover.json"]) expect(d).toContain(f);
    // Every Pi wall-clock use says what it decides: when something is posted or how far to read, never whether.
    for (const line of d.split("\n").filter((l) => l.includes("Pi wall clock"))) expect(line).toMatch(/decides (only )?(nothing|when|how far|how long)/);
  });

  test("the code matches the rows it names", () => {
    const core = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/core.ts"), "utf8");
    const keeper = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    const pub = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/publish.ts"), "utf8");
    // The sweep cursor, the keeper's state and status: fsynced before the rename is relied on.
    expect(core).toMatch(/function writeDurable[\s\S]{0,200}fsyncSync\(fd\)[\s\S]{0,80}renameSync\(tmp, f\)/);
    expect(core).toMatch(/private saveCursor[\s\S]{0,600}writeDurable\(f, /);
    expect(core).toContain("try { writeDurable(this.d.recoverFile, ");
    // No whether decided by the Pi's clock: the settle line's age and the keeper's recover file.
    expect(core).not.toContain("this.d.now() - snowflakeTime(said) > DAY");
    expect(keeper).not.toContain("now - at > 86_400_000");
    expect(keeper).toMatch(/function writeAtomic[\s\S]{0,300}fsyncSync\(fd\)[\s\S]{0,80}renameSync\(tmp, file\);\s*syncDir/);
    // The link state's saves that are relied on: fsynced.
    // Round 18: every save is the durable one.
    expect(pub).toContain("save(s: State, _sync = false): void { this.saveDurable(s); }");
    for (const t of ["this.d.save(s, true);\n    try {\n      // Cain hears it", "replaced = record(s, { ...msg, components: comps });\n      this.d.save(s, true);"]) expect(core).toContain(t);
    // No status time in the held record; the keeper floors by the hold's id.
    expect(core).not.toContain("consumed_unverified?.since ?? ks?.start?.at");
    expect(keeper).toContain("snowflakeMs(r.hold.id)");
    // The replay bound and the pending-verification bound: the monotonic clock.
    expect(core).toContain("if (this.mono() - this.replaySeen.get(r.kid)! < REPLAY_WAIT_MS) continue;");
    expect(core).toContain("if (this.mono() - this.verifyPendingSince < VERIFY_PENDING_MS) return;");
    expect(core).not.toContain("this.d.now() - Number(r.at) < REPLAY_WAIT_MS");
    // The sweep's horizon: the start mark's snowflake time.
    expect(core).toContain("const horizon = (mark === \"0\" ? -Infinity : snowflakeTime(mark)) - TAP_ISSUED_KEEP_MS;");
  });
});

describe("10. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it, and point to the invariant document", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md"), sh2 = flat("../rootfs/opt/cain/keeper.sh");
    for (const t of ["source-check-invariants.md", "first held interaction", "information only", "verification for the new link run is pending",
      "post snowflake plus", "arrived while the App was offline", "start mark's time less 100 days", "verification tuple", "monotonic clock",
      "superseded", "a link restart with the remote away"]) expect(docs).toContain(t);
    for (const t of ["arrived while the App was offline", "superseded", "verification for the link's new run is pending"]) expect(rules).toContain(t);
    for (const t of ["verify_pending", "monotonic"]) expect(sh2).toContain(t);
    for (const t of ["while the App was offline", "restart of the App", "fixed when it goes out"]) expect(log).toContain(t);
  });
});
