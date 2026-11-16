// Source checks, sixth review round (0.12.0): exactly-once taps (one settle guard per read, an
// idempotency key claimed before anything is done, restarts finish a claim and never redo it); a
// busy answer patches the card back live; a reset epoch voids every check from before it; settled
// takes are idempotent by their request id across a reset; the generation floor is written before
// a post and never falls to zero when the link's state can't be read; one fresh read in flight;
// Ship taps wait for a landed push; the Date header from its own unauthenticated HEAD request, with
// wider redaction and a wider leak check; and the smoke test split from the resilience run.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS_PATH, checkedCell, parseChecks, voidChecks } from "../rootfs/opt/cain/record/core.ts";
import { cycle, headDate, leakCheck, leakForms, readLinkFloor, redact, requestLoggedIn } from "../rootfs/opt/cain/record/main.ts";
import { MIN, PR, SHA1, pendingWith, rig as linkRig } from "./link-rig";
import { A, PENDING, hrs, rig as keeperRig } from "./rig.ts";

const P = "state/PENDING.md";
const CHECKED = "the specialist's log, read at 8 this morning";
const opts = ["Fixed", "Not fixed"];
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });
const logged: string[] = [];
const realLog = console.log;
const catchLog = () => { logged.length = 0; console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; };
afterEach(() => { console.log = realLog; });
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const synced = (now: number) => ({ synced: true, source: "kernel", diagnostic: "synchronized", at: new Date(now).toISOString() });

// The link and a real keeper on a git repo, as on the Pi.
function both() {
  const k = keeperRig();
  const l = linkRig({ unchecked: true, pending: PENDING });
  const read = (p: string) => { try { return readFileSync(join(k.cfg.dir, p), "utf8"); } catch { return null; } };
  let n = 0;
  const sync = () => {
    l.files.pending = read(P);
    l.files.checks = read(CHECKS_PATH);
    (l.files as any).status = existsSync(join(k.root, "pi/record-ledger.json")) ? readFileSync(join(k.root, "pi/record-ledger.json"), "utf8") : null;
  };
  const queued: string[] = [];
  const run = () => {
    writeFileSync(join(k.root, "pi/link/state.json"), JSON.stringify(l.state()));
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
  return { r, id: out.message as string, d: (r.link as any).d };
};
const relays = (r: ReturnType<typeof linkRig>) => r.relayed.filter((x) => x.includes("Dane tapped")).length;

describe("1. exactly-once taps", () => {
  test("a read resolving 1 ms after the limit is busy: no action, the card only patched back as it was", async () => {
    const { r, id, d } = await posted();
    d.tapReadMs = 60;
    const card = structuredClone(r.msg(id));
    d.readFresh = () => new Promise((ok) => setTimeout(() => ok({ files: d.record(), outcome: d.outcome(r.state().messages[id].checked!.req) }), 61));
    expect(await r.tap(card, r.ids(id)[0])).toBe("refused: busy");
    await wait(30);
    expect(relays(r)).toBe(0);
    expect(r.state().messages[id].q!.used).toBe(false);
    expect(r.state().taps).toBeUndefined();
    expect(r.msg(id).content).toBe(card.content);
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
  });

  test("a read that ignores cancellation and completes after busy: no action, no card mutation", async () => {
    const { r, id, d } = await posted();
    d.tapReadMs = 40;
    const card = structuredClone(r.msg(id));
    let done = false;
    d.readFresh = () => new Promise((ok) => setTimeout(() => { done = true; ok({ files: d.record(), outcome: { state: "done" } }); }, 120));
    expect(await r.tap(card, r.ids(id)[0])).toBe("refused: busy");
    const calls = r.calls.length;
    await wait(160);
    expect(done).toBe(true);
    expect(r.calls.length).toBe(calls);                              // nothing at all after it completed
    expect(relays(r)).toBe(0);
    expect(r.state().messages[id].q!.used).toBe(false);
    expect(r.msg(id)).toEqual(card);
  });

  test("two concurrent taps on one card: the second starts no read and waits for the first; exactly one acts", async () => {
    // Round 7 (item 9): the second is answered with the first's recorded outcome, not busy.
    const { r, id, d } = await posted();
    let reads = 0;
    d.readFresh = () => { reads++; return new Promise((ok) => setTimeout(() => ok({ files: d.record(), outcome: { state: "done" } }), 40)); };
    const card = structuredClone(r.msg(id));
    const a = r.tap(card, r.ids(id)[0]);
    const b = await r.tap(structuredClone(card), r.ids(id)[1]);
    expect(b).toBe("already: to Cain");
    expect(await a).toBe("to Cain");
    expect(reads).toBe(1);
    expect(relays(r)).toBe(1);
  });

  test("a retap or a Discord retry with the same key returns the recorded outcome and does nothing again", async () => {
    const { r, id } = await posted();
    const card = structuredClone(r.msg(id));
    expect(await r.tap(card, r.ids(id)[0])).toBe("to Cain");
    const key = Object.keys(r.state().taps!)[0];
    expect(key).toBe([id, r.state().messages[id].checked!.gen, r.state().messages[id].checked!.req, "P08", "Filed"].join("|"));
    expect(r.state().taps![key].stage).toBe("edited");
    // Discord retries the same interaction with the card as it was when tapped.
    expect(await r.tap(structuredClone(card), r.ids(id)[0] ?? card.components[0].components[0].custom_id)).toBe("already: to Cain");
    expect(relays(r)).toBe(1);
    expect(r.updates().at(-1).content).toContain("You answered: Filed");
  });

  test("a crash after the claim, before acting: on restart it is acted on once from the claim, and the card edited", async () => {
    const { r, id, d } = await posted();
    const relay = d.relay;
    d.relay = () => { throw new Error("killed"); };
    await expect(r.tap(structuredClone(r.msg(id)), r.ids(id)[0])).rejects.toThrow("killed");
    const key = Object.keys(r.state().taps!)[0];
    expect(r.state().taps![key].stage).toBe("claimed");
    d.relay = relay;
    r.restart();
    await r.link.sweep();
    expect(relays(r)).toBe(1);
    expect(r.state().taps![key].stage).toBe("edited");
    expect(r.buttons(id)).toEqual([]);
    expect(r.msg(id).content).toContain("You answered: Filed");
    await r.link.sweep();
    expect(relays(r)).toBe(1);                                       // never again
  });

  test("a crash after acting, before the card's edit: on restart only the edit is made, never the action", async () => {
    const { r, id } = await posted();
    r.hang.edits = true;
    void r.tap(structuredClone(r.msg(id)), r.ids(id)[0]);
    await wait(20);
    const key = Object.keys(r.state().taps!)[0];
    expect(r.state().taps![key].stage).toBe("acted");
    expect(relays(r)).toBe(1);
    r.hang.edits = false;
    r.restart();
    await r.link.sweep();
    expect(relays(r)).toBe(1);
    expect(r.state().taps![key].stage).toBe("edited");
    expect(r.buttons(id)).toEqual([]);
    expect(r.calls.some((c) => c.method === "PATCH" && c.path === `/channels/5151/messages/${id}`)).toBe(true);
  });
});

describe("2. a busy answer patches the card back live, with the busy notice as the follow-up", () => {
  test("the original message is patched through the interaction webhook with its own words and buttons, then the notice", async () => {
    const { r, id, d } = await posted();
    d.tapReadMs = 30;
    d.readFresh = () => new Promise(() => {});
    const card = structuredClone(r.msg(id));
    expect(await r.tap(card, r.ids(id)[0])).toBe("refused: busy");
    const i = r.calls.findIndex((c) => c.method === "PATCH" && c.path.endsWith("/messages/@original"));
    expect(i).toBeGreaterThan(-1);
    expect(r.calls[i].body).toMatchObject({ content: card.content, components: card.components });
    const j = r.calls.findIndex((c) => c.method === "POST" && /^\/webhooks\/[^/]+\/[^/]+$/.test(c.path));
    expect(j).toBeGreaterThan(i);
    expect(r.calls[j].body.content).toBe("Busy, tap again.");
    expect(r.buttons(id)).toEqual(["Filed", "Not filed"]);
  });
});

describe("3. the reset epoch", () => {
  test("a check superseded in a lost commit can't satisfy a pre-reset card after the generation rewrite", async () => {
    const { k, l, run, read, block } = both();
    const q1 = await ask(l, "Q1", CHECKED);
    expect(q1.status).toBe("posted");
    const gen = l.state().messages[q1.message].checked!.gen!;
    // A newer check on the same row lands only locally (pushes fail), then a reset loses it.
    block(true);
    expect((await ask(l, "Q2", "the specialist's log again, read at 8:05")).status).toBe("held");
    expect(JSON.parse(l.files.status!).unpushed).toBe(true);
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    block(false);
    l.later(MIN); k.at(new Date(l.t.now));
    catchLog();
    expect(run().ok).toBe(true);
    console.log = realLog;
    const st = JSON.parse(l.files.status!);
    expect(st.reset).toBeUndefined();                                 // the push after it landed
    expect(st.epoch).toMatchObject({ n: 1 });
    expect(st.epoch.generation).toBeGreaterThan(gen);
    expect(logged.join("\n")).toContain("reset epoch 1: source checks on P44 were accepted before it and are void until taken again");
    // The ledger came back with the card's own check, which the epoch voided; the newer check's
    // request was still queued, so it was applied again after the epoch began. Neither satisfies
    // the card: it was posted before the epoch.
    const e = parseChecks(read(CHECKS_PATH))["P44"];
    expect(e.checked).toBe("the specialist's log again, read at 8:05");
    expect(e.checked_req).not.toBe(l.state().messages[q1.message].checked!.req);
    expect(await l.tap(structuredClone(l.msg(q1.message)), l.ids(q1.message)[0])).toBe("refused: record reset since");
    expect(l.ephemerals().at(-1).content).toContain("Cain's record was reset after this was asked");
    expect(l.buttons(q1.message)).toEqual(opts);
    // The sweep takes its buttons off on its next verified read, and tells Cain.
    await l.link.sweep();
    expect(l.buttons(q1.message)).toEqual([]);
    expect(l.msg(q1.message).content).toEndWith("Record reset since, re-check needed");
    expect(l.relayed.join(" ")).toContain("the record keeper reset its copy after it was posted");
    // The held ask went out once the old card's buttons came off: it rests on the check applied
    // after the epoch began, so it counts.
    const q2 = Object.entries(l.state().messages).find(([, m]) => m.question === "Q2")!;
    expect(q2[1].checked!.gen!).toBeGreaterThan(st.epoch.generation);
    expect(await l.tap(structuredClone(l.msg(q2[0])), l.ids(q2[0])[0])).toBe("to Cain");
  }, 30_000);

  test("after a reset, a check that landed before it shows pending re-check until it is taken again", async () => {
    const { k, l, run, read, block } = both();
    expect((await ask(l, "Q1", CHECKED)).status).toBe("posted");
    expect(parseChecks(read(CHECKS_PATH))["P44"].checked).toBe(CHECKED);
    block(true);
    k.cain({ id: "cain-next-1", ops: [{ op: "note", item: "P11", text: "a note" }] });
    expect(run()).toMatchObject({ pushFailed: true });
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    expect(run().ok).toBe(true);
    const e = parseChecks(read(CHECKS_PATH))["P44"];
    expect(e.checked).toBeUndefined();
    expect(e.recheck).toBe(JSON.parse(l.files.status!).epoch.at);
    expect(read(P)).toContain("pending re-check: the record was reset, so its last check no longer counts");
    await l.link.sweep();                                             // the pre-epoch card's buttons come off
    await expect(ask(l, "Q2")).rejects.toThrow("No source check on this item");
    expect((await ask(l, "Q2", "the specialist's log again, read at 8:20")).status).toBe("posted");
  }, 30_000);

  test("voidChecks keeps each row's id and version, drops its check, and the Checked cell says pending re-check", () => {
    const L = { P08: { id: "r000000000001", version: 2, changed: "2026-11-10T12:00:00.000Z", checked: "x", checked_at: "2026-11-10T12:00:00.000Z", checked_version: 2, checked_req: "q" },
      P09: { id: "r000000000002", version: 1, changed: "2026-11-10T12:00:00.000Z" } };
    const v = voidChecks(L as any, "2026-11-11T13:00:00.000Z");
    expect(v.dropped).toEqual(["P08"]);
    expect(v.ledger.P08).toEqual({ id: "r000000000001", version: 2, changed: "2026-11-10T12:00:00.000Z", recheck: "2026-11-11T13:00:00.000Z" });
    expect(checkedCell(v.ledger.P08)).toStartWith("pending re-check");
    expect(v.ledger.P09).toEqual(L.P09);
  });
});

describe("4. settled takes are idempotent by their request id across a forced reset", () => {
  test("a take that already landed is never applied again when a reset brings it back", () => {
    const k = keeperRig();
    k.cain({ id: "cain-job-take", ops: [take("P33", "his Start tap, 7:12 AM", { branches: ["claude/wave1-merge-lane"], job: "build cse_01X" })] });
    expect(cycle(k.cfg).ok).toBe(true);
    k.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: finish the merge lane (laptop chat)")] }]);
    expect(cycle(k.cfg).ok).toBe(true);
    k.at(hrs(1));
    k.cain({ id: "cain-job-done", ops: [{ op: "release", item: "P33" }] });
    expect(cycle(k.cfg).ok).toBe(true);
    expect(k.states("lap-take-1")).toEqual(["waiting", "done"]);
    // A restored state brings the take back as settled-but-unlanded, then a forced reset reruns it.
    const st = k.kept();
    writeFileSync(k.cfg.holds!, JSON.stringify({ ...st, settled: [{ req: { id: "lap-take-1", from: A, kind: "change", summary: "s", ops: [take("P33", "dane: finish the merge lane (laptop chat)")] }, since: new Date(hrs(0.5)).toISOString(), local: false }], unpushed: true }));
    k.cain({ id: "cain-note-1", ops: [{ op: "note", item: "P33", text: "a note" }] });
    writeFileSync(join(k.root, "pi/record-force-conflict"), "");
    writeFileSync(join(k.root, "pi/record-block-push"), "");
    expect(cycle(k.cfg).pushFailed).toBe(true);
    catchLog();
    expect(cycle(k.cfg).ok).toBe(true);
    console.log = realLog;
    expect(k.states("lap-take-1")).toEqual(["waiting", "done"]);    // once, by its id
    expect(k.holds().P33).toMatchObject({ holder: A });
  }, 30_000);

  test("the docs say a take's only effect is in the record", () => {
    const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
    expect(flat("../DOCS.md")).toContain("a take's only effect is in the record");
    expect(flat("../rootfs/opt/cain/CLAUDE.md")).toContain("a take's only effect is in the record");
  });
});

describe("5. the generation floor: written before a post, never zero when the link's state can't be read", () => {
  test("the link writes the card's generation to its state before posting it", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
    r.files.checks = JSON.stringify({ _generation: 7 });
    let atPost: number | undefined;
    r.spy.onCall = (method, path) => { if (method === "POST" && path === "/channels/5151/messages") atPost = r.state().intendedGen; };
    const out = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    expect(out.status).toBe("posted");
    const gen = r.state().messages[out.message].checked!.gen!;
    expect(gen).toBeGreaterThanOrEqual(7);
    expect(atPost).toBe(gen);
  });

  for (const [name, text] of [["missing", null], ["corrupt", "not json {"], ["mid-write", '{"postedGen": 9, "messages": {"1": {"checked": {"gen"']] as const) {
    test(`a link state that is ${name}: the keeper keeps its own floor, logs once, and refuses new cards until it can read it`, async () => {
      const k = keeperRig();
      const ls = join(k.root, "pi/link/state.json");
      writeFileSync(ls, JSON.stringify({ postedGen: 5, messages: {} }));
      expect(readLinkFloor(k.cfg)).toEqual({ floor: 5 });
      expect(cycle(k.cfg).ok).toBe(true);
      const g1 = k.kept().generation;
      expect(g1).toBeGreaterThanOrEqual(5);
      if (text === null) rmSync(ls); else writeFileSync(ls, text);
      expect(readLinkFloor(k.cfg).why).toBeTruthy();
      catchLog();
      expect(cycle(k.cfg).ok).toBe(true);
      expect(cycle(k.cfg).ok).toBe(true);
      console.log = realLog;
      expect(logged.filter((x) => x.includes("FLOOR: the link's state can't be read"))).toHaveLength(1);
      expect(k.kept().generation).toBe(g1);                          // never back to zero
      const status = readFileSync(join(k.root, "pi/record-ledger.json"), "utf8");
      expect(JSON.parse(status).link_state).toMatchObject({ readable: false });
      // The link refuses new cards while the keeper says so.
      const l = linkRig({ unchecked: true, pending: pendingWith(["P08"], []) });
      (l.files as any).status = status;
      await expect(l.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }))
        .rejects.toThrow("the record keeper can't read the link's state just now");
      // Readable again: said once, and new cards go on.
      writeFileSync(ls, JSON.stringify({ postedGen: g1 + 3, messages: {} }));
      catchLog();
      expect(cycle(k.cfg).ok).toBe(true);
      console.log = realLog;
      expect(logged.join("\n")).toContain("floor: the link's state can be read again");
      expect(k.kept().generation).toBe(g1 + 3);
      expect(JSON.parse(readFileSync(join(k.root, "pi/record-ledger.json"), "utf8")).link_state).toBeUndefined();
    }, 30_000);
  }
});

describe("6. at most one fresh read in flight", () => {
  test("keeper.sh stall-read: a read held past its limit, ignoring cancellation; a second read is busy at once and a journal write still completes", async () => {
    const { r, d } = await posted();
    d.tapReadMs = 200;
    const out = await r.link.stallRead(1) as any;
    expect(out).toMatchObject({ first: "busy", second_tap: "busy at once", pass: true });
    expect(out.second_answered_ms).toBeLessThan(100);
    expect(out.journal_write_ms).toBeLessThan(1000);
    expect(r.state().journalProbe).toBeDefined();
  });
});

describe("7. Ship taps wait for a landed push", () => {
  test("while the keeper's status says unpushed, a Ship-card tap is refused with its own reason; an ask's tap is honoured and journaled", async () => {
    const r = linkRig({ unchecked: true, pending: pendingWith(["P41", "P08"], []) });
    const ship = await r.link.ship({ item: "P41", pr: PR, head: SHA1, text: "Stop stays within reach of your newest message.", checked: "the pull request on GitHub, open at that head, read at 8" }) as any;
    expect(ship.status).toBe("posted");
    const now = new Date(r.t.now).toISOString();
    (r.files as any).status = JSON.stringify({ unpushed: true, push_failed: { at: now, why: "x", since: now }, clock: synced(r.t.now) });
    expect(await r.tap(structuredClone(r.msg(ship.message)), r.ids(ship.message)[1])).toBe("refused: ship unpushed");
    expect(r.ephemerals().at(-1).content).toBe("Cain's record has unsaved changes, so Ship waits. Tap again once they're saved, in a minute or two.");
    expect(r.buttons(ship.message)).toEqual(["Ship", "Not now"]);
    expect(r.github.landings).toEqual([]);
    (r.files as any).status = JSON.stringify({ unpushed: false, clock: synced(r.t.now) });
    const a = await r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q1", checked: CHECKED }) as any;
    (r.files as any).status = JSON.stringify({ unpushed: true, push_failed: { at: now, why: "x", since: now }, clock: synced(r.t.now) });
    expect(await r.tap(structuredClone(r.msg(a.message)), r.ids(a.message)[0])).toBe("to Cain");
    expect(r.state().uncertain).toHaveLength(1);
    (r.files as any).status = JSON.stringify({ unpushed: false, clock: synced(r.t.now) });
    expect(await r.tap(structuredClone(r.msg(ship.message)), r.ids(ship.message)[1])).toBe("to Cain");
  });
});

describe("8. the Date header from an unauthenticated HEAD request; wider redaction and leak check", () => {
  test("git runs with tracing off, and the Date header never comes from git's exchange", () => {
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/record/main.ts"), "utf8");
    expect(src).not.toMatch(/GIT_TRACE_CURL:\s*"1"/);
    expect(src).toContain('env.GIT_TRACE = "0"; env.GIT_TRACE_CURL = "0"');
    expect(src).toMatch(/headDate\(remote: string\)/);
    expect(headDate("/local/path/remote.git")).toBeNull();
    expect(headDate("ssh://git@github.com/x.git")).toBeNull();
    // The HEAD request names only the host: no userinfo, no path, no token.
    const call = /"curl", "-sSI", "-m", "5", "--proto", "=https", `https:\/\/\$\{host\}\/`/;
    expect(src).toMatch(call);
  });

  test("redact covers Authorization headers and Basic and Bearer credentials", () => {
    const out = redact({ token: "tok-XYZ123" }, [
      "Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9rLVhZWjEyMw==",
      "authorization: bearer abcdef0123456789abcdef",
      "Proxy-Authorization: token ghp_abcdefghijklmnop",
      "http.extraheader=AUTHORIZATION: basic Zm9vOmJhcg==",
      "sent Basic Zm9vOmJhcmJhemJhcg== again",
      "https://x-access-token:tok-XYZ123@github.com/a.git",
    ].join("\n"));
    expect(out).not.toMatch(/eC1hY2Nlc3M|abcdef0123456789|ghp_abcdefgh|Zm9vOmJhcg|Zm9vOmJhcmJh|tok-XYZ123/);
    expect(out).toContain("Authorization: Basic <redacted>");
    expect(out).toContain("<userinfo>@github.com");
  });

  test("the leak check reads every file under /data/work, the keeper's and link's state, and the rendered notices", async () => {
    const k = keeperRig();
    k.cfg.token = "tok-XYZ123";
    k.cfg.logFile = join(k.root, "pi/work/record-keeper.log");
    mkdirSync(join(k.root, "pi/work/deep/er"), { recursive: true });
    writeFileSync(k.cfg.logFile, "[record] clock: synchronized\n");
    expect(cycle(k.cfg).ok).toBe(true);
    // The link's rendered notices land under /data/work too.
    const l = linkRig();
    const notices: string[] = [];
    (l.link as any).d.noticeLog = (t: string) => notices.push(t);
    await l.link.notice("Cain's record hasn't saved to GitHub since 8:00 AM: GitHub didn't answer.");
    expect(notices).toEqual(["Cain's record hasn't saved to GitHub since 8:00 AM: GitHub didn't answer."]);
    writeFileSync(join(k.root, "pi/work/link-notices.jsonl"), JSON.stringify({ text: notices[0] }) + "\n");
    writeFileSync(join(k.root, "pi/record-leak-check"), "");
    const clean = leakCheck(k.cfg)!;
    expect(clean.clean).toBe(true);
    const paths = clean.files.map((f) => f.path);
    for (const p of ["pi/work/record-keeper.log", "pi/work/link-notices.jsonl", "pi/record-holds.json", "pi/record-ledger.json", "pi/link/state.json"])
      expect(paths).toContain(join(k.root, p));
    // Planted forms, each found, never quoted.
    const planted: [string, string][] = [
      ["pi/work/deep/er/trace.txt", "> Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r\n"],
      ["pi/work/link-notices.jsonl", JSON.stringify({ text: "notice: bearer abcdefghijklmnop0123" }) + "\n"],
      ["pi/link/state.json", JSON.stringify({ messages: {}, note: "https://u:p@example.org/" })],
      ["pi/record-ledger.json", JSON.stringify({ note: "tok-XYZ123" })],
    ];
    for (const [p, t] of planted) writeFileSync(join(k.root, p), t);
    writeFileSync(join(k.root, "pi/record-leak-check"), "");
    catchLog();
    const found = leakCheck(k.cfg)!;
    console.log = realLog;
    expect(found.clean).toBe(false);
    const by = (p: string) => found.files.find((f) => f.path === join(k.root, p));
    expect(by("pi/work/deep/er/trace.txt")).toMatchObject({ header: true });
    expect(by("pi/work/link-notices.jsonl")).toMatchObject({ header: true });
    expect(by("pi/link/state.json")).toMatchObject({ userinfo: true });
    expect(by("pi/record-ledger.json")).toMatchObject({ token: true });
    expect(logged.join("\n")).not.toMatch(/tok-XYZ123|eC1hY2Nl|abcdefghijklmnop0123|u:p@/);
    expect(leakForms("Authorization: <redacted>")).toEqual({ token: false, userinfo: false, header: false });
  }, 30_000);
});

describe("9 and 10. the docs: the install smoke test and the separate resilience run", () => {
  const flat = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\s+/g, " ");
  test("DOCS.md and Cain's rules split the two, each step with its command and expected line", () => {
    const docs = flat("../DOCS.md"), rules = flat("../rootfs/opt/cain/CLAUDE.md");
    for (const t of [docs, rules]) {
      const smoke = t.indexOf("install smoke test"), res = t.indexOf("resilience run");
      expect(smoke).toBeGreaterThan(-1);
      expect(res).toBeGreaterThan(smoke);
      expect(t).toContain("about twelve minutes");
      // The install smoke test's non-destructive steps.
      for (const cmd of ["record.sh clock-test header-only", "record.sh leak-check", "keeper.sh reads 20", "keeper.sh slow-read", "keeper.sh stall-read"])
        expect(t.indexOf(cmd)).toBeGreaterThan(smoke);
      // The resilience run's destructive steps, offered once with buttons after a backup is confirmed.
      for (const cmd of ["record.sh block-push 3", "pkill -f /opt/cain/link/main.ts", "record.sh clock-test none", "record.sh clock-test step:-600", "record.sh force-conflict"])
        expect(t.indexOf(cmd, res)).toBeGreaterThan(res);
      expect(t).toContain("confirm a backup");
      expect(t).toContain("decline");
    }
    expect(docs).toContain("pull request 21");
    expect(flat("../CHANGELOG.md")).toContain("resilience run");
  });
});
