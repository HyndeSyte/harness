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
behind "and 3 more", no commit or job ids or ISO times, and no button named that the
message (or the card Cain's reply answers) doesn't have. Em dashes and "add-on" are
fixed as they go out. Anything else is held back for Cain to rewrite before you see it.
If he's held back twice within 10 minutes, his third try goes out as it is, so the
rules can never silence him, and he hears so. The calendar specialist's cards are
never held back, since a held approval or Undo would be lost to you: their wording is
fixed, and Cain hears about anything else. Cain can edit only his own replies. A log on
the Pi, in Cain's own folder, keeps what the rules caught. After an update that changes
the rules, the App reads back over your DM once with them, posting nothing, and Cain
files what they found. Nothing for you to do.

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
their own), and Discord shows "(edited)" on the messages it moves between. While
everything is stopped it comes off, and Turn back on stays near the bottom instead: on
the morning message and the stopped notice, which is posted again when it's out of
reach, at most once an hour or after you write.

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

A Ship card has a line of the App's own, from GitHub: how many commits and files the
change has, and whether it touches the parts that matter most (Cain's link, his hooks,
permissions or rules, Ship and Stop, GitHub's workflows, an App's image, the release
rules), whatever Cain's own words on the card say.

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
