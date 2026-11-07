#!/bin/bash
# Print the newest Claude sign-in link on the screen text read from stdin,
# rejoined: the screen breaks it across lines, and a URL has no spaces, so the
# lines after the start that are only URL characters belong to it.
awk '
  function flush() { if (cur != "") last = cur; cur = ""; on = 0 }
  {
    line = $0; gsub(/^[ \t│|]+|[ \t│|]+$/, "", line)
    if (match(line, /https:\/\/[^ \t]*oauth\/authorize\?[^ \t]*/)) {
      flush(); cur = substr(line, RSTART, RLENGTH); on = 1; next
    }
    if (on && line != "" && line ~ /^[A-Za-z0-9%&=?._~:\/+#-]+$/) { cur = cur line; next }
    if (on) flush()
  }
  END { flush(); if (last != "") print last }
'
