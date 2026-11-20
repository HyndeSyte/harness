// The probe's folders (Cain 0.14.0): /data/probe and /run/cain/probe. Before every read or write under
// one of them, the folder itself is looked at without following a link (lstat): a real folder, not a
// symlink, owned by the user the probe runs as (root on the Pi) and mode 0700. Sixth round: every
// folder above it, up to /, must be root's (or the probe's own user's) and not writable by anyone
// else (a root-owned sticky folder, like /tmp, can't have another's entry renamed, so it passes), so
// uid 1000 can't rename or replace the folder from above (lock.sh fixes what it can at start). A
// missing folder is made with the right owner and mode, then looked at again, rather than refused.
// Anything else is refused (FolderTampered) and alarmed, "Cain's probe folder was tampered with",
// again each day while it lasts: the probe then neither reads nor writes there, and pings nothing, until
// the folder is right again.
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class FolderTampered extends Error {
  constructor(readonly dir: string, readonly why: string) { super(`${dir}: ${why}`); this.name = "FolderTampered"; }
}

const own = () => (typeof process.getuid === "function" ? process.getuid() : 0);

// Why a folder above the probe's isn't safe, or null when every one up to / is: root's (or the
// probe's own user's), and writable by no one else unless it is root's and sticky.
export function aboveWhy(dir: string, uid = own()): string | null {
  let cur: string;
  try { cur = realpathSync(dirname(dir)); } catch { return "has a folder above it that can't be looked at"; }
  for (;;) {
    let st;
    try { st = statSync(cur); } catch { return `has ${cur} above it, which can't be looked at`; }
    if (st.uid !== 0 && st.uid !== uid) return `has ${cur} above it, which isn't root's`;
    if ((st.mode & 0o022) !== 0 && !((st.mode & 0o1000) !== 0 && st.uid === 0)) return `has ${cur} above it, which others can write`;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// Why the folder isn't right, or null when it is (or doesn't exist yet and the folders above it are
// right: checkFolder makes it).
export function folderWhy(dir: string, uid = own()): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e: any) { return e?.code === "ENOENT" ? aboveWhy(dir, uid) : "can't be looked at"; }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isDirectory()) return "isn't a folder";
  if (st.uid !== uid) return "isn't root's";
  if ((st.mode & 0o7777) !== 0o700) return `has mode ${(st.mode & 0o7777).toString(8).padStart(4, "0")}, not 0700`;
  return aboveWhy(dir, uid);
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
