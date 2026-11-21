// The review-round cap (Cain 0.16.0). The owner's rule since Nov 17, 2026: a piece of work gets at
// most three outside review rounds; if the third still finds something serious, he gets one decision
// (ship with the risk named, or hold), never a fourth round. Kept here, in the runner (root), where
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
// When the cap's last round leaves a serious finding, the group gets one decision card (decision:
// owed, then posted), written by the runner through the link; Cain can't post it another way.
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeKeyOf, keyOfRef, type Brief, type RoundKind } from "./core.ts";

export const DEFAULT_ROUND_CAP = 3;
export const ROUNDS_FORMAT = 1;

export type RoundRec = { id: string; at: string; kind: RoundKind; blocked?: boolean; done?: boolean; serious?: number };
export type DecisionRec = {
  id: string;                        // the decision's own id: "<key>#<round>", what the link files the tap under
  key: string; round: number; serious: number;
  topic: string; finding: string; item: string | null; pr: string | null;
  state: "owed" | "posted"; at: string; message?: string; tries?: number;
};
export type ChangeRec = { rounds: RoundRec[]; links?: string[]; pr?: string; topic?: string; decision?: DecisionRec };
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
export function decisionOf(r: Rounds, key: string): DecisionRec | null {
  for (const k of groupOf(r, key)) if (r.changes[k]?.decision) return r.changes[k].decision!;
  return null;
}

export type Admit = { ok: true; key: string; round: number; kind: RoundKind; links: string[] } | { ok: false; why: string };

// Whether a brief may be a new round, and which: the rules A and C of the cap, before anything is
// queued. The reason is plain, names the count and the rule, and is what review.sh prints.
export function admit(r: Rounds, b: Brief, cap: number): Admit {
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
  if (n >= cap) {
    const d = decisionOf(view, key);
    return { ok: false, why: `refused: ${key} has had ${n} outside review round${n === 1 ? "" : "s"}, and the owner's rule allows at most ${cap}. No more rounds for it, under any id or a replacement pull request.${d ? " Its decision card went to him." : " If the last one left something serious, he gets one decision card from the review service; nothing else to send."} Nothing was queued.` };
  }
  const kind: RoundKind = b.round_kind ?? (n === 0 ? "full" : "fixes");
  if (kind === "full" && n > 0)
    return { ok: false, why: `refused: ${key} has had ${n} round${n === 1 ? "" : "s"} already, so this one is a fix-only round: leave round_kind out or set it to fixes, and list only the fixes. Nothing was queued.` };
  if (kind === "fixes" && n === 0)
    return { ok: false, why: `refused: ${key} has had no round yet, so there's nothing to check fixes against: its first round is full. Nothing was queued.` };
  return { ok: true, key, round: n + 1, kind, links };
}

// Kept once the review is queued.
export function addRound(r: Rounds, b: Brief, a: Extract<Admit, { ok: true }>, at: string): void {
  const c = r.changes[a.key] ??= { rounds: [] };
  if (a.links.length) c.links = [...new Set([...(c.links ?? []), ...a.links])];
  if (b.pr) c.pr = b.pr;
  c.topic = b.topic;
  c.rounds.push({ id: b.id, at, kind: a.kind });
}

export function roundById(r: Rounds, key: string, id: string): RoundRec | null {
  return r.changes[key]?.rounds.find((x) => x.id === id) ?? null;
}
