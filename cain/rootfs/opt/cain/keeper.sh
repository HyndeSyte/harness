#!/bin/bash
# Cain's line to his calendar specialist (the Harness add-on). Prints its JSON answer.
#   keeper.sh handover [suggestion]     hand over his calendar request (it reads his message itself)
#   keeper.sh ask "question" "opt" ...  post a question with up to 5 buttons; his tap comes back relayed
#   keeper.sh digest                    take today's calendar digest for the morning update
#   keeper.sh morning "text" ["opt" ...] post the one morning update (with Stop, and optional buttons)
set -u
dir=/data/.claude/channels/discord
cmd="${1:-handover}"; shift || true
case "$cmd" in handover|ask|digest|morning) ;; *) echo '{"status":"error","said":"unknown command"}'; exit 2;; esac
owner=$(jq -r '.allowFrom[0] // empty' "$dir/access.json" 2>/dev/null)
# The key is HMAC-SHA256(bot token, "harness-handover-v1"); the token stays in its file.
key=$(ENV_FILE="$dir/.env" bun -e '
const fs = require("fs"), crypto = require("crypto");
let m = null;
try { m = fs.readFileSync(process.env.ENV_FILE, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m); } catch (e) {}
if (!m) process.exit(1);
process.stdout.write(crypto.createHmac("sha256", m[1].trim()).update("harness-handover-v1").digest("hex"));
') || { echo '{"status":"error","said":"No bot token here, so the keeper cannot be reached."}'; exit 1; }
umask 077
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
printf 'X-Harness-Key: %s\nContent-Type: application/json\n' "$key" > "$hdr"
unset key
case "$cmd" in
  handover) body=$(jq -nc --arg s "${1:-}" --arg p "$owner" '{suggestion: $s, paired: $p}') ;;
  digest)   body='{}' ;;
  *)        text="${1:-}"; shift || true
            body=$(jq -nc --arg t "$text" '{text: $t, options: $ARGS.positional}' --args "$@") ;;
esac
out=$(curl -sS -m 45 -H "@$hdr" -d "$body" "http://0fcc2575-harness:8098/$cmd" 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("The keeper did not answer: " + $e)}'; exit 1; }
echo "$out"
