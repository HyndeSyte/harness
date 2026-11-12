// Cain's guard on the two Discord reads he runs without a prompt (settings.json allows
// download_attachment and fetch_messages by exact name): a PreToolUse hook, wired in
// settings.json for exactly those two tools (a crash refuses too). Each call must name
// the owner's DM and nothing else:
//   - access.json (the plugin's allowlist) is dmPolicy "allowlist", exactly one allowFrom
//     user, and no groups;
//   - the owner's DM channel is the one the link recorded (/data/link/state.json: it asked
//     Discord for the bot owner's DM itself), and that owner is the one allowlisted user;
//     unknown means refused;
//   - the installed Discord plugin is the pinned one (discord/pin.json): the allow
//     entries were reviewed against that code.
// The plugin refuses a chat outside its allowlist on its own (fetchAllowedChannel in its
// server.ts); this keeps the reads to the owner's DM even if a group is allowlisted later.
// A refusal goes back to Cain as the reason; anything else is left to the usual rules.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const READS = ["mcp__plugin_discord_discord__download_attachment", "mcp__plugin_discord_discord__fetch_messages"];
const ACCESS = process.env.CAIN_DISCORD_ACCESS ?? "/data/.claude/channels/discord/access.json";
const LINK = process.env.CAIN_LINK_STATE ?? "/data/link/state.json";
const INSTALLED = process.env.CAIN_PLUGINS_INSTALLED ?? "/data/.claude/plugins/installed_plugins.json";
const PIN = process.env.CAIN_DISCORD_PIN ?? join(import.meta.dir, "../discord/pin.json");

export interface Pin { plugin: string; marketplace: string; commit: string; version: string; files: Record<string, string> }

const SNOWFLAKE = /^[0-9]{5,25}$/;
const clip = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

// "" when access.json is single-owner DM only; otherwise what's wrong with it.
export function checkAccess(text: string | null): string {
  if (text === null) return "access.json is missing (the Discord plugin isn't paired)";
  let a: any;
  try { a = JSON.parse(text); } catch { return "access.json can't be read"; }
  if (!a || typeof a !== "object" || Array.isArray(a)) return "access.json can't be read";
  if (a.dmPolicy !== "allowlist") return `access.json dmPolicy is "${clip(String(a.dmPolicy ?? ""))}", not "allowlist"`;
  const from = a.allowFrom;
  if (!Array.isArray(from) || from.length !== 1 || typeof from[0] !== "string" || !SNOWFLAKE.test(from[0]))
    return `access.json must allow exactly one user (it has ${Array.isArray(from) ? from.length : 0})`;
  const groups = a.groups ?? {};
  if (typeof groups !== "object" || Array.isArray(groups) || Object.keys(groups).length)
    return "access.json has groups; Cain reads only the owner's DM";
  return "";
}

// The owner's DM channel id, or "" when it isn't known for the one allowlisted user.
export function ownerDm(accessText: string | null, linkText: string | null): string {
  if (checkAccess(accessText) || linkText === null) return "";
  let s: any;
  try { s = JSON.parse(linkText); } catch { return ""; }
  const owner = String(JSON.parse(accessText!).allowFrom[0]);
  if (String(s?.owner ?? "") !== owner) return "";
  const dm = String(s?.dm ?? "");
  return SNOWFLAKE.test(dm) ? dm : "";
}

// "" when the installed Discord plugin is the pinned version, file for file.
export function checkPin(pin: Pin, installedText: string | null, read: (path: string) => Buffer | null): string {
  if (installedText === null) return "no plugins are installed";
  let inst: any;
  try { inst = JSON.parse(installedText); } catch { return "installed_plugins.json can't be read"; }
  const entries = inst?.plugins?.[pin.plugin];
  const e = Array.isArray(entries) ? entries.find((x: any) => x?.scope === "user") ?? entries[0] : null;
  if (!e || typeof e.installPath !== "string") return `${pin.plugin} isn't installed`;
  if (e.version !== pin.version) return `${pin.plugin} is version ${clip(String(e.version ?? "?"))}, pinned ${pin.version}`;
  for (const [file, want] of Object.entries(pin.files)) {
    const buf = read(join(e.installPath, file));
    if (!buf) return `${pin.plugin}'s ${file} is missing`;
    if (createHash("sha256").update(buf).digest("hex") !== want) return `${pin.plugin}'s ${file} isn't the pinned one`;
  }
  return "";
}

export interface Files { access: string | null; link: string | null; pinCheck: string }

// "" when there's nothing to object to; otherwise why it's refused, for Cain.
export function decide(call: any, f: Files): string {
  if (!call || typeof call !== "object") return "couldn't read the Discord call, so it's refused";
  const tool = String(call.tool_name ?? "");
  if (!READS.includes(tool)) return "";
  const t = call.tool_input;
  if (!t || typeof t !== "object") return "couldn't read the Discord call, so it's refused";
  const chat = String((tool.endsWith("fetch_messages") ? t.channel : t.chat_id) ?? "");
  const bad = checkAccess(f.access);
  if (bad) return `Discord reads are refused: ${bad}.`;
  if (f.pinCheck) return `Discord reads are refused: ${f.pinCheck}. These reads are allowed only for the pinned plugin, which was reviewed.`;
  const dm = ownerDm(f.access, f.link);
  if (!dm) return "The owner's DM channel isn't known yet (the link records it once it reaches Discord), so Discord reads are refused for now.";
  if (chat !== dm) return `Only the owner's DM can be read; "${clip(chat)}" is refused.`;
  return "";
}

const text = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const bytes = (p: string) => { try { return readFileSync(p); } catch { return null; } };

export function pinCheckHere(): string {
  let pin: Pin;
  try { pin = JSON.parse(readFileSync(PIN, "utf8")); } catch { return "the plugin pin can't be read"; }
  return checkPin(pin, text(INSTALLED), bytes);
}
export const accessHere = () => text(ACCESS);
export const linkHere = () => text(LINK);

if (import.meta.main) {
  let reason: string;
  try { reason = decide(JSON.parse(await Bun.stdin.text()), { access: accessHere(), link: linkHere(), pinCheck: pinCheckHere() }); }
  catch { reason = "couldn't read the Discord call, so it's refused"; }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}
