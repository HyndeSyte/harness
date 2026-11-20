#!/bin/bash
# The probe drill (Cain 0.14.0), for the owner's assistant to run on the real Pi, from a shell that
# can reach Docker (Home Assistant's SSH App with protection mode off). Not shipped in the image.
#
#   probe-drill.sh               kills Cain's Discord channel on purpose, again and again for up to
#                                12 minutes, and waits for the App's alarm. Expected: the probe's
#                                alarm ("Cain isn't answering") on the phone within 10 minutes, with
#                                no one watching, and the probe's outside heartbeat going late.
#   probe-drill.sh --backups     lists the backups of Cain alone through root's helper and the one a
#                                rollback would restore (changes nothing): proves the Supervisor's
#                                backup role answers.
#   probe-drill.sh --restore     the rollback's one Supervisor call, for real but harmless: takes a
#                                fresh backup of Cain alone (ha backups new), then has root's helper
#                                restore exactly that one. Cain restarts from a copy minutes old.
#
# While the drill runs the App holds any rollback back (probe/main.ts drill). It prints each step
# and ends with PASS or FAIL. It never prints a key, a token or a heartbeat URL.
set -uo pipefail
C="${CAIN_CONTAINER:-addon_0fcc2575_cain}"
SLUG="${CAIN_SLUG:-0fcc2575_cain}"
LIMIT_S="${DRILL_LIMIT_S:-720}"     # 12 minutes in all; the alarm is expected within 10
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
in_c() { docker exec "$C" "$@"; }
command -v docker >/dev/null || { echo "FAIL: no docker here (use Home Assistant's SSH App with protection mode off)"; exit 2; }
in_c true 2>/dev/null || { echo "FAIL: no running container $C"; exit 2; }

case "${1:-}" in
--backups)
  in_c bun /opt/cain/rollback/helper.ts backups && echo PASS || { echo "FAIL: the helper couldn't list the backups"; exit 1; }
  exit 0 ;;
--restore)
  command -v ha >/dev/null || { echo "FAIL: no ha command here"; exit 2; }
  say "taking a fresh backup of Cain alone (the App stops for it, then starts again)"
  out="$(ha backups new --name "cain-restore-drill" --addons "$SLUG" --raw-json 2>&1)" || { echo "FAIL: the backup wasn't taken: ${out:0:200}"; exit 1; }
  slug="$(printf '%s' "$out" | jq -r '.data.slug // empty')"
  [ -n "$slug" ] || { echo "FAIL: no backup id in the answer"; exit 1; }
  say "backup $slug taken; waiting for the App to be up again"
  for _ in $(seq 1 60); do in_c test -s /run/cain/mode 2>/dev/null && break; sleep 5; done
  sleep 30
  say "asking root's helper to restore $slug, the rollback's own call"
  in_c bun /opt/cain/rollback/helper.ts restore-drill "$slug" && echo PASS || { echo "FAIL: the restore call was refused (above)"; exit 1; }
  exit 0 ;;
"") ;;
*) echo "usage: probe-drill.sh [--backups | --restore]"; exit 2 ;;
esac

start=$(date +%s)
in_c test -s /data/c1/notice.d/probe 2>/dev/null && { echo "FAIL: a probe alarm already stands; wait for it to clear first"; exit 1; }
in_c bun /opt/cain/probe/main.ts drill 30 || { echo "FAIL: couldn't mark the drill (no rollback must follow it)"; exit 1; }
say "drill marked; killing Cain's Discord plugin every 15 seconds until the alarm"
while :; do
  now=$(date +%s); el=$((now - start))
  if in_c test -s /data/c1/notice.d/probe 2>/dev/null; then
    d="$(in_c sh -c "sed -n 's/^discord //p; s/^sent //p' /data/c1/notice.d/probe" 2>/dev/null | tr '\n' ' ')"
    say "the probe alarm was raised after $((el / 60)) min $((el % 60)) s (Discord sent, Home Assistant sent at: $d)"
    break
  fi
  [ "$el" -lt "$LIMIT_S" ] || { say "no alarm in $((LIMIT_S / 60)) minutes"; echo "FAIL"; exit 1; }
  # The plugin's server (no pkill needed in the image): every process whose command runs it.
  in_c sh -c 'for p in /proc/[0-9]*; do grep -qa "discord/plugin/server.ts" "$p/cmdline" 2>/dev/null && kill "${p#/proc/}" 2>/dev/null; done; true' || true
  sleep 15
done
say "stopping the kills; the App brings Cain back by itself, and the alarm clears at the next good probe"
if [ "$el" -le 600 ]; then echo "PASS: alarm within 10 minutes. Now confirm the push reached the phone, and that the probe's outside check went late."; else echo "FAIL: the alarm took over 10 minutes"; exit 1; fi
