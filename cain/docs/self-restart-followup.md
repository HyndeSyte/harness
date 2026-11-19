# Follow-up: the App restarting itself (not built)

Cain 0.13.3 was going to have the App restart itself, once, when an alarm it could fix by a
restart stood past its window, and tell Dane only if that didn't help. A review took it out: a
restart from inside the App can hide an outage where the App never comes back (no watcher runs
then, and Dane hears nothing), retries forever when the Supervisor refuses, and restarts once per
boot rather than once per incident. So the alarms keep their text and the restart step for now.

What a separate job needs before the App restarts itself:

- Persist restart marks across boots in the App's data directory (`/data`), not in the container.
- One restart budget per incident: alarms due in the same window coalesce into one restart.
- Cap Supervisor refusals at 3 consecutive ticks, then alarm Dane with the reason.
- An external dead-man check (a Home Assistant automation or the Supervisor watchdog) that alarms
  if the App is not running, or has no fresh heartbeat, N minutes after a requested restart.
- Report every self-restart, with its cause and time, in Cain's morning update; alarm Dane after
  3 in 24 hours, or 2 of the same kind.
- A running count and the first failure's date in the "switch undone" line.
- Drill the Supervisor restart call from the watcher's subshell, as the unprivileged user, on the
  real server, before relying on it.
