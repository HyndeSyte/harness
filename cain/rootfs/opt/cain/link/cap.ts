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
//   - A Ship card for a pull request at the cap with its decision open or "Hold it" is refused; with
//     "Ship it with that risk", only while the App's rollback of a bad install is armed for every App
//     it installs, read from the probe's record (/data/probe/rollback-armed.json), never from Cain.
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { countedRounds, decisionOf, readRounds, type DecisionRec, type Rounds } from "../review/rounds.ts";
import { capPaths } from "../capfiles.ts";
import { syncFolder } from "./auth.ts";

export const HOLD = "Hold it";
export const RISK = "Ship it with that risk";
export const DECISION_OPTIONS = [HOLD, RISK] as const;
// Constants (../capfiles.ts); an environment override only in test mode.
const P = capPaths();
export const ROUNDS_FILE = P.rounds;
export const SETTINGS_FILE = P.settings;
export const ARMED_FILE = P.armed;
export const DECISIONS_FILE = P.decisions;
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

export class DecisionsUnsaved extends Error {}
// His tap, kept durably before the card is marked used (Link.onQuestion). The same decision tapped
// again keeps its first answer (a retry records it once). Throws DecisionsUnsaved when it couldn't be
// kept; a file that doesn't parse is moved aside (never overwritten), and onCorrupt hears its new name.
export function recordDecision(path: string, id: string, choice: string, at: number,
    o: { onCorrupt?: (aside: string) => void; sync?: (dir: string) => void; now?: () => number } = {}): { choice: string; at: number } {
  const aside = asideOf(path);
  if (aside.length) throw new DecisionsUnsaved(`his decisions file was moved aside (${aside[0]}) and isn't settled yet`);
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
  if (all[id]) return all[id];
  all[id] = { choice, at };
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(all, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    (o.sync ?? syncFolder)(dirname(path));
  } catch (e) { throw new DecisionsUnsaved(`his decision couldn't be written (${String(e).slice(0, 80)})`); }
  return all[id];
}

export type CapState =
  | { state: "none" }
  | { state: "unknown"; why: string }
  | { state: "waiting" | "hold" | "risk"; key: string; decision: DecisionRec };

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
