# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. It tells you without
going through Cain, through two Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What it does

1. **Before an install.** The Ship run takes a backup of that one App, writes the install into
   Keeper's options (`attempt`, below) and waits for Keeper's log line
   `accepting <id> <app> <from> to <to> backup <slug>`. Keeper accepts only a backup that holds that
   App alone, at the version being replaced, with no Home Assistant and no folders, made without a
   password (a backup whose info says `protected` is refused: Keeper has no password to restore it
   with). A backup that fails that check is logged as `refusing <id>: <why>`, nothing is ever restored
   for that install, and you hear it ("unprotected").
2. **The watch.** From the moment Keeper first sees the new version, for 15 minutes, every 30
   seconds, it reads the App's version and state from the Supervisor and asks its health address
   (option `health`; for Cain his readiness, `/ready`, which answers 200 only while his Discord
   connection is up; his `/health` is liveness, for Home Assistant's Watchdog). The
   install fails at once on: the App's state being error; the App not started on two polls in a row;
   `/health` failing on three polls in a row (counted only after `health_grace_s` seconds from the
   App's first start); the App's own probe saying FAIL; the install deadline passing with the new
   version never started. It passes only if, at the end of the 15 minutes, the App's probe said PASS
   for this install, the App was started on every poll since it first started, and `/health`
   answered 200 on the last three polls. Anything else at the end is a fail.
3. **The rollback.** On a fail Keeper pages you at once (a fail ping carrying the line: "Keeper is
   rolling back ...") and restores the registered backup with that App alone (Home Assistant false, no
   folders), as one Supervisor job per install. It keeps that job's id with the install before
   anything else. A restore the Supervisor refused (busy with another job) is sent again with backoff
   for up to 15 minutes. A call that got no answer (a timeout, a broken connection, or Keeper restarted
   while it was out) is never just sent again: Keeper first reads the job's state from the Supervisor's
   jobs list and the App's info (back at the old version and started means the restore landed), and
   sends it again only if the Supervisor shows the job ended without restoring. Once the restore has
   landed, Keeper watches for 5 minutes: it ends as "rolled back" (the success ping, carrying the line)
   if the old version is then started and healthy, and as "gave up" if the restore failed, the App
   didn't come back, or it kept restarting (started, then stopped or error, more than twice in those 5
   minutes).
   If the outcome can't be established within the 15 minutes, the install ends as **"unresolved"**:
   nothing is restored again by itself, you hear it, and at each next start Keeper reads the job and
   the App again (landed goes on to the 5-minute check; a job seen ended without restoring is "gave
   up"; otherwise it stays unresolved and says so in its log). Check the App and Settings, System,
   Backups yourself; an unresolved install doesn't block the next one.
4. **A change nobody registered.** If a watched App's version changes with no install registered,
   Keeper never restores anything: it logs it and you hear it ("unregistered change").
5. If the install deadline passes with the App still at its old version, nothing is restored and you
   hear "install never started".

Keeper keeps its state in its own `/data` (never in `/share`): the last version seen of each App,
every install with its deadlines, a heartbeat time written every minute, the time of the last heartbeat
Healthchecks answered, its drill records and its armed record, the spent registrations, and its kept
settings (below). After a restart it picks up an open install where it was, and judges at once a
deadline that passed while it was down. A restore that was under way when it stopped is never
started again blindly, only reconciled from its job and confirmed.

## Registrations: each one counts once, and can't change Keeper's settings (0.1.1)

- **Read through the Supervisor.** Keeper reads its options from the Supervisor every 30 seconds
  (`/data/options.json` is written only when the App starts, so a registration the Ship run writes
  through the connector shows there first).
- **Kept settings.** Keeper keeps its tokens and its two Healthchecks URLs in `/data`. If options that
  carry a new registration have lost or changed any token or URL that was there before, Keeper refuses
  it (`refusing <id>: the registration changed the keeper's own settings`, "unprotected", you hear it)
  and keeps using the ones it had, so Cain can still reach it and it stays armable. They stay in force
  while that registration stands in the options; fix the options (or let the next registration replace
  it) and Keeper takes them as they are again. A change of tokens or URLs with no registration in it is
  yours and is taken.
- **Spent.** Every registration id Keeper takes is spent, with a hash of its fields. Once it accepts a
  registration (its authorization kept only as a hash), it empties `attempt` in its own options through
  the Supervisor (`/addons/self/options`, every other option written back as it was), and logs
  `cleared <id> from the keeper's options`. A spent registration seen again after that, or a
  registration with a spent id and other fields, is refused as a replay, logged once and you hear it.
  If the Supervisor refuses the clear, Keeper logs `couldn't clear <id> ...`: the plain registration,
  authorization included, then stays in its options (spent, so it can't be used again) until the next
  registration replaces it.
- **What a backup of Keeper carries.** Keeper's options (its tokens and Healthchecks URLs, and a
  registration that couldn't be cleared), its `/data/options.json` as written at its last start, and
  its state file with the kept tokens and URLs. Treat a backup of the Keeper App like its options page.
  A Ship or drill authorization in it is spent: Keeper refuses it as a replay.

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
     within the grace), and nothing else. A heartbeat that isn't delivered is tried again a minute later.
   - `hc_failed`: every line to you goes here. A fail ping carrying the line when a rollback starts,
     and on "gave up", "unresolved", "unprotected", "unregistered change" and "install never
     started"; a success ping carrying the line once a rollback is confirmed (the old version started
     and healthy), or "started and healthy again" once the App is, so the next one alerts you again.
     Every ping is retried until delivered, and a success ping never goes ahead of its App's fail ping.
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

The delivery gate (0.1.1): `/armed` answers armed only while a heartbeat ping was delivered to
Healthchecks (a 2xx answer) within the last 10 minutes, so a rollback can't be armed while its alerts
can't reach you. When no heartbeat has been delivered for 10 minutes the armed record is dropped, with
the reason in the log (`disarmed for <app>: no heartbeat ping was delivered ...`), and the drills are
needed again. A registration never drops it: the options' hash in the binding leaves `attempt` out.

## Options

| Option | What it is |
| --- | --- |
| `watch` | The App slugs Keeper watches. Default `0fcc2575_cain`. |
| `health` | Each watched App's health address on the internal network, `slug=host:port/path` (no path: `/health`). Default `0fcc2575_cain=0fcc2575-cain:8098/ready`, Cain's readiness. |
| `tokens` | Each App's own token, `slug=token` (see above). |
| `hc_done`, `hc_failed` | The two Healthchecks ping URLs (see above). |
| `health_grace_s` | Seconds after a watched App first starts before failed `/health` polls count. Default 180. |
| `attempt` | Written by the Ship run just before an install, and emptied by Keeper once it has taken it. Leave it alone by hand. |

Options are read again every 30 seconds, through the Supervisor: a change needs no restart (and a
change to anything but `attempt` drops the armed record).

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

The Supervisor's backup role only (App and backup info, the jobs list `/jobs/info`, backups and
restores), plus what every App may do to itself (`/addons/self/info`, `/addons/self/options`), never
manager. No Home Assistant API, no ingress, no page, no `/share`. If on the device the Supervisor
refuses the jobs list or the options write to this role, Keeper says so in its log (an unknown job then
ends as "unresolved", a registration stays in its options, spent): that is a device check, and the role
stays backup.
