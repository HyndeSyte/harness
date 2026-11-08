import { describe, expect, test } from "bun:test";
import { emptyState, INTENTS, Link, Protocol, State, STOP } from "../rootfs/opt/cain/link/core";

const OWNER = "4242", DM = "5151", BOT = "999";

function rig(opts: { paired?: string } = {}) {
  let state: State = emptyState();
  const calls: any[] = [], relayed: string[] = [], harness: any[] = [];
  let id = 7000;
  const posted: Record<string, any> = {};
  const rest = async (method: string, path: string, body?: any, auth = true) => {
    calls.push({ method, path, body, auth });
    if (path === "/oauth2/applications/@me") return { owner: { id: OWNER } };
    if (path === "/users/@me") return { id: BOT };
    if (path === "/users/@me/channels") return { id: DM };
    if (method === "POST" && path === `/channels/${DM}/messages`) {
      const msg = { id: String(++id), content: body.content, components: body.components ?? [], author: { id: BOT } };
      posted[msg.id] = msg;
      return msg;
    }
    if (method === "GET" && path.startsWith(`/channels/${DM}/messages/`)) return posted[path.split("/").pop()!] ?? { author: { id: OWNER } };
    return null;
  };
  const link = new Link({
    rest, load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; }, now: () => 1_000_000,
    relay: (t) => relayed.push(t), toHarness: async (p, b) => { harness.push([p, b]); return true; },
    paired: () => opts.paired ?? OWNER, log: () => {},
  });
  const tap = (msg: any, custom_id: string, over: any = {}) => link.onInteraction({
    type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: OWNER },
    data: { custom_id }, message: JSON.parse(JSON.stringify(msg)), ...over });
  const answers = () => calls.filter((c) => c.path.startsWith("/interactions/")).map((c) => c.body.type);
  return { link, calls, relayed, harness, posted, tap, answers, last: () => posted[String(id)] };
}

const undoRows = [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:abc" },
                                           { type: 2, style: 2, label: "Stop", custom_id: STOP }] }];

describe("cards from the calendar specialist", () => {
  test("are held for Cain, who is told, and shown unchanged when he says so", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved the dentist to Thu 2 PM.", rows: undoRows, kind: "reply" });
    expect(Object.keys(r.posted)).toEqual([]);
    expect(r.relayed[0]).toContain(`card ${id}`);
    expect(r.relayed[0]).toContain(`keeper.sh show ${id}`);
    await r.link.show(id);
    expect(r.last().content).toBe("Moved the dentist to Thu 2 PM.");
    expect(r.last().components).toEqual(undoRows);
    await r.link.show(id);
    expect(Object.keys(r.posted).length).toBe(1);                     // shown once
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
    await r.link.show(id);
    expect(r.last().components).toEqual([]);
  });
});

describe("taps", () => {
  test("on a shown card go back to the specialist with the card's id", async () => {
    const r = rig();
    const id = await r.link.addCard({ text: "Moved it.", rows: undoRows });
    await r.link.show(id);
    expect(await r.tap(r.last(), "k:c:abc")).toBe("to specialist");
    expect(r.answers()).toEqual([6]);
    expect(r.harness[0]).toEqual(["/press", { id: "11", token: "t", app: BOT, custom_id: "k:c:abc", message_id: id }]);
  });

  test("on a card someone rewrote are refused", async () => {
    const r = rig();
    await r.link.show(await r.link.addCard({ text: "Undo: dentist Thu?", rows: undoRows }));
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
      await r.link.show(await r.link.addCard({ text: "x", rows: undoRows }));
      expect(await r.tap(r.last(), "k:c:abc", over)).toContain(why);
      expect(r.harness).toEqual([]);
    });
  }

  test("are refused when Cain is paired with someone other than the bot's owner", async () => {
    const r = rig({ paired: "31337" });
    await r.link.show(await r.link.addCard({ text: "x", rows: undoRows }));
    expect(await r.tap(r.last(), "k:c:abc")).toContain("paired");
  });

  test("on Cain's question go to Cain once, and the card says what he chose", async () => {
    const r = rig();
    await r.link.ask("Book the plumber for Tuesday?", ["Yes", "Not now"]);
    const q = r.last();
    expect(q.components[0].components.map((c: any) => c.label)).toEqual(["Yes", "Not now"]);
    expect(await r.tap(q, q.components[0].components[0].custom_id)).toBe("to Cain");
    expect(r.answers()).toEqual([7]);
    expect(r.relayed).toEqual(['Dane tapped "Yes" on your question: "Book the plumber for Tuesday?"']);
    expect(await r.tap(q, q.components[0].components[1].custom_id)).toContain("refused");
    expect(r.relayed.length).toBe(1);
  });

  test("Cain's plugin keeps its own buttons", async () => {
    const r = rig();
    expect(await r.tap({ id: "1" }, "perm:allow:abcde")).toBe("ignored");
    expect(r.answers()).toEqual([]);
  });

  test("the morning message carries Stop", async () => {
    const r = rig();
    await r.link.ask("## Sat\nNothing needs you today.", [], true);
    expect(r.last().components[0].components[0].custom_id).toBe(STOP);
  });
});

describe("reactions", () => {
  test("his reaction to the bot's message goes to Cain; others don't", async () => {
    const r = rig();
    await r.link.ask("Want me to draft it?", []);
    const mid = r.last().id;
    expect(await r.link.onReaction({ user_id: OWNER, channel_id: DM, message_id: mid, emoji: { name: "👍" } })).toBe("to Cain");
    expect(await r.link.onReaction({ user_id: "333", channel_id: DM, message_id: mid, emoji: { name: "👎" } })).toBe("ignored");
    expect(await r.link.onReaction({ user_id: OWNER, channel_id: DM, message_id: "1", emoji: { name: "👍" } })).toBe("ignored");
    expect(r.relayed).toEqual(['Dane reacted 👍 to your message: "Want me to draft it?"']);
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
