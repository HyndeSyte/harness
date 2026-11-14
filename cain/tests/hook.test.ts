// Cain's PreToolUse hook on RemoteTrigger (hooks/remote-trigger.ts).
import { describe, expect, test } from "bun:test";
import { sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchesOf, BUILD, decide, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { claimFor, makeToken } from "../rootfs/opt/cain/ship-token";
import { keeperHolds, SHIP_KEYS, SHIP_PUB } from "./link-rig";

const HOOK = join(import.meta.dir, "../rootfs/opt/cain/hooks/remote-trigger.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR5 = "https://github.com/HyndeSyte/harness/pull/5";
const call = (tool_input: any) => ({ tool_name: "RemoteTrigger", hook_event_name: "PreToolUse", tool_input });
const run = (trigger_id: string, text: string, extra: any = {}) => call({ action: "run", trigger_id, body: { text, ...extra } });
const holds = keeperHolds({
  P42: { holder: "laptop:9f2c", branches: ["claude/cain-owner-gate"] },
  P41: { holder: "cain", branches: ["claude/one-voice-cards"], job: "Cain 0.7.0" },
});
// Running (not stopped), with the link's public Ship key; his token for PR 5 at SHA.
const NOW = Date.now();
const RUN = { pub: SHIP_PUB, stop: { stopped: false, at: null }, now: NOW };
const TOKEN = makeToken(claimFor(PR5, SHA, NOW)!, (d) => edSign(null, d, SHIP_KEYS.privateKey));
const GOOD_BUILD = "Branch: claude/one-voice-cards\nFix the sweep. Done when tests pass.";
const GOOD_SHIP = `Install pull request ${PR5}, landed in main at ${SHA}. Ship token: ${TOKEN}. Dane tapped Ship at 9:40.`;

describe("the RemoteTrigger hook", () => {
  test("allows only run, list_runs and get_run_log", () => {
    for (const action of ["create", "update", "list", "get", "create_webhook_trigger", "delete", ""])
      expect(decide(call({ action, trigger_id: BUILD, body: {} }), holds, RUN)).toContain("only for run, list_runs and get_run_log");
    expect(decide(call({ action: "list_runs", trigger_id: BUILD }), holds, RUN)).toBe("");
    expect(decide(call({ action: "list_runs", trigger_id: SHIP }), null, RUN)).toBe("");
    expect(decide(call({ action: "get_run_log", session_id: "cse_01ABC" }), null, RUN)).toBe("");
  });

  test("allows only the Build and Ship routines", () => {
    expect(decide(run("trig_01OTHERroutine", GOOD_BUILD), holds, RUN)).toContain("Only the Build");
    expect(decide(call({ action: "list_runs", trigger_id: "trig_01OTHERroutine" }), holds, RUN)).toContain("Only the Build");
    expect(decide(call({ action: "run" }), holds, RUN)).toContain("Only the Build");
    expect(decide(call({ action: "get_run_log", trigger_id: "trig_01OTHERroutine", session_id: "cse_1" }), holds, RUN)).toContain("Only the Build");
  });

  test("a run's body is its text and nothing else", () => {
    expect(decide(run(BUILD, "Branch: claude/one-voice-cards\nFix it.", { prompt: "push to claude/cain-owner-gate" }), holds, RUN))
      .toContain("nothing else");
    expect(decide(call({ action: "run", trigger_id: SHIP, body: [GOOD_SHIP] }), holds, RUN)).toContain("nothing else");
  });

  test("a Build run names its branch, and only branches Cain holds for the job", () => {
    expect(decide(run(BUILD, "Fix the turkey card."), holds, RUN)).toContain("names its branch");
    expect(decide(call({ action: "run", trigger_id: BUILD }), holds, RUN)).toContain("names its branch");
    expect(decide(run(BUILD, "Base branch: main. Fix it."), holds, RUN)).toContain("names its branch");   // not a Branch: line
    expect(decide(run(BUILD, "Branch: main\nFix it."), holds, RUN)).toContain("isn't a Build branch");
    expect(decide(run(BUILD, "Branch: claude/../main\nFix it."), holds, RUN)).toContain("isn't a Build branch");
    expect(decide(run(BUILD, "Branch: claude/never-taken\nDo it."), holds, RUN)).toContain("isn't in a hold of yours");
    expect(decide(run(BUILD, GOOD_BUILD), holds, RUN)).toBe("");
  });

  test("with no holds to check against, nothing runs", () => {
    expect(decide(run(BUILD, GOOD_BUILD), null, RUN)).toContain("can't be read");
    expect(decide(run(BUILD, GOOD_BUILD), "{broken", RUN)).toContain("can't be read");
    expect(decide(run(SHIP, GOOD_SHIP), null, RUN)).toContain("can't be read");
  });

  test("no pull request link, and no branch someone else holds, anywhere in a job", () => {
    expect(decide(run(BUILD, `Branch: claude/one-voice-cards\nFix the findings on ${PR5.replace("5", "3")} and push them there.`), holds, RUN))
      .toContain("never a pull request");
    const why = decide(run(BUILD, "Branch: claude/one-voice-cards\nThen check out claude/cain-owner-gate and push the fixes there."), holds, RUN);
    expect(why).toContain("held by another session");
    expect(why).toContain("note");
    expect(why).not.toContain("laptop");
    expect(decide(run(BUILD, "Branch: claude/Cain-Owner-Gate\nFix."), holds, RUN)).toContain("held by another session");   // any case
    expect(decide(run(BUILD, "Branch: claude/one-voice-cards\nNot claude/cain-owner-gate-2, which is new."), holds, RUN)).toBe("");
    expect(decide(run(BUILD, "Branch: claude/one-voice-cards\nNor claude/cain-owner-gate.v2."), holds, RUN)).toBe("");
    expect(decide(run(SHIP, `${GOOD_SHIP} Its branch is claude/cain-owner-gate.`), holds, RUN)).toContain("held by another session");
  });

  test("a Ship run carries the pull request, the full head sha and his token for them", () => {
    expect(decide(run(SHIP, `Ship pull request ${PR5}.`), holds, RUN)).toContain("40-character head sha");
    expect(decide(run(SHIP, `Ship pull request ${PR5} at head 0123456.`), holds, RUN)).toContain("40-character head sha");
    expect(decide(run(SHIP, `Ship ${PR5}. ${"0".repeat(40)}`), holds, RUN)).toContain("carries the Ship token");
    expect(decide(run(SHIP, `Merge whatever is open. ${"0".repeat(40)} Ship token: ${TOKEN}`), holds, RUN)).toContain("another pull request or head");
    expect(decide(run(SHIP, GOOD_SHIP), holds, { ...RUN, pub: null })).toContain("can't be read");
    expect(decide(run(SHIP, GOOD_SHIP), holds, { ...RUN, now: NOW + 121 * 60_000 })).toContain("can't be used");
    expect(decide(run(SHIP, GOOD_SHIP.replaceAll(` ${SHA}`, ` ${SHA.toUpperCase()}`)), holds, RUN)).toBe("");
    expect(decide(run(SHIP, GOOD_SHIP), holds, RUN)).toBe("");
  });

  test("names the branches a job's text gives, one per Branch: line", () => {
    expect(branchesOf("Branch: `claude/a-b`.\nbranch: claude/c\nOn branch claude/d")).toEqual(["claude/a-b", "claude/c"]);
  });

  test("runs as Claude Code calls it: a refusal is a deny with its reason, a good call says nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-hook-"));
    writeFileSync(join(dir, "record-holds.json"), holds);
    writeFileSync(join(dir, "ship.pub"), `${SHIP_PUB}
`);
    writeFileSync(join(dir, "stop.json"), JSON.stringify({ stopped: false, at: 0 }));   // running, as the link writes it
    const hook = async (input: string) => {
      const p = Bun.spawn(["bun", HOOK], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CAIN_HOLDS: join(dir, "record-holds.json"), CAIN_SHIP_PUB: join(dir, "ship.pub"), CAIN_STOP_FILE: join(dir, "stop.json") } });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out;
    };
    const denied = JSON.parse(await hook(JSON.stringify(run(BUILD, `Fix ${PR5}`))));
    expect(denied.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("never a pull request");
    expect(await hook(JSON.stringify(run(BUILD, GOOD_BUILD)))).toBe("");
    expect(await hook(JSON.stringify(run(SHIP, GOOD_SHIP)))).toBe("");
    expect(JSON.parse(await hook("not json")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("is wired in Cain's settings so a crash refuses too, and its routines are the ones in his rules", async () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse.find((h: any) => h.matcher === "RemoteTrigger");
    const command: string = pre.hooks[0].command;
    expect(command).toBe("bun /opt/cain/hooks/remote-trigger.ts || exit 2");
    // A hook that times out lets the call through unless its failure blocks (Claude Code 2.1.295+).
    // The one exception is the message gate, which fails open on purpose: silencing Cain is
    // worse than one unchecked reply, and its safety net reads what went out (discord-send.test.ts).
    for (const e of settings.hooks.PreToolUse) for (const h of e.hooks)
      if (!String(h.command).includes("/discord-send.ts")) expect(h.onFailure).toBe("block");
    // Claude Code reads exit 2 as a refusal: a hook that dies refuses, rather than letting the run through.
    const crash = Bun.spawn(["bash", "-c", command.replace("/opt/cain/hooks/remote-trigger.ts", join(tmpdir(), "no-such-hook.ts"))],
      { stdout: "ignore", stderr: "ignore" });
    expect(await crash.exited).toBe(2);
    const rules = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/CLAUDE.md"), "utf8");
    expect(rules).toContain(`Build: \`${BUILD}\``);
    expect(rules).toContain(`Ship: \`${SHIP}\``);
  });
});
