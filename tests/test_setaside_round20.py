"""0.24.0, twentieth round, item 8: a set-aside copy that's damaged while its original is gone is never dropped
silently: the loss is recorded in the progress record, the answer names the item that has neither a good copy nor
an original, and the swap marker and the live records are left untouched. The command line alone runs it, never a
start. The progress record's folder fsync is the one inside the atomic write (no second one), and the test fails if
it's removed. All names and ids invented.
"""
import json
import os
import pathlib
import re

from harness import migrate
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_setaside_round18 import NAMES, three_to_set_aside
from test_setaside_round19 import cut_after_first_removal
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_a_damaged_copy_whose_original_is_gone_is_recorded_and_named(tmp_path, clock, monkeypatch):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, "blost20")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    progress = pathlib.Path(str(marker) + migrate.SET_ASIDE_PROGRESS)
    progress.write_text("{")                                                  # torn: rebuilt from the folder
    (dest,) = list(folder.glob("harness-set-aside-*"))
    (dest / NAMES[0]).write_bytes(b"damaged")                                 # its original is gone already
    before_marker, before_live = marker.read_bytes(), target.read_bytes()
    others = {n: (folder / n).read_bytes() for n in NAMES[1:]}
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and got["lost"] == [NAMES[0]]
    assert "neither a good copy" in got["said"] and NAMES[0] in got["said"]
    assert "can't be set aside by this command" not in got["said"]           # not a generic refusal
    assert json.loads(progress.read_text())["lost"] == [NAMES[0]]            # the loss is recorded
    assert marker.read_bytes() == before_marker and target.read_bytes() == before_live
    assert {n: (folder / n).read_bytes() for n in NAMES[1:]} == others        # nothing else moved


def test_a_recorded_loss_is_named_again_on_the_next_run(tmp_path, clock, monkeypatch):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, "blost20b")
    progress = pathlib.Path(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    (dest,) = list(folder.glob("harness-set-aside-*"))
    (dest / NAMES[0]).write_bytes(b"damaged")                                 # the record reads whole this time
    first = migrate.set_aside(str(target), confirm=lambda q: "yes")
    second = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert first["lost"] == second["lost"] == [NAMES[0]]
    assert json.loads(progress.read_text())["lost"] == [NAMES[0]]


def test_set_aside_runs_only_from_the_command_line():
    src = (ROOT / "harness/app/harness/migrate.py").read_text()
    calls = [m.start() for m in re.finditer(r"(?<![\w.])set_aside\(", src)]
    main_at = src.index("got = set_aside(args[0])")
    assert [c for c in calls if c != src.index("def set_aside(") + 4] == [main_at + 6]
    for f in (ROOT / "harness/app/harness").glob("*.py"):
        if f.name != "migrate.py":
            assert "set_aside(" not in f.read_text(), f.name


def test_each_progress_write_fsyncs_its_folder_inside_the_atomic_write_once(tmp_path, clock, monkeypatch):
    target = three_to_set_aside(tmp_path, clock, monkeypatch, "bsync20")
    progress = os.path.abspath(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    inside = {"path": None}
    per_write: list[int] = []
    real_write, real_sync = migrate._write_json, migrate._fsync_dir

    def write(path, data):
        inside["path"] = os.path.abspath(path)
        if inside["path"] == progress:
            per_write.append(0)
        try:
            return real_write(path, data)
        finally:
            inside["path"] = None

    def sync(folder):
        if inside["path"] == progress and os.path.abspath(folder) == os.path.dirname(progress):
            per_write[-1] += 1
        return real_sync(folder)
    monkeypatch.setattr(migrate, "_write_json", write)
    monkeypatch.setattr(migrate, "_fsync_dir", sync)
    assert migrate.set_aside(str(target), confirm=lambda q: "yes")["ok"] is True
    assert per_write and all(n == 1 for n in per_write), per_write          # inside each write, exactly once
    assert not hasattr(migrate, "_write_progress")                           # no second wrapper fsyncing again
