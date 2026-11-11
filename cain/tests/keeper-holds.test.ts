// The record keeper with holds, end to end against a real git repo standing in for
// GitHub: the keeper's own copy of the holds, takes waiting behind Cain's jobs, a
// day's expiry and keeper downtime, the faster local cycle, and this morning's
// collisions replayed.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdsText, noteRows, openRow, rowHash } from "../rootfs/opt/cain/record/core.ts";
import { blobSha, cycle, keep } from "../rootfs/opt/cain/record/main.ts";
import { A, B, PENDING, SA, SB, T0, hrs, rig } from "./rig.ts";

const P = "state/PENDING.md";
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });
const row = (id: string, text = PENDING) => rowHash(openRow(text, id)!);
const edit = (text: string, from: string, to: string) => { expect(text).toContain(from); return text.replace(from, to); };

describe("the keeper's holds", () => {
  test("a take from the inbox is granted, published in state/holds.json and kept in /data", () => {
    const r = rig();
    r.inbox(["20261111T130000Z-a-000001.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: the collision fix", { branches: ["claude/record-holds"] })] }]);
    expect(cycle(r.cfg)).toEqual({ applied: 1, ok: true });
    expect(r.states("lap-take-1")).toEqual(["done"]);
    const want = { P33: { holder: A, for: "chat: the collision fix", branches: ["claude/record-holds"], taken: T0.toISOString(), renewed: T0.toISOString() } };
    expect(r.upstream("state/holds.json")).toBe(holdsText(want));
    expect(r.kept().holds).toEqual(want);
    expect(r.upstream("inbox/20261111T130000Z-a-000001.json")).toBeNull();
  }, 30_000);

  test("no request writes state/holds.json, and a copy changed by hand is put back", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(r.cfg);
    r.cain({ id: "cain-holds-1", ops: [{ op: "put", path: "state/holds.json", content: "{}\n", base: blobSha(r.upstream("state/holds.json")!) }] });
    cycle(r.cfg);
    expect(r.outcome("cain-holds-1")).toMatchObject({ state: "rejected", reason: "state/holds.json: not a place requests may write" });
    // Someone pushes a different copy straight to the record...
    r.pull();
    writeFileSync(join(r.seed, "state/holds.json"), "{}\n");
    r.g("add", "-A"); r.g("commit", "--quiet", "-m", "by hand"); r.g("push", "--quiet", "origin", "HEAD:main");
    // ...and the next round puts the keeper's back, with nothing queued.
    expect(cycle(r.cfg).ok).toBe(true);
    expect(r.holds()).toMatchObject({ P33: { holder: A } });
    expect(r.subjects(1)[0]).toBe("Holds: state/holds.json put back to the keeper's copy");
    // Nothing to put back: no new commit.
    const head = r.g("rev-parse", "HEAD");
    cycle(r.cfg);
    r.pull();
    expect(r.g("rev-parse", "HEAD")).toBe(head);
  }, 30_000);

  test("a take waits behind Cain's job, and goes through in the round Cain lets go", () => {
    const r = rig();
    r.cain({ id: "cain-job-take", ops: [take("P33", "his Start tap, 7:12 AM", { branches: ["claude/wave1-merge-lane"], job: "build cse_01X" })] });
    cycle(r.cfg);
    expect(r.holds().P33).toMatchObject({ holder: "cain", job: "build cse_01X" });
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: finish the merge lane (laptop chat)")] }]);
    cycle(r.cfg);
    expect(r.states("lap-take-1")).toEqual(["waiting"]);
    expect(r.reason("lap-take-1")).toContain("P33 is held by cain (a job: build cse_01X)");
    expect(r.kept().waiting).toHaveLength(1);
    expect(r.upstream("inbox/1.json")).toBeNull();
    // Rounds while the job runs leave it waiting, and say nothing more.
    r.at(hrs(1));
    cycle(r.cfg);
    expect(r.states("lap-take-1")).toEqual(["waiting"]);
    // The job ends.
    r.cain({ id: "cain-job-done", ops: [{ op: "release", item: "P33" }] });
    cycle(r.cfg);
    expect(r.states("lap-take-1")).toEqual(["waiting", "done"]);
    expect(r.holds()).toEqual({ P33: { holder: A, for: "dane: finish the merge lane (laptop chat)", branches: [], taken: hrs(1).toISOString(), renewed: hrs(1).toISOString() } });
    expect(r.kept().waiting).toEqual([]);
  }, 30_000);

  test("a waiting take is refused when the job's hold passes to someone else", () => {
    const r = rig();
    r.cain({ id: "cain-job-take", ops: [take("P33", "his Start tap", { job: "ship cse_02Y" })] });
    cycle(r.cfg);
    r.inbox(["1.json", { id: "lap-take-b", from: B, ops: [take("P33", "chat: rebase PR #3")] }]);
    cycle(r.cfg);
    r.cain({ id: "cain-pass", ops: [{ op: "pass", item: "P33", to: A }] });
    cycle(r.cfg);
    expect(r.states("lap-take-b")).toEqual(["waiting", "refused"]);
    expect(r.reason("lap-take-b")).toBe(`P33 is held by ${A}`);
  }, 30_000);

  test("a hold ends after a day without a word from its holder", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(r.cfg);
    for (let h = 1; h <= 23; h += 11) { r.running(hrs(h)); cycle(r.cfg); }   // the keeper runs on, A says nothing
    expect(r.holds()).toMatchObject({ P33: { holder: A } });
    expect(r.kept().downtime).toEqual([]);
    r.running(hrs(24.5));
    cycle(r.cfg);
    expect(r.holds()).toEqual({});
    expect(r.subjects(1)[0]).toBe(`Holds: P33 (${A}) ended after a day without a word from the holder`);
  }, 30_000);

  test("time the keeper was down doesn't count toward the day", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(r.cfg);
    r.running(hrs(1)); cycle(r.cfg);
    r.at(hrs(11)); cycle(r.cfg);   // ten hours with no round: the Pi was off
    expect(r.kept().downtime).toEqual([[hrs(1).toISOString(), hrs(11).toISOString()]]);
    for (let h = 12; h <= 30; h += 6) { r.running(hrs(h)); cycle(r.cfg); }
    expect(r.holds()).toMatchObject({ P33: { holder: A } });   // 30 hours, 10 of them down: 20 idle
    r.running(hrs(34.5)); cycle(r.cfg);
    expect(r.holds()).toEqual({});
  }, 60_000);

  test("a keeper starting with no copy of its own (a new install) starts from the record's", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/a"] })] }]);
    cycle(r.cfg);
    const pushed = r.upstream("state/holds.json");
    rmSync(r.cfg.holds!);
    rmSync(r.cfg.dir, { recursive: true, force: true });
    cycle(r.cfg);
    expect(r.kept().holds).toMatchObject({ P33: { holder: A, branches: ["claude/a"] } });
    expect(r.upstream("state/holds.json")).toBe(pushed);
  }, 30_000);

  test("a round that stopped right after its push keeps what it pushed", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(r.cfg);
    const pushed = r.kept();
    const head = r.g("ls-remote", r.remote, "refs/heads/main").split(/\s/)[0];
    // As if it stopped between the push and saving: the journal is there, the save isn't.
    writeFileSync(`${r.cfg.holds}.next`, JSON.stringify({ commit: head, state: pushed }));
    writeFileSync(r.cfg.holds!, JSON.stringify({ holds: {}, waiting: [], downtime: [], alive: pushed.alive }));
    cycle(r.cfg);
    expect(r.kept().holds).toEqual(pushed.holds);
    expect(r.holds()).toMatchObject({ P33: { holder: A } });
    expect(existsSync(`${r.cfg.holds}.next`)).toBe(false);
    // A journal whose push never reached GitHub is dropped: its requests run again.
    writeFileSync(`${r.cfg.holds}.next`, JSON.stringify({ commit: "f".repeat(40), state: { ...pushed, holds: {} } }));
    cycle(r.cfg);
    expect(r.kept().holds).toEqual(pushed.holds);
  }, 30_000);
});

describe("the faster keeper", () => {
  test("Cain's queue gets a round within one 2-second look; GitHub's inbox, every minute", async () => {
    const r = rig();
    let t = 0;
    const runs: number[] = [];
    const run = () => { runs.push(t); for (const n of readdirSync(r.cfg.queue)) rmSync(join(r.cfg.queue, n)); return { ok: true }; };
    const sleep = async (ms: number) => { t += ms; if (t === 10_000) r.cain({ id: "cain-fast-1", ops: [] }); };
    await keep(r.cfg, { pollMs: 2_000, fullMs: 60_000, clock: () => t, sleep, run, nightly: false, stop: () => t >= 130_000 });
    expect(runs).toEqual([0, 10_000, 70_000]);
  });

  test("after a failed round, Cain's queue waits for the next minute instead of retrying every 2 seconds", async () => {
    const r = rig();
    let t = 0;
    const runs: number[] = [];
    const run = () => { runs.push(t); const ok = t > 0; if (ok) for (const n of readdirSync(r.cfg.queue)) rmSync(join(r.cfg.queue, n)); return { ok }; };
    const sleep = async (ms: number) => { t += ms; if (t === 2_000) r.cain({ id: "cain-fast-2", ops: [] }); };
    await keep(r.cfg, { pollMs: 2_000, fullMs: 60_000, clock: () => t, sleep, run, nightly: false, stop: () => t >= 100_000 });
    expect(runs).toEqual([0, 60_000]);
  });

  test("for real: a request Cain queues is applied and confirmed within seconds", async () => {
    const r = rig();
    r.at(new Date());
    let applied = false;
    const loop = keep(r.cfg, { pollMs: 25, fullMs: 600_000, nightly: false, stop: () => applied });
    await Bun.sleep(300);
    const started = Date.now();
    r.cain({ id: "cain-fast-3", ops: [{ op: "row", item: "P44", base: row("P44"), set: { "Next step": "First in the build queue" } }] });
    while (!applied && Date.now() - started < 20_000) { await Bun.sleep(25); applied = r.outcome("cain-fast-3") !== null; }
    await loop;
    expect(r.outcome("cain-fast-3")).toMatchObject({ state: "done" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(openRow(r.upstream(P), "P44")).toContain("First in the build queue");
  }, 30_000);
});

describe("this morning, replayed", () => {
  test("a laptop and Cain both change P33: the one that doesn't hold it is refused, naming the holder", () => {
    const r = rig();
    r.inbox(["20261111T121500Z-a-000001.json", { id: "laptop-2026-11-11-harness-hold", from: A,
      ops: [take("P33", "dane: the laptop holds harness work until the collision fix ships (laptop chat, 7:42 AM)", { branches: ["claude/wave1-merge-lane"] })] }]);
    cycle(r.cfg);
    // Cain's row edit and Cain's whole-file put of P33 are both turned away.
    r.cain({ id: "cain-2026-11-11-hold-harness", ops: [{ op: "row", item: "P33", base: row("P33"), set: { "Next step": "Cain holds harness work until it is done" } }] });
    r.cain({ id: "cain-2026-11-11-hold-harness-2", ops: [{ op: "put", path: P, base: blobSha(PENDING),
      content: edit(PENDING, "The laptop session holds all harness work", "Cain holds harness work until it is done") }] });
    cycle(r.cfg);
    for (const id of ["cain-2026-11-11-hold-harness", "cain-2026-11-11-hold-harness-2"]) {
      expect(r.outcome(id)).toMatchObject({ state: "refused", reason: `P33 is held by ${A}` });
      expect(r.relayed()).toContain(`Your record change ${id} ("s") was refused: P33 is held by ${A}. That item has another holder; don't send it again.`);
    }
    expect(r.upstream(P)).toBe(PENDING);
    // The holder's own edit lands.
    r.inbox(["20261111T122000Z-a-000002.json", { id: "lap-p33-next", from: A, ops: [{ op: "row", item: "P33", base: row("P33"), set: { "Next step": "PR A is open" } }] }]);
    cycle(r.cfg);
    expect(r.states("lap-p33-next")).toEqual(["done"]);
    // And the other way round: a laptop's edit to a row Cain's job holds is refused too.
    r.cain({ id: "cain-p44-job", ops: [take("P44", "his Start tap", { job: "build cse_03Z", branches: ["claude/p44-plain-words"] })] });
    cycle(r.cfg);
    r.inbox(["20261111T122500Z-b-000003.json", { id: "lap-p44-edit", from: B, ops: [{ op: "row", item: "P44", base: row("P44"), set: { "Who": "Cain" } }] }]);
    cycle(r.cfg);
    expect(r.states("lap-p44-edit")).toEqual(["refused"]);
    expect(r.reason("lap-p44-edit")).toBe("P44 is held by cain (a job: build cse_03Z)");
  }, 60_000);

  test("his words to the one that doesn't hold P33 land as a note, while its row edit is refused", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: the laptop holds harness work (laptop chat, 7:42 AM)")] }]);
    cycle(r.cfg);
    r.cain({ id: "cain-p33-edit", ops: [{ op: "row", item: "P33", base: row("P33"), set: { "Next step": "PR #1 Ship asked again" } }] });
    r.cain({ id: "cain-p33-note", ops: [{ op: "note", item: "P33", text: "Dane in Discord, 7:16 AM: By laptop session I want you to go do for me" }] });
    r.inbox(["2.json", { id: "lap-b-note", from: B, ops: [{ op: "note", item: "P33", text: "Dane, other laptop chat: PR #3 rebases after the collision fix" }] }]);
    cycle(r.cfg);
    expect(r.outcome("cain-p33-edit")).toMatchObject({ state: "refused", reason: `P33 is held by ${A}` });
    expect(r.outcome("cain-p33-note")).toMatchObject({ state: "done" });
    expect(r.states("lap-b-note")).toEqual(["done"]);
    expect(noteRows(r.upstream("state/notes/P33.md"))).toEqual([
      { when: T0.toISOString(), from: "cain", text: "Dane in Discord, 7:16 AM: By laptop session I want you to go do for me" },
      { when: T0.toISOString(), from: B, text: "Dane, other laptop chat: PR #3 rebases after the collision fix" },
    ]);
    expect(r.upstream(P)).toBe(PENDING);
    expect(r.holds()).toMatchObject({ P33: { holder: A } });
  }, 30_000);

  test("Cain's fixes job can't take the branch a laptop holds", () => {
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: build the merge lane", { branches: ["claude/wave1-merge-lane"] })] }]);
    cycle(r.cfg);
    r.cain({ id: "cain-2026-11-11-pr2-fixes", ops: [take("P14", "his Start tap on the PR #2 fixes", { branches: ["claude/wave1-merge-lane"], job: "build cse_04W" })] });
    cycle(r.cfg);
    expect(r.outcome("cain-2026-11-11-pr2-fixes")).toMatchObject({ state: "refused", reason: `branch claude/wave1-merge-lane is already held, with P33 (by ${A})` });
  }, 30_000);

  test("a whole-file put by one writer and a row edit by the other, on different rows: both land, in either order", () => {
    // Same round: Cain's put of P44 (made from the list as it was) and the laptop's edit of P33.
    const r = rig();
    r.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(r.cfg);
    r.cain({ id: "cain-p44-put", ops: [{ op: "put", path: P, base: blobSha(PENDING), content: edit(PENDING, "Hold the Build until P33 lifts", "First in the build queue") }] });
    r.inbox(["2.json", { id: "lap-p33-row", from: A, ops: [{ op: "row", item: "P33", base: row("P33"), set: { "Next step": "PR A is open" } }] }]);
    cycle(r.cfg);
    expect([r.outcome("cain-p44-put")?.state, ...r.states("lap-p33-row")]).toEqual(["done", "done"]);
    expect(openRow(r.upstream(P), "P44")).toContain("First in the build queue");
    expect(openRow(r.upstream(P), "P33")).toContain("PR A is open");

    // The laptop's edit first, then a whole-file put made before it: laid on top, both stand.
    const s = rig();
    s.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(s.cfg);
    s.inbox(["2.json", { id: "lap-p33-row", from: A, ops: [{ op: "row", item: "P33", base: row("P33"), set: { "Next step": "PR A is open" } }] }]);
    cycle(s.cfg);
    s.cain({ id: "cain-p44-put", ops: [{ op: "put", path: P, base: blobSha(PENDING), content: edit(PENDING, "Hold the Build until P33 lifts", "First in the build queue") }] });
    cycle(s.cfg);
    expect(s.outcome("cain-p44-put")).toMatchObject({ state: "done" });
    expect(openRow(s.upstream(P), "P44")).toContain("First in the build queue");
    expect(openRow(s.upstream(P), "P33")).toContain("PR A is open");
  }, 60_000);

  test("Cain's two requests that changed nothing are rejected, not logged as done", () => {
    const r = rig();
    const head = r.g("rev-parse", "HEAD");
    r.cain({ id: "cain-2026-11-11-p44-direct", summary: "P44: add his direct-command fix", ops: [{ op: "put", path: P, base: blobSha(PENDING), content: PENDING }] });
    r.cain({ id: "cain-2026-11-11-p44-direct2", summary: "P44: add his direct-command fix", ops: [{ op: "put", path: P, base: blobSha(PENDING), content: PENDING }] });
    cycle(r.cfg);
    for (const id of ["cain-2026-11-11-p44-direct", "cain-2026-11-11-p44-direct2"]) {
      expect(r.states(id)).toEqual(["rejected"]);
      expect(r.outcome(id)).toMatchObject({ state: "rejected", reason: "changes nothing" });
      expect(r.relayed()).toContain(`Your record change ${id} ("P44: add his direct-command fix") was not applied: rejected, changes nothing.`);
    }
    expect(r.g("diff", "--stat", head, "HEAD", "--", P)).toBe("");
  }, 30_000);

  test("two laptop sessions take one item at once: one wins, the other is refused", () => {
    const r = rig();
    r.inbox(
      [`20261111T124500Z-${SA}-a1b2c3.json`, { id: "lap-a-take-p45", from: A, ops: [take("P45", "made it: the collision fix (laptop chat)")] }],
      [`20261111T124500Z-${SB}-d4e5f6.json`, { id: "lap-b-take-p45", from: B, ops: [take("P45", "chat: the collision fix")] }],
    );
    cycle(r.cfg);
    expect(r.states("lap-a-take-p45")).toEqual(["done"]);
    expect(r.states("lap-b-take-p45")).toEqual(["refused"]);
    expect(r.reason("lap-b-take-p45")).toBe(`P45 is held by ${A}`);
    expect(r.holds()).toMatchObject({ P45: { holder: A } });
  }, 30_000);
});
