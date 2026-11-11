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
  *) echo "usage: record.sh sha <path> | rowsha <item> | holds | notes [<item>|-] [<since>] | submit <file> | status <id>" >&2; exit 2 ;;
esac
