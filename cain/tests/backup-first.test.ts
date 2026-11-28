// Cain 0.19.4 with Keeper 0.1.19: backup first. His Ship tap for an install of Cain records only the tap, with a fresh nonce and
// request id, and asks the Keeper to back Cain up (a cold backup: it stops and starts Cain and his link). The token goes out only on
// the Keeper's word for that request (GET: ready, verified, unconsumed), after a crash-safe consume; Cain's registration carries the
// same nonce and main, and the Keeper uses that backup only for it, once.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FirstDeps, type FirstStatus, type FirstTap, fileFirstStore, judgeAsk, judgeStatus, TAP_WINDOW_MS, usedFor } from "../rootfs/opt/cain/link/backup-first";
import { FIRST_MISSING, FIRST_UNREAD } from "../rootfs/opt/cain/link/core";
import { registerInstalls } from "../rootfs/opt/cain/link/ship-pass";
import { claimFor, findToken, publicKey, readToken } from "../rootfs/opt/cain/ship-token";
import { FIRST_OLD_LINK_WHY, Keeper, keyFp } from "../../keeper/rootfs/opt/keeper/core.ts";
import { MIN, PR, rig, SHA1, SHA2, SHIP_PUB } from "./link-rig";

const snap = (m: any) => JSON.parse(JSON.stringify(m));
const KEY = publicKey(SHIP_PUB);
const CAIN = "0fcc2575_cain";
const MAIN = "c".repeat(40);

// The recorded tap, its used list and the restore mark as files (the link's own store), and the Keeper and GitHub as the test sets
// them. ops records every store write and folder sync in order; crash makes the next tap-file removal throw (a crash right there).
function firstDeps(o: { cain?: string | false | null; head?: string | null; main?: { sha: string; version: string } | null; advertised?: boolean | null;
    ask?: (body: any) => Promise<{ status: number; body: any } | null>; status?: (request: string) => FirstStatus | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backup-first-"));
  const asked: any[] = [], ops: string[] = [];
  const st = { crash: false, status: o.status, main: o.main === undefined ? { sha: MAIN, version: "0.19.4" } : o.main, head: o.head === undefined ? SHA1 : o.head };
  const files = { tap: join(dir, "backup-first.json"), used: join(dir, "backup-first-used.json"), mark: join(dir, "backup-first-mark.json") };
  const name = (p: string) => p === files.tap ? "tap" : p === files.used ? "used" : "mark";
  const inner = fileFirstStore(files.tap, files.used, files.mark, (p, t) => { writeFileSync(p, t); ops.push(`write ${name(p)}`); ops.push(`sync ${name(p)}`); }, () => ops.push("sync folder"));
  let n = 0;
  const fd: FirstDeps = {
    store: { ...inner, drop: () => { if (st.crash) { st.crash = false; throw new Error("crashed"); } inner.drop(); ops.push("drop tap"); } },
    booted: 0,
    installsCain: async () => (o.cain === undefined ? "0.19.4" : o.cain),
    mainNow: async () => st.main,
    ask: async (_ship, tap) => { const body = { app: CAIN, pr: 5, head: tap.head, request: tap.request, nonce: tap.nonce, main: tap.main, to_version: tap.version }; asked.push(body);
      return judgeAsk(o.ask ? await o.ask(body) : { status: 202, body: { status: "pending" } }); },
    status: async (request) => (st.status ? st.status(request) : { status: "ready", verified: true, request }),
    head: async () => st.head,
    advertised: async () => (o.advertised === undefined ? true : o.advertised),
    random: (bytes) => (++n).toString(16).padStart(bytes * 2, "a"),
  };
  return { fd, dir, asked, ops, st, files, tap: () => JSON.parse(readFileSync(files.tap, "utf8")) as FirstTap };
}
async function tapShip(r: ReturnType<typeof rig>) {
  const id = ((await r.link.ship({ text: "Cain 0.19.4 ready.", item: "P41", pr: PR, head: SHA1 })) as any).message as string;
  await r.tap(snap(r.msg(id)), r.ids(id)[0]);
  return id;
}
// The Keeper's backup stopped and started Cain: a new link process, then its sweep at start.
async function restart(r: ReturnType<typeof rig>, fd: { booted: number }, after = 2 * MIN) {
  r.t.now += after;
  fd.booted = r.t.now;
  r.restart();
  await r.link.sweep();
}
const tokens = (r: ReturnType<typeof rig>) => r.relayed.filter((l) => findToken(l));

describe("backup first: Cain's Ship tap at the link", () => {
  test("item 3: the tap gets a fresh nonce and request id, kept with what installs before the Keeper is asked; the token waits for the Keeper's word", async () => {
    const f = firstDeps({ status: () => ({ status: "making" }) });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(r.github.main).toEqual([SHA1]);
    expect(findToken(r.relayed[0])).toBeNull();
    expect(r.relayed[0]).toContain("the Keeper backs Cain up first");
    const tap = f.tap();
    expect(tap).toMatchObject({ v: 2, pr: PR, head: SHA1, msg: id, at: r.t.now, main: MAIN, version: "0.19.4" });
    expect(tap.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(tap.request).toMatch(/^[0-9a-f]{16}$/);
    expect(f.asked).toEqual([{ app: CAIN, pr: 5, head: SHA1, request: tap.request, nonce: tap.nonce, main: MAIN, to_version: "0.19.4" }]);
    expect(f.ops.slice(0, 4)).toEqual(["write mark", "sync mark", "write tap", "sync tap"]);   // on disk before POST
    expect(r.msg(id).content).toContain("Before installing, the Keeper backs Cain up");
    await r.link.sweep();
    expect(tokens(r)).toEqual([]);
  });
  test("item 2: the token only on the Keeper's GET for this request, ready and verified: once, bound to the used nonce", async () => {
    let state: FirstStatus["status"] = "making";
    const f = firstDeps({ status: (request) => ({ status: state, verified: state === "ready", request }), ask: async () => ({ status: 200, body: { status: "ready" } }) });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    await r.link.sweep();
    expect(tokens(r)).toEqual([]);                            // POST answered ready, but GET says making: nothing
    state = "ready";
    await restart(r, f.fd);
    const token = findToken(r.relayed[1])!;
    expect(token).toBeTruthy();
    const read = readToken(token, KEY, r.t.now);
    expect(read).toEqual({ ok: true, claim: claimFor(PR, SHA1, r.t.now) });
    expect(r.msg(id).content).toContain("Cain is backed up as of");
    expect(f.fd.store.load()).toBeNull();
    const nonce = f.asked[0].nonce;
    expect(usedFor(f.fd.store.used(), (read as any).claim)).toMatchObject({ nonce, main: MAIN, version: "0.19.4" });   // what the registration sends
    await r.link.sweep();
    expect(tokens(r)).toHaveLength(1);
  });
  test("item 2: ready but not verified, another request, failed, unknown or consumed: the tap is discarded with one line", async () => {
    for (const [st, said] of [[{ status: "ready", request: "x" }, "isn't verified for this tap"], [{ status: "failed", why: "500 busy" }, "500 busy"],
        [{ status: "unknown" }, "is unknown"], [{ status: "consumed" }, "is consumed"]] as const) {
      const f = firstDeps({ status: () => st as any });
      const r = rig({ first: f.fd });
      const id = await tapShip(r);
      await r.link.sweep();
      expect([said, r.relayed.length]).toEqual([said, 2]);
      expect(r.relayed[1]).toContain(said);
      expect(r.relayed[1]).toContain("gets no Ship token");
      expect(r.msg(id).content).toContain("Installing it needs a new Ship tap.");
      expect(f.fd.store.load()).toBeNull();
      expect(tokens(r)).toEqual([]);
    }
  });
  test("item 2 and 10: a link restart for an unrelated reason while the backup is pending keeps waiting; the Keeper not answering waits too; then the token", async () => {
    let state: FirstStatus | null = { status: "making" };
    const f = firstDeps({ status: (request) => (state ? { ...state, request } : null) });
    const r = rig({ first: f.fd });
    await tapShip(r);
    await restart(r, f.fd, MIN);                              // restarted, not by the backup: still making
    expect(tokens(r)).toEqual([]);
    expect(f.fd.store.load()).not.toBeNull();
    state = null;                                              // the Keeper doesn't answer
    await restart(r, f.fd, MIN);
    expect(tokens(r)).toEqual([]);
    expect(f.fd.store.load()).not.toBeNull();
    state = { status: "ready", verified: true };
    await r.link.sweep();
    expect(tokens(r)).toHaveLength(1);
  });
  test("item 8: pending past the window: discarded, one line, and the card asks for a new tap", async () => {
    const f = firstDeps({ status: () => ({ status: "making" }) });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    await restart(r, f.fd, TAP_WINDOW_MS + MIN);
    expect(r.relayed).toHaveLength(2);
    expect(r.relayed[1]).toContain(`over ${TAP_WINDOW_MS / MIN} minutes old`);
    expect(r.msg(id).content).toContain("Installing it needs a new Ship tap.");
    expect(f.fd.store.load()).toBeNull();
  });
  test("item 4 and 10: the consume writes the used nonce (file and folder synced) before the tap file goes (folder synced), before the token", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    f.ops.length = 0;
    await restart(r, f.fd);
    expect(f.ops).toEqual(["write used", "sync used", "sync folder", "drop tap"]);   // the drop syncs the folder before it counts
    expect(tokens(r)).toHaveLength(1);
    // the drop itself syncs the folder (fileFirstStore)
    const g = firstDeps();
    g.fd.store.store({ v: 2, pr: PR, head: SHA1, msg: "m", at: 1, nonce: "f".repeat(32), request: "e".repeat(16), main: MAIN, version: "0.19.4" });
    g.ops.length = 0;
    fileFirstStore(g.files.tap, g.files.used, g.files.mark, () => {}, () => g.ops.push("sync folder")).drop();
    expect(g.ops).toEqual(["sync folder"]);
  });
  test("item 4 and 10: a crash between the used-list write and the token: the re-read finds the nonce used, and no token ever goes", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    f.st.crash = true;                                         // the tap file's removal fails, as a crash right after the used write
    await restart(r, f.fd);
    expect(tokens(r)).toEqual([]);
    expect(f.fd.store.used()!.map((u) => u.nonce)).toEqual([f.asked[0].nonce]);
    await restart(r, f.fd, MIN);                               // the restarted link reads the tap again
    expect(tokens(r)).toEqual([]);
    expect(r.relayed.at(-1)).toContain("that recorded tap was used before");
    expect(f.fd.store.load()).toBeNull();
  });
  test("item 3 and 10: two taps for one head: each gets a new nonce and request; only the newest is kept and gets the token", async () => {
    const f = firstDeps({ status: (request) => ({ status: "ready", verified: true, request }) });
    const r = rig({ first: f.fd });
    // the first tap's backup is still making when the second tap comes
    f.st.status = () => ({ status: "making" });
    await tapShip(r);
    const second = ((await r.link.ship({ text: "Cain 0.19.4 ready.", item: "P41", pr: PR, head: SHA1 })) as any).message as string;
    await r.tap(snap(r.msg(second)), r.ids(second)[0]);
    expect(f.asked).toHaveLength(2);
    expect(f.asked[1].nonce).not.toBe(f.asked[0].nonce);
    expect(f.asked[1].request).not.toBe(f.asked[0].request);
    expect(f.tap().nonce).toBe(f.asked[1].nonce);
    f.st.status = (request) => ({ status: "ready", verified: true, request });
    await restart(r, f.fd);
    expect(tokens(r)).toHaveLength(1);
    expect(f.fd.store.used()!.map((u) => u.nonce)).toEqual([f.asked[1].nonce]);
  });
  test("item 3: a Stop since the tap ends it, and the next tap gets a new nonce", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    r.stop.stopped = true; r.stop.at = r.t.now + 1;
    await restart(r, f.fd);
    expect(tokens(r)).toEqual([]);
    expect(r.relayed.at(-1)).toContain("he tapped Stop since");
    expect(f.fd.store.used()!.map((u) => u.nonce)).toEqual([f.asked[0].nonce]);   // that nonce never counts again
  });
  test("item 5 and 10: a restore between the tap and the registration: the mark from before the tap, or the Keeper's restore time, discards it", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    writeFileSync(f.files.mark, JSON.stringify({ nonce: "0".repeat(32) }));   // a restore of a backup taken before the tap
    await restart(r, f.fd);
    expect(tokens(r)).toEqual([]);
    expect(r.relayed.at(-1)).toContain("Cain was restored from a backup since his tap");
    const g = firstDeps({ status: (request) => ({ status: "ready", verified: true, request, restoredAt: Date.now() + 9e12 }) });
    const r2 = rig({ first: g.fd });
    await tapShip(r2);
    await restart(r2, g.fd);
    expect(tokens(r2)).toEqual([]);
    expect(r2.relayed.at(-1)).toContain("the Keeper saw a restore of Cain since his tap");
  });
  test("item 6: what installs is main: main at another version records nothing; main moved since the tap gets no token; the head moved neither", async () => {
    const f = firstDeps({ main: { sha: MAIN, version: "0.19.5" } });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(f.asked).toEqual([]);
    expect(r.relayed[0]).toContain("main has Cain 0.19.5, not the 0.19.4 his card installs");
    expect(r.msg(id).content).toContain("Installing it needs a new Ship tap.");
    const g = firstDeps();
    const r2 = rig({ first: g.fd });
    await tapShip(r2);
    g.st.main = { sha: "d".repeat(40), version: "0.19.4" };
    await restart(r2, g.fd);
    expect(tokens(r2)).toEqual([]);
    expect(r2.relayed.at(-1)).toContain("main moved since his tap");
    const h = firstDeps({ head: SHA2 });
    const r3 = rig({ first: h.fd });
    await tapShip(r3);
    await restart(r3, h.fd);
    expect(r3.relayed.at(-1)).toContain("the pull request's head moved since his tap");
  });
  test("the Keeper refusing the backup first ends the tap at once: no record, no token, the card says so; an older Keeper's 404 is named", async () => {
    const f = firstDeps({ ask: async () => ({ status: 409, body: { status: "refused", why: "another attempt is open" } }) });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(f.fd.store.load()).toBeNull();
    expect(r.relayed[1]).toContain("the Keeper couldn't back Cain up first: the Keeper refused it (another attempt is open)");
    expect(r.msg(id).content).toContain("not installed");
    expect(tokens(r)).toEqual([]);
    expect(judgeAsk({ status: 404, body: null })).toEqual({ ok: false, why: "the Keeper doesn't back Cain up first (it is older than Keeper 0.1.19)" });
    expect(judgeStatus({ status: 404, body: null })?.status).toBe("unknown");
  });
  test("a change that doesn't install Cain keeps today's path: the token at once, nothing recorded, the Keeper not asked", async () => {
    const f = firstDeps({ cain: false });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(r.relayed[0]).toContain("Ship token: ");
    expect(f.asked).toEqual([]);
    expect(f.fd.store.load()).toBeNull();
    expect(r.msg(id).content).toBe("Cain 0.19.4 ready.\n\nShipped: it's in main as of 8:00 AM. Installing it is next.");
  });
  test("can't tell what it installs: today's path (and the Keeper refuses an install of Cain without its backup first)", async () => {
    const f = firstDeps({ cain: null });
    const r = rig({ first: f.fd });
    await tapShip(r);
    expect(r.relayed[0]).toContain("Ship token: ");
    expect(f.asked).toEqual([]);
  });
});

describe("backup first: Cain's Ship card for himself checks the Keeper (item 7)", () => {
  const FACTS = { head: SHA1, commits: 1, files: 2, areas: ["Cain's link"], title: "", bumps: [{ app: "Cain", version: "0.19.4" }], merged: false };
  async function card(advertised: boolean | null, bumps = FACTS.bumps) {
    const f = firstDeps({ advertised });
    const r = rig({ facts: true, first: f.fd });
    r.github.facts = { ...structuredClone(FACTS), bumps } as any;
    const id = ((await r.link.ship({ text: "Cain backs up first.", item: "P41", pr: PR, head: SHA1 })) as any).message as string;
    return String(r.msg(id).content);
  }
  test("a Keeper without backup first: the card says so; one that has it, or a change not installing Cain: no line", async () => {
    expect(await card(false)).toContain(FIRST_MISSING);
    expect(await card(null)).toContain(FIRST_UNREAD);
    expect(await card(true)).not.toContain("backs Cain up first");
    expect(await card(false, [{ app: "Harness", version: "0.31.0" }])).not.toContain("backs Cain up first");
  });
});

describe("backup first: the registration carries the tap's nonce and main", () => {
  test("registerInstalls sends first_nonce and first_main for Cain from the used tap, and keeps main for the claim", async () => {
    const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
    const BASE = "b".repeat(40);
    const fp = keyFp(SHIP_PUB);
    const files: Record<string, any> = { [`cain/config.yaml@${BASE}`]: b64('version: "0.19.3"\n'), [`cain/config.yaml@${SHA1}`]: b64('version: "0.19.4"\n'),
      [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA1}`]: b64("// the probe\n"), [`cain/SHIP_KEY_FINGERPRINT@${SHA1}`]: b64(`# key\n${fp}\n`) };
    const api = async (path: string) => {
      if (path === "/repos/HyndeSyte/harness/pulls/5") return { status: 200, body: { base: { sha: BASE } } };
      if (path === `/repos/HyndeSyte/harness/compare/${BASE}...${SHA1}`) return { status: 200, body: { files: [{ filename: "cain/config.yaml", status: "modified" }] } };
      const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
      const f = m ? files[`${m[1]}@${m[2]}`] : undefined;
      return f ? { status: 200, body: f } : { status: 404, body: null };
    };
    const c = claimFor(PR, SHA1, Date.now())!;
    const posted: any[] = [];
    await registerInstalls({ api, log: () => {}, linkFp: fp, sleep: async () => {}, waitMs: 1, pollMs: 1,
      post: async (b) => { posted.push(b); return null; }, first: (cl) => (cl.exp === c.exp ? { nonce: "f".repeat(32), main: MAIN } : null) }, "tok", c);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ app: CAIN, first_nonce: "f".repeat(32), first_main: MAIN });
  });
});

// The Keeper itself, with a fake Supervisor: the link's ask at the tap makes the backup, GET's word gates the token, and the
// registration the token's Ship run makes after the restart is accepted against that backup with its nonce, with no second backup.
describe("backup first: through the Keeper", () => {
  function keeper(nowRef: { now: number }) {
    const logs: string[] = [], made: string[] = [], keys = new Map<string, string>();
    const app = { version: "0.19.3", state: "started" };
    const k = new Keeper({
      now: () => nowRef.now, version: "0.1.19", self: "0fcc2575_keeper",
      appInfo: async (slug: string) => (slug === CAIN ? { ...app } : null),
      backupInfo: async () => ({ date: new Date(nowRef.now).toISOString(), homeassistant: null, addons: [{ slug: CAIN, version: "0.19.3" }], folders: [], protected: true } as any),
      makeBackup: async (a: string) => { made.push(a); return { slug: `kb-${made.length}` }; },
      restore: async () => ({ kind: "started", job: "j" } as any),
      backupKeys: { store: (n: string, v: string) => { keys.set(n, v); return true; }, load: (n: string) => keys.get(n) ?? null, drop: (n: string) => keys.delete(n), list: () => [...keys.keys()] },
      diskFree: async () => 10 * 1024 ** 3, backups: async () => [], activeJobs: async () => [], backupJobs: async () => [], installJobs: async () => [], restoreSeenAt: async () => 0,
      job: async () => ({ found: false } as any), live: async () => true, ready: async () => true, ping: async () => true,
      timer: () => new Promise<void>(() => {}), lockCallMs: 50, lockStepMs: 300,
      options: () => opts, save: () => true, log: (l: string) => logs.push(l),
    } as any, null);
    const opts = { watch: [CAIN], health: [`${CAIN}=0fcc2575-cain:8098/ready`], tokens: [`${CAIN}=cain-token-0123456789abcdef`],
      hc_done: "https://hc-ping.example/done", hc_deadman: "https://hc-ping.example/deadman", hc_failed: "https://hc-ping.example/failed",
      health_grace_s: 0, ship_public_key: SHIP_PUB };
    k.useOptions(opts);
    k.start();
    k.keyCode();
    const code = [...logs].reverse().map((l) => /^one-time code for key-confirm: ([0-9a-f]+) /.exec(l)).find(Boolean)![1];
    expect(k.keyConfirm(keyFp(SHIP_PUB), code).ok).toBe(true);
    return { k, made, logs };
  }
  const body = (token: string, over: any = {}) => ({ token, app: CAIN, pr: 5, head: SHA1, from_version: "0.19.3", to_version: "0.19.4", probe_hash: "abcdef0123456789", kind: "ship", ...over });
  function wired() {
    const t = { now: 0 };
    let kp: ReturnType<typeof keeper> | null = null;
    const f = firstDeps({ ask: async (b) => { const a = await kp!.k.backupFirst(CAIN, b); await kp!.k.whenFirst(CAIN); return a; } });
    f.fd.status = async (request) => judgeStatus(await kp!.k.firstView(CAIN, CAIN, request));
    const r = rig({ first: f.fd });
    Object.defineProperty(t, "now", { get: () => r.t.now });
    kp = keeper(t as any);
    return { r, f, kp: kp! };
  }
  test("a Cain install with the backup-first restart is accepted with the one backup, its nonce consumed once", async () => {
    const { r, f, kp } = wired();
    await tapShip(r);
    expect(kp.made).toEqual([CAIN]);                          // the backup at the tap (this is what restarts Cain)
    await restart(r, f.fd);
    const token = findToken(r.relayed[1])!;
    expect(token).toBeTruthy();
    const claim = (readToken(token, KEY, r.t.now) as any).claim;
    const u = usedFor(f.fd.store.used(), claim)!;
    const ans = await kp.k.registerAttempt(CAIN, body(token, { first_nonce: u.nonce, first_main: u.main }));
    expect(ans.status).toBe(202);
    await kp.k.whenSettled(String(ans.body.id));
    const v = kp.k.attemptView(CAIN, String(ans.body.id));
    expect(v.body.status).toBe("accepted");
    expect(v.body.backup).toBe("kb-1");
    expect(kp.made).toEqual([CAIN]);                          // no second backup: nothing stops Cain under a registration
    // the same nonce again, under a fresh token, is refused: consumed once
    const again = await kp.k.registerAttempt(CAIN, body(token.replace(/.$/, "A"), { pr: 5, first_nonce: u.nonce, first_main: u.main }));
    expect(again.status).toBe(409);
  });
  test("item 7 and 10: an old link against the new Keeper (no backup first): Cain's registration is refused with the clear message", async () => {
    const { r, kp } = wired();
    const token = r.link["signFor"]({ pr: PR, head: SHA1 }) as string;
    const ans = await kp.k.registerAttempt(CAIN, body(token));
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toContain(FIRST_OLD_LINK_WHY);
    expect(kp.made).toEqual([]);
  });
  test("item 5 and 10: a restore the Keeper sees between the tap and the token: the link gets no token", async () => {
    const { r, f, kp } = wired();
    await tapShip(r);
    (kp.k as any).d.restoreSeenAt = async () => r.t.now + 1;
    await restart(r, f.fd);
    expect(tokens(r)).toEqual([]);
  });
});
