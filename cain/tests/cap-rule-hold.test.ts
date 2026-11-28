// Cain 0.20.0: the owner's review rule (R-013 in his record), in its hold-only form. Three review rounds a change,
// never more. At the cap: nothing serious left gives the normal Ship card, bound to the head that round reviewed;
// something serious left means the change is held, and the owner hears one plain line from code at each outcome.
// He is never asked about rounds, risk or cuts. The rule's cut branch is a later piece: nothing here cuts.
// Each part with a test that fails without it:
//   1. the grant of extra rounds is retired (keeper.sh, link routes, c1/lock.sh, the runner reads no grants file)
//   2. the decision card and ship-with-risk are retired (no card owed, /decision answers retired, old cards expire)
//   3. sorting by the rule's test with no cross-seat downgrade (review/core.ts isSerious, seriousLeft)
//   4. the Ship card at the cap, bound to the reviewed head at the card and at the tap (link/cap.ts, link/core.ts)
//   5. the owner's one line per change and outcome (runner.ts owe, postLines, remind; review.sh decide; link reviewLine)
//   6. the message gate holds a reply or edit that asks him about rounds, risk or cuts (gate/cain.ts, gate/send.ts)
//   7. the landing: the push refspec and the owner's line when main moved (link/merge.ts, link/core.ts)
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrief, prompt, relayLine, seriousLeft, verdictsMd, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, labelRate, loadReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { configFromEnv } from "../rootfs/opt/cain/review/config.ts";
import { checkDecision, readRounds } from "../rootfs/opt/cain/review/rounds.ts";
import type { SeatAnswer, SeatFn, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { asksAboutCap, capStateFor, ownerLineText } from "../rootfs/opt/cain/link/cap.ts";
import { BOUND_MOVED, BOUND_TAP, GRANT_RETIRED, MAIN_MOVED_LINE, RETIRED_TAP } from "../rootfs/opt/cain/link/core.ts";
import { linkRoutes } from "../rootfs/opt/cain/link/http.ts";
import { ACTIONS_APP, land, pushRefspec, type MergeDeps } from "../rootfs/opt/cain/link/merge.ts";
import { decideSend, HELD } from "../rootfs/opt/cain/gate/send.ts";
import { keeperHolds, NOV11_8AM, MIN, PR, rig, SHA1, SHA2 } from "./link-rig";

const ROOT = join(import.meta.dir, "..");
const NOW = new Date("2026-11-27T15:00:00Z");
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-27-hold-a", topic: "Calendar retries", question: "Do retries keep each change exactly once?", body: "Retry a failed write.",
  needs_facts: false, consequential: false, pr: PRN(40), head: SHA1, label: "core", ...over,
});
const said = (verdict: SeatAnswer["verdict"], ...problems: string[]): SeatAnswer =>
  ({ verdict, findings: problems.map((p, i) => ({ rank: i + 1, problem: p, fix: "fix it" })), model: "m", cost_usd: 0.01 });
const SER = "SERIOUS (loses or corrupts): a crash between two writes loses the record";
type Answer = (i: SeatInput) => Promise<SeatAnswer>;

function rules(o: { openai?: Answer; gemini?: Answer; claude?: Answer; postLine?: any; down?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rulehold-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"), inboxDir: join(dir, "inbox"),
    inboxUid: process.getuid!(), reviewedFile: join(dir, "reviewed.json"), roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const calls: { seat: string; input: SeatInput }[] = [];
  const of = (seat: string, a: Answer | undefined): SeatFn => async (i) => { calls.push({ seat, input: i }); return (a ?? (async () => said("approve")))(i); };
  const seats: any = { openai: of("openai", o.openai), gemini: of("gemini", o.gemini), claude: of("claude", o.claude) };
  let clock = NOW;
  const lines: any[] = [];
  const runner = new Runner(cfg, { seats, now: () => clock, rand: () => 0.5, log: () => {},
    plan: () => ({ fraction: 0.1, at: NOW.toISOString(), reason: "t", tokens_week: 1, files: 1 }),
    unavailable: (s) => (o.down ?? []).includes(s) ? { kind: "unconfigured", detail: "down" } : null,
    postLine: o.postLine ?? (async (l: any) => { lines.push(l); return `m-${lines.length}`; }) });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  const round = async (id: string, over: Partial<Brief> = {}) => {
    const why = runner.admitAndQueue(brief({ id, seats: ["openai", "gemini"], ...over }));
    if (why) throw new Error(why);
    await runner.tick();
    return loadReview(cfg.queueDir, id)!;
  };
  const decide = (d: any) => { mkdirSync(cfg.inboxDir!, { recursive: true }); writeFileSync(join(cfg.inboxDir!, `decide-${Date.now()}-${Math.random()}.decision`), JSON.stringify(d)); };
  const cli = (...args: string[]) => spawnSync("bun", [join(ROOT, "rootfs/opt/cain/review/cli.ts"), ...args], { encoding: "utf8",
    env: { ...process.env, CAIN_TEST_MODE: "1", REVIEW_INBOX: cfg.inboxDir!, REVIEW_ROUNDS: cfg.roundsFile!, REVIEW_SETTINGS: cfg.settingsFile!,
      REVIEW_HEALTH: cfg.healthFile, REVIEW_SPEND: cfg.spendFile } });
  return { dir, cfg, runner, calls, relays, round, lines, decide, cli, later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    rounds: () => readRounds(cfg.roundsFile!)!, get: (id: string) => loadReview(cfg.queueDir, id)! };
}
const strict: Answer = async () => said("approve_with_changes", SER);
async function atCap(o: Parameters<typeof rules>[0] = {}) {
  const t = rules({ openai: strict, ...o });
  for (const id of ["c-1", "c-2", "c-3"]) await t.round(id);
  return t;
}
// A round's record by hand, for the count.
const seatRec = (key: string, s: any, findings: any[] = [], extra: any = {}) => ({ key, seat: s, role: "reviewer", state: "done", provider: "", family: "",
  counts: s !== "claude" && !extra.stands_in_for, attempts: 1, cost_usd: 0, verdict: "approve", findings, ...extra });
const finding = (problem: string, severity?: "serious" | "follow-up") => ({ rank: 1, problem, fix: "x", ...(severity ? { severity } : {}) });

describe("1: the grant of extra rounds is retired", () => {
  test("the cap check reads no grants file: a grant left on disk raises nothing, and round 4 is refused", async () => {
    const t = rules();
    writeFileSync(join(t.dir, "review-grants.json"), JSON.stringify({ format: 1, grants: [{ id: "pr-40+1", key: "pr-40", rounds: 3, by: "owner", at: NOW.toISOString(), message: "1", reason: "x", item: null, pr: PRN(40) }] }));
    for (const id of ["g-1", "g-2", "g-3"]) await t.round(id);
    const why = t.runner.admitAndQueue(brief({ id: "g-4", seats: ["openai", "gemini"] }))!;
    expect(why).toContain("the owner's rule allows at most 3, never more");
    expect(why).not.toMatch(/grant/i);
    expect(loadReview(t.cfg.queueDir, "g-4")).toBeNull();
    expect(Object.keys(configFromEnv({}))).not.toContain("grantsFile");
    for (const f of ["review/runner.ts", "review/rounds.ts", "review/cli.ts", "review/config.ts", "link/cap.ts", "link/core.ts", "link/main.ts"])
      expect(readFileSync(join(ROOT, "rootfs/opt/cain", f), "utf8")).not.toMatch(/readGrants|grantsFor|effectiveCap|grantsFile|review-grants\.json/);
    expect(existsSync(join(ROOT, "rootfs/opt/cain/review/grants.ts"))).toBe(false);
  });

  test("a capped change has no grant path: its done line names none, and the link's route answers only that it is retired", async () => {
    const t = await atCap();
    const all = t.relays().join("\n");
    expect(all).not.toMatch(/grant/i);
    const r = rig({ holds: keeperHolds({}) });
    const routes = linkRoutes({ link: r.link, toHarness: async () => true });
    const raw = JSON.stringify({ item: "P46", change: PRN(40), rounds: 2, text: "More fixing" });
    const res = await routes(new Request("http://link/review-grant", { method: "POST", body: raw }), new URL("http://link/review-grant"), "cain", raw);
    expect(res.status).toBe(400);
    expect((await res.json()).said).toContain("retired by the owner's review rule");
    expect(r.posts()).toBe(0);
    expect(GRANT_RETIRED).not.toContain("cut");
  });

  test("keeper.sh review-grant only prints a refusal naming the retirement, and asks the link nothing", () => {
    const run = spawnSync("bash", [join(ROOT, "rootfs/opt/cain/keeper.sh"), "review-grant", "--item", "P46", "--change", PRN(40), "--rounds", "2", "why"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
    expect(run.status).toBe(2);
    const j = JSON.parse(run.stdout);
    expect(j.status).toBe("refused");
    expect(j.said).toContain("keeper.sh review-grant is retired by the owner's review rule");
    expect(j.said).not.toContain("cut check");
    const sh = readFileSync(join(ROOT, "rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).not.toContain('"/review-grant"');
    expect(sh).not.toMatch(/connector\|review-grant/);
  });

  test("lock.sh removes the grants file at start, so grants already given lapse", () => {
    const lock = readFileSync(join(ROOT, "rootfs/opt/cain/c1/lock.sh"), "utf8");
    expect(lock).toContain('rm -f "$D/review-grants.json"');
    expect(lock).not.toContain("printf '{\"format\": 1, \"grants\": []}");
  });
});

describe("2: the decision card and ship-with-risk are retired", () => {
  test("the runner owes and posts no decision card, and /decision answers that it is retired", async () => {
    const t = await atCap();
    expect((t.rounds().changes["pr-40"] as any).decision).toBeUndefined();
    expect((t.runner.deps as any).postDecision).toBeUndefined();
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/review/main.ts"), "utf8")).not.toContain("/decision");
    const r = rig({ holds: keeperHolds({}) });
    const routes = linkRoutes({ link: r.link, toHarness: async () => true });
    const dec = await routes(new Request("http://link/decision", { method: "POST", body: "{}" }), new URL("http://link/decision"), "root", "{}");
    expect((await dec.json()).said).toContain("nothing goes to him from the service");
    expect(r.posts()).toBe(0);
    const core = readFileSync(join(ROOT, "rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).not.toMatch(/armedFor|this\.d\.armed|heldForRollback|DECISION_OPTIONS|reviewGrant\(|this\.d\.decided/);
  });

  test("an open grant or decision card is expired at the next sweep, and a tap on one is refused with a plain line", async () => {
    const r = rig({ holds: keeperHolds({}) });
    const grant = (await r.link.ask({ text: "Is the calendar fix ready?", options: ["Yes", "No"], item: "P46", question: "Q1" }) as any).message as string;
    let s = r.state();
    s.messages[grant].grant = { key: "pr-40", rounds: 2, pr: PRN(40), reason: "x", used: 3, cap: 3, head: SHA1, decision: null };
    r.setState(s);
    const decision = (await r.link.ask({ text: "The calendar fix: hold it?", options: ["Hold", "Go"], item: "P47", question: "Q1" }) as any).message as string;
    s = r.state();
    s.messages[decision].decision = { id: "pr-41#3", key: "pr-41", pr: PRN(41) };
    s.decisions = { "pr-42#3": { since: 1 } };
    r.setState(s);
    const before = r.relayed.length;
    expect(await r.tap(r.msg(grant), r.ids(grant)[0])).toBe("dead: retired");
    expect(r.ephemerals().map((e: any) => e.content)).toContain(RETIRED_TAP);
    expect(r.relayed.length).toBe(before);
    await r.link.sweep();
    const st = r.state();
    expect(st.messages[decision]).toMatchObject({ outcome: "expired", why: "retired", buttons: false });
    expect(String(r.msg(decision).content)).toContain("Expired");
    expect(r.msg(decision).components ?? []).toEqual([]);
    expect(st.decisions).toBeUndefined();
    expect(await r.tap({ ...r.msg(decision), components: [{ type: 1, components: [{ type: 2, custom_id: "q:x:0", label: "Hold" }] }] }, "q:x:0")).toBe("dead: retired");
    expect(r.relayed.slice(before).some((l) => l.includes("Dane tapped"))).toBe(false);
  });

  test("the cut branch isn't built: a brief naming a kind is refused, and decide takes only hold", () => {
    expect(parseBrief(JSON.stringify({ ...brief(), kind: "cut-check" })).error).toContain("a field that isn't allowed");
    expect(checkDecision({ change: "pr-40", choice: "cut" })).toContain("choice must be hold");
    for (const f of ["review/runner.ts", "review/rounds.ts", "review/core.ts", "link/cap.ts", "link/core.ts"])
      expect(readFileSync(join(ROOT, "rootfs/opt/cain", f), "utf8")).not.toMatch(/CUT_CHECK|cutResult|sortPass|panelOf|purposeOf|cutdiff/);
    expect(existsSync(join(ROOT, "rootfs/opt/cain/review/cutdiff.ts"))).toBe(false);
  });
});

describe("3: sorting by the rule's test, with no downgrade", () => {
  test("every seat's prompt carries the test and asks for each finding labelled with the arm", () => {
    for (const role of ["reviewer", "stand-in", "facts"] as const) {
      const p = prompt({ topic: "t", question: "q", body: "b", needs_facts: false, consequential: false }, role).system;
      for (const arm of ["(loses or corrupts)", "(acts wrongly)", "(exposes or widens)", "(fails silently)"]) expect(p).toContain(arm);
      expect(p).toContain('"SERIOUS (<arm>):" naming the arm it meets, or "FOLLOW-UP (<arm>):" naming the arm it comes nearest to and fails');
    }
  });

  test("an unlabelled finding counts as serious", () => {
    const r: any = { seats: [seatRec("openai", "openai", [finding("no label at all")])] };
    expect(seriousLeft(r).length).toBe(1);
    const r2: any = { seats: [seatRec("openai", "openai", [finding("a follow-up", "follow-up")])] };
    expect(seriousLeft(r2).length).toBe(0);
  });

  test("a Claude stand-in's follow-up label counts as serious, never away from it", () => {
    const r: any = { seats: [seatRec("openai", "openai", [], { state: "substituted" }), seatRec("gemini", "gemini"),
      seatRec("claude-for-openai", "claude", [finding("only wording", "follow-up")], { stands_in_for: "openai", role: "stand-in" })] };
    expect(seriousLeft(r).map((f) => f.problem)).toEqual(["only wording"]);
    expect(verdictsMd({ id: "x", brief: null, digest: "d", created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: "done",
      consequential: false, needs_facts: false, topic: "t", cost_usd: 0, ...r } as any)).toContain("a stand-in's follow-up label: it still counts as serious");
  });

  test("two seats disagreeing: serious wins, and no seat's label takes another's serious finding off", async () => {
    const t = rules({ openai: async () => said("approve_with_changes", "SERIOUS (acts wrongly): it posts twice"),
      gemini: async () => said("approve", "FOLLOW-UP (acts wrongly): it posts twice, but the second is harmless") });
    for (const id of ["s-1", "s-2", "s-3"]) await t.round(id);
    // Nothing is sent but the rounds themselves: no sorting step asks one seat about another's findings.
    expect(t.calls.length).toBe(6);
    const r = t.get("s-3");
    expect(seriousLeft(r).map((f) => f.problem)).toEqual(["it posts twice"]);
    expect(t.rounds().changes["pr-40"].rounds[2].serious).toBe(1);
    const md = verdictsMd(r);
    expect(md).toContain("1. [serious: acts wrongly] it posts twice");
    expect(md).toContain("1. [follow-up: acts wrongly] it posts twice, but the second is harmless");
    expect(relayLine(r)).toContain("1 serious finding left, at its cap.");
  });

  test("label adherence is kept per seat and round, and review.sh health shows the parse rate", async () => {
    const t = rules({ openai: async () => said("approve_with_changes", "SERIOUS (acts wrongly): it posts twice", "it has no label") });
    const r = await t.round("l-1");
    expect(r.seats.find((s) => s.seat === "openai")!.labels).toEqual({ labelled: 1, total: 2 });
    const h = JSON.parse(readFileSync(t.cfg.healthFile, "utf8"));
    expect(h.labels.openai).toEqual([{ id: "l-1", round: 1, labelled: 1, total: 2, at: NOW.toISOString() }]);
    expect(labelRate(h.labels.openai)).toEqual({ labelled: 1, total: 2, rate: 0.5 });
    const out = t.cli("health");
    expect(out.stdout).toContain("Label parse rate");
    expect(out.stdout).toContain("OpenAI: 50% (1 of 2 over 1 round)");
    expect(out.stdout).not.toContain("Cut diff fetch");
  });
});

describe("4: the Ship card at the cap", () => {
  const FACTS = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "x", bumps: [{ app: "Cain", version: "0.20.0" }], merged: false };
  const at = new Date(NOV11_8AM - 10 * MIN).toISOString();
  const roundsWith = (serious: number, lastHead = SHA1) => ({ format: 1, changes: { "pr-5": { pr: PR, rounds: [1, 2, 3].map((n) => ({ id: `r-${n}`,
    at: `2026-11-1${n}`, kind: n === 1 ? "full" : "fixes", state: "answered", done: true, serious: n === 3 ? serious : 0, head: lastHead })) } } });
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

  test("refused at the cap with serious left, saying the piece is held by the rule", async () => {
    await expect(ship(shipRig(roundsWith(1), [r3()]), SHA1, "r-3")).rejects.toThrow("the piece is held by the owner's review rule: its last review round left something serious");
    const held: any = roundsWith(2);
    held.changes["pr-5"].decided = { choice: "hold", why: "the retry is the feature", at };
    await expect(ship(shipRig(held, [r3()]), SHA1, "r-3")).rejects.toThrow("Cain held it: the retry is the feature");
  });

  test("allowed with nothing serious left, bound to the head that round reviewed, and the tap lands it", async () => {
    const r = shipRig(roundsWith(0), [r3()]);
    const ok = await ship(r, SHA1, "r-3");
    expect(ok.status).toBe("posted");
    expect(r.state().messages[ok.message].ship).toMatchObject({ head: SHA1, bound: "clean" });
    await r.tap(snap(r.msg(ok.message)), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([{ pr: PR, head: SHA1 }]);
  });

  test("refused when the head moved, at the card", async () => {
    const r = shipRig(roundsWith(0), [r3(SHA2)]);
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r, SHA2, "r-3")).rejects.toThrow("the piece is held by the owner's review rule: only the head its last review round reviewed ships");
    const r2 = shipRig(roundsWith(0), [r3()]);
    r2.github.facts = { ...FACTS, head: SHA2 } as any;
    await expect(ship(r2, SHA1, "r-3")).rejects.toThrow(BOUND_MOVED);
  });

  test("refused when the head moved, at the owner's tap against GitHub's head", async () => {
    const r = shipRig(roundsWith(0), [r3()]);
    const ok = await ship(r, SHA1, "r-3");
    r.github.facts = { ...FACTS, head: SHA2 } as any;
    await r.tap(snap(r.msg(ok.message)), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toHaveLength(0);
    expect(String(r.msg(ok.message).content)).toContain(BOUND_TAP);
    expect(r.relayed.join("\n")).toContain("held by the owner's review rule");
  });

  test("the link's asks can't put a question about rounds, risk or cuts to him", async () => {
    const r = rig({ holds: keeperHolds({}) });
    for (const [text, opts] of [
      ["Want more review rounds for the calendar fix?", ["Yes", "No"]],
      ["Ship the calendar fix with that risk?", ["Ship", "Hold"]],
      ["Should I cut the parts the serious finding is about?", ["Cut", "Hold"]],
      ["The calendar fix has a serious finding left: ship or hold?", ["Ship", "Hold"]],
    ] as [string, string[]][]) await expect(r.link.ask({ text, options: opts, item: "P46", question: "Q1" })).rejects.toThrow("never ask him about rounds, risk or cuts");
    await expect(r.link.ask({ text: "Ready?", options: ["Ship it with that risk", "No"], item: "P46", question: "Q1" })).rejects.toThrow("there is no shipping with a risk named");
    expect(asksAboutCap("Should the dentist move to Thursday?")).toBeNull();
    expect(((await r.link.ask({ text: "Is the business-license packet filed?", options: ["Filed", "Not filed"], item: "P46", question: "Q1" })) as any).status).toBe("posted");
  });
});

describe("5: the owner's one line, in code", () => {
  test("clean: one line, and a repeat produces none", async () => {
    const t = rules();
    for (const id of ["n-1", "n-2", "n-3"]) await t.round(id);
    await t.runner.tick(); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["clean"]);
    expect(t.lines[0]).toMatchObject({ id: "pr-40#clean", topic: "Calendar retries" });
    expect(ownerLineText(t.lines[0])).toBe("Calendar retries: its last outside review round left nothing serious, so its Ship card follows.");
  });

  test("the cap reached with serious left: one line with the count and that Cain holds it", async () => {
    const t = await atCap();
    await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap"]);
    expect(ownerLineText(t.lines[0])).toBe("Calendar retries: its third and last outside review round left one serious finding, so Cain holds it.");
    const last = t.relays().filter((l) => l.includes("Review c-3 done")).pop()!;
    expect(last).toContain("1 serious finding left, at its cap.");
    expect(last).toContain("by the owner's rule pr-40 is held");
    expect(last).toContain("He hears one line from the link; ask him nothing about rounds, risk or cuts.");
    expect(last).not.toMatch(/cut check/);
  });

  test("a line is retried until the link confirms it, then sent once", async () => {
    let n = 0;
    const got: any[] = [];
    const t = rules({ postLine: async (l: any) => { got.push(l); return n++ < 2 ? null : "m-1"; } });
    for (const id of ["n-1", "n-2", "n-3"]) await t.round(id);
    await t.runner.tick(); await t.runner.tick(); await t.runner.tick();
    expect(got.length).toBe(3);
    expect(t.rounds().changes["pr-40"].lines!.clean).toMatchObject({ state: "sent", message: "m-1", tries: 2 });
  });

  test("an owed line persists across a runner restart and goes out at the next start", async () => {
    const tried: any[] = [];
    const t = await atCap({ postLine: async (l: any) => { tried.push(l); throw new Error("the runner stopped"); } });
    expect(t.rounds().changes["pr-40"].lines?.cap?.state).toBe("owed");
    const lines: any[] = [];
    const again = new Runner(t.cfg, { seats: {}, now: () => NOW, log: () => {}, postLine: async (l) => { lines.push(l); return "m-1"; } });
    await again.start();
    await again.start();
    expect(tried.map((l) => l.outcome)).toContain("cap");
    expect(lines.map((l) => l.outcome)).toEqual(["cap"]);
    expect(readRounds(t.cfg.roundsFile!)!.changes["pr-40"].lines?.cap).toMatchObject({ state: "sent", message: "m-1" });
  });

  test("undecided: one reminder to Cain after an hour, one line to him after a day, each once", async () => {
    const t = await atCap();
    const reminders = () => t.relays().filter((l) => l.includes("has no recorded decision"));
    t.later(30 * MIN); await t.runner.tick();
    expect(reminders()).toHaveLength(0);
    t.later(31 * MIN); await t.runner.tick(); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toContain('review.sh decide pr-40 hold "<why, in one line>"');
    t.later(24 * 3_600_000); await t.runner.tick(); await t.runner.tick();
    t.later(24 * 3_600_000); await t.runner.tick();
    expect(reminders()).toHaveLength(1);
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "undecided"]);
    expect(ownerLineText(t.lines[1])).not.toContain("?");
  });

  test("review.sh decide hold, end to end: the why is gated, the hold is kept under the change, and he hears one held line", async () => {
    const t = await atCap();
    // A why that asks him anything is refused with the gate's reason, by the command and by the runner.
    for (const why of ["Should I cut it?", "let me know if you want it kept", "want me to keep going with it"]) {
      const no = t.cli("decide", "pr-40", "hold", why);
      expect(no.status).toBe(3);
      expect(no.stderr).toContain("The message gate held this:");
    }
    t.decide({ change: "pr-40", choice: "hold", why: "want more review rounds" });
    await t.runner.tick();
    expect(t.relays().join("\n")).toContain("The message gate held this:");
    expect(t.rounds().changes["pr-40"].decided).toBeUndefined();
    expect(t.cli("decide", "pr-40", "cut").status).toBe(2);
    const ok = t.cli("decide", "pr-40", "hold", "the retry is the feature");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('"held: the retry is the feature"');
    await t.runner.tick();
    expect(t.rounds().changes["pr-40"].decided).toMatchObject({ choice: "hold", why: "the retry is the feature" });
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "held"]);
    expect(ownerLineText(t.lines[1])).toBe("Calendar retries, held: the retry is the feature.");
    // A hold is final: a second decision isn't kept, and no second held line goes.
    const again = t.cli("decide", "pr-40", "hold", "another reason");
    expect(again.status).toBe(3);
    expect(again.stderr).toContain("a hold is final");
    t.decide({ change: "pr-40", choice: "hold", why: "another reason" });
    await t.runner.tick(); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "held"]);
    expect(capStateFor(PRN(40), t.rounds(), 3)).toMatchObject({ state: "held" });
    // Decided: no reminder and no undecided line later.
    t.later(25 * 3_600_000); await t.runner.tick();
    expect(t.lines.map((l) => l.outcome)).toEqual(["cap", "held"]);
  });

  test("decide is refused for a change not at its cap, or one at its cap with nothing serious left", async () => {
    const t = rules({ openai: strict });
    await t.round("e-1");
    expect(t.cli("decide", "pr-40", "hold", "it would break the sync").stderr).toContain("isn't at its cap");
    const u = rules();
    for (const id of ["f-1", "f-2", "f-3"]) await u.round(id);
    expect(u.cli("decide", "pr-40", "hold", "it would break the sync").stderr).toContain("left nothing serious");
  });

  test("the link posts it through root's /review-line: its own words, no buttons, no Stop, no question, once per id", async () => {
    const r = rig({});
    const routes = linkRoutes({ link: r.link, toHarness: async () => true });
    const raw = JSON.stringify({ id: "pr-40#held", outcome: "held", topic: "Calendar retries", why: "the retry is the feature" });
    const mine = await routes(new Request("http://link/review-line", { method: "POST", body: raw }), new URL("http://link/review-line"), "cain", raw);
    expect(mine.status).not.toBe(200);
    expect(r.posts()).toBe(0);
    const res = await routes(new Request("http://link/review-line", { method: "POST", body: raw }), new URL("http://link/review-line"), "root", raw);
    const a = await res.json();
    expect(a.status).toBe("posted");
    expect(String(r.msg(a.message).content)).toBe("Calendar retries, held: the retry is the feature.");
    expect(r.msg(a.message).components ?? []).toEqual([]);
    const again = await r.link.reviewLine({ id: "pr-40#held", outcome: "held", topic: "Calendar retries", why: "the retry is the feature" });
    expect(again).toMatchObject({ duplicate: true, message: a.message });
    expect(r.posts()).toBe(1);
    await expect(r.link.reviewLine({ id: "pr-41#cut-pass", outcome: "cut-pass" })).rejects.toThrow("not a line from the review runner");
    for (const outcome of ["clean", "cap", "lost", "held", "undecided"]) expect(ownerLineText({ outcome, serious: 2 })).not.toMatch(/\?|cut/i);
  });
});

describe("6: the message gate holds a reply or edit that asks him about rounds, risk or cuts", () => {
  const send = (text: string) => decideSend({ tool: "reply", text }, null, {});
  test("a direct question is held, with the gate's reason and what to change", () => {
    const d = send("Want me to ask for two more review rounds for the calendar fix?");
    expect(d.would).toBe("refuse");
    expect(d.hard).toBe(true);
    expect(d.said.startsWith(HELD)).toBe(true);
    expect(d.said).toContain("never ask him about rounds, risk or cuts");
    expect(send("Should I ship it with that risk?").would).toBe("refuse");
    expect(decideSend({ tool: "edit", text: "Should I cut the parts the serious finding is about?", target: "1" }, null, {}).hits.some((h) => h.rule === "cap")).toBe(true);
  });
  test("a two-sentence question is held", () => {
    const d = send("The calendar fix has one serious finding left. Should I hold it or ship it?");
    expect(d.would).toBe("refuse");
    expect(d.said.startsWith(HELD)).toBe(true);
  });
  test("a paraphrased question is held", () => {
    for (const text of ["The review left something serious. Want me to keep going with it?", "want me to keep going with it?"])
      expect(send(text).would).toBe("refuse");
  });
  test("a plain held line and an ordinary question pass", () => {
    expect(send("The calendar fix, held: the retry is the feature.").would).toBe("pass");
    expect(send("Should the dentist move to Thursday?").would).toBe("pass");
  });
});

describe("7: the landing", () => {
  const REPO = "HyndeSyte/harness";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sh = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  // A bare repository stands in for GitHub; every git call the link makes is kept.
  function world() {
    const root = mkdtempSync(join(tmpdir(), "landhold-"));
    const origin = join(root, "origin.git"), work = join(root, "work"), link = join(root, "link.git");
    for (const [dir, bare] of [[origin, true], [work, false], [link, true]] as const)
      Bun.spawnSync(["git", "init", "--quiet", ...(bare ? ["--bare"] : []), "-b", "main", dir], { env });
    sh(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");
    sh(work, "config", "user.email", "t@example.com");
    sh(work, "config", "user.name", "t");
    const commit = (file: string) => { writeFileSync(join(work, file), file); sh(work, "add", "-A"); sh(work, "commit", "--quiet", "-m", file); return sh(work, "rev-parse", "HEAD"); };
    const m1 = commit("a");
    sh(work, "push", "--quiet", origin, "HEAD:refs/heads/main");
    const h1 = commit("b");
    sh(work, "push", "--quiet", origin, "HEAD:refs/pull/13/head");
    const runs = ["pytest", "bun", "pr"].map((name, i) => ({ id: i, name, status: "completed", conclusion: "success", app: { id: ACTIONS_APP } }));
    const calls: string[][] = [];
    const d: MergeDeps = {
      api: async (path) => path.endsWith("/pulls/13")
        ? { status: 200, body: { state: "open", merged: false, base: { ref: "main" }, head: { sha: h1, repo: { full_name: REPO } } } }
        : path.includes("/check-runs") ? (() => {
          const name = new URL(`http://x${path}`).searchParams.get("check_name");
          const mine = runs.filter((r) => r.name === name);
          return { status: 200, body: { total_count: mine.length, check_runs: mine } };
        })() : path.includes("/actions/runs?") ? { status: 200, body: { total_count: 0, workflow_runs: [] } } : { status: 404, body: null },
      git: async (args) => {
        calls.push(args);
        const p = Bun.spawn(["git", "-C", link, ...args], { stdout: "pipe", stderr: "pipe", env });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, out, err };
      },
      stopped: () => false,
      remote: () => origin,
    };
    return { d, origin, work, m1, h1, commit, calls };
  }

  test("the push refspec is exactly \"<bound sha>:refs/heads/main\", with no force flag and no plus", async () => {
    const w = world();
    expect(await land(w.d, { repo: REPO, pr: 13, head: w.h1 })).toEqual({ ok: true, already: false });
    const pushes = w.calls.filter((a) => a[0] === "push");
    expect(pushes).toHaveLength(1);
    const p = pushes[0];
    expect(p[p.length - 1]).toBe(`${w.h1}:refs/heads/main`);
    expect(pushRefspec(w.h1)).toBe(`${w.h1}:refs/heads/main`);
    expect(p.some((a) => a.startsWith("+"))).toBe(false);
    expect(p.some((a) => /^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror|--delete|-d)$/.test(a))).toBe(false);
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/link/merge.ts"), "utf8")).not.toMatch(/"push"[^\n]*(--force|"-f"|"\+)/);
  }, 60_000);

  test("a fake remote whose main advances just before the push: git refuses it, and the landing says main moved", async () => {
    const v = world();
    let moved = "";
    v.d.stopped = () => {
      if (!moved) {
        sh(v.work, "checkout", "--quiet", "-b", "late", v.m1);
        moved = v.commit("late");
        sh(v.work, "push", "--quiet", v.origin, "HEAD:refs/heads/main");
      }
      return false;
    };
    const late = await land(v.d, { repo: REPO, pr: 13, head: v.h1 });
    expect(late).toMatchObject({ ok: false, again: false, mainMoved: true });
    expect(sh(v.origin, "rev-parse", "refs/heads/main")).toBe(moved);
  }, 60_000);

  test("on his Ship card the rejection reads \"main moved; the change wasn't landed\", once", async () => {
    const r = rig({ facts: true });
    r.github.facts = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "x", bumps: [{ app: "Cain", version: "0.20.0" }], merged: false } as any;
    r.reviews.list = [{ id: "r-3", line: "Reviewed: OpenAI, approve.", finished_at: new Date(NOV11_8AM - 10 * MIN).toISOString(), pr: PR, head: SHA1 }];
    const ok = await r.link.ship({ text: "Cards keep their place.", item: "P64", pr: PR, head: SHA1, review: "r-3" });
    r.github.answers.push({ ok: false, why: "main moved on while it was landing: the branch needs main merged in, then a new Ship card", again: false, mainMoved: true });
    const before = r.relayed.length;
    await r.tap(JSON.parse(JSON.stringify(r.msg(ok.message))), r.ids(ok.message)[0]);
    await r.link.whenLanded();
    await r.link.sweep();
    expect(MAIN_MOVED_LINE).toBe("main moved; the change wasn't landed");
    const content = String(r.msg(ok.message).content);
    expect(content).toContain(MAIN_MOVED_LINE);
    expect(content.split(MAIN_MOVED_LINE).length - 1).toBe(1);
    expect(r.github.main).toEqual([]);
    const said = r.relayed.slice(before).filter((l) => l.includes("main moved after the checks"));
    expect(said).toHaveLength(1);
  });
});
