// Runs Cain's link (core.ts): the Discord gateway for taps and reactions, the
// REST calls, the sweep that posts cards Cain hasn't shown in time and takes buttons
// off cards that stopped mattering, and a small local HTTP API.
//
// HTTP on port 8097. Who may call, by Cain's state (c1/contract.ts, auth.ts):
//   from the calendar specialist (the Harness App, over the Apps' network), signed both ways
//   with K_sign = HMAC-SHA256(bot token, "harness-link-sign-v2"); its old bare header (the
//   relay key, HMAC-SHA256(bot token, "harness-relay-v1")) gets 503 and nothing done:
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
//     POST /ship {text, item, pr, head, review?, reply_to?}  a Ship card for one pull request head: the link builds it
//                                                            from GitHub and the review service's line for that review
//     POST /answered {item, question?}  he answered an open ask in words
//     POST /replied {m}                 what a message of his replied to
//     POST /morning {text}              the one morning message, with Stop
//     POST /stopped {}                  whether everything is stopped (Dane's Stop), and since when
//     POST /look {m}                    a message in his DM as Discord has it now (keeper.sh card)
//     GET  /cards                       the cards up now, no text, and the ids of Cain's own replies (the reply hook's read);
//                                       with no DM id yet, it asks Discord for it first, for 0.8 s at most
//     POST /check {text, reply_to?, edit?}  what the gate does with a reply or edit, sending nothing
//     POST /reply {text, reply_to?}    a reply of Cain's with a link (keeper.sh reply): the gate's rules, then posted
//                                       with its preview off and recorded as his own reply (0.13.0, second round)
//     POST /sent {tool, ids, question, call, reply_to?, net?}  what Cain just sent (the PostToolUse hook): his edit
//                                       allowlist, the moving Stop, and what the safety net found
//     POST /replay {days}               the gate's rules over his DM, reading only; Cain hears when done
//     POST /connector {item, text}      the one notice that Claude's Home Assistant connector needs signing in
//     POST /review-grant {item, change, rounds, text}   a card asking Dane to grant a change at its review cap
//                                       1 to 3 more fix rounds (0.18.0); only his tap writes the grant
//     POST /drill-arm {mode}                         (Keeper 0.1.13) the drill card; only Dane's tap on it sets the drill flag
//     POST /ship-pass {token}           the RemoteTrigger hook, before a Ship run: the installs registered with the
//                                       keeper App, "pending" until it accepted every watched one (backup made and
//                                       verified), then each acceptance claimed and "ok" once, the token spent (a second
//                                       run on it is refused) (0.19.0, Keeper 0.1.5: the claim and the enrollment check)
//   from the PC job keeper (pcjobs/main.ts), on this machine only:
//     POST /reuse {m, values}           whether Discord message m is his yes to reusing those values from a PC
//                                       result: only his recorded "Use it" tap on one of Cain's asks that quoted
//                                       exactly those values when posted; a message he typed never counts
//                                       (core.ts reuseProof); "ok", or refused with why
//     POST /pc-notice {code, id?, job?: {site, action}, repeat?}   one of the keeper's fixed lines to him (core.ts PC_NOTICES): a stop
//                                       condition and its fix; "posted" (a plain code it has no words for gets a generic line naming it), or refused
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
import { sign as edSign } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendSynced, type Caller, checkRequest, RequestLog, RERUN_SAFE, sameKey, SIG_CONTEXT, SIG_HEADER, SignedOps, signResponse, writeSynced, boundedText } from "./auth";
import { type LinkMode, linkDecides } from "../c1/contract";
import { readReviewed } from "../reviewed";
import { makeToken } from "../ship-token";
import { ensureStop, readStop, TRUST_DIR, writeStop } from "../stop";
import { KEEPER_SENT, noteAt } from "../gate/held";
import { readHosts } from "../gate/hosts";
import { appendGate, GATE_LOG, GATE_LOG_MAX } from "../gate/log";
import { discordError, Link, Protocol, PULL, type Pull, type State } from "./core";
import { loadDeployKey } from "./deploykey";
import { keyStatus, makeGit, sshArgs, timeoutBin } from "./github";
import { facts, headChecks, inMain, land, type MergeDeps } from "./merge";
import { gateHeadRead, gateState, WATCH_DIR } from "./shipgate";
import { CARDS_DELAY_MS, CARDS_FILE, CardsWriter, readTranscripts, seedReplies, stateFile, TRANSCRIPTS, writeReplayReport } from "./publish";
import { loadShipKey } from "./shipkey";
import { attestFlow, rotationNeeded } from "./rotation";
import { armFlag, drillDeps, drillKeyFrom, fileStore, storeMarkPub } from "./drill";
import { type EnrollmentStore, keyFingerprint, noteArmedEnrollment, parseEnrollment, type PassDeps, registerInstalls, shipPass, acceptWaitMs, reconcilePasses } from "./ship-pass";
import { linkRoutes, rootFetch } from "./http";
import { GrantUnsaved, readGrants, recordGrant } from "../review/grants";
import { appendCapped, asideOf, capState, DECISIONS_FILE, GRANTS_FILE, GUARD_LOG, holdLogged, keeperArmedText, KEEPER_SLUGS, type KeeperReply, recordDecision, roundCapNow, ROUNDS_FILE, SETTINGS_FILE, sweepTemps } from "./cap";
import { readRounds } from "../review/rounds";
import { clearAlarm, raiseAlarm, selfCheck } from "../capfiles";
import { guard, paths as guardPaths } from "../guard";
import { gatewayHealthy, writeGatewayMark } from "./health-gate";
import { KEEPER_URL, keeperCall, probeHash } from "../probe/keeper";
import { check, CHECK_MS, every, fileStore, healthBody, hmacKey, NOTICE_TIMEOUT_MS, PeerWatch, probeHarness } from "./watch";

// The bot token and the plugin's allowlist, root's since C1 (the run script points these at
// their old places only for the old way of starting, before the first cutover).
const ENV = process.env.LINK_ENV ?? "/data/link/discord.env";
const ACCESS = process.env.LINK_ACCESS ?? "/data/discord/access.json";
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
const DECIDED = DECISIONS_FILE;                      // his taps on the review runner's decision cards (0.16.0, cap.ts): /data/link/review-decisions.json
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
// Read once at the start, so a store found damaged is known before anything is asked of the link.
// One whose loss couldn't be recorded: the link doesn't start (the run script tries again in 5
// seconds), rather than run on a store that could later pass for a fresh one (C1 re-check B1).
try { load(); }
catch (e) {
  console.log(`[cain] link: ERROR: its record of cards and messages is damaged and the loss couldn't be recorded (${String(e).slice(0, 80)}); not starting until it can`);
  process.exit(1);
}
if (stateStore.lostNow()) console.log("[cain] link: ERROR: its record of cards and messages was damaged on disk (both copies), kept aside, and started over");
else if (stateStore.lost()) console.log("[cain] link: its record of cards and messages was found damaged within the last 8 days: a card's request isn't run again meanwhile");

async function rest(method: string, path: string, body?: unknown, auth = true, timeoutMs?: number): Promise<any> {
  const headers: Record<string, string> = { "user-agent": "DiscordBot (https://github.com/HyndeSyte/harness, 1)" };
  if (auth) headers.authorization = `Bot ${token()}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs ?? (path.startsWith("/interactions/") ? 3000 : 20000)) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  // With the names of the fields Discord refused (never their values): a 400 that names flags is the
  // only one the link sends again, without its added preview flag (core.ts quiet, third round).
  if (r.status >= 400) throw new Error(discordError(r.status, data));
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

// The install-time self-check of the review cap's and usage guard's files (0.16.0, round 2,
// ../capfiles.ts): one wrong turns those features off here, with one alarm naming it. Round 3: run
// again at each sweep, so they come back without a restart once the file is right, and the alarm clears.
const capLog = (m: string) => console.log(`[cain] link: ${m}`);
let capOff: string | null = selfCheck({ log: capLog });
// Round 3: a tap's temp file left by a link that died mid-write is swept at the start.
sweepTemps(DECIDED, capLog);
// Round 3: the alarm for his decisions file moved aside names the copy and the step back; it's raised
// while a moved-aside copy stands and cleared at the first sweep after it's gone (writes resume then).
let asideUp: boolean | null = null;
const asideAlarm = (aside: string) => { raiseAlarm(aside, capLog, "review-decisions"); asideUp = true; };
const capSweep = () => {
  capOff = selfCheck({ log: capLog, prev: capOff });
  const a = asideOf(DECIDED);
  if (a.length && asideUp !== true) asideAlarm(a[0]);
  else if (!a.length && asideUp !== false) { if (asideUp) capLog("his decisions file's moved-aside copy is gone: decision writes resume"); clearAlarm(capLog, "decisions"); asideUp = false; }
};

// Keeper 0.1.14: the drill's files, root's 0600 (drill.ts): the flag, the signed mark and the aborted record in /data/trust, and
// the spent nonces in /data/link (0700), outside Cain's backups (config.yaml backup_exclude).
const drillStore = fileStore(process.env.CAIN_DRILL_FLAG ?? `${TRUST_DIR}/keeper-drill.json`, process.env.CAIN_DRILL_MARK ?? `${TRUST_DIR}/keeper-drill-mark.json`,
  process.env.CAIN_DRILL_SPENT ?? `${DIR}/keeper-drill-spent`, `${TRUST_DIR}/keeper-drill-aborted.jsonl`, Date.now, `${DIR}/keeper-drill-refused.json`);   // Keeper 0.1.15: the refused intent, beside the spent list
// The drill key, derived from the Ship key under its own domain; its public half kept by root for the run script and the probe.
const DRILL_MARK_PUB = process.env.CAIN_DRILL_MARK_PUB ?? `${TRUST_DIR}/keeper-drill-mark.pub`;
const drillKey = shipPriv ? drillKeyFrom(shipPriv) : null;
if (drillKey) { try { storeMarkPub(drillKey.pub, DRILL_MARK_PUB); } catch (e) { console.log(`[cain] link: couldn't keep the drill key's public half: ${String(e).slice(0, 80)}`); } }
const link = new Link({
  rest, load, save, now: Date.now, paired, toHarness,
  // A Ship tap's line carries its token (about 230 characters), so lines run to 1000.
  // Durable (C1 re-check N2): a card's line to Cain is on disk before the card's request is done.
  relay: (text) => appendSynced(QUEUE, JSON.stringify({ text: text.replace(/[\r\n\t]+/g, " ").slice(0, 1000) }) + "\n"),
  record: () => ({ pending: readOr(`${RECORD}/state/PENDING.md`), holds: readOr(HOLDS) }),
  pull: pullNow,
  tz: process.env.CHECKIN_TZ ?? "America/New_York",
  stop: { read: () => readStop(), write: (stopped, at) => writeStop(stopped, at) },
  signShip: shipPriv ? (claim) => makeToken(claim, (data) => edSign(null, data, shipPriv)) : undefined,
  // Keeper 0.1.9: his tap on the rotation card, signed with the Ship key here and sent to the keeper (rotation.ts)
  // Keeper 0.1.10: bound to the keeper's enrollment and its single-use challenge, read fresh at the tap (rotation.ts attestFlow)
  attestRotation: shipPriv ? async (id) => {
    if (!KEEPER_TOKEN) return { ok: false, why: "no keeper_token is set" };
    return attestFlow({ get: (path) => keeperCall(KEEPER_BASE, KEEPER_TOKEN, path), post: (path, body) => keeperCall(KEEPER_BASE, KEEPER_TOKEN, path, body, 20_000),
      sign: (data) => edSign(null, data, shipPriv), now: Date.now }, id);
  } : undefined,
  land: deployKey ? async ({ pr, head, stopped }) => {
    const p = pullOf(pr);
    if (!p) return { ok: false, why: "that isn't a pull request's address", again: false };
    return land({ ...github, stopped }, { repo: p.repo, pr: p.pr, head });
  } : undefined,
  landed: deployKey ? async ({ pr, head }) => { const p = pullOf(pr); return p ? inMain(github, p.repo, head) : null; } : undefined,
  facts: async (pr, head) => { const p = pullOf(pr); return p ? facts(github, p.repo, p.pr, head) : null; },
  // A Ship card reads the head's checks as the landing does (merge.ts headChecks, pcjobs-windows
  // included when the head's tests.yml names it), and the review
  // service's lines (/data/trust/reviewed.json), for a review of that head.
  checkRuns: async (pr, head) => { const p = pullOf(pr); return p ? headChecks(github, p.repo, head) : null; },
  gateWatch: (pr) => { const p = pullOf(pr); if (!p) return []; const st = gateState(WATCH_DIR, Number(p.pr)); return "heads" in st ? (st.owed ? { owed: st.owed } : st.heads) : st; },
  // 0.12.2: while a watch's acceptance stands, the card reads the gate's head through the gate's own curl wrapper
  // (shipgate.ts gateHeadRead: curl's version read anew each time, killed at its limit, a timeout named), never fetch.
  // It is authenticated when SHIP_GATE_GITHUB_TOKEN is set, the recommended default (without it these reads share
  // GitHub's 60 an hour from this address with every watch).
  gateHead: (pr, ms) => { const p = pullOf(pr); return p ? gateHeadRead(p.repo, p.pr, { ms: Math.max(1_000, ms - 500) }) : Promise.resolve({ unknown: "that isn't a pull request's address" }); },
  reviewed: () => readReviewed(),
  // The review-round cap (0.16.0, cap.ts): the runner's rounds, his taps on its decision cards (the
  // link's own file), and the probe's record of the rollback, read as they are now.
  // Round 2: his tap kept durably before the card is marked used; a decisions file that doesn't parse
  // is moved aside, never overwritten, and the App's alarm names it. While the install-time self-check
  // found a file wrong, the cap's state is unknown (no Ship card at the cap) and nothing is kept.
  capState: (pr) => capOff ? { state: "unknown", why: `the review cap's files aren't right (${capOff})` } : capState(pr, DECIDED),
  // 0.19.0: from the keeper App (GET /armed, Cain's token), judged as the replies stand now (cap.ts keeperArmed).
  armed: () => keeperArmedText(keeperReplies, Date.now(), PROBE_HASH),
  // Round 3: the record as kept comes back, and drives the card, the relay and the hold line.
  decided: (id, choice, at) => recordDecision(DECIDED, id, choice, at, { onCorrupt: asideAlarm }),
  roundCap: () => roundCapNow(),
  rounds: () => readRounds(ROUNDS_FILE),
  // 0.18.0: the owner's grants of extra review rounds (/data/review-grants.json, root:cain 0640), written
  // here only, on his tap on Cain's grant card, durably, made root:cain 0640 at every write and recreation.
  grants: () => readGrants(GRANTS_FILE),
  grant: (rec) => { if (capOff) throw new GrantUnsaved(`the review cap's files aren't right (${capOff})`); return recordGrant(GRANTS_FILE, rec); },
  capOff: () => capOff,
  // Round 3: the guard decides only; the link appends the line itself (deduplicated, capped in size and
  // rotated root-side, keeping one previous file: cap.ts appendCapped).
  guardHold: (label, what) => { const p = guardPaths(); return guard(label, what, { settingsFile: SETTINGS_FILE, spendFile: p.spend, tz: p.tz, now: new Date() }); },
  holdLog: (line) => appendCapped(GUARD_LOG, line),
  hasHold: (tag, what) => holdLogged(GUARD_LOG, tag, what),
  alarm: (kind, cause) => raiseAlarm(cause, capLog, kind),
  clearAlarm: (group) => clearAlarm(capLog, group),
  capSweep,
  keyKnown: deployKey ? () => keyStatus(SSH, SHIP_REPO, DIR) : undefined,
  // Not awaited: the log is written in the background and never throws (gate/log.ts).
  linkHosts: () => readHosts(),
  keeperSent: (at) => { noteAt(KEEPER_SENT, at); },
  // Keeper 0.1.13: his tap on the drill card, signed with the Ship key here and kept by root as the one-shot drill flag (drill.ts)
  armDrill: shipPriv ? (mode, version) => armFlag(drillStore, mode, version, Date.now(), (data) => edSign(null, data, shipPriv)) : undefined,
  // Keeper 0.1.15 item 8: his Clear tap on a refused-drill page
  clearDrill: () => { try { const was = drillStore.clearRefused(); if (was) console.log("[cain] link: the owner cleared the refused drill intent: installs go as usual again"); return was; } catch { return false; } },
  report: (r) => { void appendGate({ at: Date.now(), ...r }, GATE_LOG, GATE_LOG_MAX, (line) => console.log(`[cain] link: ${line}`)); },
  transcripts: (since) => readTranscripts(TRANSCRIPTS, since),
  writeReplay: (r) => writeReplayReport(r),
});

// Keeper 0.1.5: the last confirmed enrollment of the keeper's Ship key the link saw (ship-pass.ts enrollmentCheck).
const KEEPER_ENROLL = process.env.CAIN_KEEPER_ENROLL ?? `${TRUST_DIR}/keeper-enrollment.json`;
const enrollment: EnrollmentStore = {
  load: () => { try { return parseEnrollment(readFileSync(KEEPER_ENROLL, "utf8")); } catch { return null; } },
  store: (e) => writeSynced(KEEPER_ENROLL, JSON.stringify(e)),
};
const shipPub = () => { try { return readFileSync(SHIP_PUB, "utf8").trim() || null; } catch { return null; } };
// Keeper 0.1.13: the drill flag and mark, root's, beside the other trust files (drill.ts)
const drill = drillDeps(drillStore, shipPub, Date.now, (l) => console.log(`[cain] link: ${l}`), {
  sign: drillKey ? (data) => edSign(null, data, drillKey.priv) : undefined, markPub: () => drillKey?.pub ?? null,
  page: (kind, key, info) => { void link.drillPage(kind, key, info).catch((e) => console.log(`[cain] link: couldn't post the drill page: ${String(e).slice(0, 80)}`)); },
});
// -- the keeper App's armed state (0.19.0) -------------------------------------------------------------
// Asked every minute for each App; a reply older than 2 minutes, a refused token, any error or a binding
// that doesn't match reads as not armed (cap.ts keeperArmed). The token comes from the App's options
// (keeper_token, the run script hands it in KEEPER_TOKEN) and is never logged.
const KEEPER_TOKEN = process.env.KEEPER_TOKEN ?? "";
delete process.env.KEEPER_TOKEN;
const KEEPER_BASE = (process.env.KEEPER_URL || KEEPER_URL).replace(/\/+$/, "");
const PROBE_HASH = probeHash();
const keeperReplies: Record<string, KeeperReply | undefined> = {};
async function askKeeper(): Promise<void> {
  for (const [app, slug] of Object.entries(KEEPER_SLUGS)) {
    if (!KEEPER_TOKEN) { keeperReplies[app] = { error: "no keeper_token set" }; continue; }
    const before = enrollment.load();                     // Keeper 0.1.7: the record before the read was sent
    const r = await keeperCall(KEEPER_BASE, KEEPER_TOKEN, `/armed?app=${slug}`);
    keeperReplies[app] = r ? { status: r.status, body: JSON.stringify(r.body) } : { error: "no answer" };
    // Keeper 0.1.6: the enrollment recorded from this read too, outside any Ship pass (ship-pass.ts).
    if (r?.status === 200) { const pub = shipPub(); noteArmedEnrollment(r.body, pub ? keyFingerprint(pub) : null, enrollment, (l) => console.log(`[cain] link: ${l}`), before); }
  }
  // Keeper 0.1.9: the old Healthchecks key's rotation: one card naming its id while the keeper says a tap is needed
  if (KEEPER_TOKEN) {
    const rot = await keeperCall(KEEPER_BASE, KEEPER_TOKEN, "/rotation");
    const need = rot?.status === 200 ? rotationNeeded(rot.body) : null;
    if (need) await link.rotationCard(need.id, { kept: need.kept }).catch((e) => console.log(`[cain] link: couldn't post the rotation card: ${String(e).slice(0, 80)}`));
  }
}
void askKeeper();
setInterval(() => { void askKeeper(); }, 60_000);
// Keeper 0.1.15 item 21: keeper cards held by the quiet hours go at 07:00
setInterval(() => { void link.quietFlush().catch((e) => console.log(`[cain] link: couldn't send the cards held by the quiet hours: ${String(e).slice(0, 80)}`)); }, 60_000);

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
// Three callers, each opening only its own routes (auth.ts, C1): the calendar specialist
// signs each request with its key, never sending it; Cain shows his own key, made at each
// start, from this machine only; root's services (the broker) use a unix socket only root
// can open. A caller that proves nothing gets only /health's "ok".
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const KEYS = process.env.CAIN_KEYS ?? "/run/cain/keys";
const LINK_SOCK = process.env.CAIN_LINK_SOCK ?? "/run/cain/link.sock";
function cainKey(): string { try { return readFileSync(`${KEYS}/cain.key`, "utf8").trim(); } catch { return ""; } }
const loopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

// The routes themselves, and who may call each, are in http.ts (linkRoutes), so a test serves
// exactly what both servers here serve (0.12.0 twenty-third round; C1 put the caller in front).
// The Ship pass (0.19.0, with Keeper 0.1.3): one Ship run per token, and its installs registered with the
// keeper App over its own service (ship-pass.ts). The spent ids live in root's /data/trust.
const SHIP_PASSES = process.env.CAIN_SHIP_PASSES ?? `${TRUST_DIR}/ship-passes.json`;
const ACCEPT_WAIT_MS = acceptWaitMs(process.env.KEEPER_ACCEPT_MIN);   // Keeper 0.1.15 item 6
const keeperPost = (path: string, body: unknown) => KEEPER_TOKEN ? keeperCall(KEEPER_BASE, KEEPER_TOKEN, path, body) : Promise.resolve(null);
const shipPassDeps: PassDeps = {
  pub: shipPub,
  now: Date.now,
  load: () => { try { return readFileSync(SHIP_PASSES, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; return "unreadable"; } },
  store: (text) => writeSynced(SHIP_PASSES, text),
  // Keeper 0.1.5: POST /attempt answers 202 at once and the link polls GET /attempt/<id> until accepted or
  // refused (ATTEMPT_WAIT_MS per App); the pass stays "pending" meanwhile (ship-pass.ts).
  register: (tok, claim, done, note) => {
    const pub = shipPub();
    void registerInstalls({ api: githubApi, log: (l) => console.log(`[cain] link: ${l}`), note, enrollment, linkFp: pub ? keyFingerprint(pub) : null,
      post: (body) => keeperPost("/attempt", body), drill, markPost: (attempt, body) => keeperPost(`/attempt/${attempt}/drill-mark`, body), waitMs: ACCEPT_WAIT_MS,
      noSpace: (pr, head, app, version) => { void link.spaceCard(pr, head, app, version).catch((e) => console.log(`[cain] link: couldn't post the free-space card: ${String(e).slice(0, 80)}`)); },
      get: (path) => KEEPER_TOKEN ? keeperCall(KEEPER_BASE, KEEPER_TOKEN, path) : Promise.resolve(null) }, tok, claim)
      .then(done)
      .catch((e) => done({ ok: false, said: [`the keeper registration failed: ${String(e).slice(0, 80)}`] }));
  },
  // 3 seconds: the hook waits on the pass (about 8 seconds a request), so the claim must answer well within it.
  // Keeper 0.1.7: with the claim's request id, so a retry reads the recorded claim.
  claim: (a, request) => KEEPER_TOKEN ? keeperCall(KEEPER_BASE, KEEPER_TOKEN, `/attempt/${a.attempt}/claim`, { app: a.app, from_version: a.from, to_version: a.to, backup: a.backup, request }, 3_000) : Promise.resolve(null),
  // Keeper 0.1.11: the cancel's answer is judged (ship-pass.ts judgeCancel); anything but a plain "ended" brings the retry card
  cancel: (attempt, why) => keeperPost(`/attempt/${attempt}/cancel`, { why }),
  dropMark: (attempt) => drill.drop(attempt),
  retry: (attempt, what) => { void link.retryCard(attempt, what).catch((e) => console.log(`[cain] link: couldn't post the retry card: ${String(e).slice(0, 80)}`)); },
  enrollment,
  // Keeper 0.1.15: the wait for Keeper's acceptance (keeper_accept_min), and its reads for the reconcile at start
  waitMs: ACCEPT_WAIT_MS,
  view: (attempt) => KEEPER_TOKEN ? keeperCall(KEEPER_BASE, KEEPER_TOKEN, `/attempt/${attempt}`) : Promise.resolve(null),
  log: (l) => console.log(`[cain] link: ${l}`),
};
// Keeper 0.1.15 items 3 and 6: a pass a crash or restart left open is refused and its attempts cancelled; a passed one is read
void reconcilePasses(shipPassDeps).catch((e) => console.log(`[cain] link: the reconcile at start failed: ${String(e).slice(0, 80)}`));
const routeDeps = { link, toHarness, tz: process.env.CHECKIN_TZ, shipPass: (b: any) => shipPass(shipPassDeps, b) };
const route = linkRoutes(routeDeps);

// The specialist's signed requests: each id handled once (SignedOps, auth.ts), its answer kept
// and signed back, with K_sign = HMAC(bot token, "harness-link-sign-v2"). The old relay key,
// HMAC(bot token, "harness-relay-v1"), authorizes nothing of the specialist's in any state, and
// no signature made with it verifies, so one captured from an old Harness signs nothing (C1
// plan 3.9).
const requests = new RequestLog(`${DIR}/requests.json`);
if (requests.damagedSince) console.log(`[cain] link: ERROR: its record of the specialist's operations is damaged (both copies); no new one is taken until it can't matter (8 days)`);
else if (requests.recoveredFrom) console.log(`[cain] link: its record of the specialist's operations was read from ${requests.recoveredFrom} (the other was damaged or a step behind); nothing lost`);
// A card's request runs again only while the cards it made are on record: a store found damaged
// lost which request made which card, so then it's an explicit unknown too.
// And a card's answer from before the loss names a card that's gone: the explicit unknown.
const ops = new SignedOps(requests, Date.now, (p) => RERUN_SAFE.has(p) && !stateStore.lost(),
  (p, s) => p === "/card" && s.status === 200 && stateStore.lost() > 0 && s.at <= stateStore.lost());
// A body larger than any route takes is refused before it's read, signed or not (C1-7).
const MAX_BODY = 16_384;
// Recorded, durably, at the specialist's first signed request: until then the run script keeps
// every process of Cain's user stopped (3.12), so an old Harness's bare key never meets one.
// Only a write that succeeded counts: one that didn't is tried again at the next (C1-6).
const SIGNS = `${DIR}/specialist-signs`;
let specialistSigns = existsSync(SIGNS);
// Who may call, by state (c1/contract.ts): old in the old way, own in the new one, stopped
// while Cain isn't started. The run script sets it.
const MODE: LinkMode = (["old", "own", "stopped"] as const).includes(process.env.LINK_MODE as LinkMode) ? process.env.LINK_MODE as LinkMode : "own";
const health = (known: boolean) => json(healthBody(known, () => ({ discord: { connected, last_heard: lastHeard || null }, watch: watch.status() })));
// The specialist's state, for the status page and the alarm: when it last signed, and since
// when it has sent the old key (Harness 0.23.0's header) instead. Root's file.
const SPECIALIST_FILE = process.env.CAIN_SPECIALIST_STATE ?? "/run/cain/specialist.json";
const specialist = { signed_at: 0, old_key_since: 0, old_key_last: 0 };
let oldKeyRelayed = 0;
function saveSpecialist(): void {
  const view = { ...specialist, signs_recorded: specialistSigns, signs_error: specialistMarker.error || null,
    history_damaged_since: requests.damagedSince || null };
  try { writeFileSync(`${SPECIALIST_FILE}.tmp`, JSON.stringify(view), { mode: 0o600 }); renameSync(`${SPECIALIST_FILE}.tmp`, SPECIALIST_FILE); }
  catch { /* the status page shows nothing new */ }
}
const specialistMarker = { error: "" };
function signedNow(): void {
  const first = !specialist.signed_at;
  specialist.signed_at = Date.now(); specialist.old_key_since = 0;
  if (!specialistSigns) {
    try { writeSynced(SIGNS, String(Date.now())); specialistSigns = true; specialistMarker.error = ""; }
    catch (e) { specialistMarker.error = String(e).slice(0, 80); console.log(`[cain] link: couldn't record that the specialist signs (tried again at its next request): ${specialistMarker.error}`); }
  }
  if (first || specialistMarker.error) saveSpecialist();
}
// An old key from the specialist: 503 and nothing done. In the old way that's the calendar App
// not updated yet (the run script tells Cain after 30 minutes); after the switch it means the
// calendar App went back to 0.23.0, so Cain hears at once, at most hourly.
function oldKeySeen(): void {
  const now = Date.now();
  if (!specialist.old_key_since) specialist.old_key_since = now;
  specialist.old_key_last = now;
  saveSpecialist();
  if (MODE !== "old" && now - oldKeyRelayed > 3_600_000) {
    oldKeyRelayed = now;
    link.relayLine("The calendar App is sending its old key again, so it went back to an older version (a restore, most likely). Its cards wait at the link, none lost. Show him a new Ship card for the pull request that last updated the calendar App, so his tap installs it again, and file a note on P33 for the laptop session.");
  }
}

Bun.serve({
  // A Ship card asks GitHub first (a few seconds at most): the default 10 is too tight.
  port: PORT, hostname: "0.0.0.0", idleTimeout: 30, maxRequestBodySize: MAX_BODY,
  async fetch(req, server) {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await boundedText(req, MAX_BODY) : "";
    if (raw === null) return json({ status: "too large" }, 413);
    const target = url.pathname + url.search;
    const signKey = key(SIG_CONTEXT);
    const id = checkRequest(req.headers.get(SIG_HEADER), signKey, req.method, target, raw);
    if (id) {
      signedNow();
      const signed = (status: number, body: string) => new Response(body, { status,
        headers: { "content-type": "application/json", [SIG_HEADER]: signResponse(signKey, id, status, body) } });
      if (req.method !== "POST") {
        const res = url.pathname === "/health" ? health(true) : await route(req, url, "specialist", raw);
        return signed(res.status, await res.text());
      }
      // Each operation once (SignedOps): done, its stored answer; still running, the first's
      // answer; received but never done, reconciled, never simply repeated.
      const a = await ops.run(id, url.pathname, async () => { const res = await route(req, url, "specialist", raw, id); return { status: res.status, body: await res.text() }; });
      if (a.status === 503 && requests.damagedSince) saveSpecialist();
      return signed(a.status, a.body);
    }
    const ip = server.requestIP(req)?.address ?? "";
    const bare = req.headers.get("x-harness-key") ?? "";
    const local = loopback(ip);
    const relayKey = sameKey(bare, key("harness-relay-v1"));
    const asked = { signed: false, relayKey, cainKey: !relayKey && sameKey(bare, cainKey()), local, path: url.pathname };
    // The old key from anywhere but this machine is the specialist's: never taken (503, nothing
    // done, so an old Harness keeps its card and retries), counted for the alarm.
    if (relayKey && !local) oldKeySeen();
    if (req.method === "GET" && url.pathname === "/health")
      return health((relayKey && local && MODE === "old") || (asked.cainKey && local && MODE === "own"));
    const d = linkDecides(MODE, asked);
    if ("refuse" in d) return d.refuse === 503
      ? json({ status: "upgrading", said: "the link takes only signed requests now" }, 503)
      : json({ status: "refused" }, 403);
    return route(req, url, d.caller as Caller, raw);
  },
});
// Root's own: the broker reads the cards and says what Cain sent, and the PC job keeper checks
// his taps and tells him what it can't do (/reuse, /pc-notice). The folder is root's.
try { rmSync(LINK_SOCK, { force: true }); } catch { /* none */ }
Bun.serve({ unix: LINK_SOCK, idleTimeout: 30, maxRequestBodySize: MAX_BODY, fetch: rootFetch(routeDeps, MAX_BODY) });
try { chmodSync(LINK_SOCK, 0o600); } catch (e) { console.log(`[cain] link: couldn't close its root socket to others: ${String(e).slice(0, 80)}`); }

console.log(`[cain] link listening on ${PORT} and ${LINK_SOCK}`);
if (stateStore.lostNow())
  link.relayLine("The link's record of cards and messages was damaged on disk (both copies) and started over, the damaged copies kept aside: buttons on cards from before now won't work, and the calendar specialist's cards from just before may need sending again (they go out as an explicit unknown, never twice). Tell Dane in one line that the Pi's storage needs a look, and keep it in PENDING until it's fixed.");
if (requests.damagedNow)
  link.relayLine("The link's record of what the calendar specialist asked of it is damaged on disk (both copies), so for 8 days it takes nothing new from the specialist: what the specialist sends meanwhile waits, and is dropped after 7 days, so nothing can go out twice. Tell Dane in one line that his calendar cards are paused by a storage problem on the Pi, and keep it in PENDING until it's fixed.");
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
// The gateway's health for the probe (probe/main.ts, Cain 0.14.0): "connected <s>" or "down <s>",
// with when Discord last acknowledged a heartbeat (seconds), every 30 seconds. Root's, read by root.
const GATEWAY_STATE = process.env.CAIN_LINK_GATEWAY_STATE ?? "/run/cain/link-gateway.state";
setInterval(() => {
  try {
    writeFileSync(`${GATEWAY_STATE}.tmp`, `${connected ? "connected" : "down"} ${Math.floor(proto.lastAck / 1000)}\n`, { mode: 0o600 });
    renameSync(`${GATEWAY_STATE}.tmp`, GATEWAY_STATE);
  } catch { /* the probe then sees an old time, and fails that layer */ }
  // Cain's /ready (0.19.0, health-gate.ts; /health is liveness only): 200 only while the gateway is connected and acknowledged.
  writeGatewayMark(gatewayHealthy(connected, proto.lastAck, Date.now()));
}, 30_000);
writeGatewayMark(false);
