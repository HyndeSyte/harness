// A copy of a process's log lines in a file under /data/work (0.12.0), so the device smoke test
// can read the record keeper's and the link's lines from inside the App (the App log itself is
// Home Assistant's). Kept to about 1 MB: past it, the file moves to <file>.1 and starts again.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function teeConsole(file: string | undefined, maxBytes = 1_000_000): void {
  if (!file) return;
  const out = console.log.bind(console);
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* written below, or not at all */ }
  console.log = (...a: unknown[]) => {
    out(...a);
    try {
      try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      appendFileSync(file, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
    } catch { /* the App log still has it */ }
  };
}
