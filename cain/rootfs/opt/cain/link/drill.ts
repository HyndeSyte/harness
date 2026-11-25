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
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, appendFileSync } from "node:fs";
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
// The open attempt's statuses that are "still in its watch" (Keeper core.ts OPEN, less verifying and restoring).
export const WATCH_STATUSES = ["accepted", "claimed", "watching"];
const B64URL = /^[A-Za-z0-9_-]+$/;
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const ATTEMPT = /^drill-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
const NONCE = /^[0-9a-f]{16}$/;
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// -- the flag: his tap, signed with the Ship key ----------------------------------------------------------------
export function makeDrillFlag(mode: DrillMode, version: string, nowMs: number, sign: (data: Buffer) => Buffer): string {
  if (!isDrillMode(mode)) throw new Error("not a drill mode");
  if (!VERSION.test(version)) throw new Error("not a version");
  const at = Math.floor(nowMs / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ v: 2, kind: DRILL_KIND, mode, to_version: version, at, exp: at + DRILL_TTL_S, nonce: randomBytes(8).toString("hex") })));
  return `${DRILL_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${DRILL_PREFIX}.${payload}`, "utf8")))}`;
}
export type FlagRead = { ok: true; mode: DrillMode; version: string; nonce: string; at: number; exp: number } | { ok: false; why: string };
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
  if (!c || c.v !== 2 || c.kind !== DRILL_KIND || !isDrillMode(c.mode) || !VERSION.test(String(c.to_version)) || !NONCE.test(String(c.nonce))
    || !Number.isSafeInteger(c.at) || !Number.isSafeInteger(c.exp)) return { ok: false, why: "its payload isn't a drill flag of this version" };
  const now = nowMs / 1000;
  if (c.exp <= now) return { ok: false, why: "it ran out (a drill flag is good for a day after the tap)" };
  if (c.exp - c.at > DRILL_TTL_S || c.at > now + SKEW_S) return { ok: false, why: "its times aren't a drill flag's" };
  return { ok: true, mode: c.mode, version: c.to_version, nonce: c.nonce, at: c.at * 1000, exp: c.exp * 1000 };
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
// Keeper's answer to GET /attempt (the caller's open attempt), judged for a mark: that very attempt, a drill of that mode and
// version, its mark confirmed to Keeper, still in its watch. "" when it holds, else why not.
export function keeperNames(mark: DrillMark, version: string, open: { status: number; body: any } | null): string {
  if (!open) return "Keeper didn't answer";
  if (open.status !== 200) return `Keeper answered ${open.status}`;
  const b = open.body ?? {};
  if (b.attempt !== mark.attempt) return b.attempt ? `Keeper's open attempt is ${String(b.attempt).slice(0, 80)}, not the mark's` : "Keeper has no open attempt";
  if (b.kind !== "drill") return "Keeper registered that attempt as no drill";
  if (b.drill_mode !== mark.mode) return "Keeper's drill mode for it isn't the mark's";
  if (b.to_version !== version || mark.version !== version) return "Keeper's version for it isn't this start's";
  if (b.marked !== true) return "Keeper has no confirmation of the mark";
  if (!WATCH_STATUSES.includes(b.status)) return `the attempt is ${String(b.status).slice(0, 30)}, not in its watch`;
  return "";
}
// What this start of version must do: the signed mark's mode when it names this version and Keeper names its attempt as a drill
// still in its watch; else null with why (the run-time helper and the verdict probe).
export function drillModeFor(text: string | null, pubB64: string | null, version: string, nowMs: number, open: { status: number; body: any } | null):
    { mode: DrillMode | null; why: string; mark?: DrillMark; drop: boolean } {
  if (text === null) return { mode: null, why: "no mark", drop: false };
  const r = readMark(text, pubB64, nowMs);
  if (!r.ok) return { mode: null, why: `a drill mark was ignored: ${(r as { why: string }).why}`, drop: false };
  if (r.mark.version !== version) return { mode: null, why: `the drill mark names Cain ${r.mark.version}, not this start's ${version}`, mark: r.mark, drop: false };
  const no = keeperNames(r.mark, version, open);
  if (no) return { mode: null, why: `the drill mark of ${r.mark.attempt} was dropped: ${no}`, mark: r.mark, drop: true };
  return { mode: r.mark.mode, why: "", mark: r.mark, drop: false };
}

// -- the files, root's -------------------------------------------------------------------------------------------
export interface DrillStore {
  loadFlag: () => string | null;                  // null: no flag file; throws when it exists but can't be read
  removeFlag: () => void;                         // throws when it can't
  storeFlag: (text: string) => void;
  loadMark: () => string | null;
  storeMark: (text: string) => void;
  removeMark: () => void;
  spent: (nonce: string) => boolean;              // the nonce is in the spent list (throws when the list can't be read)
  recordNonce: (nonce: string, expMs: number) => "recorded" | "taken";   // exclusive: one caller records it; throws on failure
  aborted: (line: string) => void;                // an aborted drill attempt, recorded (best effort)
}
// Written whole, durably, root's only (0600 whatever the file or its temp was before).
function writeWhole(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
const readOrNull = (p: string) => { try { return readFileSync(p, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; } };
export function fileStore(flag = FLAG_FILE, mark = MARK_FILE, spentDir = SPENT_DIR, abortedFile = ABORTED_FILE, nowFn: () => number = Date.now): DrillStore {
  const nonceFile = (n: string) => { if (!NONCE.test(n)) throw new Error("not a nonce"); return join(spentDir, n); };
  const prune = () => {
    try {
      for (const n of readdirSync(spentDir)) {
        const f = join(spentDir, n);
        try { const exp = Number(readFileSync(f, "utf8").trim()); if (Number.isFinite(exp) && exp + 86_400_000 < nowFn()) rmSync(f, { force: true }); } catch { /* kept */ }
      }
    } catch { /* none yet */ }
  };
  return {
    loadFlag: () => readOrNull(flag), removeFlag: () => rmSync(flag, { force: true }), storeFlag: (t) => writeWhole(flag, t),
    loadMark: () => readOrNull(mark), storeMark: (t) => writeWhole(mark, t), removeMark: () => rmSync(mark, { force: true }),
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
    aborted: (line) => { try { mkdirSync(dirname(abortedFile), { recursive: true }); appendFileSync(abortedFile, `${line}\n`, { mode: 0o600 }); chmodSync(abortedFile, 0o600); } catch { /* the log has it */ } },
  };
}
// The drill key's public half, kept by root beside the mark (main.ts, at each start of the link).
export function storeMarkPub(pub: string, path = MARK_PUB_FILE): void {
  if (readOrNull(path)?.trim() === pub) { chmodSync(path, 0o600); return; }
  writeWhole(path, `${pub}\n`);
}

// His tap's flag, written (core.ts drillTap calls this through main.ts armDrill, after it checked the tap is his).
export function armFlag(store: DrillStore, mode: DrillMode, version: string, nowMs: number, sign: (data: Buffer) => Buffer): { ok: boolean; why: string } {
  if (!isDrillMode(mode)) return { ok: false, why: "that isn't a drill mode" };
  if (!VERSION.test(version)) return { ok: false, why: "that isn't a Cain version" };
  try { store.storeFlag(makeDrillFlag(mode, version, nowMs, sign)); return { ok: true, why: "" }; }
  catch (e) { return { ok: false, why: `the drill flag couldn't be written (${String((e as Error)?.message ?? e).slice(0, 60)})` }; }
}

// -- the registration's side (ship-pass.ts registerInstalls) ---------------------------------------------------
// The owner's page, once per key (core.ts drillPage): why the drill installed nothing.
export type DrillPage = "damaged" | "version" | "accept" | "aborted";
export type Spent = { mode: DrillMode; nonce: string } | { mode: null } | { error: string };
export interface DrillDeps {
  spend: (version: string) => Spent;              // the flag read, checked, its nonce recorded and the flag removed
  mark: (m: { version: string; attempt: string; mode: DrillMode }) => string;   // the signed mark written; its text (throws when it can't)
  drop: (attempt: string) => void;                // the mark removed if it names this attempt (its owner's cancel or abort)
  aborted: (attempt: string, version: string, why: string) => void;   // recorded as aborted, logged, the owner paged once
  page: (kind: DrillPage, key: string, info: { armed?: string; version?: string }) => void;
}
export const markHash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
export function drillDeps(store: DrillStore, pub: () => string | null, now: () => number, log: (l: string) => void,
  o: { sign?: (data: Buffer) => Buffer; markPub?: () => string | null; page?: DrillDeps["page"] } = {}): DrillDeps {
  const page: DrillDeps["page"] = (kind, key, info) => { try { o.page?.(kind, key, info); } catch { /* logged by the caller */ } };
  // A flag file that exists but can't be used: removed (best effort), the install refused, logged, the owner paged once.
  const refuse = (text: string, why: string, kind: DrillPage, info: { armed?: string; version?: string }): Spent => {
    let gone = true;
    try { store.removeFlag(); } catch { gone = false; }
    log(`a drill flag was refused${gone ? " and removed" : " (it couldn't be removed)"}: ${why}; nothing is installed (arm it again)`);
    page(kind, `${kind}:${markHash(text).slice(0, 16)}`, info);
    return { error: `the drill flag ${why}, so nothing was installed (the owner is told to arm it again)` };
  };
  return {
    spend: (version) => {
      let text: string | null;
      try { text = store.loadFlag(); } catch { log("the drill flag exists but can't be read: nothing is installed"); page("damaged", "damaged:unreadable", {}); return { error: "the drill flag can't be read, so nothing was installed" }; }
      if (text === null) return { mode: null };
      const r = readDrillFlag(text, pub(), now());
      if (!r.ok) return refuse(text, `didn't verify (${(r as { why: string }).why})`, "damaged", {});
      if (r.version !== version) return refuse(text, `was armed for Cain ${r.version}, but this install carries ${version}`, "version", { armed: r.version, version });
      let spentAlready: boolean;
      try { spentAlready = store.spent(r.nonce); } catch { log("the drill flags' spent list can't be read: nothing is installed"); return { error: "the drill flags' spent list can't be read, so nothing was installed" }; }
      if (spentAlready) return refuse(text, "was spent before (its nonce is in the spent list: an old flag brought back)", "damaged", {});
      let rec: "recorded" | "taken";
      try { rec = store.recordNonce(r.nonce, r.exp); } catch { log("the drill flag's nonce couldn't be recorded as spent: nothing is installed, and the flag stays for the next try"); return { error: "the drill flag's nonce couldn't be recorded as spent, so nothing was installed" }; }
      if (rec === "taken") { log("another registration recorded this drill flag's nonce at the same moment: this one stops"); return { error: "another registration is spending the drill flag at the same moment, so this one stops and installs nothing" }; }
      try { store.removeFlag(); } catch { log("the drill flag couldn't be removed after its nonce was recorded (it can't count again): nothing is installed"); return { error: "the drill flag couldn't be removed, so nothing was installed" }; }
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
      store.aborted(JSON.stringify({ at: new Date(now()).toISOString(), attempt, version, why: why.slice(0, 200) }));
      log(`the drill attempt ${attempt} is recorded as aborted: ${why}`);
      page("aborted", `aborted:${attempt}`, { version });
    },
    page,
  };
}

// bun drill.ts mode <version>: the run script's helper, as root. Prints the mode a start of that version must show, or
// nothing. A mark it acts on must be signed and named by Keeper (GET /attempt, Cain's token from KEEPER_TOKEN) as a drill
// still in its watch; otherwise the mark is dropped (or, unsigned, ignored) and the start goes on as usual, with a log line.
if (import.meta.main) {
  const [cmd, version] = process.argv.slice(2);
  if (cmd !== "mode" || !version) { console.error("usage: drill.ts mode <version>"); process.exit(2); }
  const env = process.env;
  const token = env.KEEPER_TOKEN ?? "";
  delete env.KEEPER_TOKEN;
  const markPath = env.CAIN_DRILL_MARK ?? MARK_FILE;
  let text: string | null = null;
  try { text = readOrNull(markPath); } catch { text = null; console.error("[cain] drill: the drill mark can't be read: this start goes on as usual"); }
  if (text !== null) {
    let pub: string | null = null;
    try { pub = readOrNull(env.CAIN_DRILL_MARK_PUB ?? MARK_PUB_FILE)?.trim() || null; } catch { pub = null; }
    const pre = readMark(text, pub, Date.now());
    let open: { status: number; body: any } | null = null;
    if (pre.ok && pre.mark.version === version && token) {
      const { keeperCall, KEEPER_URL } = await import("../probe/keeper.ts");
      open = await keeperCall((env.KEEPER_URL || KEEPER_URL).replace(/\/+$/, ""), token, "/attempt", undefined, 8_000);
    }
    const r = drillModeFor(text, pub, version, Date.now(), open);
    if (r.mode) process.stdout.write(`${r.mode}\n`);
    else {
      if (r.drop) { try { rmSync(markPath, { force: true }); } catch { /* it lapses */ } }
      console.error(`[cain] drill: ${!token && r.drop ? `${r.why} (no keeper_token set)` : r.why}; this start goes on as usual`);
    }
  }
}
