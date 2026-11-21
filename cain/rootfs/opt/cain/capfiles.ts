// The review-round cap's and the usage guard's files (Cain 0.16.0, round 2): where they live, who owns
// them, and the install-time self-check the review runner and the link run at their start (and, since
// round 3, again at each of their sweeps).
//
// Paths are constants here. An environment override is honoured only behind one explicit test-mode
// variable (CAIN_TEST_MODE=1), which the production run script never sets; the Build hook refuses to
// run at all while it is set (hooks/remote-trigger.ts).
//
// Owners and modes, as c1/lock.sh sets them at each start:
//   /data/review-rounds.json            root:cain 0640   the runner writes, Cain reads
//   /data/review-settings.json          root:cain 0640   the runner writes, Cain reads
//   /data/review-guard.log              root:cain 0640   the runner and the link append, Cain reads
//   /data/review-grants.json            root:cain 0640   the link writes (his grant taps, 0.18.0), the runner and Cain read
//   /data/link/review-decisions.json    root:root 0600   the link's own (when there)
//   /data/probe/rollback-armed.json     root, no group or other write (the probe's, when there)
// A file that is wrong turns the cap and guard features off and raises one alarm naming it.
import { lstatSync, readFileSync, type Stats } from "node:fs";

export const TEST_MODE_VAR = "CAIN_TEST_MODE";
export function testMode(env: Record<string, string | undefined> = process.env): boolean { return env[TEST_MODE_VAR] === "1"; }
// A constant, or (in test mode only) the named environment variable.
export function pathOf(name: string, fallback: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[name];
  return testMode(env) && v ? v : fallback;
}

export const FILES = {
  rounds: "/data/review-rounds.json",
  settings: "/data/review-settings.json",
  guardLog: "/data/review-guard.log",
  spend: "/data/review-spend.json",
  decisions: "/data/link/review-decisions.json",
  grants: "/data/review-grants.json",
  armed: "/data/probe/rollback-armed.json",
  home: "/data/cain",
} as const;

export const capPaths = (env: Record<string, string | undefined> = process.env) => ({
  rounds: pathOf("REVIEW_ROUNDS", FILES.rounds, env),
  settings: pathOf("REVIEW_SETTINGS", FILES.settings, env),
  guardLog: pathOf("REVIEW_GUARD_LOG", FILES.guardLog, env),
  spend: pathOf("REVIEW_SPEND", FILES.spend, env),
  decisions: pathOf("CAIN_REVIEW_DECISIONS", FILES.decisions, env),
  grants: pathOf("REVIEW_GRANTS", FILES.grants, env),
  armed: pathOf("CAIN_ROLLBACK_ARMED", FILES.armed, env),
  home: pathOf("CAIN_HOME", FILES.home, env),
});

export const ROOT_UID = 0;
export const CAIN_GID = 1000;                    // the Dockerfile's groupadd -g 1000 cain

// One file's rule: its owner, its group (undefined: any) and its exact mode, or for a file another
// part writes (the probe's) only that no group or other may write it. optional: may be missing.
export type FileRule = { path: string; uid: number; gid?: number; mode?: number; noWrite?: boolean; optional?: boolean };

export function capFileRules(p = capPaths()): FileRule[] {
  return [
    { path: p.rounds, uid: ROOT_UID, gid: CAIN_GID, mode: 0o640 },
    { path: p.settings, uid: ROOT_UID, gid: CAIN_GID, mode: 0o640 },
    { path: p.guardLog, uid: ROOT_UID, gid: CAIN_GID, mode: 0o640 },
    { path: p.decisions, uid: ROOT_UID, gid: ROOT_UID, mode: 0o600, optional: true },
    { path: p.grants, uid: ROOT_UID, gid: CAIN_GID, mode: 0o640, optional: true },
    { path: p.armed, uid: ROOT_UID, noWrite: true, optional: true },
  ];
}

const oct = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");
// null when every file is right; else the first that isn't, said in one line (it names the file).
export function checkFiles(rules: FileRule[], stat: (p: string) => Stats = lstatSync): string | null {
  for (const r of rules) {
    let s: Stats;
    try { s = stat(r.path); }
    catch (e: any) {
      if (e?.code === "ENOENT") { if (r.optional) continue; return `${r.path} is missing`; }
      return `${r.path} can't be read (${String(e?.code ?? e).slice(0, 40)})`;
    }
    if (s.isSymbolicLink()) return `${r.path} is a symlink`;
    if (!s.isFile()) return `${r.path} isn't a plain file`;
    const mode = s.mode & 0o7777;
    const bad = s.uid !== r.uid || (r.gid !== undefined && s.gid !== r.gid)
      || (r.mode !== undefined && mode !== r.mode) || (r.noWrite && (mode & 0o022) !== 0);
    if (bad) return `${r.path} is owned by ${s.uid}:${s.gid}, mode ${oct(mode)}`;
  }
  return null;
}

// The App's alarm for it, through root's notice.sh (its group "review"); tests pass their own.
export const NOTICE = "/opt/cain/notice.sh";
export function clearAlarm(log: (m: string) => void = console.log, group = "review"): void {
  try { Bun.spawnSync(["timeout", "-k", "2", "40", NOTICE, "clear", group], { stdout: "inherit", stderr: "inherit" }); }
  catch (e) { log(`couldn't clear the alarm (${group}): ${String(e).slice(0, 80)}`); }
}
// kind (round 3): "review-files" (this check), "review-decisions" (his decisions file moved aside) or
// "review-holds" (the guard-hold route's caps).
export function raiseAlarm(cause: string, log: (m: string) => void = console.log, kind = "review-files"): void {
  try {
    const r = Bun.spawnSync(["timeout", "-k", "2", "40", NOTICE, "tell", kind, cause], { stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) log(`the alarm (${kind}) didn't go yet (notice.sh ${r.exitCode}); raised again at the next change`);
  } catch (e) { log(`couldn't raise the alarm (${kind}): ${String(e).slice(0, 80)}`); }
}

// How Cain runs this start (the run script's /run/cain/mode): "own" (his own user), "old" (as root,
// the fallback) or "none" (not started); null when it can't be read.
export const MODE_FILE = "/run/cain/mode";
export function runMode(path = MODE_FILE): string | null {
  try { return readFileSync(path, "utf8").trim().slice(0, 10) || null; } catch { return null; }
}

// At a start, and again at each sweep (round 3): the check, with one alarm when it starts failing (or
// its cause changes) and the alarm cleared once every file is right, so the features come back without a
// restart. prev: the last finding (undefined at the start, which always raises or clears). The cause, or
// null when every file is right. While it fails, the cap's state reads unknown for every pull request, so
// every Ship card is refused: the alarm says so. Only while he runs as his own user, the only way lock.sh
// sets these files up and the owners mean anything; the old way (he is root) and a stopped start skip it,
// said in the log once. A mode that can't be read checks (it fails closed).
export function selfCheck(o: { rules?: FileRule[]; stat?: (p: string) => Stats; alarm?: (cause: string) => void; clear?: () => void;
    log?: (m: string) => void; mode?: string | null; prev?: string | null } = {}): string | null {
  const first = o.prev === undefined;
  const mode = o.mode !== undefined ? o.mode : runMode();
  if (mode === "old" || mode === "none") {
    if (first) (o.log ?? console.log)(`the review files' owners aren't checked this start (Cain runs ${mode === "old" ? "the old way" : "not at all"})`);
    return null;
  }
  const cause = checkFiles(o.rules ?? capFileRules(), o.stat);
  if (cause) {
    if (first || cause !== o.prev) {
      (o.log ?? console.log)(`the review cap and the usage guard are off, and Ship decisions are paused for every pull request: ${cause}`);
      (o.alarm ?? ((c) => raiseAlarm(c, o.log)))(cause);
    }
  } else if (first || o.prev !== null) {
    if (!first) (o.log ?? console.log)("the review files are right again: the review cap, the usage guard and Ship decisions are back on");
    (o.clear ?? (() => clearAlarm(o.log)))();
  }
  return cause;
}
