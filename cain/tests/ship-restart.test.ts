// Cain 0.19.4: a Cain install whose own backup restarts the App still installs. Cain's backup is cold, so the Keeper's backup of
// him (made after the link registered the install) stops and starts this App, and the link with it. Until 0.19.4 the link's
// reconcile at start refused the pass it found "left registering by a restart" and cancelled the registration, so no install of
// Cain through the Keeper could ever finish (seen Nov 27 on pull request 72). Now the pass is resumed from what it kept on disk.
import { describe, expect, test } from "bun:test";
import { sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimFor, makeToken, type Claim } from "../rootfs/opt/cain/ship-token";
import { keyFingerprint, passId, reconcilePasses, registerInstalls, RESUME_MAX, shipPass, type PassDeps } from "../rootfs/opt/cain/link/ship-pass";
import { SHIP_KEYS, SHIP_PUB } from "./link-rig";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const sign = (claim: Claim) => makeToken(claim, (d) => edSign(null, d, SHIP_KEYS.privateKey));
const TOKEN = sign(claimFor(PR, SHA, NOW)!);
const FPR = keyFingerprint(SHIP_PUB);
const T = (ms: number) => new Date(ms).toISOString();
const ATT = `ship-46-cain-${SHA.slice(0, 8)}`;
const ENROLLED = { key_fp: FPR, key_confirmed_at: T(NOW - 3_600_000), state_created: T(NOW - 7_200_000), enroll_id: "0123456789abcdef", counter: 10 };
const ROOT = join(import.meta.dir, "..");

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
const accepted = (over: any = {}) => ({ status: 200, body: { status: "accepted", id: ATT, app: "0fcc2575_cain", from_version: "0.19.3", to_version: "0.19.4", kind: "ship",
  backup: "064d4fd1", until: T(NOW + 1_800_000), install_job: null, ...ENROLLED, ...over } });
const claimed = { status: 200, body: { status: "claimed", id: ATT, app: "0fcc2575_cain", from_version: "0.19.3", to_version: "0.19.4", backup: "064d4fd1",
  claim: "claim-0123456789abcdef", until: T(NOW + 1_800_000), ...ENROLLED } };

// The Keeper, one for the whole test (it isn't restarted: only Cain's App is), and the pass file on disk (root's /data/trust)
function world() {
  let file: string | null = null;
  let now = NOW;
  const keeper = { views: [] as any[], cancels: [] as string[], claims: 0, posts: 0 };
  let enrolled: any = null;
  // One run of the link. Its registration's poll dies with the process: here, the GET that would see the acceptance never answers.
  const linkRun = (o: { view?: () => any } = {}) => {
    const logs: string[] = [], relayed: string[] = [];
    const d: PassDeps = {
      pub: () => SHIP_PUB, now: () => now, load: () => file, store: (t) => { file = t; }, log: (l) => logs.push(l),
      register: (tok, c, done, note) => {
        void registerInstalls({ api, log: (l) => logs.push(l), note, linkFp: FPR, now: () => now, sleep: async () => {}, enrollment: { load: () => enrolled, store: (e) => { enrolled = e; } },
          post: async () => { keeper.posts++; return { status: 202, body: { status: "pending", id: ATT } }; },
          get: () => new Promise(() => {}) }, tok, c).then(done);   // the backup stops the App: this poll never comes back
      },
      claim: async () => { keeper.claims++; return claimed; },
      cancel: async (a) => { keeper.cancels.push(a); return { status: 200, body: { status: "ended", id: a } }; },
      view: async () => { const v = o.view ? o.view() : accepted(); keeper.views.push(v.body.status); return v; },
      enrollment: { load: () => enrolled, store: (e) => { enrolled = e; } },
      sign, relay: (l) => relayed.push(l), sleep: async (ms) => { now += ms; }, pollMs: 5_000,
    };
    return { d, logs, relayed };
  };
  return { linkRun, keeper, get file() { return file; }, set file(t: string | null) { file = t; }, advance: (ms: number) => { now += ms; } };
}
const settleTicks = () => new Promise((r) => setTimeout(r, 10));
const passOf = (file: string | null) => JSON.parse(file!).spent.find((x: any) => x.id === passId(TOKEN));

describe("Cain 0.19.4: the Keeper's backup restarts Cain between the registration and the Ship run", () => {
  test("the restarted link resumes the pass, tells Cain to start the same run again, and that run claims and starts: the install happens", async () => {
    const w = world();
    const before = w.linkRun();
    expect((await shipPass(before.d, { token: TOKEN })).status).toBe("pending");
    await settleTicks();
    // what the pass kept before the App stopped: the token's claim (never the token), the fingerprint, the attempt's App and versions
    const kept = passOf(w.file);
    expect(kept).toMatchObject({ state: "registering", apps: 1, attempts: [ATT], fp: FPR, claim: { repo: "HyndeSyte/harness", pr: 46, head: SHA },
      expect: [{ attempt: ATT, app: "0fcc2575_cain", from: "0.19.3", to: "0.19.4" }] });
    expect(w.file).not.toContain(TOKEN);
    // the cold backup: Cain's App stops for about two minutes, and starts again. The Keeper is still checking its backup, then accepts.
    w.advance(120_000);
    let reads = 0;
    const after = w.linkRun({ view: () => (++reads < 3 ? { status: 200, body: { ...accepted().body, status: "pending" } } : accepted()) });
    expect(await reconcilePasses(after.d)).toBe(0);
    expect(w.keeper.cancels).toEqual([]);
    expect(w.keeper.views).toEqual(["pending", "pending", "accepted"]);
    expect(passOf(w.file)).toMatchObject({ state: "accepted", resumes: 1, accepted: [{ attempt: ATT, backup: "064d4fd1", from: "0.19.3", to: "0.19.4" }] });
    expect(after.logs.some((l) => l.includes("resumed a pass left registering by a restart"))).toBe(true);
    // Cain's session started again too: the line gives him the run's text with the same token
    expect(after.relayed).toHaveLength(1);
    expect(after.relayed[0]).toContain(`Start the same Ship run again now, its text: "Install pull request ${PR}, landed in main at ${SHA}. Ship token: ${TOKEN}."`);
    // the hook's next ask: claimed and passed, with the ok line the Ship run reads
    const ans = await shipPass(after.d, { token: TOKEN });
    expect(ans).toMatchObject({ status: "ok", pr: 46, head: SHA, claims: [{ attempt: ATT, claim: "claim-0123456789abcdef" }] });
    expect(w.keeper.claims).toBe(1);
    expect(w.keeper.posts).toBe(1);   // registered once, never again
    expect(after.logs.some((l) => l.startsWith(`Ship pass ok: ${ATT} claim claim-0123456789abcdef until`))).toBe(true);
    // and one tap is still one run
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("spent");
  });

  test("while the resumed poll waits, the hook's ask is pending, counted from the restart, not refused on the old wait", async () => {
    const w = world();
    await shipPass(w.linkRun().d, { token: TOKEN });
    await settleTicks();
    w.advance(5 * 60_000);   // the old wait (6 minutes from the registration) is nearly gone
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const after = w.linkRun();
    after.d.view = async () => { await gate; return accepted(); };
    const rec = reconcilePasses(after.d);
    await settleTicks();
    w.advance(2 * 60_000);
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("pending");
    release();
    await rec;
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("ok");
  });

  test("a resumed pass the Keeper no longer has as accepted and unclaimed is refused and cancelled, and Cain hears nothing was installed", async () => {
    const w = world();
    await shipPass(w.linkRun().d, { token: TOKEN });
    await settleTicks();
    const after = w.linkRun({ view: () => ({ status: 200, body: { ...accepted().body, status: "aborted", why: "its acceptance expired unclaimed" } }) });
    await reconcilePasses(after.d);
    expect(passOf(w.file).state).toBe("refused");
    expect(w.keeper.cancels).toEqual([ATT]);
    expect(after.relayed[0]).toContain("that install can't go on");
    expect(after.relayed[0]).toContain("Nothing was installed");
    expect((await shipPass(after.d, { token: TOKEN })).status).toBe("refused");
    expect(w.keeper.claims).toBe(0);
  });

  test("an acceptance for other versions, or another App, isn't taken", async () => {
    for (const over of [{ to_version: "0.19.5" }, { app: "0fcc2575_harness" }, { kind: "drill" }, { backup: "../x" }]) {
      const w = world();
      await shipPass(w.linkRun().d, { token: TOKEN });
      await settleTicks();
      const after = w.linkRun({ view: () => accepted(over) });
      await reconcilePasses(after.d);
      expect(passOf(w.file).state).toBe("refused");
      expect(w.keeper.cancels).toEqual([ATT]);
    }
  });

  test("a Keeper that stays pending past one App's wait from the restart refuses the pass", async () => {
    const w = world();
    await shipPass(w.linkRun().d, { token: TOKEN });
    await settleTicks();
    const after = w.linkRun({ view: () => ({ status: 200, body: { ...accepted().body, status: "pending" } }) });
    await reconcilePasses(after.d);
    expect(passOf(w.file)).toMatchObject({ state: "refused", said: expect.stringContaining("within 5 minutes of the restart") });
    expect(w.keeper.cancels).toEqual([ATT]);
  });

  test("what is never resumed: a pass left claiming, a drill, one from before 0.19.4, one resumed too often, one whose token is nearly spent", async () => {
    const exp = Math.floor(NOW / 1000) + 3600;
    const id = passId(TOKEN);
    const c = { repo: "HyndeSyte/harness", pr: 46, head: SHA, exp: claimFor(PR, SHA, NOW)!.exp };
    const ex = [{ attempt: ATT, app: "0fcc2575_cain", from: "0.19.3", to: "0.19.4" }];
    const cases: [string, any][] = [
      ["claiming", { id, exp, state: "claiming", at: NOW, claimingAt: NOW, apps: 1, attempts: [ATT], fp: FPR, claim: c, expect: ex, accepted: [{ app: "0fcc2575_cain", attempt: ATT, backup: "kb1" }] }],
      ["drill", { id, exp, state: "registering", at: NOW, apps: 1, attempts: ["drill-46-cain-01234567"], fp: FPR, claim: c, expect: [{ ...ex[0], attempt: "drill-46-cain-01234567" }] }],
      ["before 0.19.4", { id, exp, state: "registering", at: NOW, apps: 1, attempts: [ATT] }],
      ["resumed too often", { id, exp, state: "registering", at: NOW, apps: 1, attempts: [ATT], fp: FPR, claim: c, expect: ex, resumes: RESUME_MAX }],
      ["not every App registered", { id, exp, state: "registering", at: NOW, apps: 2, attempts: [ATT], fp: FPR, claim: c, expect: ex }],
      ["another token", { id: "f".repeat(32), exp, state: "registering", at: NOW, apps: 1, attempts: [ATT], fp: FPR, claim: c, expect: ex }],
      ["token nearly spent", { id: passId(sign({ v: 1, kind: "ship", ...c, exp: Math.floor(NOW / 1000) + 600 })), exp, state: "registering", at: NOW, apps: 1, attempts: [ATT], fp: FPR,
        claim: { ...c, exp: Math.floor(NOW / 1000) + 600 }, expect: ex }],
    ];
    for (const [name, entry] of cases) {
      const w = world();
      w.file = JSON.stringify({ format: 2, spent: [entry] });
      const after = w.linkRun();
      expect(await reconcilePasses(after.d), name).toBe(1);
      expect(JSON.parse(w.file!).spent[0].state, name).toBe("refused");
      expect(w.keeper.cancels.length, name).toBeGreaterThan(0);
      expect(w.keeper.views, name).toEqual([]);
    }
  });

  test("the link's start hands the resume its signer and Cain's queue, and Cain's rules say what the line means", () => {
    const main = readFileSync(join(ROOT, "rootfs/opt/cain/link/main.ts"), "utf8");
    const deps = main.slice(main.indexOf("const shipPassDeps: PassDeps"), main.indexOf("void reconcilePasses(shipPassDeps)"));
    expect(deps).toContain("sign: shipPriv ? (claim) => makeToken(claim");
    expect(deps).toContain("relay: (text) => appendSynced(QUEUE");
    expect(readFileSync(join(ROOT, "rootfs/opt/cain/CLAUDE.md"), "utf8")).toContain("has accepted that install since");
    expect(readFileSync(join(ROOT, "config.yaml"), "utf8")).toMatch(/^backup: cold$/m);   // the choice: Cain's backup stays cold
  });
});
