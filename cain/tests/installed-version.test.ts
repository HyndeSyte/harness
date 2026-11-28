// Cain 0.19.4, its first outside review's fixes: the start's lookup of the installed version (opt/cain/installed-version.sh) keeps the
// Supervisor's token off every command line, trace and log, is bounded, writes only a checked X.Y.Z atomically into /run/cain; the
// link's choice (ship-pass.ts cainInstalled) waits briefly for a running lookup, then takes only a valid build version, and never a
// value from an earlier start; a refused registration's one plain line (core.ts refusedCard).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cainInstalled, INSTALLED_WAIT_MS } from "../rootfs/opt/cain/link/ship-pass";
import { rig } from "./link-rig";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "rootfs/opt/cain/installed-version.sh");
const RUN = readFileSync(join(ROOT, "rootfs/etc/services.d/cain/run"), "utf8");
const TOKEN = "sv-token-0123456789abcdefSECRET";

// A fake curl on PATH: notes its argv and its stdin, then answers what ANSWER holds (or fails with FAIL set).
function lookup(answer: string | null, o: { stale?: string; limit?: number; pause?: number; xtrace?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "cain-iv-"));
  const bin = join(d, "bin"), run = join(d, "run", "cain");
  mkdirSync(bin, { recursive: true }); mkdirSync(run, { recursive: true });
  writeFileSync(join(d, "answer"), answer ?? "");
  writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${d}/argv\ncat > ${d}/stdin\n${answer === null ? "exit 22" : `cat ${d}/answer`}\n`);
  chmodSync(join(bin, "curl"), 0o755);
  if (o.stale !== undefined) writeFileSync(join(run, "installed-version"), o.stale);
  const sh = `__BASHIO_SUPERVISOR_TOKEN='${TOKEN}'; ${o.xtrace ? "set -x; " : ""}. '${SCRIPT}'; installed_version_lookup '${run}'; echo done`;
  const t0 = Date.now();
  const p = spawnSync("bash", ["-c", sh], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALLED_LOOKUP_LIMIT: String(o.limit ?? 4), INSTALLED_LOOKUP_PAUSE: String(o.pause ?? 1) }, encoding: "utf8", timeout: 30_000 });
  const file = join(run, "installed-version");
  return { d, run, file, p, ms: Date.now() - t0, out: (p.stdout ?? "") + (p.stderr ?? ""),
    argv: existsSync(join(d, "argv")) ? readFileSync(join(d, "argv"), "utf8") : "", stdin: existsSync(join(d, "stdin")) ? readFileSync(join(d, "stdin"), "utf8") : "",
    version: existsSync(file) ? readFileSync(file, "utf8") : null };
}
const OK = (v: unknown) => JSON.stringify({ result: "ok", data: { version: v, slug: "0fcc2575_cain" } });

describe("Cain 0.19.4: the start's lookup of the installed version", () => {
  test("the token goes to curl on stdin only, never in its argv, a trace or the output; every call is bounded", () => {
    const r = lookup(OK("0.19.0"), { xtrace: true });
    expect(r.p.status).toBe(0);
    expect(r.version).toBe("0.19.0\n");
    expect(r.stdin).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect(r.argv).not.toContain(TOKEN);
    expect(r.argv).toContain("-H @-");
    expect(r.argv).toMatch(/--connect-timeout \d+/);
    expect(r.argv).toMatch(/--max-time \d+/);
    expect(r.out).not.toContain(TOKEN);                        // xtrace was on in the caller: the function turns it off first
    expect(r.out).not.toContain("0fcc2575_cain");              // the answer's body is never printed
    expect(readdirSync(r.run).sort()).toEqual(["installed-version"]);   // no temp file or running mark left
    expect((statSync(r.file).mode & 0o777).toString(8)).toBe("644");
  });
  test("a missing, empty, null, HTML or malformed answer writes nothing, and an earlier start's file never survives", () => {
    const bad: (string | null)[] = [null, "", OK(null), OK(""), OK("dev"), OK("latest"), OK(19), OK("0.19.0\nrm -rf /"), OK("0.19.0-beta"), OK("1.2"),
      "<html><body>502 Bad Gateway</body></html>", JSON.stringify({ result: "error", message: "nope" }), JSON.stringify([{ result: "ok" }]),
      JSON.stringify({ result: "ok", data: null }), "null", "{not json"];
    for (const a of bad) {
      const r = lookup(a, { stale: "0.18.0\n", limit: 2, pause: 1 });
      expect([a, r.version]).toEqual([a, null]);
      expect(readdirSync(r.run)).toEqual([]);
    }
  }, 60_000);
  test("the whole lookup is bounded: a Supervisor that never answers well ends it within its limit", () => {
    const r = lookup(null, { limit: 3, pause: 1 });
    expect(r.p.status).toBe(0);
    expect(r.ms).toBeLessThan(6_000);
    expect(r.argv.trim().split("\n").length).toBeGreaterThan(1);    // it retried
    for (const line of r.argv.trim().split("\n")) expect(Number(/--max-time (\d+)/.exec(line)![1])).toBeLessThanOrEqual(10);
  }, 20_000);
  test("the start runs it in the background, in /run/cain, with no bashio Supervisor call and nothing in /data", () => {
    expect(RUN).toContain(`( . "$OPT/installed-version.sh" && installed_version_lookup /run/cain ) >/dev/null 2>&1 &`);
    const block = RUN.slice(RUN.indexOf("# The version of Cain installed now (0.19.4)"), RUN.indexOf("# Cain's link (link/main.ts): taps"));
    expect(block).not.toContain("bashio::api.supervisor");
    expect(block).not.toContain("/data");
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/set -x\b/);
    expect(src).not.toMatch(/Authorization[^\n]*curl[^\n]*-H "/);
    expect(src).toContain("{ set +x; } 2>/dev/null");
    // the link reads it from /run/cain only
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8")).toContain(`"/run/cain/installed-version"`);
  });
});

describe("Cain 0.19.4: the link's choice of the installed version", () => {
  const clock = () => { let t = 1_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms; }, get t() { return t; } }; };
  test("the file when present and valid", async () => {
    const k = clock();
    expect(await cainInstalled({ read: () => "0.19.0\n", pendingSince: () => k.now(), build: "0.19.3", ...k })).toBe("0.19.0");
    expect(k.t).toBe(1_000_000);
  });
  test("while the lookup is still running, it waits for it, a few seconds at most", async () => {
    const k = clock(); const start = k.t;
    let file: string | null = null;
    const v = await cainInstalled({ read: () => { if (k.t - start >= 1_000) file = "0.19.0"; return file; }, pendingSince: () => start, build: "0.19.3", ...k });
    expect(v).toBe("0.19.0");
    const k2 = clock(); const s2 = k2.t;
    expect(await cainInstalled({ read: () => null, pendingSince: () => s2, build: "0.19.3", ...k2 })).toBe("0.19.3");
    expect(k2.t - s2).toBeGreaterThanOrEqual(INSTALLED_WAIT_MS);
    expect(k2.t - s2).toBeLessThanOrEqual(INSTALLED_WAIT_MS + 250);
  });
  test("no running lookup (or a mark left over from one long gone): no wait, the build version if valid, else none", async () => {
    for (const since of [null, 1_000_000 - 10 * 60_000]) {
      const k = clock();
      expect(await cainInstalled({ read: () => null, pendingSince: () => since, build: "0.19.3", ...k })).toBe("0.19.3");
      expect(k.t).toBe(1_000_000);
    }
    for (const build of ["", "dev", "latest", " ", undefined, "0.19", "v0.19.3"]) {
      const k = clock();
      expect(await cainInstalled({ read: () => { throw new Error("ENOENT"); }, pendingSince: () => null, build, ...k })).toBe(null);
    }
    const k = clock();
    expect(await cainInstalled({ read: () => "<html>", pendingSince: () => { throw new Error("x"); }, build: " 0.19.3 ", ...k })).toBe("0.19.3");
  });
  test("a value from an earlier start is never used: the start's lookup clears it, so the link falls back", async () => {
    const r = lookup(null, { stale: "0.18.0\n", limit: 2, pause: 1 });
    expect(existsSync(r.file)).toBe(false);
    const read = () => readFileSync(r.file, "utf8");
    const pendingSince = () => { try { return statSync(`${r.file}.pending`).mtimeMs; } catch { return null; } };
    expect(await cainInstalled({ read, pendingSince, build: "0.19.3" })).toBe("0.19.3");
    expect(await cainInstalled({ read, pendingSince, build: "dev" })).toBe(null);
  }, 20_000);
});

describe("Cain 0.19.4: the owner's line for a refused install", () => {
  const ATT = "ship-46-cain-01234567";
  test("one plain line per attempt, with Keeper's reason and no button; not while stopped; held through quiet hours", async () => {
    const r = rig();
    const out = await r.link.refusedCard(ATT, "0fcc2575_cain", "0.19.3", "0fcc2575_cain is at 0.19.0, not 0.19.1");
    expect(out.status).toBe("posted");
    expect(r.msg(out.message!).content).toBe("Keeper refused the install of Cain 0.19.3, so nothing was installed: Cain is at 0.19.0, not 0.19.1.");
    expect(r.buttons(out.message!)).toEqual([]);
    expect((await r.link.refusedCard(ATT, "0fcc2575_cain", "0.19.3", "again")).status).toBe("open");
    expect(r.posts()).toBe(1);
    await expect(r.link.refusedCard("nope", "0fcc2575_cain", "0.19.3", "x")).rejects.toThrow("isn't a keeper attempt");
    const st = rig(); st.stop.stopped = true;
    expect((await st.link.refusedCard(ATT, "0fcc2575_cain", "0.19.3", "x")).status).toBe("stopped");
    const at = (h: number) => Date.parse(`2026-11-25T${String(h).padStart(2, "0")}:30:00-05:00`);
    const q = rig({ now: at(23) });
    expect((await q.link.refusedCard(ATT, "0fcc2575_cain", "0.19.3", "it is unprotected")).status).toBe("quiet");
    expect(q.posts()).toBe(0);
    q.t.now = at(7) + 24 * 3_600_000;
    expect(await q.link.quietFlush()).toBe(1);
    expect(q.posts()).toBe(1);
  });
});
