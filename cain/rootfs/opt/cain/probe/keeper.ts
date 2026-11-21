// The verdict probe (Cain 0.19.0), root's, run once right after each start of his session by the run
// script, outside his session. It talks to the keeper App (keeper/ in this repo) over Home Assistant's
// internal App network with Cain's own token (options keeper_url, keeper_token):
//   - GET /attempt: when an install of Cain is being watched (an attempt is open), it asks his session
//     the fixed liveness line once (the hourly check's own line, through the broker) and POSTs the
//     verdict bound to that attempt: PASS with the version this start runs, or FAIL with the reason.
//   - GET /last: when the keeper's last line about Cain names a rollback or a give-up Cain hasn't said
//     yet, that one line goes to the owner's Discord through notice.sh, once.
// Every existing probe alarm stays as it was (probe/main.ts). The token comes in KEEPER_TOKEN, is taken
// out of the environment at once, and is never logged or given to a child.
//   bun keeper.ts start <version>
// The keeper binds its armed record to this file's hash (probeHash): a drill counts only for the
// verdict probe it ran with, and the link checks the hash of the one installed here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CAIN_SLUG = "0fcc2575_cain";
export const KEEPER_URL = "http://0fcc2575-keeper:8097";
export const ASK_WAIT_S = 600;                          // the liveness line's answer, within 10 minutes
export const REPEAT_KINDS = ["rolled back", "gave up"];
export const PROBE_FILE = join(import.meta.dir, "keeper.ts");
export function probeHash(file = PROBE_FILE): string | null {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16); } catch { return null; }
}

export type Reply = { status: number; body: any } | null;
// One call to the keeper: the base URL must be plain http on a host name (the internal network).
export async function keeperCall(base: string, token: string, path: string, body?: unknown, ms = 10_000): Promise<Reply> {
  if (!/^http:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(base) || token.length < 16) return null;
  try {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(ms),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j: any = null;
    try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  } catch { return null; }
}

export interface VerdictDeps {
  get: (path: string) => Promise<Reply>;
  post: (path: string, body: unknown) => Promise<Reply>;
  ask: () => Promise<boolean>;                          // the liveness line asked once: answered in time
  version: string;
  log: (m: string) => void;
}
// The verdict for an open attempt: only one bound to it (its id), at the version this start runs.
export async function verdictRun(d: VerdictDeps): Promise<string> {
  const r = await d.get("/attempt");
  if (!r || r.status !== 200) { d.log(`the keeper didn't answer for an open attempt (${r ? r.status : "no answer"})`); return "no answer"; }
  const id = typeof r.body?.attempt === "string" ? r.body.attempt : null;
  if (!id) return "no attempt";
  if (r.body.to_version !== d.version) { d.log(`the keeper watches an install of ${String(r.body.to_version).slice(0, 32)}, but this start runs ${d.version}: no verdict`); return "other version"; }
  d.log(`an install of Cain ${d.version} is being watched: asking his session the liveness line`);
  const answered = await d.ask();
  const verdict = answered ? { result: "PASS", reason: "" } : { result: "FAIL", reason: `his session didn't answer the liveness line within ${ASK_WAIT_S / 60} minutes` };
  const p = await d.post("/verdict", { app: CAIN_SLUG, version: d.version, attempt: id, ...verdict });
  d.log(`verdict ${verdict.result} for the watched install: the keeper ${p?.status === 200 ? "took it" : `didn't take it (${p ? p.status : "no answer"})`}`);
  return verdict.result;
}

export interface LastDeps {
  get: (path: string) => Promise<Reply>;
  said: () => string | null;                            // the id of the keeper line said last
  markSaid: (id: string) => void;
  say: (line: string) => number;                        // notice.sh say's exit code
  log: (m: string) => void;
}
// The keeper's last line about Cain, said once when it names a rollback or a give-up.
export async function lastRepeat(d: LastDeps): Promise<string> {
  const r = await d.get("/last");
  if (!r || r.status !== 200) return "no answer";
  const { id, kind, line } = r.body ?? {};
  if (typeof id !== "string" || !id || typeof line !== "string" || !REPEAT_KINDS.includes(kind)) return "nothing to say";
  if (d.said() === id) return "said already";
  if (d.say(line) !== 0) { d.log("the keeper's line didn't reach his bot: tried again at the next start"); return "not said"; }
  d.markSaid(id);
  return "said";
}

if (import.meta.main) {
  const { paths, writeWhole } = await import("./main.ts");
  const { checkFolder } = await import("./folder.ts");
  const { PROBE_LINE } = await import("./core.ts");
  const env = process.env;
  const token = env.KEEPER_TOKEN ?? "";
  delete env.KEEPER_TOKEN;
  const base = (env.KEEPER_URL || KEEPER_URL).replace(/\/+$/, "");
  const log = (m: string) => console.log(`[cain] verdict probe: ${m}`);
  const [cmd, version] = process.argv.slice(2);
  if (cmd !== "start" || !version) { console.error("usage: keeper.ts start <version>"); process.exit(2); }
  if (!token) { log("no keeper_token set: no verdicts and no keeper lines"); process.exit(0); }
  const p = paths();
  const said = join(p.dir, "keeper-said");
  const readNum = (f: string) => { try { checkFolder(p.run); const n = Number(readFileSync(f, "utf8").trim().split(/\s+/)[0]); return Number.isFinite(n) ? n : 0; } catch { return 0; } };
  const get = (path: string) => keeperCall(base, token, path);
  await verdictRun({
    get, post: (path, body) => keeperCall(base, token, path, body), version, log,
    ask: async () => {
      const at = Math.floor(Date.now() / 1000);
      try { writeWhole(p.ask, `${at} ${PROBE_LINE.length}\n`); } catch (e) { log(`couldn't ask the liveness line: ${String(e).slice(0, 80)}`); return false; }
      for (let waited = 0; waited < ASK_WAIT_S; waited += 5) {
        await Bun.sleep(5_000);
        if (readNum(p.answered) >= at) return true;
      }
      return false;
    },
  });
  await lastRepeat({
    get, log,
    said: () => { try { checkFolder(p.dir); return readFileSync(said, "utf8").trim() || null; } catch { return null; } },
    markSaid: (id) => { try { writeWhole(said, `${id}\n`); } catch (e) { log(`couldn't keep which keeper line was said: ${String(e).slice(0, 80)}`); } },
    say: (line) => {
      const { KEEPER_TOKEN: _t, PROBE_PING_URL: _u, ...rest } = env;
      return Bun.spawnSync(["timeout", "-k", "2", "60", p.notice, "say", line], { stdout: "inherit", stderr: "inherit", env: rest }).exitCode ?? 1;
    },
  });
}
