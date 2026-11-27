// Cain 0.16.0: the review-round cap and the usage guard, run in code (review/rounds.ts, review/runner.ts,
// guard.ts, plan-usage.ts, link/cap.ts, hooks/remote-trigger.ts). The owner's rule: at most three outside
// review rounds a change, never a fourth (since 0.20.0 the rest of R-013 is in cap-rule-hold.test.ts). And
// "other" work never spends the reserve.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS as CORE_LABELS, earlierCheck, prompt, parseBrief, resultJson, roundLine, seriousLeft, validateAnswer, verdictsMd, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { admit, countedRounds, emptyRounds, readRounds } from "../rootfs/opt/cain/review/rounds.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { LABELS, decide as guardDecide, guard, guardLines, readings, seatsLeft } from "../rootfs/opt/cain/guard.ts";
import { readPlanUsage, type PlanReading } from "../rootfs/opt/cain/plan-usage.ts";
import { RISK, capStateFor, namesRoundPastCap } from "../rootfs/opt/cain/link/cap.ts";
import { ROOT_ROUTES, CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth.ts";
import { BUILD, decide as hookDecide } from "../rootfs/opt/cain/hooks/remote-trigger.ts";
import { keeperHolds, PR, rig, SHA1 } from "./link-rig";

const NOW = new Date("2026-11-21T15:00:00Z");
const TERMS = "# terms\nAcme Corp\n";
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-21-cap-a", topic: "The round cap in code", question: "Is this sound?", body: "Keep the cap in the runner.",
  needs_facts: false, consequential: false, seats: ["gemini"], pr: PRN(40), label: "core", ...over,
});
const fresh = (): PlanReading => ({ fraction: 0.1, at: NOW.toISOString(), reason: "test", tokens_week: 1, files: 1 });

function runnerRig(o: { seat?: (i: SeatInput) => Promise<SeatAnswer>; guard?: boolean; cap?: number; plan?: () => PlanReading } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"),
    roundsFile: join(dir, "rounds.json"), roundCap: o.cap ?? 3, settingsFile: join(dir, "settings.json"),
    ...(o.guard ? { guardLog: join(dir, "guard.log") } : {}) };
  writeFileSync(cfg.termsFile, TERMS);
  const calls: SeatInput[] = [];
  const seat: SeatFn = async (i) => { calls.push(i); return (o.seat ?? (async () => ({ verdict: "approve", findings: [], model: "m", cost_usd: 0.01 })))(i); };
  let clock = NOW;
  const runner = new Runner(cfg, { seats: { gemini: seat }, now: () => clock, rand: () => 0.5, log: () => {}, plan: o.plan ?? fresh });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  return { dir, cfg, runner, calls, relays, later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    rounds: () => readRounds(cfg.roundsFile!)!, get: (id: string) => loadReview(cfg.queueDir, id)! };
}
const finding = (problem: string) => ({ rank: 1, problem, fix: "fix it" });
const answerWith = (...problems: string[]) => async (): Promise<SeatAnswer> =>
  ({ verdict: problems.length ? "approve_with_changes" : "approve", findings: problems.map(finding), model: "m", cost_usd: 0.01 });

describe("A: the runner counts rounds per change and refuses past the cap", () => {
  test("three rounds go, the fourth is refused with the count and the rule, under a new id too", () => {
    const t = runnerRig();
    expect(t.runner.admitAndQueue(brief({ id: "cap-r1" }))).toBeNull();
    expect(t.runner.admitAndQueue(brief({ id: "cap-r2" }))).toBeNull();          // fixes by default now
    expect(t.runner.admitAndQueue(brief({ id: "cap-r3", round_kind: "fixes" }))).toBeNull();
    expect(t.get("cap-r2")).toMatchObject({ change: "pr-40", round: 2, cap: 3, round_kind: "fixes" });
    const why = t.runner.admitAndQueue(brief({ id: "cap-r4-new-id" }))!;
    expect(why).toContain("pr-40 has had 3 outside review rounds");
    expect(why).toContain("the owner's rule allows at most 3");
    expect(loadReview(t.cfg.queueDir, "cap-r4-new-id")).toBeNull();
    expect(countedRounds(t.rounds(), "pr-40").length).toBe(3);
  });

  test("a replacement pull request carries the count over, and so does going back to the old one", () => {
    const t = runnerRig();
    t.runner.admitAndQueue(brief({ id: "rep-1" }));
    t.runner.admitAndQueue(brief({ id: "rep-2" }));
    // The same scope moves to pull request 41: one round left between them.
    expect(t.runner.admitAndQueue(brief({ id: "rep-3", pr: PRN(41), supersedes: PRN(40) }))).toBeNull();
    expect(t.get("rep-3")).toMatchObject({ change: "pr-41", round: 3, round_kind: "fixes" });
    expect(t.runner.admitAndQueue(brief({ id: "rep-4", pr: PRN(41) }))).toContain("has had 3");
    expect(t.runner.admitAndQueue(brief({ id: "rep-5", pr: PRN(40) }))).toContain("has had 3");
    expect(t.runner.admitAndQueue(brief({ id: "rep-6", pr: PRN(42), supersedes: PRN(41) }))).toContain("has had 3");
  });

  test("a plan's change key counts the same way, and the count survives a restart", () => {
    const t = runnerRig();
    const plan = { pr: undefined, change: "garden-plan" };
    for (const id of ["gp-1", "gp-2", "gp-3"]) expect(t.runner.admitAndQueue(brief({ id, ...plan }))).toBeNull();
    const again = new Runner(t.cfg, { seats: {}, now: () => NOW, log: () => {} });
    expect(again.admitAndQueue(brief({ id: "gp-4", ...plan }))).toContain("garden-plan has had 3");
    expect(again.admitAndQueue(brief({ id: "gp-5", pr: undefined, change: "garden-plan-v2", supersedes: "garden-plan" }))).toContain("has had 3");
  });

  test("a brief names its change; a full second round and a fix-only first round are refused", () => {
    const t = runnerRig();
    expect(t.runner.admitAndQueue(brief({ id: "nc-1", pr: undefined }))).toContain("names the change it reviews");
    expect(t.runner.admitAndQueue(brief({ id: "nc-2", round_kind: "fixes" }))).toContain("nothing to check fixes against");
    t.runner.admitAndQueue(brief({ id: "nc-3" }));
    expect(t.runner.admitAndQueue(brief({ id: "nc-4", round_kind: "full" }))).toContain("fix-only round");
  });

  test("a round blocked for privacy sent nothing and doesn't count", async () => {
    const t = runnerRig();
    t.runner.admitAndQueue(brief({ id: "pv-1", body: "Plan for Acme Corp" }));
    await t.runner.tick();
    expect(t.get("pv-1").status).toBe("blocked: privacy");
    expect(countedRounds(t.rounds(), "pr-40").length).toBe(0);
    expect(admit(t.rounds(), brief({ id: "pv-2" }), 3)).toMatchObject({ ok: true, round: 1, kind: "full" });
  });

  // Cain 0.18.1, narrowed: over the earlier findings the email, phone and SSN-shaped patterns and the owner's
  // terms list all run; only the account-or-card pattern is relaxed, for a digit run glued to an identifier or
  // a valid year-month-day date. The brief still gets every built-in pattern and the list.
  test("earlierCheck lets a tool name ending in a date through", () => {
    expect(earlierCheck(["Claude: the web_search_20250305 tool is pinned"], TERMS)).toEqual({ ok: true });
    expect(earlierCheck(["Claude: pinned since 20250305, see the tool list"], TERMS)).toEqual({ ok: true });
    expect(earlierCheck(undefined, null)).toEqual({ ok: true });
  });
  test("earlierCheck still blocks a phone-shaped number in the earlier findings", () => {
    expect(earlierCheck(["Gemini: call 555-867-5309 about it"], TERMS)).toEqual({ ok: false, why: ["a phone number in the earlier findings"] });
  });
  test("earlierCheck still blocks an SSN-shaped number in the earlier findings", () => {
    expect(earlierCheck(["Gemini: the form shows 123-45-6789"], TERMS)).toEqual({ ok: false, why: ["an SSN-shaped number in the earlier findings"] });
  });
  test("earlierCheck still blocks an email address in the earlier findings", () => {
    expect(earlierCheck(["Gemini: mail someone@example.com"], TERMS)).toEqual({ ok: false, why: ["an email address in the earlier findings"] });
  });
  test("earlierCheck still blocks a bare eight-digit run, a run that isn't a date, and a spaced card number", () => {
    const acct = { ok: false, why: ["an account or card number in the earlier findings"] };
    expect(earlierCheck(["Gemini: the account is 12345678"], TERMS)).toEqual(acct);
    expect(earlierCheck(["Gemini: the number 20251345 is wrong"], TERMS)).toEqual(acct);      // month 13: not a date
    expect(earlierCheck(["Gemini: the number 20250230 is wrong"], TERMS)).toEqual(acct);      // Feb 30: not a date
    expect(earlierCheck(["Gemini: card 4111 1111 1111 1111"], TERMS)).toEqual(acct);
    expect(earlierCheck(["Gemini: web_search_20250305 and then 12345678"], TERMS)).toEqual(acct);  // one excused run doesn't excuse the next
    expect(earlierCheck(["Gemini: tool 12345678"], TERMS)).toEqual(acct);                      // a space before it: not glued
  });
  test("earlierCheck still blocks a private term, and fails closed without a list", () => {
    expect(earlierCheck(["Gemini: the plan names Acme Corp"], TERMS)).toEqual({ ok: false, why: ["private term on line 2 of the list, in the earlier findings"] });
    expect(earlierCheck(["Gemini: anything"], null)).toMatchObject({ ok: false });
  });

  test("a fix-only round whose earlier findings hold an eight-digit date-shaped string is admitted and sent", async () => {
    const t = runnerRig({ seat: answerWith("The web_search_20250305 tool name is pinned; move it to settings.") });
    t.runner.admitAndQueue(brief({ id: "dg-1" }));
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "dg-2", body: "Fix: the tool name is read from settings." }))).toBeNull();
    await t.runner.tick();
    const r = t.get("dg-2");
    expect(r.round_kind).toBe("fixes");
    expect(r.status).not.toBe("blocked: privacy");
    expect(t.calls.length).toBe(2);
    expect(t.calls[1].brief.earlier).toEqual(["Gemini [serious]: The web_search_20250305 tool name is pinned; move it to settings."]);
  });

  test("a fix-only round whose earlier findings hold a private term is still blocked, the line named, and doesn't count", async () => {
    const t = runnerRig({ seat: answerWith("The note mentions Acme Corp by name.") });
    t.runner.admitAndQueue(brief({ id: "et-1" }));
    await t.runner.tick();
    t.runner.admitAndQueue(brief({ id: "et-2", body: "Fix: the name is gone." }));
    await t.runner.tick();
    const r = t.get("et-2");
    expect(r.status).toBe("blocked: privacy");
    expect(r.blocked_why).toEqual(["private term on line 2 of the list, in the earlier findings"]);
    expect(t.calls.length).toBe(1);
    expect(countedRounds(t.rounds(), "pr-40").length).toBe(1);
  });

  test("a brief holding an eight-digit run is still blocked before anything is sent", async () => {
    const t = runnerRig();
    t.runner.admitAndQueue(brief({ id: "bd-1", body: "Pin the web_search_20250305 tool." }));
    await t.runner.tick();
    expect(t.get("bd-1").status).toBe("blocked: privacy");
    expect(JSON.stringify(t.get("bd-1"))).toContain("an account or card number");
    expect(t.calls.length).toBe(0);
  });

  test("a fix-only round whose earlier findings hold a bare eight-digit run is blocked and doesn't count", async () => {
    const t = runnerRig({ seat: answerWith("Reference 12345678 in the log.") });
    t.runner.admitAndQueue(brief({ id: "bn-1" }));
    await t.runner.tick();
    t.runner.admitAndQueue(brief({ id: "bn-2", body: "Fix: the reference is gone." }));
    await t.runner.tick();
    expect(t.get("bn-2").status).toBe("blocked: privacy");
    expect(t.get("bn-2").blocked_why).toEqual(["an account or card number in the earlier findings"]);
    expect(t.calls.length).toBe(1);
  });

  // Cain 0.18.1, second review: the glued-identifier excuse is narrowed to an eight-digit valid date.
  test("a fix-only round whose earlier findings glue a 16-digit Luhn-valid card number to a prefix is blocked, named", async () => {
    const t = runnerRig({ seat: answerWith("The log prints card_4111111111111111 in full.") });
    t.runner.admitAndQueue(brief({ id: "gl-1" }));
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "gl-2", body: "Fix: the log masks it." }))).toBeNull();
    await t.runner.tick();
    expect(t.get("gl-2").status).toBe("blocked: privacy");
    expect(t.get("gl-2").blocked_why).toEqual(["an account or card number in the earlier findings"]);
    expect(t.calls.length).toBe(1);
    expect(countedRounds(t.rounds(), "pr-40").length).toBe(1);
  });
  test("a fix-only round whose earlier findings glue a 12-digit run to an underscore is blocked, named", async () => {
    const t = runnerRig({ seat: answerWith("The key is account_123456789012 in the config.") });
    t.runner.admitAndQueue(brief({ id: "gu-1" }));
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "gu-2", body: "Fix: the key is gone." }))).toBeNull();
    await t.runner.tick();
    expect(t.get("gu-2").status).toBe("blocked: privacy");
    expect(t.get("gu-2").blocked_why).toEqual(["an account or card number in the earlier findings"]);
    expect(t.calls.length).toBe(1);
  });
  test("earlierCheck: only an eight-digit valid date passes, glued or bare (the bare date on purpose)", () => {
    const acct = { ok: false, why: ["an account or card number in the earlier findings"] };
    expect(earlierCheck(["Gemini: the web_search_20250305 tool is pinned"], TERMS)).toEqual({ ok: true });
    // A bare eight-digit valid date is accepted on purpose (DOCS.md, the privacy backstop).
    expect(earlierCheck(["Gemini: pinned since 20250305"], TERMS)).toEqual({ ok: true });
    expect(earlierCheck(["Gemini: the account is 87654321"], TERMS)).toEqual(acct);              // bare, not a date
    expect(earlierCheck(["Gemini: card_4111111111111111"], TERMS)).toEqual(acct);                // glued, Luhn-valid 16
    expect(earlierCheck(["Gemini: x4111111111111111"], TERMS)).toEqual(acct);                    // glued to a letter
    expect(earlierCheck(["Gemini: account_123456789012"], TERMS)).toEqual(acct);                 // glued, 12 digits
    expect(earlierCheck(["Gemini: tool_202503051"], TERMS)).toEqual(acct);                       // glued, nine digits
    expect(earlierCheck(["Gemini: tool_12345678"], TERMS)).toEqual(acct);                        // glued, eight but not a date
    expect(earlierCheck(["Gemini: tool_18991231"], TERMS)).toEqual(acct);                        // year before 1900
    expect(earlierCheck(["Gemini: tool_21000101"], TERMS)).toEqual(acct);                        // year after 2099
  });

  // Cain 0.18.1, second review: a round id is one change's; earlier findings come only from the change's own rounds.
  test("a fix-only round can't draw on another change's round: its id is refused at admission, nothing queued", async () => {
    let n = 0;
    const t = runnerRig({ seat: async (i) => answerWith(n++ === 0 ? "The other change's finding." : "Its own finding.")() });
    expect(t.runner.admitAndQueue(brief({ id: "oc-a1", pr: PRN(40) }))).toBeNull();
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "oc-b1", pr: PRN(41) }))).toBeNull();
    await t.runner.tick();
    // pr-41's fix-only round under pr-40's round id: refused, nothing queued, nothing counted.
    const why = t.runner.admitAndQueue(brief({ id: "oc-a1", pr: PRN(41), body: "Fix: done." }));
    expect(why).toContain("already a round of another change");
    expect(why).toContain("Nothing was queued.");
    expect(countedRounds(t.rounds(), "pr-41").map((x) => x.id)).toEqual(["oc-b1"]);
    expect(t.get("oc-a1").change).toBe("pr-40");
    // Even a rounds file that lists pr-40's round under pr-41 gives pr-41's fix-only round none of its findings.
    const file = t.cfg.roundsFile!;
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.changes["pr-41"].rounds.push({ ...j.changes["pr-40"].rounds[0] });
    writeFileSync(file, JSON.stringify(j));
    expect(t.runner.admitAndQueue(brief({ id: "oc-b2", pr: PRN(41), body: "Fix: done." }))).toBeNull();
    expect(t.get("oc-b2").round_kind).toBe("fixes");
    expect(t.get("oc-b2").earlier).toEqual(["Gemini [serious]: Its own finding."]);
    await t.runner.tick();
    expect(JSON.stringify(t.calls.at(-1)!.brief)).not.toContain("The other change's finding.");
  });

  // Cain 0.18.1: the earlier findings come only from the runner's own record of the previous round.
  test("a brief carrying its own earlier field, or findings text, is refused whole and nothing is queued", async () => {
    const t = runnerRig({ seat: answerWith("The stored finding.") });
    t.runner.admitAndQueue(brief({ id: "src-1" }));
    await t.runner.tick();
    const forged = { ...brief({ id: "src-2", body: "Fix: done." }), earlier: ["Gemini: forged finding 12345678"] } as unknown as Brief;
    expect(t.runner.admitAndQueue(forged)).toContain("not a brief");
    expect(existsSync(join(t.cfg.queueDir, "src-2.json"))).toBe(false);
    const findings = { ...brief({ id: "src-3", body: "Fix: done." }), findings: ["Gemini: forged"] } as unknown as Brief;
    expect(t.runner.admitAndQueue(findings)).toContain("not a brief");
    expect(parseBrief(JSON.stringify(forged)).error).toContain("a field that isn't allowed");
    expect(countedRounds(t.rounds(), "pr-40").length).toBe(1);
    // The same brief through Cain's inbox is not taken either.
    const inbox = join(t.dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "src-4.json"), JSON.stringify({ ...forged, id: "src-4" }));
    t.runner.cfg.inboxDir = inbox; t.runner.cfg.inboxUid = process.getuid!();
    t.runner.ingest();
    expect(existsSync(join(t.cfg.queueDir, "src-4.json"))).toBe(false);
    expect(t.relays().some((l) => l.includes("src-4") && l.includes("a field that isn't allowed"))).toBe(true);
    // A real fix-only round carries exactly the stored findings, and its brief's text still gets the full check.
    expect(t.runner.admitAndQueue(brief({ id: "src-5", body: "Fix: done." }))).toBeNull();
    const stored = t.get("src-1").seats.filter((s) => s.state === "done").flatMap((s) => s.findings!.map((f) => f.problem));
    expect(stored).toEqual(["The stored finding."]);
    expect(t.get("src-5").earlier).toEqual(["Gemini [serious]: The stored finding."]);
    await t.runner.tick();
    expect(t.calls[1].brief.earlier).toEqual(["Gemini [serious]: The stored finding."]);
    expect(t.runner.admitAndQueue(brief({ id: "src-6", body: "Fix: call 555-867-5309." }))).toBeNull();
    await t.runner.tick();
    expect(t.get("src-6").status).toBe("blocked: privacy");
    expect(t.get("src-6").blocked_why).toContain("a phone number");
  });

  test("review.sh prints the refusal and leaves nothing, reading the runner's cap and rounds", () => {
    const t = runnerRig();
    for (const id of ["cl-1", "cl-2", "cl-3"]) t.runner.admitAndQueue(brief({ id }));
    const f = join(t.dir, "b.json");
    writeFileSync(f, JSON.stringify(brief({ id: "cl-4" })));
    mkdirSync(join(t.dir, "in"), { recursive: true });
    const r = spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), "submit", f], { encoding: "utf8", env: { ...process.env,
      REVIEW_QUEUE: t.cfg.queueDir, REVIEW_INBOX: join(t.dir, "in"), REVIEW_TERMS: t.cfg.termsFile, REVIEW_SPEND: t.cfg.spendFile,
      REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: join(t.dir, "settings.json"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"),
      CAIN_TRUST: join(t.dir, "trust"), CAIN_STOP: join(t.dir, "trust", "stop.json"), CAIN_HOME: join(t.dir, "home"), CAIN_TEST_MODE: "1" } });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("has had 3 outside review rounds");
    expect(existsSync(join(t.dir, "in", "cl-4.json"))).toBe(false);
  });
});

describe("C: fix-only re-reviews, and the serious or follow-up sort", () => {
  test("a fixes round sends the seats only the fixes, with the earlier findings and the rule", async () => {
    const t = runnerRig({ seat: answerWith("The cap is kept in a file Cain can write.") });
    t.runner.admitAndQueue(brief({ id: "fx-1", body: "The whole design: keep the cap in the runner." }));
    await t.runner.tick();
    t.runner.admitAndQueue(brief({ id: "fx-2", body: "Fix: the rounds file is root's, 0640." }));
    await t.runner.tick();
    const [first, second] = t.calls;
    expect(first.brief.round_kind).toBeUndefined();
    expect(second.brief).toMatchObject({ round_kind: "fixes", body: "Fix: the rounds file is root's, 0640." });
    expect(second.brief.earlier).toEqual(["Gemini [serious]: The cap is kept in a file Cain can write."]);
    expect(second.brief.body).not.toContain("whole design");
    const p = prompt(second.brief, "reviewer");
    expect(p.system).toContain("Check only the listed fixes against the earlier findings");
    // 0.20.0: the owner's review rule's test, in every round's prompt, the full round's too.
    expect(p.system).toContain("(loses or corrupts) lose or corrupt something of the owner's;");
    expect(p.system).toContain("Otherwise it is FOLLOW-UP: hardening, a window that needs a crash or rare timing and fails safe, edge cases, wording, polish, and tests for those.");
    expect(p.user).toContain("<earlier>\n1. Gemini [serious]: The cap is kept in a file Cain can write.\n</earlier>");
    expect(prompt(first.brief, "reviewer").system).not.toContain("fix-only");
    expect(prompt(first.brief, "reviewer").system).toContain("(fails silently) let something fail without anyone hearing of it.");
  });

  test("the mark is read off each finding and kept in verdicts.md and result.json; an unmarked one counts as serious", async () => {
    expect(validateAnswer({ verdict: "approve_with_changes", findings: [finding("SERIOUS: loses a tap"), finding("Follow-up: wording")] }).answer!.findings
      .map((f) => [f.severity, f.problem])).toEqual([["serious", "loses a tap"], ["follow-up", "wording"]]);
    const t = runnerRig({ seat: answerWith("SERIOUS: the card can post twice", "FOLLOW-UP: a log line is long", "no mark at all") });
    t.runner.admitAndQueue(brief({ id: "mk-1" }));
    await t.runner.tick();
    t.runner.admitAndQueue(brief({ id: "mk-2" }));
    await t.runner.tick();
    const r = t.get("mk-2");
    expect(r.seats[0].findings!.map((f) => f.severity)).toEqual(["serious", "follow-up", "serious"]);
    expect(seriousLeft(r).length).toBe(2);
    expect(verdictsMd(r)).toContain("1. [serious] the card can post twice");
    expect(verdictsMd(r)).toContain("2. [follow-up] a log line is long");
    expect(JSON.parse(resultJson(r))).toMatchObject({ change: "pr-40", round: 2, cap: 3, round_kind: "fixes", serious_left: 2 });
    expect(JSON.parse(resultJson(r)).seats[0].findings[1].severity).toBe("follow-up");
    expect(roundLine(r)).toBe("Round 2 of 3 for pr-40 (fix-only): 2 serious findings left.");
    expect(t.relays().join("\n")).toContain("Round 2 of 3 for pr-40 (fix-only): 2 serious findings left.");
  });
});

describe("E: labels and the usage guard", () => {
  test("an other brief is refused below the floor and logged; a core one passes; there is no bypass", () => {
    const t = runnerRig({ guard: true, plan: () => ({ ...fresh(), fraction: 0.9 }) });
    const why = t.runner.admitAndQueue(brief({ id: "g-1", label: "other" }))!;
    expect(why).toContain("held by the usage guard");
    expect(why).toContain("10% of the week's allowance left, below the 25% reserve floor");
    const log = readFileSync(t.cfg.guardLog!, "utf8").trim().split("\n");
    expect(log.length).toBe(1);
    expect(log[0].split("\t").slice(1, 3)).toEqual(["other", "review g-1 (pr-40, round 1)"]);
    expect(log[0]).toContain("plan:");
    expect(t.runner.admitAndQueue(brief({ id: "g-2", label: undefined }))).toContain("labelled other");   // none counts as other
    for (const label of ["core", "commitment", "necessary-fix"] as const)
      expect(guardDecide(label, { plan: { ...fresh(), fraction: null }, seats: null, floor: 25 }, NOW)).toEqual({ ok: true });
    expect(t.runner.admitAndQueue(brief({ id: "g-3", label: "core" }))).toBeNull();
    expect(parseBrief(JSON.stringify({ ...brief(), label: "urgent" })).error).toContain("label must be one of");
    expect(parseBrief(JSON.stringify({ ...brief(), bypass: true })).error).toContain("a field that isn't allowed");
    expect([...LABELS]).toEqual([...CORE_LABELS]);
  });

  test("a seat below its floor holds other work too; the Build hook asks the same guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const settings = join(dir, "settings.json"), spend = join(dir, "spend.json"), log = join(dir, "guard.log");
    writeFileSync(settings, JSON.stringify({ format: 1, written_at: NOW.toISOString(), round_cap: 3, reserve_percent: 25,
      caps: { gemini: 10, perplexity: 4, claude: 30, openaiRuns: 200 }, review_limit: 1.5 }));
    writeFileSync(spend, JSON.stringify({ "2026-11": { gemini: { usd: 8, runs: 3, findings: 0, searches: 0 } } }));
    const o = { settingsFile: settings, spendFile: spend, logFile: log, tz: "America/New_York", now: NOW, plan: fresh };
    const v = guard("other", "Build on claude/x", o);
    expect(v).toMatchObject({ ok: false, floor: "seat gemini" });
    expect((v as any).why).toContain("Gemini has 20% of its monthly cap left");
    const holds = keeperHolds({ P9: { holder: "cain", branches: ["claude/x"] } });
    const run = (text: string, body: any = {}) => ({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text, ...body } } });
    const env = { stop: { stopped: false, at: null }, guard: (label: any, what: string) => guard(label, what, o) };
    expect(hookDecide(run("Branch: claude/x\nLabel: other\nDo it."), holds, env)).toContain("Held by the usage guard");
    expect(hookDecide(run("Branch: claude/x\nDo it."), holds, env)).toContain("labelled other");
    expect(hookDecide(run("Branch: claude/x\nDo it.", { label: "necessary-fix" }), holds, env)).toBe("");
    expect(hookDecide(run("Branch: claude/x\nLabel: core\nDo it.", { label: "other" }), holds, env)).toContain("one label");
    expect(hookDecide(run("Branch: claude/x\nDo it.", { label: "core", bypass: true }), holds, env)).toContain("nothing else");
    expect(hookDecide(run("Branch: claude/x\nDo it.", { label: "core" }), holds, { stop: { stopped: false, at: null } })).toBe("");
    expect(hookDecide(run("Branch: claude/x\nDo it."), holds, { stop: { stopped: false, at: null } })).toContain("usage guard");   // no guard: held
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(3);
  });
});

describe("F: the plan-usage reader, and an unknown or stale reading fails closed", () => {
  test("it reads the week's tokens from the transcripts, and says why the fraction is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const proj = join(home, ".claude", "projects", "-data-work");
    mkdirSync(proj, { recursive: true });
    const line = (ts: string, n: number) => JSON.stringify({ timestamp: ts, message: { usage: { input_tokens: n, output_tokens: n, cache_read_input_tokens: 0 } } });
    writeFileSync(join(proj, "a.jsonl"), [line("2026-11-20T10:00:00Z", 100), line("2026-11-01T10:00:00Z", 999), "not json", "{}"].join("\n"));
    writeFileSync(join(proj, "old.jsonl"), line("2026-10-01T10:00:00Z", 5000));
    utimesSync(join(proj, "old.jsonl"), new Date("2026-10-01"), new Date("2026-10-01"));
    const r = readPlanUsage({ dir: join(home, ".claude", "projects"), now: NOW });
    expect(r).toMatchObject({ fraction: null, tokens_week: 200, files: 1 });
    expect(r.reason).toContain("not the plan's weekly allowance");
    expect(readPlanUsage({ dir: join(home, "none"), now: NOW })).toMatchObject({ fraction: null, tokens_week: null });
  });
  test("unknown, or older than a day, counts as below the floor for other work", () => {
    const seats = [{ seat: "gemini", left: 0.9 }];
    expect(guardDecide("other", { plan: { ...fresh(), fraction: null, reason: "no allowance" }, seats, floor: 25 }, NOW))
      .toMatchObject({ ok: false, floor: "plan" });
    const stale = { ...fresh(), at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() };
    expect((guardDecide("other", { plan: stale, seats, floor: 25 }, NOW) as any).why).toContain("more than a day old");
    expect(guardDecide("other", { plan: fresh(), seats, floor: 25 }, NOW)).toEqual({ ok: true });
    expect(guardDecide("other", { plan: fresh(), seats: null, seatsWhy: "no caps", floor: 25 }, NOW)).toMatchObject({ ok: false, floor: "seats" });
    expect(seatsLeft({}, null, "2026-11").seats).toBeNull();
    const [a, b] = guardLines({ plan: { ...fresh(), fraction: null, reason: "no allowance" }, seats, floor: 25 }, NOW);
    expect(a).toContain("Plan: unknown (no allowance");
    expect(b).toContain("Floor 25%: other work is held (plan)");
  });
});

describe("G: review.sh spend prints the runner's caps and the round counts; guard prints two lines", () => {
  test("spend reads the caps the runner wrote, not its own environment's", () => {
    const t = runnerRig();
    t.cfg.caps = { gemini: 12, perplexity: 6, claude: 45, openaiRuns: 321 };
    t.runner.writeSettings();
    t.runner.admitAndQueue(brief({ id: "sp-1" }));
    t.runner.admitAndQueue(brief({ id: "sp-2" }));
    const env = { ...process.env, REVIEW_SPEND: t.cfg.spendFile, REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: join(t.dir, "settings.json"),
      REVIEW_CAP_GEMINI_USD: "8", REVIEW_CAP_CODEX_RUNS: "200", CAIN_HOME: join(t.dir, "home"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"), CAIN_TEST_MODE: "1" };
    const cli = (cmd: string) => spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), cmd], { encoding: "utf8", env });
    const out = cli("spend").stdout;
    expect(out).toContain("Gemini: $0.00 / $12.00");
    expect(out).toContain("OpenAI: $0.00 / 321 runs");
    expect(out).toContain("Claude: $0.00 / $45.00");
    expect(out).not.toContain("/ $8.00");
    expect(out).toContain("Review rounds (cap 3, the runner's):");
    expect(out).toContain("pr-40: 2 of 3 rounds");
    const g = cli("guard").stdout.trim().split("\n");
    expect(g.length).toBe(2);
    expect(g[0]).toStartWith("Plan: unknown");
    expect(g[1]).toContain("Floor 25%: other work is held (plan)");
  });
});

// ---- Round 2: the first outside review's fixes ----
import { capFileRules, capPaths, checkFiles, selfCheck, testMode } from "../rootfs/opt/cain/capfiles.ts";
import { decideWithGuard } from "../rootfs/opt/cain/hooks/remote-trigger.ts";
import { postHold } from "../rootfs/opt/cain/guard.ts";
import { linkRoutes, rootFetch } from "../rootfs/opt/cain/link/http.ts";
import { SeatError } from "../rootfs/opt/cain/review/core.ts";
import { readdirSync } from "node:fs";


describe("round 2, fix 2: the guard's log is root's; holds from Cain's side go through the link", () => {
  const LOW = (dir: string) => {
    const settings = join(dir, "settings.json"), spend = join(dir, "spend.json"), log = join(dir, "guard.log");
    writeFileSync(settings, JSON.stringify({ format: 1, written_at: NOW.toISOString(), round_cap: 3, reserve_percent: 25,
      caps: { gemini: 10, perplexity: 4, claude: 30, openaiRuns: 200 }, review_limit: 1.5 }));
    writeFileSync(spend, JSON.stringify({ "2026-11": { gemini: { usd: 9, runs: 3, findings: 0, searches: 0 } } }));
    writeFileSync(log, "");
    return { settingsFile: settings, spendFile: spend, log, tz: "America/New_York", now: NOW, plan: fresh };
  };
  const build = (text: string) => ({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text } } });
  const holds = keeperHolds({ P9: { holder: "cain", branches: ["claude/x"] } });

  test("the hook's refusal reaches the log through the link's route, and only the link writes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hold-"));
    const o = LOW(dir);
    const r = rig({ holds: keeperHolds({}) });
    // Round 3: the guard only decides at the link; the link appends the line itself.
    Object.assign((r.link as any).d, { guardHold: (label: any, what: string) => guard(label, what, o), holdLog: (l: string) => { appendFileSync(o.log, l); } });
    const routes = linkRoutes({ link: r.link, toHarness: async () => true });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      const url = new URL(req.url);
      if (req.headers.get("x-harness-key") !== "cain-key") return new Response("{}", { status: 403 });
      return routes(req, url, "cain", await req.text());
    } });
    try {
      const reading = (label: any, what: string) => guardDecide(label, readings(o), NOW);
      const post = (l: any, w: string) => postHold(l, w, { url: `http://127.0.0.1:${server.port}`, key: "cain-key" });
      const why = await decideWithGuard(build("Branch: claude/x\nLabel: other\nDo it."), holds, { stop: { stopped: false, at: null } }, reading, post);
      expect(why).toContain("Held by the usage guard");
      expect(why).toContain("It's on the guard's log");
      const lines = readFileSync(o.log, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0].split("\t").slice(1, 3)).toEqual(["other", "Build on claude/x"]);
      // A core run never asks the link.
      expect(await decideWithGuard(build("Branch: claude/x\nLabel: core\nDo it."), holds, { stop: { stopped: false, at: null } }, reading, post)).toBe("");
      // The link unreachable: still refused (fail closed), and it says the hold wasn't logged.
      const gone = (l: any, w: string) => postHold(l, w, { url: "http://127.0.0.1:9", key: "cain-key", ms: 1000 });
      const why2 = await decideWithGuard(build("Branch: claude/x\nLabel: other\nDo it."), holds, { stop: { stopped: false, at: null } }, reading, gone);
      expect(why2).toContain("Held by the usage guard");
      expect(why2).toContain("The hold could not be logged");
      expect(readFileSync(o.log, "utf8").trim().split("\n").length).toBe(1);
      // The link decides again: a hold its own reading doesn't refuse is not logged.
      Object.assign((r.link as any).d, { guardHold: () => ({ ok: true }) });
      expect((r.link as any).guardHoldFor({ label: "other", what: "x" })).toEqual({ status: "passes" });
      expect(readFileSync(o.log, "utf8").trim().split("\n").length).toBe(1);
    } finally { server.stop(true); }
    expect(routeAllowed("cain", "/guard-hold")).toBe(true);
    expect(routeAllowed("specialist", "/guard-hold")).toBe(false);
  });

  test("lock.sh makes the log root:cain 0640, which gives his user no write", () => {
    const lock = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/c1/lock.sh"), "utf8");
    expect(lock).toContain('own "$D/review-guard.log" root:cain 0640');
    expect(lock).not.toMatch(/for f in [^\n]*review-guard\.log[^\n]*; do\n[^]*?root:cain 0660/);
    const mode = 0o640;
    expect(mode & 0o020).toBe(0);                                             // the group (his) can't write
    expect(mode & 0o002).toBe(0);
    const rule = capFileRules(capPaths({})).find((x) => x.path === "/data/review-guard.log")!;
    expect(rule).toMatchObject({ uid: 0, gid: 1000, mode: 0o640 });
    const st = (mode: number) => ({ isSymbolicLink: () => false, isFile: () => true, uid: 0, gid: 1000, mode: 0o100000 | mode }) as any;
    expect(checkFiles([rule], () => st(0o660))).toBe("/data/review-guard.log is owned by 0:1000, mode 0660");
    expect(checkFiles([rule], () => st(0o640))).toBeNull();
  });
});

describe("round 2, fix 6: the install-time self-check", () => {
  const st = (uid: number, gid: number, mode: number, link = false) => ({ isSymbolicLink: () => link, isFile: () => !link, uid, gid, mode: 0o100000 | mode }) as any;
  test("every file right passes; one wrong turns the features off with one alarm naming it", () => {
    const rules = capFileRules(capPaths({}));
    const good: Record<string, any> = { "/data/review-rounds.json": st(0, 1000, 0o640), "/data/review-settings.json": st(0, 1000, 0o640),
      "/data/review-guard.log": st(0, 1000, 0o640) };
    const stat = (files: Record<string, any>) => (p: string) => { if (!files[p]) throw Object.assign(new Error("none"), { code: "ENOENT" }); return files[p]; };
    const alarms: string[] = [];
    let cleared = 0;
    const o = { rules, alarm: (c: string) => alarms.push(c), clear: () => cleared++, log: () => {}, mode: "own" };
    expect(selfCheck({ ...o, stat: stat(good) })).toBeNull();
    expect(cleared).toBe(1);
    // 0.20.0: the retired grants and decisions files are no longer checked, whatever they look like.
    expect(selfCheck({ ...o, stat: stat({ ...good, "/data/link/review-decisions.json": st(0, 1000, 0o664), "/data/review-grants.json": st(1000, 1000, 0o666) }) })).toBeNull();
    expect(selfCheck({ ...o, stat: stat({ ...good, "/data/review-rounds.json": st(1000, 1000, 0o640) }) })).toBe("/data/review-rounds.json is owned by 1000:1000, mode 0640");
    expect(capFileRules(capPaths({})).some((r) => r.path.includes("rollback-armed"))).toBe(false);   // 0.19.0: read from the keeper
    expect(selfCheck({ ...o, stat: stat({ ...good, "/data/review-settings.json": st(0, 1000, 0o640, true) }) })).toBe("/data/review-settings.json is a symlink");
    const { ["/data/review-guard.log"]: _c, ...noLog } = good;
    expect(selfCheck({ ...o, stat: stat(noLog) })).toBe("/data/review-guard.log is missing");
    expect(alarms.length).toBe(3);
    expect(selfCheck({ ...o, stat: stat(noLog), mode: "old" })).toBeNull();               // the old way: he's root, not checked
    expect(alarms.length).toBe(3);
  });

  test("while off, the runner takes no brief and the link logs no hold", async () => {
    const t = runnerRig();
    t.runner.capOff = "/data/review-rounds.json is owned by 1000:1000, mode 0640";
    expect(t.runner.admitAndQueue(brief({ id: "off-1" }))).toContain("the review cap's files aren't right");
    expect(loadReview(t.cfg.queueDir, "off-1")).toBeNull();
    const r = rig({ holds: keeperHolds({}) });
    Object.assign((r.link as any).d, { capOff: () => "x is a symlink", guardHold: () => ({ ok: false, floor: "plan", why: "low", logged: true }) });
    expect(() => (r.link as any).guardHoldFor({ label: "other", what: "x" })).toThrow("files aren't right");
    expect(r.posts()).toBe(0);
  });
});

describe("round 2, fix 7: paths are constants; overrides only in test mode", () => {
  test("the environment moves no path outside test mode", () => {
    const env = { REVIEW_ROUNDS: "/tmp/x", REVIEW_SETTINGS: "/tmp/y", REVIEW_GUARD_LOG: "/tmp/z", CAIN_HOME: "/tmp/h" };
    expect(testMode(env)).toBe(false);
    expect(capPaths(env)).toMatchObject({ rounds: "/data/review-rounds.json", settings: "/data/review-settings.json",
      guardLog: "/data/review-guard.log", home: "/data/cain" });
    expect(Object.keys(capPaths(env))).not.toContain("grants");       // 0.20.0: the retired grants file is gone
    expect(Object.keys(capPaths(env))).not.toContain("decisions");
    expect(capPaths({ ...env, CAIN_TEST_MODE: "1" })).toMatchObject({ rounds: "/tmp/x", settings: "/tmp/y", guardLog: "/tmp/z", home: "/tmp/h" });
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    expect(run).not.toContain("CAIN_TEST_MODE");
  });
  test("the Build hook refuses every run while the test-mode variable is set", () => {
    const call = JSON.stringify({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text: "Branch: claude/x\nLabel: core\nDo it." } } });
    const r = spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/hooks/remote-trigger.ts")], { input: call, encoding: "utf8",
      env: { ...process.env, CAIN_TEST_MODE: "1" } });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("CAIN_TEST_MODE is set, a tests-only variable");
  });
});

// Round 3: the second outside review's fixes.
import { appendCapped, holdLogged } from "../rootfs/opt/cain/link/cap.ts";
import { CARD_RULES, HOLD_DEDUPE_MS, HOLDS_PER_MINUTE } from "../rootfs/opt/cain/link/core.ts";
import { AT, RULES } from "../rootfs/opt/cain/gate/rules.ts";
import { LINK_DECIDES_BUILDS } from "../rootfs/opt/cain/guard.ts";
import { chmodSync, chownSync, statSync } from "node:fs";

const NOTICE_SH = join(import.meta.dir, "../rootfs/opt/cain/notice.sh");
const noticeText = (kind: string, cause: string) => spawnSync("bash", [NOTICE_SH, "text", kind, cause], { encoding: "utf8" }).stdout;

describe("round 3, fix 2: the hold route is bounded", () => {
  const refuse = () => ({ ok: false as const, floor: "plan", why: "the plan's usage is unknown" });
  const holdRig = () => {
    const r = rig({ holds: keeperHolds({}) });
    const lines: string[] = [], alarms: [string, string][] = [];
    Object.assign((r.link as any).d, { guardHold: refuse, holdLog: (l: string) => { lines.push(l); }, alarm: (k: string, c: string) => alarms.push([k, c]) });
    return { r, lines, alarms, hold: (what: string, caller = "cain", label = "other") => (r.link as any).guardHoldFor({ label, what }, caller) };
  };

  test(`at most ${HOLDS_PER_MINUTE} calls a minute per caller, with one alarm; another caller and the next minute go on`, () => {
    const t = holdRig();
    for (let i = 0; i < HOLDS_PER_MINUTE; i++) expect(t.hold(`Build ${i}`).status).toBe("held");
    expect(() => t.hold("Build 99")).toThrow(`more than ${HOLDS_PER_MINUTE} holds in a minute`);
    expect(() => t.hold("Build 100")).toThrow("in a minute");
    expect(t.lines.length).toBe(HOLDS_PER_MINUTE);
    expect(t.alarms).toEqual([["review-holds", `more than ${HOLDS_PER_MINUTE} holds in a minute from cain`]]);
    expect(t.hold("Build from root", "root").status).toBe("held");
    t.r.later(61_000);
    expect(t.hold("Build 101").status).toBe("held");
    expect(t.alarms.length).toBe(1);
    // An hour without another hit: the sweep clears the alarm.
    const cleared: string[] = [];
    Object.assign((t.r.link as any).d, { clearAlarm: (g: string) => cleared.push(g) });
    (t.r.link as any).capSweep();
    expect(cleared).toEqual([]);
    t.r.later(3_600_000);
    (t.r.link as any).capSweep();
    expect(cleared).toEqual(["holds"]);
  });

  test("an identical refusal is logged once in ten minutes; a new description, or later, is logged again", () => {
    const t = holdRig();
    expect(t.hold("Build on claude/x")).toEqual({ status: "held", why: "the plan's usage is unknown" });
    expect(t.hold("Build on claude/x")).toMatchObject({ status: "held", repeat: true });
    expect(t.hold("Build on claude/x", "cain", "other")).toMatchObject({ repeat: true });
    expect(t.lines.length).toBe(1);
    expect(t.hold("Build on claude/y").repeat).toBeUndefined();
    expect(t.lines.length).toBe(2);
    t.r.later(HOLD_DEDUPE_MS);
    expect(t.hold("Build on claude/x").repeat).toBeUndefined();
    expect(t.lines.length).toBe(3);
  });

  test("the description goes through the card gate: one that fails is logged as a build with its label", () => {
    for (const bad of [`Build ${"a".repeat(40)} at 2026-11-21T10:00:00Z`, "Build \u2014 now", "Build, and 3 more"]) {
      const t = holdRig();
      expect(t.hold(bad).status).toBe("held");
      expect([bad, t.lines.map((l) => l.split("\t")[2])]).toEqual([bad, ["a build labelled other"]]);
    }
    const ok = holdRig();
    ok.hold("Build on claude/cap-in-code");
    expect(ok.lines.map((l) => l.split("\t")[2])).toEqual(["Build on claude/cap-in-code"]);
  });

  test("the guard's log is capped in size and rotated root-side, keeping one previous file, with one alarm", () => {
    const dir = mkdtempSync(join(tmpdir(), "r3-"));
    const log = join(dir, "review-guard.log");
    writeFileSync(log, "x".repeat(95) + "\n", { mode: 0o640 });
    const owned: number[] = [];
    const o = { max: 100, sync: () => {}, own: (fd: number) => { owned.push(fd); } };
    expect(appendCapped(log, "first\n", o)).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(95) + "\n");
    expect(readFileSync(log, "utf8")).toBe("first\n");
    expect(statSync(log).mode & 0o777).toBe(0o640);
    expect(owned.length).toBe(1);
    expect(appendCapped(log, "second\n", o)).toBe(false);
    writeFileSync(log, "y".repeat(99));
    expect(appendCapped(log, "third\n", o)).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("y".repeat(99));            // one previous file, the older one gone
    expect(readdirSync(dir).sort()).toEqual(["review-guard.log", "review-guard.log.1"]);
    // At the link: a rotation raises the same one alarm.
    const t = holdRig();
    Object.assign((t.r.link as any).d, { holdLog: () => true });
    t.hold("Build on claude/z");
    expect(t.alarms).toEqual([["review-holds", "the guard's log reached its size cap, so the App rotated it, keeping one previous file"]]);
  });

  test("a non-root uid can't append to the 0640 root:cain guard log", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) {
      console.log("skipped: this test needs root to drop to another uid, and this run isn't root");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "r3-perm-"));
    chmodSync(dir, 0o755);
    const log = join(dir, "review-guard.log");
    writeFileSync(log, "line\n");
    chownSync(log, 0, 1000);
    chmodSync(log, 0o640);
    const r = spawnSync("/bin/sh", ["-c", 'echo held >> "$1"', "sh", log], { uid: 1000, gid: 1000, encoding: "utf8" });
    if (r.error) { console.log(`skipped: couldn't drop privileges here (${r.error.message})`); return; }
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Permission denied/i);
    expect(readFileSync(log, "utf8")).toBe("line\n");
    // His group can read it.
    const read = spawnSync("/bin/cat", [log], { uid: 1000, gid: 1000, encoding: "utf8" });
    expect(read.stdout).toBe("line\n");
  });
});

describe("round 3, fix 4: the self-check's alarm says what it stops, and the check re-runs", () => {
  test("the alarm says Ship decisions are paused for every pull request; the check re-runs and clears once the file is right", () => {
    const text = noticeText("review-files", "/data/review-rounds.json is owned by 1000:1000, mode 0640");
    expect(text).toContain("Ship decisions are paused for every pull request");
    expect(text).toContain("/data/review-rounds.json is owned by 1000:1000");
    expect(text).toContain("turns them back on by itself once it is right, and this clears then");
    const rules = capFileRules(capPaths({}));
    const st = (uid: number) => ({ isSymbolicLink: () => false, isFile: () => true, uid, gid: uid === 0 ? 1000 : 1000, mode: 0o100640 }) as any;
    let roundsUid = 1000;
    const stat = (p: string) => {
      if (p.endsWith("review-decisions.json")) throw Object.assign(new Error("none"), { code: "ENOENT" });
      return st(p.endsWith("review-rounds.json") ? roundsUid : 0);
    };
    const alarms: string[] = [];
    let cleared = 0;
    const o = { rules, stat, alarm: (c: string) => alarms.push(c), clear: () => cleared++, log: () => {}, mode: "own" };
    let prev = selfCheck(o);                                                   // the start
    expect(prev).toContain("review-rounds.json");
    prev = selfCheck({ ...o, prev });                                          // a sweep, still wrong: no second alarm
    prev = selfCheck({ ...o, prev });
    expect(alarms.length).toBe(1);
    expect(cleared).toBe(0);
    roundsUid = 0;                                                             // set right: the next sweep turns it back on
    prev = selfCheck({ ...o, prev });
    expect(prev).toBeNull();
    expect(cleared).toBe(1);
    prev = selfCheck({ ...o, prev });
    expect(cleared).toBe(1);
  });

  test("the link runs the cap's own sweep at each sweep, and the runner re-runs the check at each tick", () => {
    const r = rig({ holds: keeperHolds({}) });
    let n = 0;
    Object.assign((r.link as any).d, { capSweep: () => { n++; } });
    (r.link as any).capSweep();
    expect(n).toBe(1);
    const core = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).toMatch(/this\.retireCards\(\);\n\s*this\.capSweep\(\);/)
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toContain("capOff = selfCheck({ log: capLog, prev: capOff });");
    const review = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/review/main.ts"), "utf8");
    expect(review).toContain("runner.capOff = selfCheck({ log, prev: runner.capOff });");
  });
});

describe("round 3, fix 6: the hook names its own reading when the link's passes", () => {
  test("hook refuses, link passes: the refusal names the hook's reading and the difference", async () => {
    const holds = keeperHolds({ P9: { holder: "cain", branches: ["claude/x"] } });
    const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: BUILD, body: { text: "Branch: claude/x\nLabel: other\nDo it." } } };
    const reading = () => ({ ok: false as const, floor: "plan", why: "the plan's usage is unknown" });
    const fake = (async () => new Response(JSON.stringify({ status: "passes" }), { status: 200 })) as unknown as typeof fetch;
    const sent = await postHold("other", "Build on claude/x", { key: "k", fetch: fake });
    expect(sent).toMatchObject({ logged: false, passes: true });
    const why = await decideWithGuard(call, holds, { stop: { stopped: false, at: null } }, reading, async () => sent);
    expect(why).toContain("by the hook's own reading the plan's usage is unknown");
    expect(why).toContain("the two readings differ");
    expect(why).not.toContain("the link didn't take it");
    const why2 = await decideWithGuard(call, holds, { stop: { stopped: false, at: null } }, reading, async () => ({ logged: false }));
    expect(why2).toContain("the link didn't take it");
  });
});

describe("round 3, fix 7: no silent gap between the plan reader and the hook", () => {
  test("while the hook alone decides a Build run, the plan reader never returns a real fraction", () => {
    if (LINK_DECIDES_BUILDS) return;                                           // the link decides first: the gap is closed
    // Behaviour: whatever the transcripts hold, the fraction is unknown.
    const home = mkdtempSync(join(tmpdir(), "r3-plan-"));
    const proj = join(home, ".claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    const line = (n: number) => JSON.stringify({ timestamp: NOW.toISOString(), message: { usage: { input_tokens: n, output_tokens: n } } });
    writeFileSync(join(proj, "a.jsonl"), [line(5_000_000), line(1), '{"usage": {"plan_fraction": 0.5, "weekly_limit": 100}}'].join("\n"));
    for (const dir of [join(home, ".claude", "projects"), join(home, "none")]) {
      const p = readPlanUsage({ dir, now: NOW });
      expect([dir, p.fraction]).toEqual([dir, null]);
    }
    // Code: every fraction the reader returns is null, and the hook asks the link only when it refuses.
    const reader = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/plan-usage.ts"), "utf8");
    const body = reader.slice(reader.indexOf("export function readPlanUsage"));
    const returned = [...body.matchAll(/fraction:\s*([^,}]+)/g)].map((m) => m[1].trim());
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((v) => v === "null")).toBe(true);
    const hook = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/hooks/remote-trigger.ts"), "utf8");
    expect(hook).toContain("if (!held) return first;");
    const guardSrc = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/guard.ts"), "utf8");
    expect(guardSrc).toContain("The silent gap (round 3)");
  });
});
