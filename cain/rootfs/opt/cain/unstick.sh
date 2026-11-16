#!/bin/bash
# A question waiting on Cain's screen, where no one answers it: a dialog of Claude Code's (a
# permission prompt, an offer, a menu) or a question of his own asked in the terminal. Until it's
# answered his session takes no message, tap or check-in. Nov 16, Claude Code's offer to set up
# auto mode sat there from 4:57 to 7:53 AM, until a laptop session pressed Esc from his panel.
# The run script calls this every 10 seconds while his session runs (bounded by a timeout, as is
# every tmux call here). It reads his screen as checkin.sh does (prompt-state.sh: "dialog"), and:
#   - a question has waited 5 minutes: Esc, once, and a line for Cain. The try is kept before the
#     key is sent, so one that doesn't go through still leads on to the next step. A screen that
#     looks like a sign-in or his folder's trust question (one of their own lines starting a line
#     in the bottom 16) gets 15 minutes instead: his to answer on the panel, if he's at it;
#   - three questions closed with Esc within an hour tell Dane (notice.sh tell waiting): something
#     keeps asking, such as a trust question whose Esc ends his session each time;
#   - still a question 5 minutes after the Esc: prints "restart", and the run script starts his
#     session fresh, at most once an hour. One that would come sooner tells Dane instead
#     (notice.sh tell waiting), and the fresh start follows once the hour is up;
#   - his prompt back for 5 minutes: that alarm comes down if it stands (notice.sh clear screen, once
#     for each stretch his prompt is back; the alarm itself is notice.sh's, kept across restarts).
# A question counts from when it's first seen: any other screen, or a gap of over a minute between
# reads, starts the count again, so a new question gets its own 5 minutes and its own Esc. A
# sign-in or trust question is given longer, never forever (outside review, round 16). Nothing is
# typed but Esc. Its state is root's, in $UNSTICK_DIR, for this container; a step whose state
# can't be kept isn't taken (Dane is told instead), so no limit is ever skipped, and with no
# place for its state a question on screen is told at once. Prints "restart" or nothing; always
# exits 0.
set -u
TM="${TMUX_CMD:-tmux}"   # Cain's own user and socket the new way (the run script sets it)
OPT="${UNSTICK_OPT:-/opt/cain}"
DIR="${UNSTICK_DIR:-/run/cain/unstick}"
QUEUE="${RELAY_QUEUE:-/data/relay.queue}"
ESC_S="${UNSTICK_ESC_S:-300}"; AGAIN_S="${UNSTICK_AGAIN_S:-300}"; HOURLY_S="${UNSTICK_HOURLY_S:-3600}"
GAP_S="${UNSTICK_GAP_S:-60}"; CALM_S="${UNSTICK_CALM_S:-300}"; TMUX_S="${UNSTICK_TMUX_S:-10}"
SIGNIN_S="${UNSTICK_SIGNIN_S:-900}"; ESCS_N="${UNSTICK_ESCS_N:-3}"
now="${UNSTICK_NOW:-$(date +%s)}"
say() { echo "[cain] $*" >&2; }
# A kept number: printed (nothing when there's none); 1 when it's there but can't be read as one.
stamp() {
  [ -e "$DIR/$1" ] || return 0
  local v
  v="$(head -c 20 "$DIR/$1" 2>/dev/null)" || return 1
  v="$(printf '%s' "$v" | tr -cd '0-9')"
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}
# Kept only once it reads back as written: the file replaced whole, never moved into a directory.
put() {
  printf '%s\n' "$2" > "$DIR/.$1" 2>/dev/null && mv -fT "$DIR/.$1" "$DIR/$1" 2>/dev/null \
    && [ "$(stamp "$1" 2>/dev/null)" = "$2" ] && return 0
  rm -f "$DIR/.$1" 2>/dev/null
  say "the way out of a question on his screen couldn't keep its state ($DIR/$1)"
  return 1
}
drop() { rm -f "$DIR/$1" 2>/dev/null; [ ! -e "$DIR/$1" ]; }
forget() {   # the question's count, not the hourly limit
  local rc=0
  drop since || rc=1; drop seen || rc=1; drop esc || rc=1
  return "$rc"
}
tell_cain() {   # a line typed into his session once his prompt is back (checkin.sh)
  local line
  line="$(jq -cn --arg t "$1" '{text: $t}' 2>/dev/null)" && printf '%s\n' "$line" >> "$QUEUE" 2>/dev/null \
    || say "a line for Cain couldn't be queued: $1"
}
alarm() {   # notice.sh <tell waiting | clear screen>: 0 once it's raised or cleared (its 1: kept, to be
  local rc=0  # sent by its ticks). Its lock waited on 5 seconds at most: a busy one is tried next time.
  NOTICE_LOCK_S=5 timeout -k 2 40 "$OPT/notice.sh" "$@" >&2 || rc=$?
  [ "$rc" -le 1 ]
}
tell_dane() {   # the waiting alarm, once until it comes down; logged once, with why
  [ -f "$DIR/told" ] && return 0
  alarm tell waiting || return 0
  put told 1 || true
  say "Dane is told a question waits on Cain's screen: $1"
}

screen=$(timeout -k 2 "$TMUX_S" $TM -u capture-pane -p -J -t cain -S -400 2>/dev/null) || exit 0   # unread: nothing known
at=$(printf '%s\n' "$screen" | "${PROMPT_STATE:-$OPT/prompt-state.sh}" 2>/dev/null) || at=other
if ! mkdir -p "$DIR" 2>/dev/null; then
  # No count can be kept: a question on screen now is told at once, and taken down once his prompt
  # is back (notice.sh keeps its own state). Never silent (outside review, round 15).
  say "no place for the state of the way out of a question on his screen ($DIR)"
  case "$at" in dialog) alarm tell waiting ;; ready) alarm clear screen ;; esac
  exit 0
fi
# A screen that looks like a sign-in or the folder's trust question (one of their own lines starting
# a line, past the box's edge, in the bottom 16): 15 minutes before its Esc instead of 5. A line
# like one left in older output only gives a question longer, never a pass (outside round 16).
wait_s=$ESC_S
if [ "$at" = dialog ] && printf '%s\n' "$screen" | awk 'NF' | tail -n 16 | sed 's/^[[:space:]│]*//' \
     | grep -Eqi '^(paste code here|select login method|do you trust the files|choose the text style)'; then
  wait_s=$SIGNIN_S
fi

if [ "$at" != dialog ]; then
  forget || say "a question's count couldn't be cleared ($DIR)"
  if [ "$at" = ready ]; then
    calm=$(stamp calm) || calm=""
    if [ -z "$calm" ]; then put calm "$now" || exit 0; calm=$now; fi
    if [ ! -f "$DIR/cleared" ] && [ $((now - calm)) -ge "$CALM_S" ] && alarm clear screen; then
      put cleared 1 || true
      drop told || true
    fi
  else
    drop calm; drop cleared
  fi
  exit 0
fi
drop calm; drop cleared

cant="the App can't keep count of its tries, so it takes no step it couldn't keep from repeating"
# A count that can't be read is cleared; one that can't be cleared either can't be kept: Dane hears.
if ! { since=$(stamp since) && seen=$(stamp seen) && esc=$(stamp esc); }; then
  forget
  if ! { since=$(stamp since) && seen=$(stamp seen) && esc=$(stamp esc); }; then tell_dane "$cant"; exit 0; fi
fi
if [ -z "$since" ] || [ -z "$seen" ] || [ $((now - seen)) -gt "$GAP_S" ] || [ "$now" -lt "$seen" ]; then
  forget
  since=$now; esc=""
  put since "$now" || { tell_dane "$cant"; exit 0; }
fi
put seen "$now" || { tell_dane "$cant"; exit 0; }
waited=$(( (now - since) / 60 ))

if [ -z "$esc" ]; then
  [ $((now - since)) -ge "$wait_s" ] || exit 0
  # The try is kept first: if it can't be, no Esc goes (nothing could stop a repeat), and Dane hears.
  if ! put esc "$now"; then tell_dane "$cant"; exit 0; fi
  # Each Esc is counted, the last hour's kept: the third within an hour tells Dane. A history there
  # that isn't a file of times, one a line, can't be counted on: Dane hears (outside round 17).
  if [ -e "$DIR/escs" ] && { [ ! -f "$DIR/escs" ] || [ ! -r "$DIR/escs" ] || grep -qvE '^[0-9]+$' "$DIR/escs"; }; then
    tell_dane "$cant"
  fi
  recent="$(awk -v t=$((now - 3600)) '$1 ~ /^[0-9]+$/ && $1 >= t' "$DIR/escs" 2>/dev/null; echo "$now")"
  if ! { printf '%s\n' "$recent" > "$DIR/.escs" 2>/dev/null && mv -fT "$DIR/.escs" "$DIR/escs" 2>/dev/null; }; then
    rm -f "$DIR/.escs" 2>/dev/null
    tell_dane "$cant"
  elif [ "$(printf '%s\n' "$recent" | wc -l)" -ge "$ESCS_N" ]; then
    tell_dane "$ESCS_N questions closed with Esc within an hour: something keeps asking on his screen"
  fi
  if timeout -k 2 "$TMUX_S" $TM -u send-keys -t cain Escape 2>/dev/null; then
    say "A question has waited $waited minutes on Cain's screen, where no one answers it: pressed Esc"
    tell_cain "A question waited $waited minutes on your screen, where no one answers it, so the App pressed Esc to close it. Ask him things in Discord, never on your screen. If it stopped something you were doing, pick it up again. Nothing to tell him."
  else
    say "A question has waited $waited minutes on Cain's screen, and Esc couldn't be sent: his session starts fresh in 5 minutes if it's still there"
  fi
  exit 0
fi

[ $((now - esc)) -ge "$AGAIN_S" ] || exit 0
# Esc didn't close it: his session starts fresh, at most once an hour. One that would come sooner,
# or a limit that can't be read or kept, tells Dane instead; the fresh start waits for the hour.
if ! last=$(stamp restarted); then tell_dane "$cant"; exit 0; fi
if [ -n "$last" ] && [ $((now - last)) -lt "$HOURLY_S" ]; then   # a clock gone back counts as within
  tell_dane "Esc didn't close it, and his last fresh start was under an hour ago; the next comes once the hour is up"
  exit 0
fi
if ! put restarted "$now"; then tell_dane "$cant"; exit 0; fi
forget
say "A question still waits on Cain's screen $(( (now - esc) / 60 )) minutes after Esc: starting his session fresh"
tell_cain "Your session was started fresh: a question sat on your screen, where no one answers it, and Esc didn't close it. Anything he wrote meanwhile may not have reached you: read his DM with fetch_messages and answer what's unanswered. Then pick up your work from state/RESTART.md."
echo restart
exit 0
