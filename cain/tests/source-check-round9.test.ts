// Source checks, ninth review round (0.12.0): an unreachable remote never wedges a landing silently
// (bounded backoff, told once each, listed by keeper.sh clock), the roll-forward judged by run ids and
// the live-tap predicate (never file times), the landing token's search from the claim's base to the
// remote tip (shallow and rewritten mains answer unresolved, never "did not land"), lost claims told
// with the re-check queue, the authorization boundary of an in-flight landing, tap keys required at
// the keeper for tap-derived requests and pruned after three days, and the fixture's regeneration.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABANDONED_TAP, NOT_ACTED_TAP, LOST_TAP, UNRESOLVED_TELL_FAILS, UNRESOLVED_TELL_MS, tapKid, unconfirmedTap } from "../rootfs/opt/cain/link/core";
import { settledFrom, type MergeDeps } from "../rootfs/opt/cain/link/merge";
import { parseRequest, tapDerived } from "../rootfs/opt/cain/record/core.ts";
import { cycle, pruneTaps, TAP_KEEP_MS } from "../rootfs/opt/cain/record/main.ts";
import { Link as OldLink } from "./fixtures/link-0.11.0/core";
import { DAY, MIN, PR, SHA1, SHA2, pendingWith, rig as linkRig } from "./link-rig";
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
const shipCard = async (r: R, head = SHA1) =>
  (await r.link.ship({ item: "P41", pr: PR, head, text: WORDS, checked: `${CHECKED} (${++checks})` }) as any).message as string;
const askCard = async (r: R, item = "P08") =>
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: "the county portal, read at 8" }) as any).message as string;
const shipLines = (r: R) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
const unconfirmedLines = (r: R) => r.relayed.filter((x) => x.startsWith("Landing unconfirmed:"));
const notActedLines = (r: R) => r.relayed.filter((x) => x.includes("Tap not acted:"));
const lostLines = (r: R) => r.relayed.filter((x) => x.includes("was lost to the record's reset, please answer again"));
const onThread = (r: R, id: string, text: string | ((t: string) => boolean)) =>
  r.cards().filter((m: any) => m.message_reference?.message_id === id && (typeof text === "string" ? m.content === text : text(String(m.content))));
const sweeps = async (r: R, n = 3, step = 5 * MIN) => { for (let i = 0; i < n; i++) { r.later(step); await r.link.sweep(); await r.link.whenLanded(); } };
// A Ship tap whose landing starts (its key claimed) and is then cut off by a restart.
async function cutOff(r: R) {
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
// An ask's tap claimed and then cut off before anything was done (the relay dies).
async function cutClaim(r: R, id: string) {
  const d = (r.link as any).d, relay = d.relay;
  d.relay = () => { throw new Error("killed"); };
  await expect(r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).rejects.toThrow("killed");
  d.relay = relay;
  const key = Object.keys(r.state().taps!).find((k) => r.state().taps![k].msg === id)!;
  expect(r.state().taps![key].stage).toBe("claimed");
  return key;
}

describe("1. an unreachable remote never wedges a landing silently", () => {
  test("a remote that recovers after two failures: no message to either, and the key settles", async () => {
    const r = shipRig();
    const id = await cutOff(r);
    r.github.readable = false;
    await sweeps(r, 2);
    const key = [...r.landLedger.keys][0];
    expect(r.state().unresolved![key]).toMatchObject({ fails: 2, what: "orphan" });
    expect((r.link.clockReport() as any).unresolved_landings).toHaveLength(1);
    r.github.readable = true;
    r.github.main.push(SHA1);                                         // the push had reached GitHub
    await sweeps(r, 1);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(shipLines(r)).toHaveLength(1);
    expect(unconfirmedLines(r)).toHaveLength(0);
    expect(onThread(r, id, (t) => t.startsWith("Landing unconfirmed:"))).toHaveLength(0);
    expect(r.state().unresolved).toBeUndefined();
    expect((r.link.clockReport() as any).unresolved_landings).toEqual([]);
    expect(r.logs.join("\n")).toContain("resolved against the remote main after 2 failed look(s)");
  });

  test("one that stays down past T: one line on the thread and one to Cain, once each; keeper.sh clock lists it; it settles when the remote returns", async () => {
    const r = shipRig();
    const id = await cutOff(r);
    const tapped = r.t.now;
    r.github.readable = false;
    r.github.unreadableWhy = "GitHub couldn't be fetched from (ssh: connect to host github.com port 22: Connection timed out)";
    // Looked for again on the backoff (1, 2, 4, then every 5 minutes) with no tap or restart: the
    // sweep runs each minute, the looks at 8:05, 8:06, 8:08, 8:12, 8:17.
    await sweeps(r, 1);
    await sweeps(r, 11, MIN);
    expect(r.state().unresolved![[...r.landLedger.keys][0]].fails).toBe(4);
    expect(unconfirmedLines(r)).toHaveLength(0);                       // 4 failures, under 15 minutes since the first
    await sweeps(r, 5, MIN);
    const key = [...r.landLedger.keys][0];
    const u = r.state().unresolved![key];
    expect(r.t.now - u.since >= UNRESOLVED_TELL_MS || u.fails >= UNRESOLVED_TELL_FAILS).toBe(true);
    expect(unconfirmedLines(r)).toHaveLength(1);
    expect(unconfirmedLines(r)[0]).toContain(`tap key ${tapKid(key)}`);
    expect(unconfirmedLines(r)[0]).toContain("last error: GitHub couldn't be fetched from");
    const thread = onThread(r, id, (t) => t.startsWith("Landing unconfirmed:"));
    expect(thread).toHaveLength(1);
    expect(thread[0].content).toBe(unconfirmedTap("8:05 AM", true));
    expect(thread[0].content).toBe("Landing unconfirmed: main's remote has been unreachable since 8:05 AM, retrying.");
    void tapped;
    const clock = (r.link.clockReport() as any).unresolved_landings;
    expect(clock).toHaveLength(1);
    expect(clock[0]).toMatchObject({ tap_key: tapKid(key), what: "orphan", told: true });
    expect(clock[0].age_min).toBeGreaterThanOrEqual(15);
    expect(clock[0].last_error).toContain("Connection timed out");
    await sweeps(r, 4);
    expect(unconfirmedLines(r)).toHaveLength(1);
    expect(onThread(r, id, (t) => t.startsWith("Landing unconfirmed:"))).toHaveLength(1);
    // The remote comes back: main doesn't have it, so the usual abandoned outcome follows, told once.
    r.github.readable = true;
    await sweeps(r, 2);
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", abandoned: true });
    expect(onThread(r, id, ABANDONED_TAP)).toHaveLength(1);
    expect(r.relayed.filter((x) => x.startsWith("Landing abandoned:"))).toHaveLength(1);
    expect(r.state().unresolved).toBeUndefined();
    const again = await shipCard(r);                                  // and a new card posts
    expect(r.buttons(again)).toEqual(["Ship", "Not now"]);
    const docs = flat("../DOCS.md");
    expect(docs).toContain("UNRESOLVED_TELL_FAILS");
    expect(docs).toContain("UNRESOLVED_TELL_MS");
  });

  test("a restored ledger's remote check backs off the same way, and is told once when it stays down", async () => {
    const r = shipRig();
    r.landLedger.keys.add("k-restored");
    r.landLedger.what.set("k-restored", { pr: PR, head: SHA1, at: "2026-11-11T12:00:00.000Z", base: "0".repeat(40) });
    r.landLedger.untrusted = "the ledger has 1 claims, behind the 2 the link's marker holds";
    r.github.readable = false;
    await sweeps(r, 20, MIN);
    const u = r.state().unresolved!["k-restored"];
    expect(u.what).toBe("ledger");
    expect(u.fails).toBe(6);                                           // backed off: 6 looks in 20 sweeps
    expect(unconfirmedLines(r)).toHaveLength(1);
    expect(unconfirmedLines(r)[0]).toContain("restored landing ledger's key");
    r.github.readable = true;
    r.github.main.push(SHA1);
    await sweeps(r, 1);
    expect(r.landLedger.untrusted).toBeNull();
    expect(r.landLedger.settled.get("k-restored")).toBe("landed");
    expect(r.state().unresolved).toBeUndefined();
    expect(r.github.bases).toContain("0".repeat(40));
  });
});

describe("2. the roll-forward goes by run ids, never by file times", () => {
  test("a backwards clock step, with an outstanding claim and the previous link processing taps in between: discarded through the predicate and told", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const key = await cutClaim(r, ask);
    expect(r.state().run).toBe(1);
    expect(r.state().taps![key].run).toBe(1);
    const ship = await shipCard(r);
    r.github.hold = true;
    void r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    await wait(10);
    expect(r.landLedger.keys.size).toBe(1);
    // The previous version runs on that state: it lands the Ship tap and processes a tap of its own
    // on a new card.
    r.github.hold = false;
    r.later(10 * MIN);
    const old = new OldLink(r.deps as any);
    await old.sweep();
    await old.whenLanded();
    expect(r.github.main).toEqual([SHA1]);
    const oldShip = await old.ship({ item: "P41", pr: PR, head: SHA2, text: WORDS }) as any;
    expect(await old.onInteraction({ type: 3, id: "992", token: "t", application_id: "999", channel_id: "5151", user: { id: "4242" },
      data: { custom_id: r.ids(oldShip.message)[0] }, message: structuredClone(r.msg(oldShip.message)) })).toBe("to Cain");
    await old.whenLanded();
    expect(r.github.main).toEqual([SHA1, SHA2]);
    // Meanwhile P08's row changed: its check no longer passes the live-tap predicate.
    const ledger = JSON.parse(r.files.checks!);
    ledger.P08.version = 2;
    r.files.checks = JSON.stringify(ledger);
    const before = r.relayed.filter((x) => x.includes("Dane tapped")).length;
    // Then the clock steps back 30 minutes, to before this version's last write, and this version
    // starts again: only the run id and the predicate decide.
    r.t.now -= 30 * MIN;
    r.restart();
    await r.link.sweep();
    await r.link.whenLanded();
    expect(r.state().run).toBe(2);
    expect(r.relayed.filter((x) => x.includes("Dane tapped")).length).toBe(before);   // never acted
    expect(notActedLines(r)).toHaveLength(1);
    expect(notActedLines(r)[0]).toContain(`tap key ${tapKid(key)}`);
    expect(notActedLines(r)[0]).toContain("its status changed since it was checked");
    expect(notActedLines(r)[0]).toContain("P08 is on the link's re-check queue");
    expect(onThread(r, ask, NOT_ACTED_TAP)).toHaveLength(1);
    expect(r.state().recheck?.P08).toBeDefined();
    await r.link.sweep();
    expect(notActedLines(r)).toHaveLength(1);
    expect(onThread(r, ask, NOT_ACTED_TAP)).toHaveLength(1);
    expect(r.state().taps![key]).toMatchObject({ stage: "edited", outcome: "not acted", told: true });
    expect(r.msg(ask).content).toEndWith("Not acted after a restart, re-check needed");
    // The ledger's key for the cut-off landing gives no wrong result: a new card for that head, tapped,
    // finds it in the remote main and pushes nothing.
    const again = await shipCard(r);
    expect(await r.tap(structuredClone(r.msg(again)), r.ids(again)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.landings.filter((l) => l.head === SHA1)).toHaveLength(2);
    expect(r.relayed.at(-1)).toContain("(it was there already)");
    // A fresh card after the re-check is accepted takes P08 off the queue.
    ledger.P08.version = 2;
    const fresh = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2", checked: "the county portal again, read at 9" }) as any;
    expect(fresh.status).toBe("posted");
    expect(r.state().recheck).toBeUndefined();
  });

  // Round 18: a claim is judged by Discord's time for its tap (the claim's interaction id), so a forwards step of
  // the Pi's clock past the check's age alone no longer discards it (a tap Discord dates past the check's age is
  // refused: source-check-round18.test.ts, item 1).
  test("a forwards clock step past the check's age: the claim, judged by Discord's time for its tap, is finished once", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const key = await cutClaim(r, ask);
    r.later(8 * DAY);                                                 // the Pi's clock past source_check_max_days (7)
    r.t.discord = -8 * DAY;                                           // Discord's time hasn't moved
    r.restart();
    await r.link.sweep();
    expect(notActedLines(r)).toHaveLength(0);
    expect(r.state().taps![key].outcome).not.toBe("not acted");
    expect(r.relayed.filter((x) => x.includes(`Tap key ${key.startsWith("tap-") ? key : ""}`) || x.includes("Dane tapped"))).toHaveLength(1);
  });

  test("a legitimate claim across a restart of the same version completes normally, once", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const key = await cutClaim(r, ask);
    r.later(MIN);
    r.restart();
    await r.link.sweep();
    await r.link.sweep();
    const lines = r.relayed.filter((x) => x.includes("Dane tapped"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`Repeat of tap key ${tapKid(key)}`);
    expect(notActedLines(r)).toHaveLength(0);
    expect(r.state().taps![key].stage).toBe("edited");
    expect(r.state().run).toBe(2);
    expect(r.logs.join("\n")).toContain("from link run 1 passes the live-tap predicate: acted on");
  });

  test("the file-time comparison is gone", () => {
    const core = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/core.ts"), "utf8");
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    for (const t of [core, main]) { expect(t).not.toContain("lastWriter"); expect(t).not.toContain("mtime"); expect(t).not.toContain("savedAt"); }
    expect(flat("../DOCS.md")).toContain("never by file times or save stamps");
  });
});

// A real git repo standing in for GitHub, and the link's own copy of it, for settledFrom.
function gitWorld() {
  const root = mkdtempSync(join(tmpdir(), "settle-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as Record<string, string>;
  for (const k of Object.keys(env)) if (k.startsWith("GIT_DIR") || k === "GIT_WORK_TREE") delete env[k];
  const run = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(["git", ...a], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const ok = (cwd: string, ...a: string[]) => { const r = run(cwd, ...a); if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.err}`); return r.out.trim(); };
  const seed = join(root, "seed"), remote = join(root, "remote.git");
  ok(root, "init", "--quiet", "-b", "main", seed);
  const commit = (msg: string) => { writeFileSync(join(seed, "f.txt"), `${msg}\n`); ok(seed, "add", "-A"); ok(seed, "commit", "--quiet", "-m", msg); return ok(seed, "rev-parse", "HEAD"); };
  const c0 = commit("c0"), c1 = commit("c1"), base = commit("base"), head = commit("head"), c4 = commit("c4");
  ok(root, "clone", "--quiet", "--bare", seed, remote);
  const url = `file://${remote}`;
  const copy = (depth?: number) => {
    const dir = join(root, `link-${Math.random().toString(16).slice(2)}`);
    ok(root, "clone", "--quiet", "--bare", ...(depth ? ["--depth", String(depth)] : []), url, dir);
    return dir;
  };
  const deps = (dir: string, refuse?: RegExp): MergeDeps => ({
    api: async () => ({ status: 404, body: null }),
    stopped: () => false,
    remote: () => url,
    git: async (args) => (refuse && refuse.test(args.join(" ")) ? { code: 128, out: "", err: "fatal: the server refused to deepen" } : run(dir, ...args)),
  });
  return { root, seed, remote, ok, run, copy, deps, c0, c1, base, head, c4, url };
}

describe("3. the landing token's search, from the claim's base to the remote tip", () => {
  test("a full copy: landed is true, a commit not in main is false", async () => {
    const w = gitWorld();
    const d = w.deps(w.copy());
    expect(await settledFrom(d, "o/r", w.head, w.base)).toEqual({ inMain: true });
    w.ok(w.seed, "checkout", "--quiet", "-b", "side", w.base);
    writeFileSync(join(w.seed, "g.txt"), "side\n"); w.ok(w.seed, "add", "-A"); w.ok(w.seed, "commit", "--quiet", "-m", "side");
    const side = w.ok(w.seed, "rev-parse", "HEAD");
    expect(await settledFrom(d, "o/r", side, w.base)).toEqual({ inMain: false });
  });

  test("a shallow clone: deepened to search the range; one that can't be deepened is unresolved, never 'did not land'", async () => {
    const w = gitWorld();
    const shallow = w.copy(1);
    expect(w.ok(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    const blocked = await settledFrom(w.deps(shallow, /--unshallow/), "o/r", w.head, w.base);
    expect("unresolved" in blocked && blocked.unresolved).toContain("shallow and couldn't be deepened");
    expect(await settledFrom(w.deps(shallow), "o/r", w.head, w.base)).toEqual({ inMain: true });
    expect(w.ok(shallow, "rev-parse", "--is-shallow-repository")).toBe("false");
  });

  test("a rewritten main where the base is gone: unresolved, never 'did not land'", async () => {
    const w = gitWorld();
    const d = w.deps(w.copy());
    // main rewritten on the remote: a new history without the base (or the head).
    w.ok(w.seed, "checkout", "--quiet", "--orphan", "rewritten");
    writeFileSync(join(w.seed, "f.txt"), "new root\n"); w.ok(w.seed, "add", "-A"); w.ok(w.seed, "commit", "--quiet", "-m", "new root");
    w.ok(w.seed, "push", "--quiet", "--force", w.remote, "rewritten:main");
    w.ok(w.remote, "gc", "--quiet", "--prune=now");
    const fresh = w.deps(w.copy());                                    // a copy that never saw the base
    const r1 = await settledFrom(fresh, "o/r", w.head, w.base);
    expect("unresolved" in r1 && r1.unresolved).toContain("isn't in main's history any more (main was rewritten)");
    const r2 = await settledFrom(d, "o/r", w.head, w.base);           // a copy that still has the base
    expect("unresolved" in r2 && r2.unresolved).toContain("isn't an ancestor of main any more (main was rewritten)");
  });

  test("the claim records main's tip as its base, settlement searches from it, and an unsearchable range stays unresolved (item 1), never abandoned", async () => {
    const r = shipRig();
    r.github.main.push(SHA2);                                         // main's tip when the tap lands
    const id = await cutOff(r);
    const key = [...r.landLedger.keys][0];
    expect(r.landLedger.what.get(key)!.base).toBe(SHA2);
    r.github.readable = false;
    r.github.unreadableWhy = "the landing's base commit 222222222222 isn't in main's history any more (main was rewritten)";
    await sweeps(r, 6);
    expect(r.state().messages[id].shipping!.state).toBe("landing");
    expect(r.relayed.filter((x) => x.startsWith("Landing abandoned:"))).toHaveLength(0);
    expect(onThread(r, id, "Landing unconfirmed: main's history couldn't be searched since 8:05 AM, retrying.")).toHaveLength(1);
    expect(r.github.bases.filter((b) => b === SHA2).length).toBeGreaterThan(0);
    const docs = flat("../DOCS.md");
    expect(docs).toContain("the landing's token is the pull request's head commit itself");
    expect(docs).toContain("from the landing's recorded base commit to the remote tip");
  });
});

describe("5. the authorization boundary of an in-flight landing", () => {
  test("a reset that wins before the landing starts: nothing pushed, the tap lost and told once each, the item on the re-check queue", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    const d = (r.link as any).d, tip = d.mainTip;
    d.mainTip = async (pr: string) => {                              // the reset lands right before the claim
      r.files.status = JSON.stringify({ epoch: { n: 1, at: new Date(r.t.now).toISOString(), generation: 1, voided: true } });
      return tip(pr);
    };
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(r.landLedger.keys.size).toBe(0);
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", why: "the record was reset before it landed" });
    expect(lostLines(r)).toHaveLength(1);
    expect(onThread(r, id, LOST_TAP)).toHaveLength(1);
    expect(r.state().recheck?.P41).toBeDefined();
    expect(shipLines(r)).toHaveLength(0);
    await r.link.sweep();
    expect(lostLines(r)).toHaveLength(1);
    expect(onThread(r, id, LOST_TAP)).toHaveLength(1);
  });

  test("a reset after the remote accepted the push but before local settlement: settled as landed, with its ledger mark", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    const d = (r.link as any).d, land = d.land;
    d.land = async (l: any) => {
      const out = await land(l);                                     // GitHub took the push
      r.files.status = JSON.stringify({ reset: { at: new Date(r.t.now).toISOString(), why: "forced conflict" } });
      return out;
    };
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.main).toEqual([SHA1]);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(r.landLedger.settled.get([...r.landLedger.keys][0])).toBe("landed");
    expect(shipLines(r)[0]).toContain("The link landed it");
    expect(lostLines(r)).toHaveLength(0);
    expect(flat("../DOCS.md")).toContain("a reset does not revoke it");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("a reset no longer revokes it");
  });
});

describe("6. tap keys required at the keeper", () => {
  test("tapDerived names the request kinds that can come from a tap", () => {
    expect(tapDerived({ ops: [{ op: "row-close", item: "P08", evidence: "x" }] }).names).toEqual(["row-close P08"]);
    expect(tapDerived({ ops: [{ op: "take", item: "P41", for: "x", job: "ship Cain 0.12.0" }] })).toEqual({ names: ["take P41 for a Ship"], ship: true });
    expect(tapDerived({ ops: [{ op: "take", item: "P41", for: "x", job: "Cain 0.12.0" }] }).names).toEqual([]);
    expect(tapDerived({ ops: [{ op: "append", path: "state/decisions.md", text: "x" }] }).names).toEqual(["append state/decisions.md"]);
    expect(tapDerived({ ops: [{ op: "note", item: "P08", text: "x" }] }).names).toEqual([]);
    const req = (o: Record<string, unknown>) => parseRequest(JSON.stringify({ id: "cain-x-123", from: "cain", kind: "change", summary: "s", ...o }));
    expect(req({ ops: [{ op: "row-close", item: "P08", evidence: "x" }] }).error).toContain("tap key required: row-close P08 can act on his tap");
    expect(req({ tap: "none", ops: [{ op: "row-close", item: "P08", evidence: "x" }] }).error).toBeUndefined();
    expect(req({ tap: "none", ops: [{ op: "take", item: "P41", for: "x", job: "ship it" }] }).error).toContain("never none");
    expect(req({ tap: "tap-0123456789ab", ops: [{ op: "take", item: "P41", for: "x", job: "ship it" }] }).error).toBeUndefined();
    // A laptop session gets no taps: not asked for one.
    expect(parseRequest(JSON.stringify({ id: "lap-x-1234", from: "laptop:0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e", kind: "change", summary: "s",
      ops: [{ op: "row-close", item: "P08", evidence: "x" }] })).error).toBeUndefined();
  });

  test("a tap-derived request without a key is refused at the keeper; consumed keys are pruned after three days", () => {
    const k = keeperRig();
    k.cain({ id: "cain-close-1", tap: undefined, ops: [{ op: "row-close", item: "P11", evidence: "drilled Nov 11" }] });
    k.cain({ id: "cain-ship-1", tap: "none", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    k.cain({ id: "cain-note-1", tap: "tap-0123456789ab", ops: [{ op: "note", item: "P11", text: "Dane tapped Filed" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-close-1")).toEqual(["rejected"]);
    expect(k.reason("cain-close-1")).toContain("tap key required: row-close P11");
    expect(k.states("cain-ship-1")).toEqual(["rejected"]);
    expect(k.states("cain-note-1")).toEqual(["done"]);
    expect(k.kept().taps["tap-0123456789ab"]).toBeDefined();
    // Three days on, the consumed key is pruned (the longest card lifetime plus a margin).
    k.at(new Date(k.cfg.now!().getTime() + TAP_KEEP_MS + 60_000));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().taps?.["tap-0123456789ab"]).toBeUndefined();
    expect(TAP_KEEP_MS).toBe(3 * DAY);
    const taps = { "tap-aaaaaaaaaaaa": { id: "a", at: "2026-11-01T00:00:00.000Z" }, "tap-bbbbbbbbbbbb": { id: "b", at: "2026-11-10T00:00:00.000Z" } };
    expect(pruneTaps(taps, Date.parse("2026-11-11T00:00:00.000Z"))).toBe(1);
    expect(Object.keys(taps)).toEqual(["tap-bbbbbbbbbbbb"]);
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("the tap key is required");
  }, 30_000);
});

describe("7 to 9. the fixture's regeneration, the resilience run, and the docs", () => {
  test("the fixture rebuilds from a given commit, as committed", () => {
    const script = join(import.meta.dir, "fixtures/regenerate.sh");
    expect(existsSync(script)).toBe(true);
    const text = readFileSync(script, "utf8");
    expect(text).toContain("link-$version");
    expect(text).toContain("keeper-$version");
    // Rebuilt from the commit the committed fixture names, where that commit is in this clone.
    const at = /commit ([0-9a-f]{40})/.exec(readFileSync(join(import.meta.dir, "fixtures/link-0.11.0/core.ts"), "utf8"))?.[1];
    expect(at).toBeDefined();
    const has = Bun.spawnSync(["git", "cat-file", "-e", `${at}^{commit}`], { cwd: import.meta.dir }).exitCode === 0;
    if (!has) return;                                                 // a shallow CI checkout: the script is checked by hand
    const out = mkdtempSync(join(tmpdir(), "fixture-"));
    const p = Bun.spawnSync(["bash", script, at!, "0.11.0", out], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    for (const f of ["link-0.11.0/core.ts", "keeper-0.11.0/core.ts", "keeper-0.11.0/main.ts"])
      expect(readFileSync(join(out, f), "utf8")).toBe(readFileSync(join(import.meta.dir, "fixtures", f), "utf8"));
  });

  test("DOCS.md, the rules and the CHANGELOG say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    expect(docs).toContain("power off between the push and the ledger mark");
    expect(docs).toContain("pull request 20 lands first");
    expect(docs).toContain("run counter");
    expect(docs).toContain("TAP_KEEP_MS");
    expect(rules).toContain("Landing unconfirmed");
    expect(rules).toContain("Tap not acted");
    expect(rules).toContain("re-check queue");
    expect(log).toContain("Landing unconfirmed");
  });
});
