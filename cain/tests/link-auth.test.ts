// Who may call the link (rootfs/opt/cain/link/auth.ts): each caller opens only its own routes;
// the specialist and the link sign both ways; a request id runs once.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAIN_ROUTES, checkRequest, KEEP_MS, RequestLog, requestId, ROOT_ROUTES, routeAllowed, signRequest, signResponse, SPECIALIST_ROUTES } from "../rootfs/opt/cain/link/auth";

const KEY = "a".repeat(64);
const NOW = 1_794_686_000_000;

describe("signed requests", () => {
  test("a good signature gives the request's id", () => {
    const h = signRequest(KEY, "POST", "/card", '{"text":"x"}', NOW);
    expect(checkRequest(h, KEY, "POST", "/card", '{"text":"x"}', NOW + 5)).toBe(requestId("POST", "/card", '{"text":"x"}'));
  });

  test("the same operation retried keeps its id; another operation has another", () => {
    expect(requestId("POST", "/card", "{}")).toBe(requestId("post", "/card", "{}"));
    expect(requestId("POST", "/card", "{}")).not.toBe(requestId("POST", "/relay", "{}"));
  });

  test("it covers the method, the path with its query, and the body", () => {
    const h = signRequest(KEY, "GET", "/card-of?m=1", "", NOW);
    expect(checkRequest(h, KEY, "GET", "/card-of?m=2", "", NOW)).toBeNull();
    expect(checkRequest(h, KEY, "POST", "/card-of?m=1", "", NOW)).toBeNull();
    const b = signRequest(KEY, "POST", "/relay", '{"text":"a"}', NOW);
    expect(checkRequest(b, KEY, "POST", "/relay", '{"text":"b"}', NOW)).toBeNull();
  });

  test("a minute old, or a minute ahead, it's refused", () => {
    expect(checkRequest(signRequest(KEY, "POST", "/card", "", NOW - 60_001), KEY, "POST", "/card", "", NOW)).toBeNull();
    expect(checkRequest(signRequest(KEY, "POST", "/card", "", NOW + 60_001), KEY, "POST", "/card", "", NOW)).toBeNull();
  });

  test("another key, a bare key, or nothing: refused", () => {
    expect(checkRequest(signRequest("b".repeat(64), "POST", "/card", "", NOW), KEY, "POST", "/card", "", NOW)).toBeNull();
    expect(checkRequest(KEY, KEY, "POST", "/card", "", NOW)).toBeNull();
    expect(checkRequest(null, KEY, "POST", "/card", "", NOW)).toBeNull();
    expect(checkRequest(signRequest(KEY, "POST", "/card", "", NOW), "", "POST", "/card", "", NOW)).toBeNull();
  });

  test("a response's signature covers the request id, the status and the body", () => {
    const s = signResponse(KEY, "f".repeat(32), 200, '{"id":4}');
    expect(s).toBe(signResponse(KEY, "f".repeat(32), 200, '{"id":4}'));
    expect(s).not.toBe(signResponse(KEY, "e".repeat(32), 200, '{"id":4}'));
    expect(s).not.toBe(signResponse(KEY, "f".repeat(32), 500, '{"id":4}'));
    expect(s).not.toBe(signResponse(KEY, "f".repeat(32), 200, '{"id":5}'));
  });
});

describe("the request log: each id runs once, across restarts", () => {
  test("received, then done with its answer, kept on disk and found again after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "reqlog-")), "requests.json");
    const a = new RequestLog(path);
    a.put("f".repeat(32), { at: NOW, state: "received" });
    expect(new RequestLog(path).get("f".repeat(32), NOW + 1)?.state).toBe("received");
    a.put("f".repeat(32), { at: NOW + 5, state: "done", status: 200, body: '{"id":4}' });
    expect(new RequestLog(path).get("f".repeat(32), NOW + 1000)).toEqual({ at: NOW + 5, state: "done", status: 200, body: '{"id":4}' });
  });

  test("kept 8 days, longer than the specialist retries an operation (7 days), then gone", () => {
    const log = new RequestLog(null);
    log.put("f".repeat(32), { at: NOW, state: "done", status: 200, body: "{}" });
    expect(KEEP_MS).toBe(8 * 24 * 3_600_000);
    expect(log.get("f".repeat(32), NOW + KEEP_MS - 1)).not.toBeNull();
    expect(log.get("f".repeat(32), NOW + KEEP_MS + 1)).toBeNull();
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
    expect([...ROOT_ROUTES].sort()).toEqual(["/cards", "/check", "/decision", "/guard-hold", "/legacy-grant", "/pc-notice", "/reuse", "/sent"]);   // the PC job keeper's two, the review runner's decision card and the guard's hold (0.16.0), its Keep or Drop card (0.18.1), root's
    expect(routeAllowed("root", "/card")).toBe(false);
    expect(routeAllowed("root", "/ship")).toBe(false);
  });

  test("an unknown caller opens nothing", () => {
    for (const r of [...SPECIALIST_ROUTES, ...CAIN_ROUTES, ...ROOT_ROUTES]) expect(routeAllowed("none", r)).toBe(false);
  });
});

// The same vector tests/test_addon.py checks in the Harness App's Python (SIG_VECTOR): the two
// sides of the link's signatures must agree byte for byte.
describe("the vector both Apps share", () => {
  test("request id, request signature and response signature", () => {
    const key = "a".repeat(64), body = '{"text": "x"}', id = "ac5e14e39c2294e982a8a34f4e5beaf9";
    expect(requestId("POST", "/card", body)).toBe(id);
    expect(signRequest(key, "POST", "/card", body, 1794686000000))
      .toBe("id=ac5e14e39c2294e982a8a34f4e5beaf9,t=1794686000000,s=aa669cbb6222600a41f35eef346f0aa6b625ee988ad85d2baf455e48ce078b3d");
    expect(signResponse(key, id, 200, '{"id": 4}')).toBe("s=cb4516fb923369d50bc4b6ba1331f56ed258c0f9e398ffec6071b4f78b302da2");
  });
});
