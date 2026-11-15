# PC jobs: chores that need a browser signed in as you

Cain has no browser and no site logins. Some chores need one: read an account settings
page, check whether an old login still works, later close an account. Those go through
a small job queue. Cain writes a job; the worker on your PC (`worker.ts`) claims it,
starts a locked browser session of Claude in Chrome in a Chrome profile of its own,
checks what that session saw and writes back a short result. Cain reads the result and
tells you what matters.

## What is enforced, and what is not

The guarantee, in one line:
**restricted browser tools against owner-approved addresses**.
It is not side-effect-free browsing: a page on an address you approved can still act
when it loads (below).

- **Read-only actions, in code.** The worker refuses any job whose action isn't in a
  fixed read-only set, and your signed allowlist can only name those actions.
  Irreversible jobs (closing an account, cancelling a subscription) are
  refused until the confirm path ships, on the PC and by Cain's keeper alike. The confirm path's code
  (job tokens, nonces, the live-page gate) is there but behind `confirm_path` in your
  install config, which this version only accepts as `false`. The nonce spend lives in
  `pcjobs/confirm.ts`, which `worker.ts` doesn't import; a test holds every worker
  command to that.
- **The whole session is pinned, in code.** Windows Task Scheduler (or you, by hand)
  runs the worker, and the worker starts the session itself, straight from an argument
  list and never through a shell (on Windows `claude` must be `claude.exe`, not a
  `.cmd` or `.ps1` wrapper): the `claude` command in print mode with `--chrome`, the
  pinned settings file `cain/docs/pc-worker/session-settings.json` (`--settings`) and no
  other settings source (`--setting-sources ""`: none of user, project or local), the
  same allow and deny lists on the command line, `--strict-mcp-config` with no MCP
  servers but Claude in Chrome, from an empty folder. The session's environment is an
  allowlist: the Windows variables the `claude` command and Git Bash need, named one by
  one (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `SystemRoot`,
  `SystemDrive`, `TEMP`, `TMP`, `PATH`, `PATHEXT`, `COMSPEC`, and a few like `WINDIR`
  and `USERNAME`), `DISABLE_AUTOUPDATER=1` set by the worker itself whatever your own
  environment says, and how the hook runs the worker; nothing else of yours, no API key:
  sign the `claude` command in once with its own login. Of Claude Code's own variables
  only `CLAUDE_CODE_GIT_BASH_PATH` passes, and only when it is an absolute path to a
  `bash.exe` that exists. The worker fails closed (`untrusted_config`) if its own
  environment sets `CLAUDE_CONFIG_DIR`, an API base address (`ANTHROPIC_BASE_URL` and the
  like), any other `CLAUDE_CODE_*` variable, or a `CLAUDE_CODE_GIT_BASH_PATH` it can't
  vouch for (so don't start it from inside a Claude Code session), and hashes the
  session's environment into the confirmation.
- **The CLI and the extension can't change under a run.** The worker hashes the
  `claude` executable before and after each session and fails the run (`cli_changed`)
  if the two differ, or if it can't be read. Where the session's init data carries the
  extension's version, it must match the version installed on disk in the dedicated
  profile, or the run fails (`extension_version_mismatch`); the probe's smoke step says
  so too, with both versions. A version the probe hasn't confirmed stops every run
  anyway (`probe_stale`, below).
- **Settings from anywhere else, checked every run.** Claude Code still reads managed
  settings whatever the flags say, so before every run the worker also reads your user
  settings (`~/.claude/settings.json`), the session folder's project and local settings,
  the managed settings files and your user memory file (`~/.claude/CLAUDE.md`). It fails
  closed (`untrusted_config`) if any of those settings holds hooks, permission allow
  rules or a permission-skipping default mode or can't be read as JSON; if the memory
  file isn't empty; if a `CLAUDE.md`, `CLAUDE.local.md` or `.claude/CLAUDE.md` sits in
  the session folder or any folder above it, the worker folder included; if a managed
  settings drop-in folder (`managed-settings.d`, next to either managed settings file)
  exists; or if the Claude Code policy registry key (`HKLM` or `HKCU`
  `SOFTWARE\Policies\ClaudeCode`) exists. It hashes the settings file, the session
  prompt, those outside files and the session's environment into the confirmation and
  fails closed if any of them changes. The model reads its instruction from its prompt
  and prints its report: it reads and writes no file at all.
- **What the session was given is read from its own output, every run.** The session
  prints print mode's event stream (`--output-format stream-json`): the tools it was
  given, its MCP servers, each tool call and its result, the permission denials. A run
  whose session didn't reach the extension fails as `extension_unreachable`; one given
  any Claude in Chrome tool besides the allowed ones, missing one, given a denied tool,
  or with any MCP server but Claude in Chrome's fails as `tool_inventory`.
- **The browser tools: restricted by name, pinned in code.** The four reading tools,
  each by its exact name: `tabs_context_mcp` (the tabs in Claude's group and their
  addresses), `read_page` (a page's structure), `get_page_text` (its text) and `find` (a
  search in it). Two that open an address, and only the run's own: `navigate` and
  `tabs_create_mcp`. Nothing that reads the console or the network, and nothing that runs
  script: a test fails if that classification changes. Denied (and so
  removed from the session's tools): `computer` (clicks, typing and screenshots are one
  tool in Claude in Chrome, so screenshots go too), `form_input`, `javascript_tool`,
  `upload_image`, `file_upload`, `shortcuts_execute`, `read_console_messages`,
  `read_network_requests`. The names are the extension's; a tool it renames is simply
  not allowed, and the inventory check fails the run.
- **What may leave the PC: typed fields only, no page text.** The model's report is
  capped (2000 characters in all, 300 per field) and checked field by field; what the
  worker writes to the queue repo is a result of fixed fields: a status, a reason code,
  maybe a hand-off, the final address reduced to scheme, host and path, and a few facts,
  each typed for its action (true or false, a word from a list, a date, a short token of
  at most 64 characters; at most 240 for any fact, 8 facts, 3000 bytes for the whole
  file). Page text, the model's words and any browser or git error stay on the PC.
- **Every extension tool call goes through the guard, which fails closed.** The pinned
  settings run `worker.ts nav-guard` as a PreToolUse hook whose matcher is the
  extension's whole prefix (`mcp__claude-in-chrome__.*`). It lets the four reading tools
  through, and a `navigate` or `tabs_create_mcp` only to the exact addresses the worker
  hands it for that session: the canary page, the job's pinned start address and the
  run's end page, which is always the one literal address `about:blank` (allowed and
  logged like the others). Another host, a `javascript:` or `data:` address, the pinned
  address written another way, a tool it doesn't know, a call without a tool-use id:
  refused. Any error inside it, input it can't read, or no input within its 10 second
  deadline (headroom for a cold start of Git Bash and the runtime) is refused too (exit
  code 2 and a deny decision in JSON); its settings timeout (30 seconds) is longer than
  that deadline, so it refuses before Claude Code would give up on it. A test in the
  Windows CI job runs this very hook command line through Git Bash with a sample
  PreToolUse payload: an allowed call, a refused one and malformed input. It logs every decision, keyed by the tool-use id, to `nav-decisions.jsonl`.
  After each session the worker matches every navigation in the session's event stream
  against an allow in that log: a navigation without one went past the guard and fails
  the run (`navigation_unguarded`); a call the guard refused fails it too
  (`navigation_denied`).
- **Destinations, all through the run, not only arguments.** The model's own word on
  where it was doesn't count; the browser's does. From the tab context that shows the
  run's tab at the canary page on, the worker checks every address that tab shows: its
  entry in every tab context, and the address any reading tool's answer on it reports.
  The first one that isn't the pin (under the entry's own rules: exact, prefix,
  alternatives), a sign-in page of the entry, a redirect the entry allows, the canary
  page or the end page fails the run (`unexpected_location`), and nothing of it is
  written but the code (and the address, reduced to scheme, host and path, when it is on
  the job's site). A signed entry may list `redirects`, path prefixes on the pinned
  address's own host, each bounded by a `/` (`"redirects": ["/account/security/"]`). The
  result's final address is the tab's own in the last tab context before the end page. So
  a page that moves its tab off the pin by script, is read there and moves back before
  the end is caught, as well as one that ends off it or a redirect off the pin. Whether
  the extension's reading tools report the tab's address at all is something only the
  probe's `move_and_return` page shows on your PC; the tab contexts are checked either way.
- **Tabs.** The run's tab is the one the tab context lists at the canary page; its id is
  recorded there. Any other tab in a tab context of the run (a popup opened into Claude's
  tab group, a tab you left there) fails the run (`tabs_unexpected`). The reading tools
  can't close a tab and nothing relies on a page closing itself (`window.close`), so the
  run's tab is left on the end page, `about:blank`: the worker records its id
  (`leftover-tabs.json`), reports a `leftover_tab` warning, and the next run takes that
  tab over as its own (it starts at `about:blank`) instead of opening another. The
  dedicated Chrome must have no other tabs in Claude's tab group.
- **The canary is bound to the dedicated profile.** Once at setup, `worker.ts
  bind-profile --attended` has a session open the canary's bind page, which sets a random
  marker as a cookie on `127.0.0.1` in the profile the extension runs in (a cookie, since
  the canary's port changes every run and a cookie's host doesn't include it). The
  worker keeps only the marker's hash (`profile-marker.json`, held like the other trusted
  files). Every run's canary page shows the marker only when the browser sent that
  cookie, and the model must read it back with the other three values; a run without it
  is `wrong_profile`, and so is any run while the profile isn't bound. Another Chrome
  profile has no such cookie, so it can't pass for this one.
- **Chrome elsewhere, on disk and running.** Every preflight scans your other Chrome
  folders for the extension (setup step 7), adds to that scan the folder of any Chrome
  running with another `--user-data-dir`, and checks that every process Chrome started
  for the extension (its native messaging host, which carries
  `chrome-extension://<id>/`) descends from the Chrome running on the dedicated folder.
  One under another Chrome, or under no Chrome the worker can find, is
  `extension_elsewhere`.
- **One Claude Code at a time, and a live bridge.** Before a claim, any other Claude
  Code process on the PC (a session of yours, or one left over) is `chrome_busy`: the
  extension would serve it instead, and the worker's lock can't see it (the extension's
  own native messaging host doesn't count). Then a short bridge check (a tab-context call,
  at most 90 seconds) must reach the extension; if it doesn't, the worker ends any
  leftover native messaging host of the extension (no session is running, so none is in
  use) and checks once more; still nothing is `extension_unreachable`. Either way the job
  stays pending.
- **What a page can still do.** The extension has site access only to the allowlisted
  hosts, their sign-in hosts and the canary's `http://127.0.0.1` (setup step 7). The
  guard can't stop a page's own scripts, a site's redirects or what a plain page load does
  on the server. **A GET on an allowlisted site can still have effects:** a logout link,
  an unsubscribe link, a "confirm" link in a mail. The end check catches a run that ends
  somewhere else, after the fact, not the effect itself. So pin exact addresses where you
  can (`match: "exact"`), and never allowlist an address that acts when opened.
- **Enforced in code, and verified only by the probe.** In code, on every run: the job's
  action, the signed allowlist, the pinned session (flags, settings, prompt, environment,
  outside settings), the tool inventory, the guard's log against every navigation, every
  address the run's tab shows, the tabs, the profile marker, the CLI's hash, the
  extension's version where the session reports it, and the result's shape and caps.
  Only the probe, on your PC, can show that Claude Code honors the deny rules and runs the
  hook with Claude in Chrome, that the hook gets a tool-use id, that the extension's
  answers look the way the worker reads them (tab contexts, addresses on reading tools'
  answers, its version in the init data), that `about:blank` can be opened through the
  extension, and that the guard and the end checks catch what they should there.
- **Not enforced until your PC's probe passes.** Whether Claude Code honors the deny
  rules and the hook with Claude in Chrome on your PC can't be checked from here. The
  supervised probe checks it (below). Until its deny check has passed and you have set
  `"unattended": true` in your install config, the worker does nothing unattended
  (`attended_only`): v1 runs attended, with you watching (`worker.ts run --attended`).
  **A new Claude in Chrome or `claude` version stops every run, attended ones too**
  (`probe_stale`): only the supervised probe runs until it has passed on the new
  versions and `confirm-profile` has recorded them.

## Set up once, at your PC

Everything lives in one worker folder, `C:/pc-worker` here (any folder works; the paths
below assume this one). Neither it nor any folder above it may hold a `CLAUDE.md`,
`CLAUDE.local.md` or `.claude/CLAUDE.md` (every run checks, `untrusted_config`): a
folder at the top of a drive, like `C:/pc-worker`, keeps that simple.

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
   trailing slash and a query don't matter for it. If the site moves you on by itself
   (the settings page redirecting to `/account/security/`), list where in `redirects`:
   path prefixes on the pinned address's own host, each starting with `/` and ending
   with `/` (or an exact path), never `/` alone. A run that ends anywhere else is
   `unexpected_location`. Sign it: `worker.ts sign-allowlist <entries.json> --key
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
   **This Chrome must be open on this profile before each run, with no other tabs in
   Claude's tab group** (leave its one start tab alone; close anything you opened there
   by hand). The worker never starts Chrome (a Chrome started under the session would die
   with it on a timeout); a run without it is `browser_unreachable`, and claims nothing.
   A tab the worker left there itself (the last run's, on `about:blank`) is fine:
   the next run takes it over.
   **Updates.** Chrome updates Claude in Chrome from the Chrome Web Store by itself, and
   offers no way to hold one extension at a version on a personal install (only an
   enterprise policy pointing at a package you host yourself, which this setup doesn't
   use). So expect an extension update now and then: the next run says `probe_stale`,
   and you run the probe and `confirm-profile` again. For the `claude` command, the
   worker sets `DISABLE_AUTOUPDATER=1` in every session's environment itself; set it in
   your own Windows user environment as well, so it changes only when you update it
   yourself. Every update of it is `probe_stale`, and one during a run is `cli_changed`.
8. **The install config.** Copy `cain/docs/pc-worker/install.example.json` to
   `C:/pc-worker/install.json`, once, and fill in: `owner_fpr` (the output of
   `worker.ts owner-fpr C:/pc-worker/owner.pub`: every run checks `owner.pub` against
   it, `untrusted_config` if not), `claude` (the full path of `claude.exe` itself, with
   forward slashes; not a `.cmd` or `.ps1` wrapper),
   `session_minutes` (the browser step's hard time limit, at most 21), the profile
   (its folder, profile directory, name **Cain jobs**, and the extension's id from
   chrome://extensions with Developer mode on), and any other Chrome folders to scan
   (`other_user_data_dirs`). Leave
   `unattended` and `diagnostics` false and `confirm_path` false. The worker never writes
   this file.
9. **Power, settings and environment.** Windows power settings: the PC should
   never sleep while plugged in, and the lock screen doesn't put the PC to sleep. Your user
   settings and memory file: no hooks, no permission allow rules and no
   permission-skipping mode in `~/.claude/settings.json`, and `~/.claude/CLAUDE.md`
   empty or absent. No `managed-settings.d` folder under `C:/Program Files/ClaudeCode`
   or `C:/ProgramData/ClaudeCode`, and no `SOFTWARE\Policies\ClaudeCode` key in the
   registry. No `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_*` in your
   environment, except `CLAUDE_CODE_GIT_BASH_PATH` if Git Bash isn't where `claude` looks
   for it: then the full path of `bash.exe` (`C:\Program Files\Git\bin\bash.exe`), which
   must exist. Sign the `claude` command in once, in a terminal of your own (`claude`,
   then its login): the session gets no API key from your environment. The worker fails
   closed (`untrusted_config`) otherwise.
   **The hook on Windows.** Claude Code runs hooks through Git Bash on Windows (install
   Git for Windows if `claude` asks for it). The hook command is
   `"$PCW_RUNTIME" "$PCW_WORKER" nav-guard`: both variables are set by the worker with
   forward slashes (`C:/Users/you/.bun/bin/bun.exe`), and the double quotes keep a path
   with spaces in one piece. Nothing to set by hand; the probe's smoke step fails with
   `navigation_unguarded` if the hook doesn't run.
10. **Bind the profile, once.** With the Cain jobs Chrome open and no other Claude Code
    running, in a terminal: `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts
    bind-profile --attended --home C:/pc-worker`. A short session opens a page the worker
    serves on `127.0.0.1`, which sets a random marker as a cookie in this profile only,
    then reads it back from the canary page. The worker keeps only its hash, in
    `C:/pc-worker/profile-marker.json` (run `icacls C:\pc-worker\profile-marker.json` to
    check it is held like `install.json`; the worker copies the folder's entries onto it
    itself). Don't clear this profile's cookies for `127.0.0.1`; if you do, or if runs say
    `wrong_profile` after you cleared browsing data, run `bind-profile` again. It prints
    `{"bound": ...}`, or the code that stopped it.
11. **The supervised probe: the only way to the first confirmation.** Not a queued job:
    nothing in the queue runs, and nothing is pushed. With the Cain jobs Chrome open and
    you watching, in a terminal: `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts
    probe --attended --home C:/pc-worker` (add `--diagnose` for the diagnostic capture,
    below). In order, it:
    - checks the install config, the files' ACLs, the owner key's fingerprint and the
      allowlist's signature, and refuses to start if a `STOP` file is in place;
    - exercises STOP: puts a `STOP` file in place, checks the preflight stops on it, and
      takes it away;
    - runs the **smoke step**: a short session (at most 2 minutes) that calls
      `tabs_context_mcp` and reads the canary page back, its profile marker included. It
      stops there with a plain
      reason instead of a timeout: `extension_unreachable` ("no browser connected", the
      tab-context call didn't answer, its answer lists no tabs the worker can read, or no
      session at all), `navigation_unguarded` (nav-guard logged no decision for that call:
      the hook didn't run), `wrong_profile` (a browser answered but couldn't open or read
      the canary: another profile, no site access to `http://127.0.0.1`, or the profile
      isn't bound yet), `extension_version_mismatch` (the session reports another
      extension version than the one on disk), or
      `tool_inventory` (the tools and MCP servers the session was actually given, with
      the missing and extra names);
    - exercises a deliberately failed preflight: the same profile checks against a wrong
      extension id must fail closed;
    - runs the real preflight, skipping only the missing confirmation (and with it the
      version check: this is how new versions get confirmed), then one browser step on
      one fixed target, the first exact settings address of your allowlist, through a
      run's whole path: the canary, the settings page and the end check. Watch that Claude
      in Chrome acts in the Cain jobs window and nowhere else, opens the canary page first,
      and only reads;
    - runs the **destination check**: four short sessions on pages the worker serves,
      each judged by the run's own end check. A page that redirects off its pin
      (`redirect`), a page that moves its tab by script and opens a popup
      (`script_and_popup`) and a page that moves its tab off its pin, is read there and
      moves back to its pin before the end (`move_and_return`) must each fail it, as
      `unexpected_location` or `tabs_unexpected`; a page that redirects inside a bounded
      pattern (`redirect_bounded`) must pass it. Each line records the code, the final
      path, the first path seen off the pin (`off_path`), the other tabs seen and which of
      the pages were fetched. `move_and_return` is the evidence that the checks along the
      way work on your PC: its `off_path` must be `/<token>/away`;
    - runs the **deny check** on a probe page the worker serves: a session is ordered to
      try each denied capability (a shell command, a file write, a web fetch; on the page
      a click, typing, a form fill, JavaScript, a console read, a network read, an upload
      and a keyboard shortcut) and to open three addresses it may not (another host, a
      `javascript:` address and a `data:` address). Each item needs **positive evidence**
      of its refusal: its tools absent from the session's tools
      (`removed_from_tools`), or, for every attempt, a permission denial
      (`permission_denied`) or a nav-guard deny (`hook_denied`, `guard` for a navigation)
      recorded for that very tool-use id. An item with neither fails the check:
      `not_exercised` (never tried; listed in `not_exercised`) or `unproven` (tried, with
      no such record). nav-guard must have refused at least one of the navigations by its
      own log (`hook_intercepts`), and the run's own judgement of that session must fail
      it on those denials (`fails_closed`). The page's bait (a button, a field, a form, a
      file field, a key listener) calls back to the worker if used, and the console line
      and network request carry secrets that must not come out: any of that fails it.
    It saves `probe-evidence.json`: the time, the target, STOP, the smoke step, the
    failed preflight's code, the browser step's code, whether the canary came back, the
    tool inventory the session saw and whether it matched, the destination check line by
    line, the deny check line by line (each capability, its tools, what refused it, how
    many attempts, whether it was used) and per navigation, `not_exercised`,
    `hook_intercepts`, `fails_closed`, any bait that called back, the profile's
    fingerprint (the user data folder, the profile's name, the extension's id and version,
    Chrome's major version, the `claude` command's version), the hashes of the session's
    settings, prompt and outside settings, and the allowed tools.
    If it looks right, run `worker.ts confirm-profile --home C:/pc-worker` within a day.
    It records that evidence in `confirmed.json` if STOP worked, the smoke step
    connected, the failed preflight failed, the canary came back, every inventory
    matched, the browser step reached the site (`ok`, `needs_login` or `already_gone`)
    and the fingerprint and every hash still match. The deny check counts as passed only
    with every deny and navigation line passed, nothing `not_exercised`,
    `hook_intercepts`, `fails_closed` and the destination check passed; a failed one
    leaves runs attended only.
    **What invalidates it:** a change of the profile folder, its name, the extension's
    id or Chrome's major version (`profile_changed`); of the session's settings or
    prompt, your user, local or managed settings, memory files, the session's
    environment, or the owner key (`untrusted_config`). A new extension or `claude`
    version stops every run (`probe_stale`). Then run the probe and `confirm-profile`
    again.
    **Supported versions** are the ones your last confirmed probe recorded: its
    `fingerprint` names the Claude in Chrome version (`extension_version`) and the
    `claude` command's version (`cli_version`). Nothing else runs.
    **When something fails**, see Troubleshooting below.
12. **Attended runs, then (maybe) unattended.** Tell Cain the queue is ready; he queues a
    first job (`cain/docs/pc-worker/probe-job.json` shows one). With the Cain jobs Chrome
    open and no other Claude Code running (a run with one open is `chrome_busy`), run
    `worker.ts run --attended --home C:/pc-worker` while you watch. Only once the
    probe's deny check passed: add a Windows Task Scheduler task, every 15 minutes,
    set to **Run only when user is logged on** (the session needs your desktop and your
    open Chrome), running `bun <harness tools>/cain/rootfs/opt/cain/pcjobs/worker.ts run
    --attended --home C:/pc-worker`, and run it once from Task Scheduler in the desktop
    state you intend (screen locked or not), watching the result and the heartbeat. A
    Claude Code session you leave open makes scheduled runs `chrome_busy` until you
    close it.
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
  Chrome is not under it and keeps running. The run's tab stays open (on the blank end
  page after a normal run, wherever it was after a timeout); the next run takes over a
  tab the worker recorded, and fails on any other (`tabs_unexpected`). The lock holds the run's PID and that process's start time: a lock whose
  process is gone, whose PID now belongs to a process started at another time, or older
  than a lease, is from a run that died; the next run clears it and says so in the
  heartbeat.
- **Failure reasons are codes**, never page text or error text. Each one, where to
  look and what to do: Troubleshooting, below.
- **The last run's evidence, on the PC only:** `nav-decisions.jsonl` (nav-guard's
  decision for each extension call of the last session: tool-use id, tool, address,
  allow or deny and why), `last-run.json` (the last run's code, the navigations
  without a matching allow, the refused ones, the run's tab id, its final address
  reduced to scheme, host and path, and the other tabs seen) and `leftover-tabs.json`.

The worker can't ask Claude in Chrome which profile it is attached to: it doesn't say.
So it checks what it can: the profile's fingerprint, the extension installed nowhere
else, and the per-run canary. For each run the worker serves one page on `127.0.0.1`,
on a port the system picks, at a path that is a fresh token, for that run only. The page
holds a fresh value, the extension id you pinned and the run's attempt id; the model
must open it first and read all three back, and the worker must have seen the page
fetched. Only the dedicated profile's extension has site access to `http://127.0.0.1`,
so a session in another profile can't read it, and the run fails as `wrong_profile`.

## Troubleshooting

Every code below is in the run's line in `worker.log`, in `heartbeat.json` (and Cain's
copy of it), in the job's result, or in what `probe` prints. Files are in `C:/pc-worker`.

| Code or case | Where to look | What to do |
| --- | --- | --- |
| `stopped` | the `STOP` file | Delete `STOP` when you want runs again. |
| `busy` | `worker.lock` | Another run holds the lock. Wait; a lock from a dead run clears itself (`stale_lock` in the heartbeat). |
| `chrome_busy` (the competing-session case) | Task Manager, Details: any `claude.exe`, or `node` running `claude-code` | Close the other Claude Code session (or end a leftover one) and run again. Any other Claude Code process blocks a run, attached to Chrome or not: the worker can't tell, and the extension would serve it instead. |
| `extension_unreachable` | `probe`'s detail, or the bridge check in `worker.log` | Open the Cain jobs Chrome on its folder, check Claude in Chrome is on and paired with the `claude` command. The worker already ended a leftover native messaging host and checked again; if it persists, restart that Chrome. |
| `extension_unreachable` with "Claude in Chrome: not listed" (the strict-MCP-config case) | `probe`'s detail; the `tools` in `probe-evidence.json` hold no `mcp__claude-in-chrome__` names | `--strict-mcp-config` may be keeping the built-in Chrome integration out on your `claude` version. Don't edit the session's flags by hand (the settings hash fails closed): ask for a build without that flag. The inventory check already fails any MCP server but Claude in Chrome's, so dropping the flag keeps that guarantee. Untested assumption: that `--strict-mcp-config` leaves the built-in Chrome integration in. Needs a code change: yes. |
| `extension_unreachable` with "the claude command printed no session" (Git Bash not found) | run `claude --version` in a terminal of your own; does it complain about git-bash? | `claude` on Windows needs Git Bash, and runs the hook through it. Install Git for Windows, or set `CLAUDE_CODE_GIT_BASH_PATH` to the full path of `bash.exe` (it must exist; any other value is `untrusted_config`), then probe and confirm again (the environment's hash changes). Needs a code change: no. |
| `navigation_unguarded` from the smoke step, `nav-decisions.jsonl` never written (the hook never logs) | `nav-decisions.jsonl`; in Git Bash, `"C:/Users/you/.bun/bin/bun.exe" --version` | The hook didn't start, or started but couldn't write its log (a log it can't write is a deny). Check Git Bash runs the runtime from that path and the worker folder is writable by you. Needs a code change: no, unless Claude Code stops running PreToolUse hooks for MCP tools in print mode (then yes). |
| `extension_unreachable` with "isn't signed in under the worker's environment" | run `claude` in a terminal of your own | The session gets only the allowlisted environment, so a login that lives in an environment variable (an API key) doesn't reach it. Sign `claude` in with its own login (`claude`, then `/login`). Needs a code change: no; yes only if you must sign in through an environment variable. |
| `extension_unreachable` with "the tab-context call didn't answer", and `no_tool_use_id` in `nav-decisions.jsonl` (hook input without a tool-use id) | `nav-decisions.jsonl`: `why` | nav-guard refuses any call whose input has no tool-use id, since it can't match its log to the session's stream without one. Untested assumption: that Claude Code passes `tool_use_id` to PreToolUse hooks. Needs a code change: yes. |
| `navigation_denied` with `timeout` in `nav-decisions.jsonl`, or `navigation_unguarded` (Git Bash cold start past the hook's deadline) | `nav-decisions.jsonl`: `why`; how long `"C:/Users/you/.bun/bin/bun.exe" --version` takes in a fresh Git Bash | nav-guard gives its input 10 seconds and Claude Code gives the hook 30. A refusal for `timeout` fails the run closed; a hook Claude Code gave up on leaves no log, and the run fails as `navigation_unguarded`. Run again once the PC is warm; if it repeats, the deadline needs raising. Needs a code change: yes, if it repeats. |
| `extension_unreachable` once, then fine (recycling native hosts used by other windows) | `worker.log` | When the bridge check can't reach the extension, the worker ends the extension's native messaging hosts and tries again. Another window of the Cain jobs Chrome loses its bridge for a moment; your daily profile has no extension (`extension_elsewhere` otherwise), so nothing of yours uses them. Needs a code change: no. |
| `tabs_unexpected` on every run, `other_tabs` listing tabs outside Claude's group (tab context listing every tab in the window) | `last-run.json`: `other_tabs`; `probe-evidence.json`: `destinations`' `other_tabs` | Untested assumption: that `tabs_context_mcp` lists only Claude's tab group. If it lists every tab in the window, close every other tab in the Cain jobs window first; if it lists them anyway, the end check must learn the group. Needs a code change: yes. |
| `unexpected_location` with no `tab_id` but `tab_contexts` above 0 (the run's tab not yet in the group at the canary step) | `last-run.json`: `tab_id`, `tab_contexts` | The tab context right after the canary page didn't list the run's tab there: the tab may join Claude's group a moment later. Untested assumption: the tab is in the group by the second tab context. Run again; if it repeats, the canary step must wait for the tab. Needs a code change: yes, if it repeats. |
| A leftover tab still on the site page, not on `about:blank` (the end page can't be opened through the extension) | `leftover-tabs.json`; the Cain jobs window | Untested assumption: that Claude in Chrome navigates to `about:blank`. If it refuses, the run still ends on its last site page and is judged there, but the tab stays on the site. The fallback is a blank end page the worker serves on `127.0.0.1`, as the one literal end address. Needs a code change: yes. |
| `cli_changed` | `claude --version`; `worker.log` | The `claude` executable changed during the run (an update), or couldn't be read before or after it. Nothing was written but the code. Run the probe and `confirm-profile` again for the new version. Needs a code change: no. |
| `extension_version_mismatch` | `probe`'s detail: `live` and `disk`; chrome://extensions | The session reports another Claude in Chrome version than the one installed in the Cain jobs profile: another profile's extension may be answering, or Chrome hasn't finished an update. Restart that Chrome, then probe again. Needs a code change: no. |
| `navigation_unguarded` | `nav-decisions.jsonl` against `last-run.json`'s `unguarded` ids | A navigation had no allow in nav-guard's log: the hook didn't run, or didn't see that call. Check Git Bash is installed and `claude` runs hooks; run the probe, whose smoke step names it. Never set `unattended` while this happens. |
| `navigation_unguarded` from the probe's smoke step (the Windows hook quoting case) | `nav-decisions.jsonl` is missing or empty | The hook command didn't start. Claude Code runs it through Git Bash: `"$PCW_RUNTIME" "$PCW_WORKER" nav-guard`, both paths with forward slashes, set by the worker. Check `bun` (or `node`) runs from that path in Git Bash (`"C:/Users/you/.bun/bin/bun.exe" --version`) and that the worker's folder path has no `"` in it. |
| `navigation_denied` | `nav-decisions.jsonl`: the `deny` lines and their `why` | The session tried an address or tool it may not (`address_not_allowed`, `unknown_tool`), or nav-guard couldn't decide (`timeout`, `internal_error`, `unreadable_input`, `log_failed`). A page talking the model into a detour shows up here: look at the job's site. An `unknown_tool` after an extension update means the extension added or renamed a tool. |
| `unexpected_location` | `last-run.json`: `final_url`, `off_url`, `off_at`, `tab_id`, `tab_contexts` | The run's tab showed an address off its pin, midway (`off_url`, and `off_at` the tool call it showed in) or at the end (`final_url`). If the site really moves you on to a fixed place, add it to the entry's `redirects` and sign again; if it went to a sign-in page, add it to `login_hosts` or `login_paths`. `tab_contexts` 0 or no `tab_id`: the tab context couldn't be read (an extension update may have changed its answer): run the probe. |
| `tabs_unexpected` (and the leftover-tab case) | `last-run.json`: `other_tabs`; `leftover-tabs.json` | A tab beyond the run's own sat in Claude's tab group: a popup, or a tab you opened there. Close every tab in that group but the one the worker left (or close them all, and delete `leftover-tabs.json`), and run again. A `leftover_tab` warning alone is normal: the reading tools can't close the run's tab, and the next run reuses it. |
| `tool_inventory` | `probe`'s detail: `missing` and `extra` names | The extension or CLI renamed, added or dropped a tool, or another MCP server reached the session. A renamed allowed tool needs a code change; an extra MCP server comes from settings outside the pinned file. |
| `wrong_profile` | `probe`'s detail; `diagnostics.log` with `--diagnose`; `profile-marker.json` | Another Chrome profile answered, the extension has no site access to `http://127.0.0.1`, the profile's name or extension folder isn't as set up, or the canary page came without the profile's marker: the profile isn't bound, or its cookies for `127.0.0.1` were cleared. Run `bind-profile --attended` (setup step 10). |
| `browser_unreachable` | is the Cain jobs Chrome open? | Start it with `--user-data-dir=C:/pc-worker/chrome` before the run. |
| `probe_stale` | `confirmed.json`'s `fingerprint` against the installed versions | Claude in Chrome or `claude` updated. Run `probe --attended`, then `confirm-profile`. Nothing else runs until then. |
| `profile_changed`, `profile_unconfirmed` | `confirmed.json` | Run the probe and `confirm-profile`. |
| `untrusted_config` | the reasons in the setup steps | Install config, owner key, the session's files, outside settings, a memory file in or above the worker folder, a `managed-settings.d` folder, the policy registry key, `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_*` or a base address in the environment, a changed environment, or `claude` not a `.exe`. Fix it, then probe and confirm again if the confirmation's hash changed. |
| `untrusted_files` | `icacls C:\pc-worker\install.json` (and the others) | Redo setup step 1's `icacls` commands. |
| `extension_elsewhere`, `profile_scan_failed` | your other Chrome folders; Task Manager, Details: `chrome.exe` with another `--user-data-dir` | Remove Claude in Chrome from other profiles; turn sync off in Cain jobs. A Chrome running from another folder with the extension, or the extension's native host running under a Chrome other than Cain jobs (or under none the worker can find: end it), fails too. |
| `clock_skew` | `heartbeat.json`'s `skew_ms` | Set Windows to sync its clock. |
| `queue_misconfigured`, `git_failed` | the queue clone | Check the queue's `.gitattributes` and the deploy key (setup steps 2 and 4). |
| `browser_timeout` | `worker.log` | The session hung past `session_minutes`; the worker killed it and left Chrome running. Check the site in the Cain jobs window by hand. |
| `url_drift`, `result_rejected`, `page_not_as_expected`, `outcome_uncertain` | the job's result; `diagnostics.log` with `--diagnose` | The page wasn't what the job expected, or the model's report broke the shape. Cain tells you what it means. |
| Probe: `deny_check` is false | `probe-evidence.json`: `deny`, `navigation`, `not_exercised`, `hook_intercepts`, `fails_closed`, `destinations` | A line with `refused_by` other than `removed_from_tools`, `permission_denied` or `hook_denied`, a navigation not blocked by `guard` or `refused`, anything `not_exercised`, or a destination line with `passed: false` was not proven refused. Rerun once (the model may have skipped an item); if it repeats, don't turn on unattended. |

## How a job runs

1. `worker.ts run` (by hand with `--attended`, or by Task Scheduler once allowed): kill
   switch, lock, install config, the files' ACLs, the owner key's fingerprint,
   `git pull`, the `.gitattributes` check, the clock check, then it closes what can't
   run (cancelled, not read-only, off the signed allowlist), runs the browser preflight,
   checks no other Claude Code is running and the bridge answers, claims the oldest job
   left with a new attempt id and a 30 minute lease, and pushes.
2. It serves the canary page (which shows the profile marker only to the bound
   profile), hashes the `claude` executable, and starts the browser session with one
   narrow instruction in its prompt: site, action, start address, what to look for, the
   typed facts it may report, the outcomes it may say, the canary page, the end page
   (`about:blank`) and the tab the last run left (`tab_id`). nav-guard lets the session
   open those three addresses and nothing else, and logs every decision.
3. When the session ends (or its time limit kills it), the worker checks the job is
   still its own (same attempt, not cancelled, and well inside the lease by its own
   monotonic clock; otherwise it writes nothing), checks the session and writes the
   result: the `claude` executable's hash unchanged; the session's tools, MCP servers,
   connection and (where reported) extension version from its stream; every navigation
   against an allow in nav-guard's log, and no refused call; the report's size caps; the
   end check (the run's tab, every address it showed from the canary on and its final
   address from the tab context, each against the pin, the entry's bounded redirects and
   its sign-in pages, and no tab beyond the run's); the canary with its profile marker; the
   final address, the tab's and not the model's, checked against the pin (path case, a
   trailing slash and a query count unless the entry allows alternatives; a sign-in
   address is `needs_login`) and then reduced to scheme, host and path; the facts checked
   against the action's types (dates in the common forms made YYYY-MM-DD). Then it
   commits and pushes, with retries for transient file locks, and records the tab it
   left.

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
  `tool_inventory`, `wrong_profile`, `browser_timeout`, `navigation_unguarded`,
  `navigation_denied`, `unexpected_location` (the run's tab showed an address off the
  pin, its redirects and its sign-in pages, midway or at the end), `tabs_unexpected`,
  `cli_changed`, `extension_version_mismatch`, `url_drift` (the final address is off the allowlist's pin and not
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
  "url", "match", "login_hosts"?, "login_paths"?, "alternatives"?, "redirects"?}], "sig"}`, signed with your key;
  `owner.pub`: `<kid> <public key>`, matching `owner_fpr` in `install.json`.
- On the PC only: `install.json` (yours), `confirmed.json` and `probe-evidence.json`
  (the probe and `confirm-profile`), `profile-marker.json` (the hash of the profile's
  canary marker, from `bind-profile`), `heartbeat.json`, `worker.log`, `diagnostics.log`,
  `nav-decisions.jsonl`, `last-run.json`, `leftover-tabs.json`.

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
