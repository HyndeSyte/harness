# Changelog

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
