#!/bin/bash
# Where Cain's session stands, read from a capture of its screen on stdin. checkin.sh (before it
# types anything) and the run script's /status page read it here, the same way. Prints one word:
#   ready   his input area is on screen, found by its shape, not by words anywhere, and empty: in
#           the bottom 12 non-blank lines, a footer line that starts with Claude Code's own footer
#           ("? for shortcuts", or "auto mode on" after its two-arrow mark), with right above it
#           only the input box's borders and then its prompt line (">" or the arrow prompt, inside
#           a box or not) holding nothing but that mark, and no dialog's key hints below the footer.
#           Rows Claude Code draws under the footer, such as its panel of background tasks, don't
#           change that, nor up to three rows it draws between the box's bottom border and the
#           footer (a warning: seen on a real Claude Code 2.1.317, Nov 16). Any text in the prompt reads as a draft not sent, which typing would add
#           to and send (round 11), so it's a draft. A plain capture can't tell gray text from
#           typed text, so there's no exception for look-alikes (round 12): Claude Code's gray
#           suggestions in an empty box, its start-up example among them, are off (session.sh).
#   draft   his input area as for ready, holding text: on its prompt line, or, for text longer than
#           a line, from its prompt line (under the box's top border) down to its bottom border.
#           checkin.sh presses Enter on what it typed only while the screen reads so (Cain's third
#           service review: a question can open between the read and the Enter). With
#           PROMPT_DRAFT_LINE set, the text on its prompt line (the first of it) follows on a
#           second line, lower case, so checkin.sh takes out only a draft that is its own. With
#           PROMPT_DRAFT_TEXT set, the whole draft follows instead, one drawn line a line, from its
#           prompt line down to its last, as drawn (case and every space within kept), with only
#           what the box draws taken off: the prompt mark and the space after it, each line's
#           leading and trailing blanks (the wrap's indent), and the box's edges when it's boxed.
#           checkin.sh presses Enter only when those lines, joined by single spaces, are exactly
#           what it typed (outside review, rounds 17 and 18).
#           With PROMPT_ABOVE set (ready or draft), every line above his input box follows instead,
#           as drawn, its top border left out: where Claude Code shows a line once it's sent, so
#           checkin.sh can see its try went in (Cain's fourth service review, must-fix 1).
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
  # 2: his prompt line, empty; 1: his prompt line with anything in it; 0: not one. Only the box
  # itself is taken off: a left edge before the mark, and then its right edge at the end; a "│"
  # typed in the box stays, as any other draft (round 13).
  function prompt(s,   boxed) {
    sub(/^([[:space:]]|\302\240)*/, "", s)
    boxed = (s ~ /^│/)
    if (boxed) sub(/^│([[:space:]]|\302\240)*/, "", s)
    if (s !~ /^(>|❯)/) return 0
    sub(/^(>|❯)/, "", s); sub(/([[:space:]]|\302\240)*$/, "", s)
    if (boxed) { if (s !~ /│$/) return 1; sub(/│$/, "", s); sub(/([[:space:]]|\302\240)*$/, "", s) }
    sub(/^([[:space:]]|\302\240)*/, "", s)
    return s == "" ? 2 : 1
  }
  # The text on a prompt line, its box and mark taken off.
  function words(s) {
    sub(/^([[:space:]]|\302\240)*/, "", s); sub(/^│([[:space:]]|\302\240)*/, "", s); sub(/^(>|❯)/, "", s)
    sub(/([[:space:]]|\302\240)*$/, "", s); sub(/([[:space:]]|\302\240)*│$/, "", s)
    gsub(/\302\240/, " ", s); sub(/^ */, "", s)
    return s
  }
  # A line of the draft as drawn, with only what the box draws taken off: blanks at its ends, the
  # edges of the box when boxed, and on its first line the prompt mark. Spaces within stay.
  function drawn(s, first, boxed) {
    sub(/^([[:space:]]|\302\240)*/, "", s)
    if (boxed) sub(/^│([[:space:]]|\302\240)*/, "", s)
    if (first) { sub(/^(>|❯)/, "", s); sub(/^([[:space:]]|\302\240)*/, "", s) }
    sub(/([[:space:]]|\302\240)*$/, "", s)
    if (boxed) { sub(/│$/, "", s); sub(/([[:space:]]|\302\240)*$/, "", s) }
    return s
  }
  function footer(s) { return s ~ /^([[:space:]]|\302\240)*([?] for shortcuts|(⏵)+([[:space:]]|\302\240)*auto mode on)/ }
  NF { n++; line[n] = tolower($0); orig[n] = $0 }
  END {
    top = (n > 12 ? n - 11 : 1); foot = 0; hint = 0; empty = 0
    for (i = top; i <= n; i++) {
      if (line[i] ~ /esc to (cancel|exit|close|go back)|enter to (continue|confirm|select|apply|submit)/) hint = i
      if (!footer(line[i])) continue
      # Rows Claude Code may draw between its input box and the footer (a warning): up to three,
      # passed over only when the bottom border of the box is right above them.
      j = i - 1
      for (m = 0; m < 3 && j >= 1 && !border(line[j]) && !prompt(line[j]); m++) j--
      if (m > 0 && !(j >= 1 && border(line[j]))) j = i - 1
      for (b = 0; j >= 1 && border(line[j]); j--) b++
      if (j < 1 || b > 2) continue
      if ((p = prompt(line[j]))) { foot = i; empty = (p == 2); at = j; last = j; continue }
      # Text longer than a line: right above the bottom border its last line, and higher up, with
      # only more of it between, its prompt line holding text, under the top border.
      if (b == 0) continue
      p = 0
      for (k = j - 1; k > 1 && k >= j - 40 && !border(line[k]) && !footer(line[k]); k--)
        if ((p = prompt(line[k]))) break
      if (p == 1 && k > 1 && border(line[k - 1])) { foot = i; empty = 0; at = k; last = j }
    }
    if (foot && hint < foot) {
      print (empty ? "ready" : "draft")
      if (ENVIRON["PROMPT_ABOVE"] != "") {
        t = at - 1
        if (t >= 1 && border(line[t])) t--
        for (x = 1; x <= t; x++) print orig[x]
      }
      else {
        if (!empty && ENVIRON["PROMPT_DRAFT_LINE"] != "") print words(line[at])
        if (!empty && ENVIRON["PROMPT_DRAFT_TEXT"] != "") {
          s = orig[at]; sub(/^([[:space:]]|\302\240)*/, "", s); boxed = (s ~ /^│/)
          for (x = at; x <= last; x++) print drawn(orig[x], x == at, boxed)
        }
      }
    }
    else if (hint) print "dialog"
    else print "other"
  }'
