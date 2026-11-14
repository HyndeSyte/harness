#!/bin/bash
# Which state this App is in (C1 plan 3.12). Prints one word, and nothing else decides how
# Cain starts:
#   fresh      never switched: no state file, no journal, no /data/cain, no /data/gate. Cain
#              runs the old way (state A) until the specialist signs, then switches (state B).
#   switching  a switch began and didn't finish: /data/c1/journal, well formed, and no state
#              file. The switch resumes (after its commit) or is undone (before it).
#   cut        switched: the state file reads exactly "cut over <ISO time> c1", and /data/cain
#              and the token's new home exist. Cain runs only as his own user (state C).
#   broken     anything else. Cain isn't started; it is never read as fresh, so a damaged
#              state can't bring back the old root session.
set -u
DATA="${C1_DATA:-/data}"
OPT="${C1_OPT:-/opt/cain}"
STATE="$DATA/c1/state"
J="$DATA/c1/journal"
there() { [ -e "$1" ] || [ -L "$1" ]; }
rootfile() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ]; }

if ! there "$STATE"; then
  if ! there "$J"; then
    if ! there "$DATA/cain" && ! there "$DATA/gate"; then echo fresh; else echo broken; fi
    exit 0
  fi
  if rootfile "$J" && [ "$(bun "$OPT/c1/tools.ts" journal-check "$J" 2>/dev/null)" != bad ]; then echo switching; else echo broken; fi
  exit 0
fi
if ! rootfile "$STATE" || [ ! -r "$STATE" ]; then echo broken; exit 0; fi
line="$(head -c 200 "$STATE" 2>/dev/null)"
if printf '%s' "$line" | grep -Eq '^cut over [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z c1$' \
   && [ "$(wc -l < "$STATE")" -le 1 ] \
   && [ -d "$DATA/cain" ] && [ ! -L "$DATA/cain" ] && [ -f "$DATA/link/discord.env" ]; then
  echo cut
else
  echo broken
fi
