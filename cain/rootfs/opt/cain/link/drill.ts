// The Keeper drill switch (Cain 0.19.0, with Keeper 0.1.14). The keeper App arms only after two drill records, and it
// writes a drill record only for an install registered with kind "drill" that it rolled back, with the link's confirmation
// that it wrote the signed drill mark and the failure that mark's mode names. This file is how such an install comes about,
// and only through the owner's tap:
//   1. Cain asks for a drill card (keeper.sh drill-arm <exit-on-start|verdict-fail> <version>, the link's /drill-arm). The
//      card names the Cain version the next install must carry, and only asks: Cain's request sets nothing.
//   2. The owner's tap on it (core.ts drillTap: the tap checked to be his, in his DM, like a Ship tap) is signed here with
//      the link's Ship key, which Cain can't read, and kept by root as the drill flag, /data/trust/keeper-drill.json (0600):
//      "drl1.<payload>.<signature>", payload {v: 2, kind: "keeper-drill", mode, to_version, at, exp, nonce}. Good for a day.
//   3. The next registration of Cain spends it (ship-pass.ts registerInstalls, spend below). Fail closed: a flag file that
//      exists but doesn't verify (another key, a damaged or old payload, run out), names another version, or whose nonce is
//      already spent, is removed and the install is refused, logged, and the owner paged once. Only when no flag file exists
//      at all does a registration go as kind "ship".
//   4. A good flag's nonce is recorded in root's spent list (/data/link/keeper-drill-spent/<nonce>, created exclusively, kept
//      until the nonce's expiry, outside Cain's backups by backup_exclude) before the flag is removed: of two registrations
//      at once only the one that records it goes on as a drill, and the other stops, saying so. Keeper records every drill
//      nonce too and refuses one twice, so a restore of Cain that brings an old flag back can't register it again.
//   5. Only a definitive acceptance counts: Keeper's answer "accepted" for that drill (its kind, mode and versions) with its
//      verified backup. Anything else (pending past the wait, refused, no answer) refuses the install and pages once.
//   6. Then the link writes the drill mark, /data/trust/keeper-drill-mark.json (0600, root): "drm1.<payload>.<signature>",
//      payload {v: 1, kind: "keeper-drill-mark", version, attempt, mode, exp}, signed with the drill key, an Ed25519 key
//      derived from the Ship key under its own domain (drillKeyFrom). Its public half is /data/trust/keeper-drill-mark.pub
//      (0600, root). And it tells Keeper (POST /attempt/<id>/drill-mark, the mark's hash). A mark that can't be written or
//      isn't confirmed aborts the drill: the attempt is recorded as aborted, cancelled at Keeper, and the owner paged.
//   7. The installed version reads the mark at run time (the run script and the verdict probe, both root): the signature
//      checked first (a hand-written or unsigned mark is ignored and logged), then Keeper asked (GET /attempt, Cain's token)
//      whether that attempt is a drill of that mode and version, its mark confirmed, still in its watch. Only then does
//      "exit-on-start" exit the start, and "verdict-fail" report FAIL for that attempt. Otherwise, or when Keeper doesn't
//      answer, the helper drops the mark and the start goes on as usual. Only the attempt that owns a mark, or a cancel of
//      it, removes it: a competing, retried or rejected registration never does.
// With no flag file nothing changes: kind "ship", and a healthy start. The failure comes only from the flag, never from main.
//
// Keeper 0.1.15 (round 16):
//   - item 12: the flag is bound to the App's slug and the version (payload v 3: {v, kind, app, mode, to_version, at, exp, nonce});
//     a registration of another App leaves it be (ignored, not refused).
//   - item 8: a refused or wrong-version flag never becomes a ship on retry: the refusal is persisted (root's
//     /data/link/keeper-drill-refused.json, beside the spent list) and every install is refused, with one page, until the owner
//     clears it from the page's Clear button or arms a new drill from a card. The flag is consumed by an atomic claim of that exact
//     instance (a rename to keeper-drill.json.claim-<id>), so a replacement written meanwhile is a new instance, never consumed by it.
//   - item 11: a claimed instance left by a crash whose nonce is spent is removed, refused once and paged once; the next install
//     goes as ship. One whose nonce isn't spent yet is spent now (the crash came before the nonce was recorded).
//   - item 15: the spent list keeps a high-water time (.high-water in its folder, the highest clock reading it has seen): a flag
//     is judged against the later of the clock and that time, and pruning removes only entries older than it, so a clock that
//     starts behind at boot can't revive a pruned nonce.
//   - item 14: the mark is root's 0644: readable by the App, never writable by it; the run-time helper asks Keeper about the mark's
//     own attempt only (GET /attempt/<id>, read only).
//   - items 2 and 7: the helper and the verdict probe act on a mark only while Keeper names that attempt a drill in its watch AND
//     tied to the Supervisor's install job made during its claim, made before this start and within JOB_START_MAX_MS of it. A
//     lookup that fails (no answer, a restart, a timeout, an error) keeps the mark: the helper retries within HELPER_BOUND_MS,
//     then records an abort and the start stops (the App's finish pings the outside heartbeat; Keeper, once it sees the App not
//     started, rolls the drill back and pages). A definitive "no drill" (another attempt, closed, mismatched, no such attempt)
//     drops the mark and the start goes on.
//
// The crash ordering (each step durable before the next):
//   read flag -> verify -> record nonce -> remove flag -> register at Keeper -> accepted -> write mark -> confirm to Keeper
//   - before the nonce is recorded: the flag stands untouched; the next registration spends it.
//   - nonce recorded, flag not removed: the next registration finds its nonce spent, removes it, refuses and pages ("arm it
//     again"). It can never count twice.
//   - flag removed, nothing registered: no attempt exists; the pass times out and is refused. Arm again.
//   - registered, no mark: the pass is refused or times out and its attempts are cancelled; no mark, so nothing fails on
//     purpose, and Keeper's drill record needs the mark's confirmation, so none is written.
//   - mark written, not confirmed: the run-time helper finds Keeper doesn't name the mark confirmed and drops it; the pass is
//     refused and its cancel drops the mark too.
//   - mark confirmed: the install goes on as a drill; a refused pass cancels the attempt and drops the mark.
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, verify as edVerify, type KeyObject } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { b64url, publicKey } from "../ship-token";

export const DRILL_MODES = ["exit-on-start", "verdict-fail"] as const;
export type DrillMode = typeof DRILL_MODES[number];
export const isDrillMode = (m: unknown): m is DrillMode => typeof m === "string" && (DRILL_MODES as readonly string[]).includes(m);
export const DRILL_PREFIX = "drl1";
export const DRILL_KIND = "keeper-drill";
export const MARK_PREFIX = "drm1";
export const MARK_KIND = "keeper-drill-mark";
export const DRILL_TTL_S = 24 * 3600;             // the flag is good for a day after his tap
const SKEW_S = 5 * 60;
// The mark lasts the acceptance (30 minutes) plus the claim (30) plus the watch (15), with a margin.
export const MARK_TTL_MS = 90 * 60_000;
export const DRILL_APP = "0fcc2575_cain";          // only Cain's installs are drilled (the keeper's watch list)
export const TRUST = "/data/trust";
export const FLAG_FILE = `${TRUST}/keeper-drill.json`;
export const MARK_FILE = `${TRUST}/keeper-drill-mark.json`;
export const MARK_PUB_FILE = `${TRUST}/keeper-drill-mark.pub`;
export const ABORTED_FILE = `${TRUST}/keeper-drill-aborted.jsonl`;
// Outside Cain's backups (cain/config.yaml backup_exclude "link/keeper-drill-spent*"), root's 0700.
export const SPENT_DIR = "/data/link/keeper-drill-spent";
export const REFUSED_FILE = "/data/link/keeper-drill-refused.json";   // (Keeper 0.1.15) item 8: a refused drill intent, root's 0600
export const CLAIM_SUFFIX = ".claim-";                              // (Keeper 0.1.15) item 8: a claimed flag instance
export const HIGH_WATER = ".high-water";                            // (Keeper 0.1.15) item 15: in the spent list's folder
export const HELPER_BOUND_MS = 90_000;                              // (Keeper 0.1.15) item 7: the helper's retries, in all
export const HELPER_RETRY_MS = 5_000;
export const JOB_START_MAX_MS = 60 * 60_000;                        // (Keeper 0.1.15) item 2: a start this long after its install job at most
// The open attempt's statuses that are "still in its watch" (Keeper core.ts OPEN, less verifying and restoring).
export const WATCH_STATUSES = ["accepted", "claimed", "watching"];
const B64URL = /^[A-Za-z0-9_-]+$/;
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const ATTEMPT = /^drill-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
const NONCE = /^[0-9a-f]{16}$/;
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// -- the flag: his tap, signed with the Ship key ----------------------------------------------------------------
// (Keeper 0.1.15) item 12: v 3, bound to the App's slug as well as the version.
const SLUG = /^[a-z0-9_]{1,64}$/;
export function makeDrillFlag(mode: DrillMode, version: string, nowMs: number, sign: (data: Buffer) => Buffer, app = DRILL_APP): string {
  if (!isDrillMode(mode)) throw new Error("not a drill mode");
  if (!VERSION.test(version)) throw new Error("not a version");
  if (!SLUG.test(app)) throw new Error("not an App slug");
  const at = Math.floor(nowMs / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ v: 3, kind: DRILL_KIND, app, mode, to_version: version, at, exp: at + DRILL_TTL_S, nonce: randomBytes(8).toString("hex") })));
  return `${DRILL_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${DRILL_PREFIX}.${payload}`, "utf8")))}`;
}
export type FlagRead = { ok: true; app: string; mode: DrillMode; version: string; nonce: string; at: number; exp: number } | { ok: false; why: string };
// The flag, checked with the link's own public Ship key (base64 SPKI): signed by it, a drill flag, a known mode, a version,
// a nonce, not run out.
export function readDrillFlag(text: string | null, pubB64: string | null, nowMs: number): FlagRead {
  const parts = String(text ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== DRILL_PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return { ok: false, why: "it isn't a drill flag" };
  if (!pubB64) return { ok: false, why: "the link's Ship key can't be read, so the tap's signature can't be checked" };
  let good = false;
  try { const sig = unb64url(parts[2]); good = sig.length === 64 && edVerify(null, Buffer.from(`${DRILL_PREFIX}.${parts[1]}`, "utf8"), publicKey(pubB64), sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its signature isn't the link's: no tap of the owner's set it" };
  let c: any;
  try { c = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its payload can't be read" }; }
  if (!c || c.v !== 3 || c.kind !== DRILL_KIND || !SLUG.test(String(c.app)) || !isDrillMode(c.mode) || !VERSION.test(String(c.to_version)) || !NONCE.test(String(c.nonce))
    || !Number.isSafeInteger(c.at) || !Number.isSafeInteger(c.exp)) return { ok: false, why: "its payload isn't a drill flag of this version" };
  const now = nowMs / 1000;
  if (c.exp <= now) return { ok: false, why: "it ran out (a drill flag is good for a day after the tap)" };
  if (c.exp - c.at > DRILL_TTL_S || c.at > now + SKEW_S) return { ok: false, why: "its times aren't a drill flag's" };
  return { ok: true, app: c.app, mode: c.mode, version: c.to_version, nonce: c.nonce, at: c.at * 1000, exp: c.exp * 1000 };
}

// -- the drill key: derived from the Ship key under its own domain -----------------------------------------------
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
export const DRILL_KEY_DOMAIN = "cain-keeper-drill-mark-key-v1";
// An Ed25519 key whose seed is HMAC-SHA256(the Ship key's seed, the domain): it signs only drill marks, and a signature with
// it never verifies as the Ship key's (another key), nor a mark as a flag or a Ship token (another prefix and payload kind).
export function drillKeyFrom(shipPriv: KeyObject): { priv: KeyObject; pub: string } {
  const der = shipPriv.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = createHmac("sha256", der.subarray(der.length - 32)).update(DRILL_KEY_DOMAIN).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  return { priv, pub: (createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer).toString("base64") };
}

// -- the mark: the accepted drill, signed, read at run time ----------------------------------------------------
export interface DrillMark { v: 1; kind: typeof MARK_KIND; version: string; attempt: string; mode: DrillMode; exp: number }
export function makeMark(m: { version: string; attempt: string; mode: DrillMode }, nowMs: number, sign: (data: Buffer) => Buffer): string {
  if (!VERSION.test(m.version) || !ATTEMPT.test(m.attempt) || !isDrillMode(m.mode)) throw new Error("not a drill mark");
  const body: DrillMark = { v: 1, kind: MARK_KIND, version: m.version, attempt: m.attempt, mode: m.mode, exp: nowMs + MARK_TTL_MS };
  const payload = b64url(Buffer.from(JSON.stringify(body)));
  return `${MARK_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${MARK_PREFIX}.${payload}`, "utf8")))}`;
}
export type MarkRead = { ok: true; mark: DrillMark } | { ok: false; why: string };
// The mark, checked with the drill key's public half: signed, a mark, well formed, not run out.
export function readMark(text: string | null, pubB64: string | null, nowMs: number): MarkRead {
  const parts = String(text ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== MARK_PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return { ok: false, why: "it isn't a signed drill mark" };
  if (!pubB64) return { ok: false, why: "the drill key's public half can't be read, so its signature can't be checked" };
  let good = false;
  try { const sig = unb64url(parts[2]); good = sig.length === 64 && edVerify(null, Buffer.from(`${MARK_PREFIX}.${parts[1]}`, "utf8"), publicKey(pubB64), sig); } catch { good = false; }
  if (!good) return { ok: false, why: "its signature isn't the link's drill key's" };
  let j: any;
  try { j = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return { ok: false, why: "its payload can't be read" }; }
  if (!j || j.v !== 1 || j.kind !== MARK_KIND || !isDrillMode(j.mode) || !ATTEMPT.test(String(j.attempt)) || !VERSION.test(String(j.version)) || !Number.isSafeInteger(j.exp))
    return { ok: false, why: "its payload isn't a drill mark" };
  if (j.exp <= nowMs) return { ok: false, why: "it ran out" };
  if (j.exp > nowMs + MARK_TTL_MS + SKEW_S * 1000) return { ok: false, why: "its expiry is further off than a mark lasts" };
  return { ok: true, mark: { v: 1, kind: MARK_KIND, version: j.version, attempt: j.attempt, mode: j.mode, exp: j.exp } };
}
// Keeper's answer to GET /attempt/<the mark's attempt> (Keeper 0.1.15 item 14: read only, that attempt alone), judged for a mark:
// that very attempt, a drill of that mode and version, its mark confirmed to Keeper, still in its watch, and (item 2) tied to the
// Supervisor's install job made during its claim, made before this start and within JOB_START_MAX_MS of it. why is "" when it holds.
// definitive: Keeper's answer settles it (another attempt, a ship, another mode or version, no confirmation, closed, no such
// attempt, a job that isn't this start's); otherwise (no answer, an error status, no job tied yet) it may still change (item 7).
export function keeperNames(mark: DrillMark, version: string, view: { status: number; body: any } | null, nowMs = Date.now()): { why: string; definitive: boolean } {
  const later = (why: string) => ({ why, definitive: false }), no = (why: string) => ({ why, definitive: true });
  if (!view) return later("Keeper didn't answer");
  if (view.status === 404) return no("Keeper has no such attempt");
  if (view.status !== 200) return later(`Keeper answered ${view.status}`);
  const b = view.body ?? {};
  if (b.id !== mark.attempt) return no(b.id ? `Keeper answered for ${String(b.id).slice(0, 80)}, not the mark's attempt` : "Keeper's answer names no attempt");
  if (b.kind !== "drill") return no("Keeper registered that attempt as no drill");
  if (b.drill_mode !== mark.mode) return no("Keeper's drill mode for it isn't the mark's");
  if (b.to_version !== version || mark.version !== version) return no("Keeper's version for it isn't this start's");
  if (b.marked !== true) return no("Keeper has no confirmation of the mark");
  if (!WATCH_STATUSES.includes(b.status)) return no(`the attempt is ${String(b.status).slice(0, 30)}, not in its watch`);
  if (typeof b.install_job !== "string" || !b.install_job) return later("Keeper hasn't tied a Supervisor install job to that attempt yet");
  const at = Date.parse(String(b.install_job_at ?? ""));
  if (!Number.isFinite(at)) return later("Keeper's answer doesn't say when its install job was made");
  if (at > nowMs + SKEW_S * 1000) return no(`its install job ${String(b.install_job).slice(0, 40)} was made after this start, so this start isn't from it`);
  if (nowMs - at > JOB_START_MAX_MS) return no(`this start is more than ${JOB_START_MAX_MS / 60_000} minutes after its install job ${String(b.install_job).slice(0, 40)}, so it isn't that install's start`);
  return { why: "", definitive: true };
}
// What this start of version must do: the signed mark's mode when it names this version and Keeper names its attempt as a drill
// still in its watch, tied to its install job; else null with why (the run-time helper and the verdict probe). drop: Keeper's
// answer definitively names no drill, so the mark goes; retry: the lookup failed, so the mark stays (item 7).
export function drillModeFor(text: string | null, pubB64: string | null, version: string, nowMs: number, view: { status: number; body: any } | null):
    { mode: DrillMode | null; why: string; mark?: DrillMark; drop: boolean; retry: boolean } {
  if (text === null) return { mode: null, why: "no mark", drop: false, retry: false };
  const r = readMark(text, pubB64, nowMs);
  if (!r.ok) return { mode: null, why: `a drill mark was ignored: ${(r as { why: string }).why}`, drop: false, retry: false };
  if (r.mark.version !== version) return { mode: null, why: `the drill mark names Cain ${r.mark.version}, not this start's ${version}`, mark: r.mark, drop: false, retry: false };
  const n = keeperNames(r.mark, version, view, nowMs);
  if (n.why && n.definitive) return { mode: null, why: `the drill mark of ${r.mark.attempt} was dropped: ${n.why}`, mark: r.mark, drop: true, retry: false };
  if (n.why) return { mode: null, why: `the drill mark of ${r.mark.attempt} is kept: ${n.why}`, mark: r.mark, drop: false, retry: true };
  return { mode: r.mark.mode, why: "", mark: r.mark, drop: false, retry: false };
}

// -- the files, root's -------------------------------------------------------------------------------------------
// (Keeper 0.1.15) item 8: a refused drill intent, kept until the owner clears it (the page's Clear button) or arms a new drill
export interface RefusedIntent { at: number; why: string; kind: "damaged" | "version"; key: string; armed?: string; version?: string }
export interface DrillStore {
  loadFlag: () => string | null;                  // null: no flag file; throws when it exists but can't be read
  removeFlag: () => void;                         // throws when it can't
  storeFlag: (text: string) => void;
  loadMark: () => string | null;
  storeMark: (text: string) => void;
  removeMark: () => void;
  spent: (nonce: string) => boolean;              // the nonce is in the spent list (throws when the list can't be read)
  recordNonce: (nonce: string, expMs: number) => "recorded" | "taken";   // exclusive: one caller records it; throws on failure
  aborted: (line: string) => void;                // an aborted drill attempt, recorded (best effort: throws when it can't, the caller logs why)
  // (Keeper 0.1.15) item 8: the flag consumed by an atomic claim of its exact instance: claimFlag renames it aside and answers the
  // claimed instance (null: no flag, or another claimed it first); claimed lists instances left claimed (a crash); dropClaim removes one
  claimFlag: () => { id: string; text: string } | null;
  claimed: () => { id: string; text: string }[];
  dropClaim: (id: string) => void;                // throws when it can't
  refused: () => RefusedIntent | null;            // throws when it exists but can't be read
  storeRefused: (r: RefusedIntent) => void;
  clearRefused: () => boolean;                    // true when an intent was there and is gone
  // (Keeper 0.1.15) item 15: the later of now and the highest time the spent list has seen, persisted before it is answered
  highWater: (nowMs: number) => number;
}
// Why a store call failed, for the one log line that says so (Cain 0.19.4): the error's code, system call and path, never a
// file's contents (a parse error says only its kind, since its message can quote the file).
export function storeWhy(e: unknown): string {
  const x = e as { code?: unknown; syscall?: unknown; path?: unknown; name?: unknown } | null;
  const parts: string[] = [];
  const clip = (v: unknown, n: number) => String(v).replace(/[\u0000-\u001f]/g, "?").slice(0, n);
  if (x && typeof x === "object") {
    if (typeof x.code === "string" && x.code) parts.push(clip(x.code, 40));
    if (typeof x.syscall === "string" && x.syscall) parts.push(clip(x.syscall, 40));
    if (typeof x.path === "string" && x.path) parts.push(clip(x.path, 200));
  }
  if (!parts.length) parts.push(x && typeof x === "object" && typeof x.name === "string" && x.name ? clip(x.name, 40) : "no error code");
  return parts.join(", ");
}
// Written whole, durably, root's (0600 whatever the file or its temp was before; Keeper 0.1.15: mode, 0644 for the mark).
// Cain 0.19.4: a stray temp that isn't a regular file (a folder, a link, a socket) is moved aside whole to <temp>.stray-<unix ms>
// (renamed, never followed: a link is moved, not its target), logged once, instead of failing every write after it. Nothing under
// it is deleted; a move that fails throws with the temp's path.
const withPath = (e: any, p: string) => { if (e && typeof e === "object" && !e.path) { try { e.path = p; } catch { /* the code alone */ } } };
function writeWholeLogged(path: string, body: string, mode = 0o600, log?: (l: string) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(tmp); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  if (st && !st.isFile()) {
    const kind = st.isDirectory() ? "a folder" : st.isSymbolicLink() ? "a link" : "not a regular file";
    let ms = Date.now();
    const free = (p: string) => { try { lstatSync(p); return false; } catch (e: any) { if (e?.code === "ENOENT") return true; withPath(e, tmp); throw e; } };
    while (!free(`${tmp}.stray-${ms}`)) ms++;   // never onto an earlier stray: a rename over a file would replace it
    const aside = `${tmp}.stray-${ms}`;
    try { renameSync(tmp, aside); } catch (e: any) { withPath(e, tmp); throw e; }
    log?.(`a stray temp (${kind}) stood in the drill store's way at ${tmp}: moved aside to ${aside}, and the write goes on`);
  }
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, body); fsyncSync(fd); } catch (e: any) { withPath(e, tmp); throw e; } finally { closeSync(fd); }   // an fd's error names no path
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
const readOrNull = (p: string) => {
  try { return readFileSync(p, "utf8"); } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    withPath(e, p);   // Bun leaves the path off a read's error
    throw e;
  }
};
export function fileStore(flag = FLAG_FILE, mark = MARK_FILE, spentDir = SPENT_DIR, abortedFile = ABORTED_FILE, nowFn: () => number = Date.now, refusedFile = REFUSED_FILE,
  log?: (l: string) => void): DrillStore {
  const writeWhole = (path: string, body: string, mode = 0o600) => writeWholeLogged(path, body, mode, log);
  const nonceFile = (n: string) => { if (!NONCE.test(n)) throw new Error("not a nonce"); return join(spentDir, n); };
  const hwFile = join(spentDir, HIGH_WATER);
  const readHw = () => { try { const n = Number(readFileSync(hwFile, "utf8").trim()); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; } };
  const highWater = (nowMs: number) => {
    const was = readHw();
    if (nowMs > was) { mkdirSync(spentDir, { recursive: true, mode: 0o700 }); writeWhole(hwFile, `${nowMs}\n`); return nowMs; }
    return was;
  };
  // (Keeper 0.1.15) item 15: never an entry newer than the high-water time (exp plus a day, against that time, not the clock)
  const prune = () => {
    const hw = highWater(nowFn());
    try {
      for (const n of readdirSync(spentDir)) {
        if (!NONCE.test(n)) continue;
        const f = join(spentDir, n);
        try { const exp = Number(readFileSync(f, "utf8").trim()); if (Number.isFinite(exp) && exp + 86_400_000 < hw) rmSync(f, { force: true }); } catch { /* kept */ }
      }
    } catch { /* none yet */ }
  };
  const claimName = (id: string) => `${flag}${CLAIM_SUFFIX}${id}`;
  return {
    loadFlag: () => readOrNull(flag), removeFlag: () => rmSync(flag, { force: true }), storeFlag: (t) => writeWhole(flag, t),
    loadMark: () => readOrNull(mark), storeMark: (t) => writeWhole(mark, t, 0o644), removeMark: () => rmSync(mark, { force: true }),
    spent: (n) => readOrNull(nonceFile(n)) !== null,
    recordNonce: (n, expMs) => {
      mkdirSync(spentDir, { recursive: true, mode: 0o700 });
      chmodSync(spentDir, 0o700);
      prune();
      let fd: number;
      try { fd = openSync(nonceFile(n), "wx", 0o600); } catch (e: any) { if (e?.code === "EEXIST") return "taken"; throw e; }
      try { writeSync(fd, `${expMs}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      try { const d = openSync(spentDir, "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* the file itself is synced */ }
      return "recorded";
    },
    aborted: (line) => { mkdirSync(dirname(abortedFile), { recursive: true }); appendFileSync(abortedFile, `${line}\n`, { mode: 0o600 }); chmodSync(abortedFile, 0o600); },
    claimFlag: () => {
      const id = randomBytes(6).toString("hex");
      try { renameSync(flag, claimName(id)); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
      try { const d = openSync(dirname(flag), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* the rename stands */ }
      return { id, text: readFileSync(claimName(id), "utf8") };
    },
    claimed: () => {
      let names: string[] = [];
      try { names = readdirSync(dirname(flag)); } catch { return []; }
      const pre = `${flag.slice(dirname(flag).length + 1)}${CLAIM_SUFFIX}`;
      return names.filter((n) => n.startsWith(pre) && /^[0-9a-f]{12}$/.test(n.slice(pre.length))).map((n) => {
        const id = n.slice(pre.length); let text = ""; try { text = readFileSync(claimName(id), "utf8"); } catch { text = ""; } return { id, text };
      });
    },
    dropClaim: (id) => { if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("not a claim"); rmSync(claimName(id), { force: true }); },
    refused: () => { const t = readOrNull(refusedFile); if (t === null) return null; const j = JSON.parse(t); if (!j || typeof j.why !== "string" || typeof j.key !== "string") throw new Error("not a refused intent"); return j; },
    storeRefused: (r) => writeWhole(refusedFile, `${JSON.stringify(r)}\n`),
    clearRefused: () => { const was = existsSync(refusedFile); rmSync(refusedFile, { force: true }); return was; },
    highWater,
  };
}
// Cain 0.19.2: the link's drill store, built here so main.ts needs no fileStore name of its own (it imported watch.ts's
// fileStore under the same name, and Bun bound that one: no highWater, so every install of Cain was refused).
export function linkDrillStore(env: Record<string, string | undefined> = process.env, trustDir = TRUST, linkDir = "/data/link",
  nowFn: () => number = Date.now, log?: (l: string) => void): DrillStore {   // Cain 0.19.4: log, for a stray temp the store clears
  return fileStore(env.CAIN_DRILL_FLAG ?? `${trustDir}/keeper-drill.json`, env.CAIN_DRILL_MARK ?? `${trustDir}/keeper-drill-mark.json`,
    env.CAIN_DRILL_SPENT ?? `${linkDir}/keeper-drill-spent`, `${trustDir}/keeper-drill-aborted.jsonl`, nowFn, `${linkDir}/keeper-drill-refused.json`, log);
}
// The drill key's public half, kept by root beside the mark (main.ts, at each start of the link).
export function storeMarkPub(pub: string, path = MARK_PUB_FILE, log?: (l: string) => void): void {
  if (readOrNull(path)?.trim() === pub) { chmodSync(path, 0o600); return; }
  writeWholeLogged(path, `${pub}\n`, 0o600, log);
}

// His tap's flag, written (core.ts drillTap calls this through main.ts armDrill, after it checked the tap is his).
// Keeper 0.1.15 item 8: a new drill from a card replaces a refused intent: it is cleared once the new flag is kept.
export function armFlag(store: DrillStore, mode: DrillMode, version: string, nowMs: number, sign: (data: Buffer) => Buffer, app = DRILL_APP): { ok: boolean; why: string } {
  if (!isDrillMode(mode)) return { ok: false, why: "that isn't a drill mode" };
  if (!VERSION.test(version)) return { ok: false, why: "that isn't a Cain version" };
  try { store.storeFlag(makeDrillFlag(mode, version, nowMs, sign, app)); }
  catch (e) { return { ok: false, why: `the drill flag couldn't be written (${String((e as Error)?.message ?? e).slice(0, 60)})` }; }
  try { store.clearRefused(); } catch { /* the flag is kept; the refusal stands until cleared */ }
  return { ok: true, why: "" };
}

// -- the registration's side (ship-pass.ts registerInstalls) ---------------------------------------------------
// The owner's page, once per key (core.ts drillPage): why the drill installed nothing. (Keeper 0.1.15) "refused": a refused drill
// intent stands, with a Clear button; "spent": a flag left claimed by a crash whose nonce was spent, refused once.
export type DrillPage = "damaged" | "version" | "accept" | "aborted" | "refused" | "spent";
export type Spent = { mode: DrillMode; nonce: string } | { mode: null } | { error: string };
export interface DrillDeps {
  spend: (version: string, app?: string) => Spent;   // the flag read, checked, claimed, its nonce recorded and the claim removed
  mark: (m: { version: string; attempt: string; mode: DrillMode }) => string;   // the signed mark written; its text (throws when it can't)
  drop: (attempt: string) => void;                // the mark removed if it names this attempt (its owner's cancel or abort)
  aborted: (attempt: string, version: string, why: string) => void;   // recorded as aborted, logged, the owner paged once
  page: (kind: DrillPage, key: string, info: { armed?: string; version?: string }) => void;
  clearRefused?: () => boolean;                   // (Keeper 0.1.15) the owner's Clear tap
}
export const markHash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
export function drillDeps(store: DrillStore, pub: () => string | null, now: () => number, log: (l: string) => void,
  o: { sign?: (data: Buffer) => Buffer; markPub?: () => string | null; page?: DrillDeps["page"] } = {}): DrillDeps {
  const page: DrillDeps["page"] = (kind, key, info) => { try { o.page?.(kind, key, info); } catch { /* logged by the caller */ } };
  // (Keeper 0.1.15) item 8: a claimed instance that can't be used is refused and its intent persisted: every install is refused, with
  // one page, until the owner clears it or arms a new drill.
  const refuseIntent = (claimId: string | null, text: string, why: string, kind: "damaged" | "version", info: { armed?: string; version?: string }): Spent => {
    const key = `${kind}:${markHash(text).slice(0, 16)}`;
    let kept = true; let keptWhy = "";
    try { store.storeRefused({ at: now(), why: why.slice(0, 200), kind, key, ...info }); } catch (e) { kept = false; keptWhy = storeWhy(e); }
    let gone = true;
    try { if (claimId) store.dropClaim(claimId); else store.removeFlag(); } catch { gone = false; }
    log(`a drill flag was refused${gone ? " and removed" : " (it couldn't be removed)"}: ${why}; nothing is installed, and ${kept ? "the refusal stands until the owner clears it or arms a new drill" : `the refusal couldn't be kept (${keptWhy}; the next install reads the flag again)`}`);
    page("refused", `refused:${key}`, info);
    return { error: `the drill flag ${why}, so nothing was installed; every install is refused until the owner clears the drill or arms a new one` };
  };
  return {
    spend: (version, app = DRILL_APP) => {
      // the later of the clock and the spent list's high-water time (item 15)
      let t: number;
      try { t = store.highWater(now()); } catch (e) { log(`the drill flags' high-water time can't be kept (${storeWhy(e)}): nothing is installed`); return { error: "the drill flags' spent list can't be written, so nothing was installed" }; }
      // a refused intent stands (item 8)
      let intent: RefusedIntent | null;
      try { intent = store.refused(); } catch (e) { log(`the refused drill intent can't be read (${storeWhy(e)}): nothing is installed`); page("refused", "refused:unreadable", {}); return { error: "the refused drill intent can't be read, so nothing was installed" }; }
      if (intent) {
        log(`a refused drill intent stands (${intent.why}): nothing is installed until the owner clears it or arms a new drill`);
        page("refused", `refused:${intent.key}`, { armed: intent.armed, version: intent.version });
        return { error: `an earlier drill flag was refused (${intent.why}), and that refusal stands until the owner clears it or arms a new drill, so nothing was installed` };
      }
      // an instance left claimed by a crash (item 11): spent, refused once; not spent yet, spent now
      let left: { id: string; text: string }[] = [];
      try { left = store.claimed(); } catch { left = []; }
      let claim: { id: string; text: string } | null = null;
      for (const l of left) {
        const r = readDrillFlag(l.text, pub(), t);
        if (r.ok && r.app !== app) continue;
        if (!r.ok) return refuseIntent(l.id, l.text, `left claimed by an interrupted registration didn't verify (${(r as { why: string }).why})`, "damaged", {});
        let was: boolean;
        try { was = store.spent(r.nonce); } catch (e) { log(`the drill flags' spent list can't be read (${storeWhy(e)}): nothing is installed`); return { error: "the drill flags' spent list can't be read, so nothing was installed" }; }
        if (was) {
          try { store.dropClaim(l.id); } catch { log("a spent drill flag left by an interrupted registration couldn't be removed: nothing is installed"); return { error: "a spent drill flag couldn't be removed, so nothing was installed" }; }
          log(`a drill flag left claimed by an interrupted registration was already spent (nonce ${r.nonce}): removed and refused once; the next install goes as usual`);
          page("spent", `spent:${r.nonce}`, { version: r.version });
          return { error: "a drill flag an interrupted registration had already spent was removed, so this install is refused once; the next one goes as usual" };
        }
        claim = l; break;
      }
      if (!claim) {
        let text: string | null;
        try { text = store.loadFlag(); } catch (e) { log(`the drill flag exists but can't be read (${storeWhy(e)}): nothing is installed`); page("damaged", "damaged:unreadable", {}); return { error: "the drill flag can't be read, so nothing was installed" }; }
        if (text === null) return { mode: null };
        const pre = readDrillFlag(text, pub(), t);
        if (pre.ok && pre.app !== app) { log(`the drill flag is for ${pre.app}, not ${app}: this registration leaves it be`); return { mode: null }; }   // item 12
        try { claim = store.claimFlag(); } catch (e) { log(`the drill flag couldn't be claimed (${storeWhy(e)}): nothing is installed`); return { error: "the drill flag couldn't be claimed, so nothing was installed" }; }
        if (!claim) { log("another registration claimed this drill flag at the same moment: this one stops"); return { error: "another registration is spending the drill flag at the same moment, so this one stops and installs nothing" }; }
      }
      // the claimed instance, exactly: judged again, whatever was read before (a replacement meanwhile is another instance)
      const r = readDrillFlag(claim.text, pub(), t);
      if (!r.ok) return refuseIntent(claim.id, claim.text, `didn't verify (${(r as { why: string }).why})`, "damaged", {});
      if (r.app !== app) {   // replaced meanwhile by another App's flag: put back as it was
        try { store.storeFlag(claim.text); store.dropClaim(claim.id); } catch { /* left claimed: the next registration reads it */ }
        return { mode: null };
      }
      if (r.version !== version) return refuseIntent(claim.id, claim.text, `was armed for Cain ${r.version}, but this install carries ${version}`, "version", { armed: r.version, version });
      let spentAlready: boolean;
      try { spentAlready = store.spent(r.nonce); } catch (e) { log(`the drill flags' spent list can't be read (${storeWhy(e)}): nothing is installed`); return { error: "the drill flags' spent list can't be read, so nothing was installed" }; }
      if (spentAlready) {
        try { store.dropClaim(claim.id); } catch { /* the next registration finds it spent again */ }
        log(`a drill flag was refused and removed: it was spent before (nonce ${r.nonce} is in the spent list: an old flag brought back); nothing is installed, once`);
        page("spent", `spent:${r.nonce}`, { version: r.version });
        return { error: "the drill flag was spent before (an old flag brought back), so this install is refused once; the next one goes as usual" };
      }
      let rec: "recorded" | "taken";
      try { rec = store.recordNonce(r.nonce, r.exp); } catch (e) { log(`the drill flag's nonce couldn't be recorded as spent (${storeWhy(e)}): nothing is installed, and the flag stays claimed for the next try`); return { error: "the drill flag's nonce couldn't be recorded as spent, so nothing was installed" }; }
      if (rec === "taken") { log("another registration recorded this drill flag's nonce at the same moment: this one stops"); return { error: "another registration is spending the drill flag at the same moment, so this one stops and installs nothing" }; }
      try { store.dropClaim(claim.id); } catch { log("the drill flag couldn't be removed after its nonce was recorded (it can't count again): nothing is installed"); return { error: "the drill flag couldn't be removed, so nothing was installed" }; }
      log(`the owner's drill flag (${r.mode}, Cain ${r.version}) is spent by this registration: its nonce is recorded and it goes as kind drill`);
      return { mode: r.mode, nonce: r.nonce };
    },
    mark: (m) => {
      if (!o.sign) throw new Error("the link has no drill key");
      const text = makeMark(m, now(), o.sign);
      store.storeMark(text);
      return text;
    },
    drop: (attempt) => {
      try {
        const r = readMark(store.loadMark(), o.markPub?.() ?? null, now());
        if (r.ok && r.mark.attempt === attempt) { store.removeMark(); log(`the drill mark of ${attempt} was removed: its attempt ended without a run`); }
      } catch { /* it lapses by itself, and the run-time helper asks Keeper before acting on it */ }
    },
    aborted: (attempt, version, why) => {
      let notKept = "";
      try { store.aborted(JSON.stringify({ at: new Date(now()).toISOString(), attempt, version, why: why.slice(0, 200) })); } catch (e) { notKept = storeWhy(e); }
      log(notKept ? `the drill attempt ${attempt} is aborted, but its record couldn't be written (${notKept}): ${why}` : `the drill attempt ${attempt} is recorded as aborted: ${why}`);
      page("aborted", `aborted:${attempt}`, { version });
    },
    page,
    clearRefused: () => { try { const was = store.clearRefused(); if (was) log("the owner cleared the refused drill intent: installs go as usual again"); return was; } catch { return false; } },
  };
}

// (Keeper 0.1.15) The run script's helper, as root, for a start of version: "exit-on-start" (or "verdict-fail") when the signed mark
// names this version and Keeper names its attempt a drill in its watch, tied to its install job (keeperNames); "" for a usual start,
// with the mark dropped when Keeper's answer definitively names no drill, or ignored when it isn't a mark of this version; "abort"
// when a valid mark's lookup kept failing for HELPER_BOUND_MS (or an earlier start of this attempt already aborted, or no token is
// set to ask with): the abort is recorded (the aborted record, page: true) and the start stops, never a usual start of the drill.
export interface HelperDeps {
  version: string; now: () => number; sleep: (ms: number) => Promise<void>;
  loadMark: () => string | null; dropMark: () => void; pub: () => string | null;
  ask: ((attempt: string) => Promise<{ status: number; body: any } | null>) | null;   // GET /attempt/<attempt>, Cain's token; null: no token set
  abortedFor: (attempt: string) => boolean;                                          // an earlier start of this attempt aborted
  aborted: (line: string) => void;                                                   // throws when it can't: the log line says why
  log: (m: string) => void;
  boundMs?: number; retryMs?: number;
}
export async function helperMode(d: HelperDeps): Promise<string> {
  let text: string | null;
  try { text = d.loadMark(); } catch { d.log("the drill mark can't be read: this start goes on as usual"); return ""; }
  if (text === null) return "";
  const pre = readMark(text, d.pub(), d.now());
  if (!pre.ok || pre.mark.version !== d.version) { d.log(`${drillModeFor(text, d.pub(), d.version, d.now(), null).why}; this start goes on as usual`); return ""; }
  const attempt = pre.mark.attempt;
  const abort = (why: string) => {
    let notKept = "";
    try { d.aborted(JSON.stringify({ at: new Date(d.now()).toISOString(), attempt, version: d.version, why: why.slice(0, 200), page: true, by: "the run script's helper" })); } catch (e) { notKept = storeWhy(e); }
    d.log(`the drill of ${attempt} is aborted${notKept ? ` (its record couldn't be written: ${notKept})` : ""}: ${why}; this start stops (never a usual start of the drill), the App's finish tells the outside heartbeat, and Keeper rolls it back once it sees it`);
    return "abort";
  };
  if (d.abortedFor(attempt)) return abort("an earlier start of this drill attempt was aborted");
  if (!d.ask) return abort("no keeper_token is set, so Keeper can't be asked whether this start is the drill");
  const until = d.now() + (d.boundMs ?? HELPER_BOUND_MS);
  for (;;) {
    const view = await d.ask(attempt).catch(() => null);
    const r = drillModeFor(text, d.pub(), d.version, d.now(), view);
    if (r.mode) return r.mode;
    if (r.drop) { try { d.dropMark(); } catch { /* it lapses */ } d.log(`${r.why}; this start goes on as usual`); return ""; }
    if (!r.retry) { d.log(`${r.why}; this start goes on as usual`); return ""; }
    if (d.now() >= until) return abort(`Keeper's lookup kept failing for ${Math.round((d.boundMs ?? HELPER_BOUND_MS) / 1000)} seconds (${r.why.replace(/^the drill mark of \S+ is kept: /, "")})`);
    d.log(`${r.why}: asking again`);
    await d.sleep(d.retryMs ?? HELPER_RETRY_MS);
  }
}

// bun drill.ts mode <version>: the run script's helper (helperMode), as root. Prints the mode, "abort", or nothing.
if (import.meta.main) {
  const [cmd, version] = process.argv.slice(2);
  if (cmd !== "mode" || !version) { console.error("usage: drill.ts mode <version>"); process.exit(2); }
  const env = process.env;
  const token = env.KEEPER_TOKEN ?? "";
  delete env.KEEPER_TOKEN;
  const markPath = env.CAIN_DRILL_MARK ?? MARK_FILE;
  const abortedPath = env.CAIN_DRILL_ABORTED ?? ABORTED_FILE;
  const { keeperCall, KEEPER_URL } = await import("../probe/keeper.ts");
  const base = (env.KEEPER_URL || KEEPER_URL).replace(/\/+$/, "");
  const out = await helperMode({
    version, now: Date.now, sleep: (ms) => Bun.sleep(ms),
    loadMark: () => readOrNull(markPath), dropMark: () => rmSync(markPath, { force: true }),
    pub: () => { try { return readOrNull(env.CAIN_DRILL_MARK_PUB ?? MARK_PUB_FILE)?.trim() || null; } catch { return null; } },
    ask: token ? (attempt) => keeperCall(base, token, `/attempt/${encodeURIComponent(attempt)}`, undefined, 8_000) : null,
    abortedFor: (attempt) => { try { return (readOrNull(abortedPath) ?? "").split("\n").some((l) => { try { const j = JSON.parse(l); return j?.attempt === attempt && j?.page === true; } catch { return false; } }); } catch { return false; } },
    aborted: (line) => { mkdirSync(dirname(abortedPath), { recursive: true }); appendFileSync(abortedPath, `${line}\n`, { mode: 0o600 }); chmodSync(abortedPath, 0o600); },   // helperMode logs why it failed
    log: (m) => console.error(`[cain] drill: ${m}`),
  });
  if (out) process.stdout.write(`${out}\n`);
}
