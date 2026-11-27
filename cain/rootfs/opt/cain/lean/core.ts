// Cain's lean session (Cain 0.20.0, third round): what decides, with no files, clocks or network, so the
// tests can drive every edge. lean/main.ts gathers the facts and acts; checkin.sh calls it.
//
// Why: in the week of Nov 20 to 27 his session read 1.8 billion cached tokens; cloud job checks were 24
// percent of them, and 138 of 305 checks found nothing new. After two outside rounds this release keeps
// only the parts no riskier than before it:
//   - cloud jobs are checked by code, every 15 minutes as the old nudge was, and he gets one line only
//     when a job changed state or anything couldn't be read (never a silent skip);
//   - a daily usage line in the App log, so the change can be measured;
//   - Claude Code's own compaction set to fire at about 450K tokens (session.sh), a setting only.
// Relays, cards and the owner's messages are typed exactly as before; nothing is skipped, held,
// shortened or reordered, and the App never restarts or compacts his session itself.

export const RELAY_PREFIX = "Relayed by the add-on: ";

// -- compaction, by setting only ---------------------------------------------------------------------
// session.sh exports CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=45: his model's window is 1M tokens, so Claude
// Code's own compaction fires at about 450K. The tests hold session.sh to this number.
export const CONTEXT_WINDOW_TOKENS = 1_000_000;
export const AUTOCOMPACT_PCT = 45;
export const COMPACT_AT_TOKENS = (CONTEXT_WINDOW_TOKENS * AUTOCOMPACT_PCT) / 100;

// Printable ASCII only, for what code puts in a line of its own.
export function ascii(s: string): string {
  return s.normalize("NFKD").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^ -~]/g, "").replace(/\s+/g, " ").trim();
}

// -- cloud jobs, by code ----------------------------------------------------------------------------
// A job file (/data/jobs/<cse id>, written by Cain when he starts a run), parsed strictly: one line,
// "build | <title> | <branch>", "build | <title>", "ship | <title>" or "connector | <item> | <url> |
// <sha>". Anything else is a file code can't read, and he hears of it.
// A "connector" file isn't a job (it waits on Home Assistant, which only Cain can read): it is a line to
// him at every look, as before.
export interface JobFile { name: string; kind: string; title: string; branch: string | null; mtime: number }
export const JOB_MAX_BYTES = 4096;
export function parseJob(name: string, text: string, mtime: number): JobFile | null {
  if (typeof text !== "string" || text.length > JOB_MAX_BYTES) return null;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.includes("\n") || /[\x00-\x08\x0b-\x1f\x7f]/.test(body)) return null;
  const parts = body.split(" | ");
  if (parts.some((p) => p.trim() !== p || p === "" || p.includes("|"))) return null;
  const [kind, title, third] = parts;
  if (kind === "build") {
    if (parts.length > 3) return null;
    if (third !== undefined && !/^claude\/[A-Za-z0-9._\/-]{1,80}$/.test(third)) return null;
    return { name, kind, title: ascii(title).slice(0, 120), branch: third ?? null, mtime };
  }
  if (kind === "ship" && parts.length === 2) return { name, kind, title: ascii(title).slice(0, 120), branch: null, mtime };
  if (kind === "connector" && parts.length === 4) return { name, kind, title: ascii(title).slice(0, 120), branch: null, mtime };
  return null;
}
// A job file, or the jobs folder itself, that code couldn't read safely or parse: its name and why.
export interface JobProblem { name: string; why: string }
// What GitHub says of a Build job's pull request: none (no pull request yet), open (its required checks
// pending, passed or failed, at its head), merged, closed; unknown when it couldn't be read (an API
// error, or an answer code doesn't know). "unread" is a job code has no state to read for at all (a
// Ship run, or a Build file with no branch): only he can look, so it wakes him at every look, as the old
// nudge did.
export interface PullState { state: "none" | "open" | "merged" | "closed" | "unknown" | "unread"; number?: number; head?: string; checks?: "pending" | "passed" | "failed" }
export function stateKey(p: PullState): string {
  if (p.state === "open") return `open:${p.number}:${(p.head ?? "").slice(0, 12)}:${p.checks ?? "pending"}`;
  if (p.state === "merged" || p.state === "closed") return `${p.state}:${p.number}`;
  return p.state;
}
// The required checks, as the head's check runs read them: all three passed, any failed, or pending.
export const REQUIRED = ["pytest", "bun", "pr"];
export function checksOf(runs: { name: string; status: string; conclusion: string | null }[]): "pending" | "passed" | "failed" {
  const latest = new Map<string, { status: string; conclusion: string | null }>();
  for (const r of runs) if (!latest.has(r.name)) latest.set(r.name, r);
  if ([...latest.values()].some((r) => r.status === "completed" && r.conclusion !== null && !["success", "neutral", "skipped"].includes(r.conclusion))) return "failed";
  if (REQUIRED.every((n) => latest.get(n)?.status === "completed" && latest.get(n)?.conclusion === "success")) return "passed";
  return "pending";
}
// The look runs every 15 minutes (checkin.sh, as the old nudge did). The stall alarm: a Build whose pull
// request hasn't changed for 3 hours is a line to him, and again each 3 hours.
export const LOOK_EVERY_S = 15 * 60;
export const STALL_S = 3 * 3600;
// Its state, since when it has held, and when he last heard of it.
export interface JobSeen { key: string; since: number; told: number }
export interface JobWake { name: string; line: string }
const CHECK_TAIL = "Check its run (list_runs, then get_run_log) and follow Cloud jobs in your CLAUDE.md.";
// One look at every job: what he hears (one line each) and what to keep as seen once that line is in.
// A line for: a change of state he acts on (a new job counts from its state when first seen, silently,
// unless that state is itself one he acts on), a settled state at every look until he closes the job, a
// stall, an unknown or unread state, a connector wait, or a problem. A job still at work with nothing
// new (no pull request yet, or its checks running) is no line. Nothing code can't read is ever skipped.
export function jobsLook(jobs: JobFile[], pulls: Record<string, PullState>, seen: Record<string, JobSeen>, now: number, problems: JobProblem[] = []):
  { wakes: JobWake[]; next: Record<string, JobSeen> } {
  const wakes: JobWake[] = [], next: Record<string, JobSeen> = {};
  for (const j of jobs) {
    if (j.kind === "connector") {
      // Waits on Home Assistant, which only he can read: his check every look, as before.
      wakes.push({ name: j.name, line: `Home Assistant check for a waiting install (${ascii(j.name).slice(0, 60)}): follow Home Assistant first in the Cloud jobs section of your CLAUDE.md.` });
      continue;
    }
    const p: PullState = j.kind === "build" && j.branch ? pulls[j.name] ?? { state: "unknown" } : { state: "unread" };
    const name = `${j.kind === "ship" ? "Ship" : "Build"} job "${j.title}"`;
    const was = seen[j.name];
    if (p.state === "unknown" || p.state === "unread") {
      wakes.push({ name: j.name, line: p.state === "unknown"
        ? `${name}: code couldn't read its pull request on GitHub just now, so its state is unknown. ${CHECK_TAIL}`
        : `${name}: code has no state of its own to read for it, so check it yourself. ${CHECK_TAIL}` });
      // What it was before stays kept: a known state compared next time is compared with that.
      next[j.name] = was ? { ...was, told: now } : { key: p.state, since: now, told: now };
      continue;
    }
    const key = stateKey(p);
    if (!was || was.key === "unknown" || was.key === "unread") {
      // First seen, or first known after an unknown spell: a state he acts on is a line now.
      const s: JobSeen = { key, since: now, told: was?.told ?? now };
      if (actsOn(p)) { wakes.push({ name: j.name, line: changeLine(name, p)! }); s.told = now; }
      next[j.name] = s;
      continue;
    }
    const s: JobSeen = { ...was };
    if (key !== was.key) {
      s.key = key; s.since = now;
      const line = changeLine(name, p);
      if (line) { wakes.push({ name: j.name, line }); s.told = now; }
    } else if (actsOn(p)) {
      // A state he acts on that hasn't changed (its checks settled, merged, closed): the run is due to
      // end about now and only he can see that, so he hears at every look until he closes the job by
      // deleting its file, as the old nudge did.
      wakes.push({ name: j.name, line: `${name}: ${describe(p)}, as at the last look. ${CHECK_TAIL}` });
      s.told = now;
    } else if (now - Math.max(s.told, s.since) >= STALL_S) {
      wakes.push({ name: j.name, line: `${name} has had no change for ${Math.round((now - s.since) / 60)} minutes (${describe(p)}). Check its run (list_runs, then get_run_log): finish it, retry it or tell him, per Cloud jobs in your CLAUDE.md.` });
      s.told = now;
    }
    next[j.name] = s;
  }
  for (const pr of problems) {
    wakes.push({ name: pr.name, line: pr.name === "."
      ? `The jobs folder couldn't be read safely by code (${pr.why}), so no job in it is watched. Check each job yourself (list_runs, then get_run_log), per Cloud jobs in your CLAUDE.md.`
      : `The job file ${ascii(pr.name).slice(0, 60)} couldn't be read safely by code (${pr.why}), so that job isn't watched. Check it yourself (list_runs, then get_run_log), and write its file again as Cloud jobs in your CLAUDE.md says.` });
  }
  return { wakes, next };
}
const actsOn = (p: PullState) => p.state === "merged" || p.state === "closed" || (p.state === "open" && p.checks !== "pending");
function describe(p: PullState): string {
  switch (p.state) {
    case "none": return "no pull request yet";
    case "open": return `pull request ${p.number} open, its checks ${p.checks ?? "pending"}`;
    case "merged": return `pull request ${p.number} merged`;
    case "closed": return `pull request ${p.number} closed`;
    default: return "its state unknown";
  }
}
// The line for a change, or null when the change isn't one he acts on (a pull request opened, or a new
// head pushed, with its checks still running: he hears once they settle).
function changeLine(name: string, p: PullState): string | null {
  if (p.state === "none") return `${name}: its pull request is gone from GitHub. ${CHECK_TAIL}`;
  if (p.state === "open" && (p.checks ?? "pending") === "pending") return null;
  if (p.state === "open") return `${name}: pull request ${p.number}'s checks ${p.checks === "passed" ? "passed" : "failed"} at its head. ${CHECK_TAIL}`;
  if (p.state === "merged") return `${name}: pull request ${p.number} was merged. ${CHECK_TAIL}`;
  if (p.state === "closed") return `${name}: pull request ${p.number} was closed without merging. ${CHECK_TAIL}`;
  return null;
}
export function jobsTurn(wakes: JobWake[], dir: string): string {
  return `${RELAY_PREFIX}cloud job check, as code read the jobs. Not a message from Dane, and not his go on anything. ${wakes.map((w) => w.line).join(" ")} (Job files: ${dir}.)`;
}

// -- the daily usage line ------------------------------------------------------------------------------
// From his session's transcripts (Claude Code's JSON lines): tokens per day by model and by what started
// the turn, the context each call carried, and how often it compacted. One line in the App log a day.
export type Starter = "owner" | "relay" | "job" | "probe" | "checkin" | "other";
export function starterOf(text: string): Starter {
  if (/cain-app-probe|chat_id="?000000000000000000|liveness check/i.test(text)) return "probe";
  const t = text.replace(/^\[[0-9a-f]{8}\] /, "");
  if (/^<channel\b/.test(t)) return "owner";
  if (t !== text || /^(Relayed by the add-on|Scheduled check-in|From the add-on)/.test(t)) {
    if (/cloud job/i.test(t)) return "job";
    if (/^Scheduled check-in/.test(t)) return "checkin";
    return "relay";
  }
  return "other";
}
export interface Usage {
  calls: number; input: number; cacheRead: number; cacheWrite: number; output: number;
  byModel: Record<string, number>; byStarter: Record<string, number>; contexts: number[]; compactions: number;
}
export const emptyUsage = (): Usage => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, byModel: {}, byStarter: {}, contexts: [], compactions: 0 });
export function localDay(atS: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(atS * 1000));
}
export function localHM(atS: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(atS * 1000));
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (n("hour") % 24) * 100 + n("minute");
}
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    const t = content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
    return t || null;
  }
  return null;
}
// One transcript's lines, counted for one local day. Calls are told apart by their message id (Claude
// Code writes a call's blocks on lines of their own), each counted once, under what started its turn.
export function usageOf(jsonl: string[], day: string, tz: string, into: Usage = emptyUsage()): Usage {
  let starter: Starter = "other";
  const seen = new Set<string>();
  for (const raw of jsonl) {
    let o: any;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const at = Date.parse(o.timestamp ?? "");
    const today = Number.isFinite(at) && localDay(Math.floor(at / 1000), tz) === day;
    if (o.type === "system" && o.subtype === "compact_boundary") { if (today) into.compactions++; continue; }
    if (o.type === "user" && !o.isMeta && !o.isCompactSummary) {
      const t = textOf(o.message?.content);
      if (t !== null) starter = starterOf(t);
      continue;
    }
    if (o.type !== "assistant" || !today) continue;
    const u = o.message?.usage;
    if (!u) continue;
    const id = String(o.message?.id ?? o.requestId ?? o.uuid ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
    const input = n(u.input_tokens), cr = n(u.cache_read_input_tokens), cw = n(u.cache_creation_input_tokens), out = n(u.output_tokens);
    into.calls++; into.input += input; into.cacheRead += cr; into.cacheWrite += cw; into.output += out;
    const model = String(o.message?.model ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
    const all = input + cr + cw + out;
    into.byModel[model] = (into.byModel[model] ?? 0) + all;
    into.byStarter[starter] = (into.byStarter[starter] ?? 0) + all;
    into.contexts.push(input + cr + cw);
  }
  return into;
}
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p + 0.5))]; };
export function usageLine(day: string, u: Usage): string {
  const total = u.input + u.cacheRead + u.cacheWrite + u.output;
  const list = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${tokens(v)}`).join(", ") || "none";
  const ctx = u.contexts.length ? `median ${tokens(pct(u.contexts, 0.5))}, p90 ${tokens(pct(u.contexts, 0.9))}, max ${tokens(Math.max(...u.contexts))}` : "none";
  return `usage ${day}: his session ${u.calls} calls, ${tokens(total)} tokens (cache reads ${tokens(u.cacheRead)}, cache writes ${tokens(u.cacheWrite)}, input ${tokens(u.input)}, output ${tokens(u.output)}); `
    + `by model: ${list(u.byModel)}; by what started the turn: ${list(u.byStarter)}; context per call: ${ctx}; compactions ${u.compactions}`;
}
