#!/bin/bash
# The c1 check, at each start of the new way (C1 plan 3.12): root runs c1/check.ts as Cain's
# own user, holding the pipe, and writes what it said to /data/trust/c1check.json with the
# time (root's file: he can read it, never write it). Prints one line for the App log.
# - A breach stops Cain (C1 review service, theme 8): root records it for this version
#   (/data/c1/check-failed, "<version> <what>") and ends his session; the start then keeps him
#   stopped and tells Dane once, with the way back, until a new version is installed.
# - What couldn't be tried yet (the link not up), or a check that gave no answer, is tried again
#   a minute apart, up to five times; still not then, Cain hears it for the laptop session.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
OUT="${C1_CHECK_OUT:-/data/trust/c1check.json}"
MARK="${C1_CHECK_FAILED:-/data/c1/check-failed}"
QUEUE="${RELAY_QUEUE:-/data/relay.queue}"
VERSION="${C1_VERSION:-unknown}"
SOCK_TMUX="${SOCK_TMUX:-/run/cain/tmux/cain.sock}"
NOANSWER='{"ok": true, "failed": [], "unchecked": ["the check gave no answer"], "checks": 0}'
once() {
  local raw
  raw="$(timeout 60 "$OPT/as-cain" bun "$OPT/c1/check.ts" 2>/dev/null | tail -n 1)"
  if printf '%s' "$raw" | jq -e 'type == "object" and (.ok | type == "boolean") and (.failed | type == "array") and (.unchecked | type == "array") and (.checks | type == "number")' >/dev/null 2>&1; then
    printf '%s' "$raw"
  else printf '%s' "$NOANSWER"; fi
}
for try in 1 2 3 4 5; do
  raw="$(once)"
  [ "$(printf '%s' "$raw" | jq -r .ok)" = true ] || break                 # a breach doesn't wait
  [ "$(printf '%s' "$raw" | jq '.unchecked | length')" = 0 ] && break
  [ "$try" = 5 ] || sleep "${C1_CHECK_RETRY_S:-60}"
done
body="$(printf '%s' "$raw" | jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{at: $at, ok, failed, unchecked, checks, by: "root, running the check as cain"}')"
printf '%s\n' "$body" > "$OUT.tmp" && chmod 0644 "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
n="$(printf '%s' "$body" | jq -r .checks)"
if [ "$(printf '%s' "$body" | jq -r .ok)" != true ]; then
  why="$(printf '%s' "$body" | jq -r '.failed | join("; ")' | tr -d '\n' | cut -c1-300)"
  echo "[c1] check FAILED: $why. Cain is stopped until a new version is installed"
  printf '%s %s\n' "$VERSION" "$why" > "$MARK.tmp" && chmod 0600 "$MARK.tmp" && mv "$MARK.tmp" "$MARK"
  "$OPT/as-cain" tmux -u -S "$SOCK_TMUX" kill-session -t cain 2>/dev/null || true
elif [ "$(printf '%s' "$body" | jq '.unchecked | length')" != 0 ]; then
  not="$(printf '%s' "$body" | jq -r '.unchecked | join("; ")' | tr -d '\n' | cut -c1-300)"
  echo "[c1] check: $n held; not tried: $not"
  printf '%s\n' "$(jq -cn --arg t "The c1 check of your own user couldn't try everything after five tries ($not); what it tried held. File it as a note on P33 for the laptop session. Nothing to tell him." '{text: $t}')" >> "$QUEUE"
else
  echo "[c1] check: all $n held"
fi
