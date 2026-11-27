// Cain 0.20.0, the lean session, third round: the delivery machinery of the first two rounds is cut, and
// what is kept is no riskier than before it. Kept: cloud jobs checked by code (a line only on a change or
// on anything code can't read, from a root reader that refuses links, hardlinks, FIFOs, files over 4 KB
// and a swapped folder), the probe's limit status and its alarm for a screen it doesn't know, the short
// hourly liveness check that still needs his real reply, Claude Code's own compaction by setting only,
// and the daily usage line. Each test fails without its change.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOCOMPACT_PCT, COMPACT_AT_TOKENS, CONTEXT_WINDOW_TOKENS, jobsLook, parseJob, RELAY_PREFIX, STALL_S, starterOf, usageLine, usageOf } from "../rootfs/opt/cain/lean/core";
import { alarmFor, limitNow, otherFor, OTHER_ALARM_S, pass, type Pass, PROBE_LINE, PROBE_REPLY, screenOf } from "../rootfs/opt/cain/probe/core";

const ROOT = join(import.meta.dir, "..");
const OPT = join(ROOT, "rootfs/opt/cain");
const MAIN = join(OPT, "lean/main.ts");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "lean-"));
const T = 1795000000;          // Nov 18, 2026, 4:26 PM in New York
const UID = String(process.getuid?.() ?? 0);

function lean(args: string[], env: Record<string, string>): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { env: { ...process.env, TZ: "America/New_York", CHECKIN_TZ: "America/New_York", LEAN_JOB_UID: UID, ...env } });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

const CARD = `The calendar specialist has a card for Dane (card 42): "Move Dentist to Thu Nov 26, 2:00 to 3:00 PM, from Cain". Its buttons: Approve, Decline. It has buttons: show it now, or it goes out by itself in about 2 minutes.`;
const TAP_NOT_NOW = `Dane tapped "Not now" on your question P08 Q2: "Build job: Faster cards." (Discord message 1300000000000000001; its card shows his answer. If it needs words from you, reply with reply_to 1300000000000000001)`;
const LONG = `The review service says: ${"a long finding about the gate's rules and what it means for the next build; ".repeat(8)}`;
const BOX = "─".repeat(20);
const READY = `${BOX}\n> \n${BOX}\n  ? for shortcuts            auto mode on`;
const LIMIT_SCREEN = `> Relayed by the add-on: Dane tapped "Start" on your question\n  ⎿  You've hit your monthly spend limit for claude-fable-5-2 · /usage-credits to raise it\n${READY}\n`;

// checkin.sh, run for real with a stand-in tmux (as tests/test_addon.py's _checkin): his prompt, idle,
// or the screen in $STUB_BOX/screen when that file is there.
function checkinRig() {
  const d = tmp(), bin = join(d, "bin"), box = join(d, "box"), trans = join(d, "transcripts");
  for (const x of [bin, box, trans, join(d, "from-app")]) mkdirSync(x, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
if [ "$2" = display ]; then case "$*" in *pane_pid*) echo 4242 ;; *) echo 120 ;; esac; exit 0; fi
if [ "$2" = capture-pane ]; then
  if [ -f "$STUB_BOX/typed" ]; then printf '\\342\\235\\257 %s\\n  ? for shortcuts\\n' "$(cat "$STUB_BOX/typed")"
  elif [ -f "$STUB_BOX/screen" ]; then cat "$STUB_BOX/screen"
  else printf '%s\\n' "$STUB_SCREEN"; fi
  exit 0
fi
printf '%s\\n' "$*" >> "$STUB_SENT"
case "$*" in
  *" -l "*) printf '%s' "\${@: -1}" >> "$STUB_BOX/typed" ;;
  *" Enter") if [ -f "$STUB_BOX/typed" ]; then t=$(cat "$STUB_BOX/typed" | sed 's/"/\\\\"/g'); printf '{"type":"user","message":{"role":"user","content":"%s"}}\\n' "$t" >> "$STUB_TRANSCRIPTS/s.jsonl"; rm -f "$STUB_BOX/typed"; fi ;;
  *" C-u"*) rm -f "$STUB_BOX/typed" ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  writeFileSync(join(d, "checked"), "4242\n");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`, TZ: "America/New_York", CHECKIN_DIR: join(d, "done"), CHECKIN_NOW: "0300", CHECKIN_DAY: "2026-11-18",
    STUB_SCREEN: "> \n  ? for shortcuts            auto mode on", STUB_SENT: join(d, "sent"), STUB_BOX: box, STUB_TRANSCRIPTS: trans,
    CAIN_TRANSCRIPTS: trans, CAIN_FROM_APP: join(d, "from-app"), CHECKIN_TRY: join(d, "try"), CHECKIN_DELIVERED: join(d, "delivered"),
    CHECKIN_LAST: join(d, "last"), CHECKIN_STATE: join(d, "state"), SESSION_CHECKED: join(d, "checked"), CHECKIN_STEADY_S: "0",
    CHECKIN_PAUSE_S: "0", TYPING_SH: join(OPT, "typing.sh"), PROMPT_STATE: join(OPT, "prompt-state.sh"), CHECKIN_OPT: OPT,
    RELAY_QUEUE: join(d, "relay.queue"), RELAY_BAD: join(d, "relay.bad"), JOBS_DIR: join(d, "jobs"), JOBS_NUDGED: join(d, "nudged"),
    NOTES_SEEN: join(d, "seen"), LEAN_DIR: join(d, "lean"), HOLDS_FILE: join(d, "holds.json"), RECORD_SH: "/bin/true", KEEPER: "/bin/true",
    SECURITY_MAIN: "/nonexistent", PROBE_MAIN: "/nonexistent", REVIEW_CLI: "/nonexistent",
    MEANINGS_FILE: join(d, "none"), PLACES_FILE: join(d, "none"), CAIN_AS: "", LEAN_JOB_UID: UID,
  };
  const run = (n = 2, more: Record<string, string> = {}) => {
    let out = "";
    for (let i = 0; i < n; i++) {
      const r = Bun.spawnSync(["bash", join(OPT, "checkin.sh")], { env: { ...env, ...more } });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      out += r.stdout.toString();
    }
    return out;
  };
  const sent = () => (existsSync(env.STUB_SENT) ? readFileSync(env.STUB_SENT, "utf8") : "").split("\n").filter(Boolean);
  const typed = () => sent().filter((l) => l.includes(" -l ")).map((l) => l.split(" -l ")[1].slice(11));
  const queue = (...texts: string[]) => writeFileSync(env.RELAY_QUEUE, texts.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  const screen = (s: string | null) => { if (s === null) rmSync(join(box, "screen"), { force: true }); else writeFileSync(join(box, "screen"), s); };
  return { d, env, run, typed, sent, queue, screen };
}

describe("the delivery machinery of the first two rounds is gone", () => {
  test("no worker, no receipt skipping, no digest, no fresh start, no hold queue, no App-typed /compact", () => {
    expect(existsSync(join(OPT, "lean/held.sh"))).toBe(false);
    expect(readdirSync(join(OPT, "lean")).sort()).toEqual(["core.ts", "main.ts"]);
    const main = src("rootfs/opt/cain/lean/main.ts"), core = src("rootfs/opt/cain/lean/core.ts");
    for (const gone of ["claude -p", "workerCommand", "summarise", "classify", "shadow", "digest", "handover", "fresh-due", "compact-due", "route", "missed", "enqueue"])
      expect(`${main}\n${core}`).not.toContain(gone);
    const checkin = src("rootfs/opt/cain/checkin.sh");
    for (const gone of ["/compact", "queue.take", "held_now", "cards_first", "summarise", " route ", "lean/held"]) expect(checkin).not.toContain(gone);
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).not.toContain("fresh-due");
    expect(run).not.toContain("lean/");
    expect(src("rootfs/opt/cain/keeper.sh")).not.toContain("missed");
    expect(src("rootfs/opt/cain/watch.sh")).not.toContain("card_since");
    expect(src("rootfs/opt/cain/typing.sh")).not.toContain("held_now");
    expect(src("rootfs/opt/cain/CLAUDE.md")).not.toMatch(/What the App handles without you|daily digest|state\/receipts|summarised by a worker/);
  });
  test("every relay is typed as before: a receipt tap, then a card, in queue order, none skipped or reordered", () => {
    const g = checkinRig();
    g.queue(TAP_NOT_NOW, CARD);
    g.run(6);
    expect(g.typed()).toEqual([RELAY_PREFIX + TAP_NOT_NOW, RELAY_PREFIX + CARD]);
    // Nothing kept aside for a digest: the lean folder holds only the usage line's day.
    expect(existsSync(join(g.d, "lean")) ? readdirSync(join(g.d, "lean")) : []).not.toContain("handled.jsonl");
    expect((existsSync(join(g.d, "lean")) ? readdirSync(join(g.d, "lean")) : []).filter((n) => n !== "usage.last")).toEqual([]);
  });
  test("a long relay arrives as the file pointer, exactly as before, with no worker", () => {
    const g = checkinRig();
    g.queue(LONG);
    g.run(4);
    const t = g.typed();
    expect(t.length).toBe(1);
    expect(t[0]).toContain(join(g.d, "from-app"));
    const f = readdirSync(join(g.d, "from-app"));
    expect(f.length).toBe(1);
    expect(readFileSync(join(g.d, "from-app", f[0]), "utf8")).toContain(LONG.trim());
  });
  test("a line is typed at his idle prompt as before, with no hold for a limit on his screen (the probe alarms on it instead)", () => {
    const g = checkinRig();
    g.screen(LIMIT_SCREEN);
    g.queue("A line.");
    g.run(4);
    expect(g.typed()).toEqual([`${RELAY_PREFIX}A line.`]);
  });
});

describe("the probe: a limit is its own status, an unknown screen is never ready", () => {
  const f = { now: T, plugin: true, tmux: true, gateway: { state: "connected", ack: T }, delivered: T, slot: null };
  test("a usage or spend limit screen is 'limit', never ready, and alarms at once with the fix", () => {
    expect(limitNow(LIMIT_SCREEN)).toBe(true);
    expect(screenOf(LIMIT_SCREEN, "ready")).toBe("limit");
    expect(screenOf("  ⎿  Claude usage limit reached. Your limit resets at 9am\n> \n", "ready")).toBe("limit");
    // A limit a later reply of his got past no longer counts.
    const past = `  ⎿  You've hit your monthly spend limit · /usage-credits\n⏺ Done: the card is shown.\n${READY}\n`;
    expect(limitNow(past)).toBe(false);
    expect(screenOf(past, "ready")).toBe("ready");
    const p = pass(f, {}, { screen: "limit" });
    expect(p.status).toBe("limit");
    expect(alarmFor([p])).toBe("usage-limit");
    const r = Bun.spawnSync(["bash", join(OPT, "notice.sh"), "text", "usage-limit", ""]);
    expect(r.exitCode).toBe(0);
    const [title, msg] = r.stdout.toString().split("\n");
    expect(title).toBe("Cain hit a usage limit");
    expect(msg).toContain("switch his model, or raise the limit");
    expect(msg).not.toContain("—");
    // The hourly ask goes in only at a ready screen: a limit or an unknown screen is never one.
    expect(src("rootfs/opt/cain/probe/main.ts")).toContain('askDue(h, now, screen === "ready"');
  });
  test("a screen it doesn't know is 'other', and raises the probe alarm once it has lasted 10 minutes", () => {
    expect(screenOf("Do you want to proceed?\n❯ 1. Yes\n  2. No\n", "other")).toBe("other");
    expect(screenOf(`hello\n${BOX}\n> \n${BOX}\n? for shortcuts\n`, "ready")).toBe("ready");
    const at = (s: number, screen: "other" | "ready"): Pass => pass({ ...f, now: T + s, gateway: { state: "connected", ack: T + s }, delivered: T + s }, {}, { screen });
    const five = [at(0, "other"), at(300, "other")];
    expect(five[0].status).toBe("ok");                                     // its layers pass: the alarm is the screen's
    expect(otherFor(five)).toBeNull();
    expect(alarmFor(five)).toBeNull();
    const ten = [...five, at(OTHER_ALARM_S, "other")];
    expect(otherFor(ten)).toBe(10);
    expect(alarmFor(ten)).toBe("probe");
    expect(alarmFor([at(0, "other"), at(300, "ready"), at(600, "other")])).toBeNull();   // not on end
    expect(alarmFor([...ten, at(900, "ready")])).toBeNull();
    // The alarm stays up while the screen stays unknown, and names it.
    const main = src("rootfs/opt/cain/probe/main.ts");
    expect(main).toContain("} else if (!kind && result.status === \"ok\" && had) {");
    expect(main).toContain("his screen has shown something the App doesn't know for");
  });
  test("the hourly liveness check is short and still needs a real reply from his model", () => {
    expect(PROBE_LINE.length).toBeLessThan(100);
    expect(PROBE_LINE).toContain(PROBE_REPLY);
    expect(PROBE_REPLY.split(" ").length).toBe(1);
    const rules = src("rootfs/opt/cain/CLAUDE.md");
    expect(rules).toContain("text exactly `alive`");
    expect(rules).toContain("no other tool call");
    // Only his reply tool's call with that word answers it (the broker), and a missed answer alarms.
    expect(src("rootfs/opt/cain/discord/broker.ts")).toContain('String(args.text ?? "").trim() === PROBE_REPLY');
    expect(alarmFor([{ at: T, ok: false, failed: ["answer"], hourly: "timeout" as any, status: "failed" }])).toBe("probe");
  });
});

describe("cloud jobs, checked by code", () => {
  const branch = "claude/faster-cards";
  const pulls = `/repos/HyndeSyte/harness/pulls?head=HyndeSyte:${encodeURIComponent(branch)}&state=all&per_page=5`;
  const checks = (sha: string) => `/repos/HyndeSyte/harness/commits/${sha}/check-runs?per_page=100`;
  const SHA = "a".repeat(40);
  const open = (runs: unknown[]) => ({ [pulls]: [{ number: 70, state: "open", head: { sha: SHA } }], [checks(SHA)]: { check_runs: runs } });
  const passed = () => open(["pytest", "bun", "pr"].map((name) => ({ name, status: "completed", conclusion: "success" })));
  const setup = () => {
    const d = tmp(), jobs = join(d, "jobs"), gh = join(d, "gh.json");
    mkdirSync(jobs);
    writeFileSync(join(jobs, "cse_01ABC"), `build | Faster cards | ${branch}\n`);
    const answer = (a: Record<string, unknown>) => writeFileSync(gh, JSON.stringify(a));
    const env = (now: number) => ({ LEAN_DIR: join(d, "lean"), LEAN_GITHUB: gh, LEAN_NOW: String(now) });
    const look = (now: number, more: Record<string, string> = {}) => {
      const r = lean(["jobs", jobs], { ...env(now), ...more });
      expect(r.code).toBe(0);
      const [first, ...rest] = r.out.trimEnd().split("\n");
      return { first, line: rest.join("\n"), id: first.startsWith("wake ") ? first.slice(5) : "" };
    };
    const seen = (id: string, now: number) => lean(["jobs-seen", id], env(now));
    return { d, jobs, answer, look, seen };
  };
  test("no change makes no line; a change makes one, kept as seen only once it is in", () => {
    const s = setup();
    s.answer({ [pulls]: [] });
    expect(s.look(T).first).toBe("none");
    expect(s.look(T + 900).first).toBe("none");
    s.answer(open([{ name: "bun", status: "in_progress", conclusion: null }]));
    expect(s.look(T + 1800).first).toBe("none");                            // opened, its checks running: nothing to act on
    s.answer(passed());
    const a = s.look(T + 2700);
    expect(a.first).toMatch(/^wake \d+-[0-9a-f]+$/);
    expect(a.line).toStartWith(`${RELAY_PREFIX}cloud job check, as code read the jobs.`);
    expect(a.line).toContain("pull request 70's checks passed");
    // Not in yet (his screen wasn't ready): the same line again, not a second look.
    const b = s.look(T + 2710);
    expect(b).toEqual(a);
    // Never in, and a look's time later: looked at again, the change still a change.
    const c = s.look(T + 2700 + 900);
    expect(c.id).not.toBe(a.id);
    expect(c.line).toContain("pull request 70's checks passed");
    // In: kept as seen. A settled state is heard at every look until he deletes the file.
    s.seen(c.id, T + 3700);
    expect(readFileSync(join(s.d, "lean", "jobs.json"), "utf8")).toContain("open:70:");
    expect(s.look(T + 4600).line).toContain("pull request 70 open, its checks passed, as at the last look");
    rmSync(join(s.jobs, "cse_01ABC"));
    rmSync(join(s.d, "lean", "jobs.pending.json"), { force: true });
    expect(s.look(T + 5500).first).toBe("none");
    // A stale id keeps nothing.
    expect(s.seen("1-abc", T + 5600).err).toContain("nothing changed");
  });
  test("a new head with its checks running is no line; a failure is one; merged and closed are", () => {
    const j = [parseJob("j", `build | X | ${branch}`, T)!];
    let r = jobsLook(j, { j: { state: "none" } }, {}, T);
    expect(r.wakes).toEqual([]);
    r = jobsLook(j, { j: { state: "open", number: 70, head: SHA, checks: "failed" } }, r.next, T + 900);
    expect(r.wakes[0].line).toContain("checks failed");
    r = jobsLook(j, { j: { state: "open", number: 70, head: "b".repeat(40), checks: "pending" } }, r.next, T + 1800);
    expect(r.wakes).toEqual([]);
    expect(jobsLook(j, { j: { state: "merged", number: 70 } }, r.next, T + 2700).wakes[0].line).toContain("was merged");
    expect(jobsLook(j, { j: { state: "closed", number: 70 } }, r.next, T + 2700).wakes[0].line).toContain("closed without merging");
    expect(jobsLook(j, { j: { state: "none" } }, r.next, T + 2700).wakes[0].line).toContain("is gone from GitHub");
  });
  test("an API error, an answer code doesn't know, a Ship run and a branchless Build each wake him, at every look", () => {
    const s = setup();
    s.answer({ [pulls]: [] });
    s.look(T);
    const bad = [{}, { [pulls]: { message: "API rate limit exceeded" } }, { [pulls]: [{ number: "x", state: "open" }] },
      { [pulls]: [{ number: 70, state: "draft?", head: { sha: SHA } }] }, { [pulls]: [{ number: 70, state: "open", head: { sha: "nope" } }] },
      { [pulls]: [{ number: 70, state: "open", head: { sha: SHA } }] }];
    let t = T;
    for (const a of bad) {
      t += 900;
      s.answer(a);
      const w = s.look(t);
      expect(w.first).toStartWith("wake ");
      expect(w.line).toContain("couldn't read its pull request on GitHub just now, so its state is unknown");
      s.seen(w.id, t);
    }
    // What it was before is still what a known state is compared with.
    s.answer({ [pulls]: [] });
    expect(s.look(t + 900).first).toBe("none");
    const j = [parseJob("s", "ship | Install it", T)!, parseJob("b", "build | Old file", T)!];
    for (const at of [T, T + 900, T + 1800]) expect(jobsLook(j, {}, {}, at).wakes.map((w) => w.line)).toEqual([
      `Ship job "Install it": code has no state of its own to read for it, so check it yourself. Check its run (list_runs, then get_run_log) and follow Cloud jobs in your CLAUDE.md.`,
      `Build job "Old file": code has no state of its own to read for it, so check it yourself. Check its run (list_runs, then get_run_log) and follow Cloud jobs in your CLAUDE.md.`]);
    // A connector wait is his Home Assistant check, at every look.
    expect(jobsLook([parseJob("connector-P8", "connector | P8 | url | sha", T)!], {}, {}, T).wakes[0].line).toContain("Home Assistant check for a waiting install");
  });
  test("each unreadable or refused file wakes him, named: a symlink, a hardlink, a FIFO, an oversized file, an odd line, not his", () => {
    const s = setup();
    s.answer({ [pulls]: [] });
    writeFileSync(join(s.d, "target"), `build | Other | ${branch}\n`);
    symlinkSync(join(s.d, "target"), join(s.jobs, "cse_LINK"));
    linkSync(join(s.d, "target"), join(s.jobs, "cse_HARD"));
    expect(Bun.spawnSync(["mkfifo", join(s.jobs, "cse_FIFO")]).exitCode).toBe(0);
    writeFileSync(join(s.jobs, "cse_BIG"), `build | ${"x".repeat(5000)} | ${branch}\n`);
    writeFileSync(join(s.jobs, "cse_ODD"), "build | Two | lines\nmore\n");
    writeFileSync(join(s.jobs, "cse_KIND"), "deploy | Unknown kind\n");
    writeFileSync(join(s.jobs, "cse_BYTES"), Buffer.from([0x62, 0xff, 0xfe, 0x0a]));
    const w = s.look(T);                                                    // the FIFO never blocked it
    expect(w.first).toStartWith("wake ");
    for (const [n, why] of [["cse_LINK", "it is a link"], ["cse_HARD", "it has more than one name"], ["cse_FIFO", "it isn't a plain file"],
      ["cse_BIG", "it is over 4 KB"], ["cse_ODD", "its line isn't one code knows"], ["cse_KIND", "its line isn't one code knows"], ["cse_BYTES", "it isn't text"]])
      expect(w.line).toContain(`The job file ${n} couldn't be read safely by code (${why})`);
    expect(w.line).not.toContain("Other");                                  // what the links point at is never read
    // At every look, while it lasts.
    s.seen(w.id, T);
    expect(s.look(T + 900).line).toContain("The job file cse_LINK couldn't be read safely");
    // Not his: refused too.
    const s2 = setup();
    s2.answer({ [pulls]: [] });
    expect(s2.look(T, { LEAN_JOB_UID: String(Number(UID) + 1) }).line).toContain("The job file cse_01ABC couldn't be read safely by code (it isn't his)");
    expect(src("rootfs/opt/cain/lean/main.ts")).toContain("constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK");
  });
  test("the folder: a symlinked jobs folder and one swapped while read are refused with a wake; files are read from the held folder", async () => {
    const s = setup();
    s.answer({ [pulls]: [] });
    const real = join(s.d, "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "cse_X"), `build | Planted | ${branch}\n`);
    const linked = join(s.d, "linked");
    symlinkSync(real, linked);
    const r = lean(["jobs", linked], { LEAN_DIR: join(s.d, "lean"), LEAN_GITHUB: join(s.d, "gh.json"), LEAN_NOW: String(T) });
    expect(r.out).toContain("The jobs folder couldn't be read safely by code (it is a link or not a folder)");
    expect(r.out).not.toContain("Planted");
    process.env.LEAN_JOB_UID = UID;
    const m = await import(MAIN);
    // Swapped after it was opened: what is read is the folder held, and the look is refused.
    const swapped = m.readJobs(s.jobs, () => { renameSync(s.jobs, `${s.jobs}.old`); mkdirSync(s.jobs); writeFileSync(join(s.jobs, "cse_NEW"), `build | Planted | ${branch}\n`); });
    expect(swapped.problems).toEqual([{ name: ".", why: "it was swapped for another while code read it" }]);
    const t = jobsLook([], {}, {}, T, swapped.problems);
    expect(t.wakes[0].line).toContain("The jobs folder couldn't be read safely by code (it was swapped for another while code read it)");
    // Held: a file renamed into the old folder's place after it was opened is still read from the held one.
    rmSync(s.jobs, { recursive: true }); renameSync(`${s.jobs}.old`, s.jobs);
    const ok = m.readJobs(s.jobs);
    expect(ok.problems).toEqual([]);
    expect(ok.jobs.map((j: { title: string }) => j.title)).toEqual(["Faster cards"]);
    expect(src("rootfs/opt/cain/lean/main.ts")).toContain("/proc/self/fd/${dirFd}/${name}");
  });
  test("the stall alarm: a Build with no change for 3 hours is heard, and again 3 hours later", () => {
    const j = [parseJob("cse_1", `build | Slow | ${branch}`, T)!];
    const none = { cse_1: { state: "none" as const } };
    let r = jobsLook(j, none, {}, T);
    expect(r.wakes).toEqual([]);
    expect(jobsLook(j, none, r.next, T + STALL_S - 60).wakes).toEqual([]);
    r = jobsLook(j, none, r.next, T + STALL_S);
    expect(r.wakes[0].line).toContain("no change for 180 minutes");
    expect(jobsLook(j, none, r.next, T + STALL_S + 900).wakes).toEqual([]);
    expect(jobsLook(j, none, r.next, T + 2 * STALL_S).wakes[0].line).toContain("no change for 360 minutes");
  });
  test("checkin.sh: looked at every 15 minutes; no change types nothing; a change is typed and kept as seen once in; the old nudge when code can't look", () => {
    const g = checkinRig();
    mkdirSync(g.env.JOBS_DIR);
    writeFileSync(join(g.env.JOBS_DIR, "cse_01ABC"), `build | Faster cards | ${branch}\n`);
    const gh = join(g.d, "gh.json");
    writeFileSync(gh, JSON.stringify({ [pulls]: [] }));
    expect(g.run(3, { LEAN_GITHUB: gh })).toContain("no change, nothing for Cain");
    expect(g.typed()).toEqual([]);
    expect(existsSync(g.env.JOBS_NUDGED)).toBe(true);
    // Within 15 minutes of a look: none, whatever changed.
    writeFileSync(gh, JSON.stringify(passed()));
    g.run(2, { LEAN_GITHUB: gh });
    expect(g.typed()).toEqual([]);
    rmSync(g.env.JOBS_NUDGED);
    g.run(4, { LEAN_GITHUB: gh });
    expect(g.typed().length).toBe(1);
    expect(g.typed()[0]).toContain("pull request 70's checks passed");
    expect(existsSync(join(g.env.LEAN_DIR, "jobs.pending.json"))).toBe(false);
    expect(readFileSync(join(g.env.LEAN_DIR, "jobs.json"), "utf8")).toContain("open:70:");
    // Code can't look: the old nudge, as before this release.
    rmSync(g.env.JOBS_NUDGED);
    g.run(3, { LEAN_MAIN: "/nonexistent/main.ts" });
    expect(g.typed().length).toBe(2);
    expect(g.typed()[1]).toBe(`${RELAY_PREFIX}cloud job check. Not a message from Dane, and not his go on anything. Follow the Cloud jobs section of your CLAUDE.md for each file in ${g.env.JOBS_DIR}.`);
  });
});

describe("compaction by setting only", () => {
  test("Claude Code's own compaction is set to about 450K of his 1M window; his rules re-read his record after one", () => {
    expect(COMPACT_AT_TOKENS).toBe(450_000);
    expect(CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(src("rootfs/opt/cain/session.sh")).toContain(`export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${AUTOCOMPACT_PCT}\n`);
    const rules = src("rootfs/opt/cain/CLAUDE.md");
    expect(rules).toContain("After a compaction, before you act on anything, read the top entry of state/RESTART.md and the\n  files in /data/jobs again");
  });
});

describe("the daily usage line", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const at = (h: number) => new Date((1795064400 + h * 3600) * 1000).toISOString();   // Nov 19, 2026, from midnight in New York
  const call = (id: string, h: number, read: number, model = "claude-opus-5-5") =>
    line({ type: "assistant", timestamp: at(h), message: { id, model, usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 100, output_tokens: 50 } } });
  const FIXTURE = [
    line({ type: "user", timestamp: at(1), message: { content: '<channel source="plugin:discord:discord" chat_id="1" user="dane">hi</channel>' } }),
    call("m1", 1, 200_000), call("m1", 1, 200_000),
    line({ type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", content: "ok" }] } }),
    call("m2", 2, 210_000),
    line({ type: "user", timestamp: at(3), message: { content: "[1a2b3c4d] Relayed by the add-on: cloud job check, as code read the jobs" } }),
    call("m3", 3, 300_000),
    line({ type: "user", timestamp: at(4), message: { content: '<channel source="plugin:discord:discord" chat_id="000000000000000000" user="cain-app-probe">App liveness check</channel>' } }),
    call("m4", 4, 100_000),
    line({ type: "user", timestamp: at(5), message: { content: "[1a2b3c4e] Scheduled check-in from the Cain add-on (morning)." } }),
    line({ type: "system", subtype: "compact_boundary", timestamp: at(5) }),
    call("m5", 5, 50_000, "claude-sonnet-5-5"),
    call("m6", 30, 999_999),
    "not json",
  ];
  test("tokens by model and by what started the turn, context per call and compactions, from a fixture transcript", () => {
    expect(starterOf("[1a2b3c4d] Relayed by the add-on: Dane tapped \"Start\"")).toBe("relay");
    const u = usageOf(FIXTURE, "2026-11-19", "America/New_York");
    expect(u.calls).toBe(5);
    expect(u.cacheRead).toBe(860_000);
    expect(u.compactions).toBe(1);
    expect(Object.keys(u.byStarter).sort()).toEqual(["checkin", "job", "owner", "probe"]);
    const l = usageLine("2026-11-19", u);
    for (const must of ["usage 2026-11-19: his session 5 calls", "cache reads 860K", "claude-opus-5-5", "owner 410K", "compactions 1"]) expect(l).toContain(must);
    const d = tmp();
    mkdirSync(join(d, "-data-work"));
    writeFileSync(join(d, "-data-work", "s.jsonl"), FIXTURE.join("\n"));
    expect(lean(["usage", "2026-11-19", d], { LEAN_NOW: "1795150000" }).out.trim()).toBe(l);
  });
  test("once a day from 00:10, for the day before, in the App log", () => {
    const d = tmp();
    const due = (now: number) => lean(["usage-due"], { LEAN_DIR: d, LEAN_NOW: String(now) }).out.trim();
    expect(due(1795150800 + 5 * 60)).toBe("");                              // Nov 20, 00:05 in New York
    expect(due(1795150800 + 15 * 60)).toBe("2026-11-19");
    expect(due(1795150800 + 20 * 60)).toBe("");
    const g = checkinRig();
    mkdirSync(join(g.d, "transcripts", "-data-work"), { recursive: true });
    writeFileSync(join(g.d, "transcripts", "-data-work", "s.jsonl"), FIXTURE.join("\n"));
    const out = g.run(1, { LEAN_NOW: "1795151700" });
    expect(out).toContain("[cain] usage 2026-11-19: his session 5 calls");
    expect(g.run(1, { LEAN_NOW: "1795151700" })).not.toContain("usage 2026");
  });
});
