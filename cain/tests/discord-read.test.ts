// Cain's guard on the two Discord reads (hooks/discord-read.ts), the plugin pin
// (discord/pin.json), and the inbox upkeep (discord/upkeep.ts).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccess, checkPin, decide, ownerDm, READS, type Pin } from "../rootfs/opt/cain/hooks/discord-read";
import { MAX_AGE_MS, MAX_BYTES, sweepInbox } from "../rootfs/opt/cain/discord/upkeep";

const ROOT = join(import.meta.dir, "../rootfs");
const HOOK = join(ROOT, "opt/cain/hooks/discord-read.ts");
const PIN: Pin = JSON.parse(readFileSync(join(ROOT, "opt/cain/discord/pin.json"), "utf8"));
const OWNER = "111111111111111111", DM = "222222222222222222", OTHER_DM = "333333333333333333", GROUP = "444444444444444444";
const [DOWNLOAD, FETCH] = READS;

const access = (over: any = {}) => JSON.stringify({ dmPolicy: "allowlist", allowFrom: [OWNER], groups: {}, pending: {}, ...over });
const link = (over: any = {}) => JSON.stringify({ next: 1, cards: {}, messages: {}, owner: OWNER, dm: DM, bot: "555555555555555555", ...over });
const ok = { access: access(), link: link(), pinCheck: "" };
const dl = (chat_id: any) => ({ tool_name: DOWNLOAD, hook_event_name: "PreToolUse", tool_input: { chat_id, message_id: "9" } });
const fetchCall = (channel: any) => ({ tool_name: FETCH, hook_event_name: "PreToolUse", tool_input: { channel, limit: 20 } });

describe("the Discord reads hook", () => {
  test("allows both reads on the owner's DM", () => {
    expect(decide(dl(DM), ok)).toBe("");
    expect(decide(fetchCall(DM), ok)).toBe("");
  });

  test("refuses any other chat, a group, or no chat at all", () => {
    for (const chat of [OTHER_DM, GROUP, OWNER, "", undefined, `${DM} `, Number(DM)]) {
      expect(decide(dl(chat), ok)).toContain("Only the owner's DM");
      expect(decide(fetchCall(chat), ok)).toContain("Only the owner's DM");
    }
    // fetch_messages names its chat "channel", not chat_id.
    expect(decide({ tool_name: FETCH, tool_input: { chat_id: DM } }, ok)).toContain("Only the owner's DM");
  });

  test("refuses while the owner's DM is unknown, or recorded for someone else", () => {
    for (const l of [null, "{broken", link({ dm: undefined }), link({ owner: undefined }), link({ owner: "999999999999999999" }), link({ dm: "x" })])
      expect(decide(dl(DM), { ...ok, link: l })).toContain("isn't known yet");
  });

  test("refuses unless access.json is one allowlisted user and no groups", () => {
    const bad = [null, "{", access({ dmPolicy: "pairing" }), access({ dmPolicy: "open" }), access({ allowFrom: [] }),
      access({ allowFrom: [OWNER, "666666666666666666"] }), access({ groups: { [GROUP]: { requireMention: true, allowFrom: [] } } })];
    for (const a of bad) expect(decide(fetchCall(DM), { ...ok, access: a })).toContain("refused");
    expect(decide(fetchCall(DM), { ...ok, access: access({ groups: undefined }) })).toBe("");   // the plugin's default: none
  });

  test("refuses while the installed plugin isn't the pinned one", () => {
    expect(decide(dl(DM), { ...ok, pinCheck: "server.ts isn't the pinned one" })).toContain("only for the pinned plugin");
  });

  test("leaves other tools alone, and refuses what it can't read", () => {
    expect(decide({ tool_name: "mcp__plugin_discord_discord__reply", tool_input: { chat_id: GROUP } }, ok)).toBe("");
    expect(decide(null, ok)).toContain("refused");
    expect(decide({ tool_name: DOWNLOAD }, ok)).toContain("refused");
  });

  test("as wired: denies a stranger's chat and anything unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-dread-"));
    writeFileSync(join(dir, "access.json"), access());
    writeFileSync(join(dir, "state.json"), link());
    const env = { ...process.env, CAIN_DISCORD_ACCESS: join(dir, "access.json"), CAIN_LINK_STATE: join(dir, "state.json"),
      CAIN_PLUGINS_INSTALLED: join(dir, "none.json") };
    const run = async (input: string) => {
      const p = Bun.spawn(["bun", HOOK], { stdin: new Blob([input]), stdout: "pipe", env });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out ? JSON.parse(out).hookSpecificOutput : null;
    };
    const stranger = await run(JSON.stringify(dl(OTHER_DM)));
    expect(stranger.permissionDecision).toBe("deny");
    expect((await run("not json")).permissionDecision).toBe("deny");
    // No plugin installed here: even the owner's DM is refused.
    expect((await run(JSON.stringify(fetchCall(DM)))).permissionDecisionReason).toContain("no plugins are installed");
  });

  test("ownerDm needs both files to agree", () => {
    expect(ownerDm(access(), link())).toBe(DM);
    expect(ownerDm(access({ allowFrom: ["777777777777777777"] }), link())).toBe("");
  });
});

describe("settings.json wires the hook on exactly the two reads", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, "opt/cain/settings.json"), "utf8"));
  test("one PreToolUse entry per read, by exact name", () => {
    const entries = settings.hooks.PreToolUse.filter((e: any) => String(e.hooks?.[0]?.command).includes("discord-read.ts"));
    expect(entries.map((e: any) => e.matcher).sort()).toEqual([...READS].sort());
    for (const e of entries) expect(e.hooks).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-read.ts || exit 2", timeout: 15, onFailure: "block" }]);
    expect(settings.hooks.PreToolUse.find((e: any) => e.matcher === "RemoteTrigger")).toBeTruthy();
  });
});

describe("the startup access check", () => {
  test("passes only dmPolicy allowlist, one user, no groups", () => {
    expect(checkAccess(access())).toBe("");
    expect(checkAccess(null)).toContain("missing");
    expect(checkAccess(access({ dmPolicy: "pairing" }))).toContain("allowlist");
    expect(checkAccess(access({ allowFrom: [OWNER, "666666666666666666"] }))).toContain("exactly one");
    expect(checkAccess(access({ allowFrom: ["not-an-id"] }))).toContain("exactly one");
    expect(checkAccess(access({ groups: { [GROUP]: {} } }))).toContain("groups");
  });

  test("upkeep logs it loudly and keeps running (no crash loop)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-upkeep-"));
    writeFileSync(join(dir, "access.json"), access({ dmPolicy: "pairing" }));
    const p = Bun.spawn(["bun", join(ROOT, "opt/cain/discord/upkeep.ts")], { stdout: "pipe", env: { ...process.env,
      CAIN_DISCORD_ACCESS: join(dir, "access.json"), CAIN_PLUGINS_INSTALLED: join(dir, "none.json"), CAIN_DISCORD_INBOX: join(dir, "inbox") } });
    const reader = p.stdout.getReader();
    let out = "";
    while (!(out.includes("dmPolicy") && out.includes("no plugins are installed"))) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("[discord] ERROR: access.json dmPolicy");
    expect(out).toContain("[discord] ERROR: no plugins are installed");
    await Bun.sleep(200);
    expect(p.exitCode).toBeNull();     // still running
    p.kill();
  });
});

describe("the Discord plugin pin", () => {
  // If this fails, the plugin's pin changed. The allow entries for download_attachment and
  // fetch_messages in settings.json were reviewed against this exact plugin code: re-review
  // them (and the plugin's own allowlist gate and inbox naming) before updating these values.
  test("is the reviewed version", () => {
    expect(PIN).toEqual({
      plugin: "discord@claude-plugins-official",
      marketplace: "anthropics/claude-plugins-official",
      commit: "e0ab6e51219eef74e417a0e1d89e5d53e5e763d4",
      version: "0.0.4",
      files: {
        ".claude-plugin/plugin.json": "3e559b00317540f96fe3b24aee4a816af8b43d648f6e1dd9896e59aa835cd3d8",
        ".mcp.json": "01c15597e40a5999d7b1c15bd6f9656abc8a04d3a0956704a9dfd2df01b74960",
        "package.json": "fa2ece9108aca2ae17e7b1909f468ee8f055e53a45882eb25108a3e394f17e46",
        "bun.lock": "c3d69584e51e46a758bd9c8a8bfef12b46fe9f2bb57a367f4deb073edd26c55e",
        "server.ts": "6edc17d9e9d04930967361ba51c8e03b8f8508647a1dfc11d79ee6a0eb1010b7",
      },
    });
  });

  test("the start script installs the pinned commit", () => {
    const run = readFileSync(join(ROOT, "etc/services.d/cain/run"), "utf8");
    expect(run).toContain('jq -r .commit /opt/cain/discord/pin.json');
    expect(run).toContain('checkout -q --detach "$pin_commit"');
    expect(run.indexOf("checkout -q --detach")).toBeLessThan(run.indexOf("claude plugin install discord@claude-plugins-official"));
    expect(run).toContain("bun /opt/cain/discord/upkeep.ts");
  });

  const installed = (dir: string, version = "0.0.4") => JSON.stringify({ version: 2, plugins: { [PIN.plugin]: [
    { scope: "user", installPath: dir, version, gitCommitSha: PIN.commit } ] } });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  test("checkPin compares the installed version and every pinned file", () => {
    const files: Record<string, string> = { "server.ts": "code", ".mcp.json": "{}" };
    const pin: Pin = { ...PIN, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) };
    const read = (over: Record<string, string | null> = {}) => (p: string) => {
      const f = p.slice("/p/".length), v = f in over ? over[f] : files[f];
      return v === null || v === undefined ? null : Buffer.from(v);
    };
    expect(checkPin(pin, installed("/p"), read())).toBe("");
    expect(checkPin(pin, installed("/p", "0.0.5"), read())).toContain("pinned 0.0.4");
    expect(checkPin(pin, installed("/p"), read({ "server.ts": "changed" }))).toContain("server.ts isn't the pinned one");
    expect(checkPin(pin, installed("/p"), read({ ".mcp.json": null }))).toContain("missing");
    expect(checkPin(pin, null, read())).toContain("no plugins");
    expect(checkPin(pin, JSON.stringify({ plugins: {} }), read())).toContain("isn't installed");
  });
});

describe("the inbox upkeep", () => {
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const put = (dir: string, name: string, bytes: number, ageMs: number) => {
    writeFileSync(join(dir, name), Buffer.alloc(bytes));
    const t = (NOW - ageMs) / 1000;
    utimesSync(join(dir, name), t, t);
  };

  test("deletes files older than 7 days and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-inbox-"));
    put(dir, "1-old.png", 10, MAX_AGE_MS + 60_000);
    put(dir, "2-new.png", 10, MAX_AGE_MS - 60_000);
    mkdirSync(join(dir, "sub"));
    const r = sweepInbox(dir, NOW);
    expect(r.removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["2-new.png", "sub"]);
  });

  test("keeps it under the cap, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "cain-inbox-"));
    put(dir, "a.bin", 400, 3_000);
    put(dir, "b.bin", 400, 2_000);
    put(dir, "c.bin", 400, 1_000);
    const r = sweepInbox(dir, NOW, MAX_AGE_MS, 900);
    expect(readdirSync(dir).sort()).toEqual(["b.bin", "c.bin"]);
    expect(r).toEqual({ removed: 1, kept: 2, bytes: 800 });
  });

  test("the cap is 200 MB and a missing inbox is fine", () => {
    expect(MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(sweepInbox(join(tmpdir(), "no-such-inbox-xyz"), NOW)).toEqual({ removed: 0, kept: 0, bytes: 0 });
  });
});
