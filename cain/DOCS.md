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
6. On the App's page in Home Assistant (Settings, Apps, Cain), turn on **Watchdog**. It is the
   one switch the App can't turn on itself (below, **The Watchdog switch**).

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

Since 0.19.0 and until 0.19.2, Cain could not accept an update of himself: a mix-up in his App's
code gave his drill check the wrong kind of store, so every install of Cain was refused with "the
drill flags' high-water time can't be kept". 0.19.2 fixes it, and his tests now fail on that kind of
mix-up before a change can reach a Ship card.

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

### The privacy backstop (since 0.18.1)

Before anything goes to a seat, the review runner checks it in code and fails closed. Over the
brief (its topic, question, body and id) it runs every built-in pattern (an email address, a phone
number, an account or card number, an SSN-shaped number) and your private-terms list
(`/data/review-private-terms.txt`); a brief that matches is blocked and nothing is sent.

Over the earlier findings a fix-only round carries it runs the same email, phone and SSN-shaped
patterns and your private-terms list. Only the account-or-card pattern is relaxed there, and only
for an unbroken run of exactly eight digits that is a valid date written year, month, day, years 1900
to 2099 (`20250305`), whether glued to an identifier (a letter or an underscore right before it, as in
a web search tool's name ending in a date, `web_search_20250305`) or bare. A bare eight-digit date in
the findings is accepted on purpose: it can't be told from a date, and it is shorter than any card
number. Any other run of eight or more digits in the findings still blocks the round: a bare
`12345678`, a longer or non-date run glued to an identifier (`card_4111111111111111`,
`account_123456789012`), or a spaced card number; a Luhn-valid run of 13 to 19 digits always blocks.
A match names its kind (or the list's line), never the text. A blocked round sends nothing and
doesn't count toward the cap.

The earlier findings come only from the runner's own record: it reads the change's previous round
from the rounds recorded under that change's own key in its rounds file (each round by its id) and the
queue record that round left, which must be that round of that change. A brief has no field for them,
so a brief carrying earlier findings, or any field not in its allowlist, is refused whole and nothing
is queued. A round id is one change's: a brief whose id is already a round of another change is
refused and nothing is queued.

### The review-round cap (since 0.16.0)

A piece of work gets at most three outside review rounds, and the review runner keeps that count
itself, where Cain can't change it. Each brief names its change (a pull request's address, or a
stable `change` key for a plan or document); a replacement pull request or a new key names the one
it `supersedes`, and the count carries over, so a new id or a new pull request doesn't start it
again. The first round reads the whole change; every later round is fix-only: the seats get only the
fixes and the earlier findings, and mark each finding serious (could lose or corrupt something of
yours, act without your go, expose a secret, widen reach, or fail silently) or follow-up (a window
that needs a crash or rare timing and fails safe, hardening, edge cases, wording, polish). A fourth
round is refused, with the count and the rule.

**Since 0.19.1** (your review rule as you changed it on Nov 26, 2026): if the third round still leaves
something serious, the change is held and Cain tells you in one line, with no card. The review runner
no longer sends the ship-or-hold card, the link refuses it and Cain's grant card, and `keeper.sh
review-grant` answers that grants are retired. A tap on an old grant or ship-or-hold card still up
writes nothing: its buttons come off with one line saying it's retired. A Ship card for a held change
is refused. The rest of this section, and "More rounds, granted by your tap" below, describe how those
cards worked before 0.19.1; the code behind them goes in a later release.

Before 0.19.1: if the third still leaves something serious, the
runner itself sends you one card: what the piece is, the serious finding in one line, and "Hold it"
or "Ship it with that risk", holding recommended. Cain can't send that card or ask for another
round: the link refuses both. Its Ship card waits for your tap; after "Hold it" there is none, and
after "Ship it with that risk" it goes only while the rollback of a bad install is armed for that App.
Since 0.19.0 the link reads that from the Keeper App (`GET /armed` with Cain's `keeper_token`, every
minute): a refused token, any error, an answer for another App, a timestamp older than 2 minutes, or a
binding that doesn't match (the verdict protocol, the backup scope, the Keeper's version, and for Cain
the hash of the verdict probe installed in this App) all read as not armed, and the card says which.
Until the Keeper has run both drills for the App, its Healthchecks checks are set (Keeper 0.1.3: a
dead-man check too, and an alert check of its own for each watched App), its phone test drill is
confirmed, and (worked out at every read) its heartbeat, its dead-man ping and a non-paging log ping to
each of its alert checks reached Healthchecks within the last 10 minutes with no alert of it stuck for
over 2 minutes, that card is refused and says what isn't armed (the Keeper's own documentation has the
drills and the conditions). The cap is the option
`review_round_cap` (default 3); the rounds are kept in `/data/review-rounds.json`, your taps on the
card in the link's `/data/link/review-decisions.json`.

Since the second round of fixes in 0.16.0:
- Your tap on that card is written to disk first, and the card counts as answered only once it is.
  If the write fails, the card stays up and you get one line saying your answer couldn't be saved and
  you can tap again. A decisions file that doesn't parse is never written over: it's moved aside under
  a name with the time in it, no new tap is written while it stands, and the App's alarm names it.
- Each round is kept as started, then answered or lost (it ended without a result: every seat failed,
  or the runner stopped before the review was queued). A lost round still counts, and when the last
  round the cap allows is lost, the card comes anyway, saying the final review did not complete.
- The card's words pass the same checks as every other card to you; if they don't, the card says "A
  serious finding remains; see the item" with the piece's name. If its item is held by another
  session, the card waits and goes out once the hold clears.
- While the rollback isn't armed, the card says so first, in one sentence: a Ship would be refused
  until a release arms it, so holding is the working choice. A tap on "Ship it with that risk" then
  records the change as held, on the guard's log below, and Cain is told.
- At each start the review runner and the link check the owner and mode of these files (the rounds
  file, `/data/review-settings.json`, `/data/review-guard.log`, the decisions file; the rollback record
  is no longer a file since 0.19.0). One that's wrong turns the cap and the guard off (no review round, no `other`
  Build, and Ship decisions paused for every pull request: no Ship card for any change) and raises
  one alarm naming it. Since the third round of fixes the check runs again every minute, so they come
  back on by themselves, and the alarm clears, once the file is right; no restart needed.
- A decisions file that doesn't parse is moved aside, never deleted, and no new answer is kept while
  that copy stands; the App doesn't set it up again by itself. The alarm names the copy and the step
  back: as root on the Pi, remove it or rename it so its name no longer starts with
  `review-decisions.json.corrupt-`. Answers are kept again at once, and the alarm clears at the link's
  next sweep. If you tap the other answer after a restart cut a tap short, your first answer stands,
  and the card says "Already answered".

#### More rounds, granted by your tap (since 0.18.0)

The rule stays three rounds a change. Your decision on Nov 21: for a critical change whose last round
still left something serious, the exception is more fix rounds, granted by you, never an exemption
from the rule. So:

- Only you can grant, and only by a tap. Cain can ask with
  `keeper.sh review-grant --item <item> --change <pull request or change key> --rounds <1 to 3> "<why>"`.
  You get a card: what the change does (Cain's words) and its pull request number, how many rounds it
  has used and what the last one left (the review runner's own count of serious findings, never
  Cain's), how many rounds the grant adds, and two buttons, "Grant <n> more rounds" and "No". It
  expires at the next morning check-in like Cain's asks. Cain's command writes nothing: only your
  "Grant" tap does. The link refuses the command while the change still has rounds left (nothing to
  grant), while its last round is still running, while its item is held by another session, while
  Stop holds, and while another grant card for the same change is still open (one open card a change:
  the refusal names when the open one went up).
- Your "Grant" tap checks all of that again before anything is written: the change is still at its
  cap, no round of it is running, no other session holds its item, Stop is clear, and its round count
  and cap are still the ones the card was posted with. If any of it no longer holds, nothing is
  written, the card loses its buttons, and you see one plain line saying why (for example "That change
  has rounds left now, so this grant isn't needed"). When a grant is written, any other open grant card
  for the same change loses its buttons ("Replaced by a newer grant").
- Your tap is written to disk first, in `/data/review-grants.json` (root:cain 0640 at every write and
  every time it's made again, so the review runner and review.sh can read it; written only by the
  link): the change, how many rounds, that you granted it, when, the card's message and Cain's reason.
  It is also noted in the link's log and beside your other taps in `/data/link/review-decisions.json`.
  If it can't be written, the card stays up and you're told your grant wasn't saved. A grant is for
  one change; a replacement pull request carries it over, as it carries the rounds.
- The cap for that change is then 3 plus what you granted. Each granted round is fix-only, carrying
  the earlier findings, like any round after the first. When the cap is reached again, the runner's
  refusal says how a grant works.
- If a granted round at the raised cap still leaves something serious, the decision card ("Hold it" or
  "Ship it with that risk") comes again, for that round. A "Hold it" on an earlier card doesn't stop a
  later granted round. The Ship card rules stay: it needs a review whose last round left nothing
  serious, or your "Ship it with that risk" on the newest decision card, which still needs the App's
  rollback armed. While a granted round is running, or left something serious with rounds still to
  go, no Ship card goes out.
- What a grant never does: exempt a change from the rule, or from the armed-rollback condition on
  shipping with a risk named.

Since the second review of 0.18.0:

- Your tap is one operation at a time for each change. The re-check, the grant's write and the card's
  consumption (marked used, its buttons off, any other open grant card for that change retired) run
  under one lock for the change key, inside the link. A second delivery of the same tap, or a second
  quick tap on the same card, waits for the first and then finds the card used: nothing more is
  written. A tap on another grant card for the same change waits the same way and is refused.
- The card is bound to the change as it was when the card went up: beside the round count and cap it
  keeps the pull request's head commit and the newest decision on the change (none, if there was
  none). Your Grant tap reads both again: if the pull request has new commits, or a newer decision has
  come, nothing is written, the card loses its buttons and you see one line saying why, as for the
  other checks. No card goes out while the pull request's head can't be read from GitHub.
- An open grant card never blocks for good. Before Cain's next grant card for the same change is
  refused because one is open, the link looks at the open one: when its head moved, a newer decision
  came, its round count or cap changed, or its message is gone from the chat, it loses its buttons
  ("Replaced by a newer card"), stops counting as open, and the new card goes up. A card that is still
  current keeps refusing a second one. A card whose buttons were taken off for any reason no longer
  counts as open, and what counts as open is read from the link's own records on disk, so it holds
  across a restart of the link.
- A passing failure at your tap (the review records, who holds the change, or the pull request's head
  can't be read just then) writes nothing and keeps the card up: you see one line saying to try again
  in a minute.
- `review.sh status <id>`, `review.sh spend` and Cain's "Review done" line show the raised cap and the
  grants, for example "round 4 of 5, 2 granted by Dane on Nov 21".

### Labels (since 0.16.0)

Every brief, and every Build or Ship job Cain starts, carries one label: `core` (Cain answering you,
the calendar, reminders, the morning message), `commitment` (your course first), `necessary-fix`
(something broken now) or `other`. A missing label counts as `other`. A brief carries it in its
`label` field; a job, in its `label` field or a `Label: <label>` line of its text. The first three
always pass the usage guard (still within the round cap); `other` is what the guard can hold.

### The usage guard (since 0.16.0)

One Claude subscription and four paid review seats serve Cain's own work, the builds, the reviews
and your own projects. The guard keeps `other` work from spending what your commitments need: the
review runner asks it for every brief, and Cain's Build hook for every Build job. It refuses `other`
work while the week's plan allowance left, or any review seat's monthly cap left (the caps the
runner really uses), is below the reserve floor, the option `usage_reserve_percent` (default 25).
There's no tap or flag that gets around it. Each refusal is one line in `/data/review-guard.log`
(time, label, what was refused, which floor), and Cain lists those holds on the open list; the guard
never sends you a card. The log is root's (root:cain 0640, since the second round of fixes): Cain
reads it but can't write it. The runner writes its own refusals; Cain's Build hook and `review.sh`
send theirs to the link, which checks the guard again itself and writes only a real refusal. If the
link can't be reached the run is still refused, and the refusal says the hold wasn't logged. Since
the third round of fixes that route is bounded: at most 6 holds a minute from each caller, an
identical hold logged once in 10 minutes, its description checked like a card (one that fails is
logged as "a build labelled" and its label), and the log rotated at 256 KB keeping one previous file
(`/data/review-guard.log.1`), with one alarm when a limit is hit. The
guard's, the cap's and the plan reader's paths are fixed in the code; the environment can move them
only in the tests' own mode (`CAIN_TEST_MODE`), which the App never sets, and the Build hook refuses
every run while that variable is set. `/opt/cain/review.sh guard` prints its reading in two lines, and the morning
check-in hands Cain the same two lines for his daily usage row.

What it reads for the plan: Cain's Claude Code transcripts under `/data/cain/.claude/projects` (each
turn's token counts, the last 7 days). They record tokens used, not your plan's weekly allowance,
and nothing else on the Pi records the allowance, so the plan reading is "unknown" today, and an
unknown reading (or one older than a day) counts as below the floor. So for now every `other` job
and review is held, and only `core`, `commitment` and `necessary-fix` work runs: that's on purpose,
until there's a reliable reading. How to tell it's working: `review.sh guard`'s first line says
"Plan: unknown" with the reason and the week's token count (a count that grows as Cain works shows it
reads the transcripts; "no Claude Code transcripts found" means it can't), and its second line names
each seat's share left and whether other work is held. `review.sh spend` shows the runner's own caps
and each open change's round count.

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

## What 0.19.4 does: an install starts from the version you actually have

- When you tap Ship, the link tells the Keeper which version the install replaces. That is now the
  version of Cain installed on the Pi, as Home Assistant reports it when the App starts, not the version
  in `main`. Before, a version that was merged but never installed (0.19.1 on Nov 27) made the Keeper
  refuse every later install of Cain, since the Pi was still on the one before.
- The App reads that version from Home Assistant at each start, in the background and for at most a minute,
  and keeps it only in `/run/cain` (cleared at every start), as a plain version number: one to four groups of
  digits separated by single dots, like 0.19.3 (anything else, such as `1..2`, `dev` or `latest`, counts as
  unreadable). If the Ship run comes while that read is still going, the link waits for it to finish, up to
  its own bound of about a minute. If it can't be read, the link uses the version the running App was built
  as, when that is a plain version number too, and says so in one line of its log. If neither can be read, nothing
  is registered and the Ship run is refused with that reason; the link never guesses.
- When the Keeper itself has refused an install, or left it unprotected, there is nothing left to cancel: the
  link doesn't ask it to cancel and posts no Try again card. You get one plain line instead, saying the Keeper
  refused it and why, with no button. Any other answer (an error, no answer, something unexpected) is handled
  as before: the link cancels, and a cancel it can't confirm still brings the Try again card. A cancel counts
  as done only when the Keeper answers that it ended, or refuses it because the install is unprotected.

## What 0.19.0 does: working with the Keeper

The Keeper App (in this repository, `keeper/`) checks every install of Cain for 15 minutes and rolls a
bad one back from the backup taken just before it. Cain's part:

- Right after each start of his session, the App asks the Keeper whether an install of this version is
  being watched. If one is, it asks his session the liveness line once and gives the Keeper its
  verdict: PASS, or FAIL when he didn't answer within 10 minutes.
- If the Keeper's last line about Cain is a rollback or a give-up, his bot says that line to you once.
- Two checks on port 8098, both for Home Assistant's internal network only (404 to any other address
  and on any other path):
  - `/health`, the Watchdog's URL, is liveness: 200 while the App runs, 503 only while a self-restart
    is due. It doesn't depend on Discord, so a Discord outage doesn't make the Watchdog restart him.
  - `/ready` (its `health` option names the path) is readiness: 200 only while the link's Discord
    connection is up and Discord acknowledged it within 5 minutes, 503 otherwise. Since Keeper 0.1.3 the
    Keeper decides an install and a rollback on `/health` alone and only reports `/ready`, as "chat
    connected" or "chat not connected (degraded)": a Discord outage never rolls Cain back.
- One Ship run per Ship tap, and its registration with the Keeper (with Keeper 0.1.3). When Cain starts a
  Ship run, his RemoteTrigger hook checks the token as before, then asks the link (`POST /ship-pass`,
  Cain's key). The link refuses a token it has already let through (a second Ship run on one tap), keeps
  the spent ids (hashes, never the token) in root's `/data/trust/ship-passes.json`, and registers each
  install the tap makes with the Keeper over the Keeper's own service (`POST /attempt` with Cain's
  `keeper_token`): the token itself, the pull request, the head, the App's version before and after (since
  0.19.4 the version installed now and the `config.yaml` at the head) and the verdict probe's hash at the head. The Keeper
  checks the token's signature with the link's public Ship key (its `ship_public_key` option: the line
  `Ship key (public): ...` in this App's log; since Keeper 0.1.4 pinned on first use, a changed one needs
  confirming at the device), spends it once per App and takes the App-only backup itself. A link that
  doesn't answer refuses the Ship run. Nothing writes the Keeper's options. The link registers only the
  Apps the Keeper watches by default (Cain).
- With Keeper 0.1.4, the Ship run waits for the Keeper's acceptance. The Keeper answers a registration
  only once its backup is complete and verified, with the backup's slug, and the link answers the hook
  "ok" only once every watched App the run installs is accepted (a run that installs no watched App
  passes at once). Meanwhile the link answers "pending" and the hook refuses the run with "This Ship run
  hasn't started yet: ... start the same Ship run again in a minute"; Cain does so, up to 6 times. A
  Keeper refusal, no answer within 5 minutes, anything the link can't read, or no acceptance within 6
  minutes refuses the pass for good: nothing is installed, and a new Ship card makes a new token. So while
  the Keeper isn't installed or set up (its `ship_public_key`, its `tokens` and this App's `keeper_token`),
  no Ship run that installs Cain starts. The Ship run itself still reads the Keeper's `accepting <id> ...`
  line before it installs and stops without it (RELEASING.md, Ship).
- With Keeper 0.1.5:
  - Register, then poll: the Keeper answers a registration at once and makes the backup in the
    background; the link checks back (`GET /attempt/<id>`) every 5 seconds, up to 5 minutes per watched
    App, and the whole pass waits 5 minutes per watched App plus 1. When it gives up it cancels each
    registration it made at the Keeper, so no acceptance is left lying around.
  - The claim: once every watched App is accepted, at the hook's next ask, the link claims each
    acceptance at the Keeper (single use, valid 30 minutes) and only then answers "ok", with each claim's
    id and deadline, and writes `Ship pass ok: <attempt id> claim <claim id> until <time>` to this App's
    log. The Ship run needs that line and the Keeper's `claimed ...` line for the same attempt before it
    installs, and aborts once the claim's deadline has passed. A refused or unanswered claim refuses the
    pass for good.
  - The key's fingerprint: `cain/SHIP_KEY_FINGERPRINT` in the repository holds the fingerprint of the
    link's Ship key (this App's log prints it, `Ship key fingerprint: ...`). The link refuses the pass
    unless the Keeper's pinned key has that fingerprint at the pull request's head, it is the link's own
    key's, the owner has confirmed the pin at the Keeper (`key-confirm`), and the Keeper's state is no
    newer than the one the link recorded at the last confirmed enrollment it saw (root's
    `/data/trust/keeper-enrollment.json`). Until a Build commits the fingerprint, every Ship run that
    installs Cain is refused.
- With Keeper 0.1.6:
  - The claim's deadline in code: the link refuses (and cancels) a claim the Keeper answers with under 20
    minutes left, and the RemoteTrigger hook checks every claim's deadline again just before it lets the
    Ship run start. Under 20 minutes left, or a deadline it can't read, refuses the run and asks the link to
    cancel the pass and its claims (`POST /ship-pass {token, cancel}`); a new Ship card for the same pull
    request and head starts again. The Ship run's own check of the two log lines stays, as belt and braces.
  - The enrollment record: the link records the owner's confirm of the Keeper's key from its
    minute-by-minute `/armed` read as well as from a Ship pass, and a pass needs the Keeper's state creation
    and confirm times to equal the recorded ones (an older or newer state is refused until the owner
    confirms again at the Keeper).
- With Keeper 0.1.7:
  - The enrollment id and counter: every Keeper answer carries the owner's confirm's own enrollment id and a
    counter that only goes up. The link records both and refuses a lower counter (an older Keeper state, from
    a restore) and an earlier enrollment id it has seen replaced (a replayed confirm). Each answer is judged
    against the record as it stood before the request was sent. The way back after a restore of the Keeper or a
    clock correction is the owner's `key-confirm` at the Keeper with a fresh code (Keeper 0.1.8: from `key-code`):
    a new enrollment id, which the link records.
  - The claim's request id: the link's claim carries one, and a claim that got no answer is asked once more with
    it; the Keeper answers that retry with the claim it recorded, never a second claim. A cancel the Keeper
    already recorded is answered the same way, and the Keeper's own expiry of an unused claim deletes its
    backup, so a lost cancel leaves nothing behind.
  - The Keeper is unarmed and refuses registrations while one of its drills runs, so a Ship pass during a drill
    is refused (the drill is then void, and is run again).
  - Two limits of the design are recorded in the Keeper's DOCS ("Accepted limits") and accepted by the owner at
    the Keeper; the rollback reads as armed only once they are.
- With Keeper 0.1.8:
  - Enrollment after a restore: a brand-new enrollment id (one the link has never seen, the owner's `key-confirm`)
    is recorded at the counter it carries, however far below the old record, and counters only go up within that id
    after. A reply for an enrollment the link has replaced meanwhile (a concurrent `/armed` read recorded a newer
    one) is discarded, even when the record before its request allowed it. The fresh code for `key-confirm` comes
    from the Keeper's `key-code` (or its start, while it isn't enrolled or after a refusal).
  - A pass refused on the enrollment cancels its registrations saying so: "enrollment counter behind the link" for
    an older Keeper state, "enrollment refused by the link" otherwise. The Keeper logs `enrollment counter behind
    the link: re-enroll with key-confirm` and prints a code.
  - One Ship run per attempt: a second run on a token that already passed is refused naming the claims' latest
    expiry while one is live, since a claim at the Keeper can stay live for up to 30 minutes after a refused or
    failed run (the Keeper's first accepted limit, text version 2). The Keeper logs each claim's start and end.
  - The Keeper's cancel is refused while Home Assistant shows an install, update, rebuild or restore of Cain, a job
    on Cain it doesn't recognize, or a jobs list it can't read; the claim then runs out by itself, and its backup is
    kept until one more poll after the deadline shows no version change.
- The two options: `keeper_url` (filled in) and `keeper_token`, the same token as the Keeper's
  `tokens` entry for Cain. Empty: no verdicts, and the rollback never reads as armed.

## What 0.15.0 does: Cain stays on Discord

On Nov 20 two drills found gaps: when the Discord plugin's server stopped, nothing started it again,
and Cain was off Discord for 19 minutes until the App was restarted by hand; and after the App's
container was killed, it stayed down 10 minutes with no alarm, since every alarm runs inside the App.

- **The plugin's server is supervised.** When it stops for any reason, the App starts it again
  within seconds (waits of 1, 2, 4, 8, then 15 seconds), logs each restart with its exit code
  ("the plugin's server stopped (0): starting it again in 1 s"), and hands it Cain's session's own
  handshake again, so his session keeps its channel. Each stop is logged with its exit code, the
  signal that ended it, and the last lines it wrote. While it's down, and until the new server has
  taken that handshake, a call from his session is answered at once ("the Discord channel is
  restarting its server; nothing was sent"), never dropped or sent to a server that isn't ready; a
  new server that refuses the handshake, or doesn't answer it in 10 seconds, leaves the channel down
  for the watchdog. While it's down the App names it as its own state, "the Discord plugin's
  server", apart from his session exiting. A restart of the broker itself (the part that holds his
  connection) is different: it ends his connection, so the state says down from that moment and the
  App restarts his session after 90 seconds; the plugin's server comes back with his new session.
- **The App restarts itself, as a last resort.** When his Discord channel stays down across 3
  restarts of his session, or for 10 minutes, whichever comes first, the App ends his session and
  asks the Supervisor to restart it (the Supervisor's own restart call, which every App may make);
  should the Supervisor refuse, the App stops on an error (exit code 3) at once, and should the
  Supervisor take the call, or not answer it within 30 seconds, but not stop the App within 2 minutes
  after, it stops on an error then; the Supervisor's watchdog starts it again. The two can overlap only
  if the Supervisor takes longer than about 150 seconds to stop the App. A Stop of yours, or a crash,
  inside that window is not called a self-restart: the window measures from the App's last step of the
  restart (it notes the time again just before its 2-minute wait), and a crash in it, a kill by any
  signal but the Supervisor's normal stop (an out-of-memory kill, say) included, alarms and is reported
  as a crash. If the Supervisor can't be reached at all, the App's log says so, apart from a refusal. The App's log says "Asking the Supervisor for the
  App's restart" just before the call. A line saying the Supervisor took it rarely shows, because on
  a real success the Supervisor stops the App before it answers. The real sign of a self-restart is
  the outside heartbeat's failure ping, "restarting itself (self-restart, exit code 256)", followed
  by a fresh start of the App. One restart per incident (30 minutes), each kept
  in `/data/probe` with its cause and time, named in the next morning check-in, counted in 0.14.0's
  restart counts as a restart the App asked for itself, and an alarm after 3 in 24 hours or 2 for the
  same cause. Every self-restart also pings the outside heartbeat's failure address, so one that never
  comes back is raised from outside. Never while his screen waits on your one-time sign-in: the 10
  minutes and the wait for a first connection start again when the sign-in ends.
- **A first session that never connects** (signed in, but no Discord connection 3 minutes after it
  started) is restarted; one waiting on your sign-in never is.
- **No alarm hands you a manual step.** Each names the real cause (the plugin's server gone, his
  session exiting, his channel down past its restarts, the App restarting itself) and what the App
  does about it. The one exception is the Watchdog switch below; your Claude sign-in is yours too.
- The panel's terminal opens again: since 0.14.0 nginx couldn't reach its socket or the sign-in page.
- A loop within a day of an install now says so for the first version that keeps the install record
  too (0.14.0's own install didn't).

### The Watchdog switch

The **Watchdog** switch on the Cain App's page in Home Assistant (Settings, Apps, Cain) is the one
thing only you can turn on, once. With it on, Home Assistant's Supervisor starts the App again by
itself whenever its container stops on an error: a crash, a kill, running out of memory, or the App
restarting itself by its exit route because Cain's Discord channel stayed down. It also asks the App's
health page (`/health`, the `watchdog` URL in its configuration, answered to Home Assistant's own
internal network, 172.30.32.0/23, where the Supervisor is, and 404 to any other address and on any
other path; the answer is only whether the App is up) and restarts the App when that answers an
error, which it does only in the moment a self-restart is under way. Each `/health` 404 shows in the
App's log, at most once a minute, with the address it came from ("The health check URL (/health)
answered 404 to: ..."), so a probe from an unexpected address can't restart the App in a loop
unseen. With it off, a killed App stays down until someone starts it, and the App
never restarts itself (its exit route would leave it down): it tells you once, naming this switch, and
keeps restarting Cain's session instead. The App reads the switch through the Supervisor's own-info
call and asks for its restart through the Supervisor's own restart call, both of which every App may
make without an API role (`hassio_api` stays off); it has no wider access than before. Only a
successful answer whose `watchdog` is exactly true or false counts; anything else is "unknown".

If the App's web server (nginx, which serves its page and `/health`) doesn't start after 3 tries, the
App logs nginx's own words as the cause and raises an alarm of its own, "Cain's App page is down";
Cain himself keeps running. It comes down at the next start that works.

**The exit route is relied on only once Pi drill 7 has passed** (below): it proves that the App
stopping with exit code 3 is started again by the Supervisor within a minute. Until then the
Supervisor's restart call is the route the App uses, with the exit route only behind it.

**Drill 7 starts with a release gate: the Supervisor's health probe.** With the Watchdog switch on,
it reads the address the Supervisor probes from, checks it is inside 172.30.32.0/23, asks `/health`
from the Supervisor's own container and wants 200, then watches the App's log for 3 minutes for any
`/health` 404 line. It also reads the Watchdog switch through the Supervisor's info call and wants
it on, and wants at least one `/health` 200 to the Supervisor's own address in those 3 minutes (nginx
notes each 200 with its time and address). If any of that fails, the exit route is not relied on and the result goes back to
the laptop session. `bash probe-drill.sh 7 gate` runs the gate alone.

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
  meanwhile, or the run died before its exit handlers ran) is an unseen end, however long it ran.
  More than 3 early exits in 30 minutes is "Cain's session keeps exiting early", on
  your phone through Home Assistant and in Discord; it comes down once the count is back under.
- **Unseen ends** have their own three windows: more than 3 in 30 minutes, more than 6 in 60 minutes, or more than 8 in 24 hours
  is "Cain's session keeps restarting", with the count and the window that tripped. The 24-hour
  window catches a slow loop the others miss (a restart every 11 minutes all day); a pace slower than
  all three stays under them. Its text says no clean stop was recorded (a crash, a kill, a power
  cut, or a stop that took too long to finish (the stop drill timings show it)), and that the restarts were seen but not the exits, so it is a cadence, not a confirmed crash;
  it never counts as an early exit. Within a day of an update it carries the update line too, since an early crash
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
  Restart or update of the App from Home Assistant, or the same asked by an automation or a watchdog)
  reaches the start script's stop handler, which leaves a nonce for that start and a pending mark
  naming its id and the time. The stop is marked in two phases: the finish script promotes the
  pending mark to asked only for a real stop, the start script ended by SIGTERM (s6 passes 256 and
  signal 15), with the handler's nonce equal to the last start record's id. A plain exit 15, a death
  by SIGKILL (the out-of-memory killer, or `docker kill`), SIGSEGV or SIGABRT is never asked, and
  clears the mark. The next container start counts only a promoted mark, when its id is the last
  start record's and it is under 5 minutes old. A pending mark left over means the stop never
  finished (the container was killed, the power was lost, the finish script never ran): that start
  counts as a plain boot, and the mark is cleared; every start of the start script, a restart by s6
  alone included, clears any mark, so a stale one can never hide a later crash. The stop's budget sits
  inside the Supervisor's 30 seconds with margin: 8 seconds for the services to stop (the stop
  handler takes at most 6), 5 for a finish script (its mark at most 4), then 3 before everything left
  is killed. The count and the record of the installed version live in `/data`, so a
  restart of the container keeps them.
- **Repeated asked restarts of his App**: every stop the Supervisor asks for arrives as the same
  signal, whoever asked, so a loop of them (a Home Assistant automation, repeated restarts from the
  App's page, a watchdog) would otherwise never count. Asked starts are kept in their own window in
  `/data`, with two windows: more than 6 in 60 minutes, or more than 12 in 24 hours (so a requested
  restart every 11 minutes, at most 6 an hour, still alarms within a day), is "Cain's App keeps being
  restarted". Its text says the previous runs ended with a stop that was requested (a Restart or
  update from Home Assistant, a backup, an automation, or the Supervisor's watchdog restarting an App
  that looked unhealthy), to check the Supervisor log for who asked and why, and that if the watchdog
  asked, the App looked unhealthy to it, and that is what to fix, not the watchdog. Nothing rolls
  back by itself. Within a day of an update it carries the update line too, with the same words.
- **Every start together**: each kind of start above is counted in its own windows, so a loop that
  mixes kinds (5 asked restarts and 3 unseen ends in an hour) or paces one kind under its own limits
  would stay under each of them. One combined window counts them all, whatever the kind: each
  container start (plain, asked, or one of an update's own) and each restart of his session after an
  early exit, an unseen end or a late error exit. More than 8 in 60 minutes, or more than 12 in 24
  hours, is "Cain's App keeps starting", whose cause gives the counts by kind, for example "9 starts
  in an hour: 5 asked, 3 with no clean stop recorded, 1 plain". Within a day of an update it carries
  the update line too. The per-kind windows stay as they are. In short, the windows are: early exits,
  more than 3 in 30 minutes; unseen ends, more than 3 in 30 minutes, more than 6 in 60 minutes, or
  more than 8 in 24 hours; late error exits, more than 4 in 60 minutes; counted container starts, more
  than 3 in 30 minutes; asked restarts, more than 6 in 60 minutes, or more than 12 in 24 hours; every
  start together, more than 8 in 60 minutes, or more than 12 in 24 hours.
- **The line that names the update**: when a loop (early exits, unseen ends, container starts, asked restarts or every start together) begins
  within a day of a version change, a second alarm goes with it, for example: "Cain's session has
  exited early several times since the update to Cain 0.14.0, installed 3 hours ago. Nothing rolls
  back by itself. If a backup was made before the update, restoring it from Backups undoes the update
  and any changes since." Only then: past that day, no alarm mentions an update. It comes down once neither
  loop stands, and goes out again with each new loop.
- **A long turn**: "Cain's turn has been running for N minutes" adds "This may be normal for a long
  job."; it comes down when the turn ends.
- **Asked stops never count as crashes**: an owner's Stop, Restart or update from Home Assistant
  reaches the App's start script as a stop signal before anything else stops, and root records it as
  asked before his session ends. They count only in the asked-restart windows above (more than 6 in an
  hour, or more than 12 in a day) and in the combined window over every start, never as early exits or
  counted container starts. His session's own end by a signal, while the start script keeps running,
  is never asked: only the start script's own end by SIGTERM is, and his user can't signal it. Claude Code's own updater is off in this App (its version is pinned in
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
heartbeat ping (so the outside service alarms too) and raises
"Cain's probe folder isn't the App's alone", again each day while it lasts. Its cause names the failing path with its owner and mode in
plain words, for example "/run is owned by user 1000, mode 0777". The way out: restarting the App
sets its own folders up again and fixes what it can above them; if this alarm comes back with the same path, that path needs fixing by hand.

### Checking it on the Pi

`cain/tools/probe-drill.sh` (in the repository, run by your assistant from a shell with Docker, such
as Home Assistant's SSH App with protection mode off) has the drills. Run them, in order,
on the Pi after the install, before the alarms are relied on:

0. The probe's folders: each folder from `/run/cain/probe` and from `/data/probe` up to `/`, with
   its owner, its mode and the probe's verdict. Any refused folder fails the drill.
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
   and the mark it leaves is cleared. Each of the three prints how long the stop handler and the
   finish script took for every stop since it began, as the App measured them: the handler must stay
   under 6 seconds and the finish script under 4.
6. (0.15.0) Stop the plugin's server once: it runs again within seconds, the channel says connected
   again within 90 seconds, and his session isn't restarted for it.
7. (0.15.0, with the Watchdog switch on) First the gate: the Supervisor's health probe comes from an
   address in 172.30.32.0/23, gets 200, and the App's log shows no `/health` 404 for 3 minutes. Then
   the exit route: the App stops with exit code 3 and the Supervisor starts it again within a minute.
   The outside heartbeat hears a failure meanwhile, as expected. Until both pass, don't rely on the
   exit route.

The drill finds the container by its name (`app_<hash>_cain`, then `addon_<hash>_cain`; set
`CAIN_CONTAINER` to pick one), checks every tool a step uses before it starts, and kills through
`/proc` (the image has no `pkill`), inside that container only, and only the one process whose
program and arguments are exactly the ones named: two matches are refused and nothing is killed. Any
step reruns alone: `bash probe-drill.sh 1b`.

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
