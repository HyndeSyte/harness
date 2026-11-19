# The pre-ship connector check (since Cain 0.13.3)

Cain's managed settings (`cain/rootfs/opt/cain/settings.json`, installed on the Pi as
`/etc/claude-code/managed-settings.json` once he runs as his own user) carry an MCP allowlist
(`allowManagedMcpServersOnly`, `allowedMcpServers`). What that list does to his claude.ai
connectors (Gmail, his calendars, GitHub, Microsoft 365 and the rest) shows only in a Claude
Code that is signed in to an account with those connectors.

## Why

Cain 0.13.2 allowed only the URL of Anthropic's MCP proxy. Claude Code checks each claude.ai
connector against that connector's own server URL (`gmailmcp.googleapis.com`,
`api.githubcopilot.com`, `mcp.canva.com` and so on), never the proxy, so all 18 of his
connectors were refused under the new rules, and the switch to his own user undid itself
three times on Nov 19. CI has no signed-in account, which is how it got through. 0.13.3
allows every https server (`{ "serverUrl": "https://*" }`) beside the Discord bridge's
`serverCommand`; `cain/tools/mcp-allowlist.ts` checks that shape in CI.

## What it does

`cain/tools/connector-check.sh [settings.json]` (default: Cain's, from the clone it sits in):

1. Checks the allowlist's shape (`cain/tools/mcp-allowlist.ts`): a proxy URL or a per-host list
   fails here, before any listing.
2. Runs `claude mcp list`, with no managed settings, and counts the `claude.ai ...` lines.
   None at all means no account is signed in (or it has no connectors): the check fails,
   loudly, with `CONNECTOR CHECK FAILED ... no signed-in account here`. It never passes for want
   of something to compare.
3. Runs `claude --settings <settings.json> mcp list` and requires the same claude.ai
   connectors, by name and count. One missing fails it, and every name missing is printed.
4. On a pass it prints `Connector check passed at <head sha>: all N claude.ai connectors load
   under Cain's rules`.

Each listing waits up to 180 seconds (`CONNECTOR_CHECK_TIMEOUT_S`), since it asks every server.

## Where it runs

CI can't run it: it has no signed-in Claude account, so the `bun` job only runs its tests with
a stand-in `claude` (`cain/tests/connector-check.test.ts`) and checks the allowlist's shape.

It runs on a machine where Claude Code is signed in to the account Cain uses, with its
connectors connected:

- **The maintainer's signed-in machine** (a laptop session at Dane's PC, on his OK), for every
  pull request that changes Cain's managed settings, before its Ship card. Run it from a clone
  checked out at the pull request's head, and put its last line (`Connector check passed at
  <head sha> ...`) in the pull request description under "How it was tested". A new head that
  changes the settings again needs a new run.
- **The Ship job**, when its own Claude Code is signed in: RELEASING.md, Ship, step 3. When it
  isn't, the check fails loudly there as above, and the job goes on only if the pull request
  description carries a passing line for the head it installs.

## The switch's own check

The switch to his own user (`cain/rootfs/opt/cain/c1/cutover.sh`) lists his connectors as him,
under his new rules, against the names the old way recorded, and undoes the switch if any is
missing. Since 0.13.3 the App's log names every one missing (`his connectors missing under his
new rules (N of M): ...`); the line kept for Dane's alarm stays cut at 200 characters.
