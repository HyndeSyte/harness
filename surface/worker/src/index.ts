// The surface's Worker: PUT /snapshot stores a signed snapshot, GET /snapshot returns the latest.
// It sits on the app's own Pages hostname as a route, behind Cloudflare Access (surface/README.md,
// Deploy), and checks Access's own assertion itself: GET only for the owner's identity, PUT only
// for the exporter's service token carrying the publisher header, and a valid signature. It holds
// no GitHub token and no record access, and has no way into the home network: it only checks a
// signature and keeps one JSON document in a Durable Object, which compares and writes atomically.

import { fromBase64 } from "../../shared/canonical";
import { parseKeyList, snapshotId, verifySnapshot } from "../../shared/snapshot";

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

// What the store holds: the signed fields, the signature and key id, and the snapshot's identity.
export interface Stored {
  id: string;
  made_at: string;
  snapshot: Record<string, unknown>;
}

// The compare and write: under the object's lock, read what is held, and write the candidate only
// if it isn't older. The same identity again is "same" (nothing written; the uploader reconciling a
// lost response learns its snapshot is the one held); an older made_at is "older"; else "stored".
export type WriteResult =
  | { result: "stored" | "same"; id: string; made_at: string }
  | { result: "older"; id: string; made_at: string }
  | { result: "unreadable" }
  | { result: "failed" };

export async function compareAndWrite(state: DOState, candidate: Stored): Promise<WriteResult> {
  return state.blockConcurrencyWhile(async () => {
    let held: unknown;
    try {
      held = await state.storage.get(STORE_KEY);
    } catch {
      return { result: "failed" } as const;
    }
    if (held !== undefined && !isStored(held)) return { result: "unreadable" } as const;
    if (held) {
      if (held.id === candidate.id) return { result: "same", id: held.id, made_at: held.made_at } as const;
      if (Date.parse(held.made_at) > Date.parse(candidate.made_at)) return { result: "older", id: held.id, made_at: held.made_at } as const;
    }
    try {
      await state.storage.put(STORE_KEY, candidate);
    } catch {
      return { result: "failed" } as const;
    }
    return { result: "stored", id: candidate.id, made_at: candidate.made_at } as const;
  });
}

const STORE_KEY = "latest";
const isStored = (v: unknown): v is Stored =>
  !!v && typeof v === "object" && typeof (v as Stored).id === "string" && typeof (v as Stored).made_at === "string" &&
  !Number.isNaN(Date.parse((v as Stored).made_at)) && !!(v as Stored).snapshot && typeof (v as Stored).snapshot === "object";

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
      if (!isStored(candidate)) return Response.json({ result: "failed" });
      return Response.json(await compareAndWrite(this.state, candidate));
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
  // The exporter's Ed25519 public keys, raw 32 bytes each in base64, comma-separated: a snapshot
  // verifies under the one its key_id names, so a new key is added beside the old before the
  // exporter switches, and the old removed after. A variable.
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
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

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
  let body: any;
  try {
    const res = await deps.fetch(`${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(String(res.status));
    body = await res.json();
  } catch {
    throw new Unavailable("the Access signing keys could not be read");
  }
  const keys = new Map<string, JsonWebKey>();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) if (k && typeof k.kid === "string") keys.set(k.kid, k);
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
  let header: any, claims: any;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return "a malformed Access assertion";
  }
  const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(header) || !isObject(claims)) return "a malformed Access assertion";
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

async function askStore(env: Env, request: Request): Promise<any> {
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
  let body: any;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json(400, { error: "not JSON" });
  }
  const keys = parseKeyList(env.SNAPSHOT_PUBLIC_KEYS || "");
  if (!keys.length) return json(500, { error: "the Worker has no public key configured" });
  if (!(await verifySnapshot(body, keys))) return json(403, { error: "signature does not verify (or an unknown version, app, purpose or key id)" });
  const madeAt = Date.parse(body.made_at);
  if (Number.isNaN(madeAt)) return json(400, { error: "made_at is not a time" });
  if (madeAt > deps.now() + MAX_AHEAD_MS)
    return json(400, { error: "made_at is more than 5 minutes ahead of the Worker's clock; check the exporter's clock" });
  // Store only the signed fields, as received, so nothing unsigned rides along.
  const snapshot = {
    version: body.version,
    app: body.app,
    purpose: body.purpose,
    made_at: body.made_at,
    threads: body.threads,
    excluded_rows: body.excluded_rows,
    skipped_rows: body.skipped_rows,
    sig: body.sig,
    key_id: body.key_id,
  };
  const id = await snapshotId(snapshot);
  const r: WriteResult = await askStore(
    env,
    new Request("https://store/latest", { method: "PUT", body: JSON.stringify({ id, made_at: body.made_at, snapshot }) }),
  );
  // Every answer names the identity the store holds, so a lost response can be reconciled.
  if (r?.result === "stored") return json(200, { stored: body.made_at, id });
  if (r?.result === "same") return json(200, { stored: body.made_at, id, already: true });
  if (r?.result === "older") return json(409, { error: "older than the stored snapshot", id: r.id });
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

export default createWorker({ fetch: (u) => fetch(u), now: () => Date.now() });
