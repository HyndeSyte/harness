// The channel smoke test's own command line (c1/smoke.sh, C1 plan 3.12 step 5). The CI image test
// (cain/tests/image/in.sh) puts stub-smoke.sh in its place, since CI has no Claude sign-in, so the
// real `claude` invocation never ran in CI, and on the Pi --channels (a list option in Claude
// Code) took the prompt as a second channel: claude exited 1 before starting a session. Here the
// real smoke.sh runs against a stub `claude` first on PATH that reads its arguments the way
// Claude Code does (a list option takes every word up to the next option; "--" ends the
// options), refuses an untagged channel with Claude Code's own error, and otherwise records what
// it got, writes a start event naming the seed's plugin, and calls the stand-in broker's reply.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const posix = process.platform !== "win32";
const SMOKE = join(import.meta.dir, "../rootfs/opt/cain/c1/smoke.sh");
const SEED_LOADED = join(import.meta.dir, "../rootfs/opt/cain/c1/seed-loaded.sh");
const DM = "100000000000000042";
const CHANNEL = "plugin:discord@claude-plugins-official";

// The stub `claude`. Options it knows, as smoke.sh uses them: flags, options with one value, and
// --channels, a list. Anything it doesn't know fails, as an unknown option would.
const STUB_CLAUDE = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const FLAGS = new Set(["-p", "--print", "--verbose"]);
const ONE = new Set(["--output-format", "--permission-mode"]);
const LISTS = new Set(["--channels"]);
const argv = process.argv.slice(2);
const opts: Record<string, string[]> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
  if (FLAGS.has(a)) { opts[a] = []; continue; }
  if (ONE.has(a)) { opts[a] = [argv[++i]]; continue; }
  if (LISTS.has(a)) {
    const v: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) v.push(argv[++i]);
    opts[a] = v; continue;
  }
  if (a.startsWith("-")) { process.stderr.write("error: unknown option '" + a + "'\\n"); process.exit(1); }
  positional.push(a);
}
writeFileSync(process.env.STUB_ARGV!, JSON.stringify({ argv, opts, positional }));
for (const c of opts["--channels"] ?? [])
  if (!/^(plugin:[^@\\s]+@\\S+|server:\\S+)$/.test(c)) {
    process.stderr.write("--channels entries must be tagged: " + c + "\\n  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\\n  server:<name>                — manually configured MCP server\\n");
    process.exit(1);
  }
const seed = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR!;
console.log(JSON.stringify({ type: "system", subtype: "init", plugins: [{ name: "discord", path: seed + "/discord", source: "discord@claude-plugins-official" }] }));
await new Promise<void>((done) => Bun.connect({ unix: process.env.CAIN_DISCORD_SOCK!, socket: {
  open(s) { s.write("reply\\n"); s.end(); }, close() { done(); }, data() {}, error() { done(); } } }));
console.log(JSON.stringify({ type: "result", subtype: "success" }));
`;

// The stand-in broker: a socket at CAIN_DISCORD_SOCK; what comes in counts as the reply tool's call.
const STUB_BROKER = `import { appendFileSync } from "node:fs";
Bun.listen({ unix: process.env.CAIN_DISCORD_SOCK!, socket: {
  data(_s, d) { if (String(d).includes("reply")) appendFileSync(process.env.SMOKE_LOG!, '{"name":"reply"}\\n'); }, open() {}, close() {} } });
`;

function rig(smokeText: string) {
  const d = mkdtempSync(join(tmpdir(), "c1-smoke-"));
  const opt = join(d, "opt"), run = join(d, "run"), data = join(d, "data"), bin = join(d, "bin");
  for (const p of [join(opt, "c1"), join(opt, "discord"), join(opt, "plugin-seed", "discord"), join(run, "root-tmp"), join(data, "trust"), bin])
    mkdirSync(p, { recursive: true });
  writeFileSync(join(opt, "c1", "smoke.sh"), smokeText, { mode: 0o755 });
  copyFileSync(SEED_LOADED, join(opt, "c1", "seed-loaded.sh")); chmodSync(join(opt, "c1", "seed-loaded.sh"), 0o755);
  // as-cain drops to his user on the Pi; here it only runs the command, keeping PATH (the stub first).
  writeFileSync(join(opt, "as-cain"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(opt, "discord", "broker-main.ts"), STUB_BROKER);
  writeFileSync(join(bin, "claude"), STUB_CLAUDE, { mode: 0o755 });
  writeFileSync(join(data, "trust", "cards.json"), JSON.stringify({ dm: DM }));
  const argvFile = join(d, "argv.json");
  const r = Bun.spawnSync(["bash", join(opt, "c1", "smoke.sh")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, C1_OPT: opt, C1_RUN: run, C1_DATA: data, STUB_ARGV: argvFile },
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  let got: { argv: string[]; opts: Record<string, string[]>; positional: string[] } | null = null;
  try { got = JSON.parse(readFileSync(argvFile, "utf8")); } catch { /* claude never ran */ }
  return { code: r.exitCode, err: r.stderr.toString(), got };
}

describe.if(posix)("the channel smoke test's claude command line (c1/smoke.sh)", () => {
  const real = readFileSync(SMOKE, "utf8");

  test("--channels gets exactly one value, and the prompt is the one positional argument", () => {
    const { code, err, got } = rig(real);
    expect(got).not.toBeNull();
    expect(got!.opts["--channels"]).toEqual([CHANNEL]);
    expect(got!.positional).toHaveLength(1);
    expect(got!.positional[0]).toStartWith("This is an automated start-up check of your Discord channel");
    expect(got!.positional[0]).toContain(`chat_id ${DM} `);
    expect(got!.opts["-p"]).toEqual([]);
    expect(got!.opts["--output-format"]).toEqual(["stream-json"]);
    expect(got!.opts["--permission-mode"]).toEqual(["auto"]);
    expect(err).toContain("[c1] smoke: passed");
    expect(code).toBe(0);
  });

  test("the old command line (the prompt straight after --channels) fails here, and says why plainly", () => {
    const old = real.replace(`--channels ${CHANNEL} -- \\\n`, `--channels ${CHANNEL} \\\n`);
    expect(old).not.toBe(real);
    const { code, err, got } = rig(old);
    expect(got!.opts["--channels"]).toHaveLength(2);  // the prompt taken as a second channel
    expect(got!.positional).toEqual([]);
    expect(code).toBe(1);
    expect(err).toContain("[c1] smoke: claude exited 1 before starting a session: --channels entries must be tagged: This is an automated");
    expect(err).not.toContain("the seed's plugin didn't load");
  });
});
