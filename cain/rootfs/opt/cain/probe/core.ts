// The probe and the rollback rule (Cain 0.14.0): what decides, with no files, clocks or network,
// so the tests can drive every edge. probe/main.ts (root) gathers the facts and acts; rollback/
// watcher.ts (the watch user) reads what the probe kept and decides on a rollback; rollback/
// helper.ts (root) does only the one restore the watcher asks for, after checking it again.
//
// The rule, in plain words (DOCS.md, "Is Cain really answering"):
//   - every 5 minutes, with no model call: the Discord plugin's process is up, his tmux session is
//     there, the link's Discord gateway connection is up and Discord acknowledged it recently, and
//     his session took typed input since the last check-in that is over an hour old;
//   - once an hour, when his screen is free: a fixed probe line reaches his session on his Discord
//     channel, and he must answer it with the fixed reply through the reply tool within 20 minutes;
//   - every start of his session is kept in /data; more than 3 in 30 minutes is an alarm;
//   - within 24 hours of an install, two failed 5-minute probes in a row, an hourly answer that
//     didn't come, or more than 3 starts in 30 minutes restores the backup taken just before the
//     install, once, and only when the version it holds was installed from a signed Ship.

export const PASS_EVERY_S = 300;
export const ASK_EVERY_S = 3600;
export const ANSWER_S = 20 * 60;
export const STARTS_WINDOW_S = 30 * 60;
export const STARTS_MAX = 3;                     // more than this many starts in the window alarms
export const INSTALL_WINDOW_S = 24 * 3600;
export const GATEWAY_ACK_S = 180;                // Discord acknowledges the link's heartbeat every ~41 s
export const INPUT_GRACE_S = 3600;               // a check-in has its hour to go in (watch.sh)
export const CHECKIN_SLOTS = ["0710", "1230", "1730"];
export const DRILL_S = 45 * 60;                  // a drill holds the rollback back this long
export const REFUSALS_MAX = 3;                   // Supervisor refusals in a row before the alarm
export const BACKUP_BEFORE_S = 6 * 3600;         // the pre-install backup is at most this long before the install

// The hourly answer. The chat id is no Discord chat (no real id starts with zeros): the broker
// answers a reply to it itself and never sends it on, to Discord or to the gate. Its words are
// fixed and neutral.
export const PROBE_CHAT = "000000000000000000";
export const PROBE_REPLY = "probe answered";
export const PROBE_LINE = `Hourly check from your App, not from Dane: answer at once with the reply tool, chat_id ${PROBE_CHAT}, text exactly "${PROBE_REPLY}", and nothing else. Nothing to tell him.`;

export type Layer = "plugin" | "tmux" | "gateway" | "input";
export const LAYER_WORDS: Record<Layer, string> = {
  plugin: "the Discord plugin isn't running",
  tmux: "his session isn't there",
  gateway: "the link's Discord connection isn't acknowledged",
  input: "nothing typed has gone into his session since the last check-in",
};

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

// -- the hourly answer -----------------------------------------------------------------------------
export interface Hourly { asked?: number; answered?: number; timedOut?: number }
export type HourlyState = "none" | "waiting" | "answered" | "timeout";
export function hourlyState(h: Hourly, now: number): HourlyState {
  if (!h.asked) return "none";
  if (h.answered && h.answered >= h.asked) return "answered";
  return now - h.asked < ANSWER_S ? "waiting" : "timeout";
}
// Ask now? Only when his screen is free, never while the last ask waits for its answer, and at most
// hourly (a failed ask too: it's asked again an hour after the last).
export function askDue(h: Hourly, now: number, screenFree: boolean): boolean {
  if (!screenFree) return false;
  if (hourlyState(h, now) === "waiting") return false;
  return !h.asked || now - h.asked >= ASK_EVERY_S;
}

// -- one pass ---------------------------------------------------------------------------------------
export interface Pass { at: number; ok: boolean; failed: string[]; hourly: HourlyState }
export function pass(f: Facts, h: Hourly): Pass {
  const failed: string[] = layers(f);
  const hourly = hourlyState(h, f.now);
  if (hourly === "timeout") failed.push("answer");
  return { at: f.now, ok: failed.length === 0, failed, hourly };
}
// The outside heartbeat hears from the probe only when the probe passed: a missed ping is the alarm.
export function shouldPing(p: Pass): boolean { return p.ok === true && p.failed.length === 0; }
// The alarm through notice.sh: two failed passes in a row, or an hourly answer that didn't come.
// Comes down once a pass goes through.
export function alarmDue(recent: Pass[]): boolean {
  const last = recent.at(-1);
  if (!last || last.ok) return false;
  if (last.failed.includes("answer")) return true;
  const before = recent.at(-2);
  return !!before && !before.ok;
}
export function failedWords(p: Pass): string {
  const w = p.failed.map((l) => l === "answer" ? "he didn't answer the hourly check within 20 minutes" : LAYER_WORDS[l as Layer] ?? l);
  return w.join("; ");
}

// -- starts of his session --------------------------------------------------------------------------
// The starts file: one "<epoch seconds> <why>" line per start of his session, root's, in /data, so
// nothing in his session or its restart can reset it.
export function parseStarts(text: string): number[] {
  return text.split("\n").map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => Number.isSafeInteger(n) && n > 0);
}
export function startsIn(starts: number[], now: number, since = 0, window = STARTS_WINDOW_S): number {
  return starts.filter((t) => t > now - window && t <= now && t >= since).length;
}
export function tooManyStarts(starts: number[], now: number, since = 0): boolean {
  return startsIn(starts, now, since) > STARTS_MAX;
}
// The file kept short: the last day, at most 500 lines.
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
export interface Backup { slug: string; date: number; addons: string[]; homeassistant: boolean; folders: string[]; version?: string }
// A backup of this App alone: no Home Assistant, no folders, no other App.
export function appOnly(b: Backup, self: string): boolean {
  return !b.homeassistant && b.folders.length === 0 && b.addons.length === 1 && b.addons[0] === self;
}
// The pre-install backup: of this App alone, holding the version installed before, taken within
// BACKUP_BEFORE_S before the install. The newest such one.
export function preInstall(backups: Backup[], self: string, i: Install | null): Backup | null {
  if (!i || !i.previous || !(i.at > 0)) return null;
  const c = backups.filter((b) => appOnly(b, self) && b.version === i.previous && b.date <= i.at && b.date >= i.at - BACKUP_BEFORE_S);
  return c.sort((a, b) => b.date - a.date)[0] ?? null;
}
// One per App: every other backup of this App alone that is older than the one kept goes.
export function olderToRemove(backups: Backup[], self: string, keep: Backup): string[] {
  return backups.filter((b) => b.slug !== keep.slug && appOnly(b, self) && b.date < keep.date).map((b) => b.slug);
}

// -- after a restore --------------------------------------------------------------------------------
// A restore of this App puts /data back as the backup held it, so nothing the App kept says a
// rollback happened. It shows this way instead: the version running is the newest backup of this
// App's, and the probe's last sign of life in /data is from within minutes of that backup, which
// is a while ago. Only a restore leaves /data like that (after a plain restart the sign is
// recent; after an update the version is newer than the backup's).
export function restoredFrom(o: { now: number; version: string; alive: number | null; install: Install | null; newest: Backup | null }):
  boolean {
  const b = o.newest;
  if (!b || !o.alive || b.version !== o.version) return false;
  if (o.install && o.install.version !== o.version) return false;
  return Math.abs(o.alive - b.date) <= 15 * 60 && o.now - b.date >= 10 * 60;
}

// -- the rollback decision --------------------------------------------------------------------------
export interface Rollback { install: string; at: number; slug: string; restore: string; undo: string; why: string; state: "asking" | "restoring" | "refused"; tries: number; error?: string }
export interface WatchIn {
  now: number;
  install: Install | null;
  passes: Pass[];                              // oldest first
  starts: number[];
  signed: Record<string, unknown>;
  backup: Backup | null;                       // the recorded pre-install backup
  rollback: Rollback | null;                   // asked or done for an install
  rolledBack: number | null;                   // when a restore was last seen (restoredFrom)
  drill: number | null;                        // a drill under way since
}
export type Decision =
  | { do: "none"; why: string }
  | { do: "rollback"; why: string; install: string; slug: string; restore: string; undo: string }
  | { do: "alarm"; code: "again" | "unsigned" | "no-backup"; why: string };

export function trigger(w: WatchIn): string | null {
  const i = w.install!;
  const since = w.passes.filter((p) => p.at >= i.at);
  const last = since.at(-1), before = since.at(-2);
  if (last && !last.ok && last.failed.includes("answer")) return "he didn't answer the hourly check";
  if (last && before && !last.ok && !before.ok) return "two probes in a row failed";
  if (tooManyStarts(w.starts, w.now, i.at)) return `his session started ${startsIn(w.starts, w.now, i.at)} times in 30 minutes`;
  return null;
}
export function decide(w: WatchIn): Decision {
  if (!inWindow(w.install, w.now)) return { do: "none", why: "no install within 24 hours" };
  if (w.drill && w.now - w.drill < DRILL_S) return { do: "none", why: "a drill is under way" };
  const why = trigger(w);
  if (!why) return { do: "none", why: "the probe holds" };
  const i = w.install!;
  // One rollback per install: under way, done, or refused (the helper alarmed then), nothing more.
  if (w.rollback && w.rollback.install === i.id) return { do: "none", why: `${why}; the rollback for this install is ${w.rollback.state}` };
  if (w.rolledBack && w.now - w.rolledBack < INSTALL_WINDOW_S) return { do: "alarm", code: "again", why: `${why}, after a rollback within the last day` };
  if (!i.previous || !Object.prototype.hasOwnProperty.call(w.signed, i.previous))
    return { do: "alarm", code: "unsigned", why: `${why}, but ${i.previous ? `Cain ${i.previous}` : "the version before"} wasn't installed from a signed Ship` };
  if (!w.backup || w.backup.version !== i.previous) return { do: "alarm", code: "no-backup", why: `${why}, but there's no backup of Cain ${i.previous} from just before the install` };
  return { do: "rollback", why, install: i.id, slug: w.backup.slug, restore: i.previous, undo: i.version };
}

// The helper's own check of a request (it trusts nothing the watcher says): the request names
// this install, its recorded backup and the version before it, that version was signed, the
// window is open, and no rollback was asked for this install yet.
export interface Request { install: string; slug: string; restore: string; undo: string; why: string }
export function checkRequest(r: unknown, s: { now: number; install: Install | null; backup: Backup | null; signed: Record<string, unknown>; rollback: Rollback | null; rolledBack: number | null }): Request | string {
  const q = r as Request;
  if (!q || typeof q !== "object" || Object.keys(q).sort().join(",") !== "install,restore,slug,undo,why") return "not a rollback request";
  for (const k of ["install", "slug", "restore", "undo", "why"] as const) if (typeof q[k] !== "string" || q[k].length > 200) return `its ${k} isn't text`;
  if (!/^[0-9a-f]{8}$/.test(q.slug)) return "its backup isn't a backup's id";
  const i = s.install;
  if (!i || q.install !== i.id) return "it isn't for the install on record";
  if (!inWindow(i, s.now)) return "the install is over 24 hours old";
  if (s.rollback && s.rollback.install === i.id) return "a rollback was already asked for this install";
  if (s.rolledBack && s.now - s.rolledBack < INSTALL_WINDOW_S) return "a rollback was seen within the last day";
  if (!i.previous || q.restore !== i.previous || q.undo !== i.version) return "its versions aren't the install's";
  if (!Object.prototype.hasOwnProperty.call(s.signed, q.restore)) return `Cain ${q.restore} wasn't installed from a signed Ship`;
  if (!s.backup || q.slug !== s.backup.slug || s.backup.version !== q.restore) return "its backup isn't the recorded pre-install backup";
  return { install: q.install, slug: q.slug, restore: q.restore, undo: q.undo, why: q.why.replace(/[^\w ,.'()-]/g, " ").slice(0, 160) };
}
