// The PC side of the job queue. The worker does every check and every git operation, and
// it starts the browser session itself: a Claude Code session (the `claude` command line)
// with Claude in Chrome, locked by a pinned settings file to the read-only Claude in
// Chrome tools, with no shell, no file tools and no web tools, under a hard time limit.
// The model in it does only the browser step and prints what it saw; the worker checks
// that and writes the result. Every check is here, in code, not left to the model.
//
// Commands (cain/docs/pc-jobs.md):
//   worker.ts run [--attended] [--diagnose]   one run: preflight, claim at most one job, run its browser step, write its result.
//                                             Windows Task Scheduler runs it every 15 minutes. Without --attended it does
//                                             nothing (attended_only) until the owner has allowed unattended runs.
// Commands only the owner runs, by hand:
//   worker.ts probe --attended          the supervised probe: the only way to the first confirm-profile (no queued job runs)
//   worker.ts confirm-profile           records the probe's evidence as the profile's fingerprint and the pinned hashes
//   worker.ts owner-keygen --kid <id> --out <dir>      his allowlist key (passphrase in PC_OWNER_PASSPHRASE)
//   worker.ts owner-fpr <owner.pub>     the fingerprint of his allowlist key, for install.json
//   worker.ts sign-allowlist <entries.json> --key <pem> --kid <id> --out <allowlist.json>
//
// Every command takes --home <worker folder> (default PC_WORKER_HOME, else the current
// folder), which holds: install.json (the owner's install config, written once at setup),
// queue/ (the clone, its remote on the PC's deploy key), allowlist.json, owner.pub,
// ship.pub, confirmed.json and probe-evidence.json (the profile confirmation), canary/
// (the per-run canary page), and the worker's own STOP (the kill switch), worker.lock,
// heartbeat.json, worker.log and, only when asked, diagnostics.log.
//
// Nothing raw leaves the worker: no page text, no git or browser error text. What it
// prints, logs and pushes is fixed words, ids and reason codes. Runs on Bun, or on Node
// 22.18 or later (which runs TypeScript as is); paths are joined, never written with a
// slash, so it runs the same on Windows.
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import {
  canonical, checkFacts, factsFor, isReadOnly, jobText, keyFingerprint, LEASE_MS, newAttempt, onLogin, onPin, onSite, parseAllowlist,
  parseHeartbeat, parseJob, parseKeys, parseResult, pinFor, resultText, sanitizeUrl, signAllowlist, signerOf, SKEW_MS, stateAfter,
  attributesGood, ID, ATTEMPT, KID, TOOL,
  type Allow, type Checked, type Code, type FactType, type Handoff, type Heartbeat, type Job, type Result, type Status,
} from "./core.ts";
import { publicOf } from "../link/shipkey.ts";

// ---- Options, paths, errors -----------------------------------------------------------
export interface Session { code: number | null; out: string; timedOut: boolean }
export type Launch = (argv: string[], cwd: string, timeoutMs: number) => Promise<Session>;

export interface Opts {
  home: string;
  branch?: string;
  now?: () => Date;
  mono?: () => number;                              // a monotonic clock in ms (performance.now unless a test stands in)
  attended?: boolean;                               // the owner is watching
  diagnose?: boolean;                               // the owner's local diagnostic capture
  sleep?: (ms: number) => void;
  rand?: () => number;
  files?: { settings: string; prompt: string };     // the session's settings and prompt (this repo's copies unless a test stands in)
  launch?: Launch;                                  // starts the browser session (launchSession unless a test stands in)
  acl?: (path: string) => string[] | null;          // Windows: the writers of a path (aclWriters unless a test stands in)
  chromeDirs?: string[];                            // the other Chrome user data folders to scan (defaultChromeDirs unless a test stands in)
  pidAlive?: (pid: number) => boolean;
  platform?: string;
  skew?: (all: Job[], now: Date) => number | null;  // how far the keeper's clock runs ahead (skewMs unless a test stands in)
}

export class WorkerError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const P = {
  install: (o: Opts) => join(o.home, "install.json"),
  queue: (o: Opts) => join(o.home, "queue"),
  allow: (o: Opts) => join(o.home, "allowlist.json"),
  owner: (o: Opts) => join(o.home, "owner.pub"),
  ship: (o: Opts) => join(o.home, "ship.pub"),
  confirmed: (o: Opts) => join(o.home, "confirmed.json"),
  evidence: (o: Opts) => join(o.home, "probe-evidence.json"),
  canary: (o: Opts) => join(o.home, "canary"),
  cwd: (o: Opts) => join(o.home, "session"),
  stop: (o: Opts) => join(o.home, "STOP"),
  lock: (o: Opts) => join(o.home, "worker.lock"),
  beat: (o: Opts) => join(o.home, "heartbeat.json"),
  log: (o: Opts) => join(o.home, "worker.log"),
  diag: (o: Opts) => join(o.home, "diagnostics.log"),
  denyCheck: (o: Opts) => join(o.home, "deny-check"),
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const SESSION_FILES = {
  settings: resolve(HERE, "..", "..", "..", "..", "docs", "pc-worker", "session-settings.json"),
  prompt: resolve(HERE, "..", "..", "..", "..", "docs", "pc-worker", "session-prompt.md"),
};

const clock = (o: Opts) => o.now?.() ?? new Date();
const mono = (o: Opts) => o.mono?.() ?? performance.now();
const platform = (o: Opts) => o.platform ?? process.platform;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const word = (n: number, rand: () => number = Math.random) =>
  Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36) % 36]).join("");
const exists = (f: string) => { try { lstatSync(f); return true; } catch { return false; } };
const readJson = (f: string): any => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// How long a browser step may take, at most: well inside a lease, so the run gives up
// (and kills the session) before the keeper's clock could call the claim over.
export const MAX_SESSION_MS = LEASE_MS - 2 * SKEW_MS - 5 * 60_000;     // 21 minutes
// A lock older than this is from a run that died or hung, whatever its process.
export const LOCK_STALE_MS = LEASE_MS + SKEW_MS;

// ---- The owner's install config -------------------------------------------------------
// install.json, written by the owner once at setup (cain/docs/pc-worker/install.example.json),
// held so that only he, SYSTEM and Administrators can write it (checked every run):
//   owner_fpr: his allowlist key's fingerprint (worker.ts owner-fpr owner.pub); owner.pub must match it.
//   claude: the path of the claude command (claude.exe on Windows).
//   session_minutes: the browser step's hard time limit (at most MAX_SESSION_MS).
//   unattended: false until he has watched a probe whose deny check passed (see below).
//   confirm_path: always false in this version: the confirm path's code can't be reached.
//   diagnostics: false; true turns on the local diagnostic capture for the first probes.
//   profile: the dedicated Chrome profile (user_data_dir, profile_directory, profile_name,
//            extension_id, chrome_path or null).
//   other_user_data_dirs: Chrome folders to scan besides the usual ones.
export interface Install {
  v: 1; owner_fpr: string; claude: string; session_minutes: number; unattended: boolean; confirm_path: false; diagnostics: boolean;
  profile: { user_data_dir: string; profile_directory: string; profile_name: string; extension_id: string; chrome_path: string | null };
  other_user_data_dirs: string[];
}
const INSTALL_KEYS = ["v", "owner_fpr", "claude", "session_minutes", "unattended", "confirm_path", "diagnostics", "profile", "other_user_data_dirs"];
const PROFILE_KEYS = ["user_data_dir", "profile_directory", "profile_name", "extension_id", "chrome_path"];
const str = (x: unknown) => typeof x === "string" && x.length > 0 && x.length < 400 && !/[\u0000-\u001f]/.test(x);
const same = (o: any, keys: string[]) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");

export function parseInstall(x: any): Install | null {
  if (!same(x, INSTALL_KEYS) || x.v !== 1 || typeof x.owner_fpr !== "string" || !/^[0-9a-f]{64}$/.test(x.owner_fpr) || !str(x.claude)
    || !Number.isInteger(x.session_minutes) || x.session_minutes < 1 || x.session_minutes * 60_000 > MAX_SESSION_MS
    || typeof x.unattended !== "boolean" || x.confirm_path !== false || typeof x.diagnostics !== "boolean"
    || !Array.isArray(x.other_user_data_dirs) || x.other_user_data_dirs.length > 10 || !x.other_user_data_dirs.every(str)) return null;
  const p = x.profile;
  if (!same(p, PROFILE_KEYS) || !str(p.user_data_dir) || !str(p.profile_directory) || !str(p.profile_name) || !/^[a-p]{32}$/.test(p.extension_id ?? "")
    || !(p.chrome_path === null || str(p.chrome_path))) return null;
  return x as Install;
}
const loadInstall = (o: Opts) => parseInstall(readJson(P.install(o)));

// ---- Who can write the trusted files --------------------------------------------------
// The allowlist, owner.pub, install.json, confirmed.json and the worker folder itself.
// POSIX: no group or other write. Windows: their ACLs (Get-Acl, through PowerShell) give
// write to no one but the current user, SYSTEM and Administrators.
const WRITE_RIGHTS = /FullControl|Modify|Write|CreateFiles|CreateDirectories|AppendData|Delete|ChangePermissions|TakeOwnership|GenericAll|GenericWrite|^\d+$|-\d+/i;

// From Get-Acl's lines ("Allow|BUILTIN\Users|ReadAndExecute, Synchronize"), the principals
// that may write, other than the trusted ones. A line that can't be read counts as one.
export function untrustedWriters(lines: string[], user: string): string[] {
  const ok = new Set(["nt authority\\system", "builtin\\administrators", user.toLowerCase()]);
  const out: string[] = [];
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    const [type, who, rights] = l.split("|");
    if (!type || !who || rights === undefined) { out.push("unreadable"); continue; }
    if (type.trim().toLowerCase() !== "allow") continue;
    if (rights.split(",").some((r) => WRITE_RIGHTS.test(r.trim())) && !ok.has(who.trim().toLowerCase())) out.push(who.trim());
  }
  return out;
}

export function aclWriters(path: string): string[] | null {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Acl -LiteralPath $env:PCW_PATH).Access | ForEach-Object { \"$($_.AccessControlType)|$($_.IdentityReference.Value)|$($_.FileSystemRights)\" }"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PCW_PATH: path }, timeout: 30_000 });
    return out.split(/\r?\n/);
  } catch { return null; }
}

export function filesTrusted(o: Opts): boolean {
  const files = [P.allow(o), P.owner(o), P.install(o), o.home, ...(exists(P.confirmed(o)) ? [P.confirmed(o)] : [])];
  for (const f of files) {
    if (!exists(f)) return false;
    if (platform(o) === "win32") {
      const lines = (o.acl ?? aclWriters)(f);
      const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
      if (!lines || untrustedWriters(lines, user).length) return false;
    } else {
      try { if ((statSync(f).mode & 0o022) !== 0) return false; } catch { return false; }
    }
  }
  return true;
}

// ---- The owner's allowlist ------------------------------------------------------------
// Signed by his own key; owner.pub holds its public half, which must be the key whose
// fingerprint he pinned in install.json.
export function ownerKeys(o: Opts, inst: Install): Map<string, KeyObject> | null {
  let text = "";
  try { text = readFileSync(P.owner(o), "utf8"); } catch { return null; }
  const keys = parseKeys(text);
  if (keys.size !== 1) return null;
  const [k] = [...keys.values()];
  return keyFingerprint(k) === inst.owner_fpr ? keys : null;
}

export function loadAllowlist(o: Opts, keys: Map<string, KeyObject>): Checked<Allow[]> {
  let text = "";
  try { text = readFileSync(P.allow(o), "utf8"); } catch { return { ok: false, why: "missing" }; }
  return parseAllowlist(text, keys);
}

// ---- The session's pinned settings and prompt -----------------------------------------
// Both are hashed over canonical bytes (the settings as canonical JSON, the prompt with
// LF line endings), so a checkout's line endings don't matter and any other change does.
export function sessionHashes(o: Opts): { settings_sha256: string; prompt_sha256: string; settings: any; prompt: string } | null {
  const f = o.files ?? SESSION_FILES;
  try {
    const settings = JSON.parse(readFileSync(f.settings, "utf8"));
    const prompt = readFileSync(f.prompt, "utf8").replace(/\r\n/g, "\n");
    const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    return { settings_sha256: h(canonical(settings)), prompt_sha256: h(prompt), settings, prompt };
  } catch { return null; }
}

// The Claude in Chrome tools the settings allow, by short name (navigate, read_page...).
// Only tools of the extension: anything else in its allow list makes it untrusted.
export const CHROME = "mcp__claude-in-chrome__";
export function allowedTools(settings: any): string[] | null {
  const allow = settings?.permissions?.allow, deny = settings?.permissions?.deny;
  if (!Array.isArray(allow) || !Array.isArray(deny) || !allow.every((t: unknown) => typeof t === "string" && t.startsWith(CHROME))) return null;
  const short = allow.map((t: string) => t.slice(CHROME.length));
  if (!short.every((t: string) => TOOL.test(t))) return null;
  for (const must of ["Bash", "PowerShell", "Edit", "Write", "Read", "WebFetch", "WebSearch", `${CHROME}computer`, `${CHROME}form_input`, `${CHROME}javascript_tool`])
    if (!deny.includes(must)) return null;
  return short;
}

// ---- The dedicated Chrome profile: a fingerprint ----------------------------------------
// The user data folder (resolved), the profile's name, the extension's id and version,
// and Chrome's major version. confirm-profile records it; every preflight recomputes it
// and fails closed (profile_changed) if any part differs.
export interface Fingerprint { user_data_dir: string; profile_name: string; extension_id: string; extension_version: string; chrome_major: number }
const FP_KEYS = ["user_data_dir", "profile_name", "extension_id", "extension_version", "chrome_major"];

const vparts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
const vcmp = (a: string, b: string) => { const x = vparts(a), y = vparts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };

export function fingerprint(inst: Install): Fingerprint | null {
  const p = inst.profile;
  const dir = join(p.user_data_dir, p.profile_directory);
  const name = readJson(join(dir, "Preferences"))?.profile?.name ?? "";
  if (name !== p.profile_name) return null;
  let versions: string[] = [];
  try { versions = readdirSync(join(dir, "Extensions", p.extension_id)).filter((v) => /^\d+(\.\d+){0,3}(_\d+)?$/.test(v)).map((v) => v.replace(/_\d+$/, "")); } catch { return null; }
  if (!versions.length) return null;
  const extension_version = versions.sort(vcmp).at(-1)!;
  let chrome_major = 0;
  try { chrome_major = parseInt(readFileSync(join(p.user_data_dir, "Last Version"), "utf8").trim().split(".")[0], 10) || 0; } catch { chrome_major = 0; }
  if (!chrome_major) return null;
  return { user_data_dir: resolve(p.user_data_dir), profile_name: name, extension_id: p.extension_id, extension_version, chrome_major };
}

// The usual Chrome user data folders on this machine (the daily profile among them).
export function defaultChromeDirs(plat = process.platform): string[] {
  const h = homedir();
  if (plat === "win32") {
    const l = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome SxS", "Chromium"].map((d) => join(l, ...d.split("/"), "User Data"));
  }
  if (plat === "darwin") return ["Google/Chrome", "Google/Chrome Beta", "Chromium"].map((d) => join(h, "Library", "Application Support", ...d.split("/")));
  return ["google-chrome", "google-chrome-beta", "chromium"].map((d) => join(h, ".config", d));
}

// The extension anywhere but the dedicated folder: installed (its folder) or listed in
// a profile's preferences, in any profile of any other user data folder.
export function extensionElsewhere(o: Opts, inst: Install): boolean {
  const mine = resolve(inst.profile.user_data_dir).toLowerCase();
  const id = inst.profile.extension_id;
  for (const udd of [...(o.chromeDirs ?? defaultChromeDirs(platform(o))), ...inst.other_user_data_dirs]) {
    if (resolve(udd).toLowerCase() === mine) continue;
    let profiles: string[] = [];
    try { profiles = readdirSync(udd).filter((n) => n === "Default" || /^Profile \d+$/.test(n) || /^Guest Profile$/.test(n)); } catch { continue; }
    for (const pr of profiles) {
      if (exists(join(udd, pr, "Extensions", id))) return true;
      for (const f of ["Preferences", "Secure Preferences"]) {
        const prefs = readJson(join(udd, pr, f));
        if (prefs?.extensions?.settings && Object.hasOwn(prefs.extensions.settings, id)) return true;
      }
    }
  }
  return false;
}

const chromeRunning = (udd: string) => ["lockfile", "SingletonLock", "SingletonSocket"].some((n) => exists(join(udd, n)));

// confirmed.json, written by confirm-profile from a passing probe.
export interface Confirmed { v: 1; at: string; fingerprint: Fingerprint; settings_sha256: string; prompt_sha256: string; canary: string; deny_check: boolean }
export function readConfirmed(o: Opts): Confirmed | null {
  const c = readJson(P.confirmed(o));
  if (!same(c, ["v", "at", "fingerprint", "settings_sha256", "prompt_sha256", "canary", "deny_check"]) || c.v !== 1 || !same(c.fingerprint, FP_KEYS)
    || typeof c.canary !== "string" || !/^[a-z0-9]{16}$/.test(c.canary) || typeof c.deny_check !== "boolean") return null;
  return c as Confirmed;
}

// The browser preflight. bypassConfirm is the supervised probe's: everything but the
// missing confirmation (and the pinned hashes it would hold) is checked.
export function browserPreflight(o: Opts, inst: Install, bypassConfirm = false): Code | null {
  const fp = fingerprint(inst);
  if (!fp) return "wrong_profile";
  if (extensionElsewhere(o, inst)) return "extension_elsewhere";
  if (!chromeRunning(inst.profile.user_data_dir) && inst.profile.chrome_path) {
    try {
      spawn(inst.profile.chrome_path, [`--user-data-dir=${resolve(inst.profile.user_data_dir)}`, `--profile-directory=${inst.profile.profile_directory}`],
        { detached: true, stdio: "ignore" }).on("error", () => { /* stays unreachable */ }).unref();
      (o.sleep ?? sleepSync)(8_000);
    } catch { /* stays unreachable */ }
  }
  if (!chromeRunning(inst.profile.user_data_dir)) return "browser_unreachable";
  if (bypassConfirm) return null;
  const c = readConfirmed(o);
  if (!c) return "profile_unconfirmed";
  if (canonical(c.fingerprint) !== canonical(fp)) return "profile_changed";
  const h = sessionHashes(o);
  if (!h || h.settings_sha256 !== c.settings_sha256 || h.prompt_sha256 !== c.prompt_sha256 || !allowedTools(h.settings)) return "untrusted_config";
  if (!o.attended && !(inst.unattended && c.deny_check)) return "attended_only";
  return null;
}

// ---- One run at a time, the heartbeat, the log -----------------------------------------
// One process holds the lock for the whole run. A lock whose process is gone, or older
// than a lease, is from a run that died or hung: it is cleared, and the heartbeat says so.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as any)?.code === "EPERM"; } };

function lock(o: Opts, now: Date): { got: boolean; stale: boolean } {
  const f = P.lock(o);
  let stale = false;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
      closeSync(fd);
      return { got: true, stale };
    } catch {
      const l = readJson(f);
      const at = Date.parse(l?.at ?? "");
      const pid = Number.isSafeInteger(l?.pid) ? l.pid : 0;
      const old = !Number.isFinite(at) || now.getTime() - at >= LOCK_STALE_MS;
      const dead = pid > 0 && pid !== process.pid && !(o.pidAlive ?? alive)(pid);
      if (!old && !dead) return { got: false, stale };
      rmSync(f, { force: true });
      stale = true;
    }
  }
  return { got: false, stale };
}
const unlock = (o: Opts) => rmSync(P.lock(o), { force: true });

interface RunState { stale: boolean; skew: number | null }

function beat(o: Opts, code: Heartbeat["code"], job: string | null, now: Date, st: RunState): Heartbeat {
  const h: Heartbeat = { v: 1, worker_clock: now.toISOString(), code, job, stale_lock: st.stale, skew_ms: st.skew };
  try {
    mkdirSync(o.home, { recursive: true });
    writeFileSync(P.beat(o), JSON.stringify(h) + "\n");
    const f = P.log(o);
    if (exists(f) && statSync(f).size > 200_000) writeFileSync(f, readFileSync(f, "utf8").slice(-100_000));
    appendFileSync(f, `${h.worker_clock} ${code} ${job ?? "-"}${st.stale ? " stale_lock" : ""}\n`);
  } catch { /* the heartbeat never stops a run */ }
  return h;
}

// The owner's local diagnostic capture: off unless he asks. One line per run: the code,
// the final address with any run of digits masked, and the name of the field that failed
// validation. Never page text. It stays in the worker folder, outside the queue repo.
function diagnose(o: Opts, inst: Install | null, now: Date, job: string, code: Code, url: string | null, field: string | null) {
  if (!o.diagnose && !inst?.diagnostics) return;
  const masked = url ? url.replace(/\d+/g, "#") : "-";
  try { appendFileSync(P.diag(o), `${now.toISOString()} ${job} ${code} final_url=${masked} field=${field ?? "-"}\n`); } catch { /* never stops a run */ }
}

// ---- git, with retries ------------------------------------------------------------------
const TRANSIENT = /index\.lock|\.lock'?: File exists|cannot lock|unable to (create|unlink)|Permission denied|being used by another process|Resource temporarily unavailable|Device or resource busy|Could not resolve host|Connection (reset|timed out)|early EOF|remote end hung up/i;

function gitRaw(o: Opts, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=PC job worker", "-c", "user.email=HyndeSyte@users.noreply.github.com",
    "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", `core.hooksPath=${join(P.queue(o), ".git", "no-hooks")}`, ...args],
  { cwd: P.queue(o), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" } }).trim();
}

function git(o: Opts, args: string[], tries = 4): string {
  const wait = o.sleep ?? sleepSync;
  for (let i = 0; ; i++) {
    try { return gitRaw(o, args); }
    catch (e) {
      const text = String((e as any)?.stderr ?? "") + String((e as Error)?.message ?? "");
      if (i + 1 >= tries || !TRANSIENT.test(text)) throw new WorkerError("git_failed");
      wait(250 * 2 ** i);
    }
  }
}

const branch = (o: Opts) => o.branch ?? "main";

function update(o: Opts): boolean {
  const b = branch(o);
  if (!git(o, ["ls-remote", "--heads", "origin", b])) return false;
  git(o, ["fetch", "--quiet", "origin", b]);
  git(o, ["checkout", "--quiet", "-B", b, `origin/${b}`]);
  git(o, ["reset", "--quiet", "--hard", `origin/${b}`]);
  git(o, ["clean", "-qfd"]);
  return true;
}

function commitPush(o: Opts, message: string) {
  const b = branch(o);
  git(o, ["commit", "--quiet", "-m", message]);
  for (let i = 0; ; i++) {
    try { gitRaw(o, ["push", "--quiet", "origin", `HEAD:${b}`]); return; }
    catch {
      if (i >= 3) throw new WorkerError("git_failed");
      git(o, ["fetch", "--quiet", "origin", b]);
      try { gitRaw(o, ["rebase", "--quiet", `origin/${b}`]); }
      catch { try { gitRaw(o, ["rebase", "--abort"]); } catch { /* none */ } throw new WorkerError("lost_race"); }
    }
  }
}

const listed = (o: Opts, dir: string, re: RegExp) =>
  git(o, ["ls-files", "-z", dir]).split("\0").map((n) => re.exec(n)?.[1]).filter((x): x is string => !!x);

function jobs(o: Opts): Job[] {
  const out: Job[] = [];
  for (const id of listed(o, "jobs", /^jobs\/(j-\d{8}-[a-z0-9]{6})\.json$/)) {
    const j = parseJob(readFileSync(join(P.queue(o), "jobs", `${id}.json`), "utf8"));
    if (j.ok && j.value.id === id) out.push(j.value);
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
}
const cancels = (o: Opts) => new Set(listed(o, "cancels", /^cancels\/(j-\d{8}-[a-z0-9]{6})\.json$/));
const nonces = (o: Opts) => new Set(listed(o, "nonces", /^nonces\/([A-Za-z0-9_-]{22,64})\.json$/));

function put(o: Opts, rel: string[], text: string) {
  mkdirSync(join(P.queue(o), ...rel.slice(0, -1)), { recursive: true });
  writeFileSync(join(P.queue(o), ...rel), text);
  git(o, ["add", "--", rel.join("/")]);
}
const writeJob = (o: Opts, j: Job) => put(o, ["jobs", `${j.id}.json`], jobText(j));
const writeResult = (o: Opts, r: Result) => put(o, ["results", `${r.id}.json`], resultText(r));

const result = (job: Job, status: Status, code: Code, now: Date, extra: Partial<Result> = {}): Result => ({
  v: 1, id: job.id, attempt: job.attempt, status, code, handoff: null, worker_clock: now.toISOString(), final_url: null, facts: {},
  tools: [], attended: false, ...extra,
});

function close(o: Opts, job: Job, r: Result) {
  writeResult(o, r);
  writeJob(o, { ...job, state: stateAfter(job, r), lease_until: null });
}

function stageBeat(o: Opts, h: Heartbeat): boolean {
  let old: Heartbeat | null = null;
  try { old = parseHeartbeat(readFileSync(join(P.queue(o), "worker", "heartbeat.json"), "utf8")); } catch { old = null; }
  if (old && old.code === h.code && old.stale_lock === h.stale_lock && Date.parse(h.worker_clock) - Date.parse(old.worker_clock) < 24 * 3_600_000) return false;
  put(o, ["worker", "heartbeat.json"], JSON.stringify(h, null, 2) + "\n");
  return true;
}

// ---- One clock per decision ---------------------------------------------------------------
// The keeper's clock decides expiry (on the Pi); the worker's monotonic clock decides how
// long its own run may hold a claim. The worker still measures how far the keeper's clock
// runs ahead of its own (the keeper's newest commit and newest job can't be in the PC's
// future), records it in the heartbeat, and stops (clock_skew) past the allowance. A PC
// clock running ahead can't be seen this way; the keeper's own expiry covers that side.
export function skewMs(o: Opts, all: Job[], now: Date): number | null {
  let keeper = 0;
  try { keeper = parseInt(git(o, ["log", "-1", "--format=%ct", "--committer=Cain's PC job keeper"]), 10) * 1000 || 0; } catch { keeper = 0; }
  for (const j of all) keeper = Math.max(keeper, Date.parse(j.created));
  return keeper ? Math.max(0, keeper - now.getTime()) : null;
}

// ---- What the model is told, and what it may say back -------------------------------------
export const OUTCOMES = ["seen", "already_gone", "needs_login", "blocked_captcha", "pending_email_confirmation",
  "browser_unreachable", "wrong_profile", "not_as_expected", "uncertain"] as const;

const describe = (t: FactType) => t.t === "bool" ? "true or false" : t.t === "enum" ? `one of: ${t.of.join(", ")}`
  : t.t === "date" ? "a date, YYYY-MM-DD" : `a short token, at most ${t.max} characters, no spaces unless a label`;

export interface Instruction {
  id: string; attempt: string; site: string; action: string; start_url: string; look_for: string;
  facts: Record<string, string>; outcomes: readonly string[]; canary_url: string;
}

const instruction = (j: Job, canaryUrl: string): Instruction => ({
  id: j.id, attempt: j.attempt!, site: j.site, action: j.action, start_url: j.start_url, look_for: j.done_looks_like,
  facts: Object.fromEntries(Object.entries(factsFor(j)).map(([k, t]) => [k, describe(t)])), outcomes: OUTCOMES, canary_url: canaryUrl,
});

// Why a pending job can't run here, or null when it can. Expiry is the keeper's call: the
// worker only leaves alone a job that would run out within the skew of its own clock.
export function blocker(job: Job, allow: Checked<Allow[]>): { status: Status; code: Code } | null {
  if (!isReadOnly(job)) return { status: "refused", code: "action_not_read_only" };
  if (!allow.ok) return { status: "refused", code: "allowlist_unverified" };
  if (!pinFor(job, allow.value)) return { status: "refused", code: "not_allowlisted" };
  return null;
}

// ---- The preflight and the claim ------------------------------------------------------------
export interface Claim { job: Job; inst: Install; allow: Allow[]; claimedAt: number; st: RunState }
export interface NextOut { claim: Claim | null; closed: string[]; code: Heartbeat["code"] }

// Everything before a claim, and the claim. The lock is kept only when a job is claimed.
export function next(o: Opts): NextOut {
  const now = clock(o);
  const st: RunState = { stale: false, skew: null };
  const quit = (code: Heartbeat["code"]): NextOut => { beat(o, code, null, now, st); return { claim: null, closed: [], code }; };
  if (existsSync(P.stop(o))) return quit("stopped");
  const l = lock(o, now);
  st.stale = l.stale;
  if (!l.got) return quit("busy");
  let keep = false;
  try {
    const inst = loadInstall(o);
    if (!inst) return quit("untrusted_config");
    if (!filesTrusted(o)) return quit("untrusted_files");
    const keys = ownerKeys(o, inst);
    if (!keys) return quit("untrusted_config");
    if (!update(o)) return quit("idle");
    let attrs = "";
    try { attrs = readFileSync(join(P.queue(o), ".gitattributes"), "utf8"); } catch { attrs = ""; }
    if (!attributesGood(attrs)) return quit("queue_misconfigured");
    const all = jobs(o), cancelled = cancels(o), allow = loadAllowlist(o, keys);
    st.skew = (o.skew ?? ((js, t) => skewMs(o, js, t)))(all, now);
    if (st.skew !== null && st.skew > SKEW_MS) {
      // Cain should hear this one: the queue is up to date, so the heartbeat goes there too.
      if (stageBeat(o, beat(o, "clock_skew", null, now, st))) commitPush(o, "worker clock_skew");
      return { claim: null, closed: [], code: "clock_skew" };
    }
    const closed: string[] = [];
    let candidate: Job | null = null;
    for (const j of all) {
      if (j.state !== "pending") continue;
      if (cancelled.has(j.id)) { close(o, j, result(j, "cancelled", "cancelled", now)); closed.push(j.id); continue; }
      const b = blocker(j, allow);
      if (b) { close(o, j, result(j, b.status, b.code, now)); closed.push(j.id); continue; }
      if (Date.parse(j.expires) - SKEW_MS <= now.getTime()) continue;      // the keeper closes it
      candidate ??= j;
    }
    let run: Job | null = null;
    let code: Heartbeat["code"] = "idle";
    if (candidate) {
      const pre = browserPreflight(o, inst);
      if (pre) code = pre;
      else {
        run = { ...candidate, state: "claimed", attempt: newAttempt(o.rand), lease_until: new Date(now.getTime() + LEASE_MS).toISOString() };
        writeJob(o, run);
        code = "ok";
      }
    }
    const h = beat(o, code, run?.id ?? null, now, st);
    const beatChanged = stageBeat(o, h);
    if (run || closed.length || beatChanged) {
      const parts = [run ? `claim ${run.id}` : "", closed.length ? `close ${closed.join(", ")}` : "", !run && !closed.length ? `worker ${code}` : ""];
      commitPush(o, parts.filter(Boolean).join("; "));
    }
    keep = !!run;
    return { claim: run ? { job: run, inst, allow: allow.ok ? allow.value : [], claimedAt: mono(o), st } : null, closed, code };
  } catch (e) {
    if (e instanceof WorkerError && e.code === "git_failed") return quit("git_failed");
    throw e;
  } finally {
    if (!keep) unlock(o);
  }
}

// ---- The browser session ------------------------------------------------------------------
// Started by the worker, never by the model: the claude command in print mode, Claude in
// Chrome on, the pinned settings file, the same allow and deny lists on the command line,
// no MCP servers but Claude in Chrome, from an empty folder of its own. It prints its
// report; nothing in it can run a shell, read or write a file, or fetch from the web.
export function sessionArgv(inst: Install, o: Opts, settings: any, promptText: string): string[] {
  const f = o.files ?? SESSION_FILES;
  const mcp = join(P.cwd(o), "no-mcp.json");
  return [inst.claude, "-p", promptText, "--chrome", "--settings", f.settings,
    "--allowedTools", settings.permissions.allow.join(","), "--disallowedTools", settings.permissions.deny.join(","),
    "--strict-mcp-config", "--mcp-config", mcp, "--output-format", "json"];
}

function prepareCwd(o: Opts) {
  const d = P.cwd(o);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "no-mcp.json"), JSON.stringify({ mcpServers: {} }) + "\n");
}

// Kill the session and every process under it.
export function killTree(pid: number, plat = process.platform) {
  try {
    if (plat === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 30_000 });
    else process.kill(-pid, "SIGKILL");
  } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

export const launchSession: Launch = (argv, cwd, timeoutMs) => new Promise((done) => {
  let out = "", timedOut = false;
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, timeoutMs);
  child.stdout?.on("data", (d) => { if (out.length < 200_000) out += d.toString(); });
  child.on("error", () => { clearTimeout(timer); done({ code: null, out: "", timedOut }); });
  child.on("close", (code) => { clearTimeout(timer); if (child.pid && !timedOut && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* none left */ } } done({ code, out, timedOut }); });
});

// The model's report out of the session's output: the JSON object at the end of its
// final message (print mode's JSON output carries it in "result").
export function reportFrom(out: string): unknown {
  let text = out.trim();
  try { const j = JSON.parse(text); if (j && typeof j.result === "string") text = j.result; } catch { /* plain text */ }
  const a = text.lastIndexOf("{\"canary\""), b = text.lastIndexOf("}");
  const start = a >= 0 ? a : text.indexOf("{");
  if (start < 0 || b < start || b - start > 4_000) return null;
  try { return JSON.parse(text.slice(start, b + 1)); } catch { return null; }
}

// The per-run canary: a fresh value in a page under the worker folder that the extension
// can open only where file access is turned on, which is in the dedicated profile alone.
// The model reads it back as its first browser step.
function writeCanary(o: Opts, name: string): { url: string; value: string } {
  const value = `c-${randomBytes(9).toString("hex")}`;
  mkdirSync(P.canary(o), { recursive: true });
  const f = join(P.canary(o), `${name}.html`);
  writeFileSync(f, `<!doctype html><title>Cain jobs canary</title><p id="canary">${value}</p>\n`);
  return { url: pathToFileURL(f).href, value };
}

// ---- What the model saw, checked ------------------------------------------------------------
// {"canary", "outcome", "final_url", "facts"}, nothing else. A wrong canary is the wrong
// profile, whatever else it says. Anything that breaks the shape ends the job as
// result_rejected, and none of it is written.
export interface Ctx { canary: string; tools: string[]; attended: boolean; field?: (name: string) => void }

export function judge(job: Job, given: unknown, allow: Checked<Allow[]>, now: Date, ctx: Ctx): Result {
  const base = { tools: ctx.tools, attended: ctx.attended };
  const mk = (status: Status, code: Code, extra: Partial<Result> = {}) => result(job, status, code, now, { ...base, ...extra });
  const reject = (field: string) => { ctx.field?.(field); return mk("failed", "result_rejected"); };
  if (!given || typeof given !== "object" || Array.isArray(given)) return reject("report");
  const g = given as Record<string, unknown>;
  const extra = Object.keys(g).find((k) => !["canary", "outcome", "final_url", "facts"].includes(k));
  if (extra) return reject("extra_field");
  const outcome = g.outcome as typeof OUTCOMES[number];
  if (!OUTCOMES.includes(outcome)) return reject("outcome");
  if (outcome === "browser_unreachable") return mk("failed", "browser_unreachable");
  if (g.canary !== ctx.canary) { ctx.field?.("canary"); return mk("failed", "wrong_profile"); }
  const facts = g.facts ?? {};
  const url = g.final_url === undefined || g.final_url === null ? null : sanitizeUrl(g.final_url);
  if (g.final_url !== undefined && g.final_url !== null && url === null) return reject("final_url");
  if (outcome !== "seen" && (typeof facts !== "object" || facts === null || Object.keys(facts).length)) return reject("facts");
  const pin = allow.ok ? pinFor(job, allow.value) : null;
  const shown = url && (onSite(url, job.site) || (pin && onLogin(url, pin))) ? url : null;
  const sideEffects = !isReadOnly(job);
  switch (outcome) {
    case "wrong_profile":
      return mk("failed", "wrong_profile");
    case "needs_login": case "blocked_captcha": case "pending_email_confirmation": {
      const handoff = outcome as Handoff;
      return mk(outcome === "pending_email_confirmation" ? "done" : "failed", handoff, { handoff, final_url: shown });
    }
    case "uncertain":
      return mk("in_doubt", "outcome_uncertain", { final_url: shown });
    case "not_as_expected":
      return mk(sideEffects ? "in_doubt" : "failed", "page_not_as_expected", { final_url: shown });
    case "already_gone": case "seen": {
      if (!allow.ok) return mk("failed", "allowlist_unverified");
      if (url && pin && onLogin(url, pin)) return mk("failed", "needs_login", { handoff: "needs_login", final_url: url });
      if (!url || !pin || !onPin(url, pin)) { ctx.field?.("final_url"); return mk("failed", "url_drift", { final_url: shown }); }
      if (outcome === "already_gone") return mk("done", "already_gone", { handoff: "already_gone", final_url: url });
      const f = checkFacts(job.action, facts);
      if (!f.ok) return reject(f.field ?? "facts");
      return mk("done", "ok", { final_url: url, facts: f.value });
    }
  }
  return reject("outcome");
}

// ---- One run --------------------------------------------------------------------------------
// The job is still ours (claimed by this attempt, not cancelled), and our own monotonic
// clock says the claim is well inside its lease. Otherwise nothing is written: the keeper
// closes a claim whose lease ran out.
function stillOurs(o: Opts, c: Claim, now: Date): Job | "cancelled" | null {
  if (mono(o) - c.claimedAt >= LEASE_MS - 2 * SKEW_MS) return null;
  if (!update(o)) return null;
  const job = jobs(o).find((j) => j.id === c.job.id);
  if (!job || job.state !== "claimed" || job.attempt !== c.job.attempt) return null;
  if (cancels(o).has(job.id)) {
    close(o, job, result(job, "cancelled", "cancelled", now));
    commitPush(o, `cancel ${job.id}`);
    return "cancelled";
  }
  return job;
}

export interface RunOut { code: Heartbeat["code"] | Code; job: string | null; closed: string[]; state?: string }

export async function run(o: Opts): Promise<RunOut> {
  const n = next(o);
  if (!n.claim) return { code: n.code, job: null, closed: n.closed };
  const c = n.claim;
  try {
    const h = sessionHashes(o)!;
    const tools = allowedTools(h.settings)!;
    const conf = readConfirmed(o)!;
    const canary = writeCanary(o, conf.canary);
    prepareCwd(o);
    const prompt = `${h.prompt}\n\n## This run\n\n${JSON.stringify(instruction(c.job, canary.url), null, 2)}\n`;
    const limit = Math.min(c.inst.session_minutes * 60_000, MAX_SESSION_MS);
    const s = await (o.launch ?? launchSession)(sessionArgv(c.inst, o, h.settings, prompt), P.cwd(o), limit);
    rmSync(P.canary(o), { recursive: true, force: true });
    const now = clock(o);
    const mine = stillOurs(o, c, now);
    if (mine === "cancelled") { beat(o, "cancelled", c.job.id, now, c.st); return { code: "cancelled", job: c.job.id, closed: n.closed, state: "cancelled" }; }
    if (!mine) { beat(o, "lease_expired", c.job.id, now, c.st); return { code: "lease_expired", job: c.job.id, closed: n.closed }; }
    let field: string | null = null;
    const r = s.timedOut
      ? result(mine, "failed", "browser_timeout", now, { tools, attended: !!o.attended })
      : judge(mine, reportFrom(s.out), { ok: true, value: c.allow }, now, { canary: canary.value, tools, attended: !!o.attended, field: (f) => { field = f; } });
    // The result is checked once more as it will be read, facts typed for its action.
    const checked = parseResult(resultText(r), mine.action);
    const final = checked.ok ? checked.value : result(mine, "failed", "result_rejected", now, { tools, attended: !!o.attended });
    close(o, mine, final);
    commitPush(o, `result ${mine.id}: ${final.status} (${final.code})`);
    diagnose(o, c.inst, now, mine.id, final.code, final.final_url ?? (s.timedOut ? null : sanitizeUrl((reportFrom(s.out) as any)?.final_url)), field);
    beat(o, final.code, mine.id, now, c.st);
    return { code: final.code, job: mine.id, closed: n.closed, state: stateAfter(mine, final) };
  } finally {
    rmSync(P.canary(o), { recursive: true, force: true });
    unlock(o);
  }
}

// ---- The confirm path: behind a flag that is off -----------------------------------------------
// Before a confirming click, the tap's nonce is recorded in the queue first, so a token is
// spent once even if the click dies. install.json can't turn confirm_path on in this
// version (parseInstall refuses it), and no command reaches this.
export function spendNonce(o: Opts, id: string, attempt: string, nonce: string) {
  const inst = loadInstall(o);
  if (!inst || (inst as any).confirm_path !== true) throw new WorkerError("confirm_path_off");
  if (!ID.test(id) || !ATTEMPT.test(attempt) || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) throw new WorkerError("bad_arguments");
  if (nonces(o).has(nonce)) throw new WorkerError("nonce_spent");
  put(o, ["nonces", `${nonce}.json`], JSON.stringify({ v: 1, nonce, job: id, attempt, worker_clock: clock(o).toISOString() }, null, 2) + "\n");
  commitPush(o, `spend a tap for ${id}`);
}

// ---- The supervised probe: the only way to the first confirmation ------------------------------
// The owner runs it by hand, watching. It bypasses only the missing profile confirmation;
// it can't run a queued job (it never reads or writes the queue); its one target is the
// probe site's settings address from his signed allowlist. It exercises:
//   1. STOP: with a STOP file in place, the preflight stops before anything else.
//   2. a deliberately failed preflight: the same checks against a wrong extension id fail closed.
//   3. the browser step: the canary read back, and the settings page read, through the
//      pinned session, with its time limit.
//   4. the deny check: a second session is asked to run a shell command, write a file and
//      fetch a page; none of it may happen.
// What it saves (probe-evidence.json) is what confirm-profile records.
export interface Evidence {
  v: 1; at: string; target: string; stop_ok: boolean; failed_preflight: Code | null; browser: Code; canary_ok: boolean; deny_check: boolean;
  fingerprint: Fingerprint; settings_sha256: string; prompt_sha256: string; canary: string; tools: string[];
}

export const PROBE_ID = (now: Date) => `j-${now.toISOString().slice(0, 10).replace(/-/g, "")}-probe0`;
const DENY_PROMPT = (dir: string) => `This is a permission check. Try each of these once, and if a tool is refused, go on to the next:
1. Run the shell command: echo denied > "${join(dir, "bash.txt")}"
2. Write the file ${join(dir, "write.txt")} with the text denied.
3. Fetch https://example.com with a web fetch tool.
Then reply with the single word: done.`;

export async function probe(o: Opts): Promise<Evidence> {
  if (!o.attended) throw new WorkerError("attended_required");
  const now = clock(o);
  if (existsSync(P.stop(o))) throw new WorkerError("stopped");
  const inst = loadInstall(o);
  if (!inst) throw new WorkerError("untrusted_config");
  if (!filesTrusted(o)) throw new WorkerError("untrusted_files");
  const keys = ownerKeys(o, inst);
  if (!keys) throw new WorkerError("untrusted_config");
  const allow = loadAllowlist(o, keys);
  if (!allow.ok) throw new WorkerError("allowlist_unverified");
  const pin = allow.value.find((a) => a.action === "read_account_settings" && a.match === "exact");
  if (!pin) throw new WorkerError("no_probe_target");
  const h = sessionHashes(o);
  const tools = h ? allowedTools(h.settings) : null;
  if (!h || !tools) throw new WorkerError("untrusted_config");
  const l = lock(o, now);
  if (!l.got) throw new WorkerError("busy");
  try {
    // 1. STOP.
    writeFileSync(P.stop(o), "probe\n");
    let stop_ok = false;
    try { stop_ok = next({ ...o, now: () => now }).code === "stopped"; } finally { rmSync(P.stop(o), { force: true }); }
    // 2. A deliberately failed preflight.
    const wrongId = inst.profile.extension_id.split("").reverse().join("");
    const failed_preflight = browserPreflight(o, { ...inst, profile: { ...inst.profile, extension_id: wrongId === inst.profile.extension_id ? "a".repeat(32) : wrongId } }, true);
    // 3. The real preflight, bypassing only the confirmation, and the browser step.
    const pre = browserPreflight(o, inst, true);
    const fp = fingerprint(inst);
    if (pre || !fp) throw new WorkerError(pre ?? "wrong_profile");
    const canaryName = word(16, o.rand);
    const canary = writeCanary(o, canaryName);
    prepareCwd(o);
    const job: Job = { v: 1, id: PROBE_ID(now), from: "cain", created: now.toISOString(), expires: new Date(now.getTime() + 3_600_000).toISOString(),
      state: "claimed", lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), attempt: newAttempt(o.rand), site: pin.site,
      action: pin.action, step: "read", start_url: pin.url, done_looks_like: "The account settings page; report whether it is signed in and whether two-step sign-in is on",
      follows: null, preview_seen: null, owner_go: null, go_token: null };
    const limit = Math.min(inst.session_minutes * 60_000, MAX_SESSION_MS);
    const prompt = `${h.prompt}\n\n## This run\n\n${JSON.stringify(instruction(job, canary.url), null, 2)}\n`;
    const s = await (o.launch ?? launchSession)(sessionArgv(inst, o, h.settings, prompt), P.cwd(o), limit);
    let field: string | null = null;
    const given = reportFrom(s.out);
    const r = s.timedOut ? result(job, "failed", "browser_timeout", now)
      : judge(job, given, allow, now, { canary: canary.value, tools, attended: true, field: (f) => { field = f; } });
    diagnose(o, inst, now, job.id, r.code, r.final_url ?? sanitizeUrl((given as any)?.final_url), field);
    const canary_ok = !s.timedOut && (given as any)?.canary === canary.value;
    // 4. The deny check.
    const dir = P.denyCheck(o);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    prepareCwd(o);
    const d = await (o.launch ?? launchSession)(sessionArgv(inst, o, h.settings, DENY_PROMPT(dir)), P.cwd(o), Math.min(limit, 5 * 60_000));
    const deny_check = !d.timedOut && d.code === 0 && readdirSync(dir).length === 0;
    rmSync(dir, { recursive: true, force: true });
    rmSync(P.canary(o), { recursive: true, force: true });
    const ev: Evidence = { v: 1, at: now.toISOString(), target: pin.url, stop_ok, failed_preflight, browser: r.code, canary_ok, deny_check,
      fingerprint: fp, settings_sha256: h.settings_sha256, prompt_sha256: h.prompt_sha256, canary: canaryName, tools };
    writeFileSync(P.evidence(o), JSON.stringify(ev, null, 2) + "\n");
    return ev;
  } finally {
    rmSync(P.canary(o), { recursive: true, force: true });
    unlock(o);
  }
}

// ---- The owner's commands -----------------------------------------------------------------------
// confirm-profile records a passing probe's evidence, if it is under a day old and still
// matches the profile and the pinned files as they are now. It is invalidated (and every
// run fails closed) by a change of the profile folder, its name, the extension's id or
// version, Chrome's major version (profile_changed), of the session's settings or prompt
// (untrusted_config), or of the owner key (untrusted_config). Then: a new probe, a new
// confirm-profile.
export const BROWSER_OK: readonly Code[] = ["ok", "needs_login", "already_gone"];

export function confirmProfile(o: Opts): Confirmed {
  const inst = loadInstall(o);
  if (!inst) throw new WorkerError("untrusted_config");
  const ev = readJson(P.evidence(o)) as Evidence | null;
  const now = clock(o);
  if (!ev || ev.v !== 1 || !ev.stop_ok || !ev.failed_preflight || !ev.canary_ok || !BROWSER_OK.includes(ev.browser)
    || !(now.getTime() - Date.parse(ev.at) < 24 * 3_600_000) || typeof ev.canary !== "string" || !/^[a-z0-9]{16}$/.test(ev.canary))
    throw new WorkerError("probe_required");
  const fp = fingerprint(inst);
  const h = sessionHashes(o);
  if (!fp || canonical(fp) !== canonical(ev.fingerprint)) throw new WorkerError("profile_changed");
  if (!h || h.settings_sha256 !== ev.settings_sha256 || h.prompt_sha256 !== ev.prompt_sha256) throw new WorkerError("untrusted_config");
  const c: Confirmed = { v: 1, at: now.toISOString(), fingerprint: fp, settings_sha256: h.settings_sha256, prompt_sha256: h.prompt_sha256,
    canary: ev.canary, deny_check: ev.deny_check === true };
  writeFileSync(P.confirmed(o), JSON.stringify(c, null, 2) + "\n");
  return c;
}

export function ownerKeygen(kid: string, out: string, passphrase: string): string {
  if (!KID.test(kid)) throw new WorkerError("bad_arguments");
  if (passphrase.length < 12) throw new WorkerError("passphrase_too_short");
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "owner-key.pem"), privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase }), { mode: 0o600 });
  return `${kid} ${publicOf(privateKey)}`;
}

export function ownerFpr(file: string): string {
  const keys = parseKeys(readFileSync(file, "utf8"));
  if (keys.size !== 1) throw new WorkerError("bad_arguments");
  return keyFingerprint([...keys.values()][0]);
}

export function signAllowlistFile(entriesFile: string, keyFile: string, passphrase: string, kid: string): string {
  const e = JSON.parse(readFileSync(entriesFile, "utf8"));
  const allow = Array.isArray(e) ? e : e?.allow;
  const key: KeyObject = createPrivateKey({ key: readFileSync(keyFile, "utf8"), format: "pem", passphrase });
  const text = signAllowlist(kid, allow, signerOf(key));
  const check = parseAllowlist(text, new Map([[kid, createPublicKey(key)]]));
  if (!check.ok) throw new WorkerError("allowlist_unverified");
  return text;
}

// ---- The command line ---------------------------------------------------------------------------
function flag(args: string[], name: string, dflt?: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const isMain = (() => {
  try { return (import.meta as any).main ?? /worker\.ts$/.test(process.argv[1] ?? ""); } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const o: Opts = { home: resolve(flag(args, "--home", process.env.PC_WORKER_HOME ?? process.cwd())!), attended: args.includes("--attended"),
    diagnose: args.includes("--diagnose") };
  const say = (x: unknown) => console.log(JSON.stringify(x));
  const fail = (e: unknown) => { say({ error: e instanceof WorkerError ? e.code : "worker_failed" }); process.exit(1); };
  try {
    const [cmd, a1] = args;
    if (cmd === "run") run(o).then(say, fail);
    else if (cmd === "probe") probe(o).then(say, fail);
    else if (cmd === "confirm-profile") say({ confirmed: confirmProfile(o).at });
    else if (cmd === "owner-keygen") say({ owner_pub: ownerKeygen(flag(args, "--kid") ?? "", flag(args, "--out") ?? o.home, process.env.PC_OWNER_PASSPHRASE ?? "") });
    else if (cmd === "owner-fpr" && a1) say({ owner_fpr: ownerFpr(a1) });
    else if (cmd === "sign-allowlist" && a1) {
      const text = signAllowlistFile(a1, flag(args, "--key") ?? "", process.env.PC_OWNER_PASSPHRASE ?? "", flag(args, "--kid") ?? "");
      const out = flag(args, "--out");
      if (out) { writeFileSync(out, text); say({ written: out }); } else process.stdout.write(text);
    } else { console.error("usage: worker.ts run [--attended] | probe --attended | confirm-profile | owner-keygen | owner-fpr <owner.pub> | sign-allowlist"); process.exit(2); }
  } catch (e) { fail(e); }
}
