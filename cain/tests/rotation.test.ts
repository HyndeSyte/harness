// Cain 0.19.0 with Keeper 0.1.9: the keeper's old Healthchecks key, attested as rotated only by Dane's tap on the
// link's card naming its id. The link signs the attestation with its Ship key (rotation.ts), so nothing Cain writes
// himself counts; the keeper checks it with the key it pinned.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign as edSign } from "node:crypto";
import { attestFlow, makeRotation, rotationNeeded, ROTATION_TTL_S } from "../rootfs/opt/cain/link/rotation";
import { RETRY_LABEL, ROTATION_LABEL } from "../rootfs/opt/cain/link/core";
import { rig, SHIP_KEYS, SHIP_PUB, DM, OWNER, BOT } from "./link-rig";
import { Keeper, keyFp } from "../../keeper/rootfs/opt/keeper/core.ts";

const ID = "a1b2c3d4e5f6";
const signer = (d: Buffer) => edSign(null, d, SHIP_KEYS.privateKey);

describe("the rotation card (Keeper 0.1.9)", () => {
  test("one card naming the old key's id, with one button; not again while it is up; none while stopped", async () => {
    const r = rig();
    const out = await r.link.rotationCard(ID);
    expect(out.status).toBe("posted");
    const msg = r.msg(out.message!);
    expect(msg.content).toContain(`old Healthchecks key, id ${ID}`);
    expect(r.buttons(out.message!)).toEqual([ROTATION_LABEL]);
    expect(r.ids(out.message!)).toEqual([`k:rot:${ID}`]);
    expect((await r.link.rotationCard(ID)).status).toBe("open");
    expect(r.posts()).toBe(1);
    const s = rig(); s.stop.stopped = true;
    expect((await s.link.rotationCard(ID)).status).toBe("stopped");
    expect(s.posts()).toBe(0);
    await expect(r.link.rotationCard("not-an-id")).rejects.toThrow("isn't an old key's id");
  });
  test("his tap sends the attestation; taken, the card says so and loses its button, and no second card goes out", async () => {
    const r = rig();
    const asked: string[] = [];
    (r.link as any).d.attestRotation = async (id: string) => { asked.push(id); return { ok: true, why: "" }; };
    const out = await r.link.rotationCard(ID);
    expect(await r.tap(r.msg(out.message!), `k:rot:${ID}`)).toBe("rotation attested");
    expect(asked).toEqual([ID]);
    expect(r.msg(out.message!).content).toContain("Done: Keeper has your word the old key is replaced.");
    expect(r.buttons(out.message!)).toEqual([]);
    expect(r.state().messages[out.message!].outcome).toBe("answered");
    expect((await r.link.rotationCard(ID)).status).toBe("done");
    expect(r.posts()).toBe(1);
  });
  test("refused by the keeper: the card stays up and he is told why, to him alone", async () => {
    const r = rig();
    (r.link as any).d.attestRotation = async () => ({ ok: false, why: "the alert service still accepts the old key" });
    const out = await r.link.rotationCard(ID);
    expect(await r.tap(r.msg(out.message!), `k:rot:${ID}`)).toBe("refused");
    expect(r.ephemerals().at(-1).content).toContain("Keeper didn't take it: the alert service still accepts the old key");
    expect(r.buttons(out.message!)).toEqual([ROTATION_LABEL]);
    expect(r.state().messages[out.message!].outcome).toBeUndefined();
  });
  test("the keeper's state judged: a card only when a tap is needed and the old option is gone", () => {
    expect(rotationNeeded({ needed: true, old_key_id: ID, old_option_present: false })).toMatchObject({ id: ID, kept: true });
    expect(rotationNeeded({ needed: true, old_key_id: ID, old_key_kept: false, enroll_id: "0123456789abcdef", challenge: "a".repeat(24) }))
      .toEqual({ id: ID, kept: false, enroll: "0123456789abcdef", challenge: "a".repeat(24) });
    expect(rotationNeeded({ needed: true, old_key_id: ID, old_option_present: true })).toBeNull();
    expect(rotationNeeded({ needed: false, old_key_id: ID })).toBeNull();
    expect(rotationNeeded({ needed: true, old_key_id: "x" })).toBeNull();
    expect(rotationNeeded(null)).toBeNull();
  });
  test("the link's attestation is what the keeper accepts; Cain's own note, or one signed by another key, never is", async () => {
    let now = Date.parse("2026-11-23T12:00:00Z");
    const logs: string[] = [];
    const k = new Keeper({ now: () => now, version: "0.1.9", self: "0fcc2575_keeper", appInfo: async () => null, backupInfo: async () => null,
      makeBackup: async () => ({ why: "x" }), restore: async () => ({ kind: "unknown", why: "x" }), job: async () => null,
      live: async () => true, ready: async () => true, ping: async () => true, options: () => ({}), save: () => true, log: (l) => logs.push(l) }, null);
    k.useOptions({ ship_public_key: SHIP_PUB, hc_api_key: "old-key-0123456789abcdef" });
    k.start(); k.keyCode();
    const code = [...logs].reverse().map((l) => /^one-time code for key-confirm: ([0-9a-f]+) /.exec(l)?.[1]).find(Boolean)!;
    expect(k.keyConfirm(keyFp(SHIP_PUB), code).ok).toBe(true);
    k.useOptions({ ship_public_key: SHIP_PUB });             // the owner removed the old option
    const id = k.st.oldKey!.id;
    expect((await k.attestRotation("0fcc2575_cain", { attestation: `Dane says key ${id} is rotated` })).status).toBe(409);
    const view: any = k.rotationView("0fcc2575_cain").body;
    const { privateKey: other } = await import("node:crypto").then((c) => c.generateKeyPairSync("ed25519"));
    expect((await k.attestRotation("0fcc2575_cain", { attestation: makeRotation(id, view.enroll_id, view.challenge, now, (d) => edSign(null, d, other)) })).status).toBe(409);
    const tok = makeRotation(id, view.enroll_id, view.challenge, now, signer);
    expect(JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString())).toMatchObject({ v: 2, id, enroll: view.enroll_id, challenge: view.challenge, exp: Math.floor(now / 1000) + ROTATION_TTL_S });
    // Keeper 0.1.10: the link's own flow, reading /rotation fresh at the tap, is what the keeper takes
    const keeper = { get: async (p: string) => ({ status: 200, body: p === "/rotation" ? k.rotationView("0fcc2575_cain").body : {} }),
      post: async (_p: string, b: any) => { const a = await k.attestRotation("0fcc2575_cain", b); return { status: a.status, body: a.body }; }, sign: signer, now: () => now };
    expect(await attestFlow(keeper, "000000000000")).toEqual({ ok: false, why: `the keeper now names old key ${id}, not the card's 000000000000` });
    expect(await attestFlow(keeper, id)).toEqual({ ok: true, why: "" });
    expect(k.rotationWhy()).toBe("");
    expect(k.st.rotation!.proof).toBe("attested by your tap only");
  });
  test("only main.ts signs an attestation, inside the tap's dependency: no other code of Cain's makes one", () => {
    const main = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main.match(/attestFlow\(/g)?.length).toBe(1);
    expect(main).not.toContain("makeRotation(");
    expect(main).toContain("attestRotation: shipPriv ? async (id) => {");
    const rot = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/rotation.ts"), "utf8");
    expect(rot.match(/makeRotation\(/g)?.length).toBe(2);     // its definition and the one call, in attestFlow
    const core = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).not.toContain("makeRotation(");
    expect(core).not.toContain("attestFlow(");
    expect(core).toContain("this.d.attestRotation(id)");
    expect(DM).toBeTruthy();
  });
  // Keeper 0.1.10
  test("no old key kept: the card says the rotation is attested by his tap only", async () => {
    const r = rig();
    const out = await r.link.rotationCard(ID, { kept: false });
    expect(r.msg(out.message!).content).toContain("this is attested by your tap only");
    const k = rig();
    const kept = await k.link.rotationCard(ID);
    expect(k.msg(kept.message!).content).toContain("it checks Healthchecks turns it down before it takes your word");
  });
  test("a tap from another user is refused by the rotation handler itself, before anything is signed", async () => {
    const r = rig();
    const asked: string[] = [];
    (r.link as any).d.attestRotation = async (id: string) => { asked.push(id); return { ok: true, why: "" }; };
    const out = await r.link.rotationCard(ID);
    const msg = r.msg(out.message!);
    const it = (user: string) => ({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: user }, data: { custom_id: `k:rot:${ID}` }, message: msg });
    expect(await (r.link as any).rotationTap(it("7777"), out.message!)).toBe("refused: not the owner");
    expect(asked).toEqual([]);
    expect(r.state().messages[out.message!].outcome).toBeUndefined();
    expect(r.logs.some((l) => l.includes(`a rotation tap for the old key ${ID} was refused before signing: not the owner`))).toBe(true);
    expect(await (r.link as any).rotationTap(it(OWNER), out.message!)).toBe("rotation attested");
    expect(asked).toEqual([ID]);
  });
  test("(Keeper 0.1.11) the free-space card: one per pull request, head and App, with no button: nothing installs without the rollback", async () => {
    const r = rig();
    const HEAD = "a".repeat(40);
    const out = await r.link.spaceCard(46, HEAD, "0fcc2575_cain", "0.19.0");
    expect(out.status).toBe("posted");
    const text = r.msg(out.message!).content;
    expect(text).toContain("Keeper has no room for the backup it takes before installing Cain 0.19.0, so the install was refused and nothing was installed.");
    expect(text).toContain("Nothing installs it without Keeper's rollback.");
    expect(r.buttons(out.message!)).toEqual([]);
    expect((await r.link.spaceCard(46, HEAD, "0fcc2575_cain", "0.19.0")).status).toBe("open");
    expect(r.posts()).toBe(1);
    // the old override button does nothing now
    expect(await r.tap(r.msg(out.message!), "k:space:46")).not.toBe("override recorded");
    const st = rig(); st.stop.stopped = true;
    expect((await st.link.spaceCard(46, HEAD, "0fcc2575_cain", "0.19.0")).status).toBe("stopped");
  });
});

describe("Keeper 0.1.11 item 4: the retry card, and an attestation answer that isn't a plain attested", () => {
  const ATT = "ship-46-cain-01234567";
  test("a claim or cancel not confirmed: one card per attempt and kind with Try again; his tap asks Cain for the Ship card again", async () => {
    const r = rig();
    const out = await r.link.retryCard(ATT, "claim");
    expect(out.status).toBe("posted");
    expect(r.msg(out.message!).content).toContain("Keeper didn't confirm the start of the install of Cain, so the Ship run didn't start and nothing was installed.");
    expect(r.buttons(out.message!)).toEqual([RETRY_LABEL]);
    expect((await r.link.retryCard(ATT, "claim")).status).toBe("open");
    const c = await r.link.retryCard(ATT, "cancel");
    expect(r.msg(c.message!).content).toContain("Keeper didn't confirm it called off an install of Cain that didn't run");
    expect(r.posts()).toBe(2);
    const msg = r.msg(out.message!);
    const it = (user: string) => ({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: user }, data: { custom_id: `k:retry:${ATT}` }, message: msg });
    expect(await (r.link as any).retryTap(it("7777"), out.message!)).toBe("refused: not the owner");
    expect(r.relayed.length).toBe(0);
    expect(await r.tap(msg, `k:retry:${ATT}`)).toBe("retry asked");
    expect(r.buttons(out.message!)).toEqual([]);
    expect(r.relayed.some((l: string) => l.includes(`Dane tapped ${RETRY_LABEL} after Keeper didn't confirm its claim for pull request 46`) && l.includes("Show him a new Ship card"))).toBe(true);
    await expect(r.link.retryCard("not-an-attempt", "claim")).rejects.toThrow("isn't a keeper attempt");
    const st = rig(); st.stop.stopped = true;
    expect((await st.link.retryCard(ATT, "claim")).status).toBe("stopped");
  });
  test("the attestation counts only on a plain attested: pending, refused, an error or no answer is not taken, and the card keeps its button", async () => {
    const view = { status: 200, body: { needed: true, old_key_id: ID, old_option_present: false, old_key_kept: true, enroll_id: "0123456789abcdef", challenge: "a".repeat(24) } };
    for (const [ans, why] of [[{ status: 202, body: { status: "pending", operation: "op-0123456789abcdef" } }, "pending"], [{ status: 200, body: { status: "refused", why: "x" } }, "x"],
      [{ status: 200, body: {} }, "the keeper answered"], [{ status: 503, body: { status: "refused" } }, "the keeper answered refused"], [null, "didn't answer"]] as const) {
      const got = await attestFlow({ get: async () => view, post: async () => ans as any, sign: signer, now: () => Date.now() }, ID);
      expect(got.ok).toBe(false);
      expect(got.why).toContain(why);
    }
    expect((await attestFlow({ get: async () => view, post: async () => ({ status: 200, body: { status: "attested", id: ID } }), sign: signer, now: () => Date.now() }, ID)).ok).toBe(true);
    const r = rig();
    (r.link as any).d.attestRotation = async () => ({ ok: false, why: "the keeper's answer is pending" });
    const out = await r.link.rotationCard(ID);
    expect(await r.tap(r.msg(out.message!), `k:rot:${ID}`)).toBe("refused");
    expect(r.buttons(out.message!)).toEqual([ROTATION_LABEL]);
  });
});
