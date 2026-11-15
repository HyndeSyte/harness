// Source checks, fourth review round (0.12.0): a failed push never resets the keeper's copy (its
// local commits and outcomes stand, the ledger is marked unpushed and the push retried), with a
// ledger generation on every card so a ledger that went backwards never validates one, and asks
// and taps refused after a reset until the next push lands; the sweep takes buttons off only on a
// verified read; four clock sources with one diagnostic, the clock checked at tap time and a
// backward step invalidating checks; busy taps; the expired-check step; and the docs.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATE_SKEW_MS, dateHeaderReading, describe as said, verdict, type Reading } from "../rootfs/opt/cain/clock";
import { STATUS_CHANGED, TAP_READ_MS } from "../rootfs/opt/cain/link/core";
import { CHECKS_PATH, generationOf, nextChecksText, oneOffAudit, openRow, parseChecks, plan, rowHash, upkeep,
  type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { HOUR, MIN, NOV11_8AM, pendingWith, rig as linkRig } from "./link-rig";
import { PENDING, T0, rig as keeperRig } from "./rig.ts";

const P = "state/PENDING.md";
const CHECKED = "the specialist's log, read at 8 this morning";
const opts = ["Fixed", "Not fixed"];
const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });

// The keeper's log lines, caught for the tests that read them.
const logged: string[] = [];
const realLog = console.log;
const catchLog = () => { logged.length = 0; console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; };
afterEach(() => { console.log = realLog; });

// The link and a real keeper on a git repo, as on the Pi: the link reads the keeper's local copy,
// its outcome files and its status file; the keeper's round runs whenever the link waits.
function both() {
  const k = keeperRig();
  const l = linkRig({ unchecked: true, pending: PENDING });
  const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
  const status = () => JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
  let n = 0;
  const sync = () => {
    l.files.pending = read(P);
    l.files.checks = read(CHECKS_PATH);
    l.files.status = existsSync(join(k.root, "pi/record-ledger.json")) ? readFileSync(join(k.root, "pi/record-ledger.json"), "utf8") : null;
    for (const id of l.submitted.map((q) => q.id).concat(Object.keys(l.outcomes))) {
      const o = k.outcome(id);
      if (o) l.outcomes[id] = { state: o.state, reason: o.reason };
    }
  };
  const queued: string[] = [];
  const run = () => {
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(l.state()));   // the link's state, as the keeper reads it
    for (const q of l.submitted.splice(0)) { writeFileSync(join(k.cfg.queue, `${String(++n).padStart(4, "0")}-${q.id}.json`), JSON.stringify(q)); queued.push(q.id); }
    const r = cycle(k.cfg);
    for (const id of queued) { const o = k.outcome(id); if (o) l.outcomes[id] = { state: o.state, reason: o.reason }; }
    sync();
    return r;
  };
  l.keeper.auto = false;
  l.keeper.onWait = () => { run(); };
  // The keeper's pushes fail while this is on (the smoke test's switch, kept on by the test).
  const block = (on: boolean) => { const f = join(k.root, "pi/record-block-push"); if (on) writeFileSync(f, ""); else rmSync(f, { force: true }); };
  return { k, l, run, read, sync, status, block };
}

const ask = (l: ReturnType<typeof linkRig>, q: string, checked?: string) =>
  l.link.ask({ text: "Is the specialist fixed?", options: opts, item: "P44", question: q, ...(checked ? { checked } : {}) }) as Promise<any>;

describe("1. a failed push never resets the keeper's copy", () => {
  test("the check's outcome, local commit and ledger stand through a push failure; the next round pushes them, outcome unchanged", () => {
    const k = keeperRig();
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    const r = cycle(k.cfg);
    expect(r).toMatchObject({ ok: false, pushFailed: true });
    const outcome = readFileSync(join(k.cfg.outcomes, "link-check-p44-1.json"), "utf8");
    expect(JSON.parse(outcome)).toMatchObject({ state: "done" });
    // Local: the ledger has the check; GitHub doesn't yet.
    const local = readFileSync(join(k.cfg.dir, CHECKS_PATH), "utf8");
    expect(parseChecks(local).P44.checked).toBe(CHECKED);
    expect(k.upstream(CHECKS_PATH)).toBeNull();
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st).toMatchObject({ unpushed: true, generation: generationOf(local) });
    expect(st.push_failed.why).toContain("git push");
    expect(existsSync(join(k.root, "pi/record-block-push"))).toBe(false);   // one round only
    expect(readFileSync(join(k.cfg.queue, "0001.json"), "utf8")).toContain("link-check-p44-1");   // not let go yet
    // The next round: nothing new, but the local commits are pushed; the outcome is as it was.
    expect(cycle(k.cfg).ok).toBe(true);
    expect(readFileSync(join(k.cfg.outcomes, "link-check-p44-1.json"), "utf8")).toBe(outcome);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toEqual(parseChecks(local).P44);
    expect(k.states("link-check-p44-1")).toEqual(["done"]);                 // applied once
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"))).toMatchObject({ unpushed: false });
    expect(existsSync(join(k.cfg.queue, "0001.json"))).toBe(false);
  });

  test("Cain hears about his other requests only once GitHub has them, whatever round lands them", () => {
    const k = keeperRig();
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    k.cain({ id: "cain-append-1", ops: [{ op: "append", path: "areas/farm/backlog.md", text: "- hay" }] });
    expect(cycle(k.cfg).ok).toBe(false);
    expect(k.outcome("cain-append-1")).toBeNull();
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.outcome("cain-append-1")).toMatchObject({ state: "done" });
    expect(k.upstream("areas/farm/backlog.md")).toContain("- hay");
  });

  test("a lost race is rebased and pushed in the same round, the laptop's commit kept", () => {
    const k = keeperRig();
    let raced = false;
    k.cfg.beforePush = () => {
      if (raced) return;
      raced = true;
      k.pull();
      writeFileSync(join(k.seed, "areas-note.md"), "x\n");
      k.g("add", "-A"); k.g("commit", "--quiet", "-m", "laptop"); k.g("push", "--quiet", "origin", "HEAD:main");
    };
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.upstream("areas-note.md")).toBe("x\n");
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44.checked).toBe(CHECKED);
  });

  test("with the link: a valid card keeps its buttons through a push failure and his tap counts; one whose row moved is refused", async () => {
    const { k, l, run, read, block } = both();
    const q1 = await ask(l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    const gen = l.state().messages[q1.message].checked.gen;
    expect(gen).toBe(generationOf(read(CHECKS_PATH)));
    expect(gen).toBeGreaterThan(0);
    // A push failure: a one-off is applied locally, its push blocked.
    block(true);
    k.cain({ id: "link-oneoff-9", summary: "One-off ask to him: Lunch at noon?", ops: [{ op: "one-off", text: "Lunch at noon?", not_about_item: true }] });
    expect(run()).toMatchObject({ ok: false, pushFailed: true });
    expect(JSON.parse(l.files.status!)).toMatchObject({ unpushed: true });
    await l.link.sweep();
    expect(l.buttons(q1.message)).toEqual(opts);
    // Nothing moved: honoured, as the rules say.
    expect(await l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).not.toContain("refused");
    expect(l.relayed.join(" ")).toContain("Dane tapped");
    // A second card; then its row moves while pushes still fail: refused, buttons off.
    block(true);
    const q2 = await ask(l, "Q2");
    expect(q2.status).toBe("posted");
    k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P44", base: rowHash(openRow(read(P), "P44")!), set: { "Next step": "Build the fix" } }] });
    k.at(new Date(T0.getTime() + MIN)); l.later(MIN);
    expect(run()).toMatchObject({ pushFailed: true });
    expect(await l.tap(structuredClone(l.msg(q2.message)), l.ids(q2.message)[0])).toBe("dead: status changed");
    // The retry: nothing moved backwards, and GitHub gets the whole local history.
    block(false);
    expect(run().ok).toBe(true);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44.version).toBe(2);
    expect(JSON.parse(l.files.status!)).toMatchObject({ unpushed: false });
  }, 30_000);
});

describe("1b. the ledger's generation: monotonic, on every card, and a ledger behind a card never validates it", () => {
  test("every ledger write goes up by one, never below the keeper's own count", () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const g1 = generationOf(k.upstream(CHECKS_PATH));
    expect(g1).toBeGreaterThan(0);
    const e = parseChecks(k.upstream(CHECKS_PATH)).P44;
    k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P44", base: rowHash(openRow(k.upstream(P), "P44")!), set: { "Next step": "Build it" } }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(generationOf(k.upstream(CHECKS_PATH))).toBe(g1 + 1);
    expect(JSON.parse(readFileSync(k.cfg.holds!, "utf8")).generation).toBe(g1 + 1);
    // Unchanged entries write nothing; a stale file with a lower number is written above the keeper's count.
    expect(nextChecksText({ P44: e }, `{"_generation": 3}`, 9)).toContain(`"_generation": 10`);
    expect(nextChecksText(parseChecks(k.upstream(CHECKS_PATH)), k.upstream(CHECKS_PATH), 0)).toBeNull();
    const p = plan({ id: "link-check-p11-1", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P11", text: CHECKED, row: null, version: 0 }] } as Request,
      tree({ [P]: PENDING, [CHECKS_PATH]: `{"_generation": 2}` }), { at: T0, clockSynced: true, generation: 40 });
    if (p.state !== "ok") throw new Error(p.state);
    expect(generationOf(p.writes.get(CHECKS_PATH)!)).toBe(41);
  });

  test("a tap on a card whose ledger is now behind its generation is refused with the status-changed reason; the card keeps its buttons", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = JSON.stringify({ _generation: 5 });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED });
    expect(out.status).toBe("posted");
    const id = (out as any).message;
    const L = JSON.parse(r.files.checks!);
    expect(r.state().messages[id].checked.gen).toBe(5);
    r.files.checks = JSON.stringify({ ...L, _generation: 4 });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: status unreadable");
    expect(r.ephemerals().map((b: any) => b.content)).toEqual(["Its status changed since it was checked, so nothing was done."]);
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    r.files.checks = JSON.stringify({ ...L, _generation: 6 });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).not.toContain("refused");
  });
});

describe("1c. a reset of the keeper's copy: asks and taps wait for the next push", () => {
  test("a rebase that conflicts resets the copy; the link refuses asks and taps saying so; the next push clears it", async () => {
    const { k, l, run, read, block } = both();
    const q1 = await ask(l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    // Cain's row edit lands locally while pushes fail...
    block(true);
    k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P11", base: rowHash(openRow(read(P), "P11")!), set: { "Next step": "Mine" } }] });
    expect(run()).toMatchObject({ pushFailed: true });
    // ...and a laptop changes the same row on GitHub meanwhile.
    k.pull();
    writeFileSync(join(k.seed, P), readFileSync(join(k.seed, P), "utf8").replace("| Waiting on Dane (Ship) |", "| Theirs |"));
    k.g("add", "-A"); k.g("commit", "--quiet", "-m", "laptop"); k.g("push", "--quiet", "origin", "HEAD:main");
    catchLog();
    block(true);
    expect(run()).toMatchObject({ pushFailed: true });
    console.log = realLog;
    expect(logged.join("\n")).toContain("reset: its local commits couldn't be rebased onto GitHub's copy");
    const st = JSON.parse(l.files.status!);
    expect(st.reset.why).toContain("couldn't be rebased");
    expect(k.outcome("cain-next-1")).toBeNull();                            // run again on GitHub's copy; Cain hears once it lands
    // Asks and taps are refused, saying why; the card keeps its buttons.
    await expect(ask(l, "Q2", "the specialist's log again, read at 8:05")).rejects.toThrow("the record keeper had to reset its copy of the record");
    expect(await l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).toBe("refused: record reset");
    expect(l.ephemerals().at(-1).content).toBe("Cain's record is being put back in step, so nothing was done. Tap again in a few minutes.");
    await l.link.sweep();
    expect(l.buttons(q1.message)).toEqual(opts);
    // The next push lands: asks and taps go on.
    block(false);
    expect(run().ok).toBe(true);
    expect(JSON.parse(l.files.status!).reset).toBeUndefined();
    expect(k.outcome("cain-next-1")).toMatchObject({ state: "conflict" });
    // The card was posted before the reset epoch (0.12.0, sixth round): its tap is refused with its
    // own reason, and the sweep takes its buttons off; a new checked ask posts and counts.
    expect(await l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).toBe("refused: record reset since");
    await l.link.sweep();
    expect(l.buttons(q1.message)).toEqual([]);
    const q3 = await ask(l, "Q3", "the specialist's log again, read at 8:10");
    expect(q3.status).toBe("posted");
    expect(await l.tap(structuredClone(l.msg(q3.message)), l.ids(q3.message)[0])).toBe("to Cain");
  }, 30_000);

  test("a copy cloned again after the keeper wrote a ledger counts as a reset until the next push", () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    rmSync(k.cfg.dir, { recursive: true, force: true });
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Lunch?", ops: [{ op: "one-off", text: "Lunch?", not_about_item: true }] });
    expect(cycle(k.cfg).pushFailed).toBe(true);
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8")).reset.why).toContain("cloned again");
    expect(cycle(k.cfg).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8")).reset).toBeUndefined();
  });
});

describe("2. the sweep takes buttons off only on a verified read", () => {
  const posted = async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    expect(out.status).toBe("posted");
    const L = JSON.parse(r.files.checks!);
    const moved = JSON.stringify({ ...L, _generation: 3, P08: { ...L.P08, version: L.P08.version + 1 } });
    return { r, id: out.message as string, moved, L };
  };

  test("during or right after a push error, with an unreadable status, list or outcome, or a ledger below the last seen: buttons stay, logged once", async () => {
    for (const fail of ["unpushed", "just failed", "bad status", "no list", "no outcome", "behind"] as const) {
      const { r, id, moved, L } = await posted();
      if (fail === "behind") {
        r.files.checks = JSON.stringify({ ...L, _generation: 9 });
        await r.link.sweep();                                   // seen: 9
        expect(r.state().ledgerGen).toBe(9);
      }
      r.files.checks = fail === "behind" ? JSON.stringify({ ...JSON.parse(moved), _generation: 8 }) : moved;
      if (fail === "unpushed") r.files.status = JSON.stringify({ unpushed: true, push_failed: { at: new Date(r.t.now - HOUR).toISOString(), why: "x" } });
      if (fail === "just failed") r.files.status = JSON.stringify({ unpushed: false, push_failed: { at: new Date(r.t.now - MIN).toISOString(), why: "x" } });
      if (fail === "bad status") r.files.status = "{oops";
      if (fail === "no list") r.files.pending = null;
      if (fail === "no outcome") for (const k of Object.keys(r.outcomes)) delete r.outcomes[k];
      await r.link.sweep();
      await r.link.sweep();
      expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
      expect(r.logs.filter((x) => x.includes(`left card ${id}'s buttons on`)).length).toBe(1);
      // A verified read: off it comes.
      r.files.status = null; r.files.pending = pendingWith(["P08"], []);
      r.files.checks = JSON.stringify({ ...JSON.parse(moved), _generation: 10 });
      r.outcomes[`link-check-p08-${NOV11_8AM}`] = { state: "done" };
      await r.link.sweep();
      expect(r.buttons(id)).toEqual([]);
      expect(r.msg(id).content).toEndWith(`\n\n${STATUS_CHANGED}`);
    }
  });
});

describe("3. the clock: four sources, one diagnostic, checked at tap time, a backward step invalidates", () => {
  test("the sources in order, the Date header within its few seconds, and the diagnostic naming each", () => {
    const at = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(DATE_SKEW_MS).toBe(10_000);
    expect(dateHeaderReading("Sun, 15 Nov 2026 11:59:52 GMT", at)).toEqual({ source: "http-date", state: "synced", detail: "+8 s" });
    expect(dateHeaderReading("Sun, 15 Nov 2026 11:59:18 GMT", at)).toEqual({ source: "http-date", state: "unsynced", detail: "+42 s" });
    expect(dateHeaderReading(null, at).state).toBe("absent");
    const none: Reading[] = [{ source: "kernel", state: "unsynced", detail: "state 5, status 64" }, { source: "timedatectl", state: "absent" },
      { source: "timesyncd", state: "absent" }, dateHeaderReading("Sun, 15 Nov 2026 11:59:18 GMT", at)];
    expect(verdict(none)).toMatchObject({ synced: false, source: null,
      diagnostic: "no clock source says synchronized: kernel flag unsynced (state 5, status 64), timedatectl absent, timesyncd flag file absent, GitHub Date header unsynced (+42 s)" });
    const header: Reading[] = [...none.slice(0, 3), dateHeaderReading("Sun, 15 Nov 2026 11:59:55 GMT", at)];
    expect(verdict(header)).toMatchObject({ synced: true, source: "http-date", diagnostic: "synchronized, by the GitHub Date header (+5 s)" });
    // The kernel's flag is read first: it is the source that works on the Pi.
    expect(verdict([{ source: "kernel", state: "synced", detail: "state 0, status 8193" }, ...header.slice(1)]).source).toBe("kernel");
    expect(said({ source: "timesyncd", state: "absent" })).toBe("timesyncd flag file absent");
  });

  test("on the keeper: the Date-header source alone passes, and is recorded with the check and in its status", () => {
    const k = keeperRig();
    k.cfg.clockReadings = (_date, at) => [{ source: "kernel", state: "unreadable" }, { source: "timedatectl", state: "absent" }, { source: "timesyncd", state: "absent" },
      dateHeaderReading(new Date(at - 3_000).toUTCString(), at)];
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ checked: CHECKED, clock: "http-date" });
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8")).clock).toMatchObject({ synced: true, source: "http-date" });
  });

  test("on the keeper: with no source, one diagnostic per state change, and the refusal the link relays names it", async () => {
    catchLog();
    const k = keeperRig();
    k.cfg.clockReadings = (_date, at) => [{ source: "kernel", state: "unsynced", detail: "state 5, status 64" }, { source: "timedatectl", state: "absent" },
      { source: "timesyncd", state: "absent" }, dateHeaderReading(new Date(at - 42_000).toUTCString(), at)];
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.cain({ id: "link-check-p44-2", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    console.log = realLog;
    const diag = "no clock source says synchronized: kernel flag unsynced (state 5, status 64), timedatectl absent, timesyncd flag file absent, GitHub Date header unsynced (+42 s)";
    expect(logged.filter((x) => x.includes("clock: not synchronized")).length).toBe(1);
    expect(logged).toContain(`[record] clock: not synchronized, so no source check is taken: ${diag}`);
    expect(k.reason("link-check-p44-1")).toBe(`check P44: the keeper's clock isn't synchronized yet (${diag}), so no source check can be dated; try again in a few minutes`);
    // The link's refusal to Cain carries it.
    const { l } = both();
    l.keeper.onWait = () => { l.outcomes[l.submitted[0].id] = { state: "rejected", reason: k.reason("link-check-p44-1") }; };
    await expect(ask(l, "Q1", CHECKED)).rejects.toThrow(`the record keeper said rejected to your source check (check P44: the keeper's clock isn't synchronized yet (no clock source says synchronized: kernel flag unsynced`);
  });

  test("synchronization lost after a card posts: the tap is refused, the card keeps its buttons, and counts once it's back", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const synced = { ok: true };
    (r.link as any).d.localClock = () => verdict([{ source: "kernel", state: synced.ok ? "synced" : "unsynced" }]);
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    synced.ok = false;
    r.files.status = JSON.stringify({ clock: { synced: false, source: null, diagnostic: "no clock source says synchronized", at: new Date(r.t.now).toISOString() } });
    expect(await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0])).toBe("refused: clock");
    expect(r.ephemerals().at(-1).content).toBe("The box's clock isn't synchronized just now, so nothing was done. Tap again in a few minutes.");
    expect(r.buttons(out.message)).toEqual(["Filed", "Not filed"]);
    // The keeper's verdict says synchronized again, but the box's own sources still don't: the keeper's recent word counts.
    r.files.status = JSON.stringify({ clock: { synced: true, source: "http-date", diagnostic: "synchronized", at: new Date(r.t.now).toISOString() } });
    expect(await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0])).not.toContain("refused");
  });

  test("a backward clock step: a tap with the clock earlier than the check's acceptance is not accepted, and the keeper marks the check", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    r.later(-5 * MIN);
    expect(await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0])).toBe("dead: status changed");
    expect(r.relayed.join(" ")).not.toContain("Dane tapped");
    // The keeper: its clock reads earlier than a check's time, so the check never counts again.
    const files: Record<string, string> = { [P]: PENDING };
    const p = plan({ id: "link-check-p44-1", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] } as Request,
      tree(files), { at: T0, clockSynced: true });
    if (p.state !== "ok") throw new Error(p.state);
    for (const [k, v] of p.writes) files[k] = v!;
    const u = upkeep(tree(files), { at: new Date(T0.getTime() - 10 * MIN), clockSynced: true });
    expect(u!.stepped).toEqual(["P44"]);
    const e = parseChecks(u!.writes.get(CHECKS_PATH)!).P44;
    expect(e.stepped_back).toBe(new Date(T0.getTime() - 10 * MIN).toISOString());
    expect(openRow(u!.writes.get(P)!, "P44")).toContain("| stale, ");
  });
});

describe("4. a tap whose read goes over its limit: busy, tap again, counted in the audit", () => {
  test("its own reason, the card keeps its buttons, and the keeper's audit counts it", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    const d = (r.link as any).d, read = d.record, realNow = Date.now;
    let slow = 0;
    d.record = () => { slow += TAP_READ_MS + 200; return read(); };
    Date.now = () => realNow() + slow;
    let got = "";
    try { got = await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0]); } finally { Date.now = realNow; d.record = read; }
    expect(got).toBe("refused: busy");
    expect(r.ephemerals().at(-1).content).toBe("Busy, tap again.");
    expect(r.buttons(out.message)).toEqual(["Filed", "Not filed"]);
    expect(r.waited).toEqual([{ id: `tap-${out.message}-${r.t.now}`, at: new Date(r.t.now).toISOString(), waited_ms: expect.any(Number), kind: "tap" }]);
    expect(r.waited[0].waited_ms).toBeGreaterThan(TAP_READ_MS);
    expect((r.link as any).clockReport()).toMatchObject({ tap_read_limit_ms: TAP_READ_MS });
    const a = oneOffAudit([], pendingWith(["P08"], []), new Date(r.t.now), "America/New_York", [{ ...r.waited[0], round_ms: null }]);
    expect(a.text).toContain("0 possible matches in 0 one-offs; 0 wait timeouts; 1 tap timeout.");
    expect(a.hits[0]).toContain("a tap's fresh read of the ledger took");
    // Once the read is quick again, the tap counts.
    expect(await r.tap(structuredClone(r.msg(out.message)), r.ids(out.message)[0])).not.toContain("refused");
    expect((r.link as any).clockReport().tap_read_ms).toBeLessThan(TAP_READ_MS);
  });
});

describe("5. the smoke test's expired check (source_check_max_days 0)", () => {
  test("the keeper takes it, but the link posts nothing and says it is past the limit", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []), maxCheckDays: 0 });
    await expect(r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }))
      .rejects.toThrow("Nothing was posted: the record keeper took your source check, but it is already past source_check_max_days (0 days), so it doesn't count.");
    expect(r.posts()).toBe(0);
    const k = keeperRig();
    k.cfg.maxCheckDays = 0;
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const e = parseChecks(k.upstream(CHECKS_PATH)).P44;
    expect(e.stale_after).toBe(e.checked_at);
  });
});

describe("5, 6 and 7. the docs: the smoke test's new steps, the rollback pin, push failures, clock sources, tap reasons, heuristics", () => {
  test("DOCS.md and Cain's rules", () => {
    const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    for (const t of [docs, rules]) {
      expect(t).toContain("record.sh block-push");
      expect(t).toContain("keeper.sh clock");
      expect(t).toContain("source_check_max_days to 0");
      expect(t).toContain("Busy, tap again");
      expect(t).toContain("--reason");
    }
    expect(docs).toContain("pinned to the version installed on the Pi (0.11.0 today)");
    expect(docs).toContain("After any rebase onto a version bump");
    expect(docs).toContain("never resets the keeper's copy");
    expect(docs).toContain("status 8193");
    expect(docs).toContain("heuristics");
    expect(log).toContain("push");
  });
});
