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
  install config, which this version only accepts as `false`. The nonce spend lives in
  `pcjobs/confirm.ts`, which `worker.ts` doesn't import; a test holds every worker
  command to that.
- **The whole session is pinned, in code.** Windows Task Scheduler (or you, by hand)
  runs the worker, and the worker starts the session itself: the `claude` command in
  print mode with `--chrome`, the pinned settings file
  `cain/docs/pc-worker/session-settings.json` (`--settings`) and no other settings
  source (`--setting-sources ""`: none of user, project or local), the same allow and
  deny lists on the command line, `--strict-mcp-config` with no MCP servers but Claude in
  Chrome, from an empty folder, with the CLI's autoupdater off (`DISABLE_AUTOUPDATER=1`
  in its environment). Claude Code still reads managed settings whatever the flags say,
  so before every run the worker also reads your user settings
  (`~/.claude/settings.json`, or under `CLAUDE_CONFIG_DIR`), the session folder's
  project and local settings, the managed settings files and your user memory file
  (`~/.claude/CLAUDE.md`). It fails closed (`untrusted_config`) if any of those settings
  holds hooks, permission allow rules or a permission-skipping default mode, can't be
  read as JSON, or if the memory file isn't empty. It hashes the settings file, the
  session prompt and those outside files into the confirmation and fails closed
  (`untrusted_config`) if any of them changes. The settings deny every shell, every file
  tool, web fetch and web search, and allow only Claude in Chrome's reading tools. The
  model reads its instruction from its prompt and prints its report: it reads and writes
  no file at all. Not checked: Windows registry policies for Claude Code and a
  `managed-settings.d` folder, if your version reads them; keep none.
- **What the session was given is read from its own output, every run.** The session
  prints print mode's event stream (`--output-format stream-json`): the tools it was
  given, each tool call and its result, the permission denials. A run whose session
  didn't reach the extension fails as `extension_unreachable`; one given any Claude in
  Chrome tool besides the allowed ones, missing one, or given a denied tool fails as
  `tool_inventory`.
- **The browser tools: restricted by name.** Allowed: `tabs_context_mcp`,
  `tabs_create_mcp`, `navigate`, `read_page`, `get_page_text`, `find`. Denied (and so
  removed from the session's tools): `computer` (clicks, typing and screenshots are one
  tool in Claude in Chrome, so screenshots go too), `form_input`, `javascript_tool`,
  `upload_image`, `file_upload`, `shortcuts_execute`, `read_console_messages`,
  `read_network_requests`. The names are the extension's; a tool it renames is simply
  not allowed, and the inventory check fails the run.
- **Navigation is bounded outside the model.** The pinned settings run the worker's
  navigation guard (`worker.ts nav-guard`, a PreToolUse hook) before every `navigate` and
  `tabs_create_mcp` call. It lets through only the exact addresses the worker hands it
  for that run: the canary page, the job's pinned start address and the run's end page.
  Another host, a `javascript:` or `data:` address, or the pinned address written another
  way is refused before the extension sees it. On top of that, the dedicated profile's
  extension has site access only to the allowlisted hosts, their sign-in hosts and the
  canary's `http://127.0.0.1` (setup step 7). What it can't stop: a site's own redirects
  (a sign-in redirect is expected, and the final address is checked against the pin),
  and a plain page load that changes something. **A GET on an allowlisted site can still
  have effects:** a logout link, an unsubscribe link, a "confirm" link in a mail. So pin
  exact addresses where you can (`match: "exact"`), and never allowlist an address that
  acts when opened.
- **Not enforced until your PC's probe passes.** Whether Claude Code honors the deny
  rules and the hook with Claude in Chrome on your PC can't be checked from here. The
  supervised probe checks it (below). Until its deny check has passed and you have set
  `"unattended": true` in your install config, the worker does nothing unattended
  (`attended_only`): v1 runs attended, with you watching (`worker.ts run --attended`). A
  new Claude in Chrome or `claude` version voids that pass: unattended runs stop
  (`probe_stale`) until the probe is run again; attended runs go on.

## Set up once, at your PC

Everything lives in one worker folder, `C:/pc-worker` here (any folder works; the paths
below assume this one).

1. **The worker folder, locked.** Create `C:/pc-worker`. Its ACL may give write only
   to SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`) and your own account, by SID,
   and no write entry may be inherited. In a terminal of your own (not elevated):
   - `icacls C:\pc-worker /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "%USERNAME%:(OI)(CI)F"`
     (turns inheritance off on the folder, dropping every inherited entry, and grants
     those three full control);
   - `icacls C:\pc-worker /remove:g "*S-1-5-11" "*S-1-5-32-545" "*S-1-1-0" "*S-1-3-0"`
     (strips Authenticated Users, Users, Everyone and CREATOR OWNER if any are left);
   - once `install.json`, `allowlist.json` and `owner.pub` are in place (steps 5 and 8),
     `icacls C:\pc-worker\install.json /inheritance:d`, and the same for
     `allowlist.json` and `owner.pub` (each file keeps the folder's three entries as its
     own, not inherited). The worker does this itself for `confirmed.json`.
   - check with `icacls C:\pc-worker\install.json`: only `NT AUTHORITY\SYSTEM`,
     `BUILTIN\Administrators` and you, none marked `(I)`.
   Every run reads the ACLs of the folder, `install.json`, `allowlist.json`, `owner.pub`
   and `confirmed.json` by SID (Get-Acl, each identity translated to its SID), and fails
   closed (`untrusted_files`) if anyone else can write one, if a write entry is
   inherited, or if an ACL can't be read.
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
   `url_drift`. Addresses keep URL semantics: only the host's case and a default port
   are normalized, so a different path case, a trailing slash or a query is a different
   address (`url_drift`). If a site really serves the same page several ways, add
   `"alternatives": true` to that entry (signed with the rest): then path case, a
   trailing slash and a query don't matter for it. Sign it: `worker.ts sign-allowlist <entries.json> --key
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
   (`extension_elsewhere`) if the extension is installed or listed in any of them, or
   (`profile_scan_failed`) if a profile's preferences can't be read the way Chrome lays
   them out. Then, in chrome://extensions, Claude, Details:
   - **Site access: On specific sites.** Add each allowlisted site's host
     (`https://example.com`), each of its sign-in hosts (`https://accounts.example.com`),
     and `http://127.0.0.1` (the canary page the worker serves). Nothing else.
   - Leave **Allow access to file URLs** off: the canary is served over HTTP now, and the
     extension needs no file access.
   - Approve the probe site once in the extension's own site permissions.
   **This Chrome must be open on this profile before each run.** The worker never starts
   Chrome (a Chrome started under the session would die with it on a timeout); a run
   without it is `browser_unreachable`, and claims nothing.
8. **The install config.** Copy `cain/docs/pc-worker/install.example.json` to
   `C:/pc-worker/install.json`, once, and fill in: `owner_fpr` (the output of
   `worker.ts owner-fpr C:/pc-worker/owner.pub`: every run checks `owner.pub` against
   it, `untrusted_config` if not), `claude` (the full path of `claude.exe`),
   `session_minutes` (the browser step's hard time limit, at most 21), the profile
   (its folder, profile directory, name **Cain jobs**, and the extension's id from
   chrome://extensions with Developer mode on), and any other Chrome folders to scan
   (`other_user_data_dirs`). Leave
   `unattended` and `diagnostics` false and `confirm_path` false. The worker never writes
   this file.
9. **Power.** Windows power settings: the PC should never sleep while plugged in, and
   the lock screen doesn't put the PC to sleep. Your user settings and memory file:
   no hooks, no permission allow rules and no permission-skipping mode in
   `~/.claude/settings.json`, and `~/.claude/CLAUDE.md` empty or absent (the worker
   fails closed otherwise, `untrusted_config`).
10. **The supervised probe: the only way to the first confirmation.** Not a queued job:
    nothing in the queue runs, and nothing is pushed. With the Cain jobs Chrome open and
    you watching, in a terminal: `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts
    probe --attended --home C:/pc-worker` (add `--diagnose` for the diagnostic capture,
    below). In order, it:
    - checks the install config, the files' ACLs, the owner key's fingerprint and the
      allowlist's signature, and refuses to start if a `STOP` file is in place;
    - exercises STOP: puts a `STOP` file in place, checks the preflight stops on it, and
      takes it away;
    - runs the **smoke step**: a short session (at most 2 minutes) that calls
      `tabs_context_mcp` and reads the canary page back. It stops there with a plain
      reason instead of a timeout: `extension_unreachable` ("no browser connected", the
      tab-context call didn't answer, or no session at all), `wrong_profile` (a browser
      answered but couldn't open or read the canary: another profile, or no site access
      to `http://127.0.0.1`), or `tool_inventory` (the tools the session was actually
      given, with the missing and extra names);
    - exercises a deliberately failed preflight: the same profile checks against a wrong
      extension id must fail closed;
    - runs the real preflight, skipping only the missing confirmation, then one browser
      step on one fixed target: the first exact settings address of your allowlist. Watch
      that Claude in Chrome acts in the Cain jobs window and nowhere else, opens the
      canary page first, and only reads;
    - runs the **deny check** on a probe page the worker serves: a session is ordered to
      try each denied capability (a shell command, a file write, a web fetch; on the page
      a click, typing, a form fill, JavaScript, a console read, a network read, an upload
      and a keyboard shortcut) and to open three addresses it may not (another host, a
      `javascript:` address and a `data:` address). Each must be refused, and the
      evidence must show the refusal came from permissions: the tool wasn't among the
      session's tools, print mode recorded a permission denial, or the navigation guard
      refused it. The page's bait (a button, a field, a form, a file field, a key
      listener) calls back to the worker if used, and the console line and network
      request carry secrets that must not come out: any of that fails it.
    It saves `probe-evidence.json`: the time, the target, STOP, the smoke step, the
    failed preflight's code, the browser step's code, whether the canary came back, the
    tool inventory the session saw and whether it matched, the deny check line by line
    (each capability, its tools, what refused it, whether it was used) and per
    navigation, any bait that called back, the profile's fingerprint (the user data
    folder, the profile's name, the extension's id and version, Chrome's major version,
    the `claude` command's version), the hashes of the session's settings, prompt and
    outside settings, and the allowed tools.
    If it looks right, run `worker.ts confirm-profile --home C:/pc-worker` within a day.
    It records that evidence in `confirmed.json` if STOP worked, the smoke step
    connected, the failed preflight failed, the canary came back, every inventory
    matched, the browser step reached the site (`ok`, `needs_login` or `already_gone`)
    and the fingerprint and every hash still match. The deny check's result is recorded
    as it was: a failed one leaves runs attended only.
    **What invalidates it:** a change of the profile folder, its name, the extension's
    id or Chrome's major version (`profile_changed`); of the session's settings or
    prompt, your user, local or managed settings or memory file, or the owner key
    (`untrusted_config`). A new extension or `claude` version voids the deny check's
    pass (`probe_stale` for unattended runs). Then run the probe and `confirm-profile`
    again.
    **Supported versions** are the ones your last passing probe recorded: its
    `fingerprint` names the Claude in Chrome version (`extension_version`) and the
    `claude` command's version (`cli_version`). Nothing else is supported unattended.
    **When a stage fails:**
    - no extension (`extension_unreachable`): the Cain jobs Chrome isn't open, Claude in
      Chrome isn't paired with the `claude` command, or `--chrome` didn't connect.
    - unexpected tool inventory (`tool_inventory`): the extension or CLI renamed, added
      or dropped a tool, or a setting outside the pinned file still applies. Read the
      names it printed; a renamed allowed tool needs a code change.
    - wrong profile or canary (`wrong_profile`): another Chrome profile answered, or the
      extension has no site access to `http://127.0.0.1`.
    - deny failure (`deny_check: false`): read the `deny` and `navigation` lines; a
      capability with `refused_by: null`, `used: true` or a navigation with `passed:
      false` was not refused by permissions. Don't turn on unattended.
    - timeout (`browser_timeout`): the session hung past `session_minutes`; the worker
      killed it and everything under it, and left Chrome running.
11. **Attended runs, then (maybe) unattended.** Tell Cain the queue is ready; he queues a
    first job (`cain/docs/pc-worker/probe-job.json` shows one). With the Cain jobs Chrome
    open, run `worker.ts run --attended --home C:/pc-worker` while you watch. Only once
    the probe's deny check passed: add a Windows Task Scheduler task, every 15 minutes,
    set to **Run only when user is logged on** (the session needs your desktop and your
    open Chrome), running `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts run
    --attended --home C:/pc-worker`, and run it once from Task Scheduler in the desktop
    state you intend (screen locked or not), watching the result and the heartbeat.
    Only after that separate test passes, set `"unattended": true` in `install.json` and
    drop `--attended` from the task. Without both, a scheduled run does nothing
    (`attended_only`).

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
  out the worker kills the `claude` command and every process under it (`taskkill /T
  /F` on Windows, the process group elsewhere), and the job fails as `browser_timeout`.
  Chrome is not under it and keeps running. The run's own tab normally closes itself at
  the end (the model opens the run's end page, which closes the tab); after a timeout it
  stays open. The lock holds the run's PID and that process's start time: a lock whose
  process is gone, whose PID now belongs to a process started at another time, or older
  than a lease, is from a run that died; the next run clears it and says so in the
  heartbeat.
- **Failure reasons are codes**, never page text or error text:
  `browser_unreachable` (the Cain jobs Chrome isn't open on its profile folder),
  `extension_unreachable` (the session didn't reach Claude in Chrome), `tool_inventory`
  (the session's tools weren't the pinned ones), `wrong_profile` (the profile's name or
  the extension in it isn't as set up, the `claude` command's version can't be read, or
  the canary didn't come back), `profile_changed` (the profile's identity differs from
  the confirmed one), `probe_stale` (a new extension or `claude` version since the
  probe: unattended runs wait for a new probe), `extension_elsewhere`,
  `profile_scan_failed`, `profile_unconfirmed` (no `confirm-profile` yet),
  `untrusted_config` (install config unreadable, owner key not the pinned one, the
  session's settings or prompt changed, or settings outside them hold hooks or allow
  rules or changed), `untrusted_files`, `attended_only`, `clock_skew`,
  `browser_timeout`, `queue_misconfigured` (the `.gitattributes`), `git_failed`,
  `busy` (another run holds the lock), `stopped`.

The worker can't ask Claude in Chrome which profile it is attached to: it doesn't say.
So it checks what it can: the profile's fingerprint, the extension installed nowhere
else, and the per-run canary. For each run the worker serves one page on `127.0.0.1`,
on a port the system picks, at a path that is a fresh token, for that run only. The page
holds a fresh value, the extension id you pinned and the run's attempt id; the model
must open it first and read all three back, and the worker must have seen the page
fetched. Only the dedicated profile's extension has site access to `http://127.0.0.1`,
so a session in another profile can't read it, and the run fails as `wrong_profile`.

## How a job runs

1. `worker.ts run` (by hand with `--attended`, or by Task Scheduler once allowed): kill
   switch, lock, install config, the files' ACLs, the owner key's fingerprint,
   `git pull`, the `.gitattributes` check, the clock check, then it closes what can't
   run (cancelled, not read-only, off the signed allowlist), runs the browser preflight,
   claims the oldest job left with a new attempt id and a 30 minute lease, and pushes.
2. It serves the canary page and starts the browser session with one narrow
   instruction in its prompt: site, action, start address, what to look for, the typed
   facts it may report, the outcomes it may say, the canary page and the end page. The
   navigation guard lets the session open those three addresses and nothing else.
3. When the session ends (or its time limit kills it), the worker checks the job is
   still its own (same attempt, not cancelled, and well inside the lease by its own
   monotonic clock; otherwise it writes nothing), checks the report and writes the
   result: the session's tools and connection from its stream, the canary, the final
   address checked against the allowlist's pin as reported (path case, a trailing slash
   and a query count unless the entry allows alternatives; a sign-in address is
   `needs_login`) and then reduced to scheme, host and path, the facts checked against the action's types (dates in
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
- Failures, each its own code: `browser_unreachable`, `extension_unreachable`,
  `tool_inventory`, `wrong_profile`, `browser_timeout`, `url_drift` (the final address is off the allowlist's pin and not
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
  "url", "match", "login_hosts"?, "login_paths"?, "alternatives"?}], "sig"}`, signed with your key;
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
