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
// Once only, and never lost: a filing's id comes from what it holds (the session, the items and
// the open steps), so two ends of the same session file the same request and the record keeper,
// which refuses an id it has seen, applies it once. A filing waits in an outbox in the record
// clone's .git folder (written whole, then moved in) until the keeper has logged it: sent, then
// kept until the keeper says done; sent again, as itself, if a day passes with no word. A filing
// the record refused, or an outbox file that can't be read, is moved aside with why, never
// deleted, and named at every session's start until a session deals with it. The lock between
// two ends of one session is best effort; the id is what makes a second harmless.
// It never holds up the session's end: any failure is one line.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

// One filing's identity: why, the items held and the open steps' whole words, in any order. With
// the session it makes the record request's id, so the keeper applies one filing once.
export const filedKey = (held: string[], open: Step[], why: Why = "open") =>
  createHash("sha1").update(JSON.stringify([why, [...held].sort(), open.map((s) => clean(s.content, 10_000)).sort()])).digest("hex").slice(0, 16);
export const filingId = (session: string, key: string) => `laptop-end-${session}-${key}`.slice(0, 80);

// The record request, or null when there's nothing to file: only on items the session holds.
export function requestFor(open: Step[], held: string[], why: Why = "open", at = new Date()): any | null {
  if (!held.length || (why === "open" && !open.length)) return null;
  const day = at.toISOString().slice(0, 10);
  const said = why === "open" ? `with these steps open: ${open.map((s) => clean(s.content, 120)).join("; ")}.`
    : why === "unread" ? "and its task list couldn't be read, so what it left open isn't known."
    : "and kept no task list, so what it left open isn't known.";
  const ops = held.map((item) => ({ op: "note", item, text: clean(`The laptop session ended (${day}) ${said} Its hold lapses in a day; take the item to carry it on.`, 1900) }));
  const what = why === "open" ? `with ${open.length} step(s) open` : why === "unread" ? "and its task list couldn't be read" : "with no task list";
  return { kind: "change", summary: clean(`A laptop session ended ${what} on ${held.join(", ")}`, 200), ops };
}

// What becomes of a filing in the outbox, from what the keeper has logged for its id: filed
// (done: it leaves the outbox), waiting (the keeper holds it behind one of Cain's jobs), refused
// (moved aside, with why), send (never sent), resend (sent a day ago, no word), or wait.
export type Fate = "filed" | "waiting" | "refused" | "send" | "resend" | "wait";
export function fate(states: string[], sent: boolean, sentAgoMs: number): Fate {
  if (states.includes("done")) return "filed";
  if (states.includes("waiting")) return "waiting";
  if (states.some((s) => s === "rejected" || s === "conflict" || s === "refused")) return "refused";
  if (!sent) return "send";
  return sentAgoMs > 86_400_000 ? "resend" : "wait";
}

// The folder for the outbox and each session's last filing: beside record-holds' memo, in the
// clone's .git folder.
export function memoDir(c: Clone): string {
  const gitDir = git(c.dir, ["rev-parse", "--git-dir"])?.trim() ?? ".git";
  return join(isAbsolute(gitDir) ? gitDir : join(c.dir, gitDir), "record-holds");
}

// A file whole or not at all: written beside, then moved in (a rename replaces it at once).
function writeWhole(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

// Best effort: one end of a session files at a time; a lock left by a process that died goes
// after 2 minutes. Two that slip past it file the same request, which the keeper applies once.
export function claim(lock: string, now = Date.now()): boolean {
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { /* held, or left */ }
  try { if (now - statSync(lock).mtimeMs < 120_000) return false; } catch { /* gone meanwhile */ }
  rmSync(lock, { force: true });
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}

// Puts one filing in the outbox, to be sent.
export function enqueue(dir: string, id: string, raw: string): void {
  mkdirSync(join(dir, "outbox"), { recursive: true });
  writeWhole(join(dir, "outbox", `${id}.json`), raw);
}

// A filing moved aside, with why: kept, never deleted, until a session deals with it.
function aside(dir: string, kind: "refused" | "unreadable", name: string, why: string): void {
  const to = join(dir, "outbox", kind);
  mkdirSync(to, { recursive: true });
  const base = name.replace(/\.(json|sent)$/, "");
  renameSync(join(dir, "outbox", name), join(to, `${base}.json`));
  writeFileSync(join(to, `${base}.why`), why + "\n");
}

// Works the outbox: sends what wasn't, settles what the keeper has logged, moves aside what it
// refused or what can't be read. Returns what to say: how many went, and every filing aside.
export function flush(rec: Clone, dir: string, now = Date.now()): string[] {
  const box = join(dir, "outbox");
  let names: string[] = [];
  try { names = readdirSync(box).filter((n) => n.endsWith(".json") || n.endsWith(".sent")).sort(); } catch { /* no outbox yet */ }
  let went = 0;
  for (const n of names) {
    const path = join(box, n);
    let raw = "", req: any = null;
    try { raw = readFileSync(path, "utf8"); req = JSON.parse(raw); } catch { /* below */ }
    if (!req || typeof req.id !== "string") { aside(dir, "unreadable", n, "this filing couldn't be read"); continue; }
    const sent = n.endsWith(".sent");
    let ago = 0;
    try { ago = now - statSync(path).mtimeMs; } catch { /* gone meanwhile */ }
    const logged = outcomes(rec, req.id) as any[];
    const f = fate(logged.map((o) => String(o.state)), sent, ago);
    if (f === "filed") { rmSync(path, { force: true }); continue; }
    if (f === "refused") {
      const last = logged.filter((o) => o.state !== "done").at(-1);
      aside(dir, "refused", n, `the record said ${last?.state ?? "no"}: ${last?.reason ?? last?.line ?? ""}`.trim());
      continue;
    }
    if (f !== "send" && f !== "resend") continue;
    if (!sent) {
      const r = check(raw, rec);
      if (r.state !== "ok" && r.state !== "waiting") { aside(dir, "refused", n, `the record would refuse it: ${r.line}`); continue; }
    }
    const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const s = send(rec, `${stamp}-${req.id}.json`, raw, `Inbox: ${req.summary ?? "a laptop session's end"} (${req.id}${sent ? ", sent again" : ""})`);
    if ("error" in s) break;                                       // offline: the rest waits too
    if (sent) { const t = new Date(now); utimesSync(path, t, t); }
    else renameSync(path, join(box, n.replace(/\.json$/, ".sent")));
    went++;
  }
  const out = went ? [`Filed ${went} from a laptop session's end`] : [];
  for (const kind of ["refused", "unreadable"] as const) {
    let held: string[] = [];
    try { held = readdirSync(join(box, kind)).filter((x) => x.endsWith(".json")).sort(); } catch { /* none */ }
    for (const x of held) {
      let why = "";
      try { why = readFileSync(join(box, kind, x.replace(/\.json$/, ".why")), "utf8").trim(); } catch { /* none */ }
      out.push(`A filing a laptop session left when it ended is kept aside, ${kind === "refused" ? `refused (${why})` : "unreadable"}: ${join(box, kind, x)}. File what it held another way, or drop it; then delete it.`);
    }
  }
  return out;
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
    let any = false;
    try { any = readdirSync(join(dir, "outbox"), { recursive: true }).some((x) => /\.(json|sent)$/.test(String(x))); } catch { /* none */ }
    if (!any) say("");                                 // at every start: nothing waiting, no network
    fetch(rec);
    say(...flush(rec, dir));
  }
  let input: any = {};
  if (a.hook === true) { try { input = JSON.parse(await Bun.stdin.text()); } catch { /* none */ } }
  const session = sessionOf(a.session ?? input.session_id);
  if (!session) say("");
  fetch(rec);                                          // offline: the holds as last fetched, and the outbox
  let lines: string[] | null = null;
  try { lines = readFileSync(a.transcript ?? input.transcript_path, "utf8").split("\n"); } catch { /* said on the items held */ }
  const { steps, planned } = stepsOf(lines ?? []);
  const open = steps.filter((s) => s.status !== "completed");
  const me = `laptop:${session}`;
  const held = Object.entries(holdsAt(rec)).filter(([, h]: [string, any]) => h?.holder === me).map(([item]) => item).sort();
  const why: Why = lines === null ? "unread" : !planned ? "unplanned" : "open";
  const req = requestFor(open, held, why);
  const key = req ? filedKey(held, open, why) : "";
  let last = "";
  try { last = readFileSync(join(dir, `${session}.ended`), "utf8").trim(); } catch { /* nothing filed yet */ }
  if (!req || last === key) say(...flush(rec, dir));  // nothing new: what waits still goes
  req.from = me;
  req.id = filingId(session!, key);
  const raw = JSON.stringify(req, null, 1) + "\n";
  if (a.dry === true) say(raw);
  mkdirSync(dir, { recursive: true });
  if (!claim(join(dir, `${session}.ending`))) say("");
  lock = join(dir, `${session}.ending`);
  const r = check(raw, rec);
  if (r.state !== "ok" && r.state !== "waiting") say(...flush(rec, dir), `Open steps not filed: ${r.line}`);
  enqueue(dir, req.id, raw);
  writeWhole(join(dir, `${session}.ended`), key);
  const said = flush(rec, dir);
  const sent = said.some((l) => l.startsWith("Filed "));
  say(...said.filter((l) => !l.startsWith("Filed ")),
    sent ? (why === "open" ? `Open steps filed in the record (${open.length})` : `Filed that the session ended ${why === "unread" ? "unread" : "with no task list"}`)
      : "Open steps not sent yet: they go at the next session's start or end");
}
