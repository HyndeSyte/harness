"""0.24.0, fifteenth round: the restore's defects from the fourteenth outside review (Nov 16).

4. A kept set is pruned only once its own post-back marker says done; every set not done is posted back, oldest
   first: two restores in a row with the first post-back cut short bring both sets' held requests back, once each.
6. An unreadable swap marker (corrupt or cut short) at any step of a swap is never deleted and nothing moves: the
   start is degraded, with the files at the live and kept names listed (status page, python3 -m harness.migrate).
9. A start that waited LOCK_WAIT_S on a restore being staged goes degraded, tries the lock again on a timer, shows
   the wait, and starts normally by itself once the staging is done.
13. A swap refused for a foreign log gets python3 -m harness.migrate <records> --set-aside: the files it named move
   into a dated folder after a typed yes, the refusal is cleared, and the next start finishes the swap; the
   degraded start posts one best-effort note through Cain's link.
All names and ids invented.
"""
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys

import pytest

from harness import migrate
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import TZ  # noqa: F401
from test_handover_round13 import CLI, APP, Crash, restorable
from test_handover_round14_restore import KILL_AT, crashed_copy, kept_with_held_in_wal, notices_text
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def copy_line(monkeypatch):
    from harness import calendar_change
    monkeypatch.setattr(calendar_change, "_copy_line", lambda c, tz: c["title"])


def snapshot(folder: pathlib.Path) -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()}


def killed_at(tmp_path, clock, step, build):
    target = crashed_copy(tmp_path, clock, build=build)
    done = subprocess.run([sys.executable, "-I", "-c", KILL_AT, str(APP), str(target), step],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == -signal.SIGKILL
    return target


# -- 6. an unreadable swap marker ----------------------------------------------------------------------------------

@pytest.mark.parametrize("step", ["marker", "moved", "moved-wal", "moved-shm", "renamed"])
@pytest.mark.parametrize("damage", ["corrupt", "truncated"])
def test_an_unreadable_swap_marker_moves_nothing_deletes_nothing_and_lists_the_files(tmp_path, clock, step, damage):
    target = killed_at(tmp_path, clock, step, build=f"bm{step.replace('-', '')}{damage[0]}")
    swap = pathlib.Path(str(target) + migrate.SWAP_MARKER)
    whole = swap.read_bytes()
    swap.write_bytes(b"\x00\x13{not json" if damage == "corrupt" else whole[: len(whole) // 2])
    before = snapshot(target.parent)
    with pytest.raises(migrate.SwapRefused) as e:
        migrate.apply_staged_restore(str(target))
    assert "marker can't be read" in str(e.value)
    assert snapshot(target.parent) == before                                 # nothing moved, nothing deleted
    listed = " ".join(e.value.files)
    assert "harness.sqlite.swap.json" in listed
    if step != "marker":
        assert "harness-replaced-" in listed                                 # the kept name's files too
    out = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(target), "--swap"],
                         capture_output=True, text=True, timeout=120)
    got = json.loads(out.stdout)
    assert got["swap_marker"] is True and got["marker_readable"] is False and got["files"] == e.value.files
    assert snapshot(target.parent) == before


def test_the_start_is_degraded_with_the_listing_on_the_status_page(tmp_path, clock, monkeypatch):
    from harness import __main__ as main_mod
    target = killed_at(tmp_path, clock, "moved-wal", build="bmlist")
    pathlib.Path(str(target) + migrate.SWAP_MARKER).write_text("{")
    try:
        with pytest.raises(migrate.SwapRefused) as e:
            main_mod.build(str(target.parent), port=0, family_port=0)
    finally:
        migrate.release_process_lock(str(target))
    page = run_degraded(monkeypatch, tmp_path, target.parent, str(e.value), files=e.value.files)
    assert page["migration"]["files"] == e.value.files
    assert pathlib.Path(str(target) + migrate.SWAP_MARKER).read_text() == "{"
    src = (APP / "harness" / "__main__.py").read_text()
    assert 'files=getattr(e, "files", None)' in src


# Sixteenth round: the atomic marker write is tested by failing its write, fsync and rename (test_handover_round16_restore.py).


# -- 9. a staging slower than the lock wait ---------------------------------------------------------------------------

class Web:
    def __init__(self, app=None):
        self.app = app

    def shutdown(self):
        pass


def run_degraded(monkeypatch, tmp_path, folder, why, *, lock_wait=False, files=None, release=None, notes=None):
    """degraded() in this (main) thread, with its page captured, stopped after a few turns (or once the lock is
    free). Its status dict."""
    from harness import __main__ as main_mod
    seen = {}

    def serve(app, port):
        seen["status"] = app.status
        return Web(app)
    monkeypatch.setattr(main_mod, "serve", serve)
    monkeypatch.setattr(main_mod.handover, "serve", lambda inbox, port: None)
    monkeypatch.setattr(main_mod, "LOCK_RETRY_S", 0.05)
    if notes is not None:
        class Chat:
            def __init__(self, link):
                pass

            def send_message(self, chat_id, text, buttons=None, **kw):
                notes.append(text)
                return 1

            def answer_callback(self, callback, text=None):
                pass
        monkeypatch.setattr(main_mod, "LinkChat", Chat)
    turns = []
    real_sleep = main_mod.time.sleep

    def tick(s):
        turns.append(1)
        if release is not None and len(turns) == 2:
            release()
        if len(turns) > 40:
            os.kill(os.getpid(), signal.SIGTERM)
        real_sleep(0.02)
    monkeypatch.setattr(main_mod.time, "sleep", tick)
    old = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    try:
        seen["out"] = main_mod.degraded(str(folder), 0, why, lock_wait=lock_wait, files=files)
    finally:
        signal.signal(signal.SIGTERM, old[0])
        signal.signal(signal.SIGINT, old[1])
    return {**seen["status"], "out": seen["out"]}


def test_a_staging_past_the_wait_goes_degraded_then_starts_by_itself(tmp_path, clock, monkeypatch):
    from harness import __main__ as main_mod
    path, led = restorable(tmp_path, clock, build="bslow")
    led.close()
    monkeypatch.setattr(migrate, "LOCK_WAIT_S", 0.2)
    stager = migrate._try_lock(str(tmp_path))                                # a restore being staged, slowly
    assert stager is not None
    with pytest.raises(migrate.LockBusy) as e:
        main_mod.build(str(tmp_path), port=0, family_port=0)
    assert isinstance(e.value, migrate.SwapRefused)
    page = run_degraded(monkeypatch, tmp_path, tmp_path, str(e.value), lock_wait=True, release=stager.close)
    try:
        assert page["out"] == "retry"                                        # the start goes on by itself
        mig = page["migration"]
        assert mig["lock_wait"] is True and mig["lock_wait_since"] and mig["lock_retry_s"] == 0.05
        assert migrate.hold_process_lock(str(path))                          # and it holds the lock now
    finally:
        migrate.release_process_lock(str(path))
    src = (APP / "harness" / "__main__.py").read_text()
    assert 'if got != "retry":' in src and "lock_wait=isinstance(e, migrate.LockBusy)" in src


def test_the_page_shows_the_lock_wait():
    import inspect
    from harness import setup_web
    src = inspect.getsource(setup_web)
    assert 'mig.get("lock_wait")' in src and "tried again every" in src


# -- 13. a refused swap sorted from the command line ----------------------------------------------------------------

def refused_for_a_foreign_log(tmp_path, clock, build):
    target = killed_at(tmp_path, clock, "renamed", build=build)
    stray = pathlib.Path(str(target) + "-wal")
    stray.write_bytes(b"not its log")
    with pytest.raises(migrate.SwapRefused) as e:
        migrate.apply_staged_restore(str(target))
    assert e.value.conflict == ["harness.sqlite-wal"]
    plan = json.loads(pathlib.Path(str(target) + migrate.SWAP_MARKER).read_text())
    assert plan["refused"] and plan["conflict"] == ["harness.sqlite-wal"]
    with pytest.raises(migrate.SwapRefused, match="refused earlier"):    # a later start stays refused
        migrate.apply_staged_restore(str(target))
    return target, stray


def test_set_aside_moves_the_files_after_a_typed_yes_and_the_next_start_finishes(tmp_path, clock):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bsetaside")
    before = snapshot(target.parent)
    asked = []
    got = migrate.set_aside(str(target), confirm=lambda q: asked.append(q) or "no")
    assert got["ok"] is False and snapshot(target.parent) == before         # not confirmed: nothing moved
    assert "harness.sqlite-wal" in asked[0] and "Type yes" in asked[0]
    got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    assert got["ok"] is True and got["moved"] == ["harness.sqlite-wal"]
    moved = target.parent / got["into"] / "harness.sqlite-wal"
    assert got["into"].startswith("harness-set-aside-") and moved.read_bytes() == b"not its log"
    assert not stray.exists()
    plan = json.loads(pathlib.Path(str(target) + migrate.SWAP_MARKER).read_text())
    assert "refused" not in plan and "conflict" not in plan
    done = migrate.apply_staged_restore(str(target))                        # the next start
    assert done["ok"] is True and not pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()


def test_set_aside_from_the_command_line_asks_first(tmp_path, clock):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bsetcli")
    out = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(target), "--set-aside"], input="no\n",
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 1 and stray.exists()
    out = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(target), "--set-aside"], input="yes\n",
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stdout + out.stderr
    assert json.loads(out.stdout[out.stdout.index("{"):])["moved"] == ["harness.sqlite-wal"]
    assert not stray.exists()


def test_set_aside_is_refused_while_harness_holds_the_lock(tmp_path, clock):
    target, stray = refused_for_a_foreign_log(tmp_path, clock, "bsetlock")
    other = migrate._try_lock(str(target.parent))
    try:
        got = migrate.set_aside(str(target), confirm=lambda q: "yes")
    finally:
        other.close()
    assert got["ok"] is False and "harness.lock" in got["said"] and stray.exists()


def test_the_degraded_start_posts_one_best_effort_note_through_the_link(tmp_path, monkeypatch):
    notes = []
    page = run_degraded(monkeypatch, tmp_path, tmp_path, "the records weren't opened: a test reason", notes=notes)
    assert page["out"] == 1
    assert len(notes) == 1 and "Harness started without its records" in notes[0]
    assert "a test reason" in notes[0]


# -- 4. kept sets: each posted back, pruned only when its own marker says done ---------------------------------------

def fresh_ledger(tmp_path, clock, kept, frm):
    led = Ledger(str(tmp_path / "harness.sqlite"), clock=clock)
    migrate._write_json(str(tmp_path / "harness.sqlite") + migrate.RESTORED,
                        {"from": frm, "kept": kept.name, "at": "20261116T090000Z"})
    return led


def hold(led, pid):
    """A request held in these records (calendar_change's held state), as the kept ledger's helper makes them."""
    from harness import calendar_change
    led.db.execute("PRAGMA foreign_keys=OFF")
    with led.tx() as db:
        db.execute("INSERT INTO meta(key, value) VALUES (?, ?)",
                   (calendar_change.HELD + pid, json.dumps({"at": "2026-11-16T08:00:00+00:00"})))
        db.execute("INSERT INTO proposals VALUES (?, 'j', 'calendar_change', ?, 'h', 'p', 'held', 'a', 'b')",
                   (pid, json.dumps({"changes": [{"title": f"Copy me {pid}"}]})))


def delivered(rows, word):
    return sum(word in t for t in rows)


@pytest.mark.parametrize("went", [True, False])
@pytest.mark.parametrize("stop", ["posted:summary", "posted:p-one", "enqueue"])
def test_two_restores_in_a_row_with_the_first_post_back_cut_short_bring_both_back_once(tmp_path, clock, copy_line,
                                                                                      monkeypatch, stop, went):
    """The first restore's post-back is cut short; before the next start finishes it a second restore sets the
    records then in use aside (they become the second kept set, with whatever the first post-back had queued in
    them, delivered or not). The next start posts back both sets, the older first: each held request reaches him
    once."""
    import shutil
    first = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite", ids=("p-one",))
    led = fresh_ledger(tmp_path, clock, first, "harness-before-s2-b-one.sqlite")
    hold(led, "p-two")                                                       # a request held in these records
    if stop == "enqueue":
        real, calls = led.enqueue, []

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
    monkeypatch.setattr(__import__("harness.calendar_change").calendar_change, "_copy_line", lambda c, tz: c["title"])
    if went:                                                                 # Cain's link had taken what was queued
        with led.tx() as db:
            db.execute("UPDATE outbox SET state='sent'")
    first_sent = [r[0] for r in led.db.execute("SELECT text FROM outbox WHERE state='sent'")]
    led.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    led.close()
    second = tmp_path / "harness-replaced-20261116T100000Z.sqlite"           # the second restore's swap
    for x in ("", "-wal", "-shm"):
        if (tmp_path / ("harness.sqlite" + x)).exists():
            shutil.move(str(tmp_path / ("harness.sqlite" + x)), str(second) + x)
    assert not json.loads(pathlib.Path(str(first) + migrate.POSTBACK).read_text()).get("done")
    led = fresh_ledger(tmp_path, clock, second, "harness-before-s2-b-two.sqlite")
    got = migrate.after_restore(led, OWNER, TZ)
    assert got["held"] == 2
    now = notices_text(led)
    reached = first_sent + now
    assert delivered(reached, "Copy me p-one") == 1                          # once each
    assert delivered(reached, "Copy me p-two") == 1
    if "Copy me p-one" in " ".join(now):
        assert [t for t in now if "Copy me" in t][0].endswith("Copy me p-one")   # the older set first
    assert json.loads(pathlib.Path(str(second) + migrate.POSTBACK).read_text())["done"] is True
    assert not first.exists() and second.exists()                            # pruned once done; the latest kept
    assert migrate.after_restore(led, OWNER, TZ) == {}


def test_a_kept_set_not_posted_back_is_never_pruned(tmp_path):
    old = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261101T090000Z.sqlite", ids=("p-old",))
    new = kept_with_held_in_wal(tmp_path, name="harness-replaced-20261116T090000Z.sqlite", ids=())
    migrate._write_json(str(new) + migrate.POSTBACK, {"posted": ["summary"], "pending": None, "done": True})
    migrate._write_json(str(old) + migrate.POSTBACK, {"posted": ["summary"], "pending": "p-old", "done": False})
    assert migrate.prune_kept(str(tmp_path)) == []
    assert old.exists()
    from harness.migrate import space_problem
    import harness.migrate as mm
    real = mm._free_bytes
    try:
        mm._free_bytes = lambda folder: 0
        assert "set aside by a restore" in space_problem(str(new))           # counted in the space check
    finally:
        mm._free_bytes = real


# Sixteenth round: the post-back pruning is tested through after_restore (test_handover_round16_restore.py).


