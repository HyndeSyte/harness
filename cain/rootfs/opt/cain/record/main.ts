// Cain's record keeper: the one writer of the record (the private org repo).
// Keeps a copy of the record on the Pi (/data/record, so Home Assistant's
// backups carry it off the box), applies requests one at a time, commits each,
// pushes, and runs the nightly check. Requests come from:
//   - Cain, through /opt/cain/record.sh (a local queue folder), and
//   - the record's own inbox/ folder (Dane's page and laptop sessions).
// Safety rules: a request leaves its queue only after the commit carrying it is
// confirmed on GitHub; any git failure ends the round with nothing let go; a
// request id is applied at most once; nothing is written through a link.
// Holds (who holds which item) are the keeper's own: its copy in /data is the one
// that counts, and the record's state/holds.json is put back to it if it drifts.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRequest, plan, hygiene, hygieneReport, clean, expired, idleMs, holdsText, parseHolds, HOLDS_PATH, HOLD_IDLE_MS,
  type Downtime, type Holds, type Outcome, type Plan, type Request, type Tree } from "./core.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; relay: string;
  branch: string; token?: string; hygieneAt: string; tz: string; now?: () => Date;
  holds?: string;   // the keeper's own copy of the holds; default /data/record-holds.json (next to the queue)
};

const MAX_RAW = 1_000_000;
const MAX_NOTE = 2_000;
const DOWN_AFTER_MS = 5 * 60_000;   // this long between good rounds counts as keeper downtime
const KEEPER = "Cain's record keeper";   // the name on the keeper's own commits
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
    "-c", `user.name=${KEEPER}`, "-c", "user.email=HyndeSyte@users.noreply.github.com", ...args],
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
  // An earlier version of a file, by the blob sha a writer read it at.
  const blob = (sha: string) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const p = Bun.spawnSync(["git", "cat-file", "blob", sha], { cwd: cfg.dir, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  };
  return { read, sha: (p) => { const t = read(p); return t === null ? null : blobSha(t); }, blob,
    isDir: (p) => { const f = join(cfg.dir, p); return existsSync(f) && lstatSync(f).isDirectory(); } };
}

type Pending = { req?: Request; error?: string; local?: string; repoPath?: string; name: string };

function readRequest(file: string): { req?: Request; error?: string } {
  const st = lstatSync(file);
  if (!st.isFile()) return { error: "not a file" };
  if (st.size > MAX_RAW) return { error: "over 1 MB" };
  return parseRequest(readFileSync(file, "utf8"));
}

const jsonNames = (d: string) => readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();

function pending(cfg: Config): Pending[] {
  const out: Pending[] = [];
  mkdirSync(cfg.queue, { recursive: true });
  // Names starting with "." are still being written (record.sh copies, then renames).
  for (const name of jsonNames(cfg.queue)) {
    const local = join(cfg.queue, name);
    const r = readRequest(local);
    // The local queue is Cain's alone: what's in it is from Cain, never a note from Dane.
    if (r.req && r.req.from !== "cain") r.error = "the local queue only takes requests from cain";
    else if (r.req?.kind === "note") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), local, name });
  }
  const inbox = join(cfg.dir, "inbox");
  if (existsSync(inbox) && linkFree(cfg, "inbox")) for (const name of jsonNames(inbox)) {
    const r = readRequest(join(inbox, name));
    if (r.req && (r.req.from === "cain" || r.req.id.startsWith("cain-"))) r.error = "requests in inbox/ can't speak for Cain";
    else if (r.req?.kind === "note" && r.req.from !== "page") r.error = "notes come only from Dane's page";
    out.push({ ...(r.error ? { error: r.error, req: r.req } : r), repoPath: `inbox/${name}`, name });
  }
  return out;
}

// Cain's queue has something in it (cheap: no git).
export function queued(cfg: Config): boolean {
  return existsSync(cfg.queue) && jsonNames(cfg.queue).length > 0;
}

// Every request id in log/requests, with the last outcome logged for it.
function logbook(cfg: Config): Map<string, Outcome> {
  const last = new Map<string, Outcome>();
  const d = join(cfg.dir, "log", "requests");
  if (!existsSync(d)) return last;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl")).sort())
    for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
      try { const o = JSON.parse(line); if (o?.id) last.set(o.id, o); } catch { /* skip */ }
    }
  return last;
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

// ---- The keeper's own state, in /data: the holds, takes waiting behind Cain's
// jobs, when the keeper last finished a round (for its downtime), and the last
// commit it pushed. ----

type Waiting = { req: Request; since: string; local: boolean };
type State = { holds: Holds; waiting: Waiting[]; alive?: string; downtime: Downtime; pushed?: string };

const stateFile = (cfg: Config) => cfg.holds ?? join(dirname(cfg.queue), "record-holds.json");

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function revive(j: any): State | null {
  if (!j || typeof j !== "object") return null;
  const holds = parseHolds(JSON.stringify(j.holds ?? {}));
  if (!holds) return null;
  const waiting: Waiting[] = [];
  for (const w of Array.isArray(j.waiting) ? j.waiting : []) {
    const r = parseRequest(JSON.stringify(w?.req ?? null));
    if (r.req && !r.error && typeof w.since === "string") waiting.push({ req: r.req, since: w.since, local: w.local === true });
  }
  const downtime = (Array.isArray(j.downtime) ? j.downtime : [])
    .filter((d: any) => Array.isArray(d) && d.length === 2 && d.every((x: any) => typeof x === "string" && !Number.isNaN(Date.parse(x))));
  return { holds, waiting, alive: typeof j.alive === "string" ? j.alive : undefined, downtime,
    ...(typeof j.pushed === "string" && /^[0-9a-f]{40}$/.test(j.pushed) ? { pushed: j.pushed } : {}) };
}

function publishedHolds(cfg: Config): string | null {
  const f = join(cfg.dir, HOLDS_PATH);
  if (!existsSync(f) || !linkFree(cfg, HOLDS_PATH) || !lstatSync(f).isFile()) return null;
  return readFileSync(f, "utf8");
}

function publish(cfg: Config, holds: Holds) {
  if (!linkFree(cfg, HOLDS_PATH)) throw new Error(`${HOLDS_PATH} is behind a link`);
  const f = join(cfg.dir, HOLDS_PATH);
  // A folder can only be there by mistake (nothing may write under it): the file replaces it.
  if (existsSync(f) && lstatSync(f).isDirectory()) rmSync(f, { recursive: true, force: true });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, holdsText(holds));
}

function loadState(cfg: Config): State {
  const file = stateFile(cfg);
  let st: State | null = null;
  if (existsSync(file)) {
    try { st = revive(JSON.parse(readFileSync(file, "utf8"))); } catch { st = null; }
    if (!st) {
      // Set aside, and the copy the keeper last published stands in.
      renameSync(file, `${file}.bad-${Date.now()}`);
      log("the keeper's copy of the holds couldn't be read; set aside, starting from the record's copy");
      st = { holds: parseHolds(publishedHolds(cfg)) ?? {}, waiting: [], downtime: [] };
    }
  }
  // First start (a new install, or /data lost): what the keeper last published.
  st ??= { holds: parseHolds(publishedHolds(cfg)) ?? {}, waiting: [], downtime: [] };
  // A round that stopped between its push and saving this: its journal says what it
  // pushed. Kept only if that push is on GitHub; otherwise its requests are still
  // queued and run again.
  const next = `${file}.next`;
  if (existsSync(next)) {
    try {
      const j = JSON.parse(readFileSync(next, "utf8"));
      if (typeof j.commit !== "string" || !/^[0-9a-f]{40}$/.test(j.commit)) throw new Error("no commit");
      git(cfg, ["merge-base", "--is-ancestor", j.commit, `origin/${cfg.branch}`]);
      const landed = revive(j.state);
      if (landed) { st = { ...landed, pushed: j.commit }; writeAtomic(file, JSON.stringify(st)); }
    } catch { /* never landed */ }
    rmSync(next, { force: true });
  }
  // A /data restored from an older backup must not win: when the keeper itself has
  // published holds since this state's last push, its latest published copy stands.
  if (st.pushed) {
    let mine = "";
    try { mine = git(cfg, ["log", "-1", "--format=%H", `--author=${KEEPER}`, `origin/${cfg.branch}`, "--", HOLDS_PATH]); } catch { /* none */ }
    if (/^[0-9a-f]{40}$/.test(mine) && mine !== st.pushed) {
      let older = false;
      try { git(cfg, ["merge-base", "--is-ancestor", mine, st.pushed]); older = true; } catch { /* published after this state */ }
      let text: string | null = null;
      if (!older) try { text = git(cfg, ["show", `${mine}:${HOLDS_PATH}`]); } catch { text = null; }
      const theirs = parseHolds(text);
      if (theirs) {
        log("the keeper's copy of the holds is older than what it last published (restored from a backup?); starting from the published copy");
        st = { ...st, holds: theirs };
      }
    }
  }
  return st;
}

// The round that is starting. A long gap since the last round that finished is
// downtime: holds don't age through it, since nobody could renew them. Kept in
// memory; saved only when this round finishes, so a round that can't push (an
// outage) doesn't count as the keeper working.
function beat(st: State, now: Date) {
  if (st.alive && now.getTime() - Date.parse(st.alive) > DOWN_AFTER_MS) st.downtime.push([st.alive, now.toISOString()]);
  st.alive = now.toISOString();
  st.downtime = st.downtime.filter(([, b]) => now.getTime() - Date.parse(b) < 30 * 86_400_000).slice(-200);
}

const message = (o: Outcome) => o.state === "done"
  ? `${o.summary} (request ${o.id}, from ${o.from})`
  : `Request ${o.id} ${o.state}: ${o.reason ?? "relayed to Cain"}`;

// Once GitHub has it: the status file for Cain's own requests, and what Cain must hear.
function report(cfg: Config, o: Outcome, local: boolean, req: Request | undefined, unreadable: boolean) {
  // Status files are for Cain's own requests, so an inbox file can't overwrite one.
  if (local) writeFileSync(outcomeFile(cfg, o.id), JSON.stringify(o));
  log(`${o.id} from ${o.from}: ${o.state}${o.reason ? ` (${o.reason})` : ""}`);
  if (o.state === "relayed" && req?.note) {
    const about = req.note.about ? ` about ${clean(req.note.about, 120)}` : "";
    const text = clean(req.note.text, MAX_NOTE);
    relay(cfg, `Dane's page sent a note${about} (request ${o.id}). His words, as typed: «${text}»`);
  } else if (o.state === "conflict" || o.state === "rejected") {
    if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was not applied: ${o.state}, ${o.reason}. Re-read the files and send it again if it's still needed.`);
    else if (o.from === "page" && !unreadable) relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") couldn't be saved: ${o.reason}. Apply what he meant yourself and tell him it's done.`);
    else log(`inbox request ${o.id} from ${o.from} was ${o.state}; recorded in log/requests`);
  } else if (o.state === "refused") {
    if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was refused: ${o.reason}. That item has another holder; don't send it again.`);
    else if (o.from === "page") relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") wasn't saved: ${o.reason}. If the item is yours, apply what he meant yourself; if someone else holds it, file his words as a note on it.`);
    else log(`inbox request ${o.id} from ${o.from} was refused; recorded in log/requests`);
  }
}

// One pass: apply everything waiting, one commit per request, then push once.
// If the push loses a race (a laptop pushed meanwhile), start over from the
// record as it now stands. Nothing leaves a queue until GitHub has the commit.
export function cycle(cfg: Config): { applied: number; ok: boolean } {
  const clock = () => cfg.now?.() ?? new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    let items: Pending[] = [];
    const outcomes: (Outcome | null)[] = [];
    const settled: { o: Outcome; req: Request; local: boolean }[] = [];   // takes that stopped waiting
    let st: State;
    let book = new Map<string, Outcome>();
    try {
      sync(cfg);
      st = loadState(cfg);
      beat(st, clock());
      items = pending(cfg);
      if (items.length || st.waiting.length) book = logbook(cfg);
      // A take that has its final outcome in the log already (a /data restored from
      // a backup) isn't waiting any more.
      st.waiting = st.waiting.filter((w) => (book.get(w.req.id)?.state ?? "waiting") === "waiting");
      const seen = new Set(book.keys());
      const t = tree(cfg);
      let commits = 0;
      // One commit, when there is something to commit.
      const commit = (msg: string): string | undefined => {
        git(cfg, ["add", "-A"]);
        try { git(cfg, ["diff", "--cached", "--quiet"]); return undefined; } catch { /* staged changes */ }
        git(cfg, ["commit", "--quiet", "-m", msg]);
        commits++;
        return git(cfg, ["rev-parse", "--short", "HEAD"]);
      };
      const undo = () => { git(cfg, ["checkout", "--quiet", "--", "."]); git(cfg, ["clean", "-qfd", "--", "areas", "state", "archive", "rules", "projects", "reviews"]); };
      const ctx = (at: Date) => ({ at, holds: st.holds, downtime: st.downtime, tz: cfg.tz });
      const outcomeOf = (req: Request, at: Date) => ({ id: req.id, from: clean(req.from, 80), kind: req.kind, summary: clean(req.summary, 200), at: at.toISOString() });
      // A planned change: its files, then its holds. A failed write, the holds' included,
      // undoes this request only; the others stand.
      const apply = (p: Extract<Plan, { state: "ok" }>, base: Omit<Outcome, "state">): Outcome => {
        if ([...p.writes.keys()].some((path) => !linkFree(cfg, path))) return { ...base, state: "rejected", reason: "writes through a link" };
        try {
          for (const [path, content] of p.writes) {
            const f = join(cfg.dir, path);
            if (content === null) rmSync(f, { force: true });
            else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }
          }
          if (p.holdsChanged) publish(cfg, p.holds);
        } catch (e) {
          undo();
          return { ...base, state: "rejected", reason: clean(`couldn't write: ${(e as Error).message}`) };
        }
        if (p.holdsChanged) st.holds = p.holds;
        return { ...base, state: "done" };
      };
      const decide = (req: Request, local: boolean, base: Omit<Outcome, "state">): Outcome => {
        const p = plan(req, t, ctx(new Date(base.at)));
        if (p.state === "ok") return apply(p, base);
        if (p.state === "waiting") st.waiting.push({ req, since: base.at, local });
        return { ...base, state: p.state, reason: clean(p.reason) };
      };
      // Takes waiting behind one of Cain's jobs, planned again now; in the order they came.
      const settle = () => {
        for (let i = 0; i < st.waiting.length;) {
          const w = st.waiting[i], at = clock();
          const p = plan(w.req, t, ctx(at));
          const waited = idleMs({ renewed: w.since } as any, at, st.downtime);
          if (p.state === "waiting" && waited <= HOLD_IDLE_MS) { i++; continue; }
          st.waiting.splice(i, 1);
          const base = outcomeOf(w.req, at);
          const o: Outcome = p.state === "ok" ? apply(p, base)
            : p.state === "waiting" ? { ...base, state: "refused", reason: clean(`waited a day: ${p.reason}`) }
            : { ...base, state: p.state, reason: clean(p.reason) };
          logOutcome(cfg, o);
          o.commit = commit(message(o));
          settled.push({ o, req: w.req, local: w.local });
        }
      };
      // The keeper's own copy of the holds into the record. If that can't be written
      // the round goes on: the next round tries again.
      const republish = (msg: string) => {
        try { publish(cfg, st.holds); commit(msg); }
        catch (e) { undo(); log(`couldn't publish the holds (${(e as Error).message}); trying again next round`); }
      };

      // Holds that went a day without a word from their holder end.
      const now = clock();
      const ended = Object.keys(st.holds).filter((k) => expired(st.holds[k], now, st.downtime));
      if (ended.length) {
        const who = ended.map((k) => `${k} (${st.holds[k].holder})`).join(", ");
        for (const k of ended) delete st.holds[k];
        republish(`Holds: ${who} ended after a day without a word from the holder`);
      }
      if (st.waiting.length) settle();
      // The record's copy is the keeper's: put back if anyone else changed it.
      const published = publishedHolds(cfg);
      if (published === null ? Object.keys(st.holds).length > 0 : published !== holdsText(st.holds))
        republish(`Holds: ${HOLDS_PATH} put back to the keeper's copy`);

      for (const it of items) {
        const at = clock();
        const id = it.req?.id ?? `unreadable-${it.name}`;
        // Cain's request already applied (the reply to an earlier push was lost,
        // or the add-on restarted before letting it go): never apply twice.
        if (it.local && it.req && seen.has(id) && !it.error) { outcomes.push(null); continue; }
        const base = { id, from: clean(it.req?.from ?? "unknown", 80), kind: it.req?.kind ?? "unknown",
          summary: clean(it.req?.summary ?? "(unreadable request)", 200), at: at.toISOString() };
        let o: Outcome;
        if (it.error) o = { ...base, state: "rejected", reason: clean(it.error) };
        else if (seen.has(id)) o = { ...base, state: "rejected", reason: "an id that was already used" };
        else if (it.req!.kind === "note") o = { ...base, state: "relayed" };
        else o = decide(it.req!, !!it.local, base);
        if (it.repoPath && existsSync(join(cfg.dir, it.repoPath))) rmSync(join(cfg.dir, it.repoPath), { force: true });
        logOutcome(cfg, o);
        seen.add(id);
        o.commit = commit(message(o));
        outcomes.push(o);
        // A hold that ended or moved may let a waiting take through, before anything newer.
        if (o.state === "done" && st.waiting.length) settle();
      }
      if (commits === 0) {
        // Nothing to push: a good round all the same. Cain's requests that were
        // already applied are let go, with their status file if it was never written.
        finish(cfg, st, items, outcomes, book);
        return { applied: items.length, ok: true };
      }
      // What this round pushes, in case it stops before saving it below.
      writeAtomic(`${stateFile(cfg)}.next`, JSON.stringify({ commit: git(cfg, ["rev-parse", "HEAD"]), state: st }));
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
    // GitHub has it: the holds and waiting takes are saved, the requests can go,
    // and Cain hears what needs him.
    st!.pushed = git(cfg, ["rev-parse", "HEAD"]);
    finish(cfg, st!, items, outcomes, book);
    rmSync(`${stateFile(cfg)}.next`, { force: true });
    items.forEach((it, i) => { const o = outcomes[i]; if (o) report(cfg, o, !!it.local, it.req, !!it.error); });
    for (const s of settled) report(cfg, s.o, s.local, s.req, false);
    return { applied: items.length, ok: true };
  }
  log("gave up this round after three tries; will try again");
  return { applied: 0, ok: false };
}

// A round that finished: its state saved (so it counts as the keeper working), and
// Cain's queued requests let go. One that was applied in an earlier round that
// stopped before writing its status file gets that file from the log.
function finish(cfg: Config, st: State, items: Pending[], outcomes: (Outcome | null)[], book: Map<string, Outcome>) {
  writeAtomic(stateFile(cfg), JSON.stringify(st));
  mkdirSync(cfg.outcomes, { recursive: true });
  items.forEach((it, i) => {
    if (!it.local) return;
    rmSync(it.local, { force: true });
    const before = !outcomes[i] && it.req ? book.get(it.req.id) : undefined;
    if (before && !existsSync(outcomeFile(cfg, before.id))) writeFileSync(outcomeFile(cfg, before.id), JSON.stringify(before));
  });
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

// The keeper's loop. Cain's own queue is looked at every 2 seconds and a round runs
// as soon as it has something; GitHub's inbox gets a round every minute regardless.
// A round that fails waits for the next minute, so an outage isn't retried every
// 2 seconds.
export async function keep(cfg: Config, o: {
  pollMs?: number; fullMs?: number; stop?: () => boolean; nightly?: boolean;
  clock?: () => number; sleep?: (ms: number) => Promise<unknown>; run?: (cfg: Config) => { ok: boolean };
} = {}) {
  const pollMs = o.pollMs ?? 2_000, fullMs = o.fullMs ?? 60_000;
  const clock = o.clock ?? Date.now, sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms)), run = o.run ?? cycle;
  let due = 0, paused = false, lastNight = "", lastTry = -Infinity;
  while (!o.stop?.()) {
    if (clock() >= due || (!paused && queued(cfg))) {
      let ok = false;
      try { ok = run(cfg).ok; } catch (e) { log(`cycle error: ${e}`); }
      due = clock() + fullMs;
      paused = !ok;
    }
    if (o.nightly !== false) {
      const now = new Date();
      const hm = now.toLocaleTimeString("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit" }).replace(":", "");
      const day = now.toLocaleDateString("en-CA", { timeZone: cfg.tz });
      // At most one try an hour if it fails, so a broken check doesn't spam.
      if (hm >= cfg.hygieneAt && lastNight !== day && Date.now() - lastTry > 3_600_000) {
        lastTry = Date.now();
        if (nightly(cfg)) lastNight = day;
      }
    }
    await sleep(pollMs);
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
    holds: process.env.RECORD_HOLDS ?? "/data/record-holds.json",
  };
  delete process.env.RECORD_TOKEN;   // kept only in cfg, handed to git per call
  if (!cfg.token) {
    log("no GitHub token in the add-on's options yet; the record keeper is waiting");
    while (true) await Bun.sleep(3_600_000);
  }
  log("keeping the record");
  await keep(cfg, { fullMs: Number(process.env.RECORD_INTERVAL_S ?? 60) * 1000, pollMs: Number(process.env.RECORD_POLL_MS ?? 2000) });
}
