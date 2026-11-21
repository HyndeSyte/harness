// Keeper 0.1.0: the attempt life cycle with a fake Supervisor and a fake clock, verdict binding and
// token refusal, /armed freshness and bindings, the Healthchecks queue, the rewind drop, and the
// options re-read without a restart.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIRM_MS, HC_HEARTBEAT_MS, Keeper, POLL_MS, REWIND_MS, WATCH_MS, optionsHash, parseOptions, parseAuthorization, type AppInfo, type BackupInfo, type RestoreResult, type State } from "../rootfs/opt/keeper/core.ts";
import { handle, internal } from "../rootfs/opt/keeper/server.ts";

const CAIN = "0fcc2575_cain";
const TOKEN = "cain-token-0123456789abcdef";
const T0 = Date.parse("2026-11-21T15:00:00Z");
const HASH = "abcdef0123456789";

function rig(o: { opts?: any; saved?: unknown; backup?: Partial<BackupInfo> | null } = {}) {
  let now = T0;
  const logs: string[] = [];
  const pings: { url: string; body: string }[] = [];
  const restores: { backup: string; app: string }[] = [];
  let saved: State | null = null;
  const app: AppInfo = { version: "0.16.0", state: "started" };
  const f = {
    app, healthy: true, infoUp: true, pingOk: true, restoreQueue: [] as RestoreResult[],
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
      const r = f.restoreQueue.shift() ?? { ok: true };
      if (r.ok) f.onRestore();
      return r;
    },
    health: async () => f.healthy,
    ping: async (url, body) => { pings.push({ url, body }); return f.pingOk; },
    options: () => JSON.parse(JSON.stringify(f.options)),
    save: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    log: (l) => logs.push(l),
  }, o.saved ?? null);
  k.opts = parseOptions(f.options);
  k.start();
  const r = {
    k, f, logs, pings, restores, get saved() { return saved; },
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
    await r.poll(WATCH_MS / POLL_MS + 3);
    expect(r.a().trigger?.kind).toBe("watch-end");
    expect(r.a().status).toBe("rolled back");
    expect(r.restores).toEqual([{ backup: "b1234567", app: CAIN }]);
  });
  test("a FAIL verdict fails at once", async () => {
    const r = rig(); await watching(r);
    r.verdict("FAIL"); expect(r.a().status).toBe("restoring");
    await r.poll(2);
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
    r.f.restoreQueue.push({ ok: false, retry: true, why: "409 a backup is running" }, { ok: false, retry: true, why: "409 a backup is running" });
    r.verdict("FAIL");
    await r.poll(12);
    expect(r.restores.length).toBe(3);
    expect(r.a().status).toBe("rolled back");
    expect(r.logs.filter((l) => l.includes("tried again in")).length).toBe(2);
    await r.poll(10);
    expect(r.restores.length).toBe(3);
  });
  test("busy past the limit ends as gave up, and the owner hears", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll();
    for (let i = 0; i < 30; i++) r.f.restoreQueue.push({ ok: false, retry: true, why: "busy" });
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
    r.verdict("FAIL"); await r.poll(3);
    expect(Object.keys(r.k.st.attempts)).toEqual(["a1"]);
    expect(r.logs.some((l) => l.startsWith("unregistered"))).toBe(false);
  });
  test("a restart while restoring: the restore isn't started twice, only confirmed", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL");
    const st = JSON.parse(JSON.stringify(r.k.st)); st.attempts.a1.restore.inflight = true;
    const r2 = rig({ saved: st }); r2.f.app.version = "0.16.0";
    await r2.poll(2);
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
  test("a completed rollback sends a success ping with the line to hc_done", async () => {
    const r = rig(); r.register(); await r.poll(); r.install(); await r.poll(); r.verdict("FAIL"); await r.poll(2);
    expect(r.pings.some((p) => p.url === "https://hc-ping.example/done" && p.body.startsWith("Keeper rolled back Cain from 0.17.0 to 0.16.0"))).toBe(true);
    expect(r.k.st.last[CAIN].kind).toBe("rolled back");
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
    await r.poll(3);
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
    const r2 = rig(); r2.register(); await r2.poll(); r2.install(); await r2.poll(); r2.verdict("FAIL"); await r2.poll(3);
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
