# Changelog

## 0.6.0

- Family stays true to your Gmail calendar, with no tap. Your first name in the add-on's settings
  turns it on; adds must be on, and your Gmail calendar's secret iCal address entered.
  Plain code does it after each read. No model sees any of it, and /stop stops it.
- Appointments go on as "Name - PT", "Name - Doctor", "Name - Dentist" and the like: fixed words
  and times, never text from Gmail. Calls, meetings, "Busy" and someone else's invite stay off.
- A hotel stay becomes one block for the whole trip, with the city, flight times and numbers when
  the flights match a strict pattern, and "Name - away" when they don't.
- A copy follows its event. If it moves, the copy moves. If it's cancelled, the copy comes off
  after two good reads in a row. Many gone at once is held back as a bad read.
- Events you copied by hand are taken over rather than doubled, if they carry your first name.
  They stay as they are until the event changes on Gmail. An event with other people on it, a
  repeating one, or anyone else's stays as it is.
- A copy someone edits on Family is left alone for good. A copy gone from two good reads in a row
  isn't put back, and after two of a kind it stops copying that kind.
- At most 12 changes a day. If Gmail or Family can't be read, or too much looks gone at once,
  nothing changes. With more than one Gmail calendar entered, it does nothing. The morning digest
  says what changed, in counts, and any problem.
- None of this counts toward adds skipping the tap, and adds you ask for work as before.

## 0.5.1

- A standing rule now needs your tap. A correction, or anything pasted that looks like one,
  stays unused until you tap *Keep rule* on a card showing its exact text, and only a kept
  rule reaches a prompt. An unanswered card drops the rule after 7 days.
- Rules saved by earlier versions were never tapped, so they stop being used until you decide.
  Each gets a card, again each week. Adds can't start skipping the tap while any rule waits,
  and if they already skip it, the tap comes back and the thread says why.
- The cards are honest about alerts: a real test showed adds alert family phones with
  notifications on for the Family calendar. The card asking to stop checking says so, and
  says an alert can arrive with nothing approved first. It asks only whether adds were wrong.
- A tap on that card during `/stop` changes nothing, reads nothing, and the card still works
  after `/resume`.
- `/checkadds` with that card open closes it like *keep checking*, and says so.
- While adds skip the tap, a long or several-line message gets a card, and so does any message
  in the 30 minutes after one, or sent as a reply.
- More address shapes are stopped: any URL scheme, `[evil.com/x]`, `.evil.com`, and wide or
  look-alike dots. A word:word or a phone number gets a card.
- A saved rule a card can't show exactly is retired with a notice. Every other saved rule,
  including one waiting on a clash, gets a card. A clash nobody answers is dropped after 7 days.

## 0.5.0

- The app can now write to one calendar. It can add one event to iCloud Family
  from a message, and undo that add. This is the first change to the world the app
  can make at this stage. It is off until you turn it on with a tap. The stage stays
  S1, and calendar holds and the work mirror stay locked.
- Say "add dentist Tuesday 3pm". A card shows the exact event in your local time.
  One tap creates one event, with no invitees, alarm or repeat. The reply carries
  iCloud's answer and an Undo button.
- Undo deletes only that event, once, and refuses if someone changed it.
- If iCloud's answer is lost the app says it doesn't know, tells you to check the
  calendar, and never retries. A failed write, rejected password or wrong calendar
  name stays in `/status` and the digest until a write succeeds. `/stop` blocks adds
  and undos.
- Apple ID, app-specific password and calendar address go on the add-on page. The
  app talks to one more host: the iCloud host in that address.
- Plain code checks every proposal. An event over 24 hours or over a year ahead, or a
  title or location with a link in it, is refused in words. A time written with an
  offset your zone doesn't have at that moment, or a suspected duplicate, puts a warning
  on the card.
- After 10 adds and 14 days, whichever is later, with no undo and no failed or unknown
  write, the app asks you, with the whole record, whether to stop checking each add. The
  card lasts 3 days and asks again at most once a week. Your tap re-reads the record first,
  and nothing changes if it moved. Only your tap changes that. Any warning, more than 5 such
  adds in a day, another add at the same start, or a long or several-line message still gets
  a card.
- `/checkadds` brings the Approve tap back at once. So does an undo, a failed or unknown
  write, an add with no Undo, or a change to the credentials, the policy or the model. The app says why, and
  only a fresh full count can ask again. `/status` and the digest say when adds skip the tap.

## 0.4.0

- Work-hours mirror, shadow only. When mirror settings are entered on the add-on
  page, plain code works out which personal blocks would be copied to the work
  calendar, records that in its own table, and adds one line to the morning
  digest. It writes nothing to any calendar. With no mirror settings, nothing
  changes: no table rows, no digest line.
- The planner behind it (work days, hours, look-ahead, quiet hours, which
  calendars count, titles to skip, Family rules, "Busy" titles) ships with it.
  The calendar write it would feed is registered for S2 only and nothing calls
  it in this release.

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
