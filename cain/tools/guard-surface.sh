#!/bin/bash
# The PC worker's guard surface, for the pull request description after a rebase: the hook
# (worker.ts, which holds nav-guard and read-guard), the pinned session settings and the
# pinned Public Suffix List, each with its SHA-256 at HEAD, and the diff of those three
# files against the head the outside review read.
#   cain/tools/guard-surface.sh <reviewed head sha>
# Prints a "PC guard surface" block to paste into the description: the hashes, then either
# "unchanged since <sha>" or the diff's file list and line counts (git diff --stat), then
# the diff itself for the reviewer to read. Nothing is written anywhere.
set -euo pipefail
reviewed="${1:?usage: guard-surface.sh <reviewed head sha>}"
files=(cain/rootfs/opt/cain/pcjobs/worker.ts cain/docs/pc-worker/session-settings.json cain/rootfs/opt/cain/pcjobs/public_suffix_list.dat)
cd "$(git rev-parse --show-toplevel)"
git cat-file -e "$reviewed^{commit}" 2>/dev/null || { echo "not a commit here: $reviewed (fetch it first)" >&2; exit 2; }
echo "PC guard surface at $(git rev-parse --short=12 HEAD), against the reviewed head $(git rev-parse --short=12 "$reviewed"):"
for f in "${files[@]}"; do echo "- $f sha256 $(git show "HEAD:$f" | sha256sum | cut -c1-16)"; done
if git diff --quiet "$reviewed" HEAD -- "${files[@]}"; then
  echo "- unchanged since the reviewed head"
else
  git diff --stat "$reviewed" HEAD -- "${files[@]}" | sed 's/^/- /'
  echo
  git diff "$reviewed" HEAD -- "${files[@]}"
fi
