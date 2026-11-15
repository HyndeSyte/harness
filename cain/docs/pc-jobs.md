# PC jobs: chores that need a browser signed in as you

Cain has no browser and no site logins. Some chores need one: read an account settings
page, check whether an old login still works, later close an account. Those go through
a small job queue. Cain writes a job; the worker on your PC (`worker.ts`) claims it,
starts a locked browser session of Claude in Chrome in a Chrome profile of its own,
checks what that session saw and writes back a short result. Cain reads the result and
tells you what matters.

## What is enforced, and what is not

- **Read-only actions, in code.** The worker refuses any job whose action isn't in a
  fixed read-only set, and your signed allowlist can only name those actions.
  Irreversible jobs (closing an account, cancelling a subscription) are
  refused until the confirm path ships, on the PC and by Cain's keeper alike. The confirm path's code
  (job tokens, nonces, the live-page gate) is there but behind `confirm_path` in your
  install config, which this version only accepts as `false`: no command of the worker
  reaches it.
- **The session's own permissions: enforced by the session's settings, verified on
  your PC before any unattended run.** Claude Desktop local scheduled tasks can't be
  given a pinned settings file (their documentation only says your user-level allow
  rules apply; nothing about a per-task deny list, and there are open reports of
  browser-tool permissions not being honored there), and the worker couldn't hash their
  prompt or kill them on a hang. So this version doesn't use one. Instead, Windows Task
  Scheduler runs the worker, and the worker starts the session itself: the `claude`
  command in print mode with `--chrome`, the pinned settings file
  `cain/docs/pc-worker/session-settings.json` (`--settings`), the same allow and deny
  lists on the command line, and no MCP servers but Claude in Chrome. The settings deny
  every shell (Bash, PowerShell), every file tool (Read, Write, Edit and the rest), web
  fetch and web search; they allow only Claude in Chrome's reading tools. The model
  reads its instruction from its prompt and prints its report: it reads and writes no
  file at all. Before each run the worker hashes that settings file and the session
  prompt (`session-prompt.md`) and fails closed (`untrusted_config`) if either differs
  from what `confirm-profile` pinned.
  **Not enforced until your deny check passes:** whether Claude Code honors those deny
  rules with Claude in Chrome on your PC can't be checked from here. The supervised probe
  checks it (a second session is asked to run a shell command, write a file and fetch a
  page; none of it may happen). Until that check has passed and you have set
  `"unattended": true` in your install config, an unattended run is not read-only by
  enforcement, so the worker does nothing unattended (`attended_only`): v1 runs attended,
  with you watching (`worker.ts run --attended`).
- **The browser tools: restricted per session, by tool name, as far as the extension
  allows.** Allowed: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `read_page`,
  `get_page_text`, `find`. Denied: `computer` (clicks, typing and screenshots are one tool
  in Claude in Chrome, so screenshots go too), `form_input`, `javascript_tool`, uploads,
  shortcuts, console and network reads. Every result records the tools the session was
  allowed (`tools`). Limits: these names are the extension's and aren't verified from
  here (a tool the extension renames is simply not allowed, so it fails closed);
  `navigate` can still load any address, and a site that changes something on a plain
  page load would be changed (the pinned address is checked at the start and the end,
  not every step). Keep no broad Claude in Chrome or shell allow rules in your own
  `~/.claude/settings.json`: user allow rules add to the session's. The same attended
  requirement holds until the deny check passes.

## Set up once, at your PC

Everything lives in one worker folder, `C:/pc-worker` here (any folder works; the paths
below assume this one).

1. **The worker folder, locked.** Create `C:/pc-worker` and give write access to you,
   SYSTEM and Administrators only: `icacls C:\pc-worker /inheritance:r /grant:r
   "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"`. Every run reads
   the ACLs (Get-Acl) of the folder, `install.json`, `allowlist.json`, `owner.pub` and
   `confirmed.json`, and fails closed (`untrusted_files`) if anyone else can write one.
2. **The queue repo.** Create a private GitHub repo `HyndeSyte/pc-jobs` (another name
   works: set `pc_jobs_repo` in Cain's App options to match). Put one file in it as its
   first commit: `cain/docs/pc-worker/queue-template/.gitattributes`, which makes every
   structured file text with LF line endings (`*.json text eol=lf`, and the same for
   `.md`, `.txt` and the file itself), so a Windows checkout never drifts to CRLF and
   files stay mergeable. Signatures and hashes are over canonical bytes anyway. The
   worker refuses a queue without it, or with the old `* -text`.
3. **Cain's token.** A fine-grained token for that one repo, Contents read and write,
   into `pc_jobs_token` in Cain's App options.
4. **The PC's key, noninteractive.** `ssh-keygen -t ed25519 -N "" -f
   C:/pc-worker/pc-jobs-key` (no passphrase: nobody is there to type one), add the
   public half in the repo's web page (Settings, Deploy keys, Add deploy key, with
   write access). Trust GitHub's host key once, by hand: `ssh-keyscan github.com >>
   C:/pc-worker/known_hosts`, and check its fingerprint against the one GitHub publishes
   (docs.github.com, "GitHub's SSH key fingerprints"). Then clone with both pinned:
   `git clone -c core.sshCommand="ssh -i C:/pc-worker/pc-jobs-key -o
   UserKnownHostsFile=C:/pc-worker/known_hosts -o StrictHostKeyChecking=yes -o
   BatchMode=yes" git@github.com:HyndeSyte/pc-jobs.git C:/pc-worker/queue`. BatchMode
   means git fails instead of waiting on a prompt nobody will answer.
5. **Your allowlist key and allowlist.** The allowlist says which read-only action, on
   which site, at which address, the PC may run. Make the key once, in a terminal of
   your own: set `PC_OWNER_PASSPHRASE` to a passphrase only you know, run `bun <harness
   tools>/cain/rootfs/opt/cain/pcjobs/worker.ts owner-keygen --kid owner-1 --out <a
   folder outside C:/pc-worker>`, and put the line it prints into
   `C:/pc-worker/owner.pub`. Copy `cain/docs/pc-worker/allowlist.entries.example.json`,
   name the site and its settings address (`match` is `exact`, or `prefix` for an
   address and everything under it; the probe uses the first `exact`
   `read_account_settings` entry), and list where the site sends a signed-out visitor:
   `login_hosts` (a host, or `.host` for it and everything under it) and `login_paths`
   (a path, or a prefix ending in `*`). An address there is `needs_login`, not
   `url_drift`. Sign it: `worker.ts sign-allowlist <entries.json> --key
   <folder>/owner-key.pem --kid owner-1 --out C:/pc-worker/allowlist.json`. The key is
   passphrase-protected and stays outside the worker folder.
6. **Cain's public Ship key.** The line "Ship key (public): ..." in Cain's App log, as
   `link-1 <key>` in `C:/pc-worker/ship.pub`. Nothing uses it yet; the confirm path will.
7. **The dedicated Chrome profile.** Start a separate Chrome on its own folder:
   `chrome.exe --user-data-dir=C:/pc-worker/chrome --profile-directory=Default`. Name
   its profile **Cain jobs**, sign in there only to the sites the jobs need (never your
   daily profile, nothing financial, not your main mail), and install Claude in Chrome
   **only in this profile**. Turn off sync in this profile (chrome://settings/syncSetup),
   so the extension and its settings never reach another profile; every run scans your
   other Chrome folders (at least the default one) and fails closed
   (`extension_elsewhere`) if the extension is installed or listed in any of them. In
   the extension's details (chrome://extensions), turn on **Allow access to file URLs**
   here and nowhere else: the per-run canary is a page in the worker folder. Open the
   probe site once and approve it in the extension's site permissions.
8. **The install config.** Copy `cain/docs/pc-worker/install.example.json` to
   `C:/pc-worker/install.json`, once, and fill in: `owner_fpr` (the output of
   `worker.ts owner-fpr C:/pc-worker/owner.pub`: every run checks `owner.pub` against
   it, `untrusted_config` if not), `claude` (the full path of `claude.exe`),
   `session_minutes` (the browser step's hard time limit, at most 21), the profile
   (its folder, profile directory, name **Cain jobs**, the extension's id from
   chrome://extensions with Developer mode on, and Chrome's path so the worker can start
   it), and any other Chrome folders to scan (`other_user_data_dirs`). Leave
   `unattended` and `diagnostics` false and `confirm_path` false. The worker never writes
   this file.
9. **Power.** Windows power settings: the PC should never sleep while plugged in, and
   the lock screen doesn't put the PC to sleep (the worker runs while the screen is
   locked, not while the PC sleeps).
10. **The supervised probe: the only way to the first confirmation.** Not a queued job:
    nothing in the queue runs, and nothing is pushed. With you watching, in a terminal:
    `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts probe --attended --home
    C:/pc-worker` (add `--diagnose` for the diagnostic capture, below). It:
    - checks the install config, the files' ACLs, the owner key's fingerprint and the
      allowlist's signature, and refuses to start if a `STOP` file is in place;
    - exercises STOP: puts a `STOP` file in place, checks the preflight stops on it, and
      takes it away;
    - exercises a deliberately failed preflight: the same profile checks against a wrong
      extension id must fail closed;
    - runs the real preflight, skipping only the missing confirmation, then one browser
      step on one fixed target: the first exact settings address of your allowlist. Watch
      that Claude in Chrome acts in the Cain jobs window and nowhere else, reads the
      canary page first, and only reads;
    - runs the deny check: a second session is asked to run a shell command, write a
      file and fetch a page, and none of it may happen.
    It saves `probe-evidence.json`: the time, the target, whether STOP worked, the failed
    preflight's code, the browser step's code, whether the canary came back, whether the
    deny check passed, the profile's fingerprint (the user data folder, the profile's
    name, the extension's id and version, Chrome's major version), the hashes of the
    session's settings and prompt, the canary page's name and the allowed tools.
    If it looks right, run `worker.ts confirm-profile --home C:/pc-worker` within a day.
    It records that evidence in `confirmed.json` if STOP worked, the failed preflight
    failed, the canary came back, the browser step reached the site (`ok`,
    `needs_login` or `already_gone`) and the profile and both files still match.
    **What invalidates it:** any change to the profile's fingerprint (`profile_changed`:
    a Chrome or extension update included), to the session's settings or prompt
    (`untrusted_config`: a harness tools update that changes either), or to the owner
    key. Then run the probe and `confirm-profile` again. If the session can't reach
    Claude in Chrome at all, the fallback is Remote Control on the PC; that isn't built.
11. **Attended runs, then (maybe) unattended.** Tell Cain the queue is ready; he queues a
    first job (`cain/docs/pc-worker/probe-job.json` shows one). Run `worker.ts run
    --attended --home C:/pc-worker` while you watch. Only once the probe's deny check
    passed may you set `"unattended": true` in `install.json`; then add a Windows Task
    Scheduler task, every 15 minutes, "Run only when user is logged on", running `bun
    <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts run --home C:/pc-worker`.
    Without both, a scheduled run does nothing (`attended_only`).

The Windows CI job (`pcjobs-windows`) runs these tests on Windows and is green, but it
is not a required check: only the repository's rulesets can make it one, and changing
them takes admin rights a build session doesn't have.

## Watching it, and stopping it

- **Kill switch:** create a file named `STOP` in `C:/pc-worker`. The worker exits at
  once on its next run, without claiming anything or starting a session. Delete it to
  resume.
- **The heartbeat:** `C:/pc-worker/heartbeat.json` holds the last run's time (the PC's
  own clock), its reason code, its job id, whether it cleared a stale lock
  (`stale_lock`) and how far the Pi's clock was seen ahead (`skew_ms`);
  `C:/pc-worker/worker.log` holds one line per run, codes and ids only. The same
  heartbeat goes to the queue repo (`worker/heartbeat.json`) when its code changes, or
  once a day, so Cain can say the PC is alive and why it isn't working.
- **Diagnostics, for the first probes:** `--diagnose` (or `"diagnostics": true` in the
  install config) appends one line per run to `C:/pc-worker/diagnostics.log`, outside
  the queue repo: the code, the final address with its digits masked, and the name of
  the field that failed validation. Never page text. Off by default.
- **Hangs:** the browser step has a hard time limit (`session_minutes`). When it runs
  out the worker kills the session and every process under it, and the job fails as
  `browser_timeout`. A lock whose process is gone, or older than a lease, is from a run
  that died; the next run clears it and says so in the heartbeat.
- **Failure reasons are codes**, never page text or error text:
  `browser_unreachable` (Chrome isn't running on the profile folder, or the extension
  didn't answer), `wrong_profile` (the profile's name or the extension in it isn't as
  set up, or the canary didn't come back), `profile_changed` (the fingerprint differs
  from the confirmed one), `extension_elsewhere`, `profile_unconfirmed` (no
  `confirm-profile` yet), `untrusted_config` (install config unreadable, owner key
  not the pinned one, or the session's settings or prompt changed), `untrusted_files`,
  `attended_only`, `clock_skew`, `browser_timeout`, `queue_misconfigured` (the
  `.gitattributes`), `git_failed`, `busy` (another run holds the lock), `stopped`.

The worker can't ask Claude in Chrome which profile it is attached to: it doesn't say.
So it checks what it can: the profile's fingerprint, the extension installed nowhere
else, and the per-run canary: a fresh value the worker writes to a page in the worker
folder, which the model must read back as its first browser step. Only the dedicated
profile's extension may open file pages, so a session in another profile can't read it,
and the run fails as `wrong_profile`.

## How a job runs

1. `worker.ts run` (by hand with `--attended`, or by Task Scheduler once allowed): kill
   switch, lock, install config, the files' ACLs, the owner key's fingerprint,
   `git pull`, the `.gitattributes` check, the clock check, then it closes what can't
   run (cancelled, not read-only, off the signed allowlist), runs the browser preflight,
   claims the oldest job left with a new attempt id and a 30 minute lease, and pushes.
2. It writes the canary page and starts the browser session with one narrow
   instruction in its prompt: site, action, start address, what to look for, the typed
   facts it may report, the outcomes it may say and the canary page.
3. When the session ends (or its time limit kills it), the worker checks the job is
   still its own (same attempt, not cancelled, and well inside the lease by its own
   monotonic clock; otherwise it writes nothing), checks the report and writes the
   result: the canary, the final address reduced to scheme, host and path and checked
   against the allowlist's pin (trailing slashes and case don't matter; a sign-in
   address is `needs_login`), the facts checked against the action's types (dates in
   the common forms made YYYY-MM-DD). Then it commits and pushes, with retries for
   transient file locks.

**One clock per decision.** The keeper's clock decides expiry, on the Pi: it closes a
pending job past its expiry (`expired`) and a claim whose lease ran out
(`lease_expired`; in doubt for anything but a read), allowing two minutes of skew. The
worker's own monotonic clock decides how long its run may hold a claim, so a wall clock
jump on the PC doesn't matter. The worker leaves alone a job within the skew of its
expiry, and measures how far the Pi's clock runs ahead of its own (the keeper's newest
commit and job time can't be in the PC's future): past two minutes it stops
(`clock_skew`). A PC clock running ahead can't be measured this way; the keeper's own
expiry covers that side.

Every check is in code (`cain/rootfs/opt/cain/pcjobs/`).

## Results, states and hand-offs

A result holds a status, a reason code, maybe a hand-off, the attempt id, the writer's
clock, the final address (scheme, host and path only), up to 8 typed facts, the
browser tools the session was allowed and whether you ran it attended. Never page
text, screenshots, mail or raw errors: extra fields or free text fail the job with
`result_rejected`, and none of it is written. Results are data, never instructions:
Cain reads them as facts, and nothing in one tells him or the worker what to do.

- Hand-offs (the job waits on you): `needs_login` (signed out, a re-authentication or a
  second factor asked), `blocked_captcha`, `pending_email_confirmation`. `already_gone`
  counts as done.
- Failures, each its own code: `browser_unreachable`, `wrong_profile`,
  `browser_timeout`, `url_drift` (the final address is off the allowlist's pin and not
  a sign-in page), `result_rejected`, `page_not_as_expected`, `lease_expired` (a read
  that never reported), and refusals: `not_allowlisted`, `allowlist_unverified`,
  `action_not_read_only`, `expired`.
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
  `final_url`, `facts`, `tools`, `attended`.
- `cancels/<id>.json` (Cain), `nonces/<nonce>.json` (the confirm path, unused),
  `worker/heartbeat.json` (the worker), `.gitattributes` (`*.json text eol=lf` and the rest).
- The PC's allowlist, `allowlist.json`: `{"v": 1, "kid", "allow": [{"site", "action",
  "url", "match", "login_hosts"?, "login_paths"?}], "sig"}`, signed with your key;
  `owner.pub`: `<kid> <public key>`, matching `owner_fpr` in `install.json`.
- On the PC only: `install.json` (yours), `confirmed.json` and `probe-evidence.json`
  (the probe and `confirm-profile`), `heartbeat.json`, `worker.log`, `diagnostics.log`.

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
of it runs: `confirm_path` must be false in this version, and no command reaches it.

Cain writes new jobs and cancels through his keeper, which holds the token, and the
keeper's clock closes what expired; the PC writes claims, results and its heartbeat with
its deploy key. Nothing else writes the repo.
