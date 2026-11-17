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

Options you may change, none needed: `source_check_max_days` (7 by default, 1 to 90) is
how many days a source check counts before Cain's questions and Ship cards about that item
need a new one. `tap_read_ms` (1500 by default, 200 to 2500) is how long a tap may wait on
reading the record before it answers "Busy, tap again". If you change it, set tap_read_ms from the
measured p95: the install smoke test's `keeper.sh reads` prints `p95_ms`, and the limit should be
at least twice that (the reads fail loudly past half the limit).

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

## Cards and questions

- Cain asks one question at a time. The next one comes when you answer.
- Each card names what it's about (like "P08 Q2") and its buttons answer exactly that.
- Once a card stops mattering its buttons come off, and it says why: "You answered:
  Filed", "Expired" or "Replaced by a newer card". Cain's questions and Ship cards last
  until the next morning check-in (7:10 AM, at least two hours away); a Ship card also
  goes when its pull request changes or closes. One for a change that's already in main
  stays: your tap on it starts the install.
- Cain's questions about an open item, and his Ship cards, rest on a check at the
  source (your mail, a portal, GitHub) of that item's row as it stands, which the record
  keeper has accepted. The App posts nothing otherwise, and the check shows on the item's
  row in your record ("fresh, Nov 15, 2026 9:40 AM, stale after Nov 22: the county.gov
  receipt in your mail"). A check counts for 7 days (`source_check_max_days`, below). If
  the row changes after the card went up, its buttons come off: "Status changed, re-check
  needed", and a tap that comes before that does nothing. A one-off question isn't about an
  item and needs none, but the App refuses one that names one of your open items outright,
  and holds one that only sounds like one until Cain says why it isn't. The App proves a
  check was recorded, not that the source was read.
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
why not, or "Already in main" when main had that commit before your tap (nothing is pushed
then, and Ship only installs it). If GitHub doesn't answer, the card says it's waiting, and it lands by itself as
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
| `check` | `item`, `text`, `row`, `version` | A source check on an open row, sent by Cain's link (from `cain` only) when Cain asks with `--checked`. `row` and `version` are the row's ledger id and version as the link read them (`null` and `0` for a row the ledger didn't know). Taken only while they are still current, the row isn't pending a rewrite, and the keeper's clock is synchronized; otherwise rejected, naming what moved. `text`: one line, up to 300 characters, no `\|`, saying when and naming a concrete source (see Source checks); a repeat of the row's last check is rejected, quoting it. Never bumps the row's version. |
| `one-off` | `text`, `not_about_item`, `reason?` | A one-off ask Cain's link put to him (`--item none`), kept in `log/requests/`. `not_about_item` must be `true`: the link's declaration that it is about no open item. Rejected when `text` holds an open row's item code or its whole Item phrase (quoting what matched). When its words overlap an open row's Item more loosely (shared distinctive words), it needs `reason`, Cain's one line (up to 200 characters) on why it is about no open item, logged with it as `declared`; without one it is rejected, quoting the shared words. Writes nothing. |
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
  either end is refused, as is anything under `state/holds.json`, `state/checks.json`,
  `state/one-off-audit.md` or `state/notes`.
- Rows are matched by their item code (the `ID` cell), the one key between writes and
  the ledger. A whole-file write (`put` or `append`) of `state/PENDING.md` with an open
  row that has no item code, or with two open rows under one code, is refused in one
  line naming it.
- One row holds one fact: a `row-add`, or a `row` that sets `Item`, is refused when
  the new Item cell makes two completed-status claims about different subjects, naming
  both clauses. A whole-file write (`put` or `append`) lands whole or not at all: if any
  new or changed row bundles two statuses, the whole write is refused and the answer names
  each such row and its two clauses, so the writer fixes them and sends the complete file
  again. A row already in the open list that was refused that way has its check marked
  `pending_rewrite` in the ledger (its Checked cell says "pending rewrite"): asks and Ship
  cards on it are refused with that reason, and no new check is taken, until a write changes
  the row cleanly and it is checked again. A claim is a status word from a closed set (filed, sent, done, paid,
  issued, installed, confirmed, received, renewed, submitted, signed, mailed, delivered,
  cancelled, refunded, and "not" or "un" forms) that follows a noun-phrase subject in
  its clause and is not itself followed by a noun: "land-use packet not filed" and
  "license filed Nov 3" claim; "a signed lease", "landlord signed lease copy" and "filed
  and sent" don't. Clauses split at `, ; : ( )`, a full stop before a capital, "and",
  "but", "while", "though", " - " and " / ". Anything else passes; an Item with two or
  more status words that isn't refused is let through with a warning in the keeper's
  log. The coverage is limited (a word list, not a reader): a row it passes may still
  hold two things. Rows already in the record aren't rewritten; only new writes are
  checked.
- A row's `Next step` holds the current step and its latest source check; dated history
  goes in a note on the item (the `note` op). A `row-add`, a `row`, or a whole-file write
  whose new or changed Next step is over 800 characters is refused, saying so (a whole-file
  write lands whole or not at all, as above). A row already over 800 may shrink, never grow.
  800 is about four times a long step plus its check (a check is at most 300), and keeps a
  full open list well under the 60 KB file limit.

### Source checks: verified before he's asked

`state/checks.json` is the keeper's own ledger, per open row, keyed by its item code (the
`ID` cell: the one matching key, in row ops and whole-file writes alike):

- `id`: a hidden stable id the keeper gives the row the first time it writes the open
  list with it in. It survives Item edits and reordering and is never shown to him. A
  row that leaves the open table leaves the ledger, so one deleted in one write and added
  again in a later one under the same code gets a new id. Deleted and written again under
  the same code in one write, it reads as an edit of that row.
- `version`: 1 for a new id, and one more each time the row's content changes. Content
  is every cell but `Since` and `Checked`, compared trimmed with runs of spaces made one,
  against the row as committed under the same code. A `put` that changes no cell bumps
  nothing; one that changes one row bumps only it. A row whose Item changed under its code
  is bumped, so codes swapped between two rows in one write invalidate both checks. The
  `check` op never bumps its row.
- `changed`: when the version last went up (for the refusal's wording only).
- `checked`, `checked_version`, `checked_at`, `stale_after`, `checked_req`, `by`: the latest
  source check, the version it checked, the keeper's time for it, and when it stops counting
  (`checked_at` plus `source_check_max_days`, by the keeper's own clock).
- `hash`: the row's content as the keeper last wrote it. A row whose cells no longer match
  (changed outside the keeper: by hand, or by an earlier keeper after a rollback) doesn't
  rest a card, and the keeper's next round gives it a new version ("Source checks: P44
  changed outside the keeper").
- `aged`: set by the keeper when its clock passes `stale_after`, so the check never counts
  again whatever clock reads it later ("Source checks: P44 aged out").
- `pending_rewrite`: set when a whole-file write that changed the row was refused for it
  (above). Cleared when a write changes the row.
- `clock`: which clock source said the keeper's clock was synchronized when it took the
  check (`kernel`, `timedatectl`, `timesyncd` or `http-date`, below).
- `stepped_back`: set when the keeper's clock reads earlier than `checked_at` by more than
  10 seconds (the clock stepped back; the same skew margin as GitHub's Date header, below):
  the check never counts again. A gap within those 10 seconds is ordinary drift, and the check
  stands.

The file also holds `_generation`, a number that goes up by one with every write of the
ledger and never comes down: each write takes one more than both the file's number and the
keeper's own count, so even a copy reset to an older ledger never reuses a number. The
keeper's count is in its state file, `/data/record-holds.json`, which is in `/data`
outside the record's working copy (`/data/record`), so a re-clone of the copy leaves it alone.
If that file is lost too, the count is seeded from the highest generation the link has posted
on a card (the keeper reads the link's own state file, `/data/link/state.json`, read only), so
the generation never goes below a card that is up; and when the copy comes back with an older
ledger, the keeper writes it again above its count before anything else. The link puts the
generation on every ask and Ship card it posts, and a tap is refused (with the status-changed
reason) while the ledger's generation is below the card's: a ledger that went backwards can
never validate a card.

`Since` carries no status meaning: it is the day the row was added, never read for
freshness, and a row from before the ledger starts at version 1 with no check whatever it
says.

A check is fresh while `checked_version` is the row's `version`, the row's cells match
`hash`, it isn't `aged`, `stepped_back` or pending a rewrite, `stale_after` hasn't passed,
and the clock doesn't read earlier than `checked_at` by more than 10 seconds. Otherwise it is
stale and the link refuses to rest a card on it.

The keeper dates and ages checks by its own clock only, never the link's, and only while
that clock is synchronized. Four sources, in this order (`clock.ts`); any one that says
synchronized is enough, and the keeper records which one did (with each check, and in its
status file):

1. The kernel's own flag, through `adjtimex` (read only; the App's container shares the
   host's kernel). This is the one that works on the Pi: measured inside the Cain App's
   container on Home Assistant OS, `timedatectl` isn't installed and systemd's time-sync
   flag files don't exist, while `adjtimex` reported state 0, status 8193, STA_UNSYNC clear
   (synchronized), with the system clock within about 8 seconds of GitHub's HTTP Date
   header. So it is read first.
2. `timedatectl`'s NTPSynchronized, when it is installed and answers.
3. systemd-timesyncd's flag file.
4. The HTTP Date header of the round's own fetch from GitHub: synchronized when it is
   within 10 seconds of the system clock (the header has one-second resolution and the
   fetch takes a moment; a clock that was never set is off by days).

When none qualifies, the keeper logs one diagnostic naming what each source returned
(absent, unreadable, unsynced, the skew), once each time that changes ("clock: not
synchronized, so no source check is taken: no clock source says synchronized: kernel flag
unsynced (...), timedatectl absent, timesyncd flag file absent, GitHub Date header unsynced
(+42 s)"), every `check` is rejected with that diagnostic in its reason (which keeper.sh's
refusal line relays to Cain), and nothing ages. A tap also needs the clock synchronized at
tap time (below), and a check whose time is later than the clock now reads by more than the
10-second skew margin (a backward step) is invalidated: the link refuses taps on it at once and
the keeper marks it `stepped_back` ("Source checks: P44 dated after the clock stepped back").
Within the margin the check stands. Each round that has GitHub's Date header, the keeper logs
its measured offset ("clock: offset against GitHub's Date header +8 s"). The keeper's and the
link's log lines are also copied to `/data/work/record-keeper.log` and `/data/work/link.log`
(about 1 MB each), for the smoke test.

The open table's `Checked` column is a projection of the ledger: made again on every write
of the open list (row ops and whole-file puts alike), added the first time it's missing,
and never read back from what a writer sends. Each cell says fresh or stale (by version),
the check's day with its year (and the time, when the check and the row's last change fall
on the same day), the day it goes stale by age, then what was checked: "fresh, Nov 15,
2026 9:40 AM, stale after Nov 22: the county.gov receipt in his mail".

A check's text is one line, up to 300 characters, no `|`; dates, ISO times, shas, job ids
and codes are fine in it. It says when, and names a concrete source: a mail (its sender's
domain and its date), a page or portal by name, a file path, a command, or a message.
Vague sources ("memory", "earlier", "I recall", "I remember") are refused with a one-line
reason. A repeat of the row's last check (the same words once case, punctuation and digits
are set aside, with no later time in it) is refused; the same wording with a later time is
a new check. The gate proves a check was recorded, not that it was true: Cain is held to
naming a source, and the record shows what he named.

What Cain's link enforces:

- An ask or a Ship card for an item (anything but `--item none`) needs a fresh check:
  passed now with `--checked`, or already in the ledger. Otherwise one line: "No source
  check on this item since its row changed on Nov 13; add --checked ...", or that its
  check went stale by age.
- A check passed now goes into the keeper's local queue as a `check` request from cain
  carrying the row's id and version as read (so it shows in `log/requests/`), and the
  link waits up to 30 seconds for the keeper's outcome. The wait measures the keeper's
  local work only: it writes the outcome (with `round_ms`, the round's local time) once its
  local commit and ledger write are made, and the push to GitHub runs after, so a slow push
  never refuses a question. The ledger the link reads is the keeper's local copy
  (`/data/record`). Only an accepted check, that the ledger shows on the row's current
  version, lets the card go. If the keeper rejects it, fails, or doesn't answer in time,
  nothing is posted and Cain is told why in one line. A timeout is logged with its request
  id in `/data/record-waits.jsonl`; the keeper logs the round's time for it and counts the
  week's timeouts in `state/one-off-audit.md`. A check still pending then may land later: a
  later ask finds it in the ledger, but the pending copy never posts a card. If the link
  can't hand the check to the queue at all, nothing is posted either. A round whose fetch
  from GitHub fails works on the local copy as it is, so a GitHub outage doesn't refuse a
  question either (see When a push fails, below).
- Right before posting, the link reads the row's version again and refuses (or, for a
  held ask, drops it and tells Cain) when the check no longer counts.
- A posted, unanswered ask or Ship card for an item loses its buttons when the row's
  version changes, its check ages out or goes pending a rewrite, or the keeper's outcome
  for its check reads anything but done: the link edits it to say "Status changed,
  re-check needed" and tells Cain. The sweep does this only after a verified read of an
  intact ledger and working copy: the ledger parses, its generation isn't below the last one
  a verified read saw, the open list, the keeper's status and the check's outcome file are
  readable, the keeper hasn't reset its copy, and no push has failed (or failed in the last 2
  minutes). A read that isn't verified leaves the card as it is, logged once; so does a held
  ask, which waits instead of being dropped.
- A tap on an ask or Ship card for an item is acknowledged to Discord at once with a deferred
  answer, so Discord's 3 seconds never run out whatever the read does; the card's edit and any
  refusal line follow through the interaction's webhook. The tap is honoured only after a fresh
  read of the keeper's local ledger, its status file and the check's outcome file confirms the check's outcome is done,
  the row's hidden id and version are the card's, its cells match, the check is unexpired
  and not dated after the clock now reads, the ledger's generation is no lower than the
  card's, and the clock is synchronized now. The tap reasons, each refused with the card's
  buttons kept unless it says otherwise:
  - status changed: the row moved, the check aged out or stepped back, or its outcome isn't
    done. "Its status changed since it was checked, so nothing was done.", and the buttons
    come off ("Status changed, re-check needed").
  - status unreadable: a read failed, or the ledger is behind the card's generation. The
    same status-changed words; the sweep judges the card later.
  - busy: the read took longer than the App's `tap_read_ms` option (1500 milliseconds unless
    you change it; Discord wants an answer within 3 seconds), or another tap's read is still in
    flight. The
    limit is enforced on the read itself: it is raced against a timer and cancelled through an
    abort signal when the timer wins, so a stalled read answers within the limit (tuned from the
    measured reads the smoke test prints). "Busy, tap again." Each is logged to `/data/record-waits.jsonl` and counted in
    `state/one-off-audit.md` as a tap timeout.
  - clock: the box's clock isn't synchronized now (the keeper's verdict from the last 10
    minutes says it isn't, or neither the box's own sources nor that verdict says it is).
    "The box's clock isn't synchronized just now, so nothing was done. Tap again in a few
    minutes."
  - record reset: the keeper had to reset its copy and hasn't pushed since. "Cain's record
    is being put back in step, so nothing was done. Tap again in a few minutes."
  - record unpushed: the keeper's pushes have been failing for over 30 minutes. "Cain's
    record hasn't saved for over half an hour, so nothing was done. Tap again once it has."
  - record reset since: the card was stamped with an epoch other than the keeper's current one
    (below): equality, not ordering, so a status that came back with an older epoch never
    validates it.
    "Cain's record was reset after this was asked, so nothing was done. Cain will check it again
    and ask again if it still needs you." The sweep takes its buttons off on its next verified
    read ("Record reset since, re-check needed") and tells Cain to ask again once the keeper has
    accepted the item's re-check.
  - ship unpushed: a tap on a Ship card while the keeper's status says unpushed at all, however
    short the failure, since Ship can't be undone. "Cain's record has unsaved changes, so Ship
    waits. Tap again once they're saved, in a minute or two." Taps on asks keep the journal path
    below. Known limitation: any unsaved change holds a Ship tap, not only one about the Ship
    card's item, since the keeper's status has one unpushed flag for the whole record.
  Where the row sits in the table is never used.

  Each tap is decided exactly once. One settle guard per read decides between busy and honoured,
  once, before anything is done: a read that finishes after the limit, by a millisecond or because
  it ignored its cancellation, is busy for good, and that attempt is never honoured later. At most
  one fresh read is in flight: while one is pending, another tap answers busy at once without
  starting a read. That guard can't wedge: a read still pending after 30 seconds is killed (its
  file reads aborted, and anything it spawned killed as a process group; today's reads are file
  reads in the link's own process, so there is nothing to spawn) and its slot is released by a
  timer that doesn't wait for the read to settle, with one log line. Two taps on one card at once
  (on different buttons, say) are handled one at a time: the second starts no read, waits for the
  first, and is answered with the first one's recorded outcome, so exactly one is honoured. If the
  first hasn't settled by the read limit, the second answers "Busy, tap again." at once: it never
  reads a claim the first is still writing and never starts a second action. A busy
  answer (and every refusal that keeps the buttons) patches the card's original message back as it
  was through the interaction's webhook, so its buttons are live again, and the reason follows to
  you alone; when that patch fails, or Discord answers with another message's id, the link edits
  the card by its channel and message id with the bot's token instead. The link posts cards as the
  bot, so a bot-token edit of a card's components is allowed (Discord lets the author edit its own
  message); the install smoke test forces the webhook patch to fail once on real Discord and checks
  the buttons come back that way. Each honoured tap gets an
  idempotency key (the card, its ledger generation, its check's request id, the item and the
  label), written to the link's state in the same atomic save that marks the card answered,
  before Cain is told or a landing starts. A retap or a Discord retry with the same key returns
  the recorded outcome and does nothing again. If the link stops partway, its next sweep finishes
  the claim from that record: a claim not yet acted on is acted on once, and one acted on but not
  yet shown gets only its card edit.

  Claims across a restart, by run (since round 9). Each start of the link raises a run counter in
  its state file by one, durably, before it acts on anything, and each claim records the run it was
  made in. A claim from an earlier run (this version before a restart, or with the previous version
  having run on the state in between) is either completed through the live-tap predicate or
  discarded, judged never by file times or save stamps, so a clock step either way changes
  nothing. The predicate: the card is still as the claim left it (answered with that label), and the
  check it rests on gets exactly the verdict a live tap would get now. A claim that passes is acted
  on once, its line marked as a possible repeat. One that fails (its status changed, the record was
  reset, its card was changed or is gone) is discarded, never acted: you get one line on the card's
  thread ("Your tap was not acted on after a restart; a new card follows."), Cain gets one "Tap not
  acted" line with its tap key, each once, the card shows "Not acted after a restart, re-check
  needed", and the item goes on the link's re-check queue. One that can't be judged now (a read that
  failed, a reset standing, the clock, a push hold) waits for the next sweep. The re-check queue is
  the link's own list of items whose tap was lost or not acted on; an item leaves it once a new
  check of it is accepted, and `keeper.sh clock` lists it (`recheck_queue`).

  Claims compare on a per-start nonce (round 10), not on ordering. Each start also makes a random
  nonce, saved with the run counter, and each claim records it. A claim whose nonce isn't the current
  run's is an earlier-run claim, whatever its run number: a state file restored from a backup to an
  older counter can make this run's number equal an outstanding claim's, but never its nonce, so such
  a claim still goes through the live-tap predicate (tested with a state restored to an older counter
  and an outstanding claim, both when its card no longer holds up and when it does).

  The key travels on. Cain's relayed line for the tap ends with its short form ("Tap key
  tap-1a2b3c4d5e6f."). A line relayed again from a claim after a restart (the link may have been
  cut off between telling Cain and recording that it did) starts "Repeat of tap key ...: if you
  already had a line with this tap key, ignore this one.", so Cain acts on a tap key once. A record
  request Cain sends because of a tap carries its tap key (a `tap` field, "tap-" and 12 hex
  digits); the keeper takes one request per key and refuses a second request citing a key already
  acted on ("tap key ... was already acted on by request ..."). Since round 9 the key is required
  on Cain's requests of the kinds that can come from a tap: a `row-close`, a `take` for a Ship job
  (its job starts "ship"), and a `put` or `append` to a `decisions.md` (where Cain's rules record
  his tapped answer). One of those without `tap` is rejected ("tap key required: ..."); one that
  didn't come from a tap says `"tap": "none"` (never for a Ship take, which always follows his Ship
  tap). Laptop sessions get no taps and aren't asked for one. The keeper keeps the consumed keys in
  its own state file (`/data/record-holds.json`, outside the working copy), so no reset or re-clone
  forgets one; the request's own replay after a reset is not a second request. A consumed key is
  pruned once it is older than `TAP_KEEP_MS` (3 days: the longest card lifetime, until the morning
  check-in after next, under two days, plus a margin), except a key whose landing the link still
  lists as unresolved. Since round 11 each consumed key is also appended, fsynced, to the keeper's
  own append-only log (`/data/record-taps.jsonl`, one framed record per key with its request and time since round 12, outside
  the working copy and apart from the link's state). That log is never pruned or rewritten, so a key is
  refused a second time whatever happens to the state file or to the link's state.

  The link's issued tap keys (round 10). Each tap key the link issues is listed in its state file
  (`/data/link/state.json`, `issued`, by the key's short form) with its card's item (NONE for a
  one-off), its kind (ask or ship) and the label he tapped, in the same save as the tap's claim,
  before Cain hears of it. The record keeper reads that list (read only, as it reads the link's
  generation) and refuses a request whose tap key the link didn't issue ("isn't one the link
  issued"), one that names an item other than the card's (or, for ops that name no item, like an
  append to a `decisions.md`, whose text doesn't mention the card's item), and a take for a Ship job
  whose key isn't a Ship card's Ship tap. While the list can't be read, a request with a tap key is
  refused and sent again under a new id. Only `"tap": "none"` (no tap) stays on Cain's word. The link
  lists an issued key for `TAP_ISSUED_KEEP_MS` (4 days), longer while its landing is unresolved.

  Structured targets (round 11). With each issued key the link also records its card's message id
  and a target: the card's item and the writes its tap allows. A Ship card's Ship tap allows
  `ship-take` (the take for the Ship job); its Not now, and a question about no open item, allow
  `decision` (a write to a `decisions.md`); a question about an item allows `row-close` on that item
  and `decision`. The keeper matches a request with a tap key on that target, never on the request's
  text: each tap-derived op must be a write the target allows, on the target's item, and any other op
  naming an item must name the target's. So a decision written in Cain's own words passes, while a
  row closed from a Ship tap, or a Ship take from a question, is refused. A refusal gives Cain the
  specific reason in the keeper's usual line, and you get one line on the card's thread ("Your tap
  couldn't be recorded as it was; Cain has the reason and will sort it out."), through the keeper's
  status file (`tap_notices`), which the link reads and tells once.

  Taps lost to a restore of the link's state (round 11). The keeper remembers the issued keys it has
  seen (3 days, inside the link's own 4) and the link's run counter and per-start nonce. A link state with a lower run than it
  last saw, or the same run with another nonce, came back from an older copy. A request whose key the
  keeper saw issued but the restored state no longer lists is not refused as unknown: it is marked
  lost ("tap key ... was lost: the link's state was restored from an older copy ..."), Cain hears so
  with what to do (record nothing from that tap, ask again once the item's re-check is accepted), and
  you get one line on the card's thread ("Your tap was lost when the App's state was restored from an
  older copy, please answer again.").

  The landing ledger. A Ship tap's landing carries the key to the link's landing ledger
  (`/data/record-landings/`, outside the record's working copy, one file per key, made with an
  exclusive create). The claim file and its directory are fsynced before the first push attempt.
  The ledger takes a key once and rejects a second landing with the same key, so a landing a
  restart cut off is never started again. Such an orphan is settled against the remote, never the
  link's local copy. Where the token lives: the landing's token is the pull request's head commit
  itself. The link pushes exactly that commit to main as a fast-forward, so it writes no trailer or
  commit of its own (one would change the commit the checks passed on); its claim records main's
  tip as GitHub had it just before the push (the base commit). How settlement looks for it
  (`merge.ts` `settledFrom`): a fetch of main, and first whether the head is reachable from the remote
  tip: if it is, landed, and a landed verdict needs no base (the head commit is the token), so a
  rewritten main that still has the head, or a shallow copy that holds it, settles as landed (round
  10). Only to decide did not land does it search from the landing's recorded base commit to the
  remote tip (the whole of main, no depth, and a shallow copy deepened to full history): the base an
  ancestor of the tip and the head not, did not land. If that range is unavailable (the fetch fails, a shallow copy that can't
  be deepened, a rewritten main where the base is gone or is no longer an ancestor of the tip), the
  key stays unresolved, treated as below, never as did not land. In main: landed, with its Ship
  token. Not in main: the landing is abandoned, and you get one line on the card's thread ("The
  install was interrupted by a restart and did not land; a new card follows.") while Cain gets a
  "Landing abandoned" line and shows a new Ship card for the same pull request and head.

  An unreachable remote never wedges a landing silently (round 9). While the remote can't settle a
  key, the card stays as it is and no new Ship card for that pull request and head goes out, and
  the sweep looks again by itself on a bounded backoff (1, 2, 4, then every 5 minutes), needing no
  tap or restart; the remote check of a restored or untrusted ledger backs off the same way. After
  `UNRESOLVED_TELL_FAILS` failures (5) or `UNRESOLVED_TELL_MS` since the first (15 minutes),
  whichever comes first, you get one line on the card's thread ("Landing unconfirmed: main's remote
  has been unreachable since 9:05 AM, retrying.", or "main's history couldn't be searched" when the
  range is the trouble) and Cain one "Landing unconfirmed" line, each once. `keeper.sh clock` lists
  each unresolved key (`unresolved_landings`: its tap key, age in minutes, failures and last error).
  When the remote comes back the key settles and the usual outcome follows: landed, or abandoned
  with its told-once lines and a new card. An abandoned key is settled against the remote before
  anything else (round 10): first thing in each sweep once it is due on its backoff, and at once when
  Cain asks for a new Ship card for that pull request and head. A landed result posts the landed
  outcome (Cain's Ship token line and the card's landed words) and refuses the new card; only a
  definite did-not-land lets a new card out.

  Reconciling a landing by hand (round 10). If the range can never be searched again (main was
  rewritten, so the base is gone and the head isn't there either), the key stays unresolved and
  `keeper.sh clock` keeps listing it. Then:
  1. What to look at: the key's line in `keeper.sh clock` (`unresolved_landings`: its tap key, age and
     last error), the pull request and head from Cain's "Landing unconfirmed" line, and on GitHub
     (from a laptop) whether main has that change: the pull request's page says merged or not, and
     main's history shows the change's commit or its content.
  2. How to decide: landed if main has the change (the commit, or the same content landed another
     way); not landed if it doesn't. If in doubt, not landed: a new Ship card for the same head
     finds anything already in main and pushes nothing.
  3. The command: you send Cain in his DM exactly `settle <tap key> landed` or `settle <tap key>
     not-landed` (round 11: that form only, naming that key, with not-landed as one word; the daily
     reminder gives you both lines ready to copy), and he runs `keeper.sh settle <tap key>
     landed|not-landed --said <his message id>` with the id of that message of yours. It is yours
     alone: the link reads that message from your DM itself and settles only on a message of yours
     under a day old of that exact form, naming the same key and verdict as the command. A message
     naming another key, saying both verdicts, or writing "not landed" as two words where the command
     says landed is refused with the reason. Each message settles one key once: its id is recorded as
     consumed (in the link's state and in the ledger's settled entry, so a restore of the link's state
     doesn't forget it) and refused on reuse. The link's log gets an audit line (the key, the verdict, your message and the key's
     failures), and Cain gets a "Landing settled by Dane" line, then the usual outcome line: landed,
     with the Ship token while your tap is under 2 hours old, or not landed, with "a new card
     follows". A key the link doesn't list as unresolved (or as a tombstone) can't be settled this
     way. Ledger pruning at 30 days and tap-key pruning at 3 days never remove an unresolved key or a
     tombstone.

  Unresolved keys over days (round 11). After the first "Landing unconfirmed" line, you are told
  again on the card's thread on its first unconfirmed day, with the exact settle lines and a pointer to
  this section ("Reconciling a landing by hand"); then in one digest for every unresolved key, daily
  for 7 days, then weekly (round 12, below). `keeper.sh clock` lists each one
  under `unresolved_landings` with its two settle lines. Past 7 days Cain gets one alert line. Past
  90 days the key becomes a tombstone: it keeps its record (its entry in the link's state, its ledger
  file and its issued key), `keeper.sh clock` lists it under `tombstoned_landings`, it is no longer
  looked for on the remote, and it no longer blocks a new Ship card for that pull request and head.
  You can still settle a tombstone by hand.

  One landing per head (round 11). When a key you settled by hand is followed by a real landing of
  the same head, the ledger links the forced entry to that landing, and the reconciliation
  (`keeper.sh clock`, `landings_by_head`) shows one landing per head: the real landing over the
  forced one. Also, a reset that arrives during the push does not undo the landing and is reported as
  landed: once the claim is made the push goes on, and the outcome is what main says.

  Issued tap keys, made durable before a card can be tapped (round 12). When an ask or Ship card
  posts, the link appends one record per button to its issued-key log (`/data/link-issued.log`, outside
  its restorable state `/data/link/state.json`): the tap key, its structured target (the card's item
  and the writes its tap allows) and the card's Discord message id, each record fsynced before the
  card's own record is saved, so no tap on it counts before its key is durable.

  The issuance order (round 13). A card with buttons is posted without buttons first. Then its keys,
  each with its button's custom id, its expiry and the message id Discord returned, are appended and
  fsynced to the issued-key log; then the link's state is saved; only then are the buttons edited on,
  and an `armed` record is logged. So a card can't be tapped before its keys and its record are both
  durable. If the log write fails, the card never gets buttons and says so ("This card couldn't be made
  tappable"), and the ask is refused ("ask again in a minute"). If the state save fails after the keys
  were logged, a `void` record is logged, the card says it was withdrawn, and a later tap on it is
  told the card was withdrawn (the keeper refuses its key without using it up). If the button edit
  fails, you get one line on the card saying its buttons are on their way; at the link's next start
  they are put on from the log, with one more line saying they're on. A crash between any two steps
  is covered the same way at the next start: keys logged but no saved record is withdrawn; a saved
  record with no buttons gets them. The record
  keeper reads that log each round (the same round that takes the check, or the next) and mirrors
  every key into its own append-only log (`/data/record-issued.log`); a key in neither log is forged
  or stale ("isn't one the link issued"). A key in the log that the link's state no longer lists was
  lost to a restore of that state: the request citing it comes back "was lost", Cain hears it, and
  the link posts "Your tap was lost when the App's state was restored from an older copy, please
  answer again." on that card's own thread (its message id comes from the log). A tap on a card the
  restored state no longer knows, but whose keys are in the log, is told the same way, once. After a
  whole-image restore the log may have lost the card too (round 13): a tap on a card the bot authored,
  with a well-formed button id, is still told as lost, never as forged, when the keeper's mirror has
  its message id, or the record remote's history does (each tap-derived commit also carries
  `Tap-Card: <message id>`, listed in the keeper's status), or it is newer than every card the
  restored state and log know (the restore's boundary). Any other unknown card's tap is "not a card
  the link knows". Issued
  keys are kept for their whole actionable life, until consumed or tombstoned plus a margin
  (`TAP_ISSUED_KEEP_MS`, 100 days), the same on the link (its log and its state) and on the keeper
  (its mirror), so a restore on day 4, 10 or 89 is told as lost, never refused as not issued.

  Expiry (round 13). When a card's keys expire, its buttons come off by the message id in the
  issued-key log, with an "Expired" line added, even on a card the link's state no longer knows, and
  the card goes into a compact expired-key index (`/data/link-expired.log`, one record per card, not per
  key). A late tap on it is told it expired. Retention is aligned at 100 days: issued keys (the link's
  log and state, the keeper's mirror), and tombstones. A landing unresolved past 90 days becomes a
  tombstone; at 100 days from its first failure the tombstone and its issued key are forgotten
  together, `keeper.sh clock` lists it under `expired_landings`, Cain hears one line, and it can no
  longer be settled by hand.

  The run counter (round 12). Each start of the link raises its run counter and makes a new nonce,
  fsynced in its state before any key is issued or any request is sent under that run, then logs the
  run and nonce in the issued-key log. A run number the keeper has never seen (a gap, because a start
  died before its first issuance) is a restart; a run number logged twice with another nonce is a
  restore of the link's state.

  Restores: which are covered and how (round 12).
  - The link's state alone (`/data/link/state.json` from an older copy): its issued keys come back
    from the issued-key log and the keeper's mirror, taps on its cards are told as lost on each card,
    and consumed keys are the keeper's, so none counts twice.
  - The keeper's state alone (`/data/record-holds.json`): consumed keys are in its append-only log
    (`/data/record-taps.jsonl`) and in the record remote's history. Every tap-derived commit carries
    its key in a commit trailer, `Tap-Key: tap-<12 hex>` (with its request id as `Tap-Request`), and
    at the keeper's start, after its state or copy was lost, and after a detected restore of the link's
    state, the keeper rebuilds its consumed set from the remote's history (git log trailers),
    appending each key the log lacks, and refuses those keys too.
  - The whole image (all of `/data` from a backup taken before the tap): the logs come back as old as
    the state, so the remote's history is what remembers the key, and the rebuild at start refuses it.
    A whole-image restore is what Home Assistant's App backup does.
  The append-only logs (issued keys, the keeper's mirror, consumed keys, and the landing ledger's
  settle log) are framed: one record per line, `<length>:<CRC-32>:<JSON>`, each appended and fsynced.
  At start a torn final record (a write cut short by a power cut) is truncated, with one logged line
  and one line to Cain; the records before it stand. The keeper keeps each of its logs' high-water
  record counts in its state (consumed keys, its mirror, the install log), counted only after each
  record's fsync; a new log's folder is fsynced when the log is created.

  Degraded start and recovery (round 13). A log missing, or shorter than its high-water count, or the
  keeper's state missing (a partial restore, or a wiped image), is a detected restore, never a refusal:
  the keeper starts degraded, rebuilds its consumed set from the record remote's trailers and its
  issued set from the surviving mirror or the link's log, resets its counts, logs and relays one line
  (Cain hears "detected a restore"), and holds every request that carries a tap key until the rebuild
  completes. A partial restore in the other direction (the state older than the logs) loses nothing:
  the counts move up. The keeper refuses to start only for a case no rule explains (a log that can't be
  read, or one with a damaged record before its end); then Cain runs `keeper.sh recover-logs`, which
  only proposes: the link sends you the exact line `recover logs <code>` (round 14, below), and if you
  agree you send it in your DM. Cain runs `keeper.sh recover-logs --said <that message's
  id>`: the link checks it is your own message, under a day old, exactly that line, used once (written
  to the landing ledger like a settle), and leaves it for the keeper, which moves the damaged log aside
  and goes on only once its rebuild is verified against the record remote.

  The remote-down hold (round 13). The rebuild counts only against a fresh fetch of the record remote.
  While GitHub doesn't answer, the keeper still starts, but every request that carries a tap key is
  held (consumed set unverified): it stays in Cain's queue, untouched, and Cain gets one "Pending: your
  request ..." line for it. Hand settles are held too (`keeper.sh settle` answers pending, nothing
  settled). `keeper.sh clock` shows `consumed_unverified` with its tries, and you get one notice per
  outage once a round has tried. It retries each round GitHub could answer, logging on a backoff (1,
  2, 4 up to 30 minutes). Ask cards keep posting. Once the rebuild completes, the held requests are
  decided again: a key already acted on is refused, a fresh one acts once.

  The hand settle in the ledger first (round 12). A hand settle's entry, with your consumed message
  id, is appended to the landing ledger's settle log (`settled.log` in the ledger's folder) in one
  fsynced append before any effect: the landed or abandoned outcome, Cain's lines, and the link
  state's copy, which only mirrors it. A crash before that append settles nothing (the same message
  settles it when run again); a crash after it is finished from the ledger on the next sweep, once. A
  message in the settle log can never settle a second key.

  Settle messages as copied (round 12). Copying from the reminder on a phone is forgiven: backticks or
  a code fence around the line are taken off, non-breaking and zero-width spaces are normalised, an
  en or em dash counts as the hyphen in not-landed, and capitals don't matter. The key match and the
  single verdict stay strict, and a refusal shows the text as received, normalised. The reminder shows
  both lines, each in its own code block.

  A target mismatch doesn't use the key up (round 12). A request whose write isn't one its key's card
  allows is refused with the reason, and the key stays unused: Cain sends the write the card allows
  with the same key, or routes any other write as an ordinary request (`"tap": "none"`) with its
  source check redone. You get one line on the card saying your answer stands and there is nothing to
  do.

  Reminders taper (round 12). An unresolved landing gets one line on its card's thread on its first
  unconfirmed day; after that, one digest message lists every unresolved key with its two settle
  lines, daily for 7 days, then weekly. `keeper.sh clock` lists them all as before.

  Install taps behind a flag (round 12). Until install taps are on, a Ship tap lands nothing: it
  answers "Installs wait for the post-install tests" and the card keeps its buttons, and Cain hears it.
  The durable install flag (round 13): the flag and each once use are framed, fsynced records in a
  keeper-owned log (`/data/record-install.log`), covered by the keeper's high-water and rebuild logic,
  and read as off when it is missing, corrupt or unreadable. After any restore that lost install
  records the keeper appends off itself, so the flag stays off after an image restore. Install taps
  turn on only through your own line: `keeper.sh install-taps on` only proposes, and only once the
  post-install tests' result file (`/data/work/install-tests.json`, which Cain writes from the smoke
  test and the resilience run) names the full head they ran on and says both passed, each dated within
  7 days. Then the link sends you the exact line `install taps on <code>` (round 14, below); once you send it, Cain runs
  `keeper.sh install-taps on --said <that message's id>`, and it is on: your line is used once and
  written to the landing ledger like a settle, and the flag record names the tests' head.
  `keeper.sh install-taps once` (Cain's) lets exactly one Ship tap through, for the pull-the-plug case:
  that use is appended to the install log before the landing ledger's first write, so a crash anywhere
  after it can't let a second Ship tap through, and the landing's take carries `Install-Once: <tap key>`
  as a commit trailer. `keeper.sh install-taps off` (Cain's) stops them. `keeper.sh clock` shows
  `install_taps` (on, once or off) and why.

  The combined fault scenario (round 13). Before install taps turn on, you run one combined fault
  scenario on the Pi, with Cain, after the smoke test and the resilience run: a checked test ask and a
  Ship card for a real Ship you mean to make are up (never a test card: one already in main pushes
  nothing); Cain arms `keeper.sh install-taps once`; you
  tap Ship and pull the Pi's power right after; with the Pi off its network (so GitHub can't be
  reached) you power it on: the keeper starts and `keeper.sh clock` shows `consumed_unverified`, a
  tap on the test ask comes back held ("Pending"), and a second Ship tap answers that installs wait;
  then the network comes back: the landing settles once, the held tap is decided once, and the clock
  shows `install_taps` off and no `consumed_unverified`. Cain records the result in the result file.
  The design is frozen for this scenario: nothing new is added before it runs.

  The re-arm at start (round 14). A card whose buttons didn't go on at its post is armed at the next
  start only after the link re-runs every arming check. First, every card in the issued-key log with no
  durable state record (and no armed or void record) gets a void record and the Withdrawn line, before
  anything else runs; a tap on such a card, even before that sweep, is refused as withdrawn and its
  void record written then. Then, for each card left, its state record is saved again first (a save
  that fails withdraws it instead: a void record and the Withdrawn line), and the card must not be
  voided or expired (its keys' expiry, or its own), its source check must be accepted for its row's
  current version (the same judgement a tap gets; a read that can't decide now leaves it for the next
  sweep), and none of its keys may be consumed or tapped already. A card that fails gets the Expired
  line (and goes into the expired-key index) or the Withdrawn line (with a void record, so the keeper
  refuses its keys, and one line to Cain) instead of its buttons.

  The consumed set at every start (round 14). The keeper rebuilds its consumed tap keys from the union
  of the local copy's trailers on every ref (its branches, unpushed commits included), the record
  remote's trailers (just fetched) and the link's landing ledger (`/data/record-landings`, read only):
  any key whose ledger entry shows a started landing (a claim that wasn't voided) counts as consumed,
  and the Ship take that follows that landing still goes once, as the landing's own write. Every start
  of the keeper treats its consumed set as unverified until a fresh fetch has merged the remote's
  trailers: until then `keeper.sh clock` shows `consumed_unverified` (an ordinary start's reason is
  "a start", not a restore) and every request that carries a tap key is held under the remote-down rule
  above. With GitHub answering, that is one round.

  The durable held queue (round 14). While the keeper's consumed set is unverified, a tap on an ask is
  held by the link: a framed, fsynced record in `/data/link-held.log`, stamped with its tap time and the
  row and check version it was judged against, written before the card says it is held. The card shows
  your answer with a line saying it is held and will act by itself or say why not; Cain hears it is held
  and records nothing yet. A Ship tap isn't held: it waits, its buttons kept, and says so. Each sweep,
  once the keeper is verified, each held tap is judged again: expiry by its tap time (a tap made before
  its card expired still acts), and a row whose version changed since is told on the card as not acted
  because the item changed (Cain gets "Tap not acted: ..."). One that passes is relayed to Cain with its
  tap key, its release marked first (round 15, below: a crash repeats it only flagged as a replay, and
  the keeper's one request per tap key keeps it to one effect). Held requests in the keeper's queue are Cain's own files, and stay
  there across a kill of either process.

  Every path says so on the card (round 14). Each tap is answered at once, and each hold or refusal puts
  its own line on the card: held (Cain's record can't yet verify which taps were acted on; your answer
  acts by itself or you're told why), withdrawn, expired, lost in a restore, and already acted on (the
  keeper's consumed-key log, `/data/record-taps.jsonl`, read by the link). The owner's notice that taps
  wait goes when the first tap is held, not only after a round has tried.

  Expiry by the keeper, the removal queue and the post-restore sweep (round 14). The keeper refuses any
  tap key whose tap came after the expiry its issued record carries, whatever the buttons showed, without
  using the key up, and the link tells you on the card that it expired; the tap time is a held tap's from
  `/data/link-held.log`, else the link's own record of the tap. The link indexes an expired card first,
  then takes its buttons off through a durable removal queue (`/data/link-strip.log`, framed and
  fsynced) that is retried each sweep until Discord takes the edit, so a tap while an edit is failing
  is still told it expired. After a detected restore (an armed card in the issued-key log the state
  doesn't know, a lost tap, or the keeper's own detected restore), the link looks over the bot's
  messages in your DM once (round 15: paged back to the 100-day card horizon) and takes the buttons off any card the rebuilt state and log don't know, with
  a line saying it was lost in a restore of the App's state; a card past 100 days (one a `Tap-Card`
  trailer names included) is told expired, not lost.

  Your lines carry a code (round 14). `keeper.sh install-taps on` and `keeper.sh recover-logs` without
  `--said` only propose: the link makes a fresh code, binds it to the keeper's current reset epoch and
  to this start of the link, and sends you `install taps on <code>` or `recover logs <code>`, naming the
  epoch. Your line counts only if its code belongs to a proposal made since the link's current start,
  in the same epoch, not used before (the proposal is marked used in the link's state before any
  effect), and only as a live message sent after the proposal: a line read back from older history never
  counts. Each use goes into the record in its own commit with an `Owner-Line: <kind> <code>` trailer,
  and the used codes are rebuilt from those trailers after any restore (`keeper.sh clock` shows
  `used_lines`), so a restored ledger can't make an old line count again.

  The combined fault scenario, round 14. On top of the steps above, it now includes: a real power cut
  during issuance (pull the plug while Cain posts a checked test ask; after the restart the card either
  has its buttons, re-armed after every check, or says it was withdrawn, and a tap on a withdrawn one
  does nothing); a real power cut during a landing (as above, with install-taps once); and a rebuild
  over SSH with the remote unreachable (with the Pi off its network, move the keeper's state and its
  consumed log aside over SSH and restart the App: the keeper starts degraded, a tap on a test ask
  comes back held on the card, and once the network is back the held tap acts exactly once and a
  repeat of it is refused).

  Round 15 (the fifteenth review's fixes; the design stays frozen for the combined fault scenario, and
  no new store was added).

  Your recover line works whatever state the keeper is in. `keeper.sh recover-logs` is exempt from the
  unverified hold: it can be proposed and accepted while the keeper is in its degraded start, its consumed
  set unverified and the record remote unreachable. The keeper takes your accepted line on its next round
  in any state: with a damaged log it moves it aside as before; with nothing damaged it takes the line as
  your OK to verify again (its consumed set rebuilt and checked against a fresh fetch before any tap
  counts). Either way its use is committed locally with its `Owner-Line: recover <code>` trailer and pushed
  when the remote answers, and the rebuild then finds it. A line whose code no longer counts (proposed
  before the App's current start, in another record epoch, or used already) is never refused in silence:
  the link answers in your DM with one line naming the cause and a fresh code at once, in the same
  message. The old code still never counts, and a line read back from history never does.

  A Ship tap while the consumed set is unverified. It gets its own line on the card at once: "Not taken
  yet: Cain's record is still checking which taps were already acted on. Nothing shipped; tap Ship again
  once this line clears." Its buttons stay; nothing durable is kept for the tap (no held record, no tap
  record), so a restart while it waits leaves the card with the line and nothing recorded. Once the
  keeper's status says the consumed set is verified, the line is edited away and a Ship tap after that
  acts once.

  A held tap's time is Discord's. The held record carries the tap's interaction id, and its time is the
  interaction id's snowflake timestamp, never the link's clock alone. The keeper takes that time, and no
  earlier than the hold start the keeper itself saw (the start of its own unverified period); a tap whose
  link-logged time and snowflake time are more than 2 minutes apart is refused, with both times quoted,
  without using the key up, and the card says the App's clock and Discord's disagreed (the link checks the
  same before it relays, and drops the tap with that line). Your owner lines are bound the same way: your
  message must be sent after the proposal by snowflake order, must not be dated more than 2 minutes ahead
  of the App's clock, and the proposal's own snowflake time must agree with the time the App logged for
  it within 2 minutes. (Round 16 replaces every comparison with the Pi's clock in this paragraph: see
  below.)

  No card is re-armed at a start until the keeper's status says its consumed set is verified (a fresh
  fetch merged; a missing or unreadable status is not verified). Until then a card that would be re-armed
  stays buttonless with a line saying its buttons go on once the record has checked; once verified, the
  re-arm runs every arming check above and arms it (its text back as posted) or tells it withdrawn or
  expired. A key consumed only on the remote is known by then, so that card never shows buttons.

  A held tap's release is marked before its relay: a `releasing` record is fsynced in
  `/data/link-held.log`, then the line goes to Cain with its tap key, then `released`. After a crash
  between the two, the next sweep drops the tap if the keeper already acted on its key (and logs it), and
  otherwise relays it once more flagged as a replay ("Replay of held tap key ..."), which Cain's rules say
  is not acted on again.

  The post-restore sweep pages back to the 100-day card horizon: newest first, 100 messages at a time,
  stopping at the first message older than 100 days or where your DM's history ends, once per detected
  restore. Restore detection gates it: a restore that isn't detected sweeps nothing, and the tap path
  still refuses a card it doesn't know with a line.

  The exactly-once limit, plainly. Across a whole-image restore, exactly-once holds only for consumptions
  that reached the remote. A consumption committed locally while the push to the remote was failing
  (round 25: a round whose fetch fails consumes nothing from a tap), followed by a
  restore of the copy, the ledger and the keeper's state together to an older consistent snapshot, is a
  known gap: a re-tap on a card that survived on Discord can act again. A test pins that behaviour as the
  known gap; closing it would take a new store, which this round doesn't add.

  The combined fault scenario, round 15. It also includes your recover line under a degraded start with
  the remote unreachable: with the Pi off its network, move the keeper's consumed log aside over SSH and
  restart the App (a degraded start); Cain runs `keeper.sh recover-logs`, you send the line with its code,
  and Cain runs it with `--said`: it is accepted, the keeper commits its use locally, and once the network
  is back the trailer reaches the remote and the held tap acts exactly once.

  Round 16 (the sixteenth review's fixes, to the fifteenth round's own additions; the design stays frozen
  for the combined fault scenario, and the only new file is the restore sweep's cursor).

  Nothing an owner line or a held tap counts on is judged against the Pi's clock. A Raspberry Pi has no
  real-time clock: after a power cut its clock can be hours off until time sync, which is exactly the
  combined fault scenario. So your recover line (and your install line) is live when your message comes
  after the proposal's by snowflake order and within 30 minutes of it, snowflake to snowflake; the Pi's
  clock plays no part, and a line past that bound is told to you with both of Discord's times and a fresh
  code. A held tap is judged snowflake against snowflake: its interaction id's time against its card's
  expiry expressed as a snowflake time (the card's post snowflake plus the lifetime its key record
  carries). When the Pi's clock is the outlier against Discord's (over 2 minutes), the reply to your line,
  or the card of a held tap, says so plainly that the Pi's clock is off by about N minutes, waiting for
  time sync ("The Pi's clock is off by about N minutes, waiting for time sync."). Nothing waits on it and no fresh code is issued that would fail the same way. (Round 17: a stale line always gets its fresh code; the clock line is information only.)

  The keeper's verified status is bound to the keeper's current start. Each start of the keeper mints a
  start nonce and writes it into its status at once, with the consumed set unverified; a fresh fetch in that
  start writes `verified` naming that start, the keeper's time of the fetch, and the link run nonce it read
  in the link's state. The link takes "verified" only when it names the keeper's current start and this link
  run (so a fetch after this link's start); anything older or missing reads as unverified, so it waits. A
  status left from before a restart, or restored with the image, re-arms nothing and clears no waiting line
  until a fresh fetch. None of this reads a clock.

  Your recover line only clears the damaged-log state and runs the rebuild again: it never marks the
  consumed set verified (only a fresh fetch does) and never turns install taps on. Your install-on line waits
  under the unverified hold like any tap: until the keeper's status is verified for its current start and
  this link run, `keeper.sh install-taps on` proposes nothing and switches nothing on, and your message
  isn't used up.

  When verification is first observed, the link runs the arming checks again on every card still showing
  buttons before any waiting line is cleared: a card with a waiting line (a Ship card's "Not taken yet"
  line, or a card whose buttons wait at a start) gets every check (not expired, none of its keys consumed,
  its source check accepted for its row now), and any other card is withdrawn here for a key the keeper
  consumed (its other lapses keep their usual lines). A card that fails is withdrawn or expired, its waiting
  line replaced by that line; only then are the clean ones' lines cleared.

  Held releases resolve only once the consumed set is verified for the keeper's current start and this link
  run: the card keeps its held line meanwhile, and with the remote down at a restart nothing is resolved. A
  replayed line carries the tap key and is flagged ("Replay of held tap key ..."): Cain looks the key up in
  the keeper's consumed-key log and request log and in state/decisions.md, and acts only if it is in none of
  them, never from memory. If no keeper request for the key appears within 10 minutes, the link puts one
  line on the card asking you to answer again on the fresh card Cain sends, and tells Cain.

  The link answers only live messages as commands: one newer, by snowflake, than the newest message in your
  DM when the link started (its first sweep reads the DM's last message id), or than a proposal this link
  run posted. History reads, the paged restore sweep included, draw no reply and no code.

  The post-restore sweep keeps a durable cursor (`/data/link-sweep.json`: the restore it is for and the
  oldest message id reached), saved after each page. It is marked complete only at the 100-day horizon or
  the end of your DM's history; a restart resumes from the cursor; a rate limit waits its Retry-After and
  reads the page again.

  The keeper floors a held tap's time by the hold start the held record carries (written by the link when it
  held the tap, as a snowflake time; round 17: as the hold's first held interaction id), never by a hold start it observes again after its own restart, so a
  keeper restart between hold and release no longer moves it. A refusal that does come from the floor (a
  hold its record says began after the card expired) puts a line on the card naming the restart.

  On a detected restore, every Ship card issued before the snapshot (each Ship card the restored state
  knows) stays buttonless until it is reissued, with a line saying so, and Cain hears to show a new one.
  Question cards keep their usual handling. Ship landings stay bounded besides by the pull request's merged
  state: one landing per head.

  The combined fault scenario, round 16. It also includes the recover line with the Pi's clock hours off:
  after the power cut, before time sync (or with the clock set hours off over SSH), with the remote
  unreachable, Cain proposes the recover line, you send it, and it counts by Discord's times; you are told
  the Pi's clock is off; the keeper's status stays unverified, no card re-arms and install taps stay off
  until the network is back and a fresh fetch verifies.

  Round 17 (the seventeenth review's fixes, to the sixteenth round's own additions; the design stays frozen
  for the combined fault scenario, and no new durable store). Every durable store, its writer, its fsync
  point, its rebuild source, what it decides and the clock behind each time it holds are in one table:
  `cain/docs/source-check-invariants.md`. The code was read against it and fixed where they differed.

  The hold's start in the held record is a Discord-stamped id: the hold's first held interaction (its held
  line is put on the card by that interaction's own answer), shared by every tap held in the same hold. The
  keeper's status time is gone from it, and the keeper floors only by that id's snowflake, so a multi-hour
  Pi clock skew either way changes nothing: a hold spanning the card's expiry acts, a hold that began after
  the expiry doesn't.

  A stale owner line always gets its fresh code, whatever the Pi's clock says: validity is snowflakes alone.
  The line saying the Pi's clock is off by about N minutes still goes when it is, as information only, never
  a gate on the code.

  After a link restart the keeper's verified status names the old link run. The keeper watches the link
  state's run nonce each round and verifies for the new run with that round's fresh fetch (no keeper restart
  needed; the nonce is read before the fetch, so a restart mid-round waits a round). While the remote is
  away its status says verification for the new link run is pending, and once 5 minutes have passed on the
  link's monotonic clock each waiting card gets one line ("Still waiting: ...") and Cain is told once.

  A card's key records carry its lifetime as an explicit duration fixed at issuance, so its expiry is its
  post snowflake plus that duration, never a difference of two Pi clock readings; a clock step between the
  card's post and its key log moves nothing. A live tap's expiry is judged the same way: its interaction
  snowflake against that expiry.

  A line of yours read back from history (sent while the link was down) that answers a proposal still within
  30 minutes of it by snowflake is answered once: you are told it arrived while the App was offline and get
  a fresh code from this run; the old line never acts. Only a history line that answers no proposal gets the
  silent refusal to Cain.

  The restore sweep's horizon is the start mark's time less 100 days, a snowflake time; it is marked done
  only on reaching it or the end of history, and never while the Pi's clock is flagged off (then the next
  start reads from the cursor again).

  The arming re-checks are keyed to the verification tuple (the keeper's start, the link run, the fetch
  count), recorded durably in the link's state, so a keeper restart under the same link run runs them again.
  They run every arming check on every card that would become tappable, buttonless waiting cards included; a
  card in the removal queue counts as withdrawn; and the status is read again just before each clear or
  re-arm, which is abandoned (the card left waiting) if the tuple changed.

  The 10-minute replay bound runs on the monotonic clock, never the Pi's clock. When the line asking you to
  answer again goes up, the old tap key is superseded in the link's issued-key log first, so the keeper
  refuses a late request of Cain's for it, and the card gets one line saying so.

  The combined fault scenario, round 17. It adds a link restart with the remote away: with a card's buttons
  waiting, restart the link (`pkill -f /opt/cain/link/main.ts`) while the Pi is off its network; after 5
  minutes the card gets the waiting line and Cain hears verification is pending; once the network is back
  the keeper's next round verifies for the new link run without a keeper restart, and the card arms.

  Round 18 (the eighteenth review's fixes: rows of the invariant table that broke its own clock rule, a
  race the ordering sentence didn't cover, and a durability hole; the design stays frozen for the combined
  fault scenario, which is unchanged, and no new durable store). The table in
  `cain/docs/source-check-invariants.md` is updated for every row this round touches.

  A source check's freshness is measured by Discord's times. When the link hands a check to the keeper it
  anchors it to a Discord stamp: the newest of your DM's last message id (read from Discord just then), the
  message the ask replies to, and the newest stamp the link has seen in this run, each no later than the
  hand-over. The keeper keeps it with the check (`checked_sf`). A tap counts only while its interaction
  snowflake less that anchor is within `source_check_max_days`; a check taken before this round, with no anchor, is measured from the post snowflake of the card
  resting on it (the link sends no check without one: with no Discord stamp to give, nothing is posted). The keeper's own clock still dates the check, ages it
  in the Checked cell and decides whether a card is posted, but never whether a tap counts, so a step of the
  Pi's clock hours either way, with its clock verdict still synchronized, changes nothing.

  The expired-key index keeps each card's expiry as a Discord time (its post snowflake plus its lifetime) and
  is a cleanup marker only: a tap is refused as expired only when its interaction is stamped after that
  expiry. A card the sweep took off early (after a forward step of the Pi's clock it hadn't measured yet) is
  judged again by the tap's own stamp: one stamped before the card's real expiry acts, as long as the card
  shows what was posted and nothing else used it.

  A supersede is ordered against consumption. After the link appends the supersede of a replayed tap key,
  the line asking you to answer again waits until the keeper's status shows that supersede mirrored and the
  key still absent from the consumed-key log; if the keeper consumed the key meanwhile, the card says your
  answer was acted on after all instead. The keeper reads the link's issued-key log for a supersede of a key
  just before consuming it, so exactly one of the two happens.

  A released held tap is judged by its own interaction snowflake against its key's expiry; the hold's shared
  start only floors the keeper's lateness check, never stands for the tap's time.

  Every save of the link's state is fsynced: the temp file before the rename, the folder after it. No save
  that isn't durable can replace one that is.

  No Pi clock fallback decides whether a tap counts. A key record without a card snowflake takes it from the
  interaction (the message id it carries), and a tap that can't be placed in Discord's time at all (a held
  record without its interaction id, or a key whose card has no snowflake anywhere) is refused, with one line
  on the card ("Not acted: Discord's time for this answer couldn't be read ..."). A card posted and then cut
  off by a crash before its keys were logged can't be tapped into acting.

  A link run is one above both the state's count and the highest run in the issued-key log, with a fresh
  random nonce fsynced before use: a link state restored from a backup can't reuse a run the keeper's verified
  status names, so waiting cards stay unarmed until a new verification.

  The Pi's clock verdict is unknown until the link has compared a Discord stamp with it in this run (a post
  or a tap); unknown is never taken as in step. The restore sweep's done mark waits for in step, and the
  "clock is off" line for a comparison that says off. `keeper.sh clock` shows it as `pi_clock`.

  An item hold lapses after a day on the keeper's monotonic clock within its run (from when it saw that
  renewal), or by the wall clock's idle day, whichever comes first: a lapse only frees an item. A key record
  without a card snowflake is pruned by a snowflake comparison (the keeper's mirror: once a key logged after
  it is 100 days behind the newest card) or, on the link, on the monotonic clock of its run; never by a
  wall-clock duration.

  The consumed-key rebuild after a restore uses only landing claims the link settled against the remote main
  (with the record's Tap-Key trailers); an open claim is settled from the remote main first. Each record of
  an append-only log is one write under 4000 bytes, so the link's and the keeper's appends to the install
  log never interleave. The keeper renames the recover file to record-recover.json.taken before acting on it,
  and deletes only that; a line the link writes meanwhile is taken next.

  A card's buttons come off at its post snowflake plus its lifetime, through the offset the link measured
  against Discord's stamps; the Pi's clock is kept for how long records are kept. The keeper's reset epoch
  never decreases: a state or status restored from an older snapshot takes the higher epoch. Each row of the
  table whose fsync point matters has a crash-injection test (a kill after the write and before its fsync),
  and the table lists them.

  Round 19 (the nineteenth review's fixes, to defects in round 18's own additions; the design stays frozen
  for the combined fault scenario, which is unchanged, and no new durable store). The table in
  `cain/docs/source-check-invariants.md` is updated for every row this round touches.

  Supersede and consumption meet at one durable point, the consumed-key log. Before the keeper reads the
  link's log for a supersede of a tap key, and before the request's local commit, it appends and fsyncs a
  consuming intent for the key; the request ends with a consumed record or a dropped one. The link counts an
  open intent as consumed before asking you again, so it never asks while the keeper may be acting on the
  key. An intent a crash left open is resolved at the keeper's next round from the commit's Tap-Key trailer
  (consumed if the commit exists, else dropped), so a crash after the commit never leads to a second ask.
  The link's check before asking again reads the keeper's per-key answer in its status (`replay_keys`),
  never a newest-200 list; if that answer is late, the card gets one line saying it settles by itself. A
  held tap whose key isn't in the issued-key log is refused at the link with a line on the card.

  The expired-key index records why a card was retired: unarmed, or swept as expired. Only a swept card
  with an armed record, not queued for removal as withdrawn, is judged again by a tap's own stamp, and then
  goes through the usual checks. Its longest lifetime for old records comes from the configuration.

  No Pi-clock decision about whether a tap counts: a tap or a restarted claim without a well-formed
  interaction id is refused with a line on the card and a line to Cain; the keeper refuses a request whose
  tap record has no interaction id; a card's forgetting day is judged by the tap's snowflake against its
  post plus its retention. The one Pi-clock refusal left (a card the link can't place in Discord's time,
  past its forgetting day) is listed in the table.

  Cards live at the upgrade are migrated explicitly: a card resting on a check with no Discord anchor gets
  the lesser of its own post snowflake and one made from the check's keeper date, so a check never counts
  longer than its limit; a card with no trustworthy anchor is withdrawn with a line saying a new source check
  is needed. The keeper refuses a new check without an anchor. A tap refused because its check aged out says
  so on the card ("The check behind this is more than 7 days old"), and Cain gets the re-check.

  An open landing claim keeps its key blocked (treated as consumed) through a rebuild until the link settles
  it against GitHub's main. Verification is keyed on the link's run and nonce together: the keeper refuses
  a run number it verified before under another nonce, and its status names the highest run it verified
  (`verified_high`), which the link starts above. A message read back from Discord (the start mark, each
  restore sweep page) counts as a clock comparison, so the restore sweep completes after a quiet restart.

  Append logs: free-text fields are cut to a fixed budget so every record fits; a short write is undone
  before it is refused; every reader skips and reports a torn final line, and an append cuts one off first;
  appends are serialised by a lock beside each log. The crash tests also run each store's writer in a child
  process killed at the crash point.

  The live CLI test's edit-after-reply case is a known skip in CI and in cloud sessions, tracked in
  issue 24. You have nothing to set up beyond the smoke test's one option change.

  Round 20 (the twentieth review's fixes, to defects in round 19's own additions; the design stays frozen
  for the combined fault scenario, which is unchanged, and no new durable store: the landed marks and the
  unlanded drops are record types in the existing consumed-key log). The table in
  `cain/docs/source-check-invariants.md` is updated for every row this round touches.

  Every append to a shared log is serialised by an OS advisory lock (flock) on a file beside it, held
  through the torn-tail repair, the append and the fsync; the kernel frees it when its holder dies, so the
  next waiter to get it carries on and no two waiters ever both take over. Records are cut against a byte
  budget for the whole serialised record, on code-point boundaries, nested values included; a record still
  too long is refused with a short reason and nothing written.

  A consuming intent resolves as consumed only from a commit carrying both its tap key and its own request
  id: an earlier request's commit on the same key never resolves a newer intent. A consumption whose
  commit is later found unreachable (discarded by a reset or a rebuild, or not on GitHub two hours after it
  with the copy in step) is dropped explicitly: you get one line on the card saying the change didn't land,
  and Cain hears it and asks again on a new card if it still needs you. Each link path reads "consumed or
  consuming" from one function: a live tap on a key the keeper is acting on now does nothing and says it
  settles by itself, its buttons kept; a held tap on such a key stays held; if the keeper can't resolve an
  intent for three rounds, Cain gets a notice and the card one waiting line.

  The forgetting day is judged by the tap's snowflake against the card's post snowflake plus a constant
  retention (35 days), never two wall-clock readings. A legacy card whose check's keeper date can't be read,
  or whose check isn't the card's own request, has no trustworthy anchor: withdrawn with the new-check line;
  an open claim on such a card is not acted, and its key's open landing claim is settled as voided with the
  reason, so the key isn't left blocked. The keeper answers the link's per-key replay question a page of 500
  a round, continuing where the last status stopped, so every open replay gets its answer. A keeper status
  without a run number counts as unverified. A post or tap that measures the Pi's clock off after the
  restore sweep was marked done reopens the sweep (a read only bounds the clock from below, so an ahead
  clock goes undetected until measured). The unstamped refusal covers every button that carries a tap key,
  Ship cards included. A Ship landing voided before its push whose ledger file couldn't be marked settled is
  kept unresolved, retried each sweep, said once under its card, and settleable by your settle line.

  Round 21 (the twenty-first review's fixes, to defects in round 20's own additions; the design stays frozen
  for the combined fault scenario, which is unchanged, and no new durable store: the tombstone is the
  existing unlanded drop record). The table in `cain/docs/source-check-invariants.md` is updated for every
  row this round touches.

  A consumption dropped as not landed can't come back: the drop is one locked step on the consumed-key log
  that also takes its commit out of the keeper's local branch, the drop is a tombstone, and before every
  push the keeper takes any commit whose request was dropped out of the branch (or refuses the push when it
  can't), so a late push never applies an answer that was dropped and asked again; the rebuild and intent
  resolution skip a tombstoned commit. The two-hour window runs on the keeper's monotonic clock from when it
  first saw the record unlanded, over at least three fetch rounds with the copy in step, never the wall clock.
  Both views of the consumed-key log (the link's and the keeper's) are keyed on tap key and request id, so a
  second consumed record for one key is marked landed or dropped on its own and the views agree. The replay
  check reads "consumed or consuming" from the one function: a key the keeper is consuming stays held with
  the waiting line and gets no supersede; the waiting line for a key the keeper hasn't answered yet waits out
  a full page rotation of the open replays too. A legacy card's claim whose voided settle can't be written
  goes into the void-unsettled path (kept as void, one line on the card, Cain told, retried each sweep,
  listed under unresolved landings), and a void claim's seven-day alert says nothing was pushed.

  flock is resolved through a soname list (libc.so.6, libc.so, libc) and probed at start by the link and the
  keeper on a probe file in the real log folder; when it can't be loaded or taken, each refuses to start
  with one status line (the link posts it to you; the keeper's goes through Cain) and tries again hourly.
  A lock error that isn't would-block is told at once by its errno; a lock wait past five seconds is a
  timeout every caller holds and retries (a tap answers busy with its buttons kept, a release waits for the
  next sweep, a keeper request stays queued), never a dropped record. An arm64 run of the lock tests is a CI
  job (`arm64-flock`, an arm64 container under QEMU); the Pi smoke test's first step exercises the real
  lock on the Pi. A reader never truncates a torn tail by default; a repair takes the log's lock, and only
  the keeper's single-writer mirror repairs without it. Retention is clock-free for a card with a snowflake
  id: the sweep's forgetting, pruning and the restore's post time come from the post snowflake plus 35
  days; the Pi's clock decides those only for a card with no snowflake id. The stuck-intent waiting notice
  is told once per tap, request and episode, and cleared when the intent resolves.

  Round 22 (the twenty-second review's fixes, to defects in round 21's own additions; the design stays
  frozen for the combined fault scenario, and no new durable store: the keeper state already written each
  round carries the new fields). The table in `cain/docs/source-check-invariants.md` is updated for every
  row this round touches, and now tracks the remaining wall-clock housekeeping (tap notice pruning, the
  landing prune, unresolved reminders, the push alarms' listing) with what each decides.

  The keeper's check before a push fails closed: only a verified absence of withdrawn commits lets a push
  go. If GitHub's branch isn't known to its copy, a git command fails, or a withdrawn commit can't be taken
  out cleanly (a conflict), nothing is pushed, the cause is logged, Cain is told (no sha or job id), it is
  listed under unresolved landings in `keeper.sh clock`, and every round tries again; a conflict stays
  refused until the commit is taken out or the copy is reset. A held push is unsaved work like any
  other: Ship taps wait, and over half an hour you get the usual notice that the record isn't saving. The drop and the push can no longer overlap:
  the push holds the consumed-key log's lock from that check until its result is known, and a drop takes
  the same lock and looks at GitHub's branch again under it, so a record whose commit just landed is marked
  landed instead of dropped. After every push the range it carried is checked against the withdrawn
  requests; a match is a push alarm to Cain, listed under unresolved landings. The two-hour landing window's
  first reading (the box's own time since boot) and its round count are kept in the keeper's state per boot,
  so a keeper that restarts often still decides, and only a reboot starts the count over. The stuck-intent
  line to Cain goes once per episode however long it stays stuck (the saved notice keeps its request and
  episode). Every lock caller is listed, each with what it does when the lock is busy past five seconds,
  and a test checks the list against the source. The keeper's per-round torn check tries the lock once and
  skips to the next round when it is busy, so a round never stalls there.

  The start probe now also needs errno to resolve and runs a contention self-test (a helper process holds
  the probe lock and the probe must see would-block); either failing refuses the start with its precise
  reason. The refusal, its line and the hourly retry live in `startgate.ts`, which the tests drive. The
  `arm64-flock` CI job is evidence for symbol resolution and the foreign-function path on arm64, under
  user-mode emulation on an x86 host; it is not proof of the Pi's kernel. The Pi start probe plus the
  combined fault scenario are the real arm64 gate. Making the job a required check is a change to the
  repository's ruleset that only you can make.

  Round 23 (the twenty-third review's fixes, to defects in round 22's own additions; the design stays
  frozen for the combined fault scenario, and no new durable store: the keeper state already written each
  round carries the new fields). The table in `cain/docs/source-check-invariants.md` is updated for every
  row this round touches.

  Pushes go again only once GitHub is seen to have them: a push counts as confirmed when GitHub's branch,
  read back right after it, is the commit the keeper pushed (or a fresh fetch finds nothing waiting to
  push). A push that passes the check but fails on the network, times out or can't be read back leaves the
  held-back record in place, with nothing said to Cain. The push itself now runs under a hard time limit
  (20 seconds then, below the 30 seconds the consumed-key log's other writers waited; round 24 raises both), with
  git's low-speed limit and no prompt of any kind to wait on; on expiry git and everything it started are
  stopped and the lock is released. A push that timed out, or failed with GitHub unreadable after it, has an
  unknown outcome: kept in the keeper's state, listed under unresolved landings, and no drop of the taps it
  may have carried happens until a fresh fetch settles whether it landed. The drop itself fetches GitHub's
  branch afresh under the lock and drops nothing when that fails, so a push that errored but landed is never
  taken for one that didn't. The nightly check's push goes through the same held-back record, notice,
  retry and resolution as a round's, so a refusal is told once whichever push hit it. The check of what a
  push carried fails closed too: an unreadable consumed-key log, an unknown GitHub branch or a git failure
  is "alarm check incomplete", kept, listed, told to Cain once and checked again each round until clean.
  What Cain and you read about a held-back push is fixed wording per cause; git's own text (which can
  carry commit ids and paths) stays in the keeper's log. The remedy for a withdrawn change that can't be
  taken out cleanly is `/opt/cain/record.sh reset-copy` (its next round resets its copy to GitHub's, as after
  a conflict). With the box's boot id unreadable, the two-hour landing window starts again at each keeper
  start, so a reboot can never shorten it. A lock busy past its wait at one landing mark skips only that
  record (listed with its cause in the keeper's status); the rest are looked at. Every lock-acquiring call in
  the whole source tree is listed with what it does when the lock is busy. Each row of `keeper.sh clock`'s
  unresolved_landings now names its kind (row: landing, push-refused, push-alarm, alarm-check,
  push-unknown). The start probe's helper runs under the same runtime and flags as the App's own process,
  and a helper that can't start is its own refusal reason.

  Round 24 (the twenty-fourth review's fixes, to defects in round 23's own additions; the design stays
  frozen, and no new durable store: the keeper state carries the new fields). The table in
  `cain/docs/source-check-invariants.md` is updated for every row this round touches.

  Every network call the keeper makes now runs under the same timed, no-prompt wrapper as the push: the
  round's opening fetch, a clone, the read-back after a push, the drop's fresh fetch and the request for
  GitHub's Date header. Each runs in its own session, and on expiry that whole session is stopped. A
  fetch that hangs or fails makes a hiccup round: the round works on the box's copy, the hiccup is kept in
  the keeper's state and its status, the next round tries again, and after five such rounds Cain hears
  once that the keeper can't read GitHub (and once when it reads again). The push's wall-clock limit is
  now a ceiling, 75 seconds (set in the App's run script, kept below the consumed-key log's 90-second
  wait); git's own low-speed limit is what normally stops a stalled push. Each push's duration is logged,
  and three pushes in a row stopped at the ceiling are their own row (push-slow): the box's connection to
  GitHub is too slow. The keeper refuses to start without the session tool (setsid), with a fixed reason.

  A push whose outcome is unknown and whose own check then fails (its commit gone from the copy, or a
  listing error) is no longer forgotten: each failed round counts a try, its row says in fixed words that
  the outcome couldn't be settled yet, Cain hears once, and after three tries (at once if the commit is
  gone) the keeper reads GitHub's whole history: settled as landed when the commit is there, as not
  landed only when neither the commit nor any of its tap keys is there; otherwise it stays unresolved.

  A missing consumed-key log is taken as "no withdrawn changes" only when the keeper's state proves the
  log never existed (its created flag, written once the log exists, is unset and no record was ever
  counted, or there is no keeper state at all, a first start). Otherwise the alarm check is incomplete and
  the push guard holds pushes back. A landing check that skips a record says why in fixed words
  (lock-timeout, read-failed, git-failed or other); the error itself goes to the keeper's log only. After
  the first lock timeout in a round, the remaining records are skipped at once with the same cause, so a
  busy lock costs one wait, not one per record.

  `/opt/cain/record.sh reset-copy` is refused unless the keeper is holding back its pushes right now. The
  request is stamped with that hold's id and the reset epoch, the next round uses it up whether or not
  there are local commits, and it acts only if that very hold is still recorded; it logs, in fixed words,
  how many local commits it discarded and which consumed tap keys they carried, and settles their open
  intents first. A request made with no hold, or left from an old hold, can never reset a later round.
  (The smoke test's forced-conflict switch works as before.) Rounds whose push isn't confirmed
  while pushes are held back now count on the hold (hiccups, with their age, in the status), and past six
  such rounds Cain hears once.

  With the box's boot id unreadable, each keeper start that re-bases a landing window is counted; after
  three re-bases without the window passing, the hold shows as a landing-held row in `keeper.sh clock`'s
  unresolved_landings. A source test bans re-exporting, aliasing or generic-form calls of the lock
  primitives (so the call-site scan can't miss one), and the link's real entry file is launched in a test
  the way the keeper's is.

  Round 25 (the twenty-fifth review's fixes, to defects in round 24's own additions; the design stays
  frozen, and no new durable store: the keeper state carries the new fields). The table in
  `cain/docs/source-check-invariants.md` is updated for every row this round touches.

  The consumed-key log's created flag never goes back: it is written to the keeper's state (fsynced)
  before the log's first append, not at the round's end, and a detected loss of the log no longer clears
  it. A lost or shortened log is marked "lost, rebuilding" instead, and while that mark stands every push
  is refused (the alarm check is incomplete), whether the file is there or not, until a rebuild from a
  fresh fetch has rewritten the log and fsynced it. A missing keeper state counts as a first start only
  with independent proof: the record's copy is readable and no ref of it carries a tap key.

  A push of unknown outcome is settled as "not landed" by the fallback scan only when the tap keys it may
  have carried were read without error, the list is not empty, and none of them is on GitHub with its
  commit absent. A failed read of those keys is its own error, never an empty list, and keeps the outcome
  unresolved (a try counted, the row kept). In the landing check, the first fetch a drop needs that fails
  or times out skips the round's remaining drops (cause fetch-failed), so a hung GitHub costs one time
  limit a round, not one per record.

  The network wrapper has no fallback: without the session tool it runs nothing and answers a fixed
  reason, and the image build fails without the tool. The guarded push runs under one deadline (guard,
  push, scan, read-back) below the consumed-key log's 90-second wait, and logs how long it held the lock.
  In a round whose fetch from GitHub fails, requests that carry a tap key wait in the queue (no intent,
  nothing consumed) for a round whose fetch answers: the keeper is the only writer the design gives the
  record, but the repository can also be edited on GitHub, so a row may have moved there.

  `record.sh reset-copy` settles the open intents and writes a tombstone for each consumed record its
  discarded commits carry (unless the request is still queued and runs again) before the discard, both
  fsynced, and the request is used up only once the discard is done: a restart in between does it again.
  The link's trust folder follows CAIN_TRUST_DIR only under /tmp (a test's folder); set to anything else,
  the link refuses to start with a fixed reason. The lock lint is now a TypeScript-compiler syntax-tree
  check, and the link's entry file is launched in a test as a non-root user.

  The authorization boundary for an in-flight landing (round 9). A Ship tap's landing starts at its
  ledger claim, made right before the first push attempt and only after the tap passed the live-tap
  predicate. A reset of the record that wins before that point (checked right before the claim)
  prevents the push. The boundary is closed (round 10): the reset epoch the link read right before
  the claim is recorded in the claim, and after the claim's fsync the epoch is read again before the
  first push; if it changed (or a reset now stands), the claim is voided (settled not landed, marked
  voided) without pushing, and the tap is lost as any tap whose check didn't survive a reset: one line on
  the card's thread, one to Cain, the item on the re-check queue. Once the claim is made, a reset
  does not revoke it: the landing settles truthfully, as landed with its ledger mark when GitHub took
  the push, even if the check would now fail. Before the claim, the link also looks for the token
  on the remote main (round 10): a head already reachable from main's tip claims no landing and
  pushes nothing, the card says "Already in main as of 9:41 AM, so nothing was pushed.", and Cain
  gets a line saying it is already in main (with the Ship token, so Ship only installs it). Here,
  landed means the commit is present, not that this push put it there: this tap's push, an earlier
  tap's or another push may have brought it. A head that arrives by another push while a claimed landing waits on an outage is settled as
  landed on the next try, with no second push. A settled key is marked so in its file and pruned
  by the link after 30 days; an unsettled one is never pruned. The ledger is the link's alone: The
  record keeper never writes or cleans that directory. The link keeps a marker outside the ledger
  (`/data/link/landings-marker.json`, and a count in its own state) of how many keys it has
  claimed; a ledger behind that marker or that count, or with another id, came back from a backup,
  and is trusted again only once each of its keys was looked for on the remote main by its token
  (until then no landing starts).

  The guarantee as it holds: at most one unmarked line per tap key and at most one landing per
  tap. A line relayed again carries the "Repeat of tap key" marker. Attested, not enforced:
  that Cain honours the repeat marker and acts on a tap key once (the keeper enforces it only for
  requests that carry the key).
- A one-off (`--item none`) is refused when its text holds an open row's item code or the
  row's whole Item phrase, quoting what matched. One whose words overlap an open row's Item
  more loosely (two of the row's distinctive words, or its only one) is held: nothing is
  posted, and Cain hears in one line to either ask it under that item with `--checked`, or
  send it again with `--reason "<one line on why it is about no open item>"`. Re-declared
  that way it posts, and the keeper logs the reason with it (`declared` in
  `log/requests/`). Every one-off is written to the request log as a `one-off` request
  declaring it is about no open item. On each round that applies requests, the keeper
  matches the past week's one-offs against the open rows the same way and keeps
  `state/one-off-audit.md` (each hit, with its reason, and the week's wait timeouts); lines
  it hasn't surfaced before go to its log and to `/data/record-checkin.txt`, which the next
  check-in reads to Cain, once. The guard is limited: a one-off that shares no code, phrase
  or distinctive word with a row passes all of it.
- Every refusal quotes what it matched: the vague source word, the repeated check, the two
  bundled clauses, the overlapping words. The link logs its refusals of checks and
  one-offs to `/data/work/source-check-refusals.jsonl`, and the keeper its own to its log
  ("refused for tuning"), for tuning the rules. The word lists (vague sources, mail words,
  status words for bundled rows, distinctive words for one-off overlaps) are heuristics: tune
  them from that refusal log after one or two weeks of use.

When a push fails. A failed push never resets the keeper's copy. The keeper keeps its local
commit, and the outcome it already wrote for the link stays valid. It marks its status file
(`/data/record-ledger.json`, written whole every round, read by the link) `unpushed`, with
the push error, and tries again: at once after rebasing onto GitHub's copy when GitHub
answered (a lost race), otherwise on its next round. Requests stay in its queue until GitHub
has them, but are applied once; Cain's other requests hear done once the push lands. A valid
card keeps its buttons through the failure and his tap on it counts; a card whose row moved
meanwhile is refused as usual. Only when a reset is unavoidable (the rebase conflicts with
what GitHub has, or the copy has to be cloned again) does the keeper reset its copy to
GitHub's: it logs why, marks `reset` in its status file, runs the requests still queued
again on GitHub's copy, tells Cain which others may not have landed, and the link refuses
asks ("the record keeper had to reset its copy of the record ...") and taps (record reset)
until the next push lands. The ledger's generation still only goes up. Takes that waited
behind one of Cain's jobs and were settled in a commit stay in the keeper's queue until the
push carrying them lands, so a reset runs them again like the other queued requests. A settled
take keeps its request id, and a take's only effect is in the record (no message, card or job
follows from it), so a rerun after a reset is idempotent by that id: one whose final outcome is
already in `log/requests/` is never applied again.

The reset epoch. Each reset starts a new epoch, recorded in the keeper's state file
(`/data/record-holds.json`, outside the record's working copy) and its status: its number, when
it began, and a generation one above everything the link could have posted on. Every source
check the ledger holds when it begins was accepted before it, so each is dropped in the same
round (its row keeps its id and version, and its Checked cell says `pending re-check: the record
was reset, so its last check no longer counts`) until a new check is taken. Each card is stamped
with the epoch it was posted in, and a tap counts only while that equals the current epoch;
cards from another epoch are refused with their own reason and lose their buttons on the sweep's
next verified read, even when the ledger came back with the very check they rest on: a newer
check of that row may have been in a commit the reset lost. A reset never completes its epoch
while the keeper can't read the link's state (a card posted after the link's last good save
could be above any generation the keeper knows): it waits, logs `reset epoch waits: the link's
state can't be read (...)` once, keeps the reset standing (asks and taps refused) even if a push
lands, and completes the epoch above everything the state then shows on the first round that
can read it (`reset epoch N: completed now that the link's state can be read`).

The re-check queue. Once the epoch's checks are dropped, the keeper relays Cain a "Re-check queue
after the record's reset" line: the items whose card was up or held first, then the others whose
check was dropped, to check at their source in that order and ask again with `--checked`. Its
status counts the rows still pending re-check (`recheck_pending`, also in `keeper.sh clock`).

The generation floor. Before posting an ask or Ship card, the link writes the generation it is
about to post to its own state (`intendedGen` in `/data/link/state.json`), and saves the card's
generation after. The keeper reads that file each round and never sets its own generation below
it. When it can't read the file (missing, corrupt, or caught mid-write), it keeps its own floor,
never falling back to zero, logs `FLOOR: the link's state can't be read (...)` once per change,
and marks its status so the link posts no new ask or Ship card ("the record keeper can't read
the link's state just now") until the file reads again (`floor: the link's state can be read
again`). The link writes its state once at start when there is none.

The link's state heals itself. At start and at each sweep the link reads its own state file as it
is on disk. One failed read is looked at again next round, so a write caught mid-way never
latches. After two failed reads in a row it rewrites the file whole (an atomic rename) with a
generation of the larger of the keeper's floor and its own in-memory high-water mark, plus 10,
posts you one notice ("Cain's link had to rebuild its saved state after the file was damaged.
..."), tells Cain, and does nothing else from that state until a verified good read clears its
unreadable flag. The keeper then reads the file again, and asks go on without you doing
anything.

A tap honoured while the ledger is unpushed is journaled by the link in its state file in
`/data` (the card's generation and epoch, the check's request id, the item, the time, the label
and the tap's key). Claims and journaled taps across a reset: one recorded before the reset is
honoured only if the check it rests on survived it, judged after a restart by exactly the
predicate a live tap uses. Survived means: the accepting request is done in `log/requests/` on
the keeper's current copy, and the check was carried into the current epoch for the row's current
version (the epoch's ledger write has dropped every older check, and the ledger's entry for the
item names that very request, fresh, at the row's current version), with the ledger's generation
no lower than the card's. A check the epoch dropped is not carried, so a claim resting on it comes
out lost, never acted, even though its request is still done in the log; only a check accepted in
a commit the reset lost, and run again by the keeper after the epoch began, survives. One that
didn't survive is lost to the reset: it is recorded so under its
idempotency key, never acted on past the reset and never dropped silently, and you get one line
on the card's thread ("Lost to the record's reset, please answer again.") while Cain gets a
relayed line saying the tap was lost to the record's reset, please answer again (for a tap he
had already heard, to disregard it), and to ask again with `--checked` once the item's re-check
is accepted. The card's buttons come off ("Record reset since, re-check needed"). The journal is
cleared once a push lands. Once a push failure is older than 30 minutes, taps are refused with
their own reason (record unpushed) instead. And when the keeper's status has shown unpushed or
reset for more than 30 minutes or three rounds, the link posts you one notice, once per outage,
with the push error in plain words and how long Ship taps have been held ("Cain's record hasn't
saved to GitHub since 9:40 AM: GitHub didn't answer. Ship taps are held until it saves, for 35
minutes so far. Nothing is lost: the box keeps its copy and keeps trying."). `keeper.sh clock`
shows `recheck_pending` (also in the keeper's status) and whether Ship taps are held, and each
check-in tells Cain how many items are pending re-check.

What is mechanical and what rests on Cain's word. Mechanical, in code: no ask or Ship card
about an item posts, and no tap on one counts, without a `check` the keeper accepted for
the row's current version, by its synchronized clock, within the age limit; the check text
names a concrete source and a time in the right shape and isn't a repeat; rows are versioned
by content, matched by code, with hidden ids; whole-file writes are atomic; one-offs that
name or sound like an open item are refused or held. Resting on Cain's recorded attestation:
that he actually read the source he names, that what he read says what the row and the
question imply, and that a one-off's reason is true. The gate proves a check was recorded,
not that the source was read.

Device tests: an install smoke test, then an optional resilience run. Right after installing a
version with source checks, Cain runs the install smoke test against the real record, about
twelve minutes in all, none of it destructive, and reports the result to you in one line. The
destructive steps are a separate resilience run, offered once afterwards, which you can decline.
Each test ask says it is the smoke test and any answer does.

The install smoke test (about twelve minutes):

1. A checked ask about an item he holds, with a concrete source (`keeper.sh ask --item <id>
   --question <q> --checked "<source, when>" ...`). Expect `"status":"posted"`; your tap on it
   is accepted (the link relays it to him).
2. The same kind of ask with a deliberately vague source (`--checked "from memory"`). Expect
   `"status":"refused"` with a line quoting "memory"; nothing posts.
3. The Ship path the same way, on a harmless card: `keeper.sh ship --item <id> --pr <the pull
   request that brought this version> --head <its sha> --checked "<source, when>" "<test line>"`.
   Expect `"status":"posted"`; your tap on "Not now" is accepted and nothing ships. The same card
   with a vague source: expect `"status":"refused"`.
4. A checked test ask, then a row op on its row (a word in its Next step), then you tap the old
   card. Expect "Its status changed since it was checked, so nothing was done." and its buttons
   off ("Status changed, re-check needed").
5. A one-off that looks like an open item (`keeper.sh ask --item none ...`). Expect `"status":
   "needs reason"`; sent again with `--reason "the smoke test"`, expect `"status":"posted"` and
   the reason in `log/requests/`.
6. `/opt/cain/record.sh block-push` (expect `the record keeper's next round pushes to a wrong
   remote, once`), then a checked test ask you tap within the minute. Expect the tap relayed
   (honoured, journaled), and `keeper.sh clock` showing `"unpushed":true` until the next round
   pushes, then `false`.
7. You set source_check_max_days to 0 in the App's options for one ask (the App restarts); a
   checked test ask must answer `"status":"refused"` saying the check is past
   source_check_max_days. Then you set it back to 7. This is the only option you change.
8. `/opt/cain/keeper.sh clock`. Expect the clock verdict, the source that satisfied it and the
   measured tap read time (`tap_read_ms`), all in his one-line report.
9. `/opt/cain/record.sh clock-test header-only` (expect `clock test: header-only`), then a
   checked test ask (expect `"status":"posted"`) and a vague one whose refusal line he saves to
   `/tmp/smoke-refusal.txt`. Expect in `/data/work/record-keeper.log`: `clock: synchronized, by
   the GitHub Date header (+N s)` and `clock: offset against GitHub's Date header +N s`. The Date
   header comes from its own unauthenticated HEAD request to GitHub's host (no credentials, no
   path); git's own HTTP exchange is never traced.
10. `/opt/cain/record.sh leak-check /tmp/smoke-refusal.txt`. The keeper, which alone holds the
   token, reads every file under `/data/work` (its log copy, the link's log copy, the link's
   rendered notices in `link-notices.jsonl`, the gate's reports), its own state and status
   files, the link's state, the relay queue and that file, for the token, a web address's
   userinfo, and an Authorization header or a Basic or Bearer credential, and prints yes or no
   per file, never the match. Expect `{"clean":true,...}`; any `true` under token, userinfo or
   header fails the test.
11. `/opt/cain/keeper.sh reads 20` (about 80 seconds). It prints `p50_ms`, `p95_ms` and `max_ms`.
   Expect `"pass":true`, `p95_ms` at most half of `limit_ms` (the `tap_read_ms` option, 1500 by
   default) and `keeper_rounds_seen` at least 1. Past half the limit it fails loudly: a `FAIL:`
   line and exit status 2.
12. `/opt/cain/keeper.sh slow-read` (expect `"status":"ok"`), then a checked test ask you tap.
   Expect "Busy, tap again." with the buttons live again, and `/data/work/link.log` showing `tap
   refused: the ledger's read took`. Your next tap counts.
13. `/opt/cain/keeper.sh stall-read 20`: one fresh read is held for 20 seconds and ignores its
   cancellation. Expect `"second_tap":"busy at once"`, `journal_write_ms` under 1000 and
   `"pass":true`: while a read is stalled, another tap is answered busy without starting a read,
   and a journal write to the link's state still completes. Then the same on real Discord: run
   `/opt/cain/keeper.sh stall-read 20` again and, while it holds, tap a checked test ask. Expect
   "Busy, tap again." as a reply only you see, its buttons are still there after the busy reply, and, once the 20 seconds are over, your next tap on it honoured once (relayed once,
   the card showing your answer).
14. `/opt/cain/keeper.sh fail-webhook` (expect `"status":"ok"`), then `/opt/cain/keeper.sh
   slow-read` and a checked test ask you tap. Expect "Busy, tap again.", the buttons back on the
   card, and `/data/work/link.log` showing `forced by the smoke test (keeper.sh fail-webhook)` and
   `editing it by channel and message id`: the buttons came back through the bot's own edit.

It passes only when he sees committed in the record the `check` request done in
`log/requests/`, `state/checks.json` with that row's entry and his check, and the open
table's `Checked` column showing it, and reports the commit hashes of those three (the log
entry, the ledger write and the table change), so you can spot-check them on GitHub.

The resilience run (optional, about twelve minutes). After the install smoke test passes, Cain
offers it once, with buttons ("Run it", "Not now"), only after he can confirm a backup of this
App from just before the install exists (he reads Home Assistant's backups through his
read-only connector; if he can't see one, he doesn't offer the run). You can decline; nothing
else depends on it. Its steps change things, so they come in this order, the rollback last:

R1. `/opt/cain/record.sh block-push 3` (expect `the record keeper's rounds push to a wrong remote
   for the next 3 minutes`), then a checked test ask. For more than two minutes `keeper.sh clock`
   shows `"unpushed":true`; `/data/work/link.log` shows `left card <id>'s buttons on: no verified
   read of the ledger (unknown)` once, with the buttons still on; a tap on a Ship card meanwhile
   answers "Cain's record has unsaved changes, so Ship waits."; after three
   rounds you get one notice ("Cain's record hasn't saved to GitHub since ...: the smoke test is
   blocking it on purpose."). Then `"unpushed":false`.
R2. With a checked test ask up, `pkill -f /opt/cain/link/main.ts`. Expect `keeper.sh clock` to
   answer again within about 5 seconds, and your tap on the card relayed once.
R3. `/opt/cain/record.sh clock-test none` (expect `clock test: none`): a checked ask answers
   `"status":"refused"` naming each clock source, and a tap answers "The box's clock isn't
   synchronized just now". `/opt/cain/record.sh clock-test step:-600` (expect `clock test:
   step:-600`): the keeper log shows `dated after the clock stepped back` and a tap on an
   earlier card answers the status-changed line. `/opt/cain/record.sh clock-test off` (expect
   `clock test: off`): a new checked ask posts and its tap counts.
R4. `/opt/cain/record.sh block-push 2`, a checked test ask you tap (journaled), a queued row
   edit and a take of an item he holds, then `/opt/cain/record.sh force-conflict` (expect `the
   record keeper's next round with unpushed commits resets its copy, as after a conflict`).
   Expect: the keeper log shows `reset: its local commits couldn't be rebased onto GitHub's copy`
   and `reset epoch N: source checks on ... are void until taken again`; asks answer "the record
   keeper had to reset its copy of the record" until the push lands; a tap on a card posted
   before the reset answers "Cain's record was reset after this was asked, so nothing was done."
   and the next sweep takes its buttons off ("Record reset since, re-check needed"); the Checked
   cells show `pending re-check` and `keeper.sh clock` shows `recheck_pending`; its generation
   never goes down; Cain gets the "Re-check queue" line; your journaled tap either stands (its
   check survived the reset) or comes back on its card's thread as "Lost to the record's reset,
   please answer again." with Cain told the same; once the push lands, the row edit and the take
   are done, once each, and asks resume within two keeper rounds of the push landing (about two
   minutes): a new checked ask posts and its tap counts.
R4b. Pull the plug on a landing. Only with a real Ship you mean to make (a card for a head already
   in main pushes nothing, so it can't test this), and only if you choose to: tap Ship, then power
   off between the push and the ledger mark (pull the Pi's power right after the tap, before the
   card shows how it went). Expect, on the next start, the result to settle to landed exactly once:
   one "The link landed it" line to Cain, the card showing it shipped, no second push, and
   `keeper.sh clock` with no `unresolved_landings` once GitHub answers.
R5. The rollback, last. Cain asks you to restore this App from the backup taken just before the
   install, and gives you a message to send him once it's restored ("Rollback check: run
   /opt/cain/keeper.sh stopped and jq -r .alive /data/record-holds.json"). Expect keeper.sh
   answering and an alive time within the last two minutes. Then you install this version again
   from the App's update in Home Assistant, and Cain confirms `keeper.sh clock` answers. This is
   the one install done from Home Assistant's own page, on your say.

Rollback. If the smoke test fails, the remedy is one step: in Home Assistant, restore this
App from the backup taken just before the install (every install takes one first), which
brings back its previous version. That backup must cover the keeper's state file outside the
working copy (`/data/record-holds.json`, with the epoch, the reset that waits on it and the
consumed tap keys), the link's landing ledger (`/data/record-landings/`, checked against the remote
main before it is trusted again after a restore) and the link's state (`/data/link/state.json`,
with the tap keys, the cards' epochs and the intended generation); a backup of the whole App, as Home
Assistant takes before an install, covers all of `/data` but the two keys it leaves out. The
rollback test runs this version's record against the previous keeper, copied into the tests as
`cain/tests/fixtures/keeper-0.11.0`, and loads the state this version writes (epochs, tap keys,
the intended generation, a waiting epoch, a landing ledger) into that keeper and into the
previous link (`cain/tests/fixtures/link-0.11.0`): both start and ignore it. A roll-forward test
runs this version, then the previous link answering taps and landing, then this version again: no
stale claim acts and no ledger key gives a wrong result. On start the link raises its run counter,
and a claim from an earlier run is completed through the live-tap predicate or discarded and told
(Claims across a restart, by run, above), never by file times or save stamps; the tests step the
clock back and forward across it. The fixtures are pinned to the version installed on the Pi (0.11.0
today), and move when the Pi's does. They are rebuilt from main as it stands, never edited by hand:
after any rebase, from the repository root, `bash cain/tests/fixtures/regenerate.sh "$(git rev-parse
origin/main)" <the version on that main>` rewrites `link-<version>` and `keeper-<version>` from that
commit (the header of each file names it), and a test checks the committed copies match. After any
rebase onto a version bump (pull request 20, pull request 21 and pull request 23 also bump this
App's version; pull request 20 lands first and this rebases onto it, regenerating the fixtures, with full CI and the
round files rerun on the new head and the result file regenerated only from runs on that head),
both test suites and the rollback test run again on the new head before Ship. There is no switch that lets cards through without a
check. The previous version's record keeper (as of 0.11.0) ignores state/checks.json, the
`Checked` column and `state/one-off-audit.md` without error (tested): it reads and edits the
open list with the column in it, leaves the ledger and audit files alone, and rejects any
`check` or `one-off` request still queued from this version as malformed, harmlessly. Nothing
else needs reverting. Installed again later, this version sees from each row's `hash` which
rows the old keeper changed and gives them new versions, so no old check rests a card.

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
