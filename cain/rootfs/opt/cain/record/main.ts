// Cain's record keeper: the one writer of the record (the private org repo).
// Keeps a copy of the record on the Pi (/data/record, so Home Assistant's
// backups carry it off the box), applies requests one at a time, commits each,
// pushes, and runs the nightly check. Requests come from:
//   - Cain, through /opt/cain/record.sh (a local queue folder), and
//   - the record's own inbox/ folder (Dane's page and laptop sessions).
// Safety rules: a request leaves its queue only after the commit carrying it is
// confirmed on GitHub; any git failure ends the round with nothing let go; a
// request id is applied at most once; nothing is written through a link.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRequest, plan, hygiene, hygieneReport, clean, type Outcome, type Request, type Tree } from "./core.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; relay: string;
  branch: string; token?: string; hygieneAt: string; tz: string; now?: () => Date;
};

const MAX_RAW = 1_000_000;
const MAX_NOTE = 2_000;
const log = (m: string) => console.log(`[record] ${m}`);

export function blobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

class GitError extends Error {}

function git(cfg: Config, args: string[], cwd = cfg.dir): string {
  const env: Record<string, string> = { ...process.env as any, GIT_TERMINAL_PROMPT: "0" };
  if (cfg.token) {
    // Rewritten every time, so nothing planted there is ever used.
    const ask = "/tmp/record-askpass.sh";
    writeFileSync(ask, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token;; *) echo "$RECORD_TOKEN";; esac\n', { mode: 0o700 });
    env.GIT_ASKPASS = ask; env.RECORD_TOKEN = cfg.token;
  }
  // Byte-exact files (the shas writers send are of the bytes as committed), links
  // checked out as plain files, and no hooks from the copy's own config.
  const p = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Cain's record keeper", "-c", "user.email=HyndeSyte@users.noreply.github.com", ...args],
    { cwd, env, stdout: "pipe", stderr: "pipe" });
  let out = (p.stdout.toString() + p.stderr.toString()).trim();
  if (cfg.token) out = out.split(cfg.token).join("<token>");
  if (p.exitCode !== 0) throw new GitError(`git ${args[0]}: ${out.split("\n")[0]}`);
  return out;
}

function sync(cfg: Config) {
  if (!existsSync(join(cfg.dir, ".git"))) {
    mkdirSync(dirname(cfg.dir), { recursive: true });
    git(cfg, ["clone", "--quiet", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", cfg.remote, cfg.dir], dirname(cfg.dir));
  }
  rmSync(join(cfg.dir, ".git", "index.lock"), { force: true });   // left by a restart mid-commit
  git(cfg, ["fetch", "--quiet", "origin", cfg.branch]);
  git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);
  git(cfg, ["clean", "-qfd"]);
}

// No part of the path may be a link, so a write can't land outside the record.
function linkFree(cfg: Config, path: string): boolean {
  let at = cfg.dir;
  for (const part of path.split("/")) {
    at = join(at, part);
    if (!existsSync(at)) return true;
    if (lstatSync(at).isSymbolicLink()) return false;
  }
  return true;
}

function tree(cfg: Config): Tree {
  const read = (p: string) => {
    const f = join(cfg.dir, p);
    if (!existsSync(f) || !linkFree(cfg, p)) return null;
    return lstatSync(f).isFile() ? readFileSync(f, "utf8") : null;
  };
  return { read, sha: (p) => { const t = read(p); return t === null ? null : blobSha(t); },
    isDir: (p) => { const f = join(cfg.dir, p); return existsSync(f) && lstatSync(f).isDirectory(); } };
}

type Pending = { req?: Request; error?: string; local?: string; repoPath?: string; name: string };

function readRequest(file: string): { req?: Request; error?: string } {
  const st = lstatSync(file);
  if (!st.isFile()) return { error: "not a file" };
  if (st.size > MAX_RAW) return { error: "over 1 MB" };
  return parseRequest(readFileSync(file, "utf8"));
}

function pending(cfg: Config): Pending[] {
  const out: Pending[] = [];
  mkdirSync(cfg.queue, { recursive: true });
  // Names starting with "." are still being written (record.sh copies, then renames).
  const names = (d: string) => readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  for (const name of names(cfg.queue)) {
    const local = join(cfg.queue, name);
    const r = readRequest(local);
    // The local queue is Cain's alone: what's in it is from Cain, never a note from Dane.
    if (r.req && r.req.from !== "cain") r.error = "the local queue only takes requests from cain";
    else if (r.req?.kind === "note") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), local, name });
  }
  const inbox = join(cfg.dir, "inbox");
  if (existsSync(inbox) && linkFree(cfg, "inbox")) for (const name of names(inbox)) {
    const r = readRequest(join(inbox, name));
    if (r.req && (r.req.from === "cain" || r.req.id.startsWith("cain-"))) r.error = "requests in inbox/ can't speak for Cain";
    else if (r.req?.kind === "note" && r.req.from !== "page") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), repoPath: `inbox/${name}`, name });
  }
  return out;
}

function seenIds(cfg: Config): Set<string> {
  const ids = new Set<string>();
  const d = join(cfg.dir, "log", "requests");
  if (!existsSync(d)) return ids;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl")))
    for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
      try { const id = JSON.parse(line).id; if (id) ids.add(id); } catch { /* skip */ }
    }
  return ids;
}

function relay(cfg: Config, text: string) {
  appendFileSync(cfg.relay, JSON.stringify({ text: clean(text, 2400) }) + "\n");
}

function logOutcome(cfg: Config, o: Outcome) {
  const p = join(cfg.dir, "log", "requests", `${o.at.slice(0, 7)}.jsonl`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(o) + "\n");
}

const outcomeFile = (cfg: Config, id: string) => join(cfg.outcomes, `${id.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`);

// One pass: apply everything waiting, one commit per request, then push once.
// If the push loses a race (a laptop pushed meanwhile), start over from the
// record as it now stands. Nothing leaves a queue until GitHub has the commit.
export function cycle(cfg: Config): { applied: number; ok: boolean } {
  for (let attempt = 0; attempt < 3; attempt++) {
    let items: Pending[], outcomes: (Outcome | null)[];
    try {
      sync(cfg);
      items = pending(cfg);
      if (items.length === 0) return { applied: 0, ok: true };
      const seen = seenIds(cfg);
      const t = tree(cfg);
      outcomes = [];
      for (const it of items) {
        const at = (cfg.now?.() ?? new Date()).toISOString();
        const id = it.req?.id ?? `unreadable-${it.name}`;
        // Cain's request already applied (the reply to an earlier push was lost,
        // or the add-on restarted before letting it go): never apply twice.
        if (it.local && it.req && seen.has(id) && !it.error) { outcomes.push(null); continue; }
        const base = { id, from: clean(it.req?.from ?? "unknown", 40), kind: it.req?.kind ?? "unknown",
          summary: clean(it.req?.summary ?? "(unreadable request)", 200), at };
        let o: Outcome;
        if (it.error) o = { ...base, state: "rejected", reason: clean(it.error) };
        else if (seen.has(id)) o = { ...base, state: "rejected", reason: "an id that was already used" };
        else if (it.req!.kind === "note") o = { ...base, state: "relayed" };
        else {
          const p = plan(it.req!, t);
          if (p.state !== "ok") o = { ...base, state: p.state, reason: clean(p.reason) };
          else if ([...p.writes.keys()].some((path) => !linkFree(cfg, path))) o = { ...base, state: "rejected", reason: "writes through a link" };
          else {
            try {
              for (const [path, content] of p.writes) {
                const f = join(cfg.dir, path);
                if (content === null) rmSync(f, { force: true });
                else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }
              }
              o = { ...base, state: "done" };
            } catch (e) {
              // Undo this request's partial writes; the others stand.
              git(cfg, ["checkout", "--quiet", "--", "."]); git(cfg, ["clean", "-qfd", "--", "areas", "state", "archive", "rules", "projects", "reviews"]);
              o = { ...base, state: "rejected", reason: clean(`couldn't write: ${(e as Error).message}`) };
            }
          }
        }
        if (it.repoPath && existsSync(join(cfg.dir, it.repoPath))) rmSync(join(cfg.dir, it.repoPath), { force: true });
        logOutcome(cfg, o);
        seen.add(id);
        git(cfg, ["add", "-A"]);
        const msg = o.state === "done" ? `${o.summary} (request ${o.id}, from ${o.from})` : `Request ${o.id} ${o.state}: ${o.reason ?? "relayed to Cain"}`;
        git(cfg, ["commit", "--quiet", "-m", msg]);
        o.commit = git(cfg, ["rev-parse", "--short", "HEAD"]);
        outcomes.push(o);
      }
    } catch (e) {
      log(`stopped this round, nothing let go: ${(e as Error).message}`);
      return { applied: 0, ok: false };
    }
    try {
      git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]);
    } catch (e) {
      // A lost race, or a push GitHub refused. Confirm before deciding.
      try { git(cfg, ["fetch", "--quiet", "origin", cfg.branch]); git(cfg, ["merge-base", "--is-ancestor", "HEAD", `origin/${cfg.branch}`]); }
      catch { log(`push didn't land (${(e as Error).message}); starting over`); continue; }
    }
    // GitHub has it: now the requests can go, and Cain hears what needs him.
    mkdirSync(cfg.outcomes, { recursive: true });
    items.forEach((it, i) => {
      const o = outcomes[i];
      if (it.local) rmSync(it.local, { force: true });
      if (!o) return;
      // Status files are for Cain's own requests, so an inbox file can't overwrite one.
      if (it.local) writeFileSync(outcomeFile(cfg, o.id), JSON.stringify(o));
      log(`${o.id} from ${o.from}: ${o.state}${o.reason ? ` (${o.reason})` : ""}`);
      if (o.state === "relayed" && it.req?.note) {
        const about = it.req.note.about ? ` about ${clean(it.req.note.about, 120)}` : "";
        const text = clean(it.req.note.text, MAX_NOTE);
        relay(cfg, `Dane's page sent a note${about} (request ${o.id}). His words, as typed: «${text}»`);
      } else if (o.state === "conflict" || o.state === "rejected") {
        if (it.local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was not applied: ${o.state}, ${o.reason}. Re-read the files and send it again if it's still needed.`);
        else if (o.from === "page" && !it.error) relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") couldn't be saved: ${o.reason}. Apply what he meant yourself and tell him it's done.`);
        else log(`inbox request ${o.id} from ${o.from} was ${o.state}; recorded in log/requests`);
      }
    });
    return { applied: items.length, ok: true };
  }
  log("gave up this round after three tries; will try again");
  return { applied: 0, ok: false };
}

// Once a day: the deterministic check, written to state/record-check.md.
export function nightly(cfg: Config): boolean {
  try {
    sync(cfg);
    const files = new Map<string, string>();
    const exists = new Set<string>();
    const walk = (rel: string, collect: boolean) => {
      const abs = rel ? join(cfg.dir, rel) : cfg.dir;
      for (const n of readdirSync(abs)) {
        if (n === ".git") continue;
        const r = rel ? `${rel}/${n}` : n;
        const st = lstatSync(join(abs, n));
        if (st.isSymbolicLink()) continue;
        exists.add(r);
        if (st.isDirectory()) walk(r, collect || ["areas", "archive", "rules", "state"].includes(r));
        else if (collect && n.endsWith(".md") && st.size <= MAX_RAW) files.set(r, readFileSync(join(abs, n), "utf8"));
      }
    };
    walk("", false);
    const findings = hygiene(files, exists);
    const day = (cfg.now?.() ?? new Date()).toLocaleDateString("en-CA", { timeZone: cfg.tz });
    const report = hygieneReport(findings, day);
    const p = join(cfg.dir, "state", "record-check.md");
    const strip = (s: string) => s.replace(/^\d{4}-\d\d-\d\d: /m, "");
    if (existsSync(p) && strip(readFileSync(p, "utf8")) === strip(report)) return true;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, report);
    git(cfg, ["add", "state/record-check.md"]);
    git(cfg, ["commit", "--quiet", "-m", `Nightly record check: ${findings.length} to look at`]);
    git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]);
    if (findings.length) relay(cfg, `Nightly record check found ${findings.length} thing(s) to fix; they're in state/record-check.md. Fix what you can, record what you did, and bring Dane only what is his to decide.`);
    log(`nightly check: ${findings.length} finding(s)`);
    return true;
  } catch (e) {
    log(`nightly check didn't finish: ${(e as Error).message}`);
    return false;
  }
}

if (import.meta.main) {
  const cfg: Config = {
    remote: process.env.RECORD_REMOTE ?? "https://github.com/HyndeSyte/org.git",
    dir: process.env.RECORD_DIR ?? "/data/record",
    queue: process.env.RECORD_QUEUE ?? "/data/record-queue",
    outcomes: process.env.RECORD_OUTCOMES ?? "/data/record-outcomes",
    relay: process.env.RELAY_QUEUE ?? "/data/relay.queue",
    branch: process.env.RECORD_BRANCH ?? "main",
    token: process.env.RECORD_TOKEN || undefined,
    hygieneAt: process.env.RECORD_CHECK_AT ?? "0230",
    tz: process.env.CHECKIN_TZ ?? "America/New_York",
  };
  delete process.env.RECORD_TOKEN;   // kept only in cfg, handed to git per call
  log(cfg.token ? "keeping the record" : "no GitHub token in the add-on's options yet; the record keeper is waiting");
  let lastNight = "", lastTry = 0;
  while (true) {
    if (cfg.token) {
      try { cycle(cfg); } catch (e) { log(`cycle error: ${e}`); }
      const now = new Date();
      const hm = now.toLocaleTimeString("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit" }).replace(":", "");
      const day = now.toLocaleDateString("en-CA", { timeZone: cfg.tz });
      // At most one try an hour if it fails, so a broken check doesn't spam.
      if (hm >= cfg.hygieneAt && lastNight !== day && Date.now() - lastTry > 3_600_000) {
        lastTry = Date.now();
        if (nightly(cfg)) lastNight = day;
      }
    }
    await Bun.sleep(Number(process.env.RECORD_INTERVAL_S ?? 60) * 1000);
  }
}
