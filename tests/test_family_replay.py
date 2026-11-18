"""Family writes against the installed release (Harness 0.24.0, sixth round).

The recorded feeds (full, cut short, split, cancellation, five gone at once) through this head's sync
loop with the drive dry run on write to Google exactly what main's Family path wrote (method, title,
start, end, read by read) and make exactly as many map lookups. Main's own run is the fixture
tests/tools/family_replay_main.json, made by tests/tools/family_replay.py --record: the CI checkout
has no main to import (see that file).
"""
import json
import sys
from pathlib import Path

from fake_caldav import no_network  # noqa: F401  (autouse)
from test_family_add import on, plain_prompt, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_meaning_live import drives, live  # noqa: F401

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))

import family_replay  # noqa: E402


def test_the_dry_run_writes_to_google_and_looks_up_exactly_what_the_installed_release_does(drives, monkeypatch):
    installed = json.loads(family_replay.FIXTURE.read_text())
    head = family_replay.scenario(drives, monkeypatch, dry=True)
    assert head["writes"] == installed["writes"]
    assert head["lookups"] == installed["lookups"]
    assert any(w[1] == "Busy (drive there)" for read in installed["writes"] for w in read)   # Family's drives
