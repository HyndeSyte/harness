// A stand-in for the Discord plugin's server, for the first start's channel smoke test only
// (c1/smoke.sh): the same tools and channel capability, nothing sent anywhere. It writes each
// call it gets to SMOKE_LOG and answers as the plugin does ("sent (id: X)"). MCP over stdio,
// one JSON message a line.
import { appendFileSync } from "node:fs";

const LOG = process.env.SMOKE_LOG ?? "";
const s = { type: "string" };
const TOOLS = [
  { name: "reply", description: "Reply on Discord. Pass chat_id from the inbound message.",
    inputSchema: { type: "object", properties: { chat_id: s, text: s, reply_to: s, files: { type: "array", items: s } }, required: ["chat_id", "text"] } },
  { name: "react", description: "Add an emoji reaction.", inputSchema: { type: "object", properties: { chat_id: s, message_id: s, emoji: s }, required: ["chat_id", "message_id", "emoji"] } },
  { name: "edit_message", description: "Edit a message the bot sent.", inputSchema: { type: "object", properties: { chat_id: s, message_id: s, text: s }, required: ["chat_id", "message_id", "text"] } },
  { name: "download_attachment", description: "Download attachments.", inputSchema: { type: "object", properties: { chat_id: s, message_id: s }, required: ["chat_id", "message_id"] } },
  { name: "fetch_messages", description: "Fetch recent messages.", inputSchema: { type: "object", properties: { channel: s, limit: { type: "number" } }, required: ["channel"] } },
];
let seq = 0;
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(++seq));

function handle(m: any): void {
  if (m?.id === undefined || typeof m.method !== "string") return;
  const ok = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize")
    return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {}, experimental: { "claude/channel": {} } }, serverInfo: { name: "discord", version: "smoke" },
      instructions: "A start-up check of the Discord channel. Reply with the reply tool when asked." });
  if (m.method === "tools/list") return ok({ tools: TOOLS });
  if (m.method === "ping") return ok({});
  if (m.method === "tools/call") {
    const name = String(m.params?.name ?? ""), args = m.params?.arguments ?? {};
    if (LOG) appendFileSync(LOG, JSON.stringify({ name, arguments: { ...args, files: undefined } }) + "\n");
    return ok({ content: [{ type: "text", text: name === "reply" ? `sent (id: ${snowflake()})` : "done" }] });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not here" } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  buf += c;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); try { handle(JSON.parse(line)); } catch { /* not ours */ } }
});
process.stdin.on("end", () => process.exit(0));
