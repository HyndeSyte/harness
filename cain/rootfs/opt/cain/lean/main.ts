// Cain's lean session (Cain 0.20.0): the commands checkin.sh and the run script call (root's, but for
// usage, which reads his transcripts as him). The deciding is in lean/core.ts. Every command fails
// toward Cain: a failure, or an answer the caller can't read, makes the caller do what it did before
// this release (type the line, nudge about jobs), never drop anything.
//   compact-pct                       the compaction threshold, as Claude Code takes it (session.sh)
//   route <key>                       a relayed line's text on stdin: prints "type" and the text to type
//                                     on the next line, "handled" (written to the record and kept for the
//                                     digest: no turn), or "long" (for the worker: summarise)
//   summarise <key> <file>            a long line on stdin, its copy in his folder at <file>: the worker
//                                     classifies it; prints "type" and the summary turn, or "handled"
//   jobs <dir>                        prints "ok", then "wake" and the turn when a job changed state or
//                                     stalled (kept pending until jobs-done)
//   jobs-done                         the jobs turn went in: what it said is kept as seen
//   digest <HHMM> <day>               when due and anything was handled: "<id> <upto>" and the turn
//   digest-done <id> <upto>           the digest went in
//   missed-in                         his marks ("<digest id> <numbers>" lines, on stdin), kept for the week
//   counts                            "<handled> <missed>" over the last 7 days
//   usage <day> <projects dir>        the day's usage line, from his transcripts (run as him)
//   usage-due                         prints yesterday's day once a day, from 00:10 (root)
//   fresh-due <screen> <up since>     exit 0 and "due" when the quiet-hour fresh start is due (kept as
//                                     done), else exit 1 and why not
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checksOf, classify, compactPct, digestText, DIGEST_AT, FRESH_LINE, freshWhyNot, type Handled, jobsLook, jobsTurn, type JobSeen,
  localParts, parseJob, parseWorker, type PullState, receiptRow, RELAY_PREFIX, summaryLine, usageLine, usageOf, workerArgs,
  workerPrompt, WORKER_TIMEOUT_S,
} from "./core";

const env = process.env;
const TZ = env.CHECKIN_TZ ?? env.TZ ?? "America/New_York";
const D = env.LEAN_DIR ?? "/data/lean";
const RECORD_DIR = env.RECORD_DIR ?? "/data/record";
const RECORD_QUEUE = env.RECORD_QUEUE ?? "/data/record-queue";
const REPO = "HyndeSyte/harness";
const now = () => Number(env.LEAN_NOW ?? Math.floor(Date.now() / 1000));
const log = (m: string) => console.error(`[cain] lean: ${m}`);

function read(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
function writeWhole(p: string, s: string): void {
  const t = `${p}.${process.pid}.tmp`;
  writeFileSync(t, s, { mode: 0o600 });
  renameSync(t, p);
}
function json<T>(p: string, d: T): T { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } }
const stdin = async () => await new Response(Bun.stdin.stream()).text();
const dir = () => { mkdirSync(join(D, "route"), { recursive: true, mode: 0o700 }); return D; };

// -- relays ---------------------------------------------------------------------------------------------
const CACHE_S = 3600;
const cacheOf = (key: string) => join(dir(), "route", key.replace(/[^0-9]/g, "").slice(0, 20) || "0");
function cached(key: string): string | null {
  const p = cacheOf(key);
  try { if (now() - Math.floor(statSync(p).mtimeMs / 1000) > CACHE_S) return null; } catch { return null; }
  return read(p);
}
function keep(key: string, out: string): void {
  writeWhole(cacheOf(key), out);
  // Old ones go: a line seen again after an hour is classed again.
  for (const n of readdirSync(join(D, "route"))) {
    try { if (now() - Math.floor(statSync(join(D, "route", n)).mtimeMs / 1000) > 86400) rmSync(join(D, "route", n)); } catch { /* next time */ }
  }
}
function handled(h: Handled): void { appendFileSync(join(dir(), "handled.jsonl"), JSON.stringify(h) + "\n", { mode: 0o600 }); }
// A receipt, written to the record through the record keeper (Cain's own queue: it is his record), as
// one line appended to the day's receipts file.
function recordReceipt(row: string, at: number): void {
  const day = localParts(at, TZ).day;
  mkdirSync(RECORD_QUEUE, { recursive: true });
  const id = `cain-receipt-${day}-${at}-${Math.random().toString(16).slice(2, 8)}`;
  const req = { id, from: "cain", kind: "change", summary: "A receipt of a relayed line, written by the App (no turn of Cain's)",
    ops: [{ op: "append", path: `state/receipts/${day}.md`, text: row }] };
  const name = `${new Date(at * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${id}.json`;
  writeFileSync(join(RECORD_QUEUE, `.${name}`), JSON.stringify(req), { flag: "wx", mode: 0o644 });
  renameSync(join(RECORD_QUEUE, `.${name}`), join(RECORD_QUEUE, name));
}
async function route(key: string): Promise<string> {
  const hit = cached(key);
  if (hit !== null) return hit;
  const text = await stdin();
  const c = classify(text);
  let out: string;
  if (c.kind === "card") out = `type\n${c.card ? RELAY_PREFIX + c.card : RELAY_PREFIX + text}`;
  else if (c.kind === "receipt" && c.receipt) {
    const at = now();
    recordReceipt(receiptRow(c.receipt, text, at, TZ), at);
    handled({ at, kind: "receipt", item: c.receipt.item, line: text });
    out = "handled";
  } else if (c.kind === "long") out = "long";
  else out = `type\n${RELAY_PREFIX}${text}`;
  keep(key, out);
  return out;
}

// The worker: a fresh, tool-less Claude Code run on the pinned cheaper model, as his own user (his
// sign-in), with a small brief. Its answer is read strictly; any failure is the caller's fallback.
function rowOf(item: string | null): string | null {
  if (!item) return null;
  const pending = read(join(RECORD_DIR, "state/PENDING.md")) ?? "";
  const row = pending.split("\n").find((l) => new RegExp(`^\\|\\s*${item}\\s*\\|`).test(l));
  return row ? row.trim().slice(0, 600) : null;
}
function notesOf(item: string | null): string[] {
  if (!item) return [];
  const f = read(join(RECORD_DIR, `state/notes/${item}.md`)) ?? "";
  return f.split("\n").filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}T/.test(l)).slice(-3).map((l) => l.trim().slice(0, 300));
}
export function workerCommand(): string[] {
  const as = env.LEAN_WORKER ? [env.LEAN_WORKER] : env.CAIN_AS ? [env.CAIN_AS] : ["env", "HOME=/data"];
  return [...as, "timeout", "-k", "5", String(WORKER_TIMEOUT_S), ...workerArgs()];
}
async function runWorker(prompt: string): Promise<string | null> {
  try {
    const p = Bun.spawn(workerCommand(), { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(9), (WORKER_TIMEOUT_S + 10) * 1000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch { return null; }
}
async function summarise(key: string, file: string): Promise<string | null> {
  const hit = cached(`${key}`);
  if (hit !== null && hit !== "long") return hit;
  const text = await stdin();
  const item = /\b(P\d{1,4})\b/.exec(text)?.[1] ?? null;
  const said = await runWorker(workerPrompt({ relay: text, row: rowOf(item), notes: notesOf(item) }));
  const v = said === null ? null : parseWorker(said);
  if (!v) { log(said === null ? "the worker failed: the line goes to Cain as before" : "the worker's answer was malformed: the line goes to Cain as before"); return null; }
  let out: string;
  if (v.verdict === "no_action") {
    handled({ at: now(), kind: "no-action", item, line: `${v.reason} (the line: ${text.slice(0, 200)})` });
    out = "handled";
  } else {
    const s = summaryLine(v, file);
    if (!s) { log("the worker's summary can't be typed: the line goes to Cain as before"); return null; }
    out = `type\n${s}`;
  }
  keep(key, out);
  return out;
}

// -- cloud jobs -------------------------------------------------------------------------------------
const JOBS_EVERY_S = Number(env.LEAN_JOBS_EVERY_S ?? 600);   // GitHub without a key: 60 asks an hour, shared with the link
async function gh(path: string): Promise<any | null> {
  const fx = env.LEAN_GITHUB;                // tests: a JSON file of answers by path
  if (fx) { const all = json<Record<string, any>>(fx, {}); return path in all ? all[path] : null; }
  try {
    const r = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { accept: "application/vnd.github+json", "user-agent": "cain-lean", "x-github-api-version": "2022-11-28" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function pullOf(branch: string): Promise<PullState> {
  const owner = REPO.split("/")[0];
  const list = await gh(`/repos/${REPO}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=5`);
  if (!Array.isArray(list)) return { state: "unknown" };
  if (!list.length) return { state: "none" };
  const pr = [...list].sort((a, b) => Number(b.number) - Number(a.number))[0];
  const number = Number(pr.number);
  if (pr.merged_at) return { state: "merged", number };
  if (pr.state === "closed") return { state: "closed", number };
  const head = String(pr.head?.sha ?? "");
  const runs = await gh(`/repos/${REPO}/commits/${head}/check-runs?per_page=100`);
  if (!runs || !Array.isArray(runs.check_runs)) return { state: "unknown" };
  return { state: "open", number, head, checks: checksOf(runs.check_runs.map((r: any) => ({ name: String(r.name), status: String(r.status), conclusion: r.conclusion ?? null }))) };
}
async function jobs(jdir: string): Promise<string> {
  const pend = join(dir(), "jobs.pending.json");
  const p = json<{ turn: string; next: Record<string, JobSeen> } | null>(pend, null);
  if (p?.turn) return `ok\nwake\n${p.turn}`;           // not yet known in: offered again, never lost
  const last = Number(read(join(D, "jobs.looked")) ?? 0);
  if (now() - last < JOBS_EVERY_S) return "ok";
  writeWhole(join(D, "jobs.looked"), String(now()));
  const files = existsSync(jdir) ? readdirSync(jdir).filter((n) => !n.startsWith(".")) : [];
  // His folder too (root:cain): only a plain file is read, never through a link of his, and only its first line.
  const parsed = files.map((n) => {
    try {
      const f = join(jdir, n), st = lstatSync(f);
      if (!st.isFile() || st.size > 4096) return null;
      return parseJob(n, readFileSync(f, "utf8"), Math.floor(st.mtimeMs / 1000));
    } catch { return null; }
  });
  const list = parsed.filter((j): j is NonNullable<typeof j> => j !== null);
  const pulls: Record<string, PullState> = {};
  for (const j of list) if (j.kind === "build" && j.branch) pulls[j.name] = await pullOf(j.branch);
  const seenPath = join(D, "jobs.json");
  const seen = json<Record<string, JobSeen>>(seenPath, {});
  const { wakes, next } = jobsLook(list, pulls, seen, now());
  if (!wakes.length) { writeWhole(seenPath, JSON.stringify(next)); return "ok"; }
  const turn = jobsTurn(wakes, jdir);
  writeWhole(pend, JSON.stringify({ turn, next }));
  return `ok\nwake\n${turn}`;
}
function jobsDone(): void {
  const pend = join(dir(), "jobs.pending.json");
  const p = json<{ turn: string; next: Record<string, JobSeen> } | null>(pend, null);
  if (!p) return;
  writeWhole(join(D, "jobs.json"), JSON.stringify(p.next));
  rmSync(pend, { force: true });
}

// -- the digest and the week's measure ---------------------------------------------------------------
function handledRows(): Handled[] {
  return (read(join(D, "handled.jsonl")) ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Handled; } catch { return null; } })
    .filter((h): h is Handled => !!h && typeof h.at === "number" && typeof h.line === "string");
}
function digest(hm: string, day: string): string {
  if (!/^\d{4}$/.test(hm) || hm < DIGEST_AT) return "";
  const st = json<{ day?: string; upto?: number }>(join(D, "digest.json"), {});
  if (st.day === day) return "";
  const rows = handledRows();
  const from = Math.min(st.upto ?? 0, rows.length);
  const fresh = rows.slice(from);
  if (!fresh.length) return "";
  return `${day} ${rows.length}\n${digestText(day, fresh, TZ)}`;
}
function digestDone(id: string, upto: number): void {
  writeWhole(join(dir(), "digest.json"), JSON.stringify({ day: id, upto, at: now() }));
}
async function missedIn(): Promise<void> {
  for (const l of (await stdin()).split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2})((?: \d{1,3}){1,50})\s*$/.exec(l.trim());
    if (!m) { if (l.trim()) log(`a mark of his couldn't be read: ${l.trim().slice(0, 80)}`); continue; }
    for (const n of m[2].trim().split(" ")) appendFileSync(join(dir(), "missed.jsonl"), JSON.stringify({ at: now(), digest: m[1], n: Number(n) }) + "\n");
    log(`Cain marked ${m[2].trim().split(" ").length} line(s) of the ${m[1]} digest as needing him`);
  }
}
function counts(): string {
  const since = now() - 7 * 86400;
  const h = handledRows().filter((r) => r.at >= since).length;
  const m = (read(join(D, "missed.jsonl")) ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.at >= since).length;
  return `${h} ${m}`;
}

// -- usage ----------------------------------------------------------------------------------------------
function jsonlFiles(d: string): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) {
      const f = join(p, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (st.isFile() && n.endsWith(".jsonl") && now() - st.mtimeMs / 1000 < 3 * 86400) out.push(f);
    }
  };
  walk(d, 0);
  return out;
}
function usage(day: string, projects: string, extra: { handled?: number; missed?: number }): string {
  const session = usageOf([], day, TZ), worker = usageOf([], day, TZ);
  for (const f of jsonlFiles(projects)) {
    const lines = (read(f) ?? "").split("\n");
    // His session runs in /data/work (its folder "-data-work"); the worker in his home ("-data-cain").
    usageOf(lines, day, TZ, f.includes("-data-work") || !f.includes("-data-cain") ? session : worker);
  }
  return usageLine(day, session, worker, extra);
}
function usageDue(): string {
  const t = localParts(now(), TZ);
  if (t.hour === 0 && t.minute < 10) return "";
  const y = localParts(now() - 86400, TZ).day;
  const p = join(dir(), "usage.last");
  if ((read(p) ?? "").trim() === y) return "";
  writeWhole(p, y);
  return y;
}

// -- the quiet-hour fresh start ------------------------------------------------------------------------
function freshDue(screen: string, upSince: number): { due: boolean; why: string } {
  const p = join(dir(), "fresh.last");
  const heard = Number((read(env.PROBE_HEARD ?? "/run/cain/probe/heard") ?? "").trim()) || null;
  const jdir = env.JOBS_DIR ?? "/data/jobs";
  const jobsN = existsSync(jdir) ? readdirSync(jdir).filter((n) => !n.startsWith(".")).length : 0;
  const q = env.RELAY_QUEUE ?? "/data/relay.queue";
  const queued = [q, `${q}.work`].some((f) => (read(f) ?? "").trim() !== "");
  const why = freshWhyNot({ now: now(), tz: TZ, lastDay: (read(p) ?? "").trim() || null, heardAt: heard, jobs: jobsN,
    tryPending: existsSync(env.CHECKIN_TRY ?? "/data/checkin.try"), queued, screen, upSince });
  if (why) return { due: false, why };
  writeWhole(p, localParts(now(), TZ).day);
  // His first line after the start: where to read up. In the queue now, typed once the new session passed its check.
  appendFileSync(q, JSON.stringify({ text: FRESH_LINE }) + "\n");
  return { due: true, why: "due" };
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "compact-pct": console.log(compactPct()); break;
      case "route": console.log(await route(a ?? "0")); break;
      case "summarise": { const o = await summarise(a ?? "0", b ?? ""); if (o === null) process.exit(1); console.log(o); break; }
      case "jobs": console.log(await jobs(a ?? env.JOBS_DIR ?? "/data/jobs")); break;
      case "jobs-done": jobsDone(); break;
      case "digest": { const o = digest(a ?? "", b ?? ""); if (o) console.log(o); break; }
      case "digest-done": digestDone(a ?? "", Number(b ?? 0)); break;
      case "missed-in": await missedIn(); break;
      case "counts": console.log(counts()); break;
      case "usage": {
        const [h, m] = (process.argv[5] ?? "").split(" ").map(Number);
        console.log(usage(a ?? "", b ?? "", Number.isFinite(h) ? { handled: h, missed: Number.isFinite(m) ? m : 0 } : {}));
        break;
      }
      case "usage-due": { const o = usageDue(); if (o) console.log(o); break; }
      case "fresh-due": { const r = freshDue(a ?? "", Number(b ?? 0)); console.log(r.why); process.exit(r.due ? 0 : 1); }
      default: console.error("usage: lean/main.ts compact-pct | route <key> | summarise <key> <file> | jobs <dir> | jobs-done | digest <HHMM> <day> | digest-done <id> <upto> | missed-in | counts | usage <day> <dir> [\"<handled> <missed>\"] | usage-due | fresh-due <screen> <up since>"); process.exit(2);
    }
  } catch (e) { log(`${cmd} failed: ${String(e).slice(0, 200)}`); process.exit(1); }
}
