import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSnapshot, makeKeyPair, privateKey, signSnapshot } from "../export/lib";
import worker, { type Env } from "./src/index";

function memoryKV() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), m };
}

const keys = makeKeyPair();
const RECORD = join(import.meta.dir, "..", "export", "fixtures", "record");
const snap = (when: string) => signSnapshot(buildSnapshot(RECORD, new Date(when)), privateKey(keys.privatePem));
const env = (): Env & { SNAPSHOTS: ReturnType<typeof memoryKV> } => ({ SNAPSHOTS: memoryKV(), SNAPSHOT_PUBLIC_KEY: keys.publicRaw });
const req = (method: string, body?: unknown, path = "/snapshot") =>
  new Request("https://surface.example.com" + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

describe("the Worker", () => {
  test("GET before any PUT is 404", async () => {
    expect((await worker.fetch(req("GET"), env())).status).toBe(404);
  });

  test("PUT a signed snapshot, then GET returns it", async () => {
    const e = env();
    const s = snap("2026-11-18T12:00:00Z");
    expect((await worker.fetch(req("PUT", s), e)).status).toBe(200);
    const got = await (await worker.fetch(req("GET"), e)).json();
    expect(got).toEqual(s);
  });

  test("a tampered snapshot is refused and nothing is stored", async () => {
    const e = env();
    const s = snap("2026-11-18T12:00:00Z");
    s.threads[0].title = s.threads[0].title + "!";
    expect((await worker.fetch(req("PUT", s), e)).status).toBe(403);
    expect(e.SNAPSHOTS.m.size).toBe(0);
  });

  test("a snapshot signed by another key is refused", async () => {
    const other = makeKeyPair();
    const s = signSnapshot(buildSnapshot(RECORD), privateKey(other.privatePem));
    expect((await worker.fetch(req("PUT", s), env())).status).toBe(403);
  });

  test("an older snapshot doesn't replace a newer one", async () => {
    const e = env();
    await worker.fetch(req("PUT", snap("2026-11-18T12:00:00Z")), e);
    expect((await worker.fetch(req("PUT", snap("2026-11-18T11:00:00Z")), e)).status).toBe(409);
  });

  test("unsigned extra fields are not stored", async () => {
    const e = env();
    const s = { ...snap("2026-11-18T12:00:00Z"), extra: "not signed" };
    expect((await worker.fetch(req("PUT", s), e)).status).toBe(200);
    expect(JSON.parse(e.SNAPSHOTS.m.get("latest")!).extra).toBeUndefined();
  });

  test("no public key configured refuses", async () => {
    const e = { ...env(), SNAPSHOT_PUBLIC_KEY: "REPLACE_WITH_PUBLIC_KEY_BASE64" };
    expect((await worker.fetch(req("PUT", snap("2026-11-18T12:00:00Z")), e)).status).toBe(500);
  });

  test("not JSON, other paths and methods", async () => {
    const e = env();
    expect((await worker.fetch(new Request("https://x/snapshot", { method: "PUT", body: "{" }), e)).status).toBe(400);
    expect((await worker.fetch(req("GET", undefined, "/other"), e)).status).toBe(404);
    expect((await worker.fetch(req("DELETE"), e)).status).toBe(405);
  });
});
