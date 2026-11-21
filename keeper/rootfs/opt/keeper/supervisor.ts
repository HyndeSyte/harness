// The Supervisor's API, as the keeper uses it (hassio_role backup: the info endpoints and /backups).
// Nothing else: no Home Assistant API, no manager role. The token comes from the environment the
// Supervisor gives the App (SUPERVISOR_TOKEN) and is never logged.
import type { AppInfo, BackupInfo, RestoreResult } from "./core.ts";

export interface Http { (url: string, init: RequestInit): Promise<Response> }

export function supervisor(token: string, base = "http://supervisor", http: Http = fetch) {
  const call = async (method: string, path: string, body?: unknown, ms = 15_000) => {
    const r = await http(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
    let j: any = null;
    try { j = await r.json(); } catch { /* no body */ }
    return { status: r.status, ok: r.ok && j?.result === "ok", data: j?.data, message: typeof j?.message === "string" ? j.message.slice(0, 160) : "" };
  };
  return {
    async appInfo(slug: string): Promise<AppInfo | null> {
      const r = await call("GET", `/addons/${encodeURIComponent(slug)}/info`);
      if (!r.ok || typeof r.data?.version !== "string") return null;
      return { version: r.data.version, state: typeof r.data.state === "string" ? r.data.state : "unknown" };
    },
    async selfInfo(): Promise<{ slug: string; version: string } | null> {
      const r = await call("GET", "/addons/self/info");
      return r.ok && typeof r.data?.slug === "string" ? { slug: r.data.slug, version: String(r.data.version ?? "") } : null;
    },
    async backupInfo(slug: string): Promise<BackupInfo | null> {
      const r = await call("GET", `/backups/${encodeURIComponent(slug)}/info`);
      if (!r.ok || !r.data) return null;
      return { homeassistant: r.data.homeassistant ?? null, addons: Array.isArray(r.data.addons) ? r.data.addons.map((a: any) => ({ slug: String(a?.slug ?? ""), version: String(a?.version ?? "") })) : [],
        folders: Array.isArray(r.data.folders) ? r.data.folders : [] };
    },
    // The partial restore: that App alone, Home Assistant false, no folders. A refusal the Supervisor
    // may lift (busy with another job, a server error) is retried by the caller; a missing backup or a
    // refused permission isn't.
    async restore(backup: string, app: string): Promise<RestoreResult> {
      try {
        const r = await call("POST", `/backups/${encodeURIComponent(backup)}/restore/partial`, { homeassistant: false, addons: [app], folders: [] }, 600_000);
        if (r.ok) return { ok: true };
        const retry = ![401, 403, 404].includes(r.status);
        return { ok: false, retry, why: `${r.status}${r.message ? ` ${r.message}` : ""}` };
      } catch (e) {
        return { ok: false, retry: true, why: String((e as Error)?.name ?? e).slice(0, 80) };
      }
    },
  };
}
