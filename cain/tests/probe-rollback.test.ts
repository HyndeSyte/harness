// Cain 0.14.0: the probe (liveness, the hourly liveness check, the message round trip), the count
// of crash starts kept in /data, and the rollback within 24 hours of an install: off by default,
// armed only by a crash loop, never deleting a backup, with a durable record outside /data
// (rootfs/opt/cain/probe, rootfs/opt/cain/rollback, the broker and the link's notes).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterStart, alarmFor, askDue, type Backup, decide, endKind, type Facts, FLAG, hourlyState, inWindow, type Install, isFlag,
  lastSlot, layers, localTime, lostMessages, parseIds, parseRecord, parseStarts, pass, type Pass, preInstall, PROBE_CHAT, PROBE_LINE,
  PROBE_REPLY, restoreBody, screenOf, shouldPing, signedFromLink, startsIn, tooManyStarts, type WatchIn,
} from "../rootfs/opt/cain/probe/core";
import { paths, recordInstall, recordStart, runPass, type PassDeps } from "../rootfs/opt/cain/probe/main";
import { act, look } from "../rootfs/opt/cain/rollback/watcher";
import { allowed, boot, type HelperDeps, jobState, keepBackup, keepSigned, removeFile, restoreStep, type Sup, takeFlag } from "../rootfs/opt/cain/rollback/helper";
import { BrokerSession } from "../rootfs/opt/cain/discord/broker";
import { INTENTS, Protocol } from "../rootfs/opt/cain/link/core";

const TZ = "America/New_York";
const T = localTime(2026, 11, 20, 10, 0, TZ);          // a Friday, 10:00 in New York
const tmp = () => mkdtempSync(join(tmpdir(), "probe-"));
const SELF = "0fcc2575_cain";
const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "rootfs/opt/cain/probe/main.ts");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

function good(now = T): Facts {
  return { now, plugin: true, tmux: true, gateway: { state: "connected", ack: now - 30 }, delivered: now - 600, slot: lastSlot(now, TZ), lost: [] };
}

describe("the liveness layers, each failing alone", () => {
  test("all up passes", () => { expect(layers(good())).toEqual([]); });
  test("the plugin's process", () => { expect(layers({ ...good(), plugin: false })).toEqual(["plugin"]); });
  test("the tmux session", () => { expect(layers({ ...good(), tmux: false })).toEqual(["tmux"]); });
  test("the gateway: down, never acknowledged, or acknowledged too long ago", () => {
    expect(layers({ ...good(), gateway: { state: "down", ack: T - 10 } })).toEqual(["gateway"]);
    expect(layers({ ...good(), gateway: null })).toEqual(["gateway"]);
    expect(layers({ ...good(), gateway: { state: "connected", ack: 0 } })).toEqual(["gateway"]);
    expect(layers({ ...good(), gateway: { state: "connected", ack: T - 181 } })).toEqual(["gateway"]);
    expect(layers({ ...good(), gateway: { state: "connected", ack: T - 180 } })).toEqual([]);
  });
  test("typed input since the last check-in over an hour old", () => {
    const slot = lastSlot(T, TZ)!;
    expect(slot).toBe(localTime(2026, 11, 20, 7, 10, TZ));
    expect(layers({ ...good(), delivered: slot - 1 })).toEqual(["input"]);
    expect(layers({ ...good(), delivered: null })).toEqual(["input"]);
    expect(layers({ ...good(), delivered: slot })).toEqual([]);
    expect(lastSlot(localTime(2026, 11, 20, 13, 0, TZ), TZ)).toBe(slot);
    expect(lastSlot(localTime(2026, 11, 21, 0, 5, TZ), TZ)).toBe(localTime(2026, 11, 20, 17, 30, TZ));
  });
  test("a lost message", () => { expect(layers({ ...good(), lost: ["123456789012345678"] })).toEqual(["messages"]); });
});

describe("the message round trip", () => {
  const A = "111111111111111111", B = "222222222222222222", C = "333333333333333333";
  test("a message the link saw that didn't reach his session within 10 minutes is lost", () => {
    const seen = parseIds(`${A} ${T - 700}\n${B} ${T - 599}\n${C} ${T - 900}\nnot-an-id 5\n`);
    const reached = parseIds(`${C} ${T - 890}\n`);
    expect(lostMessages(seen, reached, T)).toEqual([A]);                  // B is under 10 minutes old
    expect(lostMessages(seen, reached, T + 2)).toEqual([A, B]);
    expect(lostMessages(seen, reached, T, T - 650)).toEqual([]);          // seen before the probe's start
    expect(lostMessages(parseIds(`${A} ${T - 700}\n`), parseIds(`${A} ${T}\n`), T)).toEqual([]);   // reached late still counts as reached
  });
  test("the broker notes each of his messages handed to his session, never the hourly check", async () => {
    const reached: string[] = [];
    const s = new BrokerSession({ toClient: () => {}, toServer: () => {}, close: () => {}, gate: async () => ({ kind: "refuse", reason: "x" }), sent: () => {},
      readsOk: () => "", outbox: { make: () => ({ dir: "", paths: [] }), drop: () => {} }, log: () => {}, session: "t", reached: (id) => reached.push(id) });
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "hi", meta: { chat_id: "9", message_id: A } } }));
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { meta: { message_id: B } } }));
    await s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    s.probe("0000123");
    expect(reached).toEqual([A]);
  });
  test("the link sees his DMs: the gateway asks for direct messages, and hands each create over", () => {
    expect(INTENTS).toBe((1 << 13) | (1 << 12));
    const got: any[] = [];
    const p = new Protocol(() => {}, () => "t", { message: (d) => got.push(d) });
    p.handle({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: A, author: { id: "5" } } });
    expect(got.map((d) => d.id)).toEqual([A]);
    // Only the id of his own DM messages is kept, never their words (link/main.ts).
    const main = src("rootfs/opt/cain/link/main.ts");
    const fn = main.slice(main.indexOf("function seenMessage"), main.indexOf("}\n", main.indexOf("function seenMessage")));
    expect(fn).toContain("d?.guild_id");
    expect(fn).toContain("!== owner");
    expect(fn).not.toContain("content");
    expect(fn).toContain("mode: 0o600");
  });
  test("a lost message fails the probe at once and alarms that messages aren't reaching Cain", async () => {
    const dir = tmp(); world(dir);
    const { d, p, notices, pings } = passDeps(dir);
    mkdirSync(p.run, { recursive: true });
    writeFileSync(p.since, `${T - 3600}\n`);
    writeFileSync(p.seen, `${A} ${T - 700}\n`);
    const r = await runPass(d);
    expect(r.failed).toEqual(["messages"]);
    expect(pings).toEqual([]);
    expect(notices).toEqual([["tell", "messages", "1 message"]]);
    writeFileSync(p.reached, `${A} ${T + 10}\n`);
    world(dir, T + 300);
    expect((await runPass({ ...d, now: T + 300 })).ok).toBe(true);
    expect(notices.at(-1)).toEqual(["clear", "probe"]);
  });
});

describe("the hourly liveness check of his session", () => {
  test("asked only when his screen is free, hourly, never while one waits", () => {
    expect(askDue({}, T, false)).toBe(false);
    expect(askDue({}, T, true)).toBe(true);
    expect(askDue({ asked: T - 60 }, T, true)).toBe(false);
    expect(askDue({ asked: T - 3599, answered: T - 3500 }, T, true)).toBe(false);
    expect(askDue({ asked: T - 3600, answered: T - 3500 }, T, true)).toBe(true);
  });
  test("no answer within 20 minutes fails the pass", () => {
    expect(hourlyState({ asked: T - 1199 }, T)).toBe("waiting");
    expect(hourlyState({ asked: T - 1200 }, T)).toBe("timeout");
    expect(hourlyState({ asked: T - 5000, answered: T - 4900 }, T)).toBe("answered");
    const p = pass(good(), { asked: T - 1200 });
    expect(p.failed).toEqual(["answer"]);
    expect(alarmFor([p])).toBe("probe");
    expect(shouldPing(p)).toBe(false);
  });
  test("a long turn with his screen at work is not a missed answer, up to a bound", () => {
    expect(hourlyState({ asked: T - 1200 }, T, true)).toBe("waiting");
    expect(hourlyState({ asked: T - 4799 }, T, true)).toBe("waiting");
    expect(hourlyState({ asked: T - 4800 }, T, true)).toBe("timeout");     // 20 minutes and the hour's bound
    expect(pass(good(), { asked: T - 1500 }, { screen: "working" }).ok).toBe(true);
  });
  test("named as what it is", () => {
    expect(PROBE_LINE).toContain("liveness check");
    expect(src("rootfs/opt/cain/CLAUDE.md")).toContain("liveness check");
  });
});

function passDeps(dir: string, over: Partial<PassDeps> = {}) {
  const p = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), CHECKIN_DELIVERED: join(dir, "delivered"), PROBE_GATEWAY: join(dir, "gw") });
  const pings: number[] = [], notices: string[][] = [];
  const d: PassDeps = {
    p, now: T, tz: TZ, mode: "own", plugin: () => true, tmux: () => true, screen: () => "other", stopped: () => false,
    ping: async () => { pings.push(d.now); return true; }, notice: (...a) => { notices.push(a); return 0; }, ...over,
  };
  return { d, p, pings, notices };
}
function world(dir: string, now = T) {
  writeFileSync(join(dir, "delivered"), `${now - 600}\n`);
  writeFileSync(join(dir, "gw"), `connected ${now - 20}\n`);
}

describe("the probe's alarms and its outside heartbeat", () => {
  test("pinged after a pass that passed, never after one that failed; two failed passes in a row alarm", async () => {
    const dir = tmp(); world(dir);
    const { d, pings, notices } = passDeps(dir);
    expect((await runPass(d)).ok).toBe(true);
    expect(pings.length).toBe(1);
    world(dir, T + 300);
    expect((await runPass({ ...d, plugin: () => false, now: T + 300 })).ok).toBe(false);
    expect(notices).toEqual([]);                                  // one alone doesn't alarm
    world(dir, T + 600);
    expect((await runPass({ ...d, tmux: () => false, now: T + 600 })).ok).toBe(false);
    expect(notices).toEqual([["tell", "probe", "his session isn't there"]]);
    world(dir, T + 900);
    expect((await runPass({ ...d, now: T + 900 })).ok).toBe(true);
    expect(notices.at(-1)).toEqual(["clear", "probe"]);
    expect(pings.length).toBe(2);
  });
  test("the hourly ask goes to the broker, and no answer alarms without a ping", async () => {
    const dir = tmp(); world(dir);
    const { d, p, pings, notices } = passDeps(dir, { screen: () => "ready" });
    await runPass(d);
    expect(readFileSync(p.ask, "utf8").startsWith(`${T} `)).toBe(true);
    world(dir, T + 1200);
    expect((await runPass({ ...d, now: T + 1200 })).failed).toEqual(["answer"]);
    expect(pings.length).toBe(1);
    expect(notices[0][1]).toBe("probe");
  });
  test("while the owner's Stop holds: no ask and no alarm", async () => {
    const dir = tmp(); world(dir);
    const { d, p, notices } = passDeps(dir, { stopped: () => true, screen: () => "ready", plugin: () => false });
    for (const t of [T, T + 300, T + 600]) { world(dir, t); expect((await runPass({ ...d, now: t })).status).toBe("stopped"); }
    expect(notices).toEqual([]);
    expect(existsSync(p.ask)).toBe(false);
  });
  test("an unreadable Stop file silences nothing", async () => {
    const dir = tmp(); world(dir);
    const { d, notices } = passDeps(dir, { stopped: undefined, plugin: () => false });
    d.p.stop = join(dir, "no-stop.json");
    await runPass(d);
    world(dir, T + 300);
    await runPass({ ...d, now: T + 300 });
    expect(notices.map((n) => n[1])).toEqual(["probe"]);
  });
  test("a sign-in screen alarms that he needs sign-in, an API error screen that the model's API isn't answering, never as failures", async () => {
    const dir = tmp(); world(dir);
    const { d, notices } = passDeps(dir, { screen: () => "signin", tmux: () => false });
    expect((await runPass(d)).status).toBe("signin");
    expect(notices).toEqual([["tell", "needs-signin", ""]]);
    world(dir, T + 300);
    await runPass({ ...d, now: T + 300 });
    expect(notices.length).toBe(1);                                // once a stretch
    world(dir, T + 600);
    expect((await runPass({ ...d, screen: () => "api", now: T + 600 })).status).toBe("api");
    expect(notices.at(-1)).toEqual(["tell", "api-down", ""]);
    world(dir, T + 900);
    await runPass({ ...d, screen: () => "other", tmux: () => true, now: T + 900 });
    expect(notices.at(-1)).toEqual(["clear", "probe"]);
  });
  test("his screen, read", () => {
    const box = "─".repeat(20);
    expect(screenOf(`hello\n${box}\n> \n${box}\n? for shortcuts\n`, "ready")).toBe("ready");
    expect(screenOf("Thinking…\n✻ Working (12s · esc to interrupt)\n", "other")).toBe("working");
    expect(screenOf("Invalid API key · Please run /login\n", "other")).toBe("signin");
    expect(screenOf("Paste code here if prompted >\n", "other")).toBe("signin");
    expect(screenOf("⎿ API Error: 529 overloaded_error\n", "ready")).toBe("api");
    expect(screenOf("Retrying in 8 seconds… (attempt 3/10)\n✻ Working (esc to interrupt)\n", "other")).toBe("api");
    expect(screenOf("", "other")).toBe("other");
  });
  test("the old way has no broker: no hourly ask, no round trip", async () => {
    const dir = tmp(); world(dir);
    const { d, p } = passDeps(dir, { mode: "old", screen: () => "ready" });
    mkdirSync(p.run, { recursive: true });
    writeFileSync(p.seen, `111111111111111111 ${T - 9000}\n`);
    writeFileSync(p.since, `${T - 99999}\n`);
    expect((await runPass(d)).ok).toBe(true);
    expect(existsSync(p.ask)).toBe(false);
  });
});

describe("crash starts, kept in /data", () => {
  test("how the run before ended", () => {
    expect(endKind({ first: true, askedByUs: false, code: 1 })).toBe("boot");
    expect(endKind({ first: false, askedByUs: true, code: 1 })).toBe("asked");
    expect(endKind({ first: false, askedByUs: false, code: null })).toBe("unknown");
    expect(endKind({ first: false, askedByUs: false, code: 0 })).toBe("clean");
    for (const c of [129, 130, 143]) expect(endKind({ first: false, askedByUs: false, code: c })).toBe("asked");
    expect(endKind({ first: false, askedByUs: false, code: 1 })).toBe("crash-1");
    expect(endKind({ first: false, askedByUs: false, code: 137 })).toBe("crash-137");
  });
  test("only starts after a crash count; the first after a boot, restarts the App asked for and clean exits never", () => {
    const text = [`${T} boot`, `${T + 10} asked`, `${T + 20} clean`, `${T + 30} unknown`, `${T + 40} session`, `${T + 50} crash-1`, `${T + 60} crash-137`].join("\n");
    expect(parseStarts(text)).toEqual([T + 50, T + 60]);
  });
  test("a sliding 30-minute window across restarts and a reboot", () => {
    const dir = tmp();
    const notices: string[][] = [];
    const n = (...a: string[]) => { notices.push(a); return 0; };
    const p = () => paths({ PROBE_DIR: join(dir, "probe") });
    expect(recordStart(p(), T, "boot", n)).toBe(0);
    for (const [i, t] of [T + 100, T + 400, T + 800].entries()) expect(recordStart(p(), t, "crash-1", n)).toBe(i + 1);
    expect(recordStart(p(), T + 900, "asked", n)).toBe(3);         // the run script's own restart: not counted
    expect(notices).toEqual([]);
    // A new process, the same file: the fourth crash start in 30 minutes alarms.
    const b = Bun.spawnSync(["bun", MAIN, "start", "crash-139"], { env: { ...process.env, PROBE_DIR: join(dir, "probe"), PROBE_NOTICE: "/bin/true" } });
    expect(b.stdout.toString().trim()).toMatch(/^\d+ crash starts in 30 minutes$/);
    expect(readFileSync(join(dir, "probe", "starts"), "utf8").trim().split("\n").at(-1)).toMatch(/^\d+ crash-139$/);
    const dir2 = tmp(), p2 = () => paths({ PROBE_DIR: join(dir2, "probe") });
    for (const t of [T, T + 400, T + 800]) recordStart(p2(), t, "crash-1", n);
    expect(recordStart(p2(), T + 1000, "crash-1", n)).toBe(4);
    expect(notices).toEqual([["tell", "restarts", "4 crashes and starts in 30 minutes"]]);
    expect(recordStart(p2(), T + 2600, "crash-1", n)).toBe(2);
    expect(notices.at(-1)).toEqual(["clear", "restarts"]);
    // A kind that isn't one is kept as unknown, so it never counts.
    recordStart(p2(), T + 2700, "crash-1; rm -rf /", n);
    expect(readFileSync(join(dir2, "probe", "starts"), "utf8").trim().split("\n").at(-1)).toBe(`${T + 2700} unknown`);
  });
  test("the window's edges", () => {
    expect(startsIn([T - 1800, T - 1799, T - 10, T], T)).toBe(3);
    expect(tooManyStarts([T - 1799, T - 900, T - 10, T], T)).toBe(true);
    expect(tooManyStarts([T - 1800, T - 900, T - 10, T], T)).toBe(false);
  });
  test("the run script records the exit: the first start after boot, its own ends, signals and exit codes", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain("first_start=1; ended_by_us=0");
    expect(run).toContain('timeout 30 bun "$OPT/probe/main.ts" start "$(last_end)"');
    const end = run.slice(run.indexOf("end_his_session() {"), run.indexOf("end_his_session() {") + 200);
    expect(end).toContain("ended_by_us=1");
    expect(run).toContain("129|130|143) echo asked");
    expect(src("rootfs/opt/cain/session.sh")).toContain('printf \'%s\\n\' "$rc" > "$exitf"');
  });
});

describe("installs and the 24-hour window", () => {
  test("a first record opens no window; a changed version does", () => {
    const first = afterStart(null, "0.14.0", T);
    expect(first.fresh).toBe(false);
    expect(inWindow(first.install, T)).toBe(false);
    const next = afterStart(first.install, "0.14.1", T + 100);
    expect(next.install).toEqual({ id: `0.14.1@${T + 100}`, version: "0.14.1", previous: "0.14.0", at: T + 100 });
    expect(afterStart(next.install, "unknown", T + 200).install).toBe(next.install);
  });
  test("a start on the version a restore on record went back to is never a new install", () => {
    const prev: Install = { id: "x", version: "0.14.1", previous: "0.14.0", at: T };
    const r = afterStart(prev, "0.14.0", T + 500, "0.14.0");
    expect(r.fresh).toBe(false);
    expect(inWindow(r.install, T + 500)).toBe(false);
    const dir = tmp(), p = paths({ PROBE_DIR: join(dir, "probe"), ROLLBACK_RECORD: join(dir, "config", "rollback-record.json") });
    recordInstall(p, "0.14.0", T);
    recordInstall(p, "0.14.1", T + 100);
    mkdirSync(join(dir, "config"));
    writeFileSync(p.record, JSON.stringify({ format: 1, restores: [{ bad: "0.14.1", target: "0.14.0", slug: "a1b2c3d4", at: T + 200 }] }));
    expect(recordInstall(p, "0.14.0", T + 300)!.at).toBe(0);
  });
  test("the edges: from the install up to, not including, 24 hours on", () => {
    const i: Install = { id: "x", version: "0.14.1", previous: "0.14.0", at: T };
    expect(inWindow(i, T - 1)).toBe(false);
    expect(inWindow(i, T)).toBe(true);
    expect(inWindow(i, T + 86399)).toBe(true);
    expect(inWindow(i, T + 86400)).toBe(false);
  });
});

const INSTALL: Install = { id: `0.14.1@${T}`, version: "0.14.1", previous: "0.14.0", at: T };
const BACKUP: Backup = { slug: "a1b2c3d4", date: T - 120, addons: [SELF], homeassistant: false, folders: [], version: "0.14.0" };
const LOOP = [T + 3000, T + 3100, T + 3200, T + 3300];
function w(over: Partial<WatchIn> = {}): WatchIn {
  return { now: T + 3600, install: INSTALL, starts: LOOP, signed: { "0.14.0": {} }, backup: BACKUP, rollback: null, bad: [], lastRestore: null, drill: null, ...over };
}

describe("the rollback decision", () => {
  test("only a crash loop since the install arms it", () => {
    expect(decide(w())).toMatchObject({ do: "rollback", slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", install: INSTALL.id });
    expect(decide(w({ starts: LOOP.slice(1) })).do).toBe("none");
    expect(decide(w({ starts: [T - 300, T - 200, T - 100, T + 100] })).do).toBe("none");   // crashes before the install
  });
  test("a failed probe, a missed hourly answer, lost input, a lost message or a network loss never roll back", () => {
    // decide() reads no probe pass at all: whatever the probe saw, only crash starts count.
    expect(decide(w({ starts: [] }))).toEqual({ do: "none", why: "no crash loop" });
    expect(Object.keys(w())).not.toContain("passes");
  });
  test("only within 24 hours of the install", () => {
    const late = [T + 86000, T + 86100, T + 86200, T + 86300];
    expect(decide(w({ now: T + 86399, starts: late })).do).toBe("rollback");
    expect(decide(w({ now: T + 86400, starts: late })).do).toBe("none");
    expect(decide(w({ install: { ...INSTALL, at: 0 } })).do).toBe("none");
  });
  test("refused for a version not installed from a signed Ship, with no pre-install backup, or after one", () => {
    expect(decide(w({ signed: { "0.13.9": {} } }))).toMatchObject({ do: "alarm", code: "unsigned" });
    expect(decide(w({ backup: null }))).toMatchObject({ do: "alarm", code: "no-backup" });
    expect(decide(w({ lastRestore: T + 100 }))).toMatchObject({ do: "alarm", code: "again" });
  });
  test("never the same bad version twice", () => {
    expect(decide(w({ bad: ["0.14.1"] }))).toMatchObject({ do: "alarm", code: "again" });
    expect(decide(w({ bad: ["0.13.2"] })).do).toBe("rollback");
  });
  test("one per install, and a drill holds it back", () => {
    const rb = { install: INSTALL.id, at: T, slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", why: "x", state: "disarmed" as const, tries: 0 };
    expect(decide(w({ rollback: rb })).do).toBe("none");
    expect(decide(w({ drill: T + 3000 })).do).toBe("none");
    expect(decide(w({ drill: T + 3600 - 45 * 60 })).do).toBe("rollback");
  });
});

describe("root's records", () => {
  test("signed Ships come from landed Ship cards that carried a token", () => {
    const state = { messages: {
      a: { kind: "ship", ship: { pr: "u", head: "a".repeat(40) }, shipping: { state: "landed", at: 5, text: "Ship Cain 0.14.0 and Harness 0.30.1?\nmore", line: "Shipped: in main. Installing it is next." } },
      b: { kind: "ship", shipping: { state: "landed", at: 6, text: "Ship Cain 0.14.2?", line: "Installing it needs your tap again." } },
      c: { kind: "ship", shipping: { state: "not landed", at: 7, text: "Ship Cain 0.14.3?", line: "Installing it is next." } },
    } };
    expect(Object.keys(signedFromLink(state))).toEqual(["0.14.0"]);
  });
  test("the pre-install backup: this App alone, the version before, from just before the install", () => {
    const list: Backup[] = [BACKUP, { ...BACKUP, slug: "00000002", date: T - 60, addons: [SELF, "other"] },
      { ...BACKUP, slug: "00000003", date: T - 50, homeassistant: true }, { ...BACKUP, slug: "00000004", date: T + 60 }];
    expect(preInstall(list, SELF, INSTALL)!.slug).toBe("a1b2c3d4");
    expect(preInstall(list, SELF, { ...INSTALL, previous: null })).toBeNull();
  });
  test("the record of restores parses or is damaged", () => {
    expect(parseRecord(null)).toEqual({ format: 1, restores: [] });
    expect(parseRecord("{")).toBe("damaged");
    expect(parseRecord(JSON.stringify({ format: 2, restores: [] }))).toBe("damaged");
    expect(parseRecord(JSON.stringify({ format: 1, restores: [{ bad: 1 }] }))).toBe("damaged");
  });
});

// A Supervisor that answers as told, noting every call.
function fakeSup(over: Partial<Record<string, (body?: any) => { ok: boolean; data?: any; message?: string }>> = {}, version = "0.14.1") {
  const calls: string[] = [];
  const sup: Sup = {
    async call(method, path, body) {
      calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
      if (!allowed(method, path)) return { ok: false, message: "not a request this helper makes" };
      const f = over[`${method} ${path}`];
      if (f) return f(body);
      if (path === "/addons/self/info") return { ok: true, data: { slug: SELF, version } };
      if (path === "/backups") return { ok: true, data: { backups: [
        { slug: "a1b2c3d4", date: new Date((T - 120) * 1000).toISOString(), content: { homeassistant: false, addons: [SELF], folders: [] } },
        { slug: "00000001", date: new Date((T - 86400 * 3) * 1000).toISOString(), content: { homeassistant: false, addons: [SELF], folders: [] } },
        { slug: "0000000f", date: new Date((T - 86400) * 1000).toISOString(), content: { homeassistant: true, addons: [SELF], folders: ["share"] } },
      ] } };
      if (path === "/backups/a1b2c3d4/info") return { ok: true, data: { addons: [{ slug: SELF, version: "0.14.0" }] } };
      if (path === "/backups/00000001/info") return { ok: true, data: { addons: [{ slug: SELF, version: "0.13.5" }] } };
      if (path.endsWith("/restore/partial")) return { ok: true, data: { job_id: "0123456789abcdef0123456789abcdef" } };
      if (path.startsWith("/jobs/")) return { ok: true, data: { done: true, errors: [] } };
      return { ok: false, message: "no such thing" };
    },
  };
  return { sup, calls };
}
function helper(dir: string, sup: Sup, o: { now?: number; armed?: boolean; flush?: number } = {}) {
  const notices: string[][] = [], relayed: string[] = [], logs: string[] = [];
  const d: HelperDeps = {
    dir: join(dir, "probe"), watcher: join(dir, "watcher"), linkState: join(dir, "state.json"), record: join(dir, "config", "rollback-record.json"),
    now: o.now ?? T + 3600, armed: o.armed ?? false, sup,
    readAsWatch: (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } }, removeAsWatch: removeFile,
    notice: (...a) => { notices.push(a); return a[0] === "flush" ? o.flush ?? 0 : 0; }, relay: (l) => relayed.push(l), log: (m) => logs.push(m),
  };
  return { d, notices, relayed, logs };
}
function setup(dir: string, signed = true) {
  mkdirSync(join(dir, "probe"), { recursive: true });
  mkdirSync(join(dir, "watcher"), { recursive: true });
  writeFileSync(join(dir, "probe", "install.json"), JSON.stringify(INSTALL));
  writeFileSync(join(dir, "probe", "starts"), LOOP.map((t) => `${t} crash-1`).join("\n") + "\n");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ messages: signed ? { a: { kind: "ship", shipping: { state: "landed", at: 1, text: "Ship Cain 0.14.0?", line: "Installing it is next." } } } : {} }));
}
const record = (dir: string) => JSON.parse(readFileSync(join(dir, "config", "rollback-record.json"), "utf8"));
const restores = (calls: string[]) => calls.filter((c) => c.includes("/restore/"));

describe("the helper", () => {
  test("never deletes a backup: no DELETE in the code, and the Supervisor wrapper refuses one", () => {
    for (const f of ["rootfs/opt/cain/rollback/helper.ts", "rootfs/opt/cain/probe/core.ts", "rootfs/opt/cain/probe/main.ts", "tools/probe-drill.sh"])
      expect(src(f)).not.toMatch(/"DELETE"|-X DELETE|backups remove|backups rm/);
    expect(allowed("DELETE", "/backups/a1b2c3d4")).toBe(false);
    expect(allowed("POST", "/backups/a1b2c3d4/restore/full")).toBe(false);
    expect(allowed("POST", "/backups/new/partial")).toBe(false);
    expect(allowed("POST", "/backups/a1b2c3d4/restore/partial")).toBe(true);
  });
  test("an install is checked at once for its pre-install backup; none there alarms rollback unavailable right away", async () => {
    const dir = tmp(); setup(dir);
    const none = fakeSup({ "GET /backups/a1b2c3d4/info": () => ({ ok: true, data: { addons: [{ slug: SELF, version: "0.13.9" }] } }) });
    const h = helper(dir, none.sup, { now: T + 30 });
    expect(await keepBackup(h.d)).toBeNull();
    expect(h.notices).toEqual([["tell", "rollback-unavailable", "no backup of Cain 0.14.0 from just before the update to 0.14.1"]]);
    await keepBackup(h.d);
    expect(h.notices.length).toBe(1);                              // once per install
    const found = fakeSup();
    const h2 = helper(dir, found.sup, { now: T + 700 });
    expect((await keepBackup(h2.d))!.slug).toBe("a1b2c3d4");
    expect(h2.notices).toEqual([["clear", "backup"]]);
    expect(found.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });
  test("switch off (the default): a rollback that would have run alarms on both routes and does nothing", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup);
    keepSigned(h.d); await keepBackup(h.d);
    expect(act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"))).toContain("a rollback is due");
    expect(await takeFlag(h.d)).toBe("disarmed");
    expect(h.notices).toEqual([["tell", "rollback-disarmed", expect.stringContaining("from 0.14.1 back to 0.14.0")]]);
    expect(restores(calls)).toEqual([]);
    expect(existsSync(join(dir, "config", "rollback-record.json"))).toBe(false);
    // Once for the install.
    act(look(T + 3660, join(dir, "probe")), join(dir, "watcher"));
    expect(await takeFlag({ ...h.d, now: T + 3660 })).toBeNull();
    expect(h.notices.length).toBe(1);
    expect(await restoreStep(h.d)).toBeNull();
  });
  test("armed: the alarm flushed on both routes first, then the record, then the restore with the fixed body", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"));
    expect(await takeFlag(h.d)).toBe("restoring");
    expect(h.notices[0]).toEqual(["flush", "rollback", expect.stringContaining("from 0.14.1 back to 0.14.0")]);
    expect(restores(calls)).toEqual([`POST /backups/a1b2c3d4/restore/partial {"addons":["${SELF}"],"background":true}`]);
    expect(record(dir)).toEqual({ format: 1, restores: [{ bad: "0.14.1", target: "0.14.0", slug: "a1b2c3d4", at: T + 3600, why: expect.stringContaining("crashed"), job: "0123456789abcdef0123456789abcdef" }] });
    expect(JSON.parse(readFileSync(join(dir, "probe", "restores.json"), "utf8")).bad).toEqual(["0.14.1"]);
    // One per install.
    act(look(T + 3700, join(dir, "probe")), join(dir, "watcher"));
    expect(await takeFlag({ ...h.d, now: T + 3700 })).toBeNull();
    expect(restores(calls).length).toBe(1);
  });
  test("armed, with the alarm not through on both routes: no record and no restore, tried again", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true, flush: 3 });
    keepSigned(h.d); await keepBackup(h.d);
    act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"));
    expect(await takeFlag(h.d)).toBe("waiting: alarms not through");
    expect(restores(calls)).toEqual([]);
    expect(existsSync(join(dir, "config", "rollback-record.json"))).toBe(false);
    const ok = helper(dir, sup, { armed: true });
    expect(await restoreStep(ok.d)).toBe("restoring");
  });
  test("armed: a failed probe, a missed answer, a lost message or a network loss never restore", async () => {
    const dir = tmp(); setup(dir);
    writeFileSync(join(dir, "probe", "starts"), `${T + 100} boot\n${T + 200} asked\n${T + 300} asked\n${T + 400} unknown\n${T + 500} clean\n`);
    writeFileSync(join(dir, "probe", "passes.jsonl"), [T + 3300, T + 3600].map((at) => JSON.stringify({ at, ok: false, failed: ["plugin", "gateway", "input", "messages", "answer"], hourly: "timeout", status: "failed" })).join("\n"));
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    expect(act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"))).toBe("no crash loop");
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);           // a flag raised anyway
    expect(await takeFlag(h.d)).toBeNull();
    expect(restores(calls)).toEqual([]);
  });
  test("the flag is all it takes from the watcher: a request with changed or extra fields is refused", async () => {
    expect(isFlag("look\n")).toBe(true);
    for (const bad of ["look", "look\n\n", "look\nslug=deadbeef\n", "rollback\n", JSON.stringify({ install: INSTALL.id, slug: "deadbeef", restore: "0.13.0", undo: "0.14.1", why: "x" }), "LOOK\n", " look\n"]) {
      expect(isFlag(bad)).toBe(false);
      const dir = tmp(); setup(dir);
      const { sup, calls } = fakeSup();
      const h = helper(dir, sup, { armed: true });
      keepSigned(h.d); await keepBackup(h.d);
      writeFileSync(join(dir, "watcher", "request"), bad);
      expect(await takeFlag(h.d)).toBe("refused: not the flag");
      expect(restores(calls)).toEqual([]);
    }
  });
  test("whatever the watcher's folder holds, the restore names root's recorded backup and this App alone", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "watcher", "backup.json"), JSON.stringify({ slug: "deadbeef" }));
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    await takeFlag(h.d);
    const body = JSON.parse(restores(calls)[0].split(" ").slice(2).join(" "));
    expect(body).toEqual(restoreBody(SELF));
    expect(Object.keys(body).sort()).toEqual(["addons", "background"]);
    expect(restores(calls)[0]).toContain("/backups/a1b2c3d4/");
  });
  test("three Supervisor refusals in a row, then the alarm with the reason, and no more tries", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup({ "POST /backups/a1b2c3d4/restore/partial": () => ({ ok: false, message: "Backup is busy" }) });
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    expect(await takeFlag(h.d)).toBe("refused 1");
    expect(await restoreStep(h.d)).toBe("refused 2");
    expect(await restoreStep(h.d)).toBe("refused");
    expect(await restoreStep(h.d)).toBeNull();
    expect(restores(calls).length).toBe(3);
    expect(h.notices.at(-1)).toEqual(["tell", "rollback-failed", "the Supervisor refused it 3 times: Backup is busy"]);
    expect(record(dir).restores.every((r: any) => r.outcome === "not run")).toBe(true);
  });
  test("an unsigned version: the alarm once, and no restore", async () => {
    const dir = tmp(); setup(dir, false);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    expect(await takeFlag(h.d)).toBe("rollback-unsigned");
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    expect(await takeFlag(h.d)).toBeNull();
    expect(h.notices.length).toBe(1);
    expect(restores(calls)).toEqual([]);
  });
  test("a version rolled back before is refused when it comes back", async () => {
    const dir = tmp(); setup(dir);
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "rollback-record.json"), JSON.stringify({ format: 1, restores: [{ bad: "0.14.1", target: "0.14.0", slug: "a1b2c3d4", at: T - 5 * 86400, outcome: "done", reported: true }] }));
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    expect(await takeFlag(h.d)).toBe("rollback-again");
    expect(restores(calls)).toEqual([]);
  });
  test("a damaged record refuses any rollback and alarms", async () => {
    const dir = tmp(); setup(dir);
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "rollback-record.json"), "{not json");
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup, { armed: true });
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "watcher", "request"), `${FLAG}\n`);
    expect(await takeFlag(h.d)).toBe("refused: the record can't be read");
    expect(h.notices.at(-1)).toEqual(["tell", "rollback-record", ""]);
    expect(restores(calls)).toEqual([]);
  });
});

describe("the next start reads the record, not the clock", () => {
  function recorded(dir: string, extra: object = {}) {
    setup(dir);
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "rollback-record.json"), JSON.stringify({ format: 1, restores: [{ bad: "0.14.1", target: "0.14.0", slug: "a1b2c3d4", at: T + 3600, why: "it kept crashing", job: "0123456789abcdef0123456789abcdef", ...extra }] }));
  }
  test("running the target and the job done: the restore happened; Cain is told, and the morning says it once", async () => {
    const dir = tmp(); recorded(dir);
    const { sup } = fakeSup({}, "0.14.0");
    const h = helper(dir, sup, { now: T + 4000 });
    expect(await boot(h.d)).toBe("done");
    expect(record(dir).restores[0].outcome).toBe("done");
    expect(h.relayed[0]).toContain("rolled back to Cain 0.14.0 from 0.14.1");
    expect(h.notices.filter((n) => n[1] === "rollback-failed")).toEqual([]);
    const env = { ...process.env, PROBE_DIR: join(dir, "probe"), ROLLBACK_RECORD: join(dir, "config", "rollback-record.json") };
    expect(Bun.spawnSync(["bun", MAIN, "lines", "morning"], { env }).stdout.toString()).toContain("Moving section");
    expect(Bun.spawnSync(["bun", MAIN, "lines", "morning"], { env }).stdout.toString()).toBe("");
  });
  test("the job failed, or its state is unknown: an alarm", async () => {
    for (const [job, want] of [[{ ok: true, data: { done: true, errors: [{ message: "x" }] } }, "failed"], [{ ok: false, message: "forbidden" }, "unknown"], [{ ok: true, data: { done: false } }, "unknown"]] as const) {
      const dir = tmp(); recorded(dir);
      const { sup } = fakeSup({ "GET /jobs/0123456789abcdef0123456789abcdef": () => job as any }, "0.14.0");
      const h = helper(dir, sup, { now: T + 4000 });
      expect(await boot(h.d)).toBe(want);
      expect(h.notices.find((n) => n[1] === "rollback-failed")).toBeTruthy();
    }
    expect(await jobState(fakeSup().sup, "not-a-job")).toBe("unknown");
  });
  test("still on the bad version: the restore didn't happen, an alarm", async () => {
    const dir = tmp(); recorded(dir);
    const { sup } = fakeSup({}, "0.14.1");
    const h = helper(dir, sup, { now: T + 4000 });
    expect(await boot(h.d)).toBe("not run");
    expect(h.notices.find((n) => n[1] === "rollback-failed")![2]).toContain("still on 0.14.1");
  });
  test("a drill's restore is settled but never marks a version bad or reaches the morning", async () => {
    const dir = tmp(); recorded(dir, { bad: "0.14.0", target: "0.14.0", drill: true });
    const { sup } = fakeSup({}, "0.14.0");
    const h = helper(dir, sup, { now: T + 4000 });
    expect(await boot(h.d)).toBe("done");
    expect(h.relayed).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "probe", "restores.json"), "utf8"))).toEqual({ bad: [], last: null });
  });
  test("no timing heuristic is left", () => {
    expect(src("rootfs/opt/cain/probe/core.ts")).not.toContain("restoredFrom");
    expect(src("rootfs/opt/cain/rollback/helper.ts")).not.toContain("rolled-back.json");
  });
});

describe("the broker's hourly liveness check", () => {
  function session() {
    const toClient: any[] = [], toServer: any[] = [];
    let answered = 0;
    const s = new BrokerSession({
      toClient: (l) => toClient.push(JSON.parse(l)), toServer: (l) => toServer.push(JSON.parse(l)), close: () => {},
      gate: async () => ({ kind: "refuse", reason: "the gate would refuse a chat that isn't his DM" }), sent: () => {}, readsOk: () => "only his DM",
      outbox: { make: () => ({ dir: "", paths: [] }), drop: () => {} }, log: () => {}, session: "t", probeAnswered: () => { answered++; },
    });
    return { s, toClient, toServer, answered: () => answered };
  }
  test("handed only after Claude Code's initialize, as a message of his channel", async () => {
    const t = session();
    expect(t.s.probe("0000123")).toBe(false);
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    expect(t.s.probe("0000123")).toBe(true);
    expect(t.toClient.at(-1).params.content).toBe(PROBE_LINE);
    expect(t.toClient.at(-1).params.meta.chat_id).toBe(PROBE_CHAT);
  });
  test("the fixed answer is taken here and never sent on; anything else to that chat is refused", async () => {
    const t = session();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { chat_id: PROBE_CHAT, text: PROBE_REPLY } } }));
    expect(t.answered()).toBe(1);
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reply", arguments: { chat_id: PROBE_CHAT, text: "something else" } } }));
    expect(t.toClient.at(-1).result.isError).toBe(true);
    expect(t.answered()).toBe(1);
    expect(t.toServer.filter((m) => m.method === "tools/call")).toEqual([]);
  });
});

describe("notice.sh", () => {
  const NOTICE = join(ROOT, "rootfs/opt/cain/notice.sh");
  test("each new alarm has a title and a text with no em dash; the probe's say they are liveness", () => {
    for (const k of ["probe", "messages", "needs-signin", "api-down", "restarts", "rollback", "rollback-disarmed", "rollback-failed", "rollback-again",
      "rollback-unsigned", "rollback-nobackup", "rollback-record", "rollback-unavailable"]) {
      const r = Bun.spawnSync(["bash", NOTICE, "text", k, "a cause"]);
      expect(r.exitCode).toBe(0);
      const [title, msg] = r.stdout.toString().split("\n");
      expect(title.length).toBeGreaterThan(5);
      expect(msg).not.toContain("—");
    }
    const t = (k: string) => Bun.spawnSync(["bash", NOTICE, "text", k, ""]).stdout.toString();
    expect(t("probe")).toContain("liveness checks");
    expect(t("probe")).toContain("not that he answers you");
    expect(t("messages")).toContain("Messages aren't reaching Cain");
    expect(t("needs-signin")).toContain("Cain needs sign-in");
    expect(t("api-down")).toContain("The model's API isn't answering");
    expect(t("rollback-disarmed")).toContain("A rollback would have run");
    expect(t("rollback-unavailable")).toContain("rollback is unavailable");
    expect(t("rollback-unavailable")).toContain("Backup before update");
    expect(t("rollback")).toContain("outside heartbeat check for him stays silent after that, the restore itself failed");
  });
  test("flush answers 0 only once Discord and Home Assistant both took the alarm", async () => {
    const dir = tmp();
    const opt = join(dir, "opt");
    mkdirSync(opt);
    writeFileSync(join(opt, "alert.sh"), "#!/bin/bash\nexit 0\n"); chmodSync(join(opt, "alert.sh"), 0o755);
    const hooked: string[] = [];
    const server = Bun.serve({ port: 0, fetch: async (r) => { hooked.push(new URL(r.url).pathname); return new Response("ok"); } });
    const run = async (opts: object) => {
      writeFileSync(join(dir, "options.json"), JSON.stringify(opts));
      const p = Bun.spawn(["bash", NOTICE, "flush", "rollback", "from 0.14.1 back to 0.14.0"], { env: { ...process.env, NOTICE_DATA: join(dir, "data"), NOTICE_OPT: opt,
        NOTICE_OPTIONS: join(dir, "options.json"), NOTICE_DIR: join(dir, "notice.d"), NOTICE_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
      return await p.exited;
    };
    try {
      expect(await run({})).toBe(3);                                       // no hook: Home Assistant can't have it
      expect(await run({ notice_hook: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" })).toBe(0);
      expect(hooked.at(-1)).toBe("/api/webhook/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    } finally { server.stop(true); }
  });
});

describe("the boundary", () => {
  test("/run/cain is root's, and his group may pass through it but not list it; what root keeps there is root's alone", () => {
    const lock = src("rootfs/opt/cain/c1/lock.sh");
    expect(lock).toContain("install -d -m 0710 -o root -g cain /run/cain ");
    expect(lock).not.toMatch(/install -d -m 07[5-7]\d -o root -g cain \/run\/cain \|\|/);
    expect(lock).toContain("install -d -m 0700 -o root -g root /run/cain/probe");
    expect(lock).toContain('install -d -m 0750 -o root -g watch "$D/probe"');
    expect(lock).toContain('install -d -m 0700 -o watch -g watch "$D/watcher"');
    expect(lock).toMatch(/chown root:root "\$\{C1_CONFIG:-\/config\}" && chmod 0700/);
    // The gateway state and the round trip's notes: root's, 0600, inside root's folders.
    expect(src("rootfs/opt/cain/link/main.ts")).toContain('writeFileSync(`${GATEWAY_STATE}.tmp`, `${connected ? "connected" : "down"} ${Math.floor(proto.lastAck / 1000)}\\n`, { mode: 0o600 })');
    expect(src("rootfs/opt/cain/discord/broker-main.ts")).toContain("appendFileSync(file, `${id} ${now}\\n`, { mode: 0o600 })");
    // uid 1000 may read nothing of those (the start's own check, c1/contract.ts ROOT_FOR_HIM).
    const contract = src("rootfs/opt/cain/c1/contract.ts");
    const allowList = contract.slice(contract.indexOf("const ROOT_FOR_HIM"), contract.indexOf("];", contract.indexOf("const ROOT_FOR_HIM")));
    expect(allowList).not.toMatch(/probe|gateway|config|watcher/);
  });
  test("neither the Supervisor token nor the probe URL reaches a command line or a log", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    const unset = run.indexOf("unset HEARTBEAT_URL PROBE_PING_URL");
    expect(unset).toBeGreaterThan(0);
    for (const child of ["tmux -u new-session", "link/main.ts", "checkin.sh", "probe/main.ts", "rollback/watcher.ts", "rollback/helper.ts"]) expect(unset).toBeLessThan(run.indexOf(child));
    expect(run.split("PROBE_PING_URL=").length).toBe(2);
    const at = run.indexOf("PROBE_PING_URL=");
    expect(run.slice(at, run.indexOf(") &", at))).toContain('bun "$OPT/probe/main.ts" loop');
    expect(run).not.toMatch(/echo[^\n]*PROBE_PING_URL|log[^\n]*PROBE_PING_URL/);
    expect(run).toContain('"$OPT/as-watch" bun "$OPT/rollback/watcher.ts" loop');
    // The probe: the URL leaves the environment at once, is sent by fetch, and no child gets it.
    const main = src("rootfs/opt/cain/probe/main.ts");
    expect(main).toContain("delete env.PROBE_PING_URL");
    expect(main.match(/Bun\.spawnSync\(/g)!.length).toBe(main.match(/PROBE_PING_URL: _drop/g)!.length);
    expect(main).not.toMatch(/log\([^)]*\$\{url|console\.[a-z]+\([^)]*\$\{url/);
    // The helper: the token read from root's file for each call, sent only as a fetch header.
    const helperSrc = src("rootfs/opt/cain/rollback/helper.ts");
    expect(helperSrc).not.toMatch(/spawn[^\n]*token|log\([^)]*token\b/i);
    expect(helperSrc).toContain("authorization: `Bearer ${token}`");
    // The drill: never reads or prints either.
    const drill = src("tools/probe-drill.sh");
    expect(drill).not.toMatch(/HASSIO_TOKEN|PROBE_PING_URL|probe_heartbeat_url|options\.json/);
    // The token's file is named once, as a path uid 1000 must fail to read, and what is read goes nowhere.
    const tokenLines = drill.split("\n").filter((l) => l.includes("SUPERVISOR_TOKEN") && !l.trimStart().startsWith("#"));
    expect(tokenLines.length).toBe(1);
    expect(tokenLines[0]).toMatch(/^\s+for f in /);
    expect(drill).toContain(`as_cain sh -c "head -c 1 '$f' >/dev/null 2>&1"`);
    expect(drill).not.toMatch(/curl[^\n]*[Aa]uthorization/);
  });
  test("the switch is root's and off by default; the helper alone reads it", () => {
    const cfg = readFileSync(join(ROOT, "config.yaml"), "utf8");
    expect(cfg).toContain("  rollback_armed: false\n");
    expect(cfg).toContain("  rollback_armed: bool\n");
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run.split("rollback_armed").length - 1).toBeGreaterThanOrEqual(1);
    const at = run.indexOf("bashio::config 'rollback_armed'");
    expect(run.slice(at, run.indexOf(") &", at))).toContain('bun "$OPT/rollback/helper.ts" loop');
  });
});

describe("the drill", () => {
  test("six numbered steps, and the switch only after all six pass", () => {
    const drill = src("tools/probe-drill.sh");
    for (const n of [1, 2, 3, 4, 5, 6]) expect(drill).toMatch(new RegExp(`^  ${n}\\)`, "m"));
    expect(drill).toContain("docker exec -u 1000");
    const docs = src("DOCS.md");
    expect(docs).toContain("rollback_armed");
    expect(docs).toMatch(/only after all six/);
  });
});
