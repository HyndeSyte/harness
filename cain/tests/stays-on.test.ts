// Cain 0.15.0, "Cain stays on Discord": the broker supervises the Discord plugin's server. On Nov 20
// the server exited under a live connection ("the plugin's server stopped (0)"), nothing started it
// again, and Cain was off Discord for 19 minutes. Here the real broker (discord/broker-main.ts) runs
// with a stand-in server that stops once: it is started again within seconds, the restart is logged
// with the exit code, the new server gets his session's handshake again (its answer goes nowhere),
// his connection stays, and the state file says "server-down" meanwhile, naming it apart from a
// session that exited.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { serverWait, SERVER_BACKOFF_S } from "../rootfs/opt/cain/discord/broker.ts";

const OPT = join(import.meta.dir, "..", "rootfs", "opt", "cain");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STUB = `
const fs = require("fs");
const log = process.argv[2];
const refuse = process.argv[3] === "refuse";                 // a restarted server refuses the handshake
const starts = (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter((l) => l === "start").length : 0) + 1;
fs.appendFileSync(log, "start\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(log, line + "\\n");
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === "initialize" && refuse && starts > 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "refused" } }) + "\\n");
    else if (m.id !== undefined && m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }) + "\\n");
    else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [], from: starts } }) + "\\n");
  }
});
// The first server stops on its own, with code 7, soon after its handshake.
if (starts === 1) setTimeout(() => process.exit(7), 400);
`;

describe("the plugin's server is supervised", () => {
  test("the waits are short and bounded: 1, 2, 4, 8, then 15 seconds at most", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(serverWait)).toEqual([1, 2, 4, 8, 15, 15, 15]);
    expect(Math.max(...SERVER_BACKOFF_S)).toBeLessThanOrEqual(15);
  });

  function launch(extra: string[] = [], scale = "1") {
    const d = mkdtempSync(join(tmpdir(), "cain-broker-"));
    dirs.push(d);
    for (const s of ["state", "plugin", "outbox", "probe"]) mkdirSync(join(d, s));
    writeFileSync(join(d, "stub.js"), STUB);
    writeFileSync(join(d, "pin.json"), JSON.stringify({ version: "0", files: {} }));
    writeFileSync(join(d, "token.env"), "DISCORD_BOT_TOKEN=not-a-real-token\n");
    const env = { ...process.env, ...brokerEnv(d, extra, scale) };
    const broker = Bun.spawn([process.execPath, join(OPT, "discord", "broker-main.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const o = { out: "" };
    void (async () => { const dec = new TextDecoder(); for await (const c of broker.stdout) o.out += dec.decode(c); })();
    return { d, broker, o };
  }
  function brokerEnv(d: string, extra: string[] = [], scale = "1"): Record<string, string> {
    const gid = String(process.getgid?.() ?? 0);
    return {
      CAIN_DISCORD_SOCK: join(d, "discord.sock"), CAIN_DISCORD_TOKEN_FILE: join(d, "token.env"),
      CAIN_DISCORD_STATE: join(d, "state"), CAIN_DISCORD_PLUGIN: join(d, "plugin"), CAIN_DISCORD_OUTBOX: join(d, "outbox"),
      CAIN_LINK_SOCK: join(d, "no-link.sock"), CAIN_CARDS: join(d, "cards.json"), CAIN_GATE_REPLIED: join(d, "replied.json"),
      CAIN_GATE_LOG: join(d, "gate.jsonl"), PROBE_RUN: join(d, "probe"), CAIN_DISCORD_STATE_FILE: join(d, "discord.state"),
      CAIN_SENT_SPOOL: join(d, "spool.jsonl"), CAIN_GID: gid, DISCORD_GID: gid, CAIN_DISCORD_PIN: join(d, "pin.json"),
      CAIN_DISCORD_SEED: "", CAIN_DISCORD_SERVER_CMD: JSON.stringify([process.execPath, join(d, "stub.js"), join(d, "server.log"), ...extra]),
      CAIN_SERVER_BACKOFF_SCALE: scale,
    };
  }
  const until = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await Bun.sleep(50); } return true; };

  test.skipIf(process.platform === "win32")("a server that stops is started again within seconds, logged with its exit code, under the same connection", async () => {
    const { d, broker, o } = launch();
    const out = () => o.out;
    try {
      // Bound either way: as root it hands the socket to cain; a runner that isn't root can't chown it
      // to root, says so, and the socket stays its own (this test connects as that same user).
      expect(await until(() => out().includes("listening on") || out().includes("couldn't open the socket to cain"), 10_000)).toBe(true);
      const sock = connect(join(d, "discord.sock"));
      let got = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => { got += c; });
      await new Promise((ok) => sock.on("connect", ok));
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } }) + "\n");
      expect(await until(() => got.includes('"id":1'), 5_000)).toBe(true);
      // The first server stops (code 7): the broker says so with the code, and the state names it.
      expect(await until(() => /the plugin's server stopped \(7\): starting it again in 1 s \(restart 1\)/.test(out()), 5_000)).toBe(true);
      const stoppedAt = Date.now();
      // A call made in the gap (the server down, the next one not started yet) is answered at once
      // with the restarting error: never dropped, never sent to a server that isn't initialized.
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }) + "\n");
      expect(await until(() => got.includes('"id":10'), 2_000)).toBe(true);
      expect(got.split("\n").find((l) => l.includes('"id":10'))).toContain("restarting its server");
      expect(readFileSync(join(d, "discord.state"), "utf8")).toMatch(/^server-down \d+\n$/);
      expect(await until(() => out().includes("the plugin's server started again (restart 1, it had stopped with 7)"), 5_000)).toBe(true);
      expect(Date.now() - stoppedAt).toBeLessThan(4_000);                       // within seconds
      // The new server got his session's own handshake, under the broker's id, and its answer went nowhere.
      expect(await until(() => readFileSync(join(d, "server.log"), "utf8").includes("notifications/initialized"), 5_000)).toBe(true);
      const log = readFileSync(join(d, "server.log"), "utf8").split("\n");
      const second = log.slice(log.lastIndexOf("start"));
      expect(second.some((l) => l.includes('"id":"cain-broker-reinit-1"') && l.includes('"clientInfo":{"name":"claude-code"'))).toBe(true);
      expect(got).not.toContain("cain-broker-reinit");
      // His connection stayed: a call now reaches the second server.
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      expect(await until(() => got.includes('"from":2'), 5_000)).toBe(true);
      expect(out()).not.toContain("a new connection replaced");
      sock.destroy();
      expect(await until(() => readFileSync(join(d, "discord.state"), "utf8").startsWith("down"), 5_000)).toBe(true);
    } finally {
      broker.kill();
      await broker.exited;
    }
    expect(existsSync(join(d, "server.log"))).toBe(true);
  }, 30_000);

  test.skipIf(process.platform === "win32")("a restarted server that refuses the handshake leaves the state server-down for the watchdog, never connected", async () => {
    // Waits scaled by 0.05: the restart after 50 ms, the minute up as 3 seconds.
    const { d, broker, o } = launch(["refuse"], "0.05");
    try {
      expect(await until(() => o.out.includes("listening on") || o.out.includes("couldn't open the socket to cain"), 10_000)).toBe(true);
      const sock = connect(join(d, "discord.sock"));
      let got = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => { got += c; });
      await new Promise((ok) => sock.on("connect", ok));
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } }) + "\n");
      expect(await until(() => got.includes('"id":1'), 5_000)).toBe(true);
      expect(await until(() => o.out.includes("the restarted server refused the handshake: the channel stays down for the watchdog"), 8_000)).toBe(true);
      const first = readFileSync(join(d, "discord.state"), "utf8");
      expect(first).toMatch(/^server-down \d+\n$/);
      await Bun.sleep(4_000);                                       // past the scaled minute up
      expect(readFileSync(join(d, "discord.state"), "utf8")).toBe(first);
      expect(o.out).not.toContain("the channel is up");
      // A call now is answered with the restarting error, not sent to the uninitialized server.
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      expect(await until(() => got.includes('"id":2'), 2_000)).toBe(true);
      expect(got).toContain("restarting its server");
      expect(readFileSync(join(d, "server.log"), "utf8").split("\n").some((l) => l.includes('"method":"tools/list"'))).toBe(false);
      sock.destroy();
    } finally {
      broker.kill();
      await broker.exited;
    }
  }, 30_000);

  test.skipIf(process.platform === "win32")("a broker that starts again writes the state down from now, whatever it said before", async () => {
    const { d, broker, o } = launch();
    try {
      // A stale server-down left by the broker before (its time an hour ago) is replaced at start.
      expect(await until(() => o.out.includes("listening on") || o.out.includes("couldn't open the socket to cain"), 10_000)).toBe(true);
    } finally { broker.kill(); await broker.exited; }
    const old = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(join(d, "discord.state"), `server-down ${old}\n`);
    const again = Bun.spawn([process.execPath, join(OPT, "discord", "broker-main.ts")], { env: { ...process.env, ...brokerEnv(d) }, stdout: "pipe", stderr: "pipe" });
    try {
      expect(await until(() => { const t = readFileSync(join(d, "discord.state"), "utf8"); return t.startsWith("down ") && Number(t.split(" ")[1]) > old + 3000; }, 10_000)).toBe(true);
    } finally { again.kill(); await again.exited; }
  }, 30_000);
});

// -- G: the update line -------------------------------------------------------------------------------
import { selfDecide, selfReport, SELF_INCIDENT_S, parseSelfRows, type SelfRow } from "../rootfs/opt/cain/probe/core.ts";
import { checkBoots, paths, recordBoot, recordInstall, selfRestart, sessionStart, markGone } from "../rootfs/opt/cain/probe/main.ts";

const T = 1_795_000_000;
function world(run = "run") {
  const dir = mkdtempSync(join(tmpdir(), "stays-on-"));
  dirs.push(dir);
  const notices: string[][] = [];
  const n = (...a: string[]) => { notices.push(a); return 0; };
  const at = (r = run) => paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, r) });
  return { dir, notices, n, p: at(), at };
}
const tells = (notices: string[][]) => notices.filter((x) => x[0] === "tell").map((x) => x[1]);

describe("the update line (G)", () => {
  test("Nov 20's replay drill: the first version on record, installed that morning, names the update when a loop is seen", () => {
    const { p, notices, n } = world();
    // No version marker before (0.13.x kept none): 0.14.0 is installed at 7:00 and its start keeps one.
    expect(existsSync(p.install)).toBe(false);
    recordInstall(p, "0.14.0", T);
    expect(JSON.parse(readFileSync(p.install, "utf8"))).toMatchObject({ version: "0.14.0", at: T });
    // The replay, hours later: his session killed within a minute of each start, 5 times.
    let id = sessionStart(p, T + 5 * 3600, null, n, "").id;
    for (let i = 1; i <= 5; i++) {
      const t = T + 5 * 3600 + i * 60;
      markGone(p, t - 20, id);
      id = sessionStart(p, t, 137, n, id).id;
    }
    expect(tells(notices)).toEqual(["restarts", "update-exits"]);
    expect(notices.find((x) => x[1] === "update-exits")![2]).toMatch(/^Cain 0\.14\.0, installed (5 hours|30\d minutes) ago$/);
  });
  test("a day after that install, the same loop doesn't name it", () => {
    const { p, notices, n } = world();
    recordInstall(p, "0.14.0", T);
    let id = sessionStart(p, T + 86400, null, n, "").id;
    for (let i = 1; i <= 5; i++) { const t = T + 86400 + i * 60; markGone(p, t - 20, id); id = sessionStart(p, t, 137, n, id).id; }
    expect(tells(notices)).toEqual(["restarts"]);
  });
});

// -- B: the App restarting itself ---------------------------------------------------------------------
describe("the App restarts itself as a last resort (B)", () => {
  const S = "aaaaaaaaaaaaaaaa";
  test("one restart per incident, with its marks in /data, counted at the next start as asked by the App", () => {
    const { p, notices, n, at } = world();
    expect(selfRestart(p, T, "channel-restarts", "on", S, "his Discord channel stayed down across 3 restarts of his session", n)).toBe("restart");
    const rows = parseSelfRows(readFileSync(p.selfRows, "utf8"));
    expect(rows).toEqual([{ at: T, kind: "channel-restarts", cause: "his Discord channel stayed down across 3 restarts of his session" }]);
    expect(JSON.parse(readFileSync(p.selfAsked, "utf8"))).toEqual({ id: S, at: T, kind: "channel-restarts" });
    expect(tells(notices)).toEqual(["self-restart"]);
    // Due again within 30 minutes (the same incident, or another alarm in its window): coalesced.
    expect(selfRestart(p, T + 60, "channel-down", "on", S, "down 10 minutes", n)).toBe("wait");
    expect(selfRestart(p, T + SELF_INCIDENT_S - 1, "channel-down", "on", S, "down 10 minutes", n)).toBe("wait");
    expect(parseSelfRows(readFileSync(p.selfRows, "utf8")).length).toBe(1);
    // The next container: its start is kept as asked, the App the requester, the cause named.
    const q = at("run2");
    writeFileSync(q.start, JSON.stringify({ id: S, at: T - 100 }));
    expect(recordBoot(q, T + 20, n, "bbbbbbbbbbbbbbbb")).toBe("asked");
    expect(readFileSync(q.boots, "utf8").trim()).toBe(`${T + 20} asked self:channel-restarts`);
    expect(existsSync(q.selfAsked)).toBe(false);
  });
  test("a mark naming another start, or too old, counts as a plain boot", () => {
    const { p, n, at } = world();
    selfRestart(p, T, "channel-down", "on", S, "down", n);
    const q = at("run2");
    writeFileSync(q.start, JSON.stringify({ id: "cccccccccccccccc", at: T - 100 }));
    expect(recordBoot(q, T + 20, n, "bbbbbbbbbbbbbbbb")).toBe("boot");
    const { p: p2, n: n2, at: at2 } = world();
    selfRestart(p2, T, "channel-down", "on", S, "down", n2);
    const q2 = at2("run2");
    writeFileSync(q2.start, JSON.stringify({ id: S, at: T - 100 }));
    expect(recordBoot(q2, T + 16 * 60, n2, "bbbbbbbbbbbbbbbb")).toBe("boot");
  });
  test("with the watchdog switch off the App never exits: one alarm naming the switch, and it comes down once the switch is on", () => {
    const { p, notices, n } = world();
    expect(selfRestart(p, T, "channel-down", "off", S, "down 10 minutes", n)).toBe("off");
    expect(selfRestart(p, T + 600, "channel-down", "off", S, "down 20 minutes", n)).toBe("off");
    expect(selfRestart(p, T + 1200, "channel-restarts", "off", S, "down", n)).toBe("off");
    expect(tells(notices)).toEqual(["self-off"]);                        // once
    expect(existsSync(p.selfRows)).toBe(false);
    expect(existsSync(p.selfAsked)).toBe(false);
    expect(selfRestart(p, T + 1800, "channel-down", "on", S, "down 30 minutes", n)).toBe("restart");
    expect(notices.some((x) => x[0] === "clear" && x[1] === "watchdog")).toBe(true);
  });
  test("3 answers in a row that can't be read alarm with the reason; a readable one starts the count again", () => {
    const { p, notices, n } = world();
    expect(selfRestart(p, T, "channel-down", "unknown", S, "down", n)).toBe("unknown");
    expect(selfRestart(p, T + 60, "channel-down", "unknown", S, "down", n)).toBe("unknown");
    expect(tells(notices)).toEqual([]);
    expect(selfRestart(p, T + 120, "channel-down", "unknown", S, "down", n)).toBe("unknown");
    expect(tells(notices)).toEqual(["self-refused"]);
    expect(notices.find((x) => x[1] === "self-refused")![2]).toContain("3 times in a row");
    expect(selfRestart(p, T + 180, "channel-down", "unknown", S, "down", n)).toBe("unknown");
    expect(tells(notices)).toEqual(["self-refused"]);                    // not again each tick
    expect(selfRestart(p, T + 240, "channel-down", "off", S, "down", n)).toBe("off");
    expect(JSON.parse(readFileSync(p.self, "utf8")).refusals).toBe(0);
  });
  test("an alarm after 3 self-restarts in 24 hours, or 2 for the same cause", () => {
    const rows: SelfRow[] = [];
    const st = { refusals: 0, offTold: false };
    const a = selfDecide(rows, st, "on", "channel-down", "x", T);
    expect(a.alarms).toEqual([]);
    const b = selfDecide([a.row!], st, "on", "channel-restarts", "x", T + 3600);
    expect(b.alarms).toEqual([]);
    const c = selfDecide([a.row!, b.row!], st, "on", "channel-restarts", "x", T + 7200);
    expect(c.alarms).toEqual([{ kind: "self-loops", cause: "3 in 24 hours, the last for his Discord channel down across 3 restarts of his session" }]);
    const d = selfDecide([a.row!], st, "on", "channel-down", "x", T + 3600);
    expect(d.alarms).toEqual([{ kind: "self-loops", cause: "2 in 24 hours for his Discord channel down 10 minutes" }]);
    expect(selfDecide([a.row!], st, "on", "channel-down", "x", T + 86400).alarms).toEqual([]);
  });
  test("every self-restart is in the morning check-in, with its cause and time", () => {
    const rows = [{ at: T - 7200, kind: "channel-down", cause: "x" }, { at: T - 100 * 3600, kind: "channel-down", cause: "old" }];
    const line = selfReport(rows, T, "America/New_York");
    expect(line).toContain("Your App restarted itself once in the last 24 hours: at ");
    expect(line).toContain("for his Discord channel down 10 minutes");
    expect(selfReport([], T, "America/New_York")).toBe("");
  });
  test("an asked-restart loop names the App's own restarts among them", () => {
    const { p, notices, n } = world();
    const lines = Array.from({ length: 7 }, (_, i) => `${T + i * 300} asked${i < 2 ? " self:channel-down" : ""}`).join("\n") + "\n";
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    writeFileSync(p.boots, lines);
    checkBoots(p, T + 2100, n);
    const told = notices.find((x) => x[1] === "asked-loop");
    expect(told?.[2]).toBe("7 in 60 minutes, 2 of them the App's own restarts (for his Discord channel down 10 minutes)");
  });
});

// -- I: the drill tool --------------------------------------------------------------------------------
describe("the drill tool finds the container by name and checks its own tools (I)", () => {
  const DRILL = join(import.meta.dir, "..", "tools", "probe-drill.sh");
  const drillSrc = readFileSync(DRILL, "utf8");
  // A stand-in docker: lists the given names, runs nothing, and answers "command -v" for the tools given.
  function fakeDocker(names: string[], have: string[]) {
    const d = mkdtempSync(join(tmpdir(), "drill-"));
    dirs.push(d);
    writeFileSync(join(d, "docker"), `#!/bin/bash
case "$1" in
  ps) printf '%s\\n' ${names.map((x) => `'${x}'`).join(" ")} ;;
  exec) shift; [ "$1" = -u ] && shift 2; shift
        if [ "$1" = sh ] && [ "$2" = -c ]; then t="$(printf '%s' "$3" | sed -n "s/^command -v '\\(.*\\)'$/\\1/p")"
          if [ -n "$t" ]; then case " ${have.join(" ")} " in *" $t "*) exit 0 ;; *) exit 1 ;; esac; fi
        fi
        exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
    return d;
  }
  const run = (args: string[], path: string, extra: Record<string, string> = {}) =>
    Bun.spawnSync(["/bin/bash", DRILL, ...args], { env: { PATH: path, HOME: tmpdir(), ...extra }, stdout: "pipe", stderr: "pipe" });

  test.skipIf(process.platform === "win32")("with no docker here, it fails loudly before any step", () => {
    const empty = mkdtempSync(join(tmpdir(), "drill-empty-"));
    dirs.push(empty);
    const r = run(["1b"], empty);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString()).toContain("FAIL: step 1b needs 'docker' on this machine");
  });
  test.skipIf(process.platform === "win32")("it finds app_<hash>_cain, then addon_<hash>_cain, and names a tool the container lacks", () => {
    const a = fakeDocker(["homeassistant", "app_0fcc2575_cain", "addon_core_ssh"], ["sh", "tr", "awk"]);
    const r = run(["1b"], `${a}:/usr/bin:/bin`);
    expect(r.stdout.toString()).toContain("the Cain container: app_0fcc2575_cain");
    expect(r.stdout.toString()).toContain("FAIL: step 1b needs 'tmux' in the container app_0fcc2575_cain, and it isn't there");
    expect(r.exitCode).toBe(2);
    const b = fakeDocker(["homeassistant", "addon_0fcc2575_cain"], []);
    const r2 = run(["0"], `${b}:/usr/bin:/bin`);
    expect(r2.stdout.toString()).toContain("the Cain container: addon_0fcc2575_cain");
    expect(r2.stdout.toString()).toContain("FAIL: step 0 needs 'bun' in the container addon_0fcc2575_cain");
    const none = fakeDocker(["homeassistant"], []);
    const r3 = run(["2"], `${none}:/usr/bin:/bin`);
    expect(r3.stdout.toString()).toContain("FAIL: no Cain container found");
    // CAIN_CONTAINER still picks one by hand.
    const r4 = run(["0"], `${b}:/usr/bin:/bin`, { CAIN_CONTAINER: "app_mine_cain" });
    expect(r4.stdout.toString()).toContain("the Cain container: app_mine_cain");
  });
  test("every step checks its tools first; kills go through /proc, never pkill or ps; the README says how to rerun 1b", () => {
    const code = drillSrc.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bpkill\b|\bpgrep\b|(?<!docker )\bps\s+(-|aux)/m);
    expect(code).not.toContain("addon_0fcc2575_cain");
    for (const step of ["0", "1", "1b", "2", "3", "4", "5", "6", "7"]) {
      const body = drillSrc.slice(drillSrc.search(new RegExp(`^  ${step}\\)`, "m")));
      expect(body.split("\n")[1]).toMatch(/^\s+need_in /);
    }
    expect(drillSrc).toContain("bash probe-drill.sh 1b");
    // Second round: every kill goes through kill_exact (inside the container, exact executable and
    // arguments, never an ambiguous match); no step kills by a pattern any more.
    expect(code).not.toMatch(/kill -9 "\$\{p#\/proc\/\}"|grep -qa "discord\/plugin\/server\.ts"/);
    expect(code.match(/kill_exact (root|cain) /g)?.length).toBe(3);
    expect(drillSrc).toContain("PLUGIN_SERVER=(/usr/local/bin/bun /usr/local/bin/bun /opt/cain/discord/plugin/server.ts)");
    expect(drillSrc).toContain("CLAUDE_CODE=(/usr/local/bin/claude claude --permission-mode auto --channels plugin:discord@claude-plugins-official)");
    // The exact command lines match what the App starts.
    expect(readFileSync(join(OPT, "session.sh"), "utf8")).toContain("\nclaude --permission-mode auto --channels plugin:discord@claude-plugins-official\n");
    expect(readFileSync(join(OPT, "discord", "broker-main.ts"), "utf8")).toContain('"/usr/local/bin/bun", join(PLUGIN, "server.ts")');
  });
  // Fourth round: step 7's gate proves the probe itself, not only that /health can be reached.
  test("step 7's gate reads the Watchdog switch through the Supervisor's info call and needs a /health 200 to the Supervisor in its window", () => {
    const seven = drillSrc.slice(drillSrc.search(/^  7\)/m), drillSrc.search(/^  \*\)/m));
    expect(seven).toContain("http://supervisor/addons/self/info");
    expect(seven).toContain('[ "$wd" = true ] || fail');
    expect(seven).toContain("-K -");                                              // the token never on a command line
    expect(seven).not.toMatch(/echo[^\n]*SUPERVISOR_TOKEN|Bearer \$/);
    expect(seven).toContain("/run/cain-web/health-ok.log");
    expect(seven).toContain('[ "${oks:-0}" -ge 1 ] || fail');
    expect(seven.indexOf('[ "$wd" = true ]')).toBeLessThan(seven.indexOf("PASS (gate)"));
    expect(seven.indexOf("sleep 190")).toBeLessThan(seven.indexOf('[ "${oks:-0}" -ge 1 ]'));
    expect(seven).toMatch(/PASS \(gate\): the Watchdog switch is on \(the Supervisor's info call\), the Supervisor's own probe from \$sup_ip got 200/);
    const nginx = readFileSync(join(import.meta.dir, "..", "rootfs", "etc", "nginx", "nginx.conf"), "utf8");
    expect(nginx).toContain("access_log /run/cain-web/health-ok.log cain_health_ok if=$cain_health_ok;");
    expect(nginx).toContain("log_format cain_health_ok '$msec $remote_addr';");
  });
  test.skipIf(process.platform !== "linux")("kill_exact kills the one exact match, refuses an ambiguous one, and leaves look-alikes", async () => {
    const body = drillSrc.match(/^KILL_EXACT='([^']*)'$/m)![1];
    const spawn = (mark: string) => Bun.spawn(["/bin/bash", "-c", "sleep 30; :", mark], { stdout: "ignore", stderr: "ignore" });
    const kx = (...a: string[]) => Bun.spawnSync(["sh", "-c", body, "kill_exact", ...a], { stdout: "pipe" });
    const twins = [spawn("drill-twin"), spawn("drill-twin")];
    const one = spawn("drill-one");
    const alike = spawn("drill-one-more");
    await Bun.sleep(200);
    try {
      const amb = kx("TERM", "/bin/bash", "/bin/bash", "-c", "sleep 30; :", "drill-twin");
      expect([amb.exitCode, amb.stdout.toString().trim()]).toEqual([3, "ambiguous:2"]);
      expect(twins.every((p) => p.exitCode === null)).toBe(true);
      const r = kx("TERM", "/bin/bash", "/bin/bash", "-c", "sleep 30; :", "drill-one");
      expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, `killed:${one.pid}`]);
      await one.exited;
      expect(alike.exitCode).toBe(null);
      // The same arguments under another executable, or a prefix of them, match nothing.
      expect(kx("TERM", "/bin/sh", "/bin/bash", "-c", "sleep 30; :", "drill-one-more").exitCode).toBe(4);
      expect(kx("TERM", "/bin/bash", "/bin/bash", "-c", "sleep 30; :").exitCode).toBe(4);
      expect(alike.exitCode).toBe(null);
    } finally { for (const p of [...twins, one, alike]) p.kill(); }
  });
});

// -- C: no alarm or notice hands the owner a manual step ----------------------------------------------
describe("no alarm or notice hands the owner a manual step (C)", () => {
  const ROOTFS = join(import.meta.dir, "..", "rootfs");
  const NOTICE = join(ROOTFS, "opt", "cain", "notice.sh");
  // What a manual step reads like. The one exception: the Supervisor's Watchdog switch, in its own
  // alarm (self-off), the one thing only he can turn on.
  const MANUAL = [/restart (the )?(cain )?app\b/i, /restart cain\b/i, /settings, (apps|system)/i, /switch (it|that|this) (off|on)/i,
    /turn (it|that|the \w+) off/i, /check the supervisor log/i, /by hand/i, /\brestor(e|ing)\b/i, /\bopen cain\b/i,
    /\btap (restart|start|sign in)/i, /needs fixing/i, /status page/i, /\bfrom backups\b/i];
  const SWITCH = "Home Assistant, Settings, Apps, Cain, Watchdog";
  const manual = (t: string) => MANUAL.filter((r) => r.test(t)).map(String);
  const kinds = (() => {
    const src = readFileSync(NOTICE, "utf8");
    const body = src.slice(src.indexOf("alarm() {"), src.indexOf("cleared_text() {"));
    return [...body.matchAll(/^    ([a-z-]+)\) (?:T=|local )/gm)].map((m) => m[1]);
  })();

  test("every alarm's title and text names the cause and the App's own step, never a step of his", () => {
    expect(kinds.length).toBeGreaterThan(35);
    for (const k of ["channel", "server-gone", "self-restart", "self-off", "self-refused", "self-loops", "session"]) expect(kinds).toContain(k);
    for (const k of kinds) {
      const r = Bun.spawnSync(["bash", NOTICE, "text", k, "a cause"], { stdout: "pipe", stderr: "pipe" });
      expect([k, r.exitCode]).toEqual([k, 0]);
      let t = r.stdout.toString();
      if (k === "self-off") { expect(t).toContain(SWITCH); expect(t).toContain("the one thing only you can turn on"); t = t.replace(SWITCH, ""); }
      expect([k, manual(t)]).toEqual([k, []]);
    }
  });
  test("each names its real cause: the plugin's server gone, the session exiting, the channel down past its restarts, the App restarting", () => {
    const text = (k: string, c = "") => Bun.spawnSync(["bash", NOTICE, "text", k, c], { stdout: "pipe" }).stdout.toString();
    expect(text("server-gone", "x")).toContain("the Discord plugin's server keeps stopping");
    expect(text("session", "x")).toContain("his session keeps exiting soon after it starts");
    expect(text("channel", "x")).toContain("his Discord channel keeps going down");
    expect(text("self-restart", "his Discord channel has been down 11 minutes")).toContain("is restarting itself: his Discord channel has been down 11 minutes");
    expect(text("self-off", "x")).toContain("Watchdog switch for the Cain App is off");
    // Nov 20's alarm, "his session keeps stopping soon after it starts" with "restart the App", is gone.
    expect(text("session")).not.toMatch(/restart the app|restart cain/i);
  });
  test("no shipped file carries a manual-step phrase in what it says to him", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of require("node:fs").readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(sh|ts|md|json)$|\/(run|finish)$/.test(p)) files.push(p); } };
    walk(ROOTFS);
    const hits: string[] = [];
    for (const f of files) {
      // The App's own alarms and notices: everything but the parts this release leaves alone (the link,
      // the message gate, the record keeper, the review runner and its ChatGPT sign-in page, PC jobs),
      // whose lines go to Cain or name a fix at his PC, and Cain's own instructions (CLAUDE.md).
      if (/\/(link|gate|record|review|pcjobs)\/|\/(CLAUDE\.md|settings\.json|pin\.json|record\.sh|review\.sh|pcjobs\.sh|keeper\.sh)$/.test(f)) continue;
      readFileSync(f, "utf8").split("\n").forEach((l, i) => {
        const s = l.trim();
        if (s.startsWith("#") || s.startsWith("//") || s.startsWith("*")) return;
        if (f.endsWith("notice.sh") && l.includes(SWITCH)) return;
        for (const m of manual(l)) hits.push(`${f.slice(ROOTFS.length)}:${i + 1}: ${m}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

// -- second round follow-ups: pinned files and the panel's sockets ------------------------------------
import { pinSocket, SOCKET_MODE } from "../rootfs/opt/cain/pinned.ts";
import * as pinnedMod from "../rootfs/opt/cain/pinned.ts";
import { statSync } from "node:fs";
import { createServer } from "node:net";
describe("pinned files and the panel's sockets", () => {
  test("the unused synchronous writer is gone", () => {
    expect("writePinnedSync" in pinnedMod).toBe(false);
  });
  test.skipIf(process.platform === "win32")("the codex socket is pinned 0770, as ttyd's, and a failed chown is logged when root", async () => {
    const d = mkdtempSync(join(tmpdir(), "cain-sock-"));
    dirs.push(d);
    const path = join(d, "codex.sock");
    const srv = createServer(() => {});
    await new Promise<void>((ok) => srv.listen(path, ok));
    const said: string[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
    try {
      pinSocket(path, Number(process.getgid?.() ?? 0));
      expect(statSync(path).mode & 0o777).toBe(SOCKET_MODE);
      expect(SOCKET_MODE).toBe(0o770);
      pinSocket(path, Number.NaN);                                 // a chown that can't work
      expect(statSync(path).mode & 0o777).toBe(0o770);
      if (process.getuid?.() === 0) expect(said.some((l) => l.includes(`couldn't give ${path} to root:nogroup`))).toBe(true);
      else expect(said).toEqual([]);
    } finally { console.error = was; srv.close(); }
    const review = readFileSync(join(OPT, "review", "main.ts"), "utf8");
    expect(review).toContain("pinSocket(sock);");
    expect(review).not.toContain("0o660");
    expect(readFileSync(join(import.meta.dir, "..", "rootfs", "etc", "services.d", "terminal", "run"), "utf8"))
      .toContain("--socket-owner root:nogroup");
  });
});

// -- second round: a self-restart that never comes back is raised from outside -------------------------
describe("the finish script on a self-restart (the outside review's third finding)", () => {
  const FINISH = join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "finish");
  function finish(code: string, signal: string, marked: boolean, at?: string) {
    const d = at ?? mkdtempSync(join(tmpdir(), "cain-finish-"));
    if (!at) dirs.push(d);
    for (const s of ["run/cain", "results", "bin"]) mkdirSync(join(d, s), { recursive: true });
    for (const f of ["curl.args", "halted", "results/exitcode"]) rmSync(join(d, f), { force: true });
    if (marked) writeFileSync(join(d, "run/cain/self-restart"), code === "3" ? `${Math.floor(Date.now() / 1000)} fallback\n` : "");
    writeFileSync(join(d, "bin/curl"), `#!/bin/bash\ncat > /dev/null\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${d}/curl.args"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(d, "bin/halt"), `#!/bin/bash\necho halted > "${d}/halted"\n`, { mode: 0o755 });
    const src = readFileSync(FINISH, "utf8").split("\n").slice(1).join("\n")
      .replaceAll("/run/cain", join(d, "run/cain")).replaceAll("/run/s6-linux-init-container-results", join(d, "results"))
      .replaceAll("/run/s6/basedir/bin/halt", join(d, "bin/halt"));
    const sh = `bashio::config() { printf '%s' "https://hc-ping.example.net/fixture-0005"; }\nbashio::log.info() { echo "info: $*"; }\nbashio::log.warning() { echo "warn: $*"; }\nset -- ${code} ${signal}\n${src}`;
    const p = Bun.spawnSync(["bash", "-c", sh], { env: { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const args = existsSync(join(d, "curl.args")) ? readFileSync(join(d, "curl.args"), "utf8").split("\n") : [];
    const body = args.length ? args[args.indexOf("--data-binary") + 1] : null;
    return { body, halted: existsSync(join(d, "halted")), exitcode: existsSync(join(d, "results/exitcode")) ? readFileSync(join(d, "results/exitcode"), "utf8").trim() : null, out: p.stdout.toString(), dir: d };
  }
  test.skipIf(process.platform === "win32")("the exit route (3): the heartbeat hears a self-restart failure, and the container halts with 3", () => {
    const r = finish("3", "", true);
    expect(r.body).toContain("restarting itself (self-restart, exit code 3)");
    expect([r.halted, r.exitcode]).toEqual([true, "3"]);
  });
  test.skipIf(process.platform === "win32")("the Supervisor's restart call (256, SIGTERM): the heartbeat hears it too, and the stop goes on", () => {
    const r = finish("256", "15", true);
    expect(r.body).toContain("restarting itself (self-restart, exit code 256)");
    expect(r.halted).toBe(false);
  });
  test.skipIf(process.platform === "win32")("without the mark, an error still says stopped on an error, and a plain stop says nothing", () => {
    expect(finish("1", "", false).body).toBe("stopped on an error");
    expect(finish("256", "15", false).body).toBe(null);
  });
  // Third round, the second outside review's first finding: the mark is consumed exactly once.
  test.skipIf(process.platform === "win32")("a mark consumed by one finish is gone for the next: the owner's Stop after it is a plain stop, a crash is a crash", () => {
    const first = finish("256", "15", true);
    expect(first.body).toContain("self-restart, exit code 256");
    expect(existsSync(join(first.dir, "run/cain/self-restart"))).toBe(false);
    expect(finish("256", "15", false, first.dir).body).toBe(null);                 // the owner's own Stop: nothing
    const crash = finish("1", "", false, first.dir);
    expect([crash.body, crash.halted, crash.exitcode]).toEqual(["stopped on an error", true, "1"]);
  });
  // A mark left in /run from an earlier self-restart (s6 restarting the service in a live container
  // keeps /run): the run script's very top clears it before its traps are armed, so a real crash after
  // it alarms from the EXIT trap, and the finish script reports it as a crash, not a self-restart.
  test.skipIf(process.platform === "win32")("a stale mark at start: the run script clears it, the exit trap alarms on a crash, and finish doesn't call it a self-restart", () => {
    const RUN = join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "run");
    const lines = readFileSync(RUN, "utf8").split("\n");
    const exitTrap = lines.findIndex((l) => l.startsWith("trap ") && l.endsWith(" EXIT"));
    const termTrap = lines.findIndex((l) => l.startsWith("trap ") && l.endsWith(" TERM"));
    const clear = lines.findIndex((l) => l.startsWith("rm -f /run/cain/self-restart"));
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(exitTrap);
    expect(exitTrap).toBeLessThan(termTrap);
    const d = mkdtempSync(join(tmpdir(), "cain-stale-"));
    dirs.push(d);
    for (const s of ["run/cain", "run/cain-web/www", "opt"]) mkdirSync(join(d, s), { recursive: true });
    writeFileSync(join(d, "run/cain/self-restart"), "");                            // left from before
    writeFileSync(join(d, "opt/notice.sh"), `#!/bin/bash\necho "$*" >> "${d}/notices"\n`, { mode: 0o755 });
    // The run script from its top through the EXIT trap, as shipped, then a crash (a step that fails
    // under errexit, as bashio runs it).
    const top = lines.slice(1, exitTrap + 1).join("\n").replaceAll("/run/cain", join(d, "run/cain"))
      .replace("OPT=/opt/cain", `OPT=${join(d, "opt")}`);
    const p = Bun.spawnSync(["bash", "-c", `set -o errexit\n${top}\nfalse\n`], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(existsSync(join(d, "run/cain/self-restart"))).toBe(false);
    expect(readFileSync(join(d, "notices"), "utf8").trim()).toBe("tell exited");
    const r = finish("1", "", false, d);
    expect(r.body).toBe("stopped on an error");
    expect(r.out).not.toContain("restart itself");
  });
  // Fourth round, the third outside review's third finding: the mark is live from just before the restart
  // request until the real stop. The run script from its top through its TERM trap, as shipped, with a
  // fresh mark written as self_mark writes it (the epoch), then one way of ending.
  function inWindow(end: string) {
    const RUN = join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "run");
    const lines = readFileSync(RUN, "utf8").split("\n");
    const termTrap = lines.findIndex((l) => l.startsWith("trap ") && l.endsWith(" TERM"));
    const d = mkdtempSync(join(tmpdir(), "cain-window-"));
    dirs.push(d);
    for (const s of ["run/cain", "run/cain-web/www", "opt"]) mkdirSync(join(d, s), { recursive: true });
    writeFileSync(join(d, "opt/notice.sh"), `#!/bin/bash\necho "$*" >> "${d}/notices"\n`, { mode: 0o755 });
    const top = lines.slice(1, termTrap + 1).join("\n").replaceAll("/run/cain", join(d, "run/cain"))
      .replace("OPT=/opt/cain", `OPT=${join(d, "opt")}`).replace(/^stop_asked\(\) \{.*$/m, "stop_asked() { :; }");
    const p = Bun.spawnSync(["bash", "-c", `set -o errexit\n${top}\nSELF_MARK=${join(d, "run/cain/self-restart")}\ndate +%s > "$SELF_MARK"\n${end}\n`], { stdout: "pipe", stderr: "pipe" });
    const notices = existsSync(join(d, "notices")) ? readFileSync(join(d, "notices"), "utf8").trim() : "";
    return { code: p.exitCode, signal: p.signalCode, marked: existsSync(join(d, "run/cain/self-restart")), notices, dir: d };
  }
  test.skipIf(process.platform === "win32")("a crash inside the self-restart window takes the mark away: it alarms, and finish reports a crash", () => {
    const c = inWindow("false");
    expect([c.code, c.marked, c.notices]).toEqual([1, false, "tell exited"]);
    const r = finish("1", "", false, c.dir);
    expect([r.body, r.halted, r.exitcode]).toEqual(["stopped on an error", true, "1"]);
    expect(r.out).not.toContain("restart itself");
  });
  test.skipIf(process.platform === "win32")("the deliberate fallback (exit 3) and a caught TERM keep the mark, and neither alarms from the trap", () => {
    const three = inWindow("printf '%s fallback\\n' \"$(date +%s)\" > \"$SELF_MARK\"; exit 3");
    expect([three.code, three.marked, three.notices]).toEqual([3, true, ""]);
    const term = inWindow("kill -TERM $$; sleep 5");
    expect([term.signal, term.marked, term.notices]).toEqual(["SIGTERM", true, ""]);
  });
  test.skipIf(process.platform === "win32")("a TERM stop later than the wait plus 30 seconds after the mark is a stop during the window, not a self-restart", () => {
    const now = Math.floor(Date.now() / 1000);
    const late = mkdtempSync(join(tmpdir(), "cain-late-"));
    dirs.push(late);
    mkdirSync(join(late, "run/cain"), { recursive: true });
    writeFileSync(join(late, "run/cain/self-restart"), `${now - 151}\n`);
    const r = finish("256", "15", false, late);
    expect(r.body).toBe(null);                                                      // no self-restart ping
    expect(r.out).toContain("stopped during the self-restart window");
    expect(r.halted).toBe(false);
    expect(existsSync(join(late, "run/cain/self-restart"))).toBe(false);            // still used once
    // Inside the window it is the self-restart, as before; so is a mark with no time (an earlier version).
    writeFileSync(join(late, "run/cain/self-restart"), `${now - 140}\n`);
    expect(finish("256", "15", false, late).body).toContain("self-restart, exit code 256");
    writeFileSync(join(late, "run/cain/self-restart"), "");
    expect(finish("256", "15", false, late).body).toContain("self-restart, exit code 256");
    // The exit route (3) is the run script's own fallback, after its wait: a self-restart whatever the age.
    writeFileSync(join(late, "run/cain/self-restart"), `${now - 600} fallback\n`);
    expect(finish("3", "", false, late).body).toContain("self-restart, exit code 3");
  });
  // Fifth round, the fourth outside review's first gap: only TERM is the Supervisor's stop.
  test.skipIf(process.platform === "win32")("a death by signal 9 inside the window is a crash: the mark goes, the heartbeat hears an error, and it halts", () => {
    const d = mkdtempSync(join(tmpdir(), "cain-kill9-"));
    dirs.push(d);
    mkdirSync(join(d, "run/cain"), { recursive: true });
    writeFileSync(join(d, "run/cain/self-restart"), `${Math.floor(Date.now() / 1000) - 10}\n`);
    const r = finish("256", "9", false, d);
    expect([r.body, r.halted, r.exitcode]).toEqual(["stopped on an error", true, "137"]);
    expect(r.out).toContain("died of signal 9 during the self-restart window");
    expect(r.out).not.toContain("restart itself");
    expect(existsSync(join(d, "run/cain/self-restart"))).toBe(false);
    // SIGSEGV too; TERM in the same window is still the self-restart, and nothing halts.
    writeFileSync(join(d, "run/cain/self-restart"), `${Math.floor(Date.now() / 1000) - 10}\n`);
    expect(finish("256", "11", false, d).exitcode).toBe("139");
    writeFileSync(join(d, "run/cain/self-restart"), `${Math.floor(Date.now() / 1000) - 10}\n`);
    const term = finish("256", "15", false, d);
    expect([term.body?.includes("self-restart, exit code 256"), term.halted]).toEqual([true, false]);
    // Without a mark, a signal death is as before (no halt here; the probe classes the stop).
    expect(finish("256", "9", false, d).halted).toBe(false);
  });
  // Fifth round, the second gap: the window measures from the run script's last action. self_mark is
  // written again just before the 2-minute wait, in both branches that wait.
  test.skipIf(process.platform === "win32")("a mark first written 160 s ago and re-stamped 40 s ago is the self-restart; one 160 s old and never re-stamped is not", () => {
    const now = Math.floor(Date.now() / 1000);
    const d = mkdtempSync(join(tmpdir(), "cain-restamp-"));
    dirs.push(d);
    mkdirSync(join(d, "run/cain"), { recursive: true });
    const mark = join(d, "run/cain/self-restart");
    writeFileSync(mark, `${now - 160}\n`);
    writeFileSync(mark, `${now - 40}\n`);                                           // re-stamped, as self_mark does
    expect(finish("256", "15", false, d).body).toContain("self-restart, exit code 256");
    writeFileSync(mark, `${now - 160}\n`);
    const old = finish("256", "15", false, d);
    expect(old.body).toBe(null);
    expect(old.out).toContain("stopped during the self-restart window");
    const run = readFileSync(join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "run"), "utf8");
    const waits = [...run.matchAll(/\n( *)self_mark\n\1nap "\$\{C1_SELF_STOP_WAIT_S:-120\}"\n/g)];
    expect(waits.length).toBe(2);
    expect(run.split('nap "${C1_SELF_STOP_WAIT_S:-120}"').length - 1).toBe(2);
  });
  // Fifth round, follow-up: an exit 3 is the fallback only with the word fallback in the mark.
  test.skipIf(process.platform === "win32")("the fallback writes its word and finish reports a self-restart; a stray exit 3 alarms and is a crash", () => {
    const RUN = join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "run");
    const run = readFileSync(RUN, "utf8");
    const fns = run.slice(run.indexOf("self_mark() {"), run.indexOf("self_tried=0"));
    const d = mkdtempSync(join(tmpdir(), "cain-fallback-"));
    dirs.push(d);
    mkdirSync(join(d, "run/cain"), { recursive: true });
    const mark = join(d, "run/cain/self-restart");
    writeFileSync(mark, `${Math.floor(Date.now() / 1000) - 100}\n`);
    const p = Bun.spawnSync(["bash", "-c", `health_down() { :; }\n${fns.replaceAll("/run/cain", join(d, "run/cain"))}\nself_exit\n`]);
    expect(p.exitCode).toBe(3);
    expect(readFileSync(mark, "utf8")).toMatch(/^\d+ fallback\n$/);
    const r = finish("3", "", false, d);
    expect(r.body).toContain("restarting itself (self-restart, exit code 3)");
    expect([r.halted, r.exitcode]).toEqual([true, "3"]);
    // A stray 3 in the window, from the run script's real top: the trap drops the mark and alarms, and
    // even a mark left without the word is a crash in finish.
    const stray = inWindow("exit 3");
    expect([stray.code, stray.marked, stray.notices]).toEqual([3, false, "tell exited"]);
    expect([finish("3", "", false, stray.dir).body, finish("3", "", false, stray.dir).halted]).toEqual(["stopped on an error", true]);
    writeFileSync(mark, `${Math.floor(Date.now() / 1000)}\n`);
    const kept = finish("3", "", false, d);
    expect([kept.body, kept.halted, kept.exitcode]).toEqual(["stopped on an error", true, "3"]);
    expect(kept.out).toContain("without its fallback's mark");
  });
});

// -- fourth round: nginx no longer waits on the run script for its folder -------------------------------
describe("terminal/run makes /run/cain-web itself, just before nginx", () => {
  const TERM_RUN = join(import.meta.dir, "..", "rootfs", "etc", "services.d", "terminal", "run");
  const src = readFileSync(TERM_RUN, "utf8");
  test("no wait for the folder; it is made with lock.sh's owner and modes, before nginx starts", () => {
    expect(src).not.toMatch(/seq 1 120|\[ -d \/run\/cain-web/);
    const lock = readFileSync(join(OPT, "c1", "lock.sh"), "utf8");
    for (const l of ["install -d -m 0750 -o root -g nogroup /run/cain-web", "install -d -m 0750 -o root -g nogroup /run/cain-web/www /run/cain-web/upstream"]) {
      expect(src).toContain(`\n${l}\n`);
      expect(lock).toContain(l);                                                   // lock.sh's own, unchanged
    }
    expect(src.indexOf("install -d -m 0750 -o root -g nogroup /run/cain-web\n")).toBeLessThan(src.indexOf('nginx_out="$(nginx 2>&1)"'));
  });
  test.skipIf(process.platform === "win32")("run with no folder there, nginx finds it made, with www and upstream at 0750", () => {
    const d = mkdtempSync(join(tmpdir(), "cain-term-"));
    dirs.push(d);
    mkdirSync(join(d, "bin"), { recursive: true });
    const web = join(d, "run/cain-web");
    // nginx and ttyd stand-ins: nginx notes what it finds; ttyd ends the script.
    writeFileSync(join(d, "bin/nginx"), `#!/bin/bash\nstat -c '%n %a' ${web} ${web}/www ${web}/upstream > ${d}/seen 2>&1\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(d, "bin/ttyd"), `#!/bin/bash\necho ttyd >> ${d}/seen\n`, { mode: 0o755 });
    writeFileSync(join(d, "bin/sleep"), `#!/bin/bash\necho "sleep $*" >> ${d}/slept\n`, { mode: 0o755 });
    const body = src.split("\n").slice(1).join("\n")
      .replaceAll("-o root -g nogroup ", "")                                       // no chown as a test user
      .replaceAll("/run/cain-web", web).replaceAll("/opt/cain/", `${d}/opt/`).replaceAll("/etc/nginx/owner.conf", `${d}/owner.conf`)
      .replaceAll("/run/s6/container_environment", `${d}/env`);
    mkdirSync(join(d, "opt"), { recursive: true });
    writeFileSync(join(d, "opt/owner-gate.sh"), "#!/bin/bash\necho gate\n", { mode: 0o755 });
    writeFileSync(join(d, "opt/notice.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const sh = `bashio::app.config() { :; }\nbashio::config() { echo x; }\nbashio::log.info() { :; }\nbashio::log.error() { echo "error: $*"; }\n${body}`;
    const p = Bun.spawnSync(["bash", "-c", sh], { env: { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const seen = readFileSync(join(d, "seen"), "utf8").trim().split("\n");
    expect(seen).toEqual([`${web} 750`, `${web}/www 750`, `${web}/upstream 750`, "ttyd"]);
    expect(existsSync(join(d, "slept"))).toBe(false);                               // no wait at all
  });
});

// -- third round: the Supervisor calls are bounded as a process group, and /health 404s reach the log ----
describe("run_bounded and the health check's 404 line", () => {
  const RUN = readFileSync(join(import.meta.dir, "..", "rootfs", "etc", "services.d", "cain", "run"), "utf8");
  const fn = (name: string) => { const a = RUN.indexOf(`${name}() {`); return RUN.slice(a, RUN.indexOf("\n}\n", a) + 3); };
  test.skipIf(process.platform !== "linux")("a hung call is killed with everything it started: no orphan curl", () => {
    const tag = `cain-hung-${process.pid}-${Date.now()}`;
    const d = mkdtempSync(join(tmpdir(), "cain-bounded-"));
    dirs.push(d);
    // A stand-in for bashio's curl to a Supervisor that never answers: a child process of the call.
    const sh = `set -o errexit -o nounset -o pipefail\nnap() { sleep "$1" & wait $! 2>/dev/null || true; }\n${fn("run_bounded")}\n`
      + `hung() { bash -c 'sleep 300; : ${tag}'; }\nrc=0; run_bounded 1 ${d}/out hung || rc=$?; echo "rc=$rc"\n`
      // Fourth round: one that ignores the TERM (as a stuck curl might) is KILLed 5 seconds after it.
      + `deaf() { bash -c "trap '' TERM; sleep 300; : ${tag}-deaf"; }\nt0=$SECONDS; rc=0; run_bounded 1 ${d}/out deaf || rc=$?; echo "deaf=$rc after=$(( SECONDS - t0 ))"\n`
      + `quick() { echo answer; }\nt0=$SECONDS; run_bounded 5 ${d}/out quick && echo "quick=$(cat ${d}/out) after=$(( SECONDS - t0 ))"\n`;
    const p = Bun.spawnSync(["bash", "-c", sh], { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString();
    expect(out).toContain("rc=124");
    expect(out).toMatch(/deaf=124 after=[67]\b/);
    expect(out).toMatch(/quick=answer after=[01]\b/);                              // no KILL wait without a timeout
    Bun.sleepSync(300);
    const left = Bun.spawnSync(["pgrep", "-f", tag], { stdout: "pipe" }).stdout.toString().trim();
    if (left) Bun.spawnSync(["pkill", "-f", tag]);
    expect(left).toBe("");
  }, 30_000);
  test.skipIf(process.platform === "win32")("each address nginx refused is in one warning with its count, and the note is emptied", () => {
    const d = mkdtempSync(join(tmpdir(), "cain-miss-"));
    dirs.push(d);
    const miss = join(d, "health-miss.log");
    const sh = (pre: string) => `set -o errexit -o nounset -o pipefail\nbashio::log.warning() { echo "warn: $*"; }\nHEALTH_MISS=${miss}\n${fn("health_misses")}\n${pre}\nhealth_misses\n`;
    writeFileSync(miss, "172.30.33.5\n172.30.33.5\n10.0.0.7\n");
    const out = Bun.spawnSync(["bash", "-c", sh("")], { stdout: "pipe" }).stdout.toString().trim().split("\n");
    expect(out.length).toBe(1);
    expect(out[0]).toContain("answered 404 to: 10.0.0.7 (1), 172.30.33.5 (2)");
    expect(readFileSync(miss, "utf8")).toBe("");
    expect(Bun.spawnSync(["bash", "-c", sh("")], { stdout: "pipe" }).stdout.toString()).toBe("");   // nothing new: no line
    expect(RUN).toContain("( while true; do sleep 60; health_misses || true; health_ok_trim || true; done ) &");           // at most once a minute
  });
});
