// Cain's PreToolUse hook on RemoteTrigger (hooks/remote-trigger.ts).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchesOf, BUILD, decide, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";

const HOOK = join(import.meta.dir, "../rootfs/opt/cain/hooks/remote-trigger.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const call = (tool_input: any) => ({ tool_name: "RemoteTrigger", hook_event_name: "PreToolUse", tool_input });
const run = (trigger_id: string, text: string) => call({ action: "run", trigger_id, body: { text } });
const holds = JSON.stringify({
  P33: { holder: "laptop:9f2c", for: "his chat, Nov 11", branches: ["claude/cain-owner-gate"], taken: "x", renewed: "x" },
  P41: { holder: "cain", for: "Build job", branches: ["claude/one-voice-cards"], taken: "x", renewed: "x" },
});
const GOOD_BUILD = "Branch: claude/turkey-card\nMake the turkey harvest card say its date. Done when tests pass.";
const GOOD_SHIP = `Ship pull request https://github.com/HyndeSyte/harness/pull/5 at head ${SHA}. Merge it with gh pr merge --squash --match-head-commit ${SHA}. Dane tapped Ship at 9:40.`;

describe("the RemoteTrigger hook", () => {
  test("allows only run, list_runs and get_run_log", () => {
    for (const action of ["create", "update", "list", "get", "create_webhook_trigger", "delete", ""])
      expect(decide(call({ action, trigger_id: BUILD, body: {} }), null)).toContain("only for run, list_runs and get_run_log");
    expect(decide(call({ action: "list_runs", trigger_id: BUILD }), null)).toBe("");
    expect(decide(call({ action: "list_runs", trigger_id: SHIP }), null)).toBe("");
    expect(decide(call({ action: "get_run_log", session_id: "cse_01ABC" }), null)).toBe("");
  });

  test("allows only the Build and Ship routines", () => {
    expect(decide(run("trig_01OTHERroutine", GOOD_BUILD), null)).toContain("Only the Build");
    expect(decide(call({ action: "list_runs", trigger_id: "trig_01OTHERroutine" }), null)).toContain("Only the Build");
    expect(decide(call({ action: "run" }), null)).toContain("Only the Build");
    expect(decide(call({ action: "get_run_log", trigger_id: "trig_01OTHERroutine", session_id: "cse_1" }), null)).toContain("Only the Build");
  });

  test("refuses a Build run that doesn't name its branch", () => {
    expect(decide(run(BUILD, "Fix the turkey card."), null)).toContain("names its branch");
    expect(decide(call({ action: "run", trigger_id: BUILD }), null)).toContain("names its branch");
    expect(decide(run(BUILD, "Base branch: main. Fix it."), null)).toContain("names its branch");   // not a Branch: line
  });

  test("refuses a Build run that names a pull request, or main, in place of its branch", () => {
    expect(decide(run(BUILD, "Branch: https://github.com/HyndeSyte/harness/pull/3\nFix it."), null)).toContain("isn't a Build branch");
    expect(decide(run(BUILD, "Branch: main\nFix it."), null)).toContain("isn't a Build branch");
    expect(decide(run(BUILD, "Branch: claude/../main\nFix it."), null)).toContain("isn't a Build branch");
  });

  test("refuses a Build run on a branch someone else holds, and says to send a note", () => {
    const why = decide(run(BUILD, "Branch: claude/cain-owner-gate\nFix the panel lock."), holds);
    expect(why).toContain("held by another session");
    expect(why).toContain("note");
    expect(why).not.toContain("laptop");
    expect(decide(run(BUILD, "Branch: claude/one-voice-cards\nFix the sweep."), holds)).toBe("");     // Cain's own
    expect(decide(run(BUILD, GOOD_BUILD), holds)).toBe("");                                          // no one's
    expect(decide(run(BUILD, GOOD_BUILD), null)).toBe("");                                           // no holds file yet
    expect(decide(run(BUILD, GOOD_BUILD), "{broken")).toContain("can't be read");
  });

  test("refuses a Ship run without the full head sha", () => {
    expect(decide(run(SHIP, "Ship pull request https://github.com/HyndeSyte/harness/pull/5."), null)).toContain("40-character head sha");
    expect(decide(run(SHIP, "Ship pull request 5 at head 0123456."), null)).toContain("40-character head sha");
    expect(decide(run(SHIP, GOOD_SHIP), null)).toBe("");
  });

  test("names the branches a job's text gives, one per Branch: line", () => {
    expect(branchesOf("Branch: `claude/a-b`.\nbranch: claude/c\nOn branch claude/d")).toEqual(["claude/a-b", "claude/c"]);
  });

  test("runs as Claude Code calls it: a refusal is a deny with its reason, a good call says nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-hook-"));
    const file = join(dir, "holds.json");
    writeFileSync(file, holds);
    const hook = async (input: string) => {
      const p = Bun.spawn(["bun", HOOK], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CAIN_HOLDS: file } });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out;
    };
    const denied = JSON.parse(await hook(JSON.stringify(run(BUILD, "Fix https://github.com/HyndeSyte/harness/pull/3"))));
    expect(denied.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("names its branch");
    expect(JSON.parse(await hook(JSON.stringify(run(BUILD, "Branch: claude/cain-owner-gate\nx")))).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await hook(JSON.stringify(run(BUILD, GOOD_BUILD)))).toBe("");
    expect(await hook(JSON.stringify(run(SHIP, GOOD_SHIP)))).toBe("");
    expect(JSON.parse(await hook("not json")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("is wired in Cain's settings, and its routines are the ones in his rules", () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse.find((h: any) => h.matcher === "RemoteTrigger");
    expect(pre.hooks[0].command).toBe("bun /opt/cain/hooks/remote-trigger.ts");
    const rules = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/CLAUDE.md"), "utf8");
    expect(rules).toContain(`Build: \`${BUILD}\``);
    expect(rules).toContain(`Ship: \`${SHIP}\``);
  });
});
