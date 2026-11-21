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
//   them: a failed check, or one not run yet, refuses the card, and pcjobs-windows, whenever
//   the head's tests.yml names it or it ran there, refuses it unless every run of it GitHub
//   lists for that very head passed (merge.ts judgeChecks); merged at that head, it's in
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
import { createHash } from "node:crypto";
import { cainReasons, type CainHit, claimsReview, codesHits, mayHaveCode, recordItems, reviewedHits, shipWordsHits } from "../gate/cain";
import { asksSomething, snowflakeTime } from "../gate/plugin";
import { decideSend, type CardsView, type CardView, type Decision, type Writer } from "../gate/send";
import { AT, check as gateCheck, type Context, fixedWhat, type Hit, hostsOnly, imperative, reasonParts, RULES, RULES_VERSION, whyOf } from "../gate/rules";
import { keyOfRef, safeId } from "../review/core";
import { effectiveCap, GRANT_MAX, grantedRounds, grantsFor, GrantUnsaved, lastRound, type GrantRec, type Grants } from "../review/grants";
import { freshReviewed, type Reviewed } from "../reviewed";
import { DECISION_OPTIONS, RISK, armedFor, decisionSummary, decisionText, DecisionsUnsaved, fallbackText, namesRoundPastCap, type CapState } from "./cap";
import { holdLine, labelOf, logLine, type Label, type Verdict } from "../guard";
import { countedRounds, decisionOf, type DecisionRec, type Rounds } from "../review/rounds";
import { claimFor, type Claim, SHIP_REPOS } from "../ship-token";
import type { StopState } from "../stop";
import { judgeChecks, WINDOWS_CHECK, type Facts, type HeadChecks, type Landed } from "./merge";

export const STOP = "k:stop";
export const RESUME = "k:resume";
export const EXPIRED_TAP = "This card expired; nothing was done.";
// His tap on the review cap's decision card that couldn't be kept (0.16.0, round 2): to him alone, the card stays up.
export const DECISION_UNSAVED = "Your answer couldn't be saved, so nothing was decided yet. The card is still up: tap your answer again.";
// His grant tap that couldn't be kept (0.18.0): to him alone, the card stays up.
export const GRANT_UNSAVED = "Your grant couldn't be saved, so no rounds were added yet. The card is still up: tap it again.";
export const GRANT_NO = "No";
export const grantLabel = (n: number) => `Grant ${n} more round${n === 1 ? "" : "s"}`;
// First review of 0.18.0: an open grant card loses its buttons when another card's grant for the same
// change is written, and a grant tap whose checks no longer hold writes nothing; its card says why.
export const GRANT_REPLACED = "Replaced by a newer grant";
const GRANT_REFUSED = "Nothing was granted: ";
// Second review of 0.18.0: a passing failure at his Grant tap (the holds file, the runner's records or the pull
// request's head can't be read just then) keeps the card's buttons, and he's told to try again in a minute.
export const grantRetry = (what: string) => `${what} can't be read right now, so nothing was granted yet. The card is still up: try again in a minute.`;
// How long his tap waits for GitHub's answer on the pull request's head, so it's answered within Discord's 3 seconds.
const GRANT_HEAD_MS = 2000;
export const EXPIRED = "Expired";
// The one card gate (round 3): asks, Ship cards, the review cap's decision card and a usage-guard hold's
// description all go through cainWords with this rule set, the same object, never a copied list.
export const CARD_RULES = AT.cain;
// The guard-hold route's bounds (round 3): calls a minute per caller, and how long an identical refusal
// (label and description) is logged once.
export const HOLDS_PER_MINUTE = 6;
export const HOLD_DEDUPE_MS = 10 * 60_000;
export const HOLD_ALARM_QUIET_MS = 3_600_000;
export const REPLACED = "Replaced by a newer card";
const COMPONENT = 3;
const ACK = 6;
const UPDATE = 7;
const EPHEMERAL = 64;
const REMEMBER_MS = 35 * 86400_000;
const DAY = 86400_000;
const HOUR = 3_600_000;
const FACTS_MS = 6_000;                  // how long a Ship card waits for GitHub (its facts and checks, asked at once) before it says it couldn't read them
// 0.12.2: the card's wait for the gate's head read ran out (an abort at its time limit), named as the gate's state unknown.
export const GATE_HEAD_TIMED_OUT = "the read of the pull request's head from GitHub was stopped at its time limit (a timeout)";
const SETTLE_MS = 10 * 60_000;           // a message younger than this may still be on its way into the state
const HEAD_EVERY_MS = 5 * 60_000;        // how often a Ship card's pull request is looked at
const LANDING_STALE_MS = 5 * 60_000;     // a landing still unsettled this long after his tap was cut off (a restart)
const LANDING_TRY_MS = 2 * 3_600_000;    // while GitHub doesn't answer, a landing is tried again this long after his tap
const KEY_CHECK_MS = DAY;                // how often the link asks GitHub whether it still knows the deploy key
const LANDING_LINE = "You tapped Ship: landing it in main now.";
const STOPPED_FIRST: Landed = { ok: false, why: "his Stop came first", again: false, stopped: true };
const HISTORY_PAGES = 5;                 // the one-time look over his DM: up to 500 messages back
const ASK_GRACE_MS = 2 * 3_600_000;      // an ask lives until the first morning check-in at least this far off
const SHOW_WAIT_MS = 2 * 60_000;         // a card with buttons Cain hasn't shown by then goes out by itself
// The PC job keeper's lines to him (pcjobs/main.ts tell): each names what happened and the fix,
// with its Troubleshooting row in cain/docs/pc-jobs.md.
export const PC_NOTICES: Record<string, string> = {
  reuse_migrated: "Your PC job keeper counted a tap of yours approving a reused value as used: an older version wrote it down without the record that could show whether its job reached your PC. If you still want that check, Cain asks you again.",
  reuse_shallow: "Your PC job keeper can't settle a tap of yours approving a reused value, because its copy of the PC job queue is shallow. Fix: delete the pc-jobs folder in the Cain App's data and restart the App (pc-jobs.md, Troubleshooting). Other PC jobs go on, and the tap stays used meanwhile.",
  queue_branch_missing: "Your PC job keeper stopped: the PC job queue's main branch is missing on GitHub while a tap of yours approving a reused value waits to be settled. Fix: restore the main branch in the pc-jobs repository (pc-jobs.md, Troubleshooting). The keeper goes on by itself once it is back.",
  queue_empty_pending: "Your PC job keeper stopped: the PC job queue on GitHub is empty while a tap of yours approving a reused value waits to be settled. Fix: give the queue its first commit again, as in setup step 2 (pc-jobs.md, Troubleshooting); the tap then counts as used.",
  reuse_store_unreadable: "Your PC job keeper can't read its record of the taps you spent on reused values, so it takes no job that reuses a value until it can. Other PC jobs go on. Fix: see the store row in pc-jobs.md, Troubleshooting.",
  reuse_unsettled: "Your PC job keeper can't tell whether a job made from a tap of yours approving a reused value reached your PC: git gave no clear answer. The tap stays used, other PC jobs go on, and it tries again each round. If it lasts, see pc-jobs.md, Troubleshooting.",
  reuse_push_refused: "A PC job made from a tap of yours approving a reused value didn't reach your PC's queue: GitHub refused it three times. The tap stays used for now and is settled at the keeper's next round with a successful fetch from GitHub (within a minute while GitHub answers), once that fetch shows none of it arrived; then the job is queued again by itself. If it keeps being refused, check the pc_jobs_token option (pc-jobs.md, Troubleshooting).",
  reuse_record_unreadable: "Your PC job keeper has tried for three rounds to settle a tap of yours approving a reused value, written by an older version, but a file in its copy of the PC job queue can't be read. The tap stays used and other PC jobs go on. Fix: see the reuse_record_unreadable row in pc-jobs.md, Troubleshooting.",
  reuse_fetch_failed: "Your PC job keeper has tried for three rounds to settle a tap of yours whose job GitHub refused three times, but it couldn't fetch the PC job queue from GitHub. The tap stays used until a round's fetch succeeds. Fix: see the reuse_fetch_failed row in pc-jobs.md, Troubleshooting (usually the network or the pc_jobs_token option).",
  hold_clear_unrecorded: "Your PC isn't taking jobs: its worker couldn't write its record of clearing a version hold (version-hold-cleared.json in the worker folder), so the hold stays. At the PC: free disk space or fix the worker folder's permissions so that file can be written, then start a run (pc-jobs.md, Troubleshooting).",
  worker_start_refused: "Your PC isn't taking jobs: its worker refused to start because a setting meant only for its tests is set where it runs (the PC_WORKER_TEST_BUILD variable, or a preload, require, import or loader flag in NODE_OPTIONS or BUN_OPTIONS, or a bunfig.toml preload). At the PC: remove it as the worker's own refusal says, open a new terminal, then start a run (pc-jobs.md, Troubleshooting).",
  worker_not_starting: "Jobs are waiting for your PC, or one ran out of time waiting, and its worker hasn't been heard from while they waited. If it was started and nothing happened, a setting on the PC may be stopping it before it can start or say why, such as a preload in BUN_OPTIONS or NODE_OPTIONS set in Windows' environment settings. At the PC: follow the worker-not-starting row in pc-jobs.md, Troubleshooting.",
  // 0.12.2, third pass: the same condition, seen in the keeper's copy while the queue couldn't be reached for hours.
  worker_not_starting_unconfirmed: "Jobs have been waiting for your PC and its worker hasn't been heard from, but this isn't confirmed: your PC job keeper hasn't been able to read the PC job queue reliably for hours, so its copy of the PC's last check-in may just be old. If the worker was started and nothing happened, follow the worker-not-starting row in pc-jobs.md, Troubleshooting.",
  queue_unreachable: "Your PC job keeper hasn't been able to reach the PC job queue on GitHub for about half an hour, so new PC jobs wait and results don't come back. It keeps trying by itself. If it lasts, the usual causes are the Pi's network or the pc_jobs_token option (pc-jobs.md, Troubleshooting).",
  // 0.12.2: the same, raised again within a day of it clearing.
  queue_unreachable_again: "Your PC job keeper can't reach the PC job queue on GitHub again, within a day of it coming back, so new PC jobs wait and results don't come back. It keeps trying by itself. If it keeps happening, the usual causes are the Pi's network or the pc_jobs_token option (pc-jobs.md, Troubleshooting).",
  notice_undelivered: "Your PC job keeper had an earlier notice for you that could not be delivered, and after its update it can no longer say which one. If something about PC jobs seems stuck, see pc-jobs.md, Troubleshooting; Cain can read the keeper's log.",
};
export const PC_NOTICE_REPEAT = "Said again, in case it didn't reach you before:";
// A code the keeper sends that this link has no words for (a keeper ahead of the link).
export const PC_NOTICE_CODE = /^[a-z][a-z0-9_]{0,39}$/;
export const PC_NOTICE_ID = /^[0-9a-f]{16,64}$/;
export const PC_JOB_ID = /^j-\d{8}-[a-z0-9]{6}$/;
// A PC job as the owner's line names it (0.12.0, twenty-second round): by what it does, its site and action
// (the queue's own shapes), never by its queue id.
const PC_SITE = /^(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const PC_ACTION = /^[a-z][a-z0-9_]{2,39}$/;
export const pcJobWords = (j: { site: string; action: string }) => `the job to ${j.action.replace(/_/g, " ")} on ${j.site}`;
// A job the keeper can't name by its site and action (twenty-third round): by a time, in words, never an id.
// Twenty-fifth round: the time is when the keeper saw the job (its record of it, or the moment it was handed the
// job in a shape it couldn't read), not when the owner's request was queued, so it is worded "a PC browser job
// seen by the keeper at Nov 15, 2:05 PM" ("seen by the keeper on Nov 15" when only the day is known). The
// structured field keeps its name (queued).
export const PC_QUEUED = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
export function pcQueuedWords(queued: string, tz = "America/New_York"): string | null {
  if (!PC_QUEUED.test(queued)) return null;
  const day = queued.length === 10;
  const t = Date.parse(day ? `${queued}T12:00:00Z` : queued);
  if (!Number.isFinite(t)) return null;
  const f = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat("en-US", { ...o, timeZone: day ? "UTC" : tz }).format(t); } catch { return new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(t); } };
  return day ? `a PC browser job seen by the keeper on ${f({ month: "short", day: "numeric" })}` : `a PC browser job seen by the keeper at ${f({ month: "short", day: "numeric" })}, ${f({ hour: "numeric", minute: "2-digit" })}`;
}
// The notice ids the link remembers having posted (twenty-eighth round: by age, PC_NOTICE_RETAIN_MS, the keeper's
// NOTICE_DEDUP_MS; PC_NOTICE_KEEP only bounds the store's size, far above what the keeper sends in that time).
export const PC_NOTICE_RETAIN_MS = 30 * DAY;
const PC_NOTICE_KEEP = 5_000;
export const pcNoticeUnknown = (code: string) => `Your PC job keeper reported a stop condition the App does not know, code ${code}, see troubleshooting in pc-jobs.md.`;
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
const MACHINE: [RegExp, string][] = [[/\b[0-9a-f]{40}\b/i, "a commit sha"], [/\bcse_[A-Za-z0-9]/, "a job id"], [/\bj-\d{8}-[a-z0-9]{6}\b/, "a PC job id"],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "an ISO time"]];
const LIMIT = 2000;
const SUPPRESS_EMBEDS = 1 << 2;
const DIRECT_KINDS = new Set(["stopped", "resumed", "alert"]);
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const QUESTION = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,39}$/;
const SNOWFLAKE = /^\d{15,22}$/;
// The one answer of an owner-reuse ask that approves it (reuseProof): its first option.
export const REUSE_YES = "Use it";
const SHA = /^[0-9a-f]{40}$/;
export const PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

export type Rest = (method: string, path: string, body?: unknown, auth?: boolean, timeoutMs?: number) => Promise<any>;
// Link previews off on everything the link puts in his DM (security watch, Cain 0.13.0): a
// post, an ephemeral answer and a tap's new message carry Discord's SUPPRESS_EMBEDS flag from
// the start, so a link in a message never unfurls into a preview fetched from its site.
// Second round: the flag only ever goes onto bits already there, never clearing one.
//   - a first post (a message, a webhook's, a tap's new message): ORed onto its own flags;
//   - an edit that carries flags: ORed onto them and onto the message's flags as last seen;
//   - an edit that sets words and carries none: only when the message's flags are known (the
//     link reads them first when it doesn't know them) and lack the bit, as those flags ORed
//     with it; one that has the bit already is sent as it was (Discord keeps a message's flags);
//   - a tap's update of its message (type 7): ORed onto flags it carries, never added alone
//     (answer() puts the tapped message's own flags in first when it sets words);
//   - anything else as it was.
// added: whether a flags value went that the caller didn't write, so a refusal of it (a 400 whose
// body names flags) is tried once more without the added bit, with a "preview flag refused" line in
// the gate report: a flag problem shows a preview, never a dead card.
// Third round: every flags value that goes out is masked to the bits Discord takes on a post, an
// edit or a tap's answer (EDITABLE_FLAGS; EPHEMERAL too on an interaction's own answer or webhook).
// Bits Discord sets itself and only reports (HAS_THREAD, CROSSPOSTED, LOADING, HAS_SNAPSHOT and the
// rest) never go back. known: the message's flags as last read; null: the read before an edit
// failed or timed out, so the edit goes as the caller wrote it (masked), without the added bit.
export const SUPPRESS_NOTIFICATIONS = 1 << 12;
export const IS_COMPONENTS_V2 = 1 << 15;
export const EDITABLE_FLAGS = SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS | IS_COMPONENTS_V2;
export function maskFlags(flags: unknown, interaction = false): number {
  return (Number(flags) || 0) & (EDITABLE_FLAGS | (interaction ? EPHEMERAL : 0));
}
export interface Quieted { body: unknown; added: boolean }
export const MESSAGE_PATH = /^\/channels\/\d+\/messages\/(\d+)$/;
const isInteraction = (path: string) => /^\/interactions\//.test(path) || /^\/webhooks\//.test(path);
// The caller's own body with its flags masked and nothing added: what a retry sends after a refusal
// that names flags, and what an edit sends when the message's flags couldn't be read.
export function masked(path: string, body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, any>, i = isInteraction(path);
  const m = (o: Record<string, any>) => ("flags" in o ? { ...o, flags: maskFlags(o.flags, i) } : o);
  return /^\/interactions\//.test(path) && b.data && typeof b.data === "object" ? { ...b, data: m(b.data) } : m(b);
}
export function quiet(method: string, path: string, body: unknown, known?: number | null): Quieted {
  const same = { body, added: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) return same;
  const b = body as Record<string, any>;
  const interaction = isInteraction(path);
  const or = (o: Record<string, any>, more = 0) => {
    const base = maskFlags(o.flags, interaction);
    const flags = maskFlags(base | more | SUPPRESS_EMBEDS, interaction);
    return { body: { ...o, flags }, added: !("flags" in o) || flags !== base };
  };
  if (method === "POST" && (/^\/channels\/\d+\/messages$/.test(path) || /^\/webhooks\/[^/]+\/[^/]+$/.test(path))) return or(b);
  if (method === "PATCH" && MESSAGE_PATH.test(path)) {
    if (known === null) return { body: masked(path, b), added: false };
    if ("flags" in b) return or(b, known ?? 0);
    if (!("content" in b) || known === undefined || (known & SUPPRESS_EMBEDS)) return same;
    return or(b, known);
  }
  if (method === "POST" && /^\/interactions\//.test(path) && b.data && typeof b.data === "object") {
    if (b.type === 4 || "flags" in b.data) { const q = or(b.data); return { body: { ...b, data: q.body }, added: q.added }; }
  }
  return { body: masked(path, b), added: false };
}
// A refusal that names the flags field (Discord's 400 lists the fields it refused; the link's rest
// puts their names after the message): only that is tried again without the added bit.
export const namesFlags = (e: unknown) => /discord 400\b/.test(String(e)) && /\bflags\b/i.test(String(e));
// Discord's error as the link throws it: the status, its message, and the names of the fields it
// refused (errors: {flags: {_errors: [...]}, data: {flags: ...}}), never values.
export function discordError(status: number, data: any): string {
  const names: string[] = [];
  const walk = (o: any, at: string, depth: number) => {
    if (!o || typeof o !== "object" || depth > 4 || names.length >= 6) return;
    for (const k of Object.keys(o)) {
      if (k === "_errors") continue;
      const here = at ? `${at}.${k}` : k;
      if (/^[A-Za-z0-9_]{1,40}$/.test(k)) { if (o[k] && typeof o[k] === "object" && "_errors" in o[k]) names.push(here); walk(o[k], here, depth + 1); }
    }
  };
  walk(data?.errors, "", 0);
  return `discord ${status}: ${String(data?.message ?? "").slice(0, 100)}${names.length ? ` (fields: ${names.join(", ")})` : ""}`;
}
export const PRE_EDIT_READ_MS = 1_500;   // the read of a message's flags before an edit, at most
// A path for a log line: an interaction's or webhook's token cut short.
const shortPath = (path: string) => path.replace(/\/[^/]{40,}/g, "/…");

export interface Card {
  text: string; rows: any[]; kind: string; created: number; shown: string | null; expires?: number | null;
  due?: number | null;               // when it goes out by itself if Cain hasn't shown it (cards with buttons, from 0.7.2)
  outcome?: "expired";               // its own expiry passed before it went out: it never goes out
  posting?: Posting;                 // a post whose answer never came: it may be on Discord already
  told?: boolean;                    // Cain was told it couldn't go out by itself
  lapseTold?: boolean;               // Cain was told it expired before it reached him
  req?: string;                      // the specialist's signed request that made it (C1): one request, one card
  announce?: string;                 // Cain's line about it, kept until it went (C1 re-check F1)
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
  kind?: Kind;                       // absent on records from before 0.7.0 until the first sweep
  item?: string; question?: string;  // what the card is about: a PENDING id (or "none") and a question id
  posted?: number;
  expires?: number | null;           // when its buttons stop mattering; null: no time of its own
  ship?: { pr: string; head: string };
  own?: string;                      // a Ship card the link built: Cain's own line on it, the rest being the link's (0.11.0)
  buttons?: boolean;                 // it has buttons on Discord, as far as the link knows
  outcome?: "answered" | "expired" | "replaced";
  why?: string;                      // for the log: what made it expire
  label?: string;                    // answered: the label he tapped
  words?: boolean;                   // answered in a message, not a tap
  byItself?: boolean;                // a specialist's card that went out by itself; Cain's show then files it
  // His Ship tap, landing in main (0.8.1): when it began, how it ended, and the card's
  // words before it, for the line that says how it went.
  shipping?: { state: "landing" | "landed" | "not landed"; at: number; text: string; why?: string;
    tries?: number; next?: number;    // it can't land yet: how often it was tried, and when it's tried next
    line?: string; edited?: boolean }; // the line his card shows now, and whether Discord took that edit
  toggle?: string;                   // the link's own Stop notice: the button it carries (STOP or RESUME)
  values?: string[];                 // an ask: the values it quoted ("..."), as the link posted it, for owner reuse (0.12.0, askValues)
  decision?: { id: string; key: string; pr: string | null; unarmed?: boolean };   // the review runner's decision card at the round cap (0.16.0, cap.ts); unarmed: posted while the rollback wasn't armed (round 2)
  grant?: { key: string; rounds: number; pr: string | null; reason: string;       // Cain's grant card for extra review rounds (0.18.0, ../review/grants.ts)
    used?: number; cap?: number;     // the runner's round count and the change's cap when it was posted: checked again at the tap
    // Second review: the state it was posted on, checked again at the tap: the pull request's head commit (null for a
    // change that isn't a pull request) and the id of the change's newest decision then (null: none). Missing: unbound.
    head?: string | null; decision?: string | null };
}
// The values an ask quotes, in straight double quotes, as the link posts it: what a "Use it"
// tap on it can approve for reuse in a PC job (reuseProof). Each one line of 4 to 300
// characters; at most 3 (more, and none count).
export function askValues(text: string): string[] {
  const out = [...String(text ?? "").matchAll(/"([^"\r\n]{4,300})"/g)].map((m) => m[1]);
  return out.length <= 3 ? out : [];
}
export interface Ask {               // Cain's question waiting behind the open one
  text: string; options: string[]; item: string; question: string; replyTo?: string; at: number; expires: number;
  nonce?: string;                    // the same on every try, so Discord never posts it twice
}
export interface State {
  owner?: string; dm?: string; bot?: string; next: number;
  saveGen?: number;                  // which save this is (publish.ts stateFile: the newer copy wins)
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
  pcNotices?: Record<string, { msg: string; at: number }>;   // the PC job keeper's notice ids already posted (0.12.0, twenty-first round)
  // The review runner's decision cards waiting while their item is held by another holder (0.16.0,
  // round 2), by decision id: one each, tried again at each sweep until the hold clears.
  decisions?: Record<string, Partial<DecisionRec> & { since: number }>;
}
// last: the newest part of what he sent; asks: its last line asks something. Seeded ids
// have neither, so they never hold the moving Stop.
export interface SentRec { at: number; last?: boolean; asks?: boolean }

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
const OUTCOME = /\n\n(?:You answered(?::| in a message)[^\n]*|Answered|Expired|Replaced by a newer card|Turned back on since\.|Stopped again since\.|You tapped Ship[^\n]*|Shipped: [^\n]*|Not shipped: [^\n]*)$/;
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
export interface RecordFiles { pending: string | null; holds: string | null }   // null: no such file
export type Holds = Record<string, { holder?: string; branches?: string[] }>;

// The holds, from the record keeper's own file (/data/record-holds.json): written
// whole, only once its push is on GitHub, with the holds under "holds". A missing
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

export class Refusal extends Error {}

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
  if (m.grant && m.outcome === "replaced" && m.why === GRANT_REPLACED) return GRANT_REPLACED;
  if (m.grant && m.why?.startsWith(GRANT_REFUSED)) return m.why;
  if (m.outcome === "replaced") return REPLACED;
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
  save: (s: State) => void;
  now: () => number;
  relay: (text: string) => void;                                   // a line typed in to Cain
  toHarness: (path: string, body: unknown) => Promise<boolean>;     // a tap on its card
  paired: () => string;                                            // who Cain is paired with
  log?: (line: string) => void;
  record?: () => RecordFiles;                                      // PENDING.md and the keeper's holds
  pull?: (pr: string) => Promise<Pull | null>;                     // a pull request now; null: can't tell
  tz?: string;                                                     // the check-ins' zone
  stop?: { read: () => StopState; write: (stopped: boolean, at: number) => void };   // Stop everything
  signShip?: (claim: Claim) => string | null;                      // his Ship tap as a token; null: no key
  // His Ship tap, landed in main with the deploy key (merge.ts); absent: no key, nothing lands.
  land?: (l: { pr: string; head: string; stopped: () => boolean }) => Promise<Landed>;
  landed?: (ship: { pr: string; head: string }) => Promise<boolean | null>;   // that head in main now; null: can't tell
  facts?: (pr: string, head?: string) => Promise<Facts | null>;    // what GitHub says the pull request changes (its Apps' versions read at head)
  checkRuns?: (pr: string, head: string) => Promise<HeadChecks | "missing" | null>;
  gateWatch?: (pr: string) => string[] | { unknown: string } | { owed: string };     // every unsuperseded head a ship_gate watch of this pull request accepted, the gate state unknown, or (twenty-eighth round) an acceptance with a supersede owed (shipgate.ts gateState)
  // 0.12.2: the pull request's head as the gate reads it (shipgate.ts gateHeadRead, through its curl wrapper), within ms:
  // the head, or the gate's state unknown, named. Absent (the tests' rig): the facts' head is used, as before.
  gateHead?: (pr: string, ms: number) => Promise<string | { unknown: string }>;
  factsMs?: number;                                                // how long a Ship card waits for them (tests)
  reviewed?: () => Reviewed[] | null;                              // the review service's lines (../reviewed.ts); null: can't be read
  // The review-round cap (0.16.0, cap.ts): where a pull request stands at it, the probe's record of the
  // rollback (its text; null: none), his tap on a decision card kept, the cap and the rounds now.
  capState?: (pr: string) => CapState;
  armed?: () => string | null;
  // Throws when his tap couldn't be kept (round 2: the card stays tappable). Round 3: returns the record
  // as kept (cap.ts recordDecision), whose choice drives the card, the relay and the hold line.
  decided?: (id: string, choice: string, at: number) => { choice: string; at: number; existed: boolean } | void;
  roundCap?: () => number;
  rounds?: () => Rounds | null;
  // 0.18.0: the owner's grants of extra rounds (null: can't be read), and his grant tap kept durably
  // (../review/grants.ts recordGrant; throws when it couldn't be kept: the card stays up).
  grants?: () => Grants | null;
  grant?: (rec: GrantRec) => { rec: GrantRec; existed: boolean };
  // Round 2: the install-time self-check's finding (null: every file right; else the cap and guard are
  // off), the usage guard as the link runs it for a part of Cain's that was refused (it decides again
  // from its own readings and logs a refusal), and one line onto the guard's log (the open list's holds).
  capOff?: () => string | null;
  guardHold?: (label: Label, what: string) => Verdict;
  holdLog?: (line: string) => boolean | void;                       // true: the log was rotated at its size cap (round 3)
  // Round 3: whether the guard's log already has a hold line (tag, what); the App's alarms (kind and
  // cause; a group cleared); and the cap's own work at each sweep (the self-check again, the decisions
  // file's moved-aside copy).
  hasHold?: (tag: string, what: string) => boolean;
  alarm?: (kind: string, cause: string) => void;
  clearAlarm?: (group: string) => void;
  capSweep?: () => void;
  keyKnown?: () => Promise<"known" | "refused" | "host key" | null>;   // does GitHub still know the deploy key; null: no answer
  // The gate (piece D): what the rules found at a send point, and what was done.
  report?: (r: GateReport) => void;
  linkHosts?: () => ReadonlySet<string>;
  keeperSent?: (at: number) => void;                               // a keeper.sh reply went out (gate/held.ts: the check-in's waiting line)                           // the hosts Cain normally cites (gate/hosts.ts); absent: no notices
  // The replay: Cain's own replies and edits as his transcripts have them (since a time),
  // where its report goes, and the pause between pages of his DM (tests: 0).
  transcripts?: (since: number) => Sent | Promise<Sent>;
  writeReplay?: (r: ReplayReport) => string | void;             // where it was written
  replayPauseMs?: number;
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

export type AskResult = { status: "posted"; message: string; said?: string } | { status: "held"; said: string };

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
  private keyLocks = new Map<string, Promise<void>>();   // one operation at a time for each grant change key (underKey)
  private sweeping = false;
  private headChecked = new Map<string, number>();
  private going = new Map<number, Promise<Put>>();   // cards being put up now (putUp)
  private cainWaits = new Set<number>();             // cards Cain's show waits on now: a lapse found meanwhile is his to hear
  private limitedAt = -Infinity;                     // when Discord last rate-limited the link
  private rest: Rest;
  constructor(private d: Deps) {
    // Every call to Discord, noting a rate limit: the moving Stop waits a minute after one.
    this.rest = async (...a) => {
      const [method, path, body, ...more] = a;
      try {
        const known = await this.flagsFor(method, path, body);
        const q = quiet(method, path, body, known);
        if (known === null) {
          // The read failed: the edit goes as the caller wrote it, and the report notes it.
          this.reportFlag("flags unread", path, "the message's flags couldn't be read before the edit: sent without the preview flag");
        }
        try { return this.sawFlags(path, await d.rest(method, path, q.body, ...more)); }
        catch (e) {
          if (!q.added || !/discord 400/.test(String(e))) throw e;
          // Only a 400 that names flags is the flag's: anything else is logged, and nothing is sent twice.
          if (!namesFlags(e)) { this.log(`Discord refused ${method} ${shortPath(path)}: ${String(e).slice(0, 160)}`); throw e; }
          this.log(`Discord refused the preview flag on ${method} ${shortPath(path)}: sent again without it`);
          this.reportFlag("preview flag refused", path);
          return this.sawFlags(path, await d.rest(method, path, masked(path, body), ...more));
        }
      } catch (e) { if (/discord 429/.test(String(e))) this.limitedAt = d.now(); throw e; }
    };
  }

  // Each message's flags as Discord last answered them (0.13.0, second round), so an edit never
  // sends a flags value that drops a bit the message has. Kept for the newest 500 messages.
  private flags = new Map<string, number>();
  private sawFlags(path: string, msg: any): any {
    const id = msg && typeof msg === "object" && /^\/channels\/\d+\/messages/.test(path) ? String(msg.id ?? "") : "";
    if (id && typeof msg.flags === "number") {
      this.flags.delete(id);
      this.flags.set(id, msg.flags);
      if (this.flags.size > 500) this.flags.delete(this.flags.keys().next().value!);
    }
    return msg;
  }
  private reportFlag(did: string, path: string, note?: string) {
    try { this.d.report?.({ point: "preview flag", writer: "link", hits: [], did, ...(note ? { note } : {}), ...(MESSAGE_PATH.exec(path) ? { message: MESSAGE_PATH.exec(path)![1] } : {}) }); }
    catch (r) { this.log(`couldn't log the gate's report: ${String(r).slice(0, 80)}`); }
  }
  // The flags an edit has to keep: as last seen, or read from Discord now for an edit that sets words
  // or flags of a message the link hasn't seen. undefined: nothing to keep; null: the read failed or ran
  // past PRE_EDIT_READ_MS (third round), so the edit goes as the caller wrote it, without the added bit.
  private async flagsFor(method: string, path: string, body: unknown): Promise<number | null | undefined> {
    const m = method === "PATCH" ? MESSAGE_PATH.exec(path) : null;
    if (!m || !body || typeof body !== "object" || !("content" in body || "flags" in body)) return undefined;
    if (this.flags.has(m[1])) return this.flags.get(m[1]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cur = this.sawFlags(path, await Promise.race([
        this.d.rest("GET", path, undefined, true, PRE_EDIT_READ_MS),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error("TimeoutError: the read of its flags ran out of time")), PRE_EDIT_READ_MS + 100); }),
      ]));
      return typeof cur?.flags === "number" ? cur.flags : undefined;
    } catch (e) {
      this.log(`couldn't read a message's flags before an edit: ${String(e).slice(0, 80)}`);
      return null;
    } finally { if (timer) clearTimeout(timer); }
  }
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
        ...(mayHaveCode(text) ? { items: this.itemIds() } : {}), plugin: true, hosts: this.d.linkHosts?.() ?? null });
    return { status: "ok", ...d };
  }

  // keeper.sh reply (Cain 0.13.0, second round): a reply of Cain's with a link in it, posted by the link
  // with the preview off from the first moment (SUPPRESS_EMBEDS on the post itself), since the plugin's
  // own reply sets no flags. The same gate as his plugin replies (decideSend, less the rule that sends
  // links here, and with no third try): "add-on" fixed as it goes, anything else refused with what to
  // change. The message is recorded as his own reply, not the link's, so he can still edit it, and it
  // counts for the moving Stop like any reply of his.
  async reply(a: { text?: unknown; replyTo?: unknown }): Promise<{ status: "posted"; message: string; said: string }> {
    const text = String(a.text ?? "");
    if (!text.trim()) throw new Refusal("needs the text to send");
    const replyTo = a.replyTo === undefined || a.replyTo === null || a.replyTo === "" ? undefined : String(a.replyTo).trim();
    if (replyTo !== undefined && !SNOWFLAKE.test(replyTo)) throw new Refusal("a message id is a Discord id");
    const { dm } = await this.identity();
    const d = decideSend({ tool: "reply", text, replyTo, chat: dm }, this.cardsNow(),
      { tz: this.d.tz, now: this.d.now(), ...(claimsReview(text) ? { reviewed: this.published() } : {}),
        ...(mayHaveCode(text) ? { items: this.itemIds() } : {}), hosts: this.d.linkHosts?.() ?? null });
    const did = d.would === "refuse" ? "refused" : d.would === "fix" ? "fixed" : "posted";
    if (d.hits.length && this.d.report) {
      try { this.d.report({ point: "keeper reply", writer: "cain", hits: d.hits as Hit[], did }); }
      catch (e) { this.log(`couldn't log the gate's report: ${String(e).slice(0, 80)}`); }
    }
    if (d.would === "refuse") throw new Refusal(d.said);
    const words = d.would === "fix" ? d.fixed : text;
    const msg = await this.post(words, [], replyTo ? { replyTo } : {});
    try { this.d.keeperSent?.(this.d.now()); } catch (e) { this.log(`couldn't note a keeper reply: ${String(e).slice(0, 80)}`); }
    await this.sent({ tool: "reply", ids: [String(msg.id)], question: asksSomething(words), call: `keeper-${String(msg.id)}`,
      ...(replyTo ? { reply_to: replyTo } : {}) }, { background: true });
    return { status: "posted", message: String(msg.id), said: d.would === "fix" ? `Posted, with its wording fixed: ${fixedWhat(d.hits as Hit[])}.` : "Posted." };
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

  private remember(s: State, msg: any, extra: Partial<Shown> = {}): void {
    const now = this.d.now();
    this.prune(s, now);
    const id = String(msg.id);
    s.messages[id] = { ...(s.messages[id] ?? {}), ...extra,
      digest: digest(msg.content ?? "", msg.components), until: now + REMEMBER_MS };
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
  async addCard(c: { text: string; rows?: any[]; kind?: string; expires?: unknown; req?: string }): Promise<number> {
    // A request already made a card (the link stopped before it could answer, or failed): that
    // card, never a second one. A notice that goes out at once and isn't out yet goes now: its
    // post is once only, by its posting mark and a look in his DM first (C1 re-check R2, R3).
    if (c.req) {
      const had = Object.entries(this.d.load().cards).find(([, v]) => v.req === c.req);
      if (had) {
        const [hid, card] = had;
        if (DIRECT_KINDS.has(card.kind) && !card.shown && !card.outcome) await this.deliverDirect(Number(hid), card.kind);
        this.announce(Number(hid));
        return Number(hid);
      }
    }
    const kind = String(c.kind ?? "reply");
    const comps = (c.rows ?? []).filter((r: any) => (r.components ?? []).every((b: any) =>
      String(b.custom_id ?? "").startsWith("k:")));                  // a specialist can't make Cain's buttons
    // The specialist's words: em dashes and "add-on" fixed, and stored that way, so the card
    // posted is exactly the card kept. Refused only for a button it tells him to use and doesn't carry
    // (below); anything else the gate flags goes out, and Cain hears.
    const w = this.words("card", "specialist", String(c.text ?? ""), { rules: AT.card, buttons: labelsOf(comps), known: this.liveLabels() });
    // 0.12.0: a card that tells him to use a button it doesn't carry ("Tap Go ahead", "the Undo button")
    // points him at something that isn't there, so it's refused, not flagged: the specialist hears why
    // (each label in straight double quotes, which it parses), Cain once, and the gate's report logs it.
    // A label only mentioned ("there's no Go ahead", "with Undo") is flagged and goes out as it is.
    const text0 = String(c.text ?? "");
    const missing = w.hits.filter((h) => h.rule === "button" && h.result === "refuse" && h.label && imperative(text0, h.at, h.end));
    if (missing.length) {
      this.report("card", "specialist", w.hits, "refused");
      const said = [...new Set(missing.map((h) => `"${h.label}"`))].join(", ");
      this.d.relay(`The calendar specialist sent a card naming ${said}, which isn't on it, so the link refused it and nothing went to him. Nothing to tell him; it's logged for a fix.`);
      throw new Refusal(`the card names ${said}, which it doesn't carry`);
    }
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
    // Cain's line about it, kept with the card in the same save and cleared once it went, so a
    // request that comes again after the link stopped or failed in between tells him then.
    const flagged = w.refused.length ? flaggedLine(w.refused) : "";
    let announce = "";
    if (DIRECT_KINDS.has(kind)) {
      if (flagged) announce = `The calendar specialist's notice (card ${id}) went out to him with words the message gate flags: ${flagged}. Nothing to do unless it matters to him; then set it right in one line of your own.`;
    } else {
      const ask = due !== null ? "It has buttons: show it now, or it goes out by itself in about 2 minutes."
        : "Show it now if it matters today, or fold it into the morning message.";
      const flag = flagged ? ` The message gate flags its words: ${flagged}. It goes out as it is; if it matters, set it right in one line of your own after it.` : "";
      announce = `The calendar specialist has a card for Dane (card ${id}): "${excerpt(text, 120)}". ${buttonsLine(labelsOf(comps))}${flag} ${ask} Run /opt/cain/keeper.sh show ${id} --item <its PENDING id, or none> (add --reply-to <his message id> when it answers a message of his). The item is only its label: the card goes out whoever holds the item, open or closed.`;
    }
    s.cards[String(id)] = { text, rows: comps, kind, created: now, shown: null, expires, due, ...(c.req ? { req: c.req } : {}), ...(announce ? { announce } : {}) };
    for (const [k, v] of Object.entries(s.cards)) if (v.created + REMEMBER_MS <= now) delete s.cards[k];
    this.d.save(s);
    if (DIRECT_KINDS.has(kind)) await this.deliverDirect(id, kind);
    this.announce(id);
    return id;
  }

  // Tells Cain the line kept on a card, then clears it (C1 re-check F1). A card with buttons
  // already out by itself needs no "show it" line: he heard it went out. Should the link stop
  // between telling him and clearing it, he's told twice: harmless, since a card is posted once
  // however often it's shown ("already out").
  private announce(id: number): void {
    const card = this.d.load().cards[String(id)];
    if (!card?.announce) return;
    if (!card.shown || DIRECT_KINDS.has(card.kind)) this.d.relay(card.announce);
    const s = this.d.load();
    const c = s.cards[String(id)];
    if (c) { delete c.announce; this.d.save(s); }
  }

  // A notice that goes out at once (Stop, Turn back on, an alert), under no item.
  private async deliverDirect(id: number, kind: string): Promise<string> {
    const shown = await this.show(id, { item: "none" });
    if (shown && (kind === "stopped" || kind === "resumed")) await this.retireToggles(shown);
    // A Turn back on notice with a Stop of its own: a moving Stop placed meanwhile comes off.
    if (shown && kind === "resumed") void this.inStopQueue(() => this.placeStop());
    return shown;
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

  // -- extra review rounds for a change, granted by his tap (0.18.0, ../review/grants.ts) --
  // Cain's keeper.sh review-grant: a card asking him whether to grant a change at its cap 1 to 3 more
  // fix rounds. What it says about the change's rounds comes from the runner's record (how many it used,
  // what the last one left), never from Cain's words; Cain's line names what the change does. Two buttons,
  // "Grant <n> more rounds" and "No"; it expires with the next morning check-in like his asks. Only his
  // tap writes the grant: this writes nothing. Refused while the change has rounds left (nothing to
  // grant), while its last round is still running, while its item is held by another holder, while Stop
  // holds, and (first review) while another grant card for the same change key is still open, naming
  // when that one went up. His tap checks all of it again before it writes (grantBlock).
  async reviewGrant(a: { item?: unknown; change?: unknown; rounds?: unknown; text?: unknown; replyTo?: unknown }): Promise<AskResult> {
    const meta = checkMeta({ item: a.item, replyTo: a.replyTo });
    if (meta.item === "none") throw new Refusal("a grant card is filed under the change's item: its PENDING id");
    if (this.stopped().stopped) throw new Refusal("Everything is stopped: Dane tapped Stop, so no grant card until he taps Turn back on. Only he can; don't ask him to.");
    const off = this.capOff();
    if (off) throw new Refusal(`the review cap's files aren't right (${off}), so no grant card goes out until they are`);
    const n = Number(a.rounds);
    if (!Number.isInteger(n) || n < 1 || n > GRANT_MAX) throw new Refusal(`rounds must be 1 to ${GRANT_MAX}`);
    const ref = String(a.change ?? "").trim();
    const key = keyOfRef(ref);
    if (!key) throw new Refusal("change must be the pull request's address or the change key its briefs name");
    const why = String(a.text ?? "").replace(/\s+/g, " ").trim();
    if (!why) throw new Refusal("say why, in one or two lines: what the change does and why more fix rounds are worth it");
    if (why.length > 300) throw new Refusal("say why in one or two lines");
    noMachineText(why);
    let rounds: Rounds | null = null, grants: Grants | null = null;
    try { rounds = this.d.rounds?.() ?? null; } catch { rounds = null; }
    try { grants = this.d.grants?.() ?? null; } catch { grants = null; }
    if (!rounds) throw new Refusal("the review rounds file can't be read, so no grant card can go out");
    if (!grants) throw new Refusal("the review grants file can't be read, so no grant card can go out");
    const base = this.d.roundCap?.() ?? 3;
    const used = countedRounds(rounds, key).length;
    if (!used) throw new Refusal(`${key} has had no review round yet: nothing to grant`);
    const had = grantsFor(rounds, grants, key);
    const cap = effectiveCap(base, rounds, grants, key);
    if (used < cap) throw new Refusal(`${key} has rounds left (${used} of ${cap} used): nothing to grant. Submit its next fix-only round as usual`);
    const last = lastRound(rounds, key);
    if (last.state === "running" || last.state === "none") throw new Refusal(`${key}'s last review round hasn't finished yet: ask once it has`);
    this.mayAsk(meta.item);
    // The pull request, from the key or from the change's own record.
    const pm = /^pr-(\d+)$/.exec(key);
    const prUrl = (PULL.test(ref) ? ref : null) ?? rounds.changes[key]?.pr ?? null;
    const prNum = pm ? pm[1] : (prUrl ? /\/pull\/(\d+)$/.exec(prUrl)?.[1] ?? null : null);
    // Second review: the card is bound to the state it's posted on, the pull request's head and the newest decision.
    const decision = decisionOf(rounds, key)?.id ?? null;
    let head: string | null = null;
    if (prUrl) {
      const h = await this.headNow(prUrl);
      if (typeof h !== "string") throw new Refusal(`the pull request's head can't be read from GitHub right now (${h.unknown}), so no grant card can go out: ask again in a minute`);
      head = h;
    }
    const w = this.cainWords("grant", "grant card", why.replace(/[.\s]+$/, ""), { rules: CARD_RULES, buttons: [grantLabel(n), GRANT_NO], known: this.liveLabels() }, { reviewed: true });
    const left = last.state === "lost" ? "its last round did not complete, so what it would have found isn't known"
      : last.serious ? `its last round still left ${last.serious === 1 ? "one serious finding" : `${last.serious} serious findings`}`
      : "its last round left nothing serious";
    const prior = had.length ? `, ${grantedRounds(had)} of them granted by you before` : "";
    const text = `${w.text}${prNum ? ` (pull request ${prNum})` : ""}. It has used all ${used} of its outside review rounds${prior}, and ${left}. `
      + `Grant it ${n} more fix round${n === 1 ? "" : "s"}, for ${cap + n} in all? A grant only allows more rounds: it never exempts the change from the rule, and shipping it with a risk named still needs the App's rollback armed.`;
    const shown = this.cardGate("grant", "grant card", text, [grantLabel(n), GRANT_NO]);
    if (!shown) throw new Refusal("the grant card's words didn't pass the card gate: say what the change does in plain words, with no record codes, counts or machine text");
    const options = [grantLabel(n), GRANT_NO];
    const question = `grant:${key}`;
    const now = this.d.now();
    const nonce = stableNonce("grant", meta.item, key, String(n), shown, String(cap));
    // Under the change key's lock (the one his taps take), then one post at a time: an open card for the key is
    // retired when what it was posted on is stale, and otherwise refuses this one.
    return this.underKey(`grant:${key}`, () => this.serial(async () => {
      await this.openGrantCard(key, { used, cap, decision, head, pr: prUrl });
      const msg = await this.postCard(shown, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
        { replyTo: meta.replyTo, nonce });
      const s = this.d.load();
      this.remember(s, msg, { kind: "ask", item: meta.item, question, posted: now, expires: this.askExpiry(now), buttons: true, labels: [...options],
        q: { q: `Grant ${key} ${n} more review round${n === 1 ? "" : "s"}?`, options, used: false },
        grant: { key, rounds: n, pr: prUrl, reason: w.text, used, cap, head, decision } });
      const replaced = this.markReplaced(s, String(msg.id));
      this.d.save(s);
      await this.stripAll(replaced);
      this.log(`a grant card for ${key} (${n} more round${n === 1 ? "" : "s"}) went to him`);
      return { status: "posted" as const, message: String(msg.id),
        said: `Posted. Only his tap grants the rounds; you'll hear it like any tap. Until then ${key} stays at its cap of ${cap}.` };
    }));
  }

  // One operation at a time for each key (second review of 0.18.0): his grant taps and a new grant card for the
  // same change key run one after another, in this process, so two can't both pass the checks before either writes.
  private underKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.keyLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.keyLocks.set(key, tail);
    void tail.then(() => { if (this.keyLocks.get(key) === tail) this.keyLocks.delete(key); });
    return run;
  }

  // A pull request's head now, as GitHub has it, within GRANT_HEAD_MS (his tap is answered within Discord's 3
  // seconds), or why it can't be told.
  private async headNow(pr: string): Promise<string | { unknown: string }> {
    if (!this.d.pull) return { unknown: "the link can't read pull requests" };
    const p = await within(Promise.resolve().then(() => this.d.pull!(pr)).catch(() => null), GRANT_HEAD_MS);
    return p?.head ? p.head : { unknown: p ? "GitHub gave no head" : "GitHub didn't answer" };
  }

  // Whether a card's message is gone from his DM: only Discord's own 404 says so (anything else can't tell).
  private async messageGone(id: string): Promise<boolean> {
    try { const { dm } = await this.identity(); await this.rest("GET", `/channels/${dm}/messages/${id}`); return false; }
    catch (e) { return /discord 404/.test(String(e)); }
  }

  // One open grant card a change key (first review of 0.18.0): a second is refused, naming when the open
  // one went up. Second review: it never deadlocks. An open card whose bound state is stale (the head moved, a
  // newer decision, the round count or cap changed, a card bound to nothing, or its message gone from the chat) is
  // retired first: its open state cleared on disk, its buttons taken off with "Replaced by a newer card".
  private async openGrantCard(key: string, now: { used: number; cap: number; decision: string | null; head: string | null; pr: string | null }): Promise<void> {
    const at = this.d.now();
    const open = Object.entries(this.d.load().messages).filter(([, m]) => m.grant?.key === key && live(m, at) && !m.q?.used);
    const standing: [string, Shown][] = [];
    for (const [id, m] of open) {
      const g = m.grant!;
      let why = g.used !== now.used || g.cap !== now.cap ? "its round count or cap changed"
        : g.decision === undefined || g.head === undefined ? "it was bound to nothing"
        : g.decision !== now.decision ? "a newer decision came"
        : (g.pr ?? now.pr) && g.head !== now.head ? "the pull request's head moved"
        : "";
      if (!why && (await this.messageGone(id))) why = "its message is gone from the chat";
      if (!why) { standing.push([id, m]); continue; }
      const s = this.d.load();
      const r = s.messages[id];
      if (!r || r.outcome || !r.buttons) continue;
      r.outcome = "replaced"; r.why = "replaced";
      if (r.q) r.q.used = true;
      this.d.save(s);
      this.log(`an open grant card for ${key} was stale (${why}): retired for the new one`);
      await this.strip(id);
    }
    if (!standing.length) return;
    const [id, m] = standing[0];
    const posted = m.posted ?? snowflakeTime(id);
    throw new Refusal(`a grant card for ${key} is already open (posted at ${posted ? clockTime(posted, this.d.tz) : "an unknown time"}, Discord message ${id}): `
      + "no second one while it stands. He answers that one, or it expires at the next morning check-in");
  }

  // Everything the card was posted on, checked again at his Grant tap before anything is written (first
  // review of 0.18.0): Stop clear, the cap's files right, the change still at its cap with no round
  // running, its item held by no one else and not closed, and the runner's round count and the change's
  // cap still what the card was posted on. Second review: run under the change key's lock, and also the
  // newest decision and the pull request's head still the ones the card was bound to. The plain line for him
  // when one fails (retry: a passing failure to read, which keeps the card up), or null.
  private async grantBlock(g: NonNullable<Shown["grant"]>, item: string): Promise<{ line: string; retry?: boolean } | null> {
    if (this.stopped().stopped) return { line: "Everything is stopped, so this grant can't be written until you tap Turn back on" };
    if (this.capOff()) return { line: "The review records aren't set up right just now, so this grant can't be written" };
    let rounds: Rounds | null = null, grants: Grants | null = null;
    try { rounds = this.d.rounds?.() ?? null; } catch { rounds = null; }
    try { grants = this.d.grants?.() ?? null; } catch { grants = null; }
    if (!rounds || !grants) return { line: grantRetry("The review records"), retry: true };
    const used = countedRounds(rounds, g.key).length;
    const cap = effectiveCap(this.d.roundCap?.() ?? 3, rounds, grants, g.key);
    if (used < cap) return { line: "That change has rounds left now, so this grant isn't needed" };
    const last = lastRound(rounds, g.key);
    if (last.state === "running" || last.state === "none") return { line: "That change has a review round running now, so this grant can't be written" };
    if (item && item !== "none") {
      const f = this.files();
      const holds = parseHolds(f.holds);
      if (holds === null) return { line: grantRetry("Who is working on that change"), retry: true };
      if (heldElsewhere(holds, item)) return { line: "That change is being worked on by another session now, so this grant can't be written" };
      if (closedItems(f.pending).has(item.toUpperCase())) return { line: "That change's item is closed now, so this grant isn't needed" };
    }
    if (g.used !== used || g.cap !== cap) return { line: "That change's review rounds have moved on since this card went up, so this grant can't be written" };
    if (g.decision === undefined || g.head === undefined) return { line: "This card was posted before grants were bound to the change as it stood, so this grant can't be written" };
    if ((decisionOf(rounds, g.key)?.id ?? null) !== g.decision) return { line: "A newer decision on that change has come since this card went up, so this grant can't be written" };
    if (g.pr) {
      const h = await this.headNow(g.pr);
      if (typeof h !== "string") return { line: grantRetry("The pull request's newest commit"), retry: true };
      if (h !== g.head) return { line: "That pull request has new commits since this card went up, so this grant can't be written" };
    }
    return null;
  }

  // A passing failure at his Grant tap: nothing written, the card keeps its buttons and stays open, and he's told
  // in one line, to him alone, to try again in a minute. Cain isn't told: nothing happened yet.
  private async grantRetryTap(it: any, g: NonNullable<Shown["grant"]>, line: string): Promise<string> {
    this.log(`his tap on the grant card for ${g.key} wrote nothing for now, the card stays up: ${line}`);
    await this.answer(it, ACK);
    await this.ephemeral(it, line);
    return "retry";
  }

  // A grant tap that failed its checks: nothing written, the card loses its buttons and says why, and he
  // gets the same line to him alone. Cain hears it like any tap.
  private async grantRefused(it: any, s: State, msgId: string, line: string, label?: string): Promise<string> {
    const m = s.messages[msgId];
    const g = m.grant!;
    m.outcome = "expired"; m.why = `${GRANT_REFUSED}${line.charAt(0).toLowerCase()}${line.slice(1)}.`;
    if (m.q) m.q.used = true;
    const content = withLine(String(it.message?.content ?? ""), m.why);
    m.digest = digest(content, []);
    this.d.save(s);
    this.log(`his tap on the grant card for ${g.key} wrote nothing: ${line}`);
    this.d.relay(`Dane tapped ${label ? `"${label}" ` : ""}on your grant card for ${g.key}, but nothing was granted: ${line}. `
      + `(Discord message ${msgId}; the card shows it.) Don't ask again unless the change is at its cap with its last round done.`);
    const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    const s2 = this.d.load();
    if (s2.messages[msgId]) { s2.messages[msgId].buttons = !ok; if (ok) s2.messages[msgId].off = this.d.now(); this.d.save(s2); }
    await this.ephemeral(it, `${line}.`);
    if (m.kind === "ask") await this.releaseHeld();
    return `refused: ${line}`;
  }

  // His tap on a grant card: "Grant" checks everything again (grantBlock), then writes the grant durably
  // (the card stays up if it can't be kept), and takes the buttons off every other open grant card for
  // the same change key; "No" writes nothing. Either way it's logged, and kept beside his other taps
  // (decided). The line for Cain and the cards replaced, "unsaved" when the grant couldn't be kept (he was
  // told; the card stays tappable), or { out } when its checks failed (answered already).
  // His checks (grantBlock) ran just before, under the same lock, and s is read after them.
  private async grantTap(it: any, s: State, m: Shown, msgId: string, label: string): Promise<{ note: string; replaced: string[] } | "unsaved"> {
    const g = m.grant!;
    const at = this.d.now();
    if (label === GRANT_NO) {
      this.log(`Dane turned down a grant of ${g.rounds} more review round${g.rounds === 1 ? "" : "s"} for ${g.key}`);
      try { this.d.decided?.(`grant:${g.key}:${msgId}`, label, at); } catch (e) { this.log(`couldn't keep his No on the grant card beside his taps: ${String(e).slice(0, 80)}`); }
      return { note: ` No rounds were granted: ${g.key} stays at its cap.`, replaced: [] };
    }
    const rec: GrantRec = { id: `${g.key}+${msgId}`, key: g.key, rounds: g.rounds, by: "owner", at: new Date(at).toISOString(),
      message: msgId, reason: g.reason, item: m.item && m.item !== "none" ? m.item : null, pr: g.pr };
    let kept: { rec: GrantRec; existed: boolean };
    try {
      if (!this.d.grant) throw new GrantUnsaved("the link has nowhere to keep it");
      kept = this.d.grant(rec);
    } catch (e) {
      this.log(`couldn't keep his grant for ${g.key}; the card stays up: ${String(e).slice(0, 120)}`);
      await this.answer(it, ACK);
      await this.ephemeral(it, GRANT_UNSAVED);
      return "unsaved";
    }
    this.log(`Dane granted ${g.rounds} more review round${g.rounds === 1 ? "" : "s"} for ${g.key}${kept.existed ? " (kept already)" : ""}`);
    try { this.d.decided?.(`grant:${g.key}:${msgId}`, label, at); } catch (e) { this.log(`couldn't keep his grant tap beside his taps: ${String(e).slice(0, 80)}`); }
    // Every other open grant card for this change key: replaced by this grant.
    const replaced: string[] = [];
    for (const [id, o] of Object.entries(s.messages)) {
      if (id === msgId || o.grant?.key !== g.key || !o.buttons || o.outcome) continue;
      o.outcome = "replaced"; o.why = GRANT_REPLACED;
      if (o.q) o.q.used = true;
      replaced.push(id);
    }
    if (replaced.length) this.log(`his grant for ${g.key} replaced ${replaced.length} other open grant card${replaced.length === 1 ? "" : "s"}`);
    let cap = "";
    try {
      const rounds = this.d.rounds?.() ?? null, grants = this.d.grants?.() ?? null;
      if (rounds && grants) cap = ` Its cap is now ${effectiveCap(this.d.roundCap?.() ?? 3, rounds, grants, g.key)}.`;
    } catch { /* said without it */ }
    return { replaced, note: ` He granted ${g.key} ${g.rounds} more fix round${g.rounds === 1 ? "" : "s"}.${cap} Submit the next fix-only round with review.sh as usual; if the last granted round still leaves something serious, the review service puts the decision to him again.` };
  }

  // -- Cain's own words with buttons ----------------------------------------------
  private openAsk(s: State, now: number): [string, Shown] | null {
    // The runner's decision card neither waits behind Cain's asks nor holds them back (0.16.0).
    for (const [id, m] of Object.entries(s.messages)) if (m.kind === "ask" && !m.decision && !m.grant && live(m, now)) return [id, m];
    return null;
  }

  // The owner's one decision at the review-round cap (0.16.0, cap.ts): only the review runner asks for
  // it, on root's socket. The link writes its words and its fixed options, files it under the brief's
  // item (or none), and it stays up until he taps it. The same decision posted twice is one card.
  // Round 2: its words go through the same card gate as every other card to him (counts, machine text,
  // record codes), with a fixed fallback and the topic when they fail; the item's hold is checked as for
  // any ask, and a decision for an item held by another holder waits (one per decision, tried again at
  // each sweep) and answers "held"; a lost final round says so; and while the rollback isn't armed the
  // card says up front that a Ship would be refused.
  async decision(d: Partial<DecisionRec>): Promise<{ status: "posted"; message: string } | { status: "held"; said: string }> {
    const off = this.capOff();
    if (off) throw new Refusal(`the review cap's files aren't right (${off}), so no decision card goes out until they are`);
    const id = String(d.id ?? ""), key = String(d.key ?? "");
    if (!/^[a-z0-9][a-z0-9-]{2,63}#\d{1,3}$/.test(id) || !id.startsWith(`${key}#`)) throw new Refusal("a decision needs its id and change key");
    const lost = d.lost === true;
    const round = Number(d.round), serious = Number(d.serious);
    if (!Number.isInteger(round) || round < 1 || !Number.isInteger(serious) || serious < (lost ? 0 : 1)) throw new Refusal("a decision needs its round and its serious findings");
    if (!String(d.topic ?? "").trim() || (!lost && !String(d.finding ?? "").trim())) throw new Refusal("a decision needs its topic and its finding");
    const item = d.item && ITEM.test(String(d.item)) ? String(d.item).toUpperCase() : "none";
    const pr = d.pr && PULL.test(String(d.pr)) ? String(d.pr) : null;
    const prior = Object.entries(this.d.load().messages).find(([, m]) => m.decision?.id === id);
    if (prior) return { status: "posted", message: prior[0] };
    // The item's hold, as for any ask: held by another holder (or the holds can't be read) waits.
    const wait = this.decisionWaits(item);
    if (wait) {
      const s = this.d.load();
      const had = s.decisions?.[id];
      (s.decisions ??= {})[id] = { ...d, id, key, item, pr, since: had?.since ?? this.d.now() };
      this.d.save(s);
      if (!had) this.log(`the decision card for ${key} waits: ${wait}`);
      return { status: "held", said: `the decision card waits: ${wait}; the link tries again at each sweep` };
    }
    let unarmed = false;
    try { unarmed = !armedFor(null, this.d.armed?.() ?? null).armed; } catch { unarmed = true; }
    const text = this.decisionWords({ topic: String(d.topic), finding: String(d.finding ?? ""), round, serious, lost, unarmed });
    const options = [...DECISION_OPTIONS];
    const nonce = stableNonce("decision", id);
    return this.serial(async () => {
      const again = Object.entries(this.d.load().messages).find(([, m]) => m.decision?.id === id);
      if (again) return { status: "posted" as const, message: again[0] };
      const msg = await this.postCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"), { nonce });
      const s = this.d.load();
      this.remember(s, msg, { kind: "ask", item, question: "", posted: this.d.now(), expires: null, buttons: true, labels: [...options],
        q: { q: decisionSummary({ topic: String(d.topic) }), options, used: false }, decision: { id, key, pr, ...(unarmed ? { unarmed: true } : {}) } });
      if (s.decisions?.[id]) delete s.decisions[id];
      this.d.save(s);
      return { status: "posted" as const, message: String(msg.id) };
    });
  }
  // Why a decision card for this item can't go up now ("" when it can): another holder has the item, or
  // the holds can't be read.
  private decisionWaits(item: string): string {
    if (item === "none") return "";
    const holds = parseHolds(this.files().holds);
    if (holds === null) return "the holds can't be read";
    if (heldElsewhere(holds, item)) return `${item} is held by another holder`;
    return "";
  }
  // The card's words through the card gate: round 3, the identical gate asks and Ship cards use
  // (cainWords with CARD_RULES, record codes included), and the fallback with the topic when its full
  // text fails (the topic left off too when it fails alone).
  private decisionWords(d: { topic: string; finding: string; round: number; serious: number; lost: boolean; unarmed: boolean }): string {
    const passes = (t: string): string | null => this.cardGate("decision", "decision card", t, [...DECISION_OPTIONS]);
    return passes(decisionText(d)) ?? passes(fallbackText(d.topic, d.unarmed)) ?? this.ownWords("decision", "link", fallbackText(null, d.unarmed));
  }
  // The card gate as a check: the words fixed, or null when it refuses them (logged either way).
  private cardGate(point: string, what: string, text: string, buttons: string[] = []): string | null {
    try { return this.cainWords(point, what, text, { rules: CARD_RULES, buttons, known: this.liveLabels() }).text; }
    catch (e) { if (e instanceof Refusal) return null; throw e; }
  }
  private capOff(): string | null {
    try { return this.d.capOff?.() ?? null; } catch (e) { return `the check failed: ${String(e).slice(0, 60)}`; }
  }
  // Decisions waiting on an item's hold, tried again at each sweep.
  private async retryDecisions(): Promise<void> {
    const waiting = Object.values(this.d.load().decisions ?? {});
    for (const d of waiting) {
      try { await this.decision(d); }
      catch (e) {
        this.log(`a waiting decision card didn't go: ${String(e).slice(0, 80)}`);
        if (e instanceof Refusal && !/files aren't right/.test(e.message)) {           // it can never go: dropped, the runner asks again
          const s = this.d.load(); if (s.decisions?.[String(d.id)]) { delete s.decisions[String(d.id)]; this.d.save(s); }
        }
      }
    }
  }

  // The usage guard for a part of Cain's that it refused (the Build hook, review.sh; Cain's key): the
  // link decides again from its own readings, and only a refusal is appended to the guard's log, which
  // is root's (round 2). "held" once it's logged; "passes" when the link's reading lets it run.
  // Round 3, bounded: at most HOLDS_PER_MINUTE calls a minute per caller (one alarm when that's hit), an
  // identical refusal (label and description) logged once in HOLD_DEDUPE_MS, the log capped in size and
  // rotated root-side (main.ts, cap.ts appendCapped), and the description put through the card gate
  // before it's logged: one that fails becomes "a build labelled <label>".
  private holdCalls = new Map<string, number[]>();
  private holdSeen = new Map<string, number>();
  private holdAlarmAt: number | null = null;
  guardHoldFor(b: { label?: unknown; what?: unknown }, caller = "cain"): { status: "held"; why: string; repeat?: true } | { status: "passes" } {
    const off = this.capOff();
    if (off) throw new Refusal(`the usage guard's files aren't right (${off}), so the hold can't be logged`);
    const now = this.d.now();
    const calls = (this.holdCalls.get(caller) ?? []).filter((t) => now - t < 60_000);
    if (calls.length >= HOLDS_PER_MINUTE) {
      this.holdsCapHit(`more than ${HOLDS_PER_MINUTE} holds in a minute from ${caller}`);
      throw new Refusal(`more than ${HOLDS_PER_MINUTE} holds in a minute: this one isn't logged. Try again in a minute`);
    }
    calls.push(now);
    this.holdCalls.set(caller, calls);
    const label = labelOf(b.label === undefined ? undefined : String(b.label));
    if (!label) throw new Refusal("a hold names its label: core, commitment, necessary-fix or other");
    const raw = String(b.what ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 160);
    if (!raw) throw new Refusal("a hold says what was refused");
    if (!this.d.guardHold) throw new Refusal("the link has no usage guard to log with");
    const what = this.cardGate("hold", "hold's description", raw) ?? `a build labelled ${label}`;
    const v = this.d.guardHold(label, what);
    if (v.ok) return { status: "passes" };
    for (const [k, t] of this.holdSeen) if (now - t >= HOLD_DEDUPE_MS) this.holdSeen.delete(k);
    const key = `${label}\t${what}`;
    if (this.holdSeen.has(key)) return { status: "held", why: v.why, repeat: true };
    if (!this.d.holdLog) throw new Refusal("the hold couldn't be written to the guard's log");
    let rotated: boolean | void;
    try { rotated = this.d.holdLog(logLine(new Date(now), label, what, v)); }
    catch (e) { this.log(`couldn't log a hold: ${String(e).slice(0, 80)}`); throw new Refusal("the hold couldn't be written to the guard's log"); }
    this.holdSeen.set(key, now);
    if (rotated === true) this.holdsCapHit("the guard's log reached its size cap, so the App rotated it, keeping one previous file");
    return { status: "held", why: v.why };
  }
  // One alarm when a cap of the hold route is hit; cleared at a sweep once an hour passed without one.
  private holdsCapHit(cause: string): void {
    const first = this.holdAlarmAt === null;
    this.holdAlarmAt = this.d.now();
    this.log(`the guard-hold route hit its cap: ${cause}`);
    if (first) { try { this.d.alarm?.("review-holds", cause); } catch (e) { this.log(`couldn't raise the hold route's alarm: ${String(e).slice(0, 80)}`); } }
  }
  private capSweep(): void {
    try { this.d.capSweep?.(); } catch (e) { this.log(`the review cap's sweep failed: ${String(e).slice(0, 80)}`); }
    if (this.holdAlarmAt !== null && this.d.now() - this.holdAlarmAt >= HOLD_ALARM_QUIET_MS) {
      this.holdAlarmAt = null;
      try { this.d.clearAlarm?.("holds"); } catch (e) { this.log(`couldn't clear the hold route's alarm: ${String(e).slice(0, 80)}`); }
    }
  }

  async ask(a: { text: string; options: string[]; item?: unknown; question?: unknown; replyTo?: unknown }): Promise<AskResult> {
    const meta = checkMeta(a);
    const raw = (a.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 5);
    const asked = unlabeled(String(a.text ?? ""), meta.item, meta.question).trim();
    if (!asked) throw new Refusal("an ask needs its question");
    if (!raw.length) throw new Refusal("an ask needs at least one option; open questions go through the reply tool");
    noMachineText(asked, ...raw);
    // The review-round cap (0.16.0): the decision at the cap is the review service's card alone, and no
    // ask may offer a round past it.
    if (raw.some((o) => o.toLowerCase() === RISK.toLowerCase()))
      throw new Refusal("the decision at the review-round cap is the review service's own card: it posts it itself when the last round leaves something serious. Ask nothing about it, and offer no review round past the cap");
    let rounds: Rounds | null = null, grants: Grants | null = null;
    try { rounds = this.d.rounds?.() ?? null; } catch { rounds = null; }
    try { grants = this.d.grants?.() ?? null; } catch { grants = null; }
    const past = namesRoundPastCap([asked, ...raw].join("\n"), this.d.roundCap?.() ?? 3, rounds, grants);
    if (past) throw new Refusal(`this names ${past}, past the review-round cap of ${this.d.roundCap?.() ?? 3}: the owner's rule allows no more rounds for a change, and the review service asks him the one decision itself. Take it out`);
    // The gate, before the nonce is made: the same words always make the same card.
    const opts = raw.map((o) => this.cainWords("ask option", "ask's option", o, { rules: ["dash", "app", "count", "machine"] }, { reviewed: true }));
    const w = this.cainWords("ask", "ask", asked, { rules: CARD_RULES, buttons: opts.map((o) => o.text), known: this.liveLabels() }, { reviewed: true });
    const options = opts.map((o) => o.text);
    const fixed = fixedSaid([...w.fixed, ...opts.flatMap((o) => o.fixed)]);
    const text = w.text;                 // no "P08 Q2: ": the item and question are data
    this.mayAsk(meta.item);
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

  private async postAsk(e: Ask): Promise<string> {
    const nonce = e.nonce ?? stableNonce("ask", e.item, e.question, e.text, e.options.join("\u0001"), e.replyTo ?? "");
    // Checked when it was asked; one held since before 0.10.0 gets the fixes now, and one held
    // since before 0.11.0 loses the label it was stored with ("P08 Q2: ").
    const text = this.words("ask", "cain", unlabeled(e.text, e.item, e.question), { rules: ["dash", "app"] }).text;
    const options = e.options.map((o) => this.words("ask option", "cain", o, { rules: ["dash", "app"] }).text);
    const msg = await this.postCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: e.replyTo, nonce });
    const s = this.d.load();
    this.remember(s, msg, { kind: "ask", item: e.item, question: e.question, posted: this.d.now(), expires: e.expires,
      buttons: true, labels: [...options], q: { q: excerpt(text), options, used: false }, values: askValues(text) });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return String(msg.id);
  }

  // A Ship card: Ship / Not now, for one pull request at one head. Doesn't wait its
  // turn; lasts as long as an ask, and goes when the head moves or the pull request
  // is merged or closed. Cain's words say what Dane will notice; the link builds the rest
  // (shipText), from GitHub and from the review he names (review: its id, or none).
  async ship(a: { text: string; item?: unknown; pr?: unknown; head?: unknown; review?: unknown; replyTo?: unknown }): Promise<AskResult> {
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
    // The review-round cap (0.16.0, cap.ts): at the cap with a serious finding left, his decision first.
    let risk = false;
    let cap: CapState = { state: "none" };
    try { cap = this.d.capState?.(pr) ?? { state: "none" }; } catch (e) { cap = { state: "unknown", why: String(e).slice(0, 80) }; }
    if (cap.state === "unknown") throw new Refusal(`where this pull request stands at the review-round cap is unknown (${cap.why}): no Ship card until it can be read`);
    if (cap.state === "waiting") throw new Refusal("its last review round left something serious, and his decision on it (ship it with that risk, or hold it) is still open: no Ship card until he taps it");
    if (cap.state === "hold") throw new Refusal("he chose to hold it at the review-round cap: no Ship card for it. A fix is new work, with its own item and a new change, or more fix rounds if he grants them (keeper.sh review-grant asks him)");
    if (cap.state === "pending") throw new Refusal(`${cap.why}: no Ship card until a granted round leaves nothing serious, or the review service's next decision card has his tap`);
    if (cap.state === "risk") risk = true;
    const w = this.cainWords("ship", "Ship card", said, { rules: CARD_RULES, buttons: ["Ship", "Not now"], known: this.liveLabels() },
      { shipWords: true });
    // Without GitHub to read (only the tests' rig has none), the card is his words alone.
    if (risk && !this.d.facts) {
      const a = armedFor(null, this.d.armed?.() ?? null);
      if (!a.armed) throw new Refusal(`he chose to ship it with the risk named, which needs the App's rollback armed, and ${a.why}: no Ship card until it is`);
    }
    const built = this.d.facts ? await this.shipText(pr, head, review, w.text, risk) : { text: w.text, own: undefined };
    const text = built.text;
    const nonce = stableNonce("ship", pr, head, text, meta.replyTo ?? "");
    const options = ["Ship", "Not now"];
    const msg = await this.postCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: meta.replyTo, nonce });
    const now = this.d.now();
    const s = this.d.load();
    this.remember(s, msg, { kind: "ship", item: meta.item, question: `ship:${m[3]}`, posted: now, expires: this.askExpiry(now),
      ship: { pr, head }, ...(built.own !== undefined ? { own: built.own } : {}), buttons: true, labels: [...options],
      q: { q: excerpt(text), options, used: false } });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
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
  // commit GitHub doesn't have, a check that failed or hasn't run, pcjobs-windows (when the
  // head's tests.yml names it or it ran there) not passed yet. A pull request merged at
  // this head is in main already: the landing asks nothing of its checks, so neither does the
  // card. Anything else going wrong while the new lines are built gives the card as it was
  // before: "Ship it?", his line and the line from GitHub as it was. Never no card.
  private async shipText(pr: string, head: string, review: string | null, words: string, risk = false): Promise<{ text: string; own: string }> {
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
    // A ship_gate watch of this pull request accepted another head (twentieth round: a watch binds to
    // the exact sha its pusher named, and its acceptance is kept by sha): a card for any other head is
    // refused while that acceptance stands, naming it and the command that records it replaced.
    // One live acceptance per pull request (twenty-first round): the card reads that single one; more than
    // one live (left from before the rule) is refused, naming each, until all but one are superseded.
    // Twenty-sixth round: a gate state that can't be read (its generation file or a kept record) refuses the card by
    // name, never reads as no acceptance.
    const gate = this.d.gateWatch?.(pr) ?? [];
    // Twenty-eighth round: an acceptance whose supersede is owed (GitHub's rate limit stopped it) is not current: the
    // card is refused by name, with the wait GitHub asked for, never left to the head read alone.
    if (!Array.isArray(gate) && "owed" in gate)
      throw new Refusal(`the Ship gate's watch of this pull request is waiting on a supersede: ${gate.owed}. No card goes until it is done`);
    if (!Array.isArray(gate))
      throw new Refusal(`the Ship gate's state is unknown for this pull request: ${gate.unknown}. No card goes until it can be read`);
    const watched = gate;
    if (watched.length > 1)
      throw new Refusal(`the Ship gate's watch of this pull request has more than one live acceptance (${watched.join(", ")}): supersede all but the one for this head (keeper.sh ship-gate --supersede <sha>) before showing its card`);
    if (watched.length && watched[0] !== head)
      throw new Refusal(`the Ship gate's watch of this pull request accepted ${watched.join(" and ")}, not this head: if this head replaces it (a rebase), run keeper.sh ship-gate --supersede ${watched[0]}, then watch this head with keeper.sh ship-gate --pr <number> --head ${head} --watch before showing its card`);
    const wait = this.d.factsMs ?? FACTS_MS;
    const ask = <T>(go?: () => Promise<T | null>): Promise<T | null> =>
      (go ? within(Promise.resolve().then(go).catch(() => null), wait) : Promise.resolve(null));
    const { facts, checkRuns, gateHead } = this.d;
    // 0.12.2: while an acceptance stands, the gate's head is read through the gate's own curl wrapper (gateHead), beside
    // the facts; its wait running out is named as a timeout, and any read that doesn't give the head is the gate's state
    // unknown, by name.
    const gateRead = watched.length && gateHead
      ? within(Promise.resolve().then(() => gateHead(pr, wait)).catch((): { unknown: string } => ({ unknown: "the read of the pull request's head failed" })), wait)
      : Promise.resolve(null);
    const [f, runs, gh] = await Promise.all([ask(() => facts!(pr, head)), ask(checkRuns && (() => checkRuns(pr, head))), gateRead]);
    if (f?.head && f.head !== head)
      throw new Refusal("GitHub has a newer head for that pull request than the one this card names: show the card for its head as it is now");
    // Shipped with the risk named (0.16.0): only while the rollback is armed for every App it installs.
    if (risk) {
      const apps = f?.bumps ? f.bumps.map((b) => b.app.toLowerCase()) : null;
      const a = armedFor(apps, this.d.armed?.() ?? null);
      if (!a.armed) throw new Refusal(`he chose to ship it with the risk named, which needs the App's rollback armed, and ${a.why}: no Ship card until it is`);
    }
    if (watched.length && gateHead) {
      if (gh === null) throw new Refusal(`the Ship gate's state is unknown for this pull request: ${GATE_HEAD_TIMED_OUT}, so its watch acceptance can't be checked against it. Show the card again in a minute`);
      if (typeof gh !== "string") throw new Refusal(`the Ship gate's state is unknown for this pull request: ${gh.unknown}, so its watch acceptance can't be checked against it. Show the card again in a minute`);
      if (gh !== head) throw new Refusal("GitHub has a newer head for that pull request than the one this card names: show the card for its head as it is now");
    }
    // Twenty-fifth round: a watch's acceptance is consumed only against the pull request's head as GitHub has it now.
    // When one stands, a head that can't be read refuses the card (the acceptance can't be checked), never passes it.
    if (watched.length && !gateHead && f?.head !== head)
      throw new Refusal("the pull request's head couldn't be read from GitHub, so the Ship gate's watch acceptance can't be checked against it: show the card again in a minute");
    // Merged on GitHub at this head: the landing asks nothing of its checks, only that main has
    // the head (a squash or a rebase would leave it out). So the card asks main too, the way the
    // landing does, and says "Already in main" only when main has it.
    const merged = f?.merged === true && f.head === head;
    const inMain = merged && this.d.landed ? await within(this.d.landed({ pr, head }).catch(() => null), wait) : null;
    if (merged && inMain === false)
      throw new Refusal("GitHub says it's merged, but main doesn't have that head (a squash or a rebase?), so a Ship tap can't install it");
    try {
      if (!merged && runs === "missing") throw new Refusal("GitHub doesn't have that commit: show the card for its head as it is now");
      const checks = !merged && runs && runs !== "missing" && Array.isArray(runs.runs) ? judgeChecks(runs.runs, runs.windows === true) : null;
      const failed = checks?.find((c) => c.state === "failed");
      if (failed) throw new Refusal(`its ${failed.name} check didn't pass (${failed.conclusion}): fix it through Build first, then show a new Ship card`);
      const notRun = checks?.find((c) => c.state === "missing");
      if (notRun) throw new Refusal(`CI hasn't run ${notRun.name} on it yet: show the card once its checks have run`);
      // Unlike a required check, a Windows run still going refuses the card: no ruleset holds
      // main to it, so the card waits for it to pass (the landing checks it again).
      if (checks?.some((c) => c.name === WINDOWS_CHECK && c.state === "running"))
        throw new Refusal(`CI is still running ${WINDOWS_CHECK} on it: show the card once it has passed`);
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

  // -- one line from the PC job keeper (POST /pc-notice, 0.12.0 nineteenth round) -------
  // The keeper sends only a code; the words are the link's own (PC_NOTICES), so nothing from the
  // queue or a page reaches Discord. The keeper sends each condition once while it lasts, and marks
  // it sent only on this answer ("posted"). A keeper newer than this link may send a code the link
  // has no words for (0.12.0, twentieth round): a plain code (lower-case letters, digits and "_",
  // at most 40) gets the generic line, naming the code; anything else is refused.
  //
  // Twenty-first round: a notice may carry its id (the keeper's, kept before it posts) and the job it
  // is about. The link deduplicates on the id: one it has already posted is answered "posted" with that
  // message, and nothing is posted again, so a post whose acknowledgement was lost isn't repeated.
  // Twenty-second round: the job is named by what it does, {site, action} in the queue's own shapes, never
  // by its queue id (Cain's rules and the gate keep those ids away from him); the notice id stays in the
  // payload, never in the words.
  // Twenty-eighth round: repeat, a notice the keeper re-minted under a new id because its first id may have outlived the
  // link's record of posted ids (PC_NOTICE_RETAIN_MS): worded as a repeat, so a second showing never reads as new.
  async pcNotice(code: unknown, job?: unknown, id?: unknown, repeat?: unknown): Promise<{ status: "posted"; message: string; duplicate?: true }> {
    const c = String(code ?? "");
    const base = Object.hasOwn(PC_NOTICES, c) ? PC_NOTICES[c] : PC_NOTICE_CODE.test(c) ? pcNoticeUnknown(c) : "";
    if (!base) throw new Refusal("not a PC job keeper notice");
    const nid = id === undefined || id === null ? null : String(id);
    if (nid !== null && !PC_NOTICE_ID.test(nid)) throw new Refusal("not a PC job keeper notice id");
    let named: string | null = null;
    if (job !== undefined && job !== null) {
      const j = job as any;
      // Twenty-third round: or, when the keeper can't say its site and action, by when it was queued ({queued}).
      const queued = j && typeof j === "object" && !Array.isArray(j) && Object.keys(j).length === 1 && typeof j.queued === "string" ? pcQueuedWords(j.queued, this.d.tz) : null;
      if (queued) named = queued;
      else {
        if (typeof j !== "object" || Array.isArray(j) || typeof j.site !== "string" || typeof j.action !== "string" || !PC_SITE.test(j.site) || !PC_ACTION.test(j.action)
          || Object.keys(j).some((k) => k !== "site" && k !== "action"))
          throw new Refusal("not a PC job: a job is named by its site and action, never by its queue id");
        named = pcJobWords({ site: j.site, action: j.action });
      }
    }
    if (nid !== null) {
      const had = this.d.load().pcNotices?.[nid];
      if (had) return { status: "posted", message: had.msg, duplicate: true };
    }
    const said = named ? `${base} (It is ${named}, code ${c}.)` : base;
    const text = repeat === true ? `${PC_NOTICE_REPEAT} ${said}` : said;
    noMachineText(text);
    const message = await this.notice(text);
    if (nid !== null) {
      const s = this.d.load();
      const kept = Object.entries({ ...(s.pcNotices ?? {}), [nid]: { msg: message, at: this.d.now() } }).filter(([, v]) => this.d.now() - v.at <= PC_NOTICE_RETAIN_MS)
        .sort((a, b) => b[1].at - a[1].at).slice(0, PC_NOTICE_KEEP);
      s.pcNotices = Object.fromEntries(kept);
      this.d.save(s);
    }
    return { status: "posted", message };
  }

  // -- his yes to reusing a PC result's values (POST /reuse, the PC job keeper's ask) ----
  // A follow-up PC job may carry a value an earlier result reported only on his yes
  // (pcjobs/core.ts, owner_reuse). Cain writes the job, so his say-so proves nothing: the
  // keeper sends the Discord message id the job names, and the link answers from what it
  // recorded and what Discord has, never from Cain's words. Only one thing is a yes (0.12.0):
  // his tap on the "Use it" button, the first option, of one of Cain's asks (a tap is
  // recorded only from him, in his DM, with Cain paired to him: who(), below), where the
  // values the job names are exactly the values that ask quoted when the link posted it
  // (askValues, recorded with the ask as values) and Discord still shows each of them on it.
  // The id is the ask's own message id. A message he typed never authorises, even one that
  // replies to the ask or quotes the value: free text can be misread, and the keeper refuses
  // a reuse that names a plain message. One tap answers for one job: the keeper records each
  // id it accepted in an append-only file that survives restarts (pcjobs/main.ts usedReuse).
  // Anything else is a Refusal: an id that isn't a Discord id, a message that isn't one of
  // Cain's asks, an ask not answered by his "Use it" tap, other values than it quoted.
  // Discord down is an error. The keeper refuses the job on either (fail closed).
  async reuseProof(messageId: unknown, values: unknown): Promise<{ status: "ok"; message: string; via: "tap"; ask: string; values: string[] }> {
    const id = String(messageId ?? "").trim();
    if (!SNOWFLAKE.test(id)) throw new Refusal("needs a Discord message id: the ask he tapped \"Use it\" on");
    const vals = Array.isArray(values) ? values : [];
    if (!vals.length || vals.length > 3 || !vals.every((v) => typeof v === "string" && v.length >= 4 && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v)))
      throw new Refusal("needs 1 to 3 values, each one line of 4 to 300 characters");
    const want = vals as string[];
    const { owner, dm, bot } = await this.identity();
    if (this.d.paired() && this.d.paired() !== owner) throw new Refusal("Cain is paired with someone other than the bot's owner");
    const s = this.d.load();
    const rec = s.messages[id];
    if (!rec) throw new Refusal("that isn't one of your asks: only his \"Use it\" tap on your ask approves a reuse, never a message he typed");
    if (rec.kind !== "ask") throw new Refusal("that message is a card of the link's, not one of Cain's asks");
    if (!(rec.outcome === "answered" && !rec.words && rec.q && rec.label !== undefined))
      throw new Refusal("no tap of his is recorded on that ask: it was answered in words, expired, replaced or is still open");
    if (rec.label !== rec.q.options[0] || rec.label !== REUSE_YES)
      throw new Refusal(`he answered that ask by tapping "${rec.label}", not its first option "${REUSE_YES}"`);
    const asked = rec.values ?? [];
    if (!asked.length) throw new Refusal("that ask quoted no value when it was posted, so his tap approved none");
    if (asked.length !== want.length || want.some((v) => !asked.includes(v)) || new Set(want).size !== want.length)
      throw new Refusal("the values aren't exactly the ones that ask quoted when it was posted");
    let msg: any;
    try { msg = await this.rest("GET", `/channels/${dm}/messages/${id}`); }
    catch (e) { if (/discord 404/.test(String(e))) throw new Refusal("no message with that id in his DM"); throw e; }
    if (String(msg?.author?.id ?? "") !== bot) throw new Refusal("that ask isn't the bot's message");
    const text = withoutOutcome(String(msg?.content ?? ""));
    if (want.some((v) => !text.includes(v))) throw new Refusal("that ask doesn't show every value exactly as written");
    return { status: "ok", message: id, via: "tap", ask: id, values: [...want] };
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

  private async answer(it: any, kind: number, data?: unknown): Promise<boolean> {
    try {
      // A tap's update that sets words keeps the tapped message's own flags (only the ones an answer may
      // carry: masked, third round); the rest wrapper adds the preview flag, so a refusal of it that
      // names flags is tried once more without it.
      const keep = kind === 7 && data && typeof data === "object" && "content" in (data as object) && !("flags" in (data as object))
        && typeof it?.message?.flags === "number" ? { ...(data as object), flags: maskFlags(it.message.flags) } : data;
      await this.rest("POST", `/interactions/${it.id}/${it.token}/callback`, keep ? { type: kind, data: keep } : { type: kind }, false);
      return true;
    } catch (e) {
      this.log(`couldn't answer a tap in time: ${String(e).slice(0, 80)}`);
      return false;
    }
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
  private deadReason(m: Shown, now: number): string {
    if (m.q?.used) return "answered";
    if (m.expires != null && m.expires <= now) return "expired";
    if (m.until - DAY <= now) return "forgetting";
    const item = boundItem(m);
    if (item) {
      const f = this.files();
      if (closedItems(f.pending).has(item.toUpperCase())) return "item closed";
      const holds = parseHolds(f.holds);
      if (holds && heldElsewhere(holds, item)) return "held elsewhere";
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
    if (!rec) return this.deadTap(it, msgId, "not a card the link knows");
    if (rec.outcome) return this.deadTap(it, msgId, rec.why ?? rec.outcome);
    if (digest(it.message.content ?? "", it.message.components) !== rec.digest) {
      await this.answer(it, ACK);
      this.log("tap refused: card was changed after it was posted");
      return "refused: card was changed after it was posted";
    }
    // A tap on a grant card (second review of 0.18.0): the re-check, the grant's write and the card's consumption
    // run under one lock for its change key, so a second delivery of the tap, or a second tap, waits and then
    // finds the card used: a dead tap, nothing written.
    if (rec.grant && cid.startsWith("q:")) return this.underKey(`grant:${rec.grant.key}`, () => this.grantTapLocked(it, cid, msgId));
    if (cid !== RESUME) {
      const why = this.deadReason(rec, now);
      if (why) {
        rec.outcome = why === "answered" ? "answered" : "expired"; rec.why = why;
        this.d.save(s);
        return this.deadTap(it, msgId, why);
      }
    }
    if (cid.startsWith("q:")) return this.onQuestion(it, cid, msgId);
    if (cid === RESUME) { this.setStop(false); return this.stopTap(it, cid, msgId); }
    return this.toSpecialist(it, cid, msgId);
  }

  // His tap on a grant card, under its change key's lock: the card read again from disk, as the tap before it
  // left it, then the same checks as any tap's, then his answer.
  private async grantTapLocked(it: any, cid: string, msgId: string): Promise<string> {
    const s = this.d.load();
    const rec = s.messages[msgId];
    if (!rec) return this.deadTap(it, msgId, "not a card the link knows");
    if (rec.outcome || rec.q?.used) return this.deadTap(it, msgId, rec.why ?? rec.outcome ?? "answered");
    if (digest(it.message.content ?? "", it.message.components) !== rec.digest) {
      await this.answer(it, ACK);
      this.log("tap refused: card was changed after it was posted");
      return "refused: card was changed after it was posted";
    }
    const why = this.deadReason(rec, this.d.now());
    // Its item moved to another holder or closed: his tap is told why in plain words.
    if (why === "held elsewhere" || why === "item closed")
      return this.grantRefused(it, s, msgId, why === "item closed" ? "That change's item is closed now, so this grant isn't needed"
        : "That change is being worked on by another session now, so this grant can't be written");
    if (why) {
      rec.outcome = why === "answered" ? "answered" : "expired"; rec.why = why;
      this.d.save(s);
      return this.deadTap(it, msgId, why);
    }
    return this.onQuestion(it, cid, msgId);
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
  // When Cain last heard that the broker's record of what went out failed (discord/spool.ts).
  private spoolToldAt = 0;

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
    // His replies go out through the Discord plugin, which sets no flags. One with a link is held by
    // the reply hook (keeper.sh reply posts it with the preview off from the start); one that slipped
    // through (the hook down, say) gets the preview turned off here, right after, best effort:
    // a race with Discord's own fetch, so only a fallback.
    if (tool === "reply" && n?.links === true) void this.quietReplies(ids.filter((id) => !this.linkPosted(s, id)));
    const net = netOf(n?.net);
    if (net && this.firstTime(call, tool, ids, net)) this.d.relay(netLine(tool, last, net));
    // The broker's record of what went out failed (C1 re-check R5): Cain hears, at most every 6
    // hours, so a disk that refuses writes doesn't go unnoticed.
    const spoolProblem = typeof n?.spool_problem === "string" ? n.spool_problem.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (spoolProblem && now - this.spoolToldAt > 6 * 3_600_000) {
      this.spoolToldAt = now;
      this.d.relay(`The Discord broker says ${spoolProblem}. Nothing to tell him the first time. If it happens again, the Pi's storage needs a look: tell Dane in one line, and keep it in PENDING until it's fixed.`);
    }
    const placing = this.inStopQueue(() => this.placeStop());
    if (!o.background) await placing;
    return { status: "ok", said: "Noted." };
  }

  async quietReplies(ids: string[]): Promise<number> {
    let done = 0;
    for (const id of ids) {
      try {
        const { dm } = await this.identity();
        // Its flags first: the flag goes onto them, never in place of them.
        const cur = await this.rest("GET", `/channels/${dm}/messages/${id}`);
        const had = Number(cur?.flags) || 0;
        if (had & SUPPRESS_EMBEDS) { done++; continue; }
        await this.rest("PATCH", `/channels/${dm}/messages/${id}`, { flags: maskFlags(had | SUPPRESS_EMBEDS) });
        done++;
      } catch (e) {
        if (/discord 429/.test(String(e))) break;
        this.log(`couldn't turn a reply's link preview off: ${String(e).slice(0, 80)}`);
      }
    }
    return done;
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
  private async deadTap(it: any, msgId: string, why: string): Promise<string> {
    const rec = this.d.load().messages[msgId];
    const line = outcomeLine(rec);
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
    await this.ephemeral(it, EXPIRED_TAP);
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

  // His "Ship it with that risk" while the rollback isn't armed (round 2): the change is recorded as
  // held, with that reason, on the guard's log (the holds Cain lists on the open list), and Cain's line
  // says so. Read again at the tap, so a rollback armed since the card went up holds nothing.
  // Round 3: written once. When his answer was already kept (a tap retried after a crash), no second
  // line: one is written only when the log doesn't have it yet (hasHold), and none when that can't be told.
  private heldForRollback(m: Shown, existed = false): string {
    const dec = m.decision!;
    let a: { armed: boolean; why: string };
    try { a = armedFor(null, this.d.armed?.() ?? null); } catch (e) { a = { armed: false, why: `the probe's rollback record can't be read` }; }
    if (a.armed) return "";
    const what = `${dec.key}${dec.pr ? ` (${dec.pr})` : ""}`;
    const why = `held: he chose to ship it with the risk named, but ${a.why}, so a Ship card is refused until a release arms it`;
    let logged = true;
    let write = true;
    if (existed) { try { write = this.d.hasHold ? !this.d.hasHold("review-cap", what) : false; } catch { write = false; } }
    if (write) {
      try { this.d.holdLog?.(holdLine(new Date(this.d.now()), "review-cap", what, why)); if (!this.d.holdLog) logged = false; }
      catch (e) { logged = false; this.log(`couldn't record the hold for ${dec.key}: ${String(e).slice(0, 80)}`); }
    }
    return ` It's recorded as held, not shippable yet: ${a.why}, so a Ship card for it is refused until a release arms the rollback.${logged
      ? " It's on the guard's log: list it on the open list as held." : " The hold couldn't be written to the guard's log: list it as held yourself, and log a Build item."}`;
  }

  private tapLine(m: Shown, label: string, msgId: string): string {
    const where = `(Discord message ${msgId}; its card shows his answer. If it needs words from you, reply with reply_to ${msgId})`;
    if (m.kind === "ship" && m.ship)
      return `Dane tapped "${label}" on your Ship card${m.item && m.item !== "none" ? ` for ${m.item}` : ""}: ${m.ship.pr} at head ${m.ship.head} ${where}`;
    const what = about(m.item, m.question);
    return `Dane tapped "${label}" on your question${what ? ` ${what}` : ""}: "${m.q?.q ?? ""}" ${where}`;
  }

  private async onQuestion(it: any, cid: string, msgId: string): Promise<string> {
    let s = this.d.load();
    let m = s.messages[msgId];
    let q = m?.q;
    const i = Number(cid.split(":")[2]);
    if (!m || !q || q.used || !(i >= 0 && i < q.options.length)) return this.deadTap(it, msgId, "answered");
    const tapped = q.options[i];
    // His Grant tap (second review of 0.18.0): under the change key's lock (onInteraction), everything is checked
    // again first, the head read from GitHub included; then the state is read afresh for the write and the card.
    if (m.grant && tapped !== GRANT_NO) {
      const block = await this.grantBlock(m.grant, m.item);
      if (block?.retry) return this.grantRetryTap(it, m.grant, block.line);
      s = this.d.load(); m = s.messages[msgId]; q = m?.q;
      if (!m || !q || q.used || m.outcome) return this.deadTap(it, msgId, "answered");
      if (block) return this.grantRefused(it, s, msgId, block.line, tapped);
    }
    let label = tapped;
    // His decision at the review-round cap (0.16.0) is kept before anything else, for the Ship card.
    // Round 2: kept durably first, and only then is the card marked used. If it can't be kept, the card
    // stays tappable and he's told, in one plain line to him alone, that his answer wasn't saved.
    // Round 3: the stored record drives everything. After a crash between the write and the card's mark,
    // a tap of the other choice finds his first answer kept: the card says "Already answered: <it>", the
    // relay carries it, and no second hold line is written.
    let heldNote = "", already = false;
    if (m.decision) {
      let kept: { choice: string; at: number; existed: boolean } | void;
      try {
        if (!this.d.decided) throw new DecisionsUnsaved("the link has nowhere to keep it");
        kept = this.d.decided(m.decision.id, tapped, this.d.now());
      } catch (e) {
        this.log(`couldn't keep his decision at the review cap; the card stays up: ${String(e).slice(0, 120)}`);
        await this.answer(it, ACK);
        await this.ephemeral(it, DECISION_UNSAVED);
        return "unsaved";
      }
      const existed = !!kept && kept.existed;
      if (kept && q.options.includes(kept.choice)) label = kept.choice;
      already = label !== tapped;
      if (already) this.log(`his decision for ${m.decision.key} was already kept as "${label}"; a later tap of "${tapped}" changes nothing`);
      if (label === RISK) heldNote = this.heldForRollback(m, existed);
    }
    let replaced: string[] = [];
    if (m.grant) {
      const done = await this.grantTap(it, s, m, msgId, tapped);
      if (done === "unsaved") return "unsaved";
      heldNote = done.note; replaced = done.replaced;
    }
    q.used = true; m.outcome = "answered"; m.label = label; m.why = "answered";
    // His Ship tap lands it in main, unless everything is stopped. Cain hears how it
    // went once it's settled, with the Ship token when it's in main.
    let shown = already ? `Already answered: ${label}` : `You answered: ${label}`, extra = "", landing = false;
    if (already) extra = " His first answer stands: it was kept before the link restarted, and a later tap of the other choice changed nothing.";
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
        m.shipping = { state: "landing", at: this.d.now(), text: words, line: LANDING_LINE, edited: false };
        landing = true;
      }
    }
    const content = withLine(words, shown);
    m.digest = digest(content, []);
    this.d.save(s);
    // Cain hears it the moment it's saved as answered: if the link stopped now, a tap
    // can't be marked answered and never reach him. A landing tells him when it settles
    // (the sweep settles one the link was cut off from).
    if (!landing) this.d.relay(this.tapLine(m, label, msgId) + extra + heldNote);
    const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    if (ok) {
      const s2 = this.d.load();
      const m2 = s2.messages[msgId];
      if (m2) { m2.buttons = false; m2.off = this.d.now(); if (m2.shipping?.line === LANDING_LINE) m2.shipping.edited = true; this.d.save(s2); }
    }
    if (replaced.length) await this.stripAll(replaced);
    if (m.kind === "ask") await this.releaseHeld();
    if (landing) await this.landShip(msgId);
    return "to Cain";
  }

  // -- landing his Ship tap in main (merge.ts) ------------------------------------
  // One at a time: a second tap waits for the first to settle.
  private landingNow = new Set<string>();
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
      if (this.voided(tapped)) r = STOPPED_FIRST;
      else {
        try { r = await this.d.land!({ pr: m.ship.pr, head: m.ship.head, stopped: () => this.voided(tapped) }); }
        catch (e) { r = { ok: false, why: `the link hit an error (${String(e).slice(0, 80)})`, again: true }; }
      }
      await this.settleLanding(msgId, r);
    });
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
    const tap = this.tapLine(m, "Ship", msgId);
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
      shown = `Shipped: it's in main as of ${clockTime(now, this.d.tz)}. ${stopped ? "Installing it waits until you turn things back on."
        : voided ? "Installing it needs your tap again, since you tapped Stop meanwhile."
        : late ? "Installing it needs your tap again, since your tap is over 2 hours old."
        : token ? "Installing it is next." : "Installing it is down right now, so it isn't installed yet."}`;
      line = `${tap} The link landed it: main has that commit now${r.already ? " (it was there already)" : ""}.` + (voided || late
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
    m.digest = digest(withLine(words, shown), []);
    this.d.save(s);
    this.d.relay(line);
    this.log(r.ok ? `his Ship tap landed ${m.ship.pr} in main` : `his Ship tap didn't land ${m.ship.pr}: ${r.why}`);
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
      if (now - sh.at >= LANDING_TRY_MS) {
        const ship = m.ship, why = sh.why;
        void this.queue(id, async () => {
          const inMain = this.d.landed ? await this.d.landed(ship).catch(() => null) : null;
          if (inMain === true) await this.settleLanding(id, { ok: true, already: true });
          else if (inMain === false) await this.settleLanding(id, { ok: false, why: `it couldn't land within 2 hours of the tap${why ? `: ${why}` : ""}`, again: false });
        });                                          // can't tell: the next sweep looks again
        continue;
      }
      if (!this.d.land) { await this.settleLanding(id, { ok: false, why: "the link has no deploy key now", again: false }); continue; }
      void this.landShip(id);
    }
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
      if (!this.d.load().migrated) {
        try { await this.migrate(); } catch (e) { this.log(`couldn't look over the cards already posted yet: ${String(e).slice(0, 80)}`); }
      }
      this.backfillLabels();
      await this.sendOwedToggle();
      await this.retryLandings();
      await this.retryDecisions();
      this.capSweep();
      await this.checkKey();
      await this.showDue();
      await this.decide();
      await this.stripDue();
      await this.releaseHeld();
      await this.inStopQueue(() => this.placeStop());   // last: moves are the lowest priority
    } finally { this.sweeping = false; }
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
    for (const [id, m] of Object.entries(s.messages)) {
      if (!m.buttons || m.outcome || !m.kind) continue;
      const item = boundItem(m);
      let why = "";
      if (m.expires != null && m.expires <= now) why = "expired";
      else if (m.until - DAY <= now) why = "forgetting";
      else if (pulls.has(id)) why = pulls.get(id)!;
      else if (item && closed.has(item.toUpperCase())) why = "item closed";
      else if (item && holds && heldElsewhere(holds, item)) why = "held elsewhere";
      else { const k = rivalKey(m); if (k && newest.get(k) !== id) why = "replaced"; }
      if (!why) continue;
      m.outcome = why === "replaced" ? "replaced" : "expired"; m.why = why;
      told.push([id, m, why]);
    }
    if (!told.length) return;
    this.d.save(s);
    for (const [id, m, why] of told) {
      const because: Record<string, string> = {
        "head moved": "the pull request's head moved, so that go would ship something else. Show a new Ship card for the new head once it's ready.",
        "merged or closed": "the pull request was merged or closed.",
        "item closed": `${m.item} is closed in PENDING.md.`,
        "held elsewhere": `${m.item} is now held by another session. Don't ask him about it or say who has it.`,
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
      const r = s.messages[id];
      if (r) { r.buttons = false; r.off = this.d.now(); if (r.q) r.q.used = true; this.d.save(s); }
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
