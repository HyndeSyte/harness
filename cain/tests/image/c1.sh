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

# The old root session ran in this container: the switch doesn't begin (exit 3).
fresh
rc="$(step -- legacy-here | rc_of)"
[ "$rc" = 3 ] || die "a switch in the old session's container gave rc=$rc, not 3"
settle; finish
echo "the old session's container never switches"

echo "C1 image test: $ran cases passed"
