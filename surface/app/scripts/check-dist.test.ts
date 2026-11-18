// Run with Bun (the surface-bun job): bun test surface/app/scripts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore: a plain .mjs script, checked here by its behaviour.
import { cspProblems, inlineScripts } from "./check-dist.mjs";

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
