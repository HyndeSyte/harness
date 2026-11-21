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
// run as Cain only reads it, and only when it is root:cain 0640 and a plain file (cacheTrouble), so an
// unchanged file is not read again. A file that only grew (transcripts are appended to) is read from where
// the cache stopped, after checking the bytes just before that point are the same.
//
// Round 2 of 0.17.0's review fixes:
//   - a deadline (ReadOpts.deadline): past it the files not yet read are skipped, the reading is
//     incomplete ("plan reading not ready: out of time"), and what was read is still kept in the cache,
//     so the next reading goes on from there. A part run as Cain (the Build hook) asks for a warm cache
//     (coldOk false): on a cold or missing one it reads nothing and answers "plan reading not ready:
//     cache cold", and the link (root) is asked to read and warm it instead;
//   - a high-water mark per week, in the cache (root's): the most tokens counted and files seen this
//     week. A later complete reading below it is unknown ("shrank"), and root's parts raise an alarm
//     naming what shrank (a transcript deleted, truncated or re-timed);
//   - the cache write's outcome and a cache the trust check refused come back on the reading
//     (cache_write, cache_untrusted), for the alarm that names them (guard.ts PlanCacheAlarm).
//
// What the count can be trusted for (round 2). The settings (/data/review-settings.json) and this cache
// are root's: Cain's user can read them, not change them. The raw count is not protected that way: it is
// read from Cain's own transcripts, which Cain's user owns and could delete, truncate or re-time, and the
// count relies on them not being altered. The high-water mark catches a count that goes down within a
// week, not one that was kept low from the start. And the allowance is this device's share of the plan,
// set by hand from the usage page (guard.ts, DOCS.md "Usage guard"), not the plan's own limit.
import { closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync,
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
  not_ready?: string;                // round 2: "cache cold" or "out of time": nothing or not everything read in time
  shrank?: string;                   // round 2: what fell below this week's high-water mark (held, and alarmed)
  cache_write?: string;              // round 2: "ok", or why the cache couldn't be written (root's parts)
  cache_untrusted?: string;          // round 2: why the trust check refused the cache file (owner, group or mode)
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
// hwm (round 2): this week's high-water mark, the most tokens counted and files seen by a complete reading.
// complete: every file changed this week is in it (a part run as Cain reads only a complete one).
export type Cache = { format: number; week: number; files: Record<string, FileCount>; complete?: boolean; hwm?: { tokens: number; files: number } };
// Why a cache file may not be trusted, or null: it must be root:cain 0640 and a plain file (round 2: the
// group and the exact mode too, the same as capfiles.ts's rule for root's review files).
export function cacheTrouble(s: Stats): string | null {
  if (s.isSymbolicLink()) return "it is a symlink";
  if (!s.isFile()) return "it isn't a plain file";
  const mode = s.mode & 0o7777;
  if (s.uid !== 0 || s.gid !== CAIN_GID || mode !== 0o640) return `it is owned by ${s.uid}:${s.gid}, mode ${mode.toString(8).padStart(4, "0")}, not 0:${CAIN_GID} 0640`;
  return null;
}
export function rootOwned(s: Stats): boolean { return cacheTrouble(s) === null; }
// The cache as read: empty (and why) when it's missing, refused by the trust check, unreadable, or another week's.
export function loadCache(path: string, week: number, trust: (s: Stats) => boolean | string | null = (s) => cacheTrouble(s)):
    { cache: Cache; state: "warm" | "partial" | "missing" | "untrusted" | "unreadable" | "other week"; why?: string } {
  const empty: Cache = { format: CACHE_FORMAT, week, files: {} };
  let st: Stats;
  try { st = lstatSync(path); } catch (e: any) { return { cache: empty, state: e?.code === "ENOENT" ? "missing" : "unreadable" }; }
  const t = trust(st);
  if (t === false || typeof t === "string") return { cache: empty, state: "untrusted", why: typeof t === "string" ? t : "the trust check refused it" };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j?.format !== CACHE_FORMAT || !j.files || typeof j.files !== "object") return { cache: empty, state: "unreadable" };
    if (j.week !== week) return { cache: empty, state: "other week" };
    return { cache: j as Cache, state: j.complete === true ? "warm" : "partial" };
  } catch { return { cache: empty, state: "unreadable" }; }
}
export function readCache(path: string, week: number, trust: (s: Stats) => boolean = rootOwned): Cache { return loadCache(path, week, trust).cache; }
// Writes the cache whole (temp file, fsync, rename): null once written, else why not.
export function writeCache(path: string, c: Cache, own: (fd: number) => void = (fd) => fchownSync(fd, 0, CAIN_GID)): string | null {
  const tmp = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, "w", 0o640);
    try { try { own(fd); } catch { /* not root: the readers won't trust it, and the trust alarm names it */ } fchmodSync(fd, 0o640); writeSync(fd, JSON.stringify(c)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
    return null;
  } catch (e: any) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    return `the plan reader's cache ${path} couldn't be written (${String(e?.code ?? e?.message ?? e).slice(0, 60)})`;
  }
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
  trustCache?: (s: Stats) => boolean | string | null;   // true or null: trusted; false or a reason: not
  maxFiles?: number;
  deadline?: number;                      // round 2: a time (ms); past it, the files not yet read are skipped
  coldOk?: boolean;                       // round 2: false: on a cache that isn't warm, read nothing ("cache cold")
  clock?: () => number;                   // the deadline's clock (tests)
};
export const NOT_READY = "plan reading not ready";
export function readPlanUsage(o: ReadOpts = {}): PlanReading {
  const now = o.now ?? new Date();
  const dir = o.dir ?? transcriptsDir();
  const tz = o.tz ?? "America/New_York";
  const since = weekStart(now, tz).getTime();
  const at = now.toISOString(), week_start = new Date(since).toISOString();
  const allowance = Number.isFinite(o.allowance) && o.allowance! > 0 ? Math.floor(o.allowance!) : 0;
  const max = o.maxFiles ?? MAX_FILES;
  const clock = o.clock ?? Date.now;
  const loaded = o.cacheFile ? loadCache(o.cacheFile, since, o.trustCache) : { cache: { format: CACHE_FORMAT, week: since, files: {} } as Cache, state: "missing" as const };
  const untrusted = loaded.state === "untrusted" ? { cache_untrusted: `${o.cacheFile}: ${loaded.why}` } : {};
  // A part run as Cain never scans a cold week itself: the link (root) reads it and warms the cache.
  if (o.coldOk === false && loaded.state !== "warm")
    return { fraction: null, at, tokens_week: null, files: 0, skipped: 0, week_start, allowance, complete: false, not_ready: "cache cold", ...untrusted,
      reason: `${NOT_READY}: cache cold (${loaded.state === "untrusted" ? `the cache was refused: ${loaded.why}` : `the cache is ${loaded.state === "partial" ? "only partly read" : loaded.state}`})` };
  const cache = loaded.cache;
  const found: Found[] = [];
  walk(dir, found);
  const recent = found.filter((f) => f.mtime >= since).sort((a, b) => b.mtime - a.mtime);
  const next: Cache = { format: CACHE_FORMAT, week: since, files: {} };
  const all = new Map<string, number>();
  let files = 0, skipped = Math.max(0, recent.length - max), changed = false, late = false;
  for (const f of recent.slice(0, max)) {
    const had = cache.files[f.path];
    if (o.deadline !== undefined && clock() > o.deadline) {
      // Out of time: this file isn't counted, and what the cache had for it is kept for the next reading.
      late = true; skipped++;
      if (had) next.files[f.path] = had;
      continue;
    }
    let c: FileCount;
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
  let tokens = 0;
  for (const n of all.values()) tokens += n;
  const complete = skipped === 0;
  // The high-water mark: a complete reading below this week's mark is unknown (something shrank).
  const mark = cache.hwm && cache.week === since ? cache.hwm : null;
  const shrank: string[] = [];
  if (complete && mark) {
    if (tokens < mark.tokens) shrank.push(`the tokens counted (${tokens}, below this week's mark of ${mark.tokens})`);
    if (recent.length < mark.files) shrank.push(`the transcript files seen this week (${recent.length}, below this week's mark of ${mark.files})`);
  }
  next.complete = complete;
  next.hwm = complete && !shrank.length ? { tokens: Math.max(tokens, mark?.tokens ?? 0), files: Math.max(recent.length, mark?.files ?? 0) } : mark ?? undefined;
  if (!next.hwm) delete next.hwm;
  let cache_write: string | undefined;
  if (o.cacheFile && o.saveCache && (changed || late || Object.keys(cache.files).length !== Object.keys(next.files).length
      || cache.complete !== next.complete || JSON.stringify(cache.hwm ?? null) !== JSON.stringify(next.hwm ?? null) || loaded.state !== "warm" && loaded.state !== "partial"))
    cache_write = writeCache(o.cacheFile, next) ?? "ok";
  const base = { at, files, skipped, week_start, allowance, complete, ...untrusted, ...(cache_write ? { cache_write } : {}) };
  if (!found.length)
    return { ...base, fraction: null, tokens_week: null, complete: false, reason: `no Claude Code transcripts found under ${dir}` };
  if (late)
    return { ...base, fraction: null, tokens_week: tokens, not_ready: "out of time",
      reason: `${NOT_READY}: out of time (${skipped} transcript file${skipped === 1 ? "" : "s"} not read before the reading's time budget ran out)` };
  if (shrank.length)
    return { ...base, fraction: null, tokens_week: tokens, shrank: shrank.join(" and "),
      reason: `the count shrank this week: ${shrank.join(" and ")}, so a transcript was deleted, truncated or re-timed` };
  if (!allowance)
    return { ...base, fraction: null, tokens_week: tokens, reason: "the week's allowance isn't set (the App's option plan_weekly_allowance_tokens is 0)" };
  if (skipped)
    return { ...base, fraction: null, tokens_week: tokens, reason: `${skipped} transcript file${skipped === 1 ? "" : "s"} changed this week ${skipped === 1 ? "wasn't" : "weren't"} counted, so the count is incomplete` };
  return { ...base, fraction: tokens / allowance, tokens_week: tokens,
    reason: `${tokens} tokens since ${week_start} against the week's allowance of ${allowance}` };
}
