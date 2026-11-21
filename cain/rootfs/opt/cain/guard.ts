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
// the guard never posts a card. The log is root:cain 0640 (round 2): root writes it, Cain only reads.
// The runner (root) appends itself; the Build hook and review.sh, which run as Cain, send the hold to
// the link (POST /guard-hold), which decides again from its own readings and appends only a refusal.
//
// The silent gap (round 3): the Build hook decides a Build run alone and asks the link only when its own
// reading refuses (hooks/remote-trigger.ts decideWithGuard). That is safe only while the plan reader can
// never return a real fraction (plan-usage.ts answers unknown, so "other" is always refused and a pass
// from the hook alone can't happen). Before plan-usage.ts returns anything but unknown, the link must
// decide every "other" Build run first, and LINK_DECIDES_BUILDS below must say so; cap.test.ts fails
// while the reader can return a fraction and this is false.
import { appendFileSync, readFileSync } from "node:fs";
import { readPlanUsage, type PlanReading } from "./plan-usage.ts";
import { capPaths } from "./capfiles.ts";

export const LINK_DECIDES_BUILDS = false;
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
  return { settings: p.settings, spend: p.spend, log: p.guardLog, tz: env.CHECKIN_TZ ?? "America/New_York" };
};

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
// logged (round 2): whether a refusal reached the guard's log; false when it couldn't be logged.
// linkPasses (round 3): the link's own reading let it pass where the hook's refused (the hook names the difference).
export type Verdict = { ok: true } | { ok: false; floor: string; why: string; logged?: boolean; linkPasses?: boolean };

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
    tz: string; now: Date; plan?: () => PlanReading }): Verdict {
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
export async function postHold(label: Label, what: string, o: { url?: string; key?: string; keyFile?: string; ms?: number;
    fetch?: typeof fetch } = {}): Promise<{ logged: true; why: string } | { logged: false; why: string; passes?: boolean }> {
  let key = o.key ?? "";
  if (!key) { try { key = readFileSync(o.keyFile ?? CAIN_KEY_FILE, "utf8").trim(); } catch { return { logged: false, why: "this start has no key for the link" }; } }
  try {
    const r = await (o.fetch ?? fetch)(`${o.url ?? LINK_URL}/guard-hold`, { method: "POST", body: JSON.stringify({ label, what: String(what).slice(0, 200) }),
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
  const plan = p.fraction === null
    ? `Plan: unknown (${p.reason}${p.tokens_week !== null ? `; ${p.tokens_week} tokens recorded in the last 7 days` : ""})`
    : `Plan: ${Math.round((1 - p.fraction) * 100)}% of the week's allowance left (read ${p.at})`;
  const v = decide("other", r, now);
  const seats = r.seats
    ? `Seats: ${r.seats.map((s) => `${SEAT_LABEL[s.seat as Seat] ?? s.seat} ${s.left === null ? "?" : `${Math.round(s.left * 100)}%`} left`).join(", ") || "none capped"}`
    : `Seats: unknown (${r.seatsWhy ?? "can't be read"})`;
  return [`${plan}.`, `${seats}. Floor ${r.floor}%: ${v.ok ? "other work may run" : `other work is held (${v.floor})`}; core, commitment and necessary-fix work always may.`];
}
