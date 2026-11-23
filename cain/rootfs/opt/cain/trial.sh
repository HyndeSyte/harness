#!/bin/bash
# Cain's way to run a model trial and read it back (trials/cli.ts; the trials runner in the review
# runner's process makes the calls, under the trials budget).
#   trial.sh plan <suite> [questions.json]   every call the suite would make, its limits and worst-case cost; no call
#   trial.sh run <suite> [--retry] [--new]   (research: the record's questions, once the owner approved them)
#   trial.sh status | result <suite> | report <suite>
# Suites: review-seats, research. No keys here: they live only in the review runner's environment.
exec bun /opt/cain/trials/cli.ts "$@"
