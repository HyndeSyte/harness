# Harness

A small deterministic controller that owns one private Telegram thread. You write;
Claude (and, later, GPT) answer through it. The models never hold a credential and
can't change anything: at this stage the harness has **zero effects**.

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
- Keeps corrections as typed rules ("keep drafts short") with an *Undo* button.
  `/rule` lists them.
- Sends a short digest every morning (from the configured start date): *Clear*,
  *Decision needed*, or *Attention needed*, with what failed and since when, then
  today's calendar. If a calendar couldn't be read, the digest says so; it never
  shows an unread day as empty. Overlapping events are marked.
- Before the start date the digest is still written every morning, just not sent.
  The last one is shown on this add-on's page, so you can check it against your
  calendar.
- Runs a daily canary through Claude and GPT and reports if either fails.

It can't send email, book, buy, delete or schedule anything. Effects arrive one at a
time in later stages, each with a card you approve by tapping.

## Commands

| | |
|---|---|
| `/stop` | Kill switch: start nothing new until `/resume`. |
| `/resume` | Undo `/stop`. |
| `/cancel` | Cancel everything pending. |
| `/status` | What it's doing, spend this month, canary results. |
| `/rule` | Your standing rules. |
| `/undo` | Retire the newest rule (`/undo R1a2b3c` for a specific one). |

## Calendar

The harness reads each calendar through its secret iCal address, every 30 minutes
and again just before the digest. That address can only read; nothing here can
change your calendar. Treat it like a password: if it leaks, use *Reset* next to it
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

## Changing a key later

Paste the new key (or the new set of calendar addresses) in the panel. After pairing, the change is **not** applied until
you approve it on a card in Telegram (15 minutes to tap).

## Starting over

*Reset* in the panel (type `RESET`) forgets the keys and the pairing; the ledger
stays. If Telegram itself is unreachable, uninstalling the add-on also starts over,
and deletes the ledger.

## Backups

Backups include `/data` (the ledger, the keys, the calendar addresses and the
last Family push). The add-on stops briefly during a
backup so the database is copied whole. After a restore, anything sent after the
backup was taken is gone; if the gap is longer than a day, the thread says
continuity is unknown.

## What it never does

- Read or change anything in Home Assistant (no Home Assistant or Supervisor API).
  The Family calendar comes the other way: Home Assistant pushes it in, and the
  listener answers with a status code only.
- Change your calendar. It reads calendars only, by GET, from calendar.google.com.
- Talk to any host but Telegram, Anthropic, OpenAI and calendar.google.com.
- Listen to anyone but the paired account, in its private chat. Messages from
  anyone else are dropped and their text is never stored.
- Keep messages that look like work content (rights-protected documents, configured
  work domains).
- Put a key in a log line or a URL it shows you.
