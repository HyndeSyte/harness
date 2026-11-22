"""0.24.0, thirteenth round: what the twelfth outside review of the handover fixes asked for (Nov 16).

Fixes to the twelfth round's own additions, each on its own: the restore swap moves the old ledger with its -wal
and -shm files, checks the staged file at swap time, renames it into place atomically and finishes after a stop;
the restore command line writes only a staged file and its marker, and refuses while the specialist holds its
lock; the checkpoint and the backup run under the writer hold before the migration's transaction; taps are
acknowledged before any ledger write, a write from another thread under the hold is an assertion, and a waiting
writer is bounded; a staged restore fences writes and asks for a restart with what will be set aside; free space
is checked first, a failed or interrupted move starts degraded and says so once; the pruning stall names its
event and his tap takes the clock as right; the lost-update compare has a per-calendar baseline; and the
unguarded PUT uses a far-past test event, removed and read back gone. All names and ids invented.
"""
import json
import logging
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request

import pytest

from harness import calendar_change, handover, ledger as ledger_mod, migrate
from harness.handover import Handover
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (TZ, Morning, ask, nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import DENTIST
from test_handover_round5 import HAIRCUT, MOVE_HAIRCUT, haircut_at, seed_haircut
from test_handover_round6 import card_for
from test_handover_round9 import _gmail_takes_any_if_match
from test_handover_round10 import conform, seen_both, start
from test_handover_round11 import failing_dry_run, notices
from fake_caldav import no_network  # noqa: F401  (autouse)

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "harness" / "app"
CLI = ("import sys, runpy; sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[1:]; "
       "runpy.run_module('harness.migrate', run_name='__main__', alter_sys=True)")


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


@pytest.fixture
def strict():
    """A ledger write from another thread while a hold is on fails at once (ledger.STRICT_HOLD)."""
    was = ledger_mod.STRICT_HOLD
    before = len(ledger_mod.cross_thread_writes())
    ledger_mod.STRICT_HOLD = True
    yield before
    ledger_mod.STRICT_HOLD = was


class Crash(BaseException):
    """Stands for the App being killed at that point: nothing after it runs."""


def restorable(tmp_path, clock, build="bswap"):
    """A ledger moved once (a backup at schema 1 beside it), then written to after the move."""
    path = tmp_path / "harness.sqlite"
    led = Ledger(str(path), clock=clock)
    with led.tx() as db:
        led.event("precious", {"keep": True}, db=db)
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build=build)
    assert got["backup"]
    with led.tx() as db:
        led.event("after_the_move", {}, db=db)
    return path, led


def count(path, kind):
    c = sqlite3.connect(str(path))
    try:
        return c.execute("SELECT COUNT(*) FROM events WHERE kind=?", (kind,)).fetchone()[0]
    finally:
        c.close()


# -- 1. the restore swap ----------------------------------------------------------------------------------------

def test_a_stale_wal_beside_the_ledger_moves_with_it_and_the_restored_file_has_none(tmp_path, clock):
    path, led = restorable(tmp_path, clock)
    assert migrate.stage_restore(str(path), 1, "bswap")["ok"]
    led.db.execute("PRAGMA wal_autocheckpoint=0")
    with led.tx() as db:
        for i in range(30):
            led.event("wal_only", {"i": i}, db=db)
    # The App killed with that log not folded in: its files as they are on disk, in a folder of their own.
    crashed = tmp_path / "crashed"
    crashed.mkdir()
    for f in tmp_path.iterdir():
        if f.is_file():
            shutil.copyfile(f, crashed / f.name)
    led.db.close()
    target = crashed / "harness.sqlite"
    assert os.path.getsize(str(target) + "-wal") > 0
    got = migrate.apply_staged_restore(str(target))
    assert got["ok"] is True
    assert not pathlib.Path(str(target) + "-wal").exists() and not pathlib.Path(str(target) + "-shm").exists()
    kept = crashed / got["replaced"]
    assert pathlib.Path(str(kept) + "-wal").exists()                 # the old log went with its file
    assert count(kept, "wal_only") == 30 and count(kept, "after_the_move") == 1
    restored = Ledger(str(target), clock=clock)
    assert migrate.schema(restored) == 1
    assert restored.db.execute("SELECT COUNT(*) FROM events WHERE kind IN ('wal_only','after_the_move')"
                               ).fetchone()[0] == 0
    assert restored.db.execute("SELECT COUNT(*) FROM events WHERE kind='precious'").fetchone()[0] == 1
    assert not pathlib.Path(str(target) + migrate.SWAP_MARKER).exists()
    assert not pathlib.Path(str(target) + migrate.STAGE_MARKER).exists()


@pytest.mark.parametrize("stop_at", ["marker", "moved", "moved-wal"])
def test_a_stop_after_the_swap_marker_and_before_the_rename_is_finished_at_the_next_start(tmp_path, clock,
                                                                                        monkeypatch, stop_at):
    path, led = restorable(tmp_path, clock)
    assert migrate.stage_restore(str(path), 1, "bswap")["ok"]
    led.close()

    def stop(phase):
        if phase == stop_at:
            raise Crash(phase)
    monkeypatch.setattr(migrate, "_swap_step", stop)
    with pytest.raises(Crash):
        migrate.apply_staged_restore(str(path))
    assert pathlib.Path(str(path) + migrate.SWAP_MARKER).exists()
    assert pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()          # not renamed yet
    monkeypatch.setattr(migrate, "_swap_step", lambda phase: None)
    got = migrate.apply_staged_restore(str(path))                            # the next start
    assert got["ok"] is True
    assert count(path, "after_the_move") == 0 and count(path, "precious") == 1
    assert count(tmp_path / got["replaced"], "after_the_move") == 1
    assert not pathlib.Path(str(path) + migrate.SWAP_MARKER).exists()
    assert not pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()
    assert migrate.apply_staged_restore(str(path)) == {}


def test_a_stop_after_the_rename_only_clears_the_markers_at_the_next_start(tmp_path, clock, monkeypatch):
    path, led = restorable(tmp_path, clock)
    assert migrate.stage_restore(str(path), 1, "bswap")["ok"]
    led.close()

    def stop(phase):
        if phase == "renamed":
            raise Crash(phase)
    monkeypatch.setattr(migrate, "_swap_step", stop)
    with pytest.raises(Crash):
        migrate.apply_staged_restore(str(path))
    assert not pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()      # renamed into place
    assert count(path, "after_the_move") == 0
    monkeypatch.setattr(migrate, "_swap_step", lambda phase: None)
    got = migrate.apply_staged_restore(str(path))
    assert got["ok"] is True and (tmp_path / got["replaced"]).exists()
    assert count(path, "precious") == 1 and count(tmp_path / got["replaced"], "after_the_move") == 1
    assert not pathlib.Path(str(path) + migrate.SWAP_MARKER).exists()
    assert pathlib.Path(str(path) + migrate.RESTORED).exists()                # the held requests still to post


def test_a_staged_file_that_fails_its_check_at_swap_time_isnt_used(tmp_path, clock):
    path, led = restorable(tmp_path, clock)
    assert migrate.stage_restore(str(path), 1, "bswap")["ok"]
    led.close()
    staged = pathlib.Path(str(path) + migrate.RESTORE_SUFFIX)
    staged.write_bytes(b"SQLite format 3\x00" + b"\x00" * 200)                # damaged since it was staged
    got = migrate.apply_staged_restore(str(path))
    assert got["ok"] is False
    assert count(path, "after_the_move") == 1                                 # the ledger is untouched
    assert not staged.exists() and pathlib.Path(str(staged) + ".refused").exists()


# -- 2. the command line never touches the live ledger ---------------------------------------------------------

def test_the_restore_command_line_refuses_while_the_specialist_runs_and_never_writes_the_ledger(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="bcli2")
    led.close()
    before = path.read_bytes()
    assert migrate.hold_process_lock(str(path))
    try:
        done = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(path), "--restore", "1", "bcli2"],
                              capture_output=True, text=True, timeout=120)
        got = json.loads(done.stdout)
        assert done.returncode == 1 and "Harness is running" in got["said"]
        assert not pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()
    finally:
        migrate.release_process_lock(str(path))
    done = subprocess.run([sys.executable, "-I", "-c", CLI, str(APP), str(path), "--restore", "1", "bcli2"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0 and json.loads(done.stdout)["ok"] is True
    assert path.read_bytes() == before                                        # only read
    assert pathlib.Path(str(path) + migrate.RESTORE_SUFFIX).exists()
    assert pathlib.Path(str(path) + migrate.STAGE_MARKER).exists()            # its marker, written last
    assert not pathlib.Path(str(path) + migrate.RESTORE_SUFFIX + ".part").exists()


# -- 3. the checkpoint and the backup come before the migration's transaction ------------------------------------

def test_the_checkpoint_and_backup_run_under_the_hold_before_the_migrations_transaction(ledger, monkeypatch):
    order = []
    real_cp, real_copy, real_install = migrate.checkpoint, migrate.copy_ledger, migrate.install

    def cp(led):
        order.append(("checkpoint", led.db.in_transaction, led.writers_held()))
        return real_cp(led)

    def copy(source, dest):
        if not isinstance(source, str) and source is ledger.db:
            order.append(("copy", ledger.db.in_transaction, ledger.writers_held()))
        return real_copy(source, dest)

    def install(led, *a, **kw):
        order.append(("migrate", led.db.in_transaction, led.writers_held()))
        return real_install(led, *a, **kw)
    monkeypatch.setattr(migrate, "checkpoint", cp)
    monkeypatch.setattr(migrate, "copy_ledger", copy)
    monkeypatch.setattr(migrate, "install", install)
    got = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-order")
    assert not got.get("waiting")
    steps = [o[0] for o in order]
    assert steps.index("checkpoint") < steps.index("migrate") and steps.index("copy") < steps.index("migrate")
    for name, in_tx, held in order:
        assert held, name
        assert in_tx == (name == "migrate"), name


def test_a_checkpoint_or_backup_inside_a_transaction_is_refused(ledger):
    with pytest.raises(migrate.OrderError):
        with ledger.tx():
            migrate.checkpoint(ledger)
    with pytest.raises(migrate.OrderError):
        with ledger.tx():
            migrate.backup(ledger, "b-inside")
    assert not list(pathlib.Path(ledger.path).parent.glob("harness-before-*"))


# -- 4. the hold is safe for live interactions --------------------------------------------------------------------

def test_a_write_from_another_thread_under_the_hold_is_an_assertion(ledger, strict):
    errors = []

    def other():
        led = None
        try:
            led = Ledger(ledger.path)                                    # its own opening writes too
            with led.tx() as db:
                led.event("other", {}, db=db)
        except AssertionError as e:
            errors.append(str(e))
        finally:
            if led is not None:
                led.db.close()
    with ledger.hold_writers():
        t = threading.Thread(target=other, name="poster")
        t.start()
        t.join(5)
    assert errors and "poster" in errors[0]
    assert ledger_mod.cross_thread_writes()[-1]["thread"] == "poster"
    assert not ledger.writers_held()


def test_a_waiting_writer_logs_and_retries_and_gives_up_bounded(ledger, monkeypatch, caplog):
    monkeypatch.setattr(ledger_mod, "WRITER_WAIT_S", 0.05)
    monkeypatch.setattr(ledger_mod, "WRITER_WAIT_MAX_S", 0.3)
    got = []

    def other(name):
        led = None
        try:
            led = Ledger(ledger.path)
            with led.tx() as db:
                led.event(name, {}, db=db)
            got.append("wrote")
        except ledger_mod.LedgerBusy:
            got.append("busy")
        finally:
            if led is not None:
                led.db.close()
    caplog.set_level(logging.WARNING, logger="harness.ledger")
    with ledger.hold_writers():
        t = threading.Thread(target=other, args=("gave_up",))
        t.start()
        t.join(5)
    assert got == ["busy"] and "trying again" in caplog.text and "gave up" in caplog.text
    monkeypatch.setattr(ledger_mod, "WRITER_WAIT_MAX_S", 30)
    with ledger.hold_writers():
        t = threading.Thread(target=other, args=("waited",))
        t.start()
        time.sleep(0.2)
    t.join(5)
    assert got == ["busy", "wrote"]
    assert ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='waited'").fetchone()[0] == 1


def test_the_hold_is_released_when_what_it_holds_fails(ledger):
    with pytest.raises(RuntimeError):
        with ledger.hold_writers():
            raise RuntimeError("the migration broke")
    assert not ledger.writers_held()


def test_a_tap_is_acknowledged_before_any_ledger_write_and_queued_while_the_hold_is_on(ledger, monkeypatch):
    monkeypatch.undo()                     # a loopback server only, as test_discord_keeper's handover tests use
    monkeypatch.setattr(handover, "PRESS_WAIT_S", 1)   # fourteenth round: answered "working" once written down
    token = "test-bot-token"
    inbox = handover.Inbox(lambda: token, journal=str(pathlib.Path(ledger.path).parent / "taps.jsonl"))
    srv = handover.serve(inbox, port=0, host="127.0.0.1", wait_s=30)
    try:
        port = srv.server_address[1]
        body = json.dumps({"id": "1", "token": "t", "app": "9", "custom_id": "hx:1", "message_id": "5"}).encode()
        with ledger.hold_writers():                    # the migration holds the ledger; nothing takes the queue
            req = urllib.request.Request(f"http://127.0.0.1:{port}/press", data=body, method="POST",
                                         headers={"x-harness-key": handover.key_for(token),
                                                  "content-type": "application/json"})
            t0 = time.monotonic()
            with urllib.request.urlopen(req, timeout=10) as r:
                answer = json.loads(r.read())
            assert time.monotonic() - t0 < 5
        assert answer == {"status": "working", "queued": True, "journaled": True}   # never a final "ok" yet
        assert [r["press"]["id"] for r in inbox.journaled()] == ["1"]
        assert inbox.pending() == 1
        assert [h.kind for h in inbox.take()] == ["press"]
    finally:
        srv.shutdown()


@pytest.mark.migrate_gate
def test_the_outbox_poster_and_the_run_check_notice_write_only_on_the_holding_thread(m, monkeypatch, strict):
    failing_dry_run(monkeypatch)
    with m.ledger.hold_writers():
        migrate.run_live(m.ledger, m.cc, OWNER, version="0.24.0", build="b-held")   # posts the Run check notice
        m.c.outbox.flush()                                                          # the poster, under the hold
        migrate.tend_waiting(m.ledger, OWNER, TZ)
    assert len(ledger_mod.cross_thread_writes()) == strict                          # none from another thread
    assert "Run check" in m.labels()


# -- 5. a staged restore fences writes and asks for a restart ------------------------------------------------------

@pytest.mark.migrate_gate
@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_staged_restore_fences_writes_asks_for_a_restart_and_the_held_requests_come_back(m, clock):
    migrate.run_live(m.ledger, m.cc, OWNER, version="0.24.0", build="bfence")     # a backup at schema 2
    clock.advance(minutes=5)
    seed_haircut(m)
    out = m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))              # held: the gate is closed
    assert m.ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE ?",
                               (calendar_change.HELD + "%",)).fetchone()[0] == 1, out
    m.send(Handover(kind="fastpath", state="migrate-restore", restore="2 bfence"))
    m.c.outbox.flush()
    try:
        m.tap("Put them back")
        assert migrate.restore_staged(m.ledger.path) and m.ledger.fenced          # fourteenth round: a mode flag
        m.c.tick()
        m.c.outbox.flush()
        card = [t for t in m.seen() if t.startswith("Restart Harness now")]
        assert len(card) == 1
        assert "taken 5 minutes ago" in card[0] and "1 held request " in card[0]
        for words in ("buttons not tapped yet", "still being confirmed", "you could still undo"):
            assert words in card[0], words
        said = m.tells("add the dentist at 3 today", ask(DENTIST))
        assert said["status"] == "refused" and said["said"] == m.c.FENCED
        assert m.c.status_box["migration"]["restore_staged"] is True
        assert m.c.handovers.health()["migration"]["restore_staged"] is True
    finally:
        m.ledger.unfence()
    m.ledger.close()
    got = migrate.apply_staged_restore(m.ledger.path)                               # the restart
    assert got["ok"]
    led = Ledger(m.ledger.path, clock=clock)
    assert not led.db.execute("SELECT 1 FROM meta WHERE key LIKE ?", (calendar_change.HELD + "%",)).fetchone()
    back = migrate.after_restore(led, OWNER, TZ)
    assert back["held"] >= 1
    text = led.db.execute("SELECT text FROM outbox ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert "ready to copy" in text and "Haircut" in text
    assert migrate.after_restore(led, OWNER, TZ) == {}                              # once
    led.db.close()


# -- 6. no start that can't recover --------------------------------------------------------------------------------

@pytest.mark.migrate_gate
def test_a_full_disk_is_refused_plainly_before_the_dry_run_and_the_backup(ledger, monkeypatch, tmp_path):
    monkeypatch.setattr(migrate, "_free_bytes", lambda folder: 1024)
    got = migrate.dry_run(ledger.path, version="0.24.0", build="b-full")
    assert got["ok"] is False and "free space" in got["said"]
    out = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-full")
    assert out["waiting"] and "free space" in out["why"]
    assert migrate.backup(ledger, "b-full") == ""
    assert not list(tmp_path.glob("harness-before-*")) and not list(tmp_path.glob("*.part"))
    assert migrate.schema(ledger) == 1


@pytest.mark.migrate_gate
def test_a_failed_migration_starts_degraded_says_so_once_and_offers_run_check_and_put_them_back(ledger,
                                                                                               monkeypatch):
    real = migrate.install

    def broken(led, *a, **kw):
        if os.path.abspath(led.path) == os.path.abspath(ledger.path):   # the live ledger only, not the dry run's copy
            raise KeyError("a step that breaks")
        return real(led, *a, **kw)
    monkeypatch.setattr(migrate, "install", broken)
    out = migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-broken")
    assert out["waiting"] and "failed" in out["why"]
    said = notices(ledger)
    assert len(said) == 1 and "couldn't move its records over" in said[0][0]
    assert [b[0] for r in said[0][1] for b in r] == ["Run check", "Put them back"]
    migrate.run_live(ledger, None, OWNER, version="0.24.0", build="b-broken")      # the next start
    assert len(notices(ledger)) == 1                                                 # posted once
    summary = migrate.migration_summary(ledger)
    assert summary["degraded"] is True and summary["waiting"] is True
    inbox = handover.Inbox.for_tests(lambda: "x")
    inbox.migration = summary
    inbox.beat()
    assert inbox.health()["migration"]["degraded"] is True


def test_a_specialist_that_cant_open_its_records_still_serves_status_and_health(tmp_path, monkeypatch):
    from harness import __main__ as main_mod
    served = {}

    class Web:
        def shutdown(self):
            served["web_down"] = True
    monkeypatch.setattr(main_mod, "serve", lambda app, port: served.setdefault("web", app) and Web() or Web())
    monkeypatch.setattr(main_mod.handover, "serve", lambda inbox, port: served.setdefault("inbox", inbox))
    monkeypatch.setattr(main_mod.time, "sleep", lambda s: os.kill(os.getpid(), signal.SIGTERM))
    old = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    try:
        assert main_mod.degraded(str(tmp_path), 0, "the records couldn't be opened (DatabaseError)") == 1
    finally:
        signal.signal(signal.SIGTERM, old[0])
        signal.signal(signal.SIGINT, old[1])
    health = served["inbox"].health()
    assert health["status"] == "degraded" and "couldn't be opened" in health["why"]
    assert served["web_down"]


@pytest.mark.migrate_gate
def test_a_restored_ledgers_move_needs_no_fresh_run_check(tmp_path, clock):
    path, led = restorable(tmp_path, clock, build="bagain")
    assert migrate.stage_restore(str(path), 1, "bagain")["ok"]
    with open(str(path) + migrate.MIGRATING, "w") as f:                    # a move interrupted on the old ledger
        f.write("{}")
    led.close()
    assert migrate.apply_staged_restore(str(path))["ok"]
    led = Ledger(str(path), clock=clock)
    got = migrate.run_live(led, None, OWNER, version="0.24.0", build="bagain")
    assert not got.get("waiting") and migrate.schema(led) == migrate.HANDOVER
    assert not led.db.execute("SELECT 1 FROM choices WHERE kind='migration_check'").fetchone()


# -- 7. the pruning stall is visible and recoverable ----------------------------------------------------------------

def test_the_pruning_stall_names_its_event_and_his_tap_takes_the_clock_as_right(m, clock):
    with m.ledger.tx() as db:
        m.ledger.event("from_the_future", {}, db=db)
    with m.ledger.tx() as db:                                               # one written before any time sync
        db.execute("INSERT INTO events(at, kind, detail) VALUES('1999-01-01T00:00:00+00:00', 'unsynced', '{}')")
    clock.advance(hours=-3)
    stall = migrate.clock_stall(m.ledger)
    assert stall["kind"] == "from_the_future" and stall["event"] and stall["at"]
    m.c.tick()
    assert m.c.status_box["migration"]["pruning_stalled"]["kind"] == "from_the_future"
    assert m.c.handovers.health()["migration"]["pruning_stalled"]["event"] == stall["event"]
    import queue
    from harness.setup_web import SetupApp, render_page
    page = render_page(SetupApp(m.vault, m.c.status_box, queue.Queue()), "u1", "Owner")
    assert "Old backups aren" in page and "pruned" in page and "from_the_future" in page
    m.c.outbox.flush()
    assert len([t for t in m.seen() if t.startswith("Harness's clock is behind its own records")]) == 1
    m.c.tick()
    m.c.outbox.flush()
    assert len([t for t in m.seen() if t.startswith("Harness's clock is behind its own records")]) == 1   # once
    m.tap("Use the clock as it is now")
    assert migrate.clock_stall(m.ledger) == {} and migrate.clock_problem(m.ledger) == ""
    with m.ledger.tx() as db:
        m.ledger.event("later_but_honest", {}, db=db)
    assert migrate.clock_stall(m.ledger) == {}


def test_events_stamped_before_the_clock_floor_never_count_for_the_rule(ledger, clock):
    with ledger.tx() as db:
        db.execute("DELETE FROM events")
        db.execute("INSERT INTO events(at, kind, detail) VALUES('1970-01-02T00:00:00+00:00', 'unsynced', '{}')")
    assert migrate.clock_stall(ledger) == {}


def test_cains_migrate_clock_only_posts_the_card(m, clock):
    with m.ledger.tx() as db:
        m.ledger.event("from_the_future", {}, db=db)
    clock.advance(minutes=-2)                                               # behind, but not by enough for a card
    m.c.tick()
    m.c.outbox.flush()
    assert "Use the clock as it is now" not in m.labels()
    out = m.send(Handover(kind="fastpath", state="migrate-clock"))
    assert out["status"] == "ok" and out["pruning_stalled"]["kind"] == "from_the_future"
    m.c.outbox.flush()
    assert "Use the clock as it is now" in m.labels()
    assert migrate.clock_stall(m.ledger)                                    # nothing taken until his tap


# -- 8. the lost-update compare has a baseline per calendar ---------------------------------------------------------

def _gmail_normalises(m, monkeypatch):
    """A Gmail that adds a field of its own on every write."""
    real = m.gmail.change

    def change_(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        if uid in m.gmail.events:
            m.gmail.events[uid]["reminders"] = {"useDefault": True}
        return out
    monkeypatch.setattr(m.gmail, "change", change_)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_calendar_that_normalises_fields_outside_the_change_raises_no_overwritten_message(m, monkeypatch):
    _gmail_normalises(m, monkeypatch)
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    conform(m, run, "gmail")
    base = calendar_change.card_gate(m.ledger)["conformance"]["gmail"]["baseline"]
    assert base == {"reminders": {"kind": "added", "now": json.dumps({"useDefault": True}, sort_keys=True)}}
    m.tap("Open without protection")
    assert m.cc._unprotected("gmail")
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    assert haircut_at(m) == "10:30" and m.gmail.events[HAIRCUT]["reminders"] == {"useDefault": True}
    assert not [t for t in m.seen() if t.startswith("Possibly overwritten")]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_real_foreign_change_is_still_told_with_a_baseline(m, monkeypatch):
    _gmail_normalises(m, monkeypatch)
    seed_haircut(m)
    run = start(m)
    seen_both(m, "gmail")
    _gmail_takes_any_if_match(m, monkeypatch)
    conform(m, run, "gmail")
    m.tap("Open without protection")
    assert m.cc._unprotected("gmail")
    real = m.gmail.change

    def someone_else_too(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        m.gmail.events[uid]["location"] = "12 Other St"
        return out
    monkeypatch.setattr(m.gmail, "change", someone_else_too)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    m.c.tick()
    m.c.outbox.flush()
    lost = [t for t in m.seen() if t.startswith("Possibly overwritten on Gmail")]
    assert len(lost) == 1 and "Location" in lost[0] and "Reminders" not in lost[0]


def test_only_differences_matching_the_baseline_are_suppressed():
    key = ("VCALENDAR/VEVENT", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR")
    base = calendar_change._baseline_of([{"field": ("VCALENDAR/VEVENT[20261111T210000Z]", key[1]), "was": None,
                                          "now": [key[1] + ":AUTOMATIC"]},
                                         {"field": ("VCALENDAR/VEVENT", "LOCATION"), "was": ["LOCATION:Pool"],
                                          "now": ["LOCATION;LANGUAGE=en:pool"]}])
    m_ = calendar_change._matches_baseline
    assert m_({"field": key, "was": None, "now": [key[1] + ":AUTOMATIC"]}, base)
    assert not m_({"field": key, "was": None, "now": [key[1] + ":DISABLED"]}, base)
    assert m_({"field": ("VCALENDAR/VEVENT", "LOCATION"), "was": ["LOCATION:Pool B"],
               "now": ["LOCATION;LANGUAGE=en:pool  b"]}, base)
    assert not m_({"field": ("VCALENDAR/VEVENT", "LOCATION"), "was": ["LOCATION:Pool B"],
                   "now": ["LOCATION:Gym"]}, base)                           # someone's edit
    assert not m_({"field": ("VCALENDAR/VEVENT", "SUMMARY"), "was": ["SUMMARY:a"], "now": ["SUMMARY:A"]}, base)
    assert calendar_change.IGNORED_STAMPS["family"] == ("DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "CREATED")


# -- 9. the unguarded PUT on Family -------------------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_unguarded_put_uses_a_far_past_test_event_and_removes_it_before_recording(m):
    run = start(m)
    conform(m, run, "family")
    rec = calendar_change.card_gate(m.ledger)["conformance"]["family"]
    assert rec["unguarded_put"] in ("taken", "refused")
    unguarded = [(i, path, body) for i, (meth, path, h, body) in enumerate(m.icloud.log)
                 if meth == "PUT" and "If-Match" not in (h or {}) and "If-None-Match" not in (h or {})]
    assert unguarded
    i, href, body = unguarded[0]
    text = body.decode() if isinstance(body, bytes) else str(body)
    assert "DTSTART" in text and "2001" in text and "VALARM" not in text
    assert calendar_change.UNGUARDED_TITLE in text.replace("\r\n ", "")
    deletes = [j for j, (meth, path, *_rest) in enumerate(m.icloud.log) if meth == "DELETE" and path == href]
    assert deletes and deletes[0] > i
    later = [j for j, (meth, path, *_rest) in enumerate(m.icloud.log)
             if path != href and j > i and meth in ("PUT", "DELETE")]
    assert later and deletes[0] < later[0]                                  # removed before anything else is written
    assert not m.cc.smoke_leftovers(run)


@pytest.mark.card_only
@pytest.mark.install_gate
def test_an_unguarded_put_whose_test_event_cant_be_shown_gone_is_unknown(m, monkeypatch):
    run = start(m)
    calls = []

    def drop(self, href, fetch):
        calls.append(href)
        return False
    monkeypatch.setattr(calendar_change.CalendarChange, "_drop_test", drop)
    conform(m, run, "family")
    rec = calendar_change.card_gate(m.ledger)["conformance"]["family"]
    assert calls and rec["unguarded_put"] == "unknown"


# -- 10. Cain's rules, keeper and the docs --------------------------------------------------------------------------

def test_cains_rules_keeper_and_docs_name_this_rounds_behaviour():
    rules = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "CLAUDE.md").read_text()
    keeper = (ROOT / "cain" / "rootfs" / "opt" / "cain" / "keeper.sh").read_text()
    docs = (ROOT / "harness" / "DOCS.md").read_text()
    for text in (rules, docs):
        for words in ("migrate-clock", "Use the clock as it is now", "restart", "degraded"):
            assert words in text, words
    for words in ("harness.lock", "-wal", "integrity_check", "free space", "baseline", "2001",
                  "writer hold"):
        assert words in docs, words
    assert "migrate-clock" in keeper
    # Cain's side is the section that introduced the calendar specialist's restore, restart and clock
    # behaviour, Cain 0.17.0, found by its version heading (newer Cain sections need not repeat it).
    for log in ((ROOT / "harness" / "CHANGELOG.md").read_text().split("\n## ", 2)[1],
                cain_changelog_section("0.17.0")):
        assert "restart" in log.lower() and "clock" in log.lower()


def cain_changelog_section(version):
    """The Cain CHANGELOG section headed "## <version>", through the line before the next heading."""
    text = (ROOT / "cain" / "CHANGELOG.md").read_text()
    head = f"\n## {version}\n"
    assert head in text, f"Cain's CHANGELOG has no {version} section"
    return text.split(head, 1)[1].split("\n## ", 1)[0]
