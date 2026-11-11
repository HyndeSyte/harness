# Cain

A Claude Code session that stays running on this box and answers your private
Discord bot, with your Claude connectors. It uses Anthropic's Discord channel
plugin (research preview) and your Claude plan; no API key.

## Set up (once)

1. Install and start the add-on. Leave auto-update off.
2. Open the **Cain** panel. It shows the Claude Code session.
3. Sign in to Claude when it asks (the link opens in your browser; paste the code back).
4. Type `/discord:configure` and your bot token. Then `/discord:access pair <code>`
   after you DM the bot, and `/discord:access policy allowlist`.
5. Type `/exit`. The session starts again in 5 seconds with Discord connected.

Only one place may run the bot at a time. Stop any other session using the same
token first, or both will answer.

## If the calendar specialist stops

Cain's add-on and the Harness add-on check each other every minute. If Harness hasn't
answered for 5 minutes, you get one Discord message from Cain's add-on, and one more when
it's back. If Cain's add-on is the one that stops, or its Discord connection stays down,
Harness tells you itself, both when it goes and when it's back. Restarts and
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
branches. An item nobody holds is Cain's.

### Who holds what: `state/holds.json`

The keeper owns it. Its own copy is `/data/record-holds.json` (in Home Assistant
backups); the copy in the record is put back to it whenever they differ, and no
request can write it. A keeper with no copy of its own (a new install) starts from
the record's. The file does not exist until the first hold. Read it as the keeper
pushed it: `/opt/cain/record.sh holds` on the Pi, or
`git show origin/main:state/holds.json` in a clone.

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

- Keys are item IDs, sorted. Fields are always in this order.
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
  keeper couldn't work (the box off, GitHub down) doesn't count toward the 24 hours.

### Requests

A change request (`kind: "change"`) holds up to 50 ops, applied in order, all or
nothing. Besides `put`, `append` and `remove`:

| Op | Fields | What it does |
| --- | --- | --- |
| `take` | `item`, `for`, `branches?`, `job?` | Granted if the item is free or its hold has ended, or if `for` starts with `dane:` (his word moves a hold, with its branches). Refused otherwise, naming the holder. The holder's own take renews it and adds branches. A branch already in another item's hold is refused. While a hold marked `job` is active, takes wait. `job` is Cain's only. |
| `pass` | `item`, `to` | The holder only. Moves the hold and its branches to `to` (`cain` or `laptop:<id>`) in one step; a `job` mark stays behind. |
| `release` | `item` | The holder only. The item is free (Cain's) again. |
| `row` | `item`, `base`, `set` | Changes cells of one open row. `base` is the row's hash as read: sha1 of the row's line, without the line ending (`record.sh rowsha <item>` on the Pi, `record-send.ts --row <item>` on a laptop). A changed row is a conflict; changes to other rows don't matter. `set` covers `Item`, `Who`, `Next step`, `Waits for`, `Done when`. |
| `row-add` | `item`, `cells` | Adds a row at the end of the open table, `Since` today. Needs `Item`. Refuses an ID in use, or one used before in Done. |
| `row-close` | `item`, `evidence` | Moves the row to the top of Done as `\| <ID> <Item>: <evidence> \| <date> \|`. |
| `note` | `item`, `text` | Anyone, holder or not, on any item the record knows (held, open, or done). Appended with its time and sender to `state/notes/<item>.md`, so it never conflicts and is never refused for a hold. `text` is one line, 1 to 2,000 characters. |

- Cells never hold `|` or a new line.
- Every change to `state/PENDING.md`, `put` included, is checked row by row: a row
  someone else holds refuses the whole request, naming the holder. The text around
  the tables and the Done table are anyone's.
- A `put` of `state/PENDING.md` made from an older version is laid onto the list as
  it stands when the rows it changed are untouched since (both sides changing one
  row, or the text around the tables, is still a conflict).
- A request from the holder that changes its row renews its hold. A laptop session
  renews its holds hourly while you chat with it.
- A change that changes nothing is rejected: "changes nothing".

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
- Cain reads them with `/opt/cain/record.sh notes <item> [<ISO time>]`: one table row
  per note, oldest first, only those after the time if one is given; nothing when
  there are none. Items nobody holds are Cain's, so their notes are his to read too.
- A laptop session's per-turn hook (`record-holds.ts --hook`) shows each new note on
  its held items once. `record-send.ts` shows any it hasn't seen on the items a request
  touches and holds that request back once, so a holder reads a note before its next
  write.
- This op is not the request kind `note`, which is his page's words relayed to Cain.

`from` is `cain` (only through Cain's local queue), `laptop:<session id>` (stamped
by `record-send.ts`), or `page` (your page). Older requests from plain `laptop` are
still read, and recorded as such, but can't hold anything.

Outcomes in `log/requests`: `done`, `conflict` (re-read and redo), `rejected` (breaks
a rule), `refused` (someone else holds the item), `relayed`, and `waiting` (a take
behind one of Cain's jobs: a second line with the same id says how it ended).

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
  `--renew` to renew its holds at most hourly.
- `record-prepush.ts`, run by `pre-push`: refuses a push to any branch the session
  doesn't hold, reading `state/holds.json` fresh from the record's main. With no
  session id (Dane in a terminal), `git push --no-verify` skips it.
- `record-preflight.ts <request.json> <clone>`: the keeper's checks only.

To set a laptop up (the session id comes from Claude Code's
`CLAUDE_CODE_SESSION_ID`; use forward slashes in paths):

1. A clone of the record on `main` with `user.name` and `user.email` set (the tools
   fetch it themselves), and a clone of this repo kept on `main` for the tools.
2. In the laptop's Claude Code settings (`~/.claude/settings.json`):

   ```json
   {
     "env": { "RECORD_CLONE": "C:/path/to/org", "CAIN_TOOLS": "C:/path/to/harness-tools" },
     "hooks": {
       "SessionStart": [{ "hooks": [{ "type": "command",
         "command": "bun C:/path/to/harness-tools/cain/tools/record-holds.ts --hook" }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command",
         "command": "bun C:/path/to/harness-tools/cain/tools/record-holds.ts --hook --renew", "timeout": 30 }] }]
     }
   }
   ```

3. In each clone of this repo a session builds in, git's pre-push hook: copy
   `cain/tools/pre-push` to `.git/hooks/pre-push`. It runs the tool from `CAIN_TOOLS`,
   so it is the same whichever branch is checked out.
