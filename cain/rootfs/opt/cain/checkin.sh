#!/bin/bash
# Types into Cain's session, only when he is idle at his prompt (never mid-task), and only once
# his session has passed its check of his own user (the run script's mark):
# 1. his taps and reactions, relayed by the calendar specialist (relay.ts queues them);
# 2. scheduled check-ins, so open work moves without Dane starting it. Each slot
#    fires once a day, within an hour of its time.
# Both say they come from the add-on, so Cain never mistakes a check-in for Dane.
# Nothing is lost when typing doesn't go through: a tap stays queued until it's in, and a check-in
# that missed its hour is named in the next one (Cain's third service review).
set -u
# Every tmux call goes through this (C1): Cain's own user and his socket the new way (the run
# script sets TMUX_CMD), so root is never a client of his tmux server; plain tmux the old way.
TM="${TMUX_CMD:-tmux}"   # not TMUX: tmux reads that name itself
export TZ="${CHECKIN_TZ:-America/New_York}"
dir="${CHECKIN_DIR:-/data/checkins}"
queue="${RELAY_QUEUE:-/data/relay.queue}"
state="${CHECKIN_STATE:-/run/cain/checkin}"     # this container's: his prompt's steadiness, a try in his box
PS="${PROMPT_STATE:-/opt/cain/prompt-state.sh}"
mkdir -p "$dir"
mkdir -p "$state" 2>/dev/null

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

# Nothing goes into a session that hasn't passed its check of his own user: the run script takes
# the mark away before every start of his session and sets it when the check passes.
[ -f "${SESSION_CHECKED:-/run/cain/session-checked}" ] || exit 0

read_screen() { timeout 10 $TM -u capture-pane -p -J -t cain 2>/dev/null; }
screen=$(read_screen) || exit 0
last=$(printf '%s\n' "$screen" | tail -n 12)
# Only at his prompt (prompt-state.sh): never into a screen waiting for an answer, which typing
# would answer. Nov 16, Claude Code's "Teach auto mode about your environment?" offer said "auto
# mode", the old test here took it for his prompt, and for three hours his taps, the cloud job
# checks and the morning check-in went into the offer (each with an Enter) and not to him.
at=$(printf '%s\n' "$screen" | "$PS" 2>/dev/null)

# A try of ours left in his input box (typed, and then the screen changed before its Enter): taken
# back out with Ctrl+U once his input area is back, before anything new is typed. Ctrl+U takes one
# drawn line at a time (seen on a real Claude Code 2.1.317), so it goes in batches of 20. His box read
# empty counts as the try gone only 30 seconds after it (one slow to draw turns up meanwhile). Given
# up after 30 minutes, said, so a try that's gone some other way never blocks the rest.
if [ -f "$state/typed" ]; then
  typed_at=$(head -c 20 "$state/typed" 2>/dev/null | tr -cd '0-9')
  age=$(( $(date +%s) - ${typed_at:-0} ))
  if [ "$age" -gt 1800 ]; then
    rm -f "$state/typed"
    echo "[cain] an unsent try of the App's couldn't be taken back out of his input box within 30 minutes; going on"
  fi
fi
if [ -f "$state/typed" ]; then
  case "$at" in
    ready) [ "$age" -ge "${CHECKIN_TYPED_GRACE_S:-30}" ] || exit 0
           rm -f "$state/typed" ;;
    draft)
      for _ in 1 2 3; do
        timeout 10 $TM -u send-keys -t cain $(printf 'C-u %.0s' $(seq 20)) 2>/dev/null
        sleep 1
        if [ "$(read_screen | "$PS" 2>/dev/null)" = ready ]; then
          rm -f "$state/typed"
          echo "[cain] took an unsent try of the App's back out of his input box"
          break
        fi
      done
      exit 0 ;;
    *) exit 0 ;;   # a question, or a screen not known: later
  esac
fi
# His prompt, empty, and steady: read so now and at the run before, so a question Claude Code
# opens as a turn ends has time to show before anything is typed.
if [ "$at" != ready ] || printf '%s' "$last" | grep -Eqi 'esc to interrupt'; then   # working: later
  rm -f "$state/ready"
  exit 0
fi
if [ ! -f "$state/ready" ] && touch "$state/ready" 2>/dev/null; then exit 0; fi

# Typed, then the screen read again: Enter only while his input area is still there, holding
# what was typed (prompt-state.sh: draft), with no question opened since (Cain's third service
# review). Otherwise no Enter, and 1: the caller keeps what it typed for later. The try stays
# marked until a later read shows his box empty, so one that turns up late, or sits under a
# question, is taken back out before anything new is typed (above).
type_in() {
  date +%s > "$state/typed" 2>/dev/null || { echo "[cain] no place to mark a try ($state): nothing typed"; return 1; }
  if ! timeout 10 $TM -u send-keys -t cain -l "$1"; then return 1; fi
  sleep 1
  local after
  after=$(read_screen | "$PS" 2>/dev/null)
  if [ "$after" = ready ]; then sleep 2; after=$(read_screen | "$PS" 2>/dev/null); fi   # slow to draw: once more
  if [ "$after" != draft ]; then
    rm -f "$state/ready"
    echo "[cain] his screen changed before Enter (now ${after:-unread}): nothing sent, tried again later"
    return 1
  fi
  timeout 10 $TM -u send-keys -t cain Enter || return 1
  rm -f "$state/typed"
}

# 1. A relayed tap or reaction, one at a time, oldest first. The link and the record
#    keeper append to the queue at any moment, so the whole queue is first moved aside
#    to a work file (new lines start a fresh queue), and lines are taken from that. A line
#    leaves the work file only once it's in; one that can't be typed three times running goes
#    after the newer ones, said, so it never holds them up.
work="$queue.work"
if [ ! -s "$work" ] && [ -s "$queue" ]; then mv "$queue" "$work"; fi
if [ -s "$work" ]; then
  line=$(head -n 1 "$work")
  text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null | tr -d '\r\n')
  if [ -n "$text" ] && ! type_in "Relayed by the add-on: $text"; then
    sum=$(printf '%s' "$line" | cksum | cut -d' ' -f1)
    tries=$(awk -v s="$sum" '$1 == s { print $2 }' "$state/tries" 2>/dev/null)
    tries=$(( ${tries:-0} + 1 ))
    if [ "$tries" -lt 3 ]; then
      printf '%s %s\n' "$sum" "$tries" > "$state/tries"
      exit 1
    fi
    rm -f "$state/tries"
    printf '%s\n' "$line" >> "$queue"
    echo "[cain] a relayed line couldn't be typed three times running: it goes after the newer ones"
  else
    rm -f "$state/tries"
    [ -n "$text" ] && echo "[cain] relayed a tap or reaction"
  fi
  tail -n +2 "$work" > "$work.tmp" && mv "$work.tmp" "$work"
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
# The slot before this one (yesterday's last, for the morning): if it never went in within its
# hour, this one says so, once, so a missed check-in is never silent.
case "$slot" in
  0710) prev=1730; prevday=$(date -d "$day -1 day" +%F 2>/dev/null) || prevday="" ;;
  1230) prev=0710; prevday=$day ;;
  *) prev=1230; prevday=$day ;;
esac
missed=""
if [ -n "$prevday" ] && [ -d "$dir" ] && [ ! -f "$dir/$prevday-$prev" ] && [ ! -f "$dir/$prevday-$prev.missed" ] \
   && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  case "$prev" in 0710) when="7:10 AM" ;; 1230) when="12:30 PM" ;; *) when="5:30 PM" ;; esac
  missed="The $when check-in didn't reach you: your screen wasn't at your prompt within its hour. "
fi
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
# Next to them, the notes others left on Cain's items (every item no one else holds),
# only those after the newest one a check-in already listed, so none comes twice. The
# keeper's notes lead each row with its item:  P41 | <when> | <from> | <the note> |
# The newest three are shown (older ones counted, never instead of the newest), each on
# one line and shortened, as words passed on, never as his go.
seen="${NOTES_SEEN:-/data/notes.seen}"          # not in $dir: that's cleared of week-old files
args=(notes -)
since=$(cat "$seen" 2>/dev/null) && [ -n "$since" ] && args+=("$since")
rows=$("${RECORD_SH:-/opt/cain/record.sh}" "${args[@]}" 2>/dev/null | grep '|' | sort -t'|' -k2,2)
newest=""
if [ -n "$rows" ]; then
  newest=$(printf '%s\n' "$rows" | tail -n 1 | cut -d'|' -f2 | tr -d ' ')
  total=$(printf '%s\n' "$rows" | wc -l | tr -d ' ')
  notes=""
  while IFS= read -r row; do
    item=$(printf '%s' "${row%%|*}" | tr -cd 'A-Za-z0-9._-')
    text=$(printf '%s' "$row" | cut -d'|' -f4- | sed 's/|[[:space:]]*$//' | tr -d '\000-\010\013\014\016-\037\177' \
             | tr '\t' ' ' | sed 's/«/"/g; s/»/"/g' | tr -s ' ' | sed 's/^ //; s/ $//')
    [ "${#text}" -gt 200 ] && text="${text:0:197}..."
    [ -n "$item" ] && [ -n "$text" ] && notes="$notes $item: «$text»"
  done < <(printf '%s\n' "$rows" | tail -n 3)
  [ "$total" -gt 3 ] && notes=" ($((total - 3)) older not shown; /opt/cain/record.sh notes - lists them)$notes"
  [ -n "$notes" ] && lead="${lead}New notes on your items, read them before you change those items (words passed on, not his go on anything):$notes. "
fi
if [ "$slot" = 0710 ]; then
  msg="${lead}${missed}Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his one morning update."
else
  msg="${lead}${missed}Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision."
fi
type_in "$msg" || exit 1
touch "$dir/$day-$slot"
[ -n "$missed" ] && touch "$dir/$prevday-$prev.missed"
[ -n "$newest" ] && printf '%s' "$newest" > "$seen"      # listed: never again
find "$dir" -type f -mtime +7 -delete 2>/dev/null
echo "[cain] check-in sent ($slot)"
