// Cain's end of the Discord channel (rootfs/opt/cain/discord/bridge.ts): lines pass both ways;
// a reply's files go as bytes read as Cain; a broker restart costs a resend, never the channel.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Bridge, MAX_BYTES, RECONNECTING, RESTARTED, withFileBytes } from "../rootfs/opt/cain/discord/bridge";

class FakeSock extends EventEmitter {
  connecting = true; destroyed = false; written: string[] = [];
  setEncoding() { return this; }
  write(s: string) { this.written.push(s); return true; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  up() { this.connecting = false; this.emit("connect"); }
  say(o: unknown) { this.emit("data", JSON.stringify(o) + "\n"); }
  lines() { return this.written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
}

function rig() {
  const socks: FakeSock[] = [];
  const timers: (() => void)[] = [];
  const toClaude: any[] = [];
  const b = new Bridge("/sock", (l) => toClaude.push(JSON.parse(l)), () => { const s = new FakeSock(); socks.push(s); return s as any; },
    (_ms, f) => { timers.push(f); });
  b.start();
  return { b, socks, toClaude, tick: () => timers.shift()?.() };
}
const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code" } } };
const inited = { jsonrpc: "2.0", method: "notifications/initialized" };
const reply = (id: number, text = "hi") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "reply", arguments: { chat_id: "1", text } } });

describe("the bridge", () => {
  test("lines wait for the first connection, then go in order", () => {
    const t = rig();
    t.b.fromClaude(JSON.stringify(init));
    t.b.fromClaude(JSON.stringify(inited));
    expect(t.socks[0].written).toEqual([]);
    t.socks[0].up();
    expect(t.socks[0].lines().map((m) => m.method)).toEqual(["initialize", "notifications/initialized"]);
  });

  test("answers and notifications come back to Claude Code unchanged", () => {
    const t = rig();
    t.socks[0].up();
    t.b.fromClaude(JSON.stringify(reply(5)));
    t.socks[0].say({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "sent (id: 1)" }] } });
    t.socks[0].say({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "hello", meta: { chat_id: "1" } } });
    expect(t.toClaude.map((m) => m.id ?? m.method)).toEqual([5, "notifications/claude/channel"]);
  });

  test("a broker restart: calls in flight are told to resend, the new server gets the initialize again", () => {
    const t = rig();
    t.b.fromClaude(JSON.stringify(init));
    t.b.fromClaude(JSON.stringify(inited));
    t.socks[0].up();
    t.socks[0].say({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    t.b.fromClaude(JSON.stringify(reply(7)));
    t.socks[0].destroy();
    expect(t.toClaude.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: RESTARTED } });

    // While it's down, a call is answered at once and a notification goes nowhere.
    t.b.fromClaude(JSON.stringify(reply(8)));
    expect(t.toClaude.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32000, message: RECONNECTING } });

    t.tick();
    t.socks[1].up();
    const sent = t.socks[1].lines();
    expect(sent[0].method).toBe("initialize");
    expect(String(sent[0].id)).toStartWith("bridge-reinit-");
    expect(sent[1].method).toBe("notifications/initialized");
    const before = t.toClaude.length;
    t.socks[1].say({ jsonrpc: "2.0", id: sent[0].id, result: { protocolVersion: "2025-06-18" } });
    expect(t.toClaude.length).toBe(before);            // the replay's answer stays in the bridge
    t.b.fromClaude(JSON.stringify(reply(9)));
    expect(t.socks[1].lines().at(-1).id).toBe(9);
  });

  test("a broker that isn't up yet: the first lines keep waiting through retries", () => {
    const t = rig();
    t.b.fromClaude(JSON.stringify(init));
    t.socks[0].destroy();
    expect(t.toClaude).toEqual([]);
    t.tick();
    t.socks[1].up();
    expect(t.socks[1].lines()[0]).toEqual(init);
  });
});

describe("a reply's files", () => {
  const files = { "/w/chart.png": Buffer.from("PNG"), "/w/notes.txt": Buffer.from("notes") };
  const read = (p: string) => { const b = (files as any)[p]; if (!b) throw Object.assign(new Error("no"), { code: "EACCES" }); return b; };
  const size = (p: string) => read(p).length;
  const call = (paths: string[]) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { chat_id: "1", text: "here", files: paths } } });

  test("go as bytes, read here, and the path doesn't", () => {
    const m = withFileBytes(call(["/w/chart.png", "/w/notes.txt"]), read, size);
    expect(m.params.arguments.files).toBeUndefined();
    expect(m.params.arguments.files_data).toEqual([
      { name: "chart.png", data: Buffer.from("PNG").toString("base64") },
      { name: "notes.txt", data: Buffer.from("notes").toString("base64") },
    ]);
  });

  test("one he can't read stops the reply, and says which", () => {
    const m = withFileBytes(call(["/w/chart.png", "/data/options.json"]), read, size);
    expect(m.params.arguments.files_data).toBeUndefined();
    expect(m.params.arguments.files_error).toBe("can't read /data/options.json: EACCES");
  });

  test("more than ten, or more than 25 MB, is refused", () => {
    expect(withFileBytes(call(Array(11).fill("/w/chart.png")), read, size).params.arguments.files_error).toContain("at most 10");
    expect(withFileBytes(call(["/w/chart.png"]), read, () => MAX_BYTES + 1).params.arguments.files_error).toContain("more than 25 MB");
  });

  test("anything else passes untouched", () => {
    const edit = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "edit_message", arguments: { files: ["/x"] } } };
    expect(withFileBytes(edit, read, size)).toBe(edit);
    const plain = reply(3);
    expect(withFileBytes(plain, read, size)).toBe(plain);
  });
});
