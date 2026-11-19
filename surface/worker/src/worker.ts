// The surface's Worker, everything but its entry (src/index.ts, which workerd loads and which may
// export only the handler and the Durable Object class). PUT /snapshot stores a signed snapshot, GET /snapshot returns the latest.
// It sits on the app's own Pages hostname as a route, behind Cloudflare Access (surface/README.md,
// Deploy), and checks Access's own assertion itself: GET only for the owner's identity, PUT only
// for the exporter's service token carrying the publisher header, and a valid signature. It holds
// no GitHub token and no record access, and has no way into the home network: it only checks a
// signature and keeps one JSON document in a Durable Object, which compares and writes atomically.

import { fromBase64, isIsoTime, isRevision, type Revision } from "../../shared/canonical";
import { keyList, snapshotId, verifyVerdict, type Snapshot } from "../../shared/snapshot";

// --- the store: one Durable Object --------------------------------------------------------------

// The storage a Durable Object gets (the part used here), and its state.
export interface DOStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}
export interface DOState {
  storage: DOStorage;
  // Runs the callback with no other event delivered to this object until it settles.
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T>;
}
// The namespace binding the Worker gets (fetch-style stubs, no runtime imports).
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

// What the store holds: the signed snapshot, its identity (the SHA-256 of its signed bytes), the
// fields the compare reads (made_at, key_id, revision), and when the Worker received it.
export interface Stored {
  id: string;
  made_at: string;
  received_at: string;
  key_id: string;
  revision: Revision | null;
  snapshot: Record<string, unknown>;
}

// The compare and write: under the object's lock, read what is held, and write the candidate only
// if it may replace it. In order:
// - the same identity again is "same" (nothing written; the uploader reconciling a lost response
//   learns its snapshot is the one held);
// - a held snapshot signed by a key that is no longer active (retired, or no longer listed) is
//   replaced by any valid candidate, whatever its made_at or revision: a stolen key's far-future
//   snapshot is cleared by retiring that key;
// - when both carry a revision, the revision decides: a lower seq is "older", the same seq with
//   another commit is "conflict", a higher seq is written; the same commit falls through to made_at;
// - otherwise an older made_at is "older", and anything else is written (an equal made_at too).
export type WriteResult =
  | { result: "stored"; id: string; made_at: string; received_at: string; replaced_retired: boolean }
  | { result: "same"; id: string; made_at: string; received_at: string }
  | { result: "older" | "conflict"; id: string; made_at: string; why: string }
  | { result: "unreadable" }
  | { result: "failed" };

export async function compareAndWrite(state: DOState, candidate: Stored, activeKeys: readonly string[]): Promise<WriteResult> {
  return state.blockConcurrencyWhile(async () => {
    let held: unknown;
    try {
      held = await state.storage.get(STORE_KEY);
    } catch {
      return { result: "failed" } as const;
    }
    if (held !== undefined && !isStored(held)) return { result: "unreadable" } as const;
    let replacedRetired = false;
    if (held) {
      if (held.id === candidate.id) return { result: "same", id: held.id, made_at: held.made_at, received_at: held.received_at } as const;
      if (!activeKeys.includes(held.key_id)) replacedRetired = true;
      else {
        const verdict = order(held, candidate);
        if (verdict) return { result: verdict.result, id: held.id, made_at: held.made_at, why: verdict.why } as const;
      }
    }
    try {
      await state.storage.put(STORE_KEY, candidate);
    } catch {
      return { result: "failed" } as const;
    }
    return { result: "stored", id: candidate.id, made_at: candidate.made_at, received_at: candidate.received_at, replaced_retired: replacedRetired } as const;
  });
}

// Whether the held snapshot (signed by an active key) keeps its place: a reason, or null to write.
function order(held: Stored, candidate: Stored): { result: "older" | "conflict"; why: string } | null {
  const h = held.revision;
  const c = candidate.revision;
  if (h && c) {
    if (c.seq < h.seq) return { result: "older", why: "an older record revision than the stored snapshot" };
    if (c.seq > h.seq) return null;
    if (c.commit !== h.commit) return { result: "conflict", why: "another commit at the stored snapshot's record revision" };
  }
  if (Date.parse(held.made_at) > Date.parse(candidate.made_at)) return { result: "older", why: "older than the stored snapshot" };
  return null;
}

const STORE_KEY = "latest";
export function isStored(v: unknown): v is Stored {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<Stored>;
  return typeof s.id === "string" && /^[0-9a-f]{64}$/.test(s.id) && isIsoTime(s.made_at) && isIsoTime(s.received_at) &&
    typeof s.key_id === "string" && (s.revision === null || isRevision(s.revision)) && !!s.snapshot && typeof s.snapshot === "object";
}

// The Durable Object class (wrangler.toml binds it as STORE). Reached only through the Worker, which
// has already checked Access, the publisher and the signature: GET reads what is held, PUT compares
// and writes.
export class SnapshotStore {
  constructor(private state: DOState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      let held: unknown;
      try {
        held = await this.state.storage.get(STORE_KEY);
      } catch {
        return Response.json({ result: "failed" });
      }
      if (held === undefined) return Response.json({ result: "empty" });
      return Response.json(isStored(held) ? { result: "held", stored: held } : { result: "unreadable" });
    }
    if (request.method === "PUT") {
      let candidate: unknown;
      try {
        candidate = await request.json();
      } catch {
        return Response.json({ result: "failed" });
      }
      const c = candidate as { candidate?: unknown; active_keys?: unknown } | null;
      const active = c?.active_keys;
      if (!c || !isStored(c.candidate) || !Array.isArray(active) || !active.every((k) => typeof k === "string"))
        return Response.json({ result: "failed" });
      return Response.json(await compareAndWrite(this.state, c.candidate, active));
    }
    return new Response(null, { status: 405 });
  }
}

// Every value comes from the Worker's variables and secrets (wrangler.toml, `wrangler secret put`).
export interface Env {
  // The Durable Object namespace holding the one store.
  STORE: DONamespace;
  // The store object's name (default "latest"). A new name starts an empty store: the recovery
  // when the held snapshot is unreadable or dated in the future. A variable.
  STORE_NAME?: string;
  // The exporter's Ed25519 public keys, comma-separated, each `<key id>:<raw key, base64>` with
  // `:retired` after one that may no longer sign: a snapshot verifies under the one its signed key_id
  // names, so a new key is added beside the old before the exporter switches, and the old retired
  // after. A variable.
  SNAPSHOT_PUBLIC_KEYS: string;
  // The Zero Trust team domain, like https://<team>.cloudflareaccess.com (the https:// may be left
  // off; it is normalised to that form). A variable.
  ACCESS_TEAM_DOMAIN: string;
  // The Access application's audience tag (AUD); several may be given, comma-separated. A variable.
  ACCESS_AUD: string;
  // The one identity allowed to read. A secret.
  OWNER_EMAIL: string;
  // The exporter's service token Client ID (Access puts it in the assertion's common_name). A secret.
  PUBLISHER_CLIENT_ID: string;
  // The value the exporter sends in X-Surface-Publisher with each PUT. A secret.
  PUBLISHER_TOKEN: string;
}

export interface Deps {
  fetch: (url: string) => Promise<Response>;
  now: () => number;
}

export const MAX_BYTES = 512 * 1024;
export const MAX_AHEAD_MS = 5 * 60_000;
// The oldest made_at a PUT may carry: 24 hours behind the Worker's clock. Long enough for the owner to
// read a dry run and approve its bytes before the first upload, short enough that a captured old
// snapshot can't be replayed into an emptied store days later.
export const MAX_AGE_MS = 24 * 60 * 60_000;
const CERTS_TTL_MS = 10 * 60_000;
// A kid the fetched key set lacked is refused for a minute without fetching again, and the key
// set is fetched at most once a minute for keys it doesn't have.
export const UNKNOWN_KID_TTL_MS = 60_000;
const UNKNOWN_KIDS_MAX = 256;
const SKEW_S = 60;
export const PUBLISHER_HEADER = "x-surface-publisher";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

class Unavailable extends Error {}

// --- Cloudflare Access ------------------------------------------------------------------------

const b64url = (s: string) => fromBase64(s.replace(/-/g, "+").replace(/_/g, "/"));
const decodeJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64url(s)));

// The team domain in one form, whichever way the variable is given: https://<host>, lower case,
// no trailing slash. "<team>.cloudflareaccess.com" and "http://..." both become the https form.
export function teamOf(env: Pick<Env, "ACCESS_TEAM_DOMAIN">): string {
  const t = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/\/+$/, "");
  if (!t) return "";
  return ("https://" + t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")).toLowerCase();
}

type Certs = { at: number; keys: Map<string, JsonWebKey> };
const certCache = new Map<string, Certs>();
const unknownKids = new Map<string, number>();

function rememberUnknown(team: string, kid: string, at: number) {
  if (unknownKids.size >= UNKNOWN_KIDS_MAX) {
    for (const [k, t] of unknownKids) if (at - t >= UNKNOWN_KID_TTL_MS) unknownKids.delete(k);
    if (unknownKids.size >= UNKNOWN_KIDS_MAX) unknownKids.clear();
  }
  unknownKids.set(`${team} ${kid}`, at);
}

async function signingKey(team: string, kid: string, deps: Deps): Promise<JsonWebKey | undefined> {
  const now = deps.now();
  const cached = certCache.get(team);
  if (cached && now - cached.at < CERTS_TTL_MS && cached.keys.has(kid)) return cached.keys.get(kid);
  const missedAt = unknownKids.get(`${team} ${kid}`);
  if (missedAt !== undefined && now - missedAt < UNKNOWN_KID_TTL_MS) return undefined;
  // Fetched under a minute ago and this kid wasn't in it: refuse without fetching again.
  if (cached && now - cached.at < UNKNOWN_KID_TTL_MS) {
    rememberUnknown(team, kid, now);
    return undefined;
  }
  let body: { keys?: unknown } | null;
  try {
    const res = await deps.fetch(`${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(String(res.status));
    body = await res.json();
  } catch {
    throw new Unavailable("the Access signing keys could not be read");
  }
  const keys = new Map<string, JsonWebKey>();
  const listed: unknown[] = Array.isArray(body?.keys) ? body.keys : [];
  for (const k of listed) if (k && typeof k === "object" && typeof (k as { kid?: unknown }).kid === "string") keys.set((k as { kid: string }).kid, k as JsonWebKey);
  certCache.set(team, { at: now, keys });
  if (!keys.has(kid)) rememberUnknown(team, kid, now);
  return keys.get(kid);
}

export type Identity = { email?: unknown; common_name?: unknown; sub?: unknown };

// Checks Access's assertion: signed by one of the team's keys (RS256), for our audience, from our
// team, not expired. Returns its claims, or a reason it is refused.
export async function accessClaims(request: Request, env: Env, deps: Deps): Promise<Identity | string> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "no Access assertion";
  const parts = token.split(".");
  if (parts.length !== 3) return "a malformed Access assertion";
  let header: unknown, payload: unknown;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return "a malformed Access assertion";
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(header) || !isObject(payload)) return "a malformed Access assertion";
  const claims = payload;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return "an unexpected Access assertion";
  const team = teamOf(env);
  const jwk = await signingKey(team, header.kid, deps);
  if (!jwk) return "an Access assertion signed by an unknown key";
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch {
    ok = false;
  }
  if (!ok) return "an Access assertion that does not verify";
  const auds = (env.ACCESS_AUD || "").split(",").map((a) => a.trim()).filter(Boolean);
  const got = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!got.some((a: unknown) => typeof a === "string" && auds.includes(a))) return "an Access assertion for another application";
  // The issuer must be the team's full https form.
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "").toLowerCase() !== team) return "an Access assertion from another team";
  const nowS = deps.now() / 1000;
  // Both times allow the same minute of clock skew.
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= nowS) return "an expired Access assertion";
  if (typeof claims.nbf === "number" && claims.nbf > nowS + SKEW_S) return "an Access assertion not valid yet";
  return { email: claims.email, common_name: claims.common_name, sub: claims.sub };
}

export function publisherClient(who: Identity): string | null {
  if (typeof who.common_name === "string" && who.common_name) return who.common_name;
  if (typeof who.sub === "string" && who.sub) return who.sub;
  return null;
}

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// The Access settings the Worker can't run without, by name, so a blank one is named.
export const ACCESS_SETTINGS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL", "PUBLISHER_CLIENT_ID", "PUBLISHER_TOKEN"] as const;
const missingSettings = (env: Env) =>
  ACCESS_SETTINGS.filter((k) => typeof env[k] !== "string" || !env[k].trim().replace(/\/+$/, ""));

// --- the store, from the Worker's side -------------------------------------------------------

const storeOf = (env: Env) => env.STORE.get(env.STORE.idFromName((env.STORE_NAME || "").trim() || STORE_KEY));
const RECOVER = 'set the Worker variable STORE_NAME to a new name to start an empty store (surface/README.md, Recovering a wedged store)';

type StoreAnswer = { result?: unknown; stored?: unknown } & Partial<Record<string, unknown>>;
async function askStore(env: Env, request: Request): Promise<StoreAnswer | null> {
  try {
    const res = await storeOf(env).fetch(request);
    return await res.json();
  } catch {
    throw new Unavailable("the store could not be reached");
  }
}

async function readStored(env: Env): Promise<Stored | null> {
  const r = await askStore(env, new Request("https://store/latest", { method: "GET" }));
  if (r?.result === "empty") return null;
  if (r?.result === "held" && isStored(r.stored)) return r.stored;
  if (r?.result === "unreadable") throw new Unavailable(`the stored snapshot is unreadable; ${RECOVER}`);
  throw new Unavailable("the store could not be read");
}

// --- the routes -------------------------------------------------------------------------------

async function put(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await accessClaims(request, env, deps);
  if (typeof who === "string") return json(403, { error: who });
  // Access names a service token's client id in common_name, and on some assertions in sub: the
  // one present (a non-empty string, common_name first) is compared in constant time. Neither a
  // string: refused.
  const client = publisherClient(who);
  if (client === null || !sameSecret(client, env.PUBLISHER_CLIENT_ID.trim()))
    return json(403, { error: "only the exporter's service token may upload" });
  if (!sameSecret(request.headers.get(PUBLISHER_HEADER) ?? "", env.PUBLISHER_TOKEN.trim()))
    return json(403, { error: "the publisher header is missing or wrong" });

  const length = Number(request.headers.get("content-length") || "0");
  if (length > MAX_BYTES) return json(413, { error: "too large" });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return json(413, { error: "too large" });
  let body: Snapshot;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json(400, { error: "not JSON" });
  }
  const keys = await keyList(env.SNAPSHOT_PUBLIC_KEYS || "");
  if (!keys) return json(500, { error: "the Worker's SNAPSHOT_PUBLIC_KEYS is malformed (each entry <key id>:<base64>[:retired], ids matching their keys)" });
  const active = keys.filter((k) => !k.retired).map((k) => k.id);
  if (!active.length) return json(500, { error: "the Worker has no active public key configured" });
  const verdict = await verifyVerdict(body, keys);
  if (verdict === "retired") return json(403, { error: "signed by a retired key" });
  if (verdict !== "ok") return json(403, { error: "signature does not verify (or an unknown version, app, purpose or key id, or a field outside the signed ones)" });
  const madeAt = Date.parse(body.made_at);
  const now = deps.now();
  if (madeAt > now + MAX_AHEAD_MS)
    return json(400, { error: "made_at is more than 5 minutes ahead of the Worker's clock; check the exporter's clock" });
  if (madeAt < now - MAX_AGE_MS) return json(400, { error: "made_at is more than 24 hours old; export again" });
  // Store only the signed fields and the signature, as received (wellFormed allowed no other field).
  const snapshot: Record<string, unknown> = { ...body };
  const id = await snapshotId(snapshot);
  const candidate: Stored = {
    id,
    made_at: body.made_at,
    received_at: new Date(now).toISOString(),
    key_id: body.key_id,
    revision: body.revision,
    snapshot,
  };
  const r = (await askStore(
    env,
    new Request("https://store/latest", { method: "PUT", body: JSON.stringify({ candidate, active_keys: active }) }),
  )) as WriteResult | null;
  // Every answer names the identity the store holds, so a lost response can be reconciled.
  if (r?.result === "stored") return json(200, { stored: body.made_at, id, received_at: r.received_at, ...(r.replaced_retired ? { replaced_retired: true } : {}) });
  if (r?.result === "same") return json(200, { stored: r.made_at, id: r.id, received_at: r.received_at, already: true });
  if (r?.result === "older" || r?.result === "conflict") return json(409, { error: r.why, id: r.id, made_at: r.made_at });
  if (r?.result === "unreadable") throw new Unavailable(`the stored snapshot is unreadable; ${RECOVER}`);
  throw new Unavailable("the store could not be written");
}

async function get(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await accessClaims(request, env, deps);
  if (typeof who === "string") return json(403, { error: who });
  if (typeof who.email !== "string" || !who.email || who.email.trim().toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase())
    return json(403, { error: "not the owner" });
  const current = await readStored(env);
  if (!current) return json(404, { error: "no snapshot yet" });
  return json(200, current.snapshot);
}

export function createWorker(deps: Deps) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/snapshot") return json(404, { error: "not found" });
      if (request.method !== "GET" && request.method !== "PUT")
        return new Response(null, { status: 405, headers: { allow: "GET, PUT", "cache-control": "no-store" } });
      const missing = missingSettings(env);
      if (missing.length)
        return json(503, { error: `the Worker's Access settings are not configured: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} blank` });
      try {
        return request.method === "PUT" ? await put(request, env, deps) : await get(request, env, deps);
      } catch (e) {
        if (e instanceof Unavailable) return json(503, { error: e.message });
        return json(503, { error: "unavailable" });
      }
    },
  };
}

