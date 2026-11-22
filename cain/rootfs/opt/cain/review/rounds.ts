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
//
// Round 2: each round is kept as started (at intake, before it runs), then answered, or lost: ended
// without a result (every seat failed, or a crash recovered at the runner's start, where the round was
// counted but its review never made it to the queue). A lost round still counts (the count stays
// conservative), and a lost round that is the cap's last owes the decision card too, saying the final
// review did not complete.
//
// Cain 0.18.0: the cap for a change is the base cap plus the rounds the owner granted it (grants.ts), on
// his tap only. A round under the raised cap is fix-only like any later round. A granted round that again
// leaves something serious at the raised cap owes a new decision card (one per round number): the newest
// decision is the one that counts, and the earlier ones are kept under `past`.
import { chmodSync, chownSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeKeyOf, keyOfRef, type Brief, type RoundKind } from "./core.ts";
import { countingGrants, grantedRounds, grantWords, standing, STALE_LONG, type GrantBinding, type GrantRec, type Grants, type StaleWhy } from "./grants.ts";

export const DEFAULT_ROUND_CAP = 3;
export const ROUNDS_FORMAT = 1;

export type RoundState = "started" | "answered" | "lost";
// claims (0.18.1): the owner's grants this round claimed (their ids): each grant is claimed by exactly one round.
export type RoundRec = { id: string; at: string; kind: RoundKind; state?: RoundState; blocked?: boolean; done?: boolean; serious?: number; claims?: string[] };
export type DecisionRec = {
  id: string;                        // the decision's own id: "<key>#<round>", what the link files the tap under
  key: string; round: number; serious: number;
  topic: string; finding: string; item: string | null; pr: string | null;
  state: "owed" | "posted"; at: string; message?: string; tries?: number;
  lost?: boolean;                    // the cap's last round never produced a result (round 2)
};
export type ChangeRec = { rounds: RoundRec[]; links?: string[]; pr?: string; topic?: string; decision?: DecisionRec; past?: DecisionRec[] };
// grants_void (0.18.1): grants the runner found no longer bound to the change as it is (or never bound),
// by grant id, kept so each is told to Cain once and never counts again. The grants file isn't touched.
export type VoidRec = { why: StaleWhy; at: string; key: string };
// grants_legacy (0.18.1, fifth review): grants from 0.18.0 (no binding), by grant id, as the upgrade's one-time sweep
// replayed them (grants.ts sweepLegacy): the rounds that needed each (credited: those rounds carry its id as a claim,
// and it counts for those rounds only), and its allowance left (unused), which is pending, never claimable, until
// the owner confirms it on the Keep or Drop card. His Keep binds it to the change as it stood at his tap (bound, the
// pull request's head read from GitHub then); his Drop ends it. Written by the runner (the sweep) and by the link
// (his tap), each under the rounds file's lock (withRoundsLock). The grants file isn't touched.
export type LegacyState = "used" | "pending" | "kept" | "dropped";
export type LegacyRec = { key: string; at: string; credited: string[]; unused: number; state: LegacyState;
  bound?: GrantBinding; answered?: { at: string; message: string } };
// legacy_cards (fifth review): the Keep or Drop card, one per change, owed by the runner and posted by the link
// (its root socket), tried again each tick until it's up. Cain is told once per change, when it's owed.
export type LegacyCard = { key: string; ids: string[]; granted: number; unused: number; item: string | null; pr: string | null;
  topic: string; state: "owed" | "posted"; at: string; message?: string; tries?: number };
export type Rounds = { format: number; changes: Record<string, ChangeRec>; grants_void?: Record<string, VoidRec>;
  grants_legacy?: Record<string, LegacyRec>; legacy_cards?: Record<string, LegacyCard> };

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

// The rounds file's lock (0.18.1, fifth review): since the owner's Keep or Drop tap is written into the rounds file by
// the link, the runner's writes and the link's are each one read, change and write under this lock, so neither
// writes over the other's. An exclusive create of "<file>.lock" holding a token; one older than staleMs is taken
// over (renamed aside, then the exclusive create again, so one contender wins). Waits up to waitMs, then throws
// RoundsBusy (the caller writes nothing: the runner tries again next tick; the link keeps the card up).
export class RoundsBusy extends Error {}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withRoundsLock<T>(path: string, fn: () => T, o: { waitMs?: number; staleMs?: number } = {}): T {
  const lock = `${path}.lock`, token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + (o.waitMs ?? 3000), stale = o.staleMs ?? 30_000;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try { const fd = openSync(lock, "wx", 0o600); try { writeSync(fd, token); } finally { closeSync(fd); } break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw new RoundsBusy(`the rounds file's lock can't be taken (${String(e?.code ?? e)})`);
      try {
        if (Date.now() - statSync(lock).mtimeMs > stale) {
          const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
          renameSync(lock, aside);
          try { unlinkSync(aside); } catch { /* gone */ }
          continue;
        }
      } catch { continue; }                          // it went meanwhile: try again
      if (Date.now() > until) throw new RoundsBusy("the rounds file is busy (another writer holds its lock)");
      sleepSync(15);
    }
  }
  try { return fn(); }
  finally { try { if (readFileSync(lock, "utf8") === token) unlinkSync(lock); } catch { /* taken over, or gone */ } }
}
// One read, change and write of the rounds file under its lock. fn returns false to write nothing. null when the
// file can't be read (nothing written).
export function updateRounds<T>(path: string, fn: (r: Rounds) => T | false): T | false | null {
  return withRoundsLock(path, () => {
    const r = readRounds(path);
    if (!r) return null;
    const out = fn(r);
    if (out !== false) writeRounds(path, r);
    return out;
  });
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
// The group's newest decision (the highest round): since 0.18.0 a granted round can owe another.
export function decisionOf(r: Rounds, key: string): DecisionRec | null {
  let best: DecisionRec | null = null;
  for (const k of groupOf(r, key)) { const d = r.changes[k]?.decision; if (d && (!best || d.round > best.round)) best = d; }
  return best;
}

// stale (0.18.1): grants of the group that don't count, with why (the runner keeps the new ones under
// grants_void and tells Cain once); claims: the grants this round claims.
export type Admit = { ok: true; key: string; round: number; kind: RoundKind; links: string[]; cap: number; granted: GrantRec[]; claims: string[]; stale: { rec: GrantRec; why: StaleWhy }[] }
  | { ok: false; why: string; key?: string; stale?: { rec: GrantRec; why: StaleWhy }[] };

// Whether a brief may be a new round, and which: the rules A and C of the cap, before anything is
// queued. The reason is plain, names the count and the rule, and is what review.sh prints.
// grants (0.18.0): the owner's grants, read by the caller (null when they can't be read: none count).
// headUnknown (0.18.1): review.sh's early check, which doesn't hold the head GitHub has; a grant's head is
// then checked only by the runner, which decides, keeps a grant that moved on as void and tells Cain once.
export function admit(r: Rounds, b: Brief, base: number, grants: Grants | null = null, tz?: string, headUnknown = false): Admit {
  const key = changeKeyOf(b);
  if (!key) return { ok: false, why: "a brief names the change it reviews: pr for a pull request, or change (a stable key) for a plan or document. Nothing was queued." };
  const links: string[] = [];
  if (b.supersedes !== undefined) {
    const old = keyOfRef(b.supersedes);
    if (!old) return { ok: false, why: "supersedes must be the earlier change key or pull request address. Nothing was queued." };
    if (old !== key) links.push(old);
  }
  // The group as it will be with this brief's link.
  const view: Rounds = { ...r, changes: { ...r.changes } };
  if (links.length) view.changes[key] = { ...(view.changes[key] ?? { rounds: [] }), links: [...new Set([...(view.changes[key]?.links ?? []), ...links])] };
  const done = countedRounds(view, key);
  const n = done.length;
  // 0.18.1: a grant counts once claimed, or when its binding matches the change as it is now, the brief's
  // head included; this round claims the matching ones when it's past the cap without them.
  const st = standing(base, view, grants, key, headUnknown ? undefined : (b.head ?? null));
  const claims = n >= st.prior ? st.claimable.map((x) => x.id) : [];
  const granted = n >= st.prior ? countingGrants(st) : st.counting;
  const cap = base + grantedRounds(granted);
  if (n >= cap) {
    const d = decisionOf(view, key);
    const g = grantWords(granted, tz);
    const notes = [
      ...st.stale.map((x) => ` His grant of ${x.rec.rounds} more round${x.rec.rounds === 1 ? "" : "s"} (${grantWords([x.rec], tz).replace(/^\d+ /, "")}) doesn't count: ${STALE_LONG[x.why]}.`),
      ...st.waiting.map((x) => ` His grant of ${x.rounds} more round${x.rounds === 1 ? "" : "s"} was given for the pull request at a given head, and this brief names no head, so it can't be matched: send the brief again with the pull request's head.`),
      // Fifth review: a 0.18.0 grant's unused allowance waits for his Keep or Drop card, and never counts before it.
      ...st.pending.map((x) => ` His earlier grant of ${x.rec.rounds} more round${x.rec.rounds === 1 ? "" : "s"} (${grantWords([x.rec], tz).replace(/^\d+ /, "")}), from before grants were bound to a commit, has ${x.unused} unused round${x.unused === 1 ? "" : "s"} waiting for his confirmation on the review service's Keep or Drop card: ${x.unused === 1 ? "it doesn't" : "they don't"} count until he taps Keep. Don't ask him about it yourself.`),
    ].join("");
    const fresh = st.stale.length ? " If the change still needs rounds, a fresh grant card is the way: keeper.sh review-grant." : "";
    return { ok: false, key, stale: st.stale, why: `refused: ${key} has had ${n} outside review round${n === 1 ? "" : "s"}, and the owner's rule allows at most ${base}${g ? `, plus ${g}, so ${cap}` : ""}.${notes}${fresh} No more rounds for it, under any id or a replacement pull request.${d ? " Its decision card went to him." : " If the last one left something serious, he gets one decision card from the review service; nothing else to send."} More rounds come only from a grant: Cain asks with keeper.sh review-grant, and only the owner's tap on that card grants them; it never exempts the change from the rule. Nothing was queued.` };
  }
  const kind: RoundKind = b.round_kind ?? (n === 0 ? "full" : "fixes");
  if (kind === "full" && n > 0)
    return { ok: false, why: `refused: ${key} has had ${n} round${n === 1 ? "" : "s"} already, so this one is a fix-only round: leave round_kind out or set it to fixes, and list only the fixes. Nothing was queued.` };
  if (kind === "fixes" && n === 0)
    return { ok: false, why: `refused: ${key} has had no round yet, so there's nothing to check fixes against: its first round is full. Nothing was queued.` };
  return { ok: true, key, round: n + 1, kind, links, cap, granted, claims, stale: st.stale };
}

// Kept once the review is queued.
export function addRound(r: Rounds, b: Brief, a: Extract<Admit, { ok: true }>, at: string): void {
  const c = r.changes[a.key] ??= { rounds: [] };
  if (a.links.length) c.links = [...new Set([...(c.links ?? []), ...a.links])];
  if (b.pr) c.pr = b.pr;
  c.topic = b.topic;
  c.rounds.push({ id: b.id, at, kind: a.kind, state: "started", ...(a.claims.length ? { claims: a.claims } : {}) });
}

export function roundById(r: Rounds, key: string, id: string): RoundRec | null {
  return r.changes[key]?.rounds.find((x) => x.id === id) ?? null;
}
