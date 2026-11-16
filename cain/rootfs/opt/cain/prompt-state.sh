#!/bin/bash
# Where Cain's session stands, read from a capture of its screen on stdin. checkin.sh (before it
# types anything) and the run script's /status page read it here, the same way. Prints one word:
#   ready   his input area is on screen, found by its shape, not by words anywhere, and empty: in
#           the bottom 12 non-blank lines, a footer line that starts with Claude Code's own footer
#           ("? for shortcuts", or "auto mode on" after its two-arrow mark), with right above it
#           only the input box's borders and then its prompt line (">" or the arrow prompt, inside
#           a box or not) holding nothing but that mark, and no dialog's key hints below the footer.
#           Rows Claude Code draws under the footer, such as its panel of background tasks, don't
#           change that. Any text in the prompt reads as a draft not sent, which typing would add
#           to and send (round 11), so it's "other". A plain capture can't tell gray text from
#           typed text, so there's no exception for look-alikes (round 12): Claude Code's gray
#           suggestions in an empty box, its start-up example among them, are off (session.sh).
#   dialog  no input area, and a screen showing key hints ("Esc to cancel", "Enter to continue",
#           "Enter to confirm" and the like) in those lines: a screen waiting for an answer, which
#           typing would answer. Nov 16, Claude Code's offer to set up auto mode said "auto mode"
#           and the App's old test took it for his prompt, so its typing went into the offer for
#           three hours.
#   other   anything else, an unknown layout included: starting, signing in, an empty capture.
# Words that only look like a footer (his own words quoting one, a menu option) count for nothing:
# only the input area's shape makes it ready (outside review, round 10). It never fails: awk reads
# an empty screen as "other".
# Claude Code puts a no-break space (\302\240 below, U+00A0) after its prompt mark: it counts as a
# space here, or his empty prompt would read as a draft (seen on Claude Code 2.1.317, Nov 16).
awk '
  function border(s) { gsub(/─|━|╭|╮|╰|╯|│|\302\240|[[:space:]]/, "", s); return s == "" }
  # 2: his prompt line, empty; 1: his prompt line with anything in it; 0: not one.
  function prompt(s) {
    sub(/^([[:space:]]|\302\240|│)*/, "", s)
    if (s !~ /^(>|❯)/) return 0
    sub(/^(>|❯)/, "", s); gsub(/[[:space:]]|\302\240|│/, "", s)
    return s == "" ? 2 : 1
  }
  function footer(s) { return s ~ /^([[:space:]]|\302\240)*([?] for shortcuts|(⏵)+([[:space:]]|\302\240)*auto mode on)/ }
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
