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
import { createHash } from "node:crypto";

export const STOP = "k:stop";
export const RESUME = "k:resume";
const COMPONENT = 3;
const ACK = 6;
const UPDATE = 7;
const REMEMBER_MS = 35 * 86400_000;
const LIMIT = 2000;
const SUPPRESS_EMBEDS = 1 << 2;
const DIRECT_KINDS = new Set(["stopped", "resumed", "alert"]);

export type Rest = (method: string, path: string, body?: unknown, auth?: boolean) => Promise<any>;

export interface Card { text: string; rows: any[]; kind: string; created: number; shown: string | null }
export interface Shown { digest: string; until: number; card?: number; q?: { q: string; options: string[]; used: boolean } }
export interface State {
  owner?: string; dm?: string; bot?: string; next: number;
  cards: Record<string, Card>; messages: Record<string, Shown>;
}

export function emptyState(): State {
  // Card ids start from the clock, so a fresh state never reuses an id the
  // specialist already has on record.
  return { next: Date.now(), cards: {}, messages: {} };
}

export function digest(content: string, components: any[] | undefined): string {
  const b = (components ?? []).map((r: any) => (r.components ?? []).map((c: any) => [c.label ?? null, c.custom_id ?? null]));
  return createHash("sha256").update(JSON.stringify({ t: content ?? "", b })).digest("hex");
}

export function fit(text: string): string {
  return text.length <= LIMIT ? text : text.slice(0, LIMIT - 2).trimEnd() + " …";
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

export interface Deps {
  rest: Rest;
  load: () => State;
  save: (s: State) => void;
  now: () => number;
  relay: (text: string) => void;                                   // a line typed in to Cain
  toHarness: (path: string, body: unknown) => Promise<boolean>;     // a tap on its card
  paired: () => string;                                            // who Cain is paired with
  log?: (line: string) => void;
}

export class Link {
  constructor(private d: Deps) {}
  relayLine(text: string): void { this.d.relay(text); }
  private log(line: string) { (this.d.log ?? console.log)(`[cain] link: ${line}`); }

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
    Object.assign(s, { owner, dm, bot });
    this.d.save(s);
    return { owner, dm, bot };
  }

  forget(): void {
    const s = this.d.load();
    delete s.owner; delete s.dm; delete s.bot;
    this.d.save(s);
  }

  private remember(s: State, msg: any, extra: Partial<Shown> = {}): void {
    const now = this.d.now();
    for (const [k, v] of Object.entries(s.messages)) if (v.until <= now) delete s.messages[k];
    const id = String(msg.id);
    s.messages[id] = { ...(s.messages[id] ?? {}), ...extra,
      digest: digest(msg.content ?? "", msg.components), until: now + REMEMBER_MS };
  }

  private async post(text: string, comps: any[]): Promise<any> {
    const { dm } = await this.identity();
    const body: any = { content: fit(text), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS };
    if (comps.length) body.components = comps;
    const msg = await this.d.rest("POST", `/channels/${dm}/messages`, body);
    if (!msg?.id) throw new Error("no message returned");
    return msg;
  }

  // -- cards from specialists -------------------------------------------------
  async addCard(c: { text: string; rows?: any[]; kind?: string }): Promise<number> {
    const kind = String(c.kind ?? "reply");
    const comps = (c.rows ?? []).filter((r: any) => (r.components ?? []).every((b: any) =>
      String(b.custom_id ?? "").startsWith("k:")));                  // a specialist can't make Cain's buttons
    const s = this.d.load();
    const id = s.next++;
    s.cards[String(id)] = { text: String(c.text ?? ""), rows: comps, kind, created: this.d.now(), shown: null };
    for (const [k, v] of Object.entries(s.cards)) if (v.created + REMEMBER_MS <= this.d.now()) delete s.cards[k];
    this.d.save(s);
    if (DIRECT_KINDS.has(kind)) {
      await this.show(id);
    } else {
      const ask = comps.length ? "It has buttons: show it now." : "Show it now if it matters today, or fold it into the morning message.";
      this.d.relay(`The calendar specialist has a card for Dane (card ${id}): "${excerpt(c.text, 120)}". ${ask} Run /opt/cain/keeper.sh show ${id}`);
    }
    return id;
  }

  async show(id: number): Promise<string> {
    const s = this.d.load();
    const card = s.cards[String(id)];
    if (!card) throw new Error(`no card ${id}`);
    if (card.shown) return card.shown;
    const msg = await this.post(card.text, card.rows);
    const s2 = this.d.load();
    s2.cards[String(id)].shown = String(msg.id);
    this.remember(s2, msg, { card: id });
    this.d.save(s2);
    return String(msg.id);
  }

  async editButtons(id: number, comps: any[]): Promise<void> {
    const s = this.d.load();
    const card = s.cards[String(id)];
    if (!card) return;
    card.rows = comps;
    if (card.shown) {
      const { dm } = await this.identity();
      const msg = await this.d.rest("PATCH", `/channels/${dm}/messages/${card.shown}`,
        { components: comps, allowed_mentions: { parse: [] } });
      if (msg?.id) this.remember(s, msg, { card: id });
    }
    this.d.save(s);
  }

  cardOf(messageId: string): number | null {
    return this.d.load().messages[messageId]?.card ?? null;
  }

  // -- Cain's own words with buttons ----------------------------------------------
  async ask(text: string, options: string[], withStop = false): Promise<string> {
    const opts = options.map((o) => o.trim()).filter(Boolean).slice(0, 5);
    const nonce = Math.random().toString(36).slice(2, 10);
    const buttons: [string, string][][] = [];
    if (opts.length) buttons.push(opts.map((o, i) => [o, `q:${nonce}:${i}`] as [string, string]));
    if (withStop) buttons.push([["Stop", STOP]]);
    const msg = await this.post(text, rows(buttons, "q:"));
    const s = this.d.load();
    this.remember(s, msg, opts.length ? { q: { q: excerpt(text), options: opts, used: false } } : {});
    this.d.save(s);
    return String(msg.id);
  }

  // -- taps -------------------------------------------------------------------
  private async check(it: any): Promise<string> {
    if (it.guild_id || it.member) return "not in the DM";
    const { owner, dm } = await this.identity();
    if (this.d.paired() && this.d.paired() !== owner) return "Cain is paired with someone other than the bot's owner";
    const user = String(it.user?.id ?? "");
    if (!user || user !== owner) return "not the owner";
    if (String(it.channel_id ?? "") !== dm) return "not the DM";
    const msg = it.message ?? {};
    const seen = this.d.load().messages[String(msg.id)];
    if (!seen || seen.until <= this.d.now()) return "not a message this link posted";
    if (digest(msg.content ?? "", msg.components) !== seen.digest) return "card was changed after it was posted";
    return "";
  }

  private async answer(it: any, kind: number, data?: unknown): Promise<void> {
    try {
      await this.d.rest("POST", `/interactions/${it.id}/${it.token}/callback`, data ? { type: kind, data } : { type: kind }, false);
    } catch (e) {
      this.log(`couldn't answer a tap in time: ${String(e).slice(0, 80)}`);
    }
  }

  async onInteraction(it: any): Promise<string> {
    if (it?.type !== COMPONENT) return "ignored";
    const cid = String(it.data?.custom_id ?? "");
    if (!cid.startsWith("k:") && !cid.startsWith("q:")) return "ignored";   // Cain's plugin answers "perm:"
    let refusal = "";
    try { refusal = await this.check(it); } catch (e) { refusal = "check failed"; }
    if (refusal) {
      await this.answer(it, ACK);
      this.log(`tap refused: ${refusal}`);
      return `refused: ${refusal}`;
    }
    const msgId = String(it.message.id);
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

  private async onQuestion(it: any, cid: string, msgId: string): Promise<string> {
    const s = this.d.load();
    const q = s.messages[msgId]?.q;
    const i = Number(cid.split(":")[2]);
    if (!q || q.used || !(i >= 0 && i < q.options.length)) {
      await this.answer(it, ACK);
      return "refused: already answered";
    }
    q.used = true;
    const content = fit(`${it.message.content ?? ""}\n\nYou chose: ${q.options[i]}.`);
    this.remember(s, { id: msgId, content, components: [] });
    this.d.save(s);
    await this.answer(it, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });
    this.d.relay(`Dane tapped "${q.options[i]}" on your question: "${q.q}"`);
    return "to Cain";
  }

  async followup(callback: string, text: string): Promise<void> {
    const [app, token] = [callback.split(":")[0], callback.split(":").slice(1).join(":")];
    if (!app || !token || !text) return;
    await this.d.rest("POST", `/webhooks/${app}/${token}`,
      { content: fit(text), flags: 64, allowed_mentions: { parse: [] } }, false);
  }

  // -- reactions ----------------------------------------------------------------
  async onReaction(r: any): Promise<string> {
    if (r?.guild_id) return "ignored";
    const { owner, dm, bot } = await this.identity();
    if (String(r.user_id) !== owner || String(r.channel_id) !== dm) return "ignored";
    const msg = await this.d.rest("GET", `/channels/${dm}/messages/${r.message_id}`);
    if (String(msg?.author?.id ?? "") !== bot) return "ignored";   // his own message
    const emoji = String(r.emoji?.name ?? "?").slice(0, 32);
    this.d.relay(`Dane reacted ${emoji} to your message: "${excerpt(msg.content ?? "")}"`);
    return "to Cain";
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
