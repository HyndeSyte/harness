#!/bin/bash
# The c1 check of Cain's own user (C1 plan 3.12): root runs c1/check.ts as him, holding the
# pipe, and writes what it said to /data/trust/c1check.json with the time (root's file: he can
# read it, never write it). Prints one line for the App log, last. The start runs it itself, one
# try at a time, from its own loop, while his session runs (services.d/cain/run), and acts on
# the exit status, which is the authority: a stop or hold stands in that container even when
# its record couldn't be written.
# - A breach stops Cain (C1 review service, theme 8): root records it for this version
#   (/data/c1/check-failed, "<version> <what>"), ends his session and tells Dane at once, from
#   root (notice.sh), with the way back. The start keeps him stopped until a new version.
# - What couldn't be tried (the link not up yet), or a check that gave no answer: with
#   C1_UNTRIED=retry, exit 5 and nothing recorded (the start tries again a minute later, five
#   tries in all); otherwise his session is held, never left running unchecked (C1 second
#   review, must-fix 1): root records it (/data/c1/check-held, "<version> <what>"), ends his
#   session and tells Dane it's a pause, not a breach. Held, the start tries the check every 10
#   minutes without his session (C1_HELD=1: no session to end) and starts him once it finishes.
# - C1_CHECK_TRIES (default 1) tries a minute apart before deciding, for a run on its own.
# A record that can't be kept in /data/c1 is kept in /run/cain for this container (the start
# reads both); if neither can be written, it says so, and the exit status still decides.
# Exits 0 when everything held, 3 on a breach, 4 when he's held, 5 to be tried again.
set -uo pipefail
OPT="${C1_OPT:-/opt/cain}"
OUT="${C1_CHECK_OUT:-/data/trust/c1check.json}"
MARK="${C1_CHECK_FAILED:-/data/c1/check-failed}"
HELD="${C1_CHECK_HELD:-/data/c1/check-held}"
RUNMARKS="${C1_RUN_MARKS:-/run/cain}"
VERSION="${C1_VERSION:-unknown}"
SOCK_TMUX="${SOCK_TMUX:-/run/cain/tmux/cain.sock}"
TRIES="${C1_CHECK_TRIES:-1}"
# How many checks c1/check.ts makes when it can try everything (45: 35 that need nothing running,
# and 10 of the Supervisor, the panel's sockets and the link). An answer that says all held with
# fewer isn't a check that passed: it's taken as one that couldn't try everything (C1 third outside
# round). The image test pins the 35 (tests/image/in.sh final).
MIN="${C1_CHECK_MIN:-45}"
NOANSWER='{"ok": true, "failed": [], "unchecked": ["the check gave no answer"], "checks": 0}'
once() {
  local raw n
  raw="$(timeout 60 "$OPT/as-cain" bun "$OPT/c1/check.ts" 2>/dev/null | tail -n 1)"
  if ! printf '%s' "$raw" | jq -e 'type == "object" and (.ok | type == "boolean") and (.failed | type == "array") and (.unchecked | type == "array") and (.checks | type == "number")' >/dev/null 2>&1; then
    printf '%s' "$NOANSWER"; return
  fi
  n="$(printf '%s' "$raw" | jq -r .checks)"; n="${n%%.*}"; [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if [ "$(printf '%s' "$raw" | jq -r .ok)" = true ] && [ "$(printf '%s' "$raw" | jq '.unchecked | length')" = 0 ] && [ "$n" -lt "$MIN" ]; then
    jq -nc --arg u "the check ran only $n of its $MIN checks" --arg c "$n" '{ok: true, failed: [], unchecked: [$u], checks: ($c | tonumber)}'
    return
  fi
  printf '%s' "$raw"
}
mark() {   # mark <file> <what>: in /data/c1, else in /run/cain for this container; 1 if neither
  if { printf '%s %s\n' "$VERSION" "$2" > "$1.tmp" && chmod 0600 "$1.tmp" && mv "$1.tmp" "$1"; } 2>/dev/null; then return 0; fi
  rm -f "$1.tmp" 2>/dev/null
  echo "[c1] couldn't keep $1, so it's kept in $RUNMARKS/${1##*/} for this container" >&2
  if { printf '%s %s\n' "$VERSION" "$2" > "$RUNMARKS/${1##*/}" && chmod 0600 "$RUNMARKS/${1##*/}"; } 2>/dev/null; then return 0; fi
  echo "[c1] couldn't keep it in $RUNMARKS either: only this run's exit status stops him" >&2
  return 1
}
unmark() { rm -f "$1" "$RUNMARKS/${1##*/}" 2>/dev/null; }
end_session() { [ "${C1_HELD:-}" = 1 ] || timeout 10 "$OPT/as-cain" tmux -u -S "$SOCK_TMUX" kill-session -t cain 2>/dev/null || true; }
try=0
while :; do
  try=$((try + 1))
  raw="$(once)"
  [ "$(printf '%s' "$raw" | jq -r .ok)" = true ] || break                 # a breach doesn't wait
  [ "$(printf '%s' "$raw" | jq '.unchecked | length')" = 0 ] && break
  [ "$try" -ge "$TRIES" ] && break
  sleep "${C1_CHECK_RETRY_S:-60}"
done
body="$(printf '%s' "$raw" | jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{at: $at, ok, failed, unchecked, checks, by: "root, running the check as cain"}')"
{ printf '%s\n' "$body" > "$OUT.tmp" && chmod 0644 "$OUT.tmp" && mv "$OUT.tmp" "$OUT"; } 2>/dev/null || echo "[c1] couldn't write $OUT" >&2
n="$(printf '%s' "$body" | jq -r .checks)"
if [ "$(printf '%s' "$body" | jq -r .ok)" != true ]; then
  why="$(printf '%s' "$body" | jq -r '.failed | join("; ")' | tr -d '\n' | cut -c1-300)"
  mark "$MARK" "$why" || true; unmark "$HELD"
  end_session
  "$OPT/notice.sh" tell breach >&2 || true
  echo "[c1] check FAILED: $why. Cain is stopped until a new version is installed"
  exit 3
elif [ "$(printf '%s' "$body" | jq '.unchecked | length')" != 0 ]; then
  not="$(printf '%s' "$body" | jq -r '.unchecked | join("; ")' | tr -d '\n' | cut -c1-300)"
  if [ "${C1_UNTRIED:-hold}" = retry ]; then echo "[c1] check: $n held; not tried yet: $not"; exit 5; fi
  mark "$HELD" "$not" || true
  end_session
  "$OPT/notice.sh" tell held >&2 || true
  echo "[c1] check: $n held; not tried: $not. His session is held (not a breach) until it can be"
  exit 4
else
  unmark "$HELD"
  echo "[c1] check: all $n held"
fi
