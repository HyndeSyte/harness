// Keeper 0.1.13 and 0.1.14, Cain 0.19.0: the drill switch (link/drill.ts). Only the owner's tap on the link's drill card sets
// the one-shot drill flag (signed with the link's Ship key, kept by root, bound to the Cain version the card names); the next
// registration of Cain spends it and goes to the keeper as kind drill; the version it installs fails on purpose as the flag
// names, through the signed drill mark the link writes once the keeper definitively accepts, and only while Keeper names that
// attempt as a drill still in its watch. With no flag file nothing changes: kind ship, and a healthy start.
// Round 15's seven fixes each have a describe block named for them.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFor, makeToken, readToken, publicKey, b64url } from "../rootfs/opt/cain/ship-token";
import { keyFingerprint, passId, registerInstalls, settle, type PassDeps } from "../rootfs/opt/cain/link/ship-pass";
import { armFlag, DRILL_TTL_S, drillDeps, drillKeyFrom, drillModeFor, fileStore, keeperNames, makeDrillFlag, makeMark, markHash, MARK_TTL_MS, readDrillFlag, readMark,
  storeMarkPub, type DrillStore, type RefusedIntent } from "../rootfs/opt/cain/link/drill";
import { DRILL_LABEL } from "../rootfs/opt/cain/link/core";
import { CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth";
import { verdictRun } from "../rootfs/opt/cain/probe/keeper";
import { readShipToken } from "../../keeper/rootfs/opt/keeper/core";
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
const { privateKey: OTHER } = generateKeyPairSync("ed25519");
const ATT = `drill-46-cain-${SHA.slice(0, 8)}`;
const ROOT = join(import.meta.dir, "..");

// A drill store in memory (root's files on the Pi: fileStore). Keeper 0.1.15: the flag consumed by a claim of its exact instance
// (claims: instances renamed aside), the refused intent, and the high-water time.
function mem(o: { flag?: string | null; removeFails?: boolean; markFails?: boolean; spent?: string[]; taken?: boolean; claimFails?: boolean } = {}) {
  const s = { flag: o.flag ?? null as string | null, mark: null as string | null, spent: new Set(o.spent ?? []), aborted: [] as string[],
    claims: [] as { id: string; text: string }[], refused: null as RefusedIntent | null, hw: 0, n: 0 };
  const store: DrillStore = {
    loadFlag: () => s.flag, removeFlag: () => { if (o.removeFails) throw new Error("EROFS"); s.flag = null; }, storeFlag: (t) => { s.flag = t; },
    loadMark: () => s.mark, storeMark: (t) => { if (o.markFails) throw new Error("ENOSPC"); s.mark = t; }, removeMark: () => { s.mark = null; },
    spent: (n) => s.spent.has(n),
    recordNonce: (n) => { if (o.taken || s.spent.has(n)) return "taken"; s.spent.add(n); return "recorded"; },
    aborted: (l) => { s.aborted.push(l); },
    claimFlag: () => { if (o.claimFails) throw new Error("EIO"); if (s.flag === null) return null; const c = { id: (++s.n).toString(16).padStart(12, "0"), text: s.flag }; s.flag = null; s.claims.push(c); return c; },
    claimed: () => s.claims.map((c) => ({ ...c })),
    dropClaim: (id) => { if (o.removeFails) throw new Error("EROFS"); s.claims = s.claims.filter((c) => c.id !== id); },
    refused: () => s.refused, storeRefused: (r) => { s.refused = r; }, clearRefused: () => { const was = !!s.refused; s.refused = null; return was; },
    highWater: (t) => { s.hw = Math.max(s.hw, t); return s.hw; },
  };
  return { s, store };
}
const flagOf = (mode: "exit-on-start" | "verdict-fail", version = V, now = NOW, sign = signer) => makeDrillFlag(mode, version, now, sign);
const nonceOf = (flag: string) => JSON.parse(Buffer.from(flag.split(".")[1], "base64url").toString()).nonce as string;

// The registration's world: GitHub at the base and head, and a keeper that registers, then accepts (or not), and confirms marks
const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
const files: Record<string, any> = {
  [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64(`version: "${V}"\n`),
  [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"),
  [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${FPR}\n`),
};
const api = async (path: string) => {
  if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
  const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
  const f = m ? files[`${m[1]}@${m[2]}`] : null;
  return f ? { status: 200, body: f } : { status: 404, body: null };
};
type KeeperMode = "accept" | "pending" | "refuse" | "no-answer" | "not-taken";
function keeper(store: DrillStore, o: { mode?: KeeperMode; markAnswer?: { status: number; body: any } | null } = {}) {
  let now = NOW; const posted: any[] = []; let enrolled: any = null; const logs: string[] = []; const pages: [string, string, any][] = []; const marks: any[] = [];
  const idOf = (b: any) => `${b.kind}-46-cain-${SHA.slice(0, 8)}`;
  let last: any = null;
  const drill = drillDeps(store, () => SHIP_PUB, () => now, (l) => logs.push(l), { sign: markSigner, markPub: () => DK.pub, page: (k, key, info) => pages.push([k, key, info]) });
  const deps = { api, log: (l: string) => logs.push(l), now: () => now, sleep: async (ms: number) => { now += ms; }, linkFp: FPR,
    enrollment: { load: () => enrolled, store: (e: any) => { enrolled = e; } }, drill,
    post: async (b: any) => { posted.push(b); last = b; if (o.mode === "not-taken") return { status: 409, body: { status: "refused", why: "a replay" } };
      return { status: 202, body: { status: "pending", id: idOf(b) } }; },
    get: async () => o.mode === "pending" ? { status: 200, body: { status: "pending", id: idOf(last) } }
      : o.mode === "refuse" ? { status: 200, body: { status: "refused", id: idOf(last), why: "the backup failed" } }
      : o.mode === "no-answer" ? null
      : { status: 200, body: { status: "accepted", id: idOf(last), app: "0fcc2575_cain", from_version: "0.18.0", to_version: V, backup: "kb1", until: "x", kind: last.kind,
        ...(last.drill_mode ? { drill_mode: last.drill_mode, marked: false } : {}), ...ENROLLED } },
    markPost: async (attempt: string, body: any) => { marks.push({ attempt, ...body }); return o.markAnswer !== undefined ? o.markAnswer : { status: 200, body: { status: "marked", id: attempt } }; },
  };
  return { deps, posted, logs, pages, marks, drill };
}
const c = claimFor(PR, SHA, NOW)!;
// Keeper's GET /attempt answer for a drill in its watch, with the mark confirmed (Keeper server.ts)
// Keeper 0.1.15: GET /attempt/<id> (attemptView): its id, and the Supervisor's install job tied to it (attempt: the open-attempt read's field)
const openOf = (over: any = {}) => ({ status: 200, body: { app: "0fcc2575_cain", id: ATT, attempt: ATT, from_version: "0.18.0", to_version: V, status: "watching", kind: "drill", drill_mode: "exit-on-start", marked: true,
  install_job: "inst-1", install_job_at: T(NOW - 60_000), ...over } });

describe("the registration spends the flag (ship-pass.ts registerInstalls)", () => {
  test("with no flag file the registration is kind ship, and no mark is written", async () => {
    const m = mem(); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["ship"]);
    expect(k.posted[0].drill_mode).toBeUndefined();
    expect(m.s.mark).toBeNull();
    expect(k.pages).toEqual([]);
  });
  test("kind drill, with the flag's mode and nonce, only while the flag is set; one registration spends it", async () => {
    const flag = flagOf("exit-on-start");
    const m = mem({ flag }); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(true);
    expect(k.posted.map((b) => [b.kind, b.drill_mode, b.drill_nonce])).toEqual([["drill", "exit-on-start", nonceOf(flag)]]);
    expect((r as any).accepted[0].attempt).toBe(ATT);
    expect(m.s.flag).toBeNull();
    expect(m.s.spent.has(nonceOf(flag))).toBe(true);
    expect(k.logs.some((l) => l.includes("the owner's drill flag (exit-on-start, Cain 0.19.0) is spent by this registration"))).toBe(true);
    // the mark: signed with the drill key, for this attempt, mode and version, and confirmed to the keeper by its hash
    expect(readMark(m.s.mark, DK.pub, NOW)).toMatchObject({ ok: true, mark: { version: V, attempt: ATT, mode: "exit-on-start" } });
    expect(k.marks).toEqual([{ attempt: ATT, mode: "exit-on-start", to_version: V, mark: markHash(m.s.mark!) }]);
    await registerInstalls(k.deps, TOKEN, c);
    expect(k.posted.map((b) => b.kind)).toEqual(["drill", "ship"]);
  });
});

describe("fix 1: fail closed on a bad flag", () => {
  const good = flagOf("exit-on-start").split(".");
  const swapped = Buffer.from(Buffer.from(good[1], "base64url").toString().replace("exit-on-start", "verdict-fail")).toString("base64url");
  const v1 = (() => { const p = b64url(Buffer.from(JSON.stringify({ v: 1, kind: "keeper-drill", mode: "exit-on-start", at: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600, nonce: "0123456789abcdef" })));
    return `drl1.${p}.${b64url(signer(Buffer.from(`drl1.${p}`)))}`; })();
  const bad: [string, string][] = [
    ["signed by another key (anything Cain could make)", flagOf("exit-on-start", V, NOW, (d) => edSign(null, d, OTHER))],
    ["a plain note", '{"mode": "exit-on-start"}'],
    ["run out", flagOf("verdict-fail", V, NOW - (DRILL_TTL_S + 60) * 1000)],
    ["a payload swapped under a good signature", `${good[0]}.${swapped}.${good[2]}`],
    ["a round-14 flag with no version or nonce", v1],
    ["cut short", flagOf("exit-on-start").slice(0, 60)],
  ];
  for (const [name, flag] of bad) {
    test(`a flag ${name}: removed, nothing registered or installed, logged, and the owner paged once`, async () => {
      const m = mem({ flag }); const k = keeper(m.store);
      const r = await registerInstalls(k.deps, TOKEN, c);
      expect(r.ok).toBe(false);
      expect(k.posted).toEqual([]);                                 // never kind ship: nothing registered at all
      expect(m.s.flag).toBeNull();
      expect(m.s.mark).toBeNull();
      expect((r as any).said.join(" ")).toContain("so nothing was installed");
      expect(k.logs.some((l) => l.startsWith("a drill flag was refused and removed: didn't verify"))).toBe(true);
      // Keeper 0.1.15 item 8: the refusal is persisted, and paged with its Clear button
      expect(k.pages.map(([kind]) => kind)).toEqual(["refused"]);
      expect(m.s.refused).toMatchObject({ kind: "damaged" });
    });
  }
  test("the owner's page says what happened and is posted once per flag, with no button", async () => {
    const r = rig();
    const a = await r.link.drillPage("damaged", "damaged:0123456789abcdef");
    expect(a.status).toBe("posted");
    expect(r.msg(a.message!).content).toBe("Keeper drill: the drill flag was damaged or had run out; nothing was installed; arm it again.");
    expect(r.buttons(a.message!)).toEqual([]);
    expect((await r.link.drillPage("damaged", "damaged:0123456789abcdef")).status).toBe("done");
    expect(r.posts()).toBe(1);
  });
  test("a flag that can't be read, or can't be removed after its nonce is recorded, installs nothing", async () => {
    const m = mem({ flag: "x" }); m.store.loadFlag = () => { throw new Error("EIO"); };
    const k = keeper(m.store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(k.posted).toEqual([]);
    const flag = flagOf("exit-on-start");
    const n = mem({ flag, removeFails: true }); const kn = keeper(n.store);
    expect((await registerInstalls(kn.deps, TOKEN, c)).ok).toBe(false);
    expect(kn.posted).toEqual([]);
    expect(n.s.spent.has(nonceOf(flag))).toBe(true);              // it can never count again
    // Keeper 0.1.15 item 11: left claimed, its nonce spent: the next registration removes it, refuses once, pages once, then ship
    const k2 = keeper(n.store); (n.store as any).dropClaim = (id: string) => { n.s.claims = n.s.claims.filter((x) => x.id !== id); };
    expect((await registerInstalls(k2.deps, TOKEN, c)).ok).toBe(false);
    expect(k2.pages.map(([kind]) => kind)).toEqual(["spent"]);
    expect(n.s.claims).toEqual([]);
    expect((await registerInstalls(k2.deps, TOKEN, c)).ok).toBe(true);
    expect(k2.posted.map((b) => b.kind)).toEqual(["ship"]);
  });
});

describe("fix 2: the mark is bound to its attempt, and a stray mark is harmless", () => {
  const mark = (mode: "exit-on-start" | "verdict-fail" = "exit-on-start", attempt = ATT, version = V) => makeMark({ version, attempt, mode }, NOW, markSigner);
  test("a mark counts only while Keeper names that attempt as a drill of that mode and version, its mark confirmed, in its watch", () => {
    expect(drillModeFor(mark(), DK.pub, V, NOW, openOf())).toMatchObject({ mode: "exit-on-start", drop: false });
    // Keeper 0.1.15 item 7: a failed lookup keeps the mark (retry), never a drop
    for (const open of [null, { status: 401, body: {} }, { status: 503, body: {} }]) expect(drillModeFor(mark(), DK.pub, V, NOW, open as any)).toMatchObject({ mode: null, drop: false, retry: true });
    for (const [why, open] of [
      ["Keeper has no such attempt", { status: 404, body: { status: "unknown" } }],
      ["names no attempt", openOf({ id: null })],
      ["not the mark's attempt", openOf({ id: "drill-46-cain-ffffffff" })],
      ["no drill", openOf({ kind: "ship", drill_mode: undefined })],
      ["drill mode for it isn't the mark's", openOf({ drill_mode: "verdict-fail" })],
      ["version for it isn't this start's", openOf({ to_version: "0.19.1" })],
      ["no confirmation of the mark", openOf({ marked: false })],
      ["not in its watch", openOf({ status: "rolled back" })],
    ] as const) {
      const r = drillModeFor(mark(), DK.pub, V, NOW, open as any);
      expect(r.mode).toBeNull();
      expect(r.drop).toBe(true);
      expect(r.why).toContain(why);
    }
    // the version a rollback restores, or any later one, never acts on it (and leaves it to lapse)
    expect(drillModeFor(mark(), DK.pub, "0.18.0", NOW, openOf())).toMatchObject({ mode: null, drop: false });
    expect(drillModeFor(mark(), DK.pub, V, NOW + MARK_TTL_MS + 1, openOf()).mode).toBeNull();
  });
  test("the run script's helper: with Keeper naming the drill it prints the mode; otherwise it drops the mark and logs why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drill-"));
    const f = join(dir, "mark.json"), pubf = join(dir, "mark.pub");
    writeFileSync(pubf, `${DK.pub}\n`);
    let open: any = openOf();
    const tok = ["test", "only", "keeper", "token", "value"].join("-");   // a made-up test value, at least 16 characters
    // Keeper 0.1.15: asked about the mark's own attempt only (GET /attempt/<id>)
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => req.headers.get("authorization") !== `Bearer ${tok}` ? new Response("no", { status: 401 })
      : new URL(req.url).pathname === `/attempt/${ATT}` ? Response.json({ ...open.body, install_job_at: T(Date.now() - 60_000) }) : new Response("no", { status: 404 }) });
    const run = async (v: string, token = tok) => {
      const p = Bun.spawn(["bun", join(ROOT, "rootfs/opt/cain/link/drill.ts"), "mode", v], { stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CAIN_DRILL_MARK: f, CAIN_DRILL_MARK_PUB: pubf, CAIN_DRILL_ABORTED: join(dir, "aborted.jsonl"), KEEPER_URL: `http://127.0.0.1:${server.port}`, KEEPER_TOKEN: token } });
      await p.exited;
      return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: p.exitCode };
    };
    try {
      writeFileSync(f, makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, Date.now(), markSigner));
      expect((await run(V)).out).toBe("exit-on-start\n");
      expect((await run("0.18.0")).out).toBe("");                 // another version: nothing, and the mark stays
      expect(existsSync(f)).toBe(true);
      open = openOf({ kind: "ship", drill_mode: undefined });       // a reinstall outside the drill: Keeper names no drill
      const r = await run(V);
      expect(r.out).toBe("");
      expect(r.code).toBe(0);
      expect(r.err).toContain("was dropped: Keeper registered that attempt as no drill; this start goes on as usual");
      expect(existsSync(f)).toBe(false);
      writeFileSync(f, makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, Date.now(), markSigner));
      open = openOf();
      // Keeper 0.1.15 item 7: no token, Keeper can't be asked: the mark is kept, and the start aborts (recorded), never a usual start
      const t = await run(V, "");
      expect(t.out).toBe("abort\n");
      expect(t.err).toContain("no keeper_token is set");
      expect(existsSync(f)).toBe(true);
    } finally { server.stop(true); }
  });
  test("a competing, retried or rejected registration never erases an active mark; only its attempt's cancel does", async () => {
    const m = mem({ flag: flagOf("exit-on-start") }); const k = keeper(m.store);
    await registerInstalls(k.deps, TOKEN, c);
    const active = m.s.mark;
    expect(active).not.toBeNull();
    await registerInstalls(k.deps, TOKEN, c);                       // a competing ship registration (no flag)
    expect(m.s.mark).toBe(active);
    const rej = keeper(m.store, { mode: "not-taken" });             // a rejected one
    await registerInstalls(rej.deps, TOKEN, c);
    expect(m.s.mark).toBe(active);
    k.drill.drop("drill-46-cain-ffffffff");                         // another attempt's cancel: kept
    expect(m.s.mark).toBe(active);
    k.drill.drop(ATT);                                              // its own: removed
    expect(m.s.mark).toBeNull();
  });
});

describe("fix 3: the mark is signed with the drill key", () => {
  test("the drill key is derived from the Ship key under its own domain: stable, and not the Ship key", () => {
    expect(drillKeyFrom(SHIP_KEYS.privateKey).pub).toBe(DK.pub);
    expect(DK.pub).not.toBe(SHIP_PUB);
    expect(drillKeyFrom(OTHER).pub).not.toBe(DK.pub);
  });
  test("a hand-written, unsigned or wrongly signed mark is ignored and logged, never acted on", () => {
    const plain = JSON.stringify({ v: 1, mode: "exit-on-start", attempt: ATT, to_version: V, head: SHA, at: NOW });   // round 14's mark
    const byShip = makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, NOW, signer);                       // the Ship key, not the drill key
    const byOther = makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, NOW, (d) => edSign(null, d, OTHER));
    for (const t of [plain, byShip, byOther, "drm1.x.y"]) {
      const r = drillModeFor(t, DK.pub, V, NOW, openOf());
      expect(r).toMatchObject({ mode: null, drop: false });
      expect(r.why).toStartWith("a drill mark was ignored");
    }
    expect(readMark(makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, NOW, markSigner), null, NOW).ok).toBe(false);   // no public half: never acted on
  });
  test("a mark planted on a ship-kind attempt changes nothing: the probe asks as usual, and the helper drops it", async () => {
    const SHIP_ATT = `ship-46-cain-${SHA.slice(0, 8)}`;
    // a planted mark can't even name a ship attempt (the mark's attempt is drill-...), and a signed one for a drill id is still
    // judged against Keeper's answer, which names a ship attempt
    expect(() => makeMark({ version: V, attempt: SHIP_ATT, mode: "verdict-fail" }, NOW, markSigner)).toThrow();
    const planted = makeMark({ version: V, attempt: ATT, mode: "verdict-fail" }, NOW, markSigner);
    for (const t of [planted, JSON.stringify({ v: 1, mode: "verdict-fail", attempt: SHIP_ATT, to_version: V, head: SHA, at: NOW })]) {
      const posted: any[] = []; let asked = 0;
      const shipOpen = { status: 200, body: { attempt: SHIP_ATT, to_version: V, status: "watching", kind: "ship" } };
      const res = await verdictRun({ version: V, log: () => {}, get: async () => shipOpen, post: async (_p, b) => { posted.push(b); return { status: 200, body: {} }; },
        ask: async () => { asked++; return true; }, drill: (a, open) => { const r = drillModeFor(t, DK.pub, V, NOW, open); return r.mode && r.mark?.attempt === a ? r.mode : null; } });
      expect(res).toBe("PASS");
      expect(asked).toBe(1);
      expect(posted[0]).toMatchObject({ attempt: SHIP_ATT, result: "PASS" });
    }
  });
  test("verdict-fail: the probe reports FAIL for the drill attempt without asking, only with the signed mark and Keeper's word", async () => {
    const t = makeMark({ version: V, attempt: ATT, mode: "verdict-fail" }, NOW, markSigner);
    const open = openOf({ drill_mode: "verdict-fail" });
    const posted: any[] = []; let asked = 0;
    const d = { version: V, log: () => {}, get: async () => open, post: async (_p: string, b: any) => { posted.push(b); return { status: 200, body: {} }; },
      ask: async () => { asked++; return true; }, drill: (a: string, o: any) => { const r = drillModeFor(t, DK.pub, V, NOW, o); return r.mode && r.mark?.attempt === a ? r.mode : null; } };
    expect(await verdictRun(d)).toBe("FAIL");
    expect(asked).toBe(0);
    expect(posted[0]).toMatchObject({ attempt: ATT, version: V, result: "FAIL" });
    expect(posted[0].reason).toContain("a Keeper drill");
  });
});

describe("fix 4: spent nonces", () => {
  const dirs = () => { const d = mkdtempSync(join(tmpdir(), "drill-")); return { d, store: fileStore(join(d, "trust/keeper-drill.json"), join(d, "trust/keeper-drill-mark.json"), join(d, "link/keeper-drill-spent"), join(d, "trust/aborted.jsonl")) }; };
  test("the nonce is recorded before the flag is removed, and a restored backup that brings the old flag back is refused", async () => {
    const { d, store } = dirs();
    const flag = flagOf("exit-on-start");
    store.storeFlag(flag);
    const k = keeper(store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(true);
    expect(existsSync(join(d, "trust/keeper-drill.json"))).toBe(false);
    expect(readdirSync(join(d, "link/keeper-drill-spent")).filter((n) => !n.startsWith("."))).toEqual([nonceOf(flag)]);
    // a restore of /data/trust from a backup taken while the flag was armed: the spent list, outside the backup, stays
    writeFileSync(join(d, "trust/keeper-drill.json"), flag);
    const k2 = keeper(store);
    const r = await registerInstalls(k2.deps, TOKEN, c);
    expect(r.ok).toBe(false);
    expect(k2.posted).toEqual([]);
    expect(existsSync(join(d, "trust/keeper-drill.json"))).toBe(false);
    expect(k2.logs.some((l) => l.includes("was spent before"))).toBe(true);
    expect(k2.pages.map(([kind]) => kind)).toEqual(["spent"]);       // Keeper 0.1.15 item 11: refused once, no refused intent
    expect((await registerInstalls(k2.deps, TOKEN, c)).ok).toBe(true);
  });
  test("the spent list is outside Cain's backups", () => {
    const cfg = readFileSync(join(ROOT, "config.yaml"), "utf8");
    const ex = cfg.slice(cfg.indexOf("backup_exclude:"), cfg.indexOf("timeout:"));
    expect(ex).toContain('  - "link/keeper-drill-spent*"');
    const main = readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8");
    // Cain 0.19.2: main.ts builds the store with linkDrillStore (drill.ts), handing it the link's folder
    expect(main).toContain("linkDrillStore(process.env, TRUST_DIR, DIR, Date.now)");
    const drillSrc = readFileSync(join(ROOT, "rootfs/opt/cain/link/drill.ts"), "utf8");
    expect(drillSrc).toContain("env.CAIN_DRILL_SPENT ?? `${linkDir}/keeper-drill-spent`");
  });
  test("only the caller that records the nonce goes on as drill; a concurrent caller stops visibly and leaves the flag to it", async () => {
    const { store } = dirs();
    expect(store.recordNonce("0123456789abcdef", NOW + 3_600_000)).toBe("recorded");
    expect(store.recordNonce("0123456789abcdef", NOW + 3_600_000)).toBe("taken");
    // two registrations read the flag at once: the second's exclusive record finds it taken
    const flag = flagOf("verdict-fail");
    const m = mem({ flag, taken: true }); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect((r as any).said.join(" ")).toContain("another registration is spending the drill flag at the same moment, so this one stops");
    expect(m.s.claims.map((x) => x.text)).toEqual([flag]);          // Keeper 0.1.15: its claimed instance stays for the one that recorded it
  });
  test("a nonce that can't be recorded installs nothing and leaves the flag for the next try", async () => {
    const flag = flagOf("exit-on-start");
    const m = mem({ flag }); m.store.recordNonce = () => { throw new Error("EROFS"); };
    const k = keeper(m.store);
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect(m.s.claims.map((x) => x.text)).toEqual([flag]);          // Keeper 0.1.15: left claimed, spent by the next try
    m.store.recordNonce = (n) => { m.s.spent.add(n); return "recorded"; };
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["drill"]);
  });
});

describe("fix 5: definitive acceptance only", () => {
  for (const [mode, why] of [["pending", "the keeper's answer was still pending when the wait ended"], ["refuse", "the keeper didn't accept it with a confirmed backup"], ["no-answer", "the keeper didn't accept it with a confirmed backup"],
    ["not-taken", "the keeper didn't take its registration"]] as const) {
    test(`a ${mode} answer: no mark, no install, the spent flag said in the log, and the owner paged once`, async () => {
      const m = mem({ flag: flagOf("exit-on-start") }); const k = keeper(m.store, { mode });
      const r = await registerInstalls(k.deps, TOKEN, c);
      expect(r.ok).toBe(false);
      expect(m.s.mark).toBeNull();
      expect(m.s.flag).toBeNull();
      expect(k.logs.some((l) => l.includes(`the spent drill flag (exit-on-start) installs nothing: ${why}`))).toBe(true);
      expect(k.pages.map(([kind]) => kind)).toEqual(["accept"]);
    });
  }
  test("a mark that can't be written records the attempt as aborted, cancels it and pages the owner", async () => {
    const m = mem({ flag: flagOf("verdict-fail"), markFails: true }); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(false);
    expect((r as any).cancel).toBe("the drill was aborted: its mark couldn't be written");
    expect((r as any).said.join(" ")).toContain("the drill is aborted, not installed");
    expect(JSON.parse(m.s.aborted[0])).toMatchObject({ attempt: ATT, version: V, why: "its mark couldn't be written" });
    expect(k.pages.map(([kind, key]) => [kind, key])).toEqual([["aborted", `aborted:${ATT}`]]);
  });
  test("a mark Keeper doesn't confirm is dropped locally and the drill aborted", async () => {
    for (const markAnswer of [null, { status: 409, body: { status: "refused", why: "it is claimed, not accepted" } }]) {
      const m = mem({ flag: flagOf("exit-on-start") }); const k = keeper(m.store, { markAnswer });
      const r = await registerInstalls(k.deps, TOKEN, c);
      expect(r.ok).toBe(false);
      expect(m.s.mark).toBeNull();
      expect((r as any).cancel).toStartWith("the drill was aborted: the keeper didn't confirm its mark");
      expect(k.pages.map(([kind]) => kind)).toEqual(["aborted"]);
    }
  });
  test("an acceptance that isn't this drill's (another kind or mode) installs nothing", async () => {
    const m = mem({ flag: flagOf("exit-on-start") }); const k = keeper(m.store);
    const get = k.deps.get;
    k.deps.get = async () => { const r: any = await get(); r.body.drill_mode = "verdict-fail"; return r; };
    expect((await registerInstalls(k.deps, TOKEN, c)).ok).toBe(false);
    expect(m.s.mark).toBeNull();
    expect(k.pages.map(([kind]) => kind)).toEqual(["accept"]);
  });
  test("a cancel that answers pending still drops the mark locally", async () => {
    const m = mem({ flag: flagOf("exit-on-start") }); const k = keeper(m.store);
    await registerInstalls(k.deps, TOKEN, c);
    expect(m.s.mark).not.toBeNull();
    let file = JSON.stringify({ format: 2, spent: [{ id: passId(TOKEN), exp: Math.floor(NOW / 1000) + 3600, state: "registering", at: NOW, attempts: [ATT] }] });
    const retried: string[] = [];
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => NOW, load: () => file, store: (t) => { file = t; }, register: () => {}, log: () => {},
      cancel: async () => ({ status: 202, body: { status: "pending", operation: "op-1" } }), retry: (a) => { retried.push(a); }, dropMark: (a) => k.drill.drop(a) };
    settle(d, passId(TOKEN), { ok: false, said: ["the keeper refused Harness"] });
    expect(m.s.mark).toBeNull();
    await Bun.sleep(5);
    expect(retried).toEqual([ATT]);                                  // the pending cancel is no success: the retry card
  });
});

describe("fix 6: a drill flag is never a Ship token, and the drill's trust files are root's", () => {
  test("a valid drill flag presented as a Ship token is refused by every verifier, and so is a Ship-prefixed drill payload", () => {
    const flag = flagOf("exit-on-start");
    expect(readToken(flag, publicKey(SHIP_PUB), NOW).ok).toBe(false);
    expect(readShipToken(flag, publicKey(SHIP_PUB), NOW).ok).toBe(false);
    // the same drill payload, signed by the Ship key under the Ship prefix: refused on its payload kind
    const p = b64url(Buffer.from(JSON.stringify({ v: 1, kind: "keeper-drill", repo: "HyndeSyte/harness", pr: 46, head: SHA, exp: Math.floor(NOW / 1000) + 3600, mode: "exit-on-start" })));
    const forged = `ship1.${p}.${b64url(signer(Buffer.from(`ship1.${p}`)))}`;
    expect(readToken(forged, publicKey(SHIP_PUB), NOW)).toEqual({ ok: false, why: "its payload kind isn't a Ship approval" });
    expect(readShipToken(forged, publicKey(SHIP_PUB), NOW)).toEqual({ ok: false, why: "its token's payload kind isn't a Ship approval" });
    // a Ship approval's own shape passes, with or without kind "ship"
    expect(readToken(TOKEN, publicKey(SHIP_PUB), NOW).ok).toBe(true);
    // Keeper 0.1.15 item 13: a Ship approval without its kind is refused by both
    const bare = b64url(Buffer.from(JSON.stringify({ v: 1, repo: "HyndeSyte/harness", pr: 46, head: SHA, exp: Math.floor(NOW / 1000) + 3600 })));
    const noKind = `ship1.${bare}.${b64url(signer(Buffer.from(`ship1.${bare}`)))}`;
    expect(readToken(noKind, publicKey(SHIP_PUB), NOW).ok).toBe(false);
    expect(readShipToken(noKind, publicKey(SHIP_PUB), NOW).ok).toBe(false);
    const q = b64url(Buffer.from(JSON.stringify({ v: 1, kind: "ship", repo: "HyndeSyte/harness", pr: 46, head: SHA, exp: Math.floor(NOW / 1000) + 3600 })));
    const kinded = `ship1.${q}.${b64url(signer(Buffer.from(`ship1.${q}`)))}`;
    expect(readToken(kinded, publicKey(SHIP_PUB), NOW).ok).toBe(true);
    expect(readShipToken(kinded, publicKey(SHIP_PUB), NOW).ok).toBe(true);
    // the hook verifies with the same readToken
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/hooks/remote-trigger.ts"), "utf8")).toContain("checked = readToken(token, publicKey(env.pub)");
  });
  test("the flag, the mark, its public half, the spent nonces and the aborted record are root's only (0600, the spent folder 0700)", () => {
    const d = mkdtempSync(join(tmpdir(), "drill-"));
    const store = fileStore(join(d, "trust/flag"), join(d, "trust/mark"), join(d, "link/spent"), join(d, "trust/aborted.jsonl"));
    writeFileSync(join(d, "x"), "");
    store.storeFlag(flagOf("exit-on-start"));
    store.storeMark("drm1.a.b");
    store.recordNonce("0123456789abcdef", NOW + 1000);
    store.aborted("{}");
    storeMarkPub(DK.pub, join(d, "trust/mark.pub"));
    for (const f of ["trust/flag", "trust/mark.pub", "link/spent/0123456789abcdef", "trust/aborted.jsonl"]) expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, "trust/mark")).mode & 0o777).toBe(0o644);   // Keeper 0.1.15 item 14: readable by the App, never writable by it
    expect(statSync(join(d, "link/spent")).mode & 0o777).toBe(0o700);
    const run = readFileSync(join(ROOT, "rootfs/etc/services.d/cain/run"), "utf8");
    expect(run).toContain('timeout 120 bun "$OPT/link/drill.ts" mode "$version" || echo abort');   // read as root by the run script
  });
});

describe("fix 7: the flag is bound to a target version at tap time", () => {
  test("the card names the version; his tap signs a flag for it; Cain's request alone sets nothing", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "drill-"));
    const store = fileStore(join(dir, "keeper-drill.json"), join(dir, "keeper-drill-mark.json"), join(dir, "spent"), join(dir, "aborted"));
    (r.link as any).d.armDrill = (mode: any, version: string) => armFlag(store, mode, version, Date.now(), signer);
    await expect(r.link.drillCard("verdict-fail")).rejects.toThrow("a drill names the Cain version");
    const out = await r.link.drillCard("verdict-fail", "0.19.1");
    expect(out.status).toBe("posted");
    expect(r.buttons(out.message!)).toEqual([DRILL_LABEL]);
    expect(r.ids(out.message!)).toEqual(["k:drill:verdict-fail"]);
    expect(r.msg(out.message!).content).toContain("it must be Cain 0.19.1");
    expect(r.msg(out.message!).content).toContain("reports a failed check after it starts");
    expect(existsSync(join(dir, "keeper-drill.json"))).toBe(false);
    expect((await r.link.drillCard("verdict-fail", "0.19.1")).status).toBe("open");
    expect(r.posts()).toBe(1);
    const msg = r.msg(out.message!);
    const it = (user: string) => ({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: user }, data: { custom_id: "k:drill:verdict-fail" }, message: msg });
    expect(await (r.link as any).drillTap(it("7777"), out.message!)).toBe("refused: not the owner");
    expect(existsSync(join(dir, "keeper-drill.json"))).toBe(false);
    expect(await (r.link as any).drillTap(it(OWNER), out.message!)).toBe("drill armed");
    const flag = readFileSync(join(dir, "keeper-drill.json"), "utf8");
    expect(readDrillFlag(flag, SHIP_PUB, Date.now())).toMatchObject({ ok: true, mode: "verdict-fail", version: "0.19.1" });
    expect(r.state().messages[out.message!].outcome).toBe("answered");
    expect(r.relayed.some((l: string) => l.includes(`Dane tapped ${DRILL_LABEL} (verdict-fail, Cain 0.19.1)`))).toBe(true);
    expect((await r.link.drillCard("verdict-fail", "0.19.1")).status).toBe("posted");
  });
  test("a card for another version retires the open one: its tap arms nothing", async () => {
    const r = rig();
    let armed = 0;
    (r.link as any).d.armDrill = () => { armed++; return { ok: true, why: "" }; };
    const a = await r.link.drillCard("exit-on-start", "0.19.1");
    const b = await r.link.drillCard("exit-on-start", "0.19.2");
    expect(b.status).toBe("posted");
    expect(r.state().messages[a.message!].outcome).toBe("replaced");
    const it = { type: 3, id: "12", token: "t", application_id: BOT, channel_id: DM, user: { id: OWNER }, data: { custom_id: "k:drill:exit-on-start" }, message: r.msg(a.message!) };
    expect(await (r.link as any).drillTap(it, a.message!)).not.toBe("drill armed");
    expect(armed).toBe(0);
  });
  test("a registration naming another version refuses, removes the flag, logs it and pages", async () => {
    const m = mem({ flag: flagOf("exit-on-start", "0.19.1") }); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(false);
    expect(k.posted).toEqual([]);
    expect(m.s.flag).toBeNull();
    expect(k.logs.some((l) => l.includes("was armed for Cain 0.19.1, but this install carries 0.19.0"))).toBe(true);
    // Keeper 0.1.15 item 8: the refusal is persisted and paged once, with its Clear button
    expect(k.pages).toEqual([["refused", expect.stringMatching(/^refused:version:[0-9a-f]{16}$/), { armed: "0.19.1", version: "0.19.0" }]]);
    expect(m.s.refused).toMatchObject({ kind: "version", armed: "0.19.1", version: "0.19.0" });
    const card = rig();
    const p = await card.link.drillPage("version", "version:0123456789abcdef", { armed: "0.19.1", version: "0.19.0" });
    expect(card.msg(p.message!).content).toBe("Keeper drill: the drill flag was armed for Cain 0.19.1, but the install carried 0.19.0; nothing was installed; arm it again for the right version.");
  });
  test("keeper.sh drill-arm takes the mode and the version, and reaches /drill-arm, Cain's route only", () => {
    expect(CAIN_ROUTES.has("/drill-arm")).toBe(true);
    expect(routeAllowed("cain", "/drill-arm")).toBe(true);
    expect(routeAllowed("specialist", "/drill-arm")).toBe(false);
    expect(routeAllowed("root", "/drill-arm")).toBe(false);
    const sh = readFileSync(join(ROOT, "rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).toContain("connector|drill-arm) url=\"$link/$cmd\"");
    expect(sh).toContain("exit-on-start|verdict-fail) ;;");
    expect(sh).toContain(`body=$(jq -nc --arg m "$1" --arg v "$2" '{mode: $m, version: $v}') ;;`);
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/link/http.ts"), "utf8")).toContain('case "/drill-arm": return json(await link.drillCard(b.mode, b.version));');
  });
});

describe("the switch's wiring", () => {
  test("no card while stopped, and no mode but the two", async () => {
    const s = rig(); s.stop.stopped = true;
    expect((await s.link.drillCard("exit-on-start", "0.19.1")).status).toBe("stopped");
    expect(s.posts()).toBe(0);
    await expect(rig().link.drillCard("rollback-anyway", "0.19.1")).rejects.toThrow("a drill takes exit-on-start or verdict-fail");
  });
  test("only main.ts signs a flag or a mark, inside the link's own dependencies", () => {
    const main = readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main.match(/armFlag\(/g)?.length).toBe(1);
    expect(main).toContain("armDrill: shipPriv ? (mode, version) => armFlag(drillStore, mode, version, Date.now(), (data) => edSign(null, data, shipPriv)) : undefined,");
    expect(main).toContain("sign: drillKey ? (data) => edSign(null, data, drillKey.priv) : undefined");
    expect(main).toContain("markPost: (attempt, body) => keeperPost(`/attempt/${attempt}/drill-mark`, body)");
    const core = readFileSync(join(ROOT, "rootfs/opt/cain/link/core.ts"), "utf8");
    for (const s of ["makeDrillFlag(", "armFlag(", "makeMark(", "drillKeyFrom("]) expect(core).not.toContain(s);
  });
  test("keeperNames reads Keeper's answer for the open attempt exactly", () => {
    const m = readMark(makeMark({ version: V, attempt: ATT, mode: "exit-on-start" }, NOW, markSigner), DK.pub, NOW);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(keeperNames(m.mark, V, openOf(), NOW).why).toBe("");
      for (const st of ["accepted", "claimed", "watching"]) expect(keeperNames(m.mark, V, openOf({ status: st }), NOW).why).toBe("");
      for (const st of ["verifying", "restoring", "passed", "ended", "aborted"]) expect(keeperNames(m.mark, V, openOf({ status: st }), NOW)).toMatchObject({ definitive: true });
    }
  });
});
