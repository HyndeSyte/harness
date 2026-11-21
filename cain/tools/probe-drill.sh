#!/bin/bash
# The Pi drills for Cain's alarms (0.14.0, and 0.15.0's step 6), in order, for the owner's assistant to run on the real Pi
# from a shell that can reach Docker (Home Assistant's SSH App with protection mode off). Not shipped
# in the image. This release only alarms: nothing here restores or rolls back anything. Run them on
# the Pi after the install, before the alarms are relied on.
#
#   probe-drill.sh 0    the probe's folders (seventh round): each folder from /run/cain/probe and from
#                       /data/probe up to /, with its owner, its mode and the probe's verdict; any
#                       REFUSED line fails (the probe would refuse that folder and alarm).
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
#                       Each of the three prints the measured time the TERM trap and the finish
#                       script took for every stop since the step began (/data/probe/stop-times: the
#                       trap must stay under 6 seconds and the finish script under 4).
#
#   probe-drill.sh 6    (Cain 0.15.0) the plugin's server stopped under a live connection: started again
#                       within seconds by the broker, logged with its exit code, and his session never
#                       restarted for it.
#   probe-drill.sh 7    (Cain 0.15.0, second round) the exit route a self-restart falls back to: the App
#                       stops with exit code 3 and the Supervisor's watchdog starts it again within a
#                       minute. Needs the App's Watchdog switch on. The outside heartbeat hears it as a
#                       failure (expected), and the next start is kept as a plain boot. The App relies on
#                       this route only once this step has passed (DOCS.md).
#                       Third round, a release gate run first: the Supervisor's health probe. With the
#                       Watchdog switch on, it finds the address the Supervisor probes from (its
#                       container on the hassio network), checks it is inside 172.30.32.0/23, asks
#                       /health from the Supervisor's own container (200 wanted), and watches the App's
#                       log for 3 minutes: any "answered 404 to:" line fails it, naming the address.
#                       Fourth round: it also reads the Watchdog switch through the Supervisor's info
#                       call (must be on), and needs at least one /health 200 to the Supervisor's
#                       address in nginx's note of 200s (health-ok.log) during those 3 minutes.
#                       Nothing after it runs unless it passes. "probe-drill.sh 7 gate" runs it alone.
#
# Each step prints what it does and ends with PASS or FAIL. Nothing here reads or prints a key, a
# token or a heartbeat URL.
#
# The container (Cain 0.15.0): found by its name, app_<hash>_cain as Home Assistant names Apps now,
# falling back to addon_<hash>_cain; CAIN_CONTAINER=<name> picks one by hand. Every step first checks
# that each tool it uses is there, on this machine and in the container, and fails loudly naming the
# one that isn't (the image has no procps: no pkill, no ps; kills go through /proc).
#
# Kills (second round): only inside the target container (docker exec, so its own PID namespace: no
# process of the Pi or another App is seen), only the process whose executable and whole argument list
# are exactly the ones named, and never when more than one matches (an ambiguous match is refused and
# nothing is killed).
#
# Rerunning one step alone: each step stands on its own, so run only its number. For step 1b (six
# self-kills, about 40 minutes):
#   CAIN_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '^app_[A-Za-z0-9]+_cain$')" bash probe-drill.sh 1b
# or just `bash probe-drill.sh 1b` when one Cain container runs. Wait 60 minutes after an earlier 1b
# (or a 2) first, so its exits are out of the hour's window, or the "keeps ending" alarm is already up.
set -uo pipefail
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { echo "FAIL: $*"; exit 1; }
# Tools this machine needs for a step, and tools the container needs: each checked before the step starts.
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || { echo "FAIL: step ${STEP:-?} needs '$t' on this machine, and it isn't there"; exit 2; }; done; }
need_in() { local t; for t in "$@"; do docker exec "$C" sh -c "command -v '$t'" >/dev/null 2>&1 || { echo "FAIL: step ${STEP:-?} needs '$t' in the container $C, and it isn't there"; exit 2; }; done; }
STEP="${1:-}"
need docker date sleep grep awk
# The container by its name: app_<hash>_cain (Home Assistant's name for Apps now), then addon_<hash>_cain.
find_container() {
  local all c pat
  all="$(docker ps --format '{{.Names}}' 2>/dev/null; docker ps -a --format '{{.Names}}' 2>/dev/null)"
  for pat in '^app_[A-Za-z0-9]+_cain$' '^addon_[A-Za-z0-9]+_cain$'; do
    c="$(printf '%s\n' "$all" | grep -E "$pat" | head -n 1)"
    [ -z "$c" ] || { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
C="${CAIN_CONTAINER:-$(find_container || true)}"
[ -n "$C" ] || { echo "FAIL: no Cain container found (no app_*_cain or addon_*_cain in docker ps -a); set CAIN_CONTAINER=<name>"; exit 2; }
in_c() { docker exec "$C" "$@"; }
as_cain() { docker exec -u 1000 "$C" "$@"; }
in_c true 2>/dev/null || { echo "FAIL: no running container $C"; exit 2; }
# kill_exact's body, run inside the container: <signal> <executable> <argv...>. Prints killed:<pid>,
# none, or ambiguous:<count>; exits 0, 4 or 3.
KILL_EXACT='sig="$1"; exe="$(readlink -f "$2" 2>/dev/null || printf %s "$2")"; shift 2
want="$(printf "%s\n" "$@")"; n=0; hit=""
for p in /proc/[0-9]*; do
  [ "$(readlink "$p/exe" 2>/dev/null)" = "$exe" ] || continue
  [ "$(tr "\000" "\n" < "$p/cmdline" 2>/dev/null)" = "$want" ] || continue
  n=$((n + 1)); hit="${p#/proc/}"
done
if [ "$n" = 0 ]; then echo none; exit 4; fi
if [ "$n" != 1 ]; then echo "ambiguous:$n"; exit 3; fi
kill "-$sig" "$hit" && echo "killed:$hit"'
# kill_exact <as: root|cain> <signal> <executable> <argv...>: the one matching process in the container.
kill_exact() {
  local who="$1"; shift
  if [ "$who" = cain ]; then as_cain sh -c "$KILL_EXACT" kill_exact "$@"; else in_c sh -c "$KILL_EXACT" kill_exact "$@"; fi
}
# The exact processes the steps end: the plugin's server as the broker starts it, and Claude Code as
# session.sh starts it.
PLUGIN_SERVER=(/usr/local/bin/bun /usr/local/bin/bun /opt/cain/discord/plugin/server.ts)
CLAUDE_CODE=(/usr/local/bin/claude claude --permission-mode auto --channels plugin:discord@claude-plugins-official)
say "the Cain container: $C"

alarm_up() { in_c test -s "/data/c1/notice.d/$1" 2>/dev/null && ! in_c grep -q '^clear 1' "/data/c1/notice.d/$1" 2>/dev/null; }
wait_for() {   # wait_for <seconds> <command...>: 0 once the command passes
  local limit="$1" t0; shift; t0=$(date +%s)
  until "$@"; do [ $(( $(date +%s) - t0 )) -lt "$limit" ] || return 1; sleep 15; done
}
starts_since() { in_c awk -v s="$1" '$1 >= s' /data/probe/starts; }
kill_his_session() { as_cain tmux -S /run/cain/tmux/cain.sock kill-session -t cain 2>/dev/null || true; }
wait_session_up() { wait_for "${1:-300}" as_cain tmux -S /run/cain/tmux/cain.sock has-session -t cain; }
# The time each stop's TERM trap and finish script took since a moment (seventh round), as measured by
# the App itself from the shell's clock at their start; "none" when no stop ran its trap meanwhile.
stop_times() {
  local t
  t="$(in_c awk -v s="$1" '$1 >= s' /data/probe/stop-times 2>/dev/null)"
  if [ -n "$t" ]; then say "  stop timings since the step began (the trap must stay under 6000ms, the finish script under 4000ms):"
    printf '%s\n' "$t" | while read -r at what ms; do say "    $(date -d "@$at" '+%H:%M:%S' 2>/dev/null || echo "$at") $what $ms"; done
  else say "  stop timings since the step began: none (no stop ran the TERM trap)"; fi
}

case "${1:-}" in
  0)
    need_in bun
    say "step 0: the probe's folders and every folder above them, with each one's owner, mode and verdict"
    out="$(in_c bun /opt/cain/probe/main.ts folders 2>&1)" || fail "couldn't run the probe's folder check: $out"
    printf '%s\n' "$out"
    if printf '%s\n' "$out" | grep -q REFUSED; then fail "a folder above is refused (above): the probe would stop and alarm"; fi
    echo "PASS: both probe folders and every folder above them are the App's alone"
    ;;
  1)
    need_in sh head ls find
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
    need_in sh tr tmux awk readlink
    say "step 1b: uid 1000 kills its own session 6 times, each after over 5 minutes"
    since=$(date +%s)
    for i in 1 2 3 4 5 6; do
      wait_session_up 600 || fail "his session didn't come back before kill $i"
      say "  kill $i: waiting 5 minutes 30 seconds, then his own user ends his session with an error"
      sleep 330
      # Through /proc in the container (the image has no pkill): Claude Code, exactly as session.sh
      # starts it, ended by his own user with SIGKILL (an error exit); refused when not exactly one.
      killed="$(kill_exact cain 9 "${CLAUDE_CODE[@]}" 2>/dev/null)"
      case "$killed" in killed:*) ;; *) fail "kill $i: Claude Code's process wasn't exactly one (${killed:-no answer}), so nothing was killed" ;; esac
      say "  kill $i: ended process ${killed#killed:}"
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
    need_in tmux awk test
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
    need_in sh grep tmux tail test tr readlink
    say "step 3: the plugin killed, his session closed, the network cut"
    say "  3a: killing Cain's Discord plugin every 15 seconds until the probe's alarm"
    t0=$(date +%s)
    until alarm_up probe; do
      [ $(( $(date +%s) - t0 )) -lt 720 ] || fail "no probe alarm within 12 minutes of killing the plugin"
      r="$(kill_exact root TERM "${PLUGIN_SERVER[@]}" 2>/dev/null)"
      case "$r" in ambiguous:*) fail "more than one plugin server matched (${r#ambiguous:}), so nothing was killed" ;; esac
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
    need_in awk test
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
    need_in awk test cat
    [ "${2:-}" != s6 ] || need_in sh
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
          stop_times "$s"
          echo "PASS: the asked stops counted nothing. Confirm each stop took under 30 seconds."
        fi
        ;;
      kill)
        say "step 5 kill: an abrupt termination is never asked"
        docker kill "$C" >/dev/null || fail "couldn't kill the container"
        say "  killed; with the App's Watchdog switch on, the Supervisor starts it again by itself"
        wait_for 900 sh -c "docker exec $C awk -v s=$since '\$1 >= s' /data/probe/boots 2>/dev/null | grep -q ." \
          || fail "no new container start kept within 15 minutes"
        boots_since "$since"
        k="$(in_c awk -v s="$since" '$1 >= s {k=$2} END {print k}' /data/probe/boots)"
        [ "$k" = boot ] || fail "the start after docker kill was kept as \"$k\", not \"boot\""
        in_c test -e /data/probe/stop-asked && fail "a stop mark stayed after the start"
        alarm_up boots && say "  note: \"Cain's App keeps restarting\" is up (other starts in the last 30 minutes)"
        stop_times "$since"
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
        stop_times "$since"
        echo "PASS: the s6-only restart counted no container start, and its stop mark was cleared"
        ;;
      *) echo "usage: probe-drill.sh 5 ha [check <start>] | 5 kill | 5 s6"; exit 2 ;;
    esac
    ;;
  6)
    need_in sh tr cat grep tail readlink
    say "step 6: the plugin's server stopped once under his connection; the broker starts it again"
    since=$(date +%s)
    before="$(in_c awk -v s="$since" '$1 >= s' /data/probe/starts 2>/dev/null | wc -l)"
    r="$(kill_exact root TERM "${PLUGIN_SERVER[@]}" 2>/dev/null)"
    case "$r" in killed:*) say "  stopped the plugin's server (process ${r#killed:})" ;; *) fail "the plugin's server wasn't exactly one process (${r:-no answer}), so nothing was killed" ;; esac
    sleep 20
    st="$(in_c cat /run/cain/discord.state 2>/dev/null | cut -d' ' -f1)"
    say "  the channel's state 20 seconds on: ${st:-none} (server-down until the new server has run a minute)"
    in_c sh -c 'for p in /proc/[0-9]*; do c="$(tr "\000" " " < "$p/cmdline" 2>/dev/null)"; [ "$c" = "/usr/local/bin/bun /opt/cain/discord/plugin/server.ts " ] && exit 0; done; exit 1' \
      || fail "no plugin server runs 20 seconds after it was stopped"
    sleep 70
    st="$(in_c cat /run/cain/discord.state 2>/dev/null | cut -d' ' -f1)"
    [ "$st" = connected ] || fail "the channel's state is ${st:-none}, not connected, 90 seconds after the server was stopped"
    after="$(in_c awk -v s="$since" '$1 >= s' /data/probe/starts 2>/dev/null | wc -l)"
    [ "$after" = "$before" ] || fail "his session was restarted for it ($after starts since the step began)"
    echo "PASS: the server came back within seconds and his session kept its channel. Confirm the App's log shows \"the plugin's server stopped (<code>): starting it again\"."
    ;;
  7)
    need_in sh test rm curl jq awk
    need timeout
    # The gate (third round): the Supervisor's health probe gets 200, from an address nginx admits, and
    # the App's log shows no /health 404. Without it the watchdog could restart the App in a loop.
    say "step 7 gate: the Supervisor's health probe, with the App's Watchdog switch on"
    # Fourth round: the switch itself, read through the Supervisor's info call from inside the App
    # (/addons/self/info). The token stays in the container: printf is the shell's own, curl reads the
    # header from its config on stdin, and only the true/false of data.watchdog leaves the container.
    wd="$(docker exec "$C" sh -c 'printf "header = \"Authorization: Bearer %s\"\n" "${SUPERVISOR_TOKEN:-}" | curl -q -fsS -m 10 -K - http://supervisor/addons/self/info 2>/dev/null | jq -r "if .result == \"ok\" and (.data.watchdog | type) == \"boolean\" then .data.watchdog else \"unknown\" end" 2>/dev/null' 2>/dev/null | tr -cd 'a-z')"
    [ "$wd" = true ] || fail "the Supervisor's info call says the App's Watchdog switch is ${wd:-unreadable}, not on. Turn it on (Home Assistant, the Cain App's page), then run this again"
    say "  the Supervisor's info call says the Watchdog switch is on"
    SUP="${SUPERVISOR_CONTAINER:-hassio_supervisor}"
    net_ip() { docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "hassio"}}{{$v.IPAddress}}{{end}}{{end}}' "$1" 2>/dev/null | tr -cd '0-9.'; }
    sup_ip="$(net_ip "$SUP")"; app_ip="$(net_ip "$C")"
    [ -n "$sup_ip" ] || fail "couldn't read the Supervisor's address on the hassio network (container $SUP; set SUPERVISOR_CONTAINER=<name>)"
    [ -n "$app_ip" ] || fail "couldn't read the App's address on the hassio network"
    say "  the Supervisor probes from $sup_ip; the App is at $app_ip"
    case "$sup_ip" in 172.30.3[23].*) ;; *) fail "the Supervisor's address $sup_ip is outside 172.30.32.0/23: /health would answer it 404. Don't rely on the exit route; report it" ;; esac
    hc="$(docker exec "$SUP" python3 -c 'import sys, urllib.request, urllib.error
try: print(urllib.request.urlopen(sys.argv[1], timeout=5).status)
except urllib.error.HTTPError as e: print(e.code)
except Exception: print("none")' "http://$app_ip:8098/health" 2>/dev/null | tr -cd '0-9a-z')"
    [ "$hc" = 200 ] || fail "/health answered the Supervisor's own container with ${hc:-nothing}, not 200. Don't rely on the exit route; report it"
    say "  /health answers 200 from the Supervisor's container; watching for 3 minutes: the Supervisor's own probe must get 200 (health-ok.log) and the App's log must show no /health 404"
    gate_since="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"; gate_epoch="$(date +%s)"
    sleep 190
    miss="$(docker logs --since "$gate_since" "$C" 2>&1 | grep -m 1 "answered 404 to:")"
    [ -z "$miss" ] || fail "the App's log shows a /health 404: ${miss}. Don't rely on the exit route; report it"
    # Fourth round: reachability alone isn't the probe. At least one /health 200 to the Supervisor's own
    # address in the watch window, from nginx's note of each 200 (time, address). The test request above
    # came before the window, so it doesn't count.
    oks="$(in_c awk -v s="$gate_epoch" -v ip="$sup_ip" '$1 + 0 >= s && $2 == ip' /run/cain-web/health-ok.log 2>/dev/null | wc -l | tr -cd '0-9')"
    [ "${oks:-0}" -ge 1 ] || fail "nginx noted no /health 200 to the Supervisor ($sup_ip) in 3 minutes: its watchdog probe isn't reaching /health as expected. Don't rely on the exit route; report it"
    echo "PASS (gate): the Watchdog switch is on (the Supervisor's info call), the Supervisor's own probe from $sup_ip got 200 ${oks} times in 3 minutes, and the App's log shows no /health 404."
    [ "${2:-}" != gate ] || exit 0
    say "step 7: the exit route: the App stops with exit code 3, and the Supervisor's watchdog starts it again within a minute"
    say "  needs the App's Watchdog switch on (Home Assistant, the Cain App's page). The outside heartbeat hears a failure: expected."
    id0="$(docker inspect -f '{{.Id}}' "$C")" || fail "couldn't read the container's id"
    in_c sh -c ': > /run/cain/root-tmp/drill-exit-route' || fail "couldn't leave the drill's mark in the container"
    say "  mark left; the run script takes the exit route at its next tick (within about 10 seconds)"
    code="$(timeout 120 docker wait "$id0" 2>/dev/null | tr -cd '0-9')"
    stopped=$(date +%s)
    [ -n "$code" ] || { in_c rm -f /run/cain/root-tmp/drill-exit-route 2>/dev/null; fail "the App didn't stop within 2 minutes of the mark (mark taken back)"; }
    [ "$code" = 3 ] || fail "the App stopped with exit code $code, not 3"
    say "  the App stopped with exit code 3; waiting up to a minute for the Supervisor to start it again"
    back=""
    while [ $(( $(date +%s) - stopped )) -le 60 ]; do
      c2="$(find_container || true)"
      if [ -n "$c2" ] && [ "$(docker inspect -f '{{.State.Running}}' "$c2" 2>/dev/null)" = true ] \
         && { [ "$(docker inspect -f '{{.Id}}' "$c2")" != "$id0" ] || [ "$(docker inspect -f '{{.State.StartedAt}}' "$c2" | cut -c1-19)" \> "$(date -u -d "@$stopped" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo 0)" ]; }; then
        back="$c2"; break
      fi
      sleep 2
    done
    [ -n "$back" ] || fail "the Supervisor didn't start the App again within a minute of its exit code 3 (is the Watchdog switch on?)"
    say "  running again as $back, $(( $(date +%s) - stopped )) s after it stopped"
    echo "PASS: the exit route works: exit code 3, and the Supervisor started the App again within a minute. The self-restart may rely on it now."
    ;;
  *) echo "usage: probe-drill.sh 0|1|1b|2|3|4|6|7 [gate] [check ...] | 5 ha|kill|s6"; exit 2 ;;
esac
