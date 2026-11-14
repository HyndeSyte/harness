#!/bin/bash
# The first start of 0.12.0 that may cut over (C1 plan 3.12, state B): stage, validate, then
# switch. Run as root by the run script only while the state is fresh and the specialist has
# signed (no process of Cain's user has run yet). Exit 0: cut over. Exit 1: not cut over, with
# why on stderr, and nothing of the old state changed (Cain then goes on the old way).
#
# Staging only copies. Nothing old is moved, deleted, truncated or changed in owner or mode
# until every check has passed and the old session is stopped; a failure removes only what
# staging made.
set -uo pipefail
umask 027
OPT="${C1_OPT:-/opt/cain}"
D="${C1_DATA:-/data}"
log() { echo "[c1] $*" >&2; }
made=()                                         # what staging made, removed on failure
fail() {
  log "not cut over: $*"
  for p in "${made[@]}"; do rm -rf "$p"; done
  rm -rf /etc/claude-code
  exit 1
}

[ "$("$OPT/c1/state.sh")" = fresh ] || fail "the state isn't fresh"
[ -f "$D/link/specialist-signs" ] || fail "the specialist hasn't signed a request yet"
old_env="$D/.claude/channels/discord/.env"
[ -f "$old_env" ] || fail "no bot token in its old place"

# 1. Stage, by copying. His new home, as his.
made+=("$D/cain")
mkdir -m 0700 "$D/cain" || fail "couldn't make /data/cain"
cp -a "$D/.claude" "$D/cain/.claude" || fail "couldn't copy his Claude folder"
rm -rf "$D/cain/.claude/channels/discord" "$D/cain/.claude/plugins"
for f in .claude.json .claude.json.backup; do [ -e "$D/$f" ] && { cp -a "$D/$f" "$D/cain/$f" || fail "couldn't copy $f"; }; done
# The token, the allowlist and the inbox: copies, root's (the plugin's server reads them as discord).
made+=("$D/link/discord.env" "$D/discord")
grep -m1 '^DISCORD_BOT_TOKEN=' "$old_env" > "$D/link/discord.env.tmp" && mv "$D/link/discord.env.tmp" "$D/link/discord.env" || fail "couldn't copy the token"
chown root:root "$D/link/discord.env" && chmod 0600 "$D/link/discord.env"
install -d -m 0750 -o root -g discord "$D/discord"
install -m 0640 -o root -g discord "$D/.claude/channels/discord/access.json" "$D/discord/access.json" || fail "no access.json to copy"
install -d -m 2750 -o discord -g cain "$D/discord/inbox"
if [ -d "$D/.claude/channels/discord/inbox" ]; then
  find "$D/.claude/channels/discord/inbox" -maxdepth 1 -type f -exec cp -p {} "$D/discord/inbox/" \;
  chown discord:cain "$D/discord/inbox"/* 2>/dev/null; chmod 0640 "$D/discord/inbox"/* 2>/dev/null
fi
# The secret search, before anything is his: a file holding a current secret value goes to
# root's quarantine, never edited (5 in the plan).
pat="/run/cain/root-tmp/secrets.$$"
bun "$OPT/c1/tools.ts" secrets "$pat" || fail "couldn't list the secrets to search for"
if [ -s "$pat" ]; then
  mkdir -p -m 0700 "$D/c1/quarantine"
  n=0
  while IFS= read -r -d '' f; do
    rel="${f#$D/cain/}"; mkdir -p "$D/c1/quarantine/$(dirname "$rel")"; mv "$f" "$D/c1/quarantine/$rel"; n=$((n + 1))
  done < <(grep -rlZF -f "$pat" "$D/cain" 2>/dev/null)
  [ "$n" = 0 ] || log "secret search: $n file(s) of his held a current secret value; moved to /data/c1/quarantine, not his"
fi
rm -f "$pat"
chown -R cain:cain "$D/cain" && chmod 0700 "$D/cain" || fail "couldn't hand /data/cain to him"

# 2. Validate, as cain, with HOME=/data/cain (as-cain sets it).
"$OPT/c1/lock.sh" managed || fail "his rules couldn't be installed"
bun "$OPT/c1/tools.ts" login-check "$D/link/discord.env" || fail "the plugin's server didn't reach Discord with the token"
listing="$("$OPT/as-cain" env CLAUDE_CODE_PLUGIN_SEED_DIR="$OPT/plugin-seed" timeout 120 claude plugin list 2>&1)"
printf '%s\n' "$listing" | grep -q 'discord@claude-plugins-official' || fail "the seed's discord plugin isn't listed: $(printf '%s' "$listing" | tail -n 3 | tr '\n' ' ' | cut -c1-200)"
"$OPT/c1/smoke.sh" || fail "the channel smoke test didn't pass"

# 3. Cut over. First the one copy that can fail for space, while a failure still undoes
# cleanly; then renames on the same disk, each undone if a later one fails.
mkdir -p -m 0700 "$D/c1/before" || fail "no /data/c1/before"
made+=("$D/c1/before")
cp -a "$D/work" "$D/c1/before/work" || fail "couldn't freeze a copy of /data/work"
moved=()
undo() {
  log "cutover stopped part way: $*; putting back what moved"
  for ((i=${#moved[@]}-1; i>=0; i--)); do mv "${moved[$i]##*|}" "${moved[$i]%%|*}" 2>/dev/null; done
  fail "$*"
}
mv_kept() { [ -e "$1" ] || return 0; mv "$1" "$2" && moved+=("$1|$2") || undo "couldn't move $1"; }
mv_kept "$D/.claude" "$D/c1/before/.claude"
mv_kept "$D/.claude.json" "$D/c1/before/.claude.json"
mv_kept "$D/.claude.json.backup" "$D/c1/before/.claude.json.backup"
install -d -m 2750 -o root -g cain "$D/gate"
for pair in "gate-report.jsonl:report.jsonl" "gate-replay.json:replay.json" "gate-tries.json:tries.json" "gate-dm.json:dm.json"; do
  mv_kept "$D/work/${pair%%:*}" "$D/gate/${pair##*:}"
done
mv_kept "$D/work/CLAUDE.md" "$D/c1/before/installed-CLAUDE.md"        # 0.11.0's installed copies
mv_kept "$D/work/.claude/settings.json" "$D/c1/before/installed-settings.json"
# From here on nothing is undone: the state is written last, so until it is, the state reads
# broken (a /data/cain with no state file) and Cain isn't started rather than started wrong.
chown -R cain:cain "$D/work" && chmod 0700 "$D/work" || { log "ERROR: couldn't hand /data/work to him"; exit 1; }
"$OPT/c1/lock.sh" data || { log "ERROR: section 3.2's modes didn't hold"; exit 1; }
bun "$OPT/c1/tools.ts" write-state "$D/c1/state" "cut over $(date -u +%Y-%m-%dT%H:%M:%SZ) c1"$'\n' || { log "ERROR: couldn't write the state"; exit 1; }
[ "$("$OPT/c1/state.sh")" = cut ] || { log "ERROR: the state doesn't read back as cut over"; exit 1; }
log "cut over: Cain runs as his own user from now on"
