// Keeper: the attempt life cycle with a fake Supervisor and a fake clock, verdict binding and token
// refusal, /armed and its bindings, the Healthchecks queue, the rewind drop, and the options re-read
// without a restart. 0.1.3 (the third review's fixes): the signed registration over POST /attempt and
// its single use; the restore sent again only after a proven pre-execution refusal, and "rolled back"
// only on its job's success; alert checks per App, the shared-success suppression, the dead-man check
// and the phone test drill; no options write and no kept settings; local evidence only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { CONFIRM_MS, DELIVERY_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, RESTORE_LIMIT_MS, REWIND_MS, WATCH_MS, ARMED_MAX_MS, PHONE_MAX_MS, LOOP_FRESH_MS, checkId, keyFp, optionsHash, parseOptions, readShipToken, shipKey,
  ACCEPT_MS, CLAIM_MS, PAGE_ACK_MS, HC_READ_MS, judgeHc, HC_RW_WHY, KEY_CODE_MS, MHB_MAX_MS, MHB_CAP_MS, LIMITS_VERSION, PHONE_WINDOW_MS, DROP_TRIES,
  OLD_KEY_WHY, ENROLL_BEHIND, ENROLL_REFUSED, jobsWhy, CLEANUP_TICK_MS, KEPT_GRACE_MS, KEPT_MAX_MS, BACKUP_CHECK_WHY, OPTIONS_UNKNOWN_WHY, CODE_EPOCH,
  EXCLUDE_HASH, BACKUP_EXCLUDE, KEY_NAME, HOOK_BOUND_MS, SHIP_TTL_S, FIRST_BACKUP_BYTES, ROTATION_PROOF_TAP, revocation, excludedName, FOLLOWUPS_WHY, JOB_GRACE_MS, KEY_TMP_PREFIX,
  type AppInfo, type BackupInfo, type HcCheck, type JobState, type RestoreResult, type State, type InstallJob } from "../rootfs/opt/keeper/core.ts";
import { backupKeys, drillSpent, hcChecks, hcKeyStore, healthUrl, keyFiles, liveUrl, writeWhole } from "../rootfs/opt/keeper/main.ts";
import { supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { scanBackup } from "../rootfs/opt/keeper/scan.ts";
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
// (0.1.15) item 13: with its explicit kind "ship" (noKind: an older token without one)
function shipToken(o: { pr?: number; head?: string; exp?: number; repo?: string; key?: KeyObject; now?: number; noKind?: boolean } = {}): string {
  const claim = { v: 1, ...(o.noKind ? {} : { kind: "ship" }), repo: o.repo ?? "HyndeSyte/harness", pr: o.pr ?? 46, head: o.head ?? HEAD, exp: o.exp ?? Math.floor((o.now ?? T0) / 1000) + 7200 };
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
    out.push({ ...(uuid ? { unique_key: key } : { slug: id, unique_key: slugKey(id) }), status: "up", channels: "ch-phone", ...c, ...(over[id] ?? {}) });
  };
  add(o.hc_done, { timeout: 300, grace: 600 });
  add(o.hc_deadman, { timeout: 60, grace: 300 });
  for (const u of Object.values(o.hc_failed)) add(u, { timeout: 86_400, grace: 3600 });
  return out;
}

// (0.1.9) A check's unique key as the read-only API shows it, and the options with hc_unique_keys filled in for every role
// not set explicitly (arming refuses a role without one): a uuid's key, or a slug check's own key in this fake.
const slugKey = (id: string) => new Bun.CryptoHasher("sha1").update(`slug-${id}`).digest("hex");
function withKeys(opts: any): any {
  const o = parseOptions(opts);
  const set = new Set((Array.isArray(opts.hc_unique_keys) ? opts.hc_unique_keys : []).map((x: string) => String(x).split("=")[0]));
  const keys = [...(Array.isArray(opts.hc_unique_keys) ? opts.hc_unique_keys : [])];
  const roles: [string, string][] = [["done", o.hc_done], ["deadman", o.hc_deadman], ...o.watch.map((a) => [a, o.hc_failed[a] ?? o.hc_failed["*"] ?? ""] as [string, string])];
  for (const [role, url] of roles) {
    const id = checkId(url);
    if (!id || set.has(role)) continue;
    keys.push(`${role}=${/^[0-9a-f-]{36}$/.test(id) ? new Bun.CryptoHasher("sha1").update(id).digest("hex") : slugKey(id)}`);
  }
  return { ...opts, hc_unique_keys: keys };
}

let nonces = 0;
function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null; confirm?: boolean; hcKey?: string; limits?: boolean; uniq?: boolean; backupCheck?: boolean } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string; password?: string }[] = [];
  // (0.1.12) the backup key store (/data/backup-keys on the device): name to password, and each backup call's password
  const keys = new Map<string, string>();
  const passwords: (string | undefined)[] = [];
  const backupsMade: string[] = [];
  const jobCalls: string[] = [];
  const deleted: string[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    saveFails: false, deleteOk: true, keyStoreOk: true, keyLoadOk: true, free: 10 * 1024 ** 3 as number | null,
    // (0.1.7) the kept Healthchecks key (a file on the device), the backups list and the active install jobs
    hcKey: o.hcKey ?? "hc-read-key-0123456789", hcKeyWrites: 0, hcKeyWriteOk: true,
    backupsList: [] as { slug: string; name: string }[] | null, activeJobs: [] as string[] | null,
    app, alive: true, ready: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
    jobs: {} as Record<string, JobState>, jobsUp: true,
    // (0.1.15) the App's install and update jobs as the Supervisor lists them (install() adds one), and the drill flags' spent list
    installJobs: [] as InstallJob[], installJobsUp: true, spent: new Set<string>(), spentOk: true, spentListOk: true,
    hcUp: true, hcOver: {} as Record<string, Partial<HcCheck> | null>, hcReads: 0,
    // (0.1.4) the registration's wait for its backup: never fires unless a test makes it
    timer: (_ms: number): Promise<void> => new Promise(() => {}),
    makeBackup: async (a: string): Promise<{ slug: string } | { why: string }> => ({ slug: `kb-${a.slice(-4)}` }),
    pingFails: (_url: string) => !f.pingOk,
    backup: o.backup === null ? null : { homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: true, ...(o.backup ?? {}) } as BackupInfo | null,
    onRestore: () => { app.version = "0.16.0"; app.state = "started"; },
    options: {
      watch: [CAIN], health: [`${CAIN}=0fcc2575-cain:8098/ready`], tokens: [`${CAIN}=${TOKEN}`, `${HARNESS}=${HTOKEN}`],
      hc_done: "https://hc-ping.example/done", hc_deadman: "https://hc-ping.example/deadman", hc_failed: "https://hc-ping.example/failed",
      health_grace_s: 0, ship_public_key: PUB, drill_followups_open: false, ...(o.opts ?? {}),
    } as any,
  };
  const k = new Keeper({
    now: () => now, version: "0.1.0", self: "0fcc2575_keeper",
    appInfo: async (slug) => (f.infoUp && slug === CAIN ? { ...app } : null),
    backupInfo: async () => (f.backup ? { date: new Date(now).toISOString(), ...f.backup } : null),
    makeBackup: async (a, _name, password) => { backupsMade.push(a); passwords.push(password); return f.makeBackup(a); },
    restore: async (backup, a, password) => {
      restores.push({ backup, app: a, ...(password === undefined ? {} : { password }) });
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
    diskFree: async () => f.free,
    backupKeys: { store: (n, key) => { if (!f.keyStoreOk) return false; keys.set(n, key); return true; }, load: (n) => (f.keyLoadOk ? keys.get(n) ?? null : null),
      drop: (n) => keys.delete(n), list: () => [...keys.keys()] },
    hcKeyStore: { load: () => f.hcKey, store: (key) => { f.hcKeyWrites++; if (!f.hcKeyWriteOk) return false; f.hcKey = key; return true; } },
    job: async (uuid) => {
      jobCalls.push(uuid);
      if (!f.jobsUp) return null;
      const ij = f.installJobs.find((j) => j.uuid === uuid);
      return f.jobs[uuid] ?? (ij ? { found: true, uuid, done: ij.done, errors: ij.errors, name: ij.name, reference: CAIN } : { found: false });
    },
    installJobs: async () => (f.installJobsUp ? f.installJobs.map((j) => ({ ...j })) : null),
    drillSpent: { list: () => { if (!f.spentListOk) throw new Error("unreadable"); return [...f.spent]; }, add: (n) => { if (!f.spentOk || f.spent.has(n)) return false; f.spent.add(n); return true; } },
    hcChecks: async () => { f.hcReads++; return f.hcUp ? hcList(f.options, f.hcOver) : null; },
    timer: (ms) => f.timer(ms),
    lockCallMs: 50, lockStepMs: 300,                     // (0.1.8) the lock's bounds, short for the tests
    live: async () => f.alive,
    ready: async () => f.ready,
    ping: async (url, body) => { pings.push({ url, body }); return !f.pingFails(url); },
    options: () => JSON.parse(JSON.stringify(o.uniq === false ? f.options : withKeys(f.options))),
    save: (s) => { if (f.saveFails) return false; saved = JSON.parse(JSON.stringify(s)); return true; },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.useOptions(o.uniq === false ? f.options : withKeys(f.options));
  k.start();
  // (0.1.9) the backup check passed on the device, as at first setup
  if (o.backupCheck !== false && !k.st.backupCheck) k.st.backupCheck = { at: T0, names: ["hc-key"], slug: "bc-1", exclude: EXCLUDE_HASH };
  // (0.1.5) the owner's enrollment of the pinned key at the device, as at first setup (0.1.9: its code on demand, key-code)
  if (o.confirm !== false && shipKey(k.opts.ship_public_key)) { k.keyCode(); k.keyConfirm(keyFp(k.opts.ship_public_key), codeIn(logs, "key-confirm")); }
  // (0.1.7) the owner's acceptance of the accepted limits, as at first setup
  if (o.limits !== false) k.acceptLimits(codeIn(logs, "accept-limits"));
  const r = {
    k, f, logs, pings, restores, backupsMade, keys, passwords, jobCalls, deleted, get saved() { return saved; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    // A registration as Cain's link sends it (POST /attempt, 202), then its poll (GET /attempt/<id>) once
    // the background backup settled (0.1.5): 200 with the acceptance, or 409 with the refusal.
    // (0.1.14) a drill carries its mode (verdict-fail unless named) and a fresh flag nonce, and once accepted the link confirms the
    // signed drill mark it wrote (noMark: it never does)
    async register(over: any = {}, caller: string | null = CAIN) {
      const head = over.head ?? HEAD;
      const { noMark, ...rest } = over;
      const drill = rest.kind === "drill" ? { drill_mode: "verdict-fail", drill_nonce: (++nonces).toString(16).padStart(16, "0") } : {};
      const body: any = { token: shipToken({ head, now }), app: CAIN, pr: 46, head, from_version: "0.16.0", to_version: "0.17.0",
        probe_hash: HASH, kind: "ship", ...drill, ...rest };
      const ans = await k.registerAttempt(caller, body);
      if (ans.status !== 202) return ans;
      await k.whenSettled(String(ans.body.id));
      const v = k.attemptView(CAIN, String(ans.body.id));
      if (v.body.status === "accepted" && body.kind === "drill" && !noMark)
        expect(k.markAttempt(CAIN, String(ans.body.id), { mode: body.drill_mode, to_version: body.to_version, mark: "ab".repeat(32) }).status).toBe(200);
      return { status: v.body.status === "accepted" ? 200 : 409, body: v.body };
    },
    // (0.1.5) The link's claim of an accepted attempt, as the Ship run starts.
    claim(id = ID, over: any = {}) {
      const a = k.st.attempts[id];
      return k.claimAttempt(CAIN, id, { app: a?.app, from_version: a?.from, to_version: a?.to, backup: a?.backup, ...over });
    },
    async poll(n = 1) { for (let i = 0; i < n; i++) { await k.poll(); await k.deadman(); now += POLL_MS; } },
    // The install, claimed first by the link as the Ship run starts (claim false: an install with no claim). 0.1.15: the Ship run's
    // update makes the Supervisor's install job, listed from now (job false: a start with no install job)
    install(state = "started", claim = true, job = true) {
      if (claim) for (const a of k.open(CAIN)) if (a.status === "accepted") r.claim(a.id);
      if (job) r.job();
      app.version = "0.17.0"; app.state = state;
    },
    // (0.1.15) an install or update job of Cain made now (done unless told otherwise)
    job(o: Partial<InstallJob> = {}) { const j = { uuid: `inst-${f.installJobs.length + 1}`, created: now, done: true, errors: 0, name: "addon_update", ...o }; f.installJobs.push(j); return j; },
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
// (0.1.9) The link's rotation attestation, signed with its Ship key, as cain link/rotation.ts makes it.
// 0.1.10: version 2, bound to the keeper's current enrollment and the single-use challenge its GET /rotation issued (k).
function rotationToken(id: string, now: number, o: { key?: KeyObject; kind?: string; ttl?: number; k?: Keeper; enroll?: string; challenge?: string; v?: number } = {}): string {
  const view: any = o.k ? o.k.rotationView(CAIN).body : {};
  const payload = b64url(Buffer.from(JSON.stringify({ v: o.v ?? 2, kind: o.kind ?? "hc-key-rotated", id, enroll: o.enroll ?? view.enroll_id ?? "", challenge: o.challenge ?? view.challenge ?? "",
    exp: Math.floor(now / 1000) + (o.ttl ?? 3600) })));
  return `rot1.${payload}.${b64url(edSign(null, Buffer.from(`rot1.${payload}`), o.key ?? LINK))}`;
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
    expect(v.body).toEqual({ status: "accepted", id: ID, app: CAIN, from_version: "0.16.0", to_version: "0.17.0", kind: "ship", install_job: null, install_job_at: null, backup: "kb-late", until: new Date(T0 + ACCEPT_MS).toISOString(),
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
    ["isn't shown as protected true", { protected: undefined }, "isn't shown as protected (protected true)"],
    ["is shown as protected false (0.1.12: made without Keeper's key)", { protected: false }, "isn't shown as protected (protected true)"],
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
    let installedAt = 0;   // (0.1.15) when the Ship run's update made its install job
    const http = async (url: string, init: RequestInit) => {
      const path = url.replace("http://supervisor", "");
      calls.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (data: any) => new Response(JSON.stringify({ result: "ok", data }), { status: 200 });
      if (path === "/addons/self/info") return ok({ slug: "0fcc2575_keeper", version: "0.1.3", options });
      if (path === `/addons/${CAIN}/info`) return ok(app);
      if (path === "/backups/new/partial") return ok({ slug: "kb1" });
      if (path === "/backups/kb1/info") return ok({ homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: true, date: new Date(now).toISOString() });
      if (path === "/backups/kb1/restore/partial") { job = { name: "backup_manager_partial_restore", reference: "kb1", uuid: "j1", done: true, errors: [], child_jobs: [] }; app.version = "0.16.0"; app.state = "started"; return ok({ job_id: "j1" }); }
      // (0.1.15) the Ship run's update of Cain, listed as its install job once the version moved
      if (path === "/jobs/info") return ok({ jobs: [...(job ? [job] : []), ...(app.version === "0.17.0" || job ? [{ name: "addon_update", reference: CAIN, uuid: "u1", done: true, errors: [], created: new Date(installedAt).toISOString(), child_jobs: [] }] : [])] });
      if (path === "/host/info") return ok({ disk_free: 20.5 });   // (0.1.9) the free-space reserve's read
      return new Response(JSON.stringify({ result: "error" }), { status: 404 });
    };
    const sup = supervisor("t", "http://supervisor", http);
    let now = T0;
    const klogs: string[] = [];
    // (0.1.12) the real backup key store, in a temporary data folder
    const keyDir = join(mkdtempSync(join(tmpdir(), "keeper-bk-")), "backup-keys");
    const k = new Keeper({ now: () => now, version: "0.1.3", self: "0fcc2575_keeper", appInfo: sup.appInfo, backupInfo: sup.backupInfo, makeBackup: sup.makeBackup,
      restore: sup.restore, job: sup.job, live: async () => true, ready: async () => true, ping: async () => true, diskFree: sup.diskFree, backupKeys: backupKeys(keyDir), installJobs: sup.installJobs,
      options: () => sup.selfOptions(), save: () => {}, log: (l) => klogs.push(l) }, null);
    k.useOptions(options); k.start(); k.keyCode(); k.keyConfirm(keyFp(PUB), codeIn(klogs, "key-confirm"));
    const poll = async (n: number) => { for (let i = 0; i < n; i++) { await k.poll(); now += POLL_MS; } };
    await k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    await k.whenSettled(ID);
    await poll(2); expect(k.st.attempts[ID].status).toBe("accepted");
    expect(k.claimAttempt(CAIN, ID, { app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: "kb1" }).status).toBe(200);
    installedAt = now; app.version = "0.17.0"; await poll(1);
    k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: ID, result: "FAIL", reason: "x" });
    await poll(ROLL);
    expect(k.st.attempts[ID].status).toBe("rolled back");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /backups/new/partial", "POST /backups/kb1/restore/partial"]);
    expect(calls.some((c) => c.path === "/host/info")).toBe(true);   // (0.1.9) free space read before the backup
    // (0.1.12) the backup is protected with a password of 32 random bytes (base64url), kept in its key file; the restore sends the same
    const pw = String(writes[0].body.password ?? "");
    expect(pw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(keyDir, k.st.attempts[ID].backupName!), "utf8").trim()).toBe(pw);
    expect(writes[0].body).toEqual({ name: k.st.attempts[ID].backupName, addons: [CAIN], homeassistant: false, folders: [], background: false, password: pw });
    expect(k.st.attempts[ID].backupName).toMatch(new RegExp(`^Keeper ${ID} [0-9a-f]{8}$`));   // (0.1.7) attempt-specific
    expect(writes[1].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true, password: pw });
    expect(klogs.some((l) => l.includes(pw))).toBe(false);
    expect(JSON.stringify(k.st)).not.toContain(pw);
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
    expect(r.restores).toEqual([{ backup: "kb-cain", app: CAIN, password: r.keys.get(r.a().backupName!) }]);
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
    // 0.1.15: a terminal abort, paged as an alert (no install job was made during the claim)
    expect(r.a().status).toBe("aborted");
    expect(r.logs.some((l) => /^ship-46-cain-\w+: aborted \(no Supervisor install job of Cain was made during its claim claim-[0-9a-f]{16}\)/.test(l))).toBe(true);
    expect(r.restores).toEqual([]);
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("Keeper ended its hold on the install"))).toBe(true);
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
  const ans = await r.register({ head, kind: "drill", drill_mode: how === "exit" ? "exit-on-start" : "verdict-fail" });
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
    expect(v.binding).toEqual({ protocol: 1, probe_hash: HASH, keeper_version: "0.1.0", options_hash: optionsHash(parseOptions(withKeys(r.f.options)), r.f.hcKey), backup_scope: "app-only" });
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
    expect(r.code("key-confirm")).toBe(r.code("key-confirm"));
    r.k.keyCode();                                         // (0.1.9) the code on demand only
    expect(r.k.keyConfirm("0000000000000000", r.code("key-confirm"))).toEqual({ ok: false, why: `that fingerprint isn't the options' key's (${keyFp(NPUB)})` });
    expect(r.k.keyConfirm(keyFp(NPUB), r.code("key-confirm")).ok).toBe(true);
    expect(r.k.st.pinnedKey?.fp).toBe(keyFp(NPUB));
    expect((await r.register({ head: headN(4), token: shipToken({ key: NEW, head: headN(4), now: r.now }) })).status).toBe(200);
  });
  test("(0.1.6) key-confirm only on the container's own loopback, with the one-time code from the log", async () => {
    const r = rig({ confirm: false });
    const log: string[] = [];
    expect(r.code("key-confirm")).toBe("");               // (0.1.9) never printed at start
    r.k.keyCode();
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
    // (0.1.9) a restart prints no code; key-code prints a new one, which confirms once
    r.k.start();
    expect(r.code("key-confirm")).toBe(code);
    r.k.keyCode();
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
    expect(r.a().status).toBe("aborted");                 // 0.1.15: a terminal abort
    const line = `${ID}: aborted (its acceptance expired unclaimed (the link never claimed it)): a terminal abort, nothing installed under it is covered`;
    expect(r.logs).toContain(line);
    const q = rig(); await q.register(); q.advance(ACCEPT_MS + 1_000); await q.poll();
    expect(q.logs).toContain(line);
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
    expect(e.a().status).toBe("aborted");
    e.install("error", false); await e.poll(5);
    expect([e.a().status, e.restores.length]).toEqual(["unprotected", 0]);
    const c = rig(); await c.register(); await c.poll();
    expect((await c.k.cancel(CAIN, ID, { why: "the pass gave up" })).status).toBe(200);
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
    expect((await r.k.cancel(CAIN, ID, {})).status).toBe(200);
    finish({ slug: "kb-late" }); await r.k.whenSettled(ID);
    expect(r.a().status).toBe("ended");
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    expect((await r.k.cancel(HARNESS, ID, {})).status).toBe(403);
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
    r.k.keyCode();
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
  test("(0.1.9) a cancelled registration's backup is kept, bound to its generation, never deleted with the claim", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const slug = r.a().backup;
    expect((await r.k.cancel(CAIN, ID, { why: "gave up" })).status).toBe(200);
    await r.poll(3);
    expect(r.deleted).toEqual([]);
    expect(r.k.st.keptBackups![slug]).toMatchObject({ slug, attempt: ID, gen: r.a().gen, name: r.a().backupName });
    expect(r.a().gen).toBeGreaterThan(0);
    expect(r.logs.some((l) => l.startsWith(`${ID}: ended; backup kept: cancelled;`) && l.includes(`backup ${slug} "${r.a().backupName}"`))).toBe(true);
  });
  test("(0.1.9) a backup still being made when the registration is cancelled is kept and bound once it is made", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    for (let i = 0; i < 20 && !r.backupsMade.length; i++) await Bun.sleep(1);
    expect(r.backupsMade).toEqual([CAIN]);
    (await r.k.cancel(CAIN, ID, {}));
    r.f.backupsList = [{ slug: "kb-late", name: r.a().backupName! }];
    finish({ slug: "kb-late" }); await r.k.whenSettled(ID);
    await r.poll();
    expect(r.deleted).toEqual([]);
    expect(r.k.st.keptBackups!["kb-late"]).toMatchObject({ attempt: ID, gen: r.a().gen });
  });
  test("(0.1.9) an acceptance that expires unclaimed keeps its backup for the bounded cleanup", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const slug = r.a().backup;
    r.advance(ACCEPT_MS + 60_000); await r.poll(3);
    expect(r.a().status).toBe("aborted");                // 0.1.15: a terminal abort, the backup kept the same way
    expect(r.deleted).toEqual([]);
    expect(r.logs.some((l) => l.startsWith(`${ID}: ended; backup kept: aborted: its acceptance expired unclaimed`) && l.includes(slug))).toBe(true);
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
    const sec = docs.slice(docs.indexOf("## Accepted limits")).replace(/\s+/g, " ");
    expect(sec.length).toBeGreaterThan(100);
    expect(sec).toContain(`Text version ${LIMITS_VERSION} (0.1.15`);   // 0.1.15: version 7; 0.1.8: version 2; 0.1.9: version 3; 0.1.10: version 4; 0.1.11: version 5; 0.1.12: version 6
    expect(sec).toContain("an install of exactly the claimed version made");
    expect(sec).toContain("at the 14-day mark");
    expect(sec).toContain("never install from Home Assistant's page while a Ship run is live");
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
    const line = "the old option hc_api_key is still in Keeper's options: remove it (Keeper ignores it; the key is entered once with hc-key and kept outside the options), then rotate that key in the alert service, since earlier backups may hold it; until then Keeper doesn't arm and refuses hc-key";
    expect(r.logs.filter((l) => l === line)).toHaveLength(1);
    expect(r.k.hcKey).toBe("");
    expect(r.k.armableWhy()).toBe(OLD_KEY_WHY);          // (0.1.8) the gate
    const again = rig({ saved: r.saved, hcKey: "", opts: { hc_api_key: "old-option-key-0123456789" } });
    expect(again.logs.filter((l) => l === line)).toHaveLength(1);
    const gone = rig({ saved: r.saved });
    expect(gone.logs.includes(line)).toBe(false);
  });
});

describe("0.1.7: the claim record (claim, cancel, consume)", () => {
  test("a lost cancel, then the claim's expiry: the claim is unused, and (0.1.9) its backup kept for the bounded cleanup", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    const slug = r.a().backup;
    r.advance(CLAIM_MS + 60_000); await r.poll(2);
    expect(r.a().status).toBe("aborted");                // 0.1.15: no install job in its claim, a terminal abort
    expect(r.deleted).toEqual([]);
    expect(r.k.st.keptBackups![slug].reason).toContain("no Supervisor install job of Cain was made during its claim");
  });
  test("(0.1.9) the expiry while an install job runs: the claim ends, the backup is kept and bound, and the cleanup doesn't run beside the install", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.f.activeJobs = ["addon_manager_update"];
    r.f.backupsList = [{ slug: r.a().backup, name: r.a().backupName! }];
    r.advance(CLAIM_MS + 60_000); await r.poll();
    expect(r.a().status).toBe("aborted");
    expect(r.k.st.keptBackups![r.a().backup]).toMatchObject({ gen: r.a().gen });
    r.advance(3 * 86_400_000); await r.poll(2);
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain(`the cleanup of kept backups (the daily tick) didn't run: an install or update of ${CAIN} is running`);
  });
  test("a cancel after the claim was handed to a started run (a version change seen) is refused", async () => {
    const r = rig();
    await watching(r);
    const c = (await r.k.cancel(CAIN, ID, { why: "late" }));
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
    expect((await c.k.cancel(CAIN, ID, { why: "gave up", request: "cancel-0123456789" })).status).toBe(200);
    expect((await c.k.cancel(CAIN, ID, { why: "gave up" })).body).toEqual({ status: "ended", id: ID, recorded: true });
    expect(c.logs).toContain(`a retry of the cancel of ${ID}: the recorded outcome (ended)`);
    // a retried claim of a cancelled attempt reads why it ended (0.1.15: the cancel asked first)
    expect(c.claim(ID).body.why).toContain("a cancel was asked for it");
  });
  test("claim and cancel run one at a time under the record's lock, in the order they came", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const a = r.a();
    const body = { app: a.app, from_version: a.from, to_version: a.to, backup: a.backup };
    const [cl, ca] = await Promise.all([r.k.claim(CAIN, ID, body), r.k.cancel(CAIN, ID, { why: "x" })]);
    // 0.1.15 item 9: the cancel is recorded as asked the moment it arrives, so the claim queued before it is refused and the cancel ends it
    expect([cl.status, ca.status]).toEqual([409, 200]);
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
    expect(codeIn(r.logs, "key-confirm")).toBe(before);   // (0.1.9) a changed key prints no code by itself
    r.k.keyCode();
    const now2 = codeIn(r.logs, "key-confirm");
    expect(now2).not.toBe(before);
    // forge: the new code checked against the old fingerprint's challenge is refused; the right one works once
    r.k.st.codes!.key!.challenge = keyFp(PUB);
    expect(r.k.keyConfirm(keyFp(pub2), now2).why).toContain("printed for another challenge");
    r.k.st.codes!.key!.challenge = keyFp(pub2);
    expect(r.k.keyConfirm(keyFp(pub2), now2)).toEqual({ ok: true, why: "" });
    expect(r.k.keyConfirm(keyFp(pub2), now2).ok).toBe(false);
    // 0.1.8: a start prints a key code only while unenrolled; enrolled, the owner asks for one with key-code
    const again = rig({ saved: r.saved, opts: { ship_public_key: pub2 }, confirm: false });
    expect(codeIn(again.logs, "key-confirm")).toBe("");
    expect(again.k.keyCode().ok).toBe(true);
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
    again.k.keyCode();                                     // (0.1.8) the code on demand while enrolled
    expect(again.k.keyConfirm(keyFp(PUB), again.code("key-confirm"))).toEqual({ ok: true, why: "" });
    expect(again.k.st.pinnedKey!.enrollId).not.toBe(id1);
    expect(again.k.enrollment()).toMatchObject({ enroll_id: again.k.st.pinnedKey!.enrollId });
    expect(again.logs.some((l) => l.includes("it replaces its earlier confirm (a re-enrollment)"))).toBe(true);
  });
});

describe("0.1.7: orphan backups by their own name, and the network mode", () => {
  test("the backup's name is kept before the call; after a restart lost its slug, a cancelled attempt's backup is found by that exact name and (0.1.9) bound, not deleted", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});         // the backup call never answers in this process
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const name = r.saved!.attempts[ID].backupName!;
    expect(name).toMatch(new RegExp(`^Keeper ${ID} [0-9a-f]{8}$`));
    (await r.k.cancel(CAIN, ID, {}));
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-other", name: `Keeper ${ID} 00000000` }, { slug: "kb-mine", name }];
    await again.poll();
    expect(again.deleted).toEqual([]);
    expect(again.k.st.keptBackups!["kb-mine"]).toMatchObject({ attempt: ID, name });
    expect(again.logs).toContain(`${ID}: found its backup kb-mine by its own name "${name}"`);
    expect(again.logs.some((l) => l.startsWith(`backup kb-other ("Keeper ${ID} 00000000") is named like Keeper's but has no generation record here: never deleted by Keeper`))).toBe(true);
  });
  test("an attempt left unprotected by a restart keeps its backup: adopted by its name with its generation, deleted only by the bounded cleanup past 48 hours", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const name = r.saved!.attempts[ID].backupName!;
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-mine", name }];
    await again.poll(2);
    expect(again.a().status).toBe("unprotected");
    expect(again.k.st.keptBackups!["kb-mine"]).toMatchObject({ attempt: ID, gen: again.a().gen });   // (0.1.10) adopted, not left unrecorded
    again.advance(24 * 3_600_000); await again.poll(2);
    expect(again.deleted).toEqual([]);
    again.advance(2 * 86_400_000); await again.poll(2);
    expect(again.deleted).toEqual(["kb-mine"]);
  });
  test("host_network is false in config.yaml, and the docs say the network mode is the real gate on the confirm commands", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^host_network: false$/m);
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    expect(docs).toContain("not secret from anyone who can read Keeper's log");
    expect(docs).toContain("the container's network mode is the real gate");
  });
});

// -- 0.1.8 (the eighth review's fixes) -------------------------------------------------------------------
const localCall = (r: ReturnType<typeof rig>, path: string, body: any = {}) =>
  handleLocal(r.k, new Request(`http://127.0.0.1:8096${path}`, { method: "POST", body: JSON.stringify(body) }), "127.0.0.1", () => {});
describe("0.1.8: the accepted limits (text version 6 since 0.1.12)", () => {
  test("the text is version 6, and an acceptance of version 2 lapses: a new code at start, not armed until accepted again", async () => {
    expect(LIMITS_VERSION).toBe(7);
    const r = await armedRig();
    const saved = JSON.parse(JSON.stringify(r.saved));
    saved.limits = { version: 2, at: T0 };
    const again = rig({ saved, limits: false });
    expect(again.logs.some((l) => l.startsWith("the accepted limits' text changed (version 2 accepted, now 7)"))).toBe(true);
    expect(again.k.limitsOk()).toBe(false);
    expect(again.k.armedState(CAIN).why).toBe("the owner hasn't accepted the limits in Keeper's DOCS (Accepted limits, text version 7): accept-limits <code>");
    expect(again.k.acceptLimits(again.code("accept-limits" as any)).ok).toBe(true);
    expect(again.k.st.limits!.version).toBe(7);
  });
  test("the DOCS' text carries each statement of both limits", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    const sec = docs.slice(docs.indexOf("## Accepted limits"), docs.indexOf("## Options")).replace(/\s+/g, " ");
    for (const t of [
      "Text version 7 (0.1.15)",
      // the installer limit
      "refuses after two silences, or whose cancel is lost, leaves a live claim on the keeper for up to 30 minutes with no Ship run live",
      "never install from Home Assistant's page while a Ship run is live, or until the keeper's log shows no live claim (up to 30 minutes after a refused or failed run)",
      "logs every claim's start and end with its deadline, one line each",
      "one pending Ship run per attempt",
      "refused with the claim's latest expiry named",
      // the delivery limit
      "the read-only key cannot see notification channels",
      "unassigning or breaking the phone channel in the alert service is invisible until the next phone test or drill",
      "the owner's own attestation that the alert appeared on the phone",
      "arming lapses when the next drill is missed or fails, at the 14-day mark",
      "`drill_days`",
    ]) expect(sec).toContain(t);
    // the confirm's docs say it is an attestation too
    const arming = docs.slice(docs.indexOf("## Arming"), docs.indexOf("## Accepted limits")).replace(/\s+/g, " ");
    expect(arming).toContain("your own attestation that the alert appeared on your phone");
  });
  test("each claim's start and end is logged with its deadline, one line each: consumed, expired, cancelled", async () => {
    const r = rig();
    await watching(r);
    const c = r.a().claim!;
    const until = new Date(c.until).toISOString();
    expect(r.logs.filter((l) => l.startsWith(`claimed ${ID} claim ${c.id} `) && l.endsWith(`until ${until}`))).toHaveLength(1);
    expect(r.logs.filter((l) => l === `claim ${c.id} of ${ID} ended (consumed by the install it covers); its deadline was ${until}`)).toHaveLength(1);
    const e = rig();
    await e.register(); await e.poll(); e.claim();
    const ec = e.a().claim!;
    e.advance(CLAIM_MS + 60_000); await e.poll(3);
    expect(e.logs.filter((l) => l.startsWith(`claim ${ec.id} of ${ID} ended (aborted: no Supervisor install job of Cain was made during its claim ${ec.id}); its deadline was `))).toHaveLength(1);
    const x = rig();
    await x.register(); await x.poll(); x.claim();
    const xc = x.a().claim!;
    expect((await x.k.cancel(CAIN, ID, { why: "the pass gave up" })).status).toBe(200);
    expect(x.logs.filter((l) => l.startsWith(`claim ${xc.id} of ${ID} ended (ended: cancelled by Cain's link`))).toHaveLength(1);
  });
  test("drill_days (1 to 14, default 14) sets how long the phone test and the missed-heartbeat drill count, with a reminder before each is due", async () => {
    expect(parseOptions({}).drill_days).toBe(14);
    expect(parseOptions({ drill_days: 3 }).drill_days).toBe(3);
    expect(parseOptions({ drill_days: 30 }).drill_days).toBe(14);
    expect(parseOptions({ drill_days: 0 }).drill_days).toBe(14);
    const r = await armedRig({ drill_days: 3 });
    r.advance(2 * 86_400_000 + 3_600_000); await r.poll();
    expect(r.logs.some((l) => l.startsWith("drill due: run the phone test (phone-test, then phone-confirm) again before ") && l.includes("(drill_days 3)"))).toBe(true);
    expect(r.logs.some((l) => l.startsWith("drill due: run the missed-heartbeat drill (missed-heartbeat, then missed-heartbeat-confirm) again before "))).toBe(true);
    const n = r.logs.filter((l) => l.startsWith("drill due:")).length;
    await r.poll(2);
    expect(r.logs.filter((l) => l.startsWith("drill due:")).length).toBe(n);   // once per confirm
    r.advance(86_400_000); await r.poll();
    expect(r.k.armedView(CAIN).why).toContain("in the last 3 days");
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^  drill_days: 14$/m);
    expect(cfg).toMatch(/^  drill_days: int\(1,14\)\?$/m);
  });
});

describe("0.1.8: the old key option gated, the key file 0600 from its first byte", () => {
  test("arming and hc-key are refused while hc_api_key is in the options as the Supervisor holds them, and allowed once it is gone", async () => {
    const r = rig({ hcKey: "", opts: { hc_api_key: "old-option-key-0123456789" } });
    expect(r.k.armableWhy()).toBe(OLD_KEY_WHY);
    expect(OLD_KEY_WHY).toBe("the old option hc_api_key is still in Keeper's options: remove it, then rotate that key in the alert service");
    const code = r.code("hc-key" as any);
    const res = await localCall(r, "/hc-key", { code, key: "hc-read-key-0123456789" });
    expect(res.status).toBe(409);
    expect((await res.json()).why).toBe(OLD_KEY_WHY);
    expect(r.f.hcKeyWrites).toBe(0);
    expect(r.k.armedState(CAIN).why).toBe(`the keeper is not armable: ${OLD_KEY_WHY}`);
    await r.k.refreshHc();
    expect(r.k.phoneTest().why).toBe(`not armable: ${OLD_KEY_WHY}`);
    // the owner removes it: the next options read lifts the gate, and the code still stands
    delete r.f.options.hc_api_key; await r.poll();
    expect(r.k.armableWhy()).not.toBe(OLD_KEY_WHY);
    const ok = await localCall(r, "/hc-key", { code, key: "hc-read-key-0123456789" });
    expect(ok.status).toBe(200);
    // (0.1.9) and arming waits for the old key's rotation, attested by the owner's tap (the link's signed attestation)
    expect(r.k.armableWhy()).toContain("isn't attested as rotated");
    expect((await r.k.attestRotation(CAIN, { attestation: rotationToken(r.k.st.oldKey!.id, r.now, { k: r.k }) })).status).toBe(200);
    expect(r.k.armableWhy()).toBe("");
  });
  test("the key file through the real store: an exclusive temporary file opened 0600, the key fsynced, then renamed; never a wider mode", async () => {
    const { mkdtempSync, statSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keeper-hckey-"));
    const path = join(dir, "hc-key");
    writeFileSync(path, "old\n", { mode: 0o644 });          // an earlier file with a wider mode is replaced, not reused
    const temps: number[] = [];
    const store = hcKeyStore(path, (tmp) => { temps.push(statSync(tmp).mode & 0o777); expect(readFileSync(tmp, "utf8")).toBe("hc-read-key-0123456789\n"); });
    expect(store.store("hc-read-key-0123456789")).toBe(true);
    expect(temps).toEqual([0o600]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.load()).toBe("hc-read-key-0123456789");
    expect(readdirSync(dir)).toEqual(["hc-key"]);           // no temporary file left
    const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", "main.ts"), "utf8");
    expect(src).not.toContain("chmodSync");
    expect(src).toContain("O_EXCL");
    // a write that fails leaves no temporary file behind
    expect(() => writeWhole(join(dir, "missing", "x"), "y")).toThrow();
  });
  test("the docs: rotate the old key (earlier backups may hold it), the key file's write, and the backup's omission among the device checks", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    const rel = readFileSync(join(import.meta.dir, "..", "..", "RELEASING.md"), "utf8").replace(/\s+/g, " ");
    for (const t of [docs, rel]) { expect(t).toContain("rotate"); expect(t).toContain("earlier backups may hold it"); }
    expect(docs).toContain("0600 from its first byte");
    const checks = docs.slice(docs.indexOf("**The checks before arming, refusals in code (0.1.9)"));   // 0.1.9: refusals now
    expect(checks).toContain("**The backup check.**");
    expect(checks).toContain("a key that can write is refused");
    expect(checks).toContain("hc_unique_keys");
  });
});

describe("0.1.8: the cancel path reads the jobs list; the unused expiry's extra poll", () => {
  const claimed = async () => { const r = rig(); await r.register(); await r.poll(); r.claim(); return r; };
  test("(0.1.9) a cancel during an active install or update of the App ends the claim and keeps its backup, bound, logged with why", async () => {
    const r = await claimed();
    r.f.activeJobs = ["addon_manager_update"];
    const c = await r.k.cancel(CAIN, ID, { why: "the pass gave up" });
    expect(c.status).toBe(200);
    expect(c.body.backup_kept).toBe(r.a().backup);
    expect(r.a().status).toBe("ended");
    expect(r.logs.some((l) => l.startsWith(`${ID}: ended; backup kept: cancelled while an install or update of ${CAIN} is running (addon_manager_update)`) && l.includes(r.a().backupName!))).toBe(true);
    expect(r.k.st.keptBackups![r.a().backup]).toMatchObject({ attempt: ID, gen: r.a().gen });
    await r.poll(2);
    expect(r.deleted).toEqual([]);
  });
  test("an active job on the App whose name isn't recognized is named in the kept reason; a backup job isn't in the way", async () => {
    const r = await claimed();
    r.f.activeJobs = ["addon_something_new"];
    const c = await r.k.cancel(CAIN, ID, { why: "x" });
    expect(c.status).toBe(200);
    expect(r.k.st.keptBackups![r.a().backup].reason).toContain(`an active job on ${CAIN} that Keeper doesn't recognize is running (addon_something_new)`);
    expect(jobsWhy(CAIN, ["backup_manager_partial_backup"])).toBe("");
    expect(jobsWhy(CAIN, ["backup_manager_partial_restore"])).toContain("an install or update");
  });
  test("a jobs list that can't be read, a thrown call or a hung one: the cancel still ends the claim, and the backup is kept", async () => {
    for (const jobs of ["null", "throw", "hang"]) {
      const r = await claimed();
      (r.k as any).d.activeJobs = jobs === "null" ? async () => null : jobs === "throw" ? async () => { throw new Error("boom"); } : () => new Promise(() => {});
      const t = Date.now();
      expect((await r.k.cancel(CAIN, ID, { why: "x" })).status).toBe(200);
      expect(Date.now() - t).toBeLessThan(1_000);
      expect(r.a().status).toBe("ended");
      expect(r.k.st.keptBackups![r.a().backup].reason).toContain("the Supervisor's jobs list couldn't be read");
      await r.poll(); expect(r.deleted).toEqual([]);
    }
  });
  test("(0.1.9) a clean cancel ends the claim and keeps its backup too", async () => {
    const r = await claimed();
    expect((await r.k.cancel(CAIN, ID, { why: "gave up" })).status).toBe(200);
    expect(r.a().status).toBe("ended");
    await r.poll();
    expect(r.deleted).toEqual([]);
  });
  test("(0.1.9) the unused expiry keeps the backup; an install seen after it is unprotected and its backup kept for a rollback by hand", async () => {
    const r = await claimed();
    r.advance(CLAIM_MS + 60_000); await r.poll(3);
    expect(r.a().status).toBe("aborted");
    expect(r.deleted).toEqual([]);
    const v = await claimed();
    v.advance(CLAIM_MS + 60_000); await v.poll();
    v.f.app.version = "0.17.0"; await v.poll(3);
    expect(v.a().status).toBe("unprotected");
    expect(v.deleted).toEqual([]);
    expect(v.logs).toContain(`${ID}: kept its backup ${v.a().backup}: ${CAIN} moved to 0.17.0 after it ended: a rollback by hand may need it`);
  });
});

describe("0.1.8: the lock's bounds", () => {
  test("a step that throws is caught, logged, and the lock released for the next one", async () => {
    const r = rig();
    await expect(r.k.record(() => { throw new Error("a broken step"); })).rejects.toThrow("a broken step");
    expect(r.logs.some((l) => l.startsWith("a step under the claim record's lock failed (a broken step): the lock is released for the next one"))).toBe(true);
    expect(await r.k.record(() => "next")).toBe("next");
    expect(await r.k.record(() => { throw new Error("x"); }, (why) => `fallback: ${why}`)).toBe("fallback: x");
  });
  test("a step that hangs past its bound is logged, answered by its fallback, and the lock released", async () => {
    const r = rig();
    const hung = r.k.record(() => new Promise<string>(() => {}), (why) => `fallback: ${why}`);
    const next = r.k.record(() => "next");
    expect(await hung).toBe("fallback: it ran past 0.3 seconds");
    expect(await next).toBe("next");
  });
  test("a claim that crosses its deadline while queued behind a slow step is refused: the deadline is read under the lock", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const a = r.a();
    const slow = r.k.record(() => new Promise<string>(() => {}), () => "fallback");   // a step ahead of it hangs (0.1.9: the cancel no longer refuses)
    const claim = r.k.claim(CAIN, ID, { app: a.app, from_version: a.from, to_version: a.to, backup: a.backup });
    r.advance(ACCEPT_MS + 1_000);                             // the acceptance runs out while the claim waits
    expect(await slow).toBe("fallback");
    const c = await claim;
    expect(c.status).toBe(409);
    expect(c.body.why).toBe("its acceptance expired");
    expect(r.a().status).toBe("aborted");
  });
  test("a consume decides on the time read under the lock: an install first seen after the claim's deadline isn't consumed", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.advance(CLAIM_MS + 1_000);
    r.f.app.version = "0.17.0";
    await r.poll();
    expect(r.a().consumedAt).toBeUndefined();
    expect(r.a().status).toBe("unprotected");
  });
});

describe("0.1.8: the counter, re-enrollment and key-code", () => {
  test("/armed is answered under the lock, after its counter is saved; an answer whose counter couldn't be saved carries no enrollment", async () => {
    const r = rig();
    let release!: () => void;
    const held = r.k.record(() => new Promise<void>((ok) => { release = ok; }));
    let answered = false;
    const armed = r.k.armed(CAIN).then((v) => { answered = true; return v; });
    await Bun.sleep(10);
    expect(answered).toBe(false);                            // serialized behind the step that holds the lock
    release(); await held;
    const v = await armed;
    expect(v.counter).toBe(r.saved!.counter);                // the very counter on disk
    r.f.saveFails = true;
    const n = await r.k.armed(CAIN);
    expect(n.armed).toBe(false);
    expect(n.why).toBe("Keeper couldn't save its state, so this read carries no enrollment");
    expect(n.counter).toBeUndefined();
    expect(n.enroll_id).toBeUndefined();
    // and over HTTP
    r.f.saveFails = false;
    const res = await handle(r.k, new Request("http://keeper:8097/armed", { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.32.5", () => {});
    expect((await res.json()).counter).toBe(r.saved!.counter);
  });
  test("the link's cancel after an enrollment refusal: logged, a key code printed now and at the next start, cleared by key-confirm", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const before = r.code("key-confirm");
    await r.k.cancel(CAIN, ID, { why: `${ENROLL_BEHIND}: the keeper's counter (9) is lower than the 10 the link recorded` });
    expect(r.logs).toContain("enrollment counter behind the link: re-enroll with key-confirm (key-code prints a code)");
    expect(r.code("key-confirm")).toBe(before);            // (0.1.9) no code printed by itself
    expect(r.k.st.enrollRefused).toBe(r.now);
    const again = rig({ saved: r.saved, confirm: false });
    expect(again.logs.some((l) => l.startsWith("the link refused Keeper's enrollment at "))).toBe(true);
    expect(again.code("key-confirm")).toBe("");            // (0.1.9) never at start
    again.k.keyCode();
    const code = again.code("key-confirm");
    expect(code).toMatch(/^[0-9a-f]{10}$/);
    expect(again.k.keyConfirm(keyFp(PUB), code).ok).toBe(true);
    expect(again.k.st.enrollRefused).toBeUndefined();
    const third = rig({ saved: again.saved, confirm: false });
    expect(third.code("key-confirm")).toBe("");            // enrolled again: no code at start
    const other = rig();
    await other.register(); await other.poll();
    await other.k.cancel(CAIN, ID, { why: `${ENROLL_REFUSED}: the keeper's key was confirmed at another time` });
    expect(other.logs).toContain("the link refused Keeper's enrollment: re-enroll with key-confirm (key-code prints a code)");
  });
  test("key-code over the loopback listener prints a fresh code; the App network's listener refuses it", async () => {
    const r = rig();
    const before = r.code("key-confirm");
    const res = await localCall(r, "/key-code");
    expect(res.status).toBe(200);
    expect(r.code("key-confirm")).not.toBe(before);
    expect(r.k.keyConfirm(keyFp(PUB), r.code("key-confirm")).ok).toBe(true);
    const net = await handle(r.k, new Request("http://keeper:8097/key-code", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.32.5", () => {});
    expect(net.status).toBe(403);
    const fresh = rig({ confirm: false });                  // (0.1.9) unenrolled: still no code until key-code
    expect(fresh.code("key-confirm")).toBe("");
    expect(fresh.logs).toContain("the Ship key isn't enrolled: key-code prints a code on demand, then key-confirm <fingerprint> <code>");
  });
});

// -- 0.1.9 (the ninth review's fixes, a scoped round) -----------------------------------------------------
// A tar archive as the Supervisor's backups hold them (ustar headers), for the backup check's scan.
// (0.1.12) a name ending in "/" is a folder entry (type 5)
function tarOf(entries: [string, string | Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, body] of entries) {
    const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
    put(name, 0); put("0000600\0", 100); put("0000000\0", 108); put("0000000\0", 116);
    put(data.length.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136); put("        ", 148); put(name.endsWith("/") ? "5" : "0", 156); put("ustar\0", 257); put("00", 263);
    const sum = h.reduce((a, b) => a + b, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// A Home Assistant backup of Keeper: the outer tar with backup.json and the App's own tar.gz holding its data folder.
const { gzipSync } = await import("node:zlib");
const haBackup = (files: [string, string][]) => tarOf([["./backup.json", "{}"], ["./0fcc2575_keeper.tar.gz", gzipSync(tarOf(files))]]);

describe("0.1.9 A1: the lock's generation fences a timed-out step", () => {
  test("a hung step resuming after the lock's release changes nothing (a cancel whose jobs read hangs past the step's bound)", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    (r.k as any).d.lockCallMs = 10_000;                    // the call's own bound longer than the step's
    let release: (v: string[]) => void = () => {};
    (r.k as any).d.activeJobs = () => new Promise<string[]>((res) => { release = res; });
    const cancel = r.k.cancel(CAIN, ID, { why: "x" });
    const c = await cancel;
    expect(c.status).toBe(503);
    expect(r.a().status).toBe("claimed");
    const next = await r.k.armed(CAIN);                    // the next step ran under the lock
    expect(next.app).toBe(CAIN);
    release([]);                                           // the hung step resumes now
    for (let i = 0; i < 5; i++) await Bun.sleep(1);
    expect(r.a().status).toBe("claimed");
    expect(r.a().cancel).toBeUndefined();
    expect(r.k.st.keptBackups ?? {}).toEqual({});
  });
  test("expiry between the check and the write: a write after the step's time ran out is refused, and logged", async () => {
    const r = rig();
    let checked = false, wrote = false;
    const step = r.k.record(async (f) => {
      checked = f.live();
      await Bun.sleep(400);                                 // past the step's 300 ms bound
      await f.write("a test delete", async () => { wrote = true; return true; });
      if (f.live()) r.k.st.lastSeen.x = "changed";
      return "done";
    }, () => "timed out");
    expect(await step).toBe("timed out");
    await Bun.sleep(150);
    expect(checked).toBe(true);
    expect(wrote).toBe(false);
    expect(r.k.st.lastSeen.x).toBeUndefined();
    expect(r.logs.some((l) => l.startsWith("a test delete not done: its step's generation"))).toBe(true);
  });
  test("expiry during a write: a delete in flight when the step runs out keeps the lock until it ends", async () => {
    const r = rig();
    const order: string[] = [];
    let finish: (v: boolean) => void = () => {};
    const step = r.k.record(async (f) => {
      await f.write("a slow delete", () => new Promise<boolean>((res) => { finish = res; }), () => order.push("delete recorded"));
      return "done";
    }, () => "timed out");
    const next = r.k.record(() => { order.push("next step"); return "next"; });
    await Bun.sleep(400);                                   // the step's bound passed with the delete in flight
    expect(order).toEqual([]);
    finish(true);
    expect(await step).toBe("timed out");
    expect(await next).toBe("next");
    expect(order).toEqual(["delete recorded", "next step"]);
    expect(r.logs.some((l) => l.includes("with a write in flight: the lock is held until that write ends"))).toBe(true);
  });
  test("a competing generation: the next step's generation is live, the timed-out one's never again", async () => {
    const r = rig();
    let first: any = null, second: any = null;
    let go: () => void = () => {};
    const s1 = r.k.record(async (f) => { first = f; await new Promise<void>((res) => { go = res; }); return f.live(); }, () => false);
    expect(await s1).toBe(false);
    const s2 = r.k.record(async (f) => { second = f; expect(first.live()).toBe(false); return f.live(); });
    expect(await s2).toBe(true);
    expect(second.gen).toBeGreaterThan(first.gen);
    expect(await first.write("a late write", async () => true)).toBeNull();
    go();
  });
});

describe("0.1.9 A2: the key file's temporary file inside the backup exclusion", () => {
  test("the temporary file has the fixed prefix hc-key.tmp-, which backup_exclude covers; the old spelling is legacy", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keeper-tmp-"));
    let seen = "";
    expect(hcKeyStore(join(dir, "hc-key"), (t) => { seen = t; }).store("hc-read-key-0123456789")).toBe(true);
    const base = seen.split("/").pop()!;
    expect(base.startsWith("hc-key.tmp-")).toBe(true);
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    const globs = [...cfg.matchAll(/^  - "([^"]+)"$/gm)].map((m) => m[1]);
    expect(globs).toContain("hc-key*");
    expect(new Bun.Glob("hc-key*").match(base)).toBe(true);
    expect(new Bun.Glob("hc-key*").match("hc-key.4242.abcdefabcdef.tmp")).toBe(true);
  });
  test("a crash between write and rename: every start removes and logs the leftovers, the legacy temporary names included", async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keeper-sweep-"));
    writeFileSync(join(dir, "hc-key"), "real-key-0123456789\n");
    writeFileSync(join(dir, "hc-key.tmp-0a1b2c3d4e5f"), "half-written\n");
    writeFileSync(join(dir, "hc-key.4242.abcdefabcdef.tmp"), "from 0.1.8\n");
    writeFileSync(join(dir, "hc-key-old"), "keeper-sentinel-abc\n");
    writeFileSync(join(dir, "state.json"), "{}");
    const files = keyFiles(dir);
    expect(files.sweep().sort()).toEqual(["hc-key-old", "hc-key.4242.abcdefabcdef.tmp", "hc-key.tmp-0a1b2c3d4e5f"]);
    expect(readdirSync(dir).sort()).toEqual(["hc-key", "state.json"]);
    // at start, through the keeper
    const r = rig({ saved: null });
    (r.k as any).d.keyFiles = { place: () => [], clear: () => {}, sweep: () => ["hc-key.tmp-0a1b2c3d4e5f", "hc-key.4242.abcdefabcdef.tmp"] };
    r.k.start();
    expect(r.logs).toContain("removed a leftover key file hc-key.tmp-0a1b2c3d4e5f (a temporary file from an interrupted write)");
    expect(r.logs).toContain("removed a leftover key file hc-key.4242.abcdefabcdef.tmp (a temporary file from an interrupted write)");
  });
});

describe("0.1.9 B: the bounded cleanup of kept backups", () => {
  // A kept backup of an ended attempt, as a cancel leaves it; the list holds it under its own name.
  async function keptOne(r: ReturnType<typeof rig>, head = HEAD) {
    const id = idOf(head);
    r.f.makeBackup = async () => ({ slug: `kb-${r.backupsMade.length}` });   // a slug of its own for each backup
    await r.register({ head }); await r.poll();
    await r.k.cancel(CAIN, id, { why: "gave up" });
    const a = r.k.st.attempts[id];
    r.f.backupsList = [...(r.f.backupsList ?? []), { slug: a.backup, name: a.backupName! }];
    return a;
  }
  test("only Keeper's own kept backups are deleted: an owner backup older than 48 hours, an unrecorded Keeper name and a drill's survive", async () => {
    const r = rig();
    const a = await keptOne(r);
    r.f.backupsList!.push({ slug: "owner1", name: "Automatic backup 2026.11.1" }, { slug: "kb-x", name: `Keeper ${idOf(headN(9))} 0a0b0c0d` });
    r.advance(49 * 3_600_000);
    r.k.st.cleanupAt = r.now - CLEANUP_TICK_MS;            // the daily tick is due
    await r.poll();
    expect(r.deleted).toEqual([a.backup]);
    expect(r.logs.some((l) => l.startsWith(`the cleanup deleted kept backup ${a.backup} ("${a.backupName}") of ${a.id}, generation ${a.gen}, 49 hours after its claim ended`))).toBe(true);
    expect(r.k.st.keptBackups).toEqual({});
  });
  test("the grace: nothing within 2 hours of a claim's end; past it at most two kept, the oldest deleted first", async () => {
    const r = rig();
    const a1 = await keptOne(r, headN(1)); r.advance(60_000);
    const a2 = await keptOne(r, headN(2)); r.advance(60_000);
    const a3 = await keptOne(r, headN(3));
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);                          // all three inside the 2-hour grace
    r.advance(KEPT_GRACE_MS);
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([a1.backup]);
    expect(Object.keys(r.k.st.keptBackups!).sort()).toEqual([a2.backup, a3.backup].sort());
  });
  test("never beside a live claim, never while an install job runs, never with a jobs list it can't read", async () => {
    const r = rig();
    const a = await keptOne(r, headN(1));
    await r.register({ head: headN(2) }); await r.poll(); r.claim(idOf(headN(2)));
    r.advance(49 * 3_600_000);                              // the claim is past its deadline but not yet ended: expiring
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain(`the cleanup of kept backups (the daily tick) didn't run: ${idOf(headN(2))} is claimed (never beside a live or expiring claim)`);
    await r.k.cancel(CAIN, idOf(headN(2)), {});
    r.f.activeJobs = ["addon_manager_install"];
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    r.f.activeJobs = null;
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
    r.f.activeJobs = [];
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([a.backup]);
  });
  test("the claim and generation are read again right before each delete: a changed generation leaves the backup", async () => {
    const r = rig();
    const a = await keptOne(r);
    r.advance(49 * 3_600_000);
    r.k.st.keptBackups![a.backup].gen = a.gen! + 7;        // a record bound to another generation
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
  });
  test("the daily tick holds the bound: kept at most 48 hours plus one tick", async () => {
    const r = rig();
    const a = await keptOne(r);
    for (let h = 0; h < 72 && !r.deleted.length; h++) { r.advance(3_600_000); await r.poll(); }
    expect(r.deleted).toEqual([a.backup]);
    const age = r.now - r.k.st.attempts[a.id].endedAt!;
    expect(age).toBeLessThanOrEqual(KEPT_MAX_MS + CLEANUP_TICK_MS + 3_600_000);
    expect(age).toBeGreaterThanOrEqual(KEPT_MAX_MS);
  });
  test("an install starting while the cleanup holds the lock waits, and its own backup survives", async () => {
    const r = rig();
    const old = await keptOne(r, headN(1));
    r.advance(49 * 3_600_000);
    let finish: (v: boolean) => void = () => {};
    (r.k as any).d.lockCallMs = 10_000; (r.k as any).d.lockStepMs = 10_000;
    (r.k as any).d.deleteBackup = (b: string) => { r.deleted.push(b); return new Promise<boolean>((res) => { finish = res; }); };
    const cleaning = r.k.record((f) => r.k.cleanup("the daily tick", f));
    await Bun.sleep(5);
    expect(r.deleted).toEqual([old.backup]);                // the delete is in flight, the lock held
    r.f.makeBackup = async () => ({ slug: `kb-new-${r.backupsMade.length}` });
    const reg = r.register({ head: headN(2) });
    await Bun.sleep(20);
    expect(r.backupsMade).toHaveLength(1);                  // the new install's backup waits for the lock
    finish(true); await cleaning;
    const ans = await reg;
    expect(ans.status).toBe(200);
    const mine = r.k.st.attempts[idOf(headN(2))];
    expect(mine.backup).not.toBe(old.backup);
    expect(mine.gen).toBeGreaterThan(old.gen!);
    r.advance(3 * 86_400_000); await r.poll(2);
    expect(r.deleted).toEqual([old.backup]);                // its own backup is never the cleanup's
  });
  test("a new backup needs the free-space reserve (the last size and a half): one that can't fit is refused, logged and paged", async () => {
    const r = rig();
    r.f.backup = { ...r.f.backup!, size: 600 } as any;      // 600 MB
    await r.register({ head: headN(1) }); await r.poll();
    expect(r.k.st.lastBackupBytes).toBe(600 * 1024 * 1024);
    await r.k.cancel(CAIN, idOf(headN(1)), {});
    r.f.backupsList = [{ slug: r.k.st.attempts[idOf(headN(1))].backup, name: r.k.st.attempts[idOf(headN(1))].backupName! }];
    r.f.free = 1024 ** 3 + 800 * 1024 * 1024;               // under 900 MB plus the 1 GB reserve
    const ans = await r.register({ head: headN(2) });
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toContain("no room for its backup: only 1824 MB is free for backups, and its backup needs about 900 MB plus a reserve of 1024 MB");
    expect(r.logs.some((l) => l.startsWith(`refused a new backup for ${idOf(headN(2))}`) && l.includes("the cleanup couldn't free enough"))).toBe(true);
    expect(r.logs.some((l) => l.startsWith("owner: Keeper can't protect the install") && l.includes("no room for its backup"))).toBe(true);
    expect(r.backupsMade).toHaveLength(1);
    r.f.free = null;
    expect(String((await r.register({ head: headN(3) })).body.why)).toContain("the free space for backups couldn't be read");
  });
});

// The legacy temporary key file's name (0.1.7 and 0.1.8), built from its parts so the secret scan doesn't read a file name as a key.
const LEGACY_TMP = ["hc-key", "1", "abcdefabcdef", "tmp"].join(".");
// 0.1.10: the key files as the device holds them (a kept key's file never written over), each sentinel read back, the
// positive control placed outside the exclusion, and the Supervisor's size for the archive downloaded.
function checkRig(archive: (sentinel: string, control: string) => Uint8Array | null, o: { size?: (b: Uint8Array) => Partial<BackupInfo>; read?: (n: string, v: string) => string | null; ctlName?: string } = {}) {
  const r = rig({ backupCheck: false });
  const files: Record<string, string> = {};
  let sentinel = "", control = "", cleared = false, bytes: Uint8Array | null | undefined;
  const placedNames = ["hc-key", "hc-key-old", "hc-key.tmp-aa", LEGACY_TMP, "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa"];
  const got = () => (bytes === undefined ? (bytes = archive(sentinel, control)) : bytes);
  (r.k as any).d.keyFiles = {
    place: (sv: string, skip: string[] = []) => { sentinel = sv; const out = placedNames.filter((n) => !skip.includes(n)); for (const n of out) files[n] = sv; return out; },
    read: (n: string) => (o.read ? o.read(n, files[n]) : files[n] ?? null),
    control: (v: string) => { control = v; const n = o.ctlName ?? "backup-check-control"; files[n] = v; return n; },
    clear: () => { cleared = true; }, sweep: () => [],
  };
  (r.k as any).d.download = async () => got();
  (r.k as any).d.backupInfo = async () => { const b = got(); return { homeassistant: null, addons: [], folders: [], ...(b ? (o.size ? o.size(b) : { sizeBytes: b.length }) : {}) }; };
  return { r, get cleared() { return cleared; }, get sentinel() { return sentinel; }, get control() { return control; } };
}
const goodFiles = (ctl: string): [string, string][] => [["./addon.json", "{}"], ["./data/state.json", "{\"format\":1}"], ["./data/options.json", "{}"], ["./data/backup-check-control", ctl]];
describe("0.1.9 C: the guards as hard refusals", () => {
  test("hc-key is refused until the backup check passed on the device", async () => {
    const r = rig({ backupCheck: false });
    const res = await r.k.hcKeyEnter(codeIn(r.logs, "hc-key"), "hc-read-key-0123456789");
    expect(res.ok).toBe(false);
    expect(res.why).toContain("the backup check hasn't passed on the device");
    expect(r.k.armableWhy()).toBe(BACKUP_CHECK_WHY);
  });
  test("the backup check passes on a backup that leaves out every key file and holds no key; its test backup and sentinels are removed", async () => {
    const c = checkRig((_s, ctl) => haBackup(goodFiles(ctl)));
    expect(await c.r.k.backupCheck()).toEqual({ ok: true, why: "" });
    // the kept key's own file (hc-key) is never written over: its value is searched for instead
    expect(c.r.k.st.backupCheck?.names).toEqual(["hc-key-old", "hc-key.tmp-aa", "hc-key.1.abcdefabcdef.tmp", "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa"]);
    expect(c.r.k.st.backupCheck?.exclude).toBe(EXCLUDE_HASH);
    expect(c.cleared).toBe(true);
    expect(c.r.backupsMade).toEqual(["0fcc2575_keeper"]);
    expect(c.r.deleted).toHaveLength(1);
    expect(c.r.k.st.backupCheckRun).toBeUndefined();
  });
  test("the backup check fails on a key file's name, current or legacy, on the sentinel or a key's value anywhere, and on an unreadable archive", async () => {
    for (const files of [[["./data/hc-key", "x"]], [["./data/hc-key.1.abcdefabcdef.tmp", "x"]], [["./data/hc-key.tmp-aa", "x"]]] as [string, string][][]) {
      const c = checkRig((_s, ctl) => haBackup([...goodFiles(ctl), ...files]));
      const res = await c.r.k.backupCheck();
      expect(res.ok).toBe(false);
      expect(res.why).toContain("is a key file's name");
      expect(c.r.k.st.backupCheck).toBeUndefined();
      expect(c.cleared).toBe(true);
    }
    const s = checkRig((sent, ctl) => haBackup([...goodFiles(ctl), ["./data/options.json", `{"note":"${sent}"}`]]));
    expect((await s.r.k.backupCheck()).why).toContain("holds a key value, a key's fingerprint or the sentinel");
    const k = checkRig((_s, ctl) => haBackup([...goodFiles(ctl), ["./data/x.json", "{\"hc_api_key\":\"hc-read-key-0123456789\"}"]]));
    expect((await k.r.k.backupCheck()).why).toContain("holds key material");
    const u = checkRig(() => null);
    expect((await u.r.k.backupCheck()).why).toContain("couldn't be downloaded");
    const g = checkRig(() => new Uint8Array([1, 2, 3]));
    expect((await g.r.k.backupCheck()).ok).toBe(false);
  });
  test("arming is refused until the old key's rotation is attested by the owner's tap; Cain's own note never satisfies it", async () => {
    const r = rig({ opts: { hc_api_key: "old-key-0123456789abcdef" } });
    const id = r.k.st.oldKey!.id;
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(r.k.st)).not.toContain("old-key-0123456789abcdef");
    delete r.f.options.hc_api_key; await r.poll();
    expect(r.k.armableWhy()).toContain(`the old Healthchecks key (id ${id}) isn't attested as rotated`);
    expect(r.k.rotationView(CAIN).body).toMatchObject({ needed: true, old_key_id: id });
    for (const bad of ["I rotated it", rotationToken(id, r.now, { k: r.k, key: OTHER }), rotationToken("000000000000", r.now, { k: r.k }), rotationToken(id, r.now, { k: r.k, kind: "other" }), rotationToken(id, r.now, { k: r.k, ttl: -10 })]) {
      expect((await r.k.attestRotation(CAIN, { attestation: bad })).status).toBe(409);
    }
    expect((await r.k.attestRotation(HARNESS, { attestation: rotationToken(id, r.now, { k: r.k }) })).status).toBe(403);
    expect(r.k.armableWhy()).toContain("isn't attested as rotated");
    expect((await r.k.attestRotation(CAIN, { attestation: rotationToken(id, r.now, { k: r.k }) })).status).toBe(200);
    expect(r.k.armableWhy()).toBe("");
    expect(r.k.rotationView(CAIN).body).toMatchObject({ needed: false, old_key_id: id });
  });
  test("where the old key was kept, it is tried first: the alert service must reject it", async () => {
    const r = rig();
    let kept = "", dropped = false, answer: { status: number; error?: string } | null = { status: 200 };
    (r.k as any).d.oldKeyStore = { load: () => kept, store: (k: string) => { kept = k; return true; }, drop: () => { dropped = true; kept = ""; } };
    (r.k as any).d.hcTry = async () => answer;
    r.f.options.hc_api_key = "old-key-0123456789abcdef"; await r.poll();
    // while the option is still there, no attestation counts
    expect(String((await r.k.attestRotation(CAIN, { attestation: rotationToken(r.k.st.oldKey!.id, r.now, { k: r.k }) })).body.why)).toBe(OLD_KEY_WHY);
    delete r.f.options.hc_api_key; await r.poll();
    const tok = () => rotationToken(r.k.st.oldKey!.id, r.now, { k: r.k });
    expect(String((await r.k.attestRotation(CAIN, { attestation: tok() })).body.why)).toContain("still accepts the old key");
    answer = null;
    expect(String((await r.k.attestRotation(CAIN, { attestation: tok() })).body.why)).toContain("the old key's try doesn't prove it revoked (no answer)");
    answer = { status: 401 };
    expect((await r.k.attestRotation(CAIN, { attestation: tok() })).status).toBe(200);
    expect(dropped).toBe(true);
    expect(r.k.st.rotation!.tried).toBe("rejected by the alert service (401)");
  });
  test("an options read that fails or times out counts as the old option present: not armable, hc-key refused", async () => {
    const r = rig();
    expect(r.k.armableWhy()).toBe("");
    (r.k as any).d.options = () => new Promise(() => {});
    await r.poll();
    expect(r.k.armableWhy()).toBe(OPTIONS_UNKNOWN_WHY);
    expect((await r.k.hcKeyEnter(codeIn(r.logs, "hc-key"), "hc-read-key-0123456789")).why).toBe(OPTIONS_UNKNOWN_WHY);
    (r.k as any).d.options = () => { throw new Error("down"); };
    await r.poll();
    expect(r.k.armableWhy()).toBe(OPTIONS_UNKNOWN_WHY);
    (r.k as any).d.options = () => JSON.parse(JSON.stringify(withKeys(r.f.options)));
    await r.poll();
    expect(r.k.armableWhy()).toBe("");
  });
  test("every check's identity must be set by its unique key: a role without one refuses arming", () => {
    const r = rig({ uniq: false });
    expect(r.k.armableWhy()).toContain("every check's identity must be set by its unique key in hc_unique_keys");
    expect(r.k.armableWhy()).toContain("hc_done (the heartbeat check) (done)");
  });
});

describe("0.1.9 D: the enrollment code only on demand", () => {
  test("no key-confirm code at start, unenrolled or not; key-code prints one", async () => {
    const r = rig({ confirm: false });
    expect(codeIn(r.logs, "key-confirm")).toBe("");
    r.k.start();
    expect(codeIn(r.logs, "key-confirm")).toBe("");
    expect(r.k.keyCode().ok).toBe(true);
    expect(codeIn(r.logs, "key-confirm")).toMatch(/^[0-9a-f]{10}$/);
  });
  test("codes printed by an earlier build are void at this build's first start", async () => {
    const r = rig({ confirm: false });
    r.k.keyCode();
    const old = codeIn(r.logs, "key-confirm");
    const saved: any = JSON.parse(JSON.stringify(r.saved));
    delete saved.codeEpoch;                                // a state an earlier build wrote
    const again = rig({ saved, confirm: false });
    expect(again.logs.some((l) => /^the one-time codes printed by an earlier build are void \(.*\bkey\b/.test(l))).toBe(true);
    expect(again.k.keyConfirm(keyFp(PUB), old).ok).toBe(false);
    expect(again.k.st.codeEpoch).toBe(CODE_EPOCH);
    const third = rig({ saved: again.saved, confirm: false });   // this build's own codes survive its restarts
    expect(third.logs.some((l) => l.startsWith("the one-time codes printed by an earlier build are void"))).toBe(false);
  });
});

describe("0.1.9 E: the text and the docs", () => {
  const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
  const limits = docs.slice(docs.indexOf("## Accepted limits"), docs.indexOf("## Options"));
  test("the installer limit: a claim is not a single-use installer authorization, and the one-installer rule covers every entry point", () => {
    for (const t of [
      "A claim is not a single-use installer authorization.",
      "An install needs your Ship tap and the link's Ship token for that pull request and head, good for 2 hours after your tap; a claim authorizes nothing.",
      "A claim is single use only in this sense: one claimant, consumed by the one install it covers, and it covers no other install.",
      "The one-installer rule applies to every entry point: a Ship card, Home Assistant's own page, a laptop session, and break glass alike.",
      "wait for the recorded claim end in Keeper's log",
      // the expiry's end line (0.1.15: a terminal abort, paged)
      "its deadline was <time>` and `<attempt>: ended; backup kept: aborted:",
    ]) expect(limits).toContain(t);
  });
  test("the delivery text: arming expires at the configured interval (14 days default and maximum), and what a failed drill does", () => {
    expect(limits).toContain("Arming expires at the configured interval: option `drill_days`, 14 days by default and at most");
    expect(limits).toContain("A failed drill: a phone test whose page didn't reach your phone can't be confirmed");
    expect(limits).toContain("Keeper stays unarmed until a new one is confirmed");
  });
  test("the card and the docs say Keeper covers only the first 15 minutes after an install", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toContain("Covers only the first 15 minutes after each App install");
    expect(docs).toContain("It covers only the first 15 minutes after an install");
    expect(limits).toContain("Keeper covers only the first 15 minutes after an install.");
  });
  test("the full-Pi restore from a fresh Home Assistant is named untested; the partial restore is the exercised path", () => {
    expect(docs).toContain("A partial restore through Home Assistant's backup page (Settings, System, Backups, one App's backup) is the exercised path");
    expect(docs).toContain("A full restore of the whole Pi from a fresh Home Assistant is untested");
  });
  test("the checks before arming name both temporary names the backup must omit, current and legacy", () => {
    const sec = docs.slice(docs.indexOf("**The checks before arming, refusals in code (0.1.9).**"), docs.indexOf("## Arming"));
    expect(sec).toContain("`hc-key.tmp-`");
    expect(sec).toContain("`hc-key.<pid>.<hex>.tmp`");
    expect(sec).toContain("the backup must leave out every one of those names");
  });
});

// -- 0.1.10 (round 11: a scoped fix round) ------------------------------------------------------------------
describe("0.1.10 item 1: the backup check fails closed", () => {
  test("a truncated gzip fails the check", async () => {
    const c = checkRig((_s, ctl) => {
      const inner = gzipSync(tarOf(goodFiles(ctl)));
      return tarOf([["./backup.json", "{}"], ["./0fcc2575_keeper.tar.gz", inner.subarray(0, inner.length - 20)]]);
    });
    const res = await c.r.k.backupCheck();
    expect(res.ok).toBe(false);
    expect(res.why).toContain("is a gzip that can't be read whole");
    expect(c.r.k.st.backupCheck).toBeUndefined();
  });
  test("an encrypted or unknown inner member fails the check rather than being skipped", async () => {
    // an encrypted App archive (SecureTar): named .tar.gz, neither gzip nor tar
    const enc = checkRig(() => tarOf([["./backup.json", "{}"], ["./0fcc2575_keeper.tar.gz", new Uint8Array(4096).map((_, i) => (i * 131 + 7) % 251)]]));
    expect((await enc.r.k.backupCheck()).why).toContain("is named as an archive but is neither gzip nor tar (encrypted or unknown)");
    // a zstd or xz member, anywhere
    for (const [m, bytes] of [["zstd", [0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]], ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1]]] as [string, number[]][]) {
      const c = checkRig((_s, ctl) => tarOf([["./backup.json", "{}"], ["./0fcc2575_keeper.tar.gz", gzipSync(tarOf([...goodFiles(ctl), ["./data/blob", new Uint8Array(bytes)]]))]]));
      const why = (await c.r.k.backupCheck()).why;
      expect(why).toContain(m === "zstd" ? "zstd" : "xz");
    }
    // a backup.json that says protected
    const p = checkRig((_s, ctl) => tarOf([["./backup.json", "{\"protected\":true}"], ["./0fcc2575_keeper.tar.gz", gzipSync(tarOf(goodFiles(ctl)))]]));
    expect((await p.r.k.backupCheck()).why).toContain("says the backup is protected");
    // a tar whose header checksum doesn't match
    const t = checkRig((_s, ctl) => { const b = haBackup(goodFiles(ctl)); b[0] ^= 1; return b; });
    expect((await t.r.k.backupCheck()).why).toContain("checksum doesn't match");
  });
  test("a missing positive control fails the check: a scan that didn't read the files proves nothing", async () => {
    const c = checkRig(() => haBackup([["./addon.json", "{}"], ["./data/state.json", "{}"]]));
    const res = await c.r.k.backupCheck();
    expect(res.ok).toBe(false);
    expect(res.why).toContain("the positive control was found 0 times, not exactly once");
    // twice is no better
    const d = checkRig((_s, ctl) => haBackup([...goodFiles(ctl), ["./data/copy", ctl]]));
    expect((await d.r.k.backupCheck()).why).toContain("found 2 times");
    // and the control must sit outside the exclusion
    const x = checkRig((_s, ctl) => haBackup(goodFiles(ctl)), { ctlName: "hc-key-control" });
    expect((await x.r.k.backupCheck()).why).toContain("is inside the backup exclusion, so it proves nothing");
  });
  test("a size mismatch against the Supervisor's report fails the check; the MB figure counts within its rounding", async () => {
    const c = checkRig((_s, ctl) => haBackup(goodFiles(ctl)), { size: (b) => ({ sizeBytes: b.length + 512 }) });
    expect((await c.r.k.backupCheck()).why).toMatch(/download is \d+ bytes, but the Supervisor reports \d+/);
    const mb = checkRig((_s, ctl) => haBackup(goodFiles(ctl)), { size: (b) => ({ sizeMb: Math.round((b.length / 1024 ** 2) * 100) / 100 }) });
    expect((await mb.r.k.backupCheck()).ok).toBe(true);
    const none = checkRig((_s, ctl) => haBackup(goodFiles(ctl)), { size: () => ({}) });
    expect((await none.r.k.backupCheck()).why).toContain("didn't report its size");
  });
  test("every sentinel must read back where it was written; a kept old key's file is never written over", async () => {
    const c = checkRig((_s, ctl) => haBackup(goodFiles(ctl)), { read: (n, v) => (n.startsWith("hc-key.tmp-") ? null : v) });
    expect((await c.r.k.backupCheck()).why).toContain("the sentinel for a temporary file with the current prefix (hc-key.tmp-aa) didn't read back");
    const k = checkRig((_s, ctl) => haBackup(goodFiles(ctl)));
    let placedSkip: string[] = [];
    const kf = (k.r.k as any).d.keyFiles;
    const place = kf.place;
    kf.place = (sv: string, skip: string[]) => { placedSkip = skip; return place(sv, skip); };
    (k.r.k as any).d.oldKeyStore = { load: () => "old-key-0123456789abcdef", store: () => true, drop: () => {}, name: "hc-key-old" };
    expect((await k.r.k.backupCheck()).ok).toBe(true);
    expect(placedSkip).toEqual(["hc-key", "hc-key-old"]);
    expect(k.r.k.st.backupCheck!.names).toEqual(["hc-key.tmp-aa", LEGACY_TMP, "backup-keys/backup-check-sentinel", "backup-keys/tmp-aa"]);
    // and its value is searched for: a backup holding it fails
    const v = checkRig((_s, ctl) => haBackup([...goodFiles(ctl), ["./data/x", "old-key-0123456789abcdef"]]));
    (v.r.k as any).d.oldKeyStore = { load: () => "old-key-0123456789abcdef", store: () => true, drop: () => {}, name: "hc-key-old" };
    expect((await v.r.k.backupCheck()).why).toContain("holds key material");
  });
  test("a leftover test backup is removed at start: the name is recorded before the backup is made, and an interrupted check counts as failed", async () => {
    const c = checkRig((_s, ctl) => haBackup(goodFiles(ctl)));
    let hang: () => void = () => {};
    (c.r.k as any).d.download = () => new Promise((res) => { hang = () => res(null); });
    void c.r.k.backupCheck();
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const run = c.r.saved!.backupCheckRun!;
    expect(run.name).toMatch(/^Keeper backup check [0-9a-f]{8}$/);
    // Keeper stops here; a pass from before no longer counts after the restart
    const saved = { ...c.r.saved!, backupCheck: { at: T0, names: [], slug: "old", exclude: EXCLUDE_HASH } };
    const again = rig({ saved, backupCheck: false });
    expect(again.logs.some((l) => l.startsWith(`a backup check was interrupted (its test backup "${run.name}"): it counts as failed`))).toBe(true);
    expect(again.k.checkPassed()).toBe(false);
    again.f.backupsList = [{ slug: "test-bk", name: run.name }, { slug: "owner", name: "Automatic backup" }];
    await again.poll();
    expect(again.deleted).toEqual(["test-bk"]);
    expect(again.logs).toContain(`at start: deleted the test backup test-bk ("${run.name}") an interrupted backup check left behind`);
    expect(again.k.st.backupCheckRun).toBeUndefined();
    expect(again.k.armableWhy()).toBe(BACKUP_CHECK_WHY);
    hang();
  });
  test("a downloaded archive left behind is removed at start and logged", async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { archives } = await import("../rootfs/opt/keeper/main.ts");
    const dir = mkdtempSync(join(tmpdir(), "keeper-arch-"));
    writeFileSync(join(dir, "bk1.tar"), "x");
    const r = rig();
    (r.k as any).d.archives = archives(dir);
    r.k.start();
    expect(r.logs).toContain("removed a downloaded archive an interrupted backup check left behind: bk1.tar");
    expect(readdirSync(dir)).toEqual([]);
    // the download itself goes through that folder and leaves nothing
    const got = await archives(dir).through("bk2", async (p) => { writeFileSync(p, "abc"); return true; });
    expect(new TextDecoder().decode(got!)).toBe("abc");
    expect(readdirSync(dir)).toEqual([]);
  });
  test("a pass is tied to the deployed exclusion: config.yaml's backup_exclude is the one hashed, and a change voids the pass", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    const block = cfg.slice(cfg.indexOf("backup_exclude:"), cfg.indexOf("watchdog:"));
    expect([...block.matchAll(/^  - "([^"]+)"$/gm)].map((m) => m[1])).toEqual(BACKUP_EXCLUDE);
    for (const n of ["hc-key", "hc-key-old", "hc-key.tmp-0a", LEGACY_TMP]) expect(excludedName(n)).toBe(true);
    expect(excludedName("backup-check-control")).toBe(false);
    const r = rig();
    expect(r.k.checkPassed()).toBe(true);
    r.k.st.backupCheck!.exclude = "000000000000";
    expect(r.k.armableWhy()).toContain("the backup exclusion changed since it passed");
  });
});

describe("0.1.10 item 2: the old key's try proves revocation", () => {
  async function rotRig(kept: string | null) {
    const r = rig();
    let store = "", dropped = false;
    let answer: { status: number; error?: string } | null = { status: 401 };
    const tried: string[] = [];
    (r.k as any).d.oldKeyStore = { load: () => store, store: (k: string) => { if (kept === null) return false; store = k; return true; }, drop: () => { dropped = true; store = ""; }, name: "hc-key-old" };
    (r.k as any).d.hcTry = async (k: string) => { tried.push(k); return answer; };
    r.f.options.hc_api_key = "old-key-0123456789abcdef"; await r.poll();
    delete r.f.options.hc_api_key; await r.poll();
    return { r, id: r.k.st.oldKey!.id, set: (a: typeof answer) => { answer = a; }, get dropped() { return dropped; }, get store() { return store; }, tried };
  }
  test("only a 401 or the documented invalid-key answer proves it revoked; a bare 403 never does", async () => {
    expect(revocation({ status: 401 }).state).toBe("revoked");
    expect(revocation({ status: 400, error: "wrong api key" }).state).toBe("revoked");
    expect(revocation({ status: 403 }).state).toBe("unknown");
    expect(revocation({ status: 403, error: "forbidden" }).state).toBe("unknown");
    expect(revocation({ status: 200 }).state).toBe("valid");
    expect(revocation(null).state).toBe("unknown");
    const t = await rotRig("kept");
    t.set({ status: 403 });
    const res = await t.r.k.attestRotation(CAIN, { attestation: rotationToken(t.id, t.r.now, { k: t.r.k }) });
    expect(res.status).toBe(409);
    expect(String(res.body.why)).toContain("a bare 403, which doesn't prove the key revoked");
    expect(t.dropped).toBe(false);
    t.set({ status: 401 });
    expect((await t.r.k.attestRotation(CAIN, { attestation: rotationToken(t.id, t.r.now, { k: t.r.k }) })).status).toBe(200);
    // deleted as soon as the revocation check passed
    expect(t.dropped).toBe(true);
    expect(t.r.k.st.rotation!.proof).toBe("your tap, and the alert service turning the old key down");
  });
  test("the try is a read-only GET of the checks list, the endpoint the old option was used for", async () => {
    const { hcTry } = await import("../rootfs/opt/keeper/main.ts");
    const seen: { url: string; method?: string }[] = [];
    const ans = await hcTry("old-key-0123456789abcdef", (async (url: string, init: RequestInit) => { seen.push({ url, method: init.method }); return new Response(JSON.stringify({ error: "wrong api key" }), { status: 401 }); }) as any);
    expect(seen).toEqual([{ url: "https://healthchecks.io/api/v3/checks/", method: "GET" }]);
    expect(ans).toEqual({ status: 401, error: "wrong api key" });
  });
  test("no old key kept: the state and the card's answer say attested by your tap only", async () => {
    const t = await rotRig(null);
    expect(t.r.k.rotationView(CAIN).body).toMatchObject({ needed: true, old_key_kept: false, proof: ROTATION_PROOF_TAP });
    expect((await t.r.k.attestRotation(CAIN, { attestation: rotationToken(t.id, t.r.now, { k: t.r.k }) })).status).toBe(200);
    expect(t.tried).toEqual([]);
    expect(t.r.k.st.rotation!.proof).toBe("attested by your tap only");
    expect(t.r.logs.some((l) => l.includes("no old key was kept: attested by your tap only"))).toBe(true);
  });
  test("the attestation is bound to the current enrollment, the old key's id and a single-use challenge Keeper issued", async () => {
    const t = await rotRig("kept");
    const view: any = t.r.k.rotationView(CAIN).body;
    expect(view.challenge).toMatch(/^[0-9a-f]{24}$/);
    expect(view.enroll_id).toBe(t.r.k.st.pinnedKey!.enrollId);
    expect(t.r.k.rotationView(CAIN).body.challenge).toBe(view.challenge);      // kept until used
    const att = (o: any) => t.r.k.attestRotation(CAIN, { attestation: rotationToken(t.id, t.r.now, { k: t.r.k, ...o }) });
    expect(String((await att({ v: 1 })).body.why)).toContain("version 2");
    expect(String((await att({ enroll: "0123456789abcdef" })).body.why)).toContain("not the current one");
    expect(String((await att({ challenge: "f".repeat(24) })).body.why)).toContain("isn't the one Keeper issued");
    // used once: a replay of the same attestation is refused
    t.set({ status: 200 });
    const tok = rotationToken(t.id, t.r.now, { k: t.r.k });
    expect(String((await t.r.k.attestRotation(CAIN, { attestation: tok })).body.why)).toContain("still accepts the old key");
    t.set({ status: 401 });
    expect(String((await t.r.k.attestRotation(CAIN, { attestation: tok })).body.why)).toContain("or it was used already");
    expect((await att({})).status).toBe(200);
  });
  test("the old key's file is written only once its name is checked inside the backup exclusion", async () => {
    const r = rig();
    const writes: string[] = [];
    (r.k as any).d.oldKeyStore = { load: () => "", store: (k: string) => { writes.push(k); return true; }, drop: () => {}, name: "old-key.txt" };
    r.f.options.hc_api_key = "old-key-0123456789abcdef"; await r.poll();
    expect(writes).toEqual([]);
    expect(r.logs.some((l) => l.includes("the old key isn't kept: its file old-key.txt isn't inside the backup exclusion"))).toBe(true);
    const ok = rig();
    (ok.k as any).d.oldKeyStore = { load: () => "", store: (k: string) => { writes.push(k); return true; }, drop: () => {}, name: "hc-key-old" };
    ok.f.options.hc_api_key = "old-key-0123456789abcdef"; await ok.poll();
    expect(writes).toEqual(["old-key-0123456789abcdef"]);
  });
});

describe("0.1.10 item 3: the cleanup's grace and eligibility", () => {
  async function keptOne(r: ReturnType<typeof rig>, head = HEAD) {
    const id = idOf(head);
    r.f.makeBackup = async () => ({ slug: `kb-${r.backupsMade.length}` });
    await r.register({ head }); await r.poll();
    await r.k.cancel(CAIN, id, { why: "gave up" });
    const a = r.k.st.attempts[id];
    r.f.backupsList = [...(r.f.backupsList ?? []), { slug: a.backup, name: a.backupName! }];
    return a;
  }
  test("the grace is 2 hours 30 minutes, strictly longer than the Ship token's life plus the hook's bound", () => {
    expect(KEPT_GRACE_MS).toBe(150 * 60_000);
    expect(KEPT_GRACE_MS).toBeGreaterThan(SHIP_TTL_S * 1000 + HOOK_BOUND_MS);
  });
  test("a backup 2 hours 15 minutes past its claim's end is kept (inside the grace)", async () => {
    const r = rig();
    const a1 = await keptOne(r, headN(1)); await keptOne(r, headN(2)); await keptOne(r, headN(3));
    r.advance(135 * 60_000);
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
    expect(r.logs.some((l) => l.startsWith("3 kept backups are over the two-backup cap, but") && l.includes("inside the 2 hours 30 minutes grace: kept (the grace is a floor the cap never overrides)"))).toBe(true);
    r.advance(20 * 60_000);
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([a1.backup]);
  });
  test("the jobs list is read again right before each delete", async () => {
    const r = rig();
    const a = await keptOne(r);
    r.advance(49 * 3_600_000);
    let calls = 0;
    (r.k as any).d.activeJobs = async () => (++calls === 1 ? [] : ["addon_manager_update"]);
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(calls).toBe(2);
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain(`the cleanup left backup ${a.backup}: an install or update of ${CAIN} is running (read again right before its delete)`);
  });
  test("a blocked cleanup past a limit is logged", async () => {
    const r = rig();
    await keptOne(r);
    r.advance(49 * 3_600_000);
    r.f.activeJobs = null;
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain("the cleanup is blocked past its limits (1 past the 48-hour limit): those backups stay until cleanup is eligible again");
  });
  test("the deadline alone never substitutes for a recorded claim end", async () => {
    const r = rig();
    const a = await keptOne(r);
    delete r.k.st.attempts[a.id].endedAt;               // no recorded end, only the claim's deadline long past
    r.advance(72 * 3_600_000);
    await r.k.record((f) => r.k.cleanup("the daily tick", f));
    expect(r.deleted).toEqual([]);
    expect(r.logs).toContain(`kept backup ${a.backup} of ${a.id} stays past its limit: its attempt has no recorded end (a deadline alone never counts as one)`);
  });
});

describe("0.1.10 item 4: a backup create that outran its bound, and a route whose write is in flight", () => {
  test("a create that times out and completes later is found by its pre-chosen name under the next lock holder and adopted with its generation", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    r.f.timer = () => Promise.resolve();                   // the create's bound passes at once
    const ans = await r.register();
    expect(ans.status).toBe(409);
    const a = r.a();
    expect(a.lateBackup).toBeGreaterThan(0);
    // the process restarts before the answer comes back: only the name is left
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-late", name: a.backupName! }];
    await again.poll();
    const x = again.a();
    expect(x.backup).toBe("kb-late");
    expect(x.lateBackup).toBeUndefined();
    expect(again.k.st.keptBackups!["kb-late"]).toMatchObject({ attempt: ID, gen: a.gen });
    expect(again.logs.some((l) => l.startsWith(`${ID}: its backup's create outran its bound and completed later: found by its name "${a.backupName}" as kb-late, adopted with its generation ${a.gen}`))).toBe(true);
    finish({ slug: "kb-late" });
  });
  test("found with no generation record, it is deleted, logged", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});
    r.f.timer = () => Promise.resolve();
    await r.register();
    const saved = JSON.parse(JSON.stringify(r.saved));
    delete saved.attempts[ID].gen;
    const again = rig({ saved });
    again.f.backupsList = [{ slug: "kb-late", name: saved.attempts[ID].backupName }];
    await again.poll();
    expect(again.deleted).toEqual(["kb-late"]);
    expect(again.logs.some((l) => l.includes("completed later as kb-late") && l.endsWith("with no generation record: deleted"))).toBe(true);
  });
  test("a step whose write is in flight at its timeout answers pending, keeps the lock until the outcome is known, and a retry reconciles the same operation", async () => {
    const r = rig();
    let finish: (v: boolean) => void = () => {};
    const order: string[] = [];
    let runs = 0;
    const step = (f: any) => { runs++; return runs === 1 ? f.write("a slow write", () => new Promise<boolean>((res) => { finish = res; }), () => order.push("write recorded")).then(() => "done") : "reconciled"; };
    const first = r.k.record(step, (why, pending) => (pending ? "pending" : "refused"), "cancel x");
    const next = r.k.record(() => { order.push("next step"); return "next"; });
    expect(await first).toBe("pending");                    // answered at the timeout, the write still out
    expect(order).toEqual([]);                              // and the lock is still held
    expect(await r.k.record(step, (_w, pending) => (pending ? "pending" : "refused"), "cancel x")).toBe("pending");   // a retry meanwhile
    expect(runs).toBe(1);
    finish(true);
    expect(await next).toBe("next");
    expect(order).toEqual(["write recorded", "next step"]);
    expect(await r.k.record(step, (_w, pending) => (pending ? "pending" : "refused"), "cancel x")).toBe("reconciled");
    expect(Keeper.pendingAnswer("x", "y")).toMatchObject({ status: 202, body: { status: "pending" } });
    const src = readFileSync(join(import.meta.dir, "..", "rootfs/opt/keeper/core.ts"), "utf8");
    for (const op of ["`claim ${id}`", "`cancel ${id}`", '"rotation"']) expect(src).toContain(`pendingAnswer(`), expect(src).toContain(op);
  });
});

describe("0.1.10 item 6: the first backup's reserve floor, and the refusal's code", () => {
  test("no last size: 2 GB when the image size isn't known, 1 GB plus the image size when it is; the refusal carries code no_space", async () => {
    const r = rig();
    r.f.free = FIRST_BACKUP_BYTES - 1;
    const ans = await r.register();
    expect(ans.status).toBe(409);
    expect(ans.body.code).toBe("no_space");
    expect(String(ans.body.why)).toContain("under the first backup's reserve floor of 2048 MB (2 GB, the App's image size not known)");
    const k = rig();
    (k.k as any).d.imageBytes = async () => 300 * 1024 ** 2;
    k.f.free = 1024 ** 3 + 299 * 1024 ** 2;
    expect(String((await k.register()).body.why)).toContain("reserve floor of 1324 MB (1 GB plus the App's image size)");
    k.f.free = 1024 ** 3 + 301 * 1024 ** 2;
    expect((await k.register({ head: headN(2) })).status).toBe(200);
  });
});

describe("0.1.10 item 7: the watch takes only its own attempt's install, and the limits text version 4", () => {
  test("an install whose claimed attempt isn't the App's newest generation isn't watched as the Ship run's", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.k.st.attempts["ship-46-cain-other"] = { ...r.a(), id: "ship-46-cain-other", status: "ended", gen: (r.a().gen ?? 0) + 1 } as any;
    r.install();
    await r.poll();
    expect(r.a().status).toBe("unprotected");
    expect(String(r.a().why)).toContain("doesn't match the claimed attempt's own generation");
    const ok = rig();
    await ok.register(); await ok.poll(); ok.install(); await ok.poll();
    expect(ok.a().status).toBe("watching");
  });
  test("the text (version 4 in 0.1.10): the Ship token's life outside the hook, and the watch's own attempt and generation", () => {
    expect(LIMITS_VERSION).toBe(7);
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    const sec = docs.slice(docs.indexOf("## Accepted limits"), docs.indexOf("## Options")).replace(/\s+/g, " ");
    expect(sec).toContain("Text version 7 (0.1.15)");
    expect(sec).toContain("stays valid by its signature for its 2 hours outside the hook, and only the hook marks it spent");
    expect(sec).toContain("The watch accepts only an install matching its own attempt and generation");
  });
});

// -- 0.1.11 (round 12) ---------------------------------------------------------------------------------------
// The fail pings (pages) carrying a line, as the queue delivers them on the next poll.
const pagesWith = (r: ReturnType<typeof rig>, text: string) => r.pings.filter((p) => p.url.endsWith("/fail") && p.body.includes(text)).length;

describe("0.1.11 item 1: a late backup is retention-only", () => {
  // A claimed attempt whose only backup was adopted late (as settleLate or the late answer marks it), then its install.
  async function lateClaimed(times: { done: number | null; start: number | null }) {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.a().retentionOnly = true;
    (r.k as any).d.backupDoneAt = async () => times.done;
    (r.k as any).d.installStartedAt = async () => times.start;
    r.install(); await r.poll(); await r.poll();
    return r;
  }
  test("a late backup that completed after the install job started is refused by the consume: unprotected, paged once", async () => {
    const r = await lateClaimed({ done: T0 + 60_000, start: T0 + 30_000 });
    expect(r.a().status).toBe("unprotected");
    expect(r.a().consumedAt).toBeUndefined();
    expect(String(r.a().why)).toContain("completed after its create timed out: disqualified for good");
    expect(pagesWith(r, "Keeper can't protect the install")).toBe(1);
    await r.poll(3);
    expect(pagesWith(r, "Keeper can't protect the install")).toBe(1);
    expect(r.restores).toEqual([]);
  });
  test("0.1.15 item 5: one that completed before the install job started is disqualified too: no completion time makes it usable", async () => {
    const r = await lateClaimed({ done: T0 + 10_000, start: T0 + 30_000 });
    expect(r.a().status).toBe("unprotected");
    expect(r.a().lateProof).toBeUndefined();
    expect(r.restores).toEqual([]);
  });
  test("no completion time from the Supervisor (the default): never restorable, the install unprotected and paged", async () => {
    const r = await lateClaimed({ done: null, start: T0 + 30_000 });
    expect(r.a().status).toBe("unprotected");
    expect(String(r.a().why)).toContain("disqualified for good");
    expect(pagesWith(r, "Keeper can't protect the install")).toBe(1);
  });
  test("a restore never runs from a retention-only backup: a fail is unprotected, paged, nothing restored", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.install(); await r.poll();
    expect(r.a().status).toBe("watching");
    r.a().retentionOnly = true;                            // as if its backup had been adopted late, with no proof
    r.verdict("FAIL");
    await r.poll(2);
    expect(r.a().status).toBe("unprotected");
    expect(r.restores).toEqual([]);
    expect(String(r.a().why)).toContain("has no usable backup to restore");
  });
  test("adopting a late backup marks it retention-only", async () => {
    const r = rig();
    r.f.makeBackup = () => new Promise(() => {});
    r.f.timer = () => Promise.resolve();
    await r.register();
    const again = rig({ saved: r.saved });
    again.f.backupsList = [{ slug: "kb-late", name: r.a().backupName! }];
    await again.poll();
    expect(again.a().backup).toBe("kb-late");
    expect(again.a().retentionOnly).toBe(true);
    expect(again.k.unusableWhy(again.a())).toContain("retention-only");
  });
  test("the Supervisor's install job start: the newest install or update job's created time for that App", async () => {
    const http = async () => new Response(JSON.stringify({ result: "ok", data: { jobs: [
      { name: "addon_manager_update", reference: CAIN, created: "2026-11-21T15:00:00Z", child_jobs: [] },
      { name: "backup_manager_partial_backup", reference: "kb-1", created: "2026-11-21T15:05:00Z" },
      { name: "outer", reference: null, child_jobs: [{ name: "addon_manager_install", reference: CAIN, created: "2026-11-21T15:02:00Z" }] },
    ] } }));
    const sup = supervisor("t", "http://sup", http as any);
    expect(await sup.installStartedAt(CAIN)).toBe(Date.parse("2026-11-21T15:02:00Z"));
    expect(await sup.installStartedAt(HARNESS)).toBeNull();
  });
});

describe("0.1.11 item 2: a pending lock has a ceiling", () => {
  test("a write that never resolves: answered pending with an operation id, the lock released at the ceiling, the owner paged once, the next calls not wedged", async () => {
    const r = rig();
    (r.k as any).d.pendingCeilingMs = 400;
    let calls = 0;
    const step = (f: any) => f.write("the delete of kept backup kb-x", () => { calls++; return new Promise<boolean>(() => {}); }, () => { throw new Error("never recorded"); }).then(() => "done");
    const fb = (why: string, pending: boolean, op?: any) => (pending ? Keeper.pendingAnswer("x", why, op) : { status: 503, body: { status: "refused" } });
    const first: any = await r.k.record(step, fb, "cancel x");
    expect(first.status).toBe(202);
    const opId = String(first.body.operation);
    expect(opId).toMatch(/^op-[0-9a-f]{16}$/);
    expect(first.body.recorded).toBe("pending");
    // a claim queued behind it runs once the ceiling passes (never wedged)
    await r.register({ head: headN(9) }); await r.poll();
    const queued = r.k.claim(CAIN, idOf(headN(9)), { app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup: r.a(idOf(headN(9))).backup });
    const t0 = Date.now();
    expect((await queued).body.status).toBe("claimed");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.k.st.ops!["cancel x"]).toMatchObject({ id: opId, state: "late" });
    expect(r.logs.some((l) => l.includes(`(operation ${opId}): its write (the delete of kept backup kb-x) still has no outcome after`) && l.endsWith("the lock is released"))).toBe(true);
    // a retry reports the recorded outcome with the same id, and the write isn't repeated
    const again: any = await r.k.record(step, fb, "cancel x");
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ operation: opId, recorded: "late" });
    expect(calls).toBe(1);
    // one page for it
    await r.poll();
    expect(pagesWith(r, "Keeper released its lock after")).toBe(1);
    await r.poll(2);
    expect(pagesWith(r, "Keeper released its lock after")).toBe(1);
  });
  test("a write that ends within the ceiling: done, the lock released then, and a retry reads the recorded outcome afresh", async () => {
    const r = rig();
    (r.k as any).d.pendingCeilingMs = 5_000;
    let finish: (v: boolean) => void = () => {};
    let runs = 0;
    const step = (f: any) => { runs++; return runs === 1 ? f.write("a slow write", () => new Promise<boolean>((res) => { finish = res; })).then(() => "done") : "reconciled"; };
    const fb = (why: string, pending: boolean, op?: any) => (pending ? Keeper.pendingAnswer("x", why, op) : "refused");
    const first: any = await r.k.record(step, fb as any, "claim y");
    const retry: any = await r.k.record(step, fb as any, "claim y");
    expect(retry.body).toMatchObject({ operation: first.body.operation, recorded: "pending" });
    expect(runs).toBe(1);
    finish(true);
    await Bun.sleep(5);
    expect(r.k.st.ops!["claim y"].state).toBe("done");
    expect(await r.k.record(step, fb as any, "claim y")).toBe("reconciled");
    expect(r.k.st.ops?.["claim y"]).toBeUndefined();
  });
  test("an operation left pending by a restart is late at the next start, and its retry reports that", async () => {
    const r = rig();
    r.k.st.ops = { "rotation": { id: "op-0123456789abcdef", op: "rotation", at: T0, state: "pending", writes: ["w"] } };
    r.k.save();
    const again = rig({ saved: r.saved });
    expect(again.k.st.ops!.rotation.state).toBe("late");
    let ran = false;
    const ans: any = await again.k.record(() => { ran = true; return "x"; }, (w, p, op) => Keeper.pendingAnswer("rotation", w, op) as any, "rotation");
    expect(ran).toBe(false);
    expect(ans.body).toMatchObject({ operation: "op-0123456789abcdef", recorded: "late" });
  });
});

describe("0.1.11 item 5: an install the watch can't take as its own pages the owner", () => {
  test("an install not matching its attempt's own generation pages once, not only a log line", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.k.st.attempts["ship-46-cain-other"] = { ...r.a(), id: "ship-46-cain-other", status: "ended", gen: (r.a().gen ?? 0) + 1 } as any;
    r.install();
    await r.poll(); await r.poll(3);
    expect(r.a().status).toBe("unprotected");
    expect(pagesWith(r, "doesn't match the claimed attempt's own generation")).toBe(1);
  });
  test("an install whose attempt has no usable backup (its backup deleted) pages once as unprotected", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.a().backupDropped = true;
    r.install();
    await r.poll(); await r.poll(3);
    expect(r.a().status).toBe("unprotected");
    expect(String(r.a().why)).toContain("has no usable backup (its backup kb-cain was deleted)");
    expect(pagesWith(r, "has no usable backup")).toBe(1);
  });
});

// -- 0.1.12 (round 13) ---------------------------------------------------------------------------------------
describe("0.1.12 item 1: Keeper's backups of a watched App are protected with a key only Keeper holds", () => {
  test("the create carries a fresh password (32 random bytes, base64url), kept under the backup's name; the info must say protected true", async () => {
    const r = rig();
    expect((await r.register()).status).toBe(200);
    const pw = r.passwords[0]!;
    expect(pw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(pw, "base64url")).toHaveLength(32);
    expect(r.keys.get(r.a().backupName!)).toBe(pw);
    const r2 = rig(); await r2.register({ head: headN(2) });
    expect(r2.passwords[0]).not.toBe(pw);                  // one per backup
    const bare = rig({ backup: { protected: false } });
    expect((await bare.register()).status).toBe(409);
    expect(bare.a().why).toBe("its backup isn't shown as protected (protected true) with Keeper's own key, and the keeper restores only such a backup");
    bare.install("error"); await bare.poll(5);
    expect(bare.restores).toEqual([]);
  });
  test("a key that can't be kept: no backup is made, the install is unprotected", async () => {
    const r = rig();
    r.f.keyStoreOk = false;
    expect((await r.register()).status).toBe(409);
    expect(r.backupsMade).toEqual([]);
    expect(r.a().why).toContain("Keeper couldn't keep the key for its backup");
  });
  test("the restore carries the same password", async () => {
    const r = rig();
    await watching(r);
    r.verdict("FAIL"); await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.restores).toEqual([{ backup: "kb-cain", app: CAIN, password: r.passwords[0] }]);
  });
  test("a missing or unreadable key file makes the attempt unprotected, paged once, never restored", async () => {
    for (const how of ["missing", "unreadable"] as const) {
      const r = rig();
      await r.register(); await r.poll(); r.claim();
      if (how === "missing") r.keys.clear(); else r.f.keyLoadOk = false;
      r.install("error"); await r.poll(); await r.poll(5);
      expect([how, r.a().status]).toEqual([how, "unprotected"]);
      expect(String(r.a().why)).toContain("key file is missing or unreadable");
      expect(r.restores).toEqual([]);
      expect(pagesWith(r, "key file is missing or unreadable")).toBe(1);
    }
    // lost after the restore was decided: still never sent
    const late = rig();
    await watching(late);
    late.verdict("FAIL");
    late.keys.clear();
    await late.poll(ROLL);
    expect(late.restores).toEqual([]);
    expect(late.a().status).toBe("unprotected");
    expect(pagesWith(late, "key file is missing or unreadable")).toBe(1);
  });
  test("the cleanup deletes a backup's key file with the backup; a kept backup's key stays", async () => {
    const r = rig();
    r.f.makeBackup = async () => ({ slug: `kb-${r.backupsMade.length}` });
    await r.register(); await r.poll();
    await r.k.cancel(CAIN, ID, { why: "gave up" });
    const a = r.a();
    r.f.backupsList = [{ slug: a.backup, name: a.backupName! }];
    r.advance(3 * 3_600_000); r.k.st.cleanupAt = r.now - CLEANUP_TICK_MS; await r.poll();
    expect(r.deleted).toEqual([]);
    expect(r.keys.has(a.backupName!)).toBe(true);           // kept: its key stays
    r.advance(49 * 3_600_000); r.k.st.cleanupAt = r.now - CLEANUP_TICK_MS; await r.poll();
    expect(r.deleted).toEqual([a.backup]);
    expect(r.keys.has(a.backupName!)).toBe(false);
    expect(r.logs).toContain(`removed the key file of backup "${a.backupName}" (its backup was deleted)`);
  });
  test("at start a key file whose backup is gone is removed and logged; one whose backup is listed stays", async () => {
    const r = rig();
    const gone = "Keeper ship-46-cain-00000001 0a0b0c0d", listed = "Keeper ship-46-cain-00000002 0a0b0c0e";
    r.keys.set(gone, "x".repeat(43)); r.keys.set(listed, "y".repeat(43)); r.keys.set("tmp-0a1b2c", "z".repeat(43));
    r.f.backupsList = [{ slug: "kb-2", name: listed }];
    await r.poll();
    expect([...r.keys.keys()]).toEqual([listed]);
    expect(r.logs).toContain(`removed the key file of backup "${gone}" (its backup is gone from the backups list)`);
    expect(r.logs).toContain(`removed the key file of backup "tmp-0a1b2c" (its backup is gone from the backups list)`);
    expect(r.logs.some((l) => l.includes("x".repeat(43)))).toBe(false);
    // the backups list unreadable: nothing is removed
    const u = rig();
    u.keys.set(gone, "x".repeat(43)); u.f.backupsList = null;
    await u.poll();
    expect(u.keys.has(gone)).toBe(true);
    expect(u.logs).toContain("the backup key store wasn't swept: the backups list couldn't be read (tried again at the next start)");
    // only at start: a later poll leaves a new key file alone
    r.keys.set(gone, "x".repeat(43)); await r.poll(3);
    expect(r.keys.has(gone)).toBe(true);
  });
  test("the password never appears in a log line or a state write", async () => {
    const r = rig();
    const states: string[] = [];
    const save = (r.k as any).d.save;
    (r.k as any).d.save = (s: State) => { states.push(JSON.stringify(s)); return save(s); };
    await watching(r);
    r.verdict("FAIL"); await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    const pw = r.passwords[0]!;
    expect(states.length).toBeGreaterThan(3);
    expect(states.some((s) => s.includes(pw))).toBe(false);
    expect(r.logs.some((l) => l.includes(pw))).toBe(false);
    expect(r.pings.some((p) => p.body.includes(pw))).toBe(false);
  });
  test("the real key store: 0600 from its first byte through a tmp- file in the same folder, a 0700 folder, nothing left behind", async () => {
    const { statSync, readdirSync } = await import("node:fs");
    const dir = join(mkdtempSync(join(tmpdir(), "keeper-keys-")), "backup-keys");
    const temps: string[] = [];
    const st = backupKeys(dir, (tmp) => { temps.push(tmp); expect(statSync(tmp).mode & 0o777).toBe(0o600); });
    const name = "Keeper ship-46-cain-7d7b5f90 0a0b0c0d";
    expect(st.load(name)).toBeNull();
    expect(st.store(name, "k".repeat(43))).toBe(true);
    expect(temps).toHaveLength(1);
    expect(temps[0].startsWith(join(dir, "tmp-"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    expect(st.load(name)).toBe("k".repeat(43));
    expect(readdirSync(dir)).toEqual([name]);
    expect(st.list()).toEqual([name]);
    for (const bad of ["../x", "a/b", "", "tmp-x"]) expect(st.store(bad, "k".repeat(43))).toBe(false);
    expect(st.drop(name)).toBe(true);
    expect(st.drop(name)).toBe(false);
    expect(st.load(name)).toBeNull();
  });
});

describe("0.1.12 item 2: the backup check covers the key store", () => {
  test("the real keyFiles place a sentinel in backup-keys under its fixed name and its temporary prefix, read them back and sweep them", async () => {
    const { readdirSync, mkdirSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "keeper-kf-"));
    mkdirSync(join(dir, "backup-keys"));
    writeFileSync(join(dir, "backup-keys", "Keeper ship-46-cain-7d7b5f90 0a0b0c0d"), "real\n");
    const kf = keyFiles(dir);
    const placed = kf.place("keeper-sentinel-abc");
    expect(placed).toContain("backup-keys/backup-check-sentinel");
    expect(placed.some((n) => /^backup-keys\/tmp-[0-9a-f]{12}$/.test(n))).toBe(true);
    for (const n of placed) expect([n, kf.read(n)]).toEqual([n, "keeper-sentinel-abc"]);
    expect(kf.read("../etc/passwd")).toBeNull();
    // an interrupted check's sentinels are swept at start; a backup's real key never
    const swept = kf.sweep();
    expect(swept).toEqual(expect.arrayContaining(placed.filter((n) => n.startsWith("backup-keys/"))));
    expect(readdirSync(join(dir, "backup-keys"))).toEqual(["Keeper ship-46-cain-7d7b5f90 0a0b0c0d"]);
  });
  test("the check fails when the key store's sentinel isn't placed, or a name under backup-keys is in the test backup", async () => {
    const c = checkRig((_s, ctl) => haBackup(goodFiles(ctl)));
    const kf = (c.r.k as any).d.keyFiles;
    const place = kf.place;
    kf.place = (sv: string, skip: string[] = []) => place(sv, skip).filter((n: string) => n !== "backup-keys/backup-check-sentinel");
    expect((await c.r.k.backupCheck()).why).toBe("the sentinel for the backup key store wasn't written (nothing was placed under that name)");
    const t = checkRig((_s, ctl) => haBackup(goodFiles(ctl)));
    const tk = (t.r.k as any).d.keyFiles; const tplace = tk.place;
    tk.place = (sv: string, skip: string[] = []) => tplace(sv, skip).filter((n: string) => !n.startsWith("backup-keys/tmp-"));
    expect((await t.r.k.backupCheck()).why).toBe("the sentinel for a temporary file in the backup key store wasn't written (nothing was placed under that name)");
    for (const name of ["./data/backup-keys/", "./data/backup-keys/Keeper ship-46-cain-7d7b5f90 0a0b0c0d", "./data/backup-keys/tmp-0a1b2c"]) {
      const b = checkRig((_s, ctl) => haBackup([...goodFiles(ctl), [name, name.endsWith("/") ? "" : "a-password-of-sorts"]]));
      const res = await b.r.k.backupCheck();
      expect([name, res.ok]).toEqual([name, false]);
      expect(res.why).toContain("is a key file's name");
    }
  });
});

describe("0.1.12 item 3: the scan on the device's real backup layout", () => {
  // A Supervisor backup of one App: an outer plain tar with ./backup.json in clear and ./<slug>.tar.gz, a gzip tar holding
  // addon.json and data/ (the exclusion filters only inside data/ and config/, never addon.json).
  const SLUG = "0fcc2575_keeper";
  const backupJson = (over: any = {}) => JSON.stringify({ slug: "3c4d5e6f", name: "Keeper backup check 0a0b0c0d", date: "2026-11-23T10:00:00+00:00", type: "partial",
    protected: false, compressed: true, homeassistant: null, folders: [], addons: [{ slug: SLUG, name: "Keeper", version: "0.1.12", size: 0.01 }], ...over });
  const inner = (ctl: string, extra: [string, string][] = []) => gzipSync(tarOf([["./addon.json", JSON.stringify({ version: "0.1.12", options: { watch: [CAIN] }, state: "started" })],
    ["./data/", ""], ["./data/state.json", "{\"format\":1}"], ["./data/options.json", "{\"watch\":[]}"], [`./data/${"backup-check-control"}`, `${ctl}\n`], ...extra]));
  const outer = (ctl: string, o: { json?: any; member?: Uint8Array; extra?: [string, string][] } = {}) =>
    tarOf([["./backup.json", backupJson(o.json)], [`./${SLUG}.tar.gz`, o.member ?? inner(ctl, o.extra)]]);
  const CTL = "keeper-control-0123456789abcdef01234567";
  test("a pass: the control found once, no key names, addon.json read", () => {
    const res = scanBackup(outer(CTL), KEY_NAME, ["keeper-sentinel-0123456789abcdef"], { control: CTL });
    expect(res).toMatchObject({ ok: true, why: "", control: 1, found: [] });
    expect(res.names).toContain(`./${SLUG}.tar.gz:./addon.json`);
    expect(res.names).toContain(`./${SLUG}.tar.gz:./data/backup-check-control`);
  });
  test("a fail when backup.json says protected true", () => {
    expect(scanBackup(outer(CTL, { json: { protected: true } }), KEY_NAME, [], { control: CTL }).why).toContain("says the backup is protected");
  });
  test("a fail when the App's inner archive is neither gzip nor tar (as an encrypted SecureTar member is)", () => {
    const secure = new Uint8Array(4096); for (let i = 0; i < secure.length; i++) secure[i] = (i * 151 + 7) % 251;
    secure.set(new TextEncoder().encode("SecureTar"), 0);
    expect(scanBackup(outer(CTL, { member: secure }), KEY_NAME, [], { control: CTL }).why).toContain("is named as an archive but is neither gzip nor tar");
  });
  test("a fail when a key name appears under data/", () => {
    for (const n of ["./data/hc-key", "./data/backup-keys/Keeper ship-46-cain-7d7b5f90 0a0b0c0d", "./data/backup-keys/tmp-0a"]) {
      const res = scanBackup(outer(CTL, { extra: [[n, "x"]] }), KEY_NAME, [], { control: CTL });
      expect([n, res.ok]).toEqual([n, false]);
      expect(res.why).toContain("is a key file's name");
    }
  });
  test("the size: the Supervisor's size_bytes preferred when present, else size in MB", async () => {
    const n = 3 * 1024 * 1024 + 17;
    expect(Keeper.sizeWhy(n, { homeassistant: null, addons: [], folders: [], sizeBytes: n, sizeMb: 99 })).toBe("");
    expect(Keeper.sizeWhy(n, { homeassistant: null, addons: [], folders: [], sizeBytes: n + 1, sizeMb: 3 })).toContain(`but the Supervisor reports ${n + 1}`);
    expect(Keeper.sizeWhy(n, { homeassistant: null, addons: [], folders: [], sizeMb: 3 })).toBe("");
    expect(Keeper.sizeWhy(n, { homeassistant: null, addons: [], folders: [], sizeMb: 3.5 })).toContain("MB, but the Supervisor reports 3.5 MB");
    // as the Supervisor's backup info gives them
    const info = (data: any) => supervisor("t", "http://s", async () => new Response(JSON.stringify({ result: "ok", data }), { status: 200 })).backupInfo("x");
    const both = await info({ size: 3, size_bytes: n, protected: true, addons: [], folders: [] });
    expect(Keeper.sizeWhy(n, both)).toBe("");
    expect(both!.protected).toBe(true);
    const mbOnly = await info({ size: 3, protected: false, addons: [], folders: [] });
    expect(mbOnly!.sizeBytes).toBeUndefined();
    expect(Keeper.sizeWhy(n, mbOnly)).toBe("");
  });
});

describe("0.1.12 item 4: the docs and the limits", () => {
  const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
  test("DOCS.md says Keeper's backups are protected with its own key, what that means for the owner, and the check's test backup", () => {
    for (const t of [
      "Every backup Keeper makes of a watched App (Cain) is protected (encrypted) with a password only Keeper holds",
      "Home Assistant's backup page shows Keeper's backups as protected, and you can't open or restore them by hand",
      "Home Assistant's own pre-install backup, protected with your key, stays your way back by hand",
      "If Keeper's data is lost",
      "Keeper can't restore from the backups it kept",
      "it holds Keeper's own options in clear on the device's disk until it is deleted, right after the check and again at every start",
      "`/data/backup-keys`",
    ]) expect(docs).toContain(t);
  });
  test("the accepted limits are text version 6 and carry the third limit", () => {
    expect(LIMITS_VERSION).toBe(7);
    const sec = docs.slice(docs.indexOf("## Accepted limits"), docs.indexOf("## Options"));
    expect(sec).toContain("Text version 7 (0.1.15)");
    expect(sec).toContain("**3. Keeper's backups are protected with a key only Keeper holds (0.1.12).**");
    expect(sec).toContain("If Keeper's data is lost, Keeper can't restore from the backups it kept");
    expect(sec).toContain("test backup stays unprotected");
  });
});

// (0.1.13) The drill switch: Cain's link registers an install as kind drill only while the owner's tap set the drill flag
// (cain/rootfs/opt/cain/link/drill.ts), and the drilled version fails on purpose as the flag names. Here, the Keeper's side
// of the runbook's cases (DOCS.md, "The drill runbook").
describe("0.1.13: the drill cases as the runbook runs them", () => {
  // Keeper restarted (its state saved and loaded again, its backup keys kept) while it watches a drilled install
  async function restartMidWatch(r: ReturnType<typeof rig>, version: string, state: string) {
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) });
    for (const [n, v] of r.keys) r2.keys.set(n, v);
    r2.f.app.version = version; r2.f.app.state = state;
    return r2;
  }
  test("exit-on-start: the App not started, rolled back, and the exits-on-start record written for that drill attempt", async () => {
    const r = rig();
    await drillOf(r, headN(1), "exit");
    const id = idOf(headN(1), "drill");
    expect(r.a(id).auth).toBe("drill");
    expect(r.a(id).trigger?.kind === "state-error" || r.a(id).trigger?.kind === "not-started").toBe(true);
    expect(r.k.st.drills[CAIN]?.["exits-on-start"]?.attempt).toBe(id);
    // the runbook's state read (drill-state, the loopback listener only), read only: the counter doesn't move
    const counter = r.k.st.counter;
    const res = await handleLocal(r.k, new Request("http://127.0.0.1:8096/drill-state", { method: "POST", body: "{}" }), "127.0.0.1", () => {});
    expect(res.status).toBe(200);
    const st: any = (await res.json()).state.apps[CAIN];
    expect(st.attempts.at(-1)).toMatchObject({ id, kind: "drill", status: "rolled back", restored: true, drill_recorded: true });
    expect(st.drills).toEqual([{ kind: "exits-on-start", attempt: id, at: expect.any(String), counts: true }, { kind: "fail-verdict", attempt: null, at: null, counts: false }]);
    expect(st.why).toBe(`no drills on record for ${CAIN} under the current binding`);
    expect(r.k.st.counter).toBe(counter);
    expect((await handle(r.k, new Request("http://keeper/drill-state", { method: "POST", body: "{}", headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {})).status).toBe(403);
    expect(r.logs.some((l) => l.startsWith(`drill recorded for ${CAIN}: exits-on-start (${id}); it counts while Keeper's version`))).toBe(true);
  });
  test("verdict-fail: the probe's FAIL rolls it back, and the fail-verdict record is written for that drill attempt", async () => {
    const r = rig();
    await drillOf(r, headN(2), "verdict");
    const id = idOf(headN(2), "drill");
    expect(r.a(id).trigger?.kind).toBe("verdict");
    expect(r.k.st.drills[CAIN]?.["fail-verdict"]?.attempt).toBe(id);
  });
  test("two drill records, one of each, are what the drills part of arming needs; a ship attempt that rolls back never writes one", async () => {
    const r = rig();
    await drillOf(r, headN(1), "exit");
    expect(r.k.armedView(CAIN).why).toBe(`no drills on record for ${CAIN} under the current binding`);
    await drillOf(r, headN(2), "verdict");
    expect(Object.keys(r.k.st.drills[CAIN] ?? {}).sort()).toEqual(["exits-on-start", "fail-verdict"]);
    expect(r.k.armedView(CAIN).why).not.toContain("no drills on record");
    const s = rig(); await failed(s); await s.poll(ROLL);
    expect(s.a().status).toBe("rolled back");
    expect(s.k.st.drills[CAIN]).toBeUndefined();
  });
  test("restart during a flagged watch (exit-on-start): Keeper restarted after it saw the drilled version still rolls it back and records the drill", async () => {
    const r = rig();
    const head = headN(3), id = idOf(head, "drill");
    expect((await r.register({ head, kind: "drill", drill_mode: "exit-on-start" })).status).toBe(200);
    // the App exited at its start: stopped, seen once (a fail needs two polls in a row), then Keeper restarts
    await r.poll(); r.install("stopped"); await r.poll();
    expect(r.a(id).status).toBe("watching");
    const r2 = await restartMidWatch(r, "0.17.0", "stopped");
    await r2.poll(ROLL);
    expect(r2.a(id).status).toBe("rolled back");
    expect(r2.restores.length + r.restores.length).toBe(1);   // one restore call, never a second
    expect(r2.k.st.drills[CAIN]?.["exits-on-start"]?.attempt).toBe(id);
  });
  test("restart during a flagged watch (verdict-fail): the FAIL that came before the restart still rolls it back", async () => {
    const r = rig();
    const head = headN(4), id = idOf(head, "drill");
    expect((await r.register({ head, kind: "drill" })).status).toBe(200);
    await r.poll(); r.install("started"); await r.poll();
    r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "a Keeper drill" });
    const r2 = await restartMidWatch(r, "0.17.0", "started");
    await r2.poll(ROLL);
    expect(r2.a(id).status).toBe("rolled back");
    expect(r2.restores.length + r.restores.length).toBe(1);
    expect(r2.k.st.drills[CAIN]?.["fail-verdict"]?.attempt).toBe(id);
  });
  test("the healthy case: the same release registered as kind ship with no flag passes, and writes no drill record", async () => {
    const r = rig();
    expect((await r.register({ head: HEAD })).status).toBe(200);
    await r.poll(); r.install("started"); await r.poll();
    r.verdict("PASS");
    await r.poll(WATCH_MS / POLL_MS + 4);
    expect(r.a().auth).toBe("ship");
    expect(r.a().status).toBe("passed");
    expect(r.restores).toEqual([]);
    expect(r.k.st.drills[CAIN]).toBeUndefined();
  });
  test("the DOCS carry the runbook: each case, the order of installs, and no RELEASING.md section that doesn't exist", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8");
    const sec = docs.slice(docs.indexOf("## The drill runbook (0.1.13)"));
    expect(sec.length).toBeGreaterThan(1000);
    for (const s of ["exit-on-start", "verdict-fail", "Restart during a watch", "healthy", "keeper.sh drill-arm", "Arm the drill",
      "Keeper App first", "unwatched"]) expect(sec).toContain(s);
    const releasing = readFileSync(join(import.meta.dir, "..", "..", "RELEASING.md"), "utf8");
    const heads = new Set([...releasing.matchAll(/^#+ (.+)$/gm)].map((m) => m[1].trim()));
    for (const m of sec.matchAll(/RELEASING\.md, ([A-Z][A-Za-z' ]+?)(?:[),.;:]| \d)/g)) expect([...heads].some((h) => h.startsWith(m[1].trim()))).toBe(true);
  });
});

// (0.1.14) Round 15: a drill record needs evidence (the link's confirmation of the signed mark, and the failure its mode names),
// a drill flag's nonce registers once, the payload kind of a Ship token is checked exactly, and Keeper reads not armed while the
// drill plan's follow-up items are open (option drill_followups_open).
describe("0.1.14: drill evidence, nonces, the Ship token's kind and the follow-ups gate", () => {
  test("a drill registration needs its mode and nonce; a ship one carries neither", async () => {
    const r = rig();
    for (const [over, why] of [
      [{ kind: "drill", drill_mode: "rollback-anyway" }, "names no drill mode"],
      [{ kind: "drill", drill_nonce: "xyz" }, "carries no drill flag nonce"],
      [{ kind: "ship", drill_mode: "exit-on-start" }, "a ship registration carries a drill mode or nonce"],
    ] as const) {
      const ans = await r.register({ head: headN(9), ...over });
      expect(ans.status).toBe(409);
      expect(String(ans.body.why)).toContain(why);
    }
    expect(Object.keys(r.k.st.attempts)).toEqual([]);
  });
  test("fix 4 (Keeper's side): a drill flag's nonce registers once, even from a fresh Ship token after Cain's state was restored", async () => {
    const r = rig();
    expect((await r.register({ head: headN(1), kind: "drill", drill_nonce: "00000000000000aa" })).status).toBe(200);
    r.k.cancel(CAIN, idOf(headN(1), "drill"), { why: "the pass is refused" });
    await r.poll(3);
    const again = await r.register({ head: headN(2), kind: "drill", drill_nonce: "00000000000000aa" });
    expect(again.status).toBe(409);
    expect(String(again.body.why)).toContain(`a replay: that drill flag's nonce was registered under ${idOf(headN(1), "drill")}`);
    // kept across a restart
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) });
    expect((r2.k.st.drillNonces ?? []).map((x) => x.nonce)).toContain("00000000000000aa");
  });
  test("the link's mark confirmation: Cain's App only, a drill only, its mode and version, while accepted, idempotent for the same mark", async () => {
    const r = rig();
    const id = idOf(headN(1), "drill");
    expect((await r.register({ head: headN(1), kind: "drill", drill_mode: "exit-on-start", noMark: true })).status).toBe(200);
    const mark = "cd".repeat(32);
    expect(r.k.markAttempt(HARNESS, id, { mode: "exit-on-start", to_version: "0.17.0", mark }).status).toBe(403);
    expect(r.k.markAttempt(CAIN, id, { mode: "verdict-fail", to_version: "0.17.0", mark }).status).toBe(409);
    expect(r.k.markAttempt(CAIN, id, { mode: "exit-on-start", to_version: "0.18.0", mark }).status).toBe(409);
    expect(r.k.markAttempt(CAIN, id, { mode: "exit-on-start", to_version: "0.17.0", mark: "nothex" }).status).toBe(409);
    expect(r.k.markAttempt(CAIN, id, { mode: "exit-on-start", to_version: "0.17.0", mark })).toEqual({ status: 200, body: { status: "marked", id } });
    expect(r.k.markAttempt(CAIN, id, { mode: "exit-on-start", to_version: "0.17.0", mark }).status).toBe(200);
    expect(r.k.markAttempt(CAIN, id, { mode: "exit-on-start", to_version: "0.17.0", mark: "ef".repeat(32) }).status).toBe(409);
    expect(r.k.attemptView(CAIN, id).body).toMatchObject({ kind: "drill", drill_mode: "exit-on-start", marked: true });
    const s = rig(); await s.register();
    expect(s.k.markAttempt(CAIN, ID, { mode: "exit-on-start", to_version: "0.17.0", mark }).body.why).toBe("it isn't a drill");
  });
  test("GET /attempt names the open attempt's kind, drill mode and whether its mark was confirmed (the run script's helper reads it)", async () => {
    const r = rig();
    expect((await r.register({ head: headN(1), kind: "drill", drill_mode: "exit-on-start" })).status).toBe(200);
    // 0.1.15 item 14: the drill fields only by the attempt's own id; the open-attempt read names its kind alone
    const res = await handle(r.k, new Request(`http://keeper/attempt/${idOf(headN(1), "drill")}`, { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {});
    expect(await res.json()).toMatchObject({ id: idOf(headN(1), "drill"), kind: "drill", drill_mode: "exit-on-start", marked: true, status: "accepted", to_version: "0.17.0", install_job: null });
    const open: any = await (await handle(r.k, new Request("http://keeper/attempt", { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {})).json();
    expect([open.kind, open.drill_mode, open.marked]).toEqual(["drill", undefined, undefined]);
    const via = await handle(r.k, new Request(`http://keeper/attempt/${idOf(headN(1), "drill")}/drill-mark`, { method: "POST", body: JSON.stringify({ mode: "exit-on-start", to_version: "0.17.0", mark: "ab".repeat(32) }),
      headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {});
    expect(via.status).toBe(200);
    const s = rig(); await s.register();
    const shipRes = await handle(s.k, new Request("http://keeper/attempt", { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {});
    const j: any = await shipRes.json();
    expect(j.kind).toBe("ship");
    expect(j.drill_mode).toBeUndefined();
  });
  test("a drill record needs evidence the mark was written: kind drill plus a rollback alone writes none", async () => {
    const r = rig();
    const head = headN(1), id = idOf(head, "drill");
    expect((await r.register({ head, kind: "drill", drill_mode: "verdict-fail", noMark: true })).status).toBe(200);
    await r.poll(); r.install("started"); await r.poll();
    r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
    await r.poll(ROLL);
    expect(r.a(id).status).toBe("rolled back");
    expect(r.k.st.drills[CAIN]).toBeUndefined();
    expect(r.k.drillRecord(id)).toEqual({ ok: false, why: "no evidence the drill mark was written (the link never confirmed it to Keeper)" });
  });
  test("a drill record needs the failure its mode names: a verdict-fail drill that exited at start records nothing", async () => {
    const r = rig();
    const head = headN(1), id = idOf(head, "drill");
    expect((await r.register({ head, kind: "drill", drill_mode: "verdict-fail" })).status).toBe(200);
    await r.poll(); r.install("error"); await r.poll(ROLL);
    expect(r.a(id).status).toBe("rolled back");
    expect(r.k.st.drills[CAIN]).toBeUndefined();
    expect(r.k.drillRecord(id).why).toBe("the failure Keeper observed (exits-on-start) isn't the one its drill mode (verdict-fail) names");
    // with the evidence, the record keeps it
    const s = rig(); await drillOf(s, headN(2), "exit");
    expect(s.k.st.drills[CAIN]?.["exits-on-start"]).toMatchObject({ mode: "exit-on-start", markHash: "ab".repeat(32), markAt: expect.any(Number) });
  });
  test("fix 6 (Keeper's side): a Ship token's payload kind is checked exactly", () => {
    const tok = (claim: any) => { const p = b64url(Buffer.from(JSON.stringify(claim))); return `ship1.${p}.${b64url(edSign(null, Buffer.from(`ship1.${p}`), LINK))}`; };
    const base = { v: 1, repo: "HyndeSyte/harness", pr: 46, head: HEAD, exp: Math.floor(T0 / 1000) + 3600 };
    const key = shipKey(PUB)!;
    // 0.1.15 item 13: only with its explicit kind "ship" (the bare base, no kind, is in the refused list below)
    expect(readShipToken(tok({ ...base, kind: "ship" }), key, T0).ok).toBe(true);
    for (const c of [{ ...base, kind: "keeper-drill" }, { ...base, kind: "keeper-drill", mode: "exit-on-start", nonce: "00000000000000aa" }, { ...base, kind: "ship", extra: 1 }, base])
      expect(readShipToken(tok(c), key, T0)).toEqual({ ok: false, why: "its token's payload kind isn't a Ship approval" });
  });
  test("while drill_followups_open is set (the default) Keeper reads not armed whatever its drills; clearing it keeps the drill records", async () => {
    expect(parseOptions({}).drill_followups_open).toBe(true);
    expect(parseOptions({ drill_followups_open: false }).drill_followups_open).toBe(false);
    const r = await armedRig();
    expect(optionsHash(parseOptions({ ...r.f.options, drill_followups_open: true }))).toBe(optionsHash(parseOptions({ ...r.f.options, drill_followups_open: false })));
    r.f.options.drill_followups_open = true; r.k.useOptions(withKeys(r.f.options));
    expect(r.k.armedView(CAIN)).toMatchObject({ armed: false, why: FOLLOWUPS_WHY });
    expect((r.k.drillState().state as any).followups_open).toBe(true);
    expect(Object.keys(r.k.st.drills[CAIN] ?? {}).sort()).toEqual(["exits-on-start", "fail-verdict"]);
    r.f.options.drill_followups_open = false; r.k.useOptions(withKeys(r.f.options));
    expect(r.k.armedView(CAIN).armed).toBe(true);
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^  drill_followups_open: true$/m);
    expect(cfg).toMatch(/^  drill_followups_open: bool\?$/m);
  });
});

// (0.1.15) Round 16: the follow-ups that close the last review round and the older list. Each numbered item has its own group, named
// for it (the Cain side of items 1, 3, 6, 7, 8, 11, 12, 13, 14, 15 and 21 is in cain/tests/round16.test.ts).
describe("0.1.15 item 1: every Ship approval is single use", () => {
  test("the keeper refuses a second registration with the same token, whatever happened to the first", async () => {
    const r = rig();
    const token = shipToken();
    const body = { token, app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, kind: "ship" };
    expect((await r.k.registerAttempt(CAIN, body)).status).toBe(202);
    await r.k.whenSettled(ID);
    expect((await r.k.cancel(CAIN, ID, { why: "the pass gave up" })).status).toBe(200);
    const again = await r.k.registerAttempt(CAIN, body);
    expect(again.status).toBe(409);
    expect(String(again.body.why)).toContain("a replay: that Ship token was spent");
  });
});

describe("0.1.15 item 2: the install is tied to its own Supervisor job", () => {
  test("the claim binds the one install job made during it; the watch, the rollback and the drill record need it", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    const j = r.job({ done: false });
    await r.poll();
    expect(r.a().job).toMatchObject({ id: j.uuid, created: j.created });
    expect(r.logs.some((l) => l.startsWith(`${ID}: bound to the Supervisor's install job ${j.uuid}`))).toBe(true);
    expect(r.k.attemptView(CAIN, ID).body).toMatchObject({ install_job: j.uuid, install_job_at: new Date(j.created).toISOString() });
    r.f.installJobs[0].done = true; r.f.app.version = "0.17.0"; await r.poll();
    expect(r.a().status).toBe("watching");
  });
  test("a start of the claimed version with no install job made during the claim is no install of the attempt: unprotected, never rolled back", async () => {
    const r = rig();
    await r.register(); await r.poll();
    r.install("error", true, false); await r.poll(ROLL);
    expect(r.a().status).toBe("unprotected");
    expect(String(r.a().why)).toContain("started with no Supervisor install job made during its claim");
    expect(r.restores).toEqual([]);
  });
  test("two install jobs during the claim, or one made before it still running, can't be tied to one: unprotected", async () => {
    const two = rig();
    await two.register(); await two.poll(); two.claim(); two.job(); two.job(); await two.poll();
    expect(two.a().status).toBe("unprotected");
    expect(String(two.a().why)).toContain("2 install jobs of Cain were made during its claim");
    const before = rig();
    before.job({ done: false });
    before.advance(60_000);
    await before.register(); await before.poll(); before.claim(); await before.poll();
    expect(before.a().status).toBe("unprotected");
    expect(String(before.a().why)).toContain("made before its claim");
  });
  test("a jobs list that can't be read binds nothing and waits; the start is judged once it can be read", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    r.f.installJobsUp = false; r.install("started", false); await r.poll();
    expect(r.a().status).toBe("claimed");
    expect(r.logs.some((l) => l.includes("the jobs list can't be read to tie it to an install job"))).toBe(true);
    r.f.installJobsUp = true; await r.poll();
    expect(r.a().status).toBe("watching");
  });
  test("a drill whose install isn't tied to a job writes no drill record", async () => {
    const r = rig();
    const head = headN(1), id = idOf(head, "drill");
    expect((await r.register({ head, kind: "drill", drill_mode: "verdict-fail" })).status).toBe(200);
    await r.poll(); r.install("started"); await r.poll();
    r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
    await r.poll(ROLL);
    expect(r.a(id).status).toBe("rolled back");
    delete r.a(id).job; delete r.a(id).drillRecorded; delete r.k.st.drills[CAIN];
    expect(r.k.drillRecord(id).why).toContain("isn't tied to a Supervisor install job");
  });
  test("the Supervisor's jobs list read: the App's install and update jobs, never a restore, with their creation times", async () => {
    const http = async (url: string) => {
      const path = new URL(url).pathname;
      if (path !== "/jobs/info") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ result: "ok", data: { jobs: [
        { name: "addon_manager_update", reference: CAIN, uuid: "u1", done: false, errors: [], created: "2026-11-25T10:00:00+00:00", child_jobs: [
          { name: "addon_install", reference: CAIN, uuid: "u2", done: true, errors: [{}], created: "2026-11-25T10:00:01+00:00", child_jobs: [] }] },
        { name: "backup_manager_partial_restore", reference: CAIN, uuid: "u3", done: false, errors: [], created: "2026-11-25T10:00:02+00:00", child_jobs: [] },
        { name: "addon_update", reference: HARNESS, uuid: "u4", done: false, errors: [], child_jobs: [] },
        { name: "addon_update", reference: CAIN, uuid: "u5", done: false, errors: [], child_jobs: [] }] } }), { status: 200 });
    };
    const jobs = await supervisor("t", "http://supervisor", http as any).installJobs(CAIN);
    expect(jobs).toEqual([
      { uuid: "u1", created: Date.parse("2026-11-25T10:00:00Z"), done: false, errors: 0, name: "addon_manager_update" },
      { uuid: "u2", created: Date.parse("2026-11-25T10:00:01Z"), done: true, errors: 1, name: "addon_install" },
      { uuid: "u5", created: 0, done: false, errors: 0, name: "addon_update" }]);   // no time: counts as made before any claim
  });
});

describe("0.1.15 item 3: an install with no job after its bound ends as a terminal abort", () => {
  test("no install job by the claim's deadline: aborted, paged, its backup kept, and a later install isn't covered", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    const slug = r.a().backup;
    r.advance(CLAIM_MS + 1_000); await r.poll();
    expect(r.a().status).toBe("aborted");
    expect(pagesWith(r, "Keeper ended its hold on the install of Cain 0.17.0")).toBe(1);
    expect(r.k.st.keptBackups![slug]).toBeDefined();
    r.install("error", false); await r.poll(ROLL);
    expect(r.a().status).toBe("unprotected");
    expect(r.restores).toEqual([]);
  });
  test("with its job bound, the claim stays live past its deadline for the version to show; past that, aborted too", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim(); r.job({ done: false }); await r.poll();
    r.advance(CLAIM_MS + 60_000); await r.poll();
    expect(r.a().status).toBe("claimed");
    r.f.app.version = "0.17.0"; await r.poll();
    expect(r.a().status).toBe("watching");
    const s = rig();
    await s.register(); await s.poll(); s.claim(); s.job({ done: false }); await s.poll();
    s.advance(CLAIM_MS + JOB_GRACE_MS + 1_000); await s.poll();
    expect(s.a().status).toBe("aborted");
    expect(String(s.a().why)).toContain("didn't bring 0.17.0");
  });
});

describe("0.1.15 item 4: the backup is kept until its attempt ends", () => {
  async function keptPast(o: { jobDone?: boolean; jobsUp?: boolean; noJob?: boolean } = {}) {
    const r = rig();
    await r.register(); await r.poll(); r.claim();
    if (!o.noJob) { r.job({ done: !!o.jobDone }); await r.poll(); }
    const slug = r.a().backup;
    r.f.backupsList = [{ slug, name: r.a().backupName! }];
    r.advance(CLAIM_MS + JOB_GRACE_MS + 1_000); await r.poll();
    expect(r.a().status).toBe("aborted");
    if (o.jobsUp === false) { r.f.jobsUp = false; r.f.installJobsUp = false; }
    r.advance(KEPT_MAX_MS + CLEANUP_TICK_MS); await r.poll(2);
    return { r, slug };
  }
  test("an install job with no recorded end pins the backup: the cleanup never deletes it", async () => {
    const { r, slug } = await keptPast({ jobDone: false });
    expect(r.deleted).toEqual([]);
    expect(r.logs.some((l) => l === `the cleanup left backup ${slug}: it is pinned (its install job inst-1 is still running)`)).toBe(true);
    r.f.installJobs[0].done = true; r.advance(CLEANUP_TICK_MS); await r.poll(2);
    expect(r.deleted).toEqual([slug]);                                // released once the job is terminal
  });
  test("a job's state that can't be read, or a claim with no job the Supervisor can't confirm had none, keeps the pin", async () => {
    const a = await keptPast({ jobsUp: false, jobDone: false });
    expect(a.r.deleted).toEqual([]);
    const b = await keptPast({ noJob: true, jobsUp: false });
    expect(b.r.deleted).toEqual([]);
    expect(b.r.logs.some((l) => l.includes("can't confirm that no install job was accepted for its claim"))).toBe(true);
  });
  test("the claim reads the backup's slug again right before the install: a backup that isn't there refuses the claim", async () => {
    const r = rig();
    await r.register(); await r.poll();
    const a = r.a();
    r.f.backup = null;
    const c = await r.k.claim(CAIN, ID, { app: a.app, from_version: a.from, to_version: a.to, backup: a.backup });
    expect(c.status).toBe(409);
    expect(String(c.body.why)).toContain(`its backup ${a.backup} isn't there`);
    expect(r.a().status).toBe("accepted");
  });
});

describe("0.1.15 item 5: only a backup made for this attempt and verified before submission is its rollback point", () => {
  test("a backup whose create timed out is disqualified for good, however it finishes later", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    let fire: () => void = () => {};
    r.f.timer = () => new Promise<void>((res) => { fire = res; });
    const ans = await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, kind: "ship" });
    expect(ans.status).toBe(202);
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    fire(); await r.k.whenSettled(ID);
    expect(r.a().status).toBe("unprotected");
    finish({ slug: "kb-late" }); for (let i = 0; i < 5; i++) await Bun.sleep(0);
    expect(r.a().backup).toBe("kb-late");
    expect(r.k.unusableWhy(r.a())).toContain("disqualified for good");
    r.a().lateProof = { backupDoneAt: T0, installStartedAt: T0 + 1 };   // no proof makes it usable
    expect(r.k.unusableWhy(r.a())).toContain("disqualified for good");
  });
});

describe("0.1.15 item 6: acceptance outside the hook's bound", () => {
  test("the registration answers pending at once; an acceptance the link never claims ends by itself as a terminal abort, paged, backup kept", async () => {
    const r = rig();
    const ans = await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, kind: "ship" });
    expect([ans.status, ans.body.status]).toEqual([202, "pending"]);
    await r.k.whenSettled(ID);
    const slug = r.a().backup;
    r.f.backupsList = [{ slug, name: r.a().backupName! }];
    r.advance(ACCEPT_MS + 1_000); await r.poll();
    expect(r.a().status).toBe("aborted");
    expect(pagesWith(r, "the link never claimed it")).toBe(1);
    expect(r.k.st.keptBackups![slug].reason).toContain("aborted");
    expect(r.claim().status).toBe(409);
  });
});

describe("0.1.15 item 9: a cancel that fails, times out or answers pending", () => {
  test("a cancel whose step runs out is recorded as asked: no claim after it, and the next poll ends it as a terminal abort", async () => {
    const r = rig();
    await r.register(); await r.poll();
    r.f.activeJobs = null;
    (r.k as any).d.activeJobs = () => new Promise(() => {});   // the jobs list hangs past the step's bound
    (r.k as any).d.lockCallMs = 1000;
    const c = await r.k.cancel(CAIN, ID, { why: "the pass gave up" });
    expect(c.status).toBe(503);
    expect(r.a().abortAsked?.why).toBe("the pass gave up");
    expect(String(r.claim().body.why)).toContain("a cancel was asked for it");
    await r.poll();
    expect(r.a().status).toBe("aborted");
    r.install("started", false); await r.poll(ROLL);          // a late install after the abort: never watched, never rolled back
    expect(r.a().status).toBe("unprotected");
    expect(r.restores).toEqual([]);
  });
  test("a cancel asked while the backup is still being made wins over the backup's late completion", async () => {
    const r = rig();
    let finish: (v: { slug: string }) => void = () => {};
    r.f.makeBackup = () => new Promise((res) => { finish = res; });
    await r.k.registerAttempt(CAIN, { token: shipToken(), app: CAIN, pr: 46, head: HEAD, from_version: "0.16.0", to_version: "0.17.0", probe_hash: HASH, kind: "ship" });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    r.a().abortAsked = { at: r.now, why: "a pending cancel" };
    finish({ slug: "kb-x" }); await r.k.whenSettled(ID);
    expect(r.a().status).toBe("aborted");
    expect(r.a().acceptedAt).toBeUndefined();
  });
});

describe("0.1.15 item 10: restore safety of the spent lists", () => {
  test("the spent list is authoritative: a state rolled back before the nonce was kept still refuses it", async () => {
    const r = rig();
    const saved = JSON.parse(JSON.stringify(r.k.st));
    expect((await r.register({ head: headN(1), kind: "drill", drill_nonce: "00000000000000bb" })).status).toBe(200);
    expect(r.f.spent.has("00000000000000bb")).toBe(true);
    const r2 = rig({ saved });                                // Keeper's state restored from before; the spent list kept
    r2.f.spent.add("00000000000000bb");
    r2.k.start();
    const again = await r2.register({ head: headN(2), kind: "drill", drill_nonce: "00000000000000bb" });
    expect(again.status).toBe(409);
    expect(String(again.body.why)).toContain("a replay: that drill flag's nonce was registered");
  });
  test("a spent list that can't be read or written refuses every drill registration", async () => {
    const r = rig();
    r.f.spentListOk = false; r.k.start();
    expect(String((await r.register({ head: headN(1), kind: "drill" })).body.why)).toContain("the drill flags' spent list can't be read");
    const s = rig();
    s.f.spentOk = false;
    expect(String((await s.register({ head: headN(1), kind: "drill" })).body.why)).toContain("couldn't be recorded in the spent list");
  });
  test("the spent list is excluded from Keeper's backups, by the Supervisor's own rule", () => {
    for (const n of ["drill-spent", "drill-spent/00000000000000bb"]) expect(excludedName(n)).toBe(true);
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    for (const g of ["drill-spent", "*/drill-spent", "drill-spent/*", "*/drill-spent/*"]) expect(cfg).toContain(`  - "${g}"`);
  });
  test("the real spent list: one file per nonce, exclusive, kept across a new store", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "keeper-ds-")), "drill-spent");
    const ds = drillSpent(dir);
    expect(ds.list()).toEqual([]);
    expect(ds.add("00000000000000cc")).toBe(true);
    expect(ds.add("00000000000000cc")).toBe(false);
    expect(ds.add("not-a-nonce")).toBe(false);
    expect(drillSpent(dir).list()).toEqual(["00000000000000cc"]);
  });
});

describe("0.1.15 item 13: every Ship token carries an explicit kind ship", () => {
  test("a registration with a token that has no kind is refused", async () => {
    const r = rig();
    const ans = await r.register({ token: shipToken({ noKind: true }) });
    expect(ans.status).toBe(409);
    expect(String(ans.body.why)).toBe("its token's payload kind isn't a Ship approval");
  });
});

describe("0.1.15 item 14: the attempt query is read only and answers for the given attempt", () => {
  test("GET /attempt/<id> saves nothing and moves no counter; the open-attempt read carries no drill fields", async () => {
    const r = rig();
    expect((await r.register({ head: headN(1), kind: "drill", drill_mode: "exit-on-start" })).status).toBe(200);
    const counter = r.k.st.counter;
    const saved = JSON.stringify(r.saved);
    const one = await handle(r.k, new Request(`http://keeper/attempt/${idOf(headN(1), "drill")}`, { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {});
    expect(((await one.json()) as any).id).toBe(idOf(headN(1), "drill"));
    expect(r.k.st.counter).toBe(counter);
    expect(JSON.stringify(r.saved)).toBe(saved);
    const other = await handle(r.k, new Request(`http://keeper/attempt/drill-46-cain-ffffffff`, { headers: { authorization: `Bearer ${TOKEN}` } }), "172.30.33.4", () => {});
    expect(other.status).toBe(404);
  });
});

describe("0.1.15 item 16: the lock's release fences a step that hung past it", () => {
  test("a step that resumes after its release changes nothing: no commit, no delete, no state write", async () => {
    const r = rig();
    let resume: () => void = () => {};
    const before = r.k.st.counter;
    let wrote = false;
    const p = r.k.record(async (f) => { await new Promise<void>((res) => { resume = res; }); if (f.live()) { wrote = true; r.k.save(); } await f.write("a delete", () => { wrote = true; }); return "late"; }, () => "released");
    expect(await p).toBe("released");
    resume(); await Bun.sleep(5);
    expect(wrote).toBe(false);
    expect(r.k.st.counter).toBe(before);
  });
});

describe("0.1.15 item 17: the key file's temporary file inside the exclusion, leftovers removed at every start", () => {
  test("the fixed prefix is excluded, and a leftover is removed and logged at start", () => {
    expect(excludedName(`${KEY_TMP_PREFIX}0123456789ab`)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "keeper-kt-"));
    writeFileSync(join(dir, `${KEY_TMP_PREFIX}0123456789ab`), "x");
    const r = rig();
    (r.k as any).d.keyFiles = keyFiles(dir);
    r.k.start();
    expect(r.logs).toContain(`removed a leftover key file ${KEY_TMP_PREFIX}0123456789ab (a temporary file from an interrupted write)`);
  });
});

describe("0.1.15 item 18: an unreadable or timed-out options read counts as the old key present, not armable", () => {
  test("a failed options read is not armable and refuses hc-key", async () => {
    const r = rig();
    r.k.optionsUnreadable();
    expect(r.k.armableWhy()).toBe(OPTIONS_UNKNOWN_WHY);
    (r.k as any).d.options = () => new Promise(() => {});
    await r.poll();
    expect(r.k.armableWhy()).toBe(OPTIONS_UNKNOWN_WHY);
  });
});

describe("0.1.15 item 19: an end that can't confirm idle logs its distinct line with the backup's name", () => {
  test("a cancel while an install job runs: \"ended; backup kept: <reason>\" naming the backup", async () => {
    const r = rig();
    await r.register(); await r.poll();
    r.f.activeJobs = ["addon_update"];
    expect((await r.k.cancel(CAIN, ID, { why: "gave up" })).status).toBe(200);
    expect(r.logs.some((l) => l.startsWith(`${ID}: ended; backup kept: cancelled while an install or update of ${CAIN} is running`) && l.includes(r.a().backup) && l.includes(r.a().backupName!))).toBe(true);
  });
});

describe("0.1.15 item 20: one installer at every entry point, and the limits' text", () => {
  test("a registration waits while an earlier attempt's install job has no recorded end", async () => {
    const r = rig();
    await r.register(); await r.poll(); r.claim(); r.job({ done: false }); await r.poll();
    r.advance(CLAIM_MS + JOB_GRACE_MS + 1_000); await r.poll();
    expect(r.a().status).toBe("aborted");
    const two = await r.register({ head: headN(2) });
    expect(String(two.body.why)).toContain("has no recorded end yet (one installer at a time");
  });
  test("the accepted limits are text version 7 and say a claim is no single-use installer authorization", () => {
    expect(LIMITS_VERSION).toBe(7);
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    const lim = docs.slice(docs.indexOf("## Accepted limits"), docs.indexOf("## Options"));
    for (const t of ["Text version 7", "A claim is not a single-use installer authorization", "every entry point", "wait for the recorded claim end",
      "install job", "14 days by default and at most", "A failed drill"]) expect(lim).toContain(t);
  });
});

describe("0.1.15 item 21: enrollment, codes and the drill interval", () => {
  test("the re-enrollment code is printed only on demand, and the drill interval can be shorter", () => {
    const r = rig();
    const n = r.logs.filter((l) => l.startsWith("one-time code for key-confirm")).length;
    r.k.start();
    expect(r.logs.filter((l) => l.startsWith("one-time code for key-confirm")).length).toBe(n);
    r.k.keyCode();
    expect(r.logs.filter((l) => l.startsWith("one-time code for key-confirm")).length).toBe(n + 1);
    expect(parseOptions({ drill_days: 7 }).drill_days).toBe(7);
  });
});

describe("0.1.15 item 22: the device list's order", () => {
  test("the placeholder check of the exclusion comes before the live key, and the old key's rotation attestation before arming", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "DOCS.md"), "utf8").replace(/\s+/g, " ");
    const dev = docs.slice(docs.indexOf("(0.1.15) This round's device checks"));
    const a = dev.indexOf("placeholder"), b = dev.indexOf("live key"), c = dev.indexOf("rotation attestation"), d = dev.indexOf("before arming");
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b); expect(d).toBeGreaterThan(c);
  });
});
