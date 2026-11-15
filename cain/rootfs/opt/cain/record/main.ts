// Cain's record keeper: the one writer of the record (the private org repo).
// Keeps a copy of the record on the Pi (/data/record, so Home Assistant's
// backups carry it off the box), applies requests one at a time, commits each,
// pushes, and runs the nightly check. Requests come from:
//   - Cain, through /opt/cain/record.sh (a local queue folder), and
//   - the record's own inbox/ folder (Dane's page and laptop sessions).
// Safety rules: a request leaves its queue only after the commit carrying it is
// confirmed on GitHub; a request id is applied at most once; nothing is written
// through a link. A push that fails never resets the keeper's copy: its local commits
// stay, the outcomes it already wrote stay valid, and the next round rebases them onto
// GitHub's copy and pushes again. Only when that can't be done (the rebase conflicts, or
// the copy has to be cloned again) is the copy reset, and then the link refuses asks and
// taps until the next push lands (the status file below says so).
// Holds (who holds which item) are the keeper's own: its copy in /data is the one
// that counts, and the record's state/holds.json is put back to it if it drifts.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRequest, plan, hygiene, hygieneReport, clean, expired, idleMs, holdsText, parseHolds, HOLDS_PATH, HOLD_IDLE_MS,
  maxCheckDays, oneOffAudit, ONE_OFF_AUDIT_PATH, ONE_OFF_SUMMARY, PENDING_PATH, upkeep, generationOf, CHECKS_PATH, type OneOff, type WaitTimeout,
  type Downtime, type Holds, type Outcome, type Plan, type Request, type Tree } from "./core.ts";
import { dateHeaderReading, localReadings, verdict, verdictKey, type Reading, type Verdict } from "../clock.ts";

export type Config = {
  remote: string; dir: string; queue: string; outcomes: string; relay: string;
  branch: string; token?: string; hygieneAt: string; tz: string; now?: () => Date;
  holds?: string;   // the keeper's own copy of the holds; default /data/record-holds.json (next to the queue)
  maxCheckDays?: number;   // the App's source_check_max_days (default 7): a check's stale_after, and the Checked cells
  clockSynced?: () => boolean;   // the tests' stand-in for the clock sources: one reading, synced or not
  // The clock sources, given the Date header of this round's GitHub fetch (null: none) and the
  // system time it ended at (default: ../clock.ts, the box's three sources then that header).
  clockReadings?: (dateHeader: string | null, at: number) => Reading[];
  status?: string;         // the keeper's status for the link (default /data/record-ledger.json, next to the queue)
  blockPush?: string;      // the smoke test's switch: while this file exists, a round pushes to a wrong remote (default /data/record-block-push)
  checkin?: string;        // where new audit lines wait for Cain's next check-in (default /data/record-checkin.txt, next to the queue)
  waits?: string;          // the link's wait timeouts (default /data/record-waits.jsonl, next to the queue)
  beforePush?: () => void; // the tests' hook: runs right before the push
};

// Whether the system clock is synchronized by the box's own sources (../clock.ts: the kernel's
// flag first, then timedatectl, then timesyncd's flag file). The keeper's rounds add a fourth,
// GitHub's Date header on their fetch.
export function clockSynced(): boolean {
  return verdict(localReadings()).synced;
}

// The round's clock verdict, from the configured sources.
function clockVerdict(cfg: Config, dateHeader: string | null, at: number): Verdict {
  if (cfg.clockReadings) return verdict(cfg.clockReadings(dateHeader, at));
  if (cfg.clockSynced) {
    let ok = false;
    try { ok = cfg.clockSynced() === true; } catch { ok = false; }
    return verdict([{ source: "kernel", state: ok ? "synced" : "unsynced" }, dateHeaderReading(dateHeader, at)]);
  }
  return verdict([...localReadings(), dateHeaderReading(dateHeader, at)]);
}

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

// trace: the fetch's HTTP exchange is traced (headers only, credentials redacted) so the round
// can read GitHub's Date header; the trace lines are kept out of what this returns.
function git(cfg: Config, args: string[], cwd = cfg.dir, trace?: { date: string | null }): string {
  const env: Record<string, string> = { ...process.env as any, GIT_TERMINAL_PROMPT: "0" };
  if (trace) Object.assign(env, { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1", GIT_TRACE_REDACT: "1" });
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
  if (trace) {
    const lines = out.split("\n"), traced = /^\d\d:\d\d:\d\d\.\d+ /;
    for (const l of lines) { const m = /<= Recv header: date: (.+?)\s*$/i.exec(l); if (m && traced.test(l)) trace.date = m[1]; }
    out = lines.filter((l) => !traced.test(l)).join("\n").trim();
  }
  if (cfg.token) out = out.split(cfg.token).join("<token>");
  if (p.exitCode !== 0) throw new GitError(`git ${args[0]}: ${out.split("\n")[0]}`);
  return out;
}

// The keeper's copy, brought up to GitHub's. Local commits GitHub doesn't have yet (a push
// that failed) are kept and rebased onto what GitHub has; only a rebase that conflicts resets
// the copy to GitHub's (reset says why). A fetch that fails (GitHub down) leaves the copy as
// it is, so local work goes on. date: GitHub's Date header on the fetch (null: none).
type Synced = { date: string | null; fetchedAt: number; cloned: boolean; fetched: boolean; reset: string | null };
function sync(cfg: Config, now: () => number = Date.now): Synced {
  let cloned = false, reset: string | null = null;
  if (!existsSync(join(cfg.dir, ".git"))) {
    mkdirSync(dirname(cfg.dir), { recursive: true });
    rmSync(cfg.dir, { recursive: true, force: true });
    git(cfg, ["clone", "--quiet", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", cfg.remote, cfg.dir], dirname(cfg.dir));
    cloned = true;
  }
  rmSync(join(cfg.dir, ".git", "index.lock"), { force: true });   // left by a restart mid-commit
  if (existsSync(join(cfg.dir, ".git", "rebase-merge")) || existsSync(join(cfg.dir, ".git", "rebase-apply")))
    try { git(cfg, ["rebase", "--abort"]); } catch { /* nothing to abort */ }
  // What a round left half-written (never committed) goes; commits stay.
  git(cfg, ["reset", "--quiet", "--hard", "HEAD"]);
  git(cfg, ["clean", "-qfd"]);
  const trace = { date: null as string | null };
  let fetched = true;
  try { git(cfg, ["fetch", "--quiet", "origin", cfg.branch], cfg.dir, cfg.remote.startsWith("https://") ? trace : undefined); }
  catch (e) { fetched = false; log(`couldn't fetch from GitHub (${(e as Error).message}); working on the local copy`); }
  const fetchedAt = now();
  if (fetched) {
    if (ahead(cfg)) {
      try { git(cfg, ["rebase", "--quiet", `origin/${cfg.branch}`]); }
      catch (e) {
        try { git(cfg, ["rebase", "--abort"]); } catch { /* none in progress */ }
        reset = `its local commits couldn't be rebased onto GitHub's copy (${clean((e as Error).message, 160)})`;
        git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);
        git(cfg, ["clean", "-qfd"]);
      }
    } else git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`]);   // a fast-forward: nothing local is lost
  }
  return { date: trace.date, fetchedAt, cloned, fetched, reset };
}

// The copy has commits GitHub doesn't (as last fetched).
function ahead(cfg: Config): boolean {
  try { git(cfg, ["merge-base", "--is-ancestor", "HEAD", `origin/${cfg.branch}`]); return false; } catch { return true; }
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
  return existsSync(cfg.queue) && jsonNames(cfg.queue).some((n) => !appliedNames.has(n));
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
// What Cain must hear about a request once GitHub has it (its status file, log lines, relayed
// lines), kept across rounds while a push fails.
type Owed = { o: Outcome; local: boolean; relay: string[]; log: string[] };
type State = { holds: Holds; waiting: Waiting[]; alive?: string; downtime: Downtime; pushed?: string;
  generation?: number;                    // the highest ledger generation the keeper has written or seen
  unpushed?: boolean;                     // local commits GitHub doesn't have: the last push failed
  pushFailed?: { at: string; why: string };
  reset?: { at: string; why: string };    // the copy was reset (lost local commits) since the last push that landed
  owed?: Owed[]; clockKey?: string };

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
  const span = (x: any) => x && typeof x.at === "string" && typeof x.why === "string" ? { at: x.at, why: x.why } : undefined;
  const owed = (Array.isArray(j.owed) ? j.owed : []).filter((w: any) => w && w.o && typeof w.o.id === "string" && Array.isArray(w.relay) && Array.isArray(w.log))
    .map((w: any) => ({ o: w.o, local: w.local === true, relay: w.relay.map(String), log: w.log.map(String) }));
  const pushFailed = span(j.pushFailed), reset = span(j.reset);
  return { holds, waiting, alive: typeof j.alive === "string" ? j.alive : undefined, downtime,
    ...(typeof j.pushed === "string" && /^[0-9a-f]{40}$/.test(j.pushed) ? { pushed: j.pushed } : {}),
    ...(Number.isInteger(j.generation) && j.generation > 0 ? { generation: j.generation } : {}),
    ...(j.unpushed === true ? { unpushed: true } : {}), ...(pushFailed ? { pushFailed } : {}), ...(reset ? { reset } : {}),
    ...(owed.length ? { owed } : {}), ...(typeof j.clockKey === "string" ? { clockKey: j.clockKey } : {}) };
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

// An item passed to Cain is his from now on, and he hears it at once, with the notes
// the same request left on it: a laptop's pull request goes to Dane's Ship card that
// way, without waiting for a check-in.
export function passLines(req: Request, o: Outcome): string[] {
  if (o.from === "cain") return [];
  const ops: any[] = Array.isArray(req.ops) ? req.ops : [];
  return ops.filter((p) => p?.op === "pass" && p.to === "cain").map((p) => {
    const notes = ops.filter((n) => n?.op === "note" && n.item === p.item && typeof n.text === "string").map((n) => clean(n.text, MAX_NOTE));
    const said = notes.length ? ` Its note: «${notes.join(" ")}»` : "";
    return `${o.from} passed ${clean(p.item, 20)} to you (request ${o.id}): it's yours now.${said} Read its notes with /opt/cain/record.sh notes ${clean(p.item, 20)} before you act on it.`;
  });
}

const message = (o: Outcome) => o.state === "done"
  ? `${o.summary} (request ${o.id}, from ${o.from})`
  : `Request ${o.id} ${o.state}: ${o.reason ?? "relayed to Cain"}`;

// What Cain must hear about a request once GitHub has it, worked out when it is applied (the
// request itself isn't kept) and delivered by deliver() after the push lands.
function owe(o: Outcome, local: boolean, req: Request | undefined, unreadable: boolean): Owed {
  const lines: string[] = [], logs: string[] = [];
  const relay = (_cfg: unknown, text: string) => { lines.push(text); };
  const log = (text: string) => { logs.push(text); };
  const cfg = null;
  log(`${o.id} from ${o.from}: ${o.state}${o.reason ? ` (${o.reason})` : ""}`);
  if (o.state === "done") {
    if (req) for (const line of passLines(req, o)) relay(cfg, line);
    // Applied, with rows left out (a whole-file write with a bundled row): the writer hears which.
    if (!o.reason) { /* nothing more */ }
    else if (local) relay(cfg, `Your record change ${o.id} ("${o.summary}") was applied, but: ${o.reason}. Fix those rows and send them again.`);
    else if (o.from === "page") relay(cfg, `A change Dane made on his page (${o.id}, "${o.summary}") was saved, but: ${o.reason}. Apply what he meant yourself, one fact per row.`);
    else log(`inbox request ${o.id} from ${o.from} left rows out; recorded in log/requests`);
  } else if (o.state === "relayed" && req?.note) {
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
  return { o, local, relay: lines, log: logs };
}

// Once GitHub has it: the status file for Cain's own requests, and what Cain must hear.
function deliver(cfg: Config, w: Owed) {
  // Status files are for Cain's own requests, so an inbox file can't overwrite one.
  if (w.local) { mkdirSync(cfg.outcomes, { recursive: true }); writeFileSync(outcomeFile(cfg, w.o.id), JSON.stringify(w.o)); }
  for (const l of w.log) log(l);
  for (const t of w.relay) relay(cfg, t);
}

// One pass: apply everything waiting, one commit per request, then push once. If the push
// fails (a lost race, GitHub down or refusing), the local commits stay: the outcomes already
// written stand, and the push is tried again, after rebasing onto GitHub's copy, within this
// round when GitHub answers and otherwise on the next round. Nothing leaves a queue until
// GitHub has the commit.
export function cycle(cfg: Config): { applied: number; ok: boolean; pushFailed?: boolean } {
  const clock = () => cfg.now?.() ?? new Date();
  let st: State | undefined;
  let cv: Verdict | undefined;
  let was: { alive?: string; downtime: Downtime } = { downtime: [] };
  const unlanded = (x: State) => JSON.stringify({ ...x, alive: was.alive, downtime: was.downtime });
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();   // the round's own time (not the record's clock), for round_ms
    let items: Pending[] = [];
    const outcomes: (Outcome | null)[] = [];
    let book = new Map<string, Outcome>();
    let synced0: Synced;
    try {
      synced0 = sync(cfg, () => clock().getTime());
      st = loadState(cfg);
      // A reset of the copy (a rebase that conflicted, or a copy cloned again after the keeper
      // had written a ledger): lost local commits. Asks and taps wait for the next push.
      const lost = synced0.reset ?? (synced0.cloned && ((st.generation ?? 0) > 0 || st.unpushed) ? "the keeper's copy of the record was missing and was cloned again from GitHub" : null);
      if (lost) resetCopy(cfg, st, lost, clock());
      // A round counts as the keeper working only once its push lands: until then the state
      // is saved with the last good round's time, so a push outage is downtime.
      was = { alive: st.alive, downtime: [...st.downtime] };
      beat(st, clock());
      cv = clockVerdict(cfg, synced0.date, synced0.fetchedAt);
      if (cv.synced !== true) cv = { ...cv, synced: false };
      noteClock(st, cv);
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
      const S = st;
      // The ledger's generation never comes down: each write is one above both the file's and
      // the keeper's own count.
      const generation = () => Math.max(S.generation ?? 0, generationOf(t.read(CHECKS_PATH)));
      const ctx = (at: Date) => ({ at, holds: S.holds, downtime: S.downtime, tz: cfg.tz, maxCheckDays: maxCheckDays(cfg.maxCheckDays),
        clockSynced: cv!.synced, ...(cv!.source ? { clockSource: cv!.source } : { clockWhy: cv!.diagnostic }), generation: generation() });
      const outcomeOf = (req: Request, at: Date) => ({ id: req.id, from: clean(req.from, 80), kind: req.kind, summary: clean(req.summary, 200), at: at.toISOString() });
      // A planned change: its files, then its holds. A failed write, the holds' included,
      // undoes this request only; the others stand.
      const apply = (p: Extract<Plan, { state: "ok" }>, base: Omit<Outcome, "state">): Outcome => {
        if ([...p.writes.keys()].some((path) => !linkFree(cfg, path))) return { ...base, state: "rejected", reason: "writes through a link" };
        try {
          for (const [path, content] of p.writes) {
            const f = join(cfg.dir, path);
            if (content === null) rmSync(f, { force: true });
            else writeWhole(f, content);
          }
          if (p.holdsChanged) publish(cfg, p.holds);
        } catch (e) {
          undo();
          return { ...base, state: "rejected", reason: clean(`couldn't write: ${(e as Error).message}`) };
        }
        if (p.holdsChanged) S.holds = p.holds;
        return { ...base, state: "done" };
      };
      // The keeper's own files written alongside a refusal (the ledger's pending rewrite).
      const side = (writes: Map<string, string | null>) => {
        if ([...writes.keys()].some((path) => !linkFree(cfg, path))) return;
        try { for (const [path, content] of writes) if (content !== null) writeWhole(join(cfg.dir, path), content); }
        catch (e) { undo(); log(`couldn't write the ledger with a refusal: ${(e as Error).message}`); }
      };
      const decide = (req: Request, local: boolean, base: Omit<Outcome, "state">): Outcome => {
        const p = plan(req, t, ctx(new Date(base.at)));
        if (p.state === "ok") {
          for (const w of p.warnings ?? []) log(`warning: ${req.id}: ${clean(w, 200)}`);
          const o = apply(p, base);
          if (o.state === "done" && p.declared) { log(`one-off ${req.id} re-declared: ${clean(p.declared, 300)}`); o.declared = p.declared; }
          return o.state === "done" && p.errors?.length ? { ...o, reason: clean(p.errors.join("; "), 600) } : o;
        }
        if (p.state === "waiting") S.waiting.push({ req, since: base.at, local });
        if (p.writes) side(p.writes);
        // Refusals of source checks and one-offs, in the keeper's log too, for tuning the rules.
        if (req.ops?.some((o) => o.op === "check" || o.op === "one-off")) log(`refused for tuning: ${req.id}: ${clean(p.reason, 400)}`);
        return { ...base, state: p.state, reason: clean(p.reason, 600) };
      };
      const owed: Owed[] = [];
      // Takes waiting behind one of Cain's jobs, planned again now; in the order they came.
      const settle = () => {
        for (let i = 0; i < S.waiting.length;) {
          const w = S.waiting[i], at = clock();
          const p = plan(w.req, t, ctx(at));
          const waited = idleMs({ renewed: w.since } as any, at, S.downtime);
          if (p.state === "waiting" && waited <= HOLD_IDLE_MS) { i++; continue; }
          S.waiting.splice(i, 1);
          const base = outcomeOf(w.req, at);
          const o: Outcome = p.state === "ok" ? apply(p, base)
            : p.state === "waiting" ? { ...base, state: "refused", reason: clean(`waited a day: ${p.reason}`) }
            : { ...base, state: p.state, reason: clean(p.reason) };
          logOutcome(cfg, o);
          o.commit = commit(message(o));
          owed.push(owe(o, w.local, w.req, false));
        }
      };
      // The keeper's own copy of the holds into the record. If that can't be written
      // the round goes on: the next round tries again.
      const republish = (msg: string) => {
        try { publish(cfg, S.holds); commit(msg); }
        catch (e) { undo(); log(`couldn't publish the holds (${(e as Error).message}); trying again next round`); }
      };

      // Holds that went a day without a word from their holder end.
      const now = clock();
      const ended = Object.keys(S.holds).filter((k) => expired(S.holds[k], now, S.downtime));
      if (ended.length) {
        const who = ended.map((k) => `${k} (${S.holds[k].holder})`).join(", ");
        for (const k of ended) delete S.holds[k];
        republish(`Holds: ${who} ended after a day without a word from the holder`);
      }
      if (S.waiting.length) settle();
      // The ledger kept in step: rows changed outside the keeper get a new version, checks
      // past their stale_after are aged out (only while the clock is synchronized), and checks
      // dated later than the clock now reads (it stepped back) never count again.
      try {
        const u = upkeep(t, { at: now, tz: cfg.tz, maxCheckDays: maxCheckDays(cfg.maxCheckDays), clockSynced: cv.synced, generation: generation() });
        if (u && [...u.writes.keys()].every((path) => linkFree(cfg, path))) {
          for (const [path, content] of u.writes) writeWhole(join(cfg.dir, path), content);
          const what = [...(u.bumped.length ? [`${u.bumped.join(", ")} changed outside the keeper`] : []), ...(u.aged.length ? [`${u.aged.join(", ")} aged out`] : []),
            ...(u.stepped.length ? [`${u.stepped.join(", ")} dated after the clock stepped back`] : [])];
          if (u.stepped.length) log(`the clock reads earlier than the source checks on ${u.stepped.join(", ")}: they no longer count`);
          commit(`Source checks: ${what.join("; ")}`);
        }
      } catch (e) { undo(); log(`couldn't keep the ledger in step (${(e as Error).message}); trying again next round`); }
      // The record's copy is the keeper's: put back if anyone else changed it.
      const published = publishedHolds(cfg);
      if (published === null ? Object.keys(S.holds).length > 0 : published !== holdsText(S.holds))
        republish(`Holds: ${HOLDS_PATH} put back to the keeper's copy`);

      for (const it of items) {
        const at = clock();
        const id = it.req?.id ?? `unreadable-${it.name}`;
        // Cain's request already applied (in a round whose push hasn't landed yet, or whose
        // reply was lost, or before a restart): never apply twice.
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
        owed.push(owe(o, !!it.local, it.req, !!it.error));
        // A hold that ended or moved may let a waiting take through, before anything newer.
        if (o.state === "done" && S.waiting.length) settle();
      }
      // The one-off audit: the past week's one-offs matched loosely against the open rows, and
      // the link's wait and tap timeouts.
      if (items.length) audit(cfg, clock(), commit);
      // The link's own requests (a source check, a one-off) have their outcome now, once the
      // local commit and the ledger are written: the link waits on this, never on the push
      // below. round_ms is this round's local work, up to here. Cain's other requests still
      // hear done only once GitHub has them (deliver, after the push).
      const round_ms = Math.round(performance.now() - started);
      const waited = waitsBy(cfg);
      const linkOwn = (req?: Request) => !!req?.ops?.some((o) => o.op === "check" || o.op === "one-off");
      items.forEach((it, i) => { const o = outcomes[i]; if (o && it.local && linkOwn(it.req)) local(cfg, o, round_ms, waited); });
      S.generation = generation();
      S.owed = [...(S.owed ?? []), ...owed];
      if (commits === 0 && !ahead(cfg)) {
        // Nothing to push: a good round all the same, in step with GitHub as last fetched.
        // Cain's requests that were already applied are let go, with their status file if it
        // was never written.
        if (synced0.fetched) landed(cfg, S, clock());
        finish(cfg, S, items, outcomes, book);
        writeStatus(cfg, S, cv, clock());
        return { applied: items.length, ok: true };
      }
      // Saved before the push: the holds and the ledger's generation are the local commits'.
      writeAtomic(stateFile(cfg), unlanded(S));
      appliedNames = new Set(items.filter((it) => it.local).map((it) => it.name));
    } catch (e) {
      log(`stopped this round, nothing let go: ${(e as Error).message}`);
      if (st && cv) writeStatus(cfg, st, cv, clock());
      return { applied: 0, ok: false };
    }
    let why = "";
    try {
      cfg.beforePush?.();
      const blocked = blockFile(cfg);
      if (existsSync(blocked)) {
        log("the smoke test's push block is on: pushing to a wrong remote this round");
        git(cfg, ["push", "--quiet", join(cfg.dir, ".git", "no-such-remote.git"), `HEAD:${cfg.branch}`]);
      } else git(cfg, ["push", "--quiet", "origin", `HEAD:${cfg.branch}`]);
    } catch (e) { why = (e as Error).message; }
    if (why) {
      // A lost race, or a push GitHub refused or never answered. Confirm before deciding.
      let answered = true;
      try { git(cfg, ["fetch", "--quiet", "origin", cfg.branch]); } catch { answered = false; }
      if (!answered || ahead(cfg)) {
        st!.unpushed = true;
        if (!st!.pushFailed) log(`push didn't land (${clean(why, 200)}); the local commits stay and their outcomes stand`);
        st!.pushFailed = { at: clock().toISOString(), why: clean(why, 200) };
        writeAtomic(stateFile(cfg), unlanded(st!));
        writeStatus(cfg, st!, cv!, clock());
        // GitHub answered (a lost race): rebase and try again now. Otherwise the next round.
        if (answered && !existsSync(blockFile(cfg)) && attempt < 2) continue;
        if (existsSync(blockFile(cfg))) rmSync(blockFile(cfg), { force: true });
        return { applied: items.length, ok: false, pushFailed: true };
      }
    }
    // GitHub has it: the holds and waiting takes are saved, the requests can go,
    // and Cain hears what needs him.
    landed(cfg, st!, clock());
    finish(cfg, st!, items, outcomes, book);
    rmSync(`${stateFile(cfg)}.next`, { force: true });
    writeStatus(cfg, st!, cv!, clock());
    return { applied: items.length, ok: true };
  }
  log("gave up this round after three tries; the local commits stay, and the next round pushes them");
  return { applied: 0, ok: false, pushFailed: true };
}

// Local queue files already applied in a round whose push hasn't landed: they don't call for
// another round by themselves (the next minute's round pushes them).
let appliedNames = new Set<string>();

const blockFile = (cfg: Config) => cfg.blockPush ?? join(dirname(cfg.queue), "record-block-push");
const statusFile = (cfg: Config) => cfg.status ?? join(dirname(cfg.queue), "record-ledger.json");

// A whole file, written so a reader sees the old one or the new one, never half of it.
function writeWhole(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// The push landed (or there was nothing to push and the copy is GitHub's): what was owed is
// delivered, and the copy is in step again.
function landed(cfg: Config, st: State, now: Date) {
  st.pushed = git(cfg, ["rev-parse", "HEAD"]);
  if (st.unpushed || st.pushFailed) log("push landed: GitHub has the keeper's local commits");
  if (st.reset) log("the copy is in step with GitHub again after its reset; asks and taps go on");
  delete st.unpushed; delete st.pushFailed; delete st.reset;
  appliedNames = new Set();
  for (const w of st.owed ?? []) deliver(cfg, w);
  delete st.owed;
  void now;
}

// The copy was reset: its local commits are gone. Requests still queued run again; Cain hears
// about the others, which may not have reached GitHub. The link refuses asks and taps until the
// next push lands.
function resetCopy(cfg: Config, st: State, why: string, now: Date) {
  st.reset = { at: now.toISOString(), why: clean(why, 240) };
  log(`reset: ${why}; asks and taps are refused until the next push to GitHub lands`);
  const queued = new Set<string>();
  for (const p of pending(cfg)) if (p.req) queued.add(p.req.id);
  // Those still queued are applied again, and owed again then.
  const lost = (st.owed ?? []).filter((w) => !queued.has(w.o.id));
  st.owed = [];
  if (lost.length) relay(cfg, `The record keeper had to reset its copy of the record (${clean(why, 160)}). These changes may not have reached GitHub: ${lost.map((w) => w.o.id).join(", ")}. Check each in /data/record and send it again if it's missing.`);
  delete st.unpushed;
  writeAtomic(stateFile(cfg), JSON.stringify(st));
}

// The clock's verdict changed (synchronized or not, by which source, each source's state):
// one log line naming what each source returned, instead of a refusal per check.
function noteClock(st: State, v: Verdict) {
  const key = verdictKey(v);
  if (st.clockKey === key) return;
  st.clockKey = key;
  log(v.synced ? `clock: ${v.diagnostic}` : `clock: not synchronized, so no source check is taken: ${v.diagnostic}`);
}

// The keeper's status for the link (written whole, every round): the ledger's generation, whether
// local commits wait for a push (and the last push error), whether the copy was reset since the
// last push landed, and the clock's verdict with the source that satisfied it.
function writeStatus(cfg: Config, st: State, v: Verdict, now: Date) {
  try {
    writeAtomic(statusFile(cfg), JSON.stringify({
      at: now.toISOString(), generation: st.generation ?? 0, unpushed: st.unpushed === true,
      ...(st.pushFailed ? { push_failed: st.pushFailed } : {}), ...(st.reset ? { reset: st.reset } : {}),
      clock: { synced: v.synced, source: v.source, diagnostic: v.diagnostic, at: now.toISOString() },
    }) + "\n");
  } catch (e) { log(`couldn't write the status for the link: ${(e as Error).message}`); }
}

// The past week's one-off asks (from log/requests) against the open rows, loosely: hits go
// to the keeper's log and to state/one-off-audit.md, which Cain reads. Written only when it
// changes. A failure here never stops the round.
function audit(cfg: Config, now: Date, commit: (msg: string) => string | undefined) {
  try {
    const oneOffs: OneOff[] = [];
    for (const o of logbook(cfg).values())
      if (o.id.startsWith("link-oneoff-") && o.state === "done" && o.summary.startsWith(ONE_OFF_SUMMARY))
        oneOffs.push({ id: o.id, at: o.at, text: o.summary.slice(ONE_OFF_SUMMARY.length), ...(o.declared ? { declared: o.declared } : {}) });
    const waits: WaitTimeout[] = [...waitsBy(cfg).values()].map((w) => ({ ...w, round_ms: w.kind === "tap" ? null : roundOf(cfg, w.id) }));
    const p = join(cfg.dir, PENDING_PATH), f = join(cfg.dir, ONE_OFF_AUDIT_PATH);
    const pending = existsSync(p) ? readFileSync(p, "utf8") : null;
    const was = existsSync(f) ? readFileSync(f, "utf8") : null;
    if (!oneOffs.length && !waits.length && was === null) return;
    const a = oneOffAudit(oneOffs, pending, now, cfg.tz, waits);
    if (a.text === was) return;
    // Lines not in the file before reach Cain at his next check-in (checkin.sh reads them).
    const fresh = a.hits.filter((h) => !(was ?? "").includes(`- ${h}\n`));
    for (const h of fresh) log(`one-off audit: ${clean(h, 300)}`);
    if (fresh.length) appendFileSync(checkinFile(cfg), fresh.map((h) => clean(h, 400)).join("\n") + "\n");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, a.text);
    commit(`One-off audit: ${a.hits.length} to look over`);
  } catch (e) {
    log(`one-off audit didn't finish: ${(e as Error).message}`);
  }
}

const checkinFile = (cfg: Config) => cfg.checkin ?? join(dirname(cfg.queue), "record-checkin.txt");
const waitsFile = (cfg: Config) => cfg.waits ?? join(dirname(cfg.queue), "record-waits.jsonl");

// The link's wait timeouts (one JSON line each: id, at, waited_ms), by request id. The audit
// counts the past week's.
function waitsBy(cfg: Config): Map<string, Omit<WaitTimeout, "round_ms">> {
  const out = new Map<string, Omit<WaitTimeout, "round_ms">>();
  const f = waitsFile(cfg);
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    try {
      const w = JSON.parse(line);
      if (typeof w?.id === "string" && typeof w.at === "string" && !Number.isNaN(Date.parse(w.at)) && Number.isFinite(w.waited_ms))
        out.set(w.id, { id: clean(w.id, 80), at: w.at, waited_ms: Number(w.waited_ms), ...(w.kind === "tap" ? { kind: "tap" as const } : {}) });
    } catch { /* skip */ }
  }
  return out;
}
// The keeper's local time for a request's round, from its outcome file (null: none yet).
function roundOf(cfg: Config, id: string): number | null {
  try { const o = JSON.parse(readFileSync(outcomeFile(cfg, id), "utf8")); return Number.isFinite(o?.round_ms) ? o.round_ms : null; }
  catch { return null; }
}
// One of Cain's own requests, settled locally: its outcome file, before the push. A request
// the link gave up waiting on is logged with this round's time.
function local(cfg: Config, o: Outcome, round_ms: number, waited: Map<string, Omit<WaitTimeout, "round_ms">>) {
  o.round_ms = round_ms;
  mkdirSync(cfg.outcomes, { recursive: true });
  writeFileSync(outcomeFile(cfg, o.id), JSON.stringify(o));
  const w = waited.get(o.id);
  if (w) log(`wait timeout: ${o.id} was refused by the link after ${w.waited_ms} ms; its round's local work took ${round_ms} ms (${o.state})`);
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
    // Local commits waiting for a push are the rounds' to push (and to rebase, or reset with
    // the link told): the check waits for them.
    if (existsSync(join(cfg.dir, ".git")) && ahead(cfg)) { log("nightly check waits: local commits are waiting for a push"); return false; }
    const synced = sync(cfg);
    if (synced.reset || !synced.fetched) { log("nightly check waits: the copy isn't in step with GitHub"); return false; }
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
      let ok = false, local = false;
      try { const r = run(cfg); ok = r.ok; local = (r as any).pushFailed === true; } catch (e) { log(`cycle error: ${e}`); }
      due = clock() + fullMs;
      // A round whose local work was done but whose push failed doesn't pause Cain's queue: new
      // requests still get their local outcome at once (and each tries the push again).
      paused = !ok && !local;
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
    maxCheckDays: maxCheckDays(process.env.SOURCE_CHECK_MAX_DAYS),
    checkin: process.env.RECORD_CHECKIN ?? "/data/record-checkin.txt",
    waits: process.env.RECORD_WAITS ?? "/data/record-waits.jsonl",
    status: process.env.RECORD_STATUS ?? "/data/record-ledger.json",
    blockPush: process.env.RECORD_BLOCK_PUSH ?? "/data/record-block-push",
  };
  delete process.env.RECORD_TOKEN;   // kept only in cfg, handed to git per call
  if (!cfg.token) {
    log("no GitHub token in the add-on's options yet; the record keeper is waiting");
    while (true) await Bun.sleep(3_600_000);
  }
  log("keeping the record");
  await keep(cfg, { fullMs: Number(process.env.RECORD_INTERVAL_S ?? 60) * 1000, pollMs: Number(process.env.RECORD_POLL_MS ?? 2000) });
}
