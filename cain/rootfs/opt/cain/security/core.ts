// The security watch (Cain 0.13.0, first stage): what the App can see of the system's health
// with the rights it has, said to Cain in his check-ins under one heading, "Security watch".
// Nothing here acts: every line names what it is and the one step, if any, for the owner.
// Pure, no I/O; main.ts does the reading, the writing and the pings.
//
//   heartbeat  a ping to an outside service (heartbeat_url, Healthchecks.io's shape) every 5
//              minutes, and <url>/fail once when the App stops on an error, so a dead Pi warns
//              him from outside. The URL is a secret: never logged, never shown, never kept.
//   spend      yesterday's spend per review seat and the month so far against each cap, and a
//              flag when a day jumps (over 3 times the trailing 7-day average, or over a fifth
//              of the month's cap in one day): the cheapest sign of a stolen key or a loop.
//   keys       when each key the App holds was first seen (by a hash of its value, never the
//              value), and any expiry set for it: a line within 14 days of an expiry, and for
//              a key with no expiry set that is older than 90 days.
import type { DayLedger, Ledger, RunnerConfig } from "../review/runner.ts";
import { LABEL, SEATS, type SeatName } from "../review/core.ts";

export const HEADING = "Security watch";
export const PING_EVERY_MS = 5 * 60_000;
export const PING_TIMEOUT_MS = 10_000;
export const FAILS_TO_TELL = 3;              // pings failed in a row before a non-morning check-in hears it
export const EXPIRY_WARN_DAYS = 14;
export const OLD_KEY_DAYS = 90;
export const JUMP_TIMES = 3;                 // a day over 3 times the trailing 7-day average
export const JUMP_FLOOR_USD = 0.25;          // ...and at least this much, so a few cents on a quiet week don't count
export const JUMP_FLOOR_RUNS = 5;            // the same for Codex, in runs
export const CAP_SHARE = 1 / 5;              // a day over a fifth of the month's cap

const DAY_MS = 86_400_000;
export const dayOf = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const money = (n: number) => `$${n.toFixed(2)}`;
const clock = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));

// -- heartbeat -----------------------------------------------------------------------------------
// The option's value: unset, set but not usable (never sent anywhere), or a URL to ping.
export type Beat = { kind: "unset" } | { kind: "invalid" } | { kind: "ok"; url: URL };
export function heartbeatUrl(raw: string | undefined | null): Beat {
  const v = String(raw ?? "").trim();
  if (!v || v === "null") return { kind: "unset" };
  let u: URL;
  try { u = new URL(v); } catch { return { kind: "invalid" }; }
  // Only https, to a named host, with nothing before it: the URL is a secret on the wire too.
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname || /^[\d.]+$|^\[/.test(u.hostname)) return { kind: "invalid" };
  return { kind: "ok", url: u };
}
// <url>/fail, Healthchecks.io's way to say the job failed, keeping any query.
export function failUrl(u: URL): URL {
  const f = new URL(u.href);
  f.pathname = `${f.pathname.replace(/\/+$/, "")}/fail`;
  return f;
}
// The one line a ping carries: how long the App has been up, nothing else of his.
export function statusLine(upMs: number, version?: string): string {
  const m = Math.max(0, Math.floor(upMs / 60_000));
  const up = m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return `up ${up}${version && /^\d+\.\d+\.\d+$/.test(version) ? `, Cain ${version}` : ""}`;
}
// What the heartbeat keeps on disk: no URL, no part of it.
export interface BeatState { state: "unset" | "invalid" | "ok"; last_ok?: number; last_try?: number; fails: number; last_error?: string }
export function afterPing(prev: BeatState, ok: boolean, now: number, error?: string): BeatState {
  return ok ? { state: "ok", last_ok: now, last_try: now, fails: 0 }
    : { state: "ok", ...(prev.last_ok ? { last_ok: prev.last_ok } : {}), last_try: now, fails: (prev.state === "ok" ? prev.fails : 0) + 1,
        ...(error ? { last_error: error } : {}) };
}
// Whether a ping failure may be named: only fixed words, never anything that could hold the URL.
export function errorName(e: unknown, status?: number): string {
  if (status) return `HTTP ${status}`;
  const n = (e as { name?: string; code?: string } | null);
  const code = typeof n?.code === "string" && /^[A-Za-z_]{2,40}$/.test(n.code) ? n.code : "";
  if (code) return code;
  return n?.name === "TimeoutError" || n?.name === "AbortError" ? "timed out" : "no answer";
}

export function heartbeatLines(b: BeatState | null, morning: boolean, tz: string): string[] {
  const st = b?.state ?? "unset";
  if (st === "unset")
    return morning ? ["No outside heartbeat yet: if the Pi died, nothing outside the house would notice. His one step, once: make a free Healthchecks.io account (or another service of that kind), make a check with a 5 minute period, and paste its ping URL into heartbeat_url in Cain's App options."] : [];
  if (st === "invalid")
    return morning ? ["The heartbeat_url in Cain's App options isn't an https address to a named site, so no heartbeat is sent. His one step: paste the service's ping URL there again."] : [];
  const fails = b!.fails ?? 0;
  if (fails >= FAILS_TO_TELL)
    return [`The outside heartbeat has failed ${fails} times in a row (last: ${b!.last_error ?? "no answer"})${b!.last_ok ? `, last sent at ${clock(b!.last_ok, tz)}` : ", none sent yet"}: the service will warn him the Pi looks down. Nothing to do if the internet is out; otherwise check the URL in the App's options.`];
  if (!morning) return [];
  return [b!.last_ok ? `Outside heartbeat: working, last sent at ${clock(b!.last_ok, tz)}.` : "Outside heartbeat: set, first ping not sent yet."];
}

// -- spend ------------------------------------------------------------------------------------------
type Caps = RunnerConfig["caps"];
const seatCap = (caps: Caps, s: SeatName) => (s === "openai" ? caps.openaiRuns : caps[s]);
const amount = (s: SeatName, r: { usd: number; runs: number } | undefined) => (s === "openai" ? r?.runs ?? 0 : r?.usd ?? 0);
const say = (s: SeatName, n: number) => (s === "openai" ? `${n} run${n === 1 ? "" : "s"}` : money(n));
const optionOf = (s: SeatName) => (s === "openai" ? "codex_monthly_runs" : s === "claude" ? "anthropic_monthly_usd" : `${s}_monthly_usd`);

// Whether one day's spend on a seat is a jump: over 3 times the 7 days before it (zero days
// counted), with a small floor, or over a fifth of the month's cap on its own.
export function jumpOf(days: DayLedger, day: string, s: SeatName, caps: Caps): string | null {
  const that = amount(s, days[day]?.[s]);
  if (that <= 0) return null;
  let sum = 0;
  for (let i = 1; i <= 7; i++) sum += amount(s, days[addDays(day, -i)]?.[s]);
  const avg = sum / 7;
  const cap = seatCap(caps, s);
  const floor = s === "openai" ? JUMP_FLOOR_RUNS : JUMP_FLOOR_USD;
  if (cap > 0 && that > cap * CAP_SHARE) return `over a fifth of the month's cap (${say(s, cap)}) in one day`;
  if (that >= floor && that > JUMP_TIMES * avg) return avg > 0 ? `over ${JUMP_TIMES} times the 7-day average of ${say(s, Number(avg.toFixed(2)))}` : "with nothing spent the 7 days before";
  return null;
}
const JUMP_STEP = "A jump is the cheapest sign of a stolen key or a review stuck in a loop: check review.sh status for reviews he didn't start; if none explains it, his one step is a new key for that seat in the App's options.";

// Morning: yesterday and the month so far for every seat that has a cap or any spend, then a
// flagged line for each jump, and a line for each cap reached. Other check-ins: only today's
// jumps so far.
export function spendLines(o: { ledger: Ledger; days: DayLedger; caps: Caps; today: string; morning: boolean }): string[] {
  const { ledger, days, caps, today, morning } = o;
  const out: string[] = [];
  const month = today.slice(0, 7);
  if (morning) {
    const y = addDays(today, -1);
    const parts: string[] = [];
    for (const s of SEATS) {
      const cap = seatCap(caps, s);
      const spent = amount(s, ledger[month]?.[s]);
      const yday = amount(s, days[y]?.[s]);
      if (cap <= 0 && spent <= 0 && yday <= 0) continue;
      parts.push(`${LABEL[s]} ${say(s, yday)} yesterday, ${say(s, Number(spent.toFixed(2)))} of ${say(s, cap)} this month`);
    }
    if (parts.length) out.push(`Review spend: ${parts.join("; ")}.`);
    for (const s of SEATS) {
      const j = jumpOf(days, y, s, caps);
      if (j) out.push(`FLAGGED: ${LABEL[s]} spent ${say(s, amount(s, days[y]?.[s]))} yesterday, ${j}. ${JUMP_STEP}`);
    }
    for (const s of SEATS) {
      const cap = seatCap(caps, s);
      if (cap > 0 && amount(s, ledger[month]?.[s]) >= cap)
        out.push(`${LABEL[s]} has reached this month's cap of ${say(s, cap)}: reviews on it are refused until the month turns. Nothing to do unless he wants more; then raise ${optionOf(s)} in Cain's App options.`);
    }
  } else {
    for (const s of SEATS) {
      const j = jumpOf(days, today, s, caps);
      if (j) out.push(`FLAGGED: ${LABEL[s]} has spent ${say(s, amount(s, days[today]?.[s]))} so far today, ${j}. ${JUMP_STEP}`);
    }
  }
  return out;
}

// -- keys -------------------------------------------------------------------------------------------
// Every key or token the App holds, by the name keeper.sh key-expiry takes, and what it is.
export const KEYS: Record<string, string> = {
  github_token: "the record keeper's GitHub token",
  pc_jobs_token: "the PC job queue's GitHub token",
  discord_bot_token: "the Discord bot token",
  gemini_api_key: "the Gemini API key",
  perplexity_api_key: "the Perplexity API key",
  anthropic_api_key: "the Anthropic API key",
  deploy_key: "the link's deploy key (it lands Ship taps in main)",
  ship_key: "the link's Ship key (it signs Ship tokens)",
};
export interface KeyRec { hash: string; first_seen: string; expires?: string; present: boolean }
export interface KeyFile { version: 1; keys: Record<string, KeyRec> }
export const emptyKeys = (): KeyFile => ({ version: 1, keys: {} });
export function parseKeys(raw: string | null): KeyFile {
  try {
    const j = JSON.parse(raw ?? "");
    if (j && j.version === 1 && j.keys && typeof j.keys === "object") return { version: 1, keys: j.keys };
  } catch { /* none yet, or unreadable: start again */ }
  return emptyKeys();
}
// Each key's hash as seen now (null: not there). A new or changed hash is first seen today and
// loses any expiry set for the value before it. Returns what changed, for the log (names only).
export function observeKeys(f: KeyFile, seen: Record<string, string | null>, today: string): { file: KeyFile; changed: string[] } {
  const keys: Record<string, KeyRec> = { ...f.keys };
  const changed: string[] = [];
  for (const name of Object.keys(KEYS)) {
    if (!(name in seen)) continue;                       // not looked at this round: kept as it was
    const h = seen[name];
    const was = keys[name];
    if (!h) { if (was?.present) { keys[name] = { ...was, present: false }; changed.push(`${name} gone`); } continue; }
    if (!was || was.hash !== h) { keys[name] = { hash: h, first_seen: today, present: true }; changed.push(`${name} ${was ? "changed" : "new"} (${h.slice(0, 8)})`); }
    else if (!was.present) { keys[name] = { ...was, present: true }; changed.push(`${name} back`); }
  }
  return { file: { version: 1, keys }, changed };
}
export function validDay(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
// keeper.sh key-expiry <name> <YYYY-MM-DD|none>
export function setExpiry(f: KeyFile, name: string, day: string): { file?: KeyFile; said: string } {
  if (!(name in KEYS)) return { said: `No key called "${name.slice(0, 40)}". Names: ${Object.keys(KEYS).join(", ")}.` };
  const rec = f.keys[name];
  if (!rec) return { said: `${KEYS[name]} hasn't been seen yet, so there's nothing to set an expiry on.` };
  if (day === "none") {
    const { expires: _, ...rest } = rec;
    return { file: { version: 1, keys: { ...f.keys, [name]: rest } }, said: `No expiry set for ${KEYS[name]} now.` };
  }
  if (!validDay(day)) return { said: "The expiry must be a date as YYYY-MM-DD, or none." };
  return { file: { version: 1, keys: { ...f.keys, [name]: { ...rec, expires: day } } }, said: `Expiry for ${KEYS[name]} set to ${shortDate(day)}.` };
}
export function keyLines(f: KeyFile, today: string): string[] {
  const out: string[] = [];
  for (const name of Object.keys(KEYS)) {
    const r = f.keys[name];
    if (!r?.present) continue;
    if (r.expires) {
      const left = daysBetween(today, r.expires);
      if (left < 0) out.push(`${cap(KEYS[name])} expired on ${shortDate(r.expires)}: what uses it has stopped working or soon will. His one step: make a new one and put it where it lives (${where(name)}).`);
      else if (left <= EXPIRY_WARN_DAYS) out.push(`${cap(KEYS[name])} expires ${left === 0 ? "today" : `on ${shortDate(r.expires)}, in ${left} day${left === 1 ? "" : "s"}`}. His one step: make a new one and put it where it lives (${where(name)}).`);
    } else {
      const age = daysBetween(r.first_seen, today);
      if (age > OLD_KEY_DAYS) out.push(`${cap(KEYS[name])} has been the same for ${age} days (first seen ${shortDate(r.first_seen)}) and has no expiry noted. Nothing urgent: replacing it now and then limits what a leak can do. If it has an expiry, note it with keeper.sh key-expiry ${name} YYYY-MM-DD.`);
    }
  }
  return out;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function where(name: string): string {
  if (name === "discord_bot_token") return "Discord's developer page, then the Cain page's Discord setup";
  if (name === "deploy_key" || name === "ship_key") return "the link makes a new one itself when the old one is removed; RELEASING.md says how";
  return `${name} in Cain's App options`;
}

// -- the check-in's section ---------------------------------------------------------------------
// One line for the check-in prompt, or "" when there's nothing to say.
export function section(lines: string[]): string {
  if (!lines.length) return "";
  return `${HEADING} (nothing here acts; bring him at most one step, in plain words): ${lines.join(" ")}`;
}
