#!/bin/bash
# Whether a Claude Code session loaded the Discord plugin from the image's seed (C1 plan 3.4):
# its start event (`claude -p --output-format stream-json --verbose`, the "init" line) lists each
# loaded plugin with the path it loaded from, as Claude Code's documentation says to check a seed.
#   seed-loaded.sh <the session's stream-json output>
# Exit 0 when it did; otherwise 1, with what the session did load on stderr.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
f="${1:?usage: seed-loaded.sh <session.jsonl>}"
found="$(jq -r --arg s "$OPT/plugin-seed/" 'select(.type == "system" and .subtype == "init") | .plugins[]?
  | select(((.path // "") | startswith($s)) and ((.name // "") | test("discord"))) | .name' "$f" 2>/dev/null | head -n 1)"
[ -n "$found" ] && exit 0
echo "[c1] the session didn't load the seed's Discord plugin; it loaded: $(jq -c 'select(.type == "system" and .subtype == "init") | [.plugins[]? | {name, path}]' "$f" 2>/dev/null | head -c 400); its plugin errors and warnings: $(jq -c 'select(.type == "system" and .subtype == "init") | [(.plugin_errors // [])[], (.plugin_warnings // [])[]]' "$f" 2>/dev/null | head -c 400)" >&2
exit 1
