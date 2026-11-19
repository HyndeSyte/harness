// A reply with a link the reply hook held for keeper.sh reply, and the keeper replies sent since
// (Cain 0.13.0, third round): when one was held more than 10 minutes ago and no keeper reply has gone
// out since, the check-in says so (security/main.ts lines), since the assistant may have forgotten to
// send it again. Two small files, one writer each: the hook writes the hold, the link the keeper reply.
// Each holds only a time, never the words.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Root's folder (/data/link), not Cain's /data/work: since Cain runs as his own user (0.13.1) the
// gate (the broker) and the link write these as root, and root never writes into a folder of his.
export const LINK_HELD = process.env.CAIN_LINK_HELD ?? "/data/link/link-held.json";
export const KEEPER_SENT = process.env.CAIN_KEEPER_SENT ?? "/data/link/keeper-reply.json";
export const HELD_WAIT_MS = 10 * 60_000;      // a hold older than this, with no keeper reply since, is named
export const HELD_FORGET_MS = 24 * 3_600_000; // and named for a day at most
export const HELD_LINE = "a reply with a link is waiting: send it with keeper.sh reply";

export function noteAt(path: string, at: number): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ at }));
    renameSync(`${path}.tmp`, path);
    return true;
  } catch { return false; }
}
export function readAt(path: string): number | null {
  try { const at = JSON.parse(readFileSync(path, "utf8"))?.at; return typeof at === "number" && Number.isFinite(at) ? at : null; } catch { return null; }
}
// The check-in's line, or null: a hold more than 10 minutes old (and under a day), with no keeper reply since.
export function heldLine(held: number | null, sent: number | null, now: number): string | null {
  if (held === null || now - held <= HELD_WAIT_MS || now - held > HELD_FORGET_MS) return null;
  if (sent !== null && sent >= held) return null;
  return HELD_LINE;
}
