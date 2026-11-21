# Changelog

## 0.1.0

- A new App, Keeper. After every install of Cain it checks him for 15 minutes, and if the install is bad (he stops, keeps failing his health check, or his own check says so) it puts back the backup taken just before the install, by itself.
- Every install is registered with Keeper first, by the Ship job. A version change nobody registered is never rolled back, and you hear about it.
- Keeper tells you without Cain, through two Healthchecks.io checks you set up for your phone: when it rolled something back, when it couldn't, when an install couldn't be protected or never started, and when Keeper itself stops.
- A rollback loses only what that App wrote after the backup. Home Assistant, your other Apps and shared folders are left alone.
- "Ship it with that risk" can go ahead only once Keeper is armed for that App, after two drills have rolled back for real and the two checks are set. Until then it stays refused, as now.
- Options to set: the two Healthchecks ping URLs and a token for Cain (DOCS.md says how).
