// The Ship pass (Cain 0.19.0, with Keeper 0.1.3 and 0.1.4): the RemoteTrigger hook lets one Ship run
// through per token, and only once the keeper App accepted every watched install (its backup made and
// verified); the link keeps the ids and their state (link/ship-pass.ts, hooks/remote-trigger.ts decideAll).
import { describe, expect, test } from "bun:test";
import { createHash, sign as edSign } from "node:crypto";
import { claimDeadlineWhy, decideAll, postShipPass, postShipPassCancel, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { claimFor, makeToken } from "../rootfs/opt/cain/ship-token";
import { PASS_WAIT_MS, CLAIM_START_MIN_MS, enrollmentCheck, enrollmentCheckNow, ENROLL_BEHIND, ENROLL_REFUSED, noteArmedEnrollment, keyFingerprint, passId, passWaitMs, readFingerprintFile, registerInstalls, shipPass, judgeCancel, type PassDeps, type RegResult } from "../rootfs/opt/cain/link/ship-pass";
import { CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth";
import { SHIP_KEYS, SHIP_PUB, keeperHolds } from "./link-rig";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const TOKEN = makeToken(claimFor(PR, SHA, NOW)!, (d) => edSign(null, d, SHIP_KEYS.privateKey));
const SHIP_TEXT = `Install pull request ${PR}, landed in main at ${SHA}. Ship token: ${TOKEN}. Dane tapped Ship at 9:40.`;
const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: SHIP, body: { text: SHIP_TEXT } } };
const ENV = { pub: SHIP_PUB, stop: { stopped: false, at: null }, now: NOW };

const FPR = keyFingerprint(SHIP_PUB);
const T = (ms: number) => new Date(ms).toISOString();
const ACC = { app: "0fcc2575_cain", attempt: "ship-46-cain-01234567", backup: "kb1", from: "0.18.0", to: "0.19.0" };
const ACCEPTED: RegResult = { ok: true, accepted: [ACC], said: [], fp: FPR };
const EID = "0123456789abcdef", EID2 = "fedcba9876543210";
const ENROLLED = { key_fp: FPR, key_confirmed_at: T(NOW - 3_600_000), state_created: T(NOW - 7_200_000), enroll_id: EID, counter: 10 };
const REC = { fp: FPR, stateCreated: NOW - 7_200_000, confirmedAt: NOW - 3_600_000, enrollId: EID, counter: 10, seen: [] as string[] };
const claimAnswer = (over: any = {}) => ({ status: 200, body: { status: "claimed", id: ACC.attempt, app: ACC.app, from_version: ACC.from, to_version: ACC.to, backup: ACC.backup,
  claim: "claim-0123456789abcdef", until: T(NOW + 1_800_000), ...ENROLLED, ...over } });
// The link's pass with a fake keeper: "accept" answers at once, "refuse" refuses, "hold" keeps the answer
// until the test gives it (the keeper still making the backup). claim answers the claim (Keeper 0.1.5).
function link(o: { file?: string | null; storeFails?: boolean; reg?: "accept" | "refuse" | "hold"; claim?: () => Promise<{ status: number; body: any } | null>; enrolled?: any } = {}) {
  let file: string | null = o.file ?? null;
  let now = NOW;
  const registered: string[] = [];
  const logs: string[] = [];
  const cancelled: string[] = [];
  const whys: string[] = [];
  const claims: any[] = [];
  let enrolled: any = o.enrolled === undefined ? null : o.enrolled;
  let held: ((r: RegResult) => void) | null = null;
  let note: ((u: any) => void) | null = null;
  const d: PassDeps = {
    pub: () => SHIP_PUB, now: () => now, load: () => file,
    store: (t) => { if (o.storeFails) throw new Error("disk"); file = t; },
    register: (tok, _c, done, n) => {
      registered.push(tok); note = n;
      n({ apps: 1 }); n({ attempt: ACC.attempt });
      if ((o.reg ?? "accept") === "accept") done(ACCEPTED);
      else if (o.reg === "refuse") done({ ok: false, said: ["the keeper refused Cain 0.19.0: its backup failed"] });
      else held = done;
    },
    claim: async (a, request) => { claims.push({ ...a, request }); return o.claim ? o.claim() : claimAnswer(); },
    cancel: (a, why) => { cancelled.push(a); whys.push(why); },
    enrollment: { load: () => enrolled, store: (e) => { enrolled = e; } },
    log: (l) => logs.push(l),
  };
  return { d, registered, logs, cancelled, whys, claims, setEnrolled(e: any) { enrolled = e; }, get enrolled() { return enrolled; }, get file() { return file; }, answer(r: RegResult) { held!(r); }, note(u: any) { note!(u); }, advance(ms: number) { now += ms; } };
}
const passOf = (l: ReturnType<typeof link>) => async (tok: string) => { const a = await shipPass(l.d, { token: tok }); return a.status === "ok" ? { ok: true as const } : a.status === "pending" ? { ok: false as const, pending: true as const, why: a.said } : { ok: false as const, why: a.said }; };

describe("the hook lets one Ship run through per token", () => {
  test("the first Ship run on a token passes; a second on the same token is refused", async () => {
    const l = link();
    const pass = passOf(l);
    const go = () => decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(await go()).toBe("");
    expect(l.registered).toEqual([TOKEN]);
    const again = await go();
    expect(again).toContain("The link didn't let this Ship run start");
    expect(again).toContain("already started a Ship run");
    expect(l.registered).toEqual([TOKEN]);
  });
  test("(Keeper 0.1.4) the run waits for the keeper's acceptance: pending refuses with a try-again line, then one run passes", async () => {
    const l = link({ reg: "hold" });
    const pass = passOf(l);
    const go = () => decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    const first = await go();
    expect(first).toContain("This Ship run hasn't started yet");
    expect(first).toContain("start the same Ship run again in a minute");
    expect(await go()).toContain("hasn't started yet");
    expect(l.registered).toEqual([TOKEN]);                 // registered once, however often it is asked
    l.answer(ACCEPTED);
    expect(await go()).toBe("");
    expect(await go()).toContain("already started a Ship run");
  });
  test("(Keeper 0.1.4) a keeper refusal, or no acceptance within the wait, refuses the pass for good, and (0.1.5) cancels the registration", async () => {
    const r = link({ reg: "refuse" });
    const a = await shipPass(r.d, { token: TOKEN });
    expect(a.status).toBe("refused");
    expect((a as any).said).toContain("its backup failed");
    expect((await shipPass(r.d, { token: TOKEN })).status).toBe("refused");
    expect(r.cancelled).toEqual([ACC.attempt]);
    const slow = link({ reg: "hold" });
    expect((await shipPass(slow.d, { token: TOKEN })).status).toBe("pending");
    slow.advance(PASS_WAIT_MS + 1_000);
    const late = await shipPass(slow.d, { token: TOKEN });
    expect(late.status).toBe("refused");
    expect((late as any).said).toContain("within 6 minutes");
    expect(slow.cancelled).toEqual([ACC.attempt]);         // the hook's give-up cancels the keeper's registration
    slow.answer(ACCEPTED);                                 // an acceptance after the pass gave up isn't kept, and is cancelled
    expect((await shipPass(slow.d, { token: TOKEN })).status).toBe("refused");
    expect(slow.cancelled).toEqual([ACC.attempt, ACC.attempt]);
  });
  test("(Keeper 0.1.4) the hook asks again while pending, within its budget, and lets the run through on ok", async () => {
    let n = 0;
    const fake = (async () => new Response(JSON.stringify(++n < 3 ? { status: "pending", said: "the keeper is taking the backup" } : { status: "ok" }), { status: 200 })) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "k", fetch: fake, pauseMs: 1 })).toEqual({ ok: true });
    expect(n).toBe(3);
    const always = (async () => new Response(JSON.stringify({ status: "pending", said: "the keeper is taking the backup" }), { status: 200 })) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "k", fetch: always, pauseMs: 5, budgetMs: 30 })).toEqual({ ok: false, pending: true, why: "the keeper is taking the backup" });
  });
  test("a run the checks refuse never spends its token; a Build run never asks for a pass", async () => {
    let asked = 0;
    const pass = async () => { asked++; return { ok: true as const }; };
    const stopped = await decideAll(call, keeperHolds({}), { ...ENV, stop: { stopped: true, at: NOW } }, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(stopped).not.toBe("");
    const build = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: "trig_015FTxexzFDZyjYjzw39bPv8", body: { text: "Branch: claude/x\nLabel: core" } } };
    await decideAll(build, keeperHolds({ P1: { holder: "cain", branches: ["claude/x"] } }), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(asked).toBe(0);
  });
  test("a link that doesn't answer refuses the run", async () => {
    const p = await postShipPass(TOKEN, { key: "k", url: "http://127.0.0.1:1", ms: 500 });
    expect(p.ok).toBe(false);
    const nokey = await postShipPass(TOKEN, { keyFile: "/nonexistent/cain.key" });
    expect(nokey).toEqual({ ok: false, why: "this start has no key for the link" });
  });
  test("the hook asks with Cain's key, and only an \"ok\" answer counts", async () => {
    const seen: any[] = [];
    const fake = (status: string) => (async (url: any, init: any) => { seen.push({ url: String(url), key: init.headers["x-harness-key"], body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status, said: "no" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "cainkey", fetch: fake("ok") })).toEqual({ ok: true });
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:8097/ship-pass", key: "cainkey", body: { token: TOKEN } });
    expect((await postShipPass(TOKEN, { key: "cainkey", fetch: fake("spent") })).ok).toBe(false);
  });
});

describe("the link's pass", () => {
  test("records the token's id (never the token) before it answers ok, and registers the installs", async () => {
    const l = link();
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a).toEqual({ status: "ok", pr: 46, head: SHA, accepted: [ACC], claims: [{ attempt: ACC.attempt, claim: "claim-0123456789abcdef", until: T(NOW + 1_800_000) }] });
    expect(l.file).toContain(passId(TOKEN));
    expect(l.file).not.toContain(TOKEN);
    expect(l.registered.length).toBe(1);
  });
  test("refuses a forged token, a spent one, an unreadable record and a record it can't write", async () => {
    const other = generateKeyPairSync("ed25519");
    const forged = makeToken(claimFor(PR, SHA, NOW)!, (d) => edSign(null, d, other.privateKey));
    expect((await shipPass(link().d, { token: forged })).status).toBe("refused");
    const l = link(); await shipPass(l.d, { token: TOKEN });
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("spent");
    expect((await shipPass(link({ file: "garbage" }).d, { token: TOKEN })).status).toBe("refused");
    // a format 1 record (Keeper 0.1.3's link) still counts its tokens as spent
    expect((await shipPass(link({ file: JSON.stringify({ format: 1, spent: [{ id: passId(TOKEN), exp: 9e9 }] }) }).d, { token: TOKEN })).status).toBe("spent");
    const w = link({ storeFails: true });
    expect((await shipPass(w.d, { token: TOKEN })).status).toBe("refused");
    expect(w.registered).toEqual([]);
  });
  test("/ship-pass is one of Cain's routes, and only his", () => {
    expect(CAIN_ROUTES.has("/ship-pass")).toBe(true);
    expect(routeAllowed("cain", "/ship-pass")).toBe(true);
    expect(routeAllowed("specialist", "/ship-pass")).toBe(false);
    expect(routeAllowed("root", "/ship-pass")).toBe(false);
  });
});

describe("the registration with the keeper App (Keeper 0.1.5: register, then poll)", () => {
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const files: Record<string, any> = {
    [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.0"\n'),
    [`harness/config.yaml@${BASE}`]: b64('version: "0.30.0"\n'), [`harness/config.yaml@${SHA}`]: b64('version: "0.31.0"\n'),
    [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"),
    [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`# the link's Ship key\n${FPR}\n`),
  };
  const apiWith = (over: Record<string, any> = {}) => async (path: string) => {
    if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
    const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    const key = m ? `${m[1]}@${m[2]}` : "";
    const f = key in over ? over[key] : files[key];
    return f ? { status: 200, body: f } : { status: 404, body: null };
  };
  const api = apiWith();
  const pending = { status: 202, body: { status: "pending", id: ACC.attempt, app: ACC.app, from_version: "0.18.0", to_version: "0.19.0" } };
  const acceptance = { status: "accepted", id: ACC.attempt, app: ACC.app, from_version: "0.18.0", to_version: "0.19.0", backup: "kb1", until: "x", ...ENROLLED };
  // A keeper that answers the polls in turn (the last answer repeats), on a fake clock.
  function keeper(polls: any[], o: { enrolled?: any } = {}) {
    let now = NOW; const posted: any[] = []; const got: string[] = []; const notes: any[] = []; let enrolled = o.enrolled ?? null;
    const deps = { api, log: () => {}, now: () => now, sleep: async (ms: number) => { now += ms; }, note: (u: any) => notes.push(u), linkFp: FPR,
      enrollment: { load: () => enrolled, store: (e: any) => { enrolled = e; } },
      post: async (b: any) => { posted.push(b); return pending; },
      get: async (p: string) => { got.push(p); const a = polls.length > 1 ? polls.shift() : polls[0]; return a === null ? null : { status: 200, body: a }; } };
    return { deps, posted, got, notes, get enrolled() { return enrolled; }, get now() { return now; } };
  }
  test("each watched App: POST /attempt (202), then GET /attempt/<id> polled until accepted; ok with its backup slug and versions", async () => {
    const k = keeper([{ status: "pending" }, { status: "pending" }, acceptance]);
    const c = (claimFor(PR, SHA, NOW))!;
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(k.posted).toEqual([{ token: TOKEN, app: "0fcc2575_cain", pr: 46, head: SHA, from_version: "0.18.0", to_version: "0.19.0", kind: "ship",
      probe_hash: createHash("sha256").update("// the probe\n").digest("hex").slice(0, 16) }]);
    expect(k.got).toEqual([`/attempt/${ACC.attempt}`, `/attempt/${ACC.attempt}`, `/attempt/${ACC.attempt}`]);
    expect(k.notes).toEqual([{ apps: 1 }, { fp: FPR }, { attempt: ACC.attempt, expect: { attempt: ACC.attempt, app: "0fcc2575_cain", from: "0.18.0", to: "0.19.0" } }]);   // Cain 0.19.4: what a resume needs
    expect(r).toEqual({ ok: true, accepted: [ACC], said: ["Cain 0.18.0 to 0.19.0 accepted as ship-46-cain-01234567, backup kb1"], fp: FPR });
    expect(k.enrolled).toEqual(REC);   // the owner's confirm seen
  });
  // Keeper 0.1.10
  test("(Keeper 0.1.11) a refusal for want of free space always refuses the install and posts one card; there is no override", async () => {
    const c = (claimFor(PR, SHA, NOW))!;
    const space = { status: "refused", why: "no room for its backup: only 900 MB is free", code: "no_space" };
    const cards: any[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await registerInstalls({ ...keeper([space]).deps, noSpace: (...a: any[]) => cards.push(a) }, TOKEN, c);
      expect(r.ok).toBe(false);
      expect((r as any).said[0]).toContain("nothing installs without the keeper's rollback, and the link posts the owner a card saying so");
    }
    expect(cards).toEqual([[46, SHA, "0fcc2575_cain", "0.19.0"], [46, SHA, "0fcc2575_cain", "0.19.0"]]);
    const src = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/ship-pass.ts"), "utf8");
    for (const gone of ["spaceOverrides", "takeOverride", "SPACE_OVERRIDE_MS"]) expect(src).not.toContain(gone);
  });
  test("polling stops at 5 minutes per App: still pending is not accepted", async () => {
    const k = keeper([{ status: "pending" }]);
    const r = await registerInstalls(k.deps, TOKEN, (claimFor(PR, SHA, NOW))!);
    expect(r.ok).toBe(false);
    expect((r as any).said[0]).toContain("didn't accept Cain 0.19.0 within 5 minutes");
    expect(k.now - NOW).toBeGreaterThanOrEqual(5 * 60_000);
    expect(k.now - NOW).toBeLessThan(5 * 60_000 + 10_000);
  });
  test("the pass's wait scales with the watched Apps registered: 5 minutes each plus 1", async () => {
    expect([passWaitMs(1), passWaitMs(2), passWaitMs(0)]).toEqual([6 * 60_000, 11 * 60_000, 6 * 60_000]);
    const l = link({ reg: "hold" });
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("pending");
    l.note({ apps: 2 });
    l.advance(PASS_WAIT_MS + 60_000);
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("pending");    // two Apps: 11 minutes
    l.advance(5 * 60_000);
    const late = await shipPass(l.d, { token: TOKEN });
    expect((late as any).said).toContain("within 11 minutes");
  });
  test("a refusal, no answer, an answer without a backup, another version, a 200 in place of the 202, or an unreadable base refuses", async () => {
    const c = (claimFor(PR, SHA, NOW))!;
    const k1 = keeper([acceptance]); k1.deps.post = async () => ({ status: 409, body: { why: "a replay" } }) as any;
    expect(await registerInstalls(k1.deps, TOKEN, c)).toEqual({ ok: false, said: ["the keeper refused Cain 0.19.0: a replay"] });
    const k2 = keeper([acceptance]); k2.deps.post = async () => null as any;
    expect(await registerInstalls(k2.deps, TOKEN, c)).toEqual({ ok: false, said: ["the keeper didn't answer for Cain 0.19.0"] });
    expect((await registerInstalls(keeper([{ ...acceptance, backup: "" }]).deps, TOKEN, c)).ok).toBe(false);
    expect((await registerInstalls(keeper([{ ...acceptance, to_version: "0.20.0" }]).deps, TOKEN, c)).ok).toBe(false);
    const ref = await registerInstalls(keeper([{ status: "refused", why: "its backup holds folders" }]).deps, TOKEN, c);
    expect((ref as any).said[0]).toContain("its backup holds folders");
    const k3 = keeper([acceptance]); k3.deps.post = async () => ({ status: 200, body: acceptance }) as any;   // 0.1.4's held answer is not a registration now
    expect((await registerInstalls(k3.deps, TOKEN, c)).ok).toBe(false);
    const none = await registerInstalls({ ...keeper([acceptance]).deps, api: async () => ({ status: 500, body: null }) }, TOKEN, c);
    expect(none.ok).toBe(false);
    expect(none.said[0]).toContain("nothing was registered");
  });
  test("a pull request that changes no watched App passes with nothing to accept", async () => {
    const c = (claimFor(PR, SHA, NOW))!;
    const harnessOnly = apiWith({ [`cain/config.yaml@${SHA}`]: b64('version: "0.18.0"\n') });
    const k = keeper([acceptance]);
    const r = await registerInstalls({ ...k.deps, api: harnessOnly }, TOKEN, c);
    expect(r).toEqual({ ok: true, accepted: [], said: [] });
    expect(k.posted.length).toBe(0);
  });
});

describe("Keeper 0.1.5: the committed fingerprint and the keeper's enrollment", () => {
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const { publicKey: EVIL } = generateKeyPairSync("ed25519");
  const EFP = keyFingerprint(EVIL.export({ format: "der", type: "spki" }).toString("base64"));
  test("the fingerprint file: comments skipped, one 16 hex digit line", () => {
    expect(readFingerprintFile(`# a comment\n\n${FPR}\n`)).toBe(FPR);
    expect(readFingerprintFile("# none yet\n")).toBe("");
    expect(readFingerprintFile("nothex0123456789\n")).toBe("");
  });
  test("a fresh keeper with an attacker's key pinned is refused by the hook: fingerprint mismatch", () => {
    const r = enrollmentCheck({ key_fp: EFP, key_confirmed_at: T(NOW), state_created: T(NOW - 1000) }, FPR, FPR, null);
    expect(r.ok).toBe(false);
    expect((r as any).why).toBe(`the keeper pinned the Ship key ${EFP}, not the committed ${FPR}`);
  });
  test("an unconfirmed pin, no fingerprint committed, or a committed one that isn't the link's key: refused", () => {
    expect((enrollmentCheck({ key_fp: FPR, key_confirmed_at: null, state_created: T(NOW) }, FPR, FPR, null) as any).why).toContain("isn't confirmed by the owner");
    expect((enrollmentCheck({ ...ENROLLED }, "", FPR, null) as any).why).toContain("holds no fingerprint");
    expect((enrollmentCheck({ ...ENROLLED }, EFP, FPR, null) as any).why).toContain("isn't the link's own Ship key");
  });
  test("the recorded state time refuses a newer keeper state until the owner confirms again (Keeper 0.1.7: a new enrollment id)", () => {
    expect(enrollmentCheck(ENROLLED, FPR, FPR, REC)).toEqual({ ok: true });
    // a reinstalled keeper (newer state) still showing the old enrollment: refused
    const newer = { ...ENROLLED, state_created: T(NOW - 60_000) };
    const r = enrollmentCheck(newer, FPR, FPR, REC);
    expect(r.ok).toBe(false);
    expect((r as any).why).toContain("after the enrollment the link recorded");
    // the owner's confirm on the new state (a new enrollment id): recorded, and it passes
    const confirmed = { ...newer, key_confirmed_at: T(NOW), enroll_id: EID2, counter: 3 };
    expect(enrollmentCheck(confirmed, FPR, FPR, REC)).toEqual({ ok: true, record: { fp: FPR, stateCreated: NOW - 60_000, confirmedAt: NOW, enrollId: EID2, counter: 3, seen: [EID] } });
  });
  test("the registration refuses an acceptance whose keeper pinned another key, and one whose head carries no fingerprint", async () => {
    const files: Record<string, any> = {
      [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.0"\n'),
      [`harness/config.yaml@${BASE}`]: b64('version: "0.30.0"\n'), [`harness/config.yaml@${SHA}`]: b64('version: "0.30.0"\n'),
      [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"), [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${FPR}\n`),
    };
    const api = (fs: Record<string, any>) => async (path: string) => {
      if (path.endsWith("/pulls/46")) return { status: 200, body: { base: { sha: BASE } } };
      const m = /contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path); const f = m ? fs[`${m[1]}@${m[2]}`] : undefined;
      return f ? { status: 200, body: f } : { status: 404, body: null };
    };
    let now = NOW; let posts = 0;
    const deps = (fs: Record<string, any>, keyFp: string) => ({ api: api(fs), log: () => {}, now: () => now, sleep: async (ms: number) => { now += ms; }, linkFp: FPR,
      post: async () => { posts++; return { status: 202, body: { status: "pending", id: ACC.attempt } }; },
      get: async () => ({ status: 200, body: { status: "accepted", id: ACC.attempt, app: ACC.app, from_version: "0.18.0", to_version: "0.19.0", backup: "kb1", ...ENROLLED, key_fp: keyFp } }) });
    const c = (claimFor(PR, SHA, NOW))!;
    const evil = await registerInstalls(deps(files, EFP), TOKEN, c);
    expect(evil.ok).toBe(false);
    expect((evil as any).said[0]).toContain(`not the committed ${FPR}`);
    const { [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: _, ...noFile } = files;
    const before = posts;
    const missing = await registerInstalls(deps(noFile, FPR), TOKEN, c);
    expect((missing as any).said[0]).toContain("holds no fingerprint");
    expect(posts).toBe(before);                              // nothing registered without it
  });
});

describe("Keeper 0.1.5: the claim at pass time", () => {
  test("the pass claims each acceptance as the hook lets the run through, answers ok with the claim, and logs the ok line", async () => {
    const l = link();
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("ok");
    expect(l.claims).toEqual([{ ...ACC, request: expect.stringMatching(/^[0-9a-f]{32}$/) }]);   // (Keeper 0.1.7) with its request id
    expect(l.logs).toContain(`Ship pass ok: ${ACC.attempt} claim claim-0123456789abcdef until ${T(NOW + 1_800_000)}`);
    expect(JSON.parse(l.file!).spent[0]).toMatchObject({ state: "passed", claims: [{ attempt: ACC.attempt, claim: "claim-0123456789abcdef" }] });
  });
  test("a refused claim (a second claimant, an expired acceptance), no answer, or an enrollment that fails refuses the pass for good and cancels", async () => {
    for (const claim of [async () => ({ status: 409, body: { status: "refused", why: "it is claimed already" } }), async () => null,
      async () => claimAnswer({ key_fp: "ffffffffffffffff" }), async () => claimAnswer({ backup: "kb-other" })]) {
      const l = link({ claim });
      const a = await shipPass(l.d, { token: TOKEN });
      expect(a.status).toBe("refused");
      expect(l.cancelled).toEqual([ACC.attempt]);
      expect((await shipPass(l.d, { token: TOKEN })).status).toBe("refused");
      expect(l.logs.some((x) => x.startsWith("Ship pass ok"))).toBe(false);
    }
  });
  test("two asks at once claim once: the second waits while the first claims", async () => {
    let release: (v: any) => void = () => {};
    const l = link({ reg: "hold", claim: () => new Promise((res) => { release = res; }) });
    await shipPass(l.d, { token: TOKEN }); l.answer(ACCEPTED);
    const first = shipPass(l.d, { token: TOKEN });
    for (let i = 0; i < 3; i++) await Bun.sleep(0);
    const second = await shipPass(l.d, { token: TOKEN });
    expect(second.status).toBe("pending");
    release(claimAnswer());
    expect((await first).status).toBe("ok");
    expect(l.claims.length).toBe(1);
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("spent");
  });
  test("a pass left claiming by a restart is refused after a minute, and its registrations cancelled", async () => {
    const l = link({ reg: "hold", claim: () => new Promise(() => {}) });
    await shipPass(l.d, { token: TOKEN }); l.answer(ACCEPTED);
    void shipPass(l.d, { token: TOKEN });
    for (let i = 0; i < 3; i++) await Bun.sleep(0);
    l.advance(61_000);
    const a = await shipPass(l.d, { token: TOKEN });
    expect((a as any).said).toContain("stopped while it claimed");
    expect(l.cancelled).toEqual([ACC.attempt]);
  });
  test("the hook carries the claims from the link's ok", async () => {
    const claims = [{ attempt: ACC.attempt, claim: "claim-0123456789abcdef", until: T(NOW + 1_800_000) }];
    const fake = (async () => new Response(JSON.stringify({ status: "ok", claims }), { status: 200 })) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "k", fetch: fake })).toEqual({ ok: true, claims });
  });
  test("the link logs its Ship key's fingerprint, the value cain/SHIP_KEY_FINGERPRINT holds", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "rootfs", "opt", "cain", "link", "shipkey.ts"), "utf8");
    expect(src).toContain("Ship key fingerprint: ");
  });
});

describe("Keeper 0.1.6: the claim's deadline in code, and the enrollment's exact times", () => {
  const claimAt = (ms: number) => ({ attempt: ACC.attempt, claim: "claim-0123456789abcdef", until: T(ms) });
  test("the hook's deadline check: a claim with under 20 minutes left, or no readable deadline, refuses the run and cancels its pass", async () => {
    expect(CLAIM_START_MIN_MS).toBe(20 * 60_000);
    expect(claimDeadlineWhy([claimAt(NOW + 29 * 60_000)], NOW)).toBe("");
    expect(claimDeadlineWhy([], NOW)).toBe("");
    expect(claimDeadlineWhy([claimAt(NOW + 19 * 60_000)], NOW)).toBe(`the keeper's claim of ${ACC.attempt} has 19 minutes left, under the 20 a Ship run needs to start`);
    expect(claimDeadlineWhy([{ ...claimAt(NOW), until: "soon" }], NOW)).toContain("no deadline the hook can read");
    const cancels: [string, string][] = [];
    const run = (until: number) => decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }),
      async () => ({ ok: true as const, claims: [claimAt(until)] }), async (t, w) => { cancels.push([t, w]); }, () => NOW);
    expect(await run(NOW + 30 * 60_000)).toBe("");
    expect(cancels).toEqual([]);
    const late = await run(NOW + 10 * 60_000);
    expect(late).toContain("The link didn't let this Ship run start: the keeper's claim of");
    expect(late).toContain("start again with a new Ship card for the same pull request and head");
    expect(cancels).toEqual([[TOKEN, `the keeper's claim of ${ACC.attempt} has 10 minutes left, under the 20 a Ship run needs to start`]]);
  });
  test("the hook's cancel goes to the link as POST /ship-pass {token, cancel}, and the link refuses the pass for good and cancels each claim", async () => {
    const seen: any[] = [];
    await postShipPassCancel(TOKEN, "too late", { url: "http://127.0.0.1:8097", key: "cainkey", fetch: (async (u: any, i: any) => { seen.push({ u: String(u), b: JSON.parse(i.body) }); return new Response("{}"); }) as any });
    expect(seen).toEqual([{ u: "http://127.0.0.1:8097/ship-pass", b: { token: TOKEN, cancel: "too late" } }]);
    const l = link();
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("ok");
    const c = await shipPass(l.d, { token: TOKEN, cancel: "the claim's deadline was too near" });
    expect(c.status).toBe("refused");
    expect(l.cancelled).toContain(ACC.attempt);
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("refused");   // never passes again
  });
  test("the link itself refuses and cancels a claim answered with under 20 minutes left", async () => {
    const l = link({ claim: async () => claimAnswer({ until: T(NOW + 15 * 60_000) }) });
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("refused");
    expect((a as any).said).toContain("has 15 minutes left, under the 20 a Ship run needs to start");
    expect(l.cancelled).toContain(ACC.attempt);
  });
  test("an older keeper state, or another confirm time, is refused; a different state counts only through a new enrollment", () => {
    const older = { ...ENROLLED, state_created: T(NOW - 9_000_000) };
    const r = enrollmentCheck(older, FPR, FPR, REC);
    expect(r.ok).toBe(false);
    expect((r as any).why).toContain("an older keeper state is refused");
    const earlierConfirm = { ...ENROLLED, key_confirmed_at: T(NOW - 5_000_000) };
    expect((enrollmentCheck(earlierConfirm, FPR, FPR, REC) as any).why).toContain("not at the confirm the link recorded");
    // the older state re-enrolled by the owner (a new id, whatever its clock says): recorded, and it passes
    const re = enrollmentCheck({ ...older, key_confirmed_at: T(NOW - 8_000_000), enroll_id: EID2 }, FPR, FPR, REC);
    expect(re).toEqual({ ok: true, record: { fp: FPR, stateCreated: NOW - 9_000_000, confirmedAt: NOW - 8_000_000, enrollId: EID2, counter: 10, seen: [EID] } });
  });
  test("(Keeper 0.1.7) the counter: a lower one is refused (an older keeper state), a higher one recorded; a replayed earlier enrollment is refused; an answer without them is refused", () => {
    const lower = enrollmentCheck({ ...ENROLLED, counter: 9 }, FPR, FPR, REC);
    expect(lower.ok).toBe(false);
    expect((lower as any).why).toBe("the keeper's counter (9) is lower than the 10 the link recorded: an older keeper state (a restore?) is refused; the owner confirms the key at the device again (key-code at the keeper prints a fresh code, then key-confirm with it)");
    expect(enrollmentCheck({ ...ENROLLED, counter: 25 }, FPR, FPR, REC)).toEqual({ ok: true, record: { ...REC, counter: 25 } });
    const after = { ...REC, enrollId: EID2, seen: [EID] };
    const replay = enrollmentCheck(ENROLLED, FPR, FPR, after);
    expect(replay.ok).toBe(false);
    expect((replay as any).why).toContain(`the keeper's enrollment ${EID} is an earlier confirmation the link has seen replaced`);
    const { enroll_id: _e, counter: _c, ...bare } = ENROLLED;
    expect((enrollmentCheck(bare, FPR, FPR, REC) as any).why).toBe("the keeper's answer carries no enrollment id or counter (Keeper 0.1.7 or later is needed)");
    // a counter is only ever raised in the record, even when a stale answer's record is noted late
    let rec: any = { ...REC, counter: 40 }; const logs: string[] = [];
    noteArmedEnrollment({ ...ENROLLED, counter: 30 }, FPR, { load: () => rec, store: (e: any) => { rec = e; } }, (l) => logs.push(l), REC);
    expect(rec.counter).toBe(40);
  });
  test("the enrollment is recorded from the minute-by-minute /armed read, outside any pass, in the link's record", () => {
    let rec: any = null; const logs: string[] = [];
    const store = { load: () => rec, store: (e: any) => { rec = e; } };
    noteArmedEnrollment({ armed: false, ...ENROLLED }, FPR, store, (l) => logs.push(l));
    expect(rec).toEqual(REC);
    expect(logs[0]).toContain("enrollment recorded");
    // an unconfirmed or foreign pin records nothing; the same confirm again records nothing new
    noteArmedEnrollment({ key_fp: FPR, key_confirmed_at: null, state_created: T(NOW) }, FPR, store, (l) => logs.push(l));
    noteArmedEnrollment({ ...ENROLLED }, FPR, store, (l) => logs.push(l));
    expect(logs).toHaveLength(1);
    // the link then passes a claim from that very state
    expect(enrollmentCheck(ENROLLED, FPR, FPR, rec)).toEqual({ ok: true });
  });
});

describe("Keeper 0.1.7: the claim's request id", () => {
  test("a claim that got no answer is asked once more with the same request id, and the keeper's recorded claim passes", async () => {
    let n = 0;
    const l = link({ enrolled: REC, claim: async () => (++n === 1 ? null : claimAnswer()) });
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("ok");
    expect(l.claims).toHaveLength(2);
    expect(l.claims[0].request).toMatch(/^[0-9a-f]{32}$/);
    expect(l.claims[1].request).toBe(l.claims[0].request);
    expect(l.logs).toContain(`the keeper didn't answer the claim of ${ACC.attempt}: asking once more with the same request`);
  });
  test("no answer to either ask refuses the pass and cancels", async () => {
    const l = link({ enrolled: REC, claim: async () => null });
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("refused");
    expect(l.claims).toHaveLength(2);
    expect(l.cancelled).toContain(ACC.attempt);
  });
});

describe("Keeper 0.1.8: enrollment after a restore, replaced replies, the cancel's why, a live claim named", () => {
  test("a keeper restored far below the old counter and re-enrolled by the owner (a brand-new id) is recorded at its own counter and passes; counters go up from there", () => {
    const old = { ...REC, counter: 5_000 };
    const restored = { ...ENROLLED, key_confirmed_at: T(NOW - 60_000), enroll_id: EID2, counter: 3 };
    const r = enrollmentCheck(restored, FPR, FPR, old);
    expect(r).toEqual({ ok: true, record: { ...old, confirmedAt: NOW - 60_000, enrollId: EID2, counter: 3, seen: [EID] } });
    const rec = (r as any).record;
    expect(enrollmentCheck({ ...restored, counter: 4 }, FPR, FPR, rec)).toEqual({ ok: true, record: { ...rec, counter: 4 } });
    expect(enrollmentCheck({ ...restored, counter: 3 }, FPR, FPR, rec)).toEqual({ ok: true });
    const lower = enrollmentCheck({ ...restored, counter: 2 }, FPR, FPR, rec);
    expect(lower.ok).toBe(false);
    expect((lower as any).cancel.startsWith(`${ENROLL_BEHIND}: `)).toBe(true);
    // and through a whole pass: the old record far ahead, the re-enrolled keeper's claim passes
    const l = link({ enrolled: old, claim: async () => claimAnswer({ key_confirmed_at: T(NOW - 60_000), enroll_id: EID2, counter: 3 }) });
    return shipPass(l.d, { token: TOKEN }).then((a) => { expect(a.status).toBe("ok"); expect(l.enrolled.enrollId).toBe(EID2); expect(l.enrolled.counter).toBe(3); });
  });
  test("a reply for an enrollment the link has replaced since the request was sent is discarded, though the record before the request allowed it", async () => {
    const replaced = { ...REC, enrollId: EID2, confirmedAt: NOW - 1_000, counter: 2, seen: [EID] };
    let rec: any = REC;
    const store = { load: () => rec, store: (e: any) => { rec = e; } };
    rec = replaced;                                         // a concurrent /armed read recorded the re-enrollment meanwhile
    const r = enrollmentCheckNow({ ...ENROLLED, counter: 11 }, FPR, FPR, REC, store);
    expect(r.ok).toBe(false);
    expect((r as any).why).toContain(`is for enrollment ${EID}, which the link has replaced (by ${EID2})`);
    expect(rec).toEqual(replaced);                          // nothing recorded from it
    // the same across a claim: the keeper's answer arrives after the re-enrollment was recorded
    const l = link({ enrolled: REC, claim: async () => { l.setEnrolled(replaced); return claimAnswer({ counter: 11 }); } });
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("refused");
    expect((a as any).said).toContain("which the link has replaced");
    expect(l.enrolled).toEqual(replaced);
    expect(l.whys.every((w) => w.startsWith(ENROLL_BEHIND))).toBe(true);
    // and from the /armed read: a stale reply never puts the replaced enrollment back
    noteArmedEnrollment({ ...ENROLLED, counter: 12 }, FPR, store, () => {}, REC);
    expect(rec).toEqual(replaced);
  });
  test("a claim refused on the enrollment cancels saying so: an older keeper state as the counter behind, anything else as refused", async () => {
    const behind = link({ enrolled: REC, claim: async () => claimAnswer({ counter: 9 }) });
    expect((await shipPass(behind.d, { token: TOKEN })).status).toBe("refused");
    expect(behind.whys.length).toBeGreaterThan(0);
    expect(behind.whys.every((w) => w.startsWith(`${ENROLL_BEHIND}: `) && w.length <= 160)).toBe(true);
    const other = link({ enrolled: REC, claim: async () => claimAnswer({ key_confirmed_at: T(NOW - 5_000_000) }) });
    expect((await shipPass(other.d, { token: TOKEN })).status).toBe("refused");
    expect(other.whys.every((w) => w.startsWith(`${ENROLL_REFUSED}: `))).toBe(true);
    // a keeper refusal that isn't about the enrollment cancels as before
    const plain = link({ claim: async () => ({ status: 409, body: { status: "refused", why: "it is ended" } }) });
    await shipPass(plain.d, { token: TOKEN });
    expect(plain.whys.every((w) => w === "the pass is refused")).toBe(true);
  });
  test("one Ship run per attempt: a second run on a token whose claim is live is refused naming the claim's latest expiry", async () => {
    const l = link();
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("ok");
    const again = await shipPass(l.d, { token: TOKEN });
    expect(again.status).toBe("spent");
    expect((again as any).said).toContain(`its claim at the keeper is live until ${T(NOW + 1_800_000)}`);
    l.advance(1_800_000 + 1_000);
    const later = await shipPass(l.d, { token: TOKEN });
    expect((later as any).said).not.toContain("live until");
    expect((later as any).said).toContain("already started a Ship run");
  });
});

// Keeper 0.1.10: out-of-order replies within one enrollment
describe("superseded keeper replies (Keeper 0.1.10)", () => {
  test("reversed delivery: the highest counter is kept, the older valid reply is discarded as superseded, with no refusal and no re-enrollment", async () => {
    let rec: any = REC;                                    // counter 10, recorded before both requests went out
    const store = { load: () => rec, store: (e: any) => { rec = e; } };
    const logs: string[] = [];
    // two /armed reads sent with the record at 10; the keeper answers 11 and 12; 12 arrives first
    noteArmedEnrollment({ ...ENROLLED, counter: 12 }, FPR, store, (l) => logs.push(l), REC);
    expect(rec.counter).toBe(12);
    noteArmedEnrollment({ ...ENROLLED, counter: 11 }, FPR, store, (l) => logs.push(l), REC);
    expect(rec.counter).toBe(12);
    expect(logs).toContain("a keeper reply with counter 11 arrived after a newer one: superseded, discarded (the highest counter is kept)");
    const j = enrollmentCheckNow({ ...ENROLLED, counter: 11 }, FPR, FPR, REC, store);
    expect(j).toEqual({ ok: true, superseded: true });
    // and through a pass: a claim answer older than a concurrent /armed reply still passes, nothing cancelled or refused
    const l = link({ enrolled: REC, claim: async () => { l.setEnrolled({ ...REC, counter: 20 }); return claimAnswer({ counter: 15 }); } });
    const a = await shipPass(l.d, { token: TOKEN });
    expect(a.status).toBe("ok");
    expect(l.enrolled.counter).toBe(20);
    expect(l.whys).toEqual([]);
    // a reply below the record as it stood before its request is still an older keeper state: refused
    expect(enrollmentCheckNow({ ...ENROLLED, counter: 9 }, FPR, FPR, REC, store).ok).toBe(false);
  });
});

describe("Keeper 0.1.11 item 4: a claim, cancel or attestation answer that isn't a plain ok", () => {
  const retries = (l: ReturnType<typeof link>) => { const out: any[] = []; l.d.retry = (...a: any[]) => { out.push(a); }; return out; };
  test("a claim answered pending, spent, refused, an error or not at all: no install, no success, and a retry card", async () => {
    for (const claim of [async () => ({ status: 202, body: { status: "pending", id: ACC.attempt, operation: "op-0123456789abcdef" } }),
      async () => ({ status: 409, body: { status: "spent" } }), async () => ({ status: 409, body: { status: "refused", why: "it is claimed already" } }),
      async () => ({ status: 503, body: { status: "refused", why: "Keeper's claim step failed" } }), async () => { throw new Error("socket"); }, async () => null,
      async () => ({ status: 200, body: { status: "ok" } })]) {
      const l = link({ claim: claim as any });
      const got = retries(l);
      const a = await shipPass(l.d, { token: TOKEN });
      expect(a.status).toBe("refused");
      expect(l.logs.some((x) => x.startsWith("Ship pass ok"))).toBe(false);
      expect(got).toHaveLength(1);
      expect(got[0].slice(0, 2)).toEqual([ACC.attempt, "claim"]);
    }
    // the hook sees no ok, so no run starts
    const l = link({ claim: async () => ({ status: 202, body: { status: "pending" } }) });
    retries(l);
    const why = await decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }), passOf(l));
    expect(why).toContain("The link didn't let this Ship run start");
  });
  test("a plain claim needs no retry card", async () => {
    const l = link();
    const got = retries(l);
    expect((await shipPass(l.d, { token: TOKEN })).status).toBe("ok");
    expect(got).toEqual([]);
  });
  test("a cancel counts only on a plain ended; pending, refused, an error or no answer is logged and brings a retry card", async () => {
    const l = link();
    const got = retries(l);
    expect(judgeCancel(l.d, ACC.attempt, { status: 200, body: { status: "ended", id: ACC.attempt, backup_kept: "kb1" } })).toBe(true);
    expect(got).toEqual([]);
    for (const r of [{ status: 202, body: { status: "pending", operation: "op-0123456789abcdef" } }, { status: 409, body: { status: "refused", why: "its claim was handed to a started run" } },
      { status: 503, body: { status: "refused" } }, { status: 200, body: { status: "ended", id: "ship-46-cain-ffffffff" } }, null]) {
      expect(judgeCancel(l.d, ACC.attempt, r)).toBe(false);
    }
    expect(got.map((x) => x.slice(0, 2))).toEqual(Array(5).fill([ACC.attempt, "cancel"]));
    expect(l.logs.some((x) => x.includes(`the keeper's cancel of ${ACC.attempt} isn't confirmed (the keeper's answer is pending (operation op-0123456789abcdef))`))).toBe(true);
    // a cancel sent by a refused pass is judged when its answer comes back
    const r2 = link({ reg: "refuse" });
    const got2 = retries(r2);
    r2.d.cancel = async () => ({ status: 202, body: { status: "pending" } });
    await shipPass(r2.d, { token: TOKEN });
    await Bun.sleep(5);
    expect(got2.map((x) => x.slice(0, 2))).toEqual([[ACC.attempt, "cancel"]]);
  });
});
