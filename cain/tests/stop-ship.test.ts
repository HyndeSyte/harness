// Wave 1, pieces E and B: Stop everything (stop.ts), and his Ship tap signed
// (ship-token.ts), through the link, the RemoteTrigger hook and the review runner.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { RESUME, RESUMED_TOO, STOP, STOP_UNSAVED, STOPPED_ALONE, STOPPED_TOO } from "../rootfs/opt/cain/link/core";
import { loadShipKey, publicOf } from "../rootfs/opt/cain/link/shipkey";
import { DEFAULTS, Runner, type RunnerConfig, saveReview } from "../rootfs/opt/cain/review/runner.ts";
import { newReview } from "../rootfs/opt/cain/review/core.ts";
import { claimFor, findToken, makeToken, publicKey, readToken, TTL_S } from "../rootfs/opt/cain/ship-token";
import { ensureStop, readStop, writeStop } from "../rootfs/opt/cain/stop";
import { keeperHolds, MIN, PR, rig, SHA1, SHA2, SHIP_KEYS, SHIP_PUB } from "./link-rig";

const snap = (m: any) => JSON.parse(JSON.stringify(m));
const ship = async (r: ReturnType<typeof rig>, head = SHA1) =>
  ((await r.link.ship({ text: "P41: Cain 0.8.0 ready.", item: "P41", pr: PR, head })) as any).message as string;
const KEY = publicKey(SHIP_PUB);

describe("Ship tokens", () => {
  test("a token is his tap for one pull request and head, for 2 hours, under the link's key only", () => {
    const now = Date.UTC(2026, 10, 12, 15, 0);
    const claim = claimFor(PR, SHA1.toUpperCase(), now)!;
    expect(claim).toEqual({ v: 1, repo: "HyndeSyte/harness", pr: 5, head: SHA1, exp: now / 1000 + TTL_S });
    const token = makeToken(claim, (d) => edSign(null, d, SHIP_KEYS.privateKey));
    expect(readToken(token, KEY, now)).toEqual({ ok: true, claim });
    expect(readToken(token, KEY, now + 119 * MIN).ok).toBe(true);
    expect(readToken(token, KEY, now + 120 * MIN)).toEqual({ ok: false, why: expect.stringContaining("expired") });
    // Another key's token, a changed claim, or a cut-off token: none of them read.
    const other = generateKeyPairSync("ed25519");
    expect(readToken(makeToken(claim, (d) => edSign(null, d, other.privateKey)), KEY, now))
      .toEqual({ ok: false, why: expect.stringContaining("signature") });
    const [p, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claim, head: SHA2 })).toString("base64url");
    expect(readToken(`${p}.${forged}.${sig}`, KEY, now).ok).toBe(false);
    expect(readToken(`${p}.${payload}.${sig.slice(0, 40)}`, KEY, now).ok).toBe(false);
    expect(readToken("ship1.x.y", KEY, now).ok).toBe(false);
    // Found standing on its own in a job's text, not inside a longer word.
    expect(findToken(`Ship it. Ship token: ${token}. Post it first.`)).toBe(token);
    expect(findToken(`xship1.${payload}.${sig}`)).toBeNull();
    expect(claimFor("https://github.com/HyndeSyte/harness/pulls", SHA1, now)).toBeNull();
    expect(claimFor(PR, "abc123", now)).toBeNull();
    expect(() => publicKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64")))
      .toThrow("Ed25519");
  });

  test("his Ship tap, once it's in main, carries a token for that pull request and head; Not now carries none", async () => {
    const r = rig();
    const id = await ship(r);
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.github.main).toEqual([SHA1]);
    const token = findToken(r.relayed[0])!;
    expect(r.relayed[0]).toContain(`Ship token: ${token} (good for 2 hours`);
    expect(readToken(token, KEY, r.t.now)).toEqual({ ok: true, claim: claimFor(PR, SHA1, r.t.now) });
    expect(r.msg(id).content).toBe("P41: Cain 0.8.0 ready.\n\nShipped: it's in main as of 8:00 AM. Installing it is next.");
    const no = await ship(r, SHA2);
    await r.tap(snap(r.msg(no)), r.ids(no)[1]);
    expect(findToken(r.relayed[1])).toBeNull();
    expect(r.github.landings).toHaveLength(1);
  });

  test("with no Ship key, it lands but says so, and carries nothing a Ship run would take", async () => {
    const r = rig({ noKey: true });
    const id = await ship(r);
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.relayed[0]).toContain("no Ship key");
    expect(findToken(r.relayed[0])).toBeNull();
  });

  test("with no deploy key, nothing lands, and Cain hears shipping is down", async () => {
    const r = rig({ noDeployKey: true });
    const id = await ship(r);
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toBe("P41: Cain 0.8.0 ready.\n\nYou tapped Ship, but shipping is down right now, so nothing shipped.");
    expect(r.relayed[0]).toContain("The link has no deploy key, so nothing can land in main");
    expect(findToken(r.relayed[0])).toBeNull();
  });
});

describe("Stop everything", () => {
  test("his Stop tap stops Cain's side and goes on to the calendar specialist; Turn back on undoes it", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.stop.stopped).toBe(true);
    expect(r.harness.at(-1)).toEqual(["/press", expect.objectContaining({ custom_id: STOP })]);
    expect(r.relayed.at(-1)).toContain("Dane tapped Stop. Everything of yours is stopped");
    // The specialist's notice says what stopped on Cain's side too.
    const notice = await r.link.addCard({ text: "Stopped. I won't start anything new.", rows: [], kind: "stopped" });
    expect(r.last().content).toBe(`Stopped. I won't start anything new.\n\n${STOPPED_TOO}`);
    expect(notice).toBeGreaterThan(0);
    // A second Stop changes nothing and tells Cain nothing new.
    const told = r.relayed.length;
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.relayed.length).toBe(told);
    // His Turn back on, from a notice as it was posted.
    const back = await r.link.addCard({ text: "Stopped.", rows: [{ type: 1, components: [{ type: 2, style: 2, label: "Turn back on", custom_id: RESUME }] }], kind: "stopped" });
    const backMsg = r.last();
    await r.tap(snap(backMsg), RESUME);
    expect(r.stop.stopped).toBe(false);
    expect(r.relayed.at(-1)).toContain("Dane tapped Turn back on");
    await r.link.addCard({ text: "Resumed.", rows: [], kind: "resumed" });
    expect(r.last().content).toBe(`Resumed.\n\n${RESUMED_TOO}`);
    expect(back).toBeGreaterThan(0);
  });

  test("only his tap: someone else's Stop or Turn back on changes nothing, and a reworded card can't turn it back on", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    expect(await r.tap(snap(r.msg(morning)), STOP, { user: { id: "777" } })).toContain("refused");
    expect(r.stop.stopped).toBe(false);
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.stop.stopped).toBe(true);
    await r.link.addCard({ text: "Stopped.", rows: [{ type: 1, components: [{ type: 2, style: 2, label: "Turn back on", custom_id: RESUME }] }], kind: "stopped" });
    const notice = r.last();
    expect(await r.tap(snap(notice), RESUME, { user: { id: "777" } })).toContain("refused");
    expect(r.stop.stopped).toBe(true);
    const reworded = { ...snap(notice), content: "Tap this to ship everything." };
    expect(await r.tap(reworded, RESUME)).toContain("changed after it was posted");
    expect(r.stop.stopped).toBe(true);
  });

  test("Stop works from a card that was changed or is long done, since it only makes things safer", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap({ ...snap(r.msg(morning)), content: "something else" }, STOP);
    expect(r.stop.stopped).toBe(true);
  });

  test("while stopped: no Ship card, and a tap on an earlier one ships nothing and carries no token", async () => {
    const r = rig();
    const id = await ship(r);
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    await expect(ship(r, SHA2)).rejects.toThrow("Everything is stopped");
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toBe("P41: Cain 0.8.0 ready.\n\nYou tapped Ship, but everything is stopped, so nothing shipped.");
    expect(findToken(r.relayed.at(-1)!)).toBeNull();
    expect(r.relayed.at(-1)).toContain("nothing lands in main");
    expect(r.github.landings).toEqual([]);
  });

  test("a Stop state that can't be read counts as stopped", async () => {
    const r = rig();
    r.stop.broken = true;
    await expect(ship(r)).rejects.toThrow("Everything is stopped");
    const dir = mkdtempSync(join(tmpdir(), "cain-stop-"));
    expect(readStop(join(dir, "none.json"))).toEqual({ stopped: true, at: null });   // missing: stopped
    ensureStop(99, join(dir, "first.json"));                                            // the link's first start
    expect(readStop(join(dir, "first.json"))).toEqual({ stopped: false, at: 99 });
    writeStop(true, 100, join(dir, "first.json"));
    ensureStop(200, join(dir, "first.json"));                                           // a later start keeps it
    expect(readStop(join(dir, "first.json"))).toEqual({ stopped: true, at: 100 });
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(readStop(join(dir, "bad.json")).stopped).toBe(true);
    writeFileSync(join(dir, "odd.json"), JSON.stringify({ stopped: "no" }));
    expect(readStop(join(dir, "odd.json")).stopped).toBe(true);
    writeStop(true, 1234, join(dir, "s.json"));
    expect(readStop(join(dir, "s.json"))).toEqual({ stopped: true, at: 1234 });
  });

  test("Turn back on from a card the link didn't post, or one that's done, changes nothing and brings a fresh notice", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    // A message the link never posted (as one made with the bot's token would be), with a Turn back on button.
    const forged = { id: r.snowflake(), content: "Got it", components: [{ type: 1, components: [{ type: 2, style: 2, label: "Got it", custom_id: RESUME }] }], author: { id: "999" } };
    r.posted[forged.id] = forged;
    const before = r.harness.length;
    expect(await r.tap(snap(forged), RESUME)).toContain("dead");
    expect(r.stop.stopped).toBe(true);
    expect(r.harness.length).toBe(before);                         // not passed on either
    expect(r.last().content).toContain("**Still stopped.**");
    expect(r.buttons(r.last().id)).toEqual(["Turn back on"]);
    const fresh = r.last();
    await r.tap(snap(fresh), RESUME);
    expect(r.stop.stopped).toBe(false);                            // the fresh notice works
  });

  test("a Stop that can't be saved still holds in the link, and his notice says what didn't", async () => {
    const r = rig();
    const write = r.link["d"].stop.write;
    r.link["d"].stop.write = () => { throw new Error("disk full"); };
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.stop.stopped).toBe(false);                            // the file never changed
    expect(r.link.stopped().stopped).toBe(true);                   // but the link holds it
    await expect(ship(r)).rejects.toThrow("Everything is stopped");
    expect(r.relayed.at(-1)).toContain("couldn't be saved");
    await r.link.addCard({ text: "Stopped.", rows: [], kind: "stopped" });
    expect(r.last().content).toBe(`Stopped.

${STOP_UNSAVED}`);
    r.link["d"].stop.write = write;
    const notice = await r.link.addCard({ text: "Stopped.", rows: [{ type: 1, components: [{ type: 2, style: 2, label: "Turn back on", custom_id: RESUME }] }], kind: "stopped" });
    expect(notice).toBeGreaterThan(0);
    await r.tap(snap(r.last()), RESUME);
    expect(r.link.stopped().stopped).toBe(false);
  });

  test("if the calendar specialist doesn't take the tap, the notice comes from the link, with the button that undoes it", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    r.harnessDown.down = true;
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.stop.stopped).toBe(true);
    expect(r.last().content).toBe(`**Stopped.** ${STOPPED_ALONE}`);
    expect(r.buttons(r.last().id)).toEqual(["Turn back on"]);
    const notice = r.last();
    await r.tap(snap(notice), RESUME);
    expect(r.stop.stopped).toBe(false);
    expect(r.buttons(r.last().id)).toEqual(["Stop"]);
  });
});

describe("the RemoteTrigger hook, with Stop and signed Ship", () => {
  const holds = keeperHolds({ P41: { holder: "cain", branches: ["claude/one-voice-cards"], job: "ship" } });
  const now = Date.UTC(2026, 10, 12, 15, 0);
  const running = { pub: SHIP_PUB, stop: { stopped: false, at: null }, now };
  const tokenFor = (pr = PR, head = SHA1, at = now, key = SHIP_KEYS.privateKey) =>
    makeToken(claimFor(pr, head, at)!, (d) => edSign(null, d, key));
  const run = (text: string) => ({ tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: SHIP, body: { text } } });
  const job = (token: string, pr = PR, head = SHA1) =>
    `Install pull request ${pr}, landed in main at ${head}. Ship token: ${token}. Dane tapped Ship at 10:00.`;

  test("a Ship run needs his token for that pull request and head, still in time", () => {
    expect(decide(run(job(tokenFor())), holds, running)).toBe("");
    expect(decide(run(job("").replace("Ship token: .", "")), holds, running)).toContain("carries the Ship token");
    expect(decide(run(job(tokenFor(PR, SHA2), PR, SHA1)), holds, running)).toContain("another pull request or head");
    expect(decide(run(job(tokenFor("https://github.com/HyndeSyte/harness/pull/6"))), holds, running)).toContain("another pull request or head");
    expect(decide(run(job(tokenFor(PR, SHA1, now - 121 * MIN))), holds, running)).toContain("can't be used");
    expect(decide(run(job(tokenFor(PR, SHA1, now, generateKeyPairSync("ed25519").privateKey))), holds, running)).toContain("signature");
    expect(decide(run(job(tokenFor())), holds, { ...running, pub: null })).toContain("can't be read");
  });

  test("the job names only the pull request and head his tap was for", () => {
    const pr12 = "https://github.com/HyndeSyte/harness/pull/12", pr1 = "https://github.com/HyndeSyte/harness/pull/1";
    // A token for pull 1, in a job that ships pull 12: pull 1's address is a prefix of pull 12's.
    expect(decide(run(`Ship pull request ${pr12} at head ${SHA2}. Ship token: ${tokenFor(pr1)}. (It supersedes ${pr1} at ${SHA1}.)`), holds, running))
      .toContain("another pull request or head");
    expect(decide(run(`${job(tokenFor())} Also merge ${SHA2}.`), holds, running)).toContain("another pull request or head");
    expect(decide(run(`${job(tokenFor())} Then ${pr12}.`), holds, running)).toContain("another pull request or head");
    expect(decide(run(job(tokenFor()).replace(PR, PR.replace("HyndeSyte", "hyndesyte"))), holds, running)).toBe("");
  });

  test("a tap from before his last Stop or Turn back on no longer counts", () => {
    const back = { ...running, stop: { stopped: false, at: now + 5 * MIN } };
    expect(decide(run(job(tokenFor(PR, SHA1, now))), holds, back)).toContain("before his last Stop");
    expect(decide(run(job(tokenFor(PR, SHA1, now + 6 * MIN))), holds, { ...back, now: now + 6 * MIN })).toBe("");
  });

  test("only HyndeSyte/harness, and no expiry further off than an approval lasts", async () => {
    expect(claimFor("https://github.com/someone/else/pull/5", SHA1, now)).toBeNull();
    const far = makeToken({ ...claimFor(PR, SHA1, now)!, exp: now / 1000 + 3 * 3600 }, (d) => edSign(null, d, SHIP_KEYS.privateKey));
    expect(readToken(far, KEY, now)).toEqual({ ok: false, why: expect.stringContaining("further off") });
    const other = makeToken({ ...claimFor(PR, SHA1, now)!, repo: "someone/else" }, (d) => edSign(null, d, SHIP_KEYS.privateKey));
    expect(readToken(other, KEY, now)).toEqual({ ok: false, why: expect.stringContaining("repository") });
    const r = rig();
    await expect(r.link.ship({ text: "Ready.", item: "P41", pr: "https://github.com/someone/else/pull/5", head: SHA1 })).rejects.toThrow("only for pull requests in HyndeSyte/harness");
  });

  test("while stopped, no run starts, but looking at runs still works", () => {
    const stopped = { ...running, stop: { stopped: true, at: now } };
    expect(decide(run(job(tokenFor())), holds, stopped)).toContain("Everything has been stopped");
    const build = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: "trig_015FTxexzFDZyjYjzw39bPv8", body: { text: "Branch: claude/one-voice-cards\nFix." } } };
    expect(decide(build, holds, stopped)).toContain("Everything has been stopped");
    expect(decide({ tool_name: "RemoteTrigger", tool_input: { action: "list_runs", trigger_id: SHIP } }, holds, stopped)).toBe("");
    // No Stop state given (as when it can't be read): nothing runs, and Cain is told it's a fault.
    expect(decide(run(job(tokenFor())), holds, { pub: SHIP_PUB, now })).toContain("can't be read");
  });

  test("runs as Claude Code calls it, reading the key and the Stop state from their files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-hook-"));
    writeFileSync(join(dir, "holds.json"), holds);
    writeFileSync(join(dir, "ship.pub"), `${SHIP_PUB}\n`);
    const hook = async (input: unknown, stopped: boolean | null) => {
      if (stopped !== null) writeStop(stopped, Date.now() - MIN, join(dir, "stop.json"));   // changed a minute ago
      const p = Bun.spawn(["bun", join(import.meta.dir, "../rootfs/opt/cain/hooks/remote-trigger.ts")],
        { stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe",
          env: { ...process.env, CAIN_HOLDS: join(dir, "holds.json"), CAIN_SHIP_PUB: join(dir, "ship.pub"), CAIN_STOP_FILE: join(dir, "stop.json") } });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string : "";
    };
    const good = run(job(tokenFor(PR, SHA1, Date.now())));
    expect(await hook(good, null)).toContain("Nothing runs");            // no Stop file: nothing runs
    expect(await hook(good, true)).toContain("Everything has been stopped");
    expect(await hook(good, false)).toBe("");
  });
});

describe("outside reviews while stopped", () => {
  test("nothing is sent and nothing is given up; it goes once he turns it back on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-stop-"));
    const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
      termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue") };
    writeFileSync(cfg.termsFile, "Acme Corp\n");
    let stopped = true, calls = 0;
    const seat = async () => { calls++; return { verdict: "approve" as const, findings: [], model: "m", cost_usd: 0 }; };
    const runner = new Runner(cfg, { seats: { openai: seat }, log: () => {}, stopped: () => stopped,
      now: () => new Date("2026-11-12T15:00:00Z"), rand: () => 0.5 });
    const r = newReview({ id: "2026-11-12-stop", topic: "t", question: "q?", body: "b", needs_facts: false, consequential: false, seats: ["openai"] } as any,
      new Date("2026-11-12T15:00:00Z"));
    saveReview(cfg.queueDir, r);
    await runner.tick();
    expect(calls).toBe(0);
    await expect(runner.selftest()).rejects.toThrow("stopped");
    stopped = false;
    await runner.tick();
    expect(calls).toBe(1);
    const broken = new Runner(cfg, { seats: { openai: seat }, log: () => {}, stopped: () => { throw new Error("x"); } });
    expect(broken.isStopped()).toBe(true);
  });
});


describe("second review round (Opus, Nov 12)", () => {
  test("Stop in the middle of a tick: no later seat or review is called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-stop2-"));
    const cfg: RunnerConfig = { ...DEFAULTS, queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "health.json"),
      termsFile: join(dir, "terms.txt"), recordQueue: join(dir, "record-queue"), relayFile: join(dir, "relay.queue") };
    writeFileSync(cfg.termsFile, "Acme Corp\n");
    let stopped = false, calls = 0;
    const seat = async () => { calls++; stopped = true; return { verdict: "approve" as const, findings: [], model: "m", cost_usd: 0 }; };
    const runner = new Runner(cfg, { seats: { openai: seat, claude: seat }, log: () => {}, stopped: () => stopped,
      now: () => new Date("2026-11-12T15:00:00Z"), rand: () => 0.5 });
    for (const id of ["2026-11-12-a", "2026-11-12-b"])
      saveReview(cfg.queueDir, newReview({ id, topic: "t", question: "q?", body: "b", needs_facts: false, consequential: false, seats: ["openai"] } as any,
        new Date("2026-11-12T15:00:00Z")));
    await runner.tick();
    expect(calls).toBe(1);                                   // the second review waits
    stopped = false; calls = 0;
    const st = new Runner(cfg, { seats: { openai: seat, claude: seat }, log: () => {}, stopped: () => stopped, unavailable: () => null });
    await expect(st.selftest()).rejects.toThrow("stopped");
    expect(calls).toBe(1);                                   // the nightly check stops at the next seat
  });

  test("a Stop the calendar specialist missed is passed on once it answers, unless things changed since", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    r.harnessDown.down = true;
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.state().toggle).toBe(STOP);
    await r.link.sweep();                                    // still down: still owed
    expect(r.state().toggle).toBe(STOP);
    r.harnessDown.down = false;
    const n = r.harness.length;
    await r.link.sweep();
    expect(r.harness.slice(n)).toEqual([["/press", { custom_id: STOP, message_id: 0 }]]);
    expect(r.state().toggle).toBeUndefined();
    // Owed a Stop, but he turned it back on meanwhile: nothing is sent.
    const r2 = rig();
    const m2 = await r2.link.morning("## Thu Nov 12");
    r2.harnessDown.down = true;
    await r2.tap(snap(r2.msg(m2)), STOP);
    r2.stop.stopped = false;
    r2.harnessDown.down = false;
    const n2 = r2.harness.length;
    await r2.link.sweep();
    expect(r2.harness.length).toBe(n2);
    expect(r2.state().toggle).toBeUndefined();
  });

  test("only a change is saved: a second Stop or Turn back on keeps the time, so a fresh Ship tap still counts", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    const at = r.stop.at;
    r.later(5 * MIN);
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.stop.at).toBe(at);
  });

  test("the morning message's button follows Stop, and Turn back on works from it", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    expect(r.buttons(morning)).toEqual(["Stop"]);
    await r.tap(snap(r.msg(morning)), STOP);
    expect(r.buttons(morning)).toEqual(["Turn back on"]);
    await r.tap(snap(r.msg(morning)), RESUME);
    expect(r.stop.stopped).toBe(false);
    expect(r.buttons(morning)).toEqual(["Stop"]);
    // One posted while stopped carries Turn back on from the start.
    r.stop.stopped = true; r.stop.at = r.t.now;
    const later = await r.link.morning("## Fri Nov 13");
    expect(r.buttons(later)).toEqual(["Turn back on"]);
  });

  test("the specialist's notice gets a line about Cain's side only after his tap changed it", async () => {
    const r = rig();
    const morning = await r.link.morning("## Thu Nov 12");
    await r.tap(snap(r.msg(morning)), STOP);
    await r.link.addCard({ text: "Stopped.", rows: [], kind: "stopped" });
    expect(r.last().content).toBe(`Stopped.\n\n${STOPPED_TOO}`);
    await r.link.addCard({ text: "Not stopped. Nothing to resume.", rows: [], kind: "resumed" });
    expect(r.last().content).toBe("Not stopped. Nothing to resume.");    // nothing of Cain's changed
    r.later(11 * MIN);
    await r.link.addCard({ text: "Stopped.", rows: [], kind: "stopped" });
    expect(r.last().content).toBe("Stopped.");                           // not after a tap of his now
    expect(RESUMED_TOO).not.toContain("cards can run");
  });

  test("with no Ship key, his Ship card says it's in main but not installed", async () => {
    const r = rig({ noKey: true });
    const id = await ship(r);
    await r.tap(snap(r.msg(id)), r.ids(id)[0]);
    expect(r.msg(id).content).toBe("P41: Cain 0.8.0 ready.\n\nShipped: it's in main as of 8:00 AM. Installing it is down right now, so it isn't installed yet.");
  });

  test("the Ship key: made once, kept, and remade when it can't be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-shipkey-"));
    const lines: string[] = [];
    const key = join(dir, "ship.key"), pub = join(dir, "ship.pub");
    const a = loadShipKey(key, pub, (l) => lines.push(l), () => 1)!;
    expect(a.remade).toBe(false);
    expect(readFileSync(pub, "utf8").trim()).toBe(a.pub);
    expect(lines.some((l) => l.includes(a.pub))).toBe(true);
    expect(lines.join(" ")).not.toContain("PRIVATE");
    const b = loadShipKey(key, pub, () => {}, () => 2)!;
    expect(b.pub).toBe(a.pub);
    writeFileSync(key, "not a key");
    const c = loadShipKey(key, pub, (l) => lines.push(l), () => 3)!;
    expect(c.remade).toBe(true);
    expect(c.pub).not.toBe(a.pub);
    expect(readFileSync(pub, "utf8").trim()).toBe(c.pub);
    expect(existsSync(`${key}.bad-3`)).toBe(true);
    expect(publicOf(c.key)).toBe(c.pub);
  });
});
