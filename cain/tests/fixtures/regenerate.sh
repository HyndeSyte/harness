#!/usr/bin/env bash
# Rebuilds the roll-forward fixtures (link-<version>/core.ts, keeper-<version>/core.ts and main.ts)
# from a given commit of this repository, so the previous link and keeper the tests run are main as it
# stands. Run from the repository root after any rebase onto main:
#   bash cain/tests/fixtures/regenerate.sh "$(git rev-parse origin/main)" <version on that main> [out dir]
# The link's core keeps its own imports pointed at this tree's modules (the gate, merge.ts and the rest
# are unchanged between the versions it is tested against); the keeper's two files are copied as they
# are. Each file gets a header naming the commit it came from. Nothing else is changed.
set -euo pipefail
commit="${1:?usage: regenerate.sh <commit> <version> [out dir]}"
version="${2:?usage: regenerate.sh <commit> <version> [out dir]}"
out="${3:-cain/tests/fixtures}"
commit="$(git rev-parse --verify "${commit}^{commit}")"
src=cain/rootfs/opt/cain
mkdir -p "$out/link-$version" "$out/keeper-$version"
{
  printf '%s\n' "// Cain's link as of main at Cain $version (commit $commit; its core, imports pointed at this tree's unchanged modules),"
  printf '%s\n' "// for the roll-forward tests: the previous link must start on, and ignore, the state this version"
  printf '%s\n' "// writes. Rebuilt by cain/tests/fixtures/regenerate.sh; never edited by hand."
  git show "$commit:$src/link/core.ts" | sed -E \
    -e 's#from "\.\./([^"]+)"#from "../../../rootfs/opt/cain/\1"#' \
    -e 's#from "\./([^"]+)"#from "../../../rootfs/opt/cain/link/\1"#'
} > "$out/link-$version/core.ts"
for f in core.ts main.ts; do
  {
    printf '%s\n' "// The record keeper as of main at Cain $version (commit $commit; unchanged copy), for the"
    printf '%s\n' "// roll-forward tests: the previous version must tolerate the ledger's files. Rebuilt by"
    printf '%s\n' "// cain/tests/fixtures/regenerate.sh; never edited by hand."
    git show "$commit:$src/record/$f"
  } > "$out/keeper-$version/$f"
done
echo "rebuilt link-$version and keeper-$version from $commit into $out"
