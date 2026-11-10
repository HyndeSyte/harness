// Cain's half of the mutual watch: is the calendar specialist (the Harness add-on)
// still there? The other half is harness/app/harness/watch.py, with the same rules.
//
// main.ts asks the specialist's /health once a minute. When it hasn't answered for
// GRACE_MS, Dane is told once; when it answers again, once more. A restart or an
// update takes well under GRACE_MS, so it says nothing. A message that couldn't be
// sent is tried again at the next check, and only then.
//
// The state is a few timestamps in /data/link/watch.json, so a restart of Cain during
// an outage doesn't tell him twice. An outage not told yet starts over after a restart:
// Cain may have been off itself for longer than the specialist was.

export const GRACE_MS = 5 * 60_000;
export const CHECK_MS = 60_000;
export const DOWN = "down", BACK = "back";
export type Due = typeof DOWN | typeof BACK | null;

export interface WatchState { down_since: number | null; alerted_at: number | null; last_ok: number | null }

export interface WatchDeps {
  load: () => Partial<WatchState> | null;
  save: (s: WatchState) => void;
  now: () => number;
  grace?: number;
}

export class PeerWatch {
  private s: WatchState;
  private lastCheck: number | null = null;
  readonly grace: number;

  constructor(private d: WatchDeps) {
    this.grace = d.grace ?? GRACE_MS;
    let raw: any = null;
    try { raw = d.load(); } catch { raw = null; }
    const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    this.s = { down_since: num(raw?.down_since), alerted_at: num(raw?.alerted_at), last_ok: num(raw?.last_ok) };
    if (!this.s.alerted_at) this.s.down_since = null;
  }

  private save(): void { this.d.save({ ...this.s }); }

  observe(ok: boolean): Due {
    const now = this.d.now();
    this.lastCheck = now;
    if (ok) {
      this.s.last_ok = now;
      if (this.s.alerted_at) return BACK;            // stays due until sent()
      if (this.s.down_since) { this.s.down_since = null; this.save(); }
      return null;
    }
    if (!this.s.down_since) { this.s.down_since = now; this.save(); }
    if (!this.s.alerted_at && now - this.s.down_since >= this.grace) return DOWN;
    return null;
  }

  sent(what: Due): void {
    if (what === DOWN) this.s.alerted_at = this.d.now();
    else if (what === BACK) { this.s.alerted_at = null; this.s.down_since = null; }
    this.save();
  }

  downFor(): number { return this.s.down_since ? this.d.now() - this.s.down_since : 0; }

  state(): "unknown" | "up" | "waiting" | "down" | "back" {
    if (this.lastCheck === null) return "unknown";
    if (this.s.alerted_at) return (this.s.last_ok ?? 0) < this.s.alerted_at ? "down" : "back";
    return this.s.down_since ? "waiting" : "up";
  }

  status(): Record<string, unknown> {
    return { state: this.state(), checked_at: this.lastCheck, ...this.s };
  }
}

export function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  return `${(m / 60).toFixed(1).replace(/\.0$/, "")} hours`;
}

export function downText(ms: number): string {
  return `The calendar specialist (the Harness add-on) hasn't answered for ${minutes(ms)}. ` +
    "Calendar requests, its cards and the morning calendar wait until it's back. " +
    "If it doesn't come back by itself, restart Harness in Home Assistant. " +
    "(From Cain's add-on; I'll say once when it's back.)";
}

export function backText(ms: number): string {
  return `The calendar specialist is answering again, after about ${minutes(ms)}. (From Cain's add-on.)`;
}

// One check: probe, decide, tell. probe never throws; tell throws when it couldn't send.
export async function check(w: PeerWatch, probe: () => Promise<boolean>, tell: (text: string, what: Due) => Promise<void>,
                            log: (line: string) => void = () => {}): Promise<Due> {
  const due = w.observe(await probe());
  if (!due) return null;
  const ms = w.downFor();
  try {
    await tell(due === DOWN ? downText(ms) : backText(ms), due);
  } catch (e) {
    log(`watch: couldn't tell Dane the specialist is ${due}: ${String(e).slice(0, 80)}`);
    return null;
  }
  w.sent(due);
  log(`watch: told Dane the specialist is ${due} (after ${Math.round(ms / 1000)}s)`);
  return due;
}
