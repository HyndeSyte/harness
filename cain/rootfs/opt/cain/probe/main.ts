// The probe (Cain 0.14.0), root's, outside his session, like watch.sh (probe/core.ts has the rule).
// What it measures is liveness, not proof of service, except the message round trip:
//   bun main.ts loop                 a pass every 5 minutes, for good (the run script starts it)
//   bun main.ts pass                 one pass, now
//   bun main.ts start <end>          one start of his session, kept in /data with how the run before
//                                    it ended (boot, asked, clean, unknown, crash-<code>: the run
//                                    script says), and the restart alarm raised or taken down
//   bun main.ts install <version>    the version this start runs: an install when it changed
//   bun main.ts drill [minutes]      a drill under way (cain/tools/probe-drill.sh): no rollback meanwhile
//   bun main.ts lines morning        the check-in's line about a restore on record, once (checkin.sh)
// The probe's own heartbeat URL (probe_heartbeat_url) comes in PROBE_PING_URL, is read once
// and taken out of the environment, and is never logged, written anywhere or put on a command
// line (fetch sends it; no child process gets it). It is pinged only after a pass that passed:
// the outside service alarms Dane when the pings stop. Every alarm here alarms only: nothing the
// probe sees ever rolls a release back.
import { appendFileSync, chmodSync, chownSync, closeSync, existsSync, fsyncSync, openSync, writeSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { heartbeatUrl } from "../security/core";
import { readStop } from "../stop";
import {
  afterStart, alarmFor, askDue, END_KINDS, failedWords, type Facts, hourlyState, type Hourly, type Install, lastSlot, lostMessages,
  parseIds, parseRecord, pass, type RestoreRecord, type Pass, PASS_EVERY_S, PROBE_LINE, pruneStarts, parseStarts, type Screen, screenOf, shouldPing,
  startsIn, STARTS_MAX, tooManyStarts, unsettled,
} from "./core";

const env = process.env;
export const paths = (e: Record<string, string | undefined> = env) => {
  const D = e.PROBE_DIR ?? "/data/probe";
  const R = e.PROBE_RUN ?? "/run/cain/probe";
  return {
    dir: D, run: R,
    starts: join(D, "starts"), install: join(D, "install.json"), passes: join(D, "passes.jsonl"), hourly: join(D, "hourly.json"),
    alive: join(D, "alive"), drill: join(D, "drill"), alarmed: join(D, "alarmed"),
    ask: join(R, "ask"), answered: join(R, "answered"),
    // The message round trip: ids of his messages the link saw, and ids that reached his session.
    seen: e.PROBE_SEEN ?? join(R, "seen"), reached: e.PROBE_REACHED ?? join(R, "reached"), since: join(R, "since"),
    // The durable record of restores, outside /data (rollback/helper.ts writes it).
    record: e.ROLLBACK_RECORD ?? "/config/rollback-record.json",
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
const WATCH_GID = Number(env.WATCH_GID ?? 1002);

const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const num = (p: string) => { const n = Number((text(p) ?? "").trim().split(/\s+/)[0]); return Number.isFinite(n) && n > 0 ? n : null; };
// Whole or not at all, root's, readable by the watch user's group (it raises the flag).
export function writeWhole(p: string, body: string, mode = 0o640): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o750 });
  writeFileSync(`${p}.tmp`, body, { mode });
  try { chownSync(`${p}.tmp`, 0, WATCH_GID); } catch { /* not root (tests) */ }
  chmodSync(`${p}.tmp`, mode);
  renameSync(`${p}.tmp`, p);
}
const log = (m: string) => console.log(`[cain] probe: ${m}`);
// The durable record of restores (/config): root's alone, whole or not at all, synced before the
// rename, since a restore call may follow at once and replace this container.
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

// One pass: the facts, the hourly liveness check and its answer, the message round trip, the pass
// kept, the ping only when it passed, and the alarm raised once a stretch and taken down when a
// pass goes through. While the owner's Stop holds: no ask and no alarm.
export async function runPass(d: PassDeps): Promise<Pass> {
  const { p, now } = d;
  const h: Hourly = json<Hourly>(p.hourly) ?? {};
  const ans = num(p.answered);
  if (ans && h.asked && ans >= h.asked && !(h.answered && h.answered >= h.asked)) h.answered = ans;
  const own = d.mode === "own";
  // The round trip counts only messages seen since the probe first ran in this container.
  let since = num(p.since);
  if (!since) { try { mkdirSync(p.run, { recursive: true, mode: 0o700 }); writeFileSync(p.since, `${now}\n`, { mode: 0o600 }); } catch { /* next pass */ } since = now; }
  const lost = own ? lostMessages(parseIds(text(p.seen) ?? ""), parseIds(text(p.reached) ?? ""), now, since) : [];
  const facts: Facts = {
    now, plugin: d.plugin(), tmux: d.tmux(), gateway: gatewayState(p),
    delivered: num(p.delivered), slot: lastSlot(now, d.tz), lost,
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
    const cause = kind === "needs-signin" || kind === "api-down" ? "" : kind === "messages" ? `${lost.length} message${lost.length === 1 ? "" : "s"}` : failedWords(result);
    if (d.notice("tell", kind, cause) <= 1) writeWhole(p.alarmed, `${now} ${kind}\n`, 0o600);
  } else if (result.status === "ok" && had) {
    if (d.notice("clear", "probe") <= 1) rmSync(p.alarmed, { force: true });
  }
  return result;
}

// One start of his session, kept with how the run before it ended; the restart alarm (more than 3
// crash starts in 30 minutes) raised or down. Alarm only.
export function recordStart(p: Paths, now: number, end: string, notice: PassDeps["notice"]): number {
  const kind = END_KINDS.test(end) ? end : "unknown";
  mkdirSync(p.dir, { recursive: true, mode: 0o750 });
  appendFileSync(p.starts, `${now} ${kind}\n`, { mode: 0o640 });
  writeWhole(p.starts, pruneStarts(text(p.starts) ?? "", now));
  return checkStarts(p, now, notice);
}
export function checkStarts(p: Paths, now: number, notice: PassDeps["notice"]): number {
  const starts = parseStarts(text(p.starts) ?? "");
  const n = startsIn(starts, now);
  const flag = `${p.alarmed}-starts`;
  if (tooManyStarts(starts, now)) {
    if (!existsSync(flag) && notice("tell", "restarts", `${n} crashes and starts in 30 minutes`) <= 1) writeWhole(flag, `${now}\n`, 0o600);
  } else if (existsSync(flag) && n <= STARTS_MAX) {
    if (notice("clear", "restarts") <= 1) rmSync(flag, { force: true });
  }
  return n;
}

// The restore on record still to be settled names the version it restored to: a start on that
// version is the rollback, never a new install.
export function restoredTo(p: Paths): string | null {
  const r = parseRecord(text(p.record));
  if (r === "damaged") return null;
  return unsettled(r)?.target ?? null;
}
export function recordInstall(p: Paths, version: string, now: number): Install | null {
  const prev = json<Install>(p.install);
  const { install, fresh } = afterStart(prev, version, now, restoredTo(p));
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
    log(`liveness every 5 minutes, and the message round trip; its outside heartbeat ${b.kind === "ok" ? "on" : b.kind === "invalid" ? "set but not usable" : "off (probe_heartbeat_url is empty)"}`);
    await Bun.sleep(Number(env.PROBE_FIRST_S ?? 120) * 1000);
    for (;;) {
      try { await runPass(deps()); checkStarts(p, now(), noticeCall(p)); } catch (e) { log(`a pass failed: ${(e as Error).name}`); }
      await Bun.sleep(PASS_EVERY_S * 1000);
    }
  } else if (cmd === "pass") {
    const r = await runPass(deps());
    console.log(r.ok ? "passed" : `${r.status}: ${failedWords(r)}`);
  } else if (cmd === "start") {
    console.log(`${recordStart(p, now(), arg ?? "unknown", noticeCall(p))} crash starts in 30 minutes`);
  } else if (cmd === "install") {
    const i = recordInstall(p, arg ?? "", now());
    console.log(i ? `${i.version} since ${i.at || "before the probe"}` : "no version");
  } else if (cmd === "drill") {
    const m = Math.min(120, Math.max(1, Number(arg ?? 45) || 45));
    writeWhole(p.drill, `${now() - 45 * 60 + m * 60}\n`);
    console.log(`drill under way: no rollback for ${m} minutes`);
  } else if (cmd === "lines") {
    // A restore on record, settled at a start (rollback/helper.ts boot) and not told yet, once,
    // for the morning's Moving section. The helper marks it told.
    const r = parseRecord(text(p.record));
    const last = r === "damaged" ? null : r.restores.at(-1);
    if (r === "damaged") console.log("Rollback record: the App's record of restores can't be read. Put it in today's Moving section in one line; Dane was told.");
    else if (last && last.outcome && !last.reported && !last.drill && now() - last.at < 2 * 86400) {
      const how = last.outcome === "done" ? `restored Cain ${last.target} in place of ${last.bad}` : last.outcome === "not run" ? `tried to restore Cain ${last.target} in place of ${last.bad}, and the restore didn't happen` : `restored Cain ${last.target} in place of ${last.bad}, but the Supervisor's job for it ${last.outcome === "failed" ? "failed" : "has no known outcome"}`;
      console.log(`Rollback: the App ${how}, because ${last.why ?? "the update kept crashing"}. Put it in today's Moving section in one line. Dane was told when it happened.`);
      last.reported = true;
      writeRecord(p.record, r);
    }
  } else {
    console.error("usage: main.ts loop | pass | start <end> | install <version> | drill [minutes] | lines morning");
    process.exit(2);
  }
}
