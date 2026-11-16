// Source checks, eighth review round (0.12.0): orphaned landings settled against the remote main (and
// a re-ship of what is there already a no-op), a durable, bounded, link-owned landing ledger that is
// checked against the remote after a restore, a waiting second tap that answers busy at once, an
// abandoned landing told to both, the forced webhook failure, one request per tap key at the keeper,
// the outage notice's Ship-tap hold, and the roll-forward. (Claim completion through the live-tap
// predicate is in round 7's file, test "round 8: a pre-reset claim ...".)
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABANDONED_TAP, tapKid } from "../rootfs/opt/cain/link/core";
import { LANDING_KEEP_MS, keyName, landingLedger } from "../rootfs/opt/cain/link/landings";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { DAY, MIN, PR, SHA1, SHA2, pendingWith, rig as linkRig } from "./link-rig";
import { rig as keeperRig } from "./rig.ts";

const realLog = console.log;
afterEach(() => { console.log = realLog; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
const CHECKED = "the pull request on GitHub, open at that head, read at 8";
const WORDS = "Stop stays within reach of your newest message.";

const shipRig = () => linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
const shipCard = async (r: ReturnType<typeof linkRig>, head = SHA1) =>
  (await r.link.ship({ item: "P41", pr: PR, head, text: WORDS, checked: CHECKED }) as any).message as string;
const shipLines = (r: ReturnType<typeof linkRig>) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
const abandonedLines = (r: ReturnType<typeof linkRig>) => r.relayed.filter((x) => x.startsWith("Landing abandoned:"));
const threadOf = (r: ReturnType<typeof linkRig>, id: string, text: string) =>
  r.cards().filter((m: any) => m.content === text && m.message_reference?.message_id === id);
// A Ship tap whose landing starts (its key claimed) and is then cut off by a restart.
async function cutOff(r: ReturnType<typeof linkRig>) {
  const id = await shipCard(r);
  r.github.hold = true;
  void r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
  await wait(10);
  expect(r.github.landings).toHaveLength(1);
  expect(r.landLedger.keys.size).toBe(1);
  r.restart();
  r.github.hold = false;
  return id;
}
const sweeps = async (r: ReturnType<typeof linkRig>, n = 3) => { for (let i = 0; i < n; i++) { r.later(5 * MIN); await r.link.sweep(); await r.link.whenLanded(); } };

describe("2. orphaned landings settled against the remote main", () => {
  test("a push that reached the remote before the process died: settled as landed from the remote, never pushed again", async () => {
    const r = shipRig();
    const id = await cutOff(r);
    r.github.main.push(SHA1);                                        // the push reached GitHub before the restart
    await sweeps(r);
    expect(r.github.landings).toHaveLength(1);
    expect(shipLines(r)).toHaveLength(1);
    expect(shipLines(r)[0]).toContain("The link landed it");
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(r.logs.join("\n")).toContain("settled from the remote main");
    expect(r.landLedger.settled.get([...r.landLedger.keys][0])).toBe("landed");
  });

  test("the remote unreachable: the key stays unresolved and no new Ship card goes out, until GitHub answers", async () => {
    const r = shipRig();
    const id = await cutOff(r);
    r.github.readable = false;
    await sweeps(r);
    expect(r.state().messages[id].shipping!.state).toBe("landing");
    expect(shipLines(r)).toHaveLength(0);
    expect(r.landLedger.settled.size).toBe(0);
    expect(r.logs.join("\n")).toContain("it stays unresolved, and no new Ship card goes out for it");
    await expect(shipCard(r)).rejects.toThrow("landing for this pull request and head isn't settled yet");
    expect(r.github.landings).toHaveLength(1);
  });

  test("before any landing the remote is read: a re-ship of a head already in main pushes nothing and is reported landed", async () => {
    const r = shipRig();
    r.github.main.push(SHA1);
    const id = await shipCard(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(shipLines(r)[0]).toContain("main has that commit now (it was there already)");
    expect(r.logs.join("\n")).toContain("is in the remote main already: nothing pushed, reported as landed");
  });
});

describe("5. an abandoned landing is told", () => {
  test("settled as not landed after a restart: one line on the card's thread, one 'landing abandoned' line to Cain, then a new card posts", async () => {
    const r = shipRig();
    const id = await cutOff(r);
    r.github.readable = false;
    await sweeps(r, 2);
    r.github.readable = true;                                        // GitHub answers: main doesn't have it
    await sweeps(r);
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", abandoned: true });
    expect(threadOf(r, id, ABANDONED_TAP)).toHaveLength(1);
    expect(ABANDONED_TAP).toBe("The install was interrupted by a restart and did not land; a new card follows.");
    expect(abandonedLines(r)).toHaveLength(1);
    expect(abandonedLines(r)[0]).toContain(`show a new Ship card for the same pull request and head (${PR} at ${SHA1})`);
    expect(abandonedLines(r)[0]).toContain(`Tap key ${tapKid([...r.landLedger.keys][0])}`);
    expect(r.landLedger.settled.get([...r.landLedger.keys][0])).toBe("not landed");
    await sweeps(r);
    expect(abandonedLines(r)).toHaveLength(1);
    expect(threadOf(r, id, ABANDONED_TAP)).toHaveLength(1);
    // Cain's new Ship card for the same pull request and head posts, and its tap lands once.
    const again = await shipCard(r);
    expect(await r.tap(structuredClone(r.msg(again)), r.ids(again)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(2);
    expect(r.github.main).toEqual([SHA1]);
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("Landing abandoned");
  });
});

describe("3. the landing ledger: durable, bounded, and checked after a restore", () => {
  test("the claim file and its directory are fsynced before the first push attempt", async () => {
    const r = shipRig();
    const dir = mkdtempSync(join(tmpdir(), "landings-"));
    const events: string[] = [];
    const d = (r.link as any).d;
    d.landings = landingLedger(join(dir, "ledger"), join(dir, "link/landings-marker.json"), { sync: (w) => events.push(w) });
    const land = d.land;
    d.land = (l: any) => { events.push("push"); return land(l); };
    const id = await shipCard(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    const push = events.indexOf("push");
    expect(push).toBeGreaterThan(-1);
    expect(events.indexOf("file")).toBeGreaterThan(-1);
    expect(events.indexOf("file")).toBeLessThan(push);
    expect(events.indexOf("dir")).toBeGreaterThan(events.indexOf("file"));
    expect(events.indexOf("dir")).toBeLessThan(push);
    // Settled once landed, and the marker outside the ledger counts the claim.
    const entries = d.landings.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].settled.how).toBe("landed");
    expect(JSON.parse(readFileSync(join(dir, "link/landings-marker.json"), "utf8")).count).toBe(1);
    expect(r.state().landingCount).toBe(1);
  });

  test("settled keys are pruned by the link after 30 days, unsettled ones never; the keeper never touches the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landings-"));
    const L = landingLedger(join(dir, "ledger"), join(dir, "marker.json"));
    const at = Date.UTC(2026, 10, 1);
    expect(L.claim("k1", { pr: PR, head: SHA1, at: new Date(at).toISOString() })).toBe(true);
    expect(L.claim("k2", { pr: PR, head: SHA2, at: new Date(at).toISOString() })).toBe(true);
    L.settle("k1", "landed", new Date(at).toISOString());
    expect(L.prune(at + LANDING_KEEP_MS - DAY)).toBe(0);
    expect(L.prune(at + LANDING_KEEP_MS + DAY)).toBe(1);
    expect(L.entries()!.map((e) => e.key)).toEqual(["k2"]);
    expect(L.prune(at + 10 * LANDING_KEEP_MS)).toBe(0);              // unsettled: kept
    // The link prunes from its sweep (once a day).
    const r = shipRig();
    await r.link.sweep();
    expect(r.landLedger.pruned).toBe(1);
    await r.link.sweep();
    expect(r.landLedger.pruned).toBe(1);
    r.later(DAY);
    await r.link.sweep();
    expect(r.landLedger.pruned).toBe(2);
    // A keeper round beside a ledger with an old settled key leaves the directory as it is.
    const k = keeperRig();
    const kl = landingLedger(join(k.root, "pi/record-landings"), join(k.root, "pi/link/landings-marker.json"));
    kl.claim("old", { pr: PR, head: SHA1, at: "2026-01-01T00:00:00.000Z" });
    kl.settle("old", "landed", "2026-01-01T00:00:00.000Z");
    const before = readdirSync(join(k.root, "pi/record-landings")).sort();
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readdirSync(join(k.root, "pi/record-landings")).sort()).toEqual(before);
    const keeper = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    expect(keeper).not.toContain("claimLanding");
    expect(flat("../DOCS.md")).toContain("The record keeper never writes or cleans that directory");
  }, 30_000);

  test("a ledger restored from a backup is untrusted until each key was looked for on the remote main by its head", async () => {
    const r = shipRig();
    const dir = mkdtempSync(join(tmpdir(), "landings-"));
    const ledger = join(dir, "ledger"), marker = join(dir, "link/landings-marker.json");
    const d = (r.link as any).d;
    let L = landingLedger(ledger, marker);
    expect(L.claim("k1", { pr: PR, head: SHA1, at: "2026-11-11T13:00:00.000Z" })).toBe(true);
    cpSync(ledger, join(dir, "backup"), { recursive: true });       // the backup, taken here
    expect(L.claim("k2", { pr: PR, head: SHA2, at: "2026-11-11T14:00:00.000Z" })).toBe(true);
    r.github.main.push(SHA1, SHA2);                                  // both landed after the backup
    rmSync(ledger, { recursive: true, force: true });
    cpSync(join(dir, "backup"), ledger, { recursive: true });        // restored: behind the marker
    L = landingLedger(ledger, marker);
    d.landings = L;
    expect(L.untrusted()).toContain("behind the 2 the link's marker holds");
    expect(L.claim("k3", { pr: PR, head: SHA2, at: "2026-11-11T15:00:00.000Z" })).toBeNull();
    r.github.readable = false;
    await r.link.sweep();
    expect(L.untrusted()).not.toBeNull();                            // GitHub can't be read: still untrusted
    expect(r.logs.join("\n")).toContain("it stays untrusted, and no landing starts");
    r.github.readable = true;
    r.later(2 * MIN);                                                // round 9: looked for again on the backoff
    await r.link.sweep();
    expect(L.untrusted()).toBeNull();
    expect(L.entries()!.find((e) => e.key === "k1")!.settled!.how).toBe("landed");
    expect(r.logs.join("\n")).toContain("the restored landing ledger was checked against the remote main (1 key(s)): trusted again");
    expect(L.claim("k3", { pr: PR, head: SHA2, at: "2026-11-11T15:00:00.000Z" })).toBe(true);
    // A ledger lost while the link's state still counts its claims is caught the same way.
    const L2 = landingLedger(join(dir, "gone"), join(dir, "no-marker.json"));
    expect(L2.untrusted(3)).toContain("behind the 3 the link's state holds");
    expect(keyName("k1")).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(join(ledger, `${keyName("k1")}.json`))).toBe(true);
  });
});

describe("4. a waiting second tap", () => {
  test("the first tap is slow: the second answers busy at once at the read limit, starts nothing, and the first counts once", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: "the county portal, read at 8" }) as any;
    const id = out.message as string;
    const link = r.link as any;
    link.d.tapReadMs = 50;
    const orig = link.onQuestion.bind(link);
    link.onQuestion = async (...a: any[]) => { await wait(300); return orig(...a); };
    const card = structuredClone(r.msg(id));
    const first = r.tap(card, r.ids(id)[0]);
    await wait(5);
    const t0 = Date.now();
    expect(await r.tap(structuredClone(card), r.ids(id)[1])).toBe("refused: busy");
    expect(Date.now() - t0).toBeLessThan(250);
    expect(r.ephemerals().at(-1).content).toBe("Busy, tap again.");
    expect(r.logs.join("\n")).toContain("hadn't settled within the read limit (50 ms); answered busy, nothing started");
    expect(await first).toBe("to Cain");
    const lines = r.relayed.filter((x) => x.includes("Dane tapped"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"Filed"`);
    expect(Object.keys(r.state().taps!)).toHaveLength(1);
  });
});

describe("6. card authorship and the forced webhook failure", () => {
  test("keeper.sh fail-webhook: the next busy tap's webhook patch fails, and the buttons come back by the bot's own edit", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: "the county portal, read at 8" }) as any;
    const id = out.message as string;
    const d = (r.link as any).d;
    d.tapReadMs = 30;
    d.readFresh = () => new Promise(() => {});
    expect(r.link.failWebhook().status).toBe("ok");
    const card = structuredClone(r.msg(id));
    r.msg(id).components = [];                                       // as the deferred answer left it
    expect(await r.tap(card, card.components[0].components[0].custom_id)).toBe("refused: busy");
    expect(r.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/webhooks/"))).toBe(false);
    const i = r.calls.findIndex((c) => c.method === "PATCH" && c.path === `/channels/5151/messages/${id}`);
    expect(i).toBeGreaterThan(-1);
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(r.logs.join("\n")).toContain("forced by the smoke test (keeper.sh fail-webhook)");
    expect(r.logs.join("\n")).toContain("editing it by channel and message id");
    const sh = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).toContain(`fail-webhook) url="$link/failwebhook"`);
    expect(flat("../DOCS.md")).toContain("The link posts cards as the bot");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("/opt/cain/keeper.sh fail-webhook");
  });
});

describe("7. one request per tap key at the keeper", () => {
  test("a request citing a consumed tap key is refused; its own replay and a request with no key are not", () => {
    const k = keeperRig();
    const note = (text: string) => [{ op: "note", item: "P11", text }];
    k.cain({ id: "cain-tap-1", tap: "tap-0123456789ab", ops: note("Dane tapped Filed") });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-tap-1")).toEqual(["done"]);
    k.cain({ id: "cain-tap-2", tap: "tap-0123456789ab", ops: note("Dane tapped Filed, again") });
    k.cain({ id: "cain-tap-3", ops: note("no tap key") });
    k.cain({ id: "cain-tap-4", tap: "Filed", ops: note("a bad key") });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-tap-2")).toEqual(["rejected"]);
    expect(k.reason("cain-tap-2")).toContain("tap key tap-0123456789ab was already acted on by request cain-tap-1");
    expect(k.states("cain-tap-3")).toEqual(["done"]);
    expect(k.states("cain-tap-4")).toEqual(["rejected"]);
    expect(k.reason("cain-tap-4")).toContain("tap, when given, is the tap key");
    // Kept in the keeper's own state, outside the working copy: a re-clone forgets nothing.
    expect(k.kept().taps["tap-0123456789ab"].id).toBe("cain-tap-1");
    rmSync(k.cfg.dir, { recursive: true, force: true });
    expect(cycle(k.cfg).ok).toBe(true);
    k.cain({ id: "cain-tap-5", tap: "tap-0123456789ab", ops: note("after a re-clone") });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-tap-5")).toEqual(["rejected"]);
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain(`"tap": "tap-`);
  }, 30_000);
});

describe("8. the outage notice, the re-check count, and tap_read_ms from the measured p95", () => {
  test("keeper.sh clock shows the pending re-checks and whether Ship taps are held; the check-in counts them; DOCS say how to set tap_read_ms", () => {
    const r = shipRig();
    r.files.status = JSON.stringify({ unpushed: true, recheck_pending: 2, clock: { synced: true, source: "kernel", diagnostic: "ok", at: new Date(r.t.now).toISOString() } });
    const c = r.link.clockReport() as any;
    expect(c.keeper.recheck_pending).toBe(2);
    expect(c.keeper.ship_taps_held).toBe(true);
    expect(c.recheck_pending).toBe(2);
    const checkin = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/checkin.sh"), "utf8");
    expect(checkin).toContain("Pending re-check after the record's reset: $rp item(s)");
    expect(flat("../DOCS.md")).toContain("set tap_read_ms from the measured p95");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("/opt/cain/keeper.sh reads 20");
  });
});

// 9. The roll-forward moved to round 9 (source-check-round9.test.ts): run ids, not file times.

describe("10. the docs", () => {
  test("DOCS.md and the rules state the guarantee, the ledger, and the notes on the other pull requests", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    expect(docs).toContain("at most one unmarked line per tap key and at most one landing per tap");
    expect(docs).toContain("Attested, not enforced");
    expect(docs).toContain("pull request 20 lands first");
    expect(docs).toContain("/data/link/landings-marker.json");
    expect(rules).toContain("Landing abandoned");
    expect(flat("../CHANGELOG.md")).toContain("did not land; a new card follows");
  });
});
