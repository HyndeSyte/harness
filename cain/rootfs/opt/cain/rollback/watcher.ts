// The rollback watcher (Cain 0.14.0). It runs as its own user, watch (uid 1002): not Cain's, not
// root. It reads what the probe keeps (/data/probe, root's, its group's to read) and, when probe/
// core.ts decide() says something is due (a rollback, or an alarm about one), raises one flag: a
// file in its own folder (/data/watcher) holding exactly the word "look". That is all it can do.
// Root's helper (rollback/helper.ts) reads the flag as this user, takes nothing else from it (no
// backup, no version, no reason), and decides again from root's own records. The watcher can't
// write Cain's settings, hooks, plugin or home, or anything of root's.
//   bun watcher.ts loop     every minute, for good (the run script starts it as watch)
//   bun watcher.ts once     one look, printing what it decided
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Backup, decide, type Decision, FLAG, type Install, parseStarts, type Rollback } from "../probe/core";

const env = process.env;
const P = env.PROBE_DIR ?? "/data/probe";
const W = env.WATCHER_DIR ?? "/data/watcher";
const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
const num = (p: string) => { const n = Number((text(p) ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : null; };

// What root's helper keeps for the watcher from its record of restores (/data/probe/restores.json).
export function look(now: number, probeDir = P): Decision {
  const restores = json<{ bad?: string[]; last?: number | null }>(join(probeDir, "restores.json")) ?? {};
  return decide({
    now,
    install: json<Install>(join(probeDir, "install.json")),
    starts: parseStarts(text(join(probeDir, "starts")) ?? ""),
    signed: json<Record<string, unknown>>(join(probeDir, "signed.json")) ?? {},
    backup: json<Backup>(join(probeDir, "backup.json")),
    rollback: json<Rollback>(join(probeDir, "rollback.json")),
    bad: Array.isArray(restores.bad) ? restores.bad.map(String) : [],
    lastRestore: Number.isFinite(restores.last) ? Number(restores.last) : null,
    drill: num(join(probeDir, "drill")),
  });
}

// The flag, for a decision that needs root's helper; nothing for one that doesn't.
export function act(d: Decision, dir = W): string {
  const f = join(dir, "request");
  if (d.do === "none") return d.why;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".request.tmp"), `${FLAG}\n`, { mode: 0o600 });
  renameSync(join(dir, ".request.tmp"), f);
  return d.do === "rollback" ? `flag raised: a rollback is due (${d.why})` : `flag raised: an alarm is due, ${d.code} (${d.why})`;
}
export const lower = (dir = W) => rmSync(join(dir, "request"), { force: true });

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
