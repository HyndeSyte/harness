// The record keeper's rules, with no I/O, so they can be tested on their own.
// Every change to Cain's record (the private org repo) arrives as a small JSON
// "request". The keeper is the record's one writer: it applies requests one at a
// time, in order, and only when they still fit the record as it stands.
//
// Each item (a row of state/PENDING.md, like P33) has at most one holder: Cain, or
// one laptop session. Only the holder changes its row and pushes its branches. The
// keeper owns the list of holds (state/holds.json); requests change it only through
// take, pass and release. Anyone may file a note on any item (state/notes/<item>.md,
// also the keeper's own), so his words always reach its holder.
import { createHash } from "node:crypto";

export type RowField = "Item" | "Who" | "Next step" | "Waits for" | "Done when";

export type Op =
  | { op: "put"; path: string; content: string; base: string }        // base: blob sha, or "new"
  | { op: "append"; path: string; text: string }                      // add lines at the end
  | { op: "remove"; path: string; base: string; merged_into: string } // only as part of a merge
  | { op: "take"; item: string; for: string; branches?: string[]; job?: string }
  | { op: "pass"; item: string; to: string }
  | { op: "release"; item: string }
  | { op: "renew"; item: string }                                     // the holder only: never takes back a hold that moved
  | { op: "row"; item: string; base: string; set: Partial<Record<RowField, string>> }  // base: rowHash of the row as read
  | { op: "row-add"; item: string; cells: Partial<Record<RowField, string>> }
  | { op: "row-close"; item: string; evidence: string }
  | { op: "note"; item: string; text: string };                       // anyone, any item: kept for its holder

export type Request = {
  id: string;          // unique; the receipt Dane or Cain can look up
  from: string;        // cain | laptop:<session id> | page (Dane's page) | laptop (older requests)
  kind: "change" | "note";
  summary: string;     // one line, becomes the commit message
  ops?: Op[];          // kind "change"
  note?: { text: string; about?: string };  // kind "note": Dane's words from his page, for Cain
};

export type Outcome = {
  id: string; from: string; kind: string; summary: string;
  // refused: someone else holds the item. waiting: a take behind one of Cain's
  // running jobs; a second line with the same id says how it ended.
  state: "done" | "conflict" | "rejected" | "refused" | "waiting" | "relayed";
  reason?: string; at: string; commit?: string;
};

// One hold per item. holder: "cain" or "laptop:<session id>". for: his words, or
// the chat it came from. branches: exact branch names only the holder pushes.
// job: set only while one of Cain's Build or Ship jobs holds it (takes wait behind
// it). taken: when this holder got it. renewed: the holder's last word on it.
export type Hold = { holder: string; for: string; branches: string[]; job?: string; taken: string; renewed: string };
export type Holds = Record<string, Hold>;
export type Downtime = [string, string][];   // spans the keeper couldn't work (ISO from, to)

export const HOLDS_PATH = "state/holds.json";
export const PENDING_PATH = "state/PENDING.md";
export const HOLD_IDLE_MS = 24 * 3_600_000;   // a day without a word from the holder
export const notesPath = (item: string) => `state/notes/${item}.md`;
export const MAX_NOTE_TEXT = 2_000;           // characters in one note

// Where requests may write. log/ and inbox/ belong to the keeper itself; code,
// workflows and the repo's own settings are never written through requests.
// reviews/ holds outside-model reviews (written by the review runner, as Cain).
// state/holds.json is the keeper's own; requests change it only with take, pass and
// release. state/notes/ is the keeper's too: written only by the note op, so a note
// never conflicts with anything.
const WRITABLE = /^(areas|state|archive|rules|projects|reviews)\/[A-Za-z0-9._ \/&()-]+$/;
const KEEPERS = /^state\/(holds\.json|notes)(\/|$)/i;
const APPEND_ONLY = /(^|\/)decisions\.md$/i;

// Text that ends up in Cain's terminal: one line, no control characters, short.
export function clean(s: unknown, max = 160): string {
  let t = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0)!;
    t += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? " " : ch;
  }
  t = t.replace(/ {2,}/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
// Every segment a plain name: no "." or ".." (state/./PENDING.md is PENDING.md on
// disk, and would slip past every check made on the path as written), no empty
// segment, no space at either end of one.
const okSegments = (p: string) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s === s.trim());
const okPath = (p: string) => WRITABLE.test(p) && okSegments(p) && !KEEPERS.test(p) && !p.includes("..");
const NOTE = /^areas\/[^/]+\/notes\/.+\.md$/;
export const MAX_BYTES = 60_000;   // Notion pages died of size; nothing here grows that big

// Who may send what. Only Cain's local queue may speak for cain (main.ts checks
// where a request came from); a laptop session is laptop:<its Claude Code session id>.
// Plain "laptop" (older requests) and "claude-code" (an older writer) may write but
// can't hold. Who a request says it's from is taken as said: holds guard against
// accidents, not against a writer set on pretending.
const SESSION = /^laptop:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isHolder = (s: unknown): s is string => s === "cain" || (typeof s === "string" && SESSION.test(s));
export const knownSender = (s: unknown): boolean => s === "page" || s === "laptop" || s === "claude-code" || isHolder(s);
export const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const NEVER_HELD = new Set(["main", "master", "HEAD"]);
export function okBranch(b: unknown): b is string {
  return typeof b === "string" && b.length <= 200 && /^[A-Za-z0-9._\/-]+$/.test(b) && !NEVER_HELD.has(b)
    && !/^[-\/.]|[\/.]$|\.\.|\/\/|\/\.|\.lock(\/|$)/.test(b);
}
export const ROW_FIELDS: RowField[] = ["Item", "Who", "Next step", "Waits for", "Done when"];
const MAX_CELL = 8_000;

// A table cell: one line, no column breaks.
function cellProblem(v: unknown): string | null {
  if (typeof v !== "string") return "a cell must be text";
  if (/[|\u0000-\u001f\u007f\u2028\u2029]/.test(v)) return "a cell can't hold | or a new line";
  if (v.length > MAX_CELL) return `a cell is over ${MAX_CELL} characters`;
  return null;
}
function cellsProblem(o: any, key: "set" | "cells", need: RowField[]): string | null {
  const v = o[key];
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length === 0) return `${o.op} ${o.item}: needs ${key}`;
  for (const k of Object.keys(v)) {
    if (!ROW_FIELDS.includes(k as RowField)) return `${o.op} ${o.item}: ${clean(k, 40)} isn't a column it can set (${ROW_FIELDS.join(", ")})`;
    const why = cellProblem(v[k]);
    if (why) return `${o.op} ${o.item} ${k}: ${why}`;
  }
  for (const k of need) if (!(typeof v[k] === "string" && v[k].trim())) return `${o.op} ${o.item}: needs ${k}`;
  return null;
}

export function parseRequest(raw: string): { req?: Request; error?: string } {
  let j: any;
  try { j = JSON.parse(raw); } catch { return { error: "not JSON" }; }
  if (!j || typeof j !== "object") return { error: "not an object" };
  if (typeof j.id !== "string" || !/^[A-Za-z0-9._:-]{6,80}$/.test(j.id)) return { error: "bad id" };
  if (typeof j.from !== "string" || !j.from) return { error: "missing from" };
  if (j.kind !== "change" && j.kind !== "note") return { error: "kind must be change or note" };
  if (typeof j.summary !== "string" || !j.summary.trim() || j.summary.length > 200) return { error: "summary must be one short line" };
  // From here the request is identifiable, so errors keep it (its id and sender
  // go into the log and the reply).
  const req = j as Request;
  if (!knownSender(j.from)) return { req, error: "from must be cain or laptop:<session id> (or page, for Dane's page)" };
  if (j.kind === "note") {
    if (!j.note || typeof j.note.text !== "string" || !j.note.text.trim()) return { req, error: "note needs text" };
    return { req };
  }
  if (!Array.isArray(j.ops) || j.ops.length === 0 || j.ops.length > 50) return { req, error: "change needs 1 to 50 ops" };
  for (const o of j.ops) {
    if (!o || typeof o !== "object") return { req, error: "an op must be an object" };
    if (["take", "pass", "release", "renew", "row", "row-add", "row-close", "note"].includes(o.op)) {
      if (typeof o.item !== "string" || !ITEM.test(o.item)) return { req, error: `${o.op}: needs an item id, like P33` };
      o.item = o.item.toUpperCase();   // p33 and P33 are one item, with one hold
      const why = itemOpProblem(o);
      if (why) return { req, error: why };
      continue;
    }
    if (typeof o.path !== "string") return { req, error: "op without a path" };
    if (!["put", "append", "remove"].includes(o.op)) return { req, error: "unknown op" };
    if (!okPath(o.path)) return { req, error: `${clean(o.path, 80)}: not a place requests may write` };
    if (o.op === "put" && (typeof o.content !== "string" || typeof o.base !== "string")) return { req, error: `put ${o.path}: needs content and base` };
    if (o.op === "put" && o.content.trim() === "") return { req, error: `put ${o.path}: empty content; removing a file is only done as part of a merge` };
    if (o.op === "append" && (typeof o.text !== "string" || !o.text.trim())) return { req, error: `append ${o.path}: needs text` };
    if (o.op === "remove" && (typeof o.base !== "string" || typeof o.merged_into !== "string" || !okPath(o.merged_into))) return { req, error: `remove ${o.path}: needs base and an allowed merged_into` };
  }
  return { req };
}

function itemOpProblem(o: any): string | null {
  switch (o.op) {
    case "take":
      if (typeof o.for !== "string" || !o.for.trim()) return `take ${o.item}: needs for (his words, or the chat it came from)`;
      if (o.branches !== undefined && (!Array.isArray(o.branches) || o.branches.length > 20 || !o.branches.every(okBranch)
        || new Set(o.branches).size !== o.branches.length)) return `take ${o.item}: branches must be up to 20 exact branch names, never main`;
      if (o.job !== undefined && (typeof o.job !== "string" || !o.job.trim() || o.job.length > 80)) return `take ${o.item}: job must be a short line`;
      return null;
    case "pass":
      return isHolder(o.to) ? null : `pass ${o.item}: to must be cain or laptop:<session id>`;
    case "release":
    case "renew":
      return null;
    case "row":
      if (typeof o.base !== "string" || !/^[0-9a-f]{40}$/.test(o.base)) return `row ${o.item}: needs base, the row's hash as read`;
      return cellsProblem(o, "set", []);
    case "row-add":
      return cellsProblem(o, "cells", ["Item"]);
    case "row-close": {
      if (typeof o.evidence !== "string" || !o.evidence.trim()) return `row-close ${o.item}: needs evidence`;
      const why = cellProblem(o.evidence);
      return why ? `row-close ${o.item} evidence: ${why}` : null;
    }
    case "note": {
      if (typeof o.text !== "string" || !o.text.trim()) return `note ${o.item}: needs text`;
      if (o.text.length > MAX_NOTE_TEXT) return `note ${o.item}: over ${MAX_NOTE_TEXT} characters`;
      const why = cellProblem(o.text);
      return why ? `note ${o.item}: ${why}` : null;
    }
  }
  return "unknown op";
}

// What the keeper needs to know about the record as it stands.
export interface Tree {
  sha(path: string): string | null;      // git blob sha, or null if absent
  read(path: string): string | null;
  isDir?(path: string): boolean;
  blob?(sha: string): string | null;     // an earlier version, by its blob sha
}

// ---- Holds ----

// How long a hold has gone without a word from its holder, not counting time the
// keeper itself was down (nobody could renew then).
export function idleMs(h: Hold, at: Date, downtime: Downtime = []): number {
  const from = Date.parse(h.renewed), to = at.getTime();
  let idle = to - from;
  for (const [a, b] of downtime) {
    const s = Math.max(from, Date.parse(a)), e = Math.min(to, Date.parse(b));
    if (e > s) idle -= e - s;
  }
  return idle;
}
export const expired = (h: Hold, at: Date, downtime: Downtime = []) => !(idleMs(h, at, downtime) <= HOLD_IDLE_MS);

// The holds file, always written the same way, so a changed copy is easy to see.
export function holdsText(holds: Holds): string {
  const out: Record<string, Hold> = {};
  for (const k of Object.keys(holds).sort()) {
    const h = holds[k];
    out[k] = { holder: h.holder, for: h.for, branches: [...h.branches], ...(h.job ? { job: h.job } : {}), taken: h.taken, renewed: h.renewed };
  }
  return JSON.stringify(out, null, 2) + "\n";
}

// Reads a holds file, keeping only well-formed holds; null when it isn't a holds file at all.
export function parseHolds(text: string | null): Holds | null {
  if (text === null) return null;
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const out: Holds = {};
  for (const [k, h] of Object.entries<any>(j)) {
    if (!ITEM.test(k) || !h || typeof h !== "object" || !isHolder(h.holder) || typeof h.for !== "string") continue;
    if (!Array.isArray(h.branches) || !h.branches.every(okBranch)) continue;
    if (Number.isNaN(Date.parse(h.taken)) || Number.isNaN(Date.parse(h.renewed))) continue;
    out[k] = { holder: h.holder, for: h.for, branches: [...h.branches], ...(typeof h.job === "string" && h.job && h.holder === "cain" ? { job: h.job } : {}), taken: h.taken, renewed: h.renewed };
  }
  return out;
}

const citesDane = (f: string) => /^\s*dane:/i.test(f);
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

// ---- The open list (state/PENDING.md) ----

// A row's hash, for row edits: sha1 of the row's line as read, without its line ending.
export function rowHash(line: string): string {
  return createHash("sha1").update(line.replace(/\r$/, ""), "utf8").digest("hex");
}

export function cells(line: string): string[] {
  let l = line.replace(/\r$/, "").trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}
const renderRow = (cs: string[], cr: boolean) => "|" + cs.map((c) => (c ? ` ${c} ` : " ")).join("|") + "|" + (cr ? "\r" : "");
const bare = (l: string) => l.replace(/\s+$/, "");

type Span = { head: number; body: number; end: number };   // header line, first row, one past the last row
type Doc = { lines: string[]; open: Span | null; done: Span | null };

// The first table under a "## <name>" heading, before the next heading.
function tableUnder(lines: string[], name: string): Span | null {
  const heading = new RegExp(`^##\\s+${name}\\s*$`, "i");
  let i = lines.findIndex((l) => heading.test(l.replace(/\r$/, "")));
  if (i < 0) return null;
  for (i++; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "");
    if (/^#{1,6}\s/.test(l)) return null;
    if (l.startsWith("|")) break;
  }
  if (i + 1 >= lines.length || !/^\|[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1].replace(/\r$/, ""))) return null;
  let end = i + 2;
  while (end < lines.length && lines[end].replace(/\r$/, "").startsWith("|")) end++;
  return { head: i, body: i + 2, end };
}

function parsePending(text: string): Doc {
  const lines = text.split("\n");
  return { lines, open: tableUnder(lines, "Open"), done: tableUnder(lines, "Done") };
}

// Each open row's line, by its ID (a list, so a doubled ID shows).
export function openRows(text: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (text === null) return out;
  const d = parsePending(text);
  if (!d.open) return out;
  for (let i = d.open.body; i < d.open.end; i++) {
    const id = cells(d.lines[i])[0];
    if (id) out.set(id, [...(out.get(id) ?? []), bare(d.lines[i])]);
  }
  return out;
}

// The IDs whose open row is added, removed or edited between two versions.
export function changedRows(before: string | null, after: string | null): string[] {
  const a = openRows(before), b = openRows(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => (a.get(id) ?? []).join("\n") !== (b.get(id) ?? []).join("\n"));
}

type Edit = { text: string } | { conflict: string } | { rejected: string };

function findRow(d: Doc, id: string): number | Edit {
  if (!d.open) return { rejected: `${PENDING_PATH} has no open table` };
  const at: number[] = [];
  for (let i = d.open.body; i < d.open.end; i++) if (cells(d.lines[i])[0] === id) at.push(i);
  if (at.length > 1) return { rejected: `${id} is in the open table twice` };
  if (at.length === 0) return { conflict: `${id} isn't an open row in ${PENDING_PATH} (closed, or not added yet)` };
  return at[0];
}

function columns(d: Doc): string[] { return cells(d.lines[d.open!.head]); }

// A row with an escaped pipe can't be split into its cells safely: it is changed
// with a put of the whole file instead.
const ESCAPED_PIPE = "\\|";
const escaped = (line: string, id: string): Edit | null =>
  line.includes(ESCAPED_PIPE) ? { rejected: `${id} has an escaped | in it; change it with a put of the whole file` } : null;

// An open row as it stands (its line, without the line ending), when there's exactly one.
export function openRow(text: string | null, id: string): string | null {
  if (text === null) return null;
  const d = parsePending(text);
  const i = findRow(d, id);
  return typeof i === "number" ? d.lines[i].replace(/\r$/, "") : null;
}

export function editRow(text: string, id: string, base: string, set: Partial<Record<RowField, string>>): Edit {
  const d = parsePending(text);
  const i = findRow(d, id);
  if (typeof i !== "number") return i;
  if (rowHash(d.lines[i]) !== base) return { conflict: `${id} changed since it was read` };
  const esc = escaped(d.lines[i], id);
  if (esc) return esc;
  const cols = columns(d);
  const cs = cells(d.lines[i]);
  while (cs.length < cols.length) cs.push("");
  for (const [k, v] of Object.entries(set)) {
    const c = cols.indexOf(k);
    if (c < 0) return { rejected: `the open table has no ${k} column` };
    cs[c] = v!.trim();
  }
  d.lines[i] = renderRow(cs, d.lines[i].endsWith("\r"));
  return { text: d.lines.join("\n") };
}

export function addRow(text: string, id: string, given: Partial<Record<RowField, string>>, since: string): Edit {
  const d = parsePending(text);
  if (!d.open) return { rejected: `${PENDING_PATH} has no open table` };
  const cols = columns(d);
  if (cols[0] !== "ID") return { rejected: "the open table's first column isn't ID" };
  if (openRows(text).has(id)) return { conflict: `${id} is already in the open table; take the next free ID` };
  if (d.done) for (let i = d.done.body; i < d.done.end; i++) {
    const first = cells(d.lines[i])[0];
    if (first === id || first.startsWith(`${id} `)) return { conflict: `${id} was used before (it's in Done); take the next free ID` };
  }
  for (const k of Object.keys(given)) if (!cols.includes(k)) return { rejected: `the open table has no ${k} column` };
  const cs = cols.map((c) => (c === "ID" ? id : c === "Since" ? since : (given as any)[c]?.trim() ?? ""));
  const last = d.lines[d.open.end - 1];
  d.lines.splice(d.open.end, 0, renderRow(cs, last.endsWith("\r")));
  return { text: d.lines.join("\n") };
}

export function closeRow(text: string, id: string, evidence: string, date: string): Edit {
  const d = parsePending(text);
  const i = findRow(d, id);
  if (typeof i !== "number") return i;
  const esc = escaped(d.lines[i], id);
  if (esc) return esc;
  const cr = d.lines[i].endsWith("\r");
  const item = cells(d.lines[i])[columns(d).indexOf("Item")] ?? "";
  const row = renderRow([`${id} ${item}: ${evidence.trim()}`.replace(/ {2,}/g, " "), date], cr);
  const lines = d.lines;
  lines.splice(i, 1);
  if (d.done) {
    const at = d.done.body > i ? d.done.body - 1 : d.done.body;   // newest first
    lines.splice(at, 0, row);
  } else {
    const nl = cr ? "\r" : "";
    const tail = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, ...[nl, `## Done${nl}`, nl, `| Item | Date |${nl}`, `|---|---|${nl}`, row]);
  }
  return { text: lines.join("\n") };
}

// An item the record knows: an open row, or one that went to Done.
export function itemKnown(text: string | null, id: string): boolean {
  if (text === null) return false;
  if (openRows(text).has(id)) return true;
  const d = parsePending(text);
  if (d.done) for (let i = d.done.body; i < d.done.end; i++) {
    const first = cells(d.lines[i])[0];
    if (first === id || first.startsWith(`${id} `)) return true;
  }
  return false;
}

// ---- Notes: words about an item for whoever holds it (state/notes/<item>.md) ----

export type Note = { when: string; from: string; text: string };
const NOTE_ROW = /^\|\s*\d{4}-\d\d-\d\dT[^|]*\|/;

// One more note at the end, with when and who. His words always land: a file past
// the size limit drops its oldest notes (git keeps them), never the new one.
export function addNote(before: string | null, item: string, at: string, from: string, text: string): string {
  let out = before ?? `# Notes on ${item}\n\nWords about ${item} for whoever holds it, oldest first, filed by the record keeper from note requests. Its holder reads new ones before changing ${item}.\n\n| When | From | Note |\n|---|---|---|\n`;
  if (!out.endsWith("\n")) out += "\n";
  out += renderRow([at, from, text.trim()], false) + "\n";
  const lines = out.split("\n");
  for (let i = 0; Buffer.byteLength(lines.join("\n")) > MAX_BYTES && i < lines.length - 2;) {
    if (NOTE_ROW.test(lines[i])) lines.splice(i, 1);
    else i++;
  }
  return lines.join("\n");
}

// The notes in a notes file, oldest first. "when" is the keeper's ISO time, so notes
// compare as text.
export function noteRows(text: string | null): Note[] {
  const out: Note[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!NOTE_ROW.test(line)) continue;
    const [when, from, ...rest] = cells(line);
    out.push({ when, from, text: rest.join(" | ") });
  }
  return out;
}

// A whole-file put of PENDING.md made from an older version: its row changes are
// laid onto the list as it stands now, so edits to different rows never conflict.
// Returns the merged text, or why it can't (both sides changed the same row, or the
// same text outside the tables).
export function mergePending(base: string | null, theirs: string, mine: string): string | { why: string } {
  if (base === null) return { why: "the version it was made from isn't known" };
  const B = split(base), C = split(theirs), M = split(mine);
  if (!B || !C || !M) return { why: "the open table couldn't be read" };
  if (B.hasDone !== C.hasDone || B.hasDone !== M.hasDone) return { why: "the Done table was added or removed" };
  const pick = <T>(b: T, c: T, m: T, eq: (x: T, y: T) => boolean): T | undefined | "both" =>
    eq(m, b) ? c : eq(c, b) ? m : eq(c, m) ? c : "both";
  const sameLines = (x: string[], y: string[]) => x.map(bare).join("\n") === y.map(bare).join("\n");
  const text: Record<"pre" | "mid" | "post", string[]> = { pre: [], mid: [], post: [] };
  for (const k of ["pre", "mid", "post"] as const) {
    const r = pick(B[k], C[k], M[k], sameLines);
    if (r === "both") return { why: "both changed the text around the tables" };
    text[k] = r as string[];
  }
  // Open rows, by ID, in the order they stand now; rows only this writer added go
  // after the row they followed.
  const row = (m: Map<string, string>, id: string) => m.get(id);
  const sameRow = (x: string | undefined, y: string | undefined) => (x === undefined ? y === undefined : y !== undefined && bare(x) === bare(y));
  const out: string[] = [];
  const ids: string[] = [...C.order];
  for (const id of M.order) if (!C.rows.has(id) && !B.rows.has(id)) {
    const prev = M.order.slice(0, M.order.indexOf(id)).reverse().find((p) => ids.includes(p));
    ids.splice(prev === undefined ? 0 : ids.indexOf(prev) + 1, 0, id);
  }
  for (const id of B.order) if (!C.rows.has(id) && M.rows.has(id) && !sameRow(row(B.rows, id), row(M.rows, id)))
    return { why: `${id} was closed or removed since it was read` };
  for (const id of ids) {
    const r = pick(row(B.rows, id), row(C.rows, id), row(M.rows, id), sameRow);
    if (r === "both") return { why: `both changed ${id}` };
    if (r !== undefined) out.push(r as string);
  }
  // Done rows: what this writer added goes in (where it put them: top or bottom);
  // what it took out comes out.
  let done = C.done;
  if (!sameLines(M.done, B.done)) {
    if (sameLines(C.done, B.done)) done = M.done;
    else {
      const inB = new Set(B.done.map(bare)), inM = new Set(M.done.map(bare)), inC = new Set(C.done.map(bare));
      const added = M.done.filter((l) => !inB.has(bare(l)) && !inC.has(bare(l)));
      const kept = C.done.filter((l) => !(inB.has(bare(l)) && !inM.has(bare(l))));
      const atTop = added.length > 0 && M.done.slice(0, added.length).every((l) => added.includes(l));
      done = atTop ? [...added, ...kept] : [...kept, ...added];
    }
  }
  return [...text.pre, ...out, ...text.mid, ...done, ...text.post].join("\n");
}

function split(text: string) {
  const d = parsePending(text);
  if (!d.open || (d.done && d.done.head < d.open.end)) return null;
  const L = d.lines, o = d.open, dn = d.done;
  const rows = new Map<string, string>(), order: string[] = [];
  for (let i = o.body; i < o.end; i++) {
    const id = cells(L[i])[0];
    if (!id || rows.has(id)) return null;
    rows.set(id, L[i]); order.push(id);
  }
  return {
    pre: L.slice(0, o.body), rows, order,
    mid: L.slice(o.end, dn ? dn.body : L.length),
    done: dn ? L.slice(dn.body, dn.end) : [],
    post: dn ? L.slice(dn.end) : [],
    hasDone: !!dn,
  };
}

// "Nov 11", as the open list writes its dates.
export function shortDate(at: Date, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(at);
}

// ---- The plan ----

export type PlanContext = {
  at: Date;               // the cycle's clock: taken/renewed stamps, expiry, dates
  holds?: Holds;          // the keeper's own copy
  downtime?: Downtime;    // keeper downtime, which doesn't count toward a hold's idle day
  tz?: string;            // for the dates written in the open list
};
export type Plan =
  | { state: "ok"; writes: Map<string, string | null>; holds: Holds; holdsChanged: boolean }
  | { state: "conflict" | "rejected" | "refused" | "waiting"; reason: string };

// Checks a change against the record and returns the files to write, or why not.
// "conflict" means the record moved on since the writer read it: Cain redoes it.
// "rejected" means the change breaks a rule: it would never be right.
// "refused" means someone else holds the item it touches.
// "waiting" means a take arrived while one of Cain's jobs holds the item: the
// keeper keeps it and plans it again when the job's hold ends.
export function plan(req: Request, tree: Tree, ctx: PlanContext): Plan {
  const at = ctx.at, iso = at.toISOString(), downtime = ctx.downtime ?? [];
  const sender = req.from;
  // An expired hold is as good as gone.
  const holds: Holds = {};
  for (const [k, h] of Object.entries(ctx.holds ?? {}))
    if (!expired(h, at, downtime)) holds[k] = { ...h, branches: [...h.branches] };
  const writes = new Map<string, string | null>();   // null = delete
  const current = (p: string) => writes.has(p) ? writes.get(p)! : tree.read(p);
  const touched = new Set<string>();   // the sender's own held rows it changed: renewed
  let explicit = false;                // a take, pass, release or renew went through
  let wait: string | null = null;
  const refused = (reason: string): Plan => ({ state: "refused", reason });
  const rejected = (reason: string): Plan => ({ state: "rejected", reason });
  const conflict = (reason: string): Plan => ({ state: "conflict", reason });
  const heldBy = (id: string) => `${id} is held by ${holds[id].holder}${holds[id].job ? ` (a job: ${holds[id].job})` : ""}`;
  // Any change to the open list is checked row by row: a row someone else holds is
  // theirs, and an open row nobody holds is Cain's, so anyone else takes it before
  // changing it (a new row is anyone's to add). Every such row is named, so a writer
  // can leave them all out at once.
  const rowsOk = (before: string | null, after: string | null): string | null => {
    const theirs: string[] = [], was = openRows(before);
    for (const id of changedRows(before, after)) {
      const h = holds[id];
      if (h) {
        if (h.holder !== sender) theirs.push(heldBy(id));
        else touched.add(id);
      } else if (sender !== "cain" && was.has(id)) theirs.push(`${id} is Cain's (nobody holds it); take it first`);
    }
    return theirs.length ? theirs.join("; ") : null;
  };

  for (const o of req.ops ?? []) {
    if (o.op === "take" || o.op === "pass" || o.op === "release" || o.op === "renew") {
      if (!isHolder(sender)) return rejected(`${o.op} needs a sender of cain or laptop:<session id>`);
      const id = o.item, h = holds[id];
      if (o.op === "take") {
        if (o.job !== undefined && sender !== "cain") return rejected("only Cain's own jobs are marked job");
        if (!h && !itemKnown(current(PENDING_PATH), id)) return rejected(`${id} isn't an item in the record; add its row first (row-add), then take it`);
        const branches = o.branches ?? [];
        let carried: string[] = [];
        if (h && h.holder === sender) {
          carried = h.branches;   // its own hold again: a renewal, and any new branches
        } else if (h && h.job) {
          // One of Cain's jobs is running on it: wait until it ends, then the take
          // is planned again as if the item were free (checked that way now too).
          wait ??= `${heldBy(id)}; this take waits until the job's hold ends`;
        } else if (h && !citesDane(o.for)) {
          return refused(heldBy(id));
        } else if (h) {
          carried = h.branches;   // Dane's word moves the hold, with its branches
        }
        for (const b of branches) for (const [k, other] of Object.entries(holds))
          if (k !== id && other.branches.includes(b)) return refused(`branch ${b} is already held, with ${k} (by ${other.holder})`);
        const job = o.job !== undefined ? clean(o.job, 80) : h && h.holder === sender ? h.job : undefined;
        holds[id] = {
          holder: sender, for: h && h.holder === sender ? h.for : clean(o.for, 300), branches: union(carried, branches),
          ...(job ? { job } : {}),
          taken: h && h.holder === sender ? h.taken : iso, renewed: iso,
        };
      } else {
        if (!h) return rejected(`${id} isn't held; nothing to ${o.op}`);
        if (h.holder !== sender) return refused(heldBy(id));
        if (o.op === "renew") {
          // Only the hold as it stands is renewed: one that moved or ended is never taken back.
          holds[id] = { ...h, renewed: iso };
        } else if (o.op === "pass") {
          if (o.to === sender) return rejected(`${id} is already yours`);
          // Atomic: the hold and its branches move in one step. A job's mark stays behind.
          holds[id] = { holder: o.to, for: h.for, branches: [...h.branches], taken: iso, renewed: iso };
          touched.delete(id);
        } else {
          delete holds[id];
          touched.delete(id);
        }
      }
      explicit = true;
      continue;
    }

    if (o.op === "note") {
      // His words always land: anyone files a note on any item, held or free, and its
      // holder reads it before changing the item. Only this op writes the file.
      const id = o.item, p = notesPath(id);
      if (!holds[id] && !itemKnown(current(PENDING_PATH), id)) return rejected(`${id} isn't an item in the record`);
      if (tree.isDir?.(p)) return rejected(`${p}: is a folder`);
      writes.set(p, addNote(current(p), id, iso, sender, o.text));
      if (holds[id]?.holder === sender) touched.add(id);
      continue;
    }

    if (o.op === "row" || o.op === "row-add" || o.op === "row-close") {
      const id = o.item, h = holds[id];
      if (h && h.holder !== sender) return refused(heldBy(id));
      const before = current(PENDING_PATH);
      if (before === null) return rejected(`${PENDING_PATH} doesn't exist`);
      const e = o.op === "row" ? editRow(before, id, o.base, o.set)
        : o.op === "row-add" ? addRow(before, id, o.cells, shortDate(at, ctx.tz))
        : closeRow(before, id, o.evidence, shortDate(at, ctx.tz));
      if ("conflict" in e) return conflict(e.conflict);
      if ("rejected" in e) return rejected(e.rejected);
      const why = rowsOk(before, e.text);
      if (why) return refused(why);
      writes.set(PENDING_PATH, e.text);
      if (Buffer.byteLength(e.text) > MAX_BYTES) return rejected(`${PENDING_PATH}: over ${MAX_BYTES / 1000} KB; split it into topics`);
      continue;
    }

    const p = o.path;
    if (!okPath(p)) return rejected(`${clean(p, 80)}: not a place requests may write`);
    if (tree.isDir?.(p)) return rejected(`${p}: is a folder`);
    const before = current(p);
    if (o.op === "put") {
      if (APPEND_ONLY.test(p) && tree.read(p) !== null) return rejected(`${p}: decisions are only ever added to`);
      const have = tree.sha(p);
      const stale = o.base === "new" ? have !== null : o.base !== have;
      const madeFrom = stale && /^[0-9a-f]{40}$/.test(o.base) ? tree.blob?.(o.base) ?? null : null;
      let content = o.content;
      if (p === PENDING_PATH) {
        // The rows it means to change (against the version it was made from): any
        // that someone else holds refuse it, however old its base.
        const why = rowsOk(stale ? madeFrom ?? before : before, o.content);
        if (why) return refused(why);
      }
      if (stale) {
        // The open list made from an older version: laid onto the list as it stands
        // when the rows it changed haven't changed since.
        const m = p === PENDING_PATH && before !== null ? mergePending(madeFrom, before, o.content) : null;
        if (typeof m !== "string") return conflict(`${p}: changed since it was read${m ? ` (${m.why})` : ""}`);
        content = m;
      }
      if (NOTE.test(p)) {
        const why = noteProblem(content);
        if (why) return rejected(`${p}: ${why}`);
      }
      writes.set(p, content);
    } else if (o.op === "append") {
      if (NOTE.test(p) && before === null) return rejected(`${p}: a new note is made with put, with its front matter`);
      const was = before ?? "";
      const sep = was === "" || was.endsWith("\n") ? "" : "\n";
      writes.set(p, was + sep + o.text.replace(/\n*$/, "\n"));
    } else if (o.op === "remove") {
      if (tree.sha(p) !== o.base) return conflict(`${p}: changed since it was read`);
      writes.set(p, null);
    }
    if (p === PENDING_PATH) {
      const why = rowsOk(before, writes.get(p)!);
      if (why) return refused(why);
    }
    const w = writes.get(p);
    if (w && Buffer.byteLength(w) > MAX_BYTES) return rejected(`${p}: over ${MAX_BYTES / 1000} KB; split it into topics`);
  }
  // A removal is only ever the losing side of a merge: the survivor must exist
  // after this change and say, in its replaces field, that it absorbed the loser.
  for (const o of req.ops ?? []) {
    if (o.op !== "remove") continue;
    const survivor = current(o.merged_into);
    if (!survivor) return rejected(`${o.path}: merged_into ${o.merged_into} doesn't exist`);
    if (!frontMatter(survivor).replaces.includes(o.path))
      return rejected(`${o.path}: ${o.merged_into} must list it under replaces`);
  }
  // A change that changes nothing would be logged as done for nothing.
  if (!explicit && ![...writes].some(([p, c]) => c !== tree.read(p))) return rejected("changes nothing");
  if (wait) return { state: "waiting", reason: wait };
  // The holder's word on its own row renews its hold.
  for (const id of touched) if (holds[id]?.holder === sender) holds[id].renewed = iso;
  return { state: "ok", writes, holds, holdsChanged: holdsText(holds) !== holdsText(ctx.holds ?? {}) };
}

export function frontMatter(text: string): { id?: string; title?: string; sources: string[]; replaces: string[]; aliases: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { sources: [] as string[], replaces: [] as string[], aliases: [] as string[] } as any;
  if (!m) return out;
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (["sources", "replaces", "aliases"].includes(key)) {
        if (v.startsWith("[")) out[key] = v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        else if (v) out[key] = [v.replace(/^["']|["']$/g, "")];
      } else if (v) out[key] = v.replace(/^["']|["']$/g, "");
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && Array.isArray(out[key])) out[key].push(item[1].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

function noteProblem(text: string): string | null {
  const fm = frontMatter(text);
  if (!fm.id) return "a note needs an id";
  if (fm.sources.length === 0) return "a note needs at least one source";
  return null;
}

// ---- Nightly hygiene: deterministic checks only. Judgment goes to Cain. ----

export type Finding = { kind: string; path: string; detail: string };

// files: the text of what's checked; exists: every path in the record (and every
// folder), so links to anything in it count as good.
export function hygiene(files: Map<string, string>, exists: Set<string> = new Set(files.keys())): Finding[] {
  const out: Finding[] = [];
  const known = new Set(exists);
  for (const p of exists) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) known.add(parts.slice(0, i).join("/")); }
  const ids = new Map<string, string>();
  const titles: { path: string; words: Set<string> }[] = [];
  for (const [path, text] of files) {
    if (!path.endsWith(".md")) continue;
    if (Buffer.byteLength(text) > MAX_BYTES) out.push({ kind: "too big", path, detail: `${Math.round(Buffer.byteLength(text) / 1000)} KB` });
    if (NOTE.test(path)) {
      const fm = frontMatter(text);
      const why = noteProblem(text);
      if (why) out.push({ kind: "incomplete note", path, detail: why });
      if (fm.id) {
        if (ids.has(fm.id)) out.push({ kind: "same id", path, detail: `also used by ${ids.get(fm.id)}` });
        else ids.set(fm.id, path);
      }
      const t = (fm.title ?? path.split("/").pop()!.replace(/\.md$/, "")).toLowerCase();
      titles.push({ path, words: new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2)) });
    }
    // Relative links that point nowhere.
    for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) {
      let rel = m[1];
      try { rel = decodeURIComponent(rel); } catch { /* keep it as written */ }
      const target = resolve(path, rel.split(":")[0]);   // file.md:12 line suffixes
      if (!known.has(target)) out.push({ kind: "broken link", path, detail: clean(m[1], 80) });
    }
  }
  // Likely duplicates: titles that share most of their words, within an area.
  for (let i = 0; i < titles.length; i++) for (let j = i + 1; j < titles.length; j++) {
    const a = titles[i], b = titles[j];
    if (a.path.split("/")[1] !== b.path.split("/")[1] || a.words.size === 0 || b.words.size === 0) continue;
    const shared = [...a.words].filter((w) => b.words.has(w)).length;
    if (shared / Math.min(a.words.size, b.words.size) >= 0.8 && shared >= 2)
      out.push({ kind: "possible duplicate", path: a.path, detail: b.path });
  }
  return out;
}

function resolve(from: string, rel: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

export function hygieneReport(f: Finding[], day: string): string {
  if (f.length === 0) return `# Record check\n\n${day}: nothing found.\n`;
  const rows = f.map((x) => `| ${x.kind} | ${x.path} | ${x.detail.replace(/\|/g, "/")} |`).join("\n");
  return `# Record check\n\n${day}: ${f.length} to look at. Cain fixes these and reports what he did.\n\n| What | File | Detail |\n| --- | --- | --- |\n${rows}\n`;
}
