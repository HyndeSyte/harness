#!/bin/bash
# Hand his calendar request to the calendar keeper (the Harness add-on), and wait
# for what it did. It reads his message in the DM itself; nothing he said is passed.
# Optional first argument: a suggestion of Cain's own (a date found in an email).
# Any change resting on it gets a card he must tap.
# Prints the keeper's JSON answer: {"status": ..., "said": ..., "posted_in_dm": ...}.
set -u
dir=/data/.claude/channels/discord
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
body=$(jq -nc --arg s "${1:-}" --arg p "$owner" '{suggestion: $s, paired: $p}')
out=$(curl -sS -m 45 -H "@$hdr" -d "$body" http://0fcc2575-harness:8098/handover 2>&1) \
  || { jq -nc --arg e "$out" '{status: "error", said: ("The keeper did not answer: " + $e)}'; exit 1; }
echo "$out"
