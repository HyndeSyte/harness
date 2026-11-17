// Source checks, tenth review round (0.12.0): an abandoned key settled against the remote before
// anything else, the reset boundary closed around the claim's fsync, landed decided by the head's
// reachability from the remote tip (the base only for did-not-land), the owner's keeper.sh settle,
// pruning that never drops an unresolved key, claims compared on a per-start nonce, a claim refused
// for a head already in main, and tap keys registered by the link and checked by the keeper.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABANDONED_TAP, LOST_TAP, NOT_ACTED_TAP, TAP_ISSUED_KEEP_MS, tapKid } from "../rootfs/opt/cain/link/core";
import { landingLedger, LANDING_KEEP_MS } from "../rootfs/opt/cain/link/landings";
import { settledFrom, type MergeDeps } from "../rootfs/opt/cain/link/merge";
import { tapIssuedProblem } from "../rootfs/opt/cain/record/core.ts";
import { cycle, pruneTaps, readLinkTaps, TAP_KEEP_MS } from "../rootfs/opt/cain/record/main.ts";
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
  (await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item, question: "Q1", checked: "the county portal, read at 8" }) as any).message as string;
const shipLines = (r: R) => r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
const landedLines = (r: R) => shipLines(r).filter((x) => x.includes("The link landed it") || x.includes("It is already in main"));
const abandonedLines = (r: R) => r.relayed.filter((x) => x.startsWith("Landing abandoned:"));
const unconfirmedLines = (r: R) => r.relayed.filter((x) => x.startsWith("Landing unconfirmed:"));
const lostLines = (r: R) => r.relayed.filter((x) => x.includes("was lost to the record's reset, please answer again"));
const notActedLines = (r: R) => r.relayed.filter((x) => x.includes("Tap not acted:"));
const onThread = (r: R, id: string, text: string) => r.cards().filter((m: any) => m.message_reference?.message_id === id && m.content === text);
const shipCards = (r: R) => r.cards().filter((m: any) => (m.components ?? []).some((row: any) => row.components.some((b: any) => b.label === "Ship")));
const sweeps = async (r: R, n = 3, step = 5 * MIN) => { for (let i = 0; i < n; i++) { r.later(step); await r.link.sweep(); await r.link.whenLanded(); } };
const status = (r: R, s: Record<string, unknown>) => {
  (r.files as any).status = JSON.stringify({ clock: { synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() }, ...s });
};

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
// Cut off, then the remote down past UNRESOLVED_TELL_MS: unresolved, told once.
async function downPast15(r: R, landed: boolean) {
  const id = await cutOff(r);
  if (landed) r.github.main.push(SHA1);                              // the push had reached GitHub
  r.github.readable = false;
  r.github.unreadableWhy = "GitHub couldn't be fetched from (ssh: connect to host github.com port 22: Connection timed out)";
  await sweeps(r, 1);
  await sweeps(r, 20, MIN);
  expect(unconfirmedLines(r)).toHaveLength(1);
  expect(r.state().messages[id].shipping!.state).toBe("landing");
  return { id, key: [...r.landLedger.keys][0] };
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

describe("1. an abandoned key is settled against the remote before anything else when it returns", () => {
  test("the push lands, the remote is down past 15 minutes, then returns: one landed outcome, no new card", async () => {
    const r = shipRig();
    const { id } = await downPast15(r, true);
    const posts = r.posts(), cards = shipCards(r).length;
    r.github.readable = true;
    // Looked for again once due on its backoff (at most 5 minutes): nothing else goes out before.
    await sweeps(r, 6, MIN);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(landedLines(r)).toHaveLength(1);
    expect(landedLines(r)[0]).toContain("Ship token: ship1.");
    expect(r.msg(id).content).toContain("Shipped: it's in main as of");
    expect(abandonedLines(r)).toHaveLength(0);
    expect(onThread(r, id, ABANDONED_TAP)).toHaveLength(0);
    expect(r.posts()).toBe(posts);                                    // nothing new posted: no card, no notice
    expect(shipCards(r)).toHaveLength(cards);
    expect(r.state().unresolved).toBeUndefined();
    await sweeps(r, 3);
    expect(landedLines(r)).toHaveLength(1);
    expect(r.github.landings).toHaveLength(1);                        // never pushed again
  });

  test("a new Ship card for that head, asked for as the remote returns: the key is settled first, landed refuses the card", async () => {
    const r = shipRig();
    const { id } = await downPast15(r, true);
    r.github.readable = true;
    r.later(MIN);
    await expect(shipCard(r)).rejects.toThrow("has just settled against main as landed");
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(landedLines(r)).toHaveLength(1);
    expect(landedLines(r)[0]).toContain("Ship token: ship1.");
    expect(abandonedLines(r)).toHaveLength(0);
    expect(r.logs.join("\n")).toContain("settling tap key");
  });

  test("only a definite did-not-land lets the new card out", async () => {
    const r = shipRig();
    const { id } = await downPast15(r, false);
    // Still down: the card is refused, and the key stays unresolved.
    await expect(shipCard(r)).rejects.toThrow("isn't settled yet");
    r.github.readable = true;
    r.later(MIN);
    const again = await shipCard(r);
    expect(r.buttons(again)).toEqual(["Ship", "Not now"]);
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", abandoned: true });
    expect(abandonedLines(r)).toHaveLength(1);
    expect(onThread(r, id, ABANDONED_TAP)).toHaveLength(1);
  });
});

describe("2. the reset boundary closed around the claim's fsync", () => {
  test("a reset injected between the last check and the fsync: the claim is voided, nothing pushed, the tap lost and told", async () => {
    const r = shipRig();
    status(r, { epoch: { n: 2, at: new Date(r.t.now).toISOString(), generation: 0, voided: true } });
    const id = await shipCard(r);
    expect(r.state().messages[id].checked!.epoch).toBe(2);
    const L = (r.link as any).d.landings, claim = L.claim;
    L.claim = (k: string, w: any) => {
      const out = claim(k, w);                                       // the claim is written and fsynced
      status(r, { reset: { at: new Date(r.t.now).toISOString(), why: "forced conflict" }, epoch: { n: 3, at: new Date(r.t.now).toISOString(), generation: 1 } });
      return out;
    };
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    const key = [...r.landLedger.keys][0];
    expect(r.landLedger.what.get(key)!.epoch).toBe(2);                // the epoch read is recorded in the claim
    expect(r.github.landings).toHaveLength(0);                        // voided before the first push
    expect(r.landLedger.settled.get(key)).toBe("not landed");
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", why: "the record was reset before it landed" });
    expect(lostLines(r)).toHaveLength(1);
    expect(onThread(r, id, LOST_TAP)).toHaveLength(1);
    expect(r.state().recheck?.P41).toBeDefined();
    expect(r.logs.join("\n")).toContain("was voided: the record keeper's reset epoch changed between the last check and the claim's fsync");
    await sweeps(r, 2);
    expect(r.github.landings).toHaveLength(0);
    expect(lostLines(r)).toHaveLength(1);
  });

  test("no reset in between: the claim stands and the push goes", async () => {
    const r = shipRig();
    status(r, { epoch: { n: 2, at: new Date(r.t.now).toISOString(), generation: 0, voided: true } });
    const id = await shipCard(r);
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
  });
});

// A real git repo standing in for GitHub, and the link's own copy of it, for settledFrom.
function gitWorld() {
  const root = mkdtempSync(join(tmpdir(), "settle10-"));
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
  commit("c0"); commit("c1");
  const base = commit("base"), head = commit("head"); commit("c4");
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
  return { ok, copy, deps, base, head, seed };
}

describe("3. settlement, the owner's settle, and pruning", () => {
  test("landed is the head reachable from the remote tip, with no base needed; the range decides only did-not-land", async () => {
    const w = gitWorld();
    // A base that isn't in main's history (main rewritten under it): the head is still there, so landed.
    const gone = "f".repeat(40);
    expect(await settledFrom(w.deps(w.copy()), "o/r", w.head, gone)).toEqual({ inMain: true });
    // A shallow copy that can't be deepened, with the head inside it: landed, without deepening.
    const shallow = w.copy(2);
    expect(await settledFrom(w.deps(shallow, /--unshallow/), "o/r", w.head, w.base)).toEqual({ inMain: true });
    expect(w.ok(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    // A head not in main with a base that's gone: unresolved, never "did not land".
    const r = await settledFrom(w.deps(w.copy()), "o/r", "e".repeat(40), gone);
    expect("unresolved" in r && r.unresolved).toContain("main was rewritten");
    // With the base there: did not land.
    expect(await settledFrom(w.deps(w.copy()), "o/r", "e".repeat(40), w.base)).toEqual({ inMain: false });
    expect(flat("../DOCS.md")).toContain("a landed verdict needs no base");
  });

  test("keeper.sh settle: the owner's own message settles an unresolved key as landed, with an audit line and a line to Cain", async () => {
    const r = shipRig();
    const { id, key } = await downPast15(r, false);
    const kid = tapKid(key);
    // Not his message, words that don't match, a key that isn't unresolved: refused, nothing settled.
    await expect(r.link.settleKey({ tap: kid, how: "landed", said: id })).rejects.toThrow("isn't his");
    const vague = r.his("hmm, maybe");
    await expect(r.link.settleKey({ tap: kid, how: "landed", said: vague.id })).rejects.toThrow("isn't of the exact form");
    const says = r.his(`settle ${kid} landed`);
    await expect(r.link.settleKey({ tap: "tap-000000000000", how: "landed", said: says.id })).rejects.toThrow("isn't an unresolved landing");
    await expect(r.link.settleKey({ tap: kid, how: "landed" })).rejects.toThrow("the owner's alone");
    // Round 17: a day old by Discord's times (against the newest message in his DM), never the Pi's clock.
    r.later(2 * DAY);
    const newer = r.his("two days on");
    await expect(r.link.settleKey({ tap: kid, how: "landed", said: says.id })).rejects.toThrow("over a day old");
    delete r.posted[newer.id];
    r.later(-2 * DAY);
    expect(r.state().messages[id].shipping!.state).toBe("landing");
    expect(await r.link.settleKey({ tap: kid, how: "landed", said: says.id })).toMatchObject({ status: "settled" });
    await r.link.whenLanded();
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(r.landLedger.settled.get(key)).toBe("landed");
    expect(r.state().unresolved).toBeUndefined();
    expect(r.logs.join("\n")).toContain(`settle: tap key ${kid} force-settled as landed by the owner (his message ${says.id}`);
    expect(r.relayed.filter((x) => x.startsWith(`Landing settled by Dane: tap key ${kid}`))).toHaveLength(1);
    expect(landedLines(r)).toHaveLength(1);
    expect(r.github.landings).toHaveLength(1);                        // settled by hand: nothing pushed
    const keeper = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/keeper.sh"), "utf8");
    expect(keeper).toContain("keeper.sh settle <tap key> landed|not-landed --said <his message id>");
    expect(keeper).toContain(`settle)   body=$(jq -nc --arg t "\${1:-}" --arg h "\${2:-}" --arg s "$said" '{tap: $t, how: $h, said: $s}') ;;`);
  });

  test("keeper.sh settle not-landed: the abandoned outcome, and a new card may follow", async () => {
    const r = shipRig();
    const { id, key } = await downPast15(r, false);
    const says = r.his(`settle ${tapKid(key)} not-landed`);
    await r.link.settleKey({ tap: tapKid(key), how: "not-landed", said: says.id });
    await r.link.whenLanded();
    expect(r.state().messages[id].shipping).toMatchObject({ state: "not landed", abandoned: true });
    expect(onThread(r, id, ABANDONED_TAP)).toHaveLength(1);
    expect(r.landLedger.settled.get(key)).toBe("not landed");
    const again = await shipCard(r);
    expect(r.buttons(again)).toEqual(["Ship", "Not now"]);
  });

  test("ledger pruning at 30 days and tap-key pruning at 3 days never remove an unresolved key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger10-"));
    const L = landingLedger(join(dir, "landings"), join(dir, "marker.json"));
    const at = "2026-11-01T00:00:00.000Z";
    expect(L.claim("k-old", { pr: PR, head: SHA1, at })).toBe(true);
    expect(L.claim("k-kept", { pr: PR, head: SHA1, at })).toBe(true);
    expect(L.claim("k-open", { pr: PR, head: SHA1, at })).toBe(true);
    L.settle("k-old", "landed", at);
    L.settle("k-kept", "landed", at, { forced: true });
    const later = Date.parse(at) + LANDING_KEEP_MS + DAY;
    expect(L.prune(later, undefined, new Set(["k-kept"]))).toBe(1);
    expect(L.entries()!.map((e) => e.key).sort()).toEqual(["k-kept", "k-open"]);
    expect(L.entries()!.find((e) => e.key === "k-kept")!.settled).toMatchObject({ how: "landed", forced: true });
    const taps = { "tap-aaaaaaaaaaaa": { id: "a", at }, "tap-bbbbbbbbbbbb": { id: "b", at } };
    expect(pruneTaps(taps, Date.parse(at) + TAP_KEEP_MS + DAY, new Set(["tap-bbbbbbbbbbbb"]))).toBe(1);
    expect(Object.keys(taps)).toEqual(["tap-bbbbbbbbbbbb"]);
  });

  test("the keeper keeps a consumed tap key past three days while the link lists its landing unresolved", () => {
    const k = keeperRig();
    const full = "1570000000000000001|7|link-check-p33-1|P33|Ship";
    const kid = tapKid(full);
    k.cain({ id: "cain-ship-10", tap: kid, ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-ship-10")).toEqual(["done"]);
    const f = join(k.root, "pi/link/state.json");
    const st = JSON.parse(readFileSync(f, "utf8"));
    st.unresolved = { [full]: { since: 0, fails: 9, last: "x", next: 0, what: "orphan" } };
    writeFileSync(f, JSON.stringify(st));
    expect(readLinkTaps(k.cfg)!.unresolved.has(kid)).toBe(true);
    k.at(new Date(k.cfg.now!().getTime() + TAP_KEEP_MS + DAY));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().taps[kid]).toBeDefined();
    delete st.unresolved;
    writeFileSync(f, JSON.stringify(st));
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.kept().taps?.[kid]).toBeUndefined();
  }, 30_000);

  test("DOCS.md documents the reconciliation procedure", () => {
    const docs = flat("../DOCS.md");
    expect(docs).toContain("Reconciling a landing by hand");
    expect(docs).toContain("keeper.sh settle <tap key> landed|not-landed --said <his message id>");
    expect(docs).toContain("never remove an unresolved key");
  });
});

describe("4. claims compare on a per-start nonce", () => {
  test("a state file restored to an older counter with an outstanding claim: an earlier-run claim, judged by the predicate", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const key = await cutClaim(r, ask);
    const st = r.state();
    expect(st.run).toBe(1);
    expect(st.taps![key]).toMatchObject({ run: 1, nonce: st.runNonce });
    // Restored to an older counter. Round 18: the next start takes its run from the issued-key log's highest run plus
    // one, so it makes run 2, never run 1 again; the claim is still an earlier-run claim by its nonce.
    st.run = 0;
    r.setState(st);
    const ledger = JSON.parse(r.files.checks!);
    ledger.P08.version = 2;                                           // the row changed since: the predicate fails
    r.files.checks = JSON.stringify(ledger);
    r.restart();
    await r.link.sweep();
    expect(r.state().run).toBe(2);
    expect(r.state().runNonce).not.toBe(st.runNonce);
    expect(r.relayed.filter((x) => x.includes("Dane tapped"))).toHaveLength(0);
    expect(notActedLines(r)).toHaveLength(1);
    expect(onThread(r, ask, NOT_ACTED_TAP)).toHaveLength(1);
  });

  test("the same restore with the card still good: acted on once, as a possible repeat", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    const key = await cutClaim(r, ask);
    const st = r.state();
    st.run = 0;
    r.setState(st);
    r.restart();
    await r.link.sweep();
    await r.link.sweep();
    const lines = r.relayed.filter((x) => x.includes("Dane tapped"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`Repeat of tap key ${tapKid(key)}`);
    expect(r.logs.join("\n")).toContain("passes the live-tap predicate: acted on");
    expect(flat("../DOCS.md")).toContain("per-start nonce");
  });
});

describe("5. a claim is refused for a head already in main", () => {
  test("the head already in main at claim time: no claim, no push, the card says it is already in main, and Cain gets a line", async () => {
    const r = shipRig();
    r.github.main.push(SHA1);
    const id = await shipCard(r);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(r.landLedger.keys.size).toBe(0);
    expect(r.msg(id).content).toMatch(/Already in main as of [0-9:]+ [AP]M, so nothing was pushed\. Installing it is next\.$/);
    const line = landedLines(r);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("It is already in main: main had that commit when his tap came (it was there already), so the link claimed no landing and pushed nothing.");
    expect(line[0]).toContain("Ship token: ship1.");
    expect(flat("../DOCS.md")).toContain("landed means the commit is present, not that this push put it there");
  });

  test("the head arriving by another push during an outage: settled as landed, no second push", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    r.github.answers.push({ ok: false, why: "GitHub didn't answer", again: true });
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(1);                        // one push attempt, not taken
    expect(r.state().messages[id].shipping!.state).toBe("landing");
    r.github.readable = false;                                        // the outage: pushes fail too
    for (let i = 0; i < 6; i++) r.github.answers.push({ ok: false, why: "GitHub didn't answer", again: true });
    await sweeps(r, 2);
    r.github.answers.length = 0;
    r.github.main.push(SHA1);                                         // another push brought the head
    r.github.readable = true;
    await sweeps(r, 3);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(landedLines(r)).toHaveLength(1);
    expect(landedLines(r)[0]).toContain("(it was there already)");
    expect(r.github.landings.length).toBeLessThanOrEqual(3);
    expect(r.github.main.filter((h) => h === SHA1)).toHaveLength(1); // never pushed a second time
  });

  test("the head arriving while GitHub can't be read before the claim: no claim, landed as already in main", async () => {
    const r = shipRig();
    const id = await shipCard(r);
    r.github.readable = false;
    await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(r.landLedger.keys.size).toBe(0);
    r.github.main.push(SHA1);
    r.github.readable = true;
    await sweeps(r, 3);
    expect(r.state().messages[id].shipping!.state).toBe("landed");
    expect(r.github.landings).toHaveLength(0);
    expect(landedLines(r)).toHaveLength(1);
  });
});

describe("6. tap keys registered by the link and checked by the keeper", () => {
  test("the link lists each issued tap key with its card's item, kind and label, and prunes it after four days unless unresolved", async () => {
    const r = shipRig();
    const ask = await askCard(r);
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    const key = Object.keys(r.state().taps!)[0];
    expect(r.state().issued![tapKid(key)]).toMatchObject({ item: "P08", kind: "ask", label: "Filed" });
    const ship = await shipCard(r);
    await r.tap(structuredClone(r.msg(ship)), r.ids(ship)[0]);
    await r.link.whenLanded();
    const skey = Object.keys(r.state().taps!).find((k) => k !== key)!;
    expect(r.state().issued![tapKid(skey)]).toMatchObject({ item: "P41", kind: "ship", label: "Ship" });
    // The relayed line carries the same short key.
    expect(r.relayed.some((x) => x.includes(`Tap key ${tapKid(key)}`))).toBe(true);
    const st = r.state();
    st.unresolved = { [skey]: { since: r.t.now, fails: 1, last: "x", next: r.t.now + DAY * 30, what: "orphan" } };
    r.setState(st);
    r.later(TAP_ISSUED_KEEP_MS + DAY);
    (r.link as any).noteStamp(r.snowflake());                           // round 18: a Discord stamp at the new time
    await r.link.sweep();
    expect(r.state().issued?.[tapKid(key)]).toBeUndefined();
    expect(r.state().issued?.[tapKid(skey)]).toBeDefined();
  });

  test("the keeper refuses unknown keys and keys whose item or kind doesn't match; none stays on Cain's word", () => {
    const k = keeperRig();
    const note = (item: string, text: string) => [{ op: "note", item, text }];
    k.cain({ id: "cain-unknown-1", tap: "tap-0123456789ab", ops: note("P11", "Dane tapped Filed") }, { issue: false });
    k.issue("tap-00000000a001", { item: "P44", kind: "ask", label: "Filed" });
    k.cain({ id: "cain-item-1", tap: "tap-00000000a001", ops: note("P11", "Dane tapped Filed") }, { issue: false });
    k.issue("tap-00000000a002", { item: "P33", kind: "ask", label: "Start" });
    k.cain({ id: "cain-kind-1", tap: "tap-00000000a002", ops: [{ op: "take", item: "P33", for: "his tap", job: "ship Cain 0.12.0" }] }, { issue: false });
    k.issue("tap-00000000a003", { item: "P33", kind: "ship", label: "Not now" });
    k.cain({ id: "cain-kind-2", tap: "tap-00000000a003", ops: [{ op: "take", item: "P33", for: "his tap", job: "ship Cain 0.12.0" }] }, { issue: false });
    k.issue("tap-00000000a004", { item: "P11", kind: "ask", label: "Filed" });
    k.cain({ id: "cain-dec-1", tap: "tap-00000000a004", ops: [{ op: "append", path: "state/decisions.md", text: "| Nov 11 | is it filed | Filed |\n" }] }, { issue: false });
    k.issue("tap-00000000a005", { item: "P11", kind: "ask", label: "Filed" });
    k.cain({ id: "cain-dec-2", tap: "tap-00000000a005", ops: [{ op: "append", path: "state/decisions.md", text: "| P11 Q2 | is it filed | Filed |\n" }] }, { issue: false });
    k.issue("tap-00000000a006", { item: "P33", kind: "ship", label: "Ship" });
    k.cain({ id: "cain-ship-2", tap: "tap-00000000a006", ops: [{ op: "take", item: "P33", for: "his Ship tap", job: "ship Cain 0.12.0" }] }, { issue: false });
    k.cain({ id: "cain-none-1", tap: "none", ops: [{ op: "row-close", item: "P44", evidence: "his PT event found, Nov 11" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("cain-unknown-1")).toEqual(["rejected"]);
    expect(k.reason("cain-unknown-1")).toContain("isn't one the link issued");
    expect(k.states("cain-item-1")).toEqual(["rejected"]);
    expect(k.reason("cain-item-1")).toContain("is from a card for P44, but the request names P11");
    expect(k.states("cain-kind-1")).toEqual(["rejected"]);
    expect(k.reason("cain-kind-1")).toContain("a question, not a Ship card, so it can't start a Ship job");
    expect(k.states("cain-kind-2")).toEqual(["rejected"]);
    expect(k.reason("cain-kind-2")).toContain(`a "Not now" tap on a Ship card`);
    // Round 11: matched on the key's target, never on the text: a decision from a question passes.
    expect(k.states("cain-dec-1")).toEqual(["done"]);
    expect(k.states("cain-dec-2")).toEqual(["done"]);
    expect(k.states("cain-ship-2")).toEqual(["done"]);
    expect(k.states("cain-none-1")).toEqual(["done"]);
  }, 30_000);

  test("tapIssuedProblem: unreadable list, no-item cards, and keys it doesn't judge", () => {
    expect(tapIssuedProblem({ tap: "tap-0123456789ab", ops: [] }, null)).toContain("can't be checked");
    expect(tapIssuedProblem({ tap: "none", ops: [{ op: "row-close", item: "P08" }] }, {})).toBeNull();
    expect(tapIssuedProblem({ ops: [{ op: "note", item: "P08" }] }, {})).toBeNull();
    const reg = { "tap-0123456789ab": { item: "NONE", kind: "ask", label: "Yes" } };
    expect(tapIssuedProblem({ tap: "tap-0123456789ab", ops: [{ op: "note", item: "P08", text: "x" }] }, reg)).toContain("about no open item");
    expect(tapIssuedProblem({ tap: "tap-0123456789ab", ops: [{ op: "append", path: "state/decisions.md", text: "a one-off: Yes" }] }, reg)).toBeNull();
  });
});

describe("8. docs, rules and the CHANGELOG", () => {
  test("they say all of it", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    expect(docs).toContain("pull request 20 lands first");
    expect(docs).toContain("issued tap keys");
    expect(rules).toContain("keeper.sh settle");
    expect(rules).toContain("It is already in main");
    expect(rules).toContain("isn't one the link issued");
    expect(log).toContain("already in main");
    expect(log).toContain("settle");
  });
});
