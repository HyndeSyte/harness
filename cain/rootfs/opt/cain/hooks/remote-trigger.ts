// Cain's guard on the RemoteTrigger tool: a PreToolUse hook, wired in settings.json.
// An accident guard on his cloud jobs, until his session is sealed off:
//   - only run, list_runs and get_run_log, and only on the Build and Ship routines;
//   - a Build run names its branch ("Branch: claude/<slug>"), never a pull request in
//     its place, and never a branch someone else holds (state/holds.json, which the
//     record keeper publishes into Cain's copy of the record);
//   - a Ship run carries the full 40-character head sha that Dane's Ship card was for.
// A refusal goes back to Cain as the reason; anything else is left to the usual
// permission rules. If the call can't be read, it's refused.
import { readFileSync } from "node:fs";
import { parseHolds } from "../link/core.ts";

export const BUILD = "trig_015FTxexzFDZyjYjzw39bPv8";
export const SHIP = "trig_015NTtUUC5DN82zDJBwmcq1r";
const ACTIONS = new Set(["run", "list_runs", "get_run_log"]);
const HOLDS = process.env.CAIN_HOLDS ?? "/data/record/state/holds.json";

const clip = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

// The branches a Build job's text names: each line that starts "Branch: <name>".
export function branchesOf(text: string): string[] {
  return [...text.matchAll(/^[ \t]*branch:[ \t]*`?([^\s`]+)`?/gim)].map((m) => m[1].replace(/[.,;:)"']+$/, ""));
}

// "" when there's nothing to object to; otherwise why it's refused, for Cain.
export function decide(call: any, holdsText: string | null): string {
  if (!call || typeof call !== "object") return "couldn't read the RemoteTrigger call, so it's refused";
  if (call.tool_name !== undefined && call.tool_name !== "RemoteTrigger") return "";
  const t = call.tool_input;
  if (!t || typeof t !== "object") return "couldn't read the RemoteTrigger call, so it's refused";
  const action = String(t.action ?? "");
  if (!ACTIONS.has(action))
    return `RemoteTrigger is only for run, list_runs and get_run_log on the Build and Ship routines; "${clip(action)}" is refused.`;
  const trigger = t.trigger_id === undefined || t.trigger_id === null ? "" : String(t.trigger_id);
  if (action === "get_run_log" && !trigger) return "";            // by the run's session id
  if (trigger !== BUILD && trigger !== SHIP)
    return `Only the Build (${BUILD}) and Ship (${SHIP}) routines; "${clip(trigger)}" is refused.`;
  if (action !== "run") return "";
  const text = typeof t.body?.text === "string" ? t.body.text : "";
  if (trigger === BUILD) {
    const branches = branchesOf(text);
    if (!branches.length)
      return "A Build job names its branch in its text, as \"Branch: claude/<slug>\": the pull request's own branch for fixes, or a new one for new work. A pull request link is not a branch.";
    for (const b of branches)
      if (!/^claude\/[A-Za-z0-9._-]+$/.test(b) || b.includes(".."))
        return `"${clip(b)}" isn't a Build branch: name it as claude/<slug>. A pull request link is not a branch.`;
    const holds = parseHolds(holdsText);
    if (holds === null) return "state/holds.json can't be read right now, so the branch can't be checked; try again in a minute.";
    for (const b of branches)
      for (const [item, h] of Object.entries(holds))
        if (String(h?.holder ?? "") !== "cain" && Array.isArray(h?.branches) && h.branches.map(String).includes(b))
          return `${b} is held by another session (item ${clip(item)}). Don't build on it: send the fix to its holder as a note, and don't tell Dane who holds it.`;
    return "";
  }
  if (!/\b[0-9a-f]{40}\b/i.test(text))
    return "A Ship job carries the full 40-character head sha his Ship card was for (it's in the relayed tap), and merges with gh pr merge --squash --match-head-commit <that sha>.";
  return "";
}

function holdsFile(): string | null {
  try { return readFileSync(HOLDS, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? null : ""; }
}

if (import.meta.main) {
  let reason: string;
  try { reason = decide(JSON.parse(await Bun.stdin.text()), holdsFile()); }
  catch { reason = "couldn't read the RemoteTrigger call, so it's refused"; }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}
