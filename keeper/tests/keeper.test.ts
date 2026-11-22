// Keeper: the attempt life cycle with a fake Supervisor and a fake clock, verdict binding and token
// refusal, /armed and its bindings, the Healthchecks queue, the rewind drop, and the options re-read
// without a restart. 0.1.3 (the third review's fixes): the signed registration over POST /attempt and
// its single use; the restore sent again only after a proven pre-execution refusal, and "rolled back"
// only on its job's success; alert checks per App, the shared-success suppression, the dead-man check
// and the phone test drill; no options write and no kept settings; local evidence only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { CONFIRM_MS, DELIVERY_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, RESTORE_LIMIT_MS, REWIND_MS, WATCH_MS, ARMED_MAX_MS, PHONE_MAX_MS, LOOP_FRESH_MS, checkId, keyFp, optionsHash, parseOptions, readShipToken, shipKey,
  type AppInfo, type BackupInfo, type JobState, type RestoreJobsSeen, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
import { healthUrl, liveUrl } from "../rootfs/opt/keeper/main.ts";
import { supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { handle, internal } from "../rootfs/opt/keeper/server.ts";

const CAIN = "0fcc2575_cain";
const HARNESS = "0fcc2575_harness";
const TOKEN = "cain-token-0123456789abcdef";
const HTOKEN = "harness-token-0123456789ab";
const T0 = Date.parse("2026-11-21T15:00:00Z");
const HEAD = "7d7b5f9".padEnd(40, "0");
const HASH = "abcdef0123456789";
const ID = `ship-46-cain-${HEAD.slice(0, 8)}`;
const ROLL = CONFIRM_MS / POLL_MS + 4;
const LIMIT_POLLS = RESTORE_LIMIT_MS / POLL_MS + 2;

// The link's Ship key (a test one) and its tokens, as cain/rootfs/opt/cain/ship-token.ts makes them.
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { privateKey: LINK, publicKey: LINK_PUB } = generateKeyPairSync("ed25519");
const { privateKey: OTHER } = generateKeyPairSync("ed25519");
const PUB = LINK_PUB.export({ format: "der", type: "spki" }).toString("base64");
function shipToken(o: { pr?: number; head?: string; exp?: number; repo?: string; key?: KeyObject; now?: number } = {}): string {
  const claim = { v: 1, repo: o.repo ?? "HyndeSyte/harness", pr: o.pr ?? 46, head: o.head ?? HEAD, exp: o.exp ?? Math.floor((o.now ?? T0) / 1000) + 7200 };
  const payload = b64url(Buffer.from(JSON.stringify(claim)));
  return `ship1.${payload}.${b64url(edSign(null, Buffer.from(`ship1.${payload}`), o.key ?? LINK))}`;
}

function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string }[] = [];
  const backupsMade: string[] = [];
  const jobCalls: string[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    app, alive: true, ready: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
    jobs: {} as Record<string, JobState>, jobsUp: true, restoreJobsListed: { matching: 0, unclassified: 0 } as RestoreJobsSeen | null,
    // (0.1.4) the registration's wait for its backup: never fires unless a test makes it
    timer: (_ms: number): Promise<void> => new Promise(() => {}),
    makeBackup: async (a: string): Promise<{ slug: string } | { why: string }> => ({ slug: `kb-${a.slice(-4)}` }),
    pingFails: (_url: string) => !f.pingOk,
    backup: o.backup === null ? null : { homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: false, ...(o.backup ?? {}) } as BackupInfo | null,
    onRestore: () => { app.version = "0.16.0"; app.state = "started"; },
    options: {
      watch: [CAIN], health: [`${CAIN}=0fcc2575-cain:8098/ready`], tokens: [`${CAIN}=${TOKEN}`, `${HARNESS}=${HTOKEN}`],
      hc_done: "https://hc-ping.example/done", hc_deadman: "https://hc-ping.example/deadman", hc_failed: "https://hc-ping.example/failed",
      health_grace_s: 0, ship_public_key: PUB, ...(o.opts ?? {}),
    } as any,
  };
  const k = new Keeper({
    now: () => now, version: "0.1.0", self: "0fcc2575_keeper",
    appInfo: async (slug) => (f.infoUp && slug === CAIN ? { ...app } : null),
    backupInfo: async () => (f.backup ? { date: new Date(now).toISOString(), ...f.backup } : null),
    makeBackup: async (a) => { backupsMade.push(a); return f.makeBackup(a); },
    restore: async (backup, a) => {
      restores.push({ backup, app: a });
      const r = f.restoreQueue.shift();
      if (r) return r;
      const id = `job-${restores.length}`;
      f.jobs[id] = { found: true, uuid: id, done: true, errors: 0, name: "backup_manager_partial_restore", reference: backup };
      f.onRestore();
      return { kind: "started", job: id };
    },
    job: async (uuid) => { jobCalls.push(uuid); return f.jobsUp ? f.jobs[uuid] ?? { found: false } : null; },
    restoreJobs: async () => f.restoreJobsListed,
    timer: (ms) => f.timer(ms),
    live: async () => f.alive,
    ready: async () => f.ready,
    ping: async (url, body) => { pings.push({ url, body }); return !f.pingFails(url); },
    options: () => JSON.parse(JSON.stringify(f.options)),
    save: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.useOptions(f.options);
  k.start();
  const r = {
    k, f, logs, pings, restores, backupsMade, jobCalls, get saved() { return saved; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    // A registration as Cain's link sends it (POST /attempt): the keeper makes the backup itself (0.1.4).
    async register(over: any = {}, caller: string | null = CAIN) {
      const head = over.head ?? HEAD;
      const body: any = { token: shipToken({ head, now }), app: CAIN, pr: 46, head, from_version: "0.16.0", to_version: "0.17.0",
        probe_hash: HASH, kind: "ship", ...over };
      return k.registerAttempt(caller, body);
    },
    async poll(n = 1) { for (let i = 0; i < n; i++) { await k.poll(); await k.deadman(); now += POLL_MS; } },
    install(state = "started") { app.version = "0.17.0"; app.state = state; },
    verdict(result: "PASS" | "FAIL", over: any = {}) { return k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: ID, result, reason: result === "FAIL" ? "no answer" : "", ...over }); },
    a(id = ID) { return k.st.attempts[id]; },
  };
  return r;
}
const headN = (n: number) => `${n}`.padStart(8, "0").padEnd(40, "a");
const idOf = (head: string, kind = "ship") => `${kind}-46-cain-${head.slice(0, 8)}`;

describe("fix 1: the owner's tap proven to the keeper (a signed Ship token, spent once)", () => {
  test("a valid signed registration is accepted once, with its one accepting line", async () => {
    const r = rig();
    const ans = await r.register();
    expect(ans.status).toBe(200);
    expect(ans.body.id).toBe(ID);
    expect(r.a().status).toBe("accepted");
    expect(r.logs).toContain(`accepting ${ID} ${CAIN} 0.16.0 to 0.17.0 backup kb-cain until ${new Date(T0 + 3_600_000).toISOString()}`);
    await r.poll(3);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
  });
  test("a replay of the same token for the same App is refused, and reported", async () => {
    const r = rig();
    const token = shipToken();
    const body = { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH };
    expect((await r.k.registerAttempt(CAIN, body)).status).toBe(200);
    const again = await r.k.registerAttempt(CAIN, { ...body, to_version: "0.18.0" });
    expect(again.status).toBe(409);
    expect(String(again.body.why)).toContain(`a replay: that Ship token was spent for ${CAIN} under ${ID}`);
    await r.poll();
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("a replay"))).toBe(true);
    expect(r.a().to).toBe("0.17.0");
  });
  for (const [name, over, why] of [
    ["a forged token (signed by another key)", { token: shipToken({ key: OTHER }) }, "signature doesn't verify"],
    ["a random 64-hex string", { token: "a".repeat(64) }, "isn't a Ship token"],
    ["a token with its signature cut", { token: shipToken().slice(0, -2) + "AA" }, "signature doesn't verify"],
    ["an expired token", { token: shipToken({ exp: Math.floor(T0 / 1000) - 10 }) }, "expired"],
    ["a token lasting further than a Ship token", { token: shipToken({ exp: Math.floor(T0 / 1000) + 4 * 3600 }) }, "further off"],
    ["a token for another repository", { token: shipToken({ repo: "someone/else" }) }, "another repository"],
    ["another pull request than the token's", { pr: 47 }, "aren't the token's"],
    ["another head than the token's", { head: "f".repeat(40), token: shipToken() }, "aren't the token's"],
    ["no token", { token: "" }, "no Ship token"],
  ] as const) {
    test(`${name} is refused: no attempt, nothing ever restored, the owner hears`, async () => {
      const r = rig();
      const ans = await r.register(over);
      expect(ans.status).toBe(409);
      expect(String(ans.body.why)).toContain(why);
      expect(Object.keys(r.k.st.attempts)).toEqual([]);
      expect(r.k.st.spent).toEqual([]);
      r.install("error"); await r.poll(5);
      expect(r.restores).toEqual([]);
      expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.startsWith("Keeper refused a registration"))).toBe(true);
    });
  }
  test("no ship_public_key, or one that isn't an Ed25519 key: every registration refused", async () => {
    for (const key of ["", "bm90IGEga2V5"]) {
      const r = rig({ opts: { ship_public_key: key } });
      const ans = await r.register();
      expect(ans.status).toBe(409);
      expect(String(ans.body.why)).toContain("ship_public_key");
    }
  });
  test("only Cain's App registers: another App's token is refused with 403", async () => {
    const r = rig();
    expect((await r.register({}, HARNESS)).status).toBe(403);
    expect((await r.register({}, null)).status).toBe(403);
  });
  test("the state never holds the token, only its id", async () => {
    const r = rig();
    const token = shipToken();
    await r.k.registerAttempt(CAIN, { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    expect(JSON.stringify(r.saved)).not.toContain(token);
    expect(JSON.stringify(r.saved)).not.toContain(token.split(".")[2]);
    expect(r.k.st.spent[0].auth).toMatch(/^[0-9a-f]{32}$/);
  });
  test("readShipToken: the link's own token format verifies with its public key, and nothing else does", () => {
    const key = shipKey(PUB)!;
    const ok = readShipToken(shipToken(), key, T0);
    expect(ok.ok && ok.claim.pr === 46 && ok.claim.head === HEAD).toBe(true);
    expect(readShipToken(shipToken({ key: OTHER }), key, T0).ok).toBe(false);
    expect(shipKey("")).toBeNull();
  });
  test("bad registrations refused on their fields: the keeper itself, an unwatched App, bad versions, a bad probe hash, an open attempt", async () => {
    for (const [over, why] of [
      [{ app: "0fcc2575_keeper" }, "its own install"], [{ app: HARNESS }, "watch list"],
      [{ to_version: "0.16.0" }, "the same"], [{ probe_hash: "nope" }, "probe_hash"], [{ kind: "merge" }, "kind"],
    ] as const) {
      const r = rig();
      const ans = await r.register(over);
      expect([JSON.stringify(over), ans.status, String(ans.body.why).includes(why)]).toEqual([JSON.stringify(over), 409, true]);
    }
    const r = rig(); await r.register();
    const second = await r.register({ head: headN(2) });
    expect(String(second.body.why)).toContain("another attempt");
  });
});

describe("fix 4: registration over the keeper's own service, never an options write", () => {
  const call = (r: ReturnType<typeof rig>, path: string, init: RequestInit = {}, ip = "172.30.33.4", token: string | null = TOKEN, log: string[] = []) =>
    handle(r.k, new Request(`http://keeper${path}`, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} }), ip, (m) => log.push(m));
  const body = (over: any = {}) => JSON.stringify({ token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, ...over });
  test("POST /attempt with Cain's token and the right body registers; nothing else does", async () => {
    const r = rig();
    const log: string[] = [];
    expect((await call(r, "/attempt", { method: "POST", body: body() }, "192.168.1.10", TOKEN, log)).status).toBe(403);
    expect((await call(r, "/attempt", { method: "POST", body: body() }, "172.30.33.4", null, log)).status).toBe(401);
    expect((await call(r, "/attempt", { method: "POST", body: body() }, "172.30.33.4", "wrong-token-0123456789", log)).status).toBe(401);
    expect((await call(r, "/attempt", { method: "POST", body: body() }, "172.30.33.4", HTOKEN, log)).status).toBe(403);
    expect((await call(r, "/attempt", { method: "POST", body: "not json" }, "172.30.33.4", TOKEN, log)).status).toBe(400);
    expect((await call(r, "/attempt", { method: "POST", body: body({ token: shipToken({ key: OTHER }) }) })).status).toBe(409);
    expect(Object.keys(r.k.st.attempts)).toEqual([]);
    const ok = await call(r, "/attempt", { method: "POST", body: body() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).id).toBe(ID);
    expect(r.a().status).toBe("accepted");
    const at = await (await call(r, "/attempt")).json() as any;
    expect(at.attempt).toBe(ID);
  });
  test("the options carry no registration, and nothing in them registers an install", async () => {
    const r = rig();
    r.f.options.attempt = { id: "a1", app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup_slug: "b1", install_deadline: new Date(T0 + 1_800_000).toISOString(), authorization: "ship", probe_hash: HASH };
    await r.poll(3);
    expect(r.k.st.attempts).toEqual({});
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).not.toMatch(/^\s+attempt:/m);
    expect(cfg).toMatch(/^  ship_public_key: ""$/m);
    expect(cfg).toMatch(/^  hc_deadman: password\?$/m);
  });
  test("no kept settings: options that drop a credential are taken as they are, never refilled", async () => {
    const r = rig(); await r.poll();
    expect((r.saved as any).kept).toBeUndefined();
    r.f.options.tokens = []; r.f.options.hc_done = ""; await r.poll();
    expect(r.k.appOfToken(TOKEN)).toBeNull();
    expect(r.k.opts.hc_done).toBe("");
    expect(r.k.armable()).toBe(false);
    const old = { format: 1, kept: { tokens: { [CAIN]: TOKEN }, hc_done: "https://old", hc_failed: { "*": "https://old" } }, settingsHold: "x" };
    const r2 = rig({ saved: old, opts: { tokens: [], hc_done: "" } });
    expect(r2.k.appOfToken(TOKEN)).toBeNull();
    expect(r2.k.opts.hc_done).toBe("");
    expect((r2.saved as any).kept).toBeUndefined();
  });
  test("(0.1.4) the registration's answer waits until the keeper's backup is complete and verified, and carries its slug", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    let answered: any = null;
    const p = r.register().then((a) => { answered = a; });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    expect(answered).toBeNull();
    expect(r.a().status).toBe("verifying");
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    finish({ slug: "kb-late" }); await p;
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ status: "accepted", id: ID, app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb-late", until: new Date(T0 + 3_600_000).toISOString() });
    expect(r.a().status).toBe("accepted");
    expect(r.backupsMade).toEqual([CAIN]);
  });
  test("(0.1.4) the App at another version, a failed backup, a backup past 4 minutes or a restart while making it: refused, unprotected, paged", async () => {
    const r = rig(); r.f.app.version = "0.15.0";
    expect((await r.register()).status).toBe(409);
    expect(r.a().status).toBe("unprotected");
    expect(r.backupsMade).toEqual([]);
    const r2 = rig(); r2.f.makeBackup = async () => ({ why: "400 busy" });
    const a2 = await r2.register();
    expect([a2.status, a2.body.status, String(a2.body.why).includes("400 busy")]).toEqual([409, "refused", true]);
    expect(r2.a().status).toBe("unprotected");
    await r2.poll();
    expect(r2.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.startsWith("Keeper can't protect the install of Cain 0.17.0"))).toBe(true);
    expect(r2.logs.some((l) => l.includes("UNPROTECTED"))).toBe(true);
    const slow = rig(); slow.f.makeBackup = () => new Promise(() => {}); slow.f.timer = async () => {};
    const a3 = await slow.register();
    expect(a3.status).toBe(409);
    expect(String(a3.body.why)).toContain("didn't complete within 4 minutes");
    expect(slow.a().status).toBe("unprotected");
    const r3 = rig(); r3.f.makeBackup = () => new Promise(() => {});
    void r3.register();
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const r4 = rig({ saved: JSON.parse(JSON.stringify(r3.k.st)) });
    await r4.poll();
    expect(r4.a().status).toBe("unprotected");
    expect(r4.a().why).toContain("restarted while it made the backup");
    expect(r4.backupsMade).toEqual([]);
  });
  test("(0.1.4) a registration naming a backup is refused, and a backup dated before the token's issue isn't accepted", async () => {
    const r = rig();
    const ans = await r.register({ backup_slug: "b1234567" });
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toContain("always makes the backup itself");
    expect(r.backupsMade).toEqual([]);
    const old = rig({ backup: { date: new Date(T0 - 10 * 60_000).toISOString() } as any });
    expect((await old.register()).status).toBe(409);
    expect(old.a().why).toBe("its backup is dated before the Ship token was issued");
  });
  for (const [name, backup, why] of [
    ["holds Home Assistant", { homeassistant: "2026.11.2" }, "holds Home Assistant"],
    ["holds two Apps", { addons: [{ slug: CAIN, version: "0.16.0" }, { slug: "x", version: "1" }] }, "2 Apps"],
    ["holds folders", { folders: ["share"] }, "folders"],
    ["holds another version", { addons: [{ slug: CAIN, version: "0.15.0" }] }, "0.15.0, not 0.16.0"],
    ["isn't shown as protected false", { protected: undefined }, "without a password"],
  ] as const) {
    test(`a backup that ${name} leaves the attempt unprotected`, async () => {
      const r = rig({ backup: backup as any }); await r.register();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs.some((l) => l.startsWith(`refusing ${ID}: `) && l.includes(why))).toBe(true);
      r.install("error"); await r.poll(5);
      expect(r.restores).toEqual([]);
    });
  }
  test("the keeper never writes options: a whole cycle through the real Supervisor calls writes only its backup and the restore", async () => {
    const calls: { method: string; path: string; body: any }[] = [];
    const app = { version: "0.16.0", state: "started" };
    const options: any = { watch: [CAIN], health: [`${CAIN}=c:8098`], tokens: [`${CAIN}=${TOKEN}`], hc_done: "https://hc/done", hc_deadman: "https://hc/dm", hc_failed: ["https://hc/failed"], health_grace_s: 0, ship_public_key: PUB };
    let job: any = null;
    const http = async (url: string, init: RequestInit) => {
      const path = url.replace("http://supervisor", "");
      calls.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (data: any) => new Response(JSON.stringify({ result: "ok", data }), { status: 200 });
      if (path === "/addons/self/info") return ok({ slug: "0fcc2575_keeper", version: "0.1.3", options });
      if (path === `/addons/${CAIN}/info`) return ok(app);
      if (path === "/backups/new/partial") return ok({ slug: "kb1" });
      if (path === "/backups/kb1/info") return ok({ homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: false, date: new Date(now).toISOString() });
      if (path === "/backups/kb1/restore/partial") { job = { name: "backup_manager_partial_restore", reference: "kb1", uuid: "j1", done: true, errors: [], child_jobs: [] }; app.version = "0.16.0"; app.state = "started"; return ok({ job_id: "j1" }); }
      if (path === "/jobs/info") return ok({ jobs: job ? [job] : [] });
      return new Response(JSON.stringify({ result: "error" }), { status: 404 });
    };
    const sup = supervisor("t", "http://supervisor", http);
    let now = T0;
    const k = new Keeper({ now: () => now, version: "0.1.3", self: "0fcc2575_keeper", appInfo: sup.appInfo, backupInfo: sup.backupInfo, makeBackup: sup.makeBackup,
      restore: sup.restore, job: sup.job, restoreJobs: sup.restoreJobs, live: async () => true, ready: async () => true, ping: async () => true,
      options: () => sup.selfOptions(), save: () => {}, log: () => {} }, null);
    k.useOptions(options); k.start();
    const poll = async (n: number) => { for (let i = 0; i < n; i++) { await k.poll(); now += POLL_MS; } };
    await k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    await poll(2); expect(k.st.attempts[ID].status).toBe("accepted");
    app.version = "0.17.0"; await poll(1);
    k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: ID, result: "FAIL", reason: "x" });
    await poll(ROLL);
    expect(k.st.attempts[ID].status).toBe("rolled back");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /backups/new/partial", "POST /backups/kb1/restore/partial"]);
    expect(writes[0].body).toEqual({ name: `Keeper ${ID}`, addons: [CAIN], homeassistant: false, folders: [], background: false });
    expect(writes[1].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true });
    expect(calls.some((c) => c.path.includes("options"))).toBe(false);
  });
  test("no code path names the options endpoint", () => {
    for (const f of ["core.ts", "supervisor.ts", "main.ts", "server.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", f), "utf8");
      expect([f, /addons\/self\/options|clearAttempt/.test(src)]).toEqual([f, false]);
    }
  });
});

async function watching(r: ReturnType<typeof rig>, over: any = {}) { await r.register(over); await r.poll(); r.install(); await r.poll(); expect(r.a().status).toBe("watching"); }
async function failed(r: ReturnType<typeof rig>) { await watching(r); r.verdict("FAIL"); }

describe("the watch", () => {
  test("the pass rule: a PASS verdict, started every poll, /health 200 on the last three, at the end of 15 minutes", async () => {
    const r = rig(); await watching(r);
    expect(r.verdict("PASS").ok).toBe(true);
    await r.poll(WATCH_MS / POLL_MS + 1);
    expect(r.a().status).toBe("passed");
    expect(r.restores).toEqual([]);
  });
  test("no verdict by the end is a fail, and the backup is restored", async () => {
    const r = rig(); await watching(r);
    await r.poll(WATCH_MS / POLL_MS + 2 + ROLL);
    expect(r.a().trigger?.kind).toBe("watch-end");
    expect(r.a().status).toBe("rolled back");
    expect(r.restores).toEqual([{ backup: "kb-cain", app: CAIN }]);
  });
  test("a FAIL verdict, state error, or not started on two polls fails", async () => {
    let r = rig(); await failed(r); expect(r.a().status).toBe("restoring"); await r.poll(ROLL); expect(r.a().status).toBe("rolled back");
    r = rig(); await watching(r); r.f.app.state = "error"; await r.poll(); expect(r.a().trigger?.kind).toBe("state-error");
    r = rig(); await watching(r);
    r.f.app.state = "stopped"; await r.poll(); expect(r.a().status).toBe("watching");
    r.f.app.state = "started"; await r.poll(); r.f.app.state = "stopped"; await r.poll(2);
    expect(r.a().trigger?.kind).toBe("not-started");
  });
  test("liveness failing on three polls in a row fails (after the grace)", async () => {
    const r = rig(); await watching(r); r.f.alive = false;
    await r.poll(2); expect(r.a().status).toBe("watching");
    await r.poll(); expect(r.a().trigger?.kind).toBe("health");
  });
  test("the install never starting (still the old version at the deadline) restores nothing, and the owner hears", async () => {
    const r = rig(); await r.register(); await r.poll();
    r.advance(61 * 60_000); await r.poll();
    expect(r.a().status).toBe("never started");
    expect(r.restores).toEqual([]);
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("never started"))).toBe(true);
  });
  test("a restart while restoring with the call out: never sent again", async () => {
    const r = rig(); await failed(r);
    const st = JSON.parse(JSON.stringify(r.k.st)); Object.assign(st.attempts[ID].restore, { inflight: true, tries: 1, sentAt: r.now });
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0";
    await r2.poll(LIMIT_POLLS + 2);
    expect(r2.restores).toEqual([]);
    expect(r2.a().status).toBe("unresolved");
  });
  test("a version change with no attempt never restores; it is logged and alarmed", async () => {
    const r = rig(); await r.poll(); r.install(); await r.poll();
    expect(r.logs.some((l) => l.startsWith("unregistered change 0fcc2575_cain 0.16.0 to 0.17.0"))).toBe(true);
    expect(r.restores).toEqual([]);
  });
});

describe("fix 5: local evidence only (liveness decides; chat is only reported)", () => {
  test("a started, live App with /ready down for 20 minutes passes the install check, reported degraded", async () => {
    const r = rig(); r.f.ready = false;
    await watching(r); r.verdict("PASS");
    await r.poll(20 * 60_000 / POLL_MS);
    expect(r.a().status).toBe("passed");
    expect(r.restores).toEqual([]);
    expect(r.logs).toContain(`${ID}: passed (${CAIN} 0.17.0; chat not connected (degraded))`);
    expect(r.logs).toContain(`${CAIN}: chat not connected (degraded)`);
    // (0.1.4) chat down for most of the window: paged (a fail ping and its own all clear), nothing restored
    expect(r.k.st.last[CAIN].kind).toBe("degraded");
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.includes("passed Keeper's install check on liveness, but chat wasn't connected for most of it") && p.body.includes("restore backup kb-cain by hand"))).toBe(true);
    expect(r.k.st.outstanding[CAIN]).toBeUndefined();
    expect(r.k.st.queue).toEqual([]);
  });
  test("a wedged App (started, never a liveness 200) fails at the end of the window", async () => {
    const r = rig(); r.f.alive = false;
    await watching(r); r.verdict("PASS");
    await r.poll(WATCH_MS / POLL_MS - 2);
    expect(r.a().status).toBe("watching");
    await r.poll(3);
    expect(r.a().trigger?.kind).toBe("watch-end");
    expect(r.a().trigger?.words).toContain("liveness");
  });
  test("a healthy local rollback with chat down still counts as rolled back, reported degraded", async () => {
    const r = rig(); await failed(r); r.f.ready = false;
    await r.poll(ROLL + 20);
    expect(r.a().status).toBe("rolled back");
    expect(r.logs.some((l) => l.startsWith(`${ID}: rolled back`) && l.includes("chat not connected (degraded)"))).toBe(true);
  });
  test("a rollback whose old version isn't live is gave up", async () => {
    const r = rig(); await failed(r); r.f.alive = false;
    await r.poll(ROLL);
    expect(r.a().status).toBe("gave up");
  });
});

describe("fix 2: a restore is sent again only after a proven pre-execution refusal", () => {
  const RJ = "backup_manager_partial_restore";
  const recorded = (r: ReturnType<typeof rig>) => { r.k.st.restoreJob = { name: RJ, attempt: "drill-1-cain-00000001", at: T0 }; };
  test("(0.1.4) a 4xx with no drill record of the restore job's name never resends: unresolved at once, paged", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 another job is running" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
    expect(r.a().why).toContain("no device drill has recorded a restore job's name yet");
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("is unresolved"))).toBe(true);
    expect(r.k.st.restoreJob).toBeUndefined();
  });
  test("(0.1.4) with the record and a clean jobs list: sent again once, then rolled back", async () => {
    const r = rig(); recorded(r); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 another job is running" });
    await failed(r); await r.poll(4 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
    expect(r.logs.some((l) => l.includes(`shows no ${RJ} job of backup kb-cain; the restore is tried again`))).toBe(true);
  });
  test("(0.1.4) with the record, a second 4xx after the resend is unresolved: at most one resend", async () => {
    const r = rig(); recorded(r);
    r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }, { kind: "refused", status: 400, retry: true, why: "400 y" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("unresolved");
    expect(r.a().why).toContain("sent again only once");
  });
  test("(0.1.4) with the record and an unrecognised restore-like job listed: no resend, unresolved at the limit", async () => {
    const r = rig(); recorded(r); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }); r.f.restoreJobsListed = { matching: 0, unclassified: 1 };
    await failed(r); await r.poll(LIMIT_POLLS + 2);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
    expect(r.a().why).toContain("can't classify");
  });
  test("(0.1.4) a drill's restore job, finished without errors with its backup as reference, records the name", async () => {
    const r = rig();
    await drillOf(r, headN(1), "verdict");
    expect(r.k.st.restoreJob?.name).toBe(RJ);
    expect(r.k.st.restoreJob?.attempt).toBe(idOf(headN(1), "drill"));
    const s = rig(); await failed(s); await s.poll(ROLL);
    expect(s.a().status).toBe("rolled back");
    expect(s.k.st.restoreJob).toBeUndefined();                  // a Ship rollback never records it
    const fresh = rig();
    expect(fresh.k.st.restoreJob).toBeUndefined();              // none on a fresh install
  });
  test("a 4xx with the jobs list showing a restore of that backup: unresolved, never sent again", async () => {
    const r = rig(); recorded(r); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }); r.f.restoreJobsListed = { matching: 1, unclassified: 0 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("a 4xx with the jobs list unreadable: never sent again; unresolved at the limit", async () => {
    const r = rig(); recorded(r); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }); r.f.restoreJobsListed = null;
    await failed(r); await r.poll(LIMIT_POLLS + 2);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("a 5xx after the Supervisor accepted the request stays unresolved and is never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "500 a server error, after which it may have run" });
    r.f.onRestore = () => {};
    await failed(r); await r.poll();
    expect(r.a().status).toBe("unresolved");
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("is unresolved"))).toBe(true);
    r.advance(3 * 3_600_000); await r.poll(2 * LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("a timeout is unresolved too, never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("a stop-then-start at the old version without a job result reports unresolved, not rolled back", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: null });
    await failed(r); await r.poll();
    r.f.app.state = "stopped"; await r.poll();
    r.f.app.version = "0.16.0"; r.f.app.state = "started"; await r.poll(ROLL);
    expect(r.a().status).toBe("unresolved");
    expect(r.a().why).toBe("the App came back at the old version (0.16.0) but the restore job's result is unknown");
    expect(r.pings.some((p) => p.body.includes("the App came back at the old version (0.16.0) but the restore job's result is unknown"))).toBe(true);
    expect(r.pings.some((p) => p.body.startsWith("Keeper rolled back"))).toBe(false);
    expect(r.restores.length).toBe(1);
  });
  test("the job by its id ended with errors: gave up, never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-e" }); r.f.jobs["job-e"] = { found: true, uuid: "job-e", done: true, errors: 1 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("gave up");
    expect(r.restores.length).toBe(1);
  });
  test("the job by its id still running, then finished: rolled back once, never sent twice", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-7" }); r.f.jobs["job-7"] = { found: true, uuid: "job-7", done: false, errors: 0 };
    await failed(r); await r.poll(4);
    expect(r.a().status).toBe("restoring");
    expect(r.saved!.attempts[ID].restore!.job).toBe("job-7");
    r.f.jobs["job-7"] = { found: true, uuid: "job-7", done: true, errors: 0 }; r.f.onRestore();
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.restores.length).toBe(1);
  });
  test("unresolved, then its job found finished without errors (after a restart): rolled back, with one follow-up line", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-9" }); r.f.jobs["job-9"] = { found: true, uuid: "job-9", done: false, errors: 0 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) }); r2.f.jobs["job-9"] = { found: true, uuid: "job-9", done: true, errors: 0 }; r2.f.onRestore();
    await r2.poll(ROLL);
    expect(r2.a().status).toBe("rolled back");
    expect(r2.restores).toEqual([]);
    expect(r2.pings.filter((p) => p.body.startsWith("Keeper rolled back Cain")).length).toBe(1);
  });
  test("a missing backup or a refused permission (401, 403, 404) is gave up, never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", status: 404, retry: false, why: "404 no such backup" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("gave up");
    expect(r.restores.length).toBe(1);
  });
  test("the restart-loop rule: started, then stopped or error, more than twice in the confirm window is gave up", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    expect(r.a().restore!.called).toBe(true);
    for (const st of ["started", "stopped", "started", "error", "started", "stopped"]) { r.f.app.state = st; await r.poll(); }
    expect(r.a().status).toBe("gave up");
  });
});

describe("the Healthchecks queue", () => {
  test("every rollback pages the phone: a fail ping when it starts, the success ping once confirmed", async () => {
    const r = rig(); await failed(r); await r.poll();
    const start = r.pings.findIndex((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.startsWith("Keeper is rolling back Cain from 0.17.0 to 0.16.0"));
    expect(start).toBeGreaterThanOrEqual(0);
    await r.poll(ROLL);
    const done = r.pings.findIndex((p) => p.url === "https://hc-ping.example/failed" && p.body.startsWith("Keeper rolled back Cain from 0.17.0 to 0.16.0"));
    expect(done).toBeGreaterThan(start);
  });
  test("the success ping waits for the rollback's fail ping", async () => {
    const r = rig(); await watching(r);
    r.f.pingOk = false; r.verdict("FAIL"); await r.poll(ROLL);
    expect(r.k.st.queue.map((q) => q.kind).filter((k) => !String(k).startsWith("key "))).toEqual(["rolling back", "rolled back"]);
    r.f.pingOk = true; r.advance(10 * 60_000); await r.poll();
    const lines = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/failed") && !p.url.endsWith("/log")).map((p) => p.url.endsWith("/fail") ? "fail" : "ok");
    expect(lines.slice(-2)).toEqual(["fail", "ok"]);
  });
  test("the heartbeat goes to hc_done every 5 minutes", async () => {
    const r = rig(); await r.poll(HC_HEARTBEAT_MS / POLL_MS * 2);
    expect(r.pings.filter((p) => p.body === "keeper heartbeat").length).toBe(2);
  });
});

describe("fix 3: alert checks per App, the dead-man check, and the phone test drill", () => {
  test("two Apps on one alert URL refuse arming with a plain line", () => {
    const r = rig({ opts: { watch: [CAIN, HARNESS], hc_failed: "https://hc-ping.example/failed" } });
    expect(r.k.armable()).toBe(false);
    expect(r.k.armableWhy()).toBe("Cain and Harness share one alert check; each watched App needs its own (hc_failed, slug=URL)");
    expect(r.logs).toContain("not armable: Cain and Harness share one alert check; each watched App needs its own (hc_failed, slug=URL)");
    const same = rig({ opts: { watch: [CAIN, HARNESS], hc_failed: [`${CAIN}=https://hc-ping.example/x`, `${HARNESS}=https://hc-ping.example/x`] } });
    expect(same.k.armable()).toBe(false);
    const own = rig({ opts: { watch: [CAIN, HARNESS], hc_failed: [`${CAIN}=https://hc-ping.example/c`, `${HARNESS}=https://hc-ping.example/h`] } });
    expect(own.k.armable()).toBe(true);
    expect(rig({ opts: { hc_failed: "https://hc-ping.example/one" } }).k.armable()).toBe(true);   // one App watched: one URL is its own
  });
  test("a shared alert check (if one slips through): one App's success ping waits while the other's incident is open", async () => {
    const r = rig({ opts: { watch: [CAIN, HARNESS], hc_failed: "https://hc-ping.example/failed" } });
    r.k.st.outstanding[HARNESS] = true;                    // Harness's incident is open on the same check
    r.k.owner(CAIN, "rolled back", "a Cain all clear", false); await r.poll(3);
    expect(r.pings.some((p) => p.body === "a Cain all clear")).toBe(false);
    expect(r.logs.filter((l) => l.includes(`a success ping for ${CAIN} waits: ${HARNESS} shares its alert check`)).length).toBe(1);
    delete r.k.st.outstanding[HARNESS]; await r.poll();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed" && p.body === "a Cain all clear")).toBe(true);
  });
  test("each App's own alert check: a success ping clears only its own", async () => {
    const r = rig({ opts: { hc_failed: [`${CAIN}=https://hc-ping.example/cain`, "https://hc-ping.example/rest"] } });
    await failed(r); await r.poll(ROLL);
    const cain = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/cain") && !p.url.endsWith("/log"));
    expect(cain.map((p) => p.url)).toEqual(["https://hc-ping.example/cain/fail", "https://hc-ping.example/cain"]);
  });
  test("the dead-man check pings from the keeper's own timer, and arming needs it delivered", async () => {
    const r = await armedRig();
    expect(r.pings.filter((p) => p.url === "https://hc-ping.example/deadman" && p.body === "keeper alive").length).toBeGreaterThan(0);
    r.f.pingFails = (u) => u.endsWith("/deadman");
    await r.poll(DELIVERY_MS / POLL_MS + 2);
    expect(r.k.armedView(CAIN).why).toContain("dead-man");
    r.f.pingFails = () => false; await r.poll();
    expect(r.k.armedView(CAIN).armed).toBe(true);
    const unset = rig({ opts: { hc_deadman: "" } });
    expect(unset.k.armableWhy()).toContain("hc_deadman");
  });
  test("the phone test drill: paged as a drill, confirmed by the owner, and lapsing after 60 days", async () => {
    const r = rig();
    await drillOf(r, headN(1), "verdict"); await drillOf(r, headN(2), "exit");
    expect(r.k.armedView(CAIN).why).toContain("phone test");
    expect(r.k.phoneConfirm().ok).toBe(false);                 // nothing delivered yet
    expect(r.k.phoneTest().ok).toBe(true);
    await r.poll();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.startsWith("Keeper phone test (a drill) for Cain"))).toBe(true);
    expect(r.k.phoneConfirm().ok).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(true);
    r.advance(ARMED_MAX_MS + 60_000);
    expect(r.k.armedView(CAIN).armed).toBe(false);
  });
  test("a phone test is refused while an incident is open, and a confirmation an hour late counts for nothing", async () => {
    const r = rig(); r.k.st.outstanding[CAIN] = true;
    expect(r.k.phoneTest().ok).toBe(false);
    const r2 = rig(); r2.k.phoneTest(); await r2.poll(); r2.advance(2 * 3_600_000);
    expect(r2.k.phoneConfirm().ok).toBe(false);
  });
});

// -- drills and the armed record ------------------------------------------------------------------
async function drillOf(r: ReturnType<typeof rig>, head: string, how: "verdict" | "exit") {
  r.f.app.version = "0.16.0"; r.f.app.state = "started";
  const ans = await r.register({ head, kind: "drill" });
  expect(ans.status).toBe(200);
  const id = idOf(head, "drill");
  await r.poll();
  r.install(how === "exit" ? "error" : "started"); await r.poll();
  if (how === "verdict") r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
  await r.poll(ROLL);
  expect(r.a(id).status).toBe("rolled back");
}
async function armedRig(opts?: any) {
  const r = rig({ opts });
  await drillOf(r, headN(1), "verdict"); await drillOf(r, headN(2), "exit");
  r.k.phoneTest(); await r.poll(); r.k.phoneConfirm();
  expect(r.k.armedView(CAIN).why).toBe("");
  return r;
}

describe("drills and the armed record", () => {
  test("both drills, the phone test and the checks delivered arm the App; /armed says so with its binding", async () => {
    const r = await armedRig();
    const v = r.k.armedView(CAIN);
    expect(v.armed).toBe(true);
    expect(v.binding).toEqual({ protocol: 1, probe_hash: HASH, keeper_version: "0.1.0", options_hash: optionsHash(parseOptions(r.f.options)), backup_scope: "app-only" });
  });
  test("an undelivered owner line records no drill; a ship attempt never does", async () => {
    const r = rig(); r.f.pingOk = false;
    await drillOf(r, headN(1), "verdict");
    expect(r.k.st.drills[CAIN]).toBeUndefined();
    const r2 = rig(); await failed(r2); await r2.poll(ROLL);
    expect(r2.k.drillRecord(ID).ok).toBe(false);
  });
  test("an options change, a new probe hash, 60 days or a rewind drop the armed record", async () => {
    let r = await armedRig(); r.f.options.health_grace_s = 60; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armedRig(); r.f.options.hc_failed = "https://hc-ping.example/failed2"; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armedRig(); await r.register({ head: headN(9), probe_hash: "ffffffffffffffff" }); await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armedRig(); r.advance(61 * 86_400_000); await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armedRig();
    const st = JSON.parse(JSON.stringify(r.k.st)); st.heartbeat = T0 - REWIND_MS - 60_000;
    const r2 = rig({ saved: st });
    expect(r2.k.armedView(CAIN).armed).toBe(false);
    expect(r2.logs.some((l) => l.includes("dropped"))).toBe(true);
  });
  test("a heartbeat outage reads as not armed and recovers by itself; a stuck fail ping disarms", async () => {
    const r = await armedRig();
    r.f.pingFails = (u) => u === "https://hc-ping.example/done";
    await r.poll(DELIVERY_MS / POLL_MS + 2);
    expect(r.k.armedView(CAIN).why).toContain("no heartbeat ping was delivered");
    r.f.pingFails = () => false; await r.poll(3);
    expect(r.k.armedView(CAIN).armed).toBe(true);
    r.f.pingFails = (u) => u.endsWith("/fail");
    r.k.owner(CAIN, "x", "a line", true); await r.poll(6);
    // (0.1.4) an undelivered page lapses the phone test first, and the stuck fail ping disarms too
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.logs.some((l) => l.startsWith("the phone test lapsed: a page (x) wasn't delivered"))).toBe(true);
    expect(r.k.st.queue.some((q) => q.fail && r.now - q.at > 2 * 60_000)).toBe(true);
  });
});

describe("options and the image", () => {
  test("re-read every poll: a change takes effect without a restart", async () => {
    const r = rig(); await r.poll();
    r.f.options.tokens = [`${CAIN}=another-token-0123456789`];
    await r.poll();
    expect(r.k.appOfToken(TOKEN)).toBeNull();
    expect(r.k.appOfToken("another-token-0123456789")).toBe(CAIN);
  });
  test("the version in config.yaml, the Dockerfile's KEEPER_VERSION and its label agree", () => {
    const dir = join(import.meta.dir, "..");
    const cfg = readFileSync(join(dir, "config.yaml"), "utf8").match(/^version: "([^"]+)"$/m)![1];
    const docker = readFileSync(join(dir, "Dockerfile"), "utf8");
    expect(docker).toContain(`ENV KEEPER_VERSION=${cfg}`);
    expect(docker).toContain(`io.hass.version="${cfg}"`);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toMatch(new RegExp(`^## ${cfg.replace(/\./g, "\\.")}$`, "m"));
  });
  test("its role is backup, never manager, and it has no Home Assistant API, ingress or /share", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^hassio_role: backup$/m);
    expect(cfg).toMatch(/^homeassistant_api: false$/m);
    expect(cfg).toMatch(/^ingress: false$/m);
    expect(cfg).not.toMatch(/^map:/m);
    expect(cfg).not.toMatch(/^ports:/m);
  });
  test("the health address: liveness is the host's /health; the path is readiness, reported only", () => {
    expect(healthUrl("0fcc2575-cain:8098/ready")).toBe("http://0fcc2575-cain:8098/ready");
    expect(liveUrl("0fcc2575-cain:8098/ready")).toBe("http://0fcc2575-cain:8098/health");
    expect(healthUrl("http://x:1/ready")).toBeNull();
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toContain(`- "0fcc2575_cain=0fcc2575-cain:8098/ready"`);
  });
  test("the HTTP service: an App's own token, the internal network only; the local routes only from inside", async () => {
    const r = rig(); await watching(r);
    const log: string[] = [];
    const call = (path: string, init: RequestInit = {}, ip = "172.30.33.4", token: string | null = TOKEN) =>
      handle(r.k, new Request(`http://keeper${path}`, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} }), ip, (m) => log.push(m));
    const v = await call("/verdict", { method: "POST", body: JSON.stringify({ app: CAIN, version: "0.17.0", attempt: ID, result: "PASS", reason: "" }) });
    expect(v.status).toBe(200);
    for (const p of ["/drill-record", "/phone-test", "/phone-confirm"]) expect((await call(p, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await call("/phone-test", { method: "POST", body: "{}" }, "127.0.0.1", null)).status).toBe(409);   // inside: answered (busy: an attempt is open)
    expect(internal("::ffff:172.30.32.7")).toBe(true);
    expect(internal("172.30.34.1")).toBe(false);
  });
});

describe("the Supervisor calls", () => {
  function fake(answers: Record<string, any>) {
    const calls: { method: string; path: string; body: any }[] = [];
    const http = async (url: string, init: RequestInit) => {
      const path = url.replace("http://supervisor", "");
      calls.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers[`${init.method} ${path}`];
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify(a ?? { result: "error", message: "no" }), { status: a?.status ?? (a ? 200 : 400) });
    };
    return { calls, sup: supervisor("t", "http://supervisor", http) };
  }
  test("the restore: its job id; a 4xx is a refusal; a 5xx, no answer or a 2xx non-result is unknown", async () => {
    let f = fake({ "POST /backups/b1/restore/partial": { result: "ok", data: { job_id: "abc" } } });
    expect(await f.sup.restore("b1", CAIN)).toEqual({ kind: "started", job: "abc" });
    expect(f.calls[0].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true });
    f = fake({});
    expect(await f.sup.restore("b1", CAIN)).toMatchObject({ kind: "refused", status: 400, retry: true });
    f = fake({ "POST /backups/b1/restore/partial": { result: "error", message: "gone", status: 404 } });
    expect(await f.sup.restore("b1", CAIN)).toMatchObject({ kind: "refused", status: 404, retry: false });
    f = fake({ "POST /backups/b1/restore/partial": { result: "error", message: "boom", status: 500 } });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
    f = fake({ "POST /backups/b1/restore/partial": new Error("timeout") });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
    f = fake({ "POST /backups/b1/restore/partial": { result: "weird" } });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
  });
  test("restore jobs for a backup are counted from /jobs/info, child jobs included; the job by id only for its result", async () => {
    const jobs = [{ name: "backup_manager_partial_restore", reference: "b1", uuid: "u1", done: false, errors: [], child_jobs: [
      { name: "addon_restore", reference: "b1", uuid: "u2", done: true, errors: [{ message: "e" }], child_jobs: [] }] },
      { name: "backup_manager_partial_backup", reference: "b2", uuid: "u3", done: true, errors: [], child_jobs: [] }];
    const f = fake({ "GET /jobs/info": { result: "ok", data: { jobs } } });
    const RJ = "backup_manager_partial_restore";
    // (0.1.4) against the recorded name: exactly that name for the backup matches; a restore-like name it
    // doesn't know (addon_restore) can't be classified; other work (a backup) is ignored
    expect(await f.sup.restoreJobs("b1", RJ)).toEqual({ matching: 1, unclassified: 1 });
    expect(await f.sup.restoreJobs("b2", RJ)).toEqual({ matching: 0, unclassified: 1 });
    const clean = fake({ "GET /jobs/info": { result: "ok", data: { jobs: [jobs[1]] } } });
    expect(await clean.sup.restoreJobs("b1", RJ)).toEqual({ matching: 0, unclassified: 0 });
    const noname = fake({ "GET /jobs/info": { result: "ok", data: { jobs: [{ uuid: "x", done: false, errors: [], child_jobs: [] }] } } });
    expect(await noname.sup.restoreJobs("b1", RJ)).toEqual({ matching: 0, unclassified: 1 });
    expect(await f.sup.job("u2")).toEqual({ found: true, uuid: "u2", done: true, errors: 1, name: "addon_restore", reference: "b1" });
    expect(await f.sup.job("u-other")).toEqual({ found: false });
    expect(await fake({}).sup.restoreJobs("b1", RJ)).toBeNull();
  });
  test("its own backup: partial, that App alone, no password, background false", async () => {
    const f = fake({ "POST /backups/new/partial": { result: "ok", data: { slug: "kb9" } } });
    expect(await f.sup.makeBackup(CAIN, "Keeper x")).toEqual({ slug: "kb9" });
    expect(f.calls[0].body).toEqual({ name: "Keeper x", addons: [CAIN], homeassistant: false, folders: [], background: false });
    expect("why" in (await fake({}).sup.makeBackup(CAIN, "x"))).toBe(true);
  });
  test("its own options are only read", async () => {
    const options = { watch: [CAIN] };
    const f = fake({ "GET /addons/self/info": { result: "ok", data: { slug: "k", options } } });
    expect(await f.sup.selfOptions()).toEqual(options);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

// -- the fourth review (0.1.4) ---------------------------------------------------------------------
describe("0.1.4: the acceptance is single use", () => {
  test("consumed when to_version is first seen; the same version installed again later is an unregistered change", async () => {
    const r = rig(); await failed(r); await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.a().consumedAt).toBeGreaterThan(0);
    expect(r.logs.filter((l) => l.startsWith(`consumed ${ID}:`)).length).toBe(1);
    r.install(); await r.poll();
    expect(r.logs).toContain(`unregistered change ${CAIN} 0.16.0 to 0.17.0: no attempt was registered for it, so nothing is restored`);
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("with no install registered with Keeper"))).toBe(true);
    expect(r.restores.length).toBe(1);
    const again = await r.register();
    expect(again.status).toBe(409);
    expect(String(again.body.why)).toContain("a replay");
  });
  test("an install seen before the acceptance (the backup still running) is unprotected, never covered", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    const p = r.register();
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    r.install(); await r.poll();
    expect(r.a().status).toBe("unprotected");
    expect(r.a().why).toBe("the install began before Keeper accepted it (its backup wasn't complete)");
    finish({ slug: "kb-late" });
    const ans = await p;
    expect(ans.status).toBe(409);
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    r.f.app.state = "error"; await r.poll(5);
    expect(r.restores).toEqual([]);
  });
});

describe("0.1.4: the Ship key is pinned on first use", () => {
  const { privateKey: NEW, publicKey: NEW_PUB } = generateKeyPairSync("ed25519");
  const NPUB = NEW_PUB.export({ format: "der", type: "spki" }).toString("base64");
  test("the first key seen is pinned, logged with its fingerprint and paged once", async () => {
    const r = rig(); await r.poll();
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(PUB));
    expect(r.logs.some((l) => l.startsWith(`pinned the Ship public key, fingerprint ${keyFp(PUB)}`))).toBe(true);
    expect(r.pings.filter((p) => p.url.endsWith("/failed/fail") && p.body.includes(`pinned Cain's link's Ship key, fingerprint ${keyFp(PUB)}`)).length).toBe(1);
    expect(r.k.st.outstanding).toEqual({});
    await r.poll(3);
    expect(r.pings.filter((p) => p.body.includes("pinned Cain's link's Ship key")).length).toBe(1);
  });
  test("changing ordinary options and the key option together can't replace the pinned key; key-confirm does", async () => {
    const r = rig(); await r.poll();
    r.f.options.ship_public_key = NPUB; r.f.options.tokens = [`${CAIN}=${TOKEN}`]; r.f.options.health_grace_s = 30; await r.poll();
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(PUB));
    expect(r.logs.some((l) => l.includes(`ship_public_key changed to a key with fingerprint ${keyFp(NPUB)}`))).toBe(true);
    expect(r.pings.filter((p) => p.body.includes("Ship key option changed")).length).toBe(1);
    // a registration signed with the new key is refused until the owner confirms it; so is one with the old
    const signedNew = await r.register({ token: shipToken({ key: NEW, now: r.now }) });
    expect(signedNew.status).toBe(409);
    expect(String(signedNew.body.why)).toContain(`isn't the key Keeper pinned (fingerprint ${keyFp(PUB)})`);
    expect((await r.register({ head: headN(3) })).status).toBe(409);
    expect(r.k.keyConfirm("0000000000000000")).toEqual({ ok: false, why: `that fingerprint isn't the options' key's (${keyFp(NPUB)})` });
    expect(r.k.keyConfirm(keyFp(NPUB)).ok).toBe(true);
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(NPUB));
    expect((await r.register({ head: headN(4), token: shipToken({ key: NEW, head: headN(4), now: r.now }) })).status).toBe(200);
  });
  test("key-confirm only from inside the container", async () => {
    const r = rig();
    const log: string[] = [];
    const req = () => new Request("http://keeper/key-confirm", { method: "POST", body: JSON.stringify({ fingerprint: keyFp(PUB) }) });
    expect((await handle(r.k, req(), "172.30.33.4", (m) => log.push(m))).status).toBe(403);
    expect((await handle(r.k, req(), "127.0.0.1", (m) => log.push(m))).status).toBe(200);
  });
  test("a token issued before the keeper's state was created is refused (a fresh or rewound state)", async () => {
    const r = rig();
    const ans = await r.register({ token: shipToken({ now: T0 - 60_000 }) });
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toContain("issued before Keeper's state was created");
    expect(r.k.st.createdAt).toBe(T0);
    const st = JSON.parse(JSON.stringify(r.k.st)); st.heartbeat = T0 - REWIND_MS - 60_000; st.createdAt = T0 - 86_400_000;
    const r2 = rig({ saved: st });
    expect(r2.k.st.createdAt).toBe(T0);
  });
});

describe("0.1.4: the alert gate", () => {
  test("checks are told apart by the check id in the ping URL's path, not the whole URL", () => {
    const U = "0f3a1c2e-1111-4222-8333-944455556666";
    expect(checkId(`https://hc-ping.com/${U}`)).toBe(U);
    expect(checkId(`https://HC-PING.com/${U.toUpperCase()}/?x=1`)).toBe(U);
    expect(checkId("https://hc-ping.com/pingkey/keeper-cain")).toBe("keeper-cain");
    expect(checkId(`https://hc-ping.com/${U}/fail`)).toBe("");
    const same = rig({ opts: { watch: [CAIN, HARNESS], hc_failed: [`${CAIN}=https://hc-ping.com/${U}`, `${HARNESS}=https://hc-ping.io/${U}/`] } });
    expect(same.k.armableWhy()).toBe("Cain and Harness share one alert check; each watched App needs its own (hc_failed, slug=URL)");
    const dm = rig({ opts: { hc_deadman: `https://hc-ping.com/${U}`, hc_failed: `https://hc-ping.com/${U}/` } });
    expect(dm.k.armableWhy()).toBe("hc_deadman and Cain's alert check are the same Healthchecks check; each needs its own");
    const fail = rig({ opts: { hc_failed: `https://hc-ping.com/${U}/fail` } });
    expect(fail.k.armableWhy()).toContain("isn't a Healthchecks ping URL");
  });
  test("the dead-man ping goes only while the poll loop completes; a frozen loop sends its /fail ping", async () => {
    const r = await armedRig();
    const before = r.pings.length;
    r.advance(LOOP_FRESH_MS + 30_000);
    expect(await r.k.deadman()).toBe(false);
    const sent = r.pings.slice(before);
    expect(sent.some((p) => p.url === "https://hc-ping.example/deadman" && p.body === "keeper alive")).toBe(false);
    expect(sent.some((p) => p.url === "https://hc-ping.example/deadman/fail" && p.body.includes("poll loop hasn't completed for 4 minutes"))).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.armedView(CAIN).why).toContain("poll loop");
    await r.poll();
    expect(r.pings.at(-1)).toEqual({ url: "https://hc-ping.example/deadman", body: "keeper alive" });
  });
  test("the phone test pages the dead-man check too, and arming needs both confirmed", async () => {
    const r = rig();
    await drillOf(r, headN(1), "verdict"); await drillOf(r, headN(2), "exit");
    r.f.pingFails = (u) => u === "https://hc-ping.example/deadman/fail";
    r.k.phoneTest(); await r.poll();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.startsWith("Keeper phone test (a drill) for Cain"))).toBe(true);
    // the dead-man page wasn't delivered: the phone test lapsed, and arming stays closed
    expect(r.logs.some((l) => l.startsWith("the phone test lapsed: a page (phone test) wasn't delivered"))).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(false);
    r.f.pingFails = () => false;
    r.advance(10 * 60_000); r.k.phoneTest(); await r.poll(); r.k.phoneConfirm();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/deadman/fail" && p.body.includes("phone test (a drill) of its dead-man check"))).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("the phone test lapses after 30 days, on any Healthchecks option change, and on any undelivered page", async () => {
    let r = await armedRig();
    r.advance(PHONE_MAX_MS + 60_000); await r.poll();
    expect(r.k.armedView(CAIN).why).toContain("phone test");
    r = await armedRig();
    r.f.options.hc_done = "https://hc-ping.example/done2"; await r.poll();
    expect(r.logs).toContain("the phone test lapsed: a Healthchecks option changed; arming needs a new one (phone-test, then phone-confirm)");
    r.f.options.hc_done = "https://hc-ping.example/done"; await r.poll();
    expect([r.k.st.phone, r.k.st.phoneHc]).toEqual([{}, undefined]);   // putting it back doesn't bring the old test back
    r = await armedRig();
    r.f.pingFails = (u) => u.endsWith("/fail");
    r.k.owner(CAIN, "unprotected", "a page", true); await r.poll();
    expect(r.k.st.phone).toEqual({});
    r.f.pingFails = () => false; await r.poll(3);
    expect(r.k.armedView(CAIN).why).toContain("phone test");
  });
});

describe("0.1.4: the degraded page", () => {
  test("chat down for a few polls only: passed, no page; down for most of the window: paged, nothing restored", async () => {
    const r = rig();
    await watching(r); r.verdict("PASS");
    r.f.ready = false; await r.poll(5); r.f.ready = true;
    await r.poll(20 * 60_000 / POLL_MS);
    expect(r.a().status).toBe("passed");
    expect(r.k.st.last[CAIN].kind).toBe("passed");
    expect(r.pings.some((p) => p.body.includes("chat wasn't connected for most of it"))).toBe(false);
  });
});
