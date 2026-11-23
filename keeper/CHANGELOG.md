# Changelog

## 0.1.9

- Keeper covers only the first 15 minutes after an install, and now says so on its card and in its docs.
- Cancelling a Ship pass, or a claim running out unused, no longer deletes the backup taken for it, since Home Assistant may be starting an install at that moment. Keeper logs "ended; backup kept" with the backup's name.
- Kept backups are tidied up by Keeper itself, and only its own: never within 2 hours of a claim ending, never while an install runs, at most two kept, none older than about 3 days. Your own backups are never touched.
- Before each new backup Keeper checks there is room for it. If there isn't, the install is refused and you are paged.
- New command `backup-check`: Keeper makes a test backup of itself and checks no key file or key is in it. Entering the Healthchecks key with `hc-key` waits until it has passed.
- Keeper won't arm until you confirm the old Healthchecks key was replaced, by tapping the card Cain posts naming it. Where Keeper still has the old key, it first checks Healthchecks turns it down. Each Healthchecks check now needs its unique key in `hc_unique_keys`.
- The code for confirming the Ship key is only printed when you ask for it with `key-code`, and codes from earlier versions no longer work.
- The "Accepted limits" text is now version 3, so you accept it again with `accept-limits`.

## 0.1.8

- The "Accepted limits" text is now version 2, so you accept it again with `accept-limits`. It says plainly that a refused or failed Ship run can leave a live claim for up to 30 minutes, so never install Cain from Home Assistant's page while a Ship run is live or until Keeper's log shows no live claim, and that a broken phone channel in Healthchecks goes unseen until your next phone test or drill.
- Keeper logs when each claim starts and when it ends, with its deadline, and a second Ship run on the same tap is refused naming when the live claim runs out.
- While the old `hc_api_key` option is still in Keeper's options, Keeper won't arm and refuses `hc-key`. Remove it, then make a new read-only key in Healthchecks, since earlier backups may hold the old one.
- The kept Healthchecks key file is private from the moment it is written.
- A cancel from Cain's link is refused while Home Assistant shows an install of Cain, or any job on Cain Keeper doesn't recognize, or can't say; the claim and its backup are kept. An unused claim's backup waits one more check before it is deleted.
- Keeper can't hang on a slow Home Assistant answer while it handles a claim, a cancel or an armed check, and a claim that waited past its deadline is refused.
- New option `drill_days` (1 to 14, default 14): how long the phone test and the missed-heartbeat drill count, with a reminder in Keeper's log a day before each is due.
- The code for confirming the Ship key again is printed at start only when it is needed; otherwise ask for one with `key-code`. If Cain's link turns down Keeper's enrollment, Keeper says so in its log and prints a code.

## 0.1.7

- The Healthchecks key is no longer an option. You enter it once at the device with `hc-key` (the key typed in, never on the command line). Keeper checks it is the read-only key and sees your checks before it keeps it, keeps it where only Keeper reads it, and leaves it out of backups. Remove the old `hc_api_key` option: until you do, Keeper's log reminds you at every start.
- Two limits of Keeper's design are now written in its docs ("Accepted limits"): an install of the same version made from Home Assistant's own page during a Ship run counts as the Ship run's, and a page that stops reaching your phone after a drill can go unseen for up to 14 days. You accept them once with `accept-limits`; Keeper won't arm until you do.
- A cancelled Ship whose cancel got lost no longer leaves a backup behind: an unused claim's backup is deleted when it runs out, unless an install of Cain is still running.
- One drill at a time: while the phone test or the missed-heartbeat drill runs, Keeper isn't armed and turns installs away. A restart or an install during a drill cancels it, so run it again.
- The phone test is confirmed in one go, naming every check, and the missed-heartbeat drill now waits for Healthchecks to show the check down and then up again.
- If Keeper's state is restored from a backup, Cain's link notices and waits until you confirm the Ship key again with the fresh code Keeper prints at start.
- New option `hc_unique_keys`, only if Keeper matches the wrong Healthchecks check.

## 0.1.6

- Keeper now takes only a read-only Healthchecks key. A key that could change your checks is refused, Keeper won't arm with it, and you are paged once to swap it for the project's read-only key.
- If the read-only key hides which channels a check pages, you confirm each check yourself at the phone test: `phone-confirm` now names each check whose page reached your phone, and Keeper arms on that.
- A new drill before arming, the missed heartbeat: Keeper stops its heartbeat until Healthchecks pages you, and you confirm the page reached your phone within an hour. Arming needs it within the last 14 days, and it lapses with the phone test.
- Confirming the Ship key, the phone test and the drill now needs a one-time code that Keeper prints in its log, and these commands work only from inside Keeper itself.
- An install seen during its claim is watched its full 15 minutes even past the claim's deadline, and an install of a different version than the one claimed pages you as unprotected and is never rolled back.
- A backup Keeper made for an install that was called off, or never claimed, is deleted. If it can't be deleted, Keeper's log names it so you can delete it by hand.

## 0.1.5

- Keeper never sends a restore twice. If Home Assistant turns a rollback down, fails it or doesn't answer, Keeper pages you "unresolved", keeps checking without touching anything, and tells you once it knows.
- An install is covered only once Cain's link claims Keeper's acceptance as the Ship run starts. An acceptance not claimed within 30 minutes, or a claim with no install within 30 minutes, ends with a line in Keeper's log. An install Keeper sees outside a live claim pages you as unprotected and is never rolled back.
- Keeper accepts no install until you confirm its Ship key at the device with `key-confirm`, at first setup too, and again after its state is lost or restored. Cain's link also checks Keeper's key against the fingerprint kept in the repository.
- New option `hc_api_key`: a Healthchecks API key. Keeper reads each check's timing, status and notification channels with it, and can't be armed without it, while a check's timing is outside the limits in its docs, while a check has no channel or is paused, or once the settings change after your phone test.
- The phone test now lasts 14 days. A page that Healthchecks hasn't taken within 10 minutes closes the gate until a new phone test.
- Registering an install answers at once and Cain's link checks back while the backup is made, so nothing waits on one long request.

## 0.1.4

- A Ship install now starts only after Keeper has made and checked Cain's backup. Keeper answers the registration only once that backup is complete, and Cain's Ship run waits for that answer. If the backup fails or takes over 4 minutes, you are paged "unprotected" and nothing is installed. Each acceptance covers one install only.
- Keeper no longer sends a restore a second time on its own until a drill on the device has recorded what Home Assistant's restore job is called. Until then a turned-down restore is "unresolved", and you are paged.
- Keeper remembers the first Ship key it sees and tells you its fingerprint. A different key in its options is refused until you confirm it at the device with `key-confirm`.
- The dead-man check now only says "alive" while Keeper's checks are actually running. If they stall for 3 minutes, the dead-man check pages you.
- The phone test now pages the dead-man check too. It lasts 30 days, and lapses when you change a Healthchecks option or a page fails to reach Healthchecks. Each check must be its own Healthchecks check.
- If an install passes but chat was down for most of its 15 minutes, you are paged so you can roll it back by hand. Keeper doesn't roll it back.
- A Ship tap from before Keeper's state was created (a fresh install or a restore of Keeper) is refused.

## 0.1.3

- Keeper now checks your Ship tap itself. An install is registered with the signed token from your tap, and Keeper checks its signature with Cain's public Ship key (the new option `ship_public_key`). A made up or reused registration is refused, each tap counts once per App, and Cain starts only one Ship run per tap.
- Nothing writes Keeper's options during a Ship any more. Cain's link registers the install with Keeper directly, and Keeper takes the App-only backup itself.
- A rollback counts as done only when Home Assistant's restore job says it finished. If Cain is seen coming back at the old version without that, or the restore call got a server error or no answer, you hear "unresolved" and Keeper never restores again by itself. A restore is sent a second time only when Home Assistant turned it down before starting anything.
- A Discord outage can no longer cause or fail a rollback. Keeper decides on whether Cain is running and alive; whether chat is connected is only reported ("chat not connected (degraded)").
- With more than one App watched, each needs its own alert check. A new dead-man check (`hc_deadman`) pages you if Keeper itself dies. Arming now also needs a phone test: Keeper pages you once as a drill, and you confirm it reached your phone (good for 60 days).
- Keeper no longer keeps its own copy of its tokens and Healthchecks addresses: if they disappear from its options, it is simply not armed until you put them back.

## 0.1.2

- A rollback is sent a second time only when the first provably never ran: the Supervisor answered it with an error, or the restore job it named is seen ended with errors while the App isn't back. Anything unclear is "unresolved": Keeper never restores again by itself, keeps checking on every poll, and tells you once more when it knows how it ended.
- Keeper counts a rollback as done only from its restore job, or from seeing the App stop and come back at the old version, never from the version alone.
- No secret in Keeper's options any more: an install's registration carries only a fingerprint of your Ship tap, its pull request, its commit and when it runs out. Keeper refuses one that has run out or isn't in that shape, and never writes its own options.
- Keeper's tokens and Healthchecks addresses are kept in its own storage, so options that lost them keep working, and Keeper says so in its log.
- Each App can have its own alert check (`hc_failed`), and Keeper checks every 5 minutes, without paging you, that each alert check still answers. "Armed" now holds only while the heartbeat and every alert check answered in the last 10 minutes and no alert has been stuck for over 2 minutes; it comes back by itself after an outage.
- Cain's readiness counts as failing only after it has been ready once since he started, and after a rollback Keeper waits 5 more minutes once if Cain is running but Discord isn't connected yet. A long Discord outage can still fail an install check, and then you hear it.

## 0.1.1

- A rollback is never started twice. Keeper keeps the Supervisor's job for each restore and, if it loses track of one (no answer, or a restart), checks that job and Cain's version before doing anything more. If it still can't tell, it stops and tells you ("unresolved") instead of restoring again.
- Every rollback reaches your phone: an alert as soon as it starts, and the all clear only once the old version is running and healthy again.
- An install whose registration changed Keeper's own tokens or Healthchecks addresses is refused, and Keeper keeps the ones it had. Each registration counts once: it is spent, cleared from Keeper's options, and refused if it comes back.
- A password-protected backup is refused before the install, since Keeper can't restore it. Ship backups are made without a password.
- Keeper now asks Cain's readiness address (/ready), not his liveness one.
- "Armed" now also needs Keeper's heartbeat to have reached Healthchecks in the last 10 minutes. A rollback where Cain keeps restarting counts as failed ("gave up").

## 0.1.0

- A new App, Keeper. After every install of Cain it checks him for 15 minutes, and if the install is bad (he stops, keeps failing his health check, or his own check says so) it puts back the backup taken just before the install, by itself.
- Every install is registered with Keeper first, by the Ship job. A version change nobody registered is never rolled back, and you hear about it.
- Keeper tells you without Cain, through two Healthchecks.io checks you set up for your phone: when it rolled something back, when it couldn't, when an install couldn't be protected or never started, and when Keeper itself stops.
- A rollback loses only what that App wrote after the backup. Home Assistant, your other Apps and shared folders are left alone.
- "Ship it with that risk" can go ahead only once Keeper is armed for that App, after two drills have rolled back for real and the two checks are set. Until then it stays refused, as now.
- Options to set: the two Healthchecks ping URLs and a token for Cain (DOCS.md says how).
