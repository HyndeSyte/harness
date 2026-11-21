"""0.24.0, eighteenth round: --set-aside resumes after a removal that fails part way.

10. The copies are made and checked, then the originals are removed one by one. A removal that fails leaves the
    swap marker as it was; the next run finds the earlier folder through the progress record kept beside the swap
    marker, accepts each checked copy whose original is already gone, finishes the remaining removals and only
    then updates the marker, once. A copy that was never checked whose original is gone is a hard stop: nothing
    more is removed and the marker is unchanged.
All names and ids invented.
"""
import hashlib
import json
import os
import pathlib
import shutil

import pytest

from harness import migrate
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_handover_round15_restore import refused_for_a_foreign_log
from fake_caldav import no_network  # noqa: F401  (autouse)

NAMES = ["harness.sqlite-wal", "harness.sqlite-shm", "harness.sqlite-extra"]
BODIES = {"harness.sqlite-wal": b"not its log", "harness.sqlite-shm": b"not its shared memory",
          "harness.sqlite-extra": b"a third foreign file"}


def three_to_set_aside(tmp_path, clock, monkeypatch, build):
    """A refused swap with three files to set aside: the foreign log, a foreign -shm (both found by the swap's own
    state) and a third plain file the conflict finder is widened to report while it exists."""
    target, stray = refused_for_a_foreign_log(tmp_path, clock, build)
    folder = target.parent
    (folder / "harness.sqlite-shm").write_bytes(BODIES["harness.sqlite-shm"])
    (folder / "harness.sqlite-extra").write_bytes(BODIES["harness.sqlite-extra"])
    real = migrate.swap_conflicts

    def conflicts(base, plan):
        movable, protected = real(base, plan)
        extra = os.path.join(os.path.dirname(base), "harness.sqlite-extra")
        return movable + (["harness.sqlite-extra"] if os.path.lexists(extra) else []), protected
    monkeypatch.setattr(migrate, "swap_conflicts", conflicts)
    return target


def marker_writes(monkeypatch, target):
    swap = os.path.abspath(str(target) + migrate.SWAP_MARKER)
    writes = []
    real = migrate._write_json

    def write(path, data):
        if os.path.abspath(path) == swap:
            writes.append(dict(data))
        return real(path, data)
    monkeypatch.setattr(migrate, "_write_json", write)
    return writes


@pytest.mark.parametrize("k", [1, 2, 3])
def test_a_removal_that_fails_is_finished_by_the_next_run(tmp_path, clock, monkeypatch, k):
    target = three_to_set_aside(tmp_path, clock, monkeypatch, f"bresume{k}")
    folder = target.parent
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    before_marker = marker.read_bytes()
    writes = marker_writes(monkeypatch, target)
    failing = os.path.join(str(folder), NAMES[k - 1])
    real_remove = os.remove

    def remove(path, *a, **kw):
        if os.path.abspath(path) == failing:
            raise OSError(13, "Permission denied")
        return real_remove(path, *a, **kw)
    monkeypatch.setattr(os, "remove", remove)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and "the swap marker is as it was" in got["said"]
    assert marker.read_bytes() == before_marker and writes == []              # not updated before the end
    for name in NAMES[:k - 1]:
        assert not (folder / name).exists()                                   # removed before the failure
    for name in NAMES[k - 1:]:
        assert (folder / name).exists()
    monkeypatch.setattr(os, "remove", real_remove)

    got = migrate.set_aside(str(target), confirm=lambda q: "yes")             # the second run
    assert got["ok"] is True, got
    assert sorted(got["moved"]) == sorted(NAMES)
    folders = list(folder.glob("harness-set-aside-*"))
    assert len(folders) == 1 and folders[0].name == got["into"]               # the earlier attempt's folder
    for name in NAMES:
        assert not (folder / name).exists()                                   # every original gone
        assert (folders[0] / name).read_bytes() == BODIES[name]               # every copy there and whole
    assert len(writes) == 1                                                   # the marker updated once, at the end
    plan = json.loads(marker.read_text())
    assert "refused" not in plan and "conflict" not in plan
    assert not pathlib.Path(str(marker) + ".set-aside").exists()              # the progress record is done with


def test_a_copy_never_checked_whose_original_is_gone_is_a_hard_stop(tmp_path, clock, monkeypatch):
    target = three_to_set_aside(tmp_path, clock, monkeypatch, "bunchecked")
    folder = target.parent
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    before_marker = marker.read_bytes()
    writes = marker_writes(monkeypatch, target)
    real_copy = shutil.copy2

    def killed(src, dst):
        if os.path.basename(src) == "harness.sqlite-shm":
            with open(dst, "wb") as f:
                f.write(b"not")                                               # cut off part way
            raise SystemExit("killed")                                        # the process dies: nothing tidied
        return real_copy(src, dst)
    monkeypatch.setattr(shutil, "copy2", killed)
    with pytest.raises(SystemExit):
        migrate.set_aside(str(target), confirm=lambda q: "yes")
    monkeypatch.setattr(shutil, "copy2", real_copy)
    (folder / "harness.sqlite-shm").unlink()                                  # its original gone by hand
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False
    assert "harness.sqlite-shm" in got["said"] and "the swap marker is as it was" in got["said"]
    assert (folder / "harness.sqlite-wal").read_bytes() == BODIES["harness.sqlite-wal"]       # nothing more removed
    assert (folder / "harness.sqlite-extra").read_bytes() == BODIES["harness.sqlite-extra"]
    assert marker.read_bytes() == before_marker and writes == []

