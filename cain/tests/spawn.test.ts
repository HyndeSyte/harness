// The link's bounded commands (link/spawn.ts): at the time limit the call returns,
// whatever the command or its children are doing.
import { describe, expect, test } from "bun:test";
import { runBounded } from "../rootfs/opt/cain/link/spawn.ts";

const env = { PATH: process.env.PATH ?? "" };
const bun = process.execPath;

describe("a bounded command", () => {
  test("answers with its output and exit code", async () => {
    const r = await runBounded([bun, "-e", "console.log('out'); console.error('err'); process.exit(3)"], env, 20_000);
    expect(r).toEqual({ code: 3, out: "out\n", err: "err\n" });
  });

  test("one that hangs is killed at its limit, and the call returns then", async () => {
    const t0 = Date.now();
    const r = await runBounded([bun, "-e", "setInterval(() => {}, 1000)"], env, 800);
    expect(r).toEqual({ code: 124, out: "", err: "timed out after 1s" });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  // ssh under git: a child holds the output open after its parent is killed.
  test.skipIf(process.platform === "win32")("even when a child of it holds its output open", async () => {
    const t0 = Date.now();
    const r = await runBounded(["sh", "-c", "sleep 30 & wait"], env, 800);
    expect(r.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
