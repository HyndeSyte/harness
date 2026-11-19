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

1. Checks the allowlist's shape and the locks it relies on (`cain/tools/mcp-allowlist.ts`): a
   proxy URL or a per-host list fails here, before any listing.
2. Runs `claude mcp list`, with no managed settings, and counts the `claude.ai ...` lines.
   None at all means no account is signed in (or it has no connectors): the check fails,
   loudly, with `CONNECTOR CHECK FAILED ... no signed-in account here`. It never passes for want
   of something to compare.
3. Proves `--settings` is enforced here, the control: it writes a known-bad copy of the
   settings (in its temp folder: `allowedMcpServers` holding only the bridge's `serverCommand`),
   runs `claude --settings <known-bad> mcp list`, and requires no claude.ai connector from it.
   If any lists, it fails with `the managed MCP rules aren't enforced through --settings here,
   so this check can't tell`. (Enforcement was confirmed on the live server on Nov 19: 0.13.2's
   proxy-only file listed 0 of 18 connectors, 0.13.3's 18 of 18.)
4. Runs `claude --settings <settings.json> mcp list` and requires the same claude.ai
   connectors, by name and count. One missing fails it, and every name missing is printed.
5. On a pass it prints the line that binds the head and the settings checked:
   `Connector check passed at <head sha>, settings sha256 <digest>: all N claude.ai connectors
   load under Cain's rules`, then the connector names seen, sorted, one per line.

Each listing waits up to 180 seconds (`CONNECTOR_CHECK_TIMEOUT_S`), since it asks every server.

## Where it runs

CI can't run it: it has no signed-in Claude account, so the `bun` job only runs its tests with
a stand-in `claude` (`cain/tests/connector-check.test.ts`) and checks the allowlist's shape.

Cain runs it himself, on the live server (the Pi), signed in as the account, for every pull
request that changes his managed settings: from the settings file at the pull request's head,
before he shows the Ship card. He puts its passing line in the pull request description. A new
head needs a new run. Nothing in it is Dane's to do.

The Ship step (RELEASING.md, Ship, step 3) requires that line for the exact head it installs,
and that the SHA-256 of `cain/rootfs/opt/cain/settings.json` at that head equals the digest in
the line; otherwise it installs nothing and says so.

## The switch's own check

The switch to his own user (`cain/rootfs/opt/cain/c1/cutover.sh`) lists his connectors as him,
under his new rules, against the names the old way recorded, and undoes the switch if any is
missing. Since 0.13.3 the App's log names every one missing (`his connectors missing under his
new rules (N of M): ...`); the line kept for Dane's alarm stays cut at 200 characters.
