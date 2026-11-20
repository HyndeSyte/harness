#!/bin/bash
# The Pi drills for Cain 0.14.0's alarms, in order, for the owner's assistant to run on the real Pi
# from a shell that can reach Docker (Home Assistant's SSH App with protection mode off). Not shipped
# in the image. This release only alarms: nothing here restores or rolls back anything.
#
#   probe-drill.sh 1    the boundary, as uid 1000 (Cain's own user): reading the Supervisor's token,
#                       the probe's records and marks and the link's gateway state file must each
#                       fail, nothing under /run/cain/probe may be written, and /run/cain must not list.
#   probe-drill.sh 1b   uid 1000 kills its own session 6 times, each after it has run over 5 minutes:
#                       no early exit is counted, no "Cain's session keeps exiting early", and "Cain's
#                       session keeps ending on its own" is raised once (more than 4 in an hour).
#   probe-drill.sh 2    the Nov 19 replay: his session killed within a minute of each start, more than
#                       3 times in 30 minutes: "Cain's session keeps exiting early" must fire.
#   probe-drill.sh 3    kill the plugin, close his session, cut the network for 15 minutes: each alarm
#                       must be raised and then cleared.
#   probe-drill.sh 4    an API outage and a reboot: no false alarm (prints the steps, then checks).
#   probe-drill.sh 5    how stops are classed (sixth round), three parts, each checking what /data keeps
#                       and the alarms:
#                       5 ha     an intentional shutdown from Home Assistant: Restart the App 4 times
#                                within 30 minutes (and an update, if one is waiting): every start kept
#                                as "asked" or "update", no container-start alarm, no early exit counted,
#                                and each stop inside the Supervisor's 30 seconds (prints the steps,
#                                then checks: probe-drill.sh 5 ha check <start>);
#                       5 kill   an abrupt termination (docker kill, SIGKILL to the whole container):
#                                the next start is kept as "boot", never "asked", and no stop mark stays;
#                       5 s6     an s6-only restart of the run script (s6-svc -r): the same container,
#                                no new start counted, and the stop mark it leaves is cleared by the
#                                run script's next start.
#
# Each step prints what it does and ends with PASS or FAIL. Nothing here reads or prints a key, a
# token or a heartbeat URL.
set -uo pipefail
C="${CAIN_CONTAINER:-addon_0fcc2575_cain}"
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
in_c() { docker exec "$C" "$@"; }
as_cain() { docker exec -u 1000 "$C" "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
command -v docker >/dev/null || { echo "FAIL: no docker here (use Home Assistant's SSH App with protection mode off)"; exit 2; }
in_c true 2>/dev/null || { echo "FAIL: no running container $C"; exit 2; }

alarm_up() { in_c test -s "/data/c1/notice.d/$1" 2>/dev/null && ! in_c grep -q '^clear 1' "/data/c1/notice.d/$1" 2>/dev/null; }
wait_for() {   # wait_for <seconds> <command...>: 0 once the command passes
  local limit="$1" t0; shift; t0=$(date +%s)
  until "$@"; do [ $(( $(date +%s) - t0 )) -lt "$limit" ] || return 1; sleep 15; done
}
starts_since() { in_c awk -v s="$1" '$1 >= s' /data/probe/starts; }
kill_his_session() { as_cain tmux -S /run/cain/tmux/cain.sock kill-session -t cain 2>/dev/null || true; }
wait_session_up() { wait_for "${1:-300}" as_cain tmux -S /run/cain/tmux/cain.sock has-session -t cain; }

case "${1:-}" in
  1)
    say "step 1: the boundary, as uid 1000"
    ok=1
    for f in /run/s6/container_environment/SUPERVISOR_TOKEN /data/probe/starts /data/probe/boots /run/cain/probe/session.json /run/cain/link-gateway.state; do
      if as_cain sh -c "head -c 1 '$f' >/dev/null 2>&1"; then say "  READ $f: it must not be readable"; ok=0; else say "  refused: $f"; fi
    done
    for f in /run/cain/probe /run/cain/probe/asked /run/cain/probe/session.json /data/probe /data/probe/stop-asked; do
      if as_cain sh -c "[ -w '$f' ] || : > '$f'" 2>/dev/null; then say "  WROTE $f: nothing under the probe's folders may be writable"; ok=0; else say "  refused: writing $f"; fi
    done
    if as_cain sh -c 'ls /run/cain >/dev/null 2>&1'; then say "  LISTED /run/cain: it must not be listable"; ok=0; else say "  refused: listing /run/cain"; fi
    bad="$(in_c sh -c 'find /run/cain/probe /data/probe \( ! -user root -o -perm /077 \) -print' 2>/dev/null)"
    if [ -n "$bad" ]; then say "  not root's alone: $bad"; ok=0; else say "  every path under the probe's folders is root's alone"; fi
    [ "$ok" = 1 ] && echo "PASS: uid 1000 can't read the token, the probe's records or the gateway state, and can't write under the probe's folders" || fail "the boundary didn't hold (above)"
    ;;
  1b)
    say "step 1b: uid 1000 kills its own session 6 times, each after over 5 minutes"
    since=$(date +%s)
    for i in 1 2 3 4 5 6; do
      wait_session_up 600 || fail "his session didn't come back before kill $i"
      say "  kill $i: waiting 5 minutes 30 seconds, then his own user ends his session with an error"
      sleep 330
      as_cain sh -c 'pkill -9 -u 1000 -f "^claude " || pkill -9 -u 1000 claude' 2>/dev/null || true
      sleep 30
    done
    starts_since "$since"
    n="$(in_c awk -v s="$since" '$1 >= s && $2 ~ /^early-/' /data/probe/starts | wc -l)"
    [ "$n" = 0 ] || fail "$n of those ends counted as early exits"
    alarm_up restarts && fail "\"Cain's session keeps exiting early\" was raised"
    alarm_up self || fail "\"Cain's session keeps ending on its own\" wasn't raised"
    echo "PASS: six self-kills after the 5 minute mark counted no early exit, and \"keeps ending on its own\" was raised. Confirm on the phone it came once."
    ;;
  2)
    say "step 2: the Nov 19 replay, his session killed within a minute of each start"
    since=$(date +%s)
    for i in 1 2 3 4 5; do
      wait_session_up 600 || fail "his session didn't come back before kill $i"
      sleep 40
      say "  kill $i"
      kill_his_session
    done
    wait_for 900 alarm_up restarts || fail "\"Cain's session keeps exiting early\" wasn't raised"
    starts_since "$since"
    say "  within a day of an update the line naming it comes too: $(alarm_up update && echo raised || echo not raised)"
    say "  raised; it comes down once the 30 minutes hold no more than 3 early exits"
    echo "PASS: the early exits alarmed. Confirm the push reached the phone, and that it clears within the hour."
    ;;
  3)
    say "step 3: the plugin killed, his session closed, the network cut"
    say "  3a: killing Cain's Discord plugin every 15 seconds until the probe's alarm"
    t0=$(date +%s)
    until alarm_up probe; do
      [ $(( $(date +%s) - t0 )) -lt 720 ] || fail "no probe alarm within 12 minutes of killing the plugin"
      in_c sh -c 'for p in /proc/[0-9]*; do grep -qa "discord/plugin/server.ts" "$p/cmdline" 2>/dev/null && kill "${p#/proc/}" 2>/dev/null; done; true' || true
      sleep 15
    done
    say "  raised after $(( $(date +%s) - t0 )) s; waiting for it to clear"
    wait_for 900 sh -c "! docker exec $C test -s /data/c1/notice.d/probe || docker exec $C grep -q '^clear 1' /data/c1/notice.d/probe" || fail "the probe alarm didn't clear within 15 minutes"
    say "  3b: closing his session once (as him); the App starts him again by itself"
    kill_his_session
    wait_session_up 300 || fail "his session didn't come back within 5 minutes"
    in_c tail -n 2 /data/probe/starts
    say "  3c: cutting the App's network for 15 minutes (docker network disconnect, put back after)"
    net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$C" | awk '{print $1}')"
    [ -n "$net" ] || fail "couldn't tell the App's network"
    trap 'docker network connect "$net" "$C" 2>/dev/null' EXIT
    docker network disconnect "$net" "$C" || fail "couldn't cut the network"
    sleep 900
    docker network connect "$net" "$C" || fail "couldn't put the network back: do it now, docker network connect $net $C"
    trap - EXIT
    say "  network back; the outside heartbeat check should have gone late meanwhile (confirm on the phone)"
    wait_for 900 sh -c "! docker exec $C test -s /data/c1/notice.d/probe || docker exec $C grep -q '^clear 1' /data/c1/notice.d/probe" || fail "the probe alarm didn't clear within 15 minutes of the network coming back"
    echo "PASS: each alarm was raised and cleared. Confirm the pushes reached the phone and the outside check went late."
    ;;
  4)
    since=$(date +%s)
    say "step 4: an API outage and a reboot cause no false alarm"
    cat <<'EOF'
  a. API outage: block the model's API from the App for 20 minutes (for example a firewall rule on
     the router for api.anthropic.com). Expected: "The model's API isn't answering" once, cleared
     after, and nothing else.
  b. Reboot the Pi (ha host reboot). Expected: the first start after the boot is "boot", one boot is
     counted, and no early-exit or container-start alarm.
Then run: probe-drill.sh 4 check <the time step 4 began, in epoch seconds>
EOF
    say "  this step began at $since"
    if [ "${2:-}" = check ]; then
      s="${3:?the time step 4 began}"
      starts_since "$s"
      n="$(in_c awk -v s="$s" '$1 >= s && $2 ~ /^early-/' /data/probe/starts | wc -l)"
      [ "$n" -le 3 ] || fail "$n early exits since step 4 began"
      alarm_up restarts && fail "\"Cain's session keeps exiting early\" is up"
      alarm_up boots && fail "\"Cain's App keeps restarting\" is up"
      echo "PASS: no early-exit or container-start alarm after the API outage and the reboot"
    fi
    ;;
  5)
    since=$(date +%s)
    boots_since() { in_c awk -v s="$1" '$1 >= s' /data/probe/boots; }
    case "${2:-}" in
      ha)
        say "step 5 ha: stops asked from Home Assistant never count"
        cat <<'EOF'
  In Home Assistant, Settings, Apps, Cain: tap Restart, wait until the log says Cain's start, and do
  it 4 times within 30 minutes (an update of the App, if one is waiting, counts as one of them). Time
  each stop: from the tap to the log's last line of the old container must be under 30 seconds.
  Expected: each start kept as "asked" (or "update") in /data/probe/boots, his session's first start
  in each container "boot", no "Cain's App keeps restarting" and no early exit counted.
Then run: probe-drill.sh 5 ha check <the time step 5 began, in epoch seconds>
EOF
        say "  this step began at $since"
        if [ "${3:-}" = check ]; then
          s="${4:?the time step 5 began}"
          boots_since "$s"
          n="$(in_c awk -v s="$s" '$1 >= s && $2 == "boot"' /data/probe/boots | wc -l)"
          [ "$n" = 0 ] || fail "$n container starts counted since step 5 began (each Restart should be kept as asked)"
          n="$(in_c awk -v s="$s" '$1 >= s && $2 ~ /^(early-|unseen)/' /data/probe/starts | wc -l)"
          [ "$n" = 0 ] || fail "$n early or unseen exits counted since step 5 began"
          alarm_up boots && fail "\"Cain's App keeps restarting\" is up"
          alarm_up restarts && fail "\"Cain's session keeps exiting early\" is up"
          alarm_up unseen && fail "\"Cain's session keeps restarting\" is up"
          echo "PASS: the asked stops counted nothing. Confirm each stop took under 30 seconds."
        fi
        ;;
      kill)
        say "step 5 kill: an abrupt termination is never asked"
        docker kill "$C" >/dev/null || fail "couldn't kill the container"
        say "  killed; start the App again from Home Assistant (Settings, Apps, Cain, Start) if the watchdog doesn't"
        wait_for 900 sh -c "docker exec $C awk -v s=$since '\$1 >= s' /data/probe/boots 2>/dev/null | grep -q ." \
          || fail "no new container start kept within 15 minutes"
        boots_since "$since"
        k="$(in_c awk -v s="$since" '$1 >= s {k=$2} END {print k}' /data/probe/boots)"
        [ "$k" = boot ] || fail "the start after docker kill was kept as \"$k\", not \"boot\""
        in_c test -e /data/probe/stop-asked && fail "a stop mark stayed after the start"
        alarm_up boots && say "  note: \"Cain's App keeps restarting\" is up (other starts in the last 30 minutes)"
        echo "PASS: the start after an abrupt termination was counted, and no stop mark stayed"
        ;;
      s6)
        say "step 5 s6: an s6-only restart of the run script"
        before="$(in_c cat /data/probe/boots 2>/dev/null | wc -l)"
        in_c sh -c 's6-svc -r /run/service/cain 2>/dev/null || /command/s6-svc -r /run/service/cain' \
          || fail "couldn't restart the run script (s6-svc -r /run/service/cain)"
        sleep 90
        in_c true || fail "the container stopped"
        after="$(in_c cat /data/probe/boots 2>/dev/null | wc -l)"
        [ "$after" = "$before" ] || fail "an s6-only restart was counted as a container start"
        in_c test -e /data/probe/stop-asked && fail "the stop mark the restart left wasn't cleared by the run script's next start"
        in_c test -e /run/cain/probe/term && fail "the TERM trap's nonce wasn't cleared"
        in_c awk -v s="$since" '$1 >= s' /data/probe/starts
        alarm_up boots && fail "\"Cain's App keeps restarting\" is up"
        alarm_up unseen && fail "\"Cain's session keeps restarting\" is up"
        echo "PASS: the s6-only restart counted no container start, and its stop mark was cleared"
        ;;
      *) echo "usage: probe-drill.sh 5 ha [check <start>] | 5 kill | 5 s6"; exit 2 ;;
    esac
    ;;
  *) echo "usage: probe-drill.sh 1|1b|2|3|4 [check ...] | 5 ha|kill|s6"; exit 2 ;;
esac
