#!/bin/bash
# Runs inside tmux: one Claude Code session, with the Discord channel. When it exits, this ends,
# and with it his tmux session: the run script starts him again, and checks the new session of his
# own user before anything is typed into it, so no start goes unchecked (Cain's third service
# review: until now this started Claude Code again by itself, which nothing checked).
# Errors from this script (not the session's screen) go to /data/session.log.
#   CAIN_MODE=own   the new way (C1): run as his own user by as-cain, his home /data/cain, the
#                   pinned plugin from the image's seed, whose channel runs through the broker.
#   CAIN_MODE=old   the old way, as root, as 0.11.0 ran.
if [ "${CAIN_MODE:-}" = own ]; then
  export HOME=/data/cain CLAUDE_CODE_PLUGIN_SEED_DIR=/opt/cain/plugin-seed DISABLE_AUTOUPDATER=1
else
  export HOME=/data
fi
# No gray suggested prompts in his input box: no one is at his screen to take one, each costs a
# request, and the App types only into an empty box (prompt-state.sh), which one would fill. The
# variable outranks any setting (Claude Code's docs, "Turn prompt suggestions off").
export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false
# His context kept small (Cain 0.20.0): his session compacts once its context reaches
# lean/core.ts COMPACT_AT_TOKENS (250K, well before 300K), set here in code, never by hand. Claude
# Code takes it as a percentage of the model's context window (1M for his model). 25 if bun can't say.
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="$(timeout 20 bun /opt/cain/lean/main.ts compact-pct 2>/dev/null | tr -cd '0-9')"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-25}"
# The outside heartbeat's URL is the security watch's alone (services.d/cain/run): never Claude's.
# No xtrace around it (third round), put back as it was after.
case $- in *x*) hb_xtrace=1 ;; *) hb_xtrace= ;; esac
{ set +x; } 2>/dev/null
unset HEARTBEAT_URL
if [ -n "${hb_xtrace}" ]; then set -x; fi
unset hb_xtrace
exec 2>>/data/session.log
echo "$(date -Is) session.sh starting (${CAIN_MODE:-old})" >&2
cd /data/work || { echo "no /data/work" >&2; exit 1; }
claude --permission-mode auto --channels plugin:discord@claude-plugins-official
rc=$?
echo "$(date -Is) claude exited ($rc): the App starts his session again, and checks it first" >&2
# Its exit code, for the run script's count of early exits (Cain 0.14.0, probe/core.ts endKind):
# his own folder the new way, root's the old way. The code only says how a run ended, never whether
# the App asked for the end (a root-owned mark says that) and never whether it counts (how long the
# run lasted, as root saw it, says that): his own user can write this file and end his own session.
if [ "${CAIN_MODE:-}" = own ]; then exitf=/run/cain/tmux/claude.rc; else exitf=/run/cain/claude.rc; fi
printf '%s\n' "$rc" > "$exitf" 2>/dev/null || true
