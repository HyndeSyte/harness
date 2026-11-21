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
import { CONFIRM_MS, DELIVERY_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, RESTORE_LIMIT_MS, REWIND_MS, WATCH_MS, ARMED_MAX_MS, optionsHash, parseOptions, readShipToken, shipKey,
  type AppInfo, type BackupInfo, type JobState, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
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
    jobs: {} as Record<string, JobState>, jobsUp: true, restoreJobsListed: 0 as number | null,
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
    backupInfo: async () => f.backup,
    makeBackup: async (a) => { backupsMade.push(a); return f.makeBackup(a); },
    restore: async (backup, a) => {
      restores.push({ backup, app: a });
      const r = f.restoreQueue.shift();
      if (r) return r;
      const id = `job-${restores.length}`;
      f.jobs[id] = { found: true, uuid: id, done: true, errors: 0 };
      f.onRestore();
      return { kind: "started", job: id };
    },
    job: async (uuid) => { jobCalls.push(uuid); return f.jobsUp ? f.jobs[uuid] ?? { found: false } : null; },
    restoreJobs: async () => f.restoreJobsListed,
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
    // A registration as Cain's link sends it (POST /attempt), with a backup the caller names unless
    // backup_slug is null (then the keeper makes its own).
    async register(over: any = {}, caller: string | null = CAIN) {
      const head = over.head ?? HEAD;
      const body: any = { token: shipToken({ head, now }), app: CAIN, pr: 46, head, from_version: "0.16.0", to_version: "0.17.0",
        probe_hash: HASH, kind: "ship", backup_slug: "b1234567", ...over };
      if (body.backup_slug === null) delete body.backup_slug;
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
    expect(ans.status).toBe(202);
    expect(ans.body.id).toBe(ID);
    expect(r.a().status).toBe("accepted");
    expect(r.logs).toContain(`accepting ${ID} ${CAIN} 0.16.0 to 0.17.0 backup b1234567`);
    await r.poll(3);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
  });
  test("a replay of the same token for the same App is refused, and reported", async () => {
    const r = rig();
    const token = shipToken();
    const body = { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, backup_slug: "b1234567" };
    expect((await r.k.registerAttempt(CAIN, body)).status).toBe(202);
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
    await r.k.registerAttempt(CAIN, { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, backup_slug: "b1234567" });
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
  const body = (over: any = {}) => JSON.stringify({ token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, backup_slug: "b1234567", ...over });
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
    expect(ok.status).toBe(202);
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
  test("the keeper makes the App-only backup itself when no backup_slug comes, once, then accepts", async () => {
    const r = rig({ backup: { addons: [{ slug: CAIN, version: "0.16.0" }] } });
    const ans = await r.register({ backup_slug: null });
    expect(ans.status).toBe(202);
    await Promise.resolve(); await r.poll(2);
    expect(r.backupsMade).toEqual([CAIN]);
    expect(r.a().backup).toBe("kb-cain");
    expect(r.a().status).toBe("accepted");
  });
  test("its own backup: the App at another version, a failed backup, or a restart while making it: unprotected", async () => {
    const r = rig(); r.f.app.version = "0.15.0";
    await r.register({ backup_slug: null });
    expect(r.a().status).toBe("unprotected");
    expect(r.backupsMade).toEqual([]);
    const r2 = rig(); r2.f.makeBackup = async () => ({ why: "400 busy" });
    await r2.register({ backup_slug: null }); await r2.poll(2);
    expect(r2.a().status).toBe("unprotected");
    expect(r2.a().why).toContain("400 busy");
    const r3 = rig(); r3.f.makeBackup = () => new Promise(() => {});
    await r3.register({ backup_slug: null });
    const r4 = rig({ saved: JSON.parse(JSON.stringify(r3.k.st)) });
    await r4.poll();
    expect(r4.a().status).toBe("unprotected");
    expect(r4.a().why).toContain("restarted while it made the backup");
    expect(r4.backupsMade).toEqual([]);
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
      if (path === "/backups/kb1/info") return ok({ homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: false });
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
    expect(r.restores).toEqual([{ backup: "b1234567", app: CAIN }]);
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
    expect(r.k.st.last[CAIN].line).toContain("chat not connected (degraded)");
    expect(r.logs).toContain(`${CAIN}: chat not connected (degraded)`);
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
  test("a 4xx with the jobs list showing no restore of that backup: sent again, then rolled back", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 another job is running" });
    await failed(r); await r.poll(4 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
    expect(r.logs.some((l) => l.includes("shows no restore of backup b1234567; the restore is tried again"))).toBe(true);
  });
  test("a 4xx with the jobs list showing a restore of that backup: unresolved, never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }); r.f.restoreJobsListed = 1;
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("a 4xx with the jobs list unreadable: never sent again; unresolved at the limit", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 x" }); r.f.restoreJobsListed = null;
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
    expect(r.k.st.queue.map((q) => q.kind)).toEqual(["rolling back", "rolled back"]);
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
  expect(ans.status).toBe(202);
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
    expect(r.k.armedView(CAIN).why).toContain("waited undelivered");
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
    expect(await f.sup.restoreJobs("b1")).toBe(2);
    expect(await f.sup.restoreJobs("b2")).toBe(0);
    expect(await f.sup.job("u2")).toEqual({ found: true, uuid: "u2", done: true, errors: 1 });
    expect(await f.sup.job("u-other")).toEqual({ found: false });
    expect(await fake({}).sup.restoreJobs("b1")).toBeNull();
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
