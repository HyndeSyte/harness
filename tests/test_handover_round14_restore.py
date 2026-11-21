"""0.24.0, fourteenth round: the restore swap, the restore lock, the kept ledger's post-back, the space check and
an interrupted move's marker, from the thirteenth outside review (Nov 16); and the receipt card's renamed button.

Each step of the swap is fsynced and recorded in its marker, and a process killed with SIGKILL at any step is
finished at the next start on the real filesystem; the command line stages under the specialist's own kernel lock;
the kept ledger's log is folded in before held requests are read and each is posted back once; the space check
sizes the log; a marker left after a move that committed is cleared. All names and ids invented.
"""
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import time

import pytest

from harness import calendar_change, migrate
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_handover_round13 import restorable, count, Crash, CLI, APP
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]

# A child process that stops dead (SIGKILL, as power loss or the OOM killer would) at one step of the swap.
KILL_AT = """
import os, signal, sys
sys.path.insert(0, sys.argv[1])
from harness import migrate
step = sys.argv[3]
def at(phase):
    if phase == step:
        os.kill(os.getpid(), signal.SIGKILL)
migrate._swap_step = at
migrate.apply_staged_restore(sys.argv[2])
print("not killed")
"""


def crashed_copy(tmp_path, clock, build="bkill"):
    """A ledger with a restore staged and a non-empty -wal and a -shm beside it, as a killed App leaves them, in a
    folder of its own. Its path."""
    path, led = restorable(tmp_path, clock, build=build)
    assert migrate.stage_restore(str(path), 1, build)["ok"]
    led.db.execute("PRAGMA wal_autocheckpoint=0")
    with led.tx() as db:
        for i in range(20):
            led.event("wal_only", {"i": i}, db=db)
    folder = tmp_path / "crashed"
    folder.mkdir()
    for f in tmp_path.iterdir():
        if f.is_file():
            shutil.copyfile(f, folder / f.name)
    led.db.close()
    target = folder / "harness.sqlite"
    assert os.path.getsize(str(target) + "-wal") > 0 and os.path.exists(str(target) + "-shm")
    return target


def names(folder):
    return sorted(p.name for p in folder.iterdir())


# -- 1. the swap survives a killed process at every step ----------------------------------------------------------

@pytest.mark.parametrize("step", ["marker", "moved", "moved-wal", "moved-shm", "renamed"])
def test_a_swap_killed_at_any_step_is_finished_at_the_next_start(tmp_path, clock, step):
    target = crashed_copy(tmp_path, clock)
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), step],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL, done.stderr
    assert pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()
    plan = json.loads(pathlib.Path(str(target) + migrate.SWAP_MARKER).read_text())
    want = {"marker": [], "moved": ["moved"], "moved-wal": ["moved", "moved-wal"],
            "moved-shm": ["moved", "moved-wal", "moved-shm"],
            "renamed": ["moved", "moved-wal", "moved-shm", "renamed"]}[step]
    assert plan["done"] == want                              # each finished step is on disk in the marker
    got = migrate.apply_staged_restore(str(target))           # the next start, another process's view of the disk
    assert got["ok"] is True, got
    kept = target.parent / got["replaced"]
    for x in ("", "-wal", "-shm"):
        assert pathlib.Path(str(kept) + x).exists()           # paired the way SQLite pairs them
    assert not pathlib.Path(str(target) + "-wal").exists() and not pathlib.Path(str(target) + "-shm").exists()
    assert count(target, "precious") == 1 and count(target, "after_the_move") == 0 and count(target, "wal_only") == 0
    assert count(kept, "wal_only") == 20 and count(kept, "after_the_move") == 1    # its own log went with it
    left = names(target.parent)
    assert not [n for n in left if n.endswith((migrate.SWAP_MARKER, migrate.STAGE_MARKER, migrate.RESTORE_SUFFIX))]
    assert migrate.apply_staged_restore(str(target)) == {}   # nothing repeated
    assert names(target.parent) == left


def test_a_swap_killed_while_rolling_back_finishes_the_roll_back(tmp_path, clock):
    target = crashed_copy(tmp_path, clock, build="brb")
    staged = pathlib.Path(str(target) + migrate.RESTORE_SUFFIX)
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), "moved-wal"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL
    staged.write_bytes(b"SQLite format 3\x00" + b"\x00" * 200)       # damaged since: the resume rolls back
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), "back"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL
    got = migrate.apply_staged_restore(str(target))
    assert got["ok"] is False and got["rolled_back"] is True
    assert count(target, "after_the_move") == 1 and count(target, "wal_only") == 20   # as it was, log and all
    assert not pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()
    assert not list(target.parent.glob("harness-replaced-*"))


def test_every_rename_is_followed_by_a_folder_fsync_before_the_marker_moves_on(tmp_path, clock, monkeypatch):
    target = crashed_copy(tmp_path, clock, build="bsync")
    trail = []
    real_replace, real_remove = os.replace, os.remove
    monkeypatch.setattr(migrate.os, "replace", lambda a, b: (trail.append(("replace", os.path.basename(b))),
                                                              real_replace(a, b))[1])
    monkeypatch.setattr(migrate.os, "remove", lambda p: (trail.append(("remove", os.path.basename(p))),
                                                         real_remove(p))[1])
    real_sync = migrate._fsync_dir
    monkeypatch.setattr(migrate, "_fsync_dir", lambda folder: (trail.append(("fsync",)), real_sync(folder))[1])
    assert migrate.apply_staged_restore(str(target))["ok"]
    moves = [i for i, t in enumerate(trail) if t[0] == "replace" and not t[1].endswith(".json")]
    assert len(moves) == 4                                   # the main file, its -wal, its -shm, the staged file
    for i in moves:
        assert trail[i + 1] == ("fsync",), trail[i:i + 2]
    swap_gone = trail.index(("remove", "harness.sqlite" + migrate.SWAP_MARKER))
    assert ("fsync",) in trail[moves[-1]:swap_gone]
    assert trail[swap_gone + 1] == ("fsync",)


def test_a_resume_never_moves_over_a_file_and_never_opens_beside_a_log_it_doesnt_own(tmp_path, clock):
    target = crashed_copy(tmp_path, clock, build="bown")
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), "renamed"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL
    stray = pathlib.Path(str(target) + "-wal")
    stray.write_bytes(b"not its log")
    with pytest.raises(migrate.SwapRefused):
        migrate.apply_staged_restore(str(target))
    assert stray.read_bytes() == b"not its log"              # nothing opened it or moved it
    assert pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()


def test_the_specialist_starts_degraded_when_the_swap_refuses(tmp_path, clock, monkeypatch):
    from harness import __main__ as main_mod
    target = crashed_copy(tmp_path, clock, build="bdeg")
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), "renamed"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL
    pathlib.Path(str(target) + "-shm").write_bytes(b"x")
    try:
        with pytest.raises(migrate.SwapRefused):
            main_mod.build(str(target.parent), port=0, family_port=0)
    finally:
        migrate.release_process_lock(str(target))


# -- 3. the restore command line takes the specialist's own lock ---------------------------------------------------

PAUSED_STAGE = """
import pathlib, sys, time
sys.path.insert(0, sys.argv[1])
from harness import migrate
flag = pathlib.Path(sys.argv[3])
def at(phase):
    if phase == "locked":
        flag.write_text("in")
        time.sleep(3)
migrate._stage_step = at
got = migrate.stage_restore(sys.argv[2], 1, sys.argv[4], cli=True)
print(__import__("json").dumps(got))
"""

START = """
import json, sys, time
sys.path.insert(0, sys.argv[1])
from harness import migrate
t = time.monotonic()
held = migrate.hold_process_lock(sys.argv[2], wait_s=60)
waited = time.monotonic() - t
got = migrate.apply_staged_restore(sys.argv[2])
print(json.dumps({"held": held, "waited": waited, "got": got}))
"""


def test_a_start_waits_for_a_staging_under_way_and_then_swaps_it_whole(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="brace")
    led.close()
    flag = tmp_path / "staging"
    stager = subprocess.Popen([sys.executable, "-I", "-c", PAUSED_STAGE, str(APP), str(path), str(flag), "brace"],
                              stdout=subprocess.PIPE, text=True)
    try:
        for _ in range(600):
            if flag.exists():
                break
            time.sleep(0.05)
        assert flag.exists()
        start = subprocess.run([sys.executable, "-I", "-c", START, str(APP), str(path)],
                               capture_output=True, text=True, timeout=120)
        out = json.loads(start.stdout)
    finally:
        staged_out = stager.communicate(timeout=120)[0]
    assert json.loads(staged_out)["ok"] is True
    assert out["held"] is True and out["waited"] > 1.0       # it waited on the kernel lock, not a check
    assert out["got"]["ok"] is True                          # and found the staging whole, marker and all
    assert count(path, "after_the_move") == 0 and count(path, "precious") == 1


def test_the_command_line_refuses_when_a_running_specialist_holds_the_lock_in_another_process(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="bheld")
    led.close()
    holder = subprocess.Popen([sys.executable, "-I", "-c",
                               "import sys, time; sys.path.insert(0, sys.argv[1]); from harness import migrate; "
                               "assert migrate.hold_process_lock(sys.argv[2]); print('held', flush=True); "
                               "time.sleep(30)", str(APP), str(path)], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        done = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(path), "--restore", "1", "bheld"],
                              capture_output=True, text=True, timeout=120)
        assert done.returncode == 1 and "Harness is running" in json.loads(done.stdout)["said"]
        assert not pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()
    finally:
        holder.kill()
        holder.wait()


def test_staging_is_refused_while_a_swap_is_unfinished(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="bunf")
    led.close()
    pathlib.Path(str(path) + migrate.SWAP_MARKER).write_text("{}")
    got = migrate.stage_restore(str(path), 1, "bunf", cli=True)
    assert got["ok"] is False and "hasn't finished" in got["said"]


def test_the_degraded_start_lets_go_of_the_lock_so_a_restore_can_be_staged_without_stopping(tmp_path, clock,
                                                                                         monkeypatch):
    from harness import __main__ as main_mod
    path, led = restorable(tmp_path, clock, build="bnoledger")
    led.close()
    assert migrate.hold_process_lock(str(path))
    staged = {}

    class Web:
        def shutdown(self):
            pass
    monkeypatch.setattr(main_mod, "serve", lambda app, port: Web())
    monkeypatch.setattr(main_mod.handover, "serve", lambda inbox, port: None)

    def tick(s):
        if not staged:
            done = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(path), "--restore", "1",
                                   "bnoledger"], capture_output=True, text=True, timeout=120)
            staged["out"] = json.loads(done.stdout)
        os.kill(os.getpid(), signal.SIGTERM)
    monkeypatch.setattr(main_mod.time, "sleep", tick)
    old = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    try:
        main_mod.degraded(str(tmp_path), 0, "the records couldn't be opened (DatabaseError)")
    finally:
        signal.signal(signal.SIGTERM, old[0])
        signal.signal(signal.SIGINT, old[1])
        migrate.release_process_lock(str(path))
    assert staged["out"]["ok"] is True
    assert migrate.restore_staged(str(path))


# -- 5. the kept ledger: its log, its post-back, its pruning --------------------------------------------------------

def kept_with_held_in_wal(folder, name="harness-replaced-20261116T090000Z.sqlite", ids=("p-wal",)):
    """A set-aside ledger whose held requests were committed only in its -wal, copied as a killed App leaves it."""
    work = folder / ("work-" + name)
    work.mkdir()
    live = work / "live.sqlite"
    Ledger(str(live)).close()
    conn = sqlite3.connect(str(live))
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("PRAGMA foreign_keys=OFF")
    for pid in ids:
        conn.execute("INSERT INTO meta(key, value) VALUES (?, ?)",
                     (calendar_change.HELD + pid, json.dumps({"at": "2026-11-16T08:00:00+00:00"})))
        conn.execute("INSERT INTO proposals VALUES (?, 'j', 'calendar_change', ?, 'h', 'p', 'held', 'a', 'b')",
                     (pid, json.dumps({"changes": [{"title": f"Copy me {pid}"}]})))
    conn.commit()
    conn.execute("INSERT INTO meta(key, value) VALUES ('kept_marker', '1')")    # the log is never empty
    conn.commit()
    for x in ("", "-wal", "-shm"):
        shutil.copyfile(str(live) + x, str(folder / name) + x)
    conn.close()
    return folder / name


@pytest.fixture
def copy_line(monkeypatch):
    monkeypatch.setattr(calendar_change, "_copy_line", lambda c, tz: c["title"])


def test_a_held_request_committed_only_in_the_kept_log_comes_back(tmp_path, copy_line):
    kept = kept_with_held_in_wal(tmp_path)
    plain = sqlite3.connect(f"file:{kept}?mode=ro&immutable=1", uri=True)     # the main file alone lacks it
    assert plain.execute("SELECT COUNT(*) FROM meta WHERE key LIKE ?",
                         (calendar_change.HELD + "%",)).fetchone()[0] == 0
    plain.close()
    got = migrate.held_items(str(kept), TZ)
    assert got == [("p-wal", ["• Copy me p-wal"])]
    assert os.path.getsize(str(kept) + "-wal") == 0                            # folded in, TRUNCATE


def restored_ledger(tmp_path, clock, kept, frm="harness-before-s2-b-x.sqlite"):
    led = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    migrate._write_json(str(tmp_path / "harness.sqlite") + migrate.RESTORED,
                        {"from": frm, "kept": kept.name, "at": "20261116T090000Z"})
    return led


def notices_text(led):
    return [r[0] for r in led.db.execute("SELECT text FROM outbox ORDER BY id")]


@pytest.mark.parametrize("stop", ["posted:summary", "posted:p-a", "posted:p-b", "enqueue"])
def test_a_stop_during_the_post_back_neither_duplicates_nor_loses_a_held_request(tmp_path, clock, copy_line,
                                                                                monkeypatch, stop):
    kept = kept_with_held_in_wal(tmp_path, ids=("p-a", "p-b"))
    led = restored_ledger(tmp_path, clock, kept)
    if stop == "enqueue":
        real = led.enqueue
        calls = []

        def once(**kw):
            calls.append(1)
            if len(calls) == 2:
                raise Crash("between the marker and the post")
            return real(**kw)
        monkeypatch.setattr(led, "enqueue", once)
    else:
        monkeypatch.setattr(migrate, "_swap_step", lambda phase: (_ for _ in ()).throw(Crash(phase))
                            if phase == stop else None)
    with pytest.raises(Crash):
        migrate.after_restore(led, OWNER, TZ)
    monkeypatch.undo()
    monkeypatch.setattr(calendar_change, "_copy_line", lambda c, tz: c["title"])
    got = migrate.after_restore(led, OWNER, TZ)                                  # the next start
    assert got["held"] == 2
    said = notices_text(led)
    assert sum("records are back" in t for t in said) == 1
    assert sum("Copy me p-a" in t for t in said) == 1 and sum("Copy me p-b" in t for t in said) == 1
    mark = json.loads(pathlib.Path(str(kept) + migrate.POSTBACK).read_text())
    assert mark["done"] is True and sorted(mark["posted"]) == ["p-a", "p-b", "summary"]
    assert migrate.after_restore(led, OWNER, TZ) == {}


def test_older_kept_sets_are_pruned_after_the_post_back_keeping_the_latest(tmp_path, clock, copy_line):
    old = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261101T090000Z.sqlite", ids=())
    new = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite")
    assert migrate.prune_kept(str(tmp_path)) == []                     # not before the newest is posted back
    led = restored_ledger(tmp_path, clock, new)
    migrate.after_restore(led, OWNER, TZ)
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(old.name)]
    for x in ("", "-wal", "-shm", migrate.POSTBACK):
        assert pathlib.Path(str(new) + x).exists()


def test_kept_sets_are_named_in_the_space_check(tmp_path, monkeypatch):
    kept_with_held_in_wal(tmp_path)
    led = Ledger(str(tmp_path / "harness.sqlite"))
    monkeypatch.setattr(migrate, "_free_bytes", lambda folder: 1024)
    said = migrate.space_problem(led.path)
    assert "set aside by a restore" in said
    led.close()


# -- 7. the space check sizes the log too ------------------------------------------------------------------------

def test_the_space_check_sizes_the_main_file_and_its_log(tmp_path, monkeypatch):
    led = Ledger(str(tmp_path / "harness.sqlite"))
    led.db.execute("PRAGMA wal_autocheckpoint=0")
    with led.tx() as db:
        for i in range(400):
            led.event("bulk", {"pad": "x" * 2000, "i": i}, db=db)
    main = os.path.getsize(led.path)
    wal = os.path.getsize(led.path + "-wal")
    assert wal > main
    monkeypatch.setattr(migrate, "_free_bytes", lambda folder: 2 * main + migrate.SPACE_MARGIN + 1)
    assert "free space" in migrate.space_problem(led.path)         # the log counts
    migrate.checkpoint(led)
    assert os.path.getsize(led.path + "-wal") == 0                  # TRUNCATE: folded in and emptied
    led.close()


# -- 8. a marker left after a move that had committed ----------------------------------------------------------------

@pytest.mark.migrate_gate
def test_a_marker_left_after_the_move_committed_is_cleared_and_the_start_is_normal(ledger):
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="bdone")
    assert got["backup"] and migrate.schema(ledger) == migrate.HANDOVER
    marker = ledger.path + migrate.MIGRATING
    migrate._write_json(marker, {"build": "bdone", "at": "2026-11-16T09:00:00+00:00"})   # the stop came here
    out = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="bdone")
    assert not out.get("waiting") and not os.path.exists(marker)
    assert not migrate.waiting(ledger)
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='migration_marker_settled'").fetchone()[0] == 1
    assert not ledger.db.execute("SELECT 1 FROM choices WHERE kind='migration_check'").fetchone()


@pytest.mark.migrate_gate
def test_a_marker_from_a_move_that_never_committed_still_waits_degraded(ledger):
    marker = ledger.path + migrate.MIGRATING
    migrate._write_json(marker, {"build": "bnot", "at": "2026-11-16T09:00:00+00:00"})
    out = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="bnot")
    assert out["waiting"] and os.path.exists(marker) and migrate.waiting(ledger)["degraded"] is True


@pytest.mark.migrate_gate
def test_a_marker_on_records_that_fail_their_integrity_check_waits_degraded(ledger, monkeypatch):
    migrate.run_live(ledger, None, OWNER, version="0.24.0", build="bbad")
    marker = ledger.path + migrate.MIGRATING
    migrate._write_json(marker, {"build": "bbad"})
    real = ledger.db

    class Damaged:
        def __getattr__(self, name):
            return getattr(real, name)

        def execute(self, sql, *a):
            if "integrity_check" in sql:
                return real.execute("SELECT 'row 3 missing from index'")
            return real.execute(sql, *a)
    monkeypatch.setattr(ledger, "db", Damaged())
    out = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="bbad")
    assert out["waiting"] and "integrity" in out["why"] and os.path.exists(marker)


# -- 9. the receipt card's button says what it does ------------------------------------------------------------------

def test_the_receipt_cards_third_button_is_not_this_time_everywhere():
    from harness import meaning_live
    shipped = [ROOT / "harness" / "app", ROOT / "cain" / "rootfs", ROOT / "harness" / "DOCS.md",
               ROOT / "tests" / "message_rules.py"]
    for where in shipped:
        files = [where] if where.is_file() else [p for p in where.rglob("*") if p.is_file()]
        for f in files:
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            assert "Just this once" not in text and "just this once" not in text, f
    src = pathlib.Path(meaning_live.__file__).read_text()
    assert '("Not this time", "once")' in src
    assert "Not this time" in (ROOT / "harness" / "DOCS.md").read_text()
