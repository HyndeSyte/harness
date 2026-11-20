// The probe's folders (Cain 0.14.0, fifth round): /data/probe and /run/cain/probe. Before every read
// or write under one of them, the folder itself is looked at without following a link (lstat): a real
// folder, not a symlink, owned by the user the probe runs as (root on the Pi) and mode 0700. Anything
// else is refused (FolderTampered) and alarmed once, "Cain's probe folder was tampered with": the
// probe then neither reads nor writes there until the folder is right again.
import { lstatSync } from "node:fs";

export class FolderTampered extends Error {
  constructor(readonly dir: string, readonly why: string) { super(`${dir}: ${why}`); this.name = "FolderTampered"; }
}

const own = () => (typeof process.getuid === "function" ? process.getuid() : 0);

// Why the folder isn't right, or null when it is (or doesn't exist yet: it is made root's 0700 by
// whoever writes first, then checked again).
export function folderWhy(dir: string, uid = own()): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e: any) { return e?.code === "ENOENT" ? null : "can't be looked at"; }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isDirectory()) return "isn't a folder";
  if (st.uid !== uid) return "isn't root's";
  if ((st.mode & 0o7777) !== 0o700) return `has mode ${(st.mode & 0o7777).toString(8).padStart(4, "0")}, not 0700`;
  return null;
}
export function checkFolder(dir: string, uid = own()): void {
  const why = folderWhy(dir, uid);
  if (why) throw new FolderTampered(dir, why);
}
