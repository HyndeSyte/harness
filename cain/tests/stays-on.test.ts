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
    if (m.id !== undefined && m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }) + "\\n");
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

  test.skipIf(process.platform === "win32")("a server that stops is started again within seconds, logged with its exit code, under the same connection", async () => {
    const d = mkdtempSync(join(tmpdir(), "cain-broker-"));
    dirs.push(d);
    for (const s of ["state", "plugin", "outbox", "probe"]) mkdirSync(join(d, s));
    writeFileSync(join(d, "stub.js"), STUB);
    writeFileSync(join(d, "pin.json"), JSON.stringify({ version: "0", files: {} }));
    writeFileSync(join(d, "token.env"), "DISCORD_BOT_TOKEN=not-a-real-token\n");
    const gid = String(process.getgid?.() ?? 0);
    const env = {
      ...process.env, CAIN_DISCORD_SOCK: join(d, "discord.sock"), CAIN_DISCORD_TOKEN_FILE: join(d, "token.env"),
      CAIN_DISCORD_STATE: join(d, "state"), CAIN_DISCORD_PLUGIN: join(d, "plugin"), CAIN_DISCORD_OUTBOX: join(d, "outbox"),
      CAIN_LINK_SOCK: join(d, "no-link.sock"), CAIN_CARDS: join(d, "cards.json"), CAIN_GATE_REPLIED: join(d, "replied.json"),
      CAIN_GATE_LOG: join(d, "gate.jsonl"), PROBE_RUN: join(d, "probe"), CAIN_DISCORD_STATE_FILE: join(d, "discord.state"),
      CAIN_SENT_SPOOL: join(d, "spool.jsonl"), CAIN_GID: gid, DISCORD_GID: gid, CAIN_DISCORD_PIN: join(d, "pin.json"),
      CAIN_DISCORD_SEED: "", CAIN_DISCORD_SERVER_CMD: JSON.stringify([process.execPath, join(d, "stub.js"), join(d, "server.log")]),
      CAIN_SERVER_BACKOFF_SCALE: "1",
    };
    const broker = Bun.spawn([process.execPath, join(OPT, "discord", "broker-main.ts")], { env, stdout: "pipe", stderr: "pipe" });
    let out = "";
    void (async () => { const dec = new TextDecoder(); for await (const c of broker.stdout) out += dec.decode(c); })();
    const until = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await Bun.sleep(50); } return true; };
    try {
      // Bound either way: as root it hands the socket to cain; a runner that isn't root can't chown it
      // to root, says so, and the socket stays its own (this test connects as that same user).
      expect(await until(() => out.includes("listening on") || out.includes("couldn't open the socket to cain"), 10_000)).toBe(true);
      const sock = connect(join(d, "discord.sock"));
      let got = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => { got += c; });
      await new Promise((ok) => sock.on("connect", ok));
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } }) + "\n");
      expect(await until(() => got.includes('"id":1'), 5_000)).toBe(true);
      // The first server stops (code 7): the broker says so with the code, and the state names it.
      expect(await until(() => /the plugin's server stopped \(7\): starting it again in 1 s \(restart 1\)/.test(out), 5_000)).toBe(true);
      const stoppedAt = Date.now();
      expect(readFileSync(join(d, "discord.state"), "utf8")).toMatch(/^server-down \d+\n$/);
      expect(await until(() => out.includes("the plugin's server started again (restart 1, it had stopped with 7)"), 5_000)).toBe(true);
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
      expect(out).not.toContain("a new connection replaced");
      sock.destroy();
      expect(await until(() => readFileSync(join(d, "discord.state"), "utf8").startsWith("down"), 5_000)).toBe(true);
    } finally {
      broker.kill();
      await broker.exited;
    }
    expect(existsSync(join(d, "server.log"))).toBe(true);
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
    for (const step of ["0", "1", "1b", "2", "3", "4", "5", "6"]) {
      const body = drillSrc.slice(drillSrc.search(new RegExp(`^  ${step}\\)`, "m")));
      expect(body.split("\n")[1]).toMatch(/^\s+need_in /);
    }
    expect(drillSrc).toContain("bash probe-drill.sh 1b");
    expect(drillSrc).toMatch(/kill -9 "\$\{p#\/proc\/\}"/);
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
