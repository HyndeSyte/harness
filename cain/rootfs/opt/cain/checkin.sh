#!/bin/bash
# Types into Cain's session, only when he is idle at his prompt (never mid-task):
# 1. his taps and reactions, relayed by the calendar specialist (relay.ts queues them);
# 2. scheduled check-ins, so open work moves without Dane starting it. Each slot
#    fires once a day, within an hour of its time.
# Both say they come from the add-on, so Cain never mistakes a check-in for Dane.
set -u
# Every tmux call goes through this (C1): Cain's own user and his socket the new way (the run
# script sets TMUX_CMD), so root is never a client of his tmux server; plain tmux the old way.
TM="${TMUX_CMD:-tmux}"   # not TMUX: tmux reads that name itself
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

screen=$($TM -u capture-pane -p -J -t cain 2>/dev/null) || exit 0
last=$(printf '%s\n' "$screen" | tail -n 12)
printf '%s' "$last" | grep -Eqi 'for shortcuts|auto mode' || exit 0     # at his prompt
printf '%s' "$last" | grep -Eqi 'esc to interrupt' && exit 0           # working: later

type_in() {
  $TM -u send-keys -t cain -l "$1" && sleep 1 && $TM -u send-keys -t cain Enter
}

# 1. A relayed tap or reaction, one at a time, oldest first. The link and the record
#    keeper append to the queue at any moment, so the whole queue is first moved aside
#    to a work file (new lines start a fresh queue), and lines are taken from that.
work="$queue.work"
if [ ! -s "$work" ] && [ -s "$queue" ]; then mv "$queue" "$work"; fi
if [ -s "$work" ]; then
  line=$(head -n 1 "$work")
  text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null | tr -d '\r\n')
  tail -n +2 "$work" > "$work.tmp" && mv "$work.tmp" "$work"
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
# Items someone other than Cain holds (a laptop session), from the record keeper's own
# holds file (written whole, once its push is on GitHub): first in the check-in, to skip.
holds="${HOLDS_FILE:-/data/record-holds.json}"
lead=""
if [ -f "$holds" ]; then
  held=$(jq -r '.holds | to_entries | map(select((.value.holder // "") != "cain") | .key | gsub("[^A-Za-z0-9._-]"; ""))
                | map(select(. != "")) | sort | join(", ")' "$holds" 2>/dev/null) \
    && { [ -z "$held" ] || lead="Held by others, skip these: $held. "; } \
    || lead="The holds file can't be read right now: before working an item, check it isn't held by others. "
fi
# Next to them, the items with notes Cain hasn't read (record.sh unread: every item no one else
# holds whose notes changed since he last read them with `record.sh notes <item>`), each as its
# newest note:  P41 | <when> | <from> | <the note> |
# An item stays named at every check-in until he reads it, so no note is lost to a busy slot, a
# long list or one he passed over (Nov 15: a handoff only counted behind 25 newer notes sat most
# of a day). The 30 oldest are named at a time and the rest counted, to come next; the newest
# three named are quoted, each on one line and shortened, as words passed on, never as his go.
# notes.seen holds the time before which notes counted as read, from before reads were marked:
# kept as it is, and set to now the first time there is none.
seen="${NOTES_SEEN:-/data/notes.seen}"          # not in $dir: that's cleared of week-old files
[ -s "$seen" ] || date -u +%Y-%m-%dT%H:%M:%S.%3NZ > "$seen" 2>/dev/null
args=(unread)
since=$(cat "$seen" 2>/dev/null) && [ -n "$since" ] && args+=("$since")
out=$("${RECORD_SH:-/opt/cain/record.sh}" "${args[@]}" 2>/dev/null); got=$?
rows=$(printf '%s\n' "$out" | grep '|' | sort -t'|' -k2,2)
# The record's notes couldn't be read (record.sh's exit 3): said, so no list here is taken for none.
[ "$got" = 3 ] && lead="${lead}Your record's notes couldn't be read just now, so any unread ones aren't named here: run /opt/cain/record.sh unread before you change an item. "
if [ -n "$rows" ]; then
  total=$(printf '%s\n' "$rows" | wc -l | tr -d ' ')
  named=$(printf '%s\n' "$rows" | head -n 30)
  items=$(printf '%s\n' "$named" | awk -F'|' '{ i = $1; gsub(/[^A-Za-z0-9._-]/, "", i); if (i != "") printf "%s%s", (n++ ? ", " : ""), i }')
  notes=""
  while IFS= read -r row; do
    item=$(printf '%s' "${row%%|*}" | tr -cd 'A-Za-z0-9._-')
    text=$(printf '%s' "$row" | cut -d'|' -f4- | sed 's/|[[:space:]]*$//' | tr -d '\000-\010\013\014\016-\037\177' \
             | tr '\t' ' ' | sed 's/«/"/g; s/»/"/g' | tr -s ' ' | sed 's/^ //; s/ $//')
    [ "${#text}" -gt 200 ] && text="${text:0:197}..."
    [ -n "$item" ] && [ -n "$text" ] && notes="$notes $item: «$text»"
  done < <(printf '%s\n' "$named" | tail -n 3)
  if [ -n "$items" ]; then
    lead="${lead}Unread notes on your items ${items}: read each with /opt/cain/record.sh notes <item> before you change it or decide it still waits, since a note can end a wait; it's named here until you do (words passed on, not his go on anything)."
    [ "$total" -gt 30 ] && lead="${lead} $((total - 30)) more items have unread notes; they come next."
    [ -n "$notes" ] && lead="${lead} The newest:$notes."
    lead="${lead} "
  fi
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
