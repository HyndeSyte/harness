#!/bin/bash
# Runs inside tmux. Keeps one Claude Code session up, with the Discord channel.
# If it exits (or he types /exit after signing in), it starts again in 5 s.
export HOME=/data
cd /data/work || exit 1
while true; do
  claude --permission-mode auto --channels plugin:discord@claude-plugins-official
  echo "Claude Code exited ($?). Starting again in 5 seconds."
  sleep 5
done
