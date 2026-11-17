"""0.24.0, twenty-second round: the defects the twenty-first outside review found in the twenty-first round's additions.

1. A terminal tap's card, its "card queued" mark and a "strike pending" flag are committed in the records first; the
   strike (the journal's rename) follows as an idempotent cleanup, resumed from the flag at every tick and at a start.
   A kill between any two steps ends with exactly one card and the tap struck.
2. A hold read that keeps raising an error in Harness itself (not a database or I/O error) is counted per tap; after
   the six-read schedule its outcome is a terminal internal error: one card with no Go ahead that says so (never that
   the records couldn't be read), struck, and never read hourly.
4. An unverified outcome that can't be journaled never sends the calendars a read at every tick: the reads are
   bounded, across a restart too.
7. The unidentified card leads with its own sentence.
9. A failing strike's next try is persisted in the records, so a restart respects it.
All names and ids invented.
"""
import logging
import sqlite3

import pytest

from harness.controller import Controller
from harness.handover import Handover, Inbox
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m  # noqa: F401
from test_handover_round17_taps import card_labels, new_cards, new_said
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from test_handover_round20_taps import Killed, states, unverified_then_killed
from test_handover_round21_taps import how_far, queued_how_far
from fake_caldav import no_network  # noqa: F401  (autouse)


def flags(m, prefix="tap_strike:"):
    return [r[0] for r in m.ledger.db.execute("SELECT key FROM meta WHERE substr(key, 1, ?)=?",
                                              (len(prefix), prefix)).fetchall()]


# -- 1. the records first, then the strike -----------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_kill_after_the_commit_before_the_rename_ends_with_one_card_and_the_tap_struck(m, monkeypatch, clock,
                                                                                        tmp_path):
    """Its ending (one card, the tap struck) held on the twenty-first round's order too, where the kill rolled the
    card back and the next start queued it again; what fails there is the strike pending in the records."""
    unverified_then_killed(m, monkeypatch, clock)
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_strike", lambda *a, **kw: (_ for _ in ()).throw(Killed()))
        with pytest.raises(Killed):
            later(m, clock, 3)
    assert states(m) == ["unverified"] and len(queued_how_far(m)) == 1         # the card is committed
    assert len(flags(m)) == 1                                                  # with its strike pending
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 3)
    assert m.c.handovers.journaled() == [] and flags(m) == []
    assert len(queued_how_far(m)) == 1
    assert len(how_far(m, before)) == 1                                        # sent once, at the restart


@pytest.mark.card_only
def test_a_kill_after_the_rename_ends_with_one_card_and_the_tap_struck(m, monkeypatch, clock, tmp_path):
    unverified_then_killed(m, monkeypatch, clock)
    real = m.c.handovers.journal_done

    def done_then_killed(press, *, strict=False):
        real(press, strict=strict)                                             # the rename reached the disk
        raise Killed()
    with monkeypatch.context() as mp:
        mp.setattr(m.c.handovers, "journal_done", done_then_killed)
        with pytest.raises(Killed):
            later(m, clock, 3)
    assert m.c.handovers.journaled() == []                                     # struck
    assert len(queued_how_far(m)) == 1                                         # and its card is there
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 3)
    assert flags(m) == []                                                      # the flag cleared at the start
    assert len(queued_how_far(m)) == 1
    assert len(how_far(m, before)) == 1


@pytest.mark.card_only
def test_a_pending_strike_is_resumed_from_the_records_in_the_running_loop(m, monkeypatch, clock):
    unverified_then_killed(m, monkeypatch, clock)
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_strike", lambda *a, **kw: False)                     # the strike didn't happen
        later(m, clock, 3)
    assert len(flags(m)) == 1 and states(m) == ["unverified"]
    later(m, clock, 3)
    assert m.c.handovers.journaled() == [] and flags(m) == []
    assert len(queued_how_far(m)) == 1


# -- 9. the strike's back-off survives a restart -----------------------------------------------------------------------

@pytest.mark.card_only
def test_a_failing_strikes_next_try_is_respected_across_a_restart(m, monkeypatch, clock, tmp_path):
    unverified_then_killed(m, monkeypatch, clock)
    calls = {"n": 0}

    def rewrite(self, keep):
        calls["n"] += 1
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(Inbox, "_rewrite", rewrite)
    later(m, clock, 3)
    assert calls["n"] == 1 and len(queued_how_far(m)) == 1
    real_restart(m, tmp_path)                                                  # at once, inside its minute
    later(m, clock, 3)
    assert calls["n"] == 1                                                     # not tried again at the start
    later(m, clock, 60)
    assert calls["n"] == 2                                                     # tried again once it's due
    monkeypatch.undo()
    for _ in range(3):
        later(m, clock, 121)
    assert m.c.handovers.journaled() == [] and flags(m) == []
    assert len(queued_how_far(m)) == 1


# -- 2. an error in Harness itself on the hold read --------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.parametrize("exc", [ValueError("bad value"), KeyError("state")], ids=["ValueError", "KeyError"])
def test_a_hold_read_that_keeps_raising_ends_as_an_internal_error(m, monkeypatch, clock, exc):
    dentist_card(m)
    cut_after(m, monkeypatch)
    reads = {"n": 0}

    def raising(p):
        reads["n"] += 1
        raise exc
    monkeypatch.setattr(m.c, "_records_hold", raising)
    before = len(m.link.cards)
    for _ in range(14):
        later(m, clock, 3601)
    assert reads["n"] == len(Controller.CHECK_BACKOFF_S) + 1                  # the schedule, then terminal
    assert m.c.handovers.journaled() == [] and flags(m) == []
    for _ in range(6):
        later(m, clock, 3601)
    assert reads["n"] == len(Controller.CHECK_BACKOFF_S) + 1                  # never read hourly after that
    said = new_said(m, before)
    cards = [t for t in said if "internal error" in t]
    assert len(cards) == 1
    assert not any("records couldn't be read" in t for t in said)             # never said as unreadable records
    assert "Go ahead" not in card_labels(new_cards(m, before))


@pytest.mark.card_only
def test_the_error_counter_starts_again_after_a_read_that_answers(m, monkeypatch, clock):
    dentist_card(m)
    cut_after(m, monkeypatch)
    real = m.c._records_hold
    mode = {"raise": True}

    def flaky(p):
        if mode["raise"]:
            raise ValueError("bad value")
        return "settling"                                                      # the records answer: still running
    monkeypatch.setattr(m.c, "_records_hold", flaky)
    for _ in range(5):
        later(m, clock, 3601)
    (row,) = m.c.handovers.journaled()
    assert row["error_checks"] == 5
    mode["raise"] = False
    later(m, clock, 3601)
    (row,) = m.c.handovers.journaled()
    assert row["error_checks"] == 0 and row["state"] == "unknown"
    monkeypatch.setattr(m.c, "_records_hold", real)


# -- 4. an unverified outcome that can't be journaled ------------------------------------------------------------------

def to_the_last_calendar_read(m, monkeypatch, clock):
    dentist_card(m)
    cut_after(m, monkeypatch)
    m.gmail.down = True
    for wait in (61, 121, 301, 901, 1801):
        later(m, clock, wait)


def journal_unwritable(monkeypatch):
    monkeypatch.setattr(Inbox, "_append", lambda self, row: False)
    monkeypatch.setattr(Inbox, "_rewrite", lambda self, keep: (_ for _ in ()).throw(OSError(30, "Read-only")))


def counted_reads(monkeypatch):
    reads = {"n": 0}
    real = Controller._tap_read

    def read(self, op):
        reads["n"] += 1
        return real(self, op)
    monkeypatch.setattr(Controller, "_tap_read", read)
    return reads


@pytest.mark.card_only
def test_an_unjournaled_unverified_outcome_reads_the_calendars_a_bounded_number_of_times(m, monkeypatch, clock,
                                                                                         tmp_path):
    to_the_last_calendar_read(m, monkeypatch, clock)
    reads = counted_reads(monkeypatch)
    journal_unwritable(monkeypatch)
    before = len(m.link.cards)
    later(m, clock, 3601)                                                      # the last read: unverified
    assert reads["n"] == 1 and len(queued_how_far(m)) == 1
    for _ in range(200):
        later(m, clock, 3)
    assert reads["n"] <= 2
    real_restart(m, tmp_path)
    for _ in range(200):
        later(m, clock, 3)
    assert reads["n"] <= 3                                                     # bounded across the restart too
    assert len(queued_how_far(m)) == 1 and len(how_far(m, before)) == 1


@pytest.mark.card_only
def test_with_the_card_unqueueable_too_the_next_read_is_put_off_on_the_backoff(m, monkeypatch, clock, tmp_path):
    to_the_last_calendar_read(m, monkeypatch, clock)
    reads = counted_reads(monkeypatch)
    journal_unwritable(monkeypatch)
    monkeypatch.setattr(Controller, "_queue_terminal",
                        lambda self, row: (_ for _ in ()).throw(sqlite3.OperationalError("database is locked")))
    later(m, clock, 3601)
    assert reads["n"] == 1
    assert len(flags(m, "tap_reread:")) == 1                                   # its next read, in the records
    for _ in range(200):                                                       # ten minutes
        later(m, clock, 3)
    assert reads["n"] <= 5                                                     # 1, 2 and 5 minutes on, not 200
    real_restart(m, tmp_path)
    for _ in range(200):
        later(m, clock, 3)
    assert reads["n"] <= 7
    assert states(m) == ["unknown"]                                            # kept, never lost


# -- 7. the unidentified card's lead ----------------------------------------------------------------------------------

@pytest.mark.card_only
def test_the_unidentified_card_says_which_request_it_couldnt_tell(m, clock):
    press = {"id": "not-a-tap", "custom_id": "k:a:who22", "token": "t", "app": "999", "message_id": "1"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-x", "changes": [], "keys": []})
    assert h.journal_check(press, 1, m.c._clock() + 60, False)
    before = len(m.link.cards)
    later(m, clock, 61)
    (card,) = [t for t in new_said(m, before) if "which request" in t]
    assert "couldn't tell which request this tap was for; nothing was changed." in card
    assert "stopped or hit an error before it noted" not in card
    assert h.journaled() == []
