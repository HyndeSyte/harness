// Cain 0.20.0, the first outside review's fixes to the owner's review rule (R-013): each of the seven with a test
// that fails without it.
//   1. sorting can't be zeroed by one seat (review/core.ts isSerious, runner.ts sortPass)
//   2. both Ship paths at the cap bind to an exact head, at the card and again at the tap (link/cap.ts, link/core.ts)
//   3. the cut check asks whether the piece's stated purpose still works (core.ts CUT_RULE, cutResult)
//   4. the runner derives the cut diff through git and chooses the seat; one check reserved atomically (cutdiff.ts,
//      rounds.ts reserveCut, runner.ts admitCutCheck and prepareCut)
//   5. the owner hears one plain line, from code; review.sh decide; the reminders (runner.ts, link/core.ts reviewLine)
//   6. the message gate holds a reply asking him about rounds, risk or cuts (gate/cain.ts, gate/send.ts)
//   7. label adherence is measured per seat and round (runner.ts noteLabels, labelRate)
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_CHECK, cutResult, prompt, seriousLeft, validArm, verdictsMd, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, labelRate, loadReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { checkDecision, cutLockOf, readRounds, reserveCut } from "../rootfs/opt/cain/review/rounds.ts";
import { CUT_ADD_ALLOWANCE, gitCutDiff, judgeCut } from "../rootfs/opt/cain/review/cutdiff.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { capStateFor, ownerLineText } from "../rootfs/opt/cain/link/cap.ts";
import { BOUND_MOVED, BOUND_TAP } from "../rootfs/opt/cain/link/core.ts";
import { decideSend } from "../rootfs/opt/cain/gate/send.ts";
import { HELD } from "../rootfs/opt/cain/gate/send.ts";
import { NOV11_8AM, MIN, PR, rig, SHA1, SHA2 } from "./link-rig";

const NOW = new Date("2026-11-26T15:00:00Z");
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-26-fix-a", topic: "Calendar retries", question: "Do retries keep each change exactly once?", body: "Retry a failed write.",
  needs_facts: false, consequential: false, pr: PRN(40), head: SHA1, label: "core", ...over,
});
const cutBrief = (over: Partial<Brief> = {}): Brief => brief({ id: "2026-11-26-cut", kind: CUT_CHECK, head: SHA2, topic: "The cut", question: "Is the cut sound?",
  body: "The cut removes the retry loop.", ...over });
const said = (verdict: SeatAnswer["verdict"], ...problems: string[]): SeatAnswer =>
  ({ verdict, findings: problems.map((p, i) => ({ rank: i + 1, problem: p, fix: "fix it" })), model: "m", cost_usd: 0.01 });
const cutPass = () => said("approve", "FOLLOW-UP (loses or corrupts): Q1. Gone.", "FOLLOW-UP (acts wrongly): Q2. Nothing new.",
  "FOLLOW-UP (fails silently): Q3. Tests pass.", "FOLLOW-UP (acts wrongly): Q4. The purpose still works.");
const SER = "SERIOUS (loses or corrupts): a crash between two writes loses the record";
type Answer = (i: SeatInput) => Promise<SeatAnswer>;
const okDiff = async () => ({ ok: true as const, diff: "--- a/x.ts\n+++ b/x.ts\n-retry()\n", judged: { ok: true as const, reverts: 0, allowed: 0 } });

function rules(o: { openai?: Answer; gemini?: Answer; perplexity?: Answer; claude?: Answer; cutDiff?: any; postLine?: any; down?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rulefix-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), inboxDir: join(dir, "inbox"),
    inboxUid: process.getuid!(), reviewedFile: join(dir, "reviewed.json"), roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const calls: { seat: string; input: SeatInput }[] = [];
  const of = (seat: string, a: Answer | undefined): SeatFn => async (i) => { calls.push({ seat, input: i }); return (a ?? (async (x: SeatInput) => x.brief.check ? cutPass() : said("approve")))(i); };
  const seats: any = { openai: of("openai", o.openai), gemini: of("gemini", o.gemini), claude: of("claude", o.claude) };
  if (o.perplexity) seats.perplexity = of("perplexity", o.perplexity);
  let clock = NOW;
  const lines: any[] = [];
  const diffs: any[] = [];
  const runner = new Runner(cfg, { seats, now: () => clock, rand: () => 0.5, log: () => {},
    plan: () => ({ fraction: 0.1, at: NOW.toISOString(), reason: "t", tokens_week: 1, files: 1 }),
    unavailable: (s) => (o.down ?? []).includes(s) ? { kind: "unconfigured", detail: "down" } : null,
    cutDiff: async (a: any) => { diffs.push(a); return (o.cutDiff ?? okDiff)(a); },
    postLine: o.postLine ?? (async (l: any) => { lines.push(l); return `m-${lines.length}`; }) });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  const round = async (id: string, over: Partial<Brief> = {}) => {
    const why = runner.admitAndQueue(brief({ id, seats: o.perplexity ? ["openai", "gemini", "perplexity"] : ["openai", "gemini"], ...over }));
    if (why) throw new Error(why);
    await runner.tick();
    return loadReview(cfg.queueDir, id)!;
  };
  const decide = (d: any) => { mkdirSync(cfg.inboxDir!, { recursive: true }); writeFileSync(join(cfg.inboxDir!, `decide-${Date.now()}-${Math.random()}.decision`), JSON.stringify(d)); };
  return { dir, cfg, runner, calls, relays, round, lines, diffs, decide, later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    rounds: () => readRounds(cfg.roundsFile!)!, get: (id: string) => loadReview(cfg.queueDir, id)! };
}
const strict: Answer = async (i) => i.brief.sort ? said("approve") : i.brief.check ? cutPass() : said("approve_with_changes", SER);
async function atCap(o: Parameters<typeof rules>[0] = {}) {
  const t = rules({ openai: strict, ...o });
  for (const id of ["c-1", "c-2", "c-3"]) await t.round(id);
  return t;
}

// A round's record, by hand, for the sorting count.
const seat = (key: string, s: any, extra: any = {}) => ({ key, seat: s, role: s === "perplexity" ? "facts" : "reviewer", state: "done", provider: "", family: "",
  counts: s !== "claude" && !extra.stands_in_for, attempts: 1, cost_usd: 0, verdict: "approve", findings: [], ...extra });
const F = { rank: 1, problem: "loses the record", fix: "x", severity: "serious" as const };
const base = (): any => ({ round_kind: "fixes", seats: [seat("openai", "openai", { findings: [F] }), seat("gemini", "gemini"), seat("perplexity", "perplexity"),
  seat("claude-for-gemini", "claude", { stands_in_for: "gemini" })] });
const fu = (by: string, arm = "fails silently") => ({ by, ref: "openai#0", label: "follow-up" as const, arm, reason: "it alarms when it gives up" });
const sr = (by: string) => ({ by, ref: "openai#0", label: "serious" as const, arm: "loses or corrupts", reason: "it can lose it" });
const left = (sorts: any[]) => seriousLeft({ ...base(), sorts }).length;

describe("1: sorting can't be zeroed by one seat", () => {
  test("one lenient seat against two strict keeps it serious", () => {
    expect(left([fu("gemini"), sr("perplexity")])).toBe(1);
    expect(left([fu("gemini"), sr("openai")])).toBe(1);             // the raiser reaffirming it
  });
  test("two non-raiser outside seats both naming an arm downgrade it", () => {
    expect(left([fu("gemini"), fu("perplexity", "loses or corrupts")])).toBe(0);
  });
  test("a stand-in's demotion doesn't count", () => {
    expect(left([fu("claude-for-gemini")])).toBe(1);
    expect(left([{ ...fu("claude"), by: "claude" }])).toBe(1);
  });
  test("a reason without a valid arm doesn't count", () => {
    expect(left([fu("gemini", "it is fine")])).toBe(1);
    expect(left([{ ...fu("gemini"), arm: undefined }])).toBe(1);
    expect(left([fu("gemini", "Fails  Silently")])).toBe(0);
    expect(validArm("exposes or widens")).toBe(true);
    expect(validArm("hardening")).toBe(false);
  });
  test("a seat demoting all its own findings keeps them in the sort, and another seat's serious label counts", async () => {
    const t = rules({
      openai: async (i) => i.brief.sort ? said("approve") : said("approve_with_changes", "FOLLOW-UP (fails silently): the retry gives up without a word", "FOLLOW-UP (acts wrongly): it posts twice"),
      gemini: async (i) => i.brief.sort ? said("approve", "SERIOUS (fails silently) [1]: nobody hears it give up", "FOLLOW-UP (acts wrongly) [2]: it is deduplicated") : said("approve"),
    });
    for (const id of ["s-1", "s-2", "s-3"]) await t.round(id);
    const sortCall = t.calls.find((c) => c.seat === "gemini" && c.input.brief.sort)!;
    expect(sortCall.input.brief.sort!.length).toBe(2);
    expect(sortCall.input.brief.sort![0]).toContain("[follow-up: fails silently] the retry gives up without a word");
    // The raiser sorts its own findings too (it may reaffirm one).
    expect(t.calls.some((c) => c.seat === "openai" && c.input.brief.sort)).toBe(true);
    const r = t.get("s-3");
    expect(seriousLeft(r).map((f) => f.problem)).toEqual(["the retry gives up without a word"]);
    expect(t.rounds().changes["pr-40"].rounds[2].serious).toBe(1);
    expect(verdictsMd(r)).toContain("So it counts as serious.");
  });
});

describe("2: both Ship paths at the cap bind to an exact head", () => {
  const FACTS = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "x", bumps: [{ app: "Cain", version: "0.20.0" }], merged: false };
  const at = new Date(NOV11_8AM - 10 * MIN).toISOString();
  const roundsWith = (serious: number, cut?: any, lastHead = SHA1) => ({ format: 1, changes: { "pr-5": { pr: PR, rounds: [1, 2, 3].map((n) => ({ id: `r-${n}`,
    at: `2026-11-1${n}`, kind: n === 1 ? "full" : "fixes", state: "answered", done: true, serious: n === 3 ? serious : 0, head: lastHead })), ...(cut ? { cut } : {}) } } });
  function shipRig(rounds: any, reviews: any[]) {
    const r = rig({ facts: true });
    r.github.facts = { ...FACTS } as any;
    r.reviews.list = reviews;
    Object.assign((r.link as any).d, { capState: (pr: string) => capStateFor(pr, rounds, 3) });
    return r;
  }
  const ship = (r: any, head: string, review?: string) => r.link.ship({ text: "Cards keep their place.", item: "P64", pr: PR, head, review });
  const snap = (m: any) => JSON.parse(JSON.stringify(m));
  const r3 = (head = SHA1) => ({ id: "r-3", line: "Reviewed: OpenAI, approve; Gemini, approve.", finished_at: at, pr: PR, head });
  const cut = { id: "cut-1", at, head: SHA2, pr: PR, seat: "openai", base: SHA1, state: "pass" };
  const cutRev = { id: "cut-1", line: "Cut checked: OpenAI, pass.", finished_at: at, pr: PR, head: SHA2 };

  test("nothing serious left: a head pushed after round 3 gets no card", async () => {
    const r = shipRig(roundsWith(0), [r3(SHA2)]);
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r, SHA2, "r-3")).rejects.toThrow("only the head its last review round reviewed ships");
    // A round recorded with no head binds nothing.
    const legacy = roundsWith(0);
    for (const x of legacy.changes["pr-5"].rounds) delete (x as any).head;
    await expect(ship(shipRig(legacy, [r3()]), SHA1, "r-3")).rejects.toThrow("names no head");
  });

  test("nothing serious left: the card's head moving on GitHub before the tap lands nothing", async () => {
    const r = shipRig(roundsWith(0), [r3()]);
    const ok = await ship(r, SHA1, "r-3");
    expect(ok.status).toBe("posted");
    expect(r.state().messages[ok.message].ship).toMatchObject({ head: SHA1, bound: "clean" });
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await r.tap(snap(r.msg(ok.message)), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(String(r.msg(ok.message).content)).toContain(BOUND_TAP);
    expect(r.relayed.join("\n")).toContain(BOUND_MOVED);
  });

  test("nothing serious left, the head unmoved: the tap lands it", async () => {
    const r = shipRig(roundsWith(0), [r3()]);
    const ok = await ship(r, SHA1, "r-3");
    await r.tap(snap(r.msg(ok.message)), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([{ pr: PR, head: SHA1 }]);
  });

  test("the cut path: a head pushed after the cut is refused at the card and at the tap", async () => {
    const r = shipRig(roundsWith(1, cut), [cutRev]);
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    const ok = await ship(r, SHA2, "cut-1");
    expect(r.state().messages[ok.message].ship).toMatchObject({ head: SHA2, bound: "cut" });
    r.github.facts = { ...FACTS, head: "3".repeat(40) } as any;
    await expect(ship(r, "3".repeat(40), "cut-1")).rejects.toThrow("only that cut head ships");
    await r.tap(snap(r.msg(ok.message)), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(String(r.msg(ok.message).content)).toContain(BOUND_TAP);
  });

  test("a Cut checked line copied onto another card is refused", async () => {
    // A change at its cap with nothing serious left: its card can't carry a cut check's line.
    const r = shipRig(roundsWith(0, undefined, SHA2), [{ ...cutRev }]);
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r, SHA2, "cut-1")).rejects.toThrow("isn't this change's cut check at its cap");
    // A change not at its cap at all: the same.
    const r2 = shipRig({ format: 1, changes: {} }, [{ ...cutRev }]);
    r2.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r2, SHA2, "cut-1")).rejects.toThrow("isn't this change's cut check at its cap");
  });

  test("a cut check id from another pull request is refused", async () => {
    // Pull request 6 replaced 5 (its rounds carried over), and the cut check passed for 6: a card for 5 can't use it.
    const rounds: any = roundsWith(1);
    rounds.changes["pr-6"] = { pr: PRN(6), links: ["pr-5"], rounds: [], cut: { ...cut, pr: PRN(6) } };
    const r = shipRig(rounds, [{ ...cutRev, pr: PRN(6) }]);
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r, SHA2, "cut-1")).rejects.toThrow("its cut check is of another pull request");
    // And a card naming another pull request's cut check by id, on a change whose own cut passed.
    const r2 = shipRig(roundsWith(1, cut), [cutRev, { id: "cut-6", line: "Cut checked: Gemini, pass.", finished_at: at, pr: PRN(6), head: SHA2 }]);
    r2.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r2, SHA2, "cut-6")).rejects.toThrow("--review cut-1");
  });
});

describe("3: the cut check asks whether the piece's purpose still works", () => {
  test("the purpose is quoted from the change's first brief, and the fourth question asks about it", async () => {
    const t = await atCap();
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    const sent = t.calls.find((c) => c.input.brief.check)!.input.brief;
    expect(sent.purpose).toBe("Topic: Calendar retries\nQuestion: Do retries keep each change exactly once?");
    const p = prompt(sent, "reviewer");
    expect(p.user).toContain("<purpose>\nTopic: Calendar retries");
    expect(p.system).toContain("4. Does the piece's stated purpose, inside <purpose>, still work after the cut?");
  });
  test("a cut that removes the feature's core path fails", async () => {
    const t = await atCap({ openai: async (i) => i.brief.check
      ? said("approve", "FOLLOW-UP (loses or corrupts): Q1. Gone.", "FOLLOW-UP (acts wrongly): Q2. Nothing new.", "FOLLOW-UP (fails silently): Q3. Tests pass.",
        "SERIOUS (acts wrongly): Q4. The retry was the feature: without it nothing is retried.")
      : (await strict(i)) });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(cutResult(t.get("2026-11-26-cut"))).toBe("fail");
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
  });
  test("an answer missing the fourth question, or unreadable, fails", () => {
    const r = (findings: string[], verdict = "approve") => cutResult({ kind: CUT_CHECK, status: "done",
      seats: [seat("openai", "openai", { verdict, findings: findings.map((p, i) => ({ rank: i + 1, problem: p, fix: "", severity: "follow-up" })) })] } as any);
    expect(r(["Q1. a", "Q2. b", "Q3. c", "Q4. d"])).toBe("pass");
    expect(r(["Q1. a", "Q2. b", "Q3. c"])).toBe("fail");
    expect(r([])).toBe("fail");
    expect(r(["Q1. a", "Q2. b", "Q3. c", "Q4. d"], "reject")).toBe("fail");
  });
});

describe("4: the runner derives the cut diff and chooses the seat", () => {
  // A repository like GitHub's: main, then the pull request's head (refs/pull/40/head).
  function repo() {
    const d = mkdtempSync(join(tmpdir(), "cutgit-"));
    const g = (...a: string[]) => { const r = spawnSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    g("init", "-q", "-b", "main");
    writeFileSync(join(d, "app.ts"), "export function run() {\n  return 1;\n}\n");
    g("add", "."); g("commit", "-q", "-m", "main");
    const commit = (content: string, msg: string) => { writeFileSync(join(d, "app.ts"), content); g("add", "."); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
    return { d, g, commit };
  }
  const derive = (d: string) => gitCutDiff({ repo: join(mkdtempSync(join(tmpdir(), "cutbare-")), "cut.git"), remote: d });

  test("a cut that only removes what the change added passes the diff check; one that adds code fails", async () => {
    const { d, g, commit } = repo();
    g("checkout", "-q", "-b", "pr");
    const reviewed = commit("export function run() {\n  retry();\n  return 1;\n}\nfunction retry() { loop(); }\n", "the change");
    const cutOk = commit("export function run() {\n  return 1;\n}\n", "the cut");
    g("update-ref", "refs/pull/40/head", cutOk);
    const good = await derive(d)({ pr: PRN(40), base: reviewed, head: cutOk });
    expect(good.ok && good.judged.ok).toBe(true);
    if (good.ok) expect(good.diff).toContain("-  retry();");
    const cutBad = commit("export function run() {\n  return 2;\n}\nexport function other() { send(); }\n", "a cut that adds code");
    g("update-ref", "refs/pull/40/head", cutBad);
    const bad = await derive(d)({ pr: PRN(40), base: reviewed, head: cutBad });
    expect(bad.ok).toBe(true);
    if (bad.ok) { expect(bad.judged.ok).toBe(false); expect((bad.judged as any).why).toContain("new code"); }
  });

  test("a cut head that doesn't descend from the last-reviewed head is refused", async () => {
    const { d, g, commit } = repo();
    g("checkout", "-q", "-b", "pr");
    const reviewed = commit("export function run() {\n  retry();\n  return 1;\n}\n", "the change");
    g("checkout", "-q", "main"); g("checkout", "-q", "-b", "other");
    const elsewhere = commit("export function run() {\n  return 3;\n}\n", "not a cut of it");
    g("update-ref", "refs/pull/40/head", elsewhere);
    g("update-ref", "refs/heads/keep", reviewed);
    const got = await derive(d)({ pr: PRN(40), base: reviewed, head: elsewhere });
    // The reviewed head isn't on the pull request's ref any more: refused either way, never judged.
    expect(got.ok).toBe(false);
    expect((got as any).kind).toBe("refused");
    // Both reachable, still not a descendant.
    g("update-ref", "refs/heads/main", reviewed);
    const got2 = await derive(d)({ pr: PRN(40), base: reviewed, head: elsewhere });
    expect(got2).toMatchObject({ ok: false, kind: "refused", why: expect.stringContaining("doesn't descend") });
  });

  test("the allowance: reverts, imports and test lines pass up to the stated amount", () => {
    expect(judgeCut([{ path: "a.ts", added: ["  old();", "import { x } from \"./x\";"], removed: [] }], () => ["  old();"]).ok).toBe(true);
    expect(judgeCut([{ path: "tests/a.test.ts", added: Array.from({ length: CUT_ADD_ALLOWANCE + 1 }, (_, i) => `expect(${i});`), removed: [] }], () => []).ok).toBe(false);
  });

  test("in the runner: an added-code cut fails without a seat, and the owner hears it is held", async () => {
    const t = await atCap({ cutDiff: async () => ({ ok: true, diff: "+send()\n", judged: { ok: false, why: "the cut adds 1 line(s) of new code" } }) });
    t.calls.length = 0;
    expect(t.runner.admitAndQueue(cutBrief())).toBeNull();
    await t.runner.tick();
    expect(t.calls.length).toBe(0);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(t.lines.filter((l) => l.outcome === "cut-fail")).toHaveLength(1);
    expect(t.diffs[0]).toEqual({ pr: PRN(40), base: SHA1, head: SHA2 });
  });

  test("in the runner: a non-descendant head is refused and uses nothing up", async () => {
    let n = 0;
    const t = await atCap({ cutDiff: async () => (n++ === 0 ? { ok: false, kind: "refused", why: "the cut head doesn't descend from the head the last review round reviewed" } : okDiff()) });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].cut).toBeUndefined();
    expect(t.relays().pop()).toContain("was refused before anything was sent");
    expect(t.runner.admitAndQueue(cutBrief({ id: "2026-11-26-cut-2" }))).toBeNull();
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].cut).toMatchObject({ id: "2026-11-26-cut-2", state: "pass" });
  });

  test("an infrastructure error retries with the same diff and doesn't use the check up", async () => {
    let n = 0, seatN = 0;
    const t = await atCap({
      cutDiff: async () => (n++ === 0 ? { ok: false, kind: "infra", why: "git fetch failed" } : okDiff()),
      openai: async (i) => { if (!i.brief.check) return strict(i); if (seatN++ === 0) throw new Error("bad output"); return cutPass(); },
    });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("started");
    for (let i = 0; i < 4; i++) { t.later(3_600_000); await t.runner.tick(); }
    expect(n).toBe(2);                                         // derived once it could be, then kept
    const sent = t.calls.filter((c) => c.input.brief.check);
    expect(sent.length).toBe(2);
    expect(sent[0].input.brief.diff).toBe(sent[1].input.brief.diff);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("pass");
  });

  test("two cut briefs at once yield one check (the reservation is atomic)", async () => {
    const t = await atCap();
    expect(t.runner.admitAndQueue(cutBrief({ id: "cut-a" }))).toBeNull();
    // A second runner whose read of the rounds file predates the first's write still finds the reservation.
    const r = t.rounds();
    delete r.changes["pr-40"].cut;
    writeFileSync(t.cfg.roundsFile!, JSON.stringify(r));
    expect(t.runner.admitAndQueue(cutBrief({ id: "cut-b" }))).toContain("another was reserved first");
    expect(existsSync(cutLockOf(t.cfg.roundsFile!, "pr-40"))).toBe(true);
    expect(reserveCut(t.cfg.roundsFile!, "pr-40", "cut-c", () => false)).toBe(false);
  });

  test("a second candidate after a fail is refused", async () => {
    const t = await atCap({ openai: async (i) => i.brief.check ? said("reject", "SERIOUS (acts wrongly): Q1. Still there.") : strict(i) });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(t.runner.admitAndQueue(cutBrief({ id: "2026-11-26-cut-2" }))).toContain("already had its one cut check");
  });

  test("a seat named in the brief is ignored; the runner prefers the seat whose serious findings were downgraded", async () => {
    const t = await atCap();
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief({ seats: ["gemini"] }));
    await t.runner.tick();
    expect(t.calls.map((c) => c.seat)).toEqual(["openai"]);
    // Gemini raised two; OpenAI downgraded one in the sort (with Gemini not reaffirming): Gemini checks the cut.
    const u = rules({
      gemini: async (i) => i.brief.sort ? said("approve") : i.brief.check ? cutPass() : said("approve_with_changes", SER, "SERIOUS (acts wrongly): it posts twice"),
      openai: async (i) => i.brief.sort ? said("approve", "FOLLOW-UP (fails silently) [1]: it is journalled first") : said("approve"),
    });
    for (const id of ["g-1", "g-2", "g-3"]) await u.round(id);
    u.calls.length = 0;
    u.runner.admitAndQueue(cutBrief({ seats: ["openai"] }));
    await u.runner.tick();
    expect(u.calls.map((c) => c.seat)).toEqual(["gemini"]);
  });
});

describe("5: the owner hears one line, in code", () => {
  test("clean: one line, and a repeat produces none", async () => {
    const t = rules();
    for (const id of ["n-1", "n-2", "n-3"]) await t.round(id);
    await t.runner.tick(); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["clean"]);
    expect(t.lines[0]).toMatchObject({ id: "pr-40#clean", topic: "Calendar retries" });
    expect(ownerLineText(t.lines[0])).toBe("Calendar retries: its last outside review round left nothing serious, so its Ship card follows.");
  });

  test("cap reached, then held by review.sh decide: one line each, the held one with its why", async () => {
    const t = await atCap();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap"]);
    expect(ownerLineText(t.lines[0])).toBe("Calendar retries: its third and last outside review round left one serious finding, so Cain now holds it or cuts those parts.");
    t.decide({ change: "pr-40", choice: "hold", why: "the retry is the feature, so a cut would leave nothing" });
    await t.runner.tick();
    t.decide({ change: "pr-40", choice: "hold", why: "again" });
    await t.runner.tick(); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "held"]);
    expect(ownerLineText(t.lines[1])).toBe("Calendar retries, held: the retry is the feature, so a cut would leave nothing.");
    expect(t.rounds().changes["pr-40"].decided).toMatchObject({ choice: "hold" });
    expect(t.relays().pop()).toContain("is decided already");
    // Held: no cut check, and no Ship card.
    expect(t.runner.admitAndQueue(cutBrief())).toContain("is held");
    expect(capStateFor(PRN(40), t.rounds(), 3)).toMatchObject({ state: "held", why: expect.stringContaining("Cain held it") });
  });

  test("cut-pass and cut-fail: one line each", async () => {
    const t = await atCap();
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick(); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "cut-pass"]);
    expect(t.rounds().changes["pr-40"].decided).toMatchObject({ choice: "cut" });
    const u = await atCap({ openai: async (i) => i.brief.check ? said("reject", "SERIOUS (acts wrongly): Q1. Still there.") : strict(i) });
    u.runner.admitAndQueue(cutBrief());
    await u.runner.tick(); await u.runner.tick();
    expect(u.lines.map((l) => l.outcome)).toEqual(["cap", "cut-fail"]);
    expect(ownerLineText(u.lines[1])).toBe("Calendar retries: the cut failed its outside check, so it is held.");
  });

  test("a line is retried until the link confirms it, and sent once", async () => {
    let n = 0;
    const got: any[] = [];
    const t = rules({ postLine: async (l: any) => { got.push(l); return n++ < 2 ? null : "m-1"; } });
    for (const id of ["n-1", "n-2", "n-3"]) await t.round(id);
    await t.runner.tick(); await t.runner.tick(); await t.runner.tick();
    expect(got.length).toBe(3);
    expect(t.rounds().changes["pr-40"].lines!.clean).toMatchObject({ state: "sent", message: "m-1", tries: 2 });
  });

  test("undecided: one reminder to Cain after an hour, one line to him after a day", async () => {
    const t = await atCap();
    const reminders = () => t.relays().filter((l) => l.includes("still undecided"));
    t.later(30 * MIN); await t.runner.tick();
    expect(reminders()).toHaveLength(0);
    t.later(31 * MIN); await t.runner.tick(); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toContain('review.sh decide pr-40 hold "<why, in one line>"');
    t.later(24 * 3_600_000); await t.runner.tick(); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "undecided"]);
  });

  test("the decision's why is one plain line: no question, nothing about rounds, risk or cuts", () => {
    expect(checkDecision({ change: "pr-40", choice: "hold", why: "Want more review rounds?" })).toContain("asks him nothing");
    expect(checkDecision({ change: "pr-40", choice: "hold", why: "" })).toContain("needs its why");
    expect(checkDecision({ change: PRN(40), choice: "hold", why: "it would break the sync" })).toEqual({ change: "pr-40", choice: "hold", why: "it would break the sync" });
    expect(checkDecision({ change: "pr-40", choice: "cut" })).toEqual({ change: "pr-40", choice: "cut" });
  });

  test("the link posts it as a plain line: no buttons, no question, once per id", async () => {
    const r = rig({});
    const a = await r.link.reviewLine({ id: "pr-40#held", outcome: "held", topic: "Calendar retries", why: "the retry is the feature" });
    expect(a.status).toBe("posted");
    expect(String(r.msg(a.message).content)).toBe("Calendar retries, held: the retry is the feature.");
    expect(r.msg(a.message).components ?? []).toEqual([]);
    const again = await r.link.reviewLine({ id: "pr-40#held", outcome: "held", topic: "Calendar retries", why: "the retry is the feature" });
    expect(again).toMatchObject({ duplicate: true, message: a.message });
    expect(r.posts()).toBe(1);
    // Cain's words that his rules hold are left out, never posted.
    const b = await r.link.reviewLine({ id: "pr-41#held", outcome: "held", topic: "Calendar — retries", why: "x" });
    expect(String(r.msg(b.message).content)).toBe("A change, held.");
    await expect(r.link.reviewLine({ id: "pr-41#x", outcome: "x" })).rejects.toThrow("not a line from the review runner");
  });

  test("review.sh decide leaves it in the inbox for the runner, refusing what can't be kept", () => {
    const t = rules();
    const ROOT = join(import.meta.dir, "..");
    const run = (...args: string[]) => spawnSync("bun", [join(ROOT, "rootfs/opt/cain/review/cli.ts"), "decide", ...args], { encoding: "utf8",
      env: { ...process.env, CAIN_TEST_MODE: "1", REVIEW_INBOX: t.cfg.inboxDir!, REVIEW_ROUNDS: t.cfg.roundsFile!, REVIEW_SETTINGS: t.cfg.settingsFile! } });
    const no = run("pr-40", "hold", "it would break the sync");
    expect(no.status).toBe(3);
    expect(no.stderr).toContain("has no review rounds");
    expect(run("pr-40", "maybe").status).toBe(2);
  });

  test("review.sh decide at the cap: kept by the runner, and he hears the one held line", async () => {
    const t = await atCap();
    const ROOT = join(import.meta.dir, "..");
    const run = (...args: string[]) => spawnSync("bun", [join(ROOT, "rootfs/opt/cain/review/cli.ts"), "decide", ...args], { encoding: "utf8",
      env: { ...process.env, CAIN_TEST_MODE: "1", REVIEW_INBOX: t.cfg.inboxDir!, REVIEW_ROUNDS: t.cfg.roundsFile!, REVIEW_SETTINGS: t.cfg.settingsFile! } });
    expect(run("pr-40", "hold", "Should I cut it?").status).toBe(3);
    const ok = run("pr-40", "hold", "the retry is the feature");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('"held: the retry is the feature"');
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].decided).toMatchObject({ choice: "hold", why: "the retry is the feature" });
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "held"]);
    expect(run("pr-40", "cut").stderr).toContain("is decided already");
  });
});

describe("6: free-text replies are gated too", () => {
  const send = (text: string) => decideSend({ tool: "reply", text }, null, {});
  test("a reply asking whether to grant more rounds is held", () => {
    const d = send("The calendar fix hit its review cap. Want me to ask for two more review rounds?");
    expect(d.would).toBe("refuse");
    expect(d.hard).toBe(true);
    expect(d.said.startsWith(HELD)).toBe(true);
    expect(d.said).toContain("never ask him about them");
    expect(send("Should I ship it with that risk?").would).toBe("refuse");
    expect(decideSend({ tool: "edit", text: "Should I cut the parts the serious finding is about?", target: "1" }, null, {}).hits.some((h) => h.rule === "cap")).toBe(true);
  });
  test("a plain held line passes", () => {
    expect(send("The calendar fix, held: the retry is the feature, so a cut would leave nothing.").would).toBe("pass");
    expect(send("Held: two serious findings were left, so I'm holding it.").would).toBe("pass");
  });
});

describe("7: label adherence is measured", () => {
  test("the rate is computed from a round with one unlabelled finding", async () => {
    const t = rules({ openai: async () => said("approve_with_changes", "SERIOUS (acts wrongly): it posts twice", "it has no label") });
    const r = await t.round("l-1");
    expect(r.seats.find((s) => s.seat === "openai")!.labels).toEqual({ labelled: 1, total: 2 });
    const h = JSON.parse(readFileSync(t.cfg.healthFile, "utf8"));
    expect(h.labels.openai).toEqual([{ id: "l-1", round: 1, labelled: 1, total: 2, at: NOW.toISOString() }]);
    expect(labelRate(h.labels.openai)).toEqual({ labelled: 1, total: 2, rate: 0.5 });
    expect(labelRate(undefined).rate).toBeNull();
  });
});
