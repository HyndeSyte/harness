# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. It tells you without
going through Cain, through Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What installing it enables, and what it doesn't

- Keeper watches and logs. It restores only for an install registered with your signed Ship token
  (below), whose backup it made and verified before it accepted the install (that App alone, at the
  version being replaced, made without a password, after the token was issued), claimed by Cain's link as
  the Ship run started (0.1.5), and it sends one restore call per install, never a second (0.1.5, below).
- An unregistered version change is only logged and reported, never restored.
- It can't be armed until both drills have rolled back for real on the device and the phone test drill
  is confirmed (the next job), so "Ship it with that risk" stays refused until then.

## What Keeper proves, and what it can't (0.1.3)

What Keeper checks itself, before it accepts an install:

1. **The link's signature on your tap.** A registration carries your Ship token itself: the token Cain's
   link signed with its own Ed25519 key when you tapped Ship, bound to the repository, the pull request,
   its head commit and an expiry 2 hours after the tap (`cain/rootfs/opt/cain/ship-token.ts`). Keeper
   verifies that signature with the link's public key **as Keeper pinned it** (below) and refuses a
   registration whose signature doesn't verify, whose repository isn't this one, whose pull request or
   head aren't the token's, whose token has expired or lasts longer than a Ship token can, or (0.1.4)
   whose token was issued before Keeper's state was created (a fresh install, or a state restored or
   rewound, can't know which tokens were spent).
   The signature proves that the link signed the token, not that you tapped: the link signs only on your
   tap on its Ship card, but anything that held the link's private key could sign one too.
2. **Once per App.** Keeper keeps each spent token's id (a hash, never the token) with the App it
   registered, and refuses the same token for that App again (a replay). One tap that installs two Apps
   registers each once.
3. **The caller.** Only a request from Home Assistant's internal App network carrying Cain's own token
   (`tokens`, Cain's entry) can register; any other App's token is refused.
4. **The backup, before the install (0.1.4).** Keeper always makes the App-only backup itself (a
   registration naming a backup is refused), waits for it to complete, and accepts the install only once
   the backup holds that App alone at the version installed now, with no Home Assistant, no folders,
   `protected` false, dated after the token was issued, and the App still at that version. Only then does
   it answer the registration, with the backup's slug; the Ship run starts only after that answer.
5. **One install per acceptance, claimed at the install (0.1.4; 0.1.5).** An acceptance lasts 30 minutes
   and covers an install only once Cain's link has claimed it (`POST /attempt/<id>/claim`, below), at the
   moment the RemoteTrigger hook lets the Ship run start. The claim is bound to the attempt, the App, both
   versions and the backup's slug, made atomically (checked and set with nothing in between, so of two
   claimants exactly one gets it) and saved in Keeper's state before it is answered (a save that fails
   refuses the claim). It lasts 30 minutes. The acceptance is consumed the first time Keeper sees the new
   version within the claim (`consumed <id>: ... seen within claim <claim id>`). A version change seen
   before the acceptance, or outside a live claim (accepted but never claimed, the claim expired, or the
   attempt ended or was cancelled), is uncertain: "unprotected", paged, never restored. One seen after the
   acceptance was consumed (the same version installed again later) is an "unregistered change".
6. **The pinned key, enrolled by you (0.1.4; 0.1.5).** Keeper pins the first valid `ship_public_key` it
   sees into its own state, logs it with its fingerprint (the first 16 hex digits of the SHA-256 of the
   key's bytes) and pages you once: "Keeper pinned Cain's link's Ship key, fingerprint ...". 0.1.5: that
   first pin accepts **no** registration until you confirm it at the device, the same way as a new key:
   `bun /opt/keeper/main.ts key-confirm <fingerprint>` in Keeper's container (for example
   `docker exec addon_0fcc2575_keeper bun /opt/keeper/main.ts key-confirm <fingerprint>` from the SSH App).
   Check the fingerprint first against `cain/SHIP_KEY_FINGERPRINT` in the repository and the
   `Ship key fingerprint: ...` line in Cain's App log: all three must agree. A state that is lost (Keeper
   reinstalled) or rewound (restored, or stopped over 10 minutes) needs the confirm again. A different key
   in the options never replaces the pin, whatever else changes with it: every registration is refused,
   Keeper pages you once, and the new key counts only once you confirm it. If you didn't change the key,
   put the old one back instead. Every acceptance and claim answer reports the pinned fingerprint, when you
   confirmed it and when Keeper's state was created; Cain's link refuses the Ship run unless that
   fingerprint is the one committed at the pull request's head (`cain/SHIP_KEY_FINGERPRINT`, which must
   also be the link's own key's) and the state is no newer than the one it recorded at the last confirmed
   enrollment it saw (it records it when your confirm shows up in Keeper's answers).

What it can't prove:

- That you meant this particular install beyond what the token binds: the token names a pull request and
  a head, not the App versions. Keeper takes the versions from the registration (the link reads them from
  each App's `config.yaml` at the pull request's base and head) and checks only that the version being
  replaced is the one installed now. A to_version the App never shows ends as "install never started",
  with no restore.
- That you tapped: only that the link signed (above). Anything about the link's private key: whoever
  holds it can sign a token. It lives only in the link's own folder, which Cain's session can't read.
- That the key it pinned is the right one: that is why you confirm it at the device, against the
  fingerprint committed in the repository (0.1.5).
- That the install itself happened through the Ship run: Keeper sees only the App's version change.
- Cain's token (`keeper_token`) is a bearer token on the internal network: anyone with it can call
  Keeper's service, but can't register an install without a valid, unspent Ship token too.

Around it, in Cain's App: the RemoteTrigger hook refuses a Ship run without a valid token for exactly that
pull request and head (and every run while you have Stop on), and since Cain 0.19.0 it lets only one Ship
run through per token, and (with Keeper 0.1.4) only once Keeper has accepted every watched App the run
installs: the link records the token as spent before the run starts and refuses a second run on it.

## Registration, over Keeper's own service (0.1.3)

Nothing writes Keeper's options during a Ship. When Cain's hook asks the link to let a Ship run through,
Cain's link (on the same internal network, with Cain's `keeper_token`) sends Keeper `POST /attempt` for
each watched App the tap installs, and lets the run start only once Keeper has accepted every one:

`{token, app, pr, head, from_version, to_version, probe_hash, kind: "ship"}`

- `token` is your Ship token as the link signed it; Keeper verifies it (above) and never stores it.
- `from_version` and `to_version` are the App's version at the pull request's base and head; Keeper
  refuses the install as "unprotected" if the App isn't at `from_version` now.
- `probe_hash` is the first 16 hex digits of the SHA-256 of the App's verdict probe at the head (for Cain
  `cain/rootfs/opt/cain/probe/keeper.ts`): drills count only for the probe they ran with.
- Keeper makes the backup itself: a partial backup of that App alone, no Home Assistant, no folders, no
  password. A backup that fails, doesn't complete within 4 minutes, or was being made when Keeper restarted
  leaves the install "unprotected": logged loudly, paged to you, and the link reads a refusal, so it
  refuses the Ship run.

**Register, then poll (0.1.5).** A registration that passes the checks above is answered at once, 202
`{status: "pending", id}` (the id is `ship-<pr>-<app>-<first 8 of the head>`), and Keeper makes the backup in
the background. The link polls `GET /attempt/<id>` every 5 seconds until it reads `accepted` (with the
backup's slug and `until`, 30 minutes on) or a refusal, up to 5 minutes per App; the whole pass gives up
after 5 minutes per watched App registered plus 1 (6 minutes for Cain alone), and the link then cancels
every registration it made (`POST /attempt/<id>/cancel`: it ends at once, `<id>: ended (cancelled by Cain's
link ...)`, so no acceptance is left to use; its backup stays in Home Assistant's list, used for nothing).
No request is held open through the backup. With the acceptance Keeper logs `accepting <id> <app> <from> to
<to> backup <slug> until <time>`. The pass answers Cain's hook "pending" meanwhile, so the hook refuses the
run with a line telling Cain to start the same run again in a minute.

**The claim (0.1.5).** Once every watched App is accepted, at the hook's next ask, the link claims each
acceptance (`POST /attempt/<id>/claim` with the App, both versions and the backup's slug) and only then
answers the hook "ok", with each claim's id and deadline. Keeper logs `claimed <id> claim <claim id> <app>
<from> to <to> backup <slug> until <time>`, and the link logs `Ship pass ok: <id> claim <claim id> until
<time>` in Cain's App log. The Ship run reads both lines for its exact id before it installs and aborts if
either is missing or the claim's `until` has passed (RELEASING.md, Ship). An acceptance never claimed ends
after 30 minutes (`<id>: ended (its acceptance expired unclaimed)`), and a claim with no version change
seen ends after its 30 minutes (`<id>: ended (its claim <claim id> expired with no version change seen)`),
each with a notice to you that leaves no incident open. Why the link and not the Ship run: the Ship run is
a cloud session, and Keeper's service is only on Home Assistant's internal network, which the Home
Assistant connector can't reach.

A refusal is logged as `refusing a registration for <app>: <why>` and paged to you (an App Keeper doesn't
watch is only logged).

## What it does

1. **The watch, on local evidence only (0.1.3).** From the moment Keeper first sees the new version, for
   15 minutes, every 30 seconds, it reads the App's version and state from the Supervisor and asks its
   liveness address (the host of option `health`, path `/health`, 200 while the App runs). The install
   fails at once on: the App's state being error; the App not started on two polls in a row; liveness
   failing on three polls in a row (counted only once it answered 200 since the App's latest start, and
   after `health_grace_s` seconds from its first start); the App's own probe saying FAIL; the install
   deadline passing with the new version seen but never started. It passes only if, at the end of the 15
   minutes, the App's probe said PASS for this install, the App was started on every poll since it first
   started, and liveness answered 200 on the last three polls. So an App that never answers its liveness
   address within the window fails at the end.
   **Chat, reported only.** When `health` names another path (Cain's `/ready`, 200 only while his Discord
   connection is up), Keeper asks it too and reports it ("chat connected", or "chat not connected
   (degraded)") in its log and in the passed and rolled back lines. It never authorizes a restore and never
   fails a rollback: a Discord outage can't roll Cain back.
   **The degraded page (0.1.4).** When an install passes but chat was not connected on more than half of
   the watch's polls, Keeper pages you through the App's alert check (a page and its own all clear, no
   incident left open): "... passed Keeper's install check on liveness, but chat wasn't connected for most
   of it ... To go back, restore backup <slug> by hand". Nothing is rolled back by itself.
2. **The rollback.** On a fail Keeper pages you at once (a fail ping carrying the line: "Keeper is
   rolling back ...") and restores the registered backup with that App alone (Home Assistant false, no
   folders, the Supervisor's `background` flag passed explicitly as true), as one Supervisor job. It saves
   its fence (the call is in flight) before sending, and the job id from the answer before anything else.
   - **No resend, ever (0.1.5).** Keeper sends one restore call per install and never a second, whatever
     the answer: no answer from the Supervisor proves that a refused call had no effect, and the restore
     takes no idempotency key. A refusal (any 4xx, a missing backup and a refused permission included), a
     5xx, a timeout, an answer that isn't a result, or a restart while the call was out is "unresolved" at
     once: fenced, reconciled read only by its job id, paged.
   - **What a drill still records.** A drill's own restore job, by the job id its own restore call
     returned (never found by its name or reference), seen finished without errors, writes its name and
     reference as the Supervisor reported them into Keeper's state (`restoreJob`), and Keeper then reads
     that job by its id each poll until it leaves the jobs list, recording how long it stayed (`listedMs`,
     up to 2 days). Nothing in this version acts on either: they are evidence for a later version deciding
     whether a resend could ever be safe.
   - **Rolled back** only on the restore job, by the id its answer gave, seen finished without errors,
     followed within 5 minutes by the old version started and live. A job that ended with errors is
     "gave up" and never sent again (a failed restore may already have changed the App's data).
   - The App seen stopping and coming back at the old version without that job's result is
     "unresolved: the App came back at the old version but the restore job's result is unknown", said to
     you as such, never "rolled back".
   - After the job finished: "gave up" if the old version isn't started and live 5 minutes later, or it
     kept restarting (started, then stopped or error, more than twice in those 5 minutes).
3. **Unresolved, reconciled.** An unresolved install is fenced: nothing is restored again by itself,
   across restarts and however long it lasts. While Keeper runs, every poll checks the job by its id again,
   read only. When the job is seen finished without errors it goes to the 5 minute check and ends as
   "rolled back" or "gave up"; seen ended with errors it is "gave up". Either way one follow-up line reaches
   you. Check the App and Settings, System, Backups yourself meanwhile.
4. **A change nobody registered.** If a watched App's version changes with no install registered,
   Keeper never restores anything: it logs it and you hear it ("unregistered change").
5. If the install deadline passes without the registered version ever seen, nothing is restored and you
   hear "install never started".

Keeper keeps its state in its own `/data` (never in `/share`): the last version seen of each App, every
install with its deadlines, a heartbeat time written every minute, the times of the last heartbeat,
dead-man and log pings Healthchecks answered, its drill records and phone test, and the spent tokens' ids.
It keeps no copy of its tokens or Healthchecks URLs (0.1.3): options that drop one are taken as they are
(Keeper is then not armable until you put it back), never refilled from an old copy. After a restart it
picks up an open install where it was, and judges at once a deadline that passed while it was down.

Keeper doesn't watch its own install, and an update of Keeper should wait while an install is open
(it logs that if it is stopped meanwhile and resumes at its next start).

## What a rollback loses

The App's data written after the backup: a rollback restores the App's whole `/data` as it was in the
backup Keeper took at the registration. That covers two windows (0.1.5 says both):

- **Between the backup and the install**, up to a few minutes: the backup is made as the Ship pass
  starts, the Ship run starts once it is accepted and claimed, and the install itself comes after the run's
  own checks (normally a few minutes; the claim allows at most 30). Whatever the App wrote then (for Cain:
  cards, taps, records, his session's notes) is in no backup, and a rollback loses it.
- **Between the install and the rollback**: everything the new version wrote.

Home Assistant itself, `/share` and every other App are left alone.

## Keeper's own install and updates (0.1.5)

Keeper doesn't gate its own install or updates: an install or update of Keeper goes through the normal
Ship path (a pull request, CI, Dane's Ship tap), with a Home Assistant backup taken first, and no Keeper
registration (it refuses to watch itself). Wait until no install it watches is open or unresolved (its log
says so). A broken Keeper (it won't start, or refuses every registration) is repaired by break glass
(RELEASING.md): a fix pushed to `main` from Dane's PC and installed with a backup first. While Keeper is
absent or broken, Cain's link refuses every Ship run that installs a watched App (no acceptance), so a fix
to Cain itself then also goes by break glass.

## What you must set before it can arm

1. **`ship_public_key`**: the public half of Cain's link's Ship key, the base64 text after
   `Ship key (public):` in Cain's App log (it is public, so it is safe in the options). Without it every
   registration is refused. Keeper pins the first one it sees and (0.1.5) accepts nothing until you
   confirm it at the device with `key-confirm <fingerprint>`, after checking that fingerprint against
   `cain/SHIP_KEY_FINGERPRINT` in the repository and `Ship key fingerprint: ...` in Cain's log. If the
   link ever makes a new Ship key (its log says so), a Build commits its fingerprint to
   `cain/SHIP_KEY_FINGERPRINT`, you paste the new key here and confirm it the same way.
2. **`hc_api_key` (0.1.5)**: a Healthchecks API key for the project holding the checks below (Project
   Settings, API Access). Keeper reads every check's period, grace, status and notification channels with
   it, at most once a minute, through `https://healthchecks.io/api/v3/checks/` (healthchecks.io only).
   Without it Keeper is not armable, and says so. The read-only key is meant to be enough; if Keeper's log
   says the API doesn't show a check's channels, the read-only key hides them on your account and a
   read-write key is needed (it is kept like a password and never logged).
3. **Healthchecks.io checks**, each with your phone as the recipient (a notification channel assigned),
   and repeated reminders on. 0.1.5: Keeper refuses to arm unless the heartbeat check's period is at most 5
   minutes with a grace of at most 10, the dead-man check's period is exactly 1 minute with a grace of at
   most 5, every check has at least one channel and none is paused, and the heartbeat and dead-man checks
   aren't down. A change to any check's period, grace or channels after the phone test lapses it:
   - `hc_done`, the heartbeat: Keeper's poll pings it every 5 minutes, so a stuck Keeper alerts you.
   - `hc_deadman`, the dead-man check (0.1.3): a separate check Keeper pings every minute from its own
     process timer, apart from the poll, so its pings stop when Keeper's process or container dies, and
     that pages you. Use period 1 minute, grace 5 minutes. 0.1.4: the timer sends "keeper alive" only while
     Keeper's poll loop completed a round within the last 3 minutes; otherwise it sends the check's `/fail`
     ping ("Keeper's poll loop hasn't completed for N minutes: it isn't watching installs"), which pages you
     at once, so a Keeper that is alive but stuck isn't taken for one that is watching.
   - `hc_failed`, the alert checks: **one per watched App** (`slug=URL` entries). With one App watched a
     plain URL is that App's. With more than one App watched, two Apps on one alert check make Keeper not
     armable, with the plain line `<App> and <App> share one alert check; each watched App needs its own`.
     Every line about an App goes to its own alert check: a fail ping carrying the line when a rollback
     starts, and on "gave up", "unresolved", "unprotected", "unregistered change" and "install never
     started"; a success ping carrying the line once a rollback is confirmed, or "started and live again",
     so its next one alerts you again. If a shared check slips through anyway, a success ping waits while
     another App on the same check has an incident open, so one App's all clear never clears the other's.
     Every 5 minutes Keeper also sends each alert check a log ping (its ping URL plus `/log`), which
     Healthchecks records without changing the check's state or paging you. That shows only that
     Healthchecks accepts pings there, not that a page reaches your phone: the phone test does.
   Every check must be its own Healthchecks check (0.1.4): Keeper compares the check id in each ping URL's
   path (the uuid, or the slug in `https://hc-ping.com/<ping key>/<slug>`), not the whole URL, so two
   spellings of one check count as one, and `hc_done`, `hc_deadman` and each alert check must all differ.
   A URL whose path names no check (or ends in `/fail`, `/log`, `/start`) makes Keeper not armable.
4. **The tokens.** One random token per watched App (at least 16 characters, for example
   `openssl rand -hex 24`), in Keeper's `tokens` as `0fcc2575_cain=<token>`, and the same token in the
   Cain App's `keeper_token` option. Cain's token is also the one that registers installs.

## Arming

"Ship it with that risk" goes only while the rollback is armed for the App. `/armed` is worked out at
every read, never stored, and says armed only while all of these hold:

1. Keeper is armable: `hc_done`, `hc_deadman`, `hc_api_key` (0.1.5), and an alert check of its own for
   every watched App, each a distinct Healthchecks check;
2. both drill records of the App are valid under the current binding: two drills each rolled back by
   an actual restore of their backup (the restore job finished without errors), with their trigger and a
   delivered line to you, one where the App's probe said FAIL and one where the App exits on start;
3. the **phone test drill** is confirmed for the App's alert check and the dead-man check within the
   last 14 days (0.1.5), under the current Healthchecks options and checks' settings, with no page left
   unacknowledged for 10 minutes since (below);
4. a heartbeat ping and a dead-man ping were delivered (a 2xx answer) within the last 10 minutes, and
   Keeper's poll loop completed a round within the last 3 minutes;
5. each alert check's log ping was delivered within the last 10 minutes;
6. no fail ping has waited undelivered in the queue for more than 2 minutes;
7. (0.1.5) the checks' settings, read through `hc_api_key` within the last 3 minutes, are within the
   bounds above, each check with a channel and none paused.

**The phone test (a drill, 0.1.3; 0.1.4).** With no incident open, run in the Keeper App's container
`bun /opt/keeper/main.ts phone-test` (for example from the SSH App: `docker exec addon_0fcc2575_keeper bun
/opt/keeper/main.ts phone-test`). Keeper pages each watched App's alert check once ("Keeper phone test (a
drill) ..."), and (0.1.4) the dead-man check too, each followed by its all clear. Once the pages have
reached your phone, within an hour, run `bun /opt/keeper/main.ts phone-confirm` the same way. It shows that
a page from each check reaches your phone, at that moment. It doesn't show that Healthchecks will page you
when the dead-man check goes quiet (that needs Keeper stopped, the device check below). It lapses, and
arming closes, after 14 days (0.1.5), on any change of `hc_done`, `hc_deadman`, `hc_failed` or
`hc_api_key`, on any change of a check's period, grace or channels as the API shows them (putting the old
one back doesn't bring it back), and (0.1.5) when any page (a fail ping, the dead-man check's included) has
no acknowledgment from Healthchecks, a 2xx answer, within 10 minutes of being sent. Until that deadline
an undelivered page is retried, and it disarms after 2 minutes (6 above). The phone test reads the
checks' settings first and is refused while they refuse arming.

What the acknowledgment shows: that Healthchecks took the page, not that your phone rang. That a missed
heartbeat really reaches your phone is a device check (the next job's drill stops Keeper's pings and waits
for the page).

The binding is the verdict protocol, the App's probe (its hash), Keeper's version, Keeper's options and the
backup scope. The drill records are dropped when the binding changes, after 60 days, or when Keeper's
heartbeat stopped for more than 10 minutes before a start (a restore of Keeper or a long stop; the phone
test too, and Ship tokens issued before that start are then refused). A registration never drops them.
The restore job name a drill recorded is kept apart from them and isn't dropped.

A later item, not in this version: an independent verifier lease (a second watcher that must vouch for
Keeper before it counts as armed).

## Options

| Option | What it is |
| --- | --- |
| `watch` | The App slugs Keeper watches. Default `0fcc2575_cain`. |
| `health` | Each watched App's health address on the internal network, `slug=host:port/path`. Liveness is always that host's `/health`; another path (Cain's `/ready`, the default) is reported as chat connected or not. Default `0fcc2575_cain=0fcc2575-cain:8098/ready`. |
| `tokens` | Each App's own token, `slug=token` (see above). |
| `hc_done` | The heartbeat check's ping URL. |
| `hc_deadman` | The dead-man check's ping URL (0.1.3). |
| `hc_failed` | The alert checks: `slug=URL` entries, one per watched App (a plain URL is fine when one App is watched). |
| `health_grace_s` | Seconds after a watched App first starts before failed liveness polls count. Default 180. |
| `ship_public_key` | Cain's link's public Ship key, base64 (0.1.3). Pinned on first use; the first pin and every change need `key-confirm` (0.1.4; 0.1.5). |
| `hc_api_key` | A Healthchecks API key, to read each check's period, grace, status and channels (0.1.5). Needed to arm. |

Options are read again every 30 seconds, through the Supervisor: a change needs no restart (and drops the
drill records). Keeper never writes them. The `attempt` option of earlier versions is gone.

## Its service

On Home Assistant's internal App network only (port 8097, no host port), each call with the calling
App's token (`Authorization: Bearer <token>`):

- `POST /attempt` (Cain's token only): register an install (above); answered 202 at once (0.1.5).
- `GET /attempt/<id>` (Cain's token only, 0.1.5): where a registration stands: pending, accepted (with its
  backup), claimed (with its claim), refused or ended, with the pinned fingerprint, its confirmation and the
  state's creation time.
- `POST /attempt/<id>/claim` (Cain's token only, 0.1.5): `{app, from_version, to_version, backup}`; one
  claimant, valid 30 minutes.
- `POST /attempt/<id>/cancel` (Cain's token only, 0.1.5): ends a pending, accepted or claimed registration.
- `GET /attempt`: the open install of the caller's App, or none.
- `POST /verdict` `{app, version, attempt, result: PASS|FAIL, reason}`: accepted only for the open
  install of the caller's App, at its new version. Anything else is ignored and logged.
- `GET /armed?app=<slug>`: the armed state worked out now, why not, its binding, Keeper's version, a
  timestamp refreshed every minute, and (0.1.5) the enrollment.
- `GET /last`: Keeper's last line to you about the caller's App.

From inside Keeper's own container only: `drill-record`, `phone-test`, `phone-confirm` and (0.1.4)
`key-confirm <fingerprint>`.

## Permissions

The Supervisor's backup role only (App and backup info, the jobs list `/jobs/info`, App-only backups and
restores), plus reading its own info (`/addons/self/info`), never manager, and no write of any options.
No Home Assistant API, no ingress, no page, no `/share`.

## Still to check on the device

None of this has run on the Pi yet. Owed there: the backup role makes a partial backup (with
`background: false` its call answers once it is complete, within 4 minutes for Cain) and restores one; the
backup info shows `protected: false` and a `date`; a restore's answer carries its job id and the jobs list
shows the restore job long enough to read its result; the drill's record of its restore job's name and
how long it stayed listed (`restoreJob`, evidence only: 0.1.5 never resends); Healthchecks accepts
the `/log` pings; the dead-man check pages when Keeper is stopped and when its poll loop stalls; the phone
test reaches the phone from each check; the pinned key's first page; Cain's link reaches Keeper's `POST
/attempt` and polls it through the backup, then claims it; (0.1.5) the first pin's `key-confirm` against
`cain/SHIP_KEY_FINGERPRINT`; the Healthchecks API read with `hc_api_key` (whether the read-only key shows
each check's channels, and whether a read-only key's `unique_key` matches a uuid ping URL); a real missed
heartbeat paging the phone; the break-glass exercise with Keeper absent (a fix installed with no Keeper at
all); and the two drills (the next job).
