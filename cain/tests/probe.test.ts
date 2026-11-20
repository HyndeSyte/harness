// Cain 0.14.0: the probe (liveness, the hourly liveness check), the counts kept in /data (early exits
// and late error exits of his session, starts of his App's container) and their alarms. Alarms only:
// no restore code ships, no Supervisor access, no map and no switch in config.yaml.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterStart, ago, alarmFor, askDue, bootKind, endKind, exitCause, type Facts, hourlyState, inWindow, type Install,
  lastCode, lastSlot, layers, localTime, logLine, parseBoots, parseSelf, parseStarts, parseUnseen, pass, PROBE_CHAT, PROBE_LINE,
  PROBE_REPLY, screenOf, shouldPing, startsIn, tooManyBoots, tooManySelf, tooManyStarts, tooManyUnseen, unseenCount,
} from "../rootfs/opt/cain/probe/core";
import {
  classify, markAsked, markGone, paths, recordBoot, recordInstall, recordStart, runPass, sessionLogLine, sessionStart, stopAsked, stopFinish, takeStopMark,
  writeWhole, type PassDeps,
} from "../rootfs/opt/cain/probe/main";
import { aboveWhy, folderWhy } from "../rootfs/opt/cain/probe/folder";
import { chmodSync, linkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { BrokerSession } from "../rootfs/opt/cain/discord/broker";
import { INTENTS } from "../rootfs/opt/cain/link/core";

const TZ = "America/New_York";
const T = localTime(2026, 11, 20, 10, 0, TZ);          // a Friday, 10:00 in New York
const tmp = () => mkdtempSync(join(tmpdir(), "probe-"));
// Start ids of the run script (one per start of it).
const S1 = "1111111111111111", S2 = "2222222222222222", S3 = "3333333333333333";
const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "rootfs/opt/cain/probe/main.ts");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

function good(now = T): Facts {
  return { now, plugin: true, tmux: true, gateway: { state: "connected", ack: now - 30 }, delivered: now - 600, slot: lastSlot(now, TZ) };
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
});

describe("no second Discord connection, no message text", () => {
  test("the link's gateway asks for reactions only, and keeps no message ids", () => {
    expect(INTENTS).toBe(1 << 13);
    const main = src("rootfs/opt/cain/link/main.ts");
    expect(main).not.toContain("seenMessage");
    expect(main).not.toContain("MESSAGE_CREATE");
    expect(src("rootfs/opt/cain/link/core.ts")).not.toContain("MESSAGE_CREATE");
    for (const f of ["rootfs/opt/cain/discord/broker.ts", "rootfs/opt/cain/discord/broker-main.ts", "rootfs/opt/cain/probe/main.ts", "rootfs/opt/cain/probe/core.ts"]) {
      expect(src(f)).not.toMatch(/reached|probe\/seen|lostMessages|parseIds/);
    }
  });
  test("the broker notes nothing of his messages", () => {
    const notes: string[] = [];
    const s = new BrokerSession({ toClient: () => {}, toServer: () => {}, close: () => {}, gate: async () => ({ kind: "refuse", reason: "x" }), sent: () => {},
      readsOk: () => "", outbox: { make: () => ({ dir: "", paths: [] }), drop: () => {} }, log: (m) => notes.push(m), session: "t" });
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "hi", meta: { chat_id: "9", message_id: "111111111111111111" } } }));
    expect(notes.join(" ")).not.toContain("111111111111111111");
  });
  test("the messages alarm is gone", () => {
    const r = Bun.spawnSync(["bash", join(ROOT, "rootfs/opt/cain/notice.sh"), "text", "messages", ""]);
    expect(r.exitCode).toBe(2);
    expect(src("rootfs/opt/cain/notice.sh")).not.toContain("Messages aren't reaching Cain");
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
    p, now: T, tz: TZ, mode: "own", plugin: () => true, tmux: () => true, screen: () => "other",
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
  test("only the App's own stopped mode (mode none) silences the alarm and the ask", async () => {
    const dir = tmp(); world(dir);
    const { d, p, pings, notices } = passDeps(dir, { mode: "none", screen: () => "ready", plugin: () => false });
    for (const t of [T, T + 300, T + 600]) { world(dir, t); expect((await runPass({ ...d, now: t })).status).toBe("stopped"); }
    expect(notices).toEqual([]);
    expect(pings).toEqual([]);
    expect(existsSync(p.ask)).toBe(false);
  });
  test("the owner's Stop doesn't touch the probe: it reads no stop.json, and his session's failures alarm as usual", async () => {
    const main = src("rootfs/opt/cain/probe/main.ts"), core = src("rootfs/opt/cain/probe/core.ts");
    for (const f of [main, core]) expect(f).not.toMatch(/readStop|stop\.json"|d\.stopped|o\.stopped/);
    expect(main).not.toContain('from "../stop"');
    const dir = tmp(); world(dir);
    const { d, notices } = passDeps(dir, { plugin: () => false });
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
  test("the old way has no broker: no hourly ask", async () => {
    const dir = tmp(); world(dir);
    const { d, p } = passDeps(dir, { mode: "old", screen: () => "ready" });
    expect((await runPass(d)).ok).toBe(true);
    expect(existsSync(p.ask)).toBe(false);
  });
});

describe("the hourly liveness line waits for a turn and for the owner", () => {
  test("not while a turn is at work, nor within 5 minutes of a message of the owner's; asked at the next pass", () => {
    expect(askDue({}, T, false)).toBe(false);                          // a turn at work: his screen isn't free
    expect(askDue({}, T, true, T - 299)).toBe(false);                  // the owner wrote 4:59 ago
    expect(askDue({}, T, true, T - 300)).toBe(true);
    expect(askDue({}, T, true, null)).toBe(true);
  });
  test("a pass skips the ask while the owner's note is fresh, and the next pass asks", async () => {
    const dir = tmp(); world(dir);
    const { d, p } = passDeps(dir, { screen: () => "ready" });
    mkdirSync(p.run, { recursive: true, mode: 0o700 });
    writeFileSync(p.heard, `${T - 60}\n`);
    await runPass(d);
    expect(existsSync(p.ask)).toBe(false);
    world(dir, T + 300);
    await runPass({ ...d, screen: () => "working", now: T + 300 });     // a turn at work now
    expect(existsSync(p.ask)).toBe(false);
    world(dir, T + 600);
    await runPass({ ...d, now: T + 600 });
    expect(readFileSync(p.ask, "utf8").startsWith(`${T + 600} `)).toBe(true);
  });
  test("the broker notes when a message of the owner's reaches his session, and nothing of it", () => {
    const notes: string[] = [];
    let heard = 0;
    const s = new BrokerSession({ toClient: () => {}, toServer: () => {}, close: () => {}, gate: async () => ({ kind: "refuse", reason: "x" }), sent: () => {},
      readsOk: () => "", outbox: { make: () => ({ dir: "", paths: [] }), drop: () => {} }, log: (m) => notes.push(m), session: "t", heard: () => { heard++; } });
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "hi", meta: { chat_id: "9", message_id: "111111111111111111" } } }));
    s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } }));
    expect(heard).toBe(1);
    expect(notes.join(" ")).not.toContain("111111111111111111");
    const bm = src("rootfs/opt/cain/discord/broker-main.ts");
    expect(bm).toContain('heard: () => probeMark("heard")');
    expect(bm).toContain('flag: "wx"');
  });
});

describe("the probe's second heartbeat check during the owner's Stop", () => {
  test("pings go on while the owner's Stop holds: his session keeps running", async () => {
    const dir = tmp(); world(dir);
    mkdirSync(join(dir, "trust"), { recursive: true });
    writeFileSync(join(dir, "trust", "stop.json"), JSON.stringify({ stopped: true, at: T - 60 }));
    const { d, pings, notices } = passDeps(dir);
    const r = await runPass(d);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    expect(shouldPing(r)).toBe(true);
    expect(pings).toEqual([T]);
    expect(notices).toEqual([]);
  });
  test("no ping in the App's own stopped mode, even if every check passed", () => {
    const r = pass(good(), {}, { appStopped: true });
    expect(r.status).toBe("stopped");
    expect(shouldPing(r)).toBe(false);
    expect(alarmFor([r, r])).toBeNull();
  });
});

describe("the hourly line's wait is capped, and a long turn alarms once a stretch", () => {
  test("after 2 hours held back by a turn at work, the line goes in anyway", () => {
    expect(askDue({ deferred: T - 7199 }, T, false)).toBe(false);
    expect(askDue({ deferred: T - 7200 }, T, false)).toBe(true);
    expect(askDue({ deferred: T - 7200 }, T, true, T - 10)).toBe(true);           // the owner's 5 minutes too
    expect(askDue({ deferred: T - 9000, asked: T - 600 }, T, false)).toBe(false);  // one is still waiting
  });
  test("a pass: held back while he works, in at the 2-hour mark, and the long turn alarmed once, cleared when it ends", async () => {
    const dir = tmp(); world(dir);
    const { d, p, notices } = passDeps(dir, { screen: () => "working" });
    let t = T;
    for (; t < T + 7200; t += 300) { world(dir, t); await runPass({ ...d, now: t }); expect(existsSync(p.ask)).toBe(false); }
    world(dir, t);
    await runPass({ ...d, now: t });
    expect(readFileSync(p.ask, "utf8").startsWith(`${t} `)).toBe(true);
    expect(notices.filter((x) => x[0] === "tell")).toEqual([["tell", "turn-long", "120"]]);
    for (const k of [1, 2]) { world(dir, t + k * 300); await runPass({ ...d, now: t + k * 300 }); }
    expect(notices.filter((x) => x[1] === "turn-long").length).toBe(1);             // once a stretch
    world(dir, t + 900);
    await runPass({ ...d, screen: () => "ready", now: t + 900 });
    expect(notices.at(-1)).toEqual(["clear", "turn"]);
    const h = JSON.parse(readFileSync(p.hourly, "utf8"));
    expect(h.busy).toBeUndefined();
    expect(h.turnTold).toBeUndefined();
  });
  test("the local liveness layers never wait on turn activity", async () => {
    const dir = tmp(); world(dir);
    const { d, notices } = passDeps(dir, { screen: () => "working", tmux: () => false });
    expect((await runPass(d)).failed).toEqual(["tmux"]);
    world(dir, T + 300);
    await runPass({ ...d, now: T + 300 });
    expect(notices).toEqual([["tell", "probe", "his session isn't there"]]);
    expect(layers.toString()).not.toMatch(/working|screen|busy/);
  });
});

// A starts world: the probe's records and this container's marks, in a temp folder.
function startsWorld(run = "run") {
  const dir = tmp();
  const notices: string[][] = [];
  const n = (...a: string[]) => { notices.push(a); return 0; };
  const at = (r = run) => paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, r) });
  return { dir, notices, n, p: at(), at };
}
const tells = (notices: string[][]) => notices.filter((x) => x[0] === "tell").map((x) => x[1]);

describe("early exits of his session, kept in /data", () => {
  test("how the run before ended", () => {
    expect(endKind({ first: true, asked: false, code: 1, ran: 10 })).toBe("boot");
    expect(endKind({ first: false, asked: true, code: 1, ran: 10 })).toBe("asked");
    expect(endKind({ first: false, asked: true, code: 137, ran: 9000 })).toBe("asked");
    // Seen ending within 5 minutes of its start, unasked: an early exit, whatever code it kept.
    expect(endKind({ first: false, asked: false, code: null, ran: 150 })).toBe("early-unknown");
    expect(endKind({ first: false, asked: false, code: 0, ran: 150 })).toBe("early-clean");
    expect(endKind({ first: false, asked: false, code: 1, ran: 300 })).toBe("early-1");
    expect(endKind({ first: false, asked: false, code: 143, ran: 20 })).toBe("early-143");    // a signal is no proof it was asked
    // Seen ending later: exit 0 clean, no code unknown, a non-zero exit "self".
    expect(endKind({ first: false, asked: false, code: 0, ran: 301 })).toBe("clean");
    expect(endKind({ first: false, asked: false, code: null, ran: 301 })).toBe("unknown");
    expect(endKind({ first: false, asked: false, code: 137, ran: 301 })).toBe("self-137");
    // Never seen ending: "unseen", whatever the gap and whatever code (sixth round).
    expect(endKind({ first: false, asked: false, code: null, ran: 300, seen: false })).toBe("unseen");
    expect(endKind({ first: false, asked: false, code: 0, ran: 20, seen: false })).toBe("unseen");
    expect(endKind({ first: false, asked: true, code: null, ran: 20, seen: false })).toBe("asked");
    expect(endKind({ first: false, asked: false, code: 1, ran: 301, seen: false })).toBe("unseen");
    expect(endKind({ first: false, asked: false, code: 137, ran: 3600, seen: false })).toBe("unseen");
  });
  test("only early exits count toward the early-exit alarm; late error exits are counted apart", () => {
    const text = [`${T} boot`, `${T + 10} asked`, `${T + 20} clean`, `${T + 30} unknown`, `${T + 40} self-1`, `${T + 50} early-1`,
      `${T + 60} early-unknown`, `${T + 70} early-clean`].join("\n");
    expect(parseStarts(text)).toEqual([T + 50, T + 60, T + 70]);
    expect(parseSelf(text)).toEqual([T + 40]);
    expect(parseUnseen(`${text}\n${T + 80} unseen`)).toEqual([T + 80]);
  });
  test("the windows' edges", () => {
    expect(startsIn([T - 1800, T - 1799, T - 10, T], T)).toBe(3);
    expect(tooManyStarts([T - 1799, T - 900, T - 10, T], T)).toBe(true);
    expect(tooManyStarts([T - 1800, T - 900, T - 10, T], T)).toBe(false);
    expect(tooManySelf([T - 3599, T - 2000, T - 1000, T - 10, T], T)).toBe(true);
    expect(tooManySelf([T - 3600, T - 2000, T - 1000, T - 10, T], T)).toBe(false);
    expect(tooManyUnseen([T - 3599, T - 3000, T - 2000, T - 1900, T - 1850, T - 10, T], T)).toBe(true);
    expect(tooManyUnseen([T - 3000, T - 2000, T - 1900, T - 1850, T - 10, T], T)).toBe(false);
    // A tight loop: more than 3 in 30 minutes, as early exits.
    expect(tooManyUnseen([T - 1799, T - 900, T - 10, T], T)).toBe(true);
    expect(tooManyUnseen([T - 1800, T - 900, T - 10, T], T)).toBe(false);
    expect(unseenCount([T - 1799, T - 900, T - 10, T], T)).toBe("4 in 30 minutes");
    expect(unseenCount([T - 3599, T - 3000, T - 2000, T - 1900, T - 1850, T - 10, T], T)).toBe("7 in 60 minutes");
  });
  test("asked only by root's mark for that very run, matching the id the run script holds in memory", () => {
    const { p } = startsWorld();
    const n = () => 0;
    expect(markAsked(p, "")).toBe(false);                                 // no run to mark
    const first = sessionStart(p, T, null, n, "");
    expect(first.kind).toBe("boot");                                      // the first start in this container
    expect(markAsked(p, "0123456789abcdef")).toBe(false);                 // not the run the script holds
    expect(markAsked(p, first.id)).toBe(true);
    expect(classify(p, T + 60, 143, first.id)).toBe("asked");
    // The file alone isn't enough: a run script that lost its memory (s6 restarted it) can't count it
    // asked, and root never saw that end: unseen.
    expect(classify(p, T + 60, 143, "")).toBe("unseen");
    expect(classify(p, T + 60, 143, "fedcba9876543210")).toBe("unseen");
    // A mark naming another run is no mark.
    writeFileSync(p.asked, "0000000000000000\n");
    expect(classify(p, T + 60, 143, first.id)).toBe("unseen");
    // A run already seen gone can't be marked asked after the fact.
    markGone(p, T + 30, first.id);
    expect(markAsked(p, first.id)).toBe(false);
    expect(classify(p, T + 900, 1, first.id)).toBe("early-1");            // it ran 30 s, as root saw it
  });
  test("the Nov 19 shape, every end seen or none: a start every 2.5 minutes for an hour, within a day of an install, alarms", () => {
    for (const seenEvery of [true, false]) {
      const { p, notices, n } = startsWorld();
      recordInstall(p, "0.13.3", T - 86400 * 3);
      recordInstall(p, "0.13.4", T - 3 * 3600);                           // installed three hours before
      let id = sessionStart(p, T, null, n, "").id;
      const kinds: string[] = [];
      for (let i = 1; i <= 24; i++) {
        const t = T + i * 150;
        if (seenEvery) markGone(p, t - 10, id);
        // Unseen: s6 restarted the run script each time, so it holds no id and never saw the end.
        const r = sessionStart(p, t, i % 2 ? null : 0, n, seenEvery ? id : "");
        kinds.push(r.kind); id = r.id;
      }
      if (seenEvery) {
        expect(new Set(kinds)).toEqual(new Set(["early-unknown", "early-clean"]));
        expect(tells(notices)).toEqual(["restarts", "update-exits"]);     // once for the loop, not each start
      } else {
        // No exit recorded and no asked mark (the finish script suppressed): unseen, alarmed as a tight loop.
        expect(new Set(kinds)).toEqual(new Set(["unseen"]));
        expect(tells(notices)).toEqual(["unseen-loop", "update-unseen"]);
      }
      const told = notices.filter((x) => x[0] === "tell");
      expect(told[0][2]).toMatch(seenEvery ? /^4 in 30 minutes, last exit code (0|1)$/ : /^4 in 30 minutes$/);
      expect(told[1][2]).toBe("Cain 0.13.4, installed 3 hours ago");
    }
  });
  test("a single unseen end, then a start an hour later, counts nothing", () => {
    const { p, notices, n } = startsWorld();
    sessionStart(p, T, null, n, "");
    // s6 restarted the run script: no id in memory, and the end never seen.
    const r = sessionStart(p, T + 3600, 1, n, "");
    expect(r.kind).toBe("unseen");
    expect(parseStarts(readFileSync(p.starts, "utf8"))).toEqual([]);
    expect(parseSelf(readFileSync(p.starts, "utf8"))).toEqual([]);
    expect(notices).toEqual([]);
  });
  test("six late error exits, spaced 5 minutes and a second apart: never early exits, and they alarm as ending on their own", () => {
    const { p, notices, n } = startsWorld();
    recordInstall(p, "0.13.5", T - 86400);
    recordInstall(p, "0.14.0", T - 600);
    let t = T;
    let id = sessionStart(p, t, null, n, "").id;
    for (let i = 0; i < 6; i++) {
      markGone(p, t + 301, id);                                           // ended 5 minutes and a second in
      t += 301;
      const r = sessionStart(p, t, 137, n, id);
      expect(r.kind).toBe("self-137");
      id = r.id;
    }
    expect(parseStarts(readFileSync(p.starts, "utf8"))).toEqual([]);
    expect(notices).toEqual([["tell", "self-loop", "5 in 60 minutes, last exit code 137"]]);  // at the fifth, once for the stretch
    // Down once the hour's count is back under.
    recordStart(p, t + 3600, "clean", n);
    expect(notices.at(-1)).toEqual(["clear", "self"]);
  });
  test("a restart every 5 minutes 30 seconds, every end unseen: \"keeps restarting\" with the update line, and no other alarm", () => {
    const { p, notices, n } = startsWorld();
    recordInstall(p, "0.13.5", T - 86400);
    recordInstall(p, "0.14.0", T - 600);                                  // within a day of an install too
    sessionStart(p, T, null, n, "");
    const kinds: string[] = [];
    for (let i = 1; i <= 12; i++) kinds.push(sessionStart(p, T + i * 330, i % 3 ? 1 : null, n, "").kind);   // s6 restarted the run script each time
    expect(new Set(kinds)).toEqual(new Set(["unseen"]));
    // The fourth, once for the stretch (4 in 30 minutes), and within a day of an install the update line too.
    expect(notices).toEqual([["tell", "unseen-loop", "4 in 30 minutes"], ["tell", "update-unseen", "Cain 0.14.0, installed 32 minutes ago"]]);
    expect(parseStarts(readFileSync(p.starts, "utf8"))).toEqual([]);
    expect(parseSelf(readFileSync(p.starts, "utf8"))).toEqual([]);
    recordStart(p, T + 12 * 330 + 3600, "clean", n);
    expect(notices.slice(-2)).toEqual([["clear", "unseen"], ["clear", "update"]]);
  });
  test("four late error exits in an hour don't alarm", () => {
    const { p, notices, n } = startsWorld();
    for (const t of [T, T + 900, T + 1800, T + 2700]) recordStart(p, t, "self-1", n);
    expect(notices).toEqual([]);
  });
  test("a sliding window across a new process; a new loop after the last cleared names the update again", () => {
    const { dir, notices, n, at } = startsWorld();
    recordInstall(at(), "0.13.5", T - 86400 * 2);
    recordInstall(at(), "0.14.0", T - 60);
    for (const t of [T, T + 400, T + 800]) recordStart(at(), t, "early-1", n);
    expect(recordStart(at(), T + 900, "asked", n)).toBe(3);
    expect(notices).toEqual([]);
    expect(recordStart(at(), T + 1000, "early-unknown", n)).toBe(4);
    expect(tells(notices)).toEqual(["restarts", "update-exits"]);
    expect(recordStart(at(), T + 2600, "early-1", n)).toBe(2);
    expect(notices.slice(-2)).toEqual([["clear", "restarts"], ["clear", "update"]]);
    for (const t of [T + 2700, T + 2800, T + 2900]) recordStart(at(), t, "early-1", n);
    expect(tells(notices).filter((k) => k === "update-exits").length).toBe(2);     // the new loop says it again
    // A kind that isn't one is kept as unknown, so it never counts.
    recordStart(at(), T + 9000, "early-1; rm -rf /", n);
    expect(readFileSync(join(dir, "probe", "starts"), "utf8").trim().split("\n").at(-1)).toBe(`${T + 9000} unknown`);
    // A separate process on the same files, and it hands back the new run's id.
    const b = Bun.spawnSync(["bun", MAIN, "session-start", "1", ""], { env: { ...process.env, PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), PROBE_NOTICE: "/bin/true" } });
    expect(b.stdout.toString().trim()).toMatch(/^run [0-9a-f]{16} boot$/);
  });
  test("outside a day of an install, a loop says only what it measures", () => {
    const { p, notices, n } = startsWorld();
    recordInstall(p, "0.14.0", T - 86400 * 3);
    for (const t of [T, T + 100, T + 200, T + 300]) recordStart(p, t, "early-1", n);
    expect(tells(notices)).toEqual(["restarts"]);
  });
  test("during the owner's saved Stop the loop alarms still fire: they read no Stop", () => {
    const main = src("rootfs/opt/cain/probe/main.ts");
    const fns = main.slice(main.indexOf("export function recordStart"), main.indexOf("export function recordInstall"));
    expect(fns).not.toMatch(/readStop|stop\.json|d\.stopped|stopped\(/);
  });
  test("the update line's words", () => {
    expect(ago(30)).toBe("a minute");
    expect(ago(40 * 60)).toBe("40 minutes");
    expect(ago(3 * 3600 + 100)).toBe("3 hours");
  });
});

describe("stops that are asked", () => {
  test("the Supervisor's stop: root marks the run it holds asked before the session ends, and the next start says asked", () => {
    const { p, notices, n } = startsWorld();
    const r = sessionStart(p, T, null, n, "");
    expect(stopAsked(p, T + 20, r.id, S1)).toBe(true);                   // the run script's TERM trap
    expect(classify(p, T + 30, 143, r.id)).toBe("asked");
    expect(sessionStart(p, T + 30, 143, n, r.id).kind).toBe("asked");
    expect(existsSync(p.stopAsked)).toBe(true);
    expect(notices).toEqual([]);
  });
  test("an owner's stop or update from Home Assistant, again and again, never counts: neither as early exits nor as container starts", () => {
    const { notices, n, at } = startsWorld();
    recordInstall(at("c0"), "0.13.5", T - 86400 * 3);
    let t = T;
    for (let i = 0; i < 6; i++) {
      const p = at(`c${i}`);                                              // each a new container
      if (i === 3) recordInstall(p, "0.14.0", t);                         // one of them an update
      const sid = `${i}`.padStart(16, "a");                               // each start of the run script its own id
      expect(recordBoot(p, t, n, sid)).toBe(i === 0 ? "boot" : "asked");
      const r = sessionStart(p, t + 5, null, n, "");
      expect(r.kind).toBe("boot");                                        // the first start in a container
      stopAsked(p, t + 60, r.id, sid);                                    // the owner stops it within a minute
      expect(stopFinish(p, t + 61, 256, 15)).toBe(true);                  // and s6's finish script sees 256/15
      t += 120;
    }
    expect(parseBoots(readFileSync(at().boots, "utf8"))).toEqual([T]);
    expect(notices).toEqual([]);
  });
  test("the run script's TERM trap marks the stop before it dies of the signal; the finish script marks it too and doesn't halt", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain(`trap 'stop_asked; trap - TERM; kill -TERM $$' TERM`);
    expect(run).toContain('stop_asked() { timeout 6 bun "$OPT/probe/main.ts" stop-asked "${run_id:-}" "${start_id:-}"');
    expect(run.indexOf('start_id="$(od')).toBeLessThan(run.indexOf("stop_asked() {"));
    // The trap is set before anything starts his session, and the loops' waits are interruptible.
    expect(run.indexOf("trap 'stop_asked")).toBeLessThan(run.indexOf("start_his_session() {"));
    expect(run).toContain("nap() { sleep \"$1\" & wait $! 2>/dev/null || true; }");
    const loop = run.slice(run.lastIndexOf("while session_up; do"));
    expect(loop).toContain("nap 10");
    expect(loop).not.toMatch(/^\s*sleep 10$/m);
    const fin = src("rootfs/etc/services.d/cain/finish");
    const mark = fin.indexOf('probe/main.ts stop-finish "${APP_EXIT_CODE}" "${2:-}"');
    expect(mark).toBeGreaterThan(0);
    expect(fin.slice(0, mark)).toContain("if [ -e /run/cain/probe/term ]; then");
    expect(fin).not.toContain("stop-asked");
    expect(mark).toBeLessThan(fin.indexOf("halt"));
  });
  test("the run script's TERM trap, run for real: the mark is written, then the script dies of SIGTERM", async () => {
    const dir = tmp();
    const script = join(dir, "t.sh");
    writeFileSync(script, `#!/bin/bash
mark() { echo "stop-asked \${run_id:-}" > "${dir}/mark"; }
run_id=0123456789abcdef
trap 'mark; trap - TERM; kill -TERM $$' TERM
nap() { sleep "$1" & wait $! 2>/dev/null || true; }
echo up > "${dir}/up"
while true; do nap 10; done
`);
    const p = Bun.spawn(["bash", script]);
    for (let i = 0; i < 50 && !existsSync(join(dir, "up")); i++) await Bun.sleep(50);
    const t0 = Date.now();
    p.kill("SIGTERM");
    await p.exited;
    expect(Date.now() - t0).toBeLessThan(3000);                           // well inside s6's grace
    expect(p.signalCode).toBe("SIGTERM");                                 // so s6 passes 256 and 15 to finish
    expect(readFileSync(join(dir, "mark"), "utf8")).toBe("stop-asked 0123456789abcdef\n");
  });
  test("a Claude Code self-update can't end his session: the updater is off in the image and in session.sh", () => {
    expect(src("Dockerfile")).toMatch(/^ENV DISABLE_AUTOUPDATER=1$/m);
    expect(src("rootfs/opt/cain/session.sh")).toContain("DISABLE_AUTOUPDATER=1");
  });
});

describe("starts of the App's container, kept in /data", () => {
  test("counted once per container: more than 3 in 30 minutes alarms that the App keeps restarting", () => {
    const { dir, notices, n, at } = startsWorld();
    for (let i = 0; i < 3; i++) expect(recordBoot(at(`c${i}`), T + i * 300, n)).toBe("boot");
    expect(recordBoot(at("c2"), T + 700, n)).toBeNull();                 // the run script again, same container
    expect(notices).toEqual([]);
    recordBoot(at("c3"), T + 900, n);
    expect(notices).toEqual([["tell", "boots", "4 in 30 minutes"]]);
    expect(parseBoots(readFileSync(join(dir, "probe", "boots"), "utf8")).length).toBe(4);
    expect(tooManyBoots([T, T + 1, T + 2], T + 2)).toBe(false);
    recordBoot(at("c4"), T + 3000, n);
    expect(notices.at(-1)).toEqual(["clear", "boots"]);
  });
  test("the count and the install record survive container restarts: they live in /data, the marks in /run", () => {
    const { dir, n, at } = startsWorld();
    recordInstall(at("c0"), "0.13.5", T - 86400);
    recordInstall(at("c0"), "0.14.0", T);
    recordBoot(at("c0"), T, n);
    // A new container: a fresh /run, the same /data.
    const p1 = at("c1");
    expect(existsSync(p1.booted)).toBe(false);
    expect(JSON.parse(readFileSync(p1.install, "utf8"))).toMatchObject({ version: "0.14.0", previous: "0.13.5", at: T });
    expect(recordInstall(p1, "0.14.0", T + 900)!.at).toBe(T);             // the same version is no new install
    recordBoot(p1, T + 900, n);
    expect(readFileSync(join(dir, "probe", "boots"), "utf8").trim().split("\n").length).toBe(2);
    expect(p1.boots.startsWith(join(dir, "probe"))).toBe(true);
    expect(p1.install.startsWith(join(dir, "probe"))).toBe(true);
    expect(p1.booted.startsWith(join(dir, "c1"))).toBe(true);
    // The run script records the install before the start, so the start can tell an update's own restart.
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run.indexOf('probe/main.ts" install')).toBeLessThan(run.indexOf('probe/main.ts" boot'));
  });
  test("the first two starts within 10 minutes of a version change aren't counted; a third is", () => {
    const i: Install = { id: "x", version: "0.14.0", previous: "0.13.5", at: T };
    expect(bootKind({ now: T, stopAsked: false, install: i, bootsText: "" })).toBe("update");
    expect(bootKind({ now: T + 100, stopAsked: false, install: i, bootsText: `${T} update\n` })).toBe("update");
    expect(bootKind({ now: T + 200, stopAsked: false, install: i, bootsText: `${T} update\n${T + 100} update\n` })).toBe("boot");
    expect(bootKind({ now: T + 601, stopAsked: false, install: i, bootsText: "" })).toBe("boot");
    expect(bootKind({ now: T + 601, stopAsked: true, install: i, bootsText: "" })).toBe("asked");
  });
  test("a boot loop within a day of an install raises the update line too, and it comes down once neither loop stands", () => {
    const { notices, n, at } = startsWorld();
    recordInstall(at("c0"), "0.13.5", T - 86400 * 2);
    recordInstall(at("c0"), "0.14.0", T);
    let t = T;
    for (let k = 0; k < 6; k++) { recordBoot(at(`c${k}`), t, n); t += 60; }
    // Two update starts not counted, then four counted: the loop, with the line that names the update.
    expect(tells(notices)).toEqual(["boots", "update-boots"]);
    expect(notices.find((x) => x[1] === "update-boots")![2]).toBe("Cain 0.14.0, installed 5 minutes ago");
    recordBoot(at("c9"), T + 4000, n);
    expect(notices.slice(-2)).toEqual([["clear", "boots"], ["clear", "update"]]);
  });
  test("the update line stays while the other loop still stands", () => {
    const { notices, n, at } = startsWorld();
    recordInstall(at("c0"), "0.13.5", T - 86400 * 2);
    recordInstall(at("c0"), "0.14.0", T - 3600);
    for (let k = 0; k < 4; k++) recordBoot(at(`c${k}`), T + k * 60, n);
    for (const s of [T, T + 60, T + 120, T + 180]) recordStart(at("c3"), s, "early-1", n);
    expect(tells(notices)).toEqual(["boots", "update-boots", "restarts", "update-exits"]);
    recordStart(at("c3"), T + 3000, "clean", n);                          // the exits clear, the boots still stand
    expect(notices.at(-1)).toEqual(["clear", "restarts"]);
    expect(notices.some((x) => x[0] === "clear" && x[1] === "update")).toBe(false);
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
  test("the edges: from the install up to, not including, 24 hours on", () => {
    const i: Install = { id: "x", version: "0.14.1", previous: "0.14.0", at: T };
    expect(inWindow(i, T - 1)).toBe(false);
    expect(inWindow(i, T)).toBe(true);
    expect(inWindow(i, T + 86399)).toBe(true);
    expect(inWindow(i, T + 86400)).toBe(false);
  });
});

describe("the marks folder", () => {
  test("every mark written whole: a fresh temp name created exclusively, then renamed; root's modes", () => {
    const dir = tmp();
    const f = join(dir, "probe", "m");
    writeWhole(f, "a\n");
    writeWhole(f, "b\n");
    expect(readFileSync(f, "utf8")).toBe("b\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "probe")).mode & 0o777).toBe(0o700);
    const main = src("rootfs/opt/cain/probe/main.ts");
    expect(main).toContain('openSync(tmp, "wx", mode)');
    expect(main).not.toMatch(/appendFileSync|writeFileSync\(/);
    expect(main).not.toMatch(/`\$\{p\}\.tmp`/);
  });
  test("no path under /run/cain/probe or /data/probe is writable by uid 1000: lock.sh's modes and the Dockerfile", () => {
    const lock = src("rootfs/opt/cain/c1/lock.sh");
    // /run/cain: root's, his group may pass through but neither list nor write.
    const run = /install -d -m (\d+) -o (\S+) -g (\S+) \/run\/cain \|\|/.exec(lock)!;
    expect(run[2]).toBe("root");
    expect(Number.parseInt(run[1], 8) & 0o022).toBe(0);
    // Every install of a path under /run/cain/probe or /data/probe: root:root, nothing for group or others.
    const under = [...lock.matchAll(/install -d -m (\d+) -o (\S+) -g (\S+) ([^\n|]*)/g)].filter((m) => /\/run\/cain\/probe|\$D\/probe/.test(m[4]));
    expect(under.length).toBeGreaterThanOrEqual(2);
    for (const m of under) { expect(m[2]).toBe("root"); expect(m[3]).toBe("root"); expect(Number.parseInt(m[1], 8) & 0o077).toBe(0); }
    expect(lock).toContain('own "$D/probe" root:root 0700');
    // Nothing else hands any of it to him: no chown, chmod or other install of it in lock.sh or the image.
    for (const l of lock.split("\n").filter((x) => /probe/.test(x) && !x.trimStart().startsWith("#")))
      expect(l).toMatch(/install -d -m 0700 -o root -g root|own "\$D\/probe" root:root 0700/);
    expect(src("Dockerfile")).not.toMatch(/probe/);
    // What writes there writes root's files: the probe through writeWhole (0600), the broker's marks 0600.
    expect(src("rootfs/opt/cain/discord/broker-main.ts")).toContain('mode: 0o600, flag: "wx"');
    expect(src("rootfs/opt/cain/link/main.ts")).toContain("{ mode: 0o600 }");
  });
  test("the image test checks it on the real image, as uid 1000", () => {
    const img = src("tests/image/in.sh");
    expect(img).toContain("probe_marks_root_only");
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
  const t = (k: string, c = "") => Bun.spawnSync(["bash", NOTICE, "text", k, c]).stdout.toString();
  test("each 0.14.0 alarm has a title and a text with no em dash, named by what it measures", () => {
    for (const k of ["probe", "needs-signin", "api-down", "restarts", "self-loop", "boots", "update-exits", "update-boots"]) {
      const r = Bun.spawnSync(["bash", NOTICE, "text", k, "a cause"]);
      expect(r.exitCode).toBe(0);
      const [title, msg] = r.stdout.toString().split("\n");
      expect(title.length).toBeGreaterThan(5);
      expect(msg).not.toContain("—");
      expect(`${title} ${msg}`).not.toMatch(/crash|rollback|rolled back|would have run/i);
    }
    expect(t("probe")).toContain("liveness checks");
    expect(t("probe")).toContain("not that he answers you");
    expect(t("needs-signin")).toContain("Cain needs sign-in");
    expect(t("api-down")).toContain("The model's API isn't answering");
    expect(t("restarts")).toContain("Cain's session keeps exiting early");
    expect(t("restarts")).toContain("within 5 minutes of starting");
    expect(t("self-loop")).toContain("Cain's session keeps ending on its own");
    expect(t("self-loop")).toContain("more than 4 times in an hour");
    expect(t("boots")).toContain("Cain's App container keeps starting");
    expect(t("boots")).toContain("not counting stops and updates asked from Home Assistant");
  });
  test("the update line is factual: what happened since which update, and the way back by hand", () => {
    const m = t("update-exits", "Cain 0.14.0, installed 3 hours ago").split("\n")[1];
    expect(m).toContain("Cain's session has exited early several times since the update to Cain 0.14.0, installed 3 hours ago.");
    expect(m).toContain("Nothing rolls back by itself.");
    expect(m).toContain("If a backup was made before the update, restoring it from Backups undoes the update and any changes since");
    const u = t("update-unseen", "Cain 0.14.0, installed 3 hours ago").split("\n")[1];
    expect(u).toContain("since the update to Cain 0.14.0, installed 3 hours ago, its exits unseen");
    expect(u).toContain("If a backup was made before the update, restoring it from Backups undoes the update and any changes since");
    const b = t("update-boots", "Cain 0.14.0, installed 5 minutes ago").split("\n")[1];
    expect(b).toContain("Cain's App container has started several times since the update to Cain 0.14.0, installed 5 minutes ago.");
    expect(b).toContain("Nothing rolls back by itself.");
  });
  test("the alarms of earlier rounds are gone", () => {
    for (const k of ["messages", "rollback", "rollback-disarmed", "rollback-failed", "rollback-again", "rollback-unsigned", "rollback-nobackup", "rollback-record", "rollback-unavailable", "self-ended"])
      expect(Bun.spawnSync(["bash", NOTICE, "text", k, ""]).exitCode).toBe(2);
    const n = src("rootfs/opt/cain/notice.sh");
    expect(n).not.toMatch(/rollback|^\s*flush\)/m);
    for (const f of ["rootfs/opt/cain/notice.sh", "DOCS.md", "CHANGELOG.md"]) expect(src(f)).not.toMatch(/stays silent[^.]*restore[^.]*failed|silence[^.]*restore[^.]*failed/i);
  });
  test("each loop clears its own group, and the update group has its own clear", () => {
    const n = src("rootfs/opt/cain/notice.sh");
    expect(n).toContain('restarts) groups="restarts" ;;');
    expect(n).toContain('update) groups="update" ;;');
    expect(n).toContain("update-exits|update-unseen|update-boots) echo update ;;");
  });
});

describe("the boundary", () => {
  test("no restore code ships: no helper, no Supervisor access, no map and no switch", () => {
    expect(existsSync(join(ROOT, "rootfs/opt/cain/rollback"))).toBe(false);
    const cfg = readFileSync(join(ROOT, "config.yaml"), "utf8");
    expect(cfg).toContain("hassio_api: false\n");
    expect(cfg).not.toMatch(/hassio_role|addon_config|^map:|rollback|restore\/partial|rollback-record/m);
    const lock = src("rootfs/opt/cain/c1/lock.sh");
    expect(lock).not.toMatch(/C1_CONFIG|\/config|watcher|-g watch|rollback/);
    expect(src("Dockerfile")).not.toMatch(/watch|as-watch|rollback/);
    expect(existsSync(join(ROOT, "rootfs/opt/cain/as-watch"))).toBe(false);
    // Nothing a later token or map could re-arm: no restore call, no backups API, no record of restores.
    for (const f of ["rootfs/opt/cain/probe/core.ts", "rootfs/opt/cain/probe/main.ts", "rootfs/etc/services.d/cain/run", "rootfs/etc/services.d/cain/finish", "rootfs/opt/cain/notice.sh"])
      expect(src(f)).not.toMatch(/restore\/partial|\/backups|SUPERVISOR_TOKEN[^\n]*probe|rollback-record|restoreBody|signedFromLink|decide\(/);
  });
  test("/run/cain is root's, and his group may pass through it but not list it; what root keeps there is root's alone", () => {
    const lock = src("rootfs/opt/cain/c1/lock.sh");
    expect(lock).toContain("install -d -m 0710 -o root -g cain /run/cain ");
    expect(lock).toContain("install -d -m 0700 -o root -g root /run/cain/probe");
    expect(lock).toContain('install -d -m 0700 -o root -g root "$D/probe"');
    expect(src("rootfs/opt/cain/link/main.ts")).toContain('writeFileSync(`${GATEWAY_STATE}.tmp`, `${connected ? "connected" : "down"} ${Math.floor(proto.lastAck / 1000)}\\n`, { mode: 0o600 })');
    const contract = src("rootfs/opt/cain/c1/contract.ts");
    const allowList = contract.slice(contract.indexOf("const ROOT_FOR_HIM"), contract.indexOf("];", contract.indexOf("const ROOT_FOR_HIM")));
    expect(allowList).not.toMatch(/probe|gateway|config|watcher/);
  });
  test("the run script: the start kept, its own stop request marked with the run it holds, the end seen, the code passed on", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    expect(run).toContain('timeout 30 bun "$OPT/probe/main.ts" boot');
    expect(run).toContain('session-start "$(last_code)" "${run_id:-}"');
    expect(run).toContain('session-gone "${run_id:-}"');
    const end = run.slice(run.indexOf("end_his_session() {"), run.indexOf("end_his_session() {") + 500);
    expect(end).toContain('session-asked "${run_id:-}"');
    expect(end.indexOf("session-asked")).toBeLessThan(end.indexOf("kill-session"));
    expect(run.split("session_gone").length - 1).toBeGreaterThanOrEqual(4);
    expect(run).not.toMatch(/129\|130\|143|first_start|ended_by_us/);
    expect(src("rootfs/opt/cain/session.sh")).toContain('printf \'%s\\n\' "$rc" > "$exitf"');
  });
  test("the probe URL reaches no command line or log", () => {
    const run = src("rootfs/etc/services.d/cain/run");
    const unset = run.indexOf("unset HEARTBEAT_URL PROBE_PING_URL");
    expect(unset).toBeGreaterThan(0);
    for (const child of ["tmux -u new-session", "link/main.ts", "checkin.sh", "probe/main.ts"]) expect(unset).toBeLessThan(run.indexOf(child));
    expect(run.split("PROBE_PING_URL=").length).toBe(2);
    const at = run.indexOf("PROBE_PING_URL=");
    expect(run.slice(at, run.indexOf(") &", at))).toContain('bun "$OPT/probe/main.ts" loop');
    expect(run).not.toMatch(/echo[^\n]*PROBE_PING_URL|log[^\n]*PROBE_PING_URL/);
    const main = src("rootfs/opt/cain/probe/main.ts");
    expect(main).toContain("delete env.PROBE_PING_URL");
    expect(main.match(/Bun\.spawnSync\(/g)!.length).toBe(main.match(/PROBE_PING_URL: _drop/g)!.length);
    expect(main).not.toMatch(/log\([^)]*\$\{url|console\.[a-z]+\([^)]*\$\{url/);
    const drill = src("tools/probe-drill.sh");
    expect(drill).not.toMatch(/HASSIO_TOKEN|PROBE_PING_URL|probe_heartbeat_url|options\.json/);
    expect(drill).not.toMatch(/curl[^\n]*[Aa]uthorization/);
  });
});

describe("the asked mark (sixth round): bound to the run script's start, kept only for a real stop", () => {
  test("stop-asked keeps the start's id and the time; the next container start counts it once", () => {
    const { p, n, at } = startsWorld();
    recordBoot(at("c0"), T - 100, n, S1);                                 // the run script's start: the last start record
    stopAsked(at("c0"), T, "", S1);
    expect(JSON.parse(readFileSync(p.stopAsked, "utf8"))).toEqual({ at: T, id: S1 });
    expect(readFileSync(at("c0").term, "utf8")).toBe(`${S1}\n`);          // the trap's nonce, in /run
    expect(recordBoot(at("c1"), T + 20, n, S2)).toBe("asked");
    expect(existsSync(p.stopAsked)).toBe(false);                          // taken
    expect(JSON.parse(readFileSync(p.start, "utf8"))).toEqual({ id: S2, at: T + 20 });
    expect(recordBoot(at("c2"), T + 40, n, S3)).toBe("boot");
  });
  test("a stale mark (over 5 minutes old) doesn't count, and is taken", () => {
    const { p, n, at } = startsWorld();
    recordBoot(at("c0"), T - 100, n, S1);
    stopAsked(at("c0"), T, "", S1);
    expect(recordBoot(at("c1"), T + 301, n, S2)).toBe("boot");
    expect(existsSync(p.stopAsked)).toBe(false);
    stopAsked(at("c1"), T, "", S2);
    expect(takeStopMark(p, T + 300, S2)).toBe(true);                      // the edge: 5 minutes counts
  });
  test("a mark from another start of the run script never counts; no hostname is involved", () => {
    const { p, n, at } = startsWorld();
    recordBoot(at("c0"), T - 100, n, S1);
    stopAsked(at("c0"), T, "", S2);                                       // a mark naming another start
    expect(recordBoot(at("c1"), T + 10, n, S3)).toBe("boot");
    expect(existsSync(p.stopAsked)).toBe(false);
    for (const f of ["rootfs/opt/cain/probe/main.ts", "rootfs/opt/cain/probe/core.ts", "DOCS.md", "rootfs/etc/services.d/cain/run", "rootfs/etc/services.d/cain/finish"])
      expect(src(f)).not.toMatch(/hostname|containerId|container: "/);
  });
  test("a mark in the old form, or garbled, doesn't count", () => {
    const { p } = startsWorld();
    for (const body of [`${T}\n`, "{", JSON.stringify({ at: "x", id: S1 }), JSON.stringify({ at: T }), JSON.stringify({ at: T, container: "cain-host" }), JSON.stringify({ at: T, id: "x" })]) {
      writeWhole(p.stopAsked, body);
      expect(takeStopMark(p, T + 10, S1)).toBe(false);
    }
  });
  test("a mark left by an s6-only restart of the run script is cleared before the next container start", () => {
    const { p, n, at } = startsWorld();
    const c0 = at("c0");
    expect(recordBoot(c0, T, n, S1)).toBe("boot");
    stopAsked(c0, T + 60, "", S1);                                        // s6 sends the run script TERM: the trap marks
    expect(stopFinish(c0, T + 61, 256, 15)).toBe(true);                   // finish: 256/15, but s6 restarts the script
    expect(recordBoot(c0, T + 62, n, S2)).toBeNull();                     // the same container: no new start counted
    expect(existsSync(p.stopAsked)).toBe(false);                          // the mark is cleared
    expect(existsSync(c0.term)).toBe(false);
    // Then the container dies without a TERM: its next start is counted, the stale mark absorbs nothing.
    expect(recordBoot(at("c1"), T + 120, n, S3)).toBe("boot");
  });
  test("the finish script keeps the mark only for a real stop the TERM trap left its nonce for", () => {
    const real = (code: number, sig: number, trap: boolean) => {
      const { p, n, at } = startsWorld();
      const c0 = at("c0");
      recordBoot(c0, T, n, S1);
      if (trap) stopAsked(c0, T + 60, "", S1);
      const kept = stopFinish(c0, T + 61, code, sig);
      return { kept, mark: existsSync(p.stopAsked), next: recordBoot(at("c1"), T + 90, n, S2) };
    };
    expect(real(256, 15, true)).toEqual({ kept: true, mark: true, next: "asked" });
    expect(real(15, 0, true)).toEqual({ kept: true, mark: true, next: "asked" });
    // No nonce from the trap (a TERM it never handled): never asked.
    expect(real(256, 15, false)).toEqual({ kept: false, mark: false, next: "boot" });
    // SIGKILL (the OOM killer), SIGSEGV, SIGABRT, an exit of its own: never asked, even after the trap ran.
    for (const [code, sig] of [[256, 9], [256, 11], [256, 6], [1, 0], [0, 0], [143, 0]])
      expect(real(code, sig, true)).toEqual({ kept: false, mark: false, next: "boot" });
    // A nonce that isn't the last start's: not kept.
    const { p, n, at } = startsWorld();
    recordBoot(at("c0"), T, n, S1);
    writeWhole(at("c0").term, `${S2}\n`);
    expect(stopFinish(at("c0"), T + 1, 256, 15)).toBe(false);
    expect(existsSync(p.stopAsked)).toBe(false);
  });
  test("a SIGKILL'd and a SIGSEGV'd run each count as unseen or early, never asked", () => {
    for (const sig of [9, 11]) {
      const { p, notices, n, at } = startsWorld();
      const c0 = at("c0");
      recordBoot(c0, T, n, S1);
      const r = sessionStart(c0, T + 5, null, n, "");
      // Killed outright: no TERM trap, so no session-asked, no stop-asked and no nonce; finish sees 256/sig.
      expect(existsSync(c0.term)).toBe(false);
      expect(stopFinish(c0, T + 100, 256, sig)).toBe(false);
      // s6 restarts the run script (its memory gone): the run before is unseen, never asked.
      expect(recordBoot(c0, T + 101, n, S2)).toBeNull();
      expect(sessionStart(c0, T + 105, null, n, "").kind).toBe("unseen");
      // Seen gone by a run script that held its id, within 5 minutes: an early exit, never asked.
      const r2 = sessionStart(c0, T + 200, null, n, "");
      markGone(c0, T + 230, r2.id);
      expect(sessionStart(c0, T + 240, null, n, r2.id).kind).toBe("early-unknown");
      // A whole container killed: the next one is counted.
      expect(recordBoot(at("c1"), T + 300, n, S3)).toBe("boot");
      expect(readFileSync(p.starts, "utf8")).not.toMatch(/ asked$/m);
      expect(r.kind).toBe("boot");
      expect(notices).toEqual([]);
    }
  });
  test("the finish script and the trap, and s6's budget inside the Supervisor's 30 seconds with margin", () => {
    const fin = src("rootfs/etc/services.d/cain/finish");
    expect(fin).toMatch(/if \[ -e \/run\/cain\/probe\/term \]; then\n\s+timeout (\d) bun \/opt\/cain\/probe\/main\.ts stop-finish/);
    const finT = Number(/timeout (\d) bun \/opt\/cain\/probe\/main\.ts stop-finish/.exec(fin)![1]);
    const trapT = Number(/stop_asked\(\) \{ timeout (\d+) bun/.exec(src("rootfs/etc/services.d/cain/run"))![1]);
    const docker = src("Dockerfile");
    const g = /^ENV S6_SERVICES_GRACETIME=(\d+) S6_KILL_FINISH_MAXTIME=(\d+) S6_KILL_GRACETIME=(\d+)$/m.exec(docker)!;
    expect(g).not.toBeNull();
    const [svc, fin2, kill] = g.slice(1).map(Number);
    expect([svc, fin2, kill]).toEqual([8000, 5000, 3000]);
    expect(trapT * 1000).toBeLessThan(svc);                               // the trap's 6 s inside the services' 8
    expect(finT * 1000).toBeLessThan(fin2);                               // the finish script's 4 s inside its 5
    const timeout = Number(/^timeout: (\d+)$/m.exec(src("config.yaml"))![1]);
    expect(svc + fin2 + kill).toBeLessThanOrEqual(timeout * 1000 - 10_000); // 16 s of the 30, with margin
  });
});

describe("alarm texts (fifth round)", () => {
  const NOTICE = join(ROOT, "rootfs/opt/cain/notice.sh");
  const msg = (k: string, c = "") => Bun.spawnSync(["bash", NOTICE, "text", k, c]).stdout.toString().split("\n");
  test("the update sentence and the way back by hand only in the update line; the others give what was measured", () => {
    for (const k of ["restarts", "self-loop", "unseen-loop", "boots"]) {
      const [title, m] = msg(k, "4 in 30 minutes, last exit code 1");
      expect(`${title} ${m}`).not.toMatch(/the update|his update|backup|restore|roll/i);
      expect(m).toContain("(4 in 30 minutes, last exit code 1)");
    }
    for (const k of ["update-exits", "update-unseen", "update-boots"])
      expect(msg(k, "Cain 0.14.0, installed 3 hours ago")[1]).toContain("If a backup was made before the update, restoring it from Backups undoes the update and any changes since");
    // The update line goes out only within a day of an install (the probe's own rule).
    const main = src("rootfs/opt/cain/probe/main.ts");
    const say = main.slice(main.indexOf("function sayUpdate"), main.indexOf("function updateDown"));
    expect(say).toContain("if (!inWindow(i, now)) return;");
  });
  test("confirmed early exits and inferred restarts stay apart", () => {
    const [rt, rm] = msg("restarts");
    expect(rt).toBe("Cain's session keeps exiting early");
    expect(rm).toContain("Each exit was seen.");
    expect(rm).not.toMatch(/keeps restarting|cadence/);
    const [ut, um] = msg("unseen-loop", "7 in 60 minutes");
    expect(ut).toBe("Cain's session keeps restarting");
    expect(um).toContain("The restarts were seen but not the exits, so this is a cadence, not a confirmed crash.");
    expect(um).not.toMatch(/exiting early|exited early/);
    expect(msg("self-loop")[1]).not.toMatch(/exiting early|keeps restarting/);
  });
  test("late exits name the model's API or the network as possible causes first", () => {
    const m = msg("self-loop", "5 in 60 minutes, last exit code 1")[1];
    expect(m).toContain("Possible causes: the model's API or the network");
    expect(m).not.toMatch(/update/i);
  });
  test("the cause: count and window, the last exit code, the last log line, plain", () => {
    expect(exitCause("4 in 30 minutes", "1", "Error: connect ETIMEDOUT")).toBe("4 in 30 minutes, last exit code 1, session log says: Error: connect ETIMEDOUT");
    expect(exitCause("7 in 60 minutes", null, null)).toBe("7 in 60 minutes");
    expect(lastCode(`${T} boot\n${T + 1} early-3\n${T + 2} asked\n`)).toBe("3");
    expect(lastCode(`${T} self-137\n${T + 1} clean\n`)).toBe("0");
    expect(lastCode(`${T} early-1\n${T + 1} unseen\n`)).toBeNull();
    expect(logLine("a\n\x1b[31mAPI Error: 529 \u2014 see https://evil.example/x?y \u201ctap\u201d\n\n")).toBe("API Error: 529 see (a link) tap");
    expect(logLine("x".repeat(200))!.length).toBe(60);
    expect(logLine("\n\n")).toBeNull();
  });
  test("the session log is read only as a plain file with one name: no symlink, no hard link", () => {
    const dir = tmp();
    const p = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), PROBE_SESSION_LOG: join(dir, "session.log") });
    writeFileSync(join(dir, "session.log"), "start\nclaude exited (1): the App starts his session again\n");
    expect(sessionLogLine(p)).toBe("claude exited (1): the App starts his session again");
    writeFileSync(join(dir, "secret"), "token=abc\n");
    const q = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), PROBE_SESSION_LOG: join(dir, "link.log") });
    symlinkSync(join(dir, "secret"), join(dir, "link.log"));
    expect(sessionLogLine(q)).toBeNull();
    const h = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), PROBE_SESSION_LOG: join(dir, "hard.log") });
    linkSync(join(dir, "secret"), join(dir, "hard.log"));
    expect(sessionLogLine(h)).toBeNull();
  });
  test("an alarm carries them from the probe", () => {
    const { p, notices, n } = startsWorld();
    for (const t of [T, T + 100, T + 200, T + 300]) recordStart(p, t, "early-2", n);
    expect(notices[0][0]).toBe("tell");
    expect(notices[0][2]).toMatch(/^4 in 30 minutes, last exit code 2/);
  });
});

describe("the probe's folders are looked at before every read or write (fifth round)", () => {
  function tamperWorld() {
    const dir = tmp(); world(dir);
    const t = passDeps(dir);
    writeWhole(join(t.p.dir, "x"), "1\n");
    writeWhole(join(t.p.run, "x"), "1\n");
    return { dir, ...t };
  }
  test("right: root's (here the test's own user), 0700, not a symlink", () => {
    const { p } = tamperWorld();
    expect(folderWhy(p.dir)).toBeNull();
    expect(folderWhy(p.run)).toBeNull();
  });
  test("a symlinked folder: the pass refuses, writes nothing through it, and the alarm goes once", async () => {
    const { dir, d, p, notices } = tamperWorld();
    renameSync(p.run, join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), p.run);
    await expect(runPass(d)).rejects.toThrow(/is a symlink/);
    expect(existsSync(join(dir, "elsewhere", "hourly.json"))).toBe(false);
    const { onTamper } = await import("../rootfs/opt/cain/probe/main");
    const err = await runPass(d).catch((e) => e);
    expect(onTamper(err, d.notice)).toBe(true);
    expect(onTamper(err, d.notice)).toBe(true);
    expect(notices.filter((x) => x[1] === "tampered").length).toBe(1);
    expect(notices.find((x) => x[1] === "tampered")![2]).toBe(`${p.run} is a symlink`);
  });
  test("a folder opened to others: refused; a session start refused too", () => {
    const { p } = tamperWorld();
    chmodSync(p.dir, 0o755);
    expect(folderWhy(p.dir)).toBe("has mode 0755, not 0700");
    expect(() => sessionStart(p, T, null, () => 0, "")).toThrow(/0755/);
    expect(() => stopAsked(p, T, "", S1)).toThrow(/0755/);
  });
  test("a folder replaced by a file", () => {
    const dir = tmp();
    writeFileSync(join(dir, "probe"), "x");
    const p = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run") });
    expect(() => recordInstall(p, "0.14.0", T)).toThrow(/isn't a folder/);
  });
  test("the command refuses with exit 3; the broker writes no mark there either", () => {
    const dir = tmp();
    mkdirSync(join(dir, "run"), { mode: 0o777 });
    chmodSync(join(dir, "run"), 0o777);
    const b = Bun.spawnSync(["bun", MAIN, "session-start", "1", ""], { env: { ...process.env, PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), PROBE_NOTICE: "/bin/true" } });
    expect(b.exitCode).toBe(3);
    const bm = src("rootfs/opt/cain/discord/broker-main.ts");
    const mark = bm.slice(bm.indexOf("function probeMark"), bm.indexOf("function probeAsk"));
    expect(mark.indexOf("checkFolder(PROBE_RUN)")).toBeLessThan(mark.indexOf("writeFileSync"));
    expect(bm).toContain("folderWhy(PROBE_RUN) !== null");
  });
  test("notice.sh has the alarm", () => {
    const r = Bun.spawnSync(["bash", join(ROOT, "rootfs/opt/cain/notice.sh"), "text", "tampered", "/data/probe is a symlink"]).stdout.toString();
    expect(r.split("\n")[0]).toBe("Cain's probe folder was tampered with");
  });
  test("the folders above can't be written by him: lock.sh, and the image test's parent-rename case", () => {
    expect(src("rootfs/opt/cain/c1/lock.sh")).toContain('chmod go-w "$D" /run/cain');
    const img = src("tests/image/in.sh");
    expect(img).toContain('mv \'"$D"\'/probe \'"$D"\'/probe.moved');
    expect(img).toContain("mv /run/cain/probe /run/cain/probe.moved");
    expect(img).toContain("a symlinked probe folder wasn't refused");
  });
});

describe("Claude Code's version", () => {
  test("its updater stays off; CI notes a newer release without failing", () => {
    const ci = readFileSync(join(ROOT, "../.github/workflows/tests.yml"), "utf8");
    const step = ci.slice(ci.indexOf("- name: Claude Code's pinned version"), ci.indexOf("- name: Names and imports"));
    expect(step).toContain("::warning");
    expect(step).toContain("|| true");
    expect(step).not.toMatch(/exit 1|continue-on-error/);
    expect(src("DOCS.md")).toContain("Claude Code fixes arrive with App releases");
  });
});

describe("the drill", () => {
  test("its steps match this release, and nothing in it restores", () => {
    const drill = src("tools/probe-drill.sh");
    for (const n of ["1", "1b", "2", "3", "4", "5"]) expect(drill).toMatch(new RegExp(`^  ${n}\\)`, "m"));
    expect(drill).toContain("docker exec -u 1000");
    expect(drill).not.toMatch(/rollback|restore\/partial|helper\.ts|\/config\//);
    expect(drill).toContain("alarm_up self");
    expect(drill).toContain("alarm_up update");
    expect(drill).toContain("/run/cain/probe");
    // Sixth round: drill 5 in three parts, each checking the classification kept and the alarms.
    for (const part of ["      ha)", "      kill)", "      s6)"]) expect(drill).toContain(part);
    expect(drill).toContain('docker kill "$C"');
    expect(drill).toContain("s6-svc -r /run/service/cain");
    expect(drill).toContain('[ "$k" = boot ] || fail');
    expect(drill).toContain("in_c test -e /data/probe/stop-asked && fail");
    const docs = src("DOCS.md");
    expect(docs).not.toMatch(/rollback_armed|rollback\/helper|restore release/);
    expect(docs).toContain("Cain's session keeps ending on its own");
    expect(docs).toContain("Your Stop doesn't touch any of this.");
    expect(docs).toContain("rare, and always caused by the App");
    expect(docs).not.toMatch(/During your saved Stop|Stop looks like a failure|pause that check at the service/i);
  });
});

describe("the tamper response doesn't silence liveness for good (sixth round)", () => {
  function tw() {
    const dir = tmp(); world(dir);
    const t = passDeps(dir);
    writeWhole(join(t.p.dir, "x"), "1\n");
    writeWhole(join(t.p.run, "x"), "1\n");
    return { dir, ...t };
  }
  test("every folder above the probe's must be root's (here the test's own user's) and not writable by others", () => {
    const { dir, p } = tw();
    expect(aboveWhy(p.dir)).toBeNull();
    chmodSync(dir, 0o777);
    expect(folderWhy(p.dir)).toBe(`has ${realpathSync(dir)} above it, which others can write`);
    expect(folderWhy(p.run)).toMatch(/above it, which others can write$/);
    expect(() => recordInstall(p, "0.14.0", T)).toThrow(/others can write/);
    chmodSync(dir, 0o1777);                                               // sticky, but not root's here unless the test runs as root
    expect(folderWhy(p.dir) === null).toBe(statSync(dir).uid === 0);
    chmodSync(dir, 0o700);
    expect(folderWhy(p.dir)).toBeNull();
    // The real chain on the Pi: lock.sh fixes / and /run and the folder above /data where it can.
    const lock = src("rootfs/opt/cain/c1/lock.sh");
    expect(lock).toContain('for a in / /run "$(dirname "$D")"; do');
    expect(lock).toContain('[ -k "$a" ] || chmod go-w "$a"');
    expect(src("tests/image/in.sh")).toContain('for p in / /run "$(dirname \'"$D"\')"; do [ -w "$p" ] && [ ! -k "$p" ] && echo "writable: $p"; done');
  });
  test("a missing folder is made with the right owner and mode, not refused", () => {
    const { p } = tw();
    rmSync(p.run, { recursive: true, force: true });
    expect(folderWhy(p.run)).toBeNull();
    const r = sessionStart(p, T, null, () => 0, "");
    expect(r.kind).toBe("boot");
    expect(statSync(p.run).mode & 0o7777).toBe(0o700);
    expect(statSync(p.run).uid).toBe(process.getuid!());
    // A missing folder whose parent others can write is refused, and nothing is made.
    const dir = tmp();
    chmodSync(dir, 0o777);
    const q = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run") });
    expect(() => recordInstall(q, "0.14.0", T)).toThrow(/others can write/);
    expect(existsSync(join(dir, "probe"))).toBe(false);
  });
  test("while the probe refuses, the heartbeat ping stops, so the outside service fires", async () => {
    const { dir, d, p, pings } = tw();
    expect((await runPass(d)).ok).toBe(true);
    expect(pings.length).toBe(1);
    chmodSync(p.dir, 0o755);
    world(dir, T + 300);
    await expect(runPass({ ...d, now: T + 300 })).rejects.toThrow(/0755/);
    chmodSync(p.dir, 0o700);
    renameSync(p.run, join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), p.run);
    await expect(runPass({ ...d, now: T + 600 })).rejects.toThrow(/symlink/);
    expect(pings.length).toBe(1);
    const main = src("rootfs/opt/cain/probe/main.ts");
    const body = main.slice(main.indexOf("export async function runPass"));
    expect(body.indexOf("checkFolder(p.dir); checkFolder(p.run);")).toBeLessThan(body.indexOf("d.ping()"));
  });
  test("the tamper alarm repeats daily while it lasts, and comes down once both folders are right", async () => {
    const { dir, d, p, notices } = tw();
    const { onTamper, tamperCleared } = await import("../rootfs/opt/cain/probe/main");
    tamperCleared(p, d.notice, true);                                     // a clean slate for this process
    notices.length = 0;
    chmodSync(p.dir, 0o755);
    const err = await runPass(d).catch((e) => e);
    for (const t of [T, T + 300, T + 86399]) expect(onTamper(err, d.notice, t)).toBe(true);
    expect(notices.filter((x) => x[1] === "tampered").length).toBe(1);
    onTamper(err, d.notice, T + 86400);
    expect(notices.filter((x) => x[1] === "tampered").length).toBe(2);   // a day on: told again
    chmodSync(p.dir, 0o700);
    tamperCleared(p, d.notice);
    expect(notices.at(-1)).toEqual(["clear", "tampered"]);
    expect(dir).toBeTruthy();
  });
  test("notice.sh sends the standing tamper alarm to his bot again once a day has passed, not before", () => {
    const dir = tmp();
    mkdirSync(join(dir, "opt"));
    writeFileSync(join(dir, "opt", "alert.sh"), `#!/bin/bash\necho sent >> "${dir}/sent"\n`, { mode: 0o755 });
    const env = { ...process.env, NOTICE_OPT: join(dir, "opt"), NOTICE_DATA: dir, NOTICE_OPTIONS: join(dir, "none.json"), NOTICE_DAY_S: "86400" };
    const tell = () => Bun.spawnSync(["bash", join(ROOT, "rootfs/opt/cain/notice.sh"), "tell", "tampered", "/data/probe is a symlink"], { env });
    const sent = () => (existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8").trim().split("\n").length : 0);
    tell(); tell();
    expect(sent()).toBe(1);
    const state = join(dir, "c1", "notice.d", "tamper");
    expect(readFileSync(state, "utf8")).toMatch(/^told \d+$/m);
    writeFileSync(state, readFileSync(state, "utf8").replace(/^told \d+$/m, `told ${Math.floor(Date.now() / 1000) - 86400}`));
    tell();
    expect(sent()).toBe(2);
    tell();
    expect(sent()).toBe(2);
  });
  test("the probe's files are opened without following a link, and only plain files are read", () => {
    const { dir, p } = tw();
    writeFileSync(join(dir, "secret"), JSON.stringify({ asked: T }));
    symlinkSync(join(dir, "secret"), p.hourly);
    const main = src("rootfs/opt/cain/probe/main.ts");
    expect(main).toContain("openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)");
    expect(main).toContain("fstatSync(fd).isFile() ? readFileSync(fd, \"utf8\") : null");
    // The session log's descriptor is checked after the open, before the read.
    const log = main.slice(main.indexOf("export function sessionLogLine"), main.indexOf("// -- the facts"));
    expect(log.indexOf("fstatSync(fd)")).toBeLessThan(log.indexOf("readSync(fd"));
    expect(log).toContain("st.nlink !== 1");
  });
});

describe("the Nov 19 cadence with the finish script suppressed (sixth round)", () => {
  test("a container start every 2.5 minutes, no stop mark and no exits recorded: the container alarm fires", () => {
    const { notices, n, at } = startsWorld();
    recordInstall(at("c0"), "0.13.5", T - 86400 * 3);
    recordInstall(at("c0"), "0.14.0", T - 3600);
    for (let i = 0; i < 8; i++) {
      const c = at(`c${i}`);
      expect(recordBoot(c, T + i * 150, n, `${i}`.padStart(16, "b"))).toBe("boot");
      sessionStart(c, T + i * 150 + 5, null, n, "");                     // the first start in each container
    }
    expect(tells(notices)).toEqual(["boots", "update-boots"]);
  });
  test("a session start every 2.5 minutes, s6 restarting the run script, no exits recorded: unseen, alarmed in 30 minutes", () => {
    const { p, notices, n } = startsWorld();
    sessionStart(p, T, null, n, "");
    const kinds: string[] = [];
    for (let i = 1; i <= 4; i++) kinds.push(sessionStart(p, T + i * 150, null, n, "").kind);
    expect(kinds).toEqual(["unseen", "unseen", "unseen", "unseen"]);
    expect(notices).toEqual([["tell", "unseen-loop", "4 in 30 minutes"]]); // no install within a day: no update line
  });
});

describe("alarm texts (sixth round)", () => {
  const NOTICE = join(ROOT, "rootfs/opt/cain/notice.sh");
  const msg = (k: string, c = "") => Bun.spawnSync(["bash", NOTICE, "text", k, c]).stdout.toString().split("\n");
  test("the quoted log line is prefixed \"session log says:\"; the restore line; the long turn may be normal", () => {
    expect(exitCause("4 in 30 minutes", null, "x")).toBe("4 in 30 minutes, session log says: x");
    expect(src("rootfs/opt/cain/probe/core.ts")).not.toContain("last log line:");
    for (const k of ["update-exits", "update-unseen", "update-boots"])
      expect(msg(k, "Cain 0.14.0, installed 3 hours ago")[1]).toContain("If a backup was made before the update, restoring it from Backups undoes the update and any changes since");
    expect(src("rootfs/opt/cain/notice.sh")).not.toContain("you can restore it from its Backups page");
    expect(msg("turn-long", "130")[1]).toContain("This may be normal for a long job");
    const u = msg("unseen-loop", "4 in 30 minutes")[1];
    expect(u).toContain("more than 3 times in half an hour, or more than 6 times in an hour (4 in 30 minutes)");
    expect(msg("tampered", "x")[1]).toContain("this alarm comes again each day meanwhile");
  });
});
