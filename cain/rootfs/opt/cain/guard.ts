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
// There is no tap or flag that bypasses it. Every refusal is one line appended to
// /data/review-guard.log (time, label, what was refused, which floor), which Cain reads to list holds;
// the guard never posts a card.
import { appendFileSync, readFileSync } from "node:fs";
import { readPlanUsage, type PlanReading } from "./plan-usage.ts";

export const LABELS = ["core", "commitment", "necessary-fix", "other"] as const;
export type Label = typeof LABELS[number];
export const DEFAULT_RESERVE_PERCENT = 25;
export const STALE_MS = 24 * 3_600_000;
export const SETTINGS_FORMAT = 1;
export const SEAT_NAMES = ["openai", "gemini", "perplexity", "claude"] as const;
type Seat = typeof SEAT_NAMES[number];
const SEAT_LABEL: Record<Seat, string> = { openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude" };

export const paths = (env: Record<string, string | undefined> = process.env) => ({
  settings: env.REVIEW_SETTINGS ?? "/data/review-settings.json",
  spend: env.REVIEW_SPEND ?? "/data/review-spend.json",
  log: env.REVIEW_GUARD_LOG ?? "/data/review-guard.log",
  tz: env.CHECKIN_TZ ?? "America/New_York",
});

// What the runner writes at its start (review/runner.ts writeSettings): the caps and the cap it really
// uses, so review.sh and the Build hook, run as Cain, read the runner's numbers and not their own.
export type Settings = {
  format: number; written_at: string; round_cap: number; reserve_percent: number;
  caps: { gemini: number; perplexity: number; claude: number; openaiRuns: number }; review_limit: number;
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
export type Readings = { plan: PlanReading; seats: SeatLeft[] | null; seatsWhy?: string; floor: number };
export type Verdict = { ok: true } | { ok: false; floor: string; why: string };

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
  if (p.fraction === null) return { ok: false, floor: "plan", why: `the plan's usage is unknown (${p.reason}), which counts as below the ${r.floor}% reserve floor` };
  if (!Number.isFinite(age) || age > STALE_MS) return { ok: false, floor: "plan", why: `the plan's usage reading is more than a day old, which counts as below the ${r.floor}% reserve floor` };
  if (1 - p.fraction < floor) return { ok: false, floor: "plan", why: `the plan has ${Math.round((1 - p.fraction) * 100)}% of the week's allowance left, below the ${r.floor}% reserve floor` };
  if (!r.seats) return { ok: false, floor: "seats", why: `${r.seatsWhy ?? "the review seats' spend can't be read"}, which counts as below the ${r.floor}% reserve floor` };
  const low = r.seats.filter((s) => s.left === null || s.left < floor);
  if (low.length) return { ok: false, floor: `seat ${low.map((s) => s.seat).join(", ")}`,
    why: `${low.map((s) => `${SEAT_LABEL[s.seat as Seat] ?? s.seat} has ${s.left === null ? "an unknown share" : `${Math.round(s.left * 100)}%`} of its monthly cap left`).join("; ")}, below the ${r.floor}% reserve floor` };
  return { ok: true };
}

export function monthOf(now: Date, tz: string): string { return now.toLocaleDateString("en-CA", { timeZone: tz }).slice(0, 7); }

// Everything read now: the runner's settings, the spend file, the plan.
export function readings(o: { settingsFile: string; spendFile: string; tz: string; now: Date; plan?: () => PlanReading }): Readings {
  const settings = readSettings(o.settingsFile);
  let ledger: any = null;
  try { ledger = JSON.parse(readFileSync(o.spendFile, "utf8")); }
  catch (e: any) { ledger = e?.code === "ENOENT" ? {} : null; }
  const s = seatsLeft(ledger, settings, monthOf(o.now, o.tz));
  let plan: PlanReading;
  try { plan = (o.plan ?? (() => readPlanUsage({ now: o.now })))(); }
  catch (e) { plan = { fraction: null, at: o.now.toISOString(), reason: `the reader failed: ${String(e).slice(0, 80)}`, tokens_week: null, files: 0 }; }
  return { plan, seats: s.seats, ...(s.why ? { seatsWhy: s.why } : {}), floor: settings?.reserve_percent ?? DEFAULT_RESERVE_PERCENT };
}

// One line of the guard's log, for each refusal: time, label, what was refused, which floor.
export function logLine(now: Date, label: Label, what: string, v: Extract<Verdict, { ok: false }>): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").slice(0, 160);
  return `${now.toISOString()}\t${label}\t${clean(what)}\t${clean(v.floor)}: ${clean(v.why)}\n`;
}

// The guard as the runner and the hook call it: refused work is logged, and the reason comes back.
export function guard(label: Label, what: string, o: { settingsFile: string; spendFile: string; logFile: string; tz: string; now: Date; plan?: () => PlanReading }): Verdict {
  if (label !== "other") return { ok: true };
  const v = decide(label, readings(o), o.now);
  if (!v.ok) { try { appendFileSync(o.logFile, logLine(o.now, label, what, v)); } catch { /* the refusal stands either way */ } }
  return v;
}

// The guard's reading in two lines, for Cain's daily usage row (review.sh guard).
export function guardLines(r: Readings, now: Date): [string, string] {
  const p = r.plan;
  const plan = p.fraction === null
    ? `Plan: unknown (${p.reason}${p.tokens_week !== null ? `; ${p.tokens_week} tokens recorded in the last 7 days` : ""})`
    : `Plan: ${Math.round((1 - p.fraction) * 100)}% of the week's allowance left (read ${p.at})`;
  const v = decide("other", r, now);
  const seats = r.seats
    ? `Seats: ${r.seats.map((s) => `${SEAT_LABEL[s.seat as Seat] ?? s.seat} ${s.left === null ? "?" : `${Math.round(s.left * 100)}%`} left`).join(", ") || "none capped"}`
    : `Seats: unknown (${r.seatsWhy ?? "can't be read"})`;
  return [`${plan}.`, `${seats}. Floor ${r.floor}%: ${v.ok ? "other work may run" : `other work is held (${v.floor})`}; core, commitment and necessary-fix work always may.`];
}
