// What a laptop session leaves open on the items it holds reaches Cain's record when it ends
// (cain/tools/session-end.ts, org-v2 DESIGN 4.F, the registry's S-051): its task list replayed
// from its transcript, filed as a note on each item it holds, once, and never lost on the way.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry, claim, clean, decide, eachLine, fate, filedKey, filingId, fileSnapshot, journalOf, outcomeOf, readJournal, requestFor, stepsOf, type Entry } from "../tools/session-end";

const use = (name: string, input: unknown, id = "") => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const failed = (id: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "invalid input" }] } });
const plan = (...s: [string, string][]) => ({ items: s.map(([content, status]) => ({ content, status })) });

describe("the task list as the session left it", () => {
  test("update_plan: items replace it; advance, done and start move steps", () => {
    const { steps, planned } = stepsOf([
      use("mcp__ccd_turn__update_plan", plan(["Look", "in_progress"], ["Build", "pending"], ["Ship", "pending"])),
      use("mcp__ccd_turn__update_plan", { advance: true }),
      use("mcp__ccd_turn__update_plan", { done: [2], start: 3 }),
    ]);
    expect(planned).toBe(true);
    expect(steps).toEqual([{ content: "Look", status: "completed" }, { content: "Build", status: "completed" }, { content: "Ship", status: "in_progress" }]);
  });

  test("wrap_up finishes nothing: a step is done only when its own status says so", () => {
    const { steps } = stepsOf([
      use("mcp__ccd_turn__update_plan", plan(["Build", "completed"], ["Ship", "in_progress"])),
      use("mcp__ccd_turn__wrap_up", { recap: "Built; shipping waits on his tap." }),
    ]);
    expect(steps.filter((s) => s.status !== "completed").map((s) => s.content)).toEqual(["Ship"]);
  });

  test("a call that failed changes nothing", () => {
    const { steps } = stepsOf([
      use("mcp__ccd_turn__update_plan", plan(["Verify after his tap", "pending"]), "a1"),
      use("mcp__ccd_turn__update_plan", plan(["Verify after his tap", "completed"]), "a2"),
      failed("a2"),
    ]);
    expect(steps).toEqual([{ content: "Verify after his tap", status: "pending" }]);
  });

  test("a later plan replaces an earlier one; lines that aren't JSON are passed over; TodoWrite counts the same way", () => {
    const { steps } = stepsOf([
      use("mcp__ccd_turn__update_plan", plan(["Old", "in_progress"])),
      use("mcp__ccd_turn__update_plan", plan(["Fix it", "completed"], ["Verify after his tap", "pending"])),
      "not json at all",
    ]);
    expect(steps.filter((s) => s.status !== "completed").map((s) => s.content)).toEqual(["Verify after his tap"]);
    const todo = stepsOf([use("TodoWrite", { todos: [{ content: "A", status: "completed", activeForm: "a" }, { content: "B", status: "in_progress", activeForm: "b" }] })]);
    expect([todo.planned, todo.steps.map((s) => s.status)]).toEqual([true, ["completed", "in_progress"]]);
    expect(stepsOf([use("Bash", { command: "ls" })]).planned).toBe(false);
  });
});

describe("what it files", () => {
  const open = [{ content: "Verify after his tap", status: "pending" }, { content: "Clean | up", status: "in_progress" }];
  const at = new Date("2026-11-15T03:00:00Z");
  test("nothing open, or no item held: nothing filed; nothing left open after a filing that had something open is said", () => {
    expect(requestFor([], ["P33"], "open")).toBeNull();
    expect(requestFor([], ["P33"], "open", at, true).ops[0].text).toBe("The laptop session ended (2026-11-15) with nothing left open on its task list. Its hold lapses in a day; take the item to carry it on.");
    expect(requestFor([{ content: "Review the renewal figures for Friday", status: "pending" }, ...open], [], "open", at)).toBeNull();
    expect(requestFor([], [], "unread", at)).toBeNull();
  });
  test("a note on each item it holds, its steps on one line", () => {
    const r = requestFor(open, ["P33", "P40"], "open", at);
    expect(r.ops.map((o: any) => [o.op, o.item])).toEqual([["note", "P33"], ["note", "P40"]]);
    expect(r.ops[0].text).toBe("The laptop session ended (2026-11-15) with these steps open: Verify after his tap; Clean up. Its hold lapses in a day; take the item to carry it on.");
  });
  test("a transcript that can't be read, or no task list, is said on the items it holds", () => {
    expect(requestFor([], ["P33"], "unread", at).ops[0].text).toStartWith("The laptop session ended (2026-11-15) and its task list couldn't be read, so what it left open isn't known.");
    expect(requestFor([], ["P33"], "unplanned", at).ops[0].text).toStartWith("The laptop session ended (2026-11-15) and kept no task list");
  });
  test("anything shaped like a key is masked", () => {
    const key = "ghp_" + "TESTONLY0123456789abcdefABCDEF0123456";
    expect(clean(`Rotate ${key} in the vault`, 200)).toBe("Rotate [a key, masked] in the vault");
    expect(JSON.stringify(requestFor([{ content: `Rotate ${key}`, status: "pending" }], ["P33"], "open", at))).not.toContain(key);
  });
});

describe("once only", () => {
  const a = { content: "Verify after his tap", status: "pending" };
  const b = { content: "Merge", status: "in_progress" };
  test("one filing is the same open steps on the same items, in any order or status; its id comes from it and the session", () => {
    expect(filedKey(["P33"], [a, b])).toBe(filedKey(["P33"], [{ ...b, status: "pending" }, a]));
    expect(filedKey(["P33"], [a])).not.toBe(filedKey(["P40"], [a]));
    expect(filedKey(["P33"], [a])).not.toBe(filedKey(["P33"], [a, b]));
    expect(filedKey(["P33"], [], "unread")).not.toBe(filedKey(["P33"], [], "unplanned"));
    const long = "x".repeat(130);
    expect(filedKey(["P33"], [{ content: `${long} one`, status: "pending" }])).not.toBe(filedKey(["P33"], [{ content: `${long} two`, status: "pending" }]));
    const id = filingId("0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e", 1, filedKey(["P33"], [a]));
    expect(id).toMatch(/^laptop-end-0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e-000001-[0-9a-f]{16}$/);
    expect(id.length).toBeLessThanOrEqual(80);
    // Names sort in the order the session's filings were made, whatever the clock or the state.
    expect([filingId("s", 10, "0000"), filingId("s", 2, "ffff"), filingId("s", 1, "9999")].sort()).toEqual([filingId("s", 1, "9999"), filingId("s", 2, "ffff"), filingId("s", 10, "0000")]);
  });

  test("the journal decides: the same state as its last entry is nothing new; any other is entry n + 1, a filing on held items", () => {
    const [kA, kB, kE] = [filedKey(["P33"], [a]), filedKey(["P33"], [b]), filedKey(["P33"], [])];
    const e = (n: number, key: string, kind: Entry["kind"], filed = true): Entry => ({ n, key, at: n, kind, ...(filed ? { id: `i${n}`, raw: "{}" } : {}) });
    expect(decide([], kA, ["P33"], [a], "open")).toEqual({ n: 1, same: false, file: true, wasOpen: false });
    expect(decide([e(1, kA, "open")], kA, ["P33"], [a], "open").same).toBe(true);
    expect(decide([e(1, kA, "open")], kB, ["P33"], [b], "open")).toEqual({ n: 2, same: false, file: true, wasOpen: true });
    expect(decide([e(1, kA, "open"), e(2, kB, "open")], kA, ["P33"], [a], "open").n).toBe(3);                     // A, B, A: a new filing
    // Nothing left open after something was: said; said once; then A again is new.
    expect(decide([e(1, kA, "open")], kE, ["P33"], [], "open")).toEqual({ n: 2, same: false, file: true, wasOpen: true });
    expect(decide([e(1, kA, "open"), e(2, kE, "empty")], kE, ["P33"], [], "open").same).toBe(true);
    expect(decide([e(1, kA, "open"), e(2, kE, "empty")], kA, ["P33"], [a], "open")).toEqual({ n: 3, same: false, file: true, wasOpen: false });
    // Nothing open, never anything filed: a state, not a filing. No item held: a state, not a filing.
    expect(decide([], kE, ["P33"], [], "open")).toEqual({ n: 1, same: false, file: false, wasOpen: false });
    expect(decide([e(1, kA, "open")], filedKey([], [a]), [], [a], "open")).toEqual({ n: 2, same: false, file: false, wasOpen: true });
  });

  test("a journal's line cut off mid-write is passed over and stays; the next entry starts on a line of its own", () => {
    const p = join(mkdtempSync(join(tmpdir(), "journal-")), "s.journal");
    const torn = '{"n": 2, "key": "k2", "at"';
    writeFileSync(p, JSON.stringify({ n: 1, key: "k1", at: 1, kind: "open", id: "i1", raw: JSON.stringify({ id: "i1" }) }) + "\n" + torn);
    expect(readJournal(p).map((x) => x.n)).toEqual([1]);
    appendEntry(p, { n: 2, key: "k3", at: 3, kind: "open" });
    expect(readJournal(p).map((x) => [x.n, x.key])).toEqual([[1, "k1"], [2, "k3"]]);
    expect(readFileSync(p, "utf8").split("\n").slice(1, 3)).toEqual([torn, JSON.stringify({ torn: true })]);   // kept as it was, marked
    expect(journalOf(p).damaged).toEqual([]);
  });

  test("no journal yet is empty; one that can't be read is never taken for empty", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    expect(readJournal(join(d, "none.journal"))).toEqual([]);
    mkdirSync(join(d, "folder.journal"));
    expect(() => readJournal(join(d, "folder.journal"))).toThrow();
  });

  test("a snapshot that had read less of the transcript than the journal's last entry is older and passed over, whatever the clock says", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    writeFileSync(join(d, "s1.journal"), JSON.stringify({ n: 1, key: filedKey(["P33"], [b]), at: 1_000, kind: "open", id: "x", raw: JSON.stringify({ id: "x" }), mark: 200 }) + "\n");
    // An older end, delayed, with a later clock: passed over.
    expect(fileSnapshot(d, { session: "s1", held: ["P33"], open: [a], why: "open", at: 5_000, mark: 100 })).toEqual({ id: null, same: true });
    expect(readJournal(join(d, "s1.journal"))).toHaveLength(1);
  });

  test("the same state seen later moves the most-seen mark on: a delayed older snapshot can't then become the newest (A@100, A@300, then B@200)", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    const snap = (open: typeof a[], mark: number) => ({ session: "s1", held: ["P33"], open, why: "open" as const, at: mark, mark });
    expect(fileSnapshot(d, snap([a], 100)).id).toMatch(/-000001-/);
    expect(fileSnapshot(d, snap([a], 300))).toEqual({ id: null, same: true });
    expect(fileSnapshot(d, snap([b], 200))).toEqual({ id: null, same: true });                        // delayed, older: passed over
    const j = readJournal(join(d, "s1.journal"));
    expect(j.at(-1)!.key).toBe(filedKey(["P33"], [a]));
    expect(j.at(-1)!.mark).toBe(300);
    expect(fileSnapshot(d, snap([b], 400)).id).toMatch(/-000002-/);                                    // B, truly newer: filed
  });

  test("with the same transcript, the record decides: a delayed snapshot that read older holds can't replace a newer one", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    const snap = (held: string[], rmark: number) => ({ session: "s1", held, open: [a], why: "open" as const, at: 1, mark: 150, rmark });
    expect(fileSnapshot(d, snap(["P33"], 10)).id).toMatch(/-000001-/);                 // A, captured first
    expect(fileSnapshot(d, snap(["P44"], 12)).id).toMatch(/-000002-/);                 // B, captured last
    expect(fileSnapshot(d, snap(["P33"], 11))).toEqual({ id: null, same: true });     // A, captured between, delayed: passed over
    expect(readJournal(join(d, "s1.journal")).at(-1)!.key).toBe(filedKey(["P44"], [a]));
    expect(fileSnapshot(d, snap(["P33"], 13)).id).toMatch(/-000003-/);                 // the record moved on: newer, filed
  });

  test("a newer snapshot taken after the clock moved back is filed: the transcript, not the clock, says it's newer", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    writeFileSync(join(d, "s1.journal"), JSON.stringify({ n: 1, key: filedKey(["P33"], [a]), at: 2_000, kind: "open", id: "x", raw: JSON.stringify({ id: "x" }), mark: 100 }) + "\n");
    const r = fileSnapshot(d, { session: "s1", held: ["P33"], open: [b], why: "open", at: 1_000, mark: 200 });
    expect(r.same).toBe(false);
    expect(r.id).toMatch(/-000002-/);
    expect(readJournal(join(d, "s1.journal")).map((x) => [x.n, x.mark])).toEqual([[1, 100], [2, 200]]);
  });

  test("a snapshot of unknown order (its transcript couldn't be read) never supersedes a known, newer state", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    writeFileSync(join(d, "s1.journal"), JSON.stringify({ n: 1, key: filedKey(["P33"], [a]), at: 1_000, kind: "open", id: "x", raw: JSON.stringify({ id: "x" }), mark: 100 }) + "\n");
    expect(fileSnapshot(d, { session: "s1", held: ["P33"], open: [], why: "unread", at: 9_000 })).toEqual({ id: null, same: true });
    const j = readJournal(join(d, "s1.journal"));
    expect(j.map((e) => [e.n, e.key === filedKey(["P33"], [a]), e.seen ?? null])).toEqual([[1, true, null], [1, true, "unread"]]);   // noted, not a new state
  });

  test("at the mark, a whole final record without its newline counts; one still being written doesn't", () => {
    const d = mkdtempSync(join(tmpdir(), "transcript-"));
    const p = join(d, "t.jsonl");
    writeFileSync(p, use("mcp__ccd_turn__update_plan", plan(["A", "pending"])));                      // no newline after it
    const seen: string[] = [];
    eachLine(p, (l) => seen.push(l), readFileSync(p).length);
    expect(stepsOf(seen).steps.map((s) => s.content)).toEqual(["A"]);
    writeFileSync(p, use("mcp__ccd_turn__update_plan", plan(["A", "pending"])) + "\n" + '{"type": "assistant", "mess');
    const cut: string[] = [];
    eachLine(p, (l) => cut.push(l), readFileSync(p).length);
    expect(cut).toHaveLength(1);
  });

  test("a transcript is read only up to the snapshot's mark: what's added after isn't read into it", () => {
    const d = mkdtempSync(join(tmpdir(), "transcript-"));
    const p = join(d, "t.jsonl");
    writeFileSync(p, use("mcp__ccd_turn__update_plan", plan(["A", "pending"])) + "\n");
    const mark = readFileSync(p).length;                                     // the end takes its mark
    writeFileSync(p, use("mcp__ccd_turn__update_plan", plan(["C", "pending"])) + "\n", { flag: "a" });   // the session goes on
    const seen: string[] = [];
    eachLine(p, (l) => seen.push(l), mark);                                  // then reads
    expect(stepsOf(seen).steps.map((s) => s.content)).toEqual(["A"]);
    const all: string[] = [];
    eachLine(p, (l) => all.push(l));
    expect(stepsOf(all).steps.map((s) => s.content)).toEqual(["C"]);
  });

  test("a journal's damaged lines are told from a crash's: a cut-off last line or a line marked torn is expected, any other is damage", () => {
    const d = mkdtempSync(join(tmpdir(), "journal-"));
    const ok = (n: number) => JSON.stringify({ n, key: `k${n}`, at: n, kind: "open" });
    writeFileSync(join(d, "a.journal"), [ok(1), '{"n": 2, "ke', JSON.stringify({ torn: true }), ok(2), ""].join("\n"));
    expect(journalOf(join(d, "a.journal"))).toMatchObject({ damaged: [] });
    writeFileSync(join(d, "b.journal"), [ok(1), ok(2), '{"n": 3, "ke'].join("\n"));                     // cut off, last, no newline
    expect(journalOf(join(d, "b.journal"))).toMatchObject({ damaged: [] });
    writeFileSync(join(d, "b2.journal"), [ok(1), "not json", ""].join("\n"));                             // last, but ended: damage
    expect(journalOf(join(d, "b2.journal")).damaged).toEqual([2]);
    writeFileSync(join(d, "f.journal"), [ok(1), JSON.stringify({ n: 2, key: "k2", at: 2, kind: "open", id: "", raw: "" }),
      JSON.stringify({ n: 3, key: "k3", at: 3, kind: "open", id: "i3", raw: JSON.stringify({ id: "other" }) }), ""].join("\n"));
    expect(journalOf(join(d, "f.journal")).damaged).toEqual([2, 3]);
    writeFileSync(join(d, "c.journal"), [ok(1), "not json at all", ok(2), ""].join("\n"));              // damage in the middle
    expect(journalOf(join(d, "c.journal")).damaged).toEqual([2]);
    expect(journalOf(join(d, "c.journal")).entries.map((x) => x.n)).toEqual([1, 2]);
    // Read, but not an entry: a number as text, a filing without its request, a kind it doesn't know.
    writeFileSync(join(d, "e.journal"), [ok(1), JSON.stringify({ n: "2", key: "k2", at: 2, kind: "open", id: "i2", raw: "{}" }),
      JSON.stringify({ n: 3, key: "k3", at: 3, kind: "open", id: "i3" }), JSON.stringify({ n: 4, key: "k4", at: 4, kind: "maybe" }), ok(5), ""].join("\n"));
    expect(journalOf(join(d, "e.journal")).damaged).toEqual([2, 3, 4]);
    expect(journalOf(join(d, "e.journal")).entries.map((x) => x.n)).toEqual([1, 5]);
  });

  test("a lock is made new, refused while it's fresh, and taken over once it's 2 minutes old", () => {
    const lock = join(mkdtempSync(join(tmpdir(), "claim-")), "s.ending");
    expect(claim(lock)).toBe(true);
    expect(claim(lock)).toBe(false);
    const old = (Date.now() - 3 * 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(claim(lock)).toBe(true);
    expect(claim(lock)).toBe(false);
  });
});

describe("what becomes of a filing in the outbox", () => {
  const day = 86_400_000;
  test("done leaves it; else its newest word: waiting keeps it, a refusal moves it aside; never sent is sent; sent a day with no word goes again", () => {
    expect(fate(["rejected", "done"], true, 0)).toBe("filed");
    expect(fate(["waiting"], true, 3 * day)).toBe("waiting");
    expect(fate(["waiting", "rejected"], true, 0)).toBe("refused");       // held behind a job, then refused
    expect(outcomeOf([{ state: "waiting" }, { state: "rejected", reason: "an id that was already used" }]).map((o) => o.state)).toEqual(["waiting"]);
    for (const s of ["rejected", "conflict", "refused"]) expect(fate([s], true, 0)).toBe("refused");
    expect(fate([], false, 0)).toBe("send");
    expect(fate([], true, day / 2)).toBe("wait");
    expect(fate([], true, 2 * day)).toBe("resend");
  });
});
