// Source checks, fifth review round (0.12.0): taps acknowledged at once with a deferred answer and
// their fresh read cancelled at its limit; a backward clock step only past the Date header's skew
// margin, and the offset logged; a generation floor that survives a re-clone with the keeper's
// state file lost; taps honoured while the ledger is unpushed journaled and reported after a
// reset, and refused once a push failure is over 30 minutes old; one notice to Dane for a long
// outage; settled takes kept until their push lands; the smoke test's switches; and the docs.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DATE_SKEW_MS } from "../rootfs/opt/cain/clock";
import { plainPush, TAP_READ_MS, UNPUSHED_TAP_MS } from "../rootfs/opt/cain/link/core";
import { CHECKS_PATH, generationOf, isFresh, openRow, parseChecks, plan, rowHash, upkeep, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";
import { cycle, leakCheck, linkFloor, redact, requestLoggedIn } from "../rootfs/opt/cain/record/main.ts";
import { MIN, pendingWith, rig as linkRig } from "./link-rig";
import { A, PENDING, T0, hrs, rig as keeperRig } from "./rig.ts";

const P = "state/PENDING.md";
const CHECKED = "the specialist's log, read at 8 this morning";
const opts = ["Fixed", "Not fixed"];
const tree = (files: Record<string, string>): Tree => ({ sha: (p) => (p in files ? "x".repeat(40) : null), read: (p) => files[p] ?? null });
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });

const logged: string[] = [];
const realLog = console.log;
const catchLog = () => { logged.length = 0; console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; };
afterEach(() => { console.log = realLog; });

// The link and a real keeper on a git repo, as on the Pi (as in the fourth round's tests).
function both() {
  const k = keeperRig();
  const l = linkRig({ unchecked: true, pending: PENDING });
  const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
  let n = 0;
  const sync = () => {
    l.files.pending = read(P);
    l.files.checks = read(CHECKS_PATH);
    l.files.status = existsSync(join(k.root, "pi/record-ledger.json")) ? readFileSync(join(k.root, "pi/record-ledger.json"), "utf8") : null;
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
  l.survive.fn = (id: string) => requestLoggedIn(k.cfg.dir, id);    // log/requests on the keeper's copy
  const block = (on: boolean) => { const f = join(k.root, "pi/record-block-push"); if (on) writeFileSync(f, ""); else rmSync(f, { force: true }); };
  return { k, l, run, read, block };
}

const ask = (l: ReturnType<typeof linkRig>, q: string, checked?: string) =>
  l.link.ask({ text: "Is the specialist fixed?", options: opts, item: "P44", question: q, ...(checked ? { checked } : {}) }) as Promise<any>;
const posted = async () => {
  const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
  const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
  expect(out.status).toBe("posted");
  return { r, id: out.message as string };
};
const synced = (now: number) => ({ synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(now).toISOString() });

describe("1. taps: a deferred answer at once, then the fresh read, cancelled at its limit", () => {
  test("a read that stalls past the limit answers busy within the limit; the read is aborted, the buttons stay, the audit counts it", async () => {
    const { r, id } = await posted();
    const d = (r.link as any).d;
    let aborted = false, answeredBeforeRead: number[] = [];
    d.readFresh = (_id: string | null, signal: AbortSignal) => {
      answeredBeforeRead = r.answers();
      return new Promise((_ok, no) => { signal.addEventListener("abort", () => { aborted = true; no(new Error("aborted")); }); });
    };
    const t0 = performance.now();
    const got = await r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    const took = performance.now() - t0;
    expect(got).toBe("refused: busy");
    expect(answeredBeforeRead).toEqual([6]);                       // the deferred answer went first
    expect(aborted).toBe(true);                                     // the read itself was cancelled
    expect(took).toBeGreaterThanOrEqual(TAP_READ_MS - 50);
    expect(took).toBeLessThan(TAP_READ_MS + 500);                   // within the limit, never Discord's 3 seconds
    expect(r.answers()).toEqual([6]);                               // no second answer: the busy line is a follow-up
    expect(r.ephemerals().at(-1)).toMatchObject({ content: "Busy, tap again.", flags: 64 });
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(r.relayed.join(" ")).not.toContain("Dane tapped");
    expect(r.waited).toEqual([expect.objectContaining({ kind: "tap", waited_ms: expect.any(Number) })]);
    expect(r.waited[0].waited_ms).toBeGreaterThanOrEqual(TAP_READ_MS);
    expect(r.logs.join("\n")).toContain("tap refused: the ledger's read took");
  });

  test("a read that returns in time is honoured as before: the card is edited through the deferred answer", async () => {
    const { r, id } = await posted();
    const d = (r.link as any).d;
    let signalSeen = false;
    d.readFresh = async (oid: string | null, signal: AbortSignal) => {
      signalSeen = signal instanceof AbortSignal;
      await new Promise((ok) => setTimeout(ok, 30));
      return { files: { ...r.files }, outcome: oid ? r.outcomes[oid] ?? null : null };
    };
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[1])).toBe("to Cain");
    expect(signalSeen).toBe(true);
    expect(r.answers()).toEqual([6]);
    expect(r.calls.filter((c) => c.method === "PATCH" && c.path === "/webhooks/999/t/messages/@original")).toHaveLength(1);
    expect(r.msg(id).content).toBe("Is the packet filed?\n\nYou answered: Not filed");
    expect(r.buttons(id)).toEqual([]);
    expect(r.relayed.at(-1)).toContain('Dane tapped "Not filed"');
    expect((r.link as any).clockReport().tap_read_ms).toBeLessThan(TAP_READ_MS);
  });

  test("the smoke test's delayed read (keeper.sh slow-read) answers busy once, buttons kept; the next tap counts", async () => {
    const { r, id } = await posted();
    (r.link as any).d.tapReadMs = 150;
    expect(r.link.slowRead()).toMatchObject({ status: "ok", delay_ms: 1150 });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: busy");
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
  });

  test("the smoke test's measured reads (keeper.sh reads): twenty fresh reads, their 95th percentile and a verdict", async () => {
    const { r } = await posted();
    const out = await r.link.probeReads(20) as any;
    expect(out).toMatchObject({ status: "ok", reads: 20, busy: 0, limit_ms: TAP_READ_MS, pass: true });
    expect(out.reads_ms).toHaveLength(20);
    expect(out.p95_ms).toBeLessThanOrEqual(1_000);
  });
});

describe("2. a backward clock step counts only past the Date header's skew margin", () => {
  const checked = () => {
    const files: Record<string, string> = { [P]: PENDING };
    const p = plan({ id: "link-check-p44-1", from: "cain", kind: "change", summary: "s", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] } as Request,
      tree(files), { at: T0, clockSynced: true });
    if (p.state !== "ok") throw new Error(p.state);
    for (const [k, v] of p.writes) files[k] = v!;
    return files;
  };

  test("within the margin the check stands; past it, it is marked stepped back and never counts again", () => {
    expect(DATE_SKEW_MS).toBe(10_000);
    const files = checked();
    const e = parseChecks(files[CHECKS_PATH]).P44;
    expect(isFresh(e, T0.getTime() - 5_000)).toBe(true);
    expect(isFresh(e, T0.getTime() - DATE_SKEW_MS)).toBe(true);
    expect(isFresh(e, T0.getTime() - DATE_SKEW_MS - 1)).toBe(false);
    expect(upkeep(tree(files), { at: new Date(T0.getTime() - 5_000), clockSynced: true })).toBeNull();
    const u = upkeep(tree(files), { at: new Date(T0.getTime() - 15_000), clockSynced: true });
    expect(u!.stepped).toEqual(["P44"]);
  });

  test("the link: a tap a few seconds behind the keeper's clock is honoured; one well behind is not", async () => {
    const { r, id } = await posted();
    r.later(-5_000);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    const b = await posted();
    b.r.later(-20_000);
    expect(await b.r.tap(structuredClone(b.r.msg(b.id)), b.r.ids(b.id)[0])).toBe("dead: status changed");
  });

  test("the keeper logs its measured offset against GitHub's Date header each round it has one", () => {
    catchLog();
    const k = keeperRig();
    k.cfg.fetchDate = () => new Date(T0.getTime() - 8_000).toUTCString();
    cycle(k.cfg);
    cycle(k.cfg);
    console.log = realLog;
    expect(logged.filter((x) => x === "[record] clock: offset against GitHub's Date header +8 s")).toHaveLength(2);
  });
});

describe("3. the generation floor: the keeper's state file is outside the working copy, and a re-clone never goes below a posted card", () => {
  test("the state file's default lives in /data, outside /data/record", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    expect(src).toContain(`holds: process.env.RECORD_HOLDS ?? "/data/record-holds.json"`);
    expect(src).toContain(`dir: process.env.RECORD_DIR ?? "/data/record"`);
    const k = keeperRig();
    expect(relative(k.cfg.dir, k.cfg.holds!)).toStartWith("..");
  });

  test("a re-clone with the state file deleted: the generation is seeded from the link's posted card, never below it", () => {
    const k = keeperRig();
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    const g1 = generationOf(k.upstream(CHECKS_PATH));
    // A check accepted while pushes fail, and a card posted on it at the new generation.
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    const L = parseChecks(k.upstream(CHECKS_PATH)).P11;
    k.cain({ id: "link-check-p11-1", ops: [{ op: "check", item: "P11", text: CHECKED, row: L.id, version: L.version }] });
    expect(cycle(k.cfg).pushFailed).toBe(true);
    const g2 = generationOf(readFileSync(join(k.cfg.dir, CHECKS_PATH), "utf8"));
    expect(g2).toBe(g1 + 1);
    mkdirSync(join(k.root, "pi/link"), { recursive: true });
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify({ postedGen: g2, messages: { "1": { checked: { row: "r1", version: 1, req: "link-check-p11-1", gen: g2 } } } }));
    expect(linkFloor(k.cfg)).toBe(g2);
    // The copy and the keeper's state file are both lost: the copy comes back from GitHub at g1.
    rmSync(k.cfg.dir, { recursive: true, force: true });
    rmSync(k.cfg.holds!, { force: true });
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    cycle(k.cfg);
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st.reset.why).toContain("cloned again");
    expect(st.generation).toBeGreaterThan(g2);
    expect(generationOf(readFileSync(join(k.cfg.dir, CHECKS_PATH), "utf8"))).toBeGreaterThan(g2);
    // Once it pushes, GitHub's ledger is above the card too, and nothing went below it on the way.
    expect(cycle(k.cfg).ok).toBe(true);
    expect(generationOf(k.upstream(CHECKS_PATH))).toBeGreaterThan(g2);
    expect(JSON.parse(readFileSync(k.cfg.holds!, "utf8")).generation).toBeGreaterThan(g2);
  }, 30_000);
});

describe("4. taps honoured while the ledger is unpushed: journaled, judged after a reset, refused after 30 minutes", () => {
  test("a tap during a push failure, then a forced conflict reset: its check survived, so it stands; the journal clears once a push lands", async () => {
    const { k, l, run, read, block } = both();
    const q1 = await ask(l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    const gen = l.state().messages[q1.message].checked!.gen;
    block(true);
    k.cain({ id: "cain-next-1", ops: [{ op: "row", item: "P11", base: rowHash(openRow(read(P), "P11")!), set: { "Next step": "Mine" } }] });
    expect(run()).toMatchObject({ pushFailed: true });
    expect(await l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).toBe("to Cain");
    expect(l.state().uncertain).toEqual([{ gen, check: expect.stringMatching(/^link-check-p44-/), item: "P44", at: l.t.now, msg: q1.message, label: "Fixed", epoch: 0, key: expect.any(String) }]);
    await l.link.sweep();
    expect(l.relayed.join(" ")).not.toContain("may not have landed");   // no reset yet: nothing to say
    // A forced conflict resets the copy while pushes still fail.
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    block(true);
    l.later(MIN); k.at(new Date(l.t.now));                              // the keeper's clock moves with the link's
    expect(run()).toMatchObject({ pushFailed: true });
    expect(JSON.parse(l.files.status!).reset.why).toContain("conflict forced by the smoke test");
    // Round 7: the check this tap rested on was pushed before the reset, so it survived it (its
    // request is in log/requests on the keeper's copy): the tap stands, and nobody is told otherwise.
    const before = l.posts();
    await l.link.sweep();
    expect(l.logs.join("\n")).toContain("rests on a check that survived the reset: it stands");
    expect(l.relayed.join(" ")).not.toContain("lost to the record's reset");
    expect(l.posts()).toBe(before);
    await l.link.sweep();
    expect(l.posts()).toBe(before);
    // The push lands: the journal is cleared.
    block(false);
    expect(run().ok).toBe(true);
    await l.link.sweep();
    expect(l.state().uncertain).toBeUndefined();
  }, 30_000);

  test("a push landing with no reset clears the journal silently", async () => {
    const { r, id } = await posted();
    r.files.status = JSON.stringify({ unpushed: true, push_failed: { at: new Date(r.t.now).toISOString(), why: "x", since: new Date(r.t.now).toISOString() }, clock: synced(r.t.now) });
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    expect(r.state().uncertain).toHaveLength(1);
    r.files.status = JSON.stringify({ unpushed: false, clock: synced(r.t.now) });
    await r.link.sweep();
    expect(r.state().uncertain).toBeUndefined();
    expect(r.relayed.join(" ")).not.toContain("may not have landed");
  });

  test("once a push failure is older than 30 minutes, taps are refused with their own reason and keep their buttons", async () => {
    const at = (r: ReturnType<typeof linkRig>, ago: number) => JSON.stringify({ unpushed: true, clock: synced(r.t.now),
      push_failed: { at: new Date(r.t.now - MIN).toISOString(), why: "x", since: new Date(r.t.now - ago).toISOString() },
      outage: { since: new Date(r.t.now - ago).toISOString(), rounds: Math.round(ago / MIN) } });
    const { r, id } = await posted();
    r.files.status = at(r, UNPUSHED_TAP_MS + MIN);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("refused: record unpushed");
    expect(r.ephemerals().at(-1).content).toBe("Cain's record hasn't saved for over half an hour, so nothing was done. Tap again once it has.");
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
    expect(r.state().uncertain).toBeUndefined();
    r.files.status = at(r, UNPUSHED_TAP_MS - MIN);
    expect(await r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).toBe("to Cain");
    expect(r.state().uncertain).toHaveLength(1);
  });
});

describe("5. a long outage: one notice to Dane with the push error in plain words", () => {
  const down = (r: ReturnType<typeof linkRig>, ago: number, rounds: number, why = "git push: fatal: unable to access 'https://github.com/HyndeSyte/org.git/': Could not resolve host: github.com") =>
    JSON.stringify({ unpushed: true, clock: synced(r.t.now), push_failed: { at: new Date(r.t.now).toISOString(), why, since: new Date(r.t.now - ago).toISOString() },
      outage: { since: new Date(r.t.now - ago).toISOString(), rounds } });
  const notices = (r: ReturnType<typeof linkRig>) => r.cards().filter((m: any) => String(m.content).startsWith("Cain's record hasn't saved"));

  test("after three rounds, or after 30 minutes: one notice per outage, through the link's own notice path", async () => {
    const r = linkRig({ pending: pendingWith(["P08"], []) });
    r.files.status = down(r, 2 * MIN, 2);
    await r.link.sweep();
    expect(notices(r)).toHaveLength(0);
    r.files.status = down(r, 3 * MIN, 3);
    await r.link.sweep();
    expect(notices(r)).toHaveLength(1);
    expect(notices(r)[0].content).toBe("Cain's record hasn't saved to GitHub since 7:57 AM: GitHub didn't answer. Nothing is lost: the box keeps its copy and keeps trying.");
    expect(notices(r)[0].content).not.toContain("github.com");
    expect(r.state().messages[notices(r)[0].id]).toMatchObject({ kind: "notice" });
    r.later(40 * MIN);
    r.files.status = down(r, 43 * MIN, 40);
    await r.link.sweep();
    expect(notices(r)).toHaveLength(1);                                 // the same outage: once
    expect(r.relayed.join(" ")).not.toContain("hasn't saved");          // Dane's notice, not a line for Cain to reply with
    // A later outage gets its own.
    r.files.status = JSON.stringify({ unpushed: false, clock: synced(r.t.now) });
    await r.link.sweep();
    r.later(HOUR_MS);
    r.files.status = down(r, 31 * MIN, 1, "git push: remote: Invalid username or password. fatal: Authentication failed");
    await r.link.sweep();
    expect(notices(r)).toHaveLength(2);
    expect(notices(r)[1].content).toContain("GitHub turned down the box's sign-in (the GitHub token in the App's options may have expired)");
  });

  test("the push errors in plain words", () => {
    expect(plainPush("git push: fatal: '/data/record/.git/no-such-remote.git' does not appear to be a git repository", false)).toBe("the smoke test is blocking it on purpose");
    expect(plainPush("git push: ! [rejected] HEAD -> main (non-fast-forward)", false)).toBe("GitHub turned the save down");
    expect(plainPush(undefined, true)).toBe("the box had to start its copy over");
    expect(plainPush("its local commits couldn't be rebased onto GitHub's copy", true)).toBe("GitHub's copy changed in a way the box couldn't merge");
  });

  test("the keeper counts the outage's rounds from its first failure, and clears them once a push lands", () => {
    const k = keeperRig();
    writeFileSync(join(k.root, "pi/record-block-push"), String(T0.getTime() + 10 * MIN));   // block-push 10
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Lunch?", ops: [{ op: "one-off", text: "Lunch?", not_about_item: true }] });
    for (let i = 0; i < 3; i++) { k.at(new Date(T0.getTime() + i * MIN)); expect(cycle(k.cfg).pushFailed).toBe(true); }
    const st = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(st.outage).toEqual({ since: T0.toISOString(), rounds: 3 });
    expect(st.push_failed.since).toBe(T0.toISOString());
    expect(existsSync(join(k.root, "pi/record-block-push"))).toBe(true);      // still within its minutes
    k.at(new Date(T0.getTime() + 11 * MIN));
    expect(cycle(k.cfg).pushFailed).toBe(true);                               // its last blocked round
    expect(existsSync(join(k.root, "pi/record-block-push"))).toBe(false);
    expect(cycle(k.cfg).ok).toBe(true);
    const after = JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"));
    expect(after.outage).toBeUndefined();
    expect(after.unpushed).toBe(false);
  }, 30_000);
});
const HOUR_MS = 60 * MIN;

describe("6. settled takes stay queued until their push lands, so a reset reruns them", () => {
  test("a take settled in a commit that a reset lost is planned again and lands", () => {
    const k = keeperRig();
    k.cain({ id: "cain-job-take", ops: [take("P33", "his Start tap, 7:12 AM", { branches: ["claude/wave1-merge-lane"], job: "build cse_01X" })] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: finish the merge lane (laptop chat)")] }]);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("lap-take-1")).toEqual(["waiting"]);
    // The job ends while pushes fail: the take is settled in a local commit, and kept.
    k.at(hrs(1));
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    k.cain({ id: "cain-job-done", ops: [{ op: "release", item: "P33" }] });
    expect(cycle(k.cfg).pushFailed).toBe(true);
    expect(k.kept().waiting).toEqual([]);
    expect(k.kept().settled.map((w: any) => w.req.id)).toEqual(["lap-take-1"]);
    // A reset loses that commit: the take waits again and is planned again in the same round.
    catchLog();
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    expect(cycle(k.cfg).pushFailed).toBe(true);
    console.log = realLog;
    expect(logged.join("\n")).toContain("reset: lap-take-1 settled in a commit that was lost; planned again");
    expect(k.kept().settled.map((w: any) => w.req.id)).toEqual(["lap-take-1"]);
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("lap-take-1")).toEqual(["waiting", "done"]);
    expect(k.holds().P33).toMatchObject({ holder: A });
    expect(k.kept().settled).toBeUndefined();
  }, 30_000);
});

describe("7. the smoke test's switches, and no token or credentials in what the keeper says", () => {
  test("redact takes out the token and a remote address's userinfo", () => {
    const out = redact({ token: "tok-XYZ123" }, "fatal: unable to access 'https://x-access-token:tok-XYZ123@github.com/a.git/' (tok-XYZ123)");
    expect(out).not.toContain("tok-XYZ123");
    expect(out).toContain("https://<userinfo>@github.com/a.git/");
  });

  test("a push and fetch to an address carrying credentials: the log, the status and the relayed lines name neither", () => {
    const k = keeperRig();
    k.cfg.token = "tok-XYZ123";
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.g("-C", k.cfg.dir, "remote", "set-url", "origin", `${k.root}/nowhere/https://dane:tok-XYZ123@example.invalid/org.git`);
    catchLog();
    k.cain({ id: "link-oneoff-1", summary: "One-off ask to him: Lunch?", ops: [{ op: "one-off", text: "Lunch?", not_about_item: true }] });
    expect(cycle(k.cfg).pushFailed).toBe(true);
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    cycle(k.cfg);
    console.log = realLog;
    const said = [logged.join("\n"), readFileSync(join(k.root, "pi/record-ledger.json"), "utf8"), k.relayed()].join("\n");
    expect(logged.join("\n")).toContain("couldn't fetch from GitHub");
    expect(said).not.toContain("tok-XYZ123");
    expect(said).not.toContain("dane:");
  }, 30_000);

  test("record.sh leak-check: the keeper says per file whether its token or a userinfo is there, never the match", () => {
    const k = keeperRig();
    k.cfg.token = "tok-XYZ123";
    k.cfg.logFile = join(k.root, "pi/work/record-keeper.log");
    mkdirSync(join(k.root, "pi/work"), { recursive: true });
    writeFileSync(k.cfg.logFile, "[record] push didn't land (git push: fatal: unable to access 'https://<userinfo>@github.com/x.git/')\n");
    const refusal = join(k.root, "refusal.txt");
    writeFileSync(refusal, '{"status":"refused","said":"Nothing was posted: the record keeper said rejected"}\n');
    expect(cycle(k.cfg).ok).toBe(true);
    expect(leakCheck(k.cfg)).toBeNull();                              // no flag, no check
    writeFileSync(join(k.root, "pi/record-leak-check"), `${refusal}\n`);
    catchLog();
    const clean = leakCheck(k.cfg)!;
    console.log = realLog;
    expect(clean.clean).toBe(true);
    expect(clean.files.map((f) => f.path)).toEqual(expect.arrayContaining([k.cfg.logFile, join(k.root, "pi/record-ledger.json"), refusal]));
    expect(logged.join("\n")).toContain("leak check: clean (");
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-leak-check.json"), "utf8")).clean).toBe(true);
    expect(existsSync(join(k.root, "pi/record-leak-check"))).toBe(false);
    writeFileSync(refusal, "said: https://dane:tok-XYZ123@github.com/x.git\n");
    writeFileSync(join(k.root, "pi/record-leak-check"), `${refusal}\n`);
    catchLog();
    const found = leakCheck(k.cfg)!;
    console.log = realLog;
    expect(found.clean).toBe(false);
    expect(found.files.find((f) => f.path === refusal)).toEqual({ path: refusal, token: true, userinfo: true, header: false });
    expect(logged.join("\n")).toContain(`leak check: FOUND in ${refusal} (token, userinfo)`);
    expect(logged.join("\n") + readFileSync(join(k.root, "pi/record-leak-check.json"), "utf8")).not.toContain("tok-XYZ123");
  }, 30_000);

  test("clock-test header-only: one round decided by GitHub's Date header alone, then off", () => {
    const k = keeperRig();
    k.synced.ok = false;                                          // the box's own sources say no
    k.cfg.fetchDate = () => new Date(T0.getTime() - 3_000).toUTCString();
    writeFileSync(join(k.root, "pi/record-clock-test"), "header-only\n");
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44).toMatchObject({ checked: CHECKED, clock: "http-date" });
    expect(existsSync(join(k.root, "pi/record-clock-test"))).toBe(false);
  }, 30_000);

  test("clock-test none refuses checks until off; step moves the keeper's clock back and the check stops counting", () => {
    const k = keeperRig();
    writeFileSync(join(k.root, "pi/record-clock-test"), "none\n");
    k.cain({ id: "link-check-p44-1", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.reason("link-check-p44-1")).toContain("the keeper's clock isn't synchronized yet");
    expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8")).clock.synced).toBe(false);
    rmSync(join(k.root, "pi/record-clock-test"));
    k.cain({ id: "link-check-p44-2", ops: [{ op: "check", item: "P44", text: CHECKED, row: null, version: 0 }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("link-check-p44-2")).toEqual(["done"]);
    writeFileSync(join(k.root, "pi/record-clock-test"), "step:-600\n");
    catchLog();
    expect(cycle(k.cfg).ok).toBe(true);
    console.log = realLog;
    expect(parseChecks(k.upstream(CHECKS_PATH)).P44.stepped_back).toBe(new Date(T0.getTime() - 600_000).toISOString());
    expect(logged.join("\n")).toContain("the smoke test's clock switch is on (step -600 s)");
  }, 30_000);
});

describe("8. the docs: the smoke test's new steps, in order, each with its command and expected line", () => {
  test("DOCS.md, Cain's rules and the CHANGELOG", () => {
    const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md"), log = flat("../CHANGELOG.md");
    for (const t of [docs, rules]) {
      for (const cmd of ["record.sh clock-test header-only", "keeper.sh reads 20", "keeper.sh slow-read", "record.sh block-push 3",
        "record.sh clock-test none", "record.sh clock-test step:-600", "record.sh force-conflict", "about twelve minutes"]) expect(t).toContain(cmd);
      // The destructive steps come last: the forced conflict, then the rollback.
      expect(t.indexOf("record.sh clock-test header-only")).toBeLessThan(t.indexOf("record.sh force-conflict"));
      expect(t.indexOf("record.sh force-conflict")).toBeLessThan(t.lastIndexOf("restore"));
    }
    expect(docs).toContain("/data/record-holds.json");
    expect(docs).toContain("outside the record's working copy");
    expect(docs).toContain("pull request 21");
    expect(log).toContain("Busy, tap again");
  });
});
