// Cain's end of the Discord channel (C1). Claude Code starts this, as Cain's user, for the
// pinned plugin (the seed's .mcp.json names it): it joins Claude Code's stdin and stdout to
// the broker's socket. The broker, as root, runs the plugin's server as its own user with
// the bot token, and gates every send. This side holds no token and decides nothing.
//
// What it does besides passing lines:
//   - A reply's files: it reads each one here, as Cain, and sends the bytes instead of the
//     path, so a reply can attach only what Cain himself can read. Ten files, 25 MB in all.
//   - Until the first connection, everything waits here (the broker may still be starting).
//   - The broker restarting: it reconnects by itself, replays Claude Code's initialize so
//     the new server is ready, and answers any call in flight with an error to send again,
//     so Cain keeps his channel without a restart of his own.
// MCP over stdio is one JSON message a line, both ways.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { connect, type Socket } from "node:net";

export const SOCK = process.env.CAIN_DISCORD_SOCK ?? "/run/cain/discord.sock";
export const MAX_FILES = 10;
export const MAX_BYTES = 25 * 1024 * 1024;
export const RESTARTED = "The Discord channel restarted before this finished; send it again.";
export const RECONNECTING = "The Discord channel is reconnecting; send it again in a few seconds.";

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
  private sock: Socket | null = null;            // connected, or connecting
  private up = false;                            // the current socket is connected
  private everUp = false;
  private buf = "";
  private pending = new Map<string, Msg>();      // Claude Code's calls not yet answered
  private waiting: string[] = [];                // lines held until the socket is up
  private init: Msg | null = null;               // Claude Code's initialize, replayed on reconnect
  private initialized: Msg | null = null;        // and its notifications/initialized
  private replaying = new Set<string>();         // ids of replayed initializes, whose answers stay here
  private backoff = 0;
  private replays = 0;
  private closed = false;

  constructor(private path: string, private toClaude: (line: string) => void,
              private connectFn: (path: string) => Socket = (p) => connect(p),
              private wait: (ms: number, f: () => void) => unknown = (ms, f) => setTimeout(f, ms)) {}

  start(): void { this.open(); }

  private open(): void {
    if (this.closed) return;
    const s = this.connectFn(this.path);
    this.sock = s; this.up = false;
    s.setEncoding("utf8");
    s.on("connect", () => {
      if (this.sock !== s) return;
      const again = this.everUp;
      this.up = true; this.everUp = true; this.backoff = 0;
      if (again && this.init) {
        const id = `bridge-reinit-${++this.replays}`;
        this.replaying.add(id);
        s.write(JSON.stringify({ ...this.init, id }) + "\n");
        if (this.initialized) s.write(JSON.stringify(this.initialized) + "\n");
      }
      const lines = this.waiting;
      this.waiting = [];
      for (const line of lines) s.write(line + "\n");
    });
    s.on("data", (chunk: string) => { if (this.sock === s) this.fromBroker(chunk); });
    s.on("error", () => { /* close follows */ });
    s.on("close", () => {
      if (this.sock !== s) return;
      const wasUp = this.up;
      this.sock = null; this.up = false; this.buf = "";
      if (this.everUp) {
        // Calls in flight never get their answer from the old server: say so now. Lines still
        // waiting are dropped, their calls answered the same way (they're in pending too).
        for (const m of this.pending.values()) this.toClaude(failed(m.id, RESTARTED));
        this.pending.clear();
        this.waiting = [];
      }
      if (this.closed) return;
      this.backoff = wasUp ? 1000 : Math.min(10_000, Math.max(1000, this.backoff * 2));
      this.wait(this.backoff, () => this.open());
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
      if (m && m.id !== undefined && m.method === undefined) {
        const key = String(m.id);
        if (this.replaying.delete(key)) continue;       // a replayed initialize's answer
        this.pending.delete(key);
      }
      this.toClaude(line);
    }
  }

  // One line from Claude Code.
  fromClaude(line: string): void {
    if (!line.trim()) return;
    let m: Msg | null = null;
    try { m = JSON.parse(line); } catch { m = null; }
    if (m && typeof m === "object") {
      if (m.method === "initialize") this.init = m;
      if (m.method === "notifications/initialized") this.initialized = m;
      m = withFileBytes(m);
      line = JSON.stringify(m);
    }
    // Between connections, after the first: a call is answered at once, a notification dropped.
    if (!this.sock && this.everUp) { if (isCall(m)) this.toClaude(failed(m!.id, RECONNECTING)); return; }
    if (isCall(m)) this.pending.set(String(m!.id), m!);
    if (!this.up) { this.waiting.push(line); return; }
    this.sock!.write(line + "\n");
  }

  stop(): void { this.closed = true; this.sock?.destroy(); }
}

if (import.meta.main) {
  const bridge = new Bridge(SOCK, (line) => process.stdout.write(line + "\n"));
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
