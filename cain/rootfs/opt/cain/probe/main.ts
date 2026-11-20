// The probe (Cain 0.14.0), root's, outside his session, like watch.sh (probe/core.ts has the rule).
// What it measures is liveness: it can say alive while messages are lost. This release only alarms.
//   bun main.ts loop                 a pass every 5 minutes, for good (the run script starts it)
//   bun main.ts pass                 one pass, now
//   bun main.ts boot                 the App's container booted: counted in /data once per container,
//                                    and the boot-loop alarm raised or taken down
//   bun main.ts session-asked        the run script is about to stop his session: a root-owned mark
//                                    naming that very run, so its end is "asked"
//   bun main.ts session-gone         the run script saw his session gone: when, for how long it ran
//   bun main.ts session-start [code] his session starts: the run before it classed (boot, asked,
//                                    crash-*, clean, unknown, self-*) from root's own marks and the exit
//                                    code session.sh kept, kept in /data, and the alarms raised or down
//   bun main.ts install <version>    the version this start runs: an install when it changed
// The probe's own heartbeat URL (probe_heartbeat_url) comes in PROBE_PING_URL, is read once
// and taken out of the environment, and is never logged, written anywhere or put on a command
// line (fetch sends it; no child process gets it). It is pinged only after a pass that passed:
// the outside service alarms Dane when the pings stop.
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, openSync, writeSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { heartbeatUrl } from "../security/core";
import { readStop } from "../stop";
import {
  afterStart, alarmFor, askDue, endKind, END_KINDS, failedWords, type Facts, hourlyState, type Hourly, type Install, inWindow, lastSlot,
  parseBoots, pass, type RestoreRecord, type Pass, PASS_EVERY_S, PROBE_LINE, pruneStarts, parseSelf, parseStarts, type Screen, screenOf, shouldPing,
  startsIn, STARTS_MAX, STARTS_WINDOW_S, tooManyBoots, tooManyStarts,
} from "./core";

const env = process.env;
export const paths = (e: Record<string, string | undefined> = env) => {
  const D = e.PROBE_DIR ?? "/data/probe";
  const R = e.PROBE_RUN ?? "/run/cain/probe";
  return {
    dir: D, run: R,
    starts: join(D, "starts"), install: join(D, "install.json"), passes: join(D, "passes.jsonl"), hourly: join(D, "hourly.json"),
    alive: join(D, "alive"), alarmed: join(D, "alarmed"), boots: join(D, "boots"),
    ask: join(R, "ask"), answered: join(R, "answered"),
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
// Whole or not at all, root's alone.
export function writeWhole(p: string, body: string, mode = 0o600): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, body, { mode });
  chmodSync(`${p}.tmp`, mode);
  renameSync(`${p}.tmp`, p);
}
const log = (m: string) => console.log(`[cain] probe: ${m}`);
// The durable record of restores: root's alone, whole or not at all, synced before the rename.
// Used only by the dormant rollback/helper.ts (not started in this release).
export function writeRecord(path: string, r: RestoreRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(`${path}.tmp`, "w", 0o600);
  try { writeSync(fd, JSON.stringify(r)); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
  try { const dfd = openSync(dirname(path), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* best effort */ }
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
  if (own && !stopped && askDue(h, now, screen === "ready")) {
    try {
      mkdirSync(p.run, { recursive: true, mode: 0o700 });
      writeFileSync(`${p.ask}.tmp`, `${now} ${PROBE_LINE.length}\n`, { mode: 0o600 });
      renameSync(`${p.ask}.tmp`, p.ask);
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
const readRun = (p: Paths): Run | null => {
  const r = json<Run>(p.session);
  return r && typeof r.id === "string" && Number.isFinite(r.at) ? r : null;
};
// The run script is about to stop his session: the mark names that very run. Root's alone; his own
// user can't write it, so no exit of his can pass for one the App asked for.
export function markAsked(p: Paths): boolean {
  const r = readRun(p);
  if (!r || r.ended) return false;
  writeWhole(p.asked, `${r.id}\n`);
  return true;
}
// The run script saw his session gone: the first time it saw so is when the run ended.
export function markGone(p: Paths, now: number): void {
  const r = readRun(p);
  if (r && !r.ended) writeWhole(p.session, JSON.stringify({ ...r, ended: now }));
}
// How the run before this start ended, from root's own marks: no run in this container (boot), the
// run script's stop request for that run (asked), and how long it ran (to when root saw it end, or
// now when it didn't); the exit code is session.sh's, his to write, so it alone never makes a start
// "asked" and never counts a late end toward a loop.
export function classify(p: Paths, now: number, code: number | null): string {
  const r = readRun(p);
  if (!r) return "boot";
  const asked = (text(p.asked) ?? "").trim() === r.id;
  const ran = (r.ended ?? now) - r.at;
  return endKind({ first: false, asked, code, ran: ran >= 0 ? ran : null });
}
// One start of his session: the run before it classed and kept, this run's mark written, and the
// alarms raised or taken down. Alarm only.
export function sessionStart(p: Paths, now: number, code: number | null, notice: PassDeps["notice"]): string {
  const kind = classify(p, now, code);
  recordStart(p, now, kind, notice);
  writeWhole(p.session, JSON.stringify({ id: randomBytes(8).toString("hex"), at: now }));
  rmSync(p.asked, { force: true });
  return kind;
}
export function recordStart(p: Paths, now: number, end: string, notice: PassDeps["notice"]): number {
  const kind = END_KINDS.test(end) ? end : "unknown";
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  appendFileSync(p.starts, `${now} ${kind}\n`, { mode: 0o600 });
  writeWhole(p.starts, pruneStarts(text(p.starts) ?? "", now));
  // A late non-zero exit no one asked for: his own user can cause one, so it alarms once a stretch
  // ("Cain's session ended on its own") and never counts toward a loop.
  const self = `${p.alarmed}-self`;
  if (/^self-/.test(kind) && !existsSync(self) && notice("tell", "self-ended", `exit ${kind.slice(5)}`) <= 1) writeWhole(self, `${now}\n`);
  return checkStarts(p, now, notice);
}
// The crash loop (more than 3 crash starts in 30 minutes): "Cain keeps crashing", and within a day
// of an install "A rollback of Cain would have run" too, once for each new loop (one that starts
// after the last one ended); both come down once the count is back under. A stretch of "ended on its
// own" ends after 30 minutes with no such end. None of this is silenced by the owner's Stop: a
// stopped session never starts, so it never counts.
export function checkStarts(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const all = text(p.starts) ?? "";
  const starts = parseStarts(all);
  const n = startsIn(starts, now);
  const flag = `${p.alarmed}-starts`;
  if (tooManyStarts(starts, now)) {
    if (!existsSync(flag) && notice("tell", "restarts", `${n} crash starts in 30 minutes`) <= 1) {
      writeWhole(flag, `${now}\n`);
      const i = json<Install>(p.install);
      if (inWindow(i, now)) notice("tell", "rollback-disarmed", `Cain ${i!.version}, installed within the last day`);
    }
  } else if (existsSync(flag) && n <= STARTS_MAX) {
    if (notice("clear", "restarts") <= 1) rmSync(flag, { force: true });
  }
  const self = `${p.alarmed}-self`;
  if (existsSync(self) && startsIn(parseSelf(all), now) === 0 && (num(self) ?? 0) <= now - STARTS_WINDOW_S) {
    if (notice("clear", "self") <= 1) rmSync(self, { force: true });
  }
  return n;
}
// The App's container booted: counted once per container (a mark in /run, which a new container
// starts without), and more than 3 boots in 30 minutes alarms "Cain's App keeps restarting".
export function recordBoot(p: Paths, now: number, notice: PassDeps["notice"]): boolean {
  if (existsSync(p.booted)) return false;
  writeWhole(p.booted, `${now}\n`);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  appendFileSync(p.boots, `${now}\n`, { mode: 0o600 });
  writeWhole(p.boots, pruneStarts(text(p.boots) ?? "", now));
  checkBoots(p, now, notice);
  return true;
}
export function checkBoots(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const boots = parseBoots(text(p.boots) ?? "");
  const n = startsIn(boots, now);
  const flag = `${p.alarmed}-boots`;
  if (tooManyBoots(boots, now)) {
    if (!existsSync(flag) && notice("tell", "boots", `${n} starts of the App in 30 minutes`) <= 1) writeWhole(flag, `${now}\n`);
  } else if (existsSync(flag)) {
    if (notice("clear", "boots") <= 1) rmSync(flag, { force: true });
  }
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
    console.log(recordBoot(p, now(), noticeCall(p)) ? "boot counted" : "this container's boot was counted already");
  } else if (cmd === "session-asked") {
    console.log(markAsked(p) ? "marked: this run's end was asked for" : "no run of his to mark");
  } else if (cmd === "session-gone") {
    markGone(p, now());
  } else if (cmd === "session-start") {
    const raw = (arg ?? "").replace(/[^0-9]/g, "").slice(0, 8);
    console.log(`the run before: ${sessionStart(p, now(), raw === "" ? null : Number(raw), noticeCall(p))}`);
  } else if (cmd === "install") {
    const i = recordInstall(p, arg ?? "", now());
    console.log(i ? `${i.version} since ${i.at || "before the probe"}` : "no version");
  } else {
    console.error("usage: main.ts loop | pass | boot | session-asked | session-gone | session-start [code] | install <version>");
    process.exit(2);
  }
}
