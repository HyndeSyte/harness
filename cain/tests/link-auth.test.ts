// Who may call the link (rootfs/opt/cain/link/auth.ts): each caller opens only its own routes,
// and the specialist proves its key without sending it.
import { describe, expect, test } from "bun:test";
import { CAIN_ROUTES, ROOT_ROUTES, SPECIALIST_ROUTES, Signatures, routeAllowed, signRequest } from "../rootfs/opt/cain/link/auth";

const KEY = "a".repeat(64);

describe("signed requests", () => {
  test("a good signature counts once", () => {
    const s = new Signatures();
    const now = 1_794_686_000_000;
    const h = signRequest(KEY, "POST", "/card", '{"text":"x"}', now);
    expect(s.check(h, KEY, "POST", "/card", '{"text":"x"}', now + 5)).toBe(true);
    expect(s.check(h, KEY, "POST", "/card", '{"text":"x"}', now + 6)).toBe(false);
  });

  test("it covers the method, the path with its query, and the body", () => {
    const s = new Signatures();
    const now = 1_794_686_000_000;
    const h = signRequest(KEY, "GET", "/card-of?m=1", "", now);
    expect(s.check(h, KEY, "GET", "/card-of?m=2", "", now)).toBe(false);
    expect(s.check(h, KEY, "POST", "/card-of?m=1", "", now)).toBe(false);
    const b = signRequest(KEY, "POST", "/relay", '{"text":"a"}', now);
    expect(s.check(b, KEY, "POST", "/relay", '{"text":"b"}', now)).toBe(false);
  });

  test("a minute old, or a minute ahead, it's refused", () => {
    const s = new Signatures();
    const now = 1_794_686_000_000;
    expect(s.check(signRequest(KEY, "POST", "/card", "", now - 60_001), KEY, "POST", "/card", "", now)).toBe(false);
    expect(s.check(signRequest(KEY, "POST", "/card", "", now + 60_001), KEY, "POST", "/card", "", now)).toBe(false);
  });

  test("another key, a bare key, or nothing: refused", () => {
    const s = new Signatures();
    const now = 1_794_686_000_000;
    expect(s.check(signRequest("b".repeat(64), "POST", "/card", "", now), KEY, "POST", "/card", "", now)).toBe(false);
    expect(s.check(KEY, KEY, "POST", "/card", "", now)).toBe(false);
    expect(s.check(null, KEY, "POST", "/card", "", now)).toBe(false);
    expect(s.check(signRequest(KEY, "POST", "/card", "", now), "", "POST", "/card", "", now)).toBe(false);
  });
});

describe("each caller opens only its own routes", () => {
  test("Cain's key opens none of the specialist's routes, and not /sent", () => {
    for (const r of SPECIALIST_ROUTES) expect(routeAllowed("cain", r)).toBe(false);
    expect(routeAllowed("cain", "/sent")).toBe(false);
    for (const r of CAIN_ROUTES) expect(routeAllowed("cain", r)).toBe(true);
  });

  test("the specialist opens none of Cain's routes", () => {
    for (const r of CAIN_ROUTES) expect(routeAllowed("specialist", r)).toBe(false);
    for (const r of SPECIALIST_ROUTES) expect(routeAllowed("specialist", r)).toBe(true);
  });

  test("root's socket opens only what the broker needs", () => {
    expect([...ROOT_ROUTES].sort()).toEqual(["/cards", "/check", "/sent"]);
    expect(routeAllowed("root", "/card")).toBe(false);
    expect(routeAllowed("root", "/ship")).toBe(false);
  });

  test("an unknown caller opens nothing", () => {
    for (const r of [...SPECIALIST_ROUTES, ...CAIN_ROUTES, ...ROOT_ROUTES]) expect(routeAllowed("none", r)).toBe(false);
  });
});
