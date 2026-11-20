// The rollback watcher (Cain 0.14.0). It runs as its own user, watch (uid 1002): not Cain's, not
// root. It reads what the probe keeps (/data/probe, root's, its group's to read) and decides, by
// probe/core.ts decide(), whether the install of the last 24 hours must be rolled back. All it can
// do about it is write one of two requests into its own folder (/data/watcher, its own and no one
// else's): a rollback of the recorded pre-install backup, or an alarm. Root's helper
// (rollback/helper.ts) reads them as this user, checks a rollback request again from root's own
// records, and does only that one restore, or raises the alarm. It can't write Cain's settings,
// hooks, plugin or home, or anything of root's.
//   bun watcher.ts loop     every minute, for good (the run script starts it as watch)
//   bun watcher.ts once     one look, printing what it decided
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Backup, decide, type Decision, type Install, parseStarts, type Pass, type Rollback } from "../probe/core";

const env = process.env;
const P = env.PROBE_DIR ?? "/data/probe";
const W = env.WATCHER_DIR ?? "/data/watcher";
const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const num = (p: string) => { const n = Number((text(p) ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : null; };

export function look(now: number, probeDir = P): Decision {
  const passes = (text(join(probeDir, "passes.jsonl")) ?? "").split("\n").filter(Boolean).slice(-50)
    .map((l) => { try { return JSON.parse(l) as Pass; } catch { return null; } }).filter((x): x is Pass => !!x);
  return decide({
    now,
    install: json<Install>(join(probeDir, "install.json")),
    passes,
    starts: parseStarts(text(join(probeDir, "starts")) ?? ""),
    signed: json<Record<string, unknown>>(join(probeDir, "signed.json")) ?? {},
    backup: json<Backup>(join(probeDir, "backup.json")),
    rollback: json<Rollback>(join(probeDir, "rollback.json")),
    rolledBack: json<{ at: number }>(join(probeDir, "rolled-back.json"))?.at ?? null,
    drill: num(join(probeDir, "drill")),
  });
}

function put(name: string, body: unknown, dir = W): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body), { mode: 0o600 });
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
}
// What it writes for a decision: the request the helper reads (one rollback, or one alarm).
export function act(d: Decision, dir = W): string {
  if (d.do === "rollback") { put("request.json", { install: d.install, slug: d.slug, restore: d.restore, undo: d.undo, why: d.why }, dir); return `rollback asked: ${d.undo} back to ${d.restore} (${d.why})`; }
  if (d.do === "alarm") { put("alarm.json", { code: d.code, why: d.why }, dir); return `alarm asked: ${d.code} (${d.why})`; }
  return d.why;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (process.getuid?.() === 0 && env.WATCHER_AS_ROOT !== "1") { console.error("[cain] watcher: refuses to run as root"); process.exit(2); }
  const now = () => Math.floor(Date.now() / 1000);
  if (cmd === "once") console.log(act(look(now())));
  else if (cmd === "loop") {
    let last = "";
    for (;;) {
      try { const said = act(look(now())); if (said !== last) { console.log(`[cain] watcher: ${said}`); last = said; } }
      catch (e) { console.log(`[cain] watcher: a look failed: ${(e as Error).name}`); }
      await Bun.sleep(60_000);
    }
  } else { console.error("usage: watcher.ts loop | once"); process.exit(2); }
}
