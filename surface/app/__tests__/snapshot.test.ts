import { readFileSync } from "fs";
import { join } from "path";
import { canonical, signedBytes } from "../../shared/canonical";
import { check, loadSnapshot, sanitize, sortThreads, verify, type Thread } from "../src/snapshot";

// Signed by the exporter itself (fixtures/make.ts), so this checks the two implementations agree.
const raw = JSON.parse(readFileSync(join(__dirname, "fixtures/snapshot.json"), "utf8"));
const vector = JSON.parse(readFileSync(join(__dirname, "fixtures/vector.json"), "utf8"));
const pub = readFileSync(join(__dirname, "fixtures/snapshot.pub"), "utf8").trim();
const clone = () => JSON.parse(JSON.stringify(raw));
const fetchOf = (body: unknown, ok = true, over: Record<string, unknown> = {}) => async () => ({
  ok,
  status: ok ? 200 : 500,
  type: "basic",
  redirected: false,
  json: async () => body,
  ...over,
});

describe("the loader", () => {
  test("an exporter-signed snapshot verifies", () => {
    expect(verify(raw, pub)).toBe(true);
  });

  test("loads and passes, with the signed counts as items not shown", async () => {
    const loaded = await loadSnapshot("/snapshot", pub, fetchOf(raw));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.snapshot.threads.length).toBe(raw.threads.length);
      expect(loaded.snapshot.hidden).toBe(raw.excluded_rows + raw.skipped_rows);
    }
  });

  test("the signed counts can't be changed or left out", () => {
    expect(verify({ ...clone(), excluded_rows: 0 }, pub)).toBe(false);
    const s = clone();
    delete s.skipped_rows;
    expect(verify(s, pub)).toBe(false);
  });

  test("it reads the Worker's route without following redirects", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const spy = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return fetchOf(raw)();
    };
    await loadSnapshot("/snapshot", pub, spy);
    expect(seen.url).toBe("/snapshot");
    expect(seen.init?.redirect).toBe("manual");
    expect(seen.init?.credentials).toBe("same-origin");
  });

  test("one changed character fails", async () => {
    const s = clone();
    s.threads[0].step = s.threads[0].step.replace("B", "b");
    expect(await loadSnapshot("/s", pub, fetchOf(s))).toEqual({ ok: false, reason: "unverified" });
  });

  test("a changed made_at fails", () => {
    const s = clone();
    s.made_at = "2026-11-18T11:00:00.000Z";
    expect(check(s, pub).ok).toBe(false);
  });

  test("an unknown field added inside a thread fails, since it is signed", () => {
    const s = clone();
    s.threads[0].secret = "x";
    expect(verify(s, pub)).toBe(false);
  });

  test("no key, a wrong key, a missing signature", () => {
    expect(verify(raw, "")).toBe(false);
    expect(verify(raw, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")).toBe(false);
    const s = clone();
    delete s.sig;
    expect(verify(s, pub)).toBe(false);
  });

  test("a server error or bad JSON is unreadable", async () => {
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false))).toEqual({ ok: false, reason: "unreadable" });
    const broken = fetchOf(raw, true, { json: async () => { throw new Error("bad"); } });
    expect(await loadSnapshot("/s", pub, broken)).toEqual({ ok: false, reason: "unreadable" });
  });

  test("only an opaque redirect, a 3xx, a 401 or a redirect flag asks to sign in again", async () => {
    const signin = { ok: false, reason: "signin" };
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false, { type: "opaqueredirect", status: 0 }))).toEqual(signin);
    expect(await loadSnapshot("/s", pub, fetchOf(raw, true, { redirected: true }))).toEqual(signin);
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false, { status: 302 }))).toEqual(signin);
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false, { status: 307 }))).toEqual(signin);
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false, { status: 401 }))).toEqual(signin);
  });

  test("a fetch that throws without an HTTP answer is offline", async () => {
    for (const err of [new TypeError("Failed to fetch"), new Error("getaddrinfo ENOTFOUND"), new DOMException("timed out", "TimeoutError")]) {
      const thrown = async () => { throw err; };
      expect(await loadSnapshot("/s", pub, thrown)).toEqual({ ok: false, reason: "offline" });
    }
  });

  test("a 403 from the Worker itself, with its JSON message, is not allowed", async () => {
    const worker403 = fetchOf(null, false, { status: 403, json: async () => ({ error: "not the owner" }) });
    expect(await loadSnapshot("/s", pub, worker403)).toEqual({ ok: false, reason: "notallowed" });
    // A 403 without the Worker's message is not the Worker's: unreadable, never sign in.
    const html403 = fetchOf(null, false, { status: 403, json: async () => { throw new SyntaxError("not JSON"); } });
    expect(await loadSnapshot("/s", pub, html403)).toEqual({ ok: false, reason: "unreadable" });
    expect(await loadSnapshot("/s", pub, fetchOf({ other: 1 }, false, { status: 403 }))).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("unknown fields", () => {
  const base = {
    id: "P1", title: "t", area: "other", who: "the assistant", step: "s", waits_for: null,
    outcome: "o", last_moved: "2026-11-18T09:00:00Z", state: "moving",
  };
  test("are dropped from each thread and from the snapshot", () => {
    const s = sanitize({ made_at: "2026-11-18T10:00:00Z", threads: [{ ...base, note: "drop me", nested: { a: 1 } }] });
    expect(Object.keys(s.threads[0]).sort()).toEqual(Object.keys(base).sort());
    expect(Object.keys(s).sort()).toEqual(["hidden", "made_at", "threads"]);
    expect(s.hidden).toBe(0);
  });
  test("an unknown who or state shows as other, never dropped", () => {
    const s = sanitize({ made_at: "x", threads: [{ ...base, who: "a stranger" }, { ...base, state: "urgent" }, base] });
    expect(s.threads.length).toBe(3);
    expect(s.threads[0].who).toBe("other");
    expect(s.threads[1].state).toBe("other");
    expect(s.hidden).toBe(0);
  });
  test("a thread that can't be drawn is dropped and counted with the signed counts", () => {
    const s = sanitize({ made_at: "x", threads: [{ ...base, title: 3 }, null, base], excluded_rows: 2, skipped_rows: 1 });
    expect(s.threads.length).toBe(1);
    expect(s.hidden).toBe(5);
  });
});

describe("the sort", () => {
  const t = (id: string, last_moved: string): Thread => ({
    id, title: id, area: "other", who: "the assistant", step: "", waits_for: null, outcome: "", last_moved, state: "moving",
  });
  test("newest move first, ties keep their order", () => {
    const sorted = sortThreads([
      t("a", "2026-11-01T00:00:00Z"),
      t("b", "2026-11-18T09:00:00Z"),
      t("c", "2026-11-10T00:00:00Z"),
      t("d", "2026-11-18T09:00:00Z"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
  });
  test("the fixture loads newest first", () => {
    const loaded = check(raw, pub);
    if (!loaded.ok) throw new Error("fixture did not verify");
    const times = loaded.snapshot.threads.map((x) => Date.parse(x.last_moved));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("one canonical form", () => {
  test("the signed bytes are the standard UTF-8, ellipsis, emoji and non-BMP text included", () => {
    const s = { version: 1, made_at: "x", threads: [{ t: "As of 9:14 … café \u{1F600} 𝄞 中" }], excluded_rows: 0, skipped_rows: 0 };
    expect(Array.from(signedBytes(s))).toEqual(Array.from(Buffer.from(canonical(s), "utf8")));
  });

  test("a cross-runtime vector the exporter signed verifies here", () => {
    expect(verify(vector, pub)).toBe(true);
    const title: string = vector.threads[0].title;
    expect(Array.from(title).length).toBe(140);
    expect(title.endsWith("😀…")).toBe(true);
    expect(vector.threads[0].step).toContain("𝄞");
  });

  test("one changed code point in the vector fails", () => {
    const v = JSON.parse(JSON.stringify(vector));
    v.threads[0].step = v.threads[0].step.replace("𝄞", "𝄢");
    expect(verify(v, pub)).toBe(false);
  });
});
