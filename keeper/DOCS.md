# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. It tells you without
going through Cain, through Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What installing it enables, and what it doesn't

- Keeper watches and logs. It restores only for an install registered with your signed Ship token
  (below), whose backup it made and verified before it accepted the install (that App alone, at the
  version being replaced, made without a password, after the token was issued), and at most one restore
  per install (0.1.4: a second only once a device drill has recorded the restore job's name, below).
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
5. **One install per acceptance (0.1.4).** The acceptance is consumed the first time Keeper sees the new
   version (`consumed <id>: ...` in its log). A version change to it before the acceptance (the backup not
   yet complete) leaves the install "unprotected", and one after the acceptance was consumed (the same
   version installed again later) is an "unregistered change": neither is ever covered by it.
6. **The pinned key (0.1.4).** Keeper pins the first valid `ship_public_key` it sees into its own state
   (trust on first use), logs it with its fingerprint (the first 16 hex digits of the SHA-256 of the key's
   bytes) and pages you once: "Keeper pinned Cain's link's Ship key, fingerprint ...". A different key in
   the options never replaces it, whatever else changes with it: every registration is refused with a
   plain line, Keeper logs and pages you once, and the new key counts only once you confirm it at the
   device, in Keeper's container: `bun /opt/keeper/main.ts key-confirm <fingerprint>` (for example
   `docker exec addon_0fcc2575_keeper bun /opt/keeper/main.ts key-confirm <fingerprint>` from the SSH
   App), where the fingerprint must be the new option's, as the page and the log name it. If you didn't
   change the key, put the old one back instead.

What it can't prove:

- That you meant this particular install beyond what the token binds: the token names a pull request and
  a head, not the App versions. Keeper takes the versions from the registration (the link reads them from
  each App's `config.yaml` at the pull request's base and head) and checks only that the version being
  replaced is the one installed now. A to_version the App never shows ends as "install never started",
  with no restore.
- That you tapped: only that the link signed (above). Anything about the link's private key: whoever
  holds it can sign a token. It lives only in the link's own folder, which Cain's session can't read.
- That the first key it pinned was the right one: check the fingerprint in the first page against the
  `Ship key (public): ...` line in Cain's log.
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
  password. 0.1.4: the answer waits for it. A backup that fails, doesn't complete within 4 minutes, or was
  being made when Keeper restarted leaves the install "unprotected": logged loudly, paged to you, and the
  answer is a refusal, so the link refuses the Ship run.

0.1.4: Keeper answers only once the backup is complete and verified: 200 `{status: "accepted", id, app,
from_version, to_version, backup, until}` (the id is `ship-<pr>-<app>-<first 8 of the head>`), or a refusal
with why. With the answer it logs `accepting <id> <app> <from> to <to> backup <slug> until <time>`. The link
waits up to 5 minutes for it (and 6 minutes for the whole pass) and answers Cain's hook "pending" meanwhile,
so the hook refuses the run with a line telling Cain to start the same run again in a minute; once every
watched App is accepted the pass answers "ok" once. The Ship run then reads the accepting line for its exact
id in Keeper's log before it installs, and aborts without it (RELEASING.md, Ship). The install deadline
(`until`) is an hour after the registration. Why the link and not the Ship run: the Ship run is a cloud
session, and Keeper's service is only on Home Assistant's internal network, which the Home Assistant
connector can't reach.

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
   - **No resend without the drill record (0.1.4).** Keeper doesn't know for sure what the Supervisor
     calls a partial restore job until it has seen one. So a 4xx answer is "unresolved" (fenced, reconciled
     read only, paged) until a drill on the device has recorded the real name: a drill's restore job, seen
     finished without errors with the drill's backup as its reference, writes its name into Keeper's state
     (`restoreJob`, none on a fresh install; logged as `drill <id> recorded the Supervisor's restore job
     name ...`). With that record, a 4xx may be sent again **once**: only when the jobs list then shows no
     job of exactly that name for the backup, and nothing restore-like it can't classify (a job with no
     name, or a name that says restore but isn't the recorded one, makes the list count as unreadable:
     nothing is sent, and it is "unresolved" at the 15 minute limit). A second 4xx is "unresolved". A
     missing backup or a refused permission (401, 403, 404) is "gave up": never sent again.
   - **Unresolved.** A 5xx, a timeout, an answer that isn't a result, a 4xx with no drill record, a 4xx
     whose jobs list shows a restore of that backup or can't be read or classified by the limit, or a
     restart while the call was out: "unresolved" at once (or at the limit), fenced, never sent again.
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
backup taken just before the install (at the registration, when the Ship run starts). For Cain that is
the minutes between the backup and the rollback (cards, taps and records written then). Home Assistant
itself, `/share` and every other App are left alone.

## What you must set before it can arm

1. **`ship_public_key`**: the public half of Cain's link's Ship key, the base64 text after
   `Ship key (public):` in Cain's App log (it is public, so it is safe in the options). Without it every
   registration is refused. Keeper pins the first one it sees (0.1.4, above): check the fingerprint it
   pages you. If the link ever makes a new Ship key (its log says so), paste the new one, then confirm it
   at the device with `key-confirm <fingerprint>`; until then every registration is refused.
2. **Healthchecks.io checks**, each with your phone as the recipient, period 5 minutes, grace 10
   minutes, and repeated reminders on:
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
3. **The tokens.** One random token per watched App (at least 16 characters, for example
   `openssl rand -hex 24`), in Keeper's `tokens` as `0fcc2575_cain=<token>`, and the same token in the
   Cain App's `keeper_token` option. Cain's token is also the one that registers installs.

## Arming

"Ship it with that risk" goes only while the rollback is armed for the App. `/armed` is worked out at
every read, never stored, and says armed only while all of these hold:

1. Keeper is armable: `hc_done`, `hc_deadman`, and an alert check of its own for every watched App, each
   a distinct Healthchecks check;
2. both drill records of the App are valid under the current binding: two drills each rolled back by
   an actual restore of their backup (the restore job finished without errors), with their trigger and a
   delivered line to you, one where the App's probe said FAIL and one where the App exits on start;
3. the **phone test drill** is confirmed for the App's alert check and the dead-man check within the
   last 30 days, under the current Healthchecks options, with no page undelivered since (below);
4. a heartbeat ping and a dead-man ping were delivered (a 2xx answer) within the last 10 minutes, and
   Keeper's poll loop completed a round within the last 3 minutes;
5. each alert check's log ping was delivered within the last 10 minutes;
6. no fail ping has waited undelivered in the queue for more than 2 minutes.

**The phone test (a drill, 0.1.3; 0.1.4).** With no incident open, run in the Keeper App's container
`bun /opt/keeper/main.ts phone-test` (for example from the SSH App: `docker exec addon_0fcc2575_keeper bun
/opt/keeper/main.ts phone-test`). Keeper pages each watched App's alert check once ("Keeper phone test (a
drill) ..."), and (0.1.4) the dead-man check too, each followed by its all clear. Once the pages have
reached your phone, within an hour, run `bun /opt/keeper/main.ts phone-confirm` the same way. It shows that
a page from each check reaches your phone, at that moment. It doesn't show that Healthchecks will page you
when the dead-man check goes quiet (that needs Keeper stopped, the device check below). It lapses, and
arming closes, after 30 days, on any change of `hc_done`, `hc_deadman` or `hc_failed` (putting the old one
back doesn't bring it back), and whenever any page (a fail ping) isn't delivered to Healthchecks.

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
| `ship_public_key` | Cain's link's public Ship key, base64 (0.1.3). Pinned on first use; a change needs `key-confirm` (0.1.4). |

Options are read again every 30 seconds, through the Supervisor: a change needs no restart (and drops the
drill records). Keeper never writes them. The `attempt` option of earlier versions is gone.

## Its service

On Home Assistant's internal App network only (port 8097, no host port), each call with the calling
App's token (`Authorization: Bearer <token>`):

- `POST /attempt` (Cain's token only): register an install (above); answered once its backup is complete
  and verified (up to about 4 minutes).
- `GET /attempt`: the open install of the caller's App, or none.
- `POST /verdict` `{app, version, attempt, result: PASS|FAIL, reason}`: accepted only for the open
  install of the caller's App, at its new version. Anything else is ignored and logged.
- `GET /armed?app=<slug>`: the armed state worked out now, why not, its binding, Keeper's version and a
  timestamp refreshed every minute.
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
shows the restore job long enough to read its result; **the drill that records the restore job's real name
and reference** (`restoreJob` in Keeper's state after the first drill rollback: until it exists, no
refused restore is ever sent again); a busy Supervisor answers a restore with a 4xx; Healthchecks accepts
the `/log` pings; the dead-man check pages when Keeper is stopped and when its poll loop stalls; the phone
test reaches the phone from each check; the pinned key's first page; Cain's link reaches Keeper's `POST
/attempt` and waits out the backup; and the two drills (the next job).
