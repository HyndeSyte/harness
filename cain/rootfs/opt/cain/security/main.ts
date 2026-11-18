// The security watch's process and commands (core.ts says what it watches). Started by the
// App's run script like the record keeper; nothing here acts on anything but its own files
// and the one heartbeat ping.
//   bun main.ts run                 the loop: a heartbeat ping every 5 minutes (when
//                                   heartbeat_url is set) and the key record kept current
//   bun main.ts fail                one ping to <heartbeat_url>/fail (the App stopping on an error)
//   bun main.ts lines morning|other the check-in's "Security watch" line, or nothing
//   bun main.ts key-expiry <name> <YYYY-MM-DD|none>   (keeper.sh key-expiry)
//   bun main.ts key-ack <name> <YYYY-MM-DD>           (keeper.sh key-ack: a key that never expires by design)
//   bun main.ts keys                each key's name, first observed, expiry: never a key, never a hash
// The heartbeat URL comes in HEARTBEAT_URL, is read once and taken out of the environment,
// and is never printed: not in a log line, an error, a file or the check-in.
// The keys come in as hashes only (KEY_SHA_<name>, made by the run script from the App's
// options); the bot token and the link's two key files are hashed here, read and dropped.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { heldLine, KEEPER_SENT, LINK_HELD, readAt } from "../gate/held.ts";
import { configFromEnv } from "../review/config.ts";
import { daysFileOf, type DayLedger, type Ledger } from "../review/runner.ts";
import {
  afterPing, type BeatState, dayOf, errorName, failUrl, heartbeatLines, heartbeatUrl, keyLines, KEYS, observeKeys, parseKeys,
  PING_EVERY_MS, PING_TIMEOUT_MS, section, setAck, setExpiry, spendLines, statusLine,
} from "./core.ts";

export interface Paths { beat: string; keys: string; discordEnv: string; deployKey: string; shipKey: string }
export const paths = (env: Record<string, string | undefined> = process.env): Paths => ({
  beat: env.SECURITY_HEARTBEAT_STATE ?? "/data/security/heartbeat.json",
  keys: env.SECURITY_KEYS ?? "/data/keys.json",
  discordEnv: env.CAIN_DISCORD_ENV ?? "/data/.claude/channels/discord/.env",
  deployKey: env.LINK_DEPLOY_KEY ?? "/data/link/deploy_key",
  shipKey: env.LINK_SHIP_KEY ?? "/data/link/ship.key",
});

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
function writeWhole(p: string, text: string) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, text, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
export const sha = (v: string) => createHash("sha256").update(v).digest("hex");

// -- heartbeat --------------------------------------------------------------------------------------
export type Fetch = (url: string, init: { method: string; body?: string; headers?: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; status: number }>;

export function readBeat(p: string): BeatState | null {
  try { const j = JSON.parse(read(p) ?? ""); return j && typeof j.state === "string" ? j : null; } catch { return null; }
}
// One ping. Returns the state written. The URL never leaves this function but in the request.
export async function ping(raw: string | undefined, o: { fetch: Fetch; now: number; upMs: number; file: string; log: (m: string) => void; fail?: boolean; version?: string }): Promise<BeatState> {
  const b = heartbeatUrl(raw);
  const prev = readBeat(o.file) ?? { state: "unset", fails: 0 } as BeatState;
  if (b.kind !== "ok") {
    const st: BeatState = { state: b.kind, fails: 0 };
    if (prev.state !== st.state) { writeWhole(o.file, JSON.stringify(st)); if (b.kind === "invalid") o.log("heartbeat_url isn't an https address to a named site: nothing is sent"); }
    return st;
  }
  const target = o.fail ? failUrl(b.url) : b.url;
  let ok = false, why = "";
  try {
    const r = await o.fetch(target.href, { method: "POST", body: statusLine(o.upMs, o.version), headers: { "content-type": "text/plain" },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS), redirect: "error" });
    ok = r.ok;
    if (!ok) why = errorName(null, r.status);
  } catch (e) { why = errorName(e); }
  // A logged failure names the host and the error's code only (third round): never the URL, its path or
  // query, and never the error's own message, which can carry the URL.
  const said = `${b.url.hostname}, ${why}`;
  if (o.fail) { o.log(ok ? "told the outside heartbeat the App stopped on an error" : `couldn't tell the outside heartbeat the App stopped (${said})`); return prev; }
  const st = afterPing(prev.state === "ok" ? prev : { state: "ok", fails: 0 }, ok, o.now, why || undefined);
  writeWhole(o.file, JSON.stringify(st));
  if (ok && (prev.state !== "ok" || prev.fails > 0)) o.log("outside heartbeat sent");
  else if (!ok && (st.fails === 1 || st.fails % 12 === 0)) o.log(`outside heartbeat failed (${said}), ${st.fails} in a row`);
  return st;
}

// The loop's heartbeat part: a ping, then a wait of PING_EVERY_MS, round after round (rounds:
// for the tests). With heartbeat_url empty nothing is sent, ever.
export async function beatLoop(raw: string | undefined, o: { fetch: Fetch; file: string; log: (m: string) => void; sleep: (ms: number) => Promise<void>;
                                 now?: () => number; started?: number; rounds?: number; everyMs?: number; version?: string; between?: () => void }): Promise<void> {
  const now = o.now ?? Date.now;
  const started = o.started ?? now();
  for (let i = 0; o.rounds === undefined || i < o.rounds; i++) {
    o.between?.();
    try { await ping(raw, { fetch: o.fetch, now: now(), upMs: now() - started, file: o.file, log: o.log, version: o.version }); }
    catch (e) { o.log(`heartbeat round failed: ${(e as Error).name}`); }
    await o.sleep(o.everyMs ?? PING_EVERY_MS);
  }
}

// -- keys -------------------------------------------------------------------------------------------
// The hashes as seen now: the App's options from the environment (hashes made by the run script),
// the bot token from its file, the link's keys from theirs.
export function seenNow(env: Record<string, string | undefined>, p: Paths): Record<string, string | null> {
  const seen: Record<string, string | null> = {};
  for (const name of ["github_token", "pc_jobs_token", "gemini_api_key", "perplexity_api_key", "anthropic_api_key"]) {
    const v = env[`KEY_SHA_${name}`];
    if (v !== undefined) seen[name] = /^[0-9a-f]{64}$/.test(v) ? v : null;
  }
  const tok = /^DISCORD_BOT_TOKEN=(.*)$/m.exec(read(p.discordEnv) ?? "")?.[1]?.trim();
  seen.discord_bot_token = tok ? sha(tok) : null;
  const dk = read(p.deployKey), sk = read(p.shipKey);
  seen.deploy_key = dk && dk.trim() ? sha(dk) : null;
  seen.ship_key = sk && sk.trim() ? sha(sk) : null;
  return seen;
}
export function keepKeys(env: Record<string, string | undefined>, p: Paths, today: string, log: (m: string) => void) {
  const before = parseKeys(read(p.keys));
  const { file, changed } = observeKeys(before, seenNow(env, p), today);
  if (changed.length || read(p.keys) === null) writeWhole(p.keys, JSON.stringify(file, null, 1));
  for (const c of changed) log(`key record: ${c}`);
  return file;
}

// -- the check-in's line ----------------------------------------------------------------------------
export function lines(kind: "morning" | "other", env: Record<string, string | undefined> = process.env, now = new Date()): string {
  const p = paths(env);
  const cfg = configFromEnv(env);
  const today = dayOf(now, cfg.tz);
  const json = <T>(f: string, d: T): T => { try { return JSON.parse(read(f) ?? "") as T; } catch { return d; } };
  const morning = kind === "morning";
  const out = [
    ...heartbeatLines(readBeat(p.beat), morning, cfg.tz),
    ...spendLines({ ledger: json<Ledger>(cfg.spendFile, {}), days: json<DayLedger>(daysFileOf(cfg), {}), caps: cfg.caps, today, morning }),
    ...(morning ? keyLines(parseKeys(read(p.keys)), today) : []),
    // A reply held for keeper.sh reply over 10 minutes ago, with no keeper reply since (third round).
    ...[heldLine(readAt(env.CAIN_LINK_HELD ?? LINK_HELD), readAt(env.CAIN_KEEPER_SENT ?? KEEPER_SENT), now.getTime())].filter((l): l is string => !!l),
  ];
  return section(out);
}

if (import.meta.main) {
  const env = process.env;
  const log = (m: string) => console.log(`[security] ${m}`);
  const [cmd, a1, a2] = process.argv.slice(2);
  const url = env.HEARTBEAT_URL;
  delete env.HEARTBEAT_URL;
  const p = paths(env);
  const tz = configFromEnv(env).tz;
  const version = env.CAIN_VERSION;
  switch (cmd) {
    case "run": {
      let lastKeys = 0;
      const b = heartbeatUrl(url);
      log(`outside heartbeat ${b.kind === "ok" ? "on" : b.kind === "invalid" ? "set but not usable" : "off (heartbeat_url is empty)"}`);
      // The key record each hour (a new bot token or a remade link key shows up without a restart).
      const keys = () => {
        if (Date.now() - lastKeys <= 3_600_000) return;
        try { keepKeys(env, p, dayOf(new Date(), tz), log); } catch (e) { log(`couldn't keep the key record: ${(e as Error).name}`); }
        lastKeys = Date.now();
      };
      await beatLoop(url, { fetch: fetch as unknown as Fetch, file: p.beat, log, sleep: (ms) => Bun.sleep(ms), version, between: keys });
      break;
    }
    case "fail":
      await ping(url, { fetch: fetch as unknown as Fetch, now: Date.now(), upMs: 0, file: p.beat, log, fail: true, version });
      break;
    case "lines": {
      const t = lines(a1 === "morning" ? "morning" : "other", env);
      if (t) console.log(t);
      break;
    }
    case "key-expiry": {
      const r = setExpiry(parseKeys(read(p.keys)), String(a1 ?? ""), String(a2 ?? ""));
      if (r.file) writeWhole(p.keys, JSON.stringify(r.file, null, 1));
      console.log(JSON.stringify({ status: r.file ? "ok" : "error", said: r.said }));
      process.exit(r.file ? 0 : 2);
    }
    case "key-ack": {
      const r = setAck(parseKeys(read(p.keys)), String(a1 ?? ""), String(a2 ?? ""), dayOf(new Date(), tz));
      if (r.file) writeWhole(p.keys, JSON.stringify(r.file, null, 1));
      console.log(JSON.stringify({ status: r.file ? "ok" : "error", said: r.said }));
      process.exit(r.file ? 0 : 2);
    }
    case "keys": {
      const f = parseKeys(read(p.keys));
      for (const name of Object.keys(KEYS)) {
        const r = f.keys[name];
        console.log(`${name}: ${!r ? "not observed" : `${r.present ? "" : "gone, "}first observed ${r.first_seen}${r.expires ? `, expires ${r.expires}` : ", no expiry set"}${r.ack ? `, acknowledged until ${r.ack}` : ""}`}`);
      }
      break;
    }
    default:
      console.error("usage: main.ts run | fail | lines morning|other | key-expiry <name> <YYYY-MM-DD|none> | key-ack <name> <YYYY-MM-DD> | keys");
      process.exit(2);
  }
}
