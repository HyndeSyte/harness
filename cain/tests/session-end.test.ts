// What a laptop session leaves open on the items it holds reaches Cain's record when it ends
// (cain/tools/session-end.ts, org-v2 DESIGN 4.F, the registry's S-051): its task list replayed
// from its transcript, filed as a note on each item it holds, once, and never lost on the way.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, clean, fate, filedKey, filingId, requestFor, stepsOf } from "../tools/session-end";

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
  test("nothing open, or no item held: nothing filed", () => {
    expect(requestFor([], ["P33"], "open")).toBeNull();
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
    const id = filingId("0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e", filedKey(["P33"], [a]));
    expect(id).toMatch(/^laptop-end-0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e-[0-9a-f]{16}$/);
    expect(id.length).toBeLessThanOrEqual(80);
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
  test("done leaves it; waiting keeps it; refused, rejected or a conflict moves it aside; never sent is sent; sent a day with no word goes again", () => {
    expect(fate(["rejected", "done"], true, 0)).toBe("filed");             // a second copy refused as a used id
    expect(fate(["waiting"], true, 3 * day)).toBe("waiting");
    for (const s of ["rejected", "conflict", "refused"]) expect(fate([s], true, 0)).toBe("refused");
    expect(fate([], false, 0)).toBe("send");
    expect(fate([], true, day / 2)).toBe("wait");
    expect(fate([], true, 2 * day)).toBe("resend");
  });
});
