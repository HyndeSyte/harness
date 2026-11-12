// The Discord plugin's upkeep, run by services.d/cain/run. It never changes the plugin.
//   - At start: a loud log line unless access.json is single-owner DM only, and unless
//     the installed plugin is the pinned one (pin.json). Then it carries on: the reads
//     hook (hooks/discord-read.ts) refuses while either is wrong, so no crash loop.
//   - At start and daily: the plugin's inbox (where download_attachment writes, under
//     names the plugin makes: <ms>-<attachment id>.<ext>) loses files older than 7 days,
//     then the oldest files until it holds at most 200 MB.
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { accessHere, checkAccess, pinCheckHere } from "../hooks/discord-read.ts";

export const MAX_AGE_MS = 7 * 24 * 3_600_000;
export const MAX_BYTES = 200 * 1024 * 1024;
const INBOX = process.env.CAIN_DISCORD_INBOX ?? "/data/.claude/channels/discord/inbox";
const DAY_MS = 24 * 3_600_000;

// Deletes old files, then the oldest until the inbox fits. Only plain files directly in it.
export function sweepInbox(dir: string, now: number, maxAgeMs = MAX_AGE_MS, maxBytes = MAX_BYTES): { removed: number; kept: number; bytes: number } {
  let names: string[];
  try { names = readdirSync(dir); } catch { return { removed: 0, kept: 0, bytes: 0 }; }
  const files: { path: string; mtime: number; size: number }[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try { const st = lstatSync(path); if (st.isFile()) files.push({ path, mtime: st.mtimeMs, size: st.size }); } catch {}
  }
  files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  let removed = 0;
  const gone = (p: string) => { try { unlinkSync(p); removed++; return true; } catch { return false; } };
  const kept = files.filter((f) => !(now - f.mtime > maxAgeMs && gone(f.path)));
  let bytes = kept.reduce((s, f) => s + f.size, 0);
  for (let i = 0; i < kept.length && bytes > maxBytes; i++)        // oldest first
    if (gone(kept[i].path)) { bytes -= kept[i].size; kept[i].size = -1; }
  const left = kept.filter((f) => f.size >= 0);
  return { removed, kept: left.length, bytes };
}

const log = (m: string) => console.log(`[discord] ${m}`);

if (import.meta.main) {
  const access = checkAccess(accessHere());
  if (access) log(`ERROR: ${access}. Cain's Discord reads are refused until access.json is dmPolicy allowlist, one allowed user, no groups (/discord:access).`);
  const pin = pinCheckHere();
  if (pin) log(`ERROR: ${pin}. Cain's Discord reads are refused until the pinned plugin is installed or a new pin is reviewed.`);
  const sweep = () => {
    const r = sweepInbox(INBOX, Date.now());
    if (r.removed) log(`inbox: removed ${r.removed} file(s), ${r.kept} left (${(r.bytes / 1048576).toFixed(1)} MB)`);
  };
  sweep();
  setInterval(sweep, DAY_MS);
}
