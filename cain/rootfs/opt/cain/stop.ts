// Stop everything (wave 1, piece E). Dane's Stop tap halts Cain's cloud jobs, his Ship
// cards and outside-review sends, along with the calendar specialist; only Dane's Turn
// back on tap undoes it. The link alone writes the state, after checking the tap is his;
// the RemoteTrigger hook, the review runner and review.sh only read it.
//
// /data/stop.json: {"stopped": true|false, "at": <ms>}. No file: running. A file that's
// there but can't be read counts as stopped: when in doubt, nothing runs.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const STOP_FILE = process.env.CAIN_STOP_FILE ?? "/data/stop.json";

export interface StopState { stopped: boolean; at: number | null }

export function readStop(path = STOP_FILE): StopState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e: any) { return e?.code === "ENOENT" ? { stopped: false, at: null } : { stopped: true, at: null }; }
  try {
    const j = JSON.parse(raw);
    if (typeof j?.stopped !== "boolean") return { stopped: true, at: null };
    return { stopped: j.stopped, at: Number.isFinite(j.at) ? Number(j.at) : null };
  } catch { return { stopped: true, at: null }; }
}

// Readable by all (Cain's session reads it from its hook), written whole or not at all.
export function writeStop(stopped: boolean, at: number, path = STOP_FILE): void {
  writeFileSync(`${path}.tmp`, JSON.stringify({ stopped, at }), { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

// "since 3:40 PM" in his zone, or "" when the time isn't known.
export function since(s: StopState, tz = "America/New_York"): string {
  if (s.at === null) return "";
  const t = new Date(s.at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return ` since ${t}`;
}

// Why something of Cain's won't run now, for Cain.
export function stoppedWhy(s: StopState, what: string, tz?: string): string {
  return `Everything is stopped${since(s, tz)}: Dane tapped Stop, so ${what}. Only he can turn it back on, with the `
    + "Turn back on button. Don't ask him to; tell him in one line only if he asks about it.";
}
