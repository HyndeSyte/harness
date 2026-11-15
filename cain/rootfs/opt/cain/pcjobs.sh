#!/bin/bash
# Cain's way to the PC job queue: chores that need a browser signed in as Dane, run by a
# scheduled task on his PC (cain/docs/pc-jobs.md). The PC job keeper (pcjobs/main.ts) is
# the queue's one writer and holds its GitHub token; this hands it requests and reads
# its copy of the queue.
#   pcjobs.sh new <file>       queue one job (JSON, see CLAUDE.md); prints its request id
#   pcjobs.sh status <request> queued <job id> / refused: <why>, or "waiting"
#   pcjobs.sh list             every job: id | state | step action on site | expires | result
#   pcjobs.sh result <job id>  its result as JSON, or "no result yet"
set -u
queue="${PC_JOBS_QUEUE:-/data/pc-jobs-queue}"
outcomes="${PC_JOBS_OUTCOMES:-/data/pc-jobs-outcomes}"
main="${PC_JOBS_MAIN:-/opt/cain/pcjobs/main.ts}"
case "${1:-}" in
  new)
    src="${2:?file}"
    jq -e 'type == "object"' "$src" >/dev/null 2>&1 || { echo "not a job: needs a JSON object" >&2; exit 2; }
    mkdir -p "$queue"
    rid="pc-$(date -u +%Y%m%dT%H%M%S)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    jq -c '{from: "cain", job: .}' "$src" > "$queue/.$rid.json" && mv "$queue/.$rid.json" "$queue/$rid.json"
    echo "$rid" ;;
  status)
    rid="${2:?request id}"
    case "$rid" in *[!A-Za-z0-9._:-]*) echo "not a request id: $rid" >&2; exit 2 ;; esac
    f="$outcomes/$rid.json"
    if [ -f "$f" ]; then jq -r 'if .state == "queued" then "queued \(.id)" else "refused: \(.reason)" end' "$f"; else echo waiting; fi ;;
  list)   exec bun "$main" list ;;
  result) exec bun "$main" result "${2:?job id}" ;;
  *) echo "usage: pcjobs.sh new <file> | status <request id> | list | result <job id>" >&2; exit 2 ;;
esac
