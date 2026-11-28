// The usage guard (Cain 0.16.0): one subscription and four paid review seats serve Cain's own work,
// the builds, the reviews and the owner's life projects. The guard keeps "other" work from spending
// what the owner's commitments need. The review runner (review/runner.ts, for every brief) and the
// Build hook (hooks/remote-trigger.ts, for every Build run) both call it.
//
// Every brief and every Build or Ship run carries one label: core (Cain answering, the calendar,
// reminders, the morning message), commitment (the owner's course first), necessary-fix (something
// broken now) or other. A missing label is "other". The first three pass. "other" is refused while
// either reading is below the reserve floor (the App's option `usage_reserve_percent`, default 25):
//   - the plan: the week's allowance left (plan-usage.ts). Unknown, or read more than a day ago,
//     counts as below the floor (it fails closed);
//   - each review seat: its month-to-date spend against its monthly cap (the runner's caps, from
//     /data/review-settings.json; Codex in runs). Caps or spend that can't be read count as below.
// No tap or flag of Cain's turns it off (what it can and can't be trusted for is below). Every refusal is one line appended to
// /data/review-guard.log (time, label, what was refused, which floor), which Cain reads to list holds;
// the guard never posts a card. The log is root:cain 0640 (round 2): root writes it, Cain only reads.
// The runner (root) appends itself; the Build hook and review.sh, which run as Cain, send the hold to
// the link (POST /guard-hold), which decides again from its own readings and appends only a refusal.
//
// The silent gap (round 3): the Build hook used to decide a Build run alone and ask the link only when
// its own reading refused, which was safe only while the plan reader could never return a real fraction.
// Cain 0.17.0: the plan reader divides by the week's allowance (plan-usage.ts), so it can, and the link
// now decides every "other" Build run first (hooks/remote-trigger.ts decideWithGuard asks it every time:
// a run passes only when the hook's reading and the link's both let it, and the link answered).
// LINK_DECIDES_BUILDS says so; cap.test.ts checks the hook keeps asking.
//
// What it can be trusted for (0.17.0, round 2 of the review fixes). The settings file and the plan
// reader's cache are root's (root:cain 0640): Cain's user reads them and can't change them. The plan's
// raw count is read from Cain's own transcripts, which Cain's user owns and could delete, truncate or
// re-time: the count relies on them not being altered. The reader's high-water mark (plan-usage.ts) holds
// a count that goes down within a week and raises an alarm naming what shrank; a count kept low from the
// start of a week isn't caught. And the allowance is this device's share of the plan, worked out by hand
// from the usage page (its date and derivation are in the settings, and review.sh guard prints them), not
// the plan's own limit. So the guard is a safeguard against Cain overspending by accident, not a wall
// against a session that set out to get around it.
import { appendFileSync, readFileSync } from "node:fs";
import { NOT_READY, readPlanUsage, type PlanReading } from "./plan-usage.ts";
import { capPaths, clearAlarm, raiseAlarm } from "./capfiles.ts";

// The week's allowance by default (0.17.0): the App's option plan_weekly_allowance_tokens, set by hand
// (DOCS.md, "Usage guard"). The runner writes the value it uses into the settings file.
export const DEFAULT_WEEKLY_ALLOWANCE = 4_200_000_000;
// When it was set and how (round 2): the App's options plan_allowance_set_on and plan_allowance_derivation,
// written by the runner into the settings file beside the allowance, and printed by review.sh guard.
export const DEFAULT_ALLOWANCE_SET_ON = "2026-11-21";
export const DEFAULT_ALLOWANCE_DERIVATION = "35 percent of the week used on the usage page against about 1.47 billion tokens since Sunday on this device";

export const LINK_DECIDES_BUILDS = true;
export const LABELS = ["core", "commitment", "necessary-fix", "other"] as const;
export type Label = typeof LABELS[number];
export const DEFAULT_RESERVE_PERCENT = 25;
export const STALE_MS = 24 * 3_600_000;
export const SETTINGS_FORMAT = 1;
export const SEAT_NAMES = ["openai", "gemini", "perplexity", "claude"] as const;
type Seat = typeof SEAT_NAMES[number];
const SEAT_LABEL: Record<Seat, string> = { openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude" };

// Constants (capfiles.ts); an environment override only in test mode.
export const paths = (env: Record<string, string | undefined> = process.env) => {
  const p = capPaths(env);
  return { settings: p.settings, spend: p.spend, log: p.guardLog, cache: p.planCache, tz: env.CHECKIN_TZ ?? "America/New_York" };
};

// What the runner writes at its start (review/runner.ts writeSettings): the caps and the cap it really
// uses, so review.sh and the Build hook, run as Cain, read the runner's numbers and not their own.
export type Settings = {
  format: number; written_at: string; round_cap: number; reserve_percent: number;
  caps: { gemini: number; perplexity: number; claude: number; openaiRuns: number }; review_limit: number;
  weekly_allowance_tokens?: number;                 // 0.17.0: the week's allowance; missing or 0: not set (unknown)
  allowance_set_on?: string;                        // round 2: the date the allowance was set (YYYY-MM-DD)
  allowance_derivation?: string;                    // round 2: how it was worked out, in the owner's words
};
export function readSettings(path: string): Settings | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j?.format !== SETTINGS_FORMAT || !j.caps || !Number.isFinite(j.round_cap) || !Number.isFinite(j.reserve_percent)) return null;
    return j as Settings;
  } catch { return null; }
}

export function labelOf(v: unknown): Label | null {
  if (v === undefined || v === null || v === "") return "other";
  return LABELS.includes(v as Label) ? (v as Label) : null;
}

export type SeatLeft = { seat: string; left: number | null; why?: string };
export type Readings = { plan: PlanReading; seats: SeatLeft[] | null; seatsWhy?: string; floor: number;
  allowance?: { set_on: string | null; derivation: string | null } };      // round 2: when and how the allowance was set
// logged (round 2): whether a refusal reached the guard's log; false when it couldn't be logged.
// linkPasses (round 3): the link's own reading let it pass where the hook's refused (the hook names the difference).
// notReady (0.17.0, round 2): the plan's reading wasn't ready in time (a cold cache, or out of time); the
// Build hook names it and has the link write the hold line.
export type Verdict = { ok: true } | { ok: false; floor: string; why: string; logged?: boolean; linkPasses?: boolean; notReady?: string };

// Each seat's share of its monthly cap left, from the spend file and the runner's caps. A seat whose
// cap is 0 is off and spends nothing, so it isn't counted.
export function seatsLeft(ledger: any, settings: Settings | null, month: string): { seats: SeatLeft[] | null; why?: string } {
  if (!settings) return { seats: null, why: "the review runner's caps can't be read (/data/review-settings.json)" };
  if (ledger === null) return { seats: null, why: "the review spend file can't be read" };
  const out: SeatLeft[] = [];
  for (const s of SEAT_NAMES) {
    const cap = s === "openai" ? settings.caps.openaiRuns : settings.caps[s];
    if (!(cap > 0)) continue;
    const row = ledger?.[month]?.[s] ?? {};
    const used = s === "openai" ? Number(row.runs ?? 0) : Number(row.usd ?? 0);
    out.push({ seat: s, left: Math.max(0, 1 - used / cap) });
  }
  return { seats: out };
}

// The rule itself, with no I/O.
export function decide(label: Label, r: Readings, now: Date): Verdict {
  if (label !== "other") return { ok: true };
  const floor = r.floor / 100;
  const p = r.plan;
  const age = now.getTime() - Date.parse(p.at);
  if (p.not_ready) return { ok: false, floor: "plan", notReady: p.not_ready, why: `${p.reason.startsWith(NOT_READY) ? p.reason : `${NOT_READY}: ${p.not_ready}`}, which counts as below the ${r.floor}% reserve floor` };
  if (p.fraction === null) return { ok: false, floor: "plan", why: `the plan's usage is unknown (${p.reason}), which counts as below the ${r.floor}% reserve floor` };
  if (!Number.isFinite(age) || age > STALE_MS) return { ok: false, floor: "plan", why: `the plan's usage reading is more than a day old, which counts as below the ${r.floor}% reserve floor` };
  if (p.complete === false) return { ok: false, floor: "plan", why: `the plan's usage reading is incomplete (${p.skipped ?? "some"} transcript files not counted), which counts as below the ${r.floor}% reserve floor` };
  if (1 - p.fraction < floor) return { ok: false, floor: "plan", why: `the plan has ${Math.round(Math.max(0, 1 - p.fraction) * 100)}% of the week's allowance left, below the ${r.floor}% reserve floor` };
  if (!r.seats) return { ok: false, floor: "seats", why: `${r.seatsWhy ?? "the review seats' spend can't be read"}, which counts as below the ${r.floor}% reserve floor` };
  const low = r.seats.filter((s) => s.left === null || s.left < floor);
  if (low.length) return { ok: false, floor: `seat ${low.map((s) => s.seat).join(", ")}`,
    why: `${low.map((s) => `${SEAT_LABEL[s.seat as Seat] ?? s.seat} has ${s.left === null ? "an unknown share" : `${Math.round(s.left * 100)}%`} of its monthly cap left`).join("; ")}, below the ${r.floor}% reserve floor` };
  return { ok: true };
}

export function monthOf(now: Date, tz: string): string { return now.toLocaleDateString("en-CA", { timeZone: tz }).slice(0, 7); }

// Everything read now: the runner's settings, the spend file, the plan.
// deadline and coldOk (round 2): the Build hook's budget, and its rule that it never scans a cold week itself.
export function readings(o: { settingsFile: string; spendFile: string; tz: string; now: Date; plan?: () => PlanReading; cacheFile?: string | null;
    deadline?: number; coldOk?: boolean }): Readings {
  const settings = readSettings(o.settingsFile);
  let ledger: any = null;
  try { ledger = JSON.parse(readFileSync(o.spendFile, "utf8")); }
  catch (e: any) { ledger = e?.code === "ENOENT" ? {} : null; }
  const s = seatsLeft(ledger, settings, monthOf(o.now, o.tz));
  let plan: PlanReading;
  const allowance = Number(settings?.weekly_allowance_tokens ?? 0);
  // Root's parts (the runner, the link) keep the reader's cache; Cain's parts only read it.
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const cacheFile = o.cacheFile === undefined ? capPaths().planCache : o.cacheFile;
  try { plan = (o.plan ?? (() => readPlanUsage({ now: o.now, tz: o.tz, allowance, cacheFile, saveCache: root,
    ...(o.deadline !== undefined ? { deadline: o.deadline } : {}), ...(o.coldOk !== undefined ? { coldOk: o.coldOk } : {}) })))(); }
  catch (e) { plan = { fraction: null, at: o.now.toISOString(), reason: `the reader failed: ${String(e).slice(0, 80)}`, tokens_week: null, files: 0 }; }
  return { plan, seats: s.seats, ...(s.why ? { seatsWhy: s.why } : {}), floor: settings?.reserve_percent ?? DEFAULT_RESERVE_PERCENT,
    ...(settings ? { allowance: { set_on: settings.allowance_set_on ?? null, derivation: settings.allowance_derivation ?? null } } : {}) };
}

// The plan reader's alarms, for root's parts (round 2): "review-plancache" when the cache can't be written
// or the trust check refuses it (owner, group or mode), raised at most once an hour unless its cause
// changes, and cleared after a good write; "review-planshrink" when a reading fell below this week's
// high-water mark, naming what shrank, cleared by the next reading that doesn't.
// Round 3: "review-planread" when the reader keeps failing (a child that exits with an error or is killed,
// a reading out of time, an incomplete one): after READ_FAILS_ALARM in a row, or READ_STUCK_MS with
// readings asked and none complete, raised at most once an hour unless its kind of failure changes, naming
// the cause, and cleared by the next complete reading. The runner's warm and the link's refresher both
// feed it (saw for each finished reading, asked for each reading asked, failed for one that threw).
export const READ_FAILS_ALARM = 2;
export const READ_STUCK_MS = 30 * 60_000;
// Why a finished reading counts as a failure of the reader, or null for a complete one.
export function readFailure(p: Partial<PlanReading>): { kind: string; cause: string } | null {
  if (p.failed) return { kind: "crash", cause: p.failed };
  if (p.not_ready) return { kind: "time", cause: `the reading ran out of time (${p.reason ?? p.not_ready})` };
  if (p.complete !== true) return { kind: "incomplete", cause: `the reading was incomplete (${p.reason ?? "some transcript files weren't counted"})` };
  return null;
}
export class PlanCacheAlarm {
  private up: string | null = null;
  private at = 0;
  private shrinkUp: string | null = null;
  private fails = 0;
  private askedSince: number | null = null;
  private readUp: string | null = null;                // the kind of failure raised; "" once cleared
  private readAt = 0;
  constructor(private o: { raise?: (kind: string, cause: string) => void; clear?: (group: string) => void; log?: (m: string) => void; now?: () => number; quietMs?: number } = {}) {}
  private raise(kind: string, cause: string) { (this.o.raise ?? ((k, c) => raiseAlarm(c, this.o.log, k)))(kind, cause); }
  private clear(group: string) { (this.o.clear ?? ((g) => clearAlarm(this.o.log, g)))(group); }
  private readTrouble(kind: string, cause: string): void {
    const now = (this.o.now ?? Date.now)();
    if (kind === this.readUp && now - this.readAt < (this.o.quietMs ?? 3_600_000)) return;
    (this.o.log ?? console.log)(`the plan reader keeps failing: ${cause}`);
    this.raise("review-planread", cause.slice(0, 200)); this.readUp = kind; this.readAt = now;
  }
  // A reading was asked for (round 3): READ_STUCK_MS of asking with no complete reading raises the alarm.
  asked(): void {
    const now = (this.o.now ?? Date.now)();
    if (this.askedSince === null) { this.askedSince = now; return; }
    if (now - this.askedSince >= READ_STUCK_MS)
      this.readTrouble("stuck", `no complete plan reading in the ${Math.round((now - this.askedSince) / 60_000)} minutes readings were asked for`);
  }
  // A reading that threw before it finished (the runner's warm, in its own process).
  failed(cause: string): void { this.saw({ failed: cause }); }
  // One reading's outcome (a PlanReading from a part that writes the cache).
  saw(p: Partial<PlanReading>): void {
    const now = (this.o.now ?? Date.now)();
    const f = readFailure(p);
    if (f) {
      this.fails++;
      if (this.askedSince === null) this.askedSince = now;
      if (this.fails >= READ_FAILS_ALARM) this.readTrouble(f.kind, `${this.fails} plan readings in a row failed, the last: ${f.cause}`);
      else if (now - this.askedSince >= READ_STUCK_MS) this.readTrouble("stuck", `no complete plan reading in ${Math.round((now - this.askedSince) / 60_000)} minutes, the last: ${f.cause}`);
    } else {
      this.fails = 0; this.askedSince = null;
      if (this.readUp !== "") { if (this.readUp) (this.o.log ?? console.log)("the plan reader gave a complete reading again"); this.clear("planread"); this.readUp = ""; }
    }
    if (p.failed) return;
    const trouble = p.cache_write && p.cache_write !== "ok" ? p.cache_write : p.cache_untrusted ? `the plan reader's cache was refused by the trust check: ${p.cache_untrusted}` : null;
    if (trouble) {
      if (trouble !== this.up || now - this.at >= (this.o.quietMs ?? 3_600_000)) {
        (this.o.log ?? console.log)(`the plan reader's cache: ${trouble}`);
        this.raise("review-plancache", trouble.slice(0, 200)); this.up = trouble; this.at = now;
      }
    } else if (p.cache_write === "ok" && this.up !== "") {
      if (this.up) (this.o.log ?? console.log)("the plan reader's cache was written again");
      this.clear("plancache"); this.up = "";
    }
    if (p.shrank) {
      if (p.shrank !== this.shrinkUp) { (this.o.log ?? console.log)(`the plan's count shrank: ${p.shrank}`); this.raise("review-planshrink", p.shrank.slice(0, 200)); this.shrinkUp = p.shrank; }
    } else if (p.complete && this.shrinkUp !== "") { this.clear("planshrink"); this.shrinkUp = ""; }
  }
}

// One line of the guard's log, for each refusal: time, label, what was refused, which floor.
const cleanCell = (s: string) => String(s ?? "").replace(/[\t\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 160);
export function holdLine(now: Date, tag: string, what: string, why: string): string {
  return `${now.toISOString()}\t${cleanCell(tag)}\t${cleanCell(what)}\t${cleanCell(why)}\n`;
}
export function logLine(now: Date, label: Label, what: string, v: Extract<Verdict, { ok: false }>): string {
  return holdLine(now, label, what, `${cleanCell(v.floor)}: ${cleanCell(v.why)}`);
}

// The guard as the runner and the link call it: a refusal is logged (logFile, or the log sink), and the
// reason comes back, with whether it was logged. With neither, nothing is logged (review.sh's own first
// look, which sends the hold to the link instead).
export function guard(label: Label, what: string, o: { settingsFile: string; spendFile: string; logFile?: string; log?: (line: string) => void;
    tz: string; now: Date; plan?: () => PlanReading; cacheFile?: string | null }): Verdict {
  if (label !== "other") return { ok: true };
  const v = decide(label, readings(o), o.now);
  if (!v.ok && (o.log || o.logFile)) {
    try { const line = logLine(o.now, label, what, v); if (o.log) o.log(line); else appendFileSync(o.logFile!, line); v.logged = true; }
    catch { v.logged = false; /* the refusal stands either way */ }
  }
  return v;
}

// A hold sent to the link by a part that runs as Cain (the Build hook, review.sh): POST /guard-hold on
// the link's local port with Cain's own key. The link answers "held" once it appended the line. Any other
// answer, or none, is "not logged": the caller still refuses (it fails closed) and says so. Round 3: the
// link answering "passes" (its own reading lets it run) comes back as passes, so the caller can name the
// difference between the two readings.
export const LINK_URL = "http://127.0.0.1:8097";
export const CAIN_KEY_FILE = "/run/cain/keys/cain.key";
// hook (0.17.0, round 2): the Build hook's own refusal when its reading wasn't ready ("cache cold" or
// "out of time"); the link writes that hold line without its own reading.
export async function postHold(label: Label, what: string, o: { url?: string; key?: string; keyFile?: string; ms?: number;
    fetch?: typeof fetch; hook?: string } = {}): Promise<{ logged: true; why: string } | { logged: false; why: string; passes?: boolean }> {
  let key = o.key ?? "";
  if (!key) { try { key = readFileSync(o.keyFile ?? CAIN_KEY_FILE, "utf8").trim(); } catch { return { logged: false, why: "this start has no key for the link" }; } }
  try {
    const r = await (o.fetch ?? fetch)(`${o.url ?? LINK_URL}/guard-hold`, { method: "POST", body: JSON.stringify({ label, what: String(what).slice(0, 200), ...(o.hook ? { hook: o.hook } : {}) }),
      headers: { "content-type": "application/json", "x-harness-key": key }, signal: AbortSignal.timeout(o.ms ?? 5_000) });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && j?.status === "held") return { logged: true, why: String(j.why ?? "") };
    if (r.ok && j?.status === "passes") return { logged: false, passes: true, why: "the link's own reading lets it run" };
    return { logged: false, why: `the link answered ${j?.status ?? r.status}` };
  } catch (e) { return { logged: false, why: `the link didn't answer (${String(e).slice(0, 60)})` }; }
}

// The guard's reading in two lines, for Cain's daily usage row (review.sh guard).
export function guardLines(r: Readings, now: Date): [string, string] {
  const p = r.plan;
  const pct = (f: number) => Math.round(Math.max(0, 1 - f) * 100);
  const files = `${p.files} transcript file${p.files === 1 ? "" : "s"} read, ${p.skipped ?? 0} skipped`;
  const counted = p.tokens_week !== null ? `${p.tokens_week} tokens counted since ${p.week_start ?? "the week's start"}` : "";
  const plan = p.fraction === null
    ? `Plan: unknown (${p.reason}${counted ? `; ${counted}` : ""}; ${files})`
    : `Plan: ${pct(p.fraction)}% of the week's allowance left (${counted}, of ${p.allowance}; ${files}; read ${p.at})`;
  // Round 2: when the allowance was set and how it was worked out, from the runner's settings.
  const set = r.allowance ? `; the allowance was set ${r.allowance.set_on ?? "on a date not recorded"}, from ${r.allowance.derivation ?? "a derivation not recorded"}` : "";
  const v = decide("other", r, now);
  const seats = r.seats
    ? `Seats: ${r.seats.map((s) => `${SEAT_LABEL[s.seat as Seat] ?? s.seat} ${s.left === null ? "?" : `${Math.round(s.left * 100)}%`} left`).join(", ") || "none capped"}`
    : `Seats: unknown (${r.seatsWhy ?? "can't be read"})`;
  return [`${plan}${set}.`, `${seats}. Floor ${r.floor}%: ${v.ok ? "other work may run" : `other work is held (${v.floor})`}; core, commitment and necessary-fix work always may.`];
}
