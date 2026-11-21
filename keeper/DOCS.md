# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. It tells you without
going through Cain, through two Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What it does

1. **Before an install.** The Ship run takes a backup of that one App, writes the install into
   Keeper's options (`attempt`, below) and waits for Keeper's log line
   `accepting <id> <app> <from> to <to> backup <slug>`. Keeper accepts only a backup that holds that
   App alone, at the version being replaced, with no Home Assistant and no folders. A backup that
   fails that check is logged as `refusing <id>: <why>`, nothing is ever restored for that install,
   and you hear it ("unprotected").
2. **The watch.** From the moment Keeper first sees the new version, for 15 minutes, every 30
   seconds, it reads the App's version and state from the Supervisor and asks its `/health`. The
   install fails at once on: the App's state being error; the App not started on two polls in a row;
   `/health` failing on three polls in a row (counted only after `health_grace_s` seconds from the
   App's first start); the App's own probe saying FAIL; the install deadline passing with the new
   version never started. It passes only if, at the end of the 15 minutes, the App's probe said PASS
   for this install, the App was started on every poll since it first started, and `/health`
   answered 200 on the last three polls. Anything else at the end is a fail.
3. **The rollback.** On a fail Keeper restores the registered backup with that App alone (Home
   Assistant false, no folders), retrying while the Supervisor is busy for up to 15 minutes, once per
   install. Then it checks the old version is started and healthy within 5 minutes. It ends as
   "rolled back", or as "gave up" if the restore failed or the App didn't come back.
4. **A change nobody registered.** If a watched App's version changes with no install registered,
   Keeper never restores anything: it logs it and you hear it ("unregistered change").
5. If the install deadline passes with the App still at its old version, nothing is restored and you
   hear "install never started".

Keeper keeps its state in its own `/data` (never in `/share`): the last version seen of each App,
every install with its deadlines, a heartbeat time written every minute, its drill records and its
armed record. After a restart it picks up an open install where it was, and judges at once a
deadline that passed while it was down. A restore that was under way when it stopped is never
started again, only confirmed.

Keeper doesn't watch its own install, and an update of Keeper should wait while an install is open
(it logs that if it is stopped meanwhile and resumes at its next start).

## What a rollback loses

The App's data written after the backup: a rollback restores the App's whole `/data` as it was in
the backup taken just before the install. For Cain that is the minutes between the backup and the
rollback (cards, taps and records written then). Home Assistant itself, `/share` and every other App
are left alone.

## What you must set before it can arm

1. **Two Healthchecks.io checks**, both with your phone as the recipient, period 5 minutes, grace
   10 minutes, and repeated reminders on:
   - `hc_done`: Keeper pings it every 5 minutes as its heartbeat (so a stopped Keeper alerts you
     within the grace), and with a line after a completed rollback.
   - `hc_failed`: Keeper sends a fail ping carrying the line on "gave up", "unprotected",
     "unregistered change" and "install never started", retried until delivered, and a success ping
     once the App is started and healthy again, so the next one alerts you again.
   Paste each check's ping URL into the option. Until both are set Keeper only logs its lines and is
   "not armable".
2. **The tokens.** Make one random token per watched App (at least 16 characters, for example
   `openssl rand -hex 24`). Put it in Keeper's `tokens` as `0fcc2575_cain=<token>`, and the same token
   in the Cain App's `keeper_token` option. A request with any other token, or from outside Home
   Assistant's internal App network, is refused and logged.

## Arming

"Ship it with that risk" goes only while the rollback is armed for the App. Keeper arms an App after
two drills of it have each rolled back by an actual restore of their registered backup, with their
trigger and a delivered line to you: one where the App's probe said FAIL, and one where the App exits
on start. The armed record is bound to the verdict protocol, the App's probe (its hash), Keeper's
version, Keeper's options (all but `attempt`) and the backup scope. It is dropped when any of those
changes, after 60 days, when Keeper's heartbeat stopped for more than 10 minutes (a restore of Keeper
or a long stop), and while the Healthchecks URLs are unset. Then the drills are needed again.

## Options

| Option | What it is |
| --- | --- |
| `watch` | The App slugs Keeper watches. Default `0fcc2575_cain`. |
| `health` | Each watched App's health address on the internal network, `slug=host:port`. Default `0fcc2575_cain=0fcc2575-cain:8098`. |
| `tokens` | Each App's own token, `slug=token` (see above). |
| `hc_done`, `hc_failed` | The two Healthchecks ping URLs (see above). |
| `health_grace_s` | Seconds after a watched App first starts before failed `/health` polls count. Default 180. |
| `attempt` | Written by the Ship run just before an install. Leave it alone by hand. |

Options are read again every 30 seconds: a change needs no restart (and drops the armed record).

`attempt` holds: `id`, `app`, `from_version`, `to_version`, `backup_slug`, `install_deadline` (an
absolute time, ISO 8601 or epoch seconds, at most 6 hours ahead), `authorization` (`ship`, or
`ship <token>` after a ship-with-risk tap, or `drill <token>`; Keeper keeps only a hash of a token)
and `probe_hash` (the first 16 hex digits of the SHA-256 of the App's verdict probe at the release
being installed; for Cain `cain/rootfs/opt/cain/probe/keeper.ts`).

## Its service

On Home Assistant's internal App network only (port 8097, no host port), each call with the calling
App's token (`Authorization: Bearer <token>`):

- `GET /attempt`: the open install of the caller's App, or none.
- `POST /verdict` `{app, version, attempt, result: PASS|FAIL, reason}`: accepted only for the open
  install of the caller's App, at its new version. Anything else is ignored and logged.
- `GET /armed?app=<slug>`: the armed state, its binding, Keeper's version and a timestamp refreshed
  every minute.
- `GET /last`: Keeper's last line to you about the caller's App.

## Permissions

The Supervisor's backup role only (App and backup info, backups and restores), never manager. No
Home Assistant API, no ingress, no page, no `/share`.
