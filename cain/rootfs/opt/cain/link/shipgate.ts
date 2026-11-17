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
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
// Twenty-second round: the check and the write happen under the pull request's own lock file
// (ship-gate-pr-<n>.lock, made exclusively), so two watches of one pull request finishing together can't
// both pass the check before either writes: the second waits for the lock (o.waitMs, default 10 seconds),
// then checks again and sees the first; a lock another watch still held at that time keeps its line as a failure
// (live_acceptance), never an acceptance, and one that couldn't be read keeps it as lock_unavailable, with a notice.
// Twenty-third round, the lock made true:
// - the lock holds a token of its holder ({pid, token, at}); its time is refreshed at the check and before the write
//   (beat; not periodically), and the holder checks it still holds its own token before it
//   writes and before it lets go, so it never writes on, or removes, a lock that isn't its own;
// - a lock whose time is older than LOCK_STALE_MS (a watch killed holding it) is taken over only by an atomic
//   rename of it to a name of the taker's own, then the exclusive create again: exactly one contender proceeds (the
//   renamer may lose the exclusive create to another watch, which is fine: that watch holds it), and it checks
//   the live acceptances again after it has the lock (keepWatch). A rename that turns out to have caught a fresh lock
//   (one made between the stat and the rename) puts it back where it was, and backs off;
// - the critical section is bounded (one directory read and one write) far below LOCK_STALE_MS: a holder that
//   took longer than CRITICAL_MAX_MS to reach its write doesn't write (lock_unavailable), so a slow live holder
//   is never mistaken for a dead one (CRITICAL_MAX_MS * 4 <= LOCK_STALE_MS, asserted below);
// - a lock that can't be read (its time or its holder) counts as held: the taker backs off until its deadline,
//   then fails lock_unavailable with a notice.
export const LOCK_STALE_MS = 60_000;
export const CRITICAL_MAX_MS = 10_000;
if (CRITICAL_MAX_MS * 4 > LOCK_STALE_MS) throw new Error("ship gate: the lock's stale threshold must be well above its critical section");
const lockFile = (dir: string, pr: number) => `${dir}/ship-gate-pr-${pr}.lock`;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export interface HeldLock { file: string; token: string; since: number }
// Twenty-fourth round, the legacy rule: a lock with no token (the empty file the twenty-second round made, or
// JSON without a token) is "legacy". Older than the stale bound, it is taken over through the same rename then
// exclusive create, with a loud log line; one that looks current still counts as held. A file whose content
// fails to parse, or that can't be read at all, counts as held ("unreadable"), whatever its age.
type LockRead = { kind: "gone" } | { kind: "unreadable" } | { kind: "held"; mtimeMs: number; token: string } | { kind: "legacy"; mtimeMs: number };
function readLock(f: string): LockRead {
  let mtimeMs: number;
  try { mtimeMs = statSync(f).mtimeMs; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable" }; }
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable" }; }
  if (text.trim() === "") return { kind: "legacy", mtimeMs };
  let x: any;
  try { x = JSON.parse(text); } catch { return { kind: "unreadable" }; }
  if (x && typeof x === "object" && !Array.isArray(x) && typeof x.token === "string" && x.token) return { kind: "held", mtimeMs, token: x.token };
  return x && typeof x === "object" && !Array.isArray(x) && !("token" in x) ? { kind: "legacy", mtimeMs } : { kind: "unreadable" };
}
export type LockMiss = { miss: "held" | "unreadable" | "error" };
export function takeLock(f: string, waitMs: number, o: { staleMs?: number } = {}): HeldLock | LockMiss {
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  const until = Date.now() + waitMs;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let last: "held" | "unreadable" = "held";
  for (;;) {
    try {
      const fd = openSync(f, "wx");
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })); } finally { closeSync(fd); }
      return { file: f, token, since: Date.now() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { miss: "error" };
    }
    const r = readLock(f);
    if (r.kind === "gone") continue;
    last = r.kind === "held" ? "held" : "unreadable";
    if ((r.kind === "held" || r.kind === "legacy") && Date.now() - r.mtimeMs > staleMs) {
      // The takeover: rename the stale lock to a name of this taker's own. Only one rename can succeed.
      const aside = `${f}.stale-${token}`;
      let moved = false;
      try { renameSync(f, aside); moved = true; } catch { moved = false; }
      if (moved) {
        const caught = readLock(aside);
        const same = r.kind === "held" ? caught.kind === "held" && caught.token === r.token : caught.kind === "legacy" && caught.mtimeMs === r.mtimeMs;
        if (same && Date.now() - (caught as { mtimeMs: number }).mtimeMs > staleMs) {
          if (r.kind === "legacy") console.error(`ship gate: WARNING: took over a legacy watch lock with no holder token (${f}), last changed ${new Date(r.mtimeMs).toISOString()}, older than the ${Math.round(staleMs / 1000)} second stale bound: left by an earlier version of the watch`);
          rmSync(aside, { force: true });
          continue;
        }
        // A fresh lock made between the stat and the rename: put it back (never over a newer one), and back off.
        try { linkSync(aside, f); } catch { /* a newer lock stands: that holder goes on */ }
        rmSync(aside, { force: true });
      }
    }
    if (Date.now() >= until) return { miss: last };
    pause(50);
  }
}
const ownsLock = (l: HeldLock) => { const r = readLock(l.file); return r.kind === "held" && r.token === l.token; };
// The heartbeat: the lock's time refreshed, only while it is still this holder's own.
export function beat(l: HeldLock): boolean {
  if (!ownsLock(l)) return false;
  try { const t = new Date(); utimesSync(l.file, t, t); return true; } catch { return false; }
}
export function letGo(l: HeldLock): void { if (ownsLock(l)) rmSync(l.file, { force: true }); }
export const lockNotice = (f: string) => `the pull request's watch lock (${f}) couldn't be taken or kept in time (another watch held it, or it couldn't be read): nothing was accepted; run the watch again once no other watch of this pull request is running, and if this repeats with no watch running, remove the lock with: rm -f ${f}`;
// An acceptance already kept for this very sha and pull request, not superseded: a second write for it is a no-op.
const keptAcceptance = (out: string, pr: number, head: string): boolean => {
  try { const a = watchAccepted(readFileSync(out, "utf8")); return !!a && a.pr === pr && a.head === head; } catch { return false; }
};
export function keepWatch(dir: string, line: WatchLine, out: string, o: { waitMs?: number; staleMs?: number; beforeWrite?: () => void; atWrite?: () => void } = {}): WatchLine {
  let kept = line;
  mkdirSync(dirname(out), { recursive: true });
  const write = (l: WatchLine) => { writeFileSync(`${out}.tmp`, JSON.stringify(l, null, 2) + "\n"); renameSync(`${out}.tmp`, out); };
  const lockPath = line.pr !== null && line.accepted_head ? lockFile(dir, line.pr) : null;
  if (lockPath) mkdirSync(dir, { recursive: true });
  const got = lockPath ? takeLock(lockPath, o.waitMs ?? 10_000, { staleMs: o.staleMs }) : null;
  const held = got && "token" in got ? got : null;
  const unavailable = (): WatchLine => ({ ...line, accepted_head: null, passed: false, failure: "lock_unavailable", failure_why: lockNotice(lockPath!) });
  if (lockPath && !held) {
    // Another watch's readable lock held to the deadline: that watch is being kept (live_acceptance, as before);
    // a lock that couldn't be read, or made: lock_unavailable.
    kept = got && "miss" in got && got.miss === "held" ? { ...line, accepted_head: null, passed: false, failure: "live_acceptance",
      failure_why: `another watch of this pull request was being kept at the same moment (its lock, ${lockPath}, stayed held): run the watch again once it is done` } : unavailable();
    console.error(`ship gate: ${kept.failure_why}`);
    write(kept);
    return kept;
  }
  try {
    if (line.pr !== null && line.accepted_head) {
      const other = otherLive(dir, line.pr, line.accepted_head);
      if (other.length) kept = { ...line, accepted_head: null, passed: false, failure: "live_acceptance", failure_why: liveWhy(other) };
    }
    if (held) beat(held);
    o.beforeWrite?.();
    // Still this watch's own lock, refreshed, and the section within its bound: otherwise nothing is accepted.
    if (held && kept.accepted_head && (Date.now() - held.since > CRITICAL_MAX_MS || !beat(held))) {
      kept = unavailable();
      console.error(`ship gate: ${kept.failure_why}`);
    }
    if (!held || !kept.accepted_head || kept.pr === null) { write(kept); return kept; }
    // Twenty-fourth round, the fenced write. Just before the acceptance is written: the lock re-read and its token
    // required to be this holder's own; the sha-bound gate check again (an acceptance already kept for this very sha
    // makes this write a no-op; a live acceptance of another head refuses it). Then, after the write, the token is read
    // once more: a holder suspended past the stale bound between that check and its write (and so taken over) finds the
    // lock no longer its own and takes its acceptance back. A contender that took over checked the live acceptances
    // after its takeover, so whichever order the two writes come in, at most one acceptance stays.
    if (!ownsLock(held)) { kept = unavailable(); console.error(`ship gate: ${kept.failure_why}`); write(kept); return kept; }
    if (keptAcceptance(out, kept.pr, kept.accepted_head)) return JSON.parse(readFileSync(out, "utf8")) as WatchLine;
    const other = otherLive(dir, kept.pr, kept.accepted_head);
    if (other.length) { kept = { ...line, accepted_head: null, passed: false, failure: "live_acceptance", failure_why: liveWhy(other) }; write(kept); return kept; }
    o.atWrite?.();
    write(kept);
    if (!ownsLock(held)) {
      kept = unavailable();
      console.error(`ship gate: the lock was taken over while this acceptance was being written: it is taken back. ${kept.failure_why}`);
      write(kept);
    }
  } finally { if (held) letGo(held); }
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
