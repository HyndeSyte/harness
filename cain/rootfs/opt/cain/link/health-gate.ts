// Cain's readiness tied to the link's Discord gateway (Cain 0.18.0; since 0.18.1 on /ready, beside the
// liveness /health). nginx answers /ready (port 8098, the keeper App's check; /health stays the
// Supervisor's watchdog URL, liveness only) 200 only while the mark below stands; the
// link writes it every 30 seconds only while its Discord gateway is connected and Discord acknowledged a
// heartbeat within the last 5 minutes, and removes it otherwise. A mark the link stopped refreshing
// (the link down) is removed by the run script's minute loop once it is 2 minutes old.
import { chownSync, rmSync, writeFileSync } from "node:fs";

export const GATEWAY_MARK = "/run/cain-web/www/health-gateway";
export const ACK_WITHIN_MS = 5 * 60_000;
export const NOGROUP_GID = 65534;                        // nginx's workers run as nobody:nogroup

export function gatewayHealthy(connected: boolean, lastAckMs: number, now: number): boolean {
  return connected && lastAckMs > 0 && now - lastAckMs <= ACK_WITHIN_MS && lastAckMs - now <= 60_000;
}
export function writeGatewayMark(ok: boolean, path = GATEWAY_MARK, chown: (p: string) => void = (p) => chownSync(p, 0, NOGROUP_GID)): void {
  try {
    if (!ok) { rmSync(path, { force: true }); return; }
    writeFileSync(path, `${Math.floor(Date.now() / 1000)}\n`, { mode: 0o640 });
    try { chown(path); } catch { /* a test's own folder */ }
  } catch { /* nginx then answers 503: the safe side */ }
}
