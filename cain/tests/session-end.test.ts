// What a laptop session leaves open reaches Cain's record when it ends (cain/tools/session-end.ts,
// org-v2 DESIGN 4.F, the registry's S-051): its task list replayed from its transcript, then
// filed as a note on each item it holds, or as a line for Cain to fold in when it holds none.
import { describe, expect, test } from "bun:test";
import { requestFor, stepsOf } from "../tools/session-end";

const use = (name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
const said = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const plan = (...s: [string, string][]) => ({ items: s.map(([content, status]) => ({ content, status })) });

describe("the task list as the session left it", () => {
  test("update_plan: items replace it; advance, done and start move steps; wrap_up finishes the one in progress", () => {
    const lines = [
      said("Finish the thing"),
      use("mcp__ccd_turn__update_plan", plan(["Look", "in_progress"], ["Build", "pending"], ["Ship", "pending"])),
      use("mcp__ccd_turn__update_plan", { advance: true }),
      use("mcp__ccd_turn__update_plan", { done: [2], start: 3 }),
      use("mcp__ccd_turn__wrap_up", { recap: "x" }),
    ];
    const { steps, first } = stepsOf(lines);
    expect(steps).toEqual([{ content: "Look", status: "completed" }, { content: "Build", status: "completed" }, { content: "Ship", status: "completed" }]);
    expect(first).toBe("Finish the thing");
  });

  test("a later plan replaces an earlier one; steps not done stay open", () => {
    const { steps } = stepsOf([
      use("mcp__ccd_turn__update_plan", plan(["Old", "in_progress"])),
      use("mcp__ccd_turn__update_plan", plan(["Fix it", "completed"], ["Verify after his tap", "pending"])),
      "not json at all",
    ]);
    expect(steps.filter((s) => s.status !== "completed").map((s) => s.content)).toEqual(["Verify after his tap"]);
  });

  test("TodoWrite's list counts the same way", () => {
    const { steps } = stepsOf([use("TodoWrite", { todos: [{ content: "A", status: "completed", activeForm: "a" }, { content: "B", status: "in_progress", activeForm: "b" }] })]);
    expect(steps.map((s) => s.status)).toEqual(["completed", "in_progress"]);
  });
});

describe("what it files", () => {
  const open = [{ content: "Verify after his tap", status: "pending" }, { content: "Clean | up", status: "in_progress" }];
  test("nothing open: nothing filed", () => {
    expect(requestFor("s1", [], ["P33"], "")).toBeNull();
  });
  test("a note on each item it holds, its steps on one line", () => {
    const r = requestFor("s1", open, ["P33", "P40"], "Finish", new Date("2026-11-15T03:00:00Z"));
    expect(r.ops.map((o: any) => [o.op, o.item])).toEqual([["note", "P33"], ["note", "P40"]]);
    expect(r.ops[0].text).toContain("Verify after his tap; Clean up");
    expect(r.ops[0].text).not.toMatch(/[\n|]/);
  });
  test("holding nothing: one line for Cain to fold into the open list", () => {
    const r = requestFor("abc", open, [], "Finish the thing", new Date("2026-11-15T03:00:00Z"));
    expect(r.ops).toEqual([{ op: "append", path: "state/laptop-open.md", text: '- 2026-11-15 laptop session abc ("Finish the thing"): Verify after his tap; Clean up\n' }]);
  });
});
