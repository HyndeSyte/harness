// The review service's lines (piece D, Cain 0.11.0): /data/trust/reviewed.json, written by
// the review runner (review/runner.ts) and read by the link, for a Ship card's Reviewed line
// and the gate on Cain's asks and morning message, and by the reply hooks, for the gate on his
// replies (gate/cain.ts). Each review that's done and has a line:
//   {"reviews": [{"id", "line", "finished_at", "pr", "head"}]}
// newest first, from the last 30 days, at most 200. pr and head are the pull request and the
// head commit the review was of (null for a review of anything else): a Ship card takes only
// a review of its own head. The line names only who answered and how (review/core.ts
// reviewedLine): no topic, brief or findings. A review blocked for privacy never appears.
// Written whole through a temp file in the same folder and a rename, readable by all, in a
// folder only root writes (like the Stop state, ../stop.ts). A file that's missing or can't
// be read is null: nothing can be checked against it. An entry older than 30 days counts for
// nothing, even when the file still has it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REVIEWED_FILE = process.env.CAIN_REVIEWED ?? "/data/trust/reviewed.json";
export const KEEP_DAYS = 30;
export const KEEP_MAX = 200;
const KEEP_MS = KEEP_DAYS * 86_400_000;

export interface Reviewed { id: string; line: string; finished_at: string; pr: string | null; head: string | null }

// The entries that are whole: an id, a line that is a Reviewed line, and a time; the pull
// request and head when it was of one.
export function parseReviewed(raw: string): Reviewed[] | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray(j.reviews)) return null;
  return j.reviews
    .filter((x: any) => typeof x?.id === "string" && typeof x?.line === "string" && x.line.startsWith("Reviewed: ")
      && typeof x?.finished_at === "string" && Number.isFinite(Date.parse(x.finished_at)))
    .map((x: any) => ({ id: x.id, line: x.line, finished_at: x.finished_at,
      pr: typeof x.pr === "string" && x.pr ? x.pr : null,
      head: typeof x.head === "string" && /^[0-9a-f]{40}$/i.test(x.head) ? x.head.toLowerCase() : null }));
}

// Those from the last 30 days, and none from the future: the runner and its readers share one
// clock, so a time more than a few minutes ahead was never written by a review that finished.
const AHEAD_MS = 10 * 60_000;
export const freshReviewed = (list: readonly Reviewed[], now: number): Reviewed[] =>
  list.filter((x) => { const at = Date.parse(x.finished_at); return at > now - KEEP_MS && at <= now + AHEAD_MS; });

export function readReviewed(path = REVIEWED_FILE, now = Date.now()): Reviewed[] | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const list = parseReviewed(raw);
  return list && freshReviewed(list, now);
}

// Newest first, from the last 30 days, at most 200.
export function keptReviewed(list: readonly Reviewed[], now: number): Reviewed[] {
  const at = (x: Reviewed) => Date.parse(x.finished_at);
  return freshReviewed(list, now)
    .sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, KEEP_MAX);
}

export function writeReviewed(list: readonly Reviewed[], path = REVIEWED_FILE): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.reviewed-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ reviews: list }, null, 1) + "\n", { mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing left to tidy */ }
    throw e;
  }
}
