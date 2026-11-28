// Cain 0.19.4: a Cain install whose own backup restarts the App still installs. Cain's backup is cold, so the Keeper's backup of
// him (made after the link registered the install) stops and starts this App, and the link with it. Until 0.19.4 the link's
// reconcile at start refused the pass it found "left registering by a restart" and cancelled the registration, so no install of
// Cain through the Keeper could ever finish (seen Nov 27 on pull request 72). Now the pass is resumed from what it kept on disk.
//
// Review round 1: every transition under one lock with a revision (compare-and-swap), states that only move forward, the Keeper's
// every answer handled on a resume, one reaper with owed cancels, the token never in Cain's queue (the pass id instead, the hook
// fetching the token), exact App sets and kind "ship", a pending deadline from the registration, and the poll's wait while the
// Keeper's backup still runs. Every test ends on the invariant: each attempt is claimed by exactly one run or cancelled, no claimed
// attempt was ever cancelled by the link, and no pass state moved backward.
import { describe, expect, test } from "bun:test";
import { sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFor, makeToken, type Claim } from "../rootfs/opt/cain/ship-token";
import { BACKUP_MAX_AGE_MS, CANCEL_RETRY_MS, drainCancels, fetchToken, keyFingerprint, passId, pendingDeadline, reapPasses, reconcilePasses, registerInstalls,
  RELAY_MAX, RESTART_GRACE_MS, RESUME_MAX, shipPass, type PassDeps } from "../rootfs/opt/cain/link/ship-pass";
import { flockFile } from "../rootfs/opt/cain/link/pass-lock";
import { PASS_REF, resolvePassRef, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { SHIP_KEYS, SHIP_PUB } from "./link-rig";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const sign = (claim: Claim) => makeToken(claim, (d) => edSign(null, d, SHIP_KEYS.privateKey));
const CLAIM = claimFor(PR, SHA, NOW)!;
const TOKEN = sign(CLAIM);
const ID = passId(TOKEN);
const FPR = keyFingerprint(SHIP_PUB);
const T = (ms: number) => new Date(ms).toISOString();
const ATT = `ship-46-cain-${SHA.slice(0, 8)}`;
const SLUG = "0fcc2575_cain";
const ENROLLED = { key_fp: FPR, key_confirmed_at: T(NOW - 3_600_000), state_created: T(NOW - 7_200_000), enroll_id: "0123456789abcdef", counter: 10 };
const ROOT = join(import.meta.dir, "..");
const RANK: Record<string, number> = { registering: 0, accepted: 1, claiming: 2, passed: 3, refused: 4 };

const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
const gh: Record<string, any> = {
  [`cain/config.yaml@${BASE}`]: b64('version: "0.19.3"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.4"\n'),
  [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"), [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${FPR}\n`),
};
const api = async (path: string) => {
  if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
  const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
  const f = m ? gh[`${m[1]}@${m[2]}`] : null;
  return f ? { status: 200, body: f } : { status: 404, body: null };
};

// A Keeper with state, one for the whole test (it isn't restarted: only Cain's App is). Its claim and cancel follow Keeper's own
// rules (core.ts claimAttempt, cancelAttempt): one claimant, a retry with the same request reads the recorded claim, and a cancel
// of a claimed attempt with no version seen ends it (which is why the link must never send one on a resume).
type KA = { status: string; kind?: string; backup: string; claim?: { id: string; request: string; until: number }; over?: any };
function keeperModel() {
  const att: Record<string, KA> = {};
  const k = {
    att, posts: 0, views: [] as string[], cancels: [] as string[], cancelledClaimed: 0, claims: 0,
    cancelAnswer: null as null | (() => { status: number; body: any } | null),
    viewHook: null as null | ((id: string) => Promise<void> | void),
    post: async () => { k.posts++; att[ATT] ??= { status: "pending", kind: "ship", backup: "064d4fd1" }; return { status: 202, body: { status: "pending", id: ATT } }; },
    view: async (id: string) => {
      if (k.viewHook) await k.viewHook(id);
      const a = att[id];
      if (!a) { k.views.push("unknown"); return { status: 404, body: { status: "unknown", id } }; }
      k.views.push(a.status);
      const base = { id, app: SLUG, from_version: "0.19.3", to_version: "0.19.4", ...(a.kind !== undefined ? { kind: a.kind } : {}), install_job: null, ...ENROLLED, ...a.over };
      if (a.status === "accepted") return { status: 200, body: { status: "accepted", ...base, backup: a.backup, until: T(NOW + 1_800_000) } };
      if (a.status === "claimed") return { status: 200, body: { status: "claimed", ...base, backup: a.backup, claim: a.claim!.id, until: T(a.claim!.until) } };
      return { status: 200, body: { status: a.status, ...base } };
    },
    claim: async (x: { attempt: string; app: string; backup: string; from?: string; to?: string }, request: string) => {
      const a = att[x.attempt];
      const body = (id: string, until: number) => ({ status: 200, body: { status: "claimed", id: x.attempt, app: SLUG, from_version: "0.19.3", to_version: "0.19.4", backup: a!.backup, claim: id, until: T(until), ...ENROLLED } });
      if (!a) return { status: 404, body: { status: "refused", why: "no such attempt" } };
      if (a.claim && a.claim.request === request) return body(a.claim.id, a.claim.until);
      if (a.claim) return { status: 409, body: { status: "refused", why: `it is claimed already (claim ${a.claim.id})` } };
      if (a.status !== "accepted") return { status: 409, body: { status: "refused", why: `it is ${a.status}, not accepted` } };
      k.claims++;
      a.status = "claimed"; a.claim = { id: `claim-${String(k.claims).padStart(16, "0")}`, request, until: NOW + 1_800_000 + 10 * 60_000 };
      return body(a.claim.id, a.claim.until);
    },
    cancel: async (id: string) => {
      k.cancels.push(id);
      if (k.cancelAnswer) { const r = k.cancelAnswer(); if (r !== undefined) return r; }
      const a = att[id];
      if (!a) return { status: 404, body: { status: "unknown", id } };
      if (a.status === "ended") return { status: 200, body: { status: "ended", id, recorded: true } };
      if (!["pending", "accepted", "claimed"].includes(a.status)) return { status: 409, body: { status: "refused", id, why: `it is ${a.status}` } };
      if (a.status === "claimed") k.cancelledClaimed++;
      a.status = "ended";
      return { status: 200, body: { status: "ended", id } };
    },
  };
  return k;
}

function world(o: { lock?: () => () => void } = {}) {
  let file: string | null = null;
  let now = NOW;
  const history: Record<string, string[]> = {};
  const queue: string[] = [];
  const keeper = keeperModel();
  let enrolled: any = null;
  const enrollment = { load: () => enrolled, store: (e: any) => { enrolled = e; } };
  const store = (t: string) => {
    file = t;
    for (const e of JSON.parse(t).spent) { const h = (history[e.id] ??= []); if (h[h.length - 1] !== e.state) h.push(e.state); }
  };
  // One run of the link. Its registration's poll dies with the process: here, the GET that would see the acceptance never answers.
  const linkRun = (r: { relay?: (l: string) => void } = {}) => {
    const logs: string[] = [], relayed: string[] = [];
    const d: PassDeps = {
      pub: () => SHIP_PUB, now: () => now, load: () => file, store, log: (l) => logs.push(l), lock: o.lock,
      register: (tok, c, done, note) => {
        void registerInstalls({ api, log: (l) => logs.push(l), note, linkFp: FPR, now: () => now, sleep: async () => {}, enrollment,
          post: keeper.post, get: () => new Promise(() => {}) }, tok, c).then(done);   // the backup stops the App: this poll never comes back
      },
      claim: keeper.claim, cancel: (a) => keeper.cancel(a), view: keeper.view, enrollment,
      sign, relay: r.relay ?? ((l) => { relayed.push(l); queue.push(JSON.stringify({ text: l })); }), sleep: async (ms) => { now += ms; await settleTicks(1); }, pollMs: 5_000,
    };
    return { d, logs, relayed };
  };
  return { linkRun, keeper, queue, history, get file() { return file; }, set file(t: string | null) { file = t; }, store, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}
type W = ReturnType<typeof world>;
const settleTicks = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const passOf = (w: W, id = ID) => JSON.parse(w.file!).spent.find((x: any) => x.id === id);

// The pass as the registration leaves it just before the Keeper's backup stops the App (or seeded with changes)
const KEPT = (over: any = {}) => ({ id: ID, exp: CLAIM.exp, state: "registering", at: NOW, rev: 5, apps: 1, watched: [SLUG], attempts: [ATT], fp: FPR,
  claim: { repo: CLAIM.repo, pr: CLAIM.pr, head: CLAIM.head, exp: CLAIM.exp }, expect: [{ attempt: ATT, app: SLUG, from: "0.19.3", to: "0.19.4" }], ...over });
function seeded(entry: any, keeperStatus = "accepted", kAtt: Partial<KA> = {}) {
  const w = world();
  w.store(JSON.stringify({ format: 2, spent: [entry] }));
  w.keeper.att[ATT] = { status: keeperStatus, kind: "ship", backup: "064d4fd1", ...kAtt };
  return w;
}
// The invariant every test ends on
function invariant(w: W) {
  for (const [id, a] of Object.entries(w.keeper.att)) {
    const claimed = a.status === "claimed" && !!a.claim, ended = a.status === "ended";
    expect(claimed !== ended, `${id} is ${a.status}: claimed by exactly one run or cancelled`).toBe(true);
  }
  expect(w.keeper.cancelledClaimed, "no claimed attempt was cancelled").toBe(0);
  for (const [id, h] of Object.entries(w.history)) for (let i = 1; i < h.length; i++)
    expect(RANK[h[i]] >= RANK[h[i - 1]] && h[i - 1] !== "refused", `${id.slice(0, 8)} moved ${h.join(" > ")}`).toBe(true);
  for (const q of w.queue) expect(q).not.toContain("ship1.");   // the token never in Cain's queue
}
const hookRun = async (w: W, d: PassDeps, line: string) => {
  const text = /its text: "([^"]+)"/.exec(line)![1];
  const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: SHIP, body: { text } } };
  const res = await resolvePassRef(call, async (id) => { const a = await shipPass(d, { fetch: id }); return a.status === "token" ? { token: a.token } : { why: (a as any).said }; });
  return res;
};

describe("Cain 0.19.4: the Keeper's backup restarts Cain between the registration and the Ship run", () => {
  test("the restarted link resumes the pass, relays only its pass id, the hook fetches the token, and that run claims and starts", async () => {
    const w = world();
    const before = w.linkRun();
    expect((await shipPass(before.d, { token: TOKEN })).status).toBe("pending");
    await settleTicks();
    const kept = passOf(w);
    expect(kept).toMatchObject({ state: "registering", apps: 1, watched: [SLUG], attempts: [ATT], fp: FPR, claim: { repo: "HyndeSyte/harness", pr: 46, head: SHA },
      expect: [{ attempt: ATT, app: SLUG, from: "0.19.3", to: "0.19.4" }] });
    expect(w.file).not.toContain(TOKEN);
    // the cold backup: Cain's App stops for about two minutes, and starts again. The Keeper is still checking its backup, then accepts.
    w.advance(120_000);
    let reads = 0;
    w.keeper.viewHook = () => { if (++reads === 3) w.keeper.att[ATT].status = "accepted"; };
    const after = w.linkRun();
    expect(await reconcilePasses(after.d)).toBe(0);
    expect(w.keeper.cancels).toEqual([]);
    expect(w.keeper.views).toEqual(["pending", "pending", "accepted"]);
    expect(passOf(w)).toMatchObject({ state: "accepted", resumes: 1, resumedAt: NOW + 120_000, accepted: [{ attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] });
    // Cain's session started again too: the line gives the run's text with the pass id, never the token, whole
    expect(after.relayed).toHaveLength(1);
    expect(after.relayed[0]).toContain(`Start the same Ship run again now, its text: "Install pull request ${PR}, landed in main at ${SHA}. Ship pass: ${ID}."`);
    expect(after.relayed[0]).not.toContain("ship1.");
    // the Ship run's hook: the token fetched from the link by the pass id and put in the run's text
    const res = await hookRun(w, after.d, after.relayed[0]);
    expect("call" in res && res.rewritten).toBe(true);
    expect((res as any).call.tool_input.body.text).toBe(`Install pull request ${PR}, landed in main at ${SHA}. Ship token: ${TOKEN}.`);
    // the hook's ask: claimed and passed, with the ok line the Ship run reads
    const ans = await shipPass(after.d, { token: TOKEN });
    expect(ans).toMatchObject({ status: "ok", pr: 46, head: SHA, claims: [{ attempt: ATT, claim: "claim-0000000000000001" }] });
    expect(w.keeper.posts).toBe(1);   // registered once, never again
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("spent");
    expect(fetchToken(after.d, ID).status).toBe("refused");   // a passed pass hands out no token
    expect(w.history[ID]).toEqual(["registering", "accepted", "claiming", "passed"]);
    invariant(w);
  });

  test("a pass the restart caught accepted stays accepted (never downgraded), its resume recorded, and is relayed once", async () => {
    const w = seeded(KEPT({ state: "accepted", accepted: [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] }));
    w.advance(60_000);
    const after = w.linkRun();
    await reconcilePasses(after.d);
    expect(passOf(w)).toMatchObject({ state: "accepted", resumes: 1, resumedAt: NOW + 60_000 });
    expect(passOf(w).relayedAt).toBeDefined();
    expect(w.history[ID]).toEqual(["accepted"]);
    expect(after.relayed).toHaveLength(1);
    // dispatch is idempotent by pass id: a second restart before the hook asked resumes it but relays nothing more
    const again = w.linkRun();
    await reconcilePasses(again.d);
    expect(passOf(w)).toMatchObject({ state: "accepted", resumes: 2 });
    expect(again.relayed).toEqual([]);
    expect((await shipPass(again.d, { token: TOKEN })).status).toBe("ok");
    invariant(w);
  });

  test("a concurrent hook write during the resume: the hook claims with the token Cain still had, the resume's swap is refused and it does nothing", async () => {
    const w = seeded(KEPT({ state: "accepted", accepted: [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] }));
    const after = w.linkRun();
    let hooked: any = null;
    w.keeper.viewHook = async () => { if (!hooked) hooked = await shipPass(after.d, { token: TOKEN }); };   // the hook's ask lands mid read
    await reconcilePasses(after.d);
    expect(hooked).toMatchObject({ status: "ok" });
    expect(passOf(w).state).toBe("passed");
    expect(after.relayed).toEqual([]);
    expect(w.keeper.cancels).toEqual([]);
    expect(after.logs.some((l) => l.includes("moved on before it was recorded"))).toBe(true);
    invariant(w);
  });

  test("the Keeper answering claimed on a resume: never cancelled, the pass refused locally, no run started", async () => {
    const w = seeded(KEPT(), "claimed", { claim: { id: "claim-00000000000000aa", request: "another", until: NOW + 1_800_000 } });
    const after = w.linkRun();
    await reconcilePasses(after.d);
    expect(passOf(w).state).toBe("refused");
    expect(w.keeper.cancels).toEqual([]);
    expect(after.relayed.join(" ")).toContain("can't go on");
    expect(fetchToken(after.d, ID).status).toBe("refused");
    invariant(w);
  });

  test("a crash between the claim's send and its local write: the claim is found as this pass's, recorded, and nothing else is done", async () => {
    const w = seeded(KEPT({ state: "accepted", accepted: [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] }));
    const first = w.linkRun();
    // the hook's ask: claiming written durably, then the claim sent, and the App stops before the answer is recorded
    first.d.claim = async (a, req) => { await w.keeper.claim(a, req); return new Promise(() => {}); };
    void shipPass(first.d, { token: TOKEN });
    await settleTicks();
    expect(passOf(w).state).toBe("claiming");
    expect(w.keeper.att[ATT].status).toBe("claimed");
    const after = w.linkRun();
    await reconcilePasses(after.d);
    expect(passOf(w)).toMatchObject({ state: "passed", claims: [{ attempt: ATT, claim: "claim-0000000000000001" }] });
    expect(w.keeper.cancels).toEqual([]);
    expect(after.relayed).toEqual([]);
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("spent");
    invariant(w);
  });

  test("a pass found claiming whose attempt another run claimed is left be; one whose claim never reached the Keeper is cancelled", async () => {
    const acc = [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }];
    const w1 = seeded(KEPT({ state: "claiming", claimingAt: NOW, accepted: acc }), "claimed", { claim: { id: "claim-00000000000000bb", request: "someone-else", until: NOW + 1_800_000 } });
    await reconcilePasses(w1.linkRun().d);
    expect(passOf(w1).state).toBe("refused");
    expect(w1.keeper.cancels).toEqual([]);
    invariant(w1);
    const w2 = seeded(KEPT({ state: "claiming", claimingAt: NOW, accepted: acc }), "accepted");
    await reconcilePasses(w2.linkRun().d);
    expect(passOf(w2).state).toBe("refused");
    expect(w2.keeper.cancels).toEqual([ATT]);
    expect(w2.keeper.att[ATT].status).toBe("ended");
    invariant(w2);
  });

  test("a failed queue write cancels at once, and an oversized line is never cut: refused and cancelled", async () => {
    const w = seeded(KEPT());
    const after = w.linkRun({ relay: () => { throw new Error("disk full"); } });
    await reconcilePasses(after.d);
    expect(passOf(w).state).toBe("refused");
    expect(w.keeper.cancels).toEqual([ATT]);
    invariant(w);
    // a repository name long enough that the line passes the queue's bound
    const long = { v: 1 as const, kind: "ship" as const, repo: `HyndeSyte/${"h".repeat(RELAY_MAX)}`, pr: 46, head: SHA, exp: CLAIM.exp };
    const id = passId(sign(long));
    const w2 = seeded(KEPT({ id, claim: { repo: long.repo, pr: 46, head: SHA, exp: long.exp } }));
    const run = w2.linkRun();
    await reconcilePasses(run.d);
    expect(passOf(w2, id).state).toBe("refused");
    expect(run.relayed.every((l) => l.length <= RELAY_MAX)).toBe(true);
    expect(run.relayed.some((l) => l.includes("Start the same Ship run"))).toBe(false);
    expect(w2.keeper.cancels).toEqual([ATT]);
    invariant(w2);
  });

  test("a second restart during the poll: the resume count was fsynced before the poll, the next start resumes again, then the cap refuses", async () => {
    const w = seeded(KEPT(), "pending");
    const writes: string[] = [];
    const first = w.linkRun();
    const store = first.d.store;
    first.d.store = (t) => { writes.push(JSON.parse(t).spent[0].resumes); store(t); };
    first.d.view = () => new Promise(() => {});   // the App stops again mid poll
    void reconcilePasses(first.d);
    await settleTicks();
    expect(writes[0]).toBe(1 as any);              // written before the first read at the Keeper
    expect(passOf(w)).toMatchObject({ state: "registering", resumes: 1 });
    w.advance(60_000);
    w.keeper.att[ATT].status = "accepted";
    const second = w.linkRun();
    await reconcilePasses(second.d);
    expect(passOf(w)).toMatchObject({ state: "accepted", resumes: 2 });
    expect(second.relayed).toHaveLength(1);
    // a third start: RESUME_MAX reached, refused and cancelled
    const third = w.linkRun();
    await reconcilePasses(third.d);
    expect(RESUME_MAX).toBe(2);
    expect(passOf(w).state).toBe("refused");
    expect(w.keeper.cancels).toEqual([ATT]);
    invariant(w);
  });

  test("cancel failures: the cancel stays owed and is retried with backoff until the Keeper confirms it ended", async () => {
    const w = seeded(KEPT({ resumes: RESUME_MAX }));
    let fails = 2;
    w.keeper.cancelAnswer = () => (fails-- > 0 ? { status: 503, body: { status: "refused", why: "Keeper couldn't save its state" } } : (undefined as any));
    const after = w.linkRun();
    const cards: string[] = [];
    after.d.retry = (a, what) => cards.push(`${what} ${a}`);
    await reconcilePasses(after.d);
    expect(w.keeper.cancels).toEqual([ATT]);
    expect(passOf(w).cancels).toMatchObject([{ attempt: ATT, tries: 1 }]);
    expect(cards).toEqual([`cancel ${ATT}`]);   // the owner's retry card once
    await reapPasses(after.d);                    // not due yet
    expect(w.keeper.cancels).toHaveLength(1);
    w.advance(CANCEL_RETRY_MS + 1);
    await reapPasses(after.d);
    expect(passOf(w).cancels).toMatchObject([{ attempt: ATT, tries: 2 }]);
    w.advance(2 * CANCEL_RETRY_MS + 1);
    await reapPasses(after.d);
    expect(w.keeper.cancels).toEqual([ATT, ATT, ATT]);
    expect(passOf(w).cancels).toEqual([]);
    expect(w.keeper.att[ATT].status).toBe("ended");
    expect(cards).toHaveLength(1);
    invariant(w);
  });

  test("an owed cancel whose attempt the Keeper has claimed meanwhile is dropped, never sent", async () => {
    const w = seeded(KEPT({ state: "refused", cancels: [{ attempt: ATT, why: "x", tries: 1, next: NOW }] }), "claimed", { claim: { id: "claim-00000000000000cc", request: "r", until: NOW + 1_800_000 } });
    const d = w.linkRun().d;
    await drainCancels(d);
    expect(w.keeper.cancels).toEqual([]);
    expect(passOf(w).cancels).toEqual([]);
    invariant(w);
  });

  test("the reaper: the pending window passes without a claim, refused and cancelled; the deadline counts from the registration, never from a resume", async () => {
    const w = world();
    const d = w.linkRun().d;
    await shipPass(d, { token: TOKEN });
    await settleTicks();
    expect(await reapPasses(d)).toBe(0);
    w.advance(pendingDeadline({ at: NOW, apps: 1, exp: CLAIM.exp }) - NOW + 1);
    expect(await reapPasses(d)).toBe(1);
    expect(passOf(w).state).toBe("refused");
    expect(w.keeper.cancels).toEqual([ATT]);
    invariant(w);
    // a resume adds one bounded grace to the deadline from the registration, nothing more, however late it starts
    expect(pendingDeadline({ at: NOW, apps: 1, exp: CLAIM.exp, resumes: 2 }) - pendingDeadline({ at: NOW, apps: 1, exp: CLAIM.exp })).toBe(RESTART_GRACE_MS);
    const late = seeded(KEPT(), "pending");
    late.advance(pendingDeadline({ at: NOW, apps: 1, exp: CLAIM.exp, resumes: 1 }) - NOW + 1);
    await reconcilePasses(late.linkRun().d);
    expect(passOf(late).state).toBe("refused");
    invariant(late);
  });

  test("an accepted pass left unclaimed past the backup's maximum age is reaped; the hook's claim on an old backup is refused", async () => {
    const acc = [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }];
    const w = seeded(KEPT({ state: "accepted", accepted: acc }));
    w.advance(BACKUP_MAX_AGE_MS + 1);
    const d = w.linkRun().d;
    const r = await shipPass(d, { token: TOKEN });
    expect(r).toMatchObject({ status: "refused", said: expect.stringContaining("over 30 minutes old") });
    expect(w.keeper.claims).toBe(0);
    expect(w.keeper.cancels).toEqual([ATT]);
    invariant(w);
    const w2 = seeded(KEPT({ state: "accepted", accepted: acc }));
    w2.advance(BACKUP_MAX_AGE_MS + 1);
    expect(await reapPasses(w2.linkRun().d)).toBe(1);
    expect(w2.keeper.cancels).toEqual([ATT]);
    invariant(w2);
  });

  test("while the Keeper says its backup still runs, the poll keeps waiting past the window, up to the hard cap below the token's expiry", async () => {
    const w = seeded(KEPT(), "pending");
    const d = w.linkRun().d;
    const deadline = pendingDeadline({ at: NOW, apps: 1, exp: CLAIM.exp, resumes: 1 });
    w.keeper.viewHook = () => { if (w.now > deadline + 60_000) w.keeper.att[ATT].status = "accepted"; };
    const rec = reconcilePasses(d);
    // the hook asking meanwhile, past the window: still pending while the Keeper reads pending
    while (w.now <= deadline + 30_000) await settleTicks(1);
    expect((await shipPass(d, { token: TOKEN })).status).toBe("pending");
    expect(await reapPasses(d)).toBe(0);
    await rec;
    expect(passOf(w).state).toBe("accepted");
    expect((await shipPass(d, { token: TOKEN })).status).toBe("ok");
    invariant(w);
    // and a Keeper that never finishes: refused at the hard cap, cancelled
    const w2 = seeded(KEPT(), "pending");
    await reconcilePasses(w2.linkRun().d);
    expect(passOf(w2)).toMatchObject({ state: "refused", said: expect.stringContaining("time ran short") });
    expect(w2.now).toBeLessThanOrEqual(CLAIM.exp * 1000);
    expect(w2.keeper.cancels).toEqual([ATT]);
    invariant(w2);
  });

  test("exact App sets, one attempt per App, and kind ship: anything else is never resumed", async () => {
    const twice = [{ attempt: ATT, app: SLUG, from: "0.19.3", to: "0.19.4" }, { attempt: `ship-46-cain-${"f".repeat(8)}`, app: SLUG, from: "0.19.3", to: "0.19.4" }];
    for (const [name, over, kAtt] of [
      ["other watched App", { watched: ["0fcc2575_harness"] }, {}],
      ["two attempts for one App", { apps: 2, watched: [SLUG, "0fcc2575_harness"], expect: twice, attempts: twice.map((x) => x.attempt) }, {}],
      ["an extra attempt", { attempts: [ATT, "ship-46-cain-ffffffff"] }, {}],
      ["no watched list (before review round 1)", { watched: undefined }, {}],
      ["kind absent", {}, { kind: undefined }],
      ["kind drill", {}, { kind: "drill" }],
    ] as [string, any, Partial<KA>][]) {
      const w = seeded(KEPT(over), "accepted", kAtt);
      const run = w.linkRun();
      await reconcilePasses(run.d);
      expect(passOf(w).state, name).toBe("refused");
      expect(w.keeper.cancels, name).toEqual([ATT]);
      expect(run.relayed.some((l) => l.includes("Ship pass:")), name).toBe(false);
      invariant(w);
    }
  });

  test("what is never resumed: a drill, one from before 0.19.4, one whose token is nearly spent, another token's", async () => {
    const exp = Math.floor(NOW / 1000) + 600;
    const cases: [string, any][] = [
      ["drill", KEPT({ attempts: ["drill-46-cain-01234567"], expect: [{ attempt: "drill-46-cain-01234567", app: SLUG, from: "0.19.3", to: "0.19.4" }] })],
      ["before 0.19.4", { id: ID, exp: CLAIM.exp, state: "registering", at: NOW, apps: 1, attempts: [ATT] }],
      ["another token", KEPT({ id: "f".repeat(32) })],
      ["token nearly spent", KEPT({ id: passId(sign({ ...CLAIM, exp })), exp, claim: { repo: CLAIM.repo, pr: 46, head: SHA, exp } })],
    ];
    for (const [name, entry] of cases) {
      const w = seeded(entry);
      if (name === "drill") { delete w.keeper.att[ATT]; w.keeper.att["drill-46-cain-01234567"] = { status: "accepted", kind: "drill", backup: "b" }; }
      expect(await reconcilePasses(w.linkRun().d), name).toBe(1);
      expect(JSON.parse(w.file!).spent[0].state, name).toBe("refused");
      expect(w.keeper.cancels.length, name).toBeGreaterThan(0);
      invariant(w);
    }
  });

  test("the pass file's lock: one flock, exclusive across two openers; a transition that can't have it writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "passlock-"));
    const take = flockFile(join(dir, "ship-passes.json.lock"), 100);
    const release = take();
    expect(() => take()).toThrow(/held by another writer/);
    release();
    take()();
    // the link with that lock held elsewhere: the hook's first ask records nothing and refuses
    const w = world({ lock: take });
    const outside = take();
    const r = await shipPass(w.linkRun().d, { token: TOKEN });
    outside();
    expect(r).toMatchObject({ status: "refused", said: expect.stringContaining("couldn't record") });
    expect(w.file).toBeNull();
  });

  test("the hook: a pass id is swapped for the token the link hands over; not both, and nothing without the link's token", async () => {
    const run = (text: string) => ({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: SHIP, body: { text } } });
    const good = `Install pull request ${PR}, landed in main at ${SHA}. Ship pass: ${ID}.`;
    expect(PASS_REF.exec(good)?.[1]).toBe(ID);
    const ok = await resolvePassRef(run(good), async () => ({ token: TOKEN }));
    expect((ok as any).call.tool_input.body.text).toBe(`Install pull request ${PR}, landed in main at ${SHA}. Ship token: ${TOKEN}.`);
    expect(await resolvePassRef(run(`${good} Ship token: ${TOKEN}`), async () => ({ token: TOKEN }))).toMatchObject({ why: expect.stringContaining("not both") });
    expect(await resolvePassRef(run(good), async () => ({ why: "no pass with that id" }))).toMatchObject({ why: expect.stringContaining("no pass with that id") });
    expect(await resolvePassRef(run(good), async () => ({ token: "not a token" }))).toMatchObject({ why: expect.stringContaining("isn't a Ship token") });
    expect(await resolvePassRef(run(`${good} Ship pass: ${ID}`), async () => ({ token: TOKEN }))).toMatchObject({ why: expect.stringContaining("one line") });
    expect(await resolvePassRef(run(`Install ${PR} at ${SHA}. Ship token: ${TOKEN}.`), async () => { throw new Error("not asked"); })).toMatchObject({ rewritten: false });
    // the link hands a token only for a pass accepted again after a restart and relayed
    const w = seeded(KEPT({ state: "accepted", accepted: [{ app: SLUG, attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] }));
    const d = w.linkRun().d;
    expect(fetchToken(d, ID)).toMatchObject({ status: "refused" });
    await reconcilePasses(d);
    expect(fetchToken(d, ID)).toEqual({ status: "token", token: TOKEN });
    expect(fetchToken(d, "nope")).toMatchObject({ status: "refused" });
    expect((await shipPass(d, { token: TOKEN })).status).toBe("ok");
    invariant(w);
  });

  test("the link's start wires the lock, the whole-line relay and the reaper; Cain's rules say what the line means", () => {
    const main = readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8");
    const deps = main.slice(main.indexOf("const shipPassDeps: PassDeps"), main.indexOf("void reconcilePasses(shipPassDeps)"));
    expect(deps).toContain("sign: shipPriv ? (claim) => makeToken(claim");
    expect(deps).toContain("lock: flockFile(`${SHIP_PASSES}.lock`)");
    expect(deps).toContain("appendSynced(QUEUE, JSON.stringify({ text }) + \"\\n\")");
    expect(deps).not.toMatch(/relay: .*slice\(/);
    expect(main).toContain("reapPasses(shipPassDeps)");
    const hook = readFileSync(join(ROOT, "rootfs/opt/cain/hooks/remote-trigger.ts"), "utf8");
    expect(hook).toContain('permissionDecision: "allow"');
    expect(hook).toContain("updatedInput: allowed");
    const rules = readFileSync(join(ROOT, "rootfs/opt/cain/CLAUDE.md"), "utf8");
    expect(rules).toContain("has accepted that install since");
    expect(rules).toContain("Ship pass: <id>");
    expect(readFileSync(join(ROOT, "config.yaml"), "utf8")).toMatch(/^backup: cold$/m);   // the choice: Cain's backup stays cold
  });
});
