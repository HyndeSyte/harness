// Cain's guard on the RemoteTrigger tool: a PreToolUse hook, wired in settings.json
// (a crash refuses too). An accident guard on his cloud jobs, until his session is
// sealed off:
//   - only run, list_runs and get_run_log, and only on the Build and Ship routines;
//     a run's body is {"text": ...} and nothing else;
//   - a Build run names its branch ("Branch: claude/<slug>"), and every branch it names
//     is in a hold of Cain's (taken for the job first), in the record keeper's own
//     holds file; it names no pull request, and no branch someone else holds, anywhere;
//   - a Ship run carries the Ship token from his Ship tap (../ship-token.ts): signed by
//     the link's Ship key, not expired, and for the pull request and full head sha the
//     job names;
//   - while everything is stopped (Dane's Stop, ../stop.ts), no run starts at all.
// A refusal goes back to Cain as the reason; anything else is left to the usual
// permission rules. If the call, the holds, the Ship key or the Stop state can't be
// read, it's refused.
import { readFileSync } from "node:fs";
import { parseHolds } from "../link/core.ts";
import { findToken, publicKey, pullOf, readToken } from "../ship-token.ts";
import { readStop, type StopState, stoppedWhy } from "../stop.ts";

export const BUILD = "trig_015FTxexzFDZyjYjzw39bPv8";
export const SHIP = "trig_015NTtUUC5DN82zDJBwmcq1r";
const ACTIONS = new Set(["run", "list_runs", "get_run_log"]);
const HOLDS = process.env.CAIN_HOLDS ?? "/data/record-holds.json";
const SHIP_PUB = process.env.CAIN_SHIP_PUB ?? "/data/ship.pub";
const PR_LINK = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

// What a Ship run is checked against: the link's public Ship key (null: none), the Stop
// state, and the time now.
export interface Env { pub?: string | null; stop?: StopState; now?: number }

const clip = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A branch name standing on its own in the text, in any case, even at the end of a
// sentence ("...claude/x."), but not as the start of a longer name (claude/x.v2).
const names = (text: string, branch: string) =>
  new RegExp(`(^|[^A-Za-z0-9._/-])${escape(branch)}[.,;:!?)]*($|[^A-Za-z0-9._/-])`, "i").test(text);

// The branches a Build job's text names: each line that starts "Branch: <name>".
export function branchesOf(text: string): string[] {
  return [...text.matchAll(/^[ \t]*branch:[ \t]*`?([^\s`]+)`?/gim)].map((m) => m[1].replace(/[.,;:)"']+$/, ""));
}

// "" when there's nothing to object to; otherwise why it's refused, for Cain.
// holdsText: the keeper's holds file (null: no such file).
export function decide(call: any, holdsText: string | null, env: Env = {}): string {
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
  const stop = env.stop ?? { stopped: true, at: null };
  if (stop.stopped) return stoppedWhy(stop, "no Build or Ship run starts");
  const body = t.body ?? {};
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "text"))
    return 'A run\'s body is {"text": "<the job>"} and nothing else.';
  const text = typeof body.text === "string" ? body.text : "";
  const holds = parseHolds(holdsText);
  if (holdsText === null || holds === null)
    return "The record keeper's holds can't be read, so the run can't be checked; try again in a minute.";
  // No branch someone else holds, anywhere in the job.
  for (const [item, h] of Object.entries(holds)) {
    if (String(h?.holder ?? "") === "cain") continue;
    for (const b of Array.isArray(h?.branches) ? h.branches.map(String) : [])
      if (names(text, b))
        return `${b} is held by another session (item ${clip(item)}). Leave it out of the job: send the fix to its holder as a note, and don't tell Dane who holds it.`;
  }
  if (trigger === BUILD) {
    if (PR_LINK.test(text))
      return "A Build job names its branch, never a pull request: take the pull request link out, and put its branch on a \"Branch: claude/<slug>\" line.";
    const branches = branchesOf(text);
    if (!branches.length)
      return "A Build job names its branch in its text, as \"Branch: claude/<slug>\": the pull request's own branch for fixes, or a new one for new work.";
    for (const b of branches) {
      if (!/^claude\/[A-Za-z0-9._-]+$/.test(b) || b.includes(".."))
        return `"${clip(b)}" isn't a Build branch: name it as claude/<slug>.`;
      const mine = Object.values(holds).some((h) => String(h?.holder ?? "") === "cain" && Array.isArray(h?.branches)
        && h.branches.map(String).includes(b));
      if (!mine)
        return `${b} isn't in a hold of yours. Take the job's item first, with "job" and that branch, and run Build once the take is done.`;
    }
    return "";
  }
  // Ship: his signed tap, for the pull request and head this job names.
  if (!/\b[0-9a-f]{40}\b/i.test(text))
    return "A Ship job carries the full 40-character head sha his Ship card was for (it's in the relayed tap), and merges with gh pr merge --squash --match-head-commit <that sha>.";
  const token = findToken(text);
  if (!token)
    return "A Ship job carries the Ship token from his relayed Ship tap (\"Ship token: ship1....\"), exactly as it came. No token, no Ship: ask him again with a new Ship card if it's gone.";
  if (!env.pub) return "The link's Ship key can't be read, so his Ship tap can't be checked; try again in a minute.";
  let checked;
  try { checked = readToken(token, publicKey(env.pub), env.now ?? Date.now()); }
  catch { return "The link's Ship key can't be read, so his Ship tap can't be checked; try again in a minute."; }
  if (!checked.ok)
    return `That Ship token can't be used: ${checked.why}. Ship only with the token from his newest Ship tap; if it ran out, ask him again with a new Ship card.`;
  const c = checked.claim;
  if (!text.includes(pullOf(c)) || !text.toLowerCase().includes(c.head))
    return "This Ship token is for another pull request or head. A Ship job names the pull request and full head sha his Ship tap was for, with that tap's token.";
  return "";
}

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? null : ""; }
}

if (import.meta.main) {
  let reason: string;
  try { reason = decide(JSON.parse(await Bun.stdin.text()), read(HOLDS), { pub: read(SHIP_PUB), stop: readStop(), now: Date.now() }); }
  catch { reason = "couldn't read the RemoteTrigger call, so it's refused"; }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}
