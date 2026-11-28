// Backup first (Cain 0.19.4, with Keeper 0.1.19). Cain's backup is cold: the Keeper's backup of him stops and starts his App,
// and the link with it. Before this, the Keeper backed Cain up only once the link had registered his install, so the restarted
// link found its own registration open and cancelled it (ship-pass.ts reconcilePasses): every install of Cain through the Keeper
// failed. Now nothing is resumed across that restart, and one tap identity runs end to end:
//   1. On the owner's Ship tap for a change that installs Cain, once it is in main, the link reads what will actually install
//      (main's commit and Cain's version there, which must be the card's), mints a random tap nonce and a request id, and keeps
//      them on disk with the tap (root's /data/trust; the restore mark beside the link's state) before it asks the Keeper:
//      POST /backup-first {app, pr, head, request, nonce, main, to_version}, idempotent by request id. The Keeper names the
//      backup by that nonce, and that backup stops and starts Cain.
//   2. At every sweep (after the restart, or while the link was never stopped) the link asks the Keeper about its own request:
//      GET /backup-first?app=<slug>&request=<id>. Pending keeps waiting within the tap's window; only "ready" with the backup
//      verified and unconsumed goes on; failed, unknown or anything else discards the tap with one line. Never on POST's answer.
//   3. Before the token: still his card, no Stop since, no restore since (the mark and the Keeper's restore time), the pull
//      request's head and main's commit and version unchanged. Then the consume, crash-safe: the nonce appended to the used
//      list (file and folder synced), the tap file removed (folder synced), and only then the token. A re-read after a crash
//      anywhere in between finds the nonce used and issues nothing.
//   4. The Ship run's registration of Cain carries the same nonce and main commit (from the used list, matched to the token's
//      claim), and the Keeper uses that backup only for that nonce, once; its claim checks main's commit again.
// A Stop or a second tap gets a new nonce: the tap file holds only the newest, and the Keeper uses only the newest unconsumed.
// The tap and the used list are left out of Cain's backups (config.yaml backup_exclude); a Supervisor restore replaces the App's
// data folder whole, so it deletes them (DOCS "An update of Cain himself"). The mark is in the backups on purpose: a restore of
// any backup taken before the tap brings back a mark without this tap's nonce, which the link reads as a restore since the tap.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { TAP_WINDOW_MS } from "./backup-first-timing";

export { FIRST_BACKUP_MS, FIRST_PHASES_MS, RUN_START_MS, TAP_WINDOW_MS } from "./backup-first-timing";
export const USED_MAX = 50;                          // the used taps kept
export const CAIN_SLUG = "0fcc2575_cain";

export interface FirstTap { v: 2; pr: string; head: string; msg: string; at: number; nonce: string; request: string; main: string; version: string }
export interface UsedTap { nonce: string; pr: string; head: string; exp: number; main: string; version: string; at: number }
export interface FirstStore {
  load: () => FirstTap | null | "unreadable";        // the recorded tap; null: none
  store: (t: FirstTap) => void;                      // written whole and synced (file and folder); throws when it can't be kept
  drop: () => void;                                  // removed and its folder synced; throws when it can't be
  used: () => UsedTap[] | null;                      // the used taps; null: unreadable
  markUsed: (u: UsedTap) => void;                    // appended, file and folder synced; throws when it can't be kept
  mark: () => string | null;                         // the restore mark: the nonce of the newest tap; null: none or unreadable
  setMark: (nonce: string) => void;                  // throws when it can't be kept
}
export type FirstAsk = { ok: true } | { ok: false; why: string };
// The Keeper's word on one request: making, ready (with verified), failed, consumed, unknown (it has no such request), none.
export type FirstStatus = { status: "none" | "making" | "ready" | "failed" | "consumed" | "unknown"; request?: string; verified?: boolean;
  why?: string; restoredAt?: number; windowMs?: number };
export interface FirstDeps {
  store: FirstStore;
  // the version of Cain the tap installs (Cain bumped between the base and the head), false when it doesn't install Cain, null: can't tell
  installsCain: (ship: { pr: string; head: string }) => Promise<string | false | null>;
  mainNow: (ship: { pr: string }) => Promise<{ sha: string; version: string } | null>;   // main's commit and Cain's version there
  ask: (ship: { pr: string; head: string }, tap: FirstTap) => Promise<FirstAsk>;          // POST /backup-first on the Keeper
  status: (request: string) => Promise<FirstStatus | null>;                               // GET /backup-first on the Keeper; null: no answer
  head: (ship: { pr: string; head: string }) => Promise<string | null>;                   // the pull request's head on GitHub now
  advertised?: () => Promise<boolean | null>;   // does the Keeper serve backup-first at all (an older Keeper answers 404); null: no answer
  booted: number;                                                                         // when this link process started
  random?: (bytes: number) => string;                                                     // hex; tests pass their own
}

const SHA = /^[0-9a-f]{40}$/;
const HEX = /^[0-9a-f]{16,64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
export const mintHex = (bytes: number) => randomBytes(bytes).toString("hex");
export function parseTap(text: string): FirstTap | "unreadable" {
  try {
    const j = JSON.parse(text);
    return j?.v === 2 && typeof j.pr === "string" && SHA.test(j.head) && typeof j.msg === "string" && Number.isFinite(j.at) && j.at > 0
      && HEX.test(j.nonce) && HEX.test(j.request) && SHA.test(j.main) && VERSION.test(j.version)
      ? { v: 2, pr: j.pr, head: j.head, msg: j.msg, at: j.at, nonce: j.nonce, request: j.request, main: j.main, version: j.version } : "unreadable";
  } catch { return "unreadable"; }
}
const usedOf = (x: any): UsedTap | null => x && typeof x === "object" && HEX.test(x.nonce) && typeof x.pr === "string" && SHA.test(x.head)
  && Number.isSafeInteger(x.exp) && SHA.test(x.main) && VERSION.test(x.version) ? { nonce: x.nonce, pr: x.pr, head: x.head, exp: x.exp, main: x.main, version: x.version, at: Number(x.at) || 0 } : null;

// The files: the tap in root's /data/trust, the used list and the mark in the link's own folder, each written whole and synced.
export function fileFirstStore(tapPath: string, usedPath: string, markPath: string, write: (path: string, text: string) => void,
    syncDir: (dir: string) => void): FirstStore {
  const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; } };
  const used = (): UsedTap[] | null => {
    try {
      const t = read(usedPath);
      if (t === null) return [];
      const j = JSON.parse(t);
      return Array.isArray(j?.used) ? j.used.map(usedOf).filter((x: UsedTap | null): x is UsedTap => !!x) : null;
    } catch { return null; }
  };
  return {
    load: () => { try { const t = read(tapPath); return t === null ? null : parseTap(t); } catch { return "unreadable"; } },
    store: (t) => write(tapPath, JSON.stringify(t)),
    drop: () => { rmSync(tapPath, { force: true }); syncDir(dirname(tapPath)); },
    used,
    // an unreadable list is never written over: the consume fails, and the tap gets nothing
    markUsed: (u) => { const prior = used(); if (prior === null) throw new Error("the used list can't be read"); write(usedPath, JSON.stringify({ used: [...prior, u].slice(-USED_MAX) })); },
    mark: () => { try { const t = read(markPath); if (t === null) return null; const j = JSON.parse(t); return HEX.test(j?.nonce) ? j.nonce : null; } catch { return null; } },
    setMark: (nonce) => write(markPath, JSON.stringify({ nonce })),
  };
}

// The Keeper's answer to POST /backup-first: 202 (being made) or 200 (made) counts as asked, nothing more (the token waits for
// GET's word); anything else is why not.
export function judgeAsk(r: { status: number; body: any } | null): FirstAsk {
  if (!r) return { ok: false, why: "the Keeper didn't answer" };
  if ((r.status === 202 && r.body?.status === "pending") || (r.status === 200 && ["ready", "making"].includes(r.body?.status))) return { ok: true };
  if (r.status === 404) return { ok: false, why: "the Keeper doesn't back Cain up first (it is older than Keeper 0.1.19)" };
  return { ok: false, why: `the Keeper refused it${r.body?.why ? ` (${clean(r.body.why)})` : ""}` };
}
const clean = (x: unknown) => String(x).replace(/[^\x20-\x7e]/g, " ").slice(0, 160);
export function judgeStatus(r: { status: number; body: any } | null): FirstStatus | null {
  if (!r) return null;
  if (r.status === 404 && r.body?.status !== "unknown") return { status: "unknown", why: "the Keeper doesn't serve backup-first" };
  const st = r.body?.status;
  if ((r.status !== 200 && r.status !== 404) || !["none", "making", "ready", "failed", "consumed", "unknown"].includes(st)) return null;
  const at = typeof r.body.restored_at === "string" ? Date.parse(r.body.restored_at) : NaN;
  return { status: st, ...(typeof r.body.request === "string" ? { request: r.body.request } : {}), ...(r.body.verified === true ? { verified: true } : {}),
    ...(r.body.why ? { why: clean(r.body.why) } : {}), ...(Number.isFinite(at) ? { restoredAt: at } : {}),
    ...(Number.isSafeInteger(r.body.window_ms) ? { windowMs: r.body.window_ms } : {}) };
}
// The used tap that a Ship token's claim stands for: same pull request number and head, and the token's expiry. The Ship pass reads
// it to give Cain's registration the tap's nonce and main commit (ship-pass.ts registerInstalls).
export function usedFor(list: UsedTap[] | null, c: { pr: number; head: string; exp: number }): UsedTap | null {
  return (list ?? []).filter((u) => Number(/\/pull\/(\d+)$/.exec(u.pr)?.[1]) === c.pr && u.head === c.head && u.exp === c.exp).pop() ?? null;
}
export const tapAge = (now: number, at: number) => `${Math.max(0, Math.round((now - at) / 1000))} seconds`;
export const windowOk = (now: number, at: number) => now - at <= TAP_WINDOW_MS;
export const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
