// Runs the Discord broker (broker.ts), as root: listens on /run/cain/discord.sock (root:cain
// 0660) and, for each connection, starts the pinned plugin's server as the discord user.
// The bot token goes only into that process's environment, through the spawn call itself:
// never into a command line, which any user can read in /proc.
// One connection at a time: a new one replaces the old, whose server is stopped.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pinProblem } from "./pin";
import { appendGate } from "../gate/log";
import { checkAccess, ownerDm } from "../hooks/discord-read";
import { tellLink } from "../hooks/discord-sent";
import { BrokerSession, fileOutbox, MAX_LINE } from "./broker";
import { gateSend, sentNote } from "./gate-call";

const env = process.env;
const SOCK = env.CAIN_DISCORD_SOCK ?? "/run/cain/discord.sock";
const TOKEN_FILE = env.CAIN_DISCORD_TOKEN_FILE ?? "/data/link/discord.env";
const STATE = env.CAIN_DISCORD_STATE ?? "/data/discord";
const PLUGIN = env.CAIN_DISCORD_PLUGIN ?? "/opt/cain/discord/plugin";
const OUTBOX = env.CAIN_DISCORD_OUTBOX ?? "/run/cain/outbox";
const LINK_SOCK = env.CAIN_LINK_SOCK ?? "/run/cain/link.sock";
const LINK_STATE = env.CAIN_LINK_STATE ?? "/data/link/state.json";
const CARDS = env.CAIN_CARDS ?? "/data/trust/cards.json";
const REPLIED = env.CAIN_GATE_REPLIED ?? "/data/gate/replied.json";
const CAIN_GID = Number(env.CAIN_GID ?? 1000);
const DISCORD_GID = Number(env.DISCORD_GID ?? 1001);
// For the tests only (the run script never sets it): the server's command in place of the
// pinned plugin as discord.
const SERVER_CMD: string[] | null = env.CAIN_DISCORD_SERVER_CMD ? JSON.parse(env.CAIN_DISCORD_SERVER_CMD) : null;

const log = (line: string) => console.log(`[discord] ${line}`);
const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

function token(): string {
  return text(TOKEN_FILE)?.match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
}

// The pinned plugin, file for file (pin.ts, which the upkeep shares).
export { pinProblem };

// His replies, by id: what he may edit. The newest 2000, kept on disk for restarts.
const replied = new Set<string>();
try { for (const id of JSON.parse(readFileSync(REPLIED, "utf8"))) if (typeof id === "string") replied.add(id); } catch { /* none yet */ }
function addReplied(ids: string[]): void {
  for (const id of ids) replied.add(id);
  while (replied.size > 2000) replied.delete(replied.values().next().value as string);
  try { mkdirSync(join(REPLIED, ".."), { recursive: true }); writeFileSync(`${REPLIED}.tmp`, JSON.stringify([...replied]), { mode: 0o640 }); renameSync(`${REPLIED}.tmp`, REPLIED); }
  catch (e) { log(`couldn't save his replies: ${String(e).slice(0, 80)}`); }
}

async function linkCall(path: string, init: RequestInit = {}, timeoutMs = 1_500): Promise<Response> {
  return fetch(`http://link${path}`, { ...init, unix: LINK_SOCK, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
}

function dmNow(): string {
  try { const c = JSON.parse(text(CARDS) ?? ""); if (typeof c?.dm === "string" && /^\d{15,22}$/.test(c.dm)) return c.dm; } catch { /* below */ }
  return ownerDm(text(join(STATE, "access.json")), text(LINK_STATE));
}

let pinned = pinProblem();
if (pinned) log(`ERROR: ${pinned}. The broker won't start the plugin until the image is right.`);

function readsOk(chat: string): string {
  const bad = checkAccess(text(join(STATE, "access.json")));
  if (bad) return `Discord reads are refused: ${bad}.`;
  if (pinned) return `Discord reads are refused: ${pinned}.`;
  const dm = dmNow();
  if (!dm) return "his DM isn't known yet (the link records it once it reaches Discord), so this is refused for now; try again in a minute.";
  if (chat !== dm) return "only his DM can be read or reacted to.";
  return "";
}

let current: { sock: Socket; session: BrokerSession } | null = null;
let n = 0;

// Whether Cain's channel is connected, for the run script's watchdog (it restarts his session
// when this has said "down" for 90 seconds): "connected <s>" or "down <s>", whole.
const STATE_FILE = env.CAIN_DISCORD_STATE_FILE ?? "/run/cain/discord.state";
// A broker that restarts under a connected channel leaves it dead (the bridge never reconnects):
// say "down" from now, so the watchdog restarts his session. Before any connection: no state.
try { if (readFileSync(STATE_FILE, "utf8").startsWith("connected")) channelState("down"); } catch { /* none yet */ }
function channelState(what: "connected" | "down"): void {
  if (env.CAIN_BROKER_SMOKE === "1") return;
  try { writeFileSync(`${STATE_FILE}.tmp`, `${what} ${Math.floor(Date.now() / 1000)}
`, { mode: 0o644 }); renameSync(`${STATE_FILE}.tmp`, STATE_FILE); }
  catch { /* the watchdog then sees nothing new, and waits */ }
}

function lineReader(onLine: (l: string) => void, onTooLong: () => void) {
  let buf = "", skipping = false;
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (skipping) { skipping = false; continue; }
      onLine(line);
    }
    if (buf.length > MAX_LINE) { buf = ""; if (!skipping) onTooLong(); skipping = true; }
  };
}

function connection(sock: Socket): void {
  if (current) { log("a new connection replaced the one before"); current.session.end(); }
  sock.setEncoding("utf8");
  const name = `conn-${++n}-${Date.now()}`;
  if (pinned) { sock.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `The Discord channel is down: ${pinned}.` } }) + "\n"); return; }
  const proc = Bun.spawn(SERVER_CMD ?? ["setpriv", "--reuid=discord", "--regid=discord", "--init-groups", "--no-new-privs",
    "--inh-caps=-all", "--bounding-set=-all", "/usr/local/bin/bun", join(PLUGIN, "server.ts")], {
    cwd: PLUGIN,
    // The token's only way in: this process's environment, never its command line. The smoke
    // test's stand-in (c1/smoke-server.ts) gets no token, only where to note what it was sent.
    env: env.CAIN_BROKER_SMOKE === "1"
      ? { HOME: "/run/cain/root-tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", SMOKE_LOG: env.SMOKE_LOG ?? "" }
      : { HOME: STATE, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISCORD_STATE_DIR: STATE,
          DISCORD_ACCESS_MODE: "static", DISCORD_BOT_TOKEN: token() },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const conn = { sock, session: null as unknown as BrokerSession };
  const session = new BrokerSession({
    toClient: (l) => { if (!sock.destroyed) sock.write(l + "\n"); },
    toServer: (l) => { try { proc.stdin.write(l + "\n"); proc.stdin.flush(); } catch { /* it's gone: serverGone follows */ } },
    close: () => { try { sock.destroy(); } catch { /* closed */ } try { proc.kill(); } catch { /* gone */ } if (current === conn) { current = null; channelState("down"); } },
    gate: (tool, args, s) => gateSend(tool, args, s, {
      cards: async () => { const r = await linkCall("/cards"); return r.ok ? await r.json() : null; },
      cardsFile: () => text(CARDS),
      replied: () => replied,
    }),
    sent: (tool, args, result, s) => {
      // The first start's smoke test (c1/smoke.sh): its stand-in sent nothing, so there is
      // nothing for the link to place Stop on or add to his replies.
      if (env.CAIN_BROKER_SMOKE === "1") return;
      const { note, madeUp } = sentNote(tool, args, result, s);
      if (!note) return;
      if (tool === "reply") addReplied(note.ids);
      const now = Date.now();
      if (note.net && !note.net.released) void appendGate({ at: now, point: "sent", writer: "cain", message: note.ids.at(-1), did: "bypassed", hits: note.net.hits });
      if (madeUp.length) void appendGate({ at: now, point: "sent", writer: "cain", message: note.ids.at(-1), did: "bypassed", hits: madeUp });
      void tellLink(note, (body, timeoutMs) => linkCall("/sent", { method: "POST", body, headers: { "content-type": "application/json" } }, timeoutMs));
    },
    readsOk,
    outbox: fileOutbox(OUTBOX, { gid: DISCORD_GID }),
    log,
    session: name,
    setTimer: (ms, f) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  conn.session = session;
  current = conn;
  channelState("connected");
  sock.on("data", lineReader((l) => { void session.fromClient(l); }, () => { void session.fromClient("x".repeat(MAX_LINE + 1)); }));
  sock.on("close", () => session.end());
  sock.on("error", () => { /* close follows */ });
  void (async () => {
    const dec = new TextDecoder();
    const read = lineReader((l) => session.fromServer(l), () => log("the server sent a line too long; dropped"));
    for await (const chunk of proc.stdout) read(dec.decode(chunk, { stream: true }));
  })();
  void (async () => {
    const dec = new TextDecoder();
    const read = lineReader((l) => { if (l.trim()) log(`plugin: ${l.slice(0, 300)}`); }, () => {});
    for await (const chunk of proc.stderr) read(dec.decode(chunk, { stream: true }));
  })();
  void proc.exited.then((code) => { log(`the plugin's server stopped (${code})`); session.serverGone(); });
}

if (import.meta.main) {
  mkdirSync(OUTBOX, { recursive: true, mode: 0o750 });
  try { chownSync(OUTBOX, 0, DISCORD_GID); } catch (e) { log(`couldn't hand the outbox to discord: ${String(e).slice(0, 80)}`); }
  if (existsSync(SOCK)) rmSync(SOCK, { force: true });
  // No state until a first connection: a session waiting on its sign-in is never restarted.
  const server = createServer(connection);
  server.listen(SOCK, () => {
    // Root and cain only. Until this lands nobody but root can connect (umask 027).
    try { chownSync(SOCK, 0, CAIN_GID); chmodSync(SOCK, 0o660); log(`listening on ${SOCK}`); }
    catch (e) { log(`ERROR: couldn't open the socket to cain: ${String(e).slice(0, 80)}`); }
  });
}
