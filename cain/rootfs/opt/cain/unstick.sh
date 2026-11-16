#!/bin/bash
# A question waiting on Cain's screen, where no one answers it: a dialog of Claude Code's (a
# permission prompt, an offer, a menu) or a question of his own asked in the terminal. Until it's
# answered his session takes no message, tap or check-in. Nov 16, Claude Code's offer to set up
# auto mode sat there from 4:57 to 7:53 AM, until a laptop session pressed Esc from his panel.
# The run script calls this every 10 seconds while his session runs. It reads his screen as the
# panel does (screen-state.sh: "dialog"), and:
#   - a question has waited 5 minutes: presses Esc, once, and tells Cain (a relayed line);
#   - it still waits 5 minutes after the Esc: prints "restart", and the run script starts his
#     session fresh, at most once an hour. One that would come sooner tells Dane instead
#     (notice.sh tell waiting), and the fresh start follows once the hour is up;
#   - his prompt back for 5 minutes: that alarm comes down if it stands (notice.sh clear screen, once
#     for each stretch his prompt is back; the alarm itself is notice.sh's, kept across restarts).
# It types nothing but Esc, and nothing at all into a sign-in (the panel's own states). A gap of
# over a minute between waiting screens starts the count again. Its own state: root's, in
# $UNSTICK_DIR, for this container. Prints "restart" or nothing; always exits 0.
set -u
TM="${TMUX_CMD:-tmux}"   # Cain's own user and socket the new way (the run script sets it)
OPT="${UNSTICK_OPT:-/opt/cain}"
DIR="${UNSTICK_DIR:-/run/cain/unstick}"
QUEUE="${RELAY_QUEUE:-/data/relay.queue}"
ESC_S="${UNSTICK_ESC_S:-300}"; AGAIN_S="${UNSTICK_AGAIN_S:-300}"; HOURLY_S="${UNSTICK_HOURLY_S:-3600}"
GAP_S="${UNSTICK_GAP_S:-60}"; CALM_S="${UNSTICK_CALM_S:-300}"
now="${UNSTICK_NOW:-$(date +%s)}"
mkdir -p "$DIR" 2>/dev/null || exit 0
get() { head -c 20 "$DIR/$1" 2>/dev/null | tr -cd '0-9'; }
put() { printf '%s\n' "$2" > "$DIR/.$1" 2>/dev/null && mv -f "$DIR/.$1" "$DIR/$1" 2>/dev/null; }
drop() { rm -f "$DIR/$1" 2>/dev/null; }
say() { echo "[cain] $*" >&2; }
tell_cain() {   # a line typed into his session once his prompt is back (checkin.sh)
  local line
  line="$(jq -cn --arg t "$1" '{text: $t}' 2>/dev/null)" && printf '%s\n' "$line" >> "$QUEUE" 2>/dev/null \
    || say "a line for Cain couldn't be queued: $1"
}
alarm() {   # notice.sh <tell waiting | clear screen>: 0 once it's raised or cleared (its 1: kept, to be
  local rc=0  # sent by its ticks). Its lock waited on 5 seconds at most: a busy one is tried next time.
  NOTICE_LOCK_S=5 "$OPT/notice.sh" "$@" >&2 || rc=$?
  [ "$rc" -le 1 ]
}

screen=$($TM -u capture-pane -p -J -t cain -S -400 2>/dev/null) || exit 0   # unread: nothing known
state=$(printf '%s\n' "$screen" | "$OPT/screen-state.sh" 2>/dev/null) || state=unknown
if [ "$state" != dialog ]; then
  if [ "$state" = ready ]; then
    calm=$(get calm)
    if [ -z "$calm" ]; then put calm "$now"; calm=$now; fi
    if [ ! -f "$DIR/cleared" ] && [ $((now - calm)) -ge "$CALM_S" ] && alarm clear screen; then
      put cleared 1; drop told
    fi
  else
    drop calm; drop cleared
  fi
  exit 0
fi
drop calm; drop cleared

since=$(get since); seen=$(get seen); esc=$(get esc)
if [ -z "$since" ] || [ -z "$seen" ] || [ $((now - seen)) -gt "$GAP_S" ]; then
  since=$now; esc=""
  put since "$now"; drop esc
fi
put seen "$now"
waited=$(( (now - since) / 60 ))

if [ -z "$esc" ]; then
  [ $((now - since)) -ge "$ESC_S" ] || exit 0
  if $TM -u send-keys -t cain Escape 2>/dev/null; then
    put esc "$now"
    say "A question has waited $waited minutes on Cain's screen, where no one answers it: pressed Esc"
    tell_cain "A question waited $waited minutes on your screen, where no one answers it, so the App pressed Esc to close it. Ask him things in Discord, never on your screen. If it stopped something you were doing, pick it up again. Nothing to tell him."
  else
    say "A question has waited $waited minutes on Cain's screen, and Esc couldn't be sent: tried again in 10 seconds"
  fi
  exit 0
fi

[ $((now - esc)) -ge "$AGAIN_S" ] || exit 0
# Esc didn't close it: his session starts fresh, at most once an hour. One that would come sooner
# tells Dane, once, and the fresh start waits for the hour.
last=$(get restarted)
if [ -z "$last" ] || [ $((now - last)) -ge "$HOURLY_S" ]; then
  put restarted "$now"; drop since; drop seen; drop esc
  say "A question still waits on Cain's screen $(( (now - esc) / 60 )) minutes after Esc: starting his session fresh"
  tell_cain "Your session was started fresh: a question sat on your screen, where no one answers it, and Esc didn't close it. Anything he wrote meanwhile may not have reached you: read his DM with fetch_messages and answer what's unanswered. Then pick up your work from state/RESTART.md."
  echo restart
  exit 0
fi
if [ ! -f "$DIR/told" ] && alarm tell waiting; then
  put told 1
  say "A question came back on Cain's screen within the hour of his fresh start: Dane is told; the next fresh start comes once the hour is up"
fi
exit 0
