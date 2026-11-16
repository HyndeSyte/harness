// The Windows Ship gate, read without acting (0.12.0, seventeenth round): keeper.sh ship-gate.
// For one head of this repository it makes the very reading the landing and the Ship card make
// (merge.ts gateReport) and prints what the gate would decide and why, with the workflow file it
// read and every pcjobs-windows attempt it saw. It reads GitHub's public API only, without a key
// (the link's own 60 reads an hour from this address are shared with it), and changes nothing:
// no card, no landing, nothing written to GitHub.
//   bun shipgate.ts <full head sha>            one report, now (the dry run)
//   bun shipgate.ts <full head sha> --watch    the probe's ship_gate step: a report now, then one
//                                              every --every minutes (default 10) for up to --hours
//                                              (default and most 2), judged (merge.ts judgeShipGate),
//                                              and kept in /data/work/ship-gate-<head>.json
//   bun shipgate.ts --pr <number> --head <full sha> --watch
//                                              the same, started before the push, for the exact sha the
//                                              pusher is about to push (twentieth round): it waits until
//                                              the pull request's head equals that sha, reads and accepts
//                                              only it, and fails by name (other_head, head_moved) if a
//                                              different head appears or the head moves away; kept by
//                                              sha in /data/work/ship-gate-<sha>.json, with the pull
//                                              request, where the Ship card reads it
//   bun shipgate.ts --supersede <full sha>     records that the acceptance kept for that sha is replaced
//                                              (after a rebase), so a card for the pull request's new
//                                              head can go once a new watch accepts it
// Every watch ends with a named failure past its caps (merge.ts): one wait GitHub asks for over 15
// minutes (rate_wait_cap), or 2 hours in all (watch_cap).
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gateReport, watchAccepted, watchFile, watchShipGate, type MergeDeps, type WatchLine } from "./merge";

export const SHIP_REPO = "HyndeSyte/harness";
export const WATCH_DIR = "/data/work";
const SHA = /^[0-9a-f]{40}$/;
async function api(path: string): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const r = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28" } });
  const headers: Record<string, string> = {};
  for (const k of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) { const v = r.headers.get(k); if (v !== null) headers[k] = v; }
  return { status: r.status, body: await r.json().catch(() => null), headers };
}
// Every unsuperseded acceptance a watch of this pull request kept (ship-gate-<sha>.json), as the
// Ship card reads them (link/main.ts gateWatch). An unreadable file counts as none.
export function acceptedFor(dir: string, pr: number): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    const m = /^ship-gate-([0-9a-f]{40})\.json$/.exec(n);
    if (!m) continue;
    let text: string | null = null;
    try { text = readFileSync(`${dir}/${n}`, "utf8"); } catch { continue; }
    const a = watchAccepted(text);
    if (a && a.pr === pr && a.head === m[1]) out.push(a.head);
  }
  return out.sort();
}
// One live acceptance per pull request (0.12.0, twenty-first round): the live (not superseded)
// acceptances of a pull request other than this head. A watch refuses to accept while any stands
// (live_acceptance, naming it), so the Ship card always reads exactly one.
export const otherLive = (dir: string, pr: number, head: string): string[] => acceptedFor(dir, pr).filter((h) => h !== head);
export const liveWhy = (other: string[]) =>
  `another live acceptance of this pull request stands (${other.join(", ")}): supersede it first (keeper.sh ship-gate --supersede ${other[0]}, once the pull request's head has moved past it), then watch again`;
// The watch's line as it is kept: an acceptance is kept only when no other live acceptance of its pull
// request stands, read again as it is written; otherwise it is kept as a failure (live_acceptance).
export function keepWatch(dir: string, line: WatchLine, out: string): WatchLine {
  let kept = line;
  if (line.pr !== null && line.accepted_head) {
    const other = otherLive(dir, line.pr, line.accepted_head);
    if (other.length) kept = { ...line, accepted_head: null, passed: false, failure: "live_acceptance", failure_why: liveWhy(other) };
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(kept, null, 2) + "\n");
  renameSync(`${out}.tmp`, out);
  return kept;
}
// keeper.sh ship-gate --supersede <sha>: the acceptance kept for that sha is marked replaced, with
// when; the file stays, as the record of what was accepted. Written whole, then renamed into place.
// Only once the pull request's head has moved past it (twenty-first round): headOf reads the pull
// request's current head; the same sha, or a head that can't be read, refuses, naming it.
export async function supersede(dir: string, sha: string, headOf: (pr: number) => Promise<string | null>, now = () => new Date()): Promise<{ ok: true; pr: number | null } | { ok: false; why: string }> {
  if (!SHA.test(sha)) return { ok: false, why: "that isn't a full commit sha" };
  const f = watchFile(dir, sha);
  let x: any;
  try { x = JSON.parse(readFileSync(f, "utf8")); } catch { return { ok: false, why: `no watch is kept for ${sha} (${f})` }; }
  if (x?.accepted_head !== sha) return { ok: false, why: `the watch kept for ${sha} accepted nothing: there is nothing to supersede` };
  if (x.superseded) return { ok: true, pr: typeof x.pr === "number" ? x.pr : null };
  if (typeof x.pr !== "number") return { ok: false, why: `the watch kept for ${sha} names no pull request, so its head can't be checked: nothing is superseded` };
  const now_head = await headOf(x.pr).catch(() => null);
  if (!now_head || !SHA.test(now_head)) return { ok: false, why: `the head of pull request ${x.pr} couldn't be read from GitHub: nothing is superseded; try again` };
  if (now_head.toLowerCase() === sha) return { ok: false, why: `pull request ${x.pr}'s head is still ${now_head.toLowerCase()}, the sha being replaced: supersede only once a new head has been pushed` };
  x.superseded = { at: now().toISOString() };
  writeFileSync(`${f}.tmp`, JSON.stringify(x, null, 2) + "\n");
  renameSync(`${f}.tmp`, f);
  return { ok: true, pr: typeof x.pr === "number" ? x.pr : null };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dir = flag("--dir") ?? WATCH_DIR;
  const usage = () => {
    console.error("usage: shipgate.ts <full head sha> [--watch [--every <minutes>] [--hours <hours>] [--out <file>]] [--repo owner/name]\n       shipgate.ts --pr <number> --head <full sha> --watch [...]\n       shipgate.ts --supersede <full sha>");
    process.exit(2);
  };
  const sup = flag("--supersede");
  if (sup !== undefined) {
    const headOf = async (n: number) => { const r = await api(`/repos/${flag("--repo") ?? SHIP_REPO}/pulls/${n}`); return r.status === 200 && typeof r.body?.head?.sha === "string" ? r.body.head.sha : null; };
    const r = await supersede(dir, sup.toLowerCase(), headOf);
    if (!r.ok) { console.error(r.why); process.exit(1); }
    console.log(JSON.stringify({ superseded: sup.toLowerCase(), pr: r.pr }, null, 2));
    process.exit(0);
  }
  const prArg = flag("--pr");
  const pr = prArg !== undefined && /^\d{1,7}$/.test(prArg) ? Number(prArg) : null;
  const head = (prArg !== undefined ? flag("--head") ?? "" : args[0] ?? "").toLowerCase();
  const repo = flag("--repo") ?? SHIP_REPO;
  const d: Pick<MergeDeps, "api"> = { api };
  if (!SHA.test(head) || (prArg !== undefined && (pr === null || !args.includes("--watch"))) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) usage();
  // One live acceptance per pull request: a watch doesn't start while another stands.
  if (pr !== null) { const other = otherLive(dir, pr, head); if (other.length) { console.error(liveWhy(other)); process.exit(1); } }
  if (!args.includes("--watch")) {
    console.log(JSON.stringify(await gateReport(d, repo, head), null, 2));
  } else {
    const every = Math.min(Math.max(Number(flag("--every") ?? 10), 2), 60) * 60_000;
    const hours = Math.min(Math.max(Number(flag("--hours") ?? 2), 0.1), 2) * 3_600_000;
    const out = flag("--out") ?? watchFile(dir, head);
    const watched = await watchShipGate(d, repo, pr !== null ? { pr, head } : head, { everyMs: every, untilMs: hours,
      each: (r) => console.log(JSON.stringify({ at: r.at, decision: r.decision, why: r.why, windows: r.windows, attempts: r.attempts.length })) });
    let line = watched;
    try { line = keepWatch(dir, watched, out); } catch { line = watched.pr !== null && watched.accepted_head && otherLive(dir, watched.pr, watched.accepted_head).length
      ? { ...watched, accepted_head: null, passed: false, failure: "live_acceptance", failure_why: liveWhy(otherLive(dir, watched.pr, watched.accepted_head)) } : watched; }
    console.log(JSON.stringify({ step: line.step, pr: line.pr, head: line.bound_head, accepted_head: line.accepted_head, passed: line.passed, failure: line.failure, failure_why: line.failure_why,
      refused_while_pending: line.refused_while_pending, accepted_early: line.accepted_early, accepted_after_pass: line.accepted_after_pass, attempts_seen: line.attempts_seen, kept: out }, null, 2));
    if (line.failure) process.exit(1);
  }
}
