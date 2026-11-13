// The gate's report log (piece D): one JSON line per send point where a rule would have
// done something, in Cain's own folder, written by the link and by the reply hook. Only
// up to 60 characters around each hit are kept, never the whole message. Kept under
// about a megabyte: a full log moves aside to .1, replacing the one before.
//
// Written without blocking (fs.promises), and it never throws: nothing on a send or a tap
// waits on it, and a log that can't be written is itself only logged.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const GATE_LOG = process.env.CAIN_GATE_LOG ?? "/data/work/gate-report.jsonl";
export const GATE_LOG_MAX = 1_000_000;

export async function appendGate(entry: object, path = GATE_LOG, max = GATE_LOG_MAX,
                                 log: (line: string) => void = () => {}): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    try { if ((await stat(path)).size > max) await rename(path, `${path}.1`); } catch { /* no log yet */ }
    await appendFile(path, JSON.stringify(entry) + "\n");
  } catch (e) { log(`couldn't log the gate's report: ${String(e).slice(0, 80)}`); }
}
