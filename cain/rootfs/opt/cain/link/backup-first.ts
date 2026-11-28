// Backup first (Cain 0.19.4, with Keeper 0.1.19). Cain's backup is cold: the Keeper's backup of him stops and starts his App,
// and the link with it. Before this, the Keeper backed Cain up only once the link had registered his install, so the restarted
// link found its own registration open and cancelled it (ship-pass.ts reconcilePasses): every install of Cain through the Keeper
// failed. Now nothing is resumed across that restart:
//   1. On the owner's Ship tap for a change that installs Cain, once it is in main, the link records only the tap, on disk, in
//      root's /data/trust (the pull request, its head, his card and the time; no attempt, no token), and asks the Keeper to back
//      Cain up now (POST /backup-first). That backup stops and starts Cain.
//   2. After the restart (or, should the backup not stop the link, once the Keeper says it is made), the link reads the recorded
//      tap once and removes it, whatever follows: only a tap under TAP_WINDOW_MS old, not used before, still on his card, with no
//      Stop since and the pull request's head unchanged on GitHub gets the Ship token, as for any other App. Its Ship run then
//      registers the install at its pass as usual, and the Keeper accepts it against the backup it took first.
//   3. Anything else issues nothing: Cain hears one line saying why, and the card says a new Ship tap installs it.
// The tap and the list of used taps are left out of Cain's backups (config.yaml backup_exclude), so a restore never brings either
// back. Changes that don't install Cain don't come here at all.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";

export const TAP_WINDOW_MS = 10 * 60_000;           // a recorded tap counts this long after it was recorded
export const USED_MAX = 50;                          // the used taps kept (their ids)
export const CAIN_SLUG = "0fcc2575_cain";

export interface FirstTap { v: 1; pr: string; head: string; msg: string; at: number }
export interface FirstStore {
  load: () => FirstTap | null | "unreadable";        // the recorded tap; null: none
  store: (t: FirstTap) => void;                      // throws when it can't be kept
  drop: () => void;                                  // throws when it can't be removed
  used: () => string[] | null;                       // the used taps' ids; null: unreadable
  markUsed: (id: string) => void;                    // throws when it can't be kept
}
export type FirstAsk = { ok: true } | { ok: false; why: string };
export type FirstStatus = { status: "none" | "making" | "ready" | "failed"; pr?: number; head?: string; why?: string };
export interface FirstDeps {
  store: FirstStore;
  installsCain: (ship: { pr: string; head: string }) => Promise<boolean | null>;   // null: can't tell
  ask: (ship: { pr: string; head: string }) => Promise<FirstAsk>;                  // POST /backup-first on the Keeper
  status?: () => Promise<FirstStatus | null>;                                       // GET /backup-first on the Keeper
  head: (ship: { pr: string; head: string }) => Promise<string | null>;            // the pull request's head on GitHub now
  booted: number;                                                                   // when this link process started
}

const SHA = /^[0-9a-f]{40}$/;
export const tapId = (t: FirstTap) => createHash("sha256").update(`backup-first-v1\n${t.pr}\n${t.head}\n${t.msg}\n${t.at}`).digest("hex").slice(0, 32);
export function parseTap(text: string): FirstTap | "unreadable" {
  try {
    const j = JSON.parse(text);
    return j?.v === 1 && typeof j.pr === "string" && SHA.test(j.head) && typeof j.msg === "string" && Number.isFinite(j.at) && j.at > 0
      ? { v: 1, pr: j.pr, head: j.head, msg: j.msg, at: j.at } : "unreadable";
  } catch { return "unreadable"; }
}

// The files: the tap in root's /data/trust, the used ids in the link's own folder, each written whole and synced.
export function fileFirstStore(tapPath: string, usedPath: string, write: (path: string, text: string) => void): FirstStore {
  const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; } };
  return {
    load: () => { try { const t = read(tapPath); return t === null ? null : parseTap(t); } catch { return "unreadable"; } },
    store: (t) => write(tapPath, JSON.stringify(t)),
    drop: () => rmSync(tapPath, { force: true }),
    used: () => {
      try {
        const t = read(usedPath);
        if (t === null) return [];
        const j = JSON.parse(t);
        return Array.isArray(j?.used) ? j.used.filter((x: unknown) => typeof x === "string") : null;
      } catch { return null; }
    },
    markUsed: (id) => {
      let prior: string[] = [];
      try { const t = read(usedPath); if (t !== null) { const j = JSON.parse(t); if (Array.isArray(j?.used)) prior = j.used.filter((x: unknown) => typeof x === "string"); } } catch { prior = []; }
      write(usedPath, JSON.stringify({ used: [...prior, id].slice(-USED_MAX) }));
    },
  };
}

// The Keeper's answer to POST /backup-first: 202 (being made) or 200 ready counts as asked; anything else is why not.
export function judgeAsk(r: { status: number; body: any } | null): FirstAsk {
  if (!r) return { ok: false, why: "the Keeper didn't answer" };
  if ((r.status === 202 && r.body?.status === "pending") || (r.status === 200 && r.body?.status === "ready")) return { ok: true };
  return { ok: false, why: `the Keeper refused it${r.body?.why ? ` (${String(r.body.why).replace(/[^\x20-\x7e]/g, " ").slice(0, 160)})` : ""}` };
}
export function judgeStatus(r: { status: number; body: any } | null): FirstStatus | null {
  if (!r || r.status !== 200 || !["none", "making", "ready", "failed"].includes(r.body?.status)) return null;
  return { status: r.body.status, ...(Number.isSafeInteger(r.body.pr) ? { pr: r.body.pr } : {}), ...(typeof r.body.head === "string" ? { head: r.body.head } : {}),
    ...(r.body.why ? { why: String(r.body.why).replace(/[^\x20-\x7e]/g, " ").slice(0, 160) } : {}) };
}
