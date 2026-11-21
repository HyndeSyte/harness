// The review-round cap at the link (Cain 0.16.0; the runner keeps the count, ../review/rounds.ts).
//   - The owner's one decision card when the cap's last round left a serious finding: only the
//     review runner asks for it (root's socket, POST /decision), and the link writes its words here.
//     Its options are fixed, the recommendation first: "Hold it", then "Ship it with that risk".
//   - Cain can't post that card another way: his ask is refused when it offers the decision's options,
//     or names a review round past the cap (a round number above it, or another round for a change
//     already at the cap), the way a Reviewed line not from the service is refused.
//   - His tap on it is kept by the link (/data/link/review-decisions.json) and relayed like any tap.
//     Round 2: kept durably first (temp file in the same folder, fsync, rename, folder fsync), and only
//     then is the card marked used; a write that fails leaves the card tappable. A decisions file that
//     doesn't parse is never overwritten: it's moved aside under a timestamped name, no new tap is
//     written while a moved-aside file stands, and the App's alarm names it.
//     Round 3: the alarm names the copy and the step back (asideStep: remove or rename it as root;
//     writes resume once it's gone, the next sweep clears the alarm); the record as kept is returned
//     and drives the card, the relay and the hold line; a failed write removes its temp file, and stale
//     temp files are swept at the link's start; the guard's log is capped in size and rotated root-side.
//   - A Ship card for a pull request at the cap with its decision open or "Hold it" is refused; with
//     "Ship it with that risk", only while the App's rollback of a bad install is armed for every App
//     it installs, read from the probe's record (/data/probe/rollback-armed.json), never from Cain.
//   - 0.18.0: extra rounds granted by his tap (../review/grants.ts) raise a change's cap. The newest
//     decision counts; a granted round after it that left nothing serious clears the way (the Ship card
//     needs nothing more from the cap), one still running or that left something serious with rounds
//     still to go refuses the card until it settles, and one at the raised cap that left something serious
//     owes a new decision card. A grant never lifts the armed-rollback condition on ship-with-risk.
import { closeSync, fchmodSync, fchownSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { countedRounds, decisionOf, readRounds, type DecisionRec, type Rounds } from "../review/rounds.ts";
import { effectiveCap, readGrants, type Grants } from "../review/grants.ts";
import { CAIN_GID, capPaths, ROOT_UID } from "../capfiles.ts";
import { appendSynced, syncFolder } from "./auth.ts";

export const HOLD = "Hold it";
export const RISK = "Ship it with that risk";
export const DECISION_OPTIONS = [HOLD, RISK] as const;
// Constants (../capfiles.ts); an environment override only in test mode.
const P = capPaths();
export const ROUNDS_FILE = P.rounds;
export const SETTINGS_FILE = P.settings;
export const ARMED_FILE = P.armed;
export const DECISIONS_FILE = P.decisions;
export const GRANTS_FILE = P.grants;
export const GUARD_LOG = P.guardLog;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const clean = (s: string, max: number) => {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
};

// The card's words: what the piece is (the brief's own topic), what the serious finding is (one line),
// the question, and the recommendation first. Round 2: a final round that never produced a result (lost)
// says so instead of a finding; with the rollback not armed, one sentence up front says a Ship would be
// refused until a release arms it, so holding it is the working choice. No counts (the card gate's
// count rule): more than one serious finding is said in words.
export const UNARMED_LINE = "The App's rollback isn't armed yet, so shipping it with the risk would be refused until a release arms it, and holding it is the working choice.";
export const FALLBACK_LINE = "A serious finding remains; see the item";
export function decisionText(d: Pick<DecisionRec, "topic" | "finding" | "round" | "serious"> & { lost?: boolean; unarmed?: boolean }): string {
  const n = d.round >= 0 && d.round < ORDINALS.length ? ORDINALS[d.round] : `round ${d.round}`;
  const lead = d.unarmed ? `${UNARMED_LINE} ` : "";
  const ask = "No more review rounds are allowed for it. Ship it with that risk, or hold it? I recommend holding it until it's fixed.";
  if (d.lost) return `${lead}${clean(d.topic, 120)}: the ${n} and last outside review did not complete, so nothing it would have found is known. ${ask}`;
  const more = d.serious > 1 ? " (it was not the only one)" : "";
  return `${lead}${clean(d.topic, 120)}: the ${n} and last outside review still found something serious${more}: ${clean(d.finding, 160).replace(/[.\s]+$/, "")}. ${ask}`;
}
// The card's words when its full text fails the card gate: a fixed line and the brief's topic.
export function fallbackText(topic: string | null, unarmed = false): string {
  return `${unarmed ? `${UNARMED_LINE} ` : ""}${FALLBACK_LINE}${topic ? `: ${clean(topic, 120).replace(/[.\s]+$/, "")}.` : "."} Ship it with that risk, or hold it? I recommend holding it until it's fixed.`;
}
// The question as Cain's relayed tap line quotes it: the topic only, never the seats' words.
export function decisionSummary(d: Pick<DecisionRec, "topic">): string {
  return `Ship ${clean(d.topic, 120)} with the serious finding its last review round left, or hold it?`;
}

export function roundCapNow(path = SETTINGS_FILE): number {
  try { const j = JSON.parse(readFileSync(path, "utf8")); if (Number.isInteger(j?.round_cap) && j.round_cap >= 1) return j.round_cap; } catch { /* default */ }
  return 3;
}

// Whether Cain's ask names a review round past the cap: refused at the link (Link.ask).
// grants (0.18.0): the owner's grants, so a change with granted rounds left isn't counted as at its cap.
export function namesRoundPastCap(text: string, cap: number, rounds: Rounds | null, grants: Grants | null = null): string | null {
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
      if (countedRounds(rounds, key).length < effectiveCap(cap, rounds, grants, key)) continue;
      const pr = /^pr-(\d+)$/.exec(key);
      const named = pr ? new RegExp(`(/pull/${pr[1]}\\b|pull request #?${pr[1]}\\b|\\bpr #?${pr[1]}\\b|#${pr[1]}\\b)`).test(t) : t.includes(key);
      if (named) return `another round for ${key}, which has had ${countedRounds(rounds, key).length}`;
    }
  }
  return null;
}

export type Decided = Record<string, { choice: string; at: number }>;
// A moved-aside copy beside the file: "<name>.corrupt-<time>".
export function asideOf(path: string): string[] {
  try { return readdirSync(dirname(path)).filter((n) => n.startsWith(`${basename(path)}.corrupt-`)).map((n) => join(dirname(path), n)); }
  catch { return []; }
}
const parseDecided = (text: string): Decided | null => {
  try { const j = JSON.parse(text); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
};
// His taps; {} when there's no file yet; null when it can't be read, doesn't parse, or a copy that
// didn't parse was moved aside (until that's settled no tap counts: the Ship card fails closed).
export function readDecided(path: string): Decided | null {
  if (asideOf(path).length) return null;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? {} : null; }
  return parseDecided(text);
}

// The way back once a moved-aside copy stands (round 3): the step that turns decision writes back on.
// It names the copy; once it's gone (removed, or renamed so its name no longer starts with the
// decisions file's name and ".corrupt-"), the next tap is kept and the link's next sweep clears the alarm.
export function asideStep(aside: string): string {
  return `${aside}: remove it or rename it as root; answers are kept again once it is gone, and the link's next sweep clears the alarm`;
}

// The temp files a tap's write leaves only when the link died mid-write (round 3): swept at the link's
// start. Only the decisions file's own temp names (".<name>.<pid>.tmp") in its folder.
export function tempOf(path: string, pid = process.pid): string { return join(dirname(path), `.${basename(path)}.${pid}.tmp`); }
export function sweepTemps(path: string, log: (m: string) => void = () => {}): number {
  const re = new RegExp(`^\\.${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.tmp$`);
  let n = 0;
  let names: string[] = [];
  try { names = readdirSync(dirname(path)); } catch { return 0; }
  for (const name of names) {
    if (!re.test(name)) continue;
    try { unlinkSync(join(dirname(path), name)); n++; } catch (e) { log(`couldn't remove a stale temp file ${name}: ${String(e).slice(0, 60)}`); }
  }
  if (n) log(`removed ${n} stale temp file${n === 1 ? "" : "s"} of ${basename(path)}`);
  return n;
}

export class DecisionsUnsaved extends Error {}
// His tap, kept durably before the card is marked used (Link.onQuestion). The same decision tapped
// again keeps its first answer (a retry records it once). Throws DecisionsUnsaved when it couldn't be
// kept; a file that doesn't parse is moved aside (never overwritten), and onCorrupt hears its new name.
// Round 3: it returns the record as kept, with existed when one was there before this tap: the caller
// uses that choice, never the label just tapped. A write that fails removes its temp file.
export type Kept = { choice: string; at: number; existed: boolean };
export function recordDecision(path: string, id: string, choice: string, at: number,
    o: { onCorrupt?: (aside: string) => void; sync?: (dir: string) => void; now?: () => number; rename?: (from: string, to: string) => void } = {}): Kept {
  const aside = asideOf(path);
  if (aside.length) throw new DecisionsUnsaved(`his decisions file was moved aside and isn't settled yet (${asideStep(aside[0])})`);
  let text: string | null = null;
  try { text = readFileSync(path, "utf8"); }
  catch (e: any) { if (e?.code !== "ENOENT") throw new DecisionsUnsaved(`his decisions file can't be read (${String(e?.code ?? e).slice(0, 40)})`); }
  let all: Decided = {};
  if (text !== null) {
    const j = parseDecided(text);
    if (!j) {
      const to = `${path}.corrupt-${new Date((o.now ?? Date.now)()).toISOString().replace(/[-:.]/g, "")}`;
      try { renameSync(path, to); } catch (e) { throw new DecisionsUnsaved(`his decisions file doesn't parse, and couldn't be moved aside (${String(e).slice(0, 60)})`); }
      try { o.onCorrupt?.(to); } catch { /* the refusal stands */ }
      throw new DecisionsUnsaved(`his decisions file didn't parse, so it was moved aside to ${to}`);
    }
    all = j;
  }
  const had = all[id];
  if (had && typeof had.choice === "string") return { choice: had.choice, at: Number(had.at), existed: true };
  all[id] = { choice, at };
  const tmp = tempOf(path);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(all, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
    (o.rename ?? renameSync)(tmp, path);
    (o.sync ?? syncFolder)(dirname(path));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone already, or renamed into place */ }
    throw new DecisionsUnsaved(`his decision couldn't be written (${String(e).slice(0, 80)})`);
  }
  return { choice, at, existed: false };
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
// Whether the guard's log (or its one previous file) already has a line with this tag and what: his
// risk tap's hold is written once, even when a tap is retried after a crash (round 3).
export function holdLogged(path: string, tag: string, what: string): boolean {
  for (const f of [path, `${path}.1`]) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const l of text.split("\n")) { const c = l.split("\t"); if (c[1] === tag && c[2] === what) return true; }
  }
  return false;
}

export type CapState =
  | { state: "none" }
  | { state: "unknown"; why: string }
  | { state: "waiting" | "hold" | "risk"; key: string; decision: DecisionRec }
  | { state: "pending"; key: string; decision: DecisionRec; why: string };   // 0.18.0: a granted round after it hasn't settled clean

// Where a pull request stands at the cap: its change group's decision, if any, and his tap on it.
export function capStateFor(pr: string, rounds: Rounds | null, decided: Decided | null): CapState {
  const m = /\/pull\/(\d+)$/.exec(pr);
  if (!m) return { state: "none" };
  if (!rounds) return { state: "unknown", why: "the review rounds file can't be read" };
  const key = `pr-${m[1]}`;
  // A pull request named only on a change's rounds (a plan reviewed under a change key, then built).
  const keys = new Set<string>([key]);
  for (const [k, c] of Object.entries(rounds.changes)) if (c.pr && c.pr.toLowerCase() === pr.toLowerCase()) keys.add(k);
  for (const k of keys) {
    const d = decisionOf(rounds, k);
    if (!d) continue;
    if (!decided) return { state: "unknown", why: "his decisions at the review cap can't be read" };
    // 0.18.0: rounds after the newest decision (granted by his tap) settle it first.
    const later = countedRounds(rounds, k).slice(d.round);
    const last = later[later.length - 1];
    if (last) {
      if (last.state === "answered" && (last.serious ?? 0) === 0) return { state: "none" };
      const why = last.state === "answered" ? `the granted review round after his decision still left something serious`
        : last.state === "lost" ? "the granted review round after his decision was lost, so it has no result"
        : "a granted review round after his decision is still running";
      return { state: "pending", key: k, decision: d, why };
    }
    const tap = decided[d.id];
    if (!tap) return { state: "waiting", key: k, decision: d };
    return { state: tap.choice === RISK ? "risk" : "hold", key: k, decision: d };
  }
  return { state: "none" };
}
export function capState(pr: string, decidedFile: string = DECISIONS_FILE): CapState {
  return capStateFor(pr, readRounds(ROUNDS_FILE), readDecided(decidedFile));
}

// Whether the probe's rollback of a bad install is armed for every App the pull request installs
// (apps: lower-case App names; null when they can't be told: then every App must be armed). The record
// is the probe's: {"armed": {"cain": "<when armed>", "harness": "<when armed>"}}. Missing or unreadable
// is not armed.
export function armedFor(apps: string[] | null, text: string | null): { armed: boolean; why: string } {
  if (text === null) return { armed: false, why: "the probe has no record that its rollback of a bad install is armed (none ships before it does)" };
  let j: any;
  try { j = JSON.parse(text); } catch { return { armed: false, why: "the probe's rollback record can't be read" }; }
  const armed = j?.armed && typeof j.armed === "object" ? j.armed : {};
  const want = apps && apps.length ? apps : ["cain", "harness"];
  const missing = want.filter((a) => typeof armed[a] !== "string" || !armed[a]);
  if (missing.length) return { armed: false, why: `the rollback of a bad install isn't armed for ${missing.map((a) => a[0].toUpperCase() + a.slice(1)).join(" and ")}` };
  return { armed: true, why: "" };
}
export function readArmed(path = ARMED_FILE): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}
