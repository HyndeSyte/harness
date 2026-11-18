// The security watch's second round (Cain 0.13.0): card edits that survive a refused preview
// flag, Cain's replies with links through keeper.sh reply, the heartbeat URL kept to its one
// process, the link rule by the URL parser with its list of cited hosts, the spend and key rules.
// Fixtures only: nothing here is anyone's real key, URL, mail or calendar.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_HOSTS, linkProblem, linksHits, linksIn, readHostList } from "../rootfs/opt/cain/gate/cain";
import { addHost, readHosts } from "../rootfs/opt/cain/gate/hosts";
import { decideSend } from "../rootfs/opt/cain/gate/send";
import { emptyKeys, keyLines, observeKeys, paceOf, jumpOf, setAck, spendLines } from "../rootfs/opt/cain/security/core";
import { sha } from "../rootfs/opt/cain/security/main";
import { DAY, DM, rig } from "./link-rig";

const ROOT = join(import.meta.dir, "..", "..");
const CAIN = join(ROOT, "cain", "rootfs", "opt", "cain");
const RUN = join(ROOT, "cain", "rootfs", "etc", "services.d", "cain", "run");
const FINISH = join(ROOT, "cain", "rootfs", "etc", "services.d", "cain", "finish");
const tmp = () => mkdtempSync(join(tmpdir(), "security2-"));
const ready = !!Bun.which("bash") && !!Bun.which("jq") && !!Bun.which("curl");
const CAPS = { gemini: 8, perplexity: 4, claude: 30, openaiRuns: 200 };
const CARDS = { written_at: Date.now(), owner: "4242", dm: DM, cards: [], sent: [] } as any;

// -- 1. card updates never break on the flag --------------------------------------------------------
describe("the preview flag never kills a card update", () => {
  test("a 400 to an edit that carried the added flag is sent again without it, and the gate report says so", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    (r.posted[ask] as any).flags = 0;            // a card from before the flag
    r.restart();                                  // the link hasn't seen its flags in this run
    r.refuseFlag.on = true;                       // Discord refuses any flags field on an edit
    await r.link.answered({ item: "P08", question: "Q2" });
    const edits = r.calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${ask}`);
    expect(edits).toHaveLength(2);
    expect(edits[0].body.flags).toBe(4);
    expect(edits[1].body.flags).toBeUndefined();
    expect(edits[1].body.content).toBe(edits[0].body.content);
    expect(r.msg(ask).components).toEqual([]);                          // the buttons came off all the same
    expect(r.msg(ask).content).toContain("You answered in a message");
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toEqual([
      { point: "preview flag", writer: "link", hits: [], did: "preview flag refused", message: ask }]);
    expect(r.logs.some((l) => l.includes("refused the preview flag"))).toBe(true);
  });

  test("an edit of a message that carries other flags keeps them: the flag is ORed on, never put in their place", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    // An editable bit the link never wrote, and one Discord sets itself (HAS_THREAD): the third round
    // keeps the editable one and never sends the read-only one back.
    (r.posted[ask] as any).flags = 4096 | 32;
    r.restart();
    await r.link.answered({ item: "P08", question: "Q2" });
    const edit = r.calls.find((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${ask}`)!;
    expect(edit.body.flags).toBe(4096 | 4);
    expect((r.posted[ask] as any).flags).toBe(4100);
    // Once it has the bit, an edit of its words sends no flags field at all.
    const again = (await r.link.ask({ text: "Filed now?", options: ["Filed", "Not filed"], item: "P08", question: "Q3" }) as any).message;
    await r.link.answered({ item: "P08", question: "Q3" });
    const e2 = r.calls.find((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${again}`)!;
    expect("flags" in e2.body).toBe(false);
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toEqual([]);
  });

  test("an edit whose message's flags can't be read goes without the flag rather than not at all", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    delete (r.posted[ask] as any).flags;
    r.restart();
    await r.link.answered({ item: "P08", question: "Q2" });
    const edit = r.calls.find((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${ask}`)!;
    expect("flags" in edit.body).toBe(false);
    expect(r.msg(ask).components).toEqual([]);
  });
});

// -- 2. Cain's replies with a link go through the keeper ----------------------------------------------
describe("a reply with a link goes through keeper.sh reply", () => {
  test("the reply hook holds a plugin reply that carries any link, for good, with that reason; one without passes as before", () => {
    for (const text of ["Here it is: https://github.com/HyndeSyte/harness/pull/29", "[Watch it](https://claude.ai/code/session_X)"]) {
      const d = decideSend({ tool: "reply", text, chat: DM }, CARDS, { plugin: true });
      expect(d.would).toBe("refuse");
      expect(d.hard).toBe(true);
      expect(d.said).toContain("Send links through the keeper");
      expect(d.said).toContain("keeper.sh reply");
    }
    expect(decideSend({ tool: "reply", text: "Moved swim to 4:30.", chat: DM }, CARDS, { plugin: true }).would).toBe("pass");
    // The hook asks for it; keeper.sh check (the link's dry run of a plugin reply) says the same.
    expect(readFileSync(join(CAIN, "hooks", "discord-send.ts"), "utf8")).toContain("plugin: true");
    const r = rig();
    expect(r.link.checkSend({ text: "See https://github.com/x/y" }).said).toContain("Send links through the keeper");
  });

  test("the link posts it with the flag on the post itself, under the same rules, and keeps it as Cain's own reply", async () => {
    const r = rig();
    const his = r.his("Where's the pull request?").id;
    const out = await r.link.reply({ text: "Here: [the pull request](https://github.com/HyndeSyte/harness/pull/29). Restarted the add-on.", replyTo: his });
    expect(out.status).toBe("posted");
    const post = r.calls.find((c) => c.method === "POST" && c.path === `/channels/${DM}/messages`)!;
    expect(post.body.flags).toBe(4);
    expect(post.body.message_reference.message_id).toBe(his);
    expect(post.body.content).toContain("Restarted the App.");            // "add-on" fixed as it goes
    expect(r.link.cardsNow().sent).toContain(out.message);                // his own reply: he may edit it
    expect(r.state().messages[out.message]?.kind ?? "plain").toBe("plain");
    // A held link is refused there too, and nothing is posted.
    const before = r.posts();
    await expect(r.link.reply({ text: "Pay at https://bit.ly/x" })).rejects.toThrow("link shortener");
    await expect(r.link.reply({ text: "Moved swim — at 4:30." })).rejects.toThrow("The message gate held this:");
    expect(r.posts()).toBe(before);
    expect(r.reports.some((x) => x.point === "keeper reply" && x.did === "refused")).toBe(true);
  });

  test.skipIf(!ready)("keeper.sh reply reaches the link's /reply, keyed, with its text and --reply-to", async () => {
    const dir = tmp();
    const TOKEN = "not-a-real-token.for-the-reply-test";
    writeFileSync(join(dir, ".env"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["4242"], groups: {} }));
    const key = createHmac("sha256", TOKEN).update("harness-relay-v1").digest("hex");
    const seen: any[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, keyed: req.headers.get("x-harness-key") === key, body: JSON.parse(await req.text()) });
      return Response.json({ status: "posted" });
    } });
    const env = { ...process.env, CAIN_LINK: `http://127.0.0.1:${server.port}`, CAIN_DISCORD_DIR: dir };
    const keeper = async (...args: string[]) => {
      const p = Bun.spawn(["bash", join(CAIN, "keeper.sh"), ...args], { env, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      return { code: await p.exited, out };
    };
    try {
      expect(await keeper("reply", "--reply-to", "1234567890123456789", "See https://github.com/x/y")).toEqual({ code: 0, out: '{"status":"posted"}' });
      await keeper("reply", "Plain words.");
      expect(seen).toEqual([
        { path: "/reply", keyed: true, body: { text: "See https://github.com/x/y", reply_to: "1234567890123456789" } },
        { path: "/reply", keyed: true, body: { text: "Plain words." } },
      ]);
      expect(await keeper("reply", "--reply-to")).toMatchObject({ code: 2 });
    } finally { server.stop(true); }
  }, 30_000);
});

// -- 3. the heartbeat URL stays with its one process ---------------------------------------------------
describe("the heartbeat URL", () => {
  test("the run script unsets it before any child starts, and only the watch's subshell reads it", () => {
    const run = readFileSync(RUN, "utf8");
    const unset = run.indexOf("unset HEARTBEAT_URL");
    expect(unset).toBeGreaterThan(0);
    for (const child of ["tmux -u new-session", "link/main.ts", "record/main.ts", "pcjobs/main.ts", "review/main.ts", "checkin.sh", "discord/upkeep.ts"])
      expect(unset).toBeLessThan(run.indexOf(child));
    const block = run.slice(run.lastIndexOf("\n(\n", run.indexOf("security/main.ts run")), run.indexOf(") &", run.indexOf("security/main.ts run")));
    expect(block).toContain('HEARTBEAT_URL="$(opt heartbeat_url)"');
    expect(run.split("HEARTBEAT_URL=").length).toBe(2);                    // read in that one place only
    expect(run).not.toMatch(/echo[^\n]*HEARTBEAT_URL|log[^\n]*HEARTBEAT_URL/);
  });

  test("Claude Code's session (session.sh) starts without it, even if it reached the environment", () => {
    const dir = tmp(), bin = join(dir, "bin"), data = join(dir, "data");
    mkdirSync(bin); mkdirSync(join(data, "work"), { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/bash\nenv > "${join(dir, "env.txt")}"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const script = readFileSync(join(CAIN, "session.sh"), "utf8").replaceAll("/data", data).replace("sleep 5", "exit 0");
    writeFileSync(join(dir, "session.sh"), script);
    const p = Bun.spawnSync(["bash", join(dir, "session.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEARTBEAT_URL: "https://hc-ping.example.net/fixture-ping" }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const env = readFileSync(join(dir, "env.txt"), "utf8");
    expect(env).toContain("HOME=");
    expect(env).not.toContain("HEARTBEAT_URL");
    expect(env).not.toContain("fixture-ping");
  });

  test.skipIf(!Bun.which("bash"))("the finish script hands curl the URL on stdin (-K -), never on its command line, with no redirects", () => {
    const finish = readFileSync(FINISH, "utf8");
    const part = finish.slice(finish.indexOf('  hb="$(bashio::config'), finish.indexOf("unset hb hb_base hb_query"));
    const one = (url: string) => {
      const dir = tmp(), bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\ncat > "${join(dir, "config")}"\nexit 0\n`);
      chmodSync(join(bin, "curl"), 0o755);
      const sh = `bashio::config() { printf '%s' "$HB"; }\nbashio::log.info() { echo "info: $*"; }\nbashio::log.warning() { echo "warn: $*"; }\n${part}`;
      const p = Bun.spawnSync(["bash", "-c", sh], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HB: url }, stdout: "pipe", stderr: "pipe" });
      const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
      return { out: p.stdout.toString(), args: read("args"), config: read("config") };
    };
    const a = one("https://hc-ping.example.net/fixture-ping-0001");
    expect(a.config).toBe('url = "https://hc-ping.example.net/fixture-ping-0001/fail"\n');
    expect(a.args).not.toContain("fixture-ping");
    for (const flag of ["-K", "-m", "10", "--max-redirs", "0", "--proto", "=https"]) expect(a.args!.split("\n")).toContain(flag);
    expect(a.args).not.toMatch(/(^|\n)-L(\n|$)|--location/);
    expect(a.out).not.toContain("fixture-ping");
    expect(one("https://hc-ping.example.net/fixture/slug?rid=7").config).toBe('url = "https://hc-ping.example.net/fixture/slug/fail?rid=7"\n');
    // Not https, or a character that could break out of the config's quotes: nothing is sent.
    for (const bad of ["http://hc-ping.example.net/x", 'https://hc-ping.example.net/x"\nurl = "https://elsewhere.example/', ""]) expect(one(bad).config).toBeNull();
  });

  test("the watch's own fetch refuses redirects too", () => {
    expect(readFileSync(join(CAIN, "security", "main.ts"), "utf8")).toContain('redirect: "error"');
  });
});

// -- 5. the link rule by the URL parser ------------------------------------------------------------------
describe("links parsed as a browser would", () => {
  const held: [string, string][] = [
    ["http://example.com/x", "not an https link"],
    ["Plain http: http://github.com/x", "not an https link"],
    ["https://example.com:8443/x", "a port other than 443"],
    ["data:text/html,hello", "not an https link"],
    ["file:///etc/passwd", "not an https link"],
    ["Tap javascript:alert(1)", "not an https link"],
    ["[click](javascript:alert(1))", "not an https link"],
    ["ftp://files.example.com/x", "not an https link"],
    ["See //evil.example/x", "a link with no scheme"],
    ["[x](//evil.example/x)", "a link with no scheme"],
    ["[https://github.com/x](https://evil.example/y)", "link text naming another site"],
    ["[github.com](https://evil.example)", "link text naming another site"],
    ["https://%31%30.0.0.1/x", "a bare IP address"],
    ["https://b%69t.ly/x", "a link shortener"],
    ["https:\\\\bit.ly\\x", "a link shortener"],
    ["<https://bit.ly/x>", "a link shortener"],
    ["https://bit.ly./x", "a link shortener"],
    ["https://user%40evil.example@github.com/", "a user name or password in it"],
  ];
  test("held, each class named", () => {
    for (const [text, why] of held) {
      const h = linksHits(text).filter((x) => x.result === "refuse");
      expect({ text, n: h.length }).toEqual({ text, n: 1 });
      expect(h[0].around).toStartWith(why);
    }
  });
  test("the first round's holds stand", () => {
    for (const [link, why] of [["http://192.168.1.20/admin", "ip"], ["https://xn--pple-43d.com/", "punycode"], ["https://t.co/AbC", "shortener"], ["https://user:pass@example.com/", "userinfo"]])
      expect(linkProblem(link)).toBe(why);
  });
  test("passes: https on its own port, masked links whose text is words or the same site", () => {
    for (const text of ["https://github.com/x", "https://github.com:443/x", "[Watch it](https://claude.ai/code/session_X)", "[github.com/x](https://github.com/y)",
      "[www.github.com](https://github.com)", "Note: the plan stands.", "It's 4:30 now.", "example.org/path"])
      expect({ text, hits: linksHits(text).filter((x) => x.result === "refuse") }).toEqual({ text, hits: [] });
  });
  test("a host off the cited list is never held, only noted for the gate report; the list grows by keeper.sh link-host", () => {
    const hosts = readHostList(null);
    expect([...LINK_HOSTS].every((h) => hosts.has(h))).toBe(true);
    for (const h of ["claude.ai", "github.com", "home-assistant.io", "intel.com"]) expect(hosts.has(h)).toBe(true);
    expect(linksHits("https://docs.github.com/en", hosts)).toEqual([]);
    const off = linksHits("https://www.example.com/x", hosts);
    expect(off).toHaveLength(1);
    expect(off[0].result).toBe("note");
    const d = decideSend({ tool: "reply", text: "https://www.example.com/x", chat: DM }, CARDS, { hosts });
    expect(d.would).toBe("pass");
    expect(d.hits).toEqual([{ rule: "links", result: "note", around: "unknown host (known hosts, noted not blocked): www.example.com" }]);
    const dir = tmp(), file = join(dir, "hosts.txt");
    expect(addHost("https://x.example/", file).ok).toBe(false);
    expect(addHost("Example.com", file)).toEqual({ ok: true, said: "Added example.com: links to it (and under it) no longer note the gate report." });
    expect(linksHits("https://www.example.com/x", readHosts(file))).toEqual([]);
    expect(addHost("example.com", file).said).toContain("already");
    const p = Bun.spawnSync(["bash", join(CAIN, "keeper.sh"), "link-host", "docs.example.org"], { env: { ...process.env, CAIN_LINK_HOSTS: file, CAIN_GATE_DIR: join(CAIN, "gate") }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("example.com\ndocs.example.org\n");
  });
  test("every link found once: masked, bare, schemed, odd schemes and scheme-relative", () => {
    expect(linksIn("a [b](https://github.com/x) c https://claude.ai/y d mailto:x@example.com e //h.example/z").map((f) => f.link))
      .toEqual(["https://github.com/x", "https://claude.ai/y", "mailto:x@example.com", "//h.example/z"]);
  });
});

// -- 6. spending ---------------------------------------------------------------------------------------
describe("spend: the floor, the active days and the pace", () => {
  const day = (usd: number) => ({ claude: { usd, runs: 1 } });
  test("the 3x rule needs at least $1 and spend on 3 of the 7 days before", () => {
    const two = { "2026-11-12": day(0.2), "2026-11-14": day(0.2) };
    expect(jumpOf({ ...two, "2026-11-17": day(2) }, "2026-11-17", "claude", CAPS)).toBeNull();
    const three = { ...two, "2026-11-15": day(0.2) };
    expect(jumpOf({ ...three, "2026-11-17": day(2) }, "2026-11-17", "claude", CAPS)).toContain("over 3 times");
    expect(jumpOf({ ...three, "2026-11-17": day(0.95) }, "2026-11-17", "claude", CAPS)).toBeNull();
    expect(jumpOf({ "2026-11-17": day(6.5) }, "2026-11-17", "claude", CAPS)).toContain("a fifth of the month's cap");   // the cap rule stands alone
  });
  test("the pace line: the month so far carried to its end above a seat's cap; the cap line stays", () => {
    expect(paceOf(20, "2026-11-18", 30)).toBeCloseTo(35.29, 1);
    expect(paceOf(10, "2026-11-18", 30)).toBeNull();
    expect(paceOf(5, "2026-11-03", 30)).toBeNull();                      // too few days in
    expect(paceOf(31, "2026-11-18", 30)).toBeNull();                     // at the cap: the cap line says it
    const out = spendLines({ ledger: { "2026-11": { claude: { usd: 20, runs: 9, findings: 0, searches: 0 }, gemini: { usd: 8.5, runs: 9, findings: 0, searches: 0 } } },
      days: {}, caps: CAPS, today: "2026-11-18", morning: true });
    expect(out.find((l) => l.startsWith("Claude is on pace"))).toStartWith("Claude is on pace for about $35.29 this month, over its cap of $30.00");
    expect(out.some((l) => l.startsWith("Gemini has reached this month's cap"))).toBe(true);
    expect(out.some((l) => l.startsWith("Gemini is on pace"))).toBe(false);
    expect(spendLines({ ledger: { "2026-11": { claude: { usd: 20, runs: 9, findings: 0, searches: 0 } } }, days: {}, caps: CAPS, today: "2026-11-18", morning: false })).toEqual([]);
  });
});

// -- 7. keys -------------------------------------------------------------------------------------------
describe("keys: weekly, acknowledged, first observed, one hash", () => {
  const MONDAY = "2026-11-16";
  test("the 90-day line comes on Mondays only, says first observed, and key-ack quiets it until its date", () => {
    let f = observeKeys(emptyKeys(), { deploy_key: sha("d"), gemini_api_key: sha("g") }, "2026-07-01").file;
    expect(keyLines(f, "2026-11-17")).toEqual([]);
    expect(keyLines(f, MONDAY)).toHaveLength(2);
    expect(keyLines(f, MONDAY)[0]).toContain("(first observed Jul 1)");
    expect(keyLines(f, MONDAY)[0]).toContain("keeper.sh key-ack");
    expect(setAck(f, "deploy_key", "2026-11-16", MONDAY).file).toBeUndefined();     // a day to come only
    expect(setAck(f, "nope", "2027-06-01", MONDAY).file).toBeUndefined();
    expect(setAck(f, "ship_key", "2027-06-01", MONDAY).said).toContain("hasn't been observed yet");
    f = setAck(f, "deploy_key", "2027-06-01", MONDAY).file!;
    expect(keyLines(f, MONDAY).map((l) => l.slice(0, 20))).toEqual(["The Gemini API key h"]);
    expect(keyLines(f, "2027-06-07")).toHaveLength(2);                              // past the date: said again
    // A new value drops the acknowledgement with the rest.
    expect(observeKeys(f, { deploy_key: sha("d2") }, MONDAY).file.keys.deploy_key.ack).toBeUndefined();
  });

  test("keeper.sh key-ack writes it without the link", () => {
    const dir = tmp(), keys = join(dir, "keys.json");
    writeFileSync(keys, JSON.stringify(observeKeys(emptyKeys(), { ship_key: sha("s") }, "2026-07-01").file));
    const env = { ...process.env, SECURITY_KEYS: keys, CAIN_SECURITY: join(CAIN, "security", "main.ts") };
    const p = Bun.spawnSync(["bash", join(CAIN, "keeper.sh"), "key-ack", "ship_key", "2030-01-01"], { env, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString()).status).toBe("ok");
    expect(JSON.parse(readFileSync(keys, "utf8")).keys.ship_key.ack).toBe("2030-01-01");
    const ls = Bun.spawnSync(["bun", join(CAIN, "security", "main.ts"), "keys"], { env, stdout: "pipe" }).stdout.toString();
    expect(ls).toContain("ship_key: first observed 2026-07-01, no expiry set, acknowledged until 2030-01-01");
  });

  test.skipIf(!Bun.which("sha256sum"))("the run script's hash (printf '%s', no new line) and the watch's agree", () => {
    const run = readFileSync(RUN, "utf8");
    const pipe = /\$\((printf '%s' "\$v" \| sha256sum \| cut -d' ' -f1)\)/.exec(run)?.[1];
    expect(pipe).toBeDefined();
    for (const v of ["github_pat_fixture_0001", "with space and ü", "trailing\\n-looking", "x"]) {
      const p = Bun.spawnSync(["bash", "-c", `v="$V"; ${pipe}`], { env: { ...process.env, V: v }, stdout: "pipe" });
      expect(p.stdout.toString().trim()).toBe(sha(v));
    }
  });
});

void DAY;
