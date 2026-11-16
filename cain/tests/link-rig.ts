// A fake Discord, record and clock around Cain's link (link/core.ts), for the tests.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { appendLog } from "../rootfs/opt/cain/applog";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, Link, type Pull, State } from "../rootfs/opt/cain/link/core";
import { ACTIONS_APP, type Facts, type Landed } from "../rootfs/opt/cain/link/merge";
import type { Reviewed } from "../rootfs/opt/cain/reviewed";
import { makeToken } from "../rootfs/opt/cain/ship-token";

// A check run as GitHub Actions posts it, and the three required ones passed.
export const checkRun = (name: string, conclusion: string | null = "success", status = "completed", id = 1) =>
  ({ id, name, status, conclusion, app: { id: ACTIONS_APP } });
export const passing = () => ["pytest", "bun", "pr"].map((n) => checkRun(n));

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
    noDeployKey?: boolean; facts?: boolean; keyCheck?: boolean; factsMs?: number; unchecked?: boolean; maxCheckDays?: number;
    installTaps?: boolean; issuedLog?: string | null; keeperMirror?: string } = {}) {
  let state: State = emptyState();
  // Round 12: Ship taps land only once install taps are on; the tests about other things have them on.
  // Round 13: in the keeper-owned install log, turned on by the owner's line on the tests' head.
  const installDir = mkdtempSync(join(tmpdir(), "link-install-"));
  const installLog = join(installDir, "record-install.log"), installResults = join(installDir, "install-tests.json");
  if (opts.installTaps !== false) appendLog(installLog, { t: "flag", how: "on", by: "owner", said: "1570000000000000001", head: "a".repeat(40), at: "2026-11-01T00:00:00.000Z" });
  const recoverFile = join(installDir, "record-recover.json");
  // Round 12: the link's issued-key log, a real file (null: none); the crash points the tests set; and
  // the durable saves, in order with the log's appends.
  const issuedLog = opts.issuedLog === null ? undefined : (opts.issuedLog ?? join(mkdtempSync(join(tmpdir(), "link-issued-")), "link-issued.log"));
  const crash = { at: null as string | null };
  const durable: { run?: number; nonce?: string }[] = [];
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
    unreadableWhy: null as string | null,          // round 9: what the remote says when it can't be read (null: no answer)
    reads: 0,                                      // how often the remote main was read for a landing
    bases: [] as (string | null | undefined)[],    // the base each remote read searched from
    // A Ship card's other read (with facts): the head's check runs ("missing": GitHub has no such
    // commit; null: no answer), which can hang; and what was asked, in order.
    runs: passing() as any[] | "missing" | null,
    runsHang: false,
    asked: [] as string[],
  };
  // The review service's lines, as /data/trust/reviewed.json has them (null: it can't be read).
  const reviews = { list: [] as Reviewed[] | null };
  const landWaiting: (() => void)[] = [];
  const stop = { stopped: false, at: null as number | null, broken: false };
  const harnessDown = { down: false };                // the calendar specialist doesn't take taps
  // now: the Pi's clock (the link's); discord: how far Discord's own clock is from it (round 16: a Pi with no
  // real-time clock can be hours off until time sync), which every new message and interaction id carries.
  const t = { now: opts.now ?? NOV11_8AM, discord: 0 };
  const files: { pending: string | null; holds: string | null; checks?: string | null } = { pending: opts.pending ?? null, holds: opts.holds ?? null, checks: null };
  const submitted: any[] = [];                    // requests the link handed the record keeper (source checks, one-offs)
  const outcomes: Record<string, { state: string; reason?: string }> = {};   // the keeper's outcome per request, once settled
  // Unless the test drives the keeper itself (keeper.auto = false, then keeper.onWait runs
  // each time the link waits on an outcome), a check is applied at once, as the keeper
  // would: the row gets a ledger id at version 1 the first time, and the check is taken while
  // the row is the version it read.
  const keeper = { auto: true, n: 0, onWait: null as null | (() => void), waits: 0 };
  // Reads of the record keeper's files that fail (a tap's fresh read included); refusals logged for
  // tuning; and the checks the keeper didn't answer in time.
  const fails = { record: false, outcome: false };
  const tuned: any[] = [], waited: any[] = [];
  // Round 7: whether a check's request survived a reset (default: yes), the keeper's landing ledger,
  // the link's state file on disk (corrupt: what it holds instead of the saved state), hung reads
  // killed at the ceiling, and what Discord answers to a webhook patch of @original (another id).
  const survive = { fn: null as null | ((id: string) => boolean | null) };
  const landLedger = { keys: new Set<string>(), broken: false, what: new Map<string, { pr: string; head: string; at: string; base?: string }>(), settled: new Map<string, string>(), said: new Map<string, string>(),
    hand: [] as { key: string; how: string; at: string; said: string }[], owner: [] as { kind: string; said: string; at: string }[],
    untrusted: null as string | null, pruned: 0 };
  const disk = { corrupt: null as string | null, writes: 0, failSaves: 0 };
  const kills = { n: 0 };
  const autoKeep = (req: any) => {
    if (!keeper.auto) return;
    for (const o of req.ops ?? []) {
      if (o.op !== "check") continue;
      const ledger = files.checks ? JSON.parse(files.checks) : {};
      const e = ledger[o.item];
      if ((e?.id ?? null) !== o.row || (e?.version ?? 0) !== o.version) { outcomes[req.id] = { state: "rejected", reason: `check ${o.item}: the row changed` }; return; }
      const entry = e ?? { id: `r${(++keeper.n).toString(16).padStart(12, "0")}`, version: 1, changed: new Date(t.now).toISOString() };
      ledger[o.item] = { ...entry, checked: o.text, checked_at: new Date(t.now).toISOString(), checked_version: entry.version, checked_req: req.id, by: "cain" };
      files.checks = JSON.stringify(ledger);
    }
    outcomes[req.id] = { state: "done" };
  };
  const pulls: Record<string, Pull> = {};
  const calls: any[] = [], relayed: string[] = [], harness: any[] = [], logs: string[] = [];
  const reports: any[] = [], replays: any[] = [];          // the gate's report log, and the replay's reports
  const sent = { ids: new Set<string>(), texts: new Set<string>() };   // what Cain's transcripts say he sent
  const discord = { marksButtonEdits: false, webhookId: null as string | null };      // whether an edit of buttons alone marks a message edited
  const posted: Record<string, any> = {};
  const nonces: Record<string, { id: string; at: number }> = {};
  const failing = new Set<string>();             // path prefixes that fail, like "/interactions/" or "PATCH" (a 5xx)
  const refusing = new Set<string>();            // the same, refused by Discord (a 403)
  const limited = new Set<string>();             // the same, answered with Discord's rate limit
  const limitN: Record<string, number> = {};     // the next n calls to a path prefix are rate limited
  const lose = { posts: 0 };                     // posts Discord makes but whose answer never arrives
  // The link stops mid-tap: its answer never returns (edits: only the card's edit after a deferred answer).
  const hang = { interactions: false, edits: false };
  // Discord is slow: posts to his DM, reads of it, or whose bot this is, wait until release()
  const gate = { posts: false, history: false, identity: false };
  const waiting: (() => void)[] = [];
  const beyond = new Set<string>();              // on Discord, but further back than the look over his DM goes
  const spy = { onCall: null as null | ((method: string, path: string) => void) };   // runs as each call reaches Discord
  let seq = 0, lastId = "", tapped = "", taps = 0;
  const snowflake = (at = t.now + t.discord) => String(((BigInt(at) - 1420070400000n) << 22n) + BigInt(++seq));
  const rest = async (method: string, path: string, body?: any, auth = true) => {
    calls.push({ method, path, body: copy(body), auth });
    spy.onCall?.(method, path);
    for (const f of failing) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 500: unavailable");
    for (const f of refusing) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 403: Missing Access");
    for (const f of limited) if (path.startsWith(f) || `${method} ${path}`.startsWith(f)) throw new Error("discord 429: You are being rate limited.");
    for (const [f, n] of Object.entries(limitN)) if (n > 0 && (path.startsWith(f) || `${method} ${path}`.startsWith(f))) {
      limitN[f] = n - 1;
      throw new Error("discord 429: You are being rate limited.");
    }
    if (path === "/oauth2/applications/@me") {
      if (gate.identity) await new Promise<void>((ok) => waiting.push(ok));
      return { owner: { id: OWNER } };
    }
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
    // The DM channel itself: its last message id (round 16: the link's start mark).
    if (method === "GET" && path === `/channels/${DM}`) {
      const ids = Object.keys(posted).sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1));
      return { id: DM, type: 1, last_message_id: ids.at(-1) ?? null };
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
    // The tapped card, edited through the interaction's webhook after a deferred answer.
    if (method === "PATCH" && /^\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/.test(path)) {
      if (hang.interactions || hang.edits) return new Promise(() => {});
      if (discord.webhookId) return { id: discord.webhookId };          // Discord patched another message
      if (posted[tapped]) {
        if (body.content !== undefined) posted[tapped].content = body.content;
        if (body.components !== undefined) posted[tapped].components = body.components;
      }
      return null;
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
    rest, load: () => (disk.corrupt !== null ? emptyState() : copy(state)),
    save: (s: State) => { if (disk.failSaves > 0) { disk.failSaves--; throw new Error("ENOSPC: no space left on device"); } state = copy(s); disk.corrupt = null; disk.writes++; }, now: () => t.now,
    saveDurable: (s: State) => { durable.push({ run: s.run, nonce: s.runNonce }); state = copy(s); disk.corrupt = null; disk.writes++; },
    issuedLog, installLog, installResults, recoverFile, keeperMirror: opts.keeperMirror,
    crashPoint: (where: string) => { if (crash.at === where) { crash.at = null; throw new Error(`crash injected at ${where}`); } },
    stateHealth: () => (disk.corrupt !== null ? { ok: false, why: "corrupt or mid-write" } : { ok: true }),
    requestLogged: (id: string) => (survive.fn ? survive.fn(id) : true),
    landings: {
      claim: (key: string, what: { pr: string; head: string; at: string; base?: string }) => {
        if (landLedger.broken || landLedger.untrusted) return null;
        if (landLedger.keys.has(key)) return false;
        landLedger.keys.add(key); landLedger.what.set(key, what); return true;
      },
      settle: (key: string, how: string, at?: string, note?: { said?: string }) => {
        if (!landLedger.settled.has(key)) { landLedger.settled.set(key, how); if (note?.said) landLedger.said.set(key, note.said); }
      },
      // Round 12: the ledger's settle log, appended before any effect of a hand settle.
      settleHand: (key: string, how: string, at: string, said: string) => {
        if (landLedger.broken) return false;
        if (landLedger.hand.some((h) => h.key === key || h.said === said)) return false;
        landLedger.hand.push({ key, how, at, said });
        if (!landLedger.settled.has(key)) { landLedger.settled.set(key, how); landLedger.said.set(key, said); }
        return true;
      },
      handSettles: () => landLedger.hand.map((h) => ({ ...h })),
      ownerLine: (kind: string, said: string, at: string) => {
        if (landLedger.broken || landLedger.hand.some((h) => h.said === said) || landLedger.owner.some((h) => h.said === said)) return false;
        landLedger.owner.push({ kind, said, at }); return true;
      },
      ownerLines: () => landLedger.owner.map((h) => ({ ...h })),
      repair: () => ({ torn: false, bytes: 0 }),
      entries: () => [...landLedger.keys].map((key) => ({ key, ...(landLedger.what.get(key) ?? { pr: "", head: "", at: "" }),
        ...(landLedger.settled.has(key) ? { settled: { how: landLedger.settled.get(key) as any, at: new Date(t.now).toISOString(),
          ...(landLedger.said.has(key) ? { said: landLedger.said.get(key) } : {}) } } : {}) })),
      prune: () => { landLedger.pruned++; return 0; },
      untrusted: () => landLedger.untrusted,
      trust: () => { landLedger.untrusted = null; },
      count: () => landLedger.keys.size,
    } as any,
    killRead: () => { kills.n++; },
    relay: (x: string) => { relayed.push(x); }, toHarness: async (p: string, b: unknown) => { harness.push([p, b]); return !harnessDown.down; },
    paired: () => opts.paired ?? OWNER, log: (l: string) => { logs.push(l); },
    record: () => { if (fails.record) throw new Error("EIO"); return { ...files }; },
    submitRecord: (req: any) => { submitted.push(copy(req)); autoKeep(req); },
    outcome: (id: string) => { if (fails.outcome) throw new Error("EIO"); return outcomes[id] ?? null; }, maxCheckDays: opts.maxCheckDays,
    tune: (x: any) => { tuned.push(x); }, waitTimeout: (w: any) => { waited.push(w); },
    sleep: async (ms: number) => { keeper.waits++; t.now += ms; keeper.onWait?.(); }, pull: async (pr: string) => pulls[pr] ?? null, tz: "America/New_York",
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
    landed: opts.noDeployKey ? undefined : async (ship: { pr: string; head: string }, base?: string | null) => {
      github.reads++; github.bases.push(base);
      if (!github.readable) return github.unreadableWhy ? { unresolved: github.unreadableWhy } : null;
      return github.main.includes(ship.head);
    },
    // main's tip as the landing's base (a stand-in commit before anything landed).
    mainTip: opts.noDeployKey ? undefined : async () => (github.readable ? (github.main.at(-1) ?? "0".repeat(40)) : null),
    facts: opts.facts ? (pr: string) => { github.asked.push(`facts ${pr}`); return github.factsHang ? new Promise<Facts | null>(() => {}) : Promise.resolve(github.facts); } : undefined,
    checkRuns: opts.facts ? (pr: string, head: string) => { github.asked.push(`runs ${head}`); return github.runsHang ? new Promise<null>(() => {}) : Promise.resolve(copy(github.runs)); } : undefined,
    factsMs: opts.factsMs ?? 50,
    reviewed: () => (reviews.list ? copy(reviews.list) : null),
    keyKnown: opts.keyCheck ? async () => { github.keyAsked++; return github.key; } : undefined,
    report: (x: any) => { reports.push(copy(x)); },
    transcripts: () => sent,
    writeReplay: (x: any) => { replays.push(copy(x)); return "/data/work/gate-replay.json"; },
    replayPauseMs: 0,
  };
  let link = new Link(deps);
  // Asks and Ship cards for an item need a source check (0.12.0). Tests about other things
  // pass one by default, as Cain does; unchecked: true leaves it to the test.
  let sources = 0;
  const SOURCE = () => `rig: the example.org portal page, read just now (${++sources})`;
  const checking = (l: Link) => opts.unchecked ? l : new Proxy(l, { get(target, prop, recv) {
    const v = Reflect.get(target, prop, recv);
    if ((prop === "ask" || prop === "ship") && typeof v === "function")
      return (a: any) => v.call(target, a && a.checked === undefined ? { ...a, checked: SOURCE() } : a);
    return typeof v === "function" ? v.bind(target) : v;
  } });
  const tap = (msg: any, custom_id: string, over: any = {}) => {
    tapped = String(msg.id);
    return link.onInteraction({ type: 3, id: t.discord ? snowflake() : String(10 + ++taps), token: "t", application_id: BOT, channel_id: DM, user: { id: OWNER },
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
    get link() { return checking(link); },
    calls, relayed, harness, posted, logs, files, pulls, failing, refusing, limited, lose, hang, gate, beyond, t, tap, his, snowflake, stop, harnessDown, github,
    reports, replays, sent, discord, limitN, spy, reviews, submitted, outcomes, keeper, fails, tuned, waited, survive, landLedger, disk, kills, deps,
    issuedLog, crash, durable, installLog, installResults, recoverFile,
    release: () => { gate.posts = false; gate.history = false; gate.identity = false; for (const ok of waiting.splice(0)) ok(); },
    go: () => { github.hold = false; for (const ok of landWaiting.splice(0)) ok(); },
    reads: () => calls.filter((c) => c.method === "GET" && c.path.startsWith(`/channels/${DM}/messages?`)).length,
    posts: () => calls.filter((c) => c.method === "POST" && c.path === `/channels/${DM}/messages`).length,
    answers: () => calls.filter((c) => c.path.startsWith("/interactions/")).map((c) => c.body.type),
    // The tapped card's edits: an update answer, or (after a deferred answer) an edit of @original.
    updates: () => calls.filter((c) => (c.path.startsWith("/interactions/") && c.body.type === 7)
      || (c.method === "PATCH" && c.path.endsWith("/messages/@original"))).map((c) => (c.path.startsWith("/interactions/") ? c.body.data : c.body)),
    ephemerals: () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/webhooks/")).map((c) => c.body),
    cards: () => Object.values(posted).filter((m: any) => m.author.id === BOT),
    last: () => posted[lastId],
    msg: (id: string) => posted[id],
    buttons: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.label)),
    ids: (id: string) => (posted[id]?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id)),
    state: () => copy(state) as State,
    setState: (s: State) => { state = copy(s); },
    restart: () => { link = new Link(deps); return link; },
    // Round 16: the record keeper's status with its consumed set verified for its current start, by a fresh
    // fetch that saw this link run (the link takes "verified" only then); extra fields merged in.
    keeperVerified: (extra: Record<string, unknown> = {}) => {
      (link as any).runNo();
      const nonce = `k${(++seq).toString(16)}`, at = new Date(t.now).toISOString();
      (files as any).status = JSON.stringify({ clock: { synced: true, source: "the rig", diagnostic: "", at }, start: { nonce, at },
        verified: { start: nonce, at, link: state.runNonce ?? null, fetches: 1 }, ...extra });
    },
    later: (ms: number) => { t.now += ms; },
  };
  return r;
}
