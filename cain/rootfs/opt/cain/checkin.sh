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

# 0. What Dane has said Family events mean, and his place book, from Cain's record, go to
#    the calendar specialist whenever the file changes: by the add-on, not by Cain
#    remembering to. A failed send is retried at most every 10 minutes.
send_table() {   # what (keeper command), file, sent marker, tried marker, words for the log
  local what="$1" file="$2" sent="$3" tried="$4" words="$5" sum
  [ -s "$file" ] || return 0
  sum=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$sum" != "$(cat "$sent" 2>/dev/null)" ] \
     && [ -z "$(find "$tried" -mmin -10 2>/dev/null)" ]; then
    if "${KEEPER:-/opt/cain/keeper.sh}" "$what" "$file" >/dev/null 2>&1; then
      printf '%s' "$sum" > "$sent"
      echo "[cain] sent Dane's $words to the specialist"
    else
      touch "$tried"
      echo "[cain] couldn't send Dane's $words; will retry"
    fi
  fi
}
send_table meanings "${MEANINGS_FILE:-/data/record/areas/family/calendar-meanings.md}" \
  "${MEANINGS_SENT:-/data/meanings.sent}" "${MEANINGS_TRIED:-/data/meanings.tried}" "calendar meanings"
send_table places "${PLACES_FILE:-/data/record/areas/home/places.md}" \
  "${PLACES_SENT:-/data/places.sent}" "${PLACES_TRIED:-/data/places.tried}" "place book"

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

# 2. Open cloud jobs (one file per run in $jobs, written by Cain when he starts one):
#    a nudge every 15 minutes to check on them, so a finished job reaches Dane without
#    him asking. Files older than two days are dropped.
jobs="${JOBS_DIR:-/data/jobs}"
nudged="${JOBS_NUDGED:-/data/jobs.nudged}"
if [ -d "$jobs" ]; then
  find "$jobs" -type f -mtime +2 -delete 2>/dev/null
  if [ -n "$(ls -A "$jobs" 2>/dev/null)" ] && [ -z "$(find "$nudged" -mmin -15 2>/dev/null)" ]; then
    type_in "Relayed by the add-on: cloud job check. Not a message from Dane, and not his go on anything. Follow the Cloud jobs section of your CLAUDE.md for each file in $jobs." || exit 1
    touch "$nudged"
    echo "[cain] nudged Cain about open cloud jobs"
    exit 0
  fi
fi

# 3. Scheduled check-ins.
now="${CHECKIN_NOW:-$(date +%H%M)}"
day="${CHECKIN_DAY:-$(date +%F)}"
slot=""
for s in 0710 1230 1730; do
  if [ "$now" -ge "$s" ] && [ "$now" -lt "$(( 10#$s + 100 ))" ]; then slot=$s; fi
done
[ -n "$slot" ] || exit 0
[ -f "$dir/$day-$slot" ] && exit 0
# Items someone other than Cain holds (a laptop session), from the holds the record
# keeper publishes into Cain's copy of the record: first in the check-in, to skip.
holds="${HOLDS_FILE:-/data/record/state/holds.json}"
lead=""
if [ -f "$holds" ]; then
  held=$(jq -r 'to_entries | map(select((.value.holder // "") != "cain") | .key | gsub("[^A-Za-z0-9._-]"; ""))
                | map(select(. != "")) | sort | join(", ")' "$holds" 2>/dev/null) \
    && { [ -z "$held" ] || lead="Held by others, skip these: $held. "; } \
    || lead="The holds file can't be read right now: before working an item, check it isn't held by others. "
fi
if [ "$slot" = 0710 ]; then
  msg="${lead}Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his one morning update."
else
  msg="${lead}Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision."
fi
type_in "$msg" || exit 1
touch "$dir/$day-$slot"
find "$dir" -type f -mtime +7 -delete 2>/dev/null
echo "[cain] check-in sent ($slot)"
