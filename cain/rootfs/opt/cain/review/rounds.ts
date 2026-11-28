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
// the cap's last round: nothing serious left, the normal Ship card; something serious left, the piece is held
// (this is the rule's hold-only form: its cut branch is a later piece), Cain records why with review.sh decide,
// and the owner hears one plain line from code at each outcome.
import { chmodSync, chownSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeKeyOf, keyOfRef, type Brief, type RoundKind } from "./core.ts";
import { CAP_WHY, asksAboutCap, capQuestionHits } from "../gate/cain.ts";
import { asksSomething } from "../gate/plugin.ts";

export const DEFAULT_ROUND_CAP = 3;
export const ROUNDS_FORMAT = 1;

export type RoundState = "started" | "answered" | "lost";
// head: the head the round reviewed, from its brief; the Ship card at the cap binds to the last one's.
export type RoundRec = { id: string; at: string; kind: RoundKind; state?: RoundState; blocked?: boolean; done?: boolean; serious?: number; head?: string };
// Cain 0.20.0: Cain's decision at the cap (review.sh decide), kept by the runner from his inbox.
export type DecisionRec = { choice: "hold"; why: string; at: string };
// The one plain line the owner hears at each terminal outcome at the cap, kept until the link confirms it.
// clean: nothing serious left at the cap; cap: the cap reached with something serious left, held; lost: the last
// round had no result, held; held: Cain's recorded why; undecided: no decision a day after the cap.
export type OwnerOutcome = "clean" | "cap" | "lost" | "held" | "undecided";
export const OWNER_OUTCOMES: readonly OwnerOutcome[] = ["clean", "cap", "lost", "held", "undecided"];
export type OwnerLineRec = { state: "owed" | "sent"; at: string; serious?: number; why?: string; message?: string; tries?: number };
// The cap's own record: when the change reached it with something serious left (for the reminder),
// and whether Cain had his reminder.
export type CappedRec = { at: string; id: string; serious: number; reminded?: string };
// decision and past: written by the retired decision card (0.16.0 to 0.19.0), read nowhere now.
export type ChangeRec = { rounds: RoundRec[]; links?: string[]; pr?: string; topic?: string; decision?: unknown; past?: unknown;
  decided?: DecisionRec; capped?: CappedRec; lines?: Partial<Record<OwnerOutcome, OwnerLineRec>> };
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

// Written whole (temp file, rename), keeping the file's owner and mode as the runner's other files do. Cain 0.20.0:
// synced to disk before the rename and the folder after it, so a line owed to the owner is kept before it is posted,
// whatever stops the runner (a power cut included).
export function writeRounds(path: string, r: Rounds): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.rounds-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = openSync(tmp, "w", 0o640);
  try { writeSync(fd, JSON.stringify(r, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
  try { const s = statSync(path); chownSync(tmp, s.uid, s.gid); chmodSync(tmp, s.mode & 0o777); } catch { /* a new file */ }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* a folder that can't be synced */ }
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

// What the change's last counted round left, from the runner's own record (never Cain's words):
// serious findings it left (by the owner's rule's count), lost, or still running.
export type LastRound = { state: "answered"; serious: number; id: string; key: string; head?: string } | { state: "lost"; id: string; key: string } | { state: "running"; id: string; key: string } | { state: "none" };
export function lastRound(r: Rounds, key: string): LastRound {
  const done = countedRounds(r, key);
  const x = done[done.length - 1];
  if (!x) return { state: "none" };
  if (x.state === "lost") return { state: "lost", id: x.id, key: x.key };
  if (x.state === "answered") return { state: "answered", serious: x.serious ?? 0, id: x.id, key: x.key, ...(x.head ? { head: x.head } : {}) };
  return { state: "running", id: x.id, key: x.key };
}

export type Admit = { ok: true; key: string; round: number; kind: RoundKind; links: string[]; cap: number } | { ok: false; why: string };

// Whether a brief may be a new round, and which: the rules A and C of the cap, before anything is
// queued. The reason is plain, names the count and the rule, and is what review.sh prints.
export function admit(r: Rounds, b: Brief, base: number): Admit {
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
    return { ok: false, why: `refused: ${key} has had ${n} outside review round${n === 1 ? "" : "s"}, and the owner's rule allows at most ${base}, never more. No more rounds for it, under any id or a replacement pull request. If the last one left something serious, it is held by the rule: record why with review.sh decide. Nothing was queued.` };
  }
  const kind: RoundKind = b.round_kind ?? (n === 0 ? "full" : "fixes");
  if (kind === "full" && n > 0)
    return { ok: false, why: `refused: ${key} has had ${n} round${n === 1 ? "" : "s"} already, so this one is a fix-only round: leave round_kind out or set it to fixes, and list only the fixes. Nothing was queued.` };
  if (kind === "fixes" && n === 0)
    return { ok: false, why: `refused: ${key} has had no round yet, so there's nothing to check fixes against: its first round is full. Nothing was queued.` };
  return { ok: true, key, round: n + 1, kind, links, cap };
}

// Kept once the review is queued.
export function addRound(r: Rounds, b: Brief, a: Extract<Admit, { ok: true }>, at: string): void {
  const c = r.changes[a.key] ??= { rounds: [] };
  if (a.links.length) c.links = [...new Set([...(c.links ?? []), ...a.links])];
  if (b.pr) c.pr = b.pr;
  c.topic = b.topic;
  c.rounds.push({ id: b.id, at, kind: a.kind, state: "started", ...(b.head ? { head: b.head.toLowerCase() } : {}) });
}

// The group's decision at the cap, and the key its change-wide records (the cap, the owner's lines) are kept
// under: the group's first key.
export function decisionOf(r: Rounds, key: string): (DecisionRec & { key: string }) | null {
  for (const k of groupOf(r, key)) { const d = r.changes[k]?.decided; if (d) return { ...d, key: k }; }
  return null;
}
export const rootOf = (r: Rounds, key: string): string => groupOf(r, key)[0];

export function roundById(r: Rounds, key: string, id: string): RoundRec | null {
  return r.changes[key]?.rounds.find((x) => x.id === id) ?? null;
}

// Cain's decision at the cap: `review.sh decide <change> hold "<why in one line>"`, kept under the change in the
// rounds file. A hold is final for that change. The why goes to the owner as his one "held: <why>" line, so it is one plain
// line: no question, nothing about rounds, risk or cuts put to him (gate/cain.ts asksAboutCap), no em dash.
export const DECIDE_WHY_MAX = 200;
// A why that asks him something without a question mark ("let me know if you want it kept").
const ASKS_HIM = /\b(let me know|tell me|your call|up to you|if you want|do you want|would you like|want me to|should i|ok to|okay to|your go|your say)\b/i;
export type Decide = { change: string; choice: "hold"; why: string };
export function checkDecision(d: any): Decide | string {
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !["change", "choice", "why"].includes(k)))
    return "a decision has only change, choice and why.";
  const change = typeof d.change === "string" ? keyOfRef(d.change.trim()) : null;
  if (!change) return "change must be the change's key (like pr-40) or its pull request's address.";
  if (d.choice !== "hold") return "choice must be hold: the cut branch of the owner's rule isn't built yet.";
  const why = typeof d.why === "string" ? d.why.trim() : "";
  if (!why) return "a hold needs its why, in one line.";
  if (/[\r\n]/.test(why) || why.length > DECIDE_WHY_MAX) return `the why is one line of at most ${DECIDE_WHY_MAX} characters.`;
  if (/[—–]/.test(why)) return "the why has a dash he'd read as an em dash: use a comma or a new sentence.";
  // Cain 0.20.0: the message gate's own cap check, over the line as he'll read it ("held: <why>"), and anything that
  // asks him something: refused with the gate's reason.
  const line = `held: ${why}`;
  if (why.includes("?") || asksSomething(line) || capQuestionHits(line).length || asksAboutCap(why) || ASKS_HIM.test(why))
    return `The message gate held this: ${CAP_WHY}. The why tells him why it is held; it asks him nothing, and says nothing about rounds, risk or cuts.`;
  return { change, choice: "hold", why };
}
// Why a decision can't be kept now, or null: the change must be at its cap with something serious left by its
// last round, and have no decision yet.
export function decideWhy(r: Rounds, change: string, cap: number): string | null {
  if (!groupOf(r, change).some((k) => r.changes[k])) return `${change} has no review rounds.`;
  const n = countedRounds(r, change).length;
  if (n < cap) return `${change} isn't at its cap (${n} of ${cap} rounds): there is nothing to decide yet.`;
  const last = lastRound(r, change);
  if (last.state !== "answered") return last.state === "lost" ? `${change}'s last round was lost, so it is held by the rule already.` : `${change}'s last round is still running.`;
  if (last.serious === 0) return `${change}'s last round left nothing serious: show the normal Ship card.`;
  const d = decisionOf(r, change);
  if (d) return `${change} is held already (${d.why}), and a hold is final: no later decision is kept.`;
  return null;
}
