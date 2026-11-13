// The gate's report log (piece D): one JSON line per send point where a rule would have
// done something, in Cain's own folder, written by the link and by the reply hook. Only
// up to 60 characters around each hit are kept, never the whole message. Kept under
// about a megabyte: a full log moves aside to .1, replacing the one before.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const GATE_LOG = process.env.CAIN_GATE_LOG ?? "/data/work/gate-report.jsonl";
export const GATE_LOG_MAX = 1_000_000;

export function appendGate(entry: object, path = GATE_LOG, max = GATE_LOG_MAX): void {
  mkdirSync(dirname(path), { recursive: true });
  try { if (statSync(path).size > max) renameSync(path, `${path}.1`); } catch { /* no log yet */ }
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
