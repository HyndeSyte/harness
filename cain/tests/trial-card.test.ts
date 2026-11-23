// Cain 0.19.0, fifth round: the owner's go for one paid model trial run (link/core.ts trialApprove and its tap,
// ../rootfs/opt/cain/trial-token.ts). Cain's keeper.sh trial-approve posts a card bound to the exact plan hash and
// cap trial.sh plan printed; only the owner's "Allow this run" tap signs a one-time approval, with the link's own
// trial key (never the Ship key), good for 2 hours. "No" signs nothing, and Stop holds every signature.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRIAL_ALLOW, TRIAL_NO } from "../rootfs/opt/cain/link/core.ts";
import { findTrialToken, makeTrialToken, readTrialToken, trialClaimFor } from "../rootfs/opt/cain/trial-token.ts";
import { readToken } from "../rootfs/opt/cain/ship-token.ts";
import { CAIN_ROUTES, routeAllowed } from "../rootfs/opt/cain/link/auth.ts";
import { HOUR, SHIP_KEYS, rig } from "./link-rig";

const TRIAL_KEYS = generateKeyPairSync("ed25519");
const PLAN = "d".repeat(64);
function trialRig(o: { noKey?: boolean } = {}) {
  const r = rig();
  if (!o.noKey) (r.link as any).d.signTrial = (c: any) => makeTrialToken(c, (data) => edSign(null, data, TRIAL_KEYS.privateKey));
  else (r.link as any).d.signTrial = undefined;
  return r;
}
const ask = (r: ReturnType<typeof rig>, over: Record<string, unknown> = {}) =>
  r.link.trialApprove({ item: "P50", suite: "review-seats", plan: PLAN, cap: 7.17, text: "Which models answer past review tasks best, before the next review month", ...over });

describe("the trial card", () => {
  test("Cain's command posts the card bound to the plan and cap, with Allow this run and No, and signs nothing", async () => {
    const r = trialRig();
    const res: any = await ask(r);
    expect(res.status).toBe("posted");
    expect(r.buttons(res.message)).toEqual([TRIAL_ALLOW, TRIAL_NO]);
    const text = String(r.msg(res.message).content);
    expect(text).toContain("Allow a model trial on past tasks, costing at most $7.17 of your trial allowance?");
    expect(text).toContain("only this one run of this exact plan, for the next 2 hours");
    expect(text).not.toContain(PLAN);                                   // the hash rides with the card, never in its words
    expect(r.state().messages[res.message]).toMatchObject({ kind: "ask", item: "P50", trial: { suite: "review-seats", plan: PLAN, cap: 7.17 } });
    expect(r.relayed.join("\n")).not.toContain("trial1.");
  });

  test("refused: a malformed plan or cap, a suite it doesn't know, no trial key, or while Stop holds", async () => {
    const r = trialRig();
    await expect(ask(r, { plan: "abc" })).rejects.toThrow("plan hash");
    await expect(ask(r, { cap: 0 })).rejects.toThrow("cap");
    await expect(ask(r, { cap: 900 })).rejects.toThrow("cap");
    await expect(ask(r, { suite: "everything" })).rejects.toThrow("suite");
    await expect(ask(trialRig({ noKey: true }))).rejects.toThrow("no trial key");
    const s = trialRig();
    s.stop.stopped = true; s.stop.at = s.t.now;
    await expect(ask(s)).rejects.toThrow("stopped");
  });

  test("his Allow tap signs a one-time approval for exactly that suite, plan and cap, with the trial key, good for 2 hours", async () => {
    const r = trialRig();
    const id = ((await ask(r)) as any).message;
    await r.tap(r.msg(id), r.ids(id)[0]);
    const line = r.relayed.find((l) => l.includes(`Dane tapped "${TRIAL_ALLOW}"`))!;
    expect(line).toContain("Trial approval: trial1.");
    expect(line).toContain("/opt/cain/trial.sh run review-seats --approval trial1.");
    const tok = findTrialToken(line)!;
    const c = readTrialToken(tok, TRIAL_KEYS.publicKey, r.t.now);
    expect(c).toMatchObject({ ok: true, claim: { suite: "review-seats", plan: PLAN, cap_cents: 717 } });
    expect((c as any).claim.exp * 1000 - r.t.now).toBeLessThanOrEqual(2 * HOUR);
    // Never a Ship token: the Ship key doesn't verify it, and its shape isn't one.
    expect(readToken(tok, SHIP_KEYS.publicKey, r.t.now).ok).toBe(false);
    expect(readTrialToken(tok, SHIP_KEYS.publicKey, r.t.now)).toMatchObject({ ok: false });
    // Two hours on, it's expired.
    expect(readTrialToken(tok, TRIAL_KEYS.publicKey, r.t.now + 2 * HOUR + 1000)).toMatchObject({ ok: false, why: expect.stringContaining("expired") });
    // A second tap on the card: dead, no second approval.
    await r.tap(r.msg(id), r.ids(id)[0] ?? "q:x:0");
    expect(r.relayed.filter((l) => l.includes("Trial approval:")).length).toBe(1);
  });

  test("the preflight's card names the preflight command; No signs nothing; Stop after the card signs nothing", async () => {
    const r = trialRig();
    const id = ((await ask(r, { suite: "preflight", cap: 4, text: "The model checks after installing" })) as any).message;
    await r.tap(r.msg(id), r.ids(id)[0]);
    expect(r.relayed.join("\n")).toContain("/opt/cain/trial.sh preflight --approval trial1.");
    const n = trialRig();
    const id2 = ((await ask(n)) as any).message;
    await n.tap(n.msg(id2), n.ids(id2)[1]);
    expect(n.relayed.join("\n")).toContain("Nothing was approved");
    expect(n.relayed.join("\n")).not.toContain("trial1.");
    const s = trialRig();
    const id3 = ((await ask(s)) as any).message;
    s.stop.stopped = true; s.stop.at = s.t.now;
    await s.tap(s.msg(id3), s.ids(id3)[0]);
    expect(s.relayed.join("\n")).not.toContain("trial1.");
  });

  test("a trial approval is checked whole: tampered, malformed or over-long ones don't count", () => {
    const now = Date.now();
    const tok = makeTrialToken(trialClaimFor({ suite: "research", plan: PLAN, capUsd: 3 }, now)!, (d) => edSign(null, d, TRIAL_KEYS.privateKey));
    expect(readTrialToken(tok, TRIAL_KEYS.publicKey, now)).toMatchObject({ ok: true });
    const [p, body, s] = tok.split(".");
    expect(readTrialToken(`${p}.${body.slice(0, -2)}AA.${s}`, TRIAL_KEYS.publicKey, now).ok).toBe(false);
    expect(readTrialToken("ship1.abc.def", TRIAL_KEYS.publicKey, now).ok).toBe(false);
    expect(trialClaimFor({ suite: "research", plan: PLAN, capUsd: 501 }, now)).toBeNull();
    expect(trialClaimFor({ suite: "research", plan: "x", capUsd: 1 }, now)).toBeNull();
  });

  test("the route is Cain's, and keeper.sh trial-approve checks its arguments before it asks", () => {
    expect(CAIN_ROUTES.has("/trial-approve")).toBe(true);
    expect(routeAllowed).toBeDefined();
    const keeper = join(import.meta.dir, "../rootfs/opt/cain/keeper.sh");
    // As his own user: a key of his own, and the link's address nowhere (each check refuses before any ask).
    const d = mkdtempSync(join(tmpdir(), "keeper-trial-"));
    writeFileSync(join(d, "mode"), "own"); mkdirSync(join(d, "keys")); writeFileSync(join(d, "keys", "cain.key"), "k".repeat(64));
    writeFileSync(join(d, "cards.json"), JSON.stringify({ owner: "4242" }));
    const run = (...a: string[]) => spawnSync("bash", [keeper, "trial-approve", ...a], { encoding: "utf8",
      env: { ...process.env, CAIN_MODE_FILE: join(d, "mode"), CAIN_KEYS: join(d, "keys"), CAIN_CARDS: join(d, "cards.json"), CAIN_LINK_URL: "http://127.0.0.1:1" } });
    expect(run("--item", "P50", "--suite", "all", "--plan", PLAN, "--cap", "4", "x").stdout).toContain("--suite takes");
    expect(run("--item", "P50", "--suite", "research", "--plan", "abc", "--cap", "4", "x").stdout).toContain("--plan takes");
    expect(run("--item", "P50", "--suite", "research", "--plan", PLAN, "--cap", "four", "x").stdout).toContain("--cap takes");
  });
});
