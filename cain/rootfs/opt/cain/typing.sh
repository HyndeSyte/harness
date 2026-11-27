#!/bin/bash
# What checkin.sh, unstick.sh and watch.sh share about typing into Cain's session: sourced, never
# run. Every tmux call goes through $TM (Cain's own user and his socket the new way: the run script
# sets TMUX_CMD; root is never a client of his tmux server), and every read or write of his files
# through as_him (his own user the new way: the run script sets CAIN_AS), so root never follows a
# link he made.
TM="${TMUX_CMD:-tmux}"   # not TMUX: tmux reads that name itself
# The App's try in his box, kept (in /data, across restarts) from before its first key until it's
# known to be in or known not to be: one field a line, "name value", its text last (checkin.sh).
TRY="${CHECKIN_TRY:-/data/checkin.try}"
# His session's transcripts: Claude Code writes each line sent to it there, as sent, within a
# second or so (a real Claude Code 2.1.317, Nov 16).
TRANSCRIPTS="${CAIN_TRANSCRIPTS:-/data/cain/.claude/projects}"
# Text of the App's for him too long or unusual to type: files of his, in his own folder.
FROM_APP="${CAIN_FROM_APP:-/data/work/from-app}"

as_him() { if [ -n "${CAIN_AS:-}" ]; then timeout -k 2 20 $CAIN_AS "$@"; else timeout -k 2 20 "$@"; fi; }
# His screen, with what scrolled up out of sight (400 lines), each wrapped line joined.
screen_now() { timeout -k 2 10 $TM -u capture-pane -p -J -t cain -S -400 2>/dev/null; }
pane_pid() { timeout -k 2 10 $TM -u display -p -t cain '#{pane_pid}' 2>/dev/null | tr -cd '0-9'; }
# Whether the run script's mark says his session, as it runs now, passed its check of his own
# user: the mark holds the process his pane runs (session.sh, which runs Claude Code once and ends
# with it), so a session started since has no mark of its own until its check passes (Cain's
# fourth service review, fix soon 10).
checked() {   # checked <the mark's file>
  local m
  m="$(head -c 20 "$1" 2>/dev/null | tr -cd '0-9')"
  [ -n "$m" ] && [ "$(pane_pid)" = "$m" ]
}
# The text as the App types it: as it is, but for control characters, which typing would turn into
# keys (a tab, a line end, an Esc): a tab or line end is a space, any other is left out. Nothing else
# is changed: a long address or code goes as written (outside round 19).
keyless() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037\177' | tr '\t\r\n' '   '; }
# Whether a text goes typed as it is: plain printable ASCII, at most 400 characters (well under
# Claude Code's paste folding and his 40-row window). Any other goes as a file (checkin.sh): a
# wide or joined character draws in a width no count of characters gives, so his box's wrapping of
# it can't be known (a real Claude Code 2.1.317 cut a line of one short of the width; Cain's fourth
# service review, must-fix 4).
plain() { [ "${#1}" -le "${TYPING_CAP:-400}" ] && ! printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'; }
# Whether a draft's lines (prompt-state.sh's PROMPT_DRAFT_TEXT, one drawn line a line) are exactly
# the text as his box wraps it at a width of w columns of text (the window's width less 4, as a real
# Claude Code 2.1.317 drew it at 60 and 120): each line the next stretch of the text; between lines,
# the blanks a wrap at a space took, or, where a word too long for a line was cut, nothing, which
# only a full line of plain letters shows. With "part", a beginning of the text will do (the try
# still drawing, or cut short), its last line ending anywhere (outside round 19).
whole() {   # whole <lines> <text> <w> [part]
  printf '%s\n' "$1" | WANT="$2" W="$3" PART="${4:-}" awk '
    NF { l[++n] = $0 }
    END {
      rest = ENVIRON["WANT"]; w = ENVIRON["W"] + 0; ok = (n > 0)
      for (i = 1; ok && i <= n; i++) {
        if (substr(rest, 1, length(l[i])) != l[i]) { ok = 0; break }
        rest = substr(rest, length(l[i]) + 1)
        if (i == n && ENVIRON["PART"] != "") break
        if (rest ~ /^ /) sub(/^ +/, "", rest)
        else if (rest != "" && !(length(l[i]) == w && l[i] !~ /[^\001-\177]/)) ok = 0
      }
      if (!ok) exit 1
      if (ENVIRON["PART"] != "") exit 0
      exit !(rest ~ /^ *$/)
    }'
}
# The width his box wraps at: the window as tmux has it now, less 4; 0 when it can't be read.
width() {
  local c
  c=$(timeout -k 2 10 $TM -u display -p -t cain '#{pane_width}' 2>/dev/null | tr -cd '0-9')
  [ -n "$c" ] && [ "$c" -gt 4 ] && echo $((c - 4)) || echo 0
}
# A field of the try ($TRY), or nothing.
try_get() { sed -n "s/^$1 //p" "$TRY" 2>/dev/null | head -n 1; }
# Whether a draft's lines are the App's try: 0 all of it, 1 a beginning of it, 2 not its.
own_try() {   # own_try <lines> <w>
  local want
  want="$(try_get want)"
  [ -n "$want" ] || return 2
  whole "$1" "$want" "$2" && return 0
  whole "$1" "$want" "$2" part && return 1
  return 2
}
# Whether a mark is in a transcript of his written since <epoch> (a minute or two of slack).
in_transcript() {   # in_transcript <mark> <epoch>
  local mins=$(( ( $(date +%s) - $2 ) / 60 + 2 ))
  [ "$mins" -gt 1 ] || mins=2
  as_him find "$TRANSCRIPTS" -type f -name '*.jsonl' -mmin "-$mins" -exec grep -lF -- "[$1]" {} + 2>/dev/null | grep -q .
}
# Whether a mark is on his screen above his input box, where Claude Code shows a line once it's
# sent (or queued to be), never in the box itself (prompt-state.sh's PROMPT_ABOVE).
above() {   # above <mark> <screen>
  printf '%s\n' "$2" | PROMPT_ABOVE=1 "${PS:-/opt/cain/prompt-state.sh}" 2>/dev/null | sed 1d | grep -qF -- "[$1]"
}
# A new mark for a try: eight random hex digits, never one his transcripts of the last two days
# hold (it's the try's proof of being in).
new_mark() {
  local m i
  for i in 1 2 3; do
    m="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -cd '0-9a-f')"
    [ "${#m}" = 8 ] || return 1
    in_transcript "$m" $(( $(date +%s) - 172800 )) || { printf '%s' "$m"; return 0; }
  done
  return 1
}
# Whether his screen holds what the App types though his prompt may look ready (Cain 0.20.0): a usage or
# spend limit that is the newest thing on it, or a compaction at work (lean/held.sh). 0 when held.
held_now() { printf '%s\n' "$1" | "${LEAN_HELD:-${OPT:-/opt/cain}/lean/held.sh}" >/dev/null 2>&1; }
# A file of his in $FROM_APP, written whole, as his own (the new way).
put_his() {   # put_his <name> <text>
  printf '%s\n' "$2" | as_him sh -c 'umask 077; mkdir -p "$1" && cat > "$1/.$2" && mv -f "$1/.$2" "$1/$2"' sh "$FROM_APP" "$1"
}
