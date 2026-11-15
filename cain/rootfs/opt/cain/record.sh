#!/bin/bash
# Cain's way to change the record. The record keeper (record/main.ts) is its one
# writer; this hands it requests and reports what happened to them.
#   record.sh sha <path>        blob sha of a file as the keeper's copy has it ("new" if absent)
#   record.sh rowsha <item>     base for a row edit of state/PENDING.md: sha1 of that open row's line
#   record.sh holds             who holds which item, as the keeper last pushed it (state/holds.json)
#   record.sh notes [<item>|-] [<since>]
#                               notes filed on an item, oldest first, one table row each
#                               (| when | from | note |). With no item (or -): every item's notes
#                               but those someone other than Cain holds, each line led by its item.
#                               <since>: only notes after that time (any ISO form or offset).
#   record.sh submit <file>     queue a request (JSON, see CLAUDE.md); prints its id
#   record.sh status <id>       done / conflict / rejected / refused / relayed, or "waiting"
#   record.sh block-push [minutes]
#                               the device smoke test only: the record keeper's next round (or, with
#                               minutes, every round for that long) pushes to a wrong remote (its push
#                               fails, its local commits stay), then it pushes as usual
#   record.sh clock-test <header-only|none|step:-N|off>
#                               the device smoke test only: one round with the box's own clock sources
#                               left out (GitHub's Date header decides), no source synchronized, or the
#                               keeper's clock N seconds off, until off
#   record.sh leak-check [files]
#                               the device smoke test only: the record keeper says per file (its log copy,
#                               its status, the relay queue, and the files named) whether its token or a
#                               web address's userinfo is in it, printing yes or no, never the match
#   record.sh force-conflict    the device smoke test only: the next round with unpushed local commits
#                               resets the keeper's copy, as a rebase conflict would
set -u
dir="${RECORD_DIR:-/data/record}"
queue="${RECORD_QUEUE:-/data/record-queue}"
outcomes="${RECORD_OUTCOMES:-/data/record-outcomes}"
ref="origin/${RECORD_BRANCH:-main}"
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
case "${1:-}" in
  sha)
    f="$dir/${2:?path}"
    if [ -f "$f" ]; then git hash-object "$f"; else echo new; fi ;;
  rowsha)
    item=$(upper "${2:?item}")
    # The row whose first cell is the item, in the table under "## Open"; exactly one.
    line=$(awk -v id="$item" '
      { sub(/\r$/, "") }
      /^## / { open = (tolower($0) ~ /^##[ \t]+open[ \t]*$/); next }
      open && /^\|/ { s = $0; sub(/^\|/, "", s); split(s, c, "|"); gsub(/^[ \t]+|[ \t]+$/, "", c[1]); if (c[1] == id) { print; n++ } }
      END { if (n != 1) exit 1 }' "$dir/state/PENDING.md" 2>/dev/null) || { echo "no single open row $item" >&2; exit 1; }
    printf '%s' "$line" | sha1sum | cut -c1-40 ;;
  holds)
    git -C "$dir" show "$ref:state/holds.json" 2>/dev/null || echo '{}' ;;
  notes)
    item="${2:-}"; since="${3:-}"
    if [ -n "$since" ]; then
      since=$(date -u -d "$since" +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null) || { echo "not a time: $3" >&2; exit 2; }
    fi
    # One item's notes, each line led by $2: as the keeper pushed them, or the copy here.
    note_rows() {
      { git -C "$dir" show "$ref:state/notes/$1.md" 2>/dev/null || cat "$dir/state/notes/$1.md" 2>/dev/null; } \
        | tr -d '\r' | awk -F'|' -v since="$since" -v lead="$2" '/^\|[ \t]*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/ {
            w = $2; gsub(/^[ \t]+|[ \t]+$/, "", w); if (since == "" || w > since) print lead $0 }'
    }
    if [ -n "$item" ] && [ "$item" != "-" ]; then
      item=$(upper "$item")
      case "$item" in [!A-Z0-9]*|*[!A-Z0-9._-]*) echo "not an item id: $2" >&2; exit 2 ;; esac
      note_rows "$item" ""
    else
      # Items someone other than Cain holds are theirs to read.
      others=$({ git -C "$dir" show "$ref:state/holds.json" 2>/dev/null || cat "$dir/state/holds.json" 2>/dev/null || echo '{}'; } \
        | jq -r 'to_entries[] | select(.value.holder != "cain") | .key') || { echo "couldn't read the holds" >&2; exit 1; }
      for i in $({ git -C "$dir" ls-tree --name-only "$ref" state/notes/ 2>/dev/null || ls "$dir/state/notes" 2>/dev/null; } \
          | sed -n 's#^\(state/notes/\)\{0,1\}\([A-Z0-9][A-Z0-9._-]*\)\.md$#\2#p'); do
        printf '%s\n' "$others" | grep -qxF "$i" && continue
        note_rows "$i" "$i "
      done
    fi ;;
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
  block-push)
    # The keeper removes it once that round's push has failed; with minutes, once they have passed.
    f="${RECORD_BLOCK_PUSH:-/data/record-block-push}"
    case "${2:-}" in
      '') : > "$f" && echo "the record keeper's next round pushes to a wrong remote, once" ;;
      *[!0-9]*) echo "block-push takes a number of minutes" >&2; exit 2 ;;
      *) echo $(( ($(date +%s) + 60 * $2) * 1000 )) > "$f" && echo "the record keeper's rounds push to a wrong remote for the next $2 minutes" ;;
    esac ;;
  clock-test)
    # The smoke test's clock switch: header-only (one round, GitHub's Date header alone), none
    # (no clock source says synchronized), step:-600 (the keeper's clock reads 600 seconds early),
    # off.
    f="${RECORD_CLOCK_TEST:-/data/record-clock-test}"
    case "${2:-}" in
      header-only|none) printf '%s\n' "$2" > "$f" && echo "clock test: $2" ;;
      step:-[0-9]*|step:[0-9]*) printf '%s\n' "$2" > "$f" && echo "clock test: $2" ;;
      off) rm -f "$f" && echo "clock test: off" ;;
      *) echo "clock-test takes header-only, none, step:-<seconds> or off" >&2; exit 2 ;;
    esac ;;
  leak-check)
    # The record keeper (which alone holds the token) reads its log copy, its status file, the relay
    # queue and the files named here, and says per file whether the token or a web address's
    # userinfo is in them: yes or no, never the match.
    f="${RECORD_LEAK_CHECK:-/data/record-leak-check}"
    shift
    rm -f "$f.json"
    : > "$f.tmp"; for p in "$@"; do case "$p" in /*) printf '%s\n' "$p" >> "$f.tmp" ;; *) printf '%s\n' "$PWD/$p" >> "$f.tmp" ;; esac; done
    mv "$f.tmp" "$f"
    for _ in $(seq 1 60); do [ -f "$f.json" ] && break; sleep 2; done
    if [ -f "$f.json" ]; then jq -c '{clean, files: [.files[] | {path, token, userinfo}]}' "$f.json"; else echo '{"clean":null,"said":"the record keeper did not answer within 2 minutes"}'; exit 1; fi ;;
  force-conflict)
    # The next round with unpushed local commits treats their rebase as a conflict and resets.
    : > "${RECORD_FORCE_CONFLICT:-/data/record-force-conflict}" && echo "the record keeper's next round with unpushed commits resets its copy, as after a conflict" ;;
  *) echo "usage: record.sh sha <path> | rowsha <item> | holds | notes [<item>|-] [<since>] | submit <file> | status <id> | block-push [minutes] | clock-test <header-only|none|step:-N|off> | force-conflict | leak-check [files]" >&2; exit 2 ;;
esac
