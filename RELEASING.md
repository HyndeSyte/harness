# Building and releasing

For any session that changes this repo, including the cloud build and ship sessions
Cain starts. Two Home Assistant Apps live here:

- `harness/` is the calendar specialist (Python). Slug `0fcc2575_harness`.
- `cain/` is Cain, Dane's chief of staff (bash and Bun/TypeScript). Slug `0fcc2575_cain`.

Home Assistant offers an update when `version` in an App's `config.yaml` changes on
`main`. So `main` is what gets installed: nothing reaches it without passing CI and
without Dane's go.

`main` changes only on Dane's Ship tap. Two GitHub rulesets (below) lock it so that
only Cain's link can update it, with a deploy key only the link holds, and the link
does that only for the pull request and head commit his Ship card was for, once its
branch is up to date with `main` and these checks passed on it:

- `pytest`: the Python tests.
- `bun`: Cain's tests.
- `pr` (`.github/scripts/check_pr.py`, run from `main`'s copy by `pull_request_target`,
  so a pull request can't change the check it is judged by; it only reads the pull
  request with git and never runs its files):
  - the branch is up to date with `main` as it is when the check runs;
  - the description, read live from GitHub, follows `.github/pull_request_template.md`,
    and is for this round: for each App that goes up a version it carries the line
    `Changelog: <App> <version> <hash>` (the first 12 hex digits of the SHA-256 of that
    App's newest CHANGELOG section), so a description left from an earlier round of fixes
    fails until it is refreshed; the failure prints the line to add;
  - each App whose shipped files changed (anything in its folder but `tests/` and
    `tools/`, a move in or out counting at both ends) goes up exactly one version step
    from `main`, with a matching section at the top of its `CHANGELOG.md`. An App that
    didn't change keeps `main`'s version. A change to `repository.yaml` needs at least
    one App bumped. A `config.yaml` whose `version` is missing, duplicated, unparseable
    or not a quoted `X.Y.Z` fails, on `main` or the branch;
  - when the pull request changes the PC worker's guard (its hook `worker.ts`, the pinned
    session settings or the pinned Public Suffix List): the hook's `POLICY_VERSION` steps
    above `main`'s (so a rebase over another pull request that touched the guard bumps it
    again), every hook timeout in the pinned settings equals the hook's `HOOK_TIMEOUT_S`,
    and the description carries `Hook policy version: <N>` and the guard-surface hash line
    of each of those three files at the head (`cain/tools/guard-surface.sh` prints them). A
    new policy version needs a new probe and confirmation on the PC. The probe steps that
    gate it are listed in `cain/docs/pc-jobs.md`; since the twentieth round its `hook_timing`
    step needs a cold first sample (taken within 5 minutes of a Restart of the PC, not a Shut
    down, which Windows Fast Startup doesn't count; `cold_sample_missing` otherwise, printing
    the uptime measured), its `structured_address` step records each reading tool's
    address-named key paths (extra paths refuse as a schema mismatch needing a policy
    change; the refusal lists them grouped by tool, the failing tool marked, and the probe
    prints the same hint at its end), and its result names the Claude in Chrome id and loaded
    version and Chrome's version (chrome.exe's file version, or the Last Version file as a
    named fallback, the source recorded) that every run then checks before and after its
    session, comparing versions by their numbers (a source difference with an equal version
    is only a note; any version change fails the run and writes the hold), and an
    auto-update needs a new probe: a version hold clears only on validated probe evidence
    (the confirmation's hash of the probe evidence, checked against the evidence file, a probe
    run after the hold, of the versions loaded now);
  - the `pytest`, `bun` and `pr` jobs keep their names, with no paths or branches
    filters and no `if` or `continue-on-error`, and no other workflow reuses the names;
    the same holds for `pcjobs-windows` (the PC worker's tests on Windows) while
    `tests.yml` defines it, and (Cain 0.13.0) for `secrets`, the secret scan, which must
    always be there. The pr check only keeps it there and reporting; refusing a merge while it
    is red needs `secrets` added to the "Checks and history" ruleset's required checks, which
    takes admin rights (Dane, once). `audit` stays optional for one week, until Nov 25, 2026,
    since it rests on network lookups: it becomes required (in the pr check's list and the
    ruleset) once a week of its runs shows no network failures. The `secrets` scan honours a
    baseline, `.gitleaksignore` at the repository's root (one finding's fingerprint a line, each
    under a `#` line with its reason), empty to start: the first full-history run after this lands
    on `main` may surface old findings, and they are triaged into it (a real secret is revoked and
    replaced, never listed).

`pcjobs-windows` is not a required check in the rulesets (making it one needs the
repository's rulesets, which take admin rights no session has). The link enforces it
instead: when the head's `tests.yml` names it, or a run of it exists on the head, a Ship
card is refused, and a landing refused or held, unless every run of it GitHub lists for
that exact head commit passed, in whatever order ("CI is still running pcjobs-windows on
it" waits; a failed, cancelled or skipped attempt refuses even beside a green re-run, so a
flaky Windows run needs a new commit; a run for another commit doesn't count, and none at
all refuses; GitHub not answering holds). It reads every run and every attempt: the head's
check runs of that name with every attempt listed, and GitHub Actions' workflow runs for the
head with each attempt's jobs, each listing followed page by page until it is whole; a page
that fails or a listing that isn't whole holds, and so does a refused page from GitHub (HTTP
403 or 429), whatever it holds: named a rate limit only on a 429, or a 403 with
`x-ratelimit-remaining: 0`, a `Retry-After` header or a body that says secondary rate limit,
and otherwise a permission failure naming the endpoint. `/opt/cain/keeper.sh ship-gate <full head
sha>` on the Pi reads that gate for a head without acting and prints what it would decide and
why, the workflow file it read and every attempt it saw (`--watch` keeps watching a fresh
head until its Windows run is done: the PC probe's `ship_gate` step, started before that head
is pushed so it sees the Windows run pending; `--pr <number> --head <full sha> --watch`
instead takes the exact commit about to be pushed, waits until the pull request's head equals
it, accepts only that sha and fails by name (`other_head`, `head_moved`) if a different head
appears or the head moves away; it honours GitHub's Retry-After and rate-limit reset before
its next reading, each wait capped at 15 minutes and the whole watch at 2 hours (an
unreadable header counts as the cap); every acceptance is kept by sha in
`/data/work/ship-gate-<sha>.json`, a Ship card for any other head of that pull request is
refused while it stands, naming the accepted sha, and after a rebase
`keeper.sh ship-gate --supersede <accepted sha>` records that the acceptance is replaced,
only once the pull request's head differs from it; a pull request has one live acceptance at
a time, and a watch refuses to accept while another stands, `live_acceptance`, checked and
kept under the pull request's own lock file so two watches finishing together keep one; a
stale lock is taken over only by a rename followed by the exclusive create again, so exactly
one contender proceeds, and a lock that can't be read fails the watch as `lock_unavailable`;
the lock's time is refreshed at the check and before the write, the holder re-reads the lock
and requires its own token just before it writes the acceptance and again after, taking the
acceptance back if it lost the lock meanwhile, and a second write for the same sha is a no-op;
twenty-fifth round: every acceptance records the lock's generation, each takeover moves the
generation on, and the Ship card counts an acceptance only under the current one, so a holder
taken over can't leave a live acceptance by writing late; the sha-bound check runs before and
after the write, a superseded sha is refused, never accepted again, and an acceptance must be
the pull request's head as GitHub has it, at the watch's checks and again when the card reads it;
twenty-sixth round: the generation never resets, a missing or unreadable generation file is
fail-closed, and the card refuses an unreadable gate state by name; twenty-seventh round: the
watch's whole critical section has one deadline, records carry a format version, the recovery
takes the lock, and one garbled record blocks only its own pull request).
Run it once on a head
with a failed-then-green Windows re-run before relying on the gate: it must say `refuse`.

Upgrading the gate's lock (0.12.0, twenty-fourth round). A lock file left by an earlier
version of the watch (`/data/work/ship-gate-pr-<number>.lock`, empty or with no holder
token) is taken over by the next watch once it is more than a minute old, through the same
rename and exclusive create, with a loud line in the watch's output. One that looks current
(under a minute old) or whose content doesn't parse still counts as held: the watch fails
`lock_unavailable`, and its notice names the exact path and the command that removes it
(`rm -f /data/work/ship-gate-pr-<number>.lock`). Run that on the Pi only when no watch of
that pull request is running, then watch again.

Generations (0.12.0, twenty-fifth round). Beside each pull request's lock the watch keeps its
generation (`/data/work/ship-gate-pr-<number>.gen`). A takeover of a stale lock, a legacy one
included, moves it on and says so in the watch's output, with the lock's age in words: the
acceptances kept before it no longer count, so run the watch again for the pull request's head.
A generation file that can't be read fails the watch as `lock_unavailable`.

Generations never reset (0.12.0, twenty-sixth round). A new generation file starts at 1, and a
record with no generation (or 0) never counts, so acceptances from before this round are void:
run the watch once after installing. A generation file that is missing while any lock or record
of that pull request carries a generation, or can't be read, is fail-closed: no acceptance
counts, a watch fails `lock_unavailable`, and a Ship card is refused as "the Ship gate's state is
unknown" (so is one whose kept records can't be read). Never delete the file. The recovery, on
the Pi once no watch of that pull request is running:
`/opt/cain/keeper.sh ship-gate --recover-generation <number>`, which rewrites the file whole with
a number above every generation in it and in the pull request's locks and records (it refuses
while the lock looks current); then watch the current head again. The head read at the
acceptance uses a GitHub token only when the environment hands one in (`SHIP_GATE_GITHUB_TOKEN`;
the link has none of its own), retries a rate-limited read briefly, and names a rate limit apart
from a head that moved.

Records, the deadline and the recovery (0.12.0, twenty-seventh round). Every record a watch keeps
now carries a record format (`"format": 27`), and a record without it never counts, whatever
generation it carries: acceptances kept before this round are void, so run the watch once after
installing. The watch's work under the lock has one deadline (10 seconds from taking the lock):
both reads of the pull request's head take their time and any rate-limit wait from what is left
of it, and the lock, its generation and the time are checked again just before the acceptance is
written; past the deadline nothing is accepted (`lock_unavailable`, saying the watch ran past its
bound), and an acceptance already written is taken back. A live watch normally lets go of the lock within 11 seconds, under a quarter
of the minute after which a lock counts as stale (not a hard bound: see the twenty-eighth round below). The generation
recovery (`--recover-generation <number>`, optionally `--floor <number>`) now takes the gate lock
itself, the same way a watch does, writes above every generation it finds (a stale lock it took
over included), checks nothing ended above what it wrote, and lets go; it refuses while a watch
runs. A record that can't be read or doesn't parse blocks only its own pull request (or every
one, when its text names none), and the refusal names it with the command that sets it aside:
`/opt/cain/keeper.sh ship-gate --quarantine <sha>`, recorded in
`/data/work/ship-gate-quarantine.jsonl`. The only full reset of a pull request's gate is deleting
all of its gate files at once (its lock, its `.gen` file and every `ship-gate-<sha>.json` naming
it), and only while no watch of it runs. Every GitHub read the gate makes goes through one
wrapper; a supersede stopped by GitHub's rate limit is kept as owed on its record and says so.

The bound and the quarantine (0.12.0, twenty-eighth round). The 10 second deadline bounds the
acceptance window, not lock holding: nothing is accepted past it, a live watch normally lets go
within 11 seconds, but its file reads and writes can't be interrupted, so under a disk stall the
holding is unbounded, fenced by the token and the generation (a holder taken over writes nothing
that counts). The deadline is checked before each record is parsed and each live check. The watch
refuses to start with curl older than 7.32 and kills a curl that runs over its limit itself. The
quarantine takes the gate lock (it refuses while a watch runs), renames before it logs, and takes
`--pr <number>` for a record that names no pull request; a lock file that doesn't parse is set
aside with `/opt/cain/keeper.sh ship-gate --quarantine-lock <number>`. A Ship card is refused while
an acceptance's supersede is owed. Without a token page reads are never retried and refusals say
how many reads are left; a fine-grained read-only token in `SHIP_GATE_GITHUB_TOKEN` is the
recommended default.

Takeovers, the quarantine's put-back and the curl rule (0.12.0, twenty-ninth round). Every takeover
of a stale lock moves the generation on before it acts: a watch's, the generation recovery's, and
both quarantines' (the lock quarantine's moving of the pull request's own lock aside included), so a
holder stalled past the stale bound that writes after the takeover leaves nothing that counts. A
quarantine never deletes what it moved: a put-back that fails leaves the file under its quarantine
name, logged with its generations and the failure (`put_back_failed`), and prints the restore command
(`mv -n <quarantined file> <record path>`, run once no watch runs). A missing record is a refusal, not
"no gate": the Ship card is refused while a quarantine or recovery holds the lock, or while a
quarantined record isn't in the log. An owed supersede run again while the head is still the sha
being replaced clears its mark under the lock ("no longer owed: head unchanged"). curl's version
check and child kill are in the one request wrapper, so every gate read has them; the dry run, the
watch and the supersede refuse to start below curl 7.32, and a read that fails on the Pi's side is
named as that. After the fenced write the deadline is checked again at once.

The follow-ups (0.12.2). The watch checks its deadline before it publishes an acceptance, as well as
after. The Ship card reads the pull request's head through the gate's own curl wrapper, and a read
stopped at its time limit refuses it as "the Ship gate's state is unknown". An unreadable quarantine
log refuses the card naming the log, with no restore command. A quarantined record carries its pull
request in its name; one whose name names none (from 0.12.0) blocks every card until
`/opt/cain/keeper.sh ship-gate --set-aside <file> --pr <number>` moves it into
`/data/work/ship-gate-set-aside/` and logs it (never a delete). An owed supersede re-reads the head
under the lock before clearing its mark. The lock quarantine takes the lock in recovery mode and moves
the generation on. `SHIP_GATE_GITHUB_TOKEN` is the recommended default for every gate read.

Owner's ship checklist, for the gate: rerun the watch after any takeover (the watch's output
says when one happened, and since the twenty-ninth round a quarantine's or recovery's takeover
counts too), after a generation recovery, after a quarantine (of a record or a lock file), after
restoring a quarantined record with its `mv -n` command, and once after installing this round. Never
delete a `.quarantined-` file: restore it or leave it.

  Run it before pushing (needs PyYAML):
  `python .github/scripts/check_pr.py --base origin/main --head HEAD --body-file <your description>`.

The rulesets on `main`, as set up:

- **Only Cain's link updates it** (ruleset 27164827): "Restrict updates" (only its
  bypass list may update `main`) and "Require a pull request before merging". Bypass
  list: deploy keys, always. The repository has exactly one deploy key with write
  access: the link's.
- **Checks and history** (no bypass list, so it binds the link's key too): required
  checks `pytest`, `bun` and `pr`, each pinned to the GitHub Actions app as its source,
  with "Require branches to be up to date before merging" on; block force pushes and
  deletions.

So GitHub refuses every other update of `main`, pull request merges included: Dane's
own account, laptop sessions, cloud jobs and Cain. Changing a ruleset or adding a
deploy key takes admin rights on the repository, which cloud jobs don't have (the Claude
GitHub app they use has administration read only).

A pull request that changes `.github/workflows/tests.yml` changes what its own `pytest`
and `bun` run, and the Claude GitHub app can write workflow files: read workflow diffs
before Ship. A Ship card says when a change touches GitHub's workflows.

## Build (a branch and a pull request)

1. One branch per job: `claude/<short-slug>`. Never commit to `main`.
2. Make the change, with tests for what it does. Read the code around it first; match
   its style. Keep the change to the job.
3. Bump the App's `version` in its `config.yaml` (patch for fixes, minor for new
   behavior) and add a section at the top of its `CHANGELOG.md`: what Dane will notice,
   in plain words, a few bullets, no em dashes. The CHANGELOG is shown in Home Assistant.
4. Run the tests:
   - Python: `python -m pytest -q -p no:cacheprovider` from the repo root.
   - Cain: `bun test cain/tests` (install Bun if missing).
   - A change to Cain's managed settings (`cain/rootfs/opt/cain/settings.json`) also needs
     the connector check, `cain/tools/connector-check.sh`, which CI can't run (no signed-in
     account; `cain/docs/connector-check.md`). Cain runs it himself on the live server (the
     Pi), signed in as the account, from the settings file at the pull request's head, before
     he shows the Ship card, and puts its passing line in the description. A build session
     doesn't run it: it says so under "Not verified". Nothing in it is Dane's to do.
5. Commit as `HyndeSyte <HyndeSyte@users.noreply.github.com>` (GitHub rejects pushes
   that expose a private email). Message: `<App> <version>: <what, in a line>`.
6. Push the branch and open a pull request into `main`. The description follows the
   template's four sections: what changed, how it was tested, what is not verified, and
   anything Dane must do (for example a new option to switch on), and the round line the
   `pr` check asks for (run check_pr.py by hand to get it). Refresh the whole description
   whenever a new round of fixes changes the CHANGELOG. Its title,
   `<App> <version>: <what he'll notice>`, is plain words with no em dashes, shas or ids.
   Dane's Ship card doesn't show it: the link writes every line there but Cain's own.
7. Wait for the `pytest`, `bun` and `pr` checks on the pull request to pass. Fix until
   they do.
8. Never merge, never push `main`, never force-push. GitHub refuses it anyway: shipping
   is Dane's tap.
9. A laptop session hands its finished pull request to Cain: it passes its record item
   to `cain` with a note naming the pull request and its full head sha. The record
   keeper tells Cain at once. Cain gets an outside review of the diff through his review
   service (only a service review's line goes on the card, whatever other reviews it
   had), then shows Dane the Ship card.

## Ship (only after Dane's go)

Dane's go is his tap on Cain's Ship card for that one pull request, at the one head
commit the card was for (its full head sha). The link builds that card itself
(`cain/rootfs/opt/cain/link/core.ts`), so what it says comes from code: its question
names each App and version the tap installs (each App's `config.yaml` read at that very
head and at the pull request's base; "Ship it?" when any of it can't be read); a line
from GitHub gives its commit and file counts, the parts that matter most, and its checks
(the pull request's title isn't shown: free text can't pose as the link's lines), read the way the landing reads them, each required check's latest
runs in one whole answer (a check that failed or hasn't run yet refuses the card; a pull
request already merged at that head, once main is seen to have it, says "Already in main,
so Ship only installs it."); and its last line is the review service's own Reviewed line for the review Cain
names, which must be a review of that very pull request and head, followed by "The
reviewers read Cain's summary of the change, not the code." ("No outside review
attached." when he names none). Cain's own line says only what Dane will notice, on one
line, with no check, test, build or CI words, no GitHub, job, status or result words, and
no review, verdict or AI names. No card shows a record code like
P64: the item stays as data.

On that tap Cain's link lands it itself
(`cain/rootfs/opt/cain/link/merge.ts`), with the deploy key only it holds:

- it checks the pull request is open, into `main`, from a branch of this repository and
  still at that head, and that its `pytest`, `bun` and `pr` checks passed there;
- it checks `main` is an ancestor of that head, and that nothing is stopped;
- it pushes exactly that commit to `main`, as a fast-forward, never forced. GitHub marks
  the pull request merged.

If GitHub doesn't answer, or the checks are still running, it tries again for up to 2
hours, and the card says so; after that nothing is pushed, and a landing the link was
cut off from (a restart) is settled from `main` itself. While Dane has everything
stopped, nothing lands, and a Stop since his tap ends that landing for good, even once
he has turned things back on: a new tap ships it.

Then Cain starts the Ship job, which only installs. Its text carries the full head sha
and Dane's Ship token: his tap, signed by the link for that pull request and head, good
for 2 hours, without which Cain can't start the job.

1. Check `main` contains that commit (`git fetch origin main`, then
   `git merge-base --is-ancestor <sha> origin/main`) and the pull request shows merged.
   If not, stop and report. Merge nothing and change no code. CI already passed on that
   exact commit, so there's nothing more to wait for.
2. Check Home Assistant first: one read through its connector (the update entity of
   the App to install). If the connector is missing, asks to be signed in again, or
   doesn't answer, stop: install nothing, change nothing, and end with one line,
   `Home Assistant connector: needs signing in again` (or `no answer`). main keeps
   the commit; only the install waits (If Home Assistant's connector lapses, below).
3. When the pull request changes Cain's managed settings (`cain/rootfs/opt/cain/settings.json`),
   its description must carry Cain's passing line from the connector check for the exact head
   being installed, `Connector check passed at <that full sha>, settings sha256 <digest>: ...`,
   and the SHA-256 of `cain/rootfs/opt/cain/settings.json` at that head
   (`git show <sha>:cain/rootfs/opt/cain/settings.json | sha256sum`) must equal that digest.
   Otherwise install nothing and end with
   `Connector check: no passing line for this head and its settings`.
4. In Home Assistant: check for App updates, then update only the App(s) the pull
   request changed, with a backup taken first. When it changed both, Cain first, then
   Harness (since Cain 0.12.0 and Harness 0.24.0: Cain's link answers the old Harness
   with 503, so its cards wait, none lost, until Harness signs). An App already at its
   new version is skipped. Nothing else in Home Assistant: no options, no other Apps,
   no services. Never read Cain's App info (`ha_get_app`): it holds his GitHub token.
5. Confirm the new version is running from the update result and the App's log.

The job is a cloud session, not a process on the Pi: Home Assistant's Supervisor does
each update, so replacing Cain's container doesn't stop the job before Harness. If the
job ends between the two anyway, Cain's App tells Cain after 30 minutes, and a new Ship
card for the same pull request and head installs what's missing.

Before a Ship card for a release that changes how an App starts (Cain 0.12.0: the move to
his own user), the laptop session confirms from Home Assistant's backup entities that the
last automatic backup succeeded within 24 hours: the way back has to exist first.

## The way back from the move to Cain's own user (Cain 0.12.0, Harness 0.24.0)

The two Apps go back together, never one alone. The Ship job takes a backup of each just
before it updates it (Cain first, then Harness), so both exist from the same few minutes.
In Home Assistant: Settings, System, Backups; restore Cain's, then the calendar App's
(Harness). If only one goes back:
- Cain alone: the calendar App's cards wait and none is lost (an answer the link didn't sign
  is retried, cain_relay.py `_call`), but they don't move until Harness goes back too.
- Harness alone: the link answers its old key with 503 and nothing done, and tells Cain at
  once, at most hourly (link/main.ts `oldKeySeen`); Cain shows a new Ship card for the pull
  request that last updated Harness, so a tap installs it again.
A restored history only matters for an operation whose answer was lost in the minutes
before the restore: the calendar App sends again only rows it never got an answer for.

## If Home Assistant's connector lapses

Cain's Ship job installs through the claude.ai Home Assistant connector, and a
claude.ai outage can sign it out (Nov 13). Landing in main doesn't use it and isn't
affected. So Cain reads Home Assistant (through his own read-only connector) before he
shows a Ship card and again before he starts a Ship run, and the job's first step
checks its own connector, which can lapse alone.

- If Home Assistant doesn't answer, nothing goes to Dane: Cain shows no card and starts
  no run, and checks again at each 15-minute cloud job check (a `connector` file in
  /data/jobs keeps that check coming; it isn't a job).
- If the connector says it must be signed in again, Cain's link posts one notice whose
  only button opens Claude's connector settings, the fix one tap away. It asks nothing
  back: Cain keeps checking by himself.
- Once Home Assistant answers, Cain goes on where he stopped: he shows the Ship card,
  or starts the run while Dane's Ship token is good (2 hours from his tap), or shows a
  new Ship card for the same pull request and head once it has run out. A new Ship card
  goes out only once Home Assistant answers again.

One installer: no laptop session installs around a waiting Ship job, and nothing is
installed from Home Assistant's own page unless Dane says so.

## If the Ship key is remade

The link makes a new Ship key only when the old one can't be read (and on a restored
Pi, since backups leave it out), and says so. Ship tokens from before it no longer
count, so an install waiting on one needs a new Ship card. Nothing else to do.

## If the deploy key is remade, or GitHub loses it

The link makes a new deploy key only when the old one can't be read (and on a restored
Pi, since backups leave it out). It logs the new public half, and Cain is told; once a
day it also checks that GitHub still knows its key, and Cain is told if it doesn't.
Until it's fixed, no Ship tap can land. The fix is at Dane's PC, on his OK: a laptop
session adds the new public key in GitHub's web page (Settings, Deploy keys, Add deploy
key, with write access), and deletes the old one there. Never add it with the `gh` CLI
or another OAuth app's token: GitHub deletes a key added that way when the token is
revoked. Keep exactly one deploy key with write access.

## Break glass (the link can't ship)

If the link itself is broken (a bad release, or the Pi is lost) and a fix has to reach
`main`, then on Dane's OK, at his PC: a laptop session makes a temporary SSH key, adds
it as a deploy key with write access in GitHub's web page, pushes the fix's commit to
`main` as a fast-forward (`git push git@github.com:HyndeSyte/harness.git
<sha>:refs/heads/main`), and deletes that key right after. The "Checks and history"
ruleset still applies to it: the commit's checks must have passed, and no force push or
deletion. Then install the App with a backup taken first, so a bad release can be
rolled back from Home Assistant.

What the first use taught (Nov 19, Cain 0.13.4, when Cain restarted every few minutes and
couldn't show a Ship card):

- Cain itself can't ship either when its session can't stay up, not only when the link is
  broken: break glass covers that too.
- The laptop's push guard (`cain/tools/record-prepush.ts`) refuses every session push to
  `main`, since `main` is never held, so this push needs `--no-verify`. Ask Dane once for
  both: "OK to install <App and version> without a Ship card, by the backup route, skipping
  the push guard for that one push?" Never skip it on the first OK alone.
- The key can be added and deleted with `gh api repos/HyndeSyte/harness/keys` (title it as
  break glass, `read_only=false`), no web page needed. Delete it in the same command that
  pushes, whatever the push does, and list the keys after: only the link's is left.

## Rules for every session

- No secrets in code, commits, logs, pull requests or reports. Don't print tokens.
- Dane's App options are his to change; say which one in the report if one is needed.
- Plain, short reports: what changed, tests and CI, what isn't verified.
