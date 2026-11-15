// The laptop's record tools (cain/tools/), run as a laptop session would run them,
// against a keeper on a real git repo standing in for GitHub.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRow, rowHash } from "../rootfs/opt/cain/record/core.ts";
import { cycle } from "../rootfs/opt/cain/record/main.ts";
import { type Clone, clone } from "../tools/record-lib.ts";
import { recordAt, recordSeen, seenAt } from "../tools/session-end.ts";
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

// The holds file at a clone's fetched commit made unreadable: its object removed from the clone
// (a fetch of a few objects leaves them loose). Returns how to put it back.
function holdsGone(clone: string): () => void {
  const blob = sh(["git", "rev-parse", "origin/main:state/holds.json"], clone);
  const obj = join(clone, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  const saved = readFileSync(obj);
  chmodSync(obj, 0o644);
  rmSync(obj);
  return () => writeFileSync(obj, saved);
}

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

  test("holds that can't be read are said, never taken for a hold that ended", () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x")] }]);
    cycle(l.cfg);
    const hook = () => l.tool("record-holds.ts", ["--hook"], { input: JSON.stringify({ session_id: SA, hook_event_name: "UserPromptSubmit" }) });
    expect(hook().out).toContain("- P33, since ");
    const back = holdsGone(l.clone);
    expect(hook()).toEqual({ code: 0, out: "Record holds not checked: the record's holds couldn't be read", err: "" });
    back();
    const again = hook().out;
    expect(again).toContain("- P33, since ");
    expect(again).not.toContain("has ended");
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

// What a laptop session leaves open on the items it holds, filed by its SessionEnd hook
// (session-end.ts): a note per change, once however often its process ends, in the order the
// changes happened, and never lost on the way.
describe("session-end", () => {
  const held = () => {
    const l = laptop();
    l.inbox(["1.json", { id: "lap-take-1", from: A, ops: [take("P33", "chat: x", { branches: ["claude/record-holds"] })] }]);
    cycle(l.cfg);
    sh(["git", "fetch", "-q", "origin"], l.clone);                          // the hold, as last fetched
    return l;
  };
  const plan = (...s: [string, string][]) => JSON.stringify({ type: "assistant", message: { role: "assistant",
    content: [{ type: "tool_use", name: "mcp__ccd_turn__update_plan", input: { items: s.map(([content, status]) => ({ content, status })) } }] } }) + "\n";
  const box = (l: ReturnType<typeof laptop>, ...sub: string[]) => join(l.clone, ".git", "record-holds", "outbox", ...sub);
  const waiting = (l: ReturnType<typeof laptop>) => readdirSync(box(l)).filter((n) => /\.(json|sent|part)$/.test(n)).sort();
  const notes = (l: ReturnType<typeof laptop>) => sh(["git", "show", "main:state/notes/P33.md"], l.remote);
  const ender = (l: ReturnType<typeof laptop>, session = SA) => {
    const transcript = join(l.root, `transcript-${session}.jsonl`);
    return {
      // A transcript only grows: each new plan is added, as a session adds it.
      steps: (...s: [string, string][]) => writeFileSync(transcript, plan(...s), { flag: "a" }),
      end: () => l.tool("session-end.ts", ["--hook"], { input: JSON.stringify({ session_id: session, transcript_path: transcript }) }),
    };
  };

  test("files a session's open steps on the item it holds, once; a new open step files again", () => {
    const l = held();
    const e = ender(l);
    e.steps(["Build", "completed"], ["Verify after his tap", "pending"]);
    expect(e.end()).toEqual({ code: 0, out: "Open steps (1): submitted to the record", err: "" });
    expect(l.inboxNames()).toHaveLength(1);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
    // Its process ends again (an idle stop, a resume) with the same steps open: nothing more,
    // and the outbox settles (the keeper said done).
    expect(e.end()).toEqual({ code: 0, out: "", err: "" });
    expect(l.inboxNames()).toHaveLength(0);
    expect(waiting(l)).toEqual([]);
    e.steps(["Build", "completed"], ["Verify after his tap", "pending"], ["Merge", "pending"]);
    expect(e.end().out).toBe("Open steps (2): submitted to the record");
    expect(l.inboxNames()).toHaveLength(1);
  }, 60_000);

  test("going back to an earlier set of open steps is a new filing: A, then B, then A again is three notes", () => {
    const l = held();
    const e = ender(l);
    for (const step of ["Verify after his tap", "Merge", "Verify after his tap"]) {
      e.steps([step, "pending"]);
      expect(e.end().out).toBe("Open steps (1): submitted to the record");
      expect(cycle(l.cfg).ok).toBe(true);
    }
    expect(notes(l).split("with these steps open: Verify after his tap.").length - 1).toBe(2);
    expect(notes(l).split("with these steps open: Merge.").length - 1).toBe(1);
    expect(notes(l).lastIndexOf("Verify after his tap")).toBeGreaterThan(notes(l).lastIndexOf("Merge"));
  }, 90_000);

  test("everything done after steps were open is said; the same steps open again after that are a new note", () => {
    const l = held();
    const e = ender(l);
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toBe("Open steps (1): submitted to the record");
    expect(cycle(l.cfg).ok).toBe(true);
    e.steps(["Verify after his tap", "completed"]);
    expect(e.end().out).toBe("That nothing is left open: submitted to the record");
    expect(cycle(l.cfg).ok).toBe(true);
    expect(e.end()).toEqual({ code: 0, out: "", err: "" });                 // still nothing open: nothing new
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toBe("Open steps (1): submitted to the record");
    expect(cycle(l.cfg).ok).toBe(true);
    const n = notes(l);
    expect(n.split("with these steps open: Verify after his tap.").length - 1).toBe(2);
    expect(n.split("with nothing left open on its task list.").length - 1).toBe(1);
    expect(n.lastIndexOf("with these steps open")).toBeGreaterThan(n.indexOf("with nothing left open"));
  }, 90_000);

  test("a session that holds no item files nothing", () => {
    const l = laptop();
    const e = ender(l, SB);
    e.steps(["Review the renewal figures for Friday", "pending"]);
    expect(e.end()).toEqual({ code: 0, out: "", err: "" });
    expect(l.inboxNames()).toHaveLength(0);
  }, 60_000);

  test("a transcript that can't be read is said on the item it holds; an end waits its turn while another end of the session files", async () => {
    const l = held();
    const input = JSON.stringify({ session_id: SA, transcript_path: join(l.root, "gone.jsonl") });
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    writeFileSync(join(memo, `${SA}.ending`), "1");                       // another end of it, filing now
    const p = Bun.spawn([process.execPath, join(TOOLS, "session-end.ts"), "--hook"], { cwd: l.root, env: cleanEnv({ RECORD_CLONE: l.clone }),
      stdout: "pipe", stderr: "pipe", stdin: Buffer.from(input) });
    await Bun.sleep(1_500);
    expect(l.inboxNames()).toHaveLength(0);                                 // still waiting its turn
    rmSync(join(memo, `${SA}.ending`));                                     // the other end is done
    expect(await p.exited).toBe(0);
    expect((await new Response(p.stdout).text()).trim()).toBe("That the session ended unread: submitted to the record");
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("its task list couldn't be read, so what it left open isn't known.");
    expect(l.tool("session-end.ts", ["--hook"], { input })).toEqual({ code: 0, out: "", err: "" });   // said once
  }, 60_000);

  test("two ends of one session at once file one note: the same request, which the keeper applies once", async () => {
    const l = held();
    const transcript = join(l.root, "transcript.jsonl");
    writeFileSync(transcript, plan(["Verify after his tap", "pending"]));
    const env = cleanEnv({ RECORD_CLONE: l.clone });
    const start = () => Bun.spawn([process.execPath, join(TOOLS, "session-end.ts"), "--hook"], { cwd: l.root, env, stdout: "pipe", stderr: "pipe",
      stdin: Buffer.from(JSON.stringify({ session_id: SA, transcript_path: transcript })) });
    const [p1, p2] = [start(), start()];
    await Promise.all([p1.exited, p2.exited]);
    // Whether the locks let one or both through, the inbox holds one request id.
    const ids = new Set(l.inboxNames().map((n) => JSON.parse(sh(["git", "show", `main:${n}`], l.remote)).id));
    expect(ids.size).toBe(1);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l).split("with these steps open: Verify after his tap.").length - 1).toBe(1);
  }, 90_000);

  test("two ends of one session at once with different steps take turns: the journal's last entry is the newer snapshot, and the record's newest note", async () => {
    const l = held();
    // The same transcript at two moments: the second end read more of it (the newer snapshot).
    const [t1, t2] = [join(l.root, "t1.jsonl"), join(l.root, "t2.jsonl")];
    writeFileSync(t1, plan(["Verify after his tap", "pending"]));
    writeFileSync(t2, plan(["Verify after his tap", "pending"]) + plan(["Merge", "pending"]));
    const env = cleanEnv({ RECORD_CLONE: l.clone });
    const start = (t: string) => Bun.spawn([process.execPath, join(TOOLS, "session-end.ts"), "--hook"], { cwd: l.root, env, stdout: "pipe", stderr: "pipe",
      stdin: Buffer.from(JSON.stringify({ session_id: SA, transcript_path: t })) });
    const [p1, p2] = [start(t1), start(t2)];
    await Promise.all([p1.exited, p2.exited]);
    expect(cycle(l.cfg).ok).toBe(true);
    const n = notes(l);
    const journal = readFileSync(join(l.clone, ".git", "record-holds", `${SA}.journal`), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    expect(journal.map((e) => e.n)).toEqual(journal.map((_, i) => i + 1));                 // in turn: the older one first, or passed over
    expect(JSON.parse(journal.at(-1).raw).ops[0].text).toContain("with these steps open: Merge.");   // the newer snapshot, always
    expect(n.lastIndexOf("Merge")).toBeGreaterThan(n.lastIndexOf("Verify after his tap"));
  }, 90_000);

  test("an end's snapshot cut off before it was moved in is taken up by a start alone: whole, filed; cut off, kept aside", () => {
    const l = held();
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(join(memo, "pending"), { recursive: true });
    const snap = { session: SA, held: ["P33"], open: [{ content: "Verify after his tap", status: "pending" }], why: "open", at: Date.now(), mark: 10 };
    const old = (Date.now() - 3 * 60_000) / 1000;
    writeFileSync(join(memo, "pending", `${SA}-000000000000001-77.json.77.part`), JSON.stringify(snap));
    writeFileSync(join(memo, "pending", `${SA}-000000000000002-78.json.78.part`), '{"session": "' + SA);
    for (const p of readdirSync(join(memo, "pending"))) utimesSync(join(memo, "pending", p), old, old);
    const said = l.tool("session-end.ts", ["--flush"]);
    expect(said.code).toBe(0);
    expect(said.out).toContain("Submitted 1 to the record from a laptop session's end");
    expect(said.out).toContain("kept aside, unreadable (an end's snapshot was cut off while it was written)");
    expect(readdirSync(join(memo, "pending"))).toEqual([]);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
  }, 60_000);

  test("a journal entry that reads but isn't one (a filing with its number as text) is said at a start, never passed over", () => {
    const l = held();
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    writeFileSync(join(memo, `${SA}.journal`), JSON.stringify({ n: 1, key: "k1", at: 1, kind: "open" }) + "\n"
      + JSON.stringify({ n: "2", key: "k2", at: 2, kind: "open", id: "laptop-end-x", raw: "{}" }) + "\n");
    const said = l.tool("session-end.ts", ["--flush"]);
    expect(said.out).toContain(`A laptop session's journal has damaged lines (2), kept as they are: ${join(memo, `${SA}.journal`)}`);
  }, 60_000);

  test("a damaged last journal line that was ended, or a filing with no id, is said at a start, never taken for a crash's tail", () => {
    const l = held();
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    writeFileSync(join(memo, `${SA}.journal`), JSON.stringify({ n: 1, key: "k1", at: 1, kind: "open" }) + "\nnot json\n");
    writeFileSync(join(memo, `${SB}.journal`), JSON.stringify({ n: 1, key: "k1", at: 1, kind: "open", id: "", raw: "" }) + "\n");
    const said = l.tool("session-end.ts", ["--flush"]).out;
    expect(said).toContain(`A laptop session's journal has damaged lines (2), kept as they are: ${join(memo, `${SA}.journal`)}`);
    expect(said).toContain(`A laptop session's journal has damaged lines (1), kept as they are: ${join(memo, `${SB}.journal`)}`);
  }, 60_000);

  test("an end reads the holds and how far the record had come at one commit: another end's fetch in between can't mix two", () => {
    const l = held();
    l.inbox(["2.json", { id: "lap-take-2", from: A, ops: [take("P44", "chat: y")] }]);
    expect(cycle(l.cfg).ok).toBe(true);                                    // the record moves on; this clone hasn't fetched it
    const rec = clone(l.clone) as Clone;
    const count = (r: string) => Number(sh(["git", "rev-list", "--count", r], l.clone));
    const at = recordAt(rec)!;                                              // this end's commit
    sh(["git", "fetch", "-q", "origin"], l.clone);                         // another end fetches meanwhile
    expect(count("origin/main")).toBeGreaterThan(count(at));
    expect(seenAt(rec, at, SA)).toEqual({ held: ["P33"], rmark: count(at) });
    expect(recordSeen(rec, SA)).toEqual({ held: ["P33", "P44"], rmark: count("origin/main") });
  }, 60_000);

  test("an end that can't read the record keeps its snapshot, said at every start, and the first start that can files it on the items held then", () => {
    const l = held();
    const e = ender(l);
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toBe("Open steps (1): submitted to the record");
    expect(cycle(l.cfg).ok).toBe(true);
    // The session takes a second item; its next end can't read the record (its main names a
    // commit this clone doesn't have, and the remote can't be reached).
    l.inbox(["2.json", { id: "lap-take-2", from: A, ops: [take("P44", "chat: y")] }]);
    expect(cycle(l.cfg).ok).toBe(true);
    const url = sh(["git", "remote", "get-url", "origin"], l.clone);
    sh(["git", "remote", "set-url", "origin", join(l.root, "gone")], l.clone);
    writeFileSync(join(l.clone, ".git", "refs", "remotes", "origin", "main"), "1".repeat(40) + "\n");
    e.steps(["Verify after his tap", "pending"], ["Merge", "pending"]);
    const pendingDir = join(l.clone, ".git", "record-holds", "pending");
    expect(e.end().out).toMatch(/^Open steps \(2\): waiting here: the record couldn't be read, so the items held aren't known yet; kept for the next session's start or end that can read it: /);
    const kept = readdirSync(pendingDir);
    expect(kept).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(pendingDir, kept[0]), "utf8")).held).toBeNull();
    expect(l.tool("session-end.ts", ["--flush"]).out).toContain(`An end's snapshot waits: the record couldn't be read, so the items it held aren't known yet: ${join(pendingDir, kept[0])}`);
    expect(readdirSync(pendingDir)).toEqual(kept);
    // The record can be read again: the next start files it, on both items.
    sh(["git", "remote", "set-url", "origin", url], l.clone);
    rmSync(join(l.clone, ".git", "refs", "remotes", "origin", "main"));
    sh(["git", "fetch", "-q", "origin"], l.clone);
    expect(l.tool("session-end.ts", ["--flush"]).out).toBe("Submitted 1 to the record from a laptop session's end");
    expect(readdirSync(pendingDir)).toEqual([]);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap; Merge.");
    expect(sh(["git", "show", "main:state/notes/P44.md"], l.remote)).toContain("with these steps open: Verify after his tap; Merge.");
  }, 90_000);

  test("an end in a clone that can't be used as the record keeps its snapshot in the clone, and it's filed once the clone can be used", () => {
    const l = held();
    const e = ender(l);
    sh(["git", "update-ref", "-d", "refs/remotes/origin/main"], l.clone);   // the clone lost its upstream
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toMatch(/^Open steps \(1\): waiting here: the record couldn't be read \(.+ isn't a clone of the record on a branch with an upstream \(main\)\), so the items held aren't known yet; kept for the next session's start or end that can read it: /);
    expect(l.tool("record-holds.ts", ["--hook"], { input: JSON.stringify({ session_id: SA }) }).out).toMatch(/^Record holds not checked: /);   // said at every start
    sh(["git", "fetch", "-q", "origin"], l.clone);
    expect(l.tool("session-end.ts", ["--flush"]).out).toBe("Submitted 1 to the record from a laptop session's end");
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
  }, 60_000);

  test("an end whose record's holds can't be read keeps its snapshot, never takes it for holding nothing, and it's filed once they can be read", () => {
    const l = held();
    const e = ender(l);
    const back = holdsGone(l.clone);
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toMatch(/^Open steps \(1\): waiting here: the record couldn't be read, so the items held aren't known yet; kept for the next session's start or end that can read it: /);
    expect(readdirSync(join(l.clone, ".git", "record-holds"))).not.toContain(`${SA}.journal`);   // nothing journaled as holding nothing
    expect(l.tool("session-end.ts", ["--flush"]).out).toContain("An end's snapshot waits: the record couldn't be read");
    back();
    expect(l.tool("session-end.ts", ["--flush"]).out).toBe("Submitted 1 to the record from a laptop session's end");
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
  }, 60_000);

  test("holds that can be read and name nothing of this session's are read as none: no holds file at all, or only another session's", () => {
    const l = laptop();
    const rec = clone(l.clone) as Clone;
    const count = () => Number(sh(["git", "rev-list", "--count", "origin/main"], l.clone));
    expect(() => sh(["git", "cat-file", "-e", "origin/main:state/holds.json"], l.clone)).toThrow();   // none at all
    expect(recordSeen(rec, SA)).toEqual({ held: [], rmark: count() });
    l.inbox(["1.json", { id: "lap-take-b", from: B, ops: [take("P33", "chat: x")] }]);
    expect(cycle(l.cfg).ok).toBe(true);
    sh(["git", "fetch", "-q", "origin"], l.clone);
    expect(recordSeen(rec, SA)).toEqual({ held: [], rmark: count() });
    expect(recordSeen(rec, SB)).toEqual({ held: ["P33"], rmark: count() });
  }, 60_000);

  test("a journal that can't be read is said at every start, never passed over in silence", () => {
    const l = held();
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(join(memo, `${SB}.journal`), { recursive: true });           // a folder where a journal should be
    const said = l.tool("session-end.ts", ["--flush"]);
    expect(said.code).toBe(0);
    expect(said.out).toContain(`A laptop session's journal can't be read (`);
    expect(said.out).toContain(join(memo, `${SB}.journal`));
    expect(l.tool("session-end.ts", ["--flush"]).out).toBe(said.out);     // again at the next start
  }, 60_000);

  test("an end that can't get its turn in time leaves its snapshot, and the next start files it", async () => {
    const l = held();
    const e = ender(l);
    e.steps(["Verify after his tap", "pending"]);
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    writeFileSync(join(memo, `${SA}.ending`), "1");                       // another end of it, taking long
    const said = l.tool("session-end.ts", ["--hook"], { input: JSON.stringify({ session_id: SA, transcript_path: join(l.root, `transcript-${SA}.jsonl`) }), env: { SESSION_END_WAIT_MS: "1000" } });
    expect(said).toEqual({ code: 0, out: "Open steps not filed yet: another end of this session is filing; they go at the next session's start or end", err: "" });
    expect(readdirSync(join(memo, "pending"))).toHaveLength(1);
    rmSync(join(memo, `${SA}.ending`));                                     // the other end is done
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "Submitted 1 to the record from a laptop session's end", err: "" });
    expect(readdirSync(join(memo, "pending"))).toHaveLength(0);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "", err: "" });
  }, 60_000);

  test("a journal line cut off by a crash: the next end journals on a line of its own, numbered on, and files", () => {
    const l = held();
    const e = ender(l);
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    writeFileSync(join(memo, `${SA}.journal`), JSON.stringify({ n: 1, key: "0000000000000000", at: 1, kind: "open" }) + "\n" + '{"n": 2, "key": "1111');
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end().out).toBe("Open steps (1): submitted to the record");
    const lines = readFileSync(join(memo, `${SA}.journal`), "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('{"n": 2, "key": "1111');                     // kept as it was
    expect(JSON.parse(lines[2])).toEqual({ torn: true });                  // marked
    expect(JSON.parse(lines[3]).n).toBe(2);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
  }, 60_000);

  test("a journal that can't be read is said, and the end's snapshot is kept: never taken for an empty journal", () => {
    const l = held();
    const e = ender(l);
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(join(memo, `${SA}.journal`), { recursive: true });           // a folder where the journal should be
    e.steps(["Verify after his tap", "pending"]);
    const said = e.end();
    expect(said.code).toBe(0);
    expect(said.out).toStartWith("Open steps not filed: this session's journal couldn't be read (");
    expect(readdirSync(join(memo, "pending"))).toHaveLength(1);
    expect(l.inboxNames()).toHaveLength(0);
  }, 60_000);

  test("a filing journaled but not in the outbox (its end stopped in between) is put back and sent at the next start, once", () => {
    const l = held();
    const e = ender(l);
    e.steps(["Verify after his tap", "pending"]);
    const dry = JSON.parse(l.tool("session-end.ts", ["--session", SA, "--transcript", join(l.root, `transcript-${SA}.jsonl`), "--dry"]).out);
    const memo = join(l.clone, ".git", "record-holds");
    mkdirSync(memo, { recursive: true });
    const key = /-\d{6}-([0-9a-f]{16})$/.exec(dry.id)![1];
    writeFileSync(join(memo, `${SA}.journal`), JSON.stringify({ n: 1, key, at: Date.now(), kind: "open", id: dry.id, raw: JSON.stringify(dry, null, 1) + "\n" }) + "\n");
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "Submitted 1 to the record from a laptop session's end", err: "" });   // a start alone
    expect(l.inboxNames()).toEqual([`inbox/${dry.id}.json`]);
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "", err: "" });                                                     // sent: not again
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l)).toContain("with these steps open: Verify after his tap.");
    // Settled, it leaves a mark: never put back from the journal again, however old the keeper's log.
    expect(e.end()).toEqual({ code: 0, out: "", err: "" });
    expect(readdirSync(join(memo, "outbox", "done"))).toEqual([dry.id]);
    expect(e.end()).toEqual({ code: 0, out: "", err: "" });
    expect(l.inboxNames()).toHaveLength(0);
  }, 60_000);

  test("filings made offline wait in the outbox and go in the order they were made; a sent one leaves once the keeper has it", () => {
    const l = held();
    const e = ender(l);
    const away = `${l.remote}-away`;
    renameSync(l.remote, away);                                             // the record can't be reached
    e.steps(["Verify after his tap", "pending"]);
    expect(e.end()).toEqual({ code: 0, out: "Open steps (1): waiting here, to go at the next session's start or end", err: "" });
    e.steps(["Merge", "pending"]);
    expect(e.end().out).toBe("Open steps (1): waiting here, to go at the next session's start or end");
    const queued = waiting(l);
    expect(queued).toHaveLength(2);
    expect(queued.map((n) => /^laptop-end-.+-(\d{6})-[0-9a-f]{16}\.json$/.exec(n)?.[1])).toEqual(["000001", "000002"]);
    const raw = readFileSync(box(l, queued[0]), "utf8");
    // Queued three days ago: the day before it's sent again counts from when it's sent.
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    for (const n of queued) utimesSync(box(l, n), old, old);
    renameSync(away, l.remote);
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "Submitted 2 to the record from a laptop session's end", err: "" });
    const inbox = l.inboxNames();
    expect(inbox.map((n) => /-(\d{6})-[0-9a-f]{16}$/.exec(JSON.parse(sh(["git", "show", `main:${n}`], l.remote)).id)?.[1])).toEqual(["000001", "000002"]);   // made first, goes first
    expect(waiting(l)).toEqual(queued.map((n) => n.replace(/\.json$/, ".sent")));
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "", err: "" });                                   // no word yet: waits, not resent
    expect(l.inboxNames()).toHaveLength(2);
    expect(cycle(l.cfg).ok).toBe(true);
    expect(notes(l).indexOf("Merge")).toBeGreaterThan(notes(l).indexOf("Verify after his tap"));
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "", err: "" });
    expect(waiting(l)).toEqual([]);                                                                                           // done: gone
    // The same filing back in the outbox (an answer lost on the way): the keeper has it, so it leaves, unsent.
    writeFileSync(box(l, queued[0]), raw);
    expect(l.tool("session-end.ts", ["--flush"])).toEqual({ code: 0, out: "", err: "" });
    expect(waiting(l)).toEqual([]);
    expect(l.inboxNames()).toHaveLength(0);
  }, 120_000);

  test("a filing the record refuses on a session's own end is kept aside with why and named at every start, never lost", () => {
    const l = held();
    const e = ender(l);
    e.steps(["Verify after his tap", "pending"]);
    // The record already refused this very filing (its id), say from an earlier, broken try.
    const id = (JSON.parse(l.tool("session-end.ts", ["--session", SA, "--transcript", join(l.root, `transcript-${SA}.jsonl`), "--dry"]).out)).id;
    l.inbox(["2.json", { id, from: A, ops: [{ op: "note", item: "P999", text: "x" }] }]);
    cycle(l.cfg);
    sh(["git", "fetch", "-q", "origin"], l.clone);
    const said = e.end();
    expect(said.code).toBe(0);
    expect(said.out).toContain("kept aside, refused (the record said rejected: ");
    expect(said.out).toContain("Open steps (1): kept aside, as above");
    expect(readdirSync(box(l, "refused")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(l.tool("session-end.ts", ["--flush"]).out).toContain("kept aside, refused (the record said rejected: ");   // named again at the next start
  }, 60_000);

  test("a filing that can't be read, that the record would refuse, or that was cut off while written is kept aside with why; one whole but not moved in goes on", () => {
    const l = held();
    mkdirSync(box(l), { recursive: true });
    writeFileSync(box(l, "laptop-end-broken.json"), '{"kind": "change", "id": "laptop-end-br');           // cut off
    writeFileSync(box(l, "laptop-end-nosuch.json"), JSON.stringify({ kind: "change", from: A, id: "laptop-end-nosuch", summary: "s", ops: [{ op: "note", item: "P999", text: "x" }] }));
    const old = (Date.now() - 3 * 60_000) / 1000;
    writeFileSync(box(l, "20261115T050000.000Z-laptop-end-cut.json.4242.part"), '{"kind": "chan');       // its process ended mid-write
    utimesSync(box(l, "20261115T050000.000Z-laptop-end-cut.json.4242.part"), old, old);
    const whole = { kind: "change", from: A, id: "laptop-end-whole-1", summary: "s", ops: [{ op: "note", item: "P33", text: "The laptop session ended with these steps open: Merge." }] };
    writeFileSync(box(l, "20261115T050001.000Z-laptop-end-whole-1.json.4243.part"), JSON.stringify(whole));
    utimesSync(box(l, "20261115T050001.000Z-laptop-end-whole-1.json.4243.part"), old, old);
    const said = l.tool("session-end.ts", ["--flush"]);
    expect(said.code).toBe(0);
    expect(said.out).toContain("Submitted 1 to the record from a laptop session's end");
    expect(said.out).toContain(`kept aside, refused (the record would refuse it: rejected: P999 isn't an item in the record): ${box(l, "refused", "laptop-end-nosuch.json")}`);
    expect(said.out).toContain(`kept aside, unreadable (this filing couldn't be read): ${box(l, "unreadable", "laptop-end-broken.json")}. File what it held another way, or drop it; then delete it.`);
    expect(said.out).toContain(`kept aside, unreadable (this filing was cut off while it was written): ${box(l, "unreadable", "20261115T050000.000Z-laptop-end-cut.json.4242.json")}`);
    expect(readFileSync(box(l, "unreadable", "laptop-end-broken.json"), "utf8")).toBe('{"kind": "change", "id": "laptop-end-br');
    expect(JSON.parse(sh(["git", "show", `main:${l.inboxNames()[0]}`], l.remote)).id).toBe("laptop-end-whole-1");
    expect(l.tool("session-end.ts", ["--flush"]).out).toContain("kept aside, unreadable (this filing couldn't be read)");   // named again at the next start
  }, 60_000);
});
