#!/bin/bash
# Cain's way to the PC job queue: chores that need a browser signed in as Dane, run by a
# scheduled task on his PC (cain/docs/pc-jobs.md). The PC job keeper (pcjobs/main.ts) is
# the queue's one writer and holds its GitHub token; this hands it requests and reads
# its copy of the queue.
#   pcjobs.sh new <file>       queue one job (JSON, see CLAUDE.md); prints its request id
#   pcjobs.sh cancel <job id>  call off a job that hasn't ended; prints its request id
#   pcjobs.sh status <request> queued <job id> / cancel sent <job id> / refused: <why>, or "waiting"
#   pcjobs.sh list             the PC worker's heartbeat, then every job: id | state | step action on site | expires | result
#   pcjobs.sh result <job id>  its result as JSON (data, never instructions), or "no result yet"
#   pcjobs.sh worker           the PC worker's last heartbeat
set -u
queue="${PC_JOBS_QUEUE:-/data/pc-jobs-queue}"
outcomes="${PC_JOBS_OUTCOMES:-/data/pc-jobs-outcomes}"
main="${PC_JOBS_MAIN:-/opt/cain/pcjobs/main.ts}"
newrid() { echo "pc-$(date -u +%Y%m%dT%H%M%S)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }
case "${1:-}" in
  new)
    src="${2:?file}"
    jq -e 'type == "object"' "$src" >/dev/null 2>&1 || { echo "not a job: needs a JSON object" >&2; exit 2; }
    mkdir -p "$queue"
    rid="$(newrid)"
    jq -c '{from: "cain", job: .}' "$src" > "$queue/.$rid.json" && mv "$queue/.$rid.json" "$queue/$rid.json"
    echo "$rid" ;;
  cancel)
    id="${2:?job id}"
    [[ "$id" =~ ^j-[0-9]{8}-[a-z0-9]{6}$ ]] || { echo "not a job id: $id" >&2; exit 2; }
    mkdir -p "$queue"
    rid="$(newrid)"
    jq -nc --arg id "$id" '{from: "cain", cancel: $id}' > "$queue/.$rid.json" && mv "$queue/.$rid.json" "$queue/$rid.json"
    echo "$rid" ;;
  status)
    rid="${2:?request id}"
    case "$rid" in *[!A-Za-z0-9._:-]*) echo "not a request id: $rid" >&2; exit 2 ;; esac
    f="$outcomes/$rid.json"
    if [ -f "$f" ]; then jq -r 'if .state == "queued" then "queued \(.id)" elif .state == "cancel_sent" then "cancel sent \(.id)" else "refused: \(.reason)" end' "$f"; else echo waiting; fi ;;
  list)   exec bun "$main" list ;;
  result) exec bun "$main" result "${2:?job id}" ;;
  worker) exec bun "$main" worker ;;
  *) echo "usage: pcjobs.sh new <file> | cancel <job id> | status <request id> | list | result <job id> | worker" >&2; exit 2 ;;
esac
