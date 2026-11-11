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

Every card with buttons, and the digest, carries a **Stop** button: start nothing new
until you tap **Turn back on**, which takes its place while stopped. What it's doing,
spend this month and canary results are on the Harness page.

## If Cain's add-on stops

This add-on and Cain's check each other every minute. If Cain's add-on hasn't answered for
5 minutes, or says its Discord connection has been down that long, you get one Discord
message from here (Cain is the usual path, and it's the one that's down), and one more
from here when it's back. Until then Stop and the buttons
don't work; calendar work goes on and cards wait. Restarts and updates are shorter than
5 minutes and say nothing. The Discord section of the Harness page shows whether the
Discord link is connected, when it last heard from Discord, and this watch.

## When something it works from stops

Your mail, the Family calendar, your Gmail calendar through Google and your calendar addresses are
each watched, and the sorting of Family events too while it decides your blocks (`meaning_live`).
Something is down from the time it fails until the next time it works.

- **What only you can fix**: Gmail's app password, Family's app-specific password or the Google
  service account key turned down, Gmail wanting you to sign in on the web, or your Gmail calendar
  no longer shared with Harness. One message as soon as a second try confirms it, saying what
  stopped, since when, what it costs you, and the steps from your phone. They end on the Harness
  page (Settings > Apps > Harness > Open Web UI, under "Replace a key") and a tap on Approve on the
  Discord message that follows, within 15 minutes. If a new key is turned down too, you hear again.
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
- **The reply** gives iCloud's answer and an *Undo* button, good for 7 days. Undo deletes
  only that event, once. If someone changed the event since, Undo refuses and leaves it.

If iCloud's answer is lost, or it has a server error, the event may or may not be there.
The reply says so and asks you to check the calendar, and it doesn't retry. A failed write,
a rejected password or a calendar whose name isn't Family is said in the thread, and stays
in `/status` and the digest until a write succeeds. `/stop` blocks adds and undos; after
`/resume`, send the event again.

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

If you tap the button to stop checking, adds go straight in without the Approve tap, up to
5 a day. Anything with a warning still gets a card, and so does any add at a start time
another add already has, or from a message that looks pasted (a quoted line, an email's header
lines, a forward, a link), any message in the 30 minutes after one, or a message sent as a reply.
A long or several-line message is no sign of a paste: you dictate. You still get the receipt and the Undo,
`/stop` still works, and `/status` and every digest say adds are skipping the tap. Nothing
else changes.

**Going back.** `/checkadds` brings the tap back at once. It also comes back by itself, and
the thread says why, after an undo, a failed or unknown write, an add iCloud gave no version
tag for (so no Undo), a change to the calendar address, Apple ID or password, a change of
policy or model, or a stored rule that never had your tap. An add already queued when the tap comes back isn't written, and the thread
says so. Going without it again takes a fresh full count. *Reset* on the add-on page ends all of this, along with the keys and
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
- **A tap only when the words may not be yours, or the change is a big one**: a message that
  looks pasted (a quoted line, an email's header lines, a forward, a link, a phone number, words
  written to you), a reply to one, an edited or forwarded message, a note from Cain; a new length
  you didn't give, three or more events off at once, or ending a series. The card says what will
  happen, in plain words; your tap's reply says it again.

## Dates from your mail

With the `mail_dates` option on, dates in your mail go on your Gmail calendar. Deadlines, last
days, renewals and the like are free all-day entries with no reminder, so nothing reaches work. An
appointment the email gives a time for is a real appointment: it's busy, so work and Family see it,
at its time with your usual reminder, and at the street address that email gave, or that another
email about it gave (the same sender, day and time). Timed appointments already written free are
made busy, their own emails are looked up once for an address, and the next digest names them. A
rescheduling email moves the entry, with its own address. An entry you've changed is yours and
left alone.

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
  Each new block gets a card with Not mine, Wrong time and Just this once. Turn it off to go straight
  back to the title rules. All the limits and safety above still apply.
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
