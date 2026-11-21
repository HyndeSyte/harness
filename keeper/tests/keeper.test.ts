// Keeper 0.1.0: the attempt life cycle with a fake Supervisor and a fake clock, verdict binding and
// token refusal, /armed freshness and bindings, the Healthchecks queue, the rewind drop, and the
// options re-read without a restart. 0.1.1 (the first review's fixes): the restore reconciled from its
// job, the registration that changes the keeper's settings, the spent-id replay, the protected backup,
// every rollback paged, the heartbeat-delivery gate on /armed, and the restart-loop rule.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CONFIRM_MS, DELIVERY_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, RESTORE_LIMIT_MS, REWIND_MS, WATCH_MS, optionsHash, parseOptions, parseAuthorization, type AppInfo, type BackupInfo, type JobState, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
import { healthUrl, liveUrl } from "../rootfs/opt/keeper/main.ts";
import { supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { handle, internal } from "../rootfs/opt/keeper/server.ts";

const CAIN = "0fcc2575_cain";
const TOKEN = "cain-token-0123456789abcdef";
const T0 = Date.parse("2026-11-21T15:00:00Z");
const EMPTY = { id: "", app: "", from_version: "", to_version: "", backup_slug: "", install_deadline: "", authorization: "", probe_hash: "" };
const HASH = "abcdef0123456789";
// Polls from a fail to the end of the confirm window (the restore, then 5 minutes started and healthy).
const ROLL = CONFIRM_MS / POLL_MS + 4;

// A well formed authorization (0.1.2): its token hash differs per id, so ids don't replay each other.
const AUTH = (id: string, kind = "ship", over: { exp?: number; pr?: string; head?: string } = {}) =>
  `${kind} sha256=${createHash("sha256").update(`tok-${id}`).digest("hex")} pr=${over.pr ?? "46"} head=${over.head ?? "7d7b5f9".padEnd(40, "0")} expires=${new Date(over.exp ?? T0 + 3_600_000).toISOString()}`;

function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string }[] = [];
  const jobCalls: string[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    app, healthy: true, alive: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
    // the Supervisor's jobs list, by job id (jobsUp false: unreadable); finishJobs: a default restore's
    // job is listed done without errors
    jobs: {} as Record<string, JobState>, jobsUp: true,
    pingFails: (_url: string) => !f.pingOk,
    backup: o.backup === null ? null : { homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: false, ...(o.backup ?? {}) } as BackupInfo | null,
    onRestore: () => { app.version = "0.16.0"; app.state = "started"; },
    options: {
      watch: [CAIN], health: [`${CAIN}=0fcc2575-cain:8098`], tokens: [`${CAIN}=${TOKEN}`],
      hc_done: "https://hc-ping.example/done", hc_failed: "https://hc-ping.example/failed", health_grace_s: 0,
      attempt: { id: "", app: "", from_version: "", to_version: "", backup_slug: "", install_deadline: "", authorization: "", probe_hash: "" },
      ...(o.opts ?? {}),
    } as any,
  };
  const k = new Keeper({
    now: () => now, version: "0.1.0", self: "0fcc2575_keeper",
    appInfo: async (slug) => (f.infoUp && slug === CAIN ? { ...app } : null),
    backupInfo: async () => f.backup,
    restore: async (backup, a) => {
      restores.push({ backup, app: a });
      const r = f.restoreQueue.shift();
      if (r) return r;
      // the default: the Supervisor takes it as job job-<n>, which runs and finishes
      const id = `job-${restores.length}`;
      f.jobs[id] = { found: true, uuid: id, done: true, errors: 0 };
      f.onRestore();
      return { kind: "started", job: id };
    },
    job: async (uuid) => { jobCalls.push(uuid); return f.jobsUp ? f.jobs[uuid] ?? { found: false } : null; },
    health: async () => f.healthy,
    live: async () => f.alive,
    ping: async (url, body) => { pings.push({ url, body }); return !f.pingFails(url); },
    options: () => JSON.parse(JSON.stringify(f.options)),
    save: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.useOptions(f.options);
  k.start();
  const r = {
    k, f, logs, pings, restores, jobCalls, get saved() { return saved; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    register(over: any = {}) {
      const id = over.id ?? "a1";
      f.options.attempt = { id, app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup_slug: "b1234567",
        install_deadline: new Date(now + 30 * 60_000).toISOString(), authorization: AUTH(id), probe_hash: HASH, ...over };
    },
    async poll(n = 1) { for (let i = 0; i < n; i++) { await k.poll(); now += POLL_MS; } },
    install(state = "started") { app.version = "0.17.0"; app.state = state; },
    verdict(result: "PASS" | "FAIL", over: any = {}) { return k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: "a1", result, reason: result === "FAIL" ? "no answer" : "", ...over }); },
    a(id = "a1") { return k.st.attempts[id]; },
  };
  return r;
}

describe("registration and the backup check", () => {
  test("a good registration is accepted with its one log line", async () => {
    const r = rig(); r.register(); await r.poll();
    expect(r.a().status).toBe("accepted");
    expect(r.logs).toContain("accepting a1 0fcc2575_cain 0.16.0 to 0.17.0 backup b1234567");
  });
  for (const [name, backup, why] of [
    ["holds Home Assistant", { homeassistant: "2026.11.2" }, "holds Home Assistant"],
    ["holds two Apps", { addons: [{ slug: CAIN, version: "0.16.0" }, { slug: "x", version: "1" }] }, "2 Apps"],
    ["holds folders", { folders: ["share"] }, "folders"],
    ["holds another version", { addons: [{ slug: CAIN, version: "0.15.0" }] }, "0.15.0, not 0.16.0"],
    ["holds another App", { addons: [{ slug: "other", version: "0.16.0" }] }, "holds other"],
  ] as const) {
    test(`a backup that ${name} leaves the attempt unprotected: never restored, the owner hears`, async () => {
      const r = rig({ backup: backup as any }); r.register(); await r.poll();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs.some((l) => l.startsWith("refusing a1: ") && l.includes(why))).toBe(true);
      expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("can't protect"))).toBe(true);
      r.install("error"); await r.poll(5);
      expect(r.restores).toEqual([]);
    });
  }
  test("a backup the Supervisor never answers for is unprotected after two minutes", async () => {
    const r = rig({ backup: null }); r.register(); await r.poll();
    expect(r.a().status).toBe("verifying");
    await r.poll(5);
    expect(r.a().status).toBe("unprotected");
  });
  test("bad registrations are refused: the keeper itself, an unwatched App, a drill with no token, a passed deadline", async () => {
    for (const [over, why] of [
      [{ app: "0fcc2575_keeper" }, "its own install"], [{ app: "0fcc2575_harness" }, "watch list"],
      [{ authorization: "drill" }, "authorization"], [{ install_deadline: new Date(T0 - 1000).toISOString() }, "passed"],
      [{ probe_hash: "nope" }, "probe_hash"],
    ] as const) {
      const r = rig(); r.register(over); await r.poll();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs.some((l) => l.includes(why))).toBe(true);
    }
  });
  test("a registration is taken once: the same id left in the options isn't registered again", async () => {
    const r = rig(); r.register(); await r.poll(3);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
  });
  test("authorization (0.1.2): the token's sha256, the pull request, its head and the expiry; never a token", () => {
    const a = parseAuthorization(AUTH("x"))!;
    expect(a.kind).toBe("ship");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.pr).toBe(46);
    expect(a.head).toMatch(/^[0-9a-f]{40}$/);
    expect(a.expires).toBe(T0 + 3_600_000);
    expect(parseAuthorization(AUTH("x", "drill"))?.kind).toBe("drill");
    const h = "a".repeat(64), head = "b".repeat(40);
    expect(parseAuthorization(`ship sha256=${h} pr=46 head=${head} expires=1795000000`)?.expires).toBe(1795000000_000);
    expect(parseAuthorization(`ship expires=1795000000 head=${head} pr=46 sha256=${h}`)?.pr).toBe(46);   // any order
    for (const bad of ["ship", "drill tok-12345678", "ship ship1.abc.def", `merge sha256=${h} pr=46 head=${head} expires=1795000000`,
      `ship sha256=${h.slice(1)} pr=46 head=${head} expires=1795000000`, `ship sha256=${h.toUpperCase()} pr=46 head=${head} expires=1795000000`,
      `ship sha256=${h} pr=0 head=${head} expires=1795000000`, `ship sha256=${h} pr=46 head=${head.slice(2)} expires=1795000000`,
      `ship sha256=${h} pr=46 head=${head} expires=soon`, `ship sha256=${h} pr=46 pr=47 head=${head}`,
      `ship sha256=${h} pr=46 head=${head} expires=1795000000 token=ship1.x.y`])
      expect([bad, parseAuthorization(bad)]).toEqual([bad, null]);
  });
});

describe("the watch", () => {
  async function watching(r: ReturnType<typeof rig>) { r.register(); await r.poll(); r.install(); await r.poll(); expect(r.a().status).toBe("watching"); }
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
  test("a FAIL verdict fails at once", async () => {
    const r = rig(); await watching(r);
    r.verdict("FAIL"); expect(r.a().status).toBe("restoring");
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.a().trigger?.kind).toBe("verdict");
  });
  test("state error fails at once", async () => {
    const r = rig(); await watching(r); r.f.app.state = "error"; await r.poll();
    expect(r.a().trigger?.kind).toBe("state-error");
  });
  test("not started on two polls in a row fails; one poll doesn't", async () => {
    const r = rig(); await watching(r);
    r.f.app.state = "stopped"; await r.poll(); expect(r.a().status).toBe("watching");
    r.f.app.state = "started"; await r.poll(); expect(r.a().status).toBe("watching");
    r.f.app.state = "stopped"; await r.poll(2);
    expect(r.a().trigger?.kind).toBe("not-started");
  });
  test("one stopped poll after the first start makes the end a fail even with a PASS", async () => {
    const r = rig(); await watching(r); r.verdict("PASS");
    r.f.app.state = "stopped"; await r.poll(); r.f.app.state = "started";
    await r.poll(WATCH_MS / POLL_MS + 1);
    expect(r.a().trigger?.kind).toBe("watch-end");
    expect(r.a().trigger?.words).toContain("every poll");
  });
  test("/health failing on three polls in a row fails (after the grace)", async () => {
    const r = rig(); await watching(r); r.f.healthy = false;
    await r.poll(2); expect(r.a().status).toBe("watching");
    await r.poll(); expect(r.a().trigger?.kind).toBe("health");
  });
  test("the health grace: failures in the first seconds after the start don't count", async () => {
    const r = rig({ opts: { health_grace_s: 180 } }); r.register(); await r.poll(); r.install(); await r.poll(); r.f.healthy = false; await r.poll(4);
    expect(r.a().status).toBe("watching");
    await r.poll(4); expect(r.a().trigger?.kind).toBe("health");
  });
  test("the install deadline passing with the new version seen but never started fails and restores", async () => {
    const r = rig(); r.register({ install_deadline: new Date(T0 + 60_000).toISOString() }); await r.poll();
    r.install("stopped"); r.f.app.state = "stopped";
    // a stopped App would fail on two polls anyway; the deadline must fail it first when it passes
    r.advance(2 * 60_000); await r.poll();
    expect(["deadline", "not-started"]).toContain(r.a().trigger?.kind!);
    expect(r.a().status).toBe("restoring");
  });
  test("the install never starting (still the old version at the deadline) restores nothing, and the owner hears", async () => {
    const r = rig(); r.register({ install_deadline: new Date(T0 + 60_000).toISOString() }); await r.poll();
    r.advance(2 * 60_000); await r.poll();
    expect(r.a().status).toBe("never started");
    expect(r.restores).toEqual([]);
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("never started"))).toBe(true);
  });
});

describe("the restore", () => {
  test("a busy Supervisor is retried with backoff inside the limit; one restore per attempt", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    r.f.restoreQueue.push({ kind: "refused", retry: true, why: "400 a backup is running" }, { kind: "refused", retry: true, why: "400 a backup is running" });
    r.verdict("FAIL");
    await r.poll(4 + ROLL);
    expect(r.restores.length).toBe(3);
    expect(r.a().status).toBe("rolled back");
    expect(r.logs.filter((l) => l.includes("tried again in")).length).toBe(2);
    await r.poll(10);
    expect(r.restores.length).toBe(3);
  });
  test("busy past the limit ends as gave up, and the owner hears", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    for (let i = 0; i < 30; i++) r.f.restoreQueue.push({ kind: "refused", retry: true, why: "busy" });
    r.verdict("FAIL"); await r.poll(40);
    expect(r.a().status).toBe("gave up");
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("gave up"))).toBe(true);
  });
  test("an App that doesn't come back ends as gave up", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    r.f.onRestore = () => { r.f.app.version = "0.16.0"; r.f.app.state = "error"; };
    r.verdict("FAIL"); await r.poll(CONFIRM_MS / POLL_MS + 3);
    expect(r.a().status).toBe("gave up");
  });
  test("the recovery's version change opens no attempt and isn't an unregistered change", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    r.verdict("FAIL"); await r.poll(ROLL);
    expect(Object.keys(r.k.st.attempts)).toEqual(["a1"]);
    expect(r.logs.some((l) => l.startsWith("unregistered"))).toBe(false);
  });
  test("a restart while restoring: the restore isn't started twice, only reconciled (the App seen down, then back) and confirmed", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL");
    const st = JSON.parse(JSON.stringify(r.k.st)); Object.assign(st.attempts.a1.restore, { inflight: true, tries: 1, sentAt: r.now });
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0"; r2.f.app.state = "stopped";
    await r2.poll(2);
    r2.f.app.version = "0.16.0"; r2.f.app.state = "started";
    await r2.poll(ROLL);
    expect(r2.restores).toEqual([]);
    expect(r2.a().status).toBe("rolled back");
  });
  test("resume after a restart: a deadline that passed while the keeper was down is judged at once", async () => {
    const r = rig(); r.register({ install_deadline: new Date(T0 + 60_000).toISOString() }); await r.poll();
    r.install("stopped");
    const st = JSON.parse(JSON.stringify(r.k.st));
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0"; r2.f.app.state = "stopped"; r2.advance(5 * 60_000);
    await r2.poll();
    expect(r2.a().status).toBe("restoring");
    expect(r2.logs.some((l) => l.startsWith("resuming a1"))).toBe(true);
  });
});

describe("unregistered changes", () => {
  test("a version change with no attempt never restores; it is logged and alarmed", async () => {
    const r = rig(); await r.poll(); r.install(); await r.poll();
    expect(r.logs.some((l) => l.startsWith("unregistered change 0fcc2575_cain 0.16.0 to 0.17.0"))).toBe(true);
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail"))).toBe(true);
    expect(r.restores).toEqual([]);
  });
});

describe("verdicts and tokens", () => {
  test("a verdict binds to the open attempt of its App, at its version, with its token", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    expect(r.verdict("PASS", { attempt: "other" }).ok).toBe(false);
    expect(r.verdict("PASS", { version: "0.16.0" }).ok).toBe(false);
    expect(r.k.verdict("0fcc2575_harness", { app: CAIN, version: "0.17.0", attempt: "a1", result: "PASS" }).ok).toBe(false);
    expect(r.verdict("PASS", { result: "MAYBE" }).ok).toBe(false);
    expect(r.verdict("PASS").ok).toBe(true);
    expect(r.verdict("FAIL").ok).toBe(false);
    expect(r.a().verdict?.result).toBe("PASS");
  });
  test("the HTTP service: an App's own token, the internal network only", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    const log: string[] = [];
    const call = (path: string, init: RequestInit = {}, ip = "172.30.33.4", token: string | null = TOKEN) =>
      handle(r.k, new Request(`http://keeper${path}`, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} }), ip, (m) => log.push(m));
    expect((await call("/attempt", {}, "192.168.1.10")).status).toBe(403);
    expect((await call("/attempt", {}, "172.30.33.4", "wrong-token-0123456789")).status).toBe(401);
    expect((await call("/attempt", {}, "172.30.33.4", null)).status).toBe(401);
    const at = await (await call("/attempt")).json() as any;
    expect(at.attempt).toBe("a1");
    const v = await call("/verdict", { method: "POST", body: JSON.stringify({ app: CAIN, version: "0.17.0", attempt: "a1", result: "PASS", reason: "" }) });
    expect(v.status).toBe(200);
    expect((await call("/drill-record", { method: "POST", body: "{}" })).status).toBe(403);
    expect(log.filter((l) => l.startsWith("refused")).length).toBe(4);
    expect(internal("::ffff:172.30.32.7")).toBe(true);
    expect(internal("172.30.34.1")).toBe(false);
  });
});

describe("the Healthchecks queue", () => {
  test("a fail ping is retried until delivered; a success ping follows once the condition clears", async () => {
    const r = rig(); r.f.pingOk = false;
    await r.poll(); r.install(); await r.poll();
    expect(r.k.st.queue.length).toBe(1);
    await r.poll(3);
    expect(r.k.st.queue.length).toBe(1);
    r.f.pingOk = true; r.advance(10 * 60_000); await r.poll();
    expect(r.k.st.queue.length).toBe(0);
    expect(r.k.st.outstanding[CAIN]).toBe(true);
    await r.poll(3);
    expect(r.k.st.outstanding[CAIN]).toBeUndefined();
    const last = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/failed") && !p.url.endsWith("/log")).at(-1)!;
    expect(last.url).toBe("https://hc-ping.example/failed");
  });
  test("every rollback pages the phone: a fail ping with the line when it starts, the success ping with the line once confirmed", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL");
    await r.poll();
    const start = r.pings.findIndex((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.startsWith("Keeper is rolling back Cain from 0.17.0 to 0.16.0"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(r.pings.some((p) => p.body.startsWith("Keeper rolled back"))).toBe(false);   // not before the old version is confirmed
    await r.poll(ROLL);
    const done = r.pings.findIndex((p) => p.url === "https://hc-ping.example/failed" && p.body.startsWith("Keeper rolled back Cain from 0.17.0 to 0.16.0"));
    expect(done).toBeGreaterThan(start);
    expect(r.pings.some((p) => p.url.startsWith("https://hc-ping.example/done") && p.body !== "keeper heartbeat")).toBe(false);   // never only on the heartbeat
    expect(r.k.st.last[CAIN].kind).toBe("rolled back");
    expect(r.k.st.outstanding[CAIN]).toBeUndefined();
  });
  test("the success ping waits for the rollback's fail ping: an undelivered start keeps both queued, in order", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    r.f.pingOk = false; r.verdict("FAIL"); await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.k.st.queue.map((q) => q.kind)).toEqual(["rolling back", "rolled back"]);
    r.f.pingOk = true; r.advance(10 * 60_000); await r.poll();
    const lines = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/failed") && !p.url.endsWith("/log")).map((p) => p.url.endsWith("/fail") ? "fail" : "ok");
    expect(lines.slice(-2)).toEqual(["fail", "ok"]);
    expect(r.k.st.queue).toEqual([]);
  });
  test("the heartbeat goes to hc_done every 5 minutes", async () => {
    const r = rig(); await r.poll(HC_HEARTBEAT_MS / POLL_MS * 2);
    expect(r.pings.filter((p) => p.body === "keeper heartbeat").length).toBe(2);
  });
  test("with no URLs set the lines are only logged, and the keeper says it isn't armable", async () => {
    const r = rig({ opts: { hc_done: "", hc_failed: "" } }); await r.poll(); r.install(); await r.poll();
    expect(r.pings).toEqual([]);
    expect(r.logs.some((l) => l.includes("not armable"))).toBe(true);
    expect(r.k.armedView(CAIN).armed).toBe(false);
  });
});

describe("drills and the armed record", () => {
  async function drill(r: ReturnType<typeof rig>, id: string, how: "verdict" | "exit") {
    r.f.app.version = "0.16.0"; r.f.app.state = "started";
    r.register({ id, authorization: AUTH(id, "drill") }); await r.poll();
    r.install(how === "exit" ? "error" : "started"); await r.poll();
    if (how === "verdict") r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
    await r.poll(ROLL);
    expect(r.a(id).status).toBe("rolled back");
  }
  test("both drills, each restored with a delivered owner line, arm the App; /armed says so with its binding", async () => {
    const r = rig();
    await drill(r, "d1", "verdict");
    expect(r.k.st.drills[CAIN]?.["fail-verdict"]).toBeTruthy();
    expect(r.k.armedView(CAIN).armed).toBe(false);
    await drill(r, "d2", "exit");
    const v = r.k.armedView(CAIN);
    expect(v.armed).toBe(true);
    expect(v.binding).toEqual({ protocol: 1, probe_hash: HASH, keeper_version: "0.1.0", options_hash: optionsHash(parseOptions(r.f.options)), backup_scope: "app-only" });
    expect(v.keeper_version).toBe("0.1.0");
  });
  test("an undelivered owner line records no drill; a ship attempt never does", async () => {
    const r = rig(); r.f.pingOk = false;
    await drill(r, "d1", "verdict");
    expect(r.k.st.drills[CAIN]).toBeUndefined();
    const r2 = rig(); r2.register(); await r2.poll(); r2.install(); await r2.poll(); r2.verdict("FAIL"); await r2.poll(ROLL);
    expect(r2.k.drillRecord("a1").ok).toBe(false);
  });
  test("an options change, a new probe hash, unset Healthchecks URLs, 60 days or a rewind drop the armed record", async () => {
    const armed = async () => { const r = rig(); await drill(r, "d1", "verdict"); await drill(r, "d2", "exit"); expect(r.k.armedView(CAIN).armed).toBe(true); return r; };
    let r = await armed(); r.f.options.health_grace_s = 60; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armed(); r.f.options.hc_done = "https://hc-ping.example/done2"; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armed(); r.f.options.hc_failed = "https://hc-ping.example/failed2"; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armed(); r.register({ id: "a9", probe_hash: "ffffffffffffffff" }); await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armed(); r.advance(61 * 86_400_000); await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
    r = await armed();
    const st = JSON.parse(JSON.stringify(r.k.st)); st.heartbeat = T0 - REWIND_MS - 60_000;
    const r2 = rig({ saved: st });
    expect(r2.k.armedView(CAIN).armed).toBe(false);
    expect(r2.logs.some((l) => l.includes("dropped"))).toBe(true);
  });
  test("/armed's timestamp is the heartbeat, refreshed every minute", async () => {
    const r = rig(); r.advance(60_000); r.k.heartbeat();
    expect(r.k.armedView(CAIN).at).toBe(new Date(T0 + 60_000).toISOString());
  });
});

describe("options", () => {
  test("re-read every poll: a change takes effect without a restart", async () => {
    const r = rig(); await r.poll();
    r.f.options.watch = [CAIN, "0fcc2575_harness"];
    await r.poll();
    expect(r.k.opts.watch).toContain("0fcc2575_harness");
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
});

// -- 0.1.1 and 0.1.2: the review fixes -------------------------------------------------------------
async function failed(r: ReturnType<typeof rig>) { r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL"); }
async function drillOf(r: ReturnType<typeof rig>, id: string, how: "verdict" | "exit") {
  r.f.app.version = "0.16.0"; r.f.app.state = "started";
  r.register({ id, authorization: AUTH(id, "drill") }); await r.poll();
  r.install(how === "exit" ? "error" : "started"); await r.poll();
  if (how === "verdict") r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
  await r.poll(ROLL);
  expect(r.a(id).status).toBe("rolled back");
}
async function armedRig(opts?: any) { const r = rig({ opts }); await drillOf(r, "d1", "verdict"); await drillOf(r, "d2", "exit"); expect(r.k.armedView(CAIN).armed).toBe(true); return r; }
const LIMIT_POLLS = RESTORE_LIMIT_MS / POLL_MS + 2;

describe("the restore is sent again only when the first provably never ran (0.1.2)", () => {
  test("the job id in the answer is saved before anything else", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-x" }); r.f.jobs["job-x"] = { found: true, uuid: "job-x", done: false, errors: 0 };
    await failed(r); await r.poll();
    expect(r.saved!.attempts.a1.restore!.job).toBe("job-x");
    expect(r.logs.some((l) => l.includes("running as job job-x"))).toBe(true);
  });
  test("an explicit error answer (nothing executed) sends it again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", retry: true, why: "500 boom" });
    await failed(r); await r.poll(3 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
  });
  test("the job named by the answer's id, seen ended with errors with the App not back: sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-e" }); r.f.jobs["job-e"] = { found: true, uuid: "job-e", done: true, errors: 1 };
    await failed(r); await r.poll(2);
    expect(r.logs.some((l) => l.includes("the restore job job-e ended without restoring (1 error, 0fcc2575_cain at 0.17.0)"))).toBe(true);
    await r.poll(3 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
  });
  test("the job by its id ended with errors but the App at from_version: never sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-e" }); r.f.jobs["job-e"] = { found: true, uuid: "job-e", done: true, errors: 2 };
    await failed(r); r.f.app.version = "0.16.0"; r.f.app.state = "started";
    await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("no job id in the answer, and a job listed for the same backup: never sent again, and that job never looked at", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: null });
    r.f.jobs["other"] = { found: true, uuid: "other", done: true, errors: 1 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.jobCalls).toEqual([]);
    expect(r.a().status).toBe("unresolved");
    expect(r.logs.some((l) => l.includes("gave no job id"))).toBe(true);
  });
  test("no answer at all: never sent again on that alone", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
  });
  test("version plus started alone never counts as landed; the App seen down after the call, then back, does", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll();
    r.f.app.version = "0.16.0"; r.f.app.state = "started";    // back, but never seen down after the call
    await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    const r2 = rig(); r2.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r2); await r2.poll();
    r2.f.app.state = "stopped"; await r2.poll();
    r2.f.app.version = "0.16.0"; r2.f.app.state = "started"; await r2.poll(ROLL);
    expect(r2.a().status).toBe("rolled back");
    expect(r2.restores.length).toBe(1);
  });
  test("the job by its id still running, then done: landed, never sent twice", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-7" }); r.f.jobs["job-7"] = { found: true, uuid: "job-7", done: false, errors: 0 };
    await failed(r); await r.poll(4);
    expect(r.a().status).toBe("restoring");
    expect(r.logs.filter((l) => l.includes("job job-7 is still running")).length).toBe(1);   // logged once, not every poll
    r.f.jobs["job-7"] = { found: true, uuid: "job-7", done: true, errors: 0 }; r.f.onRestore();
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.restores.length).toBe(1);
  });
  test("a restart in the middle of the call: fenced, reconciled from the App's states only", async () => {
    const r = rig(); await failed(r);
    const st = JSON.parse(JSON.stringify(r.k.st)); Object.assign(st.attempts.a1.restore, { inflight: true, tries: 1, sentAt: r.now });
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0"; r2.f.app.state = "started";
    await r2.poll(LIMIT_POLLS + 4);
    expect(r2.restores).toEqual([]);
    expect(r2.a().status).toBe("unresolved");
  });
});

describe("unresolved: fenced, reconciled on every poll, and told once known (0.1.2)", () => {
  test("reconciled while the keeper runs: the App seen down and back moves it to rolled back, with one follow-up line", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    const first = r.pings.findIndex((p) => p.url.endsWith("/failed/fail") && p.body.includes("can't tell whether its rollback"));
    expect(first).toBeGreaterThanOrEqual(0);
    await r.poll(10);
    expect(r.a().status).toBe("unresolved");
    expect(r.logs.filter((l) => l.startsWith("a1: still unresolved")).length).toBe(1);
    r.f.app.state = "stopped"; await r.poll();
    r.f.app.version = "0.16.0"; r.f.app.state = "started"; await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.restores.length).toBe(1);
    const follow = r.pings.filter((p, i) => i > first && p.body.startsWith("Keeper rolled back Cain"));
    expect(follow.length).toBe(1);
  });
  test("the job by its id found ended with errors later, the App not back: gave up, one follow-up line, nothing sent", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-u" }); r.f.jobs["job-u"] = { found: true, uuid: "job-u", done: false, errors: 0 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    r.f.jobs["job-u"] = { found: true, uuid: "job-u", done: true, errors: 1 }; await r.poll(3);
    expect(r.a().status).toBe("gave up");
    expect(r.restores.length).toBe(1);
    expect(r.pings.filter((p) => p.body.startsWith("Keeper gave up on Cain")).length).toBe(1);
  });
  test("across a restart and far past the limit it stays fenced: nothing is ever sent", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) }); r2.f.app.version = "0.17.0"; r2.f.app.state = "error";
    expect(r2.logs.some((l) => l.startsWith("reconciling a1"))).toBe(true);
    r2.advance(3 * 3_600_000);
    await r2.poll(3 * LIMIT_POLLS);
    expect(r2.a().status).toBe("unresolved");
    expect(r2.restores).toEqual([]);
  });
  test("the job by its id found finished after a restart: on to the confirm window and rolled back", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-9" }); r.f.jobs["job-9"] = { found: true, uuid: "job-9", done: false, errors: 0 };
    await failed(r); await r.poll(LIMIT_POLLS);
    expect(r.a().status).toBe("unresolved");
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) }); r2.f.jobs["job-9"] = { found: true, uuid: "job-9", done: true, errors: 0 }; r2.f.onRestore();
    await r2.poll(ROLL);
    expect(r2.a().status).toBe("rolled back");
    expect(r2.restores).toEqual([]);
  });
});

describe("the restart-loop rule after a restore", () => {
  test("started, then stopped or error, more than twice in the confirm window: gave up", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    expect(r.a().restore!.called).toBe(true);
    for (const st of ["started", "stopped", "started", "error", "started", "stopped"]) { r.f.app.state = st; await r.poll(); }
    expect(r.a().status).toBe("gave up");
    expect(r.a().why).toContain("keeps restarting");
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("keeps restarting"))).toBe(true);
  });
  test("one or two stops that settle still roll back", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    for (const st of ["started", "stopped", "started", "error", "started"]) { r.f.app.state = st; await r.poll(); }
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
  });
});

describe("the confirm window's one extension (0.1.2)", () => {
  test("started and alive but not ready at the end of the window: extended once by 5 minutes, then rolled back once ready", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    r.f.healthy = false; r.f.alive = true;
    await r.poll(CONFIRM_MS / POLL_MS + 1);
    expect(r.a().status).toBe("restoring");
    expect(r.logs.some((l) => l.includes("extended once, by 5 minutes"))).toBe(true);
    r.f.healthy = true; await r.poll(CONFIRM_MS / POLL_MS + 1);
    expect(r.a().status).toBe("rolled back");
  });
  test("still not ready after the extension: gave up; never extended twice", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    r.f.healthy = false;
    await r.poll(2 * CONFIRM_MS / POLL_MS + 3);
    expect(r.a().status).toBe("gave up");
    expect(r.a().why).toContain("10 minutes");
    expect(r.logs.filter((l) => l.includes("extended once")).length).toBe(1);
  });
  test("not alive either: no extension", async () => {
    const r = rig(); await failed(r); await r.poll(2);
    r.f.healthy = false; r.f.alive = false;
    await r.poll(CONFIRM_MS / POLL_MS + 2);
    expect(r.a().status).toBe("gave up");
  });
});

describe("readiness during the watch (0.1.2)", () => {
  test("failures count only after one 200 since the App's start; an App never ready fails at the end, not before", async () => {
    const r = rig(); r.register(); await r.poll(); r.f.healthy = false; r.install(); await r.poll(10);
    expect(r.a().status).toBe("watching");
    r.verdict("PASS"); await r.poll(WATCH_MS / POLL_MS);
    expect(r.a().trigger?.kind).toBe("watch-end");
  });
  test("a restart of the App resets it: failures after the restart wait for a new 200", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    r.f.app.state = "stopped"; await r.poll(); r.f.app.state = "started"; r.f.healthy = false; await r.poll(5);
    expect(r.a().status).toBe("watching");
    r.f.healthy = true; await r.poll(); r.f.healthy = false; await r.poll(3);
    expect(r.a().trigger?.kind).toBe("health");
  });
});

describe("the authorization at registration (0.1.2)", () => {
  for (const [name, over, why] of [
    ["the old plain form", { authorization: "ship" }, "isn't \"ship\" or \"drill\""],
    ["a token in place of its hash", { authorization: "ship ship1.abcdefghijklmnopqrstuvwxyz.sig" }, "isn't \"ship\" or \"drill\""],
    ["an expiry that has passed", { authorization: AUTH("a1", "ship", { exp: T0 - 1000 }) }, "has expired"],
    ["an expiry further off than a token lasts", { authorization: AUTH("a1", "ship", { exp: T0 + 3 * 3_600_000 }) }, "further off"],
  ] as const) {
    test(`${name} is refused as unprotected, and nothing is restored for it`, async () => {
      const r = rig(); r.register(over); await r.poll();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs.some((l) => l.startsWith("refusing a1: ") && l.includes(why))).toBe(true);
      r.install("error"); await r.poll(5);
      expect(r.restores).toEqual([]);
    });
  }
  test("the token hash is kept with the spent record, and no token is anywhere in the state", async () => {
    const r = rig(); r.register(); await r.poll();
    const h = createHash("sha256").update("tok-a1").digest("hex");
    expect(r.k.st.spent.find((x) => x.id === "a1")?.auth).toBe(h);
    expect(r.a().authHash).toBe(h);
    expect(JSON.stringify(r.saved)).not.toContain("tok-a1");
  });
  test("a registration for another version than the one installed ends as install never started, with no restore", async () => {
    const r = rig(); r.register({ install_deadline: new Date(T0 + 60_000).toISOString() }); await r.poll();
    r.f.app.version = "0.17.5"; r.f.app.state = "error";
    r.advance(2 * 60_000); await r.poll(5);
    expect(r.a().status).toBe("never started");
    expect(r.restores).toEqual([]);
  });
});

describe("a registration can't change the keeper's settings, and counts once", () => {
  for (const [name, over] of [
    ["drops the tokens", { tokens: [] }],
    ["changes Cain's token", { tokens: [`${CAIN}=someone-elses-token-0123`] }],
    ["drops hc_failed", { hc_failed: "" }],
    ["changes hc_done", { hc_done: "https://hc-ping.example/other" }],
  ] as const) {
    test(`a registration that ${name} is refused, and the kept settings stay in force`, async () => {
      const r = rig(); await r.poll();
      Object.assign(r.f.options, over); r.register(); await r.poll();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs).toContain("refusing a1: the registration changed the keeper's own settings");
      expect(r.k.appOfToken(TOKEN)).toBe(CAIN);
      expect(r.k.opts.hc_done).toBe("https://hc-ping.example/done");
      expect(r.k.alertUrl(CAIN)).toBe("https://hc-ping.example/failed");
      expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.includes("changed the keeper's own settings"))).toBe(true);
      await r.poll(3);
      expect(r.k.appOfToken(TOKEN)).toBe(CAIN);
    });
  }
  test("the same settings with a new registration are accepted; a token change with no registration is the owner's and taken", async () => {
    const r = rig(); await r.poll(); r.register(); await r.poll();
    expect(r.a().status).toBe("accepted");
    r.f.options.tokens = [`${CAIN}=a-new-token-0123456789`]; await r.poll();
    expect(r.k.appOfToken("a-new-token-0123456789")).toBe(CAIN);
  });
  test("an accepted registration left in the options is ignored silently: no replay line, no ping", async () => {
    const r = rig(); r.register(); await r.poll();
    const before = r.pings.filter((p) => !p.body.startsWith("keeper ")).length;
    await r.poll(20);
    expect(r.logs.some((l) => l.includes("replay"))).toBe(false);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
    expect(r.pings.filter((p) => !p.body.startsWith("keeper ")).length).toBe(before);
    expect(r.f.options.attempt.id).toBe("a1");             // the keeper never empties it
  });
  test("the same id with other fields is a replay: refused once, reported once", async () => {
    const r = rig(); r.register(); const first = { ...r.f.options.attempt }; await r.poll();
    r.f.options.attempt = { ...first, to_version: "0.18.0" }; await r.poll(3);
    expect(r.logs.filter((l) => l === "refusing a1: a replay: that id was spent with other fields").length).toBe(1);
    expect(r.pings.filter((p) => p.body.includes("a replay")).length).toBe(1);
    expect(r.a().status).toBe("accepted");                 // the attempt it was spent for is untouched
    r.f.options.attempt = first; await r.poll(2);           // the accepted one again: silent
    expect(r.pings.filter((p) => p.body.includes("a replay")).length).toBe(1);
  });
  test("the same authorization hash under another id is a replay: refused once, reported once", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("PASS"); await r.poll(WATCH_MS / POLL_MS + 1);
    expect(r.a().status).toBe("passed");
    r.f.app.version = "0.16.0";
    r.register({ id: "a2", authorization: AUTH("a1") }); await r.poll(4);
    expect(r.a("a2").status).toBe("unprotected");
    expect(r.logs.filter((l) => l === "refusing a2: a replay: that authorization was spent under a1").length).toBe(1);
    expect(r.pings.filter((p) => p.body.includes("a replay")).length).toBe(1);
  });
  test("one Ship tap's hash for a second App (one registration per App) isn't a replay", async () => {
    const H = "0fcc2575_harness";
    const r = rig({ opts: { watch: [CAIN, H], hc_failed: "https://hc-ping.example/failed" } }); r.register(); await r.poll();
    r.register({ id: "h1", app: H, authorization: AUTH("a1") }); await r.poll();
    expect(r.logs.some((l) => l.startsWith("refusing h1: a replay"))).toBe(false);
  });
  test("a registration never drops the drills (the options hash is over the static options only)", async () => {
    const r = await armedRig();
    const before = r.k.armedView(CAIN).binding;
    r.register({ id: "a7" }); await r.poll();
    expect(r.a("a7").status).toBe("accepted");
    expect(r.k.armedView(CAIN).armed).toBe(true);
    expect(r.k.armedView(CAIN).binding).toEqual(before);
    r.register({ id: "a8" }); r.f.options.tokens = [`${CAIN}=someone-elses-token-0123`]; await r.poll();   // a clobbering one: refused, still armed
    expect(r.a("a8").status).toBe("unprotected");
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
});

describe("the kept settings survive a wiped options file (0.1.2)", () => {
  test("a start with blank options uses the kept tokens and URLs, with one line logged", async () => {
    const r = rig(); await r.poll();
    expect(r.saved!.kept!.tokens[CAIN]).toBe(TOKEN);
    const st = JSON.parse(JSON.stringify(r.k.st));
    const r2 = rig({ saved: st, opts: { tokens: [], hc_done: "", hc_failed: [] } });
    expect(r2.k.appOfToken(TOKEN)).toBe(CAIN);
    expect(r2.k.opts.hc_done).toBe("https://hc-ping.example/done");
    expect(r2.k.alertUrl(CAIN)).toBe("https://hc-ping.example/failed");
    await r2.poll(5);
    expect(r2.logs.filter((l) => l === "the options lack tokens, hc_done, hc_failed: the ones kept in /data are used").length).toBe(1);
    expect(r2.k.appOfToken(TOKEN)).toBe(CAIN);
    expect(r2.k.armable()).toBe(true);
  });
  test("whatever the options carry is kept", async () => {
    const r = rig(); await r.poll();
    r.f.options.hc_done = "https://hc-ping.example/done-new"; await r.poll();
    expect(r.saved!.kept!.hc_done).toBe("https://hc-ping.example/done-new");
  });
  test("a registration arriving with the settings missing is still refused", async () => {
    const r = rig(); await r.poll();
    r.f.options.tokens = []; r.register(); await r.poll();
    expect(r.a().status).toBe("unprotected");
    expect(r.k.appOfToken(TOKEN)).toBe(CAIN);
  });
});

describe("the keeper never writes options (0.1.2)", () => {
  test("a whole cycle through the real Supervisor calls over a recording fake: no write but the restore", async () => {
    const calls: { method: string; path: string; body: any }[] = [];
    const app = { version: "0.16.0", state: "started" };
    const options: any = { watch: [CAIN], health: [`${CAIN}=c:8098`], tokens: [`${CAIN}=${TOKEN}`], hc_done: "https://hc/done", hc_failed: ["https://hc/failed"], health_grace_s: 0,
      attempt: { id: "a1", app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup_slug: "b1", install_deadline: new Date(T0 + 1_800_000).toISOString(), authorization: AUTH("a1"), probe_hash: HASH } };
    let job: any = null;
    const http = async (url: string, init: RequestInit) => {
      const path = url.replace("http://supervisor", "");
      calls.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (data: any) => new Response(JSON.stringify({ result: "ok", data }), { status: 200 });
      if (path === "/addons/self/info") return ok({ slug: "0fcc2575_keeper", version: "0.1.2", options });
      if (path === `/addons/${CAIN}/info`) return ok(app);
      if (path === "/backups/b1/info") return ok({ homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], protected: false });
      if (path === "/backups/b1/restore/partial") { job = { name: "x", uuid: "j1", done: true, errors: [], child_jobs: [] }; app.version = "0.16.0"; app.state = "started"; return ok({ job_id: "j1" }); }
      if (path === "/jobs/info") return ok({ jobs: job ? [job] : [] });
      return new Response(JSON.stringify({ result: "error" }), { status: 404 });
    };
    const sup = supervisor("t", "http://supervisor", http);
    let now = T0;
    const k = new Keeper({ now: () => now, version: "0.1.2", self: "0fcc2575_keeper", appInfo: sup.appInfo, backupInfo: sup.backupInfo, restore: sup.restore, job: sup.job,
      health: async () => true, live: async () => true, ping: async () => true, options: () => sup.selfOptions(), save: () => {}, log: () => {} }, null);
    k.useOptions(options); k.start();
    const poll = async (n: number) => { for (let i = 0; i < n; i++) { await k.poll(); now += POLL_MS; } };
    await poll(1); expect(k.st.attempts.a1.status).toBe("accepted");
    app.version = "0.17.0"; await poll(1);
    k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: "a1", result: "FAIL", reason: "x" });
    await poll(ROLL);
    expect(k.st.attempts.a1.status).toBe("rolled back");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /backups/b1/restore/partial"]);
    expect(writes[0].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true });
    expect(calls.some((c) => c.path.includes("options"))).toBe(false);
  });
  test("no code path names the options endpoint", () => {
    for (const f of ["core.ts", "supervisor.ts", "main.ts", "server.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "rootfs", "opt", "keeper", f), "utf8");
      expect([f, /addons\/self\/options|clearAttempt/.test(src)]).toEqual([f, false]);
    }
  });
});

describe("a backup must show protected false", () => {
  test("protected true or missing: unprotected before any accepting line, with its why", async () => {
    for (const backup of [{ protected: true }, { protected: undefined }]) {
      const r = rig({ backup }); r.register(); await r.poll();
      expect(r.a().status).toBe("unprotected");
      expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
      expect(r.logs.some((l) => l.startsWith("refusing a1: its backup isn't shown as made without a password"))).toBe(true);
    }
  });
  test("protected false is accepted", async () => {
    const r = rig({ backup: { protected: false } }); r.register(); await r.poll();
    expect(r.a().status).toBe("accepted");
  });
});

describe("alert checks per App (0.1.2)", () => {
  const H = "0fcc2575_harness";
  test("hc_failed as a single URL, a map or the list form", () => {
    expect(parseOptions({ hc_failed: "https://x/a" }).hc_failed).toEqual({ "*": "https://x/a" });
    expect(parseOptions({ hc_failed: { [CAIN]: "https://x/c" } }).hc_failed).toEqual({ [CAIN]: "https://x/c" });
    expect(parseOptions({ hc_failed: ["https://x/a?k=v", `${CAIN}=https://x/c`] }).hc_failed).toEqual({ "*": "https://x/a?k=v", [CAIN]: "https://x/c" });
    expect(parseOptions({ hc_failed: [] }).hc_failed).toEqual({});
  });
  test("each App's lines go to its own alert check, and a success ping clears only its own", async () => {
    const r = rig({ opts: { hc_failed: [`${CAIN}=https://hc-ping.example/cain`, "https://hc-ping.example/rest"] } });
    await failed(r); await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    const cain = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/cain") && !p.url.endsWith("/log"));
    expect(cain.map((p) => p.url)).toEqual(["https://hc-ping.example/cain/fail", "https://hc-ping.example/cain"]);
    expect(r.pings.some((p) => p.url.startsWith("https://hc-ping.example/rest") && !p.url.endsWith("/log"))).toBe(false);
    expect(r.k.alertUrl(H)).toBe("https://hc-ping.example/rest");
    r.k.st.outstanding[H] = true;                          // another App's incident stands
    r.k.owner(CAIN, "x", "a Cain line", true); await r.poll(5);
    expect(r.k.st.outstanding[H]).toBe(true);
  });
  test("not armable until every watched App has an alert check", () => {
    const r = rig({ opts: { watch: [CAIN, H], hc_failed: [`${CAIN}=https://hc-ping.example/cain`] } });
    expect(r.k.armable()).toBe(false);
    const r2 = rig({ opts: { watch: [CAIN, H], hc_failed: [`${CAIN}=https://hc-ping.example/cain`, `${H}=https://hc-ping.example/h`] } });
    expect(r2.k.armable()).toBe(true);
  });
  test("a non-paging log ping goes to each alert check every heartbeat period, and its delivery is kept", async () => {
    const r = rig({ opts: { hc_failed: [`${CAIN}=https://hc-ping.example/cain`, "https://hc-ping.example/rest"] } });
    await r.poll(2 * HC_HEARTBEAT_MS / POLL_MS);
    for (const u of ["https://hc-ping.example/cain/log", "https://hc-ping.example/rest/log"])
      expect([u, r.pings.filter((p) => p.url === u).length]).toEqual([u, 2]);
    expect(Object.values(r.k.st.logDelivered).length).toBe(2);
    expect(r.pings.some((p) => p.url.endsWith("/fail"))).toBe(false);
  });
});

describe("/armed is computed on every read, from its five conditions (0.1.2)", () => {
  test("not stored: the state has no armed record", async () => {
    const r = await armedRig();
    expect((r.saved as any).armed).toBeUndefined();
  });
  test("1. the Healthchecks URLs: an App with no alert check is not armed", async () => {
    const r = await armedRig({ watch: [CAIN] });
    r.k.opts = { ...r.k.opts, watch: [CAIN, "0fcc2575_harness"], hc_failed: { [CAIN]: "https://hc-ping.example/failed" } };
    expect(r.k.armedView(CAIN).why).toContain("not armable");
  });
  test("2. the drills under the current binding: a new probe hash drops them", async () => {
    const r = await armedRig(); r.register({ id: "a9", probe_hash: "ffffffffffffffff" }); await r.poll();
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.armedView(CAIN).why).toContain("no drills on record");
  });
  test("3. the heartbeat: an outage reads as not armed and recovers by itself, the drills kept", async () => {
    const r = await armedRig();
    r.f.pingFails = (u) => u === "https://hc-ping.example/done";
    await r.poll(DELIVERY_MS / POLL_MS + 2);
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.armedView(CAIN).why).toContain("no heartbeat ping was delivered");
    expect(Object.keys(r.k.st.drills[CAIN] ?? {}).length).toBe(2);
    r.f.pingFails = () => false; await r.poll(3);
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("4. each alert check's log ping: an outage of one reads as not armed and recovers", async () => {
    const r = await armedRig();
    r.f.pingFails = (u) => u.endsWith("/failed/log");
    await r.poll(DELIVERY_MS / POLL_MS + 2);
    expect(r.k.armedView(CAIN).why).toContain("log ping");
    r.f.pingFails = () => false; await r.poll(3);
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("5. a fail ping waiting undelivered for more than 2 minutes: not armed until it goes", async () => {
    const r = await armedRig();
    r.f.pingFails = (u) => u.endsWith("/fail");
    r.k.owner(CAIN, "x", "a line", true);
    await r.poll(2);
    expect(r.k.armedView(CAIN).armed).toBe(true);      // waiting, under 2 minutes
    await r.poll(4);
    expect(r.k.armedView(CAIN).why).toContain("waited undelivered");
    r.f.pingFails = () => false; r.advance(10 * 60_000); await r.poll(2);
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
  test("each read reflects the moment: a heartbeat older than 10 minutes reads as not armed with no poll between", async () => {
    const r = await armedRig();
    r.advance(DELIVERY_MS + 60_000);
    expect(r.k.armedView(CAIN).armed).toBe(false);
  });
});

describe("the health address names its path", () => {
  test("host:port/path asks that path; no path is /health; anything else isn't asked; liveness is the host's /health", () => {
    expect(healthUrl("0fcc2575-cain:8098/ready")).toBe("http://0fcc2575-cain:8098/ready");
    expect(healthUrl("0fcc2575-cain:8098")).toBe("http://0fcc2575-cain:8098/health");
    expect(healthUrl("0fcc2575-cain:8098/ready?x=1")).toBeNull();
    expect(healthUrl("http://x:1/ready")).toBeNull();
    expect(liveUrl("0fcc2575-cain:8098/ready")).toBe("http://0fcc2575-cain:8098/health");
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toContain(`- "0fcc2575_cain=0fcc2575-cain:8098/ready"`);
    expect(parseOptions({ health: ["0fcc2575_cain=0fcc2575-cain:8098/ready"] }).health[CAIN]).toBe("0fcc2575-cain:8098/ready");
  });
  test("the options schema: authorization is no password field, hc_failed a list", () => {
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toMatch(/^    authorization: str\?$/m);
    expect(cfg).toMatch(/^  hc_failed:\n    - password$/m);
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
  test("the restore passes the background flag: its id comes back; an error answer is refused; no answer or a 2xx non-result is unknown", async () => {
    let f = fake({ "POST /backups/b1/restore/partial": { result: "ok", data: { job_id: "abc" } } });
    expect(await f.sup.restore("b1", CAIN)).toEqual({ kind: "started", job: "abc" });
    expect(f.calls[0].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true });
    f = fake({});
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("refused");
    f = fake({ "POST /backups/b1/restore/partial": new Error("timeout") });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
    f = fake({ "POST /backups/b1/restore/partial": { result: "weird" } });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
  });
  test("the job is read from /jobs/info by its id only: a restore job of the same backup is never taken for it", async () => {
    const jobs = [{ name: "backup_manager_partial_restore", reference: "b1", uuid: "u1", done: false, errors: [], created: "2026-11-21T15:00:10+00:00", child_jobs: [
      { name: "x", reference: null, uuid: "u2", done: true, errors: [{ message: "e" }], created: "2026-11-21T15:00:11+00:00", child_jobs: [] }] }];
    const f = fake({ "GET /jobs/info": { result: "ok", data: { jobs } } });
    expect(await f.sup.job("u2")).toEqual({ found: true, uuid: "u2", done: true, errors: 1 });
    expect(await f.sup.job("u-other")).toEqual({ found: false });
    expect(await f.sup.job("")).toEqual({ found: false });
    expect(await fake({}).sup.job("u1")).toBeNull();
  });
  test("its own options are only read", async () => {
    const options = { watch: [CAIN], attempt: { id: "a1" } };
    const f = fake({ "GET /addons/self/info": { result: "ok", data: { slug: "k", options } } });
    expect(await f.sup.selfOptions()).toEqual(options);
    expect((f.sup as any).clearAttempt).toBeUndefined();
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
  test("the backup info carries its protected flag", async () => {
    const f = fake({ "GET /backups/b1/info": { result: "ok", data: { homeassistant: null, addons: [], folders: [], protected: true } } });
    expect((await f.sup.backupInfo("b1"))?.protected).toBe(true);
  });
});
