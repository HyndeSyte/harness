#!/bin/bash
# The c1 check, at each start of the new way (C1 plan 3.12): root runs c1/check.ts as Cain's
# own user, holding the pipe, and writes what it said to /data/trust/c1check.json with the
# time (root's file: he can read it, never write it). A failed check is relayed to Cain for
# the laptop session; nothing to tell Dane. Prints one line for the App log.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
OUT="${C1_CHECK_OUT:-/data/trust/c1check.json}"
raw="$(timeout 60 "$OPT/as-cain" bun "$OPT/c1/check.ts" 2>/dev/null | tail -n 1)"
if ! printf '%s' "$raw" | jq -e 'type == "object" and (.ok | type == "boolean") and (.failed | type == "array") and (.checks | type == "number")' >/dev/null 2>&1; then
  raw='{"ok": false, "failed": ["the check gave no answer"], "checks": 0}'
fi
body="$(printf '%s' "$raw" | jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{at: $at, ok, failed, checks, by: "root, running the check as cain"}')"
printf '%s\n' "$body" > "$OUT.tmp" && chmod 0644 "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
if [ "$(printf '%s' "$body" | jq -r .ok)" = true ]; then
  echo "[c1] check: all $(printf '%s' "$body" | jq -r .checks) held"
else
  why="$(printf '%s' "$body" | jq -r '.failed | join("; ")' | cut -c1-400)"
  echo "[c1] check FAILED: $why"
  printf '%s\n' "$(jq -cn --arg t "The c1 check of your own user found something open: $why. File it as a note on P33 for the laptop session. Nothing to tell him." '{text: $t}')" >> /data/relay.queue
fi
