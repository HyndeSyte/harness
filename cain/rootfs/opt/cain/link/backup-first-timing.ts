// Backup first's timing (Cain 0.19.4 with Keeper 0.1.19). One file, kept byte for byte the same in Cain's link
// (cain/rootfs/opt/cain/link/backup-first-timing.ts) and in the Keeper (keeper/rootfs/opt/keeper/backup-first-timing.ts);
// a test in each App fails when the two differ, so the link and the Keeper always judge a tap by the same window.
//
// The tap's window is built from its phases, each the bound the code already holds it to:
//   backup:  the Keeper's cold backup of Cain, which stops and starts Cain (the Keeper's backup bound, REGISTER_WAIT_MS);
//   restart: Cain's App back up and its link answering after that backup;
//   session: Cain's session back and taking the line with his Ship token.
// The restart and session phases are estimates until the first real install: the link and the Keeper log each phase's
// measured time (the lines carry "backup first timing"), and these numbers are set from what that install shows.
export const FIRST_PHASES_MS = { backup: 4 * 60_000, restart: 3 * 60_000, session: 3 * 60_000 } as const;
// From his tap to the Ship token: the link discards a tap older than this.
export const TAP_WINDOW_MS = FIRST_PHASES_MS.backup + FIRST_PHASES_MS.restart + FIRST_PHASES_MS.session;
// From the Ship token to the Ship run's registration at the Keeper (the run starting and its pass).
export const RUN_START_MS = 5 * 60_000;
// From the backup's own snapshot to the registration that uses it: the Keeper refuses an older backup, and deletes an
// unconsumed one once this has passed since it was asked for.
export const FIRST_BACKUP_MS = TAP_WINDOW_MS + RUN_START_MS;
