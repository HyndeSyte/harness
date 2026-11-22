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
import { DEFAULTS, PRE_GRANTS, PRE_ROUNDS, Runner, loadReview, type RunnerConfig, type RunnerDeps } from "../rootfs/opt/cain/review/runner.ts";
import { admit, countedRounds, decisionOf, emptyRounds, readRounds, type DecisionRec, type OwedNotice, type Rounds } from "../rootfs/opt/cain/review/rounds.ts";
import { capWords, effectiveCap, emptyGrants, grantWords, readGrants, recordGrant, standing, staleWords, GRANTS_OWNER, GrantUnsaved, type GrantRec, type Grants } from "../rootfs/opt/cain/review/grants.ts";
import type { SeatAnswer, SeatInput } from "../rootfs/opt/cain/review/seats/common.ts";
import { HOLD, RISK, capStateFor } from "../rootfs/opt/cain/link/cap.ts";
import { CAIN_ROUTES, ROOT_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth.ts";
import { GRANT_REPLACED, GRANT_UNSAVED, grantLabel, grantRetry, REPLACED } from "../rootfs/opt/cain/link/core.ts";
import { capFileRules } from "../rootfs/opt/cain/capfiles.ts";
import { classify, type HostFail } from "../rootfs/opt/cain/pullnow.ts";
import { DAY, keeperHolds, rig } from "./link-rig";

const NOW = new Date("2026-11-21T17:50:00Z");          // Nov 21, 12:50 PM in New York
const PRN = (n: number) => `https://github.com/HyndeSyte/harness/pull/${n}`;
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "2026-11-21-keeper-a", topic: "The rollback keeper", question: "Is this sound?", body: "Keep a way back.",
  needs_facts: false, consequential: false, seats: ["gemini"], pr: PRN(46), head: HEAD_A, label: "necessary-fix", item: "P46", ...over,
});
const finding = (problem: string) => ({ rank: 1, problem, fix: "fix it" });
const answerWith = (...problems: string[]) => async (): Promise<SeatAnswer> =>
  ({ verdict: problems.length ? "approve_with_changes" : "approve", findings: problems.map(finding), model: "m", cost_usd: 0.01 });
// Tests don't run as root: the grants file is made with their own uid and gid (the link uses root:cain).
const OWN = { uid: process.getuid!(), gid: process.getgid!() };
const grantRec = (key: string, rounds: number, over: Partial<GrantRec> = {}): GrantRec =>
  ({ id: `${key}+1${rounds}`, key, rounds, by: "owner", at: NOW.toISOString(), message: `1${rounds}`, reason: "The rollback keeper", item: "P46", pr: null,
    bound: { head: HEAD_A, decision: null, used: 3, cap: 3 }, ...over });                // 0.18.1: bound to a change at its cap of 3, head A
// The binding of the change as it stands now (what his tap's final check would have read), for the runner's tests.
const bindNow = (r: Rounds, g: Grants | null, key: string, head: string | null = HEAD_A) =>
  ({ head, decision: decisionOf(r, key)?.id ?? null, used: countedRounds(r, key).length, cap: standing(3, r, g, key).prior });

function runnerRig(o: { seat?: (i: SeatInput) => Promise<SeatAnswer> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grant-"));
  const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
    termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue"),
    roundsFile: join(dir, "rounds.json"), roundCap: 3, settingsFile: join(dir, "settings.json"), grantsFile: join(dir, "grants.json") };
  writeFileSync(cfg.termsFile, "# terms\nAcme Corp\n");
  const posted: DecisionRec[] = [];
  let seat = o.seat ?? answerWith("SERIOUS: the keeper can lose the way back");
  // 0.18.1 (fourth review): GitHub's head for the pull request, as the runner reads it before a claim (null: can't be read).
  let gh: string | null = HEAD_A;
  const ghReads: string[] = [];
  const logs: string[] = [];
  // Fifth review: GitHub's compare of the bound head with the head read now (null: can't tell), the runner's clock.
  // Sixth review: the owner's plain notices it asks the link for, and the compares it asked.
  let cmp: "ahead" | "behind" | "diverged" | "identical" | HostFail | null = null;
  let clock = NOW.getTime();
  // Seventh review: where the head came from (the pull request API, fresh and authoritative, or the refs fallback).
  let ghSource: "api" | "refs" = "api";
  const ghBy: Record<string, string | null | "hang" | { late: string; ms: number } | HostFail> = {};   // per pull request, over gh
  const notices: OwedNotice[] = [];
  const compares: string[] = [];
  const deps: RunnerDeps = { seats: { gemini: async (i: SeatInput) => seat(i) }, now: () => new Date(clock), rand: () => 0.5, log: (m: string) => { logs.push(m); },
    postDecision: async (d: DecisionRec) => { posted.push(d); return `m-${posted.length}`; },
    pull: async (pr: string) => {
      ghReads.push(pr);
      const v = pr in ghBy ? ghBy[pr] : gh;
      if (v && typeof v === "object" && "fail" in v) return v;
      if (v && typeof v === "object") { const late = v as { late: string; ms: number }; return new Promise<{ head: string; source: "api" }>((res) => setTimeout(() => res({ head: late.late, source: "api" }), late.ms)); }
      return v === "hang" ? new Promise<never>(() => {}) : v === null ? null : { head: v as string, source: ghSource };
    },
    compare: async (pr: string) => { compares.push(pr); return cmp; }, postNotice: async (n: OwedNotice) => { notices.push(n); return `n-${notices.length}`; } };
  const conf = { ...cfg, hostWaitMs: 20, hostDeadlineMs: 60, preReplayOwner: OWN };
  const runner = new Runner(conf, deps);
  runner.writeSettings();
  const relays = () => existsSync(cfg.relayFile) ? readFileSync(cfg.relayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
  // A brief as the inbox takes it: GitHub's head read first when its round would claim a grant, then admitted
  // in one step pinned to that head ("waits" when GitHub can't be read: nothing taken).
  const take = async (b: Brief): Promise<string | null> => {
    const h = await runner.githubHead(b);
    return h === null ? "waits" : runner.admitAndQueue(b, h);
  };
  return { dir, cfg: runner.cfg, runner, posted, relays, take, logs, ghReads, setGh: (h: string | null) => { gh = h; }, setSeat: (f: typeof seat) => { seat = f; },
    setCompare: (c: typeof cmp) => { cmp = c; }, setSource: (x: "api" | "refs") => { ghSource = x; }, advance: (ms: number) => { clock += ms; }, notices, compares, ghBy,
    // A restart: a new runner on the same files, its in-memory state gone.
    restart: (over: Partial<RunnerDeps> = {}) => new Runner(conf, { ...deps, ...over }),
    rounds: () => readRounds(cfg.roundsFile!)!, grants: () => readGrants(cfg.grantsFile!),
    grant: (key: string, n: number, over: Partial<GrantRec> = {}) => recordGrant(cfg.grantsFile!,
      grantRec(key, n, { bound: bindNow(readRounds(cfg.roundsFile!)!, readGrants(cfg.grantsFile!), key), ...over }), { sync: () => {}, owner: OWN }),
    get: (id: string) => loadReview(cfg.queueDir, id)! };
}
async function threeRounds(t: ReturnType<typeof runnerRig>, over: Partial<Brief> = {}) {
  for (const id of ["k-1", "k-2", "k-3"]) { expect(await t.take(brief({ id, ...over }))).toBeNull(); await t.runner.tick(); }
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
    const why = await t.take(brief({ id: "k-4" }))!;
    expect(why).toContain("pr-46 has had 3 outside review rounds, and the owner's rule allows at most 3.");
    expect(why).toContain("keeper.sh review-grant");
    expect(why).toContain("only the owner's tap on that card grants them");
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    t.grant("pr-46", 2);
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    expect(t.get("k-4")).toMatchObject({ change: "pr-46", round: 4, cap: 5, base_cap: 3, round_kind: "fixes" });
    expect(t.get("k-4").earlier?.length).toBeGreaterThan(0);                  // the earlier findings go with it, as today
    await t.runner.tick();
    expect(await t.take(brief({ id: "k-5" }))).toBeNull();
    await t.runner.tick();
    const sixth = await t.take(brief({ id: "k-6" }))!;
    expect(sixth).toContain("has had 5 outside review rounds, and the owner's rule allows at most 3, plus 2 granted by Dane on Nov 21, so 5.");
    expect(countedRounds(t.rounds(), "pr-46").length).toBe(5);
  });

  test("superseding carries the grants over with the rounds, either way", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    // The fix moves to pull request 48, superseding 46: the grant counts for the group.
    expect(await t.take(brief({ id: "s-4", pr: PRN(48), supersedes: PRN(46) }))).toBeNull();
    expect(t.get("s-4")).toMatchObject({ change: "pr-48", round: 4, cap: 4 });
    await t.runner.tick();
    expect(await t.take(brief({ id: "s-5", pr: PRN(48) }))).toContain("has had 4");
    // A grant made for the new key counts for the old one too.
    t.grant("pr-48", 1);
    expect(effectiveCap(3, t.rounds(), t.grants(), "pr-46")).toBe(5);
    expect(await t.take(brief({ id: "s-5b", pr: PRN(46) }))).toBeNull();
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
  r.pulls[PRN(46)] = { head: HEAD_A, open: true };                             // the pull request's head, as GitHub has it
  const written: GrantRec[] = [];
  const decided: [string, string][] = [];
  const box = { rounds, grants, fail: false, calls: 0 };
  Object.assign((r.link as any).d, {
    rounds: () => box.rounds, grants: () => box.grants, roundCap: () => 3,
    grant: (rec: GrantRec) => {
      box.calls++;
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
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
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
    await t.take(brief({ id: "k-4" }));
    expect(capStateFor(PRN(46), t.rounds(), held)).toMatchObject({ state: "pending", why: expect.stringContaining("still running") });
    await t.runner.tick(); await t.runner.tick();
    expect(t.posted.length).toBe(1);                                            // round 4 of 5 still serious: no card yet
    expect(capStateFor(PRN(46), t.rounds(), held)).toMatchObject({ state: "pending", why: expect.stringContaining("still left something serious") });
    t.setSeat(answerWith("FOLLOW-UP: a wording nit"));
    await t.take(brief({ id: "k-5" }));
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
    await t.take(brief({ id: "k-4" }));
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

// ---- Second review of 0.18.0: the tap serialized, the card bound to the reviewed state, no deadlock ----
const decided3 = (r: Rounds, id = "pr-46#3"): Rounds => {
  r.changes["pr-46"].decision = { id, key: "pr-46", round: 3, serious: 2, topic: "t", finding: "f", item: "P46", pr: PRN(46), state: "posted", at: "2026-11-21T12:00:00Z" };
  return r;
};
const grantIds = (t: ReturnType<typeof linkRig>, id: string) => t.r.ids(id);

describe("one serialized operation per change key", () => {
  test("two deliveries of the same tap at once write exactly one grant; the second is a dead tap", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    const [cid] = grantIds(t, id);
    const msg = t.r.msg(id);
    const outs = await Promise.all([t.r.tap(msg, cid), t.r.tap(msg, cid)]);
    expect(outs.filter((o) => o === "to Cain").length).toBe(1);
    expect(outs.filter((o) => String(o).startsWith("dead:")).length).toBe(1);
    expect(t.box.calls).toBe(1);
    expect(t.written.length).toBe(1);
    expect(t.r.relayed.filter((l) => l.includes('Dane tapped "Grant 2 more rounds"')).length).toBe(1);
    expect(t.r.logs.filter((l) => l.includes("Dane granted 2 more review rounds")).length).toBe(1);
  });

  test("two rapid taps on one card, Grant then No, keep the first answer only", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    const [grant, no] = grantIds(t, id);
    const msg = t.r.msg(id);
    const outs = await Promise.all([t.r.tap(msg, grant), t.r.tap(msg, no)]);
    expect(outs[0]).toBe("to Cain");
    expect(String(outs[1])).toStartWith("dead:");
    expect(t.written.length).toBe(1);
    expect(t.r.relayed.join("\n")).not.toContain("No rounds were granted");
  });

  test("taps on two cards for the same key at once write one grant", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    // A second open card for the same key (one that slipped past the one-card rule): made by filing the first under
    // another key while the second goes up, then back.
    const s = t.r.state(); s.messages[a].grant!.key = "pr-other"; t.r.setState(s);
    t.r.later(60_000);
    const b = ((await ask(t.r, { rounds: 1, text: "The rollback keeper, one more round" })) as any).message;
    const s2 = t.r.state(); s2.messages[a].grant!.key = "pr-46"; s2.messages[a].outcome = undefined; s2.messages[a].buttons = true;
    if (s2.messages[a].q) s2.messages[a].q!.used = false; t.r.setState(s2);
    const outs = await Promise.all([t.r.tap(t.r.msg(a), grantIds(t, a)[0]), t.r.tap(t.r.msg(b), grantIds(t, b)[0])]);
    expect(outs.filter((o) => o === "to Cain").length).toBe(1);
    expect(t.box.calls).toBe(1);
    expect(t.written.length).toBe(1);
  });
});

describe("the card is bound to the reviewed state", () => {
  test("it records the pull request's head and the newest decision beside the count and cap", async () => {
    const t = linkRig(decided3(atCap(2)), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    expect(t.r.state().messages[id].grant).toMatchObject({ used: 3, cap: 3, head: HEAD_A, decision: "pr-46#3" });
    const u = linkRig(atCap(2), emptyGrants());
    const id2 = ((await ask(u.r)) as any).message;
    expect(u.r.state().messages[id2].grant).toMatchObject({ head: HEAD_A, decision: null });
  });

  test("no card while the pull request's head can't be read", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    delete t.r.pulls[PRN(46)];
    await expect(ask(t.r)).rejects.toThrow("the pull request's head can't be read from GitHub right now");
  });

  test("a head change between posting and tap refuses and writes nothing", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    t.r.pulls[PRN(46)] = { head: HEAD_B, open: true };
    const line = "That pull request has new commits since this card went up, so this grant can't be written";
    expect(await t.r.tap(t.r.msg(id), grantIds(t, id)[0])).toBe(`refused: ${line}`);
    expect(t.box.calls).toBe(0);
    expect(t.r.buttons(id)).toEqual([]);
    expect(t.r.ephemerals().map((e: any) => e.content)).toContain(`${line}.`);
  });

  test("a newer decision between posting and tap refuses and writes nothing", async () => {
    const t = linkRig(decided3(atCap(2)), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    t.box.rounds = decided3(atCap(2), "pr-46#3b");
    const line = "A newer decision on that change has come since this card went up, so this grant can't be written";
    expect(await t.r.tap(t.r.msg(id), grantIds(t, id)[0])).toBe(`refused: ${line}`);
    expect(t.box.calls).toBe(0);
    // A decision where there was none refuses too.
    const u = linkRig(atCap(2), emptyGrants());
    const id2 = ((await ask(u.r)) as any).message;
    u.box.rounds = decided3(atCap(2));
    expect(await u.r.tap(u.r.msg(id2), grantIds(u, id2)[0])).toBe(`refused: ${line}`);
    expect(u.box.calls).toBe(0);
  });

  test("a card bound to nothing (no head or decision on it) writes nothing", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    const s = t.r.state(); delete s.messages[id].grant!.head; t.r.setState(s);
    expect(String(await t.r.tap(t.r.msg(id), grantIds(t, id)[0]))).toStartWith("refused: This card was posted before grants were bound");
    expect(t.box.calls).toBe(0);
  });
});

describe("the one-open-card rule never deadlocks", () => {
  const retired = (t: ReturnType<typeof linkRig>, id: string) => {
    expect(t.r.state().messages[id]).toMatchObject({ outcome: "replaced", buttons: false, q: { used: true } });
    expect(t.r.buttons(id)).toEqual([]);
    expect(String(t.r.msg(id).content)).toContain(REPLACED);
  };
  const again = (t: ReturnType<typeof linkRig>) => ask(t.r, { rounds: 1, text: "The rollback keeper, one more round" });

  test("an open card whose head moved is retired and replaced", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.r.pulls[PRN(46)] = { head: HEAD_B, open: true };
    const res = await again(t);
    expect(res.status).toBe("posted");
    retired(t, a);
    expect(REPLACED).toBe("Replaced by a newer card");
    const b = (res as any).message;
    expect(t.r.state().messages[b].grant).toMatchObject({ head: HEAD_B });
    // The old card's tap writes nothing; the new one's writes its grant.
    await t.r.tap(t.r.msg(a), `q:x:0`);
    expect(t.box.calls).toBe(0);
    expect(await t.r.tap(t.r.msg(b), grantIds(t, b)[0])).toBe("to Cain");
    expect(t.written.map((w) => w.message)).toEqual([b]);
  });

  test("a newer decision, or a changed round count or cap, retires it too", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.box.rounds = decided3(atCap(2));
    expect((await again(t)).status).toBe("posted");
    retired(t, a);
    const u = linkRig(atCap(2), emptyGrants());
    const c = ((await ask(u.r)) as any).message;
    const s = u.r.state(); s.messages[c].grant!.cap = 2; u.r.setState(s);   // posted on another cap
    expect((await again(u)).status).toBe("posted");
    retired(u, c);
  });

  test("an open card whose message is gone from the chat is retired", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.r.spy.onCall = (method, path) => { if (path.endsWith(`/messages/${a}`)) throw new Error("discord 404: Unknown Message"); };
    expect((await again(t)).status).toBe("posted");
    expect(t.r.state().messages[a]).toMatchObject({ outcome: "replaced", buttons: false, q: { used: true } });
  });

  test("a card that isn't stale still refuses a second; a Discord read that fails isn't taken as gone", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.r.failing.add(`GET /channels/`);
    await expect(again(t)).rejects.toThrow(`a grant card for pr-46 is already open`);
    expect(t.r.state().messages[a].outcome).toBeUndefined();
  });

  test("a card whose buttons were stripped no longer blocks a new one", async () => {
    // A refused tap whose answer Discord didn't take: the buttons still show, but the card is done on disk.
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.r.stop.stopped = true; t.r.stop.at = t.r.t.now;
    t.r.failing.add("/interactions/");
    expect(String(await t.r.tap(t.r.msg(a), grantIds(t, a)[0]))).toStartWith("refused: Everything is stopped");
    t.r.failing.delete("/interactions/");
    t.r.stop.stopped = false;
    expect((await again(t)).status).toBe("posted");
    // Buttons taken off without an outcome (the message edited by the sweep): not open either.
    const u = linkRig(atCap(2), emptyGrants());
    const c = ((await ask(u.r)) as any).message;
    const s = u.r.state(); s.messages[c].buttons = false; u.r.setState(s);
    expect((await again(u)).status).toBe("posted");
  });

  test("a passing failure at the tap keeps the buttons and says to try again in a minute", async () => {
    for (const [what, breakIt] of [
      ["The review records", (t: ReturnType<typeof linkRig>) => { t.box.grants = null; }],
      ["Who is working on that change", (t: ReturnType<typeof linkRig>) => { t.r.files.holds = "{not json"; }],
      ["The pull request's newest commit", (t: ReturnType<typeof linkRig>) => { delete t.r.pulls[PRN(46)]; }],
    ] as const) {
      const t = linkRig(atCap(2), emptyGrants());
      const id = ((await ask(t.r)) as any).message;
      const holds = t.r.files.holds, grants = t.box.grants, pull = t.r.pulls[PRN(46)];
      breakIt(t);
      expect(await t.r.tap(t.r.msg(id), grantIds(t, id)[0])).toBe("retry");
      expect(t.box.calls).toBe(0);
      expect(t.r.buttons(id)).toEqual(["Grant 2 more rounds", "No"]);
      expect(t.r.state().messages[id]).toMatchObject({ buttons: true, q: { used: false } });
      expect(t.r.state().messages[id].outcome).toBeUndefined();
      expect(t.r.ephemerals().map((e: any) => e.content)).toContain(grantRetry(what));
      expect(t.r.relayed.join("\n")).not.toContain("Dane tapped");
      // A minute later it reads again, and his tap writes the grant.
      t.r.files.holds = holds; t.box.grants = grants; t.r.pulls[PRN(46)] = pull;
      expect(await t.r.tap(t.r.msg(id), grantIds(t, id)[0])).toBe("to Cain");
      expect(t.written.length).toBe(1);
    }
    expect(grantRetry("The review records")).toBe("The review records can't be read right now, so nothing was granted yet. The card is still up: try again in a minute.");
  });

  test("after a link restart the open state is read back from disk", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = ((await ask(t.r)) as any).message;
    t.r.restart();
    await expect(again(t)).rejects.toThrow(`a grant card for pr-46 is already open`);
    t.r.pulls[PRN(46)] = { head: HEAD_B, open: true };
    t.r.restart();
    const res = await again(t);
    expect(res.status).toBe("posted");
    retired(t, a);
    const b = (res as any).message;
    t.r.restart();
    expect(await t.r.tap(t.r.msg(b), grantIds(t, b)[0])).toBe("to Cain");
    expect(t.written.length).toBe(1);
  });
});

// ---- Cain 0.18.1: the grant is bound to the state he approved, and the runner enforces it ----
// The third review of 0.18.0: the link's lock serializes taps, but GitHub and the runner can still move
// between the tap's final read and the grant's write. So the grant carries what the tap read (head,
// newest decision, round count, cap before it), and the runner counts it only while that still holds.
describe("the grant carries the state his tap approved", () => {
  test("his Grant tap writes the head, the newest decision, the count and the cap before it", async () => {
    const t = linkRig(decided3(atCap(2)), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    await t.r.tap(t.r.msg(id), grantIds(t, id)[0]);
    expect(t.written.length).toBe(1);
    expect(t.written[0].bound).toEqual({ head: HEAD_A, decision: "pr-46#3", used: 3, cap: 3 });
  });

  test("a push landing after the tap's final check leaves the grant bound to the head he approved", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    // The push lands in the window between grantBlock's head read and the write.
    const write = (t.r.link as any).d.grant;
    (t.r.link as any).d.grant = (rec: GrantRec) => { t.r.pulls[PRN(46)] = { head: HEAD_B, open: true }; return write(rec); };
    await t.r.tap(t.r.msg(id), grantIds(t, id)[0]);
    expect(t.written[0].bound).toEqual({ head: HEAD_A, decision: null, used: 3, cap: 3 });
    // Seen from the link with the new head, that grant doesn't raise the cap: a fresh card can go.
    expect(effectiveCap(3, atCap(2), t.box.grants, "pr-46", HEAD_B)).toBe(3);
    expect(effectiveCap(3, atCap(2), t.box.grants, "pr-46", HEAD_A)).toBe(5);
  });

  test("fourth review, 4: the binding's cap is the prior cap, the base plus the claimed grants only", async () => {
    const r = atCap(2);
    r.changes["pr-46"].rounds.push({ id: "x-4", at: "2026-11-24T00:00:00Z", kind: "fixes", state: "answered", serious: 1, claims: ["pr-46+11"] });
    const t = linkRig(r, { format: 1, grants: [grantRec("pr-46", 1)] });
    const id = ((await ask(t.r, { rounds: 1 })) as any).message;
    await t.r.tap(t.r.msg(id), grantIds(t, id)[0]);
    expect(t.written[0].bound).toEqual({ head: HEAD_A, decision: null, used: 4, cap: standing(3, r, t.box.grants, "pr-46").prior });
    expect(t.written[0].bound!.cap).toBe(4);
    expect(admit(r, brief({ id: "x-5" }), 3, t.box.grants)).toMatchObject({ ok: true, round: 5, cap: 5, claims: [`pr-46+${id}`] });
  });

  test("a change key with no pull request binds on the decision and the count only", async () => {
    const r = emptyRounds();
    r.changes["plan-x"] = { topic: "A plan", rounds: [1, 2, 3].map((n) => ({ id: `p-${n}`, at: `2026-11-2${n - 1}T00:00:00Z`, kind: (n === 1 ? "full" : "fixes") as any, state: "answered" as const, ...(n === 3 ? { serious: 1 } : {}) })) };
    const t = linkRig(r, emptyGrants());
    const id = ((await ask(t.r, { change: "plan-x" })) as any).message;
    await t.r.tap(t.r.msg(id), grantIds(t, id)[0]);
    expect(t.written[0].bound).toEqual({ head: null, decision: null, used: 3, cap: 3 });
    const a = admit(r, brief({ id: "p-4", pr: undefined, head: undefined, change: "plan-x" }), 3, t.box.grants);
    expect(a).toMatchObject({ ok: true, round: 4, cap: 5, claims: [`plan-x+${id}`] });
  });
});

describe("the runner counts a grant only while its binding holds", () => {
  test("the head moved after the tap's final check: the runner reads it on GitHub, and only then voids the grant, told to Cain once", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);                                         // bound to head A, as his tap read it
    // The push lands after the tap: GitHub's head is B. A brief naming B is checked against GitHub's head, which
    // agrees, and GitHub's compare shows A as B's ancestor (fifth review: the proof), so the grant is voided.
    t.setGh(HEAD_B); t.setCompare("ahead");
    const why = (await t.take(brief({ id: "k-4", head: HEAD_B })))!;
    expect(why).toContain("pr-46 has had 3 outside review rounds, and the owner's rule allows at most 3.");
    expect(why).toContain("doesn't count: it was given for the pull request as it stood then, but the pull request has new commits since");
    expect(why).not.toContain(HEAD_A); expect(why).not.toContain(HEAD_B);
    expect(t.ghReads).toEqual([PRN(46)]);
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    const told = t.relays().filter((l) => l.includes("no longer counts"));
    expect(told.length).toBe(1);
    expect(told[0]).toContain("Dane's grant of 1 more review round for pr-46 (granted by Dane on Nov 21) no longer counts");
    expect(told[0]).toContain("keeper.sh review-grant");
    expect(t.rounds().grants_void?.[`pr-46+11`]).toMatchObject({ why: "head", key: "pr-46" });
    // Asked again: it never counts again, and Cain isn't told twice.
    expect(await t.take(brief({ id: "k-4b", head: HEAD_B }))).toContain("doesn't count");
    expect(t.relays().filter((l) => l.includes("no longer counts")).length).toBe(1);
    expect(t.grants()!.grants.length).toBe(1);                   // never deleted
    // A fresh grant bound to the new head counts.
    t.grant("pr-46", 1, { id: "pr-46+fresh", bound: bindNow(t.rounds(), t.grants(), "pr-46", HEAD_B) });
    expect(await t.take(brief({ id: "k-4c", head: HEAD_B }))).toBeNull();
    expect(t.get("k-4c")).toMatchObject({ round: 4, cap: 4 });
  });

  test("fourth review, 1: the brief names the approved head but GitHub has moved on: refused, nothing claimed, nothing voided", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);                                         // approved at head A
    t.setGh(HEAD_B);                                             // a push after Cain read the head, before the claim
    const why = (await t.take(brief({ id: "k-4", head: HEAD_A })))!;
    expect(why).toContain("the pull request's head on GitHub is not the one the brief names; send it again with the current head");
    expect(why).toContain("No grant was claimed or voided");
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    const r = t.rounds();
    expect(r.grants_void).toBeUndefined();
    expect(r.changes["pr-46"].rounds.length).toBe(3);
    expect(r.changes["pr-46"].rounds.flatMap((x) => x.claims ?? [])).toEqual([]);
    expect(t.relays().filter((l) => l.includes("no longer counts")).length).toBe(0);
  });

  test("fourth review, 1: while GitHub can't be read the brief waits in the inbox, logged once, and is taken once it can", async () => {
    const t = runnerRig();
    t.cfg.inboxDir = join(t.dir, "inbox"); t.cfg.inboxUid = process.getuid!();
    mkdirSync(t.cfg.inboxDir, { recursive: true });
    await threeRounds(t);
    t.grant("pr-46", 1);
    t.setGh(null);
    writeFileSync(join(t.cfg.inboxDir, "k-4.json"), JSON.stringify(brief({ id: "k-4" })));
    const reads = t.ghReads.length;
    await t.runner.ingest(); await t.runner.ingest();
    expect(existsSync(join(t.cfg.inboxDir, "k-4.json"))).toBe(true);
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.length).toBe(3);
    expect(t.rounds().grants_void).toBeUndefined();
    expect(t.logs.filter((l) => l.includes("review brief k-4 waits in the inbox")).length).toBe(1);
    expect(t.ghReads.length - reads).toBe(1);                   // fifth review: backing off, not read every tick
    t.setGh(HEAD_A);
    await t.runner.ingest();
    expect(existsSync(join(t.cfg.inboxDir, "k-4.json"))).toBe(true);
    t.advance(61_000);                                          // the first wait is a minute
    await t.runner.ingest();
    expect(existsSync(join(t.cfg.inboxDir, "k-4.json"))).toBe(false);
    expect(t.get("k-4")).toMatchObject({ round: 4, cap: 4 });
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4")?.claims).toEqual(["pr-46+11"]);
  });

  test("fourth review, 2: a stale brief leaves the grant available, and the next brief on the approved head claims it", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.setGh(HEAD_B);
    t.grant("pr-46", 1, { bound: bindNow(t.rounds(), t.grants(), "pr-46", HEAD_B) });   // he approved head B
    // A delayed brief naming the older head A.
    expect(await t.take(brief({ id: "k-4", head: HEAD_A }))).toContain("the pull request's head on GitHub is not the one the brief names");
    expect(t.rounds().grants_void).toBeUndefined();
    expect(standing(3, t.rounds(), t.grants(), "pr-46", HEAD_B).claimable.map((x) => x.id)).toEqual(["pr-46+11"]);
    expect(await t.take(brief({ id: "k-4b", head: HEAD_B }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4b")?.claims).toEqual(["pr-46+11"]);
    expect(t.get("k-4b")).toMatchObject({ round: 4, cap: 4 });
  });

  test("fourth review, 4: two outstanding grants are both claimed by the one round, in time order, and the allowance is right", async () => {
    const t = runnerRig();
    await threeRounds(t);
    const b = bindNow(t.rounds(), t.grants(), "pr-46");
    t.grant("pr-46", 1, { id: "pr-46+first", at: "2026-11-21T17:40:00Z", bound: b });
    // The second's binding: the prior cap is the base plus claimed grants only, so the first (outstanding) isn't in it.
    expect(standing(3, t.rounds(), t.grants(), "pr-46").prior).toBe(3);
    t.grant("pr-46", 2, { id: "pr-46+second", at: "2026-11-21T17:45:00Z", bound: bindNow(t.rounds(), t.grants(), "pr-46") });
    expect(t.grants()!.grants[1].bound!.cap).toBe(3);
    expect(effectiveCap(3, t.rounds(), t.grants(), "pr-46", HEAD_A)).toBe(6);
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4")?.claims).toEqual(["pr-46+first", "pr-46+second"]);
    expect(t.get("k-4")).toMatchObject({ round: 4, cap: 6 });
    expect(t.rounds().grants_void).toBeUndefined();
    // Claimed, both count in full: rounds 5 and 6 run with no further claim, a seventh is refused.
    for (const id of ["k-5", "k-6"]) { await t.runner.tick(); await t.runner.tick(); expect(await t.take(brief({ id }))).toBeNull(); }
    await t.runner.tick(); await t.runner.tick();
    expect(await t.take(brief({ id: "k-7" }))).toContain("has had 6 outside review rounds");
    expect(t.rounds().changes["pr-46"].rounds.flatMap((x) => x.claims ?? [])).toEqual(["pr-46+first", "pr-46+second"]);
  });
  test("a new decision landing in that window: no extra round", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    const r = t.rounds();
    r.changes["pr-46"].decision = { ...r.changes["pr-46"].decision!, id: "pr-46#3b" };
    writeFileSync(t.cfg.roundsFile!, JSON.stringify(r));
    expect(await t.take(brief({ id: "k-4" }))).toContain("doesn't count: a newer decision on the change came after it was given");
    expect(loadReview(t.cfg.queueDir, "k-4")).toBeNull();
    expect(t.rounds().grants_void?.["pr-46+11"]?.why).toBe("decision");
  });

  test("a round count that moved in that window: no extra round", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    const r = t.rounds();
    r.changes["pr-46"].rounds.push({ id: "k-x", at: "2026-11-21T17:49:00Z", kind: "fixes", state: "answered", done: true, serious: 0 });
    writeFileSync(t.cfg.roundsFile!, JSON.stringify(r));
    expect(await t.take(brief({ id: "k-5" }))).toContain("doesn't count: the change's review rounds moved on after it was given");
    expect(loadReview(t.cfg.queueDir, "k-5")).toBeNull();
  });

  test("a brief with no head can't be matched to a grant bound to a head, and voids nothing", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    expect(await t.take(brief({ id: "k-4", head: undefined }))).toContain("this brief names no head, so it can't be matched");
    expect(t.rounds().grants_void).toBeUndefined();
    expect(await t.take(brief({ id: "k-4b" }))).toBeNull();
  });

  test("a matching binding claims exactly one round, and a second claim is refused", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4")?.claims).toEqual(["pr-46+11"]);
    await t.runner.tick(); await t.runner.tick();
    // Claimed: it counts in full whatever the head does now, and only that once.
    expect(effectiveCap(3, t.rounds(), t.grants(), "pr-46", HEAD_B)).toBe(4);
    const why = await t.take(brief({ id: "k-5" }))!;
    expect(why).toContain("has had 4 outside review rounds, and the owner's rule allows at most 3, plus 1 granted by Dane on Nov 21, so 4.");
    expect(loadReview(t.cfg.queueDir, "k-5")).toBeNull();
    const claims = t.rounds().changes["pr-46"].rounds.flatMap((x) => x.claims ?? []);
    expect(claims).toEqual(["pr-46+11"]);
  });

  test("a grant of several rounds is claimed once, then its rounds run as the head moves with the fixes", async () => {
    const t = runnerRig({ seat: answerWith("SERIOUS: still wrong") });
    await threeRounds(t);
    t.grant("pr-46", 2);
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    await t.runner.tick();
    expect(await t.take(brief({ id: "k-5", head: HEAD_B }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-5")?.claims).toBeUndefined();
  });

  test("the link offers a fresh card when the grant on file is bound to an older head", async () => {
    const u = linkRig(atCap(2), { format: 1, grants: [grantRec("pr-46", 1, { bound: { head: HEAD_B, decision: null, used: 3, cap: 3 } })] });
    const res = await ask(u.r);
    expect(res.status).toBe("posted");
    expect(String(u.r.msg((res as any).message).content)).toContain("It has used all 3 of its outside review rounds, and");
  });
});

describe("status, spend and the round line say when a grant no longer counts", () => {
  test("a grant bound to an older head, after a round under an earlier grant", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    await t.runner.tick(); await t.runner.tick();
    t.grant("pr-46", 1, { id: "pr-46+second" });                          // bound to round 4's decision and head A
    t.setGh(HEAD_B); t.setCompare("ahead");                                // a push since, as GitHub has it
    expect(await t.take(brief({ id: "k-5", head: HEAD_B }))).toContain("the pull request has new commits since");
    expect(staleWords(standing(3, t.rounds(), t.grants(), "pr-46"))).toBe("1 grant no longer counts: the pull request moved on");
    const env = { ...process.env, REVIEW_QUEUE: t.cfg.queueDir, REVIEW_SPEND: t.cfg.spendFile, REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: t.cfg.settingsFile,
      REVIEW_GRANTS: t.cfg.grantsFile, CAIN_HOME: join(t.dir, "home"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"), CAIN_TEST_MODE: "1" };
    mkdirSync(join(t.dir, "home"), { recursive: true });
    const cli = (...a: string[]) => spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), ...a], { encoding: "utf8", env });
    expect(cli("status", "k-4").stdout).toContain("pr-46: round 4 of 4, 1 granted by Dane on Nov 21, 1 grant no longer counts: the pull request moved on (fix-only)");
    expect(cli("spend").stdout).toContain("pr-46: 4 of 4 rounds (1 granted by Dane on Nov 21; 1 grant no longer counts: the pull request moved on)");
  });

  test("the relay's round line names a grant that didn't count when the round was taken", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 2, { id: "pr-46+old", bound: { ...bindNow(t.rounds(), t.grants(), "pr-46"), decision: "pr-46#2" } });   // given before a newer decision
    t.grant("pr-46", 1, { id: "pr-46+new" });
    expect(await t.take(brief({ id: "k-4" }))).toBeNull();
    await t.runner.tick();
    expect(roundLine(t.get("k-4"))).toBe("Round 4 of 4, 1 granted by Dane on Nov 21, 1 grant no longer counts: a newer decision came, for pr-46 (fix-only): 1 serious finding left.");
    expect(t.relays().filter((l) => l.includes("no longer counts:") && l.startsWith("Dane's grant")).length).toBe(1);
  });
});

// ---- Cain 0.18.1, fifth and sixth reviews ----
// The rounds and grants files as 0.18.0 wrote them: rounds at the given times, no claims; grants with no binding.
const rr018 = (id: string, at: string, n: number, serious = 1) => ({ id, at, kind: n === 1 ? "full" : "fixes", state: "answered", done: true, serious });
function records018(t: ReturnType<typeof runnerRig>, rounds: [string, string][], grants: [string, number, string][], decisionRound?: number) {
  const list = rounds.map(([id, at], i) => rr018(id, at, i + 1));
  const n = decisionRound ?? list.length;
  const r = { format: 1, changes: { "pr-46": { pr: PRN(46), topic: "The rollback keeper", rounds: list,
    decision: { id: `pr-46#${n}`, key: "pr-46", round: n, serious: 1, topic: "The rollback keeper", finding: "SERIOUS: x", item: "P46", pr: PRN(46), state: "posted", at: list[n - 1].at, message: "m-1" } } } };
  writeFileSync(t.cfg.roundsFile!, JSON.stringify(r, null, 1));
  writeFileSync(t.cfg.grantsFile!, JSON.stringify({ format: 1, grants: grants.map(([id, k, at]) => ({ id, key: "pr-46", rounds: k, by: "owner", at,
    message: id.split("+")[1], reason: "The rollback keeper", item: "P46", pr: PRN(46) })) }, null, 1));
}
const T = (h: number, m = 0) => `2026-11-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("sixth review: the one-time replay debits one earlier grant round per round past the base cap", () => {
  test("round four after a two-round grant produces one historical claim and exactly one unused round, let go", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 2, T(13)]]);
    await t.runner.tick();
    const r = t.rounds();
    expect(r.changes["pr-46"].rounds.flatMap((x) => (x.claims ?? []).map((c) => [x.id, c]))).toEqual([["k-4", "pr-46+111"]]);
    expect(r.grants_void?.["pr-46+111"]).toMatchObject({ why: "unbound", key: "pr-46", rounds: 1 });
    expect(r.replayed).toBe(NOW.toISOString());
    const st = standing(3, r, t.grants(), "pr-46", HEAD_A);
    expect(st.counting.map((x) => [x.id, x.rounds])).toEqual([["pr-46+111", 1]]);   // counts the one round that needed it
    expect(st.claimable).toEqual([]);
    expect(st.prior).toBe(4);
    expect(effectiveCap(3, r, t.grants(), "pr-46", HEAD_A)).toBe(4);
    const why = (await t.take(brief({ id: "k-5" })))!;
    expect(why).toContain("has had 4 outside review rounds, and the owner's rule allows at most 3, plus 1 granted by Dane on Nov 21, so 4.");
    expect(t.grants()!.grants.length).toBe(1);                     // the grants file isn't touched
  });

  test("a grant followed only by base-cap rounds is voided in full", async () => {
    const t = runnerRig();
    // Given after round two (a lost round had left the change at its cap then); round three was within the base cap.
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(13)]], [["pr-46+111", 2, T(12)]]);
    await t.runner.tick();
    const r = t.rounds();
    expect(r.changes["pr-46"].rounds.flatMap((x) => x.claims ?? [])).toEqual([]);
    expect(r.grants_void?.["pr-46+111"]).toMatchObject({ why: "unbound", rounds: 2 });
    const st = standing(3, r, t.grants(), "pr-46", HEAD_A);
    expect([st.counting, st.claimable]).toEqual([[], []]);
    expect(st.stale.map((x) => x.why)).toEqual(["unbound"]);
    for (const h of [HEAD_A, HEAD_B, null, undefined]) expect(effectiveCap(3, r, t.grants(), "pr-46", h as any)).toBe(3);
    const why = (await t.take(brief({ id: "k-4" })))!;
    expect(why).toContain("allows at most 3.");
    expect(why).toContain("doesn't count: it was granted before grants were bound to the change as it stood");
    expect(why).toContain("a fresh grant card is the way");
  });

  test("rounds past the base cap debit the earliest earlier grant with rounds left, by grant time then id", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)], ["k-5", T(15)], ["k-6", T(17)]],
      [["pr-46+222", 1, T(13)], ["pr-46+111", 1, T(13)], ["pr-46+333", 2, T(16)]]);
    await t.runner.tick();
    const r = t.rounds();
    expect(r.changes["pr-46"].rounds.flatMap((x) => (x.claims ?? []).map((c) => [x.id, c])))
      .toEqual([["k-4", "pr-46+111"], ["k-5", "pr-46+222"], ["k-6", "pr-46+333"]]);
    expect(Object.keys(r.grants_void ?? {})).toEqual(["pr-46+333"]);
    expect(r.grants_void!["pr-46+333"].rounds).toBe(1);
    expect(effectiveCap(3, r, t.grants(), "pr-46", HEAD_A)).toBe(6);
  });

  test("Cain hears once and the owner once, through the link, naming the change and the rounds let go; a restart changes nothing", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 1, T(13)], ["pr-46+222", 2, T(15)]]);
    await t.runner.tick(); await t.runner.tick();
    const r = t.rounds();
    expect(r.grants_void?.["pr-46+111"]).toBeUndefined();          // fully used
    expect(r.grants_void?.["pr-46+222"]).toMatchObject({ why: "unbound", rounds: 2 });
    const told = t.relays().filter((l) => l.includes("replayed Dane's earlier grants for pr-46"));
    expect(told.length).toBe(1);
    expect(told[0]).toContain("3 rounds granted, 1 credited to rounds past the base cap that needed it, 2 unused and let go: they never count");
    expect(told[0]).toContain("keeper.sh review-grant");
    expect(t.notices).toEqual([expect.objectContaining({ id: "unbound:pr-46", to: "owner", kind: "unbound", key: "pr-46", pr: PRN(46), rounds: 2 })]);
    expect(r.notices?.["unbound:pr-46"]).toMatchObject({ state: "sent", message: "n-1" });
    const again = t.restart();
    await again.tick(); await again.tick();
    expect(t.relays().filter((l) => l.includes("replayed Dane's earlier grants")).length).toBe(1);
    expect(t.notices.length).toBe(1);
    expect(t.rounds()).toEqual(r);
  });

  test("the commit is atomic: a crash before it leaves no partial state, and the replay then runs again cleanly", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 2, T(13)]]);
    const before = readFileSync(t.cfg.roundsFile!, "utf8");
    const crashing = t.restart({ crashPoint: () => { throw new Error("power cut"); } });
    await expect(crashing.tick()).rejects.toThrow("power cut");
    expect(readFileSync(t.cfg.roundsFile!, "utf8")).toBe(before);   // no claim, no void, no notice, no marker
    expect(t.relays()).toEqual([]);
    expect(t.notices).toEqual([]);
    await t.restart().tick();
    const r = t.rounds();
    expect(r.replayed).toBeTruthy();
    expect(r.changes["pr-46"].rounds.find((x) => x.id === "k-4")?.claims).toEqual(["pr-46+111"]);
    expect(r.grants_void?.["pr-46+111"]).toMatchObject({ why: "unbound", rounds: 1 });
    expect(t.relays().filter((l) => l.includes("replayed Dane's earlier grants")).length).toBe(1);
    expect(t.notices.map((n) => n.id)).toEqual(["unbound:pr-46"]);
  });

  test("copies of both files as they were go beside them first, 0640, and are kept once", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 2, T(13)]]);
    const rounds0 = readFileSync(t.cfg.roundsFile!, "utf8"), grants0 = readFileSync(t.cfg.grantsFile!, "utf8");
    await t.runner.tick();
    const pr = join(t.dir, PRE_ROUNDS), pg = join(t.dir, PRE_GRANTS);
    expect(readFileSync(pr, "utf8")).toBe(rounds0);
    expect(readFileSync(pg, "utf8")).toBe(grants0);
    for (const f of [pr, pg]) { expect(statSync(f).mode & 0o777).toBe(0o640); expect(statSync(f).uid).toBe(OWN.uid); expect(statSync(f).gid).toBe(OWN.gid); }
    expect(readFileSync(t.cfg.roundsFile!, "utf8")).not.toBe(rounds0);
    await t.restart().tick();
    expect(readFileSync(pr, "utf8")).toBe(rounds0);                 // never written over
    // The start check lets Cain's user read them, as root:cain 0640 files of /data, and lock.sh keeps them so.
    const opt = join(import.meta.dir, "../rootfs/opt/cain");
    expect(readFileSync(join(opt, "c1/contract.ts"), "utf8")).toContain("/^\\/data\\/review-(rounds|grants)\\.pre-0\\.18\\.1\\.json$/");
    const lock = readFileSync(join(opt, "c1/lock.sh"), "utf8");
    for (const f of [PRE_ROUNDS, PRE_GRANTS]) expect(lock.split(f).length).toBe(3);   // in his list, and owned root:cain 0640
  });
});

describe("sixth review: the Keep or Drop card is gone; the owner hears plain notices in the link's own words", () => {
  test("the link has no legacy-grant route; the runner's notice route is root's alone", () => {
    expect(ROOT_ROUTES.has("/legacy-grant")).toBe(false);
    expect(CAIN_ROUTES.has("/legacy-grant")).toBe(false);
    expect(ROOT_ROUTES.has("/review-notice")).toBe(true);
    expect(CAIN_ROUTES.has("/review-notice")).toBe(false);
    expect(routeAllowed("cain", "/review-notice")).toBe(false);
  });

  test("each kind is worded by the link, posted once per id, with no buttons to tap", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const said = async (b: Record<string, unknown>) => String(t.r.msg((await t.r.link.reviewNotice(b)).message).content);
    expect(await said({ id: "unbound:pr-46", kind: "unbound", key: "pr-46", pr: PRN(46), rounds: 2 }))
      .toBe("Before grants were tied to a commit, you granted extra review rounds for pull request 46. 2 of them were never used and are now let go. If it needs more rounds, Cain can ask you again.");
    expect(await said({ id: "void:pr-46+11", kind: "void", key: "pr-46", pr: PRN(46), rounds: 1, why: "head" }))
      .toBe("Your grant of 1 more review round for pull request 46 no longer counts: the pull request has new commits since you granted it. If it needs more rounds, Cain can ask you again.");
    expect(await said({ id: "waits:k-4", kind: "waits", key: "pr-46", pr: PRN(46) }))
      .toBe("The review of pull request 46 waits on GitHub: its newest commit can't be read right now. It keeps trying by itself.");
    const a = await t.r.link.reviewNotice({ id: "waits:k-4", kind: "waits", key: "pr-46", pr: PRN(46) });
    expect(a.duplicate).toBe(true);
    await expect(t.r.link.reviewNotice({ id: "void:x", kind: "void", key: "pr-46", rounds: 1, why: "because I said so" })).rejects.toThrow();
    await expect(t.r.link.reviewNotice({ id: "waits:k", kind: "unbound", key: "pr-46", rounds: 1 })).rejects.toThrow();
  });

  test("a grant voided for any reason owes the owner one notice through the link", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    t.setGh(HEAD_B); t.setCompare("ahead");
    await t.take(brief({ id: "k-4", head: HEAD_B }));
    await t.take(brief({ id: "k-4b", head: HEAD_B }));
    await t.runner.tick(); await t.runner.tick();
    expect(t.notices.filter((n) => n.kind === "void")).toEqual([expect.objectContaining({ id: "void:pr-46+11", to: "owner", key: "pr-46", rounds: 1, why: "head" })]);
  });
});

describe("sixth review: the code host's read has hard deadlines, one shared backoff and timers that survive a restart", () => {
  const inboxRig = async () => {
    const t = runnerRig();
    t.cfg.inboxDir = join(t.dir, "inbox"); t.cfg.inboxUid = process.getuid!();
    mkdirSync(t.cfg.inboxDir, { recursive: true });
    await threeRounds(t);
    await threeRounds(t, { pr: PRN(47), item: "P47" } as any);
    t.grant("pr-46", 1); t.grant("pr-47", 1, { id: "pr-47+1" });
    return t;
  };
  const put = (t: Awaited<ReturnType<typeof inboxRig>>, b: Brief) => writeFileSync(join(t.cfg.inboxDir!, `${b.id}.json`), JSON.stringify(b));
  const inbox = (t: Awaited<ReturnType<typeof inboxRig>>, id: string) => existsSync(join(t.cfg.inboxDir!, `${id}.json`));
  const reads = (t: Awaited<ReturnType<typeof inboxRig>>, n: number) => t.ghReads.filter((x) => x === PRN(n)).length;

  test("another change's brief runs while one waits on GitHub; a read past its deadline backs every read off", async () => {
    const t = await inboxRig();
    t.ghBy[PRN(46)] = "hang";                                      // GitHub doesn't answer for pull request 46
    put(t, brief({ id: "a-46" })); put(t, brief({ id: "b-47", pr: PRN(47), item: "P47" }));
    await t.runner.ingest();
    expect(inbox(t, "a-46")).toBe(true);
    expect(t.get("b-47")).toMatchObject({ round: 4, cap: 4 });
    await Bun.sleep(80);                                           // past the read's deadline
    await t.runner.ingest();
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
    const k = reads(t, 46);
    await t.runner.ingest(); await t.runner.ingest();
    expect(reads(t, 46)).toBe(k);                                  // at most one read in flight, then backing off
  });

  test("a read that never resolves: the notice goes at 15 minutes, to Cain and the owner once, and the brief is refused at 24 hours anyway", async () => {
    const t = await inboxRig();
    t.ghBy[PRN(46)] = "hang";
    put(t, brief({ id: "a-46" }));
    await t.runner.ingest();
    const notice = () => t.relays().filter((l) => l.includes("Review brief a-46 waits"));
    t.advance(14 * 60_000); await t.runner.ingest(); await t.runner.tick();
    expect(notice().length).toBe(0);
    t.advance(2 * 60_000); await t.runner.ingest(); await t.runner.tick();
    expect(notice().length).toBe(1);
    expect(notice()[0]).toContain("hasn't been readable for 15 minutes");
    expect(t.notices.filter((n) => n.kind === "waits")).toEqual([expect.objectContaining({ id: "waits:a-46", to: "owner", pr: PRN(46) })]);
    for (let i = 0; i < 5; i++) { t.advance(60 * 60_000); await t.runner.ingest(); await t.runner.tick(); }
    expect(notice().length).toBe(1);
    expect(t.notices.filter((n) => n.kind === "waits").length).toBe(1);
    t.advance(24 * 3_600_000); await t.runner.ingest();
    expect(inbox(t, "a-46")).toBe(false);
    expect(t.relays().find((l) => l.startsWith("Review brief a-46 wasn't taken"))).toContain("couldn't be read for 24 hours, so the runner stopped trying");
    expect(t.rounds().host_waits?.["a-46.json"]).toBeUndefined();
    const n = t.ghReads.length;
    t.advance(3_600_000); await t.runner.ingest();
    expect(t.ghReads.length).toBe(n);
    expect(t.rounds().changes["pr-46"].rounds.length).toBe(3);
    expect(t.rounds().grants_void).toBeUndefined();
  });

  test("a late answer from a read that ran past its deadline is discarded, and the next read decides", async () => {
    const t = await inboxRig();
    t.ghBy[PRN(46)] = { late: HEAD_B, ms: 150 };                   // answers B, but only after the 60 ms deadline
    t.setCompare("ahead");
    put(t, brief({ id: "a-46" }));
    await t.runner.ingest();
    await Bun.sleep(100);
    await t.runner.ingest();                                       // the deadline passed: a failed read, backing off
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
    await Bun.sleep(100);                                          // B arrives now, too late
    t.ghBy[PRN(46)] = HEAD_A;
    t.advance(61_000);
    await t.runner.ingest();
    expect(t.logs.some((l) => l.includes("came after its deadline and was discarded"))).toBe(true);
    expect(t.compares).toEqual([]);                                // B was never acted on
    expect(t.rounds().grants_void).toBeUndefined();
    expect(t.get("a-46")).toMatchObject({ round: 4, cap: 4 });
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "a-46")?.claims).toEqual(["pr-46+11"]);
    expect(t.rounds().host_backoff).toBeUndefined();               // an answered read clears the backoff
  });

  test("the wait's start, its notice and the backoff survive a restart", async () => {
    const t = await inboxRig();
    t.ghBy[PRN(46)] = null;
    put(t, brief({ id: "a-46" }));
    await t.runner.ingest();
    const w = t.rounds().host_waits?.["a-46.json"]!;
    expect(w).toMatchObject({ since: NOW.toISOString(), id: "a-46", pr: PRN(46) });
    expect(t.rounds().host_backoff).toMatchObject({ delay: 60_000 });
    const b = t.restart();
    const n = reads(t, 46);
    t.advance(30_000); await b.ingest();
    expect(reads(t, 46)).toBe(n);                                  // the backoff held across the restart
    t.advance(15 * 60_000); await b.ingest();
    expect(t.relays().filter((l) => l.includes("Review brief a-46 waits")).length).toBe(1);
    const c = t.restart();
    t.advance(60_000); await c.ingest(); await c.tick();
    expect(t.relays().filter((l) => l.includes("Review brief a-46 waits")).length).toBe(1);
    expect(t.rounds().host_waits?.["a-46.json"]?.since).toBe(NOW.toISOString());
    t.advance(24 * 3_600_000); await t.restart().ingest();
    expect(inbox(t, "a-46")).toBe(false);
  });

  test("one shared backoff holds both the head read and the compare", async () => {
    const t = await inboxRig();
    // Pull request 46's grant is bound to head A; GitHub has B, and the compare doesn't answer.
    t.ghBy[PRN(46)] = HEAD_B; t.setCompare(null);
    put(t, brief({ id: "a-46", head: HEAD_B }));
    await t.runner.ingest();
    expect(inbox(t, "a-46")).toBe(false);
    expect(t.relays().find((l) => l.startsWith("Review brief a-46 wasn't taken"))).toContain("the pull request's head isn't proven newer than the one the grant was given for");
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
    // A brief for pull request 47 now waits on the same backoff: its head isn't read until it passes.
    put(t, brief({ id: "b-47", pr: PRN(47), item: "P47" }));
    await t.runner.ingest();
    expect(reads(t, 47)).toBe(0);
    expect(inbox(t, "b-47")).toBe(true);
    t.advance(61_000);
    await t.runner.ingest();
    expect(t.get("b-47")).toMatchObject({ round: 4, cap: 4 });
    // A failed head read moves the same backoff, and the compare waits on it too.
    t.ghBy[PRN(46)] = null;
    put(t, brief({ id: "a-46b", head: HEAD_B }));
    await t.runner.ingest();
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
    t.ghBy[PRN(46)] = HEAD_B;
    const c = t.compares.length;
    await t.runner.ingest();
    expect(t.compares.length).toBe(c);
    t.advance(61_000); await t.runner.ingest();
    expect(t.compares.length).toBe(c + 1);
    // Seventh review: the head read answered (clearing the backoff), then the compare failed again: a minute.
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
  });
});

describe("sixth review: a grant is voided for its head only on GitHub's positive proof", () => {
  test("a host read that returns an older head than the binding leaves the grant intact", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1, { bound: bindNow(t.rounds(), t.grants(), "pr-46", HEAD_B) });   // he approved head B
    t.setGh(HEAD_A); t.setCompare("behind");                       // a lagging read: GitHub's compare says A is behind B
    for (const id of ["k-4", "k-4b"]) {
      const why = (await t.take(brief({ id, head: HEAD_A })))!;
      expect(why).toContain("GitHub's compare shows the pull request's head doesn't follow on from the commit the owner's grant was given for");
      expect(why).toContain("No grant was claimed or voided");
      await t.runner.tick();
    }
    expect(t.rounds().grants_void).toBeUndefined();
    expect(t.relays().filter((l) => l.includes("no longer counts")).length).toBe(0);
    t.setGh(HEAD_B);
    expect(await t.take(brief({ id: "k-4c", head: HEAD_B }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4c")?.claims).toEqual(["pr-46+11"]);
  });

  test("a compare that can't be read, or says diverged or identical, refuses the brief however many reads agree", async () => {
    for (const cmp of [null, "diverged", "identical"] as const) {
      const t = runnerRig();
      await threeRounds(t);
      t.grant("pr-46", 1);                                         // bound to head A
      t.setGh(HEAD_B); t.setCompare(cmp);
      for (const id of ["k-4", "k-4b", "k-4c"]) {
        // Seventh review: a diverged compare is a stalled change (a fresh grant is the way out); the others are retried.
        expect(await t.take(brief({ id, head: HEAD_B }))).toContain(cmp === "diverged" ? "doesn't follow on from the commit the owner's grant was given for"
          : "the pull request's head isn't proven newer than the one the grant was given for");
        await t.runner.tick();
      }
      expect(t.rounds().grants_void).toBeUndefined();
      expect(t.rounds().changes["pr-46"].rounds.flatMap((x) => x.claims ?? [])).toEqual([]);
      expect(t.notices.map((n) => n.kind)).toEqual(cmp === "diverged" ? ["stalled"] : []);
    }
  });
});

describe("fifth review: the grant write is idempotent per card", () => {
  test("the same card tapped twice, redelivered or sent again under a new message counts once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-card-"));
    const f = join(dir, "grants.json");
    const one = recordGrant(f, grantRec("pr-46", 2, { id: "pr-46+100", message: "100", card: "nonce-abc" }), { sync: () => {}, owner: OWN });
    const two = recordGrant(f, grantRec("pr-46", 2, { id: "pr-46+100", message: "100", card: "nonce-abc" }), { sync: () => {}, owner: OWN });
    const three = recordGrant(f, grantRec("pr-46", 2, { id: "pr-46+200", message: "200", card: "nonce-abc" }), { sync: () => {}, owner: OWN });
    expect([one.existed, two.existed, three.existed]).toEqual([false, true, true]);
    expect(readGrants(f)!.grants.map((x) => x.id)).toEqual(["pr-46+100"]);
    expect(effectiveCap(3, atCap(2), readGrants(f), "pr-46")).toBe(5);   // one grant of 2, not two
    rmSync(dir, { recursive: true, force: true });
  });

  test("the link's grant carries the card's id, and a second tap on the same card writes nothing", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const id = ((await ask(t.r)) as any).message;
    await t.r.tap(t.r.msg(id), t.r.ids(id)[0]);
    await t.r.tap(t.r.msg(id), t.r.ids(id)[0]);
    expect(t.written.length).toBe(1);
    expect(typeof t.written[0].card).toBe("string");
    expect(t.written[0].card!.length).toBeGreaterThan(8);
  });
});

describe("the owner's post-install checks", () => {
  test("review.sh sweep-dry-run prints the credit and the rounds let go on copies, writes nothing, and can be pointed at the pre-replay copies", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 2, T(13)]]);
    const rounds0 = readFileSync(t.cfg.roundsFile!, "utf8"), grants0 = readFileSync(t.cfg.grantsFile!, "utf8");
    const env = { ...process.env, REVIEW_QUEUE: t.cfg.queueDir, REVIEW_SPEND: t.cfg.spendFile, REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: t.cfg.settingsFile,
      REVIEW_GRANTS: t.cfg.grantsFile, CAIN_HOME: join(t.dir, "home"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"), CAIN_TEST_MODE: "1" };
    mkdirSync(join(t.dir, "home"), { recursive: true });
    const cli = (...a: string[]) => spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), ...a], { encoding: "utf8", env });
    const line = "pr-46+111 (2 rounds for pr-46, granted by Dane on Nov 21): credit k-4; let go 1";
    const o = cli("sweep-dry-run");
    expect(o.status).toBe(0);
    expect(o.stdout).toContain("nothing was written");
    expect(o.stdout).toContain(line);
    expect(readFileSync(t.cfg.roundsFile!, "utf8")).toBe(rounds0);
    expect(readFileSync(t.cfg.grantsFile!, "utf8")).toBe(grants0);
    // After the runner's replay, the live files say so, and the copies kept before it show what it did.
    await t.runner.tick();
    const after = cli("sweep-dry-run");
    expect(after.stdout).toContain("the runner replayed these already");
    expect(after.stdout).toContain(`review.sh sweep-dry-run ${join(t.dir, PRE_ROUNDS)} ${join(t.dir, PRE_GRANTS)}`);
    expect(after.stdout).toContain("pr-46+111: void already (unbound, 1 round let go, for pr-46)");
    const pre = cli("sweep-dry-run", join(t.dir, PRE_ROUNDS), join(t.dir, PRE_GRANTS));
    expect(pre.stdout).toContain(line);
    expect(cli("host-read", "not-a-pr").status).not.toBe(0);
  });
});

// ---- Cain 0.18.1, seventh review ----
const HEAD_D = "d".repeat(40);
describe("seventh review, 1: a void for head rests on a fresh read of GitHub's pull request API", () => {
  test("a cached descendant read after the pull request went back to the approved head leaves the grant intact", async () => {
    const t = runnerRig();
    t.cfg.inboxDir = join(t.dir, "inbox"); t.cfg.inboxUid = process.getuid!();
    mkdirSync(t.cfg.inboxDir, { recursive: true });
    await threeRounds(t);
    t.grant("pr-46", 1);                                           // approved at head A
    // GitHub's API answers B (a descendant of A), but slower than one tick waits: the answer is cached for the next.
    t.ghBy[PRN(46)] = { late: HEAD_B, ms: 35 }; t.setCompare("ahead");
    writeFileSync(join(t.cfg.inboxDir, "k-4.json"), JSON.stringify(brief({ id: "k-4", head: HEAD_B })));
    await t.runner.ingest();
    expect(existsSync(join(t.cfg.inboxDir, "k-4.json"))).toBe(true);
    await Bun.sleep(60);
    // Meanwhile the pull request was force-pushed back to A. The next tick finds the cached B: it can't void.
    t.ghBy[PRN(46)] = HEAD_A;
    await t.runner.ingest();
    expect(existsSync(join(t.cfg.inboxDir, "k-4.json"))).toBe(false);
    expect(t.relays().find((l) => l.startsWith("Review brief k-4 wasn't taken"))).toContain("wasn't read freshly from GitHub's pull request API");
    expect(t.rounds().grants_void).toBeUndefined();
    expect(t.notices).toEqual([]);
    // The brief on the approved head claims the grant.
    expect(await t.take(brief({ id: "k-4b", head: HEAD_A }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4b")?.claims).toEqual(["pr-46+11"]);
  });

  test("a head equal to the bound head claims with no compare at all, from the API or the refs", async () => {
    for (const src of ["api", "refs"] as const) {
      const t = runnerRig();
      await threeRounds(t);
      t.grant("pr-46", 1);
      t.setSource(src); t.setCompare("ahead");
      expect(await t.take(brief({ id: "k-4", head: HEAD_A }))).toBeNull();
      expect(t.compares).toEqual([]);
      expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4")?.claims).toEqual(["pr-46+11"]);
    }
  });

  test("a refs-fallback head that differs refuses the brief, asks no compare and keeps the grant", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);
    t.setGh(HEAD_B); t.setSource("refs"); t.setCompare("ahead");
    expect(await t.take(brief({ id: "k-4", head: HEAD_B }))).toContain("wasn't read freshly from GitHub's pull request API");
    expect(t.compares).toEqual([]);
    expect(t.rounds().grants_void).toBeUndefined();
    // The same head read freshly from the API, with GitHub's proof, voids it.
    t.setSource("api");
    expect(await t.take(brief({ id: "k-4b", head: HEAD_B }))).toContain("doesn't count");
    expect(t.rounds().grants_void?.["pr-46+11"]).toMatchObject({ why: "head" });
  });
});

describe("seventh review, 2: the replay reconciles existing claims and never charges a round twice", () => {
  const withClaims = (t: ReturnType<typeof runnerRig>, claims: Record<string, string[]>, extra: GrantRec[] = []) => {
    const r = JSON.parse(readFileSync(t.cfg.roundsFile!, "utf8"));
    for (const x of r.changes["pr-46"].rounds) if (claims[x.id]) x.claims = claims[x.id];
    writeFileSync(t.cfg.roundsFile!, JSON.stringify(r, null, 1));
    const g = JSON.parse(readFileSync(t.cfg.grantsFile!, "utf8"));
    g.grants.push(...extra);
    writeFileSync(t.cfg.grantsFile!, JSON.stringify(g, null, 1));
  };
  const bound900 = (): GrantRec => grantRec("pr-46", 1, { id: "pr-46+900", at: T(13, 30), pr: PRN(46), bound: { head: HEAD_A, decision: "pr-46#3", used: 3, cap: 3 } });

  test("a mixed ledger: claims already recorded are kept as they are, and only the unclaimed round past the cap is charged", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)], ["k-5", T(15)], ["k-6", T(16)]], [["pr-46+111", 2, T(13)]]);
    withClaims(t, { "k-4": ["pr-46+900"], "k-5": ["pr-46+111"] }, [bound900()]);
    await t.runner.tick();
    const r = t.rounds();
    expect(r.replayed).toBeTruthy();
    expect(r.changes["pr-46"].rounds.map((x) => [x.id, x.claims ?? []])).toEqual([
      ["k-1", []], ["k-2", []], ["k-3", []], ["k-4", ["pr-46+900"]], ["k-5", ["pr-46+111"]], ["k-6", ["pr-46+111"]]]);
    expect(r.grants_void).toBeUndefined();                          // 111's two rounds: one already claimed, one charged now
    expect(effectiveCap(3, r, t.grants(), "pr-46", HEAD_A)).toBe(6);
    expect(t.logs).toContain("replay plan: pr-46+111 (2 rounds for pr-46, granted by Dane on Nov 21): already claimed by k-5; credit k-6; let go 0");
  });

  test("a round past the cap with no earlier grant left to debit is recorded as unclaimed, never borrows from a later grant, and the replay refuses to commit", async () => {
    const t = runnerRig();
    // Round four ran before the only grant was given.
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(12, 30)]], [["pr-46+111", 2, T(13)]]);
    const before = readFileSync(t.cfg.roundsFile!, "utf8");
    await t.runner.tick(); await t.runner.tick();
    expect(readFileSync(t.cfg.roundsFile!, "utf8")).toBe(before);  // nothing committed: no claim, no void, no marker
    const plan = t.logs.filter((l) => l.startsWith("replay plan: ")).map((l) => l.slice("replay plan: ".length));
    expect(plan).toEqual([
      "pr-46+111 (2 rounds for pr-46, granted by Dane on Nov 21): credit none; let go 2",
      "round k-4 of pr-46 is past the base cap with no earlier grant left to debit: recorded as unclaimed, nothing debited",
      "the runner refuses to commit this replay: nothing is claimed or let go, and those grants don't count until it's sorted out"]);
    const told = t.relays().filter((l) => l.includes("was not committed"));
    expect(told.length).toBe(1);                                    // once a start of the runner
    expect(told[0]).toContain("review.sh sweep-dry-run prints the same plan");
    expect(t.notices).toEqual([]);
    // The dry run prints the very same plan.
    const env = { ...process.env, REVIEW_QUEUE: t.cfg.queueDir, REVIEW_SPEND: t.cfg.spendFile, REVIEW_ROUNDS: t.cfg.roundsFile, REVIEW_SETTINGS: t.cfg.settingsFile,
      REVIEW_GRANTS: t.cfg.grantsFile, CAIN_HOME: join(t.dir, "home"), REVIEW_GUARD_LOG: join(t.dir, "guard.log"), CAIN_TEST_MODE: "1" };
    mkdirSync(join(t.dir, "home"), { recursive: true });
    const o = spawnSync("bun", [join(import.meta.dir, "../rootfs/opt/cain/review/cli.ts"), "sweep-dry-run"], { encoding: "utf8", env });
    expect(o.stdout.split("\n").slice(1).filter(Boolean).map((l) => l.trim())).toEqual(plan);
  });

  test("a grant already carrying more claims than its rounds would charge a round twice: refused, nothing committed", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)], ["k-5", T(15)]], [["pr-46+111", 1, T(13)]]);
    withClaims(t, { "k-4": ["pr-46+111"], "k-5": ["pr-46+111"] });
    const before = readFileSync(t.cfg.roundsFile!, "utf8");
    await t.runner.tick();
    expect(readFileSync(t.cfg.roundsFile!, "utf8")).toBe(before);
    expect(t.logs).toContain("replay plan: pr-46+111 already carries 2 claims for its 1 round: it would charge a round twice");
    expect(t.relays().filter((l) => l.includes("was not committed")).length).toBe(1);
  });
});

describe("seventh review, 3: a notice stays owed until the link acknowledges its post", () => {
  // The link as the runner sees it: it keeps an id as posted only after its chat post succeeded and answers a repeat
  // with that message. mode: up, down (nothing posted), lost (posted, but the acknowledgement never comes back).
  const fakeLink = () => {
    const chat: string[] = [], kept = new Map<string, string>();
    const box = { mode: "up" as "up" | "down" | "lost", calls: 0 };
    const post = async (n: OwedNotice) => {
      box.calls++;
      if (kept.has(n.id)) return kept.get(n.id)!;
      if (box.mode === "down") throw new Error("the link didn't answer");
      chat.push(n.id); kept.set(n.id, `c-${chat.length}`);
      if (box.mode === "lost") throw new Error("the answer was lost");
      return kept.get(n.id)!;
    };
    return { chat, box, post };
  };
  const voided = async (t: ReturnType<typeof runnerRig>) => {
    await threeRounds(t);
    t.grant("pr-46", 1);
    t.setGh(HEAD_B); t.setCompare("ahead");
    await t.take(brief({ id: "k-4", head: HEAD_B }));
    expect(t.rounds().notices?.["void:pr-46+11"]?.state).toBe("owed");
  };

  test("a failed post stays owed, is retried under the link's own backoff, and is delivered once; the link down then up", async () => {
    const t = runnerRig();
    await voided(t);
    const l = fakeLink();
    const run = t.restart({ postNotice: l.post });
    l.box.mode = "down";
    await run.postOwedNotices();
    expect(t.rounds().notices?.["void:pr-46+11"]).toMatchObject({ state: "owed", tries: 1 });
    expect(t.rounds().link_backoff?.delay).toBe(60_000);
    expect(t.rounds().host_backoff).toBeUndefined();               // GitHub's backoff isn't the link's
    await run.postOwedNotices();
    expect(l.box.calls).toBe(1);                                    // waiting out the link's backoff
    t.advance(61_000); await run.postOwedNotices();
    expect(t.rounds().link_backoff?.delay).toBe(120_000);          // still down: doubled
    l.box.mode = "up";
    t.advance(121_000); await run.postOwedNotices(); await run.postOwedNotices();
    expect(l.chat).toEqual(["void:pr-46+11"]);
    expect(t.rounds().notices?.["void:pr-46+11"]).toMatchObject({ state: "sent", message: "c-1" });
    expect(t.rounds().link_backoff).toBeUndefined();
  });

  test("a lost acknowledgement, and a restart mid-delivery, post nothing twice", async () => {
    for (const restart of [false, true]) {
      const t = runnerRig();
      await voided(t);
      const l = fakeLink();
      const run = t.restart({ postNotice: l.post });
      l.box.mode = "lost";
      await run.postOwedNotices();
      expect(t.rounds().notices?.["void:pr-46+11"]?.state).toBe("owed");
      l.box.mode = "up";
      t.advance(61_000);
      await (restart ? t.restart({ postNotice: l.post }) : run).postOwedNotices();
      expect(l.chat).toEqual(["void:pr-46+11"]);
      expect(t.rounds().notices?.["void:pr-46+11"]).toMatchObject({ state: "sent", message: "c-1" });
    }
  });

  test("the link keeps an id as posted only after its post, and refuses a second ask while the first is under way", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const n = { id: "void:pr-46+11", kind: "void", key: "pr-46", pr: PRN(46), rounds: 1, why: "head" };
    const both = await Promise.allSettled([t.r.link.reviewNotice(n), t.r.link.reviewNotice(n)]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const again = await t.r.link.reviewNotice(n);
    expect(again.duplicate).toBe(true);
    expect(again.message).toBe((both.find((x) => x.status === "fulfilled") as any).value.message);
  });
});

describe("seventh review, 4: one writer per file", () => {
  test("a grant the link writes between the runner's read of the grants file and its rename of the rounds file survives untouched", async () => {
    const t = runnerRig();
    records018(t, [["k-1", T(10)], ["k-2", T(11)], ["k-3", T(12)], ["k-4", T(14)]], [["pr-46+111", 2, T(13)]]);
    let written = "";
    const run = t.restart({ crashPoint: () => {
      recordGrant(t.cfg.grantsFile!, grantRec("pr-47", 1, { id: "pr-47+5" }), { sync: () => {}, owner: OWN });
      written = readFileSync(t.cfg.grantsFile!, "utf8");
    } });
    await run.tick();
    expect(t.rounds().replayed).toBeTruthy();
    expect(readFileSync(t.cfg.grantsFile!, "utf8")).toBe(written);
    expect(t.grants()!.grants.map((x) => x.id)).toEqual(["pr-46+111", "pr-47+5"]);
    const src = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/review/runner.ts"), "utf8");
    expect(src).not.toMatch(/recordGrant|writeFileSync\(this\.cfg\.grantsFile/);
  });
});

describe("seventh review, follow-ups", () => {
  const inboxRig = async () => {
    const t = runnerRig();
    t.cfg.inboxDir = join(t.dir, "inbox"); t.cfg.inboxUid = process.getuid!();
    mkdirSync(t.cfg.inboxDir, { recursive: true });
    await threeRounds(t);
    await threeRounds(t, { pr: PRN(47), item: "P47" } as any);
    t.grant("pr-46", 1); t.grant("pr-47", 1, { id: "pr-47+1" });
    return t;
  };
  const put = (t: Awaited<ReturnType<typeof inboxRig>>, b: Brief) => writeFileSync(join(t.cfg.inboxDir!, `${b.id}.json`), JSON.stringify(b));
  const inbox = (t: Awaited<ReturnType<typeof inboxRig>>, id: string) => existsSync(join(t.cfg.inboxDir!, `${id}.json`));

  test("the backoff: a permanently failing compare on one change never holds up another change's brief", async () => {
    const t = await inboxRig();
    t.ghBy[PRN(46)] = HEAD_B; t.setCompare(classify(404));         // the compare is refused for good
    for (const id of ["a-46", "a-46b", "a-46c"]) {
      put(t, brief({ id, head: HEAD_B }));
      put(t, brief({ id: `b-${id}`, pr: PRN(47), item: "P47" }));
      await t.runner.ingest();
      expect(inbox(t, id)).toBe(false);
      expect(t.rounds().host_backoff).toBeUndefined();
    }
    expect(t.get("b-a-46")).toMatchObject({ round: 4, cap: 4 });
    expect(t.rounds().grants_void).toBeUndefined();
    // A definitive answer on the pull request itself refuses its brief and leaves the backoff alone; a 429 moves it.
    t.ghBy[PRN(46)] = classify(404);
    put(t, brief({ id: "a-46d", head: HEAD_B }));
    await t.runner.ingest();
    expect(t.relays().find((l) => l.startsWith("Review brief a-46d wasn't taken"))).toContain("GitHub answered for good that its pull request can't be read (not there (404))");
    expect(t.rounds().host_backoff).toBeUndefined();
    t.ghBy[PRN(46)] = classify(429);
    put(t, brief({ id: "a-46e", head: HEAD_B }));
    await t.runner.ingest();
    expect(inbox(t, "a-46e")).toBe(true);
    expect(t.rounds().host_backoff?.delay).toBe(60_000);
    t.ghBy[PRN(46)] = HEAD_A; t.advance(61_000);
    put(t, brief({ id: "a-46f" }));
    await t.runner.ingest();
    expect(t.rounds().host_backoff).toBeUndefined();               // reset on the read that answered
  });

  test("the wait start: two outages separated by a success each start their own wait, and a clock jump back re-anchors", async () => {
    const t = await inboxRig();
    const told = () => t.relays().filter((l) => l.includes("Review brief a-46 waits")).length;
    t.ghBy[PRN(46)] = null;
    put(t, brief({ id: "a-46", head: HEAD_B }));
    await t.runner.ingest();
    expect(t.rounds().host_waits?.["a-46.json"]?.since).toBe(NOW.toISOString());
    t.advance(10 * 60_000);
    t.ghBy[PRN(46)] = HEAD_A;                                       // the read answers: the brief names another head
    await t.runner.ingest();
    expect(inbox(t, "a-46")).toBe(false);
    expect(t.rounds().host_waits?.["a-46.json"]).toBeUndefined();
    // The brief again, and a second outage: its wait starts now, not at the first one's start.
    t.ghBy[PRN(46)] = null;
    put(t, brief({ id: "a-46" }));
    t.advance(61_000); await t.runner.ingest();
    const second = t.rounds().host_waits?.["a-46.json"]?.since;
    expect(second).toBe(new Date(NOW.getTime() + 11 * 60_000 + 1000).toISOString());
    t.advance(14 * 60_000); await t.runner.ingest();
    expect(told()).toBe(0);
    // The clock goes back an hour: elapsed time is clamped at zero and the start re-anchored to now.
    t.advance(-60 * 60_000); await t.runner.ingest();
    expect(Date.parse(t.rounds().host_waits!["a-46.json"].since)).toBe(NOW.getTime() + 11 * 60_000 + 1000 + 14 * 60_000 - 60 * 60_000);
    t.advance(14 * 60_000); await t.runner.ingest();
    expect(told()).toBe(0);
    t.advance(2 * 60_000); await t.runner.ingest();
    expect(told()).toBe(1);
  });

  test("a stalled change: one notice to the owner per change and head, and a new grant on the diverged head clears the refusal", async () => {
    const t = runnerRig();
    await threeRounds(t);
    t.grant("pr-46", 1);                                           // approved at head A
    t.setGh(HEAD_D); t.setCompare("diverged");                     // a rewrite: D doesn't follow on from A
    for (const id of ["k-4", "k-4b"]) {
      expect(await t.take(brief({ id, head: HEAD_D }))).toContain("A fresh grant for the pull request as it is now is the way");
      await t.runner.tick();
    }
    expect(t.notices).toEqual([expect.objectContaining({ id: `stalled:pr-46.${HEAD_D.slice(0, 12)}`, to: "owner", kind: "stalled", key: "pr-46", rounds: 1 })]);
    expect(t.relays().filter((l) => l.includes("can't place the pull request's head after the commit")).length).toBe(1);
    expect(t.rounds().grants_void).toBeUndefined();
    // His new grant on head D: the next brief runs under it; the old grant is neither claimed nor voided for its head.
    t.grant("pr-46", 1, { id: "pr-46+fresh", bound: bindNow(t.rounds(), t.grants(), "pr-46", HEAD_D) });
    expect(await t.take(brief({ id: "k-4c", head: HEAD_D }))).toBeNull();
    expect(t.rounds().changes["pr-46"].rounds.find((x) => x.id === "k-4c")?.claims).toEqual(["pr-46+fresh"]);
    expect(t.rounds().grants_void?.["pr-46+11"]).toBeUndefined();
  });

  test("the link words a stalled notice itself, facts only", async () => {
    const t = linkRig(atCap(2), emptyGrants());
    const a = await t.r.link.reviewNotice({ id: `stalled:pr-46.${HEAD_D.slice(0, 12)}`, kind: "stalled", key: "pr-46", pr: PRN(46), rounds: 1 });
    expect(String(t.r.msg(a.message).content)).toBe("Your grant of 1 more review round for pull request 46 can't be used now: its newest commit doesn't follow on from the one you granted it for. A new grant for it as it is now is the way out: Cain can ask you again.");
  });
});
