// The Keeper drill switch (Cain 0.19.0, with Keeper 0.1.13). The keeper App arms only after two drill records, and it
// writes a drill record only for an install registered with kind "drill" that it rolled back. This file is how such an
// install comes about, and only through the owner's tap:
//   1. Cain asks for a drill card (keeper.sh drill-arm <exit-on-start|verdict-fail>, the link's /drill-arm). The card
//      only asks: Cain's request sets nothing.
//   2. The owner's tap on it (core.ts drillTap: the tap checked to be his, in his DM, like a Ship tap) is signed here with
//      the link's Ship key, which Cain can't read, and kept by root as the drill flag, /data/trust/keeper-drill.json:
//      "drl1.<payload>.<signature>", payload {v: 1, kind: "keeper-drill", mode, at, exp, nonce}. It is good for a day.
//   3. The next registration of Cain spends it (ship-pass.ts registerInstalls): the flag is removed before the keeper is
//      asked, so it counts once whatever happens next, and that registration goes as kind "drill". A flag whose signature
//      doesn't verify with the link's own public key, or that ran out, is removed and never counts: that registration goes
//      as kind "ship", as with no flag.
//   4. Once the keeper accepts that drill, the link writes the drill mark, /data/trust/keeper-drill-mark.json: the mode,
//      the attempt, the version being installed, the head and the time. It is written after the keeper's backup, so the
//      backup a rollback restores never holds it (nor the flag, spent before the backup).
//   5. The installed version reads the mark at run time: with "exit-on-start" the run script exits at once
//      (bun drill.ts mode <version>); with "verdict-fail" the verdict probe reports FAIL for that attempt
//      (probe/keeper.ts). A mark counts only for the version it names, within MARK_TTL_MS of being written, so the
//      version a rollback restores, or any later one, starts as usual. Every new registration removes an old mark first.
// With no flag nothing changes: kind "ship", and a healthy start. The failure comes only from the flag at run time,
// never from code in main.
import { randomBytes, verify as edVerify } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { b64url, publicKey } from "../ship-token";

export const DRILL_MODES = ["exit-on-start", "verdict-fail"] as const;
export type DrillMode = typeof DRILL_MODES[number];
export const isDrillMode = (m: unknown): m is DrillMode => typeof m === "string" && (DRILL_MODES as readonly string[]).includes(m);
export const DRILL_PREFIX = "drl1";
export const DRILL_KIND = "keeper-drill";
export const DRILL_TTL_S = 24 * 3600;             // the flag is good for a day after his tap
const SKEW_S = 5 * 60;
// The mark lasts the acceptance (30 minutes) plus the claim (30) plus the watch (15), with a margin.
export const MARK_TTL_MS = 90 * 60_000;
export const DRILL_APP = "0fcc2575_cain";          // only Cain's installs are drilled (the keeper's watch list)
export const TRUST = "/data/trust";
export const FLAG_FILE = `${TRUST}/keeper-drill.json`;
export const MARK_FILE = `${TRUST}/keeper-drill-mark.json`;
const B64URL = /^[A-Za-z0-9_-]+$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const ATTEMPT = /^drill-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{40}$/;
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// -- the flag: his tap, signed ----------------------------------------------------------------------------------
export function makeDrillFlag(mode: DrillMode, nowMs: number, sign: (data: Buffer) => Buffer): string {
  if (!isDrillMode(mode)) throw new Error("not a drill mode");
  const at = Math.floor(nowMs / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ v: 1, kind: DRILL_KIND, mode, at, exp: at + DRILL_TTL_S, nonce: randomBytes(8).toString("hex") })));
  return `${DRILL_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${DRILL_PREFIX}.${payload}`, "utf8")))}`;
}
export type FlagRead = { ok: true; mode: DrillMode; at: number } | { ok: false; why: string };
// The flag, checked with the link's own public Ship key (base64 SPKI): signed by it, a drill flag, a known mode, not run out.
export function readDrillFlag(text: string | null, pubB64: string | null, nowMs: number): FlagRead {
  const parts = String(text ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== DRILL_PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return { ok: false, why: "it isn't a drill flag" };
  if (!pubB64) return { ok: false, why: "the link's Ship key can't be read, so the tap's signature can't be checked" };
  let good = false;
  try { const sig = unb64url(parts[2]); good = sig.length === 64 && edVerify(null, Buffer.from(`${DRILL_PREFIX}.${parts[1]}`, "utf8"), publicKey(pubB64), sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its signature isn't the link's: no tap of the owner's set it" };
  let c: any;
  try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its payload can't be read" }; }
  if (!c || c.v !== 1 || c.kind !== DRILL_KIND || !isDrillMode(c.mode) || !Number.isSafeInteger(c.at) || !Number.isSafeInteger(c.exp)) return { ok: false, why: "its payload isn't a drill flag" };
  const now = nowMs / 1000;
  if (c.exp <= now) return { ok: false, why: "it ran out (a drill flag is good for a day after the tap)" };
  if (c.exp - c.at > DRILL_TTL_S || c.at > now + SKEW_S) return { ok: false, why: "its times aren't a drill flag's" };
  return { ok: true, mode: c.mode, at: c.at * 1000 };
}

// -- the mark: the accepted drill, read at run time ------------------------------------------------------------
export interface DrillMark { v: 1; mode: DrillMode; attempt: string; to_version: string; head: string; at: number }
export function parseMark(text: string | null, nowMs: number): DrillMark | null {
  try {
    const j = JSON.parse(text ?? "");
    if (!j || j.v !== 1 || !isDrillMode(j.mode) || !ATTEMPT.test(String(j.attempt)) || !VERSION.test(String(j.to_version)) || !SHA.test(String(j.head))
      || !Number.isSafeInteger(j.at) || j.at > nowMs + SKEW_S * 1000 || nowMs - j.at > MARK_TTL_MS) return null;
    return { v: 1, mode: j.mode, attempt: j.attempt, to_version: j.to_version, head: j.head, at: j.at };
  } catch { return null; }
}
// What this start of version must do: the mark's mode when it names this version (and, given, this attempt), else null.
export function drillModeFor(text: string | null, version: string, nowMs: number, attempt?: string): DrillMode | null {
  const m = parseMark(text, nowMs);
  if (!m || m.to_version !== version) return null;
  if (attempt !== undefined && m.attempt !== attempt) return null;
  return m.mode;
}

// -- the files, root's -------------------------------------------------------------------------------------------
export interface DrillStore {
  loadFlag: () => string | null;                  // null: none
  removeFlag: () => void;                         // throws when it can't
  storeFlag: (text: string) => void;
  loadMark: () => string | null;
  storeMark: (text: string) => void;
  removeMark: () => void;
}
function writeWhole(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
const readOrNull = (p: string) => { try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; } };
export function fileStore(flag = FLAG_FILE, mark = MARK_FILE): DrillStore {
  return {
    loadFlag: () => readOrNull(flag), removeFlag: () => rmSync(flag, { force: true }), storeFlag: (t) => writeWhole(flag, t),
    loadMark: () => readOrNull(mark), storeMark: (t) => writeWhole(mark, t), removeMark: () => rmSync(mark, { force: true }),
  };
}

// His tap's flag, written (core.ts drillTap calls this through main.ts armDrill, after it checked the tap is his).
export function armFlag(store: DrillStore, mode: DrillMode, nowMs: number, sign: (data: Buffer) => Buffer): { ok: boolean; why: string } {
  if (!isDrillMode(mode)) return { ok: false, why: "that isn't a drill mode" };
  try { store.storeFlag(makeDrillFlag(mode, nowMs, sign)); return { ok: true, why: "" }; }
  catch (e) { return { ok: false, why: `the drill flag couldn't be written (${String((e as Error)?.message ?? e).slice(0, 60)})` }; }
}

// -- the registration's side (ship-pass.ts registerInstalls) ---------------------------------------------------
export type Spent = { mode: DrillMode | null } | { error: string };
export interface DrillDeps {
  clear: () => void;                              // an old mark removed before a new registration
  spend: () => Spent;                             // the flag, read and removed: its mode, none, or why it couldn't be spent
  mark: (m: DrillMark) => void;                   // the accepted drill's mark (throws when it can't be written)
  drop: (attempt: string) => void;                // the mark removed if it names this attempt (its pass ended without a run)
}
export function drillDeps(store: DrillStore, pub: () => string | null, now: () => number, log: (l: string) => void): DrillDeps {
  return {
    clear: () => {
      try { if (store.loadMark() !== null) { store.removeMark(); log("an earlier drill mark was removed before this registration"); } }
      catch { log("an earlier drill mark couldn't be removed (it lapses by itself 90 minutes after it was written)"); }
    },
    spend: () => {
      let text: string | null;
      try { text = store.loadFlag(); } catch { return { error: "the drill flag can't be read" }; }
      if (text === null) return { mode: null };
      try { store.removeFlag(); } catch { return { error: "the drill flag couldn't be spent (removed), so it might count twice" }; }
      const r = readDrillFlag(text, pub(), now());
      if (!r.ok) { log(`a drill flag was refused and removed: ${(r as { why: string }).why}; this registration is kind ship`); return { mode: null }; }
      log(`the owner's drill flag (${r.mode}) is spent by this registration: it goes as kind drill`);
      return { mode: r.mode };
    },
    mark: (m) => store.storeMark(JSON.stringify(m)),
    drop: (attempt) => {
      try { const m = parseMark(store.loadMark(), now()); if (m && m.attempt === attempt) { store.removeMark(); log(`the drill mark of ${attempt} was removed: its pass ended without a run`); } }
      catch { /* it lapses by itself */ }
    },
  };
}

// bun drill.ts mode <version>: the mode a start of that version must show, or nothing (the run script, as root).
if (import.meta.main) {
  const [cmd, version] = process.argv.slice(2);
  if (cmd !== "mode" || !version) { console.error("usage: drill.ts mode <version>"); process.exit(2); }
  let text: string | null = null;
  try { text = readOrNull(process.env.CAIN_DRILL_MARK ?? MARK_FILE); } catch { text = null; }
  const mode = drillModeFor(text, version, Date.now());
  if (mode) process.stdout.write(`${mode}\n`);
}
