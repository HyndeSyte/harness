// The PC worker's confirm path: behind a flag that is off. Before a confirming click, the
// tap's nonce is recorded in the queue first, so a token is spent once even if the click
// dies. install.json can't turn confirm_path on in this version (parseInstall refuses
// it), and no worker command reaches this: worker.ts doesn't import this file, and a test
// holds it to that.
import { ATTEMPT, ID } from "./core.ts";
import { clock, commitPush, listed, loadInstall, put, WorkerError, type Opts } from "./worker.ts";

const nonces = (o: Opts) => new Set(listed(o, "nonces", /^nonces\/([A-Za-z0-9_-]{22,64})\.json$/));

export function spendNonce(o: Opts, id: string, attempt: string, nonce: string) {
  const inst = loadInstall(o);
  if (!inst || (inst as any).confirm_path !== true) throw new WorkerError("confirm_path_off");
  if (!ID.test(id) || !ATTEMPT.test(attempt) || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) throw new WorkerError("bad_arguments");
  if (nonces(o).has(nonce)) throw new WorkerError("nonce_spent");
  put(o, ["nonces", `${nonce}.json`], JSON.stringify({ v: 1, nonce, job: id, attempt, worker_clock: clock(o).toISOString() }, null, 2) + "\n");
  commitPush(o, `spend a tap for ${id}`);
}
