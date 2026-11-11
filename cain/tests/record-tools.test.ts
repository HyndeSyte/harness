// The laptop's record tools (cain/tools/), run as a laptop session would run them,
// against a keeper on a real git repo standing in for GitHub.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRow, rowHash } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { A, PENDING, SA, SB, T0, cleanEnv, hrs, rig, sh } from "./rig.ts";

const TOOLS = resolve(import.meta.dir, "../tools");
const REPO = resolve(import.meta.dir, "../..");
const take = (item: string, f: string, extra: Record<string, unknown> = {}) => ({ op: "take", item, for: f, ...extra });

// A rig plus a laptop's clone of the record, where the tools run.
function laptop() {
  const r = rig();
  const clone = join(r.root, "laptop");
  sh(["git", "-c", "core.autocrlf=false", "clone", "--quiet", r.remote, clone], r.root);
  sh(["git", "config", "user.name", "HyndeSyte"], clone);
  sh(["git", "config", "user.email", "HyndeSyte@users.noreply.github.com"], clone);
  const tool = (name: string, args: string[], o: { session?: string; input?: string; env?: Record<string, string> } = {}) => {
    const env = cleanEnv({ RECORD_CLONE: clone, RECORD_SEND_POLL_MS: "100", ...(o.session ? { CLAUDE_CODE_SESSION_ID: o.session } : {}), ...o.env });
    const p = Bun.spawnSync([process.execPath, join(TOOLS, name), ...args], { cwd: r.root, env, stdout: "pipe", stderr: "pipe",
      stdin: o.input === undefined ? "ignore" : Buffer.from(o.input) });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  const inboxNames = () => sh(["git", "ls-tree", "--name-only", "main", "inbox/"], r.remote).split("\n").filter(Boolean);
  return { ...r, clone, tool, inboxNames };
}

describe("record-send", () => {
  test("stamps who sent it, puts it in the inbox, waits for the keeper and prints what happened", async () => {
    const l = laptop();
    l.at(new Date());
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
    l.at(new Date());
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
    l.running(hrs(25));
    cycle(l.cfg);
    const after = l.tool("record-holds.ts", [], { session: SA });
    expect(after.out).toContain("Your hold on P33 has ended");
    expect(after.out).toContain("Don't act on P33 or push its branches unless Dane asks you to take it again");
    expect(l.tool("record-holds.ts", [], { session: SA }).out).toBe(`This session (${A}) holds nothing in the record.`);
    // Not set up on this machine: the hook stays quiet and never blocks the prompt.
    const bare = Bun.spawnSync([process.execPath, join(TOOLS, "record-holds.ts"), "--hook"], { env: cleanEnv(), stdin: Buffer.from(JSON.stringify({ session_id: SA })), stdout: "pipe" });
    expect([bare.exitCode, bare.stdout.toString()]).toEqual([0, ""]);
  }, 60_000);

  test("--renew takes its holds again, at most once an hour", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/a"] })] }]);
    cycle(l.cfg);
    expect(l.tool("record-holds.ts", ["--renew"], { session: SA }).code).toBe(0);
    expect(l.inboxNames()).toHaveLength(1);
    l.running(hrs(2));
    cycle(l.cfg);
    expect(l.holds().P33).toMatchObject({ holder: A, for: "chat: x", branches: ["claude/a"], taken: T0.toISOString(), renewed: hrs(2).toISOString() });
    l.tool("record-holds.ts", ["--renew"], { session: SA });
    expect(l.inboxNames()).toEqual([]);   // renewed within the hour: nothing sent
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
    expect(l.tool("record-prepush.ts", [], { session: SA, input: pushLine("claude/record-holds"), env: { RECORD_CLONE: join(l.root, "nowhere") } }).code).toBe(1);
  }, 60_000);

  test("installed in a clone, it stops a real git push to a branch the session doesn't hold", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    // A harness repo and a clone of it, with the hook copied in as DOCS.md says.
    const origin = join(l.root, "harness.git"), work = join(l.root, "harness");
    sh(["git", "init", "--quiet", "--bare", "-b", "main", origin], l.root);
    sh(["git", "clone", "--quiet", origin, work], l.root);
    writeFileSync(join(work, "README.md"), "x\n");
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], work);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"], work);
    mkdirSync(join(work, ".git/hooks"), { recursive: true });
    copyFileSync(join(TOOLS, "pre-push"), join(work, ".git/hooks/pre-push"));
    chmodSync(join(work, ".git/hooks/pre-push"), 0o755);
    const push = (branch: string) => Bun.spawnSync(["git", "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: work, stdout: "pipe", stderr: "pipe",
      env: cleanEnv({ CLAUDE_CODE_SESSION_ID: SA, RECORD_CLONE: l.clone, CAIN_TOOLS: REPO }) });
    const refused = push("claude/link-cards");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("push refused: claude/link-cards isn't in any hold of this session");
    expect(push("claude/record-holds").exitCode).toBe(0);
    expect(sh(["git", "branch", "--list"], origin)).toBe("claude/record-holds");
  }, 60_000);
});
