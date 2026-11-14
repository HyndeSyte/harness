// Runs Cain's link (core.ts): the Discord gateway for taps and reactions, the
// REST calls, the sweep that posts cards Cain hasn't shown in time and takes buttons
// off cards that stopped mattering, and a small local HTTP API.
//
// HTTP on port 8097, keyed with HMAC-SHA256(bot token, "harness-relay-v1"):
//   from the calendar specialist (the Harness add-on, over the add-ons' network):
//     POST /card {text, rows, kind, expires?}  hold a card for Cain to show (direct kinds go out now;
//                                       one with buttons goes out by itself if he hasn't shown it in about 2 minutes)
//     POST /buttons {card, rows}        change a card's buttons (after a tap)
//     POST /answer {callback, text}     a short note only Dane sees, after a tap
//     POST /relay {text}                a line for Cain
//     GET  /card-of?m=<message id>      which card a Discord message is, and its item and question
//     GET  /health                      "ok"; with the key, also the Discord connection and the watch
//   from Cain's own scripts, on this machine only (127.0.0.1); item is a PENDING id or "none":
//     POST /show {id, item, question?, reply_to?}            show a specialist's card ("posted"; "already out":
//                                                            it only files it under his item; "expired": nothing)
//     POST /ask {text, options, item, question?, reply_to?}  ask with buttons, one open at a time
//     POST /ship {text, item, pr, head, reply_to?}           a Ship card for one pull request head
//     POST /answered {item, question?}  he answered an open ask in words
//     POST /replied {m}                 what a message of his replied to
//     POST /morning {text}              the one morning message, with Stop
//     POST /stopped {}                  whether everything is stopped (Dane's Stop), and since when
//     POST /look {m}                    a message in his DM as Discord has it now (keeper.sh card)
//     GET  /cards                       the cards up now, no text, and the ids of Cain's own replies (the reply hook's read);
//                                       with no DM id yet, it asks Discord for it first, for 0.8 s at most
//     POST /check {text, reply_to?, edit?}  what the gate does with a reply or edit, sending nothing
//     POST /sent {tool, ids, question, call, reply_to?, net?}  what Cain just sent (the PostToolUse hook): his edit
//                                       allowlist, the moving Stop, and what the safety net found
//     POST /replay {days}               the gate's rules over his DM, reading only; Cain hears when done
//     POST /connector {item, text}      the one notice that Claude's Home Assistant connector needs signing in
// Nothing is published to the LAN: the App has no "ports:".
//
// The gate (piece D), enforcing since 0.10.0: the link's send points fix and refuse
// (core.ts), and log every hit to Cain's folder (../gate/log.ts). The cards go to
// /data/trust/cards.json (publish.ts) shortly after each save and each sweep. A start whose
// gate rules are newer than the last replay's replays his DM once by itself. Cain's own
// replies (never the messages he only edited) are read from his transcripts at start and
// every 6 hours, for his edit allowlist.
//
// The Ship key (wave 1, piece B; shipkey.ts) signs Dane's Ship taps once they're in main.
// Its public half goes to /data/trust/ship.pub, where the RemoteTrigger hook checks
// tokens with it. /data/trust is only root's to write; the Stop state lives there too
// (../stop.ts). The deploy key (deploykey.ts) is the one key main is locked to: with it
// the link lands his Ship tap in main (merge.ts), over SSH to GitHub, whose host keys
// are pinned (github_known_hosts). Its public half is in the log, to add on GitHub.
import { sign as edSign, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { makeToken } from "../ship-token";
import { ensureStop, readStop, since, TRUST_DIR, writeStop } from "../stop";
import { appendGate, GATE_LOG, GATE_LOG_MAX } from "../gate/log";
import { Link, Protocol, PULL, type Pull, Refusal, SAID_MAX, type State } from "./core";
import { loadDeployKey } from "./deploykey";
import { keyStatus, makeGit, sshArgs, timeoutBin } from "./github";
import { facts, inMain, land, type MergeDeps } from "./merge";
import { CARDS_DELAY_MS, CARDS_FILE, CardsWriter, readTranscripts, seedReplies, stateFile, TRANSCRIPTS, writeReplayReport } from "./publish";
import { loadShipKey } from "./shipkey";
import { check, CHECK_MS, every, fileStore, healthBody, hmacKey, NOTICE_TIMEOUT_MS, PeerWatch, probeHarness } from "./watch";

const ENV = process.env.LINK_ENV ?? "/data/.claude/channels/discord/.env";
const ACCESS = "/data/.claude/channels/discord/access.json";
const DIR = process.env.LINK_DIR ?? "/data/link";
const STATE = `${DIR}/state.json`;
const WATCH = `${DIR}/watch.json`;
const QUEUE = process.env.RELAY_QUEUE ?? "/data/relay.queue";
const PORT = Number(process.env.RELAY_PORT ?? 8097);
const RECORD = process.env.RECORD_DIR ?? "/data/record";   // the record keeper's copy
const HOLDS = process.env.RECORD_HOLDS ?? "/data/record-holds.json";   // the keeper's holds, as pushed
const SHIP_KEY = `${DIR}/ship.key`;
const SHIP_PUB = process.env.CAIN_SHIP_PUB ?? `${TRUST_DIR}/ship.pub`;
const DEPLOY_KEY = `${DIR}/deploy_key`;
const REPO_DIR = `${DIR}/repo.git`;                  // the link's own copy, for landing his Ship taps
const KNOWN_HOSTS = "/opt/cain/link/github_known_hosts";
const HARNESS = "http://0fcc2575-harness:8098";
const API = "https://discord.com/api/v10";
const SWEEP_MS = 60_000;

mkdirSync(DIR, { recursive: true, mode: 0o700 });
mkdirSync(TRUST_DIR, { recursive: true, mode: 0o755 });
// No Stop saved yet (a first start): written as running, so readers that find no file
// can take it as stopped.
try { ensureStop(Date.now()); } catch (e) { console.log(`[cain] link: couldn't write the Stop state: ${String(e).slice(0, 80)}`); }

function token(): string {
  try { return readFileSync(ENV, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m)?.[1]?.trim() ?? ""; } catch { return ""; }
}
function key(context: string): string {
  return hmacKey(token(), context);
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function paired(): string {
  try { return String(JSON.parse(readFileSync(ACCESS, "utf8")).allowFrom?.[0] ?? ""); } catch { return ""; }
}
// The cards for the reply hook go out off the save, never inside it (publish.ts): a save
// asks for one write half a second later, and so does each sweep. A failure is logged,
// never in the way: the hook asks the link first anyway.
const cards = new CardsWriter(() => load(), CARDS_FILE, CARDS_DELAY_MS, (line) => console.log(`[cain] link: ${line}`));
const stateStore = stateFile(STATE, () => cards.soon());
function load(): State { return stateStore.load(); }
function save(s: State): void { stateStore.save(s); }

async function rest(method: string, path: string, body?: unknown, auth = true, timeoutMs?: number): Promise<any> {
  const headers: Record<string, string> = { "user-agent": "DiscordBot (https://github.com/HyndeSyte/harness, 1)" };
  if (auth) headers.authorization = `Bot ${token()}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs ?? (path.startsWith("/interactions/") ? 3000 : 20000)) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`discord ${r.status}: ${String(data?.message ?? "").slice(0, 100)}`);
  return data;
}

async function toHarness(path: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${HARNESS}${path}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-harness-key": key("harness-handover-v1") },
      signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch { return false; }
}

// What the record says: PENDING.md from the keeper's copy, and the keeper's own holds
// file. A missing file is null (no holds, nothing closed); one that can't be read is
// "", which decides nothing.
function readOr(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (e: any) { return e?.code === "ENOENT" ? null : ""; }
}

// A pull request now. GitHub's API says whether it's open and its head; when that
// can't be read (it allows 60 asks an hour without a key), the head alone comes from
// GitHub's own refs. Nothing it can't tell takes a card off.
async function pullNow(pr: string): Promise<Pull | null> {
  const m = PULL.exec(pr);
  if (!m) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "cain-link" }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j: any = await r.json();
      const head = String(j?.head?.sha ?? "");
      return { head: /^[0-9a-f]{40}$/.test(head) ? head : null, open: j?.state === "open" ? true : j?.state === "closed" ? false : null,
        merged: j?.merged === true };
    }
  } catch { /* fall back to the refs */ }
  try {
    const p = Bun.spawn(["git", "-c", "credential.helper=", "ls-remote", `https://github.com/${m[1]}/${m[2]}.git`, `refs/pull/${m[3]}/head`],
      { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", HOME: "/tmp" } });
    const timer = setTimeout(() => p.kill(), 20000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    const sha = out.trim().split(/\s+/)[0] ?? "";
    return { head: /^[0-9a-f]{40}$/.test(sha) ? sha : null, open: null };
  } catch { return null; }
}

// The Ship key: made once, never printed. No key: Ship taps carry no token, and Ship
// runs are refused until it's fixed.
const shipKey = loadShipKey(SHIP_KEY, SHIP_PUB, (line) => console.log(`[cain] link: ${line}`));
const shipPriv = shipKey?.key ?? null;

// The deploy key: made once, never printed. No key: nothing lands in main.
const deployKey = loadDeployKey(DEPLOY_KEY, (line) => console.log(`[cain] link: ${line}`));

// GitHub, for landing his Ship taps: its API without a key (a public repository; 60 asks
// an hour), and git in the link's own copy, over SSH with the deploy key and GitHub's
// pinned host keys. Nothing else's config or credentials take part.
async function githubApi(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { accept: "application/vnd.github+json", "user-agent": "cain-link", "x-github-api-version": "2022-11-28" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const SSH = sshArgs(DEPLOY_KEY, KNOWN_HOSTS);
const gitRun = makeGit({ repoDir: REPO_DIR, ssh: SSH.join(" "), home: DIR, timeoutBin: timeoutBin() });
const github: MergeDeps = { api: githubApi, git: gitRun, stopped: () => readStop().stopped };
const SHIP_REPO = "HyndeSyte/harness";
const pullOf = (pr: string) => { const m = PULL.exec(pr); return m ? { repo: `${m[1]}/${m[2]}`, pr: Number(m[3]) } : null; };

const link = new Link({
  rest, load, save, now: Date.now, paired, toHarness,
  // A Ship tap's line carries its token (about 230 characters), so lines run to 1000.
  relay: (text) => appendFileSync(QUEUE, JSON.stringify({ text: text.replace(/[\r\n\t]+/g, " ").slice(0, 1000) }) + "\n"),
  record: () => ({ pending: readOr(`${RECORD}/state/PENDING.md`), holds: readOr(HOLDS) }),
  pull: pullNow,
  tz: process.env.CHECKIN_TZ ?? "America/New_York",
  stop: { read: () => readStop(), write: (stopped, at) => writeStop(stopped, at) },
  signShip: shipPriv ? (claim) => makeToken(claim, (data) => edSign(null, data, shipPriv)) : undefined,
  land: deployKey ? async ({ pr, head, stopped }) => {
    const p = pullOf(pr);
    if (!p) return { ok: false, why: "that isn't a pull request's address", again: false };
    return land({ ...github, stopped }, { repo: p.repo, pr: p.pr, head });
  } : undefined,
  landed: deployKey ? async ({ pr, head }) => { const p = pullOf(pr); return p ? inMain(github, p.repo, head) : null; } : undefined,
  facts: async (pr) => { const p = pullOf(pr); return p ? facts(github, p.repo, p.pr) : null; },
  keyKnown: deployKey ? () => keyStatus(SSH, SHIP_REPO, DIR) : undefined,
  // Not awaited: the log is written in the background and never throws (gate/log.ts).
  report: (r) => { void appendGate({ at: Date.now(), ...r }, GATE_LOG, GATE_LOG_MAX, (line) => console.log(`[cain] link: ${line}`)); },
  transcripts: (since) => readTranscripts(TRANSCRIPTS, since),
  writeReplay: (r) => writeReplayReport(r),
});

// -- the gateway's health, for the Harness page ------------------------------------
let connected = false;
let lastHeard = 0;                       // ms: the last thing Discord's gateway sent

// -- the mutual watch on the calendar specialist (watch.ts) -------------------------
const watchLog = (line: string) => console.log(`[cain] link: ${line}`);
const watch = new PeerWatch({ ...fileStore(WATCH, watchLog), now: Date.now, mono: () => performance.now() });

async function harnessAlive(): Promise<boolean | "refused"> {
  if (!token()) return true;             // no key yet: nothing to check with, and nothing to say
  // 404 (an older Harness without /health) is alive; 403 is "refused"; 5xx, its own
  // "stuck" (its loop hasn't turned in 10 minutes) or no answer at all is down.
  return probeHarness((signal) => fetch(`${HARNESS}/health`,
    { headers: { "x-harness-key": key("harness-handover-v1") }, signal }));
}

every(CHECK_MS, () => check(watch, harnessAlive,
  async (text) => { await link.notice(text, NOTICE_TIMEOUT_MS); },
  watchLog,
  (what) => link.relayLine(what === "down"
    ? "Your App told Dane the calendar specialist hasn't answered for 5 minutes. Calendar handovers will fail until it's back; don't promise calendar changes."
    : what === "still"
      ? "Your App told Dane the calendar specialist is still down after 30 minutes, and how to restart it. Nothing more to tell him."
      : "Your App told Dane the calendar specialist is answering again.")), watchLog);

// -- the sweep: at start (the first one also looks over cards already posted), then
//    every minute, never two at once ---------------------------------------------------
const sweepLog = (line: string) => console.log(`[cain] link: ${line}`);
async function sweepLoop(): Promise<void> {
  try { if (token()) await link.sweep(); } catch (e) { sweepLog(`sweep failed: ${String(e).slice(0, 80)}`); }
  finally { cards.soon(); setTimeout(sweepLoop, SWEEP_MS); }
}
setTimeout(sweepLoop, 3000);

// The gate's replay, once by itself when its rules are newer than the last replay's (or none
// is on record): everything in his DM from the last 30 days, read only. Cain hears when
// it's done, files it, and checks the gate end to end.
setTimeout(() => { if (token() && link.replayDue()) link.replay(30, "rules"); }, 120_000);

// Cain's own replies, from his transcripts: the messages he may edit (35 days). Then every
// 6 hours, only files changed since (the PostToolUse hook tells the link of each one too).
const SEED_EVERY_MS = 6 * 3_600_000;
async function seed(): Promise<void> {
  try {
    const was = load().seeded;
    const n = await seedReplies(link, TRANSCRIPTS, was ? was - 3_600_000 : Date.now() - 35 * 86_400_000);
    if (n) console.log(`[cain] link: ${n} of Cain's replies added to the ones he may edit`);
  } catch (e) { console.log(`[cain] link: couldn't read Cain's transcripts for his replies: ${String(e).slice(0, 80)}`); }
  finally { setTimeout(seed, SEED_EVERY_MS); }
}
setTimeout(seed, 10_000);

// -- HTTP -------------------------------------------------------------------------
const LOCAL_ONLY = new Set(["/show", "/ask", "/morning", "/ship", "/answered", "/replied", "/stopped", "/look", "/cards", "/check", "/replay", "/connector", "/sent"]);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(String);

Bun.serve({
  // A Ship card asks GitHub first (a few seconds at most): the default 10 is too tight.
  port: PORT, hostname: "0.0.0.0", idleTimeout: 30,
  async fetch(req, server) {
    const url = new URL(req.url);
    const keyOk = same(req.headers.get("x-harness-key") ?? "", key("harness-relay-v1"));
    if (req.method === "GET" && url.pathname === "/health")
      return json(healthBody(keyOk, () => ({ discord: { connected, last_heard: lastHeard || null }, watch: watch.status() })));
    if (!keyOk) return json({ status: "refused" }, 403);
    const ip = server.requestIP(req)?.address ?? "";
    if (LOCAL_ONLY.has(url.pathname) && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1")
      return json({ status: "refused" }, 403);
    if (req.method === "GET" && url.pathname === "/card-of") return json(link.cardInfo(url.searchParams.get("m") ?? ""));
    if (req.method === "GET" && url.pathname === "/cards") return json(await link.cardsFor());
    if (req.method !== "POST") return json({ status: "not found" }, 404);
    const raw = await req.text();
    if (raw.length > 16384) return json({ status: "too large" }, 413);
    let b: any = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { return json({ status: "not JSON" }, 400); }
    try {
      switch (url.pathname) {
        case "/card": return json({ id: await link.addCard({ text: String(b.text ?? ""), rows: b.rows ?? [], kind: b.kind, expires: b.expires }) });
        case "/buttons": await link.editButtons(Number(b.card), b.rows ?? []); return json({ status: "ok" });
        case "/answer": await link.followup(String(b.callback ?? ""), String(b.text ?? "")); return json({ status: "ok" });
        case "/relay": { const t = String(b.text ?? "").trim(); if (t) link.relayLine(t); return json({ status: "ok" }); }
        case "/show": return json(await link.showCard(Number(b.id), { item: b.item, question: b.question, replyTo: b.reply_to }));
        case "/ask": return json(await link.ask({ text: String(b.text ?? ""), options: list(b.options),
          item: b.item, question: b.question, replyTo: b.reply_to }));
        case "/ship": return json(await link.ship({ text: String(b.text ?? ""), item: b.item, pr: b.pr, head: b.head, replyTo: b.reply_to }));
        case "/answered": return json(await link.answered({ item: b.item, question: b.question }));
        case "/replied": return json(await link.replied(b.m));
        case "/look": return json(await link.look(b.m));
        case "/check": return json(link.checkSend({ text: b.text, replyTo: b.reply_to, edit: b.edit }));
        case "/sent": return json(await link.sent(b, { background: true }));
        case "/replay": return json(link.replay(b.days));
        case "/connector": return json(await link.connector({ item: b.item, text: b.text }));
        case "/stopped": {
          const st = link.stopped();
          return json({ status: "ok", stopped: st.stopped, said: !st.stopped ? "Nothing is stopped."
            : st.at === null ? "Nothing runs: the Stop state can't be read. Tell Dane in one line, and log a Build item."
            : `Everything has been stopped${since(st, process.env.CHECKIN_TZ)}: Dane tapped Stop. Only he can turn it back on.` });
        }
        case "/morning": {
          if (list(b.options).length) throw new Refusal("the morning message asks nothing: send each decision with ask");
          const m = await link.morningPost(String(b.text ?? ""));
          await toHarness("/morning-posted", {});
          return json({ status: "posted", ...m });
        }
      }
    } catch (e) {
      if (e instanceof Refusal) return json({ status: "refused", said: e.message.slice(0, SAID_MAX) }, 400);
      return json({ status: "error", said: String(e).slice(0, 200) }, 500);
    }
    return json({ status: "not found" }, 404);
  },
});
console.log(`[cain] link listening on ${PORT}`);
if (shipKey?.remade)
  link.relayLine("The Ship key couldn't be read, so a new one was made. Ship tokens from before it no longer count, so an install waiting on one needs a new Ship card. Nothing else to do: his next Ship tap is signed with the new key.");
if (!deployKey)
  link.relayLine("The link has no deploy key, so his Ship taps can't land anything in main until that's fixed. Tell Dane in one line that shipping is down, and log a Build item.");
else if (deployKey.made)
  link.relayLine(`The link made a new deploy key${deployKey.remade ? " (the old one couldn't be read)" : ""}. Until its public half (in the add-on's log) is added on GitHub, and any old one deleted there, his Ship taps can't land anything in main (RELEASING.md, If the deploy key is remade). If a laptop session is installing this release, it adds the key itself: nothing to tell him. Otherwise (a restored Pi, say), tell him in one line that shipping is down until a laptop session at his PC adds it, and keep it in PENDING marked "At his PC".`);

// -- the gateway: taps and reactions ---------------------------------------------------
let ws: WebSocket | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let failures = 0;
let fatal = "";
let fatalToken = "";
let lastToken = token();

const proto = new Protocol((o) => ws?.send(JSON.stringify(o)), token, {
  ready: () => { failures = 0; connected = true; console.log("[cain] link: connection ready"); },
  interaction: (d) => { link.onInteraction(d).catch((e) => console.log(`[cain] link: tap failed: ${String(e).slice(0, 80)}`)); },
  reaction: (d) => { link.onReaction(d).catch((e) => console.log(`[cain] link: reaction failed: ${String(e).slice(0, 80)}`)); },
});

function connect(): void {
  const t = token();
  if (t !== lastToken) { lastToken = t; link.forget(); proto.session = null; proto.seq = null; }
  if (!t) { setTimeout(connect, 30000); return; }
  if (fatal && fatalToken === t) { setTimeout(connect, 60000); return; }
  fatal = "";
  const base = proto.session && proto.resumeUrl ? proto.resumeUrl : "wss://gateway.discord.gg";
  const host = new URL(base).hostname;
  if (host !== "gateway.discord.gg" && !host.endsWith(".discord.gg")) { proto.session = null; setTimeout(connect, 5000); return; }
  ws = new WebSocket(`wss://${host}/?v=10&encoding=json`);
  ws.onmessage = (ev) => {
    lastHeard = Date.now();
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (proto.handle(m) === "reconnect") { ws?.close(4000); return; }
    if (m.op === 10) {
      if (beat) clearInterval(beat);
      setTimeout(() => proto.beat(), Math.random() * proto.interval);
      beat = setInterval(() => { if (proto.dead()) ws?.close(4000); else proto.beat(); }, proto.interval);
    }
  };
  ws.onclose = (ev) => {
    connected = false;
    if (beat) clearInterval(beat);
    proto.interval = 0;
    const what = proto.closed(ev.code);
    if (what === "fatal") { fatal = String(ev.code); fatalToken = t; console.log(`[cain] link: Discord closed the connection: ${ev.code}`); }
    failures++;
    setTimeout(connect, Math.min(60000, 1000 * 2 ** Math.min(failures, 6)) * (0.8 + Math.random() * 0.4));
  };
  ws.onerror = () => {};
}
connect();
