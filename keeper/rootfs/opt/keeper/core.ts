// The keeper of installs (Keeper 0.1.0): a check after every install of a watched App, and an
// automatic rollback of a bad one from the App-only backup taken just before it.
//
// Everything here is plain logic over injected parts (the Supervisor, the network, the clock and the
// store), so the tests drive it with fakes. main.ts wires the real ones.
//
// The life of an attempt (one install of one App, registered by the Ship run through the keeper's
// options before it installs):
//   verifying    the registration was seen; its backup is being checked through the Supervisor
//   unprotected  the backup (or the registration) failed a check: nothing is ever restored for it
//   accepted     the backup holds that App alone at from_version: "accepting ..." is logged
//   watching     to_version was seen in the App's info: 15 minutes from then
//   restoring    a fail: marked before the restore starts, so the version change it causes is this
//                attempt's recovery and never a new attempt, across restarts
//   passed       the watch ended with every pass condition held
//   rolled back  the restore ran and from_version is started and healthy again
//   gave up      the restore failed, or the App didn't come back
//   never started  the install deadline passed with the App still at from_version (nothing restored)
import { createHash, timingSafeEqual } from "node:crypto";

export const PROTOCOL = 1;                       // the verdict protocol version, bound into the armed record
export const BACKUP_SCOPE = "app-only";          // the backup scope bound into the armed record
export const POLL_MS = 30_000;
export const WATCH_MS = 15 * 60_000;
export const HEARTBEAT_MS = 60_000;              // the heartbeat time in /data, and the armed record's timestamp
export const HC_HEARTBEAT_MS = 5 * 60_000;       // the ping to hc_done
export const VERIFY_MS = 2 * 60_000;             // how long a backup check may keep failing to answer
export const RESTORE_LIMIT_MS = 15 * 60_000;     // the restore's whole limit, busy retries included, from the fail
export const CONFIRM_MS = 5 * 60_000;            // after the restore: from_version started and healthy within this
export const REWIND_MS = 10 * 60_000;            // a heartbeat gap at start over this drops the armed state
export const ARMED_MAX_MS = 60 * 86_400_000;     // armed and drill records last 60 days
export const MAX_DEADLINE_MS = 6 * 3_600_000;    // an install deadline at most 6 hours ahead
export const DEFAULT_HEALTH_GRACE_S = 180;

// -- options --------------------------------------------------------------------------------------
export interface Registration {
  id: string; app: string; from_version: string; to_version: string; backup_slug: string;
  install_deadline: string; authorization: string; probe_hash: string;
}
export interface Options {
  watch: string[];
  health: Record<string, string>;                // slug -> "host:port"
  tokens: Record<string, string>;                // slug -> token
  hc_done: string; hc_failed: string;
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
    watch, health: pairs(o.health), tokens: pairs(o.tokens), hc_done: s(o.hc_done), hc_failed: s(o.hc_failed),
    health_grace_s: Number.isFinite(grace) && grace >= 0 && grace <= 900 ? Math.floor(grace) : DEFAULT_HEALTH_GRACE_S,
    attempt: any ? reg : null,
  };
}
// The effective options' hash: every option but the registration itself (which changes with every
// install), canonical, so an options change re-binds (and drops) the armed record.
export function optionsHash(o: Options): string {
  const sorted = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
  const canon = JSON.stringify({ watch: [...o.watch].sort(), health: sorted(o.health), tokens: sorted(o.tokens),
    hc_done: o.hc_done, hc_failed: o.hc_failed, health_grace_s: o.health_grace_s });
  return sha(canon).slice(0, 16);
}
export const sha = (t: string) => createHash("sha256").update(t).digest("hex");
export const hcArmable = (o: Options) => /^https:\/\/\S+$/.test(o.hc_done) && /^https:\/\/\S+$/.test(o.hc_failed);

export const SLUG = /^[a-z0-9_]{1,64}$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const BACKUP = /^[A-Za-z0-9_-]{1,64}$/;
const PROBE_HASH = /^[0-9a-f]{12,64}$/;
// "ship" (an ordinary install, or a ship-with-risk tap: the token after it), or "drill <token>".
export function parseAuthorization(a: string): { kind: "ship" | "drill"; tokenHash: string | null } | null {
  const m = /^(ship|drill)(?:[ :]+(\S{8,4096}))?$/.exec(a.trim());
  if (!m) return null;
  if (m[1] === "drill" && !m[2]) return null;
  return { kind: m[1] as "ship" | "drill", tokenHash: m[2] ? sha(m[2]).slice(0, 16) : null };
}
export const appName = (slug: string) => { const b = slug.replace(/^[0-9a-f]{8}_/, ""); return b ? b[0].toUpperCase() + b.slice(1) : slug; };

// -- state ----------------------------------------------------------------------------------------
export type Status = "verifying" | "unprotected" | "accepted" | "watching" | "restoring" | "passed" | "rolled back" | "gave up" | "never started";
export const OPEN: Status[] = ["verifying", "accepted", "watching", "restoring"];
export type TriggerKind = "state-error" | "not-started" | "health" | "verdict" | "deadline" | "version-moved" | "watch-end";
export interface Attempt {
  id: string; app: string; from: string; to: string; backup: string; deadline: number;
  auth: "ship" | "drill"; tokenHash: string | null; probeHash: string;
  registeredAt: number; status: Status; why?: string;
  verifyUntil?: number;
  firstSeenTo?: number; firstStartedTo?: number; watchEnd?: number;
  notStarted: number; healthFails: number; startedEveryPoll: boolean;
  health: { at: number; ok: boolean }[];         // the last three health polls while started
  verdict?: { result: "PASS" | "FAIL"; reason: string; at: number };
  trigger?: { kind: TriggerKind; words: string; at: number };
  restore?: { tries: number; nextTry: number; limit: number; inflight: boolean; called: boolean; doneAt?: number; confirmUntil?: number; result?: string };
  endedAt?: number; lineDelivered?: boolean; drillRecorded?: boolean;
}
export interface Binding { protocol: number; probe_hash: string; keeper_version: string; options_hash: string; backup_scope: string }
export interface DrillRec { attempt: string; kind: "fail-verdict" | "exits-on-start"; trigger: string; restoredAt: number; lineDeliveredAt: number; binding: Binding; at: number }
export interface LastLine { id: string; kind: string; line: string; at: number }
export interface QueueItem { key: string; to: "done" | "failed"; fail: boolean; body: string; app: string; attempt?: string; tries: number; next: number }
export interface State {
  format: 1;
  heartbeat: number;                             // ms, written every minute
  lastSeen: Record<string, string>;              // slug -> version
  attempts: Record<string, Attempt>;
  seen: string[];                                // registration ids already taken (never taken twice)
  probeHash: Record<string, string>;             // slug -> the probe_hash of its newest registration
  outstanding: Record<string, boolean>;          // slug -> a fail ping delivered, its success ping owed
  last: Record<string, LastLine>;
  drills: Record<string, Partial<Record<DrillRec["kind"], DrillRec>>>;
  armed: Record<string, { at: number; binding: Binding }>;
  queue: QueueItem[];
  hcPinged: number;
  lines: number;                                 // a counter for line ids
}
export const emptyState = (): State => ({ format: 1, heartbeat: 0, lastSeen: {}, attempts: {}, seen: [], probeHash: {}, outstanding: {},
  last: {}, drills: {}, armed: {}, queue: [], hcPinged: 0, lines: 0 });
export function loadState(raw: unknown): State {
  const e = emptyState();
  if (!raw || typeof raw !== "object" || (raw as any).format !== 1) return e;
  const r = raw as any;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { ...e, heartbeat: Number(r.heartbeat) || 0, lastSeen: obj(r.lastSeen) as any, attempts: obj(r.attempts) as any,
    seen: Array.isArray(r.seen) ? r.seen.filter((x: unknown) => typeof x === "string").slice(-500) : [], probeHash: obj(r.probeHash) as any,
    outstanding: obj(r.outstanding) as any, last: obj(r.last) as any, drills: obj(r.drills) as any, armed: obj(r.armed) as any,
    queue: Array.isArray(r.queue) ? r.queue : [], hcPinged: Number(r.hcPinged) || 0, lines: Number(r.lines) || 0 };
}

// -- the parts it is given ------------------------------------------------------------------------
export interface AppInfo { version: string; state: string }
export interface BackupInfo { homeassistant: unknown; addons: { slug: string; version: string }[]; folders: unknown[] }
export type RestoreResult = { ok: true } | { ok: false; retry: boolean; why: string };
export interface Deps {
  now: () => number;
  version: string;                               // the keeper's own version
  self: string;                                  // the keeper's own slug
  appInfo: (slug: string) => Promise<AppInfo | null>;
  backupInfo: (slug: string) => Promise<BackupInfo | null>;
  restore: (backup: string, app: string) => Promise<RestoreResult>;
  health: (hostPort: string) => Promise<boolean>;
  ping: (url: string, body: string) => Promise<boolean>;
  options: () => unknown;                        // /data/options.json, re-read each poll (null: unreadable)
  save: (s: State) => void;
  log: (line: string) => void;
}

// -- the keeper -----------------------------------------------------------------------------------
export class Keeper {
  st: State;
  opts: Options = parseOptions({});
  private appHealth: Record<string, boolean[]> = {};   // per App, the last three health polls (for clearing a fail)
  private appState: Record<string, string> = {};
  private busy = false;
  constructor(private d: Deps, saved: unknown) { this.st = loadState(saved); }

  save(): void { this.d.save(this.st); }
  private now(): number { return this.d.now(); }

  // At start: the rewind check, then the open attempts resume (the first poll judges a deadline that
  // passed while the keeper was down).
  start(): void {
    const now = this.now();
    if (this.st.heartbeat && now - this.st.heartbeat > REWIND_MS) {
      const mins = Math.round((now - this.st.heartbeat) / 60_000);
      if (Object.keys(this.st.armed).length || Object.keys(this.st.drills).length)
        this.d.log(`the keeper's heartbeat stopped for ${mins} minutes (a rewind, a restore or a long stop): the armed state and drill records are dropped`);
      this.st.armed = {}; this.st.drills = {};
    }
    for (const a of this.open()) this.d.log(`resuming ${a.id} ${a.app} (${a.status})`);
    this.st.heartbeat = now;
    this.save();
  }
  open(app?: string): Attempt[] { return Object.values(this.st.attempts).filter((a) => OPEN.includes(a.status) && (!app || a.app === app)); }
  binding(app: string): Binding {
    return { protocol: PROTOCOL, probe_hash: this.st.probeHash[app] ?? "", keeper_version: this.d.version, options_hash: optionsHash(this.opts), backup_scope: BACKUP_SCOPE };
  }

  // One poll: options re-read, the registration taken, each watched App read, every open attempt judged.
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const raw = this.d.options();
      if (raw !== null) this.opts = parseOptions(raw);
      else this.d.log("the keeper's options can't be read this poll: the last ones read stay in force");
      const now = this.now();
      if (this.opts.attempt) await this.register(this.opts.attempt);
      const apps = new Set([...this.opts.watch, ...this.open().map((a) => a.app)]);
      for (const app of apps) await this.pollApp(app);
      this.tickHeartbeat(now);
      this.arm();
      this.save();
      await this.flush();
      this.save();
    } finally { this.busy = false; }
  }

  // -- registration ---------------------------------------------------------------------------------
  private async register(r: Registration): Promise<void> {
    if (this.st.seen.includes(r.id)) {
      const a = this.st.attempts[r.id];
      if (a?.status === "verifying") await this.verify(a);
      return;
    }
    if (!ID.test(r.id)) { this.d.log(`refusing a registration with no usable id`); this.st.seen.push(r.id); return; }
    this.st.seen.push(r.id);
    const auth = parseAuthorization(r.authorization);
    const deadline = /^\d{10,13}$/.test(r.install_deadline) ? Number(r.install_deadline) * (r.install_deadline.length <= 10 ? 1000 : 1) : Date.parse(r.install_deadline);
    const now = this.now();
    const a: Attempt = {
      id: r.id, app: r.app, from: r.from_version, to: r.to_version, backup: r.backup_slug, deadline: Number.isFinite(deadline) ? deadline : 0,
      auth: auth?.kind ?? "ship", tokenHash: auth?.tokenHash ?? null, probeHash: r.probe_hash, registeredAt: now, status: "verifying",
      notStarted: 0, healthFails: 0, startedEveryPoll: true, health: [], verifyUntil: now + VERIFY_MS,
    };
    const why = !SLUG.test(r.app) ? "its app isn't an App slug"
      : r.app === this.d.self ? "the keeper doesn't watch its own install (it refuses to update itself while it watches)"
      : !this.opts.watch.includes(r.app) ? `${r.app} isn't in the keeper's watch list`
      : !VERSION.test(r.from_version) || !VERSION.test(r.to_version) ? "its versions aren't versions"
      : r.from_version === r.to_version ? "from_version and to_version are the same"
      : !BACKUP.test(r.backup_slug) ? "its backup_slug isn't a backup slug"
      : !Number.isFinite(deadline) ? "its install_deadline isn't a time"
      : deadline <= now ? "its install_deadline has passed"
      : deadline > now + MAX_DEADLINE_MS ? "its install_deadline is more than 6 hours away"
      : !auth ? `its authorization isn't "ship" or "drill" with the owner's tap token`
      : !PROBE_HASH.test(r.probe_hash) ? "its probe_hash isn't a hash"
      : this.open(r.app).length ? `another attempt for ${r.app} is open (${this.open(r.app)[0].id})`
      : null;
    if (why && SLUG.test(r.app)) { this.st.attempts[a.id] = a; this.unprotected(a, why); return; }
    if (why) { this.d.log(`refusing ${r.id}: ${why}`); return; }
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
      if (a.status === "restoring") await this.restoring(a, info, ok);
      else if (a.status === "accepted" || a.status === "watching") this.judge(a, info, ok, now);
    }
    this.clearOutstanding(app);
  }
  // A version change of a watched App: an attempt's install, an attempt's recovery, or unregistered.
  private versionChange(app: string, v: string): void {
    const was = this.st.lastSeen[app];
    if (was === undefined) { this.st.lastSeen[app] = v; return; }
    if (was === v) return;
    this.st.lastSeen[app] = v;
    const recent = Object.values(this.st.attempts).filter((a) => a.app === app && this.now() - a.registeredAt < 86_400_000);
    const covered = recent.some((a) => (a.to === v && a.status !== "never started") || (a.from === v && ["restoring", "rolled back", "gave up"].includes(a.status)));
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
      if (!a.firstSeenTo && (!info || info.version === a.from)) {
        a.status = "never started"; a.endedAt = now; a.why = "the install deadline passed with the App still at its old version";
        this.d.log(`${a.id}: install never started (${a.app} still at ${info?.version ?? "unknown"})`);
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
      if (a.firstStartedTo) a.startedEveryPoll = false;
      if (a.notStarted >= 2) return this.fail(a, "not-started", `the App wasn't started on two polls in a row (${info.state})`);
    } else {
      a.notStarted = 0;
      a.firstStartedTo ??= now;
      const graceOver = now - a.firstStartedTo >= this.opts.health_grace_s * 1000;
      a.health.push({ at: now, ok: healthOk }); if (a.health.length > 3) a.health.shift();
      if (healthOk) a.healthFails = 0;
      else if (graceOver && ++a.healthFails >= 3) return this.fail(a, "health", "its /health failed on three polls in a row");
    }
    if (a.verdict?.result === "FAIL") return this.fail(a, "verdict", `its probe said FAIL: ${a.verdict.reason}`);
    if (now >= (a.watchEnd ?? Infinity)) {
      const fresh = a.health.length === 3 && a.health.every((x) => x.ok && now - x.at <= 2 * POLL_MS + 15_000);
      const missing = [a.verdict?.result === "PASS" ? null : "no PASS verdict for this attempt",
        a.firstStartedTo && a.startedEveryPoll ? null : "not started on every poll since it first started",
        fresh ? null : "its /health wasn't 200 on the last three polls"].filter(Boolean);
      if (missing.length) return this.fail(a, "watch-end", `at the end of the watch: ${missing.join("; ")}`);
      a.status = "passed"; a.endedAt = now;
      this.d.log(`${a.id}: passed (${a.app} ${a.to})`);
      this.lastLine(a.app, "passed", `${appName(a.app)} ${a.to} passed Keeper's check after its install.`, a.id);
    }
  }
  // A fail: the trigger kept, the attempt marked restoring (saved) before any restore starts.
  private fail(a: Attempt, kind: TriggerKind, words: string): void {
    const now = this.now();
    a.trigger = { kind, words, at: now };
    a.status = "restoring";
    a.restore = { tries: 0, nextTry: now, limit: now + RESTORE_LIMIT_MS, inflight: false, called: false };
    this.d.log(`${a.id}: fail (${words}); restoring ${a.app} from backup ${a.backup}`);
    this.save();
  }

  // -- the restore ----------------------------------------------------------------------------------
  private async restoring(a: Attempt, info: AppInfo | null, healthOk: boolean): Promise<void> {
    const r = a.restore!;
    const now = this.now();
    if (!r.called) {
      if (r.inflight) { r.called = true; r.doneAt = now; r.confirmUntil = now + CONFIRM_MS; this.d.log(`${a.id}: a restore was under way when the keeper stopped; it isn't started again, only confirmed`); this.save(); return; }
      if (now < r.nextTry) return;
      if (now >= r.limit) return this.gaveUp(a, "the Supervisor stayed busy past the restore's limit");
      r.inflight = true; r.tries++;
      this.save();                                         // one restore per attempt, across restarts
      const res = await this.d.restore(a.backup, a.app).catch((e) => ({ ok: false as const, retry: true, why: String(e).slice(0, 120) }));
      const t = this.now();
      r.inflight = false;
      if (res.ok) {
        r.called = true; r.doneAt = t; r.confirmUntil = t + CONFIRM_MS;
        this.d.log(`${a.id}: restored backup ${a.backup} (${a.app} alone); confirming ${a.from} comes back`);
        this.save();
        return;
      }
      if (res.retry && t + this.backoff(r.tries) < r.limit) {
        r.nextTry = t + this.backoff(r.tries);
        this.d.log(`${a.id}: the Supervisor is busy (${res.why}); the restore is tried again in ${Math.round(this.backoff(r.tries) / 1000)} seconds`);
        this.save();
        return;
      }
      return this.gaveUp(a, `the restore failed: ${res.why}`);
    }
    if (info && info.version === a.from && info.state === "started" && healthOk) {
      a.status = "rolled back"; a.endedAt = now; r.result = "ok";
      this.d.log(`${a.id}: rolled back (${a.app} ${a.from} started and healthy; trigger: ${a.trigger?.words})`);
      this.owner(a.app, "rolled back", `Keeper rolled back ${appName(a.app)} from ${a.to} to ${a.from}: ${a.trigger?.words ?? "a failed check"}. What the App wrote after the backup is gone.`, false, a.id);
      return;
    }
    if (now >= (r.confirmUntil ?? 0)) return this.gaveUp(a, `${a.from} didn't come back started and healthy within 5 minutes of the restore`);
  }
  backoff(tries: number): number { return Math.min(240_000, POLL_MS * 2 ** Math.max(0, tries - 1)); }
  private gaveUp(a: Attempt, why: string): void {
    a.status = "gave up"; a.endedAt = this.now(); a.why = why;
    if (a.restore) a.restore.result = why;
    this.d.log(`${a.id}: gave up (${why})`);
    this.owner(a.app, "gave up", `Keeper gave up on ${appName(a.app)} ${a.to}: ${why}. Restore its backup by hand in Home Assistant (Settings, System, Backups).`, true, a.id);
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
  // The owner's line: logged, kept as the App's last line, and queued as a Healthchecks ping (a fail
  // ping to hc_failed, or a success ping to hc_done carrying the line for a completed rollback).
  owner(app: string, kind: string, line: string, fail: boolean, attempt?: string): void {
    const l = this.lastLine(app, kind, line, attempt);
    this.d.log(`owner: ${line}`);
    if (!hcArmable(this.opts)) this.d.log("the Healthchecks URLs aren't set, so that line reaches no one but this log (the keeper is not armable)");
    this.st.queue.push({ key: l.id, to: fail ? "failed" : "done", fail, body: line, app, attempt, tries: 0, next: 0 });
  }
  // Fail pings are retried until delivered; a delivered fail leaves a success ping owed for its App.
  async flush(): Promise<void> {
    const now = this.now();
    const keep: QueueItem[] = [];
    for (const q of this.st.queue) {
      const base = q.to === "done" ? this.opts.hc_done : this.opts.hc_failed;
      if (now < q.next || !/^https:\/\/\S+$/.test(base)) { keep.push(q); continue; }
      const url = q.fail ? `${base.replace(/\/+$/, "")}/fail` : base;
      const ok = await this.d.ping(url, q.body).catch(() => false);
      if (ok) {
        if (q.fail) this.st.outstanding[q.app] = true;
        if (q.attempt && this.st.attempts[q.attempt]) this.st.attempts[q.attempt].lineDelivered = true;
        if (q.attempt) this.autoDrill(q.attempt);
        continue;
      }
      q.tries++; q.next = now + Math.min(600_000, 30_000 * 2 ** Math.min(q.tries, 5));
      keep.push(q);
    }
    this.st.queue = keep;
  }
  // Once the condition clears (no open attempt for the App, started, /health 200 on the last three
  // polls), the owed success ping goes to hc_failed, so the next event alerts again.
  private clearOutstanding(app: string): void {
    if (!this.st.outstanding[app]) return;
    if (this.open(app).length || this.appState[app] !== "started") return;
    const h = this.appHealth[app] ?? [];
    if (h.length < 3 || !h.every(Boolean)) return;
    if (this.st.queue.some((q) => q.app === app && q.fail)) return;
    delete this.st.outstanding[app];
    this.st.queue.push({ key: `${app}-clear-${++this.st.lines}`, to: "failed", fail: false, body: `${appName(app)} is started and healthy again.`, app, tries: 0, next: 0 });
  }
  // The heartbeat: the time in /data every minute, a ping to hc_done every 5 minutes.
  private tickHeartbeat(now: number): void {
    this.st.heartbeat = now;
    if (now - this.st.hcPinged >= HC_HEARTBEAT_MS && /^https:\/\/\S+$/.test(this.opts.hc_done)) {
      this.st.hcPinged = now;
      void this.d.ping(this.opts.hc_done, "keeper heartbeat").catch(() => false);
    }
  }
  heartbeat(): void { this.st.heartbeat = this.now(); this.save(); }

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
  // The armed record of each App: both drills on record under the current binding, within 60 days,
  // with the Healthchecks URLs set. Anything else drops it (and a binding change drops the drills).
  arm(): void {
    const now = this.now();
    const apps = new Set([...Object.keys(this.st.drills), ...Object.keys(this.st.armed)]);
    for (const app of apps) {
      const cur = this.binding(app);
      const d = this.st.drills[app] ?? {};
      for (const k of Object.keys(d) as DrillRec["kind"][]) {
        const rec = d[k]!;
        if (JSON.stringify(rec.binding) !== JSON.stringify(cur) || now - rec.at > ARMED_MAX_MS) {
          this.d.log(`the ${k} drill of ${app} no longer counts (${now - rec.at > ARMED_MAX_MS ? "older than 60 days" : "its binding changed"})`);
          delete d[k];
        }
      }
      const both = d["fail-verdict"] && d["exits-on-start"];
      const prev = this.st.armed[app];
      if (both && hcArmable(this.opts)) {
        if (!prev || JSON.stringify(prev.binding) !== JSON.stringify(cur)) { this.st.armed[app] = { at: now, binding: cur }; this.d.log(`armed for ${app}`); }
        else if (now - prev.at > ARMED_MAX_MS) { delete this.st.armed[app]; delete this.st.drills[app]; this.d.log(`disarmed for ${app}: 60 days passed`); }
      } else if (prev) {
        delete this.st.armed[app];
        this.d.log(`disarmed for ${app}: ${!hcArmable(this.opts) ? "the Healthchecks URLs aren't set" : "a drill record no longer counts"}`);
      }
    }
  }
  armedView(app: string): { app: string; armed: boolean; why: string; armed_at: string | null; binding: Binding; keeper_version: string; at: string } {
    const a = this.st.armed[app];
    const cur = this.binding(app);
    const armable = hcArmable(this.opts);
    const why = !armable ? "the keeper is not armable: its Healthchecks URLs aren't set"
      : !a ? `no drills on record for ${app} under the current binding` : "";
    return { app, armed: !!a && armable, why, armed_at: a ? new Date(a.at).toISOString() : null, binding: a ? a.binding : cur,
      keeper_version: this.d.version, at: new Date(this.st.heartbeat || this.now()).toISOString() };
  }
}
