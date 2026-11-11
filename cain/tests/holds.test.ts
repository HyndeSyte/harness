// One hand on each item: holds, row edits, the row-by-row check on the open list,
// and no empty "done". The keeper's rules only (core.ts), no git.
import { describe, expect, test } from "bun:test";
import {
  parseRequest, plan, rowHash, openRow, idleMs, holdsText, parseHolds, mergePending, HOLD_IDLE_MS,
  type Holds, type Plan, type Request, type Tree,
} from "../rootfs/opt/cain/record/core.ts";
import { blobSha } from "../rootfs/opt/cain/record/main.ts";
import { A, B, PENDING, T0, hrs } from "./rig.ts";

const P = "state/PENDING.md";

// A record of files, with every version a writer could have read kept by its sha.
function world(files: Record<string, string> = { [P]: PENDING }) {
  const blobs = new Map<string, string>();
  const keep = (text: string) => { const s = blobSha(text); blobs.set(s, text); return s; };
  for (const v of Object.values(files)) keep(v);
  const t: Tree = {
    read: (p) => files[p] ?? null,
    sha: (p) => (p in files ? keep(files[p]) : null),
    blob: (s) => blobs.get(s) ?? null,
  };
  let holds: Holds = {};
  let n = 0;
  const w = {
    files, t,
    get holds() { return holds; },
    set holds(h: Holds) { holds = h; },
    // Plans a request at a time; when it's ok, its files and holds become the record.
    run(from: string, ops: any[], at: Date = T0): Plan {
      const req: Request = { id: `req-${++n}-abcd`, from, kind: "change", summary: "s", ops };
      const p = plan(req, t, { at, holds, tz: "America/New_York" });
      if (p.state === "ok") {
        for (const [k, v] of p.writes) { if (v === null) delete files[k]; else { files[k] = v; keep(v); } }
        holds = p.holds;
      }
      return p;
    },
    row: (id: string) => openRow(files[P], id),
    base: (id: string) => rowHash(openRow(files[P], id)!),
    sha: () => blobSha(files[P]),
  };
  return w;
}
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });
const edit = (text: string, from: string, to: string) => { expect(text).toContain(from); return text.replace(from, to); };

describe("who may send what", () => {
  test("from is cain or laptop:<session id>; plain laptop (older requests) and Dane's page still read", () => {
    const r = (from: string) => parseRequest(JSON.stringify({ id: "abc123", from, kind: "change", summary: "s", ops: [take("P33", "x")] }));
    for (const ok of ["cain", A, "laptop", "page"]) expect(r(ok).error).toBeUndefined();
    for (const bad of ["specialist:calendar", "laptop:", "laptop:../x", "Cain", "dane"]) {
      expect(r(bad).error).toContain("from must be cain or laptop:<session id>");
      expect(r(bad).req?.id).toBe("abc123");   // still identifiable, so it's logged
    }
  });

  test("hold and row ops are checked for shape", () => {
    const r = (op: any) => parseRequest(JSON.stringify({ id: "abc123", from: A, kind: "change", summary: "s", ops: [op] })).error;
    expect(r({ op: "take", item: "P33" })).toContain("needs for");
    expect(r({ op: "take", item: "P 33", for: "x" })).toContain("needs an item id");
    expect(r(take("P33", "x", { branches: ["main"] }))).toContain("never main");
    expect(r(take("P33", "x", { branches: ["claude/a", "claude/a"] }))).toContain("exact branch names");
    expect(r(take("P33", "x", { branches: ["claude/../x"] }))).toContain("exact branch names");
    expect(r({ op: "pass", item: "P33", to: "laptop" })).toContain("to must be cain or laptop:<session id>");
    expect(r({ op: "row", item: "P33", base: "x", set: { Who: "Cain" } })).toContain("needs base");
    expect(r({ op: "row", item: "P33", base: "a".repeat(40), set: { ID: "P34" } })).toContain("isn't a column it can set");
    expect(r({ op: "row", item: "P33", base: "a".repeat(40), set: {} })).toContain("needs set");
    expect(r({ op: "row-add", item: "P45", cells: { Who: "Cain" } })).toContain("needs Item");
    expect(r({ op: "row-close", item: "P33", evidence: " " })).toContain("needs evidence");
    expect(r({ op: "row", item: "P33", base: "a".repeat(40), set: { "Next step": "x" } })).toBeUndefined();
  });

  test("cells refuse | and new lines", () => {
    const r = (v: string) => parseRequest(JSON.stringify({ id: "abc123", from: A, kind: "change", summary: "s",
      ops: [{ op: "row", item: "P33", base: "a".repeat(40), set: { "Next step": v } }] })).error;
    expect(r("a | b")).toContain("can't hold | or a new line");
    expect(r("a\nb")).toContain("can't hold | or a new line");
    expect(r("a\r")).toContain("can't hold | or a new line");
    expect(parseRequest(JSON.stringify({ id: "abc123", from: A, kind: "change", summary: "s",
      ops: [{ op: "row-close", item: "P33", evidence: "x|y" }] })).error).toContain("can't hold |");
  });

  test("state/holds.json is the keeper's: no request writes it", () => {
    const w = world();
    for (const path of ["state/holds.json", "state/Holds.json"]) {
      expect(parseRequest(JSON.stringify({ id: "abc123", from: "cain", kind: "change", summary: "s",
        ops: [{ op: "put", path, content: "{}", base: "new" }] })).error).toContain("not a place requests may write");
      expect(w.run("cain", [{ op: "put", path, content: "{}", base: "new" }])).toMatchObject({ state: "rejected" });
      expect(w.run("cain", [{ op: "append", path, text: "{}" }])).toMatchObject({ state: "rejected" });
    }
  });
});

describe("holds: take, pass, release", () => {
  test("a free item is taken: who, why, which branches and when", () => {
    const w = world();
    const p = w.run(A, [take("P33", "dane: build the collision fix (laptop chat, 8:20 AM)", { branches: ["claude/record-holds"] })]);
    expect(p).toMatchObject({ state: "ok", holdsChanged: true });
    expect(w.holds.P33).toEqual({ holder: A, for: "dane: build the collision fix (laptop chat, 8:20 AM)", branches: ["claude/record-holds"],
      taken: T0.toISOString(), renewed: T0.toISOString() });
    expect(p.state === "ok" && p.writes.size).toBe(0);   // only the holds change
  });

  test("a held item is refused, naming the holder", () => {
    const w = world();
    w.run(A, [take("P33", "chat: the collision fix")]);
    expect(w.run(B, [take("P33", "chat: rebase PR #3")])).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    expect(w.run("cain", [take("P33", "his Start tap", { job: "build cse_01X" })])).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
  });

  test("Dane's word moves a hold, with its branches", () => {
    const w = world();
    w.run(A, [take("P33", "chat: the collision fix", { branches: ["claude/record-holds"] })]);
    expect(w.run(B, [take("P33", "dane: take P33 over from the other window (laptop chat, 9:12 AM)", { branches: ["claude/link-cards"] })]).state).toBe("ok");
    expect(w.holds.P33).toMatchObject({ holder: B, branches: ["claude/record-holds", "claude/link-cards"] });
    expect(w.run(A, [{ op: "release", item: "P33" }])).toEqual({ state: "refused", reason: `P33 is held by ${B}` });
  });

  test("the holder's own take renews it, adds branches, and keeps why and since", () => {
    const w = world();
    w.run(A, [take("P33", "chat: the collision fix", { branches: ["claude/a"] })]);
    expect(w.run(A, [take("P33", "renewed", { branches: ["claude/b"] })], hrs(5)).state).toBe("ok");
    expect(w.holds.P33).toEqual({ holder: A, for: "chat: the collision fix", branches: ["claude/a", "claude/b"],
      taken: T0.toISOString(), renewed: hrs(5).toISOString() });
  });

  test("a hold expires after a day idle; keeper downtime doesn't count toward the day", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    const h = w.holds.P33;
    expect(idleMs(h, hrs(25))).toBe(25 * 3_600_000);
    expect(idleMs(h, hrs(25), [[hrs(2).toISOString(), hrs(4).toISOString()]])).toBe(23 * 3_600_000);
    const held = w.holds;
    // 23 hours idle: still A's.
    expect(plan({ id: "req-x-1", from: B, kind: "change", summary: "s", ops: [take("P33", "chat: y")] as any }, w.t,
      { at: hrs(23), holds: held })).toMatchObject({ state: "refused" });
    // A day and an hour: free again.
    expect(plan({ id: "req-x-2", from: B, kind: "change", summary: "s", ops: [take("P33", "chat: y")] as any }, w.t,
      { at: hrs(25), holds: held })).toMatchObject({ state: "ok" });
    // ...unless the keeper was down for two of those hours.
    expect(plan({ id: "req-x-3", from: B, kind: "change", summary: "s", ops: [take("P33", "chat: y")] as any }, w.t,
      { at: hrs(25), holds: held, downtime: [[hrs(2).toISOString(), hrs(4).toISOString()]] })).toMatchObject({ state: "refused" });
    expect(HOLD_IDLE_MS).toBe(24 * 3_600_000);
  });

  test("a branch already in another hold is refused", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x", { branches: ["claude/wave1-merge-lane"] })]);
    expect(w.run("cain", [take("P44", "his Start tap", { branches: ["claude/wave1-merge-lane"], job: "build cse_01X" })]))
      .toEqual({ state: "refused", reason: `branch claude/wave1-merge-lane is already held, with P33 (by ${A})` });
    expect(w.run("cain", [take("P44", "his Start tap", { branches: ["claude/p44-plain-words"], job: "build cse_01X" })]).state).toBe("ok");
  });

  test("takes wait behind Cain's job, and are planned again when it ends", () => {
    const w = world();
    expect(w.run("cain", [take("P33", "his Start tap, 7:12 AM", { branches: ["claude/wave1-merge-lane"], job: "build cse_01X" })]).state).toBe("ok");
    expect(w.holds.P33.job).toBe("build cse_01X");
    const waits = w.run(A, [take("P33", "chat: the collision fix")]);
    expect(waits.state).toBe("waiting");
    expect(waits.state === "waiting" && waits.reason).toContain("P33 is held by cain (a job: build cse_01X)");
    expect(w.run(A, [take("P33", "dane: take it (laptop chat)")]).state).toBe("waiting");   // his word waits for the job too
    // One that would be turned away anyway is turned away now, not after the wait.
    w.files["state/decisions.md"] = "| 2026-11-11 | x |\n";
    expect(w.run(A, [take("P33", "chat: x"), { op: "put", path: "state/decisions.md", content: "y\n", base: blobSha("| 2026-11-11 | x |\n") }]))
      .toMatchObject({ state: "rejected" });
    // The job ends: Cain lets go, and the same take now goes through.
    expect(w.run("cain", [{ op: "release", item: "P33" }]).state).toBe("ok");
    expect(w.run(A, [take("P33", "chat: the collision fix")]).state).toBe("ok");
    expect(w.holds.P33).toMatchObject({ holder: A, branches: [] });
    // Only Cain's own takes are marked as jobs.
    expect(w.run(B, [take("P44", "chat: x", { job: "build" })])).toEqual({ state: "rejected", reason: "only Cain's own jobs are marked job" });
  });

  test("pass is the holder's alone and moves the hold and its branches in one step", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x", { branches: ["claude/a"] })]);
    expect(w.run(B, [{ op: "pass", item: "P33", to: B }])).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    expect(w.run(A, [{ op: "pass", item: "P33", to: A }])).toMatchObject({ state: "rejected" });
    expect(w.run(A, [{ op: "pass", item: "P33", to: "cain" }], hrs(1)).state).toBe("ok");
    expect(w.holds.P33).toEqual({ holder: "cain", for: "chat: x", branches: ["claude/a"], taken: hrs(1).toISOString(), renewed: hrs(1).toISOString() });
    // Passed to Cain to ask Dane, it isn't a job: others are refused, not kept waiting.
    expect(w.run(B, [take("P33", "chat: y")])).toEqual({ state: "refused", reason: "P33 is held by cain" });
    expect(w.run(A, [{ op: "pass", item: "P44", to: "cain" }])).toEqual({ state: "rejected", reason: "P44 isn't held; nothing to pass" });
  });

  test("release is the holder's alone", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    expect(w.run(B, [{ op: "release", item: "P33" }])).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    expect(w.run(A, [{ op: "release", item: "P33" }]).state).toBe("ok");
    expect(w.holds).toEqual({});
    expect(w.run(A, [{ op: "release", item: "P33" }])).toEqual({ state: "rejected", reason: "P33 isn't held; nothing to release" });
  });

  test("holds need a sender who can hold: cain or a laptop session", () => {
    const w = world();
    for (const from of ["laptop", "page"])
      expect(w.run(from, [take("P33", "x")])).toEqual({ state: "rejected", reason: "take needs a sender of cain or laptop:<session id>" });
  });

  test("the holder's word on its row renews its hold", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    expect(w.run(A, [{ op: "row", item: "P33", base: w.base("P33"), set: { "Next step": "PR A is open" } }], hrs(10)).state).toBe("ok");
    expect(w.holds.P33.renewed).toBe(hrs(10).toISOString());
    expect(w.holds.P33.taken).toBe(T0.toISOString());
  });

  test("the holds file reads back as written, and drops what isn't a hold", () => {
    const w = world();
    w.run("cain", [take("P33", "his Start tap", { branches: ["claude/a"], job: "ship cse_02Y" })]);
    w.run(A, [take("P44", "chat: x")]);
    const text = holdsText(w.holds);
    expect(parseHolds(text)).toEqual(w.holds);
    expect(Object.keys(JSON.parse(text))).toEqual(["P33", "P44"]);
    expect(parseHolds(JSON.stringify({ P1: { holder: "dane", for: "x", branches: [], taken: T0, renewed: T0 }, P2: w.holds.P44 }))).toEqual({ P2: w.holds.P44 });
    expect(parseHolds("not json")).toBeNull();
  });
});

describe("row edits", () => {
  test("row: the holder's edit lands; anyone else is refused, naming the holder", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    const base = w.base("P33");
    expect(w.run("cain", [{ op: "row", item: "P33", base, set: { "Next step": "Cain's words" } }]))
      .toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    expect(w.run(A, [{ op: "row", item: "P33", base, set: { "Next step": "PR A is open", "Waits for": "after P11" } }]).state).toBe("ok");
    expect(w.row("P33")).toBe("| P33 | Org v2 wave 1, the trust boundary | Build | PR A is open | after P11 | Deliberate drills pass | Nov 10 |");
    // An item nobody holds is Cain's by default, and open to edits.
    expect(w.run("cain", [{ op: "row", item: "P44", base: w.base("P44"), set: { "Waits for": "" } }]).state).toBe("ok");
    expect(w.row("P44")).toBe("| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | | His words find his PT event | Nov 11 |");
  });

  test("row: a stale base is a conflict; a different row changing doesn't matter", () => {
    const w = world();
    const read33 = w.base("P33");
    expect(w.run("cain", [{ op: "row", item: "P44", base: w.base("P44"), set: { "Next step": "x" } }]).state).toBe("ok");
    expect(w.run(A, [{ op: "row", item: "P33", base: read33, set: { "Next step": "y" } }]).state).toBe("ok");
    expect(w.run("cain", [{ op: "row", item: "P33", base: read33, set: { "Next step": "z" } }]))
      .toEqual({ state: "conflict", reason: "P33 changed since it was read" });
    expect(w.run("cain", [{ op: "row", item: "P99", base: read33, set: { "Next step": "z" } }]))
      .toMatchObject({ state: "conflict", reason: expect.stringContaining("isn't an open row") });
  });

  test("row-add refuses an ID in use or used before, and adds at the end with today's date", () => {
    const w = world();
    expect(w.run(A, [{ op: "row-add", item: "P33", cells: { Item: "x" } }])).toMatchObject({ state: "conflict" });
    expect(w.run(A, [{ op: "row-add", item: "P06", cells: { Item: "x" } }])).toMatchObject({ state: "conflict", reason: expect.stringContaining("in Done") });
    const p = w.run(A, [take("P45", "made it, building the collision fix"), { op: "row-add", item: "P45", cells: { Item: "Record holds", Who: "Build", "Done when": "PR A merged" } }]);
    expect(p.state).toBe("ok");
    const lines = w.files[P].split("\n");
    expect(lines[lines.indexOf(w.row("P44")!) + 1]).toBe("| P45 | Record holds | Build | | | PR A merged | Nov 11 |");
    expect(w.holds.P45.holder).toBe(A);
    // Someone else adding a row under an ID that's held is refused too.
    expect(w.run(B, [take("P46", "x")]).state).toBe("ok");
    expect(w.run(A, [{ op: "row-add", item: "P46", cells: { Item: "x" } }])).toEqual({ state: "refused", reason: `P46 is held by ${B}` });
  });

  test("row-close moves the row to Done, newest first, in its two-column form", () => {
    const w = world();
    expect(w.run("cain", [{ op: "row-close", item: "P11", evidence: "both alert, drilled Nov 11" }]).state).toBe("ok");
    expect(w.row("P11")).toBeNull();
    const lines = w.files[P].split("\n");
    const done = lines.indexOf("| Item | Date |");
    expect(lines[done + 2]).toBe("| P11 Calendar: each add-on watches the other: both alert, drilled Nov 11 | Nov 11 |");
    expect(lines[done + 3]).toBe("| P06 Turkey harvest block on Gmail: made by the specialist 7:26 AM | Nov 10 |");
    w.run(A, [take("P33", "x")]);
    expect(w.run("cain", [{ op: "row-close", item: "P33", evidence: "x" }])).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    // A list with no Done table yet gets one.
    const v = world({ [P]: PENDING.split("## Done")[0] });
    expect(v.run("cain", [{ op: "row-close", item: "P44", evidence: "fixed in 0.21.0" }]).state).toBe("ok");
    expect(v.files[P]).toEndWith("## Done\n\n| Item | Date |\n|---|---|\n| P44 Calendar specialist fails his plain commands: fixed in 0.21.0 | Nov 11 |\n");
  });

  test("a whole-file put is checked row by row: a held row is refused; other rows, the header and Done land", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    const put = (content: string) => w.run("cain", [{ op: "put", path: P, content, base: w.sha() }]);
    expect(put(edit(PENDING, "The laptop session holds all harness work", "Cain's words"))).toEqual({ state: "refused", reason: `P33 is held by ${A}` });
    expect(put(PENDING.replace(w.row("P33")! + "\n", ""))).toEqual({ state: "refused", reason: `P33 is held by ${A}` });   // closing it by hand
    // A check-in that touches several held rows hears about all of them at once.
    w.run(B, [take("P11", "chat: y")]);
    expect(put(edit(edit(PENDING, "Waiting on Dane (Ship)", "Shipped"), "The laptop session holds all harness work", "x")))
      .toEqual({ state: "refused", reason: `P11 is held by ${B}; P33 is held by ${A}` });
    w.run(B, [{ op: "release", item: "P11" }]);
    expect(put(edit(PENDING, "Hold the Build until P33 lifts", "First in the build queue")).state).toBe("ok");
    expect(put(edit(w.files[P], "Cain keeps this current.", "Cain keeps this current, row by row.")).state).toBe("ok");
    expect(put(edit(w.files[P], "|---|---|\n", "|---|---|\n| P12 Discord status on the Harness page: shipped | Nov 11 |\n")).state).toBe("ok");
    expect(w.run("cain", [{ op: "append", path: P, text: "| P10 Taps reach Cain: tested | Nov 11 |" }]).state).toBe("ok");
    // The holder's own whole-file put of its row lands.
    expect(w.run(A, [{ op: "put", path: P, content: edit(w.files[P], "The laptop session holds all harness work", "PR A open"), base: w.sha() }]).state).toBe("ok");
  });

  test("a put made from an older version lands when the rows it changed are untouched since", () => {
    const w = world();
    w.run(A, [take("P33", "chat: x")]);
    const readAt = w.sha(), was = w.files[P];
    // A's row edit lands first...
    expect(w.run(A, [{ op: "row", item: "P33", base: w.base("P33"), set: { "Next step": "PR A is open" } }]).state).toBe("ok");
    // ...then Cain's whole-file put, made before it, changing P44, a Done row and the header.
    let mine = edit(was, "Hold the Build until P33 lifts", "First in the build queue");
    mine = edit(mine, "|---|---|\n| P06", "|---|---|\n| P12 Discord status on the Harness page: shipped | Nov 11 |\n| P06");
    expect(w.run("cain", [{ op: "put", path: P, content: mine, base: readAt }]).state).toBe("ok");
    expect(w.row("P33")).toContain("PR A is open");
    expect(w.row("P44")).toContain("First in the build queue");
    expect(w.files[P]).toContain("|---|---|\n| P12 Discord status on the Harness page: shipped | Nov 11 |\n| P06");
    // The same stale put touching P33 is refused for the hold, whatever its base.
    expect(w.run("cain", [{ op: "put", path: P, content: edit(was, "The laptop session holds all harness work", "x"), base: readAt }]))
      .toEqual({ state: "refused", reason: `P33 is held by ${A}` });
  });

  test("merging never drops a change: the same row changed on both sides is a conflict", () => {
    const base = PENDING;
    const theirs = edit(base, "Hold the Build until P33 lifts", "theirs");
    expect(mergePending(base, theirs, edit(base, "Hold the Build until P33 lifts", "mine"))).toEqual({ why: "both changed P44" });
    expect(mergePending(base, theirs, base.replace(/\| P44 .*\n/, ""))).toEqual({ why: "both changed P44" });
    expect(mergePending(base, base.replace(/\| P44 .*\n/, ""), edit(base, "Hold the Build until P33 lifts", "mine"))).toEqual({ why: "P44 was closed or removed since it was read" });
    expect(mergePending(base, edit(base, "Cain keeps this current.", "a"), edit(base, "Cain keeps this current.", "b"))).toEqual({ why: "both changed the text around the tables" });
    expect(mergePending(null, theirs, base)).toEqual({ why: "the version it was made from isn't known" });
    // A row only one side added goes in after the row it followed.
    const added = edit(base, "| P44 ", "| P45 | New | Cain | x | | y | Nov 11 |\n| P44 ");
    const merged = mergePending(base, theirs, added) as string;
    expect(merged).toContain("| P33 | Org v2 wave 1, the trust boundary | Build | The laptop session holds all harness work |  | Deliberate drills pass | Nov 10 |\n| P45 | New |");
    expect(merged).toContain("theirs");
    const w = world();
    const readAt = w.sha();
    w.run("cain", [{ op: "row", item: "P44", base: w.base("P44"), set: { "Next step": "theirs" } }]);
    expect(w.run(A, [{ op: "put", path: P, content: edit(PENDING, "Hold the Build until P33 lifts", "mine"), base: readAt }]))
      .toEqual({ state: "conflict", reason: "state/PENDING.md: changed since it was read (both changed P44)" });
  });
});

describe("no empty done", () => {
  test("a change that changes nothing is rejected", () => {
    const w = world();
    expect(w.run("cain", [{ op: "put", path: P, content: PENDING, base: w.sha() }])).toEqual({ state: "rejected", reason: "changes nothing" });
    expect(w.run("cain", [{ op: "row", item: "P44", base: w.base("P44"), set: { Who: "Build" } }])).toEqual({ state: "rejected", reason: "changes nothing" });
    w.files["areas/farm/open.md"] = "- fence\n";
    expect(w.run("cain", [{ op: "put", path: "areas/farm/open.md", content: "- fence\n", base: blobSha("- fence\n") },
      { op: "put", path: P, content: PENDING, base: w.sha() }])).toEqual({ state: "rejected", reason: "changes nothing" });
    // One real change in it is enough.
    expect(w.run("cain", [{ op: "put", path: "areas/farm/open.md", content: "- fence\n", base: blobSha("- fence\n") },
      { op: "append", path: "areas/farm/open.md", text: "- gate" }]).state).toBe("ok");
  });

  test("take, pass and release always change the holds", () => {
    const w = world();
    expect(w.run(A, [take("P33", "x")]).state).toBe("ok");
    expect(w.run(A, [take("P33", "x")], hrs(1)).state).toBe("ok");   // renewed
    expect(w.run(A, [{ op: "release", item: "P33" }]).state).toBe("ok");
  });
});
