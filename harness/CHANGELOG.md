# Changelog

## 0.3.0

- The iCloud Family calendar in the morning digest. Home Assistant pushes a
  minimized copy (title, start, end) every 30 minutes to a listener on the add-on's
  internal network; the harness stores it and lists it as Family context. It never
  counts a Family event as an overlap or acts on it.
- The digest is never Clear while the Family calendar is missing: nothing received
  yet, not updated for two hours, not about today, or Home Assistant can't read it,
  each said plainly. A refused push is named; wrong-key pushes are counted in the
  next digest even when good pushes keep arriving.
- The listener takes a key only in a 30-minute window (at first start, or from a
  button on the add-on page), checks the sender's address before starting a
  thread, and handles at most two connections at once.
- Several calendars are listed in time order.
- A calendar named by its address shows the name with spaces, not "first[.]last".

## 0.2.0

- Today's calendar in the morning digest, read-only, from your calendars' secret
  iCal addresses (entered on the add-on page like the keys). Overlaps are marked;
  a calendar that couldn't be read, or an event it couldn't place, is named.
- The add-on page shows each calendar's last read and the last digest, including
  the ones recorded but not sent before the start date.
- Links from instrument cards open the chat with the card's title.

## 0.1.0

- First release for stage S1: a private Telegram thread, answers and drafts,
  typed rules with undo, a daily digest and canary, receipts for every job.
  Zero effects: it cannot change anything outside itself.
