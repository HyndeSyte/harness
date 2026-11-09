#!/bin/bash
# Cain's tools for his specialists and for talking to Dane with buttons. Prints JSON.
#   keeper.sh handover [suggestion]      hand his calendar request to the calendar specialist
#                                        (it reads his message itself); answers with card ids
#   keeper.sh digest                     take today's calendar digest for the morning message
#   keeper.sh meanings <file>            send what Dane said kinds of Family events mean: the
#                                        table in areas/family/calendar-meanings.md (rows of
#                                        | kind words | kids/me/school/drive/none | YYYY-MM-DD |)
#                                        or a JSON list of {kind, meaning, said_on}
#   keeper.sh show <card id>             show a specialist's card to Dane, unchanged
#   keeper.sh ask "question" "opt" ...   ask with up to 5 buttons; his tap comes back relayed
#   keeper.sh morning "text" ["opt" ...] post the one morning message (with Stop)
set -u
dir=/data/.claude/channels/discord
cmd="${1:-handover}"; shift || true
case "$cmd" in
  handover|digest|meanings) url="http://0fcc2575-harness:8098/$cmd"; ctx=harness-handover-v1 ;;
  show|ask|morning) url="http://127.0.0.1:8097/$cmd"; ctx=harness-relay-v1 ;;
  *) echo '{"status":"error","said":"unknown command"}'; exit 2 ;;
esac
if [ "$cmd" = meanings ] && [ ! -r "${1:-}" ]; then
  echo '{"status":"error","said":"No table file to send."}'; exit 2
fi
owner=$(jq -r '.allowFrom[0] // empty' "$dir/access.json" 2>/dev/null)
# The key is HMAC-SHA256(bot token, context); the token stays in its file.
key=$(ENV_FILE="$dir/.env" CTX="$ctx" bun -e '
const fs = require("fs"), crypto = require("crypto");
let m = null;
try { m = fs.readFileSync(process.env.ENV_FILE, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m); } catch (e) {}
if (!m) process.exit(1);
process.stdout.write(crypto.createHmac("sha256", m[1].trim()).update(process.env.CTX).digest("hex"));
') || { echo '{"status":"error","said":"No bot token here, so the specialist cannot be reached."}'; exit 1; }
umask 077
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
printf 'X-Harness-Key: %s\nContent-Type: application/json\n' "$key" > "$hdr"
unset key
case "$cmd" in
  handover) body=$(jq -nc --arg s "${1:-}" --arg p "$owner" '{suggestion: $s, paired: $p}') ;;
  digest)   body='{}' ;;
  meanings)
    # The whole table each time: the specialist stores only what's new.
    if jq -e 'type == "array" or type == "object"' "$1" >/dev/null 2>&1; then
      body=$(jq -c 'if type == "array" then {rows: .} else {rows: (.rows // [])} end' "$1")
    else
      body=$(awk -F'|' 'NF >= 5 {
          k = $2; m = $3; d = $4
          gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", m); gsub(/^[ \t]+|[ \t]+$/, "", d)
          if (m ~ /^(kids|me|school|drive|none)$/) print k "\t" m "\t" d
        }' "$1" | jq -Rnc '{rows: [inputs | split("\t") | {kind: .[0], meaning: .[1], said_on: .[2]}]}')
    fi ;;
  show)     body=$(jq -nc --arg i "${1:-}" '{id: ($i | tonumber? // 0)}') ;;
  *)        text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" '{text: $t, options: $ARGS.positional}' --args "$@") ;;
esac
out=$(curl -sS -m 45 -H "@$hdr" -d "$body" "$url" 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("No answer: " + $e)}'; exit 1; }
echo "$out"
