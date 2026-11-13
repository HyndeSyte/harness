// A fake Discord, record and clock around Cain's link (link/core.ts), for the tests.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { emptyState, Link, type Pull, State } from "../rootfs/opt/cain/link/core";
import type { Facts, Landed } from "../rootfs/opt/cain/link/merge";
import { makeToken } from "../rootfs/opt/cain/ship-token";

// The link's Ship key, for the tests: its public half as the hook and GitHub read it.
export const SHIP_KEYS = generateKeyPairSync("ed25519");
export const SHIP_PUB = SHIP_KEYS.publicKey.export({ format: "der", type: "spki" }).toString("base64");

export const OWNER = "4242", DM = "5151", BOT = "999";
export const NOV11_8AM = Date.UTC(2026, 10, 11, 13, 0);   // Wed Nov 11 2026, 8:00 AM in New York
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const SHA1 = "1".repeat(40), SHA2 = "2".repeat(40);
export const PR = "https://github.com/HyndeSyte/harness/pull/5";

const copy = (o: any) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function pendingWith(open: string[], done: string[]): string {
  return ["# Pending", "", "## Open", "", "| ID | Item | Who | Next step | Waits for | Done when | Since |", "|---|---|---|---|---|---|---|",
    ...open.map((id) => `| ${id} | Something | Cain | Next | | Done | Nov 9 |`), "", "## Done", "", "| Item | Date |", "|---|---|",
    ...done.map((id) => `| ${id} Something finished | Nov 10 |`), ""].join("\n");
}

// The record keeper's own holds file (/data/record-holds.json), as it writes it.
export function keeperHolds(holds: Record<string, { holder: string; branches?: string[]; job?: string }>): string {
  const full: Record<string, unknown> = {};
  for (const [k, h] of Object.entries(holds))
    full[k] = { for: "his chat", branches: [], taken: "2026-11-11T12:00:00.000Z", renewed: "2026-11-11T12:00:00.000Z", ...h };
  return JSON.stringify({ holds: full, waiting: [], downtime: [] });
}

export function rig(opts: { paired?: string; now?: number; pending?: string | null; holds?: string | null; noKey?: boolean;
    noDeployKey?: boolean; facts?: boolean; keyCheck?: boolean } = {}) {
  let state: State = emptyState();
  // GitHub, as the link's landings see it (merge.ts is tested on its own).
  const github = {
    main: [] as string[],                          // heads landed in main
    landings: [] as { pr: string; head: string }[],
    answers: [] as Landed[],                       // what the next landings answer; none left: it lands
    facts: null as Facts | null,
    key: "known" as "known" | "refused" | "host key" | null,   // what GitHub says to the deploy key
    keyAsked: 0,                                   // how often the link asked
    factsHang: false,                              // GitHub never answers about a pull request's facts
    hold: false,                                   // a landing waits until go()
    readable: true,                                // main can be read (for landings over 2 hours old)
  };
  const landWaiting: (() => void)[] = [];
  const stop = { stopped: false, at: null as number | null, broken: false };
  const harnessDown = { down: false };                // the calendar specialist doesn't take taps
  const t = { now: opts.now ?? NOV11_8AM };
  const files: { pending: string | null; holds: string | null } = { pending: opts.pending ?? null, holds: opts.holds ?? null };
  const pulls: Record<string, Pull> = {};
  const calls: any[] = [], relayed: string[] = [], harness: any[] = [], logs: string[] = [];
  const reports: any[] = [], replays: any[] = [];          // the gate's report log, and the replay's reports
  const sent = { ids: new Set<string>(), texts: new Set<string>() };   // what Cain's transcripts say he sent
  const discord = { marksButtonEdits: false };      // whether an edit of buttons alone marks a message edited
  const posted: Record<string, any> = {};
  const nonces: Record<string, { id: string; at: number }> = {};
  const failing = new Set<string>();             // path prefixes that fail, like "/interactions/" or "PATCH"
  const limited = new Set<string>();             // the same, answered with Discord's rate limit
  const limitN: Record<string, number> = {};     // the next n calls to a path prefix are rate limited
  const lose = { posts: 0 };                     // posts Discord makes but whose answer never arrives
  const hang = { interactions: false };          // the link stops mid-tap: its answer never returns
  const gate = { posts: false, history: false }; // Discord is slow: posts to his DM, or reads of it, wait until release()
  const waiting: (() => void)[] = [];
  const beyond = new Set<string>();              // on Discord, but further back than the look over his DM goes
  let seq = 0, lastId = "", tapped = "";
  const snowflake = (at = t.now) => String(((BigInt(at) - 1420070400000n) << 22n) + BigInt(++seq));
  const rest = async (method: string, path: string, body?: any, auth = true) => {
    calls.push({ method, path, body: copy(body), auth });
    for (const f of failing) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 500: unavailable");
    for (const f of limited) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 429: You are being rate limited.");
    for (const [f, n] of Object.entries(limitN)) if (n > 0 && (path.startsWith(f) || `${method} ${path}`.startsWith(f))) {
      limitN[f] = n - 1;
      throw new Error("discord 429: You are being rate limited.");
    }
    if (path === "/oauth2/applications/@me") return { owner: { id: OWNER } };
    if (path === "/users/@me") return { id: BOT };
    if (path === "/users/@me/channels") return { id: DM };
    if (method === "POST" && path === `/channels/${DM}/messages`) {
      if (gate.posts) await new Promise<void>((ok) => waiting.push(ok));
      // Discord's enforce_nonce: the same nonce within a few minutes returns the message already made.
      const seen = body.enforce_nonce && body.nonce ? nonces[body.nonce] : undefined;
      if (seen && t.now - seen.at < 5 * MIN && posted[seen.id]) return copy(posted[seen.id]);
      const msg = { id: snowflake(), content: body.content, components: body.components ?? [], author: { id: BOT },
        ...(body.message_reference ? { message_reference: body.message_reference } : {}) };
      posted[msg.id] = msg;
      lastId = msg.id;
      if (body.nonce) nonces[body.nonce] = { id: msg.id, at: t.now };
      if (lose.posts > 0) { lose.posts--; throw new Error("TimeoutError: The operation timed out."); }
      return copy(msg);
    }
    if (method === "GET" && path.startsWith(`/channels/${DM}/messages?`)) {
      if (gate.history) await new Promise<void>((ok) => waiting.push(ok));
      // Discord's own paging: newest first, at most `limit`, older than `before`.
      const q = new URLSearchParams(path.split("?")[1]);
      const limit = Number(q.get("limit") ?? 50), before = q.get("before");
      return Object.values(posted).filter((m: any) => !beyond.has(m.id) && (!before || BigInt(m.id) < BigInt(before)))
        .sort((a: any, b: any) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, limit).map(copy);
    }
    const one = new RegExp(`^/channels/${DM}/messages/(\\d+)$`).exec(path);
    if (one && method === "GET") return posted[one[1]] ? copy(posted[one[1]]) : { author: { id: OWNER } };
    if (one && method === "PATCH") {
      const m = posted[one[1]];
      if (!m) throw new Error("discord 404: Unknown Message");
      if (body.content !== undefined) m.content = body.content;
      if (body.components !== undefined) m.components = body.components;
      if (body.content !== undefined || discord.marksButtonEdits) m.edited_timestamp = new Date(t.now).toISOString();
      return copy(m);
    }
    if (method === "POST" && path.startsWith("/interactions/")) {
      if (hang.interactions) return new Promise(() => {});
      if (body?.type === 7 && posted[tapped]) {
        if (body.data.content !== undefined) posted[tapped].content = body.data.content;
        posted[tapped].components = body.data.components;
      }
    }
    return null;
  };
  const deps = {
    rest, load: () => copy(state), save: (s: State) => { state = copy(s); }, now: () => t.now,
    relay: (x: string) => { relayed.push(x); }, toHarness: async (p: string, b: unknown) => { harness.push([p, b]); return !harnessDown.down; },
    paired: () => opts.paired ?? OWNER, log: (l: string) => { logs.push(l); },
    record: () => ({ ...files }), pull: async (pr: string) => pulls[pr] ?? null, tz: "America/New_York",
    stop: {
      read: () => { if (stop.broken) throw new Error("unreadable"); return { stopped: stop.stopped, at: stop.at }; },
      write: (stopped: boolean, at: number) => { stop.stopped = stopped; stop.at = at; },
    },
    signShip: opts.noKey ? undefined : (claim: any) => makeToken(claim, (d) => edSign(null, d, SHIP_KEYS.privateKey)),
    land: opts.noDeployKey ? undefined : async (l: { pr: string; head: string; stopped: () => boolean }): Promise<Landed> => {
      github.landings.push({ pr: l.pr, head: l.head });
      if (github.hold) await new Promise<void>((ok) => landWaiting.push(ok));
      const next = github.answers.shift();
      if (next) { if (next.ok) github.main.push(l.head); return next; }
      if (l.stopped()) return { ok: false, why: "everything is stopped", again: false, stopped: true };
      github.main.push(l.head);
      return { ok: true, already: false };
    },
    landed: opts.noDeployKey ? undefined : async (ship: { pr: string; head: string }) => github.readable ? github.main.includes(ship.head) : null,
    facts: opts.facts ? () => github.factsHang ? new Promise<Facts | null>(() => {}) : Promise.resolve(github.facts) : undefined,
    factsMs: 50,
    keyKnown: opts.keyCheck ? async () => { github.keyAsked++; return github.key; } : undefined,
    report: (x: any) => { reports.push(copy(x)); },
    transcripts: () => sent,
    writeReplay: (x: any) => { replays.push(copy(x)); return "/data/work/gate-replay.json"; },
    replayPauseMs: 0,
  };
  let link = new Link(deps);
  const tap = (msg: any, custom_id: string, over: any = {}) => {
    tapped = String(msg.id);
    return link.onInteraction({ type: 3, id: "11", token: "t", application_id: BOT, channel_id: DM, user: { id: OWNER },
      data: { custom_id }, message: copy(msg), ...over });
  };
  // Dane's own message in the DM, optionally a Discord reply to one of the bot's.
  const his = (content: string, replyTo?: string) => {
    const msg = { id: snowflake(), content, components: [], author: { id: OWNER },
      ...(replyTo ? { message_reference: { type: 0, message_id: replyTo, channel_id: DM } } : {}) };
    posted[msg.id] = msg;
    return msg;
  };
  const r = {
    get link() { return link; },
    calls, relayed, harness, posted, logs, files, pulls, failing, limited, lose, hang, gate, beyond, t, tap, his, snowflake, stop, harnessDown, github,
    reports, replays, sent, discord, limitN,
    release: () => { gate.posts = false; gate.history = false; for (const ok of waiting.splice(0)) ok(); },
    go: () => { github.hold = false; for (const ok of landWaiting.splice(0)) ok(); },
    reads: () => calls.filter((c) => c.method === "GET" && c.path.startsWith(`/channels/${DM}/messages?`)).length,
    posts: () => calls.filter((c) => c.method === "POST" && c.path === `/channels/${DM}/messages`).length,
    answers: () => calls.filter((c) => c.path.startsWith("/interactions/")).map((c) => c.body.type),
    updates: () => calls.filter((c) => c.path.startsWith("/interactions/") && c.body.type === 7).map((c) => c.body.data),
    ephemerals: () => calls.filter((c) => c.path.startsWith("/webhooks/")).map((c) => c.body),
    cards: () => Object.values(posted).filter((m: any) => m.author.id === BOT),
    last: () => posted[lastId],
    msg: (id: string) => posted[id],
    buttons: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.label)),
    ids: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id)),
    state: () => copy(state) as State,
    setState: (s: State) => { state = copy(s); },
    restart: () => { link = new Link(deps); return link; },
    later: (ms: number) => { t.now += ms; },
  };
  return r;
}
