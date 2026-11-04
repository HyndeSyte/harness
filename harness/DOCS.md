# Harness

A small deterministic controller that owns one private Telegram thread. You write;
Claude (and, later, GPT) answer through it. The models never hold a credential and
can't change anything themselves. At this stage the harness has **one effect**, off
until you turn it on: adding an event to the iCloud Family calendar.

## Set up (about 20 minutes, once)

1. **Install** this add-on and start it. Leave *auto-update* off: an update to this
   add-on is a change you should see first.
2. **Open the Harness panel** (sidebar, or *Open web UI* here). The first Home
   Assistant user to save settings becomes the only one who can change them.
3. **Paste the keys**, each into its own box, then *Save*:
   - the Telegram bot token from @BotFather;
   - an Anthropic API key, with prepaid credit and auto-reload off;
   - an OpenAI API key, with prepaid credit;
   - optional: your calendars' **secret iCal addresses**. In Google Calendar on a
     computer: Settings, pick the calendar under *Settings for my calendars*,
     *Integrate calendar*, copy *Secret address in iCal format*. Paste several into
     the same box with a space between them (up to six).

   Keys are stored only in this add-on's private storage (`/data`), never in add-on
   options, and are never shown again.
4. **Pair:** the panel shows a link. Open it on your phone and tap *Start*, or send
   the `/start` code it shows to your bot. Only the account that sends the code
   becomes the owner; the code works once and expires in 15 minutes.
5. Make sure Telegram **two-step verification** is on for your account.

## What it does now

- Answers and drafts when you write. Each reply ends with a short job id; every job
  ends in a receipt in its ledger.
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

## Commands

| | |
|---|---|
| `/stop` | Kill switch: start nothing new until `/resume`. |
| `/resume` | Undo `/stop`. |
| `/cancel` | Cancel everything pending. |
| `/status` | What it's doing, spend this month, canary results. |
| `/rule` | Your standing rules. |
| `/undo` | Retire the newest rule (`/undo R1a2b3c` for a specific one). |
| `/checkadds` | Family calendar adds need your Approve tap again, at once. |

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
   like the other keys and never shown again. After pairing, enter one at a time and
   approve each on its card in Telegram.

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
another add already has, or from a message over 200 characters or with several lines, any
message in the 30 minutes after one, or a message sent as a reply, since that may be pasted text. You still get the receipt and the Undo,
`/stop` still works, and `/status` and every digest say adds are skipping the tap. Nothing
else changes.

**Going back.** `/checkadds` brings the tap back at once. It also comes back by itself, and
the thread says why, after an undo, a failed or unknown write, an add iCloud gave no version
tag for (so no Undo), a change to the calendar address, Apple ID or password, a change of
policy or model, or a stored rule that never had your tap. An add already queued when the tap comes back isn't written, and the thread
says so. Going without it again takes a fresh full count. *Reset* on the add-on page ends all of this, along with the keys and
the pairing.

**Alerts.** Tested on a real phone: an add alerts family phones that have notifications on
for the Family calendar. The app can't turn that off. Each phone's own Calendar settings can.

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
- **One Gmail calendar:** with two Gmail addresses entered it does nothing, because it can't tell
  which is yours.

Each add, move and removal alerts family phones that have notifications on for this calendar.

## Links from instrument cards

A card can carry a link that opens this chat with the card's title, so you can say
what happened or what you want done. The link only opens the conversation. In a
Home Assistant template, with the card title in `title`:

```
{%- set ns = namespace(t=title[:46]) -%}
{%- for i in range(46) -%}
  {%- if (ns.t | base64_encode | replace('=','') | length) > 62 -%}
    {%- set ns.t = ns.t[:-1] -%}
  {%- endif -%}
{%- endfor -%}
https://t.me/YOUR_BOT?start=c1{{ ns.t | base64_encode | replace('+','-') | replace('/','_') | replace('=','') }}
```

## Standing rules from before 0.5.1

Rules saved by an earlier version were never confirmed, because that step didn't exist. From
0.5.1 they stop being used until you decide. Each gets a card with its exact text, again each
week until you tap *Keep rule* or *Drop rule*. If adds were already skipping the tap, the tap
comes back.

## Changing a key later

Paste the new key (or the new set of calendar addresses) in the panel. After pairing, the change is **not** applied until
you approve it on a card in Telegram (15 minutes to tap).

## Starting over

*Reset* in the panel (type `RESET`) forgets the keys and the pairing; the ledger
stays. If Telegram itself is unreachable, uninstalling the add-on also starts over,
and deletes the ledger.

## Backups

Backups include `/data` (the ledger, the keys, the app-specific password, the calendar
addresses and the last Family push). The add-on stops briefly during a
backup so the database is copied whole. After a restore, anything sent after the
backup was taken is gone; if the gap is longer than a day, the thread says
continuity is unknown.

## What it never does

- Read or change anything in Home Assistant (no Home Assistant or Supervisor API).
  The Family calendar comes the other way: Home Assistant pushes it in, and the
  listener answers with a status code only.
- Change a calendar, with one exception: adding an event to iCloud Family, and undoing
  that add, as above. Google calendars are read only, by GET, from calendar.google.com.
- Talk to any host but Telegram, Anthropic, OpenAI, calendar.google.com and the iCloud
  host in the Family calendar address you entered.
- Listen to anyone but the paired account, in its private chat. Messages from
  anyone else are dropped and their text is never stored.
- Keep messages that carry rights-protected document markers. (Screening by work
  domain is built, but this release ships with no domains set, so it is not on
  yet. A later release turns it on.)
- Put a key in a log line or a URL it shows you.
