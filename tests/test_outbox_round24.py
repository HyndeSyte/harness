"""0.24.0, twenty-fourth round: the retry card's key, the one allowed ask, and an aborted transaction.

3. A retry card's once-key names the card its attempts are counted on (its relist's generation): a tap relisted twice
   gets its second card's first Go ahead through; a duplicate tap on either card mints nothing; an attempt that can't
   be read is its own value; after six attempts on one card its outcome is recorded once, with no Go ahead.
5. The internal-error card's "check your calendar" is let through only on that card, said once; on another card, or
   said twice, it's reported.
7. A savepoint whose cleanup fails raises TransactionAborted, which a caller's `except Exception` can't swallow: the
   whole transaction goes, outer work included; and with the rollback itself failing the connection is opened again.
All names invented.
"""
import json
import sqlite3

import pytest

from conftest import asks_in, rule_problems
from harness.controller import Controller
from harness.handover import Handover
from harness.ledger import Ledger, TransactionAborted
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_outbox_round23 import RETRY, RollbackFails, retry_targets, texts
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

ASK = "Please check your calendar to see whether it's there."


# -- 3. the retry card's key ------------------------------------------------------------------------------------------

def relisted(m, press):
    """The tap journaled, read as untaken with the calendar unreadable, and relisted through the production path."""
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-r24", "changes": [], "keys": []})
    row = next(r for r in h.journaled() if h.key(r["press"]) == h.key(press))
    m.c._relist_taps([row], restored=False, verdicts={h.key(press): ("untaken_unread", [], {})})
    assert h.journaled() == []


def test_a_tap_relisted_twice_gets_its_second_cards_go_ahead_through(m, monkeypatch):
    press = {"id": "96401", "custom_id": "k:a:r24twice", "token": "t", "app": "999", "message_id": "5"}
    relisted(m, press)
    relisted(m, press)                                                         # a stop or a restore brings it back
    first, second = retry_targets(m)
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))
    m.c._reconfirm_tap(first)
    m.c._reconfirm_tap(first)                                                  # a duplicate tap mints nothing
    assert len(retry_targets(m)) == 3 and len(texts(m, RETRY)) == 1
    m.c._reconfirm_tap(second)                                                 # the second card's first Go ahead
    m.c._reconfirm_tap(second)
    assert len(retry_targets(m)) == 4 and len(texts(m, RETRY)) == 2
    garbled = json.dumps(dict(json.loads(second), attempt="x"))
    m.c._reconfirm_tap(garbled)                                                # its own value, no collision
    m.c._reconfirm_tap(garbled)
    assert len(retry_targets(m)) == 5 and len(texts(m, RETRY)) == 3
    assert json.loads(first)["card"] == "relist1" and json.loads(second)["card"] == "relist2"
    key = "96401|k:a:r24twice"
    for purpose in ("relist1:1", "relist2:1", "relist2:unreadable"):
        assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "retry", purpose)) is not None


def test_after_six_attempts_on_one_card_its_outcome_is_recorded_once(m, monkeypatch):
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))
    target = json.dumps({"id": "96402", "custom_id": "k:a:r24cap", "message_id": "5", "op": {}, "card": "relist1"})
    for _ in range(len(Controller.CHECK_BACKOFF_S)):
        m.c._reconfirm_tap(target)
        target = retry_targets(m)[-1]
    assert json.loads(target)["attempt"] == len(Controller.CHECK_BACKOFF_S)
    n = len(retry_targets(m))
    got = m.c._reconfirm_tap(target)
    m.c._reconfirm_tap(target)
    assert "nothing more is done for that tap" in got
    assert len(retry_targets(m)) == n                                          # no seventh Go ahead
    assert len(texts(m, Controller.RETRY_ENDED_WORDS)) == 1
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key("96402|k:a:r24cap", "retry", "relist1:ended"))


# -- 5. the one allowed ask, on its own card only ---------------------------------------------------------------------

def test_the_check_your_calendar_ask_passes_only_on_the_internal_error_card_and_once():
    card = "A tap of yours from Tue 3:00 PM. " + Controller.TERMINAL_WORDS["internal_error"]
    assert card.count(ASK) == 1 and rule_problems("card", card, []) == []
    other = ("A tap of yours from Tue 3:00 PM. Your calendar couldn't be read just now, so nothing was done for that "
             "tap. " + ASK)
    assert rule_problems("card", other, [])                                    # anywhere else, it's an ask
    assert asks_in(card + " " + ASK)                                           # said twice, even on its own card


# -- 7. an aborted transaction ----------------------------------------------------------------------------------------

def outbox_once_fails(m, monkeypatch):
    real_set = m.ledger.set_meta

    def set_meta(key, value, db=None):
        if key.startswith("outbox_once:"):
            raise RuntimeError("the write failed")
        return real_set(key, value, db)
    monkeypatch.setattr(m.ledger, "set_meta", set_meta)


def committed(m, key):
    other = sqlite3.connect(m.ledger.path)
    try:
        return other.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    finally:
        other.close()


def test_a_caller_that_catches_the_enqueue_error_cant_go_on_in_a_dead_transaction(m, monkeypatch):
    real_conn = m.ledger.db
    outbox_once_fails(m, monkeypatch)
    m.ledger.db = RollbackFails(real_conn)
    with pytest.raises(TransactionAborted) as got:
        with m.ledger.tx() as db:
            m.ledger.set_meta("round24_before", "1", db)
            try:
                m.ledger.enqueue(chat_id=1, kind="notice", text="z24", once="tap:9|outcome|z", db=db)
            except Exception:                                                  # noqa: BLE001: the nested caller
                pass
            m.ledger.set_meta("round24_after", "1", db)                        # never reached
    assert isinstance(got.value.__cause__, RuntimeError)
    monkeypatch.undo()
    m.ledger.db = real_conn
    assert not m.ledger.db.in_transaction
    assert committed(m, "round24_before") is None and committed(m, "round24_after") is None
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text='z24'").fetchone()[0] == 0


def test_an_aborted_transaction_rolls_back_that_taps_work(m, monkeypatch):
    """Through a production caller: a terminal tap's card, mark and strike flag go together or not at all, and the
    tap isn't struck. (Twenty-fifth round: the tap's own boundary holds the error and puts that tap off instead of
    ending the settle; tests/test_outbox_round25.py.)"""
    press = {"id": "96403", "custom_id": "k:a:r24abort", "token": "t", "app": "999", "message_id": "5"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press)) and h.journal_outcome(press, "unverified")
    row = h.journaled()[0]
    real_conn = m.ledger.db
    outbox_once_fails(m, monkeypatch)
    m.ledger.db = RollbackFails(real_conn)
    m.c._finish_terminal([row])                                                # held at the tap's own boundary
    monkeypatch.undo()
    m.ledger.db = real_conn
    key = h.key(press)
    assert committed(m, f"tap_card_queued:{key}") is None and committed(m, Controller.STRIKE_FLAG + key) is None
    assert [r["press"]["id"] for r in h.journaled()] == ["96403"]              # not struck


class RollbackAlsoFails(RollbackFails):
    def rollback(self):
        raise sqlite3.OperationalError("disk I/O error")


def test_with_the_rollback_itself_failing_the_connection_is_opened_again(m, monkeypatch):
    real_conn = m.ledger.db
    outbox_once_fails(m, monkeypatch)
    m.ledger.db = RollbackAlsoFails(real_conn)
    with pytest.raises(TransactionAborted) as got:
        m.ledger.enqueue(chat_id=1, kind="notice", text="z24b", once="tap:9|outcome|zb")
    assert isinstance(got.value.__cause__.__cause__, sqlite3.OperationalError)
    monkeypatch.undo()
    assert not isinstance(m.ledger.db, RollbackFails)                          # a new connection
    assert not m.ledger.db.in_transaction
    m.ledger.set_meta("round24_probe", "1")
    assert committed(m, "round24_probe") == ("1",)
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text='z24b'").fetchone()[0] == 0
