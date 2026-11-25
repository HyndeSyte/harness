#!/bin/bash
# The C1 image test (projects/org-v2/c1-plan.md, section 4), run by the required `bun` check
# (.github/workflows/tests.yml) on Cain's real image, built there. A fake /data in 0.11.0's
# layout, with made-up secrets planted in a transcript, a scratch file and an attachment,
# goes through the switch to his own user:
#   - killed at every point of the switch (cutover.sh points), in one container, and checked
#     there: no planted secret readable by uid 1000, no process of his outliving the
#     validation, the old tree as it was before the commit (in.sh switch);
#   - then started again in new containers (a new PID namespace, as after the Supervisor's
#     restart) until it settles, and checked: cut over, the secrets quarantined, his folders
#     his, the start's own checks passing and catching a planted root file (in.sh final);
#   - and the named cases: kills inside an undo, a detached process of his, a failed smoke
#     test, a failed Discord login, a connector that wouldn't load, his connectors not listed
#     yet, no room for the copies, three failures in a row, and the old session's container.
# The real Discord login and a real Claude Code session aren't here (CI has neither sign-in):
# stand-ins take their place (stub-plugin, fake-claude.ts), and the first start on the Pi does
# them for real.
#   c1.sh <image>
set -euo pipefail
IMG="${1:?usage: c1.sh <image>}"
T="$(cd "$(dirname "$0")" && pwd)"
ran=0
die() { echo "FAIL: $*" >&2; exit 1; }
step() {   # step [VAR=value ...] -- <in.sh args...>: one new container on this case's /data
  local env=()
  while [ "$1" != -- ]; do env+=(-e "$1"); shift; done; shift
  docker run --rm --entrypoint /bin/bash -v "$d:/data" -v "$fp:/fp" -v "$T:/t:ro" ${env[@]+"${env[@]}"} "$IMG" /t/in.sh "$@"
}
fresh() { d="$(mktemp -d)"; fp="$(mktemp -d)"; chmod 0755 "$d" "$fp"; step -- template; }
rc_of() { tail -n 1 | sed -n 's/^rc=//p'; }
settle() {   # new containers until the switch is done
  local i rc=""
  for i in 1 2 3 4; do rc="$(step -- switch | rc_of)"; [ "$rc" = 0 ] && return 0; done
  die "the switch didn't settle (last rc=$rc); its log: $(tail -n 5 "$fp/switch.log" 2>/dev/null | tr '\n' ' ')"
}
finish() { step -- final; sudo rm -rf "$d" "$fp"; ran=$((ran + 1)); }

# Every kill point of a switch that would succeed (the undo's own points come below).
for P in $(docker run --rm --entrypoint /bin/bash "$IMG" /opt/cain/c1/cutover.sh points); do
  case "$P" in abort-*) continue ;; esac
  fresh
  rc="$(step -- switch "$P" | rc_of)"
  settle; finish
  echo "killed at $P (rc=$rc): recovered, nothing secret readable at any point"
done

# Kills inside the undo: a failing smoke test makes the switch undo itself.
for P in abort-0 abort-1 abort-2; do
  fresh
  rc="$(step SMOKE_FAIL=1 -- switch "$P" | rc_of)"
  settle; finish
  echo "killed in the undo at $P (rc=$rc): recovered"
done

# A process of his that detaches (double-forked, its parent gone): ended before "validated".
fresh
rc="$(step SMOKE_DETACH=1 -- switch quiesce-1 | rc_of)"
settle; finish
echo "a detached process of his was ended before the journal moved on"

# The same with the smoke test failing: undone, and nothing of Cain's runs in that container
# (exit 4: the old way waits for a new one); a new container is clean and switches.
fresh
rc="$(step SMOKE_DETACH=1 SMOKE_FAIL=1 -- switch | rc_of)"
[ "$rc" = 4 ] || die "a failed validation after his processes ran gave rc=$rc, not 4"
settle; finish
echo "a failed validation waited for a new container"

# The plugin's login fails: undone (the old tree checked whole in in.sh), then switches.
fresh
rc="$(step STUB_LOGIN_FAIL=1 -- switch | rc_of)"
[ "$rc" = 4 ] || die "a failed Discord login gave rc=$rc, not 4"
settle; finish
echo "a failed Discord login undid the switch"

# A claude.ai connector of his that wouldn't load under his new rules: undone (rc 4), so he never
# loses his mail or calendars to the switch; without it, the switch goes through.
fresh
step -- plant-connector
rc="$(step -- switch | rc_of)"
[ "$rc" = 4 ] || die "a connector that wouldn't load gave rc=$rc, not 4"
grep -q "his connectors wouldn't all load" "$fp/switch.log" || die "the undo didn't say it was the connectors"
step -- unplant-connector
settle; finish
echo "a connector that wouldn't load undid the switch"

# Not enough free space for the switch's copies: it waits (rc 1) and begins nothing.
fresh
rc="$(step C1_FREE_KB=1 -- switch | rc_of)"
[ "$rc" = 1 ] || die "a switch without room for its copies gave rc=$rc, not 1"
[ "$(step -- journal-there)" = no ] || die "a switch without room for its copies began a journal"
grep -q "not enough free space" "$fp/switch.log" || die "the wait didn't say it was the space"
settle; finish
echo "the switch waits for room for its copies"

# His connectors not listed the old way yet (the listing failed, or hasn't run): the switch
# waits (rc 1) and begins nothing; once a listing went through, it switches.
fresh
step -- unlist-connectors
rc="$(step -- switch | rc_of)"
[ "$rc" = 1 ] || die "a switch before his connectors were listed gave rc=$rc, not 1"
[ "$(step -- journal-there)" = no ] || die "a switch before his connectors were listed began a journal"
grep -q "his connectors haven't been listed" "$fp/switch.log" || die "the wait didn't say it was the listing"
step -- unplant-connector
settle; finish
echo "the switch waits for his connectors to be listed"

# Three failures in a row: the next start doesn't try (6 hours), and nothing is begun.
fresh
for i in 1 2 3; do
  rc="$(step SMOKE_FAIL=1 -- switch | rc_of)"
  [ "$rc" = 4 ] || die "failure $i gave rc=$rc"
done
rc="$(step -- switch | rc_of)"
[ "$rc" = 1 ] || die "a fourth try within 6 hours gave rc=$rc, not 1"
[ "$(step -- journal-there)" = no ] || die "a fourth try began a journal"
sudo rm -rf "$d" "$fp"; ran=$((ran + 1))
echo "three failures wait 6 hours"

# The App's alarms with Discord down (C1 second review): a check of his own user that can't
# finish holds his session and Home Assistant hears it, a breach's alarm replaces it, his return
# takes it down, and the webhook's id is on no command line (in.sh alarm).
fresh
settle
step -- alarm
finish
echo "a check that can't finish holds him, and the alarms reach Home Assistant with Discord down"

# The old root session ran in this container: the switch doesn't begin (exit 3).
fresh
rc="$(step -- legacy-here | rc_of)"
[ "$rc" = 3 ] || die "a switch in the old session's container gave rc=$rc, not 3"
settle; finish
echo "the old session's container never switches"

# The Supervisor's health check (Cain 0.15.0, second round): the shipped terminal service starts the
# shipped nginx in the image, and /health, asked from the Supervisor's own address (172.30.32.2, on a
# network laid out as Home Assistant's), answers 200, then 503 once the run script's mark is there, and
# 200 again without it; on any other path, 404 (in.sh health-serve). Third round: any other address on
# the hassio network (172.30.32.0/23) gets the same answer, an address outside it gets 404 (a second
# network, 172.30.40.0/24, joined to the same container), and each 404 shows in the App's log with its
# address within about a minute.
hnet="cain-health-$$"; hout="cain-health-out-$$"; hc="cain-health-$$"
hd=""
cleanup_health() { docker rm -f "$hc" >/dev/null 2>&1 || true; docker network rm "$hnet" "$hout" >/dev/null 2>&1 || true; [ -z "$hd" ] || sudo rm -rf "$hd"; }
trap cleanup_health EXIT
docker network create --subnet 172.30.32.0/23 "$hnet" >/dev/null
docker network create --subnet 172.30.40.0/24 "$hout" >/dev/null
hd="$(mktemp -d)"; chmod 0755 "$hd"
docker run -d --name "$hc" --network "$hnet" --ip 172.30.33.10 --entrypoint /bin/bash -v "$hd:/data" -v "$T:/t:ro" "$IMG" /t/in.sh health-serve >/dev/null
docker network connect --ip 172.30.40.10 "$hout" "$hc"
ask() {   # ask <from address> <path>: the status code nginx answers
  local net="$hnet" to=172.30.33.10
  case "$1" in 172.30.40.*) net="$hout"; to=172.30.40.10 ;; esac
  docker run --rm --network "$net" --ip "$1" --entrypoint curl "$IMG" -s -o /dev/null -m 5 -w '%{http_code}' "http://$to:8098$2" || true
}
# Cain 0.19.0 (first review fix): /health is liveness (200 with no link running here), and /ready, beside it, answers
# 503 until the link's gateway mark is there, then 200 once it is, written as the link writes it
# (link/health-gate.ts).
up=""
for _ in $(seq 1 60); do
  [ "$(ask 172.30.32.2 /health)" = 200 ] && { up=1; break; }
  docker inspect -f '{{.State.Running}}' "$hc" 2>/dev/null | grep -q true || break
  sleep 1
done
[ -n "$up" ] || die "nginx, started by the terminal service, didn't answer /health with 200: $(docker logs "$hc" 2>&1 | tail -n 15 | tr '\n' ' ')"
[ "$(ask 172.30.32.2 /ready)" = 503 ] || die "/ready didn't answer 503 while the link's gateway mark is missing"
docker exec "$hc" sh -c 'echo 1 > /run/cain-web/www/health-gateway && chgrp nogroup /run/cain-web/www/health-gateway && chmod 0640 /run/cain-web/www/health-gateway'
[ "$(ask 172.30.32.2 /ready)" = 200 ] || die "nginx didn't answer /ready with 200 once the link's gateway mark was there"
[ "$(ask 172.30.40.5 /ready)" = 404 ] || die "/ready answered an address outside the hassio network"
docker logs "$hc" 2>&1 | grep -q "nginx did not start" && die "the terminal service says nginx did not start"
docker exec "$hc" sh -c ': > /run/cain-web/www/health-down && chgrp nogroup /run/cain-web/www/health-down && chmod 0640 /run/cain-web/www/health-down'
[ "$(ask 172.30.32.2 /health)" = 503 ] || die "/health didn't answer 503 with the self-restart mark there"
[ "$(ask 172.30.33.20 /health)" = 503 ] || die "/health didn't answer another address on the hassio network as it answers the Supervisor"
docker exec "$hc" rm -f /run/cain-web/www/health-down
[ "$(ask 172.30.32.2 /health)" = 200 ] || die "/health didn't go back to 200 once the mark was gone"
[ "$(ask 172.30.32.3 /health)" = 200 ] || die "/health didn't answer 200 to another address in 172.30.32.0/23"
[ "$(ask 172.30.40.5 /health)" = 404 ] || die "/health answered an address outside 172.30.32.0/23 with something other than 404"
for path in / /status /signin /tty/ /healthz; do
  [ "$(ask 172.30.32.2 "$path")" = 404 ] || die "the health port answered $path with something other than 404"
done
docker exec "$hc" grep -qx 172.30.40.5 /run/cain-web/health-miss.log \
  || die "nginx didn't note the address of the refused /health in health-miss.log"
cleanup_health; trap - EXIT
ran=$((ran + 1))
echo "the Supervisor's health check: /health 200 to the hassio network, 503 with the self-restart mark; /ready 503 without the gateway mark, 200 with it; 404 outside it and on any other path, each 404 noted"

echo "C1 image test: $ran cases passed"
