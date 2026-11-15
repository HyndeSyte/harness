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
need a new one.

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
  - busy: the read took longer than 1.5 seconds. The limit is enforced on the read itself: it
    is raced against a timer and cancelled through an abort signal when the timer wins, so a
    stalled read answers within the limit (tuned from the measured reads the smoke test
    prints). "Busy, tap again." Each is logged to `/data/record-waits.jsonl` and counted in
    `state/one-off-audit.md` as a tap timeout.
  - clock: the box's clock isn't synchronized now (the keeper's verdict from the last 10
    minutes says it isn't, or neither the box's own sources nor that verdict says it is).
    "The box's clock isn't synchronized just now, so nothing was done. Tap again in a few
    minutes."
  - record reset: the keeper had to reset its copy and hasn't pushed since. "Cain's record
    is being put back in step, so nothing was done. Tap again in a few minutes."
  - record unpushed: the keeper's pushes have been failing for over 30 minutes. "Cain's
    record hasn't saved for over half an hour, so nothing was done. Tap again once it has."
  Where the row sits in the table is never used.
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
push carrying them lands, so a reset runs them again like the other queued requests.

A tap honoured while the ledger is unpushed is journaled by the link in its state file in
`/data` (the card's generation, the check's request id, the item, the time and the label). If
the keeper then resets its copy, the link lists those taps to Cain in a relayed line and tells
you in one short notice that they acted on a check that may not have landed; the journal is
cleared once a push lands. Once a push failure is older than 30 minutes, taps are refused with
their own reason (record unpushed) instead. And when the keeper's status has shown unpushed or
reset for more than 30 minutes or three rounds, the link posts you one notice, once per outage,
with the push error in plain words ("Cain's record hasn't saved to GitHub since 9:40 AM: GitHub
didn't answer. Nothing is lost: the box keeps its copy and keeps trying.").

What is mechanical and what rests on Cain's word. Mechanical, in code: no ask or Ship card
about an item posts, and no tap on one counts, without a `check` the keeper accepted for
the row's current version, by its synchronized clock, within the age limit; the check text
names a concrete source and a time in the right shape and isn't a repeat; rows are versioned
by content, matched by code, with hidden ids; whole-file writes are atomic; one-offs that
name or sound like an open item are refused or held. Resting on Cain's recorded attestation:
that he actually read the source he names, that what he read says what the row and the
question imply, and that a one-off's reason is true. The gate proves a check was recorded,
not that the source was read.

Device smoke test. Right after installing a version with source checks, Cain runs these
against the real record, under about twenty minutes in all (the first eight steps about seven,
then the time given with each), and reports the result to you in one line. The steps that
change things come last.

1. A checked ask about an item he holds, with a concrete source: it posts, and your tap on
   it is accepted (the link relays it to him). It says it is the smoke test; any answer
   does.
2. The same kind of ask with a deliberately vague source ("from memory"): nothing posts,
   and keeper.sh's refusal line arrives quoting the vague word.
3. The Ship path the same way, on a harmless card: a checked Ship card for the pull request
   that brought this version (already in main), where your tap on "Not now" is accepted and
   nothing ships; and the same card with a deliberately vague source, which posts nothing.
4. A checked test ask, then an edit of its row (a word in its Next step): you tap the old
   card, and it must be refused with the status-changed reason, its buttons off.
5. A one-off that looks like an open item: it must be held ("needs reason"); sent again
   with `--reason`, it must post, and the reason must show in `log/requests/`.
6. `/opt/cain/record.sh block-push`, then a checked test ask: its check lands locally while
   that round's push goes to a wrong remote. You tap it during the blocked push: it must be
   honoured (nothing moved), with the buttons kept until then; `keeper.sh clock` must show
   `unpushed` until the next round pushes.
7. An expired check: you set source_check_max_days to 0 in the App's options for one ask
   (the App restarts); a checked test ask must post nothing and say the check is past
   source_check_max_days. Then you set it back to 7. This is the only option you change.
8. `/opt/cain/keeper.sh clock`: the clock verdict, which source satisfied it, and the
   measured tap read time (from step 4's or 6's tap), all in his one-line report.
9. (a) GitHub's Date header, and no secrets (1 minute). `/opt/cain/record.sh clock-test
   header-only` (expect `clock test: header-only`): the next round leaves the box's own clock
   sources out. Then a checked test ask with a concrete source, which must post; and one with a
   vague source, whose refusal line he saves to `/tmp/smoke-refusal.txt`. Expect in
   `/data/work/record-keeper.log`: `clock: the smoke test's clock switch is on (header-only)`,
   `clock: synchronized, by the GitHub Date header (+N s)` and `clock: offset against GitHub's
   Date header +N s`. Then `/opt/cain/record.sh leak-check /tmp/smoke-refusal.txt`: the keeper,
   which alone holds the token, reads its log, its status file, the relay queue and that file
   for the token and for a web address's userinfo, and prints yes or no per file, never the
   match. Expect `{"clean":true,...}`; any `true` under token or userinfo fails the test.
10. (b) Read times (2 minutes). `/opt/cain/keeper.sh reads 20`: twenty fresh reads, the way a
   tap reads, 4 seconds apart, so some run while a keeper round fetches from GitHub. Expect
   `"pass":true` with `p95_ms` at most 1000 and `keeper_rounds_seen` at least 1; a 95th
   percentile over about one second fails.
11. (c) A slow read (half a minute). `/opt/cain/keeper.sh slow-read` (expect `"status":"ok"`),
   then a checked test ask, and you tap it: you must see "Busy, tap again." with the buttons
   still on, and `/data/work/link.log` must show `tap refused: the ledger's read took`. Your
   next tap on it is honoured.
12. (d) A push failure that keeps going (3 minutes). `/opt/cain/record.sh block-push 3` (expect
   `the record keeper's rounds push to a wrong remote for the next 3 minutes`), then a checked
   test ask. For more than two minutes `keeper.sh
   clock` must show `unpushed`; `/data/work/link.log` must show `left card <id>'s buttons on:
   no verified read of the ledger (unknown)` once only, with the card's buttons still on; and
   after three rounds you get one notice: "Cain's record hasn't saved to GitHub since ...: the
   smoke test is blocking it on purpose. ...". Once the minutes pass, `keeper.sh clock` must
   show `unpushed: false`.
13. (e) A restart of the link (1 minute). With a checked test ask up, `pkill -f
   /opt/cain/link/main.ts`; the App starts the link again within about 5 seconds (expect
   `keeper.sh clock` to answer again). You tap the card: it must be honoured and relayed.
14. (f) Clock loss and a backward step (2 minutes). `/opt/cain/record.sh clock-test none`
   (expect `clock test: none`): a checked test ask must post nothing, its refusal naming what
   each clock source said, and a tap on an earlier card must answer that the box's clock isn't
   synchronized. `/opt/cain/record.sh clock-test step:-600`: the keeper's clock reads ten
   minutes early; the log must show `dated after the clock stepped back` and a tap on a card
   checked before it must be refused with the status-changed reason. `/opt/cain/record.sh
   clock-test off`: a new checked test ask must post and its tap be honoured.
15. (g) A forced reset (2 minutes). `/opt/cain/record.sh block-push 2`, then a checked test
   ask that you tap (it is journaled), and two requests of his accepted locally and still
   queued: a row edit and a `take` of an item he holds; then `/opt/cain/record.sh force-conflict`
   (expect `the record keeper's next round with unpushed commits resets its copy, as after a
   conflict`). Expect: the keeper log shows `reset: its local commits couldn't be rebased onto
   GitHub's copy (git rebase: conflict forced by the smoke test`; asks answer "the record
   keeper had to reset its copy of the record" and taps "Cain's record is being put back in
   step"; `keeper.sh clock` never shows a generation lower than before; Cain gets the relayed
   line naming the tapped card ("Acted on a check that may not have landed") and you get one
   notice ("Heads up: one of your taps ... acted on a check that may not have landed"); once
   the minutes pass and the push lands, asks and taps work again, and the row edit and the take
   are done (they ran again from the queue).
16. (h) The rollback, last (3 minutes). Cain can't change Home Assistant, so he asks you: in
   Home Assistant, restore this App from the backup taken just before the install, which brings
   back the pinned previous version (0.11.0). He gives you a message to send him once it's
   restored ("Rollback check: run /opt/cain/keeper.sh stopped and jq -r .alive
   /data/record-holds.json"), since the restored version doesn't have these steps. Expect his
   answer to show keeper.sh answering (the link is back) and an alive time within the last two
   minutes (the keeper is). Then you install this version again from the App's update in Home
   Assistant, and Cain confirms it runs and `keeper.sh clock` answers. This is the one install
   done from Home Assistant's own page, on your say.

It passes only when he sees committed in the record the `check` request done in
`log/requests/`, `state/checks.json` with that row's entry and his check, and the open
table's `Checked` column showing it, and reports the commit hashes of those three (the log
entry, the ledger write and the table change), so you can spot-check them on GitHub.

Rollback. If the smoke test fails, the remedy is one step: in Home Assistant, restore this
App from the backup taken just before the install (every install takes one first), which
brings back its previous version. The rollback test runs this version's record against the
previous keeper, copied into the tests as `cain/tests/fixtures/keeper-0.11.0`: that fixture is
pinned to the version installed on the Pi (0.11.0 today), and moves when the Pi's does. After any
rebase onto a version bump (another open pull request, pull request 21, also bumps this App's version),
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
