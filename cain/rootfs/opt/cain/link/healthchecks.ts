// The heartbeat checks' timing at Healthchecks.io (Cain 0.17.0): the assistant reads and sets a check's
// grace and period itself, through the link, which holds the management API key (the App's option
// healthchecks_api_key, in the link's environment only; Cain's user never reads it, and it's never
// logged or answered back).
//   keeper.sh hc-check <check name>                                  POST /hc {cmd: "check", name}
//   keeper.sh hc-set <check name> --grace <s> [--period <s>]         POST /hc {cmd: "set", name, grace, period?}
// Only those fields: anything else in the call is refused, and a set sends Healthchecks only grace and
// timeout (its name for the period). Each set is logged (the App log and the link's own log file).
import { appendSynced } from "./auth";

export const HC_API = "https://healthchecks.io/api/v3";
export const HC_MIN_S = 60;
export const HC_MAX_S = 31_536_000;             // Healthchecks' own bounds for timeout and grace
export const HC_LOG = "/data/link/healthchecks.log";
const FIELDS = new Set(["cmd", "name", "grace", "period"]);

export type HcDeps = {
  key: () => string;                                       // "" when no key is set
  fetch?: typeof fetch;
  log?: (line: string) => void;                            // the App log
  logFile?: string | null;                                 // the set log; null: none
  now?: () => number;
  api?: string;
};
export type HcAnswer = { status: "ok"; said: string; check?: Record<string, unknown> } | { status: "refused" | "error"; said: string };

const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const secs = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= HC_MIN_S && n <= HC_MAX_S ? n : null;
};
// What a check shows: its name, grace, period, status and last ping. Nothing else (no ping URL: it's a secret).
export function shown(c: any): Record<string, unknown> {
  return { name: clean(c?.name), grace: Number(c?.grace) || null, period: Number(c?.timeout) || null,
    status: clean(c?.status, 20), last_ping: c?.last_ping ? clean(c.last_ping, 40) : null };
}
const line = (c: Record<string, unknown>) =>
  `${c.name}: grace ${c.grace ?? "?"} s, period ${c.period ?? "?"} s, status ${c.status || "?"}, last ping ${c.last_ping ?? "never"}`;

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
    if (grace === null) return { status: "refused", said: `--grace is needed, in whole seconds from ${HC_MIN_S} to ${HC_MAX_S}` };
    body.grace = grace;
    if (b.period !== undefined) {
      const period = secs(b.period);
      if (period === null) return { status: "refused", said: `--period is in whole seconds from ${HC_MIN_S} to ${HC_MAX_S}` };
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
  return { status: "ok", said: `Healthchecks.io answered: ${line(after)}`, check: after };
}
