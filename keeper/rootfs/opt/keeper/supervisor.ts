// The Supervisor's API, as the keeper uses it (hassio_role backup: the info endpoints, /jobs/info among
// them, and /backups; and its own info, /addons/self/info, which every App may read). Nothing else: no
// Home Assistant API, no manager role, and (0.1.2) no write of any options, its own included. 0.1.3: it also makes the App-only backup of an
// install it registered (POST /backups/new/partial, within the backup role). The token
// comes from the environment the Supervisor gives the App (SUPERVISOR_TOKEN) and is never logged.
import type { AppInfo, BackupInfo, JobState, RestoreResult } from "./core.ts";

export const BACKUP_CALL_MS = 10 * 60_000;
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
    // The keeper's own options as the Supervisor holds them, read only. /data/options.json is written
    // only when the App starts, so an attempt the Ship run writes through the connector shows here first.
    async selfOptions(): Promise<Record<string, unknown> | null> {
      const r = await call("GET", "/addons/self/info").catch(() => null);
      const o = r?.ok ? r.data?.options : null;
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    },
    async backupInfo(slug: string): Promise<BackupInfo | null> {
      const r = await call("GET", `/backups/${encodeURIComponent(slug)}/info`);
      if (!r.ok || !r.data) return null;
      return { homeassistant: r.data.homeassistant ?? null, addons: Array.isArray(r.data.addons) ? r.data.addons.map((a: any) => ({ slug: String(a?.slug ?? ""), version: String(a?.version ?? "") })) : [],
        folders: Array.isArray(r.data.folders) ? r.data.folders : [], protected: r.data.protected };
    },
    // (0.1.3) The keeper's own backup of one App: partial, that App alone, no Home Assistant, no folders,
    // no password, and background false, so the call answers once the backup is complete, with its slug.
    async makeBackup(app: string, name: string): Promise<{ slug: string } | { why: string }> {
      try {
        const r = await call("POST", "/backups/new/partial", { name, addons: [app], homeassistant: false, folders: [], background: false }, BACKUP_CALL_MS);
        if (r.ok && typeof r.data?.slug === "string" && r.data.slug) return { slug: r.data.slug };
        return { why: `${r.status}${r.message ? ` ${r.message}` : ""}` };
      } catch (e) {
        return { why: String((e as Error)?.name ?? e).slice(0, 80) };
      }
    },
    // The partial restore: that App alone, Home Assistant false, no folders, and the Supervisor's
    // background flag passed explicitly (background: true): the Supervisor answers once the job has
    // started, with its id, which the keeper keeps before anything else. 0.1.3: only a 4xx is a refusal
    // (the Supervisor turned it down before running it: busy with another job, a bad request; a missing
    // backup or a refused permission is never sent again), and even then core.ts sends it again only
    // once the jobs list shows no restore of that backup. A 5xx, no answer, or a 2xx that isn't a result
    // is "unknown": it may have been accepted, so it is never sent again.
    async restore(backup: string, app: string): Promise<RestoreResult> {
      try {
        const r = await call("POST", `/backups/${encodeURIComponent(backup)}/restore/partial`, { homeassistant: false, addons: [app], folders: [], background: true }, 120_000);
        if (r.ok) return { kind: "started", job: typeof r.data?.job_id === "string" && r.data.job_id ? r.data.job_id : null };
        if (r.status >= 400 && r.status < 500) return { kind: "refused", status: r.status, retry: ![401, 403, 404].includes(r.status), why: `${r.status}${r.message ? ` ${r.message}` : ""}` };
        return { kind: "unknown", why: `${r.status}${r.status >= 500 ? " a server error, after which it may have run" : " an answer that isn't a result"}` };
      } catch (e) {
        return { kind: "unknown", why: String((e as Error)?.name ?? e).slice(0, 80) };
      }
    },
    // The restore's job in the Supervisor's jobs list (GET /jobs/info, the backup role's info read), by
    // the id from the restore's answer and nothing else (0.1.2: no job is ever matched by its name or
    // backup). Null when the list can't be read. A finished job leaves the list after a while: not found
    // then says nothing.
    async job(uuid: string): Promise<JobState | null> {
      const r = await call("GET", "/jobs/info").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.jobs)) return null;
      const all: any[] = [];
      const walk = (xs: any[]) => { for (const x of xs) { if (x && typeof x === "object") { all.push(x); if (Array.isArray(x.child_jobs)) walk(x.child_jobs); } } };
      walk(r.data.jobs);
      const hit = uuid ? all.find((x) => x.uuid === uuid) : undefined;
      if (!hit) return { found: false };
      return { found: true, uuid: String(hit.uuid), done: hit.done === true, errors: Array.isArray(hit.errors) ? hit.errors.length : 0 };
    },
    // (0.1.3) The restore jobs the jobs list shows for one backup (a job whose name says restore and whose
    // reference is that backup's slug), child jobs included. Only used to prove a refused restore never
    // ran (none listed); null when the list can't be read.
    async restoreJobs(backup: string): Promise<number | null> {
      const r = await call("GET", "/jobs/info").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.jobs)) return null;
      let n = 0;
      const walk = (xs: any[]) => { for (const x of xs) { if (x && typeof x === "object") {
        if (/restore/i.test(String(x.name ?? "")) && String(x.reference ?? "") === backup) n++;
        if (Array.isArray(x.child_jobs)) walk(x.child_jobs); } } };
      walk(r.data.jobs);
      return n;
    },
  };
}
