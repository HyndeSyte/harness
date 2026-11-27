// Cain 0.20.0, the second outside review's fixes to the owner's review rule (R-013), each with a test that fails
// without it. This is the change's last review round, so every fix fails closed.
//   1. the sort's panel is fixed before the sort, and a missing vote counts as serious (review/core.ts isSerious,
//      runner.ts sortPass)
//   2. the cut check can't be fished through retries: only transport failures retry, capped, every attempt kept; any
//      answer that isn't a clear pass fails (runner.ts fail, noteCutAttempt; seats/common.ts onBody)
//   3. the landing is pinned to the bound head (link/merge.ts land, link/core.ts settleLanding)
//   4. the cut diff's allowance is narrow, and the judge's independence is checked from the commits (cutdiff.ts,
//      runner.ts prepareCut)
//   5. the purpose is frozen after round 1 and written by the round 1 seats and the description, not by the cut
//      (rounds.ts essentialsOf, runner.ts freezePurpose, core.ts cutResult)
//   6. every non-terminal capped state has a deadline, a hold is final, and the fetch is checked at start (runner.ts
//      remind, holdUnchecked, start; review.sh health)
//   and: the hold's why through the gate's cap check, owed lines drained at start, the whole message gated.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_CHECK, SeatError, cutResult, seriousLeft, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, whatChangedOpening, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { CUT_TRANSPORT_MAX, checkDecision, readRounds, writeRounds } from "../rootfs/opt/cain/review/rounds.ts";
import { gitCutDiff, judgeCut, verifyFetch } from "../rootfs/opt/cain/review/cutdiff.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { capStateFor, ownerLineText } from "../rootfs/opt/cain/link/cap.ts";
import { BOUND_TAP } from "../rootfs/opt/cain/link/core.ts";
import { decideSend, HELD } from "../rootfs/opt/cain/gate/send.ts";
import { NOV11_8AM, MIN, PR, rig, SHA1, SHA2 } from "./link-rig";

const NOW = new Date("2026-11-27T15:00:00Z");
const HOUR = 3_600_000, DAY = 24 * HOUR;
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-27-fix-a", topic: "Calendar retries", question: "Do retries keep each change exactly once?", body: "Retry a failed write.",
  needs_facts: false, consequential: false, pr: PRN(40), head: SHA1, label: "core", ...over,
});
const cutBrief = (over: Partial<Brief> = {}): Brief => brief({ id: "2026-11-27-cut", kind: CUT_CHECK, head: SHA2, topic: "The cut", question: "Is the cut sound?",
  body: "The cut removes the retry loop.", ...over });
const said = (verdict: SeatAnswer["verdict"], ...problems: string[]): SeatAnswer =>
  ({ verdict, findings: problems.map((p, i) => ({ rank: i + 1, problem: p, fix: "fix it" })), model: "m", cost_usd: 0.01 });
const cutPass = (i?: SeatInput, file = "x.ts") => said("approve", "FOLLOW-UP (loses or corrupts): Q1. Gone.", "FOLLOW-UP (acts wrongly): Q2. Nothing new.",
  "FOLLOW-UP (fails silently): Q3. Tests pass.", ...(i?.brief.essentials ?? ["a", "b"]).map((_, k) => `FOLLOW-UP (acts wrongly): Q4.${k + 1}. Still done, evidence: ${file}:${k + 1}.`));
const withPurpose = (seat: string, i: SeatInput, a: SeatAnswer): SeatAnswer => i.brief.purpose_ask
  ? { ...a, findings: [{ rank: 0, problem: `PURPOSE: The piece keeps each calendar change exactly once when a failed write is retried (as ${seat} reads it).`, fix: "none" }, ...a.findings] } : a;
const SER = "SERIOUS (loses or corrupts): a crash between two writes loses the record";
const REASON = "it is written before the post and read back at start, so nothing is lost";
type Answer = (i: SeatInput) => Promise<SeatAnswer>;
const BUILD_COMMIT = { sha: "c".repeat(40), author: "HyndeSyte <HyndeSyte@users.noreply.github.com>", committer: "HyndeSyte <HyndeSyte@users.noreply.github.com>",
  message: "Cain 0.20.0: the cut\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n" };
const okDiff = (over: any = {}) => async () => ({ ok: true as const, diff: "--- a/x.ts\n+++ b/x.ts\n-retry()\n", context: " keep()\n-retry()\n",
  headFiles: { "x.ts": 10 }, commits: [BUILD_COMMIT], judged: { ok: true as const, reverts: 0, allowed: 0 }, ...over });

function rules(o: { openai?: Answer; gemini?: Answer; perplexity?: Answer; claude?: Answer; cutDiff?: any; postLine?: any; prBody?: any; verifyFetch?: any; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "rule2-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), inboxDir: join(dir, "inbox"),
    inboxUid: process.getuid!(), reviewedFile: join(dir, "reviewed.json"), roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const calls: { seat: string; input: SeatInput }[] = [];
  const of = (seat: string, a: Answer | undefined): SeatFn => async (i) => { calls.push({ seat, input: i });
    return withPurpose(seat, i, await (a ?? (async (x: SeatInput) => x.brief.check ? cutPass(x) : said("approve")))(i)); };
  const seats: any = { openai: of("openai", o.openai), gemini: of("gemini", o.gemini), claude: of("claude", o.claude) };
  if (o.perplexity) seats.perplexity = of("perplexity", o.perplexity);
  let clock = NOW;
  const lines: any[] = [];
  const runner = new Runner(cfg, { seats, now: () => clock, rand: () => 0.5, log: () => {},
    plan: () => ({ fraction: 0.1, at: NOW.toISOString(), reason: "t", tokens_week: 1, files: 1 }),
    cutDiff: o.cutDiff ?? okDiff(), prBody: o.prBody, verifyFetch: o.verifyFetch,
    postLine: o.postLine ?? (async (l: any) => { lines.push(l); return `m-${lines.length}`; }) });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  const round = async (id: string, over: Partial<Brief> = {}) => {
    const why = runner.admitAndQueue(brief({ id, seats: o.perplexity ? ["openai", "gemini", "perplexity"] : ["openai", "gemini"], ...(o.perplexity ? { needs_facts: true } : {}), ...over }));
    if (why) throw new Error(why);
    await runner.tick();
    return loadReview(cfg.queueDir, id)!;
  };
  const decide = (d: any) => { mkdirSync(cfg.inboxDir!, { recursive: true }); writeFileSync(join(cfg.inboxDir!, `decide-${Date.now()}-${Math.random()}.decision`), JSON.stringify(d)); };
  const checks = () => calls.filter((c) => c.input.brief.check);
  return { dir, cfg, runner, calls, checks, relays, round, lines, decide, later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    rounds: () => readRounds(cfg.roundsFile!)!, get: (id: string) => loadReview(cfg.queueDir, id)! };
}
const strict: Answer = async (i) => i.brief.sort ? said("approve") : i.brief.check ? cutPass(i) : said("approve_with_changes", SER);
async function atCap(o: Parameters<typeof rules>[0] = {}) {
  const t = rules({ openai: strict, ...o });
  for (const id of ["c-1", "c-2", "c-3"]) await t.round(id);
  return t;
}

// A round's record by hand, for the sorting count.
const seat = (key: string, s: any, extra: any = {}) => ({ key, seat: s, role: s === "perplexity" ? "facts" : "reviewer", state: "done", provider: "", family: "",
  counts: s !== "claude" && !extra.stands_in_for, attempts: 1, cost_usd: 0, verdict: "approve", findings: [], ...extra });
const F = { rank: 1, problem: "loses the record", fix: "x", severity: "serious" as const };
const fu = (by: string, reason = REASON) => ({ by, ref: "openai#0", label: "follow-up" as const, arm: "loses or corrupts", reason });

describe("1: the sort's panel is fixed before the sort, and a missing vote counts as serious", () => {
  test("one strict seat times out while one lenient seat demotes: it stays serious", async () => {
    const t = rules({
      openai: async (i) => i.brief.sort ? said("approve", `SERIOUS (loses or corrupts) [1]: ${REASON}`) : said("approve_with_changes", SER),
      gemini: async (i) => { if (i.brief.sort) throw new SeatError("timeout", "no answer"); return said("approve"); },
      perplexity: async (i) => i.brief.sort ? said("approve", `FOLLOW-UP (loses or corrupts) [1]: ${REASON}`) : said("approve"),
    });
    for (const id of ["p-1", "p-2", "p-3"]) await t.round(id);
    const r = t.get("p-3");
    expect(r.sort_panel).toEqual(["openai", "gemini", "perplexity"]);
    expect(r.sort_failed).toEqual(["gemini"]);
    expect(seriousLeft(r)).toHaveLength(1);
    expect(t.rounds().changes["pr-40"].rounds[2].serious).toBe(1);
  });
  test("one outside seat plus a Claude stand-in: it stays serious", () => {
    // The stand-in never votes; the seat it stands in for is on the panel and gave no sort.
    const r: any = { seats: [seat("openai", "openai", { findings: [F] }), seat("gemini", "gemini", { state: "substituted" }),
      seat("claude-for-gemini", "claude", { stands_in_for: "gemini" })], sorts: [fu("claude-for-gemini")] };
    expect(seriousLeft(r)).toHaveLength(1);
    // With no other outside seat at all: an empty electorate keeps it serious.
    const alone: any = { seats: [seat("openai", "openai", { findings: [F] }), seat("claude-for-gemini", "claude", { stands_in_for: "gemini" })], sorts: [fu("claude-for-gemini")] };
    expect(seriousLeft(alone)).toHaveLength(1);
  });
  test("the raiser failed to sort and two others demote with reasons: downgraded", async () => {
    const t = rules({
      openai: async (i) => { if (i.brief.sort) throw new SeatError("transient", "network"); return said("approve_with_changes", SER); },
      gemini: async (i) => i.brief.sort ? said("approve", `FOLLOW-UP (loses or corrupts) [1]: ${REASON}`) : said("approve"),
      perplexity: async (i) => i.brief.sort ? said("approve", `FOLLOW-UP (loses or corrupts) [1]: ${REASON}`) : said("approve"),
    });
    for (const id of ["q-1", "q-2", "q-3"]) await t.round(id);
    const r = t.get("q-3");
    expect(r.sort_failed).toEqual(["openai"]);
    expect(seriousLeft(r)).toHaveLength(0);
  });
  test("a reason that is only an arm name: it stays serious", () => {
    const r = (sorts: any[]) => seriousLeft({ seats: [seat("openai", "openai", { findings: [F] }), seat("gemini", "gemini"), seat("perplexity", "perplexity")], sorts } as any).length;
    expect(r([fu("gemini", "loses or corrupts"), fu("perplexity", "loses or corrupts")])).toBe(1);
    expect(r([fu("gemini", "Loses or corrupts."), fu("perplexity")])).toBe(1);
    expect(r([fu("gemini"), fu("perplexity")])).toBe(0);
    // A follow-up the raiser labelled itself: a missing vote of another panel seat makes it serious.
    const own = { ...F, severity: "follow-up" as const };
    expect(seriousLeft({ seats: [seat("openai", "openai", { findings: [own] }), seat("gemini", "gemini"), seat("perplexity", "perplexity")], sort_panel: ["openai", "gemini", "perplexity"],
      sorts: [fu("gemini")] } as any)).toHaveLength(1);
  });
});

describe("2: the cut check can't be fished through retries", () => {
  test("garbage, then what would be a pass: it fails, and nothing is sent a second time", async () => {
    let n = 0;
    const t = await atCap({ openai: async (i) => {
      if (!i.brief.check) return strict(i);
      if (n++ === 0) throw new SeatError("bad_output", "the service answered with something that was not JSON", 0, true);
      return cutPass(i);
    } });
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief());
    for (let i = 0; i < 4; i++) { await t.runner.tick(); t.later(HOUR); }
    expect(t.checks()).toHaveLength(1);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(t.lines.filter((l) => l.outcome === "cut-fail")).toHaveLength(1);
    expect(t.relays().join("\n")).toContain("answered, but not with a clear pass");
  });
  test("a timeout after the answer began is the check's answer: it fails", async () => {
    const t = await atCap({ openai: async (i) => {
      if (!i.brief.check) return strict(i);
      i.onBody?.();
      throw new SeatError("timeout", "no answer before the seat's deadline");
    } });
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief());
    for (let i = 0; i < 3; i++) { await t.runner.tick(); t.later(HOUR); }
    expect(t.checks()).toHaveLength(1);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(cutResult(t.get("2026-11-27-cut"))).toBe("fail");
  });
  test("transport failures retry, each kept, and the cap ends in the owner's one line", async () => {
    const t = await atCap({ openai: async (i) => { if (!i.brief.check) return strict(i); throw new SeatError("transient", "network: connection refused"); } });
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief());
    for (let i = 0; i < CUT_TRANSPORT_MAX + 4; i++) { await t.runner.tick(); t.later(HOUR); }
    const cut = t.rounds().changes["pr-40"].cut!;
    expect(cut.attempts).toHaveLength(CUT_TRANSPORT_MAX);
    expect(t.checks()).toHaveLength(CUT_TRANSPORT_MAX);
    expect(cut.state).toBe("lost");
    expect(t.rounds().changes["pr-40"].held?.why).toContain("the cut could not be checked");
    expect(t.lines.filter((l) => l.outcome === "unchecked")).toHaveLength(1);
    expect(t.lines.filter((l) => l.outcome !== "cap")).toHaveLength(1);
    expect(ownerLineText({ outcome: "unchecked", topic: "Calendar retries" })).toBe("Calendar retries: the cut could not be checked, so it is held.");
    expect(capStateFor(PRN(40), t.rounds(), 3)).toMatchObject({ state: "held" });
  });
});

describe("3: the landing is pinned to the bound head", () => {
  const FACTS = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "x", bumps: [{ app: "Cain", version: "0.20.0" }], merged: false };
  const at = new Date(NOV11_8AM - 10 * MIN).toISOString();
  const rounds = { format: 1, changes: { "pr-5": { pr: PR, rounds: [1, 2, 3].map((n) => ({ id: `r-${n}`, at: `2026-11-1${n}`, kind: n === 1 ? "full" : "fixes",
    state: "answered", done: true, serious: 0, head: SHA1 })) } } };
  test("a head that moves after the tap check and before the landing: nothing lands, and he reads the moved-head line", async () => {
    const r = rig({ facts: true });
    r.github.facts = { ...FACTS } as any;
    r.reviews.list = [{ id: "r-3", line: "Reviewed: OpenAI, approve; Gemini, approve.", finished_at: at, pr: PR, head: SHA1 }];
    Object.assign((r.link as any).d, { capState: (pr: string) => capStateFor(pr, rounds as any, 3) });
    const ok = await r.link.ship({ text: "Cards keep their place.", item: "P64", pr: PR, head: SHA1, review: "r-3" });
    // The tap-time check sees SHA1; GitHub's head moves before the push, so the landing (merge.ts land) refuses.
    r.github.answers.push({ ok: false, why: "its branch moved on since the card: it has newer commits", again: false, moved: true });
    await r.tap(JSON.parse(JSON.stringify(r.msg(ok.message))), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.main).toEqual([]);
    expect(String(r.msg(ok.message).content)).toContain(BOUND_TAP);
    expect(r.relayed.join("\n")).toContain("the pull request's head moved after his tap, so nothing landed");
  });
});

describe("4: the cut diff's allowance is narrow, and the judge's independence is checked", () => {
  test("an added function in a file named like a test, outside the test directories, is refused", () => {
    const sneak = ["export function sneak() { send(); }"];
    expect(judgeCut([{ path: "cain/rootfs/opt/cain/review/x.test.ts", added: sneak, removed: [] }], () => []).ok).toBe(false);
    expect(judgeCut([{ path: "cain/rootfs/opt/cain/tests/x.ts", added: sneak, removed: [] }], () => []).ok).toBe(false);
    expect(judgeCut([{ path: "cain/tests/x.test.ts", added: sneak, removed: [] }], () => []).ok).toBe(true);
    // The changelog is each App's one file.
    expect(judgeCut([{ path: "cain/rootfs/opt/cain/CHANGELOG.md", added: ["- cut"], removed: [] }], () => []).ok).toBe(false);
    expect(judgeCut([{ path: "cain/CHANGELOG.md", added: ["- cut"], removed: [] }], () => []).ok).toBe(true);
  });
  test("a side-effecting import, or one naming what the code left doesn't use, is refused", () => {
    const after = () => ['import { used } from "./x.ts";', "used();"];
    expect(judgeCut([{ path: "a.ts", added: ['import "./side.ts";'], removed: [] }], () => [], after).ok).toBe(false);
    expect(judgeCut([{ path: "a.ts", added: ['import { used } from "./x.ts"; boot();'], removed: [] }], () => [], after).ok).toBe(false);
    expect(judgeCut([{ path: "a.ts", added: ['import { unused } from "./x.ts";'], removed: [] }], () => [], after).ok).toBe(false);
    expect(judgeCut([{ path: "a.ts", added: ['export { used } from "./x.ts";'], removed: [] }], () => [], after).ok).toBe(false);
    expect(judgeCut([{ path: "a.ts", added: ['import { used } from "./x.ts";'], removed: [] }], () => [], after).ok).toBe(true);
  });
  test("a revert that differs from the merge base by one byte is refused (byte for byte, through git)", async () => {
    const d = mkdtempSync(join(tmpdir(), "cutgit2-"));
    const g = (...a: string[]) => { const r = spawnSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    const commit = (content: string, msg: string) => { writeFileSync(join(d, "app.ts"), content); g("add", "."); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
    g("init", "-q", "-b", "main");
    commit("export function run() {\n  return 1;\n}\n", "main");
    g("checkout", "-q", "-b", "pr");
    const reviewed = commit("export function run() {\n  return retry(1);\n}\n", "the change");
    const near = commit("export function run() {\n  return 1; \n}\n", "a revert, one byte off");
    g("update-ref", "refs/pull/40/head", near);
    const derive = gitCutDiff({ repo: join(mkdtempSync(join(tmpdir(), "cutbare2-")), "cut.git"), remote: d });
    const got = await derive({ pr: PRN(40), base: reviewed, head: near });
    expect(got.ok && got.judged.ok).toBe(false);
    const exact = commit("export function run() {\n  return 1;\n}\n", "the exact revert");
    g("update-ref", "refs/pull/40/head", exact);
    const ok = await derive({ pr: PRN(40), base: reviewed, head: exact });
    expect(ok.ok && ok.judged.ok).toBe(true);
    // And it reads the cut's commits and the cut head's files for the runner's own checks.
    if (ok.ok) { expect(ok.commits!.map((c) => c.sha)).toEqual([exact, near]); expect(ok.headFiles).toEqual({ "app.ts": 3 }); expect(ok.context).toContain(" export function run() {"); }
  });
  test("a judge whose model co-authored a cut commit is not chosen; with every judge refused the cut could not be checked", async () => {
    const gpt = { ...BUILD_COMMIT, message: "the cut\n\nCo-Authored-By: GPT-5.5 Codex <codex@openai.com>\n" };
    const t = await atCap({ cutDiff: okDiff({ commits: [BUILD_COMMIT, gpt] }) });
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.checks().map((c) => c.seat)).toEqual(["gemini"]);
    expect(t.rounds().changes["pr-40"].cut).toMatchObject({ seat: "gemini", state: "pass" });
    const both = await atCap({ cutDiff: okDiff({ commits: [gpt, { ...BUILD_COMMIT, message: "x\n\nCo-Authored-By: Gemini 3 <gemini@google.com>\n" }] }) });
    both.calls.length = 0;
    both.runner.admitAndQueue(cutBrief());
    await both.runner.tick();
    expect(both.checks()).toHaveLength(0);
    expect(both.lines.map((l) => l.outcome)).toEqual(["cap", "unchecked"]);
  });
});

describe("5: the purpose is frozen after round 1, and not written by the party being checked", () => {
  const BODY = "## What changed\n\nRetries keep each calendar change exactly once. A failed write is retried from the ledger, never from the message.\n\nMore.\n\n## How it was tested\n\nx";
  test("round 1 freezes the record: the description's opening and each outside seat's own statement", async () => {
    const t = rules({ openai: strict, prBody: async () => ({ ok: true, body: BODY }) });
    await t.round("f-1");
    const p = t.rounds().changes["pr-40"].purpose!;
    expect(p.frozen).toBeTruthy();
    expect(p.source).toBe("round 1");
    expect(p.what_changed).toBe("Retries keep each calendar change exactly once. A failed write is retried from the ledger, never from the message.");
    expect(p.statements!.map((s) => s.seat)).toEqual(["OpenAI", "Gemini"]);
    // The statement isn't a finding.
    expect(t.get("f-1").seats.find((s) => s.seat === "openai")!.findings!.map((f) => f.problem)).toEqual(["a crash between two writes loses the record"]);
    // Later rounds never change it.
    await t.round("f-2");
    expect(t.rounds().changes["pr-40"].purpose).toEqual(p);
    expect(whatChangedOpening("no section")).toBeNull();
  });
  test("a cut that deletes an essential path and its tests while the topic still reads satisfied fails", async () => {
    // The judge approves and says each behaviour is still done, but its evidence points at a file the cut deleted.
    const t = await atCap({ gemini: async (i) => i.brief.check ? cutPass(i, "cain/retry.ts") : said("approve"),
      openai: async (i) => i.brief.check ? cutPass(i, "cain/retry.ts") : strict(i) });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.checks()).toHaveLength(1);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(t.lines.filter((l) => l.outcome === "cut-fail")).toHaveLength(1);
  });
  test("a missing purpose record fails the cut, with no seat asked", async () => {
    const t = await atCap();
    const r = t.rounds();
    delete r.changes["pr-40"].purpose;
    writeRounds(t.cfg.roundsFile!, r);
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    expect(t.checks()).toHaveLength(0);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("fail");
    expect(t.relays().join("\n")).toContain("has no purpose record");
  });
  test("a change past round 1 when records began: built from the description only, and it says so", async () => {
    const t = await atCap({ prBody: async () => ({ ok: true, body: BODY }) });
    const r = t.rounds();
    r.changes["pr-40"].purpose = { topic: "Calendar retries", question: "Do retries keep each change exactly once?" };
    writeRounds(t.cfg.roundsFile!, r);
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    const p = t.rounds().changes["pr-40"].purpose!;
    expect(p).toMatchObject({ source: "description only", statements: [] });
    expect(t.checks()[0].input.brief.purpose).toContain("built from the pull request's description only");
    expect(t.checks()[0].input.brief.essentials).toHaveLength(2);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("pass");
  });
});

describe("6: every non-terminal capped state has a deadline, and a hold is final", () => {
  test("a cut decided with no check: one reminder after an hour, then one owner line after a day", async () => {
    const t = await atCap();
    t.decide({ change: "pr-40", choice: "cut" });
    await t.runner.tick();
    const reminders = () => t.relays().filter((l) => l.includes("has no cut check yet"));
    t.later(61 * MIN); await t.runner.tick(); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    t.later(DAY); await t.runner.tick(); await t.runner.tick();
    t.later(DAY); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "unchecked"]);
  });
  test("a cut check in transport retry: one reminder after an hour, then one owner line after a day", async () => {
    const t = await atCap({ openai: async (i) => { if (!i.brief.check) return strict(i); throw new SeatError("timeout", "no answer"); } });
    t.runner.admitAndQueue(cutBrief());
    await t.runner.tick();
    t.later(61 * MIN); await t.runner.tick();
    expect(t.relays().filter((l) => l.includes("has no result an hour on"))).toHaveLength(1);
    t.later(DAY); await t.runner.tick(); await t.runner.tick();
    t.later(DAY); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "unchecked"]);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("lost");
  });
  test("a hold, then a cut: refused", async () => {
    const t = await atCap();
    t.decide({ change: "pr-40", choice: "hold", why: "the retry is the piece" });
    await t.runner.tick();
    t.decide({ change: "pr-40", choice: "cut" });
    await t.runner.tick();
    expect(t.relays().join("\n")).toContain("is decided already (hold)");
    expect(t.runner.admitAndQueue(cutBrief())).toContain("is held");
    // The runner's own hold is final too: no decision, no cut check after it.
    const u = await atCap();
    const held = u.rounds();
    u.runner.holdUnchecked(held, "pr-40", "no seat answered");
    writeRounds(u.cfg.roundsFile!, held);
    expect(u.runner.admitAndQueue(cutBrief())).toContain("a hold is final");
    u.decide({ change: "pr-40", choice: "cut" });
    await u.runner.tick();
    expect(u.relays().join("\n")).toContain("a hold is final: no later decision is kept");
    expect(u.lines.filter((l) => l.outcome === "unchecked")).toHaveLength(1);
  });
  test("a fetch that fails at the runner's start is named in review.sh health", async () => {
    const t = rules({ verifyFetch: () => ({ ok: false, detail: "git can't fetch https://github.com/HyndeSyte/harness.git without a token (fatal: could not read Username)" }) });
    await t.runner.start();
    const ROOT = join(import.meta.dir, "..");
    const h = spawnSync("bun", [join(ROOT, "rootfs/opt/cain/review/cli.ts"), "health"], { encoding: "utf8",
      env: { ...process.env, CAIN_TEST_MODE: "1", REVIEW_HEALTH: t.cfg.healthFile, REVIEW_SETTINGS: t.cfg.settingsFile! } });
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("Cut diff fetch: FAILING: git can't fetch");
    expect(h.stdout).toContain("set review_github_token");
    // The real check, against a remote that isn't there, fails by name and never prints a token.
    const v = verifyFetch({ remote: join(t.dir, "no-such-repo"), token: "ghp_notarealtokenvalue000", timeoutMs: 10_000 });
    expect(v.ok).toBe(false);
    expect(v.detail).not.toContain("ghp_notarealtokenvalue000");
  });
});

describe("and: the hold's why, owed lines at start, the whole message", () => {
  test("a hold whose why asks him anything is refused with the gate's reason", async () => {
    for (const why of ["let me know if you want it kept", "want me to keep going with it", "Should I cut it?"])
      expect(checkDecision({ change: "pr-40", choice: "hold", why })).toContain("The message gate held this:");
    const t = await atCap();
    t.decide({ change: "pr-40", choice: "hold", why: "let me know if you want it kept" });
    await t.runner.tick();
    expect(t.relays().join("\n")).toContain("The message gate held this:");
    expect(t.rounds().changes["pr-40"].decided).toBeUndefined();
  });
  test("a line owed when the runner stopped before the link confirmed it still goes out at the next start", async () => {
    const tried: any[] = [];
    const t = await atCap({ postLine: async (l: any) => { tried.push(l); throw new Error("the runner stopped"); } });
    expect(t.rounds().changes["pr-40"].lines?.cap?.state).toBe("owed");
    // A new runner on the same files, as after a restart.
    const lines: any[] = [];
    const again = new Runner(t.cfg, { seats: {}, now: () => NOW, log: () => {}, verifyFetch: () => ({ ok: true, detail: "t" }),
      postLine: async (l) => { lines.push(l); return "m-1"; } });
    await again.start();
    expect(tried.map((l) => l.outcome)).toContain("cap");
    expect(lines.map((l) => l.outcome)).toEqual(["cap"]);
    expect(readRounds(t.cfg.roundsFile!)!.changes["pr-40"].lines?.cap).toMatchObject({ state: "sent", message: "m-1" });
  });
  test("the free-text gate checks the whole message: a two-sentence question and a paraphrase are held", () => {
    const send = (text: string) => decideSend({ tool: "reply", text }, null, {});
    for (const text of ["The calendar fix has one serious finding left. Should I cut it or hold it?",
      "The review left something serious. Want me to keep going with it?", "want me to keep going with it?"]) {
      const d = send(text);
      expect(d.would).toBe("refuse");
      expect(d.said.startsWith(HELD)).toBe(true);
    }
    expect(send("The calendar fix, held: the retry is the feature, so a cut would leave nothing.").would).toBe("pass");
    expect(send("Should the dentist move to Thursday?").would).toBe("pass");
  });
});
