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

Second round (the outside review): the primary route is now the Supervisor's own restart call (POST
/addons/self/restart). The Supervisor lets every App's token through to /addons/self/* (but security
and update) with no API role, so hassio_api stays off and no manager role is needed; the switch to his
own user already makes the same call (bashio::addon.restart). The exit route (exit 3, the s6 exitcode
file, the watchdog) is the fallback when the Supervisor refuses the call or doesn't stop the App within a
minute. Every self-restart pings the outside heartbeat's failure URL from the finish script, so a halt
that never comes back is raised from outside the App. The /health 503 is set only on a restart decision,
just before the App stops.

Still open: the running count and first failure's date in the "switch undone" line; the exit route
proven on the real server, probe-drill.sh 7 (the App stops with 3 and the Supervisor starts it again
within a minute), before relying on it; and the restart call watched once on the Pi in a real
self-restart (the log says "Asking the Supervisor for the App's restart", the outside heartbeat gets
the failure ping with exit code 256, and the next start is kept as asked).

Third round (the second outside review): the self-restart mark is cleared at the very top of the run
script, before its traps, and the finish script deletes it once read, so a mark left in /run can never
silence a later crash or turn the owner's Stop into a self-restart. /health answers the whole hassio
network (172.30.32.0/23) and logs each 404's address at most once a minute; probe-drill.sh 7 now opens
with a gate that checks the Supervisor's probe address and its 200 on the Pi before the exit route is
relied on. The Supervisor call is bounded as a process group (no orphan curls), and the fallback waits
2 minutes, past the Supervisor's 30 second stop timeout, instead of 1.

Fourth round (the third outside review): a restart call with no answer in its 30 seconds now waits the
same 2 minutes before the exit route, since the Supervisor may still carry it out; only a definite
refusal exits at once. So the fallback and the Supervisor's own restart can overlap only when the
Supervisor takes longer than about 150 seconds to stop the App, not never. A group that ignores the
TERM at the bound gets KILL 5 seconds later. terminal/run makes /run/cain-web itself just before nginx
(root:nogroup 0750, as lock.sh does), so nginx and /health no longer wait on the run script. The mark
holds the time it was written: a crash inside the window (any exit but 0, 3 or a caught TERM) removes
it, so it alarms and reports as a crash, and a TERM stop more than the wait plus 30 seconds after it is
logged as "stopped during the self-restart window", not a self-restart. probe-drill.sh 7's gate also
reads the Watchdog switch through the Supervisor's info call (must be on) and needs a /health 200 to
the Supervisor's address in nginx's note of 200s during its 3 minutes.
