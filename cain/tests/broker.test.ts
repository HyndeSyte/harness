// The Discord broker (rootfs/opt/cain/discord/broker.ts): an explicit list both ways, the gate
// on every send, attachments as bytes only, and nothing passed when the gate can't decide.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerSession, checkArgs, fileOutbox, type GateVerdict, MAX_BAD, MAX_PENDING, UNKNOWN } from "../rootfs/opt/cain/discord/broker";

const DM = "1569045703332855809";
const MSG = "1571141530771525664";

function rig(gate: (tool: "reply" | "edit", args: Record<string, unknown>) => Promise<GateVerdict> = async () => ({ kind: "pass", did: "passed" }),
             readsOk: (chat: string) => string = (chat) => (chat === DM ? "" : "not his DM")) {
  const toClient: any[] = [], toServer: any[] = [], logs: string[] = [], sent: any[] = [], gated: any[] = [];
  const timers: { ms: number; f: () => void; on: boolean }[] = [];
  let closed = false;
  const box = mkdtempSync(join(tmpdir(), "outbox-"));
  const s = new BrokerSession({
    toClient: (l) => toClient.push(JSON.parse(l)), toServer: (l) => toServer.push(JSON.parse(l)), close: () => { closed = true; },
    gate: async (tool, args) => { gated.push({ tool, args }); return gate(tool, args); },
    sent: (tool, args, result) => sent.push({ tool, args, result }),
    readsOk, outbox: fileOutbox(box), log: (l) => logs.push(l), session: "conn-1",
    setTimer: (ms, f) => { const t = { ms, f, on: true }; timers.push(t); return t; },
    clearTimer: (t: any) => { if (t) t.on = false; },
  });
  const call = (id: number | string, name: string, args: Record<string, unknown>) =>
    s.fromClient(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
  const answer = (id: number | string, text: string) => s.fromServer(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }));
  return { s, toClient, toServer, logs, sent, gated, timers, box, call, answer, closed: () => closed };
}

describe("from Claude Code: only the list passes", () => {
  test("initialize, ping and tools/list pass; the initialize answer loses the permission relay", async () => {
    const t = rig();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(t.toServer.map((m) => m.method)).toEqual(["initialize", "tools/list"]);
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { capabilities: { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } } } }));
    expect(t.toClient[0].result.capabilities.experimental).toEqual({ "claude/channel": {} });
  });

  test("a permission prompt from the client never reaches the plugin", async () => {
    const t = rig();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel/permission_request",
      params: { request_id: "abcde", tool_name: "Bash", description: "anything at all", input_preview: "{}" } }));
    expect(t.toServer).toEqual([]);
    expect(t.logs.join("\n")).toContain("dropped a notification");
  });

  test("initialized and cancelled pass; other notifications don't", async () => {
    const t = rig();
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed", "notifications/claude/channel"])
      await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", method, params: {} }));
    expect(t.toServer.map((m) => m.method)).toEqual(["notifications/initialized", "notifications/cancelled"]);
  });

  test("any other method is refused, never forwarded", async () => {
    const t = rig();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "file:///data/options.json" } }));
    expect(t.toServer).toEqual([]);
    expect(t.toClient[0].error.code).toBe(-32601);
  });

  test("an unknown tool, or a known one with an extra field, is refused", async () => {
    const t = rig();
    await t.call(1, "send_dm", { chat_id: DM, text: "hi" });
    await t.call(2, "reply", { chat_id: DM, text: "hi", embeds: [] });
    expect(t.toServer).toEqual([]);
    expect(t.toClient.every((m) => m.result?.isError)).toBe(true);
  });

  test("files as paths are refused outright, whatever they name", async () => {
    const t = rig();
    await t.call(3, "reply", { chat_id: DM, text: "here", files: ["/data/options.json"] });
    expect(t.toServer).toEqual([]);
    expect(t.toClient[0].result.content[0].text).toContain("not as paths");
  });

  test("an answer the server never asked for, or garbage, counts against the connection", async () => {
    const t = rig();
    for (let i = 0; i < MAX_BAD; i++) await t.s.fromClient(i % 2 ? "{not json" : JSON.stringify({ jsonrpc: "2.0", id: i, result: {} }));
    expect(t.closed()).toBe(true);
    expect(t.toServer).toEqual([]);
  });

  test(`at most ${MAX_PENDING} calls in flight`, async () => {
    const t = rig();
    for (let i = 0; i < MAX_PENDING + 1; i++) await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }));
    expect(t.toServer.length).toBe(MAX_PENDING);
    expect(t.toClient.at(-1).error.message).toContain("too many calls");
  });
});

describe("sends: the gate decides, and fails closed", () => {
  test("a pass goes as it is, and the link hears what went out", async () => {
    const t = rig();
    await t.call(5, "reply", { chat_id: DM, text: "Done.", reply_to: MSG });
    expect(t.toServer[0].params).toEqual({ name: "reply", arguments: { chat_id: DM, text: "Done.", reply_to: MSG } });
    t.answer(5, "sent (id: 1571243873316114586)");
    expect(t.sent).toHaveLength(1);
    expect(t.toClient[0].result.content[0].text).toBe("sent (id: 1571243873316114586)");
  });

  test("a fix goes with the fixed words, and the answer says so", async () => {
    const t = rig(async () => ({ kind: "fix", text: "Restart the App.", note: "The message gate fixed its wording as it went: add-on to App." }));
    await t.call(6, "reply", { chat_id: DM, text: "Restart the add-on." });
    expect(t.toServer[0].params.arguments.text).toBe("Restart the App.");
    t.answer(6, "sent (id: 1571243873316114586)");
    expect(t.toClient[0].result.content[0].text).toBe("sent (id: 1571243873316114586). The message gate fixed its wording as it went: add-on to App.");
  });

  test("a refusal never reaches the plugin, and says why", async () => {
    const t = rig(async () => ({ kind: "refuse", reason: "The message gate held this: an em dash." }));
    await t.call(8, "edit_message", { chat_id: DM, message_id: MSG, text: "a \u2014 b" });
    expect(t.toServer).toEqual([]);
    expect(t.toClient[0].result).toEqual({ content: [{ type: "text", text: "edit_message failed: The message gate held this: an em dash." }], isError: true });
  });

  test("a gate that throws refuses: nothing unchecked goes out", async () => {
    const t = rig(async () => { throw new Error("boom"); });
    await t.call(9, "reply", { chat_id: DM, text: "hello" });
    expect(t.toServer).toEqual([]);
    expect(t.toClient[0].result.isError).toBe(true);
    expect(t.logs.join("\n")).toContain("the gate failed");
  });

  test("a call that times out while the gate runs is answered once, and never sent", async () => {
    let release: (v: GateVerdict) => void = () => {};
    const t = rig(() => new Promise((r) => { release = r; }));
    const p = t.call(10, "reply", { chat_id: DM, text: "slow" });
    t.timers[0].f();
    release({ kind: "pass", did: "passed" });
    await p;
    expect(t.toServer).toEqual([]);
    expect(t.toClient).toHaveLength(1);
    expect(t.toClient[0].error.message).toContain("didn't answer in time");
  });
});

describe("a reply's files", () => {
  test("bytes are staged for the plugin and the folder goes after the answer", async () => {
    const t = rig();
    const data = Buffer.from("PNG").toString("base64");
    await t.call(11, "reply", { chat_id: DM, text: "Here", files_data: [{ name: "../../chart.png", data }] });
    const paths: string[] = t.toServer[0].params.arguments.files;
    expect(t.toServer[0].params.arguments.files_data).toBeUndefined();
    expect(paths).toHaveLength(1);
    expect(paths[0].startsWith(t.box)).toBe(true);
    expect(paths[0].endsWith("_.._chart.png") || paths[0].endsWith("chart.png")).toBe(true);
    expect(readFileSync(paths[0], "utf8")).toBe("PNG");
    expect(t.gated[0].args.files).toBe("attached");
    t.answer(11, "sent (id: 1571243873316114586)");
    expect(existsSync(paths[0])).toBe(false);
    expect(readdirSync(t.box)).toEqual([]);
  });

  test("the bridge's word that a file couldn't be read stops the reply", async () => {
    const t = rig();
    await t.call(12, "reply", { chat_id: DM, text: "Here", files_error: "can't read /data/options.json: EACCES" });
    expect(t.toServer).toEqual([]);
    expect(t.toClient[0].result.content[0].text).toContain("couldn't be sent");
  });

  test("checkArgs: limits on count, size and shape", () => {
    const one = { name: "a.txt", data: Buffer.from("x").toString("base64") };
    expect("why" in checkArgs("reply", { chat_id: DM, text: "x", files_data: Array(11).fill(one) })).toBe(true);
    expect("why" in checkArgs("reply", { chat_id: DM, text: "x", files_data: [{ name: "a", data: "!!" }] })).toBe(true);
    expect("why" in checkArgs("reply", { chat_id: DM, text: "x", files_data: [{ ...one, path: "/etc/shadow" }] })).toBe(true);
    expect("why" in checkArgs("reply", { chat_id: "general", text: "x" })).toBe(true);
    expect("args" in checkArgs("reply", { chat_id: DM, text: "x", files_data: [one] })).toBe(true);
  });
});

describe("reads and reactions: his DM only", () => {
  test("fetch_messages and react for his DM pass; another chat is refused", async () => {
    const t = rig();
    await t.call(20, "fetch_messages", { channel: DM, limit: 20 });
    await t.call(21, "react", { chat_id: "1111111111111111111", message_id: MSG, emoji: "\u{1F44D}" });
    expect(t.toServer.map((m) => m.params.name)).toEqual(["fetch_messages"]);
    expect(t.toClient[0].result.content[0].text).toContain("not his DM");
  });
});

describe("from the server", () => {
  test("his messages pass; a permission verdict and requests of its own don't", () => {
    const t = rig();
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "hi", meta: { chat_id: DM } } }));
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel/permission", params: { request_id: "abcde", behavior: "allow" } }));
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} }));
    expect(t.toClient.map((m) => m.method)).toEqual(["notifications/claude/channel"]);
  });

  test("an answer to a call that timed out is dropped", async () => {
    const t = rig();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 30, method: "ping" }));
    t.timers[0].f();
    t.s.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 30, result: {} }));
    expect(t.toClient).toHaveLength(1);
    expect(t.toClient[0].error).toBeDefined();
  });

  test("a send the server took and never answered is an unknown outcome, never \"send it again\"", async () => {
    const t = rig();
    await t.call(50, "reply", { chat_id: DM, text: "x" });
    t.s.serverGone();
    expect(t.toClient[0].error.message).toBe(UNKNOWN);
    const u = rig();
    await u.call(51, "edit_message", { chat_id: DM, message_id: MSG, text: "y" });
    u.timers[0].f();
    expect(u.toClient[0].error.message).toBe(UNKNOWN);
  });

  test("when the server goes, every call in flight is told and the connection ends", async () => {
    const t = rig();
    await t.s.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 40, method: "ping" }));
    await t.call(41, "reply", { chat_id: DM, text: "x" });
    t.s.serverGone();
    expect(t.toClient.map((m) => m.id).sort()).toEqual([40, 41]);
    expect(t.closed()).toBe(true);
  });
});
