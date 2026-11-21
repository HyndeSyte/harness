// The plan-usage reader (Cain 0.16.0; Cain 0.17.0 reads the week's allowance): how much of the Claude
// Code subscription's weekly allowance is used, for the usage guard (guard.ts). What it reads on the Pi:
//   - Cain's Claude Code session transcripts, /data/cain/.claude/projects/**/*.jsonl, subagent
//     transcripts under the same folder included: every assistant message's `usage` record (input,
//     output and cache tokens);
//   - the week's allowance, set by hand: the App's option `plan_weekly_allowance_tokens`, which the
//     review runner writes to /data/review-settings.json (guard.ts readSettings), so a part run as Cain
//     reads the runner's number and not its own. 0 means not set: the reading is unknown.
// The plan's week starts Sunday 12:00 AM in the App's time zone (the subscription's usage page says
// "Resets Sunday 12:00 AM"), not a rolling 7 days: tokens with timestamps at or after the most recent
// Sunday 00:00 local count.
//
// Counting (0.17.0): Claude Code writes one transcript line per content block of an assistant message,
// each with the same message id and usage, so a message counts once: by its id, taking the largest usage
// seen for it (output tokens grow while a message streams), across every file (a resumed session repeats
// earlier messages). Every transcript changed since the week's start is read, line by line (never a
// whole file at once), newest first, bounded only by the number of files (MAX_FILES); files past the
// bound, or that can't be read, are counted as skipped, and a reading with any skipped file is
// incomplete: the guard counts it as unknown (it fails closed).
//
// The cache: each file's count (its messages this week, by id) is kept by path, size and mtime in
// /data/review-plan-cache.json, root's (root:cain 0640). The runner and the link (root) write it; a part
// run as Cain only reads it, and only when root owns it and no one else can write it, so an unchanged
// file is not read again. A file that only grew (transcripts are appended to) is read from where the
// cache stopped, after checking the bytes just before that point are the same.
import { closeSync, fchmodSync, fchownSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync,
  unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { CAIN_GID, capPaths } from "./capfiles.ts";

export type PlanReading = {
  fraction: number | null;           // of the week's allowance used, 0..1 (may be over 1); null: unknown
  at: string;                        // when it was read (ISO)
  reason: string;                    // why it's unknown, or where the figure came from
  tokens_week: number | null;        // tokens recorded since the week's start, each message once
  files: number;                     // transcript files counted
  skipped?: number;                  // transcript files changed this week but not counted (past the bound, or unreadable)
  week_start?: string;               // the plan's week start (ISO), Sunday 00:00 local
  allowance?: number;                // the week's allowance it divided by (0: not set)
  complete?: boolean;                // every file changed this week was counted
};

export const MAX_FILES = 1000;
export const CACHE_FORMAT = 1;
const MAX_LINE = 32 * 1024 * 1024;   // a line longer than this is not a usage line worth holding in memory
const CHUNK = 1024 * 1024;
const TAIL = 64;

// Round 2: a constant (capfiles.ts), overridden only in test mode.
export function transcriptsDir(home = capPaths().home): string { return join(home, ".claude", "projects"); }

type Found = { path: string; mtime: number; size: number };
function walk(dir: string, out: Found[], depth = 0): void {
  if (depth > 6) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let s;
    try { s = lstatSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out, depth + 1);
    else if (s.isFile() && n.endsWith(".jsonl")) out.push({ path: p, mtime: s.mtimeMs, size: s.size });
  }
}

// -- the plan's week ------------------------------------------------------------------------
// The zone's offset from UTC at an instant, in ms (local = utc + offset).
function offsetAt(t: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return local - Math.floor(t / 1000) * 1000;
}
// The most recent Sunday 00:00 in the zone, at or before now.
export function weekStart(now: Date, tz: string): Date {
  const off = offsetAt(now.getTime(), tz);
  const local = new Date(now.getTime() + off);                     // its UTC fields are the local wall clock
  const day = local.getUTCDay();                                   // 0: Sunday
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day);
  // Local midnight to an instant: the offset at midnight can differ from now's (a DST change in between).
  let t = wall - offsetAt(wall - off, tz);
  t = wall - offsetAt(t, tz);
  return new Date(t);
}

// -- one line, one file ---------------------------------------------------------------------
const KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
// The message id and tokens one transcript line's usage record counts, or null. A line without a message
// id is its own message (keyed by where it is). Lines timed before since don't count; a line with no
// time counts only when its file changed this week (the caller's choice).
export function lineUsage(line: string, since: number): { id: string | null; tokens: number } | null {
  if (!line.includes("\"usage\"")) return null;
  let j: any;
  try { j = JSON.parse(line); } catch { return null; }
  const t = Date.parse(String(j?.timestamp ?? ""));
  if (Number.isFinite(t) && t < since) return null;
  const u = j?.message?.usage ?? j?.usage;
  if (!u || typeof u !== "object") return null;
  let n = 0;
  for (const k of KEYS) {
    const v = Number(u[k]);
    if (Number.isFinite(v) && v > 0) n += v;
  }
  if (!n) return null;
  const id = typeof j?.message?.id === "string" && j.message.id ? j.message.id : null;
  return { id, tokens: n };
}
// The tokens one line counts, ignoring message ids (kept for callers that count single lines).
export function lineTokens(line: string, since: number): number { return lineUsage(line, since)?.tokens ?? 0; }

export type FileCount = { size: number; mtime: number; offset: number; tail: string; week: number; msgs: Record<string, number> };

// Reads a file from offset to its end, line by line in chunks, adding each line's usage into msgs (by
// message id, the largest seen). Returns where the last whole line ended and the bytes before it.
export function countFile(path: string, since: number, from?: FileCount): FileCount {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const msgs: Record<string, number> = from ? { ...from.msgs } : {};
    let pos = from ? from.offset : 0;
    let lineNo = 0;
    const add = (line: string, at: number) => {
      lineNo++;
      const u = lineUsage(line, since);
      if (!u) return;
      const key = u.id ?? `@${at}`;
      if (!(msgs[key] >= u.tokens)) msgs[key] = u.tokens;
    };
    const buf = Buffer.alloc(CHUNK);
    let carry: Buffer[] = [], carryLen = 0, carryStart = pos, dropping = false;
    let offset = pos;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue;
        const piece = buf.subarray(start, i);
        if (!dropping) {
          const whole = carryLen ? Buffer.concat([...carry, piece]) : piece;
          add(whole.toString("utf8"), carryStart);
        }
        carry = []; carryLen = 0; dropping = false;
        offset = pos + i + 1; carryStart = offset; start = i + 1;
      }
      if (start < n && !dropping) {
        carry.push(Buffer.from(buf.subarray(start, n))); carryLen += n - start;
        if (carryLen > MAX_LINE) { carry = []; carryLen = 0; dropping = true; }
      }
      pos += n;
    }
    // A last line with no new line yet may still be written: it's left for the next reading.
    const tail = offset > 0 ? readTail(fd, offset) : "";
    return { size: st.size, mtime: st.mtimeMs, offset, tail, week: since, msgs };
  } finally { closeSync(fd); }
}
function readTail(fd: number, offset: number): string {
  const len = Math.min(TAIL, offset);
  const b = Buffer.alloc(len);
  const n = readSync(fd, b, 0, len, offset - len);
  return b.subarray(0, n).toString("base64");
}

// -- the cache --------------------------------------------------------------------------------
export type Cache = { format: number; week: number; files: Record<string, FileCount> };
// Whether a cache file may be trusted: root's, a plain file, and no one else may write it.
export function rootOwned(s: Stats): boolean { return s.isFile() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o022) === 0; }
export function readCache(path: string, week: number, trust: (s: Stats) => boolean = rootOwned): Cache {
  const empty: Cache = { format: CACHE_FORMAT, week, files: {} };
  try {
    if (!trust(lstatSync(path))) return empty;
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j?.format !== CACHE_FORMAT || j.week !== week || !j.files || typeof j.files !== "object") return empty;
    return j as Cache;
  } catch { return empty; }
}
export function writeCache(path: string, c: Cache, own: (fd: number) => void = (fd) => fchownSync(fd, 0, CAIN_GID)): void {
  const tmp = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, "w", 0o640);
    try { try { own(fd); } catch { /* not root: the readers won't trust it, which is fine */ } fchmodSync(fd, 0o640); writeSync(fd, JSON.stringify(c)); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch { try { unlinkSync(tmp); } catch { /* gone */ } }
}

// Whether the cached count stands for the file as it is now: the same size and mtime, or it grew and the
// bytes before the cached offset are the same (then it's read on from there).
function reuse(path: string, f: Found, c: FileCount | undefined, since: number): "same" | "grew" | "no" {
  if (!c || c.week !== since) return "no";
  if (c.size === f.size && c.mtime === f.mtime) return "same";
  if (f.size < c.offset) return "no";
  try {
    const fd = openSync(path, "r");
    try { return c.offset === 0 || readTail(fd, c.offset) === c.tail ? "grew" : "no"; } finally { closeSync(fd); }
  } catch { return "no"; }
}

// -- the reading ------------------------------------------------------------------------------
export type ReadOpts = {
  dir?: string; now?: Date; tz?: string;
  allowance?: number;                     // the week's allowance in tokens; 0 or missing: not set
  cacheFile?: string | null;              // null: no cache
  saveCache?: boolean;                    // write the cache back (root's parts only)
  trustCache?: (s: Stats) => boolean;
  maxFiles?: number;
};
export function readPlanUsage(o: ReadOpts = {}): PlanReading {
  const now = o.now ?? new Date();
  const dir = o.dir ?? transcriptsDir();
  const tz = o.tz ?? "America/New_York";
  const since = weekStart(now, tz).getTime();
  const at = now.toISOString(), week_start = new Date(since).toISOString();
  const allowance = Number.isFinite(o.allowance) && o.allowance! > 0 ? Math.floor(o.allowance!) : 0;
  const max = o.maxFiles ?? MAX_FILES;
  const found: Found[] = [];
  walk(dir, found);
  const recent = found.filter((f) => f.mtime >= since).sort((a, b) => b.mtime - a.mtime);
  const cache = o.cacheFile ? readCache(o.cacheFile, since, o.trustCache) : { format: CACHE_FORMAT, week: since, files: {} as Record<string, FileCount> };
  const next: Cache = { format: CACHE_FORMAT, week: since, files: {} };
  const all = new Map<string, number>();
  let files = 0, skipped = Math.max(0, recent.length - max), changed = false;
  for (const f of recent.slice(0, max)) {
    let c: FileCount;
    const had = cache.files[f.path];
    try {
      const r = reuse(f.path, f, had, since);
      if (r === "same") c = had!;
      else { c = countFile(f.path, since, r === "grew" ? had : undefined); changed = true; }
    } catch { skipped++; continue; }
    next.files[f.path] = c;
    files++;
    for (const [id, n] of Object.entries(c.msgs)) {
      const key = id.startsWith("@") ? `${f.path}${id}` : id;
      if (!(all.get(key)! >= n)) all.set(key, n);
    }
  }
  if (o.cacheFile && o.saveCache && (changed || Object.keys(cache.files).length !== files)) writeCache(o.cacheFile, next);
  let tokens = 0;
  for (const n of all.values()) tokens += n;
  const base = { at, files, skipped, week_start, allowance, complete: skipped === 0 };
  if (!found.length)
    return { ...base, fraction: null, tokens_week: null, complete: false, reason: `no Claude Code transcripts found under ${dir}` };
  if (!allowance)
    return { ...base, fraction: null, tokens_week: tokens, reason: "the week's allowance isn't set (the App's option plan_weekly_allowance_tokens is 0)" };
  if (skipped)
    return { ...base, fraction: null, tokens_week: tokens, reason: `${skipped} transcript file${skipped === 1 ? "" : "s"} changed this week ${skipped === 1 ? "wasn't" : "weren't"} counted, so the count is incomplete` };
  return { ...base, fraction: tokens / allowance, tokens_week: tokens,
    reason: `${tokens} tokens since ${week_start} against the week's allowance of ${allowance}` };
}
