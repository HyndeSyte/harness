// GitHub's read allowance for the link (Cain 0.19.4, link/budget.ts): a file read at a commit is kept (its 200 only),
// an attempt's job list is kept only once a fresh read of that attempt says it is completed, other reads carry their
// ETag, two reads at once share one request (each caller its own copy), and what is left of the hour is read from the
// answers' headers and GitHub's /rate_limit (the lowest seen in a window; a failed read unknown). A Ship card short of
// the hour goes with its facts unread; his tap waits for the reset by itself within its 2 hours; the Ship run's
// registration waits once at most, bound to the landing's base. Review round 1's fixes each have a test here.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { CARD_ASKS, IMMUTABLE, LAND_ASKS, makeBook, makeGithub, PULL_STATE_EVERY_MS, pullStateReader, rateRefused, refusedUntil, REG_ASKS, RESERVE, SECONDARY_WAIT_MS, shortUntil } from "../rootfs/opt/cain/link/budget";
import { BUDGET_UNKNOWN_LINE } from "../rootfs/opt/cain/link/core";
import { facts, headChecks, land, windowsAttempts, type Git } from "../rootfs/opt/cain/link/merge";
import { budgetPendingSaid, budgetRestartSaid, keyFingerprint, passId, reconcilePasses, registerInstalls, shipPass, type PassDeps, type RegResult } from "../rootfs/opt/cain/link/ship-pass";
import { claimFor, makeToken } from "../rootfs/opt/cain/ship-token";
import { MIN, PR as LINK_PR, rig, SHA1 } from "./link-rig";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "/repos/HyndeSyte/harness";

// A fake GitHub API: answers by path, with rate-limit headers, counting what it was asked.
function fakeGithub(o: { remaining?: number; reset?: number } = {}) {
  const asked: { path: string; inm: string | null }[] = [];
  let remaining = o.remaining ?? 60;
  const reset = o.reset ?? 1_800_000_000;
  const files: Record<string, string> = { [`${REPO}/contents/cain/config.yaml?ref=${SHA}`]: 'version: "0.19.3"\n' };
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    const path = url.replace("https://api.github.com", "");
    const inm = init.headers["if-none-match"] ?? null;
    if (path === "/rate_limit")
      return new Response(JSON.stringify({ resources: { core: { limit: 60, remaining, reset } } }), { status: 200 });
    asked.push({ path, inm });
    remaining = Math.max(0, remaining - 1);
    const h = { "x-ratelimit-limit": "60", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core" };
    if (path in files) return new Response(JSON.stringify({ content: Buffer.from(files[path]).toString("base64"), encoding: "base64" }), { status: 200, headers: h });
    if (path === `${REPO}/pulls/46`) {
      if (inm === '"v1"') return new Response(null, { status: 304, headers: h });
      return new Response(JSON.stringify({ head: { sha: SHA }, base: { sha: BASE }, state: "open" }), { status: 200, headers: { ...h, etag: '"v1"' } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: h });
  };
  return { asked, fetch, get remaining() { return remaining; } };
}


const H = (remaining: number, reset = 1_800_000_000) => ({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core" });
const json = (body: any, status = 200, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });

describe("the link's GitHub reads (budget.ts)", () => {
  test("a file at a commit: its 200 is kept and never read again; another ref is read anew", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    const path = `${REPO}/contents/cain/config.yaml?ref=${SHA}`;
    const a = await gh.api(path), b = await gh.api(path);
    expect(a.status).toBe(200);
    expect(b).toEqual({ status: 200, body: a.body, headers: {} });
    await gh.api(`${REPO}/contents/cain/config.yaml?ref=main`);
    await gh.api(`${REPO}/contents/cain/config.yaml?ref=main`);
    expect(f.asked.map((x) => x.path)).toEqual([path, `${REPO}/contents/cain/config.yaml?ref=main`, `${REPO}/contents/cain/config.yaml?ref=main`]);   // a branch moves: never kept
    expect(gh.hour()).toEqual({ asked: 3, kept: 1, limits: 0 });
    expect(IMMUTABLE.test(`${REPO}/contents/x?ref=${SHA.slice(0, 39)}`)).toBe(false);
  });
  test("fix 1: a 404 at a commit is never kept: GitHub's 404 \"No commit found\" and then a 200 at the same sha gives the 200", async () => {
    let seen = false;
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      if (!seen) { seen = true; return json({ message: `No commit found for the ref ${SHA}` }, 404); }
      return json({ content: Buffer.from('version: "0.19.4"\n').toString("base64"), encoding: "base64" });
    };
    const gh = makeGithub({ fetch: fetch as any });
    const path = `${REPO}/contents/cain/config.yaml?ref=${SHA}`;
    expect((await gh.api(path)).status).toBe(404);
    const two = await gh.api(path);
    expect(two.status).toBe(200);
    expect(Buffer.from(two.body.content, "base64").toString()).toContain("0.19.4");
    expect(asked).toHaveLength(2);
    await gh.api(path);
    expect(asked).toHaveLength(2);                                 // the 200 is kept
  });
  test("fix 2: attempt 1 failed, then attempt 2 passed: judged on attempt 2's own list, and a further re-run is never read from attempt 1's", async () => {
    const run = { id: 7, head_sha: SHA, run_attempt: 1, status: "completed" };
    const jobs: Record<number, any> = { 1: { id: 101, name: "pcjobs-windows", status: "completed", conclusion: "failure" } };
    const asked: string[] = [];
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      if (path.includes("/check-runs?")) return json({ total_count: 0, check_runs: [] });
      if (path.startsWith(`${REPO}/actions/runs?head_sha=`)) return json({ total_count: 1, workflow_runs: [{ ...run }] });
      const at = /\/actions\/runs\/7\/attempts\/(\d+)$/.exec(path);
      if (at) return json({ id: 7, run_attempt: Number(at[1]), status: Number(at[1]) < run.run_attempt ? "completed" : run.status });
      const j = /\/actions\/runs\/7\/attempts\/(\d+)\/jobs\?/.exec(path);
      if (j) return json({ total_count: 1, jobs: [{ ...jobs[Number(j[1])], head_sha: SHA }] });
      return json({ message: "Not Found" }, 404);
    };
    const gh = makeGithub({ fetch: fetch as any });
    const d = { api: gh.api, lists: gh.lists };
    const jobsOf = (a: number) => `${REPO}/actions/runs/7/attempts/${a}/jobs?per_page=100&page=1`;
    const listing = () => asked.filter((p) => p.startsWith(`${REPO}/actions/runs?head_sha=`)).length;
    const by = (x: any) => Object.fromEntries((x as any[]).map((w) => [w.run_attempt, `${w.status} ${w.conclusion}`]));
    expect(by(await windowsAttempts(d, "HyndeSyte/harness", SHA))).toEqual({ 1: "completed failure" });
    // re-run: attempt 2 runs; every job in its list already shows done, but the run is in_progress, so nothing is kept
    Object.assign(run, { run_attempt: 2, status: "in_progress" });
    jobs[2] = { id: 102, name: "pcjobs-windows", status: "completed", conclusion: "success" };
    asked.length = 0;
    expect(by(await windowsAttempts(d, "HyndeSyte/harness", SHA))).toEqual({ 1: "completed failure", 2: "completed success" });
    expect(asked).not.toContain(jobsOf(1));                        // attempt 1's list was confirmed and kept
    expect(asked).toContain(jobsOf(2));
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(asked.filter((p) => p === jobsOf(2))).toHaveLength(2);  // not kept while the run is in_progress
    run.status = "completed";
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(asked.filter((p) => p === jobsOf(2))).toHaveLength(3);  // kept once the run says attempt 2 completed
    // a further re-run: attempt 3 is read on its own, while it runs
    Object.assign(run, { run_attempt: 3, status: "in_progress" });
    jobs[3] = { id: 103, name: "pcjobs-windows", status: "in_progress", conclusion: null };
    asked.length = 0;
    expect(by(await windowsAttempts(d, "HyndeSyte/harness", SHA))).toEqual({ 1: "completed failure", 2: "completed success", 3: "in_progress null" });
    expect(asked).toContain(jobsOf(3));
    expect(listing()).toBe(1);                                     // the run listing is read every time, never kept
  });
  test("fix 2: an earlier attempt's list is kept only after GET .../attempts/{n} says it completed", async () => {
    const asked: string[] = [];
    let earlier = "in_progress";
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      if (path.includes("/check-runs?")) return json({ total_count: 0, check_runs: [] });
      if (path.startsWith(`${REPO}/actions/runs?head_sha=`)) return json({ total_count: 1, workflow_runs: [{ id: 9, head_sha: SHA, run_attempt: 2, status: "in_progress" }] });
      if (path === `${REPO}/actions/runs/9/attempts/1`) return json({ id: 9, run_attempt: 1, status: earlier });
      if (path.includes("/jobs?")) return json({ total_count: 1, jobs: [{ id: 1, name: "tests", status: "completed", conclusion: "success" }] });
      return json({ message: "Not Found" }, 404);
    };
    const gh = makeGithub({ fetch: fetch as any });
    const d = { api: gh.api, lists: gh.lists };
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    const one = `${REPO}/actions/runs/9/attempts/1/jobs?per_page=100&page=1`;
    expect(asked.filter((p) => p === one)).toHaveLength(2);
    earlier = "completed";
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(asked.filter((p) => p === one)).toHaveLength(3);
  });
  test("round 2, 6: without a key no ETag is sent or kept (a 304 saves nothing then); conditional reads only when asked for", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    await gh.api(`${REPO}/pulls/46`); await gh.api(`${REPO}/pulls/46`);
    expect(f.asked.map((x) => x.inm)).toEqual([null, null]);
    expect(gh.hour()).toEqual({ asked: 2, kept: 0, limits: 0 });
    const g = fakeGithub();
    const authed = makeGithub({ fetch: g.fetch as any, conditional: true });
    const one = await authed.api(`${REPO}/pulls/46`), two = await authed.api(`${REPO}/pulls/46`);
    expect(g.asked.map((x) => x.inm)).toEqual([null, '"v1"']);
    expect(two.body).toEqual(one.body);
  });
  test("fix 8: two identical reads at once share one request, and every caller, the first included, gets its own copy", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    const p1 = gh.api(`${REPO}/pulls/46`), p2 = gh.api(`${REPO}/pulls/46`);
    const a = await p1;
    a.body.head.sha = "changed by the first";                      // before the second caller has run
    const b = await p2;
    expect(f.asked).toHaveLength(1);
    expect(b.body.head.sha).toBe(SHA);
    b.body.head.sha = "changed by the second";
    expect((await gh.api(`${REPO}/pulls/46`)).body.head.sha).toBe(SHA);   // and what was kept for the 304 is untouched
  });
  test("fix 5: what is left of the hour: the lowest seen in a window, never raised by an older answer; /rate_limit counted on its own", async () => {
    let t = 1_799_999_000_000;
    const reset = 1_800_000_000;
    let limit: any = { resources: { core: { limit: 60, remaining: 10, reset } } };
    let hdr = 9;
    const fetch = async (url: string) => {
      if (url.endsWith("/rate_limit")) return limit instanceof Error ? Promise.reject(limit) : json(limit);
      return json({ ok: true }, 200, H(hdr, reset));
    };
    const gh = makeGithub({ fetch: fetch as any, now: () => t });
    expect(gh.seen()).toBeNull();
    expect(await gh.rateLimit()).toEqual({ limit: 60, remaining: 10, reset: reset * 1000 });
    await gh.api(`${REPO}/pulls/1`);
    expect(gh.seen()?.remaining).toBe(9);
    limit = { resources: { core: { limit: 60, remaining: 30, reset } } };   // an older answer, or one read before: never raises it
    expect((await gh.rateLimit())?.remaining).toBe(9);
    hdr = 50;
    await gh.api(`${REPO}/pulls/2`);
    expect(gh.seen()?.remaining).toBe(8);                          // round 2: each read is charged as it goes out
    hdr = 3;
    await gh.api(`${REPO}/pulls/3`);
    expect(gh.seen()?.remaining).toBe(3);
    expect(gh.hour()).toEqual({ asked: 3, kept: 0, limits: 2 });
    expect(shortUntil(gh.seen(), RESERVE, t)).toBe(reset * 1000);
    expect(shortUntil(gh.seen(), 3, t)).toBeNull();
    t = reset * 1000 + 1;                                          // the window is over: unknown, never a full allowance
    expect(gh.seen()).toBeNull();
    limit = new Error("no answer");
    expect(await gh.rateLimit()).toBeNull();
    limit = { message: "unreadable" };
    expect(await gh.rateLimit()).toBeNull();
  });
  test("fix 5: a failed /rate_limit with nothing seen is unknown, and a reset that isn't a plausible time to come is never taken", async () => {
    const t = 1_799_999_000_000;
    for (const reset of [t / 1000 - 10, t / 1000 + 3 * 3600, 0]) {
      const gh = makeGithub({ fetch: (async (url: string) => url.endsWith("/rate_limit") ? json({ resources: { core: { limit: 60, remaining: 2, reset } } }) : json({}, 200, H(1, reset))) as any, now: () => t });
      expect(await gh.rateLimit()).toBeNull();
      await gh.api(`${REPO}/pulls/1`);
      expect(gh.seen()).toBeNull();
    }
    const down = makeGithub({ fetch: (async () => json({ message: "Server Error" }, 500)) as any, now: () => t });
    expect(await down.rateLimit()).toBeNull();
    expect(down.room(1)).toBe(false);                              // the card polling spends nothing on an unknown hour
    expect(shortUntil(null, 6, 1_000)).toBeNull();                 // a step that must go never waits on an unknown hour
  });
  test("round 2, 4: a rate-limit refusal is a 429, or a 403 with none left, a Retry-After or the secondary limit's message; when it lifts", () => {
    expect(rateRefused({ status: 429 })).toBe(true);
    expect(rateRefused({ status: 403, headers: { "x-ratelimit-remaining": "0" } })).toBe(true);
    expect(rateRefused({ status: 403, headers: { "x-ratelimit-remaining": "12", "retry-after": "90" } })).toBe(true);
    expect(rateRefused({ status: 403, headers: { "x-ratelimit-remaining": "12" }, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } })).toBe(true);
    expect(rateRefused({ status: 403, headers: { "x-ratelimit-remaining": "12" }, body: { message: "Resource not accessible by integration" } })).toBe(false);
    expect(rateRefused({ status: 403 })).toBe(false);
    expect(rateRefused({ status: 500 })).toBe(false);
    const now = 1_000_000_000_000;
    const spent = (reset: number) => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    expect(refusedUntil(spent(now / 1000 + 600), now)).toBe(now + 600_000);                   // the primary reset
    expect(refusedUntil(spent(now / 1000 - 5), now)).toBeNull();
    expect(refusedUntil(spent(now / 1000 + 9_999), now)).toBeNull();
    // Retry-After stands first, whatever is left
    expect(refusedUntil({ status: 403, headers: { "x-ratelimit-remaining": "12", "retry-after": "90", "x-ratelimit-reset": String(now / 1000 + 600) } }, now)).toBe(now + 90_000);
    expect(refusedUntil({ status: 429, headers: { "retry-after": "60" } }, now)).toBe(now + 60_000);
    // a secondary limit, or a 429, with no Retry-After: a bounded wait
    expect(refusedUntil({ status: 429, headers: {} }, now)).toBe(now + SECONDARY_WAIT_MS);
    expect(refusedUntil({ status: 403, headers: { "x-ratelimit-remaining": "12" }, body: { message: "secondary rate limit" } }, now)).toBe(now + SECONDARY_WAIT_MS);
    expect(SECONDARY_WAIT_MS).toBeLessThanOrEqual(5 * 60_000);
  });
  test("fix 7: the card polling keeps its ask before it is sent, whatever the answer, and stops at the reserve", async () => {
    const t = 1_799_999_000_000;
    let tr = t, remaining = RESERVE + 2, status = 500;
    const asked: string[] = [];
    const fetch = async (url: string) => {
      if (url.endsWith("/rate_limit")) return json({ resources: { core: { limit: 60, remaining, reset: 1_800_000_000 } } });
      asked.push(url); remaining--;
      return json({ head: { sha: SHA }, state: "open" }, status, H(remaining));
    };
    const gh = makeGithub({ fetch: fetch as any, now: () => t });
    const read = pullStateReader(gh, () => tr);   // the reader's clock moves; GitHub's window stays
    await gh.rateLimit();
    expect(await read(`${REPO}/pulls/46`)).toBeNull();             // a failed answer
    expect(asked).toHaveLength(1);
    expect(await read(`${REPO}/pulls/46`)).toBeNull();             // still counted as asked: not again within 30 minutes
    expect(asked).toHaveLength(1);
    status = 200;
    tr += PULL_STATE_EVERY_MS;
    expect((await read(`${REPO}/pulls/46`))?.state).toBe("open");  // RESERVE + 1 left: one more, and then it is at the reserve
    expect(remaining).toBe(RESERVE);
    tr += PULL_STATE_EVERY_MS;
    expect(await read(`${REPO}/pulls/46`)).toBeNull();
    expect(asked).toHaveLength(2);                                 // never below the reserve
  });
  test("fix 7: his tap's landing reads the pull request again each time, even right after the card polling read it", async () => {
    let state = "open";
    const asked: string[] = [];
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      if (path === `${REPO}/pulls/46`) return json({ state, head: { sha: SHA, repo: { full_name: "HyndeSyte/harness" } }, base: { ref: "main", sha: BASE } }, 200, { etag: `"${state}"` });
      return json({ message: "Not Found" }, 404);
    };
    const gh = makeGithub({ fetch: fetch as any });
    const t = 1_799_999_000_000;
    await pullStateReader({ api: gh.api, room: () => true }, () => t)(`${REPO}/pulls/46`);
    const git = async (): Promise<Git> => ({ code: 1, out: "", err: "" });
    const one = await land({ api: gh.api, git, stopped: () => false }, { repo: "HyndeSyte/harness", pr: 46, head: SHA });
    expect(one).toEqual({ ok: false, why: "GitHub doesn't have that commit", again: false });
    state = "closed";
    const two = await land({ api: gh.api, git, stopped: () => false }, { repo: "HyndeSyte/harness", pr: 46, head: SHA });
    expect(two).toEqual({ ok: false, why: "the pull request was closed", again: false });
    expect(asked.filter((p) => p === `${REPO}/pulls/46`)).toHaveLength(3);
  });
  test("shortUntil: short only with too little left before a reset still to come; unknown holds nothing back", () => {
    const b = { limit: 60, remaining: 5, reset: 2_000 };
    expect(shortUntil(b, 6, 1_000)).toBe(2_000);
    expect(shortUntil(b, 5, 1_000)).toBeNull();
    expect(shortUntil(b, 6, 2_000)).toBeNull();                   // the hour has reset
    expect(shortUntil(null, 6, 1_000)).toBeNull();
  });
});

// fix 6: what a card, a landing and a registration read, counted with nothing kept, against the constants.
describe("the reads each step makes stay within its constant", () => {
  const configs: Record<string, string> = {
    [`cain/config.yaml@${BASE}`]: 'version: "0.19.3"\n', [`cain/config.yaml@${SHA}`]: 'version: "0.19.4"\n',
    [`harness/config.yaml@${BASE}`]: 'version: "0.30.0"\n', [`harness/config.yaml@${SHA}`]: 'version: "0.30.0"\n',
    [`.github/workflows/tests.yml@${SHA}`]: "jobs:\n  pcjobs-windows:\n", [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: "// the probe\n",
  };
  function counted(runs: number, fp = "") {
    const asked: string[] = [];
    const files = { ...configs, ...(fp ? { [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: `${fp}\n` } : {}) };
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      if (path === `${REPO}/pulls/46`) return json({ state: "open", merged: false, commits: 3, changed_files: 4, title: "t", head: { sha: SHA, repo: { full_name: "HyndeSyte/harness" } }, base: { ref: "main", sha: BASE } });
      if (path.startsWith(`${REPO}/pulls/46/files?`)) return json([{ filename: "cain/config.yaml" }]);
      const c = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
      if (c) { const t = files[`${c[1]}@${c[2]}`]; return t ? json({ content: Buffer.from(t).toString("base64"), encoding: "base64" }) : json({ message: "Not Found" }, 404); }
      const cr = /\/check-runs\?check_name=([^&]+)/.exec(path);
      if (cr) { const name = decodeURIComponent(cr[1]); return json({ total_count: 1, check_runs: [{ id: 1, name, status: "completed", conclusion: "success", head_sha: SHA, app: { id: 15368 } }] }); }
      if (path.startsWith(`${REPO}/actions/runs?head_sha=`))
        return json({ total_count: runs, workflow_runs: Array.from({ length: runs }, (_, i) => ({ id: 100 + i, head_sha: SHA, run_attempt: 1, status: "completed" })) });
      const j = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs\?/.exec(path);
      if (j) return json({ total_count: 1, jobs: [{ id: Number(j[1]) === 100 ? 1 : Number(j[1]) * 10, name: Number(j[1]) === 100 ? "pcjobs-windows" : "tests", status: "completed", conclusion: "success", head_sha: SHA }] });
      return json({ message: "Not Found" }, 404);
    };
    return { asked, gh: makeGithub({ fetch: fetch as any }) };
  }
  // round 2, 8: the exact counts, which DOCS and the pull request quote (one under each constant at 15 runs)
  const COUNTS: Record<number, { card: number; land: number; reg: number }> = { 6: { card: 18, land: 13, reg: 7 }, 10: { card: 22, land: 17, reg: 7 }, 15: { card: 27, land: 22, reg: 7 } };
  for (const runs of [6, 10, 15]) {
    test(`with ${runs} workflow runs on the head: a card at most ${CARD_ASKS}, a landing at most ${LAND_ASKS}, a registration at most ${REG_ASKS}`, async () => {
      const card = counted(runs);
      const [f, checks] = await Promise.all([facts(card.gh, "HyndeSyte/harness", 46, SHA), headChecks(card.gh, "HyndeSyte/harness", SHA)]);
      expect(f?.bumps).toEqual([{ app: "Cain", version: "0.19.4" }]);
      expect(checks && checks !== "missing" && checks.windows).toBe(true);
      expect(card.asked.length).toBeLessThanOrEqual(CARD_ASKS);
      expect(card.asked.length).toBe(COUNTS[runs].card);
      const landing = counted(runs);
      const git = async (args: string[]): Promise<Git> => {
        if (args[0] === "rev-parse") return { code: 0, out: `${SHA}\n`, err: "" };
        if (args[0] === "merge-base") return { code: args[2] === SHA ? 1 : 0, out: "", err: "" };
        return { code: 0, out: "", err: "" };
      };
      expect(await land({ api: landing.gh.api, git, stopped: () => false }, { repo: "HyndeSyte/harness", pr: 46, head: SHA })).toEqual({ ok: true, already: false, base: BASE });
      expect(landing.asked.length).toBeLessThanOrEqual(LAND_ASKS);
      expect(landing.asked.length).toBe(COUNTS[runs].land);
      const keys = generateKeyPairSync("ed25519");
      const fp = keyFingerprint(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
      const reg = counted(runs, fp);
      const acc = { status: "accepted", id: "ship-46-cain-01234567", app: "0fcc2575_cain", from_version: "0.19.3", to_version: "0.19.4", backup: "kb1", key_fp: fp,
        key_confirmed_at: new Date(Date.now() - 3_600_000).toISOString(), state_created: new Date(Date.now() - 7_200_000).toISOString(), enroll_id: "0123456789abcdef", counter: 1 };
      const r = await registerInstalls({ api: reg.gh.api, log: () => {}, linkFp: fp, sleep: async () => {}, enrollment: { load: () => null, store: () => {} },
        post: async () => ({ status: 202, body: { status: "pending", id: acc.id } }), get: async () => ({ status: 200, body: acc }) } as any, "tok", claimFor("https://github.com/HyndeSyte/harness/pull/46", SHA, Date.now())!);
      expect(r.ok).toBe(true);
      expect(reg.asked.length).toBeLessThanOrEqual(REG_ASKS);
      expect(reg.asked.length).toBe(COUNTS[runs].reg);
    });
  }
});

describe("a Ship card and his tap, short of GitHub's hour (core.ts)", () => {
  const FACTS = { head: SHA1, commits: 2, files: 3, areas: ["Cain's link"], title: "t", bumps: [{ app: "Cain", version: "0.19.3" }], merged: false };
  const shipRig = () => { const r = rig({ facts: true }); r.github.facts = structuredClone(FACTS) as any; return r; };
  const ship = (r: ReturnType<typeof rig>) => r.link.ship({ text: "Ship taps go through even on busy days.", item: "P70", pr: LINK_PR, head: SHA1 });
  const snap = (m: any) => JSON.parse(JSON.stringify(m));
  const sweep = async (r: ReturnType<typeof rig>) => { await r.link.sweep(); await r.link.whenLanded(); };
  const shipping = (r: ReturnType<typeof rig>, id: string) => (r.state().messages as any)[id].shipping;

  test("fix 6: too little left to read the card: the old card goes, its facts unread, with a line saying so, and nothing is read", async () => {
    const r = shipRig();
    r.github.budget = { limit: 60, remaining: CARD_ASKS - 1, reset: r.t.now + 20 * MIN };
    const id = ((await ship(r)) as any).message;
    const text = String(r.msg(id).content);
    expect(text.split("\n")[0]).toBe("Ship it?");
    expect(text).toContain("From GitHub: the pull request couldn't be read just now.");
    expect(text).toContain("GitHub's hourly allowance for the link's reads is low until 8:20 AM, so this card's facts and checks weren't read; Ship reads them before it lands.");
    expect(r.github.asked).toEqual([]);
    r.github.budget = { limit: 60, remaining: LAND_ASKS - 1, reset: r.t.now + 20 * MIN };
    const id2 = ((await r.link.ship({ text: "Again.", item: "P70", pr: LINK_PR, head: SHA1 })) as any).message;
    expect(String(r.msg(id2).content)).toContain("weren't read; Ship reads them before it lands, and a Ship tap now waits until 8:20 AM and lands by itself.");
  });
  test("fix 6: enough for the card but not his tap's landing after it: the card says a tap waits until the reset", async () => {
    const r = shipRig();
    r.github.budget = { limit: 60, remaining: CARD_ASKS + LAND_ASKS - 1, reset: r.t.now + 20 * MIN };
    const id = ((await ship(r)) as any).message;
    expect(String(r.msg(id).content)).toContain("GitHub's hourly allowance for the link's reads is low until 8:20 AM: a Ship tap now waits until then, and lands and installs by itself.");
    expect(r.github.asked.length).toBeGreaterThan(0);
  });
  test("enough left: the card is as before", async () => {
    const r = shipRig();
    r.github.budget = { limit: 60, remaining: CARD_ASKS + LAND_ASKS, reset: r.t.now + 20 * MIN };
    const id = ((await ship(r)) as any).message;
    expect(String(r.msg(id).content)).not.toContain("allowance");
    expect(r.book.reserved()).toEqual({});                         // its own reservation is let go once it is built
  });
  test("round 2, 5: nothing known of the hour: a card build reads nothing, and says so", async () => {
    const r = shipRig();
    r.github.budget = null;
    const id = ((await ship(r)) as any).message;
    expect(String(r.msg(id).content)).toContain(BUDGET_UNKNOWN_LINE);
    expect(r.github.asked).toEqual([]);
  });
  test("fix 3: his tap short of the landing's reads waits for the reset by itself, holds its reads, isn't a try, then lands with no new tap", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    const tapped = r.t.now;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 20 * MIN };
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([]);
    expect(r.book.reserved()[`tap:${id}`]).toBe(LAND_ASKS);       // round 2: its reads reserved while it waits
    expect(String(r.msg(id).content)).toContain("You tapped Ship. Waiting: GitHub's hourly allowance for the link's reads is spent until 8:20 AM. It lands by itself as soon as it can.");
    expect(r.relayed.at(-1)).toContain("the link keeps trying for up to 2 hours and lands it by itself");
    expect(shipping(r, id).tries ?? 0).toBe(0);                    // a wait only for the budget isn't a try
    expect(shipping(r, id).next).toBe(tapped + 20 * MIN + 5_000);
    r.later(10 * MIN);
    await sweep(r);
    expect(r.github.landings).toEqual([]);                         // not before the reset
    r.later(11 * MIN);
    r.github.budget = { limit: 60, remaining: 60, reset: r.t.now + HOUR_MS };
    r.github.answers.push({ ok: true, already: false, base: BASE });
    await sweep(r);
    expect(r.github.landings).toEqual([{ pr: LINK_PR, head: SHA1 }]);
    expect(String(r.msg(id).content)).toContain("Shipped: it's in main as of 8:21 AM. Installing it is next.");
    expect(r.relayed.at(-1)).toContain("Ship token: ");
    expect(r.link.landedBase(LINK_PR, SHA1)).toBe(BASE);           // fix 4: the registration binds to it
    expect(r.book.reserved()[`tap:${id}`]).toBeUndefined();        // released once it landed
  });
  test("fix 3: a reset past his tap's 2 hours: never waited for; the card says plainly the tap runs out, and when to tap again", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    const tapped = r.t.now;
    r.github.answers.push({ ok: false, why: "CI is still running bun on it", again: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.t.now = tapped + 100 * MIN;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 30 * MIN };   // resets at 10:10, after the tap's 2 hours end at 10:00
    const before = r.github.landings.length;
    await sweep(r);
    expect(r.github.landings.length).toBe(before);
    const text = String(r.msg(id).content);
    expect(text).not.toContain("lands by itself");
    expect(text).toContain("Not shipped: GitHub's hourly allowance for the link's reads is spent until");
    expect(text).toContain("after the tap's 2 hours run out at 10:00 AM, so this tap can't land it: a Ship tap on a new card can go at 10:11 AM or later");
    expect(shipping(r, id).state).toBe("not landed");
    expect(r.book.reserved()[`tap:${id}`]).toBeUndefined();
  });
  test("fix 3: a try is never set past his tap's 2 hours", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    const tapped = r.t.now;
    r.github.answers.push({ ok: false, why: "CI is still running bun on it", again: true });
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.t.now = tapped + 118 * MIN;                                  // its next try would be 4 minutes on: past the 2 hours
    r.github.answers.push({ ok: false, why: "CI is still running bun on it", again: true });
    await sweep(r);
    expect(shipping(r, id).next).toBe(tapped + 2 * HOUR_MS);
  });
  test("fix 3: a Stop during the wait: nothing lands at the reset", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 20 * MIN };
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.later(5 * MIN);
    r.stop.stopped = true; r.stop.at = r.t.now;
    r.later(16 * MIN);
    r.github.budget = { limit: 60, remaining: 60, reset: r.t.now + HOUR_MS };
    await sweep(r);
    expect(r.github.landings).toEqual([]);
    expect(shipping(r, id).state).toBe("not landed");
    expect(String(r.msg(id).content)).toContain("Stop came before it landed");
  });
  test("fix 3: two sweeps at the reset land it once", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 20 * MIN };
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.later(21 * MIN);
    r.github.budget = { limit: 60, remaining: 60, reset: r.t.now + HOUR_MS };
    await Promise.all([r.link.sweep(), r.link.sweep()]);
    await r.link.sweep();
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([{ pr: LINK_PR, head: SHA1 }]);
    expect(r.relayed.filter((l) => l.includes("Ship token: "))).toHaveLength(1);
  });
});
const HOUR_MS = 60 * MIN;

describe("the Ship run's registration and GitHub's hour (ship-pass.ts)", () => {
  const SHIP_KEYS = generateKeyPairSync("ed25519");
  const SHIP_PUB = SHIP_KEYS.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const FPR = keyFingerprint(SHIP_PUB);
  const PR = "https://github.com/HyndeSyte/harness/pull/46";
  const NOW = Date.UTC(2026, 10, 27, 22, 18);                       // 5:18 PM in his time zone
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const files: Record<string, any> = {
    [`cain/config.yaml@${BASE}`]: b64('version: "0.19.2"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.3"\n'),
    [`harness/config.yaml@${BASE}`]: b64('version: "0.30.0"\n'), [`harness/config.yaml@${SHA}`]: b64('version: "0.30.0"\n'),
    [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"),
    [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`# the link's Ship key\n${FPR}\n`),
  };
  const ENROLLED = { key_fp: FPR, key_confirmed_at: new Date(NOW - 3_600_000).toISOString(), state_created: new Date(NOW - 7_200_000).toISOString(), enroll_id: "0123456789abcdef", counter: 10 };
  const attempt = "ship-46-cain-01234567";
  const acceptance = { status: "accepted", id: attempt, app: "0fcc2575_cain", from_version: "0.19.2", to_version: "0.19.3", backup: "kb1", until: "x", ...ENROLLED };

  // refuse: how many reads GitHub refuses, and how (status and headers), from the first read on
  function run(o: { remaining: number; refuse?: number; how?: { status: number; headers: Record<string, string> }; resetIn?: number; landing?: string | null; active?: () => boolean }) {
    let now = NOW;
    const reset = NOW + (o.resetIn ?? 25 * MIN);
    const reads: string[] = [], sleeps: number[] = [], notes: any[] = [], logs: string[] = [], posted: any[] = [], order: string[] = [];
    let refuse = o.refuse ?? 0;
    let remaining = o.remaining;
    const how = o.how ?? { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(reset / 1000)) } };
    const api = async (path: string) => {
      reads.push(path); order.push("read");
      if (refuse > 0) { refuse--; remaining = 0; return { status: how.status, body: { message: "API rate limit exceeded" }, headers: how.headers }; }
      if (path === `${REPO}/pulls/46`) return { status: 200, body: { base: { sha: BASE } }, headers: {} };
      const m = /contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
      const f = m ? files[`${m[1]}@${m[2]}`] : undefined;
      return f ? { status: 200, body: f, headers: {} } : { status: 404, body: null, headers: {} };
    };
    const deps = { api, log: (l: string) => logs.push(l), now: () => now, sleep: async (ms: number) => { sleeps.push(ms); order.push("sleep"); now += ms; if (now >= reset) remaining = 60; },
      note: (u: any) => { notes.push(u); order.push(`note ${Object.keys(u)[0]}`); }, linkFp: FPR, tz: "America/New_York",
      budget: async () => ({ limit: 60, remaining, reset }),
      landing: o.landing === undefined ? undefined : () => o.landing, active: o.active,
      enrollment: { load: () => null, store: () => {} },
      post: async (b: any) => { posted.push(b); return { status: 202, body: { status: "pending", id: attempt } }; },
      get: async () => ({ status: 200, body: acceptance }) };
    return { deps, reads, sleeps, notes, logs, posted, order, reset, get now() { return now; } };
  }
  const claim = () => claimFor(PR, SHA, NOW)!;

  test("short before it reads: bound to the landing's base (kept first, nothing read), it waits for the reset, says until when, and registers by itself", async () => {
    const k = run({ remaining: 3, landing: BASE });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r.ok).toBe(true);
    expect(k.order.slice(0, 3)).toEqual(["note base", "note waitUntil", "sleep"]);
    expect(k.notes[0]).toEqual({ base: BASE });
    expect(k.notes[1]).toEqual({ waitUntil: k.reset });
    expect(k.sleeps.filter((ms) => ms >= MIN)).toEqual([25 * MIN + 5_000]);
    expect(k.logs[0]).toContain("so it waits until 5:43 PM and then goes on by itself");
    expect(k.reads).not.toContain(`${REPO}/pulls/46`);              // the landing's base: the pull request isn't read
  });
  test("with no landing known here, the pull request's base is read and kept before the wait", async () => {
    const k = run({ remaining: 3 });
    expect((await registerInstalls(k.deps as any, "tok", claim())).ok).toBe(true);
    expect(k.order.slice(0, 4)).toEqual(["read", "note base", "note waitUntil", "sleep"]);
  });
  test("a read refused for the rate limit (the Nov 27 failure, a 403 with none left) waits once for the reset and is read again", async () => {
    const k = run({ remaining: 40, refuse: 1, landing: BASE });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r.ok).toBe(true);
    expect(k.sleeps.filter((ms) => ms >= MIN)).toEqual([25 * MIN + 5_000]);
    expect(k.notes.some((n) => n.waitUntil === k.reset)).toBe(true);
  });
  test("a 429 with Retry-After waits too; refusals while it waits share the one wait, and a refusal after it never waits again", async () => {
    const k = run({ remaining: 40, refuse: 4, landing: BASE, how: { status: 429, headers: { "retry-after": "600" } } });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(k.sleeps.filter((ms) => ms >= MIN)).toEqual([10 * MIN + 5_000]);                 // the four config reads go at once: one wait between them
    expect(r.ok).toBe(true);
    const twice = run({ remaining: 40, refuse: 6, landing: BASE });
    const r2 = await registerInstalls(twice.deps as any, "tok", claim());
    expect(r2.ok).toBe(false);
    expect(twice.sleeps.filter((ms) => ms >= MIN)).toHaveLength(1);                          // all its waiting: one reset at most
  });
  test("ordinary failures never wait: a 403 that isn't the rate limit, a 500", async () => {
    for (const how of [{ status: 403, headers: { "x-ratelimit-remaining": "31" } }, { status: 500, headers: {} }]) {
      const k = run({ remaining: 40, refuse: 99, landing: BASE, how });
      const r = await registerInstalls(k.deps as any, "tok", claim());
      expect(r.ok).toBe(false);
      expect(k.sleeps).toEqual([]);
      expect(r.said[0]).toBe("what the tap installs couldn't be read, so nothing was registered");
    }
  });
  test("a reset the tap won't outlast: refused at once, plainly, with the time to tap again, and nothing waits or reaches the keeper", async () => {
    const late = claimFor(PR, SHA, NOW - 100 * MIN)!;               // the tap was 100 minutes ago: 20 left
    const k = run({ remaining: 3, landing: BASE, resetIn: 25 * MIN });
    const r = await registerInstalls(k.deps as any, "tok", late);
    expect(r).toEqual({ ok: false, plain: true, said: [`GitHub's hourly allowance for the link's reads is spent until 5:43 PM (3 of 60 left), after this Ship tap runs out at 5:38 PM, so nothing was registered: a Ship tap on a new card can go at 5:44 PM or later`] });
    expect(k.sleeps).toEqual([]);
    expect(k.posted).toEqual([]);
    const refused = run({ remaining: 40, refuse: 1, landing: BASE, resetIn: 25 * MIN });
    const r2 = await registerInstalls(refused.deps as any, "tok", late);
    expect(r2.ok).toBe(false);
    expect(r2.said[0]).toContain("after this Ship tap runs out at 5:38 PM");
    expect(refused.sleeps).toEqual([]);
  });
  test("the pass ended during the wait (a Stop, the hook's cancel): nothing is registered after waking", async () => {
    let live = true;
    const k = run({ remaining: 3, landing: BASE, active: () => live });
    const sleep = k.deps.sleep;
    k.deps.sleep = async (ms: number) => { live = false; await sleep(ms); };
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r).toEqual({ ok: false, plain: true, said: ["the pass ended while the link waited for GitHub's hourly allowance, so nothing was registered"] });
    expect(k.posted).toEqual([]);
  });
  test("before each keeper write the pass must still be registering", async () => {
    const k = run({ remaining: 60, landing: BASE, active: () => false });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r.ok).toBe(false);
    expect(r.said).toEqual(["the pass ended before the link registered the install, so nothing was registered"]);
    expect(k.posted).toEqual([]);
  });
  test("enough left: no wait", async () => {
    const k = run({ remaining: 60 });
    expect((await registerInstalls(k.deps as any, "tok", claim())).ok).toBe(true);
    expect(k.notes.some((n) => "waitUntil" in n)).toBe(false);
    expect(k.sleeps.every((ms) => ms < MIN)).toBe(true);
  });
  function passRig() {
    let file: string | null = null, now = NOW, note: ((u: any) => void) | null = null, done: ((r: RegResult) => void) | null = null, active: (() => boolean) | null = null;
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => now, load: () => file, store: (t) => { file = t; }, tz: "America/New_York",
      register: (_t, _c, dn, n, a) => { note = n; done = dn; active = a ?? null; n({ apps: 1 }); }, log: () => {} };
    const token = makeToken(claim(), (x) => edSign(null, x, SHIP_KEYS.privateKey));
    return { d, token, later: (ms: number) => { now += ms; }, note: (u: any) => note!(u), done: (r: RegResult) => done!(r), active: () => active!(),
      get file() { return file; }, set file(t: string | null) { file = t; } };
  }
  test("the pass stays pending through the wait, and the hook's line says when to start the same run again", async () => {
    const p = passRig();
    expect((await shipPass(p.d, { token: p.token })).status).toBe("pending");
    p.note({ waitUntil: NOW + 25 * MIN });
    p.later(20 * MIN);                                             // past the usual 6 minute wait: still pending
    const a = await shipPass(p.d, { token: p.token });
    expect(a).toEqual({ status: "pending", said: budgetPendingSaid(NOW + 25 * MIN, "America/New_York") });
    expect((a as any).said).toContain("spent until 5:43 PM");
    expect((a as any).said).toContain("start the same Ship run again at 5:44 PM");
    p.later(7 * MIN);
    expect((await shipPass(p.d, { token: p.token })).status).toBe("pending");  // within the usual wait after the reset
    expect(p.active()).toBe(true);
    p.done({ ok: true, accepted: [], said: [] });
    expect(["ok", "pending"]).toContain((await shipPass(p.d, { token: p.token })).status);
  });
  test("a budget refusal is the pass's reason as it stands, not the keeper's", async () => {
    const p = passRig();
    await shipPass(p.d, { token: p.token });
    p.done({ ok: false, plain: true, said: ["GitHub's hourly allowance for the link's reads is spent until 5:43 PM, after this Ship tap runs out at 5:38 PM, so nothing was registered"] });
    const a = await shipPass(p.d, { token: p.token });
    expect(a.status).toBe("refused");
    expect((a as any).said).toStartWith("GitHub's hourly allowance");
    expect((a as any).said).not.toContain("the keeper didn't accept");
  });
  test("at start, a pass left registering with a wait time is refused with the budget's reason, never as the keeper's wait running out", async () => {
    const p = passRig();
    await shipPass(p.d, { token: p.token });
    p.note({ waitUntil: NOW + 25 * MIN });
    const kept = p.file;
    // a restart: a new process (new deps), the same file, the hook asking before the reconcile has run
    const fresh: PassDeps = { ...p.d, load: () => p.file, store: (t) => { p.file = t; } };
    p.later(40 * MIN);
    const a = await shipPass(fresh, { token: p.token });
    expect(a.status).toBe("refused");
    expect((a as any).said).toContain(budgetRestartSaid(NOW + 25 * MIN, "America/New_York"));
    expect((a as any).said).not.toContain("within");
    p.file = kept;
    expect(await reconcilePasses(fresh)).toBe(1);
    expect(JSON.parse(p.file!).spent.find((x: any) => x.id === passId(p.token)).said).toBe(budgetRestartSaid(NOW + 25 * MIN, "America/New_York"));
  });
});

// Review round 2: one test or more for each fix.
describe("review round 2", () => {
  const route = (path: string, runs: any[], jobs: (run: number, attempt: number, page: number) => any) => {
    if (path.includes("/check-runs?")) return json({ total_count: 0, check_runs: [] });
    if (path.startsWith(`${REPO}/actions/runs?head_sha=`)) return json({ total_count: runs.length, workflow_runs: runs });
    const j = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/.exec(path);
    if (j) return json(jobs(Number(j[1]), Number(j[2]), Number(j[3])));
    return json({ message: "Not Found" }, 404);
  };
  test("1: a job list whose read resolves before the run reads completed is never kept; it is read once more after that", async () => {
    const run = { id: 7, head_sha: SHA, run_attempt: 1, status: "in_progress" };
    const asked: string[] = [];
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      return route(path, [{ ...run }], () => {
        run.status = "completed";                                   // the run finishes while its list is read
        return { total_count: 1, jobs: [{ id: 101, name: "pcjobs-windows", status: "completed", conclusion: "success", head_sha: SHA }] };
      });
    };
    const gh = makeGithub({ fetch: fetch as any });
    const d = { api: gh.api, lists: gh.lists };
    const list = `${REPO}/actions/runs/7/attempts/1/jobs?per_page=100&page=1`;
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(asked.filter((p) => p === list)).toHaveLength(1);
    await windowsAttempts(d, "HyndeSyte/harness", SHA);          // the listing now says completed: read once more, then kept
    expect(asked.filter((p) => p === list)).toHaveLength(2);
    await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(asked.filter((p) => p === list)).toHaveLength(2);
  });
  test("1: every page is read, a failing job on a later page is seen, and the list is kept only whole", async () => {
    const asked: string[] = [];
    const ok = (i: number) => ({ id: 1000 + i, name: "tests", status: "completed", conclusion: "success", head_sha: SHA });
    let page2 = 200;
    const fetch = async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      asked.push(path);
      return route(path, [{ id: 8, head_sha: SHA, run_attempt: 1, status: "completed" }], (_r, _a, page) => page === 1
        ? { total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => ok(i)) }
        : page2 === 200 ? { total_count: 101, jobs: [{ id: 5, name: "pcjobs-windows", status: "completed", conclusion: "failure", head_sha: SHA }] } : null);
    };
    const gh = makeGithub({ fetch: fetch as any });
    const d = { api: gh.api, lists: gh.lists };
    page2 = 500;                                                    // a later page that fails: nothing judged, nothing kept
    expect(await windowsAttempts(d, "HyndeSyte/harness", SHA)).toBeNull();
    page2 = 200;
    const one = await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect((one as any[]).map((w) => w.conclusion)).toEqual(["failure"]);
    const pages = () => asked.filter((p) => p.includes("/attempts/1/jobs?")).length;
    const before = pages();
    const two = await windowsAttempts(d, "HyndeSyte/harness", SHA);
    expect(pages()).toBe(before);                                   // kept whole
    expect((two as any[]).map((w) => w.conclusion)).toEqual(["failure"]);
  });

  test("4: a landing refused by GitHub's rate limit waits until it lifts: a 403 with Retry-After and reads left, a 429 with and without", async () => {
    const t = 1_799_999_000_000;
    for (const [how, until] of [
      [{ status: 403, headers: { "x-ratelimit-remaining": "12", "retry-after": "120" } }, t + 120_000],
      [{ status: 429, headers: { "retry-after": "60" } }, t + 60_000],
      [{ status: 429, headers: {} }, t + SECONDARY_WAIT_MS],
    ] as const) {
      const api = async () => ({ status: how.status, body: { message: "slow down" }, headers: how.headers as Record<string, string> });
      const r = await land({ api, git: async () => ({ code: 0, out: "", err: "" }), stopped: () => false, now: () => t }, { repo: "HyndeSyte/harness", pr: 46, head: SHA });
      expect(r).toEqual({ ok: false, again: true, why: "GitHub refused a read for its rate limit", until, budget: true });
    }
  });
  test("4: his tap, refused by GitHub's rate limit, waits until it lifts; past his 2 hours it ends saying when to tap again", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.answers.push({ ok: false, again: true, why: "GitHub refused a read for its rate limit", until: r.t.now + 10 * MIN, budget: true });
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(String(r.msg(id).content)).toContain("Waiting: GitHub's rate limit holds the link's reads until 8:10 AM.");
    expect((r.state().messages as any)[id].shipping.next).toBe(r.t.now + 10 * MIN + 5_000);
    expect(r.book.reserved()[`tap:${id}`]).toBe(LAND_ASKS);
    r.later(10 * MIN + 5_000);
    r.github.answers.push({ ok: false, again: true, why: "GitHub refused a read for its rate limit", until: r.t.now + 2 * HOUR_MS, budget: true });
    await r.link.sweep(); await r.link.whenLanded();
    expect(String(r.msg(id).content)).toContain("Not shipped: GitHub's rate limit holds the link's reads until 10:10 AM, after the tap's 2 hours run out at 10:00 AM, so this tap can't land it: a Ship tap on a new card can go at 10:11 AM or later.");
  });
  test("4: the registration waits on a 403 with Retry-After and reads left, and on a 429 with or without Retry-After", async () => {
    for (const [how, ms] of [
      [{ status: 403, headers: { "x-ratelimit-remaining": "40", "retry-after": "120" } }, 2 * MIN],
      [{ status: 429, headers: { "retry-after": "300" } }, 5 * MIN],
      [{ status: 429, headers: {} }, SECONDARY_WAIT_MS],
    ] as const) {
      const k = runReg({ remaining: 40, refuse: 1, landing: BASE, how: how as any });
      const r = await registerInstalls(k.deps as any, "tok", regClaim());
      expect(r.ok).toBe(true);
      expect(k.sleeps.filter((x) => x >= MIN)).toEqual([ms + 5_000]);
    }
  });
  test("4: the expiry checks apply to the time a refusal gives: a Retry-After past the tap refuses at once", async () => {
    const late = claimFor(REG_PR, SHA, REG_NOW - 100 * MIN)!;           // 20 minutes left
    const k = runReg({ remaining: 40, refuse: 1, landing: BASE, how: { status: 403, headers: { "x-ratelimit-remaining": "40", "retry-after": "1800" } } });
    const r = await registerInstalls(k.deps as any, "tok", late);
    expect(r.ok).toBe(false);
    expect(r.said[0]).toContain("after this Ship tap runs out at 5:38 PM");
    expect(k.sleeps).toEqual([]);
  });

  test("5: two reservations at the reset never take the same reads: the older is covered first, and a read past one's share isn't sent", async () => {
    const t = 1_799_999_000_000;
    let remaining = 30, sent = 0;
    const fetch = async (url: string) => {
      if (url.endsWith("/rate_limit")) return json({ resources: { core: { limit: 60, remaining, reset: 1_800_000_000 } } });
      sent++; remaining--;
      return json({ ok: true }, 200, H(remaining));
    };
    const gh = makeGithub({ fetch: fetch as any, now: () => t });
    await gh.rateLimit();
    gh.book.reserve("tap:a", LAND_ASKS, t + HOUR_MS);
    gh.book.reserve("pass:b", LAND_ASKS, t + HOUR_MS);
    expect([gh.book.spare("tap:a"), gh.book.spare("pass:b"), gh.book.spare("card:x"), gh.book.spare()]).toEqual([LAND_ASKS, 30 - LAND_ASKS, 0, 0]);
    for (let i = 0; i < LAND_ASKS; i++) expect((await gh.api(`${REPO}/pulls/${i}`, { as: "tap:a" })).status).toBe(200);
    const over = await gh.api(`${REPO}/pulls/x`, { as: "tap:a" });
    expect(over.status).toBe(429);                                  // b's reads are b's
    expect(over.headers["x-cain-local"]).toBe("1");
    expect(rateRefused(over)).toBe(true);
    for (let i = 0; i < 30 - LAND_ASKS; i++) expect((await gh.api(`${REPO}/pulls/b${i}`, { as: "pass:b" })).status).toBe(200);
    expect((await gh.api(`${REPO}/pulls/y`, { as: "pass:b" })).status).toBe(429);
    expect(sent).toBe(30);
    expect(gh.hour().asked).toBe(30);
  });
  test("5: a read answered from what was kept or shared in flight isn't charged", async () => {
    const t = 1_799_999_000_000;
    const fetch = async (url: string) => url.endsWith("/rate_limit") ? json({ resources: { core: { limit: 60, remaining: 10, reset: 1_800_000_000 } } })
      : json({ content: "eA==", encoding: "base64" }, 200, H(9));
    const gh = makeGithub({ fetch: fetch as any, now: () => t });
    await gh.rateLimit();
    gh.book.reserve("tap:a", 5, t + HOUR_MS);
    const path = `${REPO}/contents/x?ref=${SHA}`;
    await Promise.all([gh.api(path, { as: "tap:a" }), gh.api(path, { as: "tap:a" })]);
    await gh.api(path, { as: "tap:a" });
    expect(gh.book.reserved()).toEqual({ "tap:a": 4 });
    expect(gh.seen()?.remaining).toBe(9);
  });
  test("5: a book with nothing known gives nothing to spare; an expired reservation goes", () => {
    let t = 1_000;
    let b: any = null;
    const book = makeBook(() => b, () => t);
    expect(book.spare("tap:a")).toBeNull();
    b = { limit: 60, remaining: 20, reset: 9_000 };
    book.reserve("tap:a", 15, 5_000);
    expect(book.spare()).toBe(5);
    t = 5_000;
    expect(book.spare()).toBe(20);
  });
  test("5: a warm-cache landing below the old floor goes ahead at once", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.budget = { limit: 60, remaining: 10, reset: r.t.now + 20 * MIN };   // under the 23 a cold landing could take
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([{ pr: LINK_PR, head: SHA1 }]);
    expect(r.github.lands[0].key).toBe(`tap:${id}`);                // its reads are charged to its own reservation
    expect(String(r.msg(id).content)).toContain("Shipped: it's in main");
  });
  test("5: a card build at the reset while a tap waits leaves the tap's reads", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 20 * MIN };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.book.reserved()[`tap:${id}`]).toBe(LAND_ASKS);
    r.later(20 * MIN + 1);
    r.github.budget = { limit: 60, remaining: 40, reset: r.t.now + HOUR_MS };   // 40 at the reset: 23 of them the tap's
    r.github.asked.length = 0;
    const card = ((await r.link.ship({ text: "Another change.", item: "P71", pr: "https://github.com/HyndeSyte/harness/pull/6", head: SHA1 })) as any).message;
    expect(String(r.msg(card).content)).toContain("so this card's facts and checks weren't read");
    expect(r.github.asked).toEqual([]);
    expect(r.book.reserved()[`tap:${id}`]).toBe(LAND_ASKS);
  });

  test("2: a Stop just before the ship lock: the push never starts", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.beforePush = () => { r.stop.stopped = true; r.stop.at = r.t.now; };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.pushed).toEqual([]);
    expect(String(r.msg(id).content)).toContain("Stop came before it landed");
  });
  test("2: a Stop that arrives while the push starts waits for the lock: the push was first, and no Ship token follows", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    let stopped: Promise<void> | null = null;
    r.github.duringPush = () => { stopped = r.link.shipExclusive(() => { r.stop.stopped = true; r.stop.at = r.t.now; }); };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    await stopped;
    expect(r.github.pushed).toEqual([SHA1]);
    expect(String(r.msg(id).content)).toContain("Installing it waits until you turn things back on.");
    expect(r.relayed.filter((l) => l.includes("Ship token: "))).toHaveLength(0);
  });
  test("2: the push's claim is kept before it starts, and a second worker finding it claimed doesn't push", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.duringPush = () => { expect((r.state().messages as any)[id].shipping.pushing).toBeDefined(); };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect((r.state().messages as any)[id].shipping.pushing).toBeUndefined();   // its result kept: the claim is cleared
    expect(r.github.pushed).toEqual([SHA1]);
  });
  test("2: a restart after a push that went through but whose result was never kept: main is read first, and nothing lands twice", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.afterPush = () => new Promise<void>(() => {});           // the link stops right after the push
    void r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    for (let i = 0; i < 20 && !r.github.pushed.length; i++) await Bun.sleep(1);
    expect(r.github.pushed).toEqual([SHA1]);
    expect((r.state().messages as any)[id].shipping).toMatchObject({ state: "landing", pushing: { at: r.t.now } });
    r.github.afterPush = null;
    r.restart();
    r.later(6 * MIN);
    await r.link.sweep(); await r.link.whenLanded();
    await r.link.sweep(); await r.link.whenLanded();
    expect(r.github.pushed).toEqual([SHA1]);                        // never pushed again
    expect(r.github.landings).toHaveLength(1);                      // nor landed again: main said it was there
    expect((r.state().messages as any)[id].shipping.state).toBe("landed");
    expect(r.relayed.filter((l) => l.includes("Ship token: "))).toHaveLength(1);
  });
  test("2: a Stop after the restart, before main is read, doesn't call a pushed tap \"nothing shipped\"", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.afterPush = () => new Promise<void>(() => {});
    void r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    for (let i = 0; i < 20 && !r.github.pushed.length; i++) await Bun.sleep(1);
    r.github.afterPush = null;
    r.restart();
    r.stop.stopped = true; r.stop.at = r.t.now + 1;
    r.later(6 * MIN);
    await r.link.sweep(); await r.link.whenLanded();
    expect((r.state().messages as any)[id].shipping.state).toBe("landed");
    expect(String(r.msg(id).content)).not.toContain("nothing shipped");
  });
  test("2: the registration checks the pass under the ship lock before each keeper write: a Stop just before it registers nothing", async () => {
    let stopped = false;
    const order: string[] = [];
    const k = runReg({ remaining: 60, landing: BASE, active: () => { order.push("check"); return !stopped; } });
    (k.deps as any).exclusive = async (fn: () => any) => { stopped = true; order.push("lock"); const v = await fn(); order.push("unlock"); return v; };
    const r = await registerInstalls(k.deps as any, "tok", regClaim());
    expect(r.ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect(r.said.at(-1)).toBe("the pass ended before the link registered the install, so nothing was registered");
    stopped = false;
    const k2 = runReg({ remaining: 60, landing: BASE, active: () => true });
    const seen: string[] = [];
    (k2.deps as any).exclusive = async (fn: () => any) => { seen.push("lock"); const v = await fn(); seen.push(`unlock after ${k2.posted.length} posted`); return v; };
    expect((await registerInstalls(k2.deps as any, "tok", regClaim())).ok).toBe(true);
    expect(seen).toEqual(["lock", "unlock after 1 posted"]);       // the write started under the lock
  });

  test("3: a tap pushed back twice: the first reset falls inside its 2 hours, the second past them, and the card says it ran out and when to tap again", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 30 * MIN };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(String(r.msg(id).content)).toContain("Waiting: GitHub's hourly allowance for the link's reads is spent until 8:30 AM.");
    r.later(30 * MIN + 5_000);
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 100 * MIN };   // spent again, until 10:10: past 10:00
    await r.link.sweep(); await r.link.whenLanded();
    expect(r.github.landings).toEqual([]);
    expect(String(r.msg(id).content)).toContain("Not shipped: GitHub's hourly allowance for the link's reads is spent until 10:10 AM, after the tap's 2 hours run out at 10:00 AM, so this tap can't land it: a Ship tap on a new card can go at 10:11 AM or later.");
    expect(r.logs.some((l) => l.includes("didn't land") && l.includes("can't land it"))).toBe(true);
    expect(r.book.reserved()[`tap:${id}`]).toBeUndefined();
  });
  test("3: a tap that waited on GitHub's hour and reaches its 2 hours unlanded: the card says so, and when to tap again", async () => {
    const r = shipRig2();
    const id = ((await ship2(r)) as any).message;
    const tapped = r.t.now;
    r.github.budget = { limit: 60, remaining: 0, reset: r.t.now + 110 * MIN };
    await r.tap(snap2(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    r.t.now = tapped + 110 * MIN + 5_000;
    r.github.budget = "full";
    r.github.answers.push({ ok: false, again: true, why: "CI is still running bun on it" });
    await r.link.sweep(); await r.link.whenLanded();
    r.t.now = tapped + 2 * HOUR_MS;
    await r.link.sweep(); await r.link.whenLanded();
    expect(String(r.msg(id).content)).toContain("Not shipped: GitHub's hourly allowance for the link's reads kept it waiting, and the tap's 2 hours ran out at 10:00 AM, so this tap can't land it: a Ship tap on a new card can go at 10:00 AM or later.");
    expect(r.logs.some((l) => l.includes("ran out at its 2 hours while it waited for GitHub's hourly allowance"))).toBe(true);
  });

  test("7: while a registration waits for the reset, the hook's line says so and when, and a second start for the same head is refused with it", async () => {
    let file: string | null = null, note: ((u: any) => void) | null = null;
    const now = REG_NOW;
    const d: PassDeps = { pub: () => REG_PUB, now: () => now, load: () => file, store: (t) => { file = t; }, tz: "America/New_York",
      register: (_t, _c, _dn, n) => { note = n; n({ apps: 1 }); }, log: () => {} };
    const one = makeToken(regClaim(), (x) => edSign(null, x, REG_KEYS.privateKey));
    expect((await shipPass(d, { token: one })).status).toBe("pending");
    note!({ waitUntil: now + 25 * MIN });
    const line = budgetPendingSaid(now + 25 * MIN, "America/New_York");
    expect(await shipPass(d, { token: one })).toEqual({ status: "pending", said: line });
    expect(line).toContain("spent until 5:43 PM, so the link waits and then registers the install by itself");
    const two = makeToken(claimFor(REG_PR, SHA, now + 30_000)!, (x) => edSign(null, x, REG_KEYS.privateKey));   // another tap, the same head
    expect(await shipPass(d, { token: two })).toEqual({ status: "refused", said: line });
    expect(JSON.parse(file!).spent).toHaveLength(1);               // nothing recorded for it
  });
});

// For the round 2 tests: the same rigs as above.
const shipRig2 = () => { const r = rig({ facts: true }); r.github.facts = { head: SHA1, commits: 2, files: 3, areas: ["Cain's link"], title: "t", bumps: [{ app: "Cain", version: "0.19.3" }], merged: false } as any; return r; };
const ship2 = (r: ReturnType<typeof rig>) => r.link.ship({ text: "Ship taps go through even on busy days.", item: "P70", pr: LINK_PR, head: SHA1 });
const snap2 = (m: any) => JSON.parse(JSON.stringify(m));
const REG_KEYS = generateKeyPairSync("ed25519");
const REG_PUB = REG_KEYS.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const REG_FP = keyFingerprint(REG_PUB);
const REG_PR = "https://github.com/HyndeSyte/harness/pull/46";
const REG_NOW = Date.UTC(2026, 10, 27, 22, 18);                     // 5:18 PM in his time zone
const regClaim = () => claimFor(REG_PR, SHA, REG_NOW)!;
function runReg(o: { remaining: number; refuse?: number; how?: { status: number; headers: Record<string, string> }; landing?: string; active?: () => boolean }) {
  let now = REG_NOW;
  const reset = REG_NOW + 25 * MIN;
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const files: Record<string, any> = {
    [`cain/config.yaml@${BASE}`]: b64('version: "0.19.2"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.3"\n'),
    [`harness/config.yaml@${BASE}`]: b64('version: "0.30.0"\n'), [`harness/config.yaml@${SHA}`]: b64('version: "0.30.0"\n'),
    [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"), [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${REG_FP}\n`),
  };
  const enrolled = { key_fp: REG_FP, key_confirmed_at: new Date(REG_NOW - 3_600_000).toISOString(), state_created: new Date(REG_NOW - 7_200_000).toISOString(), enroll_id: "0123456789abcdef", counter: 10 };
  const attempt = "ship-46-cain-01234567";
  let refuse = o.refuse ?? 0, remaining = o.remaining;
  const sleeps: number[] = [], posted: any[] = [];
  const api = async (path: string) => {
    if (refuse > 0) { refuse--; return { status: o.how!.status, body: { message: "slow down" }, headers: o.how!.headers }; }
    if (path === `${REPO}/pulls/46`) return { status: 200, body: { base: { sha: BASE } }, headers: {} };
    const m = /contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    const f = m ? files[`${m[1]}@${m[2]}`] : undefined;
    return f ? { status: 200, body: f, headers: {} } : { status: 404, body: null, headers: {} };
  };
  const deps = { api, log: () => {}, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; if (now >= reset) remaining = 60; },
    note: () => {}, linkFp: REG_FP, tz: "America/New_York", budget: async () => ({ limit: 60, remaining, reset }),
    landing: o.landing ? () => o.landing! : undefined, active: o.active, enrollment: { load: () => null, store: () => {} },
    post: async (b: any) => { posted.push(b); return { status: 202, body: { status: "pending", id: attempt } }; },
    get: async () => ({ status: 200, body: { status: "accepted", id: attempt, app: "0fcc2575_cain", from_version: "0.19.2", to_version: "0.19.3", backup: "kb1", ...enrolled } }) };
  return { deps, sleeps, posted };
}
