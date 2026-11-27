// The probe (Cain 0.14.0): what decides, with no files, clocks or network, so the tests can drive
// every edge. probe/main.ts (root) gathers the facts and acts. This release only alarms: nothing in
// it restores, rolls back or calls the Supervisor.
//
// What the probe measures (DOCS.md, "What 0.14.0 does"):
//   - liveness, every 5 minutes, with no model call: the Discord plugin's process is up, his tmux
//     session is there, the link's Discord gateway connection is up and acknowledged recently, and
//     typed input went into his session since the last check-in over an hour old. These show his
//     parts are running, not that he answers you: they can say alive while messages are lost;
//   - the hourly liveness check of his session: a fixed line handed to his session by root's
//     broker, which he must answer with the fixed reply through the reply tool. It shows his
//     session takes a turn, not that your messages reach him. A real round trip is a later item.
//   - repeated early exits of his session: every start is kept in /data with how the run before it
//     ended. More than 3 early exits (an unasked end within 5 minutes of the run's start) in 30
//     minutes alarm;
//   - repeated late error exits of his session: more than 4 non-zero exits after the 5-minute mark
//     in 60 minutes alarm (his own user can cause one, so they are counted apart);
//   - repeated restarts whose end root never saw (no exit recorded for the run and no valid asked mark;
//     sixth round): more than 3 in 30 minutes, more than 6 in 60 minutes, or (seventh round) more than
//     8 in 24 hours alarm that his session keeps restarting. Those three windows are the bound: a slower
//     pace than all three stays under them. That is a cadence, not a confirmed exit, and its alarm says so;
//   - repeated starts of his App's container: more than 3 counted starts in 30 minutes alarm. A start
//     after a stop that was asked for (the Supervisor's stop or update) and the first two starts
//     within 10 minutes of a version change aren't counted there;
//   - repeated asked restarts of his App's container (seventh round): every stop the Supervisor asks for
//     arrives as the same SIGTERM, whoever asked (the owner, an automation, a watchdog), so asked starts
//     are counted in their own windows: more than 6 in 60 minutes, or (eighth round) more than 12 in 24
//     hours, alarm that the App keeps being restarted;
//   - every start together, whatever its kind (eighth round): each container start (boot, asked or update)
//     and each restart of his session after an early exit, an unseen end or a late error exit, counted in
//     one combined window: more than 8 in 60 minutes, or more than 12 in 24 hours, alarm that the App keeps
//     starting, with the counts by kind. A loop that mixes kinds (5 asked and 3 unseen in an hour) or
//     paces one kind under its own limits can't stay under this one. The per-kind windows stay as they are.
// Within a day of a version change, the early-exit, unseen, container, asked-restart or combined-start loop also says so (a first record
// counts as an install, Cain 0.15.0); outside that day an alarm gives the count, the window and what root saw only.
// The owner's Stop (stop.json) stops jobs, cards and merges, not his session, so none of this reads it.
// Only the App's own stopped mode (the mode file says none) silences the liveness alarms and pings.

export const PASS_EVERY_S = 300;
export const ASK_EVERY_S = 3600;
export const ANSWER_S = 20 * 60;
export const WORK_MAX_S = 60 * 60;               // a turn at work extends the hourly window this much at most
export const STARTS_WINDOW_S = 30 * 60;
export const STARTS_MAX = 3;                     // more than this many early exits in the window
export const SHORT_RUN_S = 5 * 60;               // a run that ended unasked within this of its start exited early
export const SELF_WINDOW_S = 60 * 60;
export const SELF_MAX = 4;                       // more than this many late error exits in the hour
export const UNSEEN_WINDOW_S = 60 * 60;
export const UNSEEN_MAX = 6;                     // more than this many restarts with the end unseen in the hour
export const UNSEEN_TIGHT_MAX = 3;               // or more than this many in STARTS_WINDOW_S (a tight loop)
export const UNSEEN_DAY_S = 24 * 3600;
export const UNSEEN_DAY_MAX = 8;                 // or more than this many in a day (a slow loop, seventh round)
export const ASKED_WINDOW_S = 60 * 60;
export const ASKED_MAX = 6;                      // more than this many asked container starts in the hour
export const ASKED_DAY_S = 24 * 3600;
export const ASKED_DAY_MAX = 12;                 // or more than this many in a day (eighth round)
export const ALL_WINDOW_S = 60 * 60;
export const ALL_MAX = 8;                        // more than this many starts of every kind together in the hour
export const ALL_DAY_S = 24 * 3600;
export const ALL_DAY_MAX = 12;                   // or more than this many in a day (eighth round)
export const DEFER_MAX_S = 2 * 3600;             // the hourly line waits for a turn at most this long
export const TURN_LONG_S = 2 * 3600;             // a turn at work this long alarms, once a stretch
export const BOOTS_MAX = 3;                      // more than this many counted container starts in the window
export const UPDATE_BOOT_S = 10 * 60;            // starts this soon after a version change may be the update's own
export const UPDATE_BOOTS = 2;                   // and the first this many of them aren't counted
export const STOP_MARK_S = 5 * 60;               // a stop mark older than this, at the next container start, doesn't count
export const START_ID = /^[0-9a-f]{16}$/;        // the run script's own id for one start of it (the asked mark is bound to it)
export const OWNER_QUIET_S = 5 * 60;             // no hourly ask within this of a message of the owner's
export const INSTALL_WINDOW_S = 24 * 3600;
export const GATEWAY_ACK_S = 180;                // Discord acknowledges the link's heartbeat every ~41 s
export const INPUT_GRACE_S = 3600;               // a check-in has its hour to go in (watch.sh)
export const CHECKIN_SLOTS = ["0710", "1230", "1730"];

// The hourly liveness check. The chat id is no Discord chat (no real id starts with zeros): the
// broker answers a reply to it itself and never sends it on, to Discord or to the gate.
export const PROBE_CHAT = "000000000000000000";
// Cain 0.20.0: the shortest line that proves he answers, one word back and no other tool call (his
// rules say so), since this turn ran every hour on his whole context (7 percent of his week's reads).
export const PROBE_REPLY = "alive";
export const PROBE_LINE = `App liveness check: reply tool, chat_id ${PROBE_CHAT}, text "${PROBE_REPLY}". Nothing else.`;

export type Layer = "plugin" | "tmux" | "gateway" | "input";
export const LAYER_WORDS: Record<Layer, string> = {
  plugin: "the Discord plugin isn't running",
  tmux: "his session isn't there",
  gateway: "the link's Discord connection isn't acknowledged",
  input: "nothing typed has gone into his session since the last check-in",
};

// What his screen shows, read from a capture of his pane (prompt-state.sh for his prompt, and the
// sign-in and API-error screens by their words in the last lines).
// A usage or spend limit (Cain 0.20.0): Claude Code's own reply when the plan's usage limit or the
// model's monthly spend limit stops him. On Nov 27 every turn from about 6:20 to 9:04 AM failed on the
// monthly spend limit while his prompt looked ready, so the probe called that screen ready and no alarm
// named the cause. Now it is its own status, alarmed at once with the fix, and never ready. It counts
// while it is the newest thing on his screen (no reply of his after it, in the last 40 lines), so a
// limit that a later turn got past no longer counts. The typing path is unchanged by it.
export type Screen = "ready" | "working" | "signin" | "api" | "limit" | "other";
export const LIMIT = /you'?ve (hit|reach(?:ed)) your [a-z ]{0,30}limit|\/usage-credits|\b(monthly )?spend limit\b|usage limit (reach(?:ed)|hit)|limit reach(?:ed)[^\n]{0,40}resets/i;
const SIGNIN = /run \/login|token has expired|authentication_error|invalid api key|not logged in|paste.*code|oauth\/authorize/i;
const API = /api error|overloaded_error|internal server error|request timed out|connection error|api_error|rate_limit_error|\b(500|502|503|529)\b.*(error|status)|retrying in \d+/i;
export function limitNow(capture: string): boolean {
  const lines = capture.split("\n").filter((l) => l.trim()).slice(-40);
  let lim = false;
  for (const l of lines) {
    if (LIMIT.test(l)) lim = true;
    else if (lim && /^\s*(⏺|●)/.test(l)) lim = false;
  }
  return lim;
}
export function screenOf(capture: string, promptState: string): Screen {
  const last = capture.split("\n").filter((l) => l.trim()).slice(-12);
  if (limitNow(capture)) return "limit";
  if (last.some((l) => SIGNIN.test(l))) return "signin";
  if (last.some((l) => /esc to interrupt/i.test(l))) {
    // A turn at work that is only retrying the model's API is the API not answering.
    return last.some((l) => API.test(l)) ? "api" : "working";
  }
  if (last.some((l) => API.test(l))) return "api";
  return promptState.trim() === "ready" ? "ready" : "other";
}

export interface Facts {
  now: number;                                   // seconds
  plugin: boolean;                               // a process of the Discord plugin's server runs
  tmux: boolean;                                 // tmux says his session is there
  gateway: { state: string; ack: number } | null;   // the link's /run/cain/link-gateway.state
  delivered: number | null;                      // /data/checkin.delivered: when typed input last went in
  slot: number | null;                           // the last check-in, over INPUT_GRACE_S old (lastSlot)
}

export function layers(f: Facts): Layer[] {
  const failed: Layer[] = [];
  if (!f.plugin) failed.push("plugin");
  if (!f.tmux) failed.push("tmux");
  if (!f.gateway || f.gateway.state !== "connected" || !(f.gateway.ack > 0) || f.now - f.gateway.ack > GATEWAY_ACK_S) failed.push("gateway");
  if (f.slot !== null && !(f.delivered !== null && f.delivered >= f.slot)) failed.push("input");
  return failed;
}

// The offset of a time zone from UTC at an instant, in seconds (east positive).
function tzOffset(atS: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atS * 1000));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) / 1000) - atS;
}
// The epoch seconds of a wall-clock time in a time zone.
export function localTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}
// The newest check-in time that is at least INPUT_GRACE_S before now: typed input must have gone in
// since then. null when none is found in the last three days (it can't happen with three a day).
export function lastSlot(now: number, tz: string, grace = INPUT_GRACE_S): number | null {
  const edge = now - grace;
  let best: number | null = null;
  for (let back = 0; back < 3; back++) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date((now - back * 86400) * 1000)).split("-").map(Number);
    for (const s of CHECKIN_SLOTS) {
      const t = localTime(day[0], day[1], day[2], Number(s.slice(0, 2)), Number(s.slice(2)), tz);
      if (t <= edge && (best === null || t > best)) best = t;
    }
  }
  return best;
}

// -- the hourly liveness check --------------------------------------------------------------------
// deferred: when the hourly line first came due and was held back (a turn at work, or the owner's
// 5 minutes), cleared once it is asked. busy: when his screen was first seen at work in the current
// stretch, cleared when it isn't. turnTold: the stretch (its busy) whose long turn was alarmed.
export interface Hourly { asked?: number; answered?: number; timedOut?: number; deferred?: number; busy?: number; turnTold?: number }
export type HourlyState = "none" | "waiting" | "answered" | "timeout";
// working: his screen is at work on a turn now. A long turn isn't a missed answer: the window
// stretches while the screen is at work, up to WORK_MAX_S more.
export function hourlyState(h: Hourly, now: number, working = false): HourlyState {
  if (!h.asked) return "none";
  if (h.answered && h.answered >= h.asked) return "answered";
  const age = now - h.asked;
  if (age < ANSWER_S) return "waiting";
  if (working && age < ANSWER_S + WORK_MAX_S) return "waiting";
  return "timeout";
}
// Ask now? Only when his screen is free (no turn at work), never within OWNER_QUIET_S of a message
// of the owner's reaching his session (ownerAt, the broker's note of when), never while the last ask
// waits for its answer, and at most hourly (a failed ask too: it's asked again an hour after the
// last). An ask skipped for a turn or the owner is simply asked at the next pass that may, but the
// wait is capped: once it came due DEFER_MAX_S ago (h.deferred) it goes in anyway, so a turn that
// never ends can't keep the check out for good.
export function clockDue(h: Hourly, now: number): boolean {
  if (hourlyState(h, now) === "waiting") return false;
  return !h.asked || now - h.asked >= ASK_EVERY_S;
}
export function askDue(h: Hourly, now: number, screenFree: boolean, ownerAt: number | null = null): boolean {
  if (!clockDue(h, now)) return false;
  if (h.deferred !== undefined && now - h.deferred >= DEFER_MAX_S) return true;
  if (!screenFree) return false;
  if (ownerAt !== null && now - ownerAt < OWNER_QUIET_S) return false;
  return true;
}
// How long his screen has been at work without a break, in minutes, once it is TURN_LONG_S or more
// and that stretch wasn't alarmed yet; else null. The liveness layers never wait on this.
export function longTurn(h: Hourly, now: number): number | null {
  if (h.busy === undefined || now - h.busy < TURN_LONG_S || h.turnTold === h.busy) return null;
  return Math.floor((now - h.busy) / 60);
}

// -- one pass ---------------------------------------------------------------------------------------
// status: "ok" passed; "failed" a liveness check failed; "signin" or "api" his screen says why he
// can't answer (alarmed as that, never as a failure); "stopped" the App's own stopped mode (the mode
// file says none: the App stopped his session on purpose and told the owner itself), no alarm and no
// ping. The owner's Stop is none of these: his session keeps running and answering through it.
export type Status = "ok" | "failed" | "signin" | "api" | "limit" | "stopped";
export interface Pass { at: number; ok: boolean; failed: string[]; hourly: HourlyState; status?: Status; screen?: Screen }
export function pass(f: Facts, h: Hourly, o: { screen?: Screen; appStopped?: boolean } = {}): Pass {
  const failed: string[] = layers(f);
  const hourly = hourlyState(h, f.now, o.screen === "working");
  if (hourly === "timeout") failed.push("answer");
  const ok = failed.length === 0;
  let status: Status = ok ? "ok" : "failed";
  if (o.appStopped) status = "stopped";
  else if (o.screen === "limit") status = "limit";
  else if (o.screen === "signin") status = "signin";
  else if (o.screen === "api") status = "api";
  // His screen as read, kept only while his session is there: a capture of no session isn't a screen.
  return { at: f.now, ok, failed, hourly, status, ...(o.screen && f.tmux ? { screen: o.screen } : {}) };
}
// The outside heartbeat hears from the probe only when every check passed. A missed ping is the alarm
// from outside. The owner's Stop doesn't touch it (his session runs on); only the App's own stopped
// mode, which already told him, does: then no pass passes and nothing is pinged.
export function shouldPing(p: Pass): boolean { return p.ok === true && p.failed.length === 0 && p.status !== "stopped"; }
// The alarm the App raises for a pass, or null: two failed passes in a row (or a missed hourly
// answer, at once); a sign-in or API screen as that, at once; never in the App's own stopped mode.
export type AlarmKind = "probe" | "needs-signin" | "api-down" | "usage-limit";
// A screen the probe doesn't recognise ("other": not ready, not at work, no sign-in, API error or limit)
// is never taken as ready, and once it has lasted OTHER_ALARM_S in passes on end it raises the probe's
// own alarm (Cain 0.20.0), even while every liveness layer passes.
export const OTHER_ALARM_S = 10 * 60;
export function otherFor(recent: Pass[]): number | null {
  let first: Pass | null = null;
  for (let i = recent.length - 1; i >= 0 && recent[i].screen === "other"; i--) first = recent[i];
  const last = recent.at(-1);
  if (!first || !last || last.at - first.at < OTHER_ALARM_S) return null;
  return Math.floor((last.at - first.at) / 60);
}
export function alarmFor(recent: Pass[]): AlarmKind | null {
  const last = recent.at(-1);
  if (!last) return null;
  const st = last.status ?? (last.ok ? "ok" : "failed");
  if (st === "stopped") return null;
  if (st === "limit") return "usage-limit";
  if (otherFor(recent) !== null) return "probe";
  if (st === "ok") return null;
  if (st === "signin") return "needs-signin";
  if (st === "api") return "api-down";
  if (last.failed.includes("answer")) return "probe";
  const before = recent.at(-2);
  const bst = before ? before.status ?? (before.ok ? "ok" : "failed") : "ok";
  return bst === "failed" ? "probe" : null;
}
export function failedWords(p: Pass): string {
  const w = p.failed.map((l) => l === "answer" ? "he didn't answer the hourly liveness check of his session" : LAYER_WORDS[l as Layer] ?? l);
  return w.join("; ");
}

// -- starts of his session, and of the App's container -----------------------------------------------
// The starts file: one "<epoch seconds> <how the run before it ended>" line per start of his
// session, root's, in /data, so nothing in his session or its restart can reset it. How the run
// before ended comes from what root alone saw (endKind):
//   boot           the first start in this container (no session ran here before it);
//   asked          the run script recorded its own stop request for that very run before it ended
//                  (a root-owned mark naming the run, matching the run script's own memory of the
//                  run, never a guess from an exit code or a signal);
//   early-<how>    unasked, within SHORT_RUN_S of its start: <how> is the exit code kept, "clean"
//                  for 0, or "unknown" when none was kept. Only these count toward the early-exit
//                  alarm;
//   clean, unknown unasked, later than that, exit 0 or no code kept, the end seen;
//   unseen         a run with no recorded exit and no valid asked mark (s6 restarted the run script
//                  meanwhile, or it died before its exit handlers ran), however long it ran: how it
//                  ended is unknown, so it counts in its own three windows, as a restart cadence (more
//                  than 3 in 30 minutes, more than 6 in 60, or more than 8 in 24 hours);
//   self-<code>    unasked, later than that, a non-zero exit, seen. His own user can end his session
//                  with any code, so these count apart, in their own hour-long window.
export const END_KINDS = /^(boot|asked|clean|unknown|unseen|early-(clean|unknown|\d{1,3})|self-\d{1,3})$/;
// ran: seconds from the run's start to when root saw it end. seen false: root never saw it end: unseen,
// however long it ran (sixth round; it was an early exit under 5 minutes before, which claimed an exit
// root never saw).
export function endKind(o: { first: boolean; asked: boolean; code: number | null; ran: number | null; seen?: boolean }): string {
  if (o.first) return "boot";
  if (o.asked) return "asked";
  if (o.seen === false) return "unseen";
  const code = o.code === null ? null : Math.abs(Math.trunc(o.code)) % 1000;
  const how = code === null ? "unknown" : code === 0 ? "clean" : String(code);
  if (o.ran === null || o.ran < 0) return "unknown";
  const short = o.ran <= SHORT_RUN_S;
  if (short) return `early-${how}`;
  if (code === null) return "unknown";
  if (code === 0) return "clean";
  return `self-${code}`;
}
const startLines = (text: string, kind: RegExp) => text.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => kind.test(p[1] ?? ""))
  .map((p) => Number(p[0])).filter((n) => Number.isSafeInteger(n) && n > 0);
// The starts after an early exit only.
export function parseStarts(text: string): number[] { return startLines(text, /^early-/); }
// The starts after a late error exit (self).
export function parseSelf(text: string): number[] { return startLines(text, /^self-\d+$/); }
// The starts after a run whose end root never saw (unseen).
export function parseUnseen(text: string): number[] { return startLines(text, /^unseen$/); }
export function startsIn(starts: number[], now: number, since = 0, window = STARTS_WINDOW_S): number {
  return starts.filter((t) => t > now - window && t <= now && t >= since).length;
}
export function tooManyStarts(starts: number[], now: number, since = 0): boolean {
  return startsIn(starts, now, since) > STARTS_MAX;
}
export function tooManySelf(self: number[], now: number): boolean { return startsIn(self, now, 0, SELF_WINDOW_S) > SELF_MAX; }
// Unseen ends, in three windows: more than 3 in 30 minutes, more than 6 in 60 minutes, or (seventh
// round) more than 8 in 24 hours, so a restart every 11 minutes all day can't stay under them.
export function tooManyUnseen(unseen: number[], now: number): boolean {
  return startsIn(unseen, now) > UNSEEN_TIGHT_MAX || startsIn(unseen, now, 0, UNSEEN_WINDOW_S) > UNSEEN_MAX
    || startsIn(unseen, now, 0, UNSEEN_DAY_S) > UNSEEN_DAY_MAX;
}
// The count an unseen alarm gives, with its window: the tightest window that tripped.
export function unseenCount(unseen: number[], now: number): string {
  const n30 = startsIn(unseen, now), n60 = startsIn(unseen, now, 0, UNSEEN_WINDOW_S), nDay = startsIn(unseen, now, 0, UNSEEN_DAY_S);
  if (n30 > UNSEEN_TIGHT_MAX) return `${n30} in 30 minutes`;
  if (n60 > UNSEEN_MAX) return `${n60} in 60 minutes`;
  return `${nDay} in 24 hours`;
}
// The last exit code root kept with a start (early-<code>, self-<code>, clean as 0), or null.
export function lastCode(text: string): string | null {
  const kinds = text.split("\n").map((l) => l.trim().split(/\s+/)[1] ?? "").filter((k) => END_KINDS.test(k));
  for (const k of kinds.reverse()) {
    const m = /^(?:early|self)-(\d{1,3})$/.exec(k);
    if (m) return m[1];
    if (k === "clean" || k === "early-clean") return "0";
    if (k !== "boot" && k !== "asked") return null;
  }
  return null;
}
// A line of his session's log, as it may go into an alarm: his user writes that log, so only plain
// characters, links taken out, and short.
export function logLine(raw: string): string | null {
  const last = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  const s = last.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "(a link)").replace(/[^A-Za-z0-9 .,:;()'_=+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return s || null;
}
// The cause an exit alarm carries: the count and window, the last exit code, and the last line of his
// session's log when one was captured. Short enough for notice.sh (it keeps 160 characters).
export function exitCause(count: string, code: string | null, line: string | null): string {
  return [count, code === null ? "" : `last exit code ${code}`, line ? `session log says: ${line}` : ""].filter(Boolean).join(", ");
}
// The boots file: one "<epoch seconds> <kind>" line per start of the App's container, in /data:
// "boot" counts; "asked" (after a stop the Supervisor asked for) and "update" (one of the first two
// within UPDATE_BOOT_S of a version change) don't.
export type BootKind = "boot" | "asked" | "update";
export function bootKind(o: { now: number; stopAsked: boolean; install: Install | null; bootsText: string }): BootKind {
  if (o.stopAsked) return "asked";
  const i = o.install;
  if (i && i.at > 0 && o.now >= i.at && o.now - i.at <= UPDATE_BOOT_S) {
    const since = o.bootsText.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => Number(p[0]) >= i.at && p[1] === "update").length;
    if (since < UPDATE_BOOTS) return "update";
  }
  return "boot";
}
export function parseBoots(text: string): number[] { return startLines(text, /^boot$/); }
export function tooManyBoots(boots: number[], now: number): boolean { return startsIn(boots, now) > BOOTS_MAX; }
// The asked starts (seventh round): a stop asked of the Supervisor is the same SIGTERM whoever asked, so a
// loop of them (an automation, repeated restarts from the App's page, a watchdog) counts in its own window.
export function parseAsked(text: string): number[] { return startLines(text, /^asked$/); }
// Asked starts in two windows: more than 6 in 60 minutes, or (eighth round) more than 12 in 24 hours, so a
// requested restart every 11 minutes (at most 6 an hour) all day can't stay under them.
export function tooManyAsked(asked: number[], now: number): boolean {
  return startsIn(asked, now, 0, ASKED_WINDOW_S) > ASKED_MAX || startsIn(asked, now, 0, ASKED_DAY_S) > ASKED_DAY_MAX;
}
// The count an asked alarm gives, with its window: the tighter window that tripped.
export function askedCount(asked: number[], now: number): string {
  const n60 = startsIn(asked, now, 0, ASKED_WINDOW_S);
  return n60 > ASKED_MAX ? `${n60} in 60 minutes` : `${startsIn(asked, now, 0, ASKED_DAY_S)} in 24 hours`;
}

// -- every start together (eighth round) -------------------------------------------------------------
// Each class of start is counted in its own windows, so a loop that mixes them (5 asked and 3 unseen in
// an hour) or paces one class under its own limits stayed silent. Here every start counts, whatever its
// kind: each container start from the boots file (boot, asked, update), and each restart of his session
// from the starts file after an early exit, an unseen end or a late error exit. A container start also
// writes a "boot" line to the starts file (the first session in it), and a requested or clean end of his
// session is no restart of the App: neither is counted again here.
export type StartClass = "asked" | "unseen" | "early" | "self" | "update" | "plain";
export interface AnyStart { at: number; kind: StartClass }
const CLASS_WORDS: [StartClass, string][] = [
  ["asked", "asked"], ["unseen", "with no clean stop recorded"], ["early", "after an early exit"],
  ["self", "after an error exit"], ["update", "after the update"], ["plain", "plain"],
];
export function allStarts(bootsText: string, startsText: string): AnyStart[] {
  const out: AnyStart[] = [];
  const rows = (t: string) => t.split("\n").map((l) => l.trim().split(/\s+/)).map((p) => ({ at: Number(p[0]), k: p[1] ?? "" }))
    .filter((r) => Number.isSafeInteger(r.at) && r.at > 0);
  for (const r of rows(bootsText)) {
    if (r.k === "boot") out.push({ at: r.at, kind: "plain" });
    else if (r.k === "asked") out.push({ at: r.at, kind: "asked" });
    else if (r.k === "update") out.push({ at: r.at, kind: "update" });
  }
  for (const r of rows(startsText)) {
    if (r.k === "unseen") out.push({ at: r.at, kind: "unseen" });
    else if (/^early-(clean|unknown|\d{1,3})$/.test(r.k)) out.push({ at: r.at, kind: "early" });
    else if (/^self-\d{1,3}$/.test(r.k)) out.push({ at: r.at, kind: "self" });
  }
  return out.sort((a, b) => a.at - b.at);
}
export function tooManyAll(all: AnyStart[], now: number): boolean {
  const at = all.map((s) => s.at);
  return startsIn(at, now, 0, ALL_WINDOW_S) > ALL_MAX || startsIn(at, now, 0, ALL_DAY_S) > ALL_DAY_MAX;
}
// The cause the combined alarm carries: the count in the tighter window that tripped, then the counts by
// kind in that window ("9 starts in an hour: 5 asked, 3 with no clean stop recorded, 1 plain").
export function allCount(all: AnyStart[], now: number): string {
  const in60 = all.filter((s) => s.at > now - ALL_WINDOW_S && s.at <= now);
  const hour = in60.length > ALL_MAX;
  const inWin = hour ? in60 : all.filter((s) => s.at > now - ALL_DAY_S && s.at <= now);
  const parts = CLASS_WORDS.map(([k, w]) => [inWin.filter((s) => s.kind === k).length, w] as const).filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  return `${inWin.length} starts in ${hour ? "an hour" : "24 hours"}: ${parts.join(", ")}`;
}
// A file kept short: the last day, at most 500 lines.
export function pruneStarts(text: string, now: number): string {
  const keep = text.split("\n").filter((l) => { const n = Number(l.trim().split(/\s+/)[0]); return Number.isSafeInteger(n) && n > now - 86400; });
  return keep.slice(-500).map((l) => `${l}\n`).join("");
}

// -- installs ---------------------------------------------------------------------------------------
export interface Install { id: string; version: string; previous: string | null; at: number }
const VERSION = /^\d+\.\d+\.\d+$/;
// The install record after a start that runs this version. A version that can't be read changes nothing.
// Cain 0.15.0: a first record (none before) is an install too, at this start, so its day is watched. On
// Nov 20 0.14.0, the first version to keep this record, was installed that morning, found no record
// before it, and kept "at 0" (no window): the replay drill's loop never said "since his update". A first
// record is either the App's first install or the update to the first version that keeps one; both are
// an install whose day matters. A record kept as "at 0" by 0.14.0 is taken as it is (that day is past).
export function afterStart(prev: Install | null, version: string, now: number): { install: Install | null; fresh: boolean } {
  if (!VERSION.test(version)) return { install: prev, fresh: false };
  if (!prev) return { install: { id: `${version}@${now}`, version, previous: null, at: now }, fresh: true };
  if (prev.version === version) return { install: prev, fresh: false };
  return { install: { id: `${version}@${now}`, version, previous: prev.version, at: now }, fresh: true };
}
// Inside the 24 hours after an install: from its start up to, not including, 24 hours on.
export function inWindow(i: Install | null, now: number): boolean {
  return !!i && i.at > 0 && now >= i.at && now - i.at < INSTALL_WINDOW_S;
}
// How long ago, in words, for the alarm that names the update ("3 hours", "40 minutes").
export function ago(s: number): string {
  const n = Math.max(0, Math.floor(s));
  if (n < 120) return "a minute";
  if (n < 7200) return `${Math.floor(n / 60)} minutes`;
  return `${Math.floor(n / 3600)} hours`;
}
// The cause the install-correlated alarm carries: the version and how long ago it went in.
export function updateCause(i: Install, now: number): string { return `Cain ${i.version}, installed ${ago(now - i.at)} ago`; }

// -- the App restarting itself (Cain 0.15.0) ----------------------------------------------------------
// When his Discord channel stays down across 3 restarts of his session, or for 10 minutes, the run
// script asks here whether the App restarts itself (cain/docs/self-restart-followup.md): one restart per
// incident (any further one due within 30 minutes of the last coalesces into it), never while the
// Supervisor's watchdog switch is off (the App would stay down: it alarms once, naming the switch),
// and 3 answers in a row from the Supervisor that can't be read alarm with the reason. Every restart is
// kept in /data with its cause and time, for the morning check-in; 3 in 24 hours, or 2 for the same
// cause, alarm.
export const SELF_INCIDENT_S = 30 * 60;
export const SELF_REFUSALS_MAX = 3;
export const SELF_DAY_S = 24 * 3600;
export const SELF_DAY_MAX = 3;
export const SELF_SAME_MAX = 2;
export const SELF_MARK_S = 15 * 60;              // the mark the next container start reads, at most this old
export const SELF_KINDS = /^(channel-down|channel-restarts)$/;
export type Switch = "on" | "off" | "unknown";
export interface SelfRow { at: number; kind: string; cause: string }
export interface SelfState { refusals: number; offTold: boolean }
export type SelfAlarm = { kind: "self-off" | "self-refused" | "self-loops"; cause: string } | { clear: "watchdog" };
export function parseSelfRows(text: string): SelfRow[] {
  const out: SelfRow[] = [];
  for (const l of text.split("\n")) {
    try { const r = JSON.parse(l); if (Number.isSafeInteger(r?.at) && typeof r?.kind === "string" && typeof r?.cause === "string") out.push({ at: r.at, kind: r.kind, cause: r.cause }); }
    catch { /* not a row */ }
  }
  return out;
}
const KIND_WORDS: Record<string, string> = {
  "channel-down": "his Discord channel down 10 minutes",
  "channel-restarts": "his Discord channel down across 3 restarts of his session",
};
export function selfWords(kind: string): string { return KIND_WORDS[kind] ?? kind; }
export function selfDecide(rows: SelfRow[], st: SelfState, sw: Switch, kind: string, cause: string, now: number):
  { decision: "restart" | "wait" | "off" | "unknown"; state: SelfState; row: SelfRow | null; alarms: SelfAlarm[] } {
  const alarms: SelfAlarm[] = [];
  if (rows.some((r) => r.at <= now && now - r.at < SELF_INCIDENT_S)) return { decision: "wait", state: st, row: null, alarms };
  if (sw === "unknown") {
    const refusals = st.refusals + 1;
    if (refusals === SELF_REFUSALS_MAX) alarms.push({ kind: "self-refused", cause: `the Supervisor didn't say whether its watchdog is on, ${refusals} times in a row` });
    return { decision: "unknown", state: { ...st, refusals }, row: null, alarms };
  }
  if (sw === "off") {
    if (!st.offTold) alarms.push({ kind: "self-off", cause });
    return { decision: "off", state: { refusals: 0, offTold: true }, row: null, alarms };
  }
  if (st.offTold) alarms.push({ clear: "watchdog" });
  const row = { at: now, kind, cause };
  const day = [...rows, row].filter((r) => r.at <= now && now - r.at < SELF_DAY_S);
  const same = day.filter((r) => r.kind === kind).length;
  if (day.length >= SELF_DAY_MAX) alarms.push({ kind: "self-loops", cause: `${day.length} in 24 hours, the last for ${selfWords(kind)}` });
  else if (same >= SELF_SAME_MAX) alarms.push({ kind: "self-loops", cause: `${same} in 24 hours for ${selfWords(kind)}` });
  return { decision: "restart", state: { refusals: 0, offTold: false }, row, alarms };
}
// The morning check-in's line: each self-restart in the 24 hours before, with its time and cause.
export function selfReport(rows: SelfRow[], now: number, tz: string): string {
  const day = rows.filter((r) => r.at <= now && now - r.at < SELF_DAY_S);
  if (!day.length) return "";
  const t = (s: number) => new Date(s * 1000).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `Your App restarted itself ${day.length === 1 ? "once" : `${day.length} times`} in the last 24 hours: ${day.map((r) => `at ${t(r.at)}, for ${selfWords(r.kind)}`).join("; ")}. It did that itself and it's back; tell him in one line in the morning message, and nothing for him to do.`;
}
