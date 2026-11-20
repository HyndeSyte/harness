// The Discord broker (C1): the one way to the bot. Root runs it; it runs the pinned plugin's
// server as the discord user with the bot token in that process's environment only, and
// Cain's Claude Code reaches it through the bridge (bridge.ts) on /run/cain/discord.sock.
// Every frame from the socket is treated as an attacker's: Claude Code's are, and a client
// of Cain's own making gets nothing more. What passes is an explicit list, both ways:
//
//   from Claude Code, calls: initialize, ping, tools/list, tools/call for the plugin's five
//     tools only, each with its own fields and nothing else. reply and edit_message pass the
//     message gate first (gateSend); react, fetch_messages and download_attachment only for
//     his DM and the pinned plugin. A reply's files come as bytes the bridge read as Cain
//     (files_data); paths (files) are refused, so nothing is opened for him as root or as
//     discord.
//   from Claude Code, notifications: initialized and cancelled. Anything else is dropped,
//     the permission relay's permission_request included: the plugin answers it by sending
//     Dane a message of its own, outside the gate.
//   from the server: answers, notifications/claude/channel (his messages) and
//     notifications/message. The initialize answer loses the permission-relay capability,
//     so Claude Code never sends a prompt here.
//   the hourly liveness check (Cain 0.14.0, probe/core.ts): the probe asks root's broker, never Discord,
//     to hand his session one fixed line on a chat id no Discord chat has (PROBE_CHAT), as a
//     message of his channel; a reply to that chat is answered here and goes nowhere, and only the
//     fixed answer counts (anything else to it is refused). So the hourly liveness check costs one short
//     turn of his and never reaches Dane, Discord or the gate.
// The gate's hard rules fail closed: an error refuses the call, and no retry passes a hard
// refusal. Limits: 12 MB a line (8 MB of attachments), 32 calls in flight, 60 s a call, 20 bad
// frames. A call that may have done something (a send, an edit, a reaction, a download) and
// never got its answer is told its outcome is unknown, never "send it again".
import { chownSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBE_CHAT, PROBE_LINE, PROBE_REPLY } from "../probe/core";

export const MAX_LINE = 12 * 1024 * 1024;
export const MAX_PENDING = 32;
export const CALL_MS = 60_000;
export const MAX_BAD = 20;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT = 20_000;

type Msg = Record<string, any>;
const SNOWFLAKE = /^\d{15,22}$/;

// The five tools, and the fields each may carry.
export const TOOLS: Record<string, { required: string[]; optional: string[] }> = {
  reply: { required: ["chat_id", "text"], optional: ["reply_to", "files_data", "files_error"] },
  edit_message: { required: ["chat_id", "message_id", "text"], optional: [] },
  react: { required: ["chat_id", "message_id", "emoji"], optional: [] },
  fetch_messages: { required: ["channel"], optional: ["limit"] },
  download_attachment: { required: ["chat_id", "message_id"], optional: [] },
};
const CALLS = new Set(["initialize", "ping", "tools/list", "tools/call"]);
const CLIENT_NOTES = new Set(["notifications/initialized", "notifications/cancelled"]);
const SERVER_NOTES = new Set(["notifications/claude/channel", "notifications/message"]);

// What the gate says about one send (gateSend in gate-call.ts).
export type GateVerdict =
  | { kind: "pass"; did: string }
  | { kind: "fix"; text: string; note: string }
  | { kind: "refuse"; reason: string };

export interface BrokerDeps {
  toClient: (line: string) => void;
  toServer: (line: string) => void;
  close: () => void;                                   // end this connection
  gate: (tool: "reply" | "edit", args: Record<string, unknown>, session: string) => Promise<GateVerdict>;
  sent: (tool: "reply" | "edit", args: Record<string, unknown>, result: unknown, session: string) => void;
  readsOk: (chat: string) => string;                   // "" or why reads (and reacts) are refused for this chat
  outbox: { make: (files: { name: string; data: Buffer }[]) => { dir: string; paths: string[] }; drop: (dir: string) => void };
  log: (line: string) => void;
  session: string;                                     // this connection's name, for the gate's tries
  setTimer?: (ms: number, f: () => void) => unknown;
  clearTimer?: (t: unknown) => void;
  probeAnswered?: () => void;                          // his session gave the hourly liveness check's fixed answer
  heard?: () => void;                                  // a message of the owner's came in for his session (its time only)
}

interface Pending { method: string; tool?: string; args?: Record<string, unknown>; outbox?: string; note?: string; timer?: unknown; initialize?: boolean }

const err = (id: unknown, message: string, code = -32000) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
export const UNKNOWN = "The Discord channel stopped before it confirmed this; it may have gone out. Read the chat (fetch_messages) before sending it again.";
const ACTS = new Set(["reply", "edit_message", "react", "download_attachment"]);
const toolError = (id: unknown, text: string) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

// The arguments of a call, checked against its tool's fields: the clean copy, or why not.
export function checkArgs(name: string, args: unknown): { args: Record<string, unknown> } | { why: string } {
  const spec = TOOLS[name];
  if (!spec) return { why: `${name} isn't one of the Discord tools` };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { why: `${name} takes an object of fields` };
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a))
    if (!spec.required.includes(k) && !spec.optional.includes(k))
      return { why: k === "files"
        ? "files are sent as what you can read, not as paths: the channel reads them for you; if this came from elsewhere, it's refused"
        : `${name} takes ${[...spec.required, ...spec.optional.filter((f) => !f.startsWith("files_"))].join(", ")}; "${k.slice(0, 40)}" isn't one of them` };
  for (const k of spec.required) if (a[k] === undefined || a[k] === null) return { why: `${name} needs ${k}` };
  for (const k of ["chat_id", "message_id", "reply_to", "channel"]) if (a[k] !== undefined && !SNOWFLAKE.test(String(a[k]))) return { why: `${k} isn't a Discord id` };
  for (const k of ["text", "emoji"]) if (a[k] !== undefined && typeof a[k] !== "string") return { why: `${k} must be text` };
  if (typeof a.text === "string" && a.text.length > MAX_TEXT) return { why: `the text is over ${MAX_TEXT} characters` };
  if (a.emoji !== undefined && (String(a.emoji).length === 0 || String(a.emoji).length > 64)) return { why: "one emoji at a time" };
  if (a.limit !== undefined && !(Number.isInteger(a.limit) && (a.limit as number) >= 1 && (a.limit as number) <= 100)) return { why: "limit is 1 to 100" };
  if (a.files_error !== undefined) return { why: `the files couldn't be sent: ${String(a.files_error).slice(0, 200)}` };
  if (a.files_data !== undefined) {
    const f = a.files_data;
    if (!Array.isArray(f) || f.length === 0 || f.length > MAX_FILES) return { why: `at most ${MAX_FILES} files on a message` };
    let total = 0;
    for (const x of f) {
      if (!x || typeof x !== "object" || typeof (x as any).name !== "string" || typeof (x as any).data !== "string" || Object.keys(x).length !== 2)
        return { why: "a file must be its name and its bytes" };
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test((x as any).data)) return { why: "a file's bytes aren't base64" };
      total += Math.floor(((x as any).data.length * 3) / 4);
    }
    if (total > MAX_FILE_BYTES) return { why: "the files come to more than 8 MB" };
  }
  return { args: { ...a } };
}

// A file name the outbox can take: letters, digits, dot, dash, underscore, space.
export const cleanName = (n: string, i: number) => (n.replace(/[^\w.\- ]/g, "_").replace(/^\.+/, "").slice(0, 120) || `file-${i + 1}`);

export class BrokerSession {
  private pending = new Map<string, Pending>();
  private bad = 0;
  private initId: string | null = null;
  private closed = false;
  private ready = false;                               // Claude Code's initialize was answered
  constructor(private d: BrokerDeps) {}

  // The hourly liveness check's line, handed to his session as a message of his channel. false when there
  // is no session to hand it to yet.
  probe(messageId: string): boolean {
    if (this.closed || !this.ready) return false;
    this.d.toClient(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: PROBE_LINE,
      meta: { chat_id: PROBE_CHAT, message_id: messageId, user: "cain-app-probe", user_id: PROBE_CHAT, ts: new Date().toISOString() } } }));
    this.d.log("handed his session the hourly liveness check");
    return true;
  }

  private refuseFrame(why: string): void {
    this.bad++;
    this.d.log(`refused a frame: ${why}`);
    if (this.bad >= MAX_BAD) { this.d.log("closed a connection after too many bad frames"); this.end(); }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) { this.d.clearTimer?.(p.timer); if (p.outbox) this.d.outbox.drop(p.outbox); this.pending.delete(id); }
    this.d.close();
  }

  // The server stopped: every call in flight gets an error, and the connection ends.
  serverGone(): void {
    for (const [key, p] of this.pending) {
      this.d.clearTimer?.(p.timer);
      if (p.outbox) this.d.outbox.drop(p.outbox);
      this.d.toClient(err(JSON.parse(key), p.tool && ACTS.has(p.tool) && p.args ? UNKNOWN : "The Discord channel stopped before this finished; try it again."));
    }
    this.pending.clear();
    this.end();
  }

  async fromClient(line: string): Promise<void> {
    if (this.closed || !line.trim()) return;
    if (line.length > MAX_LINE) return this.refuseFrame("too long");
    let m: Msg;
    try { m = JSON.parse(line); } catch { return this.refuseFrame("not JSON"); }
    if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") return this.refuseFrame("not a JSON-RPC message");
    const hasId = m.id !== undefined && m.id !== null && (typeof m.id === "string" || typeof m.id === "number");
    if (typeof m.method !== "string") return this.refuseFrame(hasId ? "an answer the server never asked for" : "no method");
    if (!hasId) {                                             // a notification
      if (CLIENT_NOTES.has(m.method)) this.d.toServer(JSON.stringify(m));
      else this.d.log(`dropped a notification: ${m.method.slice(0, 60)}`);
      return;
    }
    const key = JSON.stringify(m.id);
    if (this.pending.has(key)) return void this.d.toClient(err(m.id, "a call with this id is already in flight"));
    if (!CALLS.has(m.method)) { this.d.log(`refused a call: ${m.method.slice(0, 60)}`); return void this.d.toClient(err(m.id, `${m.method.slice(0, 60)} isn't allowed here`, -32601)); }
    if (this.pending.size >= MAX_PENDING) return void this.d.toClient(err(m.id, "too many calls in flight; send it again in a moment"));
    if (m.method !== "tools/call") {
      const p: Pending = { method: m.method, initialize: m.method === "initialize" };
      if (p.initialize) this.initId = key;
      this.track(key, m.id, p);
      return void this.d.toServer(JSON.stringify({ jsonrpc: "2.0", id: m.id, method: m.method, ...(m.params !== undefined ? { params: m.params } : {}) }));
    }
    const name = String(m.params?.name ?? "");
    const checked = checkArgs(name, m.params?.arguments);
    if ("why" in checked) { this.d.log(`refused ${name.slice(0, 40) || "a tool call"}: ${checked.why}`); return void this.d.toClient(toolError(m.id, `${name || "This call"} failed: ${checked.why}`)); }
    let args = checked.args;
    // The hourly liveness check's chat: answered here, never sent on. Only the fixed answer counts.
    if (String(args.chat_id ?? args.channel ?? "") === PROBE_CHAT) {
      if (name === "reply" && String(args.text ?? "").trim() === PROBE_REPLY && args.files_data === undefined) {
        try { this.d.probeAnswered?.(); } catch (e) { this.d.log(`couldn't keep the hourly liveness check's answer: ${String(e).slice(0, 80)}`); }
        this.d.log("his session answered the hourly liveness check");
        return void this.d.toClient(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sent" }] } }));
      }
      return void this.d.toClient(toolError(m.id, `${name} failed: this chat is your App's hourly liveness check; it takes only a reply with the text "${PROBE_REPLY}"`));
    }
    const p: Pending = { method: "tools/call", tool: name };
    this.track(key, m.id, p);                                // counted while the gate runs
    if (name === "reply" || name === "edit_message") {
      const tool = name === "reply" ? "reply" : "edit";
      // The gate sees the message, and whether it carries files (a fix then goes back to him
      // to send, as the reply hook did), never the bytes.
      const { files_data: bytes, ...words } = args;
      let v: GateVerdict;
      try { v = await this.d.gate(tool, bytes === undefined ? words : { ...words, files: "attached" }, this.d.session); }
      catch (e) { v = { kind: "refuse", reason: "The message gate couldn't check this, so it wasn't sent; send it again." }; this.d.log(`the gate failed on a ${tool}: ${String(e).slice(0, 120)}`); }
      if (this.closed || !this.pending.has(key)) return;     // the connection ended, or the call timed out, meanwhile
      if (v.kind === "refuse") { this.untrack(key); return void this.d.toClient(toolError(m.id, `${name} failed: ${v.reason}`)); }
      if (v.kind === "fix") { args = { ...args, text: v.text }; p.note = v.note; }
      if (name === "reply" && Array.isArray(args.files_data)) {
        try {
          const files = (args.files_data as { name: string; data: string }[]).map((f, i) => ({ name: cleanName(f.name, i), data: Buffer.from(f.data, "base64") }));
          const box = this.d.outbox.make(files);
          p.outbox = box.dir;
          args = { ...args, files: box.paths };
        } catch (e) {
          this.untrack(key);
          this.d.log(`couldn't stage a reply's files: ${String(e).slice(0, 120)}`);
          return void this.d.toClient(toolError(m.id, "reply failed: its files couldn't be staged; send it again."));
        }
      }
      delete args.files_data;
      p.args = args;
    } else {
      const chat = String(name === "fetch_messages" ? args.channel : args.chat_id);
      const why = this.d.readsOk(chat);
      if (why) { this.untrack(key); this.d.log(`refused ${name}: ${why}`); return void this.d.toClient(toolError(m.id, `${name} failed: ${why}`)); }
      p.args = args;
    }
    this.d.toServer(JSON.stringify({ jsonrpc: "2.0", id: m.id, method: "tools/call", params: { name, arguments: p.args } }));
  }

  private track(key: string, id: unknown, p: Pending): void {
    p.timer = this.d.setTimer?.(CALL_MS, () => {
      if (!this.pending.has(key)) return;
      this.untrack(key);
      this.d.toClient(err(id, p.tool && ACTS.has(p.tool) && p.args ? UNKNOWN : "The Discord channel didn't answer in time; try it again."));
    });
    this.pending.set(key, p);
  }
  private untrack(key: string): Pending | undefined {
    const p = this.pending.get(key);
    if (!p) return;
    this.d.clearTimer?.(p.timer);
    if (p.outbox) this.d.outbox.drop(p.outbox);
    this.pending.delete(key);
    return p;
  }

  fromServer(line: string): void {
    if (this.closed || !line.trim()) return;
    let m: Msg;
    try { m = JSON.parse(line); } catch { return this.d.log("the server sent something that isn't JSON; dropped"); }
    if (!m || typeof m !== "object") return;
    const isAnswer = m.id !== undefined && m.id !== null && typeof m.method !== "string";
    if (isAnswer) {
      const key = JSON.stringify(m.id);
      const p = this.untrack(key);
      if (!p) return;                                        // timed out, or never ours
      if (p.initialize && m.result && !m.error) this.ready = true;
      if (p.initialize && m.result?.capabilities?.experimental) {
        const exp = { ...m.result.capabilities.experimental };
        delete exp["claude/channel/permission"];
        m = { ...m, result: { ...m.result, capabilities: { ...m.result.capabilities, experimental: exp } } };
      }
      if ((p.tool === "reply" || p.tool === "edit_message") && m.result && !m.result.isError) {
        try { this.d.sent(p.tool === "reply" ? "reply" : "edit", p.args ?? {}, m.result, this.d.session); }
        catch (e) { this.d.log(`couldn't report a send to the link: ${String(e).slice(0, 120)}`); }
        if (p.note && Array.isArray(m.result.content) && m.result.content[0]?.type === "text")
          m = { ...m, result: { ...m.result, content: [{ ...m.result.content[0], text: `${m.result.content[0].text}. ${p.note}` }, ...m.result.content.slice(1)] } };
      }
      return void this.d.toClient(JSON.stringify(m));
    }
    if (typeof m.method === "string" && m.id === undefined) {
      if (SERVER_NOTES.has(m.method)) {
        // A message of the owner's came in for his session: the hourly liveness check keeps 5 minutes clear
        // of it (probe/core.ts askDue). Only the time is noted, nothing of the message.
        if (m.method === "notifications/claude/channel") { try { this.d.heard?.(); } catch { /* the probe then asks as usual */ } }
        this.d.toClient(JSON.stringify(m));
      }
      else this.d.log(`dropped a server notification: ${m.method.slice(0, 60)}`);
      return;
    }
    this.d.log(`dropped a request from the server: ${String(m.method).slice(0, 60)}`);
  }
}

// The outbox: one folder per reply with files, readable by discord (the server opens them).
export function fileOutbox(root: string, group?: { gid: number }) {
  let n = 0;
  return {
    make(files: { name: string; data: Buffer }[]) {
      const dir = join(root, `${process.pid}-${Date.now()}-${++n}`);
      mkdirSync(dir, { recursive: true, mode: 0o750 });
      if (group) chownSync(dir, 0, group.gid);
      const used = new Set<string>();
      const paths = files.map((f, i) => {
        let name = f.name;
        while (used.has(name)) name = `${i + 1}-${name}`;
        used.add(name);
        const p = join(dir, name);
        writeFileSync(p, f.data, { mode: 0o640, flag: "wx" });
        if (group) chownSync(p, 0, group.gid);
        return p;
      });
      return { dir, paths };
    },
    drop(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}
