// The pinned Discord plugin, as the new way runs it (C1): the server's copy whole, and the seed's
// copy but its .mcp.json (which runs the bridge), file for file against pin.json. "" when both
// match. The broker refuses to start the plugin otherwise; the upkeep says so in the log.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PIN = process.env.CAIN_DISCORD_PIN ?? join(import.meta.dir, "pin.json");
export const PLUGIN = process.env.CAIN_DISCORD_PLUGIN ?? "/opt/cain/discord/plugin";
export const SEED = process.env.CAIN_DISCORD_SEED ?? "/opt/cain/plugin-seed";

export function pinProblem(pinPath = PIN, plugin = PLUGIN, seed = SEED): string {
  let pin: { files: Record<string, string>; version: string };
  try { pin = JSON.parse(readFileSync(pinPath, "utf8")); } catch { return "the plugin pin can't be read"; }
  const sha = (p: string) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return ""; } };
  for (const [file, want] of Object.entries(pin.files)) if (sha(join(plugin, file)) !== want) return `the server's ${file} isn't the pinned one`;
  if (seed) {
    const cache = join(seed, "cache", "claude-plugins-official", "discord", pin.version);
    for (const [file, want] of Object.entries(pin.files))
      if (file !== ".mcp.json" && sha(join(cache, file)) !== want) return `the seed's ${file} isn't the pinned one`;
  }
  return "";
}
