// Runs Cain's link (core.ts): the Discord gateway for taps and reactions, the
// REST calls, and a small local HTTP API.
//
// HTTP on port 8097, keyed with HMAC-SHA256(bot token, "harness-relay-v1"):
//   from the calendar specialist (the Harness add-on, over the add-ons' network):
//     POST /card {text, rows, kind}     hold a card for Cain to show (direct kinds go out now)
//     POST /buttons {card, rows}        change a card's buttons (after a tap)
//     POST /answer {callback, text}     a short note only Dane sees, after a tap
//     POST /relay {text}                a line for Cain
//     GET  /card-of?m=<message id>      which card a Discord message is
//     GET  /health
//   from Cain's own scripts, on this machine only (127.0.0.1):
//     POST /show {id}  POST /ask {text, options}  POST /morning {text, options}
// Nothing is published to the LAN: the add-on has no "ports:".
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { emptyState, Link, Protocol, State } from "./core";

const ENV = process.env.LINK_ENV ?? "/data/.claude/channels/discord/.env";
const ACCESS = "/data/.claude/channels/discord/access.json";
const DIR = process.env.LINK_DIR ?? "/data/link";
const STATE = `${DIR}/state.json`;
const QUEUE = process.env.RELAY_QUEUE ?? "/data/relay.queue";
const PORT = Number(process.env.RELAY_PORT ?? 8097);
const HARNESS = "http://0fcc2575-harness:8098";
const API = "https://discord.com/api/v10";

mkdirSync(DIR, { recursive: true, mode: 0o700 });

function token(): string {
  try { return readFileSync(ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? ""; } catch { return ""; }
}
function key(context: string): string {
  const t = token();
  return t ? createHmac("sha256", t).update(context).digest("hex") : "";
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function paired(): string {
  try { return String(JSON.parse(readFileSync(ACCESS, "utf8")).allowFrom?.[0] ?? ""); } catch { return ""; }
}
function load(): State {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return emptyState(); }
}
function save(s: State): void {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(s), { mode: 0o600 });
  renameSync(`${STATE}.tmp`, STATE);
}

async function rest(method: string, path: string, body?: unknown, auth = true): Promise<any> {
  const headers: Record<string, string> = { "user-agent": "DiscordBot (https://github.com/HyndeSyte/harness, 1)" };
  if (auth) headers.authorization = `Bot ${token()}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(path.startsWith("/interactions/") ? 3000 : 20000) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`discord ${r.status}: ${String(data?.message ?? "").slice(0, 100)}`);
  return data;
}

async function toHarness(path: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${HARNESS}${path}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-harness-key": key("harness-handover-v1") },
      signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch { return false; }
}

const link = new Link({
  rest, load, save, now: Date.now, paired, toHarness,
  relay: (text) => appendFileSync(QUEUE, JSON.stringify({ text: text.replace(/[\r\n\t]+/g, " ").slice(0, 600) }) + "\n"),
});

// -- HTTP -------------------------------------------------------------------------
const LOCAL_ONLY = new Set(["/show", "/ask", "/morning"]);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  port: PORT, hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!same(req.headers.get("x-harness-key") ?? "", key("harness-relay-v1"))) return json({ status: "refused" }, 403);
    const ip = server.requestIP(req)?.address ?? "";
    if (LOCAL_ONLY.has(url.pathname) && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1")
      return json({ status: "refused" }, 403);
    if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
    if (req.method === "GET" && url.pathname === "/card-of") return json({ card: link.cardOf(url.searchParams.get("m") ?? "") });
    if (req.method !== "POST") return json({ status: "not found" }, 404);
    const raw = await req.text();
    if (raw.length > 16384) return json({ status: "too large" }, 413);
    let b: any = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { return json({ status: "not JSON" }, 400); }
    try {
      switch (url.pathname) {
        case "/card": return json({ id: await link.addCard({ text: String(b.text ?? ""), rows: b.rows ?? [], kind: b.kind }) });
        case "/buttons": await link.editButtons(Number(b.card), b.rows ?? []); return json({ status: "ok" });
        case "/answer": await link.followup(String(b.callback ?? ""), String(b.text ?? "")); return json({ status: "ok" });
        case "/relay": { const t = String(b.text ?? "").trim(); if (t) link.relayLine(t); return json({ status: "ok" }); }
        case "/show": return json({ status: "posted", message: await link.show(Number(b.id)) });
        case "/ask": return json({ status: "posted", message: await link.ask(String(b.text ?? ""), (b.options ?? []).map(String)) });
        case "/morning": {
          const m = await link.ask(String(b.text ?? ""), (b.options ?? []).map(String), true);
          await toHarness("/morning-posted", {});
          return json({ status: "posted", message: m });
        }
      }
    } catch (e) {
      return json({ status: "error", said: String(e).slice(0, 200) }, 500);
    }
    return json({ status: "not found" }, 404);
  },
});
console.log(`[cain] link listening on ${PORT}`);

// -- the gateway: taps and reactions ---------------------------------------------------
let ws: WebSocket | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let failures = 0;
let fatal = "";
let fatalToken = "";
let lastToken = token();

const proto = new Protocol((o) => ws?.send(JSON.stringify(o)), token, {
  ready: () => { failures = 0; console.log("[cain] link: connection ready"); },
  interaction: (d) => { link.onInteraction(d).catch((e) => console.log(`[cain] link: tap failed: ${String(e).slice(0, 80)}`)); },
  reaction: (d) => { link.onReaction(d).catch(() => {}); },
});

function connect(): void {
  const t = token();
  if (t !== lastToken) { lastToken = t; link.forget(); proto.session = null; proto.seq = null; }
  if (!t) { setTimeout(connect, 30000); return; }
  if (fatal && fatalToken === t) { setTimeout(connect, 60000); return; }
  fatal = "";
  const base = proto.session && proto.resumeUrl ? proto.resumeUrl : "wss://gateway.discord.gg";
  const host = new URL(base).hostname;
  if (host !== "gateway.discord.gg" && !host.endsWith(".discord.gg")) { proto.session = null; setTimeout(connect, 5000); return; }
  ws = new WebSocket(`wss://${host}/?v=10&encoding=json`);
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (proto.handle(m) === "reconnect") { ws?.close(4000); return; }
    if (m.op === 10) {
      if (beat) clearInterval(beat);
      setTimeout(() => proto.beat(), Math.random() * proto.interval);
      beat = setInterval(() => { if (proto.dead()) ws?.close(4000); else proto.beat(); }, proto.interval);
    }
  };
  ws.onclose = (ev) => {
    if (beat) clearInterval(beat);
    proto.interval = 0;
    const what = proto.closed(ev.code);
    if (what === "fatal") { fatal = String(ev.code); fatalToken = t; console.log(`[cain] link: Discord closed the connection: ${ev.code}`); }
    failures++;
    setTimeout(connect, Math.min(60000, 1000 * 2 ** Math.min(failures, 6)) * (0.8 + Math.random() * 0.4));
  };
  ws.onerror = () => {};
}
connect();
