#!/bin/bash
# The pre-ship connector check (Cain 0.13.3; cain/docs/connector-check.md says where it runs).
#
# Cain's managed settings (cain/rootfs/opt/cain/settings.json, installed as
# /etc/claude-code/managed-settings.json) carry an MCP allowlist. CI has no signed-in Claude
# account, so it can't see what that list does to his claude.ai connectors: 0.13.2's list
# allowed only the MCP proxy's URL, Claude Code checks each connector against its own URL, and
# all 18 were refused on the Pi (Nov 19). This runs Claude Code itself, signed in, twice:
#   claude mcp list                        his account's connectors, no managed rules
#   claude --settings <settings> mcp list  the same under Cain's rules
# and passes only when both list the same claude.ai connectors, at least one. With no account
# signed in (no claude.ai connector listed without the rules) it fails, loudly: it never passes
# for want of something to compare. Before comparing it proves --settings is enforced here: a
# known-bad copy of the settings (allowedMcpServers holding only the bridge's serverCommand)
# must list no claude.ai connector, or the check fails, since it couldn't tell.
#
# Its passing line binds the head and the settings checked (Cain puts it in the pull request
# description; the Ship step requires it for the exact head, with the same digest):
#   Connector check passed at <head sha>, settings sha256 <digest>: all N claude.ai connectors load under Cain's rules
# followed by the connector names seen, sorted, one per line.
#
#   cain/tools/connector-check.sh [settings.json]   (default: Cain's, from this clone)
# Exits 0 when every connector loads under the rules, 1 when one doesn't or the check couldn't
# run (said on stderr), 2 on a wrong use. CLAUDE_BIN names the Claude Code to run (tests);
# CONNECTOR_CHECK_TIMEOUT_S bounds each listing (default 180: it asks every server).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
settings="${1:-$here/../rootfs/opt/cain/settings.json}"
CLAUDE="${CLAUDE_BIN:-claude}"
WAIT="${CONNECTOR_CHECK_TIMEOUT_S:-180}"
[ $# -le 1 ] || { echo "usage: connector-check.sh [settings.json]" >&2; exit 2; }

fail() { printf 'CONNECTOR CHECK FAILED: %s\n' "$*" >&2; exit 1; }

[ -r "$settings" ] || fail "can't read the settings file $settings"
command -v "$CLAUDE" >/dev/null 2>&1 || fail "no Claude Code here ($CLAUDE): run this on a machine with Claude Code installed and signed in"
command -v bun >/dev/null 2>&1 || fail "no bun here: it checks the allowlist's shape (cain/tools/mcp-allowlist.ts)"

# The allowlist's shape first: a proxy URL or a per-host list fails here without a listing.
bun "$here/mcp-allowlist.ts" "$settings" || fail "the MCP allowlist in $settings isn't the one Cain needs (above)"

# The claude.ai connectors a listing names, one per line, sorted. "claude.ai Gmail: <url> - ..."
names() { sed -n 's/^\(claude\.ai [^:]*\):.*/\1/p' | sort -u; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

timeout "$WAIT" "$CLAUDE" mcp list > "$tmp/plain" 2> "$tmp/plain.err"; rc=$?
names < "$tmp/plain" > "$tmp/plain.names"
want="$(wc -l < "$tmp/plain.names" | tr -d ' ')"
if [ "$want" -eq 0 ]; then
  fail "\`claude mcp list\` named no claude.ai connector (exit $rc$(head -c 300 "$tmp/plain.err" | tr '\n' ' ' | sed 's/^./: &/')). This check needs Claude Code signed in to the account Cain uses, with its connectors; no signed-in account here, so nothing was compared and it doesn't pass. Sign in (claude, then /login) and run it again."
fi

# The control: --settings must be enforced, or a pass below would prove nothing. The candidate
# settings with allowedMcpServers cut to the bridge's serverCommand alone must load no connector.
bun -e 'const [src, dst] = process.argv.slice(1); const s = JSON.parse(await Bun.file(src).text());
s.allowedMcpServers = (Array.isArray(s.allowedMcpServers) ? s.allowedMcpServers : []).filter((e) => e && e.serverCommand !== undefined);
await Bun.write(dst, JSON.stringify(s, null, 2));' "$settings" "$tmp/known-bad.json" \
  || fail "couldn't build the known-bad settings for the control run"
timeout "$WAIT" "$CLAUDE" --settings "$tmp/known-bad.json" mcp list > "$tmp/control" 2> "$tmp/control.err"; rc=$?
names < "$tmp/control" > "$tmp/control.names"
leaked="$(wc -l < "$tmp/control.names" | tr -d ' ')"
if [ "$leaked" -ne 0 ]; then
  echo "Under a known-bad allowlist (only the bridge's serverCommand): $leaked of $want claude.ai connectors listed (exit $rc)." >&2
  fail "the managed MCP rules aren't enforced through --settings here, so this check can't tell"
fi

timeout "$WAIT" "$CLAUDE" --settings "$settings" mcp list > "$tmp/ruled" 2> "$tmp/ruled.err"; rc=$?
names < "$tmp/ruled" > "$tmp/ruled.names"
got="$(wc -l < "$tmp/ruled.names" | tr -d ' ')"
missing="$(comm -23 "$tmp/plain.names" "$tmp/ruled.names")"
if [ "$got" -ne "$want" ] || [ -n "$missing" ]; then
  echo "Without Cain's rules: $want claude.ai connectors. Under them: $got (exit $rc)." >&2
  [ -z "$missing" ] || { echo "Missing under his rules:" >&2; printf '%s\n' "$missing" | sed 's/^/  /' >&2; }
  fail "his claude.ai connectors wouldn't all load under $settings"
fi
head="$(git -C "$here" rev-parse HEAD 2>/dev/null || echo "no git head")"
digest="$(sha256sum "$settings" | cut -d' ' -f1)"
echo "Connector check passed at $head, settings sha256 $digest: all $want claude.ai connectors load under Cain's rules"
cat "$tmp/ruled.names"
