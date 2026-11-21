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
import { countedRounds, groupOf, type Rounds } from "./rounds.ts";

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
};
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
export function effectiveCap(base: number, r: Rounds, g: Grants | null, key: string): number {
  return base + grantedRounds(grantsFor(r, g, key));
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
// keeps its first grant. Throws GrantUnsaved when it couldn't be kept: the card stays up. A file that
// doesn't parse is never overwritten.
export function recordGrant(path: string, rec: GrantRec,
  o: { sync?: (dir: string) => void; owner?: { uid: number; gid: number } } = {}): { rec: GrantRec; existed: boolean } {
  const g = readGrants(path);
  if (!g) throw new GrantUnsaved("the grants file can't be read or doesn't parse, so nothing was written over it");
  const had = g.grants.find((x) => x.id === rec.id);
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
