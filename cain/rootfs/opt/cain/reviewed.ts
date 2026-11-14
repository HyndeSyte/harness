// The review service's lines (piece D, Cain 0.11.0): /data/trust/reviewed.json, written by
// the review runner (review/runner.ts) and read by the link, for a Ship card's Reviewed line
// and the gate on Cain's asks and morning message, and by the reply hook, for the gate on his
// replies (gate/cain.ts). Each finished review that has a line:
//   {"reviews": [{"id", "line", "finished_at"}]}
// newest first, from the last 30 days, at most 200. The line names only who answered and how
// (review/core.ts reviewedLine): no topic, brief or findings. A review blocked for privacy
// never appears. Written whole through a temp file in the same folder and a rename, readable
// by all, in a folder only root writes (like the Stop state, ../stop.ts). A file that's
// missing or can't be read is null: nothing can be checked against it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REVIEWED_FILE = process.env.CAIN_REVIEWED ?? "/data/trust/reviewed.json";
export const KEEP_DAYS = 30;
export const KEEP_MAX = 200;

export interface Reviewed { id: string; line: string; finished_at: string }

// The entries that are whole: an id, a line that is a Reviewed line, and a time.
export function parseReviewed(raw: string): Reviewed[] | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray(j.reviews)) return null;
  return j.reviews
    .filter((x: any) => typeof x?.id === "string" && typeof x?.line === "string" && x.line.startsWith("Reviewed: ")
      && typeof x?.finished_at === "string" && Number.isFinite(Date.parse(x.finished_at)))
    .map((x: any) => ({ id: x.id, line: x.line, finished_at: x.finished_at }));
}

export function readReviewed(path = REVIEWED_FILE): Reviewed[] | null {
  try { return parseReviewed(readFileSync(path, "utf8")); } catch { return null; }
}

// Newest first, from the last 30 days, at most 200.
export function keptReviewed(list: readonly Reviewed[], now: number): Reviewed[] {
  const at = (x: Reviewed) => Date.parse(x.finished_at);
  return list.filter((x) => at(x) > now - KEEP_DAYS * 86_400_000)
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
