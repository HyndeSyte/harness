"""0.24.0, twenty-third round: the defects the twenty-second outside review found in the twenty-second round's additions.

1. The waiting (told-once) note is keyed on (tap, "note", "waiting"): with the tap journal unwritable its told mark
   never lands, and the note is still queued once, across a restart too.
2. A deferred re-read that the records can't take either (a full or read-only card takes both down) is held in
   memory on the same schedule, so the calendars are read only that many times, across a restart too.
3. The internal-error card says Harness couldn't confirm whether the change was made and asks him to look at his
   calendar; the struck press is kept in the records for tracing (request, identity, last exception, never the
   token). The error counter is per tap and started again only by a read of that tap that answered.
5. A strike-pending flag that can't be read is struck by its tap's id when its card is there, else one operator card;
   its log line at most once an hour. Each through a restart.
7. A tap that settles normally takes its deferred re-read with it, in the same transaction.
All names and ids invented.
"""
import json
import logging
import sqlite3

import pytest

from harness.controller import Controller
from harness.handover import Handover, Inbox
from harness.ledger import Ledger
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m  # noqa: F401
from test_handover_round17_taps import card_labels, new_cards, new_said
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from test_handover_round20_taps import states, unverified_then_killed
from test_handover_round21_taps import how_far, queued_how_far
from test_handover_round22_taps import counted_reads, flags, journal_unwritable, to_the_last_calendar_read
from fake_caldav import no_network  # noqa: F401  (autouse)

WAITING = "can't tell yet whether it went through"


def queued(m, words):
    return [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox").fetchall() if words in r[0]]


# -- 1. one waiting note, however often its told mark fails -----------------------------------------------------------

@pytest.mark.card_only
def test_with_the_journal_unwritable_the_waiting_note_goes_once_across_a_restart(m, monkeypatch, clock, tmp_path):
    dentist_card(m)
    cut_after(m, monkeypatch)
    m.gmail.down = True                                                        # every read waits
    journal_unwritable(monkeypatch)                                            # so its told mark never lands
    before = len(m.link.cards)
    later(m, clock, 61)
    assert len(queued(m, WAITING)) == 1
    for _ in range(200):
        later(m, clock, 3)
    real_restart(m, tmp_path)
    for _ in range(200):
        later(m, clock, 3)
    assert len(queued(m, WAITING)) == 1
    assert len([t for t in new_said(m, before) if WAITING in t]) == 1


# -- 2. the deferral held in memory when the records can't take it ---------------------------------------------------

@pytest.mark.card_only
def test_with_the_journal_and_the_records_unwritable_the_calendar_reads_keep_their_schedule(m, monkeypatch, clock,
                                                                                            tmp_path):
    to_the_last_calendar_read(m, monkeypatch, clock)
    reads = counted_reads(monkeypatch)
    journal_unwritable(monkeypatch)
    monkeypatch.setattr(Controller, "_queue_terminal",
                        lambda self, row: (_ for _ in ()).throw(sqlite3.OperationalError("disk I/O error")))
    real_set = Ledger.set_meta

    def set_meta(self, key, value, db=None):
        if key.startswith("tap_"):
            raise sqlite3.OperationalError("attempt to write a readonly database")
        return real_set(self, key, value, db)
    monkeypatch.setattr(Ledger, "set_meta", set_meta)
    later(m, clock, 3601)                                                      # the last read: unverified
    assert reads["n"] == 1 and flags(m, "tap_reread:") == []                   # the records took nothing
    for _ in range(200):                                                       # ten minutes
        later(m, clock, 3)
    assert reads["n"] <= 4                                                     # then 1, 2 and 5 minutes on
    real_restart(m, tmp_path)                                                  # memory is gone: read at the start
    for _ in range(200):
        later(m, clock, 3)
    assert reads["n"] <= 8                                                     # the same schedule again
    assert states(m) == ["unknown"]                                            # kept, never lost


# -- 3. the internal-error card and its diagnostic copy --------------------------------------------------------------

def raising_hold(m, monkeypatch, exc=ValueError("bad value")):
    reads = {"n": 0}

    def raising(p):
        reads["n"] += 1
        raise exc
    monkeypatch.setattr(m.c, "_records_hold", raising)
    return reads


@pytest.mark.card_only
def test_the_internal_error_card_says_it_couldnt_confirm_and_asks_him_to_look(m, monkeypatch, clock):
    dentist_card(m)
    press = cut_after(m, monkeypatch)
    raising_hold(m, monkeypatch)
    before = len(m.link.cards)
    for _ in range(14):
        later(m, clock, 3601)
    (card,) = [t for t in new_said(m, before) if "internal error" in t]
    assert "couldn't confirm whether the change was made" in card
    assert "Please check your calendar to see whether it's there." in card
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert Controller.TERMINAL_WORDS["internal_error"] in card.replace("\n", " ")
    assert m.c.handovers.journaled() == []                                     # struck
    key = m.c.handovers.key(press)
    diag = json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + key))           # and kept for tracing
    assert diag["state"] == "internal_error"
    assert diag["identity"]["id"] == press["id"] and diag["identity"]["custom_id"] == press["custom_id"]
    assert diag["request"].get("proposal")                                     # the request, recoverable
    assert diag["error"] == "ValueError: bad value"
    assert "token" not in json.dumps(diag)                                     # never the interaction token


def unknown_tap(m, tap_id):
    press = {"id": tap_id, "custom_id": f"k:a:r23{tap_id}", "token": "t", "app": "999", "message_id": "1"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": f"p-{tap_id}", "changes": [],
                                    "keys": []})
    assert h.journal_check(press, 1, m.c._clock() + 60, False)
    return press


@pytest.mark.card_only
def test_the_error_counter_is_per_tap_with_another_tap_read_in_between(m, monkeypatch, clock):
    """Tap A keeps raising; tap B, read in the same ticks, answers (its records still carrying it out). B's reads
    never start A's count again, and A never makes B terminal. (This held on the twenty-second round's code too: a
    guard on the per-tap journal.)"""
    a, b = unknown_tap(m, "97301"), unknown_tap(m, "97302")
    reads = {a["id"]: 0, b["id"]: 0}

    def hold(p):
        reads[p["id"]] += 1
        if p["id"] == a["id"]:
            raise ValueError("bad value")
        return "settling"
    monkeypatch.setattr(m.c, "_records_hold", hold)
    before = len(m.link.cards)
    for _ in range(14):
        later(m, clock, 3601)
    assert reads[a["id"]] == len(Controller.CHECK_BACKOFF_S) + 1               # the schedule, then terminal
    assert reads[b["id"]] >= 13                                                # read every hour all along
    assert [r["press"]["id"] for r in m.c.handovers.journaled()] == [b["id"]]  # only A struck
    assert len([t for t in new_said(m, before) if "internal error" in t]) == 1


@pytest.mark.card_only
def test_a_hold_read_that_couldnt_read_the_records_doesnt_start_the_count_again(m, monkeypatch, clock):
    """Between its errors the tap's own records can't be read ("hold_unread"): not a read that answered, so the count
    goes on. On the twenty-second round's code each one started it again and the tap was never finished."""
    a = unknown_tap(m, "97311")
    calls = {"n": 0, "raised": 0}

    def hold(p):
        calls["n"] += 1
        if calls["n"] % 2 == 0:
            return "hold_unread"
        calls["raised"] += 1
        raise KeyError("state")
    monkeypatch.setattr(m.c, "_records_hold", hold)
    before = len(m.link.cards)
    for _ in range(20):
        later(m, clock, 3601)
    assert calls["raised"] == len(Controller.CHECK_BACKOFF_S) + 1
    assert m.c.handovers.journaled() == []
    assert len([t for t in new_said(m, before) if "internal error" in t]) == 1
    assert a["id"] in json.loads(m.ledger.get_meta(Controller.DIAG_FLAG + m.c.handovers.key(a)))["identity"]["id"]


# -- 5. a strike-pending flag that can't be read ---------------------------------------------------------------------

def flagged_then(m, monkeypatch, clock, value):
    """A terminal tap with its card queued and its strike pending, the flag then left unreadable."""
    unverified_then_killed(m, monkeypatch, clock)
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_strike", lambda *a, **kw: False)                     # the strike didn't happen
        later(m, clock, 3)
    (key,) = [k[len(Controller.STRIKE_FLAG):] for k in flags(m)]
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, value, db)
    return key


@pytest.mark.card_only
@pytest.mark.parametrize("value", ["{not json", json.dumps({"fails": 0, "due": 0})], ids=["malformed", "no-press"])
def test_an_unreadable_strike_flag_with_its_card_there_is_struck_across_a_restart(m, monkeypatch, clock, tmp_path,
                                                                                 value):
    flagged_then(m, monkeypatch, clock, value)
    assert len(queued_how_far(m)) == 1
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 61)
    assert m.c.handovers.journaled() == [] and flags(m) == []                  # struck, the flag settled
    assert len(queued_how_far(m)) == 1 and how_far(m, before) == []            # no second card


@pytest.mark.card_only
@pytest.mark.parametrize("value", ["{not json", json.dumps({"fails": 0, "due": 0})], ids=["malformed", "no-press"])
def test_an_unreadable_strike_flag_with_no_card_raises_one_operator_card(m, clock, tmp_path, caplog, value):
    key = "97401|k:a:r23none"
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, value, db)
    caplog.set_level(logging.ERROR, logger="harness.controller")
    for _ in range(200):                                                       # ten minutes
        later(m, clock, 3)
    said = [r for r in caplog.records if "pending strike's tap couldn't be read" in r.getMessage()]
    assert len(said) == 1                                                      # rate-limited
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 61)
    assert len(queued(m, Controller.UNREADABLE_STRIKE_WORDS)) == 1             # once, across the restart


# -- 7. a normal settle clears the deferred re-read ------------------------------------------------------------------

@pytest.mark.card_only
def test_a_tap_that_settles_normally_takes_its_deferred_reread_with_it(m, monkeypatch, clock):
    dentist_card(m)
    press = cut_after(m, monkeypatch)                                          # run: the dentist is there
    key = m.c.handovers.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.REREAD_FLAG + key, json.dumps({"fails": 1, "due": 0}), db)
    later(m, clock, 61)
    assert m.c.handovers.journaled() == []                                     # settled
    assert m.ledger.get_meta(Controller.REREAD_FLAG + key) is None
