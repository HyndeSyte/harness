// Cain 0.20.0, the lean session: cloud jobs by code, relays sorted by code (receipts, cards, the
// worker), the digest and its marks, compaction, the quiet-hour fresh start, the usage line, and the
// probe's limit status. Each test fails without its change.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cardLine, classify, compactPct, COMPACT_AT_TOKENS, freshWhyNot, jobsLook, parseJob, parseWorker, plain, RELAY_PREFIX,
  starterOf, summaryLine, usageLine, usageOf, workerArgs, WORKER_MODEL, WORKER_EFFORT, workerPrompt,
} from "../rootfs/opt/cain/lean/core";
import { screenOf, pass, alarmFor, PROBE_LINE, PROBE_REPLY } from "../rootfs/opt/cain/probe/core";

const ROOT = join(import.meta.dir, "..");
const OPT = join(ROOT, "rootfs/opt/cain");
const MAIN = join(OPT, "lean/main.ts");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "lean-"));
const T = 1795000000;          // Nov 18, 2026, 4:26 PM in New York

function lean(args: string[], env: Record<string, string>, input = ""): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { env: { ...process.env, TZ: "America/New_York", CHECKIN_TZ: "America/New_York", ...env },
    stdin: new TextEncoder().encode(input) });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

// The link's own card line (link/core.ts), with buttons, as a specialist's card relays it.
const CARD = `The calendar specialist has a card for Dane (card 42): "Move “Dentist” to Thu Nov 26, 2:00 to 3:00 PM — from Cain". Its buttons: Approve, Decline. It has buttons: show it now, or it goes out by itself in about 2 minutes. Run /opt/cain/keeper.sh show 42 --item <its PENDING id, or none> (add --reply-to <his message id> when it answers a message of his). The item is only its label: the card goes out whoever holds the item, open or closed.`;
const TAP_NOT_NOW = `Dane tapped "Not now" on your question P08 Q2: "Build job: Faster cards. Cards reach you sooner." (Discord message 1300000000000000001; its card shows his answer. If it needs words from you, reply with reply_to 1300000000000000001)`;
const TAP_START = TAP_NOT_NOW.replace('"Not now"', '"Start"');
const LONG = `The review service says: ${"a long finding about the gate's rules and what it means for the next build; ".repeat(8)}`;

describe("relays, classed by code", () => {
  test("a receipt is written to the record and kept for the digest, with no turn", () => {
    const d = tmp(), q = join(d, "queue");
    expect(classify(TAP_NOT_NOW)).toMatchObject({ kind: "receipt", receipt: { item: "P08", question: "Q2", label: "Not now" } });
    const r = lean(["route", "111"], { LEAN_DIR: d, RECORD_QUEUE: q, LEAN_NOW: String(T) }, TAP_NOT_NOW);
    expect(r.out.trim()).toBe("handled");
    const reqs = readdirSync(q).filter((n) => n.endsWith(".json"));
    expect(reqs.length).toBe(1);
    const req = JSON.parse(readFileSync(join(q, reqs[0]), "utf8"));
    expect(req.from).toBe("cain");
    expect(req.ops).toEqual([{ op: "append", path: "state/receipts/2026-11-18.md", text: expect.stringContaining("P08 Q2 | tap: Not now") }]);
    expect(readFileSync(join(d, "handled.jsonl"), "utf8")).toContain('"kind":"receipt"');
    // The same line again (a run cut off before it left the queue) isn't written twice.
    expect(lean(["route", "111"], { LEAN_DIR: d, RECORD_QUEUE: q, LEAN_NOW: String(T) }, TAP_NOT_NOW).out.trim()).toBe("handled");
    expect(readdirSync(q).filter((n) => n.endsWith(".json")).length).toBe(1);
  });
  test("a tap that carries his go, or anything the link added after it, is a turn", () => {
    expect(classify(TAP_START).kind).toBe("plain");
    expect(classify(`${TAP_NOT_NOW} It's recorded as held, not shippable yet.`).kind).toBe("plain");
    expect(classify("Dane tapped Stop. Everything of yours is stopped.").kind).toBe("plain");
    const r = lean(["route", "112"], { LEAN_DIR: tmp(), RECORD_QUEUE: tmp() }, TAP_START);
    expect(r.out).toBe(`type\n${RELAY_PREFIX}${TAP_START}\n`);
  });
  test("a card with buttons goes at once, typed short and inline, never to the worker or a file", () => {
    expect(classify(CARD).kind).toBe("card");
    expect(plain(RELAY_PREFIX + CARD)).toBe(false);              // as it is it would go as a file
    const line = cardLine(CARD)!;
    expect(plain(RELAY_PREFIX + line)).toBe(true);
    for (const must of ["(card 42)", "Its buttons: Approve, Decline.", "goes out by itself in about 2 minutes", "/opt/cain/keeper.sh show 42 --item"])
      expect(line).toContain(must);
    const r = lean(["route", "113"], { LEAN_DIR: tmp(), RECORD_QUEUE: tmp(), LEAN_WORKER: "/nonexistent" }, CARD);
    expect(r.out).toBe(`type\n${RELAY_PREFIX}${line}\n`);
    // Even a card whose words fill the line keeps its id, buttons and command.
    const huge = CARD.replace("Move", "Move " + "x".repeat(600));
    expect(plain(RELAY_PREFIX + cardLine(huge)!)).toBe(true);
    expect(cardLine(huge)).toContain("show 42");
  });
  test("the owner's own words are never classed", () => {
    const note = `Dane's page sent a note about P12 (request page-1). His words, as typed: «${"please look at the farm gate list ".repeat(20)}»`;
    expect(classify(note).kind).toBe("owner");
    const r = lean(["route", "114"], { LEAN_DIR: tmp(), RECORD_QUEUE: tmp(), LEAN_WORKER: "/nonexistent" }, note);
    expect(r.out).toBe(`type\n${RELAY_PREFIX}${note}\n`);
    // And his Discord messages never pass through the relay queue at all: only the link, the record
    // keeper, the review runner and the App write it; the plugin delivers his messages to the session.
    for (const f of ["discord/broker.ts", "discord/bridge.ts"]) expect(src(`rootfs/opt/cain/${f}`)).not.toContain("relay.queue");
  });
  test("a long line goes to the worker; its needs-Cain answer becomes a short turn, its no-action the digest", () => {
    expect(classify(LONG).kind).toBe("long");
    const d = tmp(), w = join(d, "worker.sh");
    const fake = (out: string, code = 0) => { writeFileSync(w, `#!/bin/bash\ncat >/dev/null\nprintf '%b' "${out}"\nexit ${code}\n`); chmodSync(w, 0o755); };
    const env = { LEAN_DIR: d, RECORD_QUEUE: tmp(), LEAN_WORKER: w, RECORD_DIR: tmp() };
    expect(lean(["route", "200"], env, LONG).out.trim()).toBe("long");
    fake("NEEDS CAIN\\nThe review found a gate rule gap in the next build.\\nRead the findings and decide which to adopt.");
    const a = lean(["summarise", "200", "/data/work/from-app/relay-200.txt"], env, LONG);
    expect(a.code).toBe(0);
    const [verb, turn] = a.out.trim().split("\n");
    expect(verb).toBe("type");
    expect(plain(turn)).toBe(true);
    expect(turn).toContain("The review found a gate rule gap");
    expect(turn).toContain("/data/work/from-app/relay-200.txt");
    fake("NO ACTION\\nIt only says a check passed again.");
    expect(lean(["summarise", "201", "/data/work/from-app/relay-201.txt"], env, LONG).out.trim()).toBe("handled");
    expect(readFileSync(join(d, "handled.jsonl"), "utf8")).toContain("It only says a check passed again.");
  });
  test("a worker that fails, or answers in any other shape, sends the line to Cain as before", () => {
    const d = tmp(), w = join(d, "worker.sh");
    const env = { LEAN_DIR: d, RECORD_QUEUE: tmp(), LEAN_WORKER: w, RECORD_DIR: tmp() };
    writeFileSync(w, "#!/bin/bash\ncat >/dev/null\necho 'NO ACTION'\nexit 3\n"); chmodSync(w, 0o755);
    expect(lean(["summarise", "300", "/data/work/from-app/r.txt"], env, LONG).code).toBe(1);
    writeFileSync(w, "#!/bin/bash\ncat >/dev/null\necho 'Sure! This one is fine, no action needed.'\n"); chmodSync(w, 0o755);
    expect(lean(["summarise", "301", "/data/work/from-app/r.txt"], env, LONG).code).toBe(1);
    expect(existsSync(join(d, "handled.jsonl"))).toBe(false);
    for (const bad of ["", "NEEDS CAIN\nonly one line", "NO ACTION\na\nb", "needs cain\na\nb", "NO ACTION\n" + "x".repeat(300)]) expect(parseWorker(bad)).toBeNull();
    expect(parseWorker("NO ACTION\nfine")).toEqual({ verdict: "no_action", reason: "fine" });
    expect(summaryLine({ verdict: "needs_cain", lines: ["a", "b"] }, "/data/work/from-app/r 1;rm.txt")).toBeNull();
  });
  test("the worker has no tools that reach him, Discord or the record's write path", () => {
    const a = workerArgs();
    expect(a.slice(0, 4)).toEqual(["claude", "-p", "--model", WORKER_MODEL]);
    expect(WORKER_MODEL).toBe("claude-sonnet-5-5");
    expect(["low", "medium"]).toContain(WORKER_EFFORT);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(JSON.parse(a[a.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
    const deny = a[a.indexOf("--disallowedTools") + 1].split(",");
    for (const t of ["Bash", "Write", "Edit", "WebFetch", "mcp__plugin_discord_discord", "mcp__claude_ai_GitHub", "RemoteTrigger"]) expect(deny).toContain(t);
    expect(a).not.toContain("--channels");
    expect(a.join(" ")).not.toMatch(/bypassPermissions|dangerously|--permission-mode auto|acceptEdits/);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("default");
    const p = workerPrompt({ relay: "x", row: null, notes: [] });
    expect(p).toContain("never contact anyone");
    expect(p).toContain("NEEDS CAIN");
    // It is started only through as-cain (his user) or the test's stand-in, under a time bound.
    expect(src("rootfs/opt/cain/lean/main.ts")).toContain('"timeout", "-k", "5", String(WORKER_TIMEOUT_S)');
  });
});

// checkin.sh, run for real with a stand-in tmux (as tests/test_addon.py's _checkin): his prompt, idle.
function checkinRig() {
  const d = tmp(), bin = join(d, "bin"), box = join(d, "box"), trans = join(d, "transcripts");
  for (const x of [bin, box, trans, join(d, "from-app")]) mkdirSync(x, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
if [ "$2" = display ]; then case "$*" in *pane_pid*) echo 4242 ;; *) echo 120 ;; esac; exit 0; fi
if [ "$2" = capture-pane ]; then
  if [ ! -f "$STUB_BOX/typed" ]; then printf '%s\\n' "$STUB_SCREEN"; else printf '\\342\\235\\257 %s\\n  ? for shortcuts\\n' "$(cat "$STUB_BOX/typed")"; fi
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
    NOTES_SEEN: join(d, "seen"), LEAN_DIR: join(d, "lean"), RECORD_QUEUE: join(d, "rq"), RECORD_DIR: join(d, "rec"),
    LEAN_MARKS: join(d, "marks"), HOLDS_FILE: join(d, "holds.json"), RECORD_SH: "/bin/true", KEEPER: "/bin/true",
    SECURITY_MAIN: "/nonexistent", PROBE_MAIN: "/nonexistent", REVIEW_CLI: "/nonexistent",
    MEANINGS_FILE: join(d, "none"), PLACES_FILE: join(d, "none"), CAIN_AS: "", LEAN_JOBS_EVERY_S: "0",
  };
  const run = (n = 2, more: Record<string, string> = {}) => {
    for (let i = 0; i < n; i++) {
      const r = Bun.spawnSync(["bash", join(OPT, "checkin.sh")], { env: { ...env, ...more } });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    }
  };
  const typed = () => (existsSync(env.STUB_SENT) ? readFileSync(env.STUB_SENT, "utf8") : "").split("\n").filter((l) => l.includes(" -l ")).map((l) => l.split(" -l ")[1].slice(11));
  const queue = (...texts: string[]) => writeFileSync(env.RELAY_QUEUE, texts.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  return { d, env, run, typed, queue };
}

describe("checkin.sh routes each relay as code classed it", () => {
  test("a card with buttons behind other lines is typed first, at once, inline", () => {
    const g = checkinRig();
    g.queue("Review seat Gemini failed its nightly check (auth): sign in again.", CARD);
    g.run(2);
    const t = g.typed();
    expect(t.length).toBe(1);
    expect(t[0]).toBe(RELAY_PREFIX + cardLine(CARD));
    expect(t[0]).not.toContain("from-app");
  });
  test("a receipt makes no turn and leaves the queue; the next line goes as before", () => {
    const g = checkinRig();
    g.queue(TAP_NOT_NOW, "Review seat Gemini failed its nightly check (auth): sign in again.");
    g.run(4);
    expect(g.typed()).toEqual([`${RELAY_PREFIX}Review seat Gemini failed its nightly check (auth): sign in again.`]);
    expect(readdirSync(g.env.RECORD_QUEUE).filter((n) => n.endsWith(".json")).length).toBe(1);
  });
  test("a long line whose worker fails goes to Cain as before, as a file", () => {
    const g = checkinRig();
    const w = join(g.d, "worker.sh");
    writeFileSync(w, "#!/bin/bash\nexit 1\n"); chmodSync(w, 0o755);
    g.queue(LONG);
    g.run(2, { LEAN_WORKER: w });
    const t = g.typed();
    expect(t.length).toBe(1);
    expect(t[0]).toContain("a relayed line too long or unusual to type here is in");
  });
  test("a long line the worker says needs Cain is typed as its summary", () => {
    const g = checkinRig();
    const w = join(g.d, "worker.sh");
    writeFileSync(w, "#!/bin/bash\ncat >/dev/null\nprintf 'NEEDS CAIN\\nA review found a gap.\\nDecide which findings to adopt.\\n'\n"); chmodSync(w, 0o755);
    g.queue(LONG);
    g.run(2, { LEAN_WORKER: w });
    const t = g.typed();
    expect(t.length).toBe(1);
    expect(t[0]).toContain("summarised by a worker: A review found a gap. Decide which findings to adopt.");
    expect(readFileSync(join(g.d, "from-app", readdirSync(join(g.d, "from-app"))[0]), "utf8")).toContain("a long finding");
  });
});

describe("cloud jobs, by code", () => {
  const branch = "claude/faster-cards";
  const pulls = `/repos/HyndeSyte/harness/pulls?head=HyndeSyte:${encodeURIComponent(branch)}&state=all&per_page=5`;
  const checks = (sha: string) => `/repos/HyndeSyte/harness/commits/${sha}/check-runs?per_page=100`;
  const SHA = "a".repeat(40);
  const setup = () => {
    const d = tmp(), jobs = join(d, "jobs"), gh = join(d, "gh.json");
    mkdirSync(jobs);
    writeFileSync(join(jobs, "cse_01ABC"), `build | Faster cards | ${branch}\n`);
    const answer = (a: Record<string, unknown>) => writeFileSync(gh, JSON.stringify(a));
    const env = (now: number) => ({ LEAN_DIR: join(d, "lean"), LEAN_GITHUB: gh, LEAN_NOW: String(now), LEAN_JOBS_EVERY_S: "0" });
    return { d, jobs, answer, env };
  };
  test("a job with no change of state makes no turn; a changed one makes exactly one", () => {
    const s = setup();
    s.answer({ [pulls]: [] });
    expect(lean(["jobs", s.jobs], s.env(T)).out.trim()).toBe("ok");
    expect(lean(["jobs", s.jobs], s.env(T + 600)).out.trim()).toBe("ok");
    // A pull request with its checks still running: not yet a change he acts on.
    s.answer({ [pulls]: [{ number: 70, state: "open", head: { sha: SHA } }], [checks(SHA)]: { check_runs: [{ name: "bun", status: "in_progress", conclusion: null }] } });
    expect(lean(["jobs", s.jobs], s.env(T + 1200)).out.trim()).toBe("ok");
    // Its checks passed: one turn, offered until it went in, then quiet.
    s.answer({ [pulls]: [{ number: 70, state: "open", head: { sha: SHA } }], [checks(SHA)]: { check_runs: ["pytest", "bun", "pr"].map((name) => ({ name, status: "completed", conclusion: "success" })) } });
    const w = lean(["jobs", s.jobs], s.env(T + 1800)).out.trim().split("\n");
    expect(w.slice(0, 2)).toEqual(["ok", "wake"]);
    expect(w[2]).toContain("pull request 70's checks passed");
    expect(lean(["jobs", s.jobs], s.env(T + 1810)).out.trim().split("\n")[1]).toBe("wake");   // not in yet: again
    lean(["jobs-done"], s.env(T + 1820));
    expect(lean(["jobs", s.jobs], s.env(T + 2400)).out.trim()).toBe("ok");
    // A link of his in the jobs folder is never followed by root.
    symlinkSync("/etc/hostname", join(s.jobs, "cse_LINK"));
    expect(lean(["jobs", s.jobs], s.env(T + 2410)).out).not.toContain("cse_LINK");
    // GitHub not answering is no change.
    s.answer({});
    expect(lean(["jobs", s.jobs], s.env(T + 3000)).out.trim()).toBe("ok");
  });
  test("the stall alarm: a job nobody finishes is still heard, and again after each limit", () => {
    const now = T;
    const jobs = [parseJob("cse_1", `build | Slow | ${branch}`, now)!, parseJob("cse_2", "ship | Install it", now)!, parseJob("connector-P8", "connector | P8 | url | sha", now)!];
    const none = { cse_1: { state: "none" as const } };
    let r = jobsLook(jobs, none, {}, now);
    expect(r.wakes).toEqual([]);
    r = jobsLook(jobs, none, r.next, now + 25 * 60);
    expect(r.wakes.map((w) => w.name)).toEqual(["cse_2"]);           // a Ship: has it installed?
    r = jobsLook(jobs, none, r.next, now + 3 * 3600);
    expect(r.wakes.map((w) => w.name).sort()).toEqual(["cse_1", "cse_2"]);
    expect(r.wakes.find((w) => w.name === "cse_1")!.line).toContain("no change for 180 minutes");
    expect(jobsLook(jobs, none, r.next, now + 3 * 3600 + 60).wakes).toEqual([]);
    expect(Object.keys(r.next)).not.toContain("connector-P8");      // a connector wait isn't a job
  });
  test("checkin.sh: an open job with no change types nothing; the old 15-minute check only when code can't look", () => {
    const g = checkinRig();
    mkdirSync(g.env.JOBS_DIR);
    writeFileSync(join(g.env.JOBS_DIR, "cse_01ABC"), `build | Faster cards | ${branch}\n`);
    writeFileSync(join(g.d, "gh.json"), JSON.stringify({ [pulls]: [] }));
    g.run(3, { LEAN_GITHUB: join(g.d, "gh.json") });
    expect(g.typed()).toEqual([]);
    rmSync(join(g.env.CHECKIN_STATE, "lean-jobs"));            // a minute on
    g.run(2, { LEAN_MAIN: "/nonexistent/main.ts" });
    expect(g.typed().length).toBe(1);
    expect(g.typed()[0]).toContain("cloud job check");
  });
});

describe("the digest and its marks", () => {
  test("one digest a day lists what was handled, and his marks are counted for the week", () => {
    const d = tmp(), env = { LEAN_DIR: d, RECORD_QUEUE: tmp(), LEAN_NOW: String(T) };
    lean(["route", "1"], env, TAP_NOT_NOW);
    expect(lean(["digest", "0640", "2026-11-18"], env).out).toBe("");       // not before 6:50
    const out = lean(["digest", "0651", "2026-11-18"], env).out;
    const [head, text] = [out.split("\n")[0], out.split("\n").slice(1).join("\n")];
    expect(head).toBe("2026-11-18 1");
    expect(text).toContain("1. receipt, P08");
    expect(text).toContain("/opt/cain/keeper.sh missed 2026-11-18");
    lean(["digest-done", "2026-11-18", "1"], env);
    expect(lean(["digest", "0700", "2026-11-18"], env).out).toBe("");
    lean(["missed-in"], env, "2026-11-18 1\nnot a mark\n");
    expect(lean(["counts"], env).out.trim()).toBe("1 1");
  });
  test("keeper.sh missed writes his mark to his own folder, checked", () => {
    const d = tmp();
    const k = (args: string[]) => Bun.spawnSync(["bash", join(OPT, "keeper.sh"), "missed", ...args], { env: { ...process.env, LEAN_MARKS: d } });
    expect(k(["2026-11-18", "2", "5"]).exitCode).toBe(0);
    expect(readFileSync(join(d, readdirSync(d)[0]), "utf8")).toBe("2026-11-18 2 5\n");
    expect(k(["2026-11-18", "two"]).exitCode).toBe(2);
    expect(k(["P08"]).exitCode).toBe(2);
  });
});

describe("context kept small", () => {
  test("the compaction threshold is set in code, well before 300K", () => {
    expect(COMPACT_AT_TOKENS).toBeLessThan(300_000);
    expect(compactPct()).toBe(25);
    const session = src("rootfs/opt/cain/session.sh");
    expect(session).toContain("export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=");
    expect(session).toContain("lean/main.ts compact-pct");
    expect(session.indexOf("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")).toBeLessThan(session.indexOf("claude --permission-mode"));
    expect(lean(["compact-pct"], {}).out.trim()).toBe("25");
  });
  test("the quiet-hour fresh start is skipped while the owner wrote lately or a job is mid-step", () => {
    const at4 = 1795078800;      // Nov 19, 2026, 4:00 AM in New York
    const base = { now: at4, tz: "America/New_York", lastDay: null, heardAt: null, jobs: 0, tryPending: false, queued: false, screen: "ready", upSince: at4 - 7200 };
    expect(freshWhyNot(base)).toBeNull();
    expect(freshWhyNot({ ...base, heardAt: at4 - 600 })).toContain("the owner wrote");
    expect(freshWhyNot({ ...base, heardAt: at4 - 3600 })).toBeNull();
    expect(freshWhyNot({ ...base, jobs: 1 })).toContain("job is mid-step");
    expect(freshWhyNot({ ...base, screen: "other" })).not.toBeNull();
    expect(freshWhyNot({ ...base, lastDay: "2026-11-19" })).toContain("already");
    expect(freshWhyNot({ ...base, now: at4 + 3 * 3600 })).toContain("quiet hour");
    // Through the command: due once, kept as done, with his handover line queued first.
    const d = tmp(), heard = join(d, "heard"), q = join(d, "q");
    writeFileSync(heard, `${at4 - 600}\n`);
    const env = { LEAN_DIR: d, PROBE_HEARD: heard, JOBS_DIR: join(d, "nojobs"), RELAY_QUEUE: q, CHECKIN_TRY: join(d, "try"), LEAN_NOW: String(at4) };
    expect(lean(["fresh-due", "ready", String(at4 - 7200)], env).code).toBe(1);
    writeFileSync(heard, `${at4 - 3600}\n`);
    expect(lean(["fresh-due", "ready", String(at4 - 7200)], env).code).toBe(0);
    expect(readFileSync(q, "utf8")).toContain("state/RESTART.md");
    expect(lean(["fresh-due", "ready", String(at4 - 7200)], env).code).toBe(1);
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain('lean/main.ts" fresh-due');
    expect(run.indexOf('lean/main.ts" fresh-due')).toBeLessThan(run.indexOf("end_his_session || fail_closed\n      break\n    fi\n  fi\n  # The watchdog over"));
  });
});

describe("the hourly liveness check, small", () => {
  test("the shortest line, one word back, and his rules say no other tool call", () => {
    expect(PROBE_LINE.length).toBeLessThan(100);
    expect(PROBE_REPLY.split(" ").length).toBe(1);
    const rules = src("rootfs/opt/cain/CLAUDE.md");
    expect(rules).toContain("text exactly `alive`");
    expect(rules).toContain("no other tool call");
  });
});

describe("limits seen", () => {
  const box = "─".repeat(20);
  const LIMIT_SCREEN = `> Relayed by the add-on: Dane tapped "Start" on your question\n  ⎿  You've hit your monthly spend limit for claude-fable-5-2 · /usage-credits to raise it\n${box}\n> \n${box}\n  ? for shortcuts            auto mode on\n`;
  test("the probe reads a captured limit screen as its own status, never ready, and alarms at once", () => {
    expect(screenOf(LIMIT_SCREEN, "ready")).toBe("limit");
    expect(screenOf("  ⎿  Claude usage limit reached. Your limit resets at 9am\n> \n", "ready")).toBe("limit");
    expect(screenOf(`hello\n${box}\n> \n${box}\n? for shortcuts\n`, "ready")).toBe("ready");
    const f = { now: T, plugin: true, tmux: true, gateway: { state: "connected", ack: T }, delivered: T, slot: null };
    const p = pass(f, {}, { screen: "limit" });
    expect(p.status).toBe("limit");
    expect(alarmFor([p])).toBe("usage-limit");
  });
  test("its alarm names the fix through the existing alarm path", () => {
    const r = Bun.spawnSync(["bash", join(OPT, "notice.sh"), "text", "usage-limit", ""]);
    expect(r.exitCode).toBe(0);
    const [title, msg] = r.stdout.toString().split("\n");
    expect(title).toBe("Cain hit a usage limit");
    expect(msg).toContain("switch his model, or raise the limit");
    expect(msg).not.toContain("—");
  });
});

describe("the daily usage line", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const at = (h: number) => new Date((1795064400 + h * 3600) * 1000).toISOString();   // Nov 19, 2026, from midnight in New York
  const call = (id: string, h: number, read: number, model = "claude-opus-5-5") =>
    line({ type: "assistant", timestamp: at(h), message: { id, model, usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 100, output_tokens: 50 } } });
  const FIXTURE = [
    line({ type: "user", timestamp: at(1), message: { content: '<channel source="plugin:discord:discord" chat_id="1" user="dane">hi</channel>' } }),
    call("m1", 1, 200_000), call("m1", 1, 200_000),                  // one call written on two lines
    line({ type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", content: "ok" }] } }),
    call("m2", 2, 210_000),
    line({ type: "user", timestamp: at(3), message: { content: "[1a2b3c4d] Relayed by the add-on: cloud jobs changed, as code read them" } }),
    call("m3", 3, 300_000),
    line({ type: "user", timestamp: at(4), message: { content: '<channel source="plugin:discord:discord" chat_id="000000000000000000" user="cain-app-probe">App liveness check</channel>' } }),
    call("m4", 4, 100_000),
    line({ type: "user", timestamp: at(5), message: { content: "[1a2b3c4e] Scheduled check-in from the Cain add-on (morning)." } }),
    line({ type: "system", subtype: "compact_boundary", timestamp: at(5) }),
    call("m5", 5, 50_000, "claude-sonnet-5-5"),
    call("m6", 30, 999_999),                                         // the next day: not counted
    "not json",
  ];
  test("tokens by model and by what started the turn, context per call and compactions, from a fixture transcript", () => {
    expect(starterOf("[1a2b3c4d] Daily digest from the Cain add-on (2026-11-19): 2 relayed lines")).toBe("digest");
    const u = usageOf(FIXTURE, "2026-11-19", "America/New_York");
    expect(u.calls).toBe(5);
    expect(u.cacheRead).toBe(860_000);
    expect(u.compactions).toBe(1);
    expect(Object.keys(u.byStarter).sort()).toEqual(["checkin", "job", "owner", "probe"]);
    expect(u.byStarter.owner).toBe(2 * 160 + 410_000);
    const l = usageLine("2026-11-19", u, usageOf([], "2026-11-19", "America/New_York"), { handled: 4, missed: 0 });
    for (const must of ["usage 2026-11-19: his session 5 calls", "cache reads 860K", "claude-opus-5-5", "claude-sonnet-5-5", "owner 410K", "job 300K",
      "context per call: median 200K", "max 300K", "compactions 1", "handled without a turn in 7 days: 4"]) expect(l).toContain(must);
    // Through the command, as checkin.sh runs it once a day, from his projects folder.
    const d = tmp();
    mkdirSync(join(d, "-data-work"));
    writeFileSync(join(d, "-data-work", "s.jsonl"), FIXTURE.join("\n"));
    const r = lean(["usage", "2026-11-19", d, "4 0"], { LEAN_NOW: "1795150000" });
    expect(r.out.trim()).toBe(l);
    expect(src("rootfs/opt/cain/checkin.sh")).toContain('bun "$LEAN" usage "$y" "$TRANSCRIPTS" "$c"');
  });
});
