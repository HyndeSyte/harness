// Source checks, twelfth review round (0.12.0): tap keys issued durably before a card can be tapped (and
// a tap lost to a restore of the link's state told on its own card), issued keys remembered for their
// whole life on both sides, the run counter fsynced before anything is issued, consumed keys rebuilt
// from the record's history after a whole-image restore, the hand settle in the ledger before any effect,
// settle messages forgiven their copying noise, a target mismatch that doesn't use the key up, tapered
// reminders, framed logs with torn records truncated and missing ones refused, and install taps behind
// a flag.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, frame, readLog, writeLogForTest } from "../rootfs/opt/cain/applog.ts";
import { INSTALL_WAIT, settleForm, settleNormalise, settleWordsProblem, TAP_REFUSED, TAP_RESTORE_LOST, TAP_ISSUED_KEEP_MS, tapKid,
  unresolvedReminder } from "../rootfs/opt/cain/link/core";
import { landingLedger, SETTLED_LOG } from "../rootfs/opt/cain/link/landings";
import { cycle, issuedMirrorFile, readConsumed, readIssued, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const CHECKED = "the pull request on GitHub, open at that head, read at 8";
const WORDS = "Stop stays within reach of your newest message.";

type R = ReturnType<typeof linkRig>;
const shipRig = (o: Parameters<typeof linkRig>[0] = {}) => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []), ...o });
let checks = 0;
const shipCard = async (r: R) =>
  (await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: WORDS, checked: `${CHECKED} (${++checks})` }) as any).message as string;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: `the county portal, read at 8 (${++checks})` }) as any).message as string;
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const shipLines = (r: R) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
const landedLines = (r: R) => shipLines(r).filter((x) => x.includes("The link landed it") || x.includes("It is already in main"));
const sweeps = async (r: R, n = 3, step = 5 * MIN) => { for (let i = 0; i < n; i++) { r.later(step); await r.link.sweep(); await r.link.whenLanded(); } };
const logged = (r: R) => readLog<any>(r.issuedLog!, { repair: false }).records;

// A Ship tap whose landing is claimed, cut off by a restart, and then can't be settled (GitHub down).
async function unresolved(r: R) {
  const id = await shipCard(r);
  r.github.hold = true;
  void r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
  await wait(10);
  r.restart();
  r.github.hold = false;
  r.github.readable = false;
  r.github.unreadableWhy = "GitHub couldn't be fetched from (ssh: connect to host github.com port 22: Connection timed out)";
  await sweeps(r, 1);
  await sweeps(r, 20, MIN);
  expect(r.relayed.filter((x) => x.startsWith("Landing unconfirmed:"))).toHaveLength(1);
  const key = [...r.landLedger.keys][0];
  return { id, key, kid: tapKid(key) };
}
// The keeper's link files (the rig's /data): its state and its issued-key log.
const linkState = (k: ReturnType<typeof keeperRig>, st: Record<string, unknown>) => writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, ...st }));
const linkLog = (k: ReturnType<typeof keeperRig>) => join(k.root, "pi/link-issued.log");
const ASK = (msg: string) => ({ item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] } });

describe("1. issuance is durable before the card can be tapped", () => {
  test("each button's key, target and card message id are logged, after the run's record, before the card is saved", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const recs = logged(r);
    expect(recs[0]).toMatchObject({ t: "run", run: r.state().run, nonce: r.state().runNonce });
    const keys = recs.filter((x) => x.t === "key" && x.msg === ask);
    expect(keys.map((x) => x.label)).toEqual(["Filed", "Not filed"]);
    expect(keys[0]).toMatchObject({ item: "P08", kind: "ask", target: { item: "P08", writes: ["row-close", "decision"] }, run: r.state().run });
    // The tap's key is the one logged for its button.
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const key = Object.keys(r.state().taps!)[0];
    expect(keys[0].kid).toBe(tapKid(key));
  });

  test("issue, restore the link's state, tap: the tap is told as lost with a line on its own card", async () => {
    const r = shipRig();
    await r.link.sweep();
    const older = r.state();                                          // the copy a restore brings back
    const ask = await askCard(r);
    r.setState(older);
    r.restart();
    const out = await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    expect(out).toContain("lost to a restore");
    expect(onThread(r, ask, TAP_RESTORE_LOST)).toHaveLength(1);
    expect(r.relayed.some((x) => x.includes(`Discord message ${ask}`) && x.includes("was lost"))).toBe(true);
    // A second tap tells nothing more.
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[1]);
    expect(onThread(r, ask, TAP_RESTORE_LOST)).toHaveLength(1);
  });

  test("a card whose keys can't be logged loses its buttons and is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issued-dir-"));
    const r = shipRig({ issuedLog: dir });                           // a folder: every append fails
    await expect(askCard(r)).rejects.toThrow("issued-key log");
    const card = r.cards().find((m: any) => String(m.content).includes("Is the packet filed?"))!;
    expect(r.buttons(card.id)).toEqual([]);
    expect(Object.values(r.state().messages).some((m) => m.q?.q?.includes("packet"))).toBe(false);
  });

  test("the keeper: a key in the link's log only is registered; one in the link's state but not the log is forged or stale", () => {
    const k = keeperRig();
    const K = "tap-00000000a101", F = "tap-00000000a102";
    appendLog(linkLog(k), { t: "key", kid: K, ...ASK("1570000000000000701"), at: k.cfg.now!().getTime() });
    linkState(k, { issued: { [K]: ASK("1570000000000000701"), [F]: ASK("1570000000000000702") } });
    k.cain({ id: "cain-real-1", tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    k.cain({ id: "cain-forged-1", tap: F, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-real-1")).toEqual(["done"]);
    expect(k.states("cain-forged-1")).toEqual(["rejected"]);
    expect(k.reason("cain-forged-1")).toContain("isn't in the link's issued-key log");
  }, 30_000);

  test("the keeper: a key issued and then lost to a restore in the same round is told as lost, with the card's message id from the log", () => {
    const k = keeperRig();
    const K = "tap-00000000a201";
    appendLog(linkLog(k), { t: "key", kid: K, ...ASK("1570000000000000711"), at: k.cfg.now!().getTime() });
    linkState(k, {});                                                 // the restored state never listed it
    k.cain({ id: "cain-lost-12", tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-lost-12")).toContain(`tap key ${K} was lost`);
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st.tap_notices).toEqual([expect.objectContaining({ tap: K, why: "lost", msg: "1570000000000000711" })]);
  }, 30_000);
});

describe("2. issued-key memory lasts the key's whole life", () => {
  for (const day of [4, 10, 89])
    test(`a restore on day ${day} is told as lost, never refused as not issued`, () => {
      const k = keeperRig();
      const K = `tap-00000000b${String(day).padStart(3, "0")}`;
      appendLog(linkLog(k), { t: "key", kid: K, ...ASK("1570000000000000721"), at: k.cfg.now!().getTime() });
      linkState(k, { issued: { [K]: ASK("1570000000000000721") } });
      k.cain({ id: `cain-day0-${day}`, ops: [{ op: "note", item: "P44", text: "a round first" }] });
      expect(cycle(k.cfg).ok).toBe(true);
      expect(readLog<any>(issuedMirrorFile(k.cfg)).records.some((x) => x.kid === K)).toBe(true);   // mirrored by the keeper
      k.running(new Date(k.cfg.now!().getTime() + day * DAY));
      linkState(k, {});                                               // restored without it
      if (day === 89) rmSync(linkLog(k));                             // even with the link's log gone: the keeper's mirror
      k.cain({ id: `cain-restored-${day}`, tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
      expect(cycle(k.cfg).ok).toBe(true);
      expect(k.reason(`cain-restored-${day}`)).toContain(`tap key ${K} was lost`);
      expect(k.reason(`cain-restored-${day}`)).not.toContain("isn't one the link issued");
    }, 30_000);

  test("the link keeps its issued keys as long, and the keeper forgets one only past 100 days", async () => {
    expect(TAP_ISSUED_KEEP_MS).toBe(100 * DAY);
    const r = shipRig();
    const ask = await askCard(r);
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const kid = Object.keys(r.state().issued!)[0];
    r.later(89 * DAY);
    await r.link.sweep();
    expect(r.state().issued?.[kid]).toBeDefined();
    const k = keeperRig();
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000b999", ...ASK("1"), at: 0 });
    expect(readIssued(k.cfg, 99 * DAY).keys.has("tap-00000000b999")).toBe(true);
    // Round 18: a key without a card snowflake is never aged by the Pi's clock; it goes once a key logged after it has
    // a card snowflake more than 100 days behind the newest card's.
    expect(readIssued(k.cfg, 101 * DAY).keys.has("tap-00000000b999")).toBe(true);
    const sfAt = (ms: number) => String(((BigInt(ms) - 1420070400000n) << 22n) + 1n);
    const T = Date.UTC(2026, 0, 1);
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000b998", ...ASK(sfAt(T)), at: T });
    expect(readIssued(k.cfg, 101 * DAY).keys.has("tap-00000000b999")).toBe(true);
    appendLog(linkLog(k), { t: "key", kid: "tap-00000000b997", ...ASK(sfAt(T + 101 * DAY)), at: T + 101 * DAY });
    expect(readIssued(k.cfg, 0).keys.has("tap-00000000b999")).toBe(false);
    expect(readIssued(k.cfg, 0).keys.has("tap-00000000b998")).toBe(false);
    expect(readIssued(k.cfg, 0).keys.has("tap-00000000b997")).toBe(true);
  }, 30_000);
});

describe("3. the run counter is fsynced before anything is issued", () => {
  test("the link saves the run durably, then logs it, before the first key", async () => {
    const r = shipRig();
    await askCard(r);
    expect(r.durable[0]).toEqual({ run: r.state().run, nonce: r.state().runNonce });
    expect(logged(r)[0]).toMatchObject({ t: "run", run: r.durable[0].run });
    expect(logged(r).findIndex((x) => x.t === "key")).toBeGreaterThan(0);
    r.restart();
    await r.link.sweep();
    expect(r.durable).toHaveLength(2);
    expect(logged(r).filter((x) => x.t === "run").map((x) => x.run)).toEqual([1, 2]);
  });

  test("a process killed between start and first issuance: a gap, a restart, and no outstanding request marked lost", () => {
    const k = keeperRig();
    const K = "tap-00000000c301";
    appendLog(linkLog(k), { t: "run", run: 4, nonce: "aaaa", at: 0 });
    appendLog(linkLog(k), { t: "key", kid: K, ...ASK("1570000000000000731"), run: 4, nonce: "aaaa", at: k.cfg.now!().getTime() });
    linkState(k, { run: 4, runNonce: "aaaa", issued: { [K]: ASK("1570000000000000731") } });
    k.cain({ id: "cain-r1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    // Run 5 started (its state fsynced), killed before its log line or any key; run 6 started and logged.
    linkState(k, { run: 5, runNonce: "bbbb", issued: { [K]: ASK("1570000000000000731") } });
    linkState(k, { run: 6, runNonce: "cccc", issued: { [K]: ASK("1570000000000000731") } });
    appendLog(linkLog(k), { t: "run", run: 6, nonce: "cccc", at: 0 });
    k.cain({ id: "cain-after-kill", tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-after-kill")).toEqual(["done"]);
    expect(k.kept().linkRestore).toBeUndefined();
    // A run number logged twice with another nonce is a restore.
    linkState(k, { run: 4, runNonce: "dddd", issued: {} });
    k.cain({ id: "cain-r2", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().linkRestore.why).toContain("its run 4 is in the issued-key log already, with another nonce");
  }, 30_000);
});

describe("4. whole-image restores: consumed keys rebuilt from the record remote's history", () => {
  test("a tap-derived commit carries its key; with the keeper's state, logs and copy wiped, the key is still refused", () => {
    const k = keeperRig();
    k.cain({ id: "cain-ship-w", tap: "tap-00000000d401", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-w")).toEqual(["done"]);
    k.pull();
    const body = k.g("log", "--format=%B", "-20");
    expect(body).toContain("Tap-Key: tap-00000000d401");
    expect(body).toContain("Tap-Request: cain-ship-w");
    // The whole image comes back from before the tap: no state, no consumed log, no mirror, no copy.
    rmSync(k.cfg.holds!, { force: true });
    rmSync(tapsLogFile(k.cfg), { force: true });
    rmSync(issuedMirrorFile(k.cfg), { force: true });
    rmSync(k.cfg.dir, { recursive: true, force: true });
    k.cain({ id: "cain-ship-again", tap: "tap-00000000d401", ops: [{ op: "note", item: "P33", text: "again" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-again")).toEqual(["rejected"]);
    expect(k.reason("cain-ship-again")).toContain("was already acted on by request cain-ship-w");
    expect(readConsumed(k.cfg).get("tap-00000000d401")).toBe("cain-ship-w");   // and back in the log
  }, 30_000);
});

describe("5. the hand settle is in the ledger before any effect", () => {
  test("a crash before the ledger write: nothing settled; the same message settles it once afterwards", async () => {
    const r = shipRig();
    const a = await unresolved(r);
    const says = r.his(settleForm(a.kid, "landed"));
    r.crash.at = "hand-settle:before-ledger";
    await expect(r.link.settleKey({ tap: a.kid, how: "landed", said: says.id })).rejects.toThrow("crash injected");
    expect(r.landLedger.hand).toHaveLength(0);
    expect(r.state().unresolved![a.key]).toBeDefined();
    r.restart();
    await sweeps(r, 1);
    expect(r.state().messages[a.id].shipping!.state).toBe("landing");
    expect(await r.link.settleKey({ tap: a.kid, how: "landed", said: says.id })).toMatchObject({ status: "settled" });
    await r.link.whenLanded();
    expect(r.state().messages[a.id].shipping!.state).toBe("landed");
    expect(landedLines(r)).toHaveLength(1);
    expect(r.relayed.filter((x) => x.startsWith(`Landing settled by Dane: tap key ${a.kid}`))).toHaveLength(1);
  });

  test("a crash between the ledger write and the effect: finished once from the ledger, and the message can't settle twice", async () => {
    const r = shipRig();
    const a = await unresolved(r);
    const says = r.his(settleForm(a.kid, "not-landed"));
    r.crash.at = "hand-settle:after-ledger";
    await expect(r.link.settleKey({ tap: a.kid, how: "not-landed", said: says.id })).rejects.toThrow("crash injected");
    expect(r.landLedger.hand).toEqual([expect.objectContaining({ key: a.key, how: "not landed", said: says.id })]);
    expect(r.state().unresolved![a.key]).toBeDefined();             // no effect yet
    r.restart();
    await sweeps(r, 2);
    expect(r.state().unresolved?.[a.key]).toBeUndefined();
    expect(r.state().settleSaid![says.id]).toMatchObject({ tap: a.kid });
    expect(r.state().messages[a.id].shipping!.state).toBe("not landed");
    expect(r.relayed.filter((x) => x.startsWith(`Landing settled by Dane: tap key ${a.kid}`))).toHaveLength(1);
    expect(r.relayed.filter((x) => x.startsWith("Landing abandoned"))).toHaveLength(1);
    await expect(r.link.settleKey({ tap: a.kid, how: "landed", said: says.id })).rejects.toThrow("was already used");
    await sweeps(r, 2);
    expect(r.relayed.filter((x) => x.startsWith("Landing abandoned"))).toHaveLength(1);
  });

  test("the real ledger: one framed, fsynced append per hand settle, mirrored on the key's file, never two from one message", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger12-"));
    const syncs: string[] = [];
    const L = landingLedger(join(dir, "landings"), join(dir, "marker.json"), { sync: (w) => syncs.push(w) });
    const at = "2026-11-16T00:00:00.000Z";
    expect(L.claim("k-1", { pr: PR, head: SHA1, at })).toBe(true);
    expect(L.claim("k-2", { pr: PR, head: SHA1, at })).toBe(true);
    expect(L.settleHand!("k-1", "landed", at, "1570000000000000901")).toBe(true);
    expect(syncs).toContain("settle-log");
    expect(L.settleHand!("k-2", "landed", at, "1570000000000000901")).toBe(false);   // the same message
    expect(L.handSettles!()).toEqual([{ key: "k-1", how: "landed", at, said: "1570000000000000901" }]);
    expect(L.entries()!.find((e) => e.key === "k-1")!.settled).toMatchObject({ how: "landed", forced: true, said: "1570000000000000901" });
    appendFileSync(join(dir, "landings", SETTLED_LOG), "57:0000");     // a torn final record
    expect(L.repair!()).toMatchObject({ torn: true });
    expect(L.handSettles!()).toHaveLength(1);
  });
});

describe("6. settle parsing tolerates copying", () => {
  const kid = "tap-0123456789ab", other = "tap-ba9876543210";
  test("as copied from the reminder on a phone", () => {
    expect(settleWordsProblem("```\nsettle tap-0123456789ab landed\n```", kid, "landed")).toBeNull();
    expect(settleWordsProblem("`settle tap-0123456789ab landed`", kid, "landed")).toBeNull();
    expect(settleWordsProblem("Settle\u00a0tap-0123456789ab\u200b landed", kid, "landed")).toBeNull();
    expect(settleWordsProblem("Settle tap-0123456789ab not\u2013landed", kid, "not-landed")).toBeNull();     // en dash
    expect(settleWordsProblem("settle tap\u20140123456789ab not\u2014landed.", kid, "not-landed")).toBeNull();   // em dashes
    expect(settleWordsProblem("SETTLE TAP-0123456789AB LANDED", kid, "landed")).toBeNull();
    expect(settleNormalise("```text\n Settle\u202ftap-0123456789ab  landed \n```")).toBe("settle tap-0123456789ab landed");
  });
  test("the key and the single verdict stay strict, and a refusal shows what was received, normalised", () => {
    expect(settleWordsProblem(`\`settle ${other} landed\``, kid, "landed")).toContain(`names tap key ${other}, not ${kid}`);
    expect(settleWordsProblem("settle tap-0123456789ab landed not\u2013landed", kid, "landed")).toContain("says both landed and not landed");
    const said = settleWordsProblem("Settle tap-0123456789ab landed, I think it\u00a0did not land", kid, "landed")!;
    expect(said).toContain("says both landed and not landed");
    expect(said).toContain(`(received, normalised: "settle tap-0123456789ab landed, i think it did not land")`);
  });
  test("the reminder shows both settle lines, each in its own code block", () => {
    const t = unresolvedReminder(kid);
    expect(t).toContain("```\nsettle tap-0123456789ab landed\n```");
    expect(t).toContain("```\nsettle tap-0123456789ab not-landed\n```");
    // A line copied out of either block settles.
    expect(settleWordsProblem(t.split("```")[1], kid, "landed")).toBeNull();
    expect(settleWordsProblem(t.split("```")[3], kid, "not-landed")).toBeNull();
  });
});

describe("7. a target mismatch doesn't use the key up", () => {
  test("refused with what to do next; the right write with the same key is then done", () => {
    const k = keeperRig();
    const K = "tap-00000000e701";
    k.issue(K, { item: "P33", kind: "ship", label: "Ship", target: { item: "P33", writes: ["ship-take"] }, msg: "1570000000000000741" } as any);
    k.cain({ id: "cain-wrong-7", tap: K, ops: [{ op: "row-close", item: "P33", evidence: "his Ship tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-wrong-7")).toEqual(["rejected"]);
    expect(k.reason("cain-wrong-7")).toContain("The tap key isn't used up");
    expect(k.reason("cain-wrong-7")).toContain(`"tap": "none"`);
    expect(readConsumed(k.cfg).has(K)).toBe(false);
    k.cain({ id: "cain-right-7", tap: K, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-right-7")).toEqual(["done"]);
    expect(readConsumed(k.cfg).get(K)).toBe("cain-right-7");
  }, 30_000);
  test("his line says his answer stands and what to do; Cain's rules list the writes per card kind", () => {
    expect(TAP_REFUSED).toContain("Your answer still stands");
    expect(TAP_REFUSED).toContain("nothing to do");
    const rules = flat("../rootfs/opt/cain/CLAUDE.md");
    expect(rules).toContain("Writes a tap allows, per card kind");
    expect(rules).toContain(`as an ordinary request with "tap": "none" and its source check redone`);
  });
});

describe("8. reminders taper", () => {
  test("one per-thread line on the first unconfirmed day, a daily digest for 7 days, then weekly; the clock lists them", async () => {
    const r = shipRig();
    const { id, key, kid } = await unresolved(r);
    const toldAt = r.state().unresolved![key].toldAt!;
    const thread = () => onThread(r, id, unresolvedReminder(kid)).length;
    const digests = () => r.cards().filter((m: any) => String(m.content).includes("still unconfirmed")).length;
    const seen: [number, number, number][] = [];
    for (let d = 1; d <= 22; d++) {
      r.t.now = toldAt + d * DAY + MIN;
      await r.link.sweep();
      seen.push([d, thread(), digests()]);
    }
    expect(seen[0]).toEqual([1, 1, 0]);                              // day 1: the thread line
    expect(seen[7]).toEqual([8, 1, 7]);                              // days 2 to 8: a digest a day
    expect(seen[13]).toEqual([14, 1, 7]);                            // then nothing for a week
    expect(seen[14]).toEqual([15, 1, 8]);
    expect(seen[21]).toEqual([22, 1, 9]);
    const clock: any = r.link.clockReport();
    expect(clock.unresolved_landings[0]).toMatchObject({ tap_key: kid, settle: [`settle ${kid} landed`, `settle ${kid} not-landed`] });
  });
});

describe("9. framed append-only logs", () => {
  test("a torn final record is truncated, with one logged line and one relayed line", () => {
    const lines: string[] = [];
    console.log = (x: string) => { lines.push(String(x)); };
    const k = keeperRig();
    k.cain({ id: "cain-ship-t", tap: "tap-00000000f901", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const good = readFileSync(tapsLogFile(k.cfg), "utf8");
    appendFileSync(tapsLogFile(k.cfg), '61:deadbeef:{"tap":"tap-00000000f902","id":"x"');   // cut short
    k.cain({ id: "cain-r9", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    // Round 21: the file compared exactly: what stood before, then the keeper's one landed mark for the consumed key (its
    // exact form asserted on its own); the torn record is gone.
    const landed = { t: "landed", tap: "tap-00000000f901", id: "cain-ship-t", at: k.cfg.now!().toISOString() };
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.t === "landed")).toEqual([landed]);
    expect(readFileSync(tapsLogFile(k.cfg), "utf8")).toBe(good + frame(landed));
    expect(lines.filter((l) => l.includes("TORN:"))).toHaveLength(1);
    expect(k.relayed().split(" / ").filter((l) => l.includes("torn final record"))).toHaveLength(1);
    k.cain({ id: "cain-r9b", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(lines.filter((l) => l.includes("TORN:"))).toHaveLength(1);
    expect(readConsumed(k.cfg).get("tap-00000000f901")).toBe("cain-ship-t");
  }, 30_000);

  // Round 13: no longer a refusal: a detected restore, a degraded start and a rebuild (round 13's tests).
  test("a missing log, or one shorter than its high-water count: a detected restore, rebuilt, never a refusal", () => {
    const k = keeperRig();
    k.cain({ id: "cain-ship-m", tap: "tap-00000000f911", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().logHigh.consumed).toBe(1);
    rmSync(tapsLogFile(k.cfg));
    k.cain({ id: "cain-r9c", ops: [{ op: "note", item: "P44", text: "a round" }] });
    const out: any = cycle(k.cfg);
    expect(out.ok).toBe(true);
    expect(out.refused).toBeUndefined();
    expect(k.relayed()).toContain("The record keeper detected a restore");
    expect(k.states("cain-r9c")).toEqual(["done"]);
    expect(readConsumed(k.cfg).get("tap-00000000f911")).toBe("cain-ship-m");   // back from the history
    expect(k.kept().rebuild).toBeUndefined();
  }, 30_000);

  test("the frame: length and checksum per record; a bad middle record is skipped, a torn last one truncated", () => {
    const f = join(mkdtempSync(join(tmpdir(), "applog-")), "x.log");
    writeLogForTest(f, [{ a: 1 }], "3:00000000:{}\n");
    appendLog(f, { b: 2 });
    appendFileSync(f, "9:");
    const r = readLog(f, { repair: true });                           // round 21: repair is asked for (off by default)
    expect(r.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.bad).toBe(1);
    expect(r.torn).toBe(true);
    expect(readLog(f).torn).toBe(false);
    expect(readLog(join(f, "..", "none.log")).missing).toBe(true);
  });
});

describe("10. install taps behind a flag", () => {
  test("a Ship tap waits, buttons on, until install taps are on; once lets exactly one through", async () => {
    const r = shipRig({ installTaps: false });
    expect((r.link.clockReport() as any).install_taps).toBe("off");
    const id = await shipCard(r);
    const out = await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    expect(out).toBe("refused: installs wait");
    expect(r.buttons(id)).toEqual(["Ship", "Not now"]);
    expect(r.ephemerals().some((e: any) => e.content === INSTALL_WAIT)).toBe(true);
    expect(r.github.landings).toHaveLength(0);
    expect(r.relayed.some((x) => x.includes("install taps aren't on yet"))).toBe(true);
    await expect(r.link.installTaps({ how: "yes" })).rejects.toThrow("on, once or off");
    expect(await r.link.installTaps({ how: "once" })).toMatchObject({ status: "ok", install_taps: "once" });
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(landedLines(r)).toHaveLength(1);
    expect((r.link.clockReport() as any).install_taps).toBe("off");
    // Round 13: on is the owner's line alone (round 13's tests); Cain's on without it only proposes.
    await expect(r.link.installTaps({ how: "on" })).rejects.toThrow("result file");
    expect((r.link.clockReport() as any).install_taps).toBe("off");
  });
  test("keeper.sh, the docs and Cain's rules say so; the live CLI test is a known skip naming its issue", () => {
    expect(flat("../rootfs/opt/cain/keeper.sh")).toContain("keeper.sh install-taps on|once|off");
    expect(flat("../rootfs/opt/cain/keeper.sh")).toContain("install-taps) url=");
    expect(flat("../DOCS.md")).toContain("keeper.sh install-taps on");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("keeper.sh install-taps on");
    expect(flat("./discord-send.cli.test.ts")).toContain("issue #24");
  });
});

describe("11. docs, rules and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    expect(docs).toContain("link-issued.log");
    expect(docs).toContain("Tap-Key: tap-");
    expect(docs).toContain("whole image");
    expect(docs).toContain("high-water");
    expect(docs).toContain("pull request 21 and pull request 23 also bump this App's version; pull request 20 lands first and this rebases onto it, regenerating the fixture");
    expect(docs).toContain("nothing to set up beyond the smoke test's one option change");
    expect(rules).toContain("digest");
    expect(log).toContain("install");
    expect(log).toContain("torn");
  });
});
