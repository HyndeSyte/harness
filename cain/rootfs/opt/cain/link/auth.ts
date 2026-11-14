// Who may call the link (C1). Three kinds of caller, and each opens only its own routes:
//   - the calendar specialist (the Harness App, over the Apps' network): it signs with
//     K_sign = HMAC(bot token, "harness-link-sign-v2"), which only the two Apps' root sides can
//     compute. The old relay key, HMAC(bot token, "harness-relay-v1"), which Harness 0.23.0 sent
//     as a header, authorizes nothing of the specialist's and signs nothing (C1 plan 3.9);
//   - Cain (his scripts, on this machine): a key of his own, made at each start into
//     /run/cain/keys/cain.key, that opens nothing of the specialist's;
//   - root's own services (the broker): the link's unix socket, which only root can open.
// The specialist and the link sign both ways rather than sending the key, since the link's
// TCP port could be held by Cain while the link restarts:
//   request:  x-harness-sig: id=<request id>,t=<ms>,s=HMAC(key, "request", method, path and
//             query, id, t, body), counted within a minute of now;
//   response: x-harness-sig: s=HMAC(key, "response", id, status, body).
// One request id is one operation: the link records it before acting (received) and after
// (done, with its answer), durably, for 48 hours. A repeat of a done id gets the stored answer
// and nothing is done again; one received but never done (the link stopped mid-way) is
// reconciled, never simply repeated (main.ts). So a request someone holds and forwards late
// runs at most once, and an answer the specialist can't verify is no answer.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const SIG_HEADER = "x-harness-sig";
export const SIG_CONTEXT = "harness-link-sign-v2";

// A small file written whole and durably: a temp file, fsync, rename, fsync of the folder.
export function writeSynced(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const d = openSync(dirname(path), "r");
  try { fsyncSync(d); } finally { closeSync(d); }
}
export const SIG_WINDOW_MS = 60_000;
export const KEEP_MS = 48 * 3_600_000;           // longer than the specialist retries an operation

export const SPECIALIST_ROUTES = new Set(["/card", "/buttons", "/answer", "/relay", "/card-of"]);
export const CAIN_ROUTES = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied", "/stopped",
  "/look", "/cards", "/check", "/replay", "/connector"]);
// Root's services, on the unix socket only: what Cain sent (his edit allowlist) and the cards.
export const ROOT_ROUTES = new Set(["/sent", "/cards", "/check"]);

export function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const mac = (key: string, parts: (string | number)[]) => createHmac("sha256", key).update(parts.join("\n")).digest("hex");

// A request's id from what it asks: the same operation, retried, keeps its id.
export const requestId = (method: string, target: string, body: string) =>
  createHash("sha256").update(`${method.toUpperCase()}\n${target}\n${body}`).digest("hex").slice(0, 32);

export function signRequest(key: string, method: string, target: string, body: string, t = Date.now(), id = requestId(method, target, body)): string {
  return `id=${id},t=${t},s=${mac(key, ["request", method.toUpperCase(), target, id, t, body])}`;
}
export function signResponse(key: string, id: string, status: number, body: string): string {
  return `s=${mac(key, ["response", id, status, body])}`;
}

// The request's id when its signature is good and within the window; otherwise null.
export function checkRequest(header: string | null, key: string, method: string, target: string, body: string, now = Date.now()): string | null {
  if (!header || !key) return null;
  const m = /^id=([0-9a-f]{32}),t=(\d{10,16}),s=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return null;
  const t = Number(m[2]);
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > SIG_WINDOW_MS) return null;
  return sameKey(m[3], mac(key, ["request", method.toUpperCase(), target, m[1], t, body])) ? m[1] : null;
}

export interface Stored { at: number; state: "received" | "done"; status?: number; body?: string }

// What the link did with each signed request, by id, kept 48 hours on disk, each change synced.
export class RequestLog {
  private map = new Map<string, Stored>();
  constructor(private path: string | null) {
    if (!path) return;
    try { for (const [id, s] of Object.entries(JSON.parse(readFileSync(path, "utf8")))) this.map.set(id, s as Stored); } catch { /* none yet */ }
  }
  get(id: string, now = Date.now()): Stored | null {
    const s = this.map.get(id);
    return s && now - s.at <= KEEP_MS ? s : null;
  }
  put(id: string, s: Stored): void {
    for (const [k, v] of this.map) if (s.at - v.at > KEEP_MS) this.map.delete(k);
    this.map.set(id, s);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(Object.fromEntries(this.map))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    try { const dir = openSync(dirname(this.path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* not every platform syncs a folder */ }
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
