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
  ACCEPT_MS, CLAIM_MS, PAGE_ACK_MS, HC_READ_MS, judgeHc, HC_RW_WHY, KEY_CODE_MS, MHB_MAX_MS, MHB_CAP_MS, LIMITS_VERSION, PHONE_WINDOW_MS, DROP_TRIES,
  type AppInfo, type BackupInfo, type HcCheck, type JobState, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
import { hcChecks, healthUrl, liveUrl } from "../rootfs/opt/keeper/main.ts";
import { supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { handle, handleLocal, internal } from "../rootfs/opt/keeper/server.ts";

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

// (0.1.5) A Healthchecks account as its management API lists it: every check the options name, within
// bounds, each with a channel, unless a test overrides one (by its check id).
function hcList(opts: any, over: Record<string, Partial<HcCheck> | null>): HcCheck[] {
  const o = parseOptions(opts);
  const out: HcCheck[] = [];
  const add = (url: string, c: Partial<HcCheck>) => {
    const id = checkId(url);
    const uuid = /^[0-9a-f-]{36}$/.test(id);
    const key = uuid ? new Bun.CryptoHasher("sha1").update(id).digest("hex") : "";
    if (!id || out.some((x) => x.slug === id || (uuid && x.unique_key === key))) return;
    if (over[id] === null) return;
    out.push({ ...(uuid ? { unique_key: key } : { slug: id }), status: "up", channels: "ch-phone", ...c, ...(over[id] ?? {}) });
  };
  add(o.hc_done, { timeout: 300, grace: 600 });
  add(o.hc_deadman, { timeout: 60, grace: 300 });
  for (const u of Object.values(o.hc_failed)) add(u, { timeout: 86_400, grace: 3600 });
  return out;
}

function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null; confirm?: boolean; hcKey?: string; limits?: boolean } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string }[] = [];
  const backupsMade: string[] = [];
  const jobCalls: string[] = [];
  const deleted: string[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    saveFails: false, deleteOk: true,
    // (0.1.7) the kept Healthchecks key (a file on the device), the backups list and the active install jobs
    hcKey: o.hcKey ?? "hc-read-key-0123456789", hcKeyWrites: 0, hcKeyWriteOk: true,
    backupsList: [] as { slug: string; name: string }[] | null, activeJobs: [] as string[] | null,
    app, alive: true, ready: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
    jobs: {} as Record<string, JobState>, jobsUp: true,
    hcUp: true, hcOver: {} as Record<string, Partial<HcCheck> | null>, hcReads: 0,
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
    deleteBackup: async (b) => { deleted.push(b); return f.deleteOk; },
    backups: async () => f.backupsList,
    activeJobs: async () => f.activeJobs,
    hcKeyStore: { load: () => f.hcKey, store: (key) => { f.hcKeyWrites++; if (!f.hcKeyWriteOk) return false; f.hcKey = key; return true; } },
    job: async (uuid) => { jobCalls.push(uuid); return f.jobsUp ? f.jobs[uuid] ?? { found: false } : null; },
    hcChecks: async () => { f.hcReads++; return f.hcUp ? hcList(f.options, f.hcOver) : null; },
    timer: (ms) => f.timer(ms),
    live: async () => f.alive,
    ready: async () => f.ready,
    ping: async (url, body) => { pings.push({ url, body }); return !f.pingFails(url); },
    options: () => JSON.parse(JSON.stringify(f.options)),
    save: (s) => { if (f.saveFails) return false; saved = JSON.parse(JSON.stringify(s)); return true; },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.useOptions(f.options);
  k.start();
  // (0.1.5) the owner's enrollment of the pinned key at the device, as at first setup
  if (o.confirm !== false && shipKey(k.opts.ship_public_key)) k.keyConfirm(keyFp(k.opts.ship_public_key), codeIn(logs, "key-confirm"));
  // (0.1.7) the owner's acceptance of the accepted limits, as at first setup
  if (o.limits !== false) k.acceptLimits(codeIn(logs, "accept-limits"));
  const r = {
    k, f, logs, pings, restores, backupsMade, jobCalls, deleted, get saved() { return saved; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    // A registration as Cain's link sends it (POST /attempt, 202), then its poll (GET /attempt/<id>) once
    // the background backup settled (0.1.5): 200 with the acceptance, or 409 with the refusal.
    async register(over: any = {}, caller: string | null = CAIN) {
      const head = over.head ?? HEAD;
      const body: any = { token: shipToken({ head, now }), app: CAIN, pr: 46, head, from_version: "0.16.0", to_version: "0.17.0",
        probe_hash: HASH, kind: "ship", ...over };
      const ans = await k.registerAttempt(caller, body);
      if (ans.status !== 202) return ans;
      await k.whenSettled(String(ans.body.id));
      const v = k.attemptView(CAIN, String(ans.body.id));
      return { status: v.body.status === "accepted" ? 200 : 409, body: v.body };
    },
    // (0.1.5) The link's claim of an accepted attempt, as the Ship run starts.
    claim(id = ID, over: any = {}) {
      const a = k.st.attempts[id];
      return k.claimAttempt(CAIN, id, { app: a?.app, from_version: a?.from, to_version: a?.to, backup: a?.backup, ...over });
    },
    async poll(n = 1) { for (let i = 0; i < n; i++) { await k.poll(); await k.deadman(); now += POLL_MS; } },
    // The install, claimed first by the link as the Ship run starts (claim false: an install with no claim).
    install(state = "started", claim = true) {
      if (claim) for (const a of k.open(CAIN)) if (a.status === "accepted") r.claim(a.id);
      app.version = "0.17.0"; app.state = state;
    },
    verdict(result: "PASS" | "FAIL", over: any = {}) { return k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: ID, result, reason: result === "FAIL" ? "no answer" : "", ...over }); },
    a(id = ID) { return k.st.attempts[id]; },
    // (0.1.6) the newest one-time code Keeper printed in its log for that command
    code(cmd: "key-confirm" | "phone-confirm" | "missed-heartbeat-confirm") { return codeIn(logs, cmd); },
    // (0.1.6) the owner's phone-confirm, naming every watched App's alert check and the dead-man check
    phoneConfirm(names?: string[]) { return k.phoneConfirm(codeIn(logs, "phone-confirm"), names ?? [...k.opts.watch.map((x) => x.replace(/^[0-9a-f]{8}_/, "")), "deadman"]); },
    // (0.1.6) the missed-heartbeat drill run whole: Healthchecks shows the heartbeat check down during the
    // silence, the ping resumes, it is up again, and the owner confirms
    // 0.1.7: the silence lasts until Healthchecks shows it down; then up again after the ping resumes
    async heartbeatDrill(confirm = true) {
      await k.refreshHc();
      const s = k.missedHeartbeat(); if (!s.ok) return s;
      await r.poll(20);                                     // ten minutes of silence
      const was = f.hcOver.done;
      f.hcOver.done = { ...(was ?? {}), status: "down" };
      r.advance(HC_READ_MS);
      while (!k.st.mhb?.resumedAt) await r.poll();
      if (was === undefined) delete f.hcOver.done; else f.hcOver.done = was;
      r.advance(HC_READ_MS); await r.poll();
      return confirm ? k.missedHeartbeatConfirm(codeIn(logs, "missed-heartbeat-confirm")) : { ok: true, why: "" };
    },
  };
  return r;
}
function codeIn(logs: string[], cmd: string): string {
  for (let i = logs.length - 1; i >= 0; i--) { const m = new RegExp(`^one-time code for ${cmd}: ([0-9a-f]+) `).exec(logs[i]); if (m) return m[1]; }
  return "";
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
    expect(r.logs).toContain(`accepting ${ID} ${CAIN} 0.16.0 to 0.17.0 backup kb-cain until ${new Date(T0 + ACCEPT_MS).toISOString()}`);
    await r.poll(3);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
  });
  test("a replay of the same token for the same App is refused, and reported", async () => {
    const r = rig();
    const token = shipToken();
    const body = { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH };
    expect((await r.k.registerAttempt(CAIN, body)).status).toBe(202);
    await r.k.whenSettled(ID);
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
    ["a token with its signature changed", { token: ((t) => t.slice(0, -10) + (t.at(-10) === "A" ? "B" : "A") + t.slice(-9))(shipToken()) }, "signature doesn't verify"],
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
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as any)).toMatchObject({ status: "pending", id: ID });
    await r.k.whenSettled(ID);
    expect(r.a().status).toBe("accepted");
    const polled = await (await call(r, `/attempt/${ID}`)).json() as any;
    expect(polled).toMatchObject({ status: "accepted", id: ID, backup: "kb-cain", key_fp: keyFp(PUB) });
    expect((await call(r, `/attempt/${ID}`, {}, "172.30.33.4", HTOKEN)).status).toBe(403);   // only Cain's link reads it
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
  test("(0.1.5) register-then-poll: POST /attempt answers 202 at once; the poll reads pending until the backup is verified, then accepted with its slug", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    const ans = await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, kind: "ship" });
    expect([ans.status, ans.body.status, ans.body.id]).toEqual([202, "pending", ID]);
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    expect(r.k.attemptView(CAIN, ID).body.status).toBe("pending");
    expect(r.a().status).toBe("verifying");
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    finish({ slug: "kb-late" }); await r.k.whenSettled(ID);
    const v = r.k.attemptView(CAIN, ID);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ status: "accepted", id: ID, app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb-late", until: new Date(T0 + ACCEPT_MS).toISOString(),
      key_fp: keyFp(PUB), key_confirmed_at: new Date(T0).toISOString(), state_created: new Date(T0).toISOString(),
      enroll_id: r.k.st.pinnedKey!.enrollId, counter: r.k.st.counter });
    expect(v.body.enroll_id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.backupsMade).toEqual([CAIN]);
    expect(r.k.attemptView(CAIN, "ship-1-cain-00000000").status).toBe(404);
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
    const klogs: string[] = [];
    const k = new Keeper({ now: () => now, version: "0.1.3", self: "0fcc2575_keeper", appInfo: sup.appInfo, backupInfo: sup.backupInfo, makeBackup: sup.makeBackup,
      restore: sup.restore, job: sup.job, live: async () => true, ready: async () => true, ping: async () => true,
      options: () => sup.selfOptions(), save: () => {}, log: (l) => klogs.push(l) }, null);
    k.useOptions(options); k.start(); k.keyConfirm(keyFp(PUB), codeIn(klogs, "key-confirm"));
    const poll = async (n: number) => { for (let i = 0; i < n; i++) { await k.poll(); now += POLL_MS; } };
    await k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    await k.whenSettled(ID);
    await poll(2); expect(k.st.attempts[ID].status).toBe("accepted");
    expect(k.claimAttempt(CAIN, ID, { app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb1" }).status).toBe(200);
    app.version = "0.17.0"; await poll(1);
    k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: ID, result: "FAIL", reason: "x" });
    await poll(ROLL);
    expect(k.st.attempts[ID].status).toBe("rolled back");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /backups/new/partial", "POST /backups/kb1/restore/partial"]);
    expect(writes[0].body).toEqual({ name: k.st.attempts[ID].backupName, addons: [CAIN], homeassistant: false, folders: [], background: false });
    expect(k.st.attempts[ID].backupName).toMatch(new RegExp(`^Keeper ${ID} [0-9a-f]{8}$`));   // (0.1.7) attempt-specific
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
  test("(0.1.5) the install never starting (still the old version when its claim expires) restores nothing, ends, and the owner hears", async () => {
    const r = rig(); await r.register(); await r.poll();
    expect(r.claim().status).toBe(200);
    r.advance(CLAIM_MS + 60_000); await r.poll();
    expect(r.a().status).toBe("ended");
    expect(r.logs.some((l) => /^ship-46-cain-\w+: ended \(its claim claim-[0-9a-f]{16} expired with no version change seen \(unused\)\)$/.test(l))).toBe(true);
    expect(r.restores).toEqual([]);
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("ended: its claim"))).toBe(true);
    expect(r.k.st.outstanding).toEqual({});              // a notice: no incident left open
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

describe("fix 2 (0.1.5): a restore is called once, never again, whatever the answer", () => {
  for (const [name, res] of [
    ["a 400 (busy)", { kind: "refused", status: 400, retry: true, why: "400 another job is running" }],
    ["a 409", { kind: "refused", status: 409, retry: true, why: "409 conflict" }],
    ["a 404 (no such backup)", { kind: "refused", status: 404, retry: false, why: "404 no such backup" }],
    ["a 403", { kind: "refused", status: 403, retry: false, why: "403 forbidden" }],
    ["a 500", { kind: "unknown", why: "500 a server error, after which it may have run" }],
    ["a timeout", { kind: "unknown", why: "TimeoutError" }],
  ] as const) {
    test(`${name}: unresolved, fenced, paged, and never sent again however long it runs`, async () => {
      const r = rig(); r.f.restoreQueue.push(res as RestoreResult); r.f.onRestore = () => {};
      await failed(r); await r.poll(LIMIT_POLLS);
      expect(r.a().status).toBe("unresolved");
      expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("is unresolved"))).toBe(true);
      r.advance(6 * 3_600_000); await r.poll(2 * LIMIT_POLLS);
      const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) }); await r2.poll(LIMIT_POLLS);   // across a restart too
      expect([r.restores.length, r2.restores.length, r2.a().status]).toEqual([1, 0, "unresolved"]);
      if (res.kind === "refused") expect(r.a().why).toContain("sends a restore once and never again");
    });
  }
  test("a 4xx with a restore job listed for the backup, or a drill's record of the job name: still no second call", async () => {
    const r = rig();
    await drillOf(r, headN(1), "verdict");
    expect(r.k.st.restoreJob?.name).toBe("backup_manager_partial_restore");
    r.f.restoreQueue.push({ kind: "refused", status: 400, retry: true, why: "400 busy" });
    r.f.jobs["other"] = { found: true, uuid: "other", done: true, errors: 0, name: "backup_manager_partial_restore", reference: "kb-cain" };
    const before = r.restores.length;
    await r.register({ head: headN(5) }); await r.poll(); r.install(); await r.poll();
    r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: idOf(headN(5)), result: "FAIL", reason: "x" });
    await r.poll(2 * LIMIT_POLLS);
    expect(r.restores.length - before).toBe(1);
    expect(r.a(idOf(headN(5))).status).toBe("unresolved");
  });
  test("the drill records its own restore job's name and how long it stays listed, by the job id its call returned only", async () => {
    const r = rig();
    await drillOf(r, headN(1), "verdict");
    const rj = r.k.st.restoreJob!;
    expect([rj.name, rj.job, rj.attempt, rj.reference]).toEqual(["backup_manager_partial_restore", "job-1", idOf(headN(1), "drill"), "kb-cain"]);
    expect(rj.listedMs).toBeUndefined();
    r.advance(20 * 60_000); delete r.f.jobs["job-1"]; await r.poll();
    expect(r.k.st.restoreJob!.listedMs).toBeGreaterThanOrEqual(20 * 60_000);
    expect(r.logs.some((l) => l.includes("left the jobs list about") && l.includes("recorded only"))).toBe(true);
    // a job with the drill's backup as reference but another id is never taken for it
    const m = rig(); m.f.restoreQueue.push({ kind: "started", job: "mine" });
    m.f.jobs["mine"] = { found: true, uuid: "mine", done: false, errors: 0 };
    m.f.jobs["theirs"] = { found: true, uuid: "theirs", done: true, errors: 0, name: "lookalike", reference: "kb-cain" };
    await m.register({ head: headN(1), kind: "drill" }); await m.poll(); m.install(); await m.poll();
    m.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: idOf(headN(1), "drill"), result: "FAIL", reason: "d" }); await m.poll(3);
    expect(m.k.st.restoreJob).toBeUndefined();
    // a Ship rollback never records it, and a fresh install has none
    const s = rig(); await failed(s); await s.poll(ROLL);
    expect(s.a().status).toBe("rolled back");
    expect(s.k.st.restoreJob).toBeUndefined();
  });
  test("no code path sends a restore twice: the resend paths are gone", () => {
    const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "core.ts"), "utf8");
    expect(/afterRefusal|restoreJobs|\bresent\b|private again\(/.test(src)).toBe(false);
    expect(readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "supervisor.ts"), "utf8")).not.toContain("restoreJobs");
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
    expect(r.phoneConfirm().ok).toBe(false);                 // nothing delivered yet
    expect(r.k.phoneTest().ok).toBe(true);
    await r.poll();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.startsWith("Keeper phone test (a drill) for Cain"))).toBe(true);
    expect(r.phoneConfirm().ok).toBe(true);
    expect(r.k.armedView(CAIN).why).toContain("missed-heartbeat drill");   // (0.1.6) the drill too
    expect((await r.heartbeatDrill()).ok).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(true);
    r.advance(ARMED_MAX_MS + 60_000);
    expect(r.k.armedView(CAIN).armed).toBe(false);
  });
  test("a phone test is refused while an incident is open, and a confirmation an hour late counts for nothing", async () => {
    const r = rig(); r.k.st.outstanding[CAIN] = true;
    expect(r.k.phoneTest().ok).toBe(false);
    const r2 = rig(); r2.k.phoneTest(); await r2.poll(); r2.advance(2 * 3_600_000);
    expect(r2.phoneConfirm().ok).toBe(false);
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
  r.k.phoneTest(); await r.poll(); r.phoneConfirm();
  expect((await r.heartbeatDrill()).ok).toBe(true);
  expect(r.k.armedView(CAIN).why).toBe("");
  return r;
}

describe("drills and the armed record", () => {
  test("both drills, the phone test and the checks delivered arm the App; /armed says so with its binding", async () => {
    const r = await armedRig();
    const v = r.k.armedView(CAIN);
    expect(v.armed).toBe(true);
    expect(v.binding).toEqual({ protocol: 1, probe_hash: HASH, keeper_version: "0.1.0", options_hash: optionsHash(parseOptions(r.f.options), r.f.hcKey), backup_scope: "app-only" });
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
    // (0.1.5) a stuck fail ping disarms after 2 minutes; the phone test lapses only at the 10 minute deadline
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.armedView(CAIN).why).toContain("waited undelivered");
    expect(r.k.st.queue.some((q) => q.fail && r.now - q.at > 2 * 60_000)).toBe(true);
    expect(r.logs.some((l) => l.startsWith("the phone test lapsed"))).toBe(false);
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
    for (const p of ["/drill-record", "/phone-test", "/phone-confirm", "/key-confirm", "/missed-heartbeat", "/missed-heartbeat-confirm"]) {
      expect((await call(p, { method: "POST", body: "{}" })).status).toBe(403);
      expect((await call(p, { method: "POST", body: "{}" }, "127.0.0.1", null)).status).toBe(403);   // (0.1.6) never on the App network's listener
    }
    const local = (p: string, ip: string) => handleLocal(r.k, new Request(`http://127.0.0.1:8096${p}`, { method: "POST", body: "{}" }), ip, (m) => log.push(m));
    expect((await local("/phone-test", "127.0.0.1")).status).toBe(409);   // the loopback listener: answered (busy: an attempt is open)
    expect((await local("/phone-test", "172.30.33.4")).status).toBe(403);
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
  test("the job by its id only, child jobs included, from /jobs/info", async () => {
    const jobs = [{ name: "backup_manager_partial_restore", reference: "b1", uuid: "u1", done: false, errors: [], child_jobs: [
      { name: "addon_restore", reference: "b1", uuid: "u2", done: true, errors: [{ message: "e" }], child_jobs: [] }] }];
    const f = fake({ "GET /jobs/info": { result: "ok", data: { jobs } } });
    expect(await f.sup.job("u2")).toEqual({ found: true, uuid: "u2", done: true, errors: 1, name: "addon_restore", reference: "b1" });
    expect(await f.sup.job("u-other")).toEqual({ found: false });
    expect(await fake({}).sup.job("u1")).toBeNull();
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
    expect(r.k.keyConfirm("0000000000000000", r.code("key-confirm"))).toEqual({ ok: false, why: `that fingerprint isn't the options' key's (${keyFp(NPUB)})` });
    expect(r.k.keyConfirm(keyFp(NPUB), r.code("key-confirm")).ok).toBe(true);
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(NPUB));
    expect((await r.register({ head: headN(4), token: shipToken({ key: NEW, head: headN(4), now: r.now }) })).status).toBe(200);
  });
  test("(0.1.6) key-confirm only on the container's own loopback, with the one-time code from the log", async () => {
    const r = rig({ confirm: false });
    const log: string[] = [];
    const code = r.code("key-confirm");
    expect(code).toMatch(/^[0-9a-f]{10}$/);
    const req = (c: string) => new Request("http://127.0.0.1:8096/key-confirm", { method: "POST", body: JSON.stringify({ fingerprint: keyFp(PUB), code: c }) });
    // another container's address: refused on both listeners, nothing confirmed
    expect((await handle(r.k, req(code), "172.30.33.4", (m) => log.push(m))).status).toBe(403);
    expect((await handleLocal(r.k, req(code), "172.30.33.4", (m) => log.push(m))).status).toBe(403);
    expect((await handle(r.k, req(code), "127.0.0.1", (m) => log.push(m))).status).toBe(403);
    expect(r.k.st.pinnedKey?.confirmed).toBeUndefined();
    // a wrong code, then a stale one, are refused
    const wrong = await handleLocal(r.k, req("0000000000"), "127.0.0.1", (m) => log.push(m));
    expect([wrong.status, ((await wrong.json()) as any).why]).toEqual([409, "that one-time code is wrong: use the newest code Keeper printed in its log"]);
    r.advance(KEY_CODE_MS + 60_000);
    expect(((await (await handleLocal(r.k, req(code), "127.0.0.1", (m) => log.push(m))).json()) as any).why).toContain("stale");
    expect(r.k.st.pinnedKey?.confirmed).toBeUndefined();
    // a restart prints a new code, which confirms once
    r.k.start();
    const fresh = r.code("key-confirm");
    expect(fresh).not.toBe(code);
    expect((await handleLocal(r.k, req(fresh), "127.0.0.1", (m) => log.push(m))).status).toBe(200);
    expect(r.k.st.pinnedKey?.confirmed).toBe(r.now);
    expect(r.k.st.codes?.key).toBeUndefined();               // used once
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
    // the dead-man page isn't acknowledged: no confirmation at all (0.1.7: the test is confirmed whole), and
    // after 10 minutes the test lapses
    expect(r.phoneConfirm().why).toContain("no phone test page was delivered in the last hour to the dead-man check");
    expect(r.k.armedView(CAIN).armed).toBe(false);
    await r.poll(PAGE_ACK_MS / POLL_MS + 1);
    expect(r.logs.some((l) => l.startsWith("the phone test lapsed: a page (phone test) got no acknowledgment from Healthchecks within 10 minutes"))).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(false);
    r.f.pingFails = () => false;
    r.advance(10 * 60_000); await r.k.refreshHc(); expect(r.k.phoneTest()).toEqual({ ok: true, why: "" }); await r.poll(); r.phoneConfirm();
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/deadman/fail" && p.body.includes("phone test (a drill) of its dead-man check"))).toBe(true);
    expect((await r.heartbeatDrill()).ok).toBe(true);
    expect(r.k.armedView(CAIN).why).toBe("");
  });
  test("the phone test lapses after 14 days (0.1.5), on any Healthchecks option change, and on a page unacknowledged for 10 minutes", async () => {
    let r = await armedRig();
    r.advance(PHONE_MAX_MS + 60_000); await r.poll();
    expect(r.k.armedView(CAIN).why).toContain("phone test");
    r = await armedRig();
    r.f.options.hc_done = "https://hc-ping.example/done2"; await r.poll();
    expect(r.logs).toContain("the phone test lapsed: a Healthchecks option changed; arming needs a new one (phone-test, then phone-confirm) and a new missed-heartbeat drill");
    expect(r.k.st.mhbRec).toBeUndefined();                 // (0.1.6) the missed-heartbeat drill lapses with it
    r.f.options.hc_done = "https://hc-ping.example/done"; await r.poll();
    expect([r.k.st.phone, r.k.st.phoneHc]).toEqual([{}, undefined]);   // putting it back doesn't bring the old test back
    r = await armedRig();
    r.f.pingFails = (u) => u.endsWith("/fail");
    r.k.owner(CAIN, "unprotected", "a page", true); await r.poll();
    expect(r.k.st.phone).not.toEqual({});                  // a first failure is retried, not yet a lapse
    await r.poll(PAGE_ACK_MS / POLL_MS + 1);
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

// -- the fifth review (0.1.5) ----------------------------------------------------------------------
describe("0.1.5: the claim at the install", () => {
  test("one claimant: of two claims of the same acceptance exactly one gets it, saved before the answer, with its claimed line", async () => {
    const r = rig(); await r.register();
    const first = r.claim(), second = r.claim();
    expect([first.status, second.status]).toEqual([200, 409]);
    expect(first.body).toMatchObject({ status: "claimed", id: ID, app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb-cain",
      until: new Date(T0 + CLAIM_MS).toISOString(), key_fp: keyFp(PUB), state_created: new Date(T0).toISOString() });
    expect(String(first.body.claim)).toMatch(/^claim-[0-9a-f]{16}$/);
    expect(String(second.body.why)).toContain(`claimed already (claim ${first.body.claim})`);
    expect(r.saved!.attempts[ID].claim!.id).toBe(first.body.claim);           // durable before the answer
    expect(r.logs).toContain(`claimed ${ID} claim ${first.body.claim} ${CAIN} 0.16.0 to 0.17.0 backup kb-cain until ${new Date(T0 + CLAIM_MS).toISOString()}`);
  });
  test("a claim bound to other versions or another backup, by another App, or before acceptance is refused; a failed save takes it back", async () => {
    const r = rig(); await r.register();
    expect(r.claim(ID, { backup: "kb-other" }).status).toBe(409);
    expect(r.claim(ID, { to_version: "0.18.0" }).status).toBe(409);
    expect(r.k.claimAttempt(HARNESS, ID, { app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb-cain" }).status).toBe(403);
    expect(r.claim("ship-46-cain-ffffffff").status).toBe(404);
    r.f.saveFails = true;
    expect(r.claim().status).toBe(503);
    expect([r.a().status, r.a().claim]).toEqual(["accepted", undefined]);
    r.f.saveFails = false;
    expect(r.claim().status).toBe(200);
    const p = rig(); p.f.makeBackup = () => new Promise(() => {});
    await p.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    expect(String(p.claim().body.why)).toContain("verifying, not accepted");
  });
  test("an acceptance unclaimed for 30 minutes ends with its ended line, and a late claim is refused", async () => {
    const r = rig(); await r.register();
    r.advance(ACCEPT_MS + 1_000);
    expect(String(r.claim().body.why)).toContain("expired");
    expect(r.a().status).toBe("ended");
    expect(r.logs).toContain(`${ID}: ended (its acceptance expired unclaimed)`);
    const q = rig(); await q.register(); q.advance(ACCEPT_MS + 1_000); await q.poll();
    expect(q.logs).toContain(`${ID}: ended (its acceptance expired unclaimed)`);
    expect(q.restores).toEqual([]);
  });
  test("a version change outside a live claim (accepted unclaimed, its claim expired, or cancelled) is uncertain: unprotected, paged, never restored", async () => {
    const r = rig(); await r.register(); await r.poll();
    r.install("error", false); await r.poll(5);
    expect(r.a().status).toBe("unprotected");
    expect(r.a().why).toContain("outside a live claim");
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("outside a live claim"))).toBe(true);
    expect(r.restores).toEqual([]);
    const e = rig(); await e.register(); await e.poll(); e.claim(); e.advance(CLAIM_MS + 60_000); await e.poll();
    expect(e.a().status).toBe("ended");
    e.install("error", false); await e.poll(5);
    expect([e.a().status, e.restores.length]).toEqual(["unprotected", 0]);
    const c = rig(); await c.register(); await c.poll();
    expect(c.k.cancelAttempt(CAIN, ID, { why: "the pass gave up" }).status).toBe(200);
    expect(c.logs).toContain(`${ID}: ended (cancelled by Cain's link (the pass gave up))`);
    expect(c.claim().status).toBe(409);
    c.install("error", false); await c.poll(5);
    expect([c.a().status, c.restores.length]).toEqual(["unprotected", 0]);
  });
  test("a cancellation while the backup is still being made: the late backup is never accepted", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    expect(r.backupsMade).toEqual([CAIN]);
    expect(r.k.cancelAttempt(CAIN, ID, {}).status).toBe(200);
    finish({ slug: "kb-late" }); await r.k.whenSettled(ID);
    expect(r.a().status).toBe("ended");
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    expect(r.k.cancelAttempt(HARNESS, ID, {}).status).toBe(403);
  });
  test("over HTTP: GET /attempt/<id>, POST /attempt/<id>/claim and /cancel, Cain's token only", async () => {
    const r = rig(); await r.register();
    const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
      handle(r.k, new Request(`http://keeper${path}`, { ...init, headers: { authorization: `Bearer ${token}` } }), "172.30.33.4", () => {});
    const claim = JSON.stringify({ app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb-cain" });
    expect((await call(`/attempt/${ID}/claim`, { method: "POST", body: claim }, HTOKEN)).status).toBe(403);
    const ok = await call(`/attempt/${ID}/claim`, { method: "POST", body: claim });
    expect(ok.status).toBe(200);
    expect(((await (await call(`/attempt/${ID}`)).json()) as any).status).toBe("claimed");
    expect((await call(`/attempt/${ID}/claim`, { method: "POST", body: claim })).status).toBe(409);
    expect((await call(`/attempt/${ID}/cancel`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(((await (await call(`/attempt/${ID}`)).json()) as any).status).toBe("ended");
  });
  test("a claimed install seen within its claim is consumed and watched", async () => {
    const r = rig(); await watching(r);
    expect(r.logs.some((l) => l.startsWith(`consumed ${ID}: ${CAIN} 0.17.0 seen within claim claim-`))).toBe(true);
  });
});

describe("0.1.5: enrollment of the Ship key", () => {
  const { privateKey: EVIL, publicKey: EVIL_PUB } = generateKeyPairSync("ed25519");
  const EPUB = EVIL_PUB.export({ format: "der", type: "spki" }).toString("base64");
  test("a fresh keeper with an attacker's key pinned refuses every registration until the owner confirms at the device", async () => {
    const r = rig({ opts: { ship_public_key: EPUB }, confirm: false });
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(EPUB));
    const ans = await r.register({ token: shipToken({ key: EVIL }) });
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toContain(`the pinned Ship key (fingerprint ${keyFp(EPUB)}) isn't confirmed yet`);
    expect(ans.body.key_fp).toBe(keyFp(EPUB));
    expect(ans.body.key_confirmed_at).toBeNull();
    expect(Object.keys(r.k.st.attempts)).toEqual([]);
  });
  test("a reinstalled keeper (new state) with the right key is refused until the confirm, then accepts; answers report the enrollment", async () => {
    const r = rig({ confirm: false });
    expect((await r.register()).status).toBe(409);
    r.advance(60_000);
    expect(r.k.keyConfirm(keyFp(PUB), r.code("key-confirm")).ok).toBe(true);
    const ans = await r.register({ head: headN(1) });
    expect(ans.status).toBe(200);
    expect(ans.body).toMatchObject({ key_fp: keyFp(PUB), key_confirmed_at: new Date(T0 + 60_000).toISOString(), state_created: new Date(T0).toISOString() });
    expect(r.k.armedView(CAIN)).toMatchObject({ key_fp: keyFp(PUB), state_created: new Date(T0).toISOString() });
  });
  test("a rewound state needs the confirm again", async () => {
    const r = rig();
    const st = JSON.parse(JSON.stringify(r.k.st)); st.heartbeat = T0 - REWIND_MS - 60_000;
    const r2 = rig({ saved: st, confirm: false });
    expect(r2.k.st.pinnedKey?.confirmed).toBeUndefined();
    expect(String((await r2.register()).body.why)).toContain("isn't confirmed yet");
  });
});

describe("0.1.5: the Healthchecks settings read", () => {
  test("no Healthchecks key kept (0.1.7: hc-key): not armable, and it says so", () => {
    const r = rig({ hcKey: "" });
    expect(r.k.armableWhy()).toContain("no Healthchecks read-only key is kept");
    expect(r.k.phoneTest().ok).toBe(false);
  });
  for (const [name, over, why] of [
    ["a heartbeat period over 5 minutes", { done: { timeout: 600 } }, "period of at most 5 minutes"],
    ["a heartbeat grace over 10 minutes", { done: { grace: 900 } }, "grace of at most 10"],
    ["a heartbeat on a cron schedule", { done: { schedule: "* * * * *" } }, "a schedule"],
    ["a dead-man period other than 1 minute", { deadman: { timeout: 120 } }, "period of 1 minute"],
    ["a dead-man grace over 5 minutes", { deadman: { grace: 600 } }, "grace of at most 5"],
    ["an alert check with no channel", { failed: { channels: "" } }, "no notification channel"],
    ["a paused check", { deadman: { status: "paused" } }, "is paused"],
    ["a heartbeat check that is down", { done: { status: "down" } }, "is down"],
    ["a check the key can't see", { failed: null }, "isn't among the checks"],
  ] as const) {
    test(`${name} refuses arming`, async () => {
      const r = await armedRig();
      for (const [k, v] of Object.entries(over)) r.f.hcOver[k] = v === null ? null : { ...(v as any) };
      r.advance(HC_READ_MS); await r.poll();
      const v = r.k.armedView(CAIN);
      expect(v.armed).toBe(false);
      expect(v.why).toContain(why);
    });
  }
  test("the API unreadable refuses arming; a stale read (over 3 minutes) refuses too", async () => {
    const r = await armedRig();
    r.f.hcUp = false; r.advance(HC_READ_MS); await r.poll();
    expect(r.k.armedView(CAIN).why).toContain("couldn't be read");
    r.f.hcUp = true; r.advance(HC_READ_MS); await r.poll();
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("settings changed since the phone test lapse it, even once put back; a new phone test arms again", async () => {
    const r = await armedRig();
    r.f.hcOver.failed = { channels: "ch-phone,ch-mail" }; r.advance(HC_READ_MS); await r.poll();
    expect(r.logs.some((l) => l.startsWith("the phone test lapsed: a Healthchecks check's period, grace or channels changed since the phone test"))).toBe(true);
    delete r.f.hcOver.failed; r.advance(HC_READ_MS); await r.poll();
    expect(r.k.armedView(CAIN).why).toContain("phone test");
    await r.k.refreshHc(); r.k.phoneTest(); await r.poll(); r.phoneConfirm();
    expect(r.k.armedView(CAIN).why).toContain("missed-heartbeat drill");
    expect((await r.heartbeatDrill()).ok).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("read at most once a minute", async () => {
    const r = rig(); const before = r.f.hcReads;
    await r.poll(4);
    expect(r.f.hcReads - before).toBe(2);
  });
  test("the phone test lasts 14 days", async () => {
    expect(PHONE_MAX_MS).toBe(14 * 86_400_000);
    const r = await armedRig();
    r.advance(13 * 86_400_000); await r.poll(2);
    expect(r.k.armedView(CAIN).armed).toBe(true);
    r.advance(2 * 86_400_000); await r.poll(2);
    expect(r.k.armedView(CAIN).why).toContain("phone test");
  });
  test("checks found by uuid (a read-only key's unique_key) or slug; (0.1.6) any ping URL in the answer is a read-write key, refused", () => {
    const U = "0f3a1c2e-1111-4222-8333-944455556666", V = "1f3a1c2e-1111-4222-8333-944455556666", W = "2f3a1c2e-1111-4222-8333-944455556666";
    const o = parseOptions({ watch: [CAIN], hc_done: `https://hc-ping.com/${U}`, hc_deadman: `https://hc-ping.com/${V}`, hc_failed: "https://hc-ping.com/key/cain-alert" });
    const sha1 = (t: string) => new Bun.CryptoHasher("sha1").update(t).digest("hex");
    const list: HcCheck[] = [
      { unique_key: sha1(U), timeout: 300, grace: 600, status: "up", channels: "a" },
      { unique_key: sha1(V), timeout: 60, grace: 300, status: "up", channels: "a" },
      { slug: "cain-alert", timeout: 86400, grace: 3600, status: "down", channels: "a" },
      { unique_key: sha1(W), timeout: 9999, grace: 9999, status: "paused", channels: "" },
    ];
    expect(judgeHc(o, list)).toMatchObject({ ok: true, why: "", hidden: [] });
    const rw = [{ ...list[0], ping_url: `https://hc-ping.com/${U}` }, ...list.slice(1)];
    expect(judgeHc(o, rw)).toMatchObject({ ok: false, rw: true, why: HC_RW_WHY });
    // a slug fallback that matches more than one check refuses
    expect(judgeHc(o, [...list, { slug: "cain-alert", timeout: 86400, grace: 3600, status: "up", channels: "b" }]).why).toBe("Cain's alert check: its slug cain-alert matches 2 checks the key can read (give each check its own slug, use its uuid ping URL, or set its unique key in hc_unique_keys)");
    // (0.1.7) the owner's explicit unique key for a role wins over the derived match, and must match
    const dup = [...list, { unique_key: "c".repeat(40), slug: "cain-alert", timeout: 86400, grace: 3600, status: "up", channels: "b" }];
    const ex = parseOptions({ watch: [CAIN], hc_done: `https://hc-ping.com/${U}`, hc_deadman: `https://hc-ping.com/${V}`, hc_failed: "https://hc-ping.com/key/cain-alert", hc_unique_keys: [`${CAIN}=${"C".repeat(40)}`, "nosuch=1", "done=short"] });
    expect(ex.hc_unique_keys).toEqual({ [CAIN]: "c".repeat(40) });
    expect(judgeHc(ex, dup)).toMatchObject({ ok: true });
    const wrong = parseOptions({ ...ex, hc_unique_keys: [`done=${"d".repeat(40)}`], watch: [CAIN], hc_failed: "https://hc-ping.com/key/cain-alert" });
    expect(judgeHc(wrong, list).why).toBe("hc_done (the heartbeat check) isn't among the checks the kept Healthchecks key can read (by the unique key set in hc_unique_keys)");
  });
  test("main.ts reads the management API with the key in X-Api-Key and keeps only the fields it uses", async () => {
    const seen: any[] = [];
    const http = (async (url: any, init: any) => { seen.push({ url: String(url), key: init.headers["x-api-key"] });
      return new Response(JSON.stringify({ checks: [{ name: "x", slug: "done", timeout: 300, grace: 600, status: "up", channels: "c", extra: "dropped" }] }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await hcChecks("secret-key", http)).toEqual([{ name: "x", slug: "done", status: "up", channels: "c", timeout: 300, grace: 600 }]);
    expect(seen).toEqual([{ url: "https://healthchecks.io/api/v3/checks/", key: "secret-key" }]);
    expect(await hcChecks("k", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("0.1.6: a read-only Healthchecks key only", () => {
  const hideAll = (r: ReturnType<typeof rig>) => { for (const id of ["done", "deadman", "failed"]) r.f.hcOver[id] = { channels: undefined as any }; };
  test("a key whose answer shows ping URLs can write: refused for arming, logged, and paged once to swap it", async () => {
    const r = await armedRig();
    for (const id of ["done", "deadman", "failed"]) r.f.hcOver[id] = { ping_url: `https://hc-ping.com/${id}` } as any;
    r.advance(HC_READ_MS); await r.poll();
    const v = r.k.armedView(CAIN);
    expect([v.armed, v.why]).toEqual([false, `the Healthchecks checks refuse arming: ${HC_RW_WHY}`]);
    expect(r.logs.filter((l) => l.startsWith("REFUSING the kept Healthchecks key: it can write"))).toHaveLength(1);
    expect(r.pings.filter((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.includes("can write"))).toHaveLength(1);
    r.advance(HC_READ_MS); await r.poll(3);
    expect(r.logs.filter((l) => l.startsWith("REFUSING the kept Healthchecks key"))).toHaveLength(1);   // once per key
    expect(r.k.phoneTest().ok).toBe(false);
  });
  test("a read-only key that hides channels: armed only on the owner's per-check confirmations (phone test and missed-heartbeat drill)", async () => {
    const r = rig(); hideAll(r);
    await drillOf(r, headN(1), "verdict"); await drillOf(r, headN(2), "exit");
    await r.k.refreshHc();
    expect(r.k.hcSeen).toMatchObject({ ok: true, hidden: ["done", "deadman", "failed"] });
    expect(r.logs.some((l) => l.includes("the key hides the channels of done, deadman, failed"))).toBe(true);
    expect(r.k.phoneTest().ok).toBe(true); await r.poll();
    // 0.1.7: the owner names every check in one call; naming only some confirms nothing, and the code stands
    expect(r.phoneConfirm(["cain"]).why).toContain("not named: the dead-man check");
    expect(r.phoneConfirm(["cain", "nosuch"]).why).toContain("no such check: nosuch");
    expect(r.k.st.phone.deadman.confirmedAt).toBeUndefined();
    expect((await r.heartbeatDrill()).why).toBe("the phone test is running: one drill at a time");
    expect(r.phoneConfirm(["cain", "deadman"])).toEqual({ ok: true, why: "" });
    expect((await r.heartbeatDrill()).ok).toBe(true);
    expect(r.k.armedView(CAIN).why).toBe("");
    expect(r.k.st.phone.deadman.confirmedAt).toBeGreaterThan(0);
  });
  test("phone-confirm needs the code from the phone test; a wrong or stale code is refused", async () => {
    const r = rig();
    await r.k.refreshHc(); expect(r.k.phoneTest().ok).toBe(true); await r.poll();
    expect(r.k.phoneConfirm("0123456789", ["cain", "deadman"]).why).toContain("wrong");
    expect(r.k.phoneConfirm(r.code("phone-confirm"), []).ok).toBe(false);   // each check is named
    const late = rig();
    await late.k.refreshHc(); late.k.phoneTest(); await late.poll(); late.advance(PHONE_WINDOW_MS + 11 * 60_000);
    expect(late.k.phoneConfirm(late.code("phone-confirm"), ["cain", "deadman"]).ok).toBe(false);
    // (0.1.7) single use: the good code confirms once; the same code again finds no test running
    const code = r.code("phone-confirm");
    expect(r.k.phoneConfirm(code, ["cain", "deadman"])).toEqual({ ok: true, why: "" });
    expect(r.k.phoneConfirm(code, ["cain", "deadman"]).why).toContain("no phone test runs");
  });
  test("the config's comment and the docs say read-only only (0.1.7: the key entered with hc-key, out of the options and backups)", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    expect(cfg).toContain("read-only");
    expect(cfg).not.toContain("read-write key is needed");
    expect(docs).toContain("Keeper accepts a read-only key only");
    expect(docs).not.toContain("a read-write key is needed");
    expect(docs).toContain("**Backups leave it out.**");
  });
});

describe("0.1.6: the missed-heartbeat drill", () => {
  test("(0.1.7) the heartbeat stops until Healthchecks shows the check down (capped at 30 minutes), then resumes; never seen down: refused", async () => {
    const r = rig();
    await r.k.refreshHc();
    expect(r.k.missedHeartbeat()).toEqual({ ok: true, why: "" });
    expect(r.k.st.mhb!.cap - r.now).toBe(MHB_CAP_MS);
    expect(r.k.missedHeartbeat().ok).toBe(false);               // one at a time
    const before = r.pings.length;
    while (r.now < r.k.st.mhb!.cap - 60_000) await r.poll();
    expect(r.pings.slice(before).some((p) => p.url === "https://hc-ping.example/done")).toBe(false);
    expect(r.pings.slice(before).some((p) => p.url === "https://hc-ping.example/deadman")).toBe(true);   // the dead-man goes on
    expect(r.k.armedView(CAIN).why).toBe("the missed-heartbeat drill is running (one drill at a time; Keeper is unarmed during a drill)");
    // too early, then never seen down by the cap: refused
    expect(r.k.missedHeartbeatConfirm(r.code("missed-heartbeat-confirm")).why).toContain("runs until Healthchecks shows");
    await r.poll(4);
    expect(r.k.st.mhb!.resumedAt).toBeGreaterThan(0);
    expect(r.logs.some((l) => l.includes("didn't show the heartbeat check down within 30 minutes"))).toBe(true);
    expect(r.pings.some((p, i) => i >= before && p.url === "https://hc-ping.example/done")).toBe(true);
    expect(r.k.missedHeartbeatConfirm(r.code("missed-heartbeat-confirm")).why).toContain("never showed the heartbeat check down");
  });
  test("(0.1.7) shown down early: the ping resumes at once; the confirm waits for the check up again (a whole down-to-up cycle)", async () => {
    const r = rig();
    await r.k.refreshHc(); r.k.missedHeartbeat();
    await r.poll(4);
    r.f.hcOver.done = { status: "down" }; r.advance(HC_READ_MS); await r.poll(2);
    expect(r.k.st.mhb!.sawDown).toBeGreaterThan(0);
    expect(r.k.st.mhb!.resumedAt! - r.k.st.mhb!.startedAt).toBeLessThan(5 * 60_000);
    expect(r.k.missedHeartbeatConfirm(r.code("missed-heartbeat-confirm")).why).toContain("hasn't shown the heartbeat check up again");
    delete r.f.hcOver.done; r.advance(HC_READ_MS); await r.poll();
    expect(r.k.missedHeartbeatConfirm(r.code("missed-heartbeat-confirm"))).toEqual({ ok: true, why: "" });
  });
  test("(0.1.7) a heartbeat check on a schedule: the drill is refused with a plain line", async () => {
    const r = rig();
    r.f.hcOver.done = { schedule: "*/5 * * * *" } as any;
    await r.k.refreshHc();
    expect(r.k.missedHeartbeat().why).toContain("runs on a schedule (cron)");
    expect(r.logs).toContain("refused the missed-heartbeat drill: the heartbeat check runs on a schedule, not a period");
  });
  test("confirmed: wrong code refused, an hour late refused, and arming needs it within 14 days; it lapses with the phone test", async () => {
    const r = rig();
    expect((await r.heartbeatDrill(false)).ok).toBe(true);
    expect(r.k.missedHeartbeatConfirm("0000000000").why).toContain("wrong");
    expect(r.k.missedHeartbeatConfirm(r.code("missed-heartbeat-confirm")).ok).toBe(true);
    expect(r.k.st.mhbRec).toBeDefined();
    const late = rig();
    await late.heartbeatDrill(false); late.advance(PHONE_WINDOW_MS + 60_000);
    expect(late.k.missedHeartbeatConfirm(late.code("missed-heartbeat-confirm")).why).toContain("over an hour ago");
    expect(MHB_MAX_MS).toBe(14 * 86_400_000);
    const a = await armedRig();
    a.k.st.mhbRec!.confirmedAt = a.now - MHB_MAX_MS - 60_000;
    expect(a.k.armedView(CAIN).why).toContain("no missed-heartbeat drill confirmed in the last 14 days");
  });
  test("the heartbeat check shown down by the drill, and the dead-man check down after the phone test's fail ping: both back up by themselves, and the arm refusal clears with no new test", async () => {
    const r = await armedRig();
    // the phone test again: the dead-man check gets its fail ping, then its keeper alive ping
    expect(r.k.phoneTest().ok).toBe(true);
    r.f.hcOver.deadman = { status: "down" };
    r.advance(HC_READ_MS); await r.poll();
    const dm = r.pings.map((p, i) => [i, p] as const).filter(([, p]) => p.url.startsWith("https://hc-ping.example/deadman"));
    const fail = dm.findIndex(([, p]) => p.url.endsWith("/fail") && p.body.includes("phone test"));
    expect(fail).toBeGreaterThanOrEqual(0);
    expect(dm.slice(fail + 1).some(([, p]) => p.url === "https://hc-ping.example/deadman" && p.body === "keeper alive")).toBe(true);
    r.phoneConfirm();
    expect(r.k.armedView(CAIN).why).toBe("the Healthchecks checks refuse arming: hc_deadman (the dead-man check) is down");
    delete r.f.hcOver.deadman;                              // Healthchecks shows it up after the ping
    r.advance(HC_READ_MS); await r.poll();
    expect(r.k.armedView(CAIN).why).toBe("");
  });
});

describe("0.1.6: the claim's deadline bounds the start, not the watch", () => {
  test("an install first seen inside the claim and finishing after its deadline stays protected through its 15-minute watch", async () => {
    const r = rig();
    await r.register(); await r.poll();
    expect(r.claim().status).toBe(200);
    const until = r.a().claim!.until;
    r.advance(until - r.now - 60_000);
    r.install("started", false); await r.poll();
    expect(r.a().status).toBe("watching");
    expect(r.a().firstSeenTo!).toBeLessThanOrEqual(until);
    r.verdict("PASS");
    await r.poll(WATCH_MS / POLL_MS + 1);
    expect(r.a().status).toBe("passed");
    expect(r.a().endedAt!).toBeGreaterThan(until);
    // and a FAIL after the deadline still rolls back
    const f = rig();
    await f.register(); await f.poll(); f.claim();
    f.advance(f.a().claim!.until - f.now - 60_000); f.install("started", false); await f.poll();
    f.advance(5 * 60_000); f.verdict("FAIL"); await f.poll(ROLL);
    expect(f.a().status).toBe("rolled back");
    expect(f.restores).toHaveLength(1);
  });
  test("a version change inside a live claim to another version than the claimed one is uncertain: unprotected, paged, never restored", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.f.app.version = "0.18.0"; await r.poll();
    expect(r.a().status).toBe("unprotected");
    expect(r.a().why).toBe("Cain moved to 0.18.0, not the claimed 0.17.0, during its live claim, so the install is uncertain");
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("not the claimed 0.17.0"))).toBe(true);
    await r.poll(10);
    expect(r.restores).toHaveLength(0);
  });
});

describe("0.1.6: orphan backups", () => {
  test("a cancelled registration's backup is deleted, by its recorded slug", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const slug = r.a().backup;
    expect(r.k.cancelAttempt(CAIN, ID, { why: "gave up" }).status).toBe(200);
    await r.poll();
    expect(r.deleted).toEqual([slug]);
    expect(r.a().backupDropped).toBe(true);
    expect(r.logs).toContain(`${ID}: deleted its backup ${slug} (cancelled by Cain's link (gave up): never used)`);
    await r.poll(3); expect(r.deleted).toHaveLength(1);
  });
  test("a backup still being made when the registration is cancelled is deleted once it is made", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    r.k.cancelAttempt(CAIN, ID, {});
    finish({ slug: "kb-late" }); await r.k.whenSettled(ID);
    await r.poll();
    expect(r.deleted).toEqual(["kb-late"]);
  });
  test("an acceptance that expires unclaimed has its backup deleted; one that can't be deleted is named in the log and left", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const slug = r.a().backup;
    r.f.deleteOk = false;
    r.advance(ACCEPT_MS + 60_000); await r.poll(DROP_TRIES + 2);
    expect(r.a().status).toBe("ended");
    expect(r.deleted).toEqual(Array(DROP_TRIES).fill(slug));
    expect(r.logs).toContain(`${ID}: couldn't delete its backup ${slug} after ${DROP_TRIES} tries; it stays in Home Assistant's list, used for nothing: delete backup ${slug} by hand (Settings, System, Backups)`);
    const ok = rig();
    await ok.register(); await ok.poll(); ok.advance(ACCEPT_MS + 60_000); await ok.poll(2);
    expect(ok.deleted).toEqual([ok.a().backup]);
  });
  test("a claim that expires with no version change, or an install, keeps its backup", async () => {
    const r = rig();
    await watching(r); r.verdict("PASS"); await r.poll(WATCH_MS / POLL_MS + 1);
    expect(r.deleted).toEqual([]);
  });
  test("the Supervisor call: DELETE /backups/<slug>, true only on its ok", async () => {
    const seen: string[] = [];
    const http = async (url: string, init: RequestInit) => { seen.push(`${init.method} ${url}`); return new Response(JSON.stringify({ result: url.endsWith("kb1") ? "ok" : "error" }), { status: url.endsWith("kb1") ? 200 : 403 }); };
    const sup = supervisor("t", "http://supervisor", http);
    expect(await sup.deleteBackup("kb1")).toBe(true);
    expect(await sup.deleteBackup("kb2")).toBe(false);
    expect(seen).toEqual(["DELETE http://supervisor/backups/kb1", "DELETE http://supervisor/backups/kb2"]);
  });
});

// -- 0.1.7 (the seventh review's fixes) -------------------------------------------------------------------
describe("0.1.7: the accepted limits", () => {
  test("arming needs the owner's accept-limits with the code printed at start; the code is bound to the text's version and used once", async () => {
    const r = rig({ limits: false });
    expect(r.logs.some((l) => l.includes(`aren't accepted yet: arming needs accept-limits <code>`))).toBe(true);
    const code = r.code("accept-limits" as any);
    expect(code).toMatch(/^[0-9a-f]{10}$/);
    await drillOf(r, headN(1), "verdict"); await drillOf(r, headN(2), "exit");
    r.k.phoneTest(); await r.poll(); r.phoneConfirm(); expect((await r.heartbeatDrill()).ok).toBe(true);
    expect(r.k.armedView(CAIN).why).toBe(`the owner hasn't accepted the limits in Keeper's DOCS (Accepted limits, text version ${LIMITS_VERSION}): accept-limits <code>`);
    expect(r.k.acceptLimits("0000000000").why).toContain("wrong");
    expect(r.k.acceptLimits(code)).toEqual({ ok: true, why: "" });
    expect(r.k.st.limits).toEqual({ version: LIMITS_VERSION, at: r.now });
    expect(r.k.armedView(CAIN).why).toBe("");
    expect(r.logs).toContain(`the owner accepted the limits in Keeper's DOCS (Accepted limits, text version ${LIMITS_VERSION})`);
  });
  test("an acceptance of another text version lapses: a new code at start, and not armed until accepted again", async () => {
    const r = await armedRig();
    const saved = JSON.parse(JSON.stringify(r.saved));
    saved.limits = { version: LIMITS_VERSION + 1, at: T0 };
    const again = rig({ saved, limits: false });
    expect(again.logs.some((l) => l.startsWith(`the accepted limits' text changed (version ${LIMITS_VERSION + 1} accepted, now ${LIMITS_VERSION})`))).toBe(true);
    expect(again.k.limitsOk()).toBe(false);
    expect(again.k.armedState(CAIN).why).toContain("hasn't accepted the limits");
    expect(again.k.acceptLimits(again.code("accept-limits" as any)).ok).toBe(true);
  });
  test("the DOCS carry the Accepted limits section at this text version, with both limits and what the owner can do; RELEASING's setup list has the step", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    const sec = docs.slice(docs.indexOf("## Accepted limits"));
    expect(sec.length).toBeGreaterThan(100);
    expect(sec).toContain(`Text version ${LIMITS_VERSION} (0.1.7)`);
    expect(sec).toContain("same-version install");
    expect(sec).toContain("up to 14 days");
    expect(sec).toContain("never install Cain from Home Assistant's page while a Ship run is live");
    const rel = readFileSync(join(import.meta.dir, "..", "..", "RELEASING.md"), "utf8");
    expect(rel).toContain("accept-limits <code>");
    expect(rel).toContain("hc-key <code>");
  });
});

describe("0.1.7: the Healthchecks key leaves the options (hc-key)", () => {
  const enter = async (r: ReturnType<typeof rig>, key: string) => {
    const res = await handleLocal(r.k, new Request("http://127.0.0.1:8096/hc-key", { method: "POST", body: JSON.stringify({ code: r.code("hc-key" as any), key }) }), "127.0.0.1", () => {});
    return { status: res.status, body: await res.json() as any };
  };
  test("entered with the code printed at start: checked read-only and seeing every configured check, then kept; never logged", async () => {
    const r = rig({ hcKey: "" });
    expect(r.logs.some((l) => l.startsWith("no Healthchecks read-only key is kept: enter it once with hc-key <code>"))).toBe(true);
    const a = await enter(r, "new-read-key-0123456789");
    expect(a).toEqual({ status: 200, body: { ok: true, why: "" } });
    expect([r.f.hcKey, r.f.hcKeyWrites, r.k.hcKey]).toEqual(["new-read-key-0123456789", 1, "new-read-key-0123456789"]);
    expect(r.logs.some((l) => l.includes("new-read-key"))).toBe(false);
    expect(r.k.armableWhy()).toBe("");
    // the code was spent: the same code again is refused before any read
    const reads = r.f.hcReads;
    expect(String((await r.k.hcKeyEnter(codeIn(r.logs, "hc-key"), "x".repeat(20))).why)).toContain("no one-time code");
    expect(r.f.hcReads).toBe(reads);
  });
  test("a key that can write is refused at entry with a plain line, and never kept; so is one that doesn't see a configured check, or a wrong code", async () => {
    const r = rig({ hcKey: "" });
    for (const id of ["done", "deadman", "failed"]) r.f.hcOver[id] = { ping_url: `https://hc-ping.com/${id}` } as any;
    const rw = await enter(r, "write-key-0123456789ab");
    expect([rw.status, rw.body.why]).toEqual([409, "that key can write (its answer shows ping URLs): enter the project's read-only API key (Project Settings, API Access)"]);
    expect(r.logs).toContain("refused the Healthchecks key entered: that key can write (its answer shows ping URLs): enter the project's read-only API key (Project Settings, API Access); nothing was kept");
    expect([r.f.hcKey, r.f.hcKeyWrites, r.k.hcKey]).toEqual(["", 0, ""]);
    r.f.hcOver = { deadman: null };
    const blind = await enter(r, "blind-key-0123456789ab");   // a new code was printed after the refusal
    expect(blind.body.why).toBe("that key doesn't see hc_deadman (the dead-man check)");
    expect(r.f.hcKeyWrites).toBe(0);
    expect((await r.k.hcKeyEnter("0000000000", "good-key-0123456789ab")).why).toContain("wrong");
    r.f.hcOver = {}; r.f.hcKeyWriteOk = false;
    expect((await enter(r, "good-key-0123456789ab")).body.why).toBe("Keeper couldn't write the key to its data folder");
    expect(r.k.hcKey).toBe("");
  });
  test("kept root-only (0600) in the data folder, never in the options, and excluded from the keeper's own backups", async () => {
    const { hcKeyStore } = await import("../rootfs/opt/keeper/main.ts");
    const { mkdtempSync, statSync, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const st = hcKeyStore(join(dir, "hc-key"));
    expect(st.load()).toBe("");
    expect(st.store("stored-key-0123456789")).toBe(true);
    expect(statSync(join(dir, "hc-key")).mode & 0o777).toBe(0o600);
    expect(rf(join(dir, "hc-key"), "utf8")).toBe("stored-key-0123456789\n");
    expect(st.load()).toBe("stored-key-0123456789");
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).not.toMatch(/^\s+hc_api_key:/m);
    expect(cfg).toMatch(/^backup_exclude:\n(\s+- .+\n)*\s+- "?\*\/hc-key\*?"?$/m);
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    expect(docs).toContain("backup_exclude");
    expect(docs).not.toContain("carries Keeper's options, `hc_api_key`");
    const main = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "main.ts"), "utf8");
    expect(main).toContain("Bun.stdin.text()");                   // the key comes from standard input
    expect(main).toContain("the key goes on standard input, never the command line");
  });
  test("the old hc_api_key option still in the options: a line at every start, and the key in it is never used", async () => {
    const r = rig({ hcKey: "", opts: { hc_api_key: "old-option-key-0123456789" } });
    const line = "the old option hc_api_key is still in Keeper's options: remove it (Keeper ignores it; the key is entered once with hc-key and kept outside the options)";
    expect(r.logs.filter((l) => l === line)).toHaveLength(1);
    expect(r.k.hcKey).toBe("");
    expect(r.k.armableWhy()).toContain("no Healthchecks read-only key is kept");
    const again = rig({ saved: r.saved, hcKey: "", opts: { hc_api_key: "old-option-key-0123456789" } });
    expect(again.logs.filter((l) => l === line)).toHaveLength(1);
    const gone = rig({ saved: r.saved });
    expect(gone.logs.includes(line)).toBe(false);
  });
});

describe("0.1.7: the claim record (claim, cancel, consume)", () => {
  test("a lost cancel, then the claim's expiry: the claim is unused and its backup deleted, after the jobs list shows no install", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    const slug = r.a().backup;
    // the link's cancel never reaches the keeper; the claim expires with no version change seen
    r.advance(CLAIM_MS + 60_000); await r.poll(2);
    expect(r.a().status).toBe("ended");
    expect(r.deleted).toEqual([slug]);
  });
  test("an active install or update of the App in the jobs list keeps the backup, logged; an unreadable list keeps it too", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.f.activeJobs = ["addon_manager_update"];
    r.advance(CLAIM_MS + 60_000); await r.poll(3);
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain(`${ID}: kept its backup ${r.a().backup}: its claim expired with no version change seen, but an install or update of ${CAIN} is running (addon_manager_update)`);
    const u = rig();
    await u.register(); await u.poll(); u.claim();
    u.f.activeJobs = null;
    u.advance(CLAIM_MS + 60_000); await u.poll(DROP_TRIES + 2);
    expect(u.deleted).toEqual([]);
    expect(u.logs.some((l) => l.includes("the Supervisor's jobs list couldn't be read, so its backup") && l.includes("is kept"))).toBe(true);
  });
  test("a cancel after the claim was handed to a started run (a version change seen) is refused", async () => {
    const r = rig();
    await watching(r);
    const c = r.k.cancelAttempt(CAIN, ID, { why: "late" });
    expect(c.status).toBe(409);
    expect(c.body.why).toBe("its claim was handed to a started run (Cain 0.17.0 was seen): it is watching, and a cancel can't end it now");
    expect(r.a().status).toBe("watching");
  });
  test("a retry reads the recorded outcome: the same claim for the same request; the recorded cancel", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const first = r.claim(ID, { request: "req-0123456789" });
    expect(first.status).toBe(200);
    const again = r.claim(ID, { request: "req-0123456789" });
    expect([again.status, again.body.claim, again.body.recorded]).toEqual([200, first.body.claim, "claimed"]);
    expect(r.claim(ID, { request: "req-other-0000" }).status).toBe(409);   // another request: one claimant
    expect(r.claim(ID).status).toBe(409);
    const c = rig();
    await c.register(); await c.poll();
    expect(c.k.cancelAttempt(CAIN, ID, { why: "gave up", request: "cancel-0123456789" }).status).toBe(200);
    expect(c.k.cancelAttempt(CAIN, ID, { why: "gave up" }).body).toEqual({ status: "ended", id: ID, recorded: true });
    expect(c.logs).toContain(`a retry of the cancel of ${ID}: the recorded outcome (ended)`);
    // a retried claim of a cancelled attempt reads why it ended
    expect(c.claim(ID).body.why).toContain("it is ended");
  });
  test("claim and cancel run one at a time under the record's lock, in the order they came", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const a = r.a();
    const body = { app: a.app, from_version: a.from, to_version: a.to, backup: a.backup };
    const [cl, ca] = await Promise.all([r.k.claim(CAIN, ID, body), r.k.cancel(CAIN, ID, { why: "x" })]);
    expect([cl.status, ca.status]).toEqual([200, 200]);   // claimed, then the cancel ends the claim (no version change yet)
    expect(r.a().status).toBe("ended");
    const order: string[] = [];
    await Promise.all([r.k.record(async () => { await Bun.sleep(5); order.push("one"); }), r.k.record(() => { order.push("two"); })]);
    expect(order).toEqual(["one", "two"]);
  });
});

describe("0.1.7: one drill at a time", () => {
  test("while a drill runs Keeper is unarmed and refuses a registration, which voids the drill (its code no longer counts)", async () => {
    const r = await armedRig();
    await r.k.refreshHc();
    expect(r.k.missedHeartbeat().ok).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.phoneTest().why).toBe("the missed-heartbeat drill is running: one drill at a time");
    const code = r.code("missed-heartbeat-confirm");
    const ans = await r.register({ head: headN(7) });
    expect(String(ans.body.why)).toContain("the missed-heartbeat drill was running, and Keeper takes no registration during a drill");
    expect(r.logs).toContain("the missed-heartbeat drill was interrupted (a registration arrived): its code no longer counts; run it again from the start");
    expect(r.k.st.mhb).toBeUndefined();
    expect(r.k.missedHeartbeatConfirm(code).ok).toBe(false);
  });
  test("a restart interrupts a running drill: its code is void, and the drill needs a fresh run", async () => {
    const r = rig();
    await r.k.refreshHc(); r.k.phoneTest(); await r.poll();
    const code = r.code("phone-confirm");
    const again = rig({ saved: r.saved });
    expect(again.logs).toContain("the phone test was interrupted (Keeper restarted): its code no longer counts; run it again from the start");
    expect(again.k.phoneConfirm(code, ["cain", "deadman"]).ok).toBe(false);
    await again.k.refreshHc();
    expect(again.k.phoneTest().ok).toBe(true);
  });
});

describe("0.1.7: codes bound to their challenge, and the enrollment counter", () => {
  test("a key code printed for one fingerprint doesn't confirm another; a code is used once; every start prints a key code", async () => {
    const r = rig();
    const pub2 = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const before = codeIn(r.logs, "key-confirm");
    r.f.options.ship_public_key = pub2; await r.poll();
    const now2 = codeIn(r.logs, "key-confirm");
    expect(now2).not.toBe(before);
    // forge: the new code checked against the old fingerprint's challenge is refused; the right one works once
    r.k.st.codes!.key!.challenge = keyFp(PUB);
    expect(r.k.keyConfirm(keyFp(pub2), now2).why).toContain("printed for another challenge");
    r.k.st.codes!.key!.challenge = keyFp(pub2);
    expect(r.k.keyConfirm(keyFp(pub2), now2)).toEqual({ ok: true, why: "" });
    expect(r.k.keyConfirm(keyFp(pub2), now2).ok).toBe(false);
    const again = rig({ saved: r.saved, opts: { ship_public_key: pub2 }, confirm: false });
    expect(codeIn(again.logs, "key-confirm")).toMatch(/^[0-9a-f]{10}$/);
  });
  test("the counter goes up with every state write and armed read; a re-enrollment with a fresh code gives a new enrollment id", async () => {
    const r = rig();
    const e1 = r.k.enrollment();
    r.k.armedView(CAIN);
    const e2 = r.k.enrollment();
    expect(e2.counter).toBeGreaterThan(e1.counter);
    expect(r.saved!.counter).toBe(e2.counter);
    await r.poll();
    expect(r.k.enrollment().counter).toBeGreaterThan(e2.counter);
    // after a restore or a clock correction: the owner's key-confirm with the code printed at the start
    const again = rig({ saved: r.saved, confirm: false });
    const id1 = again.k.st.pinnedKey!.enrollId;
    expect(again.k.keyConfirm(keyFp(PUB), again.code("key-confirm"))).toEqual({ ok: true, why: "" });
    expect(again.k.st.pinnedKey!.enrollId).not.toBe(id1);
    expect(again.k.enrollment()).toMatchObject({ enroll_id: again.k.st.pinnedKey!.enrollId });
    expect(again.logs.some((l) => l.includes("it replaces its earlier confirm (a re-enrollment)"))).toBe(true);
  });
});

describe("0.1.7: orphan backups by their own name, and the network mode", () => {
  test("the backup's name is kept before the call; after a restart lost its slug, a cancelled attempt's backup is found by that exact name and deleted", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});         // the backup call never answers in this process
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const name = r.saved!.attempts[ID].backupName!;
    expect(name).toMatch(new RegExp(`^Keeper ${ID} [0-9a-f]{8}$`));
    r.k.cancelAttempt(CAIN, ID, {});
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-other", name: `Keeper ${ID} 00000000` }, { slug: "kb-mine", name }];
    await again.poll();
    expect(again.deleted).toEqual(["kb-mine"]);
    expect(again.logs.some((l) => l.startsWith(`backup kb-other ("Keeper ${ID} 00000000") is Keeper's, of no attempt it knows, and no attempt uses it: kept`))).toBe(true);
  });
  test("an attempt left unprotected by a restart keeps its backup, named in the log; no backup made means nothing to delete", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const name = r.saved!.attempts[ID].backupName!;
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-mine", name }];
    await again.poll(2);
    expect(again.a().status).toBe("unprotected");
    expect(again.deleted).toEqual([]);
    expect(again.logs.some((l) => l.startsWith(`backup kb-mine ("${name}") is Keeper's, of ${ID} (`))).toBe(true);
  });
  test("host_network is false in config.yaml, and the docs say the network mode is the real gate on the confirm commands", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^host_network: false$/m);
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    expect(docs).toContain("not secret from anyone who can read Keeper's log");
    expect(docs).toContain("the container's network mode is the real gate");
  });
});
