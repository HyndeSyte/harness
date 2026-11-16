#!/bin/bash
# Where Cain's session stands, read from a capture of its screen on stdin. checkin.sh (before it
# types anything) and the run script's /status page read it here, the same way. Prints one word:
#   ready   his prompt is up: its footer ("? for shortcuts", or "auto mode on") is in the bottom 12
#           non-blank lines, with no dialog's key hints below it. Rows Claude Code draws under the
#           footer, such as its panel of background tasks, don't change that.
#   dialog  a screen waiting for an answer: a dialog's key hints ("Esc to cancel", "Enter to
#           continue", "Enter to confirm", "Enter to select") in those lines, below any footer.
#           Typing there answers the screen, not him: Nov 16, Claude Code's offer to set up auto
#           mode said "auto mode" and took the App's typing for three hours.
#   other   anything else: starting, signing in, an empty capture.
# Words of his higher up, a footer's words or a hint's, count for nothing either way. It never
# fails: awk reads an empty screen as "other".
awk '
  NF { n++; line[n] = tolower($0) }
  END {
    foot = 0; hint = 0
    for (i = (n > 12 ? n - 11 : 1); i <= n; i++) {
      if (line[i] ~ /for shortcuts|auto mode on/) foot = i
      if (line[i] ~ /esc to cancel|enter to (continue|confirm|select)/) hint = i
    }
    if (foot && hint < foot) print "ready"
    else if (hint) print "dialog"
    else print "other"
  }'
