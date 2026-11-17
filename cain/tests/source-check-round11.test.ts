// Source checks, eleventh review round (0.12.0): the hand settle bound to its key, issued keys with a
// structured target the keeper matches, consumed keys in an append-only log a link restore can't
// forget (and taps lost to such a restore told), unresolved keys over days (a daily reminder, a 7-day
// alert, a 90-day tombstone), and a forced ledger entry linked to a later landing of its head.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleForm, settleWordsProblem, TAP_REFUSED, TAP_RESTORE_LOST, tapKid, tapTarget, unresolvedReminder,
  UNRESOLVED_ALERT_MS, UNRESOLVED_TOMB_MS } from "../rootfs/opt/cain/link/core";
import { landingLedger } from "../rootfs/opt/cain/link/landings";
import { tapIssuedProblem } from "../rootfs/opt/cain/record/core.ts";
import { cycle, readConsumed, readIssued, readLinkTaps, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { appendLog } from "../rootfs/opt/cain/applog.ts";
import { DAY, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const CHECKED = "the pull request on GitHub, open at that head, read at 8";
const WORDS = "Stop stays within reach of your newest message.";

type R = ReturnType<typeof linkRig>;
const shipRig = () => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
let checks = 0;
const shipCard = async (r: R) =>
  (await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: WORDS, checked: `${CHECKED} (${++checks})` }) as any).message as string;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: `the county portal, read at 8 (${++checks})` }) as any).message as string;
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const shipLines = (r: R) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
const landedLines = (r: R) => shipLines(r).filter((x) => x.includes("The link landed it") || x.includes("It is already in main"));
const sweeps = async (r: R, n = 3, step = 5 * MIN) => { for (let i = 0; i < n; i++) { r.later(step); await r.link.sweep(); await r.link.whenLanded(); } };
const status = (r: R, s: Record<string, unknown>) => {
  (r.files as any).status = JSON.stringify({ clock: { synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() }, ...s });
};

// A Ship tap whose landing is claimed, cut off by a restart, and then can't be settled (GitHub down):
// unresolved, told once.
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
// A second unresolved key, with no card of its own (a restored ledger's key).
function another(r: R, full = "1570000000000000099|1|q:feedfeedfe:0|P41|Ship") {
  const st = r.state();
  st.unresolved![full] = { since: r.t.now, fails: 3, last: "main was rewritten", next: r.t.now + DAY, what: "ledger" };
  r.setState(st);
  return { key: full, kid: tapKid(full) };
}

describe("1. the hand settle is bound to its key", () => {
  test("the exact form only: the key it names, the verdict it says, nothing negated or both", () => {
    const kid = "tap-0123456789ab", other = "tap-ba9876543210";
    expect(settleWordsProblem(`settle ${kid} landed`, kid, "landed")).toBeNull();
    expect(settleWordsProblem(`  Settle ${kid}   LANDED. `, kid, "landed")).toBeNull();
    expect(settleWordsProblem(`settle ${kid} not-landed`, kid, "not-landed")).toBeNull();
    expect(settleWordsProblem(`settle ${other} landed`, kid, "landed")).toContain(`names tap key ${other}, not ${kid}`);
    expect(settleWordsProblem(`settle ${kid} not-landed`, kid, "landed")).toContain("says not-landed, but the command says landed");
    expect(settleWordsProblem(`settle ${kid} not landed`, kid, "landed")).toContain(`says "not landed" (two words), the opposite of landed`);
    expect(settleWordsProblem(`settle ${kid} not landed`, kid, "not-landed")).toContain("not-landed as one word");
    expect(settleWordsProblem(`settle ${kid} landed, or maybe it did not land`, kid, "landed")).toContain("says both landed and not landed");
    expect(settleWordsProblem("It landed: I looked at main on GitHub.", kid, "landed")).toContain(`isn't of the exact form "${settleForm(kid, "landed")}"`);
  });

  test("one message replayed across two keys: the second is refused, even once the link's state forgets it", async () => {
    const r = shipRig();
    const a = await unresolved(r);
    const b = another(r);
    const says = r.his(settleForm(a.kid, "landed"));
    expect(await r.link.settleKey({ tap: a.kid, how: "landed", said: says.id })).toMatchObject({ status: "settled" });
    await r.link.whenLanded();
    expect(r.state().messages[a.id].shipping!.state).toBe("landed");
    expect(r.state().settleSaid![says.id]).toMatchObject({ tap: a.kid });
    await expect(r.link.settleKey({ tap: b.kid, how: "landed", said: says.id })).rejects.toThrow(`was already used to settle tap key ${a.kid}`);
    // The link's state restored without its consumed ids: the ledger's settled entry still has it.
    const st = r.state();
    delete st.settleSaid;
    r.setState(st);
    await expect(r.link.settleKey({ tap: b.kid, how: "landed", said: says.id })).rejects.toThrow("was already used");
    expect(r.state().unresolved![b.key]).toBeDefined();
    expect(landedLines(r)).toHaveLength(1);
  });

  test("a negated phrase, and a message naming another key: refused with the reason, nothing settled", async () => {
    const r = shipRig();
    const a = await unresolved(r);
    const b = another(r);
    const neg = r.his(`settle ${a.kid} not landed`);
    await expect(r.link.settleKey({ tap: a.kid, how: "landed", said: neg.id })).rejects.toThrow("the opposite of landed");
    const both = r.his(`settle ${a.kid} landed. Actually it did not land.`);
    await expect(r.link.settleKey({ tap: a.kid, how: "landed", said: both.id })).rejects.toThrow("says both landed and not landed");
    const named = r.his(settleForm(b.kid, "landed"));
    await expect(r.link.settleKey({ tap: a.kid, how: "landed", said: named.id })).rejects.toThrow(`names tap key ${b.kid}, not ${a.kid}`);
    expect(r.state().messages[a.id].shipping!.state).toBe("landing");
    expect(r.state().settleSaid).toBeUndefined();                     // a refused message isn't consumed
    // The message naming b settles b (it is unresolved), once.
    expect(await r.link.settleKey({ tap: b.kid, how: "not-landed", said: r.his(settleForm(b.kid, "not-landed")).id })).toMatchObject({ status: "settled" });
    expect(r.state().unresolved![b.key]).toBeUndefined();
  });
});

describe("2. issued keys carry a structured target the keeper matches", () => {
  test("the link records each issued key's card message and target", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const key = Object.keys(r.state().taps!)[0];
    expect(r.state().issued![tapKid(key)]).toMatchObject({ item: "P08", kind: "ask", label: "Filed", msg: ask, target: { item: "P08", writes: ["row-close", "decision"] } });
    const ship = await shipCard(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    await r.link.whenLanded();
    const skey = Object.keys(r.state().taps!).find((k) => k !== key)!;
    expect(r.state().issued![tapKid(skey)]).toMatchObject({ msg: ship, target: { item: "P41", writes: ["ship-take"] } });
    expect(tapTarget("none", "ask", "Yes")).toEqual({ item: "NONE", writes: ["decision"] });
    expect(tapTarget("P41", "ship", "Not now")).toEqual({ item: "P41", writes: ["decision"] });
  });

  test("matched on the target, never on text: a paraphrase passes, a write the tap doesn't allow is refused with the reason", () => {
    const ask = { "tap-00000000b001": { item: "P11", kind: "ask", label: "Filed", target: { item: "P11", writes: ["row-close", "decision"] } } };
    const ship = { "tap-00000000b002": { item: "P33", kind: "ship", label: "Ship", target: { item: "P33", writes: ["ship-take"] } } };
    const dec = (text: string) => ({ tap: "tap-00000000b001", ops: [{ op: "append", path: "state/decisions.md", text }] });
    expect(tapIssuedProblem(dec("| Nov 16 | whether the packet went in | yes, it is in |\n"), ask)).toBeNull();
    expect(tapIssuedProblem({ tap: "tap-00000000b001", ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, ask)).toBeNull();
    expect(tapIssuedProblem({ tap: "tap-00000000b002", ops: [{ op: "row-close", item: "P33", evidence: "x" }] }, ship))
      .toContain(`is from a "Ship" tap on a Ship card, which allows a take for its Ship job on P33, not closing its row`);
    expect(tapIssuedProblem({ tap: "tap-00000000b002", ops: [{ op: "append", path: "areas/x/decisions.md", text: "P33" }] }, ship)).toContain("not a decision");
    expect(tapIssuedProblem({ tap: "tap-00000000b001", ops: [{ op: "take", item: "P11", for: "x", job: "ship it" }] }, ask)).toContain("can't start a Ship job");
    expect(tapIssuedProblem({ tap: "tap-00000000b001", ops: [{ op: "row-close", item: "P44", evidence: "x" }] }, ask)).toContain("is from a card for P11, but the request names P44");
  });

  test("the keeper refuses a mismatched request: Cain hears the reason, the status asks the link to tell him on the card", () => {
    const k = keeperRig();
    k.issue("tap-00000000c001", { item: "P11", kind: "ask", label: "Filed", target: { item: "P11", writes: ["row-close", "decision"] }, msg: "1570000000000000701" } as any);
    k.issue("tap-00000000c002", { item: "P33", kind: "ship", label: "Ship", target: { item: "P33", writes: ["ship-take"] }, msg: "1570000000000000702" } as any);
    k.cain({ id: "cain-para-1", tap: "tap-00000000c001", ops: [{ op: "append", path: "state/decisions.md", text: "| Nov 16 | whether the packet went in | Filed |\n" }] }, { issue: false });
    k.cain({ id: "cain-wrong-1", tap: "tap-00000000c002", ops: [{ op: "row-close", item: "P33", evidence: "his Ship tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-para-1")).toEqual(["done"]);
    expect(k.states("cain-wrong-1")).toEqual(["rejected"]);
    expect(k.reason("cain-wrong-1")).toContain("not closing its row");
    expect(k.relayed()).toContain("cain-wrong-1");
    expect(k.relayed()).toContain("not closing its row");
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st.tap_notices).toEqual([expect.objectContaining({ tap: "tap-00000000c002", why: "refused", msg: "1570000000000000702" })]);
  }, 30_000);

  test("the link tells him once, on the card's thread", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const kid = Object.keys(r.state().issued!)[0];
    status(r, { tap_notices: [{ tap: kid, why: "refused", reason: "x", at: new Date(r.t.now).toISOString() }] });
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, ask, TAP_REFUSED)).toHaveLength(1);
    expect(r.logs.join("\n")).toContain(`the record keeper refused the request from tap key ${kid}`);
  });
});

describe("3. consumed keys in an append-only log, and taps lost to a restore of the link's state", () => {
  test("a consumed key is appended, and still refused when the keeper's state forgets it", () => {
    const k = keeperRig();
    k.cain({ id: "cain-ship-a", tap: "tap-00000000d001", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-a")).toEqual(["done"]);
    expect(readConsumed(k.cfg).get("tap-00000000d001")).toBe("cain-ship-a");
    const before = readFileSync(tapsLogFile(k.cfg), "utf8");
    const st = k.kept();
    delete st.taps;
    writeFileSync(k.cfg.holds!, JSON.stringify(st));
    k.cain({ id: "cain-ship-b", tap: "tap-00000000d001", ops: [{ op: "note", item: "P33", text: "again" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-b")).toEqual(["rejected"]);
    expect(k.reason("cain-ship-b")).toContain("was already acted on by request cain-ship-a");
    expect(readFileSync(tapsLogFile(k.cfg), "utf8").startsWith(before)).toBe(true);   // only appended to
  }, 30_000);

  test("a restore of the link's state while a request is outstanding: the request is lost and told, never silently refused", () => {
    const k = keeperRig();
    const f = join(k.root, "pi/link/state.json");
    const link = (run: number, nonce: string, issued: Record<string, unknown>) => writeFileSync(f, JSON.stringify({ messages: {}, run, runNonce: nonce, issued }));
    const K = "tap-00000000e001";
    const reg = { item: "P11", kind: "ask", label: "Filed", at: 0, msg: "1570000000000000801", target: { item: "P11", writes: ["row-close", "decision"] } };
    link(4, "aaaa", { [K]: reg });
    appendLog(join(k.root, "pi/link-issued.log"), { t: "key", kid: K, ...reg, at: k.cfg.now!().getTime() });   // round 12: issued means logged
    k.cain({ id: "cain-before", ops: [{ op: "note", item: "P44", text: "a round first" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readIssued(k.cfg, k.cfg.now!().getTime()).keys.get(K)).toBeDefined();   // round 12: the keeper's mirror
    expect(k.kept().linkSeen).toEqual({ run: 4, nonce: "aaaa" });
    // The link's state comes back from an older copy (a lower run, then a restart: the same run, another
    // nonce), without the key; Cain's request from that tap is outstanding.
    link(4, "bbbb", {});
    k.cain({ id: "cain-lost-1", tap: K, ops: [{ op: "row-close", item: "P11", evidence: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-lost-1")).toEqual(["rejected"]);
    expect(k.reason("cain-lost-1")).toContain(`tap key ${K} was lost: the link's state was restored from an older copy (its run went from 4 to 4 with a new nonce)`);
    expect(k.reason("cain-lost-1")).not.toContain("isn't one the link issued");
    expect(k.relayed()).toContain("was lost: the link's state was restored");
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st.tap_notices).toEqual([expect.objectContaining({ tap: K, why: "lost", msg: "1570000000000000801" })]);
    expect(st.link_restore.why).toContain("with a new nonce");
    // A lower run is a restore too.
    link(2, "cccc", {});
    k.cain({ id: "cain-after", ops: [{ op: "note", item: "P44", text: "another round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().linkRestore.why).toContain("from 4 to 2");
  }, 30_000);

  test("the link tells him the tap was lost to the restore, once, on the card's thread", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const kid = "tap-00000000e002";
    status(r, { tap_notices: [{ tap: kid, why: "lost", reason: "x", msg: ask, at: new Date(r.t.now).toISOString() }] });
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, ask, TAP_RESTORE_LOST)).toHaveLength(1);
  });

  test("the keeper treats a tombstone's key as unresolved, so its consumed key is kept", () => {
    const k = keeperRig();
    const full = "1570000000000000001|7|link-check-p33-1|P33|Ship";
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, tombstones: { [full]: { since: 0, fails: 1, last: "x", next: 0, what: "orphan", tomb: 1 } } }));
    expect(readLinkTaps(k.cfg)!.unresolved.has(tapKid(full))).toBe(true);
  });
});

describe("4. unresolved keys over days", () => {
  test("a daily reminder with the exact settle message, a 7-day alert to Cain, and a 90-day tombstone that stops blocking", async () => {
    const r = shipRig();
    const { id, key, kid } = await unresolved(r);
    const reminders = () => onThread(r, id, unresolvedReminder(kid));
    expect(reminders()).toHaveLength(0);
    expect(unresolvedReminder(kid)).toContain(`\n${settleForm(kid, "landed")}\n`);
    expect(unresolvedReminder(kid)).toContain("Reconciling a landing by hand");
    r.later(DAY);
    await r.link.sweep();
    expect(reminders()).toHaveLength(1);
    r.later(12 * 60 * MIN);
    await r.link.sweep();
    expect(reminders()).toHaveLength(1);                              // once a day, not each sweep
    r.later(12 * 60 * MIN);
    await r.link.sweep();
    expect(reminders()).toHaveLength(1);                              // round 12: the thread line once, then a digest
    expect(r.cards().filter((m: any) => String(m.content).includes("still unconfirmed") && String(m.content).includes(`settle ${kid} landed`))).toHaveLength(1);
    const clock: any = r.link.clockReport();
    expect(clock.unresolved_landings[0]).toMatchObject({ tap_key: kid, settle: [`settle ${kid} landed`, `settle ${kid} not-landed`], how: "DOCS.md, Reconciling a landing by hand" });
    // Past 7 days: one alert line to Cain.
    const alerts = () => r.relayed.filter((x) => x.startsWith("Landing unresolved for over 7 days:"));
    r.t.now = r.state().unresolved![key].since + UNRESOLVED_ALERT_MS + MIN;
    await r.link.sweep();
    await r.link.sweep();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain(`settle ${kid} landed`);
    // Past 90 days: a tombstone. Its record stays, it is listed as such, and a new card may go out.
    await expect(shipCard(r)).rejects.toThrow("isn't settled yet");
    r.t.now = r.state().unresolved![key].since + UNRESOLVED_TOMB_MS + MIN;
    await r.link.sweep();
    expect(r.state().unresolved).toBeUndefined();
    expect(r.state().tombstones![key]).toMatchObject({ what: "orphan" });
    expect(r.state().messages[id].shipping!.state).toBe("tombstone");
    expect(r.relayed.filter((x) => x.startsWith("Landing tombstoned:"))).toHaveLength(1);
    const after: any = r.link.clockReport();
    expect(after.tombstoned_landings).toEqual([expect.objectContaining({ tap_key: kid, tombstone: true })]);
    expect(after.unresolved_landings).toEqual([]);
    expect(r.state().issued?.[kid]).toBeDefined();                     // its issued key is kept
    expect(r.landLedger.keys.has(key)).toBe(true);                     // and its ledger entry
    r.github.readable = true;
    const card = await shipCard(r);
    expect(r.buttons(card)).toEqual(["Ship", "Not now"]);
    // He can still settle a tombstone by hand.
    expect(await r.link.settleKey({ tap: kid, how: "not-landed", said: r.his(settleForm(kid, "not-landed")).id })).toMatchObject({ status: "settled" });
    await r.link.whenLanded();
    expect(r.state().tombstones).toBeUndefined();
    expect(r.landLedger.settled.get(key)).toBe("not landed");
    expect(r.relayed.filter((x) => x.startsWith(`Landing settled by Dane: tap key ${kid}`))).toHaveLength(1);
  });
});

describe("5. a forced ledger entry linked to a later landing of the same head", () => {
  test("the reconciliation shows one landing per head", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger11-"));
    const L = landingLedger(join(dir, "landings"), join(dir, "marker.json"));
    const at = "2026-11-16T00:00:00.000Z", H2 = "b".repeat(40);
    expect(L.claim("k-forced", { pr: PR, head: SHA1, at })).toBe(true);
    L.settle("k-forced", "landed", at, { forced: true, said: "1570000000000000901" });
    expect(L.claim("k-real", { pr: PR, head: SHA1, at })).toBe(true);
    L.settle("k-real", "landed", at);
    expect(L.claim("k-not", { pr: PR, head: H2, at })).toBe(true);
    L.settle("k-not", "not landed", at, { forced: true });
    expect(L.claim("k-later", { pr: PR, head: H2, at })).toBe(true);
    L.settle("k-later", "landed", at);
    const es = L.entries()!;
    expect(es.find((e) => e.key === "k-forced")).toMatchObject({ linked: "k-real", settled: { how: "landed", forced: true, said: "1570000000000000901" } });
    expect(es.find((e) => e.key === "k-not")!.linked).toBe("k-later");
    const rows = L.reconcile!();
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.head === SHA1)).toMatchObject({ landed: "k-real", forced: ["k-forced"] });
    expect(rows.find((x) => x.head === H2)).toMatchObject({ landed: "k-later", forced: ["k-not"] });
    expect(existsSync(join(dir, "landings"))).toBe(true);
  });

  test("DOCS.md says a reset during the push doesn't undo the landing", () => {
    expect(flat("../DOCS.md")).toContain("a reset that arrives during the push does not undo the landing and is reported as landed");
  });
});

describe("6. docs, rules, keeper.sh and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    const keeper = flat("../rootfs/opt/cain/keeper.sh");
    expect(docs).toContain("settle <tap key> landed");
    expect(docs).toContain("tombstone");
    expect(docs).toContain("record-taps.jsonl");
    expect(docs).toContain("pull request 21 and pull request 23 also bump this App's version; pull request 20 lands first and this rebases onto it, regenerating the fixture");
    expect(rules).toContain("settle <tap key> not-landed");
    expect(rules).toContain("tombstone");
    expect(rules).toContain("reminded once a day");
    expect(keeper).toContain("tombstoned_landings");
    expect(keeper).toContain(`"settle <tap key> landed"`);
    expect(log).toContain("tombstone");
    expect(log).toContain("settle");
  });
});
