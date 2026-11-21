// The rebase step's tool: after any rebase of the PC worker's pull request, the hook, the
// pinned settings and the suffix list are diffed against the reviewed head and the result
// goes into the description (cain/tools/guard-surface.sh, cain/docs/pc-jobs.md).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "cain", "tools", "guard-surface.sh");

test.skipIf(process.platform === "win32")("guard-surface: the three files' hashes at HEAD, and unchanged against HEAD itself; a sha that isn't a commit is refused", () => {
  const r = spawnSync("bash", [TOOL, "HEAD"], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(0);
  for (const f of ["pcjobs/worker.ts", "pc-worker/session-settings.json", "pcjobs/public_suffix_list.dat"]) expect(r.stdout).toMatch(new RegExp(`${f.replace(/[./]/g, "\\$&")} sha256 [0-9a-f]{16}`));
  expect(r.stdout).toContain("unchanged since the reviewed head");
  const bad = spawnSync("bash", [TOOL, "0".repeat(40)], { cwd: ROOT, encoding: "utf8" });
  expect(bad.status).toBe(2);
});
