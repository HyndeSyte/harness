// Cain's lean session (Cain 0.20.0, third round): the commands checkin.sh calls. The deciding is in
// lean/core.ts. Every command fails toward Cain: a failure, or an answer the caller can't read, makes
// checkin.sh type the old "cloud job check" nudge, as before this release.
//   jobs <dir>        reads each job file and its job's state (root's). Prints "none" (no change: no
//                     line), or "wake <id>" and, on the next line, the one line to type for him. What it
//                     saw is kept as seen only by jobs-seen, once that line is in.
//   jobs-seen <id>    the line of that id went in (checkin.sh finish): what it saw is kept as seen
//   usage-due         prints yesterday's day once a day, from 00:10 (root)
//   usage <day> <projects dir>   the day's usage line, from his transcripts (run as him)
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksOf, emptyUsage, JOB_MAX_BYTES, type JobFile, type JobProblem, jobsLook, jobsTurn, type JobSeen, localDay, localHM, LOOK_EVERY_S, parseJob, type PullState, usageLine, usageOf } from "./core";

const env = process.env;
const TZ = env.CHECKIN_TZ ?? env.TZ ?? "America/New_York";
const D = env.LEAN_DIR ?? "/data/lean";
const REPO = "HyndeSyte/harness";
const now = () => Number(env.LEAN_NOW ?? Math.floor(Date.now() / 1000));
const log = (m: string) => console.error(`[cain] lean: ${m}`);
// He runs as his own user the new way (the run script sets CAIN_AS), as root the old way.
const OWN = !!env.CAIN_AS;

function read(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
function writeWhole(p: string, s: string): void {
  mkdirSync(D, { recursive: true, mode: 0o700 });
  const t = `${p}.${process.pid}.tmp`;
  writeFileSync(t, s, { mode: 0o600 });
  renameSync(t, p);
}
function json<T>(p: string, d: T): T { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } }

// -- the job's state, on GitHub ---------------------------------------------------------------------
// Read without a key (60 asks an hour, shared with the link): two asks a Build job each 15 minutes.
async function gh(path: string): Promise<any | null> {
  const fx = env.LEAN_GITHUB;                // tests: a JSON file of answers by path
  if (fx) { const all = json<Record<string, any>>(fx, {}); return path in all ? all[path] : null; }
  try {
    const r = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { accept: "application/vnd.github+json", "user-agent": "cain-lean", "x-github-api-version": "2022-11-28" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// Every answer code doesn't know is "unknown", which wakes him: never taken as no change.
async function pullOf(branch: string): Promise<PullState> {
  const owner = REPO.split("/")[0];
  const list = await gh(`/repos/${REPO}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=5`);
  if (!Array.isArray(list)) return { state: "unknown" };
  if (!list.length) return { state: "none" };
  const pr = [...list].sort((a, b) => Number(b?.number) - Number(a?.number))[0];
  const number = Number(pr?.number);
  if (!Number.isInteger(number) || number <= 0) return { state: "unknown" };
  if (pr.merged_at) return { state: "merged", number };
  if (pr.state === "closed") return { state: "closed", number };
  if (pr.state !== "open") return { state: "unknown" };
  const head = String(pr.head?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(head)) return { state: "unknown" };
  const runs = await gh(`/repos/${REPO}/commits/${head}/check-runs?per_page=100`);
  if (!runs || !Array.isArray(runs.check_runs)) return { state: "unknown" };
  return { state: "open", number, head, checks: checksOf(runs.check_runs.map((r: any) => ({ name: String(r?.name), status: String(r?.status), conclusion: r?.conclusion ?? null }))) };
}

// -- the root reader of his job files -----------------------------------------------------------------
// The folder is opened once (never through a link) and held: each file is opened relative to that held
// descriptor (through /proc/self/fd/<n>, Linux's openat), never by its path again, with O_NOFOLLOW (a
// link is refused) and O_NONBLOCK (a FIFO can't hang it). The descriptor's own fstat must show a
// regular file owned by his user, with one link only and at most 4 KB, and that same descriptor is what
// is read. After the look the folder's path must still name the folder held, or the whole look is a
// refusal. Every refusal is a line to him naming the file, never a silent skip.
const JOB_UID = Number(env.LEAN_JOB_UID ?? (OWN ? 1000 : 0));
export function readJobAt(dirFd: number, name: string): { job: JobFile } | { problem: JobProblem } {
  const bad = (why: string) => ({ problem: { name, why } });
  if (!name || name.includes("/") || name === "." || name === "..") return bad("its name isn't one code reads");
  let fd: number;
  try { fd = openSync(`/proc/self/fd/${dirFd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e: any) { return bad(e?.code === "ELOOP" ? "it is a link" : "it can't be opened"); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return bad("it isn't a plain file");
    if (st.nlink !== 1) return bad("it has more than one name");
    if (st.uid !== JOB_UID) return bad("it isn't his");
    if (st.size > JOB_MAX_BYTES) return bad("it is over 4 KB");
    const buf = Buffer.alloc(JOB_MAX_BYTES + 1);
    let got = 0, n = 0;
    while (got < buf.length && (n = readSync(fd, buf, got, buf.length - got, null)) > 0) got += n;
    if (got > JOB_MAX_BYTES) return bad("it is over 4 KB");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, got)); } catch { return bad("it isn't text"); }
    const job = parseJob(name, text, Math.floor(st.mtimeMs / 1000));
    return job ? { job } : bad("its line isn't one code knows");
  } catch { return bad("it can't be read"); }
  finally { closeSync(fd); }
}
export function readJobs(jdir: string, afterOpen?: () => void): { jobs: JobFile[]; problems: JobProblem[] } {
  const folder = (why: string) => ({ jobs: [], problems: [{ name: ".", why }] });
  let dfd: number;
  try { dfd = openSync(jdir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (e: any) { return folder(e?.code === "ELOOP" || e?.code === "ENOTDIR" ? "it is a link or not a folder" : "it can't be opened"); }
  try {
    const held = fstatSync(dfd);
    if (!held.isDirectory()) return folder("it isn't a folder");
    afterOpen?.();                                         // tests: the folder swapped while it is read
    let names: string[];
    try { names = readdirSync(`/proc/self/fd/${dfd}`); } catch { return folder("it can't be listed"); }
    const jobs: JobFile[] = [], problems: JobProblem[] = [];
    for (const n of names.filter((n) => !n.startsWith(".")).sort()) {
      const r = readJobAt(dfd, n);
      if ("job" in r) jobs.push(r.job); else problems.push(r.problem);
    }
    let still: ReturnType<typeof lstatSync> | null = null;
    try { still = lstatSync(jdir); } catch { /* gone: refused below */ }
    if (!still || !still.isDirectory() || still.ino !== held.ino || still.dev !== held.dev) return folder("it was swapped for another while code read it");
    return { jobs, problems };
  } finally { closeSync(dfd); }
}

// -- one look ---------------------------------------------------------------------------------------------
interface Pending { id: string; turn: string; next: Record<string, JobSeen>; at: number }
const PEND = () => join(D, "jobs.pending.json");
const SEEN = () => join(D, "jobs.json");
async function jobs(jdir: string): Promise<string> {
  // A line not yet in (his screen wasn't ready) is offered again as it was, for one look's time: no
  // new look meanwhile, so nothing is read twice or queued twice.
  const p = json<Pending | null>(PEND(), null);
  if (p?.id && typeof p.turn === "string" && now() - p.at >= 0 && now() - p.at < LOOK_EVERY_S) return `wake ${p.id}\n${p.turn}`;
  const { jobs: list, problems } = readJobs(jdir);
  const pulls: Record<string, PullState> = {};
  for (const j of list) if (j.kind === "build" && j.branch) pulls[j.name] = await pullOf(j.branch);
  const seen = json<Record<string, JobSeen>>(SEEN(), {});
  const { wakes, next } = jobsLook(list, pulls, seen, now(), problems);
  if (!wakes.length) {
    writeWhole(SEEN(), JSON.stringify(next));
    rmSync(PEND(), { force: true });
    return "none";
  }
  const id = `${now()}-${Math.random().toString(16).slice(2, 8)}`;
  const turn = jobsTurn(wakes, jdir);
  writeWhole(PEND(), JSON.stringify({ id, turn, next, at: now() }));
  return `wake ${id}\n${turn}`;
}
function jobsSeen(id: string): void {
  const p = json<Pending | null>(PEND(), null);
  if (!p || p.id !== id) { log(`no look ${id} waiting to be kept: nothing changed`); return; }
  writeWhole(SEEN(), JSON.stringify(p.next));
  rmSync(PEND(), { force: true });
}

// -- usage ----------------------------------------------------------------------------------------------
function jsonlFiles(d: string, days = 3): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) {
      const f = join(p, n);
      let st; try { st = lstatSync(f); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (st.isFile() && n.endsWith(".jsonl") && now() - st.mtimeMs / 1000 < days * 86400) out.push(f);
    }
  };
  walk(d, 0);
  return out;
}
// His session runs in /data/work (its transcripts' folder "-data-work").
function usage(day: string, projects: string): string {
  const u = emptyUsage();
  for (const f of jsonlFiles(projects)) if (f.includes("-data-work")) usageOf((read(f) ?? "").split("\n"), day, TZ, u);
  return usageLine(day, u);
}
function usageDue(): string {
  if (localHM(now(), TZ) < 10) return "";
  const y = localDay(now() - 86400, TZ);
  const p = join(D, "usage.last");
  if ((read(p) ?? "").trim() === y) return "";
  writeWhole(p, y);
  return y;
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "jobs": console.log(await jobs(a ?? env.JOBS_DIR ?? "/data/jobs")); break;
      case "jobs-seen": jobsSeen(a ?? ""); break;
      case "usage-due": { const o = usageDue(); if (o) console.log(o); break; }
      case "usage": console.log(usage(a ?? "", b ?? "")); break;
      default: console.error("usage: lean/main.ts jobs <dir> | jobs-seen <id> | usage-due | usage <day> <projects dir>"); process.exit(2);
    }
  } catch (e) { log(`${cmd} failed: ${String(e).slice(0, 200)}`); process.exit(1); }
}
