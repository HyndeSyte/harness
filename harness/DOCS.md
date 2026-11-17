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
  that makes a new card from a fresh read of the event, for your tap (a new change family). On a calendar
  whose cards were opened without the check after an install (below), Harness counts these refusals: from
  the first one there, no *Try again* is offered on that calendar, and one plain message says edits there
  can't be applied safely, naming the likely cause (the calendar gives a weak or rewritten version, an
  etag, so its safety check can't tell an unchanged event from a changed one). Any other
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
  was there and an edit of one day of a repeating event, and the calendar has passed the conformance
  item (it refused the run's own stale edit, removal and edit of one day of a series, below), a request
  for that calendar comes on a card
  that says it's waiting for the check after installing, with no *Approve*, and nothing changes. The
  first time a request is held on a calendar after an install, one message for that calendar says
  "Calendar changes on Gmail are held for now" (or Family), why (the check hasn't finished there yet, or
  what it found) and what lets them through (Cain finishing the check, your *Open cards without the
  check*, or *Test again*); further holds there aren't told one by one. While any wait, one reminder a
  day gives the count per calendar, and a held request whose day comes gets a reminder that day. A card
  offered before the install and tapped meanwhile is held the same way. Held cards don't run out. Once
  that calendar's check is done, each held change comes back on a fresh card, read again then, through
  the usual checks, for your tap: the card says how long it waited and quotes your message as every card
  does. Only an add whose day has passed meanwhile isn't offered again: a "Dropped" receipt says so, and
  nothing changes. A move or removal of an event whose day has passed comes back on a fresh card like
  any other, read again then. When more than three come back at once, one message saying how many comes first. Gmail and
  Family open separately: one can be open while the other is held. A closed gate holds every request
  except the smoke run's own steps, live run or not: your own requests, dates from your mail and Family
  adds that arrive while a run is live are held like any other, never tagged as tests and never taken
  off by the run's cleanup. Only a step Cain offers with its script (`keeper.sh fastpath smoke-step <run
  id> <step> ...`) and you start with *Start step N* is the run's, its change built from the script by
  Harness itself; a handover naming the run (`keeper.sh handover --message <id> --smoke <run id>`) cites
  your own message, so it's an ordinary request, held with your title, never tagged. If, during the
  run, a calendar refuses the safety check on an event that hadn't changed, that calendar stays held
  and you're told plainly that edits there are blocked and why, with an *Open cards without the check*
  button. That tap, or Cain's `keeper.sh fastpath gate-open gmail` (or `family`) on your say, opens that
  calendar's cards without the check, for when the run can't complete there; who did it and when is
  kept in the log, its held changes come back on fresh cards, and the paths without a tap stay off. On a
  calendar that failed the conformance item, that override also says edits there may overwrite changes
  made elsewhere between your card and your tap; on one that refused stale edits but took a stale
  removal, removals there stay held even after the override, and it says so. On one that turned down
  the check's own fresh edit, there's no override at all (it would only bring refusals): *Test again*
  runs that step once more. After an override, the first change turned down at the safety check while
  the event hadn't changed gets a "Not applied" receipt quoting your request with *Start again from now*
  (one new card from a fresh read); later ones there get no button. A calendar that passed the
  conformance item and later, in normal use, takes a write without giving the event a new version (so
  it would take a stale one too) closes again, with the same message as a failed conformance item. An
  install is each new build: the ledger keeps the version and a build identifier (a hash of every file
  the App ships: its code, the Dockerfile, config.yaml and the run scripts in rootfs, computed when the
  image is built), so a rebuild of the same version, or a change to any of those files, counts as an
  install too, and a restart doesn't. (A ledger made new, with nothing in it, counts as an install too.)
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
`keeper.sh fastpath smoke-start`: Harness issues the run's id. The run owns only its own steps, and
step ownership never rests on a model reading a message: for each one, Cain offers the step with its
script, `keeper.sh fastpath smoke-step <run id> <step> <gmail|family> <add|move|remove> <YYYY-MM-DD>
"<test title>" [HH:MM-HH:MM]` (the step a short name such as `gmail-add`; times for an add or a move).
You get a card showing that script with *Start step N*; only your tap opens the step, within 30
minutes and once, and then Harness builds the step's change from the script itself, never from your
DM, and puts it on a card for your *Approve*. Only that request (and its fresh cards) is recorded
under the run, titled as a test and judged. A handover naming the run (`--smoke`) is never the run's:
a handover only reads your own messages, so it cites a real request of yours, which goes on as an
ordinary request with your title, held like any other: a closed gate holds every request but the
run's own steps, live run or not. The run's first add is let go at once, so its answer comes late and is
read back a minute later like any lost answer: that's the late landing item. That is the only write
Harness ever lets go on purpose, and only for an add of a live run.

A run is bound to this build: it keeps the App version, the build identifier, the ledger's schema and
when it started. It
runs out after 24 hours, and stops recording at *Turn on*, at *Turn off*, at a new smoke-start or when
it runs out. It gives one *Turn on*. A run that's used, ran out, was started under another version or
schema, under another build, or is older than the install is refused by name: start a new one. Each add of the run is a
test event: its title starts "Smoke test: " and it carries the run's id as a private property (on
Gmail, the event's private extended property `harness_smoke`; on Family, an `X-HARNESS-SMOKE` line),
and the step's own nonce beside it (`harness_smoke_nonce`, or `X-HARNESS-SMOKE-NONCE`). The run keeps
the id it chose for every event it creates (both calendars take an id the client chooses), with that
nonce and its day, before the write goes out; its leftover cleanup only ever takes off those: by id,
or, when a read by that id doesn't find it (a create whose answer was lost, an id the calendar
changed), by that exact nonce, never by the run's tag alone. That search runs from the day before the
recorded day to the day after (the day is recorded in your time zone, and a step near midnight can
land on either side of it), and for a series over its whole span, to the day after its last day; a
series found that way is taken off as the series, not one day of it.

On Gmail, and then the same on Family:

1. An add: "add Pool test at 3 PM tomorrow". Done ("Added Smoke test: Pool test"), and the calendar
   shows it.
2. A move: "move Smoke test: Pool test to 4 PM". Done, and it shows at 4 only. Then *Undo* on it:
   "Undone".
3. A removal: "take off Smoke test: Pool test tomorrow". Done, and it's gone.
3a. Delete and read (done by hand, and its answer noted with the run): add a throwaway event, delete
    it in Google Calendar on the web, and read it by its id (the events API's get, from the API explorer):
    write down whether Google answers it as `"status": "cancelled"` or with 404 or 410. Harness treats a
    cancelled event as taken off since, and 404 or 410 at a fixed id it wrote as "can't tell whether it was
    added and taken off"; either way it's never added again from a tap's card. This step confirms what
    Google answers on the real calendar. On Family, the same: delete a throwaway event in the Calendar app
    and note that a read of its address answers 404.
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
   step below counts on Family; on Gmail, move one day of a throwaway weekly event).
6. The conformance item: Cain runs `keeper.sh fastpath smoke-step <run id> conformance-gmail` (and
   `conformance-family`). It covers every write kind Harness sends with a version:
   an edit, a removal and an edit of one day of a series. Harness adds its own one-off test event and its own short
   series (three days), edits each with the version it had just read (the fresh edit, which must go
   through), then sends a stale edit with the version from before that (a counter in its note, so its
   body differs from both earlier versions), a stale removal of the one-off, and a stale edit of one day
   of the series. Each counts as enforced only when the calendar gave its documented stale answer (412,
   or Gmail's 409 for that case) and a read afterwards shows the stale write wasn't applied. Any other
   answer (sign-in, a refused body, too many requests, unsupported) is unknown and keeps the gate
   closed; Cain runs the step again. Only the run's own test events are ever written this way, and
   they're taken off after. The gate opens only when all three are enforced. A calendar that takes a
   stale edit never opens its cards by itself; one that turns down the fresh edit itself (it gives weak
   versions and compares them strictly, say) is said as what was seen: Harness and that calendar don't
   agree on event versions. Either way you get one message, once per install and calendar, saying in
   plain words that Harness can't change that calendar safely and that you can edit it by hand in the
   calendar app; each request held for it is passed back in that message (and any held later, at once)
   as a line ready to copy (calendar, what, title, when), and it stays held. *Open without protection*
   (your tap only, kept in the log; Cain's `gate-open` there just sends you that message again) lets
   changes there go as a read-compare-write: each is read just before writing and compared with your
   card, then sent with no If-Match, so edits made at the same time by someone else can be overwritten
   or deleted. It opens that one calendar only: the authorisation is per calendar. Every card and
   receipt for that calendar says *Unprotected*. A calendar
   that turned down the fresh edit also gets *Test again*. This is never refused outright. One that
   refuses stale edits but takes the stale removal stays closed too, with a message saying removals
   there aren't protected; after its override, removals there stay held. The item runs again after
   every install. Once the two edits are read back and the
   conformance item passed on a calendar, its held cards come back.
   The item also records each calendar's etag strength (strong, weak, or none, from every version it
   read), and on Family it sends one PUT with no If-Match to a test event of its own and records whether
   Family took it or refused it. That test event is far in the past (1 January 2001, 3:00 UTC), with no
   reminder and the title "Smoke test: Harness write test (safe to delete)"; it's removed and read back
   gone before the result is recorded, and one that can't be shown gone is recorded as unknown. Its
   address (UID and URL) is random each run, and it's first created with `If-None-Match: *`, so it can
   only be made where nothing is, before the PUT with no If-Match. Its address is kept in the ledger until
   a read shows it gone; every start retries the removal (only of an event carrying that run's own tag),
   and one still there shows on Harness's page with how many tries so far. It's safe to delete by hand. The item
   also takes each calendar's normalisation baseline: on its own test event it writes back exactly what
   it read, reads again, and keeps which fields the calendar rewrote by itself (see below), with the
   zone names it writes (`zone_form`: as written, and as IANA names). The no-card flag stays off until both are recorded: `fastpath on`
   refuses the run by name (`gmail.etag_strength`, `family.etag_strength`, `family.unguarded_put`)
   until then.

And once, on either calendar: two days of one throwaway repeating event taken off on two cards, both
Done. The listing lag is measured from the record itself: from each write's read back by its id to
the days, read as you'd see them, showing it. It needs at least two samples on each calendar (the
steps above give more), each from 0 to 300 seconds, the most the duplicate and no-card checks allow.

Then Cain runs `keeper.sh fastpath on <run id>`. Harness builds each item from its own record: the
event ids, when each was asked and read back, the stale cards whose write was never sent, each
calendar's gate (its fenced edit, series-day edit and conformance item, or the override), each
calendar's conformance item, the two days of
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

### Weak versions, unprotected writes and a gate that closes again

Versions (etags) are compared weakly for reads (`W/"x"` and `"x"` are the same version when the card's
and the pre-write read's are compared), and If-Match is sent only when the calendar gave a strong
version: a weak one never matches under If-Match's strong comparison. Where a calendar gives only weak
versions (or none), the fence is a read-compare-write: the read just before the write is compared with
the card, the compare is logged (`read-compare-write (it gives only a weak version)`), and the write
goes with no If-Match. This narrows the window but doesn't prevent a stale write: an edit made by
someone else between that read and the write can be overwritten or deleted.

So every write sent without If-Match is labelled. Its receipt (the Done message, or Not confirmed) and
an Undo sent that way say *Unprotected*, whether the calendar was opened without protection or the
event only gave a weak version on a calendar that's otherwise protected; never a normal-looking receipt
for an unfenced write. An approval card for a calendar opened without protection, or one the check
found gives only weak versions, says *Unprotected* before your tap too. After such a write, its read
back is compared with the read just before it plus the change it meant: if any field outside the change
differs, you get a *Possibly overwritten* message naming each field with its value before and after.
An edit wholly overwritten in the moment between the read and the write can't be seen afterwards; the
*Unprotected* label is there for that. A calendar that rewrites fields of its own on any write doesn't
bring that message: the difference is compared with that calendar's baseline from the check after
installing (a no-op round trip on its test event), and only a difference matching it is left out: the
same field added with the same value; removed, only when the value removed is the one the baseline showed
removed (such as an empty description), never any value; a text field the baseline showed changed, to a
value that's the same once spacing, case, escapes and parameters are set aside. Times and dates
(`DTSTART`, `DTEND`, `RECURRENCE-ID`, `EXDATE`, `RRULE`, and all-day or timed) are never loosened that
way: they're compared by the instant or day they resolve to, whether they're all-day, and their time
zone, so someone changing an event's time zone or making it all-day is told, unless it's exactly the
zone rewrite the baseline showed. A removed time is matched the same way, by what it means (instant or
day, all-day, zone), never with its parameters set aside, and one carrying a parameter that can't be
resolved is told. Zone names that aren't IANA names (Windows ids such as "Eastern Standard Time", older
names such as "US/Eastern", and prefixed forms such as `/mozilla.org/.../America/New_York`) are mapped
to their IANA name first, so a calendar that writes one form and reads back another is never told as
someone's edit. Anything ambiguous counts as a possible lost update and is told, as is
anything else, such as someone's real edit of the same field. A field the baseline never saw (a reminder,
a repeat rule) raises nothing when it comes back as it went. The pinned stamps below stay out as before.

A calendar the conformance item passed closes its gate again only when a write that carried If-Match,
on a calendar meant to be protected, reads back with the event's content changed while its version
stayed the same; the message names that write. A calendar opened without protection, and any
read-compare-write, never closes it again that way, so there's no loop of closing and reopening. A
write that changed nothing and kept its version never closes it. The stamps a calendar rewrites on any
write never count as content, pinned per calendar: on Family `DTSTAMP`, `LAST-MODIFIED`, `SEQUENCE` and
`CREATED`; on Gmail the event's `etag`, `updated`, `sequence`, `created` and `htmlLink`. A write whose
read back doesn't show it (its version moved) still fails visibly as *Not confirmed*, and counts toward
that calendar's gate review: the count and when are kept in the gate and the log
(`calendar_gate_review`), for the next check after installing. It never closes the gate by itself.

### Before a Ship card: the migration on a copy of the ledger

Before Cain shows a Ship card for a Harness update, he rehearses the incoming build's own migration:
`keeper.sh fastpath migrate-check --candidate <path>`, where the path is the incoming build's source
tree (the `harness` App folder of a checkout of the pull request's head) or its image path (the
image's `/opt/harness`), as Harness sees it; add a ledger path first to use a ledger file other than
the live one (`keeper.sh fastpath migrate-check <path> --candidate <path>`). Harness runs the
candidate's own code in a separate, isolated Python (`python3 -m harness.migrate <ledger path>` from
that tree): it opens the ledger read only, copies it with SQLite's online backup API into a temporary
file (never a plain file copy, so what's still in the write-ahead log is copied too), checks the copy's
integrity,
runs that build's migration and install step on the copy with no calendars, deletes the copy, and
answers with what it found: the candidate's build id (computed by the candidate itself, as its image
will), the schema version, whether the paths without a tap are off (they must be), whether the gate is
set and which calendars it holds, how many *Turn on* cards are still open (none), how many rows it
touched, and how many changes left in flight it would read from the calendars on the real run. The
ledger itself is never touched. Without `--candidate`, the running build rehearses its own migration. Harness maps no folders, so a candidate path has to be one Harness itself can read (under its own
`/data`, say); where none can be put, the install step below is the backstop: the new build
rehearses itself on a copy before it moves anything.
By hand inside the App: `python3 -m harness.migrate <ledger path> [--candidate <path>]` prints it as
JSON.

The result is kept in the live ledger, keyed by the build it rehearsed, with the SHA-256 checksum of
the ledger copy it ran on and which build ran it, and `keeper.sh` writes it to the marker file
`/data/markers/harness-migrate-check.json` in Cain's App. Cain's rules need that marker, saying ok and
under 24 hours old, before a Ship card for Harness (the link itself doesn't check it yet).

### At install: the rehearsal is self-serve, and a backup comes first

When a new build starts and its migration is needed, it looks for a passing dry run of its very build
id recorded in the ledger. One counts only if it rehearsed the schema version the live ledger is at now
(each record carries the source schema version and when it ran) and is under 24 hours old; anything
else counts as none. With none, Harness runs the dry run itself, on a copy of its own ledger inside its
container (no outside path), records it, and on a pass takes the backup and migrates at once: a normal
install never waits on Cain.

Only a failed dry run leaves it waiting: nothing is migrated, calendar changes wait (no writes, and a
handover is refused saying so), and you get one message saying why, whose only button is *Run check*:
it runs the dry run again in Harness, and on a pass the records move, backup first (a second failure
says so, with a fresh *Run check*). Cain's `keeper.sh fastpath migrate-check` does the same. The
override is yours alone: `keeper.sh fastpath migrate-override` only posts you a card saying the move is
unrehearsed, why the dry run failed, and that a backup is taken first; the records move only on your
*Move them anyway* tap, once, for that build id. A tap is refused when a failed dry run for that build
is on record that the card didn't say.

While the ledger waits, the wait is never silent: the message with *Run check* is retried with backoff
until Discord takes it (one Discord refuses for good is posted again), a reminder with *Run check* goes
once a day while it waits, a handover refused meanwhile says why and whether that message reached you,
and the wait shows on Harness's page and in the `/health` answer Cain's App reads (`migration`). Neither
App has Home Assistant API access, so it isn't a Home Assistant sensor or repair issue.

The migration itself holds every other writer of the ledger off (the poller, Discord taps and the
handover service wait, and transactions already open finish first), takes the backup, and applies the
migration as one transaction: it lands whole or not at all. Work accepted before (held requests, taps
waiting to be handled, outcomes still being read) is in the ledger and goes on after. If the App is
stopped in the middle, the ledger is still at its old schema with the backup beside it. A marker
(`harness.sqlite.migrating`) spans the transaction. A start that finds it first runs
`PRAGMA integrity_check` and reads the ledger's schema version: if the move had committed before the
stop (the schema is at the last step's and the install step for the marker's build is recorded), the
marker is cleared and Harness starts normally. Otherwise the next start
doesn't try again by itself (a move that kills the App can't keep it from starting): it starts degraded,
serving its page and Cain's `/health` (both say degraded, and why), and you get one message saying the
move was interrupted, with *Run check* (rehearse and move again) and *Put them back* (restore the newest
backup). A migration that fails with an error does the same. If the records can't be opened at all,
Harness still serves its page and `/health` with status `degraded` and why, and takes nothing.

The writer hold is safe for live interactions. In Harness every ledger write is on one thread, the
controller's. Taps are never lost: Cain's link gives Discord a deferred acknowledgement and forwards the
tap; the handover service first writes it to a journal beside the records (`harness.sqlite.taps.jsonl`,
appended and fsynced), then queues it, and answers only once the controller has committed what the tap
did (or says it's still working, never a final answer before a durable write); the result then reaches
you as a follow-up. A tap caught by a stop is taken at the next start, or, if it's by then too old for
Discord (14 minutes), you're told it wasn't taken. A tap the busy ledger can't take after the bounded
wait stays queued and you're told once; nothing queued is dropped as the App stops (it's kept in the
journal or you're told). A tap that can't be written to the journal whole (the append fails, a short
write, the fsync fails) is turned down at once, never answered "working", and you're told nothing
changed. Before a tap is acted on, the journal records its intent, naming what it leads to on a calendar
by a stable identity (the change and the fixed id each add is written under, or the event a removal is
bound to); one whose intent can't be written isn't acted on and you're told nothing changed. Once what it
did is in the ledger its outcome is recorded; every journal write is checked, and one that fails is
logged and told (a tap that went through but whose outcome couldn't be written says so). A tap with an
intent and no outcome is "outcome unknown", never "not carried out". An error after the intent is
written keeps that: the tap isn't refused or struck off, its intent stays, and you're told on the tap that
Harness can't tell yet whether it went through and reads your calendar for it in about a minute. That read
runs in the running loop (and at a start, through the same code), judged by what the records in use hold of
the tap's decision as well as by the calendar: a tap whose approval or choice was never used up (the error
came between the tap being taken in and its decision being recorded) didn't run, so its card says so and
has *Go ahead*; a change whose approval was used up and which Harness's own executor is still carrying out
stays unknown in the journal, never struck, while its job isn't finished: after the schedule below it's
read every hour, and at every start, and settled only once its job reads finished. A read of the records
that fails (a database error) counts the same way: the tap is kept, you're told once that Harness's records
couldn't be read just now, and it's read again on that schedule and at every start; it's struck only once a
read answers with a finished job or a used-up choice. A change whose
approval was used up and whose job ended while the calendar reads some of it not done is a failed or
partial outcome, never "the records took it": its card names each part that isn't done; parts safe to do
again (a Gmail removal whose event is still there, or an add absent at its fixed id that the records' own
run never sent) get *Go ahead*, which reads each again by its identity and puts those on a new card for
your approval, written to the first offer's fixed ids, which are set with the new card and are the ids
its preview reads, so what it shows is what the write finds. Parts not offered again are told apart, none
with *Go ahead*, and nothing asks you to send anything again: an add whose write was sent, or may have
been (absence is ambiguous, so it isn't done again); a change that leaves nothing Harness can read (a
Family removal); and a part whose read failed. An add whose step was found in its very version also gets
no *Go ahead*: the settle record keeps that step's entry, so absence after it reads as gone since. A choice the records took and finished is said
truthfully, with no *Go ahead* (its button is used up and its receipt says what happened). A read that
can't answer is read again after exactly 1, 2, 5, 15, 30 and 60 minutes (six reads), and you're told once
when the next read is, by the time written down for it (or that it's read at the next start, when that
time couldn't be written); once the schedule runs out the card says your calendar couldn't be read, and
the outcome is recorded as unverified. That outcome is final: a tap left recorded as unverified (the
outcome written, then a stop before its card or strike) is finished at the next start, or by the running
loop, with the same card saying your calendar couldn't be read, and struck; it's never taken for a tap
Harness didn't get to. You're told a tap waits only once that note is queued, so a note that couldn't be
queued goes at the next read, or after a restart. A tap whose decision never reached the records, read
while your calendar can't be read, says so: its *Go ahead* reads first, and if your calendar still can't
be read nothing is done, you're told plainly, and the same *Go ahead* comes back on a new card that reads
again when used.

The policy split, and why: an add that never landed in Google across a restore gets no *Go ahead*,
because nothing at a fixed id can't be told apart from an event added and deleted since; a tap whose
decision never reached the records does get one, because no approval used up is not ambiguous: nothing
it leads to ran. Only an error before the intent, or a calendar's own answer turning it down,
is a refusal. A tap on a choice that writes a calendar names its identity too: *Add anyway* the fixed ids
its adds are written under (made from the receipt it came from, so the same tap taken again writes to
the same ids, and the writer reads that id before writing: a read that can't answer means nothing is
added, and a duplicate id from Google (409) or from iCloud's `If-None-Match: *` means it's already there
and nothing was written), *Undo* and the Family *Undo* each event, the version the change left it in
(Google's etag, iCloud's ETag) and the state it must read in afterwards. A read finding any other version
says it changed since and Harness can't tell, with no *Go ahead*, and the Undo writer itself sends
If-Match on that version, so an edit of yours since is refused by the calendar, never overwritten (a day
of a series whose content still reads exactly as the change left it is the one exception: another day's
change gives it a new version; that compare covers every field an Undo could write: title, times,
repeat, description, location, guests, reminders, conference details and private properties, so an
edit of yours to any of them leaves it alone). An Undo step with no version recorded for what its change
left (journaled before Harness kept one) gets no automatic undo: its receipt says so and asks for the
change you want on a new card to review, and the log notes where the old content compare would have
applied, so the smoke run sees it. A write found landed late has its version read and recorded then. *Go ahead* is offered on an allow list: only for a kind that carries a readable
identity, or one declared as changing only Harness's own records; any other kind, a new one included,
gets none, and its card says so. A refusal's outcome and its note
are written before the note is posted, and the note's delivery after it, so after a restart a refused
tap is never taken again and its note goes again only if its delivery wasn't recorded; a tap is struck
off only once its outcome is recorded and its note delivered. A tap's age is read from Discord's own
stamp in its id, bounded by the journal's own time: where the two differ by more than two minutes the
journal's is used. While the clock is flagged as behind the records the age is unknown and the tap is
reported, not taken; if that tap was on the clock card, the card is posted again. Across a restore (the
swap applied at that start) nothing written in the journal is taken by itself. For each tap that may
have reached a calendar, the calendar is read first for its effect by that identity; one it shows is
marked done, with no button (an Undo already done is said by what it leaves: the event gone, back, or
as it was). A Google event read as cancelled at its fixed id was added and deleted since: its card says so
and has no *Go ahead*, and nothing is put back. A repeating add is read by its fixed id the same way:
there is done (and left out of a *Go ahead*'s run); nothing there, or read as cancelled, is absent, with
no *Go ahead*, and it's never written back (on Family a PUT with `If-None-Match: *` to an address you
emptied would succeed). An add with nothing at its fixed id (Google answering 404
or 410 there, or an empty Family address) can't be told from one added and deleted since: its card says
Harness can't tell whether it was added and taken off, with no *Go ahead*, and it's never added again
from there. A change of several parts is read part by part, each Gmail removal by its own bound event
only: its card names which are settled, and its *Go ahead* does only the others. Which parts to leave out
is read again just before that one run and then forgotten, so a later run of the same change leaves
nothing out on an old read. Then one
message counts the rest by what's recorded (carried out before the records were put back, can't tell,
not carried out) and points at the cards below it; the newest ten each get a card that says which (a
tap whose time can't be read always gets one, marked "time unknown"), and any older ones are listed in a
second message by time and state. *Go ahead* reads the calendar again first: if the change is there it
does nothing more; otherwise the tap
goes through the usual checks on the records in use, and the write itself reads the event's fixed id
or version first, so nothing is made twice. While Harness runs degraded without its records a tap is
refused at once and you hear it through Cain's link. The tap journal is a required part of the
handover service: the App doesn't start without it. No card of Harness's names a button in its prose: where a card has one,
it says what "the button below" does. If Cain's link refuses a card all the same for telling him to use
a button it doesn't carry, the card isn't dropped: it goes once more with only the sentences the link's own
rule would refuse taken out (its imperative patterns and its label finder are mirrored from Cain's gate
rules: the verbs it looks for, labels across a line break, quoted and bold labels, every label it knows;
both sides run the same shared cases), so a sentence that merely holds the words stays; if nothing is left,
or the card's head went with them, or the link turns it down a second time, a fixed card goes instead, in
fixed words only (when it was written, whether it's about a message of yours, and that its full words
couldn't be shown), with the card's own buttons, so a card is never lost to a refusal. The refusal is recorded in Harness's log, and the link writes its own gate-report
entry. A write from any other thread while the hold is on is a bug: the tests fail on one at once, and in
the App such a writer waits in bounded slices, logging each and trying again, and gives up after five
minutes with an error rather than hang. The hold is always released, even when what it holds fails. The
checkpoint and the online backup run under the hold strictly before the migration's transaction begins,
never inside one (Harness refuses that order), so the checkpoint can't find the ledger locked.

Free space is checked before the dry run's copy and before the backup: room for two copies of the ledger
and its log plus 16 MB. The ledger is checkpointed first (`wal_checkpoint(TRUNCATE)`, folding the log in
and emptying it) and the size is the main file plus its `-wal`. Records a restore set aside
(`harness-replaced-*`) take room too, and a refusal for space says how much of it they hold. Without it nothing is copied (never a half-written file) and the ledger waits as
above, saying "there isn't enough free space for a copy of the records" with how much is free and needed.

Just before it migrates, Harness takes a restorable copy of the ledger after a checkpoint, with SQLite's
online backup API (never a plain file copy), beside it in `/data`, named
`harness-before-s<schema>-<build>-<time>.sqlite`, keyed by the source schema version and the build. The
copy is checked before anything moves: SQLite's integrity check on it, and its rows per table against
the live ledger; a copy that fails either means nothing is migrated and it waits as above. No new copy
is taken when its content checksum (computed on the backup file itself) matches the newest one's
(repeated attempts after a failure), the newest three are kept, and the oldest at each schema version is
never deleted until a later migration has succeeded and the App has run on it for a day of run time.
Run time is summed in the ledger from the monotonic clock, never the wall clock, and nothing is deleted
while the clock can't be trusted (earlier than the newest time the ledger recorded, or not set yet).
Events stamped before 1 January 2026 (written before a time sync) never count for that rule. While it
holds pruning up, Harness's page and Cain's `/health` (`migration.pruning_stalled`) name the record
that holds it (its number, kind and time), and when the clock is behind it by more than ten minutes you
get one card with *Use the clock as it is now*: your tap takes the clock as right, records up to then
stop counting for the rule, and pruning goes on. Cain's `keeper.sh fastpath migrate-clock` only posts
that card again; nothing changes without your tap. A
dry run dated later than now counts as none. The schema steps are numbered; a duplicate or conflicting
step number (a ledger that recorded another step under the same number) is refused, and the ledger waits
as above.

To restore one, by its schema version and build: Cain's `keeper.sh fastpath migrate-restore <schema>
<build>` on your say, which only posts you a card; your *Put them back* tap does it. With the App
stopped, or while it runs degraded without its records, `python3 -m harness.migrate /data/harness.sqlite
--restore <schema> <build>` does it from the command line. It takes the same kernel lock Harness holds
for as long as it runs (an exclusive `flock` on `/data/harness.lock`, beside the records on the same
volume) from finding the backup until its marker is on disk, and refuses when it can't get it (Harness
is running normally), and says so. Harness takes that lock before it reads any marker, so a start while
the command line is staging waits for it (up to two minutes) and then finds the staging whole. A
Harness running degraded because its records couldn't be opened lets the lock go (it never touches
them), so the way back doesn't need the App stopped: stage the restore, then restart the App. Either one never touches the live ledger: it checks the backup and writes only a staged
file beside it (`harness.sqlite.restore`) and then, last, its marker (`harness.sqlite.restore.json`).
All swapping is done by Harness itself at its next start, before it opens the ledger: it writes a swap
marker first, checks the staged file again (`PRAGMA integrity_check`), moves the ledger it replaces
with its `-wal` and `-shm` files to `harness-replaced-<time>.sqlite`, `-wal` and `-shm` (named as SQLite
pairs them, so the kept log stays with its file; never a stale log left beside the restored file), then
renames the staged file into place, which is atomic. Each step is durable across power loss, not only a
stop: the folder is fsynced after the marker's rename, after each of the three moves, after the final
rename and before the marker is cleared, and each finished step is recorded in the marker, so a resume
never repeats a move. A stop or a power cut between any two steps is finished at the next start (one
that fails its check there is set aside and the old ledger put back, also step by step). A move is
never made over a file that's already there, and nothing at the records' name is opened beside a
`-wal` or `-shm` it doesn't own; either one stops the start, which runs degraded and says why. The
refusal is recorded in the swap marker with the files that caused it (if that write fails, the page and
the command line say the refusal wasn't recorded, and the old marker stays whole). Each start looks at
the refusal again: once the files that caused it are gone, it clears and the swap goes on. With the App
stopped (or degraded), `python3 -m harness.migrate /data/harness.sqlite --set-aside` sorts it: what it
moves comes from the swap's own recorded steps and what's on disk, never from names in the marker, and is
only ever a `-wal` or `-shm` at the records' name that isn't theirs. A marker naming anything else (the
records' own file or log, the staged restore, a kept set, anything outside the folder) is refused by
name and nothing moves. It lists them, asks you to type yes, copies each into
`harness-set-aside-<time>-<n>/` beside the records (a new folder each time), checks the copy byte for
byte, only then removes the original, and clears the refusal, so the next start finishes the swap. A
copy or fsync that fails (a full disk, say) or a copy that doesn't match takes back what it made, the
partial copy and the folder, leaves the originals and the marker as they were, says why in plain words
and exits non-zero. It can be run again after one cut short: its progress is kept beside the swap marker
(the folder chosen and, per file, the copy's checked digest and whether the original was removed),
written whole (a temporary file, fsynced, renamed, and its folder fsynced, as every such record has been
since an earlier round), and each checked copy has its digest noted beside it in the folder too. A
progress record that's truncated or unreadable is rebuilt from those noted digests (each copy read again
and compared) and from which originals are still there, rather than stopping. A file with neither a good
copy (never checked, or no longer matching) nor its original is never dropped silently: the loss is
written into the progress record, the answer names that file, and nothing more is moved, the swap marker
and the live records left as they were. This is the command line's alone; nothing of it runs at a start.
A swap marker that can't be read (damaged or cut short) is never deleted and
nothing is moved: the start runs degraded, and the page lists the files at the records' live and kept
names, as `python3 -m harness.migrate /data/harness.sqlite --swap` does, for sorting by hand. The marker
itself is always written whole (a temporary file, fsynced, renamed, and the folder fsynced). If a start
waits the full two minutes for a restore being staged, it runs degraded, shows the wait on its page,
tries the lock again every 5 seconds and starts normally by itself once the staging is done. While
degraded, Harness posts one note to you through Cain's link, tried again after 1, 2, 4 minutes and so
on (at most 30 minutes apart) up to ten tries; if none goes, its page says "Note not delivered". The restored ledger is migrated again on that start, with rows intact, rehearsing itself as
any install does, so it doesn't need a fresh *Run check*.

Once your tap stages it, Harness is fenced and takes nothing new until it restarts. The fence is a mode,
not a held lock: any ledger write then fails at once with a plain reason, while sending messages already
queued (and marking them sent) still works, through the ledger's one outbox-only exemption (a private pass only the outbox's own method hands over: a guard against a stray flag or wrong argument by accident, not against code set on getting past it). A card with
buttons isn't sent while fenced, so no button is ever dead; a tap meanwhile gets the restart answer.
After the restart, the swap sets those records aside, and every message still waiting in them (a card
held by the fence among them, even one made in the same moment as the restart card) comes back once,
without its buttons, which belonged to the records set aside; nothing asks again for it, and one whose
buttons had already run out says its time has passed. If the restore isn't used after all, it
goes out from the records as they are, its buttons bound. The loop's
heartbeat and the clock check keep running while fenced, and the page and `/health` say fenced beside
the loop's own beat, so a stuck or stopped loop still shows as stuck. A request or a tap is answered at once that it's waiting to
restart (never queued), and one card asks you to restart the Harness
App now (Settings, Apps, Harness, Restart). The card says how old the backup is and how many held
requests, buttons not tapped yet, writes still being confirmed and changes you could still undo are in
the records it sets aside. Once the restored ledger opens, the requests that were held in the records
set aside come back to you, one message saying the records are back and then one per request, ready
to copy into the calendar app. The kept ledger is opened read-write once first to fold its log in, so a
request committed only in its `-wal` comes back too. Which have gone is recorded beside the kept files
(`harness-replaced-<time>.sqlite.postback.json`, naming each before it's posted, and the ledger records
the post in the same transaction), so a stop at any point neither repeats nor loses one. Every kept set whose own marker doesn't say done is
posted back, oldest first, so two restores in a row with the first post-back cut short bring both sets'
held requests back, once each (a post recorded in records set aside since counts only if it was
delivered from there; one recorded the older way, without its message, counts only if that set shows
the very post delivered, and is otherwise posted again, once). A kept set is pruned only once its own marker says done and the records aren't
waiting on a move; one that isn't stays, counted in the space check, and the latest is always kept. The page and `/health`
show a staged restore meanwhile. The copies beside the ledger live on the same device: a Home Assistant backup
is the off-device copy, and one is recommended before installing (the Ship job takes one first).

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

**Kinds you've said no to are skipped.** Mail of a kind on the skip list is passed over before
anything is sent to the model, matched on who sent it and its subject: no card, no calendar entry, and
the digest never mentions it. The first kind is Amazon's Subscribe & Save delivery management: the mail
must come from Amazon and say Subscribe & Save in its subject, or else where its text says what the mail
is (a header line at the top, or the first block of text before the order's items, after any greeting
on its own line such as "Hello Alex,", read on the Pi; never in a promotional footer or a quoted section,
and a first block that reads as an advert by its shape, an offer such as "save 15%" or a run of calls to
action and links, keeps the mail; one word such as "deals" or "discover" doesn't make it an advert, and
a boilerplate link doesn't count toward it: unsubscribe, privacy, preferences or opt out anywhere in its
address, help, account or manage only in its path or the words just before it, never in its domain, so a
promotional link at a domain with "account" in it still counts) before a subject like "last day to manage", "manage your delivery" or "delivery date has changed"
counts. Prime, Audible and Kindle renewals, an ordinary order's new delivery date and an order's return
window all come through ("return" counts only as a whole word, so "returning" doesn't). To skip another
kind without a new build, add it by name to `/data/mail_skip.json`, read at every pick, for example
`{"skip": [{"name": "Pet shop points", "from": ["pawsclub.example"], "subject": ["points statement"],
"unless": ["order"]}]}`: a mail is skipped when its sender contains a `from` text and its subject a
`subject` text but no `unless` word. The file is checked strictly: each entry needs a `name`, and `from`
and `subject` lists (`unless` when given) of texts at least three characters long, and nothing else. It's capped: at most 50 kinds, 20 texts in
each list, 80 characters in a text or a name. One
entry that doesn't fit, or a file that can't be read, and the whole file is ignored, the built-in kinds
still apply, and Harness's page says why. The page also counts the mail skipped so far, with the sender,
subject and rule of the latest 20, so a rule that skips too much shows.

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
  Each new block gets a card with Not mine, Wrong time and Not this time, once a later read of
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
addresses and the last Family push, and the ledger copies taken before a migration,
`harness-before-s<schema>-<build>-<time>.sqlite`). That Home Assistant backup is the copy off the
device; take one before installing. The add-on stops briefly during a
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
