// The heartbeat checks' timing at Healthchecks.io (Cain 0.17.0): the assistant reads and sets a check's
// grace and period itself, through the link, which holds the management API key (the App's option
// healthchecks_api_key, in a root-only file only the link reads, never an environment; Cain's user never
// reads it, and it's never logged or answered back).
//   keeper.sh hc-check <check name>                                  POST /hc {cmd: "check", name}
//   keeper.sh hc-set <check name> --grace <s> [--period <s>]         POST /hc {cmd: "set", name, grace, period?}
// Only those fields: anything else in the call is refused, and a set sends Healthchecks only grace and
// timeout (its name for the period). Each set is logged (the App log and the link's own log file).
// Round 2 of 0.17.0's review fixes: these checks watch Cain, so a very long grace or period would mute
// its own dead-man alarm. The link holds hard ceilings (HC_CEILING_S: one hour each), whatever keeper.sh
// sends; a set above one is refused naming it. Every set the service takes is relayed to Cain and posted
// to the owner's DM by the link, one plain line with the check's name and the old and new values.
// Round 3: a set whose line to the owner can't be posted (the link's notice path fails, or the message gate's
// rules refuse the line) raises a rate-limited alarm naming the check (HcAnnounceAlarm, notice.sh "hc-announce"),
// not only a log line; the next line that is posted clears it.
import { readFileSync } from "node:fs";
import { check as gateCheck, verdict as gateVerdict, type Rule } from "../gate/rules";
import { appendSynced } from "./auth";

export const HC_API = "https://healthchecks.io/api/v3";
export const HC_MIN_S = 60;
export const HC_MAX_S = 31_536_000;             // Healthchecks' own bounds for timeout and grace
export const HC_CEILING_S = 3_600;              // round 2: the link's ceiling for grace and for period (one hour)

// The key (round 2): read from its root-only file, which the run script writes from the App's option
// (/run/cain-hc/key, folder 0700, file 0600), never from the environment: Bun gives every child the
// environment the process started with, whatever is deleted from process.env later, so a key there would
// reach every child the link starts (git, curl, notice.sh). A name left in the environment is dropped too.
export const HC_KEY_FILE = "/run/cain-hc/key";
export function takeKey(file = HC_KEY_FILE, env: Record<string, string | undefined> = process.env): string {
  delete env.HEALTHCHECKS_API_KEY;
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}
export const HC_LOG = "/data/link/healthchecks.log";
const FIELDS = new Set(["cmd", "name", "grace", "period"]);

export type HcDeps = {
  key: () => string;                                       // "" when no key is set
  fetch?: typeof fetch;
  log?: (line: string) => void;                            // the App log
  logFile?: string | null;                                 // the set log; null: none
  now?: () => number;
  api?: string;
  announce?: (line: string) => void | Promise<void>;     // round 2: a set the service took, to Cain and the owner's DM
  announceFailed?: (name: string, why: string) => void;  // round 3: its line couldn't be posted (the alarm)
  announced?: () => void;                                // round 3: its line was posted (clears the alarm)
};

// The message gate's rules for a line the link posts in its own name (round 3): what the gate refuses in
// the assistant's words, every em dash included, so a set line never carries a dash, an ISO time or an id.
export const HC_LINE_RULES: readonly Rule[] = ["dash", "app", "count", "machine"];
export function lineTrouble(line: string): string | null {
  const r = gateCheck(line, { rules: HC_LINE_RULES, refusable: true });
  return gateVerdict(r) === "pass" ? null : [...new Set(r.hits.map((h) => h.rule))].join(", ");
}

// The alarm for a set line that couldn't be posted: at most once an hour per check; cleared by the next
// line that is posted.
export class HcAnnounceAlarm {
  private last = new Map<string, number>();
  private up = false;
  constructor(private o: { raise: (kind: string, cause: string) => void; clear: (group: string) => void; now?: () => number; quietMs?: number }) {}
  failed(name: string, why: string): void {
    const now = (this.o.now ?? Date.now)();
    const at = this.last.get(name);
    if (at !== undefined && now - at < (this.o.quietMs ?? 3_600_000)) return;
    this.last.set(name, now);
    this.up = true;
    this.o.raise("hc-announce", `the check "${name}": ${why}`.slice(0, 200));
  }
  posted(): void { if (this.up) { this.up = false; this.last.clear(); this.o.clear("hcset"); } }
}
export type HcAnswer = { status: "ok"; said: string; check?: Record<string, unknown> } | { status: "refused" | "error"; said: string };

const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const secs = (v: unknown): number | null | "over" => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < HC_MIN_S) return null;
  return n > HC_CEILING_S ? "over" : n;
};
const OVER = (flag: string) => `${flag} is at most ${HC_CEILING_S} seconds (one hour): the link's ceiling for the checks that watch Cain, so a long one can't mute their alarm`;
// What a check shows: its name, grace, period, status and last ping. Nothing else (no ping URL: it's a secret).
export function shown(c: any): Record<string, unknown> {
  return { name: clean(c?.name), grace: Number(c?.grace) || null, period: Number(c?.timeout) || null,
    status: clean(c?.status, 20), last_ping: c?.last_ping ? clean(c.last_ping, 40) : null };
}
const line = (c: Record<string, unknown>) =>
  `${c.name}: grace ${c.grace ?? "?"} s, period ${c.period ?? "?"} s, status ${c.status || "?"}, last ping ${c.last_ping ?? "never"}`;

// The one plain line a set makes (round 2): the check's name (letters, digits and a few marks only, so it
// reads plainly and passes the message gate) and the old and new values.
export const plainName = (name: string) => String(name).replace(/[^A-Za-z0-9 ._()-]+/g, "?").replace(/\s+/g, " ").trim().slice(0, 60) || "?";
export function setLine(name: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
  const n = plainName(name);
  return `Cain set the Healthchecks.io check "${n}": grace ${before.grace ?? "?"} to ${after.grace ?? "?"} seconds, period ${before.period ?? "?"} to ${after.period ?? "?"} seconds.`;
}

export async function hcCall(b: any, d: HcDeps): Promise<HcAnswer> {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: "refused", said: "not a Healthchecks call" };
  const extra = Object.keys(b).filter((k) => !FIELDS.has(k));
  if (extra.length) return { status: "refused", said: `only the check's name, grace and period can be given; refused: ${extra.map((k) => clean(k, 30)).join(", ")}` };
  const cmd = String(b.cmd ?? "");
  if (cmd !== "check" && cmd !== "set") return { status: "refused", said: "the command is check or set" };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return { status: "refused", said: "a check is named by its name at Healthchecks, up to 100 characters" };
  let body: { grace?: number; timeout?: number } = {};
  if (cmd === "check") {
    if (b.grace !== undefined || b.period !== undefined) return { status: "refused", said: "hc-check reads only; use hc-set to change grace or period" };
  } else {
    const grace = secs(b.grace);
    if (grace === "over") return { status: "refused", said: OVER("--grace") };
    if (grace === null) return { status: "refused", said: `--grace is needed, in whole seconds from ${HC_MIN_S} to ${HC_CEILING_S}` };
    body.grace = grace;
    if (b.period !== undefined) {
      const period = secs(b.period);
      if (period === "over") return { status: "refused", said: OVER("--period") };
      if (period === null) return { status: "refused", said: `--period is in whole seconds from ${HC_MIN_S} to ${HC_CEILING_S}` };
      body.timeout = period;
    }
  }
  const key = d.key();
  if (!key) return { status: "refused", said: "no key set: the owner pastes a Healthchecks.io management API key (read-write) once in the App's option healthchecks_api_key" };
  const api = d.api ?? HC_API;
  const f = d.fetch ?? fetch;
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await f(url, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "x-api-key": key, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  let list;
  try { list = await req("GET", `${api}/checks/`); }
  catch (e) { return { status: "error", said: `Healthchecks.io didn't answer (${clean(String(e), 60)})` }; }
  if (list.status === 401) return { status: "error", said: "Healthchecks.io refused the key (401): the owner checks it is a read-write management API key for the right project" };
  if (list.status !== 200 || !Array.isArray(list.body?.checks)) return { status: "error", said: `Healthchecks.io answered ${list.status} to the list of checks` };
  const found = list.body.checks.filter((c: any) => String(c?.name ?? "") === name);
  if (!found.length) {
    const names = list.body.checks.map((c: any) => clean(c?.name, 40)).filter(Boolean).slice(0, 10);
    return { status: "refused", said: `no check named "${clean(name)}"${names.length ? `; the checks are: ${names.join(", ")}` : ""}` };
  }
  if (found.length > 1) return { status: "refused", said: `more than one check is named "${clean(name)}": rename one at Healthchecks.io first` };
  const c = found[0];
  if (cmd === "check") { const s = shown(c); return { status: "ok", said: line(s), check: s }; }
  // The check's own address for changes: from its update_url when it is under the API, else its uuid.
  const uuid = /\/checks\/([0-9a-f-]{36})\/?$/i.exec(String(c?.update_url ?? ""))?.[1] ?? /([0-9a-f-]{36})\/?$/i.exec(String(c?.ping_url ?? ""))?.[1];
  if (!uuid) return { status: "error", said: "Healthchecks.io didn't give the check's id: the key may be read-only (the owner needs a read-write key)" };
  const before = shown(c);
  let r;
  try { r = await req("POST", `${api}/checks/${uuid}`, body); }
  catch (e) { return { status: "error", said: `Healthchecks.io didn't answer the change (${clean(String(e), 60)}); it may or may not have taken it: hc-check says` }; }
  const after = r.status === 200 ? shown(r.body) : null;
  const entry = { at: new Date((d.now ?? Date.now)()).toISOString(), name: clean(name), asked: { grace: body.grace, period: body.timeout ?? null },
    before: { grace: before.grace, period: before.period }, status: r.status, after: after ? { grace: after.grace, period: after.period } : null };
  (d.log ?? console.log)(`healthchecks: set ${entry.name}: grace ${before.grace} to ${body.grace}${body.timeout ? `, period ${before.period} to ${body.timeout}` : ""}: Healthchecks.io answered ${r.status}`);
  if (d.logFile !== null) { try { appendSynced(d.logFile ?? HC_LOG, JSON.stringify(entry) + "\n"); } catch (e) { (d.log ?? console.log)(`healthchecks: couldn't write the set log: ${clean(String(e), 60)}`); } }
  if (!after) return { status: "error", said: `Healthchecks.io answered ${r.status} to the change${r.body?.error ? `: ${clean(r.body.error)}` : ""}` };
  if (d.announce) {
    const said = setLine(name, before, after);
    const bad = lineTrouble(said);
    let failed: string | null = bad ? `the message gate's rules refuse its line (${bad})` : null;
    if (!failed) {
      try { await d.announce(said); }
      catch (e) { failed = `the link couldn't post its line (${clean(String(e), 60)})`; }
    }
    if (failed) {
      (d.log ?? console.log)(`healthchecks: couldn't announce the set of ${clean(name)}: ${failed}`);
      try { d.announceFailed?.(plainName(name), failed); } catch (e) { (d.log ?? console.log)(`healthchecks: couldn't raise the set line's alarm: ${clean(String(e), 60)}`); }
    } else { try { d.announced?.(); } catch { /* the clearing is tried again at the next set */ } }
  }
  return { status: "ok", said: `Healthchecks.io answered: ${line(after)}`, check: after };
}
