#!/bin/bash
# Cain's way to ask for an outside-model review (review/main.ts runs them).
#   review.sh submit <brief.json>     queue a brief; prints its id
#   review.sh status <id>             the review and each seat, with any fix
#   review.sh result <id>             the machine-readable result, once finished
#   review.sh useful <id> <seat> <n>  how many of a seat's findings were adopted
#   review.sh spend | health          this month's spend per seat against the runner's caps, and the
#                                     round count per open change; the nightly seat check
#   review.sh guard                   the usage guard's reading, in two lines
#   review.sh sweep-dry-run           the replay of grants from before grants were bound, on copies; writes nothing
#   review.sh host-read <pr>          GitHub's read of a pull request through the API and through the refs
# No keys here: they live only in the review runner's environment.
exec bun /opt/cain/review/cli.ts "$@"
