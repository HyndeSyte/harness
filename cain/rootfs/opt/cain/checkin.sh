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
bad="${RELAY_BAD:-/data/relay.bad}"          # relayed records that couldn't be read, kept (never dropped)
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
checked_mark="${SESSION_CHECKED:-/run/cain/session-checked}"
[ -f "$checked_mark" ] || exit 0

read_screen() { timeout 10 $TM -u capture-pane -p -J -t cain 2>/dev/null; }
# Every try the App types starts with its own mark, six random hex digits in brackets, kept with
# the try. A draft is the App's only when its first line (prompt-state.sh's, lower case) starts
# with that try's mark: no other text, however alike, passes (outside review, round 16).
ours() {   # ours <draft's first line> <the try's mark>
  local seen
  seen=$(printf '%s' "$1" | tr -d ' \t')
  [ -n "$2" ] && [ "${seen:0:$(( ${#2} + 2 ))}" = "[$2]" ]
}
# The text as the App types it: as it is, but for control characters, which typing would turn into
# keys (a tab, a line end, an Esc): a tab or line end is a space, any other is left out. Nothing else
# is changed: a long address or code goes as written (outside round 19).
keyless() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037\177' | tr '\t\r\n' '   '; }
# Whether a draft's lines (prompt-state.sh's PROMPT_DRAFT_TEXT, one drawn line a line) are exactly
# the text as his box wraps it at a width of w columns of text (the window's width less 4, as a real
# Claude Code 2.1.317 drew it at 60 and 120): each line the next stretch of the text; between lines,
# the blanks a wrap at a space took, or, where a word too long for a line was cut, nothing, which
# only a full line of plain letters shows. Anything else, and nothing is sent (outside round 19).
whole() {   # whole <lines> <text> <w>
  printf '%s\n' "$1" | WANT="$2" W="$3" awk '
    BEGIN { rest = ENVIRON["WANT"]; w = ENVIRON["W"] + 0; ok = 1 }
    ok && NF {
      if (substr(rest, 1, length($0)) != $0) { ok = 0; next }
      rest = substr(rest, length($0) + 1)
      if (rest ~ /^ /) sub(/^ +/, "", rest)
      else if (rest != "" && !(length($0) == w && $0 !~ /[^\001-\177]/)) ok = 0
    }
    END { exit !(ok && rest ~ /^ *$/) }'
}
# The width his box wraps at: the window as tmux has it now, less 4; 0 when it can't be read.
width() {
  local c
  c=$(timeout 10 $TM -u display -p -t cain '#{pane_width}' 2>/dev/null | tr -cd '0-9')
  [ -n "$c" ] && [ "$c" -gt 4 ] && echo $((c - 4)) || echo 0
}
screen=$(read_screen) || { rm -f "$state/ready"; exit 0; }
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
  typed_at=$(head -n 1 "$state/typed" 2>/dev/null | tr -cd '0-9')
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
      # Only a draft that starts with the try's own mark (on his box's own prompt line) is the App's
      # to take out; anyone else's is left be, and the try taken as gone (outside rounds 15, 16).
      if ! ours "$(printf '%s\n' "$screen" | PROMPT_DRAFT_LINE=1 "$PS" 2>/dev/null | sed -n 2p)" \
                "$(sed -n 2p "$state/typed" 2>/dev/null)"; then
        rm -f "$state/typed"
        echo "[cain] a draft in his input box isn't the App's try: left as it is"
        exit 0
      fi
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
# His prompt, empty, and steady: read so now and at a run 3 to 30 seconds before, in this same
# session (the mark newer than the run script's check of it), so a question Claude Code opens as a
# turn ends has time to show before anything is typed. Read afresh after every delivery and every
# failed read (outside review, round 15).
if [ "$at" != ready ] || printf '%s' "$last" | grep -Eqi 'esc to interrupt'; then   # working: later
  rm -f "$state/ready"
  exit 0
fi
now_s=$(date +%s)
ready_at=$(head -n 1 "$state/ready" 2>/dev/null | tr -cd '0-9')
if [ -n "$ready_at" ] && [ "$state/ready" -nt "$checked_mark" ] && [ $((now_s - ready_at)) -le 30 ]; then
  [ $((now_s - ready_at)) -ge "${CHECKIN_STEADY_S:-3}" ] || exit 0
elif printf '%s\n' "$now_s" > "$state/ready" 2>/dev/null; then
  exit 0
fi

# Typed, then the screen read again: Enter only while his input area is still there, holding
# what was typed (prompt-state.sh: draft), with no question opened since (Cain's third service
# review). Otherwise no Enter, and 1: the caller keeps what it typed for later. The try stays
# marked until a later read shows his box empty, so one that turns up late, or sits under a
# question, is taken back out before anything new is typed (above).
type_in() {
  local mark
  mark=$(od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -cd '0-9a-f')
  [ "${#mark}" = 6 ] || { echo "[cain] no random mark for a try: nothing typed"; return 1; }
  printf '%s\n%s\n' "$(date +%s)" "$mark" > "$state/typed" 2>/dev/null \
    || { echo "[cain] no place to mark a try ($state): nothing typed"; return 1; }
  local want
  want=$(keyless "[$mark] $1")
  if ! timeout 10 $TM -u send-keys -t cain -l "$want"; then return 1; fi
  sleep 1
  # All of it, mark first, as his box holds it: read up to three times a second apart while it
  # draws (his box still empty, or holding only part of it), never past a question or anything else.
  local after word got i wide
  for i in 1 2 3; do
    after=$(read_screen | PROMPT_DRAFT_TEXT=1 "$PS" 2>/dev/null); wide=$(width)
    word="${after%%$'\n'*}"; got=$(printf '%s\n' "$after" | sed 1d)
    [ "$word" = draft ] && whole "$got" "$want" "$wide" && break
    [ "$word" = ready ] || { [ "$word" = draft ] && [ "${got:0:8}" = "[$mark]" ]; } || break
    [ "$i" = 3 ] || sleep 1
  done
  rm -f "$state/ready"
  if [ "$word" != draft ] || ! whole "$got" "$want" "$wide"; then
    echo "[cain] his input box didn't hold all that was typed (${word:-unread}): nothing sent, tried again later"
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
  # Read whole: a JSON object whose text is a string, its text as written (line ends kept for
  # keyless to make spaces; outside round 20). One that can't be read is set aside, kept in $bad,
  # and Cain hears at the next check-in; it leaves the queue only once it's kept there.
  if ! text=$(printf '%s' "$line" | jq -j 'if type == "object" and (.text | type) == "string" then .text else error("not a relayed record") end' 2>/dev/null); then
    if ! printf '%s\n' "$line" >> "$bad" 2>/dev/null; then
      echo "[cain] a relayed record couldn't be read, nor set aside ($bad): it stays first"
      exit 1
    fi
    echo 1 >> "$state/unread" 2>/dev/null
    echo "[cain] a relayed record couldn't be read: set aside in $bad, and Cain hears at the next check-in"
    tail -n +2 "$work" > "$work.tmp" && mv "$work.tmp" "$work"
    exit 0
  fi
  if [ -n "$text" ] && ! type_in "Relayed by the add-on: $text"; then
    sum=$(printf '%s' "$line" | cksum | cut -d' ' -f1)
    tries=$(awk -v s="$sum" '$1 == s { print $2 }' "$state/tries" 2>/dev/null)
    tries=$(( ${tries:-0} + 1 ))
    if [ "$tries" -lt 3 ]; then
      printf '%s %s\n' "$sum" "$tries" > "$state/tries"
      exit 1
    fi
    if ! printf '%s\n' "$line" >> "$queue"; then
      echo "[cain] a relayed line couldn't be typed three times running, nor put after the newer ones: it stays first"
      exit 1
    fi
    rm -f "$state/tries"
    echo "[cain] a relayed line couldn't be confirmed in his box three times running: it goes after the newer ones"
    echo 1 >> "$state/unconfirmed" 2>/dev/null
  else
    rm -f "$state/tries"
    if [ -n "$text" ]; then echo "[cain] relayed a tap or reaction"; else echo "[cain] a relayed record with no text: nothing to type"; fi
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
# Every slot in the day before this one that never went in within its hour (no mark of it sent,
# none of it named yet): named in this one, each once, so a missed check-in is never silent
# (outside review, round 15). Only slots after the first check-in this App sent count, so a first
# start names none.
first=$(ls "$dir" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$' | sort | head -n 1)
yday=$(date -d "$day -1 day" +%F 2>/dev/null) || yday=""
missed=""; named=()
for cand in "$yday-0710" "$yday-1230" "$yday-1730" "$day-0710" "$day-1230" "$day-1730"; do
  [ -n "$yday" ] && [ -n "$first" ] || break
  [[ "$cand" > "$yday-$slot" && "$cand" < "$day-$slot" && "$cand" > "$first" ]] || continue
  [ -f "$dir/$cand" ] || [ -f "$dir/$cand.missed" ] && continue
  case "${cand##*-}" in 0710) when="7:10 AM" ;; 1230) when="12:30 PM" ;; *) when="5:30 PM" ;; esac
  [ "${cand%-*}" = "$day" ] && when="today at $when" || when="yesterday at $when"
  missed="${missed:+$missed, }$when"; named+=("$cand")
done
[ -z "$missed" ] || missed="Check-ins that didn't reach you (your screen wasn't at your prompt within their hour): $missed. "
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
# Relayed lines waiting because their typing couldn't be confirmed in his box: said, so none waits
# unknown to him (outside round 19).
held_back=$(wc -l < "$state/unconfirmed" 2>/dev/null | tr -cd '0-9')
[ "${held_back:-0}" -gt 0 ] && lead="${lead}Relayed lines the App couldn't confirm in your input box when it typed them: ${held_back}. Each waits in its queue behind newer ones and comes again. "
unread=$(wc -l < "$state/unread" 2>/dev/null | tr -cd '0-9')
[ "${unread:-0}" -gt 0 ] && lead="${lead}Relayed records the App couldn't read: ${unread}, set aside unread in its own files. A tap or reaction of his may be among them: if he mentions one you never heard of, that's why. "
if [ "$slot" = 0710 ]; then
  msg="${lead}${missed}Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his one morning update."
else
  msg="${lead}${missed}Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision."
fi
type_in "$msg" || exit 1
touch "$dir/$day-$slot"
for cand in "${named[@]}"; do touch "$dir/$cand.missed"; done
[ "${held_back:-0}" -gt 0 ] && rm -f "$state/unconfirmed"
[ "${unread:-0}" -gt 0 ] && rm -f "$state/unread"
[ -n "$newest" ] && printf '%s' "$newest" > "$seen"      # listed: never again
find "$dir" -type f -mtime +7 -delete 2>/dev/null
echo "[cain] check-in sent ($slot)"
