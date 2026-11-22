// The trials' one budget (Cain 0.19.0, first review round): an atomic check-and-reserve on disk, shared by
// every suite, every grader, every resume and every process. /data/trials/budget.json holds what was spent,
// each call's reservation while it is out, and each task's hold (both graders' worst case, reserved before
// the task's first call, so grading never runs out partway).
//
// The rules:
// - A call is reserved at its worst case under the ledger's lock, with the budget and the review seat's
//   room (its monthly cap less the reserve kept for real reviews, less every trial reservation already out
//   on that seat) checked in the same step, and the file is fsynced before the call is sent.
// - It is marked dispatched (fsynced again) just before it leaves. A reservation never marked dispatched
//   when its process died was never sent: it is released. One marked dispatched is counted at its worst
//   case, since its real cost can't be known.
// - Settled from the provider's bill, or from its token counts at the list price; a missing or ambiguous
//   figure keeps the whole reservation. Released with no charge only when the call never left (a privacy
//   block on the wire) or the provider refused it outright (HTTP 4xx: key, credit, rate limit, malformed).
// - A retry reserves again.
//
// Second review round (Cain 0.19.0):
// - One cap across every seat, probe, grader and retry, with a fixed overrun margin: a call is admitted only
//   while the budget left after it is at least the margin (the largest single call's worst case), so even a
//   call that overshoots its own reservation by its whole worst case stays under the cap.
// - A reservation is released only on an authoritative zero: nothing left at all, an HTTP 4xx with no usage
//   in it, or a usage block showing zero. Anything else keeps it (the runner decides; release() is only its
//   tool).
// - Codex on the ChatGPT plan has no bill: its calls count against a per-window call allowance, never as
//   dollars. Every seat has a trial allowance per window (calls) that leaves headroom for real reviews; a seat
//   whose allowance is used waits for its window, before any 429.
// - Ownership: each reservation names its owner by pid, boot id and the process's start time. A restart
//   releases (or, once sent, charges) only reservations whose owner is gone: another boot, a pid that isn't
//   running, or a pid now running something that started at another time. Marking a call dispatched happens
//   under the same lock and fails if the reservation is gone or isn't this owner's, and then nothing is sent.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, chownSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ReviewSeatName } from "./core.ts";

export type How = "billed" | "estimated" | "reserved (no bill)" | "worst case (cut off)" | "plan call";
export type BudgetEntry = { suite: string; run: string; call: string; usd: number; how: How; at: string; attempt?: number; seat?: ReviewSeatName | null; calls?: number };
export type Reservation = {
  id: string; suite: string; run: string; call: string; attempt: number; seat: ReviewSeatName | null;
  usd: number; runs: number; drawn: number; hold?: string; state: "reserved" | "dispatched"; owner: string; at: string;
};
export type Hold = { suite: string; run: string; task: string; usd: number; owner: string; at: string };
export type Budget = { format: 2; spent_usd: number; entries: BudgetEntry[]; reservations: Record<string, Reservation>; holds: Record<string, Hold> };

const EMPTY = (): Budget => ({ format: 2, spent_usd: 0, entries: [], reservations: {}, holds: {} });
export const round6 = (n: number) => Number(n.toFixed(6));
export function committedOf(b: Budget): number {
  return b.spent_usd + Object.values(b.reservations).reduce((a, r) => a + r.usd, 0) + Object.values(b.holds).reduce((a, h) => a + h.usd, 0);
}

// Read, with the format before this round (pending calls) carried over as dispatched reservations of a
// process that is gone, so each is counted once at its worst case.
export function readBudgetFile(path: string): Budget {
  let j: any;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch (e: any) {
    if (e?.code === "ENOENT") return EMPTY();
    throw new Error("the trials budget file can't be read; nothing is reserved until it can");
  }
  if (j?.format === 2 && Array.isArray(j.entries)) return { ...EMPTY(), ...j, reservations: j.reservations ?? {}, holds: j.holds ?? {} };
  if (j?.format === 1 && Array.isArray(j.entries)) {
    const b: Budget = { ...EMPTY(), spent_usd: Number(j.spent_usd) || 0, entries: j.entries };
    for (const [k, p] of Object.entries<any>(j.pending ?? {})) b.reservations[`${k}|legacy`] = { id: `${k}|legacy`, suite: p.suite, run: p.run, call: p.call, attempt: 0, seat: null,
      usd: Number(p.worst_usd) || 0, runs: 0, drawn: 0, state: "dispatched", owner: "legacy:0", at: String(p.at ?? "") };
    return b;
  }
  throw new Error("the trials budget file is in a format this runner doesn't know; nothing is reserved until it is fixed");
}

// Written whole, fsynced, renamed, and the folder fsynced, so a reservation is on disk before the call goes.
export function writeDurable(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o640);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { const s = statSync(path); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* a new file */ }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not every platform fsyncs a folder */ }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const STALE_LOCK_MS = 30_000;

export type SeatCheck = (seat: ReviewSeatName, outstanding: { usd: number; runs: number }, need: { usd: number; runs: number }) => string | null;
// A seat's trial allowance: at most `allowance` trial calls in any `ms` (a rolling window).
export type SeatWindow = { ms: number; allowance: number };
export type ReserveReq = { suite: string; run: string; call: string; attempt: number; seat: ReviewSeatName | null; usd: number; runs: number; hold?: string };
export type ReserveOpts = { marginUsd?: number; window?: (seat: ReviewSeatName) => SeatWindow | null };
export type ReserveResult = { ok: true; id: string } | { ok: false; reason: "budget" | "seat" | "busy" | "window"; detail: string; committed?: number; retryAt?: string };

// Calls a seat has made or has out within its window: settled entries and live reservations.
export function windowUse(b: Budget, seat: ReviewSeatName, sinceIso: string): { used: number; oldest: string | null } {
  const ats: string[] = [];
  for (const e of b.entries) if (e.seat === seat && e.at >= sinceIso) for (let i = 0; i < (e.calls ?? 1); i++) ats.push(e.at);
  for (const r of Object.values(b.reservations)) if (r.seat === seat) ats.push(r.at);
  ats.sort();
  return { used: ats.length, oldest: ats[0] ?? null };
}

export class Ledger {
  readonly path: string; readonly lockPath: string; readonly owner: string;
  constructor(public dir: string, owner?: string, private now: () => Date = () => new Date()) {
    this.path = join(dir, "budget.json");
    this.lockPath = join(dir, "budget.lock");
    this.owner = owner ?? ownerToken();
  }
  read(): Budget { return readBudgetFile(this.path); }
  private iso() { return this.now().toISOString(); }

  // The lock: an exclusive create; a lock older than 30 seconds is taken over by a rename, then the
  // exclusive create again, so exactly one contender proceeds.
  private lock(timeoutMs = 5_000): string | null {
    mkdirSync(this.dir, { recursive: true });
    const token = `${this.owner}:${randomBytes(4).toString("hex")}`;
    const until = Date.now() + timeoutMs;
    while (true) {
      try { const fd = openSync(this.lockPath, "wx", 0o640); try { writeSync(fd, token); fsyncSync(fd); } finally { closeSync(fd); } return token; }
      catch (e: any) { if (e?.code !== "EEXIST") throw e; }
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) {
          try { renameSync(this.lockPath, `${this.lockPath}.stale-${randomBytes(4).toString("hex")}`); } catch { /* another took it */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() > until) return null;
      sleepSync(15);
    }
  }
  private unlock(token: string) {
    try { if (readFileSync(this.lockPath, "utf8") === token) unlinkSync(this.lockPath); } catch { /* gone */ }
  }
  // Everything that changes the budget runs here: lock, read, change, write (fsynced), unlock.
  with<T>(fn: (b: Budget) => { value: T; write: boolean }): T | { busy: true } {
    const token = this.lock();
    if (!token) return { busy: true };
    try {
      const b = this.read();
      const r = fn(b);
      if (r.write) writeDurable(this.path, JSON.stringify(b, null, 1));
      return r.value;
    } finally { this.unlock(token); }
  }

  reserve(req: ReserveReq, budgetUsd: number, seatCheck?: SeatCheck, opts: ReserveOpts = {}): ReserveResult {
    const id = `${req.suite}|${req.run}|${req.call}|${req.attempt}`;
    const margin = Math.max(0, opts.marginUsd ?? 0);
    const r = this.with<ReserveResult>((b) => {
      if (b.reservations[id]) return { value: b.reservations[id].owner === this.owner ? { ok: true, id } : { ok: false, reason: "busy", detail: "another process holds this call's reservation" }, write: false };
      const hold = req.hold ? b.holds[req.hold] : undefined;
      const drawn = hold ? Math.min(hold.usd, req.usd) : 0;
      const committed = committedOf(b);
      const extra = req.usd - drawn;
      if (committed + extra > budgetUsd - margin + 1e-9) return { value: { ok: false, reason: "budget", committed,
        detail: `it could cost up to $${req.usd.toFixed(2)}, and with $${committed.toFixed(2)} spent or reserved that would leave less than the $${margin.toFixed(2)} overrun margin under the trials budget of $${budgetUsd.toFixed(2)}` }, write: false };
      const win = req.seat && opts.window ? opts.window(req.seat) : null;
      if (req.seat && win) {
        const since = new Date(this.now().getTime() - win.ms).toISOString();
        const u = windowUse(b, req.seat, since);
        if (u.used + 1 > win.allowance) {
          const retryAt = new Date((u.oldest ? Date.parse(u.oldest) : this.now().getTime()) + win.ms + 1_000).toISOString();
          return { value: { ok: false, reason: "window", retryAt,
            detail: `${req.seat} has used its trial allowance of ${win.allowance} calls in ${Math.round(win.ms / 60_000)} minutes (the rest is headroom kept for real reviews)` }, write: false };
        }
      }
      if (req.seat && seatCheck) {
        const out = Object.values(b.reservations).filter((x) => x.seat === req.seat).reduce((a, x) => ({ usd: a.usd + x.usd, runs: a.runs + x.runs }), { usd: 0, runs: 0 });
        const why = seatCheck(req.seat, out, { usd: req.usd, runs: req.runs });
        if (why) return { value: { ok: false, reason: "seat", detail: why }, write: false };
      }
      if (hold) { hold.usd = round6(hold.usd - drawn); if (hold.usd <= 1e-9) delete b.holds[req.hold!]; }
      b.reservations[id] = { id, suite: req.suite, run: req.run, call: req.call, attempt: req.attempt, seat: req.seat, usd: round6(req.usd), runs: req.runs,
        drawn: round6(drawn), ...(req.hold ? { hold: req.hold } : {}), state: "reserved", owner: this.owner, at: this.iso() };
      return { value: { ok: true, id }, write: true };
    });
    return "busy" in r ? { ok: false, reason: "busy", detail: "the trials budget is locked by another process" } : r;
  }
  // Marked sent under the lock: false (and nothing may be sent) when the reservation is gone, or isn't ours.
  dispatched(id: string): boolean {
    const r = this.with<boolean>((b) => {
      const x = b.reservations[id];
      if (!x || x.owner !== this.owner) return { value: false, write: false };
      x.state = "dispatched";
      return { value: true, write: true };
    });
    return r === true;
  }
  // What it cost, in place of its reservation.
  settle(id: string, usd: number, how: How): boolean {
    const r = this.with<boolean>((b) => {
      const x = b.reservations[id];
      if (!x) return { value: false, write: false };
      delete b.reservations[id];
      const charged = round6(Math.max(0, usd));
      b.entries.push({ suite: x.suite, run: x.run, call: x.call, attempt: x.attempt, usd: charged, how, at: x.at, seat: x.seat, calls: 1 });
      b.spent_usd = round6(b.spent_usd + charged);
      return { value: true, write: true };
    });
    return r === true;
  }
  // Nothing was sent, or the provider refused it outright: no charge, and what it drew goes back to its hold.
  release(id: string): boolean {
    const r = this.with<boolean>((b) => {
      const x = b.reservations[id];
      if (!x) return { value: false, write: false };
      delete b.reservations[id];
      if (x.hold && x.drawn > 0) {
        const h = b.holds[x.hold];
        if (h) h.usd = round6(h.usd + x.drawn);
        else { const [suite, run, task] = x.hold.split("|"); b.holds[x.hold] = { suite, run, task, usd: x.drawn, owner: this.owner, at: this.iso() }; }
      }
      return { value: true, write: true };
    });
    return r === true;
  }
  // A task's hold: kept if it is already there (a resume), otherwise reserved whole or not at all.
  hold(key: string, info: { suite: string; run: string; task: string }, usd: number, budgetUsd: number, marginUsd = 0): ReserveResult {
    const r = this.with<ReserveResult>((b) => {
      if (b.holds[key] || Object.values(b.reservations).some((x) => x.hold === key)) return { value: { ok: true, id: key }, write: false };
      const committed = committedOf(b);
      if (committed + usd > budgetUsd - marginUsd + 1e-9) return { value: { ok: false, reason: "budget", committed,
        detail: `the task's graders could cost up to $${usd.toFixed(2)}, and with $${committed.toFixed(2)} spent or reserved that would leave less than the $${marginUsd.toFixed(2)} overrun margin under the trials budget of $${budgetUsd.toFixed(2)}` }, write: false };
      b.holds[key] = { ...info, usd: round6(usd), owner: this.owner, at: this.iso() };
      return { value: { ok: true, id: key }, write: true };
    });
    return "busy" in r ? { ok: false, reason: "busy", detail: "the trials budget is locked by another process" } : r;
  }
  releaseHolds(pred: (key: string, h: Hold) => boolean): number {
    const r = this.with<number>((b) => {
      const keys = Object.keys(b.holds).filter((k) => pred(k, b.holds[k]));
      for (const k of keys) delete b.holds[k];
      return { value: keys.length, write: keys.length > 0 };
    });
    return typeof r === "number" ? r : 0;
  }
  // A process that died left its reservations: one never dispatched was never sent (released); one
  // dispatched is counted at its worst case, once.
  recover(alive: (owner: string) => boolean): { charged: Reservation[]; released: Reservation[] } | { busy: true } {
    return this.with((b) => {
      const charged: Reservation[] = [], released: Reservation[] = [];
      for (const x of Object.values(b.reservations)) {
        if (alive(x.owner)) continue;
        delete b.reservations[x.id];
        if (x.state === "dispatched") {
          b.entries.push({ suite: x.suite, run: x.run, call: x.call, attempt: x.attempt, usd: x.usd, how: "worst case (cut off)", at: x.at, seat: x.seat, calls: 1 });
          b.spent_usd = round6(b.spent_usd + x.usd);
          charged.push(x);
        } else {
          if (x.hold && x.drawn > 0 && b.holds[x.hold]) b.holds[x.hold].usd = round6(b.holds[x.hold].usd + x.drawn);
          released.push(x);
        }
      }
      return { value: { charged, released }, write: charged.length + released.length > 0 };
    });
  }
}

// Who owns a reservation: pid, boot id, the process's start time (clock ticks since boot, from
// /proc/<pid>/stat) and a random part, so a pid reused after a restart, or the same pid on another boot, isn't
// taken for the owner.
export function bootId(): string {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/[^a-f0-9-]/gi, "").slice(0, 40) || "noboot"; } catch { return "noboot"; }
}
export function startTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;   // field 22 overall: starttime
  } catch { return null; }
}
export function ownerToken(pid = process.pid): string {
  return `${pid}:${bootId()}:${startTicks(pid) ?? "0"}:${randomBytes(6).toString("hex")}`;
}
// Whether a reservation's owner may still be running: this process's own token, or another live process on
// this boot that started when the owner did. The same pid with another token is an earlier run of this
// process (a restart reused the pid). A token from before this round (pid:random) is judged by its pid alone.
export function ownerAlive(mine: string, o: { boot?: string; alive?: (pid: number) => boolean; start?: (pid: number) => string | null } = {}) {
  const boot = o.boot ?? bootId();
  const alive = o.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } });
  const start = o.start ?? startTicks;
  return (owner: string): boolean => {
    if (owner === mine) return true;
    const parts = owner.split(":");
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === Number(mine.split(":")[0])) return false;
    if (parts.length >= 4) {
      if (parts[1] !== boot) return false;              // another boot: that process is gone
      if (!alive(pid)) return false;
      const s = start(pid);
      return s === null || parts[2] === "0" || s === parts[2];
    }
    return alive(pid);
  };
}
