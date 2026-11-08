# Changelog

## 0.15.1

- The log notes each handover from Cain: what happened and how long it took, so the 20-second target can be measured. Never your words.

## 0.15.0

- The calendar keeper moves to Discord. With a Discord bot token set, it talks only in your DM with Cain, under Cain's name, and Telegram goes quiet.
- You ask Cain in plain words. Cain hands the request over without passing your words; the keeper reads your newest message (from the last 2 minutes) itself, makes the change, and posts the receipt with Undo. Questions go back to Cain to answer.
- A card to tap comes up when the words may not be yours: an edited or forwarded message, an attachment, a reply to something that isn't yours, or anything resting on Cain's suggestion.
- A Stop button sits on every set of buttons and on the morning digest; Turn back on replaces it while stopped. Both work even if Cain is down.
- At the move, changes still undoable are posted again with Undo, and open Telegram questions are closed with a note.

## 0.14.1

- Fix: the Discord connection stopped right after connecting, because it reached the main record from its own thread. The keeper now keeps its own small record, and the connection keeps going if anything else goes wrong.

## 0.14.0

- First step to Discord: the keeper connects to Discord with Cain's bot (a "Discord bot token" field on this page) and hears presses on its own buttons only. It posts one test card to your DM; a tap on it proves the link. Every press is checked: you, in your DM, on the card exactly as posted (a card changed after posting is refused), once, before it expires. Telegram is unchanged until the move is done.

## 0.13.4

- A date from mail counts as already on your calendar when a word matches in another form:
  a "Skate Center" trip is the "Skating" outing you already have.

## 0.13.3

- Left out of dates from mail: offers and memberships to claim (even marked "action
  required"), the standard "report damage within N days" in a delivery email, and a lender
  asking for proof of insurance. The last 30 days are read again.

## 0.13.2

- What's already on your calendar is checked on Family as well as Gmail, and a date with a time
  counts as there when anything starts at that time, whatever it's called: a booking for a
  session you have as "Therapy", or a school event copied to Gmail as "Busy (family)".
- Bills, statements and loan or card payments are left out (they're on autopay), unless the
  email says a payment failed, is past due or must be made by hand. Renewals that happen on
  their own are left out; a yearly subscription you could cancel stays. The routine "fill out
  your forms" in a booking is left out.
- The last 30 days are read again under these rules.

## 0.13.1

- A date that moves follows the email: when a new email says an appointment or deadline was
  rescheduled, the entry from mail moves to the new day instead of a second one being added.
- An entry you moved yourself (in your calendar, or by telling the harness) isn't added again
  when the new confirmation arrives. A second, separate appointment with the same place is
  still its own entry.

## 0.13.0

- "Again" reads your calendar instead of asking. When you name something that's on your Gmail
  calendar, the events with those words are given with your message, so "coffee with Sam
  again next week" takes the day, time and place from the last one.
- Your own plans go on your Gmail calendar without a question; the kids and the household go on
  Family.
- A series can repeat every two, three or four weeks, and can go on with no end date when you
  say "going forward".

## 0.12.4

- A day something doesn't happen (no class, a break, closed) isn't carried from mail.
- A date already on your Gmail calendar that day, entered by you or copied from Family, isn't
  added again from mail.

## 0.12.3

- Fixes from checking the first month against the inbox. One thing in several emails (two notes
  about one service appointment, three about one insurance renewal) is one entry. Payments that
  happen on their own, monthly subscription renewals and expiring promo credits are left out.
  School and group updates and loan servicing mail are now read, so registration deadlines and
  loan dates aren't missed.
- When these rules change, what was found but not written is let go and the last 30 days are
  read again under the new rules. Nothing already on the calendar is touched.

## 0.12.2

- Each date found in mail is named in the add-on log, with the subject it came from, and what's
  found but not yet written is listed again at each start. The log stays on the Pi.

## 0.12.1

- Mail is checked every 5 minutes, not every 30, so a date from new mail lands within minutes.
- A backlog reads straight through: when a read stops at its cap with mail left, the next one
  starts at once. The spend per email and the daily caps are unchanged.

## 0.12.0

- Dates from your mail: with a Gmail app password on the add-on page, the harness reads your
  inbox read-only (nothing marked read, moved or deleted) and finds the dates you have to act
  on: return windows, deadlines, renewals, appointments. Each one goes on your Gmail calendar
  as a free all-day entry with no reminder, so it shows in Outlook and never reaches work. One
  message per batch, with one Undo.
- Only mail that looks like an order, bill, renewal, appointment or deadline is read past its
  subject. What the engine pulls out is checked and cleaned here; no link reaches a calendar.
- Until the mail_dates option is on, dates are found and named in the digest, not written.
- Google's email about a failed run of the work holds script becomes a digest line.
- The log says whether each read of your Gmail calendar came straight from Google.

## 0.11.0

- Your Gmail calendar is read straight from Google for the days ahead, not from the secret
  address's copy, which Google can serve an hour late. Copies to Family and blocks on Gmail
  follow what's really there. If Google can't be reached, the old copy is used.
- The digest says what wasn't done in plain words: what you asked, when, and why, in place of
  a job number.
- A rule's receipt says how many events on Family it covers in the next two months.
- A reply to the digest is taken as your own words, with no Approve tap: the digest's text
  never reaches the engine.
- The work-hours shadow mirror is retired. The work holds script does that job.

## 0.10.1

- After a change, a rule or an Undo, Family is read again at once, so Gmail and work follow
  in a minute or two instead of up to half an hour.
- A block that's no longer needed because of something you said, with its event still on
  Family, comes off on that read.
- An event taken off Family gets its second look two minutes later, not at the next usual read.
  Many gone at once still wait for the usual reads: that's the guard against a bad read.
- The digest's question about new Family events says to ignore the ones that don't affect you,
  so the list of rules stays short. One rule can cover a person: "Anything with Pat means I
  have the kids".

## 0.10.0

- Say what a Family event means for you, by its name: "Pat dentist means I have the kids",
  "Lee - Doctor is mine", "School Day is a school day", or that one means nothing. Gmail, and
  work from there, follow it from the next read. One receipt and one Undo, like any change.
- A rule goes by words, so emoji and names in front don't matter. The most words win.
- Your own Family events get "Busy (family)" on Gmail, unless Gmail already has you busy then.
- The digest names Family events coming up in the next two weeks with no rule yet, five at
  most, until you say what they mean.
- The add-on's title settings still work. A rule you say comes first.

## 0.9.1

- Undo checks every calendar before it writes anything, so it no longer undoes one calendar and
  stops on the other.
- Undoing a change after a later change to the same event offers one button that undoes both,
  newest first, instead of calling the later change someone else's.
- A day of a Gmail series isn't put back once its series is gone, and an event already back
  doesn't block the rest of an undo.

## 0.9.0

- Say what should change on the Family or Gmail calendar and it's done, with no tap: take days
  off, end a series, move one day or event, add an event or a series. One receipt and one Undo.
  Off until the new `calendar_changes` option is on.
- It finds the event on a fresh read, keeps every other line of it, guards against someone's edit
  in between, and reads each write back. Nothing that may be pasted goes without a tap.
- A day taken off that comes back, from any app, gets a line in the digest.

## 0.8.2

- A school run now comes off only for what really stops it. An event during the trip to school does. An event after drop-off doesn't, so going on to an appointment keeps the run.
- With the school's address in `family_school_address`, an event within three hours of a run counts if you can't drive between it and the school in time. Drive times come from OpenStreetMap's free services, which get the street address and nothing else from the event.
- An event with no street address is taken as nearby, and the digest says so. If a drive time can't be looked up, the run stays and the digest says so.

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
