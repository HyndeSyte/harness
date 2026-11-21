// Keeper 0.1.0: the attempt life cycle with a fake Supervisor and a fake clock, verdict binding and
// token refusal, /armed freshness and bindings, the Healthchecks queue, the rewind drop, and the
// options re-read without a restart. 0.1.1 (the first review's fixes): the restore reconciled from its
// job, the registration that changes the keeper's settings, the spent-id replay, the protected backup,
// every rollback paged, the heartbeat-delivery gate on /armed, and the restart-loop rule.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIRM_MS, DELIVERY_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, RESTORE_LIMIT_MS, REWIND_MS, WATCH_MS, optionsHash, parseOptions, parseAuthorization, type AppInfo, type BackupInfo, type JobState, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
import { healthUrl } from "../rootfs/opt/keeper/main.ts";
import { supervisor } from "../rootfs/opt/keeper/supervisor.ts";
import { handle, internal } from "../rootfs/opt/keeper/server.ts";

const CAIN = "0fcc2575_cain";
const TOKEN = "cain-token-0123456789abcdef";
const T0 = Date.parse("2026-11-21T15:00:00Z");
const EMPTY = { id: "", app: "", from_version: "", to_version: "", backup_slug: "", install_deadline: "", authorization: "", probe_hash: "" };
const HASH = "abcdef0123456789";
// Polls from a fail to the end of the confirm window (the restore, then 5 minutes started and healthy).
const ROLL = CONFIRM_MS / POLL_MS + 3;

function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string }[] = [];
  const clears: string[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    app, healthy: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
    // the Supervisor's jobs list: what job() answers (null: unreadable); clearOk: the own-options write
    jobs: { found: false } as JobState | null, clearOk: true,
    backup: o.backup === null ? null : { homeassistant: null, addons: [{ slug: CAIN, version: "0.16.0" }], folders: [], ...(o.backup ?? {}) } as BackupInfo | null,
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
      const r = f.restoreQueue.shift() ?? { kind: "started", job: null };
      if (r.kind === "started" && !r.job) f.onRestore();
      return r;
    },
    job: async () => f.jobs,
    clearAttempt: async (id) => { clears.push(id); if (f.clearOk && f.options.attempt?.id === id) f.options.attempt = { ...f.options.attempt, ...EMPTY }; return f.clearOk ? { ok: true, why: "" } : { ok: false, why: "403 refused" }; },
    health: async () => f.healthy,
    ping: async (url, body) => { pings.push({ url, body }); return f.pingOk; },
    options: () => JSON.parse(JSON.stringify(f.options)),
    save: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.opts = parseOptions(f.options);
  k.start();
  const r = {
    k, f, logs, pings, restores, clears, get saved() { return saved; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    register(over: any = {}) {
      f.options.attempt = { id: "a1", app: CAIN, from_version: "0.16.0", to_version: "0.17.0", backup_slug: "b1234567",
        install_deadline: new Date(now + 30 * 60_000).toISOString(), authorization: "ship", probe_hash: HASH, ...over };
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
  test("authorization: ship, ship with a token, drill with a token (kept only as a hash)", () => {
    expect(parseAuthorization("ship")?.kind).toBe("ship");
    expect(parseAuthorization("drill tok-12345678")?.tokenHash).toMatch(/^[0-9a-f]{16}$/);
    expect(parseAuthorization("drill")).toBeNull();
    expect(parseAuthorization("merge")).toBeNull();
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
    const r = rig({ opts: { health_grace_s: 180 } }); r.register(); await r.poll(); r.f.healthy = false; r.install(); await r.poll(5);
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
  test("a restart while restoring: the restore isn't started twice, only reconciled and confirmed", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL");
    const st = JSON.parse(JSON.stringify(r.k.st)); st.attempts.a1.restore.inflight = true;
    const r2 = rig({ saved: st }); r2.f.app.version = "0.16.0";
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
    const last = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/failed")).at(-1)!;
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
    const lines = r.pings.filter((p) => p.url.startsWith("https://hc-ping.example/failed")).map((p) => p.url.endsWith("/fail") ? "fail" : "ok");
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
    r.register({ id, authorization: "drill tap-token-123456" }); await r.poll();
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
    r = await armed(); r.f.options.hc_done = ""; await r.poll(); expect(r.k.armedView(CAIN).armed).toBe(false);
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

// -- 0.1.1: the first review's fixes ---------------------------------------------------------------
async function failed(r: ReturnType<typeof rig>) { r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL"); }
async function drillOf(r: ReturnType<typeof rig>, id: string, how: "verdict" | "exit") {
  r.f.app.version = "0.16.0"; r.f.app.state = "started";
  r.register({ id, authorization: "drill tap-token-123456" }); await r.poll();
  r.install(how === "exit" ? "error" : "started"); await r.poll();
  if (how === "verdict") r.k.verdict(CAIN, { app: CAIN, version: "0.17.0", attempt: id, result: "FAIL", reason: "drill" });
  await r.poll(ROLL);
  expect(r.a(id).status).toBe("rolled back");
}
async function armedRig() { const r = rig(); await drillOf(r, "d1", "verdict"); await drillOf(r, "d2", "exit"); expect(r.k.armedView(CAIN).armed).toBe(true); return r; }

describe("one restore job per attempt: the reconcile", () => {
  test("the job id in the answer is saved before anything else", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "started", job: "job-1" }); r.f.jobs = { found: true, uuid: "job-1", done: false, errors: 0 };
    await failed(r); await r.poll();
    expect(r.saved!.attempts.a1.restore!.job).toBe("job-1");
    expect(r.logs.some((l) => l.includes("running as job job-1"))).toBe(true);
  });
  test("a timeout, then the job seen running, then done: never sent twice, and confirmed", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" }); r.f.jobs = { found: false };
    await failed(r); await r.poll();
    expect(r.restores.length).toBe(1);
    expect(r.logs.some((l) => l.includes("got no answer (TimeoutError); reconciling"))).toBe(true);
    r.f.jobs = { found: true, uuid: "job-7", done: false, errors: 0 }; await r.poll(4);
    expect(r.a().status).toBe("restoring");
    expect(r.a().restore!.job).toBe("job-7");
    r.f.jobs = { found: true, uuid: "job-7", done: true, errors: 0 }; r.f.app.version = "0.16.0"; r.f.app.state = "started";
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
    expect(r.restores.length).toBe(1);
  });
  test("a job seen ended with errors and the App not back: the restore is sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll();
    r.f.jobs = { found: true, uuid: "job-2", done: true, errors: 1 }; await r.poll();
    expect(r.logs.some((l) => l.includes("ended without restoring (1 error)"))).toBe(true);
    await r.poll(3 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
  });
  test("a job ended with errors but the App back at from_version counts as landed, not sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TypeError" });
    await failed(r); await r.poll();
    r.f.jobs = { found: true, uuid: "job-3", done: true, errors: 2 }; r.f.app.version = "0.16.0"; r.f.app.state = "started";
    await r.poll(ROLL);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("rolled back");
  });
  test("the job unknown and the App not back: nothing sent again, unresolved at the limit, the owner paged", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" }); r.f.jobs = { found: false };
    await failed(r);
    r.f.jobs = null;                                 // the jobs list can't be read either, for a while
    await r.poll(6);
    r.f.jobs = { found: false };
    await r.poll(RESTORE_LIMIT_MS / POLL_MS);
    expect(r.restores.length).toBe(1);
    expect(r.a().status).toBe("unresolved");
    expect(r.logs.some((l) => l.startsWith("a1: unresolved ("))).toBe(true);
    expect(r.pings.some((p) => p.url.endsWith("/failed/fail") && p.body.includes("can't tell whether its rollback"))).toBe(true);
    // the next start reconciles again: the job is found done, so it goes on to the confirm window
    const st = JSON.parse(JSON.stringify(r.k.st));
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0";
    expect(r2.logs.some((l) => l.startsWith("reconciling a1"))).toBe(true);
    r2.f.jobs = { found: true, uuid: "job-9", done: true, errors: 0 }; r2.f.onRestore();
    await r2.poll(ROLL);
    expect(r2.a().status).toBe("rolled back");
    expect(r2.restores).toEqual([]);
  });
  test("still unknown at the next start: it stays unresolved, nothing is sent", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "unknown", why: "TimeoutError" });
    await failed(r); await r.poll(RESTORE_LIMIT_MS / POLL_MS + 2);
    expect(r.a().status).toBe("unresolved");
    const r2 = rig({ saved: JSON.parse(JSON.stringify(r.k.st)) }); r2.f.app.version = "0.17.0"; r2.f.app.state = "error";
    await r2.poll(3);
    expect(r2.a().status).toBe("unresolved");
    expect(r2.restores).toEqual([]);
    expect(r2.logs.some((l) => l.includes("still unresolved at this start"))).toBe(true);
  });
  test("a restart in the middle of the call: reconciled from the job, never sent again", async () => {
    const r = rig(); await failed(r);
    const st = JSON.parse(JSON.stringify(r.k.st)); Object.assign(st.attempts.a1.restore, { inflight: true, tries: 1, sentAt: r.now });
    const r2 = rig({ saved: st }); r2.f.app.version = "0.17.0"; r2.f.app.state = "stopped";
    r2.f.jobs = { found: true, uuid: "job-4", done: false, errors: 0 }; await r2.poll(3);
    expect(r2.restores).toEqual([]);
    expect(r2.a().restore!.job).toBe("job-4");
    r2.f.jobs = { found: true, uuid: "job-4", done: true, errors: 0 }; r2.f.onRestore();
    await r2.poll(ROLL);
    expect(r2.a().status).toBe("rolled back");
    expect(r2.restores).toEqual([]);
  });
  test("a refusal the Supervisor answered ended the request: it may be sent again", async () => {
    const r = rig(); r.f.restoreQueue.push({ kind: "refused", retry: true, why: "500 boom" });
    await failed(r); await r.poll(3 + ROLL);
    expect(r.restores.length).toBe(2);
    expect(r.a().status).toBe("rolled back");
  });
});

describe("the restart-loop rule after a restore", () => {
  test("started, then stopped or error, more than twice in the confirm window: gave up", async () => {
    const r = rig(); await failed(r); await r.poll();
    expect(r.a().restore!.called).toBe(true);
    for (const st of ["started", "stopped", "started", "error", "started", "stopped"]) { r.f.app.state = st; await r.poll(); }
    expect(r.a().status).toBe("gave up");
    expect(r.a().why).toContain("keeps restarting");
    expect(r.pings.some((p) => p.url.endsWith("/fail") && p.body.includes("keeps restarting"))).toBe(true);
  });
  test("one or two stops that settle still roll back", async () => {
    const r = rig(); await failed(r); await r.poll();
    for (const st of ["started", "stopped", "started", "error", "started"]) { r.f.app.state = st; await r.poll(); }
    await r.poll(ROLL);
    expect(r.a().status).toBe("rolled back");
  });
});

describe("a registration can't change the keeper's settings, and is spent once", () => {
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
      expect(r.k.opts.hc_failed).toBe("https://hc-ping.example/failed");
      expect(r.pings.some((p) => p.url === "https://hc-ping.example/failed/fail" && p.body.includes("changed the keeper's own settings"))).toBe(true);
      await r.poll(3);
      expect(r.k.appOfToken(TOKEN)).toBe(CAIN);           // still, while that registration stands in the options
      expect(r.clears).toEqual([]);
    });
  }
  test("the same settings with a new registration are accepted; a settings change with no registration is the owner's and taken", async () => {
    const r = rig(); await r.poll(); r.register(); await r.poll();
    expect(r.a().status).toBe("accepted");
    r.f.options.tokens = [`${CAIN}=a-new-token-0123456789`]; await r.poll();
    expect(r.k.appOfToken("a-new-token-0123456789")).toBe(CAIN);
  });
  test("accepted: the authorization is spent and cleared from the keeper's options", async () => {
    const r = rig(); r.register({ authorization: "ship tap-token-abcdefgh" }); await r.poll();
    expect(r.clears).toEqual(["a1"]);
    expect(r.f.options.attempt.authorization).toBe("");
    expect(r.k.st.spent.find((x) => x.id === "a1")?.cleared).toBe(true);
    expect(JSON.stringify(r.saved)).not.toContain("tap-token-abcdefgh");
  });
  test("a spent registration written again is refused as a replay, once", async () => {
    const r = rig(); r.register(); const first = { ...r.f.options.attempt }; await r.poll();
    r.f.options.attempt = first; await r.poll(3);
    expect(r.logs.filter((l) => l === "refusing a1: a replay: that registration was spent and cleared").length).toBe(1);
    expect(r.logs.filter((l) => l.startsWith("accepting")).length).toBe(1);
    r.f.options.attempt = { ...first, to_version: "0.18.0" }; await r.poll();
    expect(r.logs).toContain("refusing a1: a replay: that id was spent with other fields");
    expect(r.pings.filter((p) => p.body.includes("a replay")).length).toBe(2);
    expect(r.a().status).toBe("accepted");                 // the attempt it was spent for is untouched
  });
  test("when the Supervisor refuses the clear, the spent registration left in the options isn't a replay", async () => {
    const r = rig(); r.f.clearOk = false; r.register(); await r.poll(3);
    expect(r.logs.some((l) => l.startsWith("couldn't clear a1 from the keeper's options (403 refused)"))).toBe(true);
    expect(r.logs.some((l) => l.includes("replay"))).toBe(false);
    r.f.options.attempt = { ...r.f.options.attempt, backup_slug: "b7654321" }; await r.poll();
    expect(r.logs).toContain("refusing a1: a replay: that id was spent with other fields");
  });
  test("a registration never drops the armed record (the options hash is over the static options only)", async () => {
    const r = await armedRig();
    const before = r.k.armedView(CAIN).binding;
    r.register({ id: "a7" }); await r.poll();
    expect(r.a("a7").status).toBe("accepted");
    expect(r.k.armedView(CAIN).armed).toBe(true);
    expect(r.k.armedView(CAIN).binding).toEqual(before);
    r.register({ id: "a8", tokens: undefined }); r.f.options.tokens = []; await r.poll();   // a clobbering one: refused, still armed
    expect(r.a("a8").status).toBe("unprotected");
    expect(r.k.armedView(CAIN).armed).toBe(true);
  });
});

describe("a protected backup is refused", () => {
  test("protected true: unprotected before any accepting line, with its why", async () => {
    const r = rig({ backup: { protected: true } }); r.register(); await r.poll();
    expect(r.a().status).toBe("unprotected");
    expect(r.logs.some((l) => l.startsWith("accepting"))).toBe(false);
    expect(r.logs.some((l) => l.startsWith("refusing a1: its backup is password-protected"))).toBe(true);
  });
  test("protected false is accepted", async () => {
    const r = rig({ backup: { protected: false } }); r.register(); await r.poll();
    expect(r.a().status).toBe("accepted");
  });
});

describe("arming needs a live alert path", () => {
  test("/armed is armed only while a heartbeat was delivered in the last 10 minutes; a stale one drops the record", async () => {
    const r = await armedRig();
    const last = r.k.st.hcDelivered;
    r.f.pingOk = false;
    for (let i = 0; i < 2 * DELIVERY_MS / POLL_MS; i++) {
      await r.k.poll();
      expect([i, r.k.armedView(CAIN).armed]).toEqual([i, r.now - last <= DELIVERY_MS]);
      r.advance(POLL_MS);
    }
    expect(r.k.armedView(CAIN).armed).toBe(false);
    expect(r.k.armedView(CAIN).why).toContain("no heartbeat ping was delivered");
    expect(r.k.st.armed[CAIN]).toBeUndefined();
    expect(r.logs.some((l) => l.startsWith("disarmed for 0fcc2575_cain: no heartbeat ping was delivered"))).toBe(true);
  });
  test("a heartbeat ping that wasn't delivered is tried again a minute later", async () => {
    const r = rig(); r.f.pingOk = false; await r.poll(); r.f.pingOk = true; await r.poll(2);
    expect(r.pings.filter((p) => p.body === "keeper heartbeat").length).toBe(2);
    expect(r.k.delivered()).toBe(true);
  });
});

describe("the health address names its path", () => {
  test("host:port/path asks that path; no path is /health; anything else isn't asked", () => {
    expect(healthUrl("0fcc2575-cain:8098/ready")).toBe("http://0fcc2575-cain:8098/ready");
    expect(healthUrl("0fcc2575-cain:8098")).toBe("http://0fcc2575-cain:8098/health");
    expect(healthUrl("0fcc2575-cain:8098/ready?x=1")).toBeNull();
    expect(healthUrl("http://x:1/ready")).toBeNull();
    const cfg = readFileSync(join(import.meta.dir, "..", "config.yaml"), "utf8");
    expect(cfg).toContain(`- "0fcc2575_cain=0fcc2575-cain:8098/ready"`);
    expect(parseOptions({ health: ["0fcc2575_cain=0fcc2575-cain:8098/ready"] }).health[CAIN]).toBe("0fcc2575-cain:8098/ready");
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
  test("the restore is a background job: its id comes back; an error answer is refused; no answer is unknown", async () => {
    let f = fake({ "POST /backups/b1/restore/partial": { result: "ok", data: { job_id: "abc" } } });
    expect(await f.sup.restore("b1", CAIN)).toEqual({ kind: "started", job: "abc" });
    expect(f.calls[0].body).toEqual({ homeassistant: false, addons: [CAIN], folders: [], background: true });
    f = fake({});
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("refused");
    f = fake({ "POST /backups/b1/restore/partial": new Error("timeout") });
    expect((await f.sup.restore("b1", CAIN)).kind).toBe("unknown");
  });
  test("the job is read from /jobs/info, by id or as the newest partial restore of that backup since the call", async () => {
    const jobs = [{ name: "backup_manager_partial_restore", reference: "b1", uuid: "u1", done: false, errors: [], created: "2026-11-21T15:00:10+00:00", child_jobs: [
      { name: "x", reference: null, uuid: "u2", done: true, errors: [{ message: "e" }], created: "2026-11-21T15:00:11+00:00", child_jobs: [] }] }];
    const f = fake({ "GET /jobs/info": { result: "ok", data: { jobs } } });
    expect(await f.sup.job("u2", "b1", 0)).toEqual({ found: true, uuid: "u2", done: true, errors: 1 });
    expect(await f.sup.job(null, "b1", T0)).toEqual({ found: true, uuid: "u1", done: false, errors: 0 });
    expect(await f.sup.job(null, "b1", T0 + 3_600_000)).toEqual({ found: false });
    expect(await fake({}).sup.job("u1", "b1", 0)).toBeNull();
  });
  test("the clear writes the keeper's own options back whole with the attempt emptied, only while it is that registration", async () => {
    const options = { watch: [CAIN], tokens: ["x=y"], hc_done: "h", attempt: { id: "a1", authorization: "ship tok-12345678" } };
    const f = fake({ "GET /addons/self/info": { result: "ok", data: { slug: "k", options } }, "POST /addons/self/options": { result: "ok" } });
    expect(await f.sup.clearAttempt("a1")).toEqual({ ok: true, why: "" });
    const w = f.calls.find((c) => c.method === "POST")!;
    expect(w.path).toBe("/addons/self/options");
    expect(w.body.options).toEqual({ ...options, attempt: EMPTY });
    expect((await f.sup.clearAttempt("a2")).ok).toBe(false);
    expect(await f.sup.selfOptions()).toEqual(options);
  });
  test("the backup info carries its protected flag", async () => {
    const f = fake({ "GET /backups/b1/info": { result: "ok", data: { homeassistant: null, addons: [], folders: [], protected: true } } });
    expect((await f.sup.backupInfo("b1"))?.protected).toBe(true);
  });
});
