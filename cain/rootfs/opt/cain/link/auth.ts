// Who may call the link (C1). Three kinds of caller, and each opens only its own routes:
//   - the calendar specialist (the Harness App, over the Apps' network): HMAC(bot token,
//     "harness-relay-v1"), which only the two Apps' root sides can compute;
//   - Cain (his scripts, on this machine): a key of his own, made at each start into
//     /run/cain/keys/cain.key, that opens nothing of the specialist's;
//   - root's own services (the broker): the link's unix socket, which only root can open.
// The specialist signs each request rather than sending its key: a port Cain holds while the
// link restarts would otherwise learn the key and could post cards as the specialist. A
// signature covers the method, the path with its query, the time and the body; it counts
// within a minute of now, once.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIG_HEADER = "x-harness-sig";
export const SIG_WINDOW_MS = 60_000;

export const SPECIALIST_ROUTES = new Set(["/card", "/buttons", "/answer", "/relay", "/card-of"]);
export const CAIN_ROUTES = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied", "/stopped",
  "/look", "/cards", "/check", "/replay", "/connector"]);
// Root's services, on the unix socket only: what Cain sent (his edit allowlist) and the cards.
export const ROOT_ROUTES = new Set(["/sent", "/cards", "/check"]);

export function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const mac = (key: string, method: string, target: string, t: number, body: string) =>
  createHmac("sha256", key).update(`${method.toUpperCase()}\n${target}\n${t}\n${body}`).digest("hex");

// The header a caller sends: t=<ms since 1970>,s=<hex>.
export function signRequest(key: string, method: string, target: string, body: string, t = Date.now()): string {
  return `t=${t},s=${mac(key, method, target, t, body)}`;
}

export class Signatures {
  private seen = new Map<string, number>();
  constructor(private windowMs = SIG_WINDOW_MS) {}

  // True once for a good signature within the window; a repeat, a stale or a future one, false.
  check(header: string | null, key: string, method: string, target: string, body: string, now = Date.now()): boolean {
    if (!header || !key) return false;
    const m = /^t=(\d{10,16}),s=([0-9a-f]{64})$/.exec(header.trim());
    if (!m) return false;
    const t = Number(m[1]);
    if (!Number.isSafeInteger(t) || Math.abs(now - t) > this.windowMs) return false;
    if (!sameKey(m[2], mac(key, method, target, t, body))) return false;
    for (const [s, at] of this.seen) if (now - at > 2 * this.windowMs) this.seen.delete(s);
    if (this.seen.has(m[2])) return false;
    this.seen.set(m[2], now);
    return true;
  }
}

export type Caller = "specialist" | "cain" | "root" | "none";

// Whether this caller may use this route. GET /health answers anyone (with details only for
// a known caller), so it isn't here.
export function routeAllowed(caller: Caller, path: string): boolean {
  if (caller === "specialist") return SPECIALIST_ROUTES.has(path);
  if (caller === "cain") return CAIN_ROUTES.has(path);
  if (caller === "root") return ROOT_ROUTES.has(path);
  return false;
}
