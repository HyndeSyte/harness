// Run with Bun (the surface-bun job): bun test surface/app/scripts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore: a plain .mjs script, checked here by its behaviour.
import { cspProblems, inlineScripts, snapshotFiles } from "./check-dist.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const policy = (csp: string) => `/*\n  Content-Security-Policy: ${csp}\n`;
const good = "default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

describe("the dist check", () => {
  test("the app's own _headers passes", () => {
    expect(cspProblems(readFileSync(join(import.meta.dir, "..", "public", "_headers"), "utf8"))).toEqual([]);
  });
  test("script-src must be 'self' alone, never unsafe-inline or unsafe-eval", () => {
    expect(cspProblems(policy(good))).toEqual([]);
    expect(cspProblems(policy(good.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))).length).toBeGreaterThan(0);
    expect(cspProblems(policy(good.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"))).length).toBeGreaterThan(0);
    expect(cspProblems(policy(good + "; script-src-elem 'self' 'unsafe-inline'"))).toEqual(["script-src-elem allows 'unsafe-inline'"]);
    expect(cspProblems(policy(good.replace("script-src 'self'; ", "")))).toEqual(["the content policy has no script-src"]);
  });
  test("connect-src 'self' and frame-ancestors 'none'", () => {
    expect(cspProblems(policy(good.replace("connect-src 'self'", "connect-src 'self' https://x.example"))).length).toBe(1);
    expect(cspProblems(policy(good.replace("frame-ancestors 'none'", "frame-ancestors 'self'"))).length).toBe(1);
    expect(cspProblems("/*\n  X-Frame-Options: DENY\n")).toEqual(["dist/_headers has no Content-Security-Policy line"]);
  });
  test("an inline script is found, a script with a src is not", () => {
    expect(inlineScripts('<script src="/a.js"></script><script>alert(1)</script><SCRIPT type="module">x</SCRIPT>').length).toBe(2);
    expect(inlineScripts('<script defer src="/a.js"></script>')).toEqual([]);
  });
});

describe("seventh round: the artifact holds no snapshot", () => {
  test("a snapshot.json, or a file with a signed snapshot inside it, is found; app code is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-dist-"));
    mkdirSync(join(dir, "_expo", "static"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    // The app's own code names the purpose, as a constant, with no signature beside it.
    writeFileSync(join(dir, "_expo", "static", "app.js"), 'const P="in-motion-snapshot";');
    expect(snapshotFiles(dir)).toEqual([]);
    writeFileSync(join(dir, "snapshot.json"), "{}");
    writeFileSync(join(dir, "_expo", "static", "data.js"), 'x={"app":"harness-surface","purpose":"in-motion-snapshot","sig":"abc"}');
    expect(snapshotFiles(dir).map((f: string) => f.slice(dir.length + 1)).sort()).toEqual(["_expo/static/data.js", "snapshot.json"]);
  });
});
