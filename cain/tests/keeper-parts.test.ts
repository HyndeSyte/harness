// Cain 0.18.0: Cain's parts for the keeper App (keeper/): /health tied to the link's Discord gateway, the
// link's armed read from the keeper failing closed on each bad case, and the probe's verdict and the
// keeper's last line said once.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACK_WITHIN_MS, gatewayHealthy, writeGatewayMark } from "../rootfs/opt/cain/link/health-gate.ts";
import { armedFor, keeperArmed, keeperArmedText, type KeeperReply } from "../rootfs/opt/cain/link/cap.ts";
import { CAIN_SLUG, lastRepeat, probeHash, verdictRun, type Reply } from "../rootfs/opt/cain/probe/keeper.ts";

const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const NOW = Date.parse("2026-11-21T15:00:00Z");

describe("/ready tied to the gateway (0.18.1: /health is liveness only)", () => {
  test("healthy only while connected and acknowledged within 5 minutes", () => {
    expect(gatewayHealthy(true, NOW - 1000, NOW)).toBe(true);
    expect(gatewayHealthy(true, NOW - ACK_WITHIN_MS - 1, NOW)).toBe(false);
    expect(gatewayHealthy(false, NOW - 1000, NOW)).toBe(false);
    expect(gatewayHealthy(true, 0, NOW)).toBe(false);
  });
  test("the mark is written while healthy and removed otherwise; nginx answers 503 without it", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hg-")), "health-gateway");
    writeGatewayMark(true, f, () => {}); expect(existsSync(f)).toBe(true);
    writeGatewayMark(false, f, () => {}); expect(existsSync(f)).toBe(false);
    const nginx = src("rootfs/etc/nginx/nginx.conf");
    const ready = nginx.split("location = /ready {")[1].split("}\n    location")[0];
    expect(ready).toContain('if (!-f /run/cain-web/www/health-gateway) { return 503');
    expect(ready.indexOf("if ($cain_health_from != 1) { return 404; }")).toBeGreaterThan(-1);
    expect(ready.indexOf("$cain_health_from")).toBeLessThan(ready.indexOf("health-gateway"));
    const health = nginx.split("location = /health {")[1].split("location = /ready {")[0];
    expect(health).not.toContain("health-gateway");
    expect(health).toContain("access_log /run/cain-web/health-ok.log cain_health_ok if=$cain_health_ok;");
    expect(health).toContain("access_log /run/cain-web/health-miss.log cain_health_miss if=$cain_health_miss;");
    expect(src("config.yaml")).toMatch(/^watchdog: http:\/\/\[HOST\]:\[PORT:8098\]\/health$/m);
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain("GATEWAY_MARK=/run/cain-web/www/health-gateway");
    expect(run).toMatch(/gateway_stale\(\) \{ \[ -z "\$\(find "\$GATEWAY_MARK" -mmin \+2/);
    const link = src("rootfs/opt/cain/link/main.ts");
    expect(link).toContain("writeGatewayMark(gatewayHealthy(connected, proto.lastAck, Date.now()));");
  });
});

describe("the link's armed read from the keeper fails closed", () => {
  const PH = probeHash()!;
  const good = (over: any = {}, binding: any = {}) => ({ status: 200, body: JSON.stringify({ app: CAIN_SLUG, armed: true, armed_at: "2026-11-20T10:00:00Z",
    binding: { protocol: 1, probe_hash: PH, keeper_version: "0.1.0", options_hash: "0123456789abcdef", backup_scope: "app-only", ...binding },
    keeper_version: "0.1.0", at: new Date(NOW - 30_000).toISOString(), ...over }) }) as KeeperReply;
  test("a good, fresh, bound reply is armed", () => {
    expect(keeperArmed("cain", good(), NOW, PH)).toMatchObject({ armed: true, at: "2026-11-20T10:00:00Z" });
  });
  const bad: [string, KeeperReply | undefined, string][] = [
    ["not asked yet", undefined, "hasn't been asked"],
    ["an error", { error: "connect refused" }, "didn't answer"],
    ["a bad token", { status: 401, body: "{}" }, "refused Cain's token"],
    ["another status", { status: 500, body: "{}" }, "answered 500"],
    ["not JSON", { status: 200, body: "<html>" }, "isn't JSON"],
    ["another App", good({ app: "0fcc2575_harness" }), "another App"],
    ["a stale timestamp", good({ at: new Date(NOW - 121_000).toISOString() }), "stale"],
    ["no timestamp", good({ at: undefined }), "stale"],
    ["another protocol", good({}, { protocol: 2 }), "binding"],
    ["another backup scope", good({}, { backup_scope: "full" }), "binding"],
    ["a version mismatch", good({ keeper_version: "0.2.0" }), "binding"],
    ["another probe", good({}, { probe_hash: "ffffffffffffffff" }), "another verdict probe"],
    ["not armed", good({ armed: false, why: "no drills on record" }), "isn't armed (no drills"],
  ];
  for (const [name, reply, why] of bad) test(`not armed on ${name}`, () => {
    const a = keeperArmed("cain", reply, NOW, PH);
    expect(a.armed).toBe(false);
    expect(a.why).toContain(why);
  });
  test("the text armedFor reads: armed only for the Apps armed now, with the keeper's reason", () => {
    const t = keeperArmedText({ cain: good() }, NOW, PH);
    expect(armedFor(["cain"], t).armed).toBe(true);
    const h = armedFor(["cain", "harness"], t);
    expect(h.armed).toBe(false);
    expect(h.why).toContain("isn't armed for Harness (the keeper hasn't been asked yet)");
    expect(armedFor(["cain"], keeperArmedText({ cain: good() }, NOW + 200_000, PH)).armed).toBe(false);
  });
  test("the file is gone: nothing reads /data/probe/rollback-armed.json any more", () => {
    for (const f of ["rootfs/opt/cain/capfiles.ts", "rootfs/opt/cain/link/cap.ts", "rootfs/opt/cain/link/main.ts"]) expect(src(f)).not.toContain("rollback-armed.json");
  });
});

describe("the verdict probe", () => {
  const rig = (attempt: any, answered: boolean) => {
    const posts: any[] = [];
    const logs: string[] = [];
    let asked = 0;
    return { posts, logs, get asked() { return asked; }, deps: {
      get: async (p: string): Promise<Reply> => (p === "/attempt" ? { status: 200, body: attempt } : null),
      post: async (_p: string, b: unknown): Promise<Reply> => { posts.push(b); return { status: 200, body: { status: "accepted" } }; },
      ask: async () => { asked++; return answered; }, version: "0.17.0", log: (m: string) => logs.push(m) } };
  };
  test("an open attempt: the liveness line asked once, PASS posted bound to it", async () => {
    const r = rig({ app: CAIN_SLUG, attempt: "a1", to_version: "0.17.0" }, true);
    expect(await verdictRun(r.deps)).toBe("PASS");
    expect(r.asked).toBe(1);
    expect(r.posts).toEqual([{ app: CAIN_SLUG, version: "0.17.0", attempt: "a1", result: "PASS", reason: "" }]);
  });
  test("no answer: FAIL with the reason", async () => {
    const r = rig({ app: CAIN_SLUG, attempt: "a1", to_version: "0.17.0" }, false);
    expect(await verdictRun(r.deps)).toBe("FAIL");
    expect(r.posts[0]).toMatchObject({ result: "FAIL", attempt: "a1" });
    expect(r.posts[0].reason).toContain("didn't answer the liveness line");
  });
  test("no attempt, or one for another version: nothing asked, nothing posted", async () => {
    for (const a of [{ app: CAIN_SLUG, attempt: null }, { app: CAIN_SLUG, attempt: "a1", to_version: "0.18.0" }]) {
      const r = rig(a, true);
      await verdictRun(r.deps);
      expect(r.asked).toBe(0);
      expect(r.posts).toEqual([]);
    }
  });
  test("the keeper's last rollback or give-up line is said once; other kinds never", async () => {
    let said: string | null = null;
    const sent: string[] = [];
    let body: any = { app: CAIN_SLUG, id: "c-3", kind: "rolled back", line: "Keeper rolled back Cain from 0.17.0 to 0.16.0: its probe said FAIL." };
    const d = { get: async () => ({ status: 200, body }), said: () => said, markSaid: (id: string) => { said = id; },
      say: (l: string) => { sent.push(l); return 0; }, log: () => {} };
    expect(await lastRepeat(d)).toBe("said");
    expect(await lastRepeat(d)).toBe("said already");
    expect(sent.length).toBe(1);
    body = { app: CAIN_SLUG, id: "c-4", kind: "passed", line: "Cain 0.17.0 passed." };
    expect(await lastRepeat(d)).toBe("nothing to say");
    body = { app: CAIN_SLUG, id: "c-5", kind: "gave up", line: "Keeper gave up on Cain 0.18.0." };
    expect(await lastRepeat({ ...d, say: () => 1 })).toBe("not said");
    expect(said).toBe("c-3");
    expect(await lastRepeat(d)).toBe("said");
    expect(sent.length).toBe(2);
  });
  test("the run script starts it after each session start, with the token in its own environment only", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain('timeout -k 5 900 bun "$OPT/probe/keeper.ts" start "${version:-unknown}"');
    expect(run).toMatch(/bashio::log.info "Cain is running"\n  verdict_probe\n\}/);
    const n = src("rootfs/opt/cain/notice.sh");
    expect(n).toContain("  say) l=");
  });
});
