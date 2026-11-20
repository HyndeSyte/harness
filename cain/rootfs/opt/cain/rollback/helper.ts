// DORMANT IN CAIN 0.14.0: this file ships but nothing runs it. The run script never starts it, the
// App has no Supervisor API (hassio_api: false), no backup role, no config map and no switch, so it
// has no token, no record folder and nothing that could arm it; run by hand, it refuses and exits.
// It waits for the restore release, which needs the drills in DOCS.md ("What the restore release
// needs") to pass first. The watcher it reads a flag from is not in this release either.
//
// The rollback helper (Cain 0.14.0), root's, and as small as the Supervisor's token allows: the
// only process here that calls the Supervisor's backup API. Its token reaches every /backups
// endpoint (list, take, remove, restore, full restores included), so it stays root's alone: read
// from s6's saved environment (root's only: c1/lock.sh run) for each call, never logged, written,
// passed on or put on a command line. This file only ever calls the five requests in ALLOWED
// below; it never removes a backup.
//
// What it does:
//   - keeps root's own records the rollback rests on, in /data/probe: the versions a signed Ship
//     installed (from the link's record of its cards, read only), and, at once when an install is
//     seen, the Supervisor's pre-install backup of this App holding the version before. None found:
//     "rollback unavailable" on both routes right away, not at failure time;
//   - keeps the durable record of restores outside /data (/config/rollback-record.json, excluded
//     from backups): written before every restore call (the bad version, the target, the backup,
//     the time) and after it (the Supervisor's job id). Each start settles it: running the target,
//     the restore happened, and the job's final state (the Supervisor's jobs endpoint) says how it
//     went; anything but done alarms. A version on record as rolled back is never rolled back again;
//   - takes the watcher's flag (read as the watch user, so no link of its leads root anywhere) and
//     nothing else from it, then decides again from its own records (probe/core.ts decide). Due
//     alarms go out once per install. A due rollback, while rollback_armed is off (the default),
//     alarms "a rollback would have run" on both routes and does nothing. Armed, it flushes the
//     alarm on both routes first, synchronously, then writes the record, then restores that one
//     backup with a body fixed here: this App's slug only, no Home Assistant, no folders.
//   bun helper.ts loop      every minute, for good (the run script starts it)
//   bun helper.ts boot      once at a start, after the install is recorded
//   bun helper.ts backups   lists the backups of this App alone and the one it would restore
//   bun helper.ts restore-drill <slug>   the rollback's one Supervisor call, on a backup of this App
//                           alone of the running version taken within 2 hours (the drill's own),
//                           recorded like a rollback but marked a drill
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appOnly, type Backup, badVersions, decide, type Decision, inWindow, type Install, isFlag, parseRecord, parseStarts, preInstall,
  REFUSALS_MAX, type Restore, type RestoreRecord, restoreBody, type Rollback, settle, signedFromLink, unsettled,
} from "../probe/core";
import { writeRecord, writeWhole } from "../probe/main";

const env = process.env;
export interface Sup { call: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data?: any; message?: string }> }
export interface HelperDeps {
  dir: string;                                      // /data/probe
  watcher: string;                                  // /data/watcher
  linkState: string;                                // /data/link/state.json
  record: string;                                   // /config/rollback-record.json
  now: number;
  armed: boolean;                                   // rollback_armed, root's own option
  sup: Sup;
  readAsWatch: (path: string) => string | null;     // the watcher's file, read as the watch user
  removeAsWatch: (path: string) => void;
  notice: (...args: string[]) => number;
  relay: (line: string) => void;
  log: (m: string) => void;
}
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const SLUG = /^[0-9a-f]{8}$/;
const JOB = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/;

// -- the Supervisor -------------------------------------------------------------------------------
// Only these requests, whatever a caller asks: never a DELETE, never a full restore, never a new
// backup, never another App's endpoint.
export const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/addons\/self\/info$/],
  ["GET", /^\/backups$/],
  ["GET", /^\/backups\/[0-9a-f]{8}\/info$/],
  ["POST", /^\/backups\/[0-9a-f]{8}\/restore\/partial$/],
  ["GET", /^\/jobs\/([0-9a-f]{32}|[0-9a-f-]{36})$/],
];
export const allowed = (method: string, path: string) => ALLOWED.some(([m, r]) => m === method && r.test(path));
export function supervisor(tokenFile = env.SUPERVISOR_TOKEN_FILE ?? "/run/s6/container_environment/SUPERVISOR_TOKEN", base = "http://supervisor"): Sup {
  return {
    async call(method, path, body) {
      if (!allowed(method, path)) return { ok: false, message: "not a request this helper makes" };
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
async function self(sup: Sup): Promise<{ slug: string; version: string } | null> {
  const r = await sup.call("GET", "/addons/self/info");
  if (!r.ok || typeof r.data?.slug !== "string" || !/^[a-z0-9_]{1,64}$/.test(r.data.slug)) return null;
  return { slug: r.data.slug, version: String(r.data.version ?? "") };
}
export async function listBackups(sup: Sup): Promise<Backup[] | null> {
  const r = await sup.call("GET", "/backups");
  if (!r.ok || !Array.isArray(r.data?.backups)) return null;
  return r.data.backups.filter((b: any) => typeof b?.slug === "string" && SLUG.test(b.slug)).map((b: any) => ({
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
// A Supervisor job's final state: done (with no errors), failed, or unknown (still running, gone,
// or the endpoint refused: the backup role may not reach it).
export async function jobState(sup: Sup, id: string | undefined): Promise<"done" | "failed" | "unknown"> {
  if (!id || !JOB.test(id)) return "unknown";
  const r = await sup.call("GET", `/jobs/${id}`);
  if (!r.ok || typeof r.data?.done !== "boolean") return "unknown";
  if (!r.data.done) return "unknown";
  return Array.isArray(r.data.errors) && r.data.errors.length > 0 ? "failed" : "done";
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
// The record of restores, and the watcher's copy of what it needs from it (the versions rolled
// back, and when the last real restore was asked) in /data/probe.
export function readRecord(d: HelperDeps): RestoreRecord | "damaged" { return parseRecord(text(d.record)); }
function mirror(d: HelperDeps, r: RestoreRecord): void {
  const real = r.restores.filter((x) => !x.drill);
  writeWhole(join(d.dir, "restores.json"), JSON.stringify({ bad: badVersions(r), last: real.at(-1)?.at ?? null }));
}

// The pre-install backup, looked for at once when an install is seen, and every 10 minutes until
// found. None there (the Supervisor listed the backups): "rollback unavailable" at once. The
// Supervisor not answering: the same alarm after 10 tries. Never removes anything.
export async function keepBackup(d: HelperDeps): Promise<Backup | null> {
  const install = json<Install>(join(d.dir, "install.json"));
  const file = join(d.dir, "backup.json");
  const have = json<Backup & { install?: string }>(file);
  if (have && install && have.install === install.id) return have;
  if (!inWindow(install, d.now)) return null;
  const lookFile = join(d.dir, "backup-look.json");
  const looked = json<{ install: string; tries: number; told?: boolean }>(lookFile);
  const st = looked && looked.install === install!.id ? looked : { install: install!.id, tries: 0, told: false };
  st.tries++;
  const unavailable = (why: string) => {
    if (!st.told && d.notice("tell", "rollback-unavailable", why) <= 1) st.told = true;
    writeWhole(lookFile, JSON.stringify(st));
  };
  const me = await self(d.sup);
  const mine = me ? await appBackups(d.sup, me.slug) : null;
  if (!me || !mine) {
    d.log("the Supervisor didn't list the backups; looked for again");
    if (st.tries >= 10) unavailable("the Supervisor didn't list the backups"); else writeWhole(lookFile, JSON.stringify(st));
    return null;
  }
  const b = preInstall(mine, me.slug, install);
  if (!b) {
    d.log(`no backup of this App holding Cain ${install!.previous} from just before the install`);
    unavailable(`no backup of Cain ${install!.previous} from just before the update to ${install!.version}`);
    return null;
  }
  writeWhole(file, JSON.stringify({ ...b, install: install!.id }));
  d.log(`the pre-install backup: ${b.slug}, Cain ${b.version}`);
  if (st.told) d.notice("clear", "backup");
  rmSync(lookFile, { force: true });
  return b;
}

// At a start: the restore on record, settled; Dane hears anything but a restore that went through
// (and that one in the morning); Cain is told. Then the pre-install backup is looked for at once.
export async function boot(d: HelperDeps): Promise<Restore["outcome"] | null> {
  keepSigned(d);
  const r = readRecord(d);
  let outcome: Restore["outcome"] | null = null;
  if (r === "damaged") {
    d.log("the record of restores can't be read: no rollback until it's fixed");
    d.notice("tell", "rollback-record", "");
  } else {
    const u = unsettled(r);
    if (u) {
      const me = await self(d.sup);
      if (me) {
        const job = await jobState(d.sup, u.job);
        outcome = settle(u, me.version, job);
        u.outcome = outcome;
        if (u.drill) u.reported = true;
        writeRecord(d.record, r);
        d.log(`the restore on record (${u.bad} to ${u.target}${u.drill ? ", a drill" : ""}): ${outcome}`);
        if (!u.drill) {
          if (outcome === "done") d.relay(`Your App was rolled back to Cain ${u.target} from ${u.bad}, from the backup Home Assistant took just before that update, because ${u.why ?? "the update kept crashing"}. The App told Dane itself when it happened. Put it in tomorrow's Moving section in one line; nothing else to tell him.`);
          else d.notice("tell", "rollback-failed", outcome === "not run" ? `still on ${u.bad} after the restore was asked` : `the Supervisor's job for the restore ${outcome === "failed" ? "failed" : "has no known outcome"}`);
        }
      } else d.log("the Supervisor didn't say which version runs: the restore on record is settled at the next start");
    }
    mirror(d, r);
  }
  await keepBackup(d);
  return outcome;
}

// Everything decide() reads, from root's own records only.
export function rootView(d: HelperDeps, r: RestoreRecord): Parameters<typeof decide>[0] {
  const real = r.restores.filter((x) => !x.drill);
  const drill = Number((text(join(d.dir, "drill")) ?? "").trim());
  return {
    now: d.now,
    install: json<Install>(join(d.dir, "install.json")),
    starts: parseStarts(text(join(d.dir, "starts")) ?? ""),
    signed: json<Record<string, unknown>>(join(d.dir, "signed.json")) ?? {},
    backup: json<Backup>(join(d.dir, "backup.json")),
    rollback: json<Rollback>(join(d.dir, "rollback.json")),
    bad: badVersions(r),
    lastRestore: real.at(-1)?.at ?? null,
    drill: Number.isFinite(drill) && drill > 0 ? drill : null,
  };
}

const ALARMS: Record<string, string> = { again: "rollback-again", unsigned: "rollback-unsigned", "no-backup": "rollback-nobackup" };
// The watcher's flag: exactly "look\n", and nothing else is taken from it. Then root decides.
export async function takeFlag(d: HelperDeps): Promise<string | null> {
  const f = join(d.watcher, "request");
  const raw = d.readAsWatch(f);
  if (raw === null) return null;
  d.removeAsWatch(f);
  if (!isFlag(raw)) { d.log("refused the watcher's request: it isn't the flag (the helper takes nothing else from it)"); return "refused: not the flag"; }
  const r = readRecord(d);
  if (r === "damaged") { d.log("the record of restores can't be read: no rollback"); d.notice("tell", "rollback-record", ""); return "refused: the record can't be read"; }
  const dec: Decision = decide(rootView(d, r));
  if (dec.do === "none") return null;
  const install = json<Install>(join(d.dir, "install.json"))!;
  if (dec.do === "alarm") {
    const kind = ALARMS[dec.code];
    const told = join(d.dir, "rollback-told");
    const key = `${install.id} ${kind}`;
    const had = (text(told) ?? "").split("\n");
    if (had.includes(key)) return null;
    if (d.notice("tell", kind, dec.why) > 1) return null;          // asked again at the next flag
    writeWhole(told, [...had.filter(Boolean).slice(-50), key].join("\n") + "\n", 0o600);
    return kind;
  }
  const rb: Rollback = { install: dec.install, at: d.now, slug: dec.slug, restore: dec.restore, undo: dec.undo, why: dec.why, state: d.armed ? "asking" : "disarmed", tries: 0 };
  if (!d.armed) {
    // Off: a rollback would have run. Both routes, and nothing else, once for this install.
    if (d.notice("tell", "rollback-disarmed", `from ${dec.undo} back to ${dec.restore}, because ${dec.why}`) > 1) return null;
    writeWhole(join(d.dir, "rollback.json"), JSON.stringify(rb));
    d.log(`a rollback would have run (${dec.undo} back to ${dec.restore}: ${dec.why}); rollback_armed is off, so nothing was done`);
    return "disarmed";
  }
  writeWhole(join(d.dir, "rollback.json"), JSON.stringify(rb));
  return await restoreStep(d);
}

// The rollback once asked (armed only): the alarm flushed on both routes, the record written, the
// one restore. Tried again each round while the Supervisor refuses, 3 times at most.
export async function restoreStep(d: HelperDeps): Promise<string | null> {
  const rbFile = join(d.dir, "rollback.json");
  let rb = json<Rollback>(rbFile);
  const install = json<Install>(join(d.dir, "install.json"));
  if (!rb || rb.state !== "asking" || rb.install !== install?.id) return null;
  if (!d.armed) return null;
  const backup = json<Backup & { install?: string }>(join(d.dir, "backup.json"));
  if (!backup || backup.slug !== rb.slug || backup.install !== rb.install || !SLUG.test(rb.slug)) { d.log("the rollback's backup isn't the recorded pre-install backup: refused"); return "refused: not the recorded backup"; }
  const me = await self(d.sup);
  if (!me) { d.log("the Supervisor didn't say which App this is; tried again next round"); return "waiting"; }
  // Dane hears it first, on both routes, before anything: the restore replaces this container.
  // flush answers 0 only once Discord and Home Assistant both took it.
  if (d.notice("flush", "rollback", `from ${rb.undo} back to ${rb.restore}, because ${rb.why}`) !== 0) {
    d.log("the rollback's alarm isn't through on both routes yet: the restore waits for it");
    return "waiting: alarms not through";
  }
  const r0 = readRecord(d);
  if (r0 === "damaged") { d.notice("tell", "rollback-record", ""); return "refused: the record can't be read"; }
  const entry: Restore = { bad: rb.undo, target: rb.restore, slug: rb.slug, at: d.now, why: rb.why };
  r0.restores.push(entry);
  writeRecord(d.record, r0);
  mirror(d, r0);
  const r = await d.sup.call("POST", `/backups/${rb.slug}/restore/partial`, restoreBody(me.slug));
  if (r.ok) {
    entry.job = typeof r.data?.job_id === "string" ? r.data.job_id : undefined;
    writeRecord(d.record, r0);
    rb = { ...rb, state: "restoring", tries: rb.tries + 1 };
    writeWhole(rbFile, JSON.stringify(rb));
    d.log(`the Supervisor took the restore of ${rb.slug}: Cain ${rb.restore} in place of ${rb.undo}`);
    return "restoring";
  }
  entry.outcome = "not run"; entry.reported = true;
  writeRecord(d.record, r0);
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
  console.error("[cain] rollback: dormant until the restore release (Cain 0.14.0 ships no restore): nothing done");
  process.exit(2);
}
// The code the restore release will run, kept as it was (unreachable: the block above exits).
if (import.meta.main) {
  const asWatch = (args: string[]) => Bun.spawnSync([env.AS_WATCH ?? "/opt/cain/as-watch", ...args], { timeout: 10_000 });
  const deps = (): HelperDeps => ({
    dir: env.PROBE_DIR ?? "/data/probe", watcher: env.WATCHER_DIR ?? "/data/watcher", linkState: env.CAIN_LINK_STATE ?? "/data/link/state.json",
    record: env.ROLLBACK_RECORD ?? "/config/rollback-record.json",
    now: Math.floor(Date.now() / 1000), armed: false /* no switch in this release */, sup: supervisor(),
    readAsWatch: (f) => { const r = asWatch(["head", "-c", "64", f]); return r.exitCode === 0 ? r.stdout.toString() : null; },
    removeAsWatch: (f) => { asWatch(["rm", "-f", f]); },
    notice: (...args) => Bun.spawnSync(["timeout", "-k", "2", "90", env.PROBE_NOTICE ?? "/opt/cain/notice.sh", ...args], { stdout: "inherit", stderr: "inherit", env: { ...env, NOTICE_LOCK_S: "20" } }).exitCode ?? 1,
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
    console.log(`rollback_armed: ${d.armed ? "on" : "off (a rollback only alarms)"}`);
  } else if (cmd === "restore-drill") {
    // The drill of the one Supervisor call a rollback makes (cain/tools/probe-drill.sh 3): only a
    // backup of this App alone, of the version running now, taken within the last 2 hours (the drill
    // takes it just before), so the drill loses nothing but those minutes. Recorded like a rollback,
    // marked a drill, so the next start shows the record survived the restore and settles its job.
    const d = deps();
    const slug = String(process.argv[3] ?? "");
    const me = await self(d.sup);
    const mine = me ? await appBackups(d.sup, me.slug) : null;
    const b = mine?.find((x) => x.slug === slug);
    if (!me || !b) { console.log(`refused: ${slug || "no backup named"} isn't a backup of this App alone`); process.exit(1); }
    if (b.version !== me.version || d.now - b.date > 2 * 3600) { console.log(`refused: ${slug} isn't of Cain ${me.version} from the last 2 hours`); process.exit(1); }
    const rec = readRecord(d);
    if (rec === "damaged") { console.log("refused: the record of restores can't be read"); process.exit(1); }
    const entry: Restore = { bad: me.version, target: me.version, slug, at: d.now, why: "a drill", drill: true };
    rec.restores.push(entry);
    writeRecord(d.record, rec);
    const t0 = Date.now();
    const r = await d.sup.call("POST", `/backups/${slug}/restore/partial`, restoreBody(me.slug));
    if (r.ok) { entry.job = typeof r.data?.job_id === "string" ? r.data.job_id : undefined; writeRecord(d.record, rec); }
    else { entry.outcome = "not run"; entry.reported = true; writeRecord(d.record, rec); }
    console.log(r.ok ? `the Supervisor took the restore of ${slug} after ${Date.now() - t0} ms: the App restarts from it now` : `the Supervisor refused the restore: ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "loop") {
    let n = 1;                                    // boot looked for the backup at this start already
    for (;;) {
      const d = deps();
      try {
        keepSigned(d);
        if (n % 10 === 0) await keepBackup(d);
        await takeFlag(d);
        await restoreStep(d);
      } catch (e) { d.log(`a round failed: ${(e as Error).name}`); }
      n++;
      await Bun.sleep(60_000);
    }
  } else { console.error("usage: helper.ts loop | boot | backups | restore-drill <slug>"); process.exit(2); }
}
// Kept for the tests: a file removed as root, when a test has no watch user.
export const removeFile = (f: string) => rmSync(f, { force: true });
export const exists = existsSync;
