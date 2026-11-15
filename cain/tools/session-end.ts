// When a laptop session ends, what it left open goes into Cain's record, so no laptop thread
// lives outside the open list (org-v2 DESIGN 4.F; the registry's S-051). A Claude Code
// SessionEnd hook in the laptop's user settings:
//
//   bun cain/tools/session-end.ts --hook     (the hook's input: session_id, transcript_path)
//   bun cain/tools/session-end.ts --session <id> --transcript <path> [--record <clone>] [--dry]
//
// It replays the session's task list from its transcript (the app's update_plan, or
// TodoWrite), and reads the items the session holds. Steps not done are filed:
//   - on each item it holds, as a note ("the laptop session ended with these steps open");
//   - when it holds none, as one line appended to state/laptop-open.md, which Cain folds into
//     the open list at his next check-in.
// Nothing open, nothing filed. It never holds up the session's end: any failure is one line.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { args, check, clone, fetch, holdsAt, send, sessionOf } from "./record-lib.ts";

export interface Step { content: string; status: string }
const STATUSES = new Set(["pending", "in_progress", "completed"]);

// The task list as the session last left it, from its transcript's lines. update_plan's items
// replace the list; advance finishes the step in progress and starts the next; done and start
// mark steps by number (from 1); wrap_up finishes the step in progress. TodoWrite's todos
// replace the list.
export function stepsOf(lines: string[]): { steps: Step[]; first: string } {
  let steps: Step[] = [];
  let first = "";
  for (const l of lines) {
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    const content = o?.message?.content;
    if (!first && o?.type === "user" && o?.message?.role === "user") {
      const t = typeof content === "string" ? content : Array.isArray(content) ? content.find((c: any) => c?.type === "text")?.text : "";
      if (typeof t === "string" && t.trim() && !t.trim().startsWith("<")) first = t.trim().replace(/\s+/g, " ").slice(0, 100);
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use" || !c.input || typeof c.input !== "object") continue;
      const name = String(c.name ?? "");
      const i = c.input;
      if (name.endsWith("update_plan")) {
        if (Array.isArray(i.items)) steps = i.items.filter((s: any) => s && typeof s.content === "string")
          .map((s: any) => ({ content: s.content, status: STATUSES.has(s.status) ? s.status : "pending" }));
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
      } else if (name.endsWith("wrap_up")) {
        for (const s of steps) if (s.status === "in_progress") s.status = "completed";
      } else if (name === "TodoWrite" && Array.isArray(i.todos)) {
        steps = i.todos.filter((t: any) => t && typeof t.content === "string")
          .map((t: any) => ({ content: t.content, status: STATUSES.has(t.status) ? t.status : "pending" }));
      }
    }
  }
  return { steps, first };
}

const oneLine = (s: string, n: number) => s.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// The record request for what's open, or null when nothing is.
export function requestFor(session: string, open: Step[], held: string[], first: string, at = new Date()): any | null {
  if (!open.length) return null;
  const list = open.map((s) => oneLine(s.content, 120)).join("; ");
  const day = at.toISOString().slice(0, 10);
  const ops = held.length
    ? held.map((item) => ({ op: "note", item, text: oneLine(`The laptop session ended (${day}) with these steps open: ${list}. Its hold lapses in a day; take the item to carry them on.`, 1900) }))
    : [{ op: "append", path: "state/laptop-open.md", text: `- ${day} laptop session ${session}${first ? ` ("${oneLine(first, 100)}")` : ""}: ${oneLine(list, 1500)}\n` }];
  return { kind: "change", summary: oneLine(`A laptop session ended with ${open.length} step(s) open${held.length ? ` on ${held.join(", ")}` : ", on no item"}`, 200), ops };
}

if (import.meta.main) {
  const a = args(process.argv.slice(2), ["record", "session", "transcript"]);
  const say = (line: string): never => { if (line) console.log(line); process.exit(0); };
  let input: any = {};
  if (a.hook === true) { try { input = JSON.parse(await Bun.stdin.text()); } catch { /* none */ } }
  const session = sessionOf(a.session ?? input.session_id);
  const path = a.transcript ?? input.transcript_path;
  if (!session || !path) say("");
  let lines: string[] = [];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { say(""); }
  const { steps, first } = stepsOf(lines);
  const open = steps.filter((s) => s.status !== "completed");
  if (!open.length) say("");
  const c = clone(a.record ?? process.env.RECORD_CLONE);
  if ("error" in c) say(`Open steps not filed: ${c.error}`);
  const rec = c as Exclude<typeof c, { error: string }>;
  if (!fetch(rec)) say("Open steps not filed: couldn't fetch the record");
  const me = `laptop:${session}`;
  const held = Object.entries(holdsAt(rec)).filter(([, h]: [string, any]) => h?.holder === me).map(([item]) => item).sort();
  const req = requestFor(session!, open, held, first);
  if (!req) say("");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = randomBytes(3).toString("hex");
  req.from = me;
  req.id = `laptop-${stamp}-${session!.slice(0, 8)}-${rand}`;
  const raw = JSON.stringify(req, null, 1) + "\n";
  if (a.dry === true) say(raw);
  const r = check(raw, rec);
  if (r.state !== "ok" && r.state !== "waiting") say(`Open steps not filed: ${r.line}`);
  const s = send(rec, `${stamp}-${session}-${rand}.json`, raw, `Inbox: ${req.summary} (${req.id})`);
  say("error" in s ? `Open steps not filed: ${s.error}` : `Open steps filed in the record (${open.length})`);
}
