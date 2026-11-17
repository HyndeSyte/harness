// Whether the box's clock is synchronized (0.12.0), for the record keeper's source checks and
// the link's taps. Four sources, in this order:
//   kernel       the kernel's own flag through adjtimex (read only; an App's container shares
//                the host's kernel). On the Pi, inside the Cain App's container on Home
//                Assistant OS, this is the one that works: timedatectl isn't installed and
//                systemd's flag files don't exist, while adjtimex answered state 0, status 8193,
//                STA_UNSYNC clear (measured Nov 15, 2026, with the clock about 8 seconds from
//                GitHub's Date header).
//   timedatectl  systemd's NTPSynchronized, when it is installed and answers.
//   timesyncd    systemd-timesyncd's flag file.
//   http-date    the Date header of the record keeper's own fetch from GitHub this round: within
//                DATE_SKEW_MS of the system clock counts as synchronized.
// Any one source that says synchronized is enough, and the verdict names it. When none does,
// the diagnostic says what each one returned.
import { existsSync } from "node:fs";

export type Source = "kernel" | "timedatectl" | "timesyncd" | "http-date";
export type Reading = { source: Source; state: "synced" | "unsynced" | "absent" | "unreadable"; detail?: string };
export type Verdict = { synced: boolean; source: Source | null; readings: Reading[]; diagnostic: string };

// How far GitHub's Date header may be from the system clock and still count: the header has
// one-second resolution and the fetch takes a moment, so a few seconds; a clock that has never
// been set is off by days or years.
export const DATE_SKEW_MS = 10_000;

export function kernelReading(): Reading {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi");
    const lib = dlopen("libc.so.6", { adjtimex: { args: [FFIType.ptr], returns: FFIType.i32 } });
    const buf = new Uint8Array(256);   // struct timex: modes is 0, so nothing is set
    const state = lib.symbols.adjtimex(ptr(buf));
    const status = new DataView(buf.buffer).getInt32(40, true);   // 64-bit Linux: after modes and four longs
    lib.close();
    if (state < 0) return { source: "kernel", state: "unreadable", detail: `adjtimex returned ${state}` };
    const ok = state !== 5 && (status & 0x40) === 0;   // not TIME_ERROR, STA_UNSYNC clear
    return { source: "kernel", state: ok ? "synced" : "unsynced", detail: `state ${state}, status ${status}` };
  } catch (e) {
    return { source: "kernel", state: "unreadable", detail: String((e as Error)?.message ?? e).slice(0, 80) };
  }
}

export function timedatectlReading(): Reading {
  try {
    const p = Bun.spawnSync(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], { stdout: "pipe", stderr: "pipe" });
    const v = p.stdout.toString().trim();
    if (p.exitCode === 0 && (v === "yes" || v === "no")) return { source: "timedatectl", state: v === "yes" ? "synced" : "unsynced" };
    return { source: "timedatectl", state: "unreadable", detail: `exit ${p.exitCode}` };
  } catch {
    return { source: "timedatectl", state: "absent" };
  }
}

export function timesyncdReading(): Reading {
  return { source: "timesyncd", state: existsSync("/run/systemd/timesync/synchronized") ? "synced" : "absent" };
}

// GitHub's Date header against the system clock at the moment the fetch ended (null: no
// header this round, as with a local remote).
export function dateHeaderReading(header: string | null | undefined, at: number): Reading {
  if (!header) return { source: "http-date", state: "absent" };
  const t = Date.parse(header);
  if (Number.isNaN(t)) return { source: "http-date", state: "unreadable" };
  const skew = at - t;
  return { source: "http-date", state: Math.abs(skew) <= DATE_SKEW_MS ? "synced" : "unsynced",
    detail: `${skew >= 0 ? "+" : "-"}${Math.round(Math.abs(skew) / 1000)} s` };
}

// The box's own sources, in order (all but GitHub's Date header).
export function localReadings(): Reading[] {
  return [kernelReading(), timedatectlReading(), timesyncdReading()];
}

const NAMES: Record<Source, string> = { kernel: "kernel flag", timedatectl: "timedatectl", timesyncd: "timesyncd flag file", "http-date": "GitHub Date header" };

export function describe(r: Reading): string {
  return `${NAMES[r.source]} ${r.state}${r.detail ? ` (${r.detail})` : ""}`;
}

export function verdict(readings: Reading[]): Verdict {
  const hit = readings.find((r) => r.state === "synced");
  if (hit) return { synced: true, source: hit.source, readings, diagnostic: `synchronized, by the ${NAMES[hit.source]}${hit.detail ? ` (${hit.detail})` : ""}` };
  return { synced: false, source: null, readings,
    diagnostic: `no clock source says synchronized: ${readings.length ? readings.map(describe).join(", ") : "none could be read"}` };
}

// What changes the verdict for logging: synchronized or not, by which source, and each
// source's state (not its numbers, so a skew that moves doesn't log every round).
export function verdictKey(v: Verdict): string {
  return `${v.synced ? `synced:${v.source}` : "unsynced"}|${v.readings.map((r) => `${r.source}=${r.state}`).join(",")}`;
}
