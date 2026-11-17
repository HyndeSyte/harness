#!/bin/bash
# The App's watchdog over what it types into Cain's session: root's, outside his session, so it
# tells Dane even when his session is what failed (Cain's fourth service review, must-fix 2). The
# run script runs it every 10 seconds while his session runs, bounded by a timeout. It reads his
# screen as checkin.sh does, and raises one alarm (notice.sh tell stalled: his bot, from root's own
# token, and Home Assistant's push to his phone as the fallback), once a stretch, when
#   - something waits to go in (a relayed line, a try of the App's not yet known to be in, a
#     check-in within its hour) and nothing has gone in for 30 minutes in which his screen was
#     neither at work nor showing a question (unstick.sh's), or for 2 hours in all; or
#   - his input box has held a draft that isn't the App's own try, unchanged, or his screen has
#     been one the App doesn't know (a sign-in aside: that has its own alarm), for 30 minutes on
#     end; the way out (unstick.sh) saves and clears it at 15.
# It comes down, with a line saying so (notice.sh clear delivered), once nothing is stuck and
# something has gone in since, or nothing waits. Its state is root's, in $WATCH_DIR, for this
# container. Prints nothing; always exits 0.
set -u
OPT="${WATCH_OPT:-/opt/cain}"
DIR="${WATCH_DIR:-/run/cain/watch}"
QUEUE="${RELAY_QUEUE:-/data/relay.queue}"
CHECKINS="${CHECKIN_DIR:-/data/checkins}"
DELIVERED="${CHECKIN_DELIVERED:-/data/checkin.delivered}"
IDLE_S="${WATCH_IDLE_S:-1800}"; ALL_S="${WATCH_ALL_S:-7200}"; ODD_S="${WATCH_ODD_S:-1800}"; STEP_S="${WATCH_STEP_S:-60}"
now="${WATCH_NOW:-$(date +%s)}"
export TZ="${CHECKIN_TZ:-America/New_York}"
PS="${PROMPT_STATE:-$OPT/prompt-state.sh}"
. "${TYPING_SH:-$OPT/typing.sh}" || { echo "[cain] no typing.sh: the watchdog doesn't run" >&2; exit 0; }
say() { echo "[cain] $*" >&2; }
num() { head -n 1 "$DIR/$1" 2>/dev/null | tr -cd '0-9'; }
keep() { printf '%s\n' "$2" > "$DIR/.$1" 2>/dev/null && mv -f "$DIR/.$1" "$DIR/$1" 2>/dev/null; }
mkdir -p "$DIR" 2>/dev/null || { say "no place for the watchdog's state ($DIR)"; exit 0; }

screen="$(screen_now)" || screen=""
at="$(printf '%s\n' "$screen" | "$PS" 2>/dev/null)" || at=other
busy=""
if [ "$at" = ready ] && printf '%s\n' "$screen" | awk 'NF' | tail -n 12 | grep -qi 'esc to interrupt'; then busy=1; fi

# Something to go in: a relayed line, a try not yet known in, or a check-in within its hour.
waiting=""
if [ -s "$QUEUE" ] || [ -s "$QUEUE.work" ] || [ -f "$TRY" ]; then waiting=1; fi
hm="${WATCH_HM:-$(date +%H%M)}"; day="${WATCH_DAY:-$(date +%F)}"
for s in 0710 1230 1730; do
  if [ "$hm" -ge "$s" ] && [ "$hm" -lt "$(( 10#$s + 100 ))" ] && [ ! -f "$CHECKINS/$day-$s" ]; then waiting=1; fi
done
last_in="$(head -n 1 "$DELIVERED" 2>/dev/null | tr -cd '0-9')"; last_in="${last_in:-0}"
prev="$(num tick)"; keep tick "$now"
step=0
if [ -n "$prev" ] && [ "$now" -ge "$prev" ]; then step=$((now - prev)); [ "$step" -le "$STEP_S" ] || step="$STEP_S"; fi

since="$(num since)"; idle="$(num idle)"
if [ -n "$waiting" ]; then
  if [ -z "$since" ] || [ "$last_in" -gt "$since" ]; then since="$now"; idle=0   # a fresh stretch
  elif [ -z "$busy" ] && [ "$at" != dialog ]; then idle=$(( ${idle:-0} + step )); fi
  keep since "$since"; keep idle "$idle"
else
  rm -f "$DIR/since" "$DIR/idle"; since=""; idle=0
fi

# A draft that isn't the App's own try (unchanged), or a screen the App doesn't know.
odd=""
if [ "$at" = draft ]; then
  lines="$(printf '%s\n' "$screen" | PROMPT_DRAFT_TEXT=1 "$PS" 2>/dev/null | sed 1d)"
  rc=0; own_try "$lines" "$(width)" || rc=$?
  [ "$rc" != 2 ] || odd="draft $(printf '%s' "$lines" | cksum | cut -d' ' -f1)"
elif [ "$at" = other ] && [ -n "$(printf '%s' "$screen" | tr -d '[:space:]')" ] \
     && ! printf '%s\n' "$screen" | awk 'NF' | tail -n 16 | sed 's/^[[:space:]│]*//' \
       | grep -Eqi '^(paste code here|select login method|do you trust the files|choose the text style)|run /login|not logged in|invalid api key|token has expired|login expired'; then
  odd=other
fi
odd_since=""
if [ -n "$odd" ]; then
  if [ "$(cut -d' ' -f2- "$DIR/odd" 2>/dev/null)" = "$odd" ]; then odd_since="$(head -n 1 "$DIR/odd" 2>/dev/null | cut -d" " -f1 | tr -cd "0-9")"; fi
  [ -n "$odd_since" ] && [ "$now" -ge "$odd_since" ] || { odd_since="$now"; keep odd "$now $odd"; }
else
  rm -f "$DIR/odd"
fi

cause=""
if [ -n "$waiting" ] && { [ "$idle" -ge "$IDLE_S" ] || [ $((now - since)) -ge "$ALL_S" ]; }; then
  cause="nothing has gone in for $(( (now - since) / 60 )) minutes"
elif [ -n "$odd_since" ] && [ $((now - odd_since)) -ge "$ODD_S" ]; then
  case "$odd" in draft*) cause="a draft has sat in his input box for $(( (now - odd_since) / 60 )) minutes" ;;
    *) cause="his screen has shown something the App doesn't know for $(( (now - odd_since) / 60 )) minutes" ;; esac
fi
told="$(num told)"
alarm() { NOTICE_LOCK_S=5 timeout -k 2 40 "$OPT/notice.sh" "$@" >&2; }
if [ -n "$cause" ]; then
  # Once a stretch: notice.sh sends its repeats itself; one that couldn't be raised (its lock
  # busy, a write failed) is raised again at the next run.
  if [ -z "$told" ]; then
    rc=0; alarm tell stalled "$cause" || rc=$?
    if [ "$rc" -le 1 ]; then keep told "$now"; say "Dane is told that what the App types doesn't go in: $cause"; fi
  fi
elif [ -n "$told" ] && { [ "$last_in" -gt "$told" ] || [ -z "$waiting" ]; } && [ -z "$odd_since" ]; then
  rc=0; alarm clear delivered || rc=$?
  if [ "$rc" -le 1 ]; then rm -f "$DIR/told"; say "What the App types goes in again: the alarm comes down"; fi
fi
exit 0
