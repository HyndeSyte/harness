// The Worker's entry module (wrangler.toml main). workerd refuses a main module exporting anything but
// handlers and classes, so it exports exactly two things: the fetch handler and the Durable Object
// class bound as STORE. Everything else lives in ./worker.ts, where the tests import it from. A test
// pins this list, and the workerd suite (worker/workerd) starts it in the real runtime.
import { createWorker, SnapshotStore } from "./worker";

export { SnapshotStore };
export default createWorker({ fetch: (u) => fetch(u), now: () => Date.now() });
