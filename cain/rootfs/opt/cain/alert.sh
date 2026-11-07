#!/bin/bash
# Send the owner a Discord DM from Cain's bot, without Claude: used when Claude
# itself can't run (its sign-in expired). Text is the first argument.
# The token never reaches the log or a command line.
set -u
dir=/data/.claude/channels/discord
token=$(sed -n 's/^DISCORD_BOT_TOKEN=//p' "$dir/.env" 2>/dev/null | head -n 1)
owner=$(jq -r '.allowFrom[0] // empty' "$dir/access.json" 2>/dev/null)
[ -n "$token" ] && [ -n "$owner" ] || { echo "alert: no token or no paired owner" >&2; exit 1; }
api=https://discord.com/api/v10
# The header goes in a private file, so the token stays off curl's command line.
umask 077
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
printf 'Authorization: Bot %s\nContent-Type: application/json\n' "$token" > "$hdr"
unset token
auth=(-H "@$hdr")
channel=$(curl -fsS -m 20 "${auth[@]}" -d "$(jq -nc --arg r "$owner" '{recipient_id: $r}')" \
  "$api/users/@me/channels" | jq -r '.id // empty') || true
[ -n "$channel" ] || { echo "alert: could not open the DM" >&2; exit 1; }
curl -fsS -m 20 -o /dev/null "${auth[@]}" -d "$(jq -nc --arg c "$1" '{content: $c}')" \
  "$api/channels/$channel/messages" || { echo "alert: send failed" >&2; exit 1; }
