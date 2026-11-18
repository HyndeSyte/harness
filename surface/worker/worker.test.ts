import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, makeKeyPair, makePolicy, privateKey, signSnapshot } from "../export/lib";
import { createWorker, MAX_BYTES, type Env } from "./src/index";

// Made-up values only.
const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-example-0001";
const OWNER = "owner@example.com";
const CLIENT_ID = "client-id-example.access";
const PUBLISHER = "publisher-value-example";
const NOW = Date.parse("2026-11-18T12:00:00Z");

function memoryKV() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), m };
}

const keys = makeKeyPair();
const FIX = join(import.meta.dir, "..", "export", "fixtures");
const policy = makePolicy(readFileSync(join(FIX, "private-terms.txt"), "utf8"), { owner_names: ["Robin"] });
const snap = (when: string) =>
  signSnapshot(buildSnapshot(join(FIX, "record"), policy, new Date(when)).snapshot, privateKey(keys.privatePem));
const env = (): Env & { SNAPSHOTS: ReturnType<typeof memoryKV> } => ({
  SNAPSHOTS: memoryKV(),
  SNAPSHOT_PUBLIC_KEY: keys.publicRaw,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  OWNER_EMAIL: OWNER,
  PUBLISHER_CLIENT_ID: CLIENT_ID,
  PUBLISHER_TOKEN: PUBLISHER,
});

// An Access signing key, and the team's certs URL serving it.
let rsa: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
let certFetches = 0;
const deps = {
  now: () => NOW,
  fetch: async (url: string) => {
    certFetches++;
    if (url !== `${TEAM}/cdn-cgi/access/certs`) return new Response("no", { status: 404 });
    return new Response(JSON.stringify({ keys: [jwk] }));
  },
};
const worker = createWorker(deps);

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey), kid: "kid-1" };
});

const b64u = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");

async function jwt(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}) {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "kid-1", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? rsa.privateKey, new TextEncoder().encode(head + "." + body));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}
const base = { aud: [AUD], iss: TEAM, exp: NOW / 1000 + 3600, iat: NOW / 1000 };
const ownerJwt = (over: Record<string, unknown> = {}) => jwt({ ...base, email: OWNER, ...over });
const serviceJwt = (over: Record<string, unknown> = {}) => jwt({ ...base, common_name: CLIENT_ID, sub: "", ...over });

const get = async (headers: Record<string, string> = {}) =>
  new Request("https://surface.example.com/snapshot", { method: "GET", headers: { "cf-access-jwt-assertion": await ownerJwt(), ...headers } });
async function put(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://surface.example.com/snapshot", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "cf-access-jwt-assertion": await serviceJwt(), "x-surface-publisher": PUBLISHER, ...headers },
  });
}

describe("the store", () => {
  test("GET before any PUT is 404", async () => {
    expect((await worker.fetch(await get(), env())).status).toBe(404);
  });

  test("PUT a signed snapshot, then GET returns it, never cached", async () => {
    const e = env();
    const s = snap("2026-11-18T12:00:00Z");
    expect((await worker.fetch(await put(s), e)).status).toBe(200);
    const res = await worker.fetch(await get(), e);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(s);
  });

  test("a tampered snapshot is refused and nothing is stored", async () => {
    const e = env();
    const s = snap("2026-11-18T12:00:00Z");
    s.threads[0].title = s.threads[0].title + "!";
    expect((await worker.fetch(await put(s), e)).status).toBe(403);
    expect(e.SNAPSHOTS.m.size).toBe(0);
  });

  test("tampered counts are refused", async () => {
    const s = { ...snap("2026-11-18T12:00:00Z"), excluded_rows: 0 };
    expect((await worker.fetch(await put(s), env())).status).toBe(403);
  });

  test("a snapshot signed by another key is refused", async () => {
    const other = makeKeyPair();
    const s = signSnapshot(buildSnapshot(join(FIX, "record"), policy, new Date(NOW)).snapshot, privateKey(other.privatePem));
    expect((await worker.fetch(await put(s), env())).status).toBe(403);
  });

  test("an older snapshot doesn't replace a newer one", async () => {
    const e = env();
    await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), e);
    expect((await worker.fetch(await put(snap("2026-11-18T11:00:00Z")), e)).status).toBe(409);
  });

  test("made_at more than 5 minutes ahead is refused with a clear message", async () => {
    const e = env();
    const res = await worker.fetch(await put(snap("2026-11-18T12:06:00Z")), e);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/5 minutes ahead/);
    expect(e.SNAPSHOTS.m.size).toBe(0);
    expect((await worker.fetch(await put(snap("2026-11-18T12:04:00Z")), e)).status).toBe(200);
  });

  test("unsigned extra fields are not stored", async () => {
    const e = env();
    const s = { ...snap("2026-11-18T12:00:00Z"), extra: "not signed" };
    expect((await worker.fetch(await put(s), e)).status).toBe(200);
    expect(JSON.parse(e.SNAPSHOTS.m.get("latest")!).extra).toBeUndefined();
  });

  test("the size limit counts bytes, not characters", async () => {
    const s = JSON.stringify(snap("2026-11-18T12:00:00Z"));
    // Under the limit in UTF-16 units, over it in UTF-8 bytes.
    const pad = "😀".repeat(Math.ceil((MAX_BYTES - s.length) / 4) + 10);
    const body = s.slice(0, -1) + `,"pad":"${pad}"}`;
    expect(body.length).toBeLessThan(MAX_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_BYTES);
    expect((await worker.fetch(await put(body), env())).status).toBe(413);
  });

  test("no public key configured refuses", async () => {
    const e = { ...env(), SNAPSHOT_PUBLIC_KEY: "REPLACE_WITH_PUBLIC_KEY_BASE64" };
    expect((await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), e)).status).toBe(500);
  });

  test("not JSON, other paths and methods", async () => {
    const e = env();
    expect((await worker.fetch(await put("{"), e)).status).toBe(400);
    expect((await worker.fetch(new Request("https://x/other"), e)).status).toBe(404);
    expect((await worker.fetch(new Request("https://x/snapshot", { method: "DELETE" }), e)).status).toBe(405);
  });
});

describe("store faults are 503, never cached", () => {
  const broken = (over: Partial<ReturnType<typeof memoryKV>>) => ({ ...env(), SNAPSHOTS: { ...memoryKV(), ...over } });
  const fail = async () => {
    throw new Error("kv down");
  };
  test("a failed read", async () => {
    const e = broken({ get: fail });
    for (const r of [await get(), await put(snap("2026-11-18T12:00:00Z"))]) {
      const res = await worker.fetch(r, e);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
  test("a failed write", async () => {
    const res = await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), broken({ put: fail }));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test("a garbled stored value names the recovery", async () => {
    const e = env();
    e.SNAPSHOTS.m.set("latest", "{garbled");
    for (const r of [await get(), await put(snap("2026-11-18T12:00:00Z"))]) {
      const res = await worker.fetch(r, e);
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toMatch(/delete the KV entry "latest"/);
    }
  });
});

describe("Access on GET", () => {
  const status = async (token: string | null) => {
    const e = env();
    await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), e);
    const headers: Record<string, string> = token === null ? {} : { "cf-access-jwt-assertion": token };
    return (await worker.fetch(new Request("https://surface.example.com/snapshot", { headers }), e)).status;
  };
  test("the owner reads", async () => {
    expect(await status(await ownerJwt())).toBe(200);
    expect(await status(await ownerJwt({ email: "OWNER@Example.com", aud: AUD }))).toBe(200);
  });
  test("no assertion, or garbage, is 403", async () => {
    expect(await status(null)).toBe(403);
    expect(await status("not.a.jwt")).toBe(403);
  });
  test("another identity, audience, issuer, an expired one, a forged one: 403", async () => {
    expect(await status(await ownerJwt({ email: "someone@example.com" }))).toBe(403);
    expect(await status(await ownerJwt({ aud: ["another-aud"] }))).toBe(403);
    expect(await status(await ownerJwt({ iss: "https://other.cloudflareaccess.com" }))).toBe(403);
    expect(await status(await ownerJwt({ exp: NOW / 1000 - 1 }))).toBe(403);
    expect(await status(await serviceJwt())).toBe(403); // the exporter can't read
    const forger = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await status(await jwt({ ...base, email: OWNER }, { key: forger.privateKey }))).toBe(403);
    expect(await status(await jwt({ ...base, email: OWNER }, { kid: "unknown" }))).toBe(403);
  });
  test("the signing keys are cached", async () => {
    const before = certFetches;
    await status(await ownerJwt());
    await status(await ownerJwt());
    expect(certFetches - before).toBe(0);
  });
  test("unreadable signing keys are 503", async () => {
    const w = createWorker({ now: () => NOW + 3_600_000, fetch: async () => new Response("down", { status: 502 }) });
    const res = await w.fetch(await get(), env());
    expect(res.status).toBe(503);
  });
  test("missing Access settings refuse", async () => {
    expect((await worker.fetch(await get(), { ...env(), OWNER_EMAIL: "" })).status).toBe(500);
  });
});

describe("Access on PUT", () => {
  const s = () => snap("2026-11-18T12:00:00Z");
  test("the owner's own assertion can't upload", async () => {
    expect((await worker.fetch(await put(s(), { "cf-access-jwt-assertion": await ownerJwt() }), env())).status).toBe(403);
  });
  test("another service token can't upload", async () => {
    const r = await put(s(), { "cf-access-jwt-assertion": await serviceJwt({ common_name: "other.access" }) });
    expect((await worker.fetch(r, env())).status).toBe(403);
  });
  test("the publisher header is required and must match", async () => {
    const e = env();
    const r = new Request("https://surface.example.com/snapshot", {
      method: "PUT",
      body: JSON.stringify(s()),
      headers: { "cf-access-jwt-assertion": await serviceJwt() },
    });
    expect((await worker.fetch(r, e)).status).toBe(403);
    expect((await worker.fetch(await put(s(), { "x-surface-publisher": "wrong" }), e)).status).toBe(403);
    expect(e.SNAPSHOTS.m.size).toBe(0);
  });
  test("no assertion at all can't upload", async () => {
    const r = new Request("https://surface.example.com/snapshot", {
      method: "PUT",
      body: JSON.stringify(s()),
      headers: { "x-surface-publisher": PUBLISHER },
    });
    expect((await worker.fetch(r, env())).status).toBe(403);
  });
});
