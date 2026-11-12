#!/bin/bash
# Cain's tools for his specialists and for talking to Dane with buttons. Prints JSON.
#   keeper.sh handover [suggestion]      hand his calendar request to the calendar specialist
#                                        (it reads his message itself); answers with card ids
#   keeper.sh digest                     take today's calendar digest for the morning message
#   keeper.sh meanings <file>            send what Dane said kinds of Family events mean: the
#                                        table in areas/family/calendar-meanings.md (rows of
#                                        | kind words | kids/me/school/drive/none | YYYY-MM-DD |)
#                                        or a JSON list of {kind, meaning, said_on}
#   keeper.sh places <file>              send Dane's place book: the table in
#                                        areas/home/places.md (rows of
#                                        | place name | street address, "lat, lon" or skip | YYYY-MM-DD |)
#                                        or a JSON list of {place, address, said_on}
#   Cards and asks name their item: --item <PENDING id, or none>, with --question <id>
#   when the item has more than one; --reply-to <message id> makes it a Discord reply.
#   keeper.sh show <card id> --item P08 [--question Q2] [--reply-to <id>]
#                                        show a specialist's card to Dane, unchanged
#   keeper.sh ask --item P08 [--question Q2] [--reply-to <id>] "question" "opt" ...
#                                        ask with up to 5 buttons, one ask open at a time
#                                        ("held" means it goes out when the open one closes);
#                                        his tap comes back relayed
#   keeper.sh ship --item P41 --pr <pull request url> --head <full sha> "text"
#                                        the Ship card (Ship / Not now) for that one head
#   keeper.sh answered --item P08 [--question Q2]
#                                        he answered that open ask in words: buttons off
#   keeper.sh replied <message id>       what a message of his replied to, if anything
#   keeper.sh morning "text"             post the one morning message (with Stop)
#   keeper.sh stopped                    whether everything is stopped (Dane's Stop), and since when
set -u
dir=/data/.claude/channels/discord
cmd="${1:-handover}"; shift || true
case "$cmd" in
  handover|digest|meanings|places) url="http://0fcc2575-harness:8098/$cmd"; ctx=harness-handover-v1 ;;
  show|ask|ship|answered|replied|morning|stopped) url="http://127.0.0.1:8097/$cmd"; ctx=harness-relay-v1 ;;
  *) echo '{"status":"error","said":"unknown command"}'; exit 2 ;;
esac
if { [ "$cmd" = meanings ] || [ "$cmd" = places ]; } && [ ! -r "${1:-}" ]; then
  echo '{"status":"error","said":"No table file to send."}'; exit 2
fi
item="" question="" reply_to="" pr="" head=""
case "$cmd" in
  show|ask|ship|answered)
    rest=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --item|--question|--reply-to|--pr|--head)
          [ $# -ge 2 ] || { jq -nc --arg f "$1" '{status: "error", said: ($f + " needs a value")}'; exit 2; }
          case "$1" in
            --item) item="$2" ;; --question) question="$2" ;; --reply-to) reply_to="$2" ;;
            --pr) pr="$2" ;; --head) head="$2" ;;
          esac
          shift 2 ;;
        *) rest+=("$1"); shift ;;
      esac
    done
    set -- ${rest[@]+"${rest[@]}"} ;;
esac
# The card's item, question and thread, as the link takes them.
meta='def opt($k; $v): if $v == "" then {} else {($k): $v} end; ({item: $it} + opt("question"; $q) + opt("reply_to"; $r))'
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
      # An optional fourth column (For, a date) makes a row his answer about that one event.
      body=$(awk -F'|' 'NF >= 5 {
          k = $2; m = $3; d = $4; f = (NF >= 6 ? $5 : "")
          gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", m); gsub(/^[ \t]+|[ \t]+$/, "", d)
          gsub(/^[ \t]+|[ \t]+$/, "", f)
          if (m ~ /^(kids|me|school|drive|none)$/) print k "\t" m "\t" d "\t" f
        }' "$1" | jq -Rnc '{rows: [inputs | split("\t")
          | {kind: .[0], meaning: .[1], said_on: .[2]} + (if (.[3] // "") != "" then {for: .[3]} else {} end)]}')
    fi ;;
  places)
    # The whole book each time: it replaces what the specialist had.
    if jq -e 'type == "array" or type == "object"' "$1" >/dev/null 2>&1; then
      body=$(jq -c 'if type == "array" then {rows: .} else {rows: (.rows // [])} end' "$1")
    else
      body=$(awk -F'|' 'NF >= 5 {
          p = $2; a = $3; d = $4
          gsub(/^[ \t]+|[ \t]+$/, "", p); gsub(/^[ \t]+|[ \t]+$/, "", a); gsub(/^[ \t]+|[ \t]+$/, "", d)
          if (d ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) print p "\t" a "\t" d
        }' "$1" | jq -Rnc '{rows: [inputs | split("\t") | {place: .[0], address: .[1], said_on: .[2]}]}')
    fi ;;
  show)     body=$(jq -nc --arg i "${1:-}" --arg it "$item" --arg q "$question" --arg r "$reply_to" \
              "$meta"' + {id: ($i | tonumber? // 0)}') ;;
  ask)      text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" --arg it "$item" --arg q "$question" --arg r "$reply_to" \
              "$meta"' + {text: $t, options: $ARGS.positional}' --args "$@") ;;
  ship)     body=$(jq -nc --arg t "${1:-}" --arg it "$item" --arg q "" --arg r "$reply_to" --arg p "$pr" --arg h "$head" \
              "$meta"' + {text: $t, pr: $p, head: $h}') ;;
  answered) body=$(jq -nc --arg it "$item" --arg q "$question" --arg r "" "$meta") ;;
  replied)  body=$(jq -nc --arg m "${1:-}" '{m: $m}') ;;
  stopped)  body='{}' ;;
  morning)  text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" '{text: $t, options: $ARGS.positional}' --args "$@") ;;
esac
out=$(curl -sS -m 45 -H "@$hdr" -d "$body" "$url" 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("No answer: " + $e)}'; exit 1; }
echo "$out"
