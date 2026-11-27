#!/bin/bash
# Whether Cain's screen holds what the App types (Cain 0.20.0, item 4), read from a capture of his pane
# on stdin. Prints why and exits 0 when it does; exits 1 when it doesn't. prompt-state.sh still has the
# last word on "ready" (his idle prompt, found by its shape); this only takes screens away from it:
#   limit       Claude Code's usage or spend limit reply, the newest thing on his screen: no reply of his
#               (a line starting with his reply mark) after it. probe/core.ts LIMIT is the same words.
#               It stands until a turn of his gets past it (the hourly probe is one, through the chat
#               plugin, outside the App's typing), so nothing typed meanwhile is lost: it waits in the queue.
#   compacting  a compaction at work.
# It never fails: an empty screen holds nothing (prompt-state.sh calls it not ready on its own).
awk '
  NF { n++; line[n] = $0 }
  END {
    top = (n > 40 ? n - 39 : 1); lim = 0
    for (i = top; i <= n; i++) {
      l = tolower(line[i])
      if (i > n - 12 && l ~ /compacting conversation/) { print "compacting"; exit 0 }
      if (l ~ /you.?ve (hit|reached) your [a-z ]{0,30}limit|\/usage-credits|(^|[^a-z])(monthly )?spend limit([^a-z]|$)|usage limit (reached|hit)|limit reached.{0,40}resets/) lim = i
      else if (lim && line[i] ~ /^[[:space:]]*(⏺|●)/) lim = 0
    }
    if (lim) { print "limit"; exit 0 }
    exit 1
  }'
