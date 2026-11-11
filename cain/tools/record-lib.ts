// What the laptop's record tools share (record-preflight, record-send, record-holds,
// record-prepush). Laptop only: nothing in cain/tools/ ships in the App.
// - The record as the keeper will see it: a clone's upstream (normally origin/main),
//   read from git objects after a fetch, so line endings and a stale checkout don't matter.
// - The keeper's own checks on a request, in its order.
// - Sending a request into the record's inbox as one commit on top of the upstream,
//   without touching the clone's working tree or index, and finding its outcome.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseRequest, plan, parseHolds, changedRows, noteRows, notesPath, HOLDS_PATH, PENDING_PATH,
  type Holds, type Note, type Outcome, type Request, type Tree } from "../rootfs/opt/cain/record/core.ts";

export type Clone = { dir: string; remote: string; branch: string; ref: string };

export function git(dir: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8", maxBuffer: 64 << 20, input: o.input,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
  } catch { return null; }
}

// The record's main is the only branch the keeper reads, so a clone tracking any
// other branch would read the wrong holds and send to the wrong inbox.
export function clone(dir: string | undefined): Clone | { error: string } {
  if (!dir) return { error: "no clone of the record: set RECORD_CLONE, or pass --record <clone>" };
  const up = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim();
  if (!up || !up.includes("/")) return { error: `${dir} isn't a clone of the record on a branch with an upstream (main)` };
  const slash = up.indexOf("/");
  const c = { dir, remote: up.slice(0, slash), branch: up.slice(slash + 1), ref: up };
  if (c.branch !== "main") return { error: `${dir} follows ${up}, not the record's main` };
  return c;
}

export const fetch = (c: Clone) => git(c.dir, ["fetch", "-q", c.remote, c.branch]) !== null;

export function treeAt(c: Clone): Tree {
  const kind = (p: string) => git(c.dir, ["cat-file", "-t", `${c.ref}:${p}`])?.trim() ?? null;
  return {
    read: (p) => (kind(p) === "blob" ? git(c.dir, ["cat-file", "blob", `${c.ref}:${p}`]) : null),
    sha: (p) => (kind(p) === "blob" ? git(c.dir, ["rev-parse", `${c.ref}:${p}`])?.trim() ?? null : null),
    isDir: (p) => kind(p) === "tree",
    blob: (sha) => (/^[0-9a-f]{40}$/.test(sha) ? git(c.dir, ["cat-file", "blob", sha]) : null),
  };
}

// Who holds what, as the keeper last pushed it.
export const holdsAt = (c: Clone): Holds => parseHolds(treeAt(c).read(HOLDS_PATH)) ?? {};

function logLines(c: Clone, lastFiles?: number): any[] {
  let files = (git(c.dir, ["ls-tree", "--name-only", c.ref, "log/requests/"]) ?? "").split("\n").filter((n) => n.endsWith(".jsonl")).sort();
  if (lastFiles) files = files.slice(-lastFiles);
  const out: any[] = [];
  for (const f of files)
    for (const line of (git(c.dir, ["cat-file", "blob", `${c.ref}:${f}`]) ?? "").split("\n")) {
      try { const o = JSON.parse(line); if (o && typeof o === "object") out.push(o); } catch { /* skip */ }
    }
  return out;
}

// Every outcome logged for a request, oldest first (a take behind a job has two).
export const outcomes = (c: Clone, id: string): Outcome[] => logLines(c, 2).filter((o) => o.id === id);

// Takes from a sender still waiting behind one of Cain's jobs.
export function waitingFrom(c: Clone, from: string): Outcome[] {
  const last = new Map<string, Outcome>();
  for (const o of logLines(c, 2)) if (o.from === from) last.set(o.id, o);
  return [...last.values()].filter((o) => o.state === "waiting");
}

export type Check = { state: "ok" | "waiting" | "conflict" | "rejected" | "refused"; line: string; req?: Request };

// The keeper's own checks on an inbox request, in its order (record/main.ts): size,
// shape, sender, id, then the plan against the record and its holds as they stand.
export function check(raw: string, c: Clone, at = new Date()): Check {
  if (Buffer.byteLength(raw) > 1_000_000) return { state: "rejected", line: "rejected: over 1 MB" };
  const { req, error } = parseRequest(raw);
  if (error || !req) return { state: "rejected", line: `rejected: ${error}`, req };
  if (req.from === "cain" || req.id.startsWith("cain-")) return { state: "rejected", line: "rejected: requests in inbox/ can't speak for Cain", req };
  if (req.kind === "note" && req.from !== "page") return { state: "rejected", line: "rejected: notes come only from Dane's page", req };
  if (logLines(c).some((o) => o.id === req.id)) return { state: "rejected", line: "rejected: an id that was already used", req };
  if (req.kind === "note") return { state: "ok", line: "ok: a note for Cain", req };
  const out = plan(req, treeAt(c), { at, holds: holdsAt(c) });
  if (out.state !== "ok") return { state: out.state, line: `${out.state}: ${out.reason}`, req };
  const parts = [...out.writes.keys()];
  if (out.holdsChanged) parts.push(`${HOLDS_PATH} (the keeper's)`);
  return { state: "ok", line: `ok: writes ${parts.join(", ")}`, req };
}

// One file into the record's inbox: a commit on top of the upstream, made in a
// throwaway index, pushed. A push that loses a race is made again on the new top.
export function send(c: Clone, name: string, text: string, message: string): { commit: string } | { error: string } {
  const index = join(tmpdir(), `record-send-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    for (let i = 0; i < 5; i++) {
      if (i > 0 && !fetch(c)) return { error: "couldn't fetch the record" };
      const blob = git(c.dir, ["hash-object", "-w", "--stdin"], { input: text })?.trim();
      const parent = git(c.dir, ["rev-parse", c.ref])?.trim();
      if (!blob || !parent) return { error: "couldn't write the request into the clone" };
      rmSync(index, { force: true });
      if (git(c.dir, ["read-tree", parent], { env }) === null
        || git(c.dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},inbox/${name}`], { env }) === null)
        return { error: "couldn't stage the request" };
      const tree = git(c.dir, ["write-tree"], { env })?.trim();
      const commit = tree ? git(c.dir, ["commit-tree", tree, "-p", parent, "-m", message])?.trim() : null;
      if (!commit) return { error: "couldn't make the commit (are user.name and user.email set in the clone?)" };
      if (git(c.dir, ["push", "-q", c.remote, `${commit}:refs/heads/${c.branch}`]) !== null) {
        fetch(c);
        return { commit };
      }
    }
    return { error: "the push kept losing to other pushes; try again" };
  } finally { rmSync(index, { force: true }); }
}

// Watches log/requests until the request has a final outcome, or time runs out.
// Calls back once if it is first logged as waiting.
export async function waitFor(c: Clone, id: string, ms: number, onWaiting?: (o: Outcome) => void): Promise<Outcome[]> {
  const poll = Number(process.env.RECORD_SEND_POLL_MS ?? 5_000);
  const until = Date.now() + ms;
  let told = false, seen: Outcome[] = [];
  while (true) {
    if (fetch(c)) {
      seen = outcomes(c, id);
      const last = seen[seen.length - 1];
      if (last?.state === "waiting" && !told) { told = true; onWaiting?.(last); }
      if (last && last.state !== "waiting") return seen;
    }
    if (Date.now() + poll > until) return seen;
    await Bun.sleep(poll);
  }
}

// This Claude Code session's id: Claude Code sets CLAUDE_CODE_SESSION_ID in every
// Bash command and hook it runs (and so in git and its hooks).
export function sessionOf(given?: string | null): string | null {
  const s = given ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
}

// --name value flags and bare --switches; the rest are positional.
export function args(argv: string[], valued: string[]): { _: string[]; [k: string]: any } {
  const out: { _: string[]; [k: string]: any } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) out._.push(argv[i]);
    else if (valued.includes(m[1])) out[m[1]] = argv[++i];
    else out[m[1]] = true;
  }
  return out;
}

// A small per-session memo kept in the clone's .git folder: what the session held
// when it last looked, when it last renewed and fetched, and per item which notes it
// has been shown (by a hash of each, so equal times or a clock step can't hide one).
export type Memo = { held: string[]; renewed: number; fetched: number; seen: Record<string, string[]> };
export function memo(c: Clone, session: string): { read(): Memo; write(m: Memo): void } {
  const gitDir = git(c.dir, ["rev-parse", "--git-dir"])?.trim() ?? ".git";
  const file = join(isAbsolute(gitDir) ? gitDir : join(c.dir, gitDir), "record-holds", `${session}.json`);
  return {
    read: () => {
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        const seen: Record<string, string[]> = {};
        if (j.seen && typeof j.seen === "object") for (const [k, v] of Object.entries(j.seen)) if (Array.isArray(v)) seen[k] = v.map(String);
        return { held: Array.isArray(j.held) ? j.held : [], renewed: +j.renewed || 0, fetched: +j.fetched || 0, seen };
      } catch { return { held: [], renewed: 0, fetched: 0, seen: {} }; }
    },
    write: (m) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(m)); },
  };
}

// Notes on the session's own held items that it hasn't been shown yet; on an item it
// has just come to hold, all of them, older ones included. Marks them seen in the
// memo given.
const noteKey = (n: Note) => createHash("sha1").update(`${n.when}\n${n.from}\n${n.text}`).digest("hex").slice(0, 16);
export function freshNotes(c: Clone, me: string, holds: Holds, items: Iterable<string>, m: Memo): { id: string; notes: Note[] }[] {
  const t = treeAt(c), out: { id: string; notes: Note[] }[] = [];
  for (const id of new Set(items)) {
    const h = holds[id];
    if (!h || h.holder !== me) continue;
    const all = noteRows(t.read(notesPath(id)));
    const shown = new Set(m.seen[id] ?? []);
    const notes = all.filter((n) => !shown.has(noteKey(n)));
    m.seen[id] = all.map(noteKey);
    if (notes.length) out.push({ id, notes });
  }
  return out;
}

// The items a request would touch: those its ops name, and the rows a put of the
// open list changes.
export function itemsOf(req: any, t: Tree): string[] {
  const out = new Set<string>();
  for (const o of Array.isArray(req?.ops) ? req.ops : []) {
    if (typeof o?.item === "string") out.add(o.item.toUpperCase());   // as the keeper reads ids
    if (o?.op === "put" && o.path === PENDING_PATH && typeof o.content === "string")
      for (const id of changedRows(t.read(PENDING_PATH), o.content)) out.add(id);
  }
  return [...out];
}

export const noteLines = (fresh: { id: string; notes: Note[] }[]): string[] => fresh.flatMap(({ id, notes }) => [
  `New notes on ${id} since you last looked. Read them before you change ${id}:`,
  ...notes.map((n) => `- ${when(n.when)}, from ${n.from}: ${n.text}`),
]);

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
