// The security watch (Cain 0.13.0): the outside heartbeat, the review spend lines and the
// jump rule, the key record, link previews off on every posting path, and the gate's rule on
// links in Cain's replies. Fixtures only: nothing here is anyone's real key, mail or calendar.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkProblem, linksHits, LINKS_WHY } from "../rootfs/opt/cain/gate/cain";
import { decideSend } from "../rootfs/opt/cain/gate/send";
import { entry } from "../rootfs/opt/cain/hooks/discord-send";
import { noteOf } from "../rootfs/opt/cain/hooks/discord-sent";
import { quiet, STOP } from "../rootfs/opt/cain/link/core";
import { DAYS_KEPT, Runner } from "../rootfs/opt/cain/review/runner";
import {
  emptyKeys, failUrl, heartbeatLines, heartbeatUrl, jumpOf, keyLines, observeKeys, PING_EVERY_MS, section, setExpiry, spendLines, statusLine,
} from "../rootfs/opt/cain/security/core";
import { beatLoop, type Fetch, keepKeys, lines, ping, readBeat, sha } from "../rootfs/opt/cain/security/main";
import { DAY, DM, MIN, PR, rig, SHA1 } from "./link-rig";

const ROOT = join(import.meta.dir, "..", "..");
const CAIN = join(ROOT, "cain", "rootfs", "opt", "cain");
const tmp = () => mkdtempSync(join(tmpdir(), "security-"));
// A made-up ping URL with a token in it, to show it never reaches a log or a file.
const PING_PATH = "made-up-ping-path-0001";
const URL_ = `https://hc-ping.example.net/${PING_PATH}`;

function fakeFetch(answer: (url: string) => { ok: boolean; status: number } | Error) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f: Fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  };
  return { f, calls };
}

describe("the outside heartbeat", () => {
  test("pings every 5 minutes, each with only a one-line status", async () => {
    const dir = tmp(), file = join(dir, "beat.json"), logs: string[] = [], sleeps: number[] = [];
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    let t = 1_000_000;
    await beatLoop(URL_, { fetch: f, file, log: (m) => logs.push(m), sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, started: t, rounds: 4 });
    expect(calls.map((c) => c.url)).toEqual([URL_, URL_, URL_, URL_]);
    expect(sleeps).toEqual([PING_EVERY_MS, PING_EVERY_MS, PING_EVERY_MS, PING_EVERY_MS]);
    expect(PING_EVERY_MS).toBe(5 * 60_000);
    expect(calls[0].body).toBe("up 0m");
    expect(calls[3].body).toBe("up 15m");
    expect(readBeat(file)).toMatchObject({ state: "ok", fails: 0, last_ok: t - PING_EVERY_MS });
    expect(statusLine(26 * 3_600_000, "0.13.0")).toBe("up 1d 2h, Cain 0.13.0");
  });

  test("pings <url>/fail once when the App stops on an error, and never logs or keeps the URL", async () => {
    const dir = tmp(), file = join(dir, "beat.json"), logs: string[] = [];
    const { f, calls } = fakeFetch((u) => (u.endsWith("/fail") ? { ok: true, status: 200 } : new Error(`connect ECONNREFUSED ${URL_}`)));
    for (let i = 0; i < 3; i++) await ping(URL_, { fetch: f, now: i, upMs: 0, file, log: (m) => logs.push(m) });
    await ping(URL_, { fetch: f, now: 9, upMs: 0, file, log: (m) => logs.push(m), fail: true });
    expect(calls.map((c) => c.url)).toEqual([URL_, URL_, URL_, `${URL_}/fail`]);
    expect(failUrl(new URL(`${URL_}/?x=1`)).href).toBe(`${URL_}/fail?x=1`);
    const st = readBeat(file)!;
    expect(st.fails).toBe(3);
    const everything = [...logs, readFileSync(file, "utf8")].join("\n");
    expect(everything).not.toContain(PING_PATH);
    // Third round: a logged failure names the host and the error's code, nothing more; the state file not even the host.
    expect(readFileSync(file, "utf8")).not.toContain("hc-ping");
    for (const l of logs) expect(l.replace("hc-ping.example.net", "")).not.toContain("hc-ping");
    expect(logs.some((l) => l.includes("told the outside heartbeat the App stopped"))).toBe(true);
    // An HTTP failure is named by its status, nothing else.
    const { f: f2 } = fakeFetch(() => ({ ok: false, status: 404 }));
    await ping(URL_, { fetch: f2, now: 10, upMs: 0, file, log: (m) => logs.push(m) });
    expect(readBeat(file)).toMatchObject({ fails: 4, last_error: "HTTP 404" });
  });

  test("silent when the option is empty; refuses anything but https to a named host", async () => {
    const dir = tmp(), file = join(dir, "beat.json"), logs: string[] = [];
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    for (const raw of ["", "null", undefined]) {
      await beatLoop(raw, { fetch: f, file, log: (m) => logs.push(m), sleep: async () => {}, rounds: 3 });
      await ping(raw, { fetch: f, now: 0, upMs: 0, file, log: (m) => logs.push(m), fail: true });
    }
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(existsSync(file)).toBe(false);
    for (const bad of ["http://hc-ping.example.net/x", "https://user:pw@hc-ping.example.net/x", "https://10.0.0.5/x", "https://[::1]/x", "not a url"])
      expect(heartbeatUrl(bad).kind).toBe("invalid");
    await ping("http://hc-ping.example.net/x", { fetch: f, now: 0, upMs: 0, file, log: (m) => logs.push(m) });
    expect(calls).toEqual([]);
    expect(readBeat(file)?.state).toBe("invalid");
    expect(logs.join(" ")).not.toContain("hc-ping");
  });

  test("the CLI: fail with no URL sends nothing and prints nothing; the finish script pings by curl", () => {
    const dir = tmp();
    const p = Bun.spawnSync(["bun", join(CAIN, "security", "main.ts"), "fail"], {
      env: { ...process.env, HEARTBEAT_URL: "", SECURITY_HEARTBEAT_STATE: join(dir, "b.json") }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString() + p.stderr.toString()).toBe("");
    const finish = readFileSync(join(ROOT, "cain/rootfs/etc/services.d/cain/finish"), "utf8");
    expect(finish).toContain("-K -");
    const run = readFileSync(join(ROOT, "cain/rootfs/etc/services.d/cain/run"), "utf8");
    expect(run).toContain("security/main.ts run");
    expect(run).not.toMatch(/echo[^\n]*HEARTBEAT_URL/);
  });

  test("its check-in lines: the one step while empty, a failure only after three in a row", () => {
    const tz = "America/New_York";
    expect(heartbeatLines(null, true, tz)[0]).toContain("No outside heartbeat yet");
    expect(heartbeatLines(null, true, tz)[0]).toContain("heartbeat_url");
    expect(heartbeatLines(null, false, tz)).toEqual([]);
    expect(heartbeatLines({ state: "ok", fails: 2, last_ok: 0 }, false, tz)).toEqual([]);
    expect(heartbeatLines({ state: "ok", fails: 3, last_ok: 0, last_error: "timed out" }, false, tz)[0]).toContain("failed 3 times in a row");
    expect(heartbeatLines({ state: "ok", fails: 0, last_ok: Date.UTC(2026, 10, 18, 12, 5) }, true, tz)[0]).toBe("Outside heartbeat: working, last sent at 7:05 AM.");
  });
});

// -- spend --------------------------------------------------------------------------------------
const CAPS = { gemini: 8, perplexity: 4, claude: 30, openaiRuns: 200 };
const TODAY = "2026-11-18";
function week(seat: string, usd: number, from = "2026-11-10", n = 7) {
  const days: any = {};
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.parse(`${from}T12:00:00Z`) + i * DAY).toISOString().slice(0, 10);
    days[d] = { [seat]: { usd, runs: 1 } };
  }
  return days;
}

describe("the spend lines and the jump rule", () => {
  test("morning: yesterday and the month so far against each cap", () => {
    const days = { ...week("gemini", 0.1), "2026-11-17": { gemini: { usd: 0.2, runs: 2 }, openai: { usd: 0, runs: 3 } } };
    const ledger = { "2026-11": { gemini: { usd: 1.4, runs: 9, findings: 0, searches: 0 }, openai: { usd: 0, runs: 12, findings: 0, searches: 0 } } };
    const out = spendLines({ ledger, days, caps: CAPS, today: TODAY, morning: true });
    expect(out).toEqual(["Review spend: OpenAI 3 runs yesterday, 12 runs of 200 runs this month; Gemini $0.20 yesterday, $1.40 of $8.00 this month; Perplexity $0.00 yesterday, $0.00 of $4.00 this month; Claude $0.00 yesterday, $0.00 of $30.00 this month."]);
  });

  test("a day over 3 times the trailing 7-day average is flagged; under it, or under the floor, isn't", () => {
    const base = week("claude", 0.3);                                  // 7 days of $0.30 before yesterday
    expect(jumpOf({ ...base, "2026-11-17": { claude: { usd: 1.6, runs: 1 } } }, "2026-11-17", "claude", CAPS)).toContain("over 3 times the 7-day average of $0.30");
    expect(jumpOf({ ...week("claude", 0.2), "2026-11-17": { claude: { usd: 0.9, runs: 1 } } }, "2026-11-17", "claude", CAPS)).toBeNull();   // under the $1 floor
    expect(jumpOf({ ...week("claude", 0.5), "2026-11-17": { claude: { usd: 1.4, runs: 1 } } }, "2026-11-17", "claude", CAPS)).toBeNull();
    // Nothing the week before: no week to compare with, so no 3x jump (second round), whatever the amount under a fifth of the cap.
    expect(jumpOf({ "2026-11-17": { gemini: { usd: 0.1, runs: 1 } } }, "2026-11-17", "gemini", CAPS)).toBeNull();
    expect(jumpOf({ "2026-11-17": { gemini: { usd: 1.5, runs: 1 } } }, "2026-11-17", "gemini", CAPS)).toBeNull();
    // Codex in runs: 7 days of 1 run, then 12.
    expect(jumpOf({ ...week("openai", 0), "2026-11-17": { openai: { usd: 0, runs: 12 } } }, "2026-11-17", "openai", CAPS)).toContain("over 3 times the 7-day average of 1 run");
    expect(jumpOf({ ...week("openai", 0), "2026-11-17": { openai: { usd: 0, runs: 4 } } }, "2026-11-17", "openai", CAPS)).toBeNull();   // under the 5-run floor
  });

  test("a day over a fifth of the month's cap is flagged whatever the week before", () => {
    const busy = week("perplexity", 0.7);                              // a steady $0.70 a day
    expect(jumpOf({ ...busy, "2026-11-17": { perplexity: { usd: 0.81, runs: 1 } } }, "2026-11-17", "perplexity", CAPS)).toBe("over a fifth of the month's cap ($4.00) in one day");
    const out = spendLines({ ledger: {}, days: { ...busy, "2026-11-17": { perplexity: { usd: 0.81, runs: 1 } } }, caps: CAPS, today: TODAY, morning: true });
    expect(out.filter((l) => l.startsWith("FLAGGED"))).toEqual([expect.stringContaining("FLAGGED: Perplexity spent $0.81 yesterday, over a fifth")]);
  });

  test("other check-ins: only today's flagged spend, nothing else", () => {
    const quiet = spendLines({ ledger: {}, days: week("claude", 0.5, "2026-11-11"), caps: CAPS, today: TODAY, morning: false });
    expect(quiet).toEqual([]);
    const loud = spendLines({ ledger: {}, days: { ...week("claude", 0.5, "2026-11-11"), [TODAY]: { claude: { usd: 7, runs: 30 } } }, caps: CAPS, today: TODAY, morning: false });
    expect(loud).toHaveLength(1);
    expect(loud[0]).toStartWith("FLAGGED: Claude has spent $7.00 so far today");
    expect(loud[0]).toContain("stolen key");
  });

  test("a cap reached is said in the morning, with the option that raises it", () => {
    const ledger = { "2026-11": { gemini: { usd: 8.02, runs: 40, findings: 0, searches: 0 } } };
    const out = spendLines({ ledger, days: {}, caps: CAPS, today: TODAY, morning: true });
    expect(out.some((l) => l.includes("Gemini has reached this month's cap of $8.00: reviews on it are refused") && l.includes("gemini_monthly_usd"))).toBe(true);
  });

  test("the runner keeps spend per day, and review.sh refuses a review whose seats are all at their cap", async () => {
    const dir = tmp();
    const cfg: any = { queueDir: join(dir, "q"), spendFile: join(dir, "spend.json"), healthFile: join(dir, "h.json"), termsFile: join(dir, "t.txt"),
      recordQueue: join(dir, "rq"), relayFile: join(dir, "relay"), caps: CAPS, reviewLimit: 1.5, timeoutS: {}, maxOut: {}, models: {}, hourlyS: 3600, tz: "America/New_York" };
    const r = new Runner(cfg, { seats: {}, now: () => new Date("2026-11-18T15:00:00Z"), log: () => {} });
    r.addSpend("gemini", 0.25, 1);
    r.addSpend("gemini", 0.5, 0);
    r.addSpend("openai", 0, 0);
    const days = JSON.parse(readFileSync(join(dir, "review-spend-days.json"), "utf8"));
    expect(days["2026-11-18"]).toEqual({ gemini: { usd: 0.75, runs: 2 }, openai: { usd: 0, runs: 1 } });
    expect(DAYS_KEPT).toBe(62);

    writeFileSync(cfg.termsFile, "# nothing private in this test\nzzzz-not-a-word\n");
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
    const full = { usd: 999, runs: 9999, findings: 0, searches: 0 };
    writeFileSync(cfg.spendFile, JSON.stringify({ [month]: { openai: full, gemini: full, perplexity: full, claude: full } }));
    const brief = join(dir, "brief.json");
    writeFileSync(brief, JSON.stringify({ id: "2026-11-18-test", topic: "a test", question: "is it fine?", body: "A plan for a stranger.", needs_facts: false, consequential: false }));
    const env = { ...process.env, REVIEW_QUEUE: cfg.queueDir, REVIEW_SPEND: cfg.spendFile, REVIEW_TERMS: cfg.termsFile, CAIN_STOP: join(dir, "stop.json") };
    const p = Bun.spawnSync(["bun", join(CAIN, "review", "cli.ts"), "submit", brief], { env, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(3);
    expect(p.stderr.toString()).toContain("blocked: the monthly cap is reached");
    expect(existsSync(join(cfg.queueDir))).toBe(false);
  });
});

// -- keys -----------------------------------------------------------------------------------------
describe("the key record", () => {
  test("first seen by hash: the same value keeps its day, a new value starts again and drops its expiry", () => {
    const h1 = sha("fixture-token-one"), h2 = sha("fixture-token-two");
    let f = observeKeys(emptyKeys(), { github_token: h1, gemini_api_key: null }, "2026-08-01").file;
    expect(f.keys.github_token).toEqual({ hash: h1, first_seen: "2026-08-01", present: true });
    expect(f.keys.gemini_api_key).toBeUndefined();
    f = setExpiry(f, "github_token", "2026-12-01").file!;
    f = observeKeys(f, { github_token: h1 }, "2026-09-01").file;
    expect(f.keys.github_token).toEqual({ hash: h1, first_seen: "2026-08-01", expires: "2026-12-01", present: true });
    const r = observeKeys(f, { github_token: h2 }, "2026-10-01");
    expect(r.file.keys.github_token).toEqual({ hash: h2, first_seen: "2026-10-01", present: true });
    expect(r.changed).toEqual([`github_token changed (${h2.slice(0, 8)})`]);
    expect(JSON.stringify(r.file)).not.toContain("fixture-token");
  });

  test("a line within 14 days of an expiry, and (Mondays) for a key over 90 days old with none set", () => {
    const MONDAY = "2026-11-16";
    let f = observeKeys(emptyKeys(), { github_token: sha("a"), pc_jobs_token: sha("b"), gemini_api_key: sha("c"), anthropic_api_key: sha("d") }, "2026-08-01").file;
    f = setExpiry(f, "github_token", "2026-12-02").file!;          // 14 days out: said
    f = setExpiry(f, "pc_jobs_token", "2026-12-03").file!;         // 15 days out: not yet
    f = setExpiry(f, "anthropic_api_key", "2026-11-10").file!;     // past
    const out = keyLines(f, TODAY);                                // a Wednesday: no age lines
    expect(out).toHaveLength(2);
    expect(out[0]).toStartWith("The record keeper's GitHub token expires on Dec 2, in 14 days.");
    expect(out[1]).toStartWith("The Anthropic API key expired on Nov 10");
    const mon = keyLines(f, MONDAY);
    expect(mon.find((l) => l.includes("Gemini"))).toStartWith("The Gemini API key has been the same for 107 days (first observed Aug 1)");
    // 90 days exactly isn't over 90.
    const g = observeKeys(emptyKeys(), { gemini_api_key: sha("c") }, "2026-08-18").file;
    expect(keyLines(g, MONDAY)).toEqual([]);
    expect(keyLines(g, "2026-11-23")).toHaveLength(1);
  });

  test("key-expiry refuses an unknown name or a bad date; keeper.sh runs it without the link", () => {
    const f = observeKeys(emptyKeys(), { github_token: sha("a") }, "2026-11-01").file;
    expect(setExpiry(f, "nope", "2026-12-01").file).toBeUndefined();
    expect(setExpiry(f, "github_token", "2026-02-30").file).toBeUndefined();
    expect(setExpiry(f, "gemini_api_key", "2026-12-01").said).toContain("hasn't been seen yet");
    expect(setExpiry(setExpiry(f, "github_token", "2026-12-01").file!, "github_token", "none").file!.keys.github_token.expires).toBeUndefined();
    const dir = tmp(), keys = join(dir, "keys.json");
    writeFileSync(keys, JSON.stringify(f));
    const env = { ...process.env, SECURITY_KEYS: keys, CAIN_SECURITY: join(CAIN, "security", "main.ts") };
    const ok = Bun.spawnSync(["bash", join(CAIN, "keeper.sh"), "key-expiry", "github_token", "2026-12-24"], { env, stdout: "pipe", stderr: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout.toString())).toEqual({ status: "ok", said: "Expiry for the record keeper's GitHub token set to Dec 24." });
    expect(JSON.parse(readFileSync(keys, "utf8")).keys.github_token.expires).toBe("2026-12-24");
    const bad = Bun.spawnSync(["bash", join(CAIN, "keeper.sh"), "key-expiry", "github_token", "soon"], { env, stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(2);
  });

  test("the watch reads the bot token and the link's keys from their files, hashes them, and keeps no key", () => {
    const dir = tmp();
    mkdirSync(join(dir, "link"));
    writeFileSync(join(dir, ".env"), "DISCORD_BOT_TOKEN=fixture-bot-token\n");
    writeFileSync(join(dir, "link", "deploy_key"), "-----BEGIN FIXTURE KEY-----\nabc\n");
    const p = { beat: join(dir, "b.json"), keys: join(dir, "keys.json"), discordEnv: join(dir, ".env"), deployKey: join(dir, "link", "deploy_key"), shipKey: join(dir, "link", "ship.key") };
    const logs: string[] = [];
    const f = keepKeys({ KEY_SHA_github_token: sha("fixture-gh"), KEY_SHA_pc_jobs_token: "" }, p, "2026-11-18", (m) => logs.push(m));
    expect(f.keys.discord_bot_token.hash).toBe(sha("fixture-bot-token"));
    expect(f.keys.deploy_key.present).toBe(true);
    expect(f.keys.ship_key).toBeUndefined();
    expect(f.keys.pc_jobs_token).toBeUndefined();
    const text = readFileSync(p.keys, "utf8") + logs.join("\n");
    for (const secret of ["fixture-bot-token", "FIXTURE KEY", "fixture-gh"]) expect(text).not.toContain(secret);
    for (const l of logs) expect(l).not.toMatch(/[0-9a-f]{20,}/);       // a hash prefix at most
  });
});

// -- the check-in -----------------------------------------------------------------------------------
describe("the check-in's Security watch line", () => {
  test("morning: heartbeat, spend and keys under one heading; other check-ins: only what's flagged", () => {
    const dir = tmp();
    const env = { REVIEW_SPEND: join(dir, "spend.json"), REVIEW_SPEND_DAYS: join(dir, "days.json"), SECURITY_KEYS: join(dir, "keys.json"),
      SECURITY_HEARTBEAT_STATE: join(dir, "beat.json"), CHECKIN_TZ: "America/New_York" };
    const monday = new Date("2026-11-16T12:10:00Z");
    writeFileSync(env.SECURITY_KEYS, JSON.stringify(observeKeys(emptyKeys(), { gemini_api_key: sha("x") }, "2026-07-01").file));
    const morning = lines("morning", env, monday);
    expect(morning).toStartWith("Security watch (nothing here acts; bring him at most one step, in plain words): No outside heartbeat yet");
    expect(morning).toContain("Review spend:");
    expect(morning).toContain("The Gemini API key has been the same for 138 days");
    const now = new Date("2026-11-18T12:10:00Z");
    expect(lines("morning", env, now)).not.toContain("Gemini API key");          // the age line only on Mondays
    expect(morning).not.toContain("\n");
    expect(lines("other", env, now)).toBe("");
    writeFileSync(env.SECURITY_HEARTBEAT_STATE, JSON.stringify({ state: "ok", fails: 3, last_ok: now.getTime() - 20 * MIN, last_error: "timed out" }));
    writeFileSync(env.REVIEW_SPEND_DAYS, JSON.stringify({ "2026-11-18": { claude: { usd: 9, runs: 4 } } }));
    const other = lines("other", env, now);
    expect(other).toContain("failed 3 times in a row");
    expect(other).toContain("FLAGGED: Claude has spent $9.00 so far today");
    expect(other).not.toContain("Review spend:");
    expect(section([])).toBe("");
  });

  // checkin.sh's own test of this line is in tests/test_addon.py (Cain 0.13.1): as his own user the
  // check-in types through marks it confirms (typing.sh), and that file's harness drives it.
});

// -- link previews off ------------------------------------------------------------------------------
describe("link previews off on everything the link posts", () => {
  test("quiet: first posts carry the flag; edits only OR it onto the flags the message has; reads and other calls don't change", () => {
    expect(quiet("POST", `/channels/${DM}/messages`, { content: "x" })).toEqual({ body: { content: "x", flags: 4 }, added: true });
    expect(quiet("POST", "/webhooks/1/tok", { content: "x", flags: 64 })).toEqual({ body: { content: "x", flags: 68 }, added: true });
    expect(quiet("POST", "/webhooks/1/tok", { content: "x", flags: 68 })).toEqual({ body: { content: "x", flags: 68 }, added: false });
    // An edit that sets words: only with the message's flags known, and only when they lack the bit.
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" })).toEqual({ body: { content: "x" }, added: false });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" }, 4)).toEqual({ body: { content: "x" }, added: false });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" }, 0)).toEqual({ body: { content: "x", flags: 4 }, added: true });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" }, 4096)).toEqual({ body: { content: "x", flags: 4100 }, added: true });
    // An edit that carries flags: ORed onto them and onto what the message has.
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { flags: 4 }, 32768)).toEqual({ body: { flags: 32772 }, added: true });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { components: [] }, 0)).toEqual({ body: { components: [] }, added: false });   // buttons alone
    // A tap's update never gets a flags field it didn't carry; a tap's new message does.
    expect(quiet("POST", "/interactions/1/tok/callback", { type: 7, data: { content: "x" } })).toEqual({ body: { type: 7, data: { content: "x" } }, added: false });
    expect(quiet("POST", "/interactions/1/tok/callback", { type: 7, data: { content: "x", flags: 64 } })).toEqual({ body: { type: 7, data: { content: "x", flags: 68 } }, added: true });
    expect(quiet("POST", "/interactions/1/tok/callback", { type: 4, data: { content: "x" } })).toEqual({ body: { type: 4, data: { content: "x", flags: 4 } }, added: true });
    expect(quiet("POST", "/interactions/1/tok/callback", { type: 6 }).body).toEqual({ type: 6 });
    expect(quiet("POST", "/users/@me/channels", { recipient_id: "1" }).body).toEqual({ recipient_id: "1" });
    expect(quiet("GET", `/channels/${DM}/messages/123`, undefined).body).toBeUndefined();
  });

  test("every posting path in a run of the link leaves the flag on: cards, asks, Ship cards, the morning message, answers, taps, edits", async () => {
    const r = rig();
    const card = await r.link.addCard({ text: "Added Swim to your calendar. https://example.com/x", rows: [{ type: 1, components: [{ type: 2, style: 2, label: "Undo", custom_id: "k:c:u1" }] }], kind: "card" });
    await r.link.show(card, { item: "none" });
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    await r.link.ship({ text: "Cain 0.13.0 ready.", item: "P41", pr: PR, head: SHA1 });
    const morning = await r.link.morning("## Wed Nov 18");
    await r.link.followup("999:tok", "Done.");
    await r.tap(structuredClone(r.msg(ask)), r.ids(ask)[0]);
    r.later(2 * DAY);
    await r.link.sweep();
    await r.tap(structuredClone(r.msg(morning)), STOP);
    await Bun.sleep(20);
    // Every message the bot has in his DM carries the flag, after every edit.
    expect(r.cards().length).toBeGreaterThan(3);
    for (const m of r.cards() as any[]) expect((Number(m.flags) & 4) === 4).toBe(true);
    for (const e of r.ephemerals()) expect((Number(e.flags) & 4) === 4).toBe(true);
    // A tap's update that sets words keeps the message's own flags with the bit.
    for (const u of r.updates()) if ("content" in u) expect(u.flags).toBe(4);
    // Edits of words never carried a flags field the message already had: no forced flags.
    const edits = r.calls.filter((c) => c.method === "PATCH" && c.path.startsWith(`/channels/${DM}/messages/`) && "content" in c.body);
    expect(edits.length).toBeGreaterThan(0);
    for (const c of edits) expect(c.body.flags).toBeUndefined();
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toEqual([]);
  });

  test("a reply of Cain's that slipped past the hook with a link gets its preview turned off after, keeping its flags", async () => {
    const r = rig();
    const reply = r.his("See https://www.example.com/x").id;     // stands in for a reply the plugin posted
    (r.posted[reply] as any).author = { id: "bot" };
    (r.posted[reply] as any).flags = 4096;           // an editable bit it has (third round: read-only ones never go back)
    const plain = r.his("Moved swim to 4:30.").id;
    await r.link.sent({ tool: "reply", ids: [plain], question: false });   // no link in it: nothing to turn off
    await r.link.sent({ tool: "reply", ids: [reply], question: false, links: true });
    await Bun.sleep(20);
    expect(r.calls.some((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${reply}` && c.body.flags === 4100)).toBe(true);
    expect(r.calls.some((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${plain}` && "flags" in c.body)).toBe(false);
    expect((r.posted[reply] as any).flags).toBe(4100);
  });

  test("the reply hook tells the link which replies carry a link", () => {
    const input = (text: string) => ({ tool_name: "mcp__plugin_discord_discord__reply", tool_input: { chat_id: DM, text },
      tool_response: [{ type: "text", text: "sent (id: 1300000000000000777)" }], tool_use_id: "call1" });
    expect(noteOf(input("See https://www.example.com/x"), 0, {})?.links).toBe(true);
    expect(noteOf(input("[the page](https://www.example.com/x)"), 0, {})?.links).toBe(true);
    expect(noteOf(input("Moved swim to 4:30."), 0, {})?.links).toBeUndefined();
  });

  test("the App's own alert (when Claude can't run) posts with the flag too", () => {
    expect(readFileSync(join(CAIN, "alert.sh"), "utf8")).toContain("{content: $c, flags: 4}");
  });
});

// -- the gate's rule on links in Cain's replies -------------------------------------------------------
describe("links he can't judge by their look", () => {
  const cards = { written_at: Date.now(), owner: "1", dm: DM, cards: [], sent: [] };
  const held = [
    ["Here: http://192.168.1.20/admin", "ip"], ["Open https://203.0.113.9:8443/x", "ip"], ["See http://[2001:db8::1]/", "ip"],
    ["Odd one: http://3232235777/", "ip"], ["Login: https://xn--pple-43d.com/", "punycode"], ["See https://аpple.com/x", "punycode"],
    ["Short: https://bit.ly/3abc", "shortener"], ["Or tinyurl.com/y2k9", "shortener"], ["Via https://t.co/AbC", "shortener"],
    ["[Your bill](https://bit.ly/bill)", "shortener"], ["[the page](https://10.0.0.1/x)", "ip"],
    ["Use https://user:pass@example.com/", "userinfo"], ["Try https://example.com@evil.example/", "userinfo"],
  ] as const;
  const passes = ["The page is https://www.example.com/account/settings", "[Watch it](https://claude.ai/code/session_X)",
    "Read https://docs.github.com/en/code-security", "It's at example.org/path", "Mail me at someone@example.com", "Version 1.2.3.4 shipped", "No link here."];

  test("held: a bare IP, punycode, a shortener, user:pass@; each named in its excerpt", () => {
    for (const [text, why] of held) {
      const h = linksHits(text);
      expect(h.length).toBe(1);
      expect(h[0].rule).toBe("links");
      expect(h[0].result).toBe("refuse");
      expect(linkProblem(text.match(/\]\(([^)]+)\)/)?.[1] ?? text.split(" ").at(-1)!)).toBe(why);
    }
  });

  test("passes: a plain https link to a named host, a masked one, a bare host, an email, a version", () => {
    for (const text of passes) expect(linksHits(text)).toEqual([]);
  });

  test("the reply hook holds it for good, says why, and logs every hit to the gate report", () => {
    const d = decideSend({ tool: "reply", text: "Your bill is at https://bit.ly/3abc and http://10.0.0.1/x", chat: DM }, cards as any);
    expect(d.would).toBe("refuse");
    expect(d.hard).toBe(true);
    expect(d.hits.filter((h) => h.rule === "links")).toHaveLength(2);
    expect(d.said).toContain(LINKS_WHY);
    const line = entry({ tool: "reply", text: "x", chat: DM, input: {}, session: "s" } as any, d, { output: {}, did: "refused" }, "link", 1);
    expect((line!.hits as any[]).filter((h) => h.rule === "links")).toHaveLength(2);
    const ok = decideSend({ tool: "reply", text: "Your bill is at https://www.example.com/billing", chat: DM }, cards as any);
    expect(ok.would).toBe("pass");
  });
});
