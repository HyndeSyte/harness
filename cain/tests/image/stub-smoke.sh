#!/bin/bash
# In the CI image test, in place of /opt/cain/c1/smoke.sh (which runs a real Claude Code
# session, and CI has no Claude sign-in): the same smoke broker with the stand-in server, the
# real bridge as cain, and fake-claude.ts doing Claude Code's part. With SMOKE_DETACH=1 it
# also leaves a detached process of cain's behind (double-forked, its parent gone), which the
# switch must end; with SMOKE_FAIL=1 it then fails.
set -uo pipefail
OPT=/opt/cain
SOCK=/run/cain/smoke.sock
LOG=/run/cain/root-tmp/smoke.log
G=/run/cain/root-tmp/smoke-gate
rm -f "$LOG"; rm -rf "$G"; mkdir -p -m 0700 "$G"
# As the real smoke test: a fresh synthetic cards file (his DM, no cards), the link not running.
jq -cn --argjson at "$(date +%s%3N)" '{written_at: $at, owner: "", dm: "100000000000000001", cards: [], sent: []}' > "$G/cards.json"
CAIN_DISCORD_SOCK="$SOCK" CAIN_BROKER_SMOKE=1 SMOKE_LOG="$LOG" CAIN_CARDS="$G/cards.json" CAIN_LINK_SOCK="$G/no-link.sock" \
  CAIN_GATE_LOG="$G/report.jsonl" CAIN_GATE_TRIES="$G/tries.json" CAIN_GATE_DM="$G/dm.json" CAIN_GATE_REPLIED="$G/replied.json" \
  CAIN_DISCORD_SERVER_CMD='["/usr/local/bin/bun","'"$OPT"'/c1/smoke-server.ts"]' \
  bun "$OPT/discord/broker-main.ts" > /run/cain/root-tmp/smoke-broker.log 2>&1 &
broker=$!
trap 'kill "$broker" 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.2; done
[ -S "$SOCK" ] || { echo "[c1] smoke: its broker didn't start" >&2; exit 1; }
if [ "${SMOKE_DETACH:-}" = 1 ]; then
  "$OPT/as-cain" bash -c '(setsid sleep 900 </dev/null >/dev/null 2>&1 &) ; exit 0'
fi
bun /t/fake-claude.ts "$SOCK" 100000000000000001 || { echo "[c1] smoke: the fake client's reply didn't go" >&2; exit 1; }
grep -q '"name":"reply"' "$LOG" || { echo "[c1] smoke: the stand-in got no reply" >&2; exit 1; }
[ "${SMOKE_FAIL:-}" = 1 ] && { echo "[c1] smoke: failed on purpose (the test)" >&2; exit 1; }
echo "[c1] smoke: passed" >&2
exit 0
