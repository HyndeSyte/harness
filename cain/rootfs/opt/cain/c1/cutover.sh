#!/bin/bash
# The switch to the new way (C1 plan 3.12, state B), run as root by the run script when the
# state is fresh and the specialist has signed, or when it finds a switch that didn't finish.
# One transaction: each step finishes, is checked, and only then gets its line in
# /data/c1/journal, and any step can run again over its own partial work. Before "commit", a
# failure or an interrupted switch undoes what staging made and leaves the old layout as it was
# (but for tighter modes, which root doesn't notice); after "commit" the switch only goes
# forward. Nothing of uid 1000 runs before /data is locked and his staged home is scrubbed.
#   exit 0  switched: the state file reads cut over
#   exit 1  not switched and the old layout whole: the old way may run (why on stderr)
#   exit 2  stopped: Cain mustn't start (why on stderr)
#   exit 3  the old root session ran in this container: the App must restart first (nothing
#           written)
#   exit 4  not switched and the old layout whole, but a process of uid 1000 ran in this
#           container: nothing of Cain's may run here; the App must restart first
# C1_KILL_AT=<point> kills the switch at that point (the CI image test, to prove every
# interruption recovers); `cutover.sh points` lists them.
set -uo pipefail
umask 027
OPT="${C1_OPT:-/opt/cain}"
D="${C1_DATA:-/data}"
C="$D/c1"; J="$C/journal"; FAILED="$C/failed"
TMPD="${CAIN_ROOT_TMP:-/run/cain/root-tmp}"
T=(bun "$OPT/c1/tools.ts")
POINTS="lock-0 lock-1 stage-0 stage-1 quarantine-staged-0 quarantine-staged-1 chown-cain-0 chown-cain-1
validate-0 validate-1 quiesce-0 quiesce-1 before-0 before-1 mv-home-0 mv-home-1 mv-gate-0 mv-gate-1 quarantine-work-0
quarantine-work-1 chown-work-0 chown-work-1 chown-inbox-0 chown-inbox-1 modes-0 modes-1 state-0 state-1
abort-0 abort-1 abort-2 j-begin-0 j-begin-1 j-locked-0 j-locked-1 j-staged-0 j-staged-1 j-scrubbed-0
j-scrubbed-1 j-validated-0 j-validated-1 j-commit-0 j-commit-1 j-committed-0 j-committed-1"
if [ "${1:-}" = points ]; then printf '%s\n' $POINTS; exit 0; fi

log() { echo "[c1] $*" >&2; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
there() { [ -e "$1" ] || [ -L "$1" ]; }
kp() { [ "${C1_KILL_AT:-}" = "$1" ] && kill -9 $$; return 0; }
stop() { log "STOPPED: $*"; exit 2; }
jadd() { kp "j-$1-0"; "${T[@]}" journal-add "$J" "$* $(now)" || stop "couldn't write the journal"; kp "j-$1-1"; }
last() { "${T[@]}" journal-check "$J" 2>/dev/null; }
needles="$TMPD/c1-needles"
cleanup() { rm -f "$needles" "$TMPD"/c1-readable* "$TMPD"/c1-hits* 2>/dev/null; }
trap cleanup EXIT
secrets() { "${T[@]}" secrets "$needles" && [ -s "$needles" ]; }
cid() { "${T[@]}" container-id; }
# Every process of these users ended, whatever it started, and checked gone. kill(-1, SIGKILL)
# run as the user signals all of that user's processes in one pass of the kernel, under the
# lock fork takes, so none forks past it. A zombie runs nothing and isn't counted.
quiesce() {
  local u p ids st left
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    for u in "$@"; do setpriv --reuid="$u" --regid="$u" --clear-groups bash -c 'kill -9 -1' 2>/dev/null; done
    left=""
    for p in /proc/[0-9]*; do
      st="$(awk '/^State:/{print $2; exit}' "$p/status" 2>/dev/null)"
      case "$st" in Z|X|"") continue ;; esac
      ids=" $(awk '/^Uid:/{print $2, $3, $4, $5; exit}' "$p/status" 2>/dev/null) "
      for u in "$@"; do case "$ids" in *" $u "*) left="${p#/proc/}"; break ;; esac; done
      [ -n "$left" ] && break
    done
    [ -z "$left" ] && return 0
    sleep 0.2
  done
  log "a process of uid $* is still running ($left)"
  return 1
}

# Undo what staging made, check the old layout is whole, and only then forget the switch. Only
# ever before "commit"; it can itself be interrupted and run again.
abort() {
  log "not switched: $*"
  kp abort-0
  # What the validation started is ended first, so nothing of his user is left working on
  # what's being removed (the container is replaced anyway before the old way runs).
  quiesce 1000 1001 >/dev/null 2>&1 || true
  rm -rf /etc/claude-code "$D/cain" "$D/discord" "$C/quarantine" "$C/before"
  rm -f "$D/link/discord.env" "$D/link/discord.env.tmp"
  kp abort-1
  if [ -d "$D/.claude" ] && [ "$(stat -c %u "$D/.claude")" = 0 ] && [ -d "$D/work" ] && [ "$(stat -c %u "$D/work")" = 0 ] \
     && ! there "$D/gate" && ! there "$C/state" && ! there "$D/cain"; then
    "${T[@]}" journal-add "$FAILED" "$(now) $*" 2>/dev/null
    rm -f "$J" && sync "$C"
    kp abort-2
    # After a process of uid 1000 ran here, nothing of Cain's runs in this container: the
    # old way waits for a new one, which has nothing that process left behind.
    if [ -f "$C/uid1000-ran" ] && [ "$(head -c 200 "$C/uid1000-ran")" = "$(cid)" ]; then exit 4; fi
    exit 1
  fi
  stop "the old layout isn't whole after undoing a switch that didn't commit"
}

state="$("$OPT/c1/state.sh")"
case "$state" in
  fresh) ;;
  switching)
    at="$(last)"
    case "$at" in commit|committed) log "a switch committed before a restart: finishing it" ;;
      *) abort "a switch was interrupted after its step '$at'" ;; esac ;;
  *) stop "the state is $state" ;;
esac

if [ "$state" = fresh ]; then
  # 0. Preconditions, nothing written.
  sig="$D/link/specialist-signs"
  { [ -f "$sig" ] && [ ! -L "$sig" ] && [ "$(stat -c %u "$sig")" = 0 ]; } || { log "the specialist hasn't signed yet"; exit 1; }
  cid="$("${T[@]}" container-id)" || stop "no container identity"
  if [ -f "$C/legacy-ran" ] && [ "$(head -c 200 "$C/legacy-ran")" = "$cid" ]; then
    log "the old root session ran in this container: the switch waits for the App's restart"; exit 3
  fi
  for p in /proc/[0-9]*; do
    u="$(awk '/^Uid:/{print $2; exit}' "$p/status" 2>/dev/null)"
    case "$u" in 1000|1001) log "a process of uid $u is running (${p#/proc/}), so this isn't a fresh container"; exit 3 ;; esac
  done
  "${T[@]}" may-retry "$FAILED" || { log "the switch failed 3 times; it's tried again 6 hours after the last"; exit 1; }
  [ -d "$D/.claude" ] && [ -d "$D/work" ] && [ -f "$D/.claude/channels/discord/.env" ] || { log "no old layout to switch from"; exit 1; }
  install -d -m 0700 -o root -g root "$C" && chmod 0700 "$C" || stop "no /data/c1"

  # 1. Begin.
  jadd begin "$cid"

  # 2. Lock: /data root's, every entry in it closed to others (root reads them regardless, so the
  # old way doesn't notice), and nothing under /data readable by uid 1000.
  kp lock-0
  chown root:root "$D" && chmod 0711 "$D" || abort "couldn't lock /data"
  for e in "$D"/* "$D"/.[!.]* "$D"/..?*; do
    there "$e" || continue; [ -L "$e" ] && continue
    chmod go-rwx "$e" || abort "couldn't lock $e"
  done
  kp lock-1
  "${T[@]}" readable "$TMPD/c1-readable" "$D" || abort "couldn't list what uid 1000 can read"
  [ ! -s "$TMPD/c1-readable" ] || abort "uid 1000 can still read under /data: $(tr '\0' '\n' < "$TMPD/c1-readable" | head -n 1)"
  jadd locked

  # 3. Stage, root's: his home, the token, the plugin's state and the inbox, all copies.
  kp stage-0
  there "$D/cain" && abort "/data/cain is already there"
  install -d -m 0700 -o root -g root "$D/cain" || abort "couldn't make /data/cain"
  cp -a "$D/.claude" "$D/cain/.claude" || abort "couldn't copy his Claude folder"
  rm -rf "$D/cain/.claude/channels/discord" "$D/cain/.claude/plugins"
  for f in .claude.json .claude.json.backup; do there "$D/$f" && { cp -a "$D/$f" "$D/cain/$f" || abort "couldn't copy $f"; }; done
  chown -R root:root "$D/cain" && chmod -R go-rwx "$D/cain" || abort "couldn't keep the staged home root's"
  grep -m1 '^DISCORD_BOT_TOKEN=' "$D/.claude/channels/discord/.env" > "$D/link/discord.env.tmp" \
    && chmod 0600 "$D/link/discord.env.tmp" && mv "$D/link/discord.env.tmp" "$D/link/discord.env" || abort "couldn't copy the token"
  install -d -m 0751 -o root -g discord "$D/discord" || abort "couldn't make /data/discord"
  install -m 0640 -o root -g discord "$D/.claude/channels/discord/access.json" "$D/discord/access.json" || abort "no access.json to copy"
  install -d -m 0700 -o root -g root "$D/discord/inbox" || abort "couldn't make the inbox"
  if [ -d "$D/.claude/channels/discord/inbox" ]; then
    find "$D/.claude/channels/discord/inbox" -maxdepth 1 -type f -exec cp -p {} "$D/discord/inbox/" \; || abort "couldn't copy the inbox"
    find "$D/discord/inbox" -type f -exec chown root:root {} + -exec chmod 0600 {} + || abort "couldn't keep the inbox root's"
  fi
  kp stage-1
  jadd staged

  # 4. Scrub, still root's: a staged file holding a current secret value goes to the quarantine,
  # never edited; a second search finds none. /data/work is only searched here (step 7 moves).
  secrets || abort "couldn't list the secret values to search for"
  "${T[@]}" scan-tree "$needles" "$TMPD/c1-hits" "$D/cain" "$D/discord/inbox" || abort "the search of the staged copies failed"
  n=0
  while IFS= read -r -d '' f; do
    q="$C/quarantine/${f#"$D"/}"; there "$q" && q="$q.$(date +%s%N)"
    kp quarantine-staged-0
    mkdir -p -m 0700 "$(dirname "$q")" && mv "$f" "$q" || abort "couldn't quarantine a staged file"
    kp quarantine-staged-1
    n=$((n + 1))
  done < "$TMPD/c1-hits"
  "${T[@]}" scan-tree "$needles" "$TMPD/c1-hits" "$D/cain" "$D/discord/inbox" || abort "the second search failed"
  [ ! -s "$TMPD/c1-hits" ] || abort "a staged file still holds a secret value"
  "${T[@]}" scan-tree "$needles" "$TMPD/c1-hits-work" "$D/work" || abort "the search of /data/work failed"
  m="$(tr -cd '\0' < "$TMPD/c1-hits-work" | wc -c)"
  [ "$n" = 0 ] || log "secret search: $n file(s) of his staged home held a current secret value; quarantined, not his"
  [ "$m" = 0 ] || log "secret search: $m file(s) in /data/work hold one; quarantined when the switch commits"
  jadd scrubbed "$n" "$m"

  # 5. Validate. The first processes of uid 1000 run here, and all they can reach of /data and
  # /run/cain is his scrubbed home and his keys; nothing he can read where anything writes
  # holds a secret value. First this container goes on record as one where uid 1000 ran: the
  # old way never starts in it again.
  "${T[@]}" write-state "$C/uid1000-ran" "$(cid)" || abort "couldn't put this container on record"
  kp chown-cain-0
  chown -R cain:cain "$D/cain" && chmod 0700 "$D/cain" || abort "couldn't give /data/cain to him"
  kp chown-cain-1
  "${T[@]}" readable "$TMPD/c1-readable" "$D" /run/cain || abort "couldn't list what uid 1000 can read"
  bad="$("${T[@]}" only "$TMPD/c1-readable" "$D/cain" /run/cain/keys/cain.key /run/cain/keys/handover.key /run/cain/mode /run/cain/discord.state)" \
    || abort "uid 1000 could read more than his home: ${bad:-?}"
  "${T[@]}" readable "$TMPD/c1-readable" "$D" /run /tmp /var/tmp /etc /root /home \
    && "${T[@]}" scan "$needles" "$TMPD/c1-readable" "$TMPD/c1-hits" || abort "couldn't search what uid 1000 can read"
  [ ! -s "$TMPD/c1-hits" ] || abort "uid 1000 could read a secret value in $(tr '\0' '\n' < "$TMPD/c1-hits" | head -n 1)"
  kp validate-0
  "$OPT/c1/lock.sh" managed || abort "his rules couldn't be installed"
  # The real plugin's server as discord, started by root with the token in its environment and
  # its pipes root's, no client: it logs in, is killed, and every process of uid 1001 is gone
  # before anything of uid 1000 runs.
  "${T[@]}" login-check "$D/link/discord.env" || abort "the plugin's server didn't reach Discord with the token"
  quiesce 1001 || abort "the plugin's login check left a process behind"
  # The channel smoke test: a session of his loads the seed's plugin (its start event lists it,
  # loaded from the seed: a seed plugin registers at session start, so `claude plugin list`
  # wouldn't show it), and its reply goes through the bridge, the broker and the gate.
  "$OPT/c1/smoke.sh" || abort "the channel smoke test didn't pass"
  kp validate-1
  # Whatever the validation started is ended, not trusted to have ended: every process of uid
  # 1000 and 1001, checked gone, before the journal moves on.
  kp quiesce-0
  quiesce 1000 1001 || abort "the validation left a process behind"
  kp quiesce-1
  jadd validated

  # 6. Commit, after the one copy that can fail for space while nothing old has changed: made in
  # a temporary folder, compared with the original, and only then given its name, so no partial
  # copy is ever taken for the backup.
  kp before-0
  install -d -m 0700 -o root -g root "$C/before" && rm -rf "$C/before/work" "$C/before/work.tmp" \
    && cp -a "$D/work" "$C/before/work.tmp" && diff -r --no-dereference "$D/work" "$C/before/work.tmp" >/dev/null \
    && "${T[@]}" same-tree "$D/work" "$C/before/work.tmp" >/dev/null \
    && mv "$C/before/work.tmp" "$C/before/work" || abort "couldn't freeze a whole copy of /data/work"
  kp before-1
  jadd commit
fi

# 7. Commit, forward only. Each move happens only if its source is there and its target isn't;
# a required one with neither, or any with both, stops.
mvonce() {   # mvonce <from> <to> <point> required|optional
  if there "$1"; then
    there "$2" && stop "both $1 and $2 are there"
    kp "mv-$3-0"; mkdir -p "$(dirname "$2")" && mv "$1" "$2" || stop "couldn't move $1"; kp "mv-$3-1"
  elif [ "$4" = required ] && ! there "$2"; then stop "neither $1 nor $2 is there"
  fi
  return 0
}
if [ "$(last)" = commit ]; then
  secrets || stop "couldn't list the secret values to search for"
  mvonce "$D/.claude" "$C/before/.claude" home required
  mvonce "$D/.claude.json" "$C/before/.claude.json" home optional
  mvonce "$D/.claude.json.backup" "$C/before/.claude.json.backup" home optional
  install -d -m 2750 -o root -g cain "$D/gate" || stop "couldn't make /data/gate"
  for pair in gate-report.jsonl:report.jsonl gate-replay.json:replay.json gate-tries.json:tries.json gate-dm.json:dm.json; do
    mvonce "$D/work/${pair%%:*}" "$D/gate/${pair##*:}" gate optional
  done
  mvonce "$D/work/CLAUDE.md" "$C/before/installed-CLAUDE.md" gate optional
  mvonce "$D/work/.claude/settings.json" "$C/before/installed-settings.json" gate optional
  # /data/work, searched again as it is now; every match quarantined, then searched once more.
  "${T[@]}" scan-tree "$needles" "$TMPD/c1-hits" "$D/work" || stop "the search of /data/work failed"
  while IFS= read -r -d '' f; do
    q="$C/quarantine/${f#"$D"/}"; there "$q" && q="$q.$(date +%s%N)"
    kp quarantine-work-0
    mkdir -p -m 0700 "$(dirname "$q")" && mv "$f" "$q" || stop "couldn't quarantine a file of /data/work"
    kp quarantine-work-1
  done < "$TMPD/c1-hits"
  "${T[@]}" scan-tree "$needles" "$TMPD/c1-hits" "$D/work" || stop "the search of /data/work failed"
  [ ! -s "$TMPD/c1-hits" ] || stop "a file of /data/work still holds a secret value"
  kp chown-work-0
  chown -R cain:cain "$D/work" && chmod 0700 "$D/work" || stop "couldn't give /data/work to him"
  kp chown-work-1
  kp chown-inbox-0
  chown -R discord:cain "$D/discord/inbox" && chmod 2750 "$D/discord/inbox" \
    && find "$D/discord/inbox" -type f -exec chmod 0640 {} + || stop "couldn't give the inbox to the plugin"
  kp chown-inbox-1
  kp modes-0
  "$OPT/c1/lock.sh" data || stop "section 3.2's owners and modes didn't hold"
  kp modes-1
  jadd committed
fi

# 8. Verify, then mark: what uid 1000 can read under /data and /run/cain is exactly what section
# 3.2 gives him, nothing he can read where anything writes holds a secret value, and no file
# there is setuid or setgid. Only then the state file.
[ "$(last)" = committed ] || stop "the journal ends at '$(last)'"
secrets || stop "couldn't list the secret values to search for"
"${T[@]}" readable "$TMPD/c1-readable" "$D" /run/cain || stop "couldn't list what uid 1000 can read"
bad="$("${T[@]}" allowed "$TMPD/c1-readable")" || stop "uid 1000 can read a file section 3.2 doesn't give him: ${bad:-?}"
"${T[@]}" readable "$TMPD/c1-readable" "$D" /run /tmp /var/tmp /etc /root /home \
  && "${T[@]}" scan "$needles" "$TMPD/c1-readable" "$TMPD/c1-hits" || stop "couldn't search what uid 1000 can read"
[ ! -s "$TMPD/c1-hits" ] || stop "uid 1000 can read a secret value in $(tr '\0' '\n' < "$TMPD/c1-hits" | head -n 1)"
suid="$(find "$D" /run /tmp /var/tmp -xdev -type f -perm /6000 2>/dev/null | head -n 1)"
[ -z "$suid" ] || stop "a setuid or setgid file: $suid"
kp state-0
"${T[@]}" write-state "$C/state" "cut over $(now) c1"$'\n' || stop "couldn't write the state"
kp state-1
[ "$("$OPT/c1/state.sh")" = cut ] || stop "the state doesn't read back as cut over"
log "switched: Cain runs as his own user from now on"
exit 0
