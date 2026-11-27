// Cain 0.19.2: the App's background services survive their child's exit (keep-running.sh, sourced by services.d/cain/run), and
// the drill store says why it failed (link/drill.ts: the error's code, system call and path in its one log line) and recovers a
// stray temp that isn't a regular file.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillDeps, fileStore, helperMode, storeMarkPub, storeWhy } from "../rootfs/opt/cain/link/drill";

const ROOT = join(import.meta.dir, "..");
const KEEP = join(ROOT, "rootfs/opt/cain/keep-running.sh");
const RUN = readFileSync(join(ROOT, "rootfs/etc/services.d/cain/run"), "utf8");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// A child that exits with each code of codes.txt in turn (one a line; "term" kills itself with SIGTERM), counting its starts.
function childDir(codes: string[]) {
  const d = mkdtempSync(join(tmpdir(), "keep-"));
  writeFileSync(join(d, "codes.txt"), codes.join("\n") + "\n");
  writeFileSync(join(d, "child.sh"), `#!/bin/bash
n=$(cat "${d}/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${d}/n"
code=$(sed -n "\${n}p" "${d}/codes.txt")
case "$code" in term) kill -TERM $$; sleep 5 ;; "") exit 0 ;; *) exit "$code" ;; esac
`);
  chmodSync(join(d, "child.sh"), 0o755);
  return d;
}
// The loop as the run script runs it, under errexit (bashio's set -e stand-in), in a subshell; sleep stubbed to record the
// wait and stop the loop after `stops` waits; bashio's warning stubbed to print the line.
function runLoop(d: string, pause: number, stops: number, env: Record<string, string> = {}) {
  const script = `set -e
bashio::log.warning() { printf 'WARN %s\\n' "$1"; }
. "${KEEP}"
waits=0
sleep() { waits=$((waits + 1)); printf 'WAIT %s\\n' "$1"; if [ "$waits" -ge ${stops} ]; then exit 0; fi; }
( keep_running "test service (child.sh)" ${pause} "${d}/child.sh" ) & p=$!
set +e; wait $p; echo "LOOP ENDED $?"
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 20_000 });
  return { out: r.stdout, err: r.stderr, status: r.status, starts: Number(readFileSync(join(d, "n"), "utf8").trim()) };
}

describe("the background loops survive their child's exit", () => {
  test("under errexit, a child that exits 143 (SIGTERM) and 1 is started again, each logged once with its code", () => {
    const d = childDir(["term", "1", "0"]);
    const r = runLoop(d, 5, 3, { KEEP_QUICK_S: "0" });
    expect(r.starts).toBe(3);
    const warns = r.out.split("\n").filter((l) => l.startsWith("WARN"));
    expect(warns).toEqual([
      "WARN Cain's test service (child.sh) stopped (exit code 143, signal 15): starting it again in 5 seconds",
      "WARN Cain's test service (child.sh) stopped (exit code 1): starting it again in 5 seconds",
    ]);
    expect(r.out.split("\n").filter((l) => l.startsWith("WAIT"))).toEqual(["WAIT 5", "WAIT 5", "WAIT 5"]);   // a clean exit isn't logged
  });
  test("the old loop shape under errexit ends at the child's first non-zero exit (why this changed)", () => {
    const d = childDir(["1", "0"]);
    const r = spawnSync("bash", ["-c", `set -e\n( while true; do "${d}/child.sh"; echo again; done ) & p=$!\nset +e; wait $p; echo "ended $?"`], { encoding: "utf8", timeout: 10_000 });
    expect(r.stdout.trim()).toBe("ended 1");
    expect(readFileSync(join(d, "n"), "utf8").trim()).toBe("1");
  });
  test("a child that keeps exiting at once backs off, doubling to the cap; a long run or a clean exit puts the wait back", () => {
    const d = childDir(["1", "1", "1", "1", "1", "0", "1"]);
    const r = runLoop(d, 2, 7, { KEEP_QUICK_S: "30", KEEP_MAX_S: "10" });
    expect(r.out.split("\n").filter((l) => l.startsWith("WAIT"))).toEqual(["WAIT 2", "WAIT 4", "WAIT 8", "WAIT 10", "WAIT 10", "WAIT 2", "WAIT 2"]);
    expect(r.out).toContain("stopped (exit code 1, 3 quick exits in a row): starting it again in 8 seconds");
    // runs longer than the quick bound never back off
    const d2 = childDir(["1", "1", "1"]);
    const r2 = runLoop(d2, 2, 3, { KEEP_QUICK_S: "0" });
    expect(r2.out.split("\n").filter((l) => l.startsWith("WAIT"))).toEqual(["WAIT 2", "WAIT 2", "WAIT 2"]);
  });
  test("with no bashio, the restart line goes to stderr", () => {
    const d = childDir(["2"]);
    const r = spawnSync("bash", ["-c", `set -e\n. "${KEEP}"\nsleep() { exit 0; }\n( keep_running "x" 1 "${d}/child.sh" )`], { encoding: "utf8", timeout: 10_000 });
    expect(r.stderr).toContain("[cain] Cain's x stopped (exit code 2): starting it again in 1 seconds");
  });
  test("the App's own stop (SIGTERM to the loop) still ends it", async () => {
    const d = mkdtempSync(join(tmpdir(), "keep-"));
    const p = spawn("bash", ["-c", `set -e\n. "${KEEP}"\nkeep_running "sleeper" 1 sleep 30`], { stdio: "ignore", detached: true });
    await Bun.sleep(300);
    const t0 = Date.now();
    const done = new Promise<number | null>((res) => p.on("exit", (code, sig) => res(sig ? 128 : code)));
    process.kill(-p.pid!, "SIGTERM");   // the process group, as a container stop does
    const how = await Promise.race([done, Bun.sleep(5000).then(() => -1)]);
    expect(how).not.toBe(-1);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(d)).toBe(true);
  });
  test("every background loop of the run script goes through keep_running or can't be ended by an error", () => {
    expect(RUN).toContain('. "$OPT/keep-running.sh"');
    expect(RUN).not.toMatch(/while true; do bun/);
    for (const svc of ["link/main.ts", "record/main.ts", "pcjobs/main.ts", "review/main.ts", "probe/main.ts\" loop", "discord/upkeep.ts", "discord/broker-main.ts"]) {
      expect(RUN).toMatch(new RegExp(`keep_running "[^"]+" \\d+ bun "\\$OPT/${svc.replace(/[.\\/"]/g, (c) => `\\${c}`)}`));
    }
    expect(RUN).toContain('keep_running "security watch (security/main.ts)" 10 bun /opt/cain/security/main.ts run 2>&1');
    // the sign-in page's loop: each pass in a subshell of its own, its failure never ends the loop
    expect(RUN).toContain("while true; do (\n    screen=$($TMUX_CMD");
    expect(RUN).toContain("    ) || true\n    sleep 2\n  done\n) &");
    // the shell loops with no bun child already swallow their command's failure
    for (const l of RUN.split("\n").filter((x) => /while true; do "\$OPT\/(notice|checkin)/.test(x))) expect(l).toContain("|| true");
    // every other run script: no loop of this shape
    for (const dir of readdirSync(join(ROOT, "rootfs/etc/services.d"))) {
      const f = join(ROOT, "rootfs/etc/services.d", dir, "run");
      if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toMatch(/while true; do bun/);
    }
    expect(spawnSync("bash", ["-n", join(ROOT, "rootfs/etc/services.d/cain/run")]).status).toBe(0);
    expect(spawnSync("bash", ["-n", KEEP]).status).toBe(0);
  });
});

// The real store in a temporary folder, its log kept
function store() {
  const d = mkdtempSync(join(tmpdir(), "drs-"));
  const logs: string[] = [];
  const s = fileStore(join(d, "trust/keeper-drill.json"), join(d, "trust/keeper-drill-mark.json"), join(d, "link/keeper-drill-spent"), join(d, "trust/aborted.jsonl"),
    Date.now, join(d, "link/keeper-drill-refused.json"), (l) => logs.push(l));
  return { d, s, logs };
}
const deps = (s: ReturnType<typeof fileStore>, logs: string[]) => drillDeps(s, () => null, Date.now, (l) => logs.push(l), { page: () => {} });

describe("the drill store says why it failed", () => {
  test("storeWhy names the code, the system call and the path, and never a parse error's text", () => {
    const e = Object.assign(new Error("EACCES: permission denied, open '/x/y.tmp'"), { code: "EACCES", syscall: "open", path: "/x/y.tmp" });
    expect(storeWhy(e)).toBe("EACCES, open, /x/y.tmp");
    let parse: unknown; try { JSON.parse("secret-file-text"); } catch (x) { parse = x; }
    expect(storeWhy(parse)).toBe("SyntaxError");
    expect(storeWhy(parse)).not.toContain("secret");
    expect(storeWhy("odd")).toBe("no error code");
  });
  test("spend: a high-water time that can't be kept logs its code and path (the spent folder's place is a file)", () => {
    const { d, s } = store();
    mkdirSync(join(d, "link"), { recursive: true });
    writeFileSync(join(d, "link/keeper-drill-spent"), "not a folder");
    const logs: string[] = [];
    const out = deps(s, logs).spend("0.19.2");
    expect(out).toEqual({ error: "the drill flags' spent list can't be written, so nothing was installed" });   // the rule, unchanged
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^the drill flags' high-water time can't be kept \((EEXIST|ENOTDIR), mkdir, .*keeper-drill-spent\): nothing is installed$/);
  });
  test.skipIf(isRoot)("spend: a read-only spent folder logs EACCES and the temp's path", () => {
    const { d, s } = store();
    mkdirSync(join(d, "link/keeper-drill-spent"), { recursive: true });
    chmodSync(join(d, "link/keeper-drill-spent"), 0o500);
    const logs: string[] = [];
    try { deps(s, logs).spend("0.19.2"); } finally { chmodSync(join(d, "link/keeper-drill-spent"), 0o700); }
    expect(logs[0]).toContain("(EACCES, open, ");
    expect(logs[0]).toContain("keeper-drill-spent/.high-water");
    expect(logs[0]).toContain(".tmp): nothing is installed");
  });
  test("spend: a refused intent that can't be read logs why, without its contents", () => {
    const { d, s } = store();
    mkdirSync(join(d, "link"), { recursive: true });
    writeFileSync(join(d, "link/keeper-drill-refused.json"), "{not json, private words");
    const logs: string[] = [];
    expect(deps(s, logs).spend("0.19.2")).toEqual({ error: "the refused drill intent can't be read, so nothing was installed" });
    expect(logs).toEqual(["the refused drill intent can't be read (SyntaxError): nothing is installed"]);
    // and one that is a folder: the code and path
    const b = store();
    mkdirSync(join(b.d, "link/keeper-drill-refused.json"), { recursive: true });
    const logs2: string[] = [];
    deps(b.s, logs2).spend("0.19.2");
    expect(logs2[0]).toMatch(/^the refused drill intent can't be read \(EISDIR, read, .*keeper-drill-refused\.json\): nothing is installed$/);
  });
  test("a refusal that can't be kept says why in the one line it writes", () => {
    const { d, s } = store();
    const flagPath = join(d, "trust/keeper-drill.json");
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFileSync(flagPath, "drl1.garbage.sig");           // a damaged flag: refused, its intent kept
    const logs: string[] = [];
    // storeRefused fails as a read-only /data would (root writes through a mode, so the error is made here)
    const bad = { ...s, storeRefused: () => { throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS", syscall: "open", path: "/data/link/keeper-drill-refused.json.tmp" }); } };
    const out = deps(bad, logs).spend("0.19.2");
    expect("error" in out).toBe(true);
    const line = logs.find((l) => l.startsWith("a drill flag was refused"))!;
    if (!line) throw new Error(logs.join(" | "));
    expect(line).toMatch(/the refusal couldn't be kept \(EROFS, open, \/data\/link\/keeper-drill-refused\.json\.tmp; the next install reads the flag again\)$/);
    expect(line).not.toContain("garbage");
  });
  test("an aborted record that can't be written says why (the link's and the run script's helper)", async () => {
    const { d } = store();
    mkdirSync(join(d, "trust/aborted.jsonl"), { recursive: true });   // a folder where the log goes
    const logs: string[] = [];
    const s = fileStore(join(d, "trust/f"), join(d, "trust/m"), join(d, "link/spent"), join(d, "trust/aborted.jsonl"), Date.now, join(d, "link/r.json"));
    deps(s, logs).aborted("drill-1-cain-0123abcd", "0.19.2", "its mark couldn't be written");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^the drill attempt drill-1-cain-0123abcd is aborted, but its record couldn't be written \(EISDIR, open, .*aborted\.jsonl\): its mark couldn't be written$/);
    // the helper (bun drill.ts mode): an abort whose record fails still aborts, and says why
    const { makeMark, drillKeyFrom } = await import("../rootfs/opt/cain/link/drill");
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const dk = drillKeyFrom(generateKeyPairSync("ed25519").privateKey);
    const now = Date.now();
    const text = makeMark({ version: "0.19.2", attempt: "drill-1-cain-0123abcd", mode: "exit-on-start" }, now, (b) => sign(null, b, dk.priv));
    const hl: string[] = [];
    const out = await helperMode({ version: "0.19.2", now: () => now, sleep: async () => {}, loadMark: () => text, dropMark: () => {}, pub: () => dk.pub, ask: null,
      abortedFor: () => false, aborted: () => { throw Object.assign(new Error("x"), { code: "ENOSPC", syscall: "write", path: "/data/trust/keeper-drill-aborted.jsonl" }); }, log: (m) => hl.push(m) });
    expect(out).toBe("abort");
    expect(hl).toHaveLength(1);
    expect(hl[0]).toContain("is aborted (its record couldn't be written: ENOSPC, write, /data/trust/keeper-drill-aborted.jsonl): no keeper_token is set");
  });
});

describe("a stray temp that isn't a regular file is recovered", () => {
  test("a folder in the high-water temp's place: removed, logged once, and the install's spend goes on", () => {
    const { d, s, logs } = store();
    const tmp = join(d, "link/keeper-drill-spent/.high-water.tmp");
    mkdirSync(join(tmp, "inner"), { recursive: true });
    writeFileSync(join(tmp, "inner/x"), "x");
    const dl: string[] = [];
    expect(deps(s, dl).spend("0.19.2")).toEqual({ mode: null });
    expect(dl).toEqual([]);
    expect(logs).toEqual([`a stray temp (a folder) stood in the drill store's way at ${tmp}: removed, and the write goes on`]);
    expect(existsSync(tmp)).toBe(false);
    expect(Number(readFileSync(join(d, "link/keeper-drill-spent/.high-water"), "utf8"))).toBeGreaterThan(0);
    // the next write finds nothing stray: no second line
    s.storeFlag("x");
    expect(logs).toHaveLength(1);
  });
  test("a link in the flag temp's place is removed, not followed; the flag is written 0600", () => {
    const { d, s, logs } = store();
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFileSync(join(d, "target"), "keep me");
    symlinkSync(join(d, "target"), join(d, "trust/keeper-drill.json.tmp"));
    s.storeFlag("drl1.a.b");
    expect(readFileSync(join(d, "target"), "utf8")).toBe("keep me");
    expect(readFileSync(join(d, "trust/keeper-drill.json"), "utf8")).toBe("drl1.a.b");
    expect(statSync(join(d, "trust/keeper-drill.json")).mode & 0o777).toBe(0o600);
    expect(logs).toEqual([`a stray temp (a link) stood in the drill store's way at ${join(d, "trust/keeper-drill.json.tmp")}: removed, and the write goes on`]);
  });
  test("the mark's public half recovers the same way, and the link passes its log to the store", () => {
    const d = mkdtempSync(join(tmpdir(), "drs-"));
    mkdirSync(join(d, "mark.pub.tmp"));
    const logs: string[] = [];
    storeMarkPub("pubkey", join(d, "mark.pub"), (l) => logs.push(l));
    expect(readFileSync(join(d, "mark.pub"), "utf8")).toBe("pubkey\n");
    expect(logs).toHaveLength(1);
    const main = readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toContain("`${DIR}/keeper-drill-refused.json`,\n  (l) => console.log(`[cain] link: ${l}`));");
    expect(main).toContain("storeMarkPub(drillKey.pub, DRILL_MARK_PUB, (l) => console.log(`[cain] link: ${l}`))");
  });
});
