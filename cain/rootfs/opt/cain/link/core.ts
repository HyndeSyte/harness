
// Cain's link to Dane on Discord, for everything his plugin can't do: taps,
// reactions, and cards. Plain code, no model.
//
// - Specialists (the Harness add-on, for calendars) hand cards here. A card waits
//   until Cain shows it, unchanged; Cain is told it's waiting. A card with buttons goes
//   out within about 2 minutes even if Cain is busy: if he hasn't shown it by then, the
//   sweep posts it by itself, under no item, and tells him; his later show only files
//   it under his item and question. If it can't go out, or its own expiry passes first
//   (then it never goes out), Cain is told once, with what it was. Only Stop notices
//   and "Cain can't reach you" alerts go straight out ("direct"). A specialist's card is
//   the specialist talking to the owner: the item Cain files it under is only a label,
//   so it goes out whoever holds that item, and whether or not the item is closed.
// - Every tap is checked here, within Discord's 3 seconds: Dane (the bot's owner,
//   who must also be the one Cain is paired with), in his DM, on a message this
//   link posted, still showing exactly what it posted (Cain can edit the bot's
//   messages, so a rewritten card is refused). A tap on a specialist's card goes
//   back to that specialist, which applies its own checks. A tap on Cain's own
//   question, and any reaction of Dane's to the bot's messages, go to Cain.
// - Every card knows its item (a PENDING id, or "none"), its question and when it
//   stops mattering. A sweep every minute takes the buttons off cards that were
//   answered, expired, or replaced by a newer card for the same item and question,
//   and off Cain's own asks and Ship cards whose item closed or is held by someone
//   other than Cain, and says so on the card. A specialist's card never loses its
//   buttons to a hold or a closed item. A tap on a card that stopped mattering is
//   answered in place: "This card expired; nothing was done."
// - Cain asks one question at a time: a new ask waits while another is open, and goes
//   out by itself when that one closes. Ship cards and specialists' cards don't wait.
// - Stop (wave 1, piece E): Dane's Stop tap, from any card of ours, stops everything:
//   the calendar specialist (the tap goes on to it, as before), Cain's Build and Ship
//   runs, his Ship cards and outside-review sends (../stop.ts). Only Dane's Turn back
//   on tap undoes it, from a card the link posted and still knows as live; Cain has no
//   command for it. Its notice says what stopped.
// - Ship (wave 1, piece B): main is locked so only the link's deploy key can update it
//   (deploykey.ts, RELEASING.md). His Ship tap lands that pull request's head in main,
//   here, after the checks in merge.ts, one at a time, and never while stopped; his card
//   then says how it went. A Ship card carries a line of the link's own, from GitHub:
//   how much the pull request changes and the parts that matter most. Once it's in
//   main, the tap is signed (../ship-token.ts) with a key only the link is meant to read
//   (shipkey.ts), for that pull request and head, good for 2 hours: Cain's Ship run,
//   which installs it, needs that token.
// - Cards as data (piece D): every message the link posts records the labels of its
//   buttons, kept after they come off, and Cain's lines and answers name them. The link
//   publishes the cards (no text) for the reply hook, with the ids of Cain's own replies
//   (the only messages he may edit), and reads any message back from Discord for
//   keeper.sh card.
// - The gate (piece D, ../gate/rules.ts), enforcing since 0.10.0. Cain's words through the
//   link (asks and their options, Ship cards, the morning message, the connector notice):
//   "add-on" fixed before anything is posted, and the answer says so; any em dash (only he
//   knows whether he meant a range or a break), a hidden count, machine text, or a button
//   the card lacks refused. The specialist's cards: fixed and posted, never refused (a
//   refused card would be lost to him), an em dash made ", " only between plain words and
//   any other kept as it is; Cain hears once what the gate flagged.
//   Its notes after a tap, and the link's own words: fixed only. Every hit is logged, its
//   excerpt with links cut to their host. The replay runs the same rules over his DM,
//   reading only. Cain's edit allowlist holds his replies alone: never a message the link
//   knows as its own, whatever a note or a transcript says. Since 0.11.0 (../gate/cain.ts),
//   a Reviewed line in his asks, their options, the morning message and the connector
//   notice must be one the review service gave, word for word, and his line on a Ship card
//   may claim no checks or review: the link adds those itself.
// - Ship cards built from GitHub and the review service (0.11.0): the question names each
//   App and version the tap installs, a line from GitHub has the pull request's title, how
//   much it changes, the parts that matter most and its checks (read as the landing reads
//   them: a failed check, or one not run yet, refuses the card; merged at that head, it's in
//   main already), and the last line is the review service's own for the review Cain names,
//   which must be a review of that very head. Cain's words say only what Dane will notice, on
//   one line. Anything going wrong while the new lines are built gives the card as it was
//   (never no card).
// - Stop within reach (0.10.0): one red Stop on its own row sits on the newest plain bot
//   message (Cain's reply, or a notice of the link's, that asks nothing), never on an ask,
//   a Ship card, a specialist's card, the connector notice, a permission prompt or the
//   morning message. Notices carry it when posted; Cain's replies get it when the
//   PostToolUse hook (../hooks/discord-sent.ts) says what went out. It moves only when
//   none of the newest 5 bot messages carries a Stop, Stop first on the new message and
//   then off the old; moves wait for a quiet channel, in the same queue as his Stop taps
//   and the notices that may carry it, so none lands with Stop once he has stopped. Only
//   Discord refusing a message (a 4xx) three times retires it as a holder; when Discord
//   doesn't answer, moves back off and try again. While stopped it comes off, and Turn
//   back on is kept within reach instead, even when the Stop state can't be read. After
//   Turn back on, the notice's own Stop is the one until it's out of reach; when the moving
//   Stop then goes onto a newer message, the notice's comes off.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Landings } from "./landings";
import { cainReasons, type CainHit, claimsReview, codesHits, mayHaveCode, recordItems, reviewedHits, shipWordsHits } from "../gate/cain";
import { asksSomething, snowflakeTime } from "../gate/plugin";
import { decideSend, type CardsView, type CardView, type Decision, type Writer } from "../gate/send";
import { AT, check as gateCheck, type Context, fixedWhat, type Hit, hostsOnly, reasonParts, RULES, RULES_VERSION, whyOf } from "../gate/rules";
import { safeId } from "../review/core";
import { freshReviewed, type Reviewed } from "../reviewed";
import { claimFor, type Claim, SHIP_REPOS } from "../ship-token";
import type { StopState } from "../stop";
import { judgeChecks, type Facts, type Landed } from "./merge";
import { checkTextProblem, freshByDiscord, generationOf, inStep, isFresh, MAX_ONE_OFF_REASON, maxCheckDays, ONE_OFF_SUMMARY, oneOffHit, oneOffLoose, parseChecks,
  repeatsCheck, staleAfter, type Checks } from "../record/core";
import type { Verdict } from "../clock";
import { appendLog, readLog } from "../applog";
import { appendInstall, installResults, installState } from "../installflag";

export const STOP = "k:stop";
export const RESUME = "k:resume";
export const EXPIRED_TAP = "This card expired; nothing was done.";
export const EXPIRED = "Expired";
export const REPLACED = "Replaced by a newer card";
const COMPONENT = 3;
const ACK = 6;
const UPDATE = 7;
const EPHEMERAL = 64;
const REMEMBER_MS = 35 * 86400_000;
const DAY = 86400_000;
// Round 18: the longest a card lasts (an ask or Ship card lasts until the next morning check-in, or the one after).
export const CARD_LIFE_MAX_MS = 3 * DAY;
const HOUR = 3_600_000;
const FACTS_MS = 6_000;                  // how long a Ship card waits for GitHub (its facts and checks, asked at once) before it says it couldn't read them
const SETTLE_MS = 10 * 60_000;           // a message younger than this may still be on its way into the state
const HEAD_EVERY_MS = 5 * 60_000;        // how often a Ship card's pull request is looked at
const LANDING_STALE_MS = 5 * 60_000;     // a landing still unsettled this long after his tap was cut off (a restart)
const LANDING_TRY_MS = 2 * 3_600_000;
// An orphaned landing (or a restored ledger's key) the remote can't settle yet: looked for again from
// the sweep on a bounded backoff (1, 2, 4, then every 5 minutes), needing no tap or restart. After
// UNRESOLVED_TELL_FAILS failures or UNRESOLVED_TELL_MS since the first, Dane gets one line on the
// card's thread and Cain one line, once each; keeper.sh clock lists the key, its age and last error.
export const UNRESOLVED_TELL_FAILS = 5;
export const UNRESOLVED_TELL_MS = 15 * 60_000;
const UNRESOLVED_BACKOFF_MAX_MS = 5 * 60_000;
// How long an issued tap key stays listed for the record keeper (round 10), unless its landing is
// unresolved. Round 12: a key's whole actionable life, until consumed or tombstoned (90 days) plus a
// margin, the same in the link's issued-key log, its state and the keeper's mirror.
export const TAP_ISSUED_KEEP_MS = 100 * DAY;
// Round 12: after the first per-thread reminder, one digest of every unresolved key a day for a week,
// then once a week.
export const UNRESOLVED_DIGEST_DAILY_MS = 7 * DAY;
export const WEEK = 7 * DAY;
// Round 11: an unresolved landing key, after its first line to him, is told again once a day with the
// exact settle message he can send; past UNRESOLVED_ALERT_MS Cain gets one alert line; past
// UNRESOLVED_TOMB_MS it becomes a tombstone: its record is kept (state, ledger, issued key), it is listed
// as such, and it no longer blocks a new Ship card for that pull request and head.
export const UNRESOLVED_REMIND_MS = DAY;
export const UNRESOLVED_ALERT_MS = 7 * DAY;
export const UNRESOLVED_TOMB_MS = 90 * DAY;
// How long a Discord message id used for a hand settle is remembered as consumed (round 11). The landing
// ledger keeps it too, with the settled entry, outside the link's state.
const SETTLE_SAID_KEEP_MS = 120 * DAY;
    // while GitHub doesn't answer, a landing is tried again this long after his tap
const KEY_CHECK_MS = DAY;                // how often the link asks GitHub whether it still knows the deploy key
const LANDING_LINE = "You tapped Ship: landing it in main now.";
const STOPPED_FIRST: Landed = { ok: false, why: "his Stop came first", again: false, stopped: true };
const HISTORY_PAGES = 5;                 // the one-time look over his DM: up to 500 messages back
const ASK_GRACE_MS = 2 * 3_600_000;      // an ask lives until the first morning check-in at least this far off
const SHOW_WAIT_MS = 2 * 60_000;         // a card with buttons Cain hasn't shown by then goes out by itself
export const CONNECTOR_URL = "https://claude.ai/customize/connectors";   // Claude's Connectors page, where one is signed in again
export const CONNECTOR_LABEL = "Open connector settings";
const CONNECTOR_ONCE_MS = 12 * 3_600_000;  // one notice about the connector per item in this long
const REPLAY_PAGES = 60;                 // the replay reads at most this many pages of 100 messages
const REPLAY_TRIES = 5;                  // a page Discord rate-limits is asked again this often
const STOP_REACH = 5;                    // the moving Stop moves only when none of this many newest bot messages carries one
const RESUME_REACH = 2;                  // while stopped, Turn back on is re-posted when it isn't on one of this many
const QUIET_MS = 60_000;                 // moves wait this long after Discord rate-limited the link
const HOLD_TRIES = 3;                    // a message Discord refuses Stop on this often (a 4xx) is skipped
const MOVE_WAITS_MS = [1, 2, 5, 10].map((m) => m * 60_000);   // after Discord didn't answer a move: the waits, the last one repeating
const REPOST_GAP_MS = 10 * 60_000;       // while stopped, his writing brings Turn back on down at most this often
const RESUME_GRACE_MS = 60_000;          // his Stop's own notice gets this long before the link posts one itself
const NAME_WAIT_MS = 800;                // the reply hook's read of the cards waits this long for Discord to name his DM
const MOVED = "stop moved";              // a message's Stop moved on: its buttons come off, with no line
const REPOSTED = "moved down";           // an older Stopped notice, once a newer one carries Turn back on
export const STILL_STOPPED = "**Still stopped.** Cain's Build and Ship jobs, Ship cards and outside reviews stay stopped, and nothing lands in main, until you tap Turn back on.";
// Machine text he never sees on a card: a full sha, a job's session id, an ISO time.
const MACHINE: [RegExp, string][] = [[/\b[0-9a-f]{40}\b/i, "a commit sha"], [/\bcse_[A-Za-z0-9]/, "a job id"],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "an ISO time"]];
const LIMIT = 2000;
const SUPPRESS_EMBEDS = 1 << 2;
const DIRECT_KINDS = new Set(["stopped", "resumed", "alert"]);
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const QUESTION = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,39}$/;
const SNOWFLAKE = /^\d{15,22}$/;
const SHA = /^[0-9a-f]{40}$/;
export const PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

export type Rest = (method: string, path: string, body?: unknown, auth?: boolean, timeoutMs?: number) => Promise<any>;

export interface Card {
  text: string; rows: any[]; kind: string; created: number; shown: string | null; expires?: number | null;
  due?: number | null;               // when it goes out by itself if Cain hasn't shown it (cards with buttons, from 0.7.2)
  outcome?: "expired";               // its own expiry passed before it went out: it never goes out
  posting?: Posting;                 // a post whose answer never came: it may be on Discord already
  told?: boolean;                    // Cain was told it couldn't go out by itself
  lapseTold?: boolean;               // Cain was told it expired before it reached him
}
// A card's post that began and never heard back: when (at), its buttons then (rows, as a
// digest), who made it (the link by itself, or Cain's show) and the item it went under.
export interface Posting { at: number; rows: string; byItself: boolean; item: string; question: string }
// plain (0.10.0): one of Cain's replies that holds, or held, the moving Stop.
export type Kind = "ask" | "ship" | "card" | "morning" | "legacy" | "notice" | "plain";
export interface Shown {
  digest: string; until: number; card?: number;
  labels?: string[];                 // its buttons' labels as last posted or edited, kept once they come off (0.9.0)
  off?: number;                      // when its buttons came off (0.9.0)
  asks?: boolean;                    // a notice whose last line asks something: never holds the moving Stop (0.10.0)
  gone?: boolean;                    // Discord no longer has it (a 404 putting Stop on it): never holds it again
  q?: { q: string; options: string[]; used: boolean };
  unarmed?: boolean;                 // round 13: its buttons' edit failed when it was posted; put on at the next start
  rearmed?: number;                  // round 14: its record saved again at a start, before its buttons' retried edit
  // Round 15: a line on the card while the record keeper's consumed set is unverified, edited away once it is
  // verified: "ship" (a Ship tap not taken yet; nothing of the tap is kept) or "rearm" (a start's re-arm waits).
  checking?: "ship" | "rearm";
  kind?: Kind;                       // absent on records from before 0.7.0 until the first sweep
  item?: string; question?: string;  // what the card is about: a PENDING id (or "none") and a question id
  posted?: number;
  expires?: number | null;           // when its buttons stop mattering; null: no time of its own
  ship?: { pr: string; head: string };
  checked?: Ref;                     // an ask or Ship card for an item: the accepted source check it rests on (0.12.0)
  own?: string;                      // a Ship card the link built: Cain's own line on it, the rest being the link's (0.11.0)
  buttons?: boolean;                 // it has buttons on Discord, as far as the link knows
  outcome?: "answered" | "expired" | "replaced";
  why?: string;                      // for the log: what made it expire
  label?: string;                    // answered: the label he tapped
  words?: boolean;                   // answered in a message, not a tap
  byItself?: boolean;                // a specialist's card that went out by itself; Cain's show then files it
  // His Ship tap, landing in main (0.8.1): when it began, how it ended, and the card's
  // words before it, for the line that says how it went.
  // tombstone (round 11): unresolved past UNRESOLVED_TOMB_MS; its record kept, no longer blocking.
  shipping?: { state: "landing" | "landed" | "not landed" | "tombstone"; at: number; text: string; why?: string;
    tries?: number; next?: number;    // it can't land yet: how often it was tried, and when it's tried next
    line?: string; edited?: boolean;   // the line his card shows now, and whether Discord took that edit
    key?: string;                      // the tap's idempotency key: its landing is claimed once by it in the link's landing ledger
    base?: string;                     // main's tip when its landing was claimed: settlement searches from it to the remote tip
    abandoned?: boolean };             // settled as not landed after a restart cut it off: a new card follows
  toggle?: string;                   // the link's own Stop notice: the button it carries (STOP or RESUME)
}
export interface Ask {               // Cain's question waiting behind the open one
  text: string; options: string[]; item: string; question: string; replyTo?: string; at: number; expires: number;
  nonce?: string;                    // the same on every try, so Discord never posts it twice
}
export interface State {
  owner?: string; dm?: string; bot?: string; next: number;
  cards: Record<string, Card>; messages: Record<string, Shown>;
  held?: Ask[];
  migrated?: boolean;                // the one-time look over cards posted before 0.7.0 is done
  toggle?: string;                   // a Stop or Turn back on the calendar specialist didn't take yet (0.8.0)
  // The daily check that GitHub still knows the deploy key (0.8.1): when, whether it was
  // refused, and since when GitHub hasn't answered at all.
  key?: { checked: number; refused?: boolean; unanswered?: number; toldUnanswered?: boolean };
  replayed?: number;                 // when the gate's replay last finished: his whole range, or its page cap (0.9.0)
  replayedRules?: number;            // the rules version that replay ran with (0.10.0; absent: 1, if it ran)
  labelled?: boolean;                // the labels of cards from before 0.9.0 were filled in, once
  // Cain's own replies (0.10.0), 35 days: the only messages he may edit, and where the
  // moving Stop can sit. From the PostToolUse hook, and seeded from his transcripts.
  sent?: Record<string, SentRec>;
  seeded?: number;                   // when his transcripts were last read for them
  stopAt?: string;                   // the message holding the moving Stop
  repostedAt?: number;               // while stopped: when Turn back on was last re-posted
  hisAt?: number;                    // the newest message of his the link heard of (a reply of Cain's answered it)
  ledgerGen?: number;                // the highest ledger generation a verified read has seen (0.12.0)
  postedGen?: number;                // the highest ledger generation on a card the link posted (the keeper's floor after a re-clone)
  // Taps honoured while the keeper's ledger was unpushed (0.12.0): if the keeper then resets its
  // copy, Cain and Dane hear of them as acted on a check that may not have landed. Cleared once
  // a push lands.
  uncertain?: Uncertain[];
  outageTold?: string;               // the keeper outage (its start) Dane was told of, once
  unverifiedTold?: string;           // round 13: the keeper's unverified consumed set (its start) Dane was told of, once
  // Round 14: the owner-line proposals (install taps on <nonce>, recover logs <nonce>): each bound to a fresh
  // nonce, the keeper's epoch and this start's run nonce; used: the message of his that used it.
  ownerProposals?: { kind: "install" | "recover"; nonce: string; epoch: number; run: string; at: number; msg?: string; used?: string }[];
  // Round 17: his history lines (sent while the link was down) already answered as offline, by message id.
  offlineTold?: Record<string, number>;
  // Round 17: the verification tuple (keeper start, link run, fetch count) whose arming re-checks last completed.
  verifyChecked?: string;
  // Round 17: the link run whose pending verification Cain was told about (VERIFY_PENDING_MS).
  pendingTold?: string;
  expiredLandings?: Record<string, { since: number; at: number }>;   // round 13: tombstones past 100 days, by tap key id
  // The generation of the card about to be posted, written durably before the post (0.12.0), so the
  // keeper's floor covers a card whose post went out but whose record never got saved.
  intendedGen?: number;
  // Honoured taps by idempotency key (0.12.0): claimed (written before anything is done), acted
  // (Cain was told, or the landing began), edited (the card shows it). A retap or a Discord retry
  // with the same key returns the recorded outcome; a restart finishes a claim from here.
  taps?: Record<string, TapClaim>;
  journalProbe?: number;             // the smoke test's journal write during a stalled read
  landingCount?: number;             // how many keys this link claimed in its landing ledger (a ledger behind it came back from a backup)
  ledgerPruned?: number;             // when settled landing keys were last pruned
  // Round 9: the link's run counter, raised by one on each start of this version (a claim records
  // the run it was made in; one from an earlier run is judged by the live-tap predicate, never by
  // file times); landings the remote can't settle yet, by tap key; and the link's re-check queue,
  // items whose tap was lost or not acted on, until a new check of the item is accepted.
  run?: number;
  runNonce?: string;
  // Round 10: each tap key the link issued, by its short form (tap-<12 hex>), with its card's item, kind
  // and tapped label, written in the same save as the tap's claim, before Cain hears of it. The record
  // keeper reads it from this file and refuses a tap key it doesn't list, or one whose item or kind
  // doesn't match the request. Kept TAP_ISSUED_KEEP_MS, and never pruned while its landing is unresolved.
  // Round 11: with the card's message id and a structured target (the item and the writes the tap
  // allows: row-close, ship-take, decision), which the keeper matches, never the request's text.
  issued?: Record<string, IssuedKey>;
  unresolved?: Record<string, Unresolved>;
  // Round 11: unresolved keys past UNRESOLVED_TOMB_MS, kept as they were with when they became tombstones.
  tombstones?: Record<string, Unresolved & { tomb: number }>;
  // Round 11: Discord ids of his messages a hand settle used (consumed: refused on reuse), with the key.
  settleSaid?: Record<string, { tap: string; at: number }>;
  // Round 11: the keeper's tap notices (a tap-derived request refused, or lost to a restore of this
  // state) already told to him, by tap key and kind, with when.
  tapNoticed?: Record<string, number>;
  recheck?: Record<string, { at: number; why: string; key?: string }>;
  // Round 12: when the last digest of unresolved landings went to him (daily for a week, then weekly).
  unresolvedDigestAt?: number;
  // Round 12: Ship taps land only once this is on (keeper.sh install-taps on, after the post-install
  // tests); once: exactly one Ship tap is let through (the smoke test's pull-the-plug case).
  installTaps?: { on: boolean; at: number; once?: boolean };
}
// stage "lost": the tap rested on a check that didn't survive a reset of the record, so it was never
// acted on past the reset; told: Dane (on the card's thread) and Cain (a relayed line) heard so.
// item, req, epoch and words: the card's item, the check it rested on, its reset epoch and its words.
export interface TapClaim { at: number; msg: string; label: string; stage: "claimed" | "acted" | "edited" | "lost"; outcome: string; shown: string; line?: string;
  item?: string; req?: string | null; epoch?: number; words?: string; told?: boolean; ref?: Ref; kind?: string;
  run?: number;                      // the link run the claim was made in (round 9), for the log
  nonce?: string;                    // that run's nonce (round 10): a claim whose nonce isn't the current run's is an earlier-run claim
  why?: string;                      // stage "lost": why (a reset, or not acted after a restart)
  it?: string }                      // round 18: the tap's interaction id: Discord's time for it, by which a claim is judged after a restart
export interface Unresolved { since: number; fails: number; last: string; next: number; what: "orphan" | "ledger"; msg?: string; told?: boolean;
  toldAt?: number; reminded?: number; alerted?: number }   // round 11: when he was first told, last reminded, and Cain alerted (7 days)
// Round 11: an issued tap key's structured target: the card's item and the kinds of write its tap allows.
export type TapWrite = "row-close" | "ship-take" | "decision";
export interface TapTarget { item: string; writes: TapWrite[] }
export interface IssuedKey { item: string; kind: string; label: string; at: number; msg?: string; target?: TapTarget; it?: string }   // it (round 18): the tap's interaction id
// What a tap on a card allows (round 11): a Ship card's Ship tap a take for the Ship job; its other
// buttons, and a question's, a decision; a question about an item also closing that item's row.
export function tapTarget(item: string, kind: string, label: string): TapTarget {
  const it = (item || "none").toUpperCase();
  if (kind === "ship") return { item: it, writes: label === "Ship" ? ["ship-take"] : ["decision"] };
  return { item: it, writes: it === "NONE" ? ["decision"] : ["row-close", "decision"] };
}
// The exact message he sends to settle a landing by hand (round 11).
export const settleForm = (kid: string, how: "landed" | "not-landed") => `settle ${kid} ${how}`;
// Round 12: his message as copied from the reminder on a phone, normalised: a code fence or the
// backticks around it taken off, non-breaking and other Unicode spaces made plain spaces, zero-width
// characters dropped, an en or em dash (or another dash a keyboard substitutes) read as a hyphen, case
// ignored, spacing collapsed, and one closing full stop or exclamation mark dropped.
export function settleNormalise(content: string): string {
  let t = String(content ?? "");
  t = t.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "");
  t = t.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  t = t.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-");
  t = t.trim();
  const fence = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  t = t.trim().replace(/^`+|`+$/g, "");
  return t.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "").trim();
}
// Whether his message settles that key that way (round 11): null when it is exactly the settle form for
// it, else the plain reason it doesn't, with what was received (normalised, round 12). The key match and
// the single verdict stay strict; only copying's noise is forgiven (settleNormalise).
export function settleWordsProblem(content: string, kid: string, how: "landed" | "not-landed"): string | null {
  const t = settleNormalise(content);
  const got = ` (received, normalised: "${t.slice(0, 120)}")`;
  const exact = /^settle (tap-[0-9a-f]{12}) (landed|not-landed)$/.exec(t);
  if (exact) {
    if (exact[1] !== kid) return `his message names tap key ${exact[1]}, not ${kid}: a message settles only the key it names${got}`;
    if (exact[2] !== how) return `his message says ${exact[2]}, but the command says ${how}${got}`;
    return null;
  }
  const negs = (t.match(/\bnot[ -]landed\b|\bdid ?n[o']?t land\b|\bnever landed\b/g) ?? []).length;
  const lands = (t.match(/\blanded\b/g) ?? []).length - (t.match(/\bnot[ -]landed\b|\bnever landed\b/g) ?? []).length;
  const form = `"${settleForm(kid, "landed")}" or "${settleForm(kid, "not-landed")}"`;
  if (negs && lands > 0) return `his message says both landed and not landed, so it settles nothing; he sends exactly ${form}${got}`;
  if (how === "landed" && /\bnot landed\b/.test(t)) return `his message says "not landed" (two words), the opposite of landed; he sends exactly ${form}${got}`;
  if (how === "not-landed" && /\bnot landed\b/.test(t)) return `his message writes "not landed" as two words; he sends exactly ${form}, with not-landed as one word${got}`;
  return `his message isn't of the exact form ${form}${got}`;
}
// Told to him on the card's thread the first day a landing stays unconfirmed (round 11), with both
// settle lines each in its own code block (round 12), so a long press copies exactly one.
export const unresolvedReminder = (kid: string) =>
  `Still can't tell whether this Ship landed. Check main on GitHub from your PC, then send exactly one of these two lines:\n\`\`\`\n${settleForm(kid, "landed")}\n\`\`\`\n\`\`\`\n${settleForm(kid, "not-landed")}\n\`\`\`\nHow: "Reconciling a landing by hand" in the Cain App's documentation.`;
// Round 12: after that, one digest for every unresolved key (daily for a week, then weekly).
export const unresolvedDigest = (kids: string[]) =>
  `${kids.length === 1 ? "One Ship is" : `${kids.length} Ships are`} still unconfirmed. For each, check main on GitHub from your PC, then send exactly one of its two lines:\n` +
  kids.map((k) => `\`\`\`\n${settleForm(k, "landed")}\n\`\`\`\n\`\`\`\n${settleForm(k, "not-landed")}\n\`\`\``).join("\n") +
  `\nHow: "Reconciling a landing by hand" in the Cain App's documentation.`;
// Told to him on a card's thread when the record keeper refused or lost a request from his tap (round 11).
// Round 12: a refusal doesn't use the tap up; the line says what happens next.
export const TAP_REFUSED = "Cain's first try at recording your tap didn't match this card, so nothing was recorded yet. Your answer still stands and Cain is recording it again; nothing to do unless you want to change it, then answer in a message.";
export const TAP_RESTORE_LOST = "Your tap was lost when the App's state was restored from an older copy, please answer again.";
// Round 12: a Ship tap before install taps are switched on (keeper.sh install-taps on, after the
// post-install tests pass): nothing lands, the buttons stay.
export const INSTALL_WAIT = "Installs wait for the post-install tests: nothing shipped, and this card stays up. Cain turns installs on once those tests pass.";
// Round 13: a card whose tap keys couldn't be logged never gets its buttons, and says so.
export const CARD_UNISSUABLE = "This card couldn't be made tappable (the App couldn't save it), so it has no buttons. Cain asks again.";
// Round 13: a card whose buttons couldn't be put on when it was posted: they go on at the next start.
export const CARD_BUTTONS_LATE = "This card's buttons didn't go on when it was posted. The App puts them on by itself; answer once they show.";
export const CARD_BUTTONS_ON = "Its buttons are on now: answer when you like.";
// Round 13: a card whose keys were logged but whose record couldn't be saved: withdrawn, never tappable.
export const CARD_WITHDRAWN = "This card was withdrawn (the App couldn't save it), so a tap on it does nothing. Cain asks again.";
// Round 13: a tap on a card past its expiry, known only from the compact expired-key index.
export const TAP_EXPIRED = "This card expired, so the tap did nothing. Cain asks again if it still needs you.";
// Round 13: his own line that turns install taps on, and the one that accepts a verified rebuild of the
// record keeper's logs (keeper.sh recover-logs).
export const INSTALL_LINE = "install taps on";
export const RECOVER_LINE = "recover logs";
// Round 13: told to him once per outage while the record keeper can't verify which taps were acted on.
export const KEEPER_UNVERIFIED = "Cain's record is checking which of your taps were already acted on, after a restart or a restore, and needs GitHub for that. Until it can, taps that change the record wait; nothing is lost and nothing to do.";
// Round 14: a line on the card for each hold and refusal path of a tap.
export const TAP_HELD = "Held: Cain's record can't yet verify which taps were already acted on, after a restart or a restore. Your answer is kept and acts by itself once it can, or you're told here why it didn't.";
export const TAP_CONSUMED = "This answer was already acted on, so this tap did nothing again.";
export const CARD_LOST_RESTORE = "Lost in a restore of the App's state, so its buttons are off. Cain asks again if it still needs you.";
export const TAP_NOT_ACTED_CHANGED = "Not acted: the item changed after your tap, so your held answer was not used. Cain asks again if it still needs you.";
export const SHIP_UNVERIFIED_TAP = "Ship waits while Cain's record checks which taps were already acted on. Nothing shipped, and this card stays up: tap Ship again once that's done.";
// Round 15: the card's own line for a Ship tap made while the consumed set is unverified, and for a card whose
// buttons wait at a start for that check; each is edited away once the record has checked.
export const SHIP_CHECKING = "Not taken yet: Cain's record is still checking which taps were already acted on. Nothing shipped; tap Ship again once this line clears.";
export const CARD_CHECKING = "Its buttons go on once Cain's record has checked which taps were already acted on, after a restart. Nothing to do.";
// Round 15: a held tap whose time the App's clock and Discord's disagree on.
// Round 16: a replayed held tap with no keeper request within REPLAY_WAIT_MS: the card asks for a fresh tap.
export const REPLAY_WAIT_MS = 10 * 60_000;
export const TAP_REPLAY_AGAIN = "Your held answer may not have reached Cain after a restart, so nothing was done from it. Please answer again on the fresh card Cain sends.";
// Round 16: a Ship card from before a detected restore stays buttonless until Cain reissues it.
export const SHIP_RESTORE_REISSUE = "Its buttons are off after a restore of the App: a Ship card from before the restore isn't tappable. Cain sends a new one if it still needs you.";
// Round 16: a held tap refused because its hold began after its card expired (by the held record).
export const TAP_HOLD_FLOOR = "Not acted: your answer was held across a restart of Cain's record, and by then its card had expired. Cain asks again if it still needs you.";
// Round 18: a replayed held tap the keeper consumed before its supersede took: it stands, and the card says so
// instead of asking him again.
export const TAP_REPLAY_ACTED = "Your answer here was acted on after all, so there's nothing to answer again.";
// Round 18: a tap the link can't place in Discord's time (no interaction id on its held record, or no card id to
// date the card's expiry from) is refused, never judged by the Pi's clock.
export const TAP_UNSTAMPED = "Not acted: Discord's time for this answer couldn't be read, so it can't be judged. Cain asks again if it still needs you.";
// Round 17: once his card asks him to answer again (TAP_REPLAY_AGAIN), the old tap key is superseded: a late
// request of Cain's for it is refused by the keeper, and the card says so.
export const TAP_SUPERSEDED = "Not acted: this answer was replaced by the request above to answer again on a fresh card. Nothing to do here.";
// Round 17: a new link run not verified within VERIFY_PENDING_MS (measured on the monotonic clock): one line on
// each waiting card, and Cain told once that verification for the new link run is pending.
export const VERIFY_PENDING_MS = 5 * 60_000;
export const VERIFY_WAITING = "Still waiting: the App restarted, and Cain's record hasn't reached GitHub since to check which taps were already acted on. This card goes on by itself once it has. Nothing to do.";
// Round 17: his owner line read back from history (sent while the link was down) that answers a proposal still
// within OWNER_LINE_MS by Discord's times: told once, with a fresh code from this run; the old line never acts.
export const OFFLINE_CAUSE = "it arrived while the App was offline, so it can't count as it is";
export const TAP_TIME_DISAGREE = "Not acted: the App's clock and Discord's disagreed about when you tapped, so your held answer was not used. Cain asks again if it still needs you.";
// Round 15: a line taken off a card's text again (the inverse of withLine).
export function withoutLine(content: string, line: string): string {
  const c = content ?? "";
  if (c === line) return "";
  return c.split(`\n\n${line}`).join("");
}
// Round 14: the keeper's reason for an ordinary start's unverified consumed set (not a restore).
// Round 15: how far the App's own clock may differ from a Discord snowflake's time before a held tap's
// time or an owner line's order is refused rather than judged.
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
// Round 16: an owner line counts only within this long of its proposal, by Discord's two snowflakes alone.
export const OWNER_LINE_MS = 30 * 60_000;
// Round 16: what he is told when the Pi's own clock is the one that is off (judged against Discord's).
export const clockOffLine = (ms: number) => `The Pi's clock is off by about ${Math.max(1, Math.round(Math.abs(ms) / 60_000))} minute${Math.round(Math.abs(ms) / 60_000) === 1 ? "" : "s"}, waiting for time sync. Discord's own time was used instead, so nothing waits on it.`;
export const KEEPER_START_WHY = "a start: the consumed tap keys are checked against the record remote before any tap counts";
export interface Uncertain { gen: number | null; check: string | null; item: string; at: number; msg: string; label: string; told?: boolean; key?: string; epoch?: number; ref?: Ref; kind?: string }
// last: the newest part of what he sent; asks: its last line asks something. Seeded ids
// have neither, so they never hold the moving Stop.
export interface SentRec { at: number; last?: boolean; asks?: boolean }
// A source check's reference (0.12.0): the row's ledger id and version the keeper accepted a
// check of, and the request that carried it, when one did.
// gen: the ledger's generation when the card went up; a tap counts only while the ledger's is
// no lower (a ledger that went backwards never validates a card).
// epoch: the record keeper's reset epoch when the card went up (0: none yet); a tap counts only while
// it is the current epoch (equality, not ordering). Cards from before it was stamped go by gen.
// Round 18: sf, the Discord snowflake a tap's freshness is measured from: the check's own anchor (its checked_sf in
// the keeper's ledger), or, for a check that carried none, the card's own post snowflake.
export interface Ref { row: string | null; version: number; req?: string; gen?: number; epoch?: number; sf?: string }

export function emptyState(): State {
  // Card ids start from the clock, so a fresh state never reuses an id the
  // specialist already has on record.
  return { next: Date.now(), cards: {}, messages: {}, held: [], migrated: false };
}

export function digest(content: string, components: any[] | undefined): string {
  const b = (components ?? []).map((r: any) => (r.components ?? []).map((c: any) => [c.label ?? null, c.custom_id ?? null]));
  return createHash("sha256").update(JSON.stringify({ t: content ?? "", b })).digest("hex");
}

export function fit(text: string): string {
  return text.length <= LIMIT ? text : text.slice(0, LIMIT - 2).trimEnd() + " …";
}

// A tap's idempotency key, short, for Cain's lines and the keeper's log: the same tap always has it.
export function tapKid(key: string): string { return `tap-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`; }

// The card's text with what happened to it on a line of its own at the end, once.
export function withLine(content: string, line: string): string {
  const c = content ?? "";
  if (!line || c === line || c.endsWith(`\n\n${line}`)) return c;
  const room = LIMIT - line.length - 2;
  const head = c.length <= room ? c : c.slice(0, room - 2).trimEnd() + " …";
  return `${head}\n\n${line}`;
}

// Buttons as Discord takes them. Stop is red (danger), one look for it everywhere.
export function rows(buttons: [string, string][][], primaryPrefix = "k:a:"): any[] {
  return buttons.slice(0, 5).map((row) => ({
    type: 1,
    components: row.slice(0, 5).map(([label, id]) => ({
      type: 2, style: id === STOP ? 4 : id.startsWith(primaryPrefix) ? 1 : 2, label: label.slice(0, 80), custom_id: id.slice(0, 100),
    })),
  })).filter((r) => r.components.length);
}

export function excerpt(text: string, n = 150): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 3) + "...";
}

function buttonIds(components: any[] | undefined): string[] {
  return (components ?? []).flatMap((r: any) => (r.components ?? []).map((c: any) => String(c.custom_id ?? "")));
}

// The labels on a message's buttons, in order, link buttons included.
export function labelsOf(components: any[] | undefined): string[] {
  return (components ?? []).flatMap((r: any) => (r.components ?? []).map((c: any) => String(c.label ?? "").trim())).filter(Boolean);
}

// How a line names a card's buttons for Cain.
export function buttonsLine(labels: string[] | undefined): string {
  return labels?.length ? `Its buttons: ${labels.join(", ")}.` : "It has no buttons.";
}

// Whose words a message the link posted carries: Cain's asks, Ship cards and morning
// message are his words through the link, and a reply of his that holds the moving Stop is
// his; a specialist's card is the specialist's; the link's own Stop notices and notices
// are the link's.
export function writerOf(m: Shown): Writer {
  if (m.kind === "ask" || m.kind === "ship" || m.kind === "morning" || m.kind === "plain") return "cain";
  if (m.kind === "card" && m.card !== undefined) return "specialist";
  return "link";
}

const CARDS_KEEP_MS = 2 * 86400_000;         // finished cards stay in the published view this long

// The cards as the reply hook reads them (/cards, and /data/trust/cards.json when the
// link doesn't answer): every message with buttons up, and every one the link posted in
// the last 2 days or whose buttons came off since. No text. With them, the ids of Cain's
// own replies from the last 35 days, the only messages he may edit.
export function cardsView(s: State, now: number): CardsView {
  const cards: CardView[] = [];
  for (const [id, m] of Object.entries(s.messages)) {
    if (!m.buttons && (m.off ?? m.posted ?? 0) < now - CARDS_KEEP_MS) continue;
    const linkButton = m.kind === "notice" && m.question === "connector";   // a link button is always up
    cards.push({ message: id, kind: m.kind ?? "legacy", writer: writerOf(m), labels: [...(m.labels ?? [])],
      live: linkButton || live(m, now), item: m.item ?? null, question: m.question || null, posted: m.posted ?? null });
  }
  cards.sort((a, b) => (a.posted ?? 0) - (b.posted ?? 0));
  const sent = Object.entries(s.sent ?? {}).filter(([, r]) => r.at > now - REMEMBER_MS).map(([id]) => id);
  return { written_at: now, owner: s.owner ?? null, dm: s.dm ?? null, cards, sent };
}

// The link's outcome and landing lines, taken off the end of a card's words.
const OUTCOME = /\n\n(?:You answered(?::| in a message)[^\n]*|Answered|Expired|Replaced by a newer card|Status changed, re-check needed|Record reset since, re-check needed|Turned back on since\.|Stopped again since\.|You tapped Ship[^\n]*|Shipped: [^\n]*|Not shipped: [^\n]*)$/;
export function withoutOutcome(content: string): string {
  return String(content ?? "").replace(OUTCOME, "");
}

// Discord ids carry their own creation time (gate/plugin.ts).
export { snowflakeTime };

// -- the check-in clock: Cain's asks last until the next morning check-in ---------------
function zoned(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p;
}
function offset(ms: number, tz: string): number {
  const p = zoned(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function localTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = guess - offset(guess, tz);
  return guess - offset(t, tz);
}
export function nextCheckin(ms: number, tz = "America/New_York", at = "0710"): number {
  const h = Number(at.slice(0, 2)), mi = Number(at.slice(2));
  const p = zoned(ms, tz);
  let t = localTime(p.year, p.month, p.day, h, mi, tz);
  for (let i = 1; t <= ms && i < 3; i++) {
    const n = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    t = localTime(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), h, mi, tz);
  }
  return t;
}

// -- what Cain's record says: PENDING.md from the keeper's copy, and the holds ----------
// status: the record keeper's status for the link (/data/record-ledger.json, record/main.ts).
export interface RecordFiles { pending: string | null; holds: string | null; checks?: string | null; status?: string | null }   // null: no such file

// The record keeper's status, as it writes it every round: the ledger's generation, whether
// local commits wait for a push after one failed, whether its copy was reset since the last
// push that landed, and its clock verdict with the source that satisfied it.
export interface KeeperStatus {
  at?: string; generation?: number; unpushed?: boolean;
  push_failed?: { at: string; why: string; since?: string }; reset?: { at: string; why: string };
  last_reset?: { at: string; why: string };          // the latest reset, kept after the push that ended it
  outage?: { since: string; rounds: number };        // rounds that ended unpushed or reset, and since when
  clock?: { synced: boolean; source: string | null; diagnostic: string; at: string };
  epoch?: { n: number; at: string; generation: number; voided?: boolean };   // the latest reset epoch (voided: its ledger write dropped the older checks)
  link_state?: { readable: boolean; why: string };          // the keeper couldn't read the link's state for its floor
  epoch_wait?: { at: string; why: string };                 // a reset whose epoch waits for the link's state to be readable
  recheck_pending?: number;                                 // rows whose check was dropped by a reset, pending re-check
  // Round 13: the keeper's consumed tap keys aren't verified yet (a detected restore whose rebuild from the
  // record remote's history waits on GitHub): tap-derived requests and hand settles are held meanwhile.
  consumed_unverified?: { since: string; why: string; tries: number };
  history_cards?: string[];                                 // round 13: card message ids the remote's Tap-Card trailers name
  used_lines?: string[];                                    // round 14: owner-line nonces the record's Owner-Line trailers (and the keeper) know used
  // Round 16: the keeper's current start (a nonce minted at its first round), and the fresh fetch that verified
  // its consumed set in that start: the start it names, the keeper's time of it, the link run nonce the keeper
  // read in the link's state at that fetch, and how many fetches since.
  start?: { nonce: string; at: string };
  verified?: { start: string; at: string; link: string | null; fetches: number };
}

// A push error in plain words, for Dane (never the raw text: it is git's, and may name things).
// A span of time in plain words: "12 minutes", "1 hour 5 minutes".
export function spanWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minute${m === 1 ? "" : "s"}` : ""}`;
}
export function plainPush(why: string | undefined, reset: boolean): string {
  const w = why ?? "";
  if (/no-such-remote|smoke test/i.test(w)) return "the smoke test is blocking it on purpose";
  if (/conflict|couldn't be rebased/i.test(w)) return "GitHub's copy changed in a way the box couldn't merge";
  if (/authentication|could not read username|terminal prompts disabled|denied|\b40[13]\b/i.test(w)) return "GitHub turned down the box's sign-in (the GitHub token in the App's options may have expired)";
  if (/could not resolve|timed out|timeout|connection|unable to access|failed to connect|network/i.test(w)) return "GitHub didn't answer";
  if (/rejected|non-fast-forward|protected/i.test(w)) return "GitHub turned the save down";
  if (!w && reset) return "the box had to start its copy over";
  return "GitHub turned the save down for a reason the box couldn't name";
}
// undefined: no status file (the keeper hasn't written one); null: one that can't be read.
export function keeperStatus(text: string | null | undefined): KeeperStatus | null | undefined {
  if (text === undefined || text === null) return undefined;
  try { const j = JSON.parse(text); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}
export type Holds = Record<string, { holder?: string; branches?: string[] }>;

// The holds, from the record keeper's own file (/data/record-holds.json): written
// whole once its local commits are made (a push that fails keeps them, and pushes them
// later), with the holds under "holds". A missing
// file is no holds; one that can't be read is null, and nothing is decided from it.
export function parseHolds(text: string | null): Holds | null {
  if (text === null) return {};
  try {
    const h = JSON.parse(text)?.holds;
    return h && typeof h === "object" && !Array.isArray(h) ? h : null;
  } catch { return null; }
}

// Held by someone other than Cain (an entry with no holder counts as someone else).
export function heldElsewhere(holds: Holds, item: string): boolean {
  const k = Object.keys(holds).find((x) => x.toUpperCase() === item.toUpperCase());
  return k !== undefined && String(holds[k]?.holder ?? "") !== "cain";
}

// Items closed in state/PENDING.md: in the Done table and not (again) in the Open one.
// An item that's in neither isn't closed: Cain may be asking before its row lands.
export function closedItems(pending: string | null): Set<string> {
  const open = new Set<string>(), done = new Set<string>();
  let section = "";
  for (const line of (pending ?? "").split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (!line.startsWith("|")) continue;
    const id = /^\s*([A-Za-z]{1,4}\d{1,4}[A-Za-z]?)\b/.exec(line.split("|")[1] ?? "")?.[1]?.toUpperCase();
    if (!id) continue;
    if (section.startsWith("open")) open.add(id);
    else if (section.startsWith("done")) done.add(id);
  }
  for (const id of open) done.delete(id);
  return done;
}

// The record keeper's ledger (record/core.ts, state/checks.json), by item: each open row's
// hidden id and version, and its latest source check with the version it checked.
function ledgerOf(text: string | null | undefined): Checks {
  return parseChecks(text ?? null);
}
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
// How long the link waits for the record keeper's outcome on a check before giving up and
// posting nothing (keeper.sh waits 45 seconds for the link's answer).
export const CHECK_WAIT_MS = 30_000;
const CHECK_POLL_MS = 500;
export const STATUS_CHANGED = "Status changed, re-check needed";
export const EPOCH_CHANGED = "Record reset since, re-check needed";
const EPOCH_TAP = "Cain's record was reset after this was asked, so nothing was done. Cain will check it again and ask again if it still needs you.";
// Any unsaved change holds a Ship tap, not only one about this item (a known limitation: the keeper's
// status has one flag for the whole record).
const SHIP_UNPUSHED_TAP = "Cain's record has unsaved changes, so Ship waits. Tap again once they're saved, in a minute or two.";
const STATUS_TAP = "Its status changed since it was checked, so nothing was done.";
export const LOST_TAP = "Lost to the record's reset, please answer again.";
export const ABANDONED_TAP = "The install was interrupted by a restart and did not land; a new card follows.";
// A landing the remote can't settle yet, told once to him on its card's thread (item 1, round 9).
export const unconfirmedTap = (since: string, unreachable: boolean) =>
  `Landing unconfirmed: ${unreachable ? "main's remote has been unreachable" : "main's history couldn't be searched"} since ${since}, retrying.`;
// A claim from an earlier run of the link whose card no longer passes the live-tap predicate: never
// acted, told once to him on its card's thread (round 9).
export const NOT_ACTED_TAP = "Your tap was not acted on after a restart; a new card follows.";
// The link's own state rebuilt after two failed reads: its generation goes this far above what it knew.
export const HEAL_GEN_MARGIN = 10;
const HEAL_NOTICE = "Cain's link had to rebuild its saved state after the file was damaged. Questions that were up may lose their buttons, and Cain asks again what still needs you. Nothing for you to do.";
// How long a tap's fresh read of the ledger, the keeper's status and the check's outcome (three
// small local files) may take before the tap is refused as busy. Discord wants the tap's answer
// within 3 seconds, and the answer itself is a call to Discord after the read, so the read gets
// half of that. The device smoke test prints the measured read time (keeper.sh clock) so this
// can be tuned from the Pi, and each busy refusal is counted in the keeper's audit.
export const TAP_READ_MS = 1_500;
const BUSY_TAP = "Busy, tap again.";
const CLOCK_TAP = "The box's clock isn't synchronized just now, so nothing was done. Tap again in a few minutes.";
const RESET_TAP = "Cain's record is being put back in step, so nothing was done. Tap again in a few minutes.";
const UNPUSHED_TAP = "Cain's record hasn't saved for over half an hour, so nothing was done. Tap again once it has.";
// A push failure older than this: taps are refused (their own reason) instead of honoured and
// journaled; and the keeper outage Dane hears of once (or after OUTAGE_ROUNDS rounds).
export const UNPUSHED_TAP_MS = 30 * 60_000;
export const OUTAGE_NOTICE_MS = 30 * 60_000;
export const OUTAGE_ROUNDS = 3;
// How recent the keeper's own clock verdict must be to count at tap time (its rounds run every
// minute), and how long after a push error the sweep leaves cards alone.
export const KEEPER_CLOCK_FRESH_MS = 10 * 60_000;
export const PUSH_QUIET_MS = 2 * 60_000;
// "Nov 13", in the zone.
const shortDay = (ms: number, tz = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(ms);

// Round 17: a small file written whole and fsynced (the file, then its folder) before it is relied on.
function writeDurable(f: string, text: string): void {
  const tmp = `${f}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, f);
  try { const d = openSync(dirname(f), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* a folder that can't be synced */ }
}
export class Refusal extends Error {}
// Round 15: an owner line whose code no longer counts (a proposal from an earlier start, another record
// epoch, or one already used): cause is the plain words he is told, with a fresh code at once.
// Round 16: late: past OWNER_LINE_MS by Discord's times (told to him with both times, whatever the line).
export class StaleLine extends Refusal { constructor(message: string, public cause: string, public late = false) { super(message); } }
type CheckState = "ok" | "changed" | "behind" | "unknown" | "busy" | "clock" | "reset" | "unpushed" | "epoch" | "ship-unpushed";
// How long a read that ignores cancellation still counts as in flight before it is forgotten.
const INFLIGHT_MAX_MS = 30_000;
// When the keeper's current run of push failures (or its reset) began, as its status says.
function outageSince(st: KeeperStatus): number {
  const t = [st.outage?.since, st.push_failed?.since, st.push_failed?.at, st.reset?.at].map((x) => (x ? Date.parse(x) : NaN)).filter(Number.isFinite);
  return t.length ? Math.min(...t) : Infinity;
}
// A wait that ends early, rejecting, once the signal aborts.
function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok, no) => {
    if (signal.aborted) return no(new Error("aborted"));
    const t = setTimeout(ok, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); no(new Error("aborted")); }, { once: true });
  });
}
class StaleCheck extends Refusal {}

export interface Meta { item: string; question: string; replyTo?: string }

function checkMeta(m: { item?: unknown; question?: unknown; replyTo?: unknown }): Meta {
  const item = String(m.item ?? "").trim();
  if (!item) throw new Refusal("needs an item: its PENDING id (like P08), or none");
  if (item.toLowerCase() !== "none" && !ITEM.test(item)) throw new Refusal("item must be a PENDING id like P08, or none");
  const question = m.question === undefined || m.question === null ? "" : String(m.question).trim();
  if (question && !QUESTION.test(question)) throw new Refusal("question must be a short id like Q2");
  const replyTo = m.replyTo === undefined || m.replyTo === null || m.replyTo === "" ? undefined : String(m.replyTo).trim();
  if (replyTo !== undefined && !SNOWFLAKE.test(replyTo)) throw new Refusal("reply_to must be a Discord message id");
  // Ids are upper-cased everywhere, as the record keeper keeps them: "p08 q2" is P08 Q2.
  return { item: item.toLowerCase() === "none" ? "none" : item.toUpperCase(), question: question.toUpperCase(), replyTo };
}

// Cards for the same item and question replace each other; so do Ship cards for the
// same pull request, and morning messages. A card with no question id, or about no
// item, never replaces anything.
const keyOf = (item?: string, question?: string): string | null =>
  !item || item === "none" || !question ? null : `${item.toUpperCase()}\n${question.toUpperCase()}`;
const sameAsk = (a: { item?: string; question?: string }, b: { item?: string; question?: string }) =>
  (a.item ?? "none").toUpperCase() === (b.item ?? "none").toUpperCase()
  && (a.question ?? "").toUpperCase() === (b.question ?? "").toUpperCase();

// A card used to start with words naming what it's about ("P08 Q2: "). He can't tell what
// those are (0.11.0), so no card shows one: the item and question stay as data (binding,
// replacing, holds, expiry, replied), and one Cain wrote at the start of his words is taken off.
// Only the card's own label is taken off ("P08 Q2: " on P08's second question), so words
// that merely start like one ("P100: filter swap" on another item) stay as they are.
const LEADING_LABEL = /^\s*P0*(\d{1,4})(?:[ \t]+Q0*(\d{1,2}))?[ \t]*:[ \t]*/i;
const numberOf = (id: string | undefined, letter: "P" | "Q"): number | null =>
  id && new RegExp(`^${letter}\\d{1,4}$`, "i").test(id) ? Number(id.slice(1)) : null;
export function unlabeled(text: string, item?: string, question?: string): string {
  const t = String(text ?? "");
  const m = LEADING_LABEL.exec(t);
  if (!m || numberOf(item, "P") !== Number(m[1])) return t;
  // A label with a question id is the card's own only when the card has that very question.
  if (m[2] !== undefined && numberOf(question, "Q") !== Number(m[2])) return t;
  return t.slice(m[0].length);
}

// What he sees has no machine text in it (Timing and truth, in CLAUDE.md).
function noMachineText(...texts: string[]): void {
  for (const t of texts) for (const [re, what] of MACHINE)
    if (re.test(t)) throw new Refusal(`his card can't show ${what}: write it as people say it, or leave it out`);
}

// The same words always carry the same nonce, so a post retried after a lost answer
// comes back as the message already made, never a second one (Discord enforce_nonce).
export const stableNonce = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 25);
function keyFor(m: Shown): string | null {
  if (m.kind === "ship" && m.ship) return `ship\n${m.ship.pr}`;
  if (m.kind === "morning") return "morning";
  return keyOf(m.item, m.question);
}
// The sweep keeps the newest card per key on each side: the specialist's cards among
// themselves, Cain's among his own. Posting one replaces older ones of either side at
// once (markReplaced); only a card filed after it went out by itself can share a key
// with one of Cain's asks, and then both stand.
const rivalKey = (m: Shown): string | null => {
  const k = keyFor(m);
  return k && m.kind === "card" ? `card\n${k}` : k;
};
const live = (m: Shown, now: number) => !!m.buttons && !m.outcome && !(m.expires != null && m.expires <= now);
// The item whose closing, or move to another holder, ends this card: only Cain's own
// asks and Ship cards have one. A specialist's card is the specialist talking to the
// owner; the item Cain files it under is a label, for replacing and for the record, so "".
const boundItem = (m: Shown): string => (m.kind !== "card" && m.item && m.item !== "none" ? m.item : "");
const about = (item?: string, question?: string) =>
  item && item !== "none" ? `${item}${question ? ` ${question}` : ""}` : "";

// What the card says once its buttons are off. A morning message, a notice and a plain
// message asked nothing: their Stop just goes, and so does an older Stopped notice's
// Turn back on once a newer notice carries it.
function outcomeLine(m: Shown | undefined): string {
  if (!m) return EXPIRED;
  if (m.kind === "morning" || m.kind === "notice" || m.kind === "plain" || m.why === MOVED || m.why === REPOSTED) return "";
  if (m.outcome === "answered") return m.label ? `You answered: ${m.label}` : m.words ? "You answered in a message" : "Answered";
  // An older Stop notice, once a newer one carries the button that counts.
  if (m.outcome === "replaced" && m.why === TURNED_ON) return "Turned back on since.";
  if (m.outcome === "replaced" && m.why === STOPPED_AGAIN) return "Stopped again since.";
  if (m.outcome === "replaced") return REPLACED;
  if (m.why === "status changed") return STATUS_CHANGED;
  if (m.why === "record reset") return EPOCH_CHANGED;
  return EXPIRED;
}
const TURNED_ON = "turned back on since";
const STOPPED_AGAIN = "stopped again since";

// Newer Discord ids are bigger numbers.
function newerId(a: string, b: string): boolean {
  try { return BigInt(a) > BigInt(b); } catch { return a > b; }
}

// A time in ms, or null. A number below 1e11 is taken as seconds: 1e11 ms is 1973, while
// 1e11 seconds is thousands of years off.
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
// Card a went up after card b (their Discord ids break a tie).
const isNewer = (a: Shown, aId: string, b: Shown, bId: string) =>
  (a.posted ?? 0) > (b.posted ?? 0) || ((a.posted ?? 0) === (b.posted ?? 0) && newerId(aId, bId));
// Why a post failed, short, for the log.
const reason = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 80);
// The same, in plain words for Cain: Discord answered no, or didn't answer.
const refused = (e: unknown) => /\bdiscord \d{3}\b/.test(String(e));
const plainly = (e: unknown) => (refused(e) ? "Discord refused it" : "Discord didn't answer");

// What Cain hears about a card the link handles by itself. Each line says what it was.
const what = (c: Card | undefined) => `("${excerpt(c?.text ?? "", 60)}")`;
const FRESH = "get a fresh card through /opt/cain/keeper.sh handover (see Calendars)";
const wentOutLine = (id: number, c: Card | undefined, msg: string, labels?: string[]) =>
  `Card ${id} ${what(c)} went out to him by itself (Discord message ${msg}): you hadn't shown it within 2 minutes. ${buttonsLine(labels ?? labelsOf(c?.rows))} No need to show it unless it belongs under an item.`;
const foundLine = (id: number, c: Card | undefined, msg: string, labels?: string[]) =>
  `Card ${id} ${what(c)} reached him after all (Discord message ${msg}): the answer to your show of it was lost. ${buttonsLine(labels ?? labelsOf(c?.rows))} Nothing more was posted.`;
const lapsedLine = (id: number, c: Card | undefined) =>
  `Card ${id} ${what(c)} expired before it reached him. Tell him in your own words, or ${FRESH}.`;
function failedLine(id: number, c: Card, e: unknown, unsure: boolean, now: number): string {
  if (unsure && c.expires != null && c.expires <= now)
    return `Card ${id} ${what(c)} expired, and I can't tell yet whether it reached him (${plainly(e)}). I'll check again.`;
  return `Card ${id} ${what(c)} ${unsure || !refused(e) ? "may not have gone out" : "didn't go out"}: ${plainly(e)}. Tell him in your own words if it matters; I'll keep trying${c.expires != null ? " until it expires" : ""}.`;
}

// His DM couldn't be read to see whether a card's unanswered post is there: nothing is
// posted until it can be, so it never goes out twice.
class Unsure extends Error {}

export interface Deps {
  rest: Rest;
  load: () => State;
  // Round 17: sync true fsyncs the save (the file, then its folder) before it returns: a save something is
  // relied on after (a tap's claim before its relay, a card's record before its buttons go on, an owner
  // proposal and its use, the verification tuple).
  save: (s: State, sync?: boolean) => void;
  now: () => number;
  relay: (text: string) => void;                                   // a line typed in to Cain
  toHarness: (path: string, body: unknown) => Promise<boolean>;     // a tap on its card
  paired: () => string;                                            // who Cain is paired with
  log?: (line: string) => void;
  record?: () => RecordFiles;                                      // PENDING.md, the keeper's holds and its source checks
  // A tap's fresh read of the keeper's files (the ledger, the list, its status and the check's
  // outcome), cancelled through the signal when it runs past its limit. Absent: record and outcome.
  readFresh?: (outcome: string | null, signal: AbortSignal) => Promise<{ files: RecordFiles; outcome: { state: string; reason?: string } | null }>;
  tapReadMs?: number;                                              // the App's tap_read_ms option (TAP_READ_MS when unset)
  inflightMaxMs?: number;                                          // the tests' INFLIGHT_MAX_MS
  // At that ceiling, a fresh read that never settled is killed: its signal aborts and anything it
  // spawned is killed as a process group (main.ts); the read's slot is released either way.
  killRead?: () => void;
  // Whether a request is in log/requests on the keeper's current copy, done (the check a tap rested
  // on survived a reset); null: can't tell now.
  requestLogged?: (id: string) => boolean | null;
  // The link's landing ledger (landings.ts), one file per tap key under /data/record-landings: its
  // claim is true the first time a tap's key starts a landing, false ever after, null when it can't
  // be written or isn't trusted yet (it came back from a backup). The keeper never touches it.
  landings?: Landings;
  // The link's own state file as it is on disk: whether it reads as a state (the self-heal's check).
  stateHealth?: () => { ok: boolean; why?: string };
  submitRecord?: (req: Record<string, unknown>) => void;           // a request into the record keeper's local queue (a source check, a one-off's log line)
  outcome?: (id: string) => { state: string; reason?: string } | null;   // the record keeper's outcome for one of those, once it has one
  maxCheckDays?: number;                                           // the App's source_check_max_days (default 7)
  localClock?: () => Verdict;                                      // the box's own clock sources now (../clock.ts), for taps
  sleep?: (ms: number) => Promise<void>;                           // waiting on the keeper's outcome (the tests' clock)
  waitTimeout?: (w: { id: string; at: string; waited_ms: number; kind?: "tap" }) => void;   // a check the keeper didn't answer in time, or a tap refused as busy, for its audit
  tune?: (r: { at: string; kind: string; item: string; said: string }) => void;   // a source-check or one-off refusal, logged for tuning the rules
  noticeLog?: (text: string) => void;                              // each notice's rendered words, for the smoke test's leak check
  pull?: (pr: string) => Promise<Pull | null>;                     // a pull request now; null: can't tell
  tz?: string;                                                     // the check-ins' zone
  stop?: { read: () => StopState; write: (stopped: boolean, at: number) => void };   // Stop everything
  signShip?: (claim: Claim) => string | null;                      // his Ship tap as a token; null: no key
  // His Ship tap, landed in main with the deploy key (merge.ts); absent: no key, nothing lands.
  land?: (l: { pr: string; head: string; stopped: () => boolean }) => Promise<Landed>;
  // That head in the remote main now (merge.ts settledFrom, from the landing's base to main's tip);
  // null or { unresolved }: can't tell (GitHub unreachable, a range it couldn't search), never "no".
  landed?: (ship: { pr: string; head: string }, base?: string | null) => Promise<boolean | null | { unresolved: string }>;
  mainTip?: (pr: string) => Promise<string | null>;   // main's tip on GitHub now: the base a landing's claim records
  facts?: (pr: string, head?: string) => Promise<Facts | null>;    // what GitHub says the pull request changes (its Apps' versions read at head)
  checkRuns?: (pr: string, head: string) => Promise<any[] | "missing" | null>;   // the head's check runs (merge.ts checkRuns)
  factsMs?: number;                                                // how long a Ship card waits for them (tests)
  reviewed?: () => Reviewed[] | null;                              // the review service's lines (../reviewed.ts); null: can't be read
  keyKnown?: () => Promise<"known" | "refused" | "host key" | null>;   // does GitHub still know the deploy key; null: no answer
  // The gate (piece D): what the rules found at a send point, and what was done.
  report?: (r: GateReport) => void;
  // The replay: Cain's own replies and edits as his transcripts have them (since a time),
  // where its report goes, and the pause between pages of his DM (tests: 0).
  transcripts?: (since: number) => Sent | Promise<Sent>;
  writeReplay?: (r: ReplayReport) => string | void;             // where it was written
  replayPauseMs?: number;
  // Round 12: the link's append-only issued-key log (/data/link-issued.log, outside its restorable
  // state): every tap key a card offers, with its target and card message id, and each run's number and
  // nonce, framed and fsynced before the card can be tapped (../applog.ts).
  issuedLog?: string;
  // Round 12: a save that is fsynced before it returns (the run counter and nonce); save when absent.
  saveDurable?: (s: State) => void;
  // Round 17: a monotonic clock in ms (performance.now when absent): bounds measured in this process only
  // (the 10-minute replay wait, the 5-minute wait for verification of a new link run), never the Pi's clock.
  mono?: () => number;
  // Round 12: the tests' crash injection, called at named points (hand settle); absent in production.
  crashPoint?: (where: string) => void;
  // Round 13: the compact expired-key index (/data/link-expired.log: one framed {msg, at} per card whose
  // keys expired, its buttons taken off by message id); the record keeper's install log
  // (/data/record-install.log, ../installflag.ts) and the post-install tests' result file; the keeper's
  // mirror of the issued keys (/data/record-issued.log, read only); and where keeper.sh recover-logs leaves
  // the owner's accepted line for the keeper (/data/record-recover.json).
  expiredLog?: string;
  // Round 14: the keeper's consumed-key log (/data/record-taps.jsonl, read only), the link's durable held-tap
  // log (/data/link-held.log) and its durable button-removal queue (/data/link-strip.log).
  consumedLog?: string;
  heldLog?: string;
  stripLog?: string;
  installLog?: string;
  installResults?: string;
  keeperMirror?: string;
  recoverFile?: string;
}

// One send point's hits, for the gate's log, and what was done: "fixed" (and posted),
// "refused" (nothing posted), "posted as it is" (a specialist's card, never refused).
export interface GateReport { point: string; writer: Writer | "unknown"; message?: string; hits: (Hit | CainHit)[]; did?: string }
// What Cain's transcripts say he sent with his plugin: message ids (replies and edits), the
// exact texts, and the ids of his replies alone (his edit allowlist is seeded from those).
export interface Sent { ids: Set<string>; texts: Set<string>; replies?: Set<string> }
// rule -> what happened -> count: fixed, refused, can't tell, or kept as it is and flagged
// (in words that are never refused: those are never counted as refused).
type Tally = Record<string, Record<string, number>>;
export interface ReplayReport {
  written_at: number;
  rules_version: number;
  // capped: it read its most pages before the start of the range, so the oldest part wasn't read.
  range: { from: number; to: number; days: number; pages: number; page_cap: number; reached_cutoff: boolean; capped: boolean; stopped: string | null };
  messages: { read: number; by_writer: Record<string, number>; skipped: Record<string, number>; cards_never_posted: number };
  hits: { by_rule: Tally; by_writer: Record<string, Tally>; total: number };
  list: { at: number; message: string; writer: string; rule: string; result: string; around: string; label?: string; kept?: string }[];
  edited: { morning_messages: number; buttons_changed: number; marked_edited: number; buttons_only_edits_marked: boolean | null; said: string };
}

// What stopped, as his Stop notice says it.
export const STOPPED_TOO = "Cain's Build and Ship jobs, Ship cards and outside reviews are stopped too, and nothing lands in main, until you tap Turn back on. A job already running finishes.";
export const RESUMED_TOO = "Cain's Build and Ship jobs and outside reviews can run again, and Ship cards can go out.";
// The link's own notice, when the calendar specialist didn't take his tap.
export const STOPPED_ALONE = "Cain's Build and Ship jobs, Ship cards and outside reviews are stopped, and nothing lands in main, until you tap Turn back on; a job already running finishes. The calendar specialist didn't answer, so it gets the Stop as soon as it does.";
export const RESUMED_ALONE = "Cain's Build and Ship jobs and outside reviews can run again, and Ship cards can go out. The calendar specialist didn't answer, so it gets the Turn back on as soon as it does.";
export const STOP_UNSAVED = "Cain's Ship cards are stopped, but his Build and Ship jobs and outside reviews may not be: the Stop couldn't be saved on his App. It's logged to be fixed.";
export const RESUME_UNSAVED = "Cain's side couldn't save that, so his Build and Ship jobs and outside reviews may still be stopped. It's logged to be fixed.";

// A pull request as GitHub has it now: its head, and whether it's still open (null
// when that couldn't be told), and whether it was merged.
export interface Pull { head: string | null; open: boolean | null; merged?: boolean }

// The link's own line on a Ship card, from GitHub, as it was before 0.11.0: what a card
// shows when the new lines can't be built.
export function factsLine(f: Facts | null): string {
  if (!f) return "From GitHub: the pull request couldn't be read just now.";
  return `From GitHub: ${changes(f)}.`;
}
const changes = (f: Facts) => {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const list = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  return `${n(f.commits, "commit")} and ${n(f.files, "file")}${f.areas.length ? `, including ${list(f.areas)}` : ""}`;
};

// A Ship card's question (0.11.0): what the tap installs, from each App's config.yaml read at
// the very head the card names and at its pull request's base (merge.ts bumpsAt).
export function shipQuestion(f: Facts | null): string {
  const bumps = f?.bumps ?? null;
  if (!bumps) return "Ship it?";
  if (!bumps.length) return "Ship it? No App version changes, so nothing installs.";
  return `Ship ${bumps.map((b) => `${b.app} ${b.version}`).join(" and ")}?`;
}

// What a Ship card says about the checks, from the head's runs (null: they couldn't be read),
// or that the pull request is in main already (the landing then asks nothing of its checks).
export const CHECKS_PASSED = "Checks passed.";
export const CHECKS_RUNNING = "Checks are still running; Ship lands it if they pass within 2 hours of the tap.";
export const CHECKS_UNREAD = "Checks couldn't be read just now; Ship checks them before it lands.";
export const IN_MAIN = "Already in main, so Ship only installs it.";
// Merged on GitHub, but whether main has this very head couldn't be read: the landing checks.
export const MERGED_UNREAD = "Merged on GitHub; Ship checks main has it before anything installs.";
// The last line when Cain names no review: none is attached, which isn't to say none happened.
export const NO_REVIEW = "No outside review attached.";

// The link's line from GitHub (0.11.0): how much it changes and the parts that matter most,
// then the checks. The pull request's title isn't shown: it's free text from whoever opened
// it, and every line here but Cain's is the link's own, so nothing quoted can pose as one.
export function githubLine(f: Facts, checks: string): string {
  return `From GitHub: ${changes(f)}. ${checks}`;
}
// Under the review service's line on a Ship card: what the reviewers read. The service sends
// them Cain's written summary of the change, never the code, so the card says so.
export const REVIEW_READ = "The reviewers read Cain's summary of the change, not the code.";

// A Ship card's words: the question, Cain's line, then the link's lines. His line gives way,
// so the link's are never cut off.
function shipCard(top: string, own: string, rest: string[]): string {
  const room = LIMIT - [top, ...rest].join("\n").length - 1;
  const mine = own.trimEnd();
  const cut = mine.length <= room ? mine : `${mine.slice(0, Math.max(0, room - 2)).trimEnd()} …`;
  return [top, cut, ...rest].join("\n");
}

// A promise's answer, or null once ms have passed.
async function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((ok) => { timer = setTimeout(() => ok(null), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

// A time as people say it, in the check-ins' zone: "4:12 AM".
export function clockTime(ms: number, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export type AskResult = { status: "posted"; message: string; said?: string } | { status: "held"; said: string }
  // A one-off whose words overlap an open row's Item: nothing posted until Cain names the item
  // (with a check) or sends it again with a reason (0.12.0).
  | { status: "needs reason"; said: string };

// The most a refusal says over the link's HTTP answer (main.ts cuts its words there).
export const SAID_MAX = 1000;
// Why the gate held words back, for Cain: what to change, and the buttons this has. Each
// reason is said once, after the excerpts it covers (an em dash's for all of them); when the
// line would run past SAID_MAX, fewer excerpts, then none, so every reason fits whole.
// cain: what his own rules found (../gate/cain.ts), with the review service's lines to offer.
function heldLine(what: string, hits: Hit[], buttons?: readonly string[], cain: CainHit[] = [], published?: readonly Reviewed[] | null): string {
  const labels = [...new Set(hits.filter((h) => h.rule === "button" && h.label).map((h) => h.label!))];
  const named = labels.length ? [`${labels.map((l) => `"${l}"`).join(", ")} ${labels.length > 1 ? "aren't among" : "isn't one of"} its buttons`
    + ` (${buttons?.length ? buttons.join(", ") : "it has none"})`] : [];
  const worded = hits.filter((h) => !(h.rule === "button" && h.label));
  let line = "";
  for (const each of [3, 1, 0]) {
    line = `The message gate held this ${what}: ${[...reasonParts(worded, each), ...cainReasons(cain, published, each), ...named].join("; ")}. Rewrite it and send it again.`;
    if (line.length <= SAID_MAX) break;
  }
  return line;
}
// What the gate flagged in a specialist's words, for Cain (its card goes out all the same).
function flaggedLine(hits: Hit[]): string {
  return [...new Set(hits.map((h) => h.rule === "button" && h.label ? `"${h.label}" isn't one of its buttons` : `"${h.around}" (${whyOf(h)})`))].join("; ");
}
const fixedSaid = (hits: Hit[]) => (hits.length ? `The message gate fixed its wording first: ${fixedWhat(hits)}.` : "");

// What the safety net found, as the PostToolUse hook says it, taken no further than this:
// at most 4 hits, each a rule the gate has and up to 60 characters of excerpt on one line,
// with links cut to their host. The hook's /sent is local and keyed, but its words reach
// Cain's relay, so nothing else of it is passed on (no corrected text).
export interface NetSeen { hits: { rule: string; result: string; around: string }[]; released: boolean }
export function netOf(v: unknown): NetSeen | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const hits = (Array.isArray(o.hits) ? o.hits : []).slice(0, 4).map((h: any) => ({
    rule: (RULES as readonly string[]).includes(String(h?.rule)) ? String(h.rule) : "other",
    result: ["fix", "refuse", "unsure"].includes(String(h?.result)) ? String(h.result) : "refuse",
    around: hostsOnly(String(h?.around ?? "")).replace(/\s+/g, " ").trim().slice(0, 60),
  }));
  const released = o.released === true;
  return hits.length || released ? { hits, released } : null;
}

// What the safety net (../hooks/discord-sent.ts) found in something of Cain's that went out:
// each rule and its short excerpt, and what to do.
const OR_NEW = "or, if the edit is held, send a one-line correction as a new reply instead";
function netLine(tool: string, id: string, net: NetSeen): string {
  const what = [...new Set(net.hits.map((h) => `"${h.around}" (${whyOf(h)})`))].join("; ");
  const kind = tool === "edit" ? "edit" : "reply";
  if (net.released)
    return `Your ${kind} (Discord message ${id}) went out as it was after the message gate held it twice${what ? `: ${what}` : ""}. If what it held still matters, fix it with an edit (edit_message), ${OR_NEW}; don't mention the gate to him.`;
  return `The message gate should have held your ${kind} (Discord message ${id}), but it went out: ${what}. Fix it now with an edit (edit_message), ${OR_NEW}; don't mention it to him. It's logged for a fix.`;
}

// What the link appended to a specialist's Stop or Turn back on notice: its own words.
const LINK_LINES = () => [STOPPED_TOO, RESUMED_TOO, STOP_UNSAVED, RESUME_UNSAVED];
export function splitLinkLine(text: string): [string, string] {
  const t = String(text ?? "");
  for (const line of LINK_LINES()) if (t.endsWith(`\n\n${line}`)) return [t.slice(0, -(line.length + 2)), line];
  return [t, ""];
}
// A specialist's card put up: its message, whether this call recorded it, and whether the
// link made it by itself (not Cain's show).
type Put = { message: string; first: boolean; fromLink?: boolean };

export class Link {
  private chain: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  private headChecked = new Map<string, number>();
  private going = new Map<number, Promise<Put>>();   // cards being put up now (putUp)
  private cainWaits = new Set<number>();             // cards Cain's show waits on now: a lapse found meanwhile is his to hear
  private limitedAt = -Infinity;                     // when Discord last rate-limited the link
  private rest: Rest;
  constructor(private d: Deps) {
    // Every call to Discord, noting a rate limit: the moving Stop waits a minute after one.
    this.rest = async (...a) => {
      let r: any;
      try { r = await d.rest(...a); }
      catch (e) { if (/discord 429/.test(String(e))) this.limitedAt = d.now(); throw e; }
      if (a[0] === "POST" && r && typeof r === "object") this.noteStamp((r as any).id);
      return r;
    };
  }
  // Round 17: the Pi's clock against Discord's, from the newest Discord-stamped id the link saw (a message it
  // posted, or an interaction). It only flags the Pi's clock off: it decides what is posted and whether the
  // restore sweep's done mark is written, never whether a tap or a line counts.
  private skew: number | null = null;
  // Round 18: the newest Discord-stamped id the link has seen in this process (a post, an interaction, his DM's
  // last message), the anchor a source check is handed over with.
  private newestSf: string | null = null;
  private noteStamp(id: unknown): void {
    const x = String(id ?? "");
    if (!/^\d{15,22}$/.test(x)) return;
    this.skew = this.d.now() - snowflakeTime(x);
    if (this.newestSf === null || BigInt(x) > BigInt(this.newestSf)) this.newestSf = x;
  }
  // Round 18: Discord's time now as the link best knows it, from the Pi's clock and the offset measured against
  // Discord's stamps in this run. It decides only when something is posted or a card's buttons come off, never
  // whether a tap or a line counts.
  private discordNow(): number { return this.d.now() - (this.skew ?? 0); }
  // Round 18: a source check's Discord anchor: the newest of his DM's last message id (read from Discord now),
  // the message the ask replies to, and the newest stamp this run has seen. Each is a Discord time no later than
  // the hand-over, so a check is never fresher than it is. null: Discord gave none.
  private async checkAnchor(replyTo?: string): Promise<string | null> {
    let best: string | null = this.newestSf;
    const take = (x: unknown) => { const v = String(x ?? ""); if (/^\d{15,22}$/.test(v) && (best === null || BigInt(v) > BigInt(best))) best = v; };
    take(replyTo);
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      const ch = await this.rest("GET", `/channels/${dm}`);
      take(ch?.last_message_id);
    } catch (e) { this.log(`couldn't read his DM's last message for a source check's anchor: ${String(e).slice(0, 80)}`); }
    return best;
  }
  private piClockOff(): boolean { return this.piClock() === "off"; }
  // Round 18: the Pi's clock verdict: unknown until this run has compared a Discord stamp (a post or a tap) with it,
  // then in step or off. Unknown is never taken as in step: the restore sweep's done mark waits for "in step", and the
  // "clock is off" line for a comparison that says off.
  private piClock(): "unknown" | "in step" | "off" {
    if (this.skew === null) return "unknown";
    return Math.abs(this.skew) > CLOCK_TOLERANCE_MS ? "off" : "in step";
  }
  // Round 17: the monotonic clock (this process only), for bounds that must not follow a step of the Pi's clock.
  private mono(): number { return this.d.mono ? this.d.mono() : performance.now(); }
  // Round 16: the newest message in his DM when this link started (its channel's last message id, by
  // snowflake, never a clock), taken at the first sweep, which runs at the start: a message of his is live only
  // when it is newer. Lines read back from older history draw no reply and no code. Until it is taken (no
  // sweep yet, or Discord didn't answer), no line can be told live.
  private started: Promise<string | null> | null = null;
  private async markStart(): Promise<string | null> {
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      const ch = await this.rest("GET", `/channels/${dm}`);
      const id = String(ch?.last_message_id ?? "");
      if (ch && typeof ch === "object" && (ch.last_message_id === null || /^\d{15,22}$/.test(id))) { this.log(`this start's mark in his DM: message ${id || "none yet"}`); return id || "0"; }
      throw new Error("Discord didn't give his DM's last message");
    } catch (e) { this.log(`couldn't mark this start in his DM (${String(e).slice(0, 80)}): an owner line waits for a start mark`); this.started = null; return null; }
  }
  private async startMark(): Promise<string | null> { return this.started ? this.started : null; }
  relayLine(text: string): void { this.d.relay(text); }
  private log(line: string) { (this.d.log ?? console.log)(`[cain] link: ${line}`); }

  // -- the gate (../gate/rules.ts) -----------------------------------------------------
  // The rules for a send point, on words about to go out: every hit is logged, dash and
  // app hits come back fixed, and the refusals come back for the caller to act on. A rule
  // that fails lets the words go as they are.
  private words(point: string, writer: Writer, text: string, ctx: Context, message?: string):
      { text: string; refused: Hit[]; fixed: Hit[]; hits: Hit[] } {
    const t = String(text ?? "");
    try {
      const r = gateCheck(t, ctx);
      return { text: r.fixed, hits: r.hits, fixed: r.hits.filter((h) => h.result === "fix"),
        refused: r.hits.filter((h) => h.result === "refuse" || h.result === "unsure") };
    } catch (e) {
      this.log(`the gate failed on a ${point}: ${String(e).slice(0, 80)}`);
      return { text: t, hits: [], fixed: [], refused: [] };
    }
  }
  private report(point: string, writer: Writer, hits: Hit[], did: string, message?: string): void {
    if (!hits.length || !this.d.report) return;
    try { this.d.report({ point, writer, ...(message ? { message } : {}), hits, did }); }
    catch (e) { this.log(`couldn't log the gate's report: ${String(e).slice(0, 80)}`); }
  }
  // Cain's words through the link: fixed, or refused with what to change. He's a writer the
  // gate refuses, so every em dash of his is refused, none fixed. His own rules too
  // (../gate/cain.ts): a Reviewed line only as the review service gave it (reviewed), on a
  // Ship card no checks or review claimed (shipWords), and never a record code (always).
  private cainWords(point: string, what: string, text: string, ctx: Context,
                    also: { reviewed?: boolean; shipWords?: boolean; published?: Reviewed[] | null } = {}): { text: string; fixed: Hit[] } {
    const w = this.words(point, "cain", text, { ...ctx, refusable: true });
    const cain: CainHit[] = [];
    let published: Reviewed[] | null = null;
    try {
      if (also.shipWords) cain.push(...shipWordsHits(text));
      // published: the review service's lines as the caller already read them, so a check and
      // what its result means rest on the same read (a held ask, below); else read now.
      if (also.reviewed && claimsReview(text)) {
        published = also.published !== undefined ? also.published : this.published();
        cain.push(...reviewedHits(text, published));
      }
      if (mayHaveCode(text)) cain.push(...codesHits(text, this.itemIds()));
    } catch (e) { this.log(`the gate's own rules for Cain failed on a ${point}: ${String(e).slice(0, 80)}`); }
    if (w.refused.length || cain.length) {
      this.report(point, "cain", [...w.hits, ...cain], "refused");
      throw new Refusal(heldLine(what, w.refused, ctx.buttons ?? undefined, cain, published));
    }
    this.report(point, "cain", w.hits, "fixed");
    return w;
  }
  // The item ids his record has (open or done), for the codes rule; null when it can't be read.
  private itemIds(): Set<string> | null {
    try { return recordItems(this.files().pending); } catch { return null; }
  }
  // The review service's lines now, from the last 30 days; null when they can't be read.
  private published(): Reviewed[] | null {
    let list: Reviewed[] | null;
    try { list = this.d.reviewed?.() ?? null; } catch { list = null; }
    return list && freshReviewed(list, this.d.now());
  }
  // The link's own words, and the specialist's notes after a tap: fixed only.
  private ownWords(point: string, writer: Writer, text: string, message?: string): string {
    const w = this.words(point, writer, text, { rules: writer === "specialist" ? AT.answer : AT.link });
    this.report(point, writer, w.hits, "fixed", message);
    return w.text;
  }

  // Labels on the cards whose buttons are up and count now.
  private liveLabels(s = this.d.load(), now = this.d.now()): string[] {
    return Object.values(s.messages).filter((m) => live(m, now)).flatMap((m) => m.labels ?? []);
  }

  // The cards now, as the reply hook reads them (GET /cards).
  cardsNow(): CardsView { return cardsView(this.d.load(), this.d.now()); }
  // The same for the route, which also learns his DM's id when it has none yet (a first
  // start, or a new bot token after forget()): it asks Discord, waiting at most waitMs so the
  // hook keeps to its 1.5 s. A slower answer is kept for the next send. One ask at a time.
  private naming: Promise<void> | null = null;
  async cardsFor(waitMs = NAME_WAIT_MS): Promise<CardsView> {
    if (!this.d.load().dm) {
      this.naming ??= this.identity().then(() => {}, (e) => this.log(`couldn't ask Discord whose bot this is: ${reason(e)}`))
        .finally(() => { this.naming = null; });
      await within(this.naming.then(() => null), waitMs);
    }
    return this.cardsNow();
  }

  // keeper.sh check: what the gate does with a reply or an edit of Cain's, against the cards
  // up now (the reply hook's decision, less its third try and the proof from his session's
  // transcript that a fresh message is his reply). Sends nothing, logs nothing.
  checkSend(a: { text?: unknown; replyTo?: unknown; edit?: unknown }): Decision & { status: "ok" } {
    const text = String(a.text ?? "");
    if (!text.trim()) throw new Refusal("needs the text to check");
    const id = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
    const replyTo = id(a.replyTo), target = id(a.edit);
    for (const v of [replyTo, target]) if (v !== undefined && !SNOWFLAKE.test(v)) throw new Refusal("a message id is a Discord id");
    const d = decideSend(target ? { tool: "edit", text, target } : { tool: "reply", text, replyTo }, this.cardsNow(),
      { tz: this.d.tz, now: this.d.now(), ...(claimsReview(text) ? { reviewed: this.published() } : {}),
        ...(mayHaveCode(text) ? { items: this.itemIds() } : {}) });
    return { status: "ok", ...d };
  }

  // -- Stop everything ----------------------------------------------------------
  // A state that can't be read counts as stopped: when in doubt, nothing ships. A Stop
  // he tapped that couldn't be saved still holds here, in the link, until he undoes it.
  private stopHeld = false;              // his Stop, held in memory because saving it failed
  private stopUnsaved = false;           // the last Stop or Turn back on couldn't be saved
  private changed: { kind: "stopped" | "resumed"; at: number } | null = null;   // his last tap that changed it
  stopped(): StopState {
    let s: StopState;
    try { s = this.d.stop ? this.d.stop.read() : { stopped: true, at: null }; } catch { s = { stopped: true, at: null }; }
    return this.stopHeld && !s.stopped ? { stopped: true, at: null } : s;
  }

  // Only from his tap (onInteraction checks it's him first). A second Stop changes nothing.
  // Only a change is written, so a second tap leaves its time (and the Ship taps signed
  // since) as they were.
  private setStop(stopped: boolean): void {
    const was = this.stopped();
    if (was.stopped === stopped && !this.stopUnsaved) return;
    let saved = true;
    try {
      if (!this.d.stop) throw new Error("no Stop state");
      this.d.stop.write(stopped, this.d.now());
    } catch (e) { saved = false; this.log(`couldn't save the Stop state: ${String(e).slice(0, 80)}`); }
    this.stopHeld = stopped && !saved;
    this.stopUnsaved = !saved;
    this.changed = { kind: stopped ? "stopped" : "resumed", at: this.d.now() };
    this.log(stopped ? "Dane tapped Stop: everything is stopped" : "Dane turned everything back on");
    // In the moving Stop's queue: a move under way finishes first, then this one reads the
    // new state (stopped: the moving Stop comes off; back on: it returns).
    void this.inStopQueue(() => this.placeStop());
    if (!saved) {
      this.d.relay(stopped
        ? "Dane tapped Stop, but it couldn't be saved, so your Build and Ship runs and review sends may not be held. The link still refuses Ship cards and won't sign a Ship tap. Run nothing until it's saved; his notice says so. Log it as a Build item."
        : "Dane tapped Turn back on, but it couldn't be saved, so your runs and review sends may still be stopped. His notice says so. Log it as a Build item.");
      return;
    }
    this.d.relay(stopped
      ? "Dane tapped Stop. Everything of yours is stopped: no Build or Ship runs, no Ship cards and no review sends, until he taps Turn back on; a job already running finishes. The calendar specialist gets the Stop too. Only he can turn it back on, and his notice already says so: never ask him to. Don't offer Start or Ship meanwhile (see Stop in your CLAUDE.md)."
      : "Dane tapped Turn back on: Build and Ship runs, Ship cards and review sends work again. A Ship tap from before his Stop no longer counts. Ask again about anything that waited.");
  }

  // What his Stop or Turn back on notice adds about Cain's side, from what's true now.
  // Only for the notice that follows his tap that changed it (within 10 minutes): a
  // specialist's "Not stopped" after a tap that changed nothing gets no line.
  private stopLine(kind: "stopped" | "resumed"): string {
    const now = this.stopped().stopped;
    const fresh = this.changed?.kind === kind && this.d.now() - this.changed.at < 10 * 60_000;
    if (!fresh) return "";
    if (this.stopUnsaved)
      return kind === "stopped" && now ? STOP_UNSAVED : kind === "resumed" ? RESUME_UNSAVED : "";
    if (kind === "stopped" && now) return STOPPED_TOO;
    if (kind === "resumed" && !now) return RESUMED_TOO;
    return "";
  }

  // Asks go out one at a time, so two can never both be "the open one".
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private files(): RecordFiles {
    try { return this.d.record?.() ?? { pending: null, holds: null }; } catch { return { pending: null, holds: "" }; }
  }

  private nextMorning(ms: number): number { return nextCheckin(ms, this.d.tz ?? "America/New_York"); }
  // An ask (and a Ship card) lasts until the first morning check-in at least two hours
  // off: one posted at 7:05 AM lasts until tomorrow's, not five minutes.
  private askExpiry(now: number): number { return this.nextMorning(now + ASK_GRACE_MS); }

  // -- identity -------------------------------------------------------------
  async identity(): Promise<{ owner: string; dm: string; bot: string }> {
    const s = this.d.load();
    if (s.owner && s.dm && s.bot) return { owner: s.owner, dm: s.dm, bot: s.bot };
    const app = await this.rest("GET", "/oauth2/applications/@me");
    const owner = String(app?.team?.owner_user_id ?? app?.owner?.id ?? "");
    const me = await this.rest("GET", "/users/@me");
    const bot = String(me?.id ?? "");
    if (!owner || !bot) throw new Error("Discord didn't say whose bot this is");
    const ch = await this.rest("POST", "/users/@me/channels", { recipient_id: owner });
    const dm = String(ch?.id ?? "");
    if (!dm) throw new Error("no DM channel");
    const s2 = this.d.load();
    Object.assign(s2, { owner, dm, bot });
    this.d.save(s2);
    return { owner, dm, bot };
  }

  forget(): void {
    const s = this.d.load();
    delete s.owner; delete s.dm; delete s.bot;
    this.d.save(s);
  }

  // A card with buttons still on is never forgotten: the sweep takes them off first.
  private prune(s: State, now: number): void {
    for (const [k, v] of Object.entries(s.messages)) if (v.until <= now && !v.buttons) delete s.messages[k];
  }

  // -- the link's own state: its high-water mark and its self-heal (0.12.0) -----------------
  // The highest generation this process has seen in its state (posted, intended, or a verified
  // ledger read), kept in memory so a state that stops reading can be rewritten above it.
  private highWater = 0;
  private noteHigh(s: State): void {
    let g = Math.max(this.highWater, s.postedGen ?? 0, s.intendedGen ?? 0, s.ledgerGen ?? 0);
    for (const m of Object.values(s.messages ?? {})) if (typeof m.checked?.gen === "number" && m.checked.gen > g) g = m.checked.gen;
    this.highWater = g;
  }
  private stateBad = 0;
  stateUnreadable = false;
  // At start and at each sweep: the link's state file as it is on disk. One failed read is looked at
  // again next round (a write caught in the middle never latches); after two in a row, the state is
  // rewritten whole (an atomic rename) with a generation of the larger of the keeper's floor and
  // this process's high-water mark, plus a margin, and Dane gets one notice through the notice path.
  // The unreadable flag clears only on a verified good read. Returns whether the state reads now.
  private async healState(): Promise<boolean> {
    if (!this.d.stateHealth) return true;
    let h: { ok: boolean; why?: string };
    try { h = this.d.stateHealth(); } catch (e) { h = { ok: false, why: String(e).slice(0, 80) }; }
    if (h.ok) {
      this.stateBad = 0;
      if (this.stateUnreadable) { this.stateUnreadable = false; this.log("the link's state reads again (a verified read): cards go on as usual"); }
      try { this.noteHigh(this.d.load()); } catch { /* the next sweep */ }
      return true;
    }
    this.stateBad++;
    if (this.stateBad < 2) { this.log(`the link's state didn't read (${h.why ?? "unreadable"}); reading it again next round before rewriting it`); return false; }
    if (this.stateUnreadable) return false;                         // rewritten already: waiting on a good read
    const floor = keeperStatus(this.files().status)?.generation;
    const g = Math.max(Number.isInteger(floor) ? floor! : 0, this.highWater) + HEAL_GEN_MARGIN;
    try {
      const s = this.d.load();
      s.intendedGen = Math.max(s.intendedGen ?? 0, g);
      s.postedGen = Math.max(s.postedGen ?? 0, g);
      this.d.save(s);
    } catch (e) { this.log(`couldn't rewrite the link's state: ${String(e).slice(0, 80)}; trying again next round`); return false; }
    this.stateUnreadable = true;
    this.highWater = Math.max(this.highWater, g);
    this.log(`HEAL: the link's state didn't read twice in a row (${h.why ?? "unreadable"}): rewritten with generation ${g}; cards go on once it reads again`);
    try { await this.notice(HEAL_NOTICE); } catch (e) { this.log(`couldn't tell him the link's state was rebuilt: ${String(e).slice(0, 80)}`); }
    this.d.relay(`The link's own saved state was damaged and has been rebuilt (generation ${g}). Cards that were up may have lost their record: check each item still open at its source and ask again with --checked if it still needs him. He got one notice from the App; nothing more to tell him.`);
    return false;
  }

  private remember(s: State, msg: any, extra: Partial<Shown> = {}): void {
    const now = this.d.now();
    this.prune(s, now);
    const id = String(msg.id);
    s.messages[id] = { ...(s.messages[id] ?? {}), ...extra,
      digest: digest(msg.content ?? "", msg.components), until: now + REMEMBER_MS };
    const gen = extra.checked?.gen;
    if (typeof gen === "number" && gen > (s.postedGen ?? 0)) s.postedGen = gen;
    if (typeof gen === "number" && gen > this.highWater) this.highWater = gen;
  }

  private async post(text: string, comps: any[], opts: { timeoutMs?: number; replyTo?: string; nonce?: string } = {}): Promise<any> {
    const { dm } = await this.identity();
    const body: any = { content: fit(text), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS };
    if (comps.length) body.components = comps;
    // An answer to a tap or a message is a Discord reply to it.
    if (opts.replyTo) body.message_reference = { message_id: opts.replyTo, channel_id: dm, fail_if_not_exists: false };
    if (opts.nonce) Object.assign(body, { nonce: opts.nonce, enforce_nonce: true });
    const msg = opts.timeoutMs === undefined ? await this.rest("POST", `/channels/${dm}/messages`, body)
      : await this.rest("POST", `/channels/${dm}/messages`, body, true, opts.timeoutMs);
    if (!msg?.id) throw new Error("no message returned");
    return msg;
  }

  // A card that must be new. Discord hands back the message already made for the same
  // nonce (a retry after a lost answer); if that one is a card already done with (the
  // same words asked again), this posts a fresh one.
  private async postCard(text: string, comps: any[], opts: { replyTo?: string; nonce: string }): Promise<any> {
    const msg = await this.post(text, comps, opts);
    if (!this.d.load().messages[String(msg.id)]?.outcome) return msg;
    return this.post(text, comps, { ...opts, nonce: stableNonce(opts.nonce, String(this.d.now())) });
  }

  // Cain may ask about an item only while no one else holds it, and not once it's closed.
  private mayAsk(item: string): void {
    if (item === "none") return;
    const f = this.files();
    const holds = parseHolds(f.holds);
    if (holds === null) throw new Refusal("holds.json can't be read right now, so the link can't tell whether that item is yours; try again in a minute");
    if (heldElsewhere(holds, item))
      throw new Refusal(`${item} is held by another session. Don't ask him about it or say who has it. If he asked you to work on it, take it first through the record keeper, citing his message.`);
    if (closedItems(f.pending).has(item.toUpperCase())) throw new Refusal(`${item} is closed in PENDING.md`);
  }

  // A status is checked at its source before it drives a question to him (his rule of
  // Nov 13). An ask or Ship card for an item goes out only on a source check of the row as
  // it stands that the record keeper accepted: its ledger (state/checks.json) gives each
  // open row a hidden id and a version that goes up when its content changes, and a check
  // counts only while the version it checked is the row's version and it is no older than
  // the App's source_check_max_days. A check that is only pending never posts a card.
  // given: a check passed now (what was checked, where and when). Returns the check to hand
  // the keeper, with the row's id and version as read, or null when one on record counts.
  private sourceCheck(item: string, given: unknown): { text: string; row: string | null; version: number } | null {
    if (item === "none") return null;
    const id = item.toUpperCase();
    const e = this.ledger()[id];
    const raw = given === undefined || given === null ? "" : String(given);
    if (e?.pending_rewrite)
      this.refuse("check", id, `This item's row is pending a rewrite: a whole-file write of it was refused (${clip(e.pending_rewrite, 200)}). Write the row cleanly, one fact per row, then ask with a new --checked.`);
    if (raw.trim()) {
      const t = raw.trim();
      const why = checkTextProblem(t);
      if (why) this.refuse("check", id, why);
      // The same check again while it still counts (a card refused for its words, sent again):
      // the accepted one stands. A repeat can't make a stale row fresh.
      if (repeatsCheck(e?.checked, t) && this.freshRef(id)) return null;
      if (repeatsCheck(e?.checked, t))
        this.refuse("check", id, `that source check repeats the row's last one ("${clip(e!.checked!, 120)}": the same words, no later time); check again and say what you found this time, where and when`);
      return { text: t, row: e?.id ?? null, version: e ? e.version : 0 };
    }
    if (this.freshRef(id)) return null;
    const since = e?.changed ? Date.parse(e.changed) : NaN;
    const until = staleAfter(e, this.maxDays());
    if (e && e.checked !== undefined && !inStep(e, this.files().pending, id))
      throw new Refusal("This item's row was changed outside the record keeper since its check; the keeper gives it a new version on its next round. Check it at its source again and add --checked.");
    if (e?.checked !== undefined && e.checked_version === e.version && Number.isFinite(until))
      throw new Refusal(`The source check on this item went stale after ${shortDay(until, this.d.tz)} (older than ${this.maxDays()} days); add --checked with what you checked, where and when.`);
    throw new Refusal(Number.isFinite(since) && e?.checked
      ? `No source check on this item since its row changed on ${shortDay(since, this.d.tz)}; add --checked with what you checked, where and when.`
      : "No source check on this item yet; add --checked with what you checked, where and when.");
  }

  private ledger(): Checks { return ledgerOf(this.files().checks); }
  private maxDays(): number { return maxCheckDays(this.d.maxCheckDays); }

  // A refusal of a source check or a one-off: quoted as said, and logged for tuning the rules.
  private refuse(kind: string, item: string, said: string): never {
    try { this.d.tune?.({ at: new Date(this.d.now()).toISOString(), kind, item, said: clip(said, 600) }); } catch { /* the refusal stands */ }
    throw new Refusal(said);
  }

  // Whether a posted ask or Ship card for an item still rests on an accepted check, from a fresh
  // read of the keeper's local ledger, its status and the check's outcome file (never the table's
  // order):
  //   "ok"       the check's outcome is done, the row's hidden id and version are the card's, its
  //              cells are as the keeper last wrote them, the check is fresh and unexpired (and
  //              not dated after the clock now reads), the ledger's generation is no lower than
  //              the card's, and, for a tap, the box's clock is synchronized now;
  //   "changed"  any of that is known to be otherwise (a card with no check counts so);
  //   "behind"   the ledger's generation is below the card's (it went backwards);
  //   "unknown"  a read failed, or (for the sweep) isn't a verified read: the ledger doesn't parse
  //              or is below the generation last seen, the list or the outcome can't be read, or
  //              a push just failed;
  //   "busy"     the read took longer than TAP_READ_MS;
  //   "clock"    a tap while the box's clock isn't synchronized;
  //   "reset"    the keeper reset its copy and hasn't pushed since;
  //   "unpushed" a tap while the keeper's push has failed for over UNPUSHED_TAP_MS.
  // A tap is honoured only on "ok"; the sweep takes buttons off only on "changed".
  private checkState(item: string, ref: Ref | undefined, o: { sweep?: boolean; seen?: number } = {}): CheckState {
    if (!ref || !ref.req) return "changed";
    const t0 = Date.now();
    let f: RecordFiles | undefined, out: { state: string } | null | undefined;
    try {
      f = this.d.record?.();
      out = this.d.outcome?.(ref.req);
    } catch { return "unknown"; }
    if (Date.now() - t0 > this.readLimit()) return "busy";
    return this.judge(item, ref, f, out, o);
  }

  // A tap's fresh read, after its deferred answer went to Discord: the keeper's files read with a
  // hard limit (TAP_READ_MS), the read itself cancelled through an abort signal when the limit
  // passes, so a stalled read answers "busy" within the limit.
  private async tapState(item: string, ref: Ref | undefined, kind?: string, at?: number | null): Promise<CheckState> {
    if (!ref || !ref.req) return "changed";
    const r = await this.freshRead(ref.req);
    if (r === "busy" || r === "unknown") return r;
    return this.judge(item, ref, r.files, r.outcome, { kind, at });
  }

  // One fresh read of the keeper's files, raced against the limit: "busy" past it (the read is
  // aborted), "unknown" when it failed. Its time is kept for keeper.sh clock.
  // One settle guard per read: whichever comes first, the limit or the read, decides, once, before
  // anything is done with it. A read that finishes after the limit (by 1 ms, or one that ignored its
  // cancellation) is disqualified for good: its files are never used. At most one read is in flight:
  // while one is pending (even one that ignored its cancellation, up to INFLIGHT_MAX_MS), another
  // tap answers busy at once without starting a read.
  private async freshRead(req: string | null): Promise<{ files: RecordFiles | undefined; outcome: { state: string; reason?: string } | null | undefined; ms: number } | "busy" | "unknown"> {
    const limit = this.readLimit();
    const maxMs = this.d.inflightMaxMs ?? INFLIGHT_MAX_MS;
    if (this.inflight && Date.now() - this.inflight.since < maxMs) {
      this.tapRead = { ms: 0, at: this.d.now() };
      this.log("tap answered busy at once: another fresh read is still in flight");
      return "busy";
    }
    const ac = new AbortController();
    const t0 = Date.now();
    const slow = this.slowNext;
    this.slowNext = 0;
    const stall = this.stallNext;
    this.stallNext = 0;
    const read = (async () => {
      if (stall) await new Promise<void>((ok) => setTimeout(ok, stall));   // the smoke test's stalled read: ignores cancellation
      if (slow) await abortable(slow, ac.signal);   // the smoke test's delayed read (keeper.sh slow-read)
      if (this.d.readFresh) return this.d.readFresh(req, ac.signal);
      return { files: this.d.record?.(), outcome: req ? this.d.outcome?.(req) : null };
    })();
    const mine = { since: Date.now() };
    this.inflight = mine;
    // The ceiling: a read still pending after INFLIGHT_MAX_MS is killed (its signal aborts, and what it
    // spawned is killed as a process group) and its slot released here, whether or not it ever
    // settles. One line logged per hung read.
    const ceiling = setTimeout(() => {
      if (this.inflight !== mine) return;
      if (!ac.signal.aborted) ac.abort();
      try { this.d.killRead?.(); } catch { /* the slot is released anyway */ }
      this.inflight = null;
      this.log(`a fresh read never settled within ${maxMs / 1000} s: killed as a group, and its slot released`);
    }, maxMs);
    read.catch(() => {}).finally(() => { clearTimeout(ceiling); if (this.inflight === mine) this.inflight = null; });
    type Got = Awaited<typeof read>;
    const verdict = await new Promise<{ by: "busy" } | { by: "read"; r: Got } | { by: "error" }>((done) => {
      let settled = false;
      const decide = (v: { by: "busy" } | { by: "read"; r: Got } | { by: "error" }) => { if (settled) return; settled = true; clearTimeout(timer); done(v); };
      const timer = setTimeout(() => { ac.abort(); decide({ by: "busy" }); }, limit);
      read.then((r) => decide(Date.now() - t0 > limit ? { by: "busy" } : { by: "read", r }), () => decide({ by: "error" }));
    });
    const ms = Date.now() - t0;
    if (verdict.by === "error") { this.tapRead = { ms, at: this.d.now() }; return "unknown"; }
    if (verdict.by === "busy") { if (!ac.signal.aborted) ac.abort(); this.tapRead = { ms: Math.max(ms, limit), at: this.d.now() }; return "busy"; }
    this.tapRead = { ms, at: this.d.now() };
    this.lastFresh = verdict.r.files;
    return { ...verdict.r, ms };
  }
  private inflight: { since: number } | null = null;
  private stallNext = 0;
  // The smoke test's stalled read (keeper.sh stall-read): a read held for that long, ignoring its
  // cancellation, while a journal write is made and timed, and a second read is tried (it must be
  // answered busy at once, without starting).
  async stallRead(seconds = 20): Promise<Record<string, unknown>> {
    const ms = Math.max(1, Math.min(120, Number(seconds) || 20)) * 1000;
    this.stallNext = ms;
    const first = this.freshRead(null);
    await new Promise<void>((ok) => setTimeout(ok, 10));
    const t0 = Date.now();
    const second = await this.freshRead(null);
    const answered = Date.now() - t0;
    const t1 = Date.now();
    const s = this.d.load();
    s.journalProbe = this.d.now();
    this.d.save(s);
    const wrote = Date.now() - t1;
    const r1 = await first;
    return { status: "ok", stalled_ms: ms, first: r1 === "busy" ? "busy" : "read", second_tap: second === "busy" ? "busy at once" : "read", second_answered_ms: answered,
      journal_write_ms: wrote, still_in_flight: this.inflight !== null, pass: r1 === "busy" && second === "busy" && answered < 100 && wrote < 1_000,
      said: `A read is held ${ms / 1000} s and ignores its cancellation: taps answer busy at once meanwhile, and a journal write still finished in ${wrote} ms.` };
  }
  // The smoke test's one delayed read (ms), and the files of the last fresh read that finished.
  private slowNext = 0;
  private lastFresh: RecordFiles | undefined;
  // The tap read's limit: the App's tap_read_ms option, TAP_READ_MS when unset.
  private readLimit(): number { return this.d.tapReadMs ?? TAP_READ_MS; }
  // The smoke test's forced webhook failure: the next time a busy tap puts a card's buttons back, the
  // interaction's webhook patch fails on purpose, so the buttons must come back through the fallback
  // (the bot's own edit by channel and message id: the link posts cards as the bot, so its token may
  // edit their components).
  private failWebhookNext = false;
  failWebhook(): { status: "ok"; said: string } {
    this.failWebhookNext = true;
    return { status: "ok", said: "The next busy tap's webhook patch fails on purpose: its card's buttons must come back by the bot's edit by channel and message id (link.log: \"editing it by channel and message id\")." };
  }
  slowRead(): { status: "ok"; said: string; delay_ms: number } {
    const limit = this.readLimit();
    this.slowNext = limit + 1_000;
    return { status: "ok", said: `The next tap's fresh read waits ${this.slowNext} ms, past its ${limit} ms limit: it must answer "${BUSY_TAP}" and keep its buttons.`, delay_ms: this.slowNext };
  }

  // The smoke test's measured reads: n fresh reads, gapMs apart (spread over more than a keeper
  // round, so some run while a round fetches), with their times, the 95th percentile and how many
  // keeper rounds ended meanwhile.
  async probeReads(n = 20, gapMs = 4_000): Promise<Record<string, unknown>> {
    const count = Math.max(1, Math.min(50, Math.floor(Number(n) || 20)));
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    const ms: number[] = [], rounds = new Set<string>();
    let busy = 0;
    for (let i = 0; i < count; i++) {
      if (i) await sleep(gapMs);
      const r = await this.freshRead(null);
      if (r === "busy") busy++;
      ms.push(this.tapRead?.ms ?? 0);
      const st = r !== "busy" && r !== "unknown" ? keeperStatus(r.files?.status) : null;
      if (st?.at) rounds.add(st.at);
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
    const p50 = pct(0.5), p95 = pct(0.95), limit = this.readLimit();
    // It fails loudly once the 95th percentile is over half the limit: taps would go busy too often.
    const pass = p95 <= limit / 2 && busy === 0;
    return { status: "ok", reads: count, reads_ms: ms, p50_ms: p50, p95_ms: p95, max_ms: sorted.at(-1), busy, limit_ms: limit,
      keeper_rounds_seen: Math.max(0, rounds.size - 1), pass,
      ...(pass ? {} : { fail: `FAIL: p95 ${p95} ms is over half the tap read limit (${limit} ms)${busy ? `, and ${busy} read(s) went busy` : ""}: raise tap_read_ms or find what slows the box's reads` }) };
  }

  // The verdict on what a read found (see checkState).
  // Round 18: o.at, Discord's time for the tap (its interaction snowflake): a check counts for a tap only when it
  // is no more than source_check_max_days older than the tap by Discord's times (its anchor, freshByDiscord). With
  // no tap (a sweep, an arming re-check), Discord's time as the link best knows it: that decides only when buttons
  // come off or a card is armed, never whether a tap counts.
  private judge(item: string, ref: Ref, f: RecordFiles | undefined, out: { state: string } | null | undefined, o: { sweep?: boolean; seen?: number; kind?: string; at?: number | null }): CheckState {
    if (!f || typeof f.checks !== "string") return "unknown";
    const st = keeperStatus(f.status);
    if (st === null) return "unknown";
    if (st?.reset) return "reset";
    if (o.sweep && this.pushTrouble(st)) return "unknown";
    try { JSON.parse(f.checks); } catch { return "unknown"; }
    if (o.sweep && typeof f.pending !== "string") return "unknown";   // the working copy isn't intact
    const gen = generationOf(f.checks);
    if (o.sweep && gen < (o.seen ?? 0)) return "unknown";
    // A card posted before the latest reset epoch: the check it rests on was accepted before the
    // reset (and may have been superseded in a commit the reset lost), so it never counts again.
    // A card stamped with its epoch counts only in that very epoch (equality, not ordering: a status
    // that came back with an older or a skipped epoch never validates it); one from before the stamp
    // goes by the epoch's generation.
    const cur = st?.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0;
    if (ref.epoch !== undefined) { if (ref.epoch !== cur) return "epoch"; }
    else if (st?.epoch && Number.isInteger(st.epoch.generation) && (ref.gen === undefined || ref.gen < st.epoch.generation)) return "epoch";
    if (ref.gen !== undefined && gen < ref.gen) return "behind";
    if (!out) return "unknown";
    if (out.state !== "done") return "changed";
    const id = item.toUpperCase(), e = parseChecks(f.checks)[id];
    if (!e || e.id !== ref.row || e.version !== ref.version) return "changed";
    if (typeof f.pending !== "string" && e.hash) return "unknown";   // the row's cells can't be compared
    const anchor = e.checked_sf ?? (e.checked_req && e.checked_req === ref.req ? ref.sf : undefined);
    if (!inStep(e, f.pending, id) || !freshByDiscord(e, anchor, typeof o.at === "number" ? o.at : this.discordNow(), this.maxDays())) return "changed";
    if (!o.sweep && !this.clockOk(st)) return "clock";
    // Honoured while a push fails, but not once the failure is older than UNPUSHED_TAP_MS.
    if (!o.sweep && st?.unpushed && this.d.now() - outageSince(st) > UNPUSHED_TAP_MS) return "unpushed";
    // A Ship tap is irreversible: it waits for a landed push, however short the failure.
    if (!o.sweep && o.kind === "ship" && st?.unpushed) return "ship-unpushed";
    return "ok";
  }

  // The last tap's read time, for the smoke test (keeper.sh clock).
  private tapRead: { ms: number; at: number } | null = null;

  // Cards whose buttons the sweep left on for want of a verified read (logged once each).
  private sweepHeld = new Set<string>();

  // The ledger's generation from a verified read (it parses, isn't below the one last seen, the
  // list and the keeper's status are readable, no reset and no recent push error), or null.
  private verifiedGen(f: RecordFiles, seen: number): number | null {
    if (typeof f.checks !== "string" || typeof f.pending !== "string") return null;
    try { JSON.parse(f.checks); } catch { return null; }
    const st = keeperStatus(f.status);
    if (st === null || st?.reset || this.pushTrouble(st)) return null;
    const gen = generationOf(f.checks);
    return gen >= seen ? gen : null;
  }

  // A push failed and hasn't landed since, or failed within PUSH_QUIET_MS: the sweep leaves
  // cards as they are.
  private pushTrouble(st: KeeperStatus | undefined): boolean {
    if (!st) return false;
    if (st.unpushed) return true;
    const at = st.push_failed ? Date.parse(st.push_failed.at) : NaN;
    return Number.isFinite(at) && this.d.now() - at < PUSH_QUIET_MS;
  }

  // Whether the box's clock is synchronized at tap time: not when the keeper's recent verdict
  // says it isn't; otherwise when the box's own sources say so now, or the keeper's recent
  // verdict does (its rounds add GitHub's Date header). With neither wired (no sources, no
  // status: the tests), yes.
  private clockOk(st: KeeperStatus | undefined): boolean {
    const now = this.d.now();
    const c = st?.clock, at = c ? Date.parse(c.at) : NaN;
    const recent = Number.isFinite(at) && Math.abs(now - at) <= KEEPER_CLOCK_FRESH_MS;
    if (recent && c!.synced !== true) return false;
    let local: Verdict | null = null;
    try { local = this.d.localClock?.() ?? null; } catch { local = null; }
    if (local?.synced) return true;
    if (recent && c!.synced === true) return true;
    return !this.d.localClock && st === undefined;
  }

  // The keeper reset its copy and hasn't pushed since: asks and Ship cards wait, as taps do.
  private notReset(): void {
    const st = keeperStatus(this.files().status);
    if (st?.reset) throw new Refusal(`Nothing was posted: the record keeper had to reset its copy of the record (${clip(st.reset.why, 160)}), so asks and Ship cards wait until its next push to GitHub lands. Ask again in a few minutes.`);
    if (st?.link_state && st.link_state.readable === false)
      throw new Refusal(`Nothing was posted: the record keeper can't read the link's state just now (${clip(st.link_state.why, 80)}), so it can't keep its generation floor above the cards that are up; asks and Ship cards wait until it can. Ask again in a few minutes.`);
  }

  // A tap honoured while the keeper's ledger is unpushed (as its fresh read found): the card's
  // generation, its check, the item, the time and the tapped label, kept in the link's state in
  // /data until a push lands.
  private journal(m: Shown, cid: string, msgId: string, item: string, now: number, key?: string): void {
    const st = keeperStatus(this.lastFresh?.status);
    if (!st?.unpushed) return;
    const i = Number(cid.split(":")[2]);
    const s = this.d.load();
    (s.uncertain ??= []).push({ gen: m.checked?.gen ?? null, check: m.checked?.req ?? null, item, at: now, msg: msgId,
      label: m.q?.options[i] ?? "", ...(key ? { key } : {}), ...(m.checked?.epoch !== undefined ? { epoch: m.checked.epoch } : {}),
      ...(m.checked ? { ref: { ...m.checked } } : {}), kind: m.kind });
    s.uncertain = s.uncertain.slice(-50);
    this.d.save(s);
    this.log(`tap on card ${msgId} honoured while the record keeper's ledger is unpushed; journaled`);
  }

  // The journal against the keeper's status (each sweep): a tap made before a reset that came after
  // it stands only if the check it rested on survived the reset (its accepting request is in
  // log/requests on the keeper's current copy). One that didn't is lost to the reset: recorded so
  // under its idempotency key, and Dane (one line on the card's thread) and Cain (a relayed line)
  // hear "lost to the record's reset, please answer again". Never dropped silently. Once a push lands
  // (nothing unpushed, no reset), the journal is cleared.
  private async uncertainTaps(): Promise<void> {
    const s = this.d.load();
    if (!s.uncertain?.length) return;
    const st = keeperStatus(this.files().status);
    if (!st) return;
    const at = st.last_reset ? Date.parse(st.last_reset.at) : NaN;
    const hit = Number.isFinite(at) ? s.uncertain.filter((u) => !u.told && u.at <= at) : [];
    for (const u of hit) {
      // A tap whose claim was never acted on (the link was cut off) is finishTaps' to settle, and one
      // already lost to the reset was told: neither is told again from here.
      const c = u.key ? s.taps?.[u.key] : undefined;
      const survived = c && (c.stage === "claimed" || c.stage === "lost" || c.outcome === "lost to reset") ? true
        : this.claimSurvives(u.item, u.ref ?? s.messages[u.msg]?.checked, u.check, u.kind ?? s.messages[u.msg]?.kind);
      if (survived === null) continue;                                // can't tell yet: the next sweep looks again
      if (survived && c && c.stage !== "edited" && c.stage !== "acted") { /* settled by finishTaps */ }
      else if (survived) this.log(`journaled tap on card ${u.msg} ("${u.label}") rests on a check that survived the reset: it stands`);
      else await this.lostTap({ key: u.key, msg: u.msg, label: u.label, item: u.item, acted: true });
      const s2 = this.d.load();
      for (const x of s2.uncertain ?? []) if (x.msg === u.msg && x.at === u.at) x.told = true;
      this.d.save(s2);
    }
    if (hit.length) return;
    if (!st.unpushed && !st.reset) {
      delete s.uncertain;
      this.d.save(s);
      this.log("a push landed: the journal of taps made while the ledger was unpushed is cleared");
    }
  }

  // Whether a check request survived a reset (its done outcome is in log/requests on the keeper's
  // current copy); null: can't tell now. With nothing wired to tell (an older keeper), no.
  private survived(req: string): boolean | null {
    try { return this.d.requestLogged ? this.d.requestLogged(req) : false; } catch { return null; }
  }

  // Whether a claim (or a journaled tap) made before the current reset epoch survived it, through
  // exactly the predicate a live tap uses (judge). Survived means all of:
  //   - the accepting request is done in log/requests on the keeper's current copy;
  //   - the check was carried into the current epoch for the row's current version: the epoch's
  //     ledger write has dropped every older check (status epoch.voided), and the ledger's entry for
  //     the item now names that very request (checked_req) at the row's current version, fresh;
  //   - the ledger's generation is no lower than the card's;
  //   - and the rest of a live tap's verdict (clock, a Ship tap's unpushed hold) is "ok".
  // A check the epoch dropped comes out lost (false), even when its request is still marked done in
  // the log. null: can't tell now (no status, a reset standing, the epoch's write not made yet, a
  // read that failed, a clock or push hold): the claim waits for the next sweep.
  private claimSurvives(item: string, ref: Ref | undefined, req: string | null | undefined, kind?: string): boolean | null {
    if (!req || !ref) return false;
    const f = this.files();
    const st = keeperStatus(f.status);
    if (!st || st.reset) return null;
    const logged = this.survived(req);
    if (logged === null) return null;
    if (!logged) return false;
    const cur = st.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0;
    if (st.epoch && st.epoch.voided !== true) return null;           // the epoch's ledger write isn't made yet
    const v = this.judge(item, { ...ref, req, epoch: cur }, f, { state: "done" }, { kind });
    if (v === "ok") {
      const e = typeof f.checks === "string" ? parseChecks(f.checks)[item.toUpperCase()] : undefined;
      return e?.checked_req === req;
    }
    if (v === "changed" || v === "epoch") return false;
    return null;
  }

  // A tap lost to a reset of the record: recorded under its idempotency key (when it has one) before
  // anyone is told, then one line on the card's thread for Dane and one relayed line for Cain, and
  // the card's buttons off. acted: Cain already heard the tap (a journaled one); the line says to
  // disregard it.
  private async lostTap(t: { key?: string; msg: string; label: string; item: string; acted: boolean; repeat?: boolean }): Promise<void> {
    const kid = t.key ? tapKid(t.key) : null;
    const s = this.d.load();
    if (t.key) {
      const c = s.taps?.[t.key];
      if (c) { c.stage = "lost"; c.outcome = "lost to reset"; c.told = false; c.shown = withLine(c.words ?? c.shown, EPOCH_CHANGED); }
      else (s.taps ??= {})[t.key] = { at: this.d.now(), msg: t.msg, label: t.label, stage: "lost", outcome: "lost to reset", shown: "", item: t.item, told: false };
    }
    const m = s.messages[t.msg];
    if (m) { if (m.q) m.q.used = true; m.outcome = "expired"; m.why = "record reset"; }
    if (t.item && t.item !== "none") (s.recheck ??= {})[t.item.toUpperCase()] = { at: this.d.now(), why: "tap lost to the record's reset", ...(t.key ? { key: tapKid(t.key) } : {}) };
    this.d.save(s);
    this.d.relay(`${t.repeat ? `Repeat of tap key ${kid}: if you already had this line, ignore it. ` : ""}Dane's tap "${t.label}" on your card for ${t.item} (Discord message ${t.msg}${kid ? `, tap key ${kid}` : ""}) was lost to the record's reset, please answer again: the source check it rested on didn't survive the reset, so ${t.acted ? "disregard that tap: what he tapped no longer stands, and record nothing from it" : "nothing was done for it"}. Once the keeper has accepted ${t.item}'s re-check, ask again with --checked if it still needs him (a new card follows); ${t.item} is on the link's re-check queue until then. Nothing else to tell him: the App told him on the card.`);
    try { await this.post(LOST_TAP, [], { replyTo: t.msg }); }
    catch (e) { this.log(`couldn't tell him on card ${t.msg}'s thread that his tap was lost to the reset: ${String(e).slice(0, 80)}`); }
    this.log(`tap on card ${t.msg} ("${t.label}") lost to the record's reset: Cain and him told`);
    const s2 = this.d.load();
    if (t.key && s2.taps?.[t.key]) s2.taps[t.key].told = true;
    this.d.save(s2);
  }

  // A claim from an earlier run of the link that no longer passes the live-tap predicate (round 9):
  // never acted. Recorded under its key before anyone is told, then one line on the card's thread for
  // Dane and one relayed line for Cain, once each, and the item on the link's re-check queue.
  private async notActedTap(k: string, t: TapClaim, why: string, repeat = false): Promise<void> {
    const kid = tapKid(k), item = (t.item ?? "none").toUpperCase();
    const s = this.d.load();
    const c = s.taps?.[k];
    if (c) { c.stage = "lost"; c.outcome = "not acted"; c.why = why; c.told = false; c.shown = withLine(c.words ?? c.shown, "Not acted after a restart, re-check needed"); }
    if (item !== "NONE") (s.recheck ??= {})[item] = { at: this.d.now(), why: "tap not acted after a restart", key: kid };
    this.d.save(s);
    this.d.relay(`${repeat ? `Repeat of tap key ${kid}: if you already had this line, ignore it. ` : ""}Tap not acted: Dane's tap "${t.label}" on your card for ${item === "NONE" ? "no item" : item} (Discord message ${t.msg}, tap key ${kid}) was claimed in an earlier run of the link and no longer passes the live-tap check (${why}), so it was discarded and nothing was done for it. Record nothing from it.${item === "NONE" ? "" : ` ${item} is on the link's re-check queue: check it at its source and ask again with --checked if it still needs him (a new card follows).`} Nothing else to tell him: the App told him on the card.`);
    try { await this.post(NOT_ACTED_TAP, [], { replyTo: t.msg }); }
    catch (e) { this.log(`couldn't tell him on card ${t.msg}'s thread that his tap wasn't acted on: ${String(e).slice(0, 80)}`); }
    this.log(`claim on card ${t.msg} ("${t.label}") from an earlier link run discarded, never acted (${why}): Cain and him told`);
    const s2 = this.d.load();
    if (s2.taps?.[k]) s2.taps[k].told = true;
    this.d.save(s2);
  }

  // The link's re-check queue: an item leaves it once a new check of it is accepted.
  private clearRecheck(item: string): void {
    const s = this.d.load();
    if (!s.recheck?.[item]) return;
    delete s.recheck[item];
    if (!Object.keys(s.recheck).length) delete s.recheck;
    this.d.save(s);
    this.log(`${item} left the link's re-check queue: its re-check was accepted`);
  }

  // The live-tap predicate for a claim from an earlier run (round 9): its card is still as the claim
  // left it (answered with that label: no other run, or another version of the link, changed it), and
  // the check it rests on passes exactly the verdict a live tap gets now (judge). true: act; false
  // (with why): discard; null: can't tell now (a read failed, a reset stands, the clock, a push
  // hold), so it waits for the next sweep.
  private claimLive(t: TapClaim): { ok: boolean; why: string } | null {
    const m = this.d.load().messages[t.msg];
    if (!m) return { ok: false, why: "its card is no longer known" };
    if (!(m.q?.used && m.outcome === "answered" && m.label === t.label)) return { ok: false, why: "its card was changed since the claim" };
    const ref = t.ref ?? m.checked;
    if (!ref?.req) return { ok: false, why: "its card rests on no check" };
    let f: RecordFiles | undefined, out: { state: string } | null | undefined;
    try { f = this.d.record?.(); out = this.d.outcome?.(ref.req); } catch { return null; }
    // Round 18: judged by Discord's time for the tap (its interaction id), as it was when he tapped.
    const v = this.judge(t.item ?? "none", ref, f, out, { kind: t.kind ?? m.kind, at: /^\d{15,22}$/.test(String(t.it ?? "")) ? snowflakeTime(String(t.it)) : null });
    if (v === "ok") return { ok: true, why: "" };
    if (v === "changed") return { ok: false, why: "its status changed since it was checked" };
    if (v === "epoch") return { ok: false, why: "the record was reset since it was asked" };
    return null;
  }

  // The remote's answer for a landing's commit (merge.ts settledFrom, through d.landed): true or
  // false, or null with why when it can't be told (GitHub unreachable, a range it couldn't search).
  private async remote(ship: { pr: string; head: string }, base?: string | null): Promise<{ v: boolean | null; why: string }> {
    if (!this.d.landed) return { v: null, why: "the link has no deploy key" };
    try {
      const r = await this.d.landed(ship, base);
      if (r === true || r === false) return { v: r, why: "" };
      if (r && typeof r === "object") return { v: null, why: clip(String(r.unresolved), 160) };
      return { v: null, why: "GitHub didn't answer" };
    } catch (e: any) { return { v: null, why: clip(String(e?.message ?? e), 160) }; }
  }

  // An unresolved landing key (round 9): each failure is counted and the next look is scheduled on a
  // bounded backoff; past UNRESOLVED_TELL_FAILS failures or UNRESOLVED_TELL_MS since the first, Dane
  // hears once on the card's thread and Cain once. Returns when the key is next due.
  private async unresolvedFail(key: string, why: string, what: "orphan" | "ledger", msg?: string): Promise<number> {
    const now = this.d.now();
    const s = this.d.load();
    const u: Unresolved = (s.unresolved ??= {})[key] ?? { since: now, fails: 0, last: why, next: now, what, ...(msg ? { msg } : {}) };
    u.fails++; u.last = why; u.what = what; if (msg) u.msg = msg;
    u.next = now + Math.min(UNRESOLVED_BACKOFF_MAX_MS, 60_000 * 2 ** (u.fails - 1));
    const tell = !u.told && (u.fails >= UNRESOLVED_TELL_FAILS || now - u.since >= UNRESOLVED_TELL_MS);
    if (tell) { u.told = true; u.toldAt = now; }
    s.unresolved[key] = u;
    this.d.save(s);
    this.log(`landing for tap key ${tapKid(key)} still unresolved (${what}, failure ${u.fails}: ${why}); looked for again at ${new Date(u.next).toISOString()}`);
    if (tell) {
      const since = clockTime(u.since, this.d.tz), unreachable = /GitHub|didn't answer|fetch/i.test(why) && !/rewritten|shallow/i.test(why);
      const m = msg ? s.messages[msg] : undefined;
      this.d.relay(`Landing unconfirmed: the ${what === "ledger" ? "restored landing ledger's key" : "landing"} for tap key ${tapKid(key)}${m?.ship ? ` (${m.ship.pr} at ${m.ship.head})` : ""} can't be settled against the remote main: ${unreachable ? "it has been unreachable" : "main's history couldn't be searched"} since ${since} (${u.fails} tries; last error: ${why}). The link keeps looking by itself on a backoff; you'll hear how it settles, and no new Ship card for that pull request and head goes out meanwhile. Nothing to tell him: his card's thread says so.`);
      if (msg)
        try { await this.post(unconfirmedTap(since, unreachable), [], { replyTo: msg }); }
        catch (e) { this.log(`couldn't tell him on card ${msg}'s thread that the landing is unconfirmed: ${String(e).slice(0, 80)}`); }
    }
    return u.next;
  }
  private unresolvedClear(key: string): void {
    const s = this.d.load();
    const u = s.unresolved?.[key];
    if (!u) return;
    delete s.unresolved![key];
    if (!Object.keys(s.unresolved!).length) delete s.unresolved;
    this.d.save(s);
    this.log(`landing for tap key ${tapKid(key)} resolved against the remote main after ${u.fails} failed look(s)`);
  }
  private unresolvedDue(key: string): boolean {
    const u = this.d.load().unresolved?.[key];
    return !u || u.next <= this.d.now();
  }

  // A keeper outage (its status unpushed or reset for over OUTAGE_NOTICE_MS, or OUTAGE_ROUNDS
  // rounds): one notice to Dane, through the link's own notice path, with the push error in
  // plain words; once per outage.
  private async outageNotice(): Promise<void> {
    const st = keeperStatus(this.files().status);
    const o = st?.outage;
    if (!st || !o || (!st.unpushed && !st.reset)) return;
    const since = Date.parse(o.since);
    if (!Number.isFinite(since)) return;
    const s = this.d.load();
    if (s.outageTold === o.since) return;
    if (this.d.now() - since <= OUTAGE_NOTICE_MS && o.rounds < OUTAGE_ROUNDS) return;
    const tz = this.d.tz ?? "America/New_York";
    const when = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(since);
    const why = plainPush(st.push_failed?.why, !!st.reset);
    // How long Ship taps have been held: a Ship tap waits on any unsaved change, from the first
    // failed push of this run (or the outage's start).
    const heldSince = Date.parse(st.push_failed?.since ?? o.since);
    const held = spanWords(this.d.now() - (Number.isFinite(heldSince) ? Math.min(heldSince, since) : since));
    try {
      await this.notice(`Cain's record hasn't saved to GitHub since ${when}: ${why}. Ship taps are held until it saves, for ${held} so far. Nothing is lost: the box keeps its copy and keeps trying.`);
    } catch (e) { this.log(`couldn't tell him the record isn't saving: ${String(e).slice(0, 80)}`); return; }
    const s2 = this.d.load();
    s2.outageTold = o.since;
    this.d.save(s2);
    this.log(`told him the record hasn't saved since ${o.since} (${why})`);
  }

  // The clock and the last tap's read time, for the device smoke test (keeper.sh clock).
  clockReport(): Record<string, unknown> {
    const st = keeperStatus(this.files().status);
    let local: Verdict | null = null;
    try { local = this.d.localClock?.() ?? null; } catch { local = null; }
    return {
      keeper: st === undefined ? "no status yet" : st === null ? "status unreadable" : {
        clock: st.clock ?? null, generation: st.generation ?? 0, unpushed: st.unpushed === true,
        push_failed: st.push_failed ?? null, reset: st.reset ?? null, last_reset: st.last_reset ?? null, outage: st.outage ?? null, at: st.at ?? null,
        recheck_pending: st.recheck_pending ?? 0, ship_taps_held: st.unpushed === true || !!st.reset },
      box: local ? { synced: local.synced, source: local.source, diagnostic: local.diagnostic } : null,
      tap_synced: this.clockOk(st ?? undefined),
      tap_read_ms: this.tapRead?.ms ?? null, tap_read_limit_ms: this.readLimit(),
      recheck_pending: st?.recheck_pending ?? 0, link_state_unreadable: this.stateUnreadable,
      tap_read_at: this.tapRead ? new Date(this.tapRead.at).toISOString() : null,
      posted_gen: this.d.load().postedGen ?? 0,
      uncertain_taps: (this.d.load().uncertain ?? []).length,
      link_run: this.d.load().run ?? 0,
      // Round 12: whether his Ship taps land yet (keeper.sh install-taps on, after the post-install tests).
      install_taps: installState(this.d.installLog).how,
      install_taps_why: installState(this.d.installLog).why,
      expired_landings: Object.entries(this.d.load().expiredLandings ?? {}).map(([kid, x]) => ({ tap_key: kid, since: new Date(x.since).toISOString(), expired: new Date(x.at).toISOString() })),
      consumed_unverified: (st as any)?.consumed_unverified ?? null,
      consumed_verified: this.consumedVerified(),
      // Round 17: the keeper saw a new link run that no fresh fetch has verified for yet (the remote away).
      verify_pending: (keeperStatus(this.files().status) as any)?.verify_pending ?? null,
      // Landings the remote can't settle yet (round 9): each key with its age and last error.
      unresolved_landings: Object.entries(this.d.load().unresolved ?? {}).map(([k, u]) => ({ tap_key: tapKid(k), what: u.what,
        since: new Date(u.since).toISOString(), age_min: Math.round((this.d.now() - u.since) / 60_000), failures: u.fails, last_error: u.last,
        next_try: new Date(u.next).toISOString(), told: u.told === true,
        // Round 11: the exact message he sends to settle it, and the docs section that says how to check.
        settle: [settleForm(tapKid(k), "landed"), settleForm(tapKid(k), "not-landed")], how: "DOCS.md, Reconciling a landing by hand",
        reminded: u.reminded ? new Date(u.reminded).toISOString() : null, alerted: !!u.alerted })),
      // Round 11: keys unresolved past 90 days, kept as tombstones (they no longer block a new card).
      tombstoned_landings: Object.entries(this.d.load().tombstones ?? {}).map(([k, u]) => ({ tap_key: tapKid(k), tombstone: true,
        since: new Date(u.since).toISOString(), tombstoned: new Date(u.tomb).toISOString(), failures: u.fails, last_error: u.last })),
      // Round 11: the landing ledger's reconciliation, one row per head.
      landings_by_head: (this.d.landings?.reconcile?.() ?? []).map((h) => ({ pr: h.pr, head: h.head, landed: h.landed ? tapKid(h.landed) : null,
        keys: h.keys.map(tapKid), forced: h.forced.map(tapKid), open: h.open.map(tapKid) })),
      pi_clock: this.piClock(),
      recheck_queue: Object.entries(this.d.load().recheck ?? {}).map(([item, r]) => ({ item, why: r.why, since: new Date(r.at).toISOString() })),
    };
  }

  // The accepted source check an ask or Ship card for the item rests on now, or null: the
  // keeper's own fresh check, from its ledger alone, of the row as it stands, with the ledger's
  // generation.
  private freshRef(item: string): Ref | null {
    const id = item.toUpperCase();
    const f = this.files();
    const e = ledgerOf(f.checks)[id];
    if (!e || !isFresh(e, this.d.now(), this.maxDays()) || !inStep(e, f.pending, id)) return null;
    const st = keeperStatus(f.status);
    return { row: e.id, version: e.version, ...(e.checked_req ? { req: e.checked_req } : {}), ...(e.checked_sf ? { sf: e.checked_sf } : {}), gen: generationOf(f.checks), epoch: st?.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0 };
  }

  // A check passed now goes to the record keeper, and the link waits for its outcome: only a
  // check the keeper accepted, as the row's current version, lets the card go. Rejected,
  // failed, or no answer within CHECK_WAIT_MS: nothing is posted, and Cain hears why in one
  // line. A check still pending when the wait ends may land later; a later ask then finds it
  // in the ledger (a retry), but it never posts this card.
  private async acceptedCheck(item: string, c: { text: string; row: string | null; version: number } | null, replyTo?: string): Promise<Ref | null> {
    if (c === null || item === "none") return null;
    const id = item.toUpperCase();
    const req = `link-check-${id.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}-${this.d.now()}`;
    // Round 18: the check is anchored to a Discord stamp, from which a tap's freshness is measured.
    const sf = await this.checkAnchor(replyTo);
    if (sf === null) throw new Refusal("Nothing was posted: Discord gave the link no time to date your source check by (it couldn't read his DM); try again in a minute.");
    try {
      if (!this.d.submitRecord) throw new Error("the record keeper can't be reached from the link");
      this.d.submitRecord({ id: req, from: "cain", kind: "change",
        summary: clip(`Source check on ${id} before asking him: ${c.text}`, 200),
        ops: [{ op: "check", item: id, text: c.text, row: c.row, version: c.version, sf }] });
    } catch (e) {
      throw new Refusal(`Nothing was posted: the source check couldn't be handed to the record keeper (${String(e).slice(0, 80)}); try again in a minute.`);
    }
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    const until = this.d.now() + CHECK_WAIT_MS;
    let o = this.d.outcome?.(req) ?? null;
    while (!o && this.d.now() < until) { await sleep(CHECK_POLL_MS); o = this.d.outcome?.(req) ?? null; }
    if (!o) {
      const waited = CHECK_WAIT_MS;
      this.log(`source check ${req}: no answer from the record keeper within ${waited} ms; nothing posted`);
      try { this.d.waitTimeout?.({ id: req, at: new Date(this.d.now()).toISOString(), waited_ms: waited }); } catch { /* logged above */ }
      this.refuse("wait", id, `Nothing was posted: the record keeper didn't accept your source check within ${CHECK_WAIT_MS / 1000} seconds (its local round is slow; the push to GitHub doesn't count). Ask again in a minute; if it has landed by then, no new --checked is needed.`);
    }
    if (o.state !== "done")
      this.refuse("keeper", id, `Nothing was posted: the record keeper said ${o.state} to your source check${o.reason ? ` (${clip(o.reason, 300)})` : ""}. Check it at its source again and ask with a new --checked.`);
    const e = this.ledger()[id];
    if (e && e.checked_req === req && e.checked_version === e.version && !e.pending_rewrite && !e.stepped_back && !isFresh(e, this.d.now(), this.maxDays()))
      this.refuse("expired", id, `Nothing was posted: the record keeper took your source check, but it is already past source_check_max_days (${this.maxDays()} day${this.maxDays() === 1 ? "" : "s"}), so it doesn't count.`);
    if (!e || e.checked_req !== req || !isFresh(e, this.d.now(), this.maxDays()))
      throw new StaleCheck("Nothing was posted: the record keeper took your source check, but the row changed right after it; check it at its source again and ask with a new --checked if it still needs him.");
    this.clearRecheck(id);
    return { row: e.id, version: e.version, req, ...(e.checked_sf ? { sf: e.checked_sf } : {}) };
  }

  // A one-off ask (--item none) can't stand in for an item's ask: one whose text holds an
  // open row's item code or its whole Item phrase is refused, quoting what matched. One whose
  // words overlap an open row's Item more loosely is held (nothing posted) until Cain either
  // asks it under that item with a check, or sends it again with a one-line reason it is about
  // no open item (--reason), which the keeper logs with it. Every one-off goes into the request
  // log, with its declaration that it is about no open item. Returns the hold, or null to post.
  private oneOff(text: string, reason: unknown): AskResult | null {
    const pending = this.files().pending;
    const hit = oneOffHit(pending, text);
    if (hit) this.refuse("one-off", hit[0], `This one-off names an open item, ${hit[0]} ("${clip(hit[1], 60)}"), matching "${clip(hit[2], 60)}": ask it with --item ${hit[0]} and a --checked source check, or reword it if it's about something else.`);
    const why = reason === undefined || reason === null ? "" : String(reason).replace(/\s+/g, " ").trim();
    if (why.length > MAX_ONE_OFF_REASON) this.refuse("one-off", "none", `The one-off's --reason is over ${MAX_ONE_OFF_REASON} characters; say why in one short line.`);
    const loose = oneOffLoose(pending, text);
    if (loose.length && !why) {
      const h = loose[0];
      const said = `Held, not posted: this one-off's words overlap an open item, ${h.id} ("${clip(h.item, 60)}"), sharing ${h.shared.map((w) => `"${w}"`).join(", ")}. Either ask it with --item ${h.id} and a --checked source check, or send it again with --reason "<one line on why it is about no open item>", which the record keeper logs.`;
      try { this.d.tune?.({ at: new Date(this.d.now()).toISOString(), kind: "one-off hold", item: h.id, said }); } catch { /* the hold stands */ }
      return { status: "needs reason", said };
    }
    const now = this.d.now(), flat = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
    try {
      if (!this.d.submitRecord) throw new Error("the record keeper can't be reached from the link");
      this.d.submitRecord({ id: `link-oneoff-${now}`, from: "cain", kind: "change", summary: clip(`${ONE_OFF_SUMMARY}${flat}`, 200),
        ops: [{ op: "one-off", text: clip(flat, 300), not_about_item: true, ...(loose.length ? { reason: why.replace(/\|/g, "/") } : {}) }] });
    } catch (e) {
      throw new Refusal(`Nothing was posted: the one-off ask's log line couldn't be handed to the record keeper (${String(e).slice(0, 80)}); try again in a minute.`);
    }
    return null;
  }

  // Right before an ask or Ship card for an item goes up: the row's version is read again,
  // and the card rests on the accepted check that counts now.
  private refNow(item: string): Ref | null {
    if (item === "none") return null;
    const fresh = this.freshRef(item);
    if (fresh) return fresh;
    throw new StaleCheck("its row changed after your source check (or the check no longer counts); check it at its source again, and ask again with --checked if it still needs him.");
  }

  // Live cards with the same key as this one: the newest keeps its buttons and the others
  // are replaced, so a card filed under its key after it went up (one that went out by
  // itself) never outlives a newer one. With `only`, just cards of that kind take part
  // and held asks are left alone. Returns the ids replaced. A card with no buttons
  // replaces nothing: it asks nothing.
  private markReplaced(s: State, newId: string, only?: Kind): string[] {
    const fresh = s.messages[newId];
    const key = fresh?.buttons && !fresh.outcome ? keyFor(fresh) : null;
    if (!key) return [];
    const same = Object.entries(s.messages).filter(([id, m]) => id === newId
      || (m.buttons && !m.outcome && keyFor(m) === key && (!only || m.kind === only)));
    let keep = newId;
    for (const [id, m] of same) if (isNewer(m, id, s.messages[keep], keep)) keep = id;
    const out: string[] = [];
    for (const [id, m] of same) {
      if (id === keep) continue;
      m.outcome = "replaced"; m.why = "replaced";
      out.push(id);
    }
    if (!only && (fresh.kind === "ask" || fresh.kind === "card")) s.held = (s.held ?? []).filter((h) => keyOf(h.item, h.question) !== key);
    return out;
  }

  // -- cards from specialists -------------------------------------------------
  async addCard(c: { text: string; rows?: any[]; kind?: string; expires?: unknown }): Promise<number> {
    const kind = String(c.kind ?? "reply");
    const comps = (c.rows ?? []).filter((r: any) => (r.components ?? []).every((b: any) =>
      String(b.custom_id ?? "").startsWith("k:")));                  // a specialist can't make Cain's buttons
    // The specialist's words: em dashes and "add-on" fixed, and stored that way, so the card
    // posted is exactly the card kept. Never refused: its outbox takes a refusal as dead,
    // and an approval or an Undo would be lost to him. What else the gate flags, Cain hears.
    const w = this.words("card", "specialist", String(c.text ?? ""), { rules: AT.card, buttons: labelsOf(comps), known: this.liveLabels() });
    this.report("card", "specialist", w.hits, w.refused.length ? "posted as it is" : "fixed");
    // The specialist's Stop and Turn back on notices also say what that did on Cain's
    // side, from what's true now: the link's own words.
    const line = kind === "stopped" || kind === "resumed" ? this.ownWords("card", "link", this.stopLine(kind)) : "";
    const text = line ? `${w.text.trimEnd()}\n\n${line}` : w.text;
    const s = this.d.load();
    const id = s.next++;
    const now = this.d.now();
    // A card with buttons goes out by itself if Cain hasn't shown it in time (showDue).
    const due = comps.length && !DIRECT_KINDS.has(kind) ? now + SHOW_WAIT_MS : null;
    const expires = toMs(c.expires);
    if (expires === null && c.expires != null && c.expires !== "")
      this.log(`card ${id}: its expiry isn't a time (${String(c.expires).slice(0, 40)}), so it has none`);
    s.cards[String(id)] = { text, rows: comps, kind, created: now, shown: null, expires, due };
    for (const [k, v] of Object.entries(s.cards)) if (v.created + REMEMBER_MS <= now) delete s.cards[k];
    this.d.save(s);
    const flagged = w.refused.length ? flaggedLine(w.refused) : "";
    if (DIRECT_KINDS.has(kind)) {
      const shown = await this.show(id, { item: "none" });
      if (shown && (kind === "stopped" || kind === "resumed")) await this.retireToggles(shown);
      // A Turn back on notice with a Stop of its own: a moving Stop placed meanwhile comes off.
      if (shown && kind === "resumed") void this.inStopQueue(() => this.placeStop());
      if (flagged) this.d.relay(`The calendar specialist's notice (card ${id}) went out to him with words the message gate flags: ${flagged}. Nothing to do unless it matters to him; then set it right in one line of your own.`);
    } else {
      const ask = due !== null ? "It has buttons: show it now, or it goes out by itself in about 2 minutes."
        : "Show it now if it matters today, or fold it into the morning message.";
      const flag = flagged ? ` The message gate flags its words: ${flagged}. It goes out as it is; if it matters, set it right in one line of your own after it.` : "";
      this.d.relay(`The calendar specialist has a card for Dane (card ${id}): "${excerpt(text, 120)}". ${buttonsLine(labelsOf(comps))}${flag} ${ask} Run /opt/cain/keeper.sh show ${id} --item <its PENDING id, or none> (add --reply-to <his message id> when it answers a message of his). The item is only its label: the card goes out whoever holds the item, open or closed.`);
    }
    return id;
  }

  async show(id: number, m: { item?: unknown; question?: unknown; replyTo?: unknown }): Promise<string> {
    return (await this.showCard(id, m)).message ?? "";
  }

  // Cain's show (POST /show). "posted": this show put it in front of him. "already out":
  // it was up before (it went out by itself, or he showed it already); then nothing more
  // is posted, and one that went out by itself is filed under his item and question.
  // "expired": its own expiry passed before it reached him, and nothing is posted.
  async showCard(id: number, m: { item?: unknown; question?: unknown; replyTo?: unknown }):
      Promise<{ status: "posted" | "already out" | "expired"; message: string | null; said?: string; buttons?: string[] }> {
    const meta = checkMeta(m);
    let put: Put;
    this.cainWaits.add(id);
    try { put = await this.putUp(id, meta); }
    catch (e) {
      if (e instanceof Refusal) return this.lapsedAnswer(id);
      throw e;
    } finally { this.cainWaits.delete(id); }
    if (put.first) return { status: "posted", message: put.message, buttons: this.upNow(put.message) };
    const f = await this.fileUnder(put.message, meta);
    const under = about(meta.item, meta.question) ? ` under ${about(meta.item, meta.question)}` : "";
    const done = "Nothing more was posted. Write no lead-in for it.";
    return { status: "already out", message: put.message, buttons: this.upNow(put.message), said: !f.filed ? "It's already in front of him; nothing more was posted."
      : f.gaveWay ? `It had gone out by itself; this filed it${under}, and as a newer card for the same question is up, its buttons came off. ${done}`
      : f.replaced ? `It had gone out by itself; this filed it${under} and took the buttons off ${f.replaced === 1 ? "an older card" : `${f.replaced} older cards`} for the same question. ${done}`
      : `It had gone out by itself; this only filed it${under}. ${done}` };
  }

  // The labels on a message's buttons while they're up, as far as the link knows ([] once off).
  private upNow(messageId: string): string[] {
    const m = this.d.load().messages[messageId];
    return m?.buttons ? [...(m.labels ?? [])] : [];
  }

  // Cain hears once that a card lapsed before it reached him, whether his show or the
  // sweep found it.
  private lapsedAnswer(id: number): { status: "expired"; message: null; said: string } {
    const s = this.d.load();
    const c = s.cards[String(id)];
    if (c?.lapseTold) return { status: "expired", message: null, said: `You were already told card ${id} expired before it reached him; nothing was posted.` };
    if (c) { c.lapseTold = true; this.d.save(s); }
    return { status: "expired", message: null, said: lapsedLine(id, c) };
  }

  // One put-up per card at a time: a second caller (Cain's show while the sweep posts it,
  // or the other way round) waits for the first and gets the same message, so it's one
  // Discord message by the link's own doing. The card's nonce stays as a second guard.
  private putUp(id: number, meta: Meta, byItself = false): Promise<Put> {
    const going = this.going.get(id);
    if (going) return going.then((p) => ({ message: p.message, first: false }));
    const run = this.postSpecialist(id, meta, byItself).finally(() => this.going.delete(id));
    this.going.set(id, run);
    return run;
  }

  // Puts a specialist's card in front of him and records it, for Cain's show and for the
  // sweep when Cain hasn't shown it in time. No hold and no closed item stops it
  // (boundItem): it's the specialist talking to him. A card already up is never posted
  // again; one whose own expiry has passed never goes out at all.
  private async postSpecialist(id: number, meta: Meta, byItself: boolean): Promise<Put> {
    const before = this.d.load().cards[String(id)];
    if (!before) throw new Error(`no card ${id}`);
    if (before.shown) return { message: before.shown, first: false };
    // A post whose answer never came may be on Discord already, from longer ago than
    // Discord's nonce remembers: look in his DM first, expired or not, and post nothing
    // while it can't be read.
    const mark = before.posting;
    let found: any = null;
    if (mark) {
      try { found = await this.findPosted(before); }
      catch (e) { throw new Unsure(reason(e)); }
    }
    let msg = found;
    if (!msg) {
      const s = this.d.load();
      const card = s.cards[String(id)];
      if (!card) throw new Error(`no card ${id}`);
      if (card.shown) return { message: card.shown, first: false };
      if (card.outcome === "expired" || (card.expires != null && card.expires <= this.d.now())) {
        if (!card.outcome) { card.outcome = "expired"; this.d.save(s); }
        throw new Refusal(`card ${id} expired before it reached him; nothing was posted`);
      }
      if (!card.posting) {
        card.posting = { at: this.d.now(), rows: digest("", card.rows), byItself, item: meta.item, question: meta.question };
        this.d.save(s);
      }
      msg = await this.postCard(card.text, card.rows, { replyTo: meta.replyTo, nonce: stableNonce("card", String(id)) });
    }
    // The specialist changed its buttons while it was on its way: the message follows.
    const rows = this.d.load().cards[String(id)]?.rows;
    if (rows && digest("", rows) !== digest("", msg.components)) {
      try {
        const { dm } = await this.identity();
        msg = (await this.rest("PATCH", `/channels/${dm}/messages/${msg.id}`, { components: rows, allowed_mentions: { parse: [] } })) ?? msg;
      } catch (e) { this.log(`couldn't bring card ${id}'s buttons up to date: ${reason(e)}`); }
    }
    const s2 = this.d.load();
    const latest = s2.cards[String(id)];
    if (latest?.shown) return { message: latest.shown, first: false };
    if (latest) { latest.shown = String(msg.id); delete latest.posting; }
    // Who made the message: a post found in his DM was made by whoever began it. The sweep
    // finding Cain's own lost show keeps his item and question.
    const fromLink = found ? !!mark?.byItself : byItself;
    const label = byItself && found && mark && !mark.byItself ? mark : meta;
    this.remember(s2, msg, { card: id, kind: "card", item: label.item, question: label.question,
      posted: found ? snowflakeTime(String(msg.id)) : this.d.now(), expires: latest?.expires ?? before.expires ?? null,
      buttons: (msg.components ?? []).length > 0, labels: labelsOf(msg.components),
      ...(byItself && fromLink ? { byItself: true } : {}) });
    const replaced = this.markReplaced(s2, String(msg.id));
    this.d.save(s2);
    await this.stripAll(replaced);
    return { message: String(msg.id), first: true, fromLink };
  }

  // The bot's message in his DM that is this card, from its post whose answer never came:
  // one the link doesn't know yet, posted since that post began (with a minute for the
  // clocks), paging back until past that time. When the card's buttons have changed
  // since, its words alone are enough. Throws when his DM can't be read, or goes back
  // further than the link looks.
  private async findPosted(card: Card): Promise<any> {
    const mark = card.posting!;
    const { dm, bot } = await this.identity();
    const known = this.d.load().messages;
    const words = fit(card.text).trim();
    const exact = digest(words, card.rows);
    const wordsAlone = digest("", card.rows) !== mark.rows;
    const from = mark.at - 60_000;
    let before = "";
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const batch = await this.rest("GET", `/channels/${dm}/messages?limit=100${before ? `&before=${before}` : ""}`);
      if (!Array.isArray(batch) || !batch.length) return null;
      for (const m of batch) {
        const id = String(m?.id ?? "");
        if (String(m?.author?.id ?? "") !== bot || known[id] || snowflakeTime(id) < from) continue;
        const text = String(m.content ?? "").trim();
        if (digest(text, m.components) === exact || (wordsAlone && text === words)) return m;
      }
      before = String(batch[batch.length - 1].id);
      if (batch.length < 100 || snowflakeTime(before) < from) return null;
    }
    throw new Error("his DM goes back further than the link looks");
  }

  // Cain showed a card that had already gone out by itself: it takes his item and
  // question, so his replies to it find what it's about, and a newer card from the
  // specialist for the same question replaces it. It only weighs against the
  // specialist's other cards: it never takes the buttons off one of Cain's own asks or
  // Ship cards, never gives way to one, and leaves his held asks alone.
  private async fileUnder(messageId: string, meta: Meta): Promise<{ filed: boolean; gaveWay: boolean; replaced: number }> {
    const s = this.d.load();
    const m = s.messages[messageId];
    if (!m?.byItself) return { filed: false, gaveWay: false, replaced: 0 };
    m.item = meta.item; m.question = meta.question;
    delete m.byItself;
    const out = this.markReplaced(s, messageId, "card");
    this.d.save(s);
    await this.stripAll(out);
    return { filed: true, gaveWay: out.includes(messageId), replaced: out.filter((x) => x !== messageId).length };
  }

  async editButtons(id: number, comps: any[]): Promise<void> {
    const s = this.d.load();
    const card = s.cards[String(id)];
    if (!card) return;
    const rec = card.shown ? s.messages[card.shown] : undefined;
    if (rec?.outcome && comps.length) { this.log(`card ${id} is ${rec.outcome}; its buttons stay off`); return; }
    if (!card.shown) {
      // Not up yet: its 2 minutes run from when it has buttons, and without them it waits
      // for Cain like any card without buttons.
      // A card from before 0.7.2 (no due time at all) never gets one.
      card.rows = comps;
      if (!comps.length) { if (card.due !== undefined) card.due = null; }
      else if (card.due === null && !DIRECT_KINDS.has(card.kind)) card.due = this.d.now() + SHOW_WAIT_MS;
      this.d.save(s);
      return;
    }
    const { dm } = await this.identity();
    const msg = await this.rest("PATCH", `/channels/${dm}/messages/${card.shown}`,
      { components: comps, allowed_mentions: { parse: [] } });
    const s2 = this.d.load();
    if (s2.cards[String(id)]) s2.cards[String(id)].rows = comps;
    // Its labels follow the edit; a card whose buttons all came off keeps the last ones.
    if (msg?.id) this.remember(s2, msg, { card: id, buttons: comps.length > 0,
      ...(comps.length ? { labels: labelsOf(comps) } : { off: this.d.now() }) });
    this.d.save(s2);
  }

  cardOf(messageId: string): number | null {
    return this.d.load().messages[messageId]?.card ?? null;
  }

  // Which card a message is, what it's about, and the buttons it has up now (GET /card-of).
  cardInfo(messageId: string): { card: number | null; item: string | null; question: string | null; buttons: string[]; live: boolean | null } {
    const m = this.d.load().messages[messageId];
    return { card: m?.card ?? null, item: m?.item ?? null, question: m?.question || null,
      buttons: m?.buttons ? [...(m.labels ?? [])] : [], live: m ? live(m, this.d.now()) : null };
  }

  // keeper.sh card (POST /look): a message in his DM as Discord has it now, its first 200
  // characters and the buttons on it, with what the link knows of it. Look, don't recall.
  async look(messageId: unknown): Promise<Record<string, unknown>> {
    const id = String(messageId ?? "").trim();
    if (!SNOWFLAKE.test(id)) throw new Refusal("needs a Discord message id");
    const { owner, dm, bot } = await this.identity();
    let msg: any;
    try { msg = await this.rest("GET", `/channels/${dm}/messages/${id}`); }
    catch (e) {
      if (/discord 404/.test(String(e))) throw new Refusal("no message with that id in his DM");
      throw e;
    }
    const author = String(msg?.author?.id ?? "");
    const m = this.d.load().messages[id];
    return { status: "ok", message: id, from: author === bot ? "the bot" : author === owner ? "Dane" : "someone else",
      text: String(msg?.content ?? "").slice(0, 200), buttons: labelsOf(msg?.components), edited: !!msg?.edited_timestamp,
      known: m ? { kind: m.kind ?? "legacy", writer: writerOf(m), item: m.item ?? null, question: m.question || null,
        card: m.card ?? null, live: live(m, this.d.now()), labels: [...(m.labels ?? [])] } : null };
  }

  // -- the mutual watch (watch.ts): a plain notice, straight to his DM ---------------
  // It carries the moving Stop when it's posted (unless things are stopped, or it asks
  // something), and the message that held it before loses it at the next quiet moment. One
  // that may carry Stop goes in the Stop queue, after any move or Stop tap under way, and
  // if he tapped Stop while Discord was posting it, its Stop comes straight off again.
  async notice(text: string, timeoutMs?: number): Promise<string> {
    const words = this.ownWords("notice", "link", text);
    try { this.d.noticeLog?.(words); } catch { /* the notice still goes */ }
    const asking = asksSomething(words);
    return asking ? this.postNotice(words, false, timeoutMs) : this.stopQueued(() => this.postNotice(words, true, timeoutMs));
  }

  private async postNotice(words: string, mayStop: boolean, timeoutMs?: number): Promise<string> {
    const stop = mayStop && !this.stopped().stopped;
    const msg = await this.post(words, stop ? rows([[["Stop", STOP]]]) : [], { timeoutMs });
    const id = String(msg.id);
    let old: string | undefined;
    try {
      const s = this.d.load();
      // Its buttons, said outright: a reply to it naming another is judged against these, never unknown.
      this.remember(s, msg, { kind: "notice", item: "none", question: "notice", posted: this.d.now(), expires: null, buttons: stop,
        labels: stop ? ["Stop"] : [], ...(mayStop ? {} : { asks: true }) });
      if (stop) { old = s.stopAt; this.takeStop(s, id); }
      this.d.save(s);
    } catch (e) { this.log(`couldn't record a notice: ${String(e).slice(0, 80)}`); }
    if (stop && this.stopped().stopped) {
      await this.unhold(id, MOVED);
      if (old && old !== id) await this.strip(old);
    }
    return id;
  }

  // -- Claude's Home Assistant connector needs signing in again (keeper.sh connector) --
  // One notice per item while it lasts (CONNECTOR_ONCE_MS), with one link button: Claude's
  // connector settings, the fix one tap away. It asks nothing back: Cain checks Home
  // Assistant again by himself and goes ahead once it answers.
  async connector(a: { item?: unknown; text?: unknown }): Promise<{ status: "posted" | "already told"; message: string; said: string }> {
    const meta = checkMeta({ item: a.item });
    const waits = String(a.text ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
    if (!waits) throw new Refusal('say what waits, in a few words, like "Installing Harness 0.21.4"');
    if (waits.length > 120) throw new Refusal("say only what waits, in a few words");
    noMachineText(waits);
    const now = this.d.now();
    const prior = Object.entries(this.d.load().messages).find(([, m]) => m.kind === "notice" && m.question === "connector"
      && (m.item ?? "none") === meta.item && (m.posted ?? 0) > now - CONNECTOR_ONCE_MS);
    if (prior) return { status: "already told", message: prior[0],
      said: "He already has the notice about Home Assistant's connector; nothing more was posted. Check Home Assistant again at each cloud job check, and go ahead once it answers." };
    const w = this.cainWords("connector", "notice", waits, { rules: AT.cain, buttons: [CONNECTOR_LABEL], known: this.liveLabels() }, { reviewed: true });
    const text = `${w.text} waits until Claude can reach Home Assistant again: its connector needs you to sign in again. `
      + "Open Claude's connector settings and reconnect Home Assistant there. It goes ahead by itself once Home Assistant answers.";
    const comps = [{ type: 1, components: [{ type: 2, style: 5, label: CONNECTOR_LABEL, url: CONNECTOR_URL }] }];
    const msg = await this.post(text, comps, { nonce: stableNonce("connector", meta.item, w.text) });
    const s = this.d.load();
    this.remember(s, msg, { kind: "notice", item: meta.item, question: "connector", posted: now, expires: null, buttons: false,
      labels: [CONNECTOR_LABEL] });
    this.d.save(s);
    return { status: "posted", message: String(msg.id),
      said: `Posted.${w.fixed.length ? ` ${fixedSaid(w.fixed)}` : ""} Write /data/jobs/connector-<item> as the Cloud jobs section says, and check Home Assistant again at each cloud job check.` };
  }

  // -- Cain's own words with buttons ----------------------------------------------
  private openAsk(s: State, now: number): [string, Shown] | null {
    for (const [id, m] of Object.entries(s.messages)) if (m.kind === "ask" && live(m, now)) return [id, m];
    return null;
  }

  async ask(a: { text: string; options: string[]; item?: unknown; question?: unknown; replyTo?: unknown; checked?: unknown; reason?: unknown }): Promise<AskResult> {
    const meta = checkMeta(a);
    const raw = (a.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 5);
    const asked = unlabeled(String(a.text ?? ""), meta.item, meta.question).trim();
    if (!asked) throw new Refusal("an ask needs its question");
    if (!raw.length) throw new Refusal("an ask needs at least one option; open questions go through the reply tool");
    noMachineText(asked, ...raw);
    // The gate, before the nonce is made: the same words always make the same card.
    const opts = raw.map((o) => this.cainWords("ask option", "ask's option", o, { rules: ["dash", "app", "count", "machine"] }, { reviewed: true }));
    const w = this.cainWords("ask", "ask", asked, { rules: AT.cain, buttons: opts.map((o) => o.text), known: this.liveLabels() }, { reviewed: true });
    const options = opts.map((o) => o.text);
    const fixed = fixedSaid([...w.fixed, ...opts.flatMap((o) => o.fixed)]);
    const text = w.text;                 // no "P08 Q2: ": the item and question are data
    this.mayAsk(meta.item);
    this.notReset();
    if (meta.item === "none") { const hold = this.oneOff(text, a.reason); if (hold) return hold; }
    await this.acceptedCheck(meta.item, this.sourceCheck(meta.item, a.checked), meta.replyTo);
    this.refNow(meta.item);
    return this.serial(async () => {
      const now = this.d.now();
      const s = this.d.load();
      const key = keyOf(meta.item, meta.question);
      const entry: Ask = { text, options, item: meta.item, question: meta.question, replyTo: meta.replyTo,
        at: now, expires: this.askExpiry(now),
        nonce: stableNonce("ask", meta.item, meta.question, text, options.join("\u0001"), meta.replyTo ?? "") };
      const open = this.openAsk(s, now);
      if (open && !(key && keyFor(open[1]) === key)) {
        const held = s.held ?? (s.held = []);
        const same = key ? held.findIndex((h) => keyOf(h.item, h.question) === key) : -1;
        if (same >= 0) held[same] = entry; else held.push(entry);
        this.d.save(s);
        const which = about(open[1].item, open[1].question) || `"${excerpt(open[1].q?.q ?? "", 60)}"`;
        return { status: "held", said: `Not asked yet: your question ${which} is still open. This one goes out by itself when that one is answered or expires, and you'll be told when it does.${fixed ? ` ${fixed}` : ""}` };
      }
      return { status: "posted", message: await this.postAsk(entry), ...(fixed ? { said: `Posted. ${fixed}` } : {}) };
    });
  }

  // A held ask under today's rules: refused (a Refusal) when its question or an option fails.
  // published: the review service's lines, read once by the caller for the whole check.
  private recheckHeld(e: Ask, published: Reviewed[] | null): void {
    const options = e.options.map((o) => this.cainWords("ask option", "ask's option", o, { rules: ["dash", "app", "count", "machine"] }, { reviewed: true, published }).text);
    this.cainWords("ask", "ask", unlabeled(e.text, e.item, e.question), { rules: AT.cain, buttons: options, known: this.liveLabels() }, { reviewed: true, published });
  }

  // The generation of a card about to go up, written durably to the link's state before the post,
  // so the keeper's floor (it reads this file) covers it even if the post's record is never saved.
  private intend(ref: Ref | null): void {
    const g = ref?.gen;
    if (typeof g !== "number") return;
    const s = this.d.load();
    if (g > this.highWater) this.highWater = g;
    if (g <= (s.intendedGen ?? 0)) return;
    s.intendedGen = g;
    this.d.save(s);
  }

  private async postAsk(e: Ask): Promise<string> {
    const checked = this.refNow(e.item);
    const nonce = e.nonce ?? stableNonce("ask", e.item, e.question, e.text, e.options.join("\u0001"), e.replyTo ?? "");
    // Checked when it was asked; one held since before 0.10.0 gets the fixes now, and one held
    // since before 0.11.0 loses the label it was stored with ("P08 Q2: ").
    const text = this.words("ask", "cain", unlabeled(e.text, e.item, e.question), { rules: ["dash", "app"] }).text;
    const options = e.options.map((o) => this.words("ask option", "cain", o, { rules: ["dash", "app"] }).text);
    this.intend(checked);
    const msg = await this.issueCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: e.replyTo, nonce }, { checked: checked ?? undefined, item: e.item, kind: "ask", expires: e.expires }, options, (s, m) => {
        this.remember(s, m, { kind: "ask", item: e.item, question: e.question, posted: this.d.now(), expires: e.expires,
          ...(checked ? { checked } : {}), buttons: true, labels: [...options], q: { q: excerpt(text), options, used: false } });
        return this.markReplaced(s, String(m.id));
      });
    return String(msg.id);
  }

  // A Ship card: Ship / Not now, for one pull request at one head. Doesn't wait its
  // turn; lasts as long as an ask, and goes when the head moves or the pull request
  // is merged or closed. Cain's words say what Dane will notice; the link builds the rest
  // (shipText), from GitHub and from the review he names (review: its id, or none).
  async ship(a: { text: string; item?: unknown; pr?: unknown; head?: unknown; review?: unknown; replyTo?: unknown; checked?: unknown }): Promise<AskResult> {
    const meta = checkMeta({ item: a.item, replyTo: a.replyTo });
    const pr = String(a.pr ?? "").trim();
    const head = String(a.head ?? "").trim().toLowerCase();
    const m = PULL.exec(pr);
    if (!m) throw new Refusal("pr must be the pull request's address: https://github.com/<owner>/<repo>/pull/<number>");
    if (!SHIP_REPOS.has(`${m[1]}/${m[2]}`.toLowerCase())) throw new Refusal("Ship cards are only for pull requests in HyndeSyte/harness");
    if (!SHA.test(head)) throw new Refusal("head must be the pull request's full 40-character head sha");
    const review = a.review === undefined || a.review === null || String(a.review).trim() === "" ? null : String(a.review).trim();
    if (review !== null && !safeId(review)) throw new Refusal("review must be a review's id, as review.sh submit printed it");
    // His words as one line, without a "P64: " in front: a second line of his can't pose as
    // one of the link's, and he can't tell what a record code is.
    const said = unlabeled(String(a.text ?? ""), meta.item).replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!said) throw new Refusal("a Ship card needs its words");
    const stop = this.stopped();
    if (stop.stopped)
      throw new Refusal("Everything is stopped: Dane tapped Stop, so no Ship cards until he taps Turn back on. Only he can; don't ask him to.");
    noMachineText(said);
    this.mayAsk(meta.item);
    this.notReset();
    // A landing for this very pull request and head that isn't settled (GitHub couldn't be read to
    // settle one a restart cut off, or it is still trying): no new card until it is.
    // Round 10: an abandoned key for it (an orphan the remote couldn't settle) is settled against the
    // remote first, now: landed posts the landed outcome and no new card; only a definite did-not-land
    // lets this card go out.
    const pending = Object.entries(this.d.load().messages).find(([, x]) => x.ship?.pr === pr && x.ship?.head === head && x.shipping?.state === "landing");
    if (pending && pending[1].shipping?.key && this.d.load().unresolved?.[pending[1].shipping.key]?.what === "orphan" && !this.landingNow.has(pending[0])) {
      const [pid, pm] = pending, k = pm.shipping!.key!;
      const s0 = this.d.load();
      if (s0.unresolved?.[k]) { s0.unresolved[k].next = this.d.now(); this.d.save(s0); }
      this.log(`a Ship card for ${pr} at a head whose landing is unresolved: settling tap key ${tapKid(k)} against the remote first`);
      if (this.d.now() - pm.shipping!.at >= LANDING_TRY_MS) await this.lateSettle(pid); else await this.landShip(pid);
      const after = this.d.load().messages[pid]?.shipping;
      if (after?.state === "landed")
        throw new Refusal("Nothing was posted: the earlier Ship tap's landing for this pull request and head has just settled against main as landed (it was there already). You have the landed line for it now; act on that line (it says whether there is a Ship token). No new card is needed.");
    }
    if (Object.values(this.d.load().messages).some((x) => x.ship?.pr === pr && x.ship?.head === head && x.shipping?.state === "landing"))
      throw new Refusal("Nothing was posted: a Ship tap's landing for this pull request and head isn't settled yet (it is still trying, or GitHub couldn't be read to settle one a restart cut off). You'll hear when it settles; show a new card then if one is still needed.");
    const check = this.sourceCheck(meta.item, a.checked);
    const w = this.cainWords("ship", "Ship card", said, { rules: AT.cain, buttons: ["Ship", "Not now"], known: this.liveLabels() },
      { shipWords: true });
    await this.acceptedCheck(meta.item, check, meta.replyTo);
    this.refNow(meta.item);
    // Without GitHub to read (only the tests' rig has none), the card is his words alone.
    const built = this.d.facts ? await this.shipText(pr, head, review, w.text) : { text: w.text, own: undefined };
    const text = built.text;
    const checked = this.refNow(meta.item);
    const nonce = stableNonce("ship", pr, head, text, meta.replyTo ?? "");
    const options = ["Ship", "Not now"];
    this.intend(checked);
    const now = this.d.now(), expires = this.askExpiry(now);
    const msg = await this.issueCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: meta.replyTo, nonce }, { checked: checked ?? undefined, item: meta.item, kind: "ship", expires }, options, (s, mm) => {
        this.remember(s, mm, { kind: "ship", item: meta.item, question: `ship:${m[3]}`, posted: now, expires,
          ship: { pr, head }, ...(checked ? { checked } : {}), ...(built.own !== undefined ? { own: built.own } : {}), buttons: true, labels: [...options],
          q: { q: excerpt(text), options, used: false } });
        return this.markReplaced(s, String(mm.id));
      });
    return { status: "posted", message: String(msg.id), ...(w.fixed.length ? { said: `Posted. ${fixedSaid(w.fixed)}` } : {}) };
  }

  // The Ship card's words, built by the link (0.11.0):
  //   Ship Cain 0.11.0?
  //   <Cain's line: what Dane will notice>
  //   From GitHub: "<title>", 4 commits and 12 files, including Cain's link. Checks passed.
  //   Reviewed: OpenAI, approve with changes; Gemini, approve.
  // The review service's lines are read first (they're on the Pi): the review he names must be
  // done, and of this very head (and pull request, when it says one), never just finished at
  // some time. Then GitHub is asked for the pull request and the head's check runs at once,
  // within FACTS_MS, and a part that doesn't come says so. Refused: no line for that review, a
  // review of another head or none named in it, its lines unreadable, a newer head on GitHub, a
  // commit GitHub doesn't have, a check that failed or hasn't run. A pull request merged at
  // this head is in main already: the landing asks nothing of its checks, so neither does the
  // card. Anything else going wrong while the new lines are built gives the card as it was
  // before: "Ship it?", his line and the line from GitHub as it was. Never no card.
  private async shipText(pr: string, head: string, review: string | null, words: string): Promise<{ text: string; own: string }> {
    const own = words.trim();
    if (!own) throw new Refusal("a Ship card needs a line saying what he'll notice");
    let rev: Reviewed | null = null;
    if (review !== null) {
      const list = this.published();
      if (!list) throw new Refusal("reviews can't be read right now: try again in a minute, or leave --review out");
      rev = list.find((x) => x.id === review && x.line) ?? null;
      if (!rev) throw new Refusal(`review ${review} isn't finished, or has no answers: show the card once it's done, or leave --review out`);
      if (!rev.head) throw new Refusal(`review ${review} wasn't submitted for this pull request's head: submit it with pr and head`);
      if (rev.head !== head || (rev.pr !== null && rev.pr.toLowerCase() !== pr.toLowerCase()))
        throw new Refusal(`review ${review} was of another head or pull request: get a review of this head as it is now`);
    }
    const wait = this.d.factsMs ?? FACTS_MS;
    const ask = <T>(go?: () => Promise<T | null>): Promise<T | null> =>
      (go ? within(Promise.resolve().then(go).catch(() => null), wait) : Promise.resolve(null));
    const { facts, checkRuns } = this.d;
    const [f, runs] = await Promise.all([ask(() => facts!(pr, head)), ask(checkRuns && (() => checkRuns(pr, head)))]);
    if (f?.head && f.head !== head)
      throw new Refusal("GitHub has a newer head for that pull request than the one this card names: show the card for its head as it is now");
    // Merged on GitHub at this head: the landing asks nothing of its checks, only that main has
    // the head (a squash or a rebase would leave it out). So the card asks main too, the way the
    // landing does, and says "Already in main" only when main has it.
    const merged = f?.merged === true && f.head === head;
    const inMain = merged && this.d.landed ? await within(this.remote({ pr, head }).then((r) => r.v), wait) : null;
    if (merged && inMain === false)
      throw new Refusal("GitHub says it's merged, but main doesn't have that head (a squash or a rebase?), so a Ship tap can't install it");
    try {
      if (!merged && runs === "missing") throw new Refusal("GitHub doesn't have that commit: show the card for its head as it is now");
      const checks = !merged && Array.isArray(runs) ? judgeChecks(runs) : null;
      const failed = checks?.find((c) => c.state === "failed");
      if (failed) throw new Refusal(`its ${failed.name} check didn't pass (${failed.conclusion}): fix it through Build first, then show a new Ship card`);
      const notRun = checks?.find((c) => c.state === "missing");
      if (notRun) throw new Refusal(`CI hasn't run ${notRun.name} on it yet: show the card once its checks have run`);
      const said = merged ? (inMain ? IN_MAIN : MERGED_UNREAD)
        : !checks ? CHECKS_UNREAD : checks.some((c) => c.state === "running") ? CHECKS_RUNNING : CHECKS_PASSED;
      const github = this.ownWords("ship facts", "link", f ? githubLine(f, said) : factsLine(null));
      return { text: shipCard(shipQuestion(f), own, [github, rev ? `${rev.line} ${REVIEW_READ}` : NO_REVIEW]), own };
    } catch (e) {
      if (e instanceof Refusal) throw e;
      this.log(`couldn't build a Ship card's new lines, so it goes as it was: ${reason(e)}`);
      let line: string;
      try { line = factsLine(f); } catch { line = factsLine(null); }
      return { text: shipCard("Ship it?", own, [this.ownWords("ship facts", "link", line)]), own };
    }
  }

  // The one morning message, with Stop. Its Stop moves to the newest morning message.
  async morning(text: string): Promise<string> { return (await this.morningPost(text)).message; }

  // The same, with what the gate fixed (POST /morning).
  async morningPost(text: string): Promise<{ message: string; said?: string }> {
    if (!String(text ?? "").trim()) throw new Refusal("the morning message needs its text");
    noMachineText(String(text));
    // While stopped, its button is the one that undoes it.
    const toggle: [string, string] = this.stopped().stopped ? ["Turn back on", RESUME] : ["Stop", STOP];
    const w = this.cainWords("morning", "morning message", String(text), { rules: AT.cain, buttons: [toggle[0]], known: this.liveLabels() }, { reviewed: true });
    const msg = await this.postCard(w.text, rows([[toggle]], "q:"), { nonce: stableNonce("morning", w.text, toggle[1]) });
    const s = this.d.load();
    this.remember(s, msg, { kind: "morning", item: "none", question: "morning", posted: this.d.now(), expires: null, buttons: true,
      labels: [toggle[0]] });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return { message: String(msg.id), ...(w.fixed.length ? { said: `Posted. ${fixedSaid(w.fixed)}` } : {}) };
  }

  // He answered an open ask in words: its buttons come off, and the next one goes out.
  // With --item none, it's the open ask about no item (only one ask is ever open).
  async answered(a: { item?: unknown; question?: unknown }): Promise<{ status: string; said: string }> {
    const meta = checkMeta({ item: a.item, question: a.question });
    const ids = await this.serial(async () => {
      const now = this.d.now();
      const s = this.d.load();
      const out: string[] = [];
      for (const [id, m] of Object.entries(s.messages)) {
        if (m.kind !== "ask" || !live(m, now) || !sameAsk(m, meta)) continue;
        m.outcome = "answered"; m.words = true; m.why = "answered in a message";
        if (m.q) m.q.used = true;
        out.push(id);
      }
      const before = (s.held ?? []).length;
      if (meta.item !== "none") s.held = (s.held ?? []).filter((h) => !sameAsk(h, meta));
      this.d.save(s);
      return { out, dropped: before - (s.held ?? []).length };
    });
    await this.stripAll(ids.out);
    await this.releaseHeld();
    const what = about(meta.item, meta.question) || "about no item";
    if (ids.out.length) return { status: "closed", said: `Your question ${what} is marked answered in a message.` };
    if (ids.dropped) return { status: "closed", said: `Your held question ${what} won't go out: he already answered it.` };
    return { status: "none open", said: `No open question ${what}.` };
  }

  // What a message of his replied to (his plugin doesn't say): the card or message,
  // and its item and question.
  async replied(messageId: unknown): Promise<Record<string, unknown>> {
    const id = String(messageId ?? "").trim();
    if (!SNOWFLAKE.test(id)) throw new Refusal("needs his message's id (message_id in its tag)");
    const { owner, dm } = await this.identity();
    const msg = await this.rest("GET", `/channels/${dm}/messages/${id}`);
    if (String(msg?.author?.id ?? "") !== owner) throw new Refusal("that isn't one of his messages in your DM");
    const ref = msg?.message_reference;
    if (!ref?.message_id || Number(ref.type ?? 0) !== 0) return { status: "ok", reply_to: null, said: "Not a reply to anything: read it on its own." };
    const rid = String(ref.message_id);
    const m = this.d.load().messages[rid];
    const now = this.d.now();
    return { status: "ok", reply_to: rid, card: m?.card ?? null, item: m?.item ?? null, question: m?.question || null,
      asked: m?.q?.q ?? null, open: m ? live(m, now) : null,
      buttons: m?.buttons ? [...(m.labels ?? [])] : [], live: m ? live(m, now) : null };
  }

  // -- taps -------------------------------------------------------------------
  // Who and where: Dane, in his DM, with Cain paired to him.
  private async who(it: any): Promise<string> {
    if (it.guild_id || it.member) return "not in the DM";
    const { owner, dm } = await this.identity();
    if (this.d.paired() && this.d.paired() !== owner) return "Cain is paired with someone other than the bot's owner";
    const user = String(it.user?.id ?? "");
    if (!user || user !== owner) return "not the owner";
    if (String(it.channel_id ?? "") !== dm) return "not the DM";
    return "";
  }

  // Taps already answered with a deferred update (an ask or Ship card about an item, before its
  // fresh read): their answers go to the interaction's webhook instead. A later acknowledgement
  // is already done, and an update edits the tapped card through @original.
  private deferred = new WeakSet<object>();

  private async answer(it: any, kind: number, data?: unknown): Promise<boolean> {
    if (it && typeof it === "object" && this.deferred.has(it)) {
      if (kind === ACK) return true;
      try {
        await this.rest("PATCH", `/webhooks/${String(it.application_id ?? "")}/${it.token}/messages/@original`, data ?? {}, false);
        return true;
      } catch (e) {
        this.log(`couldn't update a tapped card after its deferred answer: ${String(e).slice(0, 80)}`);
        return false;
      }
    }
    try {
      await this.rest("POST", `/interactions/${it.id}/${it.token}/callback`, data ? { type: kind, data } : { type: kind }, false);
      return true;
    } catch (e) {
      this.log(`couldn't answer a tap in time: ${String(e).slice(0, 80)}`);
      return false;
    }
  }

  // A card left waiting by a deferred answer, patched back as it was (its own words and buttons) through
  // the interaction's webhook; when that fails, or Discord answers with another message's id, the card
  // is edited by its channel and message id with the bot's token instead, so its buttons are back.
  private async restoreCard(it: any, msgId: string): Promise<void> {
    const body = { content: String(it.message?.content ?? ""), components: it.message?.components ?? [], allowed_mentions: { parse: [] } };
    let why = "";
    try {
      if (this.failWebhookNext) { this.failWebhookNext = false; throw new Error("forced by the smoke test (keeper.sh fail-webhook)"); }
      const r = await this.rest("PATCH", `/webhooks/${String(it.application_id ?? "")}/${it.token}/messages/@original`, body, false);
      if (r && r.id !== undefined && String(r.id) !== msgId) why = `it patched another message (${String(r.id).slice(0, 24)})`;
    } catch (e) { why = String(e).slice(0, 80); }
    if (!why) return;
    this.log(`the interaction's webhook didn't patch card ${msgId} back (${why}): editing it by channel and message id`);
    try {
      const ch = String(it.channel_id ?? "") || (await this.identity()).dm;
      await this.rest("PATCH", `/channels/${ch}/messages/${msgId}`, body);
    } catch (e) { this.log(`couldn't put card ${msgId}'s buttons back: ${String(e).slice(0, 80)}`); }
  }

  private async ephemeral(it: any, text: string): Promise<void> {
    try {
      await this.rest("POST", `/webhooks/${String(it.application_id ?? "")}/${it.token}`,
        { content: text, flags: EPHEMERAL, allowed_mentions: { parse: [] } }, false);
    } catch (e) { this.log(`couldn't tell him a card was dead: ${String(e).slice(0, 80)}`); }
  }

  // A tap on a message the link doesn't know, while a card's post never heard back: if
  // the tapped message is that card (its words and buttons, or its words alone when its
  // buttons changed since, posted since that post began), it's up after all. It's
  // recorded as that card, and the tap is handled as that card's. No network: a tap is
  // answered within Discord's 3 seconds.
  private adoptTapped(it: any, msgId: string): boolean {
    const s = this.d.load();
    const m = it?.message ?? {};
    if (!SNOWFLAKE.test(msgId) || s.messages[msgId] || (m.author?.id !== undefined && String(m.author.id) !== s.bot)) return false;
    const text = String(m.content ?? "").trim();
    for (const [k, c] of Object.entries(s.cards)) {
      const mark = c.posting;
      if (c.shown || !mark || snowflakeTime(msgId) < mark.at - 60_000) continue;
      const words = fit(c.text).trim();
      if (digest(text, m.components) !== digest(words, c.rows) && !(digest("", c.rows) !== mark.rows && text === words)) continue;
      c.shown = msgId;
      delete c.posting;
      this.remember(s, { id: msgId, content: m.content, components: m.components }, { card: Number(k), kind: "card",
        item: mark.item, question: mark.question, posted: snowflakeTime(msgId), expires: c.expires ?? null,
        buttons: (m.components ?? []).length > 0, labels: labelsOf(m.components), ...(mark.byItself ? { byItself: true } : {}) });
      this.markReplaced(s, msgId);                     // the sweep takes off what it replaced
      this.d.save(s);
      this.log(`a tap showed card ${k} is up after all; recorded`);
      const shown = labelsOf(m.components);
      this.d.relay(mark.byItself ? wentOutLine(Number(k), c, msgId, shown) : foundLine(Number(k), c, msgId, shown));
      return true;
    }
    return false;
  }

  // Why a card that looks live has stopped mattering, or "".
  // Round 17: a tap's expiry is judged by Discord's time for it (tapSf) against its card's expiry as a Discord
  // time, never the Pi's clock, when both are known.
  private async deadReason(m: Shown, now: number, msgId = "", tapSf: number | null = null): Promise<string> {
    if (m.q?.used) return "answered";
    if (m.expires != null && this.tappedAfterExpiry(msgId, m.expires, now, tapSf, m)) return "expired";
    if (m.until - DAY <= now) return "forgetting";
    const item = boundItem(m);
    if (item) {
      const f = this.files();
      if (closedItems(f.pending).has(item.toUpperCase())) return "item closed";
      const holds = parseHolds(f.holds);
      if (holds && heldElsewhere(holds, item)) return "held elsewhere";
      if (m.kind === "ask" || m.kind === "ship") {
        const c = await this.tapState(item, m.checked, m.kind, tapSf);
        if (c === "changed") return "status changed";
        if (c === "epoch") return "record epoch";
        if (c === "ship-unpushed") return "ship unpushed";
        if (c === "unknown" || c === "behind") return "status unreadable";
        if (c === "busy") return "status busy";
        if (c === "clock") return "clock unsynced";
        if (c === "reset") return "record reset";
        if (c === "unpushed") return "record unpushed";
      }
    }
    return "";
  }

  async onInteraction(it: any): Promise<string> {
    if (it?.type !== COMPONENT) return "ignored";
    const cid = String(it.data?.custom_id ?? "");
    if (!cid.startsWith("k:") && !cid.startsWith("q:")) return "ignored";   // Cain's plugin answers "perm:"
    let refusal = "";
    try { refusal = await this.who(it); } catch (e) { refusal = "check failed"; }
    if (refusal) {
      await this.answer(it, ACK);
      this.log(`tap refused: ${refusal}`);
      return `refused: ${refusal}`;
    }
    const msgId = String(it.message?.id ?? "");
    const now = this.d.now();
    // Round 17: Discord's time for the tap, from its interaction id; it also tells the link how far the Pi's
    // clock is from Discord's (for what is posted, never for whether the tap counts).
    const tapSf = /^\d{15,22}$/.test(String(it?.id ?? "")) ? snowflakeTime(String(it.id)) : null;
    this.noteStamp(it?.id);
    const s = this.d.load();
    const rec = s.messages[msgId];
    // A card whose post never heard back may be the one he tapped: then it's up after all.
    if (!rec && this.adoptTapped(it, msgId)) return this.onInteraction(it);
    // Stop only ever makes things safer, so it's his from any card of ours, as it shows
    // now, and it stops whatever else the card says.
    if (cid === STOP) {
      this.setStop(true);
      const out = await this.stopTap(it, cid, msgId);
      await this.cancelLandings();                   // after his tap is answered, within Discord's 3 seconds
      return out;
    }
    // Turn back on undoes his Stop, so it counts only from a card this link posted and
    // still knows as live, showing exactly what was posted. From anything else it does
    // nothing (not even on the calendar specialist's side), and while things are
    // stopped he gets a fresh notice whose button works.
    if (cid === RESUME) {
      const changed = !!rec && !rec.outcome && digest(it.message.content ?? "", it.message.components) !== rec.digest;
      // And only from a message whose labels include it: never one holding the moving Stop.
      const carries = !!rec && !!rec.buttons && (rec.labels ?? []).includes("Turn back on");
      if (!rec || rec.outcome || changed || !carries) {
        let out: string;
        if (changed) { await this.answer(it, ACK); out = "refused: card was changed after it was posted"; }
        else if (rec && !rec.outcome) { await this.answer(it, ACK); out = "refused: that message doesn't carry Turn back on"; }
        else out = await this.deadTap(it, msgId, rec ? (rec.why ?? rec.outcome ?? "done") : "not a card the link knows");
        this.log(`Turn back on refused (${out}); nothing changed`);
        if (this.stopped().stopped) await this.postToggle(`**Still stopped.** That button was on an old or changed card, so nothing changed. ${this.stopLine("stopped")}`.trim(), true);
        return out;
      }
    }
    // Component taps only ever come for the app's own messages, so one the link doesn't
    // know is an old card of ours: take its buttons off.
    if (!rec) {
      // Round 13: a withdrawn card (its record was never saved), and one past its expiry (the compact
      // expired-key index), are told so.
      const logged = cid.startsWith("q:") ? this.logCards().get(msgId) : undefined;
      // Round 14: a card logged but never armed and never saved can't have been tapped through the link:
      // it is withdrawn (its void record written now if a crash or a failed write left none).
      const unsaved = !!logged && !logged.void && !logged.armed && logged.keys.length > 0 && logged.keys.every((k) => typeof k.cid === "string");
      if (logged?.void || unsaved) {
        if (unsaved) { try { appendLog(this.d.issuedLog!, { t: "void", msg: msgId, at: now }); } catch (x) { this.log(`couldn't log card ${msgId} as voided at its tap: ${String(x).slice(0, 80)}`); } }
        const out = await this.deadTap(it, msgId, "withdrawn", CARD_WITHDRAWN);
        this.log(`tap on withdrawn card ${msgId} refused: its record was never saved`);
        return out;
      }
      // Round 14: a key the record keeper already consumed (its consumed-key log): told, nothing again.
      const kid = logged?.keys.find((k) => k.cid === cid)?.kid;
      if (kid && this.consumedKids().has(kid)) {
        const out = await this.deadTap(it, msgId, "consumed", TAP_CONSUMED);
        this.log(`tap on card ${msgId} refused: its tap key ${kid} was already acted on (the keeper's consumed-key log)`);
        return out;
      }
      // Round 14: past the expiry its issued keys carry, whatever the buttons show.
      // Round 18: the expired-key index is a cleanup marker: a tap is refused as expired only when its interaction is
      // stamped after the card's real expiry (the index's own snowflake expiry, else the keys'), never for its
      // membership alone.
      const exp = logged?.keys.find((k) => typeof k.exp === "number")?.exp;
      const indexedExp = this.expiredIndex().get(msgId);
      const realExp = typeof indexedExp === "number" ? indexedExp : this.cardExpirySf(msgId);
      if (cid.startsWith("q:") && ((realExp !== null && (tapSf === null || tapSf > realExp)) || (realExp === null && typeof exp === "number"))) {
        const out = await this.deadTap(it, msgId, "expired", TAP_EXPIRED);
        this.log(`tap on card ${msgId} refused: its keys expired`);
        return out;
      }
      // Round 12: a card whose keys are in the issued-key log but which this state doesn't know: the
      // state was restored from an older copy. The tap is told as lost on the card's own thread, once.
      // Round 13: and one the log lost too (a whole-image restore), when the bot authored it with a
      // well-formed key and the keeper's mirror, the remote's history or its age says it was ours.
      const lost = (logged?.keys.length ?? 0) > 0 || (cid.startsWith("q:") && await this.lostToWholeRestore(it, msgId, cid));
      const out = await this.deadTap(it, msgId, lost ? "lost to a restore of the link's state" : "not a card the link knows", lost ? TAP_RESTORE_LOST : undefined);
      if (lost) { this.restoreSeen = true; await this.tellRestoreLost(msgId, `card ${msgId}`); }
      return out;
    }
    // A retap or a Discord retry with a key already honoured: the recorded outcome, nothing again
    // (before any other check: the card shows the answer since).
    const key = cid.startsWith("q:") ? this.tapKey(rec, cid, msgId) : null;
    const prior = key ? s.taps?.[key] : undefined;
    if (prior) return this.priorTap(it, msgId, prior);
    // One tap on a card at a time: a tap on any of its buttons while another is being handled waits
    // for that one (up to the read limit) and is answered with its recorded outcome.
    if (cid.startsWith("q:")) {
      const other = this.cardTaps.get(msgId);
      if (other) return this.afterOtherTap(it, msgId, other);
      const run = this.tapBody(it, cid, msgId, s, rec, now, key);
      this.cardTaps.set(msgId, run);
      try { return await run; } finally { if (this.cardTaps.get(msgId) === run) this.cardTaps.delete(msgId); }
    }
    return this.tapBody(it, cid, msgId, s, rec, now, key);
  }

  // Taps being handled, by card.
  private cardTaps = new Map<string, Promise<string>>();
  // The honoured tap on a card (any button), if one is recorded.
  private claimOn(msgId: string): TapClaim | undefined {
    return Object.values(this.d.load().taps ?? {}).find((t) => t.msg === msgId);
  }
  // The second tap waits for the first up to the read limit. If the first hasn't settled by then, the
  // second answers busy at once: it never reads a claim the first is still writing, never shows an
  // outcome that isn't recorded, and never starts a second action. The card is left as the first
  // tap will leave it (its buttons aren't put back under a tap still being handled).
  private async afterOtherTap(it: any, msgId: string, other: Promise<string>): Promise<string> {
    if (await this.answer(it, ACK)) this.deferred.add(it);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([other.catch(() => "").then(() => { settled = true; }),
      new Promise<void>((ok) => { timer = setTimeout(ok, this.readLimit()); })]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      await this.ephemeral(it, BUSY_TAP);
      this.log(`tap refused: another tap on card ${msgId} hadn't settled within the read limit (${this.readLimit()} ms); answered busy, nothing started`);
      return "refused: busy";
    }
    const c = this.claimOn(msgId);
    if (c && c.shown) {
      this.log(`a second tap on card ${msgId} came while its first was handled: answered with the first's recorded outcome`);
      return this.priorTap(it, msgId, c);
    }
    if (this.deferred.has(it)) await this.restoreCard(it, msgId);
    await this.ephemeral(it, BUSY_TAP);
    this.log(`tap refused: another tap on card ${msgId} was still being handled; the card keeps its buttons`);
    return "refused: busy";
  }

  private async tapBody(it: any, cid: string, msgId: string, s: State, rec: Shown, now: number, key: string | null): Promise<string> {
    if (rec.outcome === "answered" && rec.why === "held") return this.deadTap(it, msgId, "held", TAP_HELD);
    // Round 18: a card the sweep expired by the link's estimate of Discord's time (say after a forward step of the
    // Pi's clock) is judged again by the tap's own interaction snowflake: one stamped before the card's real expiry
    // (its post snowflake plus its lifetime) acts, as long as the card shows what was posted and nothing else used it.
    if (rec.outcome === "expired" && rec.why === "expired" && rec.q && cid.startsWith("q:")) {
      const tapSf = /^\d{15,22}$/.test(String(it?.id ?? "")) ? snowflakeTime(String(it.id)) : null;
      const real = this.cardExpirySf(msgId, rec);
      if (tapSf !== null && real !== null && tapSf <= real && !this.claimOn(msgId) && digest(it.message?.content ?? "", it.message?.components) === rec.digest) {
        delete rec.outcome; delete rec.why; rec.q.used = false;
        this.d.save(s);
        this.log(`tap on card ${msgId}: the sweep had expired it, but Discord stamps the tap before its real expiry; judged as live`);
      }
    }
    if (rec.outcome) return this.deadTap(it, msgId, rec.why ?? rec.outcome);
    if (digest(it.message.content ?? "", it.message.components) !== rec.digest) {
      await this.answer(it, ACK);
      this.log("tap refused: card was changed after it was posted");
      return "refused: card was changed after it was posted";
    }
    // An ask or Ship card about an item: its fresh read of the keeper's files comes first, so the
    // tap is acknowledged at once with a deferred update and answered after the read, within
    // Discord's window whatever the read does.
    const item = boundItem(rec);
    // An interaction already answered busy is disqualified for good, whatever its read does later.
    if (it?.id && this.disqualified.has(String(it.id)) && this.disqualified.get(String(it.id)) === msgId) {
      await this.answer(it, ACK);
      this.log("tap refused: that attempt was already answered busy");
      return "refused: busy";
    }
    if (cid !== RESUME && item && (rec.kind === "ask" || rec.kind === "ship")) {
      if (await this.answer(it, ACK)) this.deferred.add(it);
    }
    if (cid !== RESUME) {
      const why = await this.deadReason(rec, now, msgId, /^\d{15,22}$/.test(String(it?.id ?? "")) ? snowflakeTime(String(it.id)) : null);
      // The ledger, the keeper's status or the check's outcome couldn't be read, or the ledger
      // is behind the card's generation: the tap is rejected with the status-changed reason, and
      // the card keeps its buttons for the sweep to judge. A read over its limit is "busy, tap
      // again" (counted in the keeper's audit); a clock that isn't synchronized now, or a copy
      // the keeper reset and hasn't pushed since, refuse it too. The card keeps its buttons.
      const held: Record<string, [string, string, string]> = {
        "status unreadable": [STATUS_TAP, "refused: status unreadable", "the source check couldn't be confirmed from the ledger"],
        "status busy": [BUSY_TAP, "refused: busy", `the ledger's read took ${this.tapRead?.ms ?? "?"} ms, over ${this.readLimit()} ms`],
        "clock unsynced": [CLOCK_TAP, "refused: clock", "the box's clock isn't synchronized now"],
        "record reset": [RESET_TAP, "refused: record reset", "the record keeper reset its copy and hasn't pushed since"],
        "record unpushed": [UNPUSHED_TAP, "refused: record unpushed", `the record keeper's push has failed for over ${UNPUSHED_TAP_MS / 60_000} minutes`],
        "record epoch": [EPOCH_TAP, "refused: record reset since", "the card was posted before the record keeper's latest reset epoch"],
        "ship unpushed": [SHIP_UNPUSHED_TAP, "refused: ship unpushed", "a Ship tap waits for the record keeper's push to land"],
      };
      if (held[why]) {
        const [say, out, line] = held[why];
        if (why === "status busy" && it?.id) { this.disqualified.set(String(it.id), msgId); if (this.disqualified.size > 200) this.disqualified.delete(this.disqualified.keys().next().value!); }
        // The deferred answer left the card waiting on Discord: its original message is patched back
        // as it was, so its buttons are live again, and the reason follows to him alone.
        if (this.deferred.has(it)) await this.restoreCard(it, msgId);
        else await this.answer(it, ACK);
        await this.ephemeral(it, say);
        this.log(`tap refused: ${line}; the card keeps its buttons`);
        if (why === "status busy")
          try { this.d.waitTimeout?.({ id: `tap-${msgId}-${now}`, at: new Date(now).toISOString(), waited_ms: this.tapRead?.ms ?? this.readLimit(), kind: "tap" }); } catch { /* logged above */ }
        return out;
      }
      if (why) {
        rec.outcome = why === "answered" ? "answered" : "expired"; rec.why = why;
        this.d.save(s);
        return this.deadTap(it, msgId, why);
      }
    }
    // Round 12: a Ship tap before install taps are on (keeper.sh install-taps on, after the post-install
    // tests): nothing lands, the card keeps its buttons, he is told installs wait, and Cain hears it.
    // "once" lets exactly one Ship tap through (the smoke test's pull-the-plug case) and is used up by it.
    if (cid.startsWith("q:") && rec.kind === "ship" && rec.ship && rec.q?.options[Number(cid.split(":")[2])] === "Ship") {
      // Round 13: the flag is the keeper-owned install log's (off when it is missing, corrupt or unreadable).
      const flag = installState(this.d.installLog);
      if (flag.how === "off") {
        if (this.deferred.has(it)) await this.restoreCard(it, msgId); else await this.answer(it, ACK);
        await this.ephemeral(it, INSTALL_WAIT);
        this.log(`Ship tap on card ${msgId} refused: install taps aren't on yet (keeper.sh install-taps on, after the post-install tests); the card keeps its buttons`);
        this.d.relay(`Dane tapped Ship on card ${msgId}, but install taps aren't on yet, so nothing landed and the card keeps its buttons; he was told installs wait for the post-install tests. Run keeper.sh install-taps on once the smoke test, the forced-webhook step, the pull-the-plug case and one real settle cycle have passed. Nothing more to tell him.`);
        return "refused: installs wait";
      }
      if (flag.how === "once") {
        // Round 13: the once use is appended (fsynced) to the install log before the landing ledger's
        // first write, so a crash anywhere after it can't let a second Ship tap through.
        const kid = key ? tapKid(key) : `card ${msgId}`;
        try { appendInstall(this.d.installLog!, { t: "once-used", kid, msg: msgId, at: new Date(this.d.now()).toISOString() }); }
        catch (e) {
          if (this.deferred.has(it)) await this.restoreCard(it, msgId); else await this.answer(it, ACK);
          await this.ephemeral(it, INSTALL_WAIT);
          this.log(`Ship tap on card ${msgId} refused: the once use couldn't be written to the install log (${String(e).slice(0, 80)})`);
          return "refused: installs wait";
        }
        this.d.crashPoint?.("install-once:after-log");
        this.log(`Ship tap on card ${msgId}: the one Ship tap install-taps once allowed, used up now (${kid})`);
      }
    }
    // Round 14: a key the record keeper already consumed (a restore of this state forgot the tap): told on
    // the card, nothing again.
    if (key && cid.startsWith("q:") && this.consumedKids().has(tapKid(key))) {
      const out = await this.deadTap(it, msgId, "consumed", TAP_CONSUMED);
      this.log(`tap on card ${msgId} refused: its tap key ${tapKid(key)} was already acted on (the keeper's consumed-key log)`);
      return out;
    }
    // Round 14: while the record keeper's consumed set is unverified (every start until a fresh fetch of the
    // record remote, and a detected restore until its rebuild), a tap on an ask is held: a framed, fsynced
    // record in the held-tap log, stamped with its tap time and the check version it was judged against,
    // before the card says it is held. A Ship tap waits instead, its buttons kept.
    if (key && cid.startsWith("q:") && item && (rec.kind === "ask" || rec.kind === "ship") && this.keeperUnverified()) {
      if (rec.kind === "ship") {
        // Round 15: the tap gets its own line on the card at once, its buttons kept, and nothing of it is kept
        // (he taps again once the line clears). The card's record takes the new text, so a tap after the line
        // clears matches it; the sweep edits the line away once the keeper's status says verified.
        const content = withLine(String(it.message?.content ?? ""), SHIP_CHECKING), comps = it.message?.components ?? [];
        const s2 = this.d.load(), m2 = s2.messages[msgId];
        if (m2) { m2.digest = digest(content, comps); m2.checking = "ship"; this.d.save(s2); }
        if (this.deferred.has(it)) await this.restoreCard({ ...it, message: { ...it.message, content } }, msgId);
        else await this.answer(it, UPDATE, { content, components: comps, allowed_mentions: { parse: [] } });
        this.log(`Ship tap on card ${msgId} not taken: the record keeper's consumed set is unverified; the card says so, keeps its buttons, and nothing of the tap is kept`);
        await this.unverifiedNotice(true);
        return "refused: record unverified";
      }
      if (this.heldFile()) return this.holdTap(it, cid, msgId, rec, key, now);
    }
    // Honoured while the keeper's ledger is unpushed: journaled, so that if the keeper then
    // resets its copy, Cain and Dane hear this tap acted on a check that may not have landed.
    if (cid.startsWith("q:") && item && (rec.kind === "ask" || rec.kind === "ship")) this.journal(rec, cid, msgId, item, now, key ?? undefined);
    if (cid.startsWith("q:")) return this.onQuestion(it, cid, msgId, key ?? undefined);
    if (cid === RESUME) { this.setStop(false); return this.stopTap(it, cid, msgId); }
    return this.toSpecialist(it, cid, msgId);
  }

  // Stop and Turn back on go on to the calendar specialist, whose notice says what
  // happened. If it doesn't take the tap, the notice comes from here, so the tap is
  // never silent, with the button that undoes it.
  private async stopTap(it: any, cid: string, msgId: string): Promise<string> {
    const out = await this.toSpecialist(it, cid, msgId);
    await this.retoggleMorning();
    const s = this.d.load();
    if (out !== "specialist unreachable") {
      if (s.toggle) { delete s.toggle; this.d.save(s); }
      return out;
    }
    // Owed to the specialist: the sweep sends it the moment it answers again.
    s.toggle = cid;
    this.d.save(s);
    const stopped = this.stopped().stopped;
    const line = this.stopUnsaved ? this.stopLine(stopped ? "stopped" : "resumed") : stopped ? STOPPED_ALONE : RESUMED_ALONE;
    await this.postToggle(`**${stopped ? "Stopped" : "Turned back on"}.** ${line}`, stopped);
    return out;
  }

  // His morning message's button follows where things stand: Turn back on while stopped,
  // Stop otherwise. Its record follows the edit, so his tap on it still counts.
  private async retoggleMorning(): Promise<void> {
    const want: [string, string] = this.stopped().stopped ? ["Turn back on", RESUME] : ["Stop", STOP];
    const comps = rows([[want]], "q:");
    const ids = Object.entries(this.d.load().messages)
      .filter(([, m]) => m.kind === "morning" && !m.outcome && m.buttons).map(([id]) => id);
    for (const id of ids) {
      try {
        const { dm } = await this.identity();
        const msg = await this.rest("PATCH", `/channels/${dm}/messages/${id}`, { components: comps });
        const s = this.d.load();
        if (s.messages[id]) {
          s.messages[id].digest = digest(String(msg?.content ?? ""), msg?.components ?? comps);
          s.messages[id].labels = [want[0]];
          this.d.save(s);
        }
      } catch (e) { this.log(`couldn't change the morning message's button: ${String(e).slice(0, 80)}`); }
    }
  }

  // A Stop or Turn back on the specialist didn't take: sent again until it does, as long
  // as it still matches where things stand.
  private async sendOwedToggle(): Promise<void> {
    const s = this.d.load();
    if (!s.toggle) return;
    if ((s.toggle === STOP) !== this.stopped().stopped) { delete s.toggle; this.d.save(s); return; }
    if (!(await this.d.toHarness("/press", { custom_id: s.toggle, message_id: 0 }))) return;
    const s2 = this.d.load();
    delete s2.toggle;
    this.d.save(s2);
    this.log(`the calendar specialist took the ${s.toggle === STOP ? "Stop" : "Turn back on"} it missed`);
  }

  // A notice from the link with the one button that undoes where things stand,
  // recorded so his tap on it counts.
  // repost: the same notice brought down to keep Turn back on within reach while stopped;
  // the link's older ones lose theirs, with no line (nothing happened to them).
  private async postToggle(text: string, stopped: boolean, repost = false, nonce?: string): Promise<void> {
    try {
      const button: [string, string] = stopped ? ["Turn back on", RESUME] : ["Stop", STOP];
      const words = this.ownWords("stop notice", "link", text.replace(/\s{2,}/g, " "));
      const msg = await this.post(words, rows([[button]], "q:"), nonce ? { nonce } : {});
      const s = this.d.load();
      this.remember(s, msg, { kind: "card", item: "none", question: "stop", posted: this.d.now(), expires: null, buttons: true,
        toggle: button[1], labels: [button[0]] });
      if (stopped) s.repostedAt = this.d.now();
      const older: string[] = [];
      if (repost) for (const [id, m] of Object.entries(s.messages))
        if (id !== String(msg.id) && m.toggle === RESUME && m.buttons && !m.outcome) { m.outcome = "replaced"; m.why = REPOSTED; older.push(id); }
      this.d.save(s);
      await this.retireToggles(String(msg.id));
      await this.stripAll(older);
      // Its own Stop is the one within reach now: a moving Stop placed meanwhile comes off.
      if (!stopped) void this.inStopQueue(() => this.placeStop());
    } catch (e) { this.log(`couldn't post the Stop notice: ${String(e).slice(0, 80)}`); }
  }

  // A Stop notice whose button no longer does what it says (Turn back on, once things
  // are back on) loses it, and says what changed since ("Turned back on since."). The
  // morning message keeps its own, which follows where things stand.
  private async retireToggles(keep: string): Promise<void> {
    const s = this.d.load();
    const stale = this.stopped().stopped ? STOP : RESUME;
    const old: string[] = [];
    for (const [id, m] of Object.entries(s.messages)) {
      if (id === keep || !m.buttons || m.outcome || m.kind !== "card") continue;
      const c = m.card !== undefined ? s.cards[String(m.card)] : undefined;
      const ids = m.toggle ? [m.toggle] : c && (c.kind === "stopped" || c.kind === "resumed") ? buttonIds(c.rows) : [];
      if (!ids.includes(stale)) continue;
      m.outcome = "replaced"; m.why = stale === STOP ? STOPPED_AGAIN : TURNED_ON;
      old.push(id);
    }
    if (!old.length) return;
    this.d.save(s);
    await this.stripAll(old);
  }

  // -- Stop within reach (0.10.0) -----------------------------------------------------
  // One moving Stop on the newest plain message: Cain's reply, or a notice of the link's,
  // whose last paragraph asks nothing. Never an ask, a Ship card, a specialist's card, the
  // connector notice, a Stop notice, a permission prompt or the morning message. It moves
  // only when none of the newest 5 bot messages carries a Stop (the specialist's Stop rows
  // and the morning message count), Stop first on the new message and then off the old, in
  // one queue with his Stop taps, and only when Discord is quiet: no card's outcome edit
  // waiting, no rate limit in the last minute, no unanswered move still backing off. A
  // message Discord refuses it on three times is skipped for the newest plain one within
  // reach. A strip that fails is tried again by the sweep, and an old Stop keeps working
  // meanwhile. Each move edits buttons alone, which Discord marks "(edited)". The plugin's
  // text edits leave a message's buttons alone (discord.js edit(text) sends only the
  // content), so Cain editing the message that holds it changes nothing here, unless the
  // edit makes it ask something.
  private stopChain: Promise<void> = Promise.resolve();
  private inStopQueue(job: () => Promise<void>): Promise<void> {
    const run = this.stopChain.then(job).catch((e) => this.log(`couldn't keep Stop within reach: ${reason(e)}`));
    this.stopChain = run;
    return run;
  }
  // The same, for a job whose answer (or failure) is its caller's: a notice that may carry Stop.
  private stopQueued<T>(job: () => Promise<T>): Promise<T> {
    const run = this.stopChain.then(job);
    this.stopChain = run.then(() => {}, () => {});
    return run;
  }
  whenStopPlaced(): Promise<void> { return this.stopChain; }   // for the tests

  // A message the link knows as its own (an ask, a card, a notice, the morning message):
  // never one of Cain's replies, whatever a note says. "plain" is his reply holding Stop.
  private linkPosted(s: State, id: string): boolean {
    return !!s.messages[id] && s.messages[id].kind !== "plain";
  }

  // What Cain just sent with his plugin (POST /sent, from the PostToolUse hook): his replies
  // go on his edit allowlist, the moving Stop follows, and what the safety net found reaches
  // him. An edit only says whether his reply asks something now: it never adds a message to
  // the list. background: the Stop's move isn't waited for (the route answers at once, so
  // the hook's retry never repeats a note the link already took).
  private netSeen = new Map<string, number>();       // lines /sent relayed, by digest: when (this run)
  // True the first time within a minute: the hook sends a note again when its answer is lost,
  // and each line a note brings reaches Cain once.
  private firstTime(...parts: unknown[]): boolean {
    const now = this.d.now();
    for (const [k, at] of this.netSeen) if (at < now - 60_000) this.netSeen.delete(k);
    const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    if (this.netSeen.has(key)) return false;
    this.netSeen.set(key, now);
    return true;
  }
  async sent(n: any, o: { background?: boolean } = {}): Promise<{ status: "ok"; said: string }> {
    const ids: string[] = (Array.isArray(n?.ids) ? n.ids : []).map(String).filter((x: string) => SNOWFLAKE.test(x)).slice(0, 10);
    if (!ids.length) throw new Refusal("needs the ids of what went out");
    const tool = n?.tool === "edit" ? "edit" : "reply";
    const asking = n?.question === true;
    const now = this.d.now();
    const s = this.d.load();
    const sent = s.sent ?? (s.sent = {});
    const last = ids[ids.length - 1];
    let theirs = "";                                  // an edit of a message the link posted: the reply hook was bypassed
    if (tool === "reply") {
      const mine = ids.filter((id) => !this.linkPosted(s, id));
      mine.forEach((id, i) => { sent[id] = { at: snowflakeTime(id) || now, last: i === mine.length - 1, asks: asking }; });
    } else if (this.linkPosted(s, last)) theirs = last;
    else if (sent[last]) sent[last].asks = asking;
    for (const [id, r] of Object.entries(sent)) if (r.at <= now - REMEMBER_MS) delete sent[id];
    // A reply to a message that is neither the link's nor Cain's: one of his, so he wrote then.
    const replyTo = typeof n?.reply_to === "string" && SNOWFLAKE.test(n.reply_to) ? n.reply_to : "";
    if (replyTo && !s.messages[replyTo] && !sent[replyTo]) s.hisAt = Math.max(s.hisAt ?? 0, Math.min(now, snowflakeTime(replyTo)));
    this.d.save(s);
    // A note sent again (its answer lost) is told once: the bypassed edit, and what the net found.
    // Which send it is comes from its tool call's own id (or a hash of its text): a second edit
    // of the same card is a send of its own, and is told too.
    const call = typeof n?.call === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(n.call) ? n.call : "";
    if (theirs && this.firstTime("bypassed", call, tool, ids)) {
      const m = s.messages[theirs];
      this.log(`Cain's edit changed a message the link posted (${m.kind ?? "legacy"}): the reply hook was bypassed`);
      try { this.d.report?.({ point: "sent", writer: "cain", message: theirs, hits: [], did: "bypassed: an edit of a message the link posted" }); }
      catch (e) { this.log(`couldn't log the gate's report: ${String(e).slice(0, 80)}`); }
      this.d.relay(`Your edit changed Discord message ${theirs}, ${m.kind === "notice" || m.kind === "morning" ? "a message" : "a card"} your App posted, not one of your replies: the message gate should have held it, and it's logged for a fix. Don't edit it again; if it needs setting right, say so in a new reply.`);
    }
    const net = netOf(n?.net);
    if (net && this.firstTime(call, tool, ids, net)) this.d.relay(netLine(tool, last, net));
    const placing = this.inStopQueue(() => this.placeStop());
    if (!o.background) await placing;
    return { status: "ok", said: "Noted." };
  }

  // Cain's replies from his transcripts (at start, and every few hours): his edit allowlist.
  // Only replies: never a message he edited, nor one the link knows as its own. Whether each
  // one asks something isn't known, so none of them holds the moving Stop.
  seedSent(ids: Iterable<string>): number {
    const now = this.d.now();
    const s = this.d.load();
    const sent = s.sent ?? (s.sent = {});
    let added = 0;
    for (const id of ids) {
      const at = SNOWFLAKE.test(id) && !sent[id] && !this.linkPosted(s, id) ? snowflakeTime(id) : 0;
      if (!at || at <= now - REMEMBER_MS) continue;
      sent[id] = { at };
      added++;
    }
    s.seeded = now;
    this.d.save(s);
    return added;
  }

  // A message the link just posted carrying Stop: it holds it now, and the one before loses
  // it at the next quiet moment (its strip is due).
  private takeStop(s: State, id: string): void {
    const old = s.stopAt;
    s.stopAt = id;
    const m = old && old !== id ? s.messages[old] : undefined;
    if (m?.buttons && !m.outcome) { m.outcome = "replaced"; m.why = MOVED; }
  }

  // The bot's messages the link knows of, newest first: its own posts and Cain's replies.
  private newestBot(s: State, n: number): string[] {
    const ids = new Set<string>(Object.keys(s.sent ?? {}));
    for (const [id, m] of Object.entries(s.messages)) if (m.kind && m.kind !== "legacy") ids.add(id);
    return [...ids].filter((id) => SNOWFLAKE.test(id)).sort((a, b) => (newerId(a, b) ? -1 : 1)).slice(0, n);
  }

  // A message known gone from his DM carries nothing.
  private carries(s: State, id: string, label: string): boolean {
    const m = s.messages[id];
    return !!m?.buttons && !m.outcome && !m.gone && (m.labels ?? []).includes(label);
  }

  // Where the moving Stop may sit (above): Cain's reply whose newest part asks nothing, or a
  // notice of the link's own that asks nothing.
  private plainOk(s: State, id: string): boolean {
    const m = s.messages[id];
    if (m?.gone) return false;
    if (m && m.kind === "notice") return m.question === "notice" && !m.asks;
    if (m && m.kind !== "plain") return false;
    const r = s.sent?.[id];
    return !!r && r.last === true && r.asks === false;
  }

  private newestPlain(s: State): string | null {
    for (const id of this.newestBot(s, Infinity)) if (this.plainOk(s, id)) return id;
    return null;
  }

  // Stop onto a message, before the one that held it loses it. False when Discord didn't take
  // it. Only Discord's own refusal of that message counts against it: a 4xx other than 404
  // (gone: never a holder again) and 429 (moves wait a minute, placeStop). After three it's
  // skipped. No answer, a timeout, a 5xx or a 401 (the bot's token, while it's being
  // changed) is Discord's trouble, never the message's: moves back off instead, 1, 2, 5,
  // then every 10 minutes, until one lands. If he tapped Stop while Discord was answering,
  // it comes straight off again (true: the move goes on, and the old holder loses its Stop
  // too).
  private holdFails = new Map<string, number>();     // Discord's refusals of Stop, by message (this run)
  private moveWait = { fails: 0, next: 0 };          // Discord didn't answer a move: how often, and when moves go on (this run)
  private skipped(id: string): boolean { return (this.holdFails.get(id) ?? 0) >= HOLD_TRIES; }
  private async hold(id: string): Promise<boolean> {
    let msg: any;
    try {
      const { dm } = await this.identity();
      msg = await this.rest("PATCH", `/channels/${dm}/messages/${id}`, { components: rows([[["Stop", STOP]]]), allowed_mentions: { parse: [] } });
    } catch (e) {
      const why = String(e);
      if (/discord 404/.test(why)) {                             // gone from his DM: never a holder again
        const s = this.d.load();
        if (s.messages[id]) s.messages[id].gone = true;
        if (s.sent?.[id]) s.sent[id].last = false;
        this.d.save(s);
      } else if (/discord 429/.test(why)) this.log(`couldn't put Stop on a message: ${reason(e)}`);
      else if (/discord 4\d\d/.test(why) && !/discord 401/.test(why)) {
        const n = (this.holdFails.get(id) ?? 0) + 1;
        this.holdFails.set(id, n);
        this.log(`Discord refused Stop on a message${n >= HOLD_TRIES ? ` (${n} times: it's skipped)` : ""}: ${reason(e)}`);
      } else {
        const n = ++this.moveWait.fails;
        const wait = MOVE_WAITS_MS[Math.min(n, MOVE_WAITS_MS.length) - 1];
        this.moveWait.next = this.d.now() + wait;
        this.log(`couldn't put Stop on a message, tried again in ${wait / 60_000} min: ${reason(e)}`);
      }
      return false;
    }
    this.holdFails.delete(id);
    this.moveWait = { fails: 0, next: 0 };
    const s = this.d.load();
    const was = s.messages[id];
    if (was) {
      Object.assign(was, { buttons: true, labels: ["Stop"], digest: digest(String(msg?.content ?? ""), msg?.components ?? []) });
      delete was.outcome; delete was.why; delete was.off;
    } else this.remember(s, msg?.id ? msg : { id }, { kind: "plain", item: "none", question: "plain", posted: snowflakeTime(id),
      expires: null, buttons: true, labels: ["Stop"] });
    s.stopAt = id;
    this.d.save(s);
    if (this.stopped().stopped) { await this.unhold(id, MOVED); return true; }
    this.log("Stop moved to the newest plain message");
    return true;
  }

  // Stop off a message: buttons only, no line.
  private async unhold(id: string, why: string): Promise<void> {
    const s = this.d.load();
    const m = s.messages[id];
    if (s.stopAt === id) delete s.stopAt;
    if (m?.buttons && !m.outcome) { m.outcome = "replaced"; m.why = why; }
    this.d.save(s);
    await this.strip(id);
  }

  private pendingSince = new Map<string, number>();   // outcome edits waiting, by message: since when (this run)
  private async placeStop(): Promise<void> {
    if (!this.d.stop) return;                                  // no Stop state to follow
    const now = this.d.now();
    if (now - this.limitedAt < QUIET_MS) return;               // Discord rate-limited the link just now
    const s = this.d.load();
    // A card's outcome edit goes first; the moving Stop's own strips are part of a move. One
    // that has failed for 10 minutes stops holding moves up (the sweep keeps trying it).
    const pending = Object.entries(s.messages).filter(([, m]) => m.buttons && m.outcome && m.why !== MOVED && m.why !== REPOSTED).map(([id]) => id);
    for (const id of [...this.pendingSince.keys()]) if (!pending.includes(id)) this.pendingSince.delete(id);
    for (const id of pending) if (!this.pendingSince.has(id)) this.pendingSince.set(id, now);
    if (pending.some((id) => now - this.pendingSince.get(id)! < 10 * 60_000)) return;
    const holder = s.stopAt && this.carries(s, s.stopAt, "Stop") ? s.stopAt : null;
    const st = this.stopped();
    if (st.stopped) {
      // Turn back on stays within reach however it's stopped: his tap, a Stop that couldn't
      // be saved, or a Stop state that can't be read (no time: it's posted at once).
      this.moveWait = { fails: 0, next: 0 };                   // no move is pending while stopped
      if (holder) await this.unhold(holder, MOVED);
      await this.keepResumeInReach(st.at ?? this.changed?.at ?? 0);
      return;
    }
    const reach = this.newestBot(s, STOP_REACH), newest = this.newestPlain(s);
    // Refusals are kept only for what Stop could still go to: the messages within reach, and
    // the newest plain one.
    for (const id of [...this.holdFails.keys()]) if (id !== newest && !reach.includes(id)) this.holdFails.delete(id);
    // His Stop or Turn back on notice carries a Stop of its own: newer than the moving one and
    // within reach, it's the one, and the moving Stop comes off (one Stop after Turn back on).
    if (holder && reach.some((id) => id !== holder && newerId(id, holder) && this.stopNotice(s, id) && this.carries(s, id, "Stop"))) {
      this.moveWait = { fails: 0, next: 0 };
      await this.unhold(holder, MOVED);
      return;
    }
    const holderOk = !!holder && this.plainOk(s, holder);
    const within = reach.some((id) => this.carries(s, id, "Stop") && (id !== holder || holderOk));
    let target = within ? null : newest;
    // Discord refused the newest plain message three times: the newest plain one within reach
    // that it hasn't refused instead. None, and Stop stays where it is: nothing is posted for it.
    if (target && this.skipped(target)) target = reach.find((id) => this.plainOk(s, id) && !this.skipped(id)) ?? null;
    // No move pending: the waits after an unanswered move start over at the next one.
    if (!target || target === holder) this.moveWait = { fails: 0, next: 0 };
    if (target && target !== holder) {
      if (now < this.moveWait.next) return;                    // Discord didn't answer the last move: waiting
      if (!(await this.hold(target))) return;
      if (holder) await this.unhold(holder, MOVED);
      if (!this.stopped().stopped) await this.retireNoticeStops(target);
    } else if (holder && !holderOk) await this.unhold(holder, MOVED);   // it asks something now
  }

  // A Stop or Turn back on notice's own Stop (after Turn back on), out of reach now that the
  // moving Stop is on a newer message: it comes off too, buttons only, with no line, so one
  // Stop shows. The morning message and the specialist's other cards keep theirs.
  private async retireNoticeStops(keep: string): Promise<void> {
    const s = this.d.load();
    const old: string[] = [];
    for (const [id, m] of Object.entries(s.messages)) {
      if (id === keep || !newerId(keep, id) || !this.stopNotice(s, id) || !this.carries(s, id, "Stop")) continue;
      if ((m.labels ?? []).some((l) => l !== "Stop")) continue;   // a button of another kind stays, and so does its row
      m.outcome = "replaced"; m.why = MOVED;
      old.push(id);
    }
    if (!old.length) return;
    this.d.save(s);
    await this.stripAll(old);
  }

  // His Stop or Turn back on notice: the link's own, or the calendar specialist's.
  private stopNotice(s: State, id: string): boolean {
    const m = s.messages[id];
    if (!m) return false;
    if (m.toggle) return true;
    const c = m.card !== undefined ? s.cards[String(m.card)] : undefined;
    return !!c && (c.kind === "stopped" || c.kind === "resumed");
  }

  // While stopped, Turn back on stays within reach: when neither the morning message nor a
  // Stopped notice carrying it is one of the newest 2 bot messages, the link's Stopped
  // notice is posted again. While one is up somewhere, at most hourly (from his Stop, or the
  // last one), or once he has written since, 10 minutes at least after the last re-post:
  // never every few messages. While none is up anywhere (its notice failed to post, or the
  // message is known gone), on each pass until one is, once his Stop's own notice has had a
  // minute to land.
  private async keepResumeInReach(since: number): Promise<void> {
    const s = this.d.load(), now = this.d.now();
    if (this.newestBot(s, RESUME_REACH).some((id) => this.carries(s, id, "Turn back on"))) return;
    const shown = Object.values(s.messages).filter((m) => m.buttons && !m.outcome && !m.gone && (m.labels ?? []).includes("Turn back on"));
    if (shown.length) {
      const last = Math.max(since, s.repostedAt ?? 0, ...shown.map((m) => m.posted ?? 0));
      const wrote = (s.hisAt ?? 0) > last && now - (s.repostedAt ?? 0) >= REPOST_GAP_MS;
      if (now - last < HOUR && !wrote) return;
    } else if (now - since < RESUME_GRACE_MS) return;
    // The same words and nonce until one is recorded: a post whose answer was lost isn't made twice.
    await this.postToggle(STILL_STOPPED, true, true, stableNonce("still stopped", String(since), String(s.repostedAt ?? 0)));
  }

  private async toSpecialist(it: any, cid: string, msgId: string): Promise<string> {
    await this.answer(it, ACK);
    const card = this.cardOf(msgId);
    const ok = await this.d.toHarness("/press", {
      id: String(it.id), token: String(it.token), app: String(it.application_id ?? ""),
      custom_id: cid, message_id: card ?? 0,
    });
    if (!ok) this.log("the calendar specialist didn't take a tap");
    return ok ? "to specialist" : "specialist unreachable";
  }

  // A tap on a card that stopped mattering: the card shows what happened, loses its
  // buttons in place, and he's told, to him alone, that nothing was done.
  // Round 14: line, when given, is the card's line for this path (withdrawn, expired, lost, consumed, held),
  // put on the card in place and told to him alone.
  private async deadTap(it: any, msgId: string, why: string, given?: string): Promise<string> {
    const rec = this.d.load().messages[msgId];
    const line = given ?? outcomeLine(rec);
    const content = String(it.message?.content ?? "");
    const shown = line ? withLine(content, line) : content;
    const ok = await this.answer(it, UPDATE, { content: shown, components: [], allowed_mentions: { parse: [] } });
    const s = this.d.load();
    const r = s.messages[msgId] ?? (s.messages[msgId] = { digest: "", until: this.d.now() + REMEMBER_MS,
      kind: "legacy", item: "none", posted: snowflakeTime(msgId) || undefined });
    r.outcome ??= "expired"; r.why ??= why;
    if (r.q) r.q.used = true;
    r.buttons = !ok;                                     // the sweep tries again if Discord didn't take it
    if (ok) { r.digest = digest(shown, []); r.off = this.d.now(); }
    if (!r.labels) r.labels = labelsOf(it.message?.components);
    this.d.save(s);
    await this.ephemeral(it, given ?? (why === "status changed" ? STATUS_TAP : why === "record reset" ? EPOCH_TAP : EXPIRED_TAP));
    this.log(`tap on a card that stopped mattering (${why}): answered in place`);
    return `dead: ${why}`;
  }

  // A token for his Ship tap on this pull request and head, or null (no key, or it failed).
  private signFor(ship: { pr: string; head: string }): string | null {
    const claim = claimFor(ship.pr, ship.head, this.d.now());
    if (!claim || !this.d.signShip) return null;
    try { return this.d.signShip(claim); }
    catch (e) { this.log(`couldn't sign a Ship tap: ${String(e).slice(0, 80)}`); return null; }
  }

  private tapLine(m: Shown, label: string, msgId: string): string {
    const where = `(Discord message ${msgId}; its card shows his answer. If it needs words from you, reply with reply_to ${msgId})`;
    if (m.kind === "ship" && m.ship)
      return `Dane tapped "${label}" on your Ship card${m.item && m.item !== "none" ? ` for ${m.item}` : ""}: ${m.ship.pr} at head ${m.ship.head} ${where}`;
    const what = about(m.item, m.question);
    return `Dane tapped "${label}" on your question${what ? ` ${what}` : ""}: "${m.q?.q ?? ""}" ${where}`;
  }

  // The idempotency key of a tap on an ask or Ship card: the card, its generation, its check, its
  // item and the tapped label.
  private tapKey(m: Shown, cid: string, msgId: string): string | null {
    const i = Number(cid.split(":")[2]);
    const label = m.q?.options[i];
    if (label === undefined) return null;
    return [msgId, m.checked?.gen ?? "none", m.checked?.req ?? "none", (m.item ?? "none").toUpperCase(), label].join("|");
  }
  // Interactions answered busy, by interaction id (with the card), never honoured afterwards.
  // (tapKid, below the class: the key's short form on Cain's lines.)
  private disqualified = new Map<string, string>();

  // A tap whose key was honoured already: its recorded outcome, shown again, nothing done again.
  private async priorTap(it: any, msgId: string, t: TapClaim): Promise<string> {
    // A claim with no recorded card words (one lost to a reset before its card was known): nothing
    // to show, so the card is left as it is and nothing is done again.
    if (!t.shown) { await this.answer(it, ACK); this.log(`tap on card ${msgId} already honoured (${t.stage}), nothing recorded to show: nothing done again`); return `already: ${t.outcome}`; }
    await this.answer(it, UPDATE, { content: t.shown, components: [], allowed_mentions: { parse: [] } });
    this.log(`tap on card ${msgId} already honoured (${t.stage}): its recorded outcome, nothing done again`);
    return `already: ${t.outcome}`;
  }

  // Claims a restart cut off (each sweep): a claim not yet acted on is acted on now, once (nothing was
  // done for it: the claim is written before anything is); one acted on but whose card wasn't edited
  // gets its edit. Nothing is done twice: each step is recorded before the next. The line a claim
  // relays after a restart is marked as a possible repeat with its tap key (the line may have reached
  // Cain just before the restart), so he acts on a tap key once.
  // Across a reset: a claim recorded before the current epoch is acted on only if the check it rests
  // on survived the reset; otherwise it is lost to the reset (lostTap), never acted past the epoch.
  // While the keeper's status can't be read, or its reset stands, claims wait.
  private async finishTaps(): Promise<void> {
    const s = this.d.load();
    const open = Object.entries(s.taps ?? {}).filter(([, t]) => t.stage !== "edited");
    if (!open.length) { this.pruneTaps(); return; }
    const st = keeperStatus(this.files().status);
    const cur = st?.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0;
    for (const [k, t] of open) {
      if (this.tapsNow.has(k)) continue;
      // A Ship tap's landing keeps its card itself (showLanding): its claim needs nothing more here.
      if (s.messages[t.msg]?.shipping) {
        const s1 = this.d.load();
        if (s1.taps?.[k]) { s1.taps[k].stage = "edited"; this.d.save(s1); }
        continue;
      }
      if (t.stage === "lost") {
        if (!t.told) {
          if (t.outcome === "not acted") await this.notActedTap(k, t, t.why ?? "it no longer passes the live-tap check", true);
          else await this.lostTap({ key: k, msg: t.msg, label: t.label, item: t.item ?? "none", acted: false, repeat: true });
        }
      } else if (t.stage === "claimed") {
        let judged = false;
        if (t.epoch !== undefined) {
          if (st === null || st?.reset) continue;                        // can't tell the epoch now: wait
          if (t.epoch !== cur) {
            const survived = this.claimSurvives(t.item ?? "none", t.ref ?? s.messages[t.msg]?.checked, t.req, t.kind ?? s.messages[t.msg]?.kind);
            if (survived === null) continue;
            if (!survived) { await this.lostTap({ key: k, msg: t.msg, label: t.label, item: t.item ?? "none", acted: false }); continue; }
            this.log(`claim on card ${t.msg} predates the reset, but its check survived it: acted on`);
            judged = true;
          }
        }
        // A claim from an earlier run of the link (this version before a restart, or another version
        // in between): completed only through the live-tap predicate, or discarded and told. Never
        // judged by file times or save stamps.
        this.runNo();
        if (!judged && t.nonce !== this.runNonce) {
          const live = this.claimLive(t);
          if (live === null) continue;
          if (!live.ok) { await this.notActedTap(k, t, live.why); continue; }
          this.log(`claim on card ${t.msg} from link run ${t.run ?? "unknown"} passes the live-tap predicate: acted on`);
        }
        const s2 = this.d.load();
        if (s2.taps?.[k]) s2.taps[k].stage = "acted";
        this.d.save(s2);
        if (t.line) this.d.relay(`Repeat of tap key ${tapKid(k)}: if you already had a line with this tap key, ignore this one. ${t.line}`);
        this.log(`finished tap ${t.msg} ("${t.label}") from its claim after a restart: Cain told, marked as a possible repeat`);
      }
      const t2 = this.d.load().taps?.[k];
      if (!t2 || t2.stage === "edited") continue;
      try {
        await this.rest("PATCH", `/channels/${this.d.load().dm ?? ""}/messages/${t2.msg}`, { content: t2.shown, components: [], allowed_mentions: { parse: [] } });
        const s3 = this.d.load();
        if (s3.taps?.[k]) s3.taps[k].stage = "edited";
        const m = s3.messages[t2.msg];
        if (m) { m.buttons = false; m.off = this.d.now(); m.digest = digest(t2.shown, []); }
        this.d.save(s3);
        this.log(`finished tap ${t2.msg}: its card shows ${t2.outcome === "lost to reset" ? "the reset" : t2.outcome === "not acted" ? "it wasn't acted on" : "the answer"}`);
      } catch (e) { this.log(`couldn't edit card ${t2.msg} after a cut-off tap: ${String(e).slice(0, 80)}`); }
    }
    this.pruneTaps();
  }
  private issuedSeen = new Map<string, number>();
  // Claims are kept as long as their cards are remembered.
  private pruneTaps(): void {
    const s4 = this.d.load();
    let pruned = false;
    const unresolved = new Set([...Object.keys(s4.unresolved ?? {}), ...Object.keys(s4.tombstones ?? {})]);
    const kids = new Set([...unresolved].map(tapKid));
    for (const [k, t] of Object.entries(s4.taps ?? {})) if (t.stage === "edited" && !s4.messages[t.msg] && !unresolved.has(k)) { delete s4.taps![k]; pruned = true; }
    // Round 18: a tap record is pruned by a snowflake comparison (its card's against the newest Discord stamp this run
    // has seen), or, without a card snowflake, on the monotonic clock of this run (from when this run first saw it):
    // never by a wall-clock duration, since a pruned record makes the keeper refuse its key as lost.
    const newest = this.newestSf ? snowflakeTime(this.newestSf) : null;
    for (const [kid, v] of Object.entries(s4.issued ?? {})) {
      if (kids.has(kid)) continue;
      const card = /^\d{15,22}$/.test(String(v.msg ?? "")) ? snowflakeTime(String(v.msg)) : null;
      let old = false;
      if (card !== null) old = newest !== null && newest - card > TAP_ISSUED_KEEP_MS;
      else {
        if (!this.issuedSeen.has(kid)) this.issuedSeen.set(kid, this.mono());
        old = this.mono() - this.issuedSeen.get(kid)! > TAP_ISSUED_KEEP_MS;
      }
      if (old) { delete s4.issued![kid]; this.issuedSeen.delete(kid); pruned = true; }
    }
    if (pruned) this.d.save(s4);
  }
  private tapsNow = new Set<string>();

  private async onQuestion(it: any, cid: string, msgId: string, key?: string): Promise<string> {
    const run = this.runNo();
    const s = this.d.load();
    const m = s.messages[msgId];
    const q = m?.q;
    const i = Number(cid.split(":")[2]);
    if (!m || !q || q.used || !(i >= 0 && i < q.options.length)) return this.deadTap(it, msgId, "answered");
    const label = q.options[i];
    q.used = true; m.outcome = "answered"; m.label = label; m.why = "answered";
    // His Ship tap lands it in main, unless everything is stopped. Cain hears how it
    // went once it's settled, with the Ship token when it's in main.
    let shown = `You answered: ${label}`, extra = "", landing = false;
    const words = String(it.message.content ?? "");
    if (m.kind === "ship" && m.ship && label === "Ship") {
      if (this.stopped().stopped) {
        shown = "You tapped Ship, but everything is stopped, so nothing shipped.";
        extra = " Everything is stopped, so nothing lands in main and there's no Ship token: after he taps Turn back on, ask again with a new Ship card.";
      } else if (!this.d.land) {
        shown = "You tapped Ship, but shipping is down right now, so nothing shipped.";
        extra = " The link has no deploy key, so nothing can land in main: tell him in one line that shipping is down, and log it as a Build item.";
      } else {
        shown = LANDING_LINE;
        m.shipping = { state: "landing", at: this.d.now(), text: words, line: LANDING_LINE, edited: false, ...(key ? { key } : {}) };
        landing = true;
      }
    }
    const content = withLine(words, shown);
    m.digest = digest(content, []);
    // The claim, with the key and what it will do, is written in the same save that marks the card
    // answered, before anything is done: a restart finishes it from here, never redoes it.
    // The tap's key travels with the line, so Cain acts on a tap key once (a line relayed again after
    // a restart says it may be a repeat).
    const line = landing ? undefined : this.tapLine(m, label, msgId) + extra + (key ? ` Tap key ${tapKid(key)}.` : "");
    if (key) {
      (s.taps ??= {})[key] = { at: this.d.now(), msg: msgId, label, stage: landing ? "acted" : "claimed", outcome: "to Cain", shown: content, ...(line ? { line } : {}),
        item: (m.item ?? "none").toUpperCase(), req: m.checked?.req ?? null, ...(m.checked?.epoch !== undefined ? { epoch: m.checked.epoch } : {}), words,
        ...(m.checked ? { ref: { ...m.checked } } : {}), kind: m.kind, run, nonce: this.runNonce,
        ...(/^\d{15,22}$/.test(String(it?.id ?? "")) ? { it: String(it.id) } : {}) };
      { const item = (m.item ?? "none").toUpperCase(), kind = m.kind ?? "ask";
        (s.issued ??= {})[tapKid(key)] = { item, kind, label, at: this.d.now(), msg: msgId, target: tapTarget(item, kind, label),
          ...(/^\d{15,22}$/.test(String(it?.id ?? "")) ? { it: String(it.id) } : {}) };
        // Round 12: a card adopted at its tap (its post never heard back) has its keys logged now.
        if (this.d.issuedLog && !this.issuedOn(msgId).length)
          try { this.issueKeys(msgId, m, q.options); } catch (e) { this.log(`couldn't log card ${msgId}'s tap keys at its tap: ${String(e).slice(0, 80)}`); } }
      this.tapsNow.add(key);
    }
    // Round 17: fsynced before the relay: the claim is what a restart finishes from, never redoes.
    this.d.save(s, true);
    try {
      // Cain hears it the moment it's saved as answered: if the link stopped now, a tap
      // can't be marked answered and never reach him. A landing tells him when it settles
      // (the sweep settles one the link was cut off from).
      if (line !== undefined) {
        this.d.relay(line);
        if (key) { const sa = this.d.load(); if (sa.taps?.[key]) { sa.taps[key].stage = "acted"; this.d.save(sa); } }
      }
      const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
      if (ok) {
        const s2 = this.d.load();
        const m2 = s2.messages[msgId];
        if (m2) { m2.buttons = false; m2.off = this.d.now(); if (m2.shipping?.line === LANDING_LINE) m2.shipping.edited = true; }
        if (key && s2.taps?.[key]) s2.taps[key].stage = "edited";
        this.d.save(s2);
      }
    } finally { if (key) this.tapsNow.delete(key); }
    if (m.kind === "ask") await this.releaseHeld();
    if (landing) await this.landShip(msgId);
    return "to Cain";
  }

  // -- landing his Ship tap in main (merge.ts) ------------------------------------
  // One at a time: a second tap waits for the first to settle.
  private landingNow = new Set<string>();
  private landClaimed = new Set<string>();                         // tap keys this process claimed a landing for (its retries)
  private landChain: Promise<unknown> = Promise.resolve();

  // His tap stops counting once he taps Stop, and stays void after he turns things back
  // on: the Stop state's time is when it last changed. Only a later tap counts again.
  private voided(tapped: number): boolean {
    const st = this.stopped();
    return st.stopped || (st.at !== null && st.at > tapped);
  }

  // Work on a landing goes in line behind the one before it, and the card is marked as
  // under way meanwhile, so nothing else starts on it.
  private queue(msgId: string, job: () => Promise<void>): Promise<void> {
    this.landingNow.add(msgId);
    const run = this.landChain.then(job).finally(() => this.landingNow.delete(msgId));
    this.landChain = run.catch(() => {});
    return run;
  }

  // Settles once every landing in line now has (for the tests; the sweep never waits).
  whenLanded(): Promise<void> { return this.landChain.then(() => {}); }

  private landShip(msgId: string): Promise<void> {
    return this.queue(msgId, async () => {
      const m = this.d.load().messages[msgId];
      if (!m?.ship || m.shipping?.state !== "landing") return;
      const tapped = m.shipping.at;
      let r: Landed;
      // At most one landing per tap: its key goes to the link's landing ledger (fsynced, file and
      // directory) before the first push attempt, and a key the ledger already has (a landing
      // started before a restart) is never landed again. Such an orphan is settled against the
      // remote only: the link fetches main from GitHub and looks for the landing's token (the head
      // commit) there, never in its local copy. If GitHub can't be reached the key stays unresolved
      // (the card stays "landing", so no new Ship card for that pull request and head goes out) and
      // the next sweep looks again. Not there: the landing is abandoned, and he and Cain are told.
      const key = m.shipping.key;
      let base = m.shipping.base ?? null;
      if (key && this.d.landings && !this.landClaimed.has(key) && !this.voided(tapped)) {
        const L = this.d.landings;
        const started = L.entries()?.find((e) => e.key === key);
        let c: boolean | null = started ? false : null;
        if (!started) {
          // The authorization boundary (round 9): a reset that wins before the landing starts (its
          // ledger claim, made right before the first push attempt) prevents the push, and the tap
          // is lost as any tap whose check didn't survive a reset. Once the claim is made, a reset no
          // longer revokes it: the landing settles truthfully, as landed when the remote has it.
          if (this.resetSinceTap(m)) { await this.loseShipTap(msgId); return; }
          // Already in main at claim time (round 10): no claim and no push. Landed means the commit is
          // in main, not that this tap put it there: the card says it is already in main, and Cain
          // hears it (with the Ship token, so Ship only installs it).
          if (this.d.landed) {
            const pre = await this.remote(m.ship, null);
            if (pre.v === true) {
              this.log(`${m.ship.pr} at that head is in the remote main already at claim time: no landing claimed, nothing pushed`);
              await this.settleLanding(msgId, { ok: true, already: true, unclaimed: true });
              return;
            }
            if (pre.v === null) { await this.settleLanding(msgId, { ok: false, why: "GitHub didn't answer about main", again: true }); return; }
          }
          // main's tip now: the base the claim records, from which settlement searches.
          const tip = this.d.mainTip ? await this.d.mainTip(m.ship.pr).catch(() => null) : undefined;
          if (tip === null) { await this.settleLanding(msgId, { ok: false, why: "GitHub didn't answer about main", again: true }); return; }
          if (this.resetSinceTap(m)) { await this.loseShipTap(msgId); return; }
          base = tip ?? null;
          // The reset boundary closed (round 10): the epoch read right before the claim is recorded in
          // it, and read again once the claim is fsynced, before the first push. A reset that came in
          // between voids the claim: nothing is pushed, and the tap is lost as for any reset.
          const mark = this.epochMark();
          c = L.claim(key, { pr: m.ship.pr, head: m.ship.head, at: new Date(this.d.now()).toISOString(), ...(base ? { base } : {}),
            ...(typeof mark === "number" ? { epoch: mark } : {}) });
          if (c === null) { await this.settleLanding(msgId, { ok: false, why: "the link's landing ledger couldn't be written", again: true }); return; }
          if (c === true && this.epochMark() !== mark) {
            L.settle(key, "not landed", new Date(this.d.now()).toISOString(), { voided: true });
            this.log(`the landing claim for tap key ${tapKid(key)} was voided: the record keeper's reset epoch changed between the last check and the claim's fsync (${String(mark)} to ${String(this.epochMark())}); nothing pushed`);
            await this.loseShipTap(msgId);
            return;
          }
        } else base = started.base ?? base;
        if (c === false) {
          // An orphan: a landing started before a restart. Settled against the remote main only, from
          // its recorded base to the tip (settledFrom); while that can't be told the key stays
          // unresolved, looked for again on a bounded backoff (unresolvedFail), never "did not land".
          if (!this.unresolvedDue(key)) return;
          this.log(`a landing for tap key ${tapKid(key)} already started (before a restart): not landed again, settled from the remote main`);
          const r0 = await this.remote(m.ship, base);
          if (r0.v === null) {
            const next = await this.unresolvedFail(key, r0.why, "orphan", msgId);
            const s1 = this.d.load();
            if (s1.messages[msgId]?.shipping?.state === "landing") { s1.messages[msgId].shipping!.next = next; this.d.save(s1); }
            this.log(`GitHub couldn't settle tap key ${tapKid(key)}'s landing (${r0.why}): it stays unresolved, and no new Ship card goes out for it`);
            return;
          }
          this.unresolvedClear(key);
          await this.settleLanding(msgId, r0.v ? { ok: true, already: true }
            : { ok: false, why: "the install was interrupted by a restart and did not land", again: false, abandoned: true } as Landed);
          return;
        }
        this.landClaimed.add(key);
        const s0 = this.d.load();
        s0.landingCount = Math.max(s0.landingCount ?? 0, L.count());
        if (base && s0.messages[msgId]?.shipping) s0.messages[msgId].shipping!.base = base;
        this.d.save(s0);
      }
      // Before any landing, the token is looked for on the remote main: content already there is a
      // no-op, reported as landed (a re-ship of what an earlier tap, or an older link, landed).
      if (!this.voided(tapped) && this.d.landed) {
        const there = await this.remote(m.ship, base);
        if (there.v === true) { this.log(`${m.ship.pr} at that head is in the remote main already: nothing pushed, reported as landed`); await this.settleLanding(msgId, { ok: true, already: true }); return; }
      }
      if (this.voided(tapped)) r = STOPPED_FIRST;
      else {
        try { r = await this.d.land!({ pr: m.ship.pr, head: m.ship.head, stopped: () => this.voided(tapped) }); }
        catch (e) { r = { ok: false, why: `the link hit an error (${String(e).slice(0, 80)})`, again: true }; }
      }
      await this.settleLanding(msgId, r);
    });
  }

  // Whether the record keeper reset its copy since the Ship card's check (a reset standing, or an
  // epoch other than the card's): the boundary check, made only before the landing starts.
  // keeper.sh settle (round 10): the owner force-settles an unresolved landing key, for a range the
  // remote can never search again (DOCS.md, Reconciling a landing by hand). Owner-only: it needs his
  // own message in his DM (said: its Discord id), under a day old; the link reads it from Discord itself.
  // Round 11: bound to its key. His message must be exactly "settle <tap key> landed" or "settle <tap
  // key> not-landed", naming this very key, which must be unresolved (or a tombstone); its Discord id is
  // consumed when used (kept in the link's state and in the ledger's settled entry) and refused on reuse;
  // words that say both verdicts, or "not landed" in two words where the command says landed, are refused
  // with a plain reason. An audit line goes to the link's log and a line to Cain. Landed posts the landed
  // outcome (the Ship token line while his tap is under 2 hours old); not landed posts the abandoned
  // outcome, and a new card may follow.
  async settleKey(a: { tap?: unknown; how?: unknown; said?: unknown }): Promise<{ status: "settled" | "pending"; said: string }> {
    const tap = String(a.tap ?? "").trim(), how = String(a.how ?? "").trim(), said = String(a.said ?? "").trim();
    if (!/^tap-[0-9a-f]{12}$/.test(tap)) throw new Refusal("settle needs the tap key as the lines name it (tap- and 12 hex digits)");
    if (how !== "landed" && how !== "not-landed") throw new Refusal("settle needs landed or not-landed");
    if (!/^\d{15,22}$/.test(said)) throw new Refusal("settle is the owner's alone: --said <the Discord id of his message saying it landed, or did not land>");
    // Round 13: while the record keeper's consumed set is unverified, a settle is held: nothing settled.
    const ks = keeperStatus(this.files().status);
    if (ks?.consumed_unverified) {
      this.log(`settle of tap key ${tap} held: the record keeper's consumed set is unverified (${ks.consumed_unverified.why})`);
      return { status: "pending", said: `Held, nothing settled: the record keeper can't yet verify which taps were acted on (${ks.consumed_unverified.why}); it retries by itself. Run the same settle again once keeper.sh clock shows consumed_unverified null.` } as any;
    }
    const s = this.d.load();
    const used = s.settleSaid?.[said] ?? (() => {
      const h = this.d.landings?.handSettles?.()?.find((x) => x.said === said);
      if (h) return { tap: tapKid(h.key), at: Date.parse(h.at) };
      const e = this.d.landings?.entries()?.find((x) => x.settled?.said === said);
      return e ? { tap: tapKid(e.key), at: Date.parse(e.settled!.at) } : undefined;
    })();
    if (used) throw new Refusal(`his message ${said} was already used to settle tap key ${used.tap}: one message settles one key once. Ask him to send a new message of the exact form, nothing settled`);
    const key = Object.keys(s.unresolved ?? {}).find((k) => tapKid(k) === tap) ?? Object.keys(s.tombstones ?? {}).find((k) => tapKid(k) === tap);
    if (!key) throw new Refusal(`tap key ${tap} isn't an unresolved landing: nothing to settle (keeper.sh clock lists the unresolved ones)`);
    const { owner, dm } = await this.identity();
    let msg: any;
    try { msg = await this.rest("GET", `/channels/${dm}/messages/${said}`); }
    catch (e) { throw new Refusal(`his message ${said} couldn't be read from his DM (${String(e).slice(0, 80)}): nothing settled`); }
    if (String(msg?.author?.id ?? "") !== owner) throw new Refusal("that message isn't his: settle is the owner's alone, nothing settled");
    // Round 17: a day old by Discord's times alone (his message against the newest message in his DM now), never
    // the Pi's clock.
    let newest = NaN;
    try { const ch = await this.rest("GET", `/channels/${dm}`); if (/^\d{15,22}$/.test(String(ch?.last_message_id ?? ""))) newest = snowflakeTime(String(ch.last_message_id)); }
    catch (e) { throw new Refusal(`his DM couldn't be read to date his message (${String(e).slice(0, 80)}): nothing settled, run it again in a minute`); }
    if (Number.isFinite(newest) && newest - snowflakeTime(said) > DAY) throw new Refusal("his message is over a day old: ask him again, nothing settled");
    const bad = settleWordsProblem(String(msg?.content ?? ""), tap, how);
    if (bad) throw new Refusal(`${bad}: nothing settled`);
    // Round 12: the settled entry, with his consumed message id, goes to the landing ledger's settle log
    // in one fsynced append before any effect of the settle (the outcome, the relayed line, the state's
    // copy). A crash before it leaves nothing settled (the same message settles it when run again); a
    // crash after it is finished from the ledger on the next sweep (finishHandSettles), once.
    const howW: "landed" | "not landed" = how === "landed" ? "landed" : "not landed";
    if (!this.d.landings?.settleHand) throw new Refusal("the landing ledger can't take a hand settle here: nothing settled");
    this.d.crashPoint?.("hand-settle:before-ledger");
    if (!this.d.landings.settleHand(key, howW, new Date(this.d.now()).toISOString(), said))
      throw new Refusal("the landing ledger's settle log couldn't be written: nothing settled; run it again in a minute");
    this.d.crashPoint?.("hand-settle:after-ledger");
    await this.applyHandSettle(key, howW, said, `his message ${said}: "${excerpt(String(msg?.content ?? ""), 80)}"`);
    return { status: "settled", said: `Tap key ${tap} settled as ${howW}.` };
  }

  // Round 12: a hand settle's effects, after its entry is in the ledger: the state's copy (the consumed
  // message id, the key no longer unresolved or a tombstone), the audit line, Cain's line and the card's
  // outcome. Each step is done once: the state's copy is saved before the lines, and the outcome only
  // while the card still shows the landing.
  private async applyHandSettle(key: string, how: "landed" | "not landed", said: string, words = `his message ${said}`): Promise<boolean> {
    const s = this.d.load();
    const kid = tapKid(key);
    const tomb = s.tombstones?.[key];
    const u: Unresolved | undefined = s.unresolved?.[key] ?? tomb;
    const msgId = u?.msg ?? Object.entries(s.messages).find(([, m]) => m.shipping?.key === key)?.[0];
    const m = msgId ? s.messages[msgId] : undefined;
    if (!u && m?.shipping?.state !== "landing" && m?.shipping?.state !== "tombstone") return false;
    if (u) {
      (s.settleSaid ??= {})[said] = { tap: kid, at: this.d.now() };
      if (tomb) { delete s.tombstones![key]; if (!Object.keys(s.tombstones!).length) delete s.tombstones; }
      if (s.unresolved?.[key]) { delete s.unresolved[key]; if (!Object.keys(s.unresolved).length) delete s.unresolved; }
      if (m?.shipping?.state === "tombstone") m.shipping.state = "landing";   // settled now as the owner says
      this.d.save(s);
      this.log(`settle: tap key ${kid} force-settled as ${how} by the owner (${words}), after ${u.fails} failed look(s) since ${new Date(u.since).toISOString()}${tomb ? " (a tombstone)" : ""}; last error: ${u.last}`);
      this.d.relay(`Landing settled by Dane: tap key ${kid}${m?.ship ? ` (${m.ship.pr} at ${m.ship.head})` : ""} was settled by hand as ${how}, on his own message, since the remote couldn't settle it (${u.fails} tries; last error: ${u.last}). The usual outcome line follows. Nothing to tell him: he decided it.`);
    } else if (m?.shipping?.state === "tombstone") {
      const s2 = this.d.load();
      if (s2.messages[msgId!]?.shipping) { s2.messages[msgId!].shipping!.state = "landing"; this.d.save(s2); }
    }
    if (msgId && this.d.load().messages[msgId]?.shipping?.state === "landing")
      await this.queue(msgId, () => this.settleLanding(msgId, how === "landed" ? { ok: true, already: true }
        : { ok: false, why: "the owner settled it by hand as not landed", again: false, abandoned: true } as Landed));
    return true;
  }

  // Round 12: hand settles in the ledger whose effects a crash cut off, finished once, each sweep.
  private async finishHandSettles(): Promise<void> {
    let list: { key: string; how: "landed" | "not landed"; said: string }[] = [];
    try { list = this.d.landings?.handSettles?.() ?? []; } catch { return; }
    for (const h of list)
      if (await this.applyHandSettle(h.key, h.how, h.said)) this.log(`finished the hand settle of tap key ${tapKid(h.key)} from the landing ledger after a cut-off`);
  }

  // Round 11: unresolved keys over time. After his first line, he is told again once a day on the card's
  // thread (or as a notice when there is no card) with the exact settle message; past UNRESOLVED_ALERT_MS
  // Cain gets one alert line; past UNRESOLVED_TOMB_MS the key becomes a tombstone: kept as it was, listed
  // by keeper.sh clock, its card marked so, and no longer blocking a new Ship card for that pull request
  // and head, nor looked for on the remote any more.
  private async unresolvedChores(): Promise<void> {
    const now = this.d.now();
    // Round 13: a tombstone is kept as long as its issued key (TAP_ISSUED_KEEP_MS, 100 days from the
    // landing's first failure), so both sides forget it together; then it is listed as expired.
    for (const [key, u0] of Object.entries(this.d.load().tombstones ?? {})) {
      if (now - u0.since < TAP_ISSUED_KEEP_MS) continue;
      const s = this.d.load();
      delete s.tombstones![key];
      if (!Object.keys(s.tombstones!).length) delete s.tombstones;
      (s.expiredLandings ??= {})[tapKid(key)] = { since: u0.since, at: now };
      this.d.save(s);
      this.log(`tombstone for tap key ${tapKid(key)} expired after ${Math.floor((now - u0.since) / DAY)} days, with its issued key`);
      this.d.relay(`Landing expired: tap key ${tapKid(key)} stayed unsettled for 100 days, so its tombstone and its issued key are forgotten together (keeper.sh clock lists it under expired_landings). It can no longer be settled by hand. Nothing to tell him.`);
    }
    for (const [key, u0] of Object.entries(this.d.load().unresolved ?? {})) {
      const age = now - u0.since, kid = tapKid(key);
      if (age >= UNRESOLVED_TOMB_MS) {
        const s = this.d.load();
        const u = s.unresolved?.[key];
        if (!u) continue;
        delete s.unresolved![key];
        if (!Object.keys(s.unresolved!).length) delete s.unresolved;
        (s.tombstones ??= {})[key] = { ...u, tomb: now };
        const msgId = u.msg ?? Object.entries(s.messages).find(([, m]) => m.shipping?.key === key)?.[0];
        const m = msgId ? s.messages[msgId] : undefined;
        if (m?.shipping?.state === "landing") { m.shipping.state = "tombstone"; m.shipping.why = "unresolved for 90 days"; }
        this.d.save(s);
        this.log(`landing for tap key ${kid} unresolved for ${Math.floor(age / DAY)} days: now a tombstone (its record kept; it no longer blocks a new Ship card for that pull request and head)`);
        this.d.relay(`Landing tombstoned: tap key ${kid}${m?.ship ? ` (${m.ship.pr} at ${m.ship.head})` : ""} stayed unresolved for 90 days, so it is kept as a tombstone: its record stays, keeper.sh clock lists it under tombstoned_landings, and a new Ship card for that pull request and head may go out. He can still settle it with "${settleForm(kid, "landed")}" (or not-landed). Nothing to tell him.`);
        continue;
      }
      if (age >= UNRESOLVED_ALERT_MS && !u0.alerted) {
        const s = this.d.load();
        if (!s.unresolved?.[key]) continue;
        s.unresolved[key].alerted = now;
        this.d.save(s);
        this.d.relay(`Landing unresolved for over 7 days: tap key ${kid} (failures ${u0.fails}; last error: ${u0.last}). Only he can settle it: he checks main on GitHub from his PC and sends "${settleForm(kid, "landed")}" or "${settleForm(kid, "not-landed")}"; then run keeper.sh settle with that message's id. He is reminded daily; at 90 days it becomes a tombstone.`);
      }
      // Round 12: the per-thread line goes once, on the first day it stays unconfirmed after he was told.
      if (u0.told && !u0.reminded && now - (u0.toldAt ?? u0.since) >= UNRESOLVED_REMIND_MS) {
        const s = this.d.load();
        if (!s.unresolved?.[key]) continue;
        s.unresolved[key].reminded = now;
        this.d.save(s);
        try {
          if (u0.msg) await this.post(unresolvedReminder(kid), [], { replyTo: u0.msg });
          else await this.notice(unresolvedReminder(kid));
          this.log(`reminded him that tap key ${kid}'s landing is still unresolved, with the exact settle messages`);
        } catch (e) { this.log(`couldn't remind him that tap key ${kid}'s landing is unresolved: ${String(e).slice(0, 80)}`); }
      }
    }
    await this.unresolvedDigest();
  }

  // Round 12: after each key's one per-thread line, one digest message for every unresolved key whose
  // line went a day or more ago: daily while any of them had its line within the last 7 days, then
  // weekly. keeper.sh clock lists them all as before.
  private async unresolvedDigest(): Promise<void> {
    const now = this.d.now();
    const s = this.d.load();
    const due = Object.entries(s.unresolved ?? {}).filter(([, u]) => u.reminded && now - u.reminded >= UNRESOLVED_REMIND_MS);
    if (!due.length) return;
    const daily = due.some(([, u]) => now - u.reminded! <= UNRESOLVED_DIGEST_DAILY_MS + UNRESOLVED_REMIND_MS / 2);
    if (now - (s.unresolvedDigestAt ?? 0) < (daily ? UNRESOLVED_REMIND_MS : WEEK) - 60_000) return;
    s.unresolvedDigestAt = now;
    this.d.save(s);
    const kids = due.map(([k]) => tapKid(k)).sort();
    try {
      await this.notice(unresolvedDigest(kids));
      this.log(`sent him the ${daily ? "daily" : "weekly"} digest of ${kids.length} unresolved landing(s): ${kids.join(", ")}`);
    } catch (e) { this.log(`couldn't send him the digest of unresolved landings: ${String(e).slice(0, 80)}`); }
  }

  // Round 12: keeper.sh install-taps on|once|off. Round 13: each is a framed, fsynced record in the
  // keeper-owned install log. off and once are Cain's (once lets one Ship tap through, for the pull-the-plug
  // case); on is the owner's alone: without --said it only proposes, posting him the exact line to send
  // once the post-install tests' result file passes; with --said, his own message in his DM, under a day
  // old, saying exactly "install taps on", single use (written to the landing ledger's settle log like a
  // settle, before anything else), and the result file passing, naming the head the tests ran on.
  async installTaps(a: { how?: unknown; said?: unknown }): Promise<{ status: "ok" | "proposed"; install_taps: string; said: string }> {
    const how = String(a.how ?? "").trim(), said = String(a.said ?? "").trim();
    if (how !== "on" && how !== "once" && how !== "off") throw new Refusal("install-taps needs on, once or off");
    if (!this.d.installLog) throw new Refusal("there is no install log here, so install taps stay off");
    const at = new Date(this.d.now()).toISOString();
    if (how !== "on") {
      try { appendInstall(this.d.installLog, { t: "flag", how, by: "cain", at }); }
      catch (e) { throw new Refusal(`the install log couldn't be written (${String(e).slice(0, 80)}): nothing changed`); }
      this.log(`install taps ${how === "once" ? "allowed once: the next Ship tap lands, then they wait again" : "switched off: Ship taps wait"}`);
      return { status: "ok", install_taps: how, said: how === "once" ? "His next Ship tap lands; after it, Ship taps wait again." : "Install taps are off: his Ship taps wait." };
    }
    const results = installResults(this.d.installResults, this.d.now());
    if ("why" in results) throw new Refusal(`install taps stay off: ${results.why}. Write it from the smoke test and the resilience run first`);
    // Round 16: his install-on line is under the unverified hold (it is not exempt, unlike his recover line):
    // until the keeper's status says a fresh fetch verified its consumed set in its current start and this link
    // run, nothing is proposed or switched on, and a message of his isn't used up.
    if (!this.consumedVerified()) throw new Refusal("install taps stay off: Cain's record is still checking which taps were already acted on (its consumed set isn't verified by a fresh fetch yet). Nothing was proposed or used up: run it again once keeper.sh clock shows consumed_verified true");
    if (!said) {
      const p = await this.propose("install", (line, epoch) => `The post-install tests passed. To let your Ship taps install, send this line, exactly, as a new message:\n\`\`\`\n${line}\n\`\`\`\nIt counts once, and only until the App restarts or its record is reset (record epoch ${epoch}).`);
      this.log(`install taps on proposed: he was sent the line "${p.line}" (tests at ${results.head}, record epoch ${p.epoch})`);
      return { status: "proposed", install_taps: installState(this.d.installLog).how, said: `He was sent the exact line "${p.line}". Once he sends it, run keeper.sh install-taps on --said <his message id>.` };
    }
    let got: { msg: any; nonce: string; skew: number };
    try { got = await this.ownerLine(said, INSTALL_LINE, "install"); }
    catch (e) {
      if (!(e instanceof StaleLine) || !e.late) throw e;
      const p = await this.propose("install", (line, epoch) => `Your line didn't count: ${e.cause}. Here is a fresh one. To let your Ship taps install, send this line, exactly, as a new message:\n\`\`\`\n${line}\n\`\`\`\nIt counts once, and only until the App restarts or its record is reset (record epoch ${epoch}).`);
      await this.tellPiClock();
      this.log(`install taps on line on his message ${said} didn't count (${e.message}); he was told why and sent a fresh line "${p.line}"`);
      return { status: "proposed", install_taps: installState(this.d.installLog).how, said: `His line didn't count (${e.cause}); he was told so and sent a fresh line "${p.line}". Once he sends it, run keeper.sh install-taps on --said <his message id>.` };
    }
    const { msg, nonce, skew } = got;
    if (!this.d.landings?.ownerLine?.("install", said, at)) throw new Refusal("the landing ledger couldn't take his line (or it was used already): install taps stay off");
    try { appendInstall(this.d.installLog, { t: "flag", how: "on", by: "owner", said, nonce, head: results.head, at }); }
    catch (e) { throw new Refusal(`the install log couldn't be written (${String(e).slice(0, 80)}): install taps stay off; run it again with a new message of his`); }
    this.log(`install taps switched on by the owner (his message ${said}: "${excerpt(String(msg?.content ?? ""), 40)}"), on the tests at ${results.head}: Ship taps land`);
    const off = await this.tellClockOff(skew, said);
    return { status: "ok", install_taps: "on", said: `Install taps are on: his Ship taps land in main.${off}` };
  }

  // Round 14: an owner-line proposal: a fresh nonce bound to the keeper's current reset epoch and this start's
  // run nonce, kept in the state before the notice carrying "<line> <nonce>" goes to him.
  private async propose(kind: "install" | "recover", text: (line: string, epoch: number) => string): Promise<{ line: string; epoch: number }> {
    this.runNo();
    const nonce = randomBytes(3).toString("hex").replace(/^\d/, (d) => "abcdefghij"[Number(d)]);
    const epoch = keeperStatus(this.files().status)?.epoch?.n ?? 0;
    const line = `${kind === "install" ? INSTALL_LINE : RECOVER_LINE} ${nonce}`;
    const s = this.d.load();
    s.ownerProposals = [...(s.ownerProposals ?? []).filter((p) => this.d.now() - p.at < 30 * DAY), { kind, nonce, epoch, run: this.runNonce, at: this.d.now() }];
    this.d.save(s, true);
    const id = await this.notice(text(line, epoch));
    const s2 = this.d.load();
    const p = s2.ownerProposals?.find((x) => x.nonce === nonce);
    if (p) { p.msg = String(id); this.d.save(s2, true); }
    return { line, epoch };
  }

  // Round 13: the owner's own line for a command only he may give (install taps on, recover logs): his
  // message in his DM, under a day old, saying exactly the line (copying noise forgiven as for a settle),
  // and not used before for any owner line or settle.
  // Round 14: the line carries the nonce of a proposal issued since this start, for the keeper's epoch as it
  // is now, and unused (in this state, or in the record's Owner-Line trailers the keeper lists); his message
  // must be a live one after the proposal's (never one read back from older history). The proposal is
  // marked used in the state before any effect.
  private async ownerLine(said: string, line: string, what: string): Promise<{ msg: any; nonce: string; skew: number }> {
    if (!/^\d{15,22}$/.test(said)) throw new Refusal(`${what} is the owner's alone: --said <the Discord id of his message saying "${line} <its code>">`);
    const used = this.d.load().settleSaid?.[said] ?? this.d.landings?.handSettles?.()?.find((x) => x.said === said)
      ?? this.d.landings?.ownerLines?.()?.find((x) => x.said === said);
    if (used) throw new Refusal(`his message ${said} was used already: one message counts once. Ask him to send a new one`);
    // Round 16: only a live message counts as a command, or draws a reply or a fresh code: one newer, by
    // snowflake, than the newest message in his DM when this link started, or than a proposal this link run
    // posted. One read back from older history (the restore sweep's pages included) draws nothing.
    this.runNo();
    const mark = await this.startMark();
    const live = (mark !== null && BigInt(said) > BigInt(mark))
      || (this.d.load().ownerProposals ?? []).some((x) => x.run === this.runNonce && !!x.msg && /^\d{15,22}$/.test(x.msg) && BigInt(said) > BigInt(x.msg));
    if (!live) {
      // Round 17: a line read back from history that answers a durable proposal still within OWNER_LINE_MS of it by
      // Discord's times (he sent it while the link was down) is answered once: he is told it arrived while the App
      // was offline and gets a fresh code from this run; the old line never acts. Only a line with no matching
      // proposal gets the silent refusal.
      if (mark !== null && await this.offlineLine(said, line)) throw new StaleLine(`his message ${said} answers a proposal of the App's but was sent while the link was down (before its current start): it doesn't count as it is; he is told so once, with a fresh code`, OFFLINE_CAUSE, true);
      throw new Refusal(mark === null
        ? `his message ${said} can't be told live yet (no start mark in his DM yet, and no proposal of this start before it): nothing done and nothing sent him, run it again after the next sweep`
        : `his message ${said} was sent before the link's current start, so it is history, not a live line: nothing done and nothing sent him`);
    }
    const { owner, dm } = await this.identity();
    let msg: any;
    try { msg = await this.rest("GET", `/channels/${dm}/messages/${said}`); }
    catch (e) { throw new Refusal(`his message ${said} couldn't be read from his DM (${String(e).slice(0, 80)}): nothing done`); }
    if (String(msg?.author?.id ?? "") !== owner) throw new Refusal(`that message isn't his: ${what} is the owner's alone, nothing done`);
    const got = settleNormalise(String(msg?.content ?? "")).replace(/[.!]+$/, "");
    const m = new RegExp(`^${line} ([a-z][0-9a-f]{5})$`).exec(got);
    if (!m) throw new Refusal(`his message doesn't say exactly "${line} <the code the App sent him>" (received, normalised: "${excerpt(got, 80)}"): nothing done`);
    const nonce = m[1];
    const kind = line === INSTALL_LINE ? "install" : "recover";
    this.runNo();
    const s = this.d.load();
    const p = (s.ownerProposals ?? []).find((x) => x.kind === kind && x.nonce === nonce);
    if (!p) throw new Refusal(`his line's code ${nonce} isn't one the App proposed: nothing done. Propose it again (without --said)`);
    if (p.used) throw new StaleLine(`his line's code ${nonce} was used already: one proposal counts once. Propose it again (without --said)`, "that code was used already");
    const st = keeperStatus(this.files().status) as any;
    if (Array.isArray(st?.used_lines) && st.used_lines.includes(nonce)) throw new StaleLine(`his line's code ${nonce} was used already, as the record's history shows: propose it again (without --said)`, "that code was used already");
    if (p.run !== this.runNonce) throw new StaleLine(`his line's code ${nonce} was proposed before the App's current start, so it no longer counts: propose it again (without --said)`, "the App restarted after it sent that code");
    const epoch = st?.epoch?.n ?? 0;
    if (p.epoch !== epoch) throw new StaleLine(`his line's code ${nonce} was proposed in record epoch ${p.epoch}, and the record is in epoch ${epoch} now: propose it again (without --said)`, "Cain's record was reset after the App sent that code");
    if (!p.msg || !(BigInt(said) > BigInt(p.msg))) throw new Refusal(`his message ${said} isn't a live message sent after the proposal: nothing done`);
    // Round 16: liveness is Discord's alone, never the Pi's clock (a Pi has no real-time clock, and after a
    // power cut it can be hours off until time sync): his message after the proposal's by snowflake, and within
    // OWNER_LINE_MS of it, snowflake to snowflake. A late line is refused with both of Discord's times, told to
    // him, with a fresh code.
    const gap = snowflakeTime(said) - snowflakeTime(p.msg);
    if (gap > OWNER_LINE_MS) {
      const tz = this.d.tz ?? "America/New_York";
      throw new StaleLine(`his message ${said} came ${spanWords(gap)} after the proposal by Discord's own times (the code at "${new Date(snowflakeTime(p.msg)).toISOString()}", his line at "${new Date(snowflakeTime(said)).toISOString()}"), past the ${OWNER_LINE_MS / 60_000} minutes a code counts: propose it again (without --said)`,
        `by Discord's times the code went out at ${clockTime(snowflakeTime(p.msg), tz)} and your line came at ${clockTime(snowflakeTime(said), tz)}, over the ${OWNER_LINE_MS / 60_000} minutes a code counts`, true);
    }
    p.used = said;
    this.d.save(s, true);
    return { msg, nonce, skew: this.d.now() - snowflakeTime(said) };
  }
  // Round 17: whether a history line of his answers a durable proposal (in the state, fsynced when made) within
  // OWNER_LINE_MS of it by snowflakes, and hasn't been answered as offline already; marked answered (fsynced)
  // and the proposal marked used before he is told, so it draws one reply and never acts.
  private async offlineLine(said: string, line: string): Promise<boolean> {
    const kind = line === INSTALL_LINE ? "install" : "recover";
    const s0 = this.d.load();
    if (s0.offlineTold?.[said]) return false;
    let msg: any;
    try { const { dm } = await this.identity(); msg = await this.rest("GET", `/channels/${dm}/messages/${said}`); } catch { return false; }
    const { owner } = await this.identity();
    if (String(msg?.author?.id ?? "") !== owner) return false;
    const m = new RegExp(`^${line} ([a-z][0-9a-f]{5})$`).exec(settleNormalise(String(msg?.content ?? "")).replace(/[.!]+$/, ""));
    if (!m) return false;
    const s = this.d.load();
    const p = (s.ownerProposals ?? []).find((x) => x.kind === kind && x.nonce === m[1]);
    if (!p || p.used || !p.msg || !/^\d{15,22}$/.test(p.msg) || !(BigInt(said) > BigInt(p.msg))) return false;
    if (snowflakeTime(said) - snowflakeTime(p.msg) > OWNER_LINE_MS) return false;
    p.used = said;
    (s.offlineTold ??= {})[said] = this.d.now();
    this.d.save(s, true);
    this.log(`his ${kind} line (message ${said}) was sent while the link was down: told once, with a fresh code; it doesn't act`);
    return true;
  }
  // Round 17: with a fresh code for a stale line, the Pi's clock line goes too when the Pi's clock is flagged off
  // (by the fresh code's own post against Discord's stamp for it): information only, never a gate on the code.
  private async tellPiClock(): Promise<void> {
    if (!this.piClockOff()) return;
    try { await this.notice(clockOffLine(this.skew!)); } catch (e) { this.log(`couldn't tell him the Pi's clock is off: ${String(e).slice(0, 80)}`); }
  }
  // Round 16: when the Pi's clock is the outlier against Discord's time for his line, he is told so plainly,
  // with both times, once per line; nothing waits on it.
  private async tellClockOff(skew: number, said: string): Promise<string> {
    if (Math.abs(skew) <= CLOCK_TOLERANCE_MS) return "";
    const tz = this.d.tz ?? "America/New_York";
    const text = `${clockOffLine(skew)} (Discord's time for your line: ${clockTime(snowflakeTime(said), tz)}; the Pi's: ${clockTime(this.d.now(), tz)}.)`;
    try { await this.notice(text); } catch (e) { this.log(`couldn't tell him the Pi's clock is off: ${String(e).slice(0, 80)}`); }
    this.log(`the Pi's clock is ${Math.round(skew / 1000)} s off Discord's time for his message ${said}: told him, judged by Discord's time`);
    return ` ${clockOffLine(skew)}`;
  }

  // Round 13: keeper.sh recover-logs --said <his message id>: the owner accepts a verified rebuild of the
  // record keeper's logs when it refuses to start for a case no rule explains. His exact line ("recover
  // logs"), single use, goes to the landing ledger's settle log, then to the keeper's recover file, which
  // the keeper reads on its next round: it moves the damaged log aside and rebuilds, and goes on only once
  // the rebuild is verified against the record remote.
  async recoverLogs(a: { said?: unknown }): Promise<{ status: "ok" | "proposed"; said: string }> {
    const said = String(a.said ?? "").trim();
    if (!this.d.recoverFile) throw new Refusal("there is no recover file here");
    const offer = (lead = "") => this.propose("recover", (line, epoch) => `${lead}Cain's record needs your OK to rebuild its logs from the record's history. If you agree, send this line, exactly, as a new message:\n\`\`\`\n${line}\n\`\`\`\nIt counts once, and only until the App restarts or its record is reset (record epoch ${epoch}).`);
    if (!said) {
      const p = await offer();
      this.log(`recover-logs proposed: he was sent the line "${p.line}" (record epoch ${p.epoch})`);
      return { status: "proposed", said: `He was sent the exact line "${p.line}". Once he sends it, run keeper.sh recover-logs --said <his message id>.` };
    }
    // Round 15: his recover line is never refused in silence. One whose code no longer counts (proposed before
    // the App's current start, in another record epoch, or used already) gets one line naming the cause and a
    // fresh code at once, in the same message; the old code still never counts. Nothing here waits on the
    // record keeper's consumed set: the recover line is how a degraded or unverified keeper gets well.
    let got: { msg: any; nonce: string; skew: number };
    try { got = await this.ownerLine(said, RECOVER_LINE, "recover-logs"); }
    catch (e) {
      if (!(e instanceof StaleLine)) throw e;
      const p = await offer(`Your recover line didn't count: ${e.cause}. Here is a fresh one. `);
      await this.tellPiClock();
      this.log(`recover-logs line on his message ${said} didn't count (${e.message}); he was told why and sent a fresh line "${p.line}" (record epoch ${p.epoch})`);
      return { status: "proposed", said: `His line didn't count (${e.cause}); he was told so and sent a fresh line "${p.line}". Once he sends it, run keeper.sh recover-logs --said <his message id>.` };
    }
    const { msg, nonce, skew } = got;
    const at = new Date(this.d.now()).toISOString();
    if (!this.d.landings?.ownerLine?.("recover", said, at)) throw new Refusal("the landing ledger couldn't take his line (or it was used already): nothing done");
    // Round 17: fsynced (written whole, then renamed, then its folder synced) before "ok" is answered.
    try { writeDurable(this.d.recoverFile, JSON.stringify({ said, nonce, at }) + "\n"); }
    catch (e) { throw new Refusal(`the recover file couldn't be written (${String(e).slice(0, 80)}): nothing done`); }
    this.log(`recover-logs accepted on the owner's message ${said} ("${excerpt(String(msg?.content ?? ""), 40)}"): the record keeper rebuilds its logs on its next round`);
    const off = await this.tellClockOff(skew, said);
    // Round 16: his recover line only clears the damaged-log state and runs the rebuild again: it never marks the
    // consumed set verified (only a fresh fetch does) and never turns install taps on.
    return { status: "ok", said: `The record keeper rebuilds its logs on its next round and goes on once the rebuild is checked against GitHub by a fresh fetch; taps stay held until then. You hear when it does.${off}` };
  }


  // Round 13: while the record keeper's consumed set is unverified (its status's consumed_unverified),
  // one notice to him per outage, once it lasted a round.
  // Round 14: and at once when the first tap is held (force), not only once a round has tried.
  private async unverifiedNotice(force = false): Promise<void> {
    const st = keeperStatus(this.files().status);
    const u = st?.consumed_unverified;
    if (!u || !(u.tries >= 1 || force || this.heldOpen().length > 0)) return;
    const s = this.d.load();
    if (s.unverifiedTold === u.since) return;
    try { await this.notice(KEEPER_UNVERIFIED); } catch (e) { this.log(`couldn't tell him the keeper's taps are unverified: ${String(e).slice(0, 80)}`); return; }
    const s2 = this.d.load();
    s2.unverifiedTold = u.since;
    this.d.save(s2);
    this.log(`told him the record keeper can't verify which taps were acted on yet (${u.why})`);
  }

  // Round 17: after a link restart the keeper's verified status names the old link run until a fresh fetch sees
  // the new one. While it hasn't (the remote away), once VERIFY_PENDING_MS has passed on the monotonic clock since
  // this process first saw it, each waiting card (a waiting line on it, or a held tap) gets one line saying so, and
  // Cain is told once per link run that verification for the new link run is pending.
  private verifyPendingSince: number | null = null;
  private async pendingVerify(): Promise<void> {
    const st = keeperStatus(this.files().status);
    const run = this.runNonce || (this.runNo(), this.runNonce);
    const pending = !!st && !st.consumed_unverified && !!st.start && !!st.verified && st.verified.start === st.start.nonce && st.verified.link !== run;
    if (!pending) { this.verifyPendingSince = null; return; }
    if (this.verifyPendingSince === null) this.verifyPendingSince = this.mono();
    if (this.mono() - this.verifyPendingSince < VERIFY_PENDING_MS) return;
    const s = this.d.load();
    const waiting = new Set<string>(Object.entries(s.messages).filter(([, m]) => !m.outcome && !!m.checking).map(([id]) => id));
    for (const h of this.heldOpen()) if (typeof h.msg === "string") waiting.add(h.msg);
    for (const msg of waiting) {
      const id = `${msg}:pending:${run}`;
      const s2 = this.d.load();
      if (s2.tapNoticed?.[id]) continue;
      (s2.tapNoticed ??= {})[id] = this.d.now();
      this.d.save(s2);
      try { await this.post(VERIFY_WAITING, [], { replyTo: msg }); } catch (e) { this.log(`couldn't put the waiting line on card ${msg}: ${String(e).slice(0, 80)}`); }
    }
    if (s.pendingTold !== run) {
      const s3 = this.d.load();
      s3.pendingTold = run;
      this.d.save(s3);
      this.d.relay(`Verification for the link's new run is pending: the App restarted over ${VERIFY_PENDING_MS / 60_000} minutes ago and the record keeper hasn't reached GitHub since to check which taps were already acted on, so taps wait (${waiting.size} waiting card${waiting.size === 1 ? "" : "s"}, each told on the card). It goes on by itself once a fetch answers. Nothing to tell him.`);
      this.log(`verification for link run ${run} still pending after ${VERIFY_PENDING_MS / 60_000} minutes: ${waiting.size} waiting card(s) told, Cain told`);
    }
  }

  // Round 12: one line on a card's thread saying a tap on it was lost to a restore of the link's state.
  private async tellRestoreLost(msgId: string, what: string): Promise<void> {
    const id = `${msgId}:lost`;
    const s = this.d.load();
    if (s.tapNoticed?.[id]) return;
    (s.tapNoticed ??= {})[id] = this.d.now();
    this.d.save(s);
    try { await this.post(TAP_RESTORE_LOST, [], { replyTo: msgId }); this.log(`told him a tap on ${what} was lost to a restore of the link's state`); }
    catch (e) { this.log(`couldn't tell him a tap on ${what} was lost: ${String(e).slice(0, 80)}`); }
    this.d.relay(`A tap of his on a card (Discord message ${msgId}) was lost: the link's state was restored from an older copy and no longer knows that card, so nothing was done from it. He was told on the card. Record nothing from it; once its item's re-check is accepted, ask again with --checked if it still needs him. Nothing more to tell him.`);
  }

  // Round 11: the record keeper's tap notices (its status's tap_notices): a request from his tap it
  // refused (its target didn't match), or one lost because this state was restored from an older copy.
  // Each is told to him once, on the card's thread; Cain already has the keeper's line with the reason.
  private async tapNotices(): Promise<void> {
    const st = keeperStatus(this.files().status);
    const list = Array.isArray((st as any)?.tap_notices) ? (st as any).tap_notices as { tap: string; why: string; msg?: string }[] : [];
    for (const n of list) {
      if (!n || typeof n.tap !== "string" || (n.why !== "refused" && n.why !== "lost" && n.why !== "expired" && n.why !== "time" && n.why !== "hold" && n.why !== "superseded" && n.why !== "unstamped")) continue;
      const id = `${n.tap}:${n.why}`;
      const s = this.d.load();
      if (s.tapNoticed?.[id]) continue;
      (s.tapNoticed ??= {})[id] = this.d.now();
      this.d.save(s);
      // Round 12: the card's message id from the keeper's notice, the state, or else the issued-key log.
      const msg = (typeof n.msg === "string" && /^\d{15,22}$/.test(n.msg) ? n.msg : undefined) ?? s.issued?.[n.tap]?.msg ?? this.issuedKid(n.tap)?.msg;
      const text = n.why === "lost" ? TAP_RESTORE_LOST : n.why === "expired" ? TAP_EXPIRED : n.why === "time" ? TAP_TIME_DISAGREE : n.why === "hold" ? TAP_HOLD_FLOOR : n.why === "superseded" ? TAP_SUPERSEDED : n.why === "unstamped" ? TAP_UNSTAMPED : TAP_REFUSED;
      try {
        if (msg) await this.post(text, [], { replyTo: msg }); else await this.notice(text);
        this.log(`told him the record keeper ${n.why === "lost" ? "lost" : n.why === "expired" ? "refused as expired" : n.why === "time" ? "refused (the clocks disagreed about his tap's time)" : n.why === "hold" ? "refused (its hold, across a restart, began after its card expired)" : n.why === "superseded" ? "refused (superseded: he was asked to answer again)" : "refused"} the request from tap key ${n.tap}`);
      } catch (e) { this.log(`couldn't tell him about tap key ${n.tap}: ${String(e).slice(0, 80)}`); }
    }
    const s = this.d.load();
    let pruned = false;
    for (const [k, at] of Object.entries(s.tapNoticed ?? {})) if (this.d.now() - at > TAP_ISSUED_KEEP_MS * 2) { delete s.tapNoticed![k]; pruned = true; }
    for (const [k, v] of Object.entries(s.settleSaid ?? {})) if (this.d.now() - v.at > SETTLE_SAID_KEEP_MS) { delete s.settleSaid![k]; pruned = true; }
    if (pruned) this.d.save(s);
  }

  // The keeper's reset epoch as read now (round 10): its number, "reset" while a reset stands, or
  // "unknown" when its status can't be read. Compared before and after a landing's claim.
  private epochMark(): number | "reset" | "unknown" {
    const st = keeperStatus(this.files().status);
    if (!st) return "unknown";
    if (st.reset) return "reset";
    return st.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0;
  }
  private resetSinceTap(m: Shown): boolean {
    const st = keeperStatus(this.files().status);
    if (!st) return false;
    if (st.reset) return true;
    const cur = st.epoch && Number.isInteger(st.epoch.n) ? st.epoch.n : 0;
    return m.checked?.epoch !== undefined && m.checked.epoch !== cur;
  }
  // A Ship tap a reset beat to the start of its landing: nothing pushed, the tap lost as any tap
  // whose check didn't survive a reset (lostTap: one line on the thread, one to Cain, the re-check
  // queue), and the card settled as not landed.
  private async loseShipTap(msgId: string): Promise<void> {
    const s = this.d.load();
    const m = s.messages[msgId];
    if (!m?.ship || m.shipping?.state !== "landing") return;
    const key = m.shipping.key, words = m.shipping.text;
    m.shipping = { state: "not landed", at: this.d.now(), text: words, why: "the record was reset before it landed", line: EPOCH_CHANGED, edited: false, ...(key ? { key } : {}) };
    m.digest = digest(withLine(words, EPOCH_CHANGED), []);
    this.d.save(s);
    this.log(`his Ship tap on card ${msgId} was beaten by a reset of the record before its landing started: nothing pushed`);
    await this.lostTap({ key, msg: msgId, label: "Ship", item: m.item ?? "none", acted: false });
    await this.showLanding(msgId);
  }

  // How his Ship tap went: on its card, and to Cain once. In main, it's signed for the
  // install, unless a Stop came since his tap (then a new tap installs it). While GitHub
  // doesn't answer, or its checks are still running, it's tried again (the sweep), for
  // up to 2 hours after his tap, and his card says what it waits on.
  private async settleLanding(msgId: string, r: Landed): Promise<void> {
    const s = this.d.load();
    const m = s.messages[msgId];
    if (!m?.ship || m.shipping?.state !== "landing") return;
    const now = this.d.now();
    const tapped = m.shipping.at;
    const words = m.shipping.text;
    const key = m.shipping.key;
    const tap = this.tapLine(m, "Ship", msgId) + (m.shipping.key ? ` Tap key ${tapKid(m.shipping.key)}.` : "");
    if (!r.ok && (r.stopped || this.voided(tapped))) r = STOPPED_FIRST;   // a Stop since his tap ends it, even one undone since
    // Its lines on his card are the link's own words, fixed (a reason can come from GitHub).
    const own = (t: string) => this.words("ship line", "link", t, { rules: AT.link }).text;
    if (!r.ok && r.again && now - tapped < LANDING_TRY_MS) {
      const tries = (m.shipping.tries ?? 0) + 1;
      const waiting = own(`You tapped Ship. Waiting: ${r.why}. It lands by itself as soon as it can.`);
      const changed = m.shipping.line !== waiting;
      m.shipping = { ...m.shipping, tries, next: now + Math.min(15, 2 ** tries) * 60_000, why: r.why,
        ...(changed ? { line: waiting, edited: false } : {}) };
      m.digest = digest(withLine(words, waiting), []);
      this.d.save(s);
      this.log(`his Ship tap is waiting (${r.why}); trying again`);
      if (tries === 1)
        this.d.relay(`${tap} It can't land yet (${r.why}), so the link keeps trying for up to 2 hours and lands it by itself; you'll hear when it settles. Nothing to tell him: his card says so.`);
      if (changed) await this.showLanding(msgId);
      return;
    }
    let shown: string, line: string;
    if (r.ok) {
      const stopped = this.stopped().stopped, voided = this.voided(tapped), late = now - tapped >= LANDING_TRY_MS;
      const token = voided || late ? null : this.signFor(m.ship);
      const unclaimed = (r as any).unclaimed === true;
      shown = `${unclaimed ? `Already in main as of ${clockTime(now, this.d.tz)}, so nothing was pushed.` : `Shipped: it's in main as of ${clockTime(now, this.d.tz)}.`} ${stopped ? "Installing it waits until you turn things back on."
        : voided ? "Installing it needs your tap again, since you tapped Stop meanwhile."
        : late ? "Installing it needs your tap again, since your tap is over 2 hours old."
        : token ? "Installing it is next." : "Installing it is down right now, so it isn't installed yet."}`;
      line = (unclaimed
        ? `${tap} It is already in main: main had that commit when his tap came (it was there already), so the link claimed no landing and pushed nothing. Landed means the commit is in main, not that this tap put it there.`
        : `${tap} The link landed it: main has that commit now${r.already ? " (it was there already)" : ""}.`) + (voided || late
        ? ` There's no Ship token, ${voided ? "since he tapped Stop after his Ship tap" : "since his tap is over 2 hours old"}, so it isn't installed: ${stopped ? "once he taps Turn back on, " : ""}show a new Ship card for the same pull request and head, and his tap on it gives the token to install it.`
        : token
          ? ` Ship token: ${token} (good for 2 hours): start the Ship job now to install it, with that token in its text as it is.`
          : " The link has no Ship key, so there's no Ship token and the install run will be refused: tell him in one line that it's in main but installing is down, and log a Build item.");
      m.shipping = { state: "landed", at: now, text: words, line: shown, edited: false };
    } else if (r.stopped) {
      shown = "You tapped Ship, but Stop came before it landed, so nothing shipped.";
      line = `${tap} The link didn't land it: his Stop came first. Nothing changed in main, and there's no Ship token. Once nothing is stopped, ask again with a new Ship card.`;
      m.shipping = { state: "not landed", at: now, text: words, why: r.why, line: shown, edited: false };
    } else {
      const waited = r.again ? ", for 2 hours" : "";
      shown = own(`Not shipped: ${r.why}${waited}. Nothing changed in main.`);
      line = `${tap} The link didn't land it: ${r.why}${waited}. Nothing changed in main, and there's no Ship token. Tell him in one line, as a reply to the card, what happens next.`;
      m.shipping = { state: "not landed", at: now, text: words, why: r.why, line: shown, edited: false };
    }
    const abandoned = !r.ok && (r as any).abandoned === true;
    if (abandoned) {
      m.shipping!.abandoned = true;
      line = `Landing abandoned: ${tap} The landing was cut off by a restart and main doesn't have that commit, so it did not land and isn't started again. Nothing changed in main, and there's no Ship token. He was told on the card that a new card follows: check Home Assistant first, then show a new Ship card for the same pull request and head (${m.ship.pr} at ${m.ship.head}), with --checked.`;
    }
    m.digest = digest(withLine(words, shown), []);
    if (key) m.shipping!.key = key;
    this.d.save(s);
    if (key && this.d.landings && !(r.ok && (r as any).unclaimed === true)) this.d.landings.settle(key, r.ok ? "landed" : "not landed", new Date(now).toISOString());
    this.d.relay(line);
    this.log(r.ok ? `his Ship tap landed ${m.ship.pr} in main` : abandoned ? `his Ship tap's landing of ${m.ship.pr} was abandoned after a restart` : `his Ship tap didn't land ${m.ship.pr}: ${r.why}`);
    if (abandoned)
      try { await this.post(ABANDONED_TAP, [], { replyTo: msgId }); }
      catch (e) { this.log(`couldn't tell him on card ${msgId}'s thread that the landing was abandoned: ${String(e).slice(0, 80)}`); }
    await this.showLanding(msgId);
  }

  // His card as the landing last left it, with no buttons. Edited with the bot's own key,
  // so it works long after his tap; one that didn't take is edited again by the sweep.
  private async showLanding(msgId: string): Promise<void> {
    const sh = this.d.load().messages[msgId]?.shipping;
    if (!sh?.line) return;
    let done = false;
    try {
      const { dm } = await this.identity();
      await this.rest("PATCH", `/channels/${dm}/messages/${msgId}`,
        { content: withLine(sh.text, sh.line), components: [], allowed_mentions: { parse: [] } });
      done = true;
    } catch (e) {
      if (/discord 404/.test(String(e))) done = true;   // the message is gone: nothing left to edit
      else this.log(`couldn't show on his Ship card how it's going: ${String(e).slice(0, 80)}`);
    }
    if (!done) return;
    const s = this.d.load();
    const m = s.messages[msgId];
    if (m?.shipping?.line === sh.line) { m.shipping.edited = true; if (m.buttons) m.off = this.d.now(); m.buttons = false; this.d.save(s); }
  }

  // Landings due another try: one that can't land yet, and one the link was cut off from
  // (a restart). Each try starts by reading main, so one that landed is settled as landed.
  // A Stop since his tap ends it. Over 2 hours after his tap nothing is pushed any more:
  // main alone says whether it landed. The tries go in line and the sweep doesn't wait
  // for them, so other cards keep moving while GitHub is slow.
  private async retryLandings(): Promise<void> {
    const now = this.d.now();
    for (const [id, m] of Object.entries(this.d.load().messages)) {
      const sh = m.shipping;
      if (!sh || !m.ship || this.landingNow.has(id)) continue;
      if (sh.edited === false && now - sh.at < DAY) await this.showLanding(id);
      if (sh.state !== "landing") continue;
      if (this.voided(sh.at)) { await this.settleLanding(id, STOPPED_FIRST); continue; }
      if ((sh.next ?? sh.at + LANDING_STALE_MS) > now) continue;
      // Past 2 hours, main alone settles it, from the landing's base, on the unresolved backoff.
      if (now - sh.at >= LANDING_TRY_MS) {
        void this.lateSettle(id);
        continue;
      }
      if (!this.d.land) { await this.settleLanding(id, { ok: false, why: "the link has no deploy key now", again: false }); continue; }
      void this.landShip(id);
    }
  }

  // An abandoned key (an orphaned landing the remote couldn't settle) is settled against the remote
  // before anything else, each sweep, once it is due on its backoff (round 10): a landed result posts
  // the landed outcome (the Ship token line to Cain, the card's landed words), and only a definite
  // did-not-land lets a new card for that pull request and head go out.
  private async settleAbandoned(): Promise<void> {
    const s = this.d.load();
    for (const [id, m] of Object.entries(s.messages)) {
      const key = m.shipping?.state === "landing" ? m.shipping.key : undefined;
      if (!key || !m.ship || s.unresolved?.[key]?.what !== "orphan" || this.landingNow.has(id) || !this.unresolvedDue(key)) continue;
      if (this.voided(m.shipping!.at)) continue;                     // retryLandings settles a stopped one
      if (this.d.now() - m.shipping!.at >= LANDING_TRY_MS) await this.lateSettle(id);
      else await this.landShip(id);
    }
  }

  // Past 2 hours, main alone settles a landing, from its base, on the unresolved backoff.
  private lateSettle(id: string): Promise<void> {
    return this.queue(id, async () => {
      const m = this.d.load().messages[id];
      const sh = m?.shipping;
      if (!m?.ship || sh?.state !== "landing") return;
      const ship = m.ship, why = sh.why, key = sh.key, base = sh.base;
      const r = await this.remote(ship, base);
      if (r.v === true) { if (key) this.unresolvedClear(key); await this.settleLanding(id, { ok: true, already: true }); }
      else if (r.v === false) { if (key) this.unresolvedClear(key); await this.settleLanding(id, { ok: false, why: `it couldn't land within 2 hours of the tap${why ? `: ${why}` : ""}`, again: false }); }
      else if (key) {                            // can't tell: looked for again on the backoff
        const next = await this.unresolvedFail(key, r.why, "orphan", id);
        const s1 = this.d.load();
        if (s1.messages[id]?.shipping?.state === "landing") { s1.messages[id].shipping!.next = next; this.d.save(s1); }
      }
    });
  }

  // His Stop ends every landing still waiting; one under way checks again right before
  // its push, and says whether it landed first.
  private async cancelLandings(): Promise<void> {
    for (const [id, m] of Object.entries(this.d.load().messages))
      if (m.shipping?.state === "landing" && !this.landingNow.has(id)) await this.settleLanding(id, STOPPED_FIRST);
  }

  // Once a day: does GitHub still know the link's deploy key? A key added with an OAuth
  // app's token goes when that token is revoked, and then no Ship tap can land. Cain
  // hears it once, with what fixes it, and again once it's back. No answer is asked
  // again in an hour; two days of none, and Cain hears that too.
  private async checkKey(): Promise<void> {
    if (!this.d.keyKnown) return;
    const now = this.d.now();
    const s = this.d.load();
    if (!s.key) { s.key = { checked: now }; this.d.save(s); return; }   // the first look is a day after the key is in use
    if (s.key.checked + KEY_CHECK_MS > now) return;
    const said = await this.d.keyKnown().catch(() => null);
    const s2 = this.d.load();
    const k = s2.key ?? { checked: now };
    if (said === null) {
      const since = k.unanswered ?? now;
      const tell = now - since >= 2 * DAY && !k.toldUnanswered;
      s2.key = { ...k, checked: now - KEY_CHECK_MS + HOUR, unanswered: since, ...(tell ? { toldUnanswered: true } : {}) };
      this.d.save(s2);
      if (tell) this.d.relay("The link hasn't reached GitHub over SSH for 2 days (port 22 blocked, or GitHub down), so his Ship taps may not land. Nothing for him to do yet; if it's still so tomorrow, tell him in one line and keep it in PENDING.");
      return;
    }
    const bad = said !== "known", was = k.refused === true;
    s2.key = { checked: now, refused: bad };
    this.d.save(s2);
    if (bad && !was) {
      this.log(said === "host key" ? "GitHub's SSH host key isn't one the link knows" : "GitHub doesn't know the deploy key any more");
      this.d.relay(said === "host key"
        ? "GitHub's SSH host key isn't one the link knows (a change on GitHub's side, or something in between), so the link won't land anything there. A laptop session checks GitHub's published keys and updates the pinned ones in a new release. Tell him in one line that shipping is down until then."
        : "GitHub no longer knows the link's deploy key, so his Ship taps can't land anything in main. A laptop session at his PC adds it again (its public half is in the add-on's log; RELEASING.md, If the deploy key is remade). Tell him in one line that shipping is down until then, and keep it in PENDING marked \"At his PC\".");
    } else if (!bad && was) {
      this.d.relay("GitHub knows the link's deploy key again: his Ship taps land again. Nothing to tell him unless he's waiting on it.");
    }
  }

  async followup(callback: string, text: string): Promise<void> {
    const [app, token] = [callback.split(":")[0], callback.split(":").slice(1).join(":")];
    if (!app || !token || !text) return;
    const words = this.ownWords("answer", "specialist", text);
    await this.rest("POST", `/webhooks/${app}/${token}`,
      { content: fit(words), flags: EPHEMERAL, allowed_mentions: { parse: [] } }, false);
  }

  // -- the replay (keeper.sh replay): the gate's rules over his DM, reading only ---------
  // Pages back through his DM to the start of the range (at most REPLAY_PAGES pages: past
  // that the oldest part isn't read, and it says so), reads every bot message, says
  // whose words it carries from the link's own records and Cain's transcripts (one bot
  // token posts them all, so Discord can't tell), and runs the rules in report mode.
  // Nothing is posted, edited or logged as a send. Cain hears one line when it's done.
  private replaying: Promise<void> | null = null;

  // why "rules": the link's own run after the rules changed (RULES_VERSION): its done line
  // also has Cain check the gate end to end.
  replay(daysIn?: unknown, why?: "rules"): { status: "started" | "running"; said: string } {
    if (this.replaying) return { status: "running", said: "A replay is already running; you'll hear one line when it's done." };
    const n = Number(daysIn ?? 14);
    const days = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 60) : 14;
    this.replaying = this.runReplay(days, why)
      .catch((e) => {
        this.log(`the gate's replay failed: ${reason(e)}`);
        this.d.relay(`The gate's replay over his DM failed (${reason(e)}). Nothing was posted or changed; run /opt/cain/keeper.sh replay again later. Nothing to tell him.`);
      })
      .finally(() => { this.replaying = null; });
    return { status: "started", said: `Reading the last ${days} days of his DM against the gate's rules. Nothing is posted or changed. You'll hear one line when it's done.` };
  }

  whenReplayed(): Promise<void> { return this.replaying ?? Promise.resolve(); }

  // Whether the gate's rules changed since the last replay that finished (the link's start
  // runs one by itself then). A replay from before 0.10.0 ran with version 1.
  replayDue(): boolean {
    const s = this.d.load();
    return (s.replayedRules ?? (s.replayed ? 1 : 0)) < RULES_VERSION;
  }

  private async runReplay(days: number, why?: "rules"): Promise<void> {
    // The first replay to finish after the rules changed asks for the end-to-end checks,
    // whoever started it (the link's own run may have been cut short).
    const rulesRun = why === "rules" || this.replayDue();
    const { owner, dm, bot } = await this.identity();
    const now = this.d.now();
    const from = now - days * DAY;
    const pause = this.d.replayPauseMs ?? 1000;
    const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
    const seen: any[] = [];
    let before = "", pages = 0, reached = false, capped = false, stopped: string | null = null;
    while (!reached) {
      // Its most pages, the start of the range still further back: a rerun would stop at the
      // same place, so this is how far it reads, not a stop.
      if (pages >= REPLAY_PAGES) { capped = true; break; }
      let batch: any = null;
      for (let tries = 1; ; tries++) {
        try { batch = await this.rest("GET", `/channels/${dm}/messages?limit=100${before ? `&before=${before}` : ""}`); break; }
        catch (e) {
          if (!/discord 429/.test(String(e)) || tries >= REPLAY_TRIES) { stopped = `${plainly(e)} (${reason(e)})`; break; }
          await sleep(Math.max(pause, 1) * 5);                 // rate limited: wait it out, then the same page again
        }
      }
      if (stopped) break;
      pages++;
      if (!Array.isArray(batch) || !batch.length) { reached = true; break; }
      for (const m of batch) {
        if (snowflakeTime(String(m?.id ?? "")) < from) { reached = true; continue; }
        seen.push(m);
      }
      before = String(batch[batch.length - 1].id);
      if (batch.length < 100) reached = true;
      if (!reached) await sleep(pause);
    }

    const s = this.d.load();
    let sent: Sent = { ids: new Set<string>(), texts: new Set<string>() };
    try { if (this.d.transcripts) sent = await this.d.transcripts(from); }
    catch (e) { this.log(`the replay couldn't read Cain's transcripts: ${reason(e)}`); }
    const byId = new Map(seen.map((m) => [String(m.id), m]));
    const allLabels = [...new Set(Object.values(s.messages).flatMap((m) => m.labels ?? []))];
    const byWriter: Record<string, number> = { cain: 0, specialist: 0, link: 0, unknown: 0 };
    const skipped: Record<string, number> = { his: 0, permission_prompts: 0, others: 0 };
    const empty = (): Record<string, number> => ({ fix: 0, refuse: 0, unsure: 0, kept: 0 });
    // The shared rules, and (0.11.0) the reviewed rule on Cain's own words (../gate/cain.ts).
    const rules = [...RULES, "reviewed"];
    const byRule: Tally = Object.fromEntries(rules.map((r) => [r, empty()]));
    const perWriter: Record<string, Tally> = {};
    const list: ReplayReport["list"] = [];
    let published: Reviewed[] | null | undefined;              // read once, when a Reviewed line first needs it
    const judge = (message: string, at: number, writer: string, text: string, ctx: Context) => {
      const hits: { rule: string; result: string; around: string; label?: string; kept?: string }[] = [...gateCheck(text, ctx).hits];
      if (ctx.refusable && claimsReview(text)) hits.push(...reviewedHits(text, published === undefined ? (published = this.published()) : published));
      for (const h of hits) {
        list.push({ at, message, writer, rule: h.rule, result: h.result, around: h.around, ...(h.label ? { label: h.label } : {}), ...(h.kept ? { kept: h.kept } : {}) });
        const did = h.kept ? "kept" : h.result;     // a dash kept as it is, flagged, is never refused
        byRule[h.rule][did]++;
        const w = perWriter[writer] ??= Object.fromEntries(rules.map((r) => [r, empty()]));
        w[h.rule][did]++;
      }
    };
    for (const m of seen) {
      const id = String(m.id), at = snowflakeTime(id), author = String(m?.author?.id ?? "");
      if (author === owner) { skipped.his++; continue; }
      if (author !== bot) { skipped.others++; continue; }
      if (buttonIds(m.components).some((x) => x.startsWith("perm:"))) { skipped.permission_prompts++; continue; }
      const content = withoutOutcome(String(m.content ?? ""));
      const rec = s.messages[id];
      if (rec && rec.kind !== "plain") {                   // the link posted it: its own record says whose words
        // Its buttons as posted; unknown labels (a card from before 0.9.0 whose rows are
        // gone) with none on Discord now can't be told, never "no buttons".
        const now_ = labelsOf(m.components);
        const own = rec.labels ?? (now_.length ? now_ : null);
        if (!rec.kind || rec.kind === "legacy") {          // from before 0.7.0: whose words isn't known
          byWriter.unknown++;
          judge(id, at, "unknown", content, { rules: AT.cain, buttons: own, known: allLabels, refusable: true });
          continue;
        }
        const writer = writerOf(rec);
        byWriter[writer]++;
        const card = rec.card !== undefined ? s.cards[String(rec.card)] : undefined;
        if (writer === "specialist") {
          // A Stop notice's last line is the link's own, saying what stopped on Cain's side.
          const [words, linkLine] = splitLinkLine(card?.text ?? content);
          judge(id, at, writer, words, { rules: AT.card, buttons: own, known: allLabels });
          if (linkLine) judge(id, at, "link", linkLine, { rules: AT.link });
        } else if (writer === "cain") {
          // On a Ship card the link built (0.11.0), only his line is his words: the rest is the link's.
          const words = rec.kind === "ship" && rec.own !== undefined ? rec.own : rec.shipping?.text ?? content;
          judge(id, at, writer, words, { rules: AT.cain, buttons: own, known: allLabels, refusable: true });
        } else judge(id, at, writer, content, { rules: AT.link });
        continue;
      }
      const raw = String(m.content ?? "");
      // Cain's reply: by the link's own list of them (one that held the moving Stop among
      // them), or by his transcripts.
      if (rec?.kind === "plain" || s.sent?.[id] || sent.ids.has(id) || sent.texts.has(raw.trim())) {
        byWriter.cain++;
        const ref = m.message_reference?.message_id ? String(m.message_reference.message_id) : "";
        let buttons: string[] | null = [], answersHim = false;
        if (ref) {
          const target = s.messages[ref], there = byId.get(ref);
          // Unknown labels stay unknown; known ones count only while they were up.
          if (target) buttons = target.labels === undefined ? null : target.off != null && target.off <= at ? [] : target.labels;
          else if (there && String(there.author?.id ?? "") === owner) answersHim = true;
          else if (there) buttons = labelsOf(there.components);
          else buttons = null;                             // can't tell what it answered
        }
        judge(id, at, "cain", raw, { rules: AT.cain, buttons, known: allLabels, answersHim, refusable: true });
        continue;
      }
      byWriter.unknown++;
      judge(id, at, "unknown", content, { rules: AT.cain, buttons: labelsOf(m.components), known: allLabels, refusable: true });
    }
    // The specialist's cards from the same days that never went out, as the link received them.
    let unposted = 0;
    for (const [k, c] of Object.entries(s.cards)) {
      if (c.shown || c.created < from) continue;
      unposted++;
      const [words, linkLine] = splitLinkLine(c.text);
      judge(`card ${k}`, c.created, "specialist", words, { rules: AT.card, buttons: labelsOf(c.rows), known: allLabels });
      if (linkLine) judge(`card ${k}`, c.created, "link", linkLine, { rules: AT.link });
    }
    // Whether Discord marks a message "(edited)" when only its buttons change: every edit
    // the link makes to a morning message is to its buttons alone (its Stop moves or comes off).
    let mornings = 0, changed = 0, marked = 0;
    for (const m of seen) {
      if (s.messages[String(m.id)]?.kind !== "morning") continue;
      mornings++;
      const edited = !!m.edited_timestamp;
      if (edited || !labelsOf(m.components).length) changed++;   // its Stop came off (or moved): an edit of buttons alone
      if (edited) marked++;
    }
    const marks = changed ? marked > 0 : null;
    const total = list.length;
    const n = (r: "fix" | "refuse" | "unsure" | "kept") => list.filter((h) => (h.kept ? "kept" : h.result) === r).length;
    const report: ReplayReport = {
      written_at: now,
      rules_version: RULES_VERSION,
      range: { from, to: now, days, pages, page_cap: REPLAY_PAGES, reached_cutoff: reached, capped, stopped },
      messages: { read: seen.length, by_writer: byWriter, skipped, cards_never_posted: unposted },
      hits: { by_rule: byRule, by_writer: perWriter, total },
      list,
      edited: { morning_messages: mornings, buttons_changed: changed, marked_edited: marked, buttons_only_edits_marked: marks,
        said: marks === null ? "No morning message in range has had its buttons changed, so this can't tell yet."
          : marks ? `Yes: ${marked} of ${changed} morning messages whose buttons alone changed show "(edited)".`
          : `No: none of ${changed} morning messages whose buttons alone changed shows "(edited)".` },
    };
    let where = "";
    try { where = this.d.writeReplay ? String(this.d.writeReplay(report) ?? "") : ""; }
    catch (e) { throw new Error(`its report couldn't be written: ${reason(e)}`); }
    // Done once it read back to the start of the range, or read its most pages (a rerun would
    // stop at the same place, so it says the oldest part wasn't read instead). One an error or
    // rate limits stopped is run again (the link's own run retries at its next start).
    const whole = (reached || capped) && !stopped;
    let holder = "";
    if (whole) {
      const s2 = this.d.load();
      s2.replayed = this.d.now();
      s2.replayedRules = RULES_VERSION;
      holder = s2.stopAt && this.carries(s2, s2.stopAt, "Stop") ? s2.stopAt : "";
      this.d.save(s2);
    }
    // After the rules changed, Cain checks the gate end to end once, by himself.
    const after = rulesRun && whole
      ? ` The message gate's rules changed (version ${RULES_VERSION}) and it holds things back now, so once it's filed, check it end to end, telling him nothing: `
        + "run /opt/cain/keeper.sh selftest (it should say ok); run /opt/cain/keeper.sh check --reply-to <a live card's message id> with a made-up text "
        + "that taps a button that card doesn't have (it should say refuse); and run /opt/cain/keeper.sh card on "
        + `${holder ? `Discord message ${holder}, which carries Stop now` : "the newest message carrying Stop"} (it should list Stop). File what each said with the replay.`
      : "";
    this.log(`the gate's replay read ${seen.length} messages over ${pages} pages: ${total} hits`
      + `${!whole ? " (cut short)" : capped ? " (its most pages: the oldest part of the range wasn't read)" : ""}`);
    const counts = `${seen.length} messages read (Cain ${byWriter.cain}, the specialist ${byWriter.specialist}, the link ${byWriter.link}, `
      + `unknown ${byWriter.unknown}). ${total} hits: ${n("refuse")} would be refused, ${n("fix")} fixed, ${n("kept")} kept as they are and flagged `
      + `(em dashes in words that are never refused), ${n("unsure")} can't tell.`;
    const cap = capped ? `It read its most, ${REPLAY_PAGES} pages of 100 messages, so the oldest part of the range wasn't read; a rerun would stop at the same place. ` : "";
    this.d.relay(whole
      ? `The gate's replay over the last ${days} days of his DM is done: ${counts} ${cap}Buttons-only edits and "(edited)": ${report.edited.said} `
        + `Nothing was posted or changed. Read ${where || "the replay's report"} and file it in the record as your CLAUDE.md says (Gate replay)`
        + `${capped ? ", saying the oldest part of the range wasn't read" : ""}.${after} Nothing to tell him.`
      : `The gate's replay over the last ${days} days of his DM stopped before it was done: ${stopped ?? "it didn't reach the start of the range"}. `
        + `So far ${counts} Nothing was posted or changed, and it isn't done: run /opt/cain/keeper.sh replay ${days} again in an hour, and file `
        + `the report once a replay finishes. Nothing to tell him.`);
  }

  // -- reactions ----------------------------------------------------------------
  async onReaction(r: any): Promise<string> {
    if (r?.guild_id) return "ignored";
    const { owner, dm, bot } = await this.identity();
    if (String(r.user_id) !== owner || String(r.channel_id) !== dm) return "ignored";
    const msg = await this.rest("GET", `/channels/${dm}/messages/${r.message_id}`);
    if (String(msg?.author?.id ?? "") !== bot) return "ignored";   // his own message
    const emoji = String(r.emoji?.name ?? "?").slice(0, 32);
    const m = this.d.load().messages[String(r.message_id)];
    const what = about(m?.item, m?.question);
    this.d.relay(`Dane reacted ${emoji} to your message${what ? ` (${what})` : ""}: "${excerpt(msg.content ?? "")}" (Discord message ${r.message_id})`);
    return "to Cain";
  }

  // -- the sweep: every minute, and at start ---------------------------------------
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // A link state that doesn't read: nothing else is written from a state that isn't there until
      // it is healed (two failed reads in a row) and reads again.
      if (!(await this.healState())) return;
      if (!this.d.load().migrated) {
        try { await this.migrate(); } catch (e) { this.log(`couldn't look over the cards already posted yet: ${String(e).slice(0, 80)}`); }
      }
      this.backfillLabels();
      this.runNo();
      if (!this.started) await (this.started = this.markStart());
      await this.verifyObserved();
      await this.recoverIssuance();
      await this.retryStrips();
      await this.restoreSweep();
      await this.settleAbandoned();
      await this.finishHandSettles();
      await this.unresolvedChores();
      await this.tapNotices();
      await this.sendOwedToggle();
      await this.ledgerUpkeep();
      await this.retryLandings();
      await this.finishTaps();
      await this.uncertainTaps();
      await this.outageNotice();
      await this.unverifiedNotice();
      await this.pendingVerify();
      await this.releaseHeldTaps();
      await this.replayWatch();
      await this.clearChecking();
      await this.checkKey();
      await this.showDue();
      await this.decide();
      await this.stripDue();
      await this.expireByLog();
      await this.releaseHeld();
      await this.inStopQueue(() => this.placeStop());   // last: moves are the lowest priority
    } finally { this.sweeping = false; }
  }

  // Roll-forward (round 9): each start of this version raises the run counter in the state by one,
  // durably, before it acts on anything, and each claim records the run it was made in. A claim from
  // an earlier run (this version before a restart, or a previous version's state in between) is
  // completed only through the live-tap predicate (claimLive) or discarded and told (notActedTap):
  // never judged by file times or save stamps, so a clock step either way changes nothing.
  // Round 10: each start also makes a random nonce, saved with the counter, and claims compare on the
  // nonce alone: a state file restored to an older counter can make this run's number equal an
  // outstanding claim's, but never its nonce.
  private runN = 0;
  private runNonce = "";
  private runNo(): number {
    if (this.runN) return this.runN;
    const s = this.d.load();
    // Round 18: the run number is one above both the state's and the issued-key log's highest run record (the log is
    // outside the restorable state), and the nonce is fresh randomness: a state restored from a backup can't reuse a
    // run, nor the nonce the keeper's verified status names, so its waiting cards stay unarmed until a new verification.
    let logged = 0;
    if (this.d.issuedLog && existsSync(this.d.issuedLog)) {
      try { for (const r of readLog<any>(this.d.issuedLog, { repair: false }).records) if (r?.t === "run" && Number.isInteger(r.run) && r.run > logged) logged = r.run; }
      catch { /* a log that can't be read: the state's count */ }
    }
    s.run = Math.max(Number.isInteger(s.run) ? s.run! : 0, logged) + 1;
    s.runNonce = randomBytes(8).toString("hex");
    this.runN = s.run;
    this.runNonce = s.runNonce;
    // Round 12: the counter and nonce are fsynced in the state before anything is issued or sent under
    // this run, then logged in the issued-key log, so a start the process didn't survive is a gap in the
    // runs (a restart), never a run number used twice (a restore's sign).
    (this.d.saveDurable ?? this.d.save)(s);
    this.repairLogs();
    if (this.d.issuedLog) {
      try { appendLog(this.d.issuedLog, { t: "run", run: s.run, nonce: s.runNonce, at: this.d.now() }); }
      catch (e) { this.log(`couldn't log run ${s.run} in the issued-key log: ${String(e).slice(0, 80)}`); }
    }
    this.log(`link run ${this.runN} started: claims from earlier runs are judged by the live-tap predicate`);
    return this.runN;
  }

  // Round 12: at start, each append-only log of the link's (its issued keys, the landing ledger's hand
  // settles) has a torn final record (a write a power cut cut short) truncated off, with one logged line
  // and one line to Cain.
  private repairLogs(): void {
    const torn: string[] = [];
    if (this.d.issuedLog) {
      try { const r = readLog(this.d.issuedLog); if (r.torn) torn.push(`the issued-key log (${r.tornBytes} bytes)`); }
      catch (e) { this.log(`couldn't read the issued-key log: ${String(e).slice(0, 80)}`); }
    }
    try { const r = this.d.landings?.repair?.(); if (r?.torn) torn.push(`the landing ledger's settle log (${r.bytes} bytes)`); }
    catch (e) { this.log(`couldn't read the landing ledger's settle log: ${String(e).slice(0, 80)}`); }
    for (const w of torn) {
      this.log(`TORN: a torn final record in ${w} was truncated at start; the records before it stand`);
      this.d.relay(`The link found a torn final record in ${w} at start (a write cut short, as by a power cut) and truncated it; every record before it stands. Nothing to tell him.`);
    }
  }

  // Round 13: a card with buttons goes up in this order, so no tap on it can count before its keys and
  // its record are durable: posted without buttons; its keys (one per button, with its custom id, target,
  // expiry and the message id Discord returned) appended and fsynced to the issued-key log; the link's
  // state saved; only then its buttons edited on (and an "armed" record logged). A log write that fails:
  // the card never gets buttons and says so (unissuable). A state save that fails after the keys were
  // logged: a void record is logged and the card withdrawn (voidCard). A button edit that fails: retried
  // from the log at the next start, and he is told on the card. Without an issued-key log (some tests'
  // rigs) the card goes up with its buttons at once, as before.
  private async issueCard(text: string, comps: any[], opts: { replyTo?: string; nonce: string },
      meta: { checked?: Ref; item?: string; kind: string; expires?: number }, options: string[], record: (s: State, msg: any) => string[]): Promise<any> {
    if (!this.d.issuedLog) {
      const msg = await this.postCard(text, comps, opts);
      const s = this.d.load();
      const replaced = record(s, msg);
      this.d.save(s);
      await this.stripAll(replaced);
      return msg;
    }
    // Round 17: the card's lifetime, an explicit duration fixed here once, goes into its key records: its expiry
    // is its post snowflake plus that duration, never a difference of two readings of the Pi's clock.
    const life = typeof meta.expires === "number" ? Math.max(0, meta.expires - this.d.now()) : undefined;
    const msg = await this.postCard(text, [], opts);
    const id = String(msg.id);
    // Round 18: a check that carried no anchor of its own is measured from this card's post snowflake.
    if (meta.checked && !meta.checked.sf && /^\d{15,22}$/.test(id)) meta.checked.sf = id;
    this.d.crashPoint?.("issue:after-post");
    const cids: string[] = comps.flatMap((r: any) => (r.components ?? []).map((b: any) => String(b.custom_id)));
    try { this.issueKeys(id, meta as any, options, cids, meta.expires, life); } catch (x) { await this.unissuable(id, x, String(msg.content ?? text)); }
    this.d.crashPoint?.("issue:after-log");
    let replaced: string[] = [];
    try {
      const s = this.d.load();
      replaced = record(s, { ...msg, components: comps });
      this.d.save(s, true);
    } catch (x) { await this.voidCard(id, x, String(msg.content ?? text)); }
    this.d.crashPoint?.("issue:after-save");
    await this.armCard(id, comps, false);
    await this.stripAll(replaced);
    return { ...msg, components: comps };
  }

  // Round 12: the tap keys a card offers (one per button), its structured target and its message id,
  // appended to the issued-key log and fsynced before the card's record is saved, so no tap on it can
  // count before its key is durable. Throws when they can't be written. Round 13: with each button's
  // custom id and the card's expiry, so its buttons can be put on, or taken off at expiry, from the log.
  private issueKeys(msgId: string, m: Pick<Shown, "checked" | "item" | "kind">, options: string[], cids?: string[], exp?: number, life?: number): void {
    if (!this.d.issuedLog) return;
    const run = this.runNo();
    options.forEach((label, i) => {
      const key = [msgId, m.checked?.gen ?? "none", m.checked?.req ?? "none", (m.item ?? "none").toUpperCase(), label].join("|");
      const item = (m.item ?? "none").toUpperCase(), kind = m.kind ?? "ask";
      appendLog(this.d.issuedLog!, { t: "key", kid: tapKid(key), item, kind, label, msg: msgId, target: tapTarget(item, kind, label), run, nonce: this.runNonce, at: this.d.now(),
        ...(cids?.[i] ? { cid: cids[i] } : {}), ...(typeof exp === "number" ? { exp } : {}), ...(typeof life === "number" ? { life } : {}) });
    });
  }
  // Round 17: a key's card expiry as a Discord time: its card's post snowflake plus the lifetime its key record
  // carries (an explicit duration fixed at issuance); a key logged before round 17 has none, and is read as its
  // expiry less its logged time. null: no expiry, or no card snowflake.
  // Round 18: a key record without a card snowflake takes it from the interaction (the message id it carries:
  // msgFallback); without either, null (the tap is refused, never judged by the Pi's clock).
  private keyExpirySf(k: any, msgFallback?: string): number | null {
    if (typeof k?.exp !== "number") return null;
    const id = /^\d{15,22}$/.test(String(k.msg ?? "")) ? String(k.msg) : /^\d{15,22}$/.test(String(msgFallback ?? "")) ? String(msgFallback) : null;
    if (id === null) return null;
    const m = snowflakeTime(id);
    if (typeof k.life === "number" && Number.isFinite(k.life)) return m + k.life;
    return typeof k.at === "number" && Number.isFinite(k.at) ? m + (k.exp - k.at) : null;
  }
  // Round 18: a card's expiry as a Discord time: its logged keys' (keyExpirySf, the tapped message's id standing in
  // for a missing card snowflake), else its record's lifetime (expires less posted, both fixed when it was recorded)
  // from its own message id. null: the card has no expiry the link can place.
  private cardExpirySf(msgId: string, rec?: Shown): number | null {
    const k = this.logCards().get(msgId)?.keys.find((x) => typeof x.exp === "number");
    if (k) return this.keyExpirySf(k, msgId);
    if (rec && typeof rec.expires === "number" && typeof rec.posted === "number" && /^\d{15,22}$/.test(msgId))
      return snowflakeTime(msgId) + Math.max(0, rec.expires - rec.posted);
    return null;
  }
  // Round 17: whether a tap came after its card's expiry: Discord's time for the tap (its interaction snowflake)
  // against the card's expiry as a Discord time. Only a tap with no snowflake, or a card with no logged key,
  // falls back to the Pi's clock against the card's expiry.
  // Round 18: no Pi clock fallback: a card with an expiry that can't be placed in Discord's time, or a tap without
  // Discord's time, counts as past it (refused, told on the card), never judged by the Pi's clock.
  private tappedAfterExpiry(msgId: string, expires: number | null | undefined, _now: number, tapSf: number | null, rec?: Shown): boolean {
    const k = this.logCards().get(msgId)?.keys.find((x) => typeof x.exp === "number");
    if (!k && expires == null) return false;
    const e = this.cardExpirySf(msgId, rec);
    if (e === null || tapSf === null) return true;
    return tapSf > e;
  }
  // Round 18: whether a card's time is up, for taking its buttons off (never whether a tap counts).
  private expiresBy(id: string, m: Shown, now: number): boolean {
    const e = this.cardExpirySf(id, m);
    return e !== null ? e <= this.discordNow() : m.expires != null && m.expires <= now;
  }
  // Round 12: one key's record in the issued-key log.
  private issuedKid(kid: string): any | null {
    if (!this.d.issuedLog) return null;
    try { return readLog(this.d.issuedLog, { repair: false }).records.find((r: any) => r?.t === "key" && r.kid === kid) ?? null; }
    catch { return null; }
  }
  // Round 12: the issued-key log's keys for one card (empty: none, or no log). Round 13: not a voided card's.
  private issuedOn(msgId: string): any[] {
    const c = this.logCards().get(msgId);
    return c && !c.void ? c.keys : [];
  }
  // Round 13: the issued-key log by card: its keys in order, and whether it was armed (its buttons edited
  // on) or voided.
  private logCards(): Map<string, { keys: any[]; armed: boolean; void: boolean }> {
    const out = new Map<string, { keys: any[]; armed: boolean; void: boolean }>();
    if (!this.d.issuedLog) return out;
    let recs: any[] = [];
    try { recs = readLog(this.d.issuedLog, { repair: false }).records; } catch { return out; }
    const at = (m: string) => out.get(m) ?? (out.set(m, { keys: [], armed: false, void: false }), out.get(m)!);
    for (const r of recs) {
      if (typeof r?.msg !== "string") continue;
      if (r.t === "key") at(r.msg).keys.push(r);
      else if (r.t === "armed") at(r.msg).armed = true;
      else if (r.t === "void") at(r.msg).void = true;
    }
    return out;
  }
  // Round 12: a card posted, whose keys can't be made durable: its buttons come off and the post is
  // refused. Round 13: it never had any; it says so.
  private async unissuable(msgId: string, e: unknown, content = ""): Promise<never> {
    this.log(`couldn't write card ${msgId}'s tap keys to the issued-key log (${String(e).slice(0, 80)}): it never gets buttons`);
    try { await this.rest("PATCH", `/channels/${this.d.load().dm ?? (await this.identity()).dm}/messages/${msgId}`, { content: withLine(content, CARD_UNISSUABLE), components: [], allowed_mentions: { parse: [] } }); }
    catch (x) { this.log(`couldn't mark card ${msgId} as untappable: ${String(x).slice(0, 80)}`); }
    throw new Refusal("its tap keys couldn't be written to the link's issued-key log, so it went up without buttons and says so: ask again in a minute");
  }
  // Round 13: a card whose keys are logged but whose record couldn't be saved: a void record is logged,
  // its buttons come off (it has none yet) and it says it was withdrawn; a later tap on it is told so.
  private async voidCard(msgId: string, e: unknown, content = "", refuse = true): Promise<void> {
    this.log(`couldn't save card ${msgId}'s record after its tap keys were logged (${String(e).slice(0, 80)}): voided and withdrawn`);
    try { appendLog(this.d.issuedLog!, { t: "void", msg: msgId, at: this.d.now() }); }
    catch (x) { this.log(`couldn't log card ${msgId} as voided: ${String(x).slice(0, 80)}`); }
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      if (!content) { try { content = String((await this.rest("GET", `/channels/${dm}/messages/${msgId}`))?.content ?? ""); } catch { /* the line alone */ } }
      await this.rest("PATCH", `/channels/${dm}/messages/${msgId}`, { content: withLine(content, CARD_WITHDRAWN), components: [], allowed_mentions: { parse: [] } });
    } catch (x) { this.log(`couldn't mark card ${msgId} as withdrawn: ${String(x).slice(0, 80)}`); }
    if (refuse) throw new Refusal("its record couldn't be saved after its tap keys were logged, so it was withdrawn (it says so, and a tap on it does nothing): ask again in a minute");
  }
  // Round 13: the buttons edited onto a card whose keys and record are durable, then an "armed" record
  // logged. A failed edit is kept on the card's record (unarmed) and told on the card; the next start
  // tries again from the log (late: he is told once they're on).
  private async armCard(msgId: string, comps: any[], late: boolean): Promise<boolean> {
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      // Round 15: a card that waited with the checking line gets its text back as posted with its buttons.
      if (this.d.load().messages[msgId]?.checking === "rearm") {
        const cur = await this.rest("GET", `/channels/${dm}/messages/${msgId}`);
        await this.rest("PATCH", `/channels/${dm}/messages/${msgId}`, { content: withoutLine(String(cur?.content ?? ""), CARD_CHECKING), components: comps, allowed_mentions: { parse: [] } });
        const s0 = this.d.load();
        if (s0.messages[msgId]) { delete s0.messages[msgId].checking; this.d.save(s0); }
      } else await this.rest("PATCH", `/channels/${dm}/messages/${msgId}`, { components: comps, allowed_mentions: { parse: [] } });
    } catch (e) {
      this.log(`couldn't put card ${msgId}'s buttons on (${String(e).slice(0, 80)}): tried again from the issued-key log at the next start`);
      const s = this.d.load();
      if (s.messages[msgId] && !s.messages[msgId].unarmed) {
        s.messages[msgId].unarmed = true;
        this.d.save(s);
        try { await this.post(CARD_BUTTONS_LATE, [], { replyTo: msgId }); } catch (x) { this.log(`couldn't tell him card ${msgId}'s buttons are late: ${String(x).slice(0, 80)}`); }
      }
      return false;
    }
    try { appendLog(this.d.issuedLog!, { t: "armed", msg: msgId, at: this.d.now() }); }
    catch (x) { this.log(`couldn't log card ${msgId} as armed: ${String(x).slice(0, 80)}`); }
    const s = this.d.load();
    if (s.messages[msgId]?.unarmed) {
      delete s.messages[msgId].unarmed;
      this.d.save(s);
      if (late) { try { await this.post(CARD_BUTTONS_ON, [], { replyTo: msgId }); } catch { /* the buttons are what counts */ } }
    }
    if (late) this.log(`put card ${msgId}'s buttons on from the issued-key log, after a start`);
    return true;
  }
  // Round 13: at each start, from the issued-key log: a card whose keys were logged but which the state
  // never saved is voided and withdrawn; one saved but never armed (a failed edit, or a crash before it)
  // gets its buttons now, while it is still live. Cards from before round 13 (keys with no custom id)
  // are left as they are.
  // Round 14: first, every log entry with no durable state record (and no armed or void record) gets a
  // void record and the withdrawn line, before anything else runs. Then each retried button edit re-runs
  // every arming check: the card's record is saved again first (a save that fails withdraws it instead),
  // and the card must not be voided or expired, its source check must be accepted for its row's current
  // version, and none of its keys consumed; otherwise it gets the Expired or Withdrawn line, never buttons.
  private issuanceChecked = false;
  private rearmWaits = new Set<string>();
  // Round 15: whether the record keeper's status says its consumed set is verified (a fresh fetch merged): a
  // status that reads, with no consumed_unverified. A missing or unreadable status is not verified.
  // Round 16: and bound to the keeper's current start: its verified fetch must name the start the status
  // carries, and the link run the keeper read in this link's state, so a fetch after this link's start. A
  // status left from before a restart, or restored with the image, names an older start or an older link run,
  // and reads as unverified until a fresh fetch. Nothing here reads a clock.
  private consumedVerified(): boolean {
    const st = keeperStatus(this.files().status);
    if (!st || st.consumed_unverified) return false;
    const nonce = this.runNonce || (this.runNo(), this.runNonce);
    return typeof st.start?.nonce === "string" && !!st.verified && st.verified.start === st.start.nonce && st.verified.link === nonce && Number(st.verified.fetches) >= 1;
  }
  // Round 16: whether a tap is held: the keeper's status says its consumed set is unverified, or names a start
  // that no verified fetch covers yet. (A keeper with no status at all is left to its own hold of tap-derived
  // requests, which the keeper applies whatever the link does.)
  private keeperUnverified(): boolean {
    const st = keeperStatus(this.files().status);
    if (!st) return false;
    if (st.consumed_unverified) return true;
    return !!st.start && !(st.verified && st.verified.start === st.start.nonce);
  }
  // Round 15: a card's checking line (CARD_CHECKING or SHIP_CHECKING) put on, its buttons as they are (none
  // for a card waiting to be re-armed), and its record's digest following its new text.
  private async putChecking(msg: string, line: string, kind: "ship" | "rearm"): Promise<void> {
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      const cur = await this.rest("GET", `/channels/${dm}/messages/${msg}`);
      const content = withLine(String(cur?.content ?? ""), line), comps = cur?.components ?? [];
      await this.rest("PATCH", `/channels/${dm}/messages/${msg}`, { content, components: comps, allowed_mentions: { parse: [] } });
      const s = this.d.load();
      if (s.messages[msg]) { s.messages[msg].checking = kind; this.d.save(s); }
    } catch (e) { this.log(`couldn't put the checking line on card ${msg}: ${String(e).slice(0, 80)}`); }
  }
  // Round 15: once the consumed set is verified, a Ship card's checking line is edited away (its buttons as
  // they are, its record's digest following), so his next tap on it counts.
  private async clearChecking(): Promise<void> {
    const marked = Object.entries(this.d.load().messages).filter(([, m]) => m.checking === "ship");
    const tuple = this.verifiedChecked();
    if (!marked.length || !tuple) return;
    for (const [msg] of marked) {
      // Round 17: a card in the removal queue keeps its line; the status is re-read just before each clear, and
      // the clear is abandoned (the card left waiting) if the verification tuple changed.
      if (this.stripsOpen().has(msg)) continue;
      if (this.verifyTuple() !== tuple) { this.log("the record keeper's verification changed before a waiting line was cleared: the cards stay waiting until it is checked again"); return; }
      try {
        const dm = this.d.load().dm ?? (await this.identity()).dm;
        const cur = await this.rest("GET", `/channels/${dm}/messages/${msg}`);
        const content = withoutLine(String(cur?.content ?? ""), SHIP_CHECKING), comps = cur?.components ?? [];
        if (this.verifyTuple() !== tuple) { this.log(`card ${msg}'s waiting line kept: the record keeper's verification changed just before its clear`); return; }
        if (content !== String(cur?.content ?? "")) await this.rest("PATCH", `/channels/${dm}/messages/${msg}`, { content, allowed_mentions: { parse: [] } });
        const s = this.d.load(), m = s.messages[msg];
        if (m) { if (!m.outcome) m.digest = digest(content, comps); delete m.checking; this.d.save(s); }
        this.log(`card ${msg}'s checking line cleared: the record keeper's consumed set is verified, a Ship tap on it counts again`);
      } catch (e) {
        if (/discord 404/.test(String(e))) { const s = this.d.load(); if (s.messages[msg]) { delete s.messages[msg].checking; this.d.save(s); } continue; }
        this.log(`couldn't clear card ${msg}'s checking line (${String(e).slice(0, 80)}): tried again next sweep`);
      }
    }
  }
  // Round 16: when verification is first observed (the keeper's status turns verified for its current start and
  // this link run), every card still showing buttons, a card with a waiting line included, goes through the
  // arming checks again (round 14's: not expired, none of its keys consumed, its source check accepted for its
  // row now); one that fails is withdrawn or expired, its waiting line replaced by that line, before any
  // waiting line is cleared. A check that can't decide now waits for the next sweep, lines kept.
  // Round 17: keyed to the verification tuple (keeper start, link run, fetch count), recorded durably in the
  // link's state once its checks complete, so a keeper restart under the same link run (a new start) runs them
  // again. Every arming check runs on every card that would become tappable (a waiting line, buttonless waiting
  // cards included, or never armed); a card in the removal queue counts as withdrawn.
  private verifyTuple(): string | null {
    if (!this.consumedVerified()) return null;
    const st = keeperStatus(this.files().status)!;
    return `${st.start!.nonce}|${st.verified!.link}|${Number(st.verified!.fetches)}`;
  }
  private verifyCheckedMem: string | null = null;
  private verifiedChecked(): string | null {
    const t = this.verifyTuple();
    return t !== null && (this.verifyCheckedMem === t || this.d.load().verifyChecked === t) ? t : null;
  }
  private async verifyObserved(): Promise<void> {
    const tuple = this.verifyTuple();
    if (!tuple || !this.d.issuedLog || this.verifiedChecked() === tuple) return;
    const cards = this.logCards();
    let later = false;
    for (const [msg, rec] of Object.entries(this.d.load().messages)) {
      if (rec.outcome || (!rec.buttons && !rec.checking) || (rec.kind !== "ask" && rec.kind !== "ship")) continue;
      const c = cards.get(msg);
      if (!c || c.void || !c.keys.length) continue;
      // A card that would become tappable gets every check; any other card still showing buttons is withdrawn here
      // only for a key the keeper consumed or its removal queued (the sweep's own paths take its buttons off when
      // it expires, its item changes or the record is reset, each with its own line).
      const waiting = !!rec.checking || !c.armed;
      let why = this.rearmProblem(msg, c.keys, rec, true);
      if (!waiting && why !== "one of its tap keys was used already" && why !== "its buttons are queued for removal") why = null;
      if (why === "later") { later = true; continue; }
      if (why) { await this.retireUnarmed(msg, why); this.log(`card ${msg} failed its arming checks once verification was observed: ${why}`); }
    }
    if (later) return;
    // Re-read just before it is recorded: a tuple that changed meanwhile is checked again next sweep.
    if (this.verifyTuple() !== tuple) { this.log("the record keeper's verification changed during the arming re-checks: checked again next sweep"); return; }
    // Recorded in this process, and durably in the link's state (a failed save is retried next sweep; a restart
    // without it only runs the checks again).
    this.verifyCheckedMem = tuple;
    try { const s = this.d.load(); s.verifyChecked = tuple; this.d.save(s, true); }
    catch (e) { this.log(`couldn't record the verification tuple the arming re-checks completed for: ${String(e).slice(0, 80)}`); }
  }
  private async recoverIssuance(): Promise<void> {
    if (this.issuanceChecked || !this.d.issuedLog) return;
    this.issuanceChecked = true;
    let later = false;
    const cards = this.logCards();
    const ours = (c: { keys: any[] }) => c.keys.length > 0 && c.keys.every((k) => typeof k.cid === "string");
    for (const [msg, c] of cards) {
      if (c.armed || c.void || !ours(c) || this.d.load().messages[msg]) continue;
      await this.voidCard(msg, "its record was never saved (a cut-off at its post)", "", false);
      c.void = true;
    }
    // Round 15: no card is re-armed until the keeper's status says its consumed set is verified: until then a
    // card that would be re-armed stays buttonless with the checking line, and the re-arm (every check) runs
    // at the first sweep after.
    // Round 17: re-armed only once the arming re-checks completed for the current verification tuple, and that
    // tuple re-read just before each arm: one that changed leaves the card waiting.
    const verified = this.verifiedChecked();
    for (const [msg, c] of cards) {
      if (c.armed || c.void || !ours(c)) continue;
      const rec = this.d.load().messages[msg];
      if (!rec || rec.outcome || !rec.buttons) continue;
      if (!verified) {
        later = true;
        if (rec.checking !== "rearm") { await this.putChecking(msg, CARD_CHECKING, "rearm"); this.log(`card ${msg}'s buttons wait: the record keeper's consumed set isn't verified yet`); }
        continue;
      }
      try {
        const s = this.d.load();
        s.messages[msg].rearmed = this.d.now();
        this.d.save(s);
      } catch (x) { await this.voidCard(msg, x, "", false); continue; }
      const why = this.rearmProblem(msg, c.keys, rec);
      if (why === "later") {
        later = true;
        if (!this.rearmWaits.has(msg)) { this.rearmWaits.add(msg); this.log(`card ${msg}'s source check couldn't be confirmed at start: its buttons wait for a sweep that can`); }
        continue;
      }
      if (why) { await this.retireUnarmed(msg, why); continue; }
      if (this.verifyTuple() !== verified) { later = true; this.log(`card ${msg} left waiting: the record keeper's verification changed just before its re-arm`); continue; }
      await this.armCard(msg, rows([c.keys.map((k) => [String(k.label), String(k.cid)] as [string, string])], "q:"), true);
    }
    if (later) this.issuanceChecked = false;
  }
  // Round 14: why a card can't be armed at a start, or null: "expired" (its keys' expiry or its own passed),
  // or what withdraws it (a key consumed or tapped already, its source check not accepted for its row now).
  private rearmProblem(msg: string, keys: any[], rec: Shown, live = false): string | null {
    const now = this.d.now();
    // Round 17: a card in the removal queue counts as withdrawn.
    if (this.stripsOpen().has(msg)) return "its buttons are queued for removal";
    if (keys.some((k) => typeof k.exp === "number" && k.exp <= now) || (rec.expires != null && rec.expires <= now)) return "expired";
    const consumed = this.consumedKids();
    // A card still showing buttons (live) may carry a tap's record that kept them (busy, waiting): only a key
    // the keeper consumed withdraws it.
    if (keys.some((k) => consumed.has(k.kid)) || (!live && Object.values(this.d.load().taps ?? {}).some((t) => t.msg === msg))) return "one of its tap keys was used already";
    const item = boundItem(rec);
    if (item && (rec.kind === "ask" || rec.kind === "ship")) {
      // A definite answer withdraws it ("changed", or a card from before the record's reset epoch); a read
      // that can't decide now (unreadable, busy, behind, the clock or a push) leaves it unarmed for the
      // next sweep to try again.
      const c = this.checkState(item, rec.checked, {});
      if (c === "changed" || c === "epoch") return `its source check isn't accepted for the row as it stands now (${c})`;
      if (c !== "ok") return "later";
    }
    return null;
  }
  // Round 14: a card that fails a re-arm check: its record says so, it gets the Expired line (indexed as
  // expired) or the Withdrawn line (a void record logged, so the keeper refuses its keys), through the
  // durable button-removal queue, and Cain hears a withdrawn one.
  private async retireUnarmed(msg: string, why: string): Promise<void> {
    const expired = why === "expired";
    const s = this.d.load(), r = s.messages[msg];
    if (r) { r.outcome = "expired"; r.why = expired ? "expired" : "withdrawn"; if (r.q) r.q.used = true; r.buttons = false; delete r.unarmed; this.d.save(s); }
    if (expired) { const f = this.expiredFile(); if (f && !this.expiredCards().has(msg)) { try { appendLog(f, this.indexRecord(msg, r)); } catch (e) { this.log(`couldn't index card ${msg} as expired: ${String(e).slice(0, 80)}`); } } }
    else { try { appendLog(this.d.issuedLog!, { t: "void", msg, at: this.d.now(), why }); } catch (e) { this.log(`couldn't log card ${msg} as voided: ${String(e).slice(0, 80)}`); } }
    await this.queueStrip(msg, expired ? EXPIRED : CARD_WITHDRAWN);
    this.log(`card ${msg} not armed at start: ${why}; ${expired ? "Expired" : "Withdrawn"} line instead of its buttons`);
    if (!expired) this.d.relay(`A card of yours (Discord message ${msg}${r?.item && r.item !== "none" ? `, about ${r.item}` : ""}) was withdrawn at the App's start instead of getting its buttons: ${why}. No tap on it counts; check its item again at its source and ask again with --checked if it still needs him. Nothing more to tell him.`);
  }

  // Round 14: the keeper's consumed tap keys (its consumed-key log, read only), empty when unreadable.
  private consumedKids(): Set<string> {
    const out = new Set<string>();
    if (!this.d.consumedLog) return out;
    try { for (const r of readLog<any>(this.d.consumedLog, { repair: false }).records) if (typeof r?.tap === "string") out.add(r.tap); } catch { /* none */ }
    return out;
  }
  private sideFile(given: string | undefined, name: string): string | undefined {
    return given ?? (this.d.issuedLog ? join(dirname(this.d.issuedLog), name) : undefined);
  }
  private heldFile(): string | undefined { return this.sideFile(this.d.heldLog, "link-held.log"); }
  private stripFile(): string | undefined { return this.sideFile(this.d.stripLog, "link-strip.log"); }

  // Round 14: the durable button-removal queue. A card whose buttons must come off (expired, withdrawn,
  // lost in a restore) is queued as a framed, fsynced record first, then edited; an edit that fails is
  // retried each sweep from the queue until Discord takes it (or no longer has the message).
  private async queueStrip(msg: string, line: string): Promise<boolean> {
    const f = this.stripFile();
    if (f) { try { appendLog(f, { t: "strip", msg, line, at: this.d.now() }); } catch (e) { this.log(`couldn't queue card ${msg}'s button removal: ${String(e).slice(0, 80)}`); } }
    return this.runStrip(msg, line);
  }
  private async runStrip(msg: string, line: string): Promise<boolean> {
    try {
      const dm = this.d.load().dm ?? (await this.identity()).dm;
      const cur = await this.rest("GET", `/channels/${dm}/messages/${msg}`);
      await this.rest("PATCH", `/channels/${dm}/messages/${msg}`, { content: withLine(withoutLine(withoutLine(String(cur?.content ?? ""), CARD_CHECKING), SHIP_CHECKING), line), components: [], allowed_mentions: { parse: [] } });
    } catch (e) {
      if (!/discord 404/.test(String(e))) { this.log(`couldn't take card ${msg}'s buttons off (${String(e).slice(0, 80)}): retried from the removal queue`); return false; }
    }
    const f = this.stripFile();
    if (f) { try { appendLog(f, { t: "done", msg, at: this.d.now() }); } catch { /* retried: the edit is idempotent */ } }
    return true;
  }
  private async retryStrips(): Promise<void> {
    for (const [msg, line] of this.stripsOpen()) await this.runStrip(msg, line);
  }
  // Round 17: the cards in the removal queue whose edit hasn't been done yet, with their lines.
  private stripsOpen(): Map<string, string> {
    const open = new Map<string, string>();
    const f = this.stripFile();
    if (!f || !existsSync(f)) return open;
    let recs: any[] = [];
    try { recs = readLog<any>(f, { repair: false }).records; } catch { return open; }
    for (const r of recs) {
      if (r?.t === "strip" && typeof r.msg === "string") open.set(r.msg, String(r.line ?? ""));
      else if (r?.t === "done") open.delete(r.msg);
    }
    return open;
  }

  // Round 14: a tap held while the keeper's consumed set is unverified: the held record (tap time, the
  // check's row and version, the key) is appended and fsynced, then the card is marked answered and says
  // it is held; his outage notice goes at once.
  private async holdTap(it: any, cid: string, msgId: string, rec: Shown, key: string, now: number): Promise<string> {
    const label = rec.q?.options[Number(cid.split(":")[2])] ?? "";
    const kid = tapKid(key), item = (rec.item ?? "none").toUpperCase(), kind = rec.kind ?? "ask";
    // Round 17: the hold's start goes into the durable held record as a Discord-stamped id, never a Pi clock
    // reading: the first held interaction of this hold (the keeper start the status names; the held line is put on
    // the card by that interaction's own answer, so Discord's stamp for it is the interaction id), read back from
    // the held log for every later tap held in the same hold. The keeper floors by that id's snowflake alone.
    const iid = /^\d{15,22}$/.test(String(it?.id ?? "")) ? String(it.id) : null;
    const ks = keeperStatus(this.files().status);
    const period = String(ks?.start?.nonce ?? ks?.consumed_unverified?.since ?? "");
    const first = period ? this.holdAnchor(period) : null;
    const hold = first ?? (iid ? { period, id: iid, from: "interaction" } : null);
    try {
      // Round 15: with the interaction's id, whose snowflake time is Discord's own record of when he tapped.
      appendLog(this.heldFile()!, { t: "held", kid, msg: msgId, label, item, kind, row: rec.checked?.row ?? null, version: rec.checked?.version ?? 0,
        req: rec.checked?.req ?? null, at: now, ...(iid ? { it: iid } : {}), ...(hold ? { hold } : {}) });
    } catch (e) {
      if (this.deferred.has(it)) await this.restoreCard(it, msgId); else await this.answer(it, ACK);
      await this.ephemeral(it, BUSY_TAP);
      this.log(`tap on card ${msgId} couldn't be held (${String(e).slice(0, 80)}): the card keeps its buttons`);
      return "refused: busy";
    }
    this.d.crashPoint?.("held:after-log");
    const s = this.d.load(), m = s.messages[msgId];
    const content = withLine(withLine(String(it.message?.content ?? ""), `You answered: ${label}`), TAP_HELD);
    if (m) { if (m.q) m.q.used = true; m.outcome = "answered"; m.why = "held"; m.label = label; m.digest = digest(content, []); }
    (s.issued ??= {})[kid] = { item, kind, label, at: now, msg: msgId, target: tapTarget(item, kind, label), ...(iid ? { it: iid } : {}) };
    this.d.save(s);
    const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    if (ok) { const s2 = this.d.load(); if (s2.messages[msgId]) { s2.messages[msgId].buttons = false; s2.messages[msgId].off = this.d.now(); this.d.save(s2); } }
    this.log(`tap on card ${msgId} held (tap key ${kid}): the record keeper's consumed set is unverified`);
    this.d.relay(`Dane tapped "${label}" on a card of yours (Discord message ${msgId}), but the record keeper can't verify yet which taps were already acted on, so the link holds it: record nothing yet. It comes to you again by itself once the keeper has verified, with its tap key, or you hear why it wasn't acted on. Nothing to tell him.`);
    await this.unverifiedNotice(true);
    return "held";
  }
  // Round 17: the hold's Discord-stamped start for a hold (its period: the keeper start it is under), from the
  // first held record of that hold in the held log; null: none yet.
  private holdAnchor(period: string): { period: string; id: string; from: string } | null {
    const f = this.heldFile();
    if (!f || !existsSync(f)) return null;
    try {
      const r = readLog<any>(f, { repair: false }).records.find((x) => x?.t === "held" && x.hold?.period === period && /^\d{15,22}$/.test(String(x.hold?.id ?? "")));
      return r ? { period, id: String(r.hold.id), from: String(r.hold.from ?? "interaction") } : null;
    } catch { return null; }
  }
  // Round 14: held taps not yet released or dropped.
  private heldOpen(): any[] {
    const f = this.heldFile();
    if (!f || !existsSync(f)) return [];
    let recs: any[] = [];
    try { recs = readLog<any>(f, { repair: false }).records; } catch { return []; }
    const done = new Set(recs.filter((r) => r?.t === "released" || r?.t === "dropped").map((r) => r.kid));
    const releasing = new Set(recs.filter((r) => r?.t === "releasing").map((r) => r.kid));
    const seen = new Set<string>();
    return recs.filter((r) => r?.t === "held" && typeof r.kid === "string" && !done.has(r.kid) && !seen.has(r.kid) && seen.add(r.kid))
      .map((r) => (releasing.has(r.kid) ? { ...r, releasing: true } : r));
  }
  // Round 14: each sweep, once the keeper's consumed set is verified, every held tap is judged again: by
  // its tap time against its keys' expiry, and by its check's row and version against the ledger now. One
  // that passes is relayed to Cain with its tap key (the keeper takes one request per key, so a relay a
  // crash repeats acts once); one that doesn't is dropped and told on the card.
  private async releaseHeldTaps(): Promise<void> {
    const open = this.heldOpen();
    if (!open.length) return;
    // Round 16: resolved (released, replayed or dropped) only once the consumed set is verified for the
    // keeper's current start and this link run; meanwhile the card keeps its held line.
    const f = this.files();
    if (!this.consumedVerified() || typeof f.checks !== "string") return;
    let ledger: Record<string, any>;
    try { ledger = parseChecks(f.checks); } catch { return; }
    const keyOf = new Map<string, any>();
    for (const c of this.logCards().values()) for (const k of c.keys) if (typeof k.exp === "number") keyOf.set(k.kid, k);
    const consumed = this.consumedKids();
    for (const h of open) {
      const k = keyOf.get(h.kid);
      // Round 16: the tap's time and its card's expiry are Discord's alone when the held record has the
      // interaction id: its snowflake against the card's post snowflake plus the key's lifetime. The Pi's clock
      // plays no part; when it is off from Discord's by more than CLOCK_TOLERANCE_MS, the card says so plainly.
      const sf = /^\d{15,22}$/.test(String(h.it ?? "")) ? snowflakeTime(String(h.it)) : null;
      // Round 18: the tap's own interaction snowflake is its time, always; the hold's shared start (hold.id) serves
      // only the lateness floor. A held record without an interaction id, or a key whose card can't be placed in
      // Discord's time (no card snowflake on the key and none from the held record's message id), is refused: never
      // judged by the Pi's clock.
      const expAt = k ? this.keyExpirySf(k, h.msg) : null;
      let why: "expired" | "changed" | "floor" | "unstamped" | null = null;
      const quoted = "";
      if (sf !== null && Math.abs(Number(h.at) - sf) > CLOCK_TOLERANCE_MS) await this.tellCardClockOff(h.msg, Number(h.at) - sf);
      // Round 17: the hold's start is a Discord-stamped id in the held record (never the keeper's status time).
      const holdSf = /^\d{15,22}$/.test(String(h.hold?.id ?? "")) ? snowflakeTime(String(h.hold.id)) : null;
      if (sf === null || (k && expAt === null)) why = "unstamped";
      else if (typeof expAt === "number" && sf > expAt) why = "expired";
      else if (holdSf !== null && typeof expAt === "number" && holdSf > expAt) why = "floor";
      else if (h.item !== "NONE") { const e = ledger[h.item]; if (!e || e.id !== h.row || e.version !== h.version) why = "changed"; }
      if (why) {
        try { appendLog(this.heldFile()!, { t: "dropped", kid: h.kid, why, at: this.d.now() }); } catch (e) { this.log(`couldn't drop held tap ${h.kid}: ${String(e).slice(0, 80)}`); continue; }
        const line = why === "changed" ? TAP_NOT_ACTED_CHANGED : why === "floor" ? TAP_HOLD_FLOOR : why === "unstamped" ? TAP_UNSTAMPED : TAP_EXPIRED;
        try { await this.post(line, [], { replyTo: h.msg }); } catch (e) { this.log(`couldn't tell him held tap ${h.kid} wasn't acted on: ${String(e).slice(0, 80)}`); }
        const because = why === "changed" ? `wasn't acted on because ${h.item} changed after his tap`
          : why === "floor" ? "wasn't acted on because its hold began after its card had expired (by Discord's times)"
          : why === "unstamped" ? "wasn't acted on because Discord's time for it, or for its card, couldn't be read, so it couldn't be judged"
          : "wasn't acted on because its card had expired when he tapped (by Discord's times)";
        this.d.relay(`Tap not acted: Dane's held tap "${h.label}" (Discord message ${h.msg}) ${because}. He was told on the card. Record nothing from it; check its item again at its source and ask again with --checked if it still needs him. Tap key ${h.kid}.`);
        this.log(`held tap ${h.kid} dropped: ${why}${quoted ? ` (${quoted})` : ""}`);
        continue;
      }
      // Round 15: a release a crash cut off between its "releasing" record and its "released" one: if the
      // keeper already acted on the key it is dropped and logged; otherwise it goes again, flagged as a replay
      // of a line Cain may have had, which Cain's rules say is not acted on again.
      if (h.releasing) {
        if (consumed.has(h.kid)) {
          try { appendLog(this.heldFile()!, { t: "released", kid: h.kid, at: this.d.now(), why: "acted already" }); } catch { /* the next sweep */ }
          this.log(`held tap ${h.kid}: its release was cut off, and the record keeper already acted on its key; dropped, not relayed again`);
          continue;
        }
      } else {
        // Marked releasing (fsynced) before the relay: a repeat after a crash is known as one.
        try { appendLog(this.heldFile()!, { t: "releasing", kid: h.kid, at: this.d.now() }); }
        catch (e) { this.log(`couldn't mark held tap ${h.kid} releasing (${String(e).slice(0, 80)}): released next sweep`); continue; }
      }
      const m = this.d.load().messages[h.msg];
      const line = (m ? this.tapLine(m, h.label, h.msg) : `Dane tapped "${h.label}" on your ${h.kind === "ship" ? "Ship card" : "question"}${h.item !== "NONE" ? ` about ${h.item}` : ""} (Discord message ${h.msg})`)
        + ` It was held while the record keeper verified which taps were acted on, and acts now. Tap key ${h.kid}.`;
      // Round 16: a replay carries its tap key and is flagged: Cain looks the key up in the keeper's record (its
      // consumed-key log and request log) and in decisions.md, and acts only if it is in neither. The link
      // watches for the keeper's request for the key after a replay (replayWatch).
      this.d.relay(h.releasing ? `Replay of held tap key ${h.kid}, already relayed once before a restart: look tap key ${h.kid} up in the record keeper's consumed-key log and request log and in state/decisions.md, and act only if it is in none of them, never from memory. ${line}` : line);
      this.d.crashPoint?.("held:after-relay");
      try { appendLog(this.heldFile()!, { t: "released", kid: h.kid, at: this.d.now(), ...(h.releasing ? { replay: true } : {}) }); } catch (e) { this.log(`couldn't mark held tap ${h.kid} released (${String(e).slice(0, 80)}): a repeat is flagged as a replay, and the keeper takes one request per tap key`); }
      this.log(`held tap ${h.kid} released to Cain${h.releasing ? " (flagged as a replay)" : ""}`);
    }
  }

  // Round 16: one line on a card's thread when the Pi's clock is the outlier against Discord's time for his tap
  // there (the tap is judged by Discord's time all the same).
  private async tellCardClockOff(msg: string, skew: number): Promise<void> {
    const id = `${msg}:clock`;
    const s = this.d.load();
    if (s.tapNoticed?.[id]) return;
    (s.tapNoticed ??= {})[id] = this.d.now();
    this.d.save(s);
    try { await this.post(clockOffLine(skew), [], { replyTo: msg }); } catch (e) { this.log(`couldn't tell him the Pi's clock is off on card ${msg}: ${String(e).slice(0, 80)}`); }
    this.log(`the Pi's clock is ${Math.round(skew / 1000)} s off Discord's time for his held tap on card ${msg}: told on the card, judged by Discord's time`);
  }
  // Round 16: after a flagged replay of a held tap, the keeper's request for its key should follow: a key
  // consumed, or a request the keeper refused (its tap notices). If none appears within REPLAY_WAIT_MS, his
  // card gets one line asking him to answer again on a fresh card, and Cain hears it.
  private replaySeen = new Map<string, number>();
  private async replayWatch(): Promise<void> {
    const f = this.heldFile();
    if (!f || !existsSync(f) || !this.consumedVerified()) return;
    let recs: any[] = [];
    try { recs = readLog<any>(f, { repair: false }).records; } catch { return; }
    const settled = new Set(recs.filter((r) => r?.t === "replay-done").map((r) => r.kid));
    const replays = recs.filter((r) => r?.t === "released" && r.replay === true && typeof r.kid === "string" && !settled.has(r.kid));
    if (!replays.length) return;
    const consumed = this.consumedKids();
    const st = keeperStatus(this.files().status) as any;
    const notes = st?.tap_notices;
    const noticed = new Set<string>(Array.isArray(notes) ? notes.map((n: any) => String(n?.tap ?? "")) : []);
    // Round 18: the supersedes this link has appended, and those the keeper's status shows mirrored.
    const ours = new Set<string>();
    if (this.d.issuedLog && existsSync(this.d.issuedLog)) {
      try { for (const x of readLog<any>(this.d.issuedLog, { repair: false }).records) if (x?.t === "supersede" && typeof x.kid === "string") ours.add(x.kid); } catch { /* read again next sweep */ }
    }
    const mirrored = new Set<string>(Array.isArray(st?.superseded) ? st.superseded.map((k: any) => String(k)) : []);
    for (const r of replays) {
      const held = recs.find((x) => x?.t === "held" && x.kid === r.kid);
      if (!ours.has(r.kid)) {
        if (consumed.has(r.kid) || noticed.has(r.kid)) {
          try { appendLog(f, { t: "replay-done", kid: r.kid, how: "the keeper has a request for it", at: this.d.now() }); } catch { /* the next sweep */ }
          continue;
        }
        // Round 17: the 10-minute bound runs on the monotonic clock, from when this process first saw the replay
        // (a restart starts it again, so it is never shorter), never on the Pi's clock.
        if (!this.replaySeen.has(r.kid)) this.replaySeen.set(r.kid, this.mono());
        if (this.mono() - this.replaySeen.get(r.kid)! < REPLAY_WAIT_MS) continue;
        // Round 17: the old key is superseded (fsynced in the issued-key log, which the keeper reads) before the line
        // asking him again goes, so a late request of Cain's for it is refused, with a line on the card.
        if (!this.d.issuedLog) continue;
        try { appendLog(this.d.issuedLog, { t: "supersede", kid: r.kid, ...(held?.msg ? { msg: held.msg } : {}), at: this.d.now() }); }
        catch (e) { this.log(`couldn't supersede replayed tap key ${r.kid} (${String(e).slice(0, 80)}): asked again next sweep`); continue; }
        this.log(`replayed held tap ${r.kid}: superseded; the line asking him again waits for the record keeper's mirror of it`);
      }
      // Round 18: supersede ordered against consumption. The line asking him again waits until the keeper's status
      // shows the supersede mirrored (from then on the keeper refuses the key, and it reads the link's log for a
      // supersede just before consuming any key), and the key is still absent from the consumed-key log. A key the
      // keeper consumed meanwhile gets the outcome of that tap on the card instead: exactly one of the two.
      if (!mirrored.has(r.kid)) continue;
      if (this.consumedKids().has(r.kid)) {
        try { appendLog(f, { t: "replay-done", kid: r.kid, how: "consumed before the supersede took", at: this.d.now() }); } catch { continue; }
        if (held?.msg) { try { await this.post(TAP_REPLAY_ACTED, [], { replyTo: held.msg }); } catch (e) { this.log(`couldn't tell him on card ${held.msg} that his answer was acted on: ${String(e).slice(0, 80)}`); } }
        this.d.relay(`Replayed held tap key ${r.kid} was acted on by the record keeper before its supersede took, so it stands: he was told on the card that his answer was acted on, and he isn't asked again. Nothing more to do or tell him.`);
        this.log(`replayed held tap ${r.kid}: consumed before the supersede was mirrored; he was told it acted`);
        continue;
      }
      try { appendLog(f, { t: "replay-done", kid: r.kid, how: "no request: asked again", at: this.d.now() }); } catch { continue; }
      if (held?.msg) { try { await this.post(TAP_REPLAY_AGAIN, [], { replyTo: held.msg }); } catch (e) { this.log(`couldn't ask him again on card ${held.msg}: ${String(e).slice(0, 80)}`); } }
      this.d.relay(`No request came for replayed held tap key ${r.kid} within ${REPLAY_WAIT_MS / 60_000} minutes, so it may never have been acted on. He was asked on the card to answer again, and tap key ${r.kid} is superseded: the record keeper refuses a request for it now, so send none. Check its item again at its source and ask again with --checked if it still needs him. Nothing more to tell him.`);
      this.log(`replayed held tap ${r.kid}: no keeper request within ${REPLAY_WAIT_MS / 60_000} minutes; he was asked again on the card`);
    }
  }

  // Round 14: after a detected restore (an armed card in the issued-key log this state doesn't know, a lost
  // tap, or the record keeper's own restore), the bot's recent messages in his DM are looked over once: any
  // card with buttons that neither this state nor the issued-key log knows live gets its buttons off through
  // the removal queue, with the lost-in-restore line (the Expired line when its keys expired, or when a
  // Tap-Card trailer names it and it is past 100 days).
  private restoreSeen = false;
  private restoreSwept = false;
  private restoreDetected(): boolean {
    if (this.restoreSeen) return true;
    const known = this.d.load().messages;
    for (const [msg, c] of this.logCards()) if (c.armed && !c.void && !known[msg]) return true;
    const u = keeperStatus(this.files().status)?.consumed_unverified;
    return !!u && u.why !== KEEPER_START_WHY;
  }
  // Round 16: which detected restore this is, so its sweep runs once: the keeper's own restore by when its
  // hold began, else the link's (the newest armed card its state doesn't know, or a lost tap).
  private restoreKey(): string {
    const u = keeperStatus(this.files().status)?.consumed_unverified;
    if (u && u.why !== KEEPER_START_WHY) return `keeper:${u.since}`;
    const known = this.d.load().messages;
    let newest = "";
    for (const [msg, c] of this.logCards()) if (c.armed && !c.void && !known[msg] && (!newest || BigInt(msg) > BigInt(newest))) newest = msg;
    return newest ? `log:${newest}` : `tap:${this.runNonce}`;
  }
  // Round 16: the sweep's durable cursor (link-sweep.json beside the issued-key log): the restore it is for,
  // the oldest message id reached, and whether it reached the 100-day horizon or the end of his DM's history.
  private sweepFile(): string | undefined { return this.sideFile(undefined, "link-sweep.json"); }
  private sweepCursor(): { restore: string; before: string; done: boolean } | null {
    const f = this.sweepFile();
    if (!f || !existsSync(f)) return null;
    try { const j = JSON.parse(readFileSync(f, "utf8")); return typeof j?.restore === "string" ? { restore: j.restore, before: String(j.before ?? ""), done: j.done === true } : null; }
    catch { return null; }
  }
  private saveCursor(c: { restore: string; before: string; done: boolean }): void {
    const f = this.sweepFile();
    if (!f) return;
    // Round 17: fsynced (the file, then its folder) before the rename is relied on: done is never lost to a power cut.
    writeDurable(f, JSON.stringify(c) + "\n");
  }
  private async restoreSweep(): Promise<void> {
    if (this.restoreSwept || !this.d.issuedLog || !this.restoreDetected()) return;
    this.restoreSwept = true;
    const key = this.restoreKey();
    let cur = this.sweepCursor();
    if (cur?.restore === key && cur.done) return;
    if (cur?.restore !== key) cur = { restore: key, before: "", done: false };
    // Round 16: every Ship card this state knows was issued before the restore's snapshot (the state it came
    // back with), so it stays buttonless until Cain reissues it, and says so. Question cards keep the usual
    // handling (their keys are judged at the tap).
    await this.shipCardsAfterRestore();
    // Round 15: paged back to the 100-day card horizon: newest first, 100 at a time, stopping at the first
    // message older than TAP_ISSUED_KEEP_MS or where his DM's history ends. Once per detected restore.
    // Round 16: each page is handled as it arrives and the cursor (the oldest id reached) saved after it; the
    // sweep is done only at the horizon or the end of history; a restart resumes from the cursor; a rate limit
    // waits its Retry-After and tries the page again (three times, then the next sweep resumes). History read
    // here draws no reply and no code: only cards' buttons are taken off.
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    let id: { owner: string; dm: string; bot: string };
    try { id = await this.identity(); } catch (e) { this.log(`couldn't look over his DM after a restore: ${String(e).slice(0, 80)}`); this.restoreSwept = false; return; }
    // Round 17: the horizon is a Discord time: the start mark's snowflake time less 100 days, never the Pi's clock.
    // Done is written only on reaching it or the end of history, and never while the Pi's clock is flagged off.
    const mark = await this.startMark();
    if (mark === null) { this.log("the restore sweep waits for this start's mark in his DM"); this.restoreSwept = false; return; }
    const horizon = (mark === "0" ? -Infinity : snowflakeTime(mark)) - TAP_ISSUED_KEEP_MS;
    let lost = 0;
    for (let n = 0; n < 1000; n++) {
      let got: any;
      for (let tries = 0; ; tries++) {
        try { got = await this.rest("GET", `/channels/${id.dm}/messages?limit=100${cur.before ? `&before=${cur.before}` : ""}`); break; }
        catch (e) {
          const w = String(e);
          if (/discord 429/.test(w) && tries < 3) {
            const ra = Number(/retry[_ -]after[^0-9]*([0-9.]+)/i.exec(w)?.[1] ?? 1);
            await sleep(Math.min(60_000, Math.max(0, ra) * 1000));
            continue;
          }
          this.log(`couldn't look over his DM after a restore (${w.slice(0, 80)}): resumed from message ${cur.before || "the newest"} next sweep`);
          this.restoreSwept = false;
          if (lost) this.tellLostCards(lost);
          return;
        }
      }
      const batch = Array.isArray(got) ? got : [];
      let past = false;
      const page: any[] = [];
      for (const m of batch) { if (snowflakeTime(String(m?.id ?? "0")) < horizon) { past = true; break; } page.push(m); }
      lost += await this.sweepPage(page, id.bot, horizon);
      const oldest = String(batch.at(-1)?.id ?? "");
      const end = past || batch.length < 100 || !oldest;
      const verdict = this.piClock();
      const off = end && verdict !== "in step";
      cur = { restore: key, before: oldest || cur.before, done: end && !off };
      try { this.saveCursor(cur); } catch (e) { this.log(`couldn't save the restore sweep's cursor: ${String(e).slice(0, 80)}`); }
      this.d.crashPoint?.("sweep:after-page");
      if (off) { this.log(`the restore sweep reached its horizon, but the Pi's clock is ${verdict === "off" ? "flagged off" : "not yet compared with a Discord stamp in this run"}: not marked done, read again`); this.restoreSwept = false; }
      if (end) break;
    }
    if (lost) this.tellLostCards(lost);
  }
  private tellLostCards(lost: number): void {
    this.d.relay(`After a restore of the App's state, ${lost} card${lost === 1 ? "" : "s"} of yours with buttons weren't known any more: their buttons are off, each says it was lost in the restore. Check those items again at their source and ask again with --checked what still needs him. Nothing more to tell him.`);
  }
  // One page of the restore sweep: any bot card with buttons that neither this state nor the issued-key log
  // knows live gets its buttons off; returns how many were lost (not expired).
  private async sweepPage(page: any[], bot: string, horizon: number): Promise<number> {
    const known = this.d.load().messages, cards = this.logCards(), now = this.d.now();
    const hist = keeperStatus(this.files().status)?.history_cards ?? [];
    const indexed = this.expiredCards();
    let lost = 0;
    for (const m of page) {
      const id = String(m?.id ?? "");
      if (String(m?.author?.id ?? "") !== bot || known[id]) continue;
      const cids = (m.components ?? []).flatMap((r: any) => (r.components ?? []).map((b: any) => String(b.custom_id ?? "")));
      if (!cids.some((c: string) => c.startsWith("q:"))) continue;
      const exp = cards.get(id)?.keys.find((k) => typeof k.exp === "number")?.exp;
      const old = snowflakeTime(id) < horizon;
      const expired = (typeof exp === "number" && exp <= now) || (hist.includes(id) && old) || old;
      if (expired) {
        const f = this.expiredFile();
        if (f && !indexed.has(id)) { try { appendLog(f, this.indexRecord(id, undefined, old)); indexed.add(id); } catch { /* the line still goes */ } }
      } else lost++;
      await this.queueStrip(id, expired ? EXPIRED : CARD_LOST_RESTORE);
      this.log(`after a restore: card ${id} wasn't known to the rebuilt state or log; its buttons come off (${expired ? "expired" : "lost in the restore"})`);
    }
    return lost;
  }
  // Round 16: on a detected restore, each Ship card this state knows with buttons (all issued before the
  // snapshot it came back with) loses them through the removal queue, says it waits for a reissue, and Cain
  // hears it. A Ship landing stays bounded by the pull request's merged state (one landing per head) besides.
  private async shipCardsAfterRestore(): Promise<void> {
    const s = this.d.load();
    const ships = Object.entries(s.messages).filter(([, m]) => m.kind === "ship" && m.buttons && !m.outcome);
    for (const [msg, m] of ships) {
      const s2 = this.d.load(), r = s2.messages[msg];
      if (r) { r.outcome = "expired"; r.why = "restore"; if (r.q) r.q.used = true; r.buttons = false; this.d.save(s2); }
      await this.queueStrip(msg, SHIP_RESTORE_REISSUE);
      this.log(`after a restore: Ship card ${msg} was issued before the snapshot, so it stays buttonless until it is reissued`);
      this.d.relay(`After a restore of the App's state, your Ship card (Discord message ${msg}${m.item && m.item !== "none" ? `, about ${m.item}` : ""}) lost its buttons: a Ship card from before the restore isn't tappable. Check Home Assistant first, then show a new Ship card for the same pull request and head with --checked if it still needs him. Nothing more to tell him.`);
    }
  }

  // Round 13: the compact expired-key index: one record per card whose keys expired.
  private expiredFile(): string | undefined {
    return this.d.expiredLog ?? (this.d.issuedLog ? join(dirname(this.d.issuedLog), "link-expired.log") : undefined);
  }
  private expiredCards(): Set<string> { return new Set(this.expiredIndex().keys()); }
  // Round 18: the index by card, with each card's expiry as a Discord time (exp: its post snowflake plus its
  // lifetime; null for a record without one). Membership is a cleanup marker; only exp, compared with a tap's
  // interaction snowflake, refuses a tap.
  private expiredIndex(): Map<string, number | null> {
    const f = this.expiredFile(), out = new Map<string, number | null>();
    if (!f || !existsSync(f)) return out;
    try {
      for (const r of readLog<any>(f, { repair: false }).records)
        if (typeof r?.msg === "string") out.set(r.msg, typeof r.exp === "number" && Number.isFinite(r.exp) ? r.exp : (out.get(r.msg) ?? null));
    } catch { /* none */ }
    return out;
  }
  // Round 18: an index record: the card and its expiry as a Discord time (none when it can't be placed; a card
  // older than the sweep's horizon gets its post snowflake plus the longest card lifetime, CARD_LIFE_MAX_MS).
  private indexRecord(msg: string, rec?: Shown, old = false): { msg: string; exp?: number; at: number } {
    const e = this.cardExpirySf(msg, rec) ?? (old && /^\d{15,22}$/.test(msg) ? snowflakeTime(msg) + CARD_LIFE_MAX_MS : null);
    return { msg, ...(e !== null ? { exp: e } : {}), at: this.d.now() };
  }
  // Round 13: at key expiry, each card's buttons come off by the message id in the issued-key log (an
  // "Expired" line added), even one this state no longer knows, and the card goes into the expired-key
  // index, so a late tap on it is told it expired. A card the state still shows live is left to its own
  // expiry (the sweep), and indexed once that took its buttons off.
  private async expireByLog(): Promise<void> {
    const f = this.expiredFile();
    if (!f || !this.d.issuedLog) return;
    const done = this.expiredCards();
    const now = this.d.now();
    for (const [msg, c] of this.logCards()) {
      if (done.has(msg) || c.void) continue;
      // Round 18: when the buttons come off is the card's expiry as a Discord time (post snowflake plus lifetime)
      // against Discord's time as the link knows it (the Pi's clock through the measured offset).
      const exp = this.cardExpirySf(msg);
      if (exp === null || exp > this.discordNow()) continue;
      const rec = this.d.load().messages[msg];
      if (rec?.buttons) continue;
      // Round 14: indexed first, so a tap is told it expired whatever the buttons still show; the removal
      // edit goes through the durable queue and is retried until Discord takes it.
      try { appendLog(f, this.indexRecord(msg, rec)); this.log(`card ${msg}'s tap keys expired: it is in the expired-key index and its buttons come off`); }
      catch (e) { this.log(`couldn't add card ${msg} to the expired-key index: ${String(e).slice(0, 80)}`); continue; }
      if (!rec) await this.queueStrip(msg, EXPIRED);
    }
  }
  // Round 13: a tap on a card this state doesn't know, and that isn't in the issued-key log: lost to a
  // restore (never forged) when the bot authored it, its custom id is well formed, and either the
  // keeper's mirror or the record remote's history (Tap-Card trailers, in the keeper's status) knows its
  // message id, or it is newer than every card this state and the log know (a whole-image restore).
  private async lostToWholeRestore(it: any, msgId: string, cid: string): Promise<boolean> {
    if (!/^q:[0-9a-f]{10}:\d$/.test(cid) || !/^\d{15,22}$/.test(msgId)) return false;
    let bot = "";
    try { bot = (await this.identity()).bot; } catch { return false; }
    if (String(it.message?.author?.id ?? "") !== bot) return false;
    if (this.d.keeperMirror) {
      try { if (readLog<any>(this.d.keeperMirror, { repair: false }).records.some((r) => r?.t === "key" && r.msg === msgId)) return true; } catch { /* not readable */ }
    }
    const st: any = keeperStatus(this.files().status);
    if (Array.isArray(st?.history_cards) && st.history_cards.includes(msgId)) return true;
    // Snowflakes order by time, so the newest id this state or the log knows is the restore's boundary.
    let newest = 0n;
    for (const id of [...Object.keys(this.d.load().messages), ...this.logCards().keys()]) if (/^\d{15,22}$/.test(id) && BigInt(id) > newest) newest = BigInt(id);
    return BigInt(msgId) > newest;
  }

  // The landing ledger's upkeep, each sweep. A ledger that came back from a backup (landings.ts
  // untrusted) is trusted only once every key in it was looked for on the remote main by its head
  // (the landing's token): one there is settled as landed, one not there and with no landing of
  // the link's still on it as not landed. While GitHub can't be read, it stays untrusted (no landing
  // starts). Settled keys are pruned by the link, once a day, after LANDING_KEEP_MS (30 days); the
  // record keeper never writes or cleans the directory.
  private ledgerWhy: string | null = null;
  private async ledgerUpkeep(): Promise<void> {
    const L = this.d.landings;
    if (!L) return;
    const s = this.d.load();
    const why = L.untrusted(s.landingCount);
    if (why) {
      if (this.ledgerWhy !== why) { this.ledgerWhy = why; this.log(`the landing ledger came back from a backup (${why}): each key is looked for on the remote main before it is trusted`); }
      const entries = L.entries();
      if (!entries || !this.d.landed) return;
      // Looked for again on the same bounded backoff as an orphan (unresolvedFail), from the sweep.
      const owed = Object.entries(s.unresolved ?? {}).filter(([, u]) => u.what === "ledger");
      if (owed.some(([k]) => !this.unresolvedDue(k))) return;
      const results: [typeof entries[number], boolean][] = [];
      for (const e of entries) {
        if (e.settled?.forced) { results.push([e, e.settled.how === "landed"]); continue; }   // the owner settled it (keeper.sh settle)
        const there = await this.remote({ pr: e.pr, head: e.head }, e.base);
        if (there.v === null) {
          const msg = Object.entries(s.messages).find(([, m]) => m.shipping?.key === e.key)?.[0];
          await this.unresolvedFail(e.key, there.why, "ledger", msg);
          this.log("GitHub couldn't be read to check the restored landing ledger: it stays untrusted, and no landing starts");
          return;
        }
        results.push([e, there.v]);
      }
      for (const [k] of owed) this.unresolvedClear(k);
      const at = new Date(this.d.now()).toISOString();
      const landingKeys = new Set(Object.values(s.messages).filter((m) => m.shipping?.state === "landing" && m.shipping.key).map((m) => m.shipping!.key!));
      for (const [e, there] of results) if (!e.settled && (there || !landingKeys.has(e.key))) L.settle(e.key, there ? "landed" : "not landed", at);
      L.trust();
      const s2 = this.d.load();
      s2.landingCount = L.count();
      this.d.save(s2);
      this.ledgerWhy = null;
      this.log(`the restored landing ledger was checked against the remote main (${results.length} key(s)): trusted again`);
    }
    const now = this.d.now();
    if (now - (s.ledgerPruned ?? 0) >= DAY) {
      const s5 = this.d.load();
      L.prune(now, undefined, new Set([...Object.keys(s5.unresolved ?? {}), ...Object.keys(s5.tombstones ?? {})]));   // an unresolved key (or a tombstone) is never pruned
      const s3 = this.d.load();
      s3.ledgerPruned = now;
      this.d.save(s3);
    }
  }

  // Cards from before 0.9.0 recorded no labels: they're filled in once, from what the link
  // still knows for sure (an ask's options, a specialist card's rows while it has them, a
  // Stop notice's toggle, a live morning message's toggle). What it can't know stays
  // unknown: a specialist card whose rows a strip already emptied, a morning message whose
  // button came off. Unknown is never "no buttons": the replay reads it as can't tell.
  private backfillLabels(): void {
    const s = this.d.load();
    if (s.labelled) return;
    for (const m of Object.values(s.messages)) {
      if (m.labels) continue;
      const c = m.card !== undefined ? s.cards[String(m.card)] : undefined;
      const known = m.q ? [...m.q.options] : c?.rows.length ? labelsOf(c.rows)
        : m.toggle ? [m.toggle === RESUME ? "Turn back on" : "Stop"]
        : m.kind === "morning" && m.buttons ? [this.stopped().stopped ? "Turn back on" : "Stop"] : undefined;
      if (known) m.labels = known;
    }
    s.labelled = true;
    this.d.save(s);
  }

  // A card with buttons that Cain hasn't shown in time goes out by itself, under no item,
  // and he's told: the owner's card reaches him within its life, whatever Cain is doing.
  // If it can't go out, Cain hears so once, and the link keeps trying. One whose own
  // expiry passes first is marked expired, never goes out, and Cain hears what it was.
  // Cards without buttons, Stop notices and cards from before 0.7.2 (no due time) are
  // left as they are.
  private async showDue(): Promise<void> {
    const now = this.d.now();
    const s = this.d.load();
    const due: number[] = [];
    const lapsed: string[] = [];
    let marked = false;
    for (const [k, c] of Object.entries(s.cards)) {
      if (c.shown || c.outcome || c.due == null || !c.rows.length) continue;
      const gone = c.expires != null && c.expires <= now;
      if (gone && !c.posting) {
        c.outcome = "expired"; marked = true;
        if (!c.lapseTold) { c.lapseTold = true; lapsed.push(lapsedLine(Number(k), c)); }
        this.log(`card ${k} expired before it went out; it won't be posted`);
      } else if (gone || c.due <= now) due.push(Number(k));      // a post whose answer was lost is looked for first
    }
    if (marked) this.d.save(s);
    for (const l of lapsed) this.d.relay(l);
    for (const id of due) {
      let out: Put;
      try { out = await this.putUp(id, { item: "none", question: "" }, true); }
      catch (e) {
        if (e instanceof Refusal) {                        // it lapsed just now: the post marked it expired
          const s2 = this.d.load();
          const c = s2.cards[String(id)];
          // Told once: not again if he knows, nor while his own show of it is about to tell him.
          if (c && !c.lapseTold && !this.cainWaits.has(id)) { c.lapseTold = true; this.d.save(s2); this.d.relay(lapsedLine(id, c)); }
          continue;
        }
        this.log(`couldn't post card ${id} by itself; the next sweep tries again: ${reason(e)}`);
        if (/discord 429/.test(String(e))) break;          // rate limited: the rest at the next sweep
        const s2 = this.d.load();
        const c = s2.cards[String(id)];
        if (c && !c.told && !c.shown && !c.outcome) {
          c.told = true;
          this.d.save(s2);
          this.d.relay(failedLine(id, c, e, e instanceof Unsure, this.d.now()));
        }
        continue;
      }
      if (!out.first) continue;                        // Cain's own show got there first
      const c = this.d.load().cards[String(id)];
      this.log(`card ${id} went out by itself: Cain hadn't shown it in time`);
      this.d.relay(out.fromLink === false ? foundLine(id, c, out.message) : wentOutLine(id, c, out.message));
    }
  }

  // Once: cards posted before 0.7.0. His DM is the truth about which still have buttons.
  private async migrate(): Promise<void> {
    const { dm, bot } = await this.identity();
    const found: any[] = [];
    let before = "";
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const batch = await this.rest("GET", `/channels/${dm}/messages?limit=100${before ? `&before=${before}` : ""}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        const ids = buttonIds(m?.components);
        if (String(m?.author?.id ?? "") === bot && ids.length && ids.every((x) => x.startsWith("k:") || x.startsWith("q:"))) found.push(m);
      }
      before = String(batch[batch.length - 1].id);
      if (batch.length < 100) break;
    }
    const now = this.d.now();
    const s = this.d.load();
    const seen = new Set<string>();
    for (const m of found) {
      const id = String(m.id);
      seen.add(id);
      const rec = s.messages[id];
      if (rec?.kind) continue;                                   // a 0.7.0 card: the usual rules
      if (!rec) {
        if (snowflakeTime(id) > now - SETTLE_MS) continue;       // may be on its way into the state
        s.messages[id] = { digest: digest(m.content ?? "", m.components), until: now + REMEMBER_MS, kind: "legacy",
          item: "none", posted: snowflakeTime(id), buttons: true, outcome: "expired", why: "posted before 0.7.0",
          labels: labelsOf(m.components) };
        continue;
      }
      const posted = rec.until - REMEMBER_MS;
      Object.assign(rec, { item: "none", question: "", posted, buttons: true, labels: rec.labels ?? labelsOf(m.components) });
      // Every ask from before 0.7.0 expires now, answered or not, even one from this
      // morning: it was asked the old way, and the morning check-in asks again exactly.
      if (rec.card !== undefined) Object.assign(rec, { kind: "card", expires: s.cards[String(rec.card)]?.expires ?? null });
      else if (rec.q) Object.assign(rec, { kind: "ask", outcome: "expired", why: "posted before 0.7.0" });
      else Object.assign(rec, { kind: "morning", question: "morning", expires: null });
    }
    // Older than the look went back (or no buttons left): an unanswered ask may still
    // have its buttons, so it's taken off too; either way a tap on it does nothing.
    for (const [id, rec] of Object.entries(s.messages)) {
      if (rec.kind || seen.has(id)) continue;
      const ask = !!rec.q;
      Object.assign(rec, { kind: rec.card !== undefined ? "card" : ask ? "ask" : "morning", item: "none",
        posted: rec.until - REMEMBER_MS, buttons: ask && !rec.q!.used },
        ask ? { outcome: "expired", why: "posted before 0.7.0" } : {});
    }
    s.migrated = true;
    this.d.save(s);
    this.log(`looked over the cards already posted: ${found.length} with buttons`);
  }

  // Which live cards stopped mattering, and why.
  private async decide(): Promise<void> {
    const now = this.d.now();
    const pulls = new Map<string, string>();       // Ship card -> "head moved" or "merged or closed"
    if (this.d.pull) {
      for (const [id, m] of Object.entries(this.d.load().messages)) {
        if (m.kind !== "ship" || !m.ship || !live(m, now)) continue;
        if ((this.headChecked.get(id) ?? -Infinity) + HEAD_EVERY_MS > now) continue;
        this.headChecked.set(id, now);
        const p = await this.d.pull(m.ship.pr).catch(() => null);
        // A card for a head already in main stays: his tap on it gives the token to
        // install it (after a Stop came between landing and installing).
        const landedHere = p?.merged === true && p.head?.toLowerCase() === m.ship.head;
        if (p?.open === false && !landedHere) pulls.set(id, "merged or closed");
        else if (p?.head && p.head.toLowerCase() !== m.ship.head) pulls.set(id, "head moved");
      }
    }
    const f = this.files();
    const holds = parseHolds(f.holds);              // null: can't be read, so no hold decides anything
    const closed = closedItems(f.pending);
    const s = this.d.load();
    const newest = new Map<string, string>();
    for (const [id, m] of Object.entries(s.messages)) {
      const k = rivalKey(m);
      if (!k || !live(m, now)) continue;
      const cur = newest.get(k);
      if (!cur || (m.posted ?? 0) > (s.messages[cur].posted ?? 0)
          || ((m.posted ?? 0) === (s.messages[cur].posted ?? 0) && newerId(id, cur))) newest.set(k, id);
    }
    const told: [string, Shown, string][] = [];
    // The generation a verified read of the ledger has seen: a ledger below it is no verified read.
    const seen = s.ledgerGen ?? 0;
    const heldNow = new Set<string>();
    for (const [id, m] of Object.entries(s.messages)) {
      if (!m.buttons || m.outcome || !m.kind) continue;
      const item = boundItem(m);
      let why = "";
      // Round 18: a card's buttons come off at its expiry as a Discord time, through the measured offset; the
      // record's own Pi clock expiry only for a card the link can't place.
      if (m.expires != null && this.expiresBy(id, m, now)) why = "expired";
      else if (m.until - DAY <= now) why = "forgetting";
      else if (pulls.has(id)) why = pulls.get(id)!;
      else if (item && closed.has(item.toUpperCase())) why = "item closed";
      else if (item && holds && heldElsewhere(holds, item)) why = "held elsewhere";
      else if (item && (m.kind === "ask" || m.kind === "ship")) {
        // Buttons come off for a status change only on a verified read of an intact ledger and
        // working copy, never during or right after a push error; otherwise the card stays as
        // it is, logged once.
        const c = this.checkState(item, m.checked, { sweep: true, seen });
        if (c === "changed") why = "status changed";
        else if (c === "epoch") why = "record reset";
        else if (c !== "ok") {
          heldNow.add(`${id}:${c}`);
          if (!this.sweepHeld.has(`${id}:${c}`)) this.log(`left card ${id}'s buttons on: no verified read of the ledger (${c})`);
        }
        if (!why) { const k = rivalKey(m); if (k && newest.get(k) !== id) why = "replaced"; }
      }
      else { const k = rivalKey(m); if (k && newest.get(k) !== id) why = "replaced"; }
      if (!why) continue;
      m.outcome = why === "replaced" ? "replaced" : "expired"; m.why = why;
      told.push([id, m, why]);
    }
    this.sweepHeld = heldNow;
    const gen = this.verifiedGen(f, seen);
    if (gen !== null && gen > seen) { s.ledgerGen = gen; if (!told.length) this.d.save(s); }
    if (!told.length) return;
    this.d.save(s);
    for (const [id, m, why] of told) {
      const because: Record<string, string> = {
        "head moved": "the pull request's head moved, so that go would ship something else. Show a new Ship card for the new head once it's ready.",
        "merged or closed": "the pull request was merged or closed.",
        "item closed": `${m.item} is closed in PENDING.md.`,
        "held elsewhere": `${m.item} is now held by another session. Don't ask him about it or say who has it.`,
        "status changed": `${m.item}'s row changed after the source check it rested on, so its buttons came off ("${STATUS_CHANGED}"). Check it at its source again, and ask again with --checked if it still needs him.`,
        "record reset": `the record keeper reset its copy after it was posted, so the source check it rested on no longer counts and its buttons came off ("${EPOCH_CHANGED}"). Check ${m.item} at its source again, and once the keeper has accepted its re-check, ask again with --checked if it still needs him.`,
      };
      if ((m.kind !== "ask" && m.kind !== "ship") || !because[why]) continue;
      const what = m.kind === "ship" ? `Ship card for ${m.ship?.pr}` : `question ${about(m.item, m.question) || `"${excerpt(m.q?.q ?? "", 60)}"`}`;
      this.d.relay(`Your ${what} (Discord message ${id}) was taken off: ${because[why]} Nothing to tell him.`);
    }
  }

  private async stripDue(): Promise<void> {
    const due = Object.entries(this.d.load().messages).filter(([, m]) => m.buttons && m.outcome).map(([id]) => id);
    for (const id of due) if ((await this.strip(id)) === "limited") break;   // the rest at the next sweep
  }

  private async stripAll(ids: string[]): Promise<void> {
    for (const id of ids) if ((await this.strip(id)) === "limited") break;
  }

  // Buttons off, and the card says what happened. Best effort: what fails is tried
  // again at the next sweep.
  private async strip(id: string): Promise<"done" | "failed" | "limited"> {
    const m = this.d.load().messages[id];
    if (!m || !m.buttons) return "done";
    const line = outcomeLine(m);
    const gone = () => {
      const s = this.d.load();
      if (s.messages[id]) { s.messages[id].buttons = false; s.messages[id].off = this.d.now(); this.d.save(s); }
      return "done" as const;
    };
    const failed = (e: unknown) => {
      if (/discord 404/.test(String(e))) return gone();
      this.log(`couldn't take a card's buttons off: ${String(e).slice(0, 80)}`);
      return /discord 429/.test(String(e)) ? "limited" as const : "failed" as const;
    };
    let dm: string;
    try { dm = (await this.identity()).dm; } catch (e) { this.log(`can't reach Discord to take buttons off: ${String(e).slice(0, 80)}`); return "limited"; }
    const body: any = { components: [], allowed_mentions: { parse: [] } };
    if (line) {
      try {
        const cur = await this.rest("GET", `/channels/${dm}/messages/${id}`);
        body.content = withLine(String(cur?.content ?? ""), this.ownWords("outcome line", "link", line, id));
      } catch (e) { return failed(e); }
    }
    let msg: any;
    try { msg = await this.rest("PATCH", `/channels/${dm}/messages/${id}`, body); } catch (e) { return failed(e); }
    const s = this.d.load();
    const r = s.messages[id];
    if (r) {
      r.buttons = false;
      r.off = this.d.now();
      r.digest = digest(String(msg?.content ?? body.content ?? ""), []);
      if (r.q) r.q.used = true;
      if (r.card !== undefined && s.cards[String(r.card)]) s.cards[String(r.card)].rows = [];
      this.d.save(s);
    }
    this.log(`took the buttons off a card (${r?.why ?? r?.outcome ?? "done"})`);
    return "done";
  }

  // Held asks that can no longer go out: expired before their turn (at the morning
  // check-in), or their item closed or moved to someone else meanwhile.
  private dropStaleHeld(): string[] {
    const s = this.d.load();
    const now = this.d.now();
    const f = this.files();
    const holds = parseHolds(f.holds);
    const closed = closedItems(f.pending);
    const keep: Ask[] = [], lines: string[] = [];
    for (const h of s.held ?? []) {
      const what = about(h.item, h.question) || `"${excerpt(h.text, 60)}"`;
      const item = h.item !== "none" ? h.item : "";
      if (h.expires <= now) lines.push(`Your held question ${what} was never shown: it expired at the morning check-in. Ask again if it still matters.`);
      else if (item && closed.has(item.toUpperCase())) lines.push(`Your held question ${what} was dropped unasked: ${item} is closed in PENDING.md.`);
      else if (item && holds && heldElsewhere(holds, item)) lines.push(`Your held question ${what} was dropped unasked: ${item} is now held by another session. Don't ask him about it or say who has it.`);
      else if (item && !this.freshRef(item) && this.verifiedGen(f, s.ledgerGen ?? 0) !== null) lines.push(`Your held question ${what} was dropped unasked: its row changed after your source check. Check it at its source again, and ask again with --checked if it still needs him.`);
      else if (item && !this.freshRef(item)) { keep.push(h); continue; }   // no verified read just now: it waits
      else keep.push(h);
    }
    if (lines.length) { s.held = keep; this.d.save(s); for (const l of lines) this.d.relay(`${l} Nothing to tell him.`); }
    return lines;
  }

  // When no ask is open, the next held one goes out, and Cain is told it has.
  async releaseHeld(): Promise<void> {
    this.dropStaleHeld();
    await this.serial(async () => {
      const s = this.d.load();
      if (this.openAsk(s, this.d.now()) || !(s.held ?? []).length) return;
      const next = s.held!.shift()!;
      this.d.save(s);
      // A held ask, one from an older version too, is checked again under today's rules before
      // it goes out (its question and every option): one that fails them is dropped, never
      // retried as it is, and Cain asks again in words that pass. One held only because the
      // review service's lines can't be read just now waits in line for the next sweep (until
      // its own expiry), since its words may be fine. The lines are read once, so the check and
      // what its result means can't disagree when they come back in between.
      const published = this.published();
      try { this.recheckHeld(next, published); }
      catch (e) {
        if (!(e instanceof Refusal)) throw e;
        const waiting = published === null && [next.text, ...next.options].some((t) => claimsReview(t));
        if (waiting) {
          const s2 = this.d.load();
          s2.held = [next, ...(s2.held ?? [])];
          this.d.save(s2);
          this.log("a held question waits: the review service's lines can't be read just now");
          return;
        }
        const what = about(next.item, next.question);
        this.d.relay(`Your held question${what ? ` ${what}` : ""} wasn't posted: ${e.message} Ask it again in words that pass, if it still matters. Nothing to tell him.`);
        return;
      }
      let id: string;
      try { id = await this.postAsk(next); }
      catch (e) {
        if (e instanceof StaleCheck) {
          const what = about(next.item, next.question);
          this.d.relay(`Your held question${what ? ` ${what}` : ""} was dropped unasked: ${e.message} Nothing to tell him.`);
          return;
        }
        const s2 = this.d.load();
        s2.held = [next, ...(s2.held ?? [])];
        this.d.save(s2);
        this.log(`couldn't post a held question; it goes out at the next sweep: ${String(e).slice(0, 80)}`);
        return;
      }
      const what = about(next.item, next.question);
      this.d.relay(`Your held question${what ? ` ${what}` : ""} is now in front of Dane (Discord message ${id}): "${excerpt(next.text, 120)}" Nothing to tell him.`);
    });
  }
}

// -- the gateway protocol, without the socket (main.ts owns the socket) ----------------
export const INTENTS = 1 << 13;          // DIRECT_MESSAGE_REACTIONS: reactions, never messages
export const FATAL: Record<number, string> = { 4004: "token refused", 4010: "invalid shard",
  4011: "sharding required", 4012: "invalid version", 4013: "invalid intents", 4014: "intents not allowed" };

export class Protocol {
  seq: number | null = null;
  session: string | null = null;
  resumeUrl: string | null = null;
  interval = 0;
  lastAck = 0;
  constructor(private send: (o: unknown) => void, private token: () => string,
              private on: { ready?: () => void; interaction?: (d: any) => void; reaction?: (d: any) => void },
              private now: () => number = Date.now) {}

  identifyOrResume(): void {
    if (this.session) this.send({ op: 6, d: { token: this.token(), session_id: this.session, seq: this.seq } });
    else this.send({ op: 2, d: { token: this.token(), intents: INTENTS,
      properties: { os: "linux", browser: "cain-link", device: "cain-link" } } });
  }

  beat(): void { this.send({ op: 1, d: this.seq }); }
  dead(): boolean { return this.interval > 0 && this.now() - this.lastAck > this.interval * 2 + 5000; }

  // Returns "reconnect" when the socket should be dropped and opened again.
  handle(m: any): "ok" | "reconnect" {
    if (m.s != null) this.seq = m.s;
    switch (m.op) {
      case 10: this.interval = m.d.heartbeat_interval; this.lastAck = this.now(); this.identifyOrResume(); return "ok";
      case 11: this.lastAck = this.now(); return "ok";
      case 1: this.beat(); return "ok";
      case 7: return "reconnect";
      case 9: if (!m.d) { this.session = null; this.seq = null; } return "reconnect";
      case 0:
        if (m.t === "READY") { this.session = m.d.session_id; this.resumeUrl = m.d.resume_gateway_url; this.on.ready?.(); }
        else if (m.t === "RESUMED") this.on.ready?.();
        else if (m.t === "INTERACTION_CREATE") this.on.interaction?.(m.d);
        else if (m.t === "MESSAGE_REACTION_ADD") this.on.reaction?.(m.d);
        return "ok";
    }
    return "ok";
  }

  closed(code: number): "fatal" | "fresh" | "resume" {
    if (FATAL[code]) return "fatal";
    if (code === 4007 || code === 4009) { this.session = null; this.seq = null; return "fresh"; }
    return "resume";
  }
}
