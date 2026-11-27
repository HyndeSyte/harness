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
import { chmodSync, chownSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeKeyOf, keyOfRef, type Brief, type RoundKind } from "./core.ts";
import { CAP_WHY, asksAboutCap, capQuestionHits } from "../gate/cain.ts";
import { asksSomething } from "../gate/plugin.ts";

export const DEFAULT_ROUND_CAP = 3;
export const ROUNDS_FORMAT = 1;

export type RoundState = "started" | "answered" | "lost";
// head (round 1 fixes): the head the round reviewed, from its brief; the Ship card at the cap binds to the last one's.
export type RoundRec = { id: string; at: string; kind: RoundKind; state?: RoundState; blocked?: boolean; done?: boolean; serious?: number; head?: string };
// The one cut check of a change at its cap (0.20.0): its review id, the cut head it checked, the seat, and
// how it ended (pass or fail; lost when its seat never answered). One a change group, for good.
// base (round 1 fixes): the head the change's last round reviewed, the cut diff's starting point.
// Round 2 fixes: every transport attempt (no answer at all: the seat unreachable, a timeout before any response, git
// failing before dispatch), at most CUT_TRANSPORT_MAX, and when Cain was reminded the check had no result yet.
export type CutRec = { id: string; at: string; head: string; pr: string; seat: string; base?: string; state: "started" | "pass" | "fail" | "lost";
  attempts?: { at: string; kind: string; detail: string }[]; reminded?: string };
export const CUT_TRANSPORT_MAX = 8;
// Round 1 fixes: Cain's decision at the cap (review.sh decide), kept by the runner from his inbox.
export type DecisionRec = { choice: "hold" | "cut"; why?: string; at: string };
// The one plain line the owner hears at each terminal outcome at the cap, kept until the link confirms it.
// Round 2 fixes: "unchecked", the change held because its cut could not be checked (transport retries used up, no
// seat that didn't write the cut, or a cut with no check result a day on).
export type OwnerOutcome = "clean" | "cap" | "lost" | "cut-pass" | "cut-fail" | "held" | "undecided" | "unchecked";
export const OWNER_OUTCOMES: readonly OwnerOutcome[] = ["clean", "cap", "lost", "cut-pass", "cut-fail", "held", "undecided", "unchecked"];
export type OwnerLineRec = { state: "owed" | "sent"; at: string; serious?: number; why?: string; message?: string; tries?: number };
// The cap's own record (round 1 fixes): when the change reached it with something serious left (for the reminder),
// and whether Cain had his reminder.
export type CappedRec = { at: string; id: string; serious: number; reminded?: string };
// decision and past: written by the retired decision card (0.16.0 to 0.19.0), read nowhere now.
// purpose (round 1 fixes): the topic and question of the change's first brief, quoted to its cut check.
// Round 2 fixes: the purpose record, frozen after round 1 (frozen: when): the opening of the pull request description's
// "What changed" section as the owner reads it, and each round 1 outside seat's own statement of what the piece must
// do; source says whether it was kept at round 1 or built from the description alone for a change past round 1 when
// this began. A record with no frozen time is an earlier one (topic and question only).
export type PurposeRec = { topic: string; question: string; what_changed?: string | null; statements?: { seat: string; text: string }[];
  source?: "round 1" | "description only"; frozen?: string };
// Round 2 fixes: the runner's own hold of a change (its cut could not be checked); a hold is final (monotonic).
export type HeldRec = { at: string; why: string };
export type ChangeRec = { rounds: RoundRec[]; links?: string[]; pr?: string; topic?: string; cut?: CutRec; decision?: unknown; past?: unknown;
  purpose?: PurposeRec; decided?: DecisionRec; capped?: CappedRec; lines?: Partial<Record<OwnerOutcome, OwnerLineRec>>; held?: HeldRec;
  cut_reminded?: string };
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

// Written whole (temp file, rename), keeping the file's owner and mode as the runner's other files do. Round 2 fixes:
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
// The group's cut check, if it has one (0.20.0).
export function cutOf(r: Rounds, key: string): (CutRec & { key: string }) | null {
  for (const k of groupOf(r, key)) { const c = r.changes[k]?.cut; if (c) return { ...c, key: k }; }
  return null;
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
export type AdmitCut = { ok: true; key: string; last: { id: string; key: string }; serious: number; base: string } | { ok: false; why: string };
export function admitCut(r: Rounds, b: Brief, base: number): AdmitCut {
  const key = changeKeyOf(b);
  if (!key || !b.pr || !b.head) return { ok: false, why: "a cut check names the change's pull request (pr) and the cut head (head). Nothing was queued." };
  const n = countedRounds(r, key).length;
  if (n < base) return { ok: false, why: `refused: ${key} isn't at its cap (${n} of ${base} rounds), so there's nothing to cut: a cut check is only for a change at its cap. Nothing was queued.` };
  const had = cutOf(r, key);
  const dec = decisionOf(r, key);
  const held = heldOf(r, key);
  if (held) return { ok: false, why: `refused: ${key} is held (${held.why}), and a hold is final: there is no cut and no check after it. Nothing was queued.` };
  if (dec?.choice === "hold") return { ok: false, why: `refused: ${key} is held (Cain decided so with review.sh decide), so there is no cut and no check. Nothing was queued.` };
  if (had) return { ok: false, why: `refused: ${key} already had its one cut check (${had.id}, ${had.state}). There is no second cut and no second check. Nothing was queued.` };
  const last = lastRound(r, key);
  if (last.state === "running" || last.state === "none") return { ok: false, why: `refused: ${key}'s last round is still running. A cut check waits until it has ended with something serious left. Nothing was queued.` };
  if (last.state === "lost") return { ok: false, why: `refused: ${key}'s last round was lost, so no serious finding is known to cut: it is held by the owner's rule. Nothing was queued.` };
  if (last.serious === 0) return { ok: false, why: `refused: ${key}'s last round left nothing serious, so there is nothing to cut: show the normal Ship card. Nothing was queued.` };
  if (!last.head) return { ok: false, why: `refused: the runner's record of ${key}'s last round names no head, so the cut diff has no starting point: it is held. Nothing was queued.` };
  return { ok: true, key, last: { id: last.id, key: last.key }, serious: last.serious, base: last.head };
}

// Kept once the review is queued.
export function addRound(r: Rounds, b: Brief, a: Extract<Admit, { ok: true }>, at: string): void {
  const c = r.changes[a.key] ??= { rounds: [] };
  if (a.links.length) c.links = [...new Set([...(c.links ?? []), ...a.links])];
  if (b.pr) c.pr = b.pr;
  c.topic = b.topic;
  // The piece's purpose, from its first brief only (round 1 fixes): what its cut check asks still works. Round 2 fixes:
  // completed and frozen when round 1 settles (the runner's freezePurpose); never written after.
  if (a.round === 1 && !purposeOf(r, a.key)) c.purpose = { topic: b.topic, question: b.question };
  c.rounds.push({ id: b.id, at, kind: a.kind, state: "started", ...(b.head ? { head: b.head.toLowerCase() } : {}) });
}

// The group's purpose (its first brief's topic and question), its decision at the cap, and the key its
// change-wide records (the cap, the owner's lines, the cut reservation) are kept under: the group's first key.
export function purposeOf(r: Rounds, key: string): PurposeRec | null {
  const first = countedRounds(r, key)[0];
  if (first && r.changes[first.key]?.purpose) return r.changes[first.key].purpose!;
  for (const k of groupOf(r, key)) if (r.changes[k]?.purpose) return r.changes[k].purpose!;
  return null;
}
export function decisionOf(r: Rounds, key: string): (DecisionRec & { key: string }) | null {
  for (const k of groupOf(r, key)) { const d = r.changes[k]?.decided; if (d) return { ...d, key: k }; }
  return null;
}
export const rootOf = (r: Rounds, key: string): string => groupOf(r, key)[0];
export function heldOf(r: Rounds, key: string): (HeldRec & { key: string }) | null {
  for (const k of groupOf(r, key)) { const h = r.changes[k]?.held; if (h) return { ...h, key: k }; }
  return null;
}
// The essential behaviours a cut check must find evidence for (round 2 fixes), from the frozen purpose record only:
// each sentence of the "What changed" opening and each round 1 seat's statement, of at least five words. Fewer than
// MIN_ESSENTIALS (core.ts) and the cut fails.
export function essentialsOf(p: PurposeRec | null): string[] {
  if (!p?.frozen) return [];
  const out: string[] = [];
  const words = (t: string) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  for (const x of String(p.what_changed ?? "").split(/(?<=[.!?])\s+|\n+/).map((t) => t.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()))
    if (words(x) >= 5) out.push(x.slice(0, 400));
  for (const st of p.statements ?? []) if (words(st.text) >= 5) out.push(st.text.slice(0, 800));
  return [...new Set(out)].slice(0, 12);
}
// The record as the cut judge reads it, saying where it came from.
export function purposeText(p: PurposeRec | null): string {
  if (!p) return "(no purpose record)";
  const lines = [`Topic: ${p.topic}`, `Question: ${p.question}`,
    `Source: ${p.source === "description only" ? "built from the pull request's description only, since the change was past its first round when purpose records began" : "kept at the change's first review round and frozen then"}.`];
  if (p.what_changed) lines.push(`What changed, as the owner reads it: ${p.what_changed}`);
  for (const st of p.statements ?? []) lines.push(`What it must do, by ${st.seat} at round 1: ${st.text}`);
  return lines.join("\n");
}

// The one cut check per change, reserved atomically before anything is dispatched (round 1 fixes): an exclusive
// create of the group's reservation file beside the rounds file, holding the check's id. A second brief for the
// same change finds it there and is refused, whatever the rounds file said when it was read. A reservation
// released (the cut was refused, never sent: not a descendant, or blocked for privacy) is removed. One left by
// a crash before its check was kept (no cut in the rounds file, no review of its id) is taken over after 10
// minutes.
export const cutLockOf = (roundsFile: string, root: string) => join(dirname(roundsFile), `.review-cut-${root}.lock`);
export function reserveCut(roundsFile: string, root: string, id: string, stale: (heldId: string, ageMs: number) => boolean): boolean {
  const path = cutLockOf(roundsFile, root);
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(path, "wx", 0o640); try { writeSync(fd, id); } finally { closeSync(fd); } return true; }
    catch (e: any) {
      if (e?.code !== "EEXIST" || i > 0) return false;
      let held = "", age = 0;
      try { held = readFileSync(path, "utf8").trim(); age = Date.now() - statSync(path).mtimeMs; } catch { return false; }
      if (!stale(held, age)) return false;
      try { unlinkSync(path); } catch { return false; }
    }
  }
  return false;
}
export function releaseCut(roundsFile: string, root: string): void { try { unlinkSync(cutLockOf(roundsFile, root)); } catch { /* gone */ } }

export function roundById(r: Rounds, key: string, id: string): RoundRec | null {
  return r.changes[key]?.rounds.find((x) => x.id === id) ?? null;
}

// Cain's decision at the cap (round 1 fixes): `review.sh decide <change> hold "<why in one line>"` or
// `review.sh decide <change> cut`. The why goes to the owner as his one "held: <why>" line, so it is one plain
// line: no question, nothing about rounds, risk or cuts put to him (gate/cain.ts asksAboutCap), no em dash.
export const DECIDE_WHY_MAX = 200;
// A why that asks him something without a question mark ("let me know if you want it kept").
const ASKS_HIM = /\b(let me know|tell me|your call|up to you|if you want|do you want|would you like|want me to|should i|ok to|okay to|your go|your say)\b/i;
export type Decide = { change: string; choice: "hold" | "cut"; why?: string };
export function checkDecision(d: any): Decide | string {
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !["change", "choice", "why"].includes(k)))
    return "a decision has only change, choice and why.";
  const change = typeof d.change === "string" ? keyOfRef(d.change.trim()) : null;
  if (!change) return "change must be the change's key (like pr-40) or its pull request's address.";
  if (d.choice !== "hold" && d.choice !== "cut") return "choice must be hold or cut.";
  if (d.choice === "cut") return d.why === undefined || d.why === "" ? { change, choice: "cut" } : "a cut takes no why.";
  const why = typeof d.why === "string" ? d.why.trim() : "";
  if (!why) return "a hold needs its why, in one line.";
  if (/[\r\n]/.test(why) || why.length > DECIDE_WHY_MAX) return `the why is one line of at most ${DECIDE_WHY_MAX} characters.`;
  if (/[—–]/.test(why)) return "the why has a dash he'd read as an em dash: use a comma or a new sentence.";
  // Round 2 fixes: the message gate's own cap check, over the line as he'll read it ("held: <why>"), and anything that
  // asks him something: refused with the gate's reason.
  const line = `held: ${why}`;
  if (why.includes("?") || asksSomething(line) || capQuestionHits(line).length || asksAboutCap(why) || ASKS_HIM.test(why))
    return `The message gate held this: ${CAP_WHY}. The why tells him why it is held; it asks him nothing, and says nothing about rounds, risk or cuts.`;
  return { change, choice: "hold", why };
}
// Why a decision can't be kept now, or null: the change must be at its cap with something serious left by its
// last round, and have no decision and no cut check yet.
export function decideWhy(r: Rounds, change: string, cap: number): string | null {
  if (!groupOf(r, change).some((k) => r.changes[k])) return `${change} has no review rounds.`;
  const n = countedRounds(r, change).length;
  if (n < cap) return `${change} isn't at its cap (${n} of ${cap} rounds): there is nothing to decide yet.`;
  const last = lastRound(r, change);
  if (last.state !== "answered") return last.state === "lost" ? `${change}'s last round was lost, so it is held by the rule already.` : `${change}'s last round is still running.`;
  if (last.serious === 0) return `${change}'s last round left nothing serious: show the normal Ship card.`;
  const h = heldOf(r, change);
  if (h) return `${change} is held (${h.why}), and a hold is final: no later decision is kept.`;
  const d = decisionOf(r, change);
  if (d) return `${change} is decided already (${d.choice}); a decision is made once.`;
  const c = cutOf(r, change);
  if (c) return `${change} already has its cut check (${c.state}).`;
  return null;
}
