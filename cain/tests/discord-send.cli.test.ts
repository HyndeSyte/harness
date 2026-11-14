// Decision A, against the real Claude Code CLI (local only). Cain runs `claude
// --permission-mode auto`, and the hooks docs say an updatedInput that comes without a
// decision can be refused in auto mode, so the reply hook answers "allow" with the call's
// whole input and only its text fixed ("add-on" made "App"). This proves the CLI then sends
// the fixed text to an MCP tool named like the plugin's, and hands that same input to the
// PostToolUse hook (discord-sent.ts, wired in the background as settings.json wires it),
// which tells the link what went out; that a refusal ("and 3 more", or any em dash) reaches
// the model as the hook's reason, with nothing sent; and that an edit straight after a reply
// passes on the session's own transcript, before the link has heard of the reply.
//
// The model is a stand-in: a local server speaking the Messages API that answers the
// session's first turn with one reply tool call (then, when asked, one edit of that reply)
// and its last with "done". So nothing here needs an account or the network, and what's
// tested is the CLI's own handling of hooks, permissions and MCP. Skipped where `claude`
// isn't on PATH, as in CI.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDIT_TOOL, REPLY_TOOL, sentIds } from "../rootfs/opt/cain/gate/plugin";

const CLAUDE = Bun.which("claude");
const live = CLAUDE && !process.env.CI ? test : test.skip;
const slash = (p: string) => p.replaceAll("\\", "/");
const HOOK = slash(join(import.meta.dir, "../rootfs/opt/cain/hooks/discord-send.ts"));
const SENT = slash(join(import.meta.dir, "../rootfs/opt/cain/hooks/discord-sent.ts"));
const STUB = slash(join(import.meta.dir, "stub-discord-mcp.ts"));
const DM = "1300000000000000500";

// Server-sent events for one streamed assistant message.
function sse(blocks: any[], stop: "tool_use" | "end_turn"): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("message_start", { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant",
    model: "claude-haiku-stand-in", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "tool_use") {
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    } else {
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index });
  });
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  return out + ev("message_stop", { type: "message_stop" });
}

const resultText = (r: any) => (Array.isArray(r?.content) ? r.content.map((c: any) => String(c?.text ?? "")).join(" ") : String(r?.content ?? ""));

// One session of the real CLI with Cain's two hooks, the stand-in plugin and a stand-in
// model that calls the reply tool once with `text`, and then, with `edit`, edits that reply.
// Returns what the plugin got, what the link was told, the tool results the model saw, and
// the gate's log. The stand-in link's list of Cain's replies stays empty throughout.
async function session(text: string, o: { edit?: string; told?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-cli-"));
  const log = join(dir, "stub.jsonl");
  writeFileSync(join(dir, ".env"), "DISCORD_BOT_TOKEN=not-a-real-token.for-the-cli-test\n");
  writeFileSync(join(dir, "dm.json"), JSON.stringify({ dm: DM, at: Date.now() }));
  const told: any[] = [], seen = new Map<string, any>();      // seen: the tool results the model saw, by call
  const link = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/cards") return Response.json({ written_at: Date.now(), owner: "4242", dm: DM, cards: [], sent: [] });
    if (path === "/sent") { told.push(await req.json()); return Response.json({ status: "ok" }); }
    return new Response("no", { status: 404 });
  } });
  const model = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.endsWith("/messages")) return Response.json({ data: [] });
    const body: any = await req.json().catch(() => ({}));
    const blocks = (body.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    const answer = (id: string) => blocks.find((b: any) => b?.type === "tool_result" && b.tool_use_id === id);
    const mainLoop = (body.tools ?? []).some((t: any) => t?.name === REPLY_TOOL);
    const replied = answer("toolu_gate_1"), edited = answer("toolu_gate_2");
    let reply: { blocks: any[]; stop: "tool_use" | "end_turn" };
    if (!mainLoop) reply = { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" };   // anything else the CLI asks on the side
    else if (!replied) reply = { blocks: [{ type: "tool_use", id: "toolu_gate_1", name: REPLY_TOOL, input: { chat_id: DM, text } }], stop: "tool_use" };
    else if (o.edit && !edited && sentIds(resultText(replied)).length) {
      seen.set("toolu_gate_1", replied);
      const target = sentIds(resultText(replied))[0];
      reply = { blocks: [{ type: "tool_use", id: "toolu_gate_2", name: EDIT_TOOL, input: { chat_id: DM, message_id: target, text: o.edit } }], stop: "tool_use" };
    } else {
      for (const r of [replied, edited]) if (r) seen.set(r.tool_use_id, r);
      reply = { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    }
    if (body.stream === false) return Response.json({ id: "msg_side", type: "message", role: "assistant", model: "claude-haiku-stand-in",
      content: reply.blocks.map((b) => (b.type === "text" ? b : { ...b })), stop_reason: reply.stop, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } });
    return new Response(sse(reply.blocks, reply.stop), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { plugin_discord_discord: {
      type: "stdio", command: "bun", args: [STUB], env: { STUB_LOG: slash(log) } } } }));
    // Cain's wiring (settings.json), pointed at the hooks in this checkout: the gate waited
    // for, the safety net in the background.
    const pre = { type: "command", command: `bun '${HOOK}' || true`, timeout: 5 };
    const post = { type: "command", command: `bun '${SENT}' || true`, timeout: 15, async: true };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: {
      PreToolUse: [REPLY_TOOL, EDIT_TOOL].map((matcher) => ({ matcher, hooks: [pre] })),
      PostToolUse: [REPLY_TOOL, EDIT_TOOL].map((matcher) => ({ matcher, hooks: [post] })),
    } }));
    // Tool search off, so the plugin's tools are offered up front and the stand-in model can
    // call one on its first turn (with it on, a model loads a tool through ToolSearch first).
    const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`,
      ANTHROPIC_API_KEY: "sk-ant-stand-in", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ENABLE_TOOL_SEARCH: "false",
      CAIN_LINK: `http://127.0.0.1:${link.port}`, CAIN_DISCORD_ENV: join(dir, ".env"), CAIN_GATE_DM: join(dir, "dm.json"),
      CAIN_GATE_TRIES: join(dir, "tries.json"), CAIN_GATE_LOG: join(dir, "gate.jsonl"), CAIN_CARDS: join(dir, "none.json") };
    for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(OAUTH|SESSION|HOST|MESSAGING|CHILD|ENTRYPOINT)/.test(k) || k === "CLAUDECODE") delete env[k];
    // An edit's check reads the session's transcript, as on the Pi: so that session is kept,
    // in a config folder of the test's own.
    if (o.edit) env.CLAUDE_CONFIG_DIR = join(dir, "config");
    const p = Bun.spawn([CLAUDE!, "-p", "Tell him swim moved.", "--model", "haiku", "--permission-mode", "auto",
      "--mcp-config", join(dir, "mcp.json"), "--strict-mcp-config", "--settings", join(dir, "settings.json"),
      "--setting-sources", "project", ...(o.edit ? [] : ["--no-session-persistence"]), "--output-format", "json"],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env });
    const timer = setTimeout(() => p.kill(), 150_000);
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    await p.exited;
    clearTimeout(timer);
    for (let i = 0; i < 150 && told.length < (o.told ?? 0); i++) await Bun.sleep(100);   // the PostToolUse hooks run in the background
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const gate = existsSync(join(dir, "gate.jsonl")) ? readFileSync(join(dir, "gate.jsonl"), "utf8") : "";
    return { calls, told, results: [...seen.values()], gate, said: `${out.slice(0, 1200)} ${err.slice(0, 400)}` };
  } finally { link.stop(true); model.stop(true); }
}

live("an allowed updatedInput reaches the plugin's reply tool in auto mode, and the PostToolUse hook sees it", async () => {
  const s = await session("Restarted the add-on at 4:30.", { told: 1 });
  if (!s.calls.length) console.log(`claude said: ${s.said}`);
  // The plugin got the fixed words, and the rest of the input as the model wrote it.
  expect(s.calls.map((c: any) => ({ name: c.name, arguments: c.arguments }))).toEqual([{ name: "reply", arguments: { chat_id: DM, text: "Restarted the App at 4:30." } }]);
  const id = sentIds(s.calls[0].answer)[0];
  // The PostToolUse hook, in the background, saw the fixed words and the plugin's answer: the id and its tool call, nothing for the net.
  expect(s.told).toEqual([{ tool: "reply", ids: [id], question: false, call: "toolu_gate_1", chat: DM }]);
  expect(JSON.stringify(s.results)).toContain(`sent (id: ${id})`);
  expect(s.gate).toContain('"did":"fixed"');
}, 180_000);

live("a refusal reaches the model as the hook's reason, and nothing is sent", async () => {
  const s = await session("Two blocks moved and 3 more.");
  if (!s.results.length) console.log(`claude said: ${s.said}`);
  expect(s.calls).toEqual([]);
  expect(s.told).toEqual([]);
  expect(JSON.stringify(s.results)).toContain("The message gate held this:");
  expect(JSON.stringify(s.results)).toContain("name each one instead of a count");
  expect(s.gate).toContain('"did":"refused"');
}, 180_000);

live("an em dash is refused the same way, never fixed: nothing is sent, and the reason says how to say it without one", async () => {
  const s = await session("Moved swim — it's at 4:30 now.");
  if (!s.results.length) console.log(`claude said: ${s.said}`);
  expect(s.calls).toEqual([]);
  expect(s.told).toEqual([]);
  expect(JSON.stringify(s.results)).toContain("The message gate held this:");
  expect(JSON.stringify(s.results)).toContain("an em dash; rewrite it without one");
  expect(s.gate).toContain('"did":"refused"');
}, 180_000);

// Both carry "add-on", so the hook decides each (allow, fixed) and auto mode's classifier,
// which the stand-in model can't play, never runs: the edit is fixed in place only once its
// target passed as his own reply.
live("an edit straight after a reply passes on the session's transcript, though the link's list doesn't have the reply", async () => {
  const s = await session("Restarted the add-on at 4:30.", { edit: "Restarted the add-on at 5:00.", told: 2 });
  if (s.calls.length < 2) console.log(`claude said: ${s.said} results: ${JSON.stringify(s.results).slice(0, 600)}`);
  const id = sentIds(s.calls[0]?.answer ?? "")[0];
  expect(s.calls.map((c: any) => ({ name: c.name, arguments: c.arguments }))).toEqual([
    { name: "reply", arguments: { chat_id: DM, text: "Restarted the App at 4:30." } },
    { name: "edit_message", arguments: { chat_id: DM, message_id: id, text: "Restarted the App at 5:00." } },
  ]);
  expect(s.gate.trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l).did)).toEqual(["fixed", "fixed"]);
  expect(s.told).toContainEqual({ tool: "edit", ids: [id], question: false, call: "toolu_gate_2", chat: DM });
}, 180_000);
