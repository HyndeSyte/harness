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
// Microsoft 365 (connected Nov 17, 2026, a personal account): Cain reads it and changes nothing.
// The names are the connector's own; each one that sends, files, changes or deletes is denied by
// name, so the reading tools stay usable (a bare server name would take reading away too).
const MS = "mcp__claude_ai_Microsoft_365__";
const MICROSOFT_READS = [
  "outlook_email_search", "outlook_calendar_search", "read_resource",
  "sharepoint_search", "sharepoint_folder_search", "search_people",
].map((t) => MS + t);
const MICROSOFT_WRITES = [
  "outlook_send_mail", "outlook_send_draft", "outlook_forward_mail",
  "outlook_create_draft", "outlook_create_reply_draft", "outlook_create_reply_all_draft",
  "outlook_update_draft", "outlook_delete_draft",
  "outlook_create_event", "outlook_update_event", "outlook_delete_event", "outlook_respond_to_event",
  "outlook_batch_delete_messages", "outlook_trash_thread", "outlook_untrash_thread",
  "outlook_batch_modify_labels", "outlook_modify_labels", "outlook_modify_thread_labels",
  "outlook_create_label", "outlook_update_label", "outlook_delete_label",
  "outlook_create_filter", "outlook_delete_filter", "outlook_set_vacation",
  "sharepoint_upload_file", "sharepoint_update_file", "sharepoint_create_folder",
  "sharepoint_copy_item", "sharepoint_move_item", "sharepoint_rename_item", "sharepoint_delete_item",
  "teams_create_chat",
].map((t) => MS + t);

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

  test("Microsoft 365: every tool that sends, files, changes or deletes is denied by name, and the reading tools stay usable", () => {
    for (const t of MICROSOFT_WRITES) {
      expect(deny).toContain(t);
      expect(allow.some((a) => a === t || t.startsWith(`${a}__`))).toBe(false);
    }
    for (const t of MICROSOFT_READS) expect(deny).not.toContain(t);
    // Denying the whole server would take reading away; nothing on it is denied but the writes.
    expect(deny).not.toContain("mcp__claude_ai_Microsoft_365");
    expect(deny.filter((d) => d.startsWith("mcp__claude_ai_Microsoft_365")).sort()).toEqual([...MICROSOFT_WRITES].sort());
  });

  test("Cain can't read or change the bot token: only the plugin and the hooks read it, and deny rules don't touch them", () => {
    expect(deny).toContain("Read(//data/.claude/channels/discord/.env)");
    expect(deny).toContain("Edit(//data/.claude/channels/discord/.env)");
    for (const a of allow) expect(a).not.toContain(".env");
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
