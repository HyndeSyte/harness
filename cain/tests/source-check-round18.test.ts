// Source checks, eighteenth review round (0.12.0): rows of the invariant table that broke its own clock rule, a race
// the ordering sentence didn't cover, and a durability hole, fixed. A tap counts against a source check by Discord's
// times (the check's anchor against the tap's interaction); the expired-key index is a cleanup marker with a snowflake
// expiry; a supersede is ordered against consumption; a held tap is judged by its own interaction; every save of the
// link state is fsynced; no Pi clock fallback into whether a tap counts; run numbers past the issued-key log; the Pi's
// clock unknown until compared; holds and key records off the wall clock; the table's rebuild and interleaving rows;
// buttons off by the post snowflake through the measured offset; a crash-injection test per fsync point that matters;
// the keeper's epoch never decreasing. Each describe names the invariant table row it covers
// (cain/docs/source-check-invariants.md).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendLog, crashSpy, MAX_RECORD_BYTES, readLog } from "../rootfs/opt/cain/applog.ts";
import { CARD_CHECKING, CLOCK_TOLERANCE_MS, REPLAY_WAIT_MS, TAP_EXPIRED, TAP_HELD, TAP_REPLAY_ACTED, TAP_REPLAY_AGAIN, TAP_UNSTAMPED } from "../rootfs/opt/cain/link/core";
import { landingLedger } from "../rootfs/opt/cain/link/landings";
import { stateFile, type StateIo } from "../rootfs/opt/cain/link/publish";
import { CHECKS_PATH, freshByDiscord, parseChecks, parseRequest, plan, type Request } from "../rootfs/opt/cain/record/core";
import { cycle, holdLapsed, linkHeldFile, readConsumed, recoverTaken, supersededNow } from "../rootfs/opt/cain/record/main.ts";
import { DAY, DM, HOUR, MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; crashSpy.on = null; });
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
// The Pi's clock steps by `by`; Discord's time stands still.
const stepPi = (r: R, by: number) => { r.t.now += by; r.t.discord -= by; };
// A card's real expiry as a Discord time: its post snowflake plus the lifetime its key record carries.
const realExpiry = (r: R, id: string) => { const k = logged(r).find((x) => x.t === "key" && x.msg === id); return sfTime(id) + k.life; };
// Tap a card with a message as it was when posted, at a given Discord time.
const tapAt = (r: R, id: string, msg: any, at: number, i = 0) => r.link.onInteraction({ type: 3, id: sf(at, 900 + i), token: "t", application_id: "999", channel_id: DM,
  user: { id: "4242" }, data: { custom_id: (msg.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id))[i] }, message: structuredClone(msg) });

// The keeper's side.
const status = (k: K) => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
const linkLog = (k: K) => join(k.root, "pi/link-issued.log");
const keyRec = (kid: string, msg: string, at: number, life = 10 * MIN) =>
  ({ t: "key", kid, item: "P11", kind: "ask", label: "Filed", msg, target: { item: "P11", writes: ["row-close", "decision"] }, at, exp: at + life, life });

describe("1. a tap's freshness is Discord's time against the check's anchor (invariants: the source-check ledger)", () => {
  test("the keeper records the check's Discord anchor; freshness is decided by Discord's times alone, never its aged mark", () => {
    const T0 = new Date("2026-11-11T13:00:00.000Z");
    const files: Record<string, string> = { "state/PENDING.md": pendingWith(["P44"], []) };
    const tree = { read: (p: string) => files[p] ?? null } as any;
    const anchor = sf(T0.getTime());
    const p = plan({ id: "link-check-p44-1", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: "the county portal, read at 8", row: null, version: 0, sf: anchor }] } as Request,
      tree, { at: T0, clockSynced: true });
    if (p.state !== "ok") throw new Error(p.state);
    const e = parseChecks(p.writes.get(CHECKS_PATH)!).P44;
    expect(e.checked_sf).toBe(anchor);
    expect(freshByDiscord(e, e.checked_sf, T0.getTime() + 7 * DAY - MIN)).toBe(true);
    expect(freshByDiscord(e, e.checked_sf, T0.getTime() + 7 * DAY + MIN)).toBe(false);
    expect(freshByDiscord({ ...e, aged: "2026-11-11T14:00:00.000Z", stepped_back: "2026-11-11T14:00:00.000Z" }, e.checked_sf, T0.getTime() + DAY)).toBe(true);
    expect(freshByDiscord(e, e.checked_sf, T0.getTime() + MIN, 0)).toBe(false);          // the smoke test's 0 days: nothing counts
    expect(parseRequest(JSON.stringify({ id: "link-check-p44-2", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: "the county portal, read at 9", row: null, version: 0, sf: "soon" }] })).error)
      .toContain("sf must be a Discord snowflake");
  });

  for (const [dir, off] of [["ahead", 6 * HOUR], ["behind", -6 * HOUR]] as const) {
    test(`the Pi's clock stepped hours ${dir}, the keeper's verdict still synchronized: a tap a day after a 7-day-old check is refused, one within the limit acts`, async () => {
      for (const [age, acts] of [[7 * DAY + MIN, false], [7 * DAY - MIN, true]] as const) {
        const r = shipRig();
        r.keeperVerified();
        const id = await askCard(r);
        expect(r.submitted.at(-1).ops[0].sf).toMatch(/^\d{15,22}$/);
        stepPi(r, off);
        r.keeperVerified();                                           // the keeper's clock verdict: synchronized
        const at = sfTime(id) + HOUR;                                 // he taps an hour after the card, by Discord's time
        const ledger = JSON.parse(r.files.checks!);
        ledger.P08.checked_sf = sf(at - age);                         // the check's anchor, by Discord's times
        r.files.checks = JSON.stringify(ledger);
        const out = await tapAt(r, id, r.msg(id), at);
        expect(out).toBe(acts ? "to Cain" : "dead: status changed");
        expect(tapLines(r)).toHaveLength(acts ? 1 : 0);
      }
    });
  }

  test("the table's row for the ledger: the clock column names the Discord anchor, and the keeper's clock only for retention", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("checked_sf");
    expect(doc).toContain("a tap's interaction snowflake less the check's anchor");
  });
});

describe("2. the expired-key index is a cleanup marker with a snowflake expiry (invariants: the expired-key index)", () => {
  test("a forward step of the Pi's clock: the sweep expires and indexes the card, yet a tap stamped before its real expiry acts", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const before = structuredClone(r.msg(id));
    const real = realExpiry(r, id);
    stepPi(r, 2 * DAY);                                               // the Pi jumps two days; Discord's time doesn't
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);                                // buttons off by the link's estimate
    expect(await tapAt(r, id, before, real - MIN)).toBe("to Cain");   // stamped before the real expiry: acts
    expect(tapLines(r)).toHaveLength(1);
  });

  test("an index record carries the card's expiry as a snowflake time; a tap is refused only when stamped after it", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const before = structuredClone(r.msg(id));
    const real = realExpiry(r, id);
    // The state forgets the card; the index has it.
    const st = r.state(); delete st.messages[id]; r.setState(st);
    appendLog(side(r, "link-expired.log"), { msg: id, exp: real, at: r.t.now });
    // Stamped before the real expiry: membership alone refuses nothing as expired (the tap goes the unknown card's way).
    expect(await tapAt(r, id, before, real - MIN, 1)).not.toBe("dead: expired");
    const st2 = r.state(); delete st2.messages[id]; r.setState(st2);
    expect(await tapAt(r, id, before, real + MIN)).toBe("dead: expired");
    expect(r.ephemerals().at(-1).content).toBe(TAP_EXPIRED);
  });

  test("the index pruned: a tap after the real expiry is still refused as expired by the keys, one before it is not", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const before = structuredClone(r.msg(id));
    const real = realExpiry(r, id);
    const st = r.state(); delete st.messages[id]; r.setState(st);
    rmSync(side(r, "link-expired.log"), { force: true });
    expect(await tapAt(r, id, before, real - MIN, 1)).not.toBe("dead: expired");
    const st2 = r.state(); delete st2.messages[id]; r.setState(st2);
    expect(await tapAt(r, id, before, real + MIN)).toBe("dead: expired");
  });
});

describe("3. supersede ordered against consumption (invariants: the issued-key log, the consumed-key log, the held log)", () => {
  const keeperWithKey = (kid: string) => {
    const k = keeperRig();
    k.cain({ id: "cain-r18-3-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const at = k.cfg.now!().getTime(), card = sf(at);
    appendLog(linkLog(k), keyRec(kid, card, at, DAY));
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at, it: sf(at + MIN, 3) } } }));
    k.cain({ id: "cain-r18-3-a", tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    return k;
  };

  test("the old replay delivered between the supersede append and the keeper's mirror of it: refused, never consumed", () => {
    const kid = "tap-0000000f3001";
    const k = keeperWithKey(kid);
    // The supersede lands after this round's mirror, just as the keeper reaches the request.
    k.cfg.onItem = (id: string) => { if (id === "cain-r18-3-a" && !supersededNow(k.cfg, kid)) appendLog(linkLog(k), { t: "supersede", kid, at: Date.now() }); };
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r18-3-a")).toContain("superseded");
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
    k.cfg.onItem = undefined;
    k.cain({ id: "cain-r18-3-n", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).superseded).toContain(kid);                      // mirrored: the link may ask him again now
  }, 60_000);

  test("consumed first, then superseded: the status shows both, and the link posts the tap's outcome instead of asking again", async () => {
    const kid = "tap-0000000f3002";
    const k = keeperWithKey(kid);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readConsumed(k.cfg).has(kid)).toBe(true);
    appendLog(linkLog(k), { t: "supersede", kid, at: Date.now() });
    k.cain({ id: "cain-r18-3-m", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(status(k).superseded).toContain(kid);
    expect(readConsumed(k.cfg).has(kid)).toBe(true);                  // exactly one: consumed, and the card says so
  }, 60_000);

  test("the link: the line waits for the mirror; consumed meanwhile, the card says it acted and nothing asks again", async () => {
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
    await r.link.sweep();                                             // the flagged replay
    r.t.mono += REPLAY_WAIT_MS + 1;
    await r.link.sweep();
    const kid = kidOf(r, id);
    expect(logged(r).some((x) => x.t === "supersede" && x.kid === kid)).toBe(true);
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);       // no mirror yet: nothing asked
    // The keeper consumed it before mirroring the supersede.
    const consumed = join(mkdtempSync(join(tmpdir(), "r18-consumed-")), "record-taps.jsonl");
    appendLog(consumed, { tap: kid, id: "cain-late", at: new Date(r.t.now).toISOString() });
    (r.deps as any).consumedLog = consumed;
    r.keeperVerified({ superseded: [kid] });
    await r.link.sweep();
    await r.link.sweep();
    expect(onThread(r, id, TAP_REPLAY_ACTED)).toHaveLength(1);
    expect(onThread(r, id, TAP_REPLAY_AGAIN)).toHaveLength(0);
    expect(r.relayed.filter((x) => x.includes(`Replayed held tap key ${kid} was acted on`))).toHaveLength(1);
  });
});

describe("4. a released held tap is judged by its own interaction, the hold start only as the floor (invariants: the held log)", () => {
  test("the keeper: a tap a minute after the card's expiry, inside a hold that began before it, is refused as expired", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r18-4-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const at = k.cfg.now!().getTime(), card = sf(at), kid = "tap-0000000f4001";
    appendLog(linkLog(k), keyRec(kid, card, at));
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: card, at } } }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid, msg: card, at, it: sf(at + 11 * MIN, 9), hold: { period: "p", id: sf(at + 5 * MIN, 8), from: "interaction" } });
    k.cain({ id: "cain-r18-4-a", tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("cain-r18-4-a")).toContain("had expired when he tapped it");
    expect(readConsumed(k.cfg).has(kid)).toBe(false);
  }, 60_000);

  test("the link: the same held tap, released, is refused as expired and told on the card", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const kid = kidOf(r, id), real = realExpiry(r, id);
    appendLog(side(r, "link-held.log"), { t: "held", kid, msg: id, label: "Filed", item: "P08", kind: "ask", row: null, version: 0, req: null, at: r.t.now,
      it: sf(real + MIN, 9), hold: { period: "p", id: sf(real - 10 * MIN, 8), from: "interaction" } });
    await r.link.sweep();
    expect(onThread(r, id, TAP_EXPIRED)).toHaveLength(1);
    expect(tapLines(r)).toHaveLength(0);
    expect(r.relayed.some((x) => x.includes("had expired when he tapped"))).toBe(true);
  });
});

describe("5. every save of the link state is fsynced (invariants: the link state)", () => {
  // A power-cut model: bytes written and names renamed live in the page cache until fsynced; a power cut keeps only
  // what was fsynced (a file's bytes by its own fsync, a rename by its folder's).
  const disk = () => {
    let fds = 0;
    const inodes = new Map<number, { data: string; synced: string | null }>();
    const names = new Map<string, number>(), durableNames = new Map<string, number>();
    const open = new Map<number, { path?: string; ino?: number; dir?: string }>();
    let ino = 0;
    const calls: string[] = [];
    const io: StateIo = {
      open: (p, flags) => {
        const fd = ++fds;
        if (flags === "r") { open.set(fd, { dir: p }); return fd; }
        const i = ++ino; inodes.set(i, { data: "", synced: null }); names.set(p, i); open.set(fd, { path: p, ino: i }); calls.push(`open ${p}`); return fd;
      },
      write: (fd, t) => { inodes.get(open.get(fd)!.ino!)!.data = t; calls.push("write"); },
      fsync: (fd) => {
        const o = open.get(fd)!;
        if (o.dir) { for (const [n, i] of names) durableNames.set(n, i); calls.push("fsync dir"); return; }
        const n = inodes.get(o.ino!)!; n.synced = n.data; calls.push("fsync file");
      },
      close: () => {},
      rename: (a, b) => { names.set(b, names.get(a)!); names.delete(a); calls.push("rename"); },
      read: (p) => { const i = names.get(p); if (i === undefined) throw new Error("ENOENT"); return inodes.get(i)!.data; },
    };
    const powerCut = (p: string) => { const i = durableNames.get(p); return i === undefined ? null : inodes.get(i)!.synced; };
    return { io, calls, powerCut };
  };

  test("each save writes, fsyncs the temp file, renames, then fsyncs the folder", () => {
    const d = disk();
    const store = stateFile("/data/link/state.json", () => {}, d.io);
    store.save({ messages: {} } as any);
    expect(d.calls).toEqual(["open /data/link/state.json.tmp", "write", "fsync file", "rename", "fsync dir"]);
  });

  for (const where of ["state:after-write", "state:after-rename"]) {
    test(`a synced claim, then another save cut by a power cut at ${where}: the claim is intact`, () => {
      const d = disk();
      const io = { ...d.io, crash: (w: string) => { if (w === crash) throw new Error(`crash injected at ${w}`); } };
      let crash = "";
      const store = stateFile("/data/link/state.json", () => {}, io);
      const claim = { messages: {}, taps: { k: { at: 1, msg: "1", label: "Filed", stage: "claimed", outcome: "to Cain", shown: "x" } } };
      store.save(claim as any, true);
      crash = where;
      expect(() => store.save({ messages: { m: {} }, taps: claim.taps } as any)).toThrow("crash injected");
      const after = JSON.parse(d.powerCut("/data/link/state.json")!);
      expect(after.taps.k.stage).toBe("claimed");
    });
  }

  test("main.ts uses the store whose every save is durable", () => {
    expect(flat("../rootfs/opt/cain/link/publish.ts")).toContain("save(s: State, _sync = false): void { this.saveDurable(s); }");
  });
});

describe("6. no wall-clock fallback into whether a tap counts (invariants: the issued-key log, the held log)", () => {
  test("the post-then-crash window: a card posted, killed before its key record, restarted: a tap on it is refused, never acted", async () => {
    const r = shipRig();
    r.keeperVerified();
    r.crash.at = "issue:after-post";
    await expect(askCard(r)).rejects.toThrow("crash injected");
    const id = r.last().id;
    expect(logged(r).some((x) => x.t === "key" && x.msg === id)).toBe(false);
    r.restart();
    stepPi(r, -3 * HOUR);                                             // whatever the Pi's clock says
    const forged = { ...r.msg(id), components: [{ type: 1, components: [{ type: 2, style: 1, label: "Filed", custom_id: "q:abcdefabcd:0" }] }] };
    const out = await tapAt(r, id, forged, sfTime(id) + MIN);
    expect(out.startsWith("dead:") || out.startsWith("refused")).toBe(true);
    expect(tapLines(r)).toHaveLength(0);
  });

  test("a held record without an interaction id is refused, told on the card, never floored by the clock", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const kid = kidOf(r, id);
    appendLog(side(r, "link-held.log"), { t: "held", kid, msg: id, label: "Filed", item: "P08", kind: "ask", row: null, version: 0, req: null, at: r.t.now });
    await r.link.sweep();
    expect(onThread(r, id, TAP_UNSTAMPED)).toHaveLength(1);
    expect(tapLines(r)).toHaveLength(0);
  });

  test("the keeper: a key record without a card snowflake is placed by the held record's message id, or refused", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r18-6-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const at = k.cfg.now!().getTime();
    const placed = "tap-0000000f6001", lost = "tap-0000000f6002", bare = "tap-0000000f6003";
    for (const kid of [placed, lost, bare]) appendLog(linkLog(k), { ...keyRec(kid, "not-a-snowflake", at), msg: "not-a-snowflake" });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: Object.fromEntries([placed, lost, bare].map((kid) => [kid, { item: "P11", kind: "ask", label: "Filed", at }])) }));
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: placed, msg: sf(at, 4), at, it: sf(at + MIN, 5) });     // placed by its message id: acts
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: lost, at, it: sf(at + MIN, 6) });                       // no snowflake anywhere
    appendLog(linkHeldFile(k.cfg), { t: "held", kid: bare, msg: sf(at, 7), at });                           // no interaction id
    k.at(new Date(at + 5 * DAY));                                     // the keeper's clock is far past every expiry: it decides nothing
    for (const kid of [placed, lost, bare]) k.cain({ id: `cain-r18-6-${kid.slice(-1)}`, tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-r18-6-1")).toEqual(["done"]);
    expect(k.reason("cain-r18-6-2")).toContain("can't be placed in Discord's time");
    expect(k.reason("cain-r18-6-3")).toContain("can't be placed in Discord's time");
    expect(status(k).tap_notices.filter((n: any) => n.why === "unstamped")).toHaveLength(2);
  }, 60_000);
});

describe("7. the run comes after every logged run, with a fresh nonce (invariants: the link state, the issued-key log)", () => {
  test("the link state restored from a backup, the keeper's status intact: waiting cards stay unarmed until a new verification", async () => {
    const r = shipRig();
    await r.link.sweep();
    r.keeperVerified();
    const st0 = r.state();                                            // the backup, naming the run the keeper verified
    const status0 = r.files.status!;
    r.failing.add(`PATCH /channels/${DM}/messages/`);
    const card = await askCard(r);                                    // a card whose buttons wait
    r.failing.clear();
    r.setState({ ...st0, messages: { ...st0.messages, [card]: r.state().messages[card] } });
    r.restart();
    r.files.status = status0;                                         // the keeper's status, intact: it names the old run
    await r.link.sweep();
    expect(r.state().run).toBeGreaterThan(Math.max(...logged(r).filter((x) => x.t === "run" && x.nonce !== r.state().runNonce).map((x) => x.run)));
    expect(r.state().runNonce).not.toBe(st0.runNonce);
    expect(r.buttons(card)).toEqual([]);
    r.keeperVerified();                                               // a new verification, for the new run
    await r.link.sweep();
    expect(r.buttons(card)).toEqual(["Filed", "Not filed"]);
  });
});

describe("8. the Pi's clock is unknown until compared in this run (invariants: the sweep cursor)", () => {
  test("no Discord stamp compared yet: the verdict is unknown and the restore sweep's done mark waits; after one, done", async () => {
    const r = shipRig();
    await r.link.sweep();
    unverified(r);
    (r.files as any).status = JSON.stringify({ ...JSON.parse(r.files.status!), consumed_unverified: { since: new Date(r.t.now).toISOString(), why: "its log of consumed tap keys is missing", tries: 0 } });
    r.restart();
    expect((r.link.clockReport() as any).pi_clock).toBe("unknown");
    await r.link.sweep();
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8")).done).toBe(false);
    expect(r.cards().filter((m: any) => /^The Pi's clock is off/.test(String(m.content)))).toHaveLength(0);
    await r.link.recoverLogs({});                                     // a post: Discord's stamp compared
    expect((r.link.clockReport() as any).pi_clock).toBe("in step");
    await r.link.sweep();
    expect(JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8")).done).toBe(true);
  });
});

describe("9. holds and key records off the wall clock (invariants: the keeper state, the link state, the keeper's issued-key mirror)", () => {
  test("a hold lapses on the monotonic clock within a run, even with the Pi's clock stepped back", () => {
    const k = keeperRig();
    let mono = 0;
    k.cfg.mono = () => mono;
    const h = { holder: "laptop:x", for: "work", branches: [], taken: "2026-11-11T13:00:00.000Z", renewed: "2026-11-11T13:00:00.000Z" };
    const back = new Date("2026-11-09T13:00:00.000Z");                 // the Pi's clock two days behind the renewal
    expect(holdLapsed(k.cfg, "P33", h, back, [])).toBe(false);
    mono += DAY + MIN;
    expect(holdLapsed(k.cfg, "P33", h, back, [])).toBe(true);
  });

  test("the link prunes a tap record by a snowflake comparison, never by the Pi's clock alone", async () => {
    const r = shipRig();
    const id = await askCard(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const kid = Object.keys(r.state().issued!)[0];
    stepPi(r, 200 * DAY);                                             // the Pi's clock alone
    await r.link.sweep();
    expect(r.state().issued?.[kid]).toBeDefined();
    r.t.discord += 200 * DAY;                                         // Discord's time too, seen in a stamp
    (r.link as any).noteStamp(r.snowflake());
    await r.link.sweep();
    expect(r.state().issued?.[kid]).toBeUndefined();
  });
});

describe("10. the table's rebuild and interleaving rows (invariants: the consumed-key log, the install log, the recover file)", () => {
  test("a log record is one write under the size limit; a longer one is refused before anything is written", () => {
    const f = join(mkdtempSync(join(tmpdir(), "r18-log-")), "record-install.log");
    appendLog(f, { t: "flag", how: "off", by: "keeper", at: "x" });
    const size = readFileSync(f).length;
    expect(() => appendLog(f, { t: "flag", why: "x".repeat(MAX_RECORD_BYTES) })).toThrow(`over ${MAX_RECORD_BYTES} bytes`);
    expect(readFileSync(f).length).toBe(size);
  });

  test("the recover file is renamed to a taken name before the keeper acts; a line written meanwhile is kept and taken next", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r18-10-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const file = join(k.root, "pi/record-recover.json");
    // Taken by an earlier round that stopped before acting; and a new line the link wrote since.
    writeFileSync(recoverTaken(k.cfg), JSON.stringify({ said: "1570000000000000101", nonce: "a00001" }));
    writeFileSync(file, JSON.stringify({ said: "1570000000000000102", nonce: "a00002" }));
    const lines: string[] = [];
    console.log = (l: string) => { lines.push(String(l)); };
    k.cain({ id: "cain-r18-10-1", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    expect(lines.some((l) => l.includes("message 1570000000000000101"))).toBe(true);
    expect(existsSync(file)).toBe(true);                              // the newer line is untouched
    k.cain({ id: "cain-r18-10-2", ops: [{ op: "note", item: "P44", text: "a round" }] });
    cycle(k.cfg);
    expect(lines.some((l) => l.includes("message 1570000000000000102"))).toBe(true);
    expect(existsSync(file) || existsSync(recoverTaken(k.cfg))).toBe(false);
  }, 60_000);

  test("the table names the rebuild sources and the interleaving rules", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("only landing claims the link settled against the remote main");
    expect(doc).toContain("none outside the known gap");
    expect(doc).toContain("one write under 4000 bytes");
    expect(doc).toContain("renamed to record-recover.json.taken");
  });
});

describe("11. buttons come off by the post snowflake plus the lifetime, through the measured offset (invariants: the issued-key log)", () => {
  test("the Pi's clock steps days ahead, measured by a new stamp: the card keeps its buttons until Discord's time passes its expiry", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const real = realExpiry(r, id);
    stepPi(r, 3 * DAY);
    (r.link as any).noteStamp(r.snowflake());                         // a stamp after the step: the offset is known
    r.keeperVerified();
    await r.link.sweep();
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    r.t.discord += real - (r.t.now + r.t.discord) + MIN;              // Discord's time passes the card's expiry
    (r.link as any).noteStamp(r.snowflake());
    await r.link.sweep();
    expect(r.buttons(id)).toEqual([]);
  });
});

describe("12. a crash after each write and before its fsync leaves its dependent effect undone; the epoch never decreases", () => {
  // At the crash point (bytes written, not fsynced), what the write gates mustn't have happened yet.
  const at = (file: (f: string) => boolean, snap: () => void) => { crashSpy.on = (f) => { if (file(f)) { crashSpy.on = null; snap(); throw new Error("crash injected before the fsync"); } }; };

  test("the issued-key log: no card is tappable before its keys are durable", async () => {
    const r = shipRig();
    r.keeperVerified();
    let buttons: number | null = null;
    at((f) => f === r.issuedLog && !!r.last(), () => { buttons = (r.last().components ?? []).length; });
    await askCard(r).catch(() => {});
    expect(buttons).toBe(0);
  });

  test("the held log: the card doesn't say held, and Cain hears nothing, before the held record is durable", async () => {
    const r = shipRig();
    const id = await askCard(r);
    unverified(r);
    let said = "", heard = -1;
    at((f) => f.endsWith("link-held.log"), () => { said = String(r.msg(id).content); heard = r.relayed.length; });
    const n = r.relayed.length;
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    expect(said).not.toContain(TAP_HELD);
    expect(heard).toBe(n);
  });

  test("the removal queue: no edit before the strip record is durable", async () => {
    const r = shipRig();
    const id = await askCard(r);
    let edits = -1;
    const patches = () => r.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${id}`)).length;
    at((f) => f.endsWith("link-strip.log"), () => { edits = patches(); });
    const before = patches();
    await (r.link as any).queueStrip(id, "Expired").catch(() => {});
    expect(edits).toBe(before);
  });

  test("the expired-key index: no edit before the index record is durable", async () => {
    const r = shipRig();
    r.keeperVerified();
    const id = await askCard(r);
    const st = r.state(); delete st.messages[id]; r.setState(st);
    r.t.now += 3 * DAY;                                               // the Pi and Discord both three days on
    (r.link as any).noteStamp(r.snowflake());
    let edits = -1;
    const patches = () => r.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${id}`)).length;
    at((f) => f.endsWith("link-expired.log"), () => { edits = patches(); });
    const before = patches();
    await (r.link as any).expireByLog().catch(() => {});
    expect(edits).toBe(before);
  });

  test("the landing ledger: nothing is pushed before the claim is durable", async () => {
    const r = shipRig();
    const dir = mkdtempSync(join(tmpdir(), "r18-landings-"));
    (r.deps as any).landings = landingLedger(join(dir, "record-landings"), join(dir, "landings-marker.json"));
    r.keeperVerified();
    const id = await shipCard(r);
    let pushed = -1;
    at((f) => f.includes("record-landings") && f.endsWith(".json") && !f.endsWith("meta.json"), () => { pushed = r.github.landings.length; });
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(pushed).toBe(0);
    expect(r.github.landings).toHaveLength(0);
  });

  test("the install log: a once-allowed Ship tap claims no landing before its once-used record is durable", async () => {
    const r = shipRig({ installTaps: false });
    appendLog(r.installLog, { t: "flag", how: "once", by: "cain", at: "2026-11-01T00:00:00.000Z" });
    r.keeperVerified();
    const id = await shipCard(r);
    let claims = -1;
    at((f) => f === r.installLog, () => { claims = r.landLedger.keys.size; });
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    expect(claims).toBe(0);
    expect(r.github.landings).toHaveLength(0);
  });

  test("the recover file: not at its name, so the keeper can't act on it, before it is durable", async () => {
    const r = shipRig();
    await r.link.sweep();
    await r.link.recoverLogs({});
    const code = /```\n(recover logs [a-z][0-9a-f]{5})\n```/.exec(String(r.cards().filter((m: any) => String(m.content).includes("recover logs")).at(-1)!.content))![1];
    let there: boolean | null = null;
    at((f) => f === r.recoverFile, () => { there = existsSync(r.recoverFile); });
    r.t.discord += MIN;
    await r.link.recoverLogs({ said: r.his(code).id }).catch(() => {});
    expect(there).toBe(false);
  });

  test("the consumed-key log, the keeper's status and state: the status names nothing its own write hasn't made durable", () => {
    const k = keeperRig();
    k.cain({ id: "cain-r18-12-0", ops: [{ op: "note", item: "P44", text: "a round" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const at0 = k.cfg.now!().getTime(), kid = "tap-0000000fc001";
    appendLog(linkLog(k), keyRec(kid, sf(at0), at0, DAY));
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, issued: { [kid]: { item: "P11", kind: "ask", label: "Filed", msg: sf(at0), at: at0, it: sf(at0 + MIN, 2) } } }));
    k.cain({ id: "cain-r18-12-a", tap: kid, ops: [{ op: "note", item: "P11", text: "his tap" }] }, { issue: false });
    let told: string[] | null = null;
    at((f) => f.endsWith("record-taps.jsonl"), () => { told = k.states("cain-r18-12-a"); });
    cycle(k.cfg);
    expect(told).toEqual([]);                                         // Cain hears done only after the key is durable
    // The status: crashed before its fsync, the file at its name is still the last durable one.
    const before = readFileSync(join(k.root, "pi/record-ledger.json"), "utf8");
    let seen = "";
    at((f) => f.endsWith("record-ledger.json"), () => { seen = readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"); });
    k.cain({ id: "cain-r18-12-b", ops: [{ op: "note", item: "P44", text: "a round" }] });
    try { cycle(k.cfg); } catch { /* the crash */ }
    expect(seen).toBe(before);
  }, 60_000);

  test("the sweep cursor: done isn't at its name before it is durable", async () => {
    const r = shipRig();
    await r.link.sweep();
    unverified(r);
    (r.files as any).status = JSON.stringify({ ...JSON.parse(r.files.status!), consumed_unverified: { since: new Date(r.t.now).toISOString(), why: "its log of consumed tap keys is missing", tries: 0 } });
    r.restart();
    (r.link as any).noteStamp(r.snowflake());
    let done: boolean | null = null;
    at((f) => f.endsWith("link-sweep.json"), () => { try { done = JSON.parse(readFileSync(side(r, "link-sweep.json"), "utf8")).done; } catch { done = false; } });
    await r.link.sweep().catch(() => {});
    expect(done).toBe(false);
  });

  for (const [what, stateN, statusN] of [["a status restored from an older snapshot", 3, 1], ["a keeper state restored from an older snapshot", 1, 3]] as const) {
    test(`the epoch never decreases: ${what} keeps the higher epoch`, () => {
      const k = keeperRig();
      k.cain({ id: "cain-r18-12-e0", ops: [{ op: "note", item: "P44", text: "a round" }] });
      expect(cycle(k.cfg).ok).toBe(true);
      const holds = JSON.parse(readFileSync(k.cfg.holds!, "utf8"));
      writeFileSync(k.cfg.holds!, JSON.stringify({ ...holds, epoch: { n: stateN, at: "2026-11-10T00:00:00.000Z", generation: 5, voided: true } }));
      const st = status(k);
      writeFileSync(join(k.root, "pi/record-ledger.json"), JSON.stringify({ ...st, epoch: { n: statusN, at: "2026-11-09T00:00:00.000Z", generation: 4, voided: true } }));
      k.cain({ id: "cain-r18-12-e1", ops: [{ op: "note", item: "P44", text: "a round" }] });
      cycle(k.cfg);
      expect(status(k).epoch.n).toBe(3);
    }, 60_000);
  }

  test("the table lists which rows have a crash-injection test", () => {
    const doc = flat(INVARIANTS);
    expect(doc).toContain("Crash-injection tests");
    for (const row of ["the issued-key log", "the link state", "the held log", "the removal queue", "the expired-key index", "the sweep cursor",
      "the landing ledger", "the consumed-key log", "the install log", "the keeper status", "the recover file"]) expect(doc).toContain(row);
  });
});

void CARD_CHECKING; void CLOCK_TOLERANCE_MS;
