#!/bin/bash
# The Pi drills for Cain 0.14.0's probe and rollback, in order, for the owner's assistant to run on
# the real Pi from a shell that can reach Docker (Home Assistant's SSH App with protection mode off).
# Not shipped in the image. rollback_armed (the App's option) stays off until all six have passed;
# step 4 turns it on for that one drill, with the owner watching, and off again after.
#
#   probe-drill.sh 1   the boundary, as uid 1000 (Cain's own user): reading the Supervisor's token,
#                      the watcher's request file, the link's gateway state file and the helper's
#                      environment, and posting a forged request, must each fail; the helper's argv
#                      (world-readable in /proc, as every process's is) must hold no token or URL.
#   probe-drill.sh 2   false alarms: the plugin killed, his session closed, the network cut for 15
#                      minutes. Each alarm must be raised and then cleared, and no rollback may run.
#   probe-drill.sh 3   the restore itself: a fresh backup of Cain alone, of the same version, restored
#                      by the helper's own call, timed; the App comes back, and the record of restores
#                      in /config is still there and settled after it.
#   probe-drill.sh 4   the full rollback, with the owner watching and Backup before update on: an
#                      older signed version, then a deliberately broken one (prints the steps; needs
#                      the owner, see below).
#   probe-drill.sh 5   the bad version reinstalled is refused: no second rollback of it.
#   probe-drill.sh 6   an API outage and a reboot cause no rollback (prints the steps, then checks).
#
# Each step prints what it does and ends with PASS or FAIL. Nothing here reads or prints a key, a
# token or a heartbeat URL. While a step runs, the App holds any rollback back (probe/main.ts drill).
set -uo pipefail
C="${CAIN_CONTAINER:-addon_0fcc2575_cain}"
SLUG="${CAIN_SLUG:-0fcc2575_cain}"
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
in_c() { docker exec "$C" "$@"; }
as_cain() { docker exec -u 1000 "$C" "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
command -v docker >/dev/null || { echo "FAIL: no docker here (use Home Assistant's SSH App with protection mode off)"; exit 2; }
in_c true 2>/dev/null || { echo "FAIL: no running container $C"; exit 2; }

alarm_up() { in_c test -s "/data/c1/notice.d/$1" 2>/dev/null && ! in_c grep -q '^clear 1' "/data/c1/notice.d/$1" 2>/dev/null; }
no_rollback() {   # no restore asked since the step began, and no rollback state written
  local since="$1" n
  n="$(in_c sh -c "jq -r --argjson s $since '[.restores[] | select(.at >= \$s and (.drill != true))] | length' /config/rollback-record.json 2>/dev/null || echo 0")"
  [ "${n:-0}" = 0 ] || return 1
  ! in_c sh -c "jq -e --argjson s $since '.at >= \$s and .state != \"disarmed\"' /data/probe/rollback.json >/dev/null 2>&1"
}
wait_for() {   # wait_for <seconds> <command...>: 0 once the command passes
  local limit="$1" t0; shift; t0=$(date +%s)
  until "$@"; do [ $(( $(date +%s) - t0 )) -lt "$limit" ] || return 1; sleep 15; done
}
mark_drill() { in_c bun /opt/cain/probe/main.ts drill "${1:-60}" >/dev/null || fail "couldn't mark the drill (no rollback must follow it)"; }

case "${1:-}" in
  1)
    say "step 1: the boundary, as uid 1000"
    ok=1
    for f in /run/s6/container_environment/SUPERVISOR_TOKEN /data/watcher/request /run/cain/link-gateway.state /run/cain/probe/seen /config/rollback-record.json; do
      if as_cain sh -c "head -c 1 '$f' >/dev/null 2>&1"; then say "  READ $f: it must not be readable"; ok=0; else say "  refused: $f"; fi
    done
    if as_cain sh -c 'ls /run/cain >/dev/null 2>&1'; then say "  LISTED /run/cain: it must not be listable"; ok=0; else say "  refused: listing /run/cain"; fi
    pid="$(in_c sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2>/dev/null | grep -q "rollback/helper.ts loop" && { echo ${p#/proc/}; break; }; done')"
    [ -n "$pid" ] || fail "no helper process found"
    if as_cain sh -c "head -c 1 /proc/$pid/environ >/dev/null 2>&1"; then say "  READ the helper's environment: it must not be readable"; ok=0; else say "  refused: the helper's environment"; fi
    argv="$(as_cain sh -c "tr '\0' ' ' < /proc/$pid/cmdline" 2>/dev/null)"
    case "$argv" in *http*|*Bearer*|*token*) say "  the helper's argv holds a URL or a token"; ok=0 ;; *) say "  the helper's argv holds no token or URL: $argv" ;; esac
    for forged in "look" '{"install":"x","slug":"deadbeef","restore":"0.0.1","undo":"9.9.9","why":"forged"}'; do
      if as_cain sh -c "printf '%s\n' '$forged' > /data/watcher/request" 2>/dev/null; then say "  WROTE a forged request: it must be refused"; ok=0; else say "  refused: posting a forged request"; fi
    done
    [ "$ok" = 1 ] && echo "PASS: uid 1000 can't read the token, the request file, the state file or the helper's environment, can't post a request, and the helper's argv holds no secret" || fail "the boundary didn't hold (above)"
    ;;
  2)
    say "step 2: false alarms, none of which may roll back"
    since=$(date +%s); mark_drill 90
    say "  2a: killing Cain's Discord plugin every 15 seconds until the probe's alarm"
    t0=$(date +%s)
    until alarm_up probe; do
      [ $(( $(date +%s) - t0 )) -lt 720 ] || fail "no probe alarm within 12 minutes of killing the plugin"
      in_c sh -c 'for p in /proc/[0-9]*; do grep -qa "discord/plugin/server.ts" "$p/cmdline" 2>/dev/null && kill "${p#/proc/}" 2>/dev/null; done; true' || true
      sleep 15
    done
    say "  raised after $(( $(date +%s) - t0 )) s; waiting for it to clear"
    wait_for 900 sh -c "! docker exec $C test -s /data/c1/notice.d/probe" || fail "the probe alarm didn't clear within 15 minutes"
    say "  2b: closing his session (tmux, as him)"
    as_cain tmux -S /run/cain/tmux/cain.sock kill-session -t cain 2>/dev/null || true
    sleep 120
    say "  the App starts him again by itself; the restart is the run script's own, so it isn't a crash start"
    in_c tail -n 3 /data/probe/starts
    say "  2c: cutting the App's network for 15 minutes (docker network disconnect, put back after)"
    net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$C" | awk '{print $1}')"
    [ -n "$net" ] || fail "couldn't tell the App's network"
    trap 'docker network connect "$net" "$C" 2>/dev/null' EXIT
    docker network disconnect "$net" "$C" || fail "couldn't cut the network"
    sleep 900
    docker network connect "$net" "$C" || fail "couldn't put the network back: do it now, docker network connect $net $C"
    trap - EXIT
    say "  network back; the outside heartbeat check should have gone late meanwhile (confirm on the phone)"
    wait_for 900 sh -c "! docker exec $C test -s /data/c1/notice.d/probe" || fail "the probe alarm didn't clear within 15 minutes of the network coming back"
    no_rollback "$since" || fail "a rollback ran or was asked during step 2"
    echo "PASS: each alarm was raised and cleared, and no rollback ran. Confirm the pushes reached the phone and the outside check went late."
    ;;
  3)
    command -v ha >/dev/null || fail "no ha command here"
    say "step 3: the restore itself, on a fresh backup of Cain alone of the same version"
    out="$(ha backups new --name "cain-restore-drill" --addons "$SLUG" --raw-json 2>&1)" || fail "the backup wasn't taken: ${out:0:200}"
    slug="$(printf '%s' "$out" | jq -r '.data.slug // empty')"
    [ -n "$slug" ] || fail "no backup id in the answer"
    say "  backup $slug taken; waiting for the App to be up again"
    wait_for 300 in_c test -s /run/cain/mode || fail "the App didn't come back after the backup"
    sleep 30
    t0=$(date +%s)
    say "  the helper restores $slug, the rollback's own call"
    in_c bun /opt/cain/rollback/helper.ts restore-drill "$slug" || fail "the restore call was refused (above)"
    sleep 20
    wait_for 900 in_c test -s /run/cain/mode || fail "the App didn't come back within 15 minutes of the restore"
    say "  the App is back after $(( $(date +%s) - t0 )) s"
    sleep 60
    last="$(in_c jq -c '.restores[-1] | {slug, drill, outcome}' /config/rollback-record.json 2>/dev/null)"
    say "  the record after the restore: ${last:-none}"
    case "$last" in *"\"$slug\""*'"outcome":"done"'*) echo "PASS: restored, the App came back, and the record outside /data survived and says done" ;;
      *"\"$slug\""*) fail "the record survived, but its outcome isn't done (the Supervisor's job endpoint may be out of the backup role's reach): ${last}" ;;
      *) fail "the record of restores didn't survive the restore: /config isn't durable across it, so the rollback can't be armed" ;; esac
    ;;
  4)
    cat <<'EOF'
step 4: the full rollback, with the owner watching. Needs the owner: it installs versions.
  a. In Home Assistant, Settings, Apps, Cain: Backup before update on.
  b. Install an older version of Cain that was installed from a signed Ship (from a local copy of
     the App at that version), and let it run 10 minutes.
  c. Turn rollback_armed on in the App's options (for this drill only).
  d. Install a deliberately broken build (one whose session exits 1 at once), with Backup before
     update on. Expected within about 40 minutes: "Cain is being rolled back" on the phone and in
     Discord before the App restarts, then the older version running, and
     "probe-drill.sh 5" showing the record.
  e. Turn rollback_armed off again until steps 5 and 6 pass.
Then run: probe-drill.sh 4 check
EOF
    if [ "${2:-}" = check ]; then
      last="$(in_c jq -c '.restores[-1] | {bad, target, outcome}' /config/rollback-record.json 2>/dev/null)"
      case "$last" in *'"outcome":"done"'*) echo "PASS: rolled back: $last" ;; *) fail "no completed rollback on record: ${last:-none}" ;; esac
    fi
    ;;
  5)
    say "step 5: the bad version reinstalled is refused"
    bad="$(in_c jq -r '[.restores[] | select(.drill != true)][-1].bad // empty' /config/rollback-record.json 2>/dev/null)"
    [ -n "$bad" ] || fail "no rollback on record yet: run step 4 first"
    say "  reinstall Cain $bad (Backup before update on), let it crash, and wait 40 minutes; then this checks"
    if [ "${2:-}" = check ]; then
      n="$(in_c jq -r --arg b "$bad" '[.restores[] | select(.bad == $b and (.drill != true))] | length' /config/rollback-record.json)"
      [ "$n" = 1 ] || fail "Cain $bad was rolled back $n times"
      in_c grep -q "rollback-again" /data/probe/rollback-told 2>/dev/null || fail "no 'rolled back once already' alarm was raised"
      echo "PASS: Cain $bad was refused a second rollback, and the alarm said so"
    fi
    ;;
  6)
    since=$(date +%s)
    say "step 6: an API outage and a reboot cause no rollback"
    cat <<'EOF'
  a. API outage: block the model's API from the App for 20 minutes (for example a firewall rule on
     the router for api.anthropic.com). Expected: "The model's API isn't answering" once, cleared after.
  b. Reboot the Pi (ha host reboot). Expected: the first start after the boot isn't counted, and
     no rollback alarm at all.
Then run: probe-drill.sh 6 check <the time step 6 began, in epoch seconds>
EOF
    say "  this step began at $since"
    if [ "${2:-}" = check ]; then
      s="${3:?the time step 6 began}"
      no_rollback "$s" || fail "a rollback ran or was asked during step 6"
      in_c awk -v s="$s" '$1 >= s' /data/probe/starts
      echo "PASS: no rollback after the API outage and the reboot"
    fi
    ;;
  *) echo "usage: probe-drill.sh 1|2|3|4|5|6 [check ...]"; exit 2 ;;
esac
