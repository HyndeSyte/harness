// The probe (Cain 0.14.0), root's, outside his session, like watch.sh (probe/core.ts has the rule).
// What it measures is liveness: it can say alive while messages are lost. This release only alarms.
//   bun main.ts loop                 a pass every 5 minutes, for good (the run script starts it)
//   bun main.ts pass                 one pass, now
//   bun main.ts install <version>    the version this start runs: an install when it changed (run
//                                    before boot, so a start the update itself caused isn't counted)
//   bun main.ts boot <start id>      the run script started (its own id for this start): the first in a
//                                    container is kept in /data (boot, asked or update) and the
//                                    container-start alarm raised or down; every start clears any stop
//                                    mark and keeps its id as the last start record
//   bun main.ts stop-finish <code> <signal> [<t0>]
//                                    s6's finish script: the TERM trap's pending stop mark promoted to
//                                    asked only for a real stop (256 with signal 15) whose nonce is the
//                                    last start record's id; any other end (SIGKILL, SIGSEGV, SIGABRT, an
//                                    exit of its own, exit 15 included) clears both
//   bun main.ts session-asked <id>   the run script is about to stop his session: a root-owned mark
//                                    naming that very run (the id the run script holds), so its end is
//                                    "asked"
//   bun main.ts stop-asked <id> <start id> [<t0>]
//                                    the Supervisor is stopping the App (the run script's TERM trap): the
//                                    run marked asked as above, the trap's nonce left in /run, and a
//                                    pending mark in /data naming this start (seventh round: only the
//                                    finish script promotes it, so a stop that never finished counts)
//   bun main.ts self-restart <kind> <on|off|unknown> <start id> <cause>
//                                    (Cain 0.15.0) his channel is down past its bound: whether the App
//                                    restarts itself (restart, wait, off or unknown), its marks kept
//   bun main.ts self-report          the morning check-in's line on the App's own restarts (24 hours)
//   bun main.ts folders              each folder from the probe's two up to /, with its owner, mode and
//                                    verdict (the first Pi drill; reads only)
// t0: the shell's $EPOCHREALTIME when the trap or the finish script began, so the time each took is
// kept in /data/probe/stop-times for the stop drills to print.
//   bun main.ts session-gone <id>    the run script saw his session gone: when, for how long it ran
//   bun main.ts session-start <code> <id>
//                                    his session starts: the run before it (id: the one the run script
//                                    holds in memory, empty after s6 restarted it) classed from root's
//                                    own marks and the exit code session.sh kept, kept in /data, and the
//                                    alarms raised or down. Prints "run <new id> <kind>".
// The probe's own heartbeat URL (probe_heartbeat_url) comes in PROBE_PING_URL, is read once
// and taken out of the environment, and is never logged, written anywhere or put on a command
// line (fetch sends it; no child process gets it). It is pinged only after a pass that passed:
// the outside service alarms Dane when the pings stop. The owner's Stop doesn't stop it (his session
// keeps running through a Stop); the App's own stopped mode (the mode file says none) does.
// Before every read or write under /data/probe or /run/cain/probe the folder is looked at
// (probe/folder.ts): root's, 0700, not a symlink, or the probe refuses and alarms once.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { heartbeatUrl } from "../security/core";
import { chainVerdicts, checkFolder, FolderTampered, folderWhy } from "./folder";
import {
  afterStart, alarmFor, askDue, bootKind, clockDue, endKind, END_KINDS, exitCause, failedWords, type Facts, hourlyState, type Hourly, type Install,
  inWindow, lastCode, lastSlot, logLine, longTurn, parseBoots, pass, type Pass, PASS_EVERY_S, PROBE_LINE, pruneStarts, parseSelf, parseStarts,
  parseAsked, parseUnseen, type Screen, tooManyAsked, askedCount, allStarts, allCount, tooManyAll, screenOf, shouldPing, SELF_WINDOW_S, START_ID, startsIn, STOP_MARK_S, tooManyBoots, tooManySelf, tooManyStarts, tooManyUnseen,
  unseenCount, updateCause, parseSelfRows, selfDecide, selfReport, selfWords, type SelfState, type Switch, SELF_KINDS, SELF_MARK_S,
} from "./core";

const env = process.env;
// The probe's two folders, looked at before every read or write under them (guard).
const GUARDED = new Set<string>();
export const paths = (e: Record<string, string | undefined> = env) => {
  const D = e.PROBE_DIR ?? "/data/probe";
  const R = e.PROBE_RUN ?? "/run/cain/probe";
  GUARDED.add(D); GUARDED.add(R);
  return {
    dir: D, run: R,
    starts: join(D, "starts"), install: join(D, "install.json"), passes: join(D, "passes.jsonl"), hourly: join(D, "hourly.json"),
    alive: join(D, "alive"), alarmed: join(D, "alarmed"), boots: join(D, "boots"),
    // The Supervisor asked the App to stop (stop-asked): the next container start isn't counted, when the
    // mark names the last start of the run script (start.json, its id and time).
    stopAsked: join(D, "stop-asked"), start: join(D, "start.json"),
    // How long each stop's TERM trap and finish script took (seventh round), for the stop drills.
    stopTimes: join(D, "stop-times"),
    // The App's own restarts (Cain 0.15.0): each with its cause and time (self-restarts, JSON lines), the
    // refusal count and whether the switch-off alarm went (self.json), and the mark the next container
    // start reads (self-asked, naming the last start record's id).
    selfRows: join(D, "self-restarts"), self: join(D, "self.json"), selfAsked: join(D, "self-asked"),
    // The hourly check's ask and answer, and when a message of the owner's last came in for his session
    // (the broker's note, a time only).
    ask: join(R, "ask"), answered: join(R, "answered"), heard: join(R, "heard"),
    // This container's marks (tmpfs: a new container starts with none): his session's run as root
    // started it, the run script's own stop request for that run, and that this container booted.
    session: join(R, "session.json"), asked: join(R, "asked"), booted: join(R, "booted"),
    // The run script's TERM trap ran for this start (its start id): only then is a stop "real".
    term: join(R, "term"),
    delivered: e.CHECKIN_DELIVERED ?? "/data/checkin.delivered",
    gateway: e.PROBE_GATEWAY ?? "/run/cain/link-gateway.state",
    mode: e.PROBE_MODE_FILE ?? "/run/cain/mode",
    // His session's log (session.sh's stderr): its last line goes into an exit alarm, plain and short.
    sessionLog: e.PROBE_SESSION_LOG ?? "/data/session.log",
    proc: e.PROBE_PROC ?? "/proc",
    notice: e.PROBE_NOTICE ?? "/opt/cain/notice.sh",
    promptState: e.PROMPT_STATE ?? "/opt/cain/prompt-state.sh",
  };
};
type Paths = ReturnType<typeof paths>;

// A path under one of the probe's folders: the folder looked at first (FolderTampered otherwise).
function guard(p: string): void { const d = dirname(p); if (GUARDED.has(d)) checkFolder(d); }
// A file under the probe's folders is opened without following a link (O_NOFOLLOW; Bun has no openat,
// so it is the path under the folder just looked at) and read only when it is a plain file.
const text = (p: string) => {
  const d = dirname(p);
  if (!GUARDED.has(d)) { try { return readFileSync(p, "utf8"); } catch { return null; } }
  checkFolder(d);
  let fd: number;
  try { fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try { return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null; } catch { return null; } finally { closeSync(fd); }
};
const json = <T>(p: string): T | null => { const t = text(p); try { return t === null ? null : JSON.parse(t) as T; } catch { return null; } };
const exists = (p: string) => { guard(p); try { lstatSync(p); return true; } catch { return false; } };
const rm = (p: string) => { guard(p); rmSync(p, { force: true }); };
const num = (p: string) => { const n = Number((text(p) ?? "").trim().split(/\s+/)[0]); return Number.isFinite(n) && n > 0 ? n : null; };
// Whole or not at all, root's alone: written under a fresh temp name created exclusively (never
// following a link or reusing a file), synced, then renamed over the mark. Every mark and record the
// probe keeps goes through here, in folders root alone may write (/run/cain/probe, /data/probe).
export function writeWhole(p: string, body: string, mode = 0o600): void {
  guard(p);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  guard(p);
  const tmp = `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, body); fsyncSync(fd); } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
  closeSync(fd);
  try { renameSync(tmp, p); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const log = (m: string) => console.log(`[cain] probe: ${m}`);

// A folder found wrong: refused, and alarmed, again each day while it lasts (sixth round: a tamper
// mustn't silence liveness for good; notice.sh sends the same alarm to his bot again once a day has
// passed). Meanwhile no pass passes, so the probe's outside heartbeat isn't pinged and its service
// alarms too. true when e was that.
export const TAMPER_REPEAT_S = 86400;
let toldTamper: number | null = null;
export function onTamper(e: unknown, notice: PassDeps["notice"], now = Math.floor(Date.now() / 1000)): boolean {
  if (!(e instanceof FolderTampered)) return false;
  log(`refused: the probe's folder ${e.dir}: ${e.why}`);
  if ((toldTamper === null || now - toldTamper >= TAMPER_REPEAT_S) && notice("tell", "tampered", e.why) <= 1) toldTamper = now;
  return true;
}
// Both folders right again after an alarm: it comes down.
export function tamperCleared(p: Paths, notice: PassDeps["notice"], force = false): void {
  if ((toldTamper !== null || force) && folderWhy(p.dir) === null && folderWhy(p.run) === null && notice("clear", "tampered") <= 1) toldTamper = null;
}

// The last line of his session's log, as it may go into an alarm (core logLine). He writes that log,
// so it is opened without following a link, and only a plain file with one name, root's or his, is
// read, its last 4 KB: never something it points at. The descriptor is checked after the open and
// before any read (a plain file, one link, root's or Cain's).
export function sessionLogLine(p: Paths): string | null {
  let fd: number;
  try { fd = openSync(p.sessionLog, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const cain = Number(env.CAIN_UID ?? 1000), me = typeof process.getuid === "function" ? process.getuid() : 0;
    // me: the probe's own user, root on the Pi (a test's own user here).
    if (!st.isFile() || st.nlink !== 1 || ![0, cain, me].includes(st.uid)) return null;
    const n = Math.min(st.size, 4096);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, st.size - n);
    return logLine(buf.toString("utf8"));
  } catch { return null; } finally { closeSync(fd); }
}

// -- the facts ----------------------------------------------------------------------------------------
// A process of the Discord plugin's server: its command runs server.ts from the plugin's folder
// (as discord the new way, under Claude Code the old way). Root reads every process's command and
// folder in /proc.
export function pluginUp(proc: string): boolean {
  let pids: string[] = [];
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)); } catch { return false; }
  for (const p of pids) {
    const cmd = (text(join(proc, p, "cmdline")) ?? "").split("\0").filter(Boolean);
    if (!cmd.some((a) => a.endsWith("server.ts"))) continue;
    let cwd = "";
    try { cwd = readlinkSync(join(proc, p, "cwd")); } catch { /* gone, or a test's plain folder */ }
    if (cmd.some((a) => a.includes("/discord/") && a.endsWith("server.ts")) || cwd.includes("/discord")) return true;
  }
  return false;
}
// Children get none of the probe's own environment beyond what they need: never the ping URL.
function sh(cmd: string, input?: string, ms = 15_000): { code: number; out: string } {
  const { PROBE_PING_URL: _drop, ...rest } = env;
  const p = Bun.spawnSync(["bash", "-c", cmd], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), timeout: ms, env: rest });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() };
}
function tmuxUp(): boolean { return sh(`timeout -k 2 10 ${env.TMUX_CMD ?? "tmux"} -u has-session -t cain 2>/dev/null`).code === 0; }
// His screen, from a capture of his pane: ready, at work, a sign-in, an API error, or other.
function screenNow(p: Paths): Screen {
  const s = sh(`timeout -k 2 10 ${env.TMUX_CMD ?? "tmux"} -u capture-pane -p -J -t cain -S -60 2>/dev/null`);
  if (s.code !== 0) return "other";
  return screenOf(s.out, sh(`"${p.promptState}" 2>/dev/null`, s.out).out);
}
export function gatewayState(p: Paths): Facts["gateway"] {
  const t = (text(p.gateway) ?? "").trim().split(/\s+/);
  return t.length === 2 ? { state: t[0], ack: Number(t[1]) || 0 } : null;
}

export interface PassDeps {
  p: Paths; now: number; tz: string; mode: string;
  plugin: () => boolean; tmux: () => boolean; screen: () => Screen;
  ping: () => Promise<boolean>;                      // false: not sent (unset, or it failed)
  notice: (...args: string[]) => number;             // notice.sh's exit code
}

// One pass: the facts, the hourly liveness check and its answer, the pass kept, the ping only when it
// passed, and the alarm raised once a stretch and taken down when a pass goes through. The owner's
// Stop changes none of it: his session runs and answers through a Stop. Only the App's own stopped
// mode (mode none: the App stopped his session on purpose and has told him) silences the alarm and
// the ping.
export async function runPass(d: PassDeps): Promise<Pass> {
  const { p, now } = d;
  // Both folders looked at first: a refused folder ends the pass here, so nothing is pinged.
  checkFolder(p.dir); checkFolder(p.run);
  const h: Hourly = json<Hourly>(p.hourly) ?? {};
  const ans = num(p.answered);
  if (ans && h.asked && ans >= h.asked && !(h.answered && h.answered >= h.asked)) h.answered = ans;
  const own = d.mode === "own";
  const facts: Facts = {
    now, plugin: d.plugin(), tmux: d.tmux(), gateway: gatewayState(p),
    delivered: num(p.delivered), slot: lastSlot(now, d.tz),
  };
  const screen = d.screen();
  const appStopped = d.mode === "none";
  // The hourly check goes through the broker (the new way only): the old way has no broker, so it
  // isn't asked there, and an ask from before doesn't count.
  const hh: Hourly = own ? h : {};
  const result = pass(facts, hh, { screen, appStopped });
  // Not while a turn is at work (his screen not ready) or within 5 minutes of a message of the
  // owner's: asked at the next pass that may instead, or, once it has waited 2 hours, anyway.
  if (own) {
    if (askDue(h, now, screen === "ready", num(p.heard))) {
      try {
        writeWhole(p.ask, `${now} ${PROBE_LINE.length}\n`);
        rm(p.answered);
        if (h.deferred !== undefined) log(`the hourly liveness check went in after waiting ${Math.floor((now - h.deferred) / 60)} minutes`);
        h.asked = now; delete h.answered; delete h.deferred;
      } catch (e) { if (e instanceof FolderTampered) throw e; log(`couldn't ask the hourly liveness check: ${String(e).slice(0, 80)}`); }
    } else if (clockDue(h, now) && h.deferred === undefined) h.deferred = now;
    if (hourlyState(h, now, screen === "working") === "timeout" && h.timedOut !== h.asked) { h.timedOut = h.asked; log("he didn't answer the hourly liveness check of his session"); }
    // A turn at work without a break for 2 hours: alarmed once a stretch, down when it ends.
    if (screen === "working") {
      h.busy ??= now;
      const mins = longTurn(h, now);
      if (mins !== null && !appStopped && d.notice("tell", "turn-long", String(mins)) <= 1) h.turnTold = h.busy;
    } else {
      if (h.turnTold !== undefined && d.notice("clear", "turn") <= 1) delete h.turnTold;
      if (h.turnTold === undefined) delete h.busy;
    }
    writeWhole(p.hourly, JSON.stringify(h));
  }
  const old = (text(p.passes) ?? "").split("\n").filter(Boolean).slice(-299);
  writeWhole(p.passes, [...old, JSON.stringify(result)].join("\n") + "\n");
  writeWhole(p.alive, `${now}\n`);
  if (shouldPing(result)) { if (!(await d.ping())) log("the probe passed, but its outside heartbeat wasn't pinged (unset, or no answer)"); }
  else log(`${result.status === "stopped" ? "the App stopped his session itself, no alarm" : result.status === "signin" ? "his screen waits at a sign-in" : result.status === "api" ? "his screen shows the model's API not answering" : "failed"}${result.failed.length ? `: ${failedWords(result)}` : ""}`);
  // The alarm, once a stretch per kind, and its clearing.
  const recent: Pass[] = [...old.slice(-5).map((l) => { try { return JSON.parse(l) as Pass; } catch { return null; } }).filter((x): x is Pass => !!x), result];
  const kind = alarmFor(recent);
  const had = (text(p.alarmed) ?? "").trim().split(/\s+/)[1] ?? (exists(p.alarmed) ? "probe" : "");
  // Stopped on purpose (the mode file says none), his stop's own alarm already tells Dane why.
  if (kind && kind !== had && !appStopped) {
    const cause = kind === "needs-signin" || kind === "api-down" ? "" : failedWords(result);
    if (d.notice("tell", kind, cause) <= 1) writeWhole(p.alarmed, `${now} ${kind}\n`, 0o600);
  } else if (result.status === "ok" && had) {
    if (d.notice("clear", "probe") <= 1) rm(p.alarmed);
  }
  return result;
}

// -- his session's runs, as root saw them ----------------------------------------------------------
interface Run { id: string; at: number; ended?: number }
const RUN_ID = /^[0-9a-f]{16}$/;
const readRun = (p: Paths): Run | null => {
  const r = json<Run>(p.session);
  return r && typeof r.id === "string" && RUN_ID.test(r.id) && Number.isFinite(r.at) ? r : null;
};
// The run script is about to stop his session: the mark names that very run, the one the run script
// holds in memory (mem), which must also be the run on file. Root's alone; his own user can't write
// it, so no exit of his can pass for one the App asked for.
export function markAsked(p: Paths, mem: string): boolean {
  const r = readRun(p);
  if (!r || r.ended || r.id !== mem) return false;
  writeWhole(p.asked, `${r.id}\n`);
  return true;
}
// The Supervisor is stopping the App (SIGTERM to s6, reaching the run script's TERM trap): the run
// marked asked before his session ends, when the run script still holds its id; the trap's nonce left
// in /run (its start id); and a pending mark in /data naming the run script's start, with the time.
// Seventh round, two phases: the trap writes only that pending mark. The finish script promotes it to
// asked, and only on 256 with signal 15 and a nonce equal to the last start record's id. The next
// container start counts only a promoted mark: a pending one means the stop never finished (the
// container killed, the power lost, the finish script never ran), so that start counts as a plain
// boot and the mark is cleared.
interface StopMark { at: number; id: string; state: "pending" | "asked" }
// Milliseconds since t0 (the shell's $EPOCHREALTIME, "<seconds>.<micro>"), or null when unreadable.
export function since(t0: string | undefined, nowMs = Date.now()): number | null {
  if (!/^\d{9,11}([.,]\d{1,9})?$/.test(t0 ?? "")) return null;
  const ms = Math.round(nowMs - Number(t0!.replace(",", ".")) * 1000);
  return ms >= 0 && ms < 600_000 ? ms : null;
}
function stopTime(p: Paths, now: number, what: string, ms: number | null): void {
  try { addLine(p.stopTimes, `${now} ${what} ${ms === null ? "unmeasured" : `${ms}ms`}`, now); }
  catch (e) { if (e instanceof FolderTampered) throw e; }
}
export function stopAsked(p: Paths, now: number, mem: string, start: string, t0?: string): boolean {
  if (START_ID.test(start)) {
    writeWhole(p.term, `${start}\n`);
    writeWhole(p.stopAsked, `${JSON.stringify({ at: now, id: start, state: "pending" } satisfies StopMark)}\n`);
  } else log("a stop with no start id: not kept as asked");
  const marked = mem !== "" && markAsked(p, mem);
  stopTime(p, now, "trap", since(t0));
  return marked;
}
// s6's finish script, with the exit code and signal s6 passes. Only 256 with signal 15 is a real stop
// (seventh round: a plain exit 15 no longer counts). Only then, with the trap's nonce the last start
// record's id and the trap's pending mark naming it, is the mark promoted to asked. Any other end (a
// SIGKILL from the OOM killer, a SIGSEGV, a SIGABRT, an exit of its own) is never asked: the mark and
// the nonce are cleared.
export function stopFinish(p: Paths, now: number, code: number, sig: number, t0?: string): boolean {
  const real = code === 256 && sig === 15;
  const nonce = (text(p.term) ?? "").trim();
  const last = json<{ id?: unknown }>(p.start);
  const mark = json<{ id?: unknown; state?: unknown }>(p.stopAsked);
  let kept = false;
  if (real && START_ID.test(nonce) && last && last.id === nonce && mark && mark.id === nonce && mark.state === "pending") {
    writeWhole(p.stopAsked, `${JSON.stringify({ at: now, id: nonce, state: "asked" } satisfies StopMark)}\n`);
    kept = true;
  } else {
    if (!real) log(`the run script ended by ${code === 256 ? `signal ${sig}` : `exit ${code}`}: not a stop that was asked`);
    else log("a stop with no pending mark and nonce from this start's TERM trap: not kept as asked");
    rm(p.stopAsked); rm(p.term);
  }
  stopTime(p, now, kept ? "finish promoted" : "finish not-asked", since(t0));
  return kept;
}
// The stop mark, taken: whether it counts for a container start now, after the start whose record is
// last (its id). Only a promoted mark counts: a pending one (the stop never finished), a mark from
// another start, an old-format, stale or garbled one never does.
export function takeStopMark(p: Paths, now: number, last: string | null): boolean {
  const m = json<{ at?: unknown; id?: unknown; state?: unknown }>(p.stopAsked);
  rm(p.stopAsked);
  if (!m || typeof m.at !== "number" || !Number.isFinite(m.at) || typeof m.id !== "string" || !START_ID.test(m.id)) return false;
  if (m.state === "pending") { log("a pending stop mark: the stop never finished (a kill or a power cut), so this start counts"); return false; }
  if (m.state !== "asked") return false;
  if (last === null || m.id !== last) { log("a stop mark from another start of the run script: not counted as asked"); return false; }
  const age = now - m.at;
  if (age < -60 || age > STOP_MARK_S) { log("a stop mark older than 5 minutes: not counted as asked"); return false; }
  return true;
}
// The run script saw his session gone: the first time it saw so is when the run ended. A run script
// that holds an id marks only that run.
export function markGone(p: Paths, now: number, mem = ""): void {
  const r = readRun(p);
  if (r && !r.ended && (mem === "" || mem === r.id)) writeWhole(p.session, JSON.stringify({ ...r, ended: now }));
}
// How the run before this start ended, from root's own marks: no run in this container (boot); the
// run script's stop request for that run (asked: the mark, the run on file and the id the run script
// holds in memory all the same run); how long it ran to when root saw it end; or, when root never saw
// it end (s6 restarted the run script meanwhile), the gap from its start to this one. The exit code is
// session.sh's, his to write, so it alone never makes a start "asked" and never counts a late end as
// an early exit.
export function classify(p: Paths, now: number, code: number | null, mem: string): string {
  const r = readRun(p);
  if (!r) return "boot";
  const asked = mem !== "" && mem === r.id && (text(p.asked) ?? "").trim() === r.id;
  const seen = r.ended !== undefined;
  const ran = (r.ended ?? now) - r.at;
  return endKind({ first: false, asked, code, ran: ran >= 0 ? ran : null, seen });
}
// One start of his session: the run before it classed and kept, this run's mark written, and the
// alarms raised or taken down. Alarm only.
export function sessionStart(p: Paths, now: number, code: number | null, notice: PassDeps["notice"], mem = ""): { kind: string; id: string } {
  const kind = classify(p, now, code, mem);
  recordStart(p, now, kind, notice);
  const id = randomBytes(8).toString("hex");
  writeWhole(p.session, JSON.stringify({ id, at: now }));
  rm(p.asked);
  return { kind, id };
}
// A line added to a file of root's, the whole file rewritten (never appended in place).
function addLine(path: string, line: string, now: number): string {
  const body = pruneStarts(`${text(path) ?? ""}${line}\n`, now);
  writeWhole(path, body);
  return body;
}
export function recordStart(p: Paths, now: number, end: string, notice: PassDeps["notice"]): number {
  const kind = END_KINDS.test(end) ? end : "unknown";
  addLine(p.starts, `${now} ${kind}`, now);
  return checkStarts(p, now, notice);
}
const flagOf = (p: Paths, k: string) => `${p.alarmed}-${k}`;
// The line that names the update: within a day of a version change, once for each new loop (it comes
// down once neither loop stands, so the next loop says it again).
function sayUpdate(p: Paths, now: number, kind: "update-exits" | "update-unseen" | "update-boots" | "update-asked" | "update-starts", notice: PassDeps["notice"]): void {
  const i = json<Install>(p.install);
  if (!inWindow(i, now)) return;
  if (notice("tell", kind, updateCause(i!, now)) <= 1) writeWhole(flagOf(p, "update"), `${now}\n`);
}
function updateDown(p: Paths, notice: PassDeps["notice"]): void {
  if (!exists(flagOf(p, "update")) || exists(flagOf(p, "starts")) || exists(flagOf(p, "boots")) || exists(flagOf(p, "unseen"))
    || exists(flagOf(p, "asked")) || exists(flagOf(p, "all"))) return;
  if (notice("clear", "update") <= 1) rm(flagOf(p, "update"));
}
// Repeated early exits (more than 3 in 30 minutes): "Cain's session keeps exiting early", and within
// a day of an install the line that names it; down once the count is back under. Repeated late error
// exits (more than 4 in 60 minutes): "Cain's session keeps ending on its own", down once back under.
// Restarts whose end root never saw (more than 3 in 30 minutes, 6 in 60, or 8 in 24 hours): "Cain's session
// keeps restarting", a cadence, not a confirmed exit, kept apart from both; within a day of an install
// it names the update too (an early crash before exit handlers run looks unseen).
// Each carries the count and window, the last exit code root kept and the last line of his session's
// log. None of this reads the owner's Stop: his session runs through it.
export function checkStarts(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const all = text(p.starts) ?? "";
  const starts = parseStarts(all);
  const n = startsIn(starts, now);
  const code = lastCode(all);
  let line: string | null | undefined;
  const logged = () => (line === undefined ? (line = sessionLogLine(p)) : line);
  const flag = flagOf(p, "starts");
  if (tooManyStarts(starts, now)) {
    if (!exists(flag) && notice("tell", "restarts", exitCause(`${n} in 30 minutes`, code, logged())) <= 1) {
      writeWhole(flag, `${now}\n`);
      sayUpdate(p, now, "update-exits", notice);
    }
  } else if (exists(flag)) {
    if (notice("clear", "restarts") <= 1) rm(flag);
  }
  const self = parseSelf(all);
  const sflag = flagOf(p, "self");
  if (tooManySelf(self, now)) {
    if (!exists(sflag) && notice("tell", "self-loop", exitCause(`${startsIn(self, now, 0, SELF_WINDOW_S)} in 60 minutes`, code, logged())) <= 1) writeWhole(sflag, `${now}\n`);
  } else if (exists(sflag)) {
    if (notice("clear", "self") <= 1) rm(sflag);
  }
  const unseen = parseUnseen(all);
  const uflag = flagOf(p, "unseen");
  if (tooManyUnseen(unseen, now)) {
    if (!exists(uflag) && notice("tell", "unseen-loop", exitCause(unseenCount(unseen, now), null, logged())) <= 1) {
      writeWhole(uflag, `${now}\n`);
      sayUpdate(p, now, "update-unseen", notice);
    }
  } else if (exists(uflag)) {
    if (notice("clear", "unseen") <= 1) rm(uflag);
  }
  checkAll(p, now, notice);
  updateDown(p, notice);
  return n;
}
// Every start together, whatever its kind (eighth round): container starts (boot, asked, update) and his
// session's restarts after an early exit, an unseen end or a late error exit, in one window. More than 8
// in 60 minutes, or more than 12 in 24 hours: "Cain's App keeps starting", with the counts by kind, and
// within a day of an install the update line; down once both are back under.
export function checkAll(p: Paths, now: number, notice: PassDeps["notice"]): void {
  const all = allStarts(text(p.boots) ?? "", text(p.starts) ?? "");
  const flag = flagOf(p, "all");
  if (tooManyAll(all, now)) {
    if (!exists(flag) && notice("tell", "start-loop", allCount(all, now)) <= 1) {
      writeWhole(flag, `${now}\n`);
      sayUpdate(p, now, "update-starts", notice);
    }
  } else if (exists(flag)) {
    if (notice("clear", "all") <= 1) rm(flag);
  }
}
// The run script started (start: its own id for this start). The first start in a container (a mark in
// /run, which a new container starts without) is kept as "boot", "asked" (the Supervisor asked the App
// to stop before it: the mark in /data, naming the last start record's id, taken here) or "update" (one
// of the first two within 10 minutes of a version change). More than 3 counted starts in 30 minutes:
// "Cain's App container keeps starting", and within a day of an install the line that names it.
// Every start, an s6-only restart of the run script included, then clears any stop mark and the trap's
// nonce, and keeps its id as the last start record, so a stale mark can never absorb a later crash.
export function recordBoot(p: Paths, now: number, notice: PassDeps["notice"], start = ""): string | null {
  const prev = json<{ id?: unknown }>(p.start);
  const last = prev && typeof prev.id === "string" && START_ID.test(prev.id) ? prev.id : null;
  let kind: string | null = null;
  if (!exists(p.booted)) {
    writeWhole(p.booted, `${now}\n`);
    const self = takeSelfMark(p, now, last);
    kind = self ? "asked" : bootKind({ now, stopAsked: takeStopMark(p, now, last), install: json<Install>(p.install), bootsText: text(p.boots) ?? "" });
    if (self) rm(p.stopAsked);
    // A restart the App asked for itself counts as an asked one, its requester and cause named.
    addLine(p.boots, self ? `${now} asked self:${self}` : `${now} ${kind}`, now);
    checkBoots(p, now, notice);
  } else if (exists(p.stopAsked)) log("a stop mark left by a restart of the run script alone: cleared");
  rm(p.stopAsked); rm(p.term);
  if (START_ID.test(start)) writeWhole(p.start, JSON.stringify({ id: start, at: now }));
  else rm(p.start);
  return kind;
}
export function checkBoots(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const boots = parseBoots(text(p.boots) ?? "");
  const n = startsIn(boots, now);
  const flag = flagOf(p, "boots");
  if (tooManyBoots(boots, now)) {
    if (!exists(flag) && notice("tell", "boots", exitCause(`${n} in 30 minutes`, lastCode(text(p.starts) ?? ""), sessionLogLine(p))) <= 1) {
      writeWhole(flag, `${now}\n`);
      sayUpdate(p, now, "update-boots", notice);
    }
  } else if (exists(flag)) {
    if (notice("clear", "boots") <= 1) rm(flag);
  }
  // Asked starts in their own windows (seventh round; the day window eighth): more than 6 in 60 minutes or
  // more than 12 in 24 hours is "Cain's App keeps being restarted", each stop requested; within a day of an
  // install the update line too.
  const asked = parseAsked(text(p.boots) ?? "");
  const aflag = flagOf(p, "asked");
  if (tooManyAsked(asked, now)) {
    // The App's own restarts among them are named with their cause (Cain 0.15.0).
    const own = (text(p.boots) ?? "").split("\n").map((l) => l.trim().split(/\s+/))
      .filter((f) => f[1] === "asked" && (f[2] ?? "").startsWith("self:") && now - Number(f[0]) < 24 * 3600).map((f) => f[2].slice(5));
    const ownWords = own.length ? `, ${own.length} of them the App's own restarts (for ${[...new Set(own)].map((k) => selfWords(k)).join(", ")})` : "";
    if (!exists(aflag) && notice("tell", "asked-loop", `${askedCount(asked, now)}${ownWords}`) <= 1) {
      writeWhole(aflag, `${now}\n`);
      sayUpdate(p, now, "update-asked", notice);
    }
  } else if (exists(aflag)) {
    if (notice("clear", "asked") <= 1) rm(aflag);
  }
  checkAll(p, now, notice);
  updateDown(p, notice);
  return n;
}

// The mark of a restart the App asked for itself (selfRestart below): taken once, at the next container
// start, and counted only when it names the last start record and is under 15 minutes old. Its kind, or null.
export function takeSelfMark(p: Paths, now: number, last: string | null): string | null {
  if (!exists(p.selfAsked)) return null;
  const m = json<{ at?: unknown; id?: unknown; kind?: unknown }>(p.selfAsked);
  rm(p.selfAsked);
  if (!m || typeof m.at !== "number" || typeof m.kind !== "string" || !SELF_KINDS.test(m.kind) || typeof m.id !== "string") return null;
  if (last === null || m.id !== last) { log("a self-restart mark from another start of the run script: not counted as asked"); return null; }
  if (now - m.at < -60 || now - m.at > SELF_MARK_S) { log("a self-restart mark older than 15 minutes: not counted as asked"); return null; }
  return m.kind;
}
// The run script found his channel down past its bound: whether the App restarts itself now (it prints
// the decision on its last line: restart, wait, off or unknown). On restart the row and the mark are kept
// before the run script exits; every alarm due goes out first, through notice.sh.
export function selfRestart(p: Paths, now: number, kind: string, sw: Switch, start: string, cause: string, notice: PassDeps["notice"]): string {
  if (!SELF_KINDS.test(kind)) return "unknown";
  const st = json<SelfState>(p.self);
  const state: SelfState = { refusals: Number.isSafeInteger(st?.refusals) ? st!.refusals : 0, offTold: st?.offTold === true };
  const rows = parseSelfRows(text(p.selfRows) ?? "");
  const words = cause.replace(/[\r\n]+/g, " ").slice(0, 200);
  const d = selfDecide(rows, state, sw, kind, words, now);
  for (const a of d.alarms) {
    if ("clear" in a) notice("clear", a.clear);
    else notice("tell", a.kind, a.cause);
  }
  if (d.decision !== "wait") writeWhole(p.self, JSON.stringify(d.state));
  if (d.row) {
    const keep = [...rows.filter((r) => now - r.at < 7 * 86400), d.row].slice(-200);
    writeWhole(p.selfRows, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (START_ID.test(start)) writeWhole(p.selfAsked, JSON.stringify({ id: start, at: now, kind }));
    notice("tell", "self-restart", words);
    log(`the App restarts itself: ${words}`);
  }
  return d.decision;
}
export function recordInstall(p: Paths, version: string, now: number): Install | null {
  const prev = json<Install>(p.install);
  const { install, fresh } = afterStart(prev, version, now);
  if (install && install !== prev) writeWhole(p.install, JSON.stringify(install));
  if (fresh && install) log(`installed: Cain ${install.version} (${install.previous ? `was ${install.previous}` : "no install on record before"}); the next 24 hours are watched`);
  return install;
}

function noticeCall(p: Paths) {
  return (...args: string[]) => {
    const { PROBE_PING_URL: _drop, ...rest } = env;
    const r = Bun.spawnSync(["timeout", "-k", "2", "60", p.notice, ...args], { stdout: "inherit", stderr: "inherit", env: { ...rest, NOTICE_LOCK_S: "20" } });
    return r.exitCode ?? 1;
  };
}

async function pingOnce(raw: string | undefined): Promise<boolean> {
  const b = heartbeatUrl(raw);
  if (b.kind !== "ok") return false;
  try {
    const r = await fetch(b.url.href, { method: "POST", body: "probe passed", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "content-type": "text/plain" } });
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}

if (import.meta.main) {
  const p = paths();
  const url = env.PROBE_PING_URL;
  delete env.PROBE_PING_URL;
  const tz = env.CHECKIN_TZ ?? "America/New_York";
  const now = () => Math.floor(Date.now() / 1000);
  const mode = () => (text(p.mode) ?? "").trim();
  const deps = (): PassDeps => ({ p, now: now(), tz, mode: mode(), plugin: () => pluginUp(p.proc), tmux: tmuxUp, screen: () => screenNow(p),
    ping: () => pingOnce(url), notice: noticeCall(p) });
  const [cmd, arg] = process.argv.slice(2);
  const idArg = (a: string | undefined) => /^[0-9a-f]{16}$/.test(a ?? "") ? a! : "";
  try {
    if (cmd === "loop") {
      const b = heartbeatUrl(url);
      log(`liveness every 5 minutes; its outside heartbeat ${b.kind === "ok" ? "on" : b.kind === "invalid" ? "set but not usable" : "off (probe_heartbeat_url is empty)"}`);
      await Bun.sleep(Number(env.PROBE_FIRST_S ?? 120) * 1000);
      let first = true;
      for (;;) {
        try { tamperCleared(p, noticeCall(p), first); } catch { /* told at the next pass */ }
        first = false;
        try { await runPass(deps()); } catch (e) { if (!onTamper(e, noticeCall(p))) log(`a pass failed: ${(e as Error).name}`); }
        try { checkStarts(p, now(), noticeCall(p)); checkBoots(p, now(), noticeCall(p)); } catch (e) { if (!onTamper(e, noticeCall(p))) log(`the start count failed: ${(e as Error).name}`); }
        await Bun.sleep(PASS_EVERY_S * 1000);
      }
    } else if (cmd === "pass") {
      const r = await runPass(deps());
      console.log(r.ok ? "passed" : `${r.status}: ${failedWords(r)}`);
    } else if (cmd === "boot") {
      const k = recordBoot(p, now(), noticeCall(p), idArg(arg));
      console.log(k ? `this container's start kept as ${k}` : "this container's start was kept already");
    } else if (cmd === "session-asked") {
      console.log(markAsked(p, idArg(arg)) ? "marked: this run's end was asked for" : "no run of his to mark");
    } else if (cmd === "stop-asked") {
      console.log(stopAsked(p, now(), idArg(arg), idArg(process.argv[4]), process.argv[5]) ? "the stop was asked for: pending, and his run marked" : "the stop was asked for: pending");
    } else if (cmd === "stop-finish") {
      const n = (a: string | undefined) => { const v = (a ?? "").replace(/[^0-9]/g, "").slice(0, 4); return v === "" ? -1 : Number(v); };
      console.log(stopFinish(p, now(), n(arg), n(process.argv[4]), process.argv[5]) ? "a real stop: its mark promoted to asked" : "not a stop that was asked: no mark");
    } else if (cmd === "folders") {
      for (const d of [p.run, p.dir]) { console.log(`${d}:`); for (const l of chainVerdicts(d)) console.log(`  ${l}`); }
    } else if (cmd === "session-gone") {
      markGone(p, now(), idArg(arg));
    } else if (cmd === "session-start") {
      const raw = (arg ?? "").replace(/[^0-9]/g, "").slice(0, 8);
      const r = sessionStart(p, now(), raw === "" ? null : Number(raw), noticeCall(p), idArg(process.argv[4]));
      console.log(`run ${r.id} ${r.kind}`);
    } else if (cmd === "self-restart") {
      const sw = (process.argv[4] === "on" || process.argv[4] === "off" ? process.argv[4] : "unknown") as Switch;
      console.log(selfRestart(p, now(), arg ?? "", sw, idArg(process.argv[5]), process.argv[6] ?? "", noticeCall(p)));
    } else if (cmd === "self-report") {
      console.log(selfReport(parseSelfRows(text(p.selfRows) ?? ""), now(), tz));
    } else if (cmd === "install") {
      const i = recordInstall(p, arg ?? "", now());
      console.log(i ? `${i.version} since ${i.at || "before the probe"}` : "no version");
    } else {
      console.error("usage: main.ts loop | pass | install <version> | boot <start id> | session-asked <id> | stop-asked <id> <start id> [t0] | stop-finish <code> <signal> [t0] | session-gone <id> | session-start <code> <id> | self-restart <kind> <on|off|unknown> <start id> <cause> | self-report | folders");
      process.exit(2);
    }
  } catch (e) {
    if (!onTamper(e, noticeCall(p))) throw e;
    process.exit(3);
  }
}
