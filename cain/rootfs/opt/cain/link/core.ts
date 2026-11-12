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
//   on tap undoes it; Cain has no way to. Its notice says what stopped.
// - Ship (wave 1, piece B): his Ship tap is signed here (../ship-token.ts) with a key
//   only the link reads, for that pull request and head, good for 30 minutes. Cain's
//   Ship run needs that token, and GitHub checks it before the merge.
import { createHash } from "node:crypto";
import { claimFor, type Claim } from "../ship-token";
import type { StopState } from "../stop";

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
const SETTLE_MS = 10 * 60_000;           // a message younger than this may still be on its way into the state
const HEAD_EVERY_MS = 5 * 60_000;        // how often a Ship card's pull request is looked at
const HISTORY_PAGES = 5;                 // the one-time look over his DM: up to 500 messages back
const ASK_GRACE_MS = 2 * 3_600_000;      // an ask lives until the first morning check-in at least this far off
const SHOW_WAIT_MS = 2 * 60_000;         // a card with buttons Cain hasn't shown by then goes out by itself
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
export type Kind = "ask" | "ship" | "card" | "morning" | "legacy";
export interface Shown {
  digest: string; until: number; card?: number;
  q?: { q: string; options: string[]; used: boolean };
  kind?: Kind;                       // absent on records from before 0.7.0 until the first sweep
  item?: string; question?: string;  // what the card is about: a PENDING id (or "none") and a question id
  posted?: number;
  expires?: number | null;           // when its buttons stop mattering; null: no time of its own
  ship?: { pr: string; head: string };
  buttons?: boolean;                 // it has buttons on Discord, as far as the link knows
  outcome?: "answered" | "expired" | "replaced";
  why?: string;                      // for the log: what made it expire
  label?: string;                    // answered: the label he tapped
  words?: boolean;                   // answered in a message, not a tap
  byItself?: boolean;                // a specialist's card that went out by itself; Cain's show then files it
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
}

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

export function rows(buttons: [string, string][][], primaryPrefix = "k:a:"): any[] {
  return buttons.slice(0, 5).map((row) => ({
    type: 1,
    components: row.slice(0, 5).map(([label, id]) => ({
      type: 2, style: id.startsWith(primaryPrefix) ? 1 : 2, label: label.slice(0, 80), custom_id: id.slice(0, 100),
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

// Discord ids carry their own creation time.
export function snowflakeTime(id: string): number {
  try { return Number(BigInt(id) >> 22n) + 1420070400000; } catch { return 0; }
}

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

// The words a card starts with, naming what it's about: "P08 Q2".
const labelOf = (item: string, question = "") => (item === "none" ? "" : question ? `${item} ${question}` : item);
function withLabel(text: string, label: string): string {
  if (!label) return text;
  const t = text.trimStart();
  const next = t.charAt(label.length);
  return t.toUpperCase().startsWith(label.toUpperCase()) && !/[A-Za-z0-9]/.test(next) ? text : `${label}: ${t}`;
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

// What the card says once its buttons are off. A morning message asked nothing: its
// Stop just goes.
function outcomeLine(m: Shown | undefined): string {
  if (!m) return EXPIRED;
  if (m.kind === "morning") return "";
  if (m.outcome === "answered") return m.label ? `You answered: ${m.label}` : m.words ? "You answered in a message" : "Answered";
  if (m.outcome === "replaced") return REPLACED;
  return EXPIRED;
}

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
const wentOutLine = (id: number, c: Card | undefined, msg: string) =>
  `Card ${id} ${what(c)} went out to him by itself (Discord message ${msg}): you hadn't shown it within 2 minutes. No need to show it unless it belongs under an item.`;
const foundLine = (id: number, c: Card | undefined, msg: string) =>
  `Card ${id} ${what(c)} reached him after all (Discord message ${msg}): the answer to your show of it was lost. Nothing more was posted.`;
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
}

// What stopped, as his Stop notice says it and Cain hears it.
export const STOPPED_TOO = "Cain's Build and Ship jobs, Ship cards and outside reviews are stopped too, until you tap Turn back on.";
export const RESUMED_TOO = "Cain's Build and Ship jobs, Ship cards and outside reviews can run again too.";

// A pull request as GitHub has it now: its head, and whether it's still open (null
// when that couldn't be told).
export interface Pull { head: string | null; open: boolean | null }

export type AskResult = { status: "posted"; message: string } | { status: "held"; said: string };
// A specialist's card put up: its message, whether this call recorded it, and whether the
// link made it by itself (not Cain's show).
type Put = { message: string; first: boolean; fromLink?: boolean };

export class Link {
  private chain: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  private headChecked = new Map<string, number>();
  private going = new Map<number, Promise<Put>>();   // cards being put up now (putUp)
  private cainWaits = new Set<number>();             // cards Cain's show waits on now: a lapse found meanwhile is his to hear
  constructor(private d: Deps) {}
  relayLine(text: string): void { this.d.relay(text); }
  private log(line: string) { (this.d.log ?? console.log)(`[cain] link: ${line}`); }

  // -- Stop everything ----------------------------------------------------------
  // A state that can't be read counts as stopped: when in doubt, nothing ships.
  stopped(): StopState {
    if (!this.d.stop) return { stopped: false, at: null };
    try { return this.d.stop.read(); } catch { return { stopped: true, at: null }; }
  }

  // Only from his tap (onInteraction checks it's him first). A second Stop changes nothing.
  private setStop(stopped: boolean): void {
    const was = this.stopped();
    try { this.d.stop?.write(stopped, this.d.now()); }
    catch (e) { this.log(`couldn't save the Stop state: ${String(e).slice(0, 80)}`); }
    if (was.stopped === stopped) return;
    this.log(stopped ? "Dane tapped Stop: everything is stopped" : "Dane turned everything back on");
    this.d.relay(stopped
      ? "Dane tapped Stop. Everything is stopped: no Build or Ship runs, no Ship cards and no review sends, and the calendar specialist starts nothing new, until he taps Turn back on. Only he can; his notice already says so. Don't offer Start or Ship meanwhile, and tell him in one line only if he asks."
      : "Dane tapped Turn back on: Build and Ship runs, Ship cards and review sends work again. Ask again about anything that waited.");
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
    const app = await this.d.rest("GET", "/oauth2/applications/@me");
    const owner = String(app?.team?.owner_user_id ?? app?.owner?.id ?? "");
    const me = await this.d.rest("GET", "/users/@me");
    const bot = String(me?.id ?? "");
    if (!owner || !bot) throw new Error("Discord didn't say whose bot this is");
    const ch = await this.d.rest("POST", "/users/@me/channels", { recipient_id: owner });
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
    const msg = opts.timeoutMs === undefined ? await this.d.rest("POST", `/channels/${dm}/messages`, body)
      : await this.d.rest("POST", `/channels/${dm}/messages`, body, true, opts.timeoutMs);
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
  async addCard(c: { text: string; rows?: any[]; kind?: string; expires?: unknown }): Promise<number> {
    const kind = String(c.kind ?? "reply");
    const comps = (c.rows ?? []).filter((r: any) => (r.components ?? []).every((b: any) =>
      String(b.custom_id ?? "").startsWith("k:")));                  // a specialist can't make Cain's buttons
    // The specialist's Stop and Turn back on notices also say what that did on Cain's
    // side, when the state as it is now agrees.
    const nowStopped = kind === "stopped" || kind === "resumed" ? this.stopped().stopped : null;
    if ((kind === "stopped" && nowStopped === true) || (kind === "resumed" && nowStopped === false))
      c = { ...c, text: `${String(c.text ?? "").trimEnd()}\n\n${nowStopped ? STOPPED_TOO : RESUMED_TOO}` };
    const s = this.d.load();
    const id = s.next++;
    const now = this.d.now();
    // A card with buttons goes out by itself if Cain hasn't shown it in time (showDue).
    const due = comps.length && !DIRECT_KINDS.has(kind) ? now + SHOW_WAIT_MS : null;
    const expires = toMs(c.expires);
    if (expires === null && c.expires != null && c.expires !== "")
      this.log(`card ${id}: its expiry isn't a time (${String(c.expires).slice(0, 40)}), so it has none`);
    s.cards[String(id)] = { text: String(c.text ?? ""), rows: comps, kind, created: now, shown: null, expires, due };
    for (const [k, v] of Object.entries(s.cards)) if (v.created + REMEMBER_MS <= now) delete s.cards[k];
    this.d.save(s);
    if (DIRECT_KINDS.has(kind)) {
      await this.show(id, { item: "none" });
    } else {
      const ask = due !== null ? "It has buttons: show it now, or it goes out by itself in about 2 minutes."
        : "Show it now if it matters today, or fold it into the morning message.";
      this.d.relay(`The calendar specialist has a card for Dane (card ${id}): "${excerpt(c.text, 120)}". ${ask} Run /opt/cain/keeper.sh show ${id} --item <its PENDING id, or none> (add --reply-to <his message id> when it answers a message of his). The item is only its label: the card goes out whoever holds the item, open or closed.`);
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
      Promise<{ status: "posted" | "already out" | "expired"; message: string | null; said?: string }> {
    const meta = checkMeta(m);
    let put: Put;
    this.cainWaits.add(id);
    try { put = await this.putUp(id, meta); }
    catch (e) {
      if (e instanceof Refusal) return this.lapsedAnswer(id);
      throw e;
    } finally { this.cainWaits.delete(id); }
    if (put.first) return { status: "posted", message: put.message };
    const f = await this.fileUnder(put.message, meta);
    const under = about(meta.item, meta.question) ? ` under ${about(meta.item, meta.question)}` : "";
    const done = "Nothing more was posted. Write no lead-in for it.";
    return { status: "already out", message: put.message, said: !f.filed ? "It's already in front of him; nothing more was posted."
      : f.gaveWay ? `It had gone out by itself; this filed it${under}, and as a newer card for the same question is up, its buttons came off. ${done}`
      : f.replaced ? `It had gone out by itself; this filed it${under} and took the buttons off ${f.replaced === 1 ? "an older card" : `${f.replaced} older cards`} for the same question. ${done}`
      : `It had gone out by itself; this only filed it${under}. ${done}` };
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
        msg = (await this.d.rest("PATCH", `/channels/${dm}/messages/${msg.id}`, { components: rows, allowed_mentions: { parse: [] } })) ?? msg;
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
      buttons: (msg.components ?? []).length > 0, ...(byItself && fromLink ? { byItself: true } : {}) });
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
      const batch = await this.d.rest("GET", `/channels/${dm}/messages?limit=100${before ? `&before=${before}` : ""}`);
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
    const msg = await this.d.rest("PATCH", `/channels/${dm}/messages/${card.shown}`,
      { components: comps, allowed_mentions: { parse: [] } });
    const s2 = this.d.load();
    if (s2.cards[String(id)]) s2.cards[String(id)].rows = comps;
    if (msg?.id) this.remember(s2, msg, { card: id, buttons: comps.length > 0 });
    this.d.save(s2);
  }

  cardOf(messageId: string): number | null {
    return this.d.load().messages[messageId]?.card ?? null;
  }

  // Which card a message is, and what it's about (GET /card-of).
  cardInfo(messageId: string): { card: number | null; item: string | null; question: string | null } {
    const m = this.d.load().messages[messageId];
    return { card: m?.card ?? null, item: m?.item ?? null, question: m?.question || null };
  }

  // -- the mutual watch (watch.ts): a plain notice, straight to his DM ---------------
  async notice(text: string, timeoutMs?: number): Promise<string> {
    const msg = await this.post(text, [], { timeoutMs });
    return String(msg.id);
  }

  // -- Cain's own words with buttons ----------------------------------------------
  private openAsk(s: State, now: number): [string, Shown] | null {
    for (const [id, m] of Object.entries(s.messages)) if (m.kind === "ask" && live(m, now)) return [id, m];
    return null;
  }

  async ask(a: { text: string; options: string[]; item?: unknown; question?: unknown; replyTo?: unknown }): Promise<AskResult> {
    const meta = checkMeta(a);
    const opts = (a.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 5);
    if (!String(a.text ?? "").trim()) throw new Refusal("an ask needs its question");
    if (!opts.length) throw new Refusal("an ask needs at least one option; open questions go through the reply tool");
    noMachineText(String(a.text), ...opts);
    const text = withLabel(String(a.text), labelOf(meta.item, meta.question));   // "P08 Q2: ..."
    this.mayAsk(meta.item);
    return this.serial(async () => {
      const now = this.d.now();
      const s = this.d.load();
      const key = keyOf(meta.item, meta.question);
      const entry: Ask = { text, options: opts, item: meta.item, question: meta.question, replyTo: meta.replyTo,
        at: now, expires: this.askExpiry(now),
        nonce: stableNonce("ask", meta.item, meta.question, text, opts.join("\u0001"), meta.replyTo ?? "") };
      const open = this.openAsk(s, now);
      if (open && !(key && keyFor(open[1]) === key)) {
        const held = s.held ?? (s.held = []);
        const same = key ? held.findIndex((h) => keyOf(h.item, h.question) === key) : -1;
        if (same >= 0) held[same] = entry; else held.push(entry);
        this.d.save(s);
        const which = about(open[1].item, open[1].question) || `"${excerpt(open[1].q?.q ?? "", 60)}"`;
        return { status: "held", said: `Not asked yet: your question ${which} is still open. This one goes out by itself when that one is answered or expires, and you'll be told when it does.` };
      }
      return { status: "posted", message: await this.postAsk(entry) };
    });
  }

  private async postAsk(e: Ask): Promise<string> {
    const nonce = e.nonce ?? stableNonce("ask", e.item, e.question, e.text, e.options.join("\u0001"), e.replyTo ?? "");
    const msg = await this.postCard(e.text, rows([e.options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: e.replyTo, nonce });
    const s = this.d.load();
    this.remember(s, msg, { kind: "ask", item: e.item, question: e.question, posted: this.d.now(), expires: e.expires,
      buttons: true, q: { q: excerpt(e.text), options: e.options, used: false } });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return String(msg.id);
  }

  // A Ship card: Ship / Not now, for one pull request at one head. Doesn't wait its
  // turn; lasts as long as an ask, and goes when the head moves or the pull request
  // is merged or closed.
  async ship(a: { text: string; item?: unknown; pr?: unknown; head?: unknown; replyTo?: unknown }): Promise<AskResult> {
    const meta = checkMeta({ item: a.item, replyTo: a.replyTo });
    const pr = String(a.pr ?? "").trim();
    const head = String(a.head ?? "").trim().toLowerCase();
    const m = PULL.exec(pr);
    if (!m) throw new Refusal("pr must be the pull request's address: https://github.com/<owner>/<repo>/pull/<number>");
    if (!SHA.test(head)) throw new Refusal("head must be the pull request's full 40-character head sha");
    if (!String(a.text ?? "").trim()) throw new Refusal("a Ship card needs its words");
    const stop = this.stopped();
    if (stop.stopped)
      throw new Refusal("Everything is stopped: Dane tapped Stop, so no Ship cards until he taps Turn back on. Only he can; don't ask him to.");
    noMachineText(String(a.text));
    const text = withLabel(String(a.text), labelOf(meta.item));
    this.mayAsk(meta.item);
    const nonce = stableNonce("ship", pr, head, text, meta.replyTo ?? "");
    const options = ["Ship", "Not now"];
    const msg = await this.postCard(text, rows([options.map((o, i) => [o, `q:${nonce.slice(0, 10)}:${i}`] as [string, string])], "q:"),
      { replyTo: meta.replyTo, nonce });
    const now = this.d.now();
    const s = this.d.load();
    this.remember(s, msg, { kind: "ship", item: meta.item, question: `ship:${m[3]}`, posted: now, expires: this.askExpiry(now),
      ship: { pr, head }, buttons: true, q: { q: excerpt(text), options, used: false } });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return { status: "posted", message: String(msg.id) };
  }

  // The one morning message, with Stop. Its Stop moves to the newest morning message.
  async morning(text: string): Promise<string> {
    if (!String(text ?? "").trim()) throw new Refusal("the morning message needs its text");
    noMachineText(String(text));
    const msg = await this.postCard(String(text), rows([[["Stop", STOP]]], "q:"), { nonce: stableNonce("morning", String(text)) });
    const s = this.d.load();
    this.remember(s, msg, { kind: "morning", item: "none", question: "morning", posted: this.d.now(), expires: null, buttons: true });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return String(msg.id);
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
    const msg = await this.d.rest("GET", `/channels/${dm}/messages/${id}`);
    if (String(msg?.author?.id ?? "") !== owner) throw new Refusal("that isn't one of his messages in your DM");
    const ref = msg?.message_reference;
    if (!ref?.message_id || Number(ref.type ?? 0) !== 0) return { status: "ok", reply_to: null, said: "Not a reply to anything: read it on its own." };
    const rid = String(ref.message_id);
    const m = this.d.load().messages[rid];
    return { status: "ok", reply_to: rid, card: m?.card ?? null, item: m?.item ?? null, question: m?.question || null,
      asked: m?.q?.q ?? null, open: m ? live(m, this.d.now()) : null };
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
      await this.d.rest("POST", `/interactions/${it.id}/${it.token}/callback`, data ? { type: kind, data } : { type: kind }, false);
      return true;
    } catch (e) {
      this.log(`couldn't answer a tap in time: ${String(e).slice(0, 80)}`);
      return false;
    }
  }

  private async ephemeral(it: any, text: string): Promise<void> {
    try {
      await this.d.rest("POST", `/webhooks/${String(it.application_id ?? "")}/${it.token}`,
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
        buttons: (m.components ?? []).length > 0, ...(mark.byItself ? { byItself: true } : {}) });
      this.markReplaced(s, msgId);                     // the sweep takes off what it replaced
      this.d.save(s);
      this.log(`a tap showed card ${k} is up after all; recorded`);
      this.d.relay(mark.byItself ? wentOutLine(Number(k), c, msgId) : foundLine(Number(k), c, msgId));
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
    const stop = cid === STOP || cid === RESUME;          // Stop works from any card of ours
    // Stop only ever makes things safer, so it's his from any card of ours, as it shows
    // now. Turn back on undoes it, so it gets the same checks as any other tap.
    if (cid === STOP) { this.setStop(true); return this.stopTap(it, cid, msgId); }
    // Component taps only ever come for the app's own messages, so one the link doesn't
    // know is an old card of ours: take its buttons off (Stop and Turn back on still work).
    if (!rec && !stop) return this.deadTap(it, msgId, "not a card the link knows");
    if (!rec || (rec.outcome && stop)) { this.setStop(false); return this.stopTap(it, cid, msgId); }
    if (rec.outcome) return this.deadTap(it, msgId, rec.why ?? rec.outcome);
    if (!rec.outcome && digest(it.message.content ?? "", it.message.components) !== rec.digest) {
      await this.answer(it, ACK);
      this.log("tap refused: card was changed after it was posted");
      return "refused: card was changed after it was posted";
    }
    if (!stop) {
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

  // Stop and Turn back on go on to the calendar specialist, whose notice says what
  // happened. If it doesn't take the tap, the notice comes from here, so the tap is
  // never silent, with the button that undoes it.
  private async stopTap(it: any, cid: string, msgId: string): Promise<string> {
    const out = await this.toSpecialist(it, cid, msgId);
    if (out !== "specialist unreachable") return out;
    const stopped = this.stopped().stopped;
    const text = stopped
      ? `**Stopped.** ${STOPPED_TOO} The calendar specialist didn't answer, so it may still be running.`
      : `**Turned back on.** ${RESUMED_TOO} The calendar specialist didn't answer, so it may still be stopped.`;
    try {
      const button: [string, string] = stopped ? ["Turn back on", RESUME] : ["Stop", STOP];
      const msg = await this.post(text, rows([[button]], "q:"));
      const s = this.d.load();
      this.remember(s, msg, { kind: "card", item: "none", question: "stop", posted: this.d.now(), expires: null, buttons: true });
      this.d.save(s);
    } catch (e) { this.log(`couldn't post the Stop notice: ${String(e).slice(0, 80)}`); }
    return out;
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
    if (ok) r.digest = digest(shown, []);
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

  private tapLine(m: Shown, label: string, msgId: string): string {
    const where = `(Discord message ${msgId}; its card shows his answer. If it needs words from you, reply with reply_to ${msgId})`;
    if (m.kind === "ship" && m.ship)
      return `Dane tapped "${label}" on your Ship card${m.item && m.item !== "none" ? ` for ${m.item}` : ""}: ${m.ship.pr} at head ${m.ship.head} ${where}`;
    const what = about(m.item, m.question);
    return `Dane tapped "${label}" on your question${what ? ` ${what}` : ""}: "${m.q?.q ?? ""}" ${where}`;
  }

  private async onQuestion(it: any, cid: string, msgId: string): Promise<string> {
    const s = this.d.load();
    const m = s.messages[msgId];
    const q = m?.q;
    const i = Number(cid.split(":")[2]);
    if (!m || !q || q.used || !(i >= 0 && i < q.options.length)) return this.deadTap(it, msgId, "answered");
    const label = q.options[i];
    q.used = true; m.outcome = "answered"; m.label = label; m.why = "answered";
    // His Ship tap is signed here, unless everything is stopped.
    let shown = `You answered: ${label}`, extra = "";
    if (m.kind === "ship" && m.ship && label === "Ship") {
      if (this.stopped().stopped) {
        shown = "You tapped Ship, but everything is stopped, so nothing shipped.";
        extra = " Everything is stopped, so nothing ships and there's no Ship token: after he taps Turn back on, ask again with a new Ship card.";
      } else {
        const token = this.signFor(m.ship);
        extra = token
          ? ` Ship token: ${token} (good for 30 minutes: put it in the Ship job's text as it is).`
          : " The link has no Ship key, so there's no Ship token and a Ship run will be refused: tell him in one line that shipping is down, and log it as a Build item.";
      }
    }
    const content = withLine(String(it.message.content ?? ""), shown);
    m.digest = digest(content, []);
    this.d.save(s);
    // Cain hears it the moment it's saved as answered: if the link stopped now, a tap
    // can't be marked answered and never reach him.
    this.d.relay(this.tapLine(m, label, msgId) + extra);
    const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    if (ok) { const s2 = this.d.load(); if (s2.messages[msgId]) { s2.messages[msgId].buttons = false; this.d.save(s2); } }
    if (m.kind === "ask") await this.releaseHeld();
    return "to Cain";
  }

  async followup(callback: string, text: string): Promise<void> {
    const [app, token] = [callback.split(":")[0], callback.split(":").slice(1).join(":")];
    if (!app || !token || !text) return;
    await this.d.rest("POST", `/webhooks/${app}/${token}`,
      { content: fit(text), flags: EPHEMERAL, allowed_mentions: { parse: [] } }, false);
  }

  // -- reactions ----------------------------------------------------------------
  async onReaction(r: any): Promise<string> {
    if (r?.guild_id) return "ignored";
    const { owner, dm, bot } = await this.identity();
    if (String(r.user_id) !== owner || String(r.channel_id) !== dm) return "ignored";
    const msg = await this.d.rest("GET", `/channels/${dm}/messages/${r.message_id}`);
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
      await this.showDue();
      await this.decide();
      await this.stripDue();
      await this.releaseHeld();
    } finally { this.sweeping = false; }
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
      const batch = await this.d.rest("GET", `/channels/${dm}/messages?limit=100${before ? `&before=${before}` : ""}`);
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
          item: "none", posted: snowflakeTime(id), buttons: true, outcome: "expired", why: "posted before 0.7.0" };
        continue;
      }
      const posted = rec.until - REMEMBER_MS;
      Object.assign(rec, { item: "none", question: "", posted, buttons: true });
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
        if (p?.open === false) pulls.set(id, "merged or closed");
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
      if (s.messages[id]) { s.messages[id].buttons = false; this.d.save(s); }
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
        const cur = await this.d.rest("GET", `/channels/${dm}/messages/${id}`);
        body.content = withLine(String(cur?.content ?? ""), line);
      } catch (e) { return failed(e); }
    }
    let msg: any;
    try { msg = await this.d.rest("PATCH", `/channels/${dm}/messages/${id}`, body); } catch (e) { return failed(e); }
    const s = this.d.load();
    const r = s.messages[id];
    if (r) {
      r.buttons = false;
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
