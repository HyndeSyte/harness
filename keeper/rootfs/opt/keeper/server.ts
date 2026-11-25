// The keeper's own HTTP service, on Home Assistant's internal App network only (172.30.32.0/23):
//   GET  /attempt   the open attempt of the caller's App (its id, from and to), or none
//   POST /attempt   (0.1.3) Cain's App only: register an install, {token, app, pr, head, from_version,
//                   to_version, probe_hash, kind?}, the token being the owner's signed Ship token, verified
//                   here with the pinned, confirmed key (core.ts registerAttempt). 0.1.5: answered 202
//                   {status: "pending", id} at once; the backup is made in the background
//   GET  /attempt/<id>          (0.1.5) Cain's App only: pending, accepted (with its backup), claimed, or refused; read only, and
//                               (0.1.15) with the install job bound to it (install_job, install_job_at) and, for a drill, its
//                               mode and whether its mark was confirmed
//   POST /attempt/<id>/claim    (0.1.5) Cain's App only, as the Ship run starts: {app, from_version, to_version,
//                               backup, request?}; one claimant, valid 30 minutes (0.1.7: a retry with the same
//                               request reads the recorded claim)
//   POST /attempt/<id>/cancel   (0.1.5) Cain's App only: the link gave up on the pass, {why} (0.1.7: a retry reads
//                               the recorded outcome; refused once the claim was handed to a started run; 0.1.8:
//                               refused while the jobs list shows an install or an unrecognized job, or can't be read)
//   POST /attempt/<id>/drill-mark  (0.1.14) Cain's link only: {mode, to_version, mark}, the link wrote the signed drill mark
//                               for this accepted drill (mark: its SHA-256); a drill record needs it
//   POST /verdict   {app, version, attempt, result: PASS|FAIL, reason}: the caller's App's probe verdict
//   GET  /armed     ?app=<slug> (default the caller's): the armed state, its binding, the keeper's
//                   version and a timestamp refreshed every minute (0.1.8: under the claim record's lock)
//   GET  /last      the last owner line about the caller's App
//   GET  /rotation  (0.1.9) Cain's App only: whether the old Healthchecks key's rotation needs the owner's tap, and its id
//   POST /rotation/attest  (0.1.9) Cain's link only: {attestation}, the owner's tap signed by the link's Ship key
// Every request carries an App's own token (Authorization: Bearer <token>, the keeper's option tokens maps App
// slug to token). Anything else is refused and logged.
//
// (0.1.6) The owner's commands are served only by handleLocal, on a second listener bound to the keeper
// container's own loopback (127.0.0.1:8096, main.ts), never on the App network's listener, which refuses
// them whoever asks:
//   POST /drill-record {attempt}            keeper drill-record
//   POST /phone-test                        (0.1.3) the phone test drill; prints a one-time code in the log
//   POST /phone-confirm {code, checks}      (0.1.6) with that code, each check whose page reached the phone
//   POST /key-confirm {fingerprint, code}   (0.1.4; 0.1.6 with the code printed at the pin)
//   POST /missed-heartbeat                  (0.1.6) the missed-heartbeat drill; prints its code
//   POST /missed-heartbeat-confirm {code}   (0.1.6) the owner saw its page on the phone
//   POST /accept-limits {code}              (0.1.7) the owner accepts DOCS.md's "Accepted limits" (its text version)
//   POST /hc-key {code, key}                (0.1.7) the Healthchecks read-only key, checked, then kept (0600, data folder)
//   POST /key-code                          (0.1.8) a fresh key-confirm code in the log, the only way one is printed (0.1.9)
//   POST /backup-check                      (0.1.9) the backup check on the device: a test backup of Keeper, scanned
// The confirm commands' real gate is the container's network mode (host_network: false, config.yaml): only a
// process inside Keeper's own container reaches its loopback. The codes in the log aren't secret from anyone
// who can read Keeper's log; they show the confirmer read the log for that very challenge.
import { SLUG, type Keeper } from "./core.ts";

export const MAX_BODY = 4096;
export const LOCAL = new Set(["/drill-record", "/phone-test", "/phone-confirm", "/key-confirm", "/missed-heartbeat", "/missed-heartbeat-confirm", "/accept-limits", "/hc-key", "/key-code", "/backup-check", "/drill-state"]);
// Home Assistant's internal network (the Supervisor's hassio network): 172.30.32.0/23.
export function internal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = /^172\.30\.(32|33)\.(\d{1,3})$/.exec(v4);
  return !!m && Number(m[2]) <= 255;
}
export const loopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// (0.1.6) The loopback listener's handler: only the owner's commands, only from 127.0.0.1 or ::1.
export async function handleLocal(k: Keeper, req: Request, ip: string, log: (m: string) => void): Promise<Response> {
  const url = new URL(req.url);
  if (!loopback(ip)) { log(`refused ${url.pathname} from ${ip} on the loopback listener`); return json({ status: "refused" }, 403); }
  if (!LOCAL.has(url.pathname) || req.method !== "POST") return json({ status: "no such route" }, 404);
  const b = await body(req);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (url.pathname === "/phone-test" || url.pathname === "/missed-heartbeat") await k.refreshHc();
  const r = url.pathname === "/hc-key" ? await k.hcKeyEnter(str(b?.code), str(b?.key))
    : url.pathname === "/accept-limits" ? k.acceptLimits(str(b?.code))
    : url.pathname === "/key-code" ? k.keyCode()
    : url.pathname === "/backup-check" ? await k.backupCheck()
    : url.pathname === "/drill-state" ? k.drillState()                      // (0.1.13) read only
    : url.pathname === "/drill-record" ? k.drillRecord(str(b?.attempt)) : url.pathname === "/phone-test" ? k.phoneTest()
    : url.pathname === "/key-confirm" ? k.keyConfirm(str(b?.fingerprint), str(b?.code))
    : url.pathname === "/missed-heartbeat" ? k.missedHeartbeat()
    : url.pathname === "/missed-heartbeat-confirm" ? k.missedHeartbeatConfirm(str(b?.code))
    : k.phoneConfirm(str(b?.code), Array.isArray(b?.checks) ? b.checks.map(str) : []);
  return json(r, r.ok ? 200 : 409);
}

export async function handle(k: Keeper, req: Request, ip: string, log: (m: string) => void, allow: (ip: string) => boolean = internal): Promise<Response> {
  const url = new URL(req.url);
  // (0.1.6) never on the App network's listener, from any address: only the loopback listener serves them
  if (LOCAL.has(url.pathname)) { log(`refused ${url.pathname} from ${ip}: the owner's commands are served only on the keeper's own loopback`); return json({ status: "refused" }, 403); }
  if (!allow(ip)) { log(`refused ${req.method} ${url.pathname} from ${ip}: not the internal App network`); return json({ status: "refused" }, 403); }
  const auth = req.headers.get("authorization") ?? "";
  const caller = k.appOfToken(auth.startsWith("Bearer ") ? auth.slice(7).trim() : null);
  if (!caller) { log(`refused ${req.method} ${url.pathname} from ${ip}: no App's token`); return json({ status: "refused" }, 401); }
  if (req.method === "GET" && url.pathname === "/attempt") {
    const a = k.openAttempt(caller);
    // (0.1.14) its kind. 0.1.15 item 14: no drill fields here any more: the run script's helper and the verdict probe read a drill
    // only by the attempt id the signed mark names (GET /attempt/<id>, read only, that attempt alone)
    return json(a ? { app: caller, attempt: a.id, from_version: a.from, to_version: a.to, status: a.status, kind: a.auth } : { app: caller, attempt: null });
  }
  const m = /^\/attempt\/([a-z0-9-]{1,100})(\/claim|\/cancel|\/drill-mark)?$/.exec(url.pathname);
  if (m && req.method === "GET" && !m[2]) { const r = k.attemptView(caller, m[1]); return json(r.body, r.status); }
  if (m && req.method === "POST" && m[2]) {
    const b = await body(req);
    if (b === undefined || !b || typeof b !== "object") return json({ status: "refused", why: "not JSON" }, 400);
    const r = m[2] === "/drill-mark" ? k.markAttempt(caller, m[1], b)                                     // (0.1.14)
      : m[2] === "/claim" ? await k.claim(caller, m[1], b) : await k.cancel(caller, m[1], b);   // (0.1.7) under the claim record's lock
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
    return json(await k.armed(app));   // (0.1.8) under the claim record's lock, its counter saved first
  }
  if (req.method === "GET" && url.pathname === "/rotation") { const r = k.rotationView(caller); return json(r.body, r.status); }
  if (req.method === "POST" && url.pathname === "/rotation/attest") {
    const b = await body(req);
    if (b === undefined || !b || typeof b !== "object") return json({ status: "refused", why: "not JSON" }, 400);
    const r = await k.attestRotation(caller, b);
    return json(r.body, r.status);
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
