// The Ship pass (Cain 0.19.0, with Keeper 0.1.3 and 0.1.4): each Ship token starts one Ship run, and
// that run starts only once every watched App it installs is accepted by the keeper App.
//
// Cain's RemoteTrigger hook (../hooks/remote-trigger.ts) checks a Ship run's token itself, then asks the
// link here (POST /ship-pass {token}, Cain's key) before it lets the run through. The link:
//   1. checks the token again with its own public Ship key;
//   2. refuses a token it has already let through ("spent"): one Ship run per token. The ids (hashes,
//      never the token) and each one's state are kept in root's /data/trust, which Cain can't write, until
//      the token would have expired anyway;
//   3. (0.1.4) on a token's first ask, records it as registering and registers every watched App the tap
//      installs with the keeper App (POST /attempt on its own service, with Cain's keeper_token): the
//      token itself, the pull request and head it was signed for, the App, its version at the pull
//      request's base and at the head (each App's config.yaml at those commits, as the Ship card reads
//      them), and the probe hash at the head. The keeper verifies the token's signature with its pinned
//      key, spends it once per App, makes the App-only backup itself, and answers only once that backup
//      is complete and verified, with its slug ("accepted"), and logs "accepting <id> ...". The pass
//      answers "pending" meanwhile, so the hook refuses the run and Cain asks again;
//   4. answers "ok" only once every watched App the tap installs is accepted (none watched: at once),
//      recording the token as passed before it answers, so a crash between the two refuses the run
//      rather than letting a second one through. A keeper refusal, a missing answer, anything that can't
//      be read, or no acceptance within PASS_WAIT_MS refuses the pass for good (a new Ship card makes a
//      new token).
// Why the link and not the Ship run: the Ship run is a cloud session, and the keeper's service is only
// on Home Assistant's internal App network. The Home Assistant connector can't reach it (it speaks to
// Home Assistant, not to an App's port), and the link, on the same network, already talks to the keeper
// with Cain's token. So no options are written at all.
import { createHash } from "node:crypto";
import { publicKey, readToken, type Claim } from "../ship-token";
import { bumpsAt, fileAt, type MergeDeps, versionAt } from "./merge";

export const PASS_FORMAT = 2;                     // 0.1.4: entries carry their state (format 1 entries count as passed)
export const PASS_WAIT_MS = 6 * 60_000;           // (0.1.4) every watched App accepted within this, or the pass is refused
export const ATTEMPT_WAIT_MS = 5 * 60_000;        // (0.1.4) one POST /attempt's wait (the keeper answers within 4 minutes)
const BACKUP_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const ATTEMPT_ID = /^ship-\d{1,9}-[a-z0-9_]{1,64}-[0-9a-f]{8}$/;
export const PROBE_FILES: Record<string, string> = { Cain: "cain/rootfs/opt/cain/probe/keeper.ts" };
export const APP_SLUGS: Record<string, string> = { Cain: "0fcc2575_cain", Harness: "0fcc2575_harness" };
// The Apps the keeper watches, so only their installs are registered (Keeper's default watch list).
export const WATCHED = new Set(["0fcc2575_cain"]);
const CONFIGS: Record<string, string> = { Cain: "cain/config.yaml", Harness: "harness/config.yaml" };

export const passId = (token: string) => createHash("sha256").update(`ship-pass-v1\n${token.trim()}`).digest("hex").slice(0, 32);

export interface Accepted { app: string; attempt: string; backup: string }
export type RegResult = { ok: true; accepted: Accepted[]; said: string[] } | { ok: false; said: string[] };
type Entry = { id: string; exp: number; state: "registering" | "accepted" | "refused" | "passed"; at: number; said?: string; accepted?: Accepted[] };
export interface PassDeps {
  pub: () => string | null;                      // the link's public Ship key (base64 SPKI), as /data/trust/ship.pub holds it
  now: () => number;
  load: () => string | null;                     // the pass file's text (null: none yet)
  store: (text: string) => void;                 // writes it whole; throws on failure
  register: (token: string, claim: Claim, done: (r: RegResult) => void) => void;   // the keeper registration, in the background
  log: (line: string) => void;
}
export type PassAnswer = { status: "ok"; pr: number; head: string; accepted: Accepted[] } | { status: "pending" | "spent" | "refused"; said: string };
export const PENDING_SAID = "the keeper is taking the backup before this install; nothing has run and the tap still counts: start the same Ship run again in a minute";

function readEntries(text: string | null): Entry[] | null {
  if (text === null) return [];
  try {
    const j = JSON.parse(text);
    if ((j?.format !== 1 && j?.format !== PASS_FORMAT) || !Array.isArray(j.spent)) return null;
    return j.spent.filter((x: any) => x && typeof x.id === "string" && Number.isFinite(x.exp))
      .map((x: any) => j.format === 1 ? { id: x.id, exp: x.exp, state: "passed", at: 0 } : { ...x, state: ["registering", "accepted", "refused", "passed"].includes(x.state) ? x.state : "refused", at: Number(x.at) || 0 });
  } catch { return null; }
}
const writeEntries = (d: PassDeps, spent: Entry[]) => d.store(JSON.stringify({ format: PASS_FORMAT, spent }));

// (0.1.4) A registration's outcome, kept on its entry (only while it is still registering).
export function settle(d: PassDeps, id: string, r: RegResult): void {
  const spent = readEntries(d.load());
  const e = spent?.find((x) => x.id === id);
  if (!spent || !e || e.state !== "registering") { d.log("a keeper registration ended after its pass had moved on: not kept"); return; }
  if (r.ok) { e.state = "accepted"; e.accepted = r.accepted; }
  else { e.state = "refused"; e.said = `the keeper didn't accept every install: ${r.said.join("; ").slice(0, 400) || "no reason"}`; }
  try { writeEntries(d, spent); } catch { d.log("couldn't keep a keeper registration's outcome: the pass times out and is refused"); return; }
  d.log(r.ok ? `the keeper accepted every watched install for a Ship token (${r.accepted.map((a) => `${a.attempt} backup ${a.backup}`).join(", ") || "none watched"})` : `a Ship token's pass is refused: ${e.said}`);
}

export function shipPass(d: PassDeps, body: any, depth = 0): PassAnswer {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "refused", said: "no Ship token" };
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
  if (!e) {
    spent = spent.filter((x) => x.exp * 1000 > now - 86_400_000);
    spent.push({ id, exp: c.claim.exp, state: "registering", at: now });
    try { writeEntries(d, spent); }
    catch { return { status: "refused", said: "the link couldn't record the Ship token, so no Ship run starts: try again in a minute" }; }
    d.log(`registering the installs of ${where} with the keeper; the Ship run waits for its acceptance`);
    d.register(token, c.claim, (r) => settle(d, id, r));
    return depth ? { status: "pending", said: PENDING_SAID } : shipPass(d, body, 1);
  }
  if (e.state === "passed") {
    d.log(`refused a second Ship run on the token for ${where}`);
    return { status: "spent", said: "that Ship token already started a Ship run; one tap starts one run. If the install still has to happen, show a new Ship card for the same pull request and head" };
  }
  if (e.state === "refused") return { status: "refused", said: `${e.said ?? "the keeper didn't accept the install"}. Nothing was installed; a new Ship card for the same pull request and head tries again` };
  if (e.state === "registering") {
    if (now - e.at <= PASS_WAIT_MS) return { status: "pending", said: PENDING_SAID };
    e.state = "refused"; e.said = `the keeper didn't accept every install within ${PASS_WAIT_MS / 60_000} minutes`;
    try { writeEntries(d, spent); } catch { /* refused either way */ }
    d.log(`a Ship token's pass is refused: ${e.said}`);
    return { status: "refused", said: `${e.said}. Nothing was installed; a new Ship card for the same pull request and head tries again` };
  }
  // accepted: passed before the answer, so a crash between the two refuses the run rather than letting two through
  e.state = "passed";
  try { writeEntries(d, spent); }
  catch { return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  d.log(`let a Ship run through for ${where} (every watched install accepted by the keeper); its token is spent`);
  return { status: "ok", pr: c.claim.pr, head: c.claim.head, accepted: e.accepted ?? [] };
}

export interface RegisterDeps {
  api: MergeDeps["api"];
  post: (body: unknown) => Promise<{ status: number; body: any } | null>;   // POST /attempt on the keeper, Cain's token
  log: (line: string) => void;
}
// The registration of each watched App the tap installs (0.1.4): ok only when every one is accepted (the
// keeper's answer 200 "accepted" for that App and versions, with its attempt id and backup slug). A base,
// a list of bumps, a version or a probe that can't be read, a keeper that refuses or doesn't answer within
// ATTEMPT_WAIT_MS: not ok, so the pass is refused (Gemini: register every watched App, or refuse).
export async function registerInstalls(d: RegisterDeps, token: string, c: Claim): Promise<RegResult> {
  const said: string[] = [];
  const accepted: Accepted[] = [];
  let ok = true;
  const say = (l: string, bad = true) => { said.push(l); if (bad) ok = false; d.log(`keeper registration: ${l}`); };
  const pull = await d.api(`/repos/${c.repo}/pulls/${c.pr}`).catch(() => null);
  const base = pull?.status === 200 ? String(pull.body?.base?.sha ?? "") : "";
  if (!/^[0-9a-f]{40}$/.test(base)) { say(`pull request ${c.pr}'s base couldn't be read, so nothing was registered`); return { ok: false, said }; }
  const bumps = await bumpsAt(d, c.repo, base, c.head);
  if (!bumps) { say("what the tap installs couldn't be read, so nothing was registered"); return { ok: false, said }; }
  for (const b of bumps) {
    const slug = APP_SLUGS[b.app];
    if (!slug || !WATCHED.has(slug)) continue;
    const from = await versionAt(d, c.repo, CONFIGS[b.app], base);
    const probe = await fileAt(d, c.repo, PROBE_FILES[b.app] ?? CONFIGS[b.app], c.head);
    if (!from || from === "none" || !probe || probe === "missing") { say(`${b.app}'s version at the base or its probe at the head couldn't be read: not registered`); continue; }
    const r = await d.post({ token, app: slug, pr: c.pr, head: c.head, from_version: from, to_version: b.version, kind: "ship",
      probe_hash: createHash("sha256").update(probe).digest("hex").slice(0, 16) }).catch(() => null);
    const j = r?.body ?? {};
    if (r && r.status === 200 && j.status === "accepted" && j.app === slug && j.from_version === from && j.to_version === b.version
        && typeof j.id === "string" && ATTEMPT_ID.test(j.id) && typeof j.backup === "string" && BACKUP_SLUG.test(j.backup)) {
      accepted.push({ app: slug, attempt: j.id, backup: j.backup });
      say(`${b.app} ${from} to ${b.version} accepted as ${j.id}, backup ${j.backup}`, false);
    } else say(!r ? `the keeper didn't answer for ${b.app} ${b.version}` : r.status === 200 ? `the keeper's answer for ${b.app} ${b.version} isn't an acceptance of it`
      : `the keeper refused ${b.app} ${b.version}: ${String(j?.why ?? r.status).slice(0, 160)}`);
  }
  return ok ? { ok: true, accepted, said } : { ok: false, said };
}
