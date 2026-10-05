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

Backups include `/data` (the ledger and the keys). The add-on stops briefly during a
backup so the database is copied whole. After a restore, anything sent after the
backup was taken is gone; if the gap is longer than a day, the thread says
continuity is unknown.

## What it never does

- Read or change anything in Home Assistant (no Home Assistant or Supervisor API).
- Change your calendar. It reads calendars only, by GET, from calendar.google.com.
- Talk to any host but Telegram, Anthropic, OpenAI and calendar.google.com.
- Listen to anyone but the paired account, in its private chat. Messages from
  anyone else are dropped and their text is never stored.
- Keep messages that look like work content (rights-protected documents, configured
  work domains).
- Put a key in a log line or a URL it shows you.
