# PC jobs: chores that need a browser signed in as you

Cain has no browser and no site logins. Some chores need one: read an account settings
page, check whether an old login still works, later close an account. Those go through
a small job queue. Cain writes a job; a scheduled task on your PC runs it with Claude in
Chrome, in a Chrome profile of its own, and writes back a short result. Cain reads the
result and tells you what matters.

## Set up once, at your PC

Create a private GitHub repo for the queue, `HyndeSyte/pc-jobs` (another name works:
set `pc_jobs_repo` in Cain's App options to match), with nothing in it. Make Cain's
token for it: a fine-grained token for that one repo, Contents read and write, into
`pc_jobs_token` in Cain's App options. Make the PC's own key: `ssh-keygen -t ed25519 -f
C:/pc-worker/pc-jobs-key`, add the public half in the repo's web page (Settings, Deploy
keys, Add deploy key, with write access), and clone the repo with it to
`C:/pc-worker/queue` (`git clone -c core.sshCommand="ssh -i C:/pc-worker/pc-jobs-key"
git@github.com:HyndeSyte/pc-jobs.git C:/pc-worker/queue`; it may warn that the repo is
empty). Copy Cain's public Ship key (the line "Ship key (public): ..." in Cain's App
log) into `C:/pc-worker/ship.pub`, and `cain/docs/pc-worker/allowlist.example.json` to
`C:/pc-worker/allowlist.json`, naming the one site to test with; only you edit that
file, and the worker refuses anything not on it. In Chrome, add a profile named **Cain
jobs**, sign in there only to the sites the jobs need (never your daily profile, nothing
financial, not your main mail), and install Claude in Chrome in that profile, in ask
mode. In Claude Desktop, add a local scheduled task, **Only on this computer**, every
15 minutes, with the prompt and settings in `cain/docs/pc-worker/prompt.md` (it runs
the worker from your harness tools clone, which needs `bun`). Turn on
**Keep computer awake** in Claude Desktop's settings so the task runs while you're away. Then tell Cain
the queue is ready and which site to probe.

## Proving it works: the probe

The first job is the probe: open one named site's account settings page and report
what it shows (`cain/docs/pc-worker/probe-job.json` shows it as it lands in the queue).
Its result says whether the scheduled task reached Claude in Chrome in the Cain jobs
profile. If it can't, the fallback is Remote Control on the PC; that isn't built.

## How a job runs

- A job names one site, one action and one step: `read` (look and report), `preview`
  (go to an irreversible action's confirmation screen and report it, clicking nothing)
  or `confirm` (the one confirming click). This version runs only `read` jobs: the
  allowlist example holds no other step.
- An irreversible action is always two jobs. The preview reports what the confirmation
  screen shows; then you get a card, and only your tap on it lets Cain write the confirm
  job, carrying your exact words and a token the link signs from your tap. The PC checks
  that token itself, and a tap counts for one confirm only. (The tap card for this isn't
  built yet, so no confirm job can run.)
- Every check is in code (`cain/rootfs/opt/cain/pcjobs/`): Cain's keeper refuses a
  malformed job, a second site or action, and a confirm without a quoted go and a good
  token; the PC refuses expired jobs, jobs already claimed, and anything off its
  allowlist. A claim lasts 30 minutes; one that runs out is closed as "outcome unknown",
  never run twice.
- A result holds a status, the last address, up to 8 short named facts, and one of
  `pending_email_confirmation`, `blocked_captcha`, `outcome_unknown` or `already_gone`
  (which counts as done). Never page text, screenshots or mail.

## The files

- Job, `jobs/<id>.json`: `v`, `id`, `from` (always `cain`), `created`, `expires`
  (15 minutes to 72 hours later), `state` (`pending`, `claimed`, `awaiting_owner`,
  `done`, `failed`), `lease_until` (only while claimed), `site`, `action`, `step`,
  `start_url` (https, on the site), `done_looks_like`, and for a confirm only:
  `follows` (the preview job), `owner_go` (your words, in quotes), `go_token`.
- Result, `results/<id>.json`: `v`, `id`, `status` (`done`, `failed`, `refused`,
  `expired`), `finished`, `final_url`, `facts`, `handoff`, `reason`.
- The PC's allowlist, `allowlist.json`: `{"v": 1, "allow": [{"site", "action", "steps"}]}`.

Cain writes only new job files, through his keeper, which holds the token; the PC
writes claims and results with its deploy key. Nothing else writes the repo.
