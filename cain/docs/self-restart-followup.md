# Follow-up: the App restarting itself (built in 0.15.0)

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

## What 0.15.0 built, and what is still open

Built (cain/rootfs/etc/services.d/cain/run `self_restart`, probe/main.ts `selfRestart`): the App exits on
an error and the Supervisor's watchdog switch starts it again, read through `/addons/self/info` (no API
role); marks in `/data/probe` (`self-restarts`, `self.json`, `self-asked`); one restart per incident
(30 minutes); 3 Supervisor answers in a row that can't be read alarm with the reason; with the switch off
the App never exits and alarms once, naming the switch; each self-restart in the morning check-in, and an
alarm after 3 in 24 hours or 2 of the same kind; the next start counted as an asked restart whose
requester is the App. The outside dead-man check is the heartbeat (heartbeat_url, every 5 minutes, since
Nov 18) and the Supervisor's watchdog itself.

Still open: the running count and first failure's date in the "switch undone" line, and the drill of
the exit-and-watchdog route on the real server (probe-drill.sh 5 kill with the switch on, and a forced
self-restart) before relying on it.
