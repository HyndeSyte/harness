// Cain 0.19.4 with Keeper 0.1.19: backup first. His Ship tap for an install of Cain records only the tap and asks the Keeper to
// back Cain up (a cold backup: it stops and starts Cain and his link); after the restart the link gives the Ship token for the
// recorded tap once, and the Keeper accepts Cain's registration against the backup it took first, so nothing is cancelled.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FirstStatus, type FirstTap, fileFirstStore, judgeAsk, TAP_WINDOW_MS } from "../rootfs/opt/cain/link/backup-first";
import { claimFor, findToken, publicKey, readToken } from "../rootfs/opt/cain/ship-token";
import { Keeper, keyFp } from "../../keeper/rootfs/opt/keeper/core.ts";
import { MIN, PR, rig, SHA1, SHA2, SHIP_PUB } from "./link-rig";

const snap = (m: any) => JSON.parse(JSON.stringify(m));
const KEY = publicKey(SHIP_PUB);
const CAIN = "0fcc2575_cain";

// The recorded tap and its used list as files (the link's own store), and the Keeper and GitHub as the test sets them.
function firstDeps(o: { cain?: boolean | null; head?: string | null; ask?: (body: any) => Promise<{ status: number; body: any } | null>; status?: FirstStatus | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backup-first-"));
  const asked: any[] = [];
  const fd = {
    store: fileFirstStore(join(dir, "backup-first.json"), join(dir, "backup-first-used.json"), (p, t) => writeFileSync(p, t)),
    booted: 0,
    installsCain: async () => (o.cain === undefined ? true : o.cain),
    ask: async (ship: { pr: string; head: string }) => { const body = { app: CAIN, pr: 5, head: ship.head }; asked.push(body); return judgeAsk(o.ask ? await o.ask(body) : { status: 202, body: { status: "pending" } }); },
    status: async () => (o.status === undefined ? { status: "making" as const } : o.status),
    head: async () => (o.head === undefined ? SHA1 : o.head),
  };
  return { fd, dir, asked, tapFile: join(dir, "backup-first.json") };
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

describe("backup first: Cain's Ship tap", () => {
  test("a Cain install: the tap is recorded and the Keeper asked, no token yet; after the restart the token goes out once", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(r.github.main).toEqual([SHA1]);
    expect(findToken(r.relayed[0])).toBeNull();
    expect(r.relayed[0]).toContain("the Keeper backs Cain up first");
    expect(f.asked).toEqual([{ app: CAIN, pr: 5, head: SHA1 }]);
    const tap = JSON.parse(readFileSync(f.tapFile, "utf8")) as FirstTap;
    expect(tap).toEqual({ v: 1, pr: PR, head: SHA1, msg: id, at: r.t.now });         // only the tap: no attempt, no token
    expect(r.msg(id).content).toContain("Before installing, the Keeper backs Cain up");
    await r.link.sweep();                                     // not restarted yet, the backup still being made: nothing
    expect(r.relayed).toHaveLength(1);
    await restart(r, f.fd);
    const token = findToken(r.relayed[1])!;
    expect(token).toBeTruthy();
    expect(readToken(token, KEY, r.t.now)).toEqual({ ok: true, claim: claimFor(PR, SHA1, r.t.now) });
    expect(r.msg(id).content).toContain("Cain is backed up as of");
    expect(f.fd.store.load()).toBeNull();                    // used once, then removed
    await r.link.sweep();
    expect(r.relayed).toHaveLength(2);
  });
  test("the same recorded tap brought back after its use gets nothing, and he's told in one line", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    const kept = readFileSync(f.tapFile, "utf8");
    await restart(r, f.fd);
    expect(findToken(r.relayed[1])).toBeTruthy();
    writeFileSync(f.tapFile, kept);                          // the same tap again
    await restart(r, f.fd, MIN);
    expect(r.relayed).toHaveLength(3);
    expect(findToken(r.relayed[2])).toBeNull();
    expect(r.relayed[2]).toContain("that recorded tap was used before");
    expect(f.fd.store.load()).toBeNull();
  });
  test("a recorded tap older than the window registers nothing: no token, one line, and the card asks for a new tap", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    await restart(r, f.fd, TAP_WINDOW_MS + MIN);
    expect(r.relayed).toHaveLength(2);
    expect(findToken(r.relayed[1])).toBeNull();
    expect(r.relayed[1]).toContain(`over ${TAP_WINDOW_MS / MIN} minutes old`);
    expect(r.msg(id).content).toContain("Installing it needs a new Ship tap.");
    expect(f.fd.store.load()).toBeNull();
  });
  test("a recorded tap whose pull request's head moved gets no token", async () => {
    const f = firstDeps({ head: SHA2 });
    const r = rig({ first: f.fd });
    await tapShip(r);
    await restart(r, f.fd);
    expect(findToken(r.relayed[1])).toBeNull();
    expect(r.relayed[1]).toContain("the pull request's head moved since his tap");
  });
  test("a Stop since his tap ends it", async () => {
    const f = firstDeps();
    const r = rig({ first: f.fd });
    await tapShip(r);
    r.stop.stopped = true; r.stop.at = r.t.now + 1;
    await restart(r, f.fd);
    expect(r.relayed.some((l) => findToken(l))).toBe(false);
  });
  test("the Keeper refusing the backup first ends the tap at once: no record, no token, the card says so", async () => {
    const f = firstDeps({ ask: async () => ({ status: 409, body: { status: "refused", why: "another attempt is open" } }) });
    const r = rig({ first: f.fd });
    const id = await tapShip(r);
    expect(f.fd.store.load()).toBeNull();
    expect(r.relayed[1]).toContain("the Keeper couldn't back Cain up first: the Keeper refused it (another attempt is open)");
    expect(r.msg(id).content).toContain("not installed");
    expect(r.relayed.some((l) => findToken(l))).toBe(false);
  });
  test("a backup the Keeper made without stopping the link: the token goes out once the Keeper says it's ready", async () => {
    const f = firstDeps({ status: { status: "ready", pr: 5, head: SHA1 } });
    const r = rig({ first: f.fd });
    await tapShip(r);
    await r.link.sweep();
    expect(findToken(r.relayed[1])).toBeTruthy();
  });
  test("a backup first that failed at the Keeper gets no token", async () => {
    const f = firstDeps({ status: { status: "failed", why: "500 busy" } });
    const r = rig({ first: f.fd });
    await tapShip(r);
    await r.link.sweep();
    expect(findToken(r.relayed[1])).toBeNull();
    expect(r.relayed[1]).toContain("500 busy");
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
  test("can't tell what it installs: today's path", async () => {
    const f = firstDeps({ cain: null });
    const r = rig({ first: f.fd });
    await tapShip(r);
    expect(r.relayed[0]).toContain("Ship token: ");
    expect(f.asked).toEqual([]);
  });
});

// The Keeper itself, with a fake Supervisor: the link's ask at the tap makes the backup, and the registration the token's Ship run
// makes after the restart is accepted against it, with no second backup (the second one is what stopped Cain and cancelled it).
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
      diskFree: async () => 10 * 1024 ** 3, backups: async () => [], activeJobs: async () => [], backupJobs: async () => [], installJobs: async () => [],
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
  test("a Cain install with the backup-first restart is accepted with the one backup", async () => {
    const t = { now: 0 };
    let kp: ReturnType<typeof keeper> | null = null;
    const f = firstDeps({ ask: async (body) => { const a = await kp!.k.backupFirst(CAIN, body); await kp!.k.whenFirst(CAIN); return a; } });
    const r = rig({ first: f.fd });
    t.now = r.t.now;
    Object.defineProperty(t, "now", { get: () => r.t.now });
    kp = keeper(t as any);
    await tapShip(r);
    expect(kp.made).toEqual([CAIN]);                          // the backup at the tap (this is what restarts Cain)
    await restart(r, f.fd);
    const token = findToken(r.relayed[1])!;
    expect(token).toBeTruthy();
    // the Ship run's pass registers the install as for any App (ship-pass.ts registerInstalls sends this body)
    const ans = await kp.k.registerAttempt(CAIN, { token, app: CAIN, pr: 5, head: SHA1, from_version: "0.19.3", to_version: "0.19.4", probe_hash: "abcdef0123456789", kind: "ship" });
    expect(ans.status).toBe(202);
    await kp.k.whenSettled(String(ans.body.id));
    const v = kp.k.attemptView(CAIN, String(ans.body.id));
    expect(v.body.status).toBe("accepted");
    expect(v.body.backup).toBe("kb-1");
    expect(kp.made).toEqual([CAIN]);                          // no second backup: nothing stops Cain under a registration
  });
});
