// A record keeper on a real git repo standing in for GitHub, for the holds tests
// (not a test file itself).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHolds, type Holds, type Outcome } from "../rootfs/opt/cain/record/core.ts";
import type { Config } from "../rootfs/opt/cain/record/main.ts";

export const T0 = new Date("2026-11-11T13:00:00Z");
export const hrs = (n: number) => new Date(T0.getTime() + n * 3_600_000);
export const SA = "0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e", SB = "9a1b2c3d-0000-4000-8000-000000000002";
export const A = `laptop:${SA}`, B = `laptop:${SB}`;

// The open list's real shape (state/PENDING.md in the record), cut down.
export const PENDING = [
  "# Pending",
  "",
  "Cain keeps this current. Read it at the start of every check-in and conversation.",
  "",
  "## Open",
  "",
  "| ID | Item | Who | Next step | Waits for | Done when | Since |",
  "|---|---|---|---|---|---|---|",
  "| P11 | Calendar: each add-on watches the other | Build | Waiting on Dane (Ship) | | Both alert when the other is down | Nov 7 |",
  "| P33 | Org v2 wave 1, the trust boundary | Build | The laptop session holds all harness work |  | Deliberate drills pass | Nov 10 |",
  "| P44 | Calendar specialist fails his plain commands | Build | Hold the Build until P33 lifts | after P33 | His words find his PT event | Nov 11 |",
  "",
  "## Done",
  "",
  "| Item | Date |",
  "|---|---|",
  "| P06 Turkey harvest block on Gmail: made by the specialist 7:26 AM | Nov 10 |",
  "",
].join("\n");

// Children never see this session's own Claude Code or record settings.
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["CLAUDE_CODE_SESSION_ID", "RECORD_CLONE", "CAIN_TOOLS"].includes(k)) env[k] = v;
  return { ...env, ...extra };
}

export function sh(cmd: string[], cwd: string, o: { env?: Record<string, string>; input?: string } = {}) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: o.env ?? cleanEnv(), stdin: o.input === undefined ? "ignore" : Buffer.from(o.input) });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

export function rig(files: Record<string, string> = { "state/PENDING.md": PENDING }) {
  const root = mkdtempSync(join(tmpdir(), "holds-"));
  const remote = join(root, "remote.git");
  sh(["git", "init", "--quiet", "--bare", "-b", "main", remote], root);
  const seed = join(root, "seed");
  sh(["git", "-c", "core.autocrlf=false", "clone", "--quiet", "-c", "core.autocrlf=false", remote, seed], root);
  const g = (...a: string[]) => sh(["git", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", ...a], seed);
  const put = (path: string, text: string) => { mkdirSync(join(seed, path, ".."), { recursive: true }); writeFileSync(join(seed, path), text); };
  for (const [p, t] of Object.entries(files)) put(p, t);
  g("add", "-A"); g("commit", "--quiet", "-m", "seed"); g("push", "--quiet", "origin", "HEAD:main");
  let now = T0, n = 0;
  const cfg: Config = {
    remote, dir: join(root, "pi/record"), queue: join(root, "pi/queue"), outcomes: join(root, "pi/outcomes"),
    relay: join(root, "pi/relay.queue"), branch: "main", hygieneAt: "0230", tz: "America/New_York",
    now: () => now, holds: join(root, "pi/record-holds.json"),
  };
  mkdirSync(cfg.queue, { recursive: true });
  const pull = () => g("pull", "--quiet", "--ff-only", "origin", "main");
  const r = {
    root, remote, seed, cfg, g, pull,
    at(d: Date) { now = d; },
    // The clock moves to d with the keeper running all along (its last round a minute
    // before), so none of it counts as keeper downtime.
    running(d: Date) {
      now = d;
      if (existsSync(cfg.holds!)) {
        const st = JSON.parse(readFileSync(cfg.holds!, "utf8"));
        writeFileSync(cfg.holds!, JSON.stringify({ ...st, alive: new Date(d.getTime() - 60_000).toISOString() }));
      }
    },
    // Cain's request, through his local queue.
    cain(req: Record<string, unknown>) { writeFileSync(join(cfg.queue, `${String(++n).padStart(4, "0")}.json`), JSON.stringify({ from: "cain", kind: "change", summary: "s", ...req })); },
    // Requests from laptop sessions, pushed to the record's inbox together in one commit.
    inbox(...reqs: [string, Record<string, unknown>][]) {
      pull();
      for (const [name, req] of reqs) put(`inbox/${name}`, JSON.stringify({ kind: "change", summary: "s", ...req }));
      g("add", "-A"); g("commit", "--quiet", "-m", "inbox"); g("push", "--quiet", "origin", "HEAD:main");
    },
    // A file as it is on "GitHub" now.
    upstream(path: string): string | null { pull(); return existsSync(join(seed, path)) ? readFileSync(join(seed, path), "utf8") : null; },
    holds(): Holds { return parseHolds(r.upstream("state/holds.json")) ?? {}; },
    log(): Outcome[] {
      pull();
      const d = join(seed, "log/requests");
      if (!existsSync(d)) return [];
      return readdirSync(d).sort().flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    },
    states(id: string) { return r.log().filter((o) => o.id === id).map((o) => o.state); },
    reason(id: string) { return r.log().filter((o) => o.id === id).at(-1)?.reason; },
    relayed(): string {
      if (!existsSync(cfg.relay)) return "";
      return readFileSync(cfg.relay, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).text).join(" / ");
    },
    outcome(id: string): Outcome | null { const f = join(cfg.outcomes, `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; },
    kept(): any { return JSON.parse(readFileSync(cfg.holds!, "utf8")); },
    subjects(n = 10): string[] { pull(); return g("log", "--format=%s", `-${n}`).split("\n"); },
  };
  return r;
}
