// A stand-in for the Discord plugin's MCP server, for discord-send.cli.test.ts only (not a
// test file itself). Named in its MCP config as plugin_discord_discord, so Claude Code calls
// its tools mcp__plugin_discord_discord__reply and __edit_message, as it calls the plugin's.
// It writes each call it gets to STUB_LOG and answers as the plugin does ("sent (id: X)").
// Plain JSON-RPC over stdio, one message a line.
import { appendFileSync } from "node:fs";

const LOG = process.env.STUB_LOG ?? "";
const text = { type: "string" };
const TOOLS = [
  { name: "reply", description: "Reply on Discord. Pass chat_id from the inbound message.",
    inputSchema: { type: "object", properties: { chat_id: text, text, reply_to: text }, required: ["chat_id", "text"] } },
  { name: "edit_message", description: "Edit a message the bot previously sent.",
    inputSchema: { type: "object", properties: { chat_id: text, message_id: text, text }, required: ["chat_id", "message_id", "text"] } },
];

const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(m: any): void {
  const ok = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize")
    return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "discord", version: "0.0.4" } });
  if (m.method === "tools/list") return ok({ tools: TOOLS });
  if (m.method === "tools/call") {
    const name = String(m.params?.name ?? ""), args = m.params?.arguments ?? {};
    if (LOG) appendFileSync(LOG, JSON.stringify({ name, arguments: args }) + "\n");
    return ok({ content: [{ type: "text", text: name === "reply" ? "sent (id: 1300000000000000777)" : `edited (id: ${args.message_id})` }] });
  }
  if (m.method === "ping") return ok({});
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* not a message */ }
  }
});
