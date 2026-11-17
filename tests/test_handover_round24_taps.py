"""0.24.0, twenty-fourth round: the defects the twenty-third outside review found in the twenty-third round's additions.

1. A relisted tap whose strike can't be written (the journal alone failing) is marked strike-pending in the records in
   the same transaction as its cards; later ticks and starts only resume the strike: one summary, one card, no fresh
   Go ahead, no more calendar reads.
2. An unreadable strike flag with no card is set aside in the operator card's own transaction: later ticks and starts
   write nothing for it; its record stays readable and the set-aside tooling lists and clears it.
4. An internal error's kept copy is built from the journal's rows on every path that queues its card, and a tap is
   never struck before its copy is committed.
6. A deferral the records refuse is kept beside the journal: a crash loop keeps the schedule, the restarts are counted
   and one operator card goes past a threshold, and the log line is said against a kept time. With nothing writable,
   a start waits one schedule step before reading.
8. A press rebuilt from a tap key is checked against the journal's lines before it's struck, with real custom ids.
9. The error counter starts again only on a read whose calendar answered.
All names and ids invented.
"""
import json
import logging
import sqlite3

import pytest

from harness import migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m, tap_journaled  # noqa: F401
from test_handover_round17_taps import new_said
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from test_handover_round20_taps import states
from test_handover_round22_taps import counted_reads, flags, journal_unwritable, to_the_last_calendar_read
from test_handover_round23_taps import queued, raising_hold, unknown_tap
from fake_caldav import no_network  # noqa: F401  (autouse)

SUMMARY = "Harness stopped or hit an error before it noted what came of"
UNTAKEN = "the error came before it was taken"


def reconfirms(m):
    return m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='tap_reconfirm'").fetchone()[0]


def untaken_tap(m, monkeypatch):
    """His Approve, journaled, with the handler failing before the approval is used up: unknown, and untaken."""
    dentist_card(m)

    def handle(inc):
        raise RuntimeError("cut off before the approval")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        out, press = tap_journaled(m, "Approve")
    assert out["outcome"] == "unknown"
    return press


# -- 1. a relisted tap whose strike can't be written ------------------------------------------------------------------

@pytest.mark.card_only
def test_a_relist_whose_strike_fails_goes_once_and_is_only_struck_after(m, monkeypatch, clock, tmp_path):
    press = untaken_tap(m, monkeypatch)
    key = m.c.handovers.key(press)
    reads = counted_reads(monkeypatch)
    with monkeypatch.context() as mp:
        journal_unwritable(mp)                                                 # the journal alone fails
        later(m, clock, 61)                                                    # read, relisted, the strike fails
        assert reads["n"] == 1
        assert len(queued(m, SUMMARY)) == 1 and len(queued(m, UNTAKEN)) == 1 and reconfirms(m) == 1
        for _ in range(200):                                                   # ten minutes
            later(m, clock, 3)
        real_restart(m, tmp_path)
        for _ in range(200):
            later(m, clock, 3)
        assert len(queued(m, SUMMARY)) == 1 and len(queued(m, UNTAKEN)) == 1   # one summary, one card
        assert reconfirms(m) == 1                                              # no fresh Go ahead
        assert reads["n"] <= 1                                                 # never read again
        assert states(m) == ["unknown"]                                        # kept until it's struck
        mark = json.loads(m.ledger.get_meta(Controller.RELIST_FLAG + key))
        assert mark["pending"] is True and mark["gen"] == 1                    # with its cards, in the records
    for _ in range(25):                                                        # the journal takes writes again
        later(m, clock, 61)
    assert m.c.handovers.journaled() == []
    assert json.loads(m.ledger.get_meta(Controller.RELIST_FLAG + key)) == {"gen": 1, "pending": False}
    assert len(queued(m, SUMMARY)) == 1 and reconfirms(m) == 1


# -- 2. an unreadable strike flag with no card settles -----------------------------------------------------------------

def counted_writes(monkeypatch, key):
    writes = {"n": 0}
    real_enqueue, real_set = Ledger.enqueue, Ledger.set_meta

    def enqueue(self, *a, **kw):
        if key in str(kw.get("once") or ""):
            writes["n"] += 1
        return real_enqueue(self, *a, **kw)

    def set_meta(self, k, value, db=None):
        if key in k:
            writes["n"] += 1
        return real_set(self, k, value, db)
    monkeypatch.setattr(Ledger, "enqueue", enqueue)
    monkeypatch.setattr(Ledger, "set_meta", set_meta)
    return writes


@pytest.mark.card_only
@pytest.mark.parametrize("value", ["{not json", json.dumps({"fails": 0, "due": 0})], ids=["malformed", "no-press"])
def test_an_unreadable_strike_flag_with_no_card_is_set_aside_and_never_written_again(m, monkeypatch, clock, tmp_path,
                                                                                    value):
    key = "97501|k:c:r24none"
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, value, db)
    later(m, clock, 3)                                                         # tick 1: the card, set aside
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1
    writes = counted_writes(monkeypatch, key)
    for _ in range(200):                                                       # ticks 2 to N
        later(m, clock, 3)
    real_restart(m, tmp_path)
    for _ in range(200):
        later(m, clock, 3)
    assert writes["n"] == 0                                                    # no write for it, ever again
    assert m.ledger.get_meta(Controller.STRIKE_FLAG + key) is None
    kept = json.loads(m.ledger.get_meta(Controller.QUARANTINE_FLAG + key))     # the record, still readable
    assert kept["flag"] == value
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1
    listed = migrate.set_aside_taps(m.ledger.path)                             # the set-aside tooling lists it
    assert listed["ok"] and key in listed["taps"]
    got = migrate.set_aside_taps(m.ledger.path, key)                           # and clears it, keeping a copy
    assert got["ok"] and m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is None
    beside = json.loads((tmp_path / migrate.SET_ASIDE_TAPS).read_text())
    assert json.loads(beside[key])["flag"] == value


@pytest.mark.card_only
def test_a_set_aside_taps_journal_lines_are_left_as_they_are(m, monkeypatch, clock):
    a = unknown_tap(m, "97511")
    key = m.c.handovers.key(a)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, "{not json", db)
    reads = counted_reads(monkeypatch)
    for _ in range(20):
        later(m, clock, 3601)
    assert reads["n"] == 0                                                     # never taken again
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == [a["id"]]  # kept, never struck
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1


# -- 4. the kept copy of an internal error, from the journal ----------------------------------------------------------

@pytest.mark.card_only
def test_the_kept_copy_is_built_from_the_journal_after_a_restart(m, monkeypatch, clock, tmp_path):
    dentist_card(m)
    press = cut_after(m, monkeypatch)
    key = m.c.handovers.key(press)
    raising_hold(m, monkeypatch)
    with monkeypatch.context() as mp:
        mp.setattr(Controller, "_queue_terminal",
                   lambda self, row: (_ for _ in ()).throw(sqlite3.OperationalError("database is locked")))
        for _ in range(14):
            later(m, clock, 3601)
    assert states(m) == ["internal_error"]                                     # journaled; its card not queued
    assert m.ledger.get_meta(Controller.DIAG_FLAG + key) is None
    real_restart(m, tmp_path)                                                  # the row now comes from the journal
    assert m.c.handovers.journaled() == []                                     # struck, and only with its copy
    diag = json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + key))
    assert diag["error"] == "ValueError: bad value"                            # journaled with the outcome
    assert diag["request"].get("proposal") and diag["error_checks"] == len(Controller.CHECK_BACKOFF_S)
    assert diag["identity"]["id"] == press["id"] and "token" not in json.dumps(diag)
    assert len(queued(m, "internal error")) == 1


@pytest.mark.card_only
def test_a_tap_is_never_struck_before_its_kept_copy_is_committed(m, monkeypatch, clock, tmp_path):
    """Its card and strike flag queued by a run whose copy is gone (a flag from before this round): the strike writes
    the copy from the journal first, and while the copy can't be written the tap isn't struck."""
    dentist_card(m)
    press = cut_after(m, monkeypatch)
    key = m.c.handovers.key(press)
    raising_hold(m, monkeypatch)
    with monkeypatch.context() as mp:
        mp.setattr(Controller, "_strike", lambda *a, **kw: False)              # the strike didn't happen
        for _ in range(14):
            later(m, clock, 3601)
    assert len(queued(m, "internal error")) == 1 and flags(m) == [Controller.STRIKE_FLAG + key]
    with m.ledger.tx() as db:                                                  # a flag from before: no state, no copy
        db.execute("DELETE FROM meta WHERE key=?", (Controller.DIAG_FLAG + key,))
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, json.dumps({"press": press, "fails": 0, "due": 0}), db)
    real_set = Ledger.set_meta

    def set_meta(self, k, value, db=None):
        if k.startswith(Controller.DIAG_FLAG):
            raise sqlite3.OperationalError("database or disk is full")
        return real_set(self, k, value, db)
    with monkeypatch.context() as mp:
        mp.setattr(Ledger, "set_meta", set_meta)
        real_restart(m, tmp_path)
        for _ in range(10):
            later(m, clock, 61)
        assert states(m) == ["internal_error"]                                 # never struck without its copy
    for _ in range(10):
        later(m, clock, 3601)
    assert m.c.handovers.journaled() == []
    diag = json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + key))
    assert diag["error"] == "ValueError: bad value" and diag["request"].get("proposal")
    assert len(queued(m, "internal error")) == 1


# -- 6. a crash loop with the records refusing writes -----------------------------------------------------------------

def records_refuse(mp):
    mp.setattr(Controller, "_queue_terminal",
               lambda self, row: (_ for _ in ()).throw(sqlite3.OperationalError("disk I/O error")))
    real_set = Ledger.set_meta

    def set_meta(self, key, value, db=None):
        if key.startswith("tap_"):
            raise sqlite3.OperationalError("attempt to write a readonly database")
        return real_set(self, key, value, db)
    mp.setattr(Ledger, "set_meta", set_meta)


@pytest.mark.card_only
def test_a_crash_loop_keeps_the_schedule_counts_the_restarts_and_says_so_once(m, monkeypatch, clock, tmp_path,
                                                                             caplog):
    to_the_last_calendar_read(m, monkeypatch, clock)
    reads = counted_reads(monkeypatch)
    journal_unwritable(monkeypatch)
    records_refuse(monkeypatch)
    caplog.set_level(logging.ERROR, logger="harness.controller")
    later(m, clock, 3601)                                                      # the last read: unverified
    assert reads["n"] == 1 and flags(m, "tap_reread:") == []
    for _ in range(6):                                                         # six restarts, a minute apart
        real_restart(m, tmp_path)
        for _ in range(20):
            later(m, clock, 3)
    assert reads["n"] <= 4                                                     # 1, 2 and 5 minutes on, not per start
    said = [r for r in caplog.records if "couldn't be put off in the records either" in r.getMessage()]
    assert len(said) == 1                                                      # against the kept time
    assert len(queued(m, Controller.RESTARTS_WORDS)) == 1                      # past the threshold, once
    assert states(m) == ["unknown"]


@pytest.mark.card_only
def test_with_nothing_writable_a_start_waits_a_step_before_reading(m, monkeypatch, clock, tmp_path):
    to_the_last_calendar_read(m, monkeypatch, clock)
    reads = counted_reads(monkeypatch)
    journal_unwritable(monkeypatch)
    records_refuse(monkeypatch)
    monkeypatch.setattr(Controller, "_side_save", lambda self, data: False,   # nor beside the journal
                        raising=False)
    later(m, clock, 3601)
    assert reads["n"] == 1
    for _ in range(8):                                                         # restarts every half minute
        real_restart(m, tmp_path)
        for _ in range(10):
            later(m, clock, 3)
    assert reads["n"] == 1                                                     # none at any start
    assert states(m) == ["unknown"]


# -- 8. the rebuilt press, checked against the journal ----------------------------------------------------------------

def carded_unreadable(m, press):
    """A terminal tap in the journal, its card queued and its strike flag left unreadable."""
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_outcome(press, "unverified")
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(f"tap_card_queued:{key}", "1", db)
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, "{not json", db)
    return key


@pytest.mark.card_only
@pytest.mark.parametrize("custom", ["k:a:Zq3vT8wKx1", "k:c:Ab12Cd34Ef", "k:c:ab|cd", "k:a:x|y|z", "k:stop"])
def test_an_unreadable_flag_strikes_taps_with_real_custom_ids(m, clock, custom):
    press = {"id": "1290000000000000001", "custom_id": custom, "token": "t", "app": "999", "message_id": "12"}
    key = carded_unreadable(m, press)
    later(m, clock, 3)
    assert m.c.handovers.journaled() == [] and flags(m) == []
    assert m.ledger.get_meta("tap_quarantine:" + key) is None                 # struck, not set aside


@pytest.mark.card_only
def test_a_rebuilt_press_that_doesnt_match_the_journal_is_set_aside_not_struck(m, clock):
    """An id holding a bar: the key splits on its first bar into another id and custom id than the journal's."""
    press = {"id": "12|34", "custom_id": "k:c:Ab12", "token": "t", "app": "999", "message_id": "12"}
    key = carded_unreadable(m, press)
    later(m, clock, 3)
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["12|34"]  # left as it is
    assert flags(m) == [] and m.ledger.get_meta("tap_quarantine:" + key) is not None
    assert queued(m, Controller.UNREADABLE_STRIKE_WORDS) == []                 # its card is already there


# -- 9. the error counter and reads that answered the records but not the calendar ------------------------------------

@pytest.mark.card_only
def test_errors_between_calendar_unreadable_reads_reach_the_internal_error_card(m, monkeypatch, clock):
    a = unknown_tap(m, "97901")
    calls = {"n": 0}

    def hold(p):
        calls["n"] += 1
        if calls["n"] % 3:
            raise ValueError("bad value")
        return "ended"                                                         # the records answer
    monkeypatch.setattr(m.c, "_records_hold", hold)
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))           # the calendar doesn't
    before = len(m.link.cards)
    for _ in range(20):
        later(m, clock, 3601)
    assert calls["n"] == 10                                                    # six errors, then the seventh: terminal
    assert m.c.handovers.journaled() == []
    said = new_said(m, before)
    assert len([t for t in said if "internal error" in t]) == 1
    assert not [t for t in said if "to tell how far it got" in t]
    diag = json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + m.c.handovers.key(a)))
    assert diag["error_checks"] == len(Controller.CHECK_BACKOFF_S)
