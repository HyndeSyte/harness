#!/bin/bash
# The App's alarms to Dane, sent by root and never through his session, so they reach him when
# his session, the broker or Discord is what failed (C1 second review, must-fix 2):
#   - Discord: his bot, through alert.sh (root's copy of the token). Once per alarm, tried again
#     at each tick until it goes through.
#   - Home Assistant: a local webhook whose id is the App's notice_hook option, a random id only
#     root here and Home Assistant's admins know (never one Cain could work out). One automation
#     there turns each post into a push to his phone only, tagged by group so the next replaces
#     it (no persistent notification: every Home Assistant user in the house sees those); that is
#     all the webhook can reach (DOCS.md, "If Cain stops"). The App keeps homeassistant_api off on
#     purpose: the Supervisor's own route to a notification needs it, and it would hand every
#     root process here, and the old way's root session, the run of all of Home Assistant. Sent
#     again daily while the alarm lasts, and at once when the hook is set or changed. A probe
#     daily, and at once when the hook is set or changed (no notification: the automation only
#     notes the time in a helper, input_datetime.cain_alarms_checked), is read back without Dane
#     (Cain's fourth service review, must-fix 6): the App can't read Home Assistant itself (no API
#     access, above), so it asks Cain to read the helper through his read-only connector and write
#     what it says into his folder ($READ), and checks that against the probe's time. Shown to
#     move, the channel counts as proven ($PROVEN, which the move to his own user waits for: the
#     run script); read and not moved, Dane hears from his bot (the "phone" group) and Cain files
#     it for the laptop session. Until notice_hook is set, alarms go to Discord only, and reach
#     Home Assistant once it is.
# Alarms are kept per group, so one never erases another: "stop" (why he isn't running now:
# stopped, paused, or restarting), "session" (his session keeps ending), "switch" (his move to his
# own user failed; he runs the old way), "screen" (a question keeps coming back on his screen,
# where no one answers it: unstick.sh), "deliver" (what the App types into his session doesn't go
# in, or his screen waits at a sign-in: watch.sh) and "phone" (its alarms to his phone failed their
# test). Within a group a newer alarm replaces the last.
# Each says what happened, in plain words: it reaches him as it is, and hands him no step. A hard
# stop (breach, switch-stopped, damaged, exited, setup), where no automatic path exists, also names
# the backups, after "A fixed update also brings him back". The others the App deals with itself
# (Cain 0.13.3): "restart", "switch-blocked", "held", "session", "waiting" and "stalled" are kept
# for the App and reach no one at first. Still on with no clear after their window (30 minutes for
# a switch or restart, an hour for the others), the run script's watcher has the Supervisor restart
# the App, once (notice.sh restart-due), and only when the alarm is raised again after that
# restart and still stands a window later does it reach Dane, saying the App restarted itself and
# what it saw. A switch that undid itself safely and runs him the old way ("switch-restart") posts
# no alarm at all: one line goes to Cain through the relay queue, for his morning update. When one
# clears, "Cain is back" replaces its push and both say so; until a hook takes it, the clearing
# is kept and tried again. The state is root's, in /data/c1/notice.d. Nothing
# here runs without the lock: a writer that can't have it within 30 seconds exits 75, and the
# alarm is raised again by its caller or the next tick.
#   notice.sh tell <alarm> [cause]   raise it; raised already, only its repeats and retries run
#   notice.sh clear running          Cain runs again: the stop and session groups clear
#   notice.sh clear switched         Cain runs as his own user: those and the switch group clear
#   notice.sh clear screen           his prompt is back (unstick.sh): the screen group clears
#   notice.sh clear delivered        what the App types goes in again (watch.sh): the deliver group
#   notice.sh clear phone            the probe was read back moved: the phone group clears
#   notice.sh tick                   the repeats, retries, the probe and its readback (every 10 minutes)
#   notice.sh probe                  the probe, now
#   notice.sh proven                 0 when a probe was read back moved within two days (no lock)
#   notice.sh hooked                 0 when notice_hook is set, well formed (no lock)
#   notice.sh restart-due            the groups whose alarm is due the App's one restart, marked as
#                                    restarted, one a line (exit 1 when none): the run script's
#                                    watcher then asks the Supervisor for it
#   notice.sh restart-undo <group>.. the Supervisor didn't take that restart: unmarked, so it's due again
#   notice.sh text <alarm> [cause] [restarted at, epoch]   an alarm's title and text, one line each
#                                    (tests, docs); with a time, the text after the App's restart
# Exits 0 when done, 1 when something stays to be kept or sent (said on stderr), 2 on a wrong
# use, 75 when it couldn't have the lock.
set -uo pipefail
umask 077
OPT="${NOTICE_OPT:-/opt/cain}"
D="${NOTICE_DATA:-/data}"
DIR="${NOTICE_DIR:-$D/c1/notice.d}"
PROBED="${NOTICE_PROBED:-$D/c1/notice-probed}"   # "<when> <hook's hash>": the last probe Home Assistant took
PROVEN="${NOTICE_PROVEN:-$D/c1/notice-proven}"   # "<when> <hook's hash>": the last probe read back moved
READ="${NOTICE_READ:-$D/work/alarms-checked}"    # Cain's reading of the helper: his file
QUEUE="${RELAY_QUEUE:-$D/relay.queue}"
OPTIONS="${NOTICE_OPTIONS:-$D/options.json}"
URL="${NOTICE_URL:-http://homeassistant:8123}"
DAY="${NOTICE_DAY_S:-86400}"
GROUPS_ALL="stop session switch screen deliver phone"
WINDOW_S="${NOTICE_WINDOW_S:-3600}"               # an alarm the App deals with itself: an hour
SWITCH_WINDOW_S="${NOTICE_SWITCH_WINDOW_S:-1800}" # 30 minutes for a switch or restart
export TZ="${CHECKIN_TZ:-America/New_York}"

BACKUPS="restore two backups from just before his last update, Cain's and the calendar App's, one after the other: Settings, System, Backups"
DETAILS="The Cain App's log has the details."
HARD="A fixed update also brings him back. To get him back now, $BACKUPS."
# The alarms the App deals with itself, by restarting itself once, and their windows.
self_heals() { case "$1" in restart|switch-blocked|held|session|waiting|stalled) return 0 ;; *) return 1 ;; esac; }
window_of() { case "$1" in restart|switch-blocked) echo "$SWITCH_WINDOW_S" ;; *) echo "$WINDOW_S" ;; esac; }
at() { date -d "@$1" '+%-I:%M %p' 2>/dev/null || echo "a while ago"; }
group_of() {
  case "$1" in
    breach|switch-stopped|switch-blocked|damaged|setup|restart|switch-restart|exited|held) echo stop ;;
    session) echo session ;;
    switch-failed|switch-waits) echo switch ;;
    waiting) echo screen ;;
    stalled|signin) echo deliver ;;
    phone) echo phone ;;
    *) return 1 ;;
  esac
}
alarm() {   # alarm <kind> [cause] [restarted at]: sets T (its title) and M (its text); 1 for no such alarm.
  # With a restart time, the text Dane gets once the App's own restart didn't clear it.
  local c="${2:+ (${2})}" r="${3:-}"
  [ "${r:-0}" != 0 ] || r=""
  case "$1" in
    breach) T="Cain is stopped"
      M="Cain is stopped: a safety check of his own user failed after his update, so he won't run on this version. $HARD $DETAILS" ;;
    switch-stopped) T="Cain is stopped"
      M="Cain is stopped: his move to a safer setup stopped part way. $HARD $DETAILS" ;;
    damaged) T="Cain is stopped"
      M="Cain is stopped: his saved start state is damaged, so he isn't started. $HARD $DETAILS" ;;
    setup) T="Cain is stopped"
      M="Cain is stopped: his App's safety setup didn't check out at start, so he isn't started. $HARD $DETAILS" ;;
    exited) T="Cain is stopped"
      M="Cain is stopped: his App ran into something it couldn't get past and stopped itself. $HARD $DETAILS" ;;
    restart) if [ -n "$r" ]; then T="Cain is still stopped"
        M="Cain is still stopped: his App needed a fresh start to run him clean${c}, so it restarted itself at $(at "$r"), and he still isn't back after that. The App keeps trying by itself. $DETAILS"
      else T="Cain is stopped for a moment"
        M="Cain is stopped for a moment: his App is restarting itself to start him clean${c}. Nothing for you to do."; fi ;;
    switch-restart) T="Cain's move waits for a fresh start"
      M="Cain's move to his own user, the safer setup in his update, didn't pass its checks${c}, so it was undone safely, and his App is restarting itself to run him the old way for now. Nothing for you to do." ;;
    held) if [ -n "$r" ]; then T="Cain is still paused"
        M="Cain is still paused: the safety check of his own user couldn't finish, so his session is held. This isn't a breach. The App restarted itself at $(at "$r") to clear it, and the check still couldn't finish after that. It tries again every 10 minutes, and he comes back by himself once it finishes. $DETAILS"
      else T="Cain is paused"
        M="Cain is paused: the safety check of his own user couldn't finish, so his session is held. This isn't a breach. The App tries the check again every 10 minutes, and he comes back by himself once it finishes. Nothing for you to do."; fi ;;
    session) if [ -n "$r" ]; then T="Cain still isn't answering"
        M="Cain still isn't answering: his session keeps stopping soon after it starts. The App restarted itself at $(at "$r") to clear it, and it kept happening after that. It keeps starting his session again by itself. $DETAILS"
      else T="Cain isn't answering"
        M="Cain isn't answering: his session keeps stopping soon after it starts. The App keeps starting it again by itself. Nothing for you to do."; fi ;;
    switch-failed) T="Cain is back on the old way for now"
      M="Cain's move to his own user, the safer setup in his update, didn't pass its checks${c}, so it was undone and his App went back to the old way. Nothing for you to do: the App tries again by itself, at most three times in six hours. If he doesn't answer you, you'll hear that too." ;;
    switch-waits) T="Cain is back on the old way for now"
      M="Cain's move to his own user didn't pass its checks three times${2:+ (the last: ${2})}, so his App went back to the old way and waits six hours before it tries again. Nothing for you to do. If he doesn't answer you, you'll hear that too." ;;
    switch-blocked) if [ -n "$r" ]; then T="Cain is still stopped"
        M="Cain is still stopped: his move to his own user couldn't begin${c}, and his App couldn't put that on record, so it stopped him rather than carry on unrecorded. The move changed nothing. The App restarted itself at $(at "$r") to try again, and he still isn't back after that. $DETAILS"
      else T="Cain is stopped"
        M="Cain is stopped: his move to his own user couldn't begin${c}, and his App couldn't put that on record, so it stopped him rather than carry on unrecorded. The move changed nothing, and the App restarts itself to try again. Nothing for you to do."; fi ;;
    waiting) if [ -n "$r" ]; then T="Cain still isn't answering"
        M="Cain still isn't answering: a question keeps waiting on his screen, where no one answers it. The App restarted itself at $(at "$r") to clear it, and it came back after that. $DETAILS"
      else T="Cain isn't answering"
        M="Cain isn't answering: a question is waiting on his screen, where no one answers it, and the App couldn't clear it yet. It restarts itself to clear it. Nothing for you to do."; fi ;;
    stalled) if [ -n "$r" ]; then T="Cain still isn't getting messages"
        M="Cain still isn't getting messages: what the App types into his session (your taps, his check-ins) doesn't go in${c}. The App restarted itself at $(at "$r") to clear it, and it still doesn't go in after that. It keeps trying by itself. $DETAILS"
      else T="Cain isn't getting messages"
        M="Cain isn't getting messages: what the App types into his session (your taps, his check-ins) hasn't gone in for a while${c}. The App keeps trying, and clears what it can by itself. Nothing for you to do."; fi ;;
    signin) T="Cain is waiting at a sign-in"
      M="Cain is waiting at a sign-in on his screen${c}, so nothing reaches him. Open Cain in Home Assistant, tap Sign in to Claude, and paste the code it gives you into the Cain page." ;;
    phone) T="Cain's alarms reach you here only"
      M="Cain's alarms to your phone through Home Assistant didn't pass their test${c}, so for now they reach you only here, from his bot. Nothing for you to do: Cain has it filed for a fix." ;;
    *) return 1 ;;
  esac
}
cleared_text() {   # sets CT and CM, what a cleared alarm of a group says
  case "$1" in switch) CT="Cain moved to his own user"; CM="Cain now runs as his own user, the safer setup in his update." ;;
    screen) CT="Cain is back"; CM="Cain is answering again: nothing waits on his screen." ;;
    deliver) CT="Cain is getting messages again"; CM="Cain is getting messages again: what the App types goes in." ;;
    phone) CT="Cain's alarms reach your phone again"; CM="Cain's alarms to your phone through Home Assistant passed their test again." ;;
    *) CT="Cain is back"; CM="Cain is running again." ;; esac
}
# A cause, as it may go to him: one line, plain, short.
plain() { printf '%s' "$1" | tr '\r\n' '  ' | sed 's/ *\xe2\x80\x94 */, /g; s/add-on/App/g; s/  */ /g; s/ $//' | cut -c1-160; }

# A group's state: the alarm raised and its cause, when Home Assistant last had it and from which
# hook (its hash), whether Discord has it, whether Home Assistant shows a notification for the
# group (any alarm of it, a replaced one included: it stays to be taken down), and whether it has
# cleared (its notification still to come down).
load() {   # load <group>
  kind=""; cause=""; sent=0; fp=""; discord=0; clear=0; shown=0; since=0; seen=0; restarted=0; esc=0; G="$1"
  [ -f "$DIR/$G" ] || return 1
  local k v
  while IFS=' ' read -r k v; do
    case "$k" in kind) kind="$v" ;; cause) cause="$v" ;; sent) sent="$v" ;; fp) fp="$v" ;; discord) discord="$v" ;;
      clear) clear="$v" ;; shown) shown="$v" ;; since) since="$v" ;; seen) seen="$v" ;; restarted) restarted="$v" ;;
      esc) esc="$v" ;; esac
  done < "$DIR/$G"
  case "$sent" in ''|*[!0-9]*) sent=0 ;; esac
  # Kept from before 0.13.3 (no since): raised when its file was last written.
  case "$since" in ''|0|*[!0-9]*) since="$(stat -c %Y "$DIR/$G" 2>/dev/null || date +%s)" ;; esac
  case "$seen" in ''|*[!0-9]*) seen=0 ;; esac
  case "$restarted" in ''|*[!0-9]*) restarted=0 ;; esac
  [ "$esc" = 1 ] || esc=0
  [[ "$fp" =~ ^[0-9a-f]{16}$ ]] || fp=""
  [ "$shown" = 1 ] || shown=0
  [ "$(group_of "$kind" 2>/dev/null)" = "$G" ] && alarm "$kind" "$cause" "$(escalated_at)"
}
save() {
  if mkdir -p "$DIR" 2>/dev/null \
     && printf 'kind %s\ncause %s\nsent %s\nfp %s\ndiscord %s\nclear %s\nshown %s\nsince %s\nseen %s\nrestarted %s\nesc %s\n' \
          "$kind" "$cause" "$sent" "$fp" "$discord" "$clear" "$shown" "$since" "$seen" "$restarted" "$esc" > "$DIR/.$G.tmp" 2>/dev/null \
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

# The restart time an escalated alarm's text names; none while the App still deals with it.
escalated_at() { if [ "$esc" = 1 ]; then echo "$restarted"; fi; }
deliver() {   # a group's raised alarm: Discord once, Home Assistant daily or when its hook changed
  alarm "$kind" "$cause" "$(escalated_at)" || return 1
  # One the App deals with itself reaches no one until its own restart didn't clear it.
  if self_heals "$kind" && [ "$esc" != 1 ]; then save; return; fi
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

# Within a group, an alarm doesn't give way to a lesser one while it stands: a breach isn't
# replaced by the App stopping itself after it, say (C1 fourth outside round). Its repeats run
# instead. The same rank, or a greater, replaces it.
rank() {
  case "$1" in breach) echo 6 ;; switch-stopped) echo 5 ;; switch-blocked|damaged) echo 4 ;; setup) echo 3 ;; exited) echo 2 ;;
    held|switch-restart|session|switch-waits|waiting|stalled|signin|phone) echo 1 ;; *) echo 0 ;; esac
}
tell() {   # tell <kind> [cause]
  local g c r=0 e=0 now
  g="$(group_of "$1")" || { echo "notice: no alarm called '$1'" >&2; return 2; }
  c="$(plain "${2:-}")"
  now="$(date +%s)"
  # A switch undone safely, the App restarting to run him the old way: no alarm for Dane. Cain
  # hears it once, for his morning update (the relay queue, as the App's other lines reach him).
  if [ "$1" = switch-restart ]; then
    [ -f "$DIR/switch-restart-told" ] && [ "$(head -n 1 "$DIR/switch-restart-told" 2>/dev/null)" = "$c" ] && return 0
    relay "The Cain App's move to your own user didn't pass its checks${c:+ ($c)}, so it was undone safely and the App restarted itself to run you the old way for now. The App told Dane nothing: put it in your morning update to him, in one line, with nothing for him to do. File it as a note on P33 for the laptop session." \
      || { echo "[cain] alarm 'switch-restart': its line for Cain couldn't be queued ($QUEUE), so its caller raises it again" >&2; return 1; }
    printf '%s\n' "$c" > "$DIR/switch-restart-told"
    echo "[cain] alarm 'switch-restart' passed to Cain for his morning update; nothing goes to Dane"
    return 0
  fi
  if load "$g" && [ "$clear" != 1 ]; then
    seen="$now"
    if [ "$kind" = "$1" ] && [ "$cause" = "$c" ]; then deliver; return; fi
    if [ "$(rank "$1")" -lt "$(rank "$kind")" ]; then
      echo "[cain] alarm '$1' kept back: '$kind' stands" >&2
      deliver; return
    fi
    # The App's one restart for this stretch, and whether Dane already heard it didn't help,
    # carry over to the alarm that replaces it: never a second restart for the same trouble.
    if self_heals "$1" && self_heals "$kind"; then r="$restarted"; e="$esc"; fi
  fi
  # A new alarm for the group: delivered afresh, but what Home Assistant shows for the group is
  # kept (shown), so a notification of the alarm it replaces still comes down when it clears.
  G="$g"; kind="$1"; cause="$c"; sent=0; fp=""; discord=0; clear=0; since="$now"; seen="$now"; restarted="$r"; esc="$e"
  if self_heals "$kind" && [ "$esc" != 1 ]; then
    echo "[cain] alarm '$kind' kept for the App: it restarts itself if this lasts $(( $(window_of "$kind") / 60 )) minutes, and Dane hears only if that doesn't clear it"
  fi
  deliver
}
# The groups whose alarm is due the App's one restart: on, not cleared, past its window and not
# restarted for yet. Marked restarted before the watcher asks the Supervisor, so it's asked once.
restart_due() {
  local g now any=1
  now="$(date +%s)"
  for g in stop session screen deliver; do
    load "$g" || continue
    [ "$clear" != 1 ] && self_heals "$kind" && [ "$restarted" = 0 ] || continue
    [ $((now - since)) -ge "$(window_of "$kind")" ] || continue
    restarted="$now"; save || continue
    echo "[cain] alarm '$kind' still on after $(( $(window_of "$kind") / 60 )) minutes: the App restarts itself, once" >&2
    echo "$g"; any=0
  done
  return "$any"
}
restart_undo() {
  local g
  for g in "$@"; do
    case " stop session screen deliver " in *" $g "*) ;; *) continue ;; esac
    load "$g" || continue
    restarted=0; save
  done
}
# After the App's restart: an alarm raised again since, and still on a window later, reaches Dane
# (its text says the App restarted itself and what it saw). One not raised again since the
# restart, two windows on, was cleared by it and is forgotten.
after_restart() {
  local now w
  self_heals "$kind" && [ "$restarted" != 0 ] && [ "$esc" != 1 ] || return 0
  now="$(date +%s)"; w="$(window_of "$kind")"
  if [ "$seen" -gt "$restarted" ] && [ $((now - restarted)) -ge "$w" ]; then
    esc=1; discord=0; sent=0
    echo "[cain] alarm '$kind' came back after the App restarted itself: Dane hears it now"
  elif [ "$seen" -le "$restarted" ] && [ $((now - restarted)) -ge $((2 * w)) ]; then
    rm -f -- "${DIR:?}/${G:?}"; echo "[cain] alarm '$kind' wasn't raised again after the App restarted itself: forgotten"
    return 1
  fi
  return 0
}
clear_groups() {   # clear_groups running|switched|screen|delivered|phone
  local groups g rc=0
  case "$1" in running) groups="stop session" ;; switched) groups="stop session switch" ;; screen) groups="screen" ;;
    delivered) groups="deliver" ;; phone) groups="phone" ;;
    *) echo "notice: clear running, switched, screen, delivered or phone" >&2; return 2 ;; esac
  case "$1" in running|switched) rm -f -- "${DIR:?}/switch-restart-told" ;; esac
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
# A line for Cain, typed into his session by checkin.sh once his prompt is free.
relay() { local l; l="$(jq -cn --arg t "$1" '{text: $t}')" && printf '%s\n' "$l" >> "$QUEUE"; }
# His files are read as him the new way (the run script sets CAIN_AS), so no link of his leads root.
as_him() { if [ -n "${CAIN_AS:-}" ]; then timeout -k 2 20 $CAIN_AS "$@"; else timeout -k 2 20 "$@"; fi; }
probe() {   # no notification: Home Assistant's automation only notes the time, which Cain reads back
  local now h
  now="$(date +%s)"
  G="probe"; kind="probe"
  if ha_send test "" ""; then
    h="$(hook)" || h=""
    printf '%s %s\n' "$now" "$(hash16 "$h")" > "$PROBED.tmp" && mv -f "$PROBED.tmp" "$PROBED"
    echo "[cain] alarms: Home Assistant's webhook took the probe; Cain is asked to read it back"
    relay "The App sent its alarm channel's daily test to Home Assistant at $(date -d "@$now" '+%-I:%M %p'). Through your Home Assistant connector, read input_datetime.cain_alarms_checked, and write its last_changed time, exactly as the connector gives it and nothing else, into $READ (the whole file). Nothing to tell him." \
      || echo "[cain] alarms: the readback couldn't be asked of Cain ($QUEUE)" >&2
    return 0
  fi
  echo "[cain] alarms: Home Assistant's webhook didn't take the probe (no notice_hook set, or Home Assistant didn't answer)" >&2
  return 1
}
# What Cain read back for the last probe Home Assistant took: 0 it moved (to the probe's time or
# later: Home Assistant runs on the same clock and sets it after the probe was sent, so no slack,
# and an earlier probe's time never passes for this one: outside round 24), 1 it didn't (his
# reading, written after the probe, is older), 2 nothing to go on yet (no probe, no reading since
# it, or one that isn't a time: a time later than his file was written can't have been read, so
# it proves nothing).
readback() {
  local t m r s
  t="$(head -n 1 "$PROBED" 2>/dev/null | cut -d' ' -f1 | tr -cd '0-9')"; [ -n "$t" ] || return 2
  m="$(as_him stat -c %Y "$READ" 2>/dev/null | tr -cd '0-9')"
  { [ -n "$m" ] && [ "$m" -ge "$t" ]; } || return 2
  r="$(as_him head -c 100 "$READ" 2>/dev/null | head -n 1 | tr -cd '0-9:T .+Z-')"
  [ -n "$r" ] && s="$(date -d "$r" +%s 2>/dev/null)" || return 2
  [ "$s" -le $((m + 60)) ] || return 2
  [ "$s" -ge "$t" ] && return 0
  return 1
}
check_readback() {
  local t f rb=0
  readback || rb=$?
  t="$(head -n 1 "$PROBED" 2>/dev/null | cut -d' ' -f1 | tr -cd '0-9')"
  f="$(head -n 1 "$PROBED" 2>/dev/null | cut -s -d' ' -f2 | tr -cd '0-9a-f')"
  case "$rb" in
    # Kept with the hook it was made with: a proof counts only while that hook is the one set.
    0) if [ "$(head -n 1 "$PROVEN" 2>/dev/null)" != "$t $f" ]; then
         { printf '%s %s\n' "$t" "$f" > "$PROVEN.tmp" && mv -f "$PROVEN.tmp" "$PROVEN"; } 2>/dev/null \
           && echo "[cain] alarms: Cain read the helper moved by the probe: the channel to his phone works"
       fi
       clear_groups phone ;;
    1) # Once for each probe: Dane hears from his bot (the phone group), Cain files it.
       [ "$(head -n 1 "$DIR/phone-told" 2>/dev/null)" = "$t" ] && return 0
       tell phone "the helper didn't move" || return 1
       relay "The App's daily test of its alarm channel to his phone failed: input_datetime.cain_alarms_checked didn't move. File it as a note on P33 for the laptop session. Nothing to tell him: the App told him itself." \
         || echo "[cain] alarms: the failed test couldn't be passed to Cain ($QUEUE)" >&2
       printf '%s\n' "$t" > "$DIR/phone-told" ;;
  esac
  return 0
}
tick() {
  local rc=0 last fp="" fp_last g h
  last="$(head -n 1 "$PROBED" 2>/dev/null | cut -d' ' -f1 | tr -cd '0-9' || true)"
  fp_last="$(head -n 1 "$PROBED" 2>/dev/null | cut -s -d' ' -f2 || true)"
  if h="$(hook)"; then fp="$(hash16 "$h")"; fi
  # Daily, and at once when the hook is set or changed (the move to his own user waits for it).
  if [ $(( $(date +%s) - ${last:-0} )) -ge "$DAY" ] || { [ -n "$fp" ] && [ "$fp" != "$fp_last" ]; }; then probe || true; fi
  check_readback || rc=1
  for g in $GROUPS_ALL; do
    load "$g" || continue
    if [ "$clear" = 1 ]; then finish_clear || rc=1; continue; fi
    after_restart || continue
    deliver || rc=1
  done
  return "$rc"
}

case "${1:-}" in tell|clear|tick|probe|restart-due|restart-undo) ;;
  text) alarm "${2:-}" "$(plain "${3:-}")" "${4:-}" || exit 2; printf '%s\n%s\n' "$T" "$M"; exit 0 ;;
  # A proof within two days, made with the hook set now (none set, or another, proves nothing).
  proven) t="$(head -n 1 "$PROVEN" 2>/dev/null | cut -d' ' -f1 | tr -cd '0-9')"
          f="$(head -n 1 "$PROVEN" 2>/dev/null | cut -s -d' ' -f2)"; h="$(hook)" || exit 1
          [ -n "$t" ] && [ "$f" = "$(hash16 "$h")" ] && [ $(( $(date +%s) - t )) -le $((2 * DAY)) ]; exit ;;
  hooked) hook >/dev/null; exit ;;
  *) echo "usage: notice.sh tell <alarm> [cause] | clear running|switched|screen|delivered|phone | tick | probe | restart-due | restart-undo <group>... | proven | hooked | text <alarm> [cause] [restarted at]" >&2; exit 2 ;; esac
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
  restart-due) restart_due ;;
  restart-undo) shift; restart_undo "$@" ;;
esac
