// The keeper of installs (Keeper 0.1.0, first review fixes 0.1.1, last review fixes 0.1.2): a check after
// every install of a watched App, and an automatic rollback of a bad one from the App-only backup taken
// just before it.
//
// Everything here is plain logic over injected parts (the Supervisor, the network, the clock and the
// store), so the tests drive it with fakes. main.ts wires the real ones. The keeper never writes its
// own options (0.1.2): it only reads them.
//
// The life of an attempt (one install of one App, registered by the Ship run through the keeper's
// options before it installs):
//   verifying    the registration was seen; its backup is being checked through the Supervisor
//   unprotected  the backup (or the registration) failed a check: nothing is ever restored for it
//   accepted     the backup holds that App alone at from_version: "accepting ..." is logged
//   watching     to_version was seen in the App's info: 15 minutes from then
//   restoring    a fail: marked before the restore starts, so the version change it causes is this
//                attempt's recovery and never a new attempt, across restarts. One restore call per
//                attempt unless the first provably never ran (0.1.2): a second call goes out only after
//                an explicit error answer to the first, or once the job named by the first answer's id
//                is seen ended with errors with the App not back at from_version
//   unresolved   the restore's outcome couldn't be established inside its limit: fenced (nothing is
//                sent again, ever), reconciled read only on every poll, and moved to rolled back or
//                gave up (one follow-up line to the owner) once the outcome is known
//   passed       the watch ended with every pass condition held
//   rolled back  the restore ran and from_version is started and healthy again
//   gave up      the restore failed, or the App didn't come back
//   never started  the install deadline passed without to_version ever seen (nothing restored)
import { createHash, timingSafeEqual } from "node:crypto";

export const PROTOCOL = 1;                       // the verdict protocol version, bound into the armed state
export const BACKUP_SCOPE = "app-only";          // the backup scope bound into the armed state
export const POLL_MS = 30_000;
export const WATCH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 60_000;              // the heartbeat time in /data, and /armed's timestamp
export const HC_HEARTBEAT_MS = 5 * 60_000;       // the ping to hc_done, and (0.1.2) the log ping to each alert check
export const VERIFY_MS = 2 * 60_000;             // how long a backup check may keep failing to answer
export const RESTORE_LIMIT_MS = 15 * 60_000;     // the restore's whole limit, busy retries included, from the fail
export const CONFIRM_MS = 5 * 60_000;            // after the restore: from_version started and healthy within this
export const REWIND_MS = 10 * 60_000;            // a heartbeat gap at start over this drops the drill records
export const ARMED_MAX_MS = 60 * 86_400_000;     // drill records last 60 days
export const DELIVERY_MS = 10 * 60_000;          // armed only while the heartbeat and each log ping were delivered within this
export const STUCK_FAIL_MS = 2 * 60_000;         // (0.1.2) a fail ping undelivered for longer than this disarms
export const RESTARTS_MAX = 2;                   // more stops than this after a restore, in the confirm window: gave up
export const MAX_DEADLINE_MS = 6 * 3_600_000;    // an install deadline at most 6 hours ahead
export const AUTH_MAX_MS = (2 * 3600 + 5 * 60) * 1000;   // (0.1.2) an authorization's expiry at most a Ship token's 2 hours (and 5 minutes of skew) ahead
export const DEFAULT_HEALTH_GRACE_S = 180;

// -- options --------------------------------------------------------------------------------------
export interface Registration {
  id: string; app: string; from_version: string; to_version: string; backup_slug: string;
  install_deadline: string; authorization: string; probe_hash: string;
}
export interface Options {
  watch: string[];
  health: Record<string, string>;                // slug -> "host:port" or "host:port/path" (no path: /health)
  tokens: Record<string, string>;                // slug -> token
  hc_done: string;
  hc_failed: Record<string, string>;             // (0.1.2) slug -> alert check URL; "*" for every App (a single URL)
  health_grace_s: number;
  attempt: Registration | null;                  // null: none registered (every field empty)
}
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const pairs = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const x of Array.isArray(v) ? v : []) {
    const t = s(x); const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
// hc_failed (0.1.2): a single URL (every App's alert check, as before), or per App: a map of slug to
// URL, or the option's list form, entries "slug=URL" and at most one plain URL (every other App).
export function parseAlerts(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const one = (t: string) => {
    const i = t.indexOf("=");
    const k = i > 0 ? t.slice(0, i).trim() : "";
    if (k && SLUG.test(k)) { const u = t.slice(i + 1).trim(); if (u) out[k] = u; }
    else if (t) out["*"] = t;
  };
  if (typeof v === "string") one(v.trim());
  else if (Array.isArray(v)) for (const x of v) one(s(x));
  else if (v && typeof v === "object") for (const [k, u] of Object.entries(v)) if ((SLUG.test(k) || k === "*") && s(u)) out[k] = s(u);
  return out;
}
export function parseOptions(raw: unknown): Options {
  const o: any = raw && typeof raw === "object" ? raw : {};
  const watch = (Array.isArray(o.watch) ? o.watch : []).map(s).filter((x: string) => SLUG.test(x));
  const a: any = o.attempt && typeof o.attempt === "object" ? o.attempt : {};
  const reg: Registration = {
    id: s(a.id), app: s(a.app), from_version: s(a.from_version), to_version: s(a.to_version), backup_slug: s(a.backup_slug),
    install_deadline: s(a.install_deadline), authorization: s(a.authorization), probe_hash: s(a.probe_hash),
  };
  const any = Object.values(reg).some((v) => v !== "");
  const grace = Number(o.health_grace_s);
  return {
    watch, health: pairs(o.health), tokens: pairs(o.tokens), hc_done: s(o.hc_done), hc_failed: parseAlerts(o.hc_failed),
    health_grace_s: Number.isFinite(grace) && grace >= 0 && grace <= 900 ? Math.floor(grace) : DEFAULT_HEALTH_GRACE_S,
    attempt: any ? reg : null,
  };
}
// The keeper's own settings: the tokens and the Healthchecks URLs. Kept in /data whenever the options
// carry them (0.1.2: and used at a start or a poll whose options lack them, so a wiped options file
// loses nothing); a new registration whose options lost or changed any of them is refused.
export interface Settings { tokens: Record<string, string>; hc_done: string; hc_failed: Record<string, string> }
export const settingsOf = (o: Options): Settings => ({ tokens: { ...o.tokens }, hc_done: o.hc_done, hc_failed: { ...o.hc_failed } });
export function settingsLost(kept: Settings, o: Options): string[] {
  const out: string[] = [];
  for (const [app, t] of Object.entries(kept.tokens)) if (o.tokens[app] !== t) out.push(`the token for ${app}`);
  if (kept.hc_done && o.hc_done !== kept.hc_done) out.push("hc_done");
  for (const [app, u] of Object.entries(kept.hc_failed)) if (o.hc_failed[app] !== u) out.push(app === "*" ? "hc_failed" : `hc_failed for ${app}`);
  return out;
}
// A registration's fields, hashed: a spent id seen again with other fields is a replay.
export function registrationHash(r: Registration): string {
  return sha(JSON.stringify([r.id, r.app, r.from_version, r.to_version, r.backup_slug, r.install_deadline, r.authorization, r.probe_hash])).slice(0, 16);
}
const sortedRec = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
// The effective options' hash: every option but the registration itself (which changes with every
// install), canonical, so an options change re-binds (and drops) the drill records.
export function optionsHash(o: Options): string {
  const canon = JSON.stringify({ watch: [...o.watch].sort(), health: sortedRec(o.health), tokens: sortedRec(o.tokens),
    hc_done: o.hc_done, hc_failed: sortedRec(o.hc_failed), health_grace_s: o.health_grace_s });
  return sha(canon).slice(0, 16);
}
export const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const HTTPS = /^https:\/\/\S+$/;

export const SLUG = /^[a-z0-9_]{1,64}$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const BACKUP = /^[A-Za-z0-9_-]{1,64}$/;
const PROBE_HASH = /^[0-9a-f]{12,64}$/;
// The authorization (0.1.2): never the owner's token, only what binds it.
//   "<ship|drill> sha256=<64 hex> pr=<number> head=<40 hex> expires=<ISO 8601 or epoch seconds>"
// sha256 is the SHA-256 of the owner's tap token (the Ship run computes it), pr and head the pull
// request and head commit the token was issued for, expires the token's own expiry. Each key once, in
// any order, nothing else. Anything else is no authorization.
export interface Authorization { kind: "ship" | "drill"; sha256: string; pr: number; head: string; expires: number }
export function parseAuthorization(a: string): Authorization | null {
  const parts = a.trim().split(/\s+/);
  if (parts.length !== 5 || (parts[0] !== "ship" && parts[0] !== "drill")) return null;
  const kv: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const m = /^(sha256|pr|head|expires)=(\S+)$/.exec(p);
    if (!m || m[1] in kv) return null;
    kv[m[1]] = m[2];
  }
  if (!/^[0-9a-f]{64}$/.test(kv.sha256 ?? "") || !/^[1-9]\d{0,8}$/.test(kv.pr ?? "") || !/^[0-9a-f]{40}$/.test(kv.head ?? "")) return null;
  const e = kv.expires ?? "";
  const expires = /^\d{10}$/.test(e) ? Number(e) * 1000 : /^\d{4}-\d{2}-\d{2}T/.test(e) ? Date.parse(e) : NaN;
  if (!Number.isFinite(expires)) return null;
  return { kind: parts[0] as "ship" | "drill", sha256: kv.sha256, pr: Number(kv.pr), head: kv.head, expires };
}
export const appName = (slug: string) => { const b = slug.replace(/^[0-9a-f]{8}_/, ""); return b ? b[0].toUpperCase() + b.slice(1) : slug; };

// -- state ----------------------------------------------------------------------------------------
export type Status = "verifying" | "unprotected" | "accepted" | "watching" | "restoring" | "passed" | "rolled back" | "gave up" | "never started" | "unresolved";
export const OPEN: Status[] = ["verifying", "accepted", "watching", "restoring"];
export type TriggerKind = "state-error" | "not-started" | "health" | "verdict" | "deadline" | "version-moved" | "watch-end";
export interface Attempt {
  id: string; app: string; from: string; to: string; backup: string; deadline: number;
  auth: "ship" | "drill"; authHash: string; pr: number; head: string; authExpires: number; probeHash: string;
  registeredAt: number; status: Status; why?: string;
  verifyUntil?: number;
  firstSeenTo?: number; firstStartedTo?: number; watchEnd?: number;
  notStarted: number; healthFails: number; startedEveryPoll: boolean;
  readySeen?: boolean;                           // (0.1.2) one 200 seen since the App's start: only then do failures count
  health: { at: number; ok: boolean }[];         // the last three health polls while started
  verdict?: { result: "PASS" | "FAIL"; reason: string; at: number };
  trigger?: { kind: TriggerKind; words: string; at: number };
  // The restore: inflight while a call is out and its answer not yet kept; job the job id from the
  // Supervisor's answer (the only job that ever counts); pending once an answer (or none) left the
  // outcome to reconcile; down once the App was seen not started after the call (0.1.2: the landed
  // sequence is down, then started at from_version); called once the restore is known to have landed.
  restore?: { tries: number; nextTry: number; limit: number; inflight: boolean; called: boolean; doneAt?: number; confirmUntil?: number; result?: string;
    job?: string | null; sentAt?: number; pending?: boolean; said?: string; lastState?: string; restarts?: number; down?: boolean; extended?: boolean };
  endedAt?: number; lineDelivered?: boolean; drillRecorded?: boolean;
}
export interface Binding { protocol: number; probe_hash: string; keeper_version: string; options_hash: string; backup_scope: string }
export interface DrillRec { attempt: string; kind: "fail-verdict" | "exits-on-start"; trigger: string; restoredAt: number; lineDeliveredAt: number; binding: Binding; at: number }
export interface LastLine { id: string; kind: string; line: string; at: number }
export interface QueueItem { key: string; to: "done" | "failed"; fail: boolean; body: string; app: string; attempt?: string; kind?: string; tries: number; next: number; at: number }
// A spent registration: its id, its fields' hash, its authorization's token hash (0.1.2), and the
// replays already reported.
export interface Spent { id: string; fields: string; auth: string; app: string; at: number; replays?: string[] }
export interface State {
  format: 1;
  heartbeat: number;                             // ms, written every minute
  lastSeen: Record<string, string>;              // slug -> version
  attempts: Record<string, Attempt>;
  seen: string[];                                // registration ids already taken (never taken twice)
  spent: Spent[];                                // the same, with each one's fields and token hash
  kept: Settings | null;                         // the tokens and Healthchecks URLs last carried by the options
  settingsHold: string;                          // a registration refused for changing them, while it stands in the options
  probeHash: Record<string, string>;             // slug -> the probe_hash of its newest registration
  outstanding: Record<string, boolean>;          // slug -> a fail ping delivered to its alert check, its success ping owed
  last: Record<string, LastLine>;
  drills: Record<string, Partial<Record<DrillRec["kind"], DrillRec>>>;
  queue: QueueItem[];
  hcPinged: number;
  hcDelivered: number;                           // the last heartbeat ping Healthchecks answered 2xx
  logPinged: Record<string, number>;             // (0.1.2) per alert check (its URL's hash): the last log ping tried
  logDelivered: Record<string, number>;          // (0.1.2) per alert check: the last log ping Healthchecks answered 2xx
  lines: number;                                 // a counter for line ids
}
export const emptyState = (): State => ({ format: 1, heartbeat: 0, lastSeen: {}, attempts: {}, seen: [], spent: [], kept: null, settingsHold: "",
  probeHash: {}, outstanding: {}, last: {}, drills: {}, queue: [], hcPinged: 0, hcDelivered: 0, logPinged: {}, logDelivered: {}, lines: 0 });
export function loadState(raw: unknown): State {
  const e = emptyState();
  if (!raw || typeof raw !== "object" || (raw as any).format !== 1) return e;
  const r = raw as any;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { ...e, heartbeat: Number(r.heartbeat) || 0, lastSeen: obj(r.lastSeen) as any, attempts: obj(r.attempts) as any,
    seen: Array.isArray(r.seen) ? r.seen.filter((x: unknown) => typeof x === "string").slice(-500) : [], probeHash: obj(r.probeHash) as any,
    outstanding: obj(r.outstanding) as any, last: obj(r.last) as any, drills: obj(r.drills) as any,
    queue: Array.isArray(r.queue) ? r.queue.map((q: any) => ({ ...q, at: Number(q?.at) || 0 })) : [], hcPinged: Number(r.hcPinged) || 0, lines: Number(r.lines) || 0,
    spent: Array.isArray(r.spent) ? r.spent.filter((x: any) => x && typeof x.id === "string").map((x: any) => ({ ...x, auth: s(x.auth), app: s(x.app) })).slice(-500) : [],
    kept: r.kept && typeof r.kept === "object" && r.kept.tokens && typeof r.kept.tokens === "object"
      ? { tokens: r.kept.tokens, hc_done: s(r.kept.hc_done), hc_failed: parseAlerts(r.kept.hc_failed) } : null,
    settingsHold: s(r.settingsHold), hcDelivered: Number(r.hcDelivered) || 0,
    logPinged: obj(r.logPinged) as any, logDelivered: obj(r.logDelivered) as any };
}

// -- the parts it is given ------------------------------------------------------------------------
export interface AppInfo { version: string; state: string }
export interface BackupInfo { homeassistant: unknown; addons: { slug: string; version: string }[]; folders: unknown[]; protected?: unknown }
// The restore call's answer: started (the Supervisor took it; its job id when it gave one), refused
// (the Supervisor answered an HTTP error: the request ended there, nothing executed), or unknown (no
// answer, or an answer that isn't one: it may be running).
export type RestoreResult =
  | { kind: "started"; job: string | null }
  | { kind: "refused"; retry: boolean; why: string }
  | { kind: "unknown"; why: string };
// A restore job, by its id, as the Supervisor's jobs list shows it: found or not (finished jobs leave
// the list after a while), done, and its errors.
export type JobState = { found: false } | { found: true; uuid: string; done: boolean; errors: number };
export interface Deps {
  now: () => number;
  version: string;                               // the keeper's own version
  self: string;                                  // the keeper's own slug
  appInfo: (slug: string) => Promise<AppInfo | null>;
  backupInfo: (slug: string) => Promise<BackupInfo | null>;
  restore: (backup: string, app: string) => Promise<RestoreResult>;
  job: (uuid: string) => Promise<JobState | null>;   // (0.1.2) by its id only; null: the jobs list can't be read
  health: (hostPort: string) => Promise<boolean>;    // the App's health address (Cain's: /ready)
  live: (hostPort: string) => Promise<boolean>;      // (0.1.2) the same host's /health (liveness)
  ping: (url: string, body: string) => Promise<boolean>;
  options: () => unknown | Promise<unknown>;      // the keeper's options, re-read each poll (null: unreadable)
  save: (s: State) => void;
  log: (line: string) => void;
}

// -- the keeper -----------------------------------------------------------------------------------
export class Keeper {
  st: State;
  opts: Options = parseOptions({});
  private appHealth: Record<string, boolean[]> = {};   // per App, the last three health polls (for clearing a fail)
  private appState: Record<string, string> = {};
  private armedSaid: Record<string, boolean> = {};     // per App, the armed state last logged
  private keptSaid = "";
  private busy = false;
  constructor(private d: Deps, saved: unknown) { this.st = loadState(saved); }

  save(): void { this.d.save(this.st); }
  private now(): number { return this.d.now(); }

  // The options in force: parsed, then guarded (the kept settings). main.ts calls it at the start with
  // /data/options.json; each poll calls it with the options the Supervisor holds.
  useOptions(raw: unknown): void { this.opts = this.guard(parseOptions(raw)); }

  // At start: the rewind check, then the open attempts resume (the first poll judges a deadline that
  // passed while the keeper was down).
  start(): void {
    const now = this.now();
    if (this.st.heartbeat && now - this.st.heartbeat > REWIND_MS) {
      const mins = Math.round((now - this.st.heartbeat) / 60_000);
      if (Object.keys(this.st.drills).length)
        this.d.log(`the keeper's heartbeat stopped for ${mins} minutes (a rewind, a restore or a long stop): the drill records are dropped`);
      this.st.drills = {};
    }
    for (const a of this.open()) this.d.log(`resuming ${a.id} ${a.app} (${a.status})`);
    for (const a of this.unresolvedOf()) this.d.log(`reconciling ${a.id} ${a.app} on every poll (unresolved: nothing is sent again)`);
    this.st.heartbeat = now;
    this.save();
  }
  open(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => OPEN.includes(a.status) && (!app || a.app === app)); }
  private unresolvedOf(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => a.status === "unresolved" && a.restore && (!app || a.app === app)); }
  binding(app: string): Binding {
    return { protocol: PROTOCOL, probe_hash: this.st.probeHash[app] ?? "", keeper_version: this.d.version, options_hash: optionsHash(this.opts), backup_scope: BACKUP_SCOPE };
  }
  // The alert check of an App (0.1.2): its own, else the one for every App. The keeper's own lines go
  // to the one for every App, else to the first watched App's.
  alertUrl(app: string): string {
    const m = this.opts.hc_failed;
    return m[app] ?? m["*"] ?? (app === this.d.self && this.opts.watch.length ? m[this.opts.watch[0]] ?? "" : "");
  }
  private alertUrls(): string[] { return [...new Set(Object.values(this.opts.hc_failed).filter((u) => HTTPS.test(u)))]; }
  // Armable: the heartbeat check and an alert check for every watched App set.
  armable(): boolean { return HTTPS.test(this.opts.hc_done) && this.opts.watch.length > 0 && this.opts.watch.every((a) => HTTPS.test(this.alertUrl(a))); }

  // One poll: options re-read, the registration taken, each watched App read, every open attempt judged.
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const raw = await Promise.resolve(this.d.options()).catch(() => null);
      if (raw !== null && raw !== undefined) this.useOptions(raw);
      else this.d.log("the keeper's options can't be read this poll: the last ones read stay in force");
      const now = this.now();
      if (this.opts.attempt) await this.register(this.opts.attempt);
      const apps = new Set([...this.opts.watch, ...this.open().map((a) => a.app), ...this.unresolvedOf().map((a) => a.app)]);
      for (const app of apps) await this.pollApp(app);
      await this.tickHeartbeat(now);
      this.arm();
      this.save();
      await this.flush();
      this.arm();
      this.save();
    } finally { this.busy = false; }
  }
  // The kept settings. A new registration whose options lost or changed a kept token or URL is refused
  // (register reads settingsHold) and the kept ones stay in force while it stands in the options.
  // Otherwise (0.1.2) options that lack the tokens, hc_done or hc_failed altogether get the kept ones,
  // with one line logged, and whatever the options carry is kept.
  private guard(o: Options): Options {
    const k = this.st.kept;
    const id = o.attempt?.id ?? "";
    const fresh = !!o.attempt && !this.spent(id);
    if (k && o.attempt && (this.st.settingsHold === id || (fresh && settingsLost(k, o).length))) {
      if (this.st.settingsHold !== id) {
        this.st.settingsHold = id;
        this.d.log(`the options with registration ${id || "(no id)"} lost or changed ${settingsLost(k, o).join(", ")}: the kept ones stay in force`);
      }
      return { ...o, tokens: { ...o.tokens, ...k.tokens }, hc_done: k.hc_done || o.hc_done, hc_failed: { ...o.hc_failed, ...k.hc_failed } };
    }
    if (this.st.settingsHold && this.st.settingsHold !== id) this.st.settingsHold = "";
    const filled: string[] = [];
    let out = o;
    if (k) {
      if (!Object.keys(o.tokens).length && Object.keys(k.tokens).length) { out = { ...out, tokens: { ...k.tokens } }; filled.push("tokens"); }
      if (!o.hc_done && k.hc_done) { out = { ...out, hc_done: k.hc_done }; filled.push("hc_done"); }
      if (!Object.keys(o.hc_failed).length && Object.keys(k.hc_failed).length) { out = { ...out, hc_failed: { ...k.hc_failed } }; filled.push("hc_failed"); }
    }
    const said = filled.join(", ");
    if (said && said !== this.keptSaid) this.d.log(`the options lack ${said}: the ones kept in /data are used`);
    this.keptSaid = said;
    this.st.kept = settingsOf(out);
    return out;
  }
  private spent(id: string): Spent | undefined { return this.st.spent.find((x) => x.id === id) ?? (this.st.seen.includes(id) ? { id, fields: "", auth: "", app: "", at: 0 } : undefined); }
  private spend(r: Registration, auth: string): Spent {
    const sp: Spent = { id: r.id, fields: registrationHash(r), auth, app: r.app, at: this.now() };
    this.st.spent.push(sp); if (this.st.spent.length > 500) this.st.spent.shift();
    this.st.seen.push(r.id); if (this.st.seen.length > 500) this.st.seen.shift();
    return sp;
  }

  // -- registration ---------------------------------------------------------------------------------
  // Each registration counts once. The identical record still standing in the options is the one
  // already taken: ignored silently. A replay (0.1.2): the same id with other fields, or the same token
  // hash under another id (for the same App: one Ship tap installs up to two Apps, one registration
  // each); refused once, reported once.
  private async register(r: Registration): Promise<void> {
    const sp = this.spent(r.id);
    if (sp) {
      const h = registrationHash(r);
      if (sp.fields === "" || sp.fields === h) {
        const a = this.st.attempts[r.id];
        if (a?.status === "verifying") await this.verify(a);
        return;
      }
      if (!(sp.replays ??= []).includes(h)) {
        sp.replays.push(h);
        const why = "a replay: that id was spent with other fields";
        this.d.log(`refusing ${r.id}: ${why}`);
        this.owner(SLUG.test(r.app) ? r.app : this.d.self, "unprotected", `Keeper refused a registration for ${SLUG.test(r.app) ? appName(r.app) : "an App"} (${r.id}): ${why}. Nothing will be rolled back for it.`, true);
        this.save();
      }
      return;
    }
    if (!ID.test(r.id)) { this.d.log(`refusing a registration with no usable id`); this.spend(r, ""); return; }
    const auth = parseAuthorization(r.authorization);
    const prior = auth ? this.st.spent.find((x) => x.auth === auth.sha256 && x.app === r.app) : undefined;
    this.spend(r, auth?.sha256 ?? "");
    const deadline = /^\d{10,13}$/.test(r.install_deadline) ? Number(r.install_deadline) * (r.install_deadline.length <= 10 ? 1000 : 1) : Date.parse(r.install_deadline);
    const now = this.now();
    const a: Attempt = {
      id: r.id, app: r.app, from: r.from_version, to: r.to_version, backup: r.backup_slug, deadline: Number.isFinite(deadline) ? deadline : 0,
      auth: auth?.kind ?? "ship", authHash: auth?.sha256 ?? "", pr: auth?.pr ?? 0, head: auth?.head ?? "", authExpires: auth?.expires ?? 0,
      probeHash: r.probe_hash, registeredAt: now, status: "verifying",
      notStarted: 0, healthFails: 0, startedEveryPoll: true, health: [], verifyUntil: now + VERIFY_MS,
    };
    const why = this.st.settingsHold === r.id ? "the registration changed the keeper's own settings"
      : prior ? `a replay: that authorization was spent under ${prior.id}`
      : !SLUG.test(r.app) ? "its app isn't an App slug"
      : r.app === this.d.self ? "the keeper doesn't watch its own install (it refuses to update itself while it watches)"
      : !this.opts.watch.includes(r.app) ? `${r.app} isn't in the keeper's watch list`
      : !VERSION.test(r.from_version) || !VERSION.test(r.to_version) ? "its versions aren't versions"
      : r.from_version === r.to_version ? "from_version and to_version are the same"
      : !BACKUP.test(r.backup_slug) ? "its backup_slug isn't a backup slug"
      : !Number.isFinite(deadline) ? "its install_deadline isn't a time"
      : deadline <= now ? "its install_deadline has passed"
      : deadline > now + MAX_DEADLINE_MS ? "its install_deadline is more than 6 hours away"
      : !auth ? "its authorization isn't \"ship\" or \"drill\" with the token's sha256, pr, head and expires"
      : auth.expires <= now ? "its authorization has expired"
      : auth.expires > now + AUTH_MAX_MS ? "its authorization's expiry is further off than a Ship token lasts"
      : !PROBE_HASH.test(r.probe_hash) ? "its probe_hash isn't a hash"
      : this.open(r.app).length ? `another attempt for ${r.app} is open (${this.open(r.app)[0].id})`
      : null;
    if (why) { if (!SLUG.test(a.app)) a.app = this.d.self; this.st.attempts[a.id] = a; this.unprotected(a, why); return; }
    this.st.attempts[a.id] = a;
    this.st.probeHash[a.app] = a.probeHash;
    await this.verify(a);
  }
  private async verify(a: Attempt): Promise<void> {
    const b = await this.d.backupInfo(a.backup).catch(() => null);
    if (!b) {
      if (this.now() >= (a.verifyUntil ?? 0)) this.unprotected(a, "the Supervisor didn't answer for its backup");
      return;
    }
    const addons = Array.isArray(b.addons) ? b.addons : [];
    const why = (b.homeassistant !== null && b.homeassistant !== false && b.homeassistant !== undefined && b.homeassistant !== "") ? "its backup holds Home Assistant"
      : addons.length !== 1 ? `its backup holds ${addons.length} Apps, not ${a.app} alone`
      : addons[0].slug !== a.app ? `its backup holds ${addons[0].slug}, not ${a.app}`
      : Array.isArray(b.folders) && b.folders.length ? "its backup holds folders"
      : addons[0].version !== a.from ? `its backup holds ${a.app} ${addons[0].version}, not ${a.from}`
      : b.protected !== false ? "its backup isn't shown as made without a password (protected false), and the keeper restores only such a backup"
      : null;
    if (why) { this.unprotected(a, why); return; }
    a.status = "accepted"; delete a.verifyUntil;
    this.d.log(`accepting ${a.id} ${a.app} ${a.from} to ${a.to} backup ${a.backup}`);
    this.save();
  }
  private unprotected(a: Attempt, why: string): void {
    a.status = "unprotected"; a.why = why; a.endedAt = this.now();
    this.d.log(`refusing ${a.id}: ${why}`);
    this.owner(a.app, "unprotected", `Keeper can't protect the install of ${appName(a.app)} ${a.to || "(no version)"}: ${why}. Nothing will be rolled back for it.`, true, a.id);
    this.save();
  }

  // -- the watch ------------------------------------------------------------------------------------
  private async pollApp(app: string): Promise<void> {
    const now = this.now();
    const info = await this.d.appInfo(app).catch(() => null);
    const hp = this.opts.health[app];
    const started = info?.state === "started";
    const ok = started && hp ? await this.d.health(hp).catch(() => false) : false;
    const h = (this.appHealth[app] ??= []);
    h.push(ok); if (h.length > 3) h.shift();
    if (info) this.appState[app] = info.state;
    if (info) this.versionChange(app, info.version);
    for (const a of this.open(app)) {
      if (a.status === "restoring") { this.observe(a, info); await this.restoring(a, info, ok); }
      else if (a.status === "accepted" || a.status === "watching") this.judge(a, info, ok, now);
    }
    for (const a of this.unresolvedOf(app)) { this.observe(a, info); await this.recheck(a, info); }
    this.clearOutstanding(app);
  }
  // A version change of a watched App: an attempt's install, an attempt's recovery, or unregistered.
  private versionChange(app: string, v: string): void {
    const was = this.st.lastSeen[app];
    if (was === undefined) { this.st.lastSeen[app] = v; return; }
    if (was === v) return;
    this.st.lastSeen[app] = v;
    const recent = Object.values(this.st.attempts).filter((a) => a.app === app && this.now() - a.registeredAt < 86_400_000);
    const covered = recent.some((a) => (a.to === v && !["never started", "unprotected"].includes(a.status)) || (a.from === v && ["restoring", "rolled back", "gave up", "unresolved"].includes(a.status)));
    if (covered) { this.d.log(`${app} is at ${v} (was ${was})`); return; }
    this.d.log(`unregistered change ${app} ${was} to ${v}: no attempt was registered for it, so nothing is restored`);
    this.owner(app, "unregistered change", `${appName(app)} changed from ${was} to ${v} with no install registered with Keeper. Nothing was rolled back.`, true);
  }
  judge(a: Attempt, info: AppInfo | null, healthOk: boolean, now: number): void {
    if (info && a.status === "accepted" && info.version === a.to) {
      a.status = "watching"; a.firstSeenTo = now; a.watchEnd = now + WATCH_MS;
      this.d.log(`watching ${a.id}: ${a.app} ${a.to} seen, 15 minutes from now`);
    }
    if (!a.firstStartedTo && now > a.deadline) {
      // 0.1.2: to_version never seen by the deadline (still the old version, another version, or the App
      // unreadable) is "install never started": nothing is restored for an install that isn't this one.
      if (!a.firstSeenTo) {
        a.status = "never started"; a.endedAt = now; a.why = "the install deadline passed without the registered version seen";
        this.d.log(`${a.id}: install never started (${a.app} at ${info?.version ?? "unknown"}, not ${a.to})`);
        this.owner(a.app, "install never started", `${appName(a.app)} ${a.to} never started before its install deadline. Nothing was rolled back.`, true, a.id);
        return;
      }
      return this.fail(a, "deadline", `the install deadline passed with ${a.to} never started`);
    }
    if (a.status !== "watching") return;
    if (!info) return;                                   // the Supervisor didn't answer: nothing judged this poll
    if (info.version !== a.to) return this.fail(a, "version-moved", `the App moved to ${info.version} during the watch`);
    if (info.state === "error") return this.fail(a, "state-error", "the App's state is error");
    if (info.state !== "started") {
      a.notStarted++;
      a.readySeen = false;
      if (a.firstStartedTo) a.startedEveryPoll = false;
      if (a.notStarted >= 2) return this.fail(a, "not-started", `the App wasn't started on two polls in a row (${info.state})`);
    } else {
      a.notStarted = 0;
      a.firstStartedTo ??= now;
      const graceOver = now - a.firstStartedTo >= this.opts.health_grace_s * 1000;
      a.health.push({ at: now, ok: healthOk }); if (a.health.length > 3) a.health.shift();
      if (healthOk) { a.healthFails = 0; a.readySeen = true; }
      // 0.1.2: failures count only once one 200 was seen since the App's start (and after the grace).
      else if (a.readySeen && graceOver && ++a.healthFails >= 3) return this.fail(a, "health", "its health address failed on three polls in a row");
    }
    if (a.verdict?.result === "FAIL") return this.fail(a, "verdict", `its probe said FAIL: ${a.verdict.reason}`);
    if (now >= (a.watchEnd ?? Infinity)) {
      const fresh = a.health.length === 3 && a.health.every((x) => x.ok && now - x.at <= 2 * POLL_MS + 15_000);
      const missing = [a.verdict?.result === "PASS" ? null : "no PASS verdict for this attempt",
        a.firstStartedTo && a.startedEveryPoll ? null : "not started on every poll since it first started",
        fresh ? null : "its health address wasn't 200 on the last three polls"].filter(Boolean);
      if (missing.length) return this.fail(a, "watch-end", `at the end of the watch: ${missing.join("; ")}`);
      a.status = "passed"; a.endedAt = now;
      this.d.log(`${a.id}: passed (${a.app} ${a.to})`);
      this.lastLine(a.app, "passed", `${appName(a.app)} ${a.to} passed Keeper's check after its install.`, a.id);
    }
  }
  // A fail: the trigger kept, the attempt marked restoring (saved) before any restore starts, and the
  // owner paged at once with a fail ping carrying the line.
  private fail(a: Attempt, kind: TriggerKind, words: string): void {
    const now = this.now();
    a.trigger = { kind, words, at: now };
    a.status = "restoring";
    a.restore = { tries: 0, nextTry: now, limit: now + RESTORE_LIMIT_MS, inflight: false, called: false, job: null };
    this.d.log(`${a.id}: fail (${words}); restoring ${a.app} from backup ${a.backup}`);
    this.owner(a.app, "rolling back", `Keeper is rolling back ${appName(a.app)} from ${a.to} to ${a.from}: ${words}.`, true, a.id);
    this.save();
  }

  // -- the restore ----------------------------------------------------------------------------------
  // The rules (0.1.2). The call is marked in flight (saved) before it is sent, and the job id from its
  // answer saved before anything else. A second call goes out only when the first provably never ran:
  //   (a) the Supervisor answered the first with an HTTP error (nothing executed), or
  //   (b) the job named by the first answer's id is seen ended with errors, and the App isn't back at
  //       from_version.
  // No answer, an answer with no job id, or a restart with a call in flight never authorizes a second
  // call, and no job but the one named by its id ever counts. "Landed" is the job by its id ended
  // without errors, or the App's own states seen after the call: not started, then started at
  // from_version (never version plus started alone). Anything else waits, and at the limit is
  // unresolved.
  private observe(a: Attempt, info: AppInfo | null): void {
    const r = a.restore;
    if (!r || r.called || !r.sentAt || !info) return;
    if (info.state !== "started" && !r.down) { r.down = true; this.save(); }
  }
  // The landed sequence: down after the call, then started at from_version, and no newer registration
  // for that App since (whose own install could make the same moves).
  private sequence(a: Attempt, info: AppInfo | null): boolean {
    const newer = Object.values(this.st.attempts).some((x) => x.app === a.app && x.id !== a.id && x.registeredAt > a.registeredAt && x.status !== "unprotected");
    return !newer && !!a.restore?.down && !!info && info.state === "started" && info.version === a.from;
  }
  private async restoring(a: Attempt, info: AppInfo | null, healthOk: boolean): Promise<void> {
    const r = a.restore!;
    const now = this.now();
    if (!r.called) {
      if (r.inflight || r.pending) return this.reconcile(a, info);
      if (now < r.nextTry) return;
      if (now >= r.limit) return this.gaveUp(a, "the Supervisor refused the restore until past its limit");
      r.inflight = true; r.tries++; r.sentAt = now; r.job = null; r.down = false; delete r.said;
      this.save();                                         // the in-flight mark, before the call
      const res: RestoreResult = await this.d.restore(a.backup, a.app).catch((e) => ({ kind: "unknown" as const, why: String((e as Error)?.message ?? e).slice(0, 120) }));
      const t = this.now();
      if (res.kind === "refused") { r.inflight = false; return this.again(a, res.retry, `the Supervisor refused the restore: ${res.why}`, t); }
      r.inflight = false; r.pending = true;
      if (res.kind === "started") {
        r.job = res.job;
        this.save();                                       // the job id, before anything else
        this.d.log(res.job ? `${a.id}: the restore of backup ${a.backup} (${a.app} alone) is running as job ${res.job}`
          : `${a.id}: the Supervisor took the restore of backup ${a.backup} but gave no job id: only ${a.app} seen stopping and coming back at ${a.from} can show it landed, and it is never sent again`);
        return;
      }
      this.d.log(`${a.id}: the restore call got no answer (${res.why}); it is never sent again unless the Supervisor shows it never ran`);
      this.save();
      return;
    }
    // The restore landed: from_version must be read started and healthy, and the App mustn't keep
    // restarting (started, then stopped or error, more than twice in the confirm window).
    if (info) {
      if (r.lastState === "started" && info.state !== "started") r.restarts = (r.restarts ?? 0) + 1;
      r.lastState = info.state;
      if ((r.restarts ?? 0) > RESTARTS_MAX) return this.gaveUp(a, `${a.app} keeps restarting after the restore (stopped ${r.restarts} times in its 5 minutes)`);
    }
    if (now < (r.confirmUntil ?? 0)) return;
    const back = !!info && info.version === a.from && info.state === "started";
    if (back && healthOk) {
      a.status = "rolled back"; a.endedAt = now; r.result = "ok";
      this.d.log(`${a.id}: rolled back (${a.app} ${a.from} started and healthy; trigger: ${a.trigger?.words})`);
      this.owner(a.app, "rolled back", `Keeper rolled back ${appName(a.app)} from ${a.to} to ${a.from}: ${a.trigger?.words ?? "a failed check"}. What the App wrote after the backup is gone.`, false, a.id);
      return;
    }
    // 0.1.2: started and alive (/health 200) but not ready (an upstream outage, such as Discord's): the
    // window is extended once by 5 minutes before deciding.
    const hp = this.opts.health[a.app];
    if (back && !r.extended && hp && await this.d.live(hp).catch(() => false)) {
      r.extended = true; r.confirmUntil = now + CONFIRM_MS;
      this.d.log(`${a.id}: ${a.app} ${a.from} is started and alive but not ready: the confirm window is extended once, by 5 minutes`);
      this.save();
      return;
    }
    return this.gaveUp(a, `${a.from} wasn't started and healthy ${r.extended ? 10 : 5} minutes after the restore`);
  }
  private landed(a: Attempt, t: number, words: string): void {
    const r = a.restore!;
    r.called = true; r.pending = false; r.inflight = false; r.doneAt = t; r.confirmUntil = t + CONFIRM_MS; r.restarts = 0; delete r.lastState; delete r.said;
    this.d.log(`${a.id}: ${words}; confirming ${a.from} comes back started and healthy for 5 minutes`);
    this.save();
  }
  // A restore that provably never ran: sent again inside the limit when it may succeed, else gave up.
  private again(a: Attempt, retry: boolean, why: string, t: number): void {
    const r = a.restore!;
    r.pending = false; r.job = null; delete r.said;
    if (retry && t + this.backoff(r.tries) < r.limit) {
      r.nextTry = t + this.backoff(r.tries);
      this.d.log(`${a.id}: ${why}; the restore is tried again in ${Math.round(this.backoff(r.tries) / 1000)} seconds`);
      this.save();
      return;
    }
    this.gaveUp(a, why);
  }
  private say(a: Attempt, words: string): void {
    const r = a.restore!;
    if (r.said === words) return;
    r.said = words; this.d.log(`${a.id}: ${words}`); this.save();
  }
  // What the Supervisor shows of the call's outcome: its job by id (undefined with no id), and the App.
  private async evidence(a: Attempt, info: AppInfo | null): Promise<{ j: JobState | null | undefined; seq: boolean; why: string }> {
    const r = a.restore!;
    const j = r.job ? await this.d.job(r.job).catch(() => null) : undefined;
    const seq = this.sequence(a, info);
    const why = j === undefined ? `the call left no job id and ${a.app} wasn't seen stopping and coming back at ${a.from}`
      : j === null ? "the Supervisor's jobs can't be read"
      : !j.found ? `its restore job ${r.job} isn't listed and ${a.app} wasn't seen stopping and coming back at ${a.from}`
      : !j.done ? `its restore job ${r.job} is still running`
      : `its restore job ${r.job} ended with ${j.errors} error${j.errors === 1 ? "" : "s"} and ${a.app} is ${info ? `at ${info.version} (${info.state})` : "unreadable"}`;
    return { j, seq, why };
  }
  private async reconcile(a: Attempt, info: AppInfo | null): Promise<void> {
    const r = a.restore!;
    const now = this.now();
    const { j, seq, why } = await this.evidence(a, info);
    if (j?.found && j.done && j.errors === 0) return this.landed(a, now, `the restore job ${j.uuid} finished`);
    if (seq) return this.landed(a, now, `${a.app} was seen stopping and coming back started at ${a.from}`);
    if (j?.found && j.done && info && info.version !== a.from)
      return this.again(a, true, `the restore job ${j.uuid} ended without restoring (${j.errors} error${j.errors === 1 ? "" : "s"}, ${a.app} at ${info.version})`, now);
    if (now >= r.limit) return this.unresolved(a, why);
    this.say(a, `the restore's outcome isn't known yet (${why}); nothing is sent again`);
  }
  // The outcome couldn't be established: fenced (nothing is sent again, across restarts and past the
  // limit), the owner hears it, and every poll reconciles it again, read only.
  private unresolved(a: Attempt, why: string): void {
    a.status = "unresolved"; a.endedAt = this.now(); a.why = why;
    if (a.restore) { a.restore.result = why; a.restore.inflight = false; a.restore.pending = true; a.restore.said = why; }
    this.d.log(`${a.id}: unresolved (${why}): nothing is restored again; every poll checks it again`);
    this.owner(a.app, "unresolved", `Keeper can't tell whether its rollback of ${appName(a.app)} ${a.to} to ${a.from} ran: ${why}. Nothing more is restored by itself; Keeper keeps checking and tells you once it knows. Check the App and its backups in Home Assistant (Settings, System, Backups).`, true, a.id);
    this.save();
  }
  // An unresolved attempt, on every poll: landed goes on to the confirm window (rolled back or gave up,
  // each with its line to the owner), the job by its id seen ended with errors and the App not back is
  // gave up; anything else stays unresolved, logged once per change.
  private async recheck(a: Attempt, info: AppInfo | null): Promise<void> {
    const now = this.now();
    const { j, seq, why } = await this.evidence(a, info);
    if ((j?.found && j.done && j.errors === 0) || seq) {
      a.status = "restoring"; delete a.endedAt;
      this.landed(a, now, j?.found && j.done && j.errors === 0 ? `the restore job ${j.uuid} finished (found after it was unresolved)` : `${a.app} was seen coming back at ${a.from} (after it was unresolved)`);
      return;
    }
    if (j?.found && j.done && info && info.version !== a.from) return this.gaveUp(a, `its restore job ${j.uuid} ended without restoring (found after it was unresolved)`);
    this.say(a, `still unresolved (${why}); nothing is sent again`);
  }
  backoff(tries: number): number { return Math.min(240_000, POLL_MS * 2 ** Math.max(0, tries - 1)); }
  private gaveUp(a: Attempt, why: string): void {
    a.status = "gave up"; a.endedAt = this.now(); a.why = why;
    if (a.restore) a.restore.result = why;
    this.d.log(`${a.id}: gave up (${why})`);
    this.owner(a.app, "gave up", `Keeper gave up on ${appName(a.app)} ${a.to}: ${why}. Restore its backup by hand in Home Assistant (Settings, System, Backups).`, true, a.id);
    this.save();
  }

  // -- verdicts -------------------------------------------------------------------------------------
  // The caller's App from its token, or null.
  appOfToken(token: string | null): string | null {
    if (!token) return null;
    for (const [app, t] of Object.entries(this.opts.tokens)) {
      if (t.length >= 16 && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))) return app;
    }
    return null;
  }
  openAttempt(app: string): Attempt | null { return this.open(app).find((a) => a.status === "accepted" || a.status === "watching") ?? null; }
  // A verdict: only for the open attempt of its App, at its to_version, with its own token.
  verdict(caller: string, body: any): { ok: boolean; why: string } {
    const app = s(body?.app), id = s(body?.attempt), version = s(body?.version), result = s(body?.result), reason = s(body?.reason).slice(0, 300);
    const a = this.openAttempt(app);
    const why = app !== caller ? "its app isn't the caller's"
      : !a ? `no open attempt for ${app}`
      : a.id !== id ? "it names another attempt"
      : a.to !== version ? `it names ${version}, not ${a.to}`
      : result !== "PASS" && result !== "FAIL" ? "its result isn't PASS or FAIL"
      : a.verdict ? "this attempt has its verdict already"
      : null;
    if (why) { this.d.log(`ignored a verdict from ${caller}: ${why}`); return { ok: false, why }; }
    a!.verdict = { result: result as "PASS" | "FAIL", reason, at: this.now() };
    this.d.log(`verdict for ${a!.id}: ${result}${reason ? ` (${reason})` : ""}`);
    if (result === "FAIL" && a!.status === "watching") this.fail(a!, "verdict", `its probe said FAIL: ${reason || "no reason given"}`);
    this.save();
    return { ok: true, why: "" };
  }

  // -- the owner hears ------------------------------------------------------------------------------
  private lastLine(app: string, kind: string, line: string, attempt?: string): LastLine {
    const l = { id: `${app}-${++this.st.lines}`, kind, line, at: this.now() };
    this.st.last[app] = l;
    return l;
  }
  // The owner's line: logged, kept as the App's last line, and queued as a Healthchecks ping to that
  // App's alert check: a fail ping for every alarm (a rollback starting included), a success ping
  // carrying the line once a rollback is confirmed. No owner line rides only on the heartbeat check.
  owner(app: string, kind: string, line: string, fail: boolean, attempt?: string): void {
    const l = this.lastLine(app, kind, line, attempt);
    this.d.log(`owner: ${line}`);
    if (!this.armable()) this.d.log("the Healthchecks URLs aren't all set, so that line may reach no one but this log (the keeper is not armable)");
    this.st.queue.push({ key: l.id, to: "failed", fail, body: line, app, attempt, kind, tries: 0, next: 0, at: this.now() });
  }
  // Every ping is retried until delivered. A success ping waits for any earlier fail ping of its App,
  // so the phone never sees them out of order; a delivered fail leaves a success owed, per App.
  async flush(): Promise<void> {
    const now = this.now();
    const keep: QueueItem[] = [];
    for (const q of this.st.queue) {
      const base = q.to === "done" ? this.opts.hc_done : this.alertUrl(q.app);
      const behind = !q.fail && keep.some((k) => k.app === q.app && k.fail && k.to === q.to);
      if (behind || now < q.next || !HTTPS.test(base)) { keep.push(q); continue; }
      const url = q.fail ? `${base.replace(/\/+$/, "")}/fail` : base;
      const ok = await this.d.ping(url, q.body).catch(() => false);
      if (ok) {
        if (q.fail && q.to === "failed") this.st.outstanding[q.app] = true;
        if (!q.fail && q.to === "failed") delete this.st.outstanding[q.app];
        if (q.kind === "rolled back" && q.attempt && this.st.attempts[q.attempt]) this.st.attempts[q.attempt].lineDelivered = true;
        if (q.attempt) this.autoDrill(q.attempt);
        continue;
      }
      q.tries++; q.next = now + Math.min(600_000, 30_000 * 2 ** Math.min(q.tries, 5));
      keep.push(q);
    }
    this.st.queue = keep;
  }
  // Once the condition clears (no open or unresolved attempt for the App, started, health 200 on the
  // last three polls), the owed success ping goes to that App's alert check, so the next event alerts again.
  private clearOutstanding(app: string): void {
    if (!this.st.outstanding[app]) return;
    if (this.open(app).length || this.unresolvedOf(app).length || this.appState[app] !== "started") return;
    const h = this.appHealth[app] ?? [];
    if (h.length < 3 || !h.every(Boolean)) return;
    if (this.st.queue.some((q) => q.app === app && q.to === "failed")) return;
    delete this.st.outstanding[app];
    this.st.queue.push({ key: `${app}-clear-${++this.st.lines}`, to: "failed", fail: false, body: `${appName(app)} is started and healthy again.`, app, tries: 0, next: 0, at: this.now() });
  }
  // The heartbeat: the time in /data every minute, a ping to hc_done every 5 minutes, and (0.1.2) a
  // non-paging log ping (the check's ping URL plus /log) to each alert check every 5 minutes; a failed
  // one is tried again a minute later. Each delivery's time is kept: /armed needs them.
  private async tickHeartbeat(now: number): Promise<void> {
    this.st.heartbeat = now;
    if (now - this.st.hcPinged >= HC_HEARTBEAT_MS && HTTPS.test(this.opts.hc_done)) {
      const ok = await this.d.ping(this.opts.hc_done, "keeper heartbeat").catch(() => false);
      if (ok) { this.st.hcPinged = now; this.st.hcDelivered = this.now(); }
      else { this.st.hcPinged = now - HC_HEARTBEAT_MS + 60_000; this.d.log("the heartbeat ping to hc_done wasn't delivered: tried again in a minute"); }
    }
    for (const u of this.alertUrls()) {
      const key = sha(u).slice(0, 16);
      if (now - (this.st.logPinged[key] ?? 0) < HC_HEARTBEAT_MS) continue;
      const ok = await this.d.ping(`${u.replace(/\/+$/, "")}/log`, "keeper alert path check").catch(() => false);
      if (ok) { this.st.logPinged[key] = now; this.st.logDelivered[key] = this.now(); }
      else { this.st.logPinged[key] = now - HC_HEARTBEAT_MS + 60_000; this.d.log("a log ping to an alert check wasn't delivered: tried again in a minute"); }
    }
  }
  heartbeat(): void { this.st.heartbeat = this.now(); this.save(); }
  delivered(now = this.now()): boolean { return this.st.hcDelivered > 0 && now - this.st.hcDelivered <= DELIVERY_MS; }

  // -- drills and arming ----------------------------------------------------------------------------
  // A drill record, only from the keeper's own result for one of its attempts: a drill attempt rolled
  // back by an actual restore of its registered backup, with its trigger and a delivered owner line.
  drillRecord(id: string): { ok: boolean; why: string } {
    const a = this.st.attempts[id];
    const kind: DrillRec["kind"] | null = a?.trigger?.kind === "verdict" ? "fail-verdict"
      : a?.trigger?.kind === "state-error" || a?.trigger?.kind === "not-started" ? "exits-on-start" : null;
    const why = !a ? "no such attempt"
      : a.auth !== "drill" ? "it wasn't a drill"
      : a.status !== "rolled back" ? `it ended ${a.status}, not rolled back`
      : !a.restore?.called || !a.restore.doneAt ? "no restore of its backup ran"
      : !kind ? `its trigger (${a.trigger?.kind ?? "none"}) is neither a FAIL verdict nor an exit on start`
      : !a.lineDelivered ? "its owner line wasn't delivered"
      : a.probeHash !== this.st.probeHash[a.app] ? "a newer registration changed the probe since"
      : null;
    if (why) return { ok: false, why };
    (this.st.drills[a!.app] ??= {})[kind!] = { attempt: a!.id, kind: kind!, trigger: a!.trigger!.words, restoredAt: a!.restore!.doneAt!,
      lineDeliveredAt: this.now(), binding: { ...this.binding(a!.app), probe_hash: a!.probeHash }, at: this.now() };
    a!.drillRecorded = true;
    this.d.log(`drill recorded for ${a!.app}: ${kind} (${a!.id})`);
    this.arm();
    this.save();
    return { ok: true, why: "" };
  }
  private autoDrill(id: string): void {
    const a = this.st.attempts[id];
    if (a && a.auth === "drill" && a.status === "rolled back" && !a.drillRecorded) {
      const r = this.drillRecord(id);
      if (!r.ok) this.d.log(`no drill record for ${id}: ${r.why}`);
    }
  }
  // The drill records are dropped on a binding change or after 60 days (and on the rewind at a start);
  // nothing else drops them. The armed state itself (0.1.2) is never stored: armedState computes it on
  // every read, and this only logs its changes.
  arm(): void {
    const now = this.now();
    for (const app of Object.keys(this.st.drills)) {
      const cur = this.binding(app);
      const d = this.st.drills[app] ?? {};
      for (const k of Object.keys(d) as DrillRec["kind"][]) {
        const rec = d[k]!;
        if (JSON.stringify(rec.binding) !== JSON.stringify(cur) || now - rec.at > ARMED_MAX_MS) {
          this.d.log(`the ${k} drill of ${app} no longer counts (${now - rec.at > ARMED_MAX_MS ? "older than 60 days" : "its binding changed"})`);
          delete d[k];
        }
      }
      if (!Object.keys(d).length) delete this.st.drills[app];
    }
    for (const app of new Set([...Object.keys(this.st.drills), ...Object.keys(this.armedSaid)])) {
      const v = this.armedState(app, now);
      if (v.armed !== !!this.armedSaid[app]) { this.d.log(v.armed ? `armed for ${app}` : `not armed for ${app}: ${v.why}`); }
      if (v.armed) this.armedSaid[app] = true; else delete this.armedSaid[app];
    }
  }
  // Armed (0.1.2), computed at every read, only while all five hold: the Healthchecks URLs are set (the
  // heartbeat and an alert check for every watched App); both drill records are valid under the current
  // binding; a heartbeat ping was delivered within 10 minutes; each alert check's log ping was delivered
  // within 10 minutes; and no fail ping has waited undelivered in the queue for more than 2 minutes.
  armedState(app: string, now = this.now()): { armed: boolean; why: string; at: number | null } {
    const cur = JSON.stringify(this.binding(app));
    const d = this.st.drills[app] ?? {};
    const valid = (["fail-verdict", "exits-on-start"] as const).map((k) => d[k]).filter((r) => r && JSON.stringify(r.binding) === cur && now - r.at <= ARMED_MAX_MS);
    const stale = this.alertUrls().filter((u) => { const t = this.st.logDelivered[sha(u).slice(0, 16)] ?? 0; return !t || now - t > DELIVERY_MS; });
    const stuck = this.st.queue.some((q) => q.fail && now - q.at > STUCK_FAIL_MS);
    const why = !this.armable() ? "the keeper is not armable: its Healthchecks URLs (hc_done, and an alert check for every watched App) aren't all set"
      : valid.length < 2 ? `no drills on record for ${app} under the current binding`
      : !this.delivered(now) ? "no heartbeat ping was delivered to Healthchecks in the last 10 minutes"
      : stale.length ? "an alert check's log ping wasn't delivered to Healthchecks in the last 10 minutes"
      : stuck ? "a fail ping has waited undelivered for more than 2 minutes"
      : "";
    return { armed: !why, why, at: valid.length === 2 ? Math.max(...valid.map((r) => r!.at)) : null };
  }
  armedView(app: string): { app: string; armed: boolean; why: string; armed_at: string | null; binding: Binding; keeper_version: string; at: string } {
    const v = this.armedState(app);
    return { app, armed: v.armed, why: v.why, armed_at: v.armed && v.at ? new Date(v.at).toISOString() : null, binding: this.binding(app),
      keeper_version: this.d.version, at: new Date(this.st.heartbeat || this.now()).toISOString() };
  }
}
