// Cain 0.12.2, the Ship gate's follow-ups from the twenty-ninth round's review (link/shipgate.ts, link/core.ts,
// link/main.ts): the quarantine log read in three states, the pull request taken from a quarantine's file name (and the
// set-aside command for a name that names none), the owed mark cleared only after the head is read again under the
// lock, the deadline checked before an acceptance is published, the lock quarantine taking the lock before it moves a
// lock that doesn't parse, and the card's read of the gate's head through the gate's own curl wrapper. Nothing here
// reaches GitHub or the network: curl is a local stub.
import { describe, expect, test } from "bun:test";
import { GATE_HEAD_TIMED_OUT } from "../rootfs/opt/cain/link/core";
import { GATE_RECORD_FORMAT, watchFile } from "../rootfs/opt/cain/link/merge";
import * as g from "../rootfs/opt/cain/link/shipgate";
import { PR, rig, SHA1, SHA2 } from "./link-rig";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FACTS = { head: SHA1, commits: 4, files: 12, areas: ["Cain's link"], title: "t", bumps: [{ app: "Cain", version: "0.12.2" }], merged: false };
const LINE = "Stop stays in reach of your newest message.";
const line = (head: string, pr = 5): any => ({ step: "ship_gate", head, workflow: null, reports: [], attempts_seen: [], refused_while_pending: true, accepted_early: false,
  accepted_after_pass: true, passed: true, pr, bound_head: head, accepted_head: head, failure: null, failure_why: null });
const echo = { headNow: (_p: number, h: string) => h };
const quietly = <T>(f: () => T): T => { const was = console.error; console.error = () => {}; try { return f(); } finally { console.error = was; } };
const pauseMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const mk = () => mkdtempSync(join(tmpdir(), "ship-gate-0122-"));
const logLines = (dir: string) => { try { return readFileSync(g.quarantineLog(dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const cardOf = (dir: string) => () => { const x = g.gateState(dir, 5) as any; return "heads" in x ? (x.owed ? { owed: x.owed } : x.heads) : x; };
const shipRig = (o: Parameters<typeof rig>[0] = {}) => { const r = rig({ facts: true, ...o }); r.github.facts = structuredClone(FACTS) as any; r.reviews.list = []; return r; };
const ship = async (r: ReturnType<typeof rig>) => ((await r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 })) as any).message as string;
// A curl stub: its version line, then what it prints and how it exits (or sleeps past any limit). setVersion rewrites it.
const stubCurl = (version: string, body = "", exit: number | "sleep" = 0) => {
  const d = mkdtempSync(join(tmpdir(), "stub-curl-0122-"));
  const write = (v: string) => writeFileSync(join(d, "curl"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "curl ${v} (x86_64-pc-linux-gnu)"; exit 0; fi\necho x >> ${JSON.stringify(join(d, "calls"))}\ncat ${JSON.stringify(join(d, "out"))}\n${exit === "sleep" ? "exec sleep 30" : `exit ${exit}`}\n`, { mode: 0o755 });
  writeFileSync(join(d, "out"), body);
  write(version);
  return { bin: join(d, "curl"), setVersion: write, calls: () => { try { return readFileSync(join(d, "calls"), "utf8").trim().split("\n").length; } catch { return 0; } } };
};
const page = (sha: string) => `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ head: { sha } })}`;
const BASE = "http://127.0.0.1:9";

describe("0.12.2: the quarantine log read in three states", () => {
  test("a log that is there but can't be read refuses the card by name, with no restore command; a missing log is no refusal", async () => {
    const dir = mk();
    expect(keepWatch5(dir, SHA1).accepted_head).toBe(SHA1);
    expect(g.quarantined(dir)).toEqual({ absent: true });
    expect(g.gateState(dir, 5)).toEqual({ heads: [SHA1] });
    // A record set aside by a quarantine of this pull request, cut off before its log entry, and the log unreadable
    // (a folder where the file should be: unreadable even to root).
    writeFileSync(join(dir, `ship-gate-${SHA2}.json.quarantined-pr5-abcd1234`), "{torn");
    mkdirSync(g.quarantineLog(dir));
    const q = g.quarantined(dir) as any;
    expect(q.unreadable).toContain(g.quarantineLog(dir));
    const st = g.gateState(dir, 5) as any;
    expect(st.unknown).toContain(`quarantine log (${g.quarantineLog(dir)})`);
    expect(st.unknown).not.toContain("mv -n");
    const r = shipRig({ gateWatch: cardOf(dir) });
    const err = await ship(r).catch((e) => String(e?.message ?? e));
    expect(err).toContain("state is unknown");
    expect(err).toContain(g.quarantineLog(dir));
    expect(err).not.toContain("mv -n");
    // It holds a generation that may be above every one recorded: the recovery is refused without a floor.
    expect(g.genRecorded(dir, 5).blocker).toContain(g.quarantineLog(dir));
    expect(quietly(() => g.recoverGen(dir, 5))).toMatchObject({ ok: false, why: expect.stringContaining(g.quarantineLog(dir)) });
  });
});

const keepWatch5 = (dir: string, head: string) => g.keepWatch(dir, line(head), watchFile(dir, head), echo);

describe("0.12.2: the pull request from the quarantine's file name, and the set-aside command", () => {
  test("a quarantine names its pull request in the file name, and the gate's state reads it from there, never from the text", () => {
    const dir = mk();
    writeFileSync(watchFile(dir, SHA2), `{"step": "ship_gate", "pr": 5, "gen": 1, "torn`);
    const r = g.quarantineRecord(dir, SHA2) as any;
    expect(r.ok).toBe(true);
    expect(r.as).toMatch(new RegExp(`ship-gate-${SHA2}\\.json\\.quarantined-pr5-[0-9a-f]{8}$`));
    // Cut off before its log entry (simulated: the log removed), the name alone says whose it is.
    renameSync(g.quarantineLog(dir), `${g.quarantineLog(dir)}.gone`);
    writeFileSync(r.as, `{"pr": 6, "torn`);                                         // the text claims another pull request
    expect((g.gateState(dir, 5) as any).unknown).toContain(`mv -n ${r.as} ${watchFile(dir, SHA2)}`);
    expect(g.gateState(dir, 6)).toEqual({ heads: [] });                              // the name says pull request 5
  });

  test("a set-aside file whose name names no pull request gets the set-aside command, never a restore; the command moves it to the archive folder, logged, never deleted, under the gate lock", async () => {
    const dir = mk();
    expect(keepWatch5(dir, SHA1).accepted_head).toBe(SHA1);
    const legacy = join(dir, `ship-gate-${SHA2}.json.quarantined-abcd1234`);
    writeFileSync(legacy, `{"pr": 6, "gen": 7, "torn`);
    for (const pr of [5, 6]) {
      const st = g.gateState(dir, pr) as any;
      expect(st.unknown).toContain(`--set-aside ${legacy} --pr ${pr}`);
      expect(st.unknown).not.toContain("mv -n");
    }
    // A watch of pull request 5 holds its lock: refused, nothing moved.
    const held = g.takeLock(join(dir, "ship-gate-pr-5.lock"), 100) as any;
    expect(held.token).toBeDefined();
    expect(g.setAside(dir, legacy, 5)).toMatchObject({ ok: false, why: expect.stringContaining("looks to be running") });
    expect(existsSync(legacy)).toBe(true);
    g.letGo(held);
    // A file whose name names a pull request isn't set aside this way.
    const named = join(dir, `ship-gate-${SHA2}.json.quarantined-pr5-abcd1234`);
    writeFileSync(named, "{torn");
    expect(g.setAside(dir, named, 5)).toMatchObject({ ok: false, why: expect.stringContaining("names pull request 5") });
    renameSync(named, join(mk(), "elsewhere"));                                      // out of the way for the rest
    // Through the command, as keeper.sh runs it.
    const p = Bun.spawn(["bun", join(import.meta.dir, "../rootfs/opt/cain/link/shipgate.ts"), "--set-aside", legacy, "--pr", "5", "--dir", dir], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain("nothing was deleted");
    expect(existsSync(legacy)).toBe(false);
    const kept = readdirSync(g.setAsideDir(dir));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(g.setAsideDir(dir), kept[0]), "utf8")).toBe(`{"pr": 6, "gen": 7, "torn`);
    expect(logLines(dir)).toEqual([expect.objectContaining({ file: legacy, as: join(g.setAsideDir(dir), kept[0]), pr: null, gen_max: 7, set_aside: true })]);
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);               // the lock let go
    expect(g.gateState(dir, 5)).toEqual({ heads: [SHA1] });
    expect(g.genRecorded(dir, 5).max).toBeGreaterThanOrEqual(7);                     // its generation still counted
  }, 20_000);
});

describe("0.12.2: an owed mark is cleared only once the head is read again under the lock", () => {
  test("a head that moved between the first read and the read under the lock keeps the mark, and the command fails", async () => {
    const dir = mk();
    expect(keepWatch5(dir, SHA1).accepted_head).toBe(SHA1);
    expect(await g.supersede(dir, SHA1, async () => ({ miss: "rate_limit" as const, wait_ms: 60_000 }))).toMatchObject({ ok: false, owed: true });
    const reads: (number | undefined)[] = [];
    const moved = await quietly(() => g.supersede(dir, SHA1, async (_n, deadline) => { reads.push(deadline); return reads.length === 1 ? SHA1 : SHA2; }));
    expect(moved).toMatchObject({ ok: false, why: expect.stringContaining(`moved to ${SHA2}`) });
    expect((moved as any).cleared).toBeUndefined();
    expect(reads.length).toBe(2);
    expect(reads[1]).toBeGreaterThan(Date.now() - 1_000);                          // the second read under the lock's bound
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).supersede_owed).toBeDefined();
    expect((g.gateState(dir, 5) as any).owed).toBeDefined();
    expect(existsSync(join(dir, "ship-gate-pr-5.lock"))).toBe(false);
    // A read under the lock that fails keeps it too.
    const failed = await quietly(() => g.supersede(dir, SHA1, async (_n, d) => (d === undefined ? SHA1 : { miss: "unreadable" as const, why: "GitHub didn't answer" })));
    expect(failed).toMatchObject({ ok: false, why: expect.stringContaining("the owed mark stays") });
    expect((g.gateState(dir, 5) as any).owed).toBeDefined();
    // Unchanged both times: cleared, as before.
    expect(await quietly(() => g.supersede(dir, SHA1, async () => SHA1))).toMatchObject({ cleared: true });
  });
});

describe("0.12.2: the deadline is checked before the acceptance is published", () => {
  test("a holder that reaches its write past the deadline never makes the acceptance visible: nothing is renamed into place, and no second read is made", () => {
    const dir = mk();
    let reads = 0, seen: any = "untouched";
    const k = quietly(() => g.keepWatch(dir, line(SHA1), watchFile(dir, SHA1), { criticalMs: 1_500, headNow: (_p, h) => { reads++; return h; },
      atWrite: () => pauseMs(1_700), afterWrite: () => { seen = JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).accepted_head; } }));
    expect(k).toMatchObject({ accepted_head: null, failure: "lock_unavailable" });
    expect(k.failure_why).toContain("before its acceptance was written");
    expect(seen).toBe("untouched");                                                // never published, so no post-write step
    expect(reads).toBe(1);
    expect(JSON.parse(readFileSync(watchFile(dir, SHA1), "utf8")).accepted_head).toBeNull();
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(g.acceptedFor(dir, 5)).toEqual([]);
  });
});

describe("0.12.2: the lock quarantine takes the lock before it moves a lock that doesn't parse", () => {
  test("the lock is taken in recovery mode, the garbled lock moved aside by that takeover, and the generation moved on once", () => {
    const dir = mk();
    const lock = join(dir, "ship-gate-pr-5.lock");
    writeFileSync(g.genFile(dir, 5), "3\n");
    writeFileSync(lock, `{"pid": 1, "token": "x", "gen": 3`);
    // Without the garbled mode, a lock that doesn't parse is never taken.
    expect(g.takeLock(lock, 100, { recovery: true })).toMatchObject({ miss: "unreadable" });
    const got = quietly(() => g.takeLock(lock, 100, { recovery: true, garbled: true })) as any;
    expect(got.token).toBeDefined();
    expect(got.setAside.as).toMatch(/ship-gate-pr-5\.lock\.quarantined-[0-9a-f]{8}$/);
    expect(readFileSync(got.setAside.as, "utf8")).toBe(`{"pid": 1, "token": "x", "gen": 3`);
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ token: got.token, recovery: true });
    expect(g.readGen(dir, 5)).toBe(4);
    g.letGo(got);
    // The command does the same, logged, and lets go.
    writeFileSync(lock, `{"pid": 2, "token": "y", "gen": 4`);
    const q = quietly(() => g.quarantineLock(dir, 5)) as any;
    expect(q.ok).toBe(true);
    expect(q.moved.length).toBe(1);
    expect(g.readGen(dir, 5)).toBe(5);
    expect(existsSync(lock)).toBe(false);
    expect(logLines(dir)).toEqual([expect.objectContaining({ file: lock, as: q.moved[0], pr: 5, gen_max: 4 })]);
    // A current lock that parses is a watch at work: nothing is moved.
    const held = g.takeLock(lock, 100) as any;
    writeFileSync(`${lock}.stale-zz`, `{"gen": 9, "tok`);
    expect(quietly(() => g.quarantineLock(dir, 5, { waitMs: 100 }))).toMatchObject({ ok: false, why: expect.stringContaining("took the lock meanwhile") });
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe(held.token);
    g.letGo(held);
  });
});

describe("0.12.2: the card's read of the gate's head goes through the gate's curl wrapper", () => {
  test("the link reads the head through gateHeadRead, never fetch, with the token setting named as the recommended default", () => {
    const main = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main).toMatch(/gateHead: \(pr, ms\) => \{[^\n]*gateHeadRead\(p\.repo, p\.pr/);
    expect(main).toContain("SHIP_GATE_GITHUB_TOKEN is set, the recommended default");
    expect(GATE_HEAD_TIMED_OUT).toBe(g.GATE_HEAD_TIMEOUT);
  });

  test("curl's version is read anew on every read the link makes; a read stopped at its limit is a timeout, named as the gate's state unknown", async () => {
    const c = stubCurl("8.5.0", page(SHA1));
    expect(await g.gateHeadRead("o/r", 5, { ms: 3_000, base: BASE, curl: c.bin, token: "" })).toBe(SHA1);
    c.setVersion("7.29.0");                                                         // curl replaced on the Pi meanwhile
    const old = await g.gateHeadRead("o/r", 5, { ms: 3_000, base: BASE, curl: c.bin, token: "" }) as any;
    expect(old.unknown).toContain("older than 7.32");
    expect(old.unknown).toContain("the cause is on the Pi");
    expect(c.calls()).toBe(1);
    const slow = stubCurl("8.5.0", page(SHA1), "sleep");
    const t0 = Date.now();
    expect(await g.gateHeadRead("o/r", 5, { ms: 1_500, base: BASE, curl: slow.bin, token: "" })).toEqual({ unknown: g.GATE_HEAD_TIMEOUT });
    expect(Date.now() - t0).toBeLessThan(4_000);
  }, 20_000);

  test("the blocking wrapper forgets curl's version after a local failure, so a replaced curl is read anew", () => {
    const c = stubCurl("8.5.0", "", 48);
    expect(g.ghGet("/x", { base: BASE, curl: c.bin })).toMatchObject({ miss: "local", why: expect.stringContaining("an option it doesn't know") });
    c.setVersion("7.29.0");
    expect(g.ghGet("/x", { base: BASE, curl: c.bin })).toMatchObject({ miss: "local", why: expect.stringContaining("older than 7.32") });
    expect(c.calls()).toBe(1);
  });

  test("the card: the gate's head read through gateHead, its timeout and any failed read the gate's state unknown by name, a moved head refused", async () => {
    const card = (gateHead: (pr: string, ms: number) => Promise<string | { unknown: string }>) => { const r = shipRig({ gateHead, factsMs: 300 }); r.github.watched[PR] = SHA1; return r; };
    const asked: number[] = [];
    expect(String((await card(async (_p, ms) => { asked.push(ms); return SHA1; }).link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 }) as any).status)).toBe("posted");
    expect(asked).toEqual([300]);
    await expect(ship(card(() => new Promise(() => {})))).rejects.toThrow(`the Ship gate's state is unknown for this pull request: ${GATE_HEAD_TIMED_OUT}`);
    await expect(ship(card(async () => ({ unknown: "curl isn't installed" })))).rejects.toThrow("the Ship gate's state is unknown for this pull request: curl isn't installed");
    await expect(ship(card(async () => { throw new Error("boom"); }))).rejects.toThrow("state is unknown");
    await expect(ship(card(async () => SHA2))).rejects.toThrow("GitHub has a newer head");
    // With the facts' head unreadable, the gate's own read decides.
    const r = card(async () => SHA1);
    (r.github.facts as any).head = null;
    expect(String((await r.link.ship({ text: LINE, item: "P64", pr: PR, head: SHA1 }) as any).status)).toBe("posted");
  });
});
void GATE_RECORD_FORMAT;
