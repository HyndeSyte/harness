// The surface's Worker: PUT /snapshot stores a signed snapshot, GET /snapshot returns the latest.
// It sits on the app's own Pages hostname as a route, behind Cloudflare Access (surface/README.md,
// Deploy), and checks Access's own assertion itself: GET only for the owner's identity, PUT only
// for the exporter's service token carrying the publisher header, and a valid signature. It holds
// no GitHub token and no record access, and has no way into the home network: it only checks a
// signature and keeps one JSON document in KV.

import { fromBase64 } from "../../shared/canonical";
import { verifySnapshot } from "../../shared/snapshot";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// Every value comes from the Worker's variables and secrets (wrangler.toml, `wrangler secret put`).
export interface Env {
  SNAPSHOTS: KV;
  // The exporter's Ed25519 public key, raw 32 bytes in base64. A variable.
  SNAPSHOT_PUBLIC_KEY: string;
  // The Zero Trust team domain, like https://<team>.cloudflareaccess.com. A variable.
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

const KEY = "latest";
export const MAX_BYTES = 512 * 1024;
export const MAX_AHEAD_MS = 5 * 60_000;
const CERTS_TTL_MS = 10 * 60_000;
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
const teamOf = (env: Env) => (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/\/+$/, "");

type Certs = { at: number; keys: Map<string, JsonWebKey> };
const certCache = new Map<string, Certs>();

async function signingKey(team: string, kid: string, deps: Deps): Promise<JsonWebKey | undefined> {
  const cached = certCache.get(team);
  if (cached && deps.now() - cached.at < CERTS_TTL_MS && cached.keys.has(kid)) return cached.keys.get(kid);
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
  certCache.set(team, { at: deps.now(), keys });
  return keys.get(kid);
}

export type Identity = { email?: string; common_name?: string };

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
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== team) return "an Access assertion from another team";
  const nowS = deps.now() / 1000;
  // Both times allow the same minute of clock skew.
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= nowS) return "an expired Access assertion";
  if (typeof claims.nbf === "number" && claims.nbf > nowS + SKEW_S) return "an Access assertion not valid yet";
  return { email: claims.email, common_name: claims.common_name };
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

// --- the store --------------------------------------------------------------------------------

async function readStored(env: Env): Promise<{ made_at: string } | null> {
  let text: string | null;
  try {
    text = await env.SNAPSHOTS.get(KEY);
  } catch {
    throw new Unavailable("the store could not be read");
  }
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || typeof v.made_at !== "string") throw new Error();
    return v;
  } catch {
    throw new Unavailable(`the stored snapshot is unreadable; delete the KV entry "${KEY}" to recover`);
  }
}

// --- the routes -------------------------------------------------------------------------------

async function put(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await accessClaims(request, env, deps);
  if (typeof who === "string") return json(403, { error: who });
  if (!who.common_name || !sameSecret(who.common_name, env.PUBLISHER_CLIENT_ID.trim()))
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
  let pub: Uint8Array;
  try {
    pub = fromBase64(env.SNAPSHOT_PUBLIC_KEY || "");
  } catch {
    pub = new Uint8Array();
  }
  if (pub.length !== 32) return json(500, { error: "the Worker has no public key configured" });
  if (!(await verifySnapshot(body, pub))) return json(403, { error: "signature does not verify" });
  const madeAt = Date.parse(body.made_at);
  if (Number.isNaN(madeAt)) return json(400, { error: "made_at is not a time" });
  if (madeAt > deps.now() + MAX_AHEAD_MS)
    return json(400, { error: "made_at is more than 5 minutes ahead of the Worker's clock; check the exporter's clock" });
  const prev = await readStored(env);
  if (prev && Date.parse(prev.made_at) > madeAt) return json(409, { error: "older than the stored snapshot" });
  // Store only the signed fields, as received, so nothing unsigned rides along.
  const stored = {
    version: body.version,
    made_at: body.made_at,
    threads: body.threads,
    excluded_rows: body.excluded_rows,
    skipped_rows: body.skipped_rows,
    sig: body.sig,
    key_id: body.key_id,
  };
  try {
    await env.SNAPSHOTS.put(KEY, JSON.stringify(stored));
  } catch {
    throw new Unavailable("the store could not be written");
  }
  return json(200, { stored: body.made_at });
}

async function get(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await accessClaims(request, env, deps);
  if (typeof who === "string") return json(403, { error: who });
  if (!who.email || who.email.trim().toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase())
    return json(403, { error: "not the owner" });
  const current = await readStored(env);
  if (!current) return json(404, { error: "no snapshot yet" });
  return json(200, current);
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
