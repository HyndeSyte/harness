// The keeper's own HTTP service, on Home Assistant's internal App network only (172.30.32.0/23):
//   GET  /attempt   the open attempt of the caller's App (its id, from and to), or none
//   POST /attempt   (0.1.3) Cain's App only: register an install, {token, app, pr, head, from_version,
//                   to_version, probe_hash, kind?}, the token being the owner's signed Ship token, verified
//                   here with the pinned, confirmed key (core.ts registerAttempt). 0.1.5: answered 202
//                   {status: "pending", id} at once; the backup is made in the background
//   GET  /attempt/<id>          (0.1.5) Cain's App only: pending, accepted (with its backup), claimed, or refused
//   POST /attempt/<id>/claim    (0.1.5) Cain's App only, as the Ship run starts: {app, from_version, to_version,
//                               backup}; one claimant, valid 30 minutes
//   POST /attempt/<id>/cancel   (0.1.5) Cain's App only: the link gave up on the pass, {why}
//   POST /verdict   {app, version, attempt, result: PASS|FAIL, reason}: the caller's App's probe verdict
//   GET  /armed     ?app=<slug> (default the caller's): the armed state, its binding, the keeper's
//                   version and a timestamp refreshed every minute
//   GET  /last      the last owner line about the caller's App
//   POST /drill-record {attempt}   from this container only (keeper drill-record)
//   POST /phone-test, POST /phone-confirm   (0.1.3) from this container only: the phone test drill
//   POST /key-confirm {fingerprint}   (0.1.4) from this container only: the owner confirms a changed Ship key
// Every request but those from this container carries an App's own token (Authorization: Bearer <token>, the
// keeper's option tokens maps App slug to token). Anything else is refused and logged.
import { SLUG, type Keeper } from "./core.ts";

export const MAX_BODY = 4096;
const LOCAL = new Set(["/drill-record", "/phone-test", "/phone-confirm", "/key-confirm"]);
// Home Assistant's internal network (the Supervisor's hassio network): 172.30.32.0/23.
export function internal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = /^172\.30\.(32|33)\.(\d{1,3})$/.exec(v4);
  return !!m && Number(m[2]) <= 255;
}
export const loopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handle(k: Keeper, req: Request, ip: string, log: (m: string) => void, allow: (ip: string) => boolean = internal): Promise<Response> {
  const url = new URL(req.url);
  if (LOCAL.has(url.pathname) && req.method === "POST") {
    if (!loopback(ip)) { log(`refused ${url.pathname} from ${ip}: only from inside the keeper`); return json({ status: "refused" }, 403); }
    const b = await body(req);
    if (url.pathname === "/phone-test") await k.refreshHc();
    const r = url.pathname === "/drill-record" ? k.drillRecord(String(b?.attempt ?? "")) : url.pathname === "/phone-test" ? k.phoneTest()
      : url.pathname === "/key-confirm" ? k.keyConfirm(String(b?.fingerprint ?? "")) : k.phoneConfirm();
    return json(r, r.ok ? 200 : 409);
  }
  if (!allow(ip)) { log(`refused ${req.method} ${url.pathname} from ${ip}: not the internal App network`); return json({ status: "refused" }, 403); }
  const auth = req.headers.get("authorization") ?? "";
  const caller = k.appOfToken(auth.startsWith("Bearer ") ? auth.slice(7).trim() : null);
  if (!caller) { log(`refused ${req.method} ${url.pathname} from ${ip}: no App's token`); return json({ status: "refused" }, 401); }
  if (req.method === "GET" && url.pathname === "/attempt") {
    const a = k.openAttempt(caller);
    return json(a ? { app: caller, attempt: a.id, from_version: a.from, to_version: a.to, status: a.status } : { app: caller, attempt: null });
  }
  const m = /^\/attempt\/([a-z0-9-]{1,100})(\/claim|\/cancel)?$/.exec(url.pathname);
  if (m && req.method === "GET" && !m[2]) { const r = k.attemptView(caller, m[1]); return json(r.body, r.status); }
  if (m && req.method === "POST" && m[2]) {
    const b = await body(req);
    if (b === undefined || !b || typeof b !== "object") return json({ status: "refused", why: "not JSON" }, 400);
    const r = m[2] === "/claim" ? k.claimAttempt(caller, m[1], b) : k.cancelAttempt(caller, m[1], b);
    return json(r.body, r.status);
  }
  if (req.method === "POST" && url.pathname === "/attempt") {
    const b = await body(req);
    if (b === undefined || !b || typeof b !== "object") { log(`refused a registration from ${caller}: its body isn't JSON`); return json({ status: "refused", why: "not JSON" }, 400); }
    const r = await k.registerAttempt(caller, b);
    return json(r.body, r.status);
  }
  if (req.method === "POST" && url.pathname === "/verdict") {
    const b = await body(req);
    if (b === undefined) { log(`ignored a verdict from ${caller}: its body isn't JSON`); return json({ status: "ignored", why: "not JSON" }, 400); }
    const r = k.verdict(caller, b);
    return json(r.ok ? { status: "accepted" } : { status: "ignored", why: r.why }, r.ok ? 200 : 409);
  }
  if (req.method === "GET" && url.pathname === "/armed") {
    const app = url.searchParams.get("app") || caller;
    if (!SLUG.test(app)) return json({ status: "refused", why: "not an App slug" }, 400);
    return json(k.armedView(app));
  }
  if (req.method === "GET" && url.pathname === "/last") {
    const l = k.st.last[caller];
    return json(l ? { app: caller, id: l.id, kind: l.kind, line: l.line, at: new Date(l.at).toISOString() } : { app: caller, id: null });
  }
  log(`refused ${req.method} ${url.pathname} from ${caller}: no such route`);
  return json({ status: "no such route" }, 404);
}

async function body(req: Request): Promise<any> {
  try {
    const t = await req.text();
    if (t.length > MAX_BODY) return undefined;
    return JSON.parse(t);
  } catch { return undefined; }
}
