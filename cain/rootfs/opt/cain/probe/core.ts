// The probe (Cain 0.14.0): what decides, with no files, clocks or network, so the tests can drive
// every edge. probe/main.ts (root) gathers the facts and acts. This release only alarms.
//
// What the probe measures (DOCS.md, "What 0.14.0 does"):
//   - liveness, every 5 minutes, with no model call: the Discord plugin's process is up, his tmux
//     session is there, the link's Discord gateway connection is up and acknowledged recently, and
//     typed input went into his session since the last check-in over an hour old. These show his
//     parts are running, not that he answers you: they can say alive while messages are lost;
//   - the hourly liveness check of his session: a fixed line handed to his session by root's
//     broker, which he must answer with the fixed reply through the reply tool. It shows his
//     session takes a turn, not that your messages reach him. A real round trip is a later item.
//   - the starts of his session, kept in /data with how the run before each ended, and the boots of
//     the App's container: a crash loop (more than 3 crash starts in 30 minutes) and a boot loop
//     (more than 3 boots in 30 minutes) alarm. A crash start is one whose run ended, unasked, within
//     5 minutes of its start; a later non-zero exit is "self" (his own user can cause one), alarms
//     once a stretch and never counts.
//
// The rollback rule below (decide, the record of restores, installs, backups) ships dormant: only
// rollback/helper.ts uses it, and the run script never starts the helper in this release. It stays
// for the restore release (DOCS.md, "What the restore release needs").

export const PASS_EVERY_S = 300;
export const ASK_EVERY_S = 3600;
export const ANSWER_S = 20 * 60;
export const WORK_MAX_S = 60 * 60;               // a turn at work extends the hourly window this much at most
export const STARTS_WINDOW_S = 30 * 60;
export const STARTS_MAX = 3;                     // more than this many crash starts in the window
export const SHORT_RUN_S = 5 * 60;               // a run that ended unasked within this of its start is a crash
export const BOOTS_MAX = 3;                      // more than this many container boots in the window
export const INSTALL_WINDOW_S = 24 * 3600;
export const GATEWAY_ACK_S = 180;                // Discord acknowledges the link's heartbeat every ~41 s
export const INPUT_GRACE_S = 3600;               // a check-in has its hour to go in (watch.sh)
export const CHECKIN_SLOTS = ["0710", "1230", "1730"];
export const DRILL_S = 45 * 60;                  // a drill holds the rollback back this long
export const REFUSALS_MAX = 3;                   // Supervisor refusals in a row before the alarm
export const BACKUP_BEFORE_S = 6 * 3600;         // the pre-install backup is at most this long before the install

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
// Ask now? Only when his screen is free, never while the last ask waits for its answer, and at most
// hourly (a failed ask too: it's asked again an hour after the last).
export function askDue(h: Hourly, now: number, screenFree: boolean): boolean {
  if (!screenFree) return false;
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
// The outside heartbeat hears from the probe only when every check passed: a missed ping is the
// alarm from outside.
export function shouldPing(p: Pass): boolean { return p.ok === true && p.failed.length === 0; }
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
// Kept for callers that only ask whether one is due.
export function alarmDue(recent: Pass[]): boolean { return alarmFor(recent) !== null; }
export function failedWords(p: Pass): string {
  const w = p.failed.map((l) => l === "answer" ? "he didn't answer the hourly liveness check of his session" : LAYER_WORDS[l as Layer] ?? l);
  return w.join("; ");
}

// -- starts of his session, and boots of the App -----------------------------------------------------
// The starts file: one "<epoch seconds> <how the run before it ended>" line per start of his
// session, root's, in /data, so nothing in his session or its restart can reset it. How the run
// before ended comes from what root alone saw (endKind):
//   boot           the first start in this container (no session ran here before it);
//   asked          the run script recorded its own stop request for that very run before it ended
//                  (a root-owned mark naming the run, never a guess from an exit code or a signal);
//   crash-<how>    unasked, within SHORT_RUN_S of its start: <how> is the exit code kept, "clean"
//                  for 0, or "unknown" when none was kept. Only these count toward a crash loop;
//   clean, unknown unasked, later than that, exit 0 or no code kept;
//   self-<code>    unasked, later than that, a non-zero exit. His own user can end his session with
//                  any code, so these never count toward a loop: they alarm once a stretch.
export const END_KINDS = /^(boot|asked|clean|unknown|crash-(clean|unknown|\d{1,3})|self-\d{1,3})$/;
// ran: seconds from the run's start to when root saw it end (null: not known, counted as short).
export function endKind(o: { first: boolean; asked: boolean; code: number | null; ran: number | null }): string {
  if (o.first) return "boot";
  if (o.asked) return "asked";
  const short = o.ran === null || o.ran <= SHORT_RUN_S;
  const code = o.code === null ? null : Math.abs(Math.trunc(o.code)) % 1000;
  if (short) return `crash-${code === null ? "unknown" : code === 0 ? "clean" : code}`;
  if (code === null) return "unknown";
  if (code === 0) return "clean";
  return `self-${code}`;
}
const startLines = (text: string, kind: RegExp) => text.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => kind.test(p[1] ?? ""))
  .map((p) => Number(p[0])).filter((n) => Number.isSafeInteger(n) && n > 0);
// The crash starts only.
export function parseStarts(text: string): number[] { return startLines(text, /^crash-/); }
// The starts after a run that ended on its own, late, with a non-zero code.
export function parseSelf(text: string): number[] { return startLines(text, /^self-\d+$/); }
export function startsIn(starts: number[], now: number, since = 0, window = STARTS_WINDOW_S): number {
  return starts.filter((t) => t > now - window && t <= now && t >= since).length;
}
export function tooManyStarts(starts: number[], now: number, since = 0): boolean {
  return startsIn(starts, now, since) > STARTS_MAX;
}
// The boots file: one "<epoch seconds>" line per boot of the App's container, in /data.
export function parseBoots(text: string): number[] {
  return text.split("\n").map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => Number.isSafeInteger(n) && n > 0);
}
export function tooManyBoots(boots: number[], now: number): boolean { return startsIn(boots, now) > BOOTS_MAX; }
// A file kept short: the last day, at most 500 lines.
export function pruneStarts(text: string, now: number): string {
  const keep = text.split("\n").filter((l) => { const n = Number(l.trim().split(/\s+/)[0]); return Number.isSafeInteger(n) && n > now - 86400; });
  return keep.slice(-500).map((l) => `${l}\n`).join("");
}

// -- the durable record of restores (/config, outside /data) -------------------------------------
// Written by root's helper before every restore call and after it, read at every start. A restore
// of this App puts /data back as the backup held it, so only a record outside /data can say one
// happened. Excluded from backups (config.yaml backup_exclude), so a restore never brings an older
// copy back.
export interface Restore { bad: string; target: string; slug: string; at: number; job?: string; outcome?: "done" | "failed" | "unknown" | "not run"; why?: string; reported?: boolean; drill?: boolean }
export interface RestoreRecord { format: 1; restores: Restore[] }
export function parseRecord(text: string | null): RestoreRecord | "damaged" {
  if (text === null) return { format: 1, restores: [] };
  try {
    const j = JSON.parse(text);
    if (j?.format !== 1 || !Array.isArray(j.restores)) return "damaged";
    const ok = j.restores.every((r: any) => r && typeof r.bad === "string" && typeof r.target === "string" && typeof r.slug === "string" && Number.isFinite(r.at));
    return ok ? j as RestoreRecord : "damaged";
  } catch { return "damaged"; }
}
// The versions rolled back before: never rolled back again. A drill (the same version restored
// on purpose) marks nothing bad.
export const badVersions = (r: RestoreRecord) => r.restores.filter((x) => !x.drill).map((x) => x.bad);
// The restore still to be settled at a start (the newest, not yet given an outcome).
export function unsettled(r: RestoreRecord): Restore | null {
  const last = r.restores.at(-1);
  return last && !last.outcome ? last : null;
}
// What a start tells of the restore on record: running the target, it happened (its job's final
// state then says how it went); still the bad version, it didn't.
export function settle(r: Restore, running: string, job: "done" | "failed" | "unknown"): Restore["outcome"] {
  if (running === r.target) return job;
  return "not run";
}

// -- installs ---------------------------------------------------------------------------------------
export interface Install { id: string; version: string; previous: string | null; at: number }
const VERSION = /^\d+\.\d+\.\d+$/;
// The install record after a start that runs this version. A first record (none before) is no
// install: at 0, so no window opens. A version that can't be read changes nothing. A start whose
// version is the target of the restore on record is never a new install: it is the rollback.
export function afterStart(prev: Install | null, version: string, now: number, restoredTo: string | null = null): { install: Install | null; fresh: boolean } {
  if (!VERSION.test(version)) return { install: prev, fresh: false };
  if (!prev) return { install: { id: `${version}@0`, version, previous: null, at: 0 }, fresh: false };
  if (prev.version === version) return { install: prev, fresh: false };
  if (restoredTo && version === restoredTo) return { install: { id: `${version}@0`, version, previous: prev.version, at: 0 }, fresh: false };
  return { install: { id: `${version}@${now}`, version, previous: prev.version, at: now }, fresh: true };
}
// Inside the 24 hours after an install: from its start up to, not including, 24 hours on.
export function inWindow(i: Install | null, now: number): boolean {
  return !!i && i.at > 0 && now >= i.at && now - i.at < INSTALL_WINDOW_S;
}

// -- signed Ships ------------------------------------------------------------------------------------
// The versions of Cain a signed Ship installed, from the link's own record of its cards
// (/data/link/state.json): a Ship card whose landing went through and carried the Ship token
// (its line says installing is next; the link signs the token in that same step), whose question
// names "Cain <version>". Read only; the link's signing code is unchanged.
export const SIGNED_LINE = "Installing it is next.";
export function signedFromLink(state: unknown): Record<string, { pr: string; head: string; at: number }> {
  const out: Record<string, { pr: string; head: string; at: number }> = {};
  const msgs = (state as any)?.messages;
  if (!msgs || typeof msgs !== "object") return out;
  for (const m of Object.values(msgs) as any[]) {
    if (m?.kind !== "ship" || m?.shipping?.state !== "landed" || typeof m.shipping.line !== "string" || !m.shipping.line.includes(SIGNED_LINE)) continue;
    const q = /^Ship (.+?)\?/.exec(String(m.shipping.text ?? "").split("\n")[0].trim());
    if (!q) continue;
    for (const part of q[1].split(" and ")) {
      const v = /^Cain (\d+\.\d+\.\d+)$/.exec(part.trim());
      if (v) out[v[1]] = { pr: String(m.ship?.pr ?? ""), head: String(m.ship?.head ?? ""), at: Number(m.shipping.at) || 0 };
    }
  }
  return out;
}

// -- backups ----------------------------------------------------------------------------------------
// Backups are never removed here: no code path calls DELETE on /backups.
export interface Backup { slug: string; date: number; addons: string[]; homeassistant: boolean; folders: string[]; version?: string }
// A backup of this App alone: no Home Assistant, no folders, no other App.
export function appOnly(b: Backup, self: string): boolean {
  return !b.homeassistant && b.folders.length === 0 && b.addons.length === 1 && b.addons[0] === self;
}
// The Supervisor's pre-install backup: of this App alone, holding the version installed before,
// taken within BACKUP_BEFORE_S before the install. The newest such one.
export function preInstall(backups: Backup[], self: string, i: Install | null): Backup | null {
  if (!i || !i.previous || !(i.at > 0)) return null;
  const c = backups.filter((b) => appOnly(b, self) && b.version === i.previous && b.date <= i.at && b.date >= i.at - BACKUP_BEFORE_S);
  return c.sort((a, b) => b.date - a.date)[0] ?? null;
}
// The restore call's body, hard-coded: this App's slug only, no Home Assistant, no folders.
export function restoreBody(self: string): { addons: string[]; background: true } {
  return { addons: [self], background: true };
}

// -- the rollback decision --------------------------------------------------------------------------
export interface Rollback { install: string; at: number; slug: string; restore: string; undo: string; why: string; state: "asking" | "restoring" | "refused" | "disarmed"; tries: number; error?: string }
export interface WatchIn {
  now: number;
  install: Install | null;
  starts: number[];                            // crash starts only (parseStarts)
  signed: Record<string, unknown>;
  backup: Backup | null;                       // the recorded pre-install backup
  rollback: Rollback | null;                   // asked or done for an install
  bad: string[];                               // versions rolled back before (the /config record)
  lastRestore: number | null;                  // when the newest restore on record was asked
  drill: number | null;                        // a drill under way since
}
export type Decision =
  | { do: "none"; why: string }
  | { do: "rollback"; why: string; install: string; slug: string; restore: string; undo: string }
  | { do: "alarm"; code: "again" | "unsigned" | "no-backup"; why: string };

// The one trigger: a crash loop since the install. Nothing else, a failed probe, a missed hourly
// answer or a network loss included, ever arms a rollback.
export function trigger(w: WatchIn): string | null {
  const i = w.install!;
  if (tooManyStarts(w.starts, w.now, i.at)) return `his session crashed and started ${startsIn(w.starts, w.now, i.at)} times in 30 minutes`;
  return null;
}
export function decide(w: WatchIn): Decision {
  if (!inWindow(w.install, w.now)) return { do: "none", why: "no install within 24 hours" };
  if (w.drill && w.now - w.drill < DRILL_S) return { do: "none", why: "a drill is under way" };
  const why = trigger(w);
  if (!why) return { do: "none", why: "no crash loop" };
  const i = w.install!;
  // One rollback per install: under way, done, refused or held back (disarmed), nothing more.
  if (w.rollback && w.rollback.install === i.id) return { do: "none", why: `${why}; the rollback for this install is ${w.rollback.state}` };
  if (w.bad.includes(i.version)) return { do: "alarm", code: "again", why: `${why}, and Cain ${i.version} was rolled back once already` };
  if (w.lastRestore && w.now - w.lastRestore < INSTALL_WINDOW_S) return { do: "alarm", code: "again", why: `${why}, after a rollback within the last day` };
  if (!i.previous || !Object.prototype.hasOwnProperty.call(w.signed, i.previous))
    return { do: "alarm", code: "unsigned", why: `${why}, but ${i.previous ? `Cain ${i.previous}` : "the version before"} wasn't installed from a signed Ship` };
  if (!w.backup || w.backup.version !== i.previous) return { do: "alarm", code: "no-backup", why: `${why}, but there's no backup of Cain ${i.previous} from just before the install` };
  return { do: "rollback", why, install: i.id, slug: w.backup.slug, restore: i.previous, undo: i.version };
}

// The watcher's flag: its request file holds exactly this word and nothing else. The helper takes
// nothing else from it (no slug, no version, no reason): it decides again from its own records.
export const FLAG = "look";
export function isFlag(raw: string | null): boolean { return raw !== null && raw === `${FLAG}\n`; }
