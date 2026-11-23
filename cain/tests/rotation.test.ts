// Cain 0.19.0 with Keeper 0.1.9: the keeper's old Healthchecks key, attested as rotated only by Dane's tap on the
// link's card naming its id. The link signs the attestation with its Ship key (rotation.ts), so nothing Cain writes
// himself counts; the keeper checks it with the key it pinned.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign as edSign } from "node:crypto";
import { makeRotation, rotationNeeded, ROTATION_TTL_S } from "../rootfs/opt/cain/link/rotation";
import { ROTATION_LABEL } from "../rootfs/opt/cain/link/core";
import { rig, SHIP_KEYS, SHIP_PUB, DM } from "./link-rig";
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
    expect(rotationNeeded({ needed: true, old_key_id: ID, old_option_present: false })).toBe(ID);
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
    const { privateKey: other } = await import("node:crypto").then((c) => c.generateKeyPairSync("ed25519"));
    expect((await k.attestRotation("0fcc2575_cain", { attestation: makeRotation(id, now, (d) => edSign(null, d, other)) })).status).toBe(409);
    const tok = makeRotation(id, now, signer);
    expect(JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).exp).toBe(Math.floor(now / 1000) + ROTATION_TTL_S);
    expect((await k.attestRotation("0fcc2575_cain", { attestation: tok })).status).toBe(200);
    expect(k.rotationWhy()).toBe("");
  });
  test("only main.ts signs an attestation, inside the tap's dependency: no other code of Cain's makes one", () => {
    const main = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/main.ts"), "utf8");
    expect(main.match(/makeRotation\(/g)?.length).toBe(1);
    expect(main).toContain("attestRotation: shipPriv ? async (id) => {");
    const core = readFileSync(join(import.meta.dir, "..", "rootfs/opt/cain/link/core.ts"), "utf8");
    expect(core).not.toContain("makeRotation(");
    expect(core).toContain("this.d.attestRotation(id)");
    expect(DM).toBeTruthy();
  });
});
