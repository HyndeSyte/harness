#!/bin/bash
# Cain's way to change the record. The record keeper (record/main.ts) is its one
# writer; this hands it requests and reports what happened to them.
#   record.sh sha <path>        blob sha of a file as the keeper's copy has it ("new" if absent)
#   record.sh submit <file>     queue a request (JSON, see CLAUDE.md); prints its id
#   record.sh status <id>       done / conflict / rejected / relayed, or "waiting"
set -u
dir="${RECORD_DIR:-/data/record}"
queue="${RECORD_QUEUE:-/data/record-queue}"
outcomes="${RECORD_OUTCOMES:-/data/record-outcomes}"
case "${1:-}" in
  sha)
    f="$dir/${2:?path}"
    if [ -f "$f" ]; then git hash-object "$f"; else echo new; fi ;;
  submit)
    src="${2:?file}"
    id=$(jq -er '.id' "$src" 2>/dev/null) || { echo "not a request: needs JSON with an id" >&2; exit 2; }
    jq -e '.from and .kind and .summary' "$src" >/dev/null 2>&1 || { echo "a request needs from, kind and summary" >&2; exit 2; }
    mkdir -p "$queue"
    name="$(date -u +%Y%m%dT%H%M%S)-$(printf '%s' "$id" | tr -c 'A-Za-z0-9._:-' '_').json"
    cp "$src" "$queue/.$name" && mv "$queue/.$name" "$queue/$name"
    echo "$id" ;;
  status)
    id="${2:?id}"
    f="$outcomes/$(printf '%s' "$id" | tr -c 'A-Za-z0-9._:-' '_').json"
    if [ -f "$f" ]; then jq -r '"\(.state)\(if .reason then ": " + .reason else "" end)"' "$f"; else echo waiting; fi ;;
  *) echo "usage: record.sh sha <path> | submit <file> | status <id>" >&2; exit 2 ;;
esac
