import { readFileSync } from "fs";
import { join } from "path";
import { utf8 } from "../src/canonical";
import { check, loadSnapshot, sanitize, sortThreads, verify, type Thread } from "../src/snapshot";

// Signed by the exporter itself (fixtures/make.ts), so this checks the two implementations agree.
const raw = JSON.parse(readFileSync(join(__dirname, "fixtures/snapshot.json"), "utf8"));
const pub = readFileSync(join(__dirname, "fixtures/snapshot.pub"), "utf8").trim();
const clone = () => JSON.parse(JSON.stringify(raw));
const fetchOf = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

describe("the loader", () => {
  test("an exporter-signed snapshot verifies", () => {
    expect(verify(raw, pub)).toBe(true);
  });

  test("loads and passes", async () => {
    const loaded = await loadSnapshot("/snapshot.json", pub, fetchOf(raw));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.snapshot.threads.length).toBe(raw.threads.length);
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

  test("a failed fetch or bad JSON is unreadable", async () => {
    expect(await loadSnapshot("/s", pub, fetchOf(raw, false))).toEqual({ ok: false, reason: "unreadable" });
    const broken = async () => ({ ok: true, json: async () => { throw new Error("bad"); } });
    expect(await loadSnapshot("/s", pub, broken)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("unknown fields", () => {
  const base = {
    id: "P1", title: "t", area: "other", who: "cain", step: "s", waits_for: null,
    outcome: "o", last_moved: "2026-11-18T09:00:00Z", state: "moving",
  };
  test("are dropped from each thread and from the snapshot", () => {
    const s = sanitize({ made_at: "2026-11-18T10:00:00Z", threads: [{ ...base, note: "drop me", nested: { a: 1 } }] });
    expect(Object.keys(s.threads[0]).sort()).toEqual(Object.keys(base).sort());
    expect(Object.keys(s).sort()).toEqual(["made_at", "threads"]);
  });
  test("a thread with an unknown who or state is left out", () => {
    const s = sanitize({ made_at: "x", threads: [{ ...base, who: "someone" }, { ...base, state: "urgent" }, base] });
    expect(s.threads.length).toBe(1);
  });
});

describe("the sort", () => {
  const t = (id: string, last_moved: string): Thread => ({
    id, title: id, area: "other", who: "cain", step: "", waits_for: null, outcome: "", last_moved, state: "moving",
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

describe("utf8", () => {
  test("matches Node's encoder, ellipsis and emoji included", () => {
    const text = "As of 9:14 … café \u{1F600} 中";
    expect(Array.from(utf8(text))).toEqual(Array.from(Buffer.from(text, "utf8")));
  });
});
