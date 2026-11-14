#!/bin/bash
# The channel smoke test (C1 plan 3.12, step 5): a real Claude Code session as cain, with the
# seeded plugin, its bridge, and a broker of its own whose server is a stand-in that sends
# nothing anywhere. The session must call the reply tool through the broker's gate, and the
# stand-in must receive it. One small Claude call on his plan; nothing reaches Discord.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
SOCK=/run/cain/smoke.sock
LOG=/run/cain/root-tmp/smoke.log
log() { echo "[c1] smoke: $*" >&2; }
rm -f "$LOG"
dm="$(jq -r '.dm // empty' /data/trust/cards.json 2>/dev/null)"
[ -n "$dm" ] || dm="1000000000000000001"
# The gate's own files go to a scratch folder of root's: the switch hasn't committed, so nothing
# of the old layout (the gate's log and tries in /data/work) may change, and /data/gate isn't
# made yet. The link isn't running during the switch, so the gate's view of his DM comes from a
# fresh synthetic cards file here (the link's own file is older than the gate trusts by now):
# his DM, no cards up. The stand-in server sends nothing anywhere.
G=/run/cain/root-tmp/smoke-gate
rm -rf "$G"; mkdir -p -m 0700 "$G"
jq -cn --arg dm "$dm" --argjson at "$(date +%s%3N)" '{written_at: $at, owner: "", dm: $dm, cards: [], sent: []}' > "$G/cards.json"
CAIN_DISCORD_SOCK="$SOCK" CAIN_BROKER_SMOKE=1 SMOKE_LOG="$LOG" CAIN_CARDS="$G/cards.json" CAIN_LINK_SOCK="$G/no-link.sock" \
  CAIN_GATE_LOG="$G/report.jsonl" CAIN_GATE_TRIES="$G/tries.json" CAIN_GATE_DM="$G/dm.json" CAIN_GATE_REPLIED="$G/replied.json" \
  CAIN_DISCORD_SERVER_CMD='["/usr/local/bin/bun","'"$OPT"'/c1/smoke-server.ts"]' \
  bun "$OPT/discord/broker-main.ts" > /run/cain/root-tmp/smoke-broker.log 2>&1 &
broker=$!
trap 'kill "$broker" 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.2; done
[ -S "$SOCK" ] || { log "its broker didn't start"; exit 1; }
out="$("$OPT/as-cain" env CAIN_DISCORD_SOCK="$SOCK" CLAUDE_CODE_PLUGIN_SEED_DIR="$OPT/plugin-seed" DISABLE_AUTOUPDATER=1 \
  timeout 240 claude -p --permission-mode auto --channels plugin:discord@claude-plugins-official \
  "This is an automated start-up check of your Discord channel, not a message from anyone. Call the Discord reply tool exactly once, with chat_id $dm and the text: ok. Then stop. Do nothing else." 2>&1)"
code=$?
if grep -q '"name":"reply"' "$LOG" 2>/dev/null; then log "passed"; exit 0; fi
log "the stand-in got no reply (claude exited $code): $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ' | cut -c1-300)"
exit 1
