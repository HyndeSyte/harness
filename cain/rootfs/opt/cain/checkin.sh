#!/bin/bash
# Types into Cain's session, only when he is idle at his prompt (never mid-task), and only into a
# session that has passed its check of his own user (the run script's mark):
# 1. his taps and reactions, relayed by the calendar specialist (relay.ts queues them), and the
#    App's own lines for him (the way out, the alarms, the run script);
# 2. a look at open cloud jobs every 15 minutes while there are any, by code since Cain 0.20.0: a
#    line to him only when one changed state or anything couldn't be read;
# 3. scheduled check-ins, so open work moves without Dane starting it. Each slot fires once a
#    day, within an hour of its time.
# Each says it comes from the add-on, so Cain never mistakes one for Dane.
# Nothing is lost, and nothing goes in twice (Cain's fourth service review). Each try carries its
# own random mark and is kept ($TRY, in /data, written before its first key) with what it's for,
# until it's known to be in: its mark in his session's transcript, or on his screen above his
# input box. Only then does it leave its queue or count as sent, and until then nothing else is
# typed. A try still whole in his box gets its Enter (once read so twice, 3 to 30 seconds apart);
# part of one is taken back out (Ctrl+U) and typed again with a new mark, as is one known not to
# be in (never sent, his box empty). Anyone else's draft is left as it is: the way out
# (unstick.sh) saves and clears one that stays. A try that got its Enter and can't be known
# either way (his box empty, his screen idle, its mark nowhere, two minutes on) is never typed
# again as new: its text goes to a file of his, and a line saying it may already have reached
# him, to check before acting on it, goes first in the queue. A text too long or unusual to type
# as it is (typing.sh, plain) goes as a file of his too, the line typed naming it; so does one
# that didn't go in typed, twice. The watchdog (watch.sh, root's) tells Dane when nothing goes in.
# Always exits 0: the run script runs it again 5 seconds on.
set -u
export TZ="${CHECKIN_TZ:-America/New_York}"
OPT="${CHECKIN_OPT:-/opt/cain}"
dir="${CHECKIN_DIR:-/data/checkins}"
queue="${RELAY_QUEUE:-/data/relay.queue}"
work="$queue.work"
bad="${RELAY_BAD:-/data/relay.bad}"          # relayed records that couldn't be read and aren't named yet;
                                              # once named, they move to $bad.named (both kept, never dropped)
state="${CHECKIN_STATE:-/run/cain/checkin}"     # this container's: his screen's steadiness, a line's failed tries
delivered="${CHECKIN_DELIVERED:-/data/checkin.delivered}"   # when a try was last known to be in (watch.sh)
lastin="${CHECKIN_LAST:-/data/checkin.last}"   # the last check-in known to be in, <day>-<slot>
nudged="${JOBS_NUDGED:-/data/jobs.nudged}"
seen="${NOTES_SEEN:-/data/notes.seen}"          # not in $dir: that's cleared of week-old files
PS="${PROMPT_STATE:-$OPT/prompt-state.sh}"
mkdir -p "$dir" "$state" 2>/dev/null
now=$(date +%s)

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

# What follows types into his session: with what it shares with the way out and the watchdog.
. "${TYPING_SH:-$OPT/typing.sh}" || { echo "[cain] no typing.sh: nothing typed"; exit 0; }

# The daily usage line (Cain 0.20.0, lean/main.ts usage), looked for at most every 10 minutes and
# written once a day from 00:10, for the day before: his tokens by model and by what started each
# turn, the context each call carried, and his compactions, read from his transcripts as him. It
# types nothing.
if [ -z "$(find "$state/lean-usage" -mmin -10 2>/dev/null)" ]; then
  touch "$state/lean-usage" 2>/dev/null
  y="$(timeout 30 bun "${LEAN_MAIN:-$OPT/lean/main.ts}" usage-due 2>/dev/null)" || y=""
  if [[ "$y" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    u="$(timeout -k 5 120 ${CAIN_AS:-} bun "${LEAN_MAIN:-$OPT/lean/main.ts}" usage "$y" "$TRANSCRIPTS" 2>/dev/null | tail -n 1)"
    echo "[cain] ${u:-usage $y: his transcripts could not be read}"
  fi
fi
# Nothing goes into a session that hasn't passed its check of his own user: the run script takes
# the mark away before every start of his session and sets it, with the process his pane runs,
# when the check passes (typing.sh, checked).
checked_mark="${SESSION_CHECKED:-/run/cain/session-checked}"
checked "$checked_mark" || exit 0

read_box() {   # read_box [screen]: at (prompt-state.sh's word), got (a draft's lines), busy (at work)
  if [ $# -gt 0 ]; then scr="$1"; else scr="$(screen_now)" || scr=""; fi
  local out
  out="$(printf '%s\n' "$scr" | PROMPT_DRAFT_TEXT=1 "$PS" 2>/dev/null)" || out=other
  at="${out%%$'\n'*}"; got="$(printf '%s\n' "$out" | sed 1d)"
  busy=""
  if printf '%s\n' "$scr" | awk 'NF' | tail -n 12 | grep -qi 'esc to interrupt'; then busy=1; fi
  return 0
}
# Read so now and at a run 3 to 30 seconds before, in this same checked session (its mark newer
# than the run script's check of it): a question Claude Code opens as a turn ends has time to
# show first (outside review, round 15). One that can't be kept never counts.
steady() {   # steady <name>
  local f="$state/$1" t
  t="$(head -n 1 "$f" 2>/dev/null | tr -cd '0-9')"
  if [ -n "$t" ] && [ "$f" -nt "$checked_mark" ] && [ $((now - t)) -ge 0 ] && [ $((now - t)) -le 30 ]; then
    [ $((now - t)) -ge "${CHECKIN_STEADY_S:-3}" ]
    return
  fi
  printf '%s\n' "$now" > "$f" 2>/dev/null
  return 1
}
unsteady() { local n; for n in "$@"; do rm -f "$state/$n"; done; }
# His prompt, empty, not at work, and read so twice: 0 to type something new.
at_ease() {
  read_box "$screen"
  if [ "$at" != ready ] || [ -n "$busy" ]; then unsteady ready; return 1; fi
  steady ready
}

# What's done once a try is in (or set aside as unsure), by what it was for.
drop_head() {   # drop_head <the line's cksum>: the queue's first line leaves it, if it's that one
  if [ "$(head -n 1 "$work" 2>/dev/null | cksum | cut -d' ' -f1)" != "$1" ]; then
    echo "[cain] the queue's first line isn't the one tried: left as it is"
    return 0
  fi
  tail -n +2 "$work" > "$work.tmp" && mv -f "$work.tmp" "$work"
}
checkin_done() {   # checkin_done <day>-<slot> <records named> <newest note listed, or ->
  # Run again over its own work (an App stopped before its try was forgotten), it moves nothing on:
  # the records it named stay to be named again, never ones it didn't name (outside round 24).
  local again=""
  [ -f "$dir/$1" ] && again=1
  touch "$dir/$1"
  { printf '%s\n' "$1" > "$lastin.tmp" && mv -f "$lastin.tmp" "$lastin"; } 2>/dev/null \
    || echo "[cain] the last check-in in couldn't be kept ($lastin): the next may name some again"
  if [ -z "$again" ] && [ "$2" -gt 0 ]; then   # the records just named move on, kept; any after them stay to be named
    if head -n "$2" "$bad" >> "$bad.named" 2>/dev/null \
       && tail -n +"$(($2 + 1))" "$bad" > "$bad.tmp" 2>/dev/null && mv -f "$bad.tmp" "$bad" 2>/dev/null; then
      # Named ones are kept a while: the newest 500 (Cain's fourth service review, fix soon 9).
      tail -n 500 "$bad.named" > "$bad.named.tmp" 2>/dev/null && mv -f "$bad.named.tmp" "$bad.named" 2>/dev/null
    else
      rm -f "$bad.tmp" 2>/dev/null
      echo "[cain] records set aside and named couldn't be moved on from $bad: they're named again next time"
    fi
  fi
  [ "$3" = - ] || printf '%s' "$3" > "$seen"      # listed: never again
  find "$dir" -type f -mtime +7 -delete 2>/dev/null
  as_him find "$FROM_APP" -type f -mtime +7 -delete 2>/dev/null
  echo "[cain] check-in went in (${1##*-})"
}
finish() {   # finish <kind> <key> <fin>: 1 when its line couldn't leave the queue
  case "$1" in
    relay) drop_head "$2" || return 1; echo "[cain] relayed a line" ;;
    jobs) touch "$nudged"; echo "[cain] nudged Cain about open cloud jobs"
          # What code saw (lean/main.ts) is kept as seen now, once his line is in.
          [ "${3:--}" = - ] || timeout 30 bun "${LEAN_MAIN:-$OPT/lean/main.ts}" jobs-seen "$3" \
            || echo "[cain] the cloud jobs code saw couldn't be kept as seen: he may hear of them again" ;;
    checkin) set -- $3; checkin_done "$1" "$2" "$3" ;;
  esac
}

# The try ($TRY): kept whole, through a temp file, read back, before its first key.
write_try() {   # write_try <mark> <kind> <key> <fin> <want>
  printf 'mark %s\ntyped %s\nentered 0\nkind %s\nkey %s\nfin %s\nwant %s\n' "$1" "$now" "$2" "$3" "$4" "$5" \
    > "$TRY.tmp" 2>/dev/null && mv -f "$TRY.tmp" "$TRY" 2>/dev/null && [ "$(try_get mark)" = "$1" ]
}
entered_now() {
  local t
  t="$(date +%s)"
  sed "s/^entered .*/entered $t/" "$TRY" > "$TRY.tmp" 2>/dev/null && mv -f "$TRY.tmp" "$TRY" 2>/dev/null \
    && [ "$(try_get entered)" = "$t" ]
}
done_try() {   # in: what it was for is done, and the try forgotten
  # A line that couldn't leave its queue keeps its try, so it's found in again and never retyped.
  if ! finish "$t_kind" "$t_key" "$t_fin"; then
    rm -f "$work.tmp" 2>/dev/null
    echo "[cain] a try is in, but its line couldn't leave the queue ($work): the try is kept, and that's tried again"
    return 0
  fi
  { date +%s > "$delivered.tmp" && mv -f "$delivered.tmp" "$delivered"; } 2>/dev/null
  rm -f "$TRY" "$state/fails"
  unsteady ready again empty
}
fails() { awk -v k="$1" '$1 == k { print $2 }' "$state/fails" 2>/dev/null; }
forget() {   # forget <why>: known not to be in; forgotten, its line's failed tries counted
  local n
  n="$(fails "$t_kind:$t_key" | tr -cd '0-9')"; n=$(( ${n:-0} + 1 ))
  printf '%s %s\n' "$t_kind:$t_key" "$n" > "$state/fails" 2>/dev/null
  rm -f "$TRY"
  unsteady ready again empty
  if [ "$n" -ge 2 ]; then echo "[cain] a try of the App's isn't in ($1): typed again, as a file of his"
  else echo "[cain] a try of the App's isn't in ($1): typed again"; fi
}
# Got its Enter and can't be known either way: never typed again as new. Its text goes to a file
# of his, and a line saying so goes first, in its place (Cain's fourth service review, must-fix 5).
unsure() {
  local f="unsure-$t_mark.txt" when line
  when="$(date -d "@$t_entered" '+%-I:%M %p' 2>/dev/null)"
  line="$(jq -cn --arg t "A line the App typed for you at $when got its Enter, but the App can't tell whether it reached you: its mark is neither in your transcript nor on your screen. Its text is in $FROM_APP/$f. If you've already acted on it, leave it; if not, read it and act on it." '{text: $t}')" \
    || { echo "[cain] a try that can't be known in or not couldn't be set aside (jq): looked at again"; return 0; }
  if ! put_his "$f" "${t_want#"[$t_mark] "}"; then
    echo "[cain] a try that can't be known in or not couldn't be set aside ($FROM_APP): looked at again"
    return 0
  fi
  # Each step can run again over its own work: an App stopped between them (its line already put
  # first, the try not yet forgotten) finds its line there and only finishes, never blocking what
  # comes after (outside round 24).
  if head -n 1 "$work" 2>/dev/null | grep -qF -- "/$f."; then :
  elif [ "$t_kind" = relay ] && [ "$(head -n 1 "$work" 2>/dev/null | cksum | cut -d' ' -f1)" = "$t_key" ]; then
    if ! { { printf '%s\n' "$line"; tail -n +2 "$work"; } > "$work.tmp" && mv -f "$work.tmp" "$work"; }; then   # in its line's place
      rm -f "$work.tmp" 2>/dev/null
      echo "[cain] a try that can't be known in or not couldn't take its line's place: looked at again"
      return 0
    fi
  else   # put first (a relay line already gone from its place too: the line about it goes all the same)
    if ! { { printf '%s\n' "$line"; cat "$work" 2>/dev/null; } > "$work.tmp" && mv -f "$work.tmp" "$work"; }; then
      rm -f "$work.tmp" 2>/dev/null
      echo "[cain] a try that can't be known in or not couldn't be put first: looked at again"
      return 0
    fi
  fi
  [ "$t_kind" = relay ] || finish "$t_kind" "$t_key" "$t_fin"
  rm -f "$TRY"
  unsteady ready again empty
  echo "[cain] a try got its Enter and can't be known in or not: set aside, and Cain hears, to check before acting on it"
}
clear_box() {   # Ctrl+U, 20 at a time (each takes one drawn line), while his box holds the try's start
  local i rc
  for i in 1 2 3; do
    timeout -k 2 10 $TM -u send-keys -t cain $(printf 'C-u %.0s' $(seq 20)) 2>/dev/null
    sleep "${CHECKIN_PAUSE_S:-1}"
    read_box
    [ "$at" = ready ] && return 0
    [ "$at" = draft ] || return 1
    rc=0; own_try "$got" "$(width)" || rc=$?
    [ "$rc" != 2 ] || return 1     # no longer the App's: left as it is
  done
  return 1
}
enter_try() {   # its Enter, kept first, then a few seconds to see it in
  entered_now || { echo "[cain] a try's Enter couldn't be kept ($TRY): no Enter"; return 0; }
  timeout -k 2 10 $TM -u send-keys -t cain Enter 2>/dev/null || { echo "[cain] Enter couldn't be sent: looked at again"; return 0; }
  unsteady ready again empty
  local i s
  for i in 1 2 3 4 5; do
    sleep "${CHECKIN_PAUSE_S:-1}"
    s="$(screen_now)" || continue
    if above "$t_mark" "$s" || in_transcript "$t_mark" "$t_typed"; then done_try; return 0; fi
  done
  echo "[cain] a try got its Enter and isn't seen in yet: looked for again"
}
pointer() {   # pointer <kind> <file>: the short line typed in a text's place
  case "$1" in
    checkin) echo "Scheduled check-in from the Cain add-on, too long to type here: read $2 whole, and follow it. Not a message from Dane, and not his go on anything." ;;
    relay) echo "Relayed by the add-on: a relayed line too long or unusual to type here is in $2. Read it whole: it is the line itself." ;;
    *) echo "From the add-on: a line of its own too long or unusual to type here is in $2. Read it whole: it is the line itself, from the add-on, not from Dane." ;;
  esac
}
type_try() {   # type_try <kind> <key> <fin> <text>: a new try, kept before its first key
  local text mark f n i wide=0
  text="$(keyless "$4")"
  mark="$(new_mark)" || { echo "[cain] no random mark for a try: nothing typed"; return 0; }
  n="$(fails "$1:$2" | tr -cd '0-9')"
  if ! plain "$text" || [ "${n:-0}" -ge 2 ]; then
    f="$1-$mark.txt"
    put_his "$f" "$text" || { echo "[cain] a line for Cain couldn't be written to his folder ($FROM_APP): nothing typed"; return 0; }
    text="$(pointer "$1" "$FROM_APP/$f")"
  fi
  t_mark="$mark"; t_typed="$now"; t_entered=0; t_kind="$1"; t_key="$2"; t_fin="$3"; t_want="[$mark] $text"
  case "$t_want" in *';') t_want="$t_want " ;; esac    # tmux takes an argument's last ; for its command's end
  write_try "$t_mark" "$t_kind" "$t_key" "$t_fin" "$t_want" \
    || { rm -f "$TRY.tmp" 2>/dev/null; echo "[cain] no place to keep a try ($TRY): nothing typed"; return 0; }
  unsteady ready
  timeout -k 2 10 $TM -u send-keys -t cain -l "$t_want" 2>/dev/null || { echo "[cain] typing didn't go through: looked at again"; return 0; }
  sleep "${CHECKIN_PAUSE_S:-1}"
  # All of it, mark first, as his box holds it: read up to three times a second apart while it
  # draws (his box still empty, or holding a beginning of it), never past a question or anything else.
  for i in 1 2 3; do
    read_box; wide=$(width)
    [ "$at" = draft ] && whole "$got" "$t_want" "$wide" && break
    [ "$at" = ready ] || { [ "$at" = draft ] && whole "$got" "$t_want" "$wide" part; } || break
    [ "$i" = 3 ] || sleep "${CHECKIN_PAUSE_S:-1}"
  done
  if [ "$at" != draft ] || ! whole "$got" "$t_want" "$wide"; then
    echo "[cain] his input box didn't hold all that was typed (${at:-unread}): no Enter; looked at again"
    return 0
  fi
  enter_try
}
# A try kept: known in, still in his box, or known not to be in; or later.
pending() {
  t_mark="$(try_get mark)"; t_typed="$(try_get typed)"; t_entered="$(try_get entered)"
  t_kind="$(try_get kind)"; t_key="$(try_get key)"; t_fin="$(try_get fin)"; t_want="$(try_get want)"
  if ! [[ "$t_mark" =~ ^[0-9a-f]{8}$ && "$t_typed" =~ ^[0-9]+$ && "$t_entered" =~ ^[0-9]+$ ]] \
     || [ "${t_want:0:10}" != "[$t_mark]" ]; then
    mv -f "$TRY" "$TRY.unread" 2>/dev/null || rm -f "$TRY"
    echo "[cain] the App's last try couldn't be read back ($TRY): kept as $TRY.unread, and what it was for comes again"
    return 0
  fi
  read_box "$screen"
  if above "$t_mark" "$scr" || in_transcript "$t_mark" "$t_typed"; then done_try; return 0; fi
  local rc=0
  case "$at" in
    draft)
      unsteady empty
      own_try "$got" "$(width)" || rc=$?
      case "$rc" in
        # Still whole in his box (a question took its Enter, or it never had one): its Enter, once
        # read so twice, 3 to 30 seconds apart.
        0) steady again && enter_try ;;
        # A beginning of it, 10 seconds after it was typed: cut short. Taken back out, typed again.
        1) unsteady again
           [ $((now - t_typed)) -ge "${CHECKIN_DRAW_S:-10}" ] && clear_box && forget "only part of it was in his box" ;;
        *) unsteady again ;;   # someone else's draft, or more than the try: left as it is
      esac ;;
    ready)
      unsteady again
      if [ -n "$busy" ]; then unsteady empty; return 0; fi   # at work: not known yet
      if [ "$t_entered" = 0 ]; then
        # Never sent: his box empty, and steady, 30 seconds after it was typed.
        [ $((now - t_typed)) -ge "${CHECKIN_GRACE_S:-30}" ] && steady empty && forget "his box is empty"
      else
        # Sent, and not seen in: his screen idle, and steady, two minutes on.
        [ $((now - t_entered)) -ge "${CHECKIN_CONFIRM_S:-120}" ] && steady empty && unsure
      fi ;;
    *) unsteady again empty ;;   # a question, or a screen not known: later
  esac
  return 0
}

screen=$(screen_now) || { unsteady ready; exit 0; }
if [ -f "$TRY" ]; then pending; exit 0; fi

# 1. A relayed line, one at a time, oldest first, once he's at his prompt (till then the queue is
#    left as it is). The link and the record keeper append to the queue at any moment, so the whole
#    queue is first moved aside to a work file (new lines start a fresh queue), and lines are taken
#    from that. A line leaves the work file only once it's in.
if [ -s "$work" ] || [ -s "$queue" ]; then
  at_ease || exit 0
  if [ ! -s "$work" ]; then mv "$queue" "$work"; fi
  line=$(head -n 1 "$work")
  key=$(head -n 1 "$work" | cksum | cut -d' ' -f1)
  # Read whole: the line holds exactly one JSON object, whose text is a string (two values on a
  # line, or none, is no record), and its text as written (line ends kept for keyless to make
  # spaces; outside rounds 20 and 21). One that can't be read is set aside, kept in $bad, and
  # Cain hears at the next check-in; it leaves the queue only once it's kept there.
  if ! text=$(printf '%s' "$line" | jq -s -j 'if length == 1 and (.[0] | type) == "object" and (.[0].text | type) == "string" then .[0].text else error("not a relayed record") end' 2>/dev/null); then
    if ! printf '%s\n' "$line" >> "$bad" 2>/dev/null; then
      echo "[cain] a relayed record couldn't be read, nor set aside ($bad): it stays first"
      exit 0
    fi
    echo "[cain] a relayed record couldn't be read: set aside in $bad, and Cain hears at the next check-in"
    drop_head "$key"
    exit 0
  fi
  if [ -z "$text" ]; then echo "[cain] a relayed record with no text: nothing to type"; drop_head "$key"; exit 0; fi
  type_try relay "$key" - "Relayed by the add-on: $text"
  exit 0
fi

# 2. Open cloud jobs (one file per run in $jobs, written by Cain when he starts one), looked at
#    every 15 minutes while there are any, as the old nudge was. Since Cain 0.20.0 code does the
#    look (lean/main.ts jobs): it reads each job file (root's reader: never through a link, never a
#    FIFO, his own regular file, one name, at most 4 KB) and each Build job's pull request on GitHub,
#    and he gets one line only when a job changed state, stalled, has a state code can't read (a Ship
#    run, a GitHub error, an answer code doesn't know), waits on Home Assistant (a connector file), or
#    has a file code refused. No change, no line, and the look still counts. What code saw is kept as
#    seen only once his line is in (finish), as the nudge's time was. When code can't look at all
#    (it fails, or says what this doesn't read), the old nudge goes instead. Files older than two
#    days are dropped.
jobs="${JOBS_DIR:-/data/jobs}"
if [ -d "$jobs" ] || [ -L "$jobs" ]; then
  [ -L "$jobs" ] || find "$jobs" -type f -mtime +2 -delete 2>/dev/null
  if [ -n "$(ls -A "$jobs" 2>/dev/null)" ] && [ -z "$(find "$nudged" -mmin -15 2>/dev/null)" ]; then
    look="$(timeout 60 bun "${LEAN_MAIN:-$OPT/lean/main.ts}" jobs "$jobs" 2>/dev/null)" || look=""
    first="${look%%$'\n'*}"; line="${look#*$'\n'}"
    if [ "$first" = none ]; then
      touch "$nudged"; echo "[cain] code looked at the open cloud jobs: no change, nothing for Cain"
      exit 0
    fi
    at_ease || exit 0
    if [[ "$first" =~ ^wake\ ([0-9]{1,12}-[0-9a-f]{1,12})$ ]] && [ "$line" != "$look" ] && [ -n "$line" ]; then
      type_try jobs jobs "${BASH_REMATCH[1]}" "$line"
    else
      echo "[cain] code couldn't look at the open cloud jobs: Cain checks them himself, as before"
      type_try jobs jobs - "Relayed by the add-on: cloud job check. Not a message from Dane, and not his go on anything. Follow the Cloud jobs section of your CLAUDE.md for each file in $jobs."
    fi
    exit 0
  fi
fi

# 3. Scheduled check-ins.
hm="${CHECKIN_NOW:-$(date +%H%M)}"
day="${CHECKIN_DAY:-$(date +%F)}"
slot=""
for s in 0710 1230 1730; do
  if [ "$hm" -ge "$s" ] && [ "$hm" -lt "$(( 10#$s + 100 ))" ]; then slot=$s; fi
done
[ -n "$slot" ] || exit 0
[ -f "$dir/$day-$slot" ] && exit 0
at_ease || exit 0
# Every slot since the last check-in that went in and before this one: named in this one, as a
# count and a range, so a missed check-in is never silent, however long the gap (Cain's fourth
# service review, fix soon 9). The last one is kept ($lastin; before this App kept it, the newest
# sent); none before the first check-in this App ever sent.
slot_n() {   # slot_n <day>-<slot>: its place in the run of all slots, three a day, by UTC days
  local d i
  case "${1##*-}" in 0710) i=0 ;; 1230) i=1 ;; 1730) i=2 ;; *) return 1 ;; esac
  d="$(date -u -d "${1%-*}" +%s 2>/dev/null)" || return 1
  echo $(( d / 86400 * 3 + i ))
}
slot_at() {   # slot_at <n>: in words, as Cain reads them ("today at 7:10 AM", "Nov 13 at 5:30 PM")
  local d s
  d="$(date -u -d "@$(( $1 / 3 * 86400 ))" +%F)"
  case $(( $1 % 3 )) in 0) s="7:10 AM" ;; 1) s="12:30 PM" ;; *) s="5:30 PM" ;; esac
  if [ "$d" = "$day" ]; then echo "today at $s"
  elif [ "$d" = "$(date -d "$day -1 day" +%F 2>/dev/null)" ]; then echo "yesterday at $s"
  else echo "$(date -u -d "$d" '+%b %-d') at $s"; fi
}
last=$(head -c 40 "$lastin" 2>/dev/null | tr -cd '0-9-')
[[ "$last" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-(0710|1230|1730)$ ]] \
  || last=$(ls "$dir" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(0710|1230|1730)$' | sort | tail -n 1)
missed=""
if [ -n "$last" ] && a=$(slot_n "$last") && b=$(slot_n "$day-$slot") && [ $((b - a)) -ge 2 ]; then
  if [ $((b - a)) = 2 ]; then when="$(slot_at $((a + 1)))"
  else when="from $(slot_at $((a + 1))) to $(slot_at $((b - 1)))"; fi
  missed="Check-ins that didn't reach you (your screen wasn't at your prompt within their hour): $((b - a - 1)), $when. "
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
# Relayed records set aside unread and not yet named: all that $bad holds, since a check-in that
# names them moves them on to $bad.named. Kept in /data, so a restart can't leave one unnamed, and
# with no count, so emptying or refilling $bad can't hide one (outside rounds 21 and 22).
unread=$(wc -l < "$bad" 2>/dev/null | tr -cd '0-9'); unread=${unread:-0}
[ "$unread" -gt 0 ] && lead="${lead}Relayed records the App couldn't read: ${unread}, set aside unread in its own files. A tap or reaction of his may be among them: if he mentions one you never heard of, that's why. "
# The security watch's line (security/main.ts, root's like this script): in the morning the
# heartbeat, the review spend and the keys; at the others only a flagged spend or a heartbeat
# failing three times in a row. One line, its own words only (nothing of a key, nothing of the
# heartbeat URL).
kind=other; [ "$slot" = 0710 ] && kind=morning
watch=$(timeout 30 bun "${SECURITY_MAIN:-/opt/cain/security/main.ts}" lines "$kind" 2>/dev/null \
          | head -n 1 | tr -d '\000-\010\013\014\016-\037\177' | tr '\t\r\n' '   ')
[ -n "$watch" ] && watch=" $watch"
# Every time the App restarted itself in the 24 hours before (Cain 0.15.0, probe/main.ts self-report),
# with its time and cause: in the morning only.
if [ "$slot" = 0710 ]; then
  selfline=$(timeout 30 bun "${PROBE_MAIN:-/opt/cain/probe/main.ts}" self-report 2>/dev/null \
               | tail -n 1 | tr -d '\000-\010\013\014\016-\037\177' | tr '\t\r\n' '   ' | cut -c1-600)
  [ -n "$selfline" ] && watch="$watch $selfline"
  # The usage guard's reading (Cain 0.16.0, guard.ts), for his daily usage row: read only, the
  # runner and the Build hook keep the counts; this only reads them.
  usage=$(timeout 60 bun "${REVIEW_CLI:-/opt/cain/review/cli.ts}" guard 2>/dev/null \
            | head -n 2 | tr -d '\000-\010\013\014\016-\037\177' | tr '\t\r\n' '   ' | cut -c1-700)
  [ -n "$usage" ] && watch="$watch Usage guard: $usage"
fi
if [ "$slot" = 0710 ]; then
  msg="${lead}${missed}Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his one morning update.$watch"
else
  msg="${lead}${missed}Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision.$watch"
fi
type_try checkin "$day-$slot" "$day-$slot $unread ${newest:--}" "$msg"
exit 0
