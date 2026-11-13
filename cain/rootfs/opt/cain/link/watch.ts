// Cain's half of the mutual watch: is the calendar specialist (the Harness App) still
// there? The other half is harness/app/harness/watch.py, with the same rules.
//
// main.ts asks the specialist's /health once a minute. When it hasn't answered for
// GRACE_MS, Dane is told once, with nothing asked of him; if it's still down STILL_MS
// after it stopped, he's told once more how to restart it (the fix, ready); when it
// answers again, once more. A restart or an update takes well under GRACE_MS, so it
// says nothing. A message that couldn't be sent is tried again at the next check, and
// only then.
//
// The state is a few timestamps in /data/link/watch.json, so a restart of Cain during
// an outage doesn't tell him anything twice. An outage not told yet starts over after a restart:
// Cain may have been off itself for longer than the specialist was.
//
// The grace period is timed on the monotonic clock (performance.now), so a clock jump at
// boot (the Pi has no real-time clock) can't make an outage look long. Wall-clock times
// are only for display and the persisted "already told him" flag.
//
// The probe has three answers: "up", "down" (no answer, a 5xx, or its own "stuck"), and
// "refused" (403: our key isn't the one it accepts). Refused is neither: it's logged and
// shown as "can't check: key refused", and tells him nothing.
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const GRACE_MS = 5 * 60_000;
export const STILL_MS = 30 * 60_000;              // still down this long: the restart line, once
export const CHECK_MS = 60_000;
export const NOTICE_TIMEOUT_MS = 15_000;
export const MAX_SHOWN_MS = 30 * 24 * 3_600_000;   // a shown duration longer than this is a clock jump
export const DOWN = "down", BACK = "back", STILL = "still";
export type Due = typeof DOWN | typeof BACK | typeof STILL | null;
export type Probe = "up" | "down" | "refused";

// The key both add-ons derive from the bot token (handover.key_for in Python).
export function hmacKey(token: string, context: string): string {
  return token ? createHmac("sha256", token).update(context).digest("hex") : "";
}

// What the specialist's /health answer means. Only 404 (an older Harness without /health)
// counts as alive without a body; 403 is its own state; anything else not 2xx is down.
export function classify(status: number, body: any): Probe {
  if (status === 404) return "up";
  if (status === 403) return "refused";
  if (status < 200 || status >= 300) return "down";
  return body?.status === "stuck" ? "down" : "up";
}

export async function probeHarness(fetcher: (signal: AbortSignal) => Promise<Response>, timeoutMs = 10_000): Promise<Probe> {
  try {
    const r = await fetcher(AbortSignal.timeout(timeoutMs));
    const body = r.status >= 200 && r.status < 300 ? await r.json().catch(() => null) : null;
    return classify(r.status, body);
  } catch { return "down"; }
}

const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (ms: number) => Math.min(Math.max(0, ms), MAX_SHOWN_MS);

export interface WatchState { down_since: number | null; alerted_at: number | null; last_ok: number | null; still_at: number | null }

export interface WatchDeps {
  load: () => Partial<WatchState> | null;
  save: (s: WatchState) => void;
  now: () => number;                     // wall clock, ms: shown, and the persisted flag
  mono?: () => number;                   // monotonic, ms: the grace period
  grace?: number;
}

export class PeerWatch {
  private s: WatchState;
  private lastCheck: number | null = null;
  private lastResult: Probe | null = null;
  private downMono: number | null = null;   // when this run saw the outage start
  readonly grace: number;
  private mono: () => number;

  constructor(private d: WatchDeps) {
    this.grace = d.grace ?? GRACE_MS;
    this.mono = d.mono ?? (() => performance.now());
    let raw: any = null;
    try { raw = d.load(); } catch { raw = null; }
    this.s = { down_since: num(raw?.down_since), alerted_at: num(raw?.alerted_at), last_ok: num(raw?.last_ok), still_at: num(raw?.still_at) };
    if (!this.s.alerted_at) { this.s.down_since = null; this.s.still_at = null; }
  }

  private save(): void { this.d.save({ ...this.s }); }

  observe(result: boolean | Probe): Due {
    const r: Probe = result === true ? "up" : result === false ? "down" : result;
    const now = this.d.now();
    this.lastCheck = now;
    this.lastResult = r;
    if (r === "refused") return null;               // can't tell: neither up nor down
    if (r === "up") {
      this.s.last_ok = now;
      this.downMono = null;
      if (this.s.alerted_at) return BACK;            // stays due until sent()
      if (this.s.down_since) { this.s.down_since = null; this.save(); }
      return null;
    }
    const mono = this.mono();
    if (this.downMono === null) this.downMono = mono;
    if (!this.s.down_since) { this.s.down_since = now; this.save(); }
    if (!this.s.alerted_at && mono - this.downMono >= this.grace) return DOWN;
    if (this.s.alerted_at && !this.s.still_at && this.downFor() >= STILL_MS) return STILL;
    return null;
  }

  sent(what: Due): void {
    if (what === DOWN) this.s.alerted_at = this.d.now();
    else if (what === STILL) this.s.still_at = this.d.now();
    else if (what === BACK) { this.s.alerted_at = null; this.s.down_since = null; this.s.still_at = null; this.downMono = null; }
    this.save();
  }

  // How long the outage has lasted, for the message: monotonic when this run saw it
  // start, else wall clock (after a restart), clamped either way.
  downFor(): number {
    if (this.downMono !== null) return clamp(this.mono() - this.downMono);
    return this.s.down_since ? clamp(this.d.now() - this.s.down_since) : 0;
  }

  state(): "unknown" | "up" | "waiting" | "down" | "back" | "refused" {
    if (this.lastCheck === null) return "unknown";
    if (this.lastResult === "refused") return "refused";
    if (this.s.alerted_at) return this.lastResult === "up" ? "back" : "down";
    return this.s.down_since ? "waiting" : "up";
  }

  status(): Record<string, unknown> {
    const state = this.state();
    return { state, ...(state === "refused" ? { note: "can't check: key refused" } : {}),
             checked_at: this.lastCheck, ...this.s };
  }
}

export function minutes(ms: number): string {
  const m = Math.max(1, Math.round(clamp(ms) / 60_000));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  return `${(m / 60).toFixed(1).replace(/\.0$/, "")} hours`;
}

// The first notice says what's down and what waits, and asks nothing of him.
export function downText(ms: number): string {
  return `The calendar specialist (Harness) hasn't answered for ${minutes(ms)}. ` +
    "Calendar requests, its cards and the morning calendar wait until it's back. You'll hear once it is.";
}

// Once, if it's still down after STILL_MS: the fix, ready.
export function stillText(): string {
  return "Harness is still down. Restarting it should bring it back: Settings > Apps > Harness > Restart.";
}

export function backText(ms: number): string {
  return `The calendar specialist (Harness) is answering again, after about ${minutes(ms)}.`;
}

// One check: probe, decide, tell, then (best effort) tell Cain. probe never throws;
// tell throws when the DM couldn't be sent. Once the DM is out it's marked sent, so a
// failing relay line can never make the DM go out again.
export async function check(w: PeerWatch, probe: () => Promise<boolean | Probe>,
                            tell: (text: string, what: Due) => Promise<void>,
                            log: (line: string) => void = () => {},
                            relay: (what: Due) => void = () => {}): Promise<Due> {
  const before = w.state();
  const due = w.observe(await probe());
  if (w.state() === "refused" && before !== "refused")
    log("watch: the specialist refused our key (403); can't check it until the keys match");
  if (!due) return null;
  const ms = w.downFor();
  try {
    await tell(due === DOWN ? downText(ms) : due === STILL ? stillText() : backText(ms), due);
  } catch (e) {
    log(`watch: couldn't tell Dane the specialist is ${due}: ${String(e).slice(0, 80)}`);
    return null;
  }
  try { w.sent(due); } catch (e) { log(`watch: couldn't record that Dane was told: ${String(e).slice(0, 80)}`); }
  log(`watch: told Dane the specialist is ${due} (after ${Math.round(ms / 1000)}s)`);
  try { relay(due); } catch (e) { log(`watch: couldn't pass the ${due} line to Cain: ${String(e).slice(0, 80)}`); }
  return due;
}

// Run fn every ms, never two at once: the next run is scheduled only after this one
// ends, and a failure is logged, never silent.
export function every(ms: number, fn: () => Promise<unknown>, log: (line: string) => void,
                      timer: (cb: () => void, ms: number) => unknown = setTimeout): void {
  const run = async () => {
    try { await fn(); } catch (e) { log(`watch: check failed: ${String(e).slice(0, 80)}`); }
    finally { timer(run, ms); }
  };
  timer(run, ms);
}

// The watch's file: the folder is made before each save, and a failed save is logged,
// not thrown (the watch goes on in memory).
export function fileStore(path: string, log: (line: string) => void) {
  return {
    load: (): Partial<WatchState> | null => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } },
    save: (s: WatchState): void => {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      } catch (e) { log(`watch: couldn't save ${path}: ${String(e).slice(0, 80)}`); }
    },
  };
}

// The link's /health: bare "ok" without the key; the Discord state and the watch only
// with it, as the specialist's own /health does.
export function healthBody(keyOk: boolean, detail: () => Record<string, unknown>): Record<string, unknown> {
  return keyOk ? { status: "ok", ...detail() } : { status: "ok" };
}
