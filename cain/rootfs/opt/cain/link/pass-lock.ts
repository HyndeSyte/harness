// (Cain 0.19.4, review round 1) The Ship passes' one lock: an flock(2) on a file beside root's pass file, held across every
// transition's read, check and atomic rename (ship-pass.ts txn), so no two writers of the pass file interleave, in this process
// or another (an old link still finishing while the new one starts). Exclusive, never shared; asked without blocking and tried
// again for up to waitMs, then the transition fails (a refusal, never a write without the lock).
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
let libc: { symbols: { flock: (fd: number, op: number) => number } } | null = null;
const lib = () => (libc ??= dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }) as any);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function flockFile(path: string, waitMs = 2_000): () => () => void {
  return () => {
    const fd = openSync(path, "a", 0o600);
    const until = Date.now() + waitMs;
    for (;;) {
      let got = false;
      try { got = lib().symbols.flock(fd, LOCK_EX | LOCK_NB) === 0; } catch (e) { closeSync(fd); throw e; }
      if (got) break;
      if (Date.now() >= until) { closeSync(fd); throw new Error("the Ship passes' lock is held by another writer"); }
      pause(20);
    }
    let done = false;
    return () => { if (done) return; done = true; try { lib().symbols.flock(fd, LOCK_UN); } finally { closeSync(fd); } };
  };
}
