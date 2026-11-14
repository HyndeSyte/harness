// The laptop's record tools (cain/tools/), run as a laptop session would run them,
// against a keeper on a real git repo standing in for GitHub.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRow, rowHash } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { A, B, PENDING, SA, SB, cleanEnv, rig, sh } from "./rig.ts";

const TOOLS = resolve(import.meta.dir, "../tools");
const REPO = resolve(import.meta.dir, "../..");
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });

// A rig plus a laptop's clone of the record, where the tools run. The tools read the
// real clock (a hold ends after a day idle, a renew is due after 6 hours), so the
// keeper's clock starts at the real time too, and hrs(n) counts from there. A fixed
// start (the rig's T0) made these tests fail every run from a day after T0 on.
function laptop() {
  const r = rig();
  const t0 = new Date();
  r.at(t0);
  const hrs = (n: number) => new Date(t0.getTime() + n * 3_600_000);
  const clone = join(r.root, "laptop");
  sh(["git", "-c", "core.autocrlf=false", "clone", "--quiet", r.remote, clone], r.root);
  sh(["git", "config", "user.name", "HyndeSyte"], clone);
  sh(["git", "config", "user.email", "HyndeSyte@users.noreply.github.com"], clone);
  const tool = (name: string, args: string[], o: { session?: string; input?: string; env?: Record<string, string> } = {}) => {
    const env = cleanEnv({ RECORD_CLONE: clone, RECORD_SEND_POLL_MS: "100", RECORD_HOLDS_FETCH_S: "0",
      ...(o.session ? { CLAUDE_CODE_SESSION_ID: o.session } : {}), ...o.env });
    const p = Bun.spawnSync([process.execPath, join(TOOLS, name), ...args], { cwd: r.root, env, stdout: "pipe", stderr: "pipe",
      stdin: o.input === undefined ? "ignore" : Buffer.from(o.input) });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  const inboxNames = () => sh(["git", "ls-tree", "--name-only", "main", "inbox/"], r.remote).split("\n").filter(Boolean);
  return { ...r, t0, hrs, clone, tool, inboxNames };
}

describe("record-send", () => {
  test("stamps who sent it, puts it in the inbox, waits for the keeper and prints what happened", async () => {
    const l = laptop();
    writeFileSync(join(l.root, "req.json"), JSON.stringify({ from: "cain", kind: "change", summary: "Take P33 for the collision fix",
      ops: [take("P33", "dane: build the collision fix (laptop chat, 8:20 AM)", { branches: ["claude/record-holds"] })] }));
    const env = cleanEnv({ RECORD_CLONE: l.clone, RECORD_SEND_POLL_MS: "100", CLAUDE_CODE_SESSION_ID: SA });
    const p = Bun.spawn([process.execPath, join(TOOLS, "record-send.ts"), join(l.root, "req.json"), "--wait", "60"], { cwd: l.root, env, stdout: "pipe", stderr: "pipe" });
    // The keeper's round runs once the request is on "GitHub".
    const started = Date.now();
    while (l.inboxNames().length === 0 && Date.now() - started < 30_000) await Bun.sleep(100);
    const [name] = l.inboxNames();
    expect(name).toMatch(new RegExp(`^inbox/\\d{8}T\\d{6}Z-${SA}-[0-9a-f]{6}\\.json$`));
    const sent = JSON.parse(sh(["git", "show", `main:${name}`], l.remote));
    expect(sent.from).toBe(A);                       // stamped by the tool, whatever the file said
    expect(sent.id).toMatch(/^laptop-\d{8}T\d{6}Z-0ee803c1-[0-9a-f]{6}$/);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(await p.exited).toBe(0);
    const out = await new Response(p.stdout).text();
    expect(out).toContain(`sent ${sent.id} as ${name}`);
    expect(out.trim().split("\n").at(-1)).toBe("done");
    expect(l.holds()).toMatchObject({ P33: { holder: A, branches: ["claude/record-holds"] } });
  }, 60_000);

  test("a take behind Cain's job is reported as waiting, then done once the job lets go", async () => {
    const l = laptop();
    l.cain({ id: "cain-job-take", ops: [take("P33", "his Start tap", { job: "build cse_01X" })] });
    cycle(l.cfg);
    writeFileSync(join(l.root, "req.json"), JSON.stringify({ kind: "change", summary: "Take P33", ops: [take("P33", "dane: finish it here (laptop chat)")] }));
    const env = cleanEnv({ RECORD_CLONE: l.clone, RECORD_SEND_POLL_MS: "100", CLAUDE_CODE_SESSION_ID: SA });
    const p = Bun.spawn([process.execPath, join(TOOLS, "record-send.ts"), join(l.root, "req.json"), "--wait", "60"], { cwd: l.root, env, stdout: "pipe", stderr: "pipe" });
    const started = Date.now();
    while (l.inboxNames().length === 0 && Date.now() - started < 30_000) await Bun.sleep(100);
    cycle(l.cfg);                                   // logged as waiting
    await Bun.sleep(1_000);
    l.cain({ id: "cain-job-done", ops: [{ op: "release", item: "P33" }] });
    cycle(l.cfg);                                   // the job ends; the take goes through
    expect(await p.exited).toBe(0);
    const lines = (await new Response(p.stdout).text()).trim().split("\n");
    expect(lines[1]).toBe("waiting: P33 is held by cain (a job: build cse_01X); this take waits until the job's hold ends. Don't act on it until it says done.");
    expect(lines.at(-1)).toBe("done");
  }, 60_000);

  test("sends nothing the keeper would turn away, and says why", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(l.cfg);
    writeFileSync(join(l.root, "req.json"), JSON.stringify({ kind: "change", summary: "Rebase PR #3", ops: [take("P33", "chat: rebase PR #3")] }));
    const r = l.tool("record-send.ts", [join(l.root, "req.json")], { session: SB });
    expect(r.code).toBe(1);
    expect(r.out).toBe(`not sent: refused: P33 is held by ${A}`);
    expect(l.inboxNames()).toEqual([]);
    // No session, nothing sent.
    expect(l.tool("record-send.ts", [join(l.root, "req.json")]).code).toBe(2);
  }, 60_000);

  test("--row prints the base a row edit needs", () => {
    const l = laptop();
    const r = l.tool("record-send.ts", ["--row", "P33"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([rowHash(openRow(PENDING, "P33")!), openRow(PENDING, "P33")]);
  }, 30_000);
});

describe("record-holds", () => {
  test("prints the session's holds, and tells it once when one has ended", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: build the collision fix", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    const hook = (session: string) => l.tool("record-holds.ts", ["--hook"], { input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" }) });
    const first = hook(SA);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Record holds for this session (${A})`);
    expect(first.out).toContain("- P33, since ");
    expect(first.out).toContain("branches claude/record-holds; for: dane: build the collision fix");
    expect(hook(SB)).toEqual({ code: 0, out: "", err: "" });   // nothing held: nothing said
    // A day passes without a word from the session; the keeper ends the hold.
    l.running(l.hrs(25));
    cycle(l.cfg);
    const after = l.tool("record-holds.ts", [], { session: SA });
    expect(after.out).toContain("Your hold on P33 has ended");
    expect(after.out).toContain("Don't act on P33 or push its branches unless Dane asks you to take it again");
    expect(l.tool("record-holds.ts", [], { session: SA }).out).toBe(`This session (${A}) holds nothing in the record.`);
    // Not set up on this machine: the hook stays quiet and never blocks the prompt.
    const bare = Bun.spawnSync([process.execPath, join(TOOLS, "record-holds.ts"), "--hook"], { env: cleanEnv(), stdin: Buffer.from(JSON.stringify({ session_id: SA })), stdout: "pipe" });
    expect([bare.exitCode, bare.stdout.toString()]).toEqual([0, ""]);
  }, 60_000);

  test("the holder's hook shows a note filed on its item once, and its next write waits until it has read one", () => {
    const l = laptop();
    // A note from before the session held P33: shown on its first look all the same.
    l.cain({ id: "cain-old-note", ops: [{ op: "note", item: "P33", text: "Dane, Nov 10: the drill comes first" }] });
    cycle(l.cfg);
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: the collision fix")] }]);
    cycle(l.cfg);
    const hook = () => l.tool("record-holds.ts", ["--hook"], { input: JSON.stringify({ session_id: SA, hook_event_name: "UserPromptSubmit" }) });
    expect(hook().out).toContain("from cain: Dane, Nov 10: the drill comes first");
    expect(hook().out).not.toContain("New notes");
    // Dane tells another session about P33; its row edit is refused, his words go in as a note.
    l.inbox(["2.json", { id: "lap-b-edit", from: B, ops: [{ op: "row", item: "P33", base: rowHash(openRow(PENDING, "P33")!), set: { "Next step": "x" } }] }],
      ["3.json", { id: "lap-b-note", from: B, ops: [{ op: "note", item: "P33", text: "Dane, other chat: PR #3 rebases after the collision fix" }] }]);
    cycle(l.cfg);
    expect(l.states("lap-b-edit")).toEqual(["refused"]);
    const next = hook();
    expect(next.code).toBe(0);
    expect(next.out).toContain("New notes on P33 since you last looked. Read them before you change P33:");
    expect(next.out).toMatch(new RegExp(`^- .+, from ${B}: Dane, other chat: PR #3 rebases after the collision fix$`, "m"));
    expect(hook().out).not.toContain("New notes");   // shown once
    // A note filed in the middle of a turn: the holder's next write shows it and waits once.
    l.cain({ id: "cain-p33-note", ops: [{ op: "note", item: "P33", text: "Dane in Discord: hold the ship until the drill" }] });
    cycle(l.cfg);
    writeFileSync(join(l.root, "req.json"), JSON.stringify({ kind: "change", summary: "P33 next step",
      ops: [{ op: "row", item: "P33", base: rowHash(openRow(PENDING, "P33")!), set: { "Next step": "PR A is open" } }] }));
    const held = l.tool("record-send.ts", [join(l.root, "req.json"), "--wait", "0"], { session: SA });
    expect(held.code).toBe(1);
    expect(held.out).toContain("from cain: Dane in Discord: hold the ship until the drill");
    expect(held.out.split("\n").at(-1)).toBe("not sent: read the notes above first, then send it again if it still stands");
    expect(l.inboxNames()).toEqual([]);
    const again = l.tool("record-send.ts", [join(l.root, "req.json"), "--wait", "0"], { session: SA });
    expect(again.out).toMatch(/^sent laptop-/m);
    expect(l.inboxNames()).toHaveLength(1);
    expect(hook().out).not.toContain("New notes");   // already shown by the send
  }, 90_000);

  test("--renew renews its holds with renew ops, at most every 6 hours", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "dane: build it", { branches: ["claude/a"] })] }]);
    cycle(l.cfg);
    expect(l.tool("record-holds.ts", ["--renew"], { session: SA }).code).toBe(0);
    const [name] = l.inboxNames();
    expect(JSON.parse(sh(["git", "show", `main:${name}`], l.remote)).ops).toEqual([{ op: "renew", item: "P33" }]);   // never a take
    l.running(l.hrs(2));
    cycle(l.cfg);
    expect(l.holds().P33).toMatchObject({ holder: A, for: "dane: build it", branches: ["claude/a"], taken: l.t0.toISOString(), renewed: l.hrs(2).toISOString() });
    l.tool("record-holds.ts", ["--renew"], { session: SA });
    expect(l.inboxNames()).toEqual([]);   // renewed within 6 hours: nothing sent
  }, 60_000);
});

describe("the pre-push hook", () => {
  const pushLine = (branch: string) => `refs/heads/${branch} ${"1".repeat(40)} refs/heads/${branch} ${"0".repeat(40)}\n`;

  test("refuses a branch the session doesn't hold", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    const hook = (session: string | undefined, input: string) => l.tool("record-prepush.ts", ["origin", "https://github.com/HyndeSyte/harness.git"], { session, input });
    expect(hook(SA, pushLine("claude/record-holds")).code).toBe(0);
    const other = hook(SA, pushLine("claude/link-cards"));
    expect(other.code).toBe(1);
    expect(other.err).toStartWith(`push refused: claude/link-cards isn't in any hold of this session (${A})`);
    const theirs = hook(SB, pushLine("claude/record-holds"));
    expect(theirs.code).toBe(1);
    expect(theirs.err).toStartWith(`push refused: claude/record-holds is held with P33 by ${A}`);
    expect(hook(SA, pushLine("main")).code).toBe(1);
    expect(hook(SA, `refs/tags/v1 ${"1".repeat(40)} refs/tags/v1 ${"0".repeat(40)}\n`).code).toBe(1);
    const none = hook(undefined, pushLine("claude/record-holds"));
    expect(none.code).toBe(1);
    expect(none.err).toContain("no Claude Code session id");
    const harness = ["origin", "https://github.com/HyndeSyte/harness.git"];
    expect(l.tool("record-prepush.ts", harness, { session: SA, input: pushLine("claude/record-holds"), env: { RECORD_CLONE: join(l.root, "nowhere") } }).code).toBe(1);
    // Over ssh it's the same repository, and guarded the same way.
    expect(l.tool("record-prepush.ts", ["origin", "git@github.com:HyndeSyte/harness.git"], { session: SA, input: pushLine("claude/link-cards") }).code).toBe(1);
    // Any other repository passes through, session or not: the hook is installed for all of them.
    for (const url of ["https://github.com/HyndeSyte/org.git", "https://github.com/HyndeSyte/harness-notes.git", join(l.root, "elsewhere.git")])
      expect(l.tool("record-prepush.ts", ["origin", url], { input: pushLine("main") })).toEqual({ code: 0, out: "", err: "" });
    // A record clone that follows anything but main is refused.
    sh(["git", "push", "--quiet", "origin", "HEAD:refs/heads/other"], l.clone);
    const side = join(l.root, "side");
    sh(["git", "clone", "--quiet", "--branch", "other", l.remote, side], l.root);
    const wrong = l.tool("record-prepush.ts", harness, { session: SA, input: pushLine("claude/record-holds"), env: { RECORD_CLONE: side } });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("follows origin/other, not the record's main");
  }, 60_000);

  test("installed, it stops a real git push to a branch the session doesn't hold, and lets other repositories by", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    const repo = (name: string) => {
      const origin = join(l.root, `${name}.git`), work = join(l.root, name);
      sh(["git", "init", "--quiet", "--bare", "-b", "main", origin], l.root);
      sh(["git", "clone", "--quiet", origin, work], l.root);
      writeFileSync(join(work, "README.md"), "x\n");
      sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], work);
      sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"], work);
      return { origin, work };
    };
    // Here the harness repository is the one at .../harness.git.
    const guard = { CLAUDE_CODE_SESSION_ID: SA, RECORD_CLONE: l.clone, RECORD_GUARDED_REMOTE: "harness\\.git$" };
    const push = (work: string, branch: string, pre: string[], env: Record<string, string>) =>
      Bun.spawnSync(["git", ...pre, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: work, stdout: "pipe", stderr: "pipe", env: cleanEnv(env) });

    // As the laptop has it: git's global core.hooksPath pointed at cain/tools (no copy, no CAIN_TOOLS).
    const harness = repo("harness"), other = repo("notes");
    const global = ["-c", `core.hooksPath=${TOOLS}`];
    const refused = push(harness.work, "claude/link-cards", global, guard);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("push refused: claude/link-cards isn't in any hold of this session");
    expect(push(harness.work, "claude/record-holds", global, guard).exitCode).toBe(0);
    expect(sh(["git", "branch", "--list"], harness.origin)).toBe("claude/record-holds");
    expect(push(other.work, "anything", global, guard).exitCode).toBe(0);   // not the harness: passes through
    expect(sh(["git", "branch", "--list"], other.origin)).toBe("anything");

    // Or copied into one clone's .git/hooks, with CAIN_TOOLS naming the tools clone.
    const copy = repo("harness2");
    mkdirSync(join(copy.work, ".git/hooks"), { recursive: true });
    copyFileSync(join(TOOLS, "pre-push"), join(copy.work, ".git/hooks/pre-push"));
    chmodSync(join(copy.work, ".git/hooks/pre-push"), 0o755);
    const env2 = { ...guard, RECORD_GUARDED_REMOTE: "harness2\\.git$", CAIN_TOOLS: REPO };
    expect(push(copy.work, "claude/link-cards", [], env2).stderr.toString()).toContain("push refused: claude/link-cards");
    expect(push(copy.work, "claude/record-holds", [], env2).exitCode).toBe(0);
  }, 90_000);

  test("from a linked worktree it reads the record, not the repository it's pushed from", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    const origin = join(l.root, "harness.git"), main = join(l.root, "harness"), linked = join(l.root, "harness-linked");
    sh(["git", "init", "--quiet", "--bare", "-b", "main", origin], l.root);
    sh(["git", "clone", "--quiet", origin, main], l.root);
    writeFileSync(join(main, "README.md"), "x\n");
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], main);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"], main);
    sh(["git", "worktree", "add", "--quiet", "-b", "side", linked], main);
    // git hands its hooks GIT_DIR and the like; from a linked worktree they're absolute
    // paths into the harness repository, which a git -C <record clone> would follow.
    const env = cleanEnv({ CLAUDE_CODE_SESSION_ID: SA, RECORD_CLONE: l.clone, RECORD_GUARDED_REMOTE: "harness\\.git$" });
    const push = (branch: string) => Bun.spawnSync(["git", "-c", `core.hooksPath=${TOOLS}`, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      { cwd: linked, stdout: "pipe", stderr: "pipe", env });
    const held = push("claude/record-holds");
    expect(held.stderr.toString()).not.toContain("push refused");
    expect(held.exitCode).toBe(0);
    expect(sh(["git", "branch", "--list"], origin)).toContain("claude/record-holds");
    const other = push("claude/link-cards");
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr.toString()).toContain("push refused: claude/link-cards isn't in any hold of this session");
  }, 90_000);
});
