#!/bin/bash
# Where Cain's session stands, read from a capture of its screen on stdin. checkin.sh (before it
# types anything) and the run script's /status page read it here, the same way. Prints one word:
#   ready   his input area is on screen, found by its shape, not by words anywhere, and empty: in
#           the bottom 12 non-blank lines, a footer line that starts with Claude Code's own footer
#           ("? for shortcuts", or "auto mode on" after its two-arrow mark), with right above it
#           only the input box's borders and then its prompt line (">" or the arrow prompt, inside
#           a box or not) holding nothing but that mark, and no dialog's key hints below the footer.
#           Rows Claude Code draws under the footer, such as its panel of background tasks, don't
#           change that. Text in the prompt is a draft not sent: typing would add to it and send it
#           (round 11), so it's "other". The one exception is Claude Code's gray start-up example
#           ('Try "..."'), which typing replaces; its later gray suggestions are off (session.sh).
#   dialog  no input area, and a screen showing key hints ("Esc to cancel", "Enter to continue",
#           "Enter to confirm" and the like) in those lines: a screen waiting for an answer, which
#           typing would answer. Nov 16, Claude Code's offer to set up auto mode said "auto mode"
#           and the App's old test took it for his prompt, so its typing went into the offer for
#           three hours.
#   other   anything else, an unknown layout included: starting, signing in, an empty capture.
# Words that only look like a footer (his own words quoting one, a menu option) count for nothing:
# only the input area's shape makes it ready (outside review, round 10). It never fails: awk reads
# an empty screen as "other".
awk '
  function border(s) { gsub(/─|━|╭|╮|╰|╯|│|[[:space:]]/, "", s); return s == "" }
  # 2: his prompt line, empty (or the start-up example); 1: his prompt line with a draft; 0: not one.
  function prompt(s) {
    sub(/^([[:space:]]|│)*/, "", s)
    if (s !~ /^(>|❯)/) return 0
    sub(/^(>|❯)/, "", s); sub(/([[:space:]]|│)*$/, "", s); sub(/^[[:space:]]*/, "", s)
    return (s == "" || s ~ /^try "/) ? 2 : 1
  }
  function footer(s) { return s ~ /^[[:space:]]*([?] for shortcuts|(⏵)+[[:space:]]*auto mode on)/ }
  NF { n++; line[n] = tolower($0) }
  END {
    top = (n > 12 ? n - 11 : 1); foot = 0; hint = 0; empty = 0
    for (i = top; i <= n; i++) {
      if (line[i] ~ /esc to (cancel|exit|close|go back)|enter to (continue|confirm|select|apply|submit)/) hint = i
      if (!footer(line[i])) continue
      for (j = i - 1; j >= 1 && border(line[j]); j--) { }
      if (j >= 1 && j >= i - 3 && (p = prompt(line[j]))) { foot = i; empty = (p == 2) }
    }
    if (foot && hint < foot) print (empty ? "ready" : "other")
    else if (hint) print "dialog"
    else print "other"
  }'
