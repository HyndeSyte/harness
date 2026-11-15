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
import { DATE_SKEW_MS } from "../clock.ts";

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
  | { op: "note"; item: string; text: string }                        // anyone, any item: kept for its holder
  // A source check on an open row (state/checks.json): row and version are the row's
  // ledger id and version as the link read them (null and 0: the ledger didn't know it).
  | { op: "check"; item: string; text: string; row: string | null; version: number }
  // A one-off ask to him, for the request log, with the link's declaration that it is about
  // no open item (not_about_item, always true). reason: Cain's one line on why, when its words
  // overlap an open row's Item (the link holds it until he gives one); logged with it.
  | { op: "one-off"; text: string; not_about_item: true; reason?: string };

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
  declared?: string;   // a one-off re-declared with Cain's reason: that reason, and the overlap it answers
  round_ms?: number;   // Cain's own requests: the keeper's local work for the round, up to this outcome (not the push)
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
export const CHECKS_PATH = "state/checks.json";
export const MAX_CHECK_TEXT = 300;            // characters in one source check
export const ONE_OFF_AUDIT_PATH = "state/one-off-audit.md";
export const DEFAULT_MAX_CHECK_DAYS = 7;      // the App's source_check_max_days, when unset
export const MAX_ONE_OFF_REASON = 200;        // characters in a one-off's reason
// A row's Next step holds the current step and its latest source check; dated history goes in
// a note on the item. 800 characters is about four times the longest current step plus a
// check (a check is at most 300) and keeps a full open list of 50 rows well under MAX_BYTES.
export const MAX_NEXT_STEP = 800;

// Where requests may write. log/ and inbox/ belong to the keeper itself; code,
// workflows and the repo's own settings are never written through requests.
// reviews/ holds outside-model reviews (written by the review runner, as Cain).
// state/holds.json is the keeper's own; requests change it only with take, pass and
// release. state/notes/ is the keeper's too: written only by the note op, so a note
// never conflicts with anything. So are state/checks.json (the source checks and row
// versions per item, Source checks below) and state/one-off-audit.md, written only by the
// keeper.
const WRITABLE = /^(areas|state|archive|rules|projects|reviews)\/[A-Za-z0-9._ \/&()-]+$/;
const KEEPERS = /^state\/(holds\.json|checks\.json|one-off-audit\.md|notes)(\/|$)/i;
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
    if (["take", "pass", "release", "renew", "row", "row-add", "row-close", "note", "check"].includes(o.op)) {
      if (typeof o.item !== "string" || !ITEM.test(o.item)) return { req, error: `${o.op}: needs an item id, like P33` };
      o.item = o.item.toUpperCase();   // p33 and P33 are one item, with one hold
      const why = itemOpProblem(o);
      if (why) return { req, error: why };
      continue;
    }
    if (o.op === "one-off") {
      if (typeof o.text !== "string" || !o.text.trim()) return { req, error: "one-off: needs text (the ask)" };
      if (o.text.length > MAX_CHECK_TEXT) return { req, error: `one-off: over ${MAX_CHECK_TEXT} characters` };
      const why = cellProblem(o.text);
      if (why) return { req, error: `one-off: ${why}` };
      if (o.not_about_item !== true) return { req, error: "one-off: needs not_about_item: true, the declaration that it is about no open item" };
      if (o.reason !== undefined) {
        if (typeof o.reason !== "string" || !o.reason.trim()) return { req, error: "one-off: reason, when given, is one line on why it is about no open item" };
        if (o.reason.length > MAX_ONE_OFF_REASON) return { req, error: `one-off: reason over ${MAX_ONE_OFF_REASON} characters` };
        const r = cellProblem(o.reason);
        if (r) return { req, error: `one-off: reason: ${r}` };
      }
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
      return cellsProblem(o, "cells", ["Item"]);   // the bundled-status rule is the plan's (it names the claims)
    case "row-close": {
      if (typeof o.evidence !== "string" || !o.evidence.trim()) return `row-close ${o.item}: needs evidence`;
      const why = cellProblem(o.evidence);
      return why ? `row-close ${o.item} evidence: ${why}` : null;
    }
    case "check": {
      const why = checkTextProblem(o.text);
      if (why) return `check ${o.item}: ${why}`;
      if (!(o.row === null || (typeof o.row === "string" && ROW_ID.test(o.row)))) return `check ${o.item}: needs row, the row's ledger id as read (null when it had none)`;
      if (!Number.isInteger(o.version) || o.version < 0 || (o.row === null) !== (o.version === 0))
        return `check ${o.item}: needs version, the row's version as read (0 when it had no ledger id)`;
      return null;
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

// ---- Source checks (state/checks.json, and the open table's Checked cell) ----
//
// Before Cain asks him about an item, or offers a Ship card for it, its status is checked
// at its source (his mail, the portal, GitHub), and that check is of the row as it stands;
// the link refuses otherwise. The keeper keeps, per open row (state/checks.json, keyed by
// its ID, the item code: the one matching key, in row ops and whole-file writes alike):
//   id          a hidden stable id the keeper gives the row the first time it writes the
//               open list with it in. It survives Item edits and reordering; a row that
//               leaves the open table leaves the ledger, so one deleted in one write and
//               added again in a later one under the same ID gets a new id. Never shown.
//   version     starts at 1 and goes up by one each time the row's content changes: any
//               cell but Since and Checked, compared trimmed with runs of spaces made one,
//               against the row as committed under the same ID. A rewrite that changes no
//               cell bumps nothing; one whose Item changed under an ID (swapped codes
//               included) bumps that row.
//   changed     when the version last went up (shown in refusals only, never compared).
//   checked     the latest source check, in plain words, with checked_version (the version
//               it checked), checked_at (the keeper's time for it), stale_after (checked_at
//               plus the App's source_check_max_days, by the keeper's clock), checked_req
//               and by.
//   hash        the row's versioned cells as the keeper last wrote them (sha1, normalized).
//               A row whose cells no longer match it was changed outside the keeper (by an
//               earlier keeper after a rollback, or by hand): its check doesn't count, and the
//               next write of the list bumps its version.
//   aged        when the keeper's clock passed stale_after (the keeper ages checks itself).
//   pending_rewrite  set when a whole-file write that changed this row was refused for it
//               (it bundled two statuses): what was refused. Its check doesn't count, and no
//               new check is taken, until a write changes the row cleanly.
//   clock       which clock source said the keeper's clock was synchronized when it took the
//               check (kernel, timedatectl, timesyncd or http-date; see ../clock.ts).
//   stepped_back  when the keeper's clock read earlier than checked_at (a backward step): the
//               check never counts again.
// The file also holds "_generation", a number that goes up by one with every write of the
// ledger and never comes down, even across a reset of the keeper's copy (the keeper keeps its
// own count too). The link puts it on each ask and Ship card, and a tap counts only while the
// ledger's generation is no lower than the card's, so a ledger that went backwards can't
// validate a card.
// A check is fresh while checked_version is the row's version, it isn't aged, pending a
// rewrite or out of step with the row's cells, and it is no older than stale_after (the
// App's source_check_max_days, 7 by default, from checked_at). The check op carries the id and
// version the link read; the keeper takes it only while both are still current (an
// unledgered row: id null, version 0, and still unledgered), and the op never bumps its
// own row. A row with no ledger entry starts at version 1 with no check, whatever its
// Since date says (Since carries no status meaning). The Checked column is a projection of
// the ledger: regenerated on every write of the open list, added the first time, and never
// read back as input.
export type CheckEntry = {
  id: string; version: number; changed: string; hash?: string;
  checked?: string; checked_at?: string; checked_version?: number; checked_req?: string; by?: string;
  stale_after?: string; aged?: string; pending_rewrite?: string; clock?: string; stepped_back?: string;
  recheck?: string;   // its check was dropped by a reset epoch (when it began): pending re-check until taken again
};
export type Checks = Record<string, CheckEntry>;
export const CHECKED_COLUMN = "Checked";
const UNVERSIONED = new Set(["ID", "Since", CHECKED_COLUMN]);
export const ROW_ID = /^r[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
export const GENERATION_KEY = "_generation";   // not an item code: those start with a letter or digit

// The ledger's generation (0: none written yet, or a file that can't be read).
export function generationOf(text: string | null | undefined): number {
  if (!text) return 0;
  try { const g = JSON.parse(text)?.[GENERATION_KEY]; return Number.isInteger(g) && g > 0 ? g : 0; } catch { return 0; }
}

export function parseChecks(text: string | null): Checks {
  if (!text) return {};
  let j: any;
  try { j = JSON.parse(text); } catch { return {}; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const out: Checks = {};
  for (const [k, v] of Object.entries<any>(j)) {
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !ROW_ID.test(v.id)) continue;
    if (!Number.isInteger(v.version) || v.version < 1 || typeof v.changed !== "string") continue;
    const e: CheckEntry = { id: v.id, version: v.version, changed: v.changed };
    if (typeof v.hash === "string" && /^[0-9a-f]{40}$/.test(v.hash)) e.hash = v.hash;
    if (typeof v.checked === "string" && typeof v.checked_at === "string" && Number.isInteger(v.checked_version)) {
      e.checked = v.checked; e.checked_at = v.checked_at; e.checked_version = v.checked_version;
      if (typeof v.checked_req === "string") e.checked_req = v.checked_req;
      if (typeof v.by === "string") e.by = v.by;
      if (typeof v.stale_after === "string" && !Number.isNaN(Date.parse(v.stale_after))) e.stale_after = v.stale_after;
      if (typeof v.aged === "string") e.aged = v.aged;
      if (typeof v.clock === "string") e.clock = v.clock;
    }
    if (typeof v.stepped_back === "string" && v.stepped_back) e.stepped_back = v.stepped_back;
    if (typeof v.pending_rewrite === "string" && v.pending_rewrite) e.pending_rewrite = v.pending_rewrite;
    if (typeof v.recheck === "string" && v.recheck && e.checked === undefined) e.recheck = v.recheck;
    out[k] = e;
  }
  return out;
}
export function checksText(c: Checks, generation?: number): string {
  const out: Record<string, unknown> = {};
  if (generation !== undefined && generation > 0) out[GENERATION_KEY] = generation;
  for (const k of Object.keys(c).sort()) {
    const e = c[k];
    out[k] = { id: e.id, version: e.version, changed: e.changed, ...(e.hash ? { hash: e.hash } : {}),
      ...(e.checked !== undefined ? { checked: e.checked, checked_at: e.checked_at, checked_version: e.checked_version,
        ...(e.stale_after ? { stale_after: e.stale_after } : {}), ...(e.aged ? { aged: e.aged } : {}),
        ...(e.checked_req ? { checked_req: e.checked_req } : {}), ...(e.by ? { by: e.by } : {}), ...(e.clock ? { clock: e.clock } : {}) } : {}),
      ...(e.pending_rewrite ? { pending_rewrite: e.pending_rewrite } : {}), ...(e.stepped_back ? { stepped_back: e.stepped_back } : {}),
      ...(e.recheck && e.checked === undefined ? { recheck: e.recheck } : {}) };
  }
  return JSON.stringify(out, null, 2) + "\n";
}
// The ledger's text as a write leaves it: unchanged (null) when the entries are as they were;
// otherwise stamped with the next generation, one above both the file's and the keeper's own
// count (so a ledger reset to an older copy never reuses a number).
export function nextChecksText(ledger: Checks, before: string | null, keeperGeneration = 0): string | null {
  const was = generationOf(before);
  if (before !== null && checksText(ledger, was) === before) return null;
  return checksText(ledger, Math.max(was, keeperGeneration) + 1);
}
// The App's source_check_max_days, as a number of days (0 to 90; anything else: the default).
// 0 is for the device smoke test: every check is past it at once.
export function maxCheckDays(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim() || NaN);
  return Number.isInteger(n) && n >= 0 && n <= 90 ? n : DEFAULT_MAX_CHECK_DAYS;
}
// When a check stops counting by age: the keeper's stale_after for it, or (an entry written
// before it had one) its keeper time plus the limit. NaN: no time.
export const staleAfter = (e: CheckEntry | undefined, maxDays = DEFAULT_MAX_CHECK_DAYS): number =>
  e?.stale_after ? Date.parse(e.stale_after) : e?.checked_at ? Date.parse(e.checked_at) + maxDays * DAY_MS : NaN;
// Of the row's version, not aged out by the keeper and not pending a rewrite (with no clock),
// and, given a time, no older than the limit.
// A check dated after the clock now reads, by more than DATE_SKEW_MS (10 seconds): the clock
// stepped back. A smaller gap is ordinary drift and the check stands.
export function steppedBack(e: CheckEntry | undefined, now: number): boolean {
  return !!e?.checked_at && Date.parse(e.checked_at) - now > DATE_SKEW_MS;
}
export function isFresh(e: CheckEntry | undefined, now?: number, maxDays = DEFAULT_MAX_CHECK_DAYS): boolean {
  if (!e || e.checked === undefined || e.checked_version !== e.version || e.aged || e.pending_rewrite || e.stepped_back) return false;
  if (now === undefined) return true;
  const until = staleAfter(e, maxDays);
  // A clock that reads earlier than the check's own time by more than the Date header's skew
  // margin stepped back: it doesn't count. Within the margin (a few seconds of ordinary drift
  // between the keeper's clock and the link's) the check stands.
  if (steppedBack(e, now)) return false;
  // A limit of 0 days (the smoke test's expired check): nothing counts, even in the same instant.
  return Number.isFinite(until) && now <= until && !(e.checked_at && until <= Date.parse(e.checked_at));
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");
// Each open row's versioned cells (all but ID, Since and Checked), normalized, by its ID.
function versionedCells(text: string | null): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (text === null) return out;
  const d = parsePending(text);
  if (!d.open) return out;
  const cols = columns(d);
  for (let i = d.open.body; i < d.open.end; i++) {
    const cs = cells(d.lines[i]);
    if (!cs[0] || out.has(cs[0])) continue;
    const r: Record<string, string> = {};
    cols.forEach((c, j) => { if (!UNVERSIONED.has(c)) r[c] = norm(cs[j] ?? ""); });
    // Cells past the header (a row with more cells than columns) count too.
    for (let j = cols.length; j < cs.length; j++) if (cs[j]) r[`#${j}`] = norm(cs[j]);
    out.set(cs[0], r);
  }
  return out;
}
function sameCells(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? "") !== (b[k] ?? "")) return false;
  return true;
}
// The open rows whose versioned content differs between two versions of the list, and the
// rows that are new.
export function contentChanged(before: string | null, after: string | null): string[] {
  const a = versionedCells(before), b = versionedCells(after);
  return [...b.keys()].filter((id) => { const x = a.get(id); return !x || !sameCells(x, b.get(id)!); });
}

export function newRowId(seed: string): string {
  return "r" + createHash("sha1").update(seed, "utf8").digest("hex").slice(0, 12);
}

// A row's versioned cells, as one hash (sha1 of the normalized cells in column order).
const cellsHash = (r: Record<string, string>) =>
  createHash("sha1").update(Object.keys(r).sort().map((k) => `${k}\u0000${r[k]}`).join("\u0001"), "utf8").digest("hex");
// The hash of one open row's versioned cells as the list stands (null: no such row).
export function rowContentHash(text: string | null | undefined, code: string): string | null {
  const r = versionedCells(text ?? null).get(code);
  return r ? cellsHash(r) : null;
}
// Whether the ledger's entry for a row is in step with the row as the list stands: same
// cells as the keeper last wrote them. An entry with no hash (none yet) is taken as in step.
export function inStep(e: CheckEntry | undefined, text: string | null | undefined, code: string): boolean {
  if (!e) return false;
  if (!e.hash) return true;
  return rowContentHash(text, code) === e.hash;
}

// The ledger after a write of the open list: committed is the list as it stands in the
// record, after the list as it will be written, matched by item code. New rows (and rows
// the ledger never knew) get a new id at version 1; a row whose versioned cells changed
// goes up one; a row that left the open table leaves the ledger.
// A row whose cells no longer match the hash the keeper last wrote (changed outside the
// keeper) goes up one too, even when this write leaves it as it is. A row that changes drops
// any pending rewrite: the write that changed it was clean (bundled writes are refused whole).
// The id seed holds the request and its time, so a code that comes back after leaving the
// open table (closed, or deleted) never gets the id it had.
export function reconcile(ledger: Checks, committed: string | null, after: string | null, iso: string, seed: string): Checks {
  const A = versionedCells(committed), B = versionedCells(after);
  const out: Checks = {};
  for (const [code, now] of B) {
    const e = ledger[code], was = A.get(code), hash = cellsHash(now);
    if (!e || !was) out[code] = { id: newRowId(`${seed}\u0000${code}\u0000${iso}`), version: 1, changed: iso, hash };
    else if (!sameCells(was, now) || (e.hash && e.hash !== cellsHash(was))) {
      const { pending_rewrite: _, ...rest } = e;
      out[code] = { ...rest, version: e.version + 1, changed: iso, hash };
    } else out[code] = { ...e, hash };
  }
  return out;
}

// The keeper ages checks by its own clock (only while it is synchronized): a check past its
// stale_after is marked aged, so it never counts again, whatever clock reads it later.
export function ageChecks(ledger: Checks, now: Date, maxDays = DEFAULT_MAX_CHECK_DAYS): { ledger: Checks; aged: string[] } {
  const out: Checks = {}, aged: string[] = [];
  for (const [code, e] of Object.entries(ledger)) {
    const until = staleAfter(e, maxDays);
    if (e.checked !== undefined && !e.aged && Number.isFinite(until) && now.getTime() > until) {
      out[code] = { ...e, aged: now.toISOString() };
      aged.push(code);
    } else out[code] = e;
  }
  return { ledger: out, aged };
}

// A reset epoch began at `at`: every check in the ledger was accepted before it, so each is
// dropped (the row keeps its id and version) and marked pending re-check until taken again.
export function voidChecks(ledger: Checks, at: string): { ledger: Checks; dropped: string[] } {
  const out: Checks = {}, dropped: string[] = [];
  for (const [code, e] of Object.entries(ledger)) {
    if (e.checked === undefined) { out[code] = e; continue; }
    const { checked: _c, checked_at: _a, checked_version: _v, checked_req: _r, by: _b, stale_after: _s, aged: _g, clock: _k, stepped_back: _t, ...kept } = e;
    out[code] = { ...kept, recheck: at };
    dropped.push(code);
  }
  return { ledger: out, dropped };
}

// What the Checked cell shows: fresh or stale (by version), the check's day with its year
// (and the time when the check and the row's last change fall on the same day), the day it
// goes stale by age, then what was checked. The cell is made on writes, so "stale after"
// is shown for whoever reads it later.
export function checkedCell(e: CheckEntry | undefined, tz = "America/New_York", maxDays = DEFAULT_MAX_CHECK_DAYS): string {
  if (e?.pending_rewrite) return "pending rewrite: a whole-file write of this row was refused; write it cleanly, then check it again";
  if (e?.recheck && e.checked === undefined) return "pending re-check: the record was reset, so its last check no longer counts";
  if (!e || e.checked === undefined || !e.checked_at) return "";
  const at = new Date(e.checked_at), ch = new Date(e.changed);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: tz }).format(d);
  const short = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(at);
  const when = !Number.isNaN(ch.getTime()) && day(at) === day(ch) ? `${day(at)} ${time}` : day(at);
  const limit = isFresh(e) ? `, stale after ${short(new Date(staleAfter(e, maxDays)))}` : "";
  return clean(`${isFresh(e) ? "fresh" : "stale"}, ${when}${limit}: ${e.checked}`, MAX_CELL).replace(/\|/g, "/");
}

// The open table with its Checked column as the ledger says: the column added at the end
// when missing, every row's cell rewritten. Rows with an escaped | are left as they are.
export function projectChecked(text: string, ledger: Checks, tz?: string, maxDays?: number): string {
  const d = parsePending(text);
  if (!d.open) return text;
  let cols = columns(d);
  const cr = (l: string) => l.endsWith("\r");
  if (!cols.includes(CHECKED_COLUMN)) {
    const h = d.open.head;
    cols = [...cols, CHECKED_COLUMN];
    d.lines[h] = renderRow(cols, cr(d.lines[h]));
    d.lines[h + 1] = "|" + cols.map(() => "---").join("|") + "|" + (cr(d.lines[h + 1]) ? "\r" : "");
  }
  const at = cols.indexOf(CHECKED_COLUMN);
  for (let i = d.open.body; i < d.open.end; i++) {
    if (d.lines[i].includes(ESCAPED_PIPE)) continue;
    const cs = cells(d.lines[i]);
    if (!cs[0]) continue;
    const want = [...cs];
    while (want.length < cols.length) want.push("");
    want[at] = checkedCell(ledger[cs[0]], tz, maxDays);
    // An empty Checked cell at the end of a row stays off it, as rows had it before.
    if (!want[at] && at === want.length - 1) want.pop();
    if (want.join("\u0000") === cs.join("\u0000")) continue;
    d.lines[i] = renderRow(want, cr(d.lines[i]));
  }
  return d.lines.join("\n");
}

// The open table without its Checked column: what a writer sends is never read for it.
export function stripChecked(text: string | null): string | null {
  if (text === null) return null;
  const d = parsePending(text);
  if (!d.open) return text;
  const cols = columns(d), at = cols.indexOf(CHECKED_COLUMN);
  if (at < 0) return text;
  const cr = (l: string) => l.endsWith("\r");
  const drop = (cs: string[]) => cs.filter((_, j) => j !== at);
  d.lines[d.open.head] = renderRow(drop(cols), cr(d.lines[d.open.head]));
  d.lines[d.open.head + 1] = "|" + drop(cols).map(() => "---").join("|") + "|" + (cr(d.lines[d.open.head + 1]) ? "\r" : "");
  for (let i = d.open.body; i < d.open.end; i++) {
    if (d.lines[i].includes(ESCAPED_PIPE)) continue;
    const cs = cells(d.lines[i]);
    if (cs.length > at) d.lines[i] = renderRow(drop(cs), cr(d.lines[i]));
  }
  return d.lines.join("\n");
}

// A whole-file write of the open list is matched to the ledger by item code, so each open
// row needs one, and only one row per code: otherwise it is refused, in one line.
export function openTableProblem(text: string | null): string | null {
  if (text === null) return null;
  const d = parsePending(text);
  if (!d.open) return null;
  const seen = new Set<string>();
  for (let i = d.open.body; i < d.open.end; i++) {
    const cs = cells(d.lines[i]);
    const id = cs[0] ?? "";
    if (!id) return `${PENDING_PATH}: an open row has no item code in its ID cell ("${clean(cs.filter(Boolean).join(" / "), 60)}"); every open row needs one, as the record matches rows by it`;
    if (!ITEM.test(id)) return `${PENDING_PATH}: "${clean(id, 40)}" isn't an item code (like P33); every open row needs one, as the record matches rows by it`;
    if (seen.has(id)) return `${PENDING_PATH}: ${id} is in the open table twice; each item code may hold one row, as the record matches rows by it`;
    seen.add(id);
  }
  return null;
}

// A source check's text goes into the record and the ledger, never to the owner, so dates
// in any form, ISO times, hashes, job ids and record codes are fine. It is one line, at
// most MAX_CHECK_TEXT characters, without |, says when, and names a concrete source: a mail
// (its sender's domain and its date), a page or portal by name, a file path, a command, or
// a message. Vague sources (memory, earlier, I recall, I remember) are refused. The gate
// proves a check was recorded, not that it was true.
const WHEN = new RegExp([
  "\\b\\d{1,2}:\\d{2}\\b", "\\b(?:at|by|around) \\d{1,2}\\b", "\\b\\d{1,2}\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)", "\\b\\d{4}-\\d{2}-\\d{2}", "\\b\\d{1,2}\\/\\d{1,2}\\b",
  "\\b(?:today|yesterday|tonight|noon|midnight|now)\\b", "\\bthis (?:morning|afternoon|evening|week)\\b",
  "\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b",
  "\\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\\b",
].join("|"), "i");
const VAGUE = /\b(?:from memory|memory|memories|earlier|previously|as before|i recall|recalled|as i recall|i remember|remembered|i think|i believe|i'm told|i was told)\b/i;
const DOMAIN = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|org|net|gov|edu|us|io|co|uk|ca|app|dev|ai|me|info|biz|mil|int|[a-z]{2})\b/i;
const MAIL = /\b(?:e-?mails?|gmail|inbox|outlook|mail|mails|receipt email)\b/i;
const PAGE = /\b(?:portal|page|site|website|web page|dashboard|log|logs|github|pull request|pr #?\d+|repo|repository|home assistant|update entity|entity|account|app|calendar|tracker|tracking page|order page|statement|bank)\b|https?:\/\//i;
const FILE_PATH = /(?:^|[\s(])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]*)*|\b[\w-]+\/[\w./-]*[\w-]\.(?:md|json|jsonl|txt|ts|py|yaml|yml|csv|pdf|log)\b|\b[\w-]+\.(?:md|json|jsonl|csv|pdf|log|txt)\b/;
const COMMAND = /`[^`]+`|\b(?:ran|run|running|command)\b|\b(?:git|gh|curl|bun|record\.sh|keeper\.sh|review\.sh)\s+\S/i;
const MESSAGE = /\b(?:message|messages|text|texts|sms|discord|slack|voicemail|chat|dm|thread|reply)\b/i;
export function checkTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "a source check needs its text: what was checked, where and when";
  const t = text.trim();
  if (/[\r\n\u2028\u2029]/.test(t)) return "a source check is one line: what was checked, where and when";
  if (/[\u0000-\u001f\u007f]/.test(t)) return "a source check is one line of plain text";
  if (t.length > MAX_CHECK_TEXT) return `a source check is at most ${MAX_CHECK_TEXT} characters`;
  if (t.includes("|")) return "a source check can't hold |";
  const vague = VAGUE.exec(t);
  if (vague) return `a source check can't rest on "${vague[0]}": check it at its source now and name that source (a mail's sender domain and date, a page or portal, a file path, a command, or a message)`;
  if (!WHEN.test(t)) return "a source check says when it was checked (\"read at 9:40 this morning\", \"Nov 15\")";
  const mail = MAIL.exec(t), domain = DOMAIN.test(t);
  const named = PAGE.test(t) || domain || FILE_PATH.test(t) || COMMAND.test(t) || MESSAGE.test(t);
  if (mail && !domain && !named)
    return `a source check of a mail ("${mail[0]}") names its sender's domain and its date ("the receipt from county.gov dated Nov 14, read at 9:40")`;
  if (!named) return "a source check names a concrete source: a mail (its sender's domain and date), a page or portal by name, a file path, a command, or a message";
  return null;
}
// A repeat of the row's last check: the same words once case, punctuation and digits are
// set aside, with no later time in it (its numbers, read in order, not past the last's).
// The same wording with a later time is a new check.
const skeleton = (s: string) => s.toLowerCase().replace(/[0-9]+/g, "#").replace(/[^a-z#]+/g, " ").trim();
const numbers = (s: string) => (s.match(/[0-9]+/g) ?? []).map(Number);
export function repeatsCheck(last: string | undefined, text: string): boolean {
  if (last === undefined || skeleton(last) !== skeleton(text)) return false;
  const a = numbers(last), b = numbers(text);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] ?? -1) > (a[i] ?? -1)) return false;   // a later time: a new check
    if ((b[i] ?? -1) < (a[i] ?? -1)) return true;
  }
  return true;
}

// One row holds one fact. An Item cell bundles statuses when two of its clauses each make
// a completed-status claim about different subjects. A claim is a status word from a
// closed set (filed, sent, done, paid, issued, installed, confirmed, received, renewed,
// submitted, signed, mailed, delivered, cancelled, refunded, and their "not" or "un"
// forms) that follows a noun-phrase subject in its clause and is not itself followed by a
// noun: "business license filed Nov 3" and "permit not sent" claim, "a signed lease" and
// "filed and sent" don't. Clauses split at , ; : ( ), at a full stop before a capital, and
// at "and", "but", "while", "though", " - " and " / ". The coverage is limited: no list of
// words reads every sentence, so a row it passes may still hold two things, and one with
// two status words that isn't refused passes with a warning in the keeper's log.
// refuse: the two claims; warn: why it looked close.
const STATUS = "filed|sent|done|paid|unpaid|issued|installed|confirmed|unconfirmed|received|renewed|submitted|signed|unsigned|mailed|delivered|cancell?ed|refunded";
const FILLER = new Set(["not", "yet", "was", "were", "is", "are", "be", "been", "has", "have", "had", "already", "also", "still", "never", "now",
  "the", "a", "an", "all", "fully", "it", "its", "this", "that", "and", "or", "if", "whether", "to", "of", "for", "on", "by", "in", "at", "with",
  "get", "got", "getting", "make", "need", "needs", "should", "must", "will", "would", "can", "could", "did", "do", "does"]);
const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
// What may follow a status word that ends its claim: nothing, a date, a time word, or a
// word that starts an adverbial phrase. Anything else reads as the noun it describes.
const AFTER_CLAIM = new RegExp(`^\\s*(?:$|[?.!]|(?:on|by|in|at|to|with|for|from|via|online|late|early|already|yet|today|yesterday|last|this|ago|twice|again|(?:${MONTH})\\.?|\\d)(?![A-Za-z]))`, "i");
export function bundledStatus(item: string): { refuse?: [string, string]; warn?: string } {
  const claims: { clause: string; subject: string }[] = [];
  let words = 0;
  const clauses = String(item ?? "").split(/[,;:()\[\]]|\.\s+(?=[A-Z])|\s+[-–—]\s+|\s+\/\s+|\s+(?:and|but|while|whereas|though|although)\s+/i);
  for (const raw of clauses) {
    const c = raw.trim();
    const m = new RegExp(`(?<![A-Za-z-])(?:not\\s+(?:yet\\s+)?)?(${STATUS})(?![A-Za-z-])`, "i").exec(c);
    if (!m) continue;
    words++;
    const subject = c.slice(0, m.index).split(/[^A-Za-z0-9'&-]+/).filter((w) => w && !FILLER.has(w.toLowerCase())).map((w) => w.toLowerCase());
    if (!subject.length || !AFTER_CLAIM.test(c.slice(m.index + m[0].length))) continue;
    const key = subject.join(" ");
    if (claims.some((x) => x.subject === key)) continue;
    claims.push({ clause: c, subject: key });
    if (claims.length === 2) return { refuse: [claims[0].clause, claims[1].clause] };
  }
  return words >= 2 ? { warn: `${words} status words, but not two claims about different subjects` } : {};
}

// A Next step cell over MAX_NEXT_STEP characters is refused, unless the row already had one
// at least as long (an over-long row may shrink, never grow). The answer says where history
// goes: a note on the item.
export function nextStepProblem(id: string, before: string | undefined, after: string | undefined): string | null {
  const n = norm(after ?? "").length;
  if (n <= MAX_NEXT_STEP || n <= norm(before ?? "").length) return null;
  return `${id}'s Next step is ${n} characters, over ${MAX_NEXT_STEP} ("${clean(norm(after ?? "").slice(0, 50), 50)}..."): keep the current step and its latest source check there, and move the dated history into a note on the item (the note op)`;
}

// In a whole-file write of the open list (a put, or an append to it), every row that is new
// or changed is held to the row rules: an Item that bundles two statuses, or a Next step that
// grows past MAX_NEXT_STEP. Any such row refuses the whole write, which is atomic: the answer
// names each row and what it matched (its two clauses), so the writer fixes them and sends the
// complete file again. bundled: the codes refused for bundling, for the ledger's pending
// rewrite. before and after are without the Checked column.
export function rowRules(before: string | null, after: string): { errors: string[]; warnings: string[]; bundled: { id: string; why: string }[] } {
  const d = parsePending(after);
  const errors: string[] = [], warnings: string[] = [], bundled: { id: string; why: string }[] = [];
  if (!d.open) return { errors, warnings, bundled };
  const was = new Map<string, { item: string; next: string }>();
  if (before !== null) {
    const b = parsePending(before);
    if (b.open) {
      const cols = columns(b), it = cols.indexOf("Item"), nx = cols.indexOf("Next step");
      for (let i = b.open.body; i < b.open.end; i++) {
        const cs = cells(b.lines[i]);
        if (cs[0] && !was.has(cs[0])) was.set(cs[0], { item: norm(it >= 0 ? cs[it] ?? "" : ""), next: nx >= 0 ? cs[nx] ?? "" : "" });
      }
    }
  }
  const cols = columns(d), at = cols.indexOf("Item"), nx = cols.indexOf("Next step");
  for (let i = d.open.body; i < d.open.end; i++) {
    const cs = cells(d.lines[i]), id = cs[0];
    if (!id) continue;
    const old = was.get(id);
    if (at >= 0 && !(old && old.item === norm(cs[at] ?? ""))) {
      const b = bundledStatus(cs[at] ?? "");
      if (b.warn) warnings.push(`${id}'s Item may hold two statuses (${b.warn}); let through`);
      if (b.refuse) {
        const why = `its Item bundles two statuses ("${clean(b.refuse[0], 60)}" and "${clean(b.refuse[1], 60)}")`;
        errors.push(`${id}: ${why}`);
        bundled.push({ id, why });
      }
    }
    if (nx >= 0) {
      const long = nextStepProblem(id, old?.next, cs[nx]);
      if (long) errors.push(long);
    }
  }
  return { errors, warnings, bundled };
}
export const wholeFileRefusal = (r: { errors: string[]; bundled: unknown[] }) =>
  `${PENDING_PATH} wasn't written (a whole-file write lands whole or not at all): ${r.errors.join("; ")}.${r.bundled.length ? " One row holds one fact, so give each status its own row." : ""} Fix each row named and send the complete file again`;

// ---- One-off asks (--item none): about no open item ----
//
// The link refuses a one-off when its text holds an open row's item code or the row's whole
// Item phrase. A looser overlap (shared distinctive words) is held, not refused: the link
// posts nothing and tells Cain to either ask it under the item with a source check, or send
// it again with a one-line reason it is about no open item, which the keeper logs with it
// (the request log's "declared"); the keeper refuses an overlapping one-off without one too.
// On each round that applies requests, the keeper matches the past week's one-offs against
// the open rows the same way and keeps state/one-off-audit.md (with the week's wait
// timeouts); hits not seen before go to its log and to a file the next check-in reads to
// Cain. The guard is limited: wording that shares no code, phrase or distinctive word with a
// row passes all of it.

// The open rows' Item cells, by ID.
export function openItems(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  const d = parsePending(text);
  if (!d.open) return out;
  const at = columns(d).indexOf("Item");
  if (at < 0) return out;
  for (let i = d.open.body; i < d.open.end; i++) {
    const cs = cells(d.lines[i]);
    if (cs[0] && cs[at] && !out.has(cs[0])) out.set(cs[0], cs[at]);
  }
  return out;
}
const phraseOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The open row a one-off's text names outright: its item code, or its whole Item phrase,
// with the words that matched.
export function oneOffHit(pending: string | null | undefined, text: string): [string, string, string] | null {
  const said = ` ${phraseOf(text)} `;
  for (const [id, item] of openItems(pending)) {
    const code = new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, "i").exec(text);
    if (code) return [id, item, code[0]];
    const p = phraseOf(item);
    if (p && said.includes(` ${p} `)) return [id, item, p];
  }
  return null;
}
const COMMON = new Set(("about after again also back been before being both build cain check checked could dane does done each else even "
  + "every from have here into item just like make more much must need needs next none only open other over same should some "
  + "still such than that their them then there these they this those through today tomorrow under until want week were what when "
  + "where which while will with would your filed sent paid issued installed confirmed received renewed submitted signed mailed "
  + "delivered cancelled canceled refunded").split(" "));
const stem = (w: string) => w.replace(/'s$/, "").replace(/(?<=[a-z]{3})(?<![su])s$/, "");
const wordsOf = (t: string) => t.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).map(stem);
// The open rows a one-off may be about, by a looser match: two of the Item's distinctive
// words (four letters or more, not common ones) in the one-off, or its only one.
export function oneOffLoose(pending: string | null | undefined, text: string): { id: string; item: string; shared: string[] }[] {
  const asked = new Set(wordsOf(text)), out: { id: string; item: string; shared: string[] }[] = [];
  for (const [id, item] of openItems(pending)) {
    const own = [...new Set(wordsOf(item).filter((w) => w.length >= 4 && !COMMON.has(w) && !/^\d+$/.test(w)))];
    const shared = own.filter((w) => asked.has(w));
    if (own.length && shared.length >= Math.min(2, own.length)) out.push({ id, item, shared });
  }
  return out;
}
export type OneOff = { id: string; at: string; text: string; declared?: string };
// A refusal the link gave because the keeper's outcome didn't arrive in time, with the
// keeper's local time for that request's round once it had one (null: none yet).
// kind "tap": a tap whose fresh read of the ledger went over the link's limit (waited_ms is how
// long the read took); he was told busy, tap again.
export type WaitTimeout = { id: string; at: string; waited_ms: number; round_ms: number | null; kind?: "tap" };
export const ONE_OFF_SUMMARY = "One-off ask to him: ";
// The audit file: one line for the past seven days, then each hit. Same input, same text.
export function oneOffAudit(oneOffs: OneOff[], pending: string | null, now: Date, tz = "America/New_York", waits: WaitTimeout[] = []): { text: string; hits: string[] } {
  const from = now.getTime() - 7 * DAY_MS;
  const day = (d: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: tz }).format(d);
  const inWeek = (at: string) => { const t = Date.parse(at); return t > from && t <= now.getTime(); };
  const recent = oneOffs.filter((o) => inWeek(o.at)).sort((a, b) => a.at.localeCompare(b.at));
  const hits: string[] = [];
  for (const o of recent) for (const h of oneOffLoose(pending, o.text))
    hits.push(`${day(new Date(o.at))} (${o.id}): "${clean(o.text, 120)}" may be about ${h.id} ("${clean(h.item, 60)}"), shared words: ${h.shared.map((w) => `"${w}"`).join(", ")}${o.declared ? `; re-declared about no open item: "${clean(o.declared, 120)}"` : ""}`);
  const week = waits.filter((w) => inWeek(w.at)).sort((a, b) => a.at.localeCompare(b.at));
  const timed = week.filter((w) => w.kind !== "tap"), taps = week.filter((w) => w.kind === "tap");
  const matches = hits.length;
  for (const w of timed)
    hits.push(`${day(new Date(w.at))} (${w.id}): the link gave up waiting after ${Math.round(w.waited_ms / 1000)} seconds and posted nothing; the keeper's local round for it ${w.round_ms === null ? "hadn't finished when this was written" : `took ${Math.round(w.round_ms / 100) / 10} seconds`}`);
  for (const w of taps)
    hits.push(`${day(new Date(w.at))} (${w.id}): a tap's fresh read of the ledger took ${Math.round(w.waited_ms)} ms, over the link's limit; he was told busy, tap again`);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const line = `Week to ${day(now)}: ${n(matches, "possible match", "possible matches")} in ${n(recent.length, "one-off", "one-offs")}; ${n(timed.length, "wait timeout", "wait timeouts")}; ${n(taps.length, "tap timeout", "tap timeouts")}.`;
  const text = ["# One-off audit", "",
    "The keeper's looser match of the past week's one-off asks against the open rows, the asks the link refused because",
    "the keeper's answer didn't come in time, and taps refused as busy because the ledger's read took too long (the",
    "link's tap read limit is tuned from these). Look at each: if a one-off was about an open item, check that item at its",
    "source and ask under it. New lines reach Cain at his next check-in. The guard is limited: a one-off sharing no item",
    "code, Item phrase or distinctive word with a row isn't caught.", "",
    line, ...(hits.length ? ["", ...hits.map((h) => `- ${h}`)] : []), ""].join("\n");
  return { text, hits };
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
  maxCheckDays?: number;  // the App's source_check_max_days: a check's stale_after, and the Checked cell
  clockSynced?: boolean;  // the keeper's clock is synchronized: only then is a check taken
  clockSource?: string;   // which source said so (recorded with each check)
  clockWhy?: string;      // when it isn't: what each source returned (named in the refusal)
  generation?: number;    // the keeper's own count of ledger generations (never comes down)
};
export type Plan =
  // declared: a one-off's reason and the overlap it answers, for the request log.
  | { state: "ok"; writes: Map<string, string | null>; holds: Holds; holdsChanged: boolean; warnings?: string[]; errors?: string[]; declared?: string }
  // writes: on a refused whole-file write, the keeper's own files only (the ledger's pending
  // rewrite on the refused rows, and their Checked cells), written with the refusal.
  | { state: "conflict" | "rejected" | "refused" | "waiting"; reason: string; writes?: Map<string, string | null> };

// One cell of an open row as the list stands (undefined: no such row or column).
function rowCell(text: string | null, id: string, col: string): string | undefined {
  if (text === null) return undefined;
  const d = parsePending(text);
  if (!d.open) return undefined;
  const i = findRow(d, id);
  if (typeof i !== "number") return undefined;
  const c = columns(d).indexOf(col);
  return c < 0 ? undefined : cells(d.lines[i])[c] ?? "";
}

// The ledger kept in step with the list between requests: rows changed outside the keeper
// (their cells no longer match the hash it wrote) go up a version, and, while the clock is
// synchronized, checks past their stale_after are aged out. A check whose time is later than
// the clock reads now by more than DATE_SKEW_MS (the clock stepped back) is marked stepped_back
// and never counts again; within that margin it stands.
// Returns the files to write, or null when nothing changes. Only once a ledger exists.
export function upkeep(tree: Tree, ctx: { at: Date; tz?: string; maxCheckDays?: number; clockSynced?: boolean; generation?: number }): { writes: Map<string, string>; bumped: string[]; aged: string[]; stepped: string[] } | null {
  const raw = tree.read(CHECKS_PATH), list = tree.read(PENDING_PATH);
  if (raw === null || list === null) return null;
  let ledger = parseChecks(raw);
  const iso = ctx.at.toISOString();
  const bumped = Object.keys(ledger).filter((k) => ledger[k].hash && !inStep(ledger[k], list, k) && rowContentHash(list, k) !== null);
  if (bumped.length) ledger = reconcile(ledger, list, list, iso, "upkeep");
  let aged: string[] = [];
  if (ctx.clockSynced === true) ({ ledger, aged } = ageChecks(ledger, ctx.at, ctx.maxCheckDays));
  const stepped: string[] = [];
  for (const [k, e] of Object.entries(ledger))
    if (!e.stepped_back && steppedBack(e, ctx.at.getTime())) { ledger = { ...ledger, [k]: { ...e, stepped_back: iso } }; stepped.push(k); }
  if (!bumped.length && !aged.length && !stepped.length) return null;
  const text = nextChecksText(ledger, raw, ctx.generation);
  const writes = new Map<string, string>(text === null ? [] : [[CHECKS_PATH, text]]);
  const shown = projectChecked(list, ledger, ctx.tz, ctx.maxCheckDays);
  if (shown !== list) writes.set(PENDING_PATH, shown);
  return { writes, bumped, aged, stepped };
}

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
  const warnings: string[] = [], errors: string[] = [];
  // The keeper's ledger of row versions and source checks, as this request leaves it.
  let ledger = parseChecks(tree.read(CHECKS_PATH));
  let checked = false;                 // a check op went through: the ledger and the Checked cells change
  let declared: string | undefined;    // a one-off's reason, for the request log
  const refused = (reason: string): Plan => ({ state: "refused", reason });
  const rejected = (reason: string): Plan => ({ state: "rejected", reason });
  const conflict = (reason: string): Plan => ({ state: "conflict", reason });
  // A whole-file write of the open list refused by the row rules: nothing of it lands, and each
  // existing row refused for bundling has its check marked pending a rewrite in the ledger
  // (its Checked cell says so), so no ask rests on it until the row is written cleanly and
  // checked again. Those keeper files are written with the refusal.
  const bundledRefusal = (r: { errors: string[]; bundled: { id: string; why: string }[] }): Plan => {
    const reason = wholeFileRefusal(r);
    const committed = tree.read(PENDING_PATH), raw = tree.read(CHECKS_PATH);
    let marked = false;
    const L = { ...ledger };
    for (const b of r.bundled) if (L[b.id] && rowContentHash(committed, b.id) !== null) {
      L[b.id] = { ...L[b.id], pending_rewrite: clean(`request ${req.id}, ${iso}: ${b.why}`, 300) };
      marked = true;
    }
    if (!marked || committed === null || raw === null) return { state: "rejected", reason };
    const side = new Map<string, string | null>([[CHECKS_PATH, nextChecksText(L, raw, ctx.generation) ?? raw]]);
    const shown = projectChecked(committed, L, ctx.tz, ctx.maxCheckDays);
    if (shown !== committed) side.set(PENDING_PATH, shown);
    return { state: "rejected", reason, writes: side };
  };
  const heldBy = (id: string) => `${id} is held by ${holds[id].holder}${holds[id].job ? ` (a job: ${holds[id].job})` : ""}`;
  // Any change to the open list is checked row by row: a row someone else holds is
  // theirs, and an open row nobody holds is Cain's, so anyone else takes it before
  // changing it (a new row is anyone's to add). Every such row is named, so a writer
  // can leave them all out at once.
  const rowsOk = (before: string | null, after: string | null): string | null => {
    // The Checked column is the keeper's projection, never a writer's change.
    const theirs: string[] = [], was = openRows(before);
    for (const id of changedRows(stripChecked(before), stripChecked(after))) {
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

    if (o.op === "one-off") {
      // A one-off ask to him, kept in the request log with its declaration that it is about
      // no open item; it writes nothing. One that names an open row outright is rejected; one
      // that overlaps a row's Item more loosely needs Cain's one-line reason, logged with it.
      const list = current(PENDING_PATH);
      const hit = oneOffHit(list, o.text);
      if (hit) return rejected(`one-off: names an open item, ${hit[0]} ("${clean(hit[1], 60)}"), matching "${clean(hit[2], 60)}"; ask it under that item with a source check`);
      const loose = oneOffLoose(list, o.text);
      const overlap = loose.map((h) => `${h.id}: ${h.shared.map((w) => `"${w}"`).join(", ")}`).join("; ");
      if (loose.length && !o.reason?.trim())
        return rejected(`one-off: its words overlap an open item (${overlap}); ask it under that item with a source check, or send it again with a one-line reason it is about no open item`);
      if (loose.length) declared = clean(`${o.reason!.trim()} (overlaps ${overlap})`, 400);
      explicit = true;
      continue;
    }

    if (o.op === "check") {
      // A source check, taken only while the row is the version the link read (its id and
      // version in the ledger), and never one repeated word for word from the row's last.
      // It changes no content, so it never bumps its own row.
      const id = o.item, h = holds[id];
      // Only Cain's link sends source checks (it hands them over for his asks and Ship cards).
      if (sender !== "cain") return rejected(`check ${id}: only Cain's link sends source checks`);
      if (h && h.holder !== sender) return refused(heldBy(id));
      // Checks are dated and aged by the keeper's own clock, so only once it is synchronized.
      if (ctx.clockSynced !== true) return rejected(`check ${id}: the keeper's clock isn't synchronized yet${ctx.clockWhy ? ` (${clean(ctx.clockWhy, 220)})` : ""}, so no source check can be dated; try again in a few minutes`);
      const bad = checkTextProblem(o.text);
      if (bad) return rejected(`check ${id}: ${bad}`);
      const list = current(PENDING_PATH);
      if (list === null) return rejected(`${PENDING_PATH} doesn't exist`);
      const at = findRow(parsePending(list), id);
      if (typeof at !== "number") return "conflict" in at ? rejected(at.conflict) : rejected(at.rejected);
      const e = ledger[id];
      if (e?.pending_rewrite) return rejected(`check ${id}: the row is pending a rewrite (${clean(e.pending_rewrite, 200)}); write it cleanly first, then check it again`);
      if (e && !inStep(e, list, id)) return rejected(`check ${id}: the row was changed outside the record keeper since it was ledgered; its new version comes with the keeper's next round, so check again then`);
      const haveRow = e?.id ?? null, haveVersion = e?.version ?? 0;
      if (haveRow !== o.row || haveVersion !== o.version)
        return rejected(`check ${id}: the row changed since the check was read (it checked ${o.row === null ? "the row before the ledger knew it" : `version ${o.version}`}, the row is now ${e ? `version ${e.version}${e.id !== o.row ? " of a new row" : ""}` : "not in the ledger"}); check again`);
      if (repeatsCheck(e?.checked, o.text.trim())) return rejected(`check ${id}: repeats the row's last check ("${clean(e!.checked, 120)}": the same words, no later time); say what was checked this time, where and when`);
      // A row the ledger didn't know yet gets its id from this request alone, so the same check
      // applied again after a lost push gives the row the same id.
      const entry: CheckEntry = e ?? { id: newRowId(`${req.id}\u0000${id}`), version: 1, changed: iso };
      const { aged: _aged, stepped_back: _stepped, clock: _clock, recheck: _recheck, ...kept } = entry;
      const until = new Date(ctx.at.getTime() + maxCheckDays(ctx.maxCheckDays) * DAY_MS).toISOString();
      ledger = { ...ledger, [id]: { ...kept, checked: o.text.trim(), checked_at: iso, checked_version: entry.version, stale_after: until, checked_req: req.id, by: sender,
        ...(ctx.clockSource ? { clock: ctx.clockSource } : {}) } };
      checked = true;
      if (h?.holder === sender) touched.add(id);
      continue;
    }

    if (o.op === "row" || o.op === "row-add" || o.op === "row-close") {
      const id = o.item, h = holds[id];
      if (h && h.holder !== sender) return refused(heldBy(id));
      // One row holds one fact: a new Item cell that claims two statuses about two
      // subjects is refused, naming both; a near miss passes, with a warning in the log.
      const item = o.op === "row-add" ? o.cells.Item : o.op === "row" ? o.set.Item : undefined;
      const b = typeof item === "string" ? bundledStatus(item) : {};
      if (b.refuse) return rejected(`${id}'s Item bundles two statuses ("${clean(b.refuse[0], 60)}" and "${clean(b.refuse[1], 60)}"); one row holds one fact, so give each its own row`);
      if (b.warn) warnings.push(`${id}'s Item may hold two statuses (${b.warn}); let through`);
      const before = current(PENDING_PATH);
      if (before === null) return rejected(`${PENDING_PATH} doesn't exist`);
      // The Next step holds the current step and its latest check, never the history.
      const next = o.op === "row-add" ? o.cells["Next step"] : o.op === "row" ? o.set["Next step"] : undefined;
      if (typeof next === "string") {
        const long = nextStepProblem(id, o.op === "row" ? rowCell(before, id, "Next step") : undefined, next);
        if (long) return rejected(long);
      }
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
      // The open list's Checked column is never read back: it is made again from the ledger.
      let content = p === PENDING_PATH ? stripChecked(o.content)! : o.content;
      if (p === PENDING_PATH) {
        // The rows it means to change (against the version it was made from): any
        // that someone else holds refuse it, however old its base.
        const why = rowsOk(stale ? madeFrom ?? before : before, o.content);
        if (why) return refused(why);
      }
      if (stale) {
        // The open list made from an older version: laid onto the list as it stands
        // when the rows it changed haven't changed since.
        const m = p === PENDING_PATH && before !== null ? mergePending(stripChecked(madeFrom), stripChecked(before)!, content) : null;
        if (typeof m !== "string") return conflict(`${p}: changed since it was read${m ? ` (${m.why})` : ""}`);
        content = m;
      }
      if (NOTE.test(p)) {
        const why = noteProblem(content);
        if (why) return rejected(`${p}: ${why}`);
      }
      if (p === PENDING_PATH) {
        // Matched by item code: each open row needs one, once. A new or changed row that
        // breaks a row rule refuses the whole write.
        const bad = openTableProblem(content);
        if (bad) return rejected(bad);
        const r = rowRules(stripChecked(before), content);
        if (r.errors.length) return bundledRefusal(r);
        warnings.push(...r.warnings);
      }
      writes.set(p, content);
    } else if (o.op === "append") {
      if (NOTE.test(p) && before === null) return rejected(`${p}: a new note is made with put, with its front matter`);
      const was = before ?? "";
      const sep = was === "" || was.endsWith("\n") ? "" : "\n";
      let content = was + sep + o.text.replace(/\n*$/, "\n");
      if (p === PENDING_PATH) {
        const bad = openTableProblem(content);
        if (bad) return rejected(bad);
        const r = rowRules(stripChecked(before), stripChecked(content)!);
        if (r.errors.length) return bundledRefusal(r);
        warnings.push(...r.warnings);
      }
      writes.set(p, content);
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
  // A change that changes nothing would be logged as done for nothing (the Checked column,
  // being the keeper's, doesn't count).
  const differs = (path: string, c: string | null) =>
    path === PENDING_PATH ? stripChecked(c) !== stripChecked(tree.read(path)) : c !== tree.read(path);
  if (!explicit && !checked && ![...writes].some(([path, c]) => differs(path, c)))
    return rejected(errors.length ? errors.join("; ") : "changes nothing");
  if (wait) return { state: "waiting", reason: wait };
  // The ledger follows every write of the open list, whatever op or put made it: new rows
  // get an id at version 1, rows whose content changed go up one, rows that left go. Then
  // the Checked column is made again from it.
  if (writes.has(PENDING_PATH) || checked) {
    const committed = tree.read(PENDING_PATH), list = current(PENDING_PATH);
    ledger = reconcile(ledger, committed, list, iso, req.id);
    if (list !== null) {
      const shown = projectChecked(list, ledger, ctx.tz, ctx.maxCheckDays);
      if (Buffer.byteLength(shown) > MAX_BYTES) return rejected(`${PENDING_PATH}: over ${MAX_BYTES / 1000} KB; split it into topics`);
      if (shown !== committed || writes.has(PENDING_PATH)) writes.set(PENDING_PATH, shown);
    }
    const text = nextChecksText(ledger, tree.read(CHECKS_PATH), ctx.generation);
    if (text !== null) writes.set(CHECKS_PATH, text);
  }
  // The holder's word on its own row renews its hold.
  for (const id of touched) if (holds[id]?.holder === sender) holds[id].renewed = iso;
  return { state: "ok", writes, holds, holdsChanged: holdsText(holds) !== holdsText(ctx.holds ?? {}),
    ...(warnings.length ? { warnings } : {}), ...(errors.length ? { errors } : {}), ...(declared ? { declared } : {}) };
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
