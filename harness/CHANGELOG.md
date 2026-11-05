# Changelog

## 0.8.1

- School runs are 45 minutes: 15 each way and 15 to spare. Drop-off starts 30 minutes before the start and ends 15 after. Pickup starts 15 minutes before the end and ends 30 after. Blocks already on Gmail move to match.

## 0.8.0

- School runs on your Gmail calendar. Name the Family events that mean a school day in `family_school`, and each gets a drop-off and a pickup block, 15 minutes either side of the start and of the end, with no tap. They follow Family: a closed day has no blocks and a moved start moves them.
- A real event of yours in the way means no block for that run, and it comes back if the event goes. A "Busy" hold, a block from here, or an all-day event other than a stay doesn't count. If your Gmail calendar can't be read, school runs don't change and the digest says so.
- Up to 100 changes a day to Gmail, up from 30, so the first school runs go on in one go.

## 0.7.4

- The reason moved hand copies stayed put: the repeat lines in an event's time zone block, there for its clock changes, counted as the event repeating. Now only the event's own lines count. A real repeat or a guest still means it's left alone.
- Copies given up on, still exactly as they were, get one more try after this update.

## 0.7.3

- 0.7.2 didn't get moved hand copies going: iCloud's copy still failed a safety check. Comparing an event with what was just read now ignores line order and the server's own X- lines.
- When a hand copy is refused, the log gives the reason in property names only, never what they say.
- Copies given up on, still exactly as they were, get one more try after this update.
- The digest names a copy once a day, even if it's given up on twice.

## 0.7.2

- Copies now follow a move on Gmail when iCloud reports an event's version differently in a list than it does when asked directly. They could stop following with no word.
- The digest names any copy it stops following, by word and date, and says why, so a stale copy doesn't go unnoticed. It also says when the daily limit holds changes back, part of Family can't be read, or a read goes wrong.
- A note or place added to a copy on Family now means it's left alone, rather than rebuilt without them.
- A hand copy already off from Gmail when taken over now moves to match, only if it has the copy's exact title and length and no note. Anything else is left alone and named.
- Copies it gave up on by mistake, still exactly as they were, are followed again once after this update.

## 0.7.1

- Several appointments cancelled together now come off Family, after about three hours. They could
  stay there for good, held as a bad read. Your own events stay while your Gmail calendar reads oddly.
- `/status` says when copying has stopped for a kind of event.
- Corrected: blocks on your Gmail calendar do carry your default reminders. Google applies them,
  and a service account can't turn them off. The sharing option's name is corrected too.

## 0.7.0

- The Family events you name in the add-on's settings put a block on your Gmail calendar, with no
  tap. It moves when they move and goes when they go. Your title and the times only, marked private,
  with no guests, reminders or emails.
- It needs a Google service account key, entered like any other, and your Gmail calendar shared with
  that account. A test event goes on Gmail and comes off before the first block.
- It changes only blocks it wrote. One you edit is left alone, and one you remove isn't put back.

## 0.6.1

- A computer lab class on your Gmail calendar now goes on Family as "Name - Computer Lab".

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
