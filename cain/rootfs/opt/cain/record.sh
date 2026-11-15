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
#                               Cain reading all of one item's notes (no <since>) marks them
#                               read (see unread).
#   record.sh unread [<since>]  the items whose notes changed since Cain last read them with
#                               `notes <item>`, each as its newest note led by the item; an item
#                               he has never read counts only notes after <since>. The check-in
#                               names these until he reads them.
#                               Notes are only ever the record's (its main as this copy has it);
#                               when that can't be read, notes and unread say so and exit 3.
#   record.sh submit <file>     queue a request (JSON, see CLAUDE.md); prints its id
#   record.sh status <id>       done / conflict / rejected / refused / relayed, or "waiting"
set -u
dir="${RECORD_DIR:-/data/record}"
queue="${RECORD_QUEUE:-/data/record-queue}"
outcomes="${RECORD_OUTCOMES:-/data/record-outcomes}"
ref="origin/${RECORD_BRANCH:-main}"
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
# Where his reads are marked: his own home once he runs as his own user (C1), else /data.
home="${CAIN_HOME_DIR:-/data/cain}"
reads="${NOTES_READ_DIR:-$([ -d "$home" ] && echo "$home/notes-read" || echo /data/notes-read)}"
# Notes are only ever the record's: what the keeper pushed (its main, as this copy fetched it).
# A copy here that git doesn't have is never taken for one, and with no readable main, nothing is
# read: the command says so, with exit 3, instead of reading files here.
record_ok() { git -C "$dir" rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; }
cant_read() { echo "The record's notes couldn't be read: this copy of the record, its $ref or its holds, can't be read." >&2; exit 3; }
# A path's entry in the record's tree: what ls-tree says of it ("" when the tree has no such path);
# fails when the tree can't be read, so a tree git can't walk is never taken for an empty one.
tree_entry() { git -C "$dir" ls-tree "$ref" -- "$1" 2>/dev/null; }
# An item's notes file in the record: its id from the record's tree, then its text by that id, so
# what is shown, and marked read, is exactly that file. Exit 1: the tree has no notes on it; exit 2:
# the tree can't be read.
notes_id() {
  local e
  e=$(tree_entry "state/notes/$1.md") || return 2
  [ -n "$e" ] || return 1
  e="${e#* blob }"; printf '%s\n' "${e%%$'\t'*}"
}
# The record's holds: {} only when its tree has no holds file; the file, read from git, when it
# has one; and a failure when the tree or that file can't be read (never taken for no holds).
holds_json() {
  local e
  e=$(tree_entry state/holds.json) || return 1
  [ -n "$e" ] || { echo '{}'; return 0; }
  git -C "$dir" cat-file blob "$ref:state/holds.json" 2>/dev/null
}
# Sets text to the bytes of item $1's notes file whose id is $2 (from the record's tree): from git
# by that id, or else the copy here only when it hashes to that id (the x keeps its last newlines
# through the $(...)). Taken once, so what is checked is what is shown. Fails, with text empty,
# when neither is that file.
take_text() {
  if text=$(git -C "$dir" cat-file blob "$2" 2>/dev/null && printf x); then text="${text%x}"; return 0; fi   # that object
  text=$(cat "$dir/state/notes/$1.md" 2>/dev/null && printf x) || { text=""; return 1; }
  text="${text%x}"
  [ "$(printf '%s' "$text" | git hash-object --no-filters --stdin 2>/dev/null)" = "$2" ] || { text=""; return 1; }
}
unreadable() { printf '%s\n' "$1 | ? | ? | its notes couldn't be read as the record has them |"; }
# Its rows, each led by $2, only those after $1 (an empty $1: all). Fails if any step of it does.
note_rows() (
  set -o pipefail
  tr -d '\r' | awk -F'|' -v since="$1" -v lead="$2" '/^\|[ \t]*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/ {
      w = $2; gsub(/^[ \t]+|[ \t]+$/, "", w); if (since == "" || w > since) print lead $0 }'
)
iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null; }
# Cain's items with notes in the record: every notes file in its tree but those on items someone
# other than Cain holds (a record with no holds file holds nothing for anyone). Fails when the
# record or its holds can't be read.
his_items() {
  local others list
  record_ok || return 1
  others=$(set -o pipefail; holds_json | jq -r 'to_entries[] | select(.value.holder != "cain") | .key') \
    || { echo "couldn't read the holds" >&2; return 1; }
  list=$(git -C "$dir" ls-tree --name-only "$ref" state/notes/ 2>/dev/null) || return 1
  printf '%s\n' "$list" | sed -n 's#^state/notes/\([A-Z0-9][A-Z0-9._-]*\)\.md$#\1#p' \
    | while IFS= read -r i; do printf '%s\n' "$others" | grep -qxF "$i" || printf '%s\n' "$i"; done
}
# Only Cain's own reads count: root reading after the switch marks nothing (and makes no folder of
# root's in his home). A marker that can't be written leaves the item unread: named again, never lost.
mark_read() {
  [ "$(id -u)" = 0 ] && [ -d "$home" ] && [ -z "${NOTES_READ_DIR:-}" ] && return 0
  mkdir -p "$reads" 2>/dev/null || return 0
  local t="$reads/.$1.$$"
  { printf '%s\n' "$2" > "$t" && mv -f "$t" "$reads/$1"; } 2>/dev/null || rm -f "$t" 2>/dev/null
  return 0
}
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
    record_ok || cant_read
    holds_json || cant_read ;;
  notes)
    item="${2:-}"; since="${3:-}"
    if [ -n "$since" ]; then since=$(iso "$since") || { echo "not a time: $3" >&2; exit 2; }; fi
    if [ -n "$item" ] && [ "$item" != "-" ]; then
      item=$(upper "$item")
      case "$item" in [!A-Z0-9]*|*[!A-Z0-9._-]*) echo "not an item id: $2" >&2; exit 2 ;; esac
      record_ok || cant_read
      id=$(notes_id "$item"); case $? in 0) ;; 1) exit 0 ;; *) cant_read ;; esac   # 1: the record has no notes on it
      # Read means all of that file was shown: taken once and checked (take_text), then shown
      # whole, and marked only when every step of that succeeded. A read that failed anywhere, or
      # one cut by a time, marks nothing; notes that aren't the record's file aren't shown at all.
      take_text "$item" "$id" || { echo "The notes on $item couldn't be read as the record has them; nothing is marked read." >&2; exit 1; }
      printf '%s' "$text" | note_rows "$since" ""
      shown=("${PIPESTATUS[@]}")
      { [ "${shown[0]}" = 0 ] && [ "${shown[1]}" = 0 ]; } || exit 1
      [ -z "$since" ] && mark_read "$item" "$id"
      exit 0
    else
      # Items someone other than Cain holds are theirs to read.
      items=$(his_items) || cant_read
      for i in $items; do
        id=$(notes_id "$i"); case $? in 0) ;; 1) continue ;; *) unreadable "$i"; continue ;; esac
        if take_text "$i" "$id" && rows=$(printf '%s' "$text" | note_rows "$since" "$i "); then
          [ -n "$rows" ] && printf '%s\n' "$rows"
        else
          unreadable "$i"
        fi
      done
    fi ;;
  unread)
    since="${2:-}"
    if [ -n "$since" ]; then since=$(iso "$since") || { echo "not a time: $2" >&2; exit 2; }; fi
    items=$(his_items) || cant_read
    for i in $items; do
      id=$(notes_id "$i"); case $? in 0) ;; 1) continue ;; *) unreadable "$i"; continue ;; esac
      if [ -f "$reads/$i" ]; then
        # Read before: unread again once the file changed in any way (a note with an old or
        # equal time included), so its newest note shows whatever its time.
        [ "$(head -n 1 "$reads/$i" 2>/dev/null)" = "$id" ] && continue
        after=""
      else
        after="$since"
      fi
      # Notes that can't be read as the record has them are named all the same, never shown from a
      # copy that isn't that file, so the item stays on the list.
      if take_text "$i" "$id" && last=$(printf '%s' "$text" | note_rows "$after" "$i "); then
        [ -n "$last" ] && printf '%s\n' "${last##*$'\n'}"
      else
        unreadable "$i"
      fi
    done ;;
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
  *) echo "usage: record.sh sha <path> | rowsha <item> | holds | notes [<item>|-] [<since>] | unread [<since>] | submit <file> | status <id>" >&2; exit 2 ;;
esac
