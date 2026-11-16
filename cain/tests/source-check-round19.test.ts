// Source checks, nineteenth review round (0.12.0): defects in the eighteenth round's own additions, fixed. Supersede and
// consumption meet at one durable arbitration point (a consuming intent in the consumed-key log); the expired-key index
// records why a card was retired; no Pi-clock decision about whether a tap counts; legacy cards migrated explicitly; open
// landing claims block their keys through a rebuild; append logs that always fit, never glue onto a torn line, and are
// serialised; verification keyed on run and nonce; a per-key answer before asking him again; read-back messages as clock
// comparisons; crash tests in a killed child process; the longest card lifetime from configuration and a stale-check line.
// Each describe names the invariant table row it covers (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { AFTER_RENAME, appendLog, crashSpy, FREE_TEXT_BUDGET, MAX_RECORD_BYTES, readLog, shortWriteSpy, tornSpy } from "../rootfs/opt/cain/applog.ts";
import { CHECK_STALE_TAP, CHECK_UNANCHORED, TAP_CONSUMED, TAP_REPLAY_ACTED, TAP_REPLAY_AGAIN, TAP_REPLAY_WAITING, TAP_UNISSUED, TAP_UNSTAMPED, REPLAY_WAIT_MS, tapKid } from "../rootfs/opt/cain/link/core";
import { parseRequest } from "../rootfs/opt/cain/record/core";
import { cycle, forgetRebuild, linkHeldFile, openIntents, readConsumed, replayAnswers, tapsLogFile } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; crashSpy.on = null; shortWriteSpy.on = null; tornSpy.on = null; });
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const INVARIANTS = "../docs/source-check-invariants.md";
const WORDS = "Stop stays within reach of your newest message.";

type R = ReturnType<typeof linkRig>;
type K = ReturnType<typeof keeperRig>;
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
const realExpiry = (r: R, id: string) => { const k = logged(r).find((x) => x.t === "key" && x.msg === id); return sfTime(id) + k.life; };
const tapAt = (r: R, id: string, msg: any, at: number | string, i = 0) => r.link.onInteraction({ type: 3, id: typeof at === "string" ? at : sf(at, 900 + i), token: "t", application_id: "999", channel_id: DM,
  user: { id: "4242" }, data: { custom_id: (msg.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id))[i] }, message: structuredClone(msg) });

const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const keyRec = (kid: string, msg: string, at: number, life = 10 * MIN) =>
  ({ t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + life, life });
// A keeper with one tap key issued (its key record, and the link's tap record with its interaction id) and Cain's
// request for it queued.
const keeperWithKey = (kid: string, id: string, o: { it?: string | null } = {}) => {
  const k = keeperRig();
  k.cain({ id: `${id}-0`, ops: [{ op: "note", item: "P44", text: "a round" }] });
  expect(cycle(k.cfg).ok).toBe(true);
  const at = k.cfg.now!().getTime(), card = sf(at);
  appendLog(linkLog(k), keyRec(kid, card, at, DAY));
  const it = o.it === null ? {} : { it: o.it ?? sf(at + MIN, 3) };
  writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, ...it } } }));
  k.cain({ id, tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
  return { k, card, at };
};
// The link's replayed held tap, waiting on the keeper (the round-18 flow): returns the card and its key.
const replayed = async (r: R) => {
  const id = await askCard(r);
  unverified(r);
  await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
  r.keeperVerified();
  r.crash.at = "held:after-relay";
  await expect(r.link.sweep()).rejects.toThrow("crash injected");
  r.restart();
  r.keeperVerified();
  r.t.mono = 5_000;
  await r.link.sweep();
  r.t.mono += REPLAY_WAIT_MS + 1;
  await r.link.sweep();                                               // superseded; the line waits for the keeper
  return { id, kid: kidOf(r, id) };
};
const consumedFile = (r: R) => { const f = join(mkdtempSync(join(tmpdir(), "r19-consumed-")), "record-taps.jsonl"); (r.deps as any).consumedLog = f; return f; };

describe("1. supersede and consumption through one durable arbitration point (invariants: the consumed-key log, the issued-key log)", () => {
  test("a supersede landing between the keeper's supersede read and its consumed append: consumed once, and the link says it acted", async () => {
    const kid = "tap-0000001f1001";
    const { k } = keeperWithKey(kid, "cain-r19-1-a");
    // The supersede lands after the keeper read the link's log (it found none) and before the consumed append.
    k.cfg.onDecided = (id: string) => { if (id === "cain-r19-1-a") appendLog(linkLog(k), { t: "supersede", kid, at: Date.now() }); };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-r19-1-a")).toEqual(["done"]);
    const recs = readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.tap === kid);
    expect(recs.map((x) => x.t ?? "consumed")).toEqual(["consuming", "consumed"]);   // the intent came first, durable
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r19-1-a");

    // The link, at the instant between: an open intent holds the line asking him again.
    const r = shipRig();
    const { id, kid: lkid } = await replayed(r);
    const f = consumedFile(r);
    appendLog(f, { t: "consuming", tap: lkid, id: "cain-x", at: "2026-11-11T13:00:00.000Z" });
    r.keeperVerified({ replay_keys: { [lkid]: { mirrored: true, consumed: "no" } } });   // a status from just before the intent
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
    appendLog(f, { tap: lkid, id: "cain-x", at: "2026-11-11T13:00:01.000Z" });
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_ACTED)).toHaveLength(1);
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
  }, 60_000);

  test("a refused request drops its intent, so the link may ask him again", () => {
    const kid = "tap-0000001f1002";
    const { k } = keeperWithKey(kid, "cain-r19-1-b");
    appendLog(linkLog(k), { t: "supersede", kid, at: Date.now() });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r19-1-b")).toContain("superseded");
    expect(readLog<any>(tapsLogFile(k.cfg)).records.filter((x) => x.tap === kid).map((x) => x.t)).toEqual(["consuming", "dropped"]);
    expect(openIntents(k.cfg).size).toBe(0);
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 60_000);

  test("a crash after the local commit and before the consumed append, then a restart: consumed from the trailer, one effect, no re-ask", () => {
    const kid = "tap-0000001f1003";
    const { k } = keeperWithKey(kid, "cain-r19-1-c");
    k.cfg.crashPoint = (w: string) => { if (w === "consumed:before-append") throw new Error("crash injected"); };
    expect(cycle(k.cfg).ok).toBe(false);                              // the round died at the crash point
    k.cfg.crashPoint = undefined;
    expect(openIntents(k.cfg).get(kid)).toBe("cain-r19-1-c");          // the intent stands open: the link waits
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    // The link's view meanwhile: consuming.
    writeFileSync(linkHeldFile(k.cfg), "");
    appendLog(linkHeldFile(k.cfg), { t: "released", kid, replay: true, at: 1 });
    expect(replayAnswers(k.cfg)[kid].consumed).toBe("consuming");
    forgetRebuild(k.cfg);                                             // a restart of the keeper
    k.cain({ id: "cain-r19-1-c2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    expect(openIntents(k.cfg).size).toBe(0);
    expect(readConsumed(k.cfg).get(kid)).toBe("cain-r19-1-c");
    expect(k.states("cain-r19-1-c")).toEqual(["done"]);                // one effect
    expect(replayAnswers(k.cfg)[kid].consumed).toBe("consumed");       // the link's answer: acted, never asked again
    // A second request for the key is refused as acted on.
    k.cain({ id: "cain-r19-1-c3", tap: kid, ops: [{ op: "note", item: "P11", text: "his tap again" }] }, { issue: false });
    cycle(k.cfg);
    expect(k.reason("cain-r19-1-c3")).toContain("already acted on");
  }, 60_000);

  test("the table's consumed-key row names the intent and its resolution", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("a \"consuming\" intent");
    expect(doc).toContain("resolved from the commit's Tap-Key trailer");
  });
});

describe("2. the expired-key index records why a card was retired (invariants: the expired-key index)", () => {
  test("an armed card retired unarmed (failing its arming checks) and tapped within its expiry is refused", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const before = structuredClone(r.msg(id));
    const real = realExpiry(r, id);
    await (r.link as any).retireUnarmed(id, "expired");
    expect(readLog<any>(side(r, "link-expired.log")).records.find((x) => x.msg === id)?.why).toBe("unarmed");
    expect(await tapAt(r, id, before, real - HOUR)).not.toBe("to Cain");
    expect(tapLines(r)).toHaveLength(0);
  });

  test("a card the sweep expired early is indexed as swept, and a tap stamped before its real expiry acts, its exact key relayed", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const before = structuredClone(r.msg(id));
    const real = realExpiry(r, id);
    stepPi(r, 2 * DAY);
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    await (r.link as any).expireByLog();
    expect(readLog<any>(side(r, "link-expired.log")).records.find((x) => x.msg === id)?.why).toBe("swept");
    expect(await tapAt(r, id, before, real - MIN)).toBe("to Cain");
    // The forward-step test's assertions (round 18), restored with the exact key matched.
    expect(tapLines(r)).toHaveLength(1);
    expect(tapLines(r)[0]).toEndWith(`Tap key ${kidOf(r, id)}.`);
  });
});

describe("3. no Pi-clock decision about whether a tap counts (invariants: the link state, the issued-key log)", () => {
  test("a live tap with a malformed interaction id is refused with a line on the card and a line to Cain", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    expect(await tapAt(r, id, r.msg(id), "not-a-snowflake")).toBe("refused: unstamped");
    expect(onThread(r, id, TAP_UNSTAMPED)).toHaveLength(1);
    expect(tapLines(r)).toHaveLength(0);
    expect(r.relayed.some((x) => x.startsWith("Tap not acted") && x.includes(id))).toBe(true);
  });

  test("a restarted claim without an interaction id is refused, never judged at Discord's time now", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const st = r.state();
    const key = Object.keys(st.taps!)[0];
    st.taps![key] = { ...st.taps![key], stage: "claimed", nonce: "an-earlier-run" } as any;
    delete (st.taps![key] as any).it;
    r.setState(st);
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(onThread(r, id, TAP_UNSTAMPED)).toHaveLength(1);
    expect(r.relayed.some((x) => x.includes("Tap not acted") && x.includes("interaction id"))).toBe(true);
    expect(r.state().taps![key].outcome).toBe("not acted");
  });

  test("the keeper's live-tap branch refuses a tap record without an interaction id, with a notice", () => {
    const kid = "tap-0000001f3001";
    const { k } = keeperWithKey(kid, "cain-r19-3-a", { it: null });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r19-3-a")).toContain("can't be placed in Discord's time");
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    expect(status(k).tap_notices.find((n: any) => n.tap === kid)?.why).toBe("unstamped");
  }, 60_000);

  test("the forgetting day is judged by the tap's snowflake against the card's post plus its retention", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const st = r.state(), m = st.messages[id];
    m.until = m.posted! + DAY + 2 * HOUR;                             // a retention that ends two hours after the post
    r.setState(st);
    stepPi(r, 3 * DAY);                                               // the Pi's clock alone is far past it
    r.keeperVerified();
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + HOUR)).toBe("to Cain");
    const r2 = shipRig();
    r2.keeperVerified();
    const id2 = await askCard(r2);
    const st2 = r2.state();
    st2.messages[id2].until = st2.messages[id2].posted! + DAY + 2 * HOUR;
    r2.setState(st2);
    expect(await tapAt(r2, id2, r2.msg(id2), sfTime(id2) + 3 * HOUR)).toBe("dead: forgetting");   // the Pi's clock in step: still the snowflake decides
  });

  test("the table lists the one Pi-clock refusal and its message", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("Pi-clock refusal");
    expect(doc).toContain("missing or malformed interaction id");
  });
});

describe("4. legacy cards migrated explicitly (invariants: the source-check ledger, the link state)", () => {
  // A card as a pre-round-18 version left it: its check has no Discord anchor, in the ledger or on the card.
  const legacy = (r: R, id: string, checkedAgo: number) => {
    const st = r.state();
    delete (st.messages[id].checked as any).sf;
    r.setState(st);
    const ledger = JSON.parse(r.files.checks!);
    delete ledger.P08.checked_sf;
    ledger.P08.checked_at = new Date(sfTime(id) - checkedAgo).toISOString();
    r.files.checks = JSON.stringify(ledger);
  };

  test("a card live at the upgrade keeps its buttons, and a tap within the limit acts", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    legacy(r, id, HOUR);
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(r.state().messages[id].checked!.sf).toBe(sf(sfTime(id) - HOUR, 0));   // the lesser: the check's keeper date
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + 2 * HOUR)).toBe("to Cain");
  });

  test("a six-and-a-half-day-old check does not count past its limit, though the card is under a day old", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    legacy(r, id, 6 * DAY + 12 * HOUR);
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + 20 * HOUR)).toBe("dead: check stale");
    expect(r.ephemerals().at(-1).content).toBe(CHECK_STALE_TAP(7));
  });

  test("a legacy card with no trustworthy anchor (not in the issued-key log) is withdrawn with a line saying a new check is needed", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    legacy(r, id, HOUR);
    writeFileSync(r.issuedLog!, "");                                  // the log lost it
    r.restart();
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
    expect(String(r.msg(id).content)).toContain(CHECK_UNANCHORED);
    expect(r.relayed.some((x) => x.includes("can't be dated by Discord's time"))).toBe(true);
  });

  test("the keeper refuses a new check op without an anchor, with an explicit error", () => {
    const req = { id: "link-check-p44-9", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: "the county portal, read at 9", row: null, version: 0 }] };
    expect(parseRequest(JSON.stringify(req)).error).toContain("a check without its Discord anchor (sf) isn't taken");
  });
});

describe("5. open landing claims stay blocked through a rebuild (invariants: the consumed-key log, the landing ledger)", () => {
  test("a restore, then a re-tap on a key with an open landing claim before the settle: refused as acted on", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await shipCard(r);
    const m = r.state().messages[id];
    const key = [id, m.checked?.gen ?? "none", m.checked?.req ?? "none", "P41", "Ship"].join("|");
    r.landLedger.keys.add(key);                                       // a claim the link made before the restore, still open
    r.landLedger.what.set(key, { pr: PR, head: SHA1, at: new Date(r.t.now).toISOString() });
    const before = structuredClone(r.msg(id));
    const st = r.state(); delete st.messages[id]; r.setState(st);     // the restored state forgot the card
    r.restart();
    r.keeperVerified();
    expect(await tapAt(r, id, before, sfTime(id) + MIN)).toBe("dead: consumed");
    expect(r.ephemerals().at(-1).content).toBe(TAP_CONSUMED);
    expect(r.github.landings).toHaveLength(0);
  });

  test("the keeper refuses a request for an open-claim key before the link settles it, and takes nothing into the log", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r19-5-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const key = "1570000000000000777|1|link-check-p41-1|P41|Ship", kid = tapKid(key);
    const dir = join(k.root, "pi/record-landings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${"a".repeat(32)}.json`), JSON.stringify({ key, pr: PR, head: SHA1, at: "2026-11-11T13:00:00.000Z" }));
    k.cain({ id: "cain-r19-5-a", tap: kid, ops: [{ op: "note", item: "P41", text: "his tap" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r19-5-a")).toContain("hasn't settled against GitHub's main yet");
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 60_000);

  test("the table's rebuild column keeps open claims blocked", () => {
    expect(flat(INVARIANTS)).toContain("an open claim's key stays blocked (treated as consumed) until the link settles it against the remote main");
  });
});

describe("6. append logs: free text cut to fit, short writes undone, torn tails skipped and reported, writers serialised (invariants: every append-only log)", () => {
  test("an oversize settle reason is cut to its budget and the record is written whole", () => {
    const f = join(mkdtempSync(join(tmpdir(), "r19-log-")), "settled.log");
    appendLog(f, { key: "k", how: "not landed", reason: "GitHub said: ".concat("x".repeat(3 * MAX_RECORD_BYTES)), at: "x" });
    const rec = readLog<any>(f).records[0];
    expect(rec.reason.length).toBe(FREE_TEXT_BUDGET);
    expect(readFileSync(f).length).toBeLessThan(MAX_RECORD_BYTES);
  });

  test("a short write is truncated back to the file's length before it, then refused", () => {
    const f = join(mkdtempSync(join(tmpdir(), "r19-log-")), "record-install.log");
    appendLog(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    const size = readFileSync(f).length;
    shortWriteSpy.on = () => 7;
    expect(() => appendLog(f, { t: "flag", how: "on", by: "owner", at: "y" })).toThrow("written short");
    expect(readFileSync(f).length).toBe(size);
  });

  test("a torn tail: every reader skips and reports it; after a restart another writer's append lands readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "r19-log-")), f = join(dir, "link-held.log");
    appendLog(f, { t: "held", kid: "a", at: 1 });
    writeFileSync(f, readFileSync(f, "utf8") + "57:00000000:{\"t\":\"held\",\"kid\":\"b\"");   // a power cut tore the next record
    const told: number[] = [];
    tornSpy.on = (_f, n) => { told.push(n); };
    const seen = readLog<any>(f, { repair: false });
    expect(seen.records.map((x) => x.kid)).toEqual(["a"]);
    expect(seen.torn).toBe(true);
    expect(told.length).toBe(1);
    // Another writer (a separate process) appends after the restart.
    const child = spawnSync("bun", [join(import.meta.dir, "crash-child.ts"), "log", f, join(dir, "effect"), "none"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const after = readLog<any>(f, { repair: false });
    expect(after.torn).toBe(false);
    expect(after.records.map((x) => x.kid ?? x.n)).toEqual(["a", 2]);
  }, 30_000);

  test("shared-log writers are serialised: two processes' appends all land whole; a lock its holder left is taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r19-log-")), f = join(dir, "record-install.log");
    mkdirSync(`${f}.lock`);
    writeFileSync(join(`${f}.lock`, "pid"), "999999");                // a writer that died holding it
    appendLog(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    expect(existsSync(`${f}.lock`)).toBe(false);
    const script = join(dir, "many.ts");
    writeFileSync(script, `import { appendLog } from ${JSON.stringify(join(import.meta.dir, "../rootfs/opt/cain/applog.ts"))};\nfor (let i = 0; i < 40; i++) appendLog(process.argv[2], { t: "once-used", by: "w-" + process.argv[3], n: i, why: "x".repeat(900) });\n`);
    const run = (who: string) => new Promise<number>((ok) => spawn("bun", [script, f, who], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 1)));
    expect(await Promise.all([run("link"), run("keeper")])).toEqual([0, 0]);
    const recs = readLog<any>(f, { repair: false });
    expect(recs.bad).toBe(0);
    expect(recs.torn).toBe(false);
    expect(recs.records.filter((x) => x.by === "w-link")).toHaveLength(40);
    expect(recs.records.filter((x) => x.by === "w-keeper")).toHaveLength(40);
  }, 60_000);
});

describe("7. verification keyed on run and nonce (invariants: the keeper status, the link state)", () => {
  const linkState = (k: K, run: number, nonce: string) => {
    const f = join(k.root, "pi/link/state.json");
    let j: any = { messages: {}, issued: {} };
    try { j = JSON.parse(readFileSync(f, "utf8")); } catch { /* none yet */ }
    writeFileSync(f, JSON.stringify({ ...j, run, runNonce: nonce }));
  };

  test("the keeper refuses a run it already verified under another nonce, and names its highest verified run", () => {
    const k = keeperRig();
    linkState(k, 7, "aaaa0007");
    k.cain({ id: "cain-r19-7-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.cain({ id: "cain-r19-7-1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).verified).toMatchObject({ link: "aaaa0007", run: 7 });
    expect(status(k).verified_high).toBe(7);
    linkState(k, 7, "bbbb0007");                                      // a restored link state reusing run 7
    k.cain({ id: "cain-r19-7-2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    k.cain({ id: "cain-r19-7-3", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    expect(status(k).verified).toBeUndefined();
    expect(k.relayed()).toContain("won't verify the link's run 7");
    linkState(k, 8, "cccc0008");                                      // the link's next run
    k.cain({ id: "cain-r19-7-4", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    expect(status(k).verified).toMatchObject({ link: "cccc0008", run: 8 });
  }, 60_000);

  test("the link seeds its run above the keeper's highest verified run, and takes verified only for its own run and nonce", async () => {
    const r = shipRig();
    await r.link.sweep();
    r.keeperVerified({ verified_high: 40 });
    r.restart();
    (r.link as any).runNo();
    expect(r.state().run).toBeGreaterThan(40);
    r.keeperVerified();
    expect((r.link.clockReport() as any).consumed_verified).toBe(true);
    const st = JSON.parse(r.files.status!);
    st.verified.run = r.state().run! - 1;                              // the same nonce under another run number
    r.files.status = JSON.stringify(st);
    expect((r.link.clockReport() as any).consumed_verified).toBe(false);
  });

  test("the table's row says verification is keyed on run and nonce", () => {
    expect(flat(INVARIANTS)).toContain("keyed on the link's run and nonce together");
  });
});

describe("8. the check before asking him again reads a per-key answer (invariants: the held log, the keeper status)", () => {
  test("a key outside the newest supersedes list still gets its answer; no answer yet: one line on the card after the wait, asking nothing", async () => {
    const r = shipRig();
    const { id, kid } = await replayed(r);
    r.keeperVerified({ superseded: [kid] });                          // the old list names it, but no per-key answer
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
    r.t.mono! += REPLAY_WAIT_MS + 1;
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_WAITING)).toHaveLength(1);
    r.keeperVerified({ replay_keys: { [kid]: { mirrored: true, consumed: "no" } } });   // the per-key answer, no list at all
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(1);
  });

  test("the keeper's per-key answer comes from its whole mirror, never a newest-200 list", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r19-8-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const kid = "tap-0000001f8001";
    appendLog(linkLog(k), { t: "supersede", kid, at: 1 });
    for (let i = 0; i < 250; i++) appendLog(linkLog(k), { t: "supersede", kid: `tap-${(0x2f8000 + i).toString(16).padStart(12, "0")}`, at: 1 });
    writeFileSync(linkHeldFile(k.cfg), "");
    appendLog(linkHeldFile(k.cfg), { t: "released", kid, replay: true, at: 1 });
    k.cain({ id: "cain-r19-8-1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).superseded).not.toContain(kid);                 // pushed out of the newest list
    expect(status(k).replay_keys[kid]).toEqual({ mirrored: true, consumed: "no" });
  }, 60_000);

  test("a held tap whose key isn't in the issued-key log is refused at the link with a line on the card, never released", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    appendLog(side(r, "link-held.log"), { t: "held", kid: "tap-0000001f8fff", msg: id, label: "Filed", item: "P08", kind: "ask", row: null, version: 0, req: null, at: r.t.now,
      it: sf(sfTime(id) + MIN, 9), hold: { period: "p", id: sf(sfTime(id) + MIN, 8), from: "interaction" } });
    await r.link.sweep();
    expect(onThread(r, id, TAP_UNISSUED)).toHaveLength(1);
    expect(tapLines(r)).toHaveLength(0);
    expect(readLog<any>(side(r, "link-held.log")).records.map((x) => x.t)).toEqual(["held", "dropped"]);
  });
});

describe("9. read-back messages are clock comparisons (invariants: the sweep cursor)", () => {
  const restoreAfter = async (r: R) => {
    await r.link.sweep();
    unverified(r);
    (r.files as any).status = JSON.stringify({ ...JSON.parse(r.files.status!), consumed_unverified: { since: new Date(r.t.now).toISOString(), why: "its log of consumed tap keys is missing", tries: 0 } });
    r.restart();
  };

  test("a quiet restart: the start mark's read finds the Pi's clock not behind, so the restore sweep completes", async () => {
    const r = shipRig();
    await restoreAfter(r);
    expect((r.link.clockReport() as any).pi_clock).toBe("unknown");
    await r.link.sweep();
    expect((r.link.clockReport() as any).pi_clock).toBe("in step");
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8")).done).toBe(true);
  });

  test("the Pi's clock an hour behind a message read back: off, and the done mark waits", async () => {
    const r = shipRig();
    await askCard(r);
    await restoreAfter(r);
    stepPi(r, -HOUR);
    await r.link.sweep();
    expect((r.link.clockReport() as any).pi_clock).toBe("off");
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8")).done).toBe(false);
  });
});

describe("10. crash coverage in a killed child process (invariants: every fsynced store)", () => {
  // The store's own writer runs in a child killed by SIGKILL at the crash point; the dependent effect (a marker the
  // child writes once the write returns) must not exist, and a whole-file store keeps its old content at its name
  // when killed before the fsync.
  const kill = (store: string, name: string, at: "write" | "rename", old?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "r19-crash-")), file = join(dir, name), effect = join(dir, "effect");
    if (old !== undefined) writeFileSync(file, old);
    const res = spawnSync("bun", [join(import.meta.dir, "crash-child.ts"), store, file, effect, at], { encoding: "utf8" });
    return { res, file, effect, dir };
  };
  const logs = ["link-issued.log", "link-held.log", "link-strip.log", "link-expired.log", "record-taps.jsonl", "record-install.log", "record-issued.log", "settled.log"];
  for (const name of logs) test(`the append-only log ${name}: killed before its fsync, the effect never happened`, () => {
    const { res, effect } = kill("log", name, "write");
    expect(res.signal).toBe("SIGKILL");
    expect(existsSync(effect)).toBe(false);
  }, 30_000);
  const wholes: [string, string][] = [["atomic", "record-ledger.json"], ["atomic", "record-holds.json"], ["durable", "link-sweep.json"], ["durable", "record-recover.json"], ["state", "state.json"]];
  for (const [store, name] of wholes) for (const at of ["write", "rename"] as const) test(`the whole-file store ${name}: killed ${at === "write" ? "before its fsync" : "after its rename, before the folder's fsync"}`, () => {
    const { res, file, effect } = kill(store, name, at, JSON.stringify({ n: 1 }) + "\n");
    expect(res.signal).toBe("SIGKILL");
    expect(existsSync(effect)).toBe(false);
    if (at === "write") expect(JSON.parse(readFileSync(file, "utf8")).n).toBe(1);   // the old one, whole, at the name
    else expect(JSON.parse(readFileSync(file, "utf8")).n).toBe(2);                  // renamed; durable only once the folder syncs
  }, 30_000);
  test("the landing ledger: killed before the claim's fsync, nothing after it ran", () => {
    const { res, effect, dir } = kill("landing", "landings/x", "write");
    expect(res.signal).toBe("SIGKILL");
    expect(existsSync(effect)).toBe(false);
    expect(existsSync(join(dir, "landings-marker.json"))).toBe(false);
  }, 30_000);

  test("the keeper status after a rename before its folder's fsync: a power cut keeps the old file, and the restarted keeper relies on none of it", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r19-10-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const file = join(k.root, "pi/record-ledger.json");
    const old = readFileSync(file, "utf8");
    let renamed = "";
    crashSpy.on = (f) => { if (f === `${file}${AFTER_RENAME}`) { crashSpy.on = null; renamed = readFileSync(file, "utf8"); throw new Error("crash injected after the rename"); } };
    k.cain({ id: "cain-r19-10-1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    try { cycle(k.cfg); } catch { /* the crash */ }
    expect(renamed).not.toBe("");
    writeFileSync(file, old);                                         // the power cut lost the rename
    const before = JSON.parse(old).start?.nonce;
    forgetRebuild(k.cfg);                                             // the keeper's restart
    k.cain({ id: "cain-r19-10-2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    const now = status(k);
    expect(now.start.nonce).not.toBe(before);                         // a new start, never the lost write's
    expect(now.verified?.start ?? now.start.nonce).toBe(now.start.nonce);
  }, 60_000);

  test("no module writes the link state file but its store in publish.ts", () => {
    const root = join(import.meta.dir, "../rootfs/opt/cain");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|sh)$/.test(n)) files.push(p); } };
    walk(root);
    const writers = /(writeFileSync|writeFile\(|renameSync|rename\(|openSync|appendFileSync|\bcp |\bmv |[^=]>\s*["$\/])/;
    const hits: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => { if (/(link\/state\.json|\bSTATE\b|linkState)/.test(l) && writers.test(l) && !/readFileSync|existsSync|lstatSync|stateFile\(/.test(l)) hits.push(`${f.slice(root.length + 1)}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
    expect(readFileSync(join(root, "link/main.ts"), "utf8")).toContain("stateFile(STATE");
  });

  test("the table says the cards view decides nothing, and names the child-process crash tests", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("the cards view for the reply hook (/data/trust/cards.json, rebuilt from the link state) decides nothing");
    expect(doc).toContain("in a child process killed at the crash point");
  });
});

describe("11. the longest card lifetime from configuration, and a stale check said so (invariants: the expired-key index, the source-check ledger)", () => {
  test("an index record for a card older than the sweep's horizon carries its post plus the configured longest lifetime", async () => {
    const r = shipRig();
    const most = (r.link as any).cardLifeMax();
    expect(most).toBeGreaterThan(DAY);
    expect(most).toBeLessThan(2 * DAY);
    const old = sf(r.t.now - 200 * DAY);
    const rec = (r.link as any).indexRecord(old, undefined, true, "swept");
    expect(rec.exp).toBe(sfTime(old) + most);
    expect(rec.why).toBe("swept");
  });

  test("a freshness refusal says the check is stale on the card, and offers Cain the re-check", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const ledger = JSON.parse(r.files.checks!);
    ledger.P08.checked_sf = sf(sfTime(id) - 7 * DAY);
    r.files.checks = JSON.stringify(ledger);
    expect(await tapAt(r, id, r.msg(id), sfTime(id) + HOUR)).toBe("dead: check stale");
    expect(r.ephemerals().at(-1).content).toBe(CHECK_STALE_TAP(7));
    expect(r.relayed.some((x) => x.includes("Re-check: check P08 again"))).toBe(true);
    expect(r.state().recheck?.P08).toBeDefined();
  });
});

describe("12. docs: the table, DOCS.md, Cain's rules and keeper.sh usage say what round 19 changed", () => {
  test("nothing the owner sees carries a job id or a sha, or asks him to send or tap again", () => {
    for (const line of [TAP_REPLAY_WAITING, TAP_UNISSUED, CHECK_UNANCHORED, CHECK_STALE_TAP(7), TAP_UNSTAMPED]) {
      expect(line).not.toMatch(/\b[0-9a-f]{7,40}\b|tap-|cse_|session/i);
      expect(line).not.toMatch(/tap again|send .* again|answer again/i);
    }
  });
  test("DOCS.md and Cain's rules name the round-19 behaviour", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    expect(docs).toContain("consuming intent");
    expect(rules).toContain("The check behind this is more than");
    expect(flat("../CHANGELOG.md")).toContain("stale");
  });
});

void rmSync; void SHA1;
