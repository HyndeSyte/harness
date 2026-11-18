import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as exporter, REDIRECTED } from "../export/index";
import { tempRecord } from "../export/fixtures/temp-record";
import { wranglerProblems } from "./check-wrangler";
import { buildSnapshot, makeKeyPair, makePolicy, privateKey, signSnapshot } from "../export/lib";
import { createWorker, MAX_BYTES, teamOf, type Env } from "./src/index";

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
    expect(await status(await ownerJwt({ exp: NOW / 1000 - 61 }))).toBe(403);
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
  test("blank Access settings are 503, naming the setting", async () => {
    for (const name of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL", "PUBLISHER_CLIENT_ID", "PUBLISHER_TOKEN"]) {
      for (const r of [await get(), await put(snap("2026-11-18T12:00:00Z"))]) {
        const res = await worker.fetch(r, { ...env(), [name]: " " });
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(((await res.json()) as any).error).toContain(name);
      }
    }
    const res = await worker.fetch(await get(), { ...env(), OWNER_EMAIL: "", ACCESS_AUD: "" });
    expect(((await res.json()) as any).error).toMatch(/ACCESS_AUD, OWNER_EMAIL are blank/);
  });
  test("a payload that is null, or not an object, is 403, not 503", async () => {
    const forged = async (payload: string) => {
      const head = b64u(JSON.stringify({ alg: "RS256", kid: "kid-1", typ: "JWT" }));
      const body = b64u(payload);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(head + "." + body));
      return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
    };
    for (const payload of ["null", "42", '"text"', "[1,2]", "true"]) expect(await status(await forged(payload))).toBe(403);
    const nullHead = `${b64u("null")}.${b64u(JSON.stringify({ ...base, email: OWNER }))}.${b64u("sig")}`;
    expect(await status(nullHead)).toBe(403);
  });
  test("exp has the same 60 seconds of leeway as nbf", async () => {
    expect(await status(await ownerJwt({ exp: NOW / 1000 - 59 }))).toBe(200);
    expect(await status(await ownerJwt({ exp: NOW / 1000 - 60 }))).toBe(403);
    expect(await status(await ownerJwt({ exp: NOW / 1000 - 3600 }))).toBe(403);
    expect(await status(await ownerJwt({ nbf: NOW / 1000 + 59 }))).toBe(200);
    expect(await status(await ownerJwt({ nbf: NOW / 1000 + 61 }))).toBe(403);
  });
});

describe("the team domain, in one form", () => {
  test("with or without https://, or with http://, the keys come from the https form", () => {
    for (const v of [TEAM, "example-team.cloudflareaccess.com", "http://example-team.cloudflareaccess.com/", " HTTPS://Example-Team.cloudflareaccess.com/ "])
      expect(teamOf({ ACCESS_TEAM_DOMAIN: v })).toBe(TEAM);
  });
  test("given without https://, the owner still reads, and the issuer must be the https form", async () => {
    const e = { ...env(), ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com" };
    const read = async (token: string) =>
      (await worker.fetch(new Request("https://surface.example.com/snapshot", { headers: { "cf-access-jwt-assertion": token } }), e)).status;
    expect(await read(await ownerJwt())).toBe(404); // through Access's check: no snapshot yet
    expect(await read(await ownerJwt({ iss: "example-team.cloudflareaccess.com" }))).toBe(403);
    expect(await read(await ownerJwt({ iss: "http://example-team.cloudflareaccess.com" }))).toBe(403);
  });
});

describe("an unknown key id", () => {
  // A team of its own, so the caches start empty.
  const team = "https://kid-team.cloudflareaccess.com";
  let t = NOW;
  let fetches = 0;
  const w = createWorker({
    now: () => t,
    fetch: async () => (fetches++, new Response(JSON.stringify({ keys: [jwk] }))),
  });
  const e = () => ({ ...env(), ACCESS_TEAM_DOMAIN: team });
  const read = async (kid: string) => {
    const token = await jwt({ ...base, iss: team, exp: t / 1000 + 3600, email: OWNER }, { kid });
    return (await w.fetch(new Request("https://surface.example.com/snapshot", { headers: { "cf-access-jwt-assertion": token } }), e())).status;
  };
  test("is remembered for a minute: 403 without fetching the key set again", async () => {
    expect(await read("kid-1")).toBe(404);
    expect(fetches).toBe(1);
    expect(await read("unknown-a")).toBe(403);
    expect(await read("unknown-a")).toBe(403);
    expect(await read("unknown-b")).toBe(403); // a new kid under a minute after a fetch: no fetch either
    expect(fetches).toBe(1);
    t += 61_000;
    expect(await read("unknown-a")).toBe(403);
    expect(fetches).toBe(2);
    expect(await read("unknown-a")).toBe(403);
    expect(await read("unknown-c")).toBe(403);
    expect(fetches).toBe(2);
    expect(await read("kid-1")).toBe(404); // the known key still reads, from the cache
    expect(fetches).toBe(2);
  });
});

describe("wrangler.toml", () => {
  test("has workers_dev and preview_urls false", () => {
    expect(wranglerProblems(readFileSync(join(import.meta.dir, "wrangler.toml"), "utf8"))).toEqual([]);
  });
  test("the check fails if either is missing or true", () => {
    expect(wranglerProblems('name = "x"\nworkers_dev = false\n')).toEqual(["preview_urls is missing (it must be false)"]);
    expect(wranglerProblems('workers_dev = true\npreview_urls = false\n')).toEqual(["workers_dev is true (it must be false)"]);
    expect(wranglerProblems('workers_dev = false\npreview_urls = false\n[env.dev]\nworkers_dev = true\n')).toEqual([
      "env.dev.workers_dev is true (it must be false)",
    ]);
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

describe("the exporter's --put, against this Worker in-process", () => {
  // Made-up values only. Access is played by the fetch below: it lets the request through only
  // with the service token's two headers, drops them, and adds its assertion, as Access does.
  const ID = "service-token-id-example";
  const SECRET = "service-token-secret-example";
  const putEnv = {
    SURFACE_PUT_HOST: "surface.example.com",
    SURFACE_ACCESS_CLIENT_ID: ID,
    SURFACE_ACCESS_CLIENT_SECRET: SECRET,
    SURFACE_PUBLISHER_TOKEN: PUBLISHER,
  };
  const dir = mkdtempSync(join(tmpdir(), "surface-put-"));
  const keyFile = join(dir, "surface.key");
  // --put implies --strict, so it uploads a clean record: no malformed row, no capitalised word left.
  const record = tempRecord([
    "| P1 | Tidy the garage shelves. | Cain | Sort the bins. | | Shelves sorted. | 2026-11-01 |",
    "| P2 | Pick the reminder time. | Robin | Choose a time on Friday. | Robin's pick | The reminder fires. | 2026-11-02 |",
  ]);
  const run = ["--record", record, "--private-terms", join(FIX, "private-terms.txt"), "--config", join(FIX, "exporter.json")];
  const URL_ = "https://surface.example.com/snapshot";
  // The exporter dates its snapshot now, so this Worker reads the real clock.
  const live = createWorker({ now: () => Date.now(), fetch: deps.fetch });

  function harness(e: Env) {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchVia = async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      calls.push({ url, headers: h });
      if (h.get("cf-access-client-id") !== ID || h.get("cf-access-client-secret") !== SECRET)
        return new Response("Forbidden", { status: 403 });
      h.delete("cf-access-client-id");
      h.delete("cf-access-client-secret");
      h.set("cf-access-jwt-assertion", await serviceJwt({ exp: Date.now() / 1000 + 3600 }));
      return live.fetch(new Request(url, { method: init.method, body: init.body, headers: h }), e);
    };
    return { calls, fetch: fetchVia };
  }
  const capture = async (f: () => Promise<number>) => {
    const lines: string[] = [];
    const err = console.error, log = console.log;
    console.error = console.log = (m: string) => void lines.push(String(m));
    try {
      return { code: await f(), out: lines.join("\n") };
    } finally {
      console.error = err;
      console.log = log;
    }
  };

  beforeAll(async () => {
    await capture(() => exporter(["--keygen", dir]));
  });
  const workerEnv = () => ({ ...env(), SNAPSHOT_PUBLIC_KEY: readFileSync(join(dir, "surface.pub.b64"), "utf8").trim() });

  test("a signed snapshot is stored: 200, exit 0, the status and the Worker's message printed", async () => {
    const e = workerEnv();
    const h = harness(e);
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(0);
    expect(out).toMatch(/PUT https:\/\/surface\.example\.com\/snapshot: 200 stored /);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].headers.get("x-surface-publisher")).toBe(PUBLISHER);
    const stored = JSON.parse(e.SNAPSHOTS.m.get("latest")!);
    expect(stored.threads.length).toBeGreaterThan(0);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(PUBLISHER);
  });

  test("a refusal is exit 1 with the Worker's message", async () => {
    const e = workerEnv();
    const h = harness(e);
    const env2 = { ...putEnv, SURFACE_PUBLISHER_TOKEN: "wrong" };
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: env2 }));
    expect(code).toBe(1);
    expect(out).toContain("403 the publisher header is missing or wrong");
    expect(e.SNAPSHOTS.m.size).toBe(0);
  });

  test("Access refusing the token is exit 1", async () => {
    const h = harness(workerEnv());
    const env2 = { ...putEnv, SURFACE_ACCESS_CLIENT_SECRET: "wrong" };
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: env2 }));
    expect(code).toBe(1);
    expect(out).toContain(": 403");
    // Only the Worker's JSON message is ever printed, never another body.
    expect(out).not.toContain("Forbidden");
  });

  test("the fixture record, with its malformed rows and leftovers, is refused under --put before any request", async () => {
    const h = harness(workerEnv());
    const fixtureRun = ["--record", join(FIX, "record"), ...run.slice(2)];
    const { code } = await capture(() => exporter([...fixtureRun, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(h.calls.length).toBe(0);
  });

  test("an older snapshot is 409, exit 1", async () => {
    const e = workerEnv();
    e.SNAPSHOTS.m.set("latest", JSON.stringify({ made_at: "2999-01-01T00:00:00.000Z" }));
    const h = harness(e);
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain("409 older than the stored snapshot");
  });

  test("a missing variable is exit 2 before any request", async () => {
    for (const name of Object.keys(putEnv)) {
      const h = harness(workerEnv());
      const env2: Record<string, string | undefined> = { ...putEnv, [name]: undefined };
      const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: h.fetch, env: env2 }));
      expect(code).toBe(2);
      expect(out).toContain(name);
      expect(h.calls.length).toBe(0);
    }
  });

  test("no answer is exit 1", async () => {
    const { code, out } = await capture(() =>
      exporter([...run, "--key", keyFile, "--put", URL_], {
        fetch: async () => {
          throw new Error("connection refused");
        },
        env: putEnv,
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("no answer");
  });

  test("the URL must be https, on SURFACE_PUT_HOST, with no credentials: else exit 2 before any request", async () => {
    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      ["http://surface.example.com/snapshot", putEnv, /must be https/],
      ["https://elsewhere.example.com/snapshot", putEnv, /host is not SURFACE_PUT_HOST/],
      ["https://user:pw@surface.example.com/snapshot", putEnv, /credentials/],
      [URL_, { ...putEnv, SURFACE_PUT_HOST: undefined }, /SURFACE_PUT_HOST/],
      ["not a url", putEnv, /not a URL/],
    ];
    for (const [url, env2, why] of cases) {
      const h = harness(workerEnv());
      const out = join(dir, "never.json");
      const r = await capture(() => exporter([...run, "--key", keyFile, "--out", out, "--put", url], { fetch: h.fetch, env: env2 }));
      expect([url, r.code]).toEqual([url, 2]);
      expect(r.out).toMatch(why);
      expect(r.out).not.toContain("pw@");
      expect(h.calls.length).toBe(0);
      expect(existsSync(out)).toBe(false);
    }
  });

  // A fetch that follows redirects unless told not to, as fetch does, recording every request.
  function redirecting(location: string) {
    const calls: { url: string; headers: Headers }[] = [];
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, headers: new Headers(init.headers) });
      if (url === URL_) {
        const res = new Response(null, { status: 307, headers: { location } });
        return init.redirect === "manual" ? res : f(location, init);
      }
      return new Response(JSON.stringify({ stored: "x" }));
    };
    return { calls, fetch: f };
  }

  test("a 307 to another host is refused: the other host gets no request and no header", async () => {
    const r = redirecting("https://elsewhere.example.net/collect");
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: r.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain(REDIRECTED);
    expect(r.calls.length).toBe(1);
    expect(r.calls.some((c) => c.url.includes("elsewhere"))).toBe(false);
    for (const v of [ID, SECRET, PUBLISHER]) expect(out).not.toContain(v);
  });

  test("a redirect from the first host to itself (an Access login) is refused likewise", async () => {
    const r = redirecting("https://surface.example.com/cdn-cgi/access/login?x=1");
    const { code, out } = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: r.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain("Access redirected: the service token or its Service Auth policy is wrong");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].url).toBe(URL_);
  });

  test("the printed message is the Worker's JSON message only, at most 200 characters", async () => {
    const long = "x".repeat(500);
    const f = async () => new Response(JSON.stringify({ error: long, extra: "not printed" }), { status: 400 });
    const r1 = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: f, env: putEnv }));
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("x".repeat(200));
    expect(r1.out).not.toContain("x".repeat(201));
    expect(r1.out).not.toContain("not printed");
    const html = async () => new Response("<html>secret-ish page</html>", { status: 502 });
    const r2 = await capture(() => exporter([...run, "--key", keyFile, "--put", URL_], { fetch: html, env: putEnv }));
    expect(r2.code).toBe(1);
    expect(r2.out).not.toContain("secret-ish");
  });

  test("--put with no url, or with --dry-run, is exit 2", async () => {
    const h = harness(workerEnv());
    expect((await capture(() => exporter([...run, "--key", keyFile, "--put"], { fetch: h.fetch, env: putEnv }))).code).toBe(2);
    expect((await capture(() => exporter([...run, "--dry-run", "--put", URL_], { fetch: h.fetch, env: putEnv }))).code).toBe(2);
    expect(h.calls.length).toBe(0);
  });
});
