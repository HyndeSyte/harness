// Cain's end of the Discord channel (C1). Claude Code starts this, as Cain's user, for the
// pinned plugin (the seed's .mcp.json names it): it joins Claude Code's stdin and stdout to
// the broker's socket. The broker, as root, runs the plugin's server as its own user with
// the bot token, and gates every send. This side holds no token and decides nothing.
//
// What it does besides passing lines:
//   - A reply's files: it reads each one here, as Cain, and sends the bytes instead of the
//     path, so a reply can attach only what Cain himself can read. Ten files, 8 MB in all.
//   - Until the first connection, everything waits here (the broker may still be starting).
//   - Once connected, a lost connection ends the channel: calls in flight are told their
//     outcome is unknown (a send may have gone out), and the bridge exits. Nothing is
//     replayed; the run script restarts Cain's session when the channel stays down.
// MCP over stdio is one JSON message a line, both ways.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { connect, type Socket } from "node:net";

export const SOCK = process.env.CAIN_DISCORD_SOCK ?? "/run/cain/discord.sock";
export const MAX_FILES = 10;
export const MAX_BYTES = 8 * 1024 * 1024;
// The one limit on what goes to the broker: the whole line, text, names and encoded bytes
// included (the broker refuses longer lines too).
export const MAX_LINE = 12 * 1024 * 1024;
export const UNKNOWN = "The Discord channel stopped before it confirmed this; it may have gone out. Read the chat (fetch_messages) before sending it again.";

type Msg = Record<string, any>;
const isCall = (m: Msg | null) => !!m && m.id !== undefined && typeof m.method === "string";
const failed = (id: unknown, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });

// A reply's files, read here and sent as bytes; or why they can't be.
export function withFileBytes(m: Msg, read = (p: string) => readFileSync(p), size = (p: string) => statSync(p).size): Msg {
  if (m?.method !== "tools/call" || m?.params?.name !== "reply") return m;
  const args = m.params.arguments ?? {};
  if (!Array.isArray(args.files) || args.files.length === 0) return m;
  const files: unknown[] = args.files;
  const rest: Record<string, unknown> = { ...args };
  delete rest.files;
  const out = { ...m, params: { ...m.params, arguments: rest } };
  if (files.length > MAX_FILES) { rest.files_error = `Discord takes at most ${MAX_FILES} files on a message`; return out; }
  let total = 0;
  const data: { name: string; data: string }[] = [];
  for (const f of files) {
    const path = String(f);
    try {
      total += size(path);
      if (total > MAX_BYTES) { rest.files_error = `the files come to more than ${MAX_BYTES / 1048576} MB`; return out; }
      data.push({ name: basename(path).replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file", data: read(path).toString("base64") });
    } catch (e: any) {
      rest.files_error = `can't read ${path}: ${e?.code ?? "unreadable"}`;
      return out;
    }
  }
  rest.files_data = data;
  return out;
}

export class Bridge {
  private sock: Socket | null = null;
  private up = false;
  private buf = "";
  private pending = new Map<string, Msg>();      // Claude Code's calls not yet answered
  private waiting: string[] = [];                // lines held until the first connection
  private backoff = 0;
  private closed = false;

  constructor(private path: string, private toClaude: (line: string) => void, private exit: (code: number) => void,
              private connectFn: (path: string) => Socket = (p) => connect(p),
              private wait: (ms: number, f: () => void) => unknown = (ms, f) => setTimeout(f, ms)) {}

  start(): void { this.open(); }

  private open(): void {
    if (this.closed) return;
    const s = this.connectFn(this.path);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      if (this.sock !== s) return;
      this.up = true;
      const lines = this.waiting;
      this.waiting = [];
      for (const line of lines) s.write(line + "\n");
    });
    s.on("data", (chunk: string) => { if (this.sock === s) this.fromBroker(chunk); });
    s.on("error", () => { /* close follows */ });
    s.on("close", () => {
      if (this.sock !== s || this.closed) return;
      if (!this.up) {                                 // never connected: the broker may be starting
        this.sock = null;
        this.backoff = Math.min(5_000, Math.max(500, this.backoff * 2));
        this.wait(this.backoff, () => this.open());
        return;
      }
      // Connected once and lost: every call in flight may or may not have happened.
      for (const m of this.pending.values()) this.toClaude(failed(m.id, UNKNOWN));
      this.pending.clear();
      this.closed = true;
      this.exit(1);
    });
  }

  private fromBroker(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m: Msg | null = null;
      try { m = JSON.parse(line); } catch { /* not ours to judge: pass it on */ }
      if (m && m.id !== undefined && m.method === undefined) this.pending.delete(String(m.id));
      this.toClaude(line);
    }
  }

  // One line from Claude Code.
  fromClaude(line: string): void {
    if (!line.trim() || this.closed) return;
    let m: Msg | null = null;
    try { m = JSON.parse(line); } catch { m = null; }
    if (m && typeof m === "object") { m = withFileBytes(m); line = JSON.stringify(m); }
    if (Buffer.byteLength(line) > MAX_LINE) {
      if (isCall(m)) this.toClaude(failed(m!.id, `This is over the channel's limit of ${MAX_LINE / 1048576} MB in all; send less (smaller or fewer files, or shorter text).`));
      return;
    }
    if (isCall(m)) this.pending.set(String(m!.id), m!);
    if (!this.up) { this.waiting.push(line); return; }
    this.sock!.write(line + "\n");
  }

  stop(): void { this.closed = true; this.sock?.destroy(); }
}

if (import.meta.main) {
  const bridge = new Bridge(SOCK, (line) => process.stdout.write(line + "\n"), (code) => process.exit(code));
  bridge.start();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); bridge.fromClaude(line); }
  });
  // Claude Code closing the channel ends it here too.
  const end = () => { bridge.stop(); process.exit(0); };
  process.stdin.on("end", end);
  process.stdin.on("close", end);
  process.on("SIGTERM", end);
}
