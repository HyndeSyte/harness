"""0.24.0, twenty-second round, item 6: the set-aside digest rule applies to every loaded progress record.

A readable progress record whose file entry has a null or missing digest is unverified: never trusted as a checked
copy, never a crash, and named in the answer (as lost, and why), as a torn record rebuilt from the folder already was.
All names and ids invented.
"""
import json
import pathlib

import pytest

from harness import migrate
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_setaside_round18 import NAMES
from test_setaside_round19 import cut_after_first_removal
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.mark.parametrize("how", ["null", "missing"])
def test_a_readable_record_with_no_digest_is_named_as_unverified(tmp_path, clock, monkeypatch, how):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, f"bnull22{how[0]}")
    progress = pathlib.Path(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    rec = json.loads(progress.read_text())
    assert isinstance(rec["files"][NAMES[0]]["digest"], str)                  # it was checked
    if how == "null":
        rec["files"][NAMES[0]]["digest"] = None
    else:
        del rec["files"][NAMES[0]]["digest"]
    progress.write_text(json.dumps(rec))                                       # readable, whole
    assert not (folder / NAMES[0]).exists()                                    # its original is gone
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False                                                  # never trusted as moved
    assert got["lost"] == [NAMES[0]] and got["unverified"] == [NAMES[0]]
    assert "has no digest note" in got["said"] and NAMES[0] in got["said"]
    again = json.loads(progress.read_text())
    assert again["unverified"] == [NAMES[0]]                                   # recorded with the loss
