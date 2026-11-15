// How the link reaches GitHub (link/github.ts), run for real: the ssh options parse, git
// sets up the link's copy once (and tries again if that failed), and a git call whose ssh
// hangs is cut off at its limit.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGit, sshArgs, timeoutBin } from "../rootfs/opt/cain/link/github.ts";

const ssh = Bun.which("ssh");

describe("the link's way to GitHub", () => {
  test.skipIf(!ssh)("its ssh options are ones ssh takes: the deploy key only, no agent, pinned host keys, keep-alives", () => {
    // ssh -G leaves out a key file that isn't there, so the test makes one.
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    writeFileSync(join(dir, "deploy_key"), "not a real key", { mode: 0o600 });
    const args = sshArgs(join(dir, "deploy_key"), "/opt/cain/link/github_known_hosts");
    const p = Bun.spawnSync([ssh!, ...args.slice(1), "-G", "github.com"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const said = p.stdout.toString().toLowerCase();
    for (const want of ["identitiesonly yes", "batchmode yes", "stricthostkeychecking true", "connecttimeout 15",
      "serveraliveinterval 15", "serveralivecountmax 2", "identityagent none", "globalknownhostsfile /dev/null",
      "userknownhostsfile /opt/cain/link/github_known_hosts"]) expect(said).toContain(want);
    expect(said).toMatch(/identityfile .*deploy_key/);
  });

  test("git sets up the link's copy on first use, and runs there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    const git = makeGit({ repoDir: join(dir, "repo.git"), ssh: "ssh", home: dir, timeoutBin: null });
    const r = await git(["rev-parse", "--is-bare-repository"]);
    expect(r).toMatchObject({ code: 0, out: "true\n" });
  });

  // C1 review service, theme 2: no hook or filesystem monitor runs in the link's copy, whatever
  // is planted there (the copy is root's, out of Cain's reach; this is the second wall). The
  // control: the same hook runs for git without the link's settings.
  test.skipIf(process.platform === "win32")("a hook planted in the link's copy never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    const repo = join(dir, "repo.git"), marker = join(dir, "ran");
    const git = makeGit({ repoDir: repo, ssh: "ssh", home: dir, timeoutBin: null });
    await git(["rev-parse", "--is-bare-repository"]);
    writeFileSync(join(repo, "hooks/reference-transaction"), `#!/bin/sh
echo ran >> ${marker}
`, { mode: 0o755 });
    const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const c = await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", empty, "-m", "x"]);
    expect(c.code).toBe(0);
    expect((await git(["update-ref", "refs/heads/probe", c.out.trim()])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    Bun.spawnSync(["git", "--git-dir", repo, "update-ref", "refs/heads/control", c.out.trim()]);
    expect(existsSync(marker)).toBe(true);
  });

  test("a copy that can't be set up says so, and is tried again next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    writeFileSync(join(dir, "file"), "not a folder");
    const bad = makeGit({ repoDir: join(dir, "file", "repo.git"), ssh: "ssh", home: dir, timeoutBin: null });
    const r = await bad(["rev-parse", "--is-bare-repository"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("the link's copy of the repository couldn't be set up");
    expect((await bad(["rev-parse", "--is-bare-repository"])).err).toContain("couldn't be set up");
  });

  // ssh under git, hanging: timeout(1) ends git and its ssh together, at the limit.
  test.skipIf(process.platform === "win32" || !timeoutBin())("a git call whose ssh hangs is cut off at its limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    const git = makeGit({ repoDir: join(dir, "repo.git"), ssh: "sleep 60 #", home: dir, timeoutBin: timeoutBin() });
    const t0 = Date.now();
    const r = await git(["fetch", "git@github.com:HyndeSyte/harness.git", "+refs/heads/main:refs/ship/main"], { ssh: true, timeoutMs: 2_000 });
    expect(r.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
