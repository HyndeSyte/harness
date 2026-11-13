import { describe, expect, test } from "bun:test";
import { INTENTS, Protocol, STOP } from "../rootfs/opt/cain/link/core";
import { BOT, DM, OWNER, rig } from "./link-rig";

const undoRows = [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:abc" },
                                           { type: 2, style: 2, label: "Stop", custom_id: STOP }] }];

describe("cards from the calendar specialist", () => {
  test("are held for Cain, who is told, and shown unchanged when he says so", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved the dentist to Thu 2 PM.", rows: undoRows, kind: "reply" });
    expect(Object.keys(r.posted)).toEqual([]);
    expect(r.relayed[0]).toContain(`card ${id}`);
    expect(r.relayed[0]).toContain(`keeper.sh show ${id} --item`);
    await r.link.show(id, { item: "none" });
    expect(r.last().content).toBe("Moved the dentist to Thu 2 PM.");
    expect(r.last().components).toEqual(undoRows);
    await r.link.show(id, { item: "none" });
    expect(Object.keys(r.posted).length).toBe(1);                     // shown once
  });

  test("are shown only with an item: its PENDING id, or none", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    await expect(r.link.show(id, {})).rejects.toThrow("needs an item");
    await expect(r.link.show(id, { item: "P 08" })).rejects.toThrow("PENDING id");
    expect(Object.keys(r.posted)).toEqual([]);
  });

  test("Stop notices go straight out", async () => {
    const r = rig();
    await r.link.addCard({ text: "Stopped.", rows: [], kind: "stopped" });
    expect(r.last().content).toBe("Stopped.");
    expect(r.relayed).toEqual([]);
  });

  test("a specialist can't make buttons that speak for Cain", async () => {
    const r = rig();
    const bad = [{ type: 1, components: [{ type: 2, style: 2, label: "Yes", custom_id: "q:x:0" }] }];
    const id = await r.link.addCard({ text: "x", rows: bad });
    await r.link.show(id, { item: "none" });
    expect(r.last().components).toEqual([]);
  });

  test("/card-of says which card a message is, and its item and question", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    const m = await r.link.show(id, { item: "P06", question: "Q1" });
    expect(r.link.cardInfo(m)).toEqual({ card: id, item: "P06", question: "Q1", buttons: ["Undo", "Stop"], live: true });
    expect(r.link.cardOf(m)).toBe(id);
    expect(r.link.cardInfo("123")).toEqual({ card: null, item: null, question: null, buttons: [], live: null });
  });
});

describe("taps", () => {
  test("on a shown card go back to the specialist with the card's id", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    await r.link.show(id, { item: "none" });
    expect(await r.tap(r.last(), "k:c:abc")).toBe("to specialist");
    expect(r.answers()).toEqual([6]);
    expect(r.harness[0]).toEqual(["/press", { id: "11", token: "t", app: BOT, custom_id: "k:c:abc", message_id: id }]);
  });

  test("on a card someone rewrote are refused", async () => {
    const r = rig();
    await r.link.show(await r.link.addCard({ text: "Undo: dentist Thu?", rows: undoRows }), { item: "none" });
    const msg = { ...r.last(), content: "Undo: add lunch Friday?" };
    expect(await r.tap(msg, "k:c:abc")).toContain("changed");
    expect(r.harness).toEqual([]);
  });

  for (const [over, why] of [
    [{ user: { id: "333" } }, "not the owner"],
    [{ guild_id: "5", member: {} }, "not in the DM"],
    [{ channel_id: "444" }, "not the DM"],
  ] as const) {
    test(`from anyone or anywhere else are refused: ${why}`, async () => {
      const r = rig();
      await r.link.show(await r.link.addCard({ text: "x", rows: undoRows }), { item: "none" });
      expect(await r.tap(r.last(), "k:c:abc", over)).toContain(why);
      expect(r.harness).toEqual([]);
      expect(r.answers()).toEqual([6]);                               // acknowledged, nothing changed
    });
  }

  test("are refused when Cain is paired with someone other than the bot's owner", async () => {
    const r = rig({ paired: "31337" });
    await r.link.show(await r.link.addCard({ text: "x", rows: undoRows }), { item: "none" });
    expect(await r.tap(r.last(), "k:c:abc")).toContain("paired");
  });

  test("on Cain's question go to Cain once, and the card says what he answered", async () => {
    const r = rig();
    await r.link.ask({ text: "Book the plumber for Tuesday?", options: ["Yes", "Not now"], item: "none" });
    const q = structuredClone(r.last());                               // as his phone still shows it
    expect(q.components[0].components.map((c: any) => c.label)).toEqual(["Yes", "Not now"]);
    expect(await r.tap(q, q.components[0].components[0].custom_id)).toBe("to Cain");
    expect(r.answers()).toEqual([7]);
    expect(r.updates()[0]).toEqual({ content: "Book the plumber for Tuesday?\n\nYou answered: Yes", components: [],
      allowed_mentions: { parse: [] } });
    expect(r.relayed).toEqual([`Dane tapped "Yes" on your question: "Book the plumber for Tuesday?" (Discord message ${q.id}; its card shows his answer. If it needs words from you, reply with reply_to ${q.id})`]);
    expect(await r.tap(q, q.components[0].components[1].custom_id)).toBe("dead: answered");
    expect(r.relayed.length).toBe(1);
  });

  test("Cain's plugin keeps its own buttons", async () => {
    const r = rig();
    expect(await r.tap({ id: "1" }, "perm:allow:abcde")).toBe("ignored");
    expect(r.answers()).toEqual([]);
  });

  test("the morning message carries Stop, and asks nothing", async () => {
    const r = rig();
    await r.link.morning("## Sat\nNothing needs you today.");
    expect(r.last().components[0].components[0].custom_id).toBe(STOP);
    expect(r.ids(r.last().id)).toEqual([STOP]);
  });
});

describe("reactions", () => {
  test("his reaction to the bot's message goes to Cain, with the message; others don't", async () => {
    const r = rig();
    await r.link.ask({ text: "Want me to draft it?", options: ["Draft it"], item: "P17", question: "Q1" });
    const mid = r.last().id;
    expect(r.last().content).toBe("P17 Q1: Want me to draft it?");            // the link names it
    expect(await r.link.onReaction({ user_id: OWNER, channel_id: DM, message_id: mid, emoji: { name: "👍" } })).toBe("to Cain");
    expect(await r.link.onReaction({ user_id: "333", channel_id: DM, message_id: mid, emoji: { name: "👎" } })).toBe("ignored");
    expect(await r.link.onReaction({ user_id: OWNER, channel_id: DM, message_id: "1", emoji: { name: "👍" } })).toBe("ignored");
    expect(r.relayed).toEqual([`Dane reacted 👍 to your message (P17 Q1): "P17 Q1: Want me to draft it?" (Discord message ${mid})`]);
  });
});

describe("the gateway protocol", () => {
  test("identifies for reactions only, then resumes its session", () => {
    const sent: any[] = [];
    const seen: any[] = [];
    const p = new Protocol((o) => sent.push(o), () => "tok", { interaction: (d) => seen.push(d) }, () => 0);
    p.handle({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(sent[0].op).toBe(2);
    expect(sent[0].d.intents).toBe(INTENTS);
    expect(INTENTS).toBe(1 << 13);
    p.handle({ op: 0, s: 1, t: "READY", d: { session_id: "s", resume_gateway_url: "wss://gateway-x.discord.gg" } });
    p.handle({ op: 0, s: 2, t: "INTERACTION_CREATE", d: { id: "i" } });
    expect(seen).toEqual([{ id: "i" }]);
    expect(p.closed(1006)).toBe("resume");
    p.handle({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(sent[1]).toEqual({ op: 6, d: { token: "tok", session_id: "s", seq: 2 } });
    expect(p.closed(4004)).toBe("fatal");
    expect(p.closed(4009)).toBe("fresh");
    expect(p.session).toBeNull();
  });
});
