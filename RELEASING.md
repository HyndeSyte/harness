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
  - the description, read live from GitHub, follows `.github/pull_request_template.md`;
  - each App whose shipped files changed (anything in its folder but `tests/` and
    `tools/`, a move in or out counting at both ends) goes up exactly one version step
    from `main`, with a matching section at the top of its `CHANGELOG.md`. An App that
    didn't change keeps `main`'s version. A change to `repository.yaml` needs at least
    one App bumped. A `config.yaml` whose `version` is missing, duplicated, unparseable
    or not a quoted `X.Y.Z` fails, on `main` or the branch;
  - the `pytest`, `bun` and `pr` jobs keep their names, with no paths or branches
    filters and no `if` or `continue-on-error`, and no other workflow reuses the names.

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
5. Commit as `HyndeSyte <HyndeSyte@users.noreply.github.com>` (GitHub rejects pushes
   that expose a private email). Message: `<App> <version>: <what, in a line>`.
6. Push the branch and open a pull request into `main`. The description follows the
   template's four sections: what changed, how it was tested, what is not verified, and
   anything Dane must do (for example a new option to switch on).
7. Wait for the `pytest`, `bun` and `pr` checks on the pull request to pass. Fix until
   they do.
8. Never merge, never push `main`, never force-push. GitHub refuses it anyway: shipping
   is Dane's tap.
9. A laptop session hands its finished pull request to Cain: it passes its record item
   to `cain` with a note naming the pull request, its full head sha, that CI passed,
   and how it was reviewed. The record keeper tells Cain at once, and Cain shows Dane
   the Ship card.

## Ship (only after Dane's go)

Dane's go is his tap on Cain's Ship card for that one pull request, at the one head
commit the card was for (its full head sha). On that tap Cain's link lands it itself
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
2. In Home Assistant: check for App updates, then update only the App(s) the pull
   request changed, with a backup taken first. Nothing else in Home Assistant: no
   options, no other Apps, no services. Never read Cain's App info (`ha_get_app`): it
   holds his GitHub token.
3. Confirm the new version is running from the update result and the App's log.

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

## Rules for every session

- No secrets in code, commits, logs, pull requests or reports. Don't print tokens.
- Dane's App options are his to change; say which one in the report if one is needed.
- Plain, short reports: what changed, tests and CI, what isn't verified.
