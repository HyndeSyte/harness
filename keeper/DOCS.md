# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. It tells you without
going through Cain, through Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What installing it enables, and what it doesn't

- Keeper watches and logs. It restores only for an install the Ship run registered, whose
  authorization matched and whose backup it verified (that App alone, at the version being replaced,
  made without a password), and at most one restore job per install (a second only when the first
  provably never ran, below).
- Nothing registers an install until the Ship steps in RELEASING.md do; an unregistered version change
  is only logged and reported, never restored.
- It can't be armed until both drills have rolled back for real on the device (the next job), so
  "Ship it with that risk" stays refused until then.

## The owner's tap at both execution points

How it is enforced today, mechanically:

1. Your Ship tap yields a Ship token: signed by Cain's link with its own key, bound to the repository,
   the pull request and its head commit, good for 2 hours and void after a Stop
   (`cain/rootfs/opt/cain/ship-token.ts`). The hook below doesn't count a token's uses; its single use
   at the install end is Keeper's: one registration per App per token, any other is a replay (below).
2. Cain's RemoteTrigger hook refuses a Ship run without a valid token for exactly that pull request and
   head (`cain/rootfs/opt/cain/hooks/remote-trigger.ts`), and refuses every run while you have Stop on.
3. The Ship run is the only install executor (RELEASING.md, "One installer").
4. Keeper restores only for a registered attempt it accepted, and it accepts only an authorization of
   the right shape whose expiry hadn't passed at registration (and no further off than a Ship token
   lasts), never seen before for that App. Keeper can't check the token's signature itself (it never
   sees the token, only its SHA-256); the signature is checked at step 2.
5. A registration for an App Keeper doesn't watch is refused. One whose `to_version` the App never
   shows by the install deadline ends as "install never started", with no restore.

## What it does

1. **Before an install.** The Ship run takes a backup of that one App, writes the install into
   Keeper's options (`attempt`, below; every other option written back as it was) and waits for
   Keeper's log line `accepting <id> <app> <from> to <to> backup <slug>`. Keeper accepts only a backup
   whose info shows that App alone, at the version being replaced, with no Home Assistant and no
   folders, and `protected` false (Keeper has no password to restore with; a backup whose info doesn't
   say `protected: false` is refused). A refusal is logged as `refusing <id>: <why>`, nothing is ever
   restored for that install, and you hear it ("unprotected").
2. **The watch.** From the moment Keeper first sees the new version, for 15 minutes, every 30
   seconds, it reads the App's version and state from the Supervisor and asks its health address
   (option `health`; for Cain his readiness, `/ready`, which answers 200 only while his Discord
   connection is up; his `/health` is liveness, for Home Assistant's Watchdog). The install fails at
   once on: the App's state being error; the App not started on two polls in a row; the health address
   failing on three polls in a row (counted only once it has answered 200 since the App's latest start,
   and after `health_grace_s` seconds from its first start); the App's own probe saying FAIL; the
   install deadline passing with the new version seen but never started. It passes only if, at the end
   of the 15 minutes, the App's probe said PASS for this install, the App was started on every poll
   since it first started, and the health address answered 200 on the last three polls. Anything else
   at the end is a fail, so an App that never became ready (a long Discord outage) fails the check at
   the end, and you hear it.
3. **The rollback.** On a fail Keeper pages you at once (a fail ping carrying the line: "Keeper is
   rolling back ...") and restores the registered backup with that App alone (Home Assistant false, no
   folders, the Supervisor's `background` flag passed explicitly as true), as one Supervisor job. It
   marks the call in flight before sending it and keeps the job id from the answer before anything
   else. The resend rule:
   - A second restore call goes out only (a) after the Supervisor answered the first with an HTTP error
     (nothing executed: busy with another job, a server error; with backoff, inside 15 minutes), or
     (b) once the job named by the first answer's id is seen ended with errors and the App is not back
     at the old version.
   - No answer, an answer with no job id, or a restart while the call was out never allows a second
     call. A job is only ever looked up by that id: no other job, even a restore of the same backup,
     counts.
   - "Landed" is that job seen finished without errors, or the App's own states seen after the call:
     not started (stopped or error), then started at the old version. The version and state alone are
     never enough (the App may never have gone down).
   Once landed, Keeper watches for 5 minutes: "rolled back" (the success ping, carrying the line) if the
   old version is then started and healthy; "gave up" if it isn't, or it kept restarting (started, then
   stopped or error, more than twice in those 5 minutes). If at the end of the 5 minutes the App is
   started and its `/health` answers 200 but its health address (Cain's `/ready`) doesn't, the window is
   extended once, by 5 minutes, before deciding.
4. **Unresolved.** Anything ambiguous at the restore's 15 minute limit ends as **"unresolved"**, and you
   hear it. It is fenced: nothing is restored again by itself, across restarts and however long it
   lasts. While Keeper runs, every poll reconciles it again, read only, from the job by its id and the
   App's states. When the outcome becomes known it moves on: landed goes to the 5 minute check and ends
   as "rolled back" or "gave up"; the job seen ended with errors with the App not back is "gave up".
   Either way one follow-up line reaches you. Check the App and Settings, System, Backups yourself
   meanwhile; an unresolved install doesn't block the next one.
5. **A change nobody registered.** If a watched App's version changes with no install registered,
   Keeper never restores anything: it logs it and you hear it ("unregistered change").
6. If the install deadline passes without the registered version ever seen (still the old one, or
   another), nothing is restored and you hear "install never started".

Keeper keeps its state in its own `/data` (never in `/share`): the last version seen of each App,
every install with its deadlines, a heartbeat time written every minute, the times of the last
heartbeat and log pings Healthchecks answered, its drill records, the spent registrations, and its kept
settings (below). After a restart it picks up an open install where it was, and judges at once a
deadline that passed while it was down. A restore that was under way when it stopped is never sent
again on that alone, only reconciled.

## Registrations

- **Read through the Supervisor, never written.** Keeper reads its options from the Supervisor every 30
  seconds (`/data/options.json` is written only when the App starts, so a registration the Ship run
  writes through the connector shows there first). Keeper never writes any options, its own included.
- **The authorization holds no secret.** It is one line:
  `ship sha256=<64 hex> pr=<number> head=<40 hex> expires=<time>` (or `drill ...` for a drill tap):
  the SHA-256 of your Ship token (the Ship run computes it; the token itself never goes into the
  options), the pull request number and full head commit the token was issued for, and the token's
  expiry (ISO 8601 or epoch seconds). Each key once, in any order, nothing else. Anything else, an
  expiry already passed at registration, or one further off than a Ship token lasts (2 hours and 5
  minutes), is refused as "unprotected". Keeper keeps the hash with the spent registration.
- **Each registration counts once.** Every id Keeper takes is spent, with a hash of its fields and its
  token hash. The registration Keeper accepted stays in its options until the next Ship run writes the
  next one: seen again unchanged it is ignored silently (no line, no ping). A replay is the same id with
  other fields, or the same token hash under another id for the same App (one Ship tap that installs
  both Apps registers each once): it is refused once and reported once.
- **Kept settings.** Keeper keeps its tokens and its Healthchecks URLs in `/data` whenever its options
  carry them. When its options lack the tokens, `hc_done` or `hc_failed` altogether (a wiped options
  file, at a start or later), it uses the kept ones and logs one line (`the options lack ...: the ones
  kept in /data are used`). A new registration whose options lost or changed any kept token or URL is
  refused (`refusing <id>: the registration changed the keeper's own settings`, "unprotected", you hear
  it) and the kept ones stay in force while it stands in the options. A change of tokens or URLs with no
  new registration in it is yours and is taken (to drop a setting for good, replace it: an empty one is
  filled from the kept one).
- **What a backup of Keeper carries.** Its options (the tokens and Healthchecks URLs, and the last
  registration, which holds no token), its `/data/options.json` as written at its last start, and its
  state file with the kept tokens and URLs. Treat a backup of the Keeper App like its options page.

Keeper doesn't watch its own install, and an update of Keeper should wait while an install is open
(it logs that if it is stopped meanwhile and resumes at its next start).

## What a rollback loses

The App's data written after the backup: a rollback restores the App's whole `/data` as it was in
the backup taken just before the install. For Cain that is the minutes between the backup and the
rollback (cards, taps and records written then). Home Assistant itself, `/share` and every other App
are left alone.

## What you must set before it can arm

1. **Healthchecks.io checks**, each with your phone as the recipient, period 5 minutes, grace 10
   minutes, and repeated reminders on:
   - `hc_done`, the heartbeat: Keeper pings it every 5 minutes (so a stopped Keeper alerts you within
     the grace), and nothing else. A heartbeat that isn't delivered is tried again a minute later.
   - `hc_failed`, the alert check: one ping URL for every App, or one per App (`slug=URL` entries, with
     at most one plain URL for every other App). Every line about an App goes to its own alert check: a
     fail ping carrying the line when a rollback starts, and on "gave up", "unresolved", "unprotected",
     "unregistered change" and "install never started"; a success ping carrying the line once a
     rollback is confirmed, or "started and healthy again" once the App is, so its next one alerts you
     again. A success ping clears only its own App's incident. Keeper's own lines (a refused replay with
     no App) go to the plain URL, else to the first watched App's check. Every ping is retried until
     delivered, and a success ping never goes ahead of its App's fail ping. Every 5 minutes Keeper also
     sends each alert check a log ping (its ping URL plus `/log`), which Healthchecks records without
     changing the check's state or paging you: it shows the alert path answers.
   Paste each ping URL into the option. Until `hc_done` and an alert check for every watched App are
   set Keeper only logs its lines and is "not armable".
2. **The tokens.** Make one random token per watched App (at least 16 characters, for example
   `openssl rand -hex 24`). Put it in Keeper's `tokens` as `0fcc2575_cain=<token>`, and the same token
   in the Cain App's `keeper_token` option. A request with any other token, or from outside Home
   Assistant's internal App network, is refused and logged.

## Arming

"Ship it with that risk" goes only while the rollback is armed for the App. `/armed` is worked out at
every read, never stored, and says armed only while all five hold:

1. the Healthchecks URLs are set (`hc_done`, and an alert check for every watched App);
2. both drill records of the App are valid under the current binding: two drills each rolled back by
   an actual restore of their registered backup, with their trigger and a delivered line to you, one
   where the App's probe said FAIL and one where the App exits on start;
3. a heartbeat ping was delivered (a 2xx answer) within the last 10 minutes;
4. each alert check's log ping was delivered within the last 10 minutes;
5. no fail ping has waited undelivered in the queue for more than 2 minutes.

So a Healthchecks outage reads as not armed and recovers by itself once pings get through. The binding
is the verdict protocol, the App's probe (its hash), Keeper's version, Keeper's options (all but
`attempt`) and the backup scope. The drill records are dropped only when the binding changes, after 60
days, or when Keeper's heartbeat stopped for more than 10 minutes before a start (a restore of Keeper or
a long stop); then the drills are needed again. A registration never drops them.

## Options

| Option | What it is |
| --- | --- |
| `watch` | The App slugs Keeper watches. Default `0fcc2575_cain`. |
| `health` | Each watched App's health address on the internal network, `slug=host:port/path` (no path: `/health`). Default `0fcc2575_cain=0fcc2575-cain:8098/ready`, Cain's readiness. |
| `tokens` | Each App's own token, `slug=token` (see above). |
| `hc_done` | The heartbeat check's ping URL. |
| `hc_failed` | The alert check: a list with one plain ping URL (every App), and/or `slug=URL` entries. |
| `health_grace_s` | Seconds after a watched App first starts before failed health polls count. Default 180. |
| `attempt` | Written by the Ship run just before an install. Leave it alone by hand. |

Options are read again every 30 seconds, through the Supervisor: a change needs no restart (and a
change to anything but `attempt` drops the drill records).

`attempt` holds: `id`, `app`, `from_version`, `to_version`, `backup_slug`, `install_deadline` (an
absolute time, ISO 8601 or epoch seconds, at most 6 hours ahead), `authorization` (above) and
`probe_hash` (the first 16 hex digits of the SHA-256 of the App's verdict probe at the release being
installed; for Cain `cain/rootfs/opt/cain/probe/keeper.ts`).

## Its service

On Home Assistant's internal App network only (port 8097, no host port), each call with the calling
App's token (`Authorization: Bearer <token>`):

- `GET /attempt`: the open install of the caller's App, or none.
- `POST /verdict` `{app, version, attempt, result: PASS|FAIL, reason}`: accepted only for the open
  install of the caller's App, at its new version. Anything else is ignored and logged.
- `GET /armed?app=<slug>`: the armed state worked out now, why not, its binding, Keeper's version and a
  timestamp refreshed every minute.
- `GET /last`: Keeper's last line to you about the caller's App.

## Permissions

The Supervisor's backup role only (App and backup info, the jobs list `/jobs/info`, backups and
restores), plus reading its own info (`/addons/self/info`), never manager, and no write of any options.
No Home Assistant API, no ingress, no page, no `/share`. If on the device the Supervisor refuses the
jobs list to this role, Keeper says so in its log (a restore whose job can't be read is then judged from
the App's states, or ends as "unresolved"): that is a device check, and the role stays backup.

## Still to check on the device

None of this has run on the Pi yet. Owed there: the backup role reads `/jobs/info` and restores a
partial backup; a restore's answer carries its job id; the backup info shows `protected: false` for a
backup made without a password; the Ship run's options write through the connector keeps every other
option; Healthchecks accepts the `/log` pings; and the two drills (the next job).
