// The probe's folders (Cain 0.14.0): /data/probe and /run/cain/probe. Before every read or write under
// one of them, the folder itself is looked at without following a link (lstat): a real folder, not a
// symlink, owned by the user the probe runs as (root on the Pi) and mode 0700. Sixth round: every
// folder above it, up to /, must be root's (or the probe's own user's) and not writable by anyone
// else (a root-owned sticky folder, like /tmp, can't have another's entry renamed, so it passes), so
// uid 1000 can't rename or replace the folder from above (lock.sh fixes what it can at start). A
// missing folder is made with the right owner and mode, then looked at again, rather than refused.
// Anything else is refused (FolderTampered) and alarmed, "Cain's probe folder isn't the App's alone"
// (seventh round: nothing proves intent, so the title claims none), again each day while it lasts: the
// probe then neither reads nor writes there, and pings nothing, until the folder is right again. The
// cause names the failing path with its owner and mode in plain words ("/run is owned by user 1000,
// mode 0777"), so the App's log and the alarm say where to look.
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";

export class FolderTampered extends Error {
  constructor(readonly dir: string, readonly why: string) { super(why); this.name = "FolderTampered"; }
}

const own = () => (typeof process.getuid === "function" ? process.getuid() : 0);
const ownerWords = (uid: number) => (uid === 0 ? "root" : `user ${uid}`);
const modeWords = (st: Stats) => (st.mode & 0o7777).toString(8).padStart(4, "0");
// A path, its owner and its mode, in plain words: "/run is owned by user 1000, mode 0777".
export const described = (path: string, st: Stats) => `${path} is owned by ${ownerWords(st.uid)}, mode ${modeWords(st)}`;

// One folder above the probe's: null when it is safe (root's or the probe's own user's, and writable
// by no one else unless it is root's and sticky), else why not.
function aboveOne(cur: string, st: Stats, uid: number): string | null {
  if (st.uid !== 0 && st.uid !== uid) return "not root's";
  if ((st.mode & 0o022) !== 0 && !((st.mode & 0o1000) !== 0 && st.uid === 0)) return "others can write it";
  return null;
}
// Why a folder above the probe's isn't safe, or null when every one up to / is. The answer names the
// failing folder, its owner and its mode, and the probe folder it sits above.
export function aboveWhy(dir: string, uid = own()): string | null {
  let cur: string;
  try { cur = realpathSync(dirname(dir)); } catch { return `${dirname(dir)} (above ${dir}) can't be looked at`; }
  for (;;) {
    let st;
    try { st = statSync(cur); } catch { return `${cur} (above ${dir}) can't be looked at`; }
    if (aboveOne(cur, st, uid) !== null) return `${described(cur, st)} (above ${dir})`;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// Why the folder isn't right, or null when it is (or doesn't exist yet and the folders above it are
// right: checkFolder makes it). Every answer starts with the failing path, its owner and its mode.
export function folderWhy(dir: string, uid = own()): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e: any) { return e?.code === "ENOENT" ? aboveWhy(dir, uid) : `${dir} can't be looked at`; }
  if (st.isSymbolicLink()) return `${described(dir, st)}, and is a symlink`;
  if (!st.isDirectory()) return `${described(dir, st)}, and isn't a folder`;
  if (st.uid !== uid || (st.mode & 0o7777) !== 0o700) return `${described(dir, st)}, not ${ownerWords(uid)}'s with mode 0700`;
  return aboveWhy(dir, uid);
}

// Each folder from the probe's own up to /, with its owner, its mode and its verdict, one line each:
// what the first Pi drill prints (main.ts folders). Read only: nothing is made or changed.
export function chainVerdicts(dir: string, uid = own()): string[] {
  const out: string[] = [];
  let st: Stats | null = null;
  try { st = lstatSync(dir); } catch { out.push(`${dir}: missing, made ${ownerWords(uid)}'s with mode 0700 at its next use`); }
  if (st) {
    const bad = st.isSymbolicLink() ? "a symlink" : !st.isDirectory() ? "not a folder"
      : st.uid !== uid || (st.mode & 0o7777) !== 0o700 ? `not ${ownerWords(uid)}'s with mode 0700` : null;
    out.push(`${described(dir, st)}: ${bad === null ? "ok" : `REFUSED, ${bad}`}`);
  }
  let cur: string;
  try { cur = realpathSync(dirname(dir)); } catch { out.push(`${dirname(dir)}: can't be looked at, REFUSED`); return out; }
  for (;;) {
    let s2;
    try { s2 = statSync(cur); } catch { out.push(`${cur}: can't be looked at, REFUSED`); return out; }
    const bad = aboveOne(cur, s2, uid);
    out.push(`${described(cur, s2)}: ${bad === null ? "ok" : `REFUSED, ${bad}`}`);
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

// The folder right, or FolderTampered. A missing one is made (the probe's own user's, 0700) and looked
// at again.
export function checkFolder(dir: string, uid = own()): void {
  let why = folderWhy(dir, uid);
  if (why === null) {
    let missing = false;
    try { lstatSync(dir); } catch (e: any) { missing = e?.code === "ENOENT"; }
    if (missing) {
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch { /* looked at below */ }
      why = folderWhy(dir, uid);
    }
  }
  if (why) throw new FolderTampered(dir, why);
}
