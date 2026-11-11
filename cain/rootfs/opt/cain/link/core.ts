// Cain's link to Dane on Discord, for everything his plugin can't do: taps,
// reactions, and cards. Plain code, no model.
//
// - Specialists (the Harness add-on, for calendars) hand cards here. A card is
//   held until Cain shows it, unchanged; Cain is told it's waiting. Only Stop
//   notices and "Cain can't reach you" alerts go straight out ("direct").
// - Every tap is checked here, within Discord's 3 seconds: Dane (the bot's owner,
//   who must also be the one Cain is paired with), in his DM, on a message this
//   link posted, still showing exactly what it posted (Cain can edit the bot's
//   messages, so a rewritten card is refused). A tap on a specialist's card goes
//   back to that specialist, which applies its own checks. A tap on Cain's own
//   question, and any reaction of Dane's to the bot's messages, go to Cain.
// - Every card knows its item (a PENDING id, or "none"), its question and when it
//   stops mattering. A sweep every minute takes the buttons off cards that were
//   answered, expired, replaced by a newer card for the same item and question, or
//   whose item closed or is held by someone other than Cain, and says so on the card.
//   A tap on such a card is answered in place: "This card expired; nothing was done."
// - Cain asks one question at a time: a new ask waits while another is open, and goes
//   out by itself when that one closes. Ship cards and specialists' cards don't wait.
import { createHash } from "node:crypto";

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
const LIMIT = 2000;
const SUPPRESS_EMBEDS = 1 << 2;
const DIRECT_KINDS = new Set(["stopped", "resumed", "alert"]);
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const QUESTION = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,39}$/;
const SNOWFLAKE = /^\d{15,22}$/;
const SHA = /^[0-9a-f]{40}$/;
export const PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

export type Rest = (method: string, path: string, body?: unknown, auth?: boolean, timeoutMs?: number) => Promise<any>;

export interface Card { text: string; rows: any[]; kind: string; created: number; shown: string | null; expires?: number | null }
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
}
export interface Ask {               // Cain's question waiting behind the open one
  text: string; options: string[]; item: string; question: string; replyTo?: string; at: number; expires: number;
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

function excerpt(text: string, n = 150): string {
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

// -- what Cain's record says (the record keeper's copy in /data/record) -------------------
export interface RecordFiles { pending: string | null; holds: string | null }   // null: no such file
export type Holds = Record<string, { holder?: string; branches?: string[] }>;

// state/holds.json, written only by the record keeper. A missing file is no holds;
// one that can't be read is null, and nothing is decided from it.
export function parseHolds(text: string | null): Holds | null {
  if (text === null) return {};
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
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
  return { item: item.toLowerCase() === "none" ? "none" : item, question, replyTo };
}

// Cards for the same item and question replace each other; so do Ship cards for the
// same pull request, and morning messages. "none" never replaces anything.
const keyOf = (item?: string, question?: string): string | null =>
  !item || item === "none" ? null : `${item.toUpperCase()}\n${(question ?? "").toUpperCase()}`;
function keyFor(m: Shown): string | null {
  if (m.kind === "ship" && m.ship) return `ship\n${m.ship.pr}`;
  if (m.kind === "morning") return "morning";
  return keyOf(m.item, m.question);
}
const live = (m: Shown, now: number) => !!m.buttons && !m.outcome && !(m.expires != null && m.expires <= now);
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

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

export interface Deps {
  rest: Rest;
  load: () => State;
  save: (s: State) => void;
  now: () => number;
  relay: (text: string) => void;                                   // a line typed in to Cain
  toHarness: (path: string, body: unknown) => Promise<boolean>;     // a tap on its card
  paired: () => string;                                            // who Cain is paired with
  log?: (line: string) => void;
  record?: () => RecordFiles;                                      // PENDING.md and holds.json, as the keeper has them
  head?: (pr: string) => Promise<string | null>;                   // a pull request's head sha now; null: can't tell
  tz?: string;                                                     // the check-ins' zone
}

export type AskResult = { status: "posted"; message: string } | { status: "held"; said: string };

export class Link {
  private chain: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  private headChecked = new Map<string, number>();
  constructor(private d: Deps) {}
  relayLine(text: string): void { this.d.relay(text); }
  private log(line: string) { (this.d.log ?? console.log)(`[cain] link: ${line}`); }

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

  private async post(text: string, comps: any[], opts: { timeoutMs?: number; replyTo?: string } = {}): Promise<any> {
    const { dm } = await this.identity();
    const body: any = { content: fit(text), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS };
    if (comps.length) body.components = comps;
    // An answer to a tap or a message is a Discord reply to it.
    if (opts.replyTo) body.message_reference = { message_id: opts.replyTo, channel_id: dm, fail_if_not_exists: false };
    const msg = opts.timeoutMs === undefined ? await this.d.rest("POST", `/channels/${dm}/messages`, body)
      : await this.d.rest("POST", `/channels/${dm}/messages`, body, true, opts.timeoutMs);
    if (!msg?.id) throw new Error("no message returned");
    return msg;
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

  // Older live cards with the same key as this one: replaced. Returns their ids.
  private markReplaced(s: State, newId: string): string[] {
    const fresh = s.messages[newId];
    const key = fresh ? keyFor(fresh) : null;
    if (!key) return [];
    const out: string[] = [];
    for (const [id, m] of Object.entries(s.messages)) {
      if (id === newId || !m.buttons || m.outcome || keyFor(m) !== key) continue;
      m.outcome = "replaced"; m.why = "replaced";
      out.push(id);
    }
    if (fresh.kind === "ask" || fresh.kind === "card") s.held = (s.held ?? []).filter((h) => keyOf(h.item, h.question) !== key);
    return out;
  }

  // -- cards from specialists -------------------------------------------------
  async addCard(c: { text: string; rows?: any[]; kind?: string; expires?: unknown }): Promise<number> {
    const kind = String(c.kind ?? "reply");
    const comps = (c.rows ?? []).filter((r: any) => (r.components ?? []).every((b: any) =>
      String(b.custom_id ?? "").startsWith("k:")));                  // a specialist can't make Cain's buttons
    const s = this.d.load();
    const id = s.next++;
    s.cards[String(id)] = { text: String(c.text ?? ""), rows: comps, kind, created: this.d.now(), shown: null, expires: toMs(c.expires) };
    for (const [k, v] of Object.entries(s.cards)) if (v.created + REMEMBER_MS <= this.d.now()) delete s.cards[k];
    this.d.save(s);
    if (DIRECT_KINDS.has(kind)) {
      await this.show(id, { item: "none" });
    } else {
      const ask = comps.length ? "It has buttons: show it now." : "Show it now if it matters today, or fold it into the morning message.";
      this.d.relay(`The calendar specialist has a card for Dane (card ${id}): "${excerpt(c.text, 120)}". ${ask} Run /opt/cain/keeper.sh show ${id} --item <its PENDING id, or none> (add --reply-to <his message id> when it answers a message of his)`);
    }
    return id;
  }

  async show(id: number, m: { item?: unknown; question?: unknown; replyTo?: unknown }): Promise<string> {
    const meta = checkMeta(m);
    const s = this.d.load();
    const card = s.cards[String(id)];
    if (!card) throw new Error(`no card ${id}`);
    if (card.shown) return card.shown;
    this.mayAsk(meta.item);
    const msg = await this.post(card.text, card.rows, { replyTo: meta.replyTo });
    const s2 = this.d.load();
    s2.cards[String(id)].shown = String(msg.id);
    this.remember(s2, msg, { card: id, kind: "card", item: meta.item, question: meta.question, posted: this.d.now(),
      expires: card.expires ?? null, buttons: card.rows.length > 0 });
    const replaced = this.markReplaced(s2, String(msg.id));
    this.d.save(s2);
    await this.stripAll(replaced);
    return String(msg.id);
  }

  async editButtons(id: number, comps: any[]): Promise<void> {
    const s = this.d.load();
    const card = s.cards[String(id)];
    if (!card) return;
    const rec = card.shown ? s.messages[card.shown] : undefined;
    if (rec?.outcome && comps.length) { this.log(`card ${id} is ${rec.outcome}; its buttons stay off`); return; }
    if (!card.shown) { card.rows = comps; this.d.save(s); return; }
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
    const text = String(a.text ?? "");
    const opts = (a.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 5);
    if (!text.trim()) throw new Refusal("an ask needs its question");
    if (!opts.length) throw new Refusal("an ask needs at least one option; open questions go through the reply tool");
    this.mayAsk(meta.item);
    return this.serial(async () => {
      const now = this.d.now();
      const s = this.d.load();
      const key = keyOf(meta.item, meta.question);
      const entry: Ask = { text, options: opts, item: meta.item, question: meta.question, replyTo: meta.replyTo,
        at: now, expires: this.nextMorning(now) };
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
    const nonce = Math.random().toString(36).slice(2, 10);
    const msg = await this.post(e.text, rows([e.options.map((o, i) => [o, `q:${nonce}:${i}`] as [string, string])], "q:"),
      { replyTo: e.replyTo });
    const s = this.d.load();
    this.remember(s, msg, { kind: "ask", item: e.item, question: e.question, posted: this.d.now(), expires: e.expires,
      buttons: true, q: { q: excerpt(e.text), options: e.options, used: false } });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return String(msg.id);
  }

  // A Ship card: Ship / Not now, for one pull request at one head. Doesn't wait its
  // turn, and expires when the pull request's head moves.
  async ship(a: { text: string; item?: unknown; pr?: unknown; head?: unknown; replyTo?: unknown }): Promise<AskResult> {
    const meta = checkMeta({ item: a.item, replyTo: a.replyTo });
    const pr = String(a.pr ?? "").trim();
    const head = String(a.head ?? "").trim().toLowerCase();
    const m = PULL.exec(pr);
    if (!m) throw new Refusal("pr must be the pull request's address: https://github.com/<owner>/<repo>/pull/<number>");
    if (!SHA.test(head)) throw new Refusal("head must be the pull request's full 40-character head sha");
    if (!String(a.text ?? "").trim()) throw new Refusal("a Ship card needs its words");
    this.mayAsk(meta.item);
    const nonce = Math.random().toString(36).slice(2, 10);
    const options = ["Ship", "Not now"];
    const msg = await this.post(String(a.text), rows([options.map((o, i) => [o, `q:${nonce}:${i}`] as [string, string])], "q:"),
      { replyTo: meta.replyTo });
    const s = this.d.load();
    this.remember(s, msg, { kind: "ship", item: meta.item, question: `ship:${m[3]}`, posted: this.d.now(), expires: null,
      ship: { pr, head }, buttons: true, q: { q: excerpt(String(a.text)), options, used: false } });
    const replaced = this.markReplaced(s, String(msg.id));
    this.d.save(s);
    await this.stripAll(replaced);
    return { status: "posted", message: String(msg.id) };
  }

  // The one morning message, with Stop. Its Stop moves to the newest morning message.
  async morning(text: string): Promise<string> {
    if (!String(text ?? "").trim()) throw new Refusal("the morning message needs its text");
    const msg = await this.post(String(text), rows([[["Stop", STOP]]], "q:"));
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
    const key = keyOf(meta.item, meta.question);
    const ids = await this.serial(async () => {
      const now = this.d.now();
      const s = this.d.load();
      const out: string[] = [];
      for (const [id, m] of Object.entries(s.messages)) {
        if (m.kind !== "ask" || !live(m, now)) continue;
        if (key ? keyFor(m) !== key : (m.item ?? "none") !== "none") continue;
        m.outcome = "answered"; m.words = true; m.why = "answered in a message";
        if (m.q) m.q.used = true;
        out.push(id);
      }
      const before = (s.held ?? []).length;
      if (key) s.held = (s.held ?? []).filter((h) => keyOf(h.item, h.question) !== key);
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

  // Why a card that looks live has stopped mattering, or "".
  private deadReason(m: Shown, now: number): string {
    if (m.q?.used) return "answered";
    if (m.expires != null && m.expires <= now) return "expired";
    if (m.until - DAY <= now) return "forgetting";
    if (m.item && m.item !== "none") {
      const f = this.files();
      if (closedItems(f.pending).has(m.item.toUpperCase())) return "item closed";
      const holds = parseHolds(f.holds);
      if (holds && heldElsewhere(holds, m.item)) return "held elsewhere";
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
    const stop = cid === STOP || cid === RESUME;          // Stop works from any card of ours
    // Component taps only ever come for the app's own messages, so one the link doesn't
    // know is an old card of ours: take its buttons off.
    if (!rec) return this.deadTap(it, msgId, "not a card the link knows");
    if (rec.outcome && !stop) return this.deadTap(it, msgId, rec.why ?? rec.outcome);
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

  private tapLine(m: Shown, label: string, msgId: string): string {
    const where = `(Discord message ${msgId}: answer it with reply_to ${msgId})`;
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
    const content = withLine(String(it.message.content ?? ""), `You answered: ${label}`);
    m.digest = digest(content, []);
    this.d.save(s);
    const ok = await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    if (ok) { const s2 = this.d.load(); if (s2.messages[msgId]) { s2.messages[msgId].buttons = false; this.d.save(s2); } }
    this.d.relay(this.tapLine(m, label, msgId));
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
      await this.decide();
      await this.stripDue();
      await this.releaseHeld();
    } finally { this.sweeping = false; }
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
      if (rec.card !== undefined) Object.assign(rec, { kind: "card", expires: s.cards[String(rec.card)]?.expires ?? null });
      else if (rec.q) Object.assign(rec, rec.q.used ? { kind: "ask", outcome: "expired", why: "posted before 0.7.0" }
        : { kind: "ask", expires: this.nextMorning(posted) });
      else Object.assign(rec, { kind: "morning", question: "morning", expires: null });
    }
    for (const [id, rec] of Object.entries(s.messages)) {
      if (rec.kind || seen.has(id)) continue;                    // not on Discord with buttons: nothing to take off
      Object.assign(rec, { kind: rec.card !== undefined ? "card" : rec.q ? "ask" : "morning", item: "none",
        posted: rec.until - REMEMBER_MS, buttons: false });
    }
    s.migrated = true;
    this.d.save(s);
    this.log(`looked over the cards already posted: ${found.length} with buttons`);
  }

  // Which live cards stopped mattering, and why.
  private async decide(): Promise<void> {
    const now = this.d.now();
    const moved = new Set<string>();
    if (this.d.head) {
      for (const [id, m] of Object.entries(this.d.load().messages)) {
        if (m.kind !== "ship" || !m.ship || !live(m, now)) continue;
        if ((this.headChecked.get(id) ?? -Infinity) + HEAD_EVERY_MS > now) continue;
        this.headChecked.set(id, now);
        const h = await this.d.head(m.ship.pr).catch(() => null);
        if (h && h.toLowerCase() !== m.ship.head) moved.add(id);
      }
    }
    const f = this.files();
    const holds = parseHolds(f.holds);              // null: can't be read, so no hold decides anything
    const closed = closedItems(f.pending);
    const s = this.d.load();
    const newest = new Map<string, string>();
    for (const [id, m] of Object.entries(s.messages)) {
      const k = keyFor(m);
      if (!k || !live(m, now)) continue;
      const cur = newest.get(k);
      if (!cur || (m.posted ?? 0) > (s.messages[cur].posted ?? 0)
          || ((m.posted ?? 0) === (s.messages[cur].posted ?? 0) && newerId(id, cur))) newest.set(k, id);
    }
    const told: [string, Shown, string][] = [];
    for (const [id, m] of Object.entries(s.messages)) {
      if (!m.buttons || m.outcome || !m.kind) continue;
      const item = m.item && m.item !== "none" ? m.item : "";
      let why = "";
      if (m.expires != null && m.expires <= now) why = "expired";
      else if (m.until - DAY <= now) why = "forgetting";
      else if (moved.has(id)) why = "head moved";
      else if (item && closed.has(item.toUpperCase())) why = "item closed";
      else if (item && holds && heldElsewhere(holds, item)) why = "held elsewhere";
      else { const k = keyFor(m); if (k && newest.get(k) !== id) why = "replaced"; }
      if (!why) continue;
      m.outcome = why === "replaced" ? "replaced" : "expired"; m.why = why;
      told.push([id, m, why]);
    }
    if (!told.length) return;
    this.d.save(s);
    for (const [id, m, why] of told) {
      if ((m.kind !== "ask" && m.kind !== "ship") || !["head moved", "item closed", "held elsewhere"].includes(why)) continue;
      const what = m.kind === "ship" ? `Ship card for ${m.ship?.pr}` : `question ${about(m.item, m.question) || `"${excerpt(m.q?.q ?? "", 60)}"`}`;
      const because = why === "head moved" ? "the pull request's head moved, so that go would ship something else. Ask again with the new head once it's ready."
        : why === "item closed" ? `${m.item} is closed in PENDING.md.`
        : `${m.item} is now held by another session. Don't ask him about it or say who has it.`;
      this.d.relay(`Your ${what} (Discord message ${id}) was taken off: ${because}`);
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
    if (lines.length) { s.held = keep; this.d.save(s); for (const l of lines) this.d.relay(l); }
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
      this.d.relay(`Your held question${what ? ` ${what}` : ""} is now in front of Dane (Discord message ${id}): "${excerpt(next.text, 120)}"`);
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
