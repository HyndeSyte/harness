// The laptop's check of what a session showed him in a turn (cain/tools/reply-check.ts, a Stop
// hook): the message gate's rules and the codes he can't read keep the session going once, so it
// says those lines again plainly (the registry's S-010, S-013 and S-014 on the laptop).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnWords, unreadable } from "../tools/reply-check";

const TOOL = join(import.meta.dir, "../tools/reply-check.ts");
const his = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const said = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const used = (name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] } });
const result = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const items = new Set(["P33", "P69"]);

describe("the words of this turn, as he saw them", () => {
  test("everything shown since his last message: text, the wrap-up box, a question card; never what came before, or tool results", () => {
    const words = turnWords([
      his("Finish it"), said("Earlier turn, with P33 in it"),
      his("What's next?"), said("Looking."), used("Bash", { command: "git log d47fd11" }), result,
      used("mcp__ccd_turn__wrap_up", { recap: "The fix is in.", ask: "Ship it?", actions: [{ label: "Yes" }] }),
      used("AskUserQuestion", { questions: [{ question: "Which one?", options: [{ label: "A", description: "the first" }] }] }),
    ]);
    expect(words).toEqual(["Looking.", "The fix is in.", "Ship it?", "Yes", "Which one?", "A", "the first"]);
  });
});

describe("what he can't read", () => {
  test("the gate's rules: an em dash, an add-on, a hidden count, a full commit id", () => {
    const found = unreadable([`Done \u2014 the add-on is updated, and 3 more. Commit ${"a".repeat(39)}1.`], null);
    expect(found.some((f) => f.includes("no em dashes"))).toBe(true);
    expect(found.some((f) => f.includes("Apps, not add-ons"))).toBe(true);
    expect(found.some((f) => f.includes("a full sha") || f.includes("machine") || f.includes("ids"))).toBe(true);
  });

  test("codes: an item the record has, a registry or rule number, a build piece, a wave, a commit's short id", () => {
    const found = unreadable(["P33 is done; S-062 changed; C1 ships; wave 1 is close; head d47fd11."], items);
    expect(found.some((x) => x.startsWith(`"P33 is done`) && x.endsWith("(a record code he can't read)"))).toBe(true);
    for (const f of [`"S-062" (a registry or rule number)`, `"C1" (a build piece's code)`, `"wave 1" (a build wave)`, `"d47fd11" (a commit's id)`])
      expect([f, found.some((x) => x.includes(f))]).toEqual([f, true]);
  });

  test("plain words pass: numbers, times, ordinary words, an item the record doesn't have, a link's target", () => {
    expect(unreadable(["At 7:10 Cain reviews it; 53 cases passed on both. See [the change](https://github.com/o/r/commit/d47fd115f4cd6bd2e552ab7a7f5c68379dd804ab). P99 isn't one."], items)).toEqual([]);
  });
});

describe("as a Stop hook", () => {
  const run = (rows: string[], extra: Record<string, unknown> = {}) => {
    const d = mkdtempSync(join(tmpdir(), "reply-check-"));
    writeFileSync(join(d, "t.jsonl"), rows.join("\n") + "\n");
    const { RECORD_CLONE, ...env } = process.env;
    const p = Bun.spawnSync(["bun", TOOL, "--hook"], { stdout: "pipe", stdin: Buffer.from(JSON.stringify({ transcript_path: join(d, "t.jsonl"), ...extra })), env });
    return { code: p.exitCode, out: p.stdout.toString().trim() };
  };

  test("words he can't read keep the session going once, with what they were", () => {
    const r = run([his("Status?"), said("Merged \u2014 C1 is next.")]);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o.decision).toBe("block");
    expect(o.reason).toStartWith("What you showed him this turn has words he can't read: ");
    expect(o.reason).toContain(`"C1" (a build piece's code)`);
    expect(o.reason).toContain("Send him the lines that held them again, said plainly");
  });

  test("clean words, a turn it already kept going, or a transcript it can't read: nothing", () => {
    expect(run([his("Status?"), said("Merged. The next piece is the standards cleanup.")])).toEqual({ code: 0, out: "" });
    expect(run([his("Status?"), said("C1 is next.")], { stop_hook_active: true })).toEqual({ code: 0, out: "" });
    expect(run([], { transcript_path: "/nowhere/t.jsonl" })).toEqual({ code: 0, out: "" });
  });
});
