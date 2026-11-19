import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as exporter, REDIRECTED } from "../export/index";
import { tempRecord } from "../export/fixtures/temp-record";
import { wranglerProblems } from "./check-wrangler";
import { buildSnapshot, makeKeyPair, makePolicy, privateKey, signSnapshot } from "../export/lib";
import { canonical, signedBytes, toBase64 } from "../shared/canonical";
import { snapshotId } from "../shared/snapshot";
import { sign } from "node:crypto";
import { createWorker, MAX_AGE_MS, MAX_BYTES, SnapshotStore, teamOf, type Env, type Stored } from "./src/worker";

const noWait = async () => {};
// The "--made-at <time> --approve <digest>" a dry run with --key prints.
const approvalOf = (out: string): string[] => {
  const m = out.match(/add: (--made-at \S+ --approve [0-9a-f]{64})/);
  if (!m) throw new Error("no approval line in the dry run's output");
  return m[1].split(" ");
};
// Made-up values only.
const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-example-0001";
const OWNER = "owner@example.com";
const CLIENT_ID = "client-id-example.access";
const PUBLISHER = "publisher-value-example";
const NOW = Date.parse("2026-11-18T12:00:00Z");

// The Durable Object, in memory: one SnapshotStore per name, its storage a Map, and
// blockConcurrencyWhile a real lock (events wait their turn), as the runtime gives it.
type Storage = { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> };
function memoryStore(over: Partial<Storage> = {}, delay = async () => {}) {
  const maps = new Map<string, Map<string, unknown>>();
  const objects = new Map<string, SnapshotStore>();
  const mapOf = (name: string) => (maps.has(name) ? maps.get(name)! : (maps.set(name, new Map()), maps.get(name)!));
  const objectOf = (name: string) => {
    if (!objects.has(name)) {
      const m = mapOf(name);
      let chain: Promise<unknown> = Promise.resolve();
      const storage: Storage = {
        get: async (k) => (await delay(), m.get(k)),
        put: async (k, v) => (await delay(), void m.set(k, structuredClone(v))),
        ...over,
      };
      const state = {
        storage,
        blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> {
          const run = chain.then(f, f);
          chain = run.catch(() => {});
          return run;
        },
      };
      objects.set(name, new SnapshotStore(state));
    }
    return objects.get(name)!;
  };
  const ns = { idFromName: (n: string) => n, get: (id: unknown) => ({ fetch: (r: Request) => objectOf(String(id)).fetch(r) }) };
  return { ns, raw: (name = "latest") => mapOf(name), held: (name = "latest") => mapOf(name).get("latest") as Stored | undefined };
}

const keys = makeKeyPair();
const FIX = join(import.meta.dir, "..", "export", "fixtures");
const policy = makePolicy(readFileSync(join(FIX, "private-terms.txt"), "utf8"), { owner_names: ["Robin"] });
const snap = (when: string, k = keys, revision: { seq: number; commit: string } | null = null) =>
  signSnapshot(buildSnapshot(join(FIX, "record"), policy, new Date(when), revision).snapshot, privateKey(k.privatePem), policy);
// A response's JSON body, untyped fields read as unknown.
const bodyOf = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
function env(over: Partial<Storage> = {}, delay?: () => Promise<void>): Env & { store: ReturnType<typeof memoryStore> } {
  const store = memoryStore(over, delay);
  return { ...envBase(), STORE: store.ns, store };
}
const envBase = () => ({
  SNAPSHOT_PUBLIC_KEYS: keys.publicEntry,
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
    expect(e.store.held()).toBeUndefined();
  });

  test("tampered counts are refused", async () => {
    const s = { ...snap("2026-11-18T12:00:00Z"), excluded_rows: 0 };
    expect((await worker.fetch(await put(s), env())).status).toBe(403);
  });

  test("a snapshot signed by another key is refused", async () => {
    const other = makeKeyPair();
    const s = snap(new Date(NOW).toISOString(), other);
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
    expect((await bodyOf(res)).error).toMatch(/5 minutes ahead/);
    expect(e.store.held()).toBeUndefined();
    expect((await worker.fetch(await put(snap("2026-11-18T12:04:00Z")), e)).status).toBe(200);
  });

  test("a field outside the signed ones is refused, and nothing is stored", async () => {
    const e = env();
    const s = { ...snap("2026-11-18T12:00:00Z"), extra: "not signed" };
    expect((await worker.fetch(await put(s), e)).status).toBe(403);
    expect(e.store.held()).toBeUndefined();
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
    const e = { ...env(), SNAPSHOT_PUBLIC_KEYS: "REPLACE_WITH_PUBLIC_KEY_BASE64" };
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
  const broken = (over: Partial<Storage>) => env(over);
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
    e.store.raw().set("latest", "{garbled");
    for (const r of [await get(), await put(snap("2026-11-18T12:00:00Z"))]) {
      const res = await worker.fetch(r, e);
      expect(res.status).toBe(503);
      expect((await bodyOf(res)).error).toMatch(/set the Worker variable STORE_NAME to a new name/);
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
        expect((await bodyOf(res)).error).toContain(name);
      }
    }
    const res = await worker.fetch(await get(), { ...env(), OWNER_EMAIL: "", ACCESS_AUD: "" });
    expect((await bodyOf(res)).error).toMatch(/ACCESS_AUD, OWNER_EMAIL are blank/);
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

describe("the entry module", () => {
  test("exports only the fetch handler and the Durable Object class, as workerd requires", async () => {
    const entry = await import("./src/index");
    expect(Object.keys(entry).sort()).toEqual(["SnapshotStore", "default"]);
    expect(typeof entry.default.fetch).toBe("function");
  });
});

describe("wrangler.toml", () => {
  test("has workers_dev and preview_urls false", () => {
    expect(wranglerProblems(readFileSync(join(import.meta.dir, "wrangler.toml"), "utf8"))).toEqual([]);
  });
  const DO = '[[durable_objects.bindings]]\nname = "STORE"\nclass_name = "SnapshotStore"\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["SnapshotStore"]\n';
  test("the check fails if either is missing or true", () => {
    expect(wranglerProblems('name = "x"\nworkers_dev = false\n' + DO)).toEqual(["preview_urls is missing (it must be false)"]);
    expect(wranglerProblems('workers_dev = true\npreview_urls = false\n' + DO)).toEqual(["workers_dev is true (it must be false)"]);
    expect(wranglerProblems('workers_dev = false\npreview_urls = false\n' + DO + '[env.dev]\nworkers_dev = true\n')).toEqual([
      "env.dev.workers_dev is true (it must be false)",
    ]);
  });
  test("the check fails without the Durable Object, or with a KV namespace", () => {
    const flags = "workers_dev = false\npreview_urls = false\n";
    expect(wranglerProblems(flags)).toEqual([
      "the Durable Object binding STORE to SnapshotStore is missing",
      "no migration creates the SnapshotStore class",
    ]);
    expect(wranglerProblems(flags + '[[kv_namespaces]]\nbinding = "SNAPSHOTS"\nid = "x"\n' + DO)).toEqual([
      "a KV namespace is configured; the store is the Durable Object",
    ]);
  });
});

describe("Access on PUT", () => {
  const s = () => snap("2026-11-18T12:00:00Z");
  test("the owner's own assertion can't upload", async () => {
    expect((await worker.fetch(await put(s(), { "cf-access-jwt-assertion": await ownerJwt() }), env())).status).toBe(403);
  });
  test("the client id in common_name or in sub uploads; neither a string is refused", async () => {
    const withSub = await put(s(), { "cf-access-jwt-assertion": await serviceJwt({ common_name: undefined, sub: CLIENT_ID }) });
    expect((await worker.fetch(withSub, env())).status).toBe(200);
    const withName = await put(s(), { "cf-access-jwt-assertion": await serviceJwt({ common_name: CLIENT_ID, sub: "" }) });
    expect((await worker.fetch(withName, env())).status).toBe(200);
    const wrongSub = await put(s(), { "cf-access-jwt-assertion": await serviceJwt({ common_name: undefined, sub: "other.access" }) });
    expect((await worker.fetch(wrongSub, env())).status).toBe(403);
    for (const odd of [{ common_name: undefined, sub: undefined }, { common_name: 7, sub: ["x"] }, { common_name: null, sub: {} }]) {
      const e = env();
      const r = await put(s(), { "cf-access-jwt-assertion": await serviceJwt(odd) });
      expect((await worker.fetch(r, e)).status).toBe(403);
      expect(e.store.held()).toBeUndefined();
    }
    // The publisher header is still required with the id in sub.
    const r = await put(s(), { "cf-access-jwt-assertion": await serviceJwt({ common_name: undefined, sub: CLIENT_ID }), "x-surface-publisher": "wrong" });
    expect((await worker.fetch(r, env())).status).toBe(403);
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
    expect(e.store.held()).toBeUndefined();
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
    "| P2 | Pick the reminder time. | Robin | Choose a time. | Robin's pick | The reminder fires. | 2026-11-02 |",
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
  const workerEnv = () => ({ ...env(), SNAPSHOT_PUBLIC_KEYS: readFileSync(join(dir, "surface.pub.entry"), "utf8").trim() });
  // The approval flags a dry run with the key prints for exactly these bytes (seventh round).
  const approval = async (r = run, extra: string[] = []) => approvalOf((await capture(() => exporter([...r, "--dry-run", "--key", keyFile, ...extra]))).out);

  test("a signed snapshot is stored: 200, exit 0, the status and the Worker's message printed", async () => {
    const e = workerEnv();
    const h = harness(e);
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(0);
    expect(out).toMatch(/PUT https:\/\/surface\.example\.com\/snapshot: 200 stored /);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].headers.get("x-surface-publisher")).toBe(PUBLISHER);
    const stored = e.store.held()!.snapshot;
    expect((stored.threads as unknown[]).length).toBeGreaterThan(0);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(PUBLISHER);
  });

  test("a refusal is exit 1 with the Worker's message", async () => {
    const e = workerEnv();
    const h = harness(e);
    const env2 = { ...putEnv, SURFACE_PUBLISHER_TOKEN: "wrong" };
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: env2 }));
    expect(code).toBe(1);
    expect(out).toContain("403 the publisher header is missing or wrong");
    expect(e.store.held()).toBeUndefined();
  });

  test("Access refusing the token is exit 1", async () => {
    const h = harness(workerEnv());
    const env2 = { ...putEnv, SURFACE_ACCESS_CLIENT_SECRET: "wrong" };
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: env2 }));
    expect(code).toBe(1);
    expect(out).toContain(": 403");
    // Only the Worker's JSON message is ever printed, never another body.
    expect(out).not.toContain("Forbidden");
  });

  test("the fixture record, with its malformed rows and leftovers, is refused under --put before any request", async () => {
    const h = harness(workerEnv());
    const fixtureRun = ["--record", join(FIX, "record"), ...run.slice(2)];
    const { code } = await capture(async () => exporter([...fixtureRun, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(h.calls.length).toBe(0);
  });

  test("a failed upload leaves an existing --out file as it was", async () => {
    const out = join(dir, "kept.json");
    writeFileSync(out, "the earlier file\n");
    for (const f of [
      async () => new Response(JSON.stringify({ error: "no" }), { status: 400 }),
      async () => new Response(JSON.stringify({ error: "no" }), { status: 500 }),
      async () => {
        throw new Error("connection refused");
      },
    ]) {
      const r = await capture(async () => exporter([...run, "--key", keyFile, "--out", out, "--put", URL_, ...(await approval())], { fetch: f, env: putEnv, sleep: noWait }));
      expect(r.code).not.toBe(0);
      expect(readFileSync(out, "utf8")).toBe("the earlier file\n");
    }
    // A stored upload writes it.
    const h = harness(workerEnv());
    expect((await capture(async () => exporter([...run, "--key", keyFile, "--out", out, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: putEnv }))).code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).sig).toBeString();
  });

  test("an older snapshot is 409, exit 1", async () => {
    const e = workerEnv();
    const kid = readFileSync(join(dir, "surface.pub.entry"), "utf8").split(":")[0];
    e.store.raw().set("latest", { id: "f".repeat(64), made_at: "2999-01-01T00:00:00.000Z", received_at: "2026-11-18T12:00:00.000Z", key_id: kid, revision: null, snapshot: {} });
    const h = harness(e);
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain("409 older than the stored snapshot");
  });

  test("a missing variable is exit 2 before any request", async () => {
    for (const name of Object.keys(putEnv)) {
      const h = harness(workerEnv());
      const env2: Record<string, string | undefined> = { ...putEnv, [name]: undefined };
      const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: h.fetch, env: env2 }));
      expect(code).toBe(2);
      expect(out).toContain(name);
      expect(h.calls.length).toBe(0);
    }
  });

  test("no answer at all is an unknown remote outcome: exit 3, after reconciling", async () => {
    let tries = 0;
    const { code, out } = await capture(async () =>
      exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], {
        fetch: async () => {
          tries++;
          throw new Error("connection refused");
        },
        env: putEnv,
        sleep: noWait,
      }),
    );
    expect(code).toBe(3);
    expect(tries).toBe(3);
    expect(out).toContain("no answer");
    expect(out).toContain("upload: unknown remote outcome");
  });

  test("the URL must be https, on SURFACE_PUT_HOST, exactly /snapshot, with no credentials, query or fragment: else exit 2 before any request", async () => {
    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      ["http://surface.example.com/snapshot", putEnv, /must be https/],
      ["https://elsewhere.example.com/snapshot", putEnv, /host is not SURFACE_PUT_HOST/],
      ["https://user:pw@surface.example.com/snapshot", putEnv, /credentials/],
      [URL_, { ...putEnv, SURFACE_PUT_HOST: undefined }, /SURFACE_PUT_HOST/],
      ["not a url", putEnv, /not a URL/],
      ["https://surface.example.com/other", putEnv, /path must be exactly \/snapshot/],
      ["https://surface.example.com/snapshot/", putEnv, /path must be exactly \/snapshot/],
      ["https://surface.example.com/", putEnv, /path must be exactly \/snapshot/],
      ["https://surface.example.com/snapshot?x=1", putEnv, /query string or fragment/],
      ["https://surface.example.com/snapshot?", putEnv, /query string or fragment/],
      ["https://surface.example.com/snapshot#a", putEnv, /query string or fragment/],
      ["https://surface.example.com/snapshot#", putEnv, /query string or fragment/],
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
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: r.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain(REDIRECTED);
    expect(r.calls.length).toBe(1);
    expect(r.calls.some((c) => c.url.includes("elsewhere"))).toBe(false);
    for (const v of [ID, SECRET, PUBLISHER]) expect(out).not.toContain(v);
  });

  test("a redirect from the first host to itself (an Access login) is refused likewise", async () => {
    const r = redirecting("https://surface.example.com/cdn-cgi/access/login?x=1");
    const { code, out } = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: r.fetch, env: putEnv }));
    expect(code).toBe(1);
    expect(out).toContain("Access redirected: the service token or its Service Auth policy is wrong");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].url).toBe(URL_);
  });

  test("the printed message is the Worker's JSON message only, at most 200 characters", async () => {
    const long = "x".repeat(500);
    const f = async () => new Response(JSON.stringify({ error: long, extra: "not printed" }), { status: 400 });
    // (a 4xx: a server rejection, no reconciling)
    const r1 = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: f, env: putEnv }));
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("x".repeat(200));
    expect(r1.out).not.toContain("x".repeat(201));
    expect(r1.out).not.toContain("not printed");
    const html = async () => new Response("<html>secret-ish page</html>", { status: 502 });
    const r2 = await capture(async () => exporter([...run, "--key", keyFile, "--put", URL_, ...(await approval())], { fetch: html, env: putEnv, sleep: noWait }));
    expect(r2.code).toBe(3);
    expect(r2.out).not.toContain("secret-ish");
  });

  test("--put with no url, or with --dry-run, is exit 2", async () => {
    const h = harness(workerEnv());
    expect((await capture(() => exporter([...run, "--key", keyFile, "--put"], { fetch: h.fetch, env: putEnv }))).code).toBe(2);
    expect((await capture(async () => exporter([...run, "--dry-run", "--put", URL_, ...(await approval())], { fetch: h.fetch, env: putEnv }))).code).toBe(2);
    expect(h.calls.length).toBe(0);
  });
});

describe("sixth round: the Durable Object compares and writes atomically", () => {
  test("concurrent PUTs, newer and older, interleaved at every storage step: the newer is held, the older gets 409", async () => {
    // Each storage call yields several times, so without the lock the older's read could pass
    // before the newer's write lands.
    const yieldMany = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    for (const order of [0, 1]) {
      const e = env({}, yieldMany);
      const newer = snap("2026-11-18T12:00:00Z");
      const older = snap("2026-11-18T11:00:00Z");
      const reqs = order ? [put(older), put(newer)] : [put(newer), put(older)];
      const res = await Promise.all((await Promise.all(reqs)).map((r) => worker.fetch(r, e)));
      expect(e.store.held()!.made_at).toBe(newer.made_at);
      const statuses = res.map((r) => r.status);
      // The older lands first and is replaced, or comes second and is refused: never held.
      if (order === 0) expect(statuses).toEqual([200, 409]);
      else expect(statuses).toEqual([200, 200]);
    }
  });
  test("the same snapshot again is 200 naming the same identity, and nothing is rewritten", async () => {
    const e = env();
    const s = snap("2026-11-18T12:00:00Z");
    const first = await bodyOf(await worker.fetch(await put(s), e));
    const real = e.store.raw();
    const before = real.get("latest");
    const second = await bodyOf(await worker.fetch(await put(s), e));
    expect(second.id).toBe(first.id);
    expect(second.already).toBe(true);
    expect(real.get("latest")).toBe(before);
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.id).toBe(await snapshotId(s));
  });
  test("a 409 names the identity held", async () => {
    const e = env();
    const a = await bodyOf(await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), e));
    const res = await worker.fetch(await put(snap("2026-11-18T11:00:00Z")), e);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).id).toBe(a.id);
  });
  test("STORE_NAME starts an empty store: the recovery for a wedged one", async () => {
    const e = env();
    e.store.raw().set("latest", "{garbled");
    expect((await worker.fetch(await get(), e)).status).toBe(503);
    const fresh = { ...e, STORE_NAME: "latest-2" };
    expect((await worker.fetch(await get(), fresh)).status).toBe(404);
    expect((await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), fresh)).status).toBe(200);
    expect((await worker.fetch(await get(), fresh)).status).toBe(200);
  });
});

describe("sixth round: key match and rotation", () => {
  const next = makeKeyPair();
  const snapWith = (k: typeof next, when: string) => snap(when, k);
  test("a snapshot verifies under the listed key its key_id names, in any order", async () => {
    for (const list of [`${keys.publicEntry},${next.publicEntry}`, `${next.publicEntry}, ${keys.publicEntry}`]) {
      const e = { ...env(), SNAPSHOT_PUBLIC_KEYS: list };
      expect((await worker.fetch(await put(snapWith(keys, "2026-11-18T11:00:00Z")), e)).status).toBe(200);
      expect((await worker.fetch(await put(snapWith(next, "2026-11-18T12:00:00Z")), e)).status).toBe(200);
    }
  });
  test("the rotation: add the new key, switch the exporter, retire the old; the old key is then refused", async () => {
    const e = env();
    // 1. Only the old key.
    expect((await worker.fetch(await put(snapWith(keys, "2026-11-18T10:00:00Z")), e)).status).toBe(200);
    expect((await worker.fetch(await put(snapWith(next, "2026-11-18T10:30:00Z")), e)).status).toBe(403);
    // 2. Both listed: the exporter switches to the new key.
    const both = { ...e, SNAPSHOT_PUBLIC_KEYS: `${keys.publicEntry},${next.publicEntry}` };
    expect((await worker.fetch(await put(snapWith(next, "2026-11-18T11:00:00Z")), both)).status).toBe(200);
    // 3. The old one retired (or removed): an upload signed by it is refused.
    for (const list of [`${keys.publicEntry}:retired,${next.publicEntry}`, next.publicEntry]) {
      const after = { ...e, SNAPSHOT_PUBLIC_KEYS: list };
      const res = await worker.fetch(await put(snapWith(keys, "2026-11-18T12:00:00Z")), after);
      expect(res.status).toBe(403);
      if (list.includes("retired")) expect((await bodyOf(res)).error).toBe("signed by a retired key");
    }
    expect((await worker.fetch(await put(snapWith(next, "2026-11-18T12:00:00Z")), { ...e, SNAPSHOT_PUBLIC_KEYS: next.publicEntry })).status).toBe(200);
  });
  test("a list with a mistake in it is no list: a bare key, an id that isn't its key's, a duplicate, garbage", async () => {
    const [id, raw] = keys.publicEntry.split(":");
    for (const list of ["nonsense, ,REPLACE_WITH_PUBLIC_KEY_BASE64", keys.publicRaw, `${"0".repeat(16)}:${raw}`, `${keys.publicEntry},${keys.publicEntry}`, `${keys.publicEntry},x`, `${id}:${raw}:old`, ""]) {
      const res = await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), { ...env(), SNAPSHOT_PUBLIC_KEYS: list });
      expect([list, res.status]).toEqual([list, 500]);
    }
    // Every key retired: no active key.
    const res = await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), { ...env(), SNAPSHOT_PUBLIC_KEYS: `${keys.publicEntry}:retired` });
    expect(res.status).toBe(500);
  });
  test("an unknown version, app or purpose is refused even with a good key", async () => {
    for (const over of [{ version: 1 }, { app: "x" }, { purpose: "command" }]) {
      const res = await worker.fetch(await put({ ...snap("2026-11-18T12:00:00Z"), ...over }), env());
      expect([over, res.status]).toEqual([over, 403]);
    }
  });
});

describe("seventh round: the store's ordering", () => {
  const thief = makeKeyPair();
  const kidOf = (k: typeof thief) => k.publicEntry.split(":")[0];
  const commit = (c: string) => c.repeat(40);
  // A value the store holds, as the Worker writes it.
  const heldAs = (over: Partial<Stored>): Stored => ({
    id: "e".repeat(64),
    made_at: "2026-11-18T11:00:00.000Z",
    received_at: "2026-11-18T11:00:01.000Z",
    key_id: kidOf(keys),
    revision: null,
    snapshot: { held: true },
    ...over,
  });
  test("a retired key wrote a far-future snapshot; a valid key then succeeds", async () => {
    const e = { ...env(), SNAPSHOT_PUBLIC_KEYS: `${thief.publicEntry},${keys.publicEntry}` };
    // While the stolen key is still active, its snapshot dated far ahead (from before the bound, or a
    // skewed Worker clock) and with a far-ahead revision holds the store: a valid key's newer one is 409.
    e.store.raw().set("latest", heldAs({ key_id: kidOf(thief), made_at: "2999-01-01T00:00:00.000Z", revision: { seq: 999_999_999, commit: commit("a") } }));
    expect((await worker.fetch(await put(snap("2026-11-18T12:00:00Z")), e)).status).toBe(409);
    // Its key retired: any valid snapshot replaces it, whatever its made_at or revision.
    const retired = { ...e, SNAPSHOT_PUBLIC_KEYS: `${thief.publicEntry}:retired,${keys.publicEntry}` };
    const res = await worker.fetch(await put(snap("2026-11-18T11:30:00Z")), retired);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).replaced_retired).toBe(true);
    expect(e.store.held()!.made_at).toBe("2026-11-18T11:30:00.000Z");
    // And the stolen key's own uploads are refused.
    expect((await worker.fetch(await put(snap("2026-11-18T12:01:00Z", thief)), retired)).status).toBe(403);
  });
  test("a held snapshot signed by a key no longer listed at all is replaced the same way", async () => {
    const e = env();
    e.store.raw().set("latest", heldAs({ key_id: kidOf(thief), made_at: "2999-01-01T00:00:00.000Z" }));
    expect((await worker.fetch(await put(snap("2026-11-18T11:00:00Z")), e)).status).toBe(200);
  });
  test("a skewed-future made_at is refused, and so is one older than the maximum age", async () => {
    const e = env();
    for (const when of ["2026-11-18T12:05:01Z", "2027-01-01T00:00:00Z"]) {
      const res = await worker.fetch(await put(snap(when)), e);
      expect([when, res.status]).toEqual([when, 400]);
    }
    const old = new Date(NOW - MAX_AGE_MS - 60_000).toISOString();
    const res = await worker.fetch(await put(snap(old)), e);
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/more than 24 hours old/);
    expect(e.store.held()).toBeUndefined();
    expect((await worker.fetch(await put(snap(new Date(NOW - MAX_AGE_MS + 60_000).toISOString())), e)).status).toBe(200);
  });
  test("the server's receipt time is stored beside the snapshot", async () => {
    const e = env();
    const res = await worker.fetch(await put(snap("2026-11-18T11:59:00Z")), e);
    expect((await bodyOf(res)).received_at).toBe(new Date(NOW).toISOString());
    expect(e.store.held()!.received_at).toBe(new Date(NOW).toISOString());
    expect(e.store.held()!.key_id).toBe(kidOf(keys));
    // GET returns the signed snapshot only, not the receipt.
    expect(Object.keys(await bodyOf(await worker.fetch(await get(), e)))).not.toContain("received_at");
  });
  test("the record revision is the precondition: newest revision wins, whatever made_at says", async () => {
    const e = env();
    expect((await worker.fetch(await put(snap("2026-11-18T11:00:00Z", keys, { seq: 5, commit: commit("b") })), e)).status).toBe(200);
    // A lower revision, though newer by made_at: 409.
    const lower = await worker.fetch(await put(snap("2026-11-18T11:30:00Z", keys, { seq: 4, commit: commit("c") })), e);
    expect(lower.status).toBe(409);
    expect((await bodyOf(lower)).error).toMatch(/older record revision/);
    // Another commit at the same revision: 409.
    const other = await worker.fetch(await put(snap("2026-11-18T11:30:00Z", keys, { seq: 5, commit: commit("d") })), e);
    expect(other.status).toBe(409);
    expect((await bodyOf(other)).error).toMatch(/another commit/);
    // A higher revision, though older by made_at: stored.
    expect((await worker.fetch(await put(snap("2026-11-18T10:00:00Z", keys, { seq: 6, commit: commit("e") })), e)).status).toBe(200);
    // The same commit again: made_at decides.
    expect((await worker.fetch(await put(snap("2026-11-18T09:00:00Z", keys, { seq: 6, commit: commit("e") })), e)).status).toBe(409);
    expect((await worker.fetch(await put(snap("2026-11-18T11:45:00Z", keys, { seq: 6, commit: commit("e") })), e)).status).toBe(200);
    // Without a revision on either side, made_at decides.
    expect((await worker.fetch(await put(snap("2026-11-18T11:40:00Z")), e)).status).toBe(409);
  });
  test("version 1 is refused: a version 1 blob, validly signed in its own form, replayed", async () => {
    // Version 1's signed bytes: {version, made_at, threads, excluded_rows, skipped_rows}, no app,
    // purpose or key id inside them.
    const v2 = snap("2026-11-18T12:00:00Z");
    const v1Signed = { version: 1, made_at: v2.made_at, threads: v2.threads, excluded_rows: v2.excluded_rows, skipped_rows: v2.skipped_rows };
    const sig = toBase64(new Uint8Array(sign(null, new TextEncoder().encode(canonical(v1Signed)), privateKey(keys.privatePem))));
    const v1 = { ...v1Signed, sig, key_id: v2.key_id };
    const e = env();
    const res = await worker.fetch(await put(v1), e);
    expect(res.status).toBe(403);
    expect(e.store.held()).toBeUndefined();
    // The same blob dressed as version 2 doesn't verify either: the signed bytes differ.
    const dressed = { ...v1, version: 2, app: v2.app, purpose: v2.purpose, revision: null };
    expect((await worker.fetch(await put(dressed), e)).status).toBe(403);
    expect(signedBytes(v2).length).toBeGreaterThan(0);
  });
  test("an older version 2 blob replayed is 409 naming the identity held", async () => {
    const e = env();
    const older = snap("2026-11-18T11:00:00Z");
    const newer = snap("2026-11-18T11:30:00Z");
    expect((await worker.fetch(await put(older), e)).status).toBe(200);
    expect((await worker.fetch(await put(newer), e)).status).toBe(200);
    const res = await worker.fetch(await put(older), e);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).id).toBe(await snapshotId(newer));
    expect(e.store.held()!.id).toBe(await snapshotId(newer));
  });
});

describe("sixth round: the synthetic deployment, a lost response reconciled", () => {
  // The synthetic record (export/fixtures/synthetic), uploaded through Access to this Worker in-process,
  // with the response lost on the way back after the Worker stored it.
  const ID = "service-token-id-example";
  const SECRET = "service-token-secret-example";
  const putEnv = {
    SURFACE_PUT_HOST: "surface.example.com",
    SURFACE_ACCESS_CLIENT_ID: ID,
    SURFACE_ACCESS_CLIENT_SECRET: SECRET,
    SURFACE_PUBLISHER_TOKEN: PUBLISHER,
  };
  const URL_ = "https://surface.example.com/snapshot";
  const dir = mkdtempSync(join(tmpdir(), "surface-lost-"));
  const run = [
    "--record", join(FIX, "synthetic"), "--private-terms", join(FIX, "private-terms.txt"), "--config", join(FIX, "exporter.json"),
    "--key", join(dir, "surface.key"), "--put", URL_,
  ];
  const live = createWorker({ now: () => Date.now(), fetch: deps.fetch });
  const quiet = async (f: () => Promise<number>) => {
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
  // Access in front of the Worker; `lose` says which tries lose their response after the Worker answered.
  function via(e: Env, lose: (n: number) => boolean) {
    let n = 0;
    const statuses: number[] = [];
    const f = async (url: string, init: RequestInit) => {
      const i = n++;
      const h = new Headers(init.headers);
      if (h.get("cf-access-client-id") !== ID || h.get("cf-access-client-secret") !== SECRET) return new Response("Forbidden", { status: 403 });
      h.delete("cf-access-client-id");
      h.delete("cf-access-client-secret");
      h.set("cf-access-jwt-assertion", await serviceJwt({ exp: Date.now() / 1000 + 3600 }));
      const res = await live.fetch(new Request(url, { method: init.method, body: init.body, headers: h }), e);
      statuses.push(res.status);
      if (lose(i)) throw new Error("the connection reset after the request was sent");
      return res;
    };
    return { fetch: f, statuses, tries: () => n };
  }
  beforeAll(async () => {
    await quiet(() => exporter(["--keygen", dir]));
  });
  const workerEnv = () => ({ ...env(), SNAPSHOT_PUBLIC_KEYS: readFileSync(join(dir, "surface.pub.entry"), "utf8").trim() });
  // The dry run's approval flags for the synthetic record, then the --put run with them.
  const dryRun = run.slice(0, run.indexOf("--key"));
  const approved = async (extra: string[] = []) =>
    [...run, ...approvalOf((await quiet(() => exporter([...dryRun, "--dry-run", "--key", join(dir, "surface.key"), ...extra]))).out)];

  test("the first response is lost; the second try finds the same identity held: stored, exit 0", async () => {
    const e = workerEnv();
    const v = via(e, (i) => i === 0);
    const r = await quiet(async () => exporter(await approved(), { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(r.code).toBe(0);
    expect(v.tries()).toBe(2);
    expect(v.statuses).toEqual([200, 200]);
    expect(r.out).toContain("reconciling");
    const held = e.store.held()!;
    expect(r.out).toContain(`(snapshot ${held.id})`);
    expect((held.snapshot.threads as { id: string }[]).map((t) => t.id)).toEqual(["S1", "S2"]);
  });
  test("every response lost: an unknown remote outcome, exit 3, though the Worker holds it", async () => {
    const e = workerEnv();
    const v = via(e, () => true);
    const out = join(dir, "never.json");
    const r = await quiet(async () => exporter([...(await approved()), "--out", out], { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(r.code).toBe(3);
    expect(r.out).toContain("upload: unknown remote outcome");
    expect(existsSync(out)).toBe(false);
    expect(e.store.held()).toBeDefined();
  });
  test("a server rejection is exit 1 with no reconciling; a preflight rejection is exit 2 with nothing sent", async () => {
    const e = workerEnv();
    const v = via(e, () => false);
    const r = await quiet(async () => exporter(await approved(), { fetch: v.fetch, env: { ...putEnv, SURFACE_PUBLISHER_TOKEN: "wrong" }, sleep: noWait }));
    expect(r.code).toBe(1);
    expect(v.tries()).toBe(1);
    expect(r.out).toContain("upload: server rejection");
    const p = await quiet(async () => exporter(await approved(), { fetch: v.fetch, env: { ...putEnv, SURFACE_PUT_HOST: "other.example.com" }, sleep: noWait }));
    expect(p.code).toBe(2);
    expect(p.out).toContain("upload: preflight rejection, nothing sent");
    expect(v.tries()).toBe(1);
  });
  test("a 2xx that names another snapshot is not taken as stored", async () => {
    const f = async () => new Response(JSON.stringify({ stored: "x", id: "0".repeat(32) }), { status: 200 });
    const r = await quiet(async () => exporter(await approved(), { fetch: f, env: putEnv, sleep: noWait }));
    expect(r.code).toBe(3);
  });
  test("seventh round: a lost response, then a newer write: the reconciling try is refused and reports so", async () => {
    // The first run's first try is stored with its response lost; then a newer snapshot lands; the
    // retry of the first run's same bytes gets 409 naming the newer identity: exit 1, not stored.
    const e = workerEnv();
    const first = await approved();
    const later = await approved(["--made-at", new Date(Date.now() + 2000).toISOString()]);
    let landed = false;
    let n = 0;
    const v = via(e, () => false);
    const f = async (url: string, init: RequestInit) => {
      const res = await v.fetch(url, init);
      if (n++ === 0) {
        // Lost on the way back; meanwhile the later run stores its newer snapshot.
        const l = await quiet(() => exporter(later, { fetch: via(e, () => false).fetch, env: putEnv, sleep: noWait }));
        landed = l.code === 0;
        throw new Error("the connection reset after the request was sent");
      }
      return res;
    };
    const r = await quiet(() => exporter(first, { fetch: f, env: putEnv, sleep: noWait }));
    expect(landed).toBe(true);
    expect(r.code).toBe(1);
    expect(r.out).toContain("409 older than the stored snapshot");
    expect(r.out).toContain("upload: server rejection");
  });
  test("seventh round: --put needs the dry run's approval: missing, malformed or for other bytes is exit 2 with nothing sent", async () => {
    const e = workerEnv();
    const v = via(e, () => false);
    const bare = run;
    const a = await quiet(() => exporter(bare, { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(a.code).toBe(2);
    expect(a.out).toMatch(/--put needs --made-at <time> and --approve <digest>/);
    const flags = approvalOf((await quiet(() => exporter([...dryRun, "--dry-run", "--key", join(dir, "surface.key")]))).out);
    const wrong = [...run, flags[0], flags[1], "--approve", "0".repeat(64)];
    const b = await quiet(() => exporter(wrong, { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(b.code).toBe(2);
    expect(b.out).toMatch(/not the ones approved/);
    // The approved digest with another time: other bytes.
    const otherTime = [...run, "--made-at", new Date(Date.parse(flags[1]) + 1000).toISOString(), flags[2], flags[3]];
    const c = await quiet(() => exporter(otherTime, { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(c.code).toBe(2);
    expect(v.tries()).toBe(0);
    // The digest is the snapshot's identity: the one the Worker then holds.
    const ok = await quiet(() => exporter([...run, ...flags], { fetch: v.fetch, env: putEnv, sleep: noWait }));
    expect(ok.code).toBe(0);
    expect(e.store.held()!.id).toBe(flags[3]);
  });
});
