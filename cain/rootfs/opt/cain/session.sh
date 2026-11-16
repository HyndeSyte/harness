#!/bin/bash
# Runs inside tmux. Keeps one Claude Code session up, with the Discord channel.
# If it exits (or he types /exit after signing in), it starts again in 5 s.
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
exec 2>>/data/session.log
echo "$(date -Is) session.sh starting (${CAIN_MODE:-old})" >&2
cd /data/work || { echo "no /data/work" >&2; exit 1; }
while true; do
  claude --permission-mode auto --channels plugin:discord@claude-plugins-official
  echo "$(date -Is) claude exited ($?)" >&2
  echo "Claude Code exited. Starting again in 5 seconds."
  sleep 5
done
