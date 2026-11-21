// The security watch's third round (Cain 0.13.0): replies with links never stall while the link
// is down, taps and edits never fail on a message's own flags, the fail ping's curl options and
// no xtrace around the heartbeat lines, the gate report's words for unknown hosts, and the secret
// scan's baseline. Fixtures only: nothing here is anyone's real key, URL, mail or calendar.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLink, linksHits, readHostList, UNKNOWN_HOST } from "../rootfs/opt/cain/gate/cain";
import { HELD_LINE, heldLine, noteAt, readAt } from "../rootfs/opt/cain/gate/held";
import { decideSend, LINK_DOWN } from "../rootfs/opt/cain/gate/send";
import { run } from "../rootfs/opt/cain/hooks/discord-send";
import { noteOf } from "../rootfs/opt/cain/hooks/discord-sent";
import { discordError, EDITABLE_FLAGS, maskFlags, namesFlags, quiet } from "../rootfs/opt/cain/link/core";
import { lines, ping } from "../rootfs/opt/cain/security/main";
import { DM, MIN, rig } from "./link-rig";

const ROOT = join(import.meta.dir, "..", "..");
const CAIN = join(ROOT, "cain", "rootfs", "opt", "cain");
const RUN = join(ROOT, "cain", "rootfs", "etc", "services.d", "cain", "run");
const FINISH = join(ROOT, "cain", "rootfs", "etc", "services.d", "cain", "finish");
const tmp = () => mkdtempSync(join(tmpdir(), "security3-"));
const CARDS = { written_at: Date.now(), owner: "4242", dm: DM, cards: [], sent: [] } as any;
const BIG_DM = "1300000000000000500";

// -- 1. replies with links never stall ----------------------------------------------------------------
describe("a reply with a link never stalls", () => {
  // The hook as Claude Code runs it, with its files in a temp folder and the link answering or not.
  const hook = async (text: string, linkUp: boolean) => {
    const dir = tmp();
    process.env.CAIN_GATE_TRIES = join(dir, "tries.json");
    process.env.CAIN_GATE_DM = join(dir, "dm.json");
    const held = join(dir, "held.json");
    const cards = { ...CARDS, dm: BIG_DM, written_at: Date.now() };
    const input = { session_id: `s-${Math.random()}`, hook_event_name: "PreToolUse", tool_name: "mcp__plugin_discord_discord__reply",
      tool_input: { chat_id: BIG_DM, text } };
    const out = await run(JSON.stringify(input), { ask: async () => { if (!linkUp) throw new Error("connection refused"); return cards; },
      file: () => (linkUp ? null : JSON.stringify(cards)), held });
    return { out, held: readAt(held) };
  };

  test("held for keeper.sh reply while the link answers, and the hold's time is noted", async () => {
    const r = await hook("Here it is: https://github.com/HyndeSyte/harness/pull/29", true);
    expect(r.out).toContain('"permissionDecision":"deny"');
    expect(r.out).toContain("keeper.sh reply");
    expect(r.held).toBeNumber();
  });

  test("passed through as it is when the link doesn't answer, with the report's link-down entry and no hold reason", async () => {
    const r = await hook("Here it is: https://github.com/HyndeSyte/harness/pull/29", false);
    expect(r.out).toBe("");
    expect(r.held).toBeNull();
    const d = decideSend({ tool: "reply", text: "See https://github.com/x/y", chat: DM }, CARDS, { plugin: true, linkDown: true });
    expect(d.would).toBe("pass");
    expect(d.said).not.toContain("keeper");
    expect(d.hits).toEqual([{ rule: "keeper", result: "note", around: LINK_DOWN }]);
    expect(LINK_DOWN).toBe("link down: preview not suppressed at post");
    // A link the gate holds for its look is still held with the link down: only the keeper hold lifts.
    expect(decideSend({ tool: "reply", text: "Pay at https://bit.ly/x", chat: DM }, CARDS, { plugin: true, linkDown: true }).would).toBe("refuse");
    // And a reply that went through gets its preview turned off after the fact: the after-post note says it has a link.
    expect(noteOf({ tool_name: "mcp__plugin_discord_discord__reply", tool_input: { chat_id: DM, text: "See https://github.com/x/y" },
      tool_response: [{ type: "text", text: "sent (id: 1300000000000000777)" }], tool_use_id: "toolu_1" }, Date.now(), {})?.links).toBe(true);
  });

  test("the hook, the gate and the after-post note share one detector: whatever the gate sees as a link, the hook holds", () => {
    const texts = ["https://github.com/x", "[Watch it](https://claude.ai/code/session_X)", "See //evil.example/x", "Tap javascript:alert(1)",
      "mailto:x@example.com", "example.org/path", "<https://bit.ly/x>", "https:\\\\bit.ly\\x"];
    for (const text of texts) {
      const seen = linksHits(text, readHostList(null)).length > 0 || hasLink(text);
      expect({ text, seen, has: hasLink(text) }).toEqual({ text, seen: true, has: true });
      expect({ text, would: decideSend({ tool: "reply", text, chat: DM }, CARDS, { plugin: true }).would }).toEqual({ text, would: "refuse" });
      expect({ text, links: noteOf({ tool_name: "mcp__plugin_discord_discord__reply", tool_input: { chat_id: DM, text },
        tool_response: [{ type: "text", text: "sent (id: 1300000000000000777)" }], tool_use_id: "toolu_2" }, Date.now(), {})?.links }).toEqual({ text, links: true });
    }
    for (const text of ["Moved swim to 4:30.", "It's 4:30 now.", "Note: the plan stands."]) expect(hasLink(text)).toBe(false);
    for (const f of ["hooks/discord-send.ts", "hooks/discord-sent.ts", "gate/send.ts"])
      expect({ f, shared: readFileSync(join(CAIN, f), "utf8").includes("hasLink(") }).toEqual({ f, shared: true });
  });

  test("the check-in says when a held reply waited over 10 minutes with no keeper reply since", async () => {
    const t0 = Date.UTC(2026, 10, 18, 15, 0);
    expect(heldLine(null, null, t0)).toBeNull();
    expect(heldLine(t0, null, t0 + 9 * MIN)).toBeNull();
    expect(heldLine(t0, null, t0 + 11 * MIN)).toBe(HELD_LINE);
    expect(heldLine(t0, t0 - MIN, t0 + 11 * MIN)).toBe(HELD_LINE);          // a keeper reply before the hold doesn't count
    expect(heldLine(t0, t0 + 2 * MIN, t0 + 11 * MIN)).toBeNull();           // one sent since: nothing to say
    expect(heldLine(t0, null, t0 + 25 * 60 * MIN)).toBeNull();              // a day on, it's dropped
    expect(HELD_LINE).toBe("a reply with a link is waiting: send it with keeper.sh reply");
    // In the check-in's own line, from the two files.
    const dir = tmp(), held = join(dir, "held.json"), sent = join(dir, "sent.json");
    noteAt(held, t0);
    const env = { CAIN_LINK_HELD: held, CAIN_KEEPER_SENT: sent, SECURITY_HEARTBEAT_STATE: join(dir, "beat.json"), SECURITY_KEYS: join(dir, "keys.json"),
      REVIEW_SPEND: join(dir, "spend.json"), REVIEW_DIR: dir, HEARTBEAT_URL: "" } as Record<string, string>;
    expect(lines("other", env, new Date(t0 + 11 * MIN))).toContain(HELD_LINE);
    // keeper.sh reply through the link notes its time, and the line goes.
    const r = rig();
    const noted: number[] = [];
    (r.link as any).d.keeperSent = (at: number) => { noted.push(at); noteAt(sent, t0 + 12 * MIN); };
    await r.link.reply({ text: "Here: https://github.com/HyndeSyte/harness/pull/29" });
    expect(noted).toHaveLength(1);
    expect(lines("other", env, new Date(t0 + 13 * MIN))).not.toContain(HELD_LINE);
  });
});

// -- 2. taps and edits never fail on flags ---------------------------------------------------------------
describe("flags: only the editable bits ever go out", () => {
  test("the mask: editable bits kept, read-only ones dropped, EPHEMERAL only on an interaction's answer", () => {
    expect(EDITABLE_FLAGS).toBe(4 | 4096 | 32768);
    expect(maskFlags(4 | 32 | 2 | 128 | 8192 | 4096)).toBe(4 | 4096);        // HAS_THREAD, IS_CROSSPOST, LOADING, HAS_SNAPSHOT off
    expect(maskFlags(64 | 4)).toBe(4);
    expect(maskFlags(64 | 4, true)).toBe(68);
    expect(quiet("POST", `/channels/${DM}/messages`, { content: "x", flags: 4 | 32 }).body).toEqual({ content: "x", flags: 4 });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" }, 32 | 1)).toEqual({ body: { content: "x", flags: 4 }, added: true });
    expect(quiet("POST", "/interactions/1/tok/callback", { type: 7, data: { content: "x", flags: 32 | 8192 } }).body).toEqual({ type: 7, data: { content: "x", flags: 4 } });
    // The read before an edit failed: the edit goes as the caller wrote it (masked), with nothing added.
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { content: "x" }, null)).toEqual({ body: { content: "x" }, added: false });
    expect(quiet("PATCH", `/channels/${DM}/messages/123`, { flags: 4 | 32 }, null)).toEqual({ body: { flags: 4 }, added: false });
  });

  test("a tapped message carrying a read-only flag: the tap's update goes with only the editable bits, and lands", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const msg = structuredClone(r.msg(ask));
    msg.flags = 4 | 32 | 16384;                     // HAS_THREAD and HAS_SNAPSHOT, which Discord only reports
    r.refuseFlag.readOnly = true;                   // Discord refuses a read-only bit sent back
    await r.tap(msg, r.ids(ask)[0]);
    const answers = r.calls.filter((c) => c.method === "POST" && c.path.startsWith("/interactions/") && c.body?.type === 7);
    expect(answers).toHaveLength(1);
    expect(answers[0].body.data.flags).toBe(4);
    expect(r.msg(ask).components).toEqual([]);
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toEqual([]);
  });

  test("a tap's answer refused for its added preview flag (a 400 naming flags) is sent once more without it", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    const msg = structuredClone(r.msg(ask));
    msg.flags = 4096;
    r.refuseFlag.interactions = true;
    await r.tap(msg, r.ids(ask)[0]);
    const answers = r.calls.filter((c) => c.method === "POST" && c.path.startsWith("/interactions/") && c.body?.type === 7);
    expect(answers.map((c) => c.body.data.flags)).toEqual([4096 | 4, 4096]);
    expect(r.msg(ask).components).toEqual([]);
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toHaveLength(1);
  });

  test("a 400 that doesn't name flags is logged with its body and never sent twice, nor called a flag refusal", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    (r.posted[ask] as any).flags = 0;
    r.restart();
    r.refuseFlag.other = true;
    await r.link.answered({ item: "P08", question: "Q2" }).catch(() => {});
    const edits = r.calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${ask}`);
    expect(edits).toHaveLength(1);
    expect(r.reports.filter((x) => x.did === "preview flag refused")).toEqual([]);
    expect(r.logs.some((l) => l.includes("Discord refused PATCH") && l.includes("fields: content"))).toBe(true);
    expect(namesFlags(new Error("discord 400: Invalid Form Body (fields: content)"))).toBe(false);
    expect(namesFlags(new Error("discord 400: Invalid Form Body (fields: data.flags)"))).toBe(true);
    expect(namesFlags(new Error("discord 403: Missing Access (fields: flags)"))).toBe(false);
  });

  test("Discord's error names the refused fields, never their values", () => {
    expect(discordError(400, { code: 50035, message: "Invalid Form Body", errors: { data: { flags: { _errors: [{ code: "X", message: "bad 32" }] } } } }))
      .toBe("discord 400: Invalid Form Body (fields: data.flags)");
    expect(discordError(404, { message: "Unknown Message" })).toBe("discord 404: Unknown Message");
    expect(discordError(500, null)).toBe("discord 500: ");
  });

  test("a failed pre-edit read of the flags: the edit goes as the caller wrote it, without the added flag, and it's noted", async () => {
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    r.restart();                                     // the link hasn't seen its flags in this run
    const path = `/channels/${DM}/messages/${ask}`;
    r.spy.onCall = (method, p) => { if (method === "GET" && p === path) throw new Error("TimeoutError: The operation timed out."); };
    // An edit of its words through the link's one Discord wrapper (every edit goes through it).
    await (r.link as any).rest("PATCH", path, { content: "Filed? (answered)" });
    const edit = r.calls.find((c) => c.method === "PATCH" && c.path === path)!;
    expect(edit.body).toEqual({ content: "Filed? (answered)" });
    expect(r.msg(ask).content).toBe("Filed? (answered)");
    expect(r.reports.filter((x) => x.did === "flags unread")).toEqual([{ point: "preview flag", writer: "link", hits: [], did: "flags unread",
      note: "the message's flags couldn't be read before the edit: sent without the preview flag", message: ask }]);
    expect(r.logs.some((l) => l.includes("couldn't read a message's flags before an edit"))).toBe(true);
    // A read that never answers is bounded too: the edit still goes.
    const r2 = rig();
    const ask2 = (await r2.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    r2.restart();
    const p2 = `/channels/${DM}/messages/${ask2}`;
    const deps = (r2.link as any).d, orig = deps.rest;
    deps.rest = (m: string, p: string, ...a: any[]) => (m === "GET" && p === p2 ? new Promise(() => {}) : orig(m, p, ...a));
    const t0 = Date.now();
    await (r2.link as any).rest("PATCH", p2, { content: "x" });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r2.calls.find((c) => c.method === "PATCH" && c.path === p2)!.body).toEqual({ content: "x" });
  }, 10_000);
});

// -- 3. the fail ping and the heartbeat's logged errors ---------------------------------------------------
describe("the heartbeat's curl and its errors", () => {
  const finishPart = () => {
    const f = readFileSync(FINISH, "utf8");
    // Cain 0.15.0, second round: the ping is the finish script's heartbeat_fail function, called here
    // as its error path calls it.
    const fn = f.slice(f.indexOf("heartbeat_fail() {"), f.indexOf("\n}\n", f.indexOf("heartbeat_fail() {")) + 3);
    return `${fn}\nheartbeat_fail "stopped on an error"`;
  };
  test.skipIf(!Bun.which("bash"))("curl starts with -q, https only, no redirects, two retries, the URL on stdin; no xtrace even under set -x", () => {
    const dir = tmp(), bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\ncat > "${join(dir, "config")}"\nexit 0\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const sh = `bashio::config() { printf '%s' "$HB"; }\nbashio::log.info() { echo "info: $*"; }\nbashio::log.warning() { echo "warn: $*"; }\nset -x\n${finishPart()}\ncase $- in *x*) echo "xtrace back on";; esac`;
    const p = Bun.spawnSync(["bash", "-c", sh], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HB: "https://hc-ping.example.net/fixture-ping-0003" }, stdout: "pipe", stderr: "pipe" });
    const args = readFileSync(join(dir, "args"), "utf8").split("\n").filter(Boolean);
    expect(args[0]).toBe("-q");
    for (const [flag, value] of [["--proto", "=https"], ["-m", "10"], ["--max-redirs", "0"], ["--retry", "2"], ["-K", "-"]])
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    expect(readFileSync(join(dir, "config"), "utf8")).toBe('url = "https://hc-ping.example.net/fixture-ping-0003/fail"\n');
    expect(args.join(" ")).not.toContain("fixture-ping");
    expect(p.stderr.toString()).not.toContain("fixture-ping");      // the trace (stderr) never shows it
    expect(p.stdout.toString()).toContain("xtrace back on");         // and xtrace is as it was after the block
  });

  test("the run and session scripts turn xtrace off around their heartbeat lines", () => {
    const run = readFileSync(RUN, "utf8");
    const watch = run.slice(run.lastIndexOf("\n(\n", run.indexOf("security/main.ts run")), run.indexOf("HEARTBEAT_URL=\"$(opt heartbeat_url)\""));
    expect(watch).toContain("{ set +x; } 2>/dev/null");
    const unset = run.indexOf("unset HEARTBEAT_URL");
    expect(run.lastIndexOf("{ set +x; } 2>/dev/null", unset)).toBeGreaterThan(unset - 200);
    const session = readFileSync(join(CAIN, "session.sh"), "utf8");
    const u = session.indexOf("unset HEARTBEAT_URL");
    expect(session.lastIndexOf("{ set +x; } 2>/dev/null", u)).toBeGreaterThan(u - 200);
  });

  test("a failed ping logs the host and the error's code only, never the URL, its path or the error's message", async () => {
    const dir = tmp(), logs: string[] = [];
    const url = "https://hc-ping.example.net/fixture-secret-0004?rid=9";
    const boom = Object.assign(new Error(`connect failed to ${url}`), { code: "ECONNREFUSED" });
    await ping(url, { fetch: async () => { throw boom; }, now: 1, upMs: 0, file: join(dir, "beat.json"), log: (m) => logs.push(m) });
    await ping(url, { fetch: async () => { throw boom; }, now: 2, upMs: 0, file: join(dir, "beat.json"), log: (m) => logs.push(m), fail: true });
    await ping(url, { fetch: async () => ({ ok: false, status: 503 }), now: 3, upMs: 0, file: join(dir, "beat2.json"), log: (m) => logs.push(m) });
    expect(logs).toEqual([
      "outside heartbeat failed (hc-ping.example.net, ECONNREFUSED), 1 in a row",
      "couldn't tell the outside heartbeat the App stopped (hc-ping.example.net, ECONNREFUSED)",
      "outside heartbeat failed (hc-ping.example.net, HTTP 503), 1 in a row",
    ]);
    for (const f of ["beat.json", "beat2.json"]) expect(readFileSync(join(dir, f), "utf8")).not.toContain("fixture-secret");
  });
});

// -- 4. the gate report's words ---------------------------------------------------------------------------
describe("the gate report tells an unknown host from a refused preview flag", () => {
  test("an unknown host is a note in known-hosts words; a refused flag is its own entry", async () => {
    const hits = linksHits("https://www.example.com/x", readHostList(null));
    expect(hits).toEqual([{ rule: "links", result: "note", at: 0, end: 25, around: `${UNKNOWN_HOST}: www.example.com` }]);
    expect(UNKNOWN_HOST).toContain("known hosts, noted not blocked");
    const r = rig();
    const ask = (await r.link.ask({ text: "Filed?", options: ["Filed", "Not filed"], item: "P08", question: "Q2" }) as any).message;
    (r.posted[ask] as any).flags = 0;
    r.restart();
    r.refuseFlag.on = true;
    await r.link.answered({ item: "P08", question: "Q2" });
    const entry = r.reports.find((x) => x.did === "preview flag refused")!;
    expect(entry.point).toBe("preview flag");
    expect(entry.hits).toEqual([]);
    expect(JSON.stringify(entry)).not.toContain("unknown host");
    const docs = readFileSync(join(ROOT, "cain", "DOCS.md"), "utf8");
    expect(docs).toContain("known hosts, noted");
    expect(docs).toContain("Cain's own Claude session can\n  read that options file");
  });
});

// -- 5. the secret scan's baseline -------------------------------------------------------------------------
// The baseline's shape: every line is a "#" comment, blank, or one gitleaks fingerprint
// (commit:path:rule:line) for a file in this repository, right under a "#" line giving its reason.
// An entry outside the tests, fixtures or docs needs its reason to say "not a test file:" and why.
// Returns the problems found, empty when the file is well formed.
function baselineProblems(text: string, root: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) return;
    const at = `line ${i + 1}`;
    const m = /^([0-9a-f]{40}):(.+):([a-z0-9]+(?:-[a-z0-9]+)*):([1-9][0-9]*)$/.exec(line);
    if (!m) { problems.push(`${at}: not a fingerprint (commit:path:rule:line): ${line}`); return; }
    const path = m[2];
    if (path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "." || p === "")) {
      problems.push(`${at}: not a path in this repository: ${path}`);
    } else if (!existsSync(join(root, path))) problems.push(`${at}: no such file in this repository: ${path}`);
    if (seen.has(line)) problems.push(`${at}: duplicate: ${line}`);
    seen.add(line);
    const before = i > 0 ? lines[i - 1].trim() : "";
    const reason = before.startsWith("#") ? before.slice(1).trim() : "";
    if (!reason) { problems.push(`${at}: no reason comment on the line above: ${line}`); return; }
    const inTests = path.split("/").slice(0, -1).some((p) => p === "tests" || p === "fixtures" || p === "__tests__" || p === "docs");
    if (!inTests && !/not a test file:\s*\S/.test(reason)) {
      problems.push(`${at}: ${path} is outside the tests, fixtures and docs and its reason doesn't say why ("not a test file: ...")`);
    }
  });
  return problems;
}

describe("the secret scan honours a baseline", () => {
  test(".gitleaksignore has the baseline's shape, read by both scans, and RELEASING.md's dates", () => {
    const ignore = join(ROOT, ".gitleaksignore");
    expect(existsSync(ignore)).toBe(true);
    expect(baselineProblems(readFileSync(ignore, "utf8"), ROOT)).toEqual([]);
    const yml = readFileSync(join(ROOT, ".github", "workflows", "tests.yml"), "utf8");
    expect(yml.split("--gitleaks-ignore-path .gitleaksignore").length).toBe(3);
    const rel = readFileSync(join(ROOT, "RELEASING.md"), "utf8");
    expect(rel).toContain("Nov 25, 2026");
    expect(rel).toContain("once a week of its runs shows no network failures");
  });

  test("the shape check is strict: no reason, a bad line, a duplicate, a stray path each fail", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const fp = `${sha}:cain/tests/c1.test.ts:generic-api-key:12`;
    expect(baselineProblems(`# a header\n\n# a made-up test key\n${fp}\n`, ROOT)).toEqual([]);
    expect(baselineProblems(`# a header\n\n${fp}\n`, ROOT)).toEqual([`line 3: no reason comment on the line above: ${fp}`]);
    expect(baselineProblems(`#\n${fp}\n`, ROOT)[0]).toContain("no reason comment");
    expect(baselineProblems(`# why\n${fp}\n# why\n${fp}\n`, ROOT)).toEqual([`line 4: duplicate: ${fp}`]);
    expect(baselineProblems(`# why\n${sha}:cain/tests/c1.test.ts::12\n`, ROOT)[0]).toContain("not a fingerprint");
    expect(baselineProblems(`# why\n   \n${sha}:cain/tests/c1.test.ts:generic-api-key:0\n`, ROOT)[0]).toContain("not a fingerprint");
    expect(baselineProblems(`# why\nabc:cain/tests/c1.test.ts:rule:1\n`, ROOT)[0]).toContain("not a fingerprint");
    expect(baselineProblems(`# why\n${sha}:cain/tests/nope.ts:rule:1\n`, ROOT)[0]).toContain("no such file");
    expect(baselineProblems(`# why\n${sha}:../etc/passwd:rule:1\n`, ROOT)[0]).toContain("not a path in this repository");
    expect(baselineProblems(`# why\n${sha}:/etc/passwd:rule:1\n`, ROOT)[0]).toContain("not a path in this repository");
    expect(baselineProblems(`# a value\n${sha}:cain/config.yaml:rule:1\n`, ROOT)[0]).toContain("outside the tests");
    expect(baselineProblems(`# not a test file: a public key\n${sha}:cain/config.yaml:rule:1\n`, ROOT)).toEqual([]);
  });
});
