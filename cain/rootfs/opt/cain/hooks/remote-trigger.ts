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
//   - (0.19.0, with Keeper 0.1.3 and 0.1.4) one Ship run per token, and only once the keeper accepted its
//     installs: once the checks pass, the hook asks the link (POST /ship-pass, Cain's key), which registers
//     every watched App the run installs with the keeper App and answers "pending" until the keeper has
//     made and verified each one's backup, then "ok" once (the token spent; a second run on it is
//     refused). The hook asks again for a few seconds while it is pending, then refuses the run with a
//     line telling Cain to start the same run again in a minute (../link/ship-pass.ts). A link that
//     doesn't answer, or a refused pass, refuses the run. (Keeper 0.1.5) The link's "ok" comes only after
//     it claimed each acceptance at the keeper (single use, valid 30 minutes) and checked the keeper's
//     pinned key against cain/SHIP_KEY_FINGERPRINT at the head and its state against the recorded
//     enrollment; it carries each claim id and deadline, and the link logs "Ship pass ok: <attempt> claim
//     <claim> until <time>", the line the Ship run reads. A pass the link gives up on is cancelled at the
//     keeper. (Keeper 0.1.6) Just before it lets the run start, the hook checks each claim's deadline in
//     code: a claim with under 20 minutes left (or none it can read) refuses the run, and the hook asks the
//     link to cancel the pass and its claims (POST /ship-pass {token, cancel});
//   - while everything is stopped (Dane's Stop, ../stop.ts), no run starts at all;
//   - (Cain 0.16.0) a run carries one label, core, commitment, necessary-fix or other: in its body's
//     "label" field or on a "Label: <label>" line of its text (both, and they must agree); none is
//     "other". A Build run goes through the usage guard (../guard.ts): "other" is refused while the
//     plan or a review seat is below the reserve floor, logged, with no bypass. A Ship run only installs
//     what his tap landed, so it carries its label and isn't held. Round 2: the guard's log is root's
//     (0640), so the hold goes to the link (POST /guard-hold, Cain's key), which decides again and
//     appends it; if the link can't be reached the run is still refused, saying the hold wasn't logged.
//     Cain 0.17.0: the link is asked for every "other" Build run, not only when the hook refuses.
//     Round 2 of its review fixes: the hook has its own budget (HOOK_BUDGET_MS, under the 15 seconds
//     Claude Code gives it) and never scans a cold week itself: on a cold or missing plan cache it asks
//     the link first (the link, as root, reads and warms the cache), then reads once more; if its reading
//     still isn't ready it refuses with the named reason ("plan reading not ready: cache cold", or "out of
//     time") and has the link write that hold line. The two-pass rule stays: a run passes only when the
//     hook's reading and the link's both let it, and the link answered.
//     What it can be trusted for: guard.ts says (the count rests on Cain's own transcripts not being
//     altered); the hook is an accident guard, not a wall.
//     Paths are constants (../capfiles.ts), and the hook refuses every run while the test-mode
//     variable (CAIN_TEST_MODE) is set: the production run script never sets it.
// A refusal goes back to Cain as the reason; anything else is left to the usual
// permission rules. If the call, the holds, the Ship key or the Stop state can't be
// read, it's refused.
import { readFileSync } from "node:fs";
import { parseHolds } from "../link/core.ts";
import { findToken, publicKey, pullOf, readToken, signedAt } from "../ship-token.ts";
import { readStop, type StopState, stoppedWhy } from "../stop.ts";
import { CAIN_KEY_FILE, decide as guardDecide, labelOf, LINK_URL, paths, postHold, readings, type Label, type Verdict } from "../guard.ts";
import { TEST_MODE_VAR, testMode } from "../capfiles.ts";

export const BUILD = "trig_015FTxexzFDZyjYjzw39bPv8";
export const SHIP = "trig_015NTtUUC5DN82zDJBwmcq1r";
const ACTIONS = new Set(["run", "list_runs", "get_run_log"]);
const HOLDS = process.env.CAIN_HOLDS ?? "/data/record-holds.json";
// The paths can be moved only for the tests: the hook runs in the environment Claude Code
// was started with, which Cain's session doesn't set.
const SHIP_PUB = process.env.CAIN_SHIP_PUB ?? "/data/trust/ship.pub";
const PR_LINK = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

// What a Ship run is checked against: the link's public Ship key (null: none), the Stop
// state, and the time now.
export interface Env { pub?: string | null; stop?: StopState; now?: number; guard?: (label: Label, what: string) => Verdict }

// A run's label: its body's "label", or a "Label: <label>" line of its text; both must agree; none is "other".
export function runLabel(body: any, text: string): { label: Label } | { why: string } {
  const lines = [...text.matchAll(/^[ \t]*label:[ \t]*`?([A-Za-z-]+)`?[ \t]*$/gim)].map((m) => m[1].toLowerCase());
  const field = body?.label;
  const named = [...new Set([...(field !== undefined ? [String(field).toLowerCase()] : []), ...lines])];
  if (named.length > 1) return { why: `A run carries one label; this one names ${named.join(" and ")}.` };
  const label = labelOf(named[0]);
  if (!label) return { why: `"${clip(String(named[0]))}" isn't a label: core, commitment, necessary-fix or other.` };
  return { label };
}

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
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "text" && k !== "label"))
    return 'A run\'s body is {"text": "<the job>", "label": "<its label>"} and nothing else.';
  const text = typeof body.text === "string" ? body.text : "";
  const lab = runLabel(body, text);
  if ("why" in lab) return lab.why;
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
    // The usage guard, last: only a run that would otherwise start is held, and logged.
    const title = (text.split("\n").find((l) => /^\s*title:/i.test(l)) ?? `Build on ${branches[0]}`).trim().slice(0, 100);
    const g = lab.label !== "other" ? { ok: true as const }
      : env.guard ? env.guard(lab.label, title) : { ok: false as const, floor: "guard", why: "the usage guard couldn't run" };
    // Round 3: when the link's own reading passed what the hook's refused, the refusal names the hook's
    // reading and the difference, not a link that didn't take it.
    if (!g.ok)
      return `Held by the usage guard: this Build is labelled ${lab.label}, and ${g.linkPasses ? "by the hook's own reading " : ""}${g.why}. Core, commitment and necessary-fix work still run, and labelling work to get past the guard is against the rules. ${g.linkPasses
        ? "The link read the guard again and its reading lets it run, so the two readings differ (a reading changed between them, or they read different files); the hook's refusal stands, and it isn't on the guard's log: try again in a minute, and log a Build item if it repeats."
        : g.logged === false
        ? "The hold could not be logged (the link didn't take it), so it isn't on the guard's log: try again in a minute, and log a Build item if it repeats."
        : "It's on the guard's log: list it on the open list as held."}`;
    return "";
  }
  // Ship: his signed tap, for the pull request and head this job names.
  if (!/\b[0-9a-f]{40}\b/i.test(text))
    return "A Ship job carries the full 40-character head sha his Ship card was for (it's in the relayed line that says the link landed it), and installs that commit.";
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
  // The job names one pull request and one head, the ones his tap was for, and nothing
  // else a Ship could merge: no other pull request link, no other full sha.
  const rest = text.split(token).join(" ");
  const pulls = new Set([...rest.matchAll(PR_ANY)].map((m) => `${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase()));
  const shas = new Set([...rest.matchAll(SHA_ANY)].map((m) => m[0].toLowerCase()));
  const want = pullOf(c).replace(/^https:\/\/github\.com\//, "").toLowerCase();
  if (pulls.size !== 1 || !pulls.has(want) || shas.size !== 1 || !shas.has(c.head))
    return "This Ship token is for another pull request or head. A Ship job names one pull request and one full head sha, the ones his Ship tap was for, with that tap's token, and no other pull request or sha.";
  // A tap from before his last Stop or Turn back on no longer counts.
  if (env.stop?.at != null && signedAt(c) < env.stop.at)
    return "That Ship token is from before his last Stop or Turn back on, so it no longer counts. Ask him again with a new Ship card.";
  return "";
}

const PR_ANY = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?!\d)/gi;
const SHA_ANY = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi;

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? null : ""; }
}

// The guard as the hook runs it. Cain 0.17.0: the plan reader can return a real fraction now, so the
// link decides every "other" Build run first (../guard.ts LINK_DECIDES_BUILDS): the hook's reading is
// taken, then the link is asked every time (POST /guard-hold), and the run passes only when both let it
// and the link answered "passes". Two passes: decide() is synchronous, so the first finds the run's
// label and the hook's reading, the link is asked, and the second gives the answer.
// Round 2: a hook reading that wasn't ready (notReady: a cold cache, or out of time) asks the link first;
// when the link's reading passes, the hook reads once more (the link has warmed the cache), and if that
// still isn't ready the run is refused with the named reason, its hold line written by the link (post's
// hook field). A real refusal of the hook's own stays as before.
export type Post = (label: Label, what: string, hook?: string) => Promise<{ logged: boolean; passes?: boolean; why?: string }>;
export async function decideWithGuard(call: any, holdsText: string | null, env: Env,
    reading: (label: Label, what: string) => Verdict, post: Post): Promise<string> {
  let asked: { label: Label; what: string; v: Verdict } | null = null;
  const first = decide(call, holdsText, { ...env, guard: (label, what) => {
    const v = reading(label, what);
    asked = { label, what, v };
    return v;
  } });
  if (!asked) return first;
  const h = asked as { label: Label; what: string; v: Verdict };
  const sent = await post(h.label, h.what);
  const again = (v: Verdict) => decide(call, holdsText, { ...env, guard: () => v });
  if (h.v.ok) {
    if (sent.passes) return first;                                  // both readings let it run
    // The hook's reading passed, the link's didn't, or the link didn't answer: held (fail closed).
    return again(sent.logged
      ? { ok: false, floor: "link", why: `the link's reading holds it${sent.why ? ` (${sent.why})` : ""}`, logged: true }
      : { ok: false, floor: "link", why: "the link, which decides every other-labelled Build run, didn't let it run", logged: false });
  }
  if (h.v.notReady && sent.passes) {
    // The link read (and warmed the cache) and lets it run: the hook reads once more, within its budget.
    const v2 = reading(h.label, h.what);
    if (v2.ok) return again(v2);                                    // both readings let it run now
    if (v2.notReady) {
      const hold = await post(h.label, h.what, v2.notReady);         // the hook's own hold line, written by the link
      return again({ ...v2, logged: hold.logged });
    }
    return again({ ...v2, logged: false, linkPasses: true });
  }
  return again({ ...(h.v as Extract<Verdict, { ok: false }>), logged: sent.logged, ...(sent.passes ? { linkPasses: true } : {}) });
}

// The hook's own budget (round 2): Claude Code kills it at 15 seconds (settings.json); it answers by 12.
export const HOOK_BUDGET_MS = 12_000;
// What the budget leaves for one step, never less than half a second.
export const left = (deadline: number, now = Date.now()) => Math.max(500, deadline - now);

// (0.19.0) The link's answer for a Ship run's token: "ok" lets it through once, anything else refuses.
// (Keeper 0.1.4) "pending" (the keeper is still making the backup) is asked again every second or so
// within budgetMs (the hook's whole limit is 15 seconds), then refuses with the link's line, which tells
// Cain to start the same run again in a minute.
export type Pass = { ok: true; claims?: { attempt: string; claim: string; until: string }[] } | { ok: false; why: string; pending?: true };
export const PASS_BUDGET_MS = 10_000;
export const CLAIM_START_MIN_MS = 20 * 60_000;   // (Keeper 0.1.6) the same as link/ship-pass.ts
// (Keeper 0.1.6) Why the claims' deadlines refuse the run now ("" when they don't): any claim with under 20
// minutes left, or a deadline that can't be read.
export function claimDeadlineWhy(claims: { attempt: string; claim: string; until: string }[] | undefined, now: number): string {
  for (const k of claims ?? []) {
    const t = Date.parse(String(k?.until ?? ""));
    if (!Number.isFinite(t)) return `the keeper's claim of ${String(k?.attempt ?? "an install").slice(0, 80)} has no deadline the hook can read`;
    if (t - now < CLAIM_START_MIN_MS) return `the keeper's claim of ${String(k.attempt).slice(0, 80)} has ${Math.max(0, Math.floor((t - now) / 60_000))} minutes left, under the 20 a Ship run needs to start`;
  }
  return "";
}
// (Keeper 0.1.6) The hook's refusal of a passed run, sent to the link so it cancels the pass and its claims.
export async function postShipPassCancel(token: string, why: string, o: { url?: string; key?: string; keyFile?: string; fetch?: typeof fetch } = {}): Promise<void> {
  let key = o.key ?? "";
  if (!key) { try { key = readFileSync(o.keyFile ?? CAIN_KEY_FILE, "utf8").trim(); } catch { return; } }
  try {
    await (o.fetch ?? fetch)(`${o.url ?? LINK_URL}/ship-pass`, { method: "POST", body: JSON.stringify({ token, cancel: why }),
      headers: { "content-type": "application/json", "x-harness-key": key }, signal: AbortSignal.timeout(3_000) });
  } catch { /* the claims then run out unused: the keeper ends them by themselves */ }
}
export async function postShipPass(token: string, o: { url?: string; key?: string; keyFile?: string; ms?: number; fetch?: typeof fetch; budgetMs?: number; pauseMs?: number } = {}): Promise<Pass> {
  let key = o.key ?? "";
  if (!key) { try { key = readFileSync(o.keyFile ?? CAIN_KEY_FILE, "utf8").trim(); } catch { return { ok: false, why: "this start has no key for the link" }; } }
  const until = Date.now() + (o.budgetMs ?? PASS_BUDGET_MS);
  for (;;) {
    let j: any;
    try {
      const r = await (o.fetch ?? fetch)(`${o.url ?? LINK_URL}/ship-pass`, { method: "POST", body: JSON.stringify({ token }),
        headers: { "content-type": "application/json", "x-harness-key": key }, signal: AbortSignal.timeout(Math.max(500, Math.min(o.ms ?? 8_000, until - Date.now()))) });
      j = await r.json().catch(() => ({}));
      if (r.ok && j?.status === "ok") return Array.isArray(j.claims) ? { ok: true, claims: j.claims } : { ok: true };
      if (!(r.ok && j?.status === "pending")) return { ok: false, why: String(j?.said ?? `the link answered ${j?.status ?? r.status}`).slice(0, 300) };
    } catch (e) { return { ok: false, why: `the link didn't answer (${String(e).slice(0, 60)})` }; }
    const pause = o.pauseMs ?? 1_500;
    if (Date.now() + pause >= until) return { ok: false, pending: true, why: String(j?.said ?? "the keeper hasn't accepted the install yet").slice(0, 300) };
    await Bun.sleep(pause);
  }
}

// The whole decision: the checks (decide, with the usage guard), then for a Ship run that passed them the
// link's one-run-per-token pass, last, so only a run that would otherwise start spends its token.
export async function decideAll(call: any, holdsText: string | null, env: Env,
    reading: (label: Label, what: string) => Verdict, post: Post,
    pass: (token: string) => Promise<Pass>, cancel: (token: string, why: string) => Promise<void> = async () => {}, now: () => number = Date.now): Promise<string> {
  const first = await decideWithGuard(call, holdsText, env, reading, post);
  if (first) return first;
  const t = call?.tool_input;
  if (call?.tool_name !== undefined && call.tool_name !== "RemoteTrigger") return "";
  if (!t || String(t.action ?? "") !== "run" || String(t.trigger_id ?? "") !== SHIP) return "";
  const token = findToken(typeof t.body?.text === "string" ? t.body.text : "");
  if (!token) return "A Ship job carries the Ship token from his relayed Ship tap.";
  const p = await pass(token);
  // (Keeper 0.1.6) the claims' deadlines, checked in code immediately before the run is let through
  const late = p.ok ? claimDeadlineWhy(p.claims, now()) : "";
  if (late) { await cancel(token, late); return `The link didn't let this Ship run start: ${late}. Nothing was installed; the claims are cancelled, so start again with a new Ship card for the same pull request and head.`; }
  return p.ok ? "" : p.pending ? `This Ship run hasn't started yet: ${p.why}.` : `The link didn't let this Ship run start: ${p.why}.`;
}

if (import.meta.main) {
  let reason: string;
  if (testMode()) reason = `${TEST_MODE_VAR} is set, a tests-only variable, so no Build or Ship run starts. The App's run script never sets it: log it as a Build item.`;
  else {
    const p = paths();
    const now = Date.now();
    const deadline = now + HOOK_BUDGET_MS;
    // The hook's reading: from a warm cache only (coldOk false), and stopping at its share of the budget.
    const reading = (label: Label, what: string): Verdict => label !== "other" ? { ok: true }
      : guardDecide(label, readings({ settingsFile: p.settings, spendFile: p.spend, tz: p.tz, now: new Date(), cacheFile: p.cache,
          coldOk: false, deadline: Math.min(deadline - 4_000, Date.now() + 5_000) }), new Date());
    const post: Post = (l, w, hook) => postHold(l, w, { ms: Math.min(5_000, left(deadline) - 300), ...(hook ? { hook } : {}) });
    // (0.19.0 merge) main's Ship pass runs after the guard, inside the same budget: whatever the guard left of
    // HOOK_BUDGET_MS, at most PASS_BUDGET_MS, so the two together stay under Claude Code's 15 seconds.
    try { reason = await decideAll(JSON.parse(await Bun.stdin.text()), read(HOLDS), { pub: read(SHIP_PUB), stop: readStop(), now }, reading, post,
      (tok) => postShipPass(tok, { budgetMs: Math.min(PASS_BUDGET_MS, left(deadline) - 500) }), (tok, why) => postShipPassCancel(tok, why)); }
    catch { reason = "couldn't read the RemoteTrigger call, so it's refused"; }
  }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}
