# Changelog

## 0.23.0

- **Nothing asks you to check the calendar or send something again.** When a change's answer is lost, or it can't be read back, Harness reads the calendar itself a minute later. If it went through, you get the usual receipt with Undo, and Undo puts all of it back, even after a restart cut the write short. If it didn't, it's written once more, only over the very version it was first written over, and if it still didn't go through you're told so plainly. If the event was changed on the calendar in the meantime, even back to how it was, it's left as it is and you're told so. If half of it went through, the rest is finished, or that half is put back.
- **When a read can't tell, you hear once.** Reads come each minute for the first hour, every 15 minutes for the rest of the day, then hourly. After an hour, one line says it isn't confirmed yet and is still being checked, and the receipt follows once it's known. Once the event is over or a week has passed, one line says it couldn't be confirmed, and the reads stop. The morning digest says "not confirmed yet, still checking".
- **A Family add iCloud answered but a read doesn't find** is written once more at the same address, so never as a second event, and if it's still not there you're told so plainly. Another event found at its address isn't called added. An add iCloud answered that reads never confirm keeps its Undo on the line that says so.
- **An undo cut short by a restart finishes by itself,** Family adds included, or says it's already undone. An undo the calendar turns down says so, with Undo, and is never sent again on its own. One whose answer was lost is read before anything is said, even when iCloud can't be reached or turns its second try down: gone is undone, and still there is said with Undo. Each Undo tap is tried afresh.
- **Undo leaves alone what you changed since,** a Gmail add you moved included, and a change you made before Harness read its write back, a note or an alert you added included.
- **What you send while stopped, and an Undo you tap while stopped, comes back after Turn back on,** one card each, with Do it now and Drop it. Drop it is final. Do it now on an Undo holds even if Harness restarts right then. While stopped, nothing is written or said about a Family add; its reads wait for Turn back on.
- **A failure that isn't yours is retried once by itself,** whether or not Cain is in front. A change Harness was writing when it updated isn't written again, so it can't be made twice.
- **A block Google said it wrote but never had is written once more,** not taken as you removing it. A block that was on your calendar and is later gone is yours removed, and stays off. Blocks from before this version count as having been on your calendar.
- **A Family add whose Approve tap came back before it went in comes back as its own card.**

## 0.22.0

- **A receipt comes only once your calendar shows the change.** "Added to your Gmail", "From your mail, on your calendar" and "Added to the Family calendar" now go out after a read of the calendar finds it as it was written, not when Google or iCloud only says the write worked. If three reads don't find it, or for an add or a date from your mail half an hour passes without one that does, one card says it was written but not confirmed, with its Undo, and the next morning digest names it.
- **Tap replies say what will happen:** "Thanks. I'll put Swim on your calendar as yours."
- **Receipts read as notices:** "Added to your Gmail: Busy (family), Fri Nov 20, 1:00 PM to 3:00 PM, for Swim on Family. Nothing to do if that's right; tap a button only if it's wrong."
- **No message names a button it doesn't have.** Turning on Family adds brings your event's card back by itself, and a stop or a restart no longer asks you to send something again.
- **Changes that wait past the day's limit are each named,** by block and day, never counted.
- **Stop is red** on every card and on the digest.
- **If Cain is down, the first message just says so.** If he's still down after 30 minutes, one more line says how to restart him: Settings > Apps > Cain > Restart.
- **No codes:** a refused Family add says iCloud turned it down, and its receipt has no job number.

## 0.21.3

- **The Resumed notice no longer asks you to send things again.** It says plainly that what you sent while stopped wasn't acted on.

## 0.21.2

- **The Harness no longer marks the same Family events to be judged again every few seconds.** One already waiting to be judged again is marked once, so its log stays readable and the Pi stops writing its database over and over.
- **If judging Family events stops on an unexpected problem, it tries again at the next calendar read,** not every few seconds with a warning each time.

## 0.21.1

- **You hear right away when only you can fix something.** If Gmail turns down Harness's app password or wants you to sign in on the web, iCloud turns down its app-specific password, Google turns down its service account key, or your Gmail calendar isn't shared with Harness any more, you get one message as soon as a second try confirms it. It says what stopped, since when, what it costs you, and how to fix it from your phone, down to tapping Approve on the Discord message that follows. You get it once per outage. If a new key is turned down too, you hear again.
- **If something else stops, you hear once it has kept failing for six hours.** That's Gmail, iCloud or Google not answering, Claude turning Harness's requests down, or the Pi's clock being off. Messages go out on the quarter hour, with everything that's down then in one, so a home internet outage is one message. A message that hasn't gone out yet only says what's still down, and is dropped if everything in it works again.
- **The morning digest names everything that's down,** your email included, once it has failed twice or for an hour: "Email from Gmail: not working since Sun Nov 8 at 4:53 PM; Gmail refused the app password". When one you knew about works again, the next digest says so in one line. There's no separate "it's back" message.
- **Plain words:** no error codes, and "Claude" where messages used to say "the engine".
- **The Harness log notes a failed email read,** once an hour at most unless the reason changes, and never with what Gmail said.

## 0.21.0

- **Your plain calendar commands just work.** Say "move PT to 11:30" or "no drop-off today" and it's done straight away, with one receipt and an Undo button: "Moved PT to 11:30 to 12:30 today (Gmail and Family)", "Took off today's 8:00 drop-off". No Approve tap.
- **Your words find the event.** "PT" finds "PT - Clinic" and "physical therapy" finds "PT", on Gmail or Family. The Family copy of a Gmail event moves or comes off with it, in the same change, and Undo puts both back. The school drop-off and pickup are found on your Gmail calendar, however you name them.
- **Asked once, by name, only when it's unclear.** When two events fit what you said, or none does, you're asked which, naming them, and nothing changes until you answer. A note from Cain now reaches a question that's waiting for it.
- **Plain words, nothing else.** Cards and receipts read like "11:30 to 12:30 today": no date stamps, no job numbers, no expiry line. Your tap's reply says what will happen, and "Done" comes only once the calendar reads back the change.
- **A long or dictated message is just you.** Only real signs of a paste get a tap now: a quoted line, an email's header lines, a forward, a link, a phone number, or words written to you ("your appointment", "please arrive").
- **A tap for the big ones.** A change still waits for your tap when it would give an event a new length you didn't say, take off three or more events at once, or end a series.
- **Every part, or exactly what failed.** If one part can't be done, the rest still is, and the receipt says which part wasn't and why. It never says "Nothing changed" when something did.
- **Only what you named.** When one word fits two different events ("PT" at 4:00 and "PT - Clinic"), when your words are only part of a name and something nearby fits them better, or when what you named is only on the other calendar, you're asked instead of it being changed. A receipt names the event by its own title.
- **Buttons come off when they lapse.** Each card tells Cain when its buttons stop working, so once Cain 0.7.0 is in, an expired Approve or Undo is taken off instead of sitting there for days.
- **Appointments from your mail are real appointments.** One the email gives a time for is now busy, so work and Family see it, at the street address that email gave, or another email about it (same sender, day and time). Timed appointments already on your calendar are made busy too, and only their own emails are looked up again for the address. The next digest names each one made busy. A rescheduling email moves it, with the new email's address. Deadlines, last days, classes and other notices stay free. One you've changed stays yours.

## 0.20.0

- **If Cain's add-on stops, you hear about it.** This add-on checks Cain's every minute. If Cain hasn't answered for 5 minutes, you get one Discord message saying so, sent straight from here since Cain is the one that's down. It tells you Stop and the buttons won't work until Cain is back. When Cain answers again you get one more message, also straight from here.
- **No noise on restarts or updates.** Anything shorter than 5 minutes says nothing, and a message is never repeated. If Discord can't take it, it's tried again a minute later. A restart of this add-on during an outage doesn't tell you twice.
- **Discord on the Harness page.** A new Discord section shows whether the Discord link (held by Cain's add-on) is connected, when it last heard from Discord, and whether Cain is answering, with when you were told.
- **Cain can now check this add-on too** (Cain 0.5.0): it answers a keyed health check while its main loop is turning.
- **Review fixes to the watch.** The "Cain is back" message now comes straight from here, so it can't sit unshown. Cain's Discord connection being down for 5 minutes counts as Cain down, and the message says so. A restart during an outage no longer breaks the Harness page, a failed check or send can't stop the main loop, the 5 minutes are timed on a clock that boot-time clock jumps can't fool, and a busy loop isn't mistaken for a stuck one.

## 0.19.13

- A dated row from Cain's record (`for`: the event's day) is Dane's answer about that one event: the Family event with exactly those words on that day gets what he said, as if he had answered its card, whatever the judge thinks. Other events with those words still go to the judge, with the row as an example. No question is asked about an event he already answered this way.

## 0.19.12

- **Self-healing judgments.** Each read, any judgment that never had an active answer of his in front of it is made again, if one fits the event now. Once it has seen his answer, it never triggers again. Before this, an answer that arrived "already known", or after the event was judged, never reached the judgment (the Nov 21 turkey harvest).
- **The no-block line says whether the judge saw his answer or never saw it.**

## 0.19.11

- **The Telegram code is gone.** Telegram was replaced by Discord on Nov 7, and the bot is deleted. Removed: the long poll, the Telegram API client, /start pairing and deeplinks, and the Telegram token field on the setup page. Shared message shapes moved to chat.py. The ledger is unchanged, and a leftover token in the vault is ignored and dropped on the next write. Stop, Turn back on, cards and Undo all run through Discord as before.
- **A request's calendar read counts against its 10-minute deadline** (P9). The model's retries get only the time left, so a slow read can't push a request past its deadline mid-retry. A failed request logs its reason, attempts and run time, and a read over 20 seconds is logged.

## 0.19.10

- The no-block line also counts his own answers for the event's words, by state (active, overruled). That tells a judge that ignored his answer apart from an answer that never arrived or was overruled.
- Each table of his answers Cain sends is logged: rows, new and already known.

## 0.19.9

- A Family event in the next 30 days that gets no block now says why in the log, once, and again only when the reason changes. The reasons:
  - he answered no;
  - judged as nothing for him;
  - not backed by one of his answers;
  - the judge wasn't sure.

  Each comes with the judgment's counts. Prompted by the Nov 21 turkey harvest, which had his answer and no block, with nothing saying why.

## 0.19.8

- Drive blocks are rounded up to whole quarter hours (Dane, Nov 9): a 66-minute drive shows as 75, so the drive there starts on the quarter hour and never cuts it fine. Exactly 15, 30 and so on stay as they are. The choice between going home and driving straight on uses the rounded times too.

## 0.19.7

- Family events that only name a place ("Funky's Skate Center") now get their drive blocks and address too. The place is looked up by its name on the map, only near home, and only if the map's name really matches. Your block then shows the place's name and street address, so it opens in Google Maps.
- Cain also keeps a place book for you: each place name once, with its street address. Your word wins over the map, so nicknames, typos and private places ("HMLC", "Grandma's") work too.
- When an event you go to is at a place neither your book nor the map knows, Cain asks you once: "Where is HMLC? (for Skating HMLC, Fri Nov 20)". Reply with the address, or tap Skip. Each place is asked once; a place you skip is never asked again unless you bring it up.
- Only the event's place goes to the map, never its title or notes, and each name goes out once. A place in your book, or one you skipped, isn't looked up at all.
- Events you go to now get their drive and address even when the judgment didn't say where the event is, as long as Family has its street address. Events judged to be at home or school still don't.
- Events at a place you add later get their drives on the next read, with no restart.

## 0.19.6

- Family events you go to yourself now get their drive time on your Gmail, as separate blocks: "Busy (drive there)" ending when the event starts, and "Busy (drive back)" starting when it ends. The event's own block keeps its real start and end, so you can still see when it begins.
- Drives start and end at home, unless two events on the same day are too close to go home between them. Then it's one drive straight from the first to the second, and no drive home after the first.
- The event's block now carries its street address, so tapping it on your phone opens Google Maps. Only the street address goes on it, never a name or note from Family. Calls and links get no address and no drive.
- New setting `home_location`: your home, as map coordinates ("38.5, -78.5") or a street address. Empty leaves drive blocks off.
- If a drive time can't be found, that drive block is left off and your digest names the event's day and time.
- Undo on an event takes its drive blocks off with it, right away. Events already on your Gmail still get their drives, and an event you're driving someone to never gets a second set.

## 0.19.5

- No more "and N more": the digest, the mail-dates note and the Family notes name every item, so nothing is hidden behind a count you can't open on your phone.

## 0.19.4

- Events judged before your answers counted are judged again, once, with your answers in view (the Dec 15 dentist was one). A few cents of Claude calls.

## 0.19.3

- Your answers about Family events are used again. One you gave Cain could be set aside by an old setting that was only loaded after the day you said it, as with the Dec 15 dentist. Your answer now always wins over an old setting, and answers set aside that way are back in use.

## 0.19.2

- An appointment or event from your mail now lands at its time, for an hour, with your usual reminder, instead of as an all-day note. It stays free, so nothing reaches work. Deadlines and last days stay all-day, with no reminder.
- Ones already on your calendar move to their time once, unless you've changed them.
- The calendar-meaning shadow log now says why each difference happened (sure or unsure, how certain, whether one of your answers backed it), so a miss like the Dec 15 dentist one can be traced.

## 0.19.1

- Cheaper Claude calls: the fixed instructions sent with every call are now marked for Anthropic's prompt cache, so a run of calls (judging your Family events, reading dates from mail) pays full price for them once, then a tenth. Nothing you see changes.

## 0.19.0

- New, off by default: `meaning_live`. When on, the blocks on your Gmail come from what each Family event was judged to mean, not from title words. Switch it off and the old title rules are back exactly as they were.
- Blocks it's sure of (backed by your own answers) are "Busy (...)". Kids or driving in the next 48 hours that it isn't sure of get "Maybe busy (...)", shown free, so work never sees it.
- When it can't tell and it changes your next two weeks, Cain shows you one question with buttons ("are you watching the kids?", "does it tie you up?"). At most three open, one per kind of event, never the same one twice. Your tap is remembered for that kind of event; "Depends" means it asks each time.
- Each new block gets a card with Not mine, Wrong time and Just this once. Removing a block by hand on Google still just removes it.
- What you tell Cain a kind of Family event means is kept in your record and sent here, so it counts too.
- Questions and Undo cost no model calls.

## 0.18.1

- Shadow scoring: school runs use the same fixed drive windows as today (the first pass showed 86 timing-only differences), and the difference list shows misses first, one line per event with a count, so a series can't crowd out what matters.

## 0.18.0

- New, off by default: `meaning_shadow`. Claude judges what each Family event (last and next 60 days) means for you as typed obligations (you're there, you drive, you have the kids, farm coverage, she's away, can't do anything), and plain code turns those into the blocks today's code would write. Shadow only: nothing is written to any calendar. The blocks it would give are scored against today's title rules, in one log line with up to 20 differences, and on the add-on page. At most 10 calls a run, 60 a day, and $3 a month on its own spend line. Your rules and the two title settings are its first examples.

## 0.17.1

- Fixed: "this ties me up" (a rule about what a Family event means) crashed the card and left the request hanging for 10 minutes. A crash while finishing a request now ends it at once.
- With Cain in front, a request that fails for a reason that isn't yours (a timeout, a restart, a bug, a model hiccup) runs once more on its own, from the same message; after an update, recent failures get that one retry too. You are never asked to send it again. A change from a retry still waits for your tap.

## 0.17.0

- Cain is the gatekeeper. This add-on no longer has its own Discord connection and never posts to you itself: every card goes to Cain's link, which holds it until Cain shows it, unchanged. Taps on its cards come back from the link. Only Stop's notices and the 7:40 digest fallback go straight out.

## 0.16.0

- Cain posts through the keeper: questions with buttons, and one morning update with the calendar digest folded in (with Stop). If Cain hasn't posted it by 7:40, the digest goes out on its own.
- Your taps on Cain's questions and your reactions to his messages reach Cain. The keeper's connection now also hears reactions in your DM (only reactions: still never your messages).

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
