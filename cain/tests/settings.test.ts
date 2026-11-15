// Cain's Claude Code settings (rootfs/opt/cain/settings.json, installed as managed settings, C1):
// what runs without a prompt, what never runs, and that nothing of his own can add to them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/settings.json"), "utf8"));
const allow: string[] = settings.permissions.allow;
const deny: string[] = settings.permissions.deny;

const DISCORD_READS = [
  "mcp__plugin_discord_discord__download_attachment",
  "mcp__plugin_discord_discord__fetch_messages",
];
const DISCORD_WRITES = [
  "mcp__plugin_discord_discord__reply",
  "mcp__plugin_discord_discord__react",
  "mcp__plugin_discord_discord__edit_message",
];
const SWITCHED_OFF = [
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
  "mcp__claude_ai_Notion__notion-calendar-create-events",
  "mcp__claude_ai_Notion__notion-calendar-update-events",
  "mcp__claude_ai_Notion__notion-calendar-cancel-events",
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__reply",
  "mcp__claude_ai_Gmail__forward",
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_HASS_MCP",
];

describe("Cain's permissions", () => {
  test("the Discord read tools run without a prompt", () => {
    for (const t of DISCORD_READS) expect(allow).toContain(t);
  });

  test("the only Discord tools allowed are those two reads, by exact name", () => {
    const discord = allow.filter((t) => t.includes("discord"));
    expect(discord.sort()).toEqual([...DISCORD_READS].sort());
    for (const t of DISCORD_WRITES) expect(allow).not.toContain(t);
  });

  test("the switched-off write tools stay denied and are never allowed", () => {
    for (const t of SWITCHED_OFF) {
      expect(deny).toContain(t);
      // A bare server name ("mcp__claude_ai_Gmail") would allow every tool on it.
      expect(allow.some((a) => a === t || t.startsWith(`${a}__`))).toBe(false);
    }
  });

  test("the keys are root's: his deny rules name them too, and nothing allowed touches them", () => {
    for (const r of ["Read(//data/options.json)", "Read(//data/link/**)", "Read(//data/codex/**)", "Edit(//etc/claude-code/**)"]) expect(deny).toContain(r);
    for (const a of allow) { expect(a).not.toContain(".env"); expect(a).not.toContain("/data/link"); }
  });

  test("no allow entry is a wildcard over an MCP server", () => {
    for (const t of allow.filter((a) => a.startsWith("mcp__"))) expect(t).not.toMatch(/\*/);
  });

  test("the message gate isn't a hook of his any more: the broker runs it, where he can't reach it (C1)", () => {
    const all = JSON.stringify(settings.hooks);
    expect(all).not.toContain("discord-send.ts");
    expect(all).not.toContain("discord-sent.ts");
    expect(all).not.toContain("discord-read.ts");
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse", "SessionStart"]);
    expect(settings.hooks.PreToolUse.map((e: any) => e.matcher)).toEqual(["RemoteTrigger"]);
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "bun /opt/cain/hooks/remote-trigger.ts || exit 2", timeout: 15, onFailure: "block" });
  });
});

// His standards (the registry) reach his session at every start and after every compaction,
// in parts under Claude Code's cut for a hook's added context (org-v2 DESIGN 4.F).
describe("his standards load at every start and after every compaction", () => {
  test("one SessionStart hook per part, on a start of any kind (no matcher), each with words of its own if bun fails", () => {
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const [group] = settings.hooks.SessionStart;
    expect(Object.keys(group)).toEqual(["hooks"]);
    group.hooks.forEach((h: any, i: number) => {
      expect([h.type, h.timeout]).toEqual(["command", 15]);
      expect(h.command).toStartWith(`bun /opt/cain/standards/load.ts cain --part ${i + 1} || echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Part ${i + 1} of the standards`);
    });
    expect(group.hooks).toHaveLength(3);
  });
});

describe("nothing of his own adds to his rules (C1)", () => {
  test("only these managed hooks, permission rules and plugins count", () => {
    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.disableSideloadFlags).toBe(true);
    expect(settings.strictPluginOnlyCustomization).toEqual(["mcp", "hooks"]);
    expect(settings.syncClaudeAiPlugins).toBe(false);
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
  });

  test("the one plugin, from the one marketplace, pinned in the image", () => {
    expect(settings.enabledPlugins).toEqual({ "discord@claude-plugins-official": true });
    expect(settings.strictKnownMarketplaces).toEqual([{ source: "github", repo: "anthropics/claude-plugins-official" }]);
  });
});

// The old way of starting (3.12 state A) uses 0.11.0's files unchanged, hooks and all.
describe("the old way's files are 0.11.0's", () => {
  const legacy = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/legacy/settings.json"), "utf8"));
  test("its reply and edit hooks are there", () => {
    const hooksOf = (event: string, tool: string) => (legacy.hooks[event] ?? []).filter((e: any) => e.matcher === tool).flatMap((e: any) => e.hooks);
    for (const t of ["mcp__plugin_discord_discord__reply", "mcp__plugin_discord_discord__edit_message"]) {
      expect(hooksOf("PreToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-send.ts || true", timeout: 5 }]);
      expect(hooksOf("PostToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-sent.ts || true", timeout: 15, async: true }]);
    }
  });
});
