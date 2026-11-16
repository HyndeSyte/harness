# Harness

A small deterministic controller behind Cain, your assistant on Discord. You ask Cain;
calendar requests come here, and Claude (and, later, GPT) work through it. Its messages
and buttons reach you as cards Cain shows. The models never hold a credential and
can't change anything themselves. At this stage the harness has **one effect**, off
until you turn it on: adding an event to the iCloud Family calendar.

## Set up (about 20 minutes, once)

1. **Install** this add-on and start it. Leave *auto-update* off: an update to this
   add-on is a change you should see first.
2. **Open the Harness panel** (sidebar, or *Open web UI* here). The first Home
   Assistant user to save settings becomes the only one who can change them.
3. **Paste the keys**, each into its own box, then *Save*:
   - the Discord bot token (Cain's bot, the same one Cain's add-on uses);
   - an Anthropic API key, with prepaid credit and auto-reload off;
   - an OpenAI API key, with prepaid credit;
   - optional: your calendars' **secret iCal addresses**. In Google Calendar on a
     computer: Settings, pick the calendar under *Settings for my calendars*,
     *Integrate calendar*, copy *Secret address in iCal format*. Paste several into
     the same box with a space between them (up to six).

   Keys are stored only in this add-on's private storage (`/data`), never in add-on
   options, and are never shown again.
4. The harness acts only for the Discord account that owns the bot, and only on that
   account's own messages in its DM with the bot.

## What it does now

- Answers and drafts when you write. Every job ends in a receipt in its ledger. Its id
  is in the log, never on your messages.
- Keeps corrections as typed rules ("keep drafts short"). A rule does nothing until you tap
  *Keep rule* on a card showing its exact text; it then has an *Undo* button. `/rule` lists
  them, including any still waiting.
- Sends a short digest every morning (from the configured start date): *Clear*,
  *Decision needed*, or *Attention needed*, with what failed and since when, then
  today's calendar. If a calendar couldn't be read, the digest says so; it never
  shows an unread day as empty. Overlapping events are marked.
- Before the start date the digest is still written every morning, just not sent.
  The last one is shown on this add-on's page, so you can check it against your
  calendar.
- Runs a daily canary through Claude and GPT and reports if either fails.

Apart from adding an event to the Family calendar (below), it can't send email, book,
buy, delete or schedule anything. Effects arrive one at a time in later stages, each
with a card you approve by tapping.

## Stop

Every card with buttons, and the digest, carries a red **Stop** button: start nothing new
until you tap **Turn back on**, which takes its place while stopped. What you ask while
stopped isn't acted on, and comes back after **Turn back on** as one card each, with **Do it
now** and **Drop it**, and so does an *Undo* you tap while stopped. **Drop it** is final, and
**Do it now** on an *Undo* holds even if Harness restarts at that moment. What
it's doing, spend this month and canary results are on the Harness page.

## If Cain stops

This App and Cain's check each other every minute. If Cain hasn't answered for
5 minutes, or says its Discord connection has been down that long, you get one Discord
message from here (Cain is the usual path, and it's the one that's down), and one more
from here when it's back. Until then Stop and the buttons
don't work; calendar work goes on and cards wait. If Cain is still down after 30 minutes,
one more line says how to restart it (Settings > Apps > Cain > Restart), once per outage.
Restarts and updates are shorter than 5 minutes and say nothing. The Discord section of the Harness page shows whether the
Discord link is connected, when it last heard from Discord, and this watch.

## When something it works from stops

Your mail, the Family calendar, your Gmail calendar through Google and your calendar addresses are
each watched, and the sorting of Family events too while it decides your blocks (`meaning_live`).
Something is down from the time it fails until the next time it works.

- **What only you can fix**: Gmail's app password, Family's app-specific password or the Google
  service account key turned down, Gmail wanting you to sign in on the web, or your Gmail calendar
  no longer shared with Harness. One message as soon as a second try confirms it, saying what
  stopped, since when, what it costs you, and the steps from your phone. They end on the Harness
  page (Settings > Apps > Harness > Open Web UI, under "Replace a key") and confirming it on the
  card that follows, within 15 minutes. If a new key is turned down too, you hear again.
- **Anything else**: Gmail, iCloud or Google not answering, Claude turning Harness's requests down,
  or the Pi's clock being off. One message once it has kept failing for six hours, sent on the
  quarter hour with everything else that's down then, so a home internet outage is one message.
  A message that hasn't gone out yet only says what's still down, and is dropped if everything in
  it works again.
- Each comes once per outage, with no buttons. None are sent while Harness is stopped.
- **The morning digest** names each one that's down once it has failed twice or for an hour, or
  you were told, and says in one line which came back since the last digest. There's no separate
  "it's back" message.
- **The log:** a failed email read or look-up is a warning naming only its reason (refused, web,
  unreachable, error, unexpected, engine or limit), when the reason changes or once an hour.

## Calendar

The harness reads each calendar through its secret iCal address, every 30 minutes
and again just before the digest. That address can only read; nothing here can
change your Google calendars. Treat it like a password: if it leaks, use *Reset* next to it
in Google Calendar and paste the new one here.

If an event uses a repeat pattern the harness doesn't understand, the digest says
how many it couldn't read instead of leaving them out.

## Family calendar (from Home Assistant)

An iCloud Family Sharing calendar has no secret address, but Home Assistant can
read it (CalDAV integration). Home Assistant pushes a small copy here: title, start
and end of each event from midnight today to the end of tomorrow: every hour, once
shortly before the morning digest, and at start. (Home Assistant itself re-reads an
iCloud calendar only about every 15 minutes, so pushing more often gains nothing.) Nothing else about the event leaves Home Assistant. The harness only
lists it. Until a push has arrived, and whenever the last one is older than two
hours, the digest says so instead of calling the day Clear.

The key is made inside Home Assistant and never shown to anyone: add a line
`harness_family_key: "<64 random hex characters>"` to `secrets.yaml` (for example
from the Terminal app: `openssl rand -hex 32`). The harness takes the first key
that arrives while it is accepting one: for 30 minutes after the add-on starts
without a key, or 30 minutes after *Accept a key from Home Assistant* on the add-on
page. After that, a push with any other key is refused and counted in the next
digest. *Reset* forgets the key.

A package file, for example `packages/harness_family.yaml` (replace
`0fcc2575-harness` with your add-on's hostname, shown on its Info page):

```yaml
rest_command:
  harness_family:
    url: http://0fcc2575-harness:8100/family
    method: post
    content_type: application/json
    headers:
      X-Harness-Key: !secret harness_family_key
    # The automation hands over JSON text; if Home Assistant ever turns it back
    # into a mapping on the way, encode it again.
    payload: "{{ payload if payload is string else payload | to_json }}"
    timeout: 10
```

Home Assistant needs one restart to load `rest_command` the first time. Then an
automation (Settings > Automations, or YAML):

```yaml
alias: Harness – push Family calendar
mode: single
triggers:
  - trigger: time_pattern
    minutes: "5"
  - trigger: time
    at: "06:50:00"        # just before the 07:00 digest
  - trigger: homeassistant
    event: start
actions:
  - action: calendar.get_events
    target:
      entity_id: calendar.family
    data:
      start_date_time: "{{ today_at() }}"
      end_date_time: "{{ today_at() + timedelta(days=2) }}"
    response_variable: cal
    continue_on_error: true
  - action: rest_command.harness_family
    continue_on_error: true
    data:
      payload: >-
        {%- set ok = cal is defined and cal is mapping and 'calendar.family' in cal -%}
        {%- set ns = namespace(ev=[]) -%}
        {%- if ok -%}{%- for e in cal['calendar.family'].events -%}
        {%- set ns.ev = ns.ev + [{'summary': e.summary, 'start': e.start, 'end': e.end}] -%}
        {%- endfor -%}{%- endif -%}
        {{ {'v': 1, 'entity': 'calendar.family', 'state': states('calendar.family'),
            'ok': ok, 'generated_at': now().isoformat(),
            'window_start': today_at().isoformat(),
            'window_end': (today_at() + timedelta(days=2)).isoformat(),
            'events': ns.ev} | to_json }}
```

To stop it, turn the automation off; the digest will then say Family isn't updated.

## Adding to the Family calendar

**The app can write to this one calendar.** It can add one event at a time to iCloud
Family and undo that add. It can't edit or delete anything else, and it can't touch
any other calendar. It is off until you turn it on.

Set up, on the add-on page:

1. Make an app-specific password for your Apple ID (account.apple.com, *Sign-In and
   Security*, *App-Specific Passwords*). It looks like `abcd-efgh-ijkl-mnop`.
2. Enter the Apple ID, that password and the calendar address, the URL of the Family
   collection, which must be `https://p<digits>-caldav.icloud.com/.../`. They are kept
   like the other keys and never shown again. Once there is an owner, enter one at a
   time and approve each on its card.

Then send something like "add dentist Tuesday 3pm":

- **While it's off,** it says so and adds nothing, with a *Turn on* button if the three
  settings are entered. Your tap is the only thing that turns it on. Send the event again.
- **Once it's on,** a card shows the exact event in your local time, with the weekday and
  date. *Approve* creates one event, with no invitees or repeat. It alerts family phones
  that have notifications on for the Family calendar. The offer ends after 12 hours, and an event whose start has already passed is refused.
- **Checks on every proposal.** An event over 24 hours or over a year ahead is refused, and
  so is a title or location with a recognized link or an invisible character, because the
  card must show exactly what is written. The reply says which. A link is a scheme, an IP
  address, `www.`, a mailbox, a host with a path, port or query, or a bare word.word with a
  suffix on a list of real web suffixes, so a name ending in one (`Dr.Me`) is refused too.
  Say it with a space. The list can't catch every address, so any other word.word
  (`Dr.Smith`) gets a warning on the card and never skips the tap. A time written with a UTC
  offset your zone doesn't have at that moment, or the same title and start as another add,
  also puts a warning on the card. Read it before you approve.
- **The receipt** comes once a read of the event finds it there, with an *Undo* button, good for
  7 days. If it reads differently there than what was written (title, start, end and place), the
  receipt says so. Another event at its address isn't called added, and has no Undo; a read with
  no event in it says nothing, and is read again. If a read a
  minute or more after the write doesn't find it, it's written once more at the same address, and
  if it's still not there you're told so plainly. Undo deletes only that event, once. If someone
  changed the event since, Undo refuses and leaves it.

If iCloud's answer is lost, it has a server error, or Harness restarts mid-write, Harness reads
the event a minute after the write was sent instead of asking you to look. If it's there, you get
the receipt. If it isn't, it's written once more (never twice: the event has a fixed address), and
if that doesn't go through either, you're told so plainly. A read that can't tell is tried again
each minute for the first hour, every 15 minutes for the rest of the day, then hourly. After an
hour, one line says it isn't confirmed yet, and you hear once more when it's known; once the event
is over or a week has passed, one line says it couldn't be confirmed, with *Undo* when iCloud
answered the write with a version, and the reads stop. An undo cut short the same way is read too:
gone is undone, and still there is deleted once more, at most, counted only when that delete goes
out; a read that can't get through is tried again on the same schedule. One iCloud turns down is
said plainly, with *Undo*; when it turns down that second try, a read comes first, so you hear
undone, or still there with *Undo*. Any read that finds it changed since leaves it, and says so.
A failed write,
a rejected password or a calendar whose name isn't Family is said in the thread, and stays
in `/status` and the digest until a write succeeds. `/stop` blocks adds and undos, and an add's
reads wait until you turn it back on. If adds are off when you ask for one, tapping *Turn on*
brings that event's card back by itself.

**Checking each add.** The app counts events added and days since the first. At 10 adds
and 14 days, whichever is later, with no undo and no failed or unknown write, it reads the
calendar and sends one card with the record: approved, declined, expired, cancelled, refused,
undone, failed and unknown, how many were shown with a warning, and how many of those events
are no longer on the calendar. It says that adds alert family phones with notifications on
for this calendar, and that without the tap an alert can arrive with nothing approved
first, and it asks whether any adds were wrong. If it can't complete that read, it says so and offers nothing until it can. An undo,
a failed write, or a change of policy or model restarts the count; declines and missing
events don't.

The card lasts 3 days. If you ignore it, it asks again at most once a week. When you tap
it, the app reads the record again first. If anything changed, or the read can't complete,
nothing changes: you get a fresh card, or a message saying why. While `/stop` is on, a tap
changes nothing, reads nothing, and the same card works after `/resume`. `/checkadds` closes
an open card the same way *keep checking* does, and the count starts over.

It won't offer this while any standing rule is still waiting for your tap, and says so.

If you tap the button to stop checking, and the switch for changes without a card is on (it's off
after every install until you tap *Turn on* on the smoke test's card; see "When Cain hands a
request over"), adds go straight in without the Approve tap, up to 5 a day. With that switch off,
each add is a normal card, even after this tap, and the switch is checked again at the moment of
the write. Anything with a warning still gets a card, and so does any add at a start time
another add already has, or from a message that looks pasted (a quoted line, an email's header
lines, a forward, a link), any message in the 30 minutes after one, or a message sent as a reply.
A long or several-line message is no sign of a paste: you dictate. You still get the receipt and the Undo,
`/stop` still works, and `/status` and every digest say adds are skipping the tap. Nothing
else changes.

**Going back.** `/checkadds` brings the tap back at once. It also comes back by itself, and
the thread says why, after an undo, a failed or unknown write, an add iCloud gave no version
tag for (so no Undo), a change to the calendar address, Apple ID or password, a change of
policy or model, or a stored rule that never had your tap. An add already queued when the tap comes back isn't written:
it comes back as its own card for your tap. Going without it again takes a fresh full count. *Reset* on the add-on page ends all of this, along with the keys and
the owner.

**Alerts.** Tested on a real phone: an add alerts family phones that have notifications on
for the Family calendar. The app can't turn that off. Each phone's own Calendar settings can.

## Changing your calendar when you ask

With the `calendar_changes` option on, a change you ask for (move, take off, add, end) is done
straight away when it's clear, with one receipt and an *Undo* button: "Moved PT to 11:30 to
12:30 today (Gmail and Family)", "Took off today's 8:00 drop-off". No Approve tap.

- **Clear** means every event you name is found as exactly one event on that day, and every
  time is plain. Your words match a title either way round: "PT" finds "PT - Clinic", and
  "physical therapy" finds "PT". A time you give ("the 8:00 drop-off") says which one.
- **Unclear** is asked once, by name, and nothing changes until you answer: "More than one event
  today fits PT: PT - Clinic at 12:00, PT follow-up at 4:00. Which one?" One word that fits two
  different events is always asked; a name of two words or more takes the event with exactly
  that name. Part of a name is asked when something within a week fits it better, or repeats
  under it, and a match only on the calendar you didn't name is asked too.
- **Copies follow.** Moving or taking off a Gmail event moves or takes off the Family copy this
  add-on keeps of it, in the same change, and Undo puts both back.
- **Its own blocks are found where they are.** A school drop-off or pickup, a drive or a
  "Busy (...)" block is on your Gmail calendar, whichever calendar you name.
- **Every part, or what failed.** When one part can't be done, the others still are, and the
  receipt names the part that wasn't, and why. "Done" only once the calendar reads back the change.
- **Never "check the calendar".** When a write's answer is lost or its read back fails, Harness
  reads every event the change touched a minute after the write was sent. Landed is the usual
  receipt. Nothing landed is written once more, only over the very version it was written over;
  an event changed on the calendar in the meantime, even back to how it was, is left as it is,
  and the receipt says so. One that landed and that you changed before that read (a note or an
  alert you added or took away, or travel time, included) is done, but Undo leaves it as you left
  it, and so does Undo of a Gmail add you've added a note, a guest or an attachment to. Lines iCloud
  adds of its own, like a default alert it puts on, aren't anyone's change. Half of an event and its
  copy landed is finished, or put back. Reads
  that can't tell come each minute for the first hour, every 15 minutes for the rest of the day,
  then hourly; after an hour one line says it isn't confirmed yet, and the receipt follows once
  it's known, or says it couldn't be confirmed once the event is over or a week has passed. An
  undo cut short by a restart finishes by itself.
- **A tap only when the words may not be yours, or the change is a big one**: a message that
  looks pasted (a quoted line, an email's header lines, a forward, a link, a phone number, words
  written to you), a reply to one, an edited or forwarded message, a note from Cain; a new length
  you didn't give, three or more events off at once, or ending a series. The card says what will
  happen, in plain words; your tap's reply says it again. Until the smoke test after an install has
  passed and you've tapped *Turn on* on its card (below), every change comes on a card.
- **One card per change.** When a message with two or more changes needs your tap, each change
  comes on its own card, so you can take one and not the other, even one that would be clear on
  its own. Two clear changes in your own fresh message still land together in one receipt.
- **Done means the calendar says so.** After every change (an add, a move, which is how a time is
  edited, a removal, a series added or ended, and the Undo of each), the days it touched are read
  again, the way you'd see them. It's called done, with its receipt, only when that read shows it
  as asked: an add there on its calendar with its title and time, a move at its new time and not
  its old one, a removed event gone, an ended series with no day of it from then on. If the
  calendar shows anything else, the receipt says "Not confirmed" and what the calendar actually
  shows ("still shows it at the old time", "shows it at neither the old time nor the new one",
  "doesn't list it on that day"), the record keeps it as unverified, never as done, and it's never
  written again on its own; whatever did go through keeps its *Undo*. A move that went through on
  Gmail but not on the Family copy says exactly that, with *Undo*. A read that disagrees is read
  once more a few seconds later, asking past any cache, and both reads go in the log. Undo is read
  back the same way, event by event, and says so if the calendar doesn't show it back as it was.
- **Not seen isn't the same as not done.** A change the read back doesn't show is read again by
  itself about 30 seconds and 2 minutes later, then once more after a longer window (10 minutes, or
  longer when the smoke test saw the calendar's listing lag: five times the lag it saw, up to 25
  minutes). If a read shows it as asked, a follow-up says "Confirmed". If the read at 2 minutes still
  doesn't, a follow-up says "Not seen yet", and when it will be read for again. The last read asks
  for the event by its own id where the calendar can (an add's fixed id, a moved or removed event's
  id), not a day's list. Only if that doesn't show it either does a follow-up say "Not found", and
  even then its event ids are kept and read every 30 minutes for a week: if it shows up after all,
  you get "Done after all" with *Undo*. All of this is kept in the record, so a restart carries on
  where it was. None of it writes anything. Asking for the same add again later first looks for that
  change's own event (by its id) and the slot, so it finds the first write if it did land, and adds
  nothing.
- **Writes can't hang, or land twice.** Each write to Google or iCloud has one total deadline of 45
  seconds, kept by the write itself: connecting, the request, every request it makes (a sign-in,
  the calendar's name check, the write) and the whole answer, with no retries; a watchdog shuts its
  connection at the deadline, so a server that answers a byte at a time can't keep it going.
  Harness waits 30 seconds for it; one with no answer by then is abandoned and treated as a write
  whose answer was lost, so it's settled by reading, never sent again blind, and its own thread
  ends by the deadline. If three abandoned writes are still running at once, new writes wait: the
  change comes on a card saying writes are paused, and your tap writes it once they've finished.
  Each write carries a token recorded before it goes out. A change being written counts as in
  progress for 2 minutes, and never less than 45 seconds after its last write went out; after that
  it's offered again on a card only once two reads a few seconds apart both answer and both find it
  not done (a read that can't tell leaves it in progress). A change offered again that way is read
  for again too, like one not confirmed (30 seconds, 2 minutes, the longer window by id, then every
  30 minutes for a week): if it shows up, "Done after all" with *Undo*, and the newer card comes
  off. An add offered again keeps the event id of its first offer, so it can
  never become a second event, and the calendar is searched by that id first. If the first write
  answers after all, its token is no longer current: it's recorded as done ("Done after all"), with
  *Undo*, and the card that offered it again comes off; if you'd already tapped that card, it found
  the first write there and added nothing. A move or removal offered again carries the version the
  first card was bound to (sixth round), so whichever of the two writes reaches the calendar second
  is refused by it: one event, one Done. If the first write lands just before your tap, the card
  comes off; if its answer was lost, your tap finds it already done, reads that first write back,
  and says "Done after all" with its *Undo*. If writes were paused, each change on a paused card comes
  back on a fresh card saying writes have resumed as soon as fewer than three are still running
  (only writes still running count, so the number drops as each ends at its deadline; after a
  restart none are), and the paused card comes off.
- **Late receipts say whose request it was.** "Done after all" quotes your request, says the day and
  time you asked and how it was approved (your tap on its card, or with no card from your own fresh
  message), and says how old the request is when it's more than a day. If you'd declined the card
  that offered it again, it's titled "Applied despite your Decline". A plain add that still reads
  exactly as it was written is then taken off again by itself, guarded by the version just read, and
  that same receipt says how it went: off your calendar (a read by its id shows it gone); turned
  down, so it's still there, with *Undo* first for 30 days; or not known yet, still being read, with
  the outcome to follow. Anything else (a move, a removal,
  or an add changed since it was written) comes with *Undo* first, and that *Undo* lasts 30 days
  instead of the usual week. *Undo* of a late one is sent with the event's version as it is now; if
  the event was changed since, it's left as it is and the message says how it reads now. A late
  landing of any card in one change's family (its first card, a card offered again, or the fresh
  card after a refusal) takes every open card of that family off, so there's one Done.
- **A move or removal is never sent over a change since its card.** The card keeps each event's
  version as its read found it (Google's etag, or the iCloud resource's), byte for byte, quotes and a
  weak marker included, and what it showed of the event: title, start, end, all day or not, the
  series's rule, location, notes, each attendee with their answer, the organiser, and whether it shows
  as busy or free. Notes are compared with only line endings and trailing spaces evened out, so any
  other edit, a doubled space included, counts as a change. Just before the write, the event is read
  again. If any of those fields reads otherwise, or its version differs from the card's (unless it's a
  day of a Google series or an iCloud resource holding a series or several events, and every field the
  card kept reads the same: another day's edit), nothing is sent at all: the receipt says **Not
  applied**, that the event changed since your card, which fields changed and what it shows now, and
  that nothing was sent to the calendar; the card is replaced and one fresh card follows, read anew so
  it's bound to the event as it is now. Harness never sends a write it expects the calendar to refuse,
  so a calendar that ignored If-Match couldn't apply it either. Otherwise the write is sent with the
  version that read gave (If-Match), so anything newer than that read is still refused by Google or
  iCloud. Each move or removal's If-Match and the calendar's answer code are in the log. Every Family
  write is built from that same read: its own text with only the asked change made, so another day's
  changes, exception dates, reminders and everything else in the resource stay as that read had them.
  A day of a Google series is written as that day's own event, with only its start and end sent, never
  the series, so other days' changes, cancellations and attendees stay. A day whose read gives back the
  whole series isn't written: the receipt says "Not applied", that the calendar returned the whole
  series for that day so nothing was changed, and to say to Cain whether you mean only that day or the
  whole series, so a new card follows.
  A write the calendar still refuses for its version (an edit between the read and the write) is read
  by the event's id and compared with the change (title, start, end, all day or not, repeating or not;
  a Google event read back cancelled counts as gone): when it already shows the change as asked, it's
  Done (with nothing of Harness's there to undo, unless an earlier approval of the same change has a
  write that never answered: then that write is read back, and it's "Done after all" with its *Undo*).
  When the read gives back the very version that was sent, the event didn't change and the calendar
  refused its own safety check (a weak version under a strong compare, or a version it rewrites): one
  "Not applied" receipt that says so, both versions in the log, no fresh card, and a *Try again* button
  that makes a new card from a fresh read of the event, for your tap (a new change family). Any other
  version, even with every field the same, is a change since: "Not applied" and one fresh card. That
  fresh card is one of the change's family: a late landing of any earlier write takes it off, and a
  refusal reads every earlier write of the family before calling the change stale. At most one fresh
  card per change family: if the fresh card is stale too, its receipt says what changed on the event
  since your card and offers *Start again from now*, which makes a new card from the event as it is
  now, for your tap, as a new change family with its own one fresh card. A refused or unsent write is
  never "Not confirmed", never read for again and never "Not seen yet" or "Not found"; those are only
  for writes whose outcome is unknown (no answer, or a lapsed deadline). A late add whose fixed address
  turns out to be taken (Google's 409, iCloud's 412) is never assumed to be Harness's own write: the
  event there is read and compared the same way, and only a match counts as there.
- **Bound to the event the card names.** A removal or a move is bound to the very event its card or
  receipt names (calendar, id, and for a repeating event which day of it): a different event found
  later is never changed in its place, and nothing changes if the event isn't that one any more.
  This holds with or without a card. Taking off one day of a repeating event says "this occurrence
  only (the rest of the series stays)"; ending a series says "the whole series from then on". Undo
  puts back exactly that day, or exactly that series, and reads it back. Another event like a
  removed one still in that slot is named on the receipt. Undo of an add only ever takes off the
  event that add made.
- **Already there is your call, and never silent.** Asking to add the very same event that's already
  there (the same calendar, the same title, case, spacing and punctuation aside, the same start and
  end, all day or timed alike, repeating or not alike) adds nothing, and the receipt names the event
  that's there with an *Add anyway* button, which adds the second one. A very short title (two
  letters, like "PT") never counts. Anything only like it (the same title and start with another
  end, one day of a series against a one-off, one name holding the other's words, such as "School
  drop-off" and Harness's "Busy (school drop-off)" block, or the same title on the other calendar)
  comes on a card naming the event that's there (its calendar, title and time) with *Add anyway* and
  *Leave it*, and nothing is written until you tap. *Leave it* is kept as your answer, so asking
  again later says it's settled.

### When Cain hands a request over

Cain doesn't pass your words on: Harness reads your DM itself.

- **The message it rests on.** Cain names the message your request is in, and Harness acts on
  that one if it's yours and from the last 30 minutes, whatever you sent after it. Without one,
  it's your newest message, from the last 2 minutes. The same message handed over again finds
  the same request, never the answer to something else you said.
- **Which changes go through without a tap.** Only three paths: your own newest message, under 2
  minutes old, with nothing of Cain's in it, not split into several changes and with no day your
  words leave open; a date from your mail you tapped *Add to Family* on (your tap on the mail card
  is the go); and Family adds once you've tapped "stop checking" on the bake-in card (Family
  calendar adds, above). All three sit behind one switch, and it's **off after every install** (the
  first start of each new version turns it off and ends any smoke run from before), so
  every change comes on a normal card, until the smoke test below has passed on the real calendars,
  Harness has found every item of it in its own record (`keeper.sh fastpath on <run id>`), and you
  tap *Turn on* on the card that shows the evidence. A run with any item missing from the record is
  refused and nothing changes; *Keep cards* leaves it off; the run, who tapped and when are kept in
  the record; *Turn off* on that card, or `keeper.sh fastpath off`, turns it off again at any time,
  and a change approved for a path without a tap and not yet written then comes on a card instead.
  Turning it on again takes a new smoke run. Once on, a change with no card waits for your tap when
  a write of Harness's on that calendar is younger than the listing lag the smoke test measured,
  since the reads that judge duplicates may not show it yet; an add of the same event read back
  within that lag is looked for by its own id first.
- **After every install, cards are held per calendar until the smoke test has passed there.** Until
  the smoke run has read back, on that calendar, a move or removal sent with If-Match on an event that
  was there and an edit of one day of a repeating event, a request for that calendar comes on a card
  that says it's waiting for the check after installing, with no *Approve*, and nothing changes. A card
  offered before the install and tapped meanwhile is held the same way. Held cards don't run out. Once
  that calendar's check is done, each held change comes back on a fresh card, read again then, through
  the usual checks, for your tap. Gmail and Family open separately: one can be open while the other is
  held. While a smoke run is live, its checklist goes through the card path as usual. If, during the
  run, a calendar refuses the safety check on an event that hadn't changed, that calendar stays held
  and you're told plainly that edits there are blocked and why, with an *Open cards without the check*
  button. That tap, or Cain's `keeper.sh fastpath gate-open gmail` (or `family`) on your say, opens that
  calendar's cards without the check, for when the run can't complete there; who did it and when is
  kept in the log, its held changes come back on fresh cards, and the paths without a tap stay off. An
  install is each new build: the ledger keeps the version and a build identifier (a hash of the App's
  code), so a rebuild of the same version counts as an install too, and a restart doesn't. (A ledger
  made new, with nothing in it, counts as an install too.)
  Even with the bake-in tap already given,
  a Family add is a normal card while the switch is off. Each path is checked against the switch
  again at the moment of the write. Once on, each is also checked again then: for your message,
  a fresh read of the DM must still show it as your newest, still under 2 minutes old, with no card
  open or replaced for it, in the same step that takes the change, and that step records your
  newest message; if any of that fails, it comes on a card saying why, and nothing is written. Right
  after the write the DM is read again: if you sent another message in that moment, the receipt
  says so, keeps *Undo*, and that message is read as a correction of the change just made (on a
  card), not as a request of its own. A message's age comes from the time inside its Discord id,
  against the Pi's clock, with 5 seconds allowed between them: it's fresh up to 1 minute 55 seconds,
  and one that seems to come from more than 5 seconds ahead of the Pi's clock can't be timed, so it
  comes on a card. Every other path needs your tap on a card: a message Cain names that isn't your
  newest, one over 2 minutes old, one that carries Cain's suggestion, each part of a split message,
  and anything else from your mail.
- **What that card says.** It quotes the message it acts on, on one line, with how long ago you
  sent it, and "you sent N messages after this" when you did. It states the change exactly: what
  happens, on which calendar, to which event, on which date and at what time. Any of those that
  came from Cain's suggestion and not from your words is marked "(from Cain)"; a date or time in
  neither is marked "(not in your words)".
- **Days in your words.** "Today", "tonight", "tomorrow", a weekday ("Friday", "this Friday": the
  soonest one, today included), "the 13th" (the soonest 13th) and a month and day count as your
  words, counted from the day you sent the message in your time zone (the add-on's `timezone`
  option, never UTC or the Pi's own clock, and right across a daylight saving change), so "tomorrow"
  sent at 11:58 PM is the next day even if it's read after midnight. The rules below that leave a
  day open (the day you sent it, and the small hours from midnight to 4 AM) use that same zone. The card shows the date with your word
  ("date Fri Nov 13 (your "Friday")") and the receipt says how it was read ("Read from your words:
  "Friday" as Fri Nov 13."). Some days have no one answer, so their date is marked "(not in your
  words)" and the change comes on a card: "next Friday"; a weekday that is the day you sent it
  ("Friday" sent on a Friday: today, or a week on?); "the 16th" sent on the 16th (today, or next
  month?); and "tonight" sent between midnight and 4 AM (the night just ending, or the one coming?).
- **A card stays true to itself.** Your Approve counts only for the card you tapped, and only once:
  your tap and a newer card replacing it are one decision on that card, so they can't both win,
  and two taps on one card do it once. When Cain adds a note, it replaces only the cards whose
  change it corrects: the same event, or else, by name, the one card whose event's name matches;
  those lose their buttons and the new card says it replaces the earlier one; a tap that still
  reaches an old one is answered "Replaced by a newer card" and changes nothing. When the name
  matches more than one card, none is replaced: a card asks which one it corrects (*Card 1*,
  *Card 2*, and so on, or *Neither*, which puts the correction on a card of its own). The other
  cards from that message stand, still waiting for your tap, and aren't offered twice. Whether a note
  speaks to a card is decided by Harness's own rules in code (the same event by id, or the same kind
  of change to an event whose name holds the other's words), not by the model. When those rules
  can't tell (the name matches but the kind of change differs, or the same kind of change on the same
  calendar and day), the card asking which is used (*Card 1*, and so on, or *Neither*), never a
  guess, so a stale card isn't left standing unasked. A note that speaks to none of the open cards
  is never dropped: it runs as a request of its own, and its one response (its card, or its
  question) carries a line quoting the note and saying the earlier cards stay as shown. Those cards'
  button becomes *Approve as shown*: the first tap on it only confirms you've seen there's a newer
  note, and the next one approves; if the card ran out or was replaced in between, that second tap
  says exactly that, and nothing is done. A note on a message whose cards you all declined, or that
  ran out, runs it again as a new request of that same message, quoting it, on a new card. If your
  tap on a card is still being carried out when a correction comes, the correction waits for it to
  finish, then works from what it did.
- **What the version before left.** The first time 0.24.0 runs, it sweeps the record once. That
  sweep is keyed to a schema version kept in the record itself, never to the App's version, and it
  runs as one step: if it's cut short, it runs again from the start. Any card still open from the
  version before is replaced: its buttons come off, and a tap on it is answered "Replaced when
  Harness updated. Nothing was done." Any change the version before had approved or was writing is
  read back from the calendar and recorded as done, with its receipt and *Undo*, or as not
  confirmed, with a receipt saying so; none is written again. One the version before approved but
  never started kept no event id of its own, so it counts as done only when each part is an add whose
  event is there and the calendar made that event after your approval (its own "created" time); a
  move found at its time, or an event made before, could be anyone's, so it's not confirmed. A change
  recorded as not confirmed joins the same reads as any other (30 seconds, 2 minutes, the longer
  window by id, then every 30 minutes for a week). Then one message lists each request that was
  replaced or not confirmed, a sentence each with your message quoted, with one *Propose again*
  button: a tap uses up every button on its message, so it puts each request back on a card of its
  own, and each card is approved or declined on its own, as the message says. Just before that, each
  request's slot is read: one the calendar now shows is said as "Confirmed" instead of offered
  again.
- **Cain's details.** When Cain adds what it found (a date in an email) or spells out what you
  asked, Harness works from it with your message, and the change comes on a card: your Approve
  tap is the go. A message older than 2 minutes is still acted on that way. A handover that
  waited over 2 minutes before Harness could read it is turned down, and Cain hands it over again.
- **No card asks you to repeat yourself.** When Cain passed words with a request and Harness still
  needs to know something, the question goes to Cain, who has them, and Cain answers it with a note
  on the same message. If Cain's note answers it, the request runs again with it and the card
  follows. If no note comes within 10 minutes, Harness asks you itself, on a card that quotes your
  message, what Cain passed on, and the question; your reply answers it. That 10 minutes is a
  deadline kept in the record, checked every few seconds and again right after a restart, so a
  stalled moment or a restart can't lose it; the log says how late it fired.
- **Nothing twice.** When a request runs again (a note from Cain, or a "not a change" looked at
  again), what's already done from that message is shown as already done, and only the rest is
  offered. Already done means the calendar was read back showing it (or you tapped *Leave it*). A
  change still being written counts as in progress only for 2 minutes; after that the calendar is
  read, and anything it doesn't show is offered again on a card, and never written again on its
  own.
- **"What does that mean?"** When you ask what one of its cards or messages meant, Harness reads
  its own recent cards and answers in words. A question about what something means is never taken
  for a change.
- **A reply that doesn't fit.** If the model's answer is off only in fields that can't change what it
  does (a field the change doesn't use, its location, its summary), it's tidied, the card names the
  fields tidied, and the change comes on a card. What a change does (the calendar, the operation,
  the event's name and days, its start and end) is never filled in or reshaped: if one of those is
  missing or malformed, it runs once more by itself instead, told what didn't fit. If it fails
  twice, the message says it's logged for a fix and nothing more happens with it on its own.

### After every install: a smoke test on the real calendars

The read back is tested against fake calendars; Google and iCloud can list a change a little
late. So after every install the three paths without a tap stay off, and each calendar's cards are
held (no *Approve*) until the run has read back there a fenced edit and an edit of one day of a series,
or until it has been run once, with throwaway events on a day with
nothing else on it (each name below is an example; use anything unmistakable). Cain starts it with
`keeper.sh fastpath smoke-start`: Harness issues the run's id and records every change approved while
the run is live under it. Every step goes through the normal card path: Cain hands it over, and you
tap *Approve* on its card. The run's first add is let go at once, so its answer comes late and is
read back a minute later like any lost answer: that's the late landing item. That is the only write
Harness ever lets go on purpose, and only for an add of a live run.

A run is bound to this build: it keeps the App version, the build identifier, the ledger's schema and
when it started. It
runs out after 24 hours, and stops recording at *Turn on*, at *Turn off*, at a new smoke-start or when
it runs out. It gives one *Turn on*. A run that's used, ran out, was started under another version or
schema, under another build, or is older than the install is refused by name: start a new one. Each add of the run is a
test event: its title starts "Smoke test: " and it carries the run's id as a private property (on
Gmail, the event's private extended property `harness_smoke`; on Family, an `X-HARNESS-SMOKE` line).

On Gmail, and then the same on Family:

1. An add: "add Pool test at 3 PM tomorrow". Done ("Added Smoke test: Pool test"), and the calendar
   shows it.
2. A move: "move Smoke test: Pool test to 4 PM". Done, and it shows at 4 only. Then *Undo* on it:
   "Undone".
3. A removal: "take off Smoke test: Pool test tomorrow". Done, and it's gone.
4. A card for an event that changed since it. To produce the Gmail stale card: add a throwaway
   one-off event in Google Calendar on the web (not a series), ask Cain to move it, and when its card
   comes, open the event in Google Calendar and change its end time by 15 minutes, save, then tap
   *Approve*. To produce the Family stale card: add a throwaway one-off event to the Family calendar in
   the iPhone's Calendar app, ask Cain to move it, and when its card comes, open it on the iPhone and
   change its end time by 15 minutes, save, then tap *Approve*. Each time the receipt says "Not
   applied" and "nothing was sent to the calendar", and a fresh card follows (tap *Decline* on it). The
   log shows the card's version and the version just read; no write goes out.
5. The gate's two edits, each read back: a move (step 2 counts, since it's sent with If-Match on an
   event that was there) and a move or removal of one day of a throwaway repeating event (the series
   step below counts on Family; on Gmail, move one day of a throwaway weekly event). Once both are
   read back on a calendar, its held cards come back.

And once, on either calendar: two days of one throwaway repeating event taken off on two cards, both
Done. The listing lag is measured from the record itself: from each write's read back by its id to
the days, read as you'd see them, showing it. It needs at least two samples on each calendar (the
steps above give more), each from 0 to 300 seconds, the most the duplicate and no-card checks allow.

Then Cain runs `keeper.sh fastpath on <run id>`. Harness builds each item from its own record: the
event ids, when each was asked and read back, the stale cards whose write was never sent, each
calendar's gate (its fenced edit and series-day edit, or the override), the two days of
the series, the late landing and the lag samples on each calendar. Anything Cain says passed is
ignored, and an item with no evidence in the record is refused by name, and nothing changes. A full
run sizes the longer read window from the lag and keeps the lag for the duplicate and no-card checks,
and comes to you on one card that lists each item's evidence (ids and times, in plain words), each
event read again from its calendar right then and shown beside it ("now: ..."), the lag samples per
calendar, and every path *Turn on* lets go without a card, the stored "stop checking" for Family adds
with its date included, with *Turn on* and *Keep cards*. Only your *Turn on* turns the paths on; the
run, who tapped and when are kept, the run is used up, and a *Turn off* button then sits on that
card. *Turn off*, a new smoke-start and every install take any open *Turn on* card off.

When the run is turned on, refused, or runs out, the run's test events still on a calendar are
listed in one message with *Take them off*, which removes each one only if it's still as the test
left it (sent with its version as If-Match). If a step says "Not confirmed" while the calendar does
show the change, the log has both reads ("read back of gmail (first)" and "(fresh)"): that's the
case to report, and the paths without a tap stay off. Nothing else to set up.

### Before a Ship card: the migration on a copy of the ledger

Before Cain shows a Ship card for a Harness update, he runs `keeper.sh fastpath migrate-check` (the
live ledger) or `keeper.sh fastpath migrate-check <path>` (a ledger file at that path, as Harness sees
it). Harness opens that file read only, copies it with SQLite's own backup into a temporary file, runs
this version's migration and install step on the copy with no calendars, deletes the copy, and answers
with what it found: the schema version, whether the paths without a tap are off (they must be), whether
the gate is set and which calendars it holds, how many *Turn on* cards are still open (none), how many
rows it touched, and how many changes left in flight it would read from the calendars on the real run.
The ledger itself is never touched. The same dry run works by hand inside the App:
`python3 -m harness.migrate <ledger path>` prints it as JSON.

## Dates from your mail

With the `mail_dates` option on, dates in your mail go on your calendar. Deadlines, last
days, renewals and the like are free all-day entries with no reminder, so nothing reaches work. An
appointment the email gives a time for is a real appointment: it's busy, so work and Family see it,
at its time with your usual reminder, and at the street address that email gave, or that another
email about it gave (the same sender, day and time). Timed appointments already written free are
made busy, their own emails are looked up once for an address, and the next digest names them. A
rescheduling email moves the entry, with its own address. An entry you've changed is yours and
left alone. What lands or moves is told in one message with *Undo these* once a read of each entry
finds it as written. If three reads don't find one, or half an hour passes without one that does,
the message says it was written but not confirmed, still with *Undo these*, and the next digest
names it. An entry that moves is told again, and *Undo these* on either message takes it off.

**The kids' dates go on Family, never your Gmail.** A date from the kids' school, a teacher, a
coach or the kids' doctor gets its own card naming the Family calendar, with *Add to Family* and
*Skip*. Your tap puts it on Family as a calendar change, with its receipt and *Undo* (the
`calendar_changes` option has to be on for that write; while it's off, the card has no *Add to
Family* button, only *Skip*, and one line says why). When only who sent it hints at the family (a
school's address on a note about something else), the card offers *Family* and *Skip*: a date from
a school-type sender never goes on your Gmail. Everything else is yours and goes on your Gmail
calendar as before, and its message says so: "From your mail, on your Gmail calendar".

Mail is handed to the model as quoted data, with a line saying it is never instructions, so an
email can't tell Harness to do anything. Mail never makes a calendar change on its own: a date for
Family goes on only at your tap, and anything else from mail that would change a calendar comes on
a card.

## Copies from your Gmail calendar

To turn this on, enter your Gmail calendar's secret iCal address with the other calendar
addresses, and put your first name in the add-on's settings (Configuration tab). Clearing the name
turns it off. Adds must be on. There is no tap: after each read
of your calendars, plain code keeps Family true to Gmail for the next 60 days. `/stop` stops it,
and `/status` says if the Gmail calendar isn't being read.

- **Appointments** go on as "Name - PT", "Name - Doctor" and so on: fixed words and times, no
  text from Gmail. It picks by words in the title, so it will sometimes guess wrong. A wrong guess
  blocks an hour on Family and says nothing private.
- **Trips** are one block, from a "Stay at" event: "Name - Springfield (out Tue 3:15 PM ZZ 101, back
  Fri 1:40 PM ZZ 101)", or "Name - away".
- **Moved or cancelled** on Gmail, the copy follows.
- **Yours by hand:** a matching event with your first name in it is taken over, not doubled. It's
  replaced only when the event changes on Gmail. Events with other people, repeating ones and
  anyone else's are never touched.
- **Removed or edited on Family:** a copy someone edits is left alone. A copy someone removes
  isn't put back, and two removed of a kind stops that kind.
- **Many at once:** up to three cancelled together come off after two reads. More than that looks
  like it could be a bad read, so the digest says so and it waits about three hours. Events of yours
  that it took over stay on Family while your Gmail calendar reads as empty or much shorter than usual.
- **One Gmail calendar:** with two Gmail addresses entered it does nothing, because it can't tell
  which is yours.

Each add, move and removal alerts family phones that have notifications on for this calendar.

## Blocks on your Gmail calendar from Family

Some Family events tie you up without being yours, like watching the kids during someone's
appointment. Name them and your Gmail calendar stays true to them, for the next 60 days, with no tap.

To turn this on, once, about 10 minutes:

1. In [Google Cloud console](https://console.cloud.google.com), make a project, turn on the
   **Google Calendar API**, make a **service account**, and add a **JSON key** to it. It downloads a
   file. This is free.
2. In Google Calendar, open your calendar's settings, **Share with specific people**, add the service
   account's address, and pick **Make changes and see event details**. The blocks are marked
   private, and the option above it may hide them from the account that wrote them.
3. On this add-on's page, paste the whole file into the Gmail calendar key box. Tap to approve it on
   its card, as with any key.
4. In the add-on's settings (Configuration tab), set `family_to_gmail`, then restart:
   `Family title => Gmail title`, with `;` between several. The Family title must match in full, not
   counting capitals. The Gmail title must include a word that doesn't copy back to Family, like Busy.
   Clearing it turns this off, and leaves the blocks already there. Taking out one of several
   removes that one's blocks.

Adds must be on, and your Gmail calendar's secret iCal address entered, which is how it knows your
address. Before its first block it puts one test event on Gmail, 45 days out, and takes it off again.
If Google refuses, the digest says so and nothing else happens. `/stop` stops it, and `/status` says
how many blocks are on Gmail.

- **What Gmail gets:** your title and the times, marked private, and in live mode an event's street
  address (see Drive blocks). No other text from Family, guests or invitation emails. Your calendar's default reminders still apply to it.
- **Moved or cancelled** on Family, the block follows.
- **Edited or removed on Gmail:** a block you edit in any way (the time, a note, a guest) is left
  alone from then on. A block you remove isn't put back.
- **Part of Family unreadable:** if it can't read an event on Family, it won't remove blocks, and the
  digest says so. Delete any that are wrong.
- **School days:** set `family_school` to the Family titles that mean a school day, with `;` between
  several. Each gets a drop-off block, from 30 minutes before the start to 15 after, and a pickup block, from 15 minutes before the end to 30 after.
  A real event of yours during the trip to school (the first 15 minutes of a block) removes that block, and it comes back if the event goes. A "Busy"
  hold, or an all-day event other than a stay, doesn't count. Enter the school's street address in `family_school_address`, and an event within three hours of a run counts too if you can't drive between it and the school in time. An event with no street address is taken as nearby, and the digest says so. If a drive time can't be looked up, the run stays and the digest says so. If your Gmail calendar can't be read,
  school runs don't change and the digest says so. If one event on it can't be read, blocks already
  there stay.
- **Limit:** 100 changes a day. Past that, the digest says so and the rest go the next day.
- **What it can touch:** only blocks it wrote. Your share lets it do more than that, so to end it for
  good, remove the service account from the calendar's sharing.
- **Judging instead of title words (shadow):** `meaning_shadow` (off by default) has Claude judge what
  each Family event in the last and next 60 days means for you, a few at a time (at most 10 calls a
  run, 60 a day, $3 a month), and compares the blocks that would give with the blocks the title rules
  give. It writes nothing to any calendar. The score is one line in the add-on log, with up to 20
  differences, and the same on this page.
- **Judging instead of title words (live):** `meaning_live` (off by default, separate from
  `meaning_shadow`) makes those judgments decide the blocks on Gmail instead of the title rules and
  the two title settings. A block backed by your own answer is "Busy (...)"; kids or driving in the
  next 48 hours that it isn't sure of is "Maybe busy (...)", shown free so it never reaches work.
  When it can't tell and it matters in the next two weeks, Cain shows you one question with buttons.
  Each new block gets a card with Not mine, Wrong time and Just this once, once a later read of
  Gmail finds the block as written; if three reads don't, the card says it was written but not
  confirmed, with the same buttons. Turn it off to go straight back to the title rules. All the
  limits and safety above still apply.
- **Drive blocks (live):** an event you go to yourself, at a street address, gets its street address
  on its block (only that, never a name or note from Family, so it opens in Maps) and, with
  `home_location` set ("lat, lon" or a street address), separate "Busy (drive there)" and
  "Busy (drive back)" blocks around it. The event's block keeps its own times. Two events on the same
  day too close to go home between them get one drive straight from the first to the second. A drive
  that can't be found is left off, and the digest names the event's day and time. A place you type
  on a block makes it yours, like any other edit.

## Standing rules from before 0.5.1

Rules saved by an earlier version were never confirmed, because that step didn't exist. From
0.5.1 they stop being used until you decide. Each gets a card with its exact text, again each
week until you tap *Keep rule* or *Drop rule*. If adds were already skipping the tap, the tap
comes back.

## Changing a key later

Paste the new key (or the new set of calendar addresses) in the panel. Once there is an owner, the change is **not**
applied until you approve it on its card (15 minutes to tap). An install paired before Discord keeps its owner.

## Starting over

*Reset* in the panel (type `RESET`) forgets the keys and the owner; the ledger
stays. Uninstalling the add-on also starts over, and deletes the ledger.

## Backups

Backups include `/data` (the ledger, the keys, the app-specific password, the calendar
addresses and the last Family push). The add-on stops briefly during a
backup so the database is copied whole. After a restore, anything done after the
backup was taken is gone.

## What it never does

- Read or change anything in Home Assistant (no Home Assistant or Supervisor API).
  The Family calendar comes the other way: Home Assistant pushes it in, and the
  listener answers with a status code only.
- Change a calendar, with two exceptions, both as above: iCloud Family, and its own blocks
  on your Gmail calendar once you've entered a key. Otherwise Google calendars are read
  only, by GET, from calendar.google.com.
- Talk to any host but Discord, Cain's add-on, Anthropic, OpenAI, calendar.google.com, the iCloud
  host in the Family calendar address you entered, and, for those blocks,
  oauth2.googleapis.com and www.googleapis.com. With the school's address entered, drive times
  also use nominatim.openstreetmap.org and router.project-osrm.org, by GET, and they get street
  addresses and map points only: never a title, name or time.
- Act for anyone but the bot's owner, on his own fresh words in his DM with the bot. Messages
  from anyone else are never acted on and their text is never stored.
- Keep messages that carry rights-protected document markers. (Screening by work
  domain is built, but this release ships with no domains set, so it is not on
  yet. A later release turns it on.)
- Put a key in a log line or a URL it shows you.
