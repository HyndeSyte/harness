// Keeper 0.1.13, Cain 0.19.0: the drill switch (link/drill.ts). Only the owner's tap on the link's drill card sets the
// one-shot drill flag (signed with the link's Ship key, kept by root); the next registration of Cain spends it and goes to
// the keeper as kind drill; the version it installs fails on purpose as the flag names, through the drill mark the link
// writes once the keeper accepts. With no flag nothing changes: kind ship, and a healthy start.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFor, makeToken } from "../rootfs/opt/cain/ship-token";
import { keyFingerprint, passId, registerInstalls, settle, type PassDeps } from "../rootfs/opt/cain/link/ship-pass";
import { armFlag, DRILL_TTL_S, drillDeps, drillModeFor, fileStore, makeDrillFlag, MARK_TTL_MS, parseMark, readDrillFlag, type DrillStore } from "../rootfs/opt/cain/link/drill";
import { DRILL_LABEL } from "../rootfs/opt/cain/link/core";
import { CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth";
import { verdictRun } from "../rootfs/opt/cain/probe/keeper";
import { rig, SHIP_KEYS, SHIP_PUB, DM, OWNER, BOT } from "./link-rig";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const signer = (d: Buffer) => edSign(null, d, SHIP_KEYS.privateKey);
const TOKEN = makeToken(claimFor(PR, SHA, NOW)!, signer);
const FPR = keyFingerprint(SHIP_PUB);
const T = (ms: number) => new Date(ms).toISOString();
const ENROLLED = { key_fp: FPR, key_confirmed_at: T(NOW - 3_600_000), state_created: T(NOW - 7_200_000), enroll_id: "0123456789abcdef", counter: 10 };
const { privateKey: OTHER } = generateKeyPairSync("ed25519");

// A drill store in memory (root's two files on the Pi: fileStore)
function mem(o: { flag?: string | null; removeFails?: boolean; markFails?: boolean } = {}) {
  const s = { flag: o.flag ?? null as string | null, mark: null as string | null };
  const store: DrillStore = {
    loadFlag: () => s.flag, removeFlag: () => { if (o.removeFails) throw new Error("EROFS"); s.flag = null; }, storeFlag: (t) => { s.flag = t; },
    loadMark: () => s.mark, storeMark: (t) => { if (o.markFails) throw new Error("ENOSPC"); s.mark = t; }, removeMark: () => { s.mark = null; },
  };
  return { s, store };
}

describe("the registration spends the flag (ship-pass.ts registerInstalls)", () => {
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const files: Record<string, any> = {
    [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.0"\n'),
    [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"),
    [`cain/SHIP_KEY_FINGERPRINT@${SHA}`]: b64(`${FPR}\n`),
  };
  const api = async (path: string) => {
    if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
    const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    const f = m ? files[`${m[1]}@${m[2]}`] : null;
    return f ? { status: 200, body: f } : { status: 404, body: null };
  };
  // A keeper that answers each registration with the attempt id its kind makes, then accepts it
  function keeper(store: DrillStore) {
    let now = NOW; const posted: any[] = []; let enrolled: any = null; const logs: string[] = [];
    const idOf = (b: any) => `${b.kind}-46-cain-${SHA.slice(0, 8)}`;
    let last: any = null;
    const deps = { api, log: (l: string) => logs.push(l), now: () => now, sleep: async (ms: number) => { now += ms; }, linkFp: FPR,
      enrollment: { load: () => enrolled, store: (e: any) => { enrolled = e; } },
      drill: drillDeps(store, () => SHIP_PUB, () => now, (l) => logs.push(l)),
      post: async (b: any) => { posted.push(b); last = b; return { status: 202, body: { status: "pending", id: idOf(b) } }; },
      get: async () => ({ status: 200, body: { status: "accepted", id: idOf(last), app: "0fcc2575_cain", from_version: "0.18.0", to_version: "0.19.0", backup: "kb1", until: "x", ...ENROLLED } }) };
    return { deps, posted, logs };
  }
  const c = claimFor(PR, SHA, NOW)!;

  test("with no flag the registration is kind ship, and no mark is written", async () => {
    const m = mem(); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["ship"]);
    expect(m.s.mark).toBeNull();
  });
  test("kind drill is sent only while the flag is set, and the flag is spent by that one registration", async () => {
    const m = mem({ flag: makeDrillFlag("exit-on-start", NOW, signer) }); const k = keeper(m.store);
    const r = await registerInstalls(k.deps, TOKEN, c);
    expect(r.ok).toBe(true);
    expect(k.posted.map((b) => b.kind)).toEqual(["drill"]);
    expect((r as any).accepted[0].attempt).toBe(`drill-46-cain-${SHA.slice(0, 8)}`);
    expect(m.s.flag).toBeNull();                                   // spent
    expect(k.logs.some((l) => l.includes("the owner's drill flag (exit-on-start) is spent by this registration"))).toBe(true);
    // the next registration, with the flag spent: kind ship again
    await registerInstalls(k.deps, TOKEN, c);
    expect(k.posted.map((b) => b.kind)).toEqual(["drill", "ship"]);
  });
  test("the flag is refused without a valid tap signature: removed, never counted, and the registration is kind ship", async () => {
    const forged = [
      makeDrillFlag("exit-on-start", NOW, (d) => edSign(null, d, OTHER)),           // another key (anything Cain could make)
      '{"mode": "exit-on-start"}',                                                  // a plain note
      makeDrillFlag("verdict-fail", NOW - (DRILL_TTL_S + 60) * 1000, signer),         // ran out
    ];
    for (const flag of forged) {
      const m = mem({ flag }); const k = keeper(m.store);
      await registerInstalls(k.deps, TOKEN, c);
      expect(k.posted.map((b) => b.kind)).toEqual(["ship"]);
      expect(m.s.flag).toBeNull();
      expect(m.s.mark).toBeNull();
      expect(k.logs.some((l) => l.startsWith("a drill flag was refused and removed"))).toBe(true);
    }
    expect(readDrillFlag(forged[0], SHIP_PUB, NOW)).toEqual({ ok: false, why: "its signature isn't the link's: no tap of the owner's set it" });
    expect(readDrillFlag(makeDrillFlag("verdict-fail", NOW, signer), null, NOW).ok).toBe(false);
    // a payload swapped under a good signature
    const good = makeDrillFlag("exit-on-start", NOW, signer).split(".");
    const swapped = Buffer.from(Buffer.from(good[1], "base64url").toString().replace("exit-on-start", "verdict-fail")).toString("base64url");
    expect(readDrillFlag(`${good[0]}.${swapped}.${good[2]}`, SHIP_PUB, NOW).ok).toBe(false);
  });
  test("the failure mode matches the flag: the mark names the mode, the drilled attempt and version", async () => {
    for (const mode of ["exit-on-start", "verdict-fail"] as const) {
      const m = mem({ flag: makeDrillFlag(mode, NOW, signer) }); const k = keeper(m.store);
      await registerInstalls(k.deps, TOKEN, c);
      const mark = parseMark(m.s.mark, NOW)!;
      expect(mark).toMatchObject({ v: 1, mode, attempt: `drill-46-cain-${SHA.slice(0, 8)}`, to_version: "0.19.0", head: SHA });
      expect(drillModeFor(m.s.mark, "0.19.0", NOW)).toBe(mode);
      expect(drillModeFor(m.s.mark, "0.18.0", NOW)).toBeNull();        // the version a rollback restores starts as usual
      expect(drillModeFor(m.s.mark, "0.19.0", NOW, "drill-46-cain-ffffffff")).toBeNull();
      expect(drillModeFor(m.s.mark, "0.19.0", mark.at + MARK_TTL_MS + 1)).toBeNull();   // it lapses
    }
  });
  test("a flag that can't be spent, or a mark that can't be written, installs nothing", async () => {
    const a = mem({ flag: makeDrillFlag("exit-on-start", NOW, signer), removeFails: true }); const ka = keeper(a.store);
    const ra = await registerInstalls(ka.deps, TOKEN, c);
    expect(ra.ok).toBe(false);
    expect(ka.posted).toEqual([]);
    const b = mem({ flag: makeDrillFlag("verdict-fail", NOW, signer), markFails: true }); const kb = keeper(b.store);
    const rb = await registerInstalls(kb.deps, TOKEN, c);
    expect(rb.ok).toBe(false);
    expect((rb as any).said.join(" ")).toContain("wouldn't fail as the drill needs: not installed");
  });
  test("a new registration removes an earlier mark; a cancelled drill attempt's mark is dropped", async () => {
    const m = mem({ flag: makeDrillFlag("exit-on-start", NOW, signer) }); const k = keeper(m.store);
    await registerInstalls(k.deps, TOKEN, c);
    expect(m.s.mark).not.toBeNull();
    await registerInstalls(k.deps, TOKEN, c);                           // no flag now: kind ship
    expect(m.s.mark).toBeNull();
    const m2 = mem({ flag: makeDrillFlag("exit-on-start", NOW, signer) }); const k2 = keeper(m2.store);
    await registerInstalls(k2.deps, TOKEN, c);
    const ID = `drill-46-cain-${SHA.slice(0, 8)}`;
    k2.deps.drill.drop("drill-46-cain-ffffffff");                       // another attempt's: kept
    expect(m2.s.mark).not.toBeNull();
    // the pass refused after the drill was accepted: its cancel drops the mark (ship-pass.ts cancelAll)
    let file = JSON.stringify({ format: 2, spent: [{ id: passId(TOKEN), exp: Math.floor(NOW / 1000) + 3600, state: "registering", at: NOW, attempts: [ID] }] });
    const dropped: string[] = [];
    const d: PassDeps = { pub: () => SHIP_PUB, now: () => NOW, load: () => file, store: (t) => { file = t; }, register: () => {}, log: () => {},
      cancel: () => undefined, dropMark: (a) => { dropped.push(a); k2.deps.drill.drop(a); } };
    settle(d, passId(TOKEN), { ok: false, said: ["the keeper refused Harness"] });
    expect(dropped).toEqual([ID]);
    expect(m2.s.mark).toBeNull();
  });
});

describe("the drill card and his tap (core.ts drillCard, drillTap)", () => {
  test("Cain's request posts one card with one button and sets nothing; only the owner's tap sets the flag", async () => {
    const r = rig();
    const dir = mkdtempSync(join(tmpdir(), "drill-"));
    const store = fileStore(join(dir, "keeper-drill.json"), join(dir, "keeper-drill-mark.json"));
    (r.link as any).d.armDrill = (mode: any) => armFlag(store, mode, Date.now(), signer);
    const out = await r.link.drillCard("verdict-fail");
    expect(out.status).toBe("posted");
    expect(r.buttons(out.message!)).toEqual([DRILL_LABEL]);
    expect(r.ids(out.message!)).toEqual(["k:drill:verdict-fail"]);
    expect(r.msg(out.message!).content).toContain("reports a failed check after it starts");
    expect(existsSync(join(dir, "keeper-drill.json"))).toBe(false);      // Cain's request alone sets nothing
    expect((await r.link.drillCard("verdict-fail")).status).toBe("open");
    expect(r.posts()).toBe(1);
    // another user's tap: refused before anything is signed
    const msg = r.msg(out.message!);
    const it = (user: string) => ({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: user }, data: { custom_id: "k:drill:verdict-fail" }, message: msg });
    expect(await (r.link as any).drillTap(it("7777"), out.message!)).toBe("refused: not the owner");
    expect(existsSync(join(dir, "keeper-drill.json"))).toBe(false);
    expect(await (r.link as any).drillTap(it(OWNER), out.message!)).toBe("drill armed");
    const flag = readFileSync(join(dir, "keeper-drill.json"), "utf8");
    expect(readDrillFlag(flag, SHIP_PUB, Date.now())).toMatchObject({ ok: true, mode: "verdict-fail" });
    expect(r.state().messages[out.message!].outcome).toBe("answered");
    expect(r.relayed.some((l: string) => l.includes(`Dane tapped ${DRILL_LABEL} (verdict-fail)`))).toBe(true);
    // a new card can go out once that one was answered (each drill needs its own tap)
    expect((await r.link.drillCard("verdict-fail")).status).toBe("posted");
  });
  test("no card while stopped, and no mode but the two", async () => {
    const s = rig(); s.stop.stopped = true;
    expect((await s.link.drillCard("exit-on-start")).status).toBe("stopped");
    expect(s.posts()).toBe(0);
    await expect(rig().link.drillCard("rollback-anyway")).rejects.toThrow("a drill takes exit-on-start or verdict-fail");
  });
  test("/drill-arm is Cain's route, and only his; keeper.sh drill-arm reaches it", () => {
    expect(CAIN_ROUTES.has("/drill-arm")).toBe(true);
    expect(routeAllowed("cain", "/drill-arm")).toBe(true);
    expect(routeAllowed("specialist", "/drill-arm")).toBe(false);
    expect(routeAllowed("root", "/drill-arm")).toBe(false);
    const sh = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/keeper.sh"), "utf8");
    expect(sh).toContain("review-grant|drill-arm) url=\"$link/$cmd\"");
    expect(sh).toContain("exit-on-start|verdict-fail) ;;");
  });
  test("only main.ts signs a flag, inside the tap's dependency", () => {
    const main = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main.match(/armFlag\(/g)?.length).toBe(1);
    expect(main).toContain("armDrill: shipPriv ? (mode) => armFlag(drillStore, mode, Date.now(), (data) => edSign(null, data, shipPriv)) : undefined,");
    const core = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).not.toContain("makeDrillFlag(");
    expect(core).not.toContain("armFlag(");
  });
});

describe("the drilled version fails as the flag names (run time)", () => {
  const ID = `drill-46-cain-${SHA.slice(0, 8)}`;
  const mark = (mode: string) => JSON.stringify({ v: 1, mode, attempt: ID, to_version: "0.19.0", head: SHA, at: Date.now() });
  function probe(drill: string | null) {
    const posted: any[] = []; let asked = 0;
    const d = { version: "0.19.0", log: () => {}, get: async () => ({ status: 200, body: { attempt: ID, to_version: "0.19.0" } }),
      post: async (_p: string, b: any) => { posted.push(b); return { status: 200, body: {} }; }, ask: async () => { asked++; return true; },
      drill: (a: string) => drillModeFor(drill, "0.19.0", Date.now(), a) };
    return { d, posted, get asked() { return asked; } };
  }
  test("verdict-fail: the probe reports FAIL for that attempt without asking; with no mark, or exit-on-start, it asks as usual", async () => {
    const p = probe(mark("verdict-fail"));
    expect(await verdictRun(p.d)).toBe("FAIL");
    expect(p.asked).toBe(0);
    expect(p.posted[0]).toMatchObject({ attempt: ID, version: "0.19.0", result: "FAIL" });
    expect(p.posted[0].reason).toContain("a Keeper drill");
    for (const m of [null, mark("exit-on-start")]) {
      const q = probe(m);
      expect(await verdictRun(q.d)).toBe("PASS");
      expect(q.asked).toBe(1);
    }
  });
  test("exit-on-start: drill.ts mode prints the mode only for the version the mark names (the run script exits on it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drill-"));
    const f = join(dir, "mark.json");
    writeFileSync(f, mark("exit-on-start"));
    const run = (v: string) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "rootfs/opt/cain/link/drill.ts"), "mode", v], { env: { ...process.env, CAIN_DRILL_MARK: f } });
    expect(run("0.19.0").stdout.toString()).toBe("exit-on-start\n");
    expect(run("0.18.0").stdout.toString()).toBe("");
    expect(run("0.18.0").exitCode).toBe(0);
    const sh = readFileSync(join(import.meta.dir, "..", "rootfs/etc/services.d/cain/run"), "utf8");
    expect(sh).toContain('if [ "$drill_mode" = exit-on-start ]; then');
  });
});
