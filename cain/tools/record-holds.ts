// What a laptop session holds in Cain's record, for it to read at the start of each
// turn: its holds (item, branches, why), new notes on them (his words, or anyone's,
// filed since it last looked: read before changing the item), its takes still
// waiting behind one of Cain's jobs, and any hold of its that has ended since it
// last looked (a day without a word from it, or Dane moved it), so it doesn't act on
// an item that isn't its own any more. With --renew it also renews its holds, at
// most every 6 hours (a hold ends after a day), with renew ops: only the holder's
// own renew goes through, so a hold that moved is never taken back.
//
//   bun cain/tools/record-holds.ts [--session <id>] [--record <clone>] [--hook] [--renew]
//
// As a Claude Code hook (SessionStart, UserPromptSubmit) pass --hook: the session
// comes from the hook's input, it prints only when there's something to say, looks
// at GitHub at most every 30 seconds (RECORD_HOLDS_FETCH_S), and never blocks the prompt.
import { randomBytes } from "node:crypto";
import { args, check, clone, fetch, freshNotes, holdsAt, memo, noteLines, send, sessionOf, waitingFrom, when } from "./record-lib.ts";

const a = args(process.argv.slice(2), ["record", "session"]);
const hook = a.hook === true;
const quiet = (line: string, code = 0): never => { if (line) console.log(line); process.exit(hook ? 0 : code); };

let given: string | undefined = a.session;
if (hook) {
  try { given ??= JSON.parse(await Bun.stdin.text())?.session_id; } catch { /* no input */ }
}
const session = sessionOf(given);
if (!session) quiet(hook ? "" : "no session id: pass --session <id>, or run it from a Claude Code session", 2);
const where = a.record ?? process.env.RECORD_CLONE;
if (hook && !where) quiet("");   // the record tools aren't set up on this machine
const c = clone(where);
if ("error" in c) quiet(`Record holds not checked: ${c.error}`, 1);
const rec = c as Exclude<typeof c, { error: string }>;
const me = `laptop:${session}`;
const m = memo(rec, session!);
const was = m.read();
const now = Date.now();
if (!hook || now - was.fetched > Number(process.env.RECORD_HOLDS_FETCH_S ?? 30) * 1000) {
  if (!fetch(rec)) quiet("Record holds not checked: couldn't fetch the record", 1);
  was.fetched = now;
}

const holds = holdsAt(rec);
const mine = Object.entries(holds).filter(([, h]) => h.holder === me);
const ended = was.held.filter((id) => !mine.some(([k]) => k === id));
const waiting = waitingFrom(rec, me);
const out: string[] = [];
if (mine.length) {
  out.push(`Record holds for this session (${me}). Only these items' rows and branches are yours to change:`);
  for (const [id, h] of mine)
    out.push(`- ${id}, since ${when(h.taken)}${h.branches.length ? `; branches ${h.branches.join(", ")}` : ""}; for: ${h.for}`);
}
// Each note is shown once: the memo keeps the newest one shown per item.
out.push(...noteLines(freshNotes(rec, me, holds, mine.map(([k]) => k), was)));
for (const o of waiting) out.push(`Waiting: ${o.summary} (${o.id}) waits behind one of Cain's jobs. Don't act on it until it's done.`);
for (const id of ended)
  out.push(`Your hold on ${id} has ended (a day without a word from this session, or Dane moved it). Don't act on ${id} or push its branches unless Dane asks you to take it again and the take comes back done.`);
if (!out.length && !hook) out.push(`This session (${me}) holds nothing in the record.`);

// Renewed with renew ops: the keeper refuses one from anyone but the current holder,
// so a hold that moved or ended in the meantime is never taken back.
if (a.renew && mine.length && now - was.renewed > 6 * 3_600_000) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = randomBytes(3).toString("hex");
  const req = { id: `laptop-${stamp}-${session!.slice(0, 8)}-renew-${rand}`, from: me, kind: "change",
    summary: `Holds renewed: ${mine.map(([k]) => k).join(", ")}`, ops: mine.map(([k]) => ({ op: "renew", item: k })) };
  const raw = JSON.stringify(req, null, 1) + "\n";
  if (check(raw, rec).state === "ok" && !("error" in send(rec, `${stamp}-${session}-${rand}.json`, raw, `Inbox: ${req.summary} (${req.id})`)))
    was.renewed = now;
}
const held = mine.map(([k]) => k);
const seen = Object.fromEntries(Object.entries(was.seen).filter(([k]) => held.includes(k)));
m.write({ held, renewed: was.renewed, fetched: was.fetched, seen });
quiet(out.join("\n"));
