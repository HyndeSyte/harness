// Round 22: the start gate both Apps' processes pass before they take taps or apply anything: flock is probed on a probe
// file in the real log folder (applog.ts probeLock: loaded, errno resolved, and a contention self-test). When the probe
// fails, the process refuses to start: it logs why, tells once (the link: Cain's line and his notice; the keeper: Cain's
// line), and probes again every retryMs (an hour) until it passes, so a fixed box needs no restart by hand. Its own module
// (not the entry files) so the tests drive it.
export const LOCK_RETRY_MS = 3_600_000;
export interface GateDeps {
  probe: () => string | null;                 // null: the logs can be locked
  log: (line: string) => void;
  tell: (why: string) => Promise<void> | void;   // once, on the first refusal
  sleep: (ms: number) => Promise<void>;
  retryMs?: number;
}
// Resolves once the probe passes: refused, whether it refused at all; tries, how many probes it took.
export async function lockGate(d: GateDeps): Promise<{ refused: boolean; tries: number }> {
  let tries = 0, told = false;
  for (;;) {
    tries++;
    const why = d.probe();
    if (!why) {
      if (told) d.log("its logs can be locked now; starting");
      return { refused: told, tries };
    }
    d.log(`REFUSED TO START: ${why}`);
    if (!told) {
      told = true;
      try { await d.tell(why); } catch (e) { d.log(`couldn't tell that it refuses to start: ${String(e).slice(0, 80)}`); }
    }
    await d.sleep(d.retryMs ?? LOCK_RETRY_MS);
  }
}
