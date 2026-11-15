// The laptop's check of what a session showed him in a turn (cain/tools/reply-check.ts, a Stop
// hook): the message gate's rules and the codes he can't read keep the session going once, so it
// says those lines again plainly (the registry's S-010, S-013 and S-014 on the laptop, a
// correction after the fact).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownNumbers, tailLines, turnWords, unreadable } from "../tools/reply-check";

const TOOL = join(import.meta.dir, "../tools/reply-check.ts");
const DASH = String.fromCharCode(0x2014);
const his = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const said = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const used = (name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] } });
const result = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const items = new Set(["P33", "P69"]);
const numbers = knownNumbers("## S-062 His go\n- kind: principle\n## S-013 No codes\n", ["rules/R-004-how-he-wants-things.md", "rules/README.md"]);

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

describe("a long session's transcript", () => {
  test("only its end is read, from the first whole line, and this turn is found there", () => {
    const d = mkdtempSync(join(tmpdir(), "reply-tail-"));
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "y".repeat(1_000) }] } });
    const rows = [his("Long ago"), said("P33 then"), ...Array.from({ length: 300 }, () => filler), his("Status?"), said("All done.")];
    writeFileSync(join(d, "t.jsonl"), rows.join("\n") + "\n");
    const tail = tailLines(join(d, "t.jsonl"), 50_000);
    expect(tail.length).toBeLessThan(rows.length);
    expect(() => tail.forEach((l) => l && JSON.parse(l))).not.toThrow();               // no line cut in half
    expect(turnWords(tail)).toEqual(["All done."]);
    expect(turnWords(tailLines(join(d, "t.jsonl")))).toEqual(["All done."]);            // a small one, whole
  });
});

describe("what he can't read", () => {
  test("the gate's rules: an em dash, an add-on, a hidden count, a full commit id", () => {
    const found = unreadable([`Done ${DASH} the add-on is updated, and 3 more. Commit ${"a".repeat(39)}1.`], null);
    expect(found.some((f) => f.includes("no em dashes"))).toBe(true);
    expect(found.some((f) => f.includes("Apps, not add-ons"))).toBe(true);
    expect(found.some((f) => f.includes("no shas, job ids"))).toBe(true);
    expect(found.some((f) => f.includes("name each one instead of a count"))).toBe(true);
  });

  test("codes: an item his record has, a registry or rule number that exists, a wave, a commit's short id", () => {
    const found = unreadable(["P33 is done; S-062 changed under R-004; wave 1 is close; head d47fd11."], items, numbers);
    expect(found.some((x) => x.startsWith(`"P33 is done`) && x.endsWith("(a record code he can't read)"))).toBe(true);
    for (const f of [`"S-062" (a registry or rule number)`, `"R-004" (a registry or rule number)`, `"wave 1" (a build wave)`, `"d47fd11" (a commit's id)`])
      expect([f, found.includes(f)]).toEqual([f, true]);
  });

  test("ordinary words pass: vitamins, vertebrae, races, refrigerants, paper, part numbers, numbers that aren't ours, times, a link's target", () => {
    expect(unreadable([
      "Take vitamin D3 with breakfast, and a B12 shot on Friday.",
      "The C1 vertebra sits under the skull; an F1 race runs Sunday.",
      "The car takes R-134a; the old unit took R-22. Print it on A4; the S-300 and R-999 aren't ours.",
      "At 7:10 Cain reviews it; 53 cases passed on both. See [the change](https://github.com/o/r/commit/d47fd115f4cd6bd2e552ab7a7f5c68379dd804ab). P99 isn't one.",
    ], items, numbers)).toEqual([]);
  });

  test("the numbers that are codes are the ones that exist", () => {
    expect([...numbers].sort()).toEqual(["R-004", "S-013", "S-062"]);
    expect(knownNumbers(null, [])).toEqual(new Set());
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
    const r = run([his("Status?"), said(`Merged ${DASH} S-062 is next.`)]);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o.decision).toBe("block");
    expect(o.reason).toStartWith("What you showed him this turn has words he can't read: ");
    expect(o.reason).toContain("(no em dashes)");
    expect(o.reason).toContain(`"S-062" (a registry or rule number)`);            // the registry beside the tool
    expect(o.reason).toContain("If one is an ordinary word where it stands");
  });

  test("clean words, a turn it already kept going, or a transcript it can't read: nothing", () => {
    expect(run([his("Status?"), said("Merged. The next piece is the standards cleanup, and vitamin D3 is fine.")])).toEqual({ code: 0, out: "" });
    expect(run([his("Status?"), said("S-062 is next.")], { stop_hook_active: true })).toEqual({ code: 0, out: "" });
    expect(run([], { transcript_path: "/nowhere/t.jsonl" })).toEqual({ code: 0, out: "" });
  });
});
