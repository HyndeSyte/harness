# Keeper

Keeper checks every install of a watched App for 15 minutes, and if the install is bad it puts the
App back by itself, from the App-only backup taken just before the install. (0.1.9) It covers only the first 15
minutes after an install: a fault that shows later is yours to roll back by hand. It tells you without
going through Cain, through Healthchecks.io checks that reach your phone.

It watches Cain to start with (option `watch`).

## What installing it enables, and what it doesn't

- Keeper watches and logs. It restores only for an install registered with your signed Ship token
  (below), whose backup it made and verified before it accepted the install (that App alone, at the
  version being replaced, protected with a key only Keeper holds (0.1.12), after the token was issued), claimed by Cain's link as
  the Ship run started (0.1.5), and it sends one restore call per install, never a second (0.1.5, below).
- An unregistered version change is only logged and reported, never restored.
- It can't be armed until both drills have rolled back for real on the device, the phone test drill is
  confirmed and (0.1.6) the missed-heartbeat drill is confirmed (the next job), and (0.1.7) you have entered
  its Healthchecks read-only key (`hc-key`) and accepted its accepted limits (`accept-limits`, three since 0.1.12), so "Ship it
  with that risk" stays refused until then.

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
   `bun /opt/keeper/main.ts key-confirm <fingerprint> <code>` in Keeper's container (for example
   `docker exec "$(docker ps --format '{{.Names}}' | grep 0fcc2575_keeper)" bun /opt/keeper/main.ts key-confirm <fingerprint> <code>` from the SSH
   App; the container is `app_0fcc2575_keeper` on the device (0.1.17: seen there; `addon_0fcc2575_keeper` only on an
   older Home Assistant, before its rename), so the command finds its name at run time with `docker ps --format
   '{{.Names}}' | grep 0fcc2575_keeper`, and the SSH user is `hassio`, who runs it with `sudo`). 0.1.6: `<code>` is the one-time code Keeper printed in its log at the pin (`one-time code for
   key-confirm: ...`, below).
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
7. **The enrollment record (0.1.6).** The link keeps the last confirmed enrollment it saw (the fingerprint,
   Keeper's state creation time and your confirm time) in root's `/data/trust/keeper-enrollment.json`, which
   Cain's session can't write. It records it from its minute-by-minute `/armed` read of Keeper as well as from
   a Ship pass, so your confirm is recorded even before the next Ship. A Ship pass then needs Keeper's state
   creation time and confirm time to **equal** the recorded ones: a newer state is refused, and so is an
   older one (a restored Keeper state), and a different state counts only once you confirm the key at the
   device again.
8. **The enrollment id and counter (0.1.7).** Each `key-confirm` gets an enrollment id of its own, and
   Keeper's state carries a counter that goes up at every state write and every `/armed` read and never goes
   down. Both are in every acceptance, claim and `/armed` answer. The link records the counter with the
   enrollment and refuses any lower value (an older Keeper state, from a backup, can't pass for the current
   one), and it keeps the enrollment ids it has seen: an earlier confirmation played back is refused. The way
   back after a restore of Keeper or a clock correction is explicit: run `key-confirm <fingerprint> <code>`
   again with a fresh code (0.1.8: printed at start only while the key isn't enrolled or after the link refused the
   enrollment, otherwise from `key-code`). That is a new enrollment (a new id), which the link records in place of
   the old one, at the counter it carries however far below the old record, whatever the clocks say (0.1.8; "The
   claim record" below).

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

**The claim (0.1.5; its deadline, 0.1.6).** Once every watched App is accepted, at the hook's next ask, the link claims each
acceptance (`POST /attempt/<id>/claim` with the App, both versions and the backup's slug) and only then
answers the hook "ok", with each claim's id and deadline. Keeper logs `claimed <id> claim <claim id> <app>
<from> to <to> backup <slug> until <time>`, and the link logs `Ship pass ok: <id> claim <claim id> until
<time>` in Cain's App log. The Ship run reads both lines for its exact id before it installs and aborts if
either is missing or the claim's `until` has passed (RELEASING.md, Ship). An acceptance never claimed ends
after 30 minutes (`<id>: ended (its acceptance expired unclaimed)`), and a claim with no version change
seen ends after its 30 minutes (`<id>: ended (its claim <claim id> expired with no version change seen)`),
each with a notice to you that leaves no incident open.

The deadline in code (0.1.6). The Ship run is a cloud session that reaches GitHub and Home Assistant only,
never Keeper or the link, so the gates in code are Cain's hook at the run's start and Keeper's own fence:

- the claim lasts 30 minutes from the claim; the link refuses (and cancels) a claim answered with under 20
  minutes left, and the hook checks every claim's deadline again in code immediately before it lets the run
  start: under 20 minutes left, or a deadline it can't read, refuses the run and asks the link to cancel the
  pass and its claims (`POST /ship-pass {token, cancel}`); a new Ship card for the same pull request and head
  starts again (the same tap can't: Keeper spends a Ship token once per App);
- Keeper treats a version change seen outside a live claim as uncertain, and (0.1.6) so is one seen during a
  live claim to a version other than the claimed one: "unprotected", paged, never restored;
- the deadline bounds the start, not the watch: an install whose new version Keeper first sees inside the
  claim is watched its full 15 minutes, and rolled back on a fail, even after the claim's deadline passed;
- the Ship run's own reading of both log lines and the time (RELEASING.md, Ship 4a) stays as belt and braces.

What these gates leave open, a same-version install made another way inside a live claim, is the first of the
accepted limits (below).

**The claim record (0.1.7).** Claim, cancel and consume (Keeper seeing the new version within the claim) are
three operations on one record, the attempt, and run one at a time under Keeper's own lock, in the order they
came, together with each poll's version check and expiries. Each is idempotent: the link sends a request id
with its claim, and a retry with the same id reads the recorded claim (the same claim id and deadline, or why
the attempt ended since) and changes nothing; a cancel already recorded answers its recorded outcome again
(`a retry of the cancel of <id>: the recorded outcome (ended)`). A cancel is refused once the claim was handed
to a started run, that is once Keeper saw the new version (`its claim was handed to a started run ...`): the
install is then watched, and rolled back on a fail, as any other. (0.1.8) The cancel also reads the Supervisor's
jobs list under the lock; (0.1.9) it no longer refuses for what it shows, it ends the claim and keeps the backup;
see "The claim record: the cancel, the lock, the counter and re-enrollment" below.

**A lost cancel, a cancel and an unused expiry (0.1.7; 0.1.9).** If the link's cancel never reaches Keeper, the
claim simply runs out: it ends unused (`<id>: ended (its claim <claim id> expired with no version change seen
(unused))`, with the claim's own end line `claim <claim id> of <id> ended (...); its deadline was <time>`). Since
0.1.9 neither a cancel nor an unused expiry ever deletes the backup: the Supervisor may be starting an install at
that very moment, and that backup would be its only way back. The claim ends, and the backup is kept, bound to the
attempt and its generation, with the line `<id>: ended; backup kept: <reason> (backup <slug> "<its name>",
generation <n>; only the bounded cleanup may delete it)`. The cancel still reads the Supervisor's jobs list, but
only to say why in that line (an install running, a job Keeper doesn't recognize, a list it couldn't read); it is
no longer refused for it.

**Kept backups and the bounded cleanup (0.1.9).** Keeper records the slug of the backup it made on each attempt
(as soon as the backup call answers, even if the registration was cancelled meanwhile), and before the call its
own name, `Keeper <attempt id> <8 hex digits>`, and the attempt's generation (a counter in its state that never
goes down). A kept backup is deleted only by the cleanup, and the cleanup touches only Keeper's own: a backup whose
name is the one Keeper gave and which has a generation record in Keeper's state, never your backups, never a
drill's, never a Keeper-named backup it has no record of (that one is named in the log once at start, for you to
delete by hand if you like). It runs only at Keeper's start, before a new backup, and on a daily tick, always
under the claim record's lock; never while any other attempt is open (a live or expiring claim); only when the
Supervisor's jobs list shows no install job on a watched App (a list it can't read stops it); never within 2
hours of a claim's end. It deletes a kept backup 48 hours after its claim ended (so at most 48 hours plus one
daily tick), and the oldest past the 2-hour grace while more than two are kept. Right before each delete it reads
the attempt and its generation again. Every deletion is logged (`the cleanup deleted kept backup <slug> ("<name>")
of <id>, generation <n>, <hours> hours after its claim ended (...)`), and so is every run that didn't happen and
why (`the cleanup of kept backups (<when>) didn't run: ...`). If a restart lost a slug, the backup is found in the
backups list by its exact own name and bound then.

**The cleanup's grace and eligibility (0.1.10).** The grace is 2 hours 30 minutes, strictly longer than a Ship
token's 2 hours plus the hook's bound (10 minutes), so no backup a still-valid token's run could reach is deleted.
The limits hold only while cleanup is eligible: the 48 hours and the two-backup cap are applied only when no other
attempt is open and the jobs list shows no install job; while it is blocked, kept backups past a limit stay, and
the log says so (`the cleanup is blocked past its limits (...): those backups stay until cleanup is eligible
again`). The grace is a floor the cap never overrides: a third backup inside it is kept and logged (`... over the
two-backup cap, but ... inside the 2 hours 30 minutes grace: kept`). The 48 hours count from the attempt's recorded
end (its claim's logged end); a claim's deadline alone never counts as one (`... stays past its limit: its attempt
has no recorded end`). Right before each delete the jobs list is read again, with the attempt and its generation.

**A backup create that outran its bound (0.1.10).** A backup whose create didn't answer within its bound, or whose
answer a restart lost, may complete later. Its name was chosen and saved before the call, so under the next holder
of the claim record's lock Keeper looks it up by that name in the backups list: found with its attempt's
generation, it is adopted (`... completed later: found by its name ... adopted with its generation <n>`) and left
to the bounded cleanup; found with no generation record, it is deleted, logged. **A route whose write is still in
flight** when its step runs out answers `202 {"status": "pending"}` at once, the lock stays held until that write's
outcome is known, and the same request sent again meanwhile answers pending without starting it twice; once the
write ended, it runs again and reads the recorded outcome.

**Late backups are retention-only, and a pending write has a ceiling (0.1.11).** A backup adopted late (its create
outran its bound) is kept for retention only: a consume never takes it as the attempt's backup and a restore never
runs from it, unless the Supervisor's recorded completion time for that backup precedes the install job's start time,
both read from the Supervisor. The Supervisor's jobs list gives no completion time for a backup today, so in practice
a late backup is never restorable. An install whose only backup is retention-only is "unprotected": logged and paged
once, not covered. So is an install the watch can't match to its own attempt and generation, or whose attempt has no
usable backup (none, or one deleted): one page, never only a log line. A write in flight under the claim record's
lock holds it at most 3 minutes: then the write is marked late (reconciled later by its pre-chosen name or slug, as
late backups are), the lock is released and you are paged once, so later claims, cancels and attestations are never
stuck behind it. (0.1.16) The 3 minutes bound the lock itself, counted from the moment the step took it (before, the
step's own 30 seconds came first, so the lock could be held about three and a half minutes): one timer started with the
step releases the lock then whatever the step or its write is doing, marks the step late and logs it (`... the lock's
bound ... the lock is released`), and a failing save or page at that moment doesn't keep the release from happening.
(0.1.16, the fix round) The release comes first, synchronously, before anything else; the late record's save and your
page follow, each bounded, and a failure of either is logged. Each time a step takes the lock it gets its own token, and
a release is a no-op unless that token still holds the lock, so a step finishing in the same moment its bound fires lets
go exactly once, and a step that lost the lock can never write over the next one's state: a write of its that answers
late is never recorded by it, it queues a reconcile under the lock instead. If the late record can't be saved, Keeper
keeps it in memory: the same request is refused (it reports late, and nothing reaches the Supervisor) while it stands,
and the save is tried again at the next step. An operation's record only moves one way (pending to done or late, late
only to reconciled), each write of it compared on its generation and id. While any operation is late, Keeper holds every
Supervisor write: claims, cancels, restores, backups and backup deletes (reads and status go on), until a reconcile under
the lock (at the next poll) reads the Supervisor's jobs list with no backup job running, and, for a backup delete, the
backups list for whether it took effect. The writes that run under the lock are only two, a kept backup's delete and a
late backup's delete, each bounded by 10 seconds (and the Supervisor call's own 15): the step's 30 seconds plus one of
them is well under the 3 minutes, checked in a test. The backup create (up to 15 minutes), the restore (tracked by its
Supervisor job id) and the backup check's backup and its delete run outside the lock. The pending answer (`202 {"status": "pending", "operation": "op-...", "recorded": ...}`) carries a
stable operation id, and the same request again reports that recorded outcome (pending or late) without repeating
the write.

**The free-space reserve (0.1.9).** Before every new backup Keeper reads the free space where backups go
(`/host/info`) and needs the projected backup (the last backup's size and a half) plus a 1 GB reserve. (0.1.10) For
a first backup, with no last size, the floor is 1 GB plus the App's image size when Keeper knows it, else 2 GB.
The refusal carries the code `no_space`: Cain's link then refuses the install and posts you one card saying so, with
no button (0.1.11: the one-day override that installed without Keeper's rollback is gone); you clear space or choose
another path. A backup that can't fit is refused: the registration is "unprotected", logged (`refused a new
backup for <id>: ...`, naming the kept backups the cleanup couldn't free yet) and paged. A free space it can't read
refuses too. Delete old backups in Home Assistant (Settings, System, Backups) to make room.

**A Ship install's own backup (0.1.9).** Each registration begins under the claim record's lock: the cleanup, the
reserve, then the attempt's own generation and backup name, saved before the backup call. Its acceptance commits
under the lock too, bound to the slug its own call returned. So an older kept backup is never that install's
rollback.

Why the link and not the Ship run: the Ship run is
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

## Keeper's backups are protected (0.1.12)

Every backup Keeper makes of a watched App (Cain) is protected (encrypted) with a password only Keeper holds, as
every other backup on the device is. The backup holds the App's `addon.json` (its options, which hold its tokens and
keys) and its data folder, so an unprotected one would keep them in clear on the device's disk for as long as it is
kept, where any App or sync that reads the backup folder could copy it. Keeper makes a new password for each backup
(32 random bytes), keeps it root-only (0600) in `/data/backup-keys/<the backup's name>`, written whole through a
temporary file with the fixed prefix `tmp-` in that folder, and never puts it in its options, its state or its log.
It accepts the backup only when the Supervisor shows it as protected (`protected: true`), and its restore sends the
same password. A backup whose key file is missing or unreadable is unusable, exactly like a missing backup: the install
is "unprotected", paged once and never restored. When the cleanup deletes a backup it deletes its key file too, and at
every start Keeper removes, and logs, a key file whose backup is gone (`removed the key file of backup "<name>" ...`);
a key file is never deleted while its backup is kept. `backup_exclude` leaves `/data/backup-keys` and everything in
it out of Keeper's own backups, and the backup check proves it on the device.

What this means for you:
- Home Assistant's backup page shows Keeper's backups as protected, and you can't open or restore them by hand: their
  key is Keeper's alone. Home Assistant's own pre-install backup, protected with your key, stays your way back by hand.
- If Keeper's data is lost (a reinstall of Keeper, or a restore of Keeper, since its backups leave the keys out),
  Keeper can't restore from the backups it kept: each is then unusable, and an install it covered is "unprotected".
- Keeper's own backup check test backup stays unprotected, since the check must read it: it holds Keeper's own
  options in clear on the device's disk until it is deleted, right after the check and again at every start if the
  check was interrupted.

## What a rollback loses

The App's data written after the backup: a rollback restores the App's whole `/data` as it was in the
backup Keeper took at the registration. That covers two windows (0.1.5 says both):

- **Between the backup and the install**, up to a few minutes: the backup is made as the Ship pass
  starts, the Ship run starts once it is accepted and claimed, and the install itself comes after the run's
  own checks (normally a few minutes; the claim allows at most 30). Whatever the App wrote then (for Cain:
  cards, taps, records, his session's notes) is in no backup, and a rollback loses it.
- **Between the install and the rollback**: everything the new version wrote.

Home Assistant itself, `/share` and every other App are left alone.

## Cain backed up first (0.1.19)

Cain's backup is cold: making it stops and starts Cain, and his link with him. Before 0.1.19 Keeper made it
when Cain's install was registered, and the restarted link cancelled that very registration, so every install
of Cain failed (Nov 27). Now the backup comes first, and nothing is carried across that restart:

- At Dane's Ship tap for a change that installs Cain, once it is in main, Cain's link records only the tap (its
  own file, left out of Cain's backups) and asks Keeper for the backup: `POST /backup-first {app, pr, head}`,
  Cain's token, Cain's own App only. Keeper answers 202 and makes the backup in the background, under the name
  the attempt for that pull request and head will have, and checks it as a registration's backup is checked
  (Cain alone, at the version running now, protected with Keeper's own key). `GET /backup-first?app=<slug>` says
  where it stands: none, making, ready or failed. It is refused during a drill, beside an open attempt or an
  install job with no recorded end, while an operation is late, and before the Ship key is confirmed.
- After the restart the link gives the Ship token for that tap once, as for any App, and the Ship run's pass
  registers the install as usual (`POST /attempt`).
- Keeper accepts Cain's registration against that backup, used once and removed whatever happens, only when it
  was made for the same pull request and head, at the version the install replaces, and its own snapshot time
  (the backup's date as the Supervisor gives it, never the time it was asked for) is within 15 minutes before the
  registration, after every restore Keeper sent for Cain and after Keeper's state was created. Then it makes no
  second backup. Otherwise it logs why, keeps the unused backup for the bounded cleanup, and takes a backup as for
  any install: for Cain that restarts him again, so the install needs a new Ship tap.
- A drill makes its own backup at its registration, as before. Every other App's install is unchanged.

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
2. **The Healthchecks read-only key, entered once with `hc-key` (0.1.7; it was the `hc_api_key` option in
   0.1.5 and 0.1.6).** The **read-only** API key of the Healthchecks project holding the checks below (Project
   Settings, API Access, the read-only key). It is no longer an option: Keeper's options can be read by
   anything with Supervisor option access, and a backup of the App carries them. Set the checks (3) first, then
   in Keeper's container run `bun /opt/keeper/main.ts hc-key <code>` with the key on standard input, never on
   the command line (for example `docker exec -i "$(docker ps --format '{{.Names}}' | grep 0fcc2575_keeper)" bun /opt/keeper/main.ts hc-key <code>`,
   paste the key, then Enter and Ctrl-D). `<code>` is the one-time code Keeper prints in its log at every start
   (`one-time code for hc-key: ...`); the command prints nothing of the key. Before it keeps the key, Keeper
   checks that it is read-only (an answer showing any ping URL comes from a key that can write, and is refused
   at entry with the plain line `that key can write (its answer shows ping URLs): enter the project's read-only
   API key`) and that it sees every check the options name (`that key doesn't see <check>` otherwise). A
   refused key is never kept, and a new code is printed. The key is kept root-only (0600) in Keeper's data
   folder (`/data/hc-key`), never in its options and never in its log. (0.1.8) The file is 0600 from its first
   byte: Keeper writes the key into an exclusive temporary file it creates with mode 0600 in the data folder,
   fsyncs it, then renames it into place; it never writes a file and changes its mode after. (0.1.9) That
   temporary file's name has a fixed prefix, `hc-key.tmp-`, which the backup exclusion covers, so a crash between
   the write and the rename leaves no key outside it; at every start Keeper removes and logs any leftover, the
   earlier builds' temporary names (`hc-key.<pid>.<hex>.tmp`) included (`removed a leftover key file ...`).
   (0.1.9) `hc-key` is refused until the backup check (below) has passed on the device.
   **Backups leave it out.** Keeper's `config.yaml` lists the file under `backup_exclude`, so the Supervisor
   leaves it out of any backup it makes of the Keeper App (a device check confirms it). After a restore of
   Keeper the key is missing: Keeper says so at start and isn't armable until you enter it again. Keeper's own
   backups are of the watched Apps (Cain), never of Keeper, so they never held it.
   **The old option.** While `hc_api_key` is still in Keeper's options, Keeper logs at every start `the old
   option hc_api_key is still in Keeper's options: remove it ...` and never uses it. (0.1.8) Keeper checks the
   options as the Supervisor holds them at each poll, and while the option is there it doesn't arm and refuses the
   `hc-key` entry, both with the line `the old option hc_api_key is still in Keeper's options: remove it, then
   rotate that key in the alert service`. Remove it (the App's Configuration page, Edit in YAML), then rotate that
   key in Healthchecks (Project Settings, API Access: revoke it and make a new one), since earlier backups may hold
   it: a backup of the Keeper App made while it was an option carries it. Enter the new read-only key with `hc-key`.
   Keeper reads every check's period, grace, status and notification channels with the key, at most once a
   minute, through `https://healthchecks.io/api/v3/checks/` (healthchecks.io only). Without a kept key Keeper
   is not armable, and says so. Keeper accepts a read-only key only: a read-write key can pause checks, change
   their period and grace, and delete or reroute their channels. A kept key that later shows ping URLs is
   refused for arming, logged (`REFUSING the kept Healthchecks key: it can write ...`) and paged once. Never
   upgrade the key to make arming work.
   **Hand-confirmed channels.** If the read-only key hides a check's channels, Keeper doesn't refuse for that
   (its log says which checks are hidden): you confirm the checks yourself, by the pages reaching your phone.
   The phone test confirms the alert checks and the dead-man check, and the missed-heartbeat drill confirms
   the heartbeat check; arming takes those records in place of the API's channel list. A check found by its
   slug must be the only check with that slug the key can read (two refuse arming: give each its own slug, or
   use its uuid ping URL).
   **When the derived match is wrong (0.1.7).** Keeper finds each check by the id in its ping URL (a uuid's
   unique key, or the slug). If that doesn't find the right check, set its unique key yourself in option
   `hc_unique_keys`, one `role=<unique key>` entry per check, the role `done`, `deadman` or the App's slug
   (`0fcc2575_cain`), the unique key as the read-only API shows it (40 hex digits). That entry then decides
   alone. Which check each role maps to on the live account is a device check.
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
5. **The accepted limits (0.1.7; text version 7 since 0.1.15).** Read "Accepted limits" below, then run `bun
   /opt/keeper/main.ts accept-limits <code>` in Keeper's container, with the one-time code Keeper prints at each
   start while they aren't accepted for the current text (`one-time code for accept-limits: ...`). Arming needs it.
   An acceptance of version 1 (0.1.7) lapsed with 0.1.8: accept again.

**The checks before arming, refusals in code (0.1.9).** What 0.1.8 listed as device checks are now refusals:
Keeper doesn't take `hc-key`, or doesn't arm, until each holds.
- **The backup check.** Run `bun /opt/keeper/main.ts backup-check` in Keeper's container. Keeper writes a sentinel
  into every key file name it uses or used (the key file `hc-key` when none is kept yet, the old key's file
  `hc-key-old`, a temporary file with the current prefix `hc-key.tmp-`, and one with the legacy temporary name
  `hc-key.<pid>.<hex>.tmp` from 0.1.7 and 0.1.8), makes a test backup of the Keeper App, downloads it and reads every
  file in it: the backup must leave out every one of those names, and no file in it may hold a sentinel, a kept key's
  value or a key's fingerprint. Then it removes the sentinels and deletes the test backup. `hc-key` and arming are
  refused until it passes (`the backup check hasn't passed on the device ...`).
  (0.1.10) It fails closed. Before the test backup it reads every sentinel back where it was meant to go, each inside
  the exclusion; a file holding a kept key (the current key, or the old key) is never written over: its value and
  fingerprint are searched for instead. It places a positive control in `backup-check-control`, a file the exclusion
  doesn't cover. It records the test backup's name before making it. After the download the archive's size must
  match the Supervisor's (in bytes where given, else its MB figure), every entry and nested archive is read (tar and
  gzip; a zstd, xz or other member, an archive-named member that is neither gzip nor tar, an encrypted backup, a tar
  header whose checksum doesn't match and a truncated file all fail it), and the control must be found exactly once.
  (0.1.12) It also writes a sentinel into the backup key store, `/data/backup-keys/backup-check-sentinel`, and into a
  name there with its temporary prefix (`/data/backup-keys/tmp-<hex>`); both must be absent from the test backup like
  the `hc-key` names, and no name under `backup-keys` may appear in it. The exclusion changed in 0.1.12, so an earlier
  pass no longer counts: run the backup check again.
  (0.1.16) The scan reaches every byte of the archive. Each layer is searched whole as well as member by member, so a
  key value, a fingerprint or a sentinel is found in the gzip header's name and comment, in any tar header field (a
  link's target, the owner and group names, pax records, global ones included), in the padding after a member, and
  after the end-of-archive block. Anything but zeros after a gzip stream or after a tar's end-of-archive block fails
  the check, since nothing would read it as a member, and an old tar header with no `ustar` magic (its checksum right)
  is read as a tar. It also writes a sentinel into the drill flags' spent list
  (`/data/drill-spent/backup-check-sentinel`, a name that is never a nonce), and no name under `drill-spent` may appear
  in the test backup. A pass is tied to this scan too (scan 2): a pass from before 0.1.16 no longer counts, so run the
  backup check again. (0.1.16, the fix round) The scan finds the gzip stream's end itself: it parses the gzip header
  (its flags, extra field, name, comment and header CRC), inflates the stream with the inflater's count of bytes read,
  confirms that count, and checks the 8-byte trailer (CRC32 and length) against what it decoded; a trailer that doesn't
  match, a second gzip member, or anything but zeros after the trailer fails the check. The positive control is counted
  only inside files: a copy anywhere else in a layer (a header field, the padding, the tail, the gzip header) fails it. A
  layer read as a tar (ustar, or an old v7 header with a valid checksum) must parse to its end-of-archive block, and a
  layer whose magic says gzip must decode: neither is ever read as a plain file. zstd, xz, bzip2 and encrypted members
  still fail. Every value searched for is at least 16 bytes: the 8 and 12 hex digit ids are left out (they could match
  random bytes by chance) and each key's 16 digit fingerprint stands for them. Every failure names the layer, the byte
  offset and what matched (the sentinel, a key value, a key's fingerprint).
  (0.1.17) The scan streams, in bounded memory. On the device the 0.1.16 scan of a 100 MB test backup held the whole
  archive and each inflated layer several times over, and the kernel's out-of-memory killer stopped Keeper's service.
  Now the downloaded archive is written to a file and read from it by offsets, a chunk at a time; each gzip member is
  inflated once, through a streaming inflater, into a streaming tar reader, its CRC32 and length computed as it streams
  and checked against its trailer (the inflater's own end of the stream, with that trailer check, takes the place of
  0.1.16's two confirming re-inflations); every value is searched for across chunk boundaries, so one split between two
  chunks is still found; and a tar layer's own bytes (headers, records, padding, the tail) are searched by offset
  ranges as it streams. A hard budget fails the check, naming itself: 4 GB decoded in all (the expanded-bytes budget),
  6 layers of nesting (the nesting budget), and 1 MB for any record Keeper must hold to read (the record budget).
  Nothing it looks for changed. The scan runs in a child process of Keeper's service, with a memory limit of its own
  (384 MB resident, and Bun's smaller heap): if it is killed, the service lives on, counts the check failed, removes
  the sentinels, deletes the test backup and says so, with the archive's size ("the scan was killed (out of memory)
  ..."). A pass is tied to this scan (scan 3): a pass from before 0.1.17 no longer counts, so run the backup check again.
  (0.1.18) The App's own image. A backup of Keeper holds its container image (`./image.tar` inside the App's archive), the
  image as built from Keeper's public source before any key exists; nothing the container writes reaches it. Base images
  ship files Keeper can't open (Debian's apt logs are xz-compressed), and on the device 0.1.17 failed the check on the
  first one. Inside the image only, such a file (a format Keeper can't open, a name that says archive over other bytes,
  or a layer past the nesting budget) is searched as raw bytes and counted; the log says how many ("left N files in the
  App's own image unopened"). Everywhere else nothing changed: Keeper's data, its options and the outer archive still
  fail closed. A pass is tied to scan 4: run the backup check again after installing 0.1.18. On the device a full
  Keeper backup (104 MB) read 5,108 files in 3 seconds, peak 62 MB, with 4 image files left unopened.
  (0.1.17, the review's fix round) The gzip member's end is the inflater's own end-of-stream signal, with its count of
  bytes read taken at that moment for the trailer, so a stream that ends exactly on the last byte of a piece, a trailer
  split across pieces and the bytes after the stream are all read exactly (the trailer's CRC32 and length, and nothing
  but zeros after it, are still checked). A tar layer searches its whole byte stream, the files' data included, so a value
  split between a header (or padding) and a file's data is found; a value wholly inside a file is reported once, by the
  file. The inflater is fed 4 KB at a time and paused after each 64 KB it puts out until the layers below have taken it,
  so an all-zero image (deflate expands up to about 1000 to 1) never builds up in memory: 2 GB of zeros scans in about
  55 MB. The scan's memory is checked for every chunk it unpacks as well as every 20 ms, and it asks the kernel's
  out-of-memory killer to pick it before Keeper's service (oom_score_adj 1000). The service reads the scan's output and
  errors as they come, so a scan that writes too much or dies early never leaves the check waiting; it exits on its own
  if the service goes. The whole check has one deadline of 8 minutes (making, downloading and scanning the test backup);
  past it the check fails and names the phase it was in. One backup check runs at a time: a second one is answered at
  once, "a backup check is already running". Every budget's failure names the phase, the limit, what it saw and what to
  do, and every check logs the test backup's size ("backup check: test backup <slug> downloaded, <bytes> bytes").

  **What `backup-check` says (0.1.17).** It waits at most 10 minutes and says what happened in plain words. At the start:
  "backup check running: Keeper makes a test backup of itself, downloads it and scans it in a separate process; this
  can take several minutes (at most 10)", then each minute "backup check still running (<n> min): the scan is reading
  the test backup". Then one of:
  - "the backup check passed: a test backup of Keeper leaves out every key file and holds no key";
  - "not done: <why>", Keeper's own reason, for example "not done: the scan was killed (out of memory): it passed its
    own limit of 384.0 MB reading the <bytes>-byte (<MB> MB) test backup (the scan's memory limit, in the scan phase:
    limit ..., seen ...; what to do: ...)", or "the scan was killed (signal 9) reading ...: likely out of memory, its
    last memory sample ... near its limit" when the kernel killed it near its limit (without "likely out of memory", and
    saying so, when its last sample was far from it: the system, a supervisor stop or a manual kill), or "the scan took
    longer than ... and was stopped (a timeout, not a crash)", or "the backup check ran past its deadline of 8 minutes
    while downloading the test backup" (or making, or scanning);
  - "not done: a backup check is already running; wait for it (Keeper's log says when it ends), then run backup-check
    again if you need to";
  - "not done: the keeper's service isn't answering on its loopback port (127.0.0.1:8096): is Keeper started? Nothing
    was checked";
  - "not done: the keeper's service stopped answering while the backup check ran (it was likely restarted while
    scanning). Its restart counts the check failed, removes the sentinels and deletes the test backup; read Keeper's
    log, then run backup-check again";
  - "not done: no answer within 10 minutes; the backup check may still be running. Read Keeper's log for "backup check
    passed" or "backup check FAILED"; if the service restarts, that counts the check failed and deletes the test
    backup";
  - "not done: the request to Keeper's service failed (<code>); whether the check ran is unknown: read Keeper's log for
    "backup check passed" or "backup check FAILED"", for any other failure, naming its raw code. (Fix round: the cause
    is read from the error's code, never its message.)
  Any read, format, size or traversal error fails it. A check that was interrupted counts as failed: at every start
  Keeper deletes its recorded test backup and any downloaded archive left behind, and logs it. A pass is tied to the
  exclusion this build ships (its hash); a build with another exclusion needs the check again.
- **Both key roles.** Keeper keeps only a read-only key (a key that can write is refused at entry and for arming).
  The old `hc_api_key` option must be gone, and the old key's rotation attested: while Keeper has seen an old key in
  its options (it keeps only its id, a hash, and the key itself root-only in `hc-key-old` to try it once), arming is
  refused until you tap the card Cain's link posts naming that id, once you revoked the key in Healthchecks. The
  link signs your tap with its Ship key and Keeper checks that signature, so nothing Cain writes himself counts;
  where Keeper kept the old key it first tries it at Healthchecks and needs it rejected (`the alert service still
  accepts the old key ...` otherwise). (0.1.10) The try is a read-only GET of the checks list (the endpoint the old
  option was used for). (0.1.16) Only Healthchecks' documented `wrong api key` answer on a 401 or 403 proves the key
  revoked. A bare 401, once or repeated, stays unknown, since an outage or a proxy can answer 401: Keeper logs "the alert
  service answered 401 with no documented body: not taken as proof; try again later", pages you once for that tap, and
  you tap again later. A bare 403 never proves it either. The answer's body is read for at most 3 seconds and only its
  first 4 KB; a body cut short by either proves nothing. The kept old key is deleted as soon as that passes, and is written in the first place only
  once its file is checked inside the backup exclusion. Where no old key was kept, nothing can be tried: the card and
  Keeper's state say "attested by your tap only". The link's signature is bound to the current enrollment, the old
  key's id and a single-use challenge Keeper issues (`GET /rotation`), and the link checks the tap is yours before it
  signs. An options read that fails or doesn't answer within 10 seconds counts as the
  old option still present: not armable, and `hc-key` refused, until a read answers.
- **The check identities.** Every role (`done`, `deadman`, and each watched App's alert check, `0fcc2575_cain`) needs
  its check's unique key set in `hc_unique_keys`, read from the read-only API or the check's page, so no derived
  match decides; a role without one refuses arming.
- Still yours, by hand: the phone test and the missed-heartbeat drill reach your phone from each check.

## Arming

"Ship it with that risk" goes only while the rollback is armed for the App. `/armed` is worked out at
every read, never stored, and says armed only while all of these hold:

1. Keeper is armable: `hc_done`, `hc_deadman`, a kept Healthchecks read-only key (0.1.5; entered with
   `hc-key` since 0.1.7), and an alert check of its own for every watched App, each a distinct Healthchecks
   check;
1a. (0.1.7) you accepted the limits below ("Accepted limits") for the current text version, and no drill is
   running (one drill at a time);
2. both drill records of the App are valid under the current binding: two drills each rolled back by
   an actual restore of their backup (the restore job finished without errors), with their trigger and a
   delivered line to you, one where the App's probe said FAIL and one where the App exits on start;
   (0.1.13) such drills are installs your tap on the link's drill card armed (below, "The drill runbook");
3. the **phone test drill** is confirmed for the App's alert check and the dead-man check within the
   last 14 days (0.1.5; 0.1.8: `drill_days`, 1 to 14), under the current Healthchecks options and checks' settings, with no page left
   unacknowledged for 10 minutes since (below);
3a. (0.1.6) the **missed-heartbeat drill** is confirmed within the last 14 days, under the current
   Healthchecks options and checks' settings, and isn't running now (below);
4. a heartbeat ping and a dead-man ping were delivered (a 2xx answer) within the last 10 minutes, and
   Keeper's poll loop completed a round within the last 3 minutes;
5. each alert check's log ping was delivered within the last 10 minutes;
6. no fail ping has waited undelivered in the queue for more than 2 minutes;
7. (0.1.5) the checks' settings, read through the kept key within the last 3 minutes, are within the
   bounds above, each check with a channel and none paused.

**The phone test (a drill, 0.1.3; 0.1.4; 0.1.6).** With no incident open, run in the Keeper App's container
`bun /opt/keeper/main.ts phone-test` (for example from the SSH App: `docker exec "$(docker ps --format '{{.Names}}' | grep 0fcc2575_keeper)" bun
/opt/keeper/main.ts phone-test`). Keeper pages each watched App's alert check once ("Keeper phone test (a
drill) ..."), and (0.1.4) the dead-man check too, each followed by its all clear, and (0.1.6) prints a
one-time code in its log. Once the pages have reached your phone, within an hour, run
`bun /opt/keeper/main.ts phone-confirm <code> cain deadman` the same way. The confirm is your own attestation that
the alert appeared on your phone, for each check named: Keeper can't see the phone, takes your word, and logs it as
that (0.1.8). 0.1.7: the confirm is whole, in one
call: it names every check (each watched App's short name for its alert check, and `deadman` for the dead-man
check), every page must have been delivered to Healthchecks within the hour, and only then is the code spent.
Naming only some checks confirms nothing and leaves the code standing; if a check's page didn't reach your
phone, the test failed: fix that check's channel and run `phone-test` again. It shows that a page from each check reaches your phone, at that moment, and
stands as your confirmation that each check's channel reaches it. It doesn't show that Healthchecks will page
you when a check goes quiet: the missed-heartbeat drill (below) shows that for the heartbeat check.
The dead-man check after the phone test: its page is a fail ping, so Healthchecks shows it down until the
"keeper alive" ping that follows at once, and then up again by itself. While a read of the API shows it
down, arming is refused ("hc_deadman ... is down"); that refusal clears by itself at the next read that shows
it up, with no new phone test (the settings' hash doesn't include a check's status). It lapses, and
arming closes, after 14 days (0.1.5), on any change of `hc_done`, `hc_deadman`, `hc_failed`,
`hc_unique_keys` or the kept key, on any change of a check's period, grace or channels as the API shows them (putting the old
one back doesn't bring it back), and (0.1.5) when any page (a fail ping, the dead-man check's included) has
no acknowledgment from Healthchecks, a 2xx answer, within 10 minutes of being sent. Until that deadline
an undelivered page is retried, and it disarms after 2 minutes (6 above). The phone test reads the
checks' settings first and is refused while they refuse arming.

What the acknowledgment shows: that Healthchecks took the page, not that your phone rang.

**The missed-heartbeat drill (0.1.6; 0.1.7).** With no incident open and the checks' settings read within
bounds, run `bun /opt/keeper/main.ts missed-heartbeat` in Keeper's container. Keeper stops its heartbeat ping
to `hc_done` and (0.1.7) reads Healthchecks every minute until it shows the heartbeat check down, at most 30
minutes, instead of working out the silence from the check's settings; the dead-man ping goes on.
Healthchecks marks the check down and pages you. Keeper prints a one-time code, logs when Healthchecks shows
the check down, then resumes the ping at once, and logs when Healthchecks shows the check up again. Once the
page reached your phone and the check is up again, within an hour after the ping resumed, run
`bun /opt/keeper/main.ts missed-heartbeat-confirm <code>`, your own attestation that the alert appeared on your
phone (0.1.8: its log line says so). It is refused before the ping resumed, before the
check is seen up again (the drill needs a whole down-to-up cycle), more than an hour after, with a wrong or
stale code, or if Healthchecks never showed the check down within the 30 minutes. A heartbeat check on a
schedule (cron) rather than a period is refused with a plain line: the drill needs a period check. Arming needs
the drill within 14 days (0.1.8: or `drill_days`, and both drills get a log reminder a day before they are due),
and it lapses exactly as the phone test does: a change of any Healthchecks option,
the kept key or check settings, a page left unacknowledged, a rewound state. The window this leaves is one of
the accepted limits below.

**One drill at a time (0.1.7).** While a drill runs (the phone test from its pages until its confirm or its
code runs out; the missed-heartbeat drill from its start until its confirm or an hour after its ping resumed)
Keeper is unarmed and starts no other drill, and it refuses every registration: a page or a silent heartbeat
during a real install would be mistaken for the drill's, or the other way round. A drill that is interrupted,
by a restart of Keeper or by a registration arriving meanwhile, is void: its code no longer counts (`... was
interrupted (...): its code no longer counts; run it again from the start`), and it needs a fresh run, for the
missed-heartbeat drill a fresh down-to-up cycle.

**The one-time codes (0.1.6; 0.1.7).** `key-confirm`, `phone-confirm`, `missed-heartbeat-confirm`, and since
0.1.7 `accept-limits` and `hc-key`, each need a one-time code Keeper prints in its log (`one-time code for
key-confirm: <code> (good until ...)`): for `key-confirm` (0.1.9) only on demand, with `bun /opt/keeper/main.ts
key-code` (good 24 hours), never at start or at a pin, and codes printed by an earlier build are void at this
build's first start; for
`hc-key` at every start (24 hours); for `accept-limits` at every start while the limits aren't accepted for the
current text (24 hours); at each phone test (its hour and 10 minutes); and at each missed-heartbeat drill (until
an hour after its 30 minute cap). 0.1.7: each code is bound to its exact challenge (the key's fingerprint, that
phone test, that drill, the limits' text version), kept only as a hash with it, and spent by its first good use,
checked and removed in one step, so it can't be used twice or for another challenge. A newer code of a kind
replaces the last one; a wrong, stale or other-challenge code is refused and logged.
**Who can use them.** The codes are not secret from anyone who can read Keeper's log (the log page in Home
Assistant, a Supervisor log read). They show the confirmer read the log for that very challenge, nothing more.
The commands reach Keeper only on its container's own loopback (`127.0.0.1:8096`, a listener of its own); the App
network's listener (port 8097) refuses them from any address. So the container's network mode is the real gate on
the confirm commands: `host_network: false` is set in Keeper's `config.yaml` (a test fails if it changes), which
keeps every other container and the host network off that loopback. Only a process inside Keeper's own container
(`docker exec "$(docker ps --format '{{.Names}}' | grep 0fcc2575_keeper)" ...` at the Pi, as root) can make them.

The binding is the verdict protocol, the App's probe (its hash), Keeper's version, Keeper's options and the
backup scope. The drill records are dropped when the binding changes, after 60 days, or when Keeper's
heartbeat stopped for more than 10 minutes before a start (a restore of Keeper or a long stop; the phone
test too, and Ship tokens issued before that start are then refused). A registration never drops them.
The restore job name a drill recorded is kept apart from them and isn't dropped.

A later item, not in this version: an independent verifier lease (a second watcher that must vouch for
Keeper before it counts as armed).

## The drill runbook (0.1.13)

Keeper arms only after two drill records (Arming, 2), and it writes a drill record only for an install registered
as kind `drill` that it rolled back. Since Cain 0.19.0 with Keeper 0.1.13 one switch makes such an install, and only
your tap sets it: the **drill flag**.

**The switch** (0.1.14: round 15's version, fail closed throughout).
- Cain asks for the card: `/opt/cain/keeper.sh drill-arm exit-on-start <version>` (or `verdict-fail`), the version
  being the Cain version the drill release carries (its `config.yaml` at the pull request's head). That version is
  checked when the install registers, against `cain/config.yaml` at the pull request's head: a flag armed for another
  version is refused, nothing is installed, and the refusal then blocks every install of Cain until you tap **Clear the
  drill** on its message (or arm a new drill). The link posts you
  one card, "Keeper drill: ... it must be Cain <version> ...", with one button, **Arm the drill**. Cain's request sets
  nothing; a new card for another version or mode retires an open one (its button no longer arms anything).
- Your tap is checked to be yours, in your DM, the same way as a Ship tap, and only then signed with the link's Ship
  key (which Cain can't read) and kept by root as the flag, `/data/trust/keeper-drill.json` (0600), good for a day,
  naming the mode, the version and a fresh nonce.
- The next registration of Cain spends it. **A flag file that exists but doesn't verify** (another key, a damaged or
  earlier payload, run out), **names another version**, or **whose nonce is already spent** is removed, the install is
  refused and logged, and you get one message: "the drill flag was damaged or had run out; nothing was installed; arm
  it again" (or, for a version, which one it was armed for). A registration goes as a normal one (kind `ship`) only
  when no flag file exists at all.
- A good flag's nonce is recorded first, in root's spent list `/data/link/keeper-drill-spent/` (0700, one file per
  nonce, kept a day past its expiry, and outside Cain's backups by `backup_exclude`), then the flag is removed. Only
  the registration that records the nonce goes on as a drill; another at the same moment stops and says so. Keeper
  records every drill nonce too and refuses one twice, so a restored backup that brings an old flag back can't arm
  anything (and when a restore leaves the link without its Ship key, it makes a new one, so an old flag fails its
  signature as well).
- The registration goes to Keeper as kind `drill` with the mode and the nonce; Keeper names the attempt
  `drill-<pr>-cain-<head>`. Only a definitive acceptance counts: Keeper's "accepted" for that drill, its kind, mode
  and versions, with its checked backup. A pending answer at the end of the wait, a refusal or no answer installs
  nothing, and you get one message saying so.
- Then the link writes the **drill mark**, `/data/trust/keeper-drill-mark.json` (root's, mode 0644: readable by the
  App, never writable by it; Keeper 0.1.15), signed with the drill
  key (an Ed25519 key derived from the Ship key under its own domain; its public half is
  `/data/trust/keeper-drill-mark.pub`, 0600), naming the version, the attempt, the mode and its expiry (90 minutes),
  and tells Keeper so (`POST /attempt/<id>/drill-mark`, the mark's hash). It is written after Keeper's backup, so the
  backup a rollback restores never holds the mark or the flag. A mark that can't be written, or that Keeper doesn't
  confirm, aborts the drill: the attempt is recorded as aborted (`/data/trust/keeper-drill-aborted.jsonl`), cancelled
  at Keeper, the mark dropped, and you get one message.
- The version installed fails on purpose, at run time: `exit-on-start`, the Cain App stops at once when it starts
  (its run script's helper; the App's own "exited" alarm comes too, expected here); or `verdict-fail`, the verdict
  probe reports FAIL for that attempt without asking his session. Both check the mark's signature first (a
  hand-written or unsigned mark is ignored and logged), then ask Keeper with Cain's token for its open attempt: only
  when Keeper names the mark's attempt as a drill of that mode and version, its mark confirmed, still in its watch,
  does the start fail. Otherwise, or when Keeper doesn't answer, the mark is dropped and the start goes on as usual,
  with a log line. So a reinstall or a restart of that version outside the drill starts normally. Only the attempt
  that owns a mark, or a cancel of it (even one Keeper answers pending), removes it: no other registration does.
- **What a drill record needs** (Keeper 0.1.14): kind `drill` plus a rollback is not enough. It also needs the link's
  confirmation that the mark was written for that attempt, and the failure Keeper observed must be the one the mode
  names (`exit-on-start`: the App not started or in error, the exits-on-start record; `verdict-fail`: the probe's
  FAIL, the fail-verdict record). The record keeps the mode and the mark's hash as its evidence.
- **The follow-ups gate.** While option `drill_followups_open` is `true` (the default), Keeper reads not armed
  whatever its drills recorded, and `drill-state` says why (`followups_open: true`). Keeper 0.1.15 closed three of the
  items the drill plan filed: the Ship token's causal link to the install (now the install job binding, below), late
  jobs racing a backup delete (now the pins), and the pending claim in the hook (now the acceptance outside the hook's
  bound). Keeper 0.1.16 closed the other three: the secret scanner's coverage (the backup check's scan reads every
  byte of the archive), a bare 401 taken as a revocation (only the documented answer counts), and the pending lock's
  bound (released at 3 minutes from the step's start, whatever the step does). Only the device checks remain ("Still to check on the device", 0.1.15, 0.1.16 and 0.1.17): you set
  the option to `false` once they are done, after the device run, and not before. It isn't in the drill records' binding, so changing it drops nothing: the drills
  can run before, and arming completes only after.

**Round 16 (Keeper 0.1.15, Cain 0.19.0): the switch as it now is.**
- **Single use, and tied to its own install job.** A Ship approval starts one pass (the link records its use before
  anything is registered) and registers once per App at Keeper; a second submission of the same token is refused by
  both. The link doesn't submit the install itself: the Ship run installs through Home Assistant, as RELEASING.md's
  Ship section says. So Keeper ties the install to the Supervisor's own job: while an attempt is claimed it reads the
  jobs list (`/jobs/info`, the backup role's read) and binds the one install or update job of the App made during the
  claim, by its id and creation time (`<id>: bound to the Supervisor's install job <uuid> ...`). Two such jobs, or one
  made before the claim that is still running, can't be tied to one attempt: unprotected, paged, never rolled back.
  Keeper watches, rolls back and credits a drill only for a start whose attempt has its job bound; a start of the
  claimed version with no job made during the claim is not the attempt's install. Once its job is bound the claim
  stays live 15 minutes past its deadline for the version to show. `GET /attempt/<id>` names the job
  (`install_job`, `install_job_at`).
- **The drilled start, tied to the job.** The run script's helper and the verdict probe ask Keeper about the mark's
  own attempt only (`GET /attempt/<id>`, read only) and fail on purpose only when Keeper names it a drill in its watch
  with its install job bound, made before this start and within an hour of it. Which: the Supervisor's job record, as
  Keeper read it, against the App's own clock at its start. The limit: the jobs list says nothing about which
  container a job started, so a restart of the drilled version within that hour (the watchdog's) also counts as the
  drill's start, and when the jobs list can't be read Keeper binds nothing and the start waits (the helper's retries,
  then its abort).
- **A lookup that fails keeps the mark.** Keeper unreachable, restarting or slow: the helper keeps the mark and asks
  again every 5 seconds for 90 seconds; then it records the abort (`/data/trust/keeper-drill-aborted.jsonl`, `page:
  true`) and the start stops (exit 1): never a usual start of the drill. The App's finish pings the outside heartbeat's
  failure check, and Keeper, once it sees the App not started, rolls it back and pages you. A later start of that
  attempt aborts at once while its mark lasts. Only Keeper's definitive "no drill" (another attempt, a ship, another
  mode or version, no confirmation, closed, no such attempt) drops the mark, and the start goes on.
- **A refused flag never becomes a ship.** A flag that doesn't verify, or names another version, is refused and the
  refusal kept (`/data/link/keeper-drill-refused.json`, root's, beside the spent list): every install of Cain is then
  refused, with one message whose button **Clear the drill** removes the refusal; arming a new drill from a card
  replaces it too. A registration consumes the flag by renaming that exact file aside first
  (`keeper-drill.json.claim-<id>`), so a new flag written meanwhile is a new one, never consumed by it.
- **A crash between the nonce and the flag's removal.** A claimed flag left behind whose nonce is spent is removed at
  the next install, which is refused once, with one message; the install after goes as usual. One whose nonce isn't
  spent yet is spent then.
- **The flag is bound to the App and the version** (`app` in its payload): another App's registration leaves it be.
- **Every Ship token carries `kind: "ship"`**; the link, the hook and Keeper refuse one without it.
- **The mark** is root's `0644`: readable by the App, never writable by it.
- **The clock.** The link's spent list keeps a high-water time (`.high-water` in its folder): a flag is judged against
  the later of the clock and that time, and pruning removes only entries older than it.
- **Restore safety.** The flag, the mark and Cain's spent list are left out of Cain's backups (`backup_exclude`), and
  Keeper keeps its own spent list in `/data/drill-spent/` (one file per nonce, never pruned), left out of Keeper's
  backups and read again at every start, so a Keeper state rolled back before a nonce was kept still refuses it. The
  Supervisor keeps excluded files where they are on a restore of the App; that a full restore keeps both spent lists
  is a device check (below).
- **Acceptance outside the hook's bound.** The hook asks the link (10 seconds), which answers pending and waits for
  Keeper's "accepted" on its own clock, up to Cain's option `keeper_accept_min` (1 to 15 minutes, default 5); Keeper
  makes and checks the backup on its own clock. An acceptance the link never claims (the link crashed after it) ends
  by itself after 30 minutes as a **terminal abort**: its backup kept, you paged. The link refuses, at its next start,
  every pass a restart left open and cancels its attempts, and reads each passed one's attempt at Keeper, its job
  included, into its log.
- **Cancels.** A cancel is recorded at Keeper as asked the moment it arrives: if its step fails, times out or answers
  pending, the attempt is never claimed or consumed after it, and the next poll ends it as a terminal abort, which
  wins over a late backup or a late install (that install is unprotected, never rolled back).
- **Backups.** Only the backup made for this attempt, completed and checked before the acceptance, is its rollback
  point; one whose create timed out is disqualified for good, however it finishes. The cleanup never deletes a backup
  an open attempt names, or one pinned by an install job with no recorded end (or by a claim the jobs list can't
  confirm had none), reading the attempt records right before every delete; the claim reads the backup's slug again
  right before the install.
- **Quiet hours.** From 22:00 to 07:00 (the link's check-in zone) the drill card is refused, not held: Cain is told
  "ask again after 7:00", and nothing is sent at 07:00 unless he asks again. Only the retry and free-space cards are
  held and sent at 07:00 (the link's `quietFlush`). The rotation card isn't posted then either; Cain's next ask after
  07:00 posts it. The drill pages and Keeper's own alerts are never held.

**The crash ordering.** Each step is durable before the next: read the flag, claim it (0.1.15: renamed aside), check
it, record its nonce, remove the claimed flag, register at Keeper, the acceptance (within `keeper_accept_min`), write the
mark, confirm it to Keeper, the claim, the Supervisor's install job bound to it, the drilled start.
- Cut before the claim: the flag stands; the next registration claims it.
- Claimed, nonce not recorded: the next registration finds the claimed flag and spends it then.
- Nonce recorded, claimed flag not removed: the next registration finds it spent, removes it, refuses once and tells
  you; the install after goes as usual. It never counts twice.
- Flag removed, nothing registered: no attempt exists; the Ship pass times out and is refused. Arm again.
- Registered, no mark: the pass is refused or times out and its attempts are cancelled; with no mark nothing fails on
  purpose, and Keeper writes no drill record without the mark's confirmation.
- Mark written, not confirmed: the run-time helper finds Keeper doesn't name it confirmed and drops it; the refused
  pass's cancel drops it too.
- Mark confirmed: the install goes on as a drill; if the pass is refused after that, its cancel drops the mark.
- Accepted, never claimed (the link crashed): Keeper ends it after 30 minutes as a terminal abort, its backup kept,
  and pages you; the link refuses the pass at its next start.
- Claimed, no install job made during the claim (the install never reached the Supervisor, or its answer was lost and
  nothing ran): the claim's deadline ends it as a terminal abort, paged; an install that shows later is unprotected.
- Job bound, the version never shows: 15 minutes past the claim's deadline, a terminal abort; the backup stays pinned
  until the job's end is recorded.
- Job bound, the drilled version starts: the helper (or the probe) finds Keeper naming the drill with its job and fails
  on purpose; Keeper unreachable then, it retries, then aborts (the start stops).

**The drill releases.** Each is healthy code: a Cain patch release whose only change is its version (a CHANGELOG
section that says it is a drill release with nothing new), built by a Build job (RELEASING.md, Build) and landed by the usual
Ship tap (RELEASING.md, Ship). Nothing in `main` ever fails on purpose; the failure comes only from the flag.
Keeper names an attempt by its kind, pull request and head, and takes each name once, so each drilled install needs a
release of its own; the healthy case is the same release shipped again with no flag (a new Ship card for the same
pull request and head: "Already in main, so Ship only installs it."). None of them may change Cain's verdict probe
(`cain/rootfs/opt/cain/probe/keeper.ts`): the drill records are bound to its hash.

**What must hold before the first case, and stay as it is until arming.** A drill record counts only under the
binding it was made with: Keeper's version, its options (including `hc_unique_keys`), the kept Healthchecks key and
Cain's probe hash (Arming, the binding). So everything in the binding is set first, and none of it changes until the
phone test and the missed-heartbeat drill are done; a Keeper update after the drills drops them and they run again.

1. **The order of installs.** The Keeper App first, then the current Cain App (0.19.0) unwatched. The pull request
   that brings them installs both; the Ship job installs Keeper first. Cain's install is unwatched: the Cain that
   runs then has no Ship pass and registers nothing, and the link must be installed before it can register anything.
   Keeper logs it as an "unregistered change", never restored.
2. Keeper's options: `watch`, `health`, `tokens` (and the same token in Cain's `keeper_token`), `hc_done`,
   `hc_deadman`, `hc_failed` (Cain's alert check: a drill record needs its rollback line delivered there),
   `hc_unique_keys` for every role, `ship_public_key`, `drill_days` (What you must set, 1 to 4).
3. In Keeper's container (for example `docker exec "$(docker ps --format '{{.Names}}' | grep 0fcc2575_keeper)" bun /opt/keeper/main.ts <command>` from
   the SSH App, as for `key-confirm` above: `app_0fcc2575_keeper` on the device, `addon_0fcc2575_keeper` only on an
   older Home Assistant; the SSH user `hassio` runs it with `sudo`): `key-code`, then `key-confirm <fingerprint> <code>` against
   `cain/SHIP_KEY_FINGERPRINT`; `backup-check`; `hc-key <code>` (the key on standard input); `accept-limits <code>`.
4. The state read, before and after every case below: `bun /opt/keeper/main.ts drill-state` in Keeper's container
   (read only: each watched App's newest attempts with their kind, versions, status, trigger, whether a restore ran
   and whether a drill record was written; its two drill records and whether each counts under the current binding;
   and why it isn't armed), and the Cain App's version on its Home Assistant page.

**The cases.** Cain is at the release before each case (call it N). Each case is one Arm the drill tap (none for
the healthy case), then one Ship tap. Wait for each case's last line before the next.

| Case | Version and taps | What Keeper must show | Proves on the Pi |
| --- | --- | --- | --- |
| 1. exit-on-start | Drill release 1 (N+1). `drill-arm exit-on-start <N+1>`, your Arm the drill tap, then its Ship tap. | `accepting drill-<pr>-cain-<head> ...`, `the link confirmed the drill mark of drill-...`, `claimed ...`, the App not started on two polls, `<id>: fail (...); restoring 0fcc2575_cain from backup ...`, `drill recorded for 0fcc2575_cain: exits-on-start (...)`; Cain back at N; your phone gets the rollback line. drill-state: that attempt `rolled back`, `restored`, `drill_recorded` true and `mark_confirmed` set, the exits-on-start record counting. Then the restored backup's check below. | A release that won't start is put back by itself from Keeper's own backup, through the Supervisor's real restore, and the line reaches you. |
| 2. healthy | The same release again, no tap but Ship: a new Ship card for the same pull request and head. | `accepting ship-<pr>-cain-<head> ...`, the watch's 15 minutes, `passed`; no restore, no drill record; Cain at N+1. | With no flag the same release is a normal install: kind ship, a healthy start, nothing rolled back. |
| 3. verdict-fail | Drill release 2 (N+2). `drill-arm verdict-fail <N+2>`, your tap, then its Ship tap. | Cain's log: `verdict FAIL for the watched install`; Keeper: `its probe said FAIL: a Keeper drill ...`, the restore, `drill recorded for 0fcc2575_cain: fail-verdict (...)`; Cain back at N+1. drill-state: both records counting. | A release that starts but fails its own check is put back too, on the probe's word. |
| 4. Restart during a watch | Ship release 2 again with no flag first (Cain at N+2). Then drill release 3 (N+3): `drill-arm exit-on-start <N+3>`, your tap, its Ship tap, and Restart the Keeper App (its Home Assistant page) the moment its log shows `consumed drill-...` (the drilled version seen), before any `<id>: fail (...); restoring ...` line. Keep it a Restart, back within a minute: a stop over 10 minutes drops the drill records (Arming, the binding). | After Keeper's restart, the same attempt still ends `rolled back` with one restore call, never a second, and its drill record written again; Cain back at N+2. | A watch survives Keeper restarting in the middle of it: its state on disk carries the watch to the rollback. A restart after the restore call went out proves something else (Keeper never sends a restore twice, so that attempt ends unresolved and pages you): run the case again with drill release 4. |
| 5. healthy again | Ship release 3 again with no flag. | `passed`; Cain at N+3. | Cain ends on the newest release, as before the drills. |

**The restored backup's check (the first device drill, case 1).** Once Cain is back at N, list what Keeper's backup
held and what the restore left: in Home Assistant, Settings, System, Backups, open the backup named
`Keeper drill-<pr>-cain-<head> ...` and note its contents (the Cain App only); then, from the SSH App,
`docker exec "$(docker ps --format '{{.Names}}' | grep 0fcc2575_cain)" ls -l /data/trust/` (Cain's container is `app_0fcc2575_cain` on the device, `addon_0fcc2575_cain` only on an older Home Assistant, as above) and confirm neither `keeper-drill.json` (the flag) nor
`keeper-drill-mark.json` (the mark) is there. Either one present means the backup or the restore held it: stop the
drills and log it as a Build item.

After case 3 `drill-state` shows both records counting, and the reason it isn't armed moves on from "no drills on
record" to the phone test. If a record isn't written (`no drill record for <id>: <why>`, for example its line wasn't
delivered), fix the why and run `drill-record <attempt id>` in Keeper's container once.

**After the cases: your setup steps.** These don't touch the binding, so they come once the cases have run:
1. The SSH route: the container commands above go through the SSH App, as the user `hassio` with `sudo`. (0.1.17) scp
   is closed on the device, so a script is never copied over: it is piped over ssh's standard input, for example
   `ssh hassio@<the Pi> 'sudo bash -s' < script.sh`. Once the drills are done, close or lock down whatever access you
   opened for them.
2. The old Healthchecks key: revoke it in Healthchecks (Project Settings, API Access), then
3. the rotation tap: tap **Old key replaced** on the link's card (What you must set, "Both key roles").
4. The phone test: `phone-test`, then `phone-confirm <code> cain deadman` once both pages reached your phone (Arming).
5. The missed-heartbeat drill: `missed-heartbeat`, then `missed-heartbeat-confirm <code>` (Arming).
6. Once Keeper 0.1.17 is installed (0.1.16 closed the drill plan's follow-up items; 0.1.17 lets the backup check read
   the device's full-size backup) and the device checks are done ("Still to check on the device", 0.1.15, 0.1.16 and
   0.1.17), set `drill_followups_open` to `false` in Keeper's options.
Then `drill-state` (or Cain's "Ship it with that risk" card) reads armed; until step 6 it says the follow-up items
or the device checks are still open, so arming can't complete on this runbook alone. The phone test and the missed-heartbeat
drill last `drill_days`; the drill records last 60 days or until the binding changes.

## Accepted limits

Text version 7 (0.1.15). Version 6 was 0.1.12's, version 5 0.1.11's, version 4 0.1.10's, version 3 0.1.9's, version 2
0.1.8's and version 1 0.1.7's; an acceptance of any of them lapsed with 0.1.15. Three
limits of Keeper's design are recorded here rather than built around, and you accept them at the device: `bun
/opt/keeper/main.ts accept-limits <code>` in Keeper's container, with the code Keeper prints at each start while they
aren't accepted for this text version (`one-time code for accept-limits: ...`). Keeper records your acceptance with the
text version in its state; arming needs it, and it lapses when this text changes (a new text version). Keeper's log
says so at start. Keeper covers only the first 15 minutes after an install.

**1. The installer: a claim authorizes nothing, and one installer at a time.** A claim is not a single-use installer
authorization. Since 0.1.15 the install job binding narrows what one covers: Keeper watches an install only through
the one Supervisor install job of the App made during the claim (a second job, or one made before the claim and still
running, leaves it unprotected), and a new registration waits while an earlier attempt's install job has no recorded
end. It still can't tell which installer asked the Supervisor for that job. An install needs your Ship tap and the link's Ship token for that pull request and head, good for 2
hours after your tap; a claim authorizes nothing. A claim is single use only in this sense: one claimant, consumed by
the one install it covers, and it covers no other install. The Ship token stays valid by its signature for its 2 hours
outside the hook, and only the hook marks it spent: the link's pass records it on its first use, so a second Ship run
on it is refused there, but nothing else checks it is unspent. The watch accepts only an install matching its own
attempt and generation: the claimed attempt's own backup bound to it, and its generation the App's newest; any other
install is "unprotected", paged and never restored. The Ship run is a cloud session that reaches GitHub and
Home Assistant only. It can't call Keeper or Cain's link, so nothing at the moment the installer asks the Supervisor
to install can spend an authorization. The gates in code are two: Cain's hook at the run's start (the claim, and its
deadline checked again just before the run starts), and Keeper's own fence (a version change seen outside a live
claim, or to another version than the claimed one, is "unprotected", paged, and never restored). What is left:
- A pass the link refuses after two silences, or whose cancel is lost, leaves a live claim on the keeper for up to
  30 minutes with no Ship run live. The link asks a claim once more when the keeper doesn't answer; after a second
  silence it refuses the pass and cancels, but the keeper may have recorded the claim, and a cancel is sent once and
  may be lost (0.1.15: Keeper records the cancel as asked the moment it arrives, so a cancel that reached it ends the
  attempt as a terminal abort at the next poll). Otherwise that claim stands until its deadline. When it runs out with
  no install job made during it, Keeper logs `claim <claim id> of <attempt> ended (aborted: no Supervisor install job
  of Cain was made during its claim <claim id>); its deadline was <time>` and `<attempt>: ended; backup kept: aborted:
  ... (backup <slug> "<name>", ...)`, and pages you: the backup is never deleted with the claim, only by the bounded
  cleanup, and never while an install job of it has no recorded end.
- While a claim is live (at most 30 minutes from the link's claim), an install of exactly the claimed version made
  some other way is taken for the Ship run's, watched and, on a fail, rolled back from the backup Keeper took for the
  Ship run. Only you can start such an install, from Home Assistant's own page.

The one-installer rule applies to every entry point: a Ship card, Home Assistant's own page, a laptop session, and
break glass alike. One install of an App at a time, and none beside a live claim. When an install's outcome is
uncertain (a run that stopped without saying, a claim you can't see ended), wait for the recorded claim end in
Keeper's log (`claim <id> of <attempt> ended (...)`) before any other install. Keeper logs every claim's start and
end with its deadline, one line each (`claimed <attempt> claim <id> ... until <time>`, and `claim <id> of <attempt>
ended (<how>); its deadline was <time>`). The hook allows one pending Ship run per attempt: one Ship tap starts one
run, and a second run on a token whose attempt has a live claim is refused with the claim's latest expiry named.
Your guard: never install from Home Assistant's page while a Ship run is live, or until the keeper's log shows no
live claim (up to 30 minutes after a refused or failed run). Install only through Ship cards. A space refusal stops the install: when Keeper
has no room for the backup it takes first, the install is refused and nothing is installed, and no button or override
installs it without Keeper's rollback; you clear space (Settings, System, Backups) or choose another path yourself.

**2. Delivery: no code can prove a page reached your phone.** Keeper sees only that Healthchecks took a page (a 2xx
answer), never that your phone rang, and the read-only key cannot see notification channels, so unassigning or breaking
the phone channel in the alert service is invisible until the next phone test or drill: Keeper reads the checks'
settings, but with that key a channel's change shows nowhere it can read. The phone test and the missed-heartbeat
drill prove delivery only at the moment you confirm them, and each confirm is the owner's own attestation that the
alert appeared on the phone: Keeper takes your word, with the one-time code showing you read its log for that very
drill. Arming expires at the configured interval: option `drill_days`, 14 days by default and at most, so arming
lapses when the next drill is missed or fails, at the 14-day mark (the longest a drill counts), or sooner when you
set `drill_days` lower; Keeper logs a reminder a day before each is due (`drill due: run ... again before <time>`), and
the drills themselves are still run by hand. A failed drill: a phone test whose page didn't reach your phone can't be
confirmed, and since starting a phone test drops the earlier confirmations, Keeper stays unarmed until a new one is
confirmed; a missed-heartbeat drill that isn't confirmed within its hour counts for nothing (the last confirmed one
counts only until its own interval ends); and Keeper is unarmed while any drill runs. A failure on the provider's side
afterwards (Healthchecks or its channel silently stops delivering) goes unseen until the next drill. What you can do:
set `drill_days` to 7 (weekly halves the window) and run the drills when reminded; keep Healthchecks' repeated
reminders on; and treat a quiet phone during an install you are watching as a reason to look at Keeper's log.

**3. Keeper's backups are protected with a key only Keeper holds (0.1.12).** Every backup Keeper makes of a watched App
is protected with a password Keeper keeps in `/data/backup-keys`, left out of its own backups. Home Assistant's backup
page shows them as protected and you can't open or restore them by hand; Home Assistant's own pre-install backup,
protected with your key, stays your way back by hand. If Keeper's data is lost, Keeper can't restore from the backups
it kept: each is unusable, and an install it covered is "unprotected", paged, never restored. Keeper's own backup check
test backup stays unprotected (the check must read it), so it holds Keeper's own options in clear on the device's disk
until it is deleted, right after the check and at every start after an interrupted one.

## Options

| Option | What it is |
| --- | --- |
| `watch` | The App slugs Keeper watches. Default `0fcc2575_cain`. |
| `health` | Each watched App's health address on the internal network, `slug=host:port/path`. Liveness is always that host's `/health`; another path (Cain's `/ready`, the default) is reported as chat connected or not. Default `0fcc2575_cain=0fcc2575-cain:8098/ready`. |
| `tokens` | Each App's own token, `slug=token` (see above). |
| `hc_done` | The heartbeat check's ping URL. |
| `hc_deadman` | The dead-man check's ping URL (0.1.3). |
| `hc_failed` | The alert checks: `slug=URL` entries, one per watched App (a plain URL is fine when one App is watched). |
| `hc_unique_keys` | (0.1.7) Optional: `role=<unique key>` entries (role `done`, `deadman` or an App's slug), each check's unique key as the read-only API shows it, used in place of the one derived from its ping URL when that doesn't match. |
| `health_grace_s` | Seconds after a watched App first starts before failed liveness polls count. Default 180. |
| `ship_public_key` | Cain's link's public Ship key, base64 (0.1.3). Pinned on first use; the first pin and every change need `key-confirm` (0.1.4; 0.1.5). |
| `drill_days` | (0.1.8) 1 to 14, default 14: how many days the phone test and the missed-heartbeat drill count for arming. Keeper logs a reminder a day before each is due; running them is still by hand. |
| `drill_followups_open` | (0.1.14) Default `true`: Keeper reads not armed while the drill plan's follow-up items are open (The drill runbook). Set it `false` once they have landed. Not in the drill records' binding: changing it drops nothing. |

The Healthchecks key is not an option since 0.1.7: it is entered once with `hc-key` (What you must set, 2).
Options are read again every 30 seconds, through the Supervisor: a change needs no restart (and drops the
drill records). Keeper never writes them. The `attempt` option of earlier versions is gone.

## Its service

On Home Assistant's internal App network only (port 8097, no host port), each call with the calling
App's token (`Authorization: Bearer <token>`):

- `POST /attempt` (Cain's token only): register an install (above); answered 202 at once (0.1.5).
- `GET /attempt/<id>` (Cain's token only, 0.1.5): where a registration stands: pending, accepted (with its
  backup), claimed (with its claim), refused or ended, with the pinned fingerprint, its confirmation and the
  state's creation time.
- `POST /attempt/<id>/claim` (Cain's token only, 0.1.5): `{app, from_version, to_version, backup, request}`;
  one claimant, valid 30 minutes; (0.1.7) a retry with the same `request` reads the recorded claim.
- `POST /attempt/<id>/cancel` (Cain's token only, 0.1.5): ends a pending, accepted or claimed registration;
  (0.1.7) a retry reads the recorded outcome, and a claim already handed to a started run is refused; (0.1.8)
  refused while the Supervisor's jobs list shows an install, update, rebuild or restore of the App or a job on it
  Keeper doesn't recognize, or can't be read (below, "The claim record").
- `GET /attempt`: the open install of the caller's App, or none.
- `POST /verdict` `{app, version, attempt, result: PASS|FAIL, reason}`: accepted only for the open
  install of the caller's App, at its new version. Anything else is ignored and logged.
- `GET /armed?app=<slug>`: the armed state worked out now, why not, its binding, Keeper's version, a
  timestamp refreshed every minute, and (0.1.5) the enrollment (0.1.7: with the enrollment id and the counter,
  which each read moves on; 0.1.8: answered under the claim record's lock, only once that counter is on disk).
- `GET /last`: Keeper's last line to you about the caller's App.
- `GET /rotation` (Cain's token only, 0.1.9): whether the old Healthchecks key's rotation still needs your tap, and
  that key's id (a hash, never the key); (0.1.10) whether the old key is kept (`old_key_kept`, and `proof`: "attested
  by your tap only" when it isn't), the enrollment id and a single-use challenge (10 minutes).
- `POST /rotation/attest` (Cain's token only, 0.1.9): `{attestation}`, your tap on the link's card, signed by the
  link's Ship key and checked against the pinned, confirmed key; (0.1.10) version 2, bound to that enrollment, the old
  key's id and that challenge, which it spends.

From inside Keeper's own container only, on its own loopback listener (0.1.6: `127.0.0.1:8096`, never the
App network's): `drill-record`, `phone-test`, `phone-confirm <code> <check>...`, `key-confirm <fingerprint>
<code>`, (0.1.6) `missed-heartbeat` and `missed-heartbeat-confirm <code>`, (0.1.7) `accept-limits <code>`
and `hc-key <code>` (the key on standard input), (0.1.8) `key-code`, and (0.1.9) `backup-check`.

## The claim record: the cancel, the lock, the counter and re-enrollment (0.1.8)

**The cancel.** The link's cancel (`POST /attempt/<id>/cancel`) is served under the claim record's lock, and there
Keeper reads the Supervisor's jobs list for the App. (0.1.9) The cancel ends the claim whatever the list shows, and
never deletes the backup: it is kept, bound to its generation, with the line `<id>: ended; backup kept: <reason>`,
the reason naming what the list showed (an install running, a job Keeper doesn't recognize, a list it couldn't read).
A cancel is refused only once the claim was handed to a started run.

**The unused expiry.** A claim that runs out with no version change seen ends "unused", and (0.1.9) its backup is
kept the same way, for the bounded cleanup only. An install seen after it instead is unprotected, and its backup's
kept reason says a rollback by hand may need it.

**The lock's bounds.** Claim, cancel, consume, the expiries and `/armed` run one at a time under one lock. Each
external call inside it is bounded (10 seconds; one that doesn't answer or throws counts as unreadable, logged), a
step that throws or runs past 30 seconds is logged (`a step under the claim record's lock failed ...`) and the lock
released for the next one, and the deadline is read again under the lock right before a claim or a consume commits,
so a request that waited in the queue past its deadline is refused. (0.1.9) Each step under the lock has its own
generation: every commit, delete or state write checks it in the same moment as the write, so a step that ran past
its 30 seconds and resumes later changes nothing; a delete already in flight when the step runs out keeps the lock
until it ends (`... with a write in flight: the lock is held until that write ends`).

**The counter.** Every state write moves the enrollment counter on, and each `/armed` read is one: the state is
written whole (a temporary file, fsynced, renamed, the folder fsynced) before the answer leaves, and an answer whose
state couldn't be saved says not armed and carries no enrollment. When the link refuses Keeper's enrollment as an
older state (a counter below the one it recorded), its cancel says so and Keeper logs `enrollment counter behind the
link: re-enroll with key-confirm`.

**Re-enrollment.** After a restore of Keeper's state, its counter may be far below the link's record. The owner's
`key-confirm` gives a brand-new enrollment id; the link records the counter that enrollment carries and enforces
increases within that id from then on. A reply for an enrollment the link has since replaced is discarded. The
re-enrollment code is printed at start only while the key isn't enrolled or after the link refused the enrollment
(`the link refused Keeper's enrollment at ...`); otherwise run `bun /opt/keeper/main.ts key-code` in Keeper's
container for a fresh one, then `key-confirm <fingerprint> <code>`.

## Permissions

The Supervisor's backup role only (App and backup info, the jobs list `/jobs/info`, App-only backups and
restores, (0.1.6) deleting the orphan backups it made, and (0.1.7) the backups list `/backups`, to find one by its
name), plus reading its own info (`/addons/self/info`), never manager, and no write of any options.
No Home Assistant API, no ingress, no page, no `/share`. (0.1.7) `host_network: false`, stated in `config.yaml`
and held by a test: the container keeps its own network namespace, which is what keeps its loopback, and the
confirm commands on it, to processes inside the container. `backup_exclude` leaves the kept Healthchecks key
(`/data/hc-key`) and (0.1.12) the backup key store (`/data/backup-keys`) out of backups of the App. (0.1.12) The backups
Keeper makes of a watched App are protected with a password it passes to the Supervisor, and its restores pass it again.

## Restoring

(0.1.9) A partial restore through Home Assistant's backup page (Settings, System, Backups, one App's backup) is the
exercised path, and the one Keeper itself uses. A full restore of the whole Pi from a fresh Home Assistant is
untested: none has been run with Keeper installed. After any restore of Keeper itself, its kept key and the old key's
file are missing (backups leave them out), so enter the key again with `hc-key`. (0.1.12) The backup key store is
missing too, so Keeper can't restore from any backup it kept before; Home Assistant's own pre-install backup, with your
key, is the way back by hand.

## Still to check on the device

None of this has run on the Pi yet. Owed there: the backup role makes a partial backup (with
`background: false` its call answers once it is complete, within 4 minutes for Cain) and restores one; the
backup info shows `protected: true` (0.1.12: Keeper's backups carry its own password) and a `date`, and a restore with
that password works; a restore's answer carries its job id and the jobs list
shows the restore job long enough to read its result; the drill's record of its restore job's name and
how long it stayed listed (`restoreJob`, evidence only: 0.1.5 never resends); Healthchecks accepts
the `/log` pings; the dead-man check pages when Keeper is stopped and when its poll loop stalls; the phone
test reaches the phone from each check; the pinned key's first page; Cain's link reaches Keeper's `POST
/attempt` and polls it through the backup, then claims it; (0.1.5) the first pin's `key-confirm` against
`cain/SHIP_KEY_FINGERPRINT`; the Healthchecks API read with the kept key in both modes (0.1.6: a read-write key's answer
shows ping URLs and is refused; whether the read-only key shows each check's channels, and whether its
`unique_key` matches a uuid ping URL); the missed-heartbeat drill paging the phone; (0.1.6) the loopback
listener and the one-time codes; the backup role deleting an orphan backup (if it can't, the log names it);
(0.1.7) `hc-key` entry at the Pi (the read-only key accepted, a read-write key refused at entry, the file 0600),
a backup of the Keeper App leaving `/data/hc-key` out (`backup_exclude`), each role's live check mapping (the
derived match, or `hc_unique_keys`), the jobs list's names for an install or update of Cain (Keeper matches
`install`, `update`, `rebuild` or `restore` with Cain's slug as the reference), the backups list's `name` field
matching the name Keeper gave, the missed-heartbeat drill's down-to-up cycle on the live check, and Cain's link
recording the enrollment id and counter from `/armed`; (0.1.8) the device checks before arming (above: both key roles,
each role's check identity by an explicit `hc_unique_keys` entry, the backup leaving out the key file), the jobs list's
names for anything else that runs on Cain (a name Keeper doesn't recognize refuses a cancel), the key file's mode at the
Pi, and the old key rotated in Healthchecks; the break-glass exercise with Keeper absent (a fix installed with no Keeper at
all); (0.1.9) the backup check on the Pi (the backup role makes and downloads a backup of Keeper itself, and the
download is a tar Keeper can read), `/host/info`'s `disk_free` and the backup info's `size` for the free-space
reserve, the old key's try at Healthchecks answering 401 or 403 once revoked, the rotation card's tap reaching Keeper,
and a full-Pi restore from a fresh Home Assistant (untested); (0.1.10) the backup check's archive as the Pi's
Supervisor makes it (its layout, whether the App's archive is gzip, `size` and `size_bytes` in the backup info
matching the download, the positive control found once), the old key's try answering `wrong api key` (on a 401 or
403, 0.1.16) once revoked, a refused registration for free space bringing the link's card (no button since 0.1.11), and the rotation card's
challenge reaching Keeper within its 10 minutes; (0.1.12) a backup made with Keeper's password shown as protected in the
backup info and on Home Assistant's backup page, a partial restore of it with the same password, and the backup check
passing with the backup key store's sentinels; and the two drills (the next job). (0.1.13) The drill switch itself: the link's drill card and your tap reaching the flag in `/data/trust`, the run script's exit at start and the probe's FAIL for the drilled version only, the mark missing from the backup a rollback restores, `drill-state` read in the container, and the restart case's timing on the Pi ("The drill runbook"). (0.1.14) The run script's helper reaching Keeper's `GET /attempt` with Cain's token at start, and dropping a mark when Keeper names no drill; the link's `POST /attempt/<id>/drill-mark` reaching Keeper; the drill files' modes in `/data/trust` and `/data/link` on the Pi; the spent list staying out of a Cain backup; the restored backup's contents and no flag or mark after case 1.

(0.1.15) This round's device checks, in this order; the follow-ups gate is cleared only once they are done:
1. The backup exclusion first, with a placeholder: run `backup-check` (its sentinels stand in for the key) and confirm
   it passes for this build's exclusion (the `drill-spent` folder is new in it) before you enter the live key with
   `hc-key`.
2. Then the live key: `hc-key <code>`, and each role's check identity against the live service (`hc_unique_keys`).
3. The old key's rotation attestation, made explicit: revoke it in Healthchecks, then tap **Old key replaced**, before
   arming (the gate refuses arming until that tap is recorded).
4. The install job binding: at a real Ship of Cain, Keeper's log shows `bound to the Supervisor's install job <uuid>`
   with the job's name (`addon_manager_update` or what the Pi's Supervisor calls it) and its creation time inside the
   claim; `GET /attempt/<id>` names it; the jobs list shows that job finished, and its end is recorded.
5. The drilled start tied to its job: in drill case 1 the helper exits only once Keeper names the job; stop Keeper
   for the first 2 minutes of a drill install and the helper keeps the mark, retries, then aborts (exit 1, the abort
   line in `/data/trust/keeper-drill-aborted.jsonl`, the outside heartbeat's failure page, then Keeper's rollback
   once it is back).
6. A restore keeps the excluded files: after case 1, and once after a full restore from a backup, `/data/drill-spent/`
   in Keeper and `/data/link/keeper-drill-spent/` in Cain still hold every nonce spent since (the Supervisor keeps
   excluded paths on a restore), and neither the flag nor the mark is in the backup's contents.
7. The pins: a kept backup whose attempt's install job is still listed as running isn't deleted by the cleanup
   (`it is pinned (...)` in the log).
8. The refused-drill page's **Clear the drill** tap reaching the link; a drill card asked for between 22:00 and 07:00
   refused with "ask again after 7:00" (not held, nothing sent at 07:00); the retry and free-space cards held from
   22:00 to 07:00 and sent at 07:00.
9. Cain's option `keeper_accept_min` read by the link (its wait for Keeper's acceptance), and the link's reconcile
   at its start (a pass a restart left open refused, in its log).

(0.1.16) The device checks this build needs, named here. `drill_followups_open` stays `true` until each is done:
10. The backup check run again: the scan was widened (every byte of the archive, and a sentinel in `/data/drill-spent/`),
    so a pass recorded before 0.1.16 no longer counts. Run `backup-check` after installing 0.1.16 (step 1 above, with the
    placeholder); its log line names `drill-spent/backup-check-sentinel` among the sentinels placed.
11. The real archive passes the wider scan: the Supervisor's own archive of Keeper has only zeros after its gzip stream
    and after each tar's end-of-archive block, one gzip member with a matching trailer, and the control once in a file.
    A failure names the layer, the byte and what matched: copy that line into a Build item. (0.1.17) Before this check
    goes on a runbook, `backup-check` is run at device size (an archive of 100 MB or more) under a memory cap: the
    0.1.16 scan of the device's 100 MB backup was killed by the kernel's out-of-memory killer, and only the tests' small
    archives had been scanned before. `keeper/tests/scan-stream.test.ts` runs it in CI (an archive over 100 MB whose image
    tar inflates past 300 MB, the scan's child under a 256 MB cap, its peak asserted); on the Pi, Keeper's log line
    `backup check: the scan read <n> files, decoded <bytes> bytes, peak memory <MB> (its limit 384.0 MB)` shows the
    device's own run.
12. The service's real answer for a revoked key, captured as a fixture: revoke a spare read-only key in Healthchecks,
    try it once (`curl -s -o - -w '%{http_code}' -H 'X-Api-Key: <that key>' https://healthchecks.io/api/v3/checks/`),
    and record the status and body (expected: 401 with `{"error": "wrong api key"}`; the key itself never goes in the
    record). Anything else means the rotation tap can't prove a revocation: a Build item.
13. The lock's bound against a real hung Supervisor step: while a cleanup's delete is slow (or the Supervisor is busy),
    Keeper's log shows the lock released at 3 minutes from the step's start, the operation late, `can't be reconciled
    yet` while a backup job runs, then reconciled once none does, and Supervisor writes going on after.
14. The container name on this Home Assistant: `docker ps --format '{{.Names}}' | grep 0fcc2575_keeper` names exactly
    one container, and the commands above reach it. (0.1.17) On the device it is `app_0fcc2575_keeper`, not
    `addon_0fcc2575_keeper`; the SSH user is `hassio`, with `sudo`; scp is closed, so scripts are piped over ssh's
    standard input.

(0.1.17) This build's device check, after 14:
15. The backup check run again on the streaming scan (scan 3): a pass recorded by 0.1.16's scan no longer counts. Run
    `backup-check` after installing 0.1.17; it should pass on the device's full-size backup, and its log shows the
    scan's peak memory (above, 11). If it says the scan was killed, copy its line (it names the archive's size) into a
    Build item.
    (Fix round) Then three runs that prove the service survives and cleans up, at the Pi in Keeper's container (Pi access
    in RELEASING.md). Record each run's peak memory and duration (the log's "backup check: the scan read ...
    peak memory ..." line and the time from "backup check running" to the answer) in the Build item.
    a. Under a memory hog (dd): in another shell on the Pi, start a hog that fills memory until the kernel's
       out-of-memory killer acts (for example `sudo dd if=/dev/zero of=/dev/null bs=1G count=1 iflag=fullblock` run a few
       times at once, or one with a bs near the free memory `free -m` shows), then run `backup-check`. Expected: the
       kernel kills the scan's child (or the hog), never Keeper's service; `backup-check` answers (killed (signal 9),
       likely out of memory, or a pass); the log shows the sentinels removed and the test backup deleted; Keeper's
       service is still running (`docker ps` shows the container up and its log shows no restart).
    b. With an all-zero high-ratio image: the scan's tests already read 2 GB of zeros in about 55 MB; on the device, place
       a large all-zero file in Keeper's data folder outside the exclusion
       (`docker exec ... dd if=/dev/zero of=/data/zeros.img bs=1M count=1024`), run `backup-check`, then remove it
       (`docker exec ... rm /data/zeros.img`). Expected: a pass, the log showing the decoded size and a peak well under
       the limit.
    c. With the service stopped mid-scan: run `backup-check`, and while it says "still running" restart the Keeper App
       from Home Assistant. Expected: the CLI says the service stopped answering; after the restart the log says the
       interrupted check counts as failed and its test backup is deleted; no orphaned child, temp file or sentinel
       remains (`docker exec ... ps aux` shows no `scan.ts child`; `/tmp/keeper-backup-check` is empty; no
       `backup-check-sentinel` or `backup-check-control` file is left under `/data`, and the log says the sentinels were
       removed).

Follow-ups, not built in 0.1.17 (named here so they aren't lost): a cgroup memory limit for the scan's child (a hard
ceiling the kernel enforces, rather than the child's own sampled limit; it needs a change outside Keeper's folder, in how
the image runs); and deriving the download's cap from free disk (today a fixed 200 MB) so a check never fills the disk.

(0.1.17, last fix round) What the scan's memory rests on, said plainly:
- The bound the design gives: each gzip layer is fed 4 KB at a time, so one piece's output is at most 4 KB times deflate's
  maximum ratio (about 1032) times the deepest nesting (6), about 25 MB, held with backpressure; plus each layer's own
  buffering (a record of at most 1 MB, a tar header, a 64 KB output chunk or two) and the 256 KB outer read, about 33 MB on top
  of Bun's own. The tests pin it under the 256 MB cap and run the real child at the deepest nesting under that cap.
- The child's resident-size limit (384 MB on the device) is a sampled check: the child reads its own size on every piece and
  every 20 ms and stops itself past the limit, but between samples nothing stops it, so the kernel is the hard limit until a
  cgroup limit lands (the follow-up above). The service names a kill "likely out of memory" from the latest and the peak of
  every sample the child reported, read as they stream, never from stderr's capped text.
- Device check 15's runs (the real archive, the memory hog, the all-zero image, the service stopped mid-scan, each with its
  peak memory and duration recorded) are the conditions for setting `drill_followups_open` to false.
- A backup the host finishes after the check gave up on it (its create timed out or was aborted) is looked for in the backups
  list, by its name or as a backup that wasn't there before, for up to 60 seconds after the check, and deleted once it shows.
  If it doesn't show in time, `backup-check`'s answer names it (`the test backup "Keeper backup check <id>" may still be on
  the host`); Keeper looks for it at each poll for an hour, and every start deletes any backup named like a test backup. One
  check runs at a time until all of that is done: a second `backup-check` meanwhile says "a backup check is already running".
  The whole answer comes within the 8-minute deadline plus the 60-second cleanup, inside the CLI's 10-minute wait.
- The scan's child runs in its own process group: a timeout, an abort or a pipe failure kills the group, so nothing it started
  is left holding its pipes. Its ask to the out-of-memory killer (`/proc/self/oom_score_adj`) is never fatal: a read-only
  `/proc` or a refusal is logged (`the scan's child says: oom_score_adj not set ...`) and the scan goes on.

More follow-ups, outside Keeper's folder and not built in 0.1.17: a cgroup memory limit in the workflow (the tests' child under a
kernel-enforced limit, not only the sampled one), and the tests run on ARM in CI: a pinned Bun build on ARM running the gzip
boundary suite (`keeper/tests/scan-review.test.ts` item 1 and `keeper/tests/scan-last.test.ts` item 2), since the device is an
ARM Pi and CI runs on x86.
