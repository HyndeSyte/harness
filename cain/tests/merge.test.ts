// Landing a pull request on Dane's Ship tap (link/merge.ts), against a small model of
// GitHub: its API answers, and a commit graph that git's fetch, rev-parse,
// merge-base and push read and change.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS_APP, bumpsAt, checkRuns, facts, headChecks, inMain, judgeChecks, keyAnswer, land, type MergeDeps } from "../rootfs/opt/cain/link/merge.ts";

const REPO = "HyndeSyte/harness";
const M0 = "a".repeat(40), M1 = "b".repeat(40), H1 = "c".repeat(40), H2 = "d".repeat(40), X1 = "e".repeat(40);

function gh(over: { pull?: any; runs?: any[]; parents?: Record<string, string>; main?: string; prHead?: string; yml?: string | null | 0; winStatus?: number } = {}) {
  const parents: Record<string, string> = over.parents ?? { [M1]: M0, [H1]: M1, [H2]: H1, [X1]: M0 };
  const state = {
    main: over.main ?? M1,
    prHead: over.prHead ?? H1,
    local: new Map<string, string>(),
    known: new Set<string>(),
    calls: [] as string[][],
    pushes: [] as string[][],
    stopped: false,
    stopAtPush: false,
    apiDown: false,
    fetchFails: false,
    pushSays: null as null | { code: number; err: string; lands?: boolean },
  };
  const pull = over.pull ?? { state: "open", merged: false, base: { ref: "main" }, head: { sha: H1, repo: { full_name: REPO } } };
  const runs = over.runs ?? ["pytest", "bun", "pr"].map((name, i) => ({ id: 100 + i, name, status: "completed", conclusion: "success", app: { id: ACTIONS_APP } }));
  const isAncestor = (a: string, b: string) => {
    for (let c: string | undefined = b; c; c = parents[c]) if (c === a) return true;
    return false;
  };
  const known = (sha: string) => { for (let c: string | undefined = sha; c; c = parents[c]) state.known.add(c); };
  const resolve = (ref: string) => {
    const r = ref.replace(/\^\{commit\}$/, "");
    return state.local.get(r) ?? (state.known.has(r) ? r : "");
  };
  const d: MergeDeps = {
    api: async (path) => {
      if (state.apiDown) throw new Error("timeout");
      if (path === `/repos/${REPO}/pulls/13`) return { status: 200, body: pull };
      // The head's tests.yml: its text, none (undefined or null: 404), or 0 (no answer).
      if (path === `/repos/${REPO}/contents/.github/workflows/tests.yml?ref=${H1}`) {
        if (over.yml === 0) return { status: 502, body: null };
        if (over.yml == null) return { status: 404, body: null };
        return { status: 200, body: { encoding: "base64", content: Buffer.from(over.yml).toString("base64") } };
      }
      if (path.startsWith(`/repos/${REPO}/commits/${H1}/check-runs`)) {
        const name = new URL(`http://x${path}`).searchParams.get("check_name");
        if (name === "pcjobs-windows" && over.winStatus) return { status: over.winStatus, body: { message: "Server Error" } };
        const mine = name ? runs.filter((r: any) => r?.name === name) : runs;
        return { status: 200, body: { total_count: mine.length, check_runs: mine } };
      }
      return { status: 404, body: null };
    },
    git: async (args, o) => {
      state.calls.push(args);
      const cmd = args.includes("fetch") ? "fetch" : args[0];
      if (cmd === "fetch") {
        expect(o?.ssh).toBe(true);
        if (state.fetchFails) return { code: 128, out: "", err: "ssh: connect to host github.com port 22: Connection timed out" };
        for (const spec of args.filter((a) => a.startsWith("+") && a.includes(":"))) {
          const [src, dst] = spec.slice(1).split(":");
          // main by its name; the tapped commit by its sha, which GitHub has when it's the branch's head
          const sha = src === "refs/heads/main" ? state.main : src === state.prHead || src.startsWith("refs/") ? state.prHead : "";
          if (!sha) return { code: 128, out: "", err: `fatal: remote error: upload-pack: not our ref ${src}` };
          state.local.set(dst, sha); known(sha);
        }
        return { code: 0, out: "", err: "" };
      }
      if (cmd === "rev-parse") { const s = resolve(args[args.length - 1]); return { code: s ? 0 : 1, out: s ? `${s}\n` : "", err: "" }; }
      if (cmd === "merge-base") {
        const [a, b] = args.slice(-2).map((x) => resolve(x) || x);
        return { code: isAncestor(a, b) ? 0 : 1, out: "", err: "" };
      }
      if (cmd === "push") {
        expect(o?.ssh).toBe(true);
        state.pushes.push(args);
        if (state.stopAtPush) throw new Error("pushed while stopped");
        if (state.pushSays) {
          if (state.pushSays.lands) state.main = H1;
          return { code: state.pushSays.code, out: "", err: state.pushSays.err };
        }
        const [sha, dst] = args[args.length - 1].split(":");
        expect(dst).toBe("refs/heads/main");
        if (!isAncestor(state.main, sha)) return { code: 1, out: "!\trefs/heads/main", err: " ! [rejected] (non-fast-forward)" };
        state.main = sha;
        return { code: 0, out: `\t${sha}:refs/heads/main\t${state.main}`, err: "" };
      }
      return { code: 1, out: "", err: `unexpected git ${args.join(" ")}` };
    },
    stopped: () => state.stopped || state.stopAtPush,
  };
  return { d, state };
}
const L = { repo: REPO, pr: 13, head: H1 };

describe("landing his Ship tap", () => {
  test("an up-to-date pull request with its checks passed lands as a fast-forward of main, never forced", async () => {
    const { d, state } = gh();
    expect(await land(d, L)).toEqual({ ok: true, already: false });
    expect(state.main).toBe(H1);
    expect(state.pushes).toHaveLength(1);
    const push = state.pushes[0];
    expect(push).toContain("git@github.com:HyndeSyte/harness.git");
    expect(push[push.length - 1]).toBe(`${H1}:refs/heads/main`);
    expect(push.some((a) => a.startsWith("+") || /force/.test(a))).toBe(false);
    // The fetch checks what it gets.
    expect(state.calls.find((c) => c.includes("fetch"))).toContain("fetch.fsckObjects=true");
  });

  for (const [what, pull, why] of [
    ["closed", { state: "closed", merged: false, base: { ref: "main" }, head: { sha: H1, repo: { full_name: REPO } } }, "the pull request was closed"],
    ["into another branch", { state: "open", merged: false, base: { ref: "dev" }, head: { sha: H1, repo: { full_name: REPO } } }, "it isn't a pull request into main"],
    ["from a fork", { state: "open", merged: false, base: { ref: "main" }, head: { sha: H1, repo: { full_name: "someone/harness" } } }, "its branch isn't in this repository"],
    ["moved on", { state: "open", merged: false, base: { ref: "main" }, head: { sha: H2, repo: { full_name: REPO } } }, "its branch moved on since the card: it has newer commits"],
  ] as const) {
    test(`a pull request ${what} doesn't land`, async () => {
      const { d, state } = gh({ pull });
      expect(await land(d, L)).toEqual({ ok: false, why, again: false });
      expect(state.pushes).toEqual([]);
      expect(state.main).toBe(M1);
    });
  }

  test("its checks must all have passed, from GitHub Actions", async () => {
    const run = (name: string, conclusion: string | null, status = "completed", app = ACTIONS_APP, id = 1) => ({ id, name, status, conclusion, app: { id: app } });
    const cases: [any[], string, boolean][] = [
      [[run("pytest", "success"), run("bun", "success")], "CI hasn't run pr on it", false],
      [[run("pytest", "success"), run("bun", null, "in_progress"), run("pr", "success")], "CI is still running bun on it", true],
      [[run("pytest", "failure"), run("bun", "success"), run("pr", "success")], "CI's pytest check didn't pass on it (failure)", false],
      // A pass posted by another app doesn't count, and the newest run decides.
      [[run("pytest", "failure", "completed", ACTIONS_APP, 1), run("pytest", "success", "completed", 1236702, 9), run("bun", "success"), run("pr", "success")],
        "CI's pytest check didn't pass on it (failure)", false],
    ];
    for (const [runs, why, again] of cases) {
      const { d, state } = gh({ runs });
      expect(await land(d, L)).toEqual({ ok: false, why, again });
      expect(state.pushes).toEqual([]);
    }
    const { d } = gh({ runs: [run("pytest", "failure", "completed", ACTIONS_APP, 1), run("pytest", "success", "completed", ACTIONS_APP, 2), run("bun", "success"), run("pr", "success")] });
    expect(await land(d, L)).toEqual({ ok: true, already: false });
  });

  test("pcjobs-windows, when the head's tests.yml names it or it ran there, must pass too; an older head without it lands as before", async () => {
    const run = (name: string, conclusion: string | null, status = "completed", id = 1) => ({ id, name, status, conclusion, head_sha: H1, app: { id: ACTIONS_APP } });
    const req = () => ["pytest", "bun", "pr"].map((n, i) => run(n, "success", "completed", 100 + i));
    const YML = "jobs:\n  pytest: {}\n  bun: {}\n  pcjobs-windows:\n    runs-on: windows-latest\n";
    const cases: [any[], string | null | 0, string | null, boolean][] = [
      [[...req(), run("pcjobs-windows", "success")], YML, null, false],
      [[...req(), run("pcjobs-windows", "failure")], YML, "CI's pcjobs-windows check didn't pass on it (failure)", false],
      [[...req(), run("pcjobs-windows", "cancelled")], YML, "CI's pcjobs-windows check didn't pass on it (cancelled)", false],
      [[...req(), run("pcjobs-windows", null, "in_progress")], YML, "CI is still running pcjobs-windows on it", true],
      [req(), YML, "CI hasn't run pcjobs-windows on it", false],                       // named, never run: fail closed
      [[...req(), run("pcjobs-windows", "failure")], null, "CI's pcjobs-windows check didn't pass on it (failure)", false],   // ran, not named
      [req(), "jobs:\n  pytest: {}\n  bun: {}\n", null, false],                       // an older workflow
      [req(), null, null, false],
      [req(), 0, "GitHub didn't answer about its checks", true],                        // tests.yml unread: nothing judged
    ];
    for (const [runs, yml, why, again] of cases) {
      const { d, state } = gh({ runs, yml });
      expect(await land(d, L)).toEqual(why === null ? { ok: true, already: false } : { ok: false, why, again });
      expect(state.pushes).toHaveLength(why === null ? 1 : 0);
    }
  });

  test("headChecks: the runs, and whether pcjobs-windows must pass", async () => {
    const run = (name: string, conclusion = "success") => ({ id: 1, name, status: "completed", conclusion, head_sha: H1, app: { id: ACTIONS_APP } });
    const req = ["pytest", "bun", "pr"].map((n) => run(n));
    expect(await headChecks(gh({ runs: req, yml: "jobs:\n  pcjobs-windows: {}\n" }).d, REPO, H1)).toEqual({ runs: req, windows: true });
    expect(await headChecks(gh({ runs: req, yml: "jobs:\n  pytest: {}\n" }).d, REPO, H1)).toEqual({ runs: req, windows: false });
    expect(await headChecks(gh({ runs: [...req, run("pcjobs-windows")] }).d, REPO, H1)).toEqual({ runs: [...req, run("pcjobs-windows")], windows: true });
    expect(await headChecks(gh({ runs: req, yml: 0 }).d, REPO, H1)).toBeNull();
    expect(await headChecks(gh({ runs: req }).d, REPO, H2)).toBe("missing");
  });

  test("the Windows-job gate against a fake GitHub: an API error, no run, a cancelled run, a stale-head run and re-run attempts in both orders all refuse or hold; none passes", async () => {
    const YML = "jobs:\n  pytest: {}\n  bun: {}\n  pcjobs-windows:\n    runs-on: windows-latest\n";
    const run = (conclusion: string | null, status = "completed", id = 1, head = H1) => ({ id, name: "pcjobs-windows", status, conclusion, head_sha: head, app: { id: ACTIONS_APP } });
    const req = () => ["pytest", "bun", "pr"].map((n, i) => ({ id: 100 + i, name: n, status: "completed", conclusion: "success", head_sha: H1, app: { id: ACTIONS_APP } }));
    const cases: [string, { runs: any[]; winStatus?: number }, string, boolean][] = [
      ["API error", { runs: [...req(), run("success")], winStatus: 502 }, "GitHub didn't answer about its checks", true],
      ["API refusal", { runs: [...req(), run("success")], winStatus: 403 }, "GitHub didn't answer about its checks", true],
      ["no run", { runs: req() }, "CI hasn't run pcjobs-windows on it", false],
      ["cancelled", { runs: [...req(), run("cancelled")] }, "CI's pcjobs-windows check didn't pass on it (cancelled)", false],
      ["stale head", { runs: [...req(), run("success", "completed", 1, H2)] }, "CI hasn't run pcjobs-windows on it", false],
      ["no head named", { runs: [...req(), { ...run("success"), head_sha: undefined }] }, "CI hasn't run pcjobs-windows on it", false],
      ["green, then a failed re-run", { runs: [...req(), run("success", "completed", 1), run("failure", "completed", 2)] }, "CI's pcjobs-windows check didn't pass on it (failure)", false],
      ["failed, then a green re-run", { runs: [...req(), run("failure", "completed", 1), run("success", "completed", 2)] }, "CI's pcjobs-windows check didn't pass on it (failure)", false],
      ["green re-run listed first", { runs: [...req(), run("success", "completed", 2), run("failure", "completed", 1)] }, "CI's pcjobs-windows check didn't pass on it (failure)", false],
      ["green, then a re-run going", { runs: [...req(), run("success", "completed", 1), run(null, "in_progress", 2)] }, "CI is still running pcjobs-windows on it", true],
      ["a re-run going, listed first", { runs: [...req(), run(null, "queued", 2), run("success", "completed", 1)] }, "CI is still running pcjobs-windows on it", true],
      ["a stale green beside this head's failure", { runs: [...req(), run("success", "completed", 2, H2), run("failure", "completed", 1)] }, "CI's pcjobs-windows check didn't pass on it (failure)", false],
    ];
    for (const [, c, why, again] of cases) {
      const { d, state } = gh({ ...c, yml: YML });
      expect(await land(d, L)).toEqual({ ok: false, why, again });
      expect(state.pushes).toEqual([]);
      // The Ship card reads the same: headChecks, then judgeChecks.
      const h = await headChecks(d, REPO, H1);
      if (c.winStatus) { expect(h).toBeNull(); continue; }
      expect(h).not.toBeNull();
      const w = judgeChecks((h as any).runs, (h as any).windows).find((x) => x.name === "pcjobs-windows")!;
      expect(w.state).not.toBe("passed");
    }
    // A stale-head run that didn't pass isn't this head's either, and doesn't make an older workflow wait.
    const old = gh({ runs: [...req(), run("failure", "completed", 1, H2)], yml: "jobs:\n  pytest: {}\n" });
    expect(await land(old.d, L)).toEqual({ ok: true, already: false });
  });

  test("when GitHub or the fetch doesn't answer, nothing is pushed, and a new card can follow", async () => {
    const a = gh(); a.state.apiDown = true;
    expect(await land(a.d, L)).toEqual({ ok: false, why: "GitHub didn't answer about the pull request", again: true });
    expect(a.state.calls).toEqual([]);
    const f = gh(); f.state.fetchFails = true;
    const r = await land(f.d, L);
    expect(r).toMatchObject({ ok: false, again: true });
    expect((r as any).why).toContain("the link couldn't fetch it from GitHub (ssh: connect to host github.com port 22");
    expect(f.state.pushes).toEqual([]);
  });

  test("a branch main has moved past doesn't land: nothing on main is lost or merged in", async () => {
    // main moved to X1, which the branch doesn't have.
    const { d, state } = gh({ main: X1, parents: { [M1]: M0, [H1]: M1, [X1]: M1 } });
    expect(await land(d, L)).toEqual({ ok: false, why: "main moved on since its branch was made: the branch needs main merged in, then a new Ship card", again: false });
    expect(state.pushes).toEqual([]);
    expect(state.main).toBe(X1);
  });

  test("a commit already in main counts as landed, with nothing pushed", async () => {
    const { d, state } = gh({ main: H2 });
    expect(await land(d, L)).toEqual({ ok: true, already: true });
    expect(state.pushes).toEqual([]);
    const merged = gh({ main: H1, pull: { state: "closed", merged: true, base: { ref: "main" }, head: { sha: H1, repo: { full_name: REPO } } } });
    expect(await land(merged.d, L)).toEqual({ ok: true, already: true });
    // GitHub says merged, but main doesn't have it: refused.
    const odd = gh({ pull: { state: "closed", merged: true, base: { ref: "main" }, head: { sha: H1, repo: { full_name: REPO } } } });
    expect(await land(odd.d, L)).toEqual({ ok: false, why: "GitHub says it's merged, but main doesn't have that commit", again: false });
  });

  test("Stop is read again right before the push", async () => {
    const { d, state } = gh();
    let reads = 0;
    d.stopped = () => ++reads > 0 && true;
    expect(await land(d, L)).toEqual({ ok: false, why: "everything is stopped", again: false, stopped: true });
    expect(state.pushes).toEqual([]);
    expect(reads).toBe(1);
  });

  test("a refused push says why in his words; a lost answer is settled by reading main", async () => {
    const cases: [{ code: number; err: string; lands?: boolean }, any][] = [
      [{ code: 1, err: " ! [rejected]        cccc -> main (fetch first)" }, { ok: false, why: "main moved on while it was landing: the branch needs main merged in, then a new Ship card", again: false }],
      [{ code: 128, err: "ERROR: Permission to HyndeSyte/harness.git denied to deploy key\nfatal: Could not read from remote repository." },
        { ok: false, why: "GitHub refused the link's deploy key, so shipping needs its key set up again", again: false }],
      [{ code: 1, err: "remote: error: GH013: Repository rule violations found for refs/heads/main." }, { ok: false, why: "GitHub refused it (remote: error: GH013: Repository rule violations found for refs/heads/main.)", again: false }],
      [{ code: 128, err: "Connection to github.com closed by remote host." }, { ok: false, why: "the push to GitHub failed (Connection to github.com closed by remote host.)", again: true }],
      [{ code: 128, err: "Connection to github.com closed by remote host.", lands: true }, { ok: true, already: false }],
    ];
    for (const [says, want] of cases) {
      const { d, state } = gh();
      state.pushSays = says;
      expect(await land(d, L)).toEqual(want);
      expect(state.pushes).toHaveLength(1);
    }
  });

  test("inMain reads main over SSH: yes, no, or can't tell", async () => {
    const a = gh({ main: H2 });
    a.state.known.add(H1);
    expect(await inMain(a.d, REPO, H1)).toBe(true);
    const b = gh();
    expect(await inMain(b.d, REPO, H1)).toBe(false);
    const c = gh(); c.state.fetchFails = true;
    expect(await inMain(c.d, REPO, H1)).toBeNull();
  });
});

// The same, with real git: a bare repository stands in for GitHub.
describe("landing, with real git", () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sh = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  function world() {
    const root = mkdtempSync(join(tmpdir(), "land-"));
    const origin = join(root, "origin.git"), work = join(root, "work"), link = join(root, "link.git");
    for (const [dir, bare] of [[origin, true], [work, false], [link, true]] as const)
      Bun.spawnSync(["git", "init", "--quiet", ...(bare ? ["--bare"] : []), "-b", "main", dir], { env });
    sh(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");   // as GitHub allows: a commit fetched by its sha
    sh(work, "config", "user.email", "t@example.com");
    sh(work, "config", "user.name", "t");
    const commit = (file: string) => {
      writeFileSync(join(work, file), file);
      sh(work, "add", "-A");
      sh(work, "commit", "--quiet", "-m", file);
      return sh(work, "rev-parse", "HEAD");
    };
    const m1 = commit("a");
    sh(work, "push", "--quiet", origin, "HEAD:refs/heads/main");
    const h1 = commit("b");
    sh(work, "push", "--quiet", origin, "HEAD:refs/pull/13/head");
    const runs = ["pytest", "bun", "pr"].map((name, i) => ({ id: i, name, status: "completed", conclusion: "success", app: { id: ACTIONS_APP } }));
    const d: MergeDeps = {
      api: async (path) => path.endsWith("/pulls/13")
        ? { status: 200, body: { state: "open", merged: false, base: { ref: "main" }, head: { sha: h1, repo: { full_name: REPO } } } }
        : path.includes("/check-runs") ? (() => {
          const name = new URL(`http://x${path}`).searchParams.get("check_name");
          const mine = runs.filter((r) => r.name === name);
          return { status: 200, body: { total_count: mine.length, check_runs: mine } };
        })() : { status: 404, body: null },
      git: async (args) => {
        const p = Bun.spawn(["git", "-C", link, ...args], { stdout: "pipe", stderr: "pipe", env });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, out, err };
      },
      stopped: () => false,
      remote: () => origin,
    };
    return { d, origin, work, m1, h1, commit };
  }

  test("main fast-forwards to exactly the commit he tapped Ship for", async () => {
    const w = world();
    expect(await land(w.d, { repo: REPO, pr: 13, head: w.h1 })).toEqual({ ok: true, already: false });
    expect(sh(w.origin, "rev-parse", "refs/heads/main")).toBe(w.h1);
    expect(await inMain(w.d, REPO, w.h1)).toBe(true);
    expect(await land(w.d, { repo: REPO, pr: 13, head: w.h1 })).toEqual({ ok: true, already: true });
  }, 60_000);

  test("a main that moved on is never rewound or merged into, even when it moves mid-landing", async () => {
    const w = world();
    sh(w.work, "checkout", "--quiet", "-b", "other", w.m1);
    const x = w.commit("x");
    sh(w.work, "push", "--quiet", w.origin, "HEAD:refs/heads/main");
    const r = await land(w.d, { repo: REPO, pr: 13, head: w.h1 });
    expect(r).toMatchObject({ ok: false, again: false, why: expect.stringContaining("main moved on since its branch was made") });
    expect(sh(w.origin, "rev-parse", "refs/heads/main")).toBe(x);
    expect(await inMain(w.d, REPO, w.h1)).toBe(false);
    // main moves between the link's checks and its push: git refuses the push.
    const v = world();
    v.d.stopped = () => {
      sh(v.work, "checkout", "--quiet", "-b", "late", v.m1);
      v.commit("late");
      sh(v.work, "push", "--quiet", v.origin, "HEAD:refs/heads/main");
      return false;
    };
    const late = await land(v.d, { repo: REPO, pr: 13, head: v.h1 });
    expect(late).toEqual({ ok: false, why: "main moved on while it was landing: the branch needs main merged in, then a new Ship card", again: false });
    expect(sh(v.origin, "rev-parse", "refs/heads/main")).not.toBe(v.h1);
  }, 60_000);
});

describe("what GitHub says", () => {
  test("to the deploy key over SSH: it knows it, it doesn't, or it can't be reached", () => {
    expect(keyAnswer("Hi HyndeSyte/harness! You've successfully authenticated, but GitHub does not provide shell access.", REPO)).toBe(true);
    expect(keyAnswer("Hi HyndeSyte! You've successfully authenticated, but GitHub does not provide shell access.", REPO)).toBeNull();
    expect(keyAnswer("git@github.com: Permission denied (publickey).", REPO)).toBe(false);
    expect(keyAnswer("ssh: connect to host github.com port 22: Network is unreachable", REPO)).toBeNull();
  });

  test("about a pull request: its commits, its files, the parts that matter most, its title, and what the tap installs", async () => {
    const B = M0;                                   // its base
    const files = ["cain/rootfs/opt/cain/link/core.ts", "cain/rootfs/opt/cain/CLAUDE.md", ".github/workflows/tests.yml",
      "cain/config.yaml", "cain/CHANGELOG.md", "cain/tests/merge.test.ts"].map((filename) => ({ filename }));
    const cfg = (v: string) => ({ status: 200, body: { encoding: "base64", content: Buffer.from(`name: X\nversion: "${v}"\nslug: x\n`).toString("base64") } });
    const api = async (path: string) => path === `/repos/${REPO}/pulls/13`
      ? { status: 200, body: { head: { sha: H1.toUpperCase() }, base: { sha: B }, commits: 3, changed_files: 6 } }
      : path === `/repos/${REPO}/pulls/13/files?per_page=100&page=1` ? { status: 200, body: files }
      : path === `/repos/${REPO}/contents/cain/config.yaml?ref=${B}` ? cfg("0.10.0")
      : path === `/repos/${REPO}/contents/cain/config.yaml?ref=${H1}` ? cfg("0.11.0")
      : path.startsWith(`/repos/${REPO}/contents/harness/config.yaml?ref=`) ? cfg("0.23.0")
      : { status: 404, body: null };
    expect(await facts({ api }, REPO, 13)).toEqual({ head: H1, commits: 3, files: 6,
      areas: ["Cain's link", "Cain's rules", "GitHub's workflows"], title: "", bumps: [{ app: "Cain", version: "0.11.0" }], merged: false });
    expect(await facts({ api: async () => ({ status: 500, body: null }) }, REPO, 13)).toBeNull();
    // The files are read for the parts they touch, 3 pages at most; the versions never come
    // from them, so a long list costs only a part not named.
    const asked: string[] = [];
    const many = Array.from({ length: 400 }, (_, i) => ({ filename: i === 399 ? "cain/rootfs/opt/cain/CLAUDE.md" : `harness/app/f${i}.py` }));
    const paged = async (path: string) => {
      asked.push(path);
      const page = Number(new URL(`http://x${path}`).searchParams.get("page"));
      return path === `/repos/${REPO}/pulls/13`
        ? { status: 200, body: { head: { sha: H1 }, base: { sha: B }, commits: 1, changed_files: 400, title: "Harness 0.24.0: the digest says less" } }
        : path.startsWith(`/repos/${REPO}/pulls/13/files?`) ? { status: 200, body: many.slice((page - 1) * 100, page * 100) }
        : path === `/repos/${REPO}/contents/harness/config.yaml?ref=${H1}` ? cfg("0.24.0")
        : path.startsWith(`/repos/${REPO}/contents/`) ? cfg(path.includes("harness") ? "0.23.0" : "0.10.0")
        : { status: 404, body: null };
    };
    const f = await facts({ api: paged }, REPO, 13);
    expect(f).toMatchObject({ title: "Harness 0.24.0: the digest says less", files: 400, bumps: [{ app: "Harness", version: "0.24.0" }] });
    expect(f!.areas).toEqual([]);
    expect(asked.filter((p) => p.includes("/files?")).length).toBe(3);
    // The versions are read at the head the card names, not the one GitHub gives later.
    asked.length = 0;
    await facts({ api: paged }, REPO, 13, H2);
    expect(asked).toContain(`/repos/${REPO}/contents/cain/config.yaml?ref=${H2}`);
    expect(asked.some((p) => p.endsWith(`?ref=${H1}`))).toBe(false);
  });

  test("what the tap installs: each App's version at the head against its base, read at those very commits", async () => {
    const B = M0;
    const at = (map: Record<string, string | null | number>) => async (path: string) => {
      for (const [k, v] of Object.entries(map)) if (path === `/repos/${REPO}/contents/${k}`) {
        if (v === null) return { status: 500, body: null };
        if (v === 404) return { status: 404, body: { message: "Not Found" } };
        return { status: 200, body: { encoding: "base64", content: Buffer.from(String(v)).toString("base64") } };
      }
      return { status: 404, body: null };
    };
    const v = (x: string) => `name: X\nversion: ${x}\nslug: x\n`;
    const both = (cb: string, ch: string, hb: string, hh: string) => at({
      [`cain/config.yaml?ref=${B}`]: v(cb), [`cain/config.yaml?ref=${H1}`]: v(ch),
      [`harness/config.yaml?ref=${B}`]: v(hb), [`harness/config.yaml?ref=${H1}`]: v(hh) });
    expect(await bumpsAt({ api: both('"0.10.0"', '"0.11.0"', "0.23.0", "0.23.0") }, REPO, B, H1)).toEqual([{ app: "Cain", version: "0.11.0" }]);
    expect(await bumpsAt({ api: both("0.10.0", "'0.11.0'  # minor", '"0.23.0"', '"0.24.0"') }, REPO, B, H1))
      .toEqual([{ app: "Cain", version: "0.11.0" }, { app: "Harness", version: "0.24.0" }]);   // Cain first
    // The same version at both ends installs nothing, whatever the diff did to its line.
    expect(await bumpsAt({ api: both('"0.10.0"', "0.10.0", "0.23.0", "0.23.0") }, REPO, B, H1)).toEqual([]);
    // Can't be told: a read GitHub didn't answer, a version that isn't one, or not a commit.
    expect(await bumpsAt({ api: at({ [`cain/config.yaml?ref=${B}`]: v("0.10.0"), [`cain/config.yaml?ref=${H1}`]: null,
      [`harness/config.yaml?ref=${B}`]: v("0.23.0"), [`harness/config.yaml?ref=${H1}`]: v("0.23.0") }) }, REPO, B, H1)).toBeNull();
    expect(await bumpsAt({ api: both("0.10.0", '"soon"', "0.23.0", "0.23.0") }, REPO, B, H1)).toBeNull();
    expect(await bumpsAt({ api: both("0.10.0", "0.11.0", "0.23.0", "0.23.0") }, REPO, "main", H1)).toBeNull();
    // An App with no config.yaml at the head installs nothing; one new at the head does.
    expect(await bumpsAt({ api: at({ [`cain/config.yaml?ref=${B}`]: 404, [`cain/config.yaml?ref=${H1}`]: v("0.1.0"),
      [`harness/config.yaml?ref=${B}`]: v("0.23.0"), [`harness/config.yaml?ref=${H1}`]: 404 }) }, REPO, B, H1))
      .toEqual([{ app: "Cain", version: "0.1.0" }]);
  });

  test("a rate limit or a refusal from GitHub isn't asked again at once; anything else once more", async () => {
    for (const status of [403, 429]) {
      let calls = 0;
      expect(await checkRuns({ api: async () => { calls++; return { status, body: { message: "API rate limit exceeded" } }; } }, REPO, H1)).toBeNull();
      expect(calls).toBe(3);                                   // one question per required check, none asked twice
    }
    let calls = 0;
    expect(await checkRuns({ api: async () => { calls++; return { status: 502, body: null }; } }, REPO, H1)).toBeNull();
    expect(calls).toBe(6);                                     // each asked once more
  });
});

describe("the checks, read one way for the landing and the Ship card", () => {
  const run = (name: string, conclusion: string | null, status = "completed", app = ACTIONS_APP, id = 1) => ({ id, name, status, conclusion, app: { id: app } });
  test("each required check's newest run from GitHub Actions: passed, running, failed or not run", () => {
    expect(judgeChecks([run("pytest", "success"), run("bun", "success"), run("pr", "success")]).map((c) => c.state)).toEqual(["passed", "passed", "passed"]);
    expect(judgeChecks([run("pytest", "success"), run("bun", null, "in_progress")])).toEqual([
      { name: "pytest", state: "passed" }, { name: "bun", state: "running" }, { name: "pr", state: "missing" }]);
    expect(judgeChecks([run("pytest", "skipped"), run("bun", null), run("pr", "neutral")])).toEqual([
      { name: "pytest", state: "failed", conclusion: "skipped" }, { name: "bun", state: "failed", conclusion: "no result" },
      { name: "pr", state: "failed", conclusion: "neutral" }]);
    // Another app's pass doesn't count, and the newest run decides.
    expect(judgeChecks([run("pytest", "failure", "completed", ACTIONS_APP, 1), run("pytest", "success", "completed", 1236702, 9)])[0].state).toBe("failed");
    expect(judgeChecks([run("pytest", "failure", "completed", ACTIONS_APP, 1), run("pytest", "success", "completed", ACTIONS_APP, 2)])[0].state).toBe("passed");
  });

  test("the runs, one answer per required check by its name, as the landing reads them: missing, no answer, or the list", async () => {
    const seen: string[] = [];
    const byName: Record<string, any[]> = { pytest: [run("pytest", "success")], bun: [run("bun", "success")], pr: [] };
    const api = async (path: string) => {
      seen.push(path);
      if (!path.includes(H1)) return { status: 404, body: null };
      const name = new URL(`http://x${path}`).searchParams.get("check_name")!;
      return { status: 200, body: { total_count: byName[name].length, check_runs: byName[name] } };
    };
    expect(await checkRuns({ api }, REPO, H1)).toEqual([...byName.pytest, ...byName.bun]);
    expect([...seen].sort()).toEqual(["bun", "pr", "pytest"].map((n) => `/repos/${REPO}/commits/${H1}/check-runs?check_name=${n}&app_id=${ACTIONS_APP}&filter=latest&per_page=100&page=1`));
    expect(await checkRuns({ api }, REPO, H2)).toBe("missing");
    expect(await checkRuns({ api: async () => ({ status: 200, body: { message: "odd" } }) }, REPO, H1)).toBeNull();
    expect(await checkRuns({ api: async () => { throw new Error("timeout"); } }, REPO, H1)).toBeNull();
  });

  test("an answer whose count and list disagree is never judged, so part of the runs can't read as passed", async () => {
    const one = (name: string, total: number | undefined, list: any[]) => async (path: string) => {
      const n = new URL(`http://x${path}`).searchParams.get("check_name")!;
      return { status: 200, body: n === name ? { total_count: total, check_runs: list } : { total_count: 1, check_runs: [run(n, "success")] } };
    };
    // GitHub says 300 pytest runs and sends 1 (a short page): none judged, never "passed".
    expect(await checkRuns({ api: one("pytest", 300, [run("pytest", "success")]) }, REPO, H1)).toBeNull();
    // No count, or one that isn't a whole number: the same.
    expect(await checkRuns({ api: one("pytest", undefined, [run("pytest", "success")]) }, REPO, H1)).toBeNull();
    // Whole answers: judged as the landing judges them, a failed newest run included.
    const whole = await checkRuns({ api: one("pytest", 2, [run("pytest", "success", "completed", ACTIONS_APP, 1), run("pytest", "failure", "completed", ACTIONS_APP, 2)]) }, REPO, H1);
    expect(judgeChecks(whole as any[]).map((c) => c.state)).toEqual(["failed", "passed", "passed"]);
  });

  test("more than 100 runs of a check are read page by page, whole, or not judged at all (ChatGPT's third look)", async () => {
    const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => run("pytest", "success", "completed", ACTIONS_APP, from + i));
    const paged = (pages: { total: number; runs: any[] }[]) => async (path: string) => {
      const q = new URL(`http://x${path}`).searchParams;
      if (q.get("check_name") !== "pytest") return { status: 200, body: { total_count: 1, check_runs: [run(q.get("check_name")!, "success")] } };
      const p = pages[Number(q.get("page")) - 1];
      return p ? { status: 200, body: { total_count: p.total, check_runs: p.runs } } : { status: 500, body: null };
    };
    // 101 runs over two pages that agree: all read, and judged.
    const whole = await checkRuns({ api: paged([{ total: 101, runs: many(100) }, { total: 101, runs: [run("pytest", "failure", "completed", ACTIONS_APP, 500)] }]) }, REPO, H1);
    expect(Array.isArray(whole) ? whole.filter((r: any) => r.name === "pytest").length : whole).toBe(101);
    expect(judgeChecks(whole as any[])[0]).toEqual({ name: "pytest", state: "failed", conclusion: "failure" });
    // A total that shifts between pages, a run that comes twice, or a page that doesn't come: none judged.
    expect(await checkRuns({ api: paged([{ total: 101, runs: many(100) }, { total: 102, runs: many(2, 101) }]) }, REPO, H1)).toBeNull();
    expect(await checkRuns({ api: paged([{ total: 101, runs: many(100) }, { total: 101, runs: many(1, 100) }]) }, REPO, H1)).toBeNull();
    expect(await checkRuns({ api: paged([{ total: 101, runs: many(100) }]) }, REPO, H1)).toBeNull();
    // 501 runs over 6 pages that agree: read whole (up to 1,000), and judged.
    const big = Array.from({ length: 6 }, (_, p) => ({ total: 501, runs: many(p < 5 ? 100 : 1, 1 + p * 100) }));
    const read = await checkRuns({ api: paged(big) }, REPO, H1);
    expect(Array.isArray(read) ? read.filter((r: any) => r.name === "pytest").length : read).toBe(501);
  });
});

describe("review fixes (Fable, Nov 13)", () => {
  test("a key GitHub refuses, a host key that isn't GitHub's, or a pull request that isn't there won't mend by waiting", async () => {
    const said = async (err: string) => {
      const { d } = gh();
      const git = d.git;
      d.git = async (args, o) => args.includes("fetch") ? { code: 128, out: "", err } : git(args, o);
      return land(d, L);
    };
    const refused = { ok: false, why: "GitHub refused the link's deploy key, so shipping needs its key set up again", again: false };
    expect(await said("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toEqual(refused);
    expect(await said("ERROR: Repository not found.\nfatal: Could not read from remote repository.")).toEqual(refused);
    expect(await said("Host key verification failed.\nfatal: Could not read from remote repository."))
      .toEqual({ ok: false, why: "GitHub's SSH host key isn't one the link knows, so it won't send anything there", again: false });
    expect(await said("ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository."))
      .toMatchObject({ ok: false, again: true });
    // (Opus, Nov 13) A commit GitHub doesn't have, or one that fails the link's own check.
    expect(await said(`fatal: remote error: upload-pack: not our ref ${H1}`)).toEqual({ ok: false, why: "GitHub doesn't have that commit", again: false });
    expect(await said("error: object 1234: badTimezone: invalid author/committer line\nfatal: fsck error in packed object"))
      .toEqual({ ok: false, why: "what GitHub sent failed the link's check (fsck), so it won't land it", again: false });
    const missing = gh();
    missing.d.api = async () => ({ status: 404, body: { message: "Not Found" } });
    expect(await land(missing.d, L)).toEqual({ ok: false, why: "GitHub has no such pull request", again: false });
  });
});
