// Source checks, fourteenth review round (0.12.0): the thirteenth round's additions made whole. A start's
// re-arm re-runs every arming check; the keeper's consumed set is rebuilt from every ref, the remote and the
// landing ledger, and is unverified at every start until a fresh fetch; held taps are durable and judged by
// their tap time; every hold and refusal path says so on the card; the keeper enforces expiry, removal edits
// are retried from a durable queue and a detected restore sweeps the bot's recent cards; his owner lines are
// bound to a fresh nonce and the keeper's epoch, and their uses are commit trailers.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLog, readLog } from "../rootfs/opt/cain/applog.ts";
import { CARD_LOST_RESTORE, CARD_WITHDRAWN, EXPIRED, INSTALL_LINE, KEEPER_START_WHY, KEEPER_UNVERIFIED, TAP_CONSUMED, TAP_EXPIRED, TAP_HELD,
  TAP_NOT_ACTED_CHANGED, TAP_RESTORE_LOST } from "../rootfs/opt/cain/link/core";
import { cycle, forgetRebuild, KEEPER_START_WHY as KEEPER_SIDE_WHY, issuedMirrorFile, linkHeldFile, readConsumed, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

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
const posted = (r: R, text: string) => r.cards().find((m: any) => String(m.content).includes(text)) as any;
const side = (r: R, name: string) => join(dirname(r.issuedLog!), name);
const tapFromLog = (r: R, msg: string) => {
  const cid = logged(r).find((x) => x.t === "key" && x.msg === msg)!.cid;
  return r.tap({ ...structuredClone(r.msg(msg)), components: [{ type: 1, components: [{ type: 2, label: "Filed", custom_id: cid }] }] }, cid);
};
const clock = (r: R) => ({ clock: { synced: true, source: "the rig", diagnostic: "", at: new Date(r.t.now).toISOString() } });
const unverified = (r: R, why = KEEPER_START_WHY, extra: Record<string, unknown> = {}) =>
  { r.files.status = JSON.stringify({ ...clock(r), consumed_unverified: { since: "2026-11-11T13:00:00.000Z", why, tries: 0 }, ...extra }); };
const verified = (r: R, extra: Record<string, unknown> = {}) => { r.files.status = JSON.stringify({ ...clock(r), ...extra }); };
const tapLines = (r: R) => r.relayed.filter((x) => x.includes("Dane tapped") && x.includes("Tap key"));
// A card whose button edit failed at its post: unarmed, for the next start to retry.
const unarmedAsk = async (r: R) => {
  await r.link.sweep();
  r.failing.add(`PATCH /channels/${DM}/messages/`);
  const id = await askCard(r);
  r.failing.clear();
  expect(r.buttons(id)).toEqual([]);
  expect(r.state().messages[id].unarmed).toBe(true);
  return id;
};

// The keeper's side.
const shipTake = (id: string, tap: string) => ({ id, tap, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
const queued = (k: K) => readdirSync(k.cfg.queue).filter((n) => n.endsWith(".json"));
const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const remoteDown = (k: K) => renameSync(k.remote, `${k.remote}.away`);
const remoteBack = (k: K) => renameSync(`${k.remote}.away`, k.remote);
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
// What the keeper's own copy logged for a request (its push may not have landed).
const localReason = (k: K, id: string) => {
  const d = join(k.cfg.dir, "log/requests");
  if (!existsSync(d)) return undefined;
  return readdirSync(d).sort().flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => o.id === id).at(-1)?.reason as string | undefined;
};

test("the keeper and the link name an ordinary start's unverified set the same way", () => {
  expect(KEEPER_SIDE_WHY).toBe(KEEPER_START_WHY);
});

describe("1. the start-time re-arm re-runs every arming check", () => {
  test("a failed state save followed by a failed void write, then a restart: no buttons, and a tap is refused as withdrawn", async () => {
    const r = shipRig();
    const log = r.issuedLog!;
    r.deps.crashPoint = (w: string) => {
      if (w !== "issue:after-log") return;
      r.disk.failSaves = 1;                                            // the state save fails...
      renameSync(log, `${log}.aside`); mkdirSync(log);                 // ...and so does the void record's append
    };
    await expect(askCard(r)).rejects.toThrow("withdrawn");
    rmSync(log, { recursive: true }); renameSync(`${log}.aside`, log);
    const card = posted(r, "packet");
    expect(logged(r).filter((x) => x.msg === card.id).map((x) => x.t)).toEqual(["key", "key"]);   // no void record
    expect(r.buttons(card.id)).toEqual([]);
    expect(r.msg(card.id).content).toContain(CARD_WITHDRAWN);
    r.deps.crashPoint = () => {};
    r.restart();
    await r.link.sweep();
    expect(logged(r).some((x) => x.t === "void" && x.msg === card.id)).toBe(true);
    expect(r.buttons(card.id)).toEqual([]);
    expect(await tapFromLog(r, card.id)).toContain("withdrawn");
    expect(r.msg(card.id).content).toContain(CARD_WITHDRAWN);
    expect(r.relayed.some((x) => x.includes("Dane tapped"))).toBe(false);
  });

  test("the same, tapped before any sweep: withdrawn at the tap, its void record written then", async () => {
    const r = shipRig();
    const log = r.issuedLog!;
    r.deps.crashPoint = (w: string) => { if (w === "issue:after-log") { r.disk.failSaves = 1; renameSync(log, `${log}.aside`); mkdirSync(log); } };
    await expect(askCard(r)).rejects.toThrow("withdrawn");
    rmSync(log, { recursive: true }); renameSync(`${log}.aside`, log);
    r.deps.crashPoint = () => {};
    r.restart();
    const card = posted(r, "packet");
    expect(await tapFromLog(r, card.id)).toContain("withdrawn");
    expect(logged(r).some((x) => x.t === "void" && x.msg === card.id)).toBe(true);
  });

  test("a restart past expiry: the Expired line instead of the buttons, and indexed", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    r.restart();
    r.t.now = r.state().messages[id].expires! + MIN;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain(EXPIRED);
    expect(logged(r).some((x) => x.t === "armed" && x.msg === id)).toBe(false);
    expect(readLog<any>(side(r, "link-expired.log")).records.map((x) => x.msg)).toContain(id);
  });

  test("a restart after a version bump: the Withdrawn line, a void record, and Cain told", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    const ledger = JSON.parse(r.files.checks!);
    ledger.P08.version = 2;                                            // the row changed since its check
    r.files.checks = JSON.stringify(ledger);
    verified(r);                                                       // round 15: re-arm waits for a verified consumed set
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain(CARD_WITHDRAWN);
    expect(logged(r).some((x) => x.t === "void" && x.msg === id)).toBe(true);
    expect(r.relayed.some((x) => x.includes("was withdrawn at the App's start"))).toBe(true);
    expect(await tapFromLog(r, id)).toMatch(/dead|withdrawn/);
    expect(tapLines(r)).toHaveLength(0);
  });

  test("its record is saved again before the retried edit; a save that fails withdraws it instead", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    verified(r);                                                       // round 15: re-arm waits for a verified consumed set
    r.restart();
    r.disk.failSaves = 1;
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain(CARD_WITHDRAWN);
    expect(logged(r).some((x) => x.t === "void" && x.msg === id)).toBe(true);
  });

  test("a key the keeper consumed already: withdrawn, never armed", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    const consumed = side(r, "record-taps.jsonl");
    appendLog(consumed, { tap: logged(r).find((x) => x.t === "key" && x.msg === id)!.kid, id: "cain-earlier", at: "x" });
    r.deps.consumedLog = consumed;
    verified(r);                                                       // round 15: re-arm waits for a verified consumed set
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain(CARD_WITHDRAWN);
  });

  test("all checks pass: armed, as before", async () => {
    const r = shipRig();
    const id = await unarmedAsk(r);
    verified(r);                                                       // round 15: re-arm waits for a verified consumed set
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(r.state().messages[id].rearmed).toBe(r.t.now);
  });
});

describe("2. the consumed set: every ref, the remote and the landing ledger; unverified at every start", () => {
  test("keeper state removed, the mirror kept, one tap committed locally but not pushed: a re-tap is refused", () => {
    const k = keeperRig();
    const T = "tap-00000000b201";
    writeFileSync(join(k.root, "pi/record-block-push"), String(k.cfg.now!().getTime() + 30 * DAY));   // every push fails
    k.cain(shipTake("cain-ship-l", T));
    cycle(k.cfg);
    expect(k.g("log", "--format=%B", "-3")).not.toContain(T);       // not on the remote (the seed is its clone)
    k.pull();
    expect(k.g("log", "--format=%B", "-3")).not.toContain(`Tap-Key: ${T}`);
    rmSync(k.cfg.holds!); rmSync(tapsLogFile(k.cfg));               // the keeper's state, its consumed log with it
    expect(existsSync(issuedMirrorFile(k.cfg))).toBe(true);
    forgetRebuild(k.cfg);                                            // a restart
    k.cain(shipTake("cain-again-l", T), { issue: false });
    cycle(k.cfg);
    expect(localReason(k, "cain-again-l")).toContain("was already acted on by request cain-ship-l");
    expect(readConsumed(k.cfg).get(T)).toBe("cain-ship-l");
  }, 60_000);

  test("a consistent older snapshot (issued log, keeper state, link state, copy) restored together: a key consumed after it is refused, and held until a fresh fetch", () => {
    const k = keeperRig();
    k.cain({ id: "cain-s0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const snap = join(k.root, "snap");
    const files = [k.cfg.holds!, tapsLogFile(k.cfg), issuedMirrorFile(k.cfg), linkLog(k), join(k.root, "pi/link/state.json")];
    mkdirSync(snap);
    files.forEach((f, i) => { if (existsSync(f)) cpSync(f, join(snap, String(i))); });
    cpSync(k.cfg.dir, join(snap, "copy"), { recursive: true });
    const T = "tap-00000000b202";
    k.cain(shipTake("cain-ship-s", T));
    expect(cycle(k.cfg).ok).toBe(true);
    files.forEach((f, i) => { rmSync(f, { force: true }); if (existsSync(join(snap, String(i)))) cpSync(join(snap, String(i)), f); });
    rmSync(k.cfg.dir, { recursive: true, force: true });
    cpSync(join(snap, "copy"), k.cfg.dir, { recursive: true });
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.issue(T, { item: "P33", kind: "ship", label: "Ship" });       // the card is still up on Discord
    k.cain(shipTake("cain-again-s", T), { issue: false });
    cycle(k.cfg);
    expect(queued(k)).toHaveLength(1);                               // held: nothing decided before a fetch
    expect(status(k).consumed_unverified).toMatchObject({ why: KEEPER_START_WHY });
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).consumed_unverified).toBeUndefined();
    expect(k.reason("cain-again-s")).toContain("was already acted on by request cain-ship-s");
  }, 60_000);

  test("a key the landing ledger shows started counts as consumed; its Ship take still goes once", () => {
    const k = keeperRig();
    const key = `1570000000000000201|1|cain-check|P33|Ship`;
    const kid = `tap-${new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 12)}`;
    const dir = join(k.root, "pi/record-landings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 32)}.json`), JSON.stringify({ key, pr: PR, head: SHA1, at: "2026-11-11T13:00:00.000Z" }));
    k.cain({ id: "cain-l0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readConsumed(k.cfg).get(kid)).toBe("the link's landing ledger (its landing started)");
    k.cain(shipTake("cain-ship-g", kid));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-g")).toEqual(["done"]);
    k.cain(shipTake("cain-ship-g2", kid), { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-ship-g2")).toContain("was already acted on by request cain-ship-g");
  }, 60_000);
});

describe("3. the held queue is durable and judged by tap time", () => {
  test("remote down, tap, kill both the link and the keeper, restart, remote returns: the tap acts exactly once", async () => {
    // The link: held in its log before the card says so, kept across a restart, released once.
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("held");
    const held = readLog<any>(side(r, "link-held.log")).records;
    expect(held).toEqual([expect.objectContaining({ t: "held", msg: id, label: "Filed", item: "P08", version: 1, at: r.t.now })]);
    expect(tapLines(r)).toHaveLength(0);
    r.restart();                                                       // the link killed
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(0);
    verified(r);                                                       // the remote is back: the keeper verified
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
    expect(tapLines(r)[0]).toContain(held[0].kid);
    r.restart();
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);

    // The keeper: Cain's request from that tap, held across a kill, acts once when the remote returns.
    const k = keeperRig();
    k.cain({ id: "cain-h0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain(shipTake("cain-held-1", "tap-00000000b301"));
    cycle(k.cfg);
    forgetRebuild(k.cfg);                                            // the keeper killed
    cycle(k.cfg);
    expect(queued(k)).toHaveLength(1);
    expect(k.outcome("cain-held-1")).toBeNull();
    remoteBack(k);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-held-1")).toEqual(["done"]);
    k.cain(shipTake("cain-held-2", "tap-00000000b301"), { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-held-2")).toContain("was already acted on by request cain-held-1");
  }, 60_000);

  test("a held tap whose row changed before its release is told on the card as not acted", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const ledger = JSON.parse(r.files.checks!);
    ledger.P08.version = 2;
    r.files.checks = JSON.stringify(ledger);
    verified(r);
    await r.link.sweep();
    expect(onThread(r, id, TAP_NOT_ACTED_CHANGED)).toHaveLength(1);
    expect(r.relayed.some((x) => x.startsWith("Tap not acted:") && x.includes("P08 changed after his tap"))).toBe(true);
    expect(tapLines(r)).toHaveLength(0);
    await r.link.sweep();
    expect(onThread(r, id, TAP_NOT_ACTED_CHANGED)).toHaveLength(1);
  });

  test("released after the card's expiry: judged by its tap time, so it acts", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    r.t.now = r.state().messages[id].expires! + DAY;
    verified(r);
    await r.link.sweep();
    expect(tapLines(r)).toHaveLength(1);
  });

  test("the keeper judges a held tap by its tap time: before the expiry acts, after it is refused unused", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime();
    const ask = (kid: string, msg: string) => ({ t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + 10 * MIN });
    appendLog(linkLog(k), ask("tap-00000000b311", "1570000000000000311"));
    appendLog(linkLog(k), ask("tap-00000000b312", "1570000000000000312"));
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: {
      "tap-00000000b311": { item: "P11", kind: "ask", label: "Filed", msg: "1570000000000000311", at: at + MIN },
      "tap-00000000b312": { item: "P11", kind: "ask", label: "Filed", msg: "1570000000000000312", at: at + 20 * MIN } } }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: "tap-00000000b311", msg: "1570000000000000311", at: at + MIN });
    // Round 15: the keeper's own hold (a start with the remote down) begins before the taps.
    k.cain({ id: "cain-hold-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    forgetRebuild(k.cfg);
    remoteDown(k);
    k.cain({ id: "cain-hold-start", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    remoteBack(k);
    k.at(new Date(at + 60 * MIN));                                     // decided well after the expiry
    k.cain({ id: "cain-in-time", tap: "tap-00000000b311", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    k.cain({ id: "cain-too-late", tap: "tap-00000000b312", ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-in-time") ?? "").not.toContain("expired");
    expect(k.reason("cain-too-late")).toContain("had expired when he tapped it");
    expect(readConsumed(k.cfg).has("tap-00000000b312")).toBe(false);
    expect(status(k).tap_notices).toEqual(expect.arrayContaining([expect.objectContaining({ tap: "tap-00000000b312", why: "expired" })]));
  }, 60_000);
});

describe("4. every hold and refusal path says so on the card", () => {
  test("held: the card's line, its buttons off, and his outage notice at the first held tap", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toContain(TAP_HELD);
    expect(r.buttons(id)).toEqual([]);
    expect(r.cards().filter((m: any) => String(m.content).startsWith(KEEPER_UNVERIFIED))).toHaveLength(1);
    expect(await r.tap(structuredClone(r.msg(id)), "q:x:0")).toMatch(/refused|dead/);   // a stale retap
    await r.link.sweep();
    expect(r.cards().filter((m: any) => String(m.content).startsWith(KEEPER_UNVERIFIED))).toHaveLength(1);
  });

  test("withdrawn, expired, lost and consumed: each its own line on the card", async () => {
    // withdrawn
    const w = shipRig();
    w.deps.crashPoint = (x: string) => { if (x === "issue:after-log") w.disk.failSaves = 1; };
    await expect(askCard(w)).rejects.toThrow("withdrawn");
    const wc = posted(w, "packet");
    await tapFromLog(w, wc.id);
    expect(w.msg(wc.id).content).toContain(CARD_WITHDRAWN);
    // expired (the state forgot the card)
    const e = shipRig();
    await e.link.sweep();
    const before = e.state();
    const ec = await askCard(e);
    const exp = e.state().messages[ec].expires!;
    e.setState(before);
    e.restart();
    e.t.now = exp + MIN;
    expect(await e.tap(structuredClone(e.msg(ec)), e.ids(ec)[0])).toContain("expired");
    expect(e.msg(ec).content).toContain(TAP_EXPIRED);
    // lost (the state restored from before the card)
    const l = shipRig();
    await shipCard(l);
    const st0 = l.state();
    const lc = await askCard(l);
    l.setState(st0);
    l.restart();
    expect(await l.tap(structuredClone(l.msg(lc)), l.ids(lc)[0])).toContain("lost to a restore");
    expect(l.msg(lc).content).toContain(TAP_RESTORE_LOST);
    // consumed (the keeper acted on the key; this state forgot the tap)
    const c = shipRig();
    const cc = await askCard(c);
    const consumed = side(c, "record-taps.jsonl");
    appendLog(consumed, { tap: logged(c).find((x) => x.t === "key" && x.msg === cc)!.kid, id: "cain-earlier", at: "x" });
    c.deps.consumedLog = consumed;
    c.restart();
    expect(await c.tap(structuredClone(c.msg(cc)), c.ids(cc)[0])).toContain("consumed");
    expect(c.msg(cc).content).toContain(TAP_CONSUMED);
    expect(c.ephemerals().some((x: any) => x.content === TAP_CONSUMED)).toBe(true);
    expect(tapLines(c)).toHaveLength(0);
  });
});

describe("5. expiry enforced by the keeper; removal edits retried; the post-restore sweep", () => {
  test("a failed removal edit followed by a tap: told expired, the edit retried until it takes", async () => {
    const r = shipRig();
    await r.link.sweep();
    const before = r.state();
    const id = await askCard(r);
    const exp = r.state().messages[id].expires!;
    r.setState(before);
    r.restart();
    r.t.now = exp + MIN;
    r.failing.add(`PATCH /channels/${DM}/messages/`);
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);           // the edit failed: the buttons still show
    expect(readLog<any>(side(r, "link-strip.log")).records.map((x) => x.t)).toEqual(["strip"]);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toContain("expired");
    expect(r.ephemerals().some((x: any) => x.content === TAP_EXPIRED)).toBe(true);
    expect(tapLines(r)).toHaveLength(0);
    r.failing.clear();
    r.restart();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(readLog<any>(side(r, "link-strip.log")).records.map((x) => x.t)).toEqual(["strip", "done"]);
  });

  test("the keeper refuses a key tapped past its card's expiry without using it up", () => {
    const k = keeperRig();
    const at = k.cfg.now!().getTime();
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000b501", item: "P11", kind: "ask", label: "Filed", msg: "1570000000000000501",
      target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + MIN });
    k.at(new Date(at + 5 * MIN));
    k.cain({ id: "cain-late-5", tap: "tap-00000000b501", ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-late-5")).toContain("had expired when he tapped it");
    expect(readConsumed(k.cfg).has("tap-00000000b501")).toBe(false);
  }, 60_000);

  test("after a detected restore, the bot's recent cards the rebuilt sets don't know lose their buttons with the lost line", async () => {
    const r = shipRig();
    await shipCard(r);
    const st0 = r.state(), log0 = readFileSync(r.issuedLog!);
    const b = await askCard(r);                                        // after the image was taken
    r.setState(st0);
    writeFileSync(r.issuedLog!, log0);                                 // a whole-image restore: the log too
    unverified(r, "its log of consumed tap keys is missing");          // the keeper detected it
    r.restart();
    await r.link.sweep();
    expect(r.buttons(b)).toEqual([]);
    expect(r.msg(b).content).toContain(CARD_LOST_RESTORE);
    expect(r.relayed.some((x) => x.includes("weren't known any more"))).toBe(true);
  });

  test("a card a trailer names but past 100 days is told expired, not lost", async () => {
    const r = shipRig();
    const c = await askCard(r);
    r.setState({ ...r.state(), messages: {} });
    writeFileSync(r.issuedLog!, "");
    r.t.now += 101 * DAY;
    unverified(r, "its log of consumed tap keys is missing", { history_cards: [c] });
    r.restart();
    await r.link.sweep();
    expect(r.buttons(c)).toEqual([]);
    expect(r.msg(c).content).toContain(EXPIRED);
    expect(r.msg(c).content).not.toContain(CARD_LOST_RESTORE);
  });

  test("an ordinary start's unverified set is no restore: nothing is swept", async () => {
    const r = shipRig();
    await shipCard(r);
    const st0 = r.state();
    const b = await askCard(r);
    r.setState({ ...r.state(), messages: { ...st0.messages, [b]: r.state().messages[b] } });
    unverified(r);
    r.restart();
    await r.link.sweep();
    expect(r.buttons(b)).toEqual(["Filed", "Not filed"]);
  });
});

describe("6. his lines are bound to a nonce, the keeper's epoch and this start", () => {
  const passResults = (r: R) => writeFileSync(r.installResults, JSON.stringify({ head: "b".repeat(40),
    smoke: { pass: true, at: new Date(r.t.now - DAY).toISOString() }, resilience: { pass: true, at: new Date(r.t.now - DAY / 2).toISOString() } }));
  const propose = async (r: R) => {
    await r.link.installTaps({ how: "on" });
    return /```\n(install taps on [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().filter((m: any) => String(m.content).includes(INSTALL_LINE)).at(-1)!.content))![1];
  };

  test("arm, wipe and restore the ledger, resend the old line: refused", async () => {
    const r = shipRig({ installTaps: false });
    passResults(r);
    const line = await propose(r);
    expect(await r.link.installTaps({ how: "on", said: r.his(line).id })).toMatchObject({ status: "ok" });
    r.landLedger.owner.length = 0;                                     // the ledger wiped and restored from before
    await r.link.installTaps({ how: "off" });
    await expect(r.link.installTaps({ how: "on", said: r.his(line).id })).rejects.toThrow("was used already");
    // and after a restart, with the state's proposal list restored too: not proposed since this start
    const st = r.state();
    st.ownerProposals = st.ownerProposals!.map((p) => ({ ...p, used: undefined }));
    r.setState(st);
    r.restart();
    await expect(r.link.installTaps({ how: "on", said: r.his(line).id })).rejects.toThrow("before the App's current start");
  });

  test("a code the record's history shows used, another epoch, an old message or a made-up code: refused", async () => {
    const r = shipRig({ installTaps: false });
    passResults(r);
    const early = r.his("install taps on a00000");
    const line = await propose(r);
    const code = line.split(" ")[3];
    await expect(r.link.installTaps({ how: "on", said: r.his("install taps on b12345").id })).rejects.toThrow("isn't one the App proposed");
    await expect(r.link.installTaps({ how: "on", said: early.id })).rejects.toThrow("isn't one the App proposed");
    r.files.status = JSON.stringify({ epoch: { n: 3, at: "x", generation: 1 } });
    await expect(r.link.installTaps({ how: "on", said: r.his(line).id })).rejects.toThrow("record epoch 0");
    r.files.status = JSON.stringify({ used_lines: [code] });
    await expect(r.link.installTaps({ how: "on", said: r.his(line).id })).rejects.toThrow("as the record's history shows");
  });

  test("a line read from older history never counts: only a live message after the proposal", async () => {
    const r = shipRig({ installTaps: false });
    passResults(r);
    const line = await propose(r);
    const st = r.state();
    const p = st.ownerProposals!.at(-1)!;
    p.msg = r.snowflake(r.t.now + DAY);                                 // a proposal newer than his message
    r.setState(st);
    await expect(r.link.installTaps({ how: "on", said: r.his(line).id })).rejects.toThrow("isn't a live message sent after the proposal");
  });

  test("the keeper commits each use with an Owner-Line trailer and rebuilds the used lines from it", () => {
    const k = keeperRig();
    appendLog(join(k.root, "pi/record-install.log"), { t: "flag", how: "on", by: "owner", said: "1570000000000000601", nonce: "c0ffee", head: "d".repeat(40), at: "2026-11-11T13:00:00.000Z" });
    k.cain({ id: "cain-o6", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.pull();
    expect(k.g("log", "--format=%B", "-6")).toContain("Owner-Line: install c0ffee");
    expect(status(k).used_lines).toContain("c0ffee");
    rmSync(k.cfg.holds!);
    rmSync(join(k.root, "pi/record-install.log"));
    forgetRebuild(k.cfg);
    k.cain({ id: "cain-o6b", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).used_lines).toContain("c0ffee");
  }, 60_000);
});

describe("7. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md"), sh = flat("../rootfs/opt/cain/keeper.sh");
    for (const t of ["re-runs every arming check", "every ref", "landing ledger", "unverified until a fresh fetch", "link-held.log", "tap time",
      "link-strip.log", "lost in a restore", "install taps on <code>", "recover logs <code>", "Owner-Line", "power cut during issuance",
      "power cut during a landing", "over SSH with the remote unreachable"]) expect(docs).toContain(t);
    expect(docs).toContain("pull request 20, pull request 21 and pull request 23 also bump this App's version; pull request 20 lands first and this rebases onto it, regenerating the fixtures");
    for (const t of ["install taps on <code>", "recover logs <code>", "Held", "Tap not acted"]) expect(rules).toContain(t);
    expect(sh).toContain("keeper.sh recover-logs [--said");
    for (const t of ["held", "lost in a restore", "code"]) expect(log).toContain(t);
  });
});
