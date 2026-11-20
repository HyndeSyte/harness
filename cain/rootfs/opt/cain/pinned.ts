// Files his user must read and only root writes (Cain 0.15.0): root:cain 0640, pinned on every write,
// whatever the writer's umask (the run script's is 027) and whatever was there before. The holds fix
// (0.13.5) kept an existing file's owner and mode on rewrite; a file made fresh (after a restore, or
// the first write) still came out root:root, so his session couldn't read /data/trust/cards.json, his
// DM's chat id after a restart and what fetch_messages needs for his DM. Shared by every such writer.
// And (second round) the panel's unix sockets, root:nogroup 0770 like ttyd's (pinSocket).
import { chmodSync, chownSync } from "node:fs";
import { chmod, chown, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PINNED_MODE = 0o640;
export const SOCKET_MODE = 0o770;
const gid = () => Number(process.env.CAIN_GID ?? 1000);
const isRoot = () => process.getuid?.() === 0;
// Root must manage the chown; a failure there is logged, never swallowed (second round). A writer that
// isn't root (the tests) can't give a file away and keeps the mode only.
const chownFailed = (what: string, p: string, e: unknown) => {
  if (isRoot()) console.error(`[cain] couldn't give ${p} to ${what}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
};

export async function writePinned(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: PINNED_MODE });
  try { await chown(tmp, 0, gid()); } catch (e) { chownFailed("root:cain", path, e); }
  await chmod(tmp, PINNED_MODE);
  await rename(tmp, path);
}

// A unix socket only nginx's workers (nobody:nogroup) and root may open: root:nogroup 0770, the same
// as ttyd's (terminal/run: --socket-owner root:nogroup under umask 0007). The mode is set whether or
// not the chown worked.
export function pinSocket(path: string, nginxGid = Number(process.env.NGINX_GID ?? 65534)): void {
  try { chownSync(path, 0, nginxGid); } catch (e) { chownFailed("root:nogroup", path, e); }
  chmodSync(path, SOCKET_MODE);
}
