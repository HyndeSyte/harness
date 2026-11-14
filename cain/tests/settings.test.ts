// Cain's Claude Code settings (rootfs/opt/cain/settings.json): what runs without a prompt, and what never runs.
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

  test("no allow entry is a wildcard over an MCP server", () => {
    for (const t of allow.filter((a) => a.startsWith("mcp__"))) expect(t).not.toMatch(/\*/);
  });

  test("the reply and edit tools have the message gate in front, waited for, and the safety net after, in the background", () => {
    const hooksOf = (event: string, tool: string) => (settings.hooks[event] ?? []).filter((e: any) => e.matcher === tool).flatMap((e: any) => e.hooks);
    for (const t of ["mcp__plugin_discord_discord__reply", "mcp__plugin_discord_discord__edit_message"]) {
      expect(hooksOf("PreToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-send.ts || true", timeout: 5 }]);
      expect(hooksOf("PostToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-sent.ts || true", timeout: 15, async: true }]);
    }
    expect(hooksOf("PreToolUse", "mcp__plugin_discord_discord__react")).toEqual([]);   // a reaction carries no words
  });
});
