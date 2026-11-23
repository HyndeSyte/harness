// The Supervisor's API, as the keeper uses it (hassio_role backup: the info endpoints, /jobs/info among
// them, and /backups; and its own info, /addons/self/info, which every App may read). Nothing else: no
// Home Assistant API, no manager role, and (0.1.2) no write of any options, its own included. 0.1.3: it also makes the App-only backup of an
// install it registered (POST /backups/new/partial, within the backup role). The token
// comes from the environment the Supervisor gives the App (SUPERVISOR_TOKEN) and is never logged.
import { type AppInfo, type BackupInfo, type JobState, REGISTER_WAIT_MS, type RestoreResult } from "./core.ts";

// (0.1.4) The backup call waits as long as the registration's answer does.
export const BACKUP_CALL_MS = REGISTER_WAIT_MS;
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
      // 0.1.10: the size as reported, zero included (sizeMb), and in bytes where the Supervisor gives it (size_bytes)
      return { ...(Number(r.data.size) > 0 ? { size: Number(r.data.size) } : {}), ...(Number.isFinite(Number(r.data.size)) && r.data.size !== null ? { sizeMb: Number(r.data.size) } : {}),
        ...(Number.isSafeInteger(r.data.size_bytes) ? { sizeBytes: r.data.size_bytes } : {}), homeassistant: r.data.homeassistant ?? null, addons: Array.isArray(r.data.addons) ? r.data.addons.map((a: any) => ({ slug: String(a?.slug ?? ""), version: String(a?.version ?? "") })) : [],
        folders: Array.isArray(r.data.folders) ? r.data.folders : [], protected: r.data.protected, ...(typeof r.data.date === "string" ? { date: r.data.date } : {}) };
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
    // started, with its id, which the keeper keeps before anything else. A 4xx is reported as a refusal,
    // a 5xx, no answer, or a 2xx that isn't a result as "unknown"; 0.1.5: core.ts sends neither again,
    // ever (nothing proves a refused call had no effect).
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
    // (0.1.9) The free space where backups go: /host/info's disk_free (GB), an info read; null when it can't be read.
    async diskFree(): Promise<number | null> {
      const r = await call("GET", "/host/info").catch(() => null);
      const gb = Number(r?.ok ? r.data?.disk_free : NaN);
      return Number.isFinite(gb) && gb >= 0 ? Math.floor(gb * 1024 ** 3) : null;
    },
    // (0.1.9) A backup's archive (GET /backups/<slug>/download, the backup role): the backup check's scan reads it.
    async download(slug: string): Promise<Uint8Array | null> {
      try {
        const r = await http(`${base}/backups/${encodeURIComponent(slug)}/download`, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
        if (r.status !== 200) return null;
        const b = new Uint8Array(await r.arrayBuffer());
        return b.length > 200 * 1024 * 1024 ? null : b;
      } catch { return null; }
    },
    // (0.1.10) The same download, written to a file (the backup check's own folder), so an interrupted check leaves a file
    // the next start removes rather than nothing it can name. True once the whole body is written.
    async downloadTo(slug: string, path: string): Promise<boolean> {
      try {
        const r = await http(`${base}/backups/${encodeURIComponent(slug)}/download`, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
        if (r.status !== 200) return false;
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length > 200 * 1024 * 1024) return false;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, b, { mode: 0o600 });
        return true;
      } catch { return false; }
    },
    // (0.1.6) An orphan backup's delete (DELETE /backups/<slug>, within the backup role): true only on the
    // Supervisor's ok.
    async deleteBackup(slug: string): Promise<boolean> {
      try { return (await call("DELETE", `/backups/${encodeURIComponent(slug)}`)).ok; } catch { return false; }
    },
    // (0.1.7) The backups list (GET /backups): each backup's slug and name, so a backup whose slug a restart lost
    // is found by the attempt-specific name kept before its call. Null when it can't be read.
    async backups(): Promise<{ slug: string; name: string }[] | null> {
      const r = await call("GET", "/backups").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.backups)) return null;
      return r.data.backups.filter((b: any) => b && typeof b.slug === "string").map((b: any) => ({ slug: b.slug, name: typeof b.name === "string" ? b.name : "" }));
    },
    // (0.1.7) The jobs list's active (not done) jobs on that App: matched on the App's slug as the job's reference.
    // 0.1.8: every such job's name (core.ts jobsWhy judges them: an install-like or unrecognized one stands in the way;
    // a job with no name counts as unrecognized). Null when the list can't be read.
    async activeJobs(app: string): Promise<string[] | null> {
      const r = await call("GET", "/jobs/info").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.jobs)) return null;
      const out: string[] = [];
      const walk = (xs: any[]) => { for (const x of xs) { if (!x || typeof x !== "object") continue;
        if (x.done !== true && x.reference === app) out.push(typeof x.name === "string" && x.name ? x.name.slice(0, 60) : "(a job with no name)");
        if (Array.isArray(x.child_jobs)) walk(x.child_jobs); } };
      walk(r.data.jobs);
      return out;
    },
    // (0.1.11) When the App's newest install or update job started: its "created" time in the jobs list (done or not), the
    // newest such job's. Null when the list can't be read or names none with a time. The Supervisor's jobs list records no
    // completion time for a backup, so no backupDoneAt is read here: a late backup stays retention-only (core.ts unusableWhy).
    async installStartedAt(app: string): Promise<number | null> {
      const r = await call("GET", "/jobs/info").catch(() => null);
      if (!r?.ok || !Array.isArray(r.data?.jobs)) return null;
      let best: number | null = null;
      const walk = (xs: any[]) => { for (const x of xs) { if (!x || typeof x !== "object") continue;
        const t = typeof x.created === "string" ? Date.parse(x.created) : NaN;
        if (x.reference === app && typeof x.name === "string" && /install|update/i.test(x.name) && Number.isFinite(t)) best = Math.max(best ?? 0, t);
        if (Array.isArray(x.child_jobs)) walk(x.child_jobs); } };
      walk(r.data.jobs);
      return best;
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
      return { found: true, uuid: String(hit.uuid), done: hit.done === true, errors: Array.isArray(hit.errors) ? hit.errors.length : 0,
        ...(typeof hit.name === "string" ? { name: hit.name.slice(0, 120) } : {}), ...(typeof hit.reference === "string" ? { reference: hit.reference.slice(0, 120) } : {}) };
    },
  };
}
