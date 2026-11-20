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
//   - repeated starts of his App's container: more than 3 counted starts in 30 minutes alarm. A start
//     after a stop that was asked for (the Supervisor's stop or update) and the first two starts
//     within 10 minutes of a version change aren't counted.
// Within a day of a version change, either loop also says so, with the way back by hand.

export const PASS_EVERY_S = 300;
export const ASK_EVERY_S = 3600;
export const ANSWER_S = 20 * 60;
export const WORK_MAX_S = 60 * 60;               // a turn at work extends the hourly window this much at most
export const STARTS_WINDOW_S = 30 * 60;
export const STARTS_MAX = 3;                     // more than this many early exits in the window
export const SHORT_RUN_S = 5 * 60;               // a run that ended unasked within this of its start exited early
export const SELF_WINDOW_S = 60 * 60;
export const SELF_MAX = 4;                       // more than this many late error exits in the hour
export const BOOTS_MAX = 3;                      // more than this many counted container starts in the window
export const UPDATE_BOOT_S = 10 * 60;            // starts this soon after a version change may be the update's own
export const UPDATE_BOOTS = 2;                   // and the first this many of them aren't counted
export const OWNER_QUIET_S = 5 * 60;             // no hourly ask within this of a message of the owner's
export const INSTALL_WINDOW_S = 24 * 3600;
export const GATEWAY_ACK_S = 180;                // Discord acknowledges the link's heartbeat every ~41 s
export const INPUT_GRACE_S = 3600;               // a check-in has its hour to go in (watch.sh)
export const CHECKIN_SLOTS = ["0710", "1230", "1730"];

// The hourly liveness check. The chat id is no Discord chat (no real id starts with zeros): the
// broker answers a reply to it itself and never sends it on, to Discord or to the gate.
export const PROBE_CHAT = "000000000000000000";
export const PROBE_REPLY = "probe answered";
export const PROBE_LINE = `Hourly liveness check from your App, not from Dane: answer at once with the reply tool, chat_id ${PROBE_CHAT}, text exactly "${PROBE_REPLY}", and nothing else. Nothing to tell him.`;

export type Layer = "plugin" | "tmux" | "gateway" | "input";
export const LAYER_WORDS: Record<Layer, string> = {
  plugin: "the Discord plugin isn't running",
  tmux: "his session isn't there",
  gateway: "the link's Discord connection isn't acknowledged",
  input: "nothing typed has gone into his session since the last check-in",
};

// What his screen shows, read from a capture of his pane (prompt-state.sh for his prompt, and the
// sign-in and API-error screens by their words in the last lines).
export type Screen = "ready" | "working" | "signin" | "api" | "other";
const SIGNIN = /run \/login|token has expired|authentication_error|invalid api key|not logged in|paste.*code|oauth\/authorize/i;
const API = /api error|overloaded_error|internal server error|request timed out|connection error|api_error|rate_limit_error|\b(500|502|503|529)\b.*(error|status)|retrying in \d+/i;
export function screenOf(capture: string, promptState: string): Screen {
  const last = capture.split("\n").filter((l) => l.trim()).slice(-12);
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
export interface Hourly { asked?: number; answered?: number; timedOut?: number }
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
// last). An ask skipped for a turn or the owner is simply asked at the next pass that may.
export function askDue(h: Hourly, now: number, screenFree: boolean, ownerAt: number | null = null): boolean {
  if (!screenFree) return false;
  if (ownerAt !== null && now - ownerAt < OWNER_QUIET_S) return false;
  if (hourlyState(h, now) === "waiting") return false;
  return !h.asked || now - h.asked >= ASK_EVERY_S;
}

// -- one pass ---------------------------------------------------------------------------------------
// status: "ok" passed; "failed" a liveness check failed; "signin" or "api" his screen says why he
// can't answer (alarmed as that, never as a failure); "stopped" the owner's Stop holds (no alarm).
export type Status = "ok" | "failed" | "signin" | "api" | "stopped";
export interface Pass { at: number; ok: boolean; failed: string[]; hourly: HourlyState; status?: Status }
export function pass(f: Facts, h: Hourly, o: { screen?: Screen; stopped?: boolean } = {}): Pass {
  const failed: string[] = layers(f);
  const hourly = hourlyState(h, f.now, o.screen === "working");
  if (hourly === "timeout") failed.push("answer");
  const ok = failed.length === 0;
  let status: Status = ok ? "ok" : "failed";
  if (o.stopped) status = "stopped";
  else if (o.screen === "signin") status = "signin";
  else if (o.screen === "api") status = "api";
  return { at: f.now, ok, failed, hourly, status };
}
// The outside heartbeat hears from the probe only when every check passed, and never while the
// owner's Stop holds: a missed ping is the alarm from outside, so during his Stop the outside check
// goes late (DOCS.md says so).
export function shouldPing(p: Pass): boolean { return p.ok === true && p.failed.length === 0 && p.status !== "stopped"; }
// The alarm the App raises for a pass, or null: two failed passes in a row (or a missed hourly
// answer, at once); a sign-in or API screen as that, at once; never while the owner's Stop holds.
export type AlarmKind = "probe" | "needs-signin" | "api-down";
export function alarmFor(recent: Pass[]): AlarmKind | null {
  const last = recent.at(-1);
  if (!last) return null;
  const st = last.status ?? (last.ok ? "ok" : "failed");
  if (st === "stopped" || st === "ok") return null;
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
//   clean, unknown unasked, later than that, exit 0 or no code kept; and "unknown" too for a run whose
//                  end the run script never saw (s6 restarted it meanwhile) when the next start came
//                  more than SHORT_RUN_S after the run's start;
//   self-<code>    unasked, later than that, a non-zero exit, seen. His own user can end his session
//                  with any code, so these count apart, in their own hour-long window.
export const END_KINDS = /^(boot|asked|clean|unknown|early-(clean|unknown|\d{1,3})|self-\d{1,3})$/;
// ran: seconds from the run's start to when root saw it end. seen false: root never saw it end, and
// ran is then the gap from the run's start to this start, which alone decides.
export function endKind(o: { first: boolean; asked: boolean; code: number | null; ran: number | null; seen?: boolean }): string {
  if (o.first) return "boot";
  if (o.asked) return "asked";
  const code = o.code === null ? null : Math.abs(Math.trunc(o.code)) % 1000;
  const how = code === null ? "unknown" : code === 0 ? "clean" : String(code);
  if (o.ran === null || o.ran < 0) return "unknown";
  const short = o.ran <= SHORT_RUN_S;
  if (o.seen === false) return short ? `early-${how}` : "unknown";
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
export function startsIn(starts: number[], now: number, since = 0, window = STARTS_WINDOW_S): number {
  return starts.filter((t) => t > now - window && t <= now && t >= since).length;
}
export function tooManyStarts(starts: number[], now: number, since = 0): boolean {
  return startsIn(starts, now, since) > STARTS_MAX;
}
export function tooManySelf(self: number[], now: number): boolean { return startsIn(self, now, 0, SELF_WINDOW_S) > SELF_MAX; }
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
// A file kept short: the last day, at most 500 lines.
export function pruneStarts(text: string, now: number): string {
  const keep = text.split("\n").filter((l) => { const n = Number(l.trim().split(/\s+/)[0]); return Number.isSafeInteger(n) && n > now - 86400; });
  return keep.slice(-500).map((l) => `${l}\n`).join("");
}

// -- installs ---------------------------------------------------------------------------------------
export interface Install { id: string; version: string; previous: string | null; at: number }
const VERSION = /^\d+\.\d+\.\d+$/;
// The install record after a start that runs this version. A first record (none before) is no
// install: at 0, so no window opens. A version that can't be read changes nothing.
export function afterStart(prev: Install | null, version: string, now: number): { install: Install | null; fresh: boolean } {
  if (!VERSION.test(version)) return { install: prev, fresh: false };
  if (!prev) return { install: { id: `${version}@0`, version, previous: null, at: 0 }, fresh: false };
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
