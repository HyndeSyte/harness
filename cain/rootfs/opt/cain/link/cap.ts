// The review-round cap at the link (Cain 0.16.0; the runner keeps the count, ../review/rounds.ts).
// Cain 0.20.0, the owner's review rule (R-013): three rounds a piece, never more; no card offers more rounds
// or a ship with a risk named. The grants of extra rounds, the review service's decision card at the cap and
// the ship-with-risk path (with its armed-rollback condition) are retired.
//   - A Ship card for a pull request at its cap goes only when the change's last round left nothing serious
//     (by the rule's count, review/core.ts seriousLeft), or when the change's one cut check passed: then only
//     for exactly the cut head it checked, naming that check as its review. Otherwise the piece is held by the
//     rule, and the card is refused with a plain line saying so.
//   - Cain can't put a question about rounds, risk or cuts to the owner: his ask is refused when it offers
//     "Ship it with that risk", names a review round past the cap (a round number above it, or another round for
//     a change already at the cap), or asks about more rounds, a risk or a cut (asksAboutCap).
//   - The guard's log stays capped in size and rotated root-side (appendCapped).
//   - The keeper's armed read (keeperArmed, armedFor) stays for the keeper's own checks; no Ship card reads it.
import { closeSync, fchmodSync, fchownSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { countedRounds, cutOf, lastRound, readRounds, type Rounds } from "../review/rounds.ts";
import { CAIN_GID, capPaths, ROOT_UID } from "../capfiles.ts";
import { appendSynced, syncFolder } from "./auth.ts";

// The retired decision card's riskier option (0.16.0 to 0.19.0): an ask offering it is refused.
export const RISK = "Ship it with that risk";
// Constants (../capfiles.ts); an environment override only in test mode.
const P = capPaths();
export const ROUNDS_FILE = P.rounds;
export const SETTINGS_FILE = P.settings;
export const GUARD_LOG = P.guardLog;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const clean = (s: string, max: number) => {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
};

export function roundCapNow(path = SETTINGS_FILE): number {
  try { const j = JSON.parse(readFileSync(path, "utf8")); if (Number.isInteger(j?.round_cap) && j.round_cap >= 1) return j.round_cap; } catch { /* default */ }
  return 3;
}

// Whether Cain's ask names a review round past the cap: refused at the link (Link.ask).
export function namesRoundPastCap(text: string, cap: number, rounds: Rounds | null): string | null {
  const t = String(text ?? "").toLowerCase();
  const past = (n: number) => Number.isFinite(n) && n > cap;
  for (const m of t.matchAll(/\bround\s*(?:#|no\.?|number)?\s*(\d{1,3})\b/g)) if (past(Number(m[1]))) return `round ${m[1]}`;
  for (const m of t.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:\w+\s+){0,2}(?:round|review)\b/g)) if (past(Number(m[1]))) return `round ${m[1]}`;
  for (let i = cap + 1; i < ORDINALS.length; i++)
    if (new RegExp(`\\b${ORDINALS[i]}\\s+(?:\\w+\\s+){0,2}(?:round|review)\\b`).test(t)) return `the ${ORDINALS[i]} round`;
  const i = WORDS.findIndex((w) => new RegExp(`\\b${w}\\s+(?:\\w+\\s+)?(?:review\\s+)?rounds\\b`).test(t) && WORDS.indexOf(w) > cap);
  if (i > 0) return `${WORDS[i]} rounds`;
  // Another round for a change already at the cap, named by its pull request or change key.
  if (rounds && /\b(round|re-?review|review again|another review|more review)/.test(t)) {
    for (const key of Object.keys(rounds.changes)) {
      if (countedRounds(rounds, key).length < cap) continue;
      const pr = /^pr-(\d+)$/.exec(key);
      const named = pr ? new RegExp(`(/pull/${pr[1]}\\b|pull request #?${pr[1]}\\b|\\bpr #?${pr[1]}\\b|#${pr[1]}\\b)`).test(t) : t.includes(key);
      if (named) return `another round for ${key}, which has had ${countedRounds(rounds, key).length}`;
    }
  }
  return null;
}

// Whether Cain's ask puts a question about review rounds, a risk or a cut to the owner (0.20.0): the rule
// has Cain decide those himself, so the link refuses the ask. What it names, or null.
export function asksAboutCap(text: string): string | null {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ");
  if (/\b(more|extra|another|additional|further|fourth|4th)\s+(\w+\s+){0,2}(review\s+)?rounds?\b/.test(t) || /\bgrant\w*\b[^.?!]{0,40}\brounds?\b/.test(t))
    return "more review rounds";
  if (/\b(ship|land|install|merge)\w*\b[^.?!]{0,60}\bwith\s+(that|the|this|a|its)\s+(\w+\s+)?risks?\b/.test(t) || /\b(accept|take|live with)\s+(that|the|this)\s+risk\b/.test(t))
    return "shipping with a risk";
  if (/\bcut\s+check/.test(t) || /\b(cut|remove|drop|strip)\b[^.?!]{0,40}\b(parts?|pieces?|findings?)\b[^.?!]{0,40}\b(serious|review|reviewers?|finding)/.test(t)
    || (/\bserious\s+findings?\b/.test(t) && /\b(cut|hold|ship)\b/.test(t)))
    return "a cut, or what to do with a serious finding";
  return null;
}

// The guard's log, bounded (round 3): one line appended, root-side. When the line would take the file
// past max, the file is first rotated (renamed to "<log>.1", replacing the previous one, so one previous
// file is kept) and a new one made root:cain 0640, as c1/lock.sh makes it. Returns whether it rotated.
export const GUARD_LOG_MAX = 256 * 1024;
export function appendCapped(path: string, line: string, o: { max?: number; sync?: (dir: string) => void;
    own?: (fd: number) => void } = {}): boolean {
  const max = o.max ?? GUARD_LOG_MAX;
  const sync = o.sync ?? syncFolder;
  let size = 0;
  try { size = statSync(path).size; } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  let rotated = false;
  if (size > 0 && size + Buffer.byteLength(line) > max) {
    renameSync(path, `${path}.1`);
    const fd = openSync(path, "a", 0o640);
    try { (o.own ?? ((f) => fchownSync(f, ROOT_UID, CAIN_GID)))(fd); fchmodSync(fd, 0o640); } finally { closeSync(fd); }
    sync(dirname(path));
    rotated = true;
  }
  appendSynced(path, line, sync);
  return rotated;
}
// Whether the guard's log (or its one previous file) already has a line with this tag and what (round 3).
export function holdLogged(path: string, tag: string, what: string): boolean {
  for (const f of [path, `${path}.1`]) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const l of text.split("\n")) { const c = l.split("\t"); if (c[1] === tag && c[2] === what) return true; }
  }
  return false;
}

export type CapState =
  | { state: "none" }                                                  // not at its cap, or nothing serious left: the normal card
  | { state: "unknown"; why: string }
  | { state: "waiting"; key: string; why: string }                     // its last round or its cut check is still running
  | { state: "held"; key: string; why: string }                        // held by the rule: no Ship card
  | { state: "cut"; key: string; id: string; head: string; seat: string };   // its cut check passed: only that head, naming it

// Where a pull request stands at the cap (0.20.0), from the runner's own record only (never Cain's words):
// at its cap, its change group's last round and its one cut check decide.
export function capStateFor(pr: string, rounds: Rounds | null, cap = 3): CapState {
  const m = /\/pull\/(\d+)$/.exec(pr);
  if (!m) return { state: "none" };
  if (!rounds) return { state: "unknown", why: "the review rounds file can't be read" };
  const key = `pr-${m[1]}`;
  // A pull request named only on a change's rounds (a plan reviewed under a change key, then built).
  const keys = new Set<string>([key]);
  for (const [k, c] of Object.entries(rounds.changes)) if (c.pr && c.pr.toLowerCase() === pr.toLowerCase()) keys.add(k);
  for (const k of keys) {
    if (countedRounds(rounds, k).length < cap) continue;
    const last = lastRound(rounds, k);
    if (last.state === "running" || last.state === "none") return { state: "waiting", key: k, why: "its last review round is still running" };
    if (last.state === "lost") return { state: "held", key: k, why: "its last review round was lost, so nothing serious is known to be gone" };
    if (last.serious === 0) continue;
    const c = cutOf(rounds, k);
    if (!c) return { state: "held", key: k, why: "its last review round left something serious, and it has no passing cut check" };
    if (c.state === "started") return { state: "waiting", key: k, why: "its cut check is still running" };
    if (c.state !== "pass") return { state: "held", key: k, why: `its last review round left something serious, and its one cut check ${c.state === "fail" ? "failed" : "has no answer"}` };
    return { state: "cut", key: k, id: c.id, head: c.head.toLowerCase(), seat: c.seat };
  }
  return { state: "none" };
}
export function capState(pr: string, cap = roundCapNow()): CapState {
  return capStateFor(pr, readRounds(ROUNDS_FILE), cap);
}

// Whether the rollback of a bad install is armed for every App the pull request installs (apps:
// lower-case App names; null when they can't be told: then every App must be armed). The text is the
// one keeperArmedText builds from the keeper's replies: {"armed": {"cain": "<when armed>"}, "why": {...}}.
// Missing or unreadable is not armed.
export function armedFor(apps: string[] | null, text: string | null): { armed: boolean; why: string } {
  if (text === null) return { armed: false, why: "the keeper has no record that its rollback of a bad install is armed (none ships before it does)" };
  let j: any;
  try { j = JSON.parse(text); } catch { return { armed: false, why: "the keeper's rollback record can't be read" }; }
  const armed = j?.armed && typeof j.armed === "object" ? j.armed : {};
  const want = apps && apps.length ? apps : ["cain", "harness"];
  const missing = want.filter((a) => typeof armed[a] !== "string" || !armed[a]);
  const told = missing.map((a) => typeof j?.why?.[a] === "string" ? j.why[a].replace(/[^\x20-\x7e]/g, " ").slice(0, 120) : "").filter(Boolean);
  if (missing.length) return { armed: false, why: `the rollback of a bad install isn't armed for ${missing.map((a) => a[0].toUpperCase() + a.slice(1)).join(" and ")}${told.length ? ` (${[...new Set(told)].join("; ")})` : ""}` };
  return { armed: true, why: "" };
}

// -- the keeper's armed state (0.19.0) ----------------------------------------------------------------
// The link asks the keeper App every minute (GET /armed?app=<slug>, Cain's own token) for each App and
// keeps the replies; each use judges them as they stand then. Not armed: a refused token, any error, a
// reply that isn't for that App, a timestamp older than 2 minutes, or a binding that doesn't match (the
// verdict protocol, the backup scope, the keeper's version as it says it, and for Cain the hash of the
// verdict probe installed here, which must be the one the drills ran with).
export const KEEPER_SLUGS: Record<string, string> = { cain: "0fcc2575_cain", harness: "0fcc2575_harness" };
export const ARMED_PROTOCOL = 1;
export const ARMED_SCOPE = "app-only";
export const ARMED_MAX_AGE_MS = 120_000;
export type KeeperReply = { status: number; body: string } | { error: string };
export function keeperArmed(app: string, reply: KeeperReply | undefined, now: number, probeHash: string | null): { armed: boolean; why: string; at?: string } {
  const slug = KEEPER_SLUGS[app] ?? app;
  if (!reply) return { armed: false, why: "the keeper hasn't been asked yet" };
  if ("error" in reply) return { armed: false, why: `the keeper didn't answer (${reply.error.slice(0, 60)})` };
  if (reply.status === 401 || reply.status === 403) return { armed: false, why: "the keeper refused Cain's token" };
  if (reply.status !== 200) return { armed: false, why: `the keeper answered ${reply.status}` };
  let j: any;
  try { j = JSON.parse(reply.body); } catch { return { armed: false, why: "the keeper's answer isn't JSON" }; }
  const b = j?.binding ?? {};
  const at = typeof j?.at === "string" ? Date.parse(j.at) : NaN;
  if (j?.app !== slug) return { armed: false, why: "the keeper's answer is for another App" };
  if (!Number.isFinite(at) || now - at > ARMED_MAX_AGE_MS || at - now > 60_000) return { armed: false, why: "the keeper's answer is stale (its timestamp is older than 2 minutes)" };
  if (b.protocol !== ARMED_PROTOCOL || b.backup_scope !== ARMED_SCOPE || typeof j.keeper_version !== "string" || !j.keeper_version || b.keeper_version !== j.keeper_version
    || typeof b.options_hash !== "string" || !b.options_hash || typeof b.probe_hash !== "string" || !b.probe_hash)
    return { armed: false, why: "the keeper's binding doesn't match" };
  if (app === "cain" && (!probeHash || b.probe_hash !== probeHash)) return { armed: false, why: "the keeper's drills ran with another verdict probe than the one installed" };
  if (j.armed !== true || typeof j.armed_at !== "string") return { armed: false, why: `the keeper says it isn't armed${typeof j.why === "string" && j.why ? ` (${j.why.slice(0, 120)})` : ""}` };
  return { armed: true, why: "", at: j.armed_at };
}
// The text armedFor reads, from the replies as they stand now.
export function keeperArmedText(replies: Record<string, KeeperReply | undefined>, now: number, probeHash: string | null): string {
  const armed: Record<string, string> = {}, why: Record<string, string> = {};
  for (const app of Object.keys(KEEPER_SLUGS)) {
    const a = keeperArmed(app, replies[app], now, probeHash);
    if (a.armed) armed[app] = a.at!; else why[app] = a.why;
  }
  return JSON.stringify({ armed, why });
}
