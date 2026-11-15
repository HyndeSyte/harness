// When a laptop session ends, what it left open goes into Cain's record (org-v2 DESIGN 4.F; the
// registry's S-051). This is the backstop, not the only home: a session that builds holds its
// item, so the item is on the open list from the start, and its hold lapses after a day without
// a word. A Claude Code SessionEnd hook in the laptop's user settings:
//
//   bun cain/tools/session-end.ts --hook     (the hook's input: session_id, transcript_path)
//   bun cain/tools/session-end.ts --session <id> --transcript <path> [--record <clone>] [--dry]
//   bun cain/tools/session-end.ts --flush    (a SessionStart hook: sends what an end couldn't)
//
// Give the hook a timeout of 30 (seconds): Claude Code allows a SessionEnd hook 1.5 seconds
// unless its timeout says more, and fetching and sending the record takes longer.
//
// It replays the session's task list from its transcript (the app's update_plan, or TodoWrite):
// only a step's own status says it's done, and a call that failed changes nothing. Then:
//   - on each item the session holds, a note: the steps still open; or, when the transcript
//     can't be read or kept no task list, that it ended without one;
//   - when it holds none, one line appended to state/laptop-open.md, which Cain's check-in
//     names until he has folded it into the open list: how many steps, never their words (a
//     session that holds no item isn't the harness's work, so what it was about stays on the
//     laptop, in the session, to resume there).
// On a held item only the steps' words go, with anything shaped like a key masked; never the
// chat itself. A session's process can end more than once (an idle stop, a /clear, a resume):
// the same filing is made once, and made again only if the record refused it or never logged it
// within a day. A filing that couldn't be sent waits in an outbox and goes at the next session's
// start or end, as the same request: the record keeper refuses an id it has seen, so a resend
// never files twice. The record clone's .git folder keeps all of it. One end at a time. It never
// holds up the session's end: any failure is one line.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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

// One filing: the items held and the open steps' whole words, in any order.
export const filedKey = (held: string[], open: Step[]) =>
  createHash("sha1").update(JSON.stringify([[...held].sort(), open.map((s) => clean(s.content, 10_000)).sort()])).digest("hex").slice(0, 16);

// The record request, or null when there's nothing to file. why: "open" (steps not done),
// "unread" (the transcript couldn't be read), "unplanned" (it kept no task list).
export function requestFor(session: string, open: Step[], held: string[], why: "open" | "unread" | "unplanned" = "open", at = new Date()): any | null {
  const day = at.toISOString().slice(0, 10);
  if (why === "open" && !open.length) return null;
  if (why !== "open" && !held.length) return null;
  const list = open.map((s) => clean(s.content, 120)).join("; ");
  const said = why === "open" ? `with these steps open: ${list}.`
    : why === "unread" ? "and its task list couldn't be read, so what it left open isn't known."
    : "and kept no task list, so what it left open isn't known.";
  const ops = held.length
    ? held.map((item) => ({ op: "note", item, text: clean(`The laptop session ended (${day}) ${said} Its hold lapses in a day; take the item to carry it on.`, 1900) }))
    : [{ op: "append", path: "state/laptop-open.md", text: `- ${day} laptop session ${session}: ${open.length} open step(s), their words kept on the laptop (resume the session there to see them)\n` }];
  const what = why === "open" ? `with ${open.length} step(s) open` : why === "unread" ? "and its task list couldn't be read" : "with no task list";
  return { kind: "change", summary: clean(`A laptop session ended ${what}${held.length ? ` on ${held.join(", ")}` : ", on no item"}`, 200), ops };
}

// Whether to file again what was filed last time this session ended: only if the record
// refused it, or hasn't logged it a day after it was sent.
export function fileAgain(states: string[], sentAt: number, now = Date.now()): boolean {
  if (states.some((s) => s === "done" || s === "waiting")) return false;
  if (states.some((s) => s === "rejected" || s === "conflict" || s === "refused")) return true;
  return now - sentAt > 86_400_000;
}

// Where a session's last filing and the outbox are kept: beside record-holds' memo, in the
// clone's .git folder.
function memoDir(c: Clone): string {
  const gitDir = git(c.dir, ["rev-parse", "--git-dir"])?.trim() ?? ".git";
  return join(isAbsolute(gitDir) ? gitDir : join(c.dir, gitDir), "record-holds");
}

// A lock only one process holds: made new, or taken over once it's 2 minutes old by moving the
// old one aside first (a rename only one process can make).
export function claim(lock: string, now = Date.now()): boolean {
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { /* held, or left */ }
  try { if (now - statSync(lock).mtimeMs < 120_000) return false; } catch { /* gone meanwhile */ }
  const aside = `${lock}.${process.pid}.${randomBytes(3).toString("hex")}`;
  try { renameSync(lock, aside); } catch { return false; }          // another took it first
  rmSync(aside, { force: true });
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}

// Sends what waits in the outbox: a request the keeper has logged is gone from it already; any
// other goes again, as itself. Returns how many went.
export function flush(rec: Clone, dir: string): number {
  const box = join(dir, "outbox");
  let names: string[] = [];
  try { names = readdirSync(box).filter((n) => n.endsWith(".json")).sort(); } catch { return 0; }
  if (!names.length || !claim(join(dir, "outbox.lock"))) return 0;
  let sent = 0;
  try {
    for (const n of names) {
      let raw = "";
      try { raw = readFileSync(join(box, n), "utf8"); } catch { continue; }
      let id = "", summary = "";
      try { ({ id, summary } = JSON.parse(raw)); } catch { rmSync(join(box, n), { force: true }); continue; }
      if (outcomes(rec, id).length) { rmSync(join(box, n), { force: true }); continue; }
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const s = send(rec, `${stamp}-${n.replace(/\.json$/, "")}-again.json`, raw, `Inbox: ${summary} (${id}, sent again)`);
      if ("error" in s) break;
      rmSync(join(box, n), { force: true });
      sent++;
    }
  } finally { rmSync(join(dir, "outbox.lock"), { force: true }); }
  return sent;
}

if (import.meta.main) {
  const a = args(process.argv.slice(2), ["record", "session", "transcript"]);
  let lock = "";
  const say = (line: string): never => {
    if (lock) rmSync(lock, { force: true });
    if (line) console.log(line);
    process.exit(0);
  };
  if (a.flush === true) {
    const c = clone(a.record ?? process.env.RECORD_CLONE);
    if ("error" in c) say("");
    const rec = c as Exclude<typeof c, { error: string }>;
    fetch(rec);
    const n = flush(rec, memoDir(rec));
    say(n ? `Filed ${n} left from a session's end` : "");
  }
  let input: any = {};
  if (a.hook === true) { try { input = JSON.parse(await Bun.stdin.text()); } catch { /* none */ } }
  const session = sessionOf(a.session ?? input.session_id);
  const path = a.transcript ?? input.transcript_path;
  if (!session) say("");
  let lines: string[] | null = null;
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { /* said below, if it holds anything */ }
  const { steps, planned } = stepsOf(lines ?? []);
  const open = steps.filter((s) => s.status !== "completed");
  const c = clone(a.record ?? process.env.RECORD_CLONE);
  if ("error" in c) say(open.length ? `Open steps not filed: ${c.error}` : "");
  const rec = c as Exclude<typeof c, { error: string }>;
  fetch(rec);                                          // offline: the holds as last fetched, and the outbox
  const me = `laptop:${session}`;
  const held = Object.entries(holdsAt(rec)).filter(([, h]: [string, any]) => h?.holder === me).map(([item]) => item).sort();
  const why = lines === null ? "unread" : !planned ? "unplanned" : "open";
  const req = requestFor(session!, open, held, why);
  if (!req) say("");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = randomBytes(3).toString("hex");
  req.from = me;
  req.id = `laptop-${stamp}-${session!.slice(0, 8)}-${rand}`;
  const raw = JSON.stringify(req, null, 1) + "\n";
  if (a.dry === true) say(raw);
  // One end of this session files at a time; a lock left by one that died goes after 2 minutes.
  const dir = memoDir(rec);
  mkdirSync(join(dir, "outbox"), { recursive: true });
  if (!claim(join(dir, `${session}.ending`))) say("");
  lock = join(dir, `${session}.ending`);
  flush(rec, dir);                                     // what an earlier end couldn't send
  const key = why === "open" ? filedKey(held, open) : `${why}:${held.join(",")}`;
  const ended = join(dir, `${session}.ended`);
  try {
    const [lastKey, lastId, lastAt] = readFileSync(ended, "utf8").trim().split(" ");
    if (lastKey === key && !fileAgain(outcomes(rec, lastId).map((o: any) => String(o.state)), Number(lastAt) || 0)) say("");
  } catch { /* nothing filed yet */ }
  const r = check(raw, rec);
  if (r.state !== "ok" && r.state !== "waiting") say(`Open steps not filed: ${r.line}`);
  const box = join(dir, "outbox", `${req.id}.json`);
  writeFileSync(box, raw);                             // kept until it's sent
  try { writeFileSync(ended, `${key} ${req.id} ${Date.now()}`); } catch { /* filed again next time */ }
  const s = send(rec, `${stamp}-${session}-${rand}.json`, raw, `Inbox: ${req.summary} (${req.id})`);
  if ("error" in s) say(`Open steps not sent yet (${s.error}): they go at the next session's start`);
  rmSync(box, { force: true });
  say(why === "open" ? `Open steps filed in the record (${open.length})` : `Filed that the session ended ${why === "unread" ? "unread" : "with no task list"}`);
}
