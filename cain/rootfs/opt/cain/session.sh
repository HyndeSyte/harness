#!/bin/bash
# Runs inside tmux. Keeps one Claude Code session up, with the Discord channel.
# If it exits (or he types /exit after signing in), it starts again in 5 s.
# Errors from this script (not the session's screen) go to /data/session.log.
export HOME=/data
exec 2>>/data/session.log
echo "$(date -Is) session.sh starting" >&2
cd /data/work || { echo "no /data/work" >&2; exit 1; }
while true; do
  claude --permission-mode auto --channels plugin:discord@claude-plugins-official
  echo "$(date -Is) claude exited ($?)" >&2
  echo "Claude Code exited. Starting again in 5 seconds."
  sleep 5
done
