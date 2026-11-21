// The Supervisor's API, as the keeper uses it (hassio_role backup: the info endpoints, /jobs/info among
// them, and /backups; and what every App may do to itself: /addons/self/info and /addons/self/options).
// Nothing else: no Home Assistant API, no manager role. The token comes from the environment the
// Supervisor gives the App (SUPERVISOR_TOKEN) and is never logged.
import { RESTORE_JOB, type AppInfo, type BackupInfo, type JobState, type RestoreResult } from "./core.ts";

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
    // The keeper's own options as the Supervisor holds them (0.1.1). /data/options.json is written only
    // when the App starts, so an attempt the Ship run writes through the connector shows here first.
    async selfOptions(): Promise<Record<string, unknown> | null> {
      const r = await call("GET", "/addons/self/info").catch(() => null);
      const o = r?.ok ? r.data?.options : null;
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    },
    // The registration cleared from the keeper's own options (0.1.1): read them, check the attempt there
    // is still that id, and write them back whole with every attempt field empty. Nothing else changes.
    async clearAttempt(id: string): Promise<{ ok: boolean; why: string }> {
      const r = await call("GET", "/addons/self/info");
      const o = r.ok ? r.data?.options : null;
      if (!o || typeof o !== "object") return { ok: false, why: `its options can't be read (${r.status})` };
      if (String(o.attempt?.id ?? "") !== id) return { ok: false, why: "the options hold another registration now" };
      const empty = { id: "", app: "", from_version: "", to_version: "", backup_slug: "", install_deadline: "", authorization: "", probe_hash: "" };
      const w = await call("POST", "/addons/self/options", { options: { ...o, attempt: empty } });
      return w.ok ? { ok: true, why: "" } : { ok: false, why: `the Supervisor answered ${w.status}${w.message ? ` ${w.message}` : ""}` };
    },
    async backupInfo(slug: string): Promise<BackupInfo | null> {
      const r = await call("GET", `/backups/${encodeURIComponent(slug)}/info`);
      if (!r.ok || !r.data) return null;
      return { homeassistant: r.data.homeassistant ?? null, addons: Array.isArray(r.data.addons) ? r.data.addons.map((a: any) => ({ slug: String(a?.slug ?? ""), version: String(a?.version ?? "") })) : [],
        folders: Array.isArray(r.data.folders) ? r.data.folders : [], protected: r.data.protected };
    },
    // The partial restore: that App alone, Home Assistant false, no folders, as a background job
    // (0.1.1): the Supervisor answers once the job has started, with its id, which the keeper keeps
    // before anything else. An error answer means the request ended there (busy with another job, a
    // server error: the caller may send it again; a missing backup or a refused permission: not). No
    // answer at all is "unknown": the caller reconciles from the jobs list and never just sends again.
    async restore(backup: string, app: string): Promise<RestoreResult> {
      try {
        const r = await call("POST", `/backups/${encodeURIComponent(backup)}/restore/partial`, { homeassistant: false, addons: [app], folders: [], background: true }, 120_000);
        if (r.ok) return { kind: "started", job: typeof r.data?.job_id === "string" && r.data.job_id ? r.data.job_id : null };
        if (r.status >= 200 && r.status < 300) return { kind: "unknown", why: `${r.status} an answer that isn't a result` };
        return { kind: "refused", retry: ![401, 403, 404].includes(r.status), why: `${r.status}${r.message ? ` ${r.message}` : ""}` };
      } catch (e) {
        return { kind: "unknown", why: String((e as Error)?.name ?? e).slice(0, 80) };
      }
    },
    // The restore's job in the Supervisor's jobs list (GET /jobs/info, the backup role's info read): by
    // its id, or else the newest partial restore of that backup created since the call. Null when the
    // list can't be read. A finished job leaves the list after a while: not found then says nothing.
    async job(uuid: string | null, backup: string, since: number): Promise<JobState | null> {
      const r = await call("GET", "/jobs/info").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.jobs)) return null;
      const all: any[] = [];
      const walk = (xs: any[]) => { for (const x of xs) { if (x && typeof x === "object") { all.push(x); if (Array.isArray(x.child_jobs)) walk(x.child_jobs); } } };
      walk(r.data.jobs);
      const hit = uuid ? all.find((x) => x.uuid === uuid)
        : all.filter((x) => x.name === RESTORE_JOB && x.reference === backup && Date.parse(String(x.created ?? "")) >= since - 60_000)
          .sort((p, q) => Date.parse(q.created) - Date.parse(p.created))[0];
      if (!hit) return { found: false };
      return { found: true, uuid: String(hit.uuid), done: hit.done === true, errors: Array.isArray(hit.errors) ? hit.errors.length : 0 };
    },
  };
}
