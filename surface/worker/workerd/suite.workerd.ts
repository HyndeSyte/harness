// The Worker's suite under workerd, the runtime Cloudflare runs it on (surface/README.md, Tests):
// the Worker bundled as it deploys, run by Miniflare with a real SQLite-backed Durable Object bound as
// STORE, Access's certs served by an outbound stub. CI runs it before any deploy job, and the Pages
// and Worker deploy jobs need it.
// Run: cd surface/worker/workerd && bun install --frozen-lockfile && bun test ./suite.workerd.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";
import { Miniflare } from "miniflare";
import { buildSnapshot, makeKeyPair, makePolicy, privateKey, signSnapshot } from "../../export/lib";
import { canonical, toBase64 } from "../../shared/canonical";
import { snapshotId } from "../../shared/snapshot";

// Made-up values only.
const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-example-0001";
const OWNER = "owner@example.com";
const CLIENT_ID = "client-id-example.access";
const PUBLISHER = "publisher-value-example";
const HOST = "https://surface.example.com/snapshot";

const FIX = join(import.meta.dir, "..", "..", "export", "fixtures");
const policy = makePolicy(readFileSync(join(FIX, "private-terms.txt"), "utf8"), { owner_names: ["Robin"], names: [] });
const keys = makeKeyPair();
const thief = makeKeyPair();
type Pair = ReturnType<typeof makeKeyPair>;
// A snapshot of the fixture record signed by a key, made `ms` from now (workerd reads the real clock).
const snap = (ms: number, k: Pair = keys, revision: { seq: number; commit: string } | null = null) =>
  signSnapshot(buildSnapshot(join(FIX, "record"), policy, new Date(Date.now() + ms), revision).snapshot, privateKey(k.privatePem), policy);

let rsa: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
const b64u = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");
async function jwt(claims: Record<string, unknown>) {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "kid-1", typ: "JWT" }));
  const body = b64u(JSON.stringify({ aud: [AUD], iss: TEAM, exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(head + "." + body));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}

const persist = mkdtempSync(join(tmpdir(), "surface-workerd-"));
let script = "";
let mf: Miniflare;
// The Worker's settings as wrangler.toml and its secrets give them.
const bindings = (publicKeys: string) => ({
  SNAPSHOT_PUBLIC_KEYS: publicKeys,
  STORE_NAME: "latest",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  OWNER_EMAIL: OWNER,
  PUBLISHER_CLIENT_ID: CLIENT_ID,
  PUBLISHER_TOKEN: PUBLISHER,
});
const options = (publicKeys: string) => ({
  modules: [{ type: "ESModule" as const, path: "index.js", contents: script }],
  compatibilityDate: "2026-07-01",
  bindings: bindings(publicKeys),
  // The real binding: the SnapshotStore class, SQLite-backed, kept on disk across option changes.
  durableObjects: { STORE: { className: "SnapshotStore", useSQLite: true } },
  durableObjectsPersist: persist,
  // Access's signing keys; any other outbound request fails the test.
  outboundService: (req: Request) => {
    if (req.url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return new Response("no outbound requests in this suite", { status: 599 });
  },
});

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey), kid: "kid-1" };
  // The Worker bundled as one ES module, as wrangler deploys it.
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "index.ts")], target: "browser", format: "esm" });
  if (!built.success) throw new Error("the Worker did not bundle");
  script = await built.outputs[0].text();
  mf = new Miniflare(options(`${thief.publicEntry},${keys.publicEntry}`));
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(persist, { recursive: true, force: true });
});

const put = async (body: unknown) =>
  mf.dispatchFetch(HOST, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "cf-access-jwt-assertion": await jwt({ common_name: CLIENT_ID }), "x-surface-publisher": PUBLISHER },
  });
const get = async () => mf.dispatchFetch(HOST, { headers: { "cf-access-jwt-assertion": await jwt({ email: OWNER }) } });
const bodyOf = async (res: { json(): Promise<unknown> }) => (await res.json()) as Record<string, unknown>;
// A new runtime with these keys over the same persisted storage (STORE_NAME picks the object).
const fresh = async (storeName: string, publicKeys: string) => {
  await mf.dispose();
  mf = new Miniflare({ ...options(publicKeys), bindings: { ...bindings(publicKeys), STORE_NAME: storeName } });
  await mf.ready;
};

describe("the Worker under workerd, with a real Durable Object", () => {
  test("PUT a signed snapshot, then GET returns it, never cached", async () => {
    await fresh("basic", keys.publicEntry);
    expect((await get()).status).toBe(404);
    const s = snap(-60_000);
    const res = await put(s);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).id).toBe(await snapshotId(s));
    const g = await get();
    expect(g.headers.get("cache-control")).toBe("no-store");
    expect(await g.json()).toEqual(s);
  });

  test("a concurrent upload race: twenty PUTs at once, the newest is held, every older one stored first or refused", async () => {
    await fresh("race", keys.publicEntry);
    const snaps = Array.from({ length: 20 }, (_, i) => snap(-20 * 60_000 + i * 30_000));
    // Shuffled, then all sent together.
    const order = snaps.map((s, i) => ({ s, k: (i * 7) % 20 })).sort((a, b) => a.k - b.k).map((x) => x.s);
    const results = await Promise.all(order.map(async (s) => ({ s, status: (await put(s)).status })));
    const newest = snaps[snaps.length - 1];
    expect(results.find((r) => r.s === newest)!.status).toBe(200);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await (await get()).json()).toEqual(newest);
    // Again, the newest and an older one together, in both orders.
    for (const flip of [false, true]) {
      await fresh(`race-pair-${flip}`, keys.publicEntry);
      const older = snap(-120_000);
      const newer = snap(-60_000);
      await Promise.all((flip ? [older, newer] : [newer, older]).map(put));
      expect(await (await get()).json()).toEqual(newer);
    }
  }, 60_000);

  test("a skewed-future made_at is refused, and so is one older than 24 hours", async () => {
    await fresh("clock", keys.publicEntry);
    expect((await put(snap(6 * 60_000))).status).toBe(400);
    expect((await put(snap(-25 * 60 * 60_000))).status).toBe(400);
    expect((await get()).status).toBe(404);
  });

  test("a retired key wrote a far-ahead snapshot; a valid key then succeeds", async () => {
    // The stolen key, still listed, writes a snapshot with a far-ahead record revision: the valid
    // key's newer one is refused.
    await fresh("retired", `${thief.publicEntry},${keys.publicEntry}`);
    const far = { seq: 999_999_999, commit: "a".repeat(40) };
    expect((await put(snap(4 * 60_000, thief, far))).status).toBe(200);
    expect((await put(snap(0, keys, { seq: 10, commit: "b".repeat(40) }))).status).toBe(409);
    // Its key retired: the next valid upload replaces it whatever its made_at or revision, and the
    // stolen key's own uploads are refused.
    await fresh("retired", `${thief.publicEntry}:retired,${keys.publicEntry}`);
    const res = await put(snap(-60_000, keys, { seq: 10, commit: "b".repeat(40) }));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).replaced_retired).toBe(true);
    const t = await put(snap(4 * 60_000 + 30_000, thief, { seq: 999_999_999 + 1, commit: "c".repeat(40) }));
    expect(t.status).toBe(403);
    expect((await bodyOf(t)).error).toBe("signed by a retired key");
  });

  test("the same bytes again (a lost response reconciled) is 200 already; an older replay is 409 naming the held identity", async () => {
    await fresh("replay", keys.publicEntry);
    const older = snap(-120_000);
    const newer = snap(-60_000);
    expect((await put(older)).status).toBe(200);
    const again = await bodyOf(await put(older));
    expect(again.already).toBe(true);
    expect((await put(newer)).status).toBe(200);
    const replay = await put(older);
    expect(replay.status).toBe(409);
    expect((await bodyOf(replay)).id).toBe(await snapshotId(newer));
  });

  test("version 1 is refused", async () => {
    await fresh("v1", keys.publicEntry);
    const v2 = snap(-60_000);
    const v1Signed = { version: 1, made_at: v2.made_at, threads: v2.threads, excluded_rows: v2.excluded_rows, skipped_rows: v2.skipped_rows };
    const sig = toBase64(new Uint8Array(sign(null, new TextEncoder().encode(canonical(v1Signed)), privateKey(keys.privatePem))));
    expect((await put({ ...v1Signed, sig, key_id: v2.key_id })).status).toBe(403);
    expect((await get()).status).toBe(404);
  });

  test("Access is checked in the Worker: the owner's assertion can't upload, the publisher's can't read", async () => {
    await fresh("access", keys.publicEntry);
    const asOwner = await mf.dispatchFetch(HOST, {
      method: "PUT",
      body: JSON.stringify(snap(-60_000)),
      headers: { "cf-access-jwt-assertion": await jwt({ email: OWNER }), "x-surface-publisher": PUBLISHER },
    });
    expect(asOwner.status).toBe(403);
    const asPublisher = await mf.dispatchFetch(HOST, { headers: { "cf-access-jwt-assertion": await jwt({ common_name: CLIENT_ID }) } });
    expect(asPublisher.status).toBe(403);
    expect((await mf.dispatchFetch(HOST)).status).toBe(403);
  });
});
