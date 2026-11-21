"""0.24.0, thirtieth round: the defects the twenty-ninth outside review found in the twenty-ninth round's additions.

1. The tap journal's lock fails closed: a strike that can't take it appends a tombstone (read back) instead of
   rewriting, an append that can't take it is refused with /health's storage flag, the lock file is the App's and
   group-writable, and the set-aside tool runs only as the journal's owner.
2. A mark with the ended state is terminal whatever its epoch or generation, decided before any other field.
4. The waiting card is once per outage, kept beside the journal and keyed on a counter, never on the clock.
5. A struck mark whose count couldn't be read keeps the "nocount" state, read ahead of any side entry.
6. A requeue's epoch comes from one counter in the records, never pruned.
9. The App refuses to start with the journal on a network mount; the one-time repair ends a nought mark beside an
   over-cap count at six.
All names and ids invented.
"""
import json
import os
import sqlite3
import stat
import threading

import pytest

from harness import __main__ as app_main, handover, migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import m  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round23_taps import queued
from test_handover_round26_taps import reconfirms
from test_handover_round28_taps import mark
from test_handover_round29_taps import back_to_set_aside, journal_text, set_side_gen, side
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)


def tap(n):
    return {"id": str(n), "custom_id": f"k:a:r30{n}", "token": "t", "app": "999", "message_id": "5"}


def cards(m):
    return m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]


def no_lock(journal):
    raise PermissionError("the lock file isn't the App's")


# -- 1. the journal's lock fails closed ------------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_strike_with_the_lock_unopenable_appends_a_tombstone_and_never_rewrites(m, monkeypatch):
    h = m.c.handovers
    gone, stays = tap(30101), tap(30102)
    for p in (gone, stays):
        assert h.journal_add(Handover(kind="press", press=p))
    before = journal_text(m)
    monkeypatch.setattr(handover, "journal_lock", no_lock)
    h.journal_done(gone, strict=True)
    after = journal_text(m)
    assert after == before                                                     # not rewritten, not written to
    # thirty-first round: the tombstone goes beside the journal, only ever appended there
    assert '"struck"' in open(h.journal + handover.STRUCK_SIDE, encoding="utf-8").read()
    assert [h.key(r["press"]) for r in h.journaled()] == [h.key(stays)]         # every reader honours it
    assert h.lines_for(h.key(gone)) == [] and not h.has_lines(h.key(gone))
    monkeypatch.undo()
    h.journal_done(stays)                                                      # the next locked strike compacts it
    assert h.journaled() == [] and '"struck"' not in (journal_text(m) if os.path.exists(h.journal) else "")


@pytest.mark.card_only
def test_an_append_with_the_lock_unopenable_is_refused_beside_another_thread_and_health_says_storage(m, monkeypatch):
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=tap(30111)))
    before = journal_text(m)
    monkeypatch.setattr(handover, "journal_lock", no_lock)
    got = {}

    def other():
        got["other"] = Inbox(lambda: "", journal=h.journal).journal_add(Handover(kind="press", press=tap(30112)))
    t = threading.Thread(target=other)
    t.start()
    got["mine"] = h.journal_add(Handover(kind="press", press=tap(30113)))
    t.join(5)
    assert got == {"other": False, "mine": False}                             # both refused, never unlocked
    assert journal_text(m) == before                                           # the journal as it was
    assert "storage" in h.health()
    monkeypatch.undo()
    assert h.journal_add(Handover(kind="press", press=tap(30114)))             # the lock back: taken, flag cleared
    assert "storage" not in h.health()


@pytest.mark.card_only
def test_a_concurrent_append_and_strike_under_a_lock_permission_failure_loses_no_tap(m, monkeypatch):
    """The striking writer can't open the lock (another user's file) while another writer, which can, appends a tap
    between the strike's read and where its rename would be."""
    h = m.c.handovers
    gone = tap(30121)
    assert h.journal_add(Handover(kind="press", press=gone))
    late, real_lock, real_replace, done = tap(30122), handover.journal_lock, os.replace, {}

    def lock(journal):
        if threading.current_thread() is threading.main_thread():
            raise PermissionError("the lock file isn't this writer's")
        return real_lock(journal)

    def append():
        done["ok"] = Inbox(lambda: "", journal=h.journal).journal_add(Handover(kind="press", press=late))

    def replace(src, dst, *a, **kw):
        if dst == h.journal and "t" not in done:                               # the old code's unlocked rewrite
            done["t"] = threading.Thread(target=append)
            done["t"].start()
            done["t"].join(5)
        return real_replace(src, dst, *a, **kw)

    def raw(self, row, _real=Inbox._side_tombstone):                           # the new code's tombstone
        if "t" not in done:
            done["t"] = threading.Thread(target=append)
            done["t"].start()
            done["t"].join(5)
        return _real(self, row)
    monkeypatch.setattr(handover, "journal_lock", lock)
    monkeypatch.setattr(os, "replace", replace)
    monkeypatch.setattr(Inbox, "_side_tombstone", raw)
    h.journal_done(gone, strict=True)
    assert done.get("ok")
    keys = [h.key(r["press"]) for r in h.journaled()]
    assert keys == [h.key(late)]                                               # his later tap survived, gone is gone


@pytest.mark.card_only
def test_the_lock_file_is_group_writable_whatever_the_umask(m):
    old = os.umask(0o077)
    try:
        lock = m.c.handovers.journal + handover.JOURNAL_LOCK
        if os.path.exists(lock):
            os.remove(lock)
        assert m.c.handovers.journal_add(Handover(kind="press", press=tap(30131)))
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(lock).st_mode) == 0o660


@pytest.mark.card_only
def test_the_set_aside_tool_refuses_to_run_as_another_user(m, monkeypatch):
    h = m.c.handovers
    press = tap(30141)
    assert h.journal_add(Handover(kind="press", press=press))
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    before = journal_text(m)
    monkeypatch.setattr(os, "geteuid", lambda: os.stat(h.journal).st_uid + 4242)
    for action in ("discard", "requeue", "export"):
        got = migrate.set_aside_taps(m.ledger.path, key, action, journal=h.journal)
        assert not got["ok"] and "owner" in got["said"]
    assert journal_text(m) == before
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None      # still set aside, nothing done


# -- 2. an ended mark is terminal whatever its epoch -----------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.parametrize("epoch", [pytest.param('"x"', id="string"), pytest.param("true", id="bool"),
                                   pytest.param(None, id="missing")])
def test_an_ended_mark_with_a_bad_epoch_beside_a_side_count_stays_ended(m, tmp_path, epoch):
    press = tap(30201)
    key = m.c.handovers.key(press)
    relisted(m, press)
    raw = '{"gen": 6, "pending": false, "ended": true' + (f', "epoch": {epoch}' if epoch else "") + "}"
    m.ledger.db.execute("UPDATE meta SET value=? WHERE key=?", (raw, Controller.RELIST_FLAG + key))
    set_side_gen(m, key, 3)                                                    # a stale count beside the journal
    goes, before = reconfirms(m), cards(m)
    for _ in range(2):
        relisted(m, press)
    real_restart(m, tmp_path)
    set_side_gen(m, key, 3)
    relisted(m, press)
    assert reconfirms(m) == goes                                               # no Go ahead
    assert cards(m) == before                                                  # and no second card
    assert mark(m, key)["ended"] is True


# -- 4. one waiting card per outage -----------------------------------------------------------------------------------

def list_down(monkeypatch):
    def down(self):
        raise sqlite3.OperationalError("unable to open database file")
    monkeypatch.setattr(Controller, "_quarantined", down)


@pytest.mark.card_only
@pytest.mark.parametrize("refusals", [0, 4])
def test_an_outage_with_a_restart_in_the_middle_gives_one_waiting_card(m, monkeypatch, clock, tmp_path, refusals):
    list_down(monkeypatch)
    real_enqueue, left = type(m.ledger).enqueue, {"n": refusals}

    def enqueue(self, *a, **kw):
        if kw.get("once", "").startswith("setaside_waiting:") and left["n"] > 0:
            left["n"] -= 1
            raise sqlite3.OperationalError("disk I/O error")
        return real_enqueue(self, *a, **kw)
    monkeypatch.setattr(type(m.ledger), "enqueue", enqueue)
    real_restart(m, tmp_path)
    for _ in range(40):
        later(m, clock, 60)
    real_restart(m, tmp_path)                                                  # a restart mid-outage
    clock.t = clock.t.replace(year=clock.t.year + 1)                           # and a clock step
    for _ in range(40):
        later(m, clock, 60)
    assert "waiting" in m.c.handovers.health()
    assert len(queued(m, Controller.SETASIDE_CARD_WORDS)) == 1                 # exactly one, the whole outage
    monkeypatch.setattr(Controller, "_quarantined", lambda self: {})           # it reads again: the outage closes
    for _ in range(Controller.SETASIDE_CLOSE_AFTER):                           # (thirty-first round: after a run)
        later(m, clock, 3600)
    assert "waiting" not in m.c.handovers.health()
    assert side(m)["outage"]["open"] is False


@pytest.mark.card_only
def test_a_second_outage_gets_its_own_card(m, monkeypatch, clock, tmp_path):
    for _ in range(2):
        list_down(monkeypatch)
        real_restart(m, tmp_path)                                              # the start replay waits on the list
        for _ in range(30):
            later(m, clock, 60)
        monkeypatch.setattr(Controller, "_quarantined", lambda self: {})
        for _ in range(Controller.SETASIDE_CLOSE_AFTER):                       # thirty-first round: a run closes it
            later(m, clock, 3600)
    assert len(queued(m, Controller.SETASIDE_CARD_WORDS)) == 2


# -- 5. no count for good ---------------------------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_struck_mark_with_no_count_ignores_a_side_entry_that_appears_later(m, monkeypatch):
    press = tap(30501)
    key = m.c.handovers.key(press)
    relisted(m, press)
    goes = reconfirms(m)
    with m.ledger.tx() as db:                                                  # a pending strike whose count is gone
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps({"press": press, "gen": "x", "pending": True,
                                                                    "fails": 0, "due": 0.0}), db)
    got = side(m)
    got.get("gens", {}).pop(key, None)
    with open(m.c.handovers.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:
        json.dump(got, f)
    m.c._resume_relists(m.c._relist_marks())                                   # struck, with no count
    assert mark(m, key)["gen"] is None and mark(m, key)["nocount"] is True
    assert mark(m, key).get("ended") is not True
    set_side_gen(m, key, 3)                                                    # a side entry appears
    relisted(m, press)
    assert reconfirms(m) == goes                                               # no Go ahead counted from it
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1                 # stopped, with its own card


@pytest.mark.card_only
def test_a_requeue_clears_no_count(m):
    press = tap(30502)
    key = m.c.handovers.key(press)
    relisted(m, press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps({"gen": None, "pending": False,
                                                                    "nocount": True}), db)
    back_to_set_aside(m, press)
    assert migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)["ok"]
    assert "nocount" not in mark(m, key) and mark(m, key)["gen"] == 0
    goes = reconfirms(m)
    relisted(m, press)
    assert reconfirms(m) == goes + 1


# -- 6. epochs from one counter, never pruned ------------------------------------------------------------------------

def requeue(m, press):
    key = back_to_set_aside(m, press)
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"], got
    return key


def lose_count(m, key):
    m.ledger.db.execute("DELETE FROM meta WHERE key=?", (Controller.RELIST_FLAG + key,))
    got = side(m)
    for part in ("gens", "epochs"):
        (got.get(part) or {}).pop(key, None)
    with open(m.c.handovers.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:
        json.dump(got, f)


@pytest.mark.card_only
def test_a_requeued_tap_whose_mark_and_side_entry_are_both_lost_still_gets_a_fresh_go_ahead(m):
    press = tap(30601)
    relisted(m, press)
    key = requeue(m, press)
    relisted(m, press)                                                         # its first relist after the requeue
    goes = reconfirms(m)
    lose_count(m, key)                                                         # both lost
    requeue(m, press)
    relisted(m, press)
    assert reconfirms(m) == goes + 1                                           # never refused as a duplicate
    assert mark(m, key)["epoch"] == 2 and m.ledger.get_meta(migrate.RELIST_EPOCHS) == "2"


@pytest.mark.card_only
def test_the_side_entry_one_epoch_ahead_of_the_mark(m):
    """The count beside the journal written for a requeue (epoch 2) while the mark kept the one before (epoch 1)."""
    press = tap(30602)
    relisted(m, press)
    key = requeue(m, press)
    relisted(m, press)
    got = side(m)
    got["gens"][key], got.setdefault("epochs", {})[key] = 0, 2
    with open(m.c.handovers.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:
        json.dump(got, f)
    goes = reconfirms(m)
    relisted(m, press)                                                         # counted in the side's epoch
    assert reconfirms(m) == goes + 1 and mark(m, key)["epoch"] == 2
    requeue(m, press)
    assert mark(m, key)["epoch"] == 3                                          # past both
    relisted(m, press)
    assert reconfirms(m) == goes + 2


# -- 9. local storage only; the repair's nought mark beside an over-cap count ---------------------------------------

MOUNTS = """22 1 0:21 / / rw,relatime - ext4 /dev/root rw
40 22 0:40 / /data rw,relatime - {kind} server:/export rw
"""


@pytest.mark.parametrize("kind,refused", [("nfs4", True), ("cifs", True), ("fuse.sshfs", True), ("ext4", False),
                                          ("overlay", False)])
def test_the_journal_on_a_network_mount_is_refused(tmp_path, kind, refused):
    info = tmp_path / "mountinfo"
    info.write_text(MOUNTS.format(kind=kind))
    if refused:
        with pytest.raises(handover.NetworkJournal):
            handover.check_local("/data/harness.sqlite" + handover.TAP_JOURNAL, str(info))
    else:
        handover.check_local("/data/harness.sqlite" + handover.TAP_JOURNAL, str(info))
    handover.check_local("/elsewhere/x" + handover.TAP_JOURNAL, str(info))   # the root's ext4


def test_the_app_refuses_to_start_on_a_network_mount(tmp_path, monkeypatch):
    monkeypatch.setattr(handover, "mount_type", lambda path, mountinfo="": "nfs4")
    with pytest.raises(handover.NetworkJournal):
        app_main.build(str(tmp_path))
    assert not os.path.exists(tmp_path / "harness.sqlite")                    # refused before the records open


@pytest.mark.card_only
def test_the_repair_ends_a_nought_mark_beside_an_over_cap_count_at_six(m, tmp_path):
    press = tap(30901)
    key = m.c.handovers.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps({"gen": 0, "pending": False}), db)
        db.execute("DELETE FROM meta WHERE key=?", (Controller.LEGACY_CHECKED,))
    set_side_gen(m, key, Controller.RELIST_GEN_CAP + 1)
    real_restart(m, tmp_path)
    assert mark(m, key)["ended"] is True and mark(m, key)["gen"] == Controller.RELIST_GEN_CAP
    goes, before = reconfirms(m), cards(m)
    relisted(m, press)
    assert reconfirms(m) == goes and cards(m) == before                        # struck, no Go ahead, no card
