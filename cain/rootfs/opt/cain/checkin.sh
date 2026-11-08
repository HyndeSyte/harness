#!/bin/bash
# Prompts Cain at set times so open work moves without Dane starting it.
# Run every 30 seconds by the service. Each slot fires once a day, within an hour
# of its time, and only when Cain is idle at his prompt (never mid-task).
# The prompt is typed into Cain's own session; it says it comes from the add-on,
# so Cain never takes it for Dane, or for his go on anything.
set -u
export TZ="${CHECKIN_TZ:-America/New_York}"
dir="${CHECKIN_DIR:-/data/checkins}"
mkdir -p "$dir"
now="${CHECKIN_NOW:-$(date +%H%M)}"
day="${CHECKIN_DAY:-$(date +%F)}"
slot=""
for s in 0710 1230 1730; do
  if [ "$now" -ge "$s" ] && [ "$now" -lt "$(( 10#$s + 100 ))" ]; then slot=$s; fi
done
[ -n "$slot" ] || exit 0
[ -f "$dir/$day-$slot" ] && exit 0
screen=$(tmux -u capture-pane -p -J -t cain 2>/dev/null) || exit 0
last=$(printf '%s\n' "$screen" | tail -n 12)
printf '%s' "$last" | grep -Eqi 'for shortcuts|auto mode' || exit 0     # at his prompt
printf '%s' "$last" | grep -Eqi 'esc to interrupt' && exit 0           # working: later
if [ "$slot" = 0710 ]; then
  msg="Scheduled check-in from the Cain add-on (morning). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md, then post Dane his morning update in Discord."
else
  msg="Scheduled check-in from the Cain add-on ($slot). Not a message from Dane, and not his go on anything. Follow the Check-ins section of your CLAUDE.md. Post to Dane only if something finished or needs his decision."
fi
tmux -u send-keys -t cain -l "$msg" && sleep 1 && tmux -u send-keys -t cain Enter || exit 1
touch "$dir/$day-$slot"
find "$dir" -type f -mtime +7 -delete 2>/dev/null
echo "[cain] check-in sent ($slot)"
