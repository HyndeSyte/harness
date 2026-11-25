// Keeper 0.1.15, Cain 0.19.0 (round 16): the Cain side of the follow-ups that close the last review round. Each numbered item has
// its own group, named for it; Keeper's side of the same items is in keeper/tests/keeper.test.ts ("0.1.15 item <n>").
import { describe, expect, test } from "bun:test";
import { sign as edSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64url, claimFor, makeToken, publicKey, readToken } from "../rootfs/opt/cain/ship-token";
import { acceptWaitMs, ATTEMPT_WAIT_MS, passId, passWaitMs, reconcilePasses, registerInstalls, shipPass, type PassDeps } from "../rootfs/opt/cain/link/ship-pass";
import { armFlag, drillDeps, drillKeyFrom, fileStore, helperMode, HELPER_BOUND_MS, JOB_START_MAX_MS, keeperNames, makeDrillFlag, makeMark, readDrillFlag, readMark,
  type DrillStore } from "../rootfs/opt/cain/link/drill";
import { DRILL_CLEAR, DRILL_CLEAR_LABEL, quietHours } from "../rootfs/opt/cain/link/core";
import { keyFingerprint } from "../rootfs/opt/cain/link/ship-pass";
import { rig, SHIP_KEYS, SHIP_PUB, DM, OWNER, BOT } from "./link-rig";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const V = "0.19.0";
const signer = (d: Buffer) => edSign(null, d, SHIP_KEYS.privateKey);
const DK = drillKeyFrom(SHIP_KEYS.privateKey);
const markSigner = (d: Buffer) => edSign(null, d, DK.priv);
const TOKEN = makeToken(claimFor(PR, SHA, NOW)!, signer);
const FPR = keyFingerprint(SHIP_PUB);
const T = (ms: number) => new Date(ms).toISOString();
const ENROLLED = { key_fp: FPR, key_confirmed_at: T(NOW - 3_600_000), state_created: T(NOW - 7_200_000), enroll_id: "0123456789abcdef", counter: 10 };
const ATT = `drill-46-cain-${SHA.slice(0, 8)}`;
const ROOT = join(import.meta.dir, "..");
const c = claimFor(PR, SHA, NOW)!;

// The real store in a temporary folder (root's files on the Pi)
function files() {
  const d = mkdtempSync(join(tmpdir(), "r16-"));
  const store = fileStore(join(d, "trust/keeper-drill.json"), join(d, "trust/keeper-drill-mark.json"), join(d, "link/keeper-drill-spent"), join(d, "trust/aborted.jsonl"),
    () => NOW, join(d, "link/keeper-drill-refused.json"));
  return { d, store };
}
// The registration's world, as drill.test.ts has it: GitHub at the base and head, and a keeper that accepts and confirms marks
const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
const gh: Record<string, any> = {
  [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64(`version: "${V}"\n`),
  [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"), [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${FPR}\n`),
};
const api = async (path: string) => {
  if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
  const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
  const f = m ? gh[`${m[1]}@${m[2]}`] : null;
  return f ? { status: 200, body: f } : { status: 404, body: null };
};
function keeper(store: DrillStore) {
  let now = NOW; const posted: any[] = []; const logs: string[] = []; const pages: [string, string, any][] = []; let enrolled: any = null; let last: any = null;
  const drill = drillDeps(store, () => SHIP_PUB, () => now, (l) => logs.push(l), { sign: markSigner, markPub: () => DK.pub, page: (k, key, info) => pages.push([k, key, info]) });
  const idOf = (b: any) => `${b.kind}-46-cain-${SHA.slice(0, 8)}`;
  const deps = { api, log: (l: string) => logs.push(l), now: () => now, sleep: async (ms: number) => { now += ms; }, linkFp: FPR,
    enrollment: { load: () => enrolled, store: (e: any) => { enrolled = e; } }, drill,
    post: async (b: any) => { posted.push(b); last = b; return { status: 202, body: { status: "pending", id: idOf(b) } }; },
    get: async () => ({ status: 200, body: { status: "accepted", id: idOf(last), app: "0fcc2575_cain", from_version: "0.18.0", to_version: V, backup: "kb1", until: "x", kind: last.kind,
      ...(last.drill_mode ? { drill_mode: last.drill_mode, marked: false } : {}), ...ENROLLED } }),
    markPost: async (attempt: string) => ({ status: 200, body: { status: "marked", id: attempt } }),
  };
  return { deps, posted, logs, pages, drill };
}
const view = (over: any = {}) => ({ status: 200, body: { id: ATT, app: "0fcc2575_cain", from_version: "0.18.0", to_version: V, status: "claimed", kind: "drill", drill_mode: "exit-on-start",
  marked: true, install_job: "inst-1", install_job_at: T(NOW - 30_000), ...over } });
const markText = (mode: "exit-on-start" | "verdict-fail" = "exit-on-start") => makeMark({ version: V, attempt: ATT, mode }, NOW, markSigner);

describe("item 1: every Ship approval is single use (the link's side)", () => {
  test("the link records the token's use before it registers anything, and a second submission is refused", async () => {
    let file: string | null = null; const order: string[] = [];
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => NOW, load: () => file, store: (t) => { order.push("recorded"); file = t; }, log: () => {},
      register: (_t, _c, done) => { order.push("registered"); done({ ok: false, said: ["the keeper refused it"] }); } };
    await shipPass(d, { token: TOKEN });
    expect(order.slice(0, 2)).toEqual(["recorded", "registered"]);
    expect((await shipPass(d, { token: TOKEN })).status).toBe("refused");
    expect(JSON.parse(file!).spent.map((x: any) => x.id)).toEqual([passId(TOKEN)]);
  });
});

describe("item 2: the drilled start is tied to its install job", () => {
  test("only a job Keeper bound to the attempt, made before this start and within the hour, lets the start fail on purpose", () => {
    const m = readMark(markText(), DK.pub, NOW);
    if (!m.ok) throw new Error("mark");
    expect(keeperNames(m.mark, V, view(), NOW)).toEqual({ why: "", definitive: true });
    expect(keeperNames(m.mark, V, view({ install_job: null }), NOW)).toMatchObject({ definitive: false });
    expect(keeperNames(m.mark, V, view({ install_job_at: T(NOW + 600_000) }), NOW)).toMatchObject({ definitive: true, why: expect.stringContaining("made after this start") });
    expect(keeperNames(m.mark, V, view({ install_job_at: T(NOW - JOB_START_MAX_MS - 1000) }), NOW)).toMatchObject({ definitive: true, why: expect.stringContaining("isn't that install's start") });
  });
});

describe("items 3 and 6: the link's reconcile at its start, and its wait outside the hook", () => {
  test("a pass a restart left open is refused and its attempts cancelled; a passed one is read at Keeper, its job logged", async () => {
    const exp = Math.floor(NOW / 1000) + 3600;
    let file: string | null = JSON.stringify({ format: 2, spent: [
      { id: "a".repeat(32), exp, state: "accepted", at: NOW, attempts: ["ship-46-cain-01234567"], accepted: [{ app: "0fcc2575_cain", attempt: "ship-46-cain-01234567", backup: "kb1" }] },
      { id: "b".repeat(32), exp, state: "passed", at: NOW, claims: [{ attempt: "ship-47-cain-89abcdef", claim: "claim-0123456789abcdef", until: T(NOW + 600_000) }] }] });
    const cancelled: string[] = []; const logs: string[] = [];
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => NOW, load: () => file, store: (t) => { file = t; }, register: () => {}, log: (l) => logs.push(l),
      cancel: (a) => { cancelled.push(a); }, view: async (a) => ({ status: 200, body: { id: a, status: "watching", install_job: "u1", install_job_at: T(NOW) } }) };
    expect(await reconcilePasses(d)).toBe(1);
    expect(cancelled).toEqual(["ship-46-cain-01234567"]);
    expect(JSON.parse(file!).spent.map((x: any) => x.state)).toEqual(["refused", "passed"]);
    expect(logs.some((l) => l.includes("refused a pass left accepted by a restart"))).toBe(true);
    expect(logs.some((l) => l.includes("ship-47-cain-89abcdef at Keeper: watching, tied to the Supervisor's install job u1"))).toBe(true);
  });
  test("the wait for Keeper's acceptance is the option keeper_accept_min (1 to 15 minutes, default 5), and the pass waits on it", () => {
    expect(acceptWaitMs(undefined)).toBe(ATTEMPT_WAIT_MS);
    expect(acceptWaitMs("10")).toBe(600_000);
    for (const v of ["0", "16", "x", "2.5", ""]) expect(acceptWaitMs(v)).toBe(ATTEMPT_WAIT_MS);
    expect(passWaitMs(1, 600_000)).toBe(660_000);
    const cfg = readFileSync(join(ROOT, "config.yaml"), "utf8");
    expect(cfg).toMatch(/^  keeper_accept_min: 5$/m);
    expect(cfg).toMatch(/^  keeper_accept_min: int\(1,15\)\?$/m);
    expect(readFileSync(join(ROOT, "rootfs/etc/services.d/cain/run"), "utf8")).toContain("export KEEPER_URL KEEPER_TOKEN KEEPER_ACCEPT_MIN");
  });
});

describe("item 7: the helper on an unreachable keeper fails closed", () => {
  function helper(o: { answers: ({ status: number; body: any } | null)[]; noToken?: boolean; aborted?: boolean; mark?: string | null }) {
    let now = NOW; let mark: string | null = o.mark === undefined ? markText() : o.mark; const lines: string[] = []; const logs: string[] = []; let asked = 0;
    const d = { version: V, now: () => now, sleep: async (ms: number) => { now += ms; }, loadMark: () => mark, dropMark: () => { mark = null; }, pub: () => DK.pub,
      ask: o.noToken ? null : async () => { asked++; return o.answers.length > 1 ? o.answers.shift()! : o.answers[0]; },
      abortedFor: () => !!o.aborted, aborted: (l: string) => lines.push(l), log: (m: string) => logs.push(m) };
    return { d, lines, logs, get mark() { return mark; }, get asked() { return asked; } };
  }
  test("a lookup that keeps failing keeps the mark, retries within the bound, then records a paged abort", async () => {
    const h = helper({ answers: [null] });
    expect(await helperMode(h.d)).toBe("abort");
    expect(h.mark).not.toBeNull();
    expect(h.asked).toBeGreaterThan(10);
    expect(JSON.parse(h.lines[0])).toMatchObject({ attempt: ATT, version: V, page: true });
    expect(HELPER_BOUND_MS).toBe(90_000);
  });
  test("a lookup that fails then answers: the mode, once Keeper names the drill with its job", async () => {
    const h = helper({ answers: [{ status: 503, body: {} }, view({ install_job: null }), view()] });
    expect(await helperMode(h.d)).toBe("exit-on-start");
  });
  test("a definitive no-drill drops the mark and the start goes on; an earlier abort of this attempt, or no token, aborts at once", async () => {
    const h = helper({ answers: [view({ status: "aborted" })] });
    expect(await helperMode(h.d)).toBe("");
    expect(h.mark).toBeNull();
    const a = helper({ answers: [view()], aborted: true });
    expect(await helperMode(a.d)).toBe("abort");
    expect(a.asked).toBe(0);
    const t = helper({ answers: [view()], noToken: true });
    expect(await helperMode(t.d)).toBe("abort");
    const other = helper({ answers: [view()], mark: makeMark({ version: "0.18.0", attempt: ATT, mode: "exit-on-start" }, NOW, markSigner) });
    expect(await helperMode(other.d)).toBe("");                  // another version's mark: a usual start, never asked
    expect(other.asked).toBe(0);
  });
});

describe("item 8: a refused or wrong-version flag never becomes a ship on retry", () => {
  test("the refusal is persisted: every install refused with one page, until the owner clears it", async () => {
    const { store } = files();
    store.storeFlag(makeDrillFlag("exit-on-start", "0.19.1", NOW, signer));
    const k = keeper(store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(store.refused()).toMatchObject({ kind: "version", armed: "0.19.1", version: V });
    for (let i = 0; i < 2; i++) expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect(new Set(k.pages.map(([, key]) => key)).size).toBe(1);   // one page: the same key each time (the link posts it once)
    expect(k.drill.clearRefused!()).toBe(true);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["ship"]);
  });
  test("a new drill armed from a card replaces the refusal", () => {
    const { store } = files();
    store.storeRefused({ at: NOW, why: "x", kind: "damaged", key: "damaged:0123456789abcdef" });
    expect(armFlag(store, "verdict-fail", V, NOW, signer).ok).toBe(true);
    expect(store.refused()).toBeNull();
  });
  test("replacement and consumption are serialized on the exact flag instance: a flag written after the claim stays", () => {
    const { d, store } = files();
    const first = makeDrillFlag("exit-on-start", V, NOW, signer);
    store.storeFlag(first);
    const claimed = store.claimFlag();
    expect(claimed?.text).toBe(first);
    const second = makeDrillFlag("verdict-fail", V, NOW, signer);
    store.storeFlag(second);                                         // his new tap meanwhile
    store.dropClaim(claimed!.id);
    expect(readFileSync(join(d, "trust/keeper-drill.json"), "utf8")).toBe(second);
    expect(store.claimed()).toEqual([]);
    expect(store.claimFlag()).toMatchObject({ text: second });
    expect(store.claimFlag()).toBeNull();                            // one claimant
  });
  test("the page carries Clear the drill; his tap clears it, checked to be his", async () => {
    const r = rig();
    let cleared = 0;
    (r.link as any).d.clearDrill = () => { cleared++; return true; };
    const p = await r.link.drillPage("refused", "refused:version:0123456789abcdef", { armed: "0.19.1", version: V });
    expect(r.buttons(p.message!)).toEqual([DRILL_CLEAR_LABEL]);
    expect(r.ids(p.message!)).toEqual([DRILL_CLEAR]);
    expect(r.msg(p.message!).content).toContain("every install of Cain is refused until you tap Clear the drill or arm a new drill");
    const it = (user: string) => ({ type: 3, id: "21", token: "t", application_id: BOT, channel_id: DM, user: { id: user }, data: { custom_id: DRILL_CLEAR }, message: r.msg(p.message!) });
    expect(await (r.link as any).drillClearTap(it("7777"), p.message!)).toBe("refused: not the owner");
    expect(cleared).toBe(0);
    expect(await (r.link as any).drillClearTap(it(OWNER), p.message!)).toBe("drill cleared");
    expect(cleared).toBe(1);
    expect(r.state().messages[p.message!].outcome).toBe("answered");
  });
});

describe("item 11: a crash between the nonce's spend and the flag's removal", () => {
  test("the claimed flag left with its nonce spent is removed, refused once, paged once; the next install goes as ship", async () => {
    const { d, store } = files();
    const flag = makeDrillFlag("exit-on-start", V, NOW, signer);
    const nonce = JSON.parse(Buffer.from(flag.split(".")[1], "base64url").toString()).nonce;
    store.storeFlag(flag);
    const cl = store.claimFlag()!;                                   // the cut: claimed and its nonce recorded, then the crash
    store.recordNonce(nonce, NOW + 3_600_000);
    expect(store.claimed().map((x) => x.id)).toEqual([cl.id]);
    const k = keeper(store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(k.pages.map(([kind]) => kind)).toEqual(["spent"]);
    expect(readdirSync(join(d, "trust")).filter((n) => n.includes("claim"))).toEqual([]);
    expect(store.refused()).toBeNull();
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["ship"]);
  });
  test("a claimed flag left before its nonce was recorded is spent by the next registration", async () => {
    const { store } = files();
    store.storeFlag(makeDrillFlag("verdict-fail", V, NOW, signer));
    store.claimFlag();
    const k = keeper(store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["drill"]);
    expect(store.claimed()).toEqual([]);
  });
});

describe("item 12: the flag is bound to the App's slug and version", () => {
  test("the flag names its App; another App's registration leaves it be, not refused", () => {
    const flag = makeDrillFlag("exit-on-start", V, NOW, signer, "0fcc2575_harness");
    expect(readDrillFlag(flag, SHIP_PUB, NOW)).toMatchObject({ ok: true, app: "0fcc2575_harness" });
    const { store } = files();
    store.storeFlag(flag);
    const k = keeper(store);
    expect(k.drill.spend(V, "0fcc2575_cain")).toEqual({ mode: null });
    expect(store.loadFlag()).toBe(flag);
    expect(store.refused()).toBeNull();
    expect(k.pages).toEqual([]);
    expect(k.drill.spend(V, "0fcc2575_harness")).toMatchObject({ mode: "exit-on-start" });
  });
  test("a round-15 flag (no App) doesn't verify", () => {
    const p = b64url(Buffer.from(JSON.stringify({ v: 2, kind: "keeper-drill", mode: "exit-on-start", to_version: V, at: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600, nonce: "0123456789abcdef" })));
    expect(readDrillFlag(`drl1.${p}.${b64url(signer(Buffer.from(`drl1.${p}`)))}`, SHIP_PUB, NOW).ok).toBe(false);
  });
});

describe("item 13: every Ship token carries an explicit kind ship", () => {
  test("the link's tokens carry it, and the link and the hook refuse one without it", () => {
    expect(JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString()).kind).toBe("ship");
    const p = b64url(Buffer.from(JSON.stringify({ v: 1, repo: "HyndeSyte/harness", pr: 46, head: SHA, exp: Math.floor(NOW / 1000) + 3600 })));
    const bare = `ship1.${p}.${b64url(signer(Buffer.from(`ship1.${p}`)))}`;
    expect(readToken(bare, publicKey(SHIP_PUB), NOW)).toEqual({ ok: false, why: "its payload kind isn't a Ship approval" });
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/hooks/remote-trigger.ts"), "utf8")).toContain("checked = readToken(token, publicKey(env.pub)");
  });
});

describe("item 14: the mark is root's, readable by the App, not writable by it; the lookup is the mark's own attempt", () => {
  test("the mark is written 0644 and the helper asks GET /attempt/<the mark's attempt>", async () => {
    const { d, store } = files();
    store.storeMark(markText());
    expect(statSync(join(d, "trust/keeper-drill-mark.json")).mode & 0o777).toBe(0o644);
    const asked: string[] = [];
    await helperMode({ version: V, now: () => NOW, sleep: async () => {}, loadMark: () => markText(), dropMark: () => {}, pub: () => DK.pub,
      ask: async (a) => { asked.push(a); return view(); }, abortedFor: () => false, aborted: () => {}, log: () => {} });
    expect(asked).toEqual([ATT]);
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/link/drill.ts"), "utf8")).toContain("keeperCall(base, token, `/attempt/${encodeURIComponent(attempt)}`");
  });
  test("the flag and the mark are left out of Cain's backups", () => {
    const cfg = readFileSync(join(ROOT, "config.yaml"), "utf8");
    const ex = cfg.slice(cfg.indexOf("backup_exclude:"), cfg.indexOf("timeout:"));
    for (const g of ["trust/keeper-drill.json*", "trust/keeper-drill-mark*", "link/keeper-drill-spent*"]) expect(ex).toContain(`  - "${g}"`);
  });
});

describe("item 15: nonce pruning never removes an entry newer than the high-water time", () => {
  test("a clock that starts behind can't revive a pruned nonce: the flag is judged against the high-water time", async () => {
    const { d } = files();
    const day = 86_400_000;
    let clock = NOW;
    const store = fileStore(join(d, "t/flag"), join(d, "t/mark"), join(d, "l/spent"), join(d, "t/ab"), () => clock, join(d, "l/refused.json"));
    const flag = makeDrillFlag("exit-on-start", V, NOW, signer);    // good for a day from NOW
    const nonce = JSON.parse(Buffer.from(flag.split(".")[1], "base64url").toString()).nonce;
    store.recordNonce(nonce, NOW + day);
    clock = NOW + 3 * day; store.recordNonce("00000000000000aa", clock + day);   // later: its entry pruned (a day past its expiry)
    expect(existsSync(join(d, "l/spent", nonce))).toBe(false);
    expect(store.highWater(NOW)).toBe(NOW + 3 * day);                 // the clock starts behind: the high-water time stands
    clock = NOW + 1000;
    store.storeFlag(flag);                                           // the old flag brought back, its nonce no longer listed
    const k = keeper(store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect(k.logs.some((l) => l.includes("ran out"))).toBe(true);
  });
  test("pruning keeps an entry while the high-water time hasn't passed it", () => {
    const { d } = files();
    const store = fileStore(join(d, "t/flag"), join(d, "t/mark"), join(d, "l/spent"), join(d, "t/ab"), () => NOW, join(d, "l/refused.json"));
    store.recordNonce("00000000000000bb", NOW - 1000);               // expired, but not a day past it
    store.recordNonce("00000000000000cc", NOW);
    expect(existsSync(join(d, "l/spent/00000000000000bb"))).toBe(true);
  });
});

describe("item 21: quiet hours for the owner's keeper cards", () => {
  test("no keeper card from 22:00 to 07:00 local; the held ones go at 07:00; a drill page is never held", async () => {
    const at = (h: number) => Date.parse(`2026-11-25T${String(h).padStart(2, "0")}:30:00-05:00`);
    expect([at(21), at(22), at(3), at(6), at(7)].map((t) => quietHours(t, "America/New_York"))).toEqual([false, true, true, true, false]);
    const r = rig({ now: at(23) });
    expect((await r.link.drillCard("exit-on-start", "0.19.1")).status).toBe("quiet");
    expect((await r.link.retryCard("ship-46-cain-01234567", "claim")).status).toBe("quiet");
    expect((await r.link.drillPage("refused", "refused:damaged:0123456789abcdef")).status).toBe("posted");
    expect(r.posts()).toBe(1);
    expect(await r.link.quietFlush()).toBe(0);
    r.t.now = at(7) + 24 * 3_600_000;
    expect(await r.link.quietFlush()).toBe(1);
    expect(r.posts()).toBe(2);
    expect(r.state().quietHeld).toBeUndefined();
  });
});
