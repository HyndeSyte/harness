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
echo "$(date -Is) claude exited ($?): the App starts his session again, and checks it first" >&2
