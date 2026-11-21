// Cain 0.18.0: extra review rounds for a change, granted by the owner's tap (review/grants.ts, the runner's
// round count, link/core.ts reviewGrant and its tap, link/cap.ts capStateFor, review.sh status and spend).
// The rule stays: three outside review rounds a change. The only way past it is his tap on Cain's grant
// card, which raises that change's cap by exactly the rounds it names; a grant never exempts the change
// from the rule or from the armed-rollback condition on shipping with a risk named.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roundLine, type Brief } from "../rootfs/opt/cain/review/core.ts";
import { DEFAULTS, Runner, loadReview, type RunnerConfig } from "../rootfs/opt/cain/review/runner.ts";
import { admit, countedRounds, decisionOf, emptyRounds, readRounds, type DecisionRec, type Rounds } from "../rootfs/opt/cain/review/rounds.ts";
import { capWords, effectiveCap, emptyGrants, grantWords, readGrants, recordGrant, GRANTS_OWNER, GrantUnsaved, type GrantRec, type Grants } from "../rootfs/opt/cain/review/grants.ts";
import type { SeatAnswer, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { HOLD, RISK, capStateFor } from "../rootfs/opt/cain/link/cap.ts";
import { CAIN_ROUTES, ROOT_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth.ts";
import { GRANT_REPLACED, GRANT_UNSAVED, grantLabel } from "../rootfs/opt/cain/link/core.ts";
import { capFileRules } from "../rootfs/opt/cain/capfiles.ts";
import { DAY, keeperHolds, rig } from "./link-rig";

const NOW = new Date("2026-11-21T17:50:00Z");          // Nov 21, 12:50 PM in New York
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-21-keeper-a", topic: "The rollback keeper", question: "Is this sound?", body: "Keep a way back.",
  needs_facts: false, consequential: false, seats: ["gemini"], pr: PRN(46), label: "necessary-fix", item: "P46", ...over,
});
const finding = (problem: string) => ({ rank: 1, problem, fix: "fix it" });
const answerWith = (...problems: string[]) => async (): Promise<SeatAnswer> =>
  ({ verdict: problems.length ? "approve_with_changes" : "approve", findings: problems.map(finding), model: "m", cost_usd: 0.01 });
// Tests don't run as root: the grants file is made with their own uid and gid (the link uses root:cain).
const OWN = { uid: process.getuid!(), gid: process.getgid!() };
const grantRec = (key: string, rounds: number, over: Partial<GrantRec> = {}): GrantRec =>
  ({ id: `${key}+1${rounds}`, key, rounds, by: "owner", at: NOW.toISOString(), message: `1${rounds}`, reason: "The rollback keeper", item: "P46", pr: null, ...over });

function runnerRig(o: { seat?: (i: SeatInput) => Promise<SeatAnswer> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grant-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"),
    roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json"), grantsFile: join(dir, "grants.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const posted: DecisionRec[] = [];
  let seat = o.seat ?? answerWith("SERIOUS: the keeper can lose the way back");
  const runner = new Runner(cfg, { seats: { gemini: async (i) => seat(i) }, now: () => NOW, rand: () => 0.5, log: () => {},
    postDecision: async (d) => { posted.push(d); return `m-${posted.length}`; } });
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  return { dir, cfg, runner, posted, relays, setSeat: (f: typeof seat) => { seat = f; },
    rounds: () => readRounds(cfg.roundsFile!)!, grants: () => readGrants(cfg.grantsFile!),
    grant: (key: string, n: number, over: Partial<GrantRec> = {}) => recordGrant(cfg.grantsFile!, grantRec(key, n, over), { sync: () => {}, owner: OWN }),
    get: (id: string) => loadReview(cfg.queueDir, id)! };
}
async function threeRounds(t: ReturnType<typeof runnerRig>, over: Partial<Brief> = {}) {
  for (const id of ["k-1", "k-2", "k-3"]) { expect(t.runner.admitAndQueue(brief({ id, ...over }))).toBeNull(); await t.runner.tick(); }
}

describe("the grant raises the cap by exactly the rounds it names", () => {
  test("effectiveCap is 3 plus the sum of the change's grants; admit honours it, as fix-only rounds", () => {
    const r = emptyRounds();
    r.changes["pr-46"] = { rounds: [1, 2, 3].map((n) => ({ id: `x-${n}`, at: `2026-11-2${n - 1}T00:00:00Z`, kind: (n === 1 ? "full" : "fixes") as any, state: "answered" as const })) };
    const g: Grants = emptyGrants();
    expect(effectiveCap(3, r, g, "pr-46")).toBe(3);
    expect(admit(r, brief({ id: "a-4" }), 3, g)).toMatchObject({ ok: false });
    g.grants.push(grantRec("pr-46", 2));
    expect(effectiveCap(3, r, g, "pr-46")).toBe(5);
    expect(admit(r, brief({ id: "a-4" }), 3, g)).toMatchObject({ ok: true, round: 4, cap: 5, kind: "fixes" });
    expect(admit(r, brief({ id: "a-4", round_kind: "full" }), 3, g)).toMatchObject({ ok: false });
    g.grants.push(grantRec("pr-46", 1, { id: "pr-46+99" }));
    expect(effectiveCap(3, r, g, "pr-46")).toBe(6);
    // A grant for another change raises nothing here; unreadable grants count as none.
    expect(effectiveCap(3, r, { format: 1, grants: [grantRec("pr-47", 3)] }, "pr-46")).toBe(3);
    expect(effectiveCap(3, r, null, "pr-46")).toBe(3);
  });

  test("a fourth round is refused without a grant, saying how a grant works, and runs as fix-only with one", async () => {
    const t = runnerRig();
    await threeRounds(t);
    const why = t.runner.admitAndQueue(brief({ id: "k-4" }))!;
    expect(why).toContain("pr-46 has had 3 outside review rounds, and the owner's rule allows at most 3.");
    expect(why).toContain("keeper.sh review-grant");
    expect(why).toContain("only the owner's tap on that card grants them");
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    t.grant("pr-46", 2);
    expect(t.runner.admitAndQueue(brief({ id: "k-4" }))).toBeNull();
    expect(t.get("k-4")).toMatchObject({ change: "pr-46", round: 4, cap: 5, base_cap: 3, round_kind: "fixes" });
    expect(t.get("k-4").earlier?.length).toBeGreaterThan(0);                  // the earlier findings go with it, as today
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "k-5" }))).toBeNull();
    await t.runner.tick();
    const sixth = t.runner.admitAndQueue(brief({ id: "k-6" }))!;
    expect(sixth).toContain("has had 5 outside review rounds, and the owner's rule allows at most 3, plus 2 granted by Dane on Nov 21, so 5.");
    expect(countedRounds(t.rounds(), "pr-46").length).toBe(5);
  });

  test("superseding carries the grants over with the rounds, either way", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    // The fix moves to pull request 48, superseding 46: the grant counts for the group.
    expect(t.runner.admitAndQueue(brief({ id: "s-4", pr: PRN(48), supersedes: PRN(46) }))).toBeNull();
    expect(t.get("s-4")).toMatchObject({ change: "pr-48", round: 4, cap: 4 });
    await t.runner.tick();
    expect(t.runner.admitAndQueue(brief({ id: "s-5", pr: PRN(48) }))).toContain("has had 4");
    // A grant made for the new key counts for the old one too.
    t.grant("pr-48", 1);
    expect(effectiveCap(3, t.rounds(), t.grants(), "pr-46")).toBe(5);
    expect(t.runner.admitAndQueue(brief({ id: "s-5b", pr: PRN(46) }))).toBeNull();
  });

  test("the grants file: kept whole, root:cain 0640 kept, one per card, never written over when it doesn't parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "grants-file-"));
    const f = join(dir, "review-grants.json");
    writeFileSync(f, JSON.stringify(emptyGrants()), { mode: 0o640 });
    const a = recordGrant(f, grantRec("pr-46", 2), { sync: () => {}, owner: OWN });
    expect(a.existed).toBe(false);
    expect(recordGrant(f, grantRec("pr-46", 3, { id: "pr-46+12" }), { sync: () => {}, owner: OWN })).toMatchObject({ existed: true, rec: { rounds: 2 } });   // the same card: its first grant
    expect(readGrants(f)!.grants.length).toBe(1);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    writeFileSync(f, "{not json");
    expect(readGrants(f)).toBeNull();
    expect(() => recordGrant(f, grantRec("pr-46", 1, { id: "pr-46+2" }), { sync: () => {}, owner: OWN })).toThrow(GrantUnsaved);
    expect(readFileSync(f, "utf8")).toBe("{not json");
    expect(readGrants(join(dir, "none.json"))).toEqual(emptyGrants());
    // Out of range in the file: not trusted.
    writeFileSync(f, JSON.stringify({ format: 1, grants: [grantRec("pr-46", 9)] }));
    expect(readGrants(f)).toBeNull();
    // The install-time self-check knows it: root:cain 0640, optional.
    expect(capFileRules().find((x) => x.path.endsWith("review-grants.json"))).toMatchObject({ uid: 0, gid: 1000, mode: 0o640, optional: true });
  });
});

// ---- The card ----
function linkRig(rounds: Rounds, grants: Grants | null, o: { holds?: Record<string, any> } = {}) {
  const r = rig({ holds: keeperHolds(o.holds ?? {}) });
  const written: GrantRec[] = [];
  const decided: [string, string][] = [];
  const box = { rounds, grants, fail: false };
  Object.assign((r.link as any).d, {
    rounds: () => box.rounds, grants: () => box.grants, roundCap: () => 3,
    grant: (rec: GrantRec) => {
      if (box.fail) throw new GrantUnsaved("disk full");
      const had = written.find((x) => x.id === rec.id);
      if (had) return { rec: had, existed: true };
      written.push(rec);
      box.grants = { format: 1, grants: [...(box.grants?.grants ?? []), rec] };
      return { rec, existed: false };
    },
    decided: (id: string, choice: string) => { decided.push([id, choice]); return { choice, at: 0, existed: false }; },
  });
  return { r, written, decided, box };
}
const atCap = (serious = 2, state: "answered" | "lost" | "started" = "answered"): Rounds => {
  const r = emptyRounds();
  r.changes["pr-46"] = { pr: PRN(46), topic: "The rollback keeper", rounds: [1, 2, 3].map((n) => ({ id: `x-${n}`, at: `2026-11-2${n - 1}T00:00:00Z`,
    kind: (n === 1 ? "full" : "fixes") as any, state: n < 3 ? "answered" as const : state, ...(n === 3 && state === "answered" ? { serious } : {}) })) };
  return r;
};
const ask = (r: ReturnType<typeof rig>, over: Record<string, unknown> = {}) => r.link.reviewGrant({ item: "P46", change: PRN(46), rounds: 2,
  text: "The rollback keeper, which gives every install a way back", ...over });

describe("Cain's command posts a card; only the owner's tap writes the grant", () => {
  test("the card names the change and the runner's own count, with Grant <n> more rounds and No", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const res = await ask(t.r);
    expect(res.status).toBe("posted");
    const id = (res as any).message;
    expect(t.r.buttons(id)).toEqual(["Grant 2 more rounds", "No"]);
    const text = String(t.r.msg(id).content);
    expect(text).toContain("The rollback keeper, which gives every install a way back (pull request 46).");
    expect(text).toContain("It has used all 3 of its outside review rounds, and its last round still left 2 serious findings.");
    expect(text).toContain("Grant it 2 more fix rounds, for 5 in all?");
    expect(text).toContain("it never exempts the change from the rule, and shipping it with a risk named still needs the App's rollback armed");
    expect(t.r.state().messages[id]).toMatchObject({ kind: "ask", item: "P46", grant: { key: "pr-46", rounds: 2, pr: PRN(46) } });
    // Cain's command wrote nothing.
    expect(t.written).toEqual([]);
    expect(grantLabel(1)).toBe("Grant 1 more round");
  });

  test("the count is the runner's, never Cain's words; a lost last round is said so", async () => {
    const t = linkRig(atCap(1), emptyGrants());
    const id = ((await ask(t.r, { text: "The rollback keeper, its last round found nothing serious" })) as any).message;
    expect(String(t.r.msg(id).content)).toContain("its last round still left one serious finding");
    const u = linkRig(atCap(0, "lost"), emptyGrants());
    const id2 = ((await ask(u.r)) as any).message;
    expect(String(u.r.msg(id2).content)).toContain("its last round did not complete");
  });

  test("his Grant tap writes exactly that grant, once, and Cain hears the new cap", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    await t.r.tap(t.r.msg(id), t.r.ids(id)[0]);
    expect(t.written).toEqual([expect.objectContaining({ id: `pr-46+${id}`, key: "pr-46", rounds: 2, by: "owner", message: id, item: "P46", pr: PRN(46),
      reason: "The rollback keeper, which gives every install a way back" })]);
    expect(t.decided).toEqual([[`grant:pr-46:${id}`, "Grant 2 more rounds"]]);         // beside his other taps
    const line = t.r.relayed.find((l) => l.includes('Dane tapped "Grant 2 more rounds"'))!;
    expect(line).toContain("He granted pr-46 2 more fix rounds. Its cap is now 5.");
    expect(t.r.logs.join("\n")).toContain("Dane granted 2 more review rounds for pr-46");
    expect(String(t.r.msg(id).content)).toContain("You answered: Grant 2 more rounds");
    // A second tap on the same card: dead, nothing more written.
    await t.r.tap(t.r.msg(id), t.r.ids(id)[0] ?? `q:x:0`);
    expect(t.written.length).toBe(1);
  });

  test("No writes nothing; a grant that can't be kept leaves the card up and tells him", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    await t.r.tap(t.r.msg(id), t.r.ids(id)[1]);
    expect(t.written).toEqual([]);
    expect(t.r.relayed.join("\n")).toContain("No rounds were granted: pr-46 stays at its cap.");
    const u = linkRig(atCap(2), emptyGrants());
    u.box.fail = true;
    const id2 = ((await ask(u.r)) as any).message;
    expect(await u.r.tap(u.r.msg(id2), u.r.ids(id2)[0])).toBe("unsaved");
    expect(u.r.ephemerals().map((e: any) => e.content)).toContain(GRANT_UNSAVED);
    expect(u.r.state().messages[id2].q?.used).toBe(false);
    u.box.fail = false;
    await u.r.tap(u.r.msg(id2), u.r.ids(id2)[0]);
    expect(u.written.length).toBe(1);
  });

  test("it expires at the next morning check-in like his asks; a tap after that does nothing", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    const exp = t.r.state().messages[id].expires!;
    expect(exp).toBeGreaterThan(t.r.t.now);
    expect(exp - t.r.t.now).toBeLessThanOrEqual(DAY + 2 * 3_600_000);
    t.r.later(exp - t.r.t.now + 1);
    await t.r.tap(t.r.msg(id), t.r.ids(id)[0]);
    expect(t.written).toEqual([]);
  });

  test("refused while the change has rounds left, its last round runs, the item is held elsewhere, or Stop holds", async () => {
    const left = emptyRounds();
    left.changes["pr-46"] = { rounds: [{ id: "x-1", at: "2026-11-20T00:00:00Z", kind: "full", state: "answered" }] };
    await expect(ask(linkRig(left, emptyGrants()).r)).rejects.toThrow("has rounds left (1 of 3 used): nothing to grant");
    // Granted already and not used yet: still rounds left.
    await expect(ask(linkRig(atCap(2), { format: 1, grants: [grantRec("pr-46", 1)] }).r)).rejects.toThrow("has rounds left (3 of 4 used)");
    await expect(ask(linkRig(atCap(0, "started"), emptyGrants()).r)).rejects.toThrow("hasn't finished yet");
    await expect(ask(linkRig(emptyRounds(), emptyGrants()).r)).rejects.toThrow("no review round yet");
    await expect(ask(linkRig(atCap(2), emptyGrants(), { holds: { P46: { holder: "laptop:abc" } } }).r)).rejects.toThrow("held by another session");
    const s = linkRig(atCap(2), emptyGrants());
    s.r.stop.stopped = true; s.r.stop.at = s.r.t.now;
    await expect(ask(s.r)).rejects.toThrow("Everything is stopped");
    await expect(ask(linkRig(atCap(2), emptyGrants()).r, { rounds: 4 })).rejects.toThrow("rounds must be 1 to 3");
    await expect(ask(linkRig(atCap(2), emptyGrants()).r, { item: "none" })).rejects.toThrow("PENDING id");
    await expect(ask(linkRig(atCap(2), null).r)).rejects.toThrow("grants file can't be read");
  });

  test("only Cain's key reaches the route, and it isn't root's decision route", () => {
    expect(CAIN_ROUTES.has("/review-grant")).toBe(true);
    expect(routeAllowed("cain", "/review-grant")).toBe(true);
    expect(routeAllowed("specialist", "/review-grant")).toBe(false);
    expect(ROOT_ROUTES.has("/review-grant")).toBe(false);
  });

  test("the grant card neither waits behind his open ask nor holds it back", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    expect((await t.r.link.ask({ text: "Is the packet filed?", options: ["Filed", "Not filed"], item: "none" })).status).toBe("posted");
    expect((await ask(t.r)).status).toBe("posted");
    expect((await t.r.link.ask({ text: "Is the desk ordered?", options: ["Ordered", "Not ordered"], item: "none", question: "Q3" })).status).toBe("held");
  });
});

describe("the runner honours the grant, and the decision card comes again", () => {
  test("a granted round that still leaves something serious at the raised cap owes a new decision card, after a Hold too", async () => {
    const t = runnerRig();
    await threeRounds(t);
    expect(t.posted.map((d) => d.id)).toEqual(["pr-46#3"]);
    // He held it; then granted one more round. The Hold doesn't stop the granted round.
    t.grant("pr-46", 1);
    expect(t.runner.admitAndQueue(brief({ id: "k-4" }))).toBeNull();
    await t.runner.tick(); await t.runner.tick();
    expect(t.posted.map((d) => d.id)).toEqual(["pr-46#3", "pr-46#4"]);
    expect(t.posted[1]).toMatchObject({ round: 4, serious: 1, item: "P46" });
    const rounds = t.rounds();
    expect(decisionOf(rounds, "pr-46")).toMatchObject({ id: "pr-46#4", state: "posted" });
    expect(rounds.changes["pr-46"].past?.map((d) => d.id)).toEqual(["pr-46#3"]);
    // The Ship card follows the newest decision: open until he taps it.
    expect(capStateFor(PRN(46), rounds, { "pr-46#3": { choice: HOLD, at: 1 } })).toMatchObject({ state: "waiting", decision: { id: "pr-46#4" } });
    expect(capStateFor(PRN(46), rounds, { "pr-46#3": { choice: HOLD, at: 1 }, "pr-46#4": { choice: RISK, at: 2 } })).toMatchObject({ state: "risk" });
  });

  test("no new card while granted rounds are left; a granted round that leaves nothing serious clears the Hold for the Ship card", async () => {
    const t = runnerRig();
    await threeRounds(t);
    const held = { "pr-46#3": { choice: HOLD, at: 1 } };
    expect(capStateFor(PRN(46), t.rounds(), held)).toMatchObject({ state: "hold" });
    t.grant("pr-46", 2);
    t.runner.admitAndQueue(brief({ id: "k-4" }));
    expect(capStateFor(PRN(46), t.rounds(), held)).toMatchObject({ state: "pending", why: expect.stringContaining("still running") });
    await t.runner.tick(); await t.runner.tick();
    expect(t.posted.length).toBe(1);                                            // round 4 of 5 still serious: no card yet
    expect(capStateFor(PRN(46), t.rounds(), held)).toMatchObject({ state: "pending", why: expect.stringContaining("still left something serious") });
    t.setSeat(answerWith("FOLLOW-UP: a wording nit"));
    t.runner.admitAndQueue(brief({ id: "k-5" }));
    await t.runner.tick(); await t.runner.tick();
    expect(t.posted.length).toBe(1);
    expect(capStateFor(PRN(46), t.rounds(), held)).toEqual({ state: "none" });
  });

  test("the Ship card is refused while a granted round hasn't settled clean, and the risk tap still needs the rollback armed", async () => {
    const decision = { id: "pr-5#4", key: "pr-5", round: 4, serious: 1, topic: "t", finding: "f", item: null, pr: "https://github.com/HyndeSyte/harness/pull/5", state: "posted" as const, at: "x" };
    const r = rig({ holds: keeperHolds({}) });
    Object.assign((r.link as any).d, { capState: () => ({ state: "pending", key: "pr-5", decision, why: "a granted review round after his decision is still running" }) });
    await expect(r.link.ship({ text: "A way back for every install.", item: "none", pr: decision.pr, head: "1".repeat(40) })).rejects.toThrow("still running: no Ship card");
    Object.assign((r.link as any).d, { capState: () => ({ state: "risk", key: "pr-5", decision }), armed: () => null });
    await expect(r.link.ship({ text: "A way back for every install.", item: "none", pr: decision.pr, head: "1".repeat(40) })).rejects.toThrow("rollback armed");
  });
});

describe("the record for Cain shows the effective cap and the grants", () => {
  test("the relay's round line and review.sh status and spend", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 2);
    t.runner.admitAndQueue(brief({ id: "k-4" }));
    await t.runner.tick();
    const line = roundLine(t.get("k-4"))!;
    expect(line).toBe("Round 4 of 5, 2 granted by Dane on Nov 21, for pr-46 (fix-only): 1 serious finding left.");
    expect(t.relays().find((l) => l.startsWith("Review k-4 done"))).toContain("Round 4 of 5, 2 granted by Dane on Nov 21");
    expect(capWords(4, 3, t.grants()!.grants)).toBe("round 4 of 5, 2 granted by Dane on Nov 21");
    expect(grantWords([grantRec("a", 1), grantRec("a", 2, { at: "2026-11-23T15:00:00Z" })])).toBe("3 granted by Dane (Nov 21, Nov 23)");
    const env = { ...process.env, REVIEW_QUEUE: t.cfg.queueDir, REVIEW_SPEND: t.cfg.spendFile, REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: t.cfg.settingsFile,
      REVIEW_GRANTS: t.cfg.grantsFile, CAIN_HOME: join(t.dir, "home"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"), CAIN_TEST_MODE: "1" };
    mkdirSync(join(t.dir, "home"), { recursive: true });
    const cli = (...a: string[]) => spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), ...a], { encoding: "utf8", env });
    expect(cli("status", "k-4").stdout).toContain("pr-46: round 4 of 5, 2 granted by Dane on Nov 21 (fix-only)");
    expect(cli("spend").stdout).toContain("pr-46: 4 of 5 rounds (2 granted by Dane on Nov 21)");
  });
});

describe("keeper.sh review-grant", () => {
  const ready = !!Bun.which("bash") && !!Bun.which("jq") && !!Bun.which("curl");
  test.skipIf(!ready)("reaches /review-grant with Cain's key, and checks its flags before sending", async () => {
    const { createHmac } = await import("node:crypto");
    const TOKEN = "not-a-real-token.for-the-grant-test";
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["4242"], groups: {} }));
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const seen: { path: string; keyed: boolean; body: any }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, keyed: req.headers.get("x-harness-key") === key, body: JSON.parse(await req.text()) });
      return Response.json({ status: "posted", message: "1" });
    } });
    const env = { ...process.env, CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_DIR: dir, CAIN_MODE_FILE: join(dir, "no-mode") };
    const keeper = async (...args: string[]) => {
      const p = Bun.spawn(["bash", join(import.meta.dir, "../rootfs/opt/cain/keeper.sh"), ...args], { env, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      return { code: await p.exited, out };
    };
    try {
      expect((await keeper("review-grant", "--item", "P46", "--change", PRN(46), "--rounds", "2", "The rollback keeper")).code).toBe(0);
      expect(seen).toEqual([{ path: "/review-grant", keyed: true, body: { item: "P46", change: PRN(46), rounds: 2, text: "The rollback keeper" } }]);
      expect(await keeper("review-grant", "--item", "P46", "--change", PRN(46), "--rounds", "4", "x")).toMatchObject({ code: 2 });
      expect(await keeper("review-grant", "--item", "P46", "--rounds", "1", "x")).toMatchObject({ code: 2 });
      expect(await keeper("review-grant", "--item", "P46", "--change")).toMatchObject({ code: 2 });
      expect(seen.length).toBe(1);
    } finally { server.stop(true); }
  }, 30_000);
});

// ---- First review of 0.18.0: the tap checks again, one open card a change, the file stays readable ----
describe("his Grant tap checks everything again before it writes", () => {
  const tapGrant = async (t: ReturnType<typeof linkRig>, id: string) => t.r.tap(t.r.msg(id), t.r.ids(id)[0]);
  const refusedBy = async (change: (t: ReturnType<typeof linkRig>) => void, line: string) => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    change(t);
    expect(await tapGrant(t, id)).toBe(`refused: ${line}`);
    expect(t.written).toEqual([]);                                             // nothing written
    expect(t.r.ephemerals().map((e: any) => e.content)).toContain(`${line}.`);  // one plain line to him
    expect(t.r.buttons(id)).toEqual([]);                                        // the card's buttons off
    expect(String(t.r.msg(id).content)).toContain("Nothing was granted: ");
    expect(t.r.state().messages[id]).toMatchObject({ outcome: "expired", buttons: false, q: { used: true } });
    expect(t.r.relayed.join("\n")).toContain(`but nothing was granted: ${line}`);
    // A second tap does nothing more.
    await tapGrant(t, id);
    expect(t.written).toEqual([]);
    return t;
  };

  test("the change has rounds left now (a grant from elsewhere raised its cap)", async () => {
    await refusedBy((t) => { t.box.grants = { format: 1, grants: [grantRec("pr-46", 1, { id: "pr-46+other" })] }; },
      "That change has rounds left now, so this grant isn't needed");
  });

  test("a round is running now", async () => {
    await refusedBy((t) => { t.box.rounds = atCap(0, "started"); }, "That change has a review round running now, so this grant can't be written");
  });

  test("its item is held by another session now, or closed", async () => {
    await refusedBy((t) => { t.r.files.holds = keeperHolds({ P46: { holder: "laptop:abc" } }); },
      "That change is being worked on by another session now, so this grant can't be written");
  });

  test("Stop holds", async () => {
    await refusedBy((t) => { t.r.stop.stopped = true; t.r.stop.at = t.r.t.now; },
      "Everything is stopped, so this grant can't be written until you tap Turn back on");
  });

  test("the round count or cap no longer matches what the card was posted on", async () => {
    // A fourth round counted since (granted and answered elsewhere): still at its cap, but not the card's count.
    const moved = () => {
      const r = atCap(2);
      r.changes["pr-46"].rounds.push({ id: "x-4", at: "2026-11-21T10:00:00Z", kind: "fixes" as any, state: "answered", serious: 1 });
      return r;
    };
    await refusedBy((t) => { t.box.rounds = moved(); t.box.grants = { format: 1, grants: [grantRec("pr-46", 1, { id: "pr-46+other" })] }; },
      "That change's review rounds have moved on since this card went up, so this grant can't be written");
  });

  test("unreadable records write nothing", async () => {
    await refusedBy((t) => { t.box.grants = null; }, "The review records can't be read right now, so this grant can't be written");
  });

  test("No still writes nothing and needs no checks", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    t.box.grants = { format: 1, grants: [grantRec("pr-46", 1, { id: "pr-46+other" })] };
    expect(await t.r.tap(t.r.msg(id), t.r.ids(id)[1])).toBe("to Cain");
    expect(t.written).toEqual([]);
  });
});

describe("one open grant card a change key", () => {
  test("a second card for the same key is refused, naming the open card's time; once it's answered a new one can go", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    await expect(ask(t.r, { rounds: 1, text: "The rollback keeper, one more round" })).rejects.toThrow(`a grant card for pr-46 is already open (posted at 8:00 AM, Discord message ${id})`);
    expect(t.r.cards().filter((c: any) => String(c.content).includes("Grant it")).length).toBe(1);
    await t.r.tap(t.r.msg(id), t.r.ids(id)[1]);                               // No
    expect((await ask(t.r, { rounds: 1, text: "The rollback keeper, one more round" })).status).toBe("posted");
  });

  test("a grant written takes the buttons off every other open grant card for the change", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    // An older open card for the same change (one from before this rule, say): filed under it after the second went up.
    const s = t.r.state(); s.messages[a].grant!.key = "pr-other"; t.r.setState(s);
    t.r.later(60_000);
    const b = ((await ask(t.r, { rounds: 1, text: "The rollback keeper, one more round" })) as any).message;
    const s2 = t.r.state(); s2.messages[a].grant!.key = "pr-46"; s2.messages[a].outcome = undefined; s2.messages[a].buttons = true; t.r.setState(s2);
    expect(await t.r.tap(t.r.msg(b), t.r.ids(b)[0])).toBe("to Cain");
    expect(t.written.map((w) => w.id)).toEqual([`pr-46+${b}`]);
    expect(t.r.state().messages[a]).toMatchObject({ outcome: "replaced", why: GRANT_REPLACED, buttons: false });
    expect(t.r.buttons(a)).toEqual([]);
    expect(String(t.r.msg(a).content)).toContain(GRANT_REPLACED);
    // A tap on the replaced card writes nothing.
    await t.r.tap(t.r.msg(a), `q:x:0`);
    expect(t.written.length).toBe(1);
  });
});

describe("the grants file stays root:cain 0640, readable by Cain's user", () => {
  const cainReads = (f: string) => {
    const st = statSync(f);
    expect(st.mode & 0o777).toBe(0o640);
    expect(st.mode & 0o040).toBe(0o040);                                       // group (cain) reads
    expect(st.mode & 0o022).toBe(0);                                           // no one but the owner writes
    expect(st.gid).toBe(OWN.gid);
    expect(st.uid).toBe(OWN.uid);
    accessSync(f, constants.R_OK);
    expect(readGrants(f)).not.toBeNull();
  };
  test("a write with the file there, one after it was removed, and one over a file left too open", () => {
    const dir = mkdtempSync(join(tmpdir(), "grants-mode-"));
    const f = join(dir, "review-grants.json");
    const old = process.umask(0o077);                                          // a strict umask can't make it root-only
    try {
      writeFileSync(f, JSON.stringify(emptyGrants()), { mode: 0o600 });
      recordGrant(f, grantRec("pr-46", 1, { id: "pr-46+1" }), { sync: () => {}, owner: OWN });
      cainReads(f);
      rmSync(f);
      recordGrant(f, grantRec("pr-46", 1, { id: "pr-46+2" }), { sync: () => {}, owner: OWN });
      cainReads(f);
      expect(readGrants(f)!.grants.map((g) => g.id)).toEqual(["pr-46+2"]);
      writeFileSync(f, readFileSync(f)); require("node:fs").chmodSync(f, 0o666);
      recordGrant(f, grantRec("pr-46", 1, { id: "pr-46+3" }), { sync: () => {}, owner: OWN });
      cainReads(f);
    } finally { process.umask(old); }
    expect(GRANTS_OWNER).toEqual({ uid: 0, gid: 1000, mode: 0o640 });
  });
  test("an owner that can't be set writes nothing (never a file of the wrong owner)", () => {
    if (process.getuid!() === 0) return;                                       // root may chown to anyone
    const dir = mkdtempSync(join(tmpdir(), "grants-owner-"));
    const f = join(dir, "review-grants.json");
    expect(() => recordGrant(f, grantRec("pr-46", 1), { sync: () => {} })).toThrow(GrantUnsaved);
    expect(existsSync(f)).toBe(false);
    expect(require("node:fs").readdirSync(dir)).toEqual([]);
  });
});
