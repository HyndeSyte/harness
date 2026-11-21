// The plan-usage reader (Cain 0.16.0): how much of the Claude Code subscription's weekly allowance
// is used, for the usage guard (guard.ts). What it reads on the Pi:
//   - Cain's Claude Code session transcripts, /data/cain/.claude/projects/**/*.jsonl (every turn's
//     `usage` record: input, output and cache tokens), the files changed in the last 7 days, bounded
//     (at most MAX_FILES files and MAX_BYTES bytes read);
// What it can't read: the plan's allowance. Claude Code records the tokens each turn used, never the
// plan's weekly limit or how much of it is left, and nothing else on the Pi does either (the App's
// own logs and the review runner's spend file are about the review seats' dollars, not the plan).
// So the reading is "unknown", with that reason and the week's token count for information, and the
// guard fails closed on it for "other" work. The owner decides the next step (DOCS.md, "Usage guard").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type PlanReading = {
  fraction: number | null;           // of the week's allowance used, 0..1; null: unknown
  at: string;                        // when it was read (ISO)
  reason: string;                    // why it's unknown, or where the figure came from
  tokens_week: number | null;        // tokens Claude Code recorded in the last 7 days (information only)
  files: number;                     // transcript files read
};

export const MAX_FILES = 400;
export const MAX_BYTES = 64 * 1024 * 1024;
const WEEK_MS = 7 * 86_400_000;

export function transcriptsDir(home = process.env.CAIN_HOME ?? "/data/cain"): string { return join(home, ".claude", "projects"); }

function walk(dir: string, out: { path: string; mtime: number; size: number }[], depth = 0): void {
  if (depth > 3) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out, depth + 1);
    else if (s.isFile() && n.endsWith(".jsonl")) out.push({ path: p, mtime: s.mtimeMs, size: s.size });
  }
}

// The tokens one transcript line's usage record counts, or 0.
export function lineTokens(line: string, since: number): number {
  if (!line.includes("\"usage\"")) return 0;
  let j: any;
  try { j = JSON.parse(line); } catch { return 0; }
  const t = Date.parse(String(j?.timestamp ?? ""));
  if (Number.isFinite(t) && t < since) return 0;
  const u = j?.message?.usage ?? j?.usage;
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const v = Number(u[k]);
    if (Number.isFinite(v) && v > 0) n += v;
  }
  return n;
}

export function readPlanUsage(o: { dir?: string; now?: Date } = {}): PlanReading {
  const now = o.now ?? new Date();
  const dir = o.dir ?? transcriptsDir();
  const since = now.getTime() - WEEK_MS;
  const found: { path: string; mtime: number; size: number }[] = [];
  walk(dir, found);
  const recent = found.filter((f) => f.mtime >= since).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
  let tokens = 0, bytes = 0, files = 0;
  for (const f of recent) {
    if (bytes + f.size > MAX_BYTES) break;
    let text: string;
    try { text = readFileSync(f.path, "utf8"); } catch { continue; }
    bytes += f.size; files++;
    for (const line of text.split("\n")) tokens += lineTokens(line, since);
  }
  const at = now.toISOString();
  if (!found.length)
    return { fraction: null, at, tokens_week: null, files: 0, reason: `no Claude Code transcripts found under ${dir}` };
  return { fraction: null, at, tokens_week: tokens, files,
    reason: "the Pi records the tokens Claude Code used, not the plan's weekly allowance, so the fraction used can't be read" };
}
