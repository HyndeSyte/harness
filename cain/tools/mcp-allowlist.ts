// Cain's managed MCP allowlist (rootfs/opt/cain/settings.json: allowManagedMcpServersOnly and
// allowedMcpServers), checked by its shape. Used by cain/tests/settings.test.ts and by the
// pre-ship connector check (cain/tools/connector-check.sh).
//
// Why this shape (Cain 0.13.3): Claude Code checks each claude.ai connector against that
// connector's own server URL (gmailmcp.googleapis.com, api.githubcopilot.com, mcp.canva.com and
// so on), never against Anthropic's MCP proxy. 0.13.2 allowed only the proxy's URL, so all 18 of
// his claude.ai connectors were refused under his new rules and the switch to his own user undid
// itself three times on Nov 19. A list of hosts would break each time a connector is added, so
// every https server is allowed. Local (stdio) servers stay locked to the Discord bridge, and
// servers he'd add himself stay blocked by strictPluginOnlyCustomization ["mcp", "hooks"] and
// disableSideloadFlags; the deny list still denies every write tool by name.

export const BRIDGE = { serverCommand: ["/usr/local/bin/bun", "/opt/cain/discord/bridge.ts"] };
export const CONNECTORS = { serverUrl: "https://*" };
export const ALLOWLIST = [BRIDGE, CONNECTORS];

const PROXY = "mcp-proxy.anthropic.com";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Every reason the settings' MCP allowlist isn't the one Cain needs; none when it is.
export function mcpAllowlistProblems(settings: any): string[] {
  const out: string[] = [];
  if (settings?.allowManagedMcpServersOnly !== true) out.push("allowManagedMcpServersOnly isn't true");
  if (settings?.strictPluginOnlyCustomization === undefined || !same(settings.strictPluginOnlyCustomization, ["mcp", "hooks"]))
    out.push('strictPluginOnlyCustomization isn\'t ["mcp", "hooks"]');
  if (settings?.disableSideloadFlags !== true) out.push("disableSideloadFlags isn't true");
  const list = settings?.allowedMcpServers;
  if (!Array.isArray(list)) { out.push("allowedMcpServers isn't a list"); return out; }
  for (const e of list) {
    const url = typeof e?.serverUrl === "string" ? e.serverUrl : undefined;
    if (url === undefined || url === CONNECTORS.serverUrl) continue;
    if (url.includes(PROXY)) out.push(`allowedMcpServers names the MCP proxy (${url}): claude.ai connectors are checked against their own server URLs, never the proxy, so none would load`);
    else out.push(`allowedMcpServers names a server URL other than "https://*" (${url}): a per-host list leaves out every connector it doesn't name, and breaks when one is added`);
  }
  if (!list.some((e: unknown) => same(e, BRIDGE))) out.push("allowedMcpServers doesn't hold the Discord bridge's serverCommand exactly");
  if (!list.some((e: unknown) => same(e, CONNECTORS))) out.push('allowedMcpServers doesn\'t hold { "serverUrl": "https://*" }');
  if (list.length !== 2 || !list.every((e: unknown) => same(e, BRIDGE) || same(e, CONNECTORS)))
    out.push("allowedMcpServers must hold exactly the bridge's serverCommand and https://*, nothing else");
  return out;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: bun mcp-allowlist.ts <settings.json>"); process.exit(2); }
  let s: unknown;
  try { s = JSON.parse(await Bun.file(file).text()); }
  catch (e) { console.error(`${file}: not readable JSON (${(e as Error).message})`); process.exit(1); }
  const p = mcpAllowlistProblems(s);
  for (const l of p) console.error(`${file}: ${l}`);
  process.exit(p.length ? 1 : 0);
}
