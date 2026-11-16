// Source checks, seventh review round (0.12.0): claims and journaled taps across a reset (honoured only
// when their check survived it, otherwise "lost to the record's reset"); cards stamped with their reset
// epoch and a reset that waits for a readable link state; the tap key on Cain's lines and in the
// keeper's landing ledger; buttons back by channel and message id; the link state's self-heal; a read
// guard that can't wedge; the re-check queue; one tap per card; and the rollback.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOST_TAP, Link, tapKid } from "../rootfs/opt/cain/link/core";
import { CHECKS_PATH, parseChecks } from "../rootfs/opt/cain/record/core.ts";
import { claimLanding, cycle, requestLoggedIn } from "../rootfs/opt/cain/record/main.ts";
import { Link as OldLink } from "./fixtures/link-0.11.0/core";
import { cycle as oldCycle } from "./fixtures/keeper-0.11.0/main.ts";
import { MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { PENDING, rig as keeperRig } from "./rig.ts";

const P = "state/PENDING.md";
const CHECKED = "the specialist's log, read at 8 this morning";
const opts = ["Fixed", "Not fixed"];
const logged: string[] = [];
const realLog = console.log;
const catchLog = () => { logged.length = 0; console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; };
afterEach(() => { console.log = realLog; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");

// The link and a real keeper on a git repo, as on the Pi. linkFile: what the keeper finds as the
// link's state (frozen: left as the test wrote it, a corrupt file say).
function both() {
  const k = keeperRig();
  const l = linkRig({ unchecked: true, pending: PENDING });
  const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
  const statusPath = join(k.root, "pi/record-ledger.json"), linkPath = join(k.root, "pi/link/state.json");
  const sync = () => {
    l.files.pending = read(P);
    l.files.checks = read(CHECKS_PATH);
    l.files.status = existsSync(statusPath) ? readFileSync(statusPath, "utf8") : null;
  };
  const linkFile = { frozen: false };
  let n = 0;
  const queued: string[] = [];
  const run = () => {
    if (!linkFile.frozen) writeFileSync(linkPath, l.disk.corrupt ?? JSON.stringify(l.state()));
    for (const q of l.submitted.splice(0)) { writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q)); queued.push(q.id); }
    const r = cycle(k.cfg);
    for (const id of queued) { const o = k.outcome(id); if (o) l.outcomes[id] = { state: o.state, reason: o.reason }; }
    sync();
    return r;
  };
  l.keeper.auto = false;
  l.keeper.onWait = () => { run(); };
  l.survive.fn = (id: string) => requestLoggedIn(k.cfg.dir, id);
  const block = (on: boolean) => { const f = join(k.root, "pi/record-block-push"); if (on) writeFileSync(f, ""); else rmSync(f, { force: true }); };
  const conflict = () => writeFileSync(join(k.root, "pi/record-force-conflict"), "");
  const status = () => JSON.parse(l.files.status!);
  return { k, l, run, read, block, conflict, status, linkFile, linkPath };
}
const ask = (l: ReturnType<typeof linkRig>, q: string, checked?: string, item = "P44") =>
  l.link.ask({ text: "Is the specialist fixed?", options: opts, item, question: q, ...(checked ? { checked } : {}) }) as Promise<any>;
const posted = async () => {
  const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
  const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
  expect(out.status).toBe("posted");
  return { r, id: out.message as string, d: (r.link as any).d };
};
const tapped = (r: ReturnType<typeof linkRig>, id?: string) => r.relayed.filter((x) => x.includes("Dane tapped") && (!id || x.includes(`Discord message ${id};`)));
const lostLines = (r: ReturnType<typeof linkRig>) => r.relayed.filter((x) => x.includes("was lost to the record's reset, please answer again"));
const threadLines = (r: ReturnType<typeof linkRig>, id: string) => r.cards().filter((m: any) => m.content === LOST_TAP && m.message_reference?.message_id === id);

// A first check pushed (Q1, answered), then a second accepted only locally (pushes fail), then a
// forced conflict that loses that commit.
async function lostCheck() {
  const b = both();
  const q0 = await ask(b.l, "Q1", CHECKED);
  expect(await b.l.tap(structuredClone(b.l.msg(q0.message)), b.l.ids(q0.message)[1])).toBe("to Cain");
  b.block(true);
  const q1 = await ask(b.l, "Q2", "the specialist's log again, read at 8:05");
  expect(q1.status).toBe("posted");
  expect(b.status().unpushed).toBe(true);
  return { ...b, id: q1.message as string };
}
// Meanwhile someone changes P44's row on GitHub, so the check the reset puts back in line is turned
// down when it runs again (its row has a new version): the check is lost for good.
function editUpstream(b: ReturnType<typeof both>) {
  b.k.pull();
  const f = join(b.k.seed, P);
  writeFileSync(f, readFileSync(f, "utf8").replace("Hold the Build until P33 lifts", "Hold the Build until P33 lifts, edited on GitHub"));
  b.k.g("commit", "--quiet", "-am", "upstream edit"); b.k.g("push", "--quiet", "origin", "HEAD:main");
}
function resetNow(b: ReturnType<typeof both>) {
  b.conflict();
  b.block(false);
  b.l.later(MIN); b.k.at(new Date(b.l.t.now));
  expect(b.run().ok).toBe(true);
  expect(b.status().reset).toBeUndefined();
  expect(b.status().epoch).toMatchObject({ n: 1 });
}

describe("1. claims and journaled taps across a reset", () => {
  test("a crash after the claim, then a reset that lost its check: lost to the reset, told once each, never acted", async () => {
    const b = await lostCheck();
    const { l, id } = b;
    const d = (l.link as any).d, relay = d.relay;
    d.relay = () => { throw new Error("killed"); };
    await expect(l.tap(structuredClone(l.msg(id)), l.ids(id)[0])).rejects.toThrow("killed");
    const key = Object.keys(l.state().taps!).find((x) => l.state().taps![x].msg === id)!;
    expect(l.state().taps![key]).toMatchObject({ stage: "claimed", epoch: 0, item: "P44" });
    d.relay = relay;
    editUpstream(b);
    resetNow(b);
    expect(requestLoggedIn(b.k.cfg.dir, l.state().taps![key].req!)).toBe(false);   // its check didn't survive
    l.restart();
    await l.link.sweep();
    await l.link.sweep();
    expect(tapped(l, id)).toHaveLength(0);                               // never acted past the epoch
    expect(lostLines(l)).toHaveLength(1);
    expect(lostLines(l)[0]).toContain(`tap key ${tapKid(key)}`);
    expect(lostLines(l)[0]).toContain("Once the keeper has accepted P44's re-check, ask again with --checked");
    expect(threadLines(l, id)).toHaveLength(1);
    expect(l.state().taps![key]).toMatchObject({ stage: "edited", outcome: "lost to reset", told: true });
    expect(l.buttons(id)).toEqual([]);
    expect(l.msg(id).content).toEndWith("Record reset since, re-check needed");
    // A Discord retry of the same tap gets the recorded outcome, and nothing more.
    expect(await l.tap(structuredClone({ ...l.msg(id), components: [] }), `q:${l.state().messages[id].q?.id ?? ""}:0`)).not.toBe("to Cain");
    await l.link.sweep();
    expect(lostLines(l)).toHaveLength(1);
    expect(threadLines(l, id)).toHaveLength(1);
  }, 30_000);

  test("a crash after the claim, then a reset its check survived: acted on once, marked as a possible repeat", async () => {
    const b = both();
    const q1 = await ask(b.l, "Q1", CHECKED);                         // pushed: it survives the reset
    const { l } = b;
    const d = (l.link as any).d, relay = d.relay;
    d.relay = () => { throw new Error("killed"); };
    await expect(l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).rejects.toThrow("killed");
    d.relay = relay;
    b.block(true);
    b.k.cain({ id: "cain-note-1", ops: [{ op: "note", item: "P11", text: "a note" }] });
    expect(b.run()).toMatchObject({ pushFailed: true });
    resetNow(b);
    l.restart();
    await l.link.sweep();
    expect(tapped(l)).toHaveLength(1);
    expect(tapped(l)[0]).toStartWith("Repeat of tap key tap-");
    expect(lostLines(l)).toHaveLength(0);
    expect(l.logs.join("\n")).toContain("predates the reset, but its check survived it: acted on");
  }, 30_000);

  test("a journaled ask, then a reset that lost its check: Cain is told to disregard it, Dane one line on the card's thread", async () => {
    const b = await lostCheck();
    const { l, id } = b;
    expect(await l.tap(structuredClone(l.msg(id)), l.ids(id)[0])).toBe("to Cain");
    expect(l.state().uncertain).toHaveLength(1);
    const key = Object.keys(l.state().taps!).find((x) => l.state().taps![x].msg === id)!;
    editUpstream(b);
    resetNow(b);
    await l.link.sweep();
    await l.link.sweep();
    expect(lostLines(l)).toHaveLength(1);
    expect(lostLines(l)[0]).toContain("disregard that tap");
    expect(lostLines(l)[0]).toContain(`tap key ${tapKid(key)}`);
    expect(threadLines(l, id)).toHaveLength(1);
    expect(l.state().taps![key]).toMatchObject({ outcome: "lost to reset", stage: "edited" });
    expect(l.msg(id).content).toEndWith("Record reset since, re-check needed");
    // Never dropped silently, never twice; the old "may not have landed" notice is gone.
    expect(l.cards().filter((m: any) => String(m.content).startsWith("Heads up:"))).toHaveLength(0);
    await l.link.sweep();
    expect(lostLines(l)).toHaveLength(1);
  }, 30_000);

  test("the re-ask path end to end: the stripped card tells Cain to ask after the re-check, the keeper queues it first, the new ask counts", async () => {
    const b = both();
    const q1 = await ask(b.l, "Q1", CHECKED);
    b.block(true);
    b.k.cain({ id: "cain-note-1", ops: [{ op: "note", item: "P11", text: "a note" }] });
    expect(b.run()).toMatchObject({ pushFailed: true });
    resetNow(b);
    // The keeper's re-check queue: P44, whose card was up, first; its status counts it.
    expect(b.k.relayed()).toContain("Re-check queue after the record's reset (epoch 1): P44 (a card of yours was up or held)");
    expect(b.status().recheck_pending).toBe(1);
    // The sweep strips the pre-reset card and tells Cain to ask again once the re-check is accepted.
    await b.l.link.sweep();
    expect(b.l.buttons(q1.message)).toEqual([]);
    expect(b.l.relayed.join(" ")).toContain("once the keeper has accepted its re-check, ask again with --checked");
    // The re-check, then the new ask: posted, stamped with the new epoch, and its tap counts.
    const q2 = await ask(b.l, "Q2", "the specialist's log again, read at 8:20");
    expect(q2.status).toBe("posted");
    expect(b.l.state().messages[q2.message].checked!.epoch).toBe(1);
    expect(b.status().recheck_pending).toBe(0);
    expect(await b.l.tap(structuredClone(b.l.msg(q2.message)), b.l.ids(q2.message)[0])).toBe("to Cain");
  }, 30_000);
});

describe("2. the epoch stamped on each card, and a reset that waits for a readable link state", () => {
  test("a reset with the link's state corrupt and a card posted after its last good save: the epoch waits, then the card is refused by epoch", async () => {
    const b = both();
    b.block(true);
    b.k.cain({ id: "cain-note-1", ops: [{ op: "note", item: "P11", text: "a note" }] });
    expect(b.run()).toMatchObject({ pushFailed: true });
    // The link's last good save is on disk; then the file goes corrupt, and a card is posted after it.
    writeFileSync(b.linkPath, "not json {");
    b.linkFile.frozen = true;
    b.block(true);                                                     // its check, too, lands only locally
    const q1 = await ask(b.l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    expect(b.l.state().messages[q1.message].checked!.epoch).toBe(0);
    const cardGen = b.l.state().messages[q1.message].checked!.gen!;
    // The reset, while the keeper can't read the link's state: no epoch yet, the reset stands (logged once).
    b.conflict(); b.block(false);
    b.l.later(MIN); b.k.at(new Date(b.l.t.now));
    catchLog();
    expect(b.run().ok).toBe(true);
    expect(b.run().ok).toBe(true);
    console.log = realLog;
    expect(logged.filter((x) => x.includes("reset epoch waits: the link's state can't be read"))).toHaveLength(1);
    expect(b.status().epoch).toBeUndefined();
    expect(b.status().reset).toBeDefined();
    expect(b.status().epoch_wait).toBeDefined();
    expect(await b.l.tap(structuredClone(b.l.msg(q1.message)), b.l.ids(q1.message)[0])).toBe("refused: record reset");
    // Readable again: the epoch completes above the card, and the card is refused by its epoch.
    b.linkFile.frozen = false;
    catchLog();
    expect(b.run().ok).toBe(true);
    expect(b.run().ok).toBe(true);
    console.log = realLog;
    expect(logged.join("\n")).toContain("reset epoch 1: completed now that the link's state can be read");
    expect(b.status().epoch.n).toBe(1);
    expect(b.status().epoch.generation).toBeGreaterThan(cardGen);
    expect(b.status().reset).toBeUndefined();
    expect(await b.l.tap(structuredClone(b.l.msg(q1.message)), b.l.ids(q1.message)[0])).toBe("refused: record reset since");
  }, 30_000);

  test("equality, not ordering: a card stamped with a later epoch than the status shows is refused too", async () => {
    const { r, id } = await posted();
    const s = r.state();
    s.messages[id].checked!.epoch = 3;
    r.setState(s);
    r.files.status = JSON.stringify({ epoch: { n: 2, at: new Date(r.t.now).toISOString(), generation: 1 }, clock: { synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() } });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: record reset since");
  });
});

describe("3. exactly once through the landing", () => {
  test("a kill after the relay, before the acted save: the line again after the restart is marked a repeat, with the same key", async () => {
    const { r, id, d } = await posted();
    const relay = d.relay;
    d.relay = (x: string) => { relay(x); throw new Error("killed"); };
    await expect(r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).rejects.toThrow("killed");
    d.relay = relay;
    const key = Object.keys(r.state().taps!)[0];
    expect(r.state().taps![key].stage).toBe("claimed");
    r.restart();
    await r.link.sweep();
    const lines = tapped(r);
    expect(lines).toHaveLength(2);
    expect(lines.every((x) => x.includes(tapKid(key)))).toBe(true);
    expect(lines.filter((x) => !x.startsWith("Repeat of tap key"))).toHaveLength(1);   // one assistant-visible action
    expect(lines[1]).toStartWith(`Repeat of tap key ${tapKid(key)}: if you already had a line with this tap key, ignore this one.`);
    await r.link.sweep();
    expect(tapped(r)).toHaveLength(2);
  });

  test("a kill after a landing starts: one landing, one assistant-visible notification, the key in the keeper's ledger", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41"], []) });
    const ship = await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message.", checked: "the pull request on GitHub, open at that head, read at 8" }) as any;
    r.github.hold = true;
    void r.tap(structuredClone(r.msg(ship.message)), r.ids(ship.message)[0]);
    await wait(10);
    expect(r.github.landings).toHaveLength(1);
    expect(r.landLedger.keys.size).toBe(1);
    r.github.main.push(SHA1);
    r.restart();
    r.github.hold = false;
    for (let i = 0; i < 3; i++) { r.later(5 * MIN); await r.link.sweep(); await r.link.whenLanded(); }
    expect(r.github.landings).toHaveLength(1);
    const said = r.relayed.filter((x) => x.includes(`Dane tapped "Ship"`));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`Tap key ${tapKid([...r.landLedger.keys][0])}`);
    expect(said[0]).toContain("The link landed it");
  });

  test("the keeper's landing ledger: the first request with a key is taken, a second is rejected, an unwritable one starts nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "landings-"));
    const what = { pr: PR, head: SHA1, at: "2026-11-11T13:00:00.000Z" };
    expect(claimLanding(join(dir, "l"), "k1", what)).toBe(true);
    expect(claimLanding(join(dir, "l"), "k1", what)).toBe(false);
    expect(claimLanding(join(dir, "l"), "k2", what)).toBe(true);
    expect(readdirSync(join(dir, "l"))).toHaveLength(2);
    writeFileSync(join(dir, "file"), "");
    expect(claimLanding(join(dir, "file", "x"), "k3", what)).toBeNull();
  });
});

describe("4. buttons back on Discord when the webhook patch fails or patches another message", () => {
  for (const how of ["fails", "answers another id"] as const) {
    test(`the webhook patch ${how}: the card is edited by channel and message id, and keeps its buttons`, async () => {
      const { r, id, d } = await posted();
      d.tapReadMs = 30;
      d.readFresh = () => new Promise(() => {});
      if (how === "fails") r.failing.add("PATCH /webhooks/"); else r.discord.webhookId = "1";
      const card = structuredClone(r.msg(id));                       // as his phone shows it
      r.msg(id).components = [];                                     // as the deferred answer left it on Discord
      expect(await r.tap(card, card.components[0].components[0].custom_id)).toBe("refused: busy");
      const i = r.calls.findIndex((c) => c.method === "PATCH" && c.path === `/channels/5151/messages/${id}`);
      expect(i).toBeGreaterThan(-1);
      expect(r.calls[i].body.components).toEqual(card.components);
      expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
      expect(r.logs.join("\n")).toContain("editing it by channel and message id");
      expect(r.ephemerals().at(-1).content).toBe("Busy, tap again.");
    });
  }
});

describe("5. the link's state heals itself", () => {
  test("a corrupt state file becomes asks working again, with one notice and nothing for the owner to do", async () => {
    const b = both();
    const q1 = await ask(b.l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    const gen = b.l.state().messages[q1.message].checked!.gen!;
    b.l.disk.corrupt = "not json {";
    b.run();
    expect(b.status().link_state).toMatchObject({ readable: false });
    await expect(ask(b.l, "Q2", "the specialist's log again, read at 8:10")).rejects.toThrow("can't read the link's state");
    const notices = () => b.l.cards().filter((m: any) => String(m.content).startsWith("Cain's link had to rebuild its saved state")).length;
    await b.l.link.sweep();                                          // one failed read: looked at again, nothing rewritten
    expect(b.l.disk.corrupt).not.toBeNull();
    expect(notices()).toBe(0);
    await b.l.link.sweep();                                          // two in a row: rewritten atomically, one notice
    expect(b.l.disk.corrupt).toBeNull();
    expect(b.l.state().intendedGen!).toBeGreaterThanOrEqual(gen + 10);
    expect(notices()).toBe(1);
    expect(b.l.logs.join("\n")).toContain("HEAL: the link's state didn't read twice in a row");
    expect((b.l.link as any).stateUnreadable).toBe(true);
    b.run();
    expect(b.status().link_state).toBeUndefined();
    await b.l.link.sweep();                                          // a verified good read clears the flag
    expect((b.l.link as any).stateUnreadable).toBe(false);
    expect((await ask(b.l, "Q2", "the specialist's log again, read at 8:10")).status).toBe("posted");
    await b.l.link.sweep();
    expect(notices()).toBe(1);
  }, 30_000);

  test("a single failed read (a write caught mid-way) never latches", async () => {
    const { r } = await posted();
    r.disk.corrupt = '{"messages": {';
    await r.link.sweep();
    r.disk.corrupt = null;
    await r.link.sweep();
    r.disk.corrupt = '{"messages": {';
    await r.link.sweep();
    r.disk.corrupt = null;
    await r.link.sweep();
    expect(r.logs.join("\n")).not.toContain("HEAL:");
    expect((r.link as any).stateUnreadable).toBe(false);
  });
});

describe("6. the in-flight read guard can't wedge", () => {
  test("a read that never resolves is killed at the ceiling and its slot released; a new tap then starts a fresh read", async () => {
    const { r, id, d } = await posted();
    d.tapReadMs = 30;
    d.inflightMaxMs = 120;
    let reads = 0;
    d.readFresh = () => { reads++; return reads === 1 ? new Promise(() => {}) : Promise.resolve({ files: d.record(), outcome: { state: "done" } }); };
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: busy");
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: busy");   // still in flight: no read
    expect(reads).toBe(1);
    await wait(150);
    expect(r.kills.n).toBe(1);
    expect(r.logs.filter((x) => x.includes("a fresh read never settled within 0.12 s: killed as a group, and its slot released"))).toHaveLength(1);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    expect(reads).toBe(2);
  });

  test("keeper.sh reads prints p50, p95 and max, and fails loudly once p95 is over half the limit", async () => {
    const { r, d } = await posted();
    d.tapReadMs = 100;
    d.readFresh = () => new Promise((ok) => setTimeout(() => ok({ files: d.record(), outcome: null }), 60));
    const out = await r.link.probeReads(3, 0) as any;
    expect(out).toMatchObject({ pass: false, limit_ms: 100 });
    expect(out.p50_ms).toBeGreaterThanOrEqual(55);
    expect(out.max_ms).toBeGreaterThanOrEqual(out.p95_ms);
    expect(out.fail).toStartWith("FAIL: p95 ");
    d.readFresh = undefined;
    d.tapReadMs = 1500;
    expect(await r.link.probeReads(3, 0)).toMatchObject({ pass: true });
    const sh = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).toContain(`if [ "$cmd" = reads ] && [ "$(printf '%s' "$out" | jq -r '.pass // empty' 2>/dev/null)" = false ]; then`);
  });

  test("tap_read_ms is an App option with the current default, handed to the link", () => {
    const cfg = readFileSync(join(import.meta.dir, "../config.yaml"), "utf8");
    expect(cfg).toContain("  tap_read_ms: 1500\n");
    expect(cfg).toContain("  tap_read_ms: int(200,2500)\n");
    expect(readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8")).toContain("export TAP_READ_MS");
    expect(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8")).toContain("tapReadMs: TAP_READ,");
  });
});

describe("8. Ship taps while unpushed", () => {
  test("the refusal says the record has unsaved changes, and the docs record the global flag as a known limitation", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/core.ts"), "utf8");
    expect(src).toContain(`"Cain's record has unsaved changes, so Ship waits. Tap again once they're saved, in a minute or two."`);
    expect(flat("../DOCS.md")).toContain("Known limitation: any unsaved change holds a Ship tap");
  });
});

describe("9. two concurrent taps on different labels of one card", () => {
  test("exactly one is honoured; the other is answered with the recorded outcome", async () => {
    const { r, id, d } = await posted();
    d.readFresh = () => new Promise((ok) => setTimeout(() => ok({ files: d.record(), outcome: { state: "done" } }), 30));
    const card = structuredClone(r.msg(id));
    const [a, b] = await Promise.all([r.tap(card, r.ids(id)[0]), r.tap(structuredClone(card), r.ids(id)[1])]);
    expect([a, b].sort()).toEqual(["already: to Cain", "to Cain"]);
    expect(tapped(r)).toHaveLength(1);
    expect(tapped(r)[0]).toContain(`"Filed"`);
    expect(Object.keys(r.state().taps!)).toHaveLength(1);
    expect(r.updates().at(-1).content).toContain("You answered: Filed");
  });
});

describe("10. rollback: the previous keeper and link start on this version's state and ignore it", () => {
  test("the previous link loads a state with epochs, tap keys and an intended generation, sweeps, and answers taps", async () => {
    const { r, id } = await posted();
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    const q2 = await r.link.ask({ text: "Is it signed?", options: ["Signed", "Not signed"], item: "P08", question: "Q2", checked: "the portal, read at 8:30" }) as any;
    const st = r.state();
    st.intendedGen = 12;
    r.setState(st);
    expect(Object.keys(st.taps!).length).toBe(1);
    expect(st.messages[q2.message].checked!.epoch).toBe(0);
    const old = new OldLink(r.deps as any);
    await old.sweep();
    expect(await old.onInteraction({ type: 3, id: "991", token: "t", application_id: "999", channel_id: "5151", user: { id: "4242" },
      data: { custom_id: r.ids(q2.message)[1] }, message: structuredClone(r.msg(q2.message)) })).toBe("to Cain");
    expect(r.state().taps).toBeDefined();                            // kept as it was, unread
  });

  test("the previous keeper runs a round on a state file with an epoch, a waiting epoch and a landing ledger beside it", () => {
    const k = keeperRig();
    expect(cycle(k.cfg).ok).toBe(true);
    const st = k.kept();
    writeFileSync(k.cfg.holds!, JSON.stringify({ ...st, generation: 9, epoch: { n: 2, at: "2026-11-11T12:00:00.000Z", generation: 9, voided: true },
      epochWait: { at: "2026-11-11T12:30:00.000Z", why: "corrupt" }, floorWhy: "corrupt" }));
    claimLanding(join(k.root, "pi/record-landings"), "k1", { pr: PR, head: SHA1, at: "2026-11-11T12:00:00.000Z" });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ messages: {}, intendedGen: 12, taps: { x: { stage: "lost" } } }));
    k.cain({ id: "cain-old-1", ops: [{ op: "note", item: "P11", text: "after the rollback" }] });
    expect(oldCycle(k.cfg as any).ok).toBe(true);
    expect(k.states("cain-old-1")).toEqual(["done"]);
    // Forward again: this version reads its own fields back.
    expect(cycle(k.cfg).ok).toBe(true);
  }, 30_000);
});

describe("11. the docs", () => {
  test("DOCS.md and Cain's rules state the guarantees, the reset handling and the backup", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    for (const t of [docs, rules]) {
      expect(t).toContain("lost to the record's reset, please answer again");
      expect(t).toContain("Repeat of tap key");
      expect(t).toContain("Re-check queue");
    }
    expect(docs).toContain("at most one landing and one assistant-visible action per tap");
    expect(docs).toContain("/data/record-holds.json");
    expect(docs).toContain("/data/link/state.json");
    expect(docs).toContain("tap_read_ms");
    expect(docs).toContain("pull request 20 lands first");
    // The resilience run's forced reset has its bound for asks resuming; the smoke test's stall step its real-Discord tap.
    expect(docs).toContain("asks resume within two keeper rounds of the push landing");
    expect(rules).toContain("asks resume within two keeper rounds of the push landing");
    expect(docs).toContain("its buttons are still there after the busy reply");
    expect(flat("../CHANGELOG.md")).toContain("Lost to the record's reset, please answer again.");
    void parseChecks; void Link; void mkdirSync; void chmodSync;
  });
});
