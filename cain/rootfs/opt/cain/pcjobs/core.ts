// The PC job queue: chores that need a browser signed in as Dane, which Cain can't do.
// Cain writes a job (through his keeper, pcjobs/main.ts); a scheduled task on Dane's PC
// runs it in a Chrome profile of its own and writes a result (pcjobs/worker.ts). Both
// live in a small private GitHub repo of their own (cain/docs/pc-jobs.md).
//
// This file is the format, and the checks both ends make. It needs only node:crypto and
// ../ship-token.ts, so it runs on the Pi (Bun) and on the PC (Bun, or Node 22.18 or
// later) alike.
//
// A job is jobs/<id>.json, a result is results/<id>.json: fixed fields, small, JSON.
// A job names one site and one action, and one step of it:
//   - read:    look and report (v1 runs only these);
//   - preview: go as far as the confirmation screen of an irreversible action and report
//              what it shows, clicking nothing that confirms;
//   - confirm: make the one confirming click. Only after a preview job of the same site
//              and action ended waiting on Dane, and only with his exact go (quoted) and
//              a job token the link signed from his fresh tap, checked on the PC.
// A result says what was seen, in a few named facts, never page text or dumps.
import { sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { b64url, publicKey } from "../ship-token.ts";

export const STATES = ["pending", "claimed", "awaiting_owner", "done", "failed"] as const;
export const STEPS = ["read", "preview", "confirm"] as const;
export const STATUSES = ["done", "failed", "refused", "expired"] as const;
export const HANDOFFS = ["pending_email_confirmation", "blocked_captcha", "outcome_unknown", "already_gone"] as const;
export type State = typeof STATES[number];
export type Step = typeof STEPS[number];
export type Status = typeof STATUSES[number];
export type Handoff = typeof HANDOFFS[number];

export const DEFAULT_REPO = "HyndeSyte/pc-jobs";
export const MIN_LIFE_MS = 15 * 60_000;          // a job lives at least this long
export const MAX_LIFE_MS = 72 * 3_600_000;       // and at most this long
export const LEASE_MS = 30 * 60_000;             // a claim lasts this long
export const MAX_FACTS = 8;
const SKEW_MS = 5 * 60_000;

export interface Job {
  v: 1;
  id: string;
  from: "cain";
  created: string;
  expires: string;
  state: State;
  lease_until: string | null;
  site: string;
  action: string;
  step: Step;
  start_url: string;
  done_looks_like: string;
  follows: string | null;      // confirm: the preview job it rests on
  owner_go: string | null;     // confirm: Dane's exact words, quoted
  go_token: string | null;     // confirm: job1.<claim>.<signature>
}

export interface Result {
  v: 1;
  id: string;
  status: Status;
  finished: string;
  final_url: string | null;
  facts: Record<string, string>;
  handoff: Handoff | null;
  reason: string | null;
}

export const JOB_KEYS = ["v", "id", "from", "created", "expires", "state", "lease_until", "site", "action", "step",
  "start_url", "done_looks_like", "follows", "owner_go", "go_token"];
export const RESULT_KEYS = ["v", "id", "status", "finished", "final_url", "facts", "handoff", "reason"];

export const ID = /^j-\d{8}-[a-z0-9]{6}$/;
const SITE = /^(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const ACTION = /^[a-z][a-z0-9_]{2,39}$/;
const FACT_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
// One line of plain words: no control characters, no new lines.
const LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;
// Dane's go, as he said it, inside quotes.
const QUOTED = /^(["\u201c])[^"\u201c\u201d]{1,298}["\u201d]$/;

const isIso = (s: unknown): s is string => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s));
const line = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max && LINE.test(s);
const exact = (o: any, keys: string[]) => {
  const have = Object.keys(o).sort().join(","), want = [...keys].sort().join(",");
  return have === want;
};

// The site a URL is on: its host is the site or under it, over https, with no login in it.
export function onSite(url: unknown, site: string): boolean {
  if (typeof url !== "string" || url.length > 500 || !LINE.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return h === site || h.endsWith(`.${site}`);
}

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string };
const no = (why: string): { ok: false; why: string } => ({ ok: false, why });

// A job file's text, checked for shape alone (what a job token says is checked apart).
export function parseJob(text: string): Checked<Job> {
  if (text.length > 4_000) return no("a job file is at most 4000 bytes");
  let j: any;
  try { j = JSON.parse(text); } catch { return no("it isn't JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return no("it isn't a JSON object");
  if (!exact(j, JOB_KEYS)) return no(`a job has exactly these fields: ${JOB_KEYS.join(", ")}`);
  if (j.v !== 1) return no("v must be 1");
  if (typeof j.id !== "string" || !ID.test(j.id)) return no("id must look like j-YYYYMMDD-abc123");
  if (j.from !== "cain") return no("only Cain's jobs are accepted");
  if (!isIso(j.created) || !isIso(j.expires)) return no("created and expires are UTC times (2026-11-15T14:00:00Z)");
  const life = Date.parse(j.expires) - Date.parse(j.created);
  if (life < MIN_LIFE_MS || life > MAX_LIFE_MS) return no("a job lives between 15 minutes and 72 hours");
  if (!STATES.includes(j.state)) return no(`state is one of ${STATES.join(", ")}`);
  if (j.state === "claimed" ? !isIso(j.lease_until) : j.lease_until !== null) return no("lease_until is a time when claimed, and null otherwise");
  if (typeof j.site !== "string" || !SITE.test(j.site)) return no("site is one host name, lower case (example.com)");
  if (typeof j.action !== "string" || !ACTION.test(j.action)) return no("action is one name in snake_case (read_account_settings)");
  if (!STEPS.includes(j.step)) return no(`step is one of ${STEPS.join(", ")}`);
  if (!onSite(j.start_url, j.site)) return no("start_url is an https address on the job's site");
  if (!line(j.done_looks_like, 300)) return no("done_looks_like is one line, at most 300 characters");
  if (j.step === "confirm") {
    if (typeof j.follows !== "string" || !ID.test(j.follows)) return no("a confirm job names the preview job it follows");
    if (typeof j.owner_go !== "string" || !QUOTED.test(j.owner_go)) return no("a confirm job carries Dane's exact go, in quotes");
    if (typeof j.go_token !== "string" || !JOB_TOKEN.test(j.go_token)) return no("a confirm job carries a job token from his tap");
  } else if (j.follows !== null || j.owner_go !== null || j.go_token !== null) {
    return no("only a confirm job has follows, owner_go and go_token");
  }
  return { ok: true, value: j as Job };
}

// A result file's text, checked for shape. No page text: facts are a few named values.
export function parseResult(text: string): Checked<Result> {
  if (text.length > 3_000) return no("a result file is at most 3000 bytes");
  let r: any;
  try { r = JSON.parse(text); } catch { return no("it isn't JSON"); }
  if (!r || typeof r !== "object" || Array.isArray(r)) return no("it isn't a JSON object");
  if (!exact(r, RESULT_KEYS)) return no(`a result has exactly these fields: ${RESULT_KEYS.join(", ")}`);
  if (r.v !== 1) return no("v must be 1");
  if (typeof r.id !== "string" || !ID.test(r.id)) return no("id must look like j-YYYYMMDD-abc123");
  if (!STATUSES.includes(r.status)) return no(`status is one of ${STATUSES.join(", ")}`);
  if (!isIso(r.finished)) return no("finished is a UTC time");
  if (r.final_url !== null && (typeof r.final_url !== "string" || r.final_url.length > 500 || !LINE.test(r.final_url) || !/^https:\/\//.test(r.final_url)))
    return no("final_url is an https address or null");
  if (!r.facts || typeof r.facts !== "object" || Array.isArray(r.facts)) return no("facts is an object of named values");
  const keys = Object.keys(r.facts);
  if (keys.length > MAX_FACTS) return no(`at most ${MAX_FACTS} facts`);
  for (const k of keys) {
    if (!FACT_KEY.test(k)) return no(`fact names are snake_case: ${k.slice(0, 40)}`);
    if (!line(r.facts[k], 120)) return no(`each fact is one line of at most 120 characters: ${k}`);
  }
  if (r.handoff !== null && !HANDOFFS.includes(r.handoff)) return no(`handoff is one of ${HANDOFFS.join(", ")}, or null`);
  if (r.reason !== null && !line(r.reason, 160)) return no("reason is one line of at most 160 characters, or null");
  if (r.status === "done" && r.handoff !== null && r.handoff !== "already_gone"
    && r.handoff !== "pending_email_confirmation") return no("a done result's handoff is already_gone, pending_email_confirmation or null");
  if (r.status !== "done" && r.handoff === "already_gone") return no("already_gone counts as done");
  return { ok: true, value: r as Result };
}

// Where a job goes once its result is in.
export function stateAfter(job: Job, r: Result): State {
  if (r.handoff === "pending_email_confirmation" || r.handoff === "blocked_captcha") return "awaiting_owner";
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

// A new id: the day, and six random letters or digits.
export function newId(now: Date, rand: () => number = Math.random): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += abc[Math.floor(rand() * abc.length) % abc.length];
  return `j-${day}-${s}`;
}

// ---- Job tokens: Dane's tap on an irreversible action, signed by the link ----------
// The same Ed25519 key and token shape as a Ship approval (../ship-token.ts), under its
// own prefix, so neither passes for the other: "job1.<claim>.<signature>". The claim
// names the preview job the confirm rests on, its site and action, and an expiry.

export const JOB_PREFIX = "job1";
export const JOB_TTL_S = 2 * 3600;
export const JOB_TOKEN = /^job1\.[A-Za-z0-9_-]{20,600}\.[A-Za-z0-9_-]{86}$/;
export interface JobClaim { v: 1; follows: string; site: string; action: string; exp: number }

export function jobClaimFor(preview: Job, nowMs: number): JobClaim | null {
  if (preview.step !== "preview" || preview.state !== "awaiting_owner") return null;
  return { v: 1, follows: preview.id, site: preview.site, action: preview.action, exp: Math.floor(nowMs / 1000) + JOB_TTL_S };
}

export function makeJobToken(claim: JobClaim, sign: (data: Buffer) => Buffer): string {
  const payload = b64url(Buffer.from(JSON.stringify(claim), "utf8"));
  return `${JOB_PREFIX}.${payload}.${b64url(sign(Buffer.from(`${JOB_PREFIX}.${payload}`, "utf8")))}`;
}

// The signer the link would use, from its private key.
export const signerOf = (key: KeyObject) => (data: Buffer) => edSign(null, data, key);

const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function readJobToken(token: string, key: KeyObject, nowMs: number): Checked<JobClaim> {
  if (!JOB_TOKEN.test(token)) return no("it isn't a job token");
  const [, payload, sigText] = token.split(".");
  const sig = unb64url(sigText);
  let good = false;
  try { good = sig.length === 64 && edVerify(null, Buffer.from(`${JOB_PREFIX}.${payload}`, "utf8"), key, sig); } catch { good = false; }
  if (!good) return no("its signature doesn't match the link's key");
  let c: any;
  try { c = JSON.parse(unb64url(payload).toString("utf8")); } catch { return no("its claim can't be read"); }
  if (!c || c.v !== 1 || typeof c.follows !== "string" || !ID.test(c.follows) || typeof c.site !== "string" || !SITE.test(c.site)
    || typeof c.action !== "string" || !ACTION.test(c.action) || !Number.isSafeInteger(c.exp)) return no("its claim isn't a job approval");
  if (c.exp * 1000 <= nowMs) return no("it expired (a tap lasts 2 hours)");
  if (c.exp * 1000 > nowMs + JOB_TTL_S * 1000 + SKEW_MS) return no("its expiry is further off than a tap lasts");
  return { ok: true, value: { v: 1, follows: c.follows, site: c.site, action: c.action, exp: c.exp } };
}

export { publicKey };

// A confirm job against its token and the preview it follows. "" when it stands.
// others: every job in the queue, so a token is spent once.
export function confirmWhy(job: Job, key: KeyObject | null, jobs: Job[], nowMs: number): string {
  if (job.step !== "confirm") return "";
  if (!key) return "no public key here to check the job token with";
  const t = readJobToken(job.go_token ?? "", key, nowMs);
  if (!t.ok) return `job token refused: ${t.why}`;
  if (t.value.follows !== job.follows || t.value.site !== job.site || t.value.action !== job.action)
    return "the job token is for another job, site or action";
  const prev = jobs.find((x) => x.id === job.follows);
  if (!prev) return `the preview job ${job.follows} isn't in the queue`;
  if (prev.step !== "preview" || prev.site !== job.site || prev.action !== job.action)
    return `${job.follows} isn't a preview of this site and action`;
  if (prev.state !== "awaiting_owner") return `${job.follows} isn't waiting on Dane`;
  // A new job (not in the queue yet) loses to any confirm already there; in the queue,
  // the earliest one stands.
  const inQueue = jobs.some((x) => x.id === job.id);
  const twin = jobs.find((x) => x.id !== job.id && x.step === "confirm" && x.follows === job.follows
    && (!inQueue || x.created < job.created || (x.created === job.created && x.id < job.id)));
  if (twin) return `${job.follows} already has a confirm job (${twin.id}); a tap is spent once`;
  return "";
}

// ---- The PC's allowlist: which site and action, at which steps, Dane allows ---------
export interface Allow { site: string; action: string; steps: Step[] }

export function parseAllowlist(text: string): Checked<Allow[]> {
  let a: any;
  try { a = JSON.parse(text); } catch { return no("the allowlist isn't JSON"); }
  if (!a || a.v !== 1 || !Array.isArray(a.allow)) return no('the allowlist is {"v": 1, "allow": [...]}');
  const out: Allow[] = [];
  for (const e of a.allow) {
    if (!e || typeof e.site !== "string" || !SITE.test(e.site) || typeof e.action !== "string" || !ACTION.test(e.action)
      || !Array.isArray(e.steps) || e.steps.length === 0 || !e.steps.every((s: any) => STEPS.includes(s)))
      return no("each allowlist entry is {site, action, steps}");
    out.push({ site: e.site, action: e.action, steps: e.steps });
  }
  return { ok: true, value: out };
}

export function allowed(job: Job, list: Allow[]): boolean {
  return list.some((a) => a.site === job.site && a.action === job.action && a.steps.includes(job.step));
}

// ---- What Cain sends his keeper ----------------------------------------------------
// {site, action, step, start_url, done_looks_like, hours?, follows?, owner_go?, go_token?}
// The keeper fills id, from, created, expires (hours, default 24), state and lease.
export const ASK_KEYS = ["site", "action", "step", "start_url", "done_looks_like", "hours", "follows", "owner_go", "go_token"];

export function jobFromAsk(ask: any, now: Date, id: string): Checked<Job> {
  if (!ask || typeof ask !== "object" || Array.isArray(ask)) return no("a job request is a JSON object");
  const extra = Object.keys(ask).filter((k) => !ASK_KEYS.includes(k));
  if (extra.length) return no(`a job request has only ${ASK_KEYS.join(", ")} (not ${extra.join(", ").slice(0, 80)})`);
  if (Array.isArray(ask.site) || (typeof ask.site === "string" && /[,\s]/.test(ask.site.trim())))
    return no("a job names one site; send a job per site");
  if (Array.isArray(ask.action)) return no("a job names one action; send a job per action");
  const hours = ask.hours ?? 24;
  if (typeof hours !== "number" || !Number.isFinite(hours)) return no("hours is a number");
  const job: Job = {
    v: 1, id, from: "cain", created: now.toISOString(), expires: new Date(now.getTime() + Math.round(hours * 3_600_000)).toISOString(),
    state: "pending", lease_until: null,
    site: typeof ask.site === "string" ? ask.site.trim().toLowerCase() : ask.site,
    action: ask.action, step: ask.step, start_url: ask.start_url, done_looks_like: ask.done_looks_like,
    follows: ask.follows ?? null, owner_go: ask.owner_go ?? null, go_token: ask.go_token ?? null,
  };
  return parseJob(JSON.stringify(job));
}

// What a job's line in a listing says.
export function listLine(j: Job, r: Result | null): string {
  const tail = r ? ` | ${r.status}${r.handoff ? ` (${r.handoff})` : ""}` : "";
  return `${j.id} | ${j.state} | ${j.step} ${j.action} on ${j.site} | expires ${j.expires}${tail}`;
}
