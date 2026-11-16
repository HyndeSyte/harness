#!/bin/bash
# The App's alarms to Dane, sent by root and never through his session, so they reach him when
# his session, the broker or Discord is what failed (C1 second review, must-fix 2):
#   - Discord: his bot, through alert.sh (root's copy of the token). Once per alarm, tried again
#     at each tick until it goes through.
#   - Home Assistant: a local webhook whose id is the App's notice_hook option, a random id only
#     root here and Home Assistant's admins know (never one Cain could work out). One automation
#     there turns each post into a persistent notification and a push to his phone; that is all
#     the webhook can reach (DOCS.md, "If Cain stops"). The App keeps homeassistant_api off on
#     purpose: the Supervisor's own route to a notification needs it, and it would hand every
#     root process here, and the old way's root session, the run of all of Home Assistant. Sent
#     again daily while the alarm lasts, and at once when the hook is set or changed. A probe at
#     each start and daily (no notification: the automation only notes the time in a helper)
#     shows from Home Assistant's side that the channel works. Until notice_hook is set, alarms
#     go to Discord only, and reach Home Assistant once it is.
# Alarms are kept per group, so one never erases another: "stop" (why he isn't running now:
# stopped, paused, or restarting), "session" (his session keeps ending), and "switch" (his move
# to his own user failed; he runs the old way). Within a group a newer alarm replaces the last.
# Each says what happened and the way back, in plain words: it reaches him as it is. When one
# clears, its Home Assistant notification comes down and both say so; until a hook takes it
# down, the clearing is kept and tried again. The state is root's, in /data/c1/notice.d. Nothing
# here runs without the lock: a writer that can't have it within 30 seconds exits 75, and the
# alarm is raised again by its caller or the next tick.
#   notice.sh tell <alarm> [cause]   raise it; raised already, only its repeats and retries run
#   notice.sh clear running          Cain runs again: the stop and session groups clear
#   notice.sh clear switched         Cain runs as his own user: every group clears
#   notice.sh tick                   the repeats, retries and the daily probe (every 10 minutes)
#   notice.sh probe                  the probe, now
#   notice.sh text <alarm> [cause]   an alarm's title and text, one line each (tests, docs)
# Exits 0 when done, 1 when something stays to be kept or sent (said on stderr), 2 on a wrong
# use, 75 when it couldn't have the lock.
set -uo pipefail
umask 077
OPT="${NOTICE_OPT:-/opt/cain}"
D="${NOTICE_DATA:-/data}"
DIR="${NOTICE_DIR:-$D/c1/notice.d}"
PROBED="${NOTICE_PROBED:-$D/c1/notice-probed}"
OPTIONS="${NOTICE_OPTIONS:-$D/options.json}"
URL="${NOTICE_URL:-http://homeassistant:8123}"
DAY="${NOTICE_DAY_S:-86400}"
GROUPS_ALL="stop session switch"

BACKUPS="restore two backups from just before his last update, Cain's and the calendar App's, one after the other: Settings, System, Backups"
RESTART="restart the Cain App: Settings, Apps, Cain, Restart"
DETAILS="The Cain App's log has the details."
group_of() {
  case "$1" in
    breach|switch-stopped|damaged|setup|restart|switch-restart|exited|held) echo stop ;;
    session) echo session ;;
    switch-failed|switch-waits) echo switch ;;
    *) return 1 ;;
  esac
}
alarm() {   # alarm <kind> [cause]: sets T (its title) and M (its text); 1 for no such alarm
  local c="${2:+ (${2})}"
  case "$1" in
    breach) T="Cain is stopped"
      M="Cain is stopped: a safety check of his own user failed after his update, so he won't run on this version. To get him back now, $BACKUPS. A fixed update also brings him back. $DETAILS" ;;
    switch-stopped) T="Cain is stopped"
      M="Cain is stopped: his move to a safer setup stopped part way. To get him back, $BACKUPS. $DETAILS" ;;
    damaged) T="Cain is stopped"
      M="Cain is stopped: his saved start state is damaged, so he isn't started. To get him back, $BACKUPS. $DETAILS" ;;
    setup) T="Cain is stopped"
      M="Cain is stopped: his App's safety setup didn't check out at start, so he isn't started. First $RESTART. If he's still stopped after that, $BACKUPS. $DETAILS" ;;
    restart) T="Cain is stopped for a moment"
      M="Cain is stopped for a moment: his App is restarting itself to start him clean. Nothing for you to do. If he isn't back within half an hour, $RESTART." ;;
    switch-restart) T="Cain is stopped for a moment"
      M="Cain's move to his own user, the safer setup in his update, didn't pass its checks${c}, so it was undone, and his App is restarting itself to run him the old way for now. Nothing for you to do. If he isn't back within half an hour, $RESTART." ;;
    exited) T="Cain is stopped"
      M="Cain is stopped: his App ran into something it couldn't get past and stopped itself. First $RESTART. If he's still stopped after that, $BACKUPS. $DETAILS" ;;
    held) T="Cain is paused"
      M="Cain is paused: the safety check of his own user couldn't finish, so his session is held. This isn't a breach. The App tries the check again every 10 minutes, and he comes back by himself once it finishes. If he isn't back within an hour, $BACKUPS. $DETAILS" ;;
    session) T="Cain isn't answering"
      M="Cain isn't answering: his session keeps stopping soon after it starts. The App keeps starting it again by itself. If he isn't back within an hour, $RESTART. $DETAILS" ;;
    switch-failed) T="Cain runs the old way for now"
      M="Cain's move to his own user, the safer setup in his update, didn't pass its checks${c}, so it was undone. He runs the old way for now and still answers you. Nothing for you to do: the App tries again by itself, at most three times in six hours." ;;
    switch-waits) T="Cain runs the old way for now"
      M="Cain's move to his own user didn't pass its checks three times${2:+ (the last: ${2})}, so the App waits six hours before it tries again. He runs the old way meanwhile and still answers you. Nothing for you to do." ;;
    *) return 1 ;;
  esac
}
cleared_text() {   # sets CT and CM, what a cleared alarm of a group says
  case "$1" in switch) CT="Cain moved to his own user"; CM="Cain now runs as his own user, the safer setup in his update." ;;
    *) CT="Cain is back"; CM="Cain is running again." ;; esac
}
# A cause, as it may go to him: one line, plain, short.
plain() { printf '%s' "$1" | tr '\r\n' '  ' | sed 's/ *\xe2\x80\x94 */, /g; s/add-on/App/g; s/  */ /g; s/ $//' | cut -c1-160; }

# A group's state: the alarm raised and its cause, when Home Assistant last had it and from which
# hook (its hash), whether Discord has it, whether Home Assistant shows a notification for the
# group (any alarm of it, a replaced one included: it stays to be taken down), and whether it has
# cleared (its notification still to come down).
load() {   # load <group>
  kind=""; cause=""; sent=0; fp=""; discord=0; clear=0; shown=0; G="$1"
  [ -f "$DIR/$G" ] || return 1
  local k v
  while IFS=' ' read -r k v; do
    case "$k" in kind) kind="$v" ;; cause) cause="$v" ;; sent) sent="$v" ;; fp) fp="$v" ;; discord) discord="$v" ;;
      clear) clear="$v" ;; shown) shown="$v" ;; esac
  done < "$DIR/$G"
  case "$sent" in ''|*[!0-9]*) sent=0 ;; esac
  [[ "$fp" =~ ^[0-9a-f]{16}$ ]] || fp=""
  [ "$shown" = 1 ] || shown=0
  [ "$(group_of "$kind" 2>/dev/null)" = "$G" ] && alarm "$kind" "$cause"
}
save() {
  if mkdir -p "$DIR" 2>/dev/null \
     && printf 'kind %s\ncause %s\nsent %s\nfp %s\ndiscord %s\nclear %s\nshown %s\n' "$kind" "$cause" "$sent" "$fp" "$discord" "$clear" "$shown" > "$DIR/.$G.tmp" 2>/dev/null \
     && mv -fT "$DIR/.$G.tmp" "$DIR/$G" 2>/dev/null; then return 0; fi
  rm -f "$DIR/.$G.tmp" 2>/dev/null
  echo "[cain] alarm '$kind': its state couldn't be kept ($DIR/$G), so its caller raises it again" >&2
  return 1
}

# The hook: the notice_hook option, a well-formed id, or none.
hook() {
  local h
  h="$(jq -r '.notice_hook // empty' "$OPTIONS" 2>/dev/null)" || return 1
  [[ "$h" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || return 1
  printf '%s' "$h"
}
hash16() { printf '%s' "$1" | sha256sum | cut -c1-16; }
ha_send() {   # ha_send <on|clear|test> <title> <text>: 0 once Home Assistant took it
  local h body
  h="$(hook)" || return 2
  body="$(jq -nc --arg s "$1" --arg g "$G" --arg a "$kind" --arg t "$2" --arg m "$3" \
    '{state: $s, group: $g, alarm: $a, title: $t, message: $m}')" || return 1
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

deliver() {   # a group's raised alarm: Discord once, Home Assistant daily or when its hook changed
  alarm "$kind" "$cause" || return 1
  local now h said="" missed=""
  if [ "$discord" != 1 ]; then
    if discord_send "$M"; then discord=1; said="his bot"; else missed="his bot"; fi
  fi
  now="$(date +%s)"
  if h="$(hook)"; then
    if [ "$fp" != "$(hash16 "$h")" ] || [ $((now - sent)) -ge "$DAY" ]; then
      if ha_send on "$T" "$M"; then sent="$now"; fp="$(hash16 "$h")"; shown=1; said="${said:+$said and }Home Assistant"
      else missed="${missed:+$missed and }Home Assistant"; fi
    fi
  else missed="${missed:+$missed and }Home Assistant (no notice_hook set)"; fi
  save || return 1
  [ -z "$said" ] || echo "[cain] alarm '$kind' sent to $said"
  [ -z "$missed" ] || echo "[cain] alarm '$kind' not yet through to $missed: tried again in 10 minutes" >&2
  return 0
}
finish_clear() {   # a group's cleared alarm: its notification comes down, then its state goes
  cleared_text "$G"
  if [ "$shown" != 1 ]; then rm -f "$DIR/$G"; echo "[cain] alarm '$kind' cleared"; return 0; fi
  if ha_send clear "$CT" "$CM"; then rm -f "$DIR/$G"; echo "[cain] alarm '$kind' cleared, and Home Assistant's notification came down"; return 0; fi
  echo "[cain] alarm '$kind' cleared, but Home Assistant's notification is still up: taking it down is tried again in 10 minutes" >&2
  return 1
}

tell() {   # tell <kind> [cause]
  local g c
  g="$(group_of "$1")" || { echo "notice: no alarm called '$1'" >&2; return 2; }
  c="$(plain "${2:-}")"
  if load "$g" && [ "$kind" = "$1" ] && [ "$cause" = "$c" ] && [ "$clear" != 1 ]; then deliver; return; fi
  # A new alarm for the group: delivered afresh, but what Home Assistant shows for the group is
  # kept (shown), so a notification of the alarm it replaces still comes down when it clears.
  G="$g"; kind="$1"; cause="$c"; sent=0; fp=""; discord=0; clear=0
  deliver
}
clear_groups() {   # clear_groups running|switched
  local groups g rc=0
  case "$1" in running) groups="stop session" ;; switched) groups="$GROUPS_ALL" ;; *) echo "notice: clear running or switched" >&2; return 2 ;; esac
  for g in $groups; do
    load "$g" || continue
    if [ "$clear" != 1 ]; then
      clear=1; cleared_text "$G"
      save || { rc=1; continue; }
      if [ "$discord" = 1 ]; then discord_send "$CM" || echo "[cain] alarm '$kind' cleared, but his bot couldn't say so" >&2; fi
    fi
    finish_clear || rc=1
  done
  return "$rc"
}
probe() {   # no notification: Home Assistant's automation only notes the time
  local now; now="$(date +%s)"
  G="probe"; kind="probe"
  if ha_send test "" ""; then printf '%s\n' "$now" > "$PROBED.tmp" && mv -f "$PROBED.tmp" "$PROBED"; echo "[cain] alarms: Home Assistant's webhook took the probe"; return 0; fi
  echo "[cain] alarms: Home Assistant's webhook didn't take the probe (no notice_hook set, or Home Assistant didn't answer)" >&2
  return 1
}
tick() {
  local rc=0 last g
  last="$(head -c 20 "$PROBED" 2>/dev/null | tr -cd '0-9' || true)"
  if [ $(( $(date +%s) - ${last:-0} )) -ge "$DAY" ]; then probe || true; fi
  for g in $GROUPS_ALL; do
    load "$g" || continue
    if [ "$clear" = 1 ]; then finish_clear || rc=1; else deliver || rc=1; fi
  done
  return "$rc"
}

case "${1:-}" in tell|clear|tick|probe) ;; text) alarm "${2:-}" "$(plain "${3:-}")" || exit 2; printf '%s\n%s\n' "$T" "$M"; exit 0 ;;
  *) echo "usage: notice.sh tell <alarm> [cause] | clear running|switched | tick | probe | text <alarm> [cause]" >&2; exit 2 ;; esac
# One writer at a time: the start, the check and the ticks may all call it, and none goes on
# without the lock.
mkdir -p "$DIR" 2>/dev/null && exec 9>"$DIR/.lock" \
  || { echo "[cain] alarms: no place for their state ($DIR)" >&2; exit 75; }
flock -w "${NOTICE_LOCK_S:-30}" 9 || { echo "[cain] alarms: another writer kept the lock; this one is raised again by its caller or the next tick" >&2; exit 75; }
case "$1" in
  tell) tell "${2:-}" "${3:-}" ;;
  clear) clear_groups "${2:-}" ;;
  tick) tick ;;
  probe) probe ;;
esac
