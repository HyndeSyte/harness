// Files his user must read and only root writes (Cain 0.15.0): root:cain 0640, pinned on every write,
// whatever the writer's umask (the run script's is 027) and whatever was there before. The holds fix
// (0.13.5) kept an existing file's owner and mode on rewrite; a file made fresh (after a restore, or
// the first write) still came out root:root, so his session couldn't read /data/trust/cards.json, his
// DM's chat id after a restart and what fetch_messages needs for his DM. Shared by every such writer.
import { chmodSync, chownSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, chown, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PINNED_MODE = 0o640;
const gid = () => Number(process.env.CAIN_GID ?? 1000);
// Root may give the file to his group; a writer that isn't root (the tests) keeps the mode at least.
const give = (p: string) => { try { chownSync(p, 0, gid()); } catch { /* not root */ } chmodSync(p, PINNED_MODE); };

export function writePinnedSync(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: PINNED_MODE });
  give(tmp);
  renameSync(tmp, path);
}

export async function writePinned(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: PINNED_MODE });
  try { await chown(tmp, 0, gid()); } catch { /* not root */ }
  await chmod(tmp, PINNED_MODE);
  await rename(tmp, path);
}
