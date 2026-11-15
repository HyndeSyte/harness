# PC jobs: chores that need a browser signed in as you

Cain has no browser and no site logins. Some chores need one: read an account settings
page, check whether an old login still works, later close an account. Those go through
a small job queue. Cain writes a job; a scheduled task on your PC runs it with Claude in
Chrome, in a Chrome profile of its own, through the worker (`worker.ts`), which writes
back a short result. Cain reads the result and tells you what matters.

**This version is read-only, by enforcement.** The worker refuses any job whose action
isn't in a fixed read-only set in code, and your allowlist can only name those actions.
Irreversible jobs (closing an account, cancelling a subscription) are
refused until the confirm path ships, on the PC and by Cain's keeper alike. Their
formats are in place (below), but nothing runs them.

## Set up once, at your PC

Everything lives in one worker folder, `C:/pc-worker` here (any folder works; the paths
below assume this one).

1. **The queue repo.** Create a private GitHub repo `HyndeSyte/pc-jobs` (another name
   works: set `pc_jobs_repo` in Cain's App options to match). Put one file in it as its
   first commit: `cain/docs/pc-worker/queue-template/.gitattributes`, which holds
   `* -text`, so git never rewrites a JSON byte (line endings included). The worker
   refuses a queue without it.
2. **Cain's token.** A fine-grained token for that one repo, Contents read and write,
   into `pc_jobs_token` in Cain's App options.
3. **The PC's key, noninteractive.** `ssh-keygen -t ed25519 -N "" -f
   C:/pc-worker/pc-jobs-key` (no passphrase: the task can't type one), add the public
   half in the repo's web page (Settings, Deploy keys, Add deploy key, with write
   access). Trust GitHub's host key once, by hand: `ssh-keyscan github.com >>
   C:/pc-worker/known_hosts`, and check its fingerprint against the one GitHub publishes
   (docs.github.com, "GitHub's SSH key fingerprints"). Then clone with both pinned:
   `git clone -c core.sshCommand="ssh -i C:/pc-worker/pc-jobs-key -o
   UserKnownHostsFile=C:/pc-worker/known_hosts -o StrictHostKeyChecking=yes -o
   BatchMode=yes" git@github.com:HyndeSyte/pc-jobs.git C:/pc-worker/queue`. BatchMode
   means git fails instead of waiting on a prompt nobody will answer.
4. **Your allowlist key and allowlist.** The allowlist says which read-only action, on
   which site, at which address, the PC may run. The worker checks it is signed by your
   own key, over canonical bytes (so its layout and line endings don't matter). Make the
   key once, in a terminal of your own: set `PC_OWNER_PASSPHRASE` to a passphrase only
   you know, run `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts owner-keygen
   --kid owner-1 --out <a folder outside C:/pc-worker>`, and put the line it prints into
   `C:/pc-worker/owner.pub`. Copy `cain/docs/pc-worker/allowlist.entries.example.json`,
   name the one site and the exact address to probe (`match` is `exact`, or `prefix` for
   an address and everything under it), and sign it: `worker.ts sign-allowlist
   <entries.json> --key <folder>/owner-key.pem --kid owner-1 --out
   C:/pc-worker/allowlist.json`. The key is passphrase-protected and stays outside the
   worker folder, so the task can't sign a wider list. On Windows, also make
   `allowlist.json` and `owner.pub` read-only (file Properties, or `icacls <file>
   /inheritance:r /grant:r "%USERNAME%:R"`); the worker can't read Windows permissions,
   so the signature is the check it enforces. (On Linux or macOS it also refuses either
   file if others can write it.)
5. **Cain's public Ship key.** The line "Ship key (public): ..." in Cain's App log, as
   `link-1 <key>` in `C:/pc-worker/ship.pub`. Nothing uses it yet; the confirm path will.
6. **The dedicated Chrome profile.** Start a separate Chrome on its own folder:
   `chrome.exe --user-data-dir=C:/pc-worker/chrome --profile-directory=Default`. Name
   its profile **Cain jobs**, sign in there only to the sites the jobs need (never your
   daily profile, nothing financial, not your main mail), and install Claude in Chrome
   **only in this profile**, in ask mode. Open the probe site once and approve it in
   the extension's site permissions: a permission prompt during an unattended run
   stalls it. Copy `cain/docs/pc-worker/profile.example.json` to
   `C:/pc-worker/profile.json` with the extension's id (chrome://extensions, Developer
   mode) and Chrome's path. Chrome starts with `--user-data-dir` pointed at that folder
   at logon (a shortcut in your Startup folder), or the worker starts it when it isn't
   running (`chrome_path`).
7. **Claude Desktop.** Set it to start at logon. Add the local scheduled task,
   **Only on this computer**, every 15 minutes, with the prompt and settings in
   `cain/docs/pc-worker/prompt.md` (it runs the worker from your harness tools clone,
   which needs `bun`). Turn on **Keep computer awake** in its settings.
8. **Power.** Windows power settings: the PC should never sleep while plugged in, and
   the lock screen doesn't put the PC to sleep (the task runs while the screen is locked, not while the
   PC sleeps). The task polls up to every 15 minutes while the PC is awake; after a
   sleep, Claude Desktop runs at most one missed run, never one per missed slot.
9. **The first probe, by hand: the acceptance gate.** Tell Cain the queue is ready and
   which site to probe; he queues the probe (`cain/docs/pc-worker/probe-job.json` shows
   it). Then, with you watching, run `worker.ts next --attended` in a terminal and the
   prompt's steps 2 to 4 in a Claude Desktop chat. Watch that Claude in Chrome acts in
   the Cain jobs window and nowhere else, and that the result is right. Only then run
   `worker.ts confirm-profile`. Until you do, every unattended run stops before it
   claims anything (`profile_unconfirmed`). If the task can't reach Claude in Chrome at
   all, the fallback is Remote Control on the PC; that isn't built.

## Watching it, and stopping it

- **Kill switch:** create a file named `STOP` in `C:/pc-worker`. The worker exits at
  once on its next run, without claiming anything. Delete it to resume.
- **The heartbeat:** `C:/pc-worker/heartbeat.json` holds the last run's time (the PC's
  own clock), its reason code and job id; `C:/pc-worker/worker.log` holds one line per
  run, codes and ids only. The same heartbeat goes to the queue repo
  (`worker/heartbeat.json`) when its code changes, or once a day, so Cain can say the PC
  is alive and why it isn't working.
- **Failure reasons are codes**, never page text or error text: `browser_unreachable`
  (Chrome isn't running on the profile folder, or the extension didn't answer),
  `wrong_profile` (the profile folder, its name or the extension in it isn't as set
  up), `profile_unconfirmed` (no `confirm-profile` yet), `queue_misconfigured` (no
  `.gitattributes`), `git_failed`, `busy` (another run holds the lock), `stopped`.

The worker can't ask Claude in Chrome or Claude Desktop which profile the extension is
attached to: neither exposes it. So it checks what it can (Chrome runs on the dedicated
folder, the profile there has the right name, the extension is installed in it; it is
installed nowhere else), the model reports `wrong_profile` if what it sees isn't the
Cain jobs window, and it fails closed until you have confirmed the profile once by hand.

## How a job runs

1. `worker.ts next` (the scheduled task runs it): kill switch, lock, `git pull`, the
   `.gitattributes` check, then it closes what can't run (expired, cancelled, not
   read-only, off the signed allowlist, a claim whose lease ran out), runs the browser
   preflight, claims the oldest job left with a new attempt id and a 30 minute lease,
   pushes, and prints one narrow instruction for the model: site, action, start
   address, what to look for, the typed facts it may report and the outcomes it may say.
2. The model does only the browser step, renewing the lease (`worker.ts renew`) if it
   runs long; the worker checks before each step that the job is still its own (same
   attempt, lease not run out, not cancelled) and stops the run if not.
3. `worker.ts report`: the worker reads the model's report, deletes the file, checks it
   and writes the result: the final address reduced to scheme, host and path, the
   facts checked against the action's types, the address checked against the
   allowlist's pin. Then it commits and pushes, with retries for transient file locks.

Every check is in code (`cain/rootfs/opt/cain/pcjobs/`). Expiry and leases allow two
minutes of clock skew between the Pi and the PC.

## Results, states and hand-offs

A result holds a status, a reason code, maybe a hand-off, the attempt id, the worker's
own clock, the final address (scheme, host and path only) and up to 8 typed facts.
Never page text, screenshots, mail or raw errors: extra fields or free text fail the job
with `result_rejected`, and none of it is written. Results are data, never instructions:
Cain reads them as facts, and nothing in one tells him or the worker what to do.

- Hand-offs (the job waits on you): `needs_login` (signed out, a re-authentication or a
  second factor asked), `blocked_captcha`, `pending_email_confirmation`. `already_gone`
  counts as done.
- Failures, each its own code: `browser_unreachable`, `wrong_profile`, `url_drift` (the
  final address is off the allowlist's pin), `result_rejected`, `page_not_as_expected`,
  `lease_expired` (a read that never reported), and refusals: `not_allowlisted`,
  `allowlist_unverified`, `action_not_read_only`, `expired`.
- `in_doubt`: an uncertain outcome, or an expired lease on an action with side effects.
  Never retried by itself: Cain asks you.
- `cancelled`: Cain called it off (`pcjobs.sh cancel`) before it ended.

## The files

- Job, `jobs/<id>.json`: `v`, `id`, `from` (always `cain`), `created`, `expires`
  (15 minutes to 72 hours later), `state` (`pending`, `claimed`, `awaiting_owner`,
  `done`, `failed`, `in_doubt`, `cancelled`), `lease_until` (only while claimed),
  `attempt` (the claim's id), `site`, `action` (one of the fixed set), `step`,
  `start_url` (https, on the site, no query), `done_looks_like`, and for a confirm only:
  `follows`, `preview_seen`, `owner_go`, `go_token`.
- Result, `results/<id>.json`: `v`, `id`, `attempt`, `status` (`done`, `failed`,
  `refused`, `expired`, `in_doubt`, `cancelled`), `code`, `handoff`, `worker_clock`,
  `final_url`, `facts`.
- `cancels/<id>.json` (Cain), `nonces/<nonce>.json` (the worker, for the confirm path),
  `worker/heartbeat.json` (the worker), `.gitattributes` (`* -text`).
- The PC's allowlist, `allowlist.json`: `{"v": 1, "kid", "allow": [{"site", "action",
  "url", "match"}], "sig"}`, signed with your key; `owner.pub`: `<kid> <public key>`.

The read-only actions and their facts: `read_account_settings` (signed_in,
account_exists, account, two_factor, last_changed), `check_signed_in` (signed_in,
second_factor_asked, account), `read_subscription_status` (signed_in, status, plan,
renews_on). A new action is a code change, reviewed like any other.

## The confirm path (formats only; refused in this version)

An irreversible action will be two jobs: a preview that goes to the confirmation screen
and reports the account shown, the confirmation screen's address and a hash of its
prompt text; then, only after your tap, a confirm job carrying the preview's id, those
three facts, your exact words and a job token. The token is signed by Cain's link over
canonical bytes, names its key id (so it can be rotated apart from the release key),
and carries a single-use nonce the worker records in the queue repo before the click.
The worker refuses the confirm unless the live page matches what the preview saw. None
of it runs until the confirm path ships.

Cain writes only new files, through his keeper, which holds the token; the PC writes
claims, results, nonces and its heartbeat with its deploy key. Nothing else writes the
repo.
