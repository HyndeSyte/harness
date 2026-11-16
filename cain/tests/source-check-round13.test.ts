// Source checks, thirteenth review round (0.12.0): the interactions among the twelfth round's additions.
// A card's buttons go on only after its keys and its record are durable; a high-water shortfall is a
// detected restore that starts the keeper degraded and rebuilds, never a refusal that bricks it; with
// the record remote down the rebuild holds tap-derived requests and hand settles; install taps live in a
// keeper-owned log and turn on only through the owner's own line; whole-image restores and expiry are
// told plainly; a key is looked up again before it is judged missing; a card whose record can't be saved
// is withdrawn.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, readLog, syncSpy, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import { installState } from "../rootfs/opt/cain/installflag.ts";
import { CARD_BUTTONS_LATE, CARD_BUTTONS_ON, CARD_UNISSUABLE, CARD_WITHDRAWN, EXPIRED, INSTALL_LINE, INSTALL_WAIT, KEEPER_UNVERIFIED, RECOVER_LINE,
  settleForm, TAP_EXPIRED, TAP_RESTORE_LOST, tapKid } from "../rootfs/opt/cain/link/core";
import { cycle, installLogFile, issuedMirrorFile, readConsumed, recoverFile, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, MIN, PR, SHA1, SHA2, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; syncSpy.on = null; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const WORDS = "Stop stays within reach of your newest message.";

type R = ReturnType<typeof linkRig>;
const shipRig = (o: Parameters<typeof linkRig>[0] = {}) => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []), ...o });
let checks = 0;
const shipCard = async (r: R, head = SHA1) =>
  (await r.link.ship({ item: "P41", pr: PR, head, text: WORDS, checked: `the pull request on GitHub, open at that head, read at 8 (${++checks})` }) as any).message as string;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: `the county portal, read at 8 (${++checks})` }) as any).message as string;
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const logged = (r: R) => readLog<any>(r.issuedLog!, { repair: false }).records;
const posted = (r: R, text: string) => r.cards().find((m: any) => String(m.content).includes(text)) as any;
// A tap on a card as Discord sends it, with the custom id the issued-key log has for its first button.
const tapFromLog = (r: R, msg: string) => {
  const cid = logged(r).find((x) => x.t === "key" && x.msg === msg)!.cid;
  return r.tap({ ...structuredClone(r.msg(msg)), components: [{ type: 1, components: [{ type: 2, label: "Filed", custom_id: cid }] }] }, cid);
};
const landedLines = (r: R) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`) && (x.includes("The link landed it") || x.includes("It is already in main")));
const passResults = (r: R, head = "b".repeat(40)) => writeFileSync(r.installResults, JSON.stringify({ head,
  smoke: { pass: true, at: new Date(r.t.now - DAY).toISOString() }, resilience: { pass: true, at: new Date(r.t.now - DAY / 2).toISOString() } }));

// The keeper's link files (the rig's /data): its state and its issued-key log.
const linkState = (k: ReturnType<typeof keeperRig>, st: Record<string, unknown>) => writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, ...st }));
const linkLog = (k: ReturnType<typeof keeperRig>) => join(k.root, "pi/link-issued.log");
const ASK = (msg: string) => ({ item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] } });
const shipTake = (id: string, tap: string) => ({ id, tap, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
const queued = (k: ReturnType<typeof keeperRig>) => readdirSync(k.cfg.queue).filter((n) => n.endsWith(".json"));
const status = (k: ReturnType<typeof keeperRig>) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const remoteDown = (k: ReturnType<typeof keeperRig>) => renameSync(k.remote, `${k.remote}.away`);
const remoteBack = (k: ReturnType<typeof keeperRig>) => renameSync(`${k.remote}.away`, k.remote);

describe("1. issuance: posted without buttons, keys logged, state saved, then the buttons", () => {
  test("in that order, each step durable before the next", async () => {
    const r = shipRig();
    const seen: any[] = [];
    r.spy.onCall = (method, path) => {
      if (method === "PATCH" && path.startsWith(`/channels/${DM}/messages/`)) {
        const id = path.split("/").at(-1)!;
        seen.push({ keys: logged(r).filter((x) => x.t === "key" && x.msg === id).length, saved: !!r.state().messages[id], armed: logged(r).some((x) => x.t === "armed" && x.msg === id) });
      }
    };
    const id = await askCard(r);
    const post = r.calls.find((c) => c.method === "POST" && c.path === `/channels/${DM}/messages` && String(c.body.content).includes("packet"))!;
    expect(post.body.components).toBeUndefined();
    expect(seen[0]).toEqual({ keys: 2, saved: true, armed: false });
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(logged(r).filter((x) => x.msg === id).map((x) => x.t)).toEqual(["key", "key", "armed"]);
    expect(logged(r).find((x) => x.t === "key" && x.msg === id)).toMatchObject({ cid: r.ids(id)[0], exp: r.state().messages[id].expires });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
  });

  test("a crash between the post and the log write: the card never has buttons, and the same ask puts them on once", async () => {
    const r = shipRig();
    r.crash.at = "issue:after-post";
    await expect(askCard(r)).rejects.toThrow("crash injected");
    const card = posted(r, "packet");
    expect(r.buttons(card.id)).toEqual([]);
    expect(logged(r).some((x) => x.msg === card.id)).toBe(false);
    r.restart();
    await r.link.sweep();
    expect(r.buttons(card.id)).toEqual([]);
    const again = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1" }) as any;
    expect(again.message).toBe(card.id);                              // Discord's nonce gave back the same card
    expect(r.buttons(card.id)).toEqual(["Filed", "Not filed"]);
    expect(logged(r).filter((x) => x.t === "key" && x.msg === card.id)).toHaveLength(2);
  });

  test("a crash between the log write and the state save: voided at the next start, and a tap on it is told withdrawn", async () => {
    const r = shipRig();
    r.crash.at = "issue:after-log";
    await expect(askCard(r)).rejects.toThrow("crash injected");
    const card = posted(r, "packet");
    expect(r.buttons(card.id)).toEqual([]);
    r.restart();
    await r.link.sweep();
    expect(logged(r).some((x) => x.t === "void" && x.msg === card.id)).toBe(true);
    expect(r.msg(card.id).content).toContain(CARD_WITHDRAWN);
    expect(await tapFromLog(r, card.id)).toContain("withdrawn");
    expect(r.ephemerals().some((e: any) => e.content === CARD_WITHDRAWN)).toBe(true);
    expect(r.relayed.some((x) => x.includes("Dane tapped"))).toBe(false);
  });

  test("a crash between the state save and the button edit: the buttons go on from the log at the next start", async () => {
    const r = shipRig();
    r.crash.at = "issue:after-save";
    await expect(askCard(r)).rejects.toThrow("crash injected");
    const card = posted(r, "packet");
    expect(r.buttons(card.id)).toEqual([]);
    r.restart();
    await r.link.sweep();
    expect(r.buttons(card.id)).toEqual(["Filed", "Not filed"]);
    expect(logged(r).some((x) => x.t === "armed" && x.msg === card.id)).toBe(true);
    expect(await r.tap(structuredClone(r.msg(card.id)), r.ids(card.id)[0])).toBe("to Cain");
  });

  test("a failed button edit: told on the card, retried from the log at the next start, told again once they're on", async () => {
    const r = shipRig();
    await r.link.sweep();                                             // this run's start is behind it
    r.failing.add(`PATCH /channels/${DM}/messages/`);
    const id = await askCard(r);
    r.failing.clear();
    expect(r.buttons(id)).toEqual([]);
    expect(r.state().messages[id].unarmed).toBe(true);
    expect(onThread(r, id, CARD_BUTTONS_LATE)).toHaveLength(1);
    await r.link.sweep();                                             // the same run: not before a start
    expect(r.buttons(id)).toEqual([]);
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(onThread(r, id, CARD_BUTTONS_ON)).toHaveLength(1);
    expect(r.state().messages[id].unarmed).toBeUndefined();
    r.restart();
    await r.link.sweep();
    expect(onThread(r, id, CARD_BUTTONS_ON)).toHaveLength(1);
  });

  test("a log write that fails: no buttons ever, and the card says so", async () => {
    const r = shipRig({ issuedLog: mkdtempSync(join(tmpdir(), "issued-dir-")) });
    await expect(askCard(r)).rejects.toThrow("issued-key log");
    const card = posted(r, "packet");
    expect(r.buttons(card.id)).toEqual([]);
    expect(r.msg(card.id).content).toContain(CARD_UNISSUABLE);
    expect(r.calls.some((c) => c.method === "PATCH" && c.body?.components?.length)).toBe(false);
  });
});

describe("7. a card whose state save fails after its keys were logged is withdrawn", () => {
  test("a void record, no buttons, a withdrawn line; a later tap is told withdrawn; the keeper refuses its key without using it up", async () => {
    const r = shipRig();
    r.deps.crashPoint = (w: string) => { if (w === "issue:after-log") r.disk.failSaves = 1; };
    await expect(askCard(r)).rejects.toThrow("withdrawn");
    const card = posted(r, "packet");
    expect(logged(r).filter((x) => x.msg === card.id).map((x) => x.t)).toEqual(["key", "key", "void"]);
    expect(r.buttons(card.id)).toEqual([]);
    expect(r.msg(card.id).content).toContain(CARD_WITHDRAWN);
    expect(r.state().messages[card.id]).toBeUndefined();
    await tapFromLog(r, card.id);
    expect(r.ephemerals().some((e: any) => e.content === CARD_WITHDRAWN)).toBe(true);
    // The keeper: the key is the withdrawn card's.
    const k = keeperRig();
    const kid = logged(r).find((x) => x.t === "key" && x.msg === card.id)!.kid;
    for (const x of logged(r)) appendLog(linkLog(k), x);
    k.cain({ id: "cain-void-7", tap: kid, ops: [{ op: "row-close", item: "P08", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-void-7")).toContain("from a card the link withdrew");
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 30_000);
});

describe("2. the high-water refusal never bricks the keeper", () => {
  const consumedOnce = () => {
    const k = keeperRig();
    k.cain(shipTake("cain-ship-a", "tap-00000000a131"));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().logHigh.consumed).toBe(1);
    return k;
  };
  test("a torn tail: truncated, the start goes on, nothing rebuilt", () => {
    const k = consumedOnce();
    appendFileSync(tapsLogFile(k.cfg), "40:0000");
    k.cain({ id: "cain-t2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().rebuild).toBeUndefined();
    expect(k.states("cain-t2")).toEqual(["done"]);
  }, 30_000);

  test("a missing log: a degraded start that rebuilds from the remote's trailers; the consumed key is still refused", () => {
    const k = consumedOnce();
    rmSync(tapsLogFile(k.cfg));
    k.cain(shipTake("cain-again-m", "tap-00000000a131"), { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.relayed()).toContain("detected a restore");
    expect(k.relayed()).toContain("rebuild is complete");
    expect(k.reason("cain-again-m")).toContain("was already acted on by request cain-ship-a");
    expect(k.kept().rebuild).toBeUndefined();
    expect(k.kept().logHigh.consumed).toBe(1);
  }, 30_000);

  test("a partial restore, the state older than the logs: nothing lost, the counts move up", () => {
    const k = consumedOnce();
    const older = readFileSync(k.cfg.holds!, "utf8");
    k.cain(shipTake("cain-ship-b", "tap-00000000a132"));
    expect(cycle(k.cfg).ok).toBe(true);
    writeFileSync(k.cfg.holds!, older);                              // state from before the second tap; logs as they are
    k.cain({ ...shipTake("cain-again-b", "tap-00000000a132") }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-again-b")).toContain("was already acted on by request cain-ship-b");
    expect(k.kept().rebuild).toBeUndefined();
    expect(k.kept().logHigh.consumed).toBe(2);
  }, 30_000);

  test("a partial restore, the logs older than the state: detected and rebuilt", () => {
    const k = consumedOnce();
    const older = readFileSync(tapsLogFile(k.cfg));
    k.cain(shipTake("cain-ship-c", "tap-00000000a133"));
    expect(cycle(k.cfg).ok).toBe(true);
    writeFileSync(tapsLogFile(k.cfg), older);                         // the log from before the second tap
    k.cain({ ...shipTake("cain-again-c", "tap-00000000a133") }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.relayed()).toContain("holds 1 records, fewer than the 2");
    expect(k.reason("cain-again-c")).toContain("was already acted on by request cain-ship-c");
    expect(readConsumed(k.cfg).get("tap-00000000a133")).toBe("cain-ship-c");
  }, 30_000);

  test("the whole image wiped: state, logs, mirror and copy; rebuilt from the remote before any tap counts", () => {
    const k = consumedOnce();
    for (const f of [k.cfg.holds!, tapsLogFile(k.cfg), issuedMirrorFile(k.cfg), installLogFile(k.cfg)]) rmSync(f, { force: true });
    rmSync(k.cfg.dir, { recursive: true, force: true });
    k.cain({ ...shipTake("cain-again-w", "tap-00000000a131") }, { issue: false });
    k.cain({ ...shipTake("cain-fresh-w", "tap-00000000a134") });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-again-w")).toContain("was already acted on by request cain-ship-a");
    expect(k.states("cain-fresh-w")).toEqual(["done"]);
  }, 30_000);

  test("a case no rule explains refuses, until his recover-logs line accepts a verified rebuild", () => {
    const k = consumedOnce();
    rmSync(tapsLogFile(k.cfg));
    mkdirSync(tapsLogFile(k.cfg));                                    // a folder where the log was: unreadable
    k.cain({ id: "cain-r-x", ops: [{ op: "note", item: "P44", text: "a round" }] });
    const out: any = cycle(k.cfg);
    expect(out.refused).toContain("can't be read");
    expect(k.relayed()).toContain(`he sends exactly "${RECOVER_LINE}"`);
    expect(k.relayed()).toContain("keeper.sh recover-logs --said");
    // An old line doesn't count; a fresh one does, once.
    writeFileSync(recoverFile(k.cfg), JSON.stringify({ said: "1570000000000000951", at: new Date(k.cfg.now!().getTime() - 2 * DAY).toISOString() }));
    expect((cycle(k.cfg) as any).refused).toBeDefined();
    writeFileSync(recoverFile(k.cfg), JSON.stringify({ said: "1570000000000000952", at: k.cfg.now!().toISOString() }));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(existsSync(recoverFile(k.cfg))).toBe(false);
    expect(k.kept().recovered).toEqual(["1570000000000000952"]);
    expect(readConsumed(k.cfg).get("tap-00000000a131")).toBe("cain-ship-a");
    expect(k.states("cain-r-x")).toEqual(["done"]);
  }, 30_000);

  test("a new log's directory is fsynced with it; the count follows the fsynced records", () => {
    const seen: string[] = [];
    syncSpy.on = (w) => seen.push(w);
    const dir = mkdtempSync(join(tmpdir(), "applog13-")), f = join(dir, "x.log");
    appendLog(f, { a: 1 });
    appendLog(f, { a: 2 });
    expect(seen).toEqual([`file ${f}`, `dir ${dir}`, `file ${f}`]);
    const k = consumedOnce();
    expect(k.kept().logHigh).toEqual({ consumed: readLog(tapsLogFile(k.cfg)).records.length, issued: readLog(issuedMirrorFile(k.cfg)).records.length, install: 0 });
  }, 30_000);
});

describe("3. the rebuild with the record remote unreachable", () => {
  test("after a wipe with the remote down: no tap counts, asks go on; once it returns a consumed key is refused and a fresh one acts once", () => {
    const k = keeperRig();
    k.cain(shipTake("cain-ship-d", "tap-00000000a141"));
    expect(cycle(k.cfg).ok).toBe(true);
    for (const f of [k.cfg.holds!, tapsLogFile(k.cfg), issuedMirrorFile(k.cfg)]) rmSync(f, { force: true });
    remoteDown(k);
    k.cain({ ...shipTake("cain-again-d", "tap-00000000a141") }, { issue: false });
    k.cain({ ...shipTake("cain-fresh-d", "tap-00000000a142") });
    k.cain({ id: "link-check-p44-13", summary: "check", ops: [{ op: "check", item: "P44", text: "the specialist's log, read at 8", row: null, version: 0 }] });
    cycle(k.cfg);
    cycle(k.cfg);
    expect(queued(k)).toHaveLength(3);                                 // nothing leaves the queue before a push lands
    expect(k.outcome("cain-again-d")).toBeNull();
    expect(k.outcome("cain-fresh-d")).toBeNull();
    expect(k.outcome("link-check-p44-13")?.state).toBe("done");       // the ask's check went on
    expect(k.relayed().split(" / ").filter((x) => x.startsWith("Pending: your request cain-fresh-d"))).toHaveLength(1);
    expect(status(k).consumed_unverified).toMatchObject({ tries: 2 });
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).consumed_unverified).toBeUndefined();
    expect(k.reason("cain-again-d")).toContain("was already acted on by request cain-ship-d");
    expect(k.states("cain-fresh-d")).toEqual(["done"]);
    expect(queued(k)).toHaveLength(0);
    k.cain({ ...shipTake("cain-fresh-d2", "tap-00000000a142") }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-fresh-d2")).toContain("was already acted on by request cain-fresh-d");
  }, 60_000);

  test("the copy wiped too: the keeper waits for the remote, and nothing is taken meanwhile", () => {
    const k = keeperRig();
    k.cain(shipTake("cain-ship-e", "tap-00000000a151"));
    expect(cycle(k.cfg).ok).toBe(true);
    for (const f of [k.cfg.holds!, tapsLogFile(k.cfg), issuedMirrorFile(k.cfg)]) rmSync(f, { force: true });
    rmSync(k.cfg.dir, { recursive: true, force: true });
    remoteDown(k);
    k.cain({ ...shipTake("cain-again-e", "tap-00000000a151") }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(false);
    expect(queued(k)).toHaveLength(1);
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-again-e")).toContain("was already acted on by request cain-ship-e");
  }, 60_000);

  test("the link holds a hand settle and tells him once per outage", async () => {
    const r = shipRig();
    r.files.status = JSON.stringify({ consumed_unverified: { since: "2026-11-11T13:00:00.000Z", why: "its log of consumed tap keys is missing", tries: 0 } });
    expect(await r.link.settleKey({ tap: "tap-0123456789ab", how: "landed", said: r.his(settleForm("tap-0123456789ab", "landed")).id })).toMatchObject({ status: "pending" });
    await r.link.sweep();
    expect(r.cards().filter((m: any) => m.content === KEEPER_UNVERIFIED)).toHaveLength(0);   // not before a round has tried
    r.files.status = JSON.stringify({ consumed_unverified: { since: "2026-11-11T13:00:00.000Z", why: "x", tries: 1 } });
    await r.link.sweep();
    await r.link.sweep();
    expect(r.cards().filter((m: any) => String(m.content).startsWith(KEEPER_UNVERIFIED))).toHaveLength(1);
    expect((r.link.clockReport() as any).consumed_unverified).toMatchObject({ tries: 1 });
  });
});

describe("4. install taps: a keeper-owned log, and his own line", () => {
  test("on proposes; only his exact line, with a passing result file, turns it on, once per message", async () => {
    const r = shipRig({ installTaps: false });
    await expect(r.link.installTaps({ how: "on" })).rejects.toThrow("result file isn't there yet");
    passResults(r);
    expect(await r.link.installTaps({ how: "on" })).toMatchObject({ status: "proposed", install_taps: "off" });
    // Round 14: the line carries the proposal's code.
    const line = /```\n(install taps on [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().find((m: any) => String(m.content).includes("install taps on"))!.content))![1];
    const wrong = r.his("install taps please");
    await expect(r.link.installTaps({ how: "on", said: wrong.id })).rejects.toThrow(`doesn't say exactly "${INSTALL_LINE} <the code`);
    const his = r.his("`" + line.replace("install", "Install") + "`");
    expect(await r.link.installTaps({ how: "on", said: his.id })).toMatchObject({ status: "ok", install_taps: "on" });
    expect(r.landLedger.owner).toEqual([expect.objectContaining({ kind: "install", said: his.id })]);
    expect(installState(r.installLog)).toMatchObject({ how: "on", head: "b".repeat(40) });
    expect((r.link.clockReport() as any).install_taps).toBe("on");
    await r.link.installTaps({ how: "off" });
    await expect(r.link.installTaps({ how: "on", said: his.id })).rejects.toThrow("used already");
    expect((r.link.clockReport() as any).install_taps).toBe("off");
  });

  test("a result file that doesn't pass keeps it off", async () => {
    const r = shipRig({ installTaps: false });
    writeFileSync(r.installResults, JSON.stringify({ head: "b".repeat(40), smoke: { pass: true, at: new Date(r.t.now).toISOString() }, resilience: { pass: false } }));
    await expect(r.link.installTaps({ how: "on", said: r.his(INSTALL_LINE).id })).rejects.toThrow("resilience run passed");
    passResults(r);
    writeFileSync(r.installResults, JSON.stringify({ head: "b".repeat(40), smoke: { pass: true, at: new Date(r.t.now - 9 * DAY).toISOString() }, resilience: { pass: true, at: new Date(r.t.now).toISOString() } }));
    await expect(r.link.installTaps({ how: "on", said: r.his(INSTALL_LINE).id })).rejects.toThrow("over 7 days old");
    expect(installState(r.installLog).how).toBe("off");
  });

  test("missing, corrupt or unreadable reads as off; on only from the owner's record", () => {
    const dir = mkdtempSync(join(tmpdir(), "install13-")), f = join(dir, "i.log");
    expect(installState(f).how).toBe("off");
    writeLogForTest(f, [{ t: "flag", how: "on", by: "cain", at: "x" }]);
    expect(installState(f).how).toBe("off");
    writeLogForTest(f, [{ t: "flag", how: "on", by: "owner", said: "1", head: "c".repeat(40), at: "x" }], "12:00000000:{}\n");
    expect(installState(f).how).toBe("off");                            // a damaged record
    expect(installState(dir).how).toBe("off");                          // unreadable
  });

  test("arm once, let it through, kill and restart during the landing, tap again: refused; the once use was logged before the ledger's claim", async () => {
    const r = shipRig({ installTaps: false });
    await r.link.installTaps({ how: "once" });
    const claim = r.deps.landings.claim;
    let usedAtClaim: string[] | null = null;
    r.deps.landings.claim = (k: string, w: any) => { usedAtClaim ??= installState(r.installLog).onceUsed; return claim(k, w); };
    const id = await shipCard(r);
    r.github.hold = true;
    void r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await wait(10);
    expect(usedAtClaim).toHaveLength(1);
    r.restart();                                                        // killed during the landing
    r.go();
    await r.link.sweep();
    await r.link.whenLanded();
    const second = await shipCard(r, SHA2);
    expect(await r.tap(structuredClone(r.msg(second)), r.ids(second)[0])).toBe("refused: installs wait");
    expect(r.buttons(second)).toEqual(["Ship", "Not now"]);
    expect(r.github.landings.filter((l) => l.head === SHA2)).toHaveLength(0);
  });

  test("an image restore that loses install records leaves the flag off", () => {
    const k = keeperRig();
    const f = installLogFile(k.cfg);
    appendLog(f, { t: "flag", how: "on", by: "owner", said: "1570000000000000961", head: "d".repeat(40), at: "2026-11-11T13:00:00.000Z" });
    const older = readFileSync(f);
    appendLog(f, { t: "flag", how: "once", by: "cain", at: "2026-11-11T13:01:00.000Z" });
    k.cain({ id: "cain-i-1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().logHigh.install).toBe(2);
    writeFileSync(f, older);                                            // an older copy, saying on
    expect(installState(f).how).toBe("on");
    k.cain({ id: "cain-i-2", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(installState(f)).toMatchObject({ how: "off" });
    expect(readLog<any>(f).records.at(-1)).toMatchObject({ t: "flag", how: "off", by: "keeper" });
  }, 30_000);

  test("the once use is a trailer on the landing's take, and comes back from the history after a wipe", () => {
    const k = keeperRig();
    appendLog(installLogFile(k.cfg), { t: "flag", how: "once", by: "cain", at: "x" });
    appendLog(installLogFile(k.cfg), { t: "once-used", kid: "tap-00000000a161", at: "x" });
    k.cain(shipTake("cain-ship-o", "tap-00000000a161"));
    expect(cycle(k.cfg).ok).toBe(true);
    k.pull();
    expect(k.g("log", "--format=%B", "-5")).toContain("Install-Once: tap-00000000a161");
    rmSync(installLogFile(k.cfg));
    rmSync(k.cfg.holds!);
    k.cain({ id: "cain-o-2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(installState(installLogFile(k.cfg))).toMatchObject({ how: "off", onceUsed: ["tap-00000000a161"] });
  }, 30_000);
});

describe("5. whole-image restores and expiry", () => {
  test("both processes restored: a tap on a newer card the bot authored is told lost, not refused as unknown", async () => {
    const r = shipRig();
    await askCard(r);
    const state0 = r.state(), log0 = readFileSync(r.issuedLog!);
    const b = await shipCard(r);                                       // after the image was taken
    r.setState(state0);
    writeFileSync(r.issuedLog!, log0);
    r.restart();
    const out = await r.tap(structuredClone(r.msg(b)), r.ids(b)[0]);
    expect(out).toContain("lost to a restore");
    expect(onThread(r, b, TAP_RESTORE_LOST)).toHaveLength(1);
  });

  test("an older card: the keeper's mirror (or the remote's history) decides lost; with neither it isn't a card the link knows", async () => {
    const mirror = join(mkdtempSync(join(tmpdir(), "mirror13-")), "record-issued.log");
    const r = shipRig({ keeperMirror: mirror });
    const a = await askCard(r);
    const b = await shipCard(r);
    const st = r.state();
    delete st.messages[a];
    r.setState(st);
    writeFileSync(r.issuedLog!, "");
    r.restart();
    const card = structuredClone(r.msg(a)), cid = r.ids(a)[0];
    expect(await r.tap(structuredClone(card), cid)).toContain("not a card the link knows");
    appendLog(mirror, { t: "key", kid: "tap-00000000a171", msg: a, item: "P08", kind: "ask" });
    r.restart();
    const st2 = r.state(); delete st2.messages[a]; r.setState(st2);
    expect(await r.tap(structuredClone(card), cid)).toContain("lost to a restore");
    // The remote's history, through the keeper's status.
    const c = await shipCard(r, SHA2);
    const st3 = r.state(); delete st3.messages[c]; r.setState(st3);
    void b;
    r.files.status = JSON.stringify({ history_cards: [c] });
    // c is the newest card the state no longer knows; a's and b's message ids are older, so only the history says so here.
    expect(await r.tap(structuredClone(r.msg(c)), r.ids(c)[0])).toContain("lost to a restore");
  });

  test("the keeper writes the card's message id as a trailer and lists it for the link", () => {
    const k = keeperRig();
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000a181", ...ASK("1570000000000000781"), at: k.cfg.now!().getTime() });
    linkState(k, { issued: { "tap-00000000a181": ASK("1570000000000000781") } });
    k.cain({ id: "cain-card-5", tap: "tap-00000000a181", ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    k.pull();
    expect(k.g("log", "--format=%B", "-5")).toContain("Tap-Card: 1570000000000000781");
    expect(status(k).history_cards).toContain("1570000000000000781");
  }, 30_000);

  test("at expiry the buttons come off by message id, even on a card the state forgot; a late tap is told expired", async () => {
    const r = shipRig();
    await r.link.sweep();                                             // a state that has looked over the DM once
    const before = r.state();
    const id = await askCard(r);
    const exp = r.state().messages[id].expires!;
    r.setState(before);                                                 // the state forgot the card
    r.restart();
    r.t.now = exp + MIN;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain(EXPIRED);
    const index = readLog<any>(join(join(r.issuedLog!, ".."), "link-expired.log")).records;
    expect(index).toEqual([expect.objectContaining({ msg: id })]);      // one record per card, not per key
    const cid = logged(r).find((x) => x.t === "key" && x.msg === id)!.cid;
    await r.tap({ ...structuredClone(r.msg(id)), components: [{ type: 1, components: [{ type: 2, label: "Filed", custom_id: cid }] }] }, cid);
    expect(r.ephemerals().some((e: any) => e.content === TAP_EXPIRED)).toBe(true);
    await r.link.sweep();
    expect(readLog<any>(join(join(r.issuedLog!, ".."), "link-expired.log")).records).toHaveLength(1);
  });

  test("a card that expired through the state is indexed too", async () => {
    const r = shipRig();
    const id = await askCard(r);
    r.t.now = r.state().messages[id].expires! + MIN;
    await r.link.sweep();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(readLog<any>(join(join(r.issuedLog!, ".."), "link-expired.log")).records.map((x) => x.msg)).toEqual([id]);
  });

  test("a tombstone is forgotten with its key at 100 days, and listed as expired", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    r.github.hold = true;
    void r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await wait(10);
    r.restart();
    r.github.hold = false;
    r.github.readable = false;
    r.github.unreadableWhy = "GitHub couldn't be fetched from (ssh: connect to host github.com port 22: Connection timed out)";
    for (let i = 0; i < 25; i++) { r.later(5 * MIN); await r.link.sweep(); await r.link.whenLanded(); }
    const key = Object.keys(r.state().unresolved!)[0];
    const since = r.state().unresolved![key].since;
    r.t.now = since + 91 * DAY;
    await r.link.sweep();
    expect(r.state().tombstones?.[key]).toBeDefined();
    r.t.now = since + 100 * DAY + MIN;
    await r.link.sweep();
    expect(r.state().tombstones?.[key]).toBeUndefined();
    expect((r.link.clockReport() as any).expired_landings).toEqual([expect.objectContaining({ tap_key: tapKid(key) })]);
    expect(r.state().issued?.[tapKid(key)]).toBeUndefined();
    expect(r.relayed.filter((x) => x.startsWith("Landing expired:"))).toHaveLength(1);
  });
});

describe("6. a key that misses the mirror is looked up again before deciding", () => {
  test("a tap within one round of the card posting counts", () => {
    const k = keeperRig();
    const K = "tap-00000000a191";
    k.cain({ id: "cain-r6", ops: [{ op: "note", item: "P44", text: "a round first" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.cain({ id: "cain-quick-6", tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    // The card goes up, and is tapped, after this round read the link's files and before it decides.
    k.cfg.onItem = (id) => {
      if (id !== "cain-quick-6") return;
      appendLog(linkLog(k), { t: "key", kid: K, ...ASK("1570000000000000791"), at: k.cfg.now!().getTime() });
      linkState(k, { issued: { [K]: ASK("1570000000000000791") } });
    };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-quick-6")).toEqual(["done"]);
  }, 30_000);
});

describe("recover-logs on the link", () => {
  test("his exact line, single use, written to the ledger and the keeper's recover file", async () => {
    const r = shipRig();
    await expect(r.link.recoverLogs({ said: r.his("recover the logs").id })).rejects.toThrow(`doesn't say exactly "${RECOVER_LINE} <the code`);
    expect(await r.link.recoverLogs({})).toMatchObject({ status: "proposed" });
    const line = /```\n(recover logs [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().find((m: any) => String(m.content).includes("recover logs"))!.content))![1];
    const his = r.his(line.replace("recover", "Recover"));
    expect(await r.link.recoverLogs({ said: his.id })).toMatchObject({ status: "ok" });
    expect(JSON.parse(readFileSync(r.recoverFile, "utf8"))).toMatchObject({ said: his.id, nonce: line.split(" ")[2] });
    expect(r.landLedger.owner).toEqual([expect.objectContaining({ kind: "recover", said: his.id })]);
    await expect(r.link.recoverLogs({ said: his.id })).rejects.toThrow("used already");
  });
});

describe("8. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md"), sh = flat("../rootfs/opt/cain/keeper.sh");
    for (const t of ["posted without buttons", "degraded", "keeper.sh recover-logs", "consumed_unverified", "record-install.log", "install taps on",
      "install-tests.json", "link-expired.log", "100 days", "combined fault scenario"]) expect(docs).toContain(t);
    expect(docs).toContain("pull request 21 and pull request 23 also bump this App's version; pull request 20 lands first and this rebases onto it, regenerating the fixture");
    expect(docs).toContain("nothing to set up beyond the smoke test's one option change");
    for (const t of ["keeper.sh install-taps on --said", "recover logs", "withdrawn", "Pending: your request"]) expect(rules).toContain(t);
    expect(sh).toContain("keeper.sh recover-logs --said");
    expect(sh).toContain("recover-logs) url=");
    expect(log).toContain("withdrawn");
  });
});
