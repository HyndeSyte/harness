// GitHub's read allowance for the link (Cain 0.19.3, link/budget.ts): a file read at a commit is kept and never
// read again, other reads carry their ETag, two reads at once share one request, and what is left of the hour
// is read from the answers' headers and GitHub's /rate_limit. A Ship card, his tap and the Ship run's
// registration each check it first: short, the card says when a tap can go, the tap waits for the reset by
// itself and lands then with no new tap, and the registration waits and goes on.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { CARD_ASKS, finishedJobs, IMMUTABLE, makeGithub, RESERVE, RUN_ASKS, shortUntil } from "../rootfs/opt/cain/link/budget";
import { budgetPendingSaid, keyFingerprint, registerInstalls, shipPass, type PassDeps, type RegResult } from "../rootfs/opt/cain/link/ship-pass";
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

describe("the link's GitHub reads (budget.ts)", () => {
  test("a file at a commit is read once, its absence too; another ref is read anew", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    const path = `${REPO}/contents/cain/config.yaml?ref=${SHA}`;
    const a = await gh.api(path), b = await gh.api(path);
    expect(a.status).toBe(200);
    expect(b).toEqual({ status: 200, body: a.body, headers: {} });
    const gone = `${REPO}/contents/harness/config.yaml?ref=${SHA}`;
    expect((await gh.api(gone)).status).toBe(404);
    expect((await gh.api(gone)).status).toBe(404);
    expect(f.asked.map((x) => x.path)).toEqual([path, gone]);
    await gh.api(`${REPO}/contents/cain/config.yaml?ref=main`);
    await gh.api(`${REPO}/contents/cain/config.yaml?ref=main`);
    expect(f.asked).toHaveLength(4);                               // a branch moves: never kept
    expect(gh.hour()).toEqual({ asked: 4, kept: 2 });
    expect(IMMUTABLE.test(`${REPO}/contents/x?ref=${SHA.slice(0, 39)}`)).toBe(false);
  });
  test("a workflow attempt's job list is kept once every job in it has finished, and read anew while one runs", async () => {
    const asked: string[] = [];
    let status = "in_progress";
    const fetch = async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ total_count: 2, jobs: [{ id: 1, status: "completed", conclusion: "success" }, { id: 2, status, conclusion: status === "completed" ? "failure" : null }] }), { status: 200 });
    };
    const gh = makeGithub({ fetch: fetch as any });
    const path = `${REPO}/actions/runs/7/attempts/1/jobs?per_page=100&page=1`;
    await gh.api(path); await gh.api(path);
    expect(asked).toHaveLength(2);
    status = "completed";
    await gh.api(path);
    const last = await gh.api(path);
    expect(asked).toHaveLength(3);
    expect(last.body.jobs[1].conclusion).toBe("failure");
    expect(finishedJobs({ total_count: 3, jobs: last.body.jobs })).toBe(false);   // not whole on this page
  });
  test("a read that can change carries its ETag, and a 304 answers from what was kept", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    const one = await gh.api(`${REPO}/pulls/46`);
    const two = await gh.api(`${REPO}/pulls/46`);
    expect(f.asked.map((x) => x.inm)).toEqual([null, '"v1"']);
    expect(two.status).toBe(200);
    expect(two.body).toEqual(one.body);
  });
  test("two identical reads at once share one request, and each gets its own copy", async () => {
    const f = fakeGithub();
    const gh = makeGithub({ fetch: f.fetch as any });
    const [a, b] = await Promise.all([gh.api(`${REPO}/pulls/46`), gh.api(`${REPO}/pulls/46`)]);
    expect(f.asked).toHaveLength(1);
    a.body.head.sha = "changed";
    expect(b.body.head.sha).toBe(SHA);
  });
  test("what is left of the hour: from the answers' headers, and from /rate_limit, which isn't counted", async () => {
    const f = fakeGithub({ remaining: 10, reset: 1_800_000_000 });
    const gh = makeGithub({ fetch: f.fetch as any, now: () => 1_799_999_000_000 });
    expect(gh.seen()).toBeNull();
    expect(await gh.rateLimit()).toEqual({ limit: 60, remaining: 10, reset: 1_800_000_000_000 });
    expect(f.asked).toHaveLength(0);
    await gh.api(`${REPO}/pulls/46`);
    expect(gh.seen()?.remaining).toBe(9);
    expect(gh.short(RESERVE)).toBe(1_800_000_000_000);
    expect(gh.short(5)).toBeNull();
  });
  test("shortUntil: short only with too little left before a reset still to come; unknown holds nothing back", () => {
    const b = { limit: 60, remaining: 5, reset: 2_000 };
    expect(shortUntil(b, 6, 1_000)).toBe(2_000);
    expect(shortUntil(b, 5, 1_000)).toBeNull();
    expect(shortUntil(b, 6, 2_000)).toBeNull();                   // the hour has reset
    expect(shortUntil(null, 6, 1_000)).toBeNull();
  });
});

describe("a Ship card and his tap reserve the hour for the run", () => {
  const FACTS = { head: SHA1, commits: 2, files: 3, areas: ["Cain's link"], title: "t", bumps: [{ app: "Cain", version: "0.19.3" }], merged: false };
  const shipRig = () => { const r = rig({ facts: true }); r.github.facts = structuredClone(FACTS) as any; return r; };
  const ship = (r: ReturnType<typeof rig>) => r.link.ship({ text: "Ship taps go through even on busy days.", item: "P70", pr: LINK_PR, head: SHA1 });
  const snap = (m: any) => JSON.parse(JSON.stringify(m));
  const sweep = async (r: ReturnType<typeof rig>) => { await r.link.sweep(); await r.link.whenLanded(); };

  test("too little left to read the card: refused, naming when it can go, and nothing is read", async () => {
    const r = shipRig();
    r.github.budget = { limit: 60, remaining: CARD_ASKS - 1, reset: r.t.now + 20 * MIN };
    await expect(ship(r)).rejects.toThrow(/GitHub's hourly allowance for the link's reads is spent until 8:20 AM .*show the card again at 8:21 AM/);
    expect(r.github.asked).toEqual([]);
  });
  test("enough for the card but not the run: the card says a tap waits until the reset", async () => {
    const r = shipRig();
    r.github.budget = { limit: 60, remaining: CARD_ASKS + RUN_ASKS - 1, reset: r.t.now + 20 * MIN };
    const id = ((await ship(r)) as any).message;
    expect(String(r.msg(id).content)).toContain("GitHub's hourly allowance for the link's reads is low until 8:20 AM: a Ship tap now waits until then, and lands and installs by itself.");
  });
  test("enough left, or nothing known: the card is as before", async () => {
    for (const b of [{ limit: 60, remaining: 60, reset: 0 }, null]) {
      const r = shipRig();
      r.github.budget = b ? { ...b, reset: r.t.now + 20 * MIN } : null;
      const id = ((await ship(r)) as any).message;
      expect(String(r.msg(id).content)).not.toContain("allowance");
    }
  });
  test("his tap with the run short waits for the reset by itself, then lands with no new tap", async () => {
    const r = shipRig();
    const id = ((await ship(r)) as any).message;
    r.github.budget = { limit: 60, remaining: RUN_ASKS - 1, reset: r.t.now + 20 * MIN };
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    await r.link.whenLanded();
    expect(r.github.landings).toEqual([]);
    expect(String(r.msg(id).content)).toContain("You tapped Ship. Waiting: GitHub's hourly allowance for the link's reads is spent until 8:20 AM. It lands by itself as soon as it can.");
    expect(r.relayed.at(-1)).toContain("the link keeps trying for up to 2 hours and lands it by itself");
    r.later(10 * MIN);
    await sweep(r);
    expect(r.github.landings).toEqual([]);                         // not before the reset: no read spent on a try that can't finish
    r.later(11 * MIN);
    r.github.budget = { limit: 60, remaining: 60, reset: r.t.now + HOUR_MS };
    await sweep(r);
    expect(r.github.landings).toEqual([{ pr: LINK_PR, head: SHA1 }]);
    expect(String(r.msg(id).content)).toContain("Shipped: it's in main as of 8:21 AM. Installing it is next.");
    expect(r.relayed.at(-1)).toContain("Ship token: ");
  });
});
const HOUR_MS = 60 * MIN;

describe("the Ship run's registration waits for GitHub's hour (ship-pass.ts)", () => {
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

  function run(o: { remaining: number; limitedOnce?: boolean }) {
    let now = NOW;
    const reset = NOW + 25 * MIN;
    const reads: string[] = [], sleeps: number[] = [], notes: any[] = [], logs: string[] = [];
    let limited = o.limitedOnce ?? false;
    let remaining = o.remaining;
    const api = async (path: string) => {
      reads.push(path);
      if (now < reset && limited) { limited = false; remaining = 0; return { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }; }
      if (path === `${REPO}/pulls/46`) return { status: 200, body: { base: { sha: BASE } }, headers: {} };
      const m = /contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
      const f = m ? files[`${m[1]}@${m[2]}`] : undefined;
      return f ? { status: 200, body: f, headers: {} } : { status: 404, body: null, headers: {} };
    };
    const deps = { api, log: (l: string) => logs.push(l), now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; if (now >= reset) remaining = 60; },
      note: (u: any) => notes.push(u), linkFp: FPR, tz: "America/New_York",
      budget: async () => ({ limit: 60, remaining, reset }),
      enrollment: { load: () => null, store: () => {} },
      post: async () => ({ status: 202, body: { status: "pending", id: attempt } }),
      get: async () => ({ status: 200, body: acceptance }) };
    return { deps, reads, sleeps, notes, logs, reset, get now() { return now; } };
  }
  const claim = () => claimFor(PR, SHA, NOW)!;

  test("short before it reads: it waits for the reset, says until when, and then registers by itself", async () => {
    const k = run({ remaining: 3 });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r.ok).toBe(true);
    expect(k.notes[0]).toEqual({ waitUntil: k.reset });
    expect(k.sleeps[0]).toBe(25 * MIN + 5_000);
    expect(k.logs[0]).toContain("so it waits until 5:43 PM and then goes on by itself");
    expect(k.reads[0]).toBe(`${REPO}/pulls/46`);                  // nothing read before the wait
  });
  test("a read refused for the rate limit (the Nov 27 failure) waits for the reset and is read once more", async () => {
    const k = run({ remaining: 40, limitedOnce: true });
    const r = await registerInstalls(k.deps as any, "tok", claim());
    expect(r.ok).toBe(true);
    expect(k.reads.filter((p) => p === `${REPO}/pulls/46`)).toHaveLength(2);
    expect(k.notes.some((n) => n.waitUntil === k.reset)).toBe(true);
  });
  test("enough left: no wait", async () => {
    const k = run({ remaining: 60 });
    expect((await registerInstalls(k.deps as any, "tok", claim())).ok).toBe(true);
    expect(k.notes.some((n) => "waitUntil" in n)).toBe(false);
    expect(k.sleeps.every((ms) => ms < MIN)).toBe(true);
  });
  test("the pass stays pending through the wait, and the hook's line says when to start the same run again", async () => {
    let file: string | null = null, now = NOW, note: ((u: any) => void) | null = null, done: ((r: RegResult) => void) | null = null;
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => now, load: () => file, store: (t) => { file = t; }, tz: "America/New_York",
      register: (_t, _c, dn, n) => { note = n; done = dn; n({ apps: 1 }); }, log: () => {} };
    const token = makeToken(claim(), (x) => edSign(null, x, SHIP_KEYS.privateKey));
    expect((await shipPass(d, { token })).status).toBe("pending");
    note!({ waitUntil: NOW + 25 * MIN });
    now += 20 * MIN;                                               // past the usual 6 minute wait: still pending
    const a = await shipPass(d, { token });
    expect(a).toEqual({ status: "pending", said: budgetPendingSaid(NOW + 25 * MIN, "America/New_York") });
    expect((a as any).said).toContain("spent until 5:43 PM");
    expect((a as any).said).toContain("start the same Ship run again at 5:44 PM");
    now += 7 * MIN;
    expect((await shipPass(d, { token })).status).toBe("pending");  // within the usual wait after the reset
    done!({ ok: true, accepted: [], said: [] });
    expect(["ok", "pending"]).toContain((await shipPass(d, { token })).status);
  });
});
