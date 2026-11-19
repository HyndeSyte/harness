"""Family writes against the installed release (Harness 0.24.0, sixth and seventh rounds).

The recorded feeds (full, cut short, split, cancellation, five gone at once) through this head's sync
loop with the drive dry run on write to Google exactly what the installed release's Family path wrote
(method, title, start, end, read by read) and make exactly as many map lookups on the Family path. The
dry run's own lookups (it looks his drives up) are counted apart and its writes for him are none. The
release's own run is the fixture tests/tools/family_replay_main.json, made by
tests/tools/family_replay.py --record from the release's tag or commit (never main): the CI checkout has
no release to import (see that file).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, plain_prompt, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_meaning_live import drives, live  # noqa: F401

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))

import family_replay  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
# The installed release. The repository has no release tags (the CI checkout has none either), so the
# commit is hard-coded with the tag name it will have: the last commit on main that changed harness/.
INSTALLED_TAG = "harness-0.24.1"
INSTALLED_COMMIT = "5b58cf2a20f68ecae99d5144ebbf2ebb645f45a5"


def _git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def test_the_dry_run_writes_to_google_and_looks_up_exactly_what_the_installed_release_does(drives, monkeypatch):
    installed = json.loads(family_replay.FIXTURE.read_text())
    head = family_replay.scenario(drives, monkeypatch, dry=True)
    assert head["writes"] == installed["writes"]           # the Family path's writes, read by read
    assert head["lookups"] == installed["lookups"]         # the Family path's map lookups
    assert head["own_writes"] == []                        # the dry run writes nothing for his appointments
    assert head["own_lookups"] > 0                         # and it does look his drives up
    assert any(w[1] == "Busy (drive there)" for read in installed["writes"] for w in read)   # Family's drives


def test_the_fixture_was_recorded_from_the_installed_release():
    header = json.loads(family_replay.FIXTURE.read_text())["recorded_from"]
    assert header["commit"] == INSTALLED_COMMIT == family_replay.RELEASE_COMMIT
    assert header["tag"] == INSTALLED_TAG == family_replay.RELEASE_TAG
    # The release named is the one below this branch's newest CHANGELOG section: what main installs now.
    versions = re.findall(r"^## (\d+\.\d+\.\d+)", (ROOT / "harness" / "CHANGELOG.md").read_text(), re.M)
    assert header["release"] == f"Harness {versions[1]}"
    # Where the checkout has them: the newest Harness release tag, and the commit's own config.yaml.
    tags = [t for t in _git("tag", "--list", "harness-*").stdout.split() if re.fullmatch(r"harness-\d+\.\d+\.\d+", t)]
    if tags:
        newest = max(tags, key=lambda t: tuple(int(x) for x in t.split("-")[1].split(".")))
        assert _git("rev-parse", f"{newest}^{{commit}}").stdout.strip() == header["commit"]
    shown = _git("show", f"{header['commit']}:harness/config.yaml")
    if shown.returncode == 0:
        assert f'version: "{versions[1]}"' in shown.stdout
