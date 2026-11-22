// Extra review rounds for a change, granted by the owner's tap (Cain 0.18.0). The owner's rule caps
// outside review rounds at three a change (rounds.ts). His decision on Nov 21, 2026: the exception for a
// critical change whose last round still left something serious is more fix rounds, granted by him, never
// an exemption from the rule. So the cap for a change is the base cap plus the rounds he granted it.
//
// Grants are kept in /data/review-grants.json, beside the rounds file: root:cain 0640 (kept so at every
// write and recreation, recordGrant), written only by the
// link, and only on his tap on the card Cain's `keeper.sh review-grant` asked for (Cain's command alone
// writes nothing). The review runner reads it to count the cap; review.sh reads it for status and spend.
// A grant is for one change key (a pull request's "pr-<number>", or a plan's change key); a superseding
// change carries its grants over the way it carries the rounds: they count for the whole group.
//
// What a grant never does: exempt a change from the rule (each granted round is a fix-only round, counted
// like any other), or from the armed-rollback condition a Ship card with the risk named needs.
import { closeSync, fchmodSync, fchownSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAIN_GID, ROOT_UID } from "../capfiles.ts";
import { grantedNote } from "./core.ts";
import { countedRounds, decisionOf, groupOf, type Rounds } from "./rounds.ts";

export const GRANTS_FORMAT = 1;
export const GRANT_MAX = 3;                   // one card grants 1 to 3 rounds
export type GrantRec = {
  id: string;                                 // "<key>+<Discord message id of the card>": one grant per card
  key: string; rounds: number;
  by: "owner";                                // always the owner, by his tap
  at: string;                                 // when he tapped
  message: string;                            // the card's Discord message
  reason: string;                             // the reason Cain gave on the card
  item: string | null; pr: string | null;
  // Cain 0.18.1 (third review of 0.18.0): the state his tap approved, the very values the tap's final
  // re-check compared under the change key's lock: the pull request's head (null for a change key with no
  // pull request), the change's newest decision id (or null), the round count used, and the cap before
  // this grant. The runner counts the grant only while that state still holds when a round claims it.
  bound?: GrantBinding;
  // Fifth review: the card's own id (the link's stable nonce for it), the same however often the card is tapped,
  // its tap redelivered or the card sent again: the grants file holds at most one grant per card id.
  card?: string;
};
export type GrantBinding = { head: string | null; decision: string | null; used: number; cap: number };
export type Grants = { format: number; grants: GrantRec[] };
export const emptyGrants = (): Grants => ({ format: GRANTS_FORMAT, grants: [] });

// Read whole; a file not there yet is empty; null when it's there and can't be read or doesn't parse
// (the caller fails closed: no round past the base cap, no grant card).
export function readGrants(path: string): Grants | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? emptyGrants() : null; }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || j.format !== GRANTS_FORMAT || !Array.isArray(j.grants)) return null;
    const ok = j.grants.every((g: any) => g && typeof g.id === "string" && typeof g.key === "string"
      && Number.isInteger(g.rounds) && g.rounds >= 1 && g.rounds <= GRANT_MAX && g.by === "owner");
    return ok ? (j as Grants) : null;
  } catch { return null; }
}

// The grants that count for a key: every one made for a key of its group (supersedes, either way).
export function grantsFor(r: Rounds, g: Grants | null, key: string): GrantRec[] {
  if (!g) return [];
  const group = new Set(groupOf(r, key));
  return g.grants.filter((x) => group.has(x.key)).sort((a, b) => a.at.localeCompare(b.at));
}
export const grantedRounds = (list: GrantRec[]) => list.reduce((n, x) => n + x.rounds, 0);

// Cain 0.18.1: a grant counts toward the cap only once a round claimed it, or while its binding still
// matches the change as it is (so the next round may claim it). Why one doesn't count:
export type StaleWhy = "head" | "decision" | "rounds" | "cap" | "unbound";
export const STALE_SHORT: Record<StaleWhy, string> = {
  head: "the pull request moved on", decision: "a newer decision came", rounds: "its rounds moved on",
  cap: "its cap changed", unbound: "it was given before grants were bound",
};
export const STALE_LONG: Record<StaleWhy, string> = {
  head: "it was given for the pull request as it stood then, but the pull request has new commits since",
  decision: "a newer decision on the change came after it was given",
  rounds: "the change's review rounds moved on after it was given",
  cap: "the change's cap changed after it was given",
  unbound: "it was granted before grants were bound to the change as it stood, so it can't be matched to what he approved",
};
export type Standing = {
  counting: GrantRec[];                       // claimed by a round already: count in full
  claimable: GrantRec[];                      // binding matches now: the next round claims them
  waiting: GrantRec[];                        // bound to a head, and the brief named none: not matched, not voided
  stale: { rec: GrantRec; why: StaleWhy }[];  // never count
  // The cap from the base and the claimed grants alone (fourth review): the prior cap a candidate's binding is
  // checked against, never counting the candidate or any other outstanding grant. The link's tap records the
  // same value as the binding's cap.
  prior: number;
};
export const validBinding = (b: any): b is GrantBinding => !!b && typeof b === "object"
  && (b.head === null || (typeof b.head === "string" && /^[0-9a-f]{40}$/.test(b.head)))
  && (b.decision === null || typeof b.decision === "string")
  && Number.isInteger(b.used) && b.used >= 0 && Number.isInteger(b.cap) && b.cap >= 1;
// Which round claimed which grant (the runner's rounds file, RoundRec.claims), across the group: the first round
// to claim each grant id.
export function claimsOf(r: Rounds, key: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of groupOf(r, key)) for (const x of r.changes[k]?.rounds ?? []) for (const id of x.claims ?? []) if (!out.has(id)) out.set(id, x.id);
  return out;
}
// How many rounds of the group claim each grant id. A bound grant is claimed by one round, for all its rounds; a
// grant from before grants were bound is claimed by each round past the base cap the one-time replay debited it for.
export function claimCounts(r: Rounds, key: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of groupOf(r, key)) for (const x of r.changes[k]?.rounds ?? []) for (const id of x.claims ?? []) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}
// The grants of a key's group as they count (sixth review). A grant with a binding is itself. A grant from before
// grants were bound (0.18.0, no binding) counts only for the rounds the one-time replay debited it for (each carries
// its id as a claim), never more: its unused rounds were let go (grants_void, why "unbound"). One the replay hasn't
// handled yet is itself, unbound: it never counts.
export function effectiveGrants(r: Rounds, g: Grants | null, key: string): GrantRec[] {
  const n = claimCounts(r, key);
  return grantsFor(r, g, key).flatMap((x) => validBinding(x.bound) ? [x] : n.get(x.id) ? [{ ...x, rounds: Math.min(x.rounds, n.get(x.id)!) }] : [x]);
}
// head: the pull request's head now, as GitHub gave it to the runner (fourth review: never a brief's own claim),
// null when the brief named none, undefined when not known here (status lines, review.sh's early check, and
// the runner before a claim: the head is checked only when a round claims the grant, against GitHub's head).
export function standing(base: number, r: Rounds, g: Grants | null, key: string, head?: string | null): Standing {
  const list = effectiveGrants(r, g, key);
  const claimed = claimsOf(r, key);
  const counting = list.filter((x) => claimed.has(x.id));
  const prior = base + grantedRounds(counting);
  const used = countedRounds(r, key).length;
  const dec = decisionOf(r, key)?.id ?? null;
  const s: Standing = { counting, claimable: [], waiting: [], stale: [], prior };
  for (const x of list) {
    if (claimed.has(x.id)) continue;
    const voided = r.grants_void?.[x.id];
    const b = x.bound;
    const why: StaleWhy | null = voided ? voided.why
      : !validBinding(b) ? "unbound"
      : b.decision !== dec ? "decision"
      : b.used !== used ? "rounds"
      : b.cap !== prior ? "cap"
      : b.head !== null && typeof head === "string" && head.toLowerCase() !== b.head ? "head"
      : null;
    if (why) s.stale.push({ rec: x, why });
    else if (b!.head !== null && head === null) s.waiting.push(x);
    else s.claimable.push(x);
  }
  return s;
}
// The upgrade's one-time replay of grants written by 0.18.0 (sixth review). None of them carries a binding. For each
// change group, its rounds are replayed in time order. Seventh review: existing claims are reconciled first: a round
// that already carries a claim (of any grant) is never charged again and its claim is never replaced, and each
// pre-binding grant's balance is its rounds less the claims it already has. Then only the unclaimed rounds past the
// base cap (the rounds a claim covers aside: a bound grant's claim covers its rounds, a pre-binding grant's one) debit
// exactly one round each from the earliest pre-binding grant given before that round with rounds left (by grant time,
// then grant id), written as a claim on that round. A round past the cap with no earlier grant left to debit is
// recorded as unclaimed: it debits nothing and never borrows from a later grant. Whatever a pre-binding grant has left
// is then let go (voided, why "unbound"): a fresh grant card is the way to more rounds. Changes r in place, and
// touches neither the grants file nor any bound grant.
// The plan says whether it may be committed: it may not (refused) when it would charge a round twice (a grant with
// more claims than rounds, or a round carrying the same grant twice) or meets an unclaimed round past the cap. The
// runner then commits nothing and reports the plan instead; review.sh sweep-dry-run prints the same lines (planLines).
export type ReplayDecision = { rec: GrantRec; credited: string[]; unused: number; claimed: string[] };
export type ReplayPlan = { decisions: ReplayDecision[]; unclaimed: { key: string; round: string }[]; twice: string[]; refused: boolean };
export function replayUnbound(r: Rounds, g: Grants, base: number, at: string): ReplayPlan {
  const decisions: ReplayDecision[] = [], unclaimed: ReplayPlan["unclaimed"] = [], twice: string[] = [];
  const todo = g.grants.filter((x) => !validBinding(x.bound) && !r.grants_void?.[x.id]);
  const byTime = (a: GrantRec, b: GrantRec) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  const groups = new Map<string, GrantRec[]>();
  for (const x of [...todo].sort(byTime)) {
    const gk = groupOf(r, x.key).join(" ");
    groups.set(gk, [...(groups.get(gk) ?? []), x]);
  }
  for (const mine of groups.values()) {
    const key = mine[0].key;
    const byId = new Map(grantsFor(r, g, key).map((x) => [x.id, x]));
    const had = claimCounts(r, key);
    const claimedBy = new Map<string, string[]>();
    for (const y of countedRounds(r, key)) for (const id of y.claims ?? []) claimedBy.set(id, [...(claimedBy.get(id) ?? []), y.id]);
    const left = new Map(mine.map((x) => [x.id, x.rounds - (had.get(x.id) ?? 0)]));
    for (const x of mine) if (left.get(x.id)! < 0) twice.push(`${x.id} already carries ${had.get(x.id)} claims for its ${x.rounds} round${x.rounds === 1 ? "" : "s"}`);
    const credited = new Map(mine.map((x) => [x.id, [] as string[]]));
    let covered = base;                                  // the rounds the base cap and the claims seen so far cover
    countedRounds(r, key).forEach((y, i) => {
      const ids = y.claims ?? [];
      if (new Set(ids).size !== ids.length) twice.push(`round ${y.id} of ${key} carries the same grant twice`);
      for (const id of new Set(ids)) { const x = byId.get(id); covered += x && validBinding(x.bound) ? x.rounds : 1; }
      if (ids.length || i + 1 <= covered) return;        // claimed already (never charged again), or within the cap
      const c = mine.find((x) => x.at < y.at && left.get(x.id)! > 0);
      if (!c) { unclaimed.push({ key, round: y.id }); return; }
      left.set(c.id, left.get(c.id)! - 1);
      credited.get(c.id)!.push(y.id);
      covered += 1;
      const rec = r.changes[y.key]?.rounds.find((z) => z.id === y.id);
      if (rec) rec.claims = [c.id];
    });
    for (const x of mine) {
      const unused = Math.max(0, left.get(x.id)!);
      if (unused > 0) (r.grants_void ??= {})[x.id] = { why: "unbound", at, key: x.key, rounds: unused };
      decisions.push({ rec: x, credited: credited.get(x.id)!, unused, claimed: claimedBy.get(x.id) ?? [] });
    }
  }
  return { decisions, unclaimed, twice, refused: unclaimed.length > 0 || twice.length > 0 };
}
// The plan in lines, the same for the runner's log and report and for review.sh sweep-dry-run.
export function planLines(p: ReplayPlan, tz?: string): string[] {
  const out: string[] = [];
  if (!p.decisions.length && !p.unclaimed.length && !p.twice.length) out.push("no grant from before grants were bound");
  for (const d of p.decisions) {
    const n = d.rec.rounds;
    out.push(`${d.rec.id} (${n} round${n === 1 ? "" : "s"} for ${d.rec.key}, ${grantWords([d.rec], tz).replace(/^\d+ /, "")}): `
      + `${d.claimed.length ? `already claimed by ${d.claimed.join(", ")}; ` : ""}credit ${d.credited.length ? d.credited.join(", ") : "none"}; let go ${d.unused}`);
  }
  for (const u of p.unclaimed) out.push(`round ${u.round} of ${u.key} is past the base cap with no earlier grant left to debit: recorded as unclaimed, nothing debited`);
  for (const t of p.twice) out.push(`${t}: it would charge a round twice`);
  if (p.refused) out.push("the runner refuses to commit this replay: nothing is claimed or let go, and those grants don't count until it's sorted out");
  return out;
}

// The grants that count now (claimed, or claimable), in time order.
export const countingGrants = (s: Standing) => [...s.counting, ...s.claimable].sort((a, b) => a.at.localeCompare(b.at));
export function effectiveCap(base: number, r: Rounds, g: Grants | null, key: string, head?: string | null): number {
  const s = standing(base, r, g, key, head);
  return s.prior + grantedRounds(s.claimable);
}
// "1 grant no longer counts: the pull request moved on"; "" when every grant counts.
export function staleWords(s: Pick<Standing, "stale">): string {
  if (!s.stale.length) return "";
  const whys = [...new Set(s.stale.map((x) => STALE_SHORT[x.why]))];
  const n = s.stale.length;
  return `${n} grant${n === 1 ? "" : "s"} no longer count${n === 1 ? "s" : ""}: ${whys.join("; ")}`;
}

// "2 granted by Dane on Nov 21", or "3 granted by Dane (Nov 21, Nov 22)"; "" when none.
export function grantWords(list: GrantRec[], tz?: string): string { return grantedNote({ granted: list }, tz); }
// "round 4 of 5, 2 granted by Dane on Nov 21"
export function capWords(round: number, base: number, list: GrantRec[], tz?: string): string {
  const cap = base + grantedRounds(list);
  const g = grantWords(list, tz);
  return `round ${round} of ${cap}${g ? `, ${g}` : ""}`;
}

// What the change's last counted round left, from the runner's own record (never Cain's words):
// serious findings it left, lost, or still running.
export type LastRound = { state: "answered"; serious: number } | { state: "lost" } | { state: "running" } | { state: "none" };
export function lastRound(r: Rounds, key: string): LastRound {
  const done = countedRounds(r, key);
  const x = done[done.length - 1];
  if (!x) return { state: "none" };
  if (x.state === "lost") return { state: "lost" };
  if (x.state === "answered") return { state: "answered", serious: x.serious ?? 0 };
  return { state: "running" };
}

export class GrantUnsaved extends Error {}
// The grants file's owner and mode, at every write and every recreation (first review of 0.18.0): root,
// group cain, 0640, so the runner and review.sh (Cain's user, in group cain) read it and only the link
// writes it. Never a root-only file: the owner and mode are set on the temp file itself (fchown, fchmod),
// before it's renamed into place, whether the file was there or not; if they can't be set, nothing is
// written. Tests pass their own uid and gid (they don't run as root).
export const GRANTS_OWNER = { uid: ROOT_UID, gid: CAIN_GID, mode: 0o640 };
// His tap's grant, kept durably (temp file in the same folder, fsync, rename). The same card tapped again
// (or the same card id) keeps its first grant. Throws GrantUnsaved when it couldn't be kept: the card stays up. A file that
// doesn't parse is never overwritten.
export function recordGrant(path: string, rec: GrantRec,
  o: { sync?: (dir: string) => void; owner?: { uid: number; gid: number } } = {}): { rec: GrantRec; existed: boolean } {
  const g = readGrants(path);
  if (!g) throw new GrantUnsaved("the grants file can't be read or doesn't parse, so nothing was written over it");
  // Idempotent per card (fifth review): a second tap on the same card, a redelivered callback, or the card sent
  // again under a new message keeps the first grant and writes nothing.
  const had = g.grants.find((x) => x.id === rec.id || (!!rec.card && x.card === rec.card));
  if (had) return { rec: had, existed: true };
  g.grants.push(rec);
  const owner = o.owner ?? GRANTS_OWNER;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${rec.id.replace(/[^a-z0-9-]/gi, "_")}.${process.pid}.grant.tmp`);
  try { unlinkSync(tmp); } catch { /* none left from a crash */ }
  try {
    const fd = openSync(tmp, "wx", GRANTS_OWNER.mode);
    try {
      fchownSync(fd, owner.uid, owner.gid);
      fchmodSync(fd, GRANTS_OWNER.mode);          // the umask can't narrow it
      writeSync(fd, JSON.stringify(g, null, 1));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    if (o.sync) o.sync(dirname(path));
    else { try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ } }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone already, or renamed */ }
    throw new GrantUnsaved(`the grant couldn't be written (${String(e).slice(0, 80)})`);
  }
  return { rec, existed: false };
}
