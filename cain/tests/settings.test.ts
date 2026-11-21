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
    // The old way's rules (as root, before the switch to his own user) deny the same, and only those.
    const legacy: string[] = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/legacy/settings.json"), "utf8")).permissions.deny;
    expect(legacy.filter((d) => d.startsWith("mcp__claude_ai_Microsoft_365")).sort()).toEqual([...MICROSOFT_WRITES].sort());
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
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
    expect(settings.hooks.PreToolUse.map((e: any) => e.matcher)).toEqual(["RemoteTrigger"]);
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "bun /opt/cain/hooks/remote-trigger.ts || exit 2", timeout: 15, onFailure: "block" });
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

// Claude Code's own offers that stop a session at a question can't stop his: no one is at his
// screen to answer. Nov 16, its offer to set up auto mode sat in his session for three hours.
describe("Claude Code's auto mode setup offer is off (Nov 16)", () => {
  test("and no gray suggested prompts in his input box, which the App's typing would add to (round 11)", () => {
    expect(settings.promptSuggestionEnabled).toBe(false);
    const session = readFileSync(join(import.meta.dir, "../rootfs/opt/cain/session.sh"), "utf8");
    const off = session.indexOf("export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(session.indexOf("claude --permission-mode"));   // both ways, before it starts
  });
  test("the new way and the old", () => {
    const legacy = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/legacy/settings.json"), "utf8"));
    expect(settings.skillOverrides).toEqual({ "auto-mode-setup": "off" });
    expect(legacy.skillOverrides).toEqual({ "auto-mode-setup": "off" });
  });
});

// The old way of starting (3.12 state A) uses 0.11.0's files, hooks and all, with only that offer off.
describe("the old way's files are 0.11.0's", () => {
  const legacy = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/legacy/settings.json"), "utf8"));
  test("0.11.0's settings and the offer, nothing else", () => {
    expect(Object.keys(legacy).sort()).toEqual(["hooks", "permissions", "skillOverrides"]);
  });
  test("its reply and edit hooks are there", () => {
    const hooksOf = (event: string, tool: string) => (legacy.hooks[event] ?? []).filter((e: any) => e.matcher === tool).flatMap((e: any) => e.hooks);
    for (const t of ["mcp__plugin_discord_discord__reply", "mcp__plugin_discord_discord__edit_message"]) {
      expect(hooksOf("PreToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-send.ts || true", timeout: 5 }]);
      expect(hooksOf("PostToolUse", t)).toEqual([{ type: "command", command: "bun /opt/cain/hooks/discord-sent.ts || true", timeout: 15, async: true }]);
    }
  });
});

// Cain 0.13.3: Claude Code checks each claude.ai connector against its own server URL
// (gmailmcp.googleapis.com, api.githubcopilot.com, mcp.canva.com, ...), never Anthropic's MCP
// proxy. 0.13.2 allowed only the proxy, so all 18 of his connectors were refused under his new
// rules and the switch to his own user undid itself three times (Nov 19).
describe("his MCP allowlist lets every claude.ai connector load (0.13.3)", () => {
  const { ALLOWLIST, mcpAllowlistProblems } = require("../tools/mcp-allowlist.ts");
  const withList = (list: unknown) => ({ ...settings, allowedMcpServers: list });
  const BRIDGE = { serverCommand: ["/usr/local/bin/bun", "/opt/cain/discord/bridge.ts"] };

  test("exactly two entries: the bridge's serverCommand as it was, and every https server", () => {
    expect(settings.allowManagedMcpServersOnly).toBe(true);
    expect(settings.allowedMcpServers).toEqual([BRIDGE, { serverUrl: "https://*" }]);
    expect(settings.allowedMcpServers).toEqual(ALLOWLIST);
    expect(mcpAllowlistProblems(settings)).toEqual([]);
  });

  test("the old way's settings carry no MCP allowlist to keep in step", () => {
    const legacy = JSON.parse(readFileSync(join(import.meta.dir, "../rootfs/opt/cain/legacy/settings.json"), "utf8"));
    expect(legacy.allowedMcpServers).toBeUndefined();
  });

  test("a settings file naming the MCP proxy fails", () => {
    const p = mcpAllowlistProblems(withList([BRIDGE, { serverUrl: "https://mcp-proxy.anthropic.com/v1/mcp/*" }]));
    expect(p.some((l: string) => l.includes("MCP proxy"))).toBe(true);
  });

  test("a settings file naming a per-host list fails", () => {
    const hosts = ["https://gmailmcp.googleapis.com/*", "https://api.githubcopilot.com/*", "https://mcp.canva.com/*"];
    const p = mcpAllowlistProblems(withList([BRIDGE, ...hosts.map((serverUrl) => ({ serverUrl }))]));
    expect(p.some((l: string) => l.includes("per-host"))).toBe(true);
    // A per-host list beside https://* still fails: exactly the two entries.
    expect(mcpAllowlistProblems(withList([BRIDGE, { serverUrl: "https://*" }, { serverUrl: hosts[0] }])).length).toBeGreaterThan(0);
  });

  test("stdio stays locked to the bridge, and the lock on servers of his own stays", () => {
    expect(mcpAllowlistProblems(withList([{ serverCommand: ["bun", "/opt/cain/discord/bridge.ts"] }, { serverUrl: "https://*" }])).length).toBeGreaterThan(0);
    expect(mcpAllowlistProblems(withList([BRIDGE, { serverUrl: "https://*" }, { serverCommand: ["/bin/sh"] }])).length).toBeGreaterThan(0);
    expect(mcpAllowlistProblems(withList([{ serverUrl: "https://*" }])).length).toBeGreaterThan(0);
    expect(mcpAllowlistProblems({ ...settings, strictPluginOnlyCustomization: ["hooks"] }).length).toBeGreaterThan(0);
    expect(mcpAllowlistProblems({ ...settings, disableSideloadFlags: false }).length).toBeGreaterThan(0);
    expect(mcpAllowlistProblems({ ...settings, allowManagedMcpServersOnly: false }).length).toBeGreaterThan(0);
  });

  test("the locks the wide allowlist relies on", () => {
    expect(settings.strictKnownMarketplaces).toEqual([{ source: "github", repo: "anthropics/claude-plugins-official" }]);
    expect(settings.enabledPlugins).toEqual({ "discord@claude-plugins-official": true });
    expect(settings.syncClaudeAiPlugins).toBe(false);
    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.disableSideloadFlags).toBe(true);
    expect(settings.strictPluginOnlyCustomization).toContain("mcp");
    expect(settings.strictPluginOnlyCustomization).toContain("hooks");
    // The shape checker refuses each one loosened.
    const bad: Record<string, unknown>[] = [
      { strictKnownMarketplaces: [] },
      { strictKnownMarketplaces: [{ source: "github", repo: "anthropics/claude-plugins-official" }, { source: "github", repo: "someone/else" }] },
      { strictKnownMarketplaces: [{ source: "github", repo: "someone/else" }] },
      { strictKnownMarketplaces: undefined },
      { enabledPlugins: { "discord@claude-plugins-official": true, "other@claude-plugins-official": true } },
      { enabledPlugins: { "discord@claude-plugins-official": false } },
      { enabledPlugins: undefined },
      { syncClaudeAiPlugins: true },
      { syncClaudeAiPlugins: undefined },
      { allowManagedHooksOnly: false },
      { allowManagedPermissionRulesOnly: false },
      { allowManagedPermissionRulesOnly: undefined },
      { disableSideloadFlags: undefined },
      { strictPluginOnlyCustomization: ["mcp"] },
      { strictPluginOnlyCustomization: undefined },
    ];
    for (const b of bad) expect(mcpAllowlistProblems({ ...settings, ...b }).length).toBeGreaterThan(0);
    // Containing mcp and hooks is enough; more locked surfaces are fine.
    expect(mcpAllowlistProblems({ ...settings, strictPluginOnlyCustomization: ["mcp", "hooks", "skills"] })).toEqual([]);
  });
});
