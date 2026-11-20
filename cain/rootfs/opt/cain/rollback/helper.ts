// The rollback helper (Cain 0.14.0), root's, and as small as the Supervisor's token allows: the
// only process here that calls the Supervisor's backup API. It does this and nothing else:
//   - keeps root's own records the rollback rests on, in /data/probe: the versions a signed Ship
//     installed (from the link's record of its cards, read only), and the pre-install backup of
//     this App the Supervisor took before the install (one kept per App: older backups of this App
//     alone are removed once the new one is found);
//   - at each start, tells whether this start came from a restore of that backup (a rollback
//     leaves no record of its own: the restore puts /data back as the backup held it);
//   - reads the watcher's requests (/data/watcher, read as the watch user, so no link of its
//     leads root anywhere), checks a rollback request against root's own records (probe/core.ts
//     checkRequest), tells Dane (notice.sh, both routes) and then restores that one backup, this
//     App only; anything else is refused. Three Supervisor refusals in a row end it with an alarm
//     naming the reason. An alarm request raises one fixed alarm, once per install.
//   bun helper.ts loop      every minute, for good (the run script starts it)
//   bun helper.ts boot      once at a start, after the install is recorded
//   bun helper.ts backups   lists the backups of this App alone and the one it would restore
//                           (the drill's first step: it changes nothing)
//   bun helper.ts restore-drill <slug>   the rollback's one Supervisor call, on a backup of this App
//                           alone of the running version taken within 2 hours (the drill's own)
// The Supervisor's token is read from s6's saved environment (root's only: c1/lock.sh run) for
// each call and never logged, written or passed on.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appOnly, type Backup, checkRequest, type Install, inWindow, olderToRemove, preInstall, REFUSALS_MAX, restoredFrom,
  type Rollback, signedFromLink,
} from "../probe/core";
import { paths as probePaths, writeWhole } from "../probe/main";

const env = process.env;
export interface Sup { call: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data?: any; message?: string }> }
export interface HelperDeps {
  dir: string;                                      // /data/probe
  watcher: string;                                  // /data/watcher
  linkState: string;                                // /data/link/state.json
  now: number;
  sup: Sup;
  readAsWatch: (path: string) => string | null;     // the watcher's file, read as the watch user
  removeAsWatch: (path: string) => void;
  notice: (...args: string[]) => number;
  relay: (line: string) => void;
  log: (m: string) => void;
}
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };

// -- the Supervisor -------------------------------------------------------------------------------
export function supervisor(tokenFile = env.SUPERVISOR_TOKEN_FILE ?? "/run/s6/container_environment/SUPERVISOR_TOKEN", base = "http://supervisor"): Sup {
  return {
    async call(method, path, body) {
      let token = "";
      try { token = readFileSync(tokenFile, "utf8").trim(); } catch { return { ok: false, message: "the Supervisor's token can't be read" }; }
      try {
        const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: "manual" });
        let j: any = null;
        try { j = await r.json(); } catch { /* not JSON */ }
        if (r.ok && j?.result === "ok") return { ok: true, data: j.data };
        return { ok: false, message: String(j?.message ?? `HTTP ${r.status}`).replace(/[^\w ,.:'()/-]/g, " ").slice(0, 120) };
      } catch (e) { return { ok: false, message: `no answer (${(e as Error).name})` }; }
    },
  };
}
async function self(sup: Sup): Promise<{ slug: string; version: string; latest: string } | null> {
  const r = await sup.call("GET", "/addons/self/info");
  if (!r.ok || typeof r.data?.slug !== "string") return null;
  return { slug: r.data.slug, version: String(r.data.version ?? ""), latest: String(r.data.version_latest ?? "") };
}
export async function listBackups(sup: Sup): Promise<Backup[] | null> {
  const r = await sup.call("GET", "/backups");
  if (!r.ok || !Array.isArray(r.data?.backups)) return null;
  return r.data.backups.filter((b: any) => typeof b?.slug === "string" && /^[0-9a-f]{8}$/.test(b.slug)).map((b: any) => ({
    slug: b.slug, date: Math.floor(Date.parse(String(b.date)) / 1000) || 0,
    addons: Array.isArray(b.content?.addons) ? b.content.addons.map(String) : [],
    homeassistant: b.content?.homeassistant === true, folders: Array.isArray(b.content?.folders) ? b.content.folders.map(String) : [],
  }));
}
async function versionOf(sup: Sup, b: Backup, slug: string): Promise<string | undefined> {
  const r = await sup.call("GET", `/backups/${b.slug}/info`);
  const a = Array.isArray(r.data?.addons) ? r.data.addons.find((x: any) => x?.slug === slug) : null;
  return typeof a?.version === "string" ? a.version : undefined;
}
// The backups of this App alone, with the version each holds.
async function appBackups(sup: Sup, slug: string): Promise<Backup[] | null> {
  const all = await listBackups(sup);
  if (!all) return null;
  const mine = all.filter((b) => appOnly(b, slug));
  for (const b of mine) b.version = await versionOf(sup, b, slug);
  return mine;
}

// -- root's records --------------------------------------------------------------------------------
export function keepSigned(d: HelperDeps): Record<string, unknown> {
  const file = join(d.dir, "signed.json");
  const had = json<Record<string, unknown>>(file) ?? {};
  const now = signedFromLink(json(d.linkState));
  const merged = { ...had, ...now };
  if (Object.keys(merged).length !== Object.keys(had).length) {
    writeWhole(file, JSON.stringify(merged));
    d.log(`signed Ships on record: Cain ${Object.keys(merged).sort().join(", ")}`);
  }
  return merged;
}
// The pre-install backup, found once per install, and the older backups of this App alone removed.
export async function keepBackup(d: HelperDeps): Promise<Backup | null> {
  const install = json<Install>(join(d.dir, "install.json"));
  const file = join(d.dir, "backup.json");
  const have = json<Backup & { install?: string }>(file);
  if (have && install && have.install === install.id) return have;
  if (!inWindow(install, d.now)) return null;
  const me = await self(d.sup);
  if (!me) { d.log("the Supervisor didn't say which App this is, so the pre-install backup isn't looked for yet"); return null; }
  const mine = await appBackups(d.sup, me.slug);
  if (!mine) { d.log("the Supervisor didn't list the backups; looked for again in 10 minutes"); return null; }
  const b = preInstall(mine, me.slug, install);
  if (!b) { d.log(`no backup of this App holding Cain ${install!.previous} from just before the install; looked for again in 10 minutes`); return null; }
  writeWhole(file, JSON.stringify({ ...b, install: install!.id }));
  d.log(`the pre-install backup: ${b.slug}, Cain ${b.version}`);
  for (const old of olderToRemove(mine, me.slug, b)) {
    const r = await d.sup.call("DELETE", `/backups/${old}`);
    d.log(r.ok ? `removed an older backup of this App alone (${old}): one is kept` : `couldn't remove an older backup of this App (${old}): ${r.message}`);
  }
  return b;
}

// At a start: did a restore of this App's newest backup put /data back? Then it was a rollback (or
// Dane's own restore of that backup): kept, so no other rollback follows within a day, Dane hears
// it in the morning's Moving section, and Cain is told now.
export async function boot(d: HelperDeps): Promise<boolean> {
  keepSigned(d);
  const p = probePaths({ PROBE_DIR: d.dir });
  const alive = Number((existsSync(p.alive) ? readFileSync(p.alive, "utf8") : "").trim()) || null;
  const me = await self(d.sup);
  if (!me) return false;
  const mine = await appBackups(d.sup, me.slug);
  const newest = (mine ?? []).sort((a, b) => b.date - a.date)[0] ?? null;
  const install = json<Install>(p.install);
  if (!restoredFrom({ now: d.now, version: me.version, alive, install, newest })) return false;
  const undone = me.latest && me.latest !== me.version ? me.latest : "unknown";
  writeWhole(p.rolled, JSON.stringify({ at: d.now, restored: me.version, undone, backup: newest!.slug }));
  d.log(`this start came from a restore of the backup taken before an update: Cain ${me.version}${undone !== "unknown" ? `, in place of ${undone}` : ""}`);
  d.relay(`Your App was rolled back to Cain ${me.version}${undone !== "unknown" ? ` from ${undone}` : ""}, from the backup taken just before that update, because the update stopped you answering. The App told Dane itself when it happened. Put it in tomorrow's Moving section in one line; nothing else to tell him.`);
  return true;
}

// The watcher's alarm request: one fixed alarm per install and code.
const ALARMS: Record<string, string> = { again: "rollback-again", unsigned: "rollback-unsigned", "no-backup": "rollback-nobackup" };
export function takeAlarm(d: HelperDeps): string | null {
  const f = join(d.watcher, "alarm.json");
  const raw = d.readAsWatch(f);
  if (raw === null) return null;
  let a: any = null;
  try { a = JSON.parse(raw); } catch { /* below */ }
  const kind = ALARMS[String(a?.code)];
  const install = json<Install>(join(d.dir, "install.json"));
  if (!kind || !install) { d.removeAsWatch(f); return null; }
  const told = join(d.dir, "rollback-told");
  const key = `${install.id} ${kind}`;
  const had = (existsSync(told) ? readFileSync(told, "utf8") : "").split("\n");
  if (had.includes(key)) { d.removeAsWatch(f); return null; }
  const why = String(a?.why ?? "").replace(/[^\w ,.'()-]/g, " ").slice(0, 160);
  if (d.notice("tell", kind, why) > 1) return null;          // kept for the next round
  writeWhole(told, [...had.filter(Boolean).slice(-50), key].join("\n") + "\n", 0o600);
  d.removeAsWatch(f);
  return kind;
}

// The watcher's rollback request, checked from root's records, then the one restore.
export async function takeRequest(d: HelperDeps): Promise<string | null> {
  const rbFile = join(d.dir, "rollback.json");
  let rb = json<Rollback>(rbFile);
  const install = json<Install>(join(d.dir, "install.json"));
  if (!rb || rb.install !== install?.id) {
    const f = join(d.watcher, "request.json");
    const raw = d.readAsWatch(f);
    if (raw === null) return null;
    d.removeAsWatch(f);
    let req: unknown = null;
    try { req = JSON.parse(raw); } catch { /* below */ }
    const ok = checkRequest(req, { now: d.now, install, backup: json<Backup>(join(d.dir, "backup.json")), signed: json(join(d.dir, "signed.json")) ?? {},
      rollback: rb, rolledBack: json<{ at: number }>(join(d.dir, "rolled-back.json"))?.at ?? null });
    if (typeof ok === "string") { d.log(`refused a rollback request: ${ok}`); return `refused: ${ok}`; }
    rb = { install: ok.install, at: d.now, slug: ok.slug, restore: ok.restore, undo: ok.undo, why: ok.why, state: "asking", tries: 0 };
    writeWhole(rbFile, JSON.stringify(rb));
    // Dane hears it first: the restore replaces /data and this App with them, so nothing after it
    // here could tell him.
    d.notice("tell", "rollback", `from ${rb.undo} back to ${rb.restore}, because ${rb.why}`);
  }
  if (rb.state !== "asking") return null;
  const me = await self(d.sup);
  const r = me ? await d.sup.call("POST", `/backups/${rb.slug}/restore/partial`, { addons: [me.slug], background: true })
    : { ok: false, message: "the Supervisor didn't say which App this is" };
  if (r.ok) {
    rb = { ...rb, state: "restoring", tries: rb.tries + 1 };
    writeWhole(rbFile, JSON.stringify(rb));
    d.log(`the Supervisor took the restore of ${rb.slug}: Cain ${rb.restore} in place of ${rb.undo}`);
    return "restoring";
  }
  rb = { ...rb, tries: rb.tries + 1, error: r.message };
  if (rb.tries >= REFUSALS_MAX) {
    rb.state = "refused";
    writeWhole(rbFile, JSON.stringify(rb));
    d.notice("tell", "rollback-failed", `the Supervisor refused it ${rb.tries} times: ${r.message}`);
    d.log(`the Supervisor refused the restore ${rb.tries} times (${r.message}): stopped, and Dane told`);
    return "refused";
  }
  writeWhole(rbFile, JSON.stringify(rb));
  d.log(`the Supervisor refused the restore (${r.message}); try ${rb.tries} of ${REFUSALS_MAX}`);
  return `refused ${rb.tries}`;
}

if (import.meta.main) {
  const asWatch = (args: string[]) => Bun.spawnSync([env.AS_WATCH ?? "/opt/cain/as-watch", ...args], { timeout: 10_000 });
  const deps = (): HelperDeps => ({
    dir: env.PROBE_DIR ?? "/data/probe", watcher: env.WATCHER_DIR ?? "/data/watcher", linkState: env.CAIN_LINK_STATE ?? "/data/link/state.json",
    now: Math.floor(Date.now() / 1000), sup: supervisor(),
    readAsWatch: (f) => { const r = asWatch(["head", "-c", "4096", f]); return r.exitCode === 0 ? r.stdout.toString() : null; },
    removeAsWatch: (f) => { asWatch(["rm", "-f", f]); },
    notice: (...args) => Bun.spawnSync(["timeout", "-k", "2", "60", env.PROBE_NOTICE ?? "/opt/cain/notice.sh", ...args], { stdout: "inherit", stderr: "inherit", env: { ...env, NOTICE_LOCK_S: "20" } }).exitCode ?? 1,
    relay: (line) => { try { appendFileSync(env.RELAY_QUEUE ?? "/data/relay.queue", JSON.stringify({ text: line }) + "\n"); } catch { /* the morning line still says it */ } },
    log: (m) => console.log(`[cain] rollback: ${m}`),
  });
  const cmd = process.argv[2];
  if (cmd === "boot") { await boot(deps()); }
  else if (cmd === "backups") {
    const d = deps();
    const me = await self(d.sup);
    if (!me) { console.log("the Supervisor didn't answer (is hassio_api on, with the backup role?)"); process.exit(1); }
    const mine = await appBackups(d.sup, me.slug) ?? [];
    for (const b of mine) console.log(`${b.slug} ${new Date(b.date * 1000).toISOString()} Cain ${b.version ?? "?"}`);
    const install = json<Install>(join(d.dir, "install.json"));
    const pick = preInstall(mine, me.slug, install);
    console.log(pick ? `would restore ${pick.slug} (Cain ${pick.version})` : `would restore nothing: no pre-install backup for ${install ? `Cain ${install.version}` : "an install on record"}`);
  } else if (cmd === "restore-drill") {
    // The drill of the one Supervisor call a rollback makes (cain/tools/probe-drill.sh --restore):
    // only a backup of this App alone, of the version running now, taken within the last 2 hours
    // (the drill takes it just before), so the drill loses nothing but those minutes.
    const d = deps();
    const slug = String(process.argv[3] ?? "");
    const me = await self(d.sup);
    const mine = me ? await appBackups(d.sup, me.slug) : null;
    const b = mine?.find((x) => x.slug === slug);
    if (!me || !b) { console.log(`refused: ${slug || "no backup named"} isn't a backup of this App alone`); process.exit(1); }
    if (b.version !== me.version || d.now - b.date > 2 * 3600) { console.log(`refused: ${slug} isn't of Cain ${me.version} from the last 2 hours`); process.exit(1); }
    const r = await d.sup.call("POST", `/backups/${slug}/restore/partial`, { addons: [me.slug], background: true });
    console.log(r.ok ? `the Supervisor took the restore of ${slug}: the App restarts from it now` : `the Supervisor refused the restore: ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "loop") {
    let n = 0;
    for (;;) {
      const d = deps();
      try {
        keepSigned(d);
        if (n % 10 === 0) await keepBackup(d);
        takeAlarm(d);
        await takeRequest(d);
        // A request file of no install, or a stale rollback mark, needs nothing: the watcher's own
        // folder is its to keep.
      } catch (e) { d.log(`a round failed: ${(e as Error).name}`); }
      n++;
      await Bun.sleep(60_000);
    }
  } else { console.error("usage: helper.ts loop | boot | backups | restore-drill <slug>"); process.exit(2); }
}
// Kept for the tests: a file removed as root, when a test has no watch user.
export const removeFile = (f: string) => rmSync(f, { force: true });
