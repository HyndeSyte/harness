#!/bin/bash
# The channel smoke test (C1 plan 3.12, step 5): a real Claude Code session as cain, with the
# seeded plugin, its bridge, and a broker of its own whose server is a stand-in that sends
# nothing anywhere. The session must call the reply tool through the broker's gate, and the
# stand-in must receive it. One small Claude call on his plan; nothing reaches Discord.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
# C1_RUN and C1_DATA are for the tests only (cain/tests/c1-smoke.test.ts); on the Pi they're unset.
RUN="${C1_RUN:-/run/cain}"
SOCK="$RUN/smoke.sock"
LOG="$RUN/root-tmp/smoke.log"
log() { echo "[c1] smoke: $*" >&2; }
rm -f "$LOG"
dm="$(jq -r '.dm // empty' "${C1_DATA:-/data}/trust/cards.json" 2>/dev/null)"
[ -n "$dm" ] || dm="1000000000000000001"
# The gate's own files go to a scratch folder of root's: the switch hasn't committed, so nothing
# of the old layout (the gate's log and tries in /data/work) may change, and /data/gate isn't
# made yet. The link isn't running during the switch, so the gate's view of his DM comes from a
# fresh synthetic cards file here (the link's own file is older than the gate trusts by now):
# his DM, no cards up. The stand-in server sends nothing anywhere.
G="$RUN/root-tmp/smoke-gate"
rm -rf "$G"; mkdir -p -m 0700 "$G"
jq -cn --arg dm "$dm" --argjson at "$(date +%s%3N)" '{written_at: $at, owner: "", dm: $dm, cards: [], sent: []}' > "$G/cards.json"
CAIN_DISCORD_SOCK="$SOCK" CAIN_BROKER_SMOKE=1 SMOKE_LOG="$LOG" CAIN_CARDS="$G/cards.json" CAIN_LINK_SOCK="$G/no-link.sock" \
  CAIN_GATE_LOG="$G/report.jsonl" CAIN_GATE_TRIES="$G/tries.json" CAIN_GATE_DM="$G/dm.json" CAIN_GATE_REPLIED="$G/replied.json" \
  CAIN_DISCORD_SERVER_CMD='["/usr/local/bin/bun","'"$OPT"'/c1/smoke-server.ts"]' \
  bun "$OPT/discord/broker-main.ts" > "$RUN/root-tmp/smoke-broker.log" 2>&1 &
broker=$!
trap 'kill "$broker" 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.2; done
[ -S "$SOCK" ] || { log "its broker didn't start"; exit 1; }
# Its output, a line of JSON per event, goes to a file of root's (the shell opens it): the start
# event says which plugins loaded and from where (c1/seed-loaded.sh). --channels takes a list
# (Claude Code reads every word after it as a channel until the next option), so "--" ends the
# options and the prompt after it is the one positional argument; without it the prompt was read
# as a second channel and claude exited 1 before starting a session.
"$OPT/as-cain" env CAIN_DISCORD_SOCK="$SOCK" CLAUDE_CODE_PLUGIN_SEED_DIR="$OPT/plugin-seed" DISABLE_AUTOUPDATER=1 \
  timeout 240 claude -p --output-format stream-json --verbose --permission-mode auto --channels plugin:discord@claude-plugins-official -- \
  "This is an automated start-up check of your Discord channel, not a message from anyone. Call the Discord reply tool exactly once, with chat_id $dm and the text: ok. Then stop. Do nothing else." \
  > "$G/session.jsonl" 2> "$G/session.err"
code=$?
# claude failing before it starts a session (a bad command line, a missing sign-in) writes no start
# event: say so, with its own words, rather than only that the seed's plugin didn't load.
if [ "$code" -ne 0 ] && ! jq -e 'select(.type == "system" and .subtype == "init")' "$G/session.jsonl" >/dev/null 2>&1; then
  log "claude exited $code before starting a session: $(tail -n 3 "$G/session.err" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
  exit 1
fi
"$OPT/c1/seed-loaded.sh" "$G/session.jsonl" || { log "the seed's plugin didn't load (claude exited $code): $(tail -n 3 "$G/session.err" | tr '\n' ' ' | cut -c1-300)"; exit 1; }
if grep -q '"name":"reply"' "$LOG" 2>/dev/null; then log "passed"; exit 0; fi
log "the stand-in got no reply (claude exited $code): $(tail -n 3 "$G/session.err" | tr '\n' ' ' | cut -c1-300)"
exit 1
