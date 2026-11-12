# Building and releasing

For any session that changes this repo, including the cloud build and ship sessions
Cain starts. Two Home Assistant Apps live here:

- `harness/` is the calendar specialist (Python). Slug `0fcc2575_harness`.
- `cain/` is Cain, Dane's chief of staff (bash and Bun/TypeScript). Slug `0fcc2575_cain`.

Home Assistant offers an update when `version` in an App's `config.yaml` changes on
`main`. So `main` is what gets installed: nothing reaches it without passing CI and
without Dane's go.

`main` changes only through pull requests (a GitHub ruleset): no direct pushes from
anyone, laptop sessions included, and a pull request merges only when its branch is up
to date with `main` and these checks pass on it:

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

The ruleset on `main`, as set up:

- Bypass list: empty. Nobody bypasses it, the repository owner included.
- Require a pull request before merging; block force pushes and deletions.
- Require status checks to pass, with "Require branches to be up to date before
  merging" on.
- Required checks `pytest`, `bun` and `pr`, each pinned to the GitHub Actions app as its
  source, so a status posted by anything else can't stand in for one.

Once the ruleset is on, a pull request that changes `.github/workflows/tests.yml`
changes what its own `pytest` and `bun` run; read workflow diffs before Ship.

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
8. Never merge, never push `main`, never force-push. Shipping is a separate step.

## Ship (only after Dane's go)

Dane's go is his tap on Cain's Ship card for that one pull request, at the one head
commit the card was for. The job's text carries that commit's full head sha and his
Ship token: his tap, signed by Cain's link with a key only the link holds, for that
pull request and head, good for 2 hours after the tap.

1. The pull request is open, its head commit is the full head sha in the job's text and
   passed CI, and the diff matches its description. If `main` moved and it no longer
   merges cleanly, or the head isn't that sha, stop and report.
2. Post the Ship token, exactly as given and nothing else, as a comment on the pull
   request: `gh pr comment <number> --body "<token>"`. Where `main` has the `ship`
   check (`.github/workflows/ship.yml`), wait for it to pass on the head: it fails when
   the token isn't his, has run out, or is for another pull request or head, and then
   nothing merges, so stop and report.
3. Squash-merge it into `main`, pinned to that head with GitHub's head match:
   `gh pr merge <number> --squash --match-head-commit <full head sha>`. If GitHub refuses
   because the head moved, nothing is merged: stop and report, and Cain asks again with a
   new Ship card.
4. Wait for CI on `main` to pass.
5. In Home Assistant: check for App updates, then update only the App(s) the pull
   request changed. Nothing else in Home Assistant: no options, no other Apps, no
   services. Never read Cain's App info (`ha_get_app`): it holds his GitHub token.
6. Confirm the new version is running from the update result and the App's log.

## If the Ship key is remade

Cain's App makes a new Ship key only when the old one can't be read, and says so in its
log and to Cain. GitHub checks Ship taps against the public key on `main`
(`.github/ship.pub`), so until that file is the new key (in `/data/trust/ship.pub` on the
Pi, and in the App's log), no Ship tap can approve a merge, including the one that
changes the file. That one pull request changes only `.github/ship.pub`, and ships on
Dane's go with the `ship` check lifted from the ruleset for that one merge and put back
right after.

## Rules for every session

- No secrets in code, commits, logs, pull requests or reports. Don't print tokens.
- Dane's App options are his to change; say which one in the report if one is needed.
- Plain, short reports: what changed, tests and CI, what isn't verified.
