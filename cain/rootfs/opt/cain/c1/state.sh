#!/bin/bash
# Which of the three states this App is in (C1 plan 3.12). Prints one word and nothing else
# ever decides how Cain starts:
#   fresh   never cut over: no state file and no /data/cain. Cain may run the old way, as
#           root, until the specialist signs; then the first start validates and cuts over.
#   cut     cut over: the state file reads exactly "cut over <ISO time> c1", and
#           /data/cain and the token's new home exist. Cain runs only as his own user.
#   broken  anything else: an empty, unreadable or malformed state file, a state file with no
#           /data/cain, a /data/cain with no state file. Cain isn't started at all; it is never
#           read as fresh, so a damaged state can't bring back the old root session.
set -u
DATA="${C1_DATA:-/data}"
STATE="$DATA/c1/state"
if [ ! -e "$STATE" ] && [ ! -L "$STATE" ]; then
  if [ ! -e "$DATA/cain" ] && [ ! -L "$DATA/cain" ]; then echo fresh; else echo broken; fi
  exit 0
fi
if [ -L "$STATE" ] || [ ! -f "$STATE" ] || [ ! -r "$STATE" ]; then echo broken; exit 0; fi
line="$(head -c 200 "$STATE" 2>/dev/null)"
if printf '%s' "$line" | grep -Eq '^cut over [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z c1$' \
   && [ "$(wc -l < "$STATE")" -le 1 ] \
   && [ -d "$DATA/cain" ] && [ ! -L "$DATA/cain" ] && [ -f "$DATA/link/discord.env" ]; then
  echo cut
else
  echo broken
fi
