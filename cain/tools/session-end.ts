// When a laptop session ends, what it left open on the items it holds goes into Cain's record
// (org-v2 DESIGN 4.F; the registry's S-051). This is the backstop, not the home: work that
// outlives a turn holds its item (the record's holds; a push to a branch the session doesn't
// hold is refused), so the item is on the open list from the start, and a hold lapses after a
// day without a word. A session that holds no item files nothing: it isn't the harness's
// tracked work, and what it was about stays in the session, on the laptop.
//
//   bun cain/tools/session-end.ts --hook     (a SessionEnd hook: session_id, transcript_path)
//   bun cain/tools/session-end.ts --flush    (a SessionStart hook: what an end couldn't send)
//   bun cain/tools/session-end.ts --session <id> --transcript <path> [--record <clone>] [--dry]
//
// Give the SessionEnd hook a timeout of 30 (seconds): Claude Code allows one 1.5 seconds unless
// its timeout says more, and fetching and sending the record takes longer.
//
// It replays the session's task list from its transcript (the app's update_plan, or TodoWrite):
// only a step's own status says it's done, and a call that failed changes nothing. On each item
// the session holds, a note: the steps still open (their words, anything shaped like a key
// masked; never the chat itself), or, when the transcript can't be read or kept no task list,
// that it ended without one.
//
// Once only, in order, and never lost. Each session keeps one journal (append-only, synced),
// the one truth of what it left open at each end: every end whose state differs from the last
// entry's (the items held, the open steps, or why it can't tell) is entry n + 1, the same state
// again is nothing new, and going back to an earlier state is a new entry. An entry on held items
// is a filing (and an end with nothing left open is one when the last filing had something
// open); its id is the session, n and the state, so a second end of the same change files the
// same request, which the record keeper, refusing an id it has seen, applies once. Ends of one
// session take turns (the second waits for the first). The filing is journaled first, then put
// in an outbox in the record clone's .git folder (written whole and synced, then moved in); one
// the journal has but the outbox and the keeper don't is put back from the journal. The outbox
// is only a delivery queue: named by session and n, it leaves in that order, under the same
// name in the record's inbox, which the keeper works through by name. It stays until the keeper
// has logged it: kept after it's sent until the keeper says done, and sent again, as itself, if
// a day passes with no word. A filing the record refuses or would refuse, an outbox file that
// can't be read, or one cut off while it was written is moved aside with why, never deleted,
// and named at every session's start until a session deals with it. What it says of a filing
// is that filing's own fate: submitted (in the record's inbox), filed (the keeper said done),
// waiting here, or kept aside.
//
// Every flush, at a session's start or end, first settles what the journals hold: a journaled
// filing the outbox has no trace of is put back (or marked done, or kept aside as refused, as
// the keeper's log says), and a snapshot left by an end that couldn't take its turn in time
// (each end leaves one before it waits) is journaled and filed then, under its session's lock.
// A journal line cut off by a crash stays as it is, marked torn, and the next entry starts on a
// line of its own; any other line that can't be read is damage, named at every flush; a journal
// that can't be read is never taken for an empty one, and is named at every flush too. Which of
// two snapshots of a session is newer is read from its transcript, not a clock: a transcript only
// grows, so the one that had read more of it is the newer.
// It never holds up the session's end: any failure is one line.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TOKEN_SHAPES } from "../rootfs/opt/cain/c1/tools.ts";
import { type Clone, args, check, clone, fetch, git, holdsAt, outcomes, send, sessionOf } from "./record-lib.ts";

export interface Step { content: string; status: string }
const STATUSES = new Set(["pending", "in_progress", "completed"]);

// The task list as the session last left it, from its transcript's lines. update_plan's items
// replace the list; advance finishes the step in progress and starts the next; done and start
// mark steps by number (from 1). TodoWrite's todos replace the list. A call whose result was an
// error changed nothing. wrap_up says nothing about which steps are done.
export function stepsOf(lines: string[]): { steps: Step[]; planned: boolean } {
  const calls: { id: string; name: string; input: any }[] = [];
  const failed = new Set<string>();
  for (const l of lines) {
    if (!l.includes("update_plan") && !l.includes("TodoWrite") && !l.includes("is_error")) continue;   // a long transcript: only these lines matter
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_use" && c.input && typeof c.input === "object") calls.push({ id: String(c.id ?? ""), name: String(c.name ?? ""), input: c.input });
      if (c?.type === "tool_result" && c.is_error === true && c.tool_use_id) failed.add(String(c.tool_use_id));
    }
  }
  let steps: Step[] = [];
  let planned = false;
  const list = (xs: any[]) => xs.filter((s: any) => s && typeof s.content === "string")
    .map((s: any) => ({ content: s.content, status: STATUSES.has(s.status) ? s.status : "pending" }));
  for (const { id, name, input: i } of calls) {
    if (id && failed.has(id)) continue;
    if (name.endsWith("update_plan")) {
      planned = true;
      if (Array.isArray(i.items)) steps = list(i.items);
      if (Array.isArray(i.done)) for (const n of i.done) if (steps[n - 1]) steps[n - 1].status = "completed";
      if (i.advance === true) {
        const at = steps.findIndex((s) => s.status === "in_progress");
        if (at >= 0) steps[at].status = "completed";
        const next = steps.findIndex((s) => s.status === "pending");
        if (next >= 0) steps[next].status = "in_progress";
      }
      if (Number.isInteger(i.start) && steps[i.start - 1]) {
        for (const s of steps) if (s.status === "in_progress") s.status = "pending";
        steps[i.start - 1].status = "in_progress";
      }
    } else if (name === "TodoWrite" && Array.isArray(i.todos)) {
      planned = true;
      steps = list(i.todos);
    }
  }
  return { steps, planned };
}

// A step's words, on one line, with anything shaped like a key masked.
export function clean(s: string, n: number): string {
  let t = s.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
  for (const { re } of TOKEN_SHAPES) t = t.replace(new RegExp(re.source, re.flags.replace("g", "") + "g"), "[a key, masked]");
  return t.slice(0, n);
}

export type Why = "open" | "unread" | "unplanned";

// What a filing holds: why, the items held and the open steps' whole words, in any order.
export const filedKey = (held: string[], open: Step[], why: Why = "open") =>
  createHash("sha1").update(JSON.stringify([why, [...held].sort(), open.map((s) => clean(s.content, 10_000)).sort()])).digest("hex").slice(0, 16);
// A filing's id, and its name in the outbox and the record's inbox: the session, then n (so
// names sort in the order the session's filings were made, whatever the clock), then the state.
export const filingId = (session: string, n: number, key: string) => `laptop-end-${session}-${String(n).padStart(6, "0")}-${key}`;

// One journal entry: n, the state's key, when, what kind of end, and for a filing its id and
// the request as sent.
export interface Entry { n: number; key: string; at: number; kind: "open" | "empty" | Why; id?: string; raw?: string; mark?: number }

// A journal's entries, and its damaged lines: a line that can't be read that is neither its last
// (a crash cut it off; the next append marks it torn) nor marked torn. No journal yet is empty;
// one that can't be read throws.
export function journalOf(path: string): { entries: Entry[]; damaged: number[] } {
  let text = "";
  try { text = readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { entries: [], damaged: [] }; throw e; }   // unreadable is not empty
  const lines = text.split("\n");
  const entries: Entry[] = [];
  const damaged: number[] = [];
  const parsed = lines.map((l) => { try { return l.trim() ? JSON.parse(l) : null; } catch { return undefined; } });
  parsed.forEach((p, i) => {
    if (p === null) return;
    if (p === undefined) {
      const last = lines.slice(i + 1).every((l) => !l.trim());
      if (!last && parsed[i + 1]?.torn !== true) damaged.push(i + 1);
      return;
    }
    if (Number.isInteger(p?.n) && typeof p?.key === "string") entries.push(p);
  });
  return { entries, damaged };
}
export const readJournal = (path: string): Entry[] => journalOf(path).entries;

// What this end is, given the journal: the same state as its last entry (nothing new), or entry
// n + 1, a filing when it has held items and something to say.
export function decide(journal: Entry[], key: string, held: string[], open: Step[], why: Why): { n: number; same: boolean; file: boolean; wasOpen: boolean } {
  const last = journal.at(-1);
  if (last && last.key === key) return { n: last.n, same: true, file: false, wasOpen: false };
  const n = journal.reduce((m, e) => Math.max(m, e.n), 0) + 1;
  const filed = [...journal].reverse().find((e) => e.id);
  const wasOpen = !!filed && filed.kind !== "empty";
  return { n, same: false, file: held.length > 0 && (why !== "open" || open.length > 0 || wasOpen), wasOpen };
}

// A folder's entries made durable where the system allows it (not on Windows).
function syncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* not here */ }
}

// Appends one entry, synced. A last line cut off by a crash is left as it is, a line marking it
// torn follows it, and the new entry starts on a line of its own.
export function appendEntry(path: string, e: Entry): void {
  let torn = false;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size > 0) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); torn = b[0] !== 0x0a; }
    } finally { closeSync(fd); }
  } catch { /* none yet */ }
  const fd = openSync(path, "a");
  try { writeSync(fd, (torn ? "\n" + JSON.stringify({ torn: true }) + "\n" : "") + JSON.stringify(e) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
}

// A transcript, a line at a time, in chunks: a long session's runs to hundreds of megabytes.
export function eachLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    const dec = new StringDecoder("utf8");
    let rest = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const lines = (rest + dec.write(buf.subarray(0, n))).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) fn(l);
    }
    rest += dec.end();
    if (rest) fn(rest);
  } finally { closeSync(fd); }
}

// The record request, or null when there's nothing to file: only on items the session holds,
// and an end with nothing left open only when its last filing had something open (wasOpen), so
// the record's newest note on the item is true.
export function requestFor(open: Step[], held: string[], why: Why = "open", at = new Date(), wasOpen = false): any | null {
  if (!held.length || (why === "open" && !open.length && !wasOpen)) return null;
  const day = at.toISOString().slice(0, 10);
  const said = why === "open" ? (open.length ? `with these steps open: ${open.map((s) => clean(s.content, 120)).join("; ")}.` : "with nothing left open on its task list.")
    : why === "unread" ? "and its task list couldn't be read, so what it left open isn't known."
    : "and kept no task list, so what it left open isn't known.";
  const ops = held.map((item) => ({ op: "note", item, text: clean(`The laptop session ended (${day}) ${said} Its hold lapses in a day; take the item to carry it on.`, 1900) }));
  const what = why === "open" ? (open.length ? `with ${open.length} step(s) open` : "with nothing left open") : why === "unread" ? "and its task list couldn't be read" : "with no task list";
  return { kind: "change", summary: clean(`A laptop session ended ${what} on ${held.join(", ")}`, 200), ops };
}

// What becomes of a filing in the outbox, from what the keeper has logged for its id, oldest
// first: filed (done: it leaves the outbox), else by its newest word: waiting (the keeper holds
// it behind one of Cain's jobs), refused (moved aside, with why); with no word, send (never
// sent), resend (sent a day ago) or wait. A second copy's refusal as a used id isn't a word
// about the filing: the first copy's is (outcomeOf drops those).
export type Fate = "filed" | "waiting" | "refused" | "send" | "resend" | "wait";
export function fate(states: string[], sent: boolean, sentAgoMs: number): Fate {
  if (states.includes("done")) return "filed";
  const last = states.at(-1);
  if (last === "rejected" || last === "conflict" || last === "refused") return "refused";
  if (last === "waiting") return "waiting";
  if (!sent) return "send";
  return sentAgoMs > 86_400_000 ? "resend" : "wait";
}
export const outcomeOf = (logged: any[]) => logged.filter((o) => !/already used/.test(String(o?.reason ?? o?.line ?? "")));

// The folder for the outbox and each session's last filing: beside record-holds' memo, in the
// clone's .git folder.
export function memoDir(c: Clone): string {
  const gitDir = git(c.dir, ["rev-parse", "--git-dir"])?.trim() ?? ".git";
  return join(isAbsolute(gitDir) ? gitDir : join(c.dir, gitDir), "record-holds");
}

// A file whole or not at all: written beside and synced, then moved in (a rename replaces it at once).
function writeWhole(path: string, body: string): void {
  const part = `${path}.${process.pid}.part`;
  const fd = openSync(part, "w");
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(part, path);
  syncDir(dirname(path));
}

// Best effort: one holder at a time; a lock left by a process that died goes after 2 minutes.
// Two that slip past it do the same work, which the keeper's refusal of a seen id makes harmless.
export function claim(lock: string, now = Date.now()): boolean {
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { /* held, or left */ }
  try { if (now - statSync(lock).mtimeMs < 120_000) return false; } catch { /* gone meanwhile */ }
  rmSync(lock, { force: true });
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}

// Puts one filing in the outbox, by its id. Returns its name.
export function enqueue(dir: string, id: string, raw: string): string {
  mkdirSync(join(dir, "outbox"), { recursive: true });
  const name = `${id}.json`;
  writeWhole(join(dir, "outbox", name), raw);
  return name;
}

// Whether the outbox has seen a filing: waiting, sent, kept aside, or done (a filing the keeper
// said done leaves an empty mark in outbox/done, so it's never put back from the journal, however
// old the keeper's log of it).
export const inOutbox = (dir: string, id: string) =>
  [`${id}.json`, `${id}.sent`, `refused/${id}.json`, `unreadable/${id}.json`, `done/${id}`].some((n) => existsSync(join(dir, "outbox", n)));

// A filing moved aside, with why: kept, never deleted, until a session deals with it.
function aside(dir: string, kind: "refused" | "unreadable", name: string, why: string): void {
  const to = join(dir, "outbox", kind);
  mkdirSync(to, { recursive: true });
  const base = name.replace(/\.(json|sent|part)$/, "");
  try { renameSync(join(dir, "outbox", name), join(to, `${base}.json`)); } catch { return; }   // another flush took it
  writeFileSync(join(to, `${base}.why`), why + "\n");
}

// What one end saw: the session, the items it held, its open steps and why, how much of the
// transcript it had read (mark: its order among the session's snapshots), and when (dating the note).
export interface Snapshot { session: string; held: string[]; open: Step[]; why: Why; at: number; mark?: number }

// Journals one end's snapshot and, if it's a filing, puts it in the outbox. The caller holds the
// session's lock. A snapshot that had read less of the transcript than the journal's last entry
// is older (a transcript only grows) and is passed over, so the record's newest note is the
// session's newest state; a clock never decides it. Throws when the journal can't be read.
export function fileSnapshot(dir: string, s: Snapshot): { id: string | null; same: boolean } {
  const journalPath = join(dir, `${s.session}.journal`);
  const key = filedKey(s.held, s.open, s.why);
  const journal = readJournal(journalPath);
  const lastMark = journal.at(-1)?.mark;
  if (s.mark !== undefined && lastMark !== undefined && s.mark < lastMark) return { id: null, same: true };
  const d = decide(journal, key, s.held, s.open, s.why);
  if (d.same) return { id: null, same: true };
  const kind: Entry["kind"] = s.why === "open" ? (s.open.length ? "open" : "empty") : s.why;
  const mark = s.mark !== undefined ? { mark: s.mark } : {};
  if (!d.file) { appendEntry(journalPath, { n: d.n, key, at: s.at, kind, ...mark }); return { id: null, same: false }; }
  const req = requestFor(s.open, s.held, s.why, new Date(s.at), d.wasOpen);
  req.from = `laptop:${s.session}`;
  req.id = filingId(s.session, d.n, key);
  const raw = JSON.stringify(req, null, 1) + "\n";
  appendEntry(journalPath, { n: d.n, key, at: s.at, kind, id: req.id, raw, ...mark });
  enqueue(dir, req.id, raw);                           // after the journal: a stop in between is put back
  return { id: req.id, same: false };
}

// An end's snapshot, kept before it waits for its session's turn: a flush files it if the end
// couldn't.
export function writePending(dir: string, s: Snapshot): string {
  mkdirSync(join(dir, "pending"), { recursive: true });
  const p = join(dir, "pending", `${s.session}-${String(s.at).padStart(15, "0")}-${process.pid}.json`);
  writeWhole(p, JSON.stringify(s));
  return p;
}

// Files the snapshots ends left, oldest first, each under its session's lock (one held now waits
// for the next flush). One that can't be read is kept aside.
function takePending(dir: string): void {
  // A snapshot cut off while it was written (its end stopped before moving it in): once 2 minutes
  // old, whole it's moved in, cut off it's kept aside.
  let parts: string[] = [];
  try { parts = readdirSync(join(dir, "pending")).filter((n) => n.endsWith(".part")); } catch { /* none */ }
  for (const p of parts) {
    const path = join(dir, "pending", p);
    try { if (Date.now() - statSync(path).mtimeMs < 120_000) continue; } catch { continue; }
    let ok = false;
    try { const s = JSON.parse(readFileSync(path, "utf8")); ok = typeof s?.session === "string" && Array.isArray(s?.held) && Array.isArray(s?.open); } catch { /* cut off */ }
    const whole = p.replace(/\.\d+\.part$/, "");
    if (ok && whole.endsWith(".json")) { try { renameSync(path, join(dir, "pending", whole)); } catch { /* taken */ } continue; }
    mkdirSync(join(dir, "outbox", "unreadable"), { recursive: true });
    try { renameSync(path, join(dir, "outbox", "unreadable", `pending-${whole.replace(/\.json$/, "")}.json`)); writeFileSync(join(dir, "outbox", "unreadable", `pending-${whole.replace(/\.json$/, "")}.why`), "an end's snapshot was cut off while it was written\n"); } catch { /* taken */ }
  }
  let names: string[] = [];
  try { names = readdirSync(join(dir, "pending")).filter((n) => n.endsWith(".json")).sort((a, b) => a.split("-").at(-2)!.localeCompare(b.split("-").at(-2)!)); } catch { return; }
  for (const n of names) {
    const path = join(dir, "pending", n);
    let s: Snapshot | null = null;
    try { s = JSON.parse(readFileSync(path, "utf8")); } catch { /* below */ }
    if (!s || typeof s.session !== "string" || !Array.isArray(s.held) || !Array.isArray(s.open)) {
      mkdirSync(join(dir, "outbox", "unreadable"), { recursive: true });
      try { renameSync(path, join(dir, "outbox", "unreadable", `pending-${n}`)); writeFileSync(join(dir, "outbox", "unreadable", `pending-${n.replace(/\.json$/, "")}.why`), "an end's snapshot couldn't be read\n"); } catch { /* taken */ }
      continue;
    }
    const lock = join(dir, `${s.session}.ending`);
    if (!claim(lock)) continue;
    try { fileSnapshot(dir, s); rmSync(path, { force: true }); }
    catch { /* its journal can't be read: kept, and said by its session's end */ }
    finally { rmSync(lock, { force: true }); }
  }
}

// Every journaled filing the outbox has no trace of: done by the keeper's log (marked), refused
// (kept aside), held behind a job (tracked as sent), or never seen (put back). Returns what it
// couldn't: a journal it can't read, or damaged lines in one, each said at every flush.
function reconcile(rec: Clone, dir: string): string[] {
  const said: string[] = [];
  let journals: string[] = [];
  try { journals = readdirSync(dir).filter((n) => n.endsWith(".journal")); } catch { return said; }
  for (const j of journals) {
    let entries: Entry[] = [];
    try {
      const got = journalOf(join(dir, j));
      entries = got.entries;
      if (got.damaged.length) said.push(`A laptop session's journal has damaged lines (${got.damaged.join(", ")}), kept as they are: ${join(dir, j)}. What they held may not be filed; file it another way if it matters.`);
    } catch (e) {
      said.push(`A laptop session's journal can't be read (${(e as NodeJS.ErrnoException)?.code ?? e}), kept as it is: ${join(dir, j)}. What it holds isn't filed until it can be read.`);
      continue;
    }
    for (const e of entries) {
      if (!e.id || !e.raw || inOutbox(dir, e.id)) continue;
      const logged = outcomeOf(outcomes(rec, e.id) as any[]);
      const f = fate(logged.map((o) => String(o.state)), false, 0);
      if (f === "filed") { mkdirSync(join(dir, "outbox", "done"), { recursive: true }); writeFileSync(join(dir, "outbox", "done", e.id), ""); continue; }
      enqueue(dir, e.id, e.raw);
      if (f === "refused") {
        const last = logged.filter((o) => o.state !== "done").at(-1);
        aside(dir, "refused", `${e.id}.json`, `the record said ${last?.state ?? "no"}: ${last?.reason ?? last?.line ?? ""}`.trim());
      } else if (f === "waiting") {
        try { renameSync(join(dir, "outbox", `${e.id}.json`), join(dir, "outbox", `${e.id}.sent`)); } catch { /* taken */ }
      }
    }
  }
  return said;
}

// Whether anything waits for a flush: an outbox file, an end's snapshot, or a journaled filing
// the outbox has no trace of. Local reads only, so a start with nothing to do needs no network.
export function waiting(dir: string): boolean {
  try { if (readdirSync(join(dir, "outbox"), { recursive: true }).some((x) => /\.(json|sent|part)$/.test(String(x)))) return true; } catch { /* none */ }
  try { if (readdirSync(join(dir, "pending")).some((x) => x.endsWith(".json") || x.endsWith(".part"))) return true; } catch { /* none */ }
  let journals: string[] = [];
  try { journals = readdirSync(dir).filter((n) => n.endsWith(".journal")); } catch { return false; }
  for (const j of journals) {
    try {
      const got = journalOf(join(dir, j));
      if (got.damaged.length || got.entries.some((e) => e.id && e.raw && !inOutbox(dir, e.id))) return true;
    } catch { return true; }                           // can't be read: the flush says so
  }
  return false;
}

export interface Flushed { lines: string[]; fates: Map<string, "submitted" | "filed" | "waiting here" | "aside"> }

// Works the outbox, oldest filing first: sends what wasn't, settles what the keeper has logged,
// moves aside what it refused or would refuse, or what can't be read. One flush at a time.
export function flush(rec: Clone, dir: string, now = Date.now()): Flushed {
  const lock = join(dir, "outbox.lock");
  mkdirSync(join(dir, "outbox"), { recursive: true });
  if (!claim(lock, now)) return { lines: [], fates: new Map() };          // another flush is at it
  try {
    takePending(dir);
    const unsettled = reconcile(rec, dir);
    const out = flushing(rec, dir, join(dir, "outbox"), now);
    out.lines.push(...unsettled);
    // An end's snapshot still waiting after ten minutes (its session's journal can't be read, or
    // its lock is held) is named, so it's never silent.
    let stuck: string[] = [];
    try { stuck = readdirSync(join(dir, "pending")).filter((n) => n.endsWith(".json") && now - statSync(join(dir, "pending", n)).mtimeMs > 600_000); } catch { /* none */ }
    for (const n of stuck.sort()) out.lines.push(`An end's snapshot is still waiting to be filed: ${join(dir, "pending", n)}. Its session's journal may not be readable; file what it held another way, or drop it; then delete it.`);
    return out;
  } finally { rmSync(lock, { force: true }); }
}

function flushing(rec: Clone, dir: string, box: string, now: number): Flushed {
  const fates: Flushed["fates"] = new Map();
  // A filing cut off while it was written (its process ended before it was moved in) is kept
  // aside once it's 2 minutes old; one whole is moved in and goes on as its own.
  let parts: string[] = [];
  try { parts = readdirSync(box).filter((n) => n.endsWith(".part")); } catch { /* none */ }
  for (const p of parts) {
    try { if (now - statSync(join(box, p)).mtimeMs < 120_000) continue; } catch { continue; }
    let req: any = null;
    try { req = JSON.parse(readFileSync(join(box, p), "utf8")); } catch { /* cut off */ }
    const whole = p.replace(/\.\d+\.part$/, "");
    if (req && typeof req.id === "string" && whole.endsWith(".json")) { try { renameSync(join(box, p), join(box, whole)); } catch { /* taken */ } }
    else aside(dir, "unreadable", p, "this filing was cut off while it was written");
  }
  let names: string[] = [];
  try { names = readdirSync(box).filter((n) => n.endsWith(".json") || n.endsWith(".sent")).sort(); } catch { /* none */ }
  let went = 0;
  let offline = false;
  for (const n of names) {
    const path = join(box, n);
    let raw = "", req: any = null;
    try { raw = readFileSync(path, "utf8"); req = JSON.parse(raw); } catch { /* below */ }
    if (!req || typeof req.id !== "string") {
      try { statSync(path); } catch { continue; }                          // another flush moved it
      aside(dir, "unreadable", n, "this filing couldn't be read");
      continue;
    }
    const sent = n.endsWith(".sent");
    let ago = 0;
    try { ago = now - statSync(path).mtimeMs; } catch { continue; }
    const logged = outcomeOf(outcomes(rec, req.id) as any[]);
    const f = fate(logged.map((o) => String(o.state)), sent, ago);
    if (f === "filed") {
      mkdirSync(join(box, "done"), { recursive: true });
      writeFileSync(join(box, "done", req.id), "");
      rmSync(path, { force: true });
      fates.set(req.id, "filed");
      continue;
    }
    if (f === "refused") {
      const last = logged.filter((o) => o.state !== "done").at(-1);
      aside(dir, "refused", n, `the record said ${last?.state ?? "no"}: ${last?.reason ?? last?.line ?? ""}`.trim());
      fates.set(req.id, "aside");
      continue;
    }
    if (f === "waiting" || f === "wait") { fates.set(req.id, sent ? "submitted" : "waiting here"); continue; }
    if (offline) { fates.set(req.id, sent ? "submitted" : "waiting here"); continue; }   // in order: none past one that couldn't go
    if (!sent) {
      const r = check(raw, rec);
      if (r.state !== "ok" && r.state !== "waiting") { aside(dir, "refused", n, `the record would refuse it: ${r.line}`); fates.set(req.id, "aside"); continue; }
    }
    const s = send(rec, n.replace(/\.(json|sent)$/, ".json"), raw, `Inbox: ${req.summary ?? "a laptop session's end"} (${req.id}${sent ? ", sent again" : ""})`);
    if ("error" in s) { offline = true; fates.set(req.id, sent ? "submitted" : "waiting here"); continue; }
    try {
      const to = sent ? path : join(box, n.replace(/\.json$/, ".sent"));
      if (!sent) renameSync(path, to);
      const t = new Date(now);
      utimesSync(to, t, t);                                                 // a day from this send
    } catch { /* another flush settled it */ }
    fates.set(req.id, "submitted");
    went++;
  }
  const lines = went ? [`Submitted ${went} to the record from a laptop session's end`] : [];
  for (const kind of ["refused", "unreadable"] as const) {
    let held: string[] = [];
    try { held = readdirSync(join(box, kind)).filter((x) => x.endsWith(".json")).sort(); } catch { /* none */ }
    for (const x of held) {
      let why = "";
      try { why = readFileSync(join(box, kind, x.replace(/\.json$/, ".why")), "utf8").trim(); } catch { /* none */ }
      lines.push(`A filing a laptop session left when it ended is kept aside, ${kind === "refused" ? `refused (${why})` : `unreadable (${why || "it couldn't be read"})`}: ${join(box, kind, x)}. File what it held another way, or drop it; then delete it.`);
    }
  }
  return { lines, fates };
}

if (import.meta.main) {
  const a = args(process.argv.slice(2), ["record", "session", "transcript"]);
  let lock = "";
  const say = (...lines: string[]): never => {
    if (lock) rmSync(lock, { force: true });
    const text = lines.filter(Boolean).join("\n");
    if (text) console.log(text);
    process.exit(0);
  };
  const c = clone(a.record ?? process.env.RECORD_CLONE);
  if ("error" in c) say("");
  const rec = c as Exclude<typeof c, { error: string }>;
  const dir = memoDir(rec);
  if (a.flush === true) {
    if (!waiting(dir)) say("");                        // at every start: nothing waiting, no network
    fetch(rec);
    say(...flush(rec, dir).lines);
  }
  let input: any = {};
  if (a.hook === true) { try { input = JSON.parse(await Bun.stdin.text()); } catch { /* none */ } }
  const session = sessionOf(a.session ?? input.session_id);
  if (!session) say("");
  fetch(rec);                                          // offline: the holds as last fetched, and the outbox
  let read = true;
  let mark: number | undefined;
  const kept: string[] = [];
  try {
    mark = statSync(a.transcript ?? input.transcript_path).size;   // how much of it this end has seen: its order
    eachLine(a.transcript ?? input.transcript_path, (l) => { if (l.includes("update_plan") || l.includes("TodoWrite") || l.includes("is_error")) kept.push(l); });
  } catch { read = false; mark = undefined; }
  const { steps, planned } = stepsOf(kept);
  const open = steps.filter((s) => s.status !== "completed");
  const held = Object.entries(holdsAt(rec)).filter(([, h]: [string, any]) => h?.holder === `laptop:${session}`).map(([item]) => item).sort();
  const why: Why = !read ? "unread" : !planned ? "unplanned" : "open";
  const snap: Snapshot = { session: session!, held, open, why, at: Date.now(), ...(mark !== undefined ? { mark } : {}) };
  mkdirSync(dir, { recursive: true });
  if (a.dry === true) {                                // what this end would file, changing nothing
    const key = filedKey(held, open, why);
    const d = decide(readJournal(join(dir, `${session}.journal`)), key, held, open, why);
    const r = d.file ? requestFor(open, held, why, new Date(snap.at), d.wasOpen) : null;
    if (r) { r.from = `laptop:${session}`; r.id = filingId(session!, d.n, key); }
    say(r ? JSON.stringify(r, null, 1) : "");
  }
  // Ends of one session take turns. Its snapshot is kept first, so one that can't get its turn
  // in time is filed by the next flush, at any session's start or end.
  const pending = writePending(dir, snap);
  const waitMs = Number(process.env.SESSION_END_WAIT_MS ?? 20_000);
  const waitFrom = Date.now();
  while (!claim(join(dir, `${session}.ending`))) {
    if (Date.now() - waitFrom > waitMs) say("Open steps not filed yet: another end of this session is filing; they go at the next session's start or end");
    await Bun.sleep(250);
  }
  lock = join(dir, `${session}.ending`);
  if (!existsSync(pending)) say(...flush(rec, dir).lines);   // a flush filed it meanwhile
  let r: { id: string | null; same: boolean };
  try { r = fileSnapshot(dir, snap); }
  catch (e) {
    say(`Open steps not filed: this session's journal couldn't be read (${(e as NodeJS.ErrnoException)?.code ?? e}); its snapshot is kept for the next start: ${pending}`);
  }
  rmSync(pending, { force: true });
  rmSync(lock, { force: true });                       // its turn is over: a flush may take others' snapshots
  lock = "";
  const done = flush(rec, dir);
  if (!r!.id) say(...done.lines);                      // nothing new to file: what waits still goes
  const mine = done.fates.get(r!.id!);
  const what = why === "open" ? (open.length ? `Open steps (${open.length})` : "That nothing is left open") : `That the session ended ${why === "unread" ? "unread" : "with no task list"}`;
  say(...done.lines.filter((l) => !l.startsWith("Submitted ")),
    mine === "submitted" ? `${what}: submitted to the record`
      : mine === "filed" ? `${what}: filed in the record`
      : mine === "aside" ? `${what}: kept aside, as above`
      : `${what}: waiting here, to go at the next session's start or end`);
}
