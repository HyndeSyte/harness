// The review-round cap (Cain 0.16.0). The owner's rule since Nov 17, 2026: a piece of work gets at
// most three outside review rounds, never a fourth (since Nov 26 the rest is R-013, below). Kept here, in the runner (root), where
// Cain can't change it: the cap is the App's option `review_round_cap` (default 3), read by the run
// script from /data/options.json (root's) into the runner's environment only.
//
// Rounds are kept per change in /data/review-rounds.json, written only by the runner (root:cain
// 0640: review.sh reads it for `spend`, the link for the Ship card). A change's key is "pr-<number>"
// for a pull request, or the brief's `change` key; a brief may name `supersedes` (an earlier key or
// pull request), and every key linked that way is one group whose rounds count together, so neither a
// new id nor a replacement pull request starts the count again. A round blocked for privacy sent
// nothing and doesn't count.
//
// Round 2: each round is kept as started (at intake, before it runs), then answered, or lost: ended
// without a result (every seat failed, or a crash recovered at the runner's start, where the round was
// counted but its review never made it to the queue). A lost round still counts (the count stays
// conservative).
//
// Cain 0.20.0, the owner's review rule (R-013): three rounds a piece, never more, and no card offers more
// rounds or a ship with a risk named (the grants of extra rounds and the decision card are retired). After
// the cap's last round: nothing serious left, the normal Ship card; something serious left, Cain either
// holds the piece or cuts the parts the serious findings are about, and one outside model that did not write
// the cut checks the cut diff (a cut check, kept under the change as `cut`): not a round, never a second.
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeKeyOf, keyOfRef, type Brief, type RoundKind } from "./core.ts";

export const DEFAULT_ROUND_CAP = 3;
export const ROUNDS_FORMAT = 1;

export type RoundState = "started" | "answered" | "lost";
export type RoundRec = { id: string; at: string; kind: RoundKind; state?: RoundState; blocked?: boolean; done?: boolean; serious?: number };
// The one cut check of a change at its cap (0.20.0): its review id, the cut head it checked, the seat, and
// how it ended (pass or fail; lost when its seat never answered). One a change group, for good.
export type CutRec = { id: string; at: string; head: string; pr: string; seat: string; state: "started" | "pass" | "fail" | "lost" };
// decision and past: written by the retired decision card (0.16.0 to 0.19.0), read nowhere now.
export type ChangeRec = { rounds: RoundRec[]; links?: string[]; pr?: string; topic?: string; cut?: CutRec; decision?: unknown; past?: unknown };
export type Rounds = { format: number; changes: Record<string, ChangeRec> };

export const emptyRounds = (): Rounds => ({ format: ROUNDS_FORMAT, changes: {} });

// Read whole, or null when the file is there and can't be read or doesn't parse (the caller fails
// closed); a file not there yet is empty.
export function readRounds(path: string): Rounds | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? emptyRounds() : null; }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || j.format !== ROUNDS_FORMAT || !j.changes || typeof j.changes !== "object") return null;
    return j as Rounds;
  } catch { return null; }
}

// Written whole (temp file, rename), keeping the file's owner and mode as the runner's other files do.
export function writeRounds(path: string, r: Rounds): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.rounds-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(r, null, 1), { mode: 0o640 });
  try { const s = statSync(path); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* a new file */ }
  renameSync(tmp, path);
}

// Every key linked to this one by supersedes, either way, itself included.
export function groupOf(r: Rounds, key: string): string[] {
  const seen = new Set<string>([key]);
  const todo = [key];
  while (todo.length) {
    const k = todo.pop()!;
    const near = new Set<string>(r.changes[k]?.links ?? []);
    for (const [other, c] of Object.entries(r.changes)) if ((c.links ?? []).includes(k)) near.add(other);
    for (const n of near) if (!seen.has(n)) { seen.add(n); todo.push(n); }
  }
  return [...seen].sort();
}

// The rounds that count for a key's group: every one kept but those blocked for privacy.
export function countedRounds(r: Rounds, key: string): (RoundRec & { key: string })[] {
  return groupOf(r, key).flatMap((k) => (r.changes[k]?.rounds ?? []).map((x) => ({ ...x, key: k })))
    .filter((x) => !x.blocked).sort((a, b) => a.at.localeCompare(b.at));
}
// The group's cut check, if it has one (0.20.0).
export function cutOf(r: Rounds, key: string): (CutRec & { key: string }) | null {
  for (const k of groupOf(r, key)) { const c = r.changes[k]?.cut; if (c) return { ...c, key: k }; }
  return null;
}

// What the change's last counted round left, from the runner's own record (never Cain's words):
// serious findings it left (by the owner's rule's count), lost, or still running.
export type LastRound = { state: "answered"; serious: number; id: string; key: string } | { state: "lost"; id: string; key: string } | { state: "running"; id: string; key: string } | { state: "none" };
export function lastRound(r: Rounds, key: string): LastRound {
  const done = countedRounds(r, key);
  const x = done[done.length - 1];
  if (!x) return { state: "none" };
  if (x.state === "lost") return { state: "lost", id: x.id, key: x.key };
  if (x.state === "answered") return { state: "answered", serious: x.serious ?? 0, id: x.id, key: x.key };
  return { state: "running", id: x.id, key: x.key };
}

export type Admit = { ok: true; key: string; round: number; kind: RoundKind; links: string[]; cap: number } | { ok: false; why: string };

// Whether a brief may be a new round, and which: the rules A and C of the cap, before anything is
// queued. The reason is plain, names the count and the rule, and is what review.sh prints.
export function admit(r: Rounds, b: Brief, base: number): Admit {
  if (b.kind === "cut-check") return { ok: false, why: "a cut check isn't a round: the runner takes it as a cut check. Nothing was queued." };
  const key = changeKeyOf(b);
  if (!key) return { ok: false, why: "a brief names the change it reviews: pr for a pull request, or change (a stable key) for a plan or document. Nothing was queued." };
  const links: string[] = [];
  if (b.supersedes !== undefined) {
    const old = keyOfRef(b.supersedes);
    if (!old) return { ok: false, why: "supersedes must be the earlier change key or pull request address. Nothing was queued." };
    if (old !== key) links.push(old);
  }
  // The group as it will be with this brief's link.
  const view: Rounds = { format: r.format, changes: { ...r.changes } };
  if (links.length) view.changes[key] = { ...(view.changes[key] ?? { rounds: [] }), links: [...new Set([...(view.changes[key]?.links ?? []), ...links])] };
  const done = countedRounds(view, key);
  const n = done.length;
  const cap = base;
  if (n >= cap) {
    return { ok: false, why: `refused: ${key} has had ${n} outside review round${n === 1 ? "" : "s"}, and the owner's rule allows at most ${base}, never more. No more rounds for it, under any id or a replacement pull request. If the last one left something serious, you decide by the rule: cut what the serious findings are about and submit one cut check (kind cut-check), or hold it. Nothing was queued.` };
  }
  const kind: RoundKind = b.round_kind ?? (n === 0 ? "full" : "fixes");
  if (kind === "full" && n > 0)
    return { ok: false, why: `refused: ${key} has had ${n} round${n === 1 ? "" : "s"} already, so this one is a fix-only round: leave round_kind out or set it to fixes, and list only the fixes. Nothing was queued.` };
  if (kind === "fixes" && n === 0)
    return { ok: false, why: `refused: ${key} has had no round yet, so there's nothing to check fixes against: its first round is full. Nothing was queued.` };
  return { ok: true, key, round: n + 1, kind, links, cap };
}

// Whether a brief may be the change's one cut check (0.20.0), before anything is queued: the change is at its
// cap, its last round ended with something serious left, and it has had no cut check. The reason is plain.
export type AdmitCut = { ok: true; key: string; last: { id: string; key: string }; serious: number } | { ok: false; why: string };
export function admitCut(r: Rounds, b: Brief, base: number): AdmitCut {
  const key = changeKeyOf(b);
  if (!key || !b.pr || !b.head) return { ok: false, why: "a cut check names the change's pull request (pr) and the cut head (head). Nothing was queued." };
  const n = countedRounds(r, key).length;
  if (n < base) return { ok: false, why: `refused: ${key} isn't at its cap (${n} of ${base} rounds), so there's nothing to cut: a cut check is only for a change at its cap. Nothing was queued.` };
  const had = cutOf(r, key);
  if (had) return { ok: false, why: `refused: ${key} already had its one cut check (${had.id}, ${had.state}). There is no second cut and no second check. Nothing was queued.` };
  const last = lastRound(r, key);
  if (last.state === "running" || last.state === "none") return { ok: false, why: `refused: ${key}'s last round is still running. A cut check waits until it has ended with something serious left. Nothing was queued.` };
  if (last.state === "lost") return { ok: false, why: `refused: ${key}'s last round was lost, so no serious finding is known to cut: it is held by the owner's rule. Nothing was queued.` };
  if (last.serious === 0) return { ok: false, why: `refused: ${key}'s last round left nothing serious, so there is nothing to cut: show the normal Ship card. Nothing was queued.` };
  return { ok: true, key, last: { id: last.id, key: last.key }, serious: last.serious };
}

// Kept once the review is queued.
export function addRound(r: Rounds, b: Brief, a: Extract<Admit, { ok: true }>, at: string): void {
  const c = r.changes[a.key] ??= { rounds: [] };
  if (a.links.length) c.links = [...new Set([...(c.links ?? []), ...a.links])];
  if (b.pr) c.pr = b.pr;
  c.topic = b.topic;
  c.rounds.push({ id: b.id, at, kind: a.kind, state: "started" });
}

export function roundById(r: Rounds, key: string, id: string): RoundRec | null {
  return r.changes[key]?.rounds.find((x) => x.id === id) ?? null;
}
