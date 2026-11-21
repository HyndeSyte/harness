// The Ship pass (Cain 0.19.0, with Keeper 0.1.3): each Ship token starts one Ship run, and that run's
// installs are registered with the keeper App before it starts.
//
// Cain's RemoteTrigger hook (../hooks/remote-trigger.ts) checks a Ship run's token itself, then asks the
// link here (POST /ship-pass {token}, Cain's key) before it lets the run through. The link:
//   1. checks the token again with its own public Ship key;
//   2. refuses a token it has already let through ("spent"): one Ship run per token. The spent ids
//      (hashes, never the token) are kept in root's /data/trust, which Cain can't write, until the token
//      would have expired anyway;
//   3. records the token as spent before it answers "ok", so a crash between the two refuses the run
//      rather than letting a second one through;
//   4. registers each App the tap installs with the keeper App (POST /attempt on its own service, with
//      Cain's keeper_token): the token itself, the pull request and head it was signed for, the App, its
//      version at the pull request's base and at the head (each App's config.yaml at those commits, as the
//      Ship card reads them), and the probe hash at the head. The keeper verifies the token's signature
//      with the same public key, spends it once per App, makes the App-only backup itself and logs
//      "accepting <id> ...", which the Ship run reads before it installs (RELEASING.md, Ship).
// Why the link and not the Ship run: the Ship run is a cloud session, and the keeper's service is only
// on Home Assistant's internal App network. The Home Assistant connector can't reach it (it speaks to
// Home Assistant, not to an App's port), and the link, on the same network, already talks to the keeper
// with Cain's token. So no options are written at all.
import { createHash } from "node:crypto";
import { publicKey, readToken, type Claim } from "../ship-token";
import { bumpsAt, fileAt, type MergeDeps, versionAt } from "./merge";

export const PASS_FORMAT = 1;
export const PROBE_FILES: Record<string, string> = { Cain: "cain/rootfs/opt/cain/probe/keeper.ts" };
export const APP_SLUGS: Record<string, string> = { Cain: "0fcc2575_cain", Harness: "0fcc2575_harness" };
// The Apps the keeper watches, so only their installs are registered (Keeper's default watch list).
export const WATCHED = new Set(["0fcc2575_cain"]);
const CONFIGS: Record<string, string> = { Cain: "cain/config.yaml", Harness: "harness/config.yaml" };

export const passId = (token: string) => createHash("sha256").update(`ship-pass-v1\n${token.trim()}`).digest("hex").slice(0, 32);

export interface PassDeps {
  pub: () => string | null;                      // the link's public Ship key (base64 SPKI), as /data/trust/ship.pub holds it
  now: () => number;
  load: () => string | null;                     // the spent file's text (null: none yet)
  store: (text: string) => void;                 // writes it whole; throws on failure
  register: (token: string, claim: Claim) => void;   // the keeper registration, in the background
  log: (line: string) => void;
}
export type PassAnswer = { status: "ok"; pr: number; head: string } | { status: "spent" | "refused"; said: string };

export function shipPass(d: PassDeps, body: any): PassAnswer {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "refused", said: "no Ship token" };
  const pub = d.pub();
  if (!pub) return { status: "refused", said: "the link's Ship key can't be read" };
  let c;
  try { c = readToken(token, publicKey(pub), d.now()); } catch { return { status: "refused", said: "the link's Ship key can't be read" }; }
  if (!c.ok) return { status: "refused", said: `that Ship token can't be used: ${c.why}` };
  const text = d.load();
  let spent: { id: string; exp: number }[] = [];
  if (text !== null) {
    try {
      const j = JSON.parse(text);
      if (j?.format !== PASS_FORMAT || !Array.isArray(j.spent)) throw new Error("not a pass file");
      spent = j.spent.filter((x: any) => x && typeof x.id === "string" && Number.isFinite(x.exp));
    } catch { return { status: "refused", said: "the link's record of spent Ship tokens can't be read, so no Ship run starts: log a Build item" }; }
  }
  const id = passId(token);
  if (spent.some((x) => x.id === id)) {
    d.log(`refused a second Ship run on the token for pull request ${c.claim.pr} at ${c.claim.head.slice(0, 12)}`);
    return { status: "spent", said: "that Ship token already started a Ship run; one tap starts one run. If the install still has to happen, show a new Ship card for the same pull request and head" };
  }
  const now = d.now();
  spent = spent.filter((x) => x.exp * 1000 > now - 86_400_000);
  spent.push({ id, exp: c.claim.exp });
  try { d.store(JSON.stringify({ format: PASS_FORMAT, spent })); }
  catch { return { status: "refused", said: "the link couldn't record the Ship token as spent, so no Ship run starts: try again in a minute" }; }
  d.log(`let a Ship run through for pull request ${c.claim.pr} at ${c.claim.head.slice(0, 12)}; its token is spent`);
  d.register(token, c.claim);
  return { status: "ok", pr: c.claim.pr, head: c.claim.head };
}

export interface RegisterDeps {
  api: MergeDeps["api"];
  post: (body: unknown) => Promise<{ status: number; body: any } | null>;   // POST /attempt on the keeper, Cain's token
  log: (line: string) => void;
}
// The registration of each watched App the tap installs. What each answer was is logged; the Ship run
// reads the keeper's own log for the outcome.
export async function registerInstalls(d: RegisterDeps, token: string, c: Claim): Promise<string[]> {
  const said: string[] = [];
  const say = (l: string) => { said.push(l); d.log(`keeper registration: ${l}`); };
  const pull = await d.api(`/repos/${c.repo}/pulls/${c.pr}`).catch(() => null);
  const base = pull?.status === 200 ? String(pull.body?.base?.sha ?? "") : "";
  if (!/^[0-9a-f]{40}$/.test(base)) { say(`pull request ${c.pr}'s base couldn't be read, so nothing was registered (the install goes unwatched)`); return said; }
  const bumps = await bumpsAt(d, c.repo, base, c.head);
  if (!bumps) { say("what the tap installs couldn't be read, so nothing was registered (the install goes unwatched)"); return said; }
  for (const b of bumps) {
    const slug = APP_SLUGS[b.app];
    if (!slug || !WATCHED.has(slug)) continue;
    const from = await versionAt(d, c.repo, CONFIGS[b.app], base);
    const probe = await fileAt(d, c.repo, PROBE_FILES[b.app] ?? CONFIGS[b.app], c.head);
    if (!from || from === "none" || !probe || probe === "missing") { say(`${b.app}'s version at the base or its probe at the head couldn't be read: not registered`); continue; }
    const r = await d.post({ token, app: slug, pr: c.pr, head: c.head, from_version: from, to_version: b.version, kind: "ship",
      probe_hash: createHash("sha256").update(probe).digest("hex").slice(0, 16) }).catch(() => null);
    say(!r ? `the keeper didn't answer for ${b.app} ${b.version}` : r.status === 202 ? `${b.app} ${from} to ${b.version} registered as ${String(r.body?.id ?? "?")}`
      : `the keeper refused ${b.app} ${b.version}: ${String(r.body?.why ?? r.status).slice(0, 160)}`);
  }
  return said;
}
