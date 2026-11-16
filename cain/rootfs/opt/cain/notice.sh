#!/bin/bash
# The App's alarms to Dane, sent by root and never through his session, so they reach him when
# his session, the broker or Discord is what failed (C1 second review, must-fix 2):
#   - Discord: his bot, through alert.sh (root's copy of the token). Once per alarm, tried again
#     at each tick until it goes through.
#   - Home Assistant: a local webhook. One automation there turns each post into a persistent
#     notification and a push to his phone; that is all the webhook can reach (DOCS.md, "If Cain
#     stops"). Its id: the App's notice_hook option when set, else one made from owner_user_id
#     (his Home Assistant user id, already set for the panel), so the channel works from the
#     first start after the update, before anyone sets an option. The App keeps homeassistant_api
#     off on purpose: the Supervisor's own route to a notification needs it, and it would hand
#     every root process here, and the old way's root session, the run of all of Home Assistant.
#     Sent again daily while the alarm lasts, and at once when the hook changes. A probe at each
#     start and daily (no notification: the automation only notes the time in a helper) shows
#     from Home Assistant's side that the channel works.
# Each alarm says what happened and the way back, in plain words: it reaches him as it is. When
# it clears, Home Assistant's notification comes down and both say so; until a hook takes it
# down, the clearing is kept and tried again. The state is root's, in /data/c1/notice; one alarm
# at a time, a newer one replacing it. Nothing here runs without the lock: a writer that can't
# have it within 30 seconds exits 75, and the alarm is raised again by its caller or the next tick.
#   notice.sh tell <alarm>       raise it; raised already, only its repeats and retries run
#   notice.sh clear running      Cain runs again: a stop's or a pause's alarm clears
#   notice.sh clear switched     Cain runs as his own user: any alarm clears
#   notice.sh tick               the repeats, retries and the daily probe (every 10 minutes)
#   notice.sh probe              the probe, now
#   notice.sh text <alarm>       an alarm's title and text, one line each (tests, docs)
# Exits 0 when done, 1 when what it was asked couldn't be kept or sent and stays to be retried
# (said on stderr), 2 on a wrong use, 75 when it couldn't have the lock.
set -uo pipefail
umask 077
OPT="${NOTICE_OPT:-/opt/cain}"
D="${NOTICE_DATA:-/data}"
STATE="${NOTICE_STATE:-$D/c1/notice}"
PROBED="${NOTICE_PROBED:-$D/c1/notice-probed}"
OPTIONS="${NOTICE_OPTIONS:-$D/options.json}"
URL="${NOTICE_URL:-http://homeassistant:8123}"
DAY="${NOTICE_DAY_S:-86400}"

BACKUPS="restore two backups from just before his last update, Cain's and the calendar App's, one after the other: Settings, System, Backups"
RESTART="restart the Cain App: Settings, Apps, Cain, Restart"
DETAILS="The Cain App's log has the details."
alarm() {   # sets T (its title) and M (its text); 1 for no such alarm
  case "$1" in
    breach) T="Cain is stopped"
      M="Cain is stopped: a safety check of his own user failed after his update, so he won't run on this version. To get him back now, $BACKUPS. A fixed update also brings him back. $DETAILS" ;;
    switch-stopped) T="Cain is stopped"
      M="Cain is stopped: his move to a safer setup stopped part way. To get him back, $BACKUPS. $DETAILS" ;;
    damaged) T="Cain is stopped"
      M="Cain is stopped: his saved start state is damaged, so he isn't started. To get him back, $BACKUPS. $DETAILS" ;;
    setup) T="Cain is stopped"
      M="Cain is stopped: his App's safety setup didn't check out at start, so he isn't started. First $RESTART. If he's still stopped after that, $BACKUPS. $DETAILS" ;;
    restart) T="Cain is stopped"
      M="Cain is stopped: his App asked to be restarted half an hour ago, and it hasn't been. To get him back, $RESTART." ;;
    exited) T="Cain is stopped"
      M="Cain is stopped: his App ran into something it couldn't get past and stopped itself. First $RESTART. If he's still stopped after that, $BACKUPS. $DETAILS" ;;
    session) T="Cain isn't answering"
      M="Cain isn't answering: his session keeps stopping soon after it starts. The App keeps starting it again by itself. If he isn't back within an hour, $RESTART. $DETAILS" ;;
    held) T="Cain is paused"
      M="Cain is paused: the safety check of his own user couldn't finish, so his session is held. This isn't a breach. The App tries the check again every 10 minutes, and he comes back by himself once it finishes. If he isn't back within an hour, $BACKUPS. $DETAILS" ;;
    switch-failed) T="Cain runs the old way for now"
      M="Cain's move to his own user, the safer setup in his update, didn't pass its checks, so it was undone. He runs the old way for now and still answers you. Nothing for you to do: the App tries again by itself, at most three times in six hours." ;;
    switch-waits) T="Cain runs the old way for now"
      M="Cain's move to his own user didn't pass its checks three times, so the App waits six hours before it tries again. He runs the old way meanwhile and still answers you. Nothing for you to do." ;;
    *) return 1 ;;
  esac
}
STOPS="breach switch-stopped damaged setup restart exited session held"
SWITCH="switch-failed switch-waits"
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
cleared_text() {   # sets CT and CM, what a cleared alarm says
  if in_list "$kind" "$SWITCH"; then CT="Cain moved to his own user"; CM="Cain now runs as his own user, the safer setup in his update."
  else CT="Cain is back"; CM="Cain is running again."; fi
}

# The state: the alarm raised, when Home Assistant last had it and from which hook (its hash),
# whether Discord has it, and whether it has cleared (its notification still to come down).
load() {
  kind=""; sent=0; fp=""; discord=0; clear=0
  [ -f "$STATE" ] || return 1
  local k v
  while read -r k v; do
    case "$k" in kind) kind="$v" ;; sent) sent="$v" ;; fp) fp="$v" ;; discord) discord="$v" ;; clear) clear="$v" ;; esac
  done < "$STATE"
  case "$sent" in ''|*[!0-9]*) sent=0 ;; esac
  [[ "$fp" =~ ^[0-9a-f]{16}$ ]] || fp=""
  alarm "$kind"
}
save() {
  if printf 'kind %s\nsent %s\nfp %s\ndiscord %s\nclear %s\n' "$kind" "$sent" "$fp" "$discord" "$clear" > "$STATE.tmp" 2>/dev/null \
     && mv -fT "$STATE.tmp" "$STATE" 2>/dev/null; then return 0; fi
  rm -f "$STATE.tmp" 2>/dev/null
  echo "[cain] alarm '$kind': its state couldn't be kept ($STATE), so its caller raises it again" >&2
  return 1
}

# The hook: the notice_hook option if set (only a well-formed id), else made from owner_user_id.
hook() {
  local h o
  h="$(jq -r '.notice_hook // empty' "$OPTIONS" 2>/dev/null)" || return 1
  if [ -n "$h" ]; then [[ "$h" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || return 1; printf '%s' "$h"; return 0; fi
  o="$(jq -r '.owner_user_id // empty' "$OPTIONS" 2>/dev/null)" || return 1
  [[ "$o" =~ ^[0-9a-f]{32}$ ]] || return 1
  printf 'cain-%s' "$(printf 'cain alarms %s' "$o" | sha256sum | cut -c1-40)"
}
hash16() { printf '%s' "$1" | sha256sum | cut -c1-16; }
ha_send() {   # ha_send <on|clear|test> <title> <text>: 0 once Home Assistant took it
  local h body
  h="$(hook)" || return 2
  body="$(jq -nc --arg s "$1" --arg a "$kind" --arg t "$2" --arg m "$3" '{state: $s, alarm: $a, title: $t, message: $m}')" || return 1
  # The hook stays off every command line, which the kernel shows to every user: curl reads the
  # address from its standard input.
  printf 'url = "%s/api/webhook/%s"\n' "$URL" "$h" \
    | curl -fsS -m 15 -K - -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary "$body" 2>/dev/null
}
# His bot, wherever the token is now (root's places after the switch, the old way's before it).
discord_send() {
  local tok="$D/link/discord.env" acc="$D/discord/access.json"
  [ -f "$tok" ] || tok="$D/.claude/channels/discord/.env"
  [ -f "$acc" ] || acc="$D/.claude/channels/discord/access.json"
  TOKEN_FILE="$tok" ACCESS_FILE="$acc" "$OPT/alert.sh" "$1" >/dev/null 2>&1
}

deliver() {   # the raised alarm: Discord once, Home Assistant daily or when its hook changed
  alarm "$kind" || return 1
  local now h said="" missed=""
  if [ "$discord" != 1 ]; then
    if discord_send "$M"; then discord=1; said="his bot"; else missed="his bot"; fi
  fi
  now="$(date +%s)"
  if h="$(hook)"; then
    if [ "$fp" != "$(hash16 "$h")" ] || [ $((now - sent)) -ge "$DAY" ]; then
      if ha_send on "$T" "$M"; then sent="$now"; fp="$(hash16 "$h")"; said="${said:+$said and }Home Assistant"
      else missed="${missed:+$missed and }Home Assistant"; fi
    fi
  else missed="${missed:+$missed and }Home Assistant (no hook)"; fi
  save || return 1
  [ -z "$said" ] || echo "[cain] alarm '$kind' sent to $said"
  [ -z "$missed" ] || echo "[cain] alarm '$kind' not yet through to $missed: tried again in 10 minutes" >&2
  return 0
}
finish_clear() {   # a cleared alarm: Home Assistant's notification comes down, then the state goes
  cleared_text
  if [ -z "$fp" ]; then rm -f "$STATE"; echo "[cain] alarm '$kind' cleared"; return 0; fi
  if ha_send clear "$CT" "$CM"; then rm -f "$STATE"; echo "[cain] alarm '$kind' cleared, and Home Assistant's notification came down"; return 0; fi
  echo "[cain] alarm '$kind' cleared, but Home Assistant's notification is still up: taking it down is tried again in 10 minutes" >&2
  return 1
}

tell() {
  alarm "$1" || { echo "notice: no alarm called '$1'" >&2; return 2; }
  if load && [ "$kind" = "$1" ] && [ "$clear" != 1 ]; then deliver; return; fi
  kind="$1"; sent=0; fp=""; discord=0; clear=0
  deliver
}
clear_alarm() {
  local kinds
  case "$1" in running) kinds="$STOPS" ;; switched) kinds="$STOPS $SWITCH" ;; *) echo "notice: clear running or switched" >&2; return 2 ;; esac
  load || return 0
  in_list "$kind" "$kinds" || return 0
  if [ "$clear" != 1 ]; then
    clear=1; cleared_text
    save || return 1
    if [ "$discord" = 1 ]; then discord_send "$CM" || echo "[cain] alarm '$kind' cleared, but his bot couldn't say so" >&2; fi
  fi
  finish_clear
}
probe() {   # no notification: Home Assistant's automation only notes the time
  local now; now="$(date +%s)"
  kind="probe"
  if ha_send test "" ""; then printf '%s\n' "$now" > "$PROBED.tmp" && mv -f "$PROBED.tmp" "$PROBED"; echo "[cain] alarms: Home Assistant's webhook took the probe"; return 0; fi
  echo "[cain] alarms: Home Assistant's webhook didn't take the probe (no hook, or Home Assistant didn't answer)" >&2
  return 1
}
tick() {
  local rc=0 last
  last="$(head -c 20 "$PROBED" 2>/dev/null | tr -cd '0-9' || true)"
  if [ $(( $(date +%s) - ${last:-0} )) -ge "$DAY" ]; then probe || true; fi
  load || return 0
  if [ "$clear" = 1 ]; then finish_clear || rc=1; else deliver || rc=1; fi
  return "$rc"
}

case "${1:-}" in tell|clear|tick|probe) ;; text) alarm "${2:-}" || exit 2; printf '%s\n%s\n' "$T" "$M"; exit 0 ;;
  *) echo "usage: notice.sh tell <alarm> | clear running|switched | tick | probe | text <alarm>" >&2; exit 2 ;; esac
# One writer at a time: the start, the check and the ticks may all call it, and none goes on
# without the lock.
mkdir -p "${STATE%/*}" 2>/dev/null && exec 9>"$STATE.lock" \
  || { echo "[cain] alarms: no place for their state (${STATE%/*})" >&2; exit 75; }
flock -w "${NOTICE_LOCK_S:-30}" 9 || { echo "[cain] alarms: another writer kept the lock; this one is raised again by its caller or the next tick" >&2; exit 75; }
case "$1" in
  tell) tell "${2:-}" ;;
  clear) clear_alarm "${2:-}" ;;
  tick) tick ;;
  probe) probe ;;
esac
