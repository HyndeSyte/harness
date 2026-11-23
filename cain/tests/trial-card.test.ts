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
// The link's own reading of the plan (sixth round: ../trials/plan.ts in the link); here a fixed view per suite.
const DISCLOSURE = "Sent to third-party search:\nq01: As of 2026-11-20: What is the current release of tool number 1?\n  answer notes: must contain the version; sources https://example.com/releases (read 2026-11-19)";
function view(suite: string, over: Record<string, unknown> = {}) {
  if (suite === "preflight") return { target: "preflight", action: "preflight", plan: PLAN, cap: 4, worst: 4, calls: 0, providers: ["Google (Gemini)", "Anthropic (Claude)", "Perplexity", "OpenAI (Codex, on the ChatGPT plan)"], disclosure: null, granted: 2, allowance: 50, budget: 40, tasks: 0, ...over };
  return { target: suite, action: "start", plan: PLAN, cap: 7.17, worst: 3.17, calls: 120, providers: ["Google (Gemini)", "OpenAI (Codex, on the ChatGPT plan)", "Perplexity", "Anthropic (Claude)"],
    disclosure: suite === "research" ? DISCLOSURE : null, granted: 4, allowance: 50, budget: 40, tasks: 12, ...over };
}
function trialRig(o: { noKey?: boolean; view?: (suite: string, fresh: boolean) => any } = {}) {
  const r = rig();
  (r.link as any).d.trialPlan = ({ suite, fresh }: { suite: string; fresh: boolean }) => (o.view ? o.view(suite, fresh) : view(suite));
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
    // A start's command says --new, so a run that stopped meanwhile isn't resumed on an approval for a new one.
    expect(line).toContain("/opt/cain/trial.sh run review-seats --new --approval trial1.");
    const tok = findTrialToken(line)!;
    const c = readTrialToken(tok, TRIAL_KEYS.publicKey, r.t.now);
    expect(c).toMatchObject({ ok: true, claim: { suite: "review-seats", action: "start", plan: PLAN, cap_cents: 717 } });
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
    expect(String(r.msg(id).content)).toContain("What: the preflight");
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

  test("sixth round: the link computes the plan itself; a carried hash or cap that differs from its own is refused, nothing posted", async () => {
    const r = trialRig();
    const before = r.posts();
    await expect(ask(r, { plan: "e".repeat(64) })).rejects.toThrow("isn't the one the link computes");
    await expect(ask(r, { cap: 9.5 })).rejects.toThrow("isn't the run's cap as the link computes it ($7.17)");
    expect(r.posts()).toBe(before);
    // The link can't compute it (no suite, no approval, unreadable options): no card, with its reason.
    const n = trialRig({ view: () => ({ error: "the research suite can't run: the owner hasn't approved the questions" }) });
    await expect(ask(n, { suite: "research" })).rejects.toThrow("no trial card: the research suite can't run");
    const none = trialRig(); (none.link as any).d.trialPlan = undefined;
    await expect(ask(none)).rejects.toThrow("can't compute the trial's plan");
  });

  test("sixth round: the card shows what he approves as text: suite, start or resume, cap, worst case, providers, granted, and the disclosure", async () => {
    const r = trialRig();
    const id = ((await ask(r, { suite: "research" })) as any).message;
    const text = String(r.msg(id).content);
    expect(text).toContain("What: a new run of the research suite, 12 tasks, 120 calls.");
    expect(text).toContain("Cap: $7.17 of your trial allowance; worst case of its calls $3.17.");
    expect(text).toContain("Providers called: Google (Gemini), OpenAI (Codex, on the ChatGPT plan), Perplexity, Anthropic (Claude).");
    expect(text).toContain("Granted to trial runs so far: $4.00 of your $50.00 allowance.");
    expect(text).toContain("Sent to third-party search:");
    expect(text).toContain("What is the current release of tool number 1?");
    expect(text).not.toContain(PLAN);
    // A resume says so, and the tap's approval is for a resume (and its command has no --new).
    const res = trialRig({ view: (s) => view(s, { action: "resume" }) });
    const id2 = ((await ask(res)) as any).message;
    expect(String(res.msg(id2).content)).toContain("What: a resume of the review-seats suite's stopped run");
    await res.tap(res.msg(id2), res.ids(id2)[0]);
    const line = res.relayed.find((l) => l.includes("Trial approval:"))!;
    expect(line).toContain("/opt/cain/trial.sh run review-seats --approval trial1.");
    expect(readTrialToken(findTrialToken(line)!, TRIAL_KEYS.publicKey, res.t.now)).toMatchObject({ ok: true, claim: { action: "resume", plan: PLAN } });
    // A list too long for the card is attached as a text file, named on the card.
    const long = "Sent to third-party search:\n" + Array.from({ length: 30 }, (_, i) => `q${i}: As of 2026-11-20: What is the current release of tool number ${i}? answer notes: must contain the version`).join("\n");
    const big = trialRig({ view: (s) => view(s, { disclosure: long }) });
    const id3 = ((await ask(big, { suite: "research" })) as any).message;
    expect(String(big.msg(id3).content)).toContain("the full list is attached (12 questions and their answer notes)");
    const post = big.calls.filter((c: any) => c.method === "POST" && c.path.endsWith("/messages")).at(-1)!;
    expect(post.body.files).toEqual([{ name: "sent-to-third-party-search.txt", content: `${long}\n` }]);
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
