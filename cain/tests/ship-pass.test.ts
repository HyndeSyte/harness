// The Ship pass (Cain 0.19.0, with Keeper 0.1.3 and 0.1.4): the RemoteTrigger hook lets one Ship run
// through per token, and only once the keeper App accepted every watched install (its backup made and
// verified); the link keeps the ids and their state (link/ship-pass.ts, hooks/remote-trigger.ts decideAll).
import { describe, expect, test } from "bun:test";
import { createHash, sign as edSign } from "node:crypto";
import { decideAll, postShipPass, SHIP } from "../rootfs/opt/cain/hooks/remote-trigger";
import { claimFor, makeToken } from "../rootfs/opt/cain/ship-token";
import { PASS_WAIT_MS, passId, registerInstalls, shipPass, type PassDeps, type RegResult } from "../rootfs/opt/cain/link/ship-pass";
import { CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth";
import { SHIP_KEYS, SHIP_PUB, keeperHolds } from "./link-rig";
import { generateKeyPairSync } from "node:crypto";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PR = "https://github.com/HyndeSyte/harness/pull/46";
const NOW = Date.now();
const TOKEN = makeToken(claimFor(PR, SHA, NOW)!, (d) => edSign(null, d, SHIP_KEYS.privateKey));
const SHIP_TEXT = `Install pull request ${PR}, landed in main at ${SHA}. Ship token: ${TOKEN}. Dane tapped Ship at 9:40.`;
const call = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: SHIP, body: { text: SHIP_TEXT } } };
const ENV = { pub: SHIP_PUB, stop: { stopped: false, at: null }, now: NOW };

const ACCEPTED: RegResult = { ok: true, accepted: [{ app: "0fcc2575_cain", attempt: "ship-46-cain-01234567", backup: "kb1" }], said: [] };
// The link's pass with a fake keeper: "accept" answers at once, "refuse" refuses, "hold" keeps the answer
// until the test gives it (the keeper still making the backup).
function link(o: { file?: string | null; storeFails?: boolean; reg?: "accept" | "refuse" | "hold" } = {}) {
  let file: string | null = o.file ?? null;
  let now = NOW;
  const registered: string[] = [];
  const logs: string[] = [];
  let held: ((r: RegResult) => void) | null = null;
  const d: PassDeps = {
    pub: () => SHIP_PUB, now: () => now, load: () => file,
    store: (t) => { if (o.storeFails) throw new Error("disk"); file = t; },
    register: (tok, _c, done) => {
      registered.push(tok);
      if ((o.reg ?? "accept") === "accept") done(ACCEPTED);
      else if (o.reg === "refuse") done({ ok: false, said: ["the keeper refused Cain 0.19.0: its backup failed"] });
      else held = done;
    },
    log: (l) => logs.push(l),
  };
  return { d, registered, logs, get file() { return file; }, answer(r: RegResult) { held!(r); }, advance(ms: number) { now += ms; } };
}

describe("the hook lets one Ship run through per token", () => {
  test("the first Ship run on a token passes; a second on the same token is refused", async () => {
    const l = link();
    const pass = async (tok: string) => { const a = shipPass(l.d, { token: tok }); return a.status === "ok" ? { ok: true as const } : { ok: false as const, why: a.said }; };
    const go = () => decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(await go()).toBe("");
    expect(l.registered).toEqual([TOKEN]);
    const again = await go();
    expect(again).toContain("The link didn't let this Ship run start");
    expect(again).toContain("already started a Ship run");
    expect(l.registered).toEqual([TOKEN]);
  });
  test("(Keeper 0.1.4) the run waits for the keeper's acceptance: pending refuses with a try-again line, then one run passes", async () => {
    const l = link({ reg: "hold" });
    const pass = async (tok: string) => { const a = shipPass(l.d, { token: tok }); return a.status === "ok" ? { ok: true as const } : a.status === "pending" ? { ok: false as const, pending: true as const, why: a.said } : { ok: false as const, why: a.said }; };
    const go = () => decideAll(call, keeperHolds({}), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    const first = await go();
    expect(first).toContain("This Ship run hasn't started yet");
    expect(first).toContain("start the same Ship run again in a minute");
    expect(await go()).toContain("hasn't started yet");
    expect(l.registered).toEqual([TOKEN]);                 // registered once, however often it is asked
    l.answer(ACCEPTED);
    expect(await go()).toBe("");
    expect(await go()).toContain("already started a Ship run");
  });
  test("(Keeper 0.1.4) a keeper refusal, or no acceptance within the wait, refuses the pass for good", async () => {
    const r = link({ reg: "refuse" });
    const a = shipPass(r.d, { token: TOKEN });
    expect(a.status).toBe("refused");
    expect((a as any).said).toContain("its backup failed");
    expect(shipPass(r.d, { token: TOKEN }).status).toBe("refused");
    const slow = link({ reg: "hold" });
    expect(shipPass(slow.d, { token: TOKEN }).status).toBe("pending");
    slow.advance(PASS_WAIT_MS + 1_000);
    const late = shipPass(slow.d, { token: TOKEN });
    expect(late.status).toBe("refused");
    expect((late as any).said).toContain("within 6 minutes");
    slow.answer(ACCEPTED);                                 // an acceptance after the pass gave up isn't kept
    expect(shipPass(slow.d, { token: TOKEN }).status).toBe("refused");
  });
  test("(Keeper 0.1.4) the hook asks again while pending, within its budget, and lets the run through on ok", async () => {
    let n = 0;
    const fake = (async () => new Response(JSON.stringify(++n < 3 ? { status: "pending", said: "the keeper is taking the backup" } : { status: "ok" }), { status: 200 })) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "k", fetch: fake, pauseMs: 1 })).toEqual({ ok: true });
    expect(n).toBe(3);
    const always = (async () => new Response(JSON.stringify({ status: "pending", said: "the keeper is taking the backup" }), { status: 200 })) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "k", fetch: always, pauseMs: 5, budgetMs: 30 })).toEqual({ ok: false, pending: true, why: "the keeper is taking the backup" });
  });
  test("a run the checks refuse never spends its token; a Build run never asks for a pass", async () => {
    let asked = 0;
    const pass = async () => { asked++; return { ok: true as const }; };
    const stopped = await decideAll(call, keeperHolds({}), { ...ENV, stop: { stopped: true, at: NOW } }, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(stopped).not.toBe("");
    const build = { tool_name: "RemoteTrigger", tool_input: { action: "run", trigger_id: "trig_015FTxexzFDZyjYjzw39bPv8", body: { text: "Branch: claude/x\nLabel: core" } } };
    await decideAll(build, keeperHolds({ P1: { holder: "cain", branches: ["claude/x"] } }), ENV, () => ({ ok: true }), async () => ({ logged: true }), pass);
    expect(asked).toBe(0);
  });
  test("a link that doesn't answer refuses the run", async () => {
    const p = await postShipPass(TOKEN, { key: "k", url: "http://127.0.0.1:1", ms: 500 });
    expect(p.ok).toBe(false);
    const nokey = await postShipPass(TOKEN, { keyFile: "/nonexistent/cain.key" });
    expect(nokey).toEqual({ ok: false, why: "this start has no key for the link" });
  });
  test("the hook asks with Cain's key, and only an \"ok\" answer counts", async () => {
    const seen: any[] = [];
    const fake = (status: string) => (async (url: any, init: any) => { seen.push({ url: String(url), key: init.headers["x-harness-key"], body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status, said: "no" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await postShipPass(TOKEN, { key: "cainkey", fetch: fake("ok") })).toEqual({ ok: true });
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:8097/ship-pass", key: "cainkey", body: { token: TOKEN } });
    expect((await postShipPass(TOKEN, { key: "cainkey", fetch: fake("spent") })).ok).toBe(false);
  });
});

describe("the link's pass", () => {
  test("records the token's id (never the token) before it answers ok, and registers the installs", () => {
    const l = link();
    const a = shipPass(l.d, { token: TOKEN });
    expect(a).toEqual({ status: "ok", pr: 46, head: SHA, accepted: ACCEPTED.ok ? ACCEPTED.accepted : [] });
    expect(l.file).toContain(passId(TOKEN));
    expect(l.file).not.toContain(TOKEN);
    expect(l.registered.length).toBe(1);
  });
  test("refuses a forged token, a spent one, an unreadable record and a record it can't write", () => {
    const other = generateKeyPairSync("ed25519");
    const forged = makeToken(claimFor(PR, SHA, NOW)!, (d) => edSign(null, d, other.privateKey));
    expect(shipPass(link().d, { token: forged }).status).toBe("refused");
    const l = link(); shipPass(l.d, { token: TOKEN });
    expect(shipPass(l.d, { token: TOKEN }).status).toBe("spent");
    expect(shipPass(link({ file: "garbage" }).d, { token: TOKEN }).status).toBe("refused");
    // a format 1 record (Keeper 0.1.3's link) still counts its tokens as spent
    expect(shipPass(link({ file: JSON.stringify({ format: 1, spent: [{ id: passId(TOKEN), exp: 9e9 }] }) }).d, { token: TOKEN }).status).toBe("spent");
    const w = link({ storeFails: true });
    expect(shipPass(w.d, { token: TOKEN }).status).toBe("refused");
    expect(w.registered).toEqual([]);
  });
  test("/ship-pass is one of Cain's routes, and only his", () => {
    expect(CAIN_ROUTES.has("/ship-pass")).toBe(true);
    expect(routeAllowed("cain", "/ship-pass")).toBe(true);
    expect(routeAllowed("specialist", "/ship-pass")).toBe(false);
    expect(routeAllowed("root", "/ship-pass")).toBe(false);
  });
});

describe("the registration with the keeper App (POST /attempt)", () => {
  const b64 = (t: string) => ({ content: Buffer.from(t).toString("base64"), encoding: "base64" });
  const files: Record<string, any> = {
    [`cain/config.yaml@${BASE}`]: b64('version: "0.18.0"\n'), [`cain/config.yaml@${SHA}`]: b64('version: "0.19.0"\n'),
    [`harness/config.yaml@${BASE}`]: b64('version: "0.30.0"\n'), [`harness/config.yaml@${SHA}`]: b64('version: "0.31.0"\n'),
    [`cain/rootfs/opt/cain/probe/keeper.ts@${SHA}`]: b64("// the probe\n"),
  };
  const api = async (path: string) => {
    if (path === "/repos/HyndeSyte/harness/pulls/46") return { status: 200, body: { base: { sha: BASE } } };
    const m = /^\/repos\/HyndeSyte\/harness\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    const f = m ? files[`${m[1]}@${m[2]}`] : undefined;
    return f ? { status: 200, body: f } : { status: 404, body: null };
  };
  const acceptance = { status: "accepted", id: "ship-46-cain-01234567", app: "0fcc2575_cain", from_version: "0.18.0", to_version: "0.19.0", backup: "kb1", until: "x" };
  test("each watched App the tap installs: the token, its pull request and head, both versions and the probe hash; ok only on its acceptance with a backup slug", async () => {
    const posted: any[] = [];
    const c = (claimFor(PR, SHA, NOW))!;
    const r = await registerInstalls({ api, log: () => {}, post: async (b) => { posted.push(b); return { status: 200, body: acceptance }; } }, TOKEN, c);
    expect(posted).toEqual([{ token: TOKEN, app: "0fcc2575_cain", pr: 46, head: SHA, from_version: "0.18.0", to_version: "0.19.0", kind: "ship",
      probe_hash: createHash("sha256").update("// the probe\n").digest("hex").slice(0, 16) }]);
    expect(r).toEqual({ ok: true, accepted: [{ app: "0fcc2575_cain", attempt: "ship-46-cain-01234567", backup: "kb1" }], said: ["Cain 0.18.0 to 0.19.0 accepted as ship-46-cain-01234567, backup kb1"] });
  });
  test("every watched App the pull request changes must be accepted: a refusal, no answer, an answer without a backup, or an unreadable base refuses", async () => {
    const c = (claimFor(PR, SHA, NOW))!;
    expect(await registerInstalls({ api, log: () => {}, post: async () => ({ status: 409, body: { why: "a replay" } }) }, TOKEN, c)).toEqual({ ok: false, said: ["the keeper refused Cain 0.19.0: a replay"] });
    expect(await registerInstalls({ api, log: () => {}, post: async () => null }, TOKEN, c)).toEqual({ ok: false, said: ["the keeper didn't answer for Cain 0.19.0"] });
    expect((await registerInstalls({ api, log: () => {}, post: async () => ({ status: 200, body: { ...acceptance, backup: "" } }) }, TOKEN, c)).ok).toBe(false);
    expect((await registerInstalls({ api, log: () => {}, post: async () => ({ status: 202, body: { id: "ship-46-cain-01234567" } }) }, TOKEN, c)).ok).toBe(false);
    expect((await registerInstalls({ api, log: () => {}, post: async () => ({ status: 200, body: { ...acceptance, to_version: "0.20.0" } }) }, TOKEN, c)).ok).toBe(false);
    const none = await registerInstalls({ api: async () => ({ status: 500, body: null }), log: () => {}, post: async () => { throw new Error("never"); } }, TOKEN, c);
    expect(none.ok).toBe(false);
    expect(none.said[0]).toContain("nothing was registered");
  });
  test("a pull request that changes no watched App passes with nothing to accept", async () => {
    const c = (claimFor(PR, SHA, NOW))!;
    const harnessOnly = async (path: string) => path.includes("cain/config.yaml") && path.endsWith(SHA) ? { status: 200, body: b64('version: "0.18.0"\n') } : api(path);
    let posted = 0;
    const r = await registerInstalls({ api: harnessOnly, log: () => {}, post: async () => { posted++; return null; } }, TOKEN, c);
    expect(r).toEqual({ ok: true, accepted: [], said: [] });
    expect(posted).toBe(0);
  });
});
