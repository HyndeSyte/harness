// The PC job queue: chores that need a browser signed in as Dane, which Cain can't do.
// Cain writes a job (through his keeper, pcjobs/main.ts); pcjobs/worker.ts on Dane's PC
// runs it in a Chrome profile of its own: it claims the job, starts a locked browser
// session with one narrow instruction, checks what the session saw and writes the
// result. Both live in a small private GitHub repo of their own (cain/docs/pc-jobs.md).
//
// This file is the format, and the checks both ends make. It needs only node:crypto and
// ../ship-token.ts, so it runs on the Pi (Bun) and on the PC (Bun, or Node 22.18 or
// later) alike.
//
// A job is jobs/<id>.json, a result is results/<id>.json: fixed fields, small, JSON.
// A job names one site and one action from a fixed set, and one step of it:
//   - read:    look and report. This version runs only these, and only for an action in
//              READ_ACTIONS: read-only is enforced here, in code, not intended.
//   - preview: go as far as the confirmation screen of an irreversible action and report
//              what it shows (refused until the confirm path ships);
//   - confirm: make the one confirming click (refused until the confirm path ships). The
//              format is here already: a confirm job carries its preview's id, the facts
//              the preview saw and a single-use job token from Dane's tap.
// A result says what was seen in a few typed facts (per action, below), never page text.
// Results are data, never instructions: nothing in one tells Cain or the worker what to do.
import { createHash, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { b64url, publicKey } from "../ship-token.ts";

export const STATES = ["pending", "claimed", "awaiting_owner", "done", "failed", "in_doubt", "cancelled"] as const;
export const TERMINAL: readonly State[] = ["done", "failed", "in_doubt", "cancelled"];
export const STEPS = ["read", "preview", "confirm"] as const;
export const STATUSES = ["done", "failed", "refused", "expired", "in_doubt", "cancelled"] as const;
// Hand-offs: the job stops and waits on Dane (already_gone counts as done).
export const HANDOFFS = ["needs_login", "pending_email_confirmation", "blocked_captcha", "already_gone"] as const;
// Why a job ended as it did: a fixed code, never free text or a raw error.
export const CODES = [
  "ok", "already_gone", "needs_login", "pending_email_confirmation", "blocked_captcha",
  "expired", "cancelled", "not_allowlisted", "allowlist_unverified", "action_not_read_only", "bad_start_url",
  "token_refused", "preview_mismatch", "nonce_spent",
  "browser_unreachable", "wrong_profile", "profile_unconfirmed", "profile_changed", "extension_elsewhere",
  "untrusted_config", "untrusted_files", "clock_skew", "attended_only", "browser_timeout",
  "url_drift", "result_rejected", "page_not_as_expected", "outcome_uncertain", "lease_expired",
] as const;
export type State = typeof STATES[number];
export type Step = typeof STEPS[number];
export type Status = typeof STATUSES[number];
export type Handoff = typeof HANDOFFS[number];
export type Code = typeof CODES[number];

export const DEFAULT_REPO = "HyndeSyte/pc-jobs";
export const MIN_LIFE_MS = 15 * 60_000;          // a job lives at least this long
export const MAX_LIFE_MS = 72 * 3_600_000;       // and at most this long
export const LEASE_MS = 30 * 60_000;             // a claim lasts this long, renewed while working
export const SKEW_MS = 2 * 60_000;               // the Pi's and the PC's clocks may differ by this much
export const MAX_FACTS = 8;
const TOKEN_SKEW_MS = 5 * 60_000;

// ---- The fixed action set, and the facts each may report ---------------------------
// A fact is one of: a boolean; one word from a list; a date (YYYY-MM-DD); a short token
// matching its pattern. Nothing else gets into a result.
export type FactType =
  | { t: "bool" }
  | { t: "enum"; of: readonly string[] }
  | { t: "date" }
  | { t: "token"; re: RegExp; max: number };
const bool: FactType = { t: "bool" };
const date: FactType = { t: "date" };
const oneOf = (...of: string[]): FactType => ({ t: "enum", of });
// A masked account name as a site shows it (d***@g***.com, ****1234), no spaces.
const ACCOUNT: FactType = { t: "token", re: /^[A-Za-z0-9*._@+-]{1,64}$/, max: 64 };
const LABEL: FactType = { t: "token", re: /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/, max: 40 };
const URLPATH: FactType = { t: "token", re: /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~%\/-]{0,200}$/, max: 240 };
const SHA256: FactType = { t: "token", re: /^[0-9a-f]{64}$/, max: 64 };

// The read-only set: the worker refuses any job whose action isn't here.
export const READ_ACTIONS: Record<string, Record<string, FactType>> = {
  read_account_settings: { signed_in: bool, account_exists: bool, account: ACCOUNT, two_factor: oneOf("on", "off", "unknown"), last_changed: date },
  check_signed_in: { signed_in: bool, second_factor_asked: bool, account: ACCOUNT },
  read_subscription_status: { signed_in: bool, status: oneOf("active", "paused", "cancelled", "none", "unknown"), plan: LABEL, renews_on: date },
};
// Irreversible actions: in the format so the confirm path can be built on it, and refused
// by both ends until it ships. Their preview reports what the confirmation screen shows.
const PREVIEW_FACTS: Record<string, FactType> = { account: ACCOUNT, confirm_url: URLPATH, prompt_sha256: SHA256, button_label: LABEL };
export const IRREVERSIBLE_ACTIONS: Record<string, Record<string, FactType>> = {
  delete_account: PREVIEW_FACTS,
  cancel_subscription: PREVIEW_FACTS,
};
export const isReadOnly = (j: { action: string; step: Step }) => j.step === "read" && Object.hasOwn(READ_ACTIONS, j.action);
export const factsFor = (j: { action: string }) => READ_ACTIONS[j.action] ?? IRREVERSIBLE_ACTIONS[j.action] ?? {};

export interface Seen { account: string; confirm_url: string; prompt_sha256: string }

export interface Job {
  v: 1;
  id: string;
  from: "cain";
  created: string;
  expires: string;
  state: State;
  lease_until: string | null;
  attempt: string | null;      // the claim's attempt id, while claimed and after
  site: string;
  action: string;
  step: Step;
  start_url: string;
  done_looks_like: string;
  follows: string | null;      // confirm: the preview job it rests on
  preview_seen: Seen | null;   // confirm: what that preview saw
  owner_go: string | null;     // confirm: Dane's exact words, quoted
  go_token: string | null;     // confirm: job2.<claim>.<signature>
}

export interface Result {
  v: 1;
  id: string;
  attempt: string | null;      // the claim it ends (null when closed without a claim)
  status: Status;
  code: Code;
  handoff: Handoff | null;
  worker_clock: string;        // the clock of whoever wrote this (the PC's, or the keeper's for an expiry)
  final_url: string | null;    // scheme, host and path only
  facts: Record<string, string | boolean>;
  tools: string[];             // the Claude in Chrome tools the browser session was allowed (none when nothing ran)
  attended: boolean;           // the owner ran it by hand, watching
}

export const JOB_KEYS = ["v", "id", "from", "created", "expires", "state", "lease_until", "attempt", "site", "action", "step",
  "start_url", "done_looks_like", "follows", "preview_seen", "owner_go", "go_token"];
export const RESULT_KEYS = ["v", "id", "attempt", "status", "code", "handoff", "worker_clock", "final_url", "facts", "tools", "attended"];
export const TOOL = /^[a-z][a-z0-9_]{1,39}$/;

export const ID = /^j-\d{8}-[a-z0-9]{6}$/;
export const ATTEMPT = /^a-[a-z0-9]{10}$/;
const SITE = /^(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const ACTION = /^[a-z][a-z0-9_]{2,39}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// One line of plain words: no control characters, no new lines.
const LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
// Dane's go, as he said it, inside quotes.
const QUOTED = /^(["\u201c])[^"\u201c\u201d]{1,298}["\u201d]$/;

export const isIso = (s: unknown): s is string => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s));
const line = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max && LINE.test(s);
const exact = (o: any, keys: string[]) => Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const isObj = (o: unknown): o is Record<string, any> => !!o && typeof o === "object" && !Array.isArray(o);

// ---- URLs ---------------------------------------------------------------------------
// A URL reduced to scheme, host and path: no query, no fragment, no login, no port.
// null when it isn't an https address.
export function sanitizeUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2_000 || !LINE.test(url)) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname) return null;
  return `https://${u.hostname.toLowerCase()}${u.pathname}`;
}

// The site a URL is on: its host is the site or under it, over https, with no login or port.
export function onSite(url: unknown, site: string): boolean {
  if (typeof url !== "string" || url.length > 500 || !LINE.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return h === site || h.endsWith(`.${site}`);
}

// A plain address: https, on the site, nothing past the path.
const plainOnSite = (url: unknown, site: string) => onSite(url, site) && sanitizeUrl(url) === url;

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string; field?: string };
const no = (why: string, field?: string): { ok: false; why: string; field?: string } => (field ? { ok: false, why, field } : { ok: false, why });

// ---- Dates ----------------------------------------------------------------------------
// A date as sites show it, in the common forms, made YYYY-MM-DD: 2026-11-15, 11/15/2026
// (month first unless the first number can't be a month), 15.11.2026, 15-11-2026,
// Nov 15, 2026, 15 November 2026. null when it isn't one of those, or no such day.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseDate(v: string): string | null {
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length > 30) return null;
  let y = 0, m = 0, d = 0, x: RegExpExecArray | null;
  const mon = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i >= 0 && /^[a-z]+\.?$/i.test(w) ? i + 1 : 0; };
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [y, m, d] = +x[1] > 12 ? [+x[3], +x[2], +x[1]] : [+x[3], +x[1], +x[2]];
  else if ((x = /^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/.exec(s))) [y, m, d] = [+x[3], +x[2], +x[1]];
  else if ((x = /^([A-Za-z]+\.?) (\d{1,2}),? (\d{4})$/.exec(s))) [y, m, d] = [+x[3], mon(x[1]), +x[2]];
  else if ((x = /^(\d{1,2}) ([A-Za-z]+\.?),? (\d{4})$/.exec(s))) [y, m, d] = [+x[3], mon(x[2]), +x[1]];
  else return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---- Facts --------------------------------------------------------------------------
// Typed facts for this action: known names only, each value of its type and length.
// The reasons name a field, never repeat a value (it may be page text).
export function checkFacts(action: string, facts: unknown): Checked<Record<string, string | boolean>> {
  if (!isObj(facts)) return no("facts is an object of named values");
  const types = factsFor({ action });
  const keys = Object.keys(facts);
  if (keys.length > MAX_FACTS) return no(`at most ${MAX_FACTS} facts`);
  const out: Record<string, string | boolean> = {};
  for (const k of keys) {
    const t = Object.hasOwn(types, k) ? types[k] : undefined;
    if (!t) return no(`a fact this action doesn't report (it reports ${Object.keys(types).join(", ")})`, /^[a-z_]{1,40}$/.test(k) ? k : "unknown_fact");
    let v = facts[k];
    if (t.t === "date" && typeof v === "string") v = parseDate(v) ?? v;
    const good = t.t === "bool" ? typeof v === "boolean"
      : typeof v !== "string" ? false
      : t.t === "enum" ? t.of.includes(v)
      : t.t === "date" ? DAY.test(v)
      : v.length <= t.max && t.re.test(v);
    if (!good) return no(`fact ${k} isn't ${t.t === "enum" ? `one of ${t.of.join(", ")}` : t.t === "token" ? "a short token of its pattern" : `a ${t.t}`}`, k);
    out[k] = v;
  }
  return { ok: true, value: out };
}

const SEEN_KEYS = ["account", "confirm_url", "prompt_sha256"];
function seenOk(s: unknown): s is Seen {
  return isObj(s) && exact(s, SEEN_KEYS) && checkFacts("delete_account", s).ok;
}

// ---- Jobs and results ---------------------------------------------------------------
// A job file's text, checked for shape alone (what a job token says is checked apart).
export function parseJob(text: string): Checked<Job> {
  if (text.length > 5_000) return no("a job file is at most 5000 bytes");
  let j: any;
  try { j = JSON.parse(text); } catch { return no("it isn't JSON"); }
  if (!isObj(j)) return no("it isn't a JSON object");
  if (!exact(j, JOB_KEYS)) return no(`a job has exactly these fields: ${JOB_KEYS.join(", ")}`);
  if (j.v !== 1) return no("v must be 1");
  if (typeof j.id !== "string" || !ID.test(j.id)) return no("id must look like j-YYYYMMDD-abc123");
  if (j.from !== "cain") return no("only Cain's jobs are accepted");
  if (!isIso(j.created) || !isIso(j.expires)) return no("created and expires are UTC times (2026-11-15T14:00:00Z)");
  const life = Date.parse(j.expires) - Date.parse(j.created);
  if (life < MIN_LIFE_MS || life > MAX_LIFE_MS) return no("a job lives between 15 minutes and 72 hours");
  if (!STATES.includes(j.state)) return no(`state is one of ${STATES.join(", ")}`);
  if (j.state === "claimed" ? !isIso(j.lease_until) : j.lease_until !== null) return no("lease_until is a time when claimed, and null otherwise");
  if (j.state === "pending" ? j.attempt !== null : j.state === "claimed" ? !(typeof j.attempt === "string" && ATTEMPT.test(j.attempt))
    : !(j.attempt === null || (typeof j.attempt === "string" && ATTEMPT.test(j.attempt)))) return no("attempt is the claim's id (a-xxxxxxxxxx), null while pending");
  if (typeof j.site !== "string" || !SITE.test(j.site)) return no("site is one host name, lower case (example.com)");
  if (typeof j.action !== "string" || !ACTION.test(j.action)) return no("action is one name in snake_case (read_account_settings)");
  if (!Object.hasOwn(READ_ACTIONS, j.action) && !Object.hasOwn(IRREVERSIBLE_ACTIONS, j.action))
    return no(`action is one of ${[...Object.keys(READ_ACTIONS), ...Object.keys(IRREVERSIBLE_ACTIONS)].join(", ")}`);
  if (!STEPS.includes(j.step)) return no(`step is one of ${STEPS.join(", ")}`);
  if (Object.hasOwn(READ_ACTIONS, j.action) !== (j.step === "read")) return no("a read-only action is a read step, and only a read-only action is");
  if (!plainOnSite(j.start_url, j.site)) return no("start_url is an https address on the job's site, with no query or fragment");
  if (!line(j.done_looks_like, 300)) return no("done_looks_like is one line, at most 300 characters");
  if (j.step === "confirm") {
    if (typeof j.follows !== "string" || !ID.test(j.follows)) return no("a confirm job names the preview job it follows");
    if (!seenOk(j.preview_seen)) return no("a confirm job carries what its preview saw: account, confirm_url, prompt_sha256");
    if (typeof j.owner_go !== "string" || !QUOTED.test(j.owner_go)) return no("a confirm job carries Dane's exact go, in quotes");
    if (typeof j.go_token !== "string" || !JOB_TOKEN.test(j.go_token)) return no("a confirm job carries a job token from his tap");
  } else if (j.follows !== null || j.preview_seen !== null || j.owner_go !== null || j.go_token !== null) {
    return no("only a confirm job has follows, preview_seen, owner_go and go_token");
  }
  return { ok: true, value: j as Job };
}

// A result file's text, checked for shape, its facts typed for the job's action.
export function parseResult(text: string, action?: string): Checked<Result> {
  if (text.length > 3_000) return no("a result file is at most 3000 bytes");
  let r: any;
  try { r = JSON.parse(text); } catch { return no("it isn't JSON"); }
  if (!isObj(r)) return no("it isn't a JSON object");
  if (!exact(r, RESULT_KEYS)) return no(`a result has exactly these fields: ${RESULT_KEYS.join(", ")}`);
  if (r.v !== 1) return no("v must be 1");
  if (typeof r.id !== "string" || !ID.test(r.id)) return no("id must look like j-YYYYMMDD-abc123");
  if (r.attempt !== null && !(typeof r.attempt === "string" && ATTEMPT.test(r.attempt))) return no("attempt is a claim's id or null");
  if (!STATUSES.includes(r.status)) return no(`status is one of ${STATUSES.join(", ")}`);
  if (!CODES.includes(r.code)) return no("code is one of the fixed reason codes");
  if (r.handoff !== null && !HANDOFFS.includes(r.handoff)) return no(`handoff is one of ${HANDOFFS.join(", ")}, or null`);
  if (!isIso(r.worker_clock)) return no("worker_clock is a UTC time");
  if (r.final_url !== null && (typeof r.final_url !== "string" || r.final_url.length > 300 || sanitizeUrl(r.final_url) !== r.final_url))
    return no("final_url is scheme, host and path only, or null");
  if (action !== undefined) {
    const f = checkFacts(action, r.facts);
    if (!f.ok) return f;
  } else if (!isObj(r.facts) || Object.keys(r.facts).length > MAX_FACTS) return no("facts is an object of named values");
  if (!Array.isArray(r.tools) || r.tools.length > 16 || !r.tools.every((t: unknown) => typeof t === "string" && TOOL.test(t)))
    return no("tools is a short list of tool names");
  if (typeof r.attended !== "boolean") return no("attended is true or false");
  if (r.handoff !== null && r.handoff !== r.code) return no("a hand-off's code is the hand-off");
  if (r.status === "done" && !["ok", "already_gone", "pending_email_confirmation"].includes(r.code)) return no("a done result's code is ok, already_gone or pending_email_confirmation");
  if (r.status !== "done" && ["ok", "already_gone"].includes(r.code)) return no("ok and already_gone count as done");
  return { ok: true, value: r as Result };
}

// Where a job goes once its result is in.
export function stateAfter(job: Job, r: Result): State {
  if (r.handoff === "needs_login" || r.handoff === "pending_email_confirmation" || r.handoff === "blocked_captcha") return "awaiting_owner";
  if (r.status === "in_doubt") return "in_doubt";
  if (r.status === "cancelled") return "cancelled";
  if (r.status !== "done") return "failed";
  if (job.step === "preview" && r.handoff !== "already_gone") return "awaiting_owner";   // waits on his go
  return "done";
}

// The JSON a file holds: fields in the fixed order, two-space indent, a final new line.
export function jobText(j: Job): string {
  return JSON.stringify(Object.fromEntries(JOB_KEYS.map((k) => [k, (j as any)[k]])), null, 2) + "\n";
}
export function resultText(r: Result): string {
  return JSON.stringify(Object.fromEntries(RESULT_KEYS.map((k) => [k, (r as any)[k]])), null, 2) + "\n";
}

const ABC = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomWord = (n: number, rand: () => number) => Array.from({ length: n }, () => ABC[Math.floor(rand() * ABC.length) % ABC.length]).join("");
// A new id: the day, and six random letters or digits.
export function newId(now: Date, rand: () => number = Math.random): string {
  return `j-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomWord(6, rand)}`;
}
export const newAttempt = (rand: () => number = Math.random) => `a-${randomWord(10, rand)}`;

// ---- Canonical bytes, for every signature ------------------------------------------
// Keys sorted, no white space, UTF-8: the same bytes whatever a file's layout or line
// endings, so a signature never rests on how a file happens to be written.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("only whole numbers are signed");
  return JSON.stringify(v);
}
export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// A key file: one key per line, "<key id> <base64 SPKI>", or a single bare key (the
// link's Ship key file), which gets the id "link-1".
export const KID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export function parseKeys(text: string): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const l of lines) {
    const parts = l.split(/\s+/);
    const [kid, b64] = parts.length === 1 ? ["link-1", parts[0]] : parts;
    if (parts.length > 2 || !KID.test(kid)) continue;
    try { out.set(kid, publicKey(b64)); } catch { /* not a key */ }
  }
  return out;
}

// ---- Job tokens: Dane's tap on an irreversible action, signed by the link ----------
// The link's Ed25519 key, the Ship token's signer, under its own prefix, so neither
// passes for the other: "job2.<claim>.<signature>". The signature covers "job2." and the
// claim's canonical bytes. The claim carries a key id (so this key can be rotated apart
// from the release key later), a single-use nonce, the preview it rests on, the site,
// action and a hash of what that preview saw, and an expiry.
export const JOB_PREFIX = "job2";
export const JOB_TTL_S = 2 * 3600;
export const JOB_TOKEN = /^job2\.[A-Za-z0-9_-]{20,900}\.[A-Za-z0-9_-]{86}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
export interface JobClaim { v: 1; kid: string; nonce: string; follows: string; site: string; action: string; seen_sha256: string; exp: number }

export const seenHash = (s: Seen) => sha256hex(canonical({ account: s.account, confirm_url: s.confirm_url, prompt_sha256: s.prompt_sha256 }));

// What a finished preview saw, from its result (null unless it reported all three).
export function seenOf(r: Result | null): Seen | null {
  if (!r) return null;
  const s = { account: r.facts.account, confirm_url: r.facts.confirm_url, prompt_sha256: r.facts.prompt_sha256 };
  return seenOk(s) ? s : null;
}

export function jobClaimFor(preview: Job, result: Result | null, nowMs: number, kid: string, nonce: string): JobClaim | null {
  const seen = seenOf(result);
  if (preview.step !== "preview" || preview.state !== "awaiting_owner" || !seen || !KID.test(kid) || !NONCE.test(nonce)) return null;
  return { v: 1, kid, nonce, follows: preview.id, site: preview.site, action: preview.action, seen_sha256: seenHash(seen),
    exp: Math.floor(nowMs / 1000) + JOB_TTL_S };
}

export function makeJobToken(claim: JobClaim, sign: (data: Buffer) => Buffer): string {
  const body = canonical(claim);
  return `${JOB_PREFIX}.${b64url(Buffer.from(body, "utf8"))}.${b64url(sign(Buffer.from(`${JOB_PREFIX}.${body}`, "utf8")))}`;
}

// The signer the link would use, from its private key.
export const signerOf = (key: KeyObject) => (data: Buffer) => edSign(null, data, key);

export function readJobToken(token: string, keys: Map<string, KeyObject>, nowMs: number): Checked<JobClaim> {
  if (!JOB_TOKEN.test(token)) return no("it isn't a job token");
  const [, payload, sigText] = token.split(".");
  let c: any;
  try { c = JSON.parse(unb64url(payload).toString("utf8")); } catch { return no("its claim can't be read"); }
  if (!isObj(c) || !exact(c, ["v", "kid", "nonce", "follows", "site", "action", "seen_sha256", "exp"]) || c.v !== 1
    || typeof c.kid !== "string" || !KID.test(c.kid) || typeof c.nonce !== "string" || !NONCE.test(c.nonce)
    || typeof c.follows !== "string" || !ID.test(c.follows) || typeof c.site !== "string" || !SITE.test(c.site)
    || typeof c.action !== "string" || !ACTION.test(c.action) || typeof c.seen_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.seen_sha256)
    || !Number.isSafeInteger(c.exp)) return no("its claim isn't a job approval");
  const key = keys.get(c.kid);
  if (!key) return no("its key id isn't one this side knows");
  const sig = unb64url(sigText);
  let good = false;
  try { good = sig.length === 64 && edVerify(null, Buffer.from(`${JOB_PREFIX}.${canonical(c)}`, "utf8"), key, sig); } catch { good = false; }
  if (!good) return no("its signature doesn't match the link's key");
  if (c.exp * 1000 <= nowMs) return no("it expired (a tap lasts 2 hours)");
  if (c.exp * 1000 > nowMs + JOB_TTL_S * 1000 + TOKEN_SKEW_MS) return no("its expiry is further off than a tap lasts");
  return { ok: true, value: c as JobClaim };
}

export { publicKey };

// A public key's fingerprint: the SHA-256 of its SPKI bytes, in hex. The owner pins his
// allowlist key's in the worker's install config at setup.
export const keyFingerprint = (k: KeyObject) => createHash("sha256").update(k.export({ format: "der", type: "spki" })).digest("hex");

// A confirm job against its token, the preview it follows and that preview's result.
// "" when it stands. jobs: every job in the queue; spent: nonces already recorded.
export function confirmWhy(job: Job, keys: Map<string, KeyObject>, jobs: Job[], resultOf: (id: string) => Result | null,
  spent: Set<string>, nowMs: number): string {
  if (job.step !== "confirm") return "";
  if (!keys.size) return "no public key here to check the job token with";
  const t = readJobToken(job.go_token ?? "", keys, nowMs);
  if (!t.ok) return `job token refused: ${t.why}`;
  if (t.value.follows !== job.follows || t.value.site !== job.site || t.value.action !== job.action)
    return "the job token is for another job, site or action";
  if (spent.has(t.value.nonce)) return "the job token was used already; a tap is spent once";
  const prev = jobs.find((x) => x.id === job.follows);
  if (!prev) return `the preview job ${job.follows} isn't in the queue`;
  if (prev.step !== "preview" || prev.site !== job.site || prev.action !== job.action)
    return `${job.follows} isn't a preview of this site and action`;
  if (prev.state !== "awaiting_owner") return `${job.follows} isn't waiting on Dane`;
  const seen = seenOf(resultOf(prev.id));
  if (!seen || !job.preview_seen || canonical(seen) !== canonical(job.preview_seen) || seenHash(seen) !== t.value.seen_sha256)
    return "what the confirm job says the preview saw isn't what the preview reported";
  // A new job (not in the queue yet) loses to any confirm already there; in the queue,
  // the earliest one stands.
  const inQueue = jobs.some((x) => x.id === job.id);
  const twin = jobs.find((x) => x.id !== job.id && x.step === "confirm" && x.follows === job.follows
    && (!inQueue || x.created < job.created || (x.created === job.created && x.id < job.id)));
  if (twin) return `${job.follows} already has a confirm job (${twin.id}); a tap is spent once`;
  return "";
}

// Right before a confirming click: the live page must be what the preview saw.
export function confirmGate(job: Job, live: unknown): Code | null {
  if (job.step !== "confirm" || !job.preview_seen) return "preview_mismatch";
  if (!seenOk(live)) return "preview_mismatch";
  return canonical(live) === canonical(job.preview_seen) ? null : "preview_mismatch";
}

// ---- The PC's allowlist, signed by Dane --------------------------------------------
// {"v": 1, "kid": "<his key id>", "allow": [{site, action, url, match, login_hosts?, login_paths?}], "sig": "<base64url>"}
// Each entry pins one read-only action on one site to an exact address or an address
// prefix (match "exact" or "prefix"). A real site sends a signed-out visitor to its
// sign-in page, often on another host (accounts.example.com) or path (/login): those
// listed in login_hosts (a host, or a host and everything under it with a leading ".")
// and login_paths (a path, or a path prefix ending in "*") count as needs_login, not as
// url_drift. The signature is his Ed25519 key's, over the canonical bytes of {v, kid,
// allow}; the worker checks it against owner.pub on the PC, and owner.pub against the
// fingerprint pinned in his install config.
export interface Allow { site: string; action: string; url: string; match: "exact" | "prefix"; login_hosts?: string[]; login_paths?: string[] }

export const allowBody = (kid: string, allow: Allow[]) => canonical({ v: 1, kid, allow });

export function signAllowlist(kid: string, allow: Allow[], sign: (data: Buffer) => Buffer): string {
  return JSON.stringify({ v: 1, kid, allow, sig: b64url(sign(Buffer.from(allowBody(kid, allow), "utf8"))) }, null, 2) + "\n";
}

const LOGIN_HOST = /^\.?(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const LOGIN_PATH = /^\/[A-Za-z0-9._~%\/-]{0,100}\*?$/;
const listOf = (x: unknown, re: RegExp) => x === undefined || (Array.isArray(x) && x.length <= 8 && x.every((v) => typeof v === "string" && re.test(v)));

function entriesOk(list: unknown): Checked<Allow[]> {
  if (!Array.isArray(list)) return no("allow is a list");
  const out: Allow[] = [];
  for (const e of list) {
    const keys = isObj(e) ? Object.keys(e) : [];
    if (!isObj(e) || !["site", "action", "url", "match"].every((k) => keys.includes(k))
      || keys.some((k) => !["site", "action", "url", "match", "login_hosts", "login_paths"].includes(k))
      || typeof e.site !== "string" || !SITE.test(e.site)
      || typeof e.action !== "string" || !Object.hasOwn(READ_ACTIONS, e.action) || !plainOnSite(e.url, e.site)
      || (e.match !== "exact" && e.match !== "prefix") || !listOf(e.login_hosts, LOGIN_HOST) || !listOf(e.login_paths, LOGIN_PATH))
      return no("each allowlist entry is {site, action (a read-only one), url (https, on the site, no query), match (exact or prefix), and optionally login_hosts and login_paths}");
    const a: Allow = { site: e.site, action: e.action, url: e.url, match: e.match };
    if (e.login_hosts !== undefined) a.login_hosts = e.login_hosts;
    if (e.login_paths !== undefined) a.login_paths = e.login_paths;
    out.push(a);
  }
  return { ok: true, value: out };
}

export function parseAllowlist(text: string, ownerKeys: Map<string, KeyObject>): Checked<Allow[]> {
  let a: any;
  try { a = JSON.parse(text); } catch { return no("the allowlist isn't JSON"); }
  if (!isObj(a) || !exact(a, ["v", "kid", "allow", "sig"]) || a.v !== 1 || typeof a.kid !== "string" || !KID.test(a.kid)
    || typeof a.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(a.sig)) return no('the allowlist is {"v": 1, "kid", "allow": [...], "sig"}');
  const e = entriesOk(a.allow);
  if (!e.ok) return e;
  const key = ownerKeys.get(a.kid);
  if (!key) return no("its key id isn't in owner.pub");
  let good = false;
  try { good = edVerify(null, Buffer.from(allowBody(a.kid, e.value), "utf8"), key, unb64url(a.sig)); } catch { good = false; }
  if (!good) return no("its signature doesn't match the owner's key");
  return e;
}

// An address as it is compared: scheme, host and path, the path in lower case and
// without a trailing slash (sites differ on both and mean the same page).
export function normalUrl(url: string): string {
  const s = sanitizeUrl(url);
  if (!s) return "";
  const u = new URL(s);
  let path = u.pathname.toLowerCase();
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `https://${u.hostname}${path === "/" ? "" : path}`;
}

// An address on an entry's pin.
export function onPin(url: string, a: Allow): boolean {
  const u = normalUrl(url), p = normalUrl(a.url);
  if (!u || !p) return false;
  if (a.match === "exact") return u === p;
  return u === p || u.startsWith(`${p}/`);
}

// An address on one of the entry's sign-in pages: needs_login, not url_drift.
export function onLogin(url: string, a: Allow): boolean {
  const s = sanitizeUrl(url);
  if (!s) return false;
  const u = new URL(s);
  const host = u.hostname;
  if ((a.login_hosts ?? []).some((h) => h.startsWith(".") ? host === h.slice(1) || host.endsWith(h) : host === h)) return true;
  if (!onSite(s, a.site)) return false;
  const path = normalUrl(s).slice(`https://${host}`.length) || "/";
  return (a.login_paths ?? []).some((p) => {
    const q = p.toLowerCase();
    return q.endsWith("*") ? path.startsWith(q.slice(0, -1)) : path === (q.length > 1 ? q.replace(/\/+$/, "") : q);
  });
}

export function pinFor(job: Job, list: Allow[]): Allow | null {
  return list.find((a) => a.site === job.site && a.action === job.action && onPin(job.start_url, a)) ?? null;
}

// ---- What Cain sends his keeper ----------------------------------------------------
// {site, action, step, start_url, done_looks_like, hours?, follows?, preview_seen?, owner_go?, go_token?}
// The keeper fills id, from, created, expires (hours, default 24), state, lease and attempt.
export const ASK_KEYS = ["site", "action", "step", "start_url", "done_looks_like", "hours", "follows", "preview_seen", "owner_go", "go_token"];

export function jobFromAsk(ask: any, now: Date, id: string): Checked<Job> {
  if (!isObj(ask)) return no("a job request is a JSON object");
  const extra = Object.keys(ask).filter((k) => !ASK_KEYS.includes(k));
  if (extra.length) return no(`a job request has only ${ASK_KEYS.join(", ")} (not ${extra.join(", ").slice(0, 80)})`);
  if (Array.isArray(ask.site) || (typeof ask.site === "string" && /[,\s]/.test(ask.site.trim())))
    return no("a job names one site; send a job per site");
  if (Array.isArray(ask.action)) return no("a job names one action; send a job per action");
  const hours = ask.hours ?? 24;
  if (typeof hours !== "number" || !Number.isFinite(hours)) return no("hours is a number");
  const job: Job = {
    v: 1, id, from: "cain", created: now.toISOString(), expires: new Date(now.getTime() + Math.round(hours * 3_600_000)).toISOString(),
    state: "pending", lease_until: null, attempt: null,
    site: typeof ask.site === "string" ? ask.site.trim().toLowerCase() : ask.site,
    action: ask.action, step: ask.step, start_url: ask.start_url, done_looks_like: ask.done_looks_like,
    follows: ask.follows ?? null, preview_seen: ask.preview_seen ?? null, owner_go: ask.owner_go ?? null, go_token: ask.go_token ?? null,
  };
  return parseJob(JSON.stringify(job));
}

// What a job's line in a listing says. Only fixed words and checked fields: a result is
// data, and its facts are shown as data, never acted on.
export function listLine(j: Job, r: Result | null): string {
  const tail = r ? ` | ${r.status} (${r.code})` : "";
  return `${j.id} | ${j.state} | ${j.step} ${j.action} on ${j.site} | expires ${j.expires}${tail}`;
}

// ---- The worker's heartbeat, as it lands in the queue repo -------------------------
// stale_lock: this run found a lock left by a run that died (or hung) and cleared it.
// skew_ms: how far the keeper's clock was seen ahead of the PC's (its newest commit or
// job time), or null when there was nothing to measure against.
export interface Heartbeat { v: 1; worker_clock: string; code: Code | "idle" | "stopped" | "busy" | "queue_misconfigured" | "git_failed";
  job: string | null; stale_lock: boolean; skew_ms: number | null }
export const HEARTBEAT_CODES = [...CODES, "idle", "stopped", "busy", "queue_misconfigured", "git_failed"];

// The queue's .gitattributes: every structured file it holds is text with LF line
// endings, so a Windows checkout never drifts to CRLF, and files stay mergeable.
// Signatures and hashes are over canonical bytes anyway.
export const QUEUE_ATTRIBUTES = "*.json text eol=lf\n*.md text eol=lf\n*.txt text eol=lf\n.gitattributes text eol=lf\n";
export const attributesLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
export const attributesGood = (text: string) => {
  const have = attributesLines(text);
  return attributesLines(QUEUE_ATTRIBUTES).every((l) => have.includes(l)) && !have.some((l) => /^\*\s/.test(l) && /-text|binary/.test(l));
};

export function parseHeartbeat(text: string): Heartbeat | null {
  try {
    const h = JSON.parse(text);
    if (!isObj(h) || !exact(h, ["v", "worker_clock", "code", "job", "stale_lock", "skew_ms"]) || h.v !== 1 || !isIso(h.worker_clock)
      || !HEARTBEAT_CODES.includes(h.code) || !(h.job === null || (typeof h.job === "string" && ID.test(h.job)))
      || typeof h.stale_lock !== "boolean" || !(h.skew_ms === null || Number.isSafeInteger(h.skew_ms))) return null;
    return h as Heartbeat;
  } catch { return null; }
}
