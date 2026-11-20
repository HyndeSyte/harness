# Cain

A Claude Code session that stays running on this box and answers your private
Discord bot, with your Claude connectors. It uses Anthropic's Discord channel
plugin (research preview) and your Claude plan; no API key.

## Set up (once)

1. Install the App and leave auto-update off. In its Configuration, set
   `owner_user_id` to your Home Assistant user id (see **Who can open the panel**),
   then start it.
2. Open the **Cain** panel. It shows the Claude Code session.
3. Sign in to Claude when it asks (the link opens in your browser; paste the code back).
4. Type `/discord:configure` and your bot token. Then `/discord:access pair <code>`
   after you DM the bot, and `/discord:access policy allowlist`.
5. Type `/exit`. The session starts again in 5 seconds with Discord connected.

## What Cain reads in Discord without asking

Cain reads the files you send him (`download_attachment`) and your DM's recent history
(`fetch_messages`) without a prompt, and only in your DM with the bot: a hook refuses
any other chat. Both also stop, with a line in the App's log at start, unless
`/discord:access` is set to the allowlist with exactly one user (you) and no groups, and
unless the Discord plugin is the pinned, reviewed one (`/opt/cain/discord/pin.json`).
Files he downloads land in the plugin's inbox; the App deletes them after 7 days, and
the oldest first whenever the inbox passes 200 MB.

Only one place may run the bot at a time. Stop any other session using the same
token first, or both will answer.

## Who can open the panel

The panel is a live terminal into Cain's session, so it opens for one Home Assistant
user only: the one whose user id is in `owner_user_id`. Home Assistant tells the App
who is signed in, and anyone else gets Forbidden. While `owner_user_id` is empty, the
panel answers Forbidden to everyone, you included. The App's log says which at each
start. This needs Supervisor 2026.10.3 or later (Settings, About).

It keeps other users out, not other Home Assistant admins: an admin can change
`owner_user_id`.

To find your user id, turn on **Advanced mode** in your user profile. Then go to
Settings, People, **Users** and open your user: the id is the 32 letters and digits
shown there. Put it in `owner_user_id` in this App's Configuration, save, and restart
the App.

## Security watch

Cain's App keeps an eye on what it can see of the system's health, and Cain brings you
anything that needs you in his morning update, one thing at a time. Nothing here acts on
its own.

- **Outside heartbeat** (`heartbeat_url`, empty by default). Make a free account at
  Healthchecks.io (or a service like it), add a check with a 5 minute period, and paste its
  ping URL into `heartbeat_url` in this App's Configuration, then restart the App. The App
  pings it every 5 minutes and says so at once when it stops on an error; the service emails
  or pushes to you itself when the pings stop, so a dead Pi reaches you without going through
  the App. Each ping carries only how long the App has been up. The URL is not logged, not in
  any child's environment (only the heartbeat's own process has it, and the stop ping reads it
  through curl's standard input, never a command line); it is stored only in the App's options,
  which is where Supervisor keeps every option, and that is fine. Cain's own Claude session can
  read that options file too, so a compromised session could read the URL: the risk that a leaked
  URL masks an outage or fakes a failure includes that case. Keep it like a key, and make a new
  one in Healthchecks.io if you ever think it leaked. Give the check a grace period of 10 to 15 minutes, so
  one late ping doesn't page you. A second check, pinged only while every liveness check of Cain passes,
  is `probe_heartbeat_url` (**What 0.14.0 does**, below).
- **Review spend.** The morning check-in has yesterday's spend per review seat and the month
  so far against each cap, and flags a day that jumps (over 3 times the week before and at
  least $1, once the seat was used on at least 3 of those 7 days; or over a fifth of the month's
  cap): the cheapest sign of a stolen key or a loop. It also says when the month so far, at its
  rate, would pass a seat's cap. A seat at its monthly cap runs no reviews until the month turns.
- **Key ages.** The App notes the day it first observed each key or token it holds (by a hash
  of it, never the key itself) in `/data/keys.json`. The morning check-in names a key within 14
  days of an expiry noted for it (`/opt/cain/keeper.sh key-expiry <name> <YYYY-MM-DD>`), and,
  on Mondays, one with no expiry noted that has been the same for over 90 days. A key that never
  expires by design (the link's deploy and Ship keys) can be acknowledged until a date
  (`/opt/cain/keeper.sh key-ack <name> <YYYY-MM-DD>`), and its line stays quiet until then.
- **Links.** Messages from Cain's bot no longer unfold link previews: a reply of Cain's with a
  link goes out through the App with the preview off from the start. A link that isn't plain
  https on its usual port, points to a bare IP address, a punycode host or a link shortener,
  has a user name or password in it, or whose text names another site than where it leads, is
  held for him to rewrite. The short list of sites Cain usually cites is the known hosts, noted
  not blocked: a link to an unknown host is never held, it goes out as usual and is only noted
  in the App's gate report ("unknown host"), apart from the report's "preview flag refused"
  lines (Discord refused the no-preview setting on a card update, which then went without it).
  While the App's link is restarting, a reply of Cain's with a link goes out through Discord's
  own plugin rather than wait, noted in the report as "link down: preview not suppressed at
  post", and its preview is turned off once the link is back.

## Cards and questions

- Cain asks one question at a time. The next one comes when you answer.
- Each card names what it's about (like "P08 Q2") and its buttons answer exactly that.
- Once a card stops mattering its buttons come off, and it says why: "You answered:
  Filed", "Expired" or "Replaced by a newer card". Cain's questions and Ship cards last
  until the next morning check-in (7:10 AM, at least two hours away); a Ship card also
  goes when its pull request changes or closes. One for a change that's already in main
  stays: your tap on it starts the install.
- Tapping an old card does nothing, and says so.
- The card shows what you tapped. When a tap needs words from Cain, they come as a reply
  to that card.
- Stop is red wherever it is.

## Words that reach you

Rules in the App check what reaches you: no em dashes, Apps not add-ons, nothing hidden
behind "and 3 more", no commit or job ids or ISO times, no button named that the
message (or the card Cain's reply answers) doesn't have, and a "Reviewed:" line from
Cain only as the review service gave it, word for word. "add-on" is fixed as it goes
out. Every em dash of Cain's is held back for him to rewrite, never fixed: only he
knows whether he meant a break (a comma or a new sentence) or a range ("to" or
"through"), and a comma in its place can turn a range into a list. Anything else is
held back for Cain to rewrite before you see it too.
If he's held back twice within 10 minutes, his third try goes out as it is, so the
rules can never silence him, and he hears so. The calendar specialist's cards are
never held back, since a held approval or Undo would be lost to you: their wording is
fixed, but an em dash becomes a comma only between plain words; one near a number, a
day, a month, a time of day, a symbol, a single letter or a link is left as it is, and
Cain hears about it and anything else. Cain can edit only his own replies. A log on the Pi, in Cain's own folder, keeps what the rules caught, as short
excerpts in which a link of any kind, with "https://" or without, or an IP address with
a path, is only its site. After an update that changes
the rules, the App reads back over your DM once with them, posting nothing, and Cain
files what they found, the specialist's kept em dashes counted apart from what would be
held back. Nothing for you to do.

## Stop

The Stop button (on the morning message, the calendar digest and the calendar
specialist's notices) stops what would start next: the calendar specialist, Cain's
Build and Ship jobs, his Ship cards and outside reviews, and nothing lands in main. A
job already running finishes. The notice says what stopped, and the morning message's
button becomes Turn back on. Only your tap turns it back on, and only from a card
that's still current: a tap on an old card does nothing and brings a fresh notice whose
button works. An older notice loses a button that no longer does what it says ("Turned
back on since."). Cain has no button or command for it. While it's stopped, Cain can
still answer you and keep the record.

One red Stop is always near the bottom of your DM. It sits on the newest plain message
from Cain or his App, one that asks nothing, and never on a card that asks something,
so it's never next to Ship, Start, Approve or Undo. It moves down only when none of the
last 5 messages has a Stop (the morning message and the calendar specialist's cards have
their own), and Discord shows "(edited)" on the messages it moves between. If Discord
doesn't answer, the move is tried again after 1, 2 and 5 minutes, then every 10; a
message Discord refuses it on three times is passed over for the newest plain one among
the last 5, and nothing is posted just to carry it. While everything is stopped it comes
off, and Turn back on stays near the bottom instead: on the morning message and the
stopped notice, which is posted again when it's out of reach, at most once an hour, or
10 minutes after the last one once you write. If none is up anywhere, it's posted each
minute until one is, also when the App can't read whether things are stopped, which it
counts as stopped. After Turn back on, the notice's own Stop is the only one near the
bottom; once newer messages push it out of reach, the Stop moves down to the newest
plain message and comes off the notice.

## Ship

`main` is what Home Assistant installs, and it's locked on GitHub so that only Cain's
App can change it, with a key of its own (a deploy key) that never leaves the Pi. Your
Ship tap lands that one pull request at that one commit in `main`, right then: the App
checks it's still open and at that commit, that its tests passed, and that nothing else
landed meanwhile, then puts exactly that commit on `main`. The card says "Shipped" or
why not. If GitHub doesn't answer, the card says it's waiting, and it lands by itself as
soon as it can, for up to 2 hours. While everything is stopped, nothing lands, and a
Stop after your Ship tap ends that tap for good, even once you turn things back on.

Then Cain installs it: his Ship job needs your tap, signed by the App for that pull
request and commit and good for 2 hours. A tap from before a Stop no longer counts.

Installing goes through Claude's Home Assistant connector. Cain checks Home Assistant
answers before he shows you a Ship card and again before the install. If it doesn't,
he waits and checks again every 15 minutes, and goes ahead once it does. Only if the
connector needs you to sign in again do you get one message, with a button that opens
Claude's connector settings. If your Ship tap ran out meanwhile (2 hours), a new Ship
card comes once Home Assistant answers.

A Ship card is built by the App, not by Cain. Its question says what your tap installs
("Ship Cain 0.11.0?", or that nothing installs). A line from GitHub gives how many
commits and files it has, whether it touches the parts that matter most
(Cain's link, his hooks, permissions or rules, Ship and Stop, GitHub's workflows, an
App's image, the release rules), and whether its checks passed; a change whose checks
failed gets no card. The last line is the outside review's verdicts as the review
service recorded them, for a review of the change as it is now, with a note that the
reviewers read Cain's summary of it, not the code; or "No outside review attached." Cain's own line says only what you'll notice. Cards and Cain's messages never
show item codes.

Both keys are kept by the App and left out of Home Assistant's backups. Cain's tools
are barred from them, and once his session runs as its own user (the next step) he
can't reach them at all. Once a day the App checks that GitHub still knows its deploy
key, and Cain is told if it doesn't.

## If the calendar specialist stops

Cain's App and the Harness App check each other every minute. If Harness hasn't
answered for 5 minutes, you get one Discord message from Cain's App, and one more when
it's back. If it's still down after 30 minutes, one more line says how to restart it
(Settings > Apps > Harness > Restart). If Cain's App is the one that stops, or its
Discord connection stays down, Harness tells you itself, the same way. Restarts and
updates are shorter than 5 minutes and say nothing.

## Outside reviews (once)

1. ChatGPT, for the OpenAI reviewer: in ChatGPT, Settings, Security, turn on device
   code sign-in for Codex. Then on the Cain page tap **ChatGPT sign-in**, tap Start,
   copy the code, open the link and enter it. It stays signed in.
2. Keys, in this add-on's Configuration (hidden fields, never shown or logged):
   `gemini_api_key` (Google AI Studio, prepaid, auto-reload off),
   `perplexity_api_key` (Perplexity API, prepaid, auto-reload off),
   `anthropic_api_key` (Claude Console, in the organization linked to your Claude plan,
   so it uses the plan's monthly API credit). Save and restart the add-on.
3. Caps: `review_limit_usd` per review; `gemini_monthly_usd`, `perplexity_monthly_usd`,
   `anthropic_monthly_usd` and `codex_monthly_runs` per month.

A seat with no key or sign-in is simply off; Cain is told once, with the fix.

The sign-in, token and allowlist live in this add-on's private storage (`/data`),
which is included in Home Assistant backups.

## Cain's own user (since 0.12.0)

Cain's Claude Code session runs as its own user, `cain`, not as root. The App's keys, the
Discord bot's token and the Supervisor's token stay root's; the Discord plugin's server runs
as a third user, `discord`, behind a broker that checks every send (the message gate). His
rules are Claude Code's managed settings, under `/etc/claude-code`, installed from the image
and checked at every start. The whole design, and its review, is in the record:
`projects/org-v2/c1-plan.md`.

The move happens once, at the first start after the calendar App signs its requests (the
calendar App 0.24.0) and the App's alarms to your phone are shown to work (below): the App
restarts itself, checks the new setup on the Pi, and only then switches (`/opt/cain/c1/cutover.sh`, with its journal in `/data/c1`). Until then Cain runs as
0.11.0 did. After the move there is no way back to root but restoring the backup taken before
the update. `/data/trust/c1check.json` holds the check that runs as `cain` at every start.

### If Cain stops

Nothing of Cain's runs unchecked, and no stop is silent. The App stops him when a check of
his own user finds a breach, when the move stops part way, when his start state is damaged,
or when its safety setup doesn't check out at start; it pauses him (not a breach) when that
check can't finish, and tries it again every 10 minutes until it does. If his session keeps
ending soon after it starts, the App keeps starting it again, and says so at the third time.
If a question waits on his screen, where no one answers it (one of Claude Code's own, or his
own asked there by mistake), he can't take a message until it's answered: the App presses Esc
after 5 minutes (15 for what looks like a sign-in or his folder's trust question, yours to answer
on the panel if you're at it), and if that doesn't close it, starts his session fresh 5 minutes
later (at most once an hour, and he's told to read your messages he may have missed). You hear
only when that can't clear it (a question back within the hour of a fresh start, three closed
with Esc within an hour, or a step the App can't keep track of), and it comes down once his
prompt has been back 5 minutes. A draft left in his input box (not the App's own), unchanged
for 15 minutes, is saved in his folder and cleared, and a screen the App doesn't know is saved
and his session started fresh; he's told each time.
The App types your taps and his check-ins into his session only after that session has passed
its check of his own user (at every start, and every start is the App's: when Claude Code ends,
his session ends and the App starts it again), only at his prompt, empty and steady, and it
presses Enter only once what it typed sits whole in his input box. Each line it types carries its
own random mark, and leaves its queue only once that mark shows in his session's transcript or
on his screen above his input box: a question that takes the Enter leaves the line to go in later,
once, and a line that can't be known in or not is never typed again as new (he gets it as a file,
told to check first). A text too long or unusual to type goes as a file in his folder, the line
typed naming it. A tap that can't go in waits, never lost, and check-ins that miss their hour
are named in the next one, however many. If nothing goes in for half an hour while something
waits (his screen not busy), or for two hours in all, or a draft or a screen the App doesn't know
stays half an hour, you hear "Cain isn't getting messages", once, and when it's back; a sign-in
waiting half an hour that no sign-in alarm told you of gets "Cain is waiting at a sign-in", with
the way to sign in.
If a try of the move fails, he keeps running the old way (after a restart of the App, when the
try ran as his user) and the App says so. Each time, the App tells you itself, from outside his
session (`/opt/cain/notice.sh`), what happened and the way back:

- in Discord, from his bot, once;
- as a push to your phone, through Home Assistant, again each day until it's fixed, and
  replaced (with "Cain is back") once he has run two minutes and passed his check (for a
  question on his screen, once his prompt has been back 5 minutes). It goes to your phone
  only: no Home Assistant notification, which everyone in the house would see.

Alarms are kept apart by what they're about (whether he's running, whether his session keeps
ending, whether his move went through, whether a question keeps coming back on his screen,
whether what the App types goes in, whether its alarms reach your phone), so one never takes
down another.

The Home Assistant side is one automation with a webhook trigger. The App has no Home
Assistant API access, on purpose: the Supervisor's route to a notification would give every
process of the App the run of all of Home Assistant, and this webhook can only pass an alarm on
to your phone.
Its id is a long random one (32 to 128 letters, digits, `-` or `_`) in this App's
`notice_hook` option, which only the App's root and Home Assistant's admins can read, never
Cain's own user: an id he could work out would let him send or take down an alarm. Until it's
set, the alarms go to Discord only, and those still standing reach Home Assistant once it is
(the App reads it at its next start). The App also posts a probe (`state: test`) daily, and
at once when the hook is set or changed, which notifies no one: the automation notes its time
in a helper. The App can't read Home Assistant, so it asks Cain to read that helper through his
read-only connector and write what it says into his folder, and checks it against the probe:
moved, the channel counts as working (the move to his own user waits for that); read and not
moved, you hear it from his bot ("Cain's alarms reach you here only"), and Cain files it for a
fix. No one needs to check it by hand.

```yaml
alias: Cain App alarms
mode: queued
max: 20
triggers:
  - trigger: webhook
    webhook_id: <the notice_hook id>
    allowed_methods: [POST]
    local_only: true
actions:
  - choose:
      - conditions: "{{ trigger.json.state == 'test' }}"
        sequence:
          - action: input_datetime.set_datetime
            target: {entity_id: input_datetime.cain_alarms_checked}
            data: {timestamp: "{{ now().timestamp() }}"}
      - conditions: "{{ trigger.json.state in ['on', 'clear'] }}"
        sequence:
          - action: notify.mobile_app_<your phone>
            data:
              title: "{{ trigger.json.title }}"
              message: "{{ trigger.json.message }}"
              data:
                tag: "cain_app_{{ trigger.json.group }}"
                push:
                  interruption-level: "{{ 'time-sensitive' if trigger.json.state == 'on' else 'active' }}"
```

The tag is what lets "Cain is back", or a newer alarm about the same thing, replace the one on
your phone. `input_datetime.cain_alarms_checked` is a date-and-time helper. An alarm raised while Home
Assistant can't be reached is sent once it can; one that clears while it can't stays to be
taken down. Home Assistant answers every webhook post alike, found or not, so the probe's time
in the helper is the only proof the channel works end to end, and the App has Cain read it back
each time (above): after an update, set `notice_hook` and restart the App if it hasn't restarted
since; the probe and its readback follow by themselves.

**The way back** (the alarms say which applies): when he's stopped for a moment, nothing: the
App restarts itself. Where an alarm says to (his session keeps ending, a question waits on his
screen, messages don't go in, or a stop at start that a restart may clear), restart the Cain App
(Settings, Apps, Cain, Restart). For a hard stop (first after a restart where the alarm says so),
or a pause that lasts, restore two backups from just before the update, Cain's first and then the
calendar App's (Settings, System, Backups). Either order is safe: neither App drops a card
while the other is on its old version, it waits. After a restore, the calendar App may send
again a card it sent after its backup was taken; the newest card is the one to answer.

## What 0.14.0 does: liveness alarms

The outside heartbeat above says the App is alive. That is not the same as Cain answering: on
Nov 19 his session restarted every two and a half minutes for about six hours while the heartbeat
kept saying alive. 0.14.0 adds alarms for that. It only alarms: nothing in it restores or rolls
back anything, it has no Supervisor access, and no switch.

- **Liveness checks, every 5 minutes**, with no model call, from a part of the App outside Cain's
  session: his Discord plugin is running, his session is there, the App's own Discord connection is
  up and acknowledged in the last 3 minutes, and something the App typed reached his session since
  the last check-in over an hour old. Two failed passes in a row alarm, once for the stretch, with
  its all-clear when a pass goes through. A sign-in on his screen alarms "Cain needs sign-in", and
  the model's API errors on his screen "The model's API isn't answering", instead of a failure.
- **The hourly liveness check of his session**: once an hour the App hands his session one fixed
  line on his Discord channel and he must answer it with a fixed reply. It shows his session takes a
  turn. It never reaches Discord or you, and costs a few short turns of your Claude usage a day. It
  waits while a turn is at work and for 5 minutes after a message of yours reaches him, and is asked
  at the next 5-minute pass instead, so it never cuts in on you. A long turn doesn't count against
  it: while his screen is at work, the 20 minutes he has to answer stretch, up to an hour more. The
  wait has a cap: once the line has been held back for 2 hours, it goes in anyway. A turn at work for
  2 hours without a break also raises "Cain's turn has been running for N minutes", once for that
  stretch, and it comes down when the turn ends. The 5-minute checks above never wait on a turn.
- **Plainly: these are liveness checks.** They show his parts run, not that he answers you. They
  can say alive while your messages are lost. A real round trip (a message of yours seen reaching
  his session) is a later item; this release has none, and the App reads nothing of your messages
  (only the time one came in, for the wait above).
- **The probe's second heartbeat check**: set `probe_heartbeat_url` to the ping URL of a second
  check at your heartbeat service (Healthchecks.io: a check with a 5 minute period and a 15 minute
  grace). The App pings it only after a pass where every liveness check passed, so when his parts
  stop, or the Pi or the App is down, the pings stop and the service alarms your phone itself. The
  URL is read only by the probe's own process, never logged, never on a command line, and never
  reaches Cain's session.
- **Your Stop doesn't touch any of this.** Stop stops jobs, cards and merges, not Cain's session:
  he keeps running and answering through a Stop, so the 5-minute checks, the hourly line and both
  heartbeat pings go on as usual, and a failure during your Stop alarms like any other. Only the
  App's own stopped mode silences the liveness alarms and the probe's pings: when the App itself
  stops his session on purpose (a failed safety check of his own user, for example), it has already
  told you why with its own "Cain is stopped" notice. That is rare, and always caused by the App.
- **Repeated early exits of his session**, counted in `/data`: every start of his session is
  written there with how the run before it ended, from what root alone saw: the first start in a
  container ("boot"); a stop the App's start script asked for that very run ("asked": root's mark,
  written before the session ends, naming the run the start script holds in memory, never guessed
  from an exit code or a signal); or how long the run lasted to when the start script saw it gone.
  A run that ended unasked within 5 minutes of its start is an early exit, whatever exit code it
  left. A run with no recorded exit and no valid asked mark (the start script was itself restarted
  meanwhile, or the run died before its exit handlers ran) is an unseen end, whatever the gap
  between the two starts. More than 3 early exits in 30 minutes is "Cain's session keeps exiting early", on
  your phone through Home Assistant and in Discord; it comes down once the count is back under.
- **Unseen ends** have their own windows: more than 3 in 30 minutes (a tight loop, as early exits),
  or more than 6 in 60 minutes (a slow one), is "Cain's session keeps restarting". Its text says the
  restarts were seen but not the exits, so it is a cadence, not a confirmed crash; it never counts as
  an early exit. Within a day of an update it carries the update line too, since an early crash
  before the exit handlers run looks unseen.
- **Repeated late error exits of his session**: an unasked end after the 5-minute mark with an
  error code is counted apart (Cain's own user can end his own session, so these never count as
  early exits). More than 4 in 60 minutes is "Cain's session keeps ending on its own". Its text names
  the model's API or the network as possible causes.
- **What each of these alarms says**: the count and its window, the last exit code root kept, and,
  when there is one, the last line of his session's log, after "session log says:" (plain characters
  only, links taken out, at most 60 characters; the log is opened without following a link, and read
  only when the open file is a plain file with one name, owned by root or Cain). Outside a day of an update, that is all: nothing about updates or backups.
- **Repeated starts of his App's container**, counted in `/data` too, once per container. More than
  3 counted in 30 minutes is "Cain's App keeps restarting". Not counted: a start after a stop the
  Supervisor asked for, and the first two starts within 10 minutes of a version change, since an
  update restarts the container. How a stop counts as asked: each start of the App's start script
  makes its own id, which root keeps as the last start record in `/data`. A stop signal (a Stop,
  Restart or update of the App from Home Assistant) reaches the start script's stop handler, which
  leaves a nonce for that start and a mark naming its id and the time. The finish script keeps the
  mark only for a real stop: the start script ended by SIGTERM (or exit 15), with the handler's nonce
  there. A death by SIGKILL (the out-of-memory killer, or `docker kill`), SIGSEGV or SIGABRT is never
  asked, and clears the mark. The next container start counts the mark only when its id is the last
  start record's and it is under 5 minutes old; every start of the start script, a restart by s6
  alone included, clears any mark, so a stale one can never hide a later crash. The stop's budget sits
  inside the Supervisor's 30 seconds with margin: 8 seconds for the services to stop (the stop
  handler takes at most 6), 5 for a finish script (its mark at most 4), then 3 before everything left
  is killed. The count and the record of the installed version live in `/data`, so a
  restart of the container keeps them.
- **The line that names the update**: when a loop (early exits, unseen ends, or container starts) begins
  within a day of a version change, a second alarm goes with it, for example: "Cain's session has
  exited early several times since the update to Cain 0.14.0, installed 3 hours ago. Nothing rolls
  back by itself. If a backup was made before the update, restoring it from Backups undoes the update
  and any changes since." Only then: past that day, no alarm mentions an update. It comes down once neither
  loop stands, and goes out again with each new loop.
- **A long turn**: "Cain's turn has been running for N minutes" adds "This may be normal for a long
  job."; it comes down when the turn ends.
- **Asked stops never count**: an owner's Stop, Restart or update from Home Assistant reaches the
  App's start script as a stop signal before anything else stops, and root records it as asked
  before his session ends. Claude Code's own updater is off in this App (its version is pinned in
  the image), so it never ends his session to update itself.
  Claude Code fixes arrive with App releases, and the repository's CI notes when a newer Claude Code
  than the pinned one is out.

Each check is kept in `/data/probe` with its time, root's alone; the marks of this container's runs
are in `/run/cain/probe`, root's alone too. Nothing under either can be written by Cain's own user,
nor can either folder be renamed or replaced: every folder above them, up to `/`, is root's and not
his to write (the App's start fixes what it can). Before every read or write there, the App checks
the folder is root's, mode 0700 and not a symlink, and the folders above it; a missing folder is made
that way rather than refused. The probe's files are opened without following a link and read only
when they are plain files. If a folder isn't right, the App refuses to use it, stops the probe's
heartbeat ping (so the outside service alarms too) and raises "Cain's probe folder was tampered
with", again each day while it lasts. A restart of the App sets the folders up again.

### Checking it on the Pi

`cain/tools/probe-drill.sh` (in the repository, run by your assistant from a shell with Docker, such
as Home Assistant's SSH App with protection mode off) has the drills, in order:

1. uid 1000 (Cain's own user) can't read the Supervisor's token, the probe's records and marks or
   the gateway state, can't write anything under `/run/cain/probe` or `/data/probe`, and can't list
   `/run/cain`.
1b. uid 1000 kills its own session 6 times after the 5-minute mark: no early exit is counted, and
   "Cain's session keeps ending on its own" is raised once.
2. The Nov 19 replay raises "Cain's session keeps exiting early".
3. Kill the plugin, close the session, cut the network for 15 minutes: each alarm raises and clears.
4. An API outage and a reboot: no false alarm.
5. How stops are classed, each part checking what `/data` keeps and the alarms: `5 ha`, Restart the
   App from Home Assistant 4 times within 30 minutes, each stop under 30 seconds: nothing counts;
   `5 kill`, an abrupt termination (`docker kill`): the next start counts as a boot, never asked, and
   no stop mark stays; `5 s6`, a restart of the start script by s6 alone: no container start counts,
   and the mark it leaves is cleared.

For a hand restore to be there when the update line asks for it, keep a backup taken before each
update of Cain: the Ship job takes one, and Home Assistant's **Backup before update** does too.

## Your record: one hand on each item (since 0.6.0)

The record keeper (`/opt/cain/record/main.ts`) is the record's only writer. Every
item in your open list (`state/PENDING.md`, rows like P33) has at most one holder:
Cain, or one laptop session. Only the holder changes the item's row and pushes its
branches. An item nobody holds is Cain's: anyone else takes it before changing its
row.

### Who holds what: `state/holds.json`

The keeper owns it. Its own copy is `/data/record-holds.json` (in Home Assistant
backups); the copy in the record is put back to it whenever they differ, and no
request can write it. A keeper with no copy of its own (a new install) starts from
the record's, and so does one whose copy is older than what the keeper itself last
published (a `/data` restored from a backup). The file does not exist until the
first hold. Read it as the keeper pushed it: `/opt/cain/record.sh holds` on the Pi,
or `git show origin/main:state/holds.json` in a clone.

```json
{
  "P33": {
    "holder": "laptop:0ee803c1-4bb1-4945-8ec3-b7ca82c30c1e",
    "for": "dane: build the collision fix (laptop chat, 8:20 AM)",
    "branches": ["claude/record-holds"],
    "taken": "2026-11-11T13:20:00.000Z",
    "renewed": "2026-11-11T14:05:00.000Z"
  },
  "P44": {
    "holder": "cain",
    "for": "his Start tap on the P44 card",
    "branches": ["claude/p44-plain-words"],
    "job": "build cse_01ABC",
    "taken": "2026-11-11T15:00:00.000Z",
    "renewed": "2026-11-11T15:00:00.000Z"
  }
}
```

- Keys are item IDs, upper case, sorted. Fields are always in this order.
- `holder`: `cain` or `laptop:<Claude Code session id>`.
- `for`: his words, or the chat it came from (one line, at most 300 characters).
- `branches`: exact branch names only the holder may push. Never `main`. A branch is
  in at most one hold.
- `job`: only on Cain's holds, only while one of his Build or Ship jobs runs on the
  item (what runs, e.g. `build cse_X`). Takes from anyone else wait until the hold
  ends (Cain releases or passes it, or it expires); one still waiting after a day is
  refused.
- `taken`: when this holder got it. `renewed`: the holder's last word on it.
- A hold ends after 24 hours without a word from its holder on that item. Time the
  keeper couldn't work doesn't count toward the 24 hours: the box off, or rounds that
  couldn't push (GitHub down, or refusing pushes).

### Requests

A change request (`kind: "change"`) holds up to 50 ops, applied in order, all or
nothing. Item IDs are read in upper case (`p33` is P33). Besides `put`, `append`
and `remove`:

| Op | Fields | What it does |
| --- | --- | --- |
| `take` | `item`, `for`, `branches?`, `job?` | The item must be in the record (add a new one with `row-add` first, in the same request). Granted if the item is free or its hold has ended, or if `for` starts with `dane:` (his word moves a hold, with its branches). Refused otherwise, naming the holder. The holder's own take adds branches. A branch already in another item's hold is refused. While a hold marked `job` is active, takes wait. `job` is Cain's only. |
| `renew` | `item` | The holder only: renews its hold as it stands. A hold that moved or ended is refused, never taken back. |
| `pass` | `item`, `to` | The holder only. Moves the hold and its branches to `to` (`cain` or `laptop:<id>`) in one step; a `job` mark stays behind. |
| `release` | `item` | The holder only. The item is free (Cain's) again. |
| `row` | `item`, `base`, `set` | Changes cells of one open row. `base` is the row's hash as read: sha1 of the row's line, without the line ending (`record.sh rowsha <item>` on the Pi, `record-send.ts --row <item>` on a laptop). A changed row is a conflict; changes to other rows don't matter. `set` covers `Item`, `Who`, `Next step`, `Waits for`, `Done when`. |
| `row-add` | `item`, `cells` | Adds a row at the end of the open table, `Since` today. Needs `Item`. Refuses an ID in use, or one used before in Done. Anyone may add a row. |
| `row-close` | `item`, `evidence` | Moves the row to the top of Done as `\| <ID> <Item>: <evidence> \| <date> \|`. |
| `note` | `item`, `text` | Anyone, holder or not, on any item the record knows (held, open, or done). Appended with its time and sender to `state/notes/<item>.md`, so it never conflicts and is never refused for a hold. `text` is one line, 1 to 2,000 characters. |

- Cells never hold `|` or a new line. A row that already holds an escaped `\|` is
  changed only with a `put` of the whole file.
- Every change to `state/PENDING.md`, `put` included, is checked row by row: a row
  someone else holds refuses the whole request, naming the holder, and so does an
  open row nobody holds unless the sender is Cain ("take it first"). New rows, the
  text around the tables and the Done table are anyone's.
- A `put` of `state/PENDING.md` made from an older version is laid onto the list as
  it stands when the rows it changed are untouched since (both sides changing one
  row, or the text around the tables, is still a conflict).
- A request from the holder that changes its row, or files a note on it, renews its
  hold.
- A change that changes nothing is rejected: "changes nothing".
- Paths are plain names: a `.` or `..` segment, an empty one, or one with a space at
  either end is refused, as is anything under `state/holds.json` or `state/notes`.

### Notes: his words always land

When he tells someone other than the holder something about a held item, it says
"Got it" and files his words with a `note` op. Only that op writes `state/notes/`.
A notes file reads:

```
# Notes on P33

Words about P33 for whoever holds it, oldest first, filed by the record keeper from note requests. Its holder reads new ones before changing P33.

| When | From | Note |
|---|---|---|
| 2026-11-11T13:20:00.000Z | laptop:9a1b2c3d-0000-4000-8000-000000000002 | Dane, laptop chat 9:12 AM: make the card say P08 Q2 |
```

- `When` is the keeper's ISO time. Past 60 KB the oldest notes roll off (git keeps
  them); a new note is never refused for size.
- Cain reads them with `/opt/cain/record.sh notes [<item>|-] [<since>]`: one table row
  per note, oldest first; nothing when there are none.
  - With an item: that item's notes.
  - With no item (or `-`): every item's notes except those on items someone other
    than Cain holds, each line led by its item (`P33 | <when> | <from> | <note> |`).
    Items nobody holds are Cain's, so their notes are his to read.
  - `<since>`: only notes after that time, in any ISO form or offset
    (`2026-11-11T08:20:00-05:00` is 13:20 UTC).
- A laptop session's per-turn hook (`record-holds.ts --hook`) shows each new note on
  its held items once; on an item it has just come to hold, all of its notes.
  `record-send.ts` shows any it hasn't seen on the items a request touches and holds
  that request back once, so a holder reads a note before its next write.
- This op is not the request kind `note`, which is his page's words relayed to Cain.

### Who a request is from

`from` is `cain` (only through Cain's local queue), `laptop:<session id>` (stamped
by `record-send.ts`), or `page` (your page). Older writers that send plain `laptop`
or `claude-code` may still write, recorded as such, but can't hold anything.

Who a request says it is from is taken as said. Anything that can push to the
record's inbox could claim to be any laptop session, though never Cain. Holds stop
accidents between Cain and laptop sessions, not someone set on pretending.

Outcomes in `log/requests`: `done`, `conflict` (re-read and redo), `rejected` (breaks
a rule), `refused` (someone else holds the item, or Cain does by default),
`relayed`, and `waiting` (a take behind one of Cain's jobs: a second line with the
same id says how it ended).

The keeper looks at Cain's own queue every 2 seconds and runs as soon as something is
in it; the record's inbox (your page, laptop sessions) is read every minute.

## PC jobs (since 0.12.0)

Chores that need a browser signed in as you go to a small job queue in a private repo
of their own (`pc_jobs_repo`, default `HyndeSyte/pc-jobs`), run by the worker on your
PC in a locked browser session, in a Chrome profile named Cain jobs. Runs are attended
(you start them, watching): this version refuses unattended runs. The session gets four
reading tools of Claude in Chrome and nothing that reads files, and the worker's own
folder (with its Claude Code sign-in) is denied to it by path besides. A new Claude in Chrome or Claude Code version stops
every run until you probe again. Cain's PC job keeper is the queue's one
writer of jobs and holds `pc_jobs_token`, so his session never does. With no token it
waits and does nothing. This version is read-only by enforcement: the PC worker runs
only actions from a fixed read-only set that your signed allowlist pins to an address,
and irreversible jobs are refused until the confirm path ships. Results are typed facts,
each checked against a strict schema for its action (a value outside it fails the run
and nothing of it is kept), and reason codes, read by Cain as data, never as instructions. The keeper's clock
closes jobs past their expiry and claims whose lease ran out. The one-time setup at your
PC, what is enforced and what isn't, the job and result formats and the browser
session's settings and prompt are in `cain/docs/pc-jobs.md` and `cain/docs/pc-worker/`
in this repo.

## Laptop sessions (tools, not part of the App)

`cain/tools/` in this repo holds a laptop's side. Nothing there ships in the App, and
nothing is installed by this release.

- `record-send.ts <request.json>`: stamps `from: laptop:<session id>`, runs the
  keeper's own checks and sends nothing they'd turn away, pushes the request to the
  record's inbox as `<UTC>-<session>-<random>.json`, then waits up to 3 minutes for
  its outcome in `log/requests` and prints it. Exit 0 done, 1 refused, conflict or
  rejected, 3 still waiting. `--row <item>` prints a row's base. A session acts on a
  hold only once its take prints `done`. New notes on its items are shown first and
  the request held back once.
- `record-holds.ts`: prints what the session holds, new notes on those items (each
  once), its takes still waiting, and tells it once when a hold has ended. `--hook`
  for Claude Code hooks (prints only when there is something to say, never blocks),
  `--renew` to renew its holds with `renew` ops, at most every 6 hours.
- `record-prepush.ts`, run by `pre-push`: refuses a push to any branch of
  HyndeSyte/harness the session doesn't hold, reading `state/holds.json` fresh from
  the record's main. Pushes to any other repository pass through, and a push from a
  linked worktree reads the record the same way. With no session id (Dane in a
  terminal), `git push --no-verify` skips it.
- `record-preflight.ts <request.json> <clone>`: the keeper's checks only.

The tools refuse a record clone that follows anything but the record's `main`. The
pre-push hook covers `git push` only: changes pushed through `gh` or the GitHub
connector don't run git's hooks.

To set a laptop up (the session id comes from Claude Code's
`CLAUDE_CODE_SESSION_ID`; use forward slashes in paths):

1. A clone of the record on `main` with `user.name` and `user.email` set (the tools
   fetch it themselves), and a clone of this repo kept on `main` for the tools.
2. In the laptop's Claude Code settings (`~/.claude/settings.json`):

   ```json
   {
     "env": { "RECORD_CLONE": "C:/path/to/org" },
     "hooks": {
       "SessionStart": [{ "hooks": [{ "type": "command",
         "command": "bun C:/path/to/harness-tools/cain/tools/record-holds.ts --hook" }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command",
         "command": "bun C:/path/to/harness-tools/cain/tools/record-holds.ts --hook --renew", "timeout": 30 }] }]
     }
   }
   ```

3. git's pre-push hook for every repository on the laptop, pointed at the tools:
   `git config --global core.hooksPath C:/path/to/harness-tools/cain/tools`. It
   guards HyndeSyte/harness and lets every other repository through. A global
   `core.hooksPath` replaces each repository's own `.git/hooks`, and the hook needs
   `bun` on the PATH of whatever runs git. (To guard one clone only, copy
   `cain/tools/pre-push` to its `.git/hooks/` and set `CAIN_TOOLS` to the tools clone.)
