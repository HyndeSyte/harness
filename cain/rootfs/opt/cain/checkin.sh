#!/bin/bash
# Types into Cain's session, only when he is idle at his prompt (never mid-task):
# 1. his taps and reactions, relayed by the calendar specialist (relay.ts queues them);
# 2. scheduled check-ins, so open work moves without Dane starting it. Each slot
#    fires once a day, within an hour of its time.
# Both say they come from the add-on, so Cain never mistakes a check-in for Dane.
set -u
export TZ="${CHECKIN_TZ:-America/New_York}"
dir="${CHECKIN_DIR:-/data/checkins}"
queue="${RELAY_QUEUE:-/data/relay.queue}"
mkdir -p "$dir"

screen=$(tmux -u capture-pane -p -J -t cain 2>/dev/null) || exit 0
last=$(printf '%s\n' "$screen" | tail -n 12)
printf '%s' "$last" | grep -Eqi 'for shortcuts|auto mode' || exit 0     # at his prompt
printf '%s' "$last" | grep -Eqi 'esc to interrupt' && exit 0           # working: later

type_in() {
  tmux -u send-keys -t cain -l "$1" && sleep 1 && tmux -u send-keys -t cain Enter
}

# 1. A relayed tap or reaction, one at a time, oldest first.
if [ -s "$queue" ]; then
  line=$(head -n 1 "$queue")
  text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null | tr -d '\r\n')
  tail -n +2 "$queue" > "$queue.tmp" && mv "$queue.tmp" "$queue"
  if [ -n "$text" ]; then
    type_in "Relayed by the add-on: $text" || exit 1
    echo "[cain] relayed a tap or reaction"
  fi
  exit 0
fi

# 2. Scheduled check-ins.
now="${CHECKIN_NOW:-$(date +%H%M)}"
day="${CHECKIN_DAY:-$(date +%F)}"
slot=""
for s in 0710 1230 1730; do
  if [ "$now" -ge "$s" ] && [ "$now" -lt "$(( 10#$s + 100 ))" ]; then slot=$s; fi
done
[ -n "$slot" ] || exit 0
[ -f "$dir/$day-$slot" ] && exit 0
if [ "$slot" = 0710 ]; then
  msg="Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his one morning update."
else
  msg="Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision."
fi
type_in "$msg" || exit 1
touch "$dir/$day-$slot"
find "$dir" -type f -mtime +7 -delete 2>/dev/null
echo "[cain] check-in sent ($slot)"
