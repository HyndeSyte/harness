"""0.24.0, nineteenth round, item 8: --set-aside's progress record is written whole (temp file, fsync, rename, then
its folder fsynced), and one that's there but truncated or unreadable is rebuilt from the copies' checked digests
(noted beside each copy) and the presence of the originals, rather than stopping. All names and ids invented.
"""
import json
import os
import pathlib

from harness import migrate
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_setaside_round18 import BODIES, NAMES, marker_writes, three_to_set_aside
from fake_caldav import no_network  # noqa: F401  (autouse)


def cut_after_first_removal(tmp_path, clock, monkeypatch, build):
    target = three_to_set_aside(tmp_path, clock, monkeypatch, build)
    folder = target.parent
    failing = os.path.join(str(folder), NAMES[1])
    real_remove = os.remove

    def remove(path, *a, **kw):
        if os.path.abspath(path) == failing:
            raise OSError(13, "Permission denied")
        return real_remove(path, *a, **kw)
    monkeypatch.setattr(os, "remove", remove)
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False
    monkeypatch.setattr(os, "remove", real_remove)
    return target, folder


def test_a_truncated_progress_record_is_rebuilt_and_the_run_finishes(tmp_path, clock, monkeypatch):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, "btrunc19")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    progress = pathlib.Path(str(marker) + migrate.SET_ASIDE_PROGRESS)
    whole = progress.read_bytes()
    progress.write_bytes(whole[:len(whole) // 2])                             # torn: half a record
    writes = marker_writes(monkeypatch, target)
    assert not (folder / NAMES[0]).exists()                                   # its original went before the cut
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is True, got
    folders = list(folder.glob("harness-set-aside-*"))
    assert len(folders) == 1 and folders[0].name == got["into"]               # the same folder, found again
    for name in NAMES:
        assert not (folder / name).exists()
        assert (folders[0] / name).read_bytes() == BODIES[name]
    assert len(writes) == 1 and not progress.exists()
    assert "refused" not in json.loads(marker.read_text())


def test_a_rebuilt_record_never_trusts_a_copy_that_no_longer_matches(tmp_path, clock, monkeypatch):
    target, folder = cut_after_first_removal(tmp_path, clock, monkeypatch, "bbad19")
    marker = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    before = marker.read_bytes()
    progress = pathlib.Path(str(marker) + migrate.SET_ASIDE_PROGRESS)
    progress.write_text("{")
    (dest,) = list(folder.glob("harness-set-aside-*"))
    (dest / NAMES[0]).write_bytes(b"damaged")                                 # its original is gone already
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is False and NAMES[0] in got["said"]
    assert marker.read_bytes() == before


def test_the_progress_record_is_written_whole_and_its_folder_fsynced(tmp_path, clock, monkeypatch):
    target = three_to_set_aside(tmp_path, clock, monkeypatch, "bsync19")
    progress = os.path.abspath(str(target) + migrate.SWAP_MARKER + migrate.SET_ASIDE_PROGRESS)
    seen, synced = [], []
    real_write, real_sync = migrate._write_json, migrate._fsync_dir

    def write(path, data):
        seen.append(os.path.abspath(path))
        return real_write(path, data)

    def sync(folder):
        if seen and seen[-1] == progress:
            synced.append(os.path.abspath(folder))
        return real_sync(folder)
    monkeypatch.setattr(migrate, "_write_json", write)
    monkeypatch.setattr(migrate, "_fsync_dir", sync)
    assert migrate.set_aside(str(target), confirm=lambda q: "yes")["ok"] is True
    assert progress in seen and os.path.dirname(progress) in synced
