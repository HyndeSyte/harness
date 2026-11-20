// The probe (Cain 0.14.0), root's, outside his session, like watch.sh (probe/core.ts has the rule).
// What it measures is liveness: it can say alive while messages are lost. This release only alarms.
//   bun main.ts loop                 a pass every 5 minutes, for good (the run script starts it)
//   bun main.ts pass                 one pass, now
//   bun main.ts install <version>    the version this start runs: an install when it changed (run
//                                    before boot, so a start the update itself caused isn't counted)
//   bun main.ts boot                 the App's container started: kept in /data once per container
//                                    (boot, asked or update), and the container-start alarm raised or down
//   bun main.ts session-asked <id>   the run script is about to stop his session: a root-owned mark
//                                    naming that very run (the id the run script holds), so its end is
//                                    "asked"
//   bun main.ts stop-asked [id]      the Supervisor is stopping the App (the run script's TERM, or s6's
//                                    finish after it): the run marked asked as above, and a mark in /data
//                                    so the next container start isn't counted
//   bun main.ts session-gone <id>    the run script saw his session gone: when, for how long it ran
//   bun main.ts session-start <code> <id>
//                                    his session starts: the run before it (id: the one the run script
//                                    holds in memory, empty after s6 restarted it) classed from root's
//                                    own marks and the exit code session.sh kept, kept in /data, and the
//                                    alarms raised or down. Prints "run <new id> <kind>".
// The probe's own heartbeat URL (probe_heartbeat_url) comes in PROBE_PING_URL, is read once
// and taken out of the environment, and is never logged, written anywhere or put on a command
// line (fetch sends it; no child process gets it). It is pinged only after a pass that passed:
// the outside service alarms Dane when the pings stop.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { heartbeatUrl } from "../security/core";
import { readStop } from "../stop";
import {
  afterStart, alarmFor, askDue, bootKind, endKind, END_KINDS, failedWords, type Facts, hourlyState, type Hourly, type Install, inWindow, lastSlot,
  parseBoots, pass, type Pass, PASS_EVERY_S, PROBE_LINE, pruneStarts, parseSelf, parseStarts, type Screen, screenOf, shouldPing,
  SELF_WINDOW_S, startsIn, tooManyBoots, tooManySelf, tooManyStarts, updateCause,
} from "./core";

const env = process.env;
export const paths = (e: Record<string, string | undefined> = env) => {
  const D = e.PROBE_DIR ?? "/data/probe";
  const R = e.PROBE_RUN ?? "/run/cain/probe";
  return {
    dir: D, run: R,
    starts: join(D, "starts"), install: join(D, "install.json"), passes: join(D, "passes.jsonl"), hourly: join(D, "hourly.json"),
    alive: join(D, "alive"), alarmed: join(D, "alarmed"), boots: join(D, "boots"),
    // The Supervisor asked the App to stop (stop-asked): the next container start isn't counted.
    stopAsked: join(D, "stop-asked"),
    // The hourly check's ask and answer, and when a message of the owner's last came in for his session
    // (the broker's note, a time only).
    ask: join(R, "ask"), answered: join(R, "answered"), heard: join(R, "heard"),
    // This container's marks (tmpfs: a new container starts with none): his session's run as root
    // started it, the run script's own stop request for that run, and that this container booted.
    session: join(R, "session.json"), asked: join(R, "asked"), booted: join(R, "booted"),
    delivered: e.CHECKIN_DELIVERED ?? "/data/checkin.delivered",
    gateway: e.PROBE_GATEWAY ?? "/run/cain/link-gateway.state",
    mode: e.PROBE_MODE_FILE ?? "/run/cain/mode",
    stop: e.CAIN_STOP_FILE ?? "/data/trust/stop.json",
    proc: e.PROBE_PROC ?? "/proc",
    notice: e.PROBE_NOTICE ?? "/opt/cain/notice.sh",
    promptState: e.PROMPT_STATE ?? "/opt/cain/prompt-state.sh",
  };
};
type Paths = ReturnType<typeof paths>;

const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const num = (p: string) => { const n = Number((text(p) ?? "").trim().split(/\s+/)[0]); return Number.isFinite(n) && n > 0 ? n : null; };
// Whole or not at all, root's alone: written under a fresh temp name created exclusively (never
// following a link or reusing a file), synced, then renamed over the mark. Every mark and record the
// probe keeps goes through here, in folders root alone may write (/run/cain/probe, /data/probe).
export function writeWhole(p: string, body: string, mode = 0o600): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, body); fsyncSync(fd); } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
  closeSync(fd);
  try { renameSync(tmp, p); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const log = (m: string) => console.log(`[cain] probe: ${m}`);

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
  stopped?: () => boolean;                           // the owner's Stop holds (default: read stop.json)
  ping: () => Promise<boolean>;                      // false: not sent (unset, or it failed)
  notice: (...args: string[]) => number;             // notice.sh's exit code
}

// One pass: the facts, the hourly liveness check and its answer, the pass kept, the ping only when it passed, and the alarm raised once a stretch and taken down when a
// pass goes through. While the owner's Stop holds: no ask and no alarm.
export async function runPass(d: PassDeps): Promise<Pass> {
  const { p, now } = d;
  const h: Hourly = json<Hourly>(p.hourly) ?? {};
  const ans = num(p.answered);
  if (ans && h.asked && ans >= h.asked && !(h.answered && h.answered >= h.asked)) h.answered = ans;
  const own = d.mode === "own";
  const facts: Facts = {
    now, plugin: d.plugin(), tmux: d.tmux(), gateway: gatewayState(p),
    delivered: num(p.delivered), slot: lastSlot(now, d.tz),
  };
  const screen = d.screen();
  // A Stop file that can't be read silences nothing: only his saved Stop does.
  const stopped = (d.stopped ?? (() => { const s = readStop(p.stop); return s.stopped && s.at !== null; }))();
  // The hourly check goes through the broker (the new way only): the old way has no broker, so it
  // isn't asked there, and an ask from before doesn't count.
  const hh: Hourly = own ? h : {};
  const result = pass(facts, hh, { screen, stopped });
  // Not while a turn is at work (his screen not ready) or within 5 minutes of a message of the
  // owner's: asked at the next pass that may instead.
  if (own && !stopped && askDue(h, now, screen === "ready", num(p.heard))) {
    try {
      writeWhole(p.ask, `${now} ${PROBE_LINE.length}\n`);
      rmSync(p.answered, { force: true });
      h.asked = now; delete h.answered;
    } catch (e) { log(`couldn't ask the hourly liveness check: ${String(e).slice(0, 80)}`); }
  }
  if (own) {
    if (hourlyState(h, now, screen === "working") === "timeout" && h.timedOut !== h.asked) { h.timedOut = h.asked; log("he didn't answer the hourly liveness check of his session"); }
    writeWhole(p.hourly, JSON.stringify(h));
  }
  const old = (text(p.passes) ?? "").split("\n").filter(Boolean).slice(-299);
  writeWhole(p.passes, [...old, JSON.stringify(result)].join("\n") + "\n");
  writeWhole(p.alive, `${now}\n`);
  if (shouldPing(result)) { if (!(await d.ping())) log("the probe passed, but its outside heartbeat wasn't pinged (unset, or no answer)"); }
  else log(`${result.status === "stopped" ? "Stop holds, no alarm" : result.status === "signin" ? "his screen waits at a sign-in" : result.status === "api" ? "his screen shows the model's API not answering" : "failed"}${result.failed.length ? `: ${failedWords(result)}` : ""}`);
  // The alarm, once a stretch per kind, and its clearing.
  const recent: Pass[] = [...old.slice(-5).map((l) => { try { return JSON.parse(l) as Pass; } catch { return null; } }).filter((x): x is Pass => !!x), result];
  const kind = alarmFor(recent);
  const had = (text(p.alarmed) ?? "").trim().split(/\s+/)[1] ?? (existsSync(p.alarmed) ? "probe" : "");
  // Stopped on purpose (the mode file says none), his stop's own alarm already tells Dane why.
  if (kind && kind !== had && d.mode !== "none") {
    const cause = kind === "needs-signin" || kind === "api-down" ? "" : failedWords(result);
    if (d.notice("tell", kind, cause) <= 1) writeWhole(p.alarmed, `${now} ${kind}\n`, 0o600);
  } else if (result.status === "ok" && had) {
    if (d.notice("clear", "probe") <= 1) rmSync(p.alarmed, { force: true });
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
// The Supervisor is stopping the App (SIGTERM to s6, so the run script's own termination): the run
// marked asked before his session ends, when the run script still holds its id, and a mark in /data
// so the container start after it isn't counted.
export function stopAsked(p: Paths, now: number, mem: string): boolean {
  writeWhole(p.stopAsked, `${now}\n`);
  return mem !== "" && markAsked(p, mem);
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
  rmSync(p.asked, { force: true });
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
function sayUpdate(p: Paths, now: number, kind: "update-exits" | "update-boots", notice: PassDeps["notice"]): void {
  const i = json<Install>(p.install);
  if (!inWindow(i, now)) return;
  if (notice("tell", kind, updateCause(i!, now)) <= 1) writeWhole(flagOf(p, "update"), `${now}\n`);
}
function updateDown(p: Paths, notice: PassDeps["notice"]): void {
  if (!existsSync(flagOf(p, "update")) || existsSync(flagOf(p, "starts")) || existsSync(flagOf(p, "boots"))) return;
  if (notice("clear", "update") <= 1) rmSync(flagOf(p, "update"), { force: true });
}
// Repeated early exits (more than 3 in 30 minutes): "Cain's session keeps exiting early", and within
// a day of an install the line that names it; down once the count is back under. Repeated late error
// exits (more than 4 in 60 minutes): "Cain's session keeps ending on its own", down once back under.
// None of this is silenced by the owner's Stop: a stopped session never starts, so it never counts.
export function checkStarts(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const all = text(p.starts) ?? "";
  const starts = parseStarts(all);
  const n = startsIn(starts, now);
  const flag = flagOf(p, "starts");
  if (tooManyStarts(starts, now)) {
    if (!existsSync(flag) && notice("tell", "restarts", `${n} in 30 minutes`) <= 1) {
      writeWhole(flag, `${now}\n`);
      sayUpdate(p, now, "update-exits", notice);
    }
  } else if (existsSync(flag)) {
    if (notice("clear", "restarts") <= 1) rmSync(flag, { force: true });
  }
  const self = parseSelf(all);
  const sflag = flagOf(p, "self");
  if (tooManySelf(self, now)) {
    if (!existsSync(sflag) && notice("tell", "self-loop", `${startsIn(self, now, 0, SELF_WINDOW_S)} in 60 minutes`) <= 1) writeWhole(sflag, `${now}\n`);
  } else if (existsSync(sflag)) {
    if (notice("clear", "self") <= 1) rmSync(sflag, { force: true });
  }
  updateDown(p, notice);
  return n;
}
// The App's container started: kept once per container (a mark in /run, which a new container starts
// without) as "boot", "asked" (the Supervisor asked the App to stop before it: the mark in /data,
// taken here) or "update" (one of the first two within 10 minutes of a version change). More than 3
// counted starts in 30 minutes: "Cain's App container keeps starting", and within a day of an install
// the line that names it.
export function recordBoot(p: Paths, now: number, notice: PassDeps["notice"]): string | null {
  if (existsSync(p.booted)) return null;
  writeWhole(p.booted, `${now}\n`);
  const kind = bootKind({ now, stopAsked: existsSync(p.stopAsked), install: json<Install>(p.install), bootsText: text(p.boots) ?? "" });
  addLine(p.boots, `${now} ${kind}`, now);
  rmSync(p.stopAsked, { force: true });
  checkBoots(p, now, notice);
  return kind;
}
export function checkBoots(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const boots = parseBoots(text(p.boots) ?? "");
  const n = startsIn(boots, now);
  const flag = flagOf(p, "boots");
  if (tooManyBoots(boots, now)) {
    if (!existsSync(flag) && notice("tell", "boots", `${n} in 30 minutes`) <= 1) {
      writeWhole(flag, `${now}\n`);
      sayUpdate(p, now, "update-boots", notice);
    }
  } else if (existsSync(flag)) {
    if (notice("clear", "boots") <= 1) rmSync(flag, { force: true });
  }
  updateDown(p, notice);
  return n;
}

export function recordInstall(p: Paths, version: string, now: number): Install | null {
  const prev = json<Install>(p.install);
  const { install, fresh } = afterStart(prev, version, now);
  if (install && install !== prev) writeWhole(p.install, JSON.stringify(install));
  if (fresh && install) log(`installed: Cain ${install.version} (was ${install.previous}); the next 24 hours are watched`);
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
  if (cmd === "loop") {
    const b = heartbeatUrl(url);
    log(`liveness every 5 minutes; its outside heartbeat ${b.kind === "ok" ? "on" : b.kind === "invalid" ? "set but not usable" : "off (probe_heartbeat_url is empty)"}`);
    await Bun.sleep(Number(env.PROBE_FIRST_S ?? 120) * 1000);
    for (;;) {
      try { await runPass(deps()); } catch (e) { log(`a pass failed: ${(e as Error).name}`); }
      try { checkStarts(p, now(), noticeCall(p)); checkBoots(p, now(), noticeCall(p)); } catch (e) { log(`the start count failed: ${(e as Error).name}`); }
      await Bun.sleep(PASS_EVERY_S * 1000);
    }
  } else if (cmd === "pass") {
    const r = await runPass(deps());
    console.log(r.ok ? "passed" : `${r.status}: ${failedWords(r)}`);
  } else if (cmd === "boot") {
    const k = recordBoot(p, now(), noticeCall(p));
    console.log(k ? `this container's start kept as ${k}` : "this container's start was kept already");
  } else if (cmd === "session-asked") {
    console.log(markAsked(p, idArg(arg)) ? "marked: this run's end was asked for" : "no run of his to mark");
  } else if (cmd === "stop-asked") {
    console.log(stopAsked(p, now(), idArg(arg)) ? "the stop was asked for: kept, and his run marked" : "the stop was asked for: kept");
  } else if (cmd === "session-gone") {
    markGone(p, now(), idArg(arg));
  } else if (cmd === "session-start") {
    const raw = (arg ?? "").replace(/[^0-9]/g, "").slice(0, 8);
    const r = sessionStart(p, now(), raw === "" ? null : Number(raw), noticeCall(p), idArg(process.argv[4]));
    console.log(`run ${r.id} ${r.kind}`);
  } else if (cmd === "install") {
    const i = recordInstall(p, arg ?? "", now());
    console.log(i ? `${i.version} since ${i.at || "before the probe"}` : "no version");
  } else {
    console.error("usage: main.ts loop | pass | install <version> | boot | session-asked <id> | stop-asked [id] | session-gone <id> | session-start <code> <id>");
    process.exit(2);
  }
}
