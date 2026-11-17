// Stop everything (wave 1, piece E). Dane's Stop tap halts what would start next on
// Cain's side (his Build and Ship runs, his Ship cards and outside-review sends), along
// with the calendar specialist; only Dane's Turn back on tap undoes it. The link alone
// writes the state, after checking the tap is his; the RemoteTrigger hook, the review
// runner and review.sh only read it. A job already running finishes.
//
// /data/trust/stop.json: {"stopped": true|false, "at": <ms of the last change>}, in a
// folder only root can write (so once Cain's session runs as its own user, it can't
// remove or swap the file). The link writes it at start if it's missing. A file
// that's missing or can't be read counts as stopped: when in doubt, nothing runs.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Round 24: CAIN_TRUST_DIR moves it for a test that launches the link's real entry file (the image never sets it).
// Round 25: honoured only when it resolves (symbolic links followed, through its nearest existing folder) under the fixed
// test root, /tmp; set to anything else, the trust folder stays /data/trust and TRUST_DIR_REFUSED says why: the link
// refuses to start with that fixed reason.
export const TRUST_TEST_ROOT = "/tmp";
export const TRUST_DIR_WHY = "CAIN_TRUST_DIR is set to a folder outside the test root, so the link won't move its trust folder (Stop, Ship key) off /data/trust";
export function trustDirFrom(v: string | undefined): { dir: string; refused: string | null } {
  if (v === undefined) return { dir: "/data/trust", refused: null };
  const real = (p: string): string | null => {
    let base = resolve(p);
    const rest: string[] = [];
    while (!existsSync(base)) { const up = dirname(base); if (up === base) return null; rest.unshift(base.slice(up.length).replace(/^\//, "")); base = up; }
    try { return join(realpathSync(base), ...rest); } catch { return null; }
  };
  const root = real(TRUST_TEST_ROOT), dir = v ? real(v) : null;
  if (!root || !dir || !dir.startsWith(`${root}/`)) return { dir: "/data/trust", refused: TRUST_DIR_WHY };
  return { dir, refused: null };
}
const trust = trustDirFrom(process.env.CAIN_TRUST_DIR);
export const TRUST_DIR = trust.dir;
export const TRUST_DIR_REFUSED = trust.refused;
export const STOP_FILE = process.env.CAIN_STOP_FILE ?? `${TRUST_DIR}/stop.json`;

export interface StopState { stopped: boolean; at: number | null }

export function readStop(path = STOP_FILE): StopState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { stopped: true, at: null }; }
  try {
    const j = JSON.parse(raw);
    if (typeof j?.stopped !== "boolean") return { stopped: true, at: null };
    return { stopped: j.stopped, at: Number.isFinite(j.at) ? Number(j.at) : null };
  } catch { return { stopped: true, at: null }; }
}

// Readable by all (Cain's session reads it from its hook), written whole or not at all.
export function writeStop(stopped: boolean, at: number, path = STOP_FILE): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(`${path}.tmp`, JSON.stringify({ stopped, at }), { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

// At the link's start: a missing file means no Stop was ever saved, so it's written as
// running. One that's there is left as it is, stopped or not.
export function ensureStop(at: number, path = STOP_FILE): void {
  try { readFileSync(path); } catch (e: any) { if (e?.code === "ENOENT") writeStop(false, at, path); }
}

// " since 3:40 PM" (with the day when it isn't today), in his zone; "" when unknown.
export function since(s: StopState, tz = "America/New_York", nowMs = Date.now()): string {
  if (s.at === null) return "";
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  const t = new Date(s.at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return day(s.at) === day(nowMs) ? ` since ${t}` : ` since ${day(s.at)}, ${t}`;
}

// Why something of Cain's won't run now, for Cain.
export function stoppedWhy(s: StopState, what: string, tz?: string): string {
  if (s.at === null)
    return `Nothing runs: the Stop state can't be read, so ${what}. Tell Dane in one line that Cain's jobs are held `
      + "because of a fault on his App, and log a Build item.";
  return `Everything has been stopped${since(s, tz)}: Dane tapped Stop, so ${what}. Only he can turn it back on, with `
    + "the Turn back on button; never ask him to. If this was for something he asked for or tapped, tell him in one "
    + "line it waits until he turns things back on.";
}
