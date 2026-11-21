# Changelog

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
