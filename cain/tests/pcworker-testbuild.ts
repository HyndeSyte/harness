// The PC worker's test build (0.12.0, twenty-seventh round): imported by the test files only, never by the worker's
// production entry point (worker.ts imports nothing from cain/tests, and the release ships no cain/tests). Importing it
// marks this process as the test harness with a global symbol no environment variable, user or system setting,
// inherited shell or scheduled task can set; only then does the worker honour a listing runner (Opts.chromePs).
export const TEST_BUILD_MARK = Symbol.for("cain.pc-worker.test-build");
(globalThis as any)[TEST_BUILD_MARK] = true;
// A stretch of a test run as the production build would see it (the mark off), the mark put back after.
export function outsideTestBuild<T>(f: () => T): T {
  const g = globalThis as any;
  const was = g[TEST_BUILD_MARK];
  delete g[TEST_BUILD_MARK];
  try { return f(); } finally { if (was !== undefined) g[TEST_BUILD_MARK] = was; }
}
