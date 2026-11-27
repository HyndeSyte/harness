// Cain's lean session (Cain 0.20.0): the commands checkin.sh, watch.sh and the run script call (root's,
// but for usage and context, which read his transcripts as him). The deciding is in lean/core.ts. Every
// command fails toward Cain: a failure, or an answer the caller can't read, makes the caller type what it
// did before this release, never drop anything.
//   compact-pct                       Claude Code's own backstop for compaction, as it takes it (session.sh)
//   route <key>                       a relayed line's text on stdin: prints "type" and the text to type
//                                     on the next line, "handled" (an allowlisted receipt, kept first: no
//                                     turn), or "long" (for the worker: summarise)
//   summarise <key> <file>            a long line on stdin, its copy in his folder at <file>: the worker's
//                                     summary as "type" and the turn; exit 1 when it has none
//   jobs <dir>                        reads the jobs and GitHub; a line for him goes into the queue
//   delivered <tag>                   a line of the App's own (its queue record's "lean" tag) went in
//   digest <HHMM> <day>               when due and anything was matched: the digest goes into the queue
//   missed-in                         his marks ("<digest id> <numbers>" lines, on stdin), kept for the week
//   counts                            "<handled> <missed>" over the last 7 days
//   usage <day> <projects dir>        the day's usage line, from his transcripts (run as him)
//   usage-due                         prints yesterday's day once a day, from 00:10 (root)
//   fresh-due <screen> <up since>     exit 0 and "due" when the quiet-hour fresh start is due (his handover
//                                     asked for first, and in the record), else exit 1 and why not
//   context <projects dir>            "<tokens> <compacted since: 0 or 1>" from his newest transcript (as him)
//   compact-due <tokens> <0|1> <screen>  exit 0 when the App should type /compact now
//   compact-done                      the App typed /compact: kept, for its limits
//   compact-sim <projects dir> <threshold> ...  how often each threshold would have compacted last week
//   shadow                            the shadow week's state, in words
//   card-wait                         exit 0 when a card with buttons waits to be typed (watch.sh)
import {
  appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Call, CARD_WINDOW_S, checksOf, classify, compactPct, compactWhyNot, digestText, DIGEST_AT, FRESH_LINE, freshWhyNot, type Handled,
  handoverConfirmed, handoverId, handoverLine, HANDOVER_WAIT_S, inShadow, JOB_MAX_BYTES, type JobFile, type JobProblem, jobsLook, jobsTurn,
  type JobSeen, localParts, parseJob, parseWorker, type PullState, receiptRow, RELAY_PREFIX, shadowSetting, simulate, summaryLine,
  usageLine, usageOf, workerCommand, WORKER_HOME, workerPrompt, WORKER_TIMEOUT_S,
} from "./core";

const env = process.env;
const TZ = env.CHECKIN_TZ ?? env.TZ ?? "America/New_York";
const D = env.LEAN_DIR ?? "/data/lean";
const RECORD_DIR = env.RECORD_DIR ?? "/data/record";
const RECORD_QUEUE = env.RECORD_QUEUE ?? "/data/record-queue";
const RECORD_OUTCOMES = env.RECORD_OUTCOMES ?? "/data/record-outcomes";
const QUEUE = env.RELAY_QUEUE ?? "/data/relay.queue";
const TRY = env.CHECKIN_TRY ?? "/data/checkin.try";
const REPO = "HyndeSyte/harness";
const now = () => Number(env.LEAN_NOW ?? Math.floor(Date.now() / 1000));
const log = (m: string) => console.error(`[cain] lean: ${m}`);
// He runs as his own user the new way (the run script sets CAIN_AS), as root the old way.
const OWN = !!env.CAIN_AS;

function read(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
function writeWhole(p: string, s: string): void {
  const t = `${p}.${process.pid}.tmp`;
  writeFileSync(t, s, { mode: 0o600 });
  renameSync(t, p);
}
// Appended and on disk before it returns, or it throws.
function appendSynced(p: string, line: string): void {
  const fd = openSync(p, "a", 0o600);
  try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
}
function json<T>(p: string, d: T): T { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } }
const num = (p: string): number | null => { const n = Number((read(p) ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : null; };
const stdin = async () => await new Response(Bun.stdin.stream()).text();
const dir = () => { mkdirSync(join(D, "route"), { recursive: true, mode: 0o700 }); return D; };

// -- the one queue ------------------------------------------------------------------------------------
// Every line the App types goes through the relay queue (item 4): relays, the job lines, the digest, the
// handover ask and the fresh start's first line, one record a line, cards put first by checkin.sh. A line
// of the App's own carries a "lean" tag, and only once it is known in (checkin.sh finish, delivered) does
// what it stands for count as done.
const QUEUE_FILES = () => [QUEUE, `${QUEUE}.work`, `${QUEUE}.take`];
function enqueue(text: string, tag: string): void { appendSynced(QUEUE, JSON.stringify({ text, lean: tag }) + "\n"); }
function inQueue(tag: string): boolean {
  const want = `"lean":${JSON.stringify(tag)}`;
  if (QUEUE_FILES().some((f) => (read(f) ?? "").includes(want))) return true;
  return (read(TRY) ?? "").split("\n").includes(`fin ${tag}`);
}
const CARD_WORDS = ["has a card for Dane (card ", "goes out by itself in about 2 minutes"];
function cardWaiting(): boolean {
  const lines = QUEUE_FILES().flatMap((f) => (read(f) ?? "").split("\n"));
  const t = read(TRY);
  if (t !== null) lines.push(t);
  return lines.some((l) => CARD_WORDS.every((w) => l.includes(w)));
}
function quiet(screen: string) {
  const cardLast = num(join(D, "card.last"));
  return {
    now: now(), screen,
    cardWindow: cardWaiting() || (cardLast !== null && now() - cardLast < CARD_WINDOW_S),
    queued: QUEUE_FILES().some((f) => (read(f) ?? "").trim() !== ""),
    tryPending: existsSync(TRY),
  };
}

// -- the shadow week ----------------------------------------------------------------------------------
function installedAt(): number {
  const p = join(dir(), "installed");
  const n = num(p);
  if (n !== null) return n;
  try { writeWhole(p, String(now())); } catch { /* counted from now next time too */ }
  return now();
}
const shadowNow = () => inShadow(shadowSetting(read(join(D, "shadow"))), installedAt(), now(), existsSync(join(D, "shadow.marked")));

// -- relays ---------------------------------------------------------------------------------------------
const CACHE_S = 3600;
const cacheOf = (key: string) => join(dir(), "route", key.replace(/[^0-9]/g, "").slice(0, 20) || "0");
function cached(key: string): string | null {
  const p = cacheOf(key);
  try { if (now() - Math.floor(statSync(p).mtimeMs / 1000) > CACHE_S) return null; } catch { return null; }
  return read(p);
}
function keep(key: string, out: string): void {
  try { writeWhole(cacheOf(key), out); } catch { return; }
  // Old ones go: a line seen again after an hour is classed again.
  for (const n of readdirSync(join(D, "route"))) {
    try { if (now() - Math.floor(statSync(join(D, "route", n)).mtimeMs / 1000) > 86400) rmSync(join(D, "route", n)); } catch { /* next time */ }
  }
}
// The kept record of every skip and would-skip, each with its routing decision: the digest is built
// from it. Appended and synced before the line is skipped; a failure throws, and the line is typed.
function handled(h: Handled): void { appendSynced(join(dir(), "handled.jsonl"), JSON.stringify(h) + "\n"); }
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
  const at = now();
  try { writeWhole(join(dir(), "relay.last"), String(at)); } catch { /* only the fresh start reads it, and fails closed */ }
  const c = classify(text);
  const typeIt = `type\n${RELAY_PREFIX}${text}`;
  let out: string;
  if (c.kind === "card") {
    try { writeWhole(join(dir(), "card.last"), String(at)); } catch { /* the card is still typed first */ }
    out = `type\n${RELAY_PREFIX}${c.card ?? text}`;
  } else if (c.kind === "receipt" && c.receipt) {
    const sh = shadowNow();
    if (sh.shadow) {
      // The shadow week: logged as would-skip, and typed all the same.
      try { handled({ at, kind: "would-skip", item: c.receipt.item, line: text, route: `delivered (shadow: ${sh.why})` }); }
      catch (e) { log(`a would-skip couldn't be kept (${String(e).slice(0, 80)}): typed anyway`); }
      out = typeIt;
    } else {
      try {
        handled({ at, kind: "receipt", item: c.receipt.item, line: text, route: "skipped: allowlisted receipt" });
        out = "handled";
      } catch (e) {
        log(`a receipt couldn't be kept before it was skipped (${String(e).slice(0, 80)}): typed instead`);
        out = typeIt;
      }
      if (out === "handled") {
        try { recordReceipt(receiptRow(c.receipt, text, at, TZ), at); }
        catch (e) { log(`a receipt kept for the digest couldn't go to the record queue (${String(e).slice(0, 80)})`); }
      }
    }
  } else if (c.kind === "long") out = "long";
  else out = typeIt;
  keep(key, out);
  return out;
}

// The worker: a fresh, tool-less Claude Code run on the pinned cheaper model (core.ts workerCommand),
// with a small brief. Its answer is read strictly; any failure is the caller's fallback.
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
export function launch(): { cmd: string[]; cwd: string } {
  if (env.LEAN_WORKER) return { cmd: [env.LEAN_WORKER], cwd: "/" };    // tests: a stand-in
  return { cmd: workerCommand(OWN, TZ), cwd: existsSync(WORKER_HOME) ? WORKER_HOME : "/" };
}
async function runWorker(prompt: string): Promise<string | null> {
  try {
    const { cmd, cwd } = launch();
    // env -i in the command clears it; nothing of root's is handed in here either.
    const p = Bun.spawn(cmd, { cwd, env: {}, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(9), (WORKER_TIMEOUT_S + 5) * 1000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch { return null; }
}
async function summarise(key: string, file: string): Promise<string | null> {
  const hit = cached(`${key}`);
  if (hit !== null && hit.startsWith("type\n")) return hit;
  const text = await stdin();
  const item = /\b(P\d{1,4})\b/.exec(text)?.[1] ?? null;
  const said = await runWorker(workerPrompt({ relay: text, row: rowOf(item), notes: notesOf(item) }));
  const v = said === null ? null : parseWorker(said);
  if (!v) { log(said === null ? "the worker failed or ran out of time: the line goes to Cain as before" : "the worker's answer was malformed: the line goes to Cain as before"); return null; }
  const s = summaryLine(v, file);
  if (!s) { log("the worker's summary can't be typed: the line goes to Cain as before"); return null; }
  const out = `type\n${s}`;
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
  const number = Number(pr?.number);
  if (!Number.isInteger(number)) return { state: "unknown" };
  if (pr.merged_at) return { state: "merged", number };
  if (pr.state === "closed") return { state: "closed", number };
  if (pr.state !== "open") return { state: "unknown" };
  const head = String(pr.head?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(head)) return { state: "unknown" };
  const runs = await gh(`/repos/${REPO}/commits/${head}/check-runs?per_page=100`);
  if (!runs || !Array.isArray(runs.check_runs)) return { state: "unknown" };
  return { state: "open", number, head, checks: checksOf(runs.check_runs.map((r: any) => ({ name: String(r.name), status: String(r.status), conclusion: r.conclusion ?? null }))) };
}
// The root-run reader of his job files (item 5): never through a link (O_NOFOLLOW), never blocking on a
// FIFO (O_NONBLOCK), the descriptor's own fstat: a regular file of his user's, one link only, at most
// 4 KB, read and parsed strictly. Anything else is a problem he hears of, never a silent skip.
const JOB_UID = Number(env.LEAN_JOB_UID ?? (OWN ? 1000 : 0));
export function readJob(path: string, name: string): { job: JobFile } | { problem: JobProblem } {
  const bad = (why: string) => ({ problem: { name, why } });
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
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
interface JobsPending { id: string; turn: string; next: Record<string, JobSeen>; at: number }
async function jobs(jdir: string): Promise<string> {
  const pend = join(dir(), "jobs.pending.json");
  const p = json<JobsPending | null>(pend, null);
  if (p?.id) {
    // Not yet known in: in the queue still, or put back once it has gone missing for 10 minutes.
    if (!inQueue(`jobs:${p.id}`) && now() - p.at >= 600) {
      enqueue(p.turn, `jobs:${p.id}`);
      writeWhole(pend, JSON.stringify({ ...p, at: now() }));
      log("a cloud job line not known in went missing from the queue: queued again");
    }
    return "ok";
  }
  const last = num(join(D, "jobs.looked")) ?? 0;
  if (now() - last < JOBS_EVERY_S) return "ok";
  writeWhole(join(D, "jobs.looked"), String(now()));
  const names = readdirSync(jdir).filter((n) => !n.startsWith("."));   // an unreadable folder throws: the caller's old check
  const list: JobFile[] = [], problems: JobProblem[] = [];
  for (const n of names) {
    const r = readJob(join(jdir, n), n);
    if ("job" in r) list.push(r.job); else problems.push(r.problem);
  }
  const pulls: Record<string, PullState> = {};
  for (const j of list) if (j.kind === "build" && j.branch) pulls[j.name] = await pullOf(j.branch);
  const seenPath = join(D, "jobs.json");
  const seen = json<Record<string, JobSeen>>(seenPath, {});
  const { wakes, next } = jobsLook(list, pulls, seen, now(), problems);
  if (!wakes.length) { writeWhole(seenPath, JSON.stringify(next)); return "ok"; }
  // What he hears is kept as seen only once the line is in (delivered).
  const id = `${now()}-${Math.random().toString(16).slice(2, 8)}`;
  const turn = jobsTurn(wakes, jdir);
  writeWhole(pend, JSON.stringify({ id, turn, next, at: now() }));
  enqueue(turn, `jobs:${id}`);
  return "ok";
}

// -- what the App's own lines stand for, once in -------------------------------------------------------
function delivered(tag: string): void {
  const [kind, a, b] = tag.split(":");
  if (kind === "jobs") {
    const pend = join(dir(), "jobs.pending.json");
    const p = json<JobsPending | null>(pend, null);
    if (!p || p.id !== a) return;
    writeWhole(join(D, "jobs.json"), JSON.stringify(p.next));
    rmSync(pend, { force: true });
  } else if (kind === "digest") {
    writeWhole(join(dir(), "digest.json"), JSON.stringify({ day: a, upto: Number(b), at: now() }));
    rmSync(join(D, "digest.pending.json"), { force: true });
  } else if (kind === "handover") {
    const f = join(dir(), "fresh.json");
    const st = json<any>(f, null);
    if (st?.id === a) writeWhole(f, JSON.stringify({ ...st, typed: now() }));
  }
}

// -- the digest and the week's measure ---------------------------------------------------------------
function handledRows(): Handled[] {
  return (read(join(D, "handled.jsonl")) ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Handled; } catch { return null; } })
    .filter((h): h is Handled => !!h && typeof h.at === "number" && typeof h.line === "string");
}
// Built from the kept record and marked sent only once it went in; what wasn't, comes again the next day.
function digest(hm: string, day: string): string {
  if (!/^\d{4}$/.test(hm) || hm < DIGEST_AT) return "";
  const st = json<{ day?: string; upto?: number }>(join(D, "digest.json"), {});
  if (st.day === day) return "";
  const pp = join(dir(), "digest.pending.json");
  const pend = json<{ id: string; upto: number; at: number } | null>(pp, null);
  if (pend && inQueue(`digest:${pend.id}:${pend.upto}`)) return "";
  if (pend && pend.id === day && now() - pend.at < 600) return "";
  const rows = handledRows();
  const from = Math.min(st.upto ?? 0, rows.length);
  const fresh = rows.slice(from);
  if (!fresh.length) return "";
  enqueue(digestText(day, fresh, TZ, shadowNow()), `digest:${day}:${rows.length}`);
  writeWhole(pp, JSON.stringify({ id: day, upto: rows.length, at: now() }));
  return `queued ${day} ${rows.length}`;
}
async function missedIn(): Promise<void> {
  for (const l of (await stdin()).split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2})((?: \d{1,3}){1,50})\s*$/.exec(l.trim());
    if (!m) { if (l.trim()) log(`a mark of his couldn't be read: ${l.trim().slice(0, 80)}`); continue; }
    for (const n of m[2].trim().split(" ")) appendFileSync(join(dir(), "missed.jsonl"), JSON.stringify({ at: now(), digest: m[1], n: Number(n) }) + "\n");
    // A mark is a line the allowlist matched that needed him: the shadow week doesn't end by itself.
    try { writeWhole(join(D, "shadow.marked"), `${now()} ${m[1]}\n`); } catch { log("a mark couldn't be kept for the shadow week"); }
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
function jsonlFiles(d: string, days = 3): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) {
      const f = join(p, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (st.isFile() && n.endsWith(".jsonl") && now() - st.mtimeMs / 1000 < days * 86400) out.push(f);
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

// -- compaction ------------------------------------------------------------------------------------------
// One transcript's calls in order: each call once (by its message id), its context, and whether a
// compaction came before it.
function callsOf(lines: string[]): Call[] {
  const out: Call[] = [], seen = new Set<string>();
  let compacted = false;
  for (const raw of lines) {
    let o: any;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o?.type === "system" && o.subtype === "compact_boundary") { compacted = true; continue; }
    if (o?.isCompactSummary) { compacted = true; continue; }
    const u = o?.type === "assistant" ? o.message?.usage : null;
    if (!u) continue;
    const id = String(o.message?.id ?? o.uuid ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
    out.push({ ctx: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), compactedBefore: compacted });
    compacted = false;
  }
  return out;
}
// His session's newest transcript (its folder "-data-work"): the last call's context, and whether it
// compacted since.
function context(projects: string): string {
  const files = jsonlFiles(projects, 2).filter((f) => f.includes("-data-work"));
  if (!files.length) return "none";
  const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const st = statSync(newest);
  const fd = openSync(newest, "r");
  let text: string;
  try {
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    text = buf.toString("utf8");
  } finally { closeSync(fd); }
  const lines = text.split("\n");
  const calls = callsOf(lines);
  if (!calls.length) return "none";
  // A compaction after the last call: its context isn't his context any more.
  let lastCall = -1, lastCompact = -1;
  lines.forEach((l, i) => {
    if (l.includes('"compact_boundary"') || l.includes('"isCompactSummary":true')) lastCompact = i;
    else if (l.includes('"type":"assistant"') && l.includes('"usage"')) lastCall = i;
  });
  return `${calls.at(-1)!.ctx} ${lastCompact > lastCall ? 1 : 0}`;
}
function compactDue(tokens: string, since: string, screen: string): { due: boolean; why: string } {
  const st = json<{ last?: number; day?: string; n?: number }>(join(dir(), "compact.json"), {});
  const today = localParts(now(), TZ).day;
  const ctx = /^\d+$/.test(tokens) ? Number(tokens) : null;
  const why = compactWhyNot({ ...quiet(screen), context: ctx, compactedSince: since === "1", lastTry: st.last ?? null, triesToday: st.day === today ? st.n ?? 0 : 0 });
  return why ? { due: false, why } : { due: true, why: "due" };
}
function compactDone(): void {
  const p = join(dir(), "compact.json");
  const st = json<{ last?: number; day?: string; n?: number }>(p, {});
  const today = localParts(now(), TZ).day;
  writeWhole(p, JSON.stringify({ last: now(), day: today, n: (st.day === today ? st.n ?? 0 : 0) + 1 }));
}
// Item 7's measurement, from the Pi (as him): over his session's transcripts of the last 8 days, how
// many compactions each threshold would have made, a day.
function compactSim(projects: string, thresholds: number[]): string {
  const files = jsonlFiles(projects, 8).filter((f) => f.includes("-data-work"));
  const sessions = files.map((f) => callsOf((read(f) ?? "").split("\n")));
  const calls = sessions.reduce((a, s) => a + s.length, 0);
  const real = sessions.reduce((a, s) => a + s.filter((c) => c.compactedBefore).length, 0);
  const days = 8;
  const parts = thresholds.map((t) => { const n = simulate(sessions, t); return `${Math.round(t / 1000)}K: ${n} (${(n / days).toFixed(1)} a day)`; });
  return `compact-sim over ${files.length} transcripts, ${calls} calls, ${real} real compactions, ${days} days: ${parts.join("; ")}`;
}

// -- the quiet-hour fresh start ------------------------------------------------------------------------
// Two steps (item 6): when every quiet sign holds, his handover is asked for (a line in the queue, with a
// request id of the App's); once the record keeper has that request done, written after the ask, and
// every sign holds again, the start is due, its first line queued for the new session.
function freshDue(screen: string, upSince: number): { due: boolean; why: string } {
  const lastP = join(dir(), "fresh.last"), stP = join(D, "fresh.json");
  const heard = num(env.PROBE_HEARD ?? "/run/cain/probe/heard");
  const jdir = env.JOBS_DIR ?? "/data/jobs";
  const jobsN = existsSync(jdir) ? readdirSync(jdir).filter((n) => !n.startsWith(".")).length : 0;
  const day = localParts(now(), TZ).day;
  const facts = { ...quiet(screen), tz: TZ, lastDay: (read(lastP) ?? "").trim() || null, heardAt: heard, relayAt: num(join(D, "relay.last")), jobs: jobsN, upSince };
  const why = freshWhyNot(facts);
  const st = json<{ id: string; at: number; day: string; typed?: number } | null>(stP, null);
  if (st?.id) {
    if (st.day !== day || now() - st.at > HANDOVER_WAIT_S) {
      writeWhole(lastP, st.day);
      rmSync(stP, { force: true });
      return { due: false, why: "his handover didn't reach the record in time: no fresh start today" };
    }
    if (!handoverConfirmed(read(join(RECORD_OUTCOMES, `${st.id}.json`)), st.id, st.at)) return { due: false, why: "waiting for his handover in the record" };
    if (why) return { due: false, why };
    writeWhole(lastP, day);
    rmSync(stP, { force: true });
    enqueue(FRESH_LINE, "fresh");
    return { due: true, why: "due" };
  }
  if (why) return { due: false, why };
  const id = handoverId(day, now());
  writeWhole(stP, JSON.stringify({ id, at: now(), day }));
  enqueue(handoverLine(id), `handover:${id}`);
  return { due: false, why: "asked for his handover" };
}

if (import.meta.main) {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "compact-pct": console.log(compactPct()); break;
      case "route": console.log(await route(a ?? "0")); break;
      case "summarise": { const o = await summarise(a ?? "0", b ?? ""); if (o === null) process.exit(1); console.log(o); break; }
      case "jobs": console.log(await jobs(a ?? env.JOBS_DIR ?? "/data/jobs")); break;
      case "delivered": delivered(a ?? ""); break;
      case "digest": { const o = digest(a ?? "", b ?? ""); if (o) console.log(o); break; }
      case "missed-in": await missedIn(); break;
      case "counts": console.log(counts()); break;
      case "usage": {
        const [h, m] = (c ?? "").split(" ").map(Number);
        console.log(usage(a ?? "", b ?? "", Number.isFinite(h) && c ? { handled: h, missed: Number.isFinite(m) ? m : 0 } : {}));
        break;
      }
      case "usage-due": { const o = usageDue(); if (o) console.log(o); break; }
      case "fresh-due": { const r = freshDue(a ?? "", Number(b ?? 0)); console.log(r.why); process.exit(r.due ? 0 : 1); }
      case "context": console.log(context(a ?? "")); break;
      case "compact-due": { const r = compactDue(a ?? "", b ?? "", c ?? ""); console.log(r.why); process.exit(r.due ? 0 : 1); }
      case "compact-done": compactDone(); break;
      case "compact-sim": console.log(compactSim(a ?? "", process.argv.slice(4).map(Number).filter((n) => n > 0))); break;
      case "shadow": { const s = shadowNow(); console.log(`${s.shadow ? "shadow" : "live"}: ${s.why}`); break; }
      case "card-wait": process.exit(cardWaiting() ? 0 : 1);
      case "worker-argv": console.log(JSON.stringify(launch())); break;
      default: console.error("usage: lean/main.ts compact-pct | route <key> | summarise <key> <file> | jobs <dir> | delivered <tag> | digest <HHMM> <day> | missed-in | counts | usage <day> <dir> [\"<handled> <missed>\"] | usage-due | fresh-due <screen> <up since> | context <dir> | compact-due <tokens> <0|1> <screen> | compact-done | compact-sim <dir> <threshold>... | shadow | card-wait | worker-argv"); process.exit(2);
    }
  } catch (e) { log(`${cmd} failed: ${String(e).slice(0, 200)}`); process.exit(1); }
}
