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
// One request id is one operation (SignedOps, below): the link records it before acting
// (received) and after (done, with its answer), durably, for KEEP_MS, longer than the
// specialist ever retries one. A repeat of a done id gets the stored answer and nothing is done
// again; a copy that arrives while the first runs waits for it; one received but never done (the
// link stopped mid-way) is reconciled, never simply repeated. So a request someone holds and
// forwards late runs at most once, and an answer the specialist can't verify is no answer.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not every platform syncs a folder */ }
}
export const SIG_WINDOW_MS = 60_000;
// Longer than the specialist retries an operation: Harness 0.24.0 gives up on an outbox row after
// 7 days (outbox.py MAX_AGE_S), so one operation is never mistaken for a new one (C1-8).
export const KEEP_MS = 8 * 24 * 3_600_000;

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

const validStored = (s: any): s is Stored => s && typeof s === "object" && Number.isFinite(s.at)
  && (s.state === "received" || (s.state === "done" && Number.isInteger(s.status) && typeof s.body === "string"));

// What the link did with each signed request, by id, kept on disk for KEEP_MS (longer than the
// specialist retries an operation), each change synced; the copy before the last change is kept
// beside it. Only a log that doesn't exist yet is empty: one that can't be read or doesn't hold
// valid entries, with no valid copy beside it, is "damaged", and the link then takes no signed
// operation that does anything until KEEP_MS has passed since (C1 code review, C1-5).
export class RequestLog {
  private map = new Map<string, Stored>();
  damagedSince = 0;
  constructor(private path: string | null, now = Date.now()) {
    if (!path) return;
    const load = (p: string): Map<string, Stored> | "absent" | "bad" => {
      let text: string;
      try { text = readFileSync(p, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? "absent" : "bad"; }
      try {
        const o = JSON.parse(text);
        if (!o || typeof o !== "object" || Array.isArray(o)) return "bad";
        const m = new Map<string, Stored>();
        for (const [id, s] of Object.entries(o)) { if (!/^[0-9a-f]{32}$/.test(id) || !validStored(s)) return "bad"; m.set(id, s); }
        return m;
      } catch { return "bad"; }
    };
    const main = load(path);
    if (main instanceof Map) { this.map = main; return; }
    const prev = load(`${path}.prev`);
    if (prev instanceof Map) { this.map = prev; return; }
    if (main === "absent" && prev === "absent") return;
    // Damaged: remembered as such (a marker beside it), so a restart doesn't forget it either.
    const marker = `${path}.damaged`;
    let since = now;
    try { const t = Number(readFileSync(marker, "utf8")); if (Number.isFinite(t) && t > 0) since = t; } catch { /* first time */ }
    this.damagedSince = since;
    try { writeSynced(marker, String(since)); } catch { /* still damaged in memory */ }
  }
  // Damaged and not yet past KEEP_MS: every entry the lost log held may still matter.
  damaged(now = Date.now()): boolean {
    if (!this.damagedSince) return false;
    if (now - this.damagedSince <= KEEP_MS) return true;
    this.damagedSince = 0;
    try { rmSync(`${this.path}.damaged`, { force: true }); } catch { /* gone */ }
    return false;
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
    try { copyFileSync(this.path, `${this.path}.prev`); } catch { /* the first one */ }
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(Object.fromEntries(this.map))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    try { const dir = openSync(dirname(this.path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* not every platform syncs a folder */ }
  }
}

export interface Answer { status: number; body: string }

// Each signed operation once (C1 code review, C1-1 and C1-2): a repeat of a done one gets its
// stored answer; a copy that arrives while the first is still running waits for the first's
// answer rather than running again; one received but never done (the link stopped mid-way) is
// reconciled by its route: an answer to a tap can't be checked against Discord, so it gets an
// explicit unknown outcome (never a success, never sent twice); the others run again, each
// idempotent or deduplicated by the request id they carry (a card by the id stored on it).
export class SignedOps {
  private inflight = new Map<string, Promise<Answer>>();
  constructor(private log: RequestLog, private now = () => Date.now()) {}
  async run(id: string, path: string, act: () => Promise<Answer>): Promise<Answer> {
    const done = this.log.get(id, this.now());
    if (done?.state === "done") return { status: done.status ?? 200, body: done.body ?? "{}" };
    const joined = this.inflight.get(id);
    if (joined) return joined;
    if (this.log.damaged(this.now()))
      return { status: 503, body: JSON.stringify({ status: "history damaged", said: "the link's record of what it has done is damaged, so it takes no new operation for now" }) };
    const p = (async (): Promise<Answer> => {
      if (done?.state === "received" && path === "/answer") {
        const a = { status: 409, body: JSON.stringify({ status: "unknown", said: "the link stopped before it confirmed this note went out; it isn't sent again" }) };
        this.log.put(id, { at: this.now(), state: "done", status: a.status, body: a.body });
        return a;
      }
      this.log.put(id, { at: this.now(), state: "received" });
      const a = await act();
      this.log.put(id, { at: this.now(), state: "done", status: a.status, body: a.body });
      return a;
    })();
    this.inflight.set(id, p);
    try { return await p; } finally { this.inflight.delete(id); }
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

// A request's body, read only up to max bytes (C1 code review, C1-7): a declared length over it is refused unread, and
// a body that runs past it (chunked, or a length that lied) is cut off and refused. null: too
// large. The link's servers also set Bun's maxRequestBodySize to the same.
export async function boundedText(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
