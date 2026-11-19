// The pre-ship connector check (cain/tools/connector-check.sh, Cain 0.13.3) and the switch's own
// connector check (c1/cutover.sh). CI has no signed-in Claude account, so these run against a
// stand-in `claude` that lists what a signed-in one would: they prove the comparison and that a
// machine with no account fails loudly, not that real connectors load (that is the check's job,
// on a signed-in machine: cain/docs/connector-check.md).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "cain/tools/connector-check.sh");
const SETTINGS = join(ROOT, "cain/rootfs/opt/cain/settings.json");

const CONNECTORS = ["claude.ai Canva", "claude.ai Claude Docs", "claude.ai GitHub", "claude.ai Gmail", "claude.ai Google Calendar"];
const line = (n: string, url = "https://example.test/mcp") => `${n}: ${url} - ✓ Connected`;

// A stand-in claude: `mcp list` prints PLAIN's lines, and with --settings RULED's.
function fake(plain: string[], ruled: string[], rcPlain = 0) {
  const dir = mkdtempSync(join(tmpdir(), "conncheck-"));
  writeFileSync(join(dir, "plain"), plain.join("\n") + (plain.length ? "\n" : ""));
  writeFileSync(join(dir, "ruled"), ruled.join("\n") + (ruled.length ? "\n" : ""));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/bash
echo "$*" >> "${dir}/calls"
if [ "$1" = --settings ]; then echo "Checking MCP server health..."; echo; cat "${dir}/ruled"; exit 0; fi
echo "Checking MCP server health..."; echo; cat "${dir}/plain"; exit ${rcPlain}
`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}
function run(bin: string, settings = SETTINGS) {
  const p = Bun.spawnSync(["bash", SCRIPT, settings], { env: { ...process.env, CLAUDE_BIN: bin } });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("the pre-ship connector check", () => {
  test("passes when every claude.ai connector also loads under Cain's rules, and runs both listings", () => {
    const all = [...CONNECTORS.map((n) => line(n)), "plugin:discord:discord: bun run start - ✓ Connected"];
    const f = fake(all, all);
    const r = run(f.bin);
    expect(r.err).toBe("");
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`all ${CONNECTORS.length} claude.ai connectors load`);
    expect(readFileSync(join(f.dir, "calls"), "utf8").trim().split("\n")).toEqual(["mcp list", `--settings ${SETTINGS} mcp list`]);
  });

  test("fails, naming each one missing, when the rules refuse some (Nov 19: all 18)", () => {
    const f = fake(CONNECTORS.map((n) => line(n)), [line(CONNECTORS[0])]);
    const r = run(f.bin);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("CONNECTOR CHECK FAILED");
    expect(r.err).toContain(`Without Cain's rules: ${CONNECTORS.length} claude.ai connectors. Under them: 1`);
    for (const n of CONNECTORS.slice(1)) expect(r.err).toContain(`  ${n}\n`);
    const none = run(fake(CONNECTORS.map((n) => line(n)), []).bin);
    expect(none.rc).toBe(1);
    expect(none.err).toContain("Under them: 0");
  });

  test("with no account signed in it fails loudly, never passing on nothing compared", () => {
    for (const f of [fake([], []), fake(["No MCP servers configured."], [], 1)]) {
      const r = run(f.bin);
      expect(r.rc).toBe(1);
      expect(r.err).toContain("CONNECTOR CHECK FAILED");
      expect(r.err).toContain("no signed-in account here");
      expect(r.out).not.toContain("passed");
      // The ruled listing never runs: there's nothing to compare it with.
      expect(readFileSync(join(f.dir, "calls"), "utf8").trim()).toBe("mcp list");
    }
    const r = run("/nonexistent/claude");
    expect(r.rc).toBe(1);
    expect(r.err).toContain("no Claude Code here");
  });

  test("a settings file naming the proxy or a per-host list fails before any listing", () => {
    const base = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "conncheck-s-"));
    for (const url of ["https://mcp-proxy.anthropic.com/v1/mcp/*", "https://gmailmcp.googleapis.com/*"]) {
      const s = join(dir, "s.json");
      writeFileSync(s, JSON.stringify({ ...base, allowedMcpServers: [base.allowedMcpServers[0], { serverUrl: url }] }));
      const all = CONNECTORS.map((n) => line(n));
      const f = fake(all, all);
      const r = run(f.bin, s);
      expect(r.rc).toBe(1);
      expect(r.err).toContain("isn't the one Cain needs");
      expect(() => readFileSync(join(f.dir, "calls"))).toThrow();
    }
  });

  test("its doc says where it runs and that CI can't run it", () => {
    const doc = readFileSync(join(ROOT, "cain/docs/connector-check.md"), "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("cain/tools/connector-check.sh");
    expect(doc).toContain("CI can't run it");
    expect(doc).toContain("signed in");
    const rel = readFileSync(join(ROOT, "RELEASING.md"), "utf8").replace(/\s+/g, " ");
    expect(rel).toContain("cain/tools/connector-check.sh");
  });
});

// The switch's own check of his connectors (c1/cutover.sh): the App's log gets the whole list of
// those missing, while the line kept for Dane's alarm stays cut at 200 characters.
describe("the switch's connector check logs every name missing", () => {
  const src = readFileSync(join(ROOT, "cain/rootfs/opt/cain/c1/cutover.sh"), "utf8");
  const start = src.indexOf('  if [ -n "$(tail -n +2 "$C/connectors-before")" ]; then');
  const block = src.slice(start, src.indexOf("\n  fi\n", start) + 5);

  test("all 18 named in the log, the alarm's line cut", () => {
    expect(start).toBeGreaterThan(-1);
    const names = Array.from({ length: 18 }, (_, i) => `claude.ai Connector Number ${String(i + 1).padStart(2, "0")}`);
    const dir = mkdtempSync(join(tmpdir(), "cutover-conn-"));
    writeFileSync(join(dir, "connectors-before"), ["listed", ...names].join("\n") + "\n");
    // As him, under the rules, nothing of claude.ai lists (0.13.2's allowlist).
    writeFileSync(join(dir, "as-cain"), `#!/bin/bash\necho "plugin:discord:discord: bun run start - Connected"\n`);
    chmodSync(join(dir, "as-cain"), 0o755);
    const script = `set -uo pipefail
C="${dir}"; OPT="${dir}"
log() { echo "[c1] $*" >&2; }
abort() { log "not switched: $*"; echo "ABORT $*"; exit 1; }
${block}
echo PASSED`;
    const p = Bun.spawnSync(["bash", "-c", script]);
    const out = p.stdout.toString(), err = p.stderr.toString();
    expect(p.exitCode).toBe(1);
    const logLine = err.split("\n").find((l) => l.includes("missing under his new rules (18 of 18)"))!;
    expect(logLine).toBeDefined();
    for (const n of names) expect(logLine).toContain(n);
    const abortLine = out.split("\n").find((l) => l.startsWith("ABORT "))!;
    const inner = abortLine.match(/\(missing: (.*)\)$/)![1];
    expect(inner.length).toBeLessThanOrEqual(200);
    expect(inner).not.toContain(names[17]);
  });
});
