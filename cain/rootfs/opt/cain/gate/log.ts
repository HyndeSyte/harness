// The gate's report log (piece D): one JSON line per send point where a rule would have
// done something, in Cain's own folder, written by the link and by the reply hook. Only
// up to 60 characters around each hit are kept, never the whole message. Kept under
// about a megabyte: a full log moves aside to .1, replacing the one before.
//
// Written without blocking (fs.promises), and it never throws: nothing on a send or a tap
// waits on it, and a log that can't be written is itself only logged. Within a process the
// appends go one at a time, in order, so two in the same tick can't both move a full log
// aside (the second would move the new log over .1, and the full one would be lost).
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const GATE_LOG = process.env.CAIN_GATE_LOG ?? "/data/work/gate-report.jsonl";
export const GATE_LOG_MAX = 1_000_000;

let queue: Promise<void> = Promise.resolve();   // the last append in line; it never rejects

// Settles once this entry is written, or its failure logged: the hook awaits it before it exits.
export function appendGate(entry: object, path = GATE_LOG, max = GATE_LOG_MAX,
                           log: (line: string) => void = () => {}): Promise<void> {
  const run = queue.then(() => write(entry, path, max, log)).catch(() => {});
  queue = run;
  return run;
}

async function write(entry: object, path: string, max: number, log: (line: string) => void): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    try { if ((await stat(path)).size > max) await rename(path, `${path}.1`); } catch { /* no log yet */ }
    await appendFile(path, JSON.stringify(entry) + "\n");
  } catch (e) {
    try { log(`couldn't log the gate's report: ${String(e).slice(0, 80)}`); } catch { /* nowhere left to say it */ }
  }
}
