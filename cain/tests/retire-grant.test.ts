// Cain 0.20.0: the owner's review rule (R-013 in his record). Three review rounds a piece, never more; no
// card offers more rounds or a ship with a risk named. After round 3: nothing serious left gives the normal
// Ship card; something serious left, Cain holds the piece or cuts what the serious findings are about, and one
// outside model that did not write the cut checks the cut diff (a cut check, not a round, never a second).
// The grant of extra rounds and the review service's decision card are retired (review/runner.ts,
// review/rounds.ts, review/core.ts, link/cap.ts, link/core.ts, keeper.sh).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_CHECK, cutLine, parseBrief, prompt, relayLine, seriousLeft, verdictsMd, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { configFromEnv } from "../rootfs/opt/cain/review/config.ts";
import { readRounds } from "../rootfs/opt/cain/review/rounds.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { asksAboutCap, capStateFor } from "../rootfs/opt/cain/link/cap.ts";
import { GRANT_RETIRED, RETIRED_TAP } from "../rootfs/opt/cain/link/core.ts";
import { linkRoutes } from "../rootfs/opt/cain/link/http.ts";
import { parseReviewed } from "../rootfs/opt/cain/reviewed.ts";
import { reviewedHits } from "../rootfs/opt/cain/gate/cain.ts";
import { keeperHolds, NOV11_8AM, MIN, PR, rig, SHA1, SHA2 } from "./link-rig";

const ROOT = join(import.meta.dir, "..");
const NOW = new Date("2026-11-26T15:00:00Z");
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-26-rule-a", topic: "The review rule in code", question: "Is this sound?", body: "Keep the rule in the runner.",
  needs_facts: false, consequential: false, pr: PRN(40), label: "core", ...over,
});
const cutBrief = (over: Partial<Brief> = {}): Brief => brief({ id: "2026-11-26-cut", kind: CUT_CHECK, head: SHA2,
  body: "The cut diff: it removes the new retry loop the serious finding was about, and nothing else.", ...over });
type Answer = (i: SeatInput) => Promise<SeatAnswer>;
const said = (verdict: SeatAnswer["verdict"], ...problems: string[]): SeatAnswer =>
  ({ verdict, findings: problems.map((p, i) => ({ rank: i + 1, problem: p, fix: "fix it" })), model: "m", cost_usd: 0.01 });

// Two outside seats (OpenAI and Gemini) and Claude, each with its own answers, by call kind.
function rules(o: { openai?: Answer; gemini?: Answer; claude?: Answer; noOpenai?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rule-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"),
    reviewedFile: join(dir, "reviewed.json"), roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const calls: { seat: string; input: SeatInput }[] = [];
  const of = (seat: string, a: Answer | undefined): SeatFn => async (i) => { calls.push({ seat, input: i }); return (a ?? (async () => said("approve")))(i); };
  const seats: RunnerConfig extends never ? never : any = { gemini: of("gemini", o.gemini), claude: of("claude", o.claude) };
  if (!o.noOpenai) seats.openai = of("openai", o.openai);
  let clock = NOW;
  const runner = new Runner(cfg, { seats, now: () => clock, rand: () => 0.5, log: () => {}, plan: () => ({ fraction: 0.1, at: NOW.toISOString(), reason: "t", tokens_week: 1, files: 1 }) });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  const round = async (id: string, over: Partial<Brief> = {}) => {
    const why = runner.admitAndQueue(brief({ id, seats: ["openai", "gemini"], ...over }));
    if (why) throw new Error(why);
    await runner.tick();
    return loadReview(cfg.queueDir, id)!;
  };
  return { dir, cfg, runner, calls, relays, round, later: (ms: number) => { clock = new Date(clock.getTime() + ms); }, rounds: () => readRounds(cfg.roundsFile!)!, get: (id: string) => loadReview(cfg.queueDir, id)! };
}
// A round's seats: serious from OpenAI unless the answer says otherwise.
const serious = (text = "SERIOUS (loses or corrupts): a crash between two writes loses the record") => async (i: SeatInput) =>
  i.brief.sort ? said("approve") : said("approve_with_changes", text);
const clean = async (i: SeatInput) => said("approve");

describe("1: the grant of extra rounds is retired", () => {
  test("the cap check reads no grants file: a grant left on disk raises nothing, and round 4 is refused", async () => {
    const t = rules();
    // A grants file from 0.18.0 beside the rounds file, granting this change three more rounds.
    writeFileSync(join(t.dir, "review-grants.json"), JSON.stringify({ format: 1, grants: [{ id: "pr-40+1", key: "pr-40", rounds: 3, by: "owner", at: NOW.toISOString(), message: "1", reason: "x", item: null, pr: PRN(40) }] }));
    for (const id of ["g-1", "g-2", "g-3"]) await t.round(id);
    const why = t.runner.admitAndQueue(brief({ id: "g-4", seats: ["openai", "gemini"] }))!;
    expect(why).toContain("the owner's rule allows at most 3, never more");
    expect(why).not.toContain("grant");
    expect(why).not.toContain("review-grant");
    expect(loadReview(t.cfg.queueDir, "g-4")).toBeNull();
    // No grants anywhere in the runner's config or code.
    expect(Object.keys(configFromEnv({}))).not.toContain("grantsFile");
    for (const f of ["review/runner.ts", "review/rounds.ts", "review/cli.ts", "review/config.ts", "link/cap.ts"])
      expect(readFileSync(join(ROOT, "rootfs/opt/cain", f), "utf8")).not.toMatch(/readGrants|grantsFor|effectiveCap|grantsFile/);
    expect(existsSync(join(ROOT, "rootfs/opt/cain/review/grants.ts"))).toBe(false);
  });

  test("a capped change gets no grant path: its done line names none, and the link's route refuses", async () => {
    const t = rules({ openai: serious() });
    for (const id of ["p-1", "p-2", "p-3"]) await t.round(id);
    const all = t.relays().join("\n");
    expect(all).not.toMatch(/grant/i);
    expect(all).not.toContain("decision in front of Dane");
    const r = rig({ holds: keeperHolds({}) });
    const routes = linkRoutes({ link: r.link, toHarness: async () => true });
    const raw = JSON.stringify({ item: "P46", change: PRN(40), rounds: 2, text: "More fixing" });
    const res = await routes(new Request("http://link/review-grant", { method: "POST", body: raw }), new URL("http://link/review-grant"), "cain", raw);
    expect(res.status).toBe(400);
    expect((await res.json()).said).toContain("retired by the owner's review rule");
    const dec = await routes(new Request("http://link/decision", { method: "POST", body: "{}" }), new URL("http://link/decision"), "root", "{}");
    expect((await dec.json()).said).toContain("nothing goes to him from the service");
    expect(r.posts()).toBe(0);
    expect(GRANT_RETIRED).toContain("cut-check");
  });

  test("keeper.sh review-grant prints a refusal naming the retirement, and asks the link nothing", () => {
    const run = spawnSync("bash", [join(ROOT, "rootfs/opt/cain/keeper.sh"), "review-grant", "--item", "P46", "--change", PRN(40), "--rounds", "2", "why"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
    expect(run.status).toBe(2);
    const j = JSON.parse(run.stdout);
    expect(j.status).toBe("refused");
    expect(j.said).toContain("keeper.sh review-grant is retired by the owner's review rule");
    expect(j.said).toContain("never more");
    const sh = readFileSync(join(ROOT, "rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).not.toContain('"/review-grant"');
    expect(sh).not.toMatch(/connector\|review-grant/);
  });

  test("lock.sh removes the grants file, so grants already given lapse", () => {
    const lock = readFileSync(join(ROOT, "rootfs/opt/cain/c1/lock.sh"), "utf8");
    expect(lock).toContain('rm -f "$D/review-grants.json"');
    expect(lock).not.toContain("printf '{\"format\": 1, \"grants\": []}");
  });

  test("an open grant or decision card is expired at the sweep, and a tap on an old one is refused plainly", async () => {
    const r = rig({ holds: keeperHolds({}) });
    // Two cards as 0.18.0 and 0.16.0 left them: a grant card and a decision card, still up.
    const grant = (await r.link.ask({ text: "Is the calendar fix ready?", options: ["Yes", "No"], item: "P46", question: "Q1" }) as any).message as string;
    let s = r.state();
    s.messages[grant].grant = { key: "pr-40", rounds: 2, pr: PRN(40), reason: "x", used: 3, cap: 3, head: SHA1, decision: null };
    r.setState(s);
    const decision = (await r.link.ask({ text: "The calendar fix: hold it?", options: ["Hold", "Go"], item: "P47", question: "Q1" }) as any).message as string;
    s = r.state();
    s.messages[decision].decision = { id: "pr-41#3", key: "pr-41", pr: PRN(41) };
    s.decisions = { "pr-42#3": { since: 1 } };
    r.setState(s);
    // A tap before the sweep: refused with the plain line, its buttons off, nothing relayed as his answer.
    const before = r.relayed.length;
    expect(await r.tap(r.msg(grant), r.ids(grant)[0])).toBe("dead: retired");
    expect(r.ephemerals().map((e: any) => e.content)).toContain(RETIRED_TAP);
    expect(r.relayed.length).toBe(before);
    expect(r.state().messages[grant].q?.used).toBe(true);
    // The sweep takes the other card's buttons off with a plain "Expired" line, and drops the waiting decisions.
    await r.link.sweep();
    const st = r.state();
    expect(st.messages[decision]).toMatchObject({ outcome: "expired", why: "retired", buttons: false });
    expect(String(r.msg(decision).content)).toContain("Expired");
    expect(r.msg(decision).components ?? []).toEqual([]);
    expect(st.decisions).toBeUndefined();
    // A tap on it afterwards: the same plain line, nothing decided.
    expect(await r.tap({ ...r.msg(decision), components: [{ type: 1, components: [{ type: 2, custom_id: "q:x:0", label: "Hold" }] }] }, "q:x:0")).toBe("dead: retired");
    expect(r.relayed.slice(before).some((l) => l.includes("Dane tapped"))).toBe(false);
  });
});

describe("2: no decision card at the cap; the done line says at its cap and the serious count", () => {
  test("round 3 with something serious left relays the count and the rule, and posts nothing to him", async () => {
    const t = rules({ openai: serious() });
    for (const id of ["d-1", "d-2", "d-3"]) await t.round(id);
    const last = t.relays().filter((l) => l.includes("Review d-3 done")).pop()!;
    expect(last).toContain("Round 3 of 3 for pr-40 (fix-only): 1 serious finding left, at its cap.");
    expect(last).toContain("By the owner's rule you decide");
    expect(last).toContain("Tell him one line; ask him nothing about rounds, risk or cuts.");
    expect(t.rounds().changes["pr-40"].rounds[2]).toMatchObject({ state: "answered", serious: 1 });
    expect((t.rounds().changes["pr-40"] as any).decision).toBeUndefined();
    expect((t.runner.deps as any).postDecision).toBeUndefined();
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/review/main.ts"), "utf8")).not.toContain("/decision");
  });

  test("round 3 with nothing serious left says so: the normal Ship card", async () => {
    const t = rules({ openai: async (i) => said("approve_with_changes", "FOLLOW-UP (fails silently): a log line could be clearer") });
    for (const id of ["n-1", "n-2", "n-3"]) await t.round(id);
    const last = t.relays().filter((l) => l.includes("Review n-3 done")).pop()!;
    expect(last).toContain("0 serious findings left, at its cap.");
    expect(last).toContain("Nothing serious is left at its cap: show the normal Ship card.");
  });

  test("Cain's ask can't put a question about rounds, risk or cuts to him", async () => {
    const r = rig({ holds: keeperHolds({}) });
    for (const [text, opts] of [
      ["Want more review rounds for the calendar fix?", ["Yes", "No"]],
      ["Ship the calendar fix with that risk?", ["Ship", "Hold"]],
      ["Should I cut the parts the serious finding is about?", ["Cut", "Hold"]],
      ["The calendar fix has a serious finding left: ship or hold?", ["Ship", "Hold"]],
      ["Is it OK to run a cut check?", ["Yes", "No"]],
      ["Grant two more rounds?", ["Yes", "No"]],
    ] as [string, string[]][]) await expect(r.link.ask({ text, options: opts, item: "P46", question: "Q1" })).rejects.toThrow("never ask him about rounds, risk or cuts");
    await expect(r.link.ask({ text: "Ready?", options: ["Ship it with that risk", "No"], item: "P46", question: "Q1" })).rejects.toThrow("there is no shipping with a risk named");
    // Ordinary asks still go.
    for (const text of ["Is the business-license packet filed?", "Want me to cut the grass list down to three?", "Should the dentist move to Thursday?"])
      expect(asksAboutCap(text)).toBeNull();
    expect(((await r.link.ask({ text: "Is the business-license packet filed?", options: ["Filed", "Not filed"], item: "P46", question: "Q1" })) as any).status).toBe("posted");
  });
});

describe("3: the cut check", () => {
  async function atCap(o: Parameters<typeof rules>[0] = {}) {
    const t = rules({ openai: serious(), ...o });
    for (const id of ["c-1", "c-2", "c-3"]) await t.round(id);
    return t;
  }

  test("the brief: kind cut-check, its pull request and the cut head; not a round's fields", () => {
    expect(parseBrief(JSON.stringify(cutBrief())).brief).toMatchObject({ kind: "cut-check", head: SHA2 });
    expect(parseBrief(JSON.stringify({ ...cutBrief(), head: undefined })).error).toContain("names the change's pull request (pr) and the cut head");
    expect(parseBrief(JSON.stringify({ ...cutBrief(), round_kind: "fixes" })).error).toContain("a cut check isn't a round");
    expect(parseBrief(JSON.stringify({ ...cutBrief(), seats: ["claude"] })).error).toContain("exactly one outside seat that did not write the cut");
    expect(parseBrief(JSON.stringify({ ...cutBrief(), seats: ["openai", "gemini"] })).error).toContain("exactly one outside seat");
    expect(parseBrief(JSON.stringify({ ...cutBrief(), kind: "other" })).error).toContain("kind must be cut-check");
  });

  test("refused on a change not at its cap, and on one whose last round left nothing serious", async () => {
    const t = rules({ openai: serious() });
    await t.round("e-1"); await t.round("e-2");
    expect(t.runner.admitAndQueue(cutBrief())).toContain("isn't at its cap (2 of 3 rounds)");
    const u = rules();
    for (const id of ["f-1", "f-2", "f-3"]) await u.round(id);
    expect(u.runner.admitAndQueue(cutBrief())).toContain("left nothing serious, so there is nothing to cut: show the normal Ship card");
  });

  test("one outside seat, never the Claude stand-in; it gets the three questions and the serious findings; not counted as a round", async () => {
    const t = await atCap();
    t.calls.length = 0;
    expect(t.runner.admitAndQueue(cutBrief({ seats: ["gemini"] }))).toBeNull();
    await t.runner.tick();
    expect(t.calls.map((c) => c.seat)).toEqual(["gemini"]);
    const sent = t.calls[0].input.brief;
    expect(sent.check).toBe("cut");
    expect(sent.earlier).toEqual(["[serious: loses or corrupts] a crash between two writes loses the record"]);
    const p = prompt(sent, "reviewer");
    expect(p.system).toContain("1. Does it remove each serious risk listed inside <earlier>? 2. Does it add a serious risk of its own? 3. Does what is left pass its tests?");
    expect(p.user).toContain("The cut diff: it removes the new retry loop");
    // Not a round: the count stays 3, and the cut is kept on its own.
    expect(t.rounds().changes["pr-40"].rounds.length).toBe(3);
    expect(t.rounds().changes["pr-40"].cut).toMatchObject({ id: "2026-11-26-cut", head: SHA2, seat: "gemini", state: "pass" });
  });

  test("its seat down: no Claude stands in, and the check has no answer, so the piece is held", async () => {
    const t = await atCap({ gemini: async (i) => { if (i.brief.check) throw new Error("down"); return said("approve"); } });
    t.calls.length = 0;
    t.runner.admitAndQueue(cutBrief({ seats: ["gemini"] }));
    for (let i = 0; i < 6; i++) { t.later(3_600_000); await t.runner.tick(); }
    expect(t.calls.every((c) => c.seat === "gemini")).toBe(true);
    const r = t.get("2026-11-26-cut");
    expect(r.seats.map((s) => s.seat)).toEqual(["gemini"]);
    expect(t.rounds().changes["pr-40"].cut!.state).toBe("lost");
    expect(capStateFor(PRN(40), t.rounds(), 3)).toMatchObject({ state: "held" });
  });

  test("pass: filed under reviews/ like a round, with its line; a second cut check is refused", async () => {
    const t = await atCap();
    t.runner.admitAndQueue(cutBrief({ seats: ["gemini"] }));
    await t.runner.tick();
    const r = t.get("2026-11-26-cut");
    expect(cutLine(r)).toBe("Cut checked: Gemini, pass.");
    expect(r.record_dir).toBe("reviews/2026-11-26-cut");
    expect(verdictsMd(r)).toContain("Cut check of pr-40 at its cap (not a round): pass.");
    const relay = t.relays().filter((l) => l.includes("Cut check 2026-11-26-cut")).pop()!;
    expect(relay).toContain("(not a round): pass");
    expect(relay).toContain("--review 2026-11-26-cut");
    expect(relay).toContain("Say it as: Cut checked: Gemini, pass.");
    const pub = parseReviewed(readFileSync(t.cfg.reviewedFile!, "utf8"))!;
    expect(pub.find((x) => x.id === "2026-11-26-cut")).toMatchObject({ line: "Cut checked: Gemini, pass.", head: SHA2, pr: PRN(40) });
    expect(t.runner.admitAndQueue(cutBrief({ id: "2026-11-26-cut-2" }))).toContain("already had its one cut check");
    expect(capStateFor(PRN(40), t.rounds(), 3)).toEqual({ state: "cut", key: "pr-40", id: "2026-11-26-cut", head: SHA2, seat: "gemini" });
  });

  test("fail: an unmarked reason or a reject fails it, and the piece is held", async () => {
    const t = await atCap({ gemini: async (i) => i.brief.check ? said("approve", "It still retries without a bound.") : said("approve") });
    t.runner.admitAndQueue(cutBrief({ seats: ["gemini"] }));
    await t.runner.tick();
    expect(cutLine(t.get("2026-11-26-cut"))).toBe("Cut checked: Gemini, fail.");
    expect(t.relays().pop()).toContain("is held by the owner's rule: no second cut and no second check");
    expect(capStateFor(PRN(40), t.rounds(), 3)).toMatchObject({ state: "held", why: expect.stringContaining("its one cut check failed") });
  });
});

describe("4: sorting by the rule's test", () => {
  test("every seat's prompt carries the test and asks for a label naming the arm", () => {
    const p = prompt({ topic: "t", question: "q", body: "b", needs_facts: false, consequential: false }, "reviewer").system;
    for (const arm of ["(loses or corrupts)", "(acts wrongly)", "(exposes or widens)", "(fails silently)"]) expect(p).toContain(arm);
    expect(p).toContain('"SERIOUS (<arm>):" naming the arm it meets, or "FOLLOW-UP (<arm>):" naming the arm it comes nearest to and fails');
  });

  test("the count: serious by any seat, less those another outside seat labelled follow-up in writing; verdicts.md shows both", async () => {
    const t = rules({
      openai: async (i) => i.brief.sort ? said("approve") : said("approve_with_changes", "SERIOUS (fails silently): the retry gives up without a word", "SERIOUS (acts wrongly): it posts twice"),
      gemini: async (i) => i.brief.sort
        ? said("approve", "FOLLOW-UP (fails silently) [1]: it logs and alarms when it gives up, so someone hears", "SERIOUS (acts wrongly) [2]: agreed, it posts twice")
        : said("approve"),
    });
    for (const id of ["s-1", "s-2", "s-3"]) await t.round(id);
    const r = t.get("s-3");
    expect(r.sorts?.length).toBe(2);
    expect(seriousLeft(r).map((f) => f.problem)).toEqual(["it posts twice"]);
    expect(t.rounds().changes["pr-40"].rounds[2].serious).toBe(1);
    const md = verdictsMd(r);
    expect(md).toContain("1. [serious: fails silently] the retry gives up without a word");
    expect(md).toContain("Gemini labelled it follow-up (fails silently): it logs and alarms when it gives up, so someone hears So it doesn't count as serious.");
    expect(md).toContain("Gemini labelled it serious (acts wrongly): agreed, it posts twice");
    expect(relayLine(r)).toContain("1 serious finding left, at its cap.");
  });

  test("Claude's follow-up label, the raising seat's own, or one with no reason doesn't take a finding off", () => {
    const seat = (key: string, seat: any, counts = true, extra: any = {}) => ({ key, seat, role: "reviewer", state: "done", provider: "", family: "", counts, attempts: 1, cost_usd: 0, verdict: "approve", findings: [], ...extra });
    const f = { rank: 1, problem: "loses the record", fix: "x", severity: "serious" as const };
    const base: any = { round_kind: "fixes", seats: [seat("openai", "openai", true, { findings: [f] }), seat("gemini", "gemini"), seat("claude", "claude", false),
      seat("claude-for-gemini", "claude", false, { stands_in_for: "gemini" })] };
    const left = (sorts: any[]) => seriousLeft({ ...base, sorts }).length;
    expect(left([{ by: "claude", ref: "openai#0", label: "follow-up", reason: "fine" }])).toBe(1);
    expect(left([{ by: "claude-for-gemini", ref: "openai#0", label: "follow-up", reason: "fine" }])).toBe(1);
    expect(left([{ by: "openai", ref: "openai#0", label: "follow-up", reason: "fine" }])).toBe(1);
    expect(left([{ by: "gemini", ref: "openai#0", label: "follow-up", reason: " " }])).toBe(1);
    expect(left([{ by: "gemini", ref: "openai#0", label: "follow-up", reason: "it fails safe and is heard" }])).toBe(0);
  });

  test("an unlabelled finding counts as serious in every round, a full one too", async () => {
    const t = rules({ openai: async () => said("approve_with_changes", "no label at all") });
    const r = await t.round("u-1");
    expect(r.seats.find((s) => s.seat === "openai")!.findings![0].severity).toBe("serious");
  });
});

describe("5: the Ship card for a capped change", () => {
  const FACTS = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "x", bumps: [{ app: "Cain", version: "0.20.0" }], merged: false };
  function shipRig(rounds: any, reviews: any[] = []) {
    const r = rig({ facts: true });
    r.github.facts = { ...FACTS };
    r.reviews.list = reviews;
    Object.assign((r.link as any).d, { capState: (pr: string) => capStateFor(pr, rounds, 3) });
    return r;
  }
  const at = new Date(NOV11_8AM - 10 * MIN).toISOString();
  const roundsWith = (serious: number, cut?: any) => ({ format: 1, changes: { "pr-5": { pr: PR, rounds: [1, 2, 3].map((n) => ({ id: `r-${n}`, at: `2026-11-1${n}`, kind: n === 1 ? "full" : "fixes", state: "answered", done: true, serious: n === 3 ? serious : 0 })), ...(cut ? { cut } : {}) } } });
  const ship = (r: any, head: string, review?: string) => r.link.ship({ text: "Cards keep their place.", item: "P64", pr: PR, head, review });

  test("nothing serious left at the cap: the normal card", async () => {
    const r = shipRig(roundsWith(0), [{ id: "r-3", line: "Reviewed: OpenAI, approve; Gemini, approve.", finished_at: at, pr: PR, head: SHA1 }]);
    expect((await ship(r, SHA1, "r-3")).status).toBe("posted");
  });

  test("something serious left and no passing cut check: held by the rule, said plainly", async () => {
    await expect(ship(shipRig(roundsWith(1)), SHA1)).rejects.toThrow("the piece is held by the owner's review rule: its last review round left something serious, and it has no passing cut check");
    await expect(ship(shipRig(roundsWith(1, { id: "cut-1", at, head: SHA1, pr: PR, seat: "gemini", state: "fail" })), SHA1, "cut-1")).rejects.toThrow("held by the owner's review rule");
    await expect(ship(shipRig(roundsWith(1, { id: "cut-1", at, head: SHA1, pr: PR, seat: "gemini", state: "started" })), SHA1, "cut-1")).rejects.toThrow("its cut check is still running");
  });

  test("a passing cut check: only its cut head, only naming it, and the review line reads Cut checked", async () => {
    const cut = { id: "cut-1", at, head: SHA1, pr: PR, seat: "gemini", state: "pass" };
    const line = { id: "cut-1", line: "Cut checked: Gemini, pass.", finished_at: at, pr: PR, head: SHA1 };
    const r = shipRig(roundsWith(1, cut), [line, { id: "r-3", line: "Reviewed: OpenAI, approve.", finished_at: at, pr: PR, head: SHA1 }]);
    await expect(ship(r, SHA1, "r-3")).rejects.toThrow("only its passing cut check can be its review: name it with --review cut-1");
    await expect(ship(r, SHA1)).rejects.toThrow("--review cut-1");
    const r2 = shipRig(roundsWith(1, { ...cut, head: SHA2 }), [line]);
    await expect(ship(r2, SHA1, "cut-1")).rejects.toThrow("its cut check passed for another head, and only that cut head ships");
    const ok = await ship(r, SHA1, "cut-1");
    expect(ok.status).toBe("posted");
    expect(String(r.msg(ok.message).content)).toContain("Cut checked: Gemini, pass.");
  });

  test("a cut check's line can't go on another card, or when it failed", async () => {
    const r = shipRig({ format: 1, changes: {} }, [{ id: "cut-9", line: "Cut checked: Gemini, pass.", finished_at: at, pr: PR, head: SHA1 }]);
    await expect(ship(r, SHA1, "cut-9")).rejects.toThrow("isn't this change's cut check at its cap");
  });

  test("the ship-with-risk path and its armed reads are gone from the link", () => {
    const core = readFileSync(join(ROOT, "rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).not.toMatch(/armedFor|this\.d\.armed|heldForRollback|DECISION_OPTIONS|reviewGrant\(/);
  });
});

describe("6: the gate takes the cut check's line word for word", () => {
  test("the published line passes; a made-up one is refused", () => {
    const pub = [{ id: "cut-1", line: "Cut checked: Gemini, pass.", finished_at: NOW.toISOString(), pr: PR, head: SHA1 }];
    expect(reviewedHits("Done, the cut went in. Cut checked: Gemini, pass.", pub)).toEqual([]);
    expect(reviewedHits("Cut checked: OpenAI, pass.", pub).map((h) => h.result)).toEqual(["refuse"]);
    expect(parseReviewed(JSON.stringify({ reviews: [...pub, { id: "x", line: "Cut checked: anyone, fine.", finished_at: NOW.toISOString() }] }))!.map((x) => x.id)).toEqual(["cut-1"]);
  });
});
