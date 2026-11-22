// The Ship pass (Cain 0.19.0, with Keeper 0.1.3, 0.1.4 and 0.1.5): each Ship token starts one Ship run,
// and that run starts only once every watched App it installs is accepted by the keeper App, and claimed.
//
// Cain's RemoteTrigger hook (../hooks/remote-trigger.ts) checks a Ship run's token itself, then asks the
// link here (POST /ship-pass {token}, Cain's key) before it lets the run through. The link:
//   1. checks the token again with its own public Ship key;
//   2. refuses a token it has already let through ("spent"): one Ship run per token. The ids (hashes,
//      never the token) and each one's state are kept in root's /data/trust, which Cain can't write, until
//      the token would have expired anyway;
//   3. on a token's first ask, records it as registering and registers every watched App the tap installs
//      with the keeper App (POST /attempt on its own service, with Cain's keeper_token): the token itself,
//      the pull request and head, the App, its version at the base and at the head, and the probe hash.
//      (Keeper 0.1.5) The keeper answers 202 at once and makes the App-only backup in the background; the
//      link polls GET /attempt/<id> until it is accepted or refused (5 minutes per App), so no request is
//      held open through the backup. The pass answers "pending" meanwhile, and gives up after 5 minutes per
//      watched App plus 1 (passWaitMs), cancelling every registration it made (POST /attempt/<id>/cancel);
//   4. (Keeper 0.1.5) checks every acceptance and claim answer's enrollment: the keeper's pinned key must
//      have the fingerprint committed at the pull request's head (cain/SHIP_KEY_FINGERPRINT, which must also
//      be the link's own key's), confirmed by the owner, and the keeper's state must be no newer than the
//      one the link recorded at the last confirmed enrollment (recorded when it sees the owner's confirm);
//   5. once every watched App is accepted, at the hook's next ask, claims each acceptance (POST
//      /attempt/<id>/claim: atomic and single use at the keeper, valid 30 minutes) and answers "ok" with
//      each claim id and deadline, recording the token as passed first, and writes the ok line to its log:
//      "Ship pass ok: <attempt id> claim <claim id> until <time>". A claim refused, or anything that can't
//      be read, refuses the pass for good and cancels the rest (a new Ship card makes a new token).
//   6. (Keeper 0.1.6) refuses and cancels, rather than passes, a claim with under 20 minutes left
//      (CLAIM_START_MIN_MS); the hook checks the same deadline again in code just before it lets the run
//      start, and when it refuses it asks the link (POST /ship-pass {token, cancel}) to cancel the claims;
//   7. (Keeper 0.1.6) requires the keeper's state creation and confirm times to equal the recorded ones (an
//      older or a newer state is refused; a different state counts only through a confirm newer than the
//      record), and records the enrollment from the minute-by-minute /armed read as well as from a pass.
// Why the link and not the Ship run: the Ship run is a cloud session, and the keeper's service is only
// on Home Assistant's internal App network. The Home Assistant connector can't reach it, and the link,
// on the same network, already talks to the keeper with Cain's token. So no options are written at all.
import { createHash } from "node:crypto";
import { publicKey, readToken, type Claim } from "../ship-token";
import { bumpsAt, fileAt, type MergeDeps, versionAt } from "./merge";

export const PASS_FORMAT = 2;                     // 0.1.4: entries carry their state (format 1 entries count as passed)
export const ATTEMPT_WAIT_MS = 5 * 60_000;        // (0.1.5) one App's registration polled for this long
export const passWaitMs = (apps: number) => Math.max(1, apps) * ATTEMPT_WAIT_MS + 60_000;   // (0.1.5) the whole pass
export const PASS_WAIT_MS = passWaitMs(1);        // one watched App: 6 minutes
export const POLL_MS = 5_000;                     // (0.1.5) GET /attempt/<id> every 5 seconds
export const CLAIMING_STUCK_MS = 60_000;
export const CLAIM_START_MIN_MS = 20 * 60_000;    // (Keeper 0.1.6) a claim with less left than this never starts a run          // (0.1.5) a pass left "claiming" (a restart mid-claim) is refused after this
export const FINGERPRINT_FILE = "cain/SHIP_KEY_FINGERPRINT";
const FP = /^[0-9a-f]{16}$/;
const BACKUP_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const ATTEMPT_ID = /^ship-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
const CLAIM_ID = /^claim-[0-9a-f]{16}$/;
export const PROBE_FILES: Record<string, string> = { Cain: "cain/rootfs/opt/cain/probe/keeper.ts" };
export const APP_SLUGS: Record<string, string> = { Cain: "0fcc2575_cain", Harness: "0fcc2575_harness" };
// The Apps the keeper watches, so only their installs are registered (Keeper's default watch list).
export const WATCHED = new Set(["0fcc2575_cain"]);
const CONFIGS: Record<string, string> = { Cain: "cain/config.yaml", Harness: "harness/config.yaml" };

export const passId = (token: string) => createHash("sha256").update(`ship-pass-v1\n${token.trim()}`).digest("hex").slice(0, 32);
// A public key's fingerprint, as the keeper computes it (keyFp): the first 16 hex digits of the SHA-256 of
// its DER bytes.
export const keyFingerprint = (spkiB64: string) => createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex").slice(0, 16);
// cain/SHIP_KEY_FINGERPRINT: "#" lines are comments; the first other line is the fingerprint. "" when none.
export function readFingerprintFile(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return FP.test(line.toLowerCase()) ? line.toLowerCase() : "";
}

// -- enrollment (Keeper 0.1.5) ----------------------------------------------------------------------------
// The link's record of the last confirmed enrollment it saw: the fingerprint, the keeper's state creation
// time and the owner's confirm time (ms), in root's /data/trust.
export interface Enrollment { fp: string; stateCreated: number; confirmedAt: number }
export interface EnrollmentStore { load: () => Enrollment | null; store: (e: Enrollment) => void }
export function parseEnrollment(text: string | null): Enrollment | null {
  try { const j = JSON.parse(text ?? ""); return FP.test(j?.fp) && Number(j.stateCreated) > 0 && Number(j.confirmedAt) > 0 ? { fp: j.fp, stateCreated: Number(j.stateCreated), confirmedAt: Number(j.confirmedAt) } : null; }
  catch { return null; }
}
// An answer from the keeper (an acceptance, a claim, or /armed) judged against the committed fingerprint
// and the recorded enrollment. A confirm newer than the record, for the committed fingerprint and made
// after the keeper's state was created, is the owner's confirm seen: the record moves to it (record).
export function enrollmentCheck(ans: any, committed: string, linkFp: string | null, rec: Enrollment | null): { ok: true; record?: Enrollment } | { ok: false; why: string; record?: Enrollment } {
  if (!FP.test(committed)) return { ok: false, why: `${FINGERPRINT_FILE} at the head holds no fingerprint (the Build run when the link's Ship key is made writes it)` };
  if (linkFp && committed !== linkFp) return { ok: false, why: `${FINGERPRINT_FILE} at the head (${committed}) isn't the link's own Ship key (${linkFp})` };
  const fp = typeof ans?.key_fp === "string" ? ans.key_fp : "";
  if (fp !== committed) return { ok: false, why: `the keeper pinned the Ship key ${fp || "(none)"}, not the committed ${committed}` };
  const created = Date.parse(String(ans?.state_created ?? "")), confirmed = Date.parse(String(ans?.key_confirmed_at ?? ""));
  if (!Number.isFinite(created)) return { ok: false, why: "the keeper's answer doesn't say when its state was created" };
  if (!Number.isFinite(confirmed)) return { ok: false, why: "the keeper's pinned key isn't confirmed by the owner (key-confirm at the device)" };
  let record: Enrollment | undefined;
  if (confirmed >= created && (!rec || confirmed > rec.confirmedAt || rec.fp !== committed)) record = { fp: committed, stateCreated: created, confirmedAt: confirmed };
  const r = record ?? rec;
  if (!r) return { ok: false, why: "the link has recorded no confirmed enrollment of the keeper" };
  // (Keeper 0.1.6) the very state and confirm the link recorded: an older state is refused too
  if (created > r.stateCreated) return { ok: false, why: `the keeper's state was created ${new Date(created).toISOString()}, after the enrollment the link recorded (${new Date(r.stateCreated).toISOString()}): the owner confirms the key at the device again`, ...(record ? { record } : {}) };
  if (created < r.stateCreated) return { ok: false, why: `the keeper's state was created ${new Date(created).toISOString()}, before the enrollment the link recorded (${new Date(r.stateCreated).toISOString()}): an older keeper state is refused; the owner confirms the key at the device again` };
  if (confirmed !== r.confirmedAt) return { ok: false, why: `the keeper's key was confirmed ${new Date(confirmed).toISOString()}, not at the confirm the link recorded (${new Date(r.confirmedAt).toISOString()}): the owner confirms the key at the device again` };
  return record ? { ok: true, record } : { ok: true };
}
// (Keeper 0.1.6) The enrollment seen in the keeper's minute-by-minute /armed answer, judged against the
// link's own key's fingerprint: a confirm newer than the record is recorded there too, outside any pass.
export function noteArmedEnrollment(ans: any, linkFp: string | null, e: EnrollmentStore | undefined, log: (l: string) => void): void {
  if (!linkFp || !e) return;
  const en = enrollmentCheck(ans, linkFp, linkFp, e.load());
  if (en.record) noteRecord(e, en.record, log);
}
const noteRecord = (e: EnrollmentStore | undefined, r: Enrollment | undefined, log: (l: string) => void) => {
  if (!e || !r) return;
  try { e.store(r); log(`the owner's confirm of the keeper's Ship key ${r.fp} seen: enrollment recorded (keeper state created ${new Date(r.stateCreated).toISOString()})`); } catch { log("couldn't record the keeper's enrollment"); }
};

export interface Accepted { app: string; attempt: string; backup: string; from?: string; to?: string }
export interface Claimed { attempt: string; claim: string; until: string }
export type RegResult = { ok: true; accepted: Accepted[]; said: string[]; fp?: string } | { ok: false; said: string[] };
type Entry = { id: string; exp: number; state: "registering" | "accepted" | "claiming" | "refused" | "passed"; at: number; said?: string; accepted?: Accepted[];
  apps?: number; attempts?: string[]; fp?: string; claims?: Claimed[]; claimingAt?: number };
export interface PassDeps {
  pub: () => string | null;                      // the link's public Ship key (base64 SPKI), as /data/trust/ship.pub holds it
  now: () => number;
  load: () => string | null;                     // the pass file's text (null: none yet)
  store: (text: string) => void;                 // writes it whole; throws on failure
  // the keeper registration, in the background; note(upd) keeps how many Apps and which attempts it made
  register: (token: string, claim: Claim, done: (r: RegResult) => void, note: (upd: { apps?: number; attempt?: string }) => void) => void;
  claim?: (a: Accepted) => Promise<{ status: number; body: any } | null>;   // (0.1.5) POST /attempt/<id>/claim
  cancel?: (attempt: string, why: string) => void;                         // (0.1.5) POST /attempt/<id>/cancel, fire and forget
  enrollment?: EnrollmentStore;                                             // (0.1.5) the recorded enrollment
  log: (line: string) => void;
}
export type PassAnswer = { status: "ok"; pr: number; head: string; accepted: Accepted[]; claims: Claimed[] } | { status: "pending" | "spent" | "refused"; said: string };
export const PENDING_SAID = "the keeper is taking the backup before this install; nothing has run and the tap still counts: start the same Ship run again in a minute";

function readEntries(text: string | null): Entry[] | null {
  if (text === null) return [];
  try {
    const j = JSON.parse(text);
    if ((j?.format !== 1 && j?.format !== PASS_FORMAT) || !Array.isArray(j.spent)) return null;
    return j.spent.filter((x: any) => x && typeof x.id === "string" && Number.isFinite(x.exp))
      .map((x: any) => j.format === 1 ? { id: x.id, exp: x.exp, state: "passed", at: 0 } : { ...x, state: ["registering", "accepted", "claiming", "refused", "passed"].includes(x.state) ? x.state : "refused", at: Number(x.at) || 0 });
  } catch { return null; }
}
const writeEntries = (d: PassDeps, spent: Entry[]) => d.store(JSON.stringify({ format: PASS_FORMAT, spent }));
const cancelAll = (d: PassDeps, ids: string[], why: string) => { for (const a of new Set(ids)) { d.log(`cancelling the keeper's registration ${a}: ${why}`); d.cancel?.(a, why); } };

// (0.1.5) What the registration made so far, kept on its entry: the number of watched Apps (the pass's
// wait scales with it) and each attempt id (cancelled if the pass gives up).
export function noteEntry(d: PassDeps, id: string, upd: { apps?: number; attempt?: string }): void {
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === id);
  if (!spent || !e) return;
  if (e.state !== "registering") { if (upd.attempt) cancelAll(d, [upd.attempt], "its pass had already ended"); return; }
  if (upd.apps !== undefined) e.apps = upd.apps;
  if (upd.attempt) e.attempts = [...(e.attempts ?? []), upd.attempt];
  try { writeEntries(d, spent); } catch { d.log("couldn't keep a keeper registration's progress"); }
}

// A registration's outcome, kept on its entry (only while it is still registering). One that ends after
// its pass gave up is cancelled at the keeper, so no acceptance is left lying around.
export function settle(d: PassDeps, id: string, r: RegResult): void {
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === id);
  if (!spent || !e || e.state !== "registering") {
    d.log("a keeper registration ended after its pass had moved on: not kept");
    if (r.ok) cancelAll(d, r.accepted.map((a) => a.attempt), "its pass had already ended");
    return;
  }
  if (r.ok) { e.state = "accepted"; e.accepted = r.accepted; if (r.fp) e.fp = r.fp; }
  else { e.state = "refused"; e.said = `the keeper didn't accept every install: ${r.said.join("; ").slice(0, 400) || "no reason"}`; }
  try { writeEntries(d, spent); } catch { d.log("couldn't keep a keeper registration's outcome: the pass times out and is refused"); return; }
  d.log(r.ok ? `the keeper accepted every watched install for a Ship token (${r.accepted.map((a) => `${a.attempt} backup ${a.backup}`).join(", ") || "none watched"})` : `a Ship token's pass is refused: ${e.said}`);
  if (!r.ok) cancelAll(d, e.attempts ?? [], "the pass is refused");
}

// (Keeper 0.1.6) The hook refused a run the link had passed (its claim's deadline too near when it checked):
// POST /ship-pass {token, cancel: <why>}. The pass is refused for good and each claim cancelled at the keeper,
// so no claim is left live; a new Ship card for the same pull request and head starts again.
export function cancelPass(d: PassDeps, token: string, why: string): PassAnswer {
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === passId(token));
  if (!spent || !e) return { status: "refused", said: "no pass for that Ship token" };
  const ids = [...(e.claims ?? []).map((k) => k.attempt), ...(e.accepted ?? []).map((a) => a.attempt), ...(e.attempts ?? [])];
  const said = `the hook refused the Ship run: ${String(why).replace(/[^\x20-\x7e]/g, " ").slice(0, 200)}`;
  e.state = "refused"; e.said = said;
  try { writeEntries(d, spent); } catch { d.log("couldn't record a cancelled pass: its claims are cancelled anyway"); }
  d.log(`a Ship token's pass is cancelled: ${said}`);
  cancelAll(d, ids, "the hook refused the Ship run");
  return { status: "refused", said: `${said}. Nothing was installed; start again with a new Ship card for the same pull request and head` };
}

export async function shipPass(d: PassDeps, body: any, depth = 0): Promise<PassAnswer> {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "refused", said: "no Ship token" };
  if (typeof body?.cancel === "string" && body.cancel) return cancelPass(d, token, body.cancel);
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  let spent = readEntries(d.load());
  if (!spent) return { status: "refused", said: "the link's record of spent Ship tokens can't be read, so no Ship run starts: log a Build item" };
  const id = passId(token);
  const now = d.now();
  const e = spent.find((x) => x.id === id);
  const where = `pull request ${c.claim.pr} at ${c.claim.head.slice(0, 12)}`;
  const again = "Nothing was installed; a new Ship card for the same pull request and head tries again";
  if (!e) {
    spent = spent.filter((x) => x.exp * 1000 > now - 86_400_000);
    spent.push({ id, exp: c.claim.exp, state: "registering", at: now });
    try { writeEntries(d, spent); }
    catch { return { status: "refused", said: "the link couldn't record the Ship token, so no Ship run starts: try again in a minute" }; }
    d.log(`registering the installs of ${where} with the keeper; the Ship run waits for its acceptance`);
    d.register(token, c.claim, (r) => settle(d, id, r), (upd) => noteEntry(d, id, upd));
    return depth ? { status: "pending", said: PENDING_SAID } : shipPass(d, body, 1);
  }
  const refuseFor = (said: string, cancel: string[]): PassAnswer => {
    const all = readEntries(d.load()) ?? spent!;
    const cur = all.find((x) => x.id === id);
    if (cur) { cur.state = "refused"; cur.said = said; try { writeEntries(d, all); } catch { /* refused either way */ } }
    d.log(`a Ship token's pass is refused: ${said}`);
    cancelAll(d, cancel, "the pass is refused");
    return { status: "refused", said: `${said}. ${again}` };
  };
  if (e.state === "passed") {
    d.log(`refused a second Ship run on the token for ${where}`);
    return { status: "spent", said: "that Ship token already started a Ship run; one tap starts one run. If the install still has to happen, show a new Ship card for the same pull request and head" };
  }
  if (e.state === "refused") return { status: "refused", said: `${e.said ?? "the keeper didn't accept the install"}. ${again}` };
  if (e.state === "registering") {
    const wait = passWaitMs(e.apps ?? 1);
    if (now - e.at <= wait) return { status: "pending", said: PENDING_SAID };
    return refuseFor(`the keeper didn't accept every install within ${wait / 60_000} minutes`, e.attempts ?? []);
  }
  if (e.state === "claiming") {
    if (now - (e.claimingAt ?? 0) <= CLAIMING_STUCK_MS) return { status: "pending", said: "the link is claiming the keeper's acceptance: start the same Ship run again in a minute" };
    return refuseFor("the link stopped while it claimed the keeper's acceptance", (e.accepted ?? []).map((a) => a.attempt));
  }
  // accepted: claim each acceptance at the keeper, then pass. "claiming" is written first, so two asks at
  // once claim once, and a restart mid-claim refuses rather than claiming twice.
  const accepted = e.accepted ?? [];
  e.state = "claiming"; e.claimingAt = now;
  try { writeEntries(d, spent); }
  catch { return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  const claims: Claimed[] = [];
  for (const a of accepted) {
    const r = d.claim ? await d.claim(a).catch(() => null) : null;
    const j = r?.body ?? {};
    const okAns = r && r.status === 200 && j.status === "claimed" && j.id === a.attempt && j.app === a.app && j.backup === a.backup
      && (a.from === undefined || j.from_version === a.from) && (a.to === undefined || j.to_version === a.to)
      && typeof j.claim === "string" && CLAIM_ID.test(j.claim) && Number.isFinite(Date.parse(String(j.until)));
    const en = okAns ? enrollmentCheck(j, e.fp ?? "", keyFingerprint(pub), d.enrollment?.load() ?? null) : null;
    if (en?.record) noteRecord(d.enrollment, en.record, d.log);
    if (!okAns || !en || !en.ok) {
      return refuseFor(!r ? `the keeper didn't answer the claim of ${a.attempt}` : !okAns ? `the keeper refused the claim of ${a.attempt}: ${String(j?.why ?? r.status).slice(0, 160)}`
        : `the keeper's claim of ${a.attempt} failed the enrollment check: ${(en as any).why}`, accepted.map((x) => x.attempt));
    }
    const left = Date.parse(String(j.until)) - d.now();
    if (left < CLAIM_START_MIN_MS) return refuseFor(`the keeper's claim of ${a.attempt} has ${Math.max(0, Math.floor(left / 60_000))} minutes left, under the ${CLAIM_START_MIN_MS / 60_000} a Ship run needs to start`, accepted.map((x) => x.attempt));
    claims.push({ attempt: a.attempt, claim: j.claim, until: new Date(Date.parse(String(j.until))).toISOString() });
  }
  spent = readEntries(d.load()) ?? spent;
  const cur = spent.find((x) => x.id === id);
  if (!cur || cur.state !== "claiming") { cancelAll(d, accepted.map((a) => a.attempt), "the pass changed while it claimed"); return { status: "refused", said: `the pass changed while the link claimed. ${again}` }; }
  cur.state = "passed"; cur.claims = claims;
  try { writeEntries(d, spent); }
  catch { cancelAll(d, accepted.map((a) => a.attempt), "the pass couldn't be recorded"); return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  for (const k of claims) d.log(`Ship pass ok: ${k.attempt} claim ${k.claim} until ${k.until}`);
  d.log(`let a Ship run through for ${where} (every watched install accepted and claimed); its token is spent`);
  return { status: "ok", pr: c.claim.pr, head: c.claim.head, accepted, claims };
}

export interface RegisterDeps {
  api: MergeDeps["api"];
  post: (body: unknown) => Promise<{ status: number; body: any } | null>;   // POST /attempt on the keeper, Cain's token
  get?: (path: string) => Promise<{ status: number; body: any } | null>;    // (0.1.5) GET /attempt/<id>
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  note?: (upd: { apps?: number; attempt?: string }) => void;
  linkFp?: string | null;                                                 // the link's own Ship key's fingerprint
  enrollment?: EnrollmentStore;
  pollMs?: number; waitMs?: number;
  log: (line: string) => void;
}
// The registration of each watched App the tap installs (0.1.5: register, then poll): ok only when every one
// is accepted (the keeper's answer "accepted" for that App and versions, with its attempt id and backup
// slug) and passes the enrollment check against the fingerprint committed at the head. A base, a list of
// bumps, a version, a probe or the fingerprint file that can't be read, a keeper that refuses, or no
// acceptance within ATTEMPT_WAIT_MS of polling: not ok, so the pass is refused.
export async function registerInstalls(d: RegisterDeps, token: string, c: Claim): Promise<RegResult> {
  const said: string[] = [];
  const accepted: Accepted[] = [];
  let ok = true;
  const say = (l: string, bad = true) => { said.push(l); if (bad) ok = false; d.log(`keeper registration: ${l}`); };
  const now = d.now ?? Date.now, sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pull = await d.api(`/repos/${c.repo}/pulls/${c.pr}`).catch(() => null);
  const base = pull?.status === 200 ? String(pull.body?.base?.sha ?? "") : "";
  if (!/^[0-9a-f]{40}$/.test(base)) { say(`pull request ${c.pr}'s base couldn't be read, so nothing was registered`); return { ok: false, said }; }
  const bumps = await bumpsAt(d, c.repo, base, c.head);
  if (!bumps) { say("what the tap installs couldn't be read, so nothing was registered"); return { ok: false, said }; }
  const watched = bumps.filter((b) => APP_SLUGS[b.app] && WATCHED.has(APP_SLUGS[b.app]));
  d.note?.({ apps: watched.length });
  if (!watched.length) return { ok: true, accepted, said };
  const fpFile = await fileAt(d, c.repo, FINGERPRINT_FILE, c.head);
  const committed = fpFile && fpFile !== "missing" ? readFingerprintFile(fpFile.toString("utf8")) : "";
  if (!committed) { say(`${FINGERPRINT_FILE} at the head ${fpFile === null ? "couldn't be read" : "holds no fingerprint"} (the Build run when the link's Ship key is made writes it), so nothing was registered`); return { ok: false, said }; }
  if (d.linkFp && committed !== d.linkFp) { say(`${FINGERPRINT_FILE} at the head (${committed}) isn't the link's own Ship key (${d.linkFp}), so nothing was registered`); return { ok: false, said }; }
  for (const b of watched) {
    const slug = APP_SLUGS[b.app];
    const from = await versionAt(d, c.repo, CONFIGS[b.app], base);
    const probe = await fileAt(d, c.repo, PROBE_FILES[b.app] ?? CONFIGS[b.app], c.head);
    if (!from || from === "none" || !probe || probe === "missing") { say(`${b.app}'s version at the base or its probe at the head couldn't be read: not registered`); continue; }
    const r = await d.post({ token, app: slug, pr: c.pr, head: c.head, from_version: from, to_version: b.version, kind: "ship",
      probe_hash: createHash("sha256").update(probe).digest("hex").slice(0, 16) }).catch(() => null);
    let j = r?.body ?? {};
    if (!r || r.status !== 202 || j.status !== "pending" || typeof j.id !== "string" || !ATTEMPT_ID.test(j.id)) {
      say(!r ? `the keeper didn't answer for ${b.app} ${b.version}` : r.status === 202 || r.status === 200 ? `the keeper's answer for ${b.app} ${b.version} isn't a registration of it`
        : `the keeper refused ${b.app} ${b.version}: ${String(j?.why ?? r.status).slice(0, 160)}`);
      continue;
    }
    const attempt = j.id;
    d.note?.({ attempt });
    const until = now() + (d.waitMs ?? ATTEMPT_WAIT_MS);
    let last: { status: number; body: any } | null = null;
    for (;;) {
      await sleep(d.pollMs ?? POLL_MS);
      last = d.get ? await d.get(`/attempt/${attempt}`).catch(() => null) : null;
      j = last?.body ?? {};
      if (last?.status === 200 && j.status !== "pending") break;
      if (now() >= until) break;
    }
    if (last?.status === 200 && j.status === "accepted" && j.id === attempt && j.app === slug && j.from_version === from && j.to_version === b.version
        && typeof j.backup === "string" && BACKUP_SLUG.test(j.backup)) {
      const en = enrollmentCheck(j, committed, d.linkFp ?? null, d.enrollment?.load() ?? null);
      if (en.record) noteRecord(d.enrollment, en.record, d.log);
      if (!en.ok) { say(`the keeper accepted ${b.app} ${b.version} as ${attempt}, but its enrollment is refused: ${en.why}`); continue; }
      accepted.push({ app: slug, attempt, backup: j.backup, from, to: b.version });
      say(`${b.app} ${from} to ${b.version} accepted as ${attempt}, backup ${j.backup}`, false);
    } else say(last?.status === 200 && j.status === "pending" ? `the keeper didn't accept ${b.app} ${b.version} within ${(d.waitMs ?? ATTEMPT_WAIT_MS) / 60_000} minutes`
      : last?.status === 200 ? `the keeper refused ${b.app} ${b.version}: ${String(j?.why || j?.status).slice(0, 160)}`
      : `the keeper didn't answer for ${b.app} ${b.version} (${attempt})`);
  }
  return ok ? { ok: true, accepted, said, fp: committed } : { ok: false, said };
}
