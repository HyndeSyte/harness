"""0.24.0, twenty-first round, item 8: a set-aside loss can be accepted from the command line.

- --set-aside --accept-lost <name> records a file an earlier run recorded as lost as accepted (in the progress record
  and beside the copies), moves nothing, and leaves the live records and the swap marker untouched; the next
  --set-aside goes on without it and finishes the rest.
- A name that isn't recorded as lost is refused, and nothing is recorded.
- A copy with no digest note is unverified: when its original is gone, the answer names it (as lost, and why),
  never skipping it.
All names and ids invented.
"""
import json
import os
import pathlib
import subprocess
import sys

from harness import migrate
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_setaside_round18 import NAMES
from test_setaside_round19 import cut_after_first_removal
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]


def lost_first(tmp_path, clock, monkeypatch, build):
    """A run cut after its first removal, then that file's copy damaged: recorded as lost by the next run."""
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, build)
    (dest,) = list(folder.glob("harness-set-aside-*"))
    (dest / NAMES[0]).write_bytes(b"damaged")
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["lost"] == [NAMES[0]] and "--accept-lost" in got["said"]       # the command is named
    return target, folder, dest


def test_an_accepted_loss_lets_the_next_run_finish(tmp_path, clock, monkeypatch):
    target, folder, dest = lost_first(tmp_path, clock, monkeypatch, "bacc21")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    progress = pathlib.Path(str(marker) + migrate.SET_ASIDE_PROGRESS)
    before_marker, before_live = marker.read_bytes(), target.read_bytes()
    others = {n: (folder / n).read_bytes() for n in NAMES[1:]}
    got = migrate.accept_lost(str(target), NAMES[0])
    assert got["ok"] is True and got["accepted"] == [NAMES[0]]
    assert marker.read_bytes() == before_marker and target.read_bytes() == before_live   # untouched
    assert {n: (folder / n).read_bytes() for n in NAMES[1:]} == others                  # nothing moved
    rec = json.loads(progress.read_text())
    assert rec["accepted"] == [NAMES[0]] and NAMES[0] not in rec["lost"]
    done = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert done["ok"] is True, done                                           # the rest finishes
    for name in NAMES[1:]:
        assert not (folder / name).exists() and (dest / name).exists()
    assert marker.read_bytes() != before_marker                               # the refusal cleared at last


def test_an_accepted_loss_survives_a_torn_progress_record(tmp_path, clock, monkeypatch):
    target, folder, dest = lost_first(tmp_path, clock, monkeypatch, "bacc21b")
    assert migrate.accept_lost(str(target), NAMES[0])["ok"] is True
    progress = pathlib.Path(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    progress.write_text("{")                                                  # torn: rebuilt from the folder
    done = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert done["ok"] is True, done


def test_a_name_not_recorded_as_lost_is_refused(tmp_path, clock, monkeypatch):
    target, folder, dest = lost_first(tmp_path, clock, monkeypatch, "bacc21c")
    progress = pathlib.Path(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    before = progress.read_bytes()
    for name in (NAMES[1], "harness.sqlite", "../elsewhere"):
        got = migrate.accept_lost(str(target), name)
        assert got["ok"] is False and "isn't recorded as lost" in got["said"]
    assert progress.read_bytes() == before


def test_a_copy_with_no_digest_note_is_named_as_unverified(tmp_path, clock, monkeypatch):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, "bnote21")
    progress = pathlib.Path(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    progress.write_text("{")                                                  # torn: rebuilt from the folder
    (dest,) = list(folder.glob("harness-set-aside-*"))
    os.remove(dest / ("." + NAMES[0] + migrate.SET_ASIDE_DIGEST))             # its copy can't be checked now
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and got["lost"] == [NAMES[0]] and got["unverified"] == [NAMES[0]]
    assert "has no digest note" in got["said"] and NAMES[0] in got["said"]


def test_the_command_line_takes_accept_lost(tmp_path, clock, monkeypatch):
    target, folder, dest = lost_first(tmp_path, clock, monkeypatch, "bacc21d")
    run = subprocess.run([sys.executable, "-m", "harness.migrate", str(target), "--set-aside", "--accept-lost",
                          NAMES[0]], cwd=str(ROOT / "harness/app"), capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout)["accepted"] == [NAMES[0]]
    src = (ROOT / "harness/app/harness/migrate.py").read_text()
    assert "got = accept_lost(args[0], args[3])" in src
    for f in (ROOT / "harness/app/harness").glob("*.py"):
        if f.name != "migrate.py":
            assert "accept_lost(" not in f.read_text(), f.name               # never at a start
