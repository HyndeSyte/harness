#!/bin/bash
# The start's locks (C1 plan 3.2, 3.11, 3.12), run as root before anything of Cain's:
#   lock.sh run       /run/cain's folders, Cain's keys, s6's saved environment root's only,
#                     the App's options 0600. Every start, every state.
#   lock.sh managed   his rules into /etc/claude-code, read back and checked by hash.
#   lock.sh data      the owners and modes of section 3.2 for /data (after the switch); any
#                     other entry of /data is closed to everyone but root.
#   lock.sh verify    what uid 1000 can read under /data and /run/cain is exactly what section
#                     3.2 gives him; nothing of root's he can read where anything writes holds a
#                     secret value; no setuid or setgid file there (every start of the new way).
#   lock.sh old       the old way's rules: /etc/claude-code removed, 0.11.0's settings and
#                     CLAUDE.md in /data/work, checked by hash.
# Any check that doesn't hold exits non-zero with why; the caller doesn't start Cain then.
set -uo pipefail
umask 027
die() { echo "[c1] lock: $*" >&2; exit 1; }
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
OPT="${C1_OPT:-/opt/cain}"
D="${C1_DATA:-/data}"

case "${1:-}" in
run)
  install -d -m 0750 -o root -g cain /run/cain || die "no /run/cain"
  install -d -m 0700 -o root -g root /run/cain/root-tmp
  install -d -m 0750 -o root -g cain /run/cain/keys
  install -d -m 0750 -o root -g nogroup /run/cain/www /run/cain/upstream
  install -d -m 0750 -o root -g discord /run/cain/outbox
  install -d -m 0700 -o cain -g cain /run/cain/tmux
  chmod 0700 /run/s6/container_environment 2>/dev/null
  [ ! -d /run/s6/container_environment ] || [ "$(stat -c %a /run/s6/container_environment)" = 700 ] \
    || die "s6's saved environment isn't root's only"
  [ ! -e "$D/options.json" ] || chmod 0600 "$D/options.json" || die "options.json couldn't be made root's only"
  # Cain's own key for his link routes: new at every start. His handover key: the one the
  # Harness App checks, derived from the token, which stays here.
  tokenfile="$D/link/discord.env"; [ -f "$tokenfile" ] || tokenfile="$D/.claude/channels/discord/.env"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /run/cain/keys/cain.key.tmp && mv /run/cain/keys/cain.key.tmp /run/cain/keys/cain.key
  if bun "$OPT/c1/tools.ts" handover-key "$tokenfile" > /run/cain/keys/handover.key.tmp 2>/dev/null; then
    mv /run/cain/keys/handover.key.tmp /run/cain/keys/handover.key
  else rm -f /run/cain/keys/handover.key.tmp; echo "[c1] lock: no bot token yet, so no handover key" >&2; fi
  chown root:cain /run/cain/keys/*.key 2>/dev/null; chmod 0640 /run/cain/keys/*.key 2>/dev/null
  ;;
managed)
  install -d -m 0755 -o root -g root /etc/claude-code || die "no /etc/claude-code"
  install -m 0644 -o root -g root "$OPT/settings.json" /etc/claude-code/managed-settings.json
  install -m 0644 -o root -g root "$OPT/CLAUDE.md" /etc/claude-code/CLAUDE.md
  [ "$(sha /etc/claude-code/managed-settings.json)" = "$(sha "$OPT/settings.json")" ] || die "managed-settings.json isn't the image's"
  [ "$(sha /etc/claude-code/CLAUDE.md)" = "$(sha "$OPT/CLAUDE.md")" ] || die "CLAUDE.md isn't the image's"
  for f in /etc/claude-code /etc/claude-code/managed-settings.json /etc/claude-code/CLAUDE.md; do
    [ "$(stat -c %U "$f")" = root ] || die "$f isn't root's"
  done
  ;;
data)
  chown root:root "$D" && chmod 0711 "$D" || die "/data"
  # What section 3.2 opens to him by name; any other entry is root's alone.
  his="cain work trust record record-queue record-outcomes record-holds.json review-inbox review-queue
review-spend.json review-health.json review-useful.jsonl review-private-terms.txt jobs gate session.log"
  for e in "$D"/* "$D"/.[!.]* "$D"/..?*; do
    { [ -e "$e" ] && [ ! -L "$e" ]; } || continue
    case " $(echo $his) " in *" ${e##*/} "*) ;; *) chmod go-rwx "$e" || die "$e" ;; esac
  done
  own() { [ -e "$1" ] || return 0; chown "$2" "$1" && chmod "$3" "$1" || die "$1"; }
  own "$D/options.json" root:root 0600
  own "$D/cain" cain:cain 0700
  own "$D/work" cain:cain 0700
  own "$D/link" root:root 0700
  own "$D/codex" root:root 0700
  own "$D/c1" root:root 0700
  own "$D/.claude" root:root 0700
  own "$D/.claude.json" root:root 0600
  own "$D/trust" root:root 0755
  own "$D/discord" root:discord 0750
  own "$D/discord/access.json" root:discord 0640
  own "$D/discord/inbox" discord:cain 2750
  for q in record-queue review-inbox jobs; do install -d -m 2770 -o root -g cain "$D/$q"; done
  for q in record-outcomes review-queue gate; do
    install -d -m 2750 -o root -g cain "$D/$q"
    find "$D/$q" -mindepth 1 -maxdepth 1 -type f -exec chgrp cain {} + -exec chmod 0640 {} +
  done
  for f in record-holds.json review-spend.json review-health.json; do own "$D/$f" root:cain 0640; done
  for f in review-useful.jsonl review-private-terms.txt session.log; do
    [ -L "$D/$f" ] && rm -f "$D/$f"
    [ -e "$D/$f" ] || : > "$D/$f"
    own "$D/$f" root:cain 0660
  done
  for f in relay.queue relay.queue.work checkins notes.seen jobs.nudged meanings.sent meanings.tried places.sent places.tried alerted-login; do
    [ -e "$D/$f" ] && { chown root:root "$D/$f"; chmod go-rwx "$D/$f"; }
  done
  # The record keeper's copy: his to read, not to write. Its folders keep the group (setgid).
  if [ -d "$D/record" ]; then
    chgrp -R cain "$D/record" && chmod -R g+rX,g-w,o-rwx "$D/record" \
      && find "$D/record" -type d -exec chmod g+s {} + || die "/data/record"
  fi
  ;;
verify)
  T=(bun "$OPT/c1/tools.ts"); tmp="${CAIN_ROOT_TMP:-/run/cain/root-tmp}"
  trap 'rm -f "$tmp"/verify-*' EXIT
  "${T[@]}" readable "$tmp/verify-list" "$D" /run/cain || die "couldn't list what uid 1000 can read"
  bad="$("${T[@]}" allowed "$tmp/verify-list")" || die "uid 1000 can read a file section 3.2 doesn't give him: ${bad:-?}"
  # His own files hold only what he could read already; root's files he can read are searched.
  "${T[@]}" secrets "$tmp/verify-needles" && [ -s "$tmp/verify-needles" ] || die "couldn't list the secret values"
  C1_NOT_HIS=1 "${T[@]}" readable "$tmp/verify-list" "$D" /run /tmp /var/tmp /etc /root /home \
    && "${T[@]}" scan "$tmp/verify-needles" "$tmp/verify-list" "$tmp/verify-hits" || die "couldn't search what uid 1000 can read"
  [ ! -s "$tmp/verify-hits" ] || die "uid 1000 can read a secret value in $(tr '\0' '\n' < "$tmp/verify-hits" | head -n 1)"
  suid="$(find "$D" /run /tmp /var/tmp -xdev -type f -perm /6000 2>/dev/null | head -n 1)"
  [ -z "$suid" ] || die "a setuid or setgid file: $suid"
  ;;
old)
  rm -rf /etc/claude-code
  [ ! -e /etc/claude-code ] || die "/etc/claude-code is still there"
  install -d -m 0755 "$D/work" "$D/work/.claude"
  install -m 0644 "$OPT/legacy/CLAUDE.md" "$D/work/CLAUDE.md"
  install -m 0644 "$OPT/legacy/settings.json" "$D/work/.claude/settings.json"
  [ "$(sha "$D/work/CLAUDE.md")" = "$(sha "$OPT/legacy/CLAUDE.md")" ] || die "the old CLAUDE.md isn't 0.11.0's"
  [ "$(sha "$D/work/.claude/settings.json")" = "$(sha "$OPT/legacy/settings.json")" ] || die "the old settings aren't 0.11.0's"
  grep -q 'hooks/discord-send.ts' "$D/work/.claude/settings.json" || die "the old settings have no reply hook"
  ;;
*) echo "usage: lock.sh run | managed | data | verify | old" >&2; exit 2 ;;
esac
