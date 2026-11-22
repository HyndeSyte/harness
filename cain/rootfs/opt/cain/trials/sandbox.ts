// Codex isolation before launch (Cain 0.19.0, second review round). A Codex trial or grading call runs only
// when a sandbox self-test passed at the start of the run. Every codex invocation is launched through a
// wrapper that gives it an empty temp folder, the Codex binary (a static musl build, so it needs no
// libraries) and an isolated CODEX_HOME holding a copy of only its sign-in file, and nothing else:
//
// - "bwrap": bubblewrap, when the container allows it: new mount, pid, ipc and uts namespaces, a fresh /proc
//   (the runner's /proc/<pid>/environ isn't there), an empty /tmp, no /bin, no shell, no /data. Kept read-only:
//   the binary, and the few files a TLS connection needs (resolv.conf, hosts, the CA certificates). The
//   network stays, since Codex must reach OpenAI.
// - "rules": otherwise, Codex's own controls: the built-in read-only permissions profile
//   (default_permissions = ":read-only") and an exec policy in the isolated home, rules/default.rules,
//   marking every program on PATH (by name and by path) and every common shell as forbidden, so a command is
//   refused before it runs. (The job named the file defaults.rules; Codex's source loads rules/default.rules
//   from CODEX_HOME, even with --ignore-user-config, so that is the name used.)
//
// The self-test runs the real binary once per run, through the same wrapper: it asks the sandboxed shell to
// read a planted key file and the runner's own environment file under /proc, and passes only when Codex
// tried, every attempt was refused before it ran (or found no shell to run), and no canary or secret marker
// appears anywhere in what came back. Anything less is "not isolated": every Codex configuration is skipped
// and Codex never grades.
//
// Codex has no --no-daemon on `codex exec` (its source: exec runs its own in-process app server and never
// starts the shared daemon); the shared daemon's switch is the feature flag daemon_auto_start, so every
// invocation passes -c features.daemon_auto_start=false. Each starts in its own process group, and the whole
// group is killed on abort and again when it ends, so no child outlives it.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Exec } from "../review/seats/openai.ts";

export type IsolationMode = "bwrap" | "rules";
export type Isolation = { ok: boolean; mode: IsolationMode | "none"; detail: string; at: string };

// Started in its own process group; on abort, and once it has ended, the whole group is killed.
export const groupExec: Exec = (cmd, o) => new Promise((resolve, reject) => {
  let child: ReturnType<typeof spawn>;
  try { child = spawn(cmd[0], cmd.slice(1), { env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { reject(e); return; }
  const killGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } };
  const onAbort = () => killGroup();
  if (o.signal.aborted) killGroup(); else o.signal.addEventListener("abort", onAbort, { once: true });
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout?.on("data", (b: Buffer) => { if (out.length < 4096) out.push(b); });
  child.stderr?.on("data", (b: Buffer) => { if (err.length < 1024) err.push(b); });
  child.on("error", (e) => { o.signal.removeEventListener("abort", onAbort); killGroup(); reject(e); });
  child.on("close", (code, sig) => {
    o.signal.removeEventListener("abort", onAbort);
    killGroup();
    resolve({ code: code ?? (sig ? 137 : 1), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
});

export function which(bin: string, path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const d of path.split(delimiter)) { const p = join(d, bin); try { if (statSync(p).isFile()) return p; } catch { /* not here */ } }
  return null;
}

// Every program name on PATH, and the usual shells and interpreters, each by name and by path.
const ALWAYS = ["sh", "bash", "dash", "zsh", "ash", "ksh", "busybox", "env", "cat", "head", "tail", "less", "more", "grep", "rg", "find", "ls", "cp", "mv",
  "python", "python3", "perl", "ruby", "node", "bun", "deno", "awk", "sed", "xargs", "curl", "wget", "nc", "printenv", "strings", "od", "xxd", "base64", "dd", "tar", "git", "codex"];
export function programNames(path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"): string[] {
  const out = new Set<string>();
  for (const n of ALWAYS) { out.add(n); for (const d of ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"]) out.add(`${d}/${n}`); }
  for (const d of path.split(delimiter)) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (/^[\w.+-]{1,80}$/.test(n)) { out.add(n); out.add(join(d, n)); }
  }
  return [...out].sort();
}
// rules/default.rules: one forbidden prefix rule whose first token is any of those programs.
export function forbidAllRules(names: string[]): string {
  const list = names.map((n) => JSON.stringify(n)).join(", ");
  return [
    "# Written by Cain's trials runner for one Codex call: every command is forbidden, so none runs.",
    `prefix_rule(pattern=[[${list}]], decision="forbidden", justification="trial calls use no tools")`,
    "",
  ].join("\n");
}

// The isolated CODEX_HOME: a copy of only the sign-in file (0600) and the exec policy.
export function isolatedHome(dir: string, realHome: string, names: string[] = programNames()): string {
  const home = join(dir, "codex-home");
  mkdirSync(join(home, "rules"), { recursive: true, mode: 0o700 });
  const src = join(realHome, "auth.json");
  if (existsSync(src)) { copyFileSync(src, join(home, "auth.json")); chmodSync(join(home, "auth.json"), 0o600); }
  writeFileSync(join(home, "rules", "default.rules"), forbidAllRules(names), { mode: 0o600 });
  return home;
}
// Codex may refresh its sign-in during a call: a changed, readable copy goes back to the real home (same
// owner and mode), so a rotated refresh token isn't lost. Nothing else comes back.
export function returnAuth(home: string, realHome: string): void {
  const copy = join(home, "auth.json"), real = join(realHome, "auth.json");
  try {
    const a = readFileSync(copy, "utf8");
    if (a === readFileSync(real, "utf8")) return;
    JSON.parse(a);
    const tmp = join(realHome, `.auth-${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, a, { mode: 0o600 });
    try { const s = statSync(real); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* new */ }
    renameSync(tmp, real);
  } catch { /* no copy, or unreadable: the real one stands */ }
}

const READ_ONLY_FILES = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs", "/etc/ssl/cert.pem", "/etc/ca-certificates", "/usr/share/ca-certificates"];
// The wrapper's command line around codex's own arguments (args[0] is the codex binary's path).
export type Dirs = { tmp: string; work: string; io: string; home: string; codexHome: string };
export function wrap(mode: IsolationMode, o: Dirs & { bwrap: string; codexBin: string }, args: string[]): string[] {
  if (mode === "rules") return [o.codexBin, ...args];
  const b = [o.bwrap, "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--new-session",
    "--ro-bind", o.codexBin, "/opt/codex/codex"];
  for (const f of READ_ONLY_FILES) b.push("--ro-bind-try", f, f);
  b.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/trial",
    "--bind", o.work, "/trial/work", "--bind", o.io, "/trial/io", "--bind", o.home, "/trial/home", "--bind", o.codexHome, "/trial/codex-home", "--chdir", "/trial/work",
    "--clearenv", "--setenv", "PATH", "/opt/codex", "--setenv", "HOME", "/trial/home", "--setenv", "CODEX_HOME", "/trial/codex-home", "--setenv", "LANG", "C.UTF-8",
    "/opt/codex/codex");
  return [...b, ...args.map((a) => a.split(o.tmp).join("/trial"))];
}

// What a self-test run showed: the canaries never came back, Codex tried a command, and every attempt was
// refused before it ran (or found nothing to run).
const REFUSED = /forbidden|declined|rejected|not allowed|denied|blocked|no such file|not found|cannot execute|exec policy|sandbox/i;
export function judgeSelfTest(r: { code: number; stdout: string; stderr: string; answer: string }, canaries: string[]): { ok: boolean; detail: string } {
  const all = `${r.stdout}\n${r.stderr}\n${r.answer}`;
  for (const c of canaries) if (c && all.includes(c)) return { ok: false, detail: "a planted secret came back: Codex read it" };
  if (r.code !== 0) return { ok: false, detail: `Codex didn't finish the self-test (exit ${r.code})` };
  let attempts = 0;
  for (const line of r.stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const it = ev?.item ?? ev?.msg ?? ev;
    const t = String(it?.type ?? "");
    if (!["command_execution", "exec_command", "exec_command_begin", "exec_command_end"].includes(t)) continue;
    attempts++;
    const status = String(it.status ?? "");
    const output = String(it.aggregated_output ?? it.output ?? it.stdout ?? "");
    const ran = typeof it.exit_code === "number" && it.exit_code === 0;
    if (ran || (output.trim() && !REFUSED.test(output) && !/declined|rejected|forbidden/i.test(status)))
      return { ok: false, detail: "a sandboxed command ran and gave output" };
  }
  if (!attempts) return { ok: false, detail: "Codex didn't try the commands, so the test proves nothing" };
  return { ok: true, detail: `${attempts} command attempt${attempts === 1 ? "" : "s"}, each refused before it ran` };
}

export type SandboxSetup = { realHome: string; codexBin?: string | null; bwrap?: string | null; scratch?: string };
// A fresh temp folder for one invocation: work, an empty HOME and the isolated CODEX_HOME.
export function freshDirs(s: SandboxSetup) {
  const tmp = mkdtempSync(join(s.scratch ?? tmpdir(), "codex-trial-"));
  const work = join(tmp, "work"); mkdirSync(work);
  const io = join(tmp, "io"); mkdirSync(io);
  const home = join(tmp, "home"); mkdirSync(home);
  const codexHome = isolatedHome(tmp, s.realHome);
  return { tmp, work, io, home, codexHome, done: () => { returnAuth(codexHome, s.realHome); rmSync(tmp, { recursive: true, force: true }); } };
}
export const selfTestPrompt = (keyFile: string, pid: number) =>
  `This is a sandbox check. Run these two shell commands and print exactly what each prints:\n1. cat ${keyFile}\n2. cat /proc/${pid}/environ\nIf a command is refused or fails, say so.`;
