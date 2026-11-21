"""0.24.0, thirty-first round: the defects the thirtieth outside review found in the thirtieth round's additions.

1. No unlocked write to the tap journal: a strike (and the set-aside tool's discard) that can't take its lock records
   its tombstone beside it (handover.STRUCK_SIDE, only ever appended), which no rewrite of the journal can drop.
2. The file beside the journal is never written over contents that couldn't be read: moved aside, the write refused.
3. A requeue's epoch is drawn, and the counter raised, inside its own write transaction.
5. The set-aside tool checks its user against every file's owner before it opens or creates anything.
6. The journal's file system is checked against an allowlist of local types.
7. /health's storage flag: any lock failure raises it, any lock taken clears that cause, a write failure is its own.
8. A lock file root creates before the journal exists is given the journal folder's owner.
9. An outage of the set-aside list closes only after a run of good reads, so flapping reads give one card.
All names and ids invented.
"""
import io
import json
import logging
import os
import sqlite3
import threading

import pytest

from harness import handover, migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from harness.ledger import Ledger
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import m  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round23_taps import queued
from test_handover_round26_taps import reconfirms
from test_handover_round28_taps import mark
from test_handover_round29_taps import back_to_set_aside, journal_text, orphaned, side
from test_handover_round30_taps import list_down
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)


def tap(n):
    return {"id": str(n), "custom_id": f"k:a:r31{n}", "token": "t", "app": "999", "message_id": "5"}


def keys(h):
    return [h.key(r["press"]) for r in h.journaled()]


def raced_rewrite(monkeypatch, h, struck_by_rewrite, while_paused):
    """A locked rewrite of the journal (another writer's strike, on its own thread, which can take the lock) that
    reads the journal, then waits before its rename while `while_paused` runs on this thread (which can't take the
    lock), then renames what it read."""
    real_lock, real_replace = handover.journal_lock, os.replace
    read, go, done = threading.Event(), threading.Event(), {}

    def lock(journal):
        if threading.current_thread() is threading.main_thread():
            raise PermissionError("the lock file isn't this writer's")
        return real_lock(journal)

    def replace(src, dst, *a, **kw):
        if dst == h.journal and threading.current_thread() is not threading.main_thread():
            read.set()                                                        # it has read the journal
            go.wait(5)
        return real_replace(src, dst, *a, **kw)
    monkeypatch.setattr(handover, "journal_lock", lock)
    monkeypatch.setattr(os, "replace", replace)

    def rewrite():
        Inbox(lambda: "", journal=h.journal).journal_done(struck_by_rewrite, strict=True)
        done["ok"] = True
    t = threading.Thread(target=rewrite)
    t.start()
    assert read.wait(5)
    try:
        return while_paused()
    finally:
        go.set()
        t.join(5)
        assert done.get("ok")
        monkeypatch.undo()


# -- 1. no unlocked write to the journal -----------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_strike_without_the_lock_survives_a_locked_rewrite_that_read_before_it_and_renames_after(m, monkeypatch):
    h = m.c.handovers
    gone, other, stays = tap(31101), tap(31102), tap(31103)
    for p in (gone, other, stays):
        assert h.journal_add(Handover(kind="press", press=p))
    before = journal_text(m)

    def strike():
        h.journal_done(gone, strict=True)                                      # no lock: its tombstone beside
        assert journal_text(m) == before                                       # nothing written to the journal
    raced_rewrite(monkeypatch, h, other, strike)
    assert keys(h) == [h.key(stays)]                                           # the strike survived the rename
    assert h.lines_for(h.key(gone)) == [] and not h.has_lines(h.key(gone))
    lines, entry = migrate._tap_lines(h.journal, h.key(gone))                  # the tool's reader too
    assert lines == [] and entry == []
    h.journal_done(stays)                                                      # the next locked strike compacts
    assert h.journaled() == [] and not os.path.exists(h.journal)
    assert h._side_tombstones()[0] == []                                       # applied, and marked so beside


@pytest.mark.card_only
def test_the_tools_discard_without_the_lock_survives_a_locked_rewrite_that_read_before_it(m, monkeypatch):
    h = m.c.handovers
    press, key = orphaned(m, 31111)                                            # a refused requeue's intent
    other = tap(31112)
    assert h.journal_add(Handover(kind="press", press=other))

    def discard():
        got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=h.journal)
        assert got["ok"], got
    raced_rewrite(monkeypatch, h, other, discard)
    lines, _ = migrate._tap_lines(h.journal, key)
    assert migrate._requeue_intents(lines, key) == 0                           # the intent stays cleared
    row = next(r for r in h.journaled() if h.key(r["press"]) == key)
    assert not row["intent"] and row["state"] != "unknown"


@pytest.mark.card_only
def test_the_journal_is_never_written_without_its_lock(m, monkeypatch):
    h = m.c.handovers
    gone = tap(31121)
    assert h.journal_add(Handover(kind="press", press=gone))
    real_open = os.open
    written = []

    def opened(path, flags, *a, **kw):
        if path == h.journal and flags & (os.O_WRONLY | os.O_RDWR):
            written.append(path)
        return real_open(path, flags, *a, **kw)
    monkeypatch.setattr(handover, "journal_lock", lambda j: (_ for _ in ()).throw(PermissionError("not ours")))
    monkeypatch.setattr(os, "open", opened)
    h.journal_done(gone, strict=True)
    assert written == [] and keys(h) == []


# -- 2. the file beside the journal is never written over what couldn't be read ---------------------------------

CORRUPT = '{"gens": {"%s": 6}, "epochs": {"%s": 0}, "taps": {"%s": {"fails": 1, "du'


@pytest.mark.card_only
def test_a_corrupt_side_file_through_an_outage_and_recovery_gives_no_go_ahead_beyond_the_cap(m, monkeypatch, clock,
                                                                                            tmp_path):
    press = tap(31201)
    key = m.c.handovers.key(press)
    relisted(m, press)                                                         # its first relist: the mark says 1
    goes = reconfirms(m)
    path = m.c.handovers.journal + Controller.REREAD_SIDE
    corrupt = CORRUPT % (key, key, key)                                        # the count beside it reached six
    with open(path, "w", encoding="utf-8") as f:
        f.write(corrupt)
    list_down(monkeypatch)                                                     # the records in an outage
    real_restart(m, tmp_path)
    for _ in range(30):
        later(m, clock, 60)
    assert "waiting" in m.c.handovers.health()                                 # the flags still say it
    assert len(queued(m, Controller.SETASIDE_CARD_WORDS)) <= 1                 # (a fresh file once it's aside)
    with open(path + handover.SIDE_ASIDE, encoding="utf-8") as f:
        assert f.read() == corrupt                                             # its counts and epochs kept, aside
    monkeypatch.undo()                                                         # recovery
    for _ in range(Controller.SETASIDE_CLOSE_AFTER):
        later(m, clock, 3600)
    relisted(m, press)
    assert reconfirms(m) == goes                                               # no Go ahead beyond the cap
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1                 # the no-count state, said
    with open(path + handover.SIDE_ASIDE, encoding="utf-8") as f:
        assert f.read() == corrupt


@pytest.mark.card_only
@pytest.mark.parametrize("writer", ["deferral", "relist", "outage", "requeue", "discard"])
def test_no_side_file_writer_writes_over_contents_that_couldnt_be_read(m, writer):
    h = m.c.handovers
    press = tap(31211)
    key = h.key(press)
    path = h.journal + Controller.REREAD_SIDE
    corrupt = CORRUPT % (key, key, key)
    if writer in ("requeue", "discard"):
        back_to_set_aside(m, press)
    with open(path, "w", encoding="utf-8") as f:
        f.write(corrupt)
    if writer == "deferral":
        m.c.__dict__.setdefault("_reread_mem", {})[key] = {"fails": 1, "due": 0}
        m.c._hold_deferral(key, "OperationalError", "a tap's next read couldn't be put off")
    elif writer == "relist":
        m.c._side_gens({key: 2})
    elif writer == "outage":
        m.c._setaside_card()
        assert queued(m, Controller.SETASIDE_CARD_WORDS) == []
    else:
        got = migrate.set_aside_taps(m.ledger.path, key, writer, journal=h.journal)
        assert not got["ok"] and "stays set aside" in got["said"]
        assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    assert not os.path.exists(path) or open(path, encoding="utf-8").read() == corrupt
    assert open(path + handover.SIDE_ASIDE, encoding="utf-8").read() == corrupt


@pytest.mark.card_only
def test_after_the_move_aside_a_requeue_gives_the_lost_tap_its_count_again(m):
    h = m.c.handovers
    press = tap(31221)
    relisted(m, press)
    path = h.journal + Controller.REREAD_SIDE
    key = h.key(press)
    with open(path, "w", encoding="utf-8") as f:
        f.write(CORRUPT % (key, key, key))
    m.c._side_gens({})                                                         # finds it unreadable: moved aside
    back_to_set_aside(m, press)
    assert migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal)["ok"]
    assert key in side(m)["lost"] and side(m)["gens"][key] == 0                # written afresh, the loss kept
    goes = reconfirms(m)
    relisted(m, press)
    assert reconfirms(m) == goes + 1                                           # a fresh Go ahead after the requeue


def test_an_unreadable_side_file_with_no_legible_key_loses_every_marked_count(tmp_path):
    journal = str(tmp_path / "x.taps")
    path = journal + ".reread"
    with open(path, "wb") as f:
        f.write(b"\x00\x81 not json")
    got = handover.load_side(path, lambda: [])
    assert got["unread"] and got["lost_all"] and os.path.exists(path + handover.SIDE_ASIDE)
    again = handover.load_side(path, lambda: ["1|k"])                         # none there now: the loss kept
    assert "unread" not in again and again["lost_all"] and again["lost"] == ["1|k"]


# -- 3. the requeue's epoch inside its own transaction ----------------------------------------------------------------

@pytest.mark.card_only
def test_two_interleaved_requeues_of_one_tap_never_draw_one_epoch(m, monkeypatch):
    h = m.c.handovers
    press = tap(31301)
    relisted(m, press)
    key = back_to_set_aside(m, press)
    drawn, real, results = [], migrate._side_relist, []

    def side_relist(journal, key_, gen, epoch=0):
        if gen is not None:
            drawn.append(epoch)
            if len(drawn) == 1:                                               # the first run, between its epoch
                with monkeypatch.context() as mp:                              # a second run past the tool's lock
                    mp.setattr(migrate, "_try_lock", lambda folder: io.StringIO())
                    results.append(migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal))
        return real(journal, key_, gen, epoch)
    monkeypatch.setattr(migrate, "_side_relist", side_relist)
    results.insert(0, migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal))
    took = [d for d, r in zip(drawn, results) if r["ok"]]                    # the epochs the runs that went drew
    assert results[0]["ok"] and took
    assert len(set(took)) == len(took)                                         # no epoch handed out twice
    assert mark(m, key)["epoch"] == max(took)
    assert int(m.ledger.get_meta(migrate.RELIST_EPOCHS)) == max(took)


@pytest.mark.card_only
def test_a_requeue_never_lowers_the_epoch_counter(m, monkeypatch):
    press = tap(31311)
    relisted(m, press)
    key = back_to_set_aside(m, press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(migrate.RELIST_EPOCHS, "50", db)                    # another run raised it meanwhile
    monkeypatch.setattr(migrate, "_epoch_counter", lambda db: 0)               # a stale read of it
    assert migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)["ok"]
    assert m.ledger.get_meta(migrate.RELIST_EPOCHS) == "50"                    # never lowered


def test_the_counter_is_raised_in_one_statement_and_never_lowered(tmp_path):
    db = sqlite3.connect(str(tmp_path / "x.sqlite"), isolation_level=None)
    db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
    for n, want in ((3, "3"), (7, "7"), (2, "7"), (7, "7"), (8, "8")):
        migrate._raise_epoch_counter(db, n)
        assert db.execute("SELECT value FROM meta WHERE key=?", (migrate.RELIST_EPOCHS,)).fetchone()[0] == want
    db.execute("UPDATE meta SET value='garbled' WHERE key=?", (migrate.RELIST_EPOCHS,))
    migrate._raise_epoch_counter(db, 4)
    assert migrate._epoch_counter(db) == 4


@pytest.mark.card_only
def test_a_refused_requeue_transaction_leaves_the_side_file_as_it_was(m):
    h = m.c.handovers
    press = tap(31321)
    relisted(m, press)
    key = back_to_set_aside(m, press)
    path = h.journal + Controller.REREAD_SIDE
    kept = json.dumps({"taps": {}, "gens": {key: 1}, "epochs": {key: 0}}, indent=2)   # as some writer left it
    with open(path, "w", encoding="utf-8") as f:
        f.write(kept)
    m.ledger.db.execute("CREATE TRIGGER r31_refuse BEFORE INSERT ON meta WHEN NEW.key LIKE 'tap_relist:%' "
                        "BEGIN SELECT RAISE(ABORT, 'refused'); END")
    try:
        got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal)
    finally:
        m.ledger.db.execute("DROP TRIGGER r31_refuse")
    assert not got["ok"] and "stays set aside" in got["said"]
    with open(path, encoding="utf-8") as f:
        assert f.read() == kept                                                # no new side state, byte for byte
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None


# -- 5. the tool's owner check comes before anything else --------------------------------------------------------------

def snapshot(folder):
    out = {}
    for name in sorted(os.listdir(folder)):
        p = os.path.join(folder, name)
        if os.path.isfile(p):
            st = os.stat(p)
            with open(p, "rb") as f:
                out[name] = (f.read(), st.st_mtime_ns, st.st_uid)
    return out


@pytest.mark.parametrize("action", [None, "export", "discard", "requeue"])
def test_the_tool_run_as_another_user_creates_or_changes_no_file(tmp_path, monkeypatch, action):
    folder = tmp_path / "data"
    folder.mkdir()
    path = str(folder / "harness.sqlite")
    led = Ledger(path)
    journal = path + handover.TAP_JOURNAL
    press = tap(31501)
    inbox = Inbox(lambda: "", journal=journal)
    assert inbox.journal_add(Handover(kind="press", press=press))
    key = inbox.key(press)
    with led.tx() as db:
        led.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    led.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    led.db.close()
    for extra in ("-wal", "-shm", handover.JOURNAL_LOCK):
        target = (journal if extra == handover.JOURNAL_LOCK else path) + extra
        if os.path.exists(target):
            os.remove(target)
    before = snapshot(folder)
    monkeypatch.setattr(os, "geteuid", lambda: os.stat(path).st_uid + 4242)
    got = migrate.set_aside_taps(path, key, action or "export", journal=journal) if action \
        else migrate.set_aside_taps(path, None, journal=journal)
    assert not got["ok"] and "owner" in got["said"]
    assert snapshot(folder) == before                                          # nothing created or changed


# -- 6. local storage by an allowlist ---------------------------------------------------------------------------------

MOUNTS = """22 1 0:21 / / rw,relatime - ext4 /dev/root rw
40 22 0:40 / /data rw,relatime - {kind} somewhere rw
"""


LOCAL = ["btrfs", "ext4", "f2fs", "overlay", "tmpfs", "vfat", "xfs"]


def test_the_allowlist_is_the_documented_one():
    assert sorted(handover.LOCAL_FS) == LOCAL


@pytest.mark.parametrize("kind", LOCAL)
def test_each_allowed_local_type_is_accepted(tmp_path, kind):
    info = tmp_path / "mountinfo"
    info.write_text(MOUNTS.format(kind=kind))
    handover.check_local("/data/harness.sqlite" + handover.TAP_JOURNAL, str(info))


@pytest.mark.parametrize("kind", ["fuse", "fuseblk", "fuse.mergerfs", "zfs", "ext3", "nfs4", "cifs", "9p",
                                  "somethingnew"])
def test_anything_not_on_the_allowlist_is_refused(tmp_path, kind):
    info = tmp_path / "mountinfo"
    info.write_text(MOUNTS.format(kind=kind))
    with pytest.raises(handover.NetworkJournal):
        handover.check_local("/data/harness.sqlite" + handover.TAP_JOURNAL, str(info))


@pytest.mark.parametrize("table", [None, "", "garbled line with no separator\n"])
def test_a_mount_table_that_cant_be_read_is_refused(tmp_path, table):
    info = tmp_path / "mountinfo"
    if table is not None:
        info.write_text(table)
    with pytest.raises(handover.NetworkJournal):
        handover.check_local("/data/harness.sqlite" + handover.TAP_JOURNAL, str(info))


# -- 7. the storage flag's causes ------------------------------------------------------------------------------------

def no_lock(journal):
    raise PermissionError("the lock file isn't the App's")


@pytest.mark.card_only
def test_a_strike_that_cant_take_the_lock_raises_the_storage_flag(m, monkeypatch):
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=tap(31701)))
    monkeypatch.setattr(handover, "journal_lock", no_lock)
    h.journal_done(tap(31701))
    assert h.health().get("storage") == handover.LOCK_STORAGE


@pytest.mark.card_only
def test_any_lock_taken_clears_the_lock_cause(m, monkeypatch):
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=tap(31711)))
    with monkeypatch.context() as mp:
        mp.setattr(handover, "journal_lock", no_lock)
        assert not h.journal_add(Handover(kind="press", press=tap(31712)))
    assert h.health().get("storage") == handover.LOCK_STORAGE
    h.journal_done(tap(31711))                                                 # a strike takes the lock: cleared
    assert "storage" not in h.health()


@pytest.mark.card_only
def test_a_lock_taken_then_a_failed_write_says_the_write_with_its_own_words(m, monkeypatch):
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=tap(31721)))
    with monkeypatch.context() as mp:
        mp.setattr(handover, "journal_lock", no_lock)
        assert not h.journal_add(Handover(kind="press", press=tap(31722)))
    real_open = os.open

    def opened(path, flags, *a, **kw):
        if path == h.journal and flags & os.O_APPEND:
            raise OSError(28, "No space left on device")
        return real_open(path, flags, *a, **kw)
    with monkeypatch.context() as mp:
        mp.setattr(os, "open", opened)
        assert not h.journal_add(Handover(kind="press", press=tap(31723)))
    assert h.health().get("storage") == handover.JOURNAL_WRITE_STORAGE      # the lock was taken: not its words
    assert handover.JOURNAL_WRITE_STORAGE != handover.LOCK_STORAGE
    assert h.journal_add(Handover(kind="press", press=tap(31724)))             # written again: cleared
    assert "storage" not in h.health()


# -- 8. the lock file's owner before the journal exists ---------------------------------------------------------------

def test_a_lock_file_root_creates_before_the_journal_is_given_the_folders_owner(tmp_path, monkeypatch):
    journal = str(tmp_path / "harness.sqlite") + handover.TAP_JOURNAL
    folder = str(tmp_path)
    real_stat, chowned = os.stat, []

    def stat(p, *a, **kw):
        got = real_stat(p, *a, **kw)
        if os.path.abspath(str(p)) == os.path.abspath(folder):
            fields = list(got)
            fields[4], fields[5] = 1234, 2345                                  # st_uid, st_gid: the App's
            return os.stat_result(fields)
        return got
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "stat", stat)
    monkeypatch.setattr(os, "fchown", lambda fd, uid, gid: chowned.append((uid, gid)))
    with handover.journal_lock(journal):
        pass
    assert not os.path.exists(journal)
    assert chowned == [(1234, 2345)]


# -- 9. one card for flapping reads -----------------------------------------------------------------------------------

@pytest.mark.card_only
def test_alternating_good_and_failed_reads_over_an_hour_give_one_card(m, monkeypatch, clock, tmp_path):
    pattern, at = [False, False, False, True], {"n": 0}

    def flapping(self):
        ok = pattern[at["n"] % len(pattern)]
        at["n"] += 1
        if not ok:
            raise sqlite3.OperationalError("unable to open database file")
        return set()
    monkeypatch.setattr(Controller, "_quarantined", flapping)
    real_restart(m, tmp_path)
    for _ in range(60):
        later(m, clock, 60)
    assert at["n"] > 2 * len(pattern)                                          # it did flap, more than once
    assert len(queued(m, Controller.SETASIDE_CARD_WORDS)) == 1
    monkeypatch.setattr(Controller, "_quarantined", lambda self: set())        # good reads, a run of them
    for _ in range(Controller.SETASIDE_BACKOFF_S[-1] // 60 + Controller.SETASIDE_CLOSE_AFTER + 1):
        later(m, clock, Controller.SETASIDE_CLOSE_EVERY_S)                     # the back-off, then the run
    assert side(m)["outage"]["open"] is False
    assert len(queued(m, Controller.SETASIDE_CARD_WORDS)) == 1


@pytest.mark.card_only
def test_an_outage_that_cant_be_recorded_is_said_loudly(m, monkeypatch, caplog):
    monkeypatch.setattr(Controller, "_side_save", lambda self, data: False)
    with caplog.at_level(logging.ERROR, logger="harness.controller"):
        m.c._setaside_card()
    assert queued(m, Controller.SETASIDE_CARD_WORDS) == []
    assert any(r.levelno >= logging.ERROR and "couldn't be recorded" in r.getMessage() for r in caplog.records)
