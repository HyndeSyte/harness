// Hears his taps and reactions, passed on by the calendar specialist (the Harness
// add-on), whose Discord connection is the one that hears them. Each is queued in
// /data/relay.queue; checkin.sh types it into Cain's session once Cain is idle.
// Local only (the add-ons' own network), keyed with HMAC-SHA256(bot token,
// "harness-relay-v1"), so nothing else can speak for him.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const ENV = "/data/.claude/channels/discord/.env";
const QUEUE = process.env.RELAY_QUEUE ?? "/data/relay.queue";
const PORT = Number(process.env.RELAY_PORT ?? 8097);

function key(): string {
  let m: RegExpMatchArray | null = null;
  try { m = readFileSync(process.env.RELAY_ENV ?? ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m); } catch {}
  if (!m) return "";
  return createHmac("sha256", m[1].trim()).update("harness-relay-v1").digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/relay") return new Response("not found", { status: 404 });
    if (!same(req.headers.get("x-harness-key") ?? "", key())) return new Response("refused", { status: 403 });
    const raw = await req.text();
    if (raw.length > 4096) return new Response("too large", { status: 413 });
    let text = "";
    try { text = String(JSON.parse(raw).text ?? ""); } catch { return new Response("not JSON", { status: 400 }); }
    text = text.replace(/[\r\n\t]+/g, " ").slice(0, 600).trim();
    if (!text) return new Response("empty", { status: 400 });
    appendFileSync(QUEUE, JSON.stringify({ text }) + "\n");
    return new Response("ok");
  },
});
console.log(`[cain] relay listening on ${PORT}`);
