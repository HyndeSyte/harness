// Cain 0.14.0: the probe, the restart count kept in /data, and the rollback within 24 hours of an
// install (rootfs/opt/cain/probe, rootfs/opt/cain/rollback, the broker's hourly check).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterStart, alarmDue, askDue, type Backup, checkRequest, decide, type Facts, hourlyState, inWindow, type Install, lastSlot,
  layers, localTime, olderToRemove, pass, type Pass, preInstall, PROBE_CHAT, PROBE_LINE, PROBE_REPLY, restoredFrom, shouldPing,
  signedFromLink, startsIn, tooManyStarts, type WatchIn,
} from "../rootfs/opt/cain/probe/core";
import { paths, recordInstall, recordStart, runPass, type PassDeps } from "../rootfs/opt/cain/probe/main";
import { act, look } from "../rootfs/opt/cain/rollback/watcher";
import { boot, type HelperDeps, keepBackup, keepSigned, removeFile, type Sup, takeAlarm, takeRequest } from "../rootfs/opt/cain/rollback/helper";
import { BrokerSession } from "../rootfs/opt/cain/discord/broker";

const TZ = "America/New_York";
const T = localTime(2026, 11, 20, 10, 0, TZ);          // a Friday, 10:00 in New York
const tmp = () => mkdtempSync(join(tmpdir(), "probe-"));
const SELF = "0fcc2575_cain";

function good(now = T): Facts {
  return { now, plugin: true, tmux: true, gateway: { state: "connected", ack: now - 30 }, delivered: now - 600, slot: lastSlot(now, TZ) };
}

describe("the layers, each failing alone", () => {
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
    // At 10:00 the last check-in an hour old is 7:10 today.
    const slot = lastSlot(T, TZ)!;
    expect(slot).toBe(localTime(2026, 11, 20, 7, 10, TZ));
    expect(layers({ ...good(), delivered: slot - 1 })).toEqual(["input"]);
    expect(layers({ ...good(), delivered: null })).toEqual(["input"]);
    expect(layers({ ...good(), delivered: slot })).toEqual([]);
    // 13:00: 12:30 is under an hour old, so 7:10 still counts as the one to have gone in.
    const one = localTime(2026, 11, 20, 13, 0, TZ);
    expect(lastSlot(one, TZ)).toBe(slot);
    // Just after midnight: yesterday's 17:30.
    expect(lastSlot(localTime(2026, 11, 21, 0, 5, TZ), TZ)).toBe(localTime(2026, 11, 20, 17, 30, TZ));
  });
});

describe("the hourly answer", () => {
  test("asked only when his screen is free, hourly, never while one waits", () => {
    expect(askDue({}, T, false)).toBe(false);
    expect(askDue({}, T, true)).toBe(true);
    expect(askDue({ asked: T - 60 }, T, true)).toBe(false);                      // waiting
    expect(askDue({ asked: T - 3599, answered: T - 3500 }, T, true)).toBe(false);
    expect(askDue({ asked: T - 3600, answered: T - 3500 }, T, true)).toBe(true);
  });
  test("an answer that doesn't come within 20 minutes fails the pass, and stays failed until one comes", () => {
    expect(hourlyState({ asked: T - 1199 }, T)).toBe("waiting");
    expect(hourlyState({ asked: T - 1200 }, T)).toBe("timeout");
    expect(hourlyState({ asked: T - 5000, answered: T - 4900 }, T)).toBe("answered");
    expect(hourlyState({ asked: T - 1300, answered: T - 5000 }, T)).toBe("timeout");  // an older answer
    const p = pass(good(), { asked: T - 1200 });
    expect(p.ok).toBe(false);
    expect(p.failed).toEqual(["answer"]);
    expect(alarmDue([p])).toBe(true);                                             // at once, no second pass
    expect(shouldPing(p)).toBe(false);
  });
});

function passDeps(dir: string, over: Partial<PassDeps> = {}) {
  const p = paths({ PROBE_DIR: join(dir, "probe"), PROBE_RUN: join(dir, "run"), CHECKIN_DELIVERED: join(dir, "delivered"), PROBE_GATEWAY: join(dir, "gw") });
  const pings: number[] = [], notices: string[][] = [];
  const d: PassDeps = {
    p, now: T, tz: TZ, mode: "own", plugin: () => true, tmux: () => true, screenFree: () => false,
    ping: async () => { pings.push(d.now); return true; }, notice: (...a) => { notices.push(a); return 0; }, ...over,
  };
  return { d, p, pings, notices };
}
function world(dir: string, now = T) {
  writeFileSync(join(dir, "delivered"), `${now - 600}\n`);
  writeFileSync(join(dir, "gw"), `connected ${now - 20}\n`);
}

describe("the probe's outside heartbeat", () => {
  test("pinged after a pass that passed, never after one that failed", async () => {
    const dir = tmp(); world(dir);
    const { d, pings, notices } = passDeps(dir);
    expect((await runPass(d)).ok).toBe(true);
    expect(pings.length).toBe(1);
    for (const bad of [{ plugin: () => false }, { tmux: () => false }] as Partial<PassDeps>[]) {
      world(dir, T + 300);
      const r = await runPass({ ...d, ...bad, now: T + 300 });
      expect(r.ok).toBe(false);
    }
    writeFileSync(join(dir, "gw"), `down ${T}\n`);
    expect((await runPass({ ...d, now: T + 600 })).failed).toEqual(["gateway"]);
    expect(pings.length).toBe(1);                                // none of the three failed passes pinged
    // The alarm came once, at the second failed pass in a row, and comes down at the next pass.
    expect(notices).toEqual([["tell", "probe", "his session isn't there"]]);
    writeFileSync(join(dir, "gw"), `connected ${T + 880}\n`);
    world(dir, T + 900);
    expect((await runPass({ ...d, now: T + 900 })).ok).toBe(true);
    expect(notices.at(-1)).toEqual(["clear", "probe"]);
    expect(pings.length).toBe(2);
  });
  test("the hourly ask goes to the broker, and no answer fails without a ping", async () => {
    const dir = tmp(); world(dir);
    const { d, p, pings, notices } = passDeps(dir, { screenFree: () => true });
    await runPass(d);
    expect(readFileSync(p.ask, "utf8").startsWith(`${T} `)).toBe(true);
    world(dir, T + 1200);
    const late = await runPass({ ...d, now: T + 1200 });
    expect(late.failed).toEqual(["answer"]);
    expect(pings.length).toBe(1);
    expect(notices[0]).toEqual(["tell", "probe", "he didn't answer the hourly check within 20 minutes"]);
    // The answer, from the broker, after a fresh ask an hour later: it passes again.
    world(dir, T + 3600);
    await runPass({ ...d, now: T + 3600 });
    writeFileSync(p.answered, `${T + 3700}\n`);
    world(dir, T + 3900);
    const back = await runPass({ ...d, now: T + 3900 });
    expect(back.failed).toEqual([]);
    expect(pings.length).toBe(2);
  });
  test("the old way has no broker: no hourly ask", async () => {
    const dir = tmp(); world(dir);
    const { d, p } = passDeps(dir, { mode: "old", screenFree: () => true });
    expect((await runPass(d)).ok).toBe(true);
    expect(existsSync(p.ask)).toBe(false);
  });
});

describe("the restart count, kept in /data", () => {
  test("a sliding 30-minute window across restarts and a reboot", () => {
    const dir = tmp();
    const notices: string[][] = [];
    const n = (...a: string[]) => { notices.push(a); return 0; };
    const p = () => paths({ PROBE_DIR: join(dir, "probe") });           // a fresh read each time: nothing kept in memory
    expect(recordStart(p(), T, "session", n)).toBe(1);
    expect(recordStart(p(), T + 400, "session", n)).toBe(2);
    expect(recordStart(p(), T + 800, "session", n)).toBe(3);
    expect(notices).toEqual([]);
    // A reboot: a new process, the same file. Its first start is the fourth in 30 minutes.
    const b = Bun.spawnSync(["bun", join(import.meta.dir, "../rootfs/opt/cain/probe/main.ts"), "start", "boot"], {
      env: { ...process.env, PROBE_DIR: join(dir, "probe"), PROBE_NOTICE: "/bin/true" } });
    expect(b.stdout.toString().trim()).toMatch(/^\d+ starts in 30 minutes$/);
    const starts = readFileSync(join(dir, "probe", "starts"), "utf8").trim().split("\n");
    expect(starts.length).toBe(4);
    expect(starts.at(-1)).toMatch(/^\d+ boot$/);
    // The same four with the fourth at T + 1000: the alarm.
    const dir2 = tmp(), p2 = () => paths({ PROBE_DIR: join(dir2, "probe") });
    for (const t of [T, T + 400, T + 800]) recordStart(p2(), t, "session", n);
    expect(recordStart(p2(), T + 1000, "session", n)).toBe(4);
    expect(notices).toEqual([["tell", "restarts", "4 starts in 30 minutes"]]);
    // Told once a stretch; down once the oldest have left the window.
    recordStart(p2(), T + 1100, "session", n);
    expect(notices.length).toBe(1);
    expect(recordStart(p2(), T + 2600, "session", n)).toBe(3);
    expect(notices.at(-1)).toEqual(["clear", "restarts"]);
  });
  test("the window's edges", () => {
    const s = [T - 1800, T - 1799, T - 10, T];
    expect(startsIn(s, T)).toBe(3);                                      // exactly 30 minutes ago is out
    expect(tooManyStarts([T - 1799, T - 900, T - 10, T], T)).toBe(true);
    expect(tooManyStarts([T - 1800, T - 900, T - 10, T], T)).toBe(false);
    expect(startsIn([T - 100, T - 50, T], T, T - 60)).toBe(2);            // only since an install, when asked
  });
});

describe("installs and the 24-hour window", () => {
  test("a first record opens no window; a changed version does", () => {
    const first = afterStart(null, "0.14.0", T);
    expect(first.fresh).toBe(false);
    expect(first.install!.at).toBe(0);
    expect(inWindow(first.install, T)).toBe(false);
    expect(afterStart(first.install, "0.14.0", T + 10).install).toBe(first.install);
    const next = afterStart(first.install, "0.14.1", T + 100);
    expect(next.fresh).toBe(true);
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
  test("kept in /data across starts", () => {
    const dir = tmp(), p = paths({ PROBE_DIR: join(dir, "probe") });
    recordInstall(p, "0.14.0", T);
    expect(recordInstall(p, "0.14.0", T + 50)!.at).toBe(0);
    expect(recordInstall(p, "0.14.1", T + 100)!.at).toBe(T + 100);
    expect(recordInstall(p, "0.14.1", T + 200)!.at).toBe(T + 100);
  });
});

const INSTALL: Install = { id: `0.14.1@${T}`, version: "0.14.1", previous: "0.14.0", at: T };
const BACKUP: Backup = { slug: "a1b2c3d4", date: T - 120, addons: [SELF], homeassistant: false, folders: [], version: "0.14.0" };
const failed = (at: number, f = ["plugin"]): Pass => ({ at, ok: false, failed: f, hourly: "none" });
const passed = (at: number): Pass => ({ at, ok: true, failed: [], hourly: "none" });
function w(over: Partial<WatchIn> = {}): WatchIn {
  return { now: T + 3600, install: INSTALL, passes: [passed(T + 300), failed(T + 3300), failed(T + 3600)], starts: [T],
    signed: { "0.14.0": {} }, backup: BACKUP, rollback: null, rolledBack: null, drill: null, ...over };
}

describe("the rollback decision", () => {
  test("two failed probes in a row, a failed hourly answer, or more than 3 starts in 30 minutes", () => {
    expect(decide(w())).toMatchObject({ do: "rollback", slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", install: INSTALL.id });
    expect(decide(w({ passes: [failed(T + 3300), passed(T + 3600)] })).do).toBe("none");
    expect(decide(w({ passes: [failed(T + 3600)] })).do).toBe("none");                     // one alone
    expect(decide(w({ passes: [passed(T + 3300), failed(T + 3600, ["answer"])] })).do).toBe("rollback");
    expect(decide(w({ passes: [], starts: [T + 3000, T + 3100, T + 3200, T + 3300] })).do).toBe("rollback");
    expect(decide(w({ passes: [], starts: [T + 3000, T + 3100, T + 3200] })).do).toBe("none");
    // Failed passes from before the install don't count.
    expect(decide(w({ passes: [failed(T - 300), failed(T - 10)] })).do).toBe("none");
  });
  test("only within 24 hours of the install", () => {
    expect(decide(w({ now: T + 86399, passes: [failed(T + 86000), failed(T + 86300)] })).do).toBe("rollback");
    expect(decide(w({ now: T + 86400, passes: [failed(T + 86000), failed(T + 86300)] })).do).toBe("none");
    expect(decide(w({ install: { ...INSTALL, at: 0 } })).do).toBe("none");
  });
  test("refused for a version not installed from a signed Ship: an alarm and nothing else", () => {
    const d = decide(w({ signed: { "0.13.9": {} } }));
    expect(d).toMatchObject({ do: "alarm", code: "unsigned" });
    expect(checkRequest({ install: INSTALL.id, slug: BACKUP.slug, restore: "0.14.0", undo: "0.14.1", why: "x" },
      { now: T + 3600, install: INSTALL, backup: BACKUP, signed: {}, rollback: null, rolledBack: null })).toContain("signed Ship");
  });
  test("no pre-install backup: an alarm", () => {
    expect(decide(w({ backup: null }))).toMatchObject({ do: "alarm", code: "no-backup" });
    expect(decide(w({ backup: { ...BACKUP, version: "0.13.9" } }))).toMatchObject({ do: "alarm", code: "no-backup" });
  });
  test("one rollback per install; a failure after a rollback alarms and stops", () => {
    const rb = { install: INSTALL.id, at: T + 3600, slug: BACKUP.slug, restore: "0.14.0", undo: "0.14.1", why: "x", state: "restoring" as const, tries: 1 };
    expect(decide(w({ rollback: rb })).do).toBe("none");
    expect(decide(w({ rollback: { ...rb, state: "refused" } })).do).toBe("none");
    expect(decide(w({ rolledBack: T + 100 }))).toMatchObject({ do: "alarm", code: "again" });
    const req = { install: INSTALL.id, slug: BACKUP.slug, restore: "0.14.0", undo: "0.14.1", why: "x" };
    const s = { now: T + 3600, install: INSTALL, backup: BACKUP, signed: { "0.14.0": {} }, rollback: null, rolledBack: null };
    expect(typeof checkRequest(req, s)).toBe("object");
    expect(checkRequest(req, { ...s, rollback: rb })).toContain("already");
    expect(checkRequest(req, { ...s, rolledBack: T })).toContain("within the last day");
  });
  test("a drill holds it back", () => {
    expect(decide(w({ drill: T + 3000 })).do).toBe("none");
    expect(decide(w({ drill: T + 3600 - 45 * 60 })).do).toBe("rollback");
  });
  test("the helper's own check refuses anything but the recorded backup and versions", () => {
    const s = { now: T + 3600, install: INSTALL, backup: BACKUP, signed: { "0.14.0": {} }, rollback: null, rolledBack: null };
    const ok = { install: INSTALL.id, slug: BACKUP.slug, restore: "0.14.0", undo: "0.14.1", why: "two probes" };
    expect(checkRequest({ ...ok, slug: "deadbeef" }, s)).toContain("recorded pre-install backup");
    expect(checkRequest({ ...ok, slug: "../x" }, s)).toContain("backup's id");
    expect(checkRequest({ ...ok, restore: "0.13.0" }, s)).toContain("versions");
    expect(checkRequest({ ...ok, install: "other" }, s)).toContain("install on record");
    expect(checkRequest({ ...ok, extra: 1 }, s)).toBe("not a rollback request");
    expect(checkRequest(ok, { ...s, now: T + 86400 })).toContain("24 hours");
  });
});

describe("root's records", () => {
  test("signed Ships come from landed Ship cards that carried a token", () => {
    const state = { messages: {
      a: { kind: "ship", ship: { pr: "https://github.com/HyndeSyte/harness/pull/9", head: "a".repeat(40) },
           shipping: { state: "landed", at: 5, text: "Ship Cain 0.14.0 and Harness 0.30.1?\nmore", line: "Shipped: it's in main as of 9:00. Installing it is next." } },
      b: { kind: "ship", shipping: { state: "landed", at: 6, text: "Ship Cain 0.14.2?", line: "Shipped: it's in main as of 9:00. Installing it needs your tap again, since your tap is over 2 hours old." } },
      c: { kind: "ship", shipping: { state: "not landed", at: 7, text: "Ship Cain 0.14.3?", line: "Installing it is next." } },
      d: { kind: "ask", shipping: { state: "landed", text: "Ship Cain 0.14.4?", line: "Installing it is next." } },
    } };
    expect(Object.keys(signedFromLink(state))).toEqual(["0.14.0"]);
    expect(signedFromLink(null)).toEqual({});
  });
  test("the pre-install backup, one kept per App", () => {
    const list: Backup[] = [
      BACKUP,
      { ...BACKUP, slug: "00000001", date: T - 86400 * 3, version: "0.13.5" },
      { ...BACKUP, slug: "00000002", date: T - 60, addons: [SELF, "other"] },
      { ...BACKUP, slug: "00000003", date: T - 50, homeassistant: true },
      { ...BACKUP, slug: "00000004", date: T + 60 },                       // after the install
    ];
    expect(preInstall(list, SELF, INSTALL)!.slug).toBe("a1b2c3d4");
    expect(olderToRemove(list, SELF, BACKUP)).toEqual(["00000001"]);
    expect(preInstall(list, SELF, { ...INSTALL, previous: null })).toBeNull();
  });
  test("a start that came from a restore", () => {
    const newest = { ...BACKUP, version: "0.14.0" };
    expect(restoredFrom({ now: T + 3600, version: "0.14.0", alive: T - 200, install: { ...INSTALL, version: "0.14.0" }, newest })).toBe(true);
    expect(restoredFrom({ now: T + 3600, version: "0.14.0", alive: T + 3500, install: null, newest })).toBe(false);     // a plain restart
    expect(restoredFrom({ now: T + 3600, version: "0.14.1", alive: T - 200, install: null, newest })).toBe(false);      // an update
    expect(restoredFrom({ now: T + 60, version: "0.14.0", alive: T - 200, install: null, newest })).toBe(false);        // too soon to tell
  });
});

// A Supervisor that answers as told, noting every call.
function fakeSup(over: Partial<Record<string, (body?: any) => { ok: boolean; data?: any; message?: string }>> = {}) {
  const calls: string[] = [];
  const sup: Sup = {
    async call(method, path, body) {
      calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
      const f = over[`${method} ${path}`];
      if (f) return f(body);
      if (path === "/addons/self/info") return { ok: true, data: { slug: SELF, version: "0.14.1", version_latest: "0.14.1" } };
      if (path === "/backups") return { ok: true, data: { backups: [
        { slug: "a1b2c3d4", date: new Date((T - 120) * 1000).toISOString(), content: { homeassistant: false, addons: [SELF], folders: [] } },
        { slug: "00000001", date: new Date((T - 86400 * 3) * 1000).toISOString(), content: { homeassistant: false, addons: [SELF], folders: [] } },
        { slug: "0000000f", date: new Date((T - 86400) * 1000).toISOString(), content: { homeassistant: true, addons: [SELF], folders: ["share"] } },
      ] } };
      if (path === "/backups/a1b2c3d4/info") return { ok: true, data: { addons: [{ slug: SELF, version: "0.14.0" }] } };
      if (path === "/backups/00000001/info") return { ok: true, data: { addons: [{ slug: SELF, version: "0.13.5" }] } };
      if (method === "DELETE") return { ok: true };
      if (path.endsWith("/restore/partial")) return { ok: true, data: { job_id: "j1" } };
      return { ok: false, message: "no such thing" };
    },
  };
  return { sup, calls };
}
function helper(dir: string, sup: Sup, now = T + 3600) {
  const notices: string[][] = [], relayed: string[] = [], logs: string[] = [];
  const d: HelperDeps = {
    dir: join(dir, "probe"), watcher: join(dir, "watcher"), linkState: join(dir, "state.json"), now, sup,
    readAsWatch: (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } }, removeAsWatch: removeFile,
    notice: (...a) => { notices.push(a); return 0; }, relay: (l) => relayed.push(l), log: (m) => logs.push(m),
  };
  return { d, notices, relayed, logs };
}
function setup(dir: string, signed = true) {
  mkdirSync(join(dir, "probe"), { recursive: true });
  writeFileSync(join(dir, "probe", "install.json"), JSON.stringify(INSTALL));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ messages: signed ? { a: { kind: "ship", shipping: { state: "landed", at: 1, text: "Ship Cain 0.14.0?", line: "Installing it is next." } } } : {} }));
}

describe("the helper", () => {
  test("finds the pre-install backup, removes the older one, and restores it on a checked request after telling Dane", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup);
    keepSigned(h.d);
    expect((await keepBackup(h.d))!.slug).toBe("a1b2c3d4");
    expect(calls).toContain("DELETE /backups/00000001");
    expect(calls.some((c) => c.startsWith("DELETE /backups/0000000f"))).toBe(false);    // not this App alone
    // The watcher, as it decides from what root keeps.
    writeFileSync(join(dir, "probe", "passes.jsonl"), [failed(T + 3300), failed(T + 3600)].map((p) => JSON.stringify(p)).join("\n"));
    writeFileSync(join(dir, "probe", "starts"), `${T} session\n`);
    expect(act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"))).toContain("rollback asked: 0.14.1 back to 0.14.0");
    expect(await takeRequest(h.d)).toBe("restoring");
    expect(h.notices[0][0]).toBe("tell");
    expect(h.notices[0][1]).toBe("rollback");
    expect(h.notices[0][2]).toContain("from 0.14.1 back to 0.14.0");
    expect(calls.at(-1)).toBe(`POST /backups/a1b2c3d4/restore/partial {"addons":["${SELF}"],"background":true}`);
    // One per install: the watcher stands down, and a second request is refused.
    expect(look(T + 3700, join(dir, "probe")).do).toBe("none");
    writeFileSync(join(dir, "watcher", "request.json"), JSON.stringify({ install: INSTALL.id, slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", why: "x" }));
    expect(await takeRequest(h.d)).toBeNull();
    expect(calls.filter((c) => c.includes("/restore/")).length).toBe(1);
  });
  test("three Supervisor refusals in a row, then the alarm with the reason, and no more tries", async () => {
    const dir = tmp(); setup(dir);
    const { sup, calls } = fakeSup({ "POST /backups/a1b2c3d4/restore/partial": () => ({ ok: false, message: "Backup is busy" }) });
    const h = helper(dir, sup);
    keepSigned(h.d); await keepBackup(h.d);
    mkdirSync(join(dir, "watcher"), { recursive: true });
    writeFileSync(join(dir, "watcher", "request.json"), JSON.stringify({ install: INSTALL.id, slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", why: "x" }));
    expect(await takeRequest(h.d)).toBe("refused 1");
    expect(await takeRequest(h.d)).toBe("refused 2");
    expect(await takeRequest(h.d)).toBe("refused");
    expect(await takeRequest(h.d)).toBeNull();
    expect(calls.filter((c) => c.includes("/restore/")).length).toBe(3);
    expect(h.notices.at(-1)).toEqual(["tell", "rollback-failed", "the Supervisor refused it 3 times: Backup is busy"]);
  });
  test("an unsigned version: the watcher asks for the alarm, the helper raises it once and restores nothing", async () => {
    const dir = tmp(); setup(dir, false);
    const { sup, calls } = fakeSup();
    const h = helper(dir, sup);
    keepSigned(h.d); await keepBackup(h.d);
    writeFileSync(join(dir, "probe", "passes.jsonl"), [failed(T + 3300), failed(T + 3600)].map((p) => JSON.stringify(p)).join("\n"));
    expect(act(look(T + 3600, join(dir, "probe")), join(dir, "watcher"))).toContain("alarm asked: unsigned");
    expect(takeAlarm(h.d)).toBe("rollback-unsigned");
    act(look(T + 3660, join(dir, "probe")), join(dir, "watcher"));
    expect(takeAlarm(h.d)).toBeNull();                                           // once per install
    expect(h.notices.length).toBe(1);
    // A forged request is refused all the same.
    writeFileSync(join(dir, "watcher", "request.json"), JSON.stringify({ install: INSTALL.id, slug: "a1b2c3d4", restore: "0.14.0", undo: "0.14.1", why: "x" }));
    expect(await takeRequest(h.d)).toContain("signed Ship");
    expect(calls.some((c) => c.includes("/restore/"))).toBe(false);
  });
  test("a start after a restore is kept as a rollback, for the morning's Moving section", async () => {
    const dir = tmp(); setup(dir);
    writeFileSync(join(dir, "probe", "install.json"), JSON.stringify({ ...INSTALL, version: "0.14.0", previous: "0.13.5" }));
    writeFileSync(join(dir, "probe", "alive"), `${T - 100}\n`);
    const { sup } = fakeSup({ "GET /addons/self/info": () => ({ ok: true, data: { slug: SELF, version: "0.14.0", version_latest: "0.14.1" } }) });
    const h = helper(dir, sup);
    expect(await boot(h.d)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "probe", "rolled-back.json"), "utf8"))).toMatchObject({ restored: "0.14.0", undone: "0.14.1" });
    expect(h.relayed[0]).toContain("rolled back to Cain 0.14.0 from 0.14.1");
    const lines = Bun.spawnSync(["bun", join(import.meta.dir, "../rootfs/opt/cain/probe/main.ts"), "lines", "morning"], { env: { ...process.env, PROBE_DIR: join(dir, "probe") } });
    expect(lines.stdout.toString()).toContain("Moving section");
    const again = Bun.spawnSync(["bun", join(import.meta.dir, "../rootfs/opt/cain/probe/main.ts"), "lines", "morning"], { env: { ...process.env, PROBE_DIR: join(dir, "probe") } });
    expect(again.stdout.toString()).toBe("");
  });
});

describe("the broker's hourly check", () => {
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
    const note = t.toClient.at(-1);
    expect(note.method).toBe("notifications/claude/channel");
    expect(note.params.content).toBe(PROBE_LINE);
    expect(note.params.meta.chat_id).toBe(PROBE_CHAT);
  });
  test("the fixed answer is taken here and never sent on; anything else to that chat is refused", async () => {
    const t = session();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { chat_id: PROBE_CHAT, text: PROBE_REPLY } } }));
    expect(t.answered()).toBe(1);
    expect(t.toClient.at(-1).result.isError).toBeUndefined();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reply", arguments: { chat_id: PROBE_CHAT, text: "something else" } } }));
    expect(t.toClient.at(-1).result.isError).toBe(true);
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fetch_messages", arguments: { channel: PROBE_CHAT } } }));
    expect(t.toClient.at(-1).result.isError).toBe(true);
    expect(t.answered()).toBe(1);
    expect(t.toServer.filter((m) => m.method === "tools/call")).toEqual([]);   // nothing reached the plugin, so nothing Discord
  });
});

describe("notice.sh knows the new alarms", () => {
  const NOTICE = join(import.meta.dir, "../rootfs/opt/cain/notice.sh");
  test("each has a title and a text with no em dash", () => {
    for (const k of ["probe", "restarts", "rollback", "rollback-failed", "rollback-again", "rollback-unsigned", "rollback-nobackup"]) {
      const r = Bun.spawnSync(["bash", NOTICE, "text", k, "a cause"]);
      expect(r.exitCode).toBe(0);
      const [title, msg] = r.stdout.toString().split("\n");
      expect(title.length).toBeGreaterThan(5);
      expect(msg).toContain("(a cause)");
      expect(msg).not.toContain("—");
    }
  });
});

describe("the probe's heartbeat URL", () => {
  test("unset before any child starts, read only in the probe's own subshell, never logged", () => {
    const run = readFileSync(join(import.meta.dir, "../rootfs/etc/services.d/cain/run"), "utf8");
    const unset = run.indexOf("unset HEARTBEAT_URL PROBE_PING_URL");
    expect(unset).toBeGreaterThan(0);
    for (const child of ["tmux -u new-session", "link/main.ts", "checkin.sh", "probe/main.ts", "rollback/watcher.ts"]) expect(unset).toBeLessThan(run.indexOf(child));
    expect(run.split("PROBE_PING_URL=").length).toBe(2);
    const at = run.indexOf("PROBE_PING_URL=");
    expect(run.slice(at, run.indexOf(") &", at))).toContain('bun "$OPT/probe/main.ts" loop');
    expect(run).not.toMatch(/echo[^\n]*PROBE_PING_URL|log[^\n]*PROBE_PING_URL/);
    // The watcher runs as its own user, through as-watch, never as root.
    expect(run).toContain('"$OPT/as-watch" bun "$OPT/rollback/watcher.ts" loop');
  });
});
