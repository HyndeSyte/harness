"""0.24.0, twenty-third round: which cards about a tap are keyed, and the enqueue savepoint's cleanup.

1. One tap's terminal outcome card, its retry card and its waiting note, each through its production enqueue site, all
   go; a duplicate of each is refused; a new retry attempt goes.
4. A savepoint whose rollback-to fails on the records' autocommit connection keeps the original exception (the
   cleanup's chained to it) and never leaves the connection inside a transaction: a following write commits.
All names invented.
"""
import json
import sqlite3
from zoneinfo import ZoneInfo

import pytest

from harness.ledger import Ledger, TransactionAborted
from test_handover_round16_taps import m  # noqa: F401
from test_discord_keeper import OWNER  # noqa: F401
from test_outbox_round20 import posted
from test_plain_commands import nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from fake_caldav import no_network  # noqa: F401  (autouse)

RETRY = "Your calendar still couldn't be read, so nothing was done for that tap."
WAITING = "can't tell yet whether it went through"


def texts(m, words):
    return [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox ORDER BY id").fetchall() if words in r[0]]


def retry_targets(m):
    return [r[0] for r in m.ledger.db.execute("SELECT target FROM choices WHERE kind='tap_reconfirm' ORDER BY rowid")]


# -- 1. the keyed cards about one tap ---------------------------------------------------------------------------------

def test_one_taps_outcome_retry_and_waiting_note_all_go_and_duplicates_of_each_are_refused(m, monkeypatch):
    press = {"id": "96301", "custom_id": "k:a:r23three", "message_id": "5"}
    row = {"press": press, "at": 1794000000.0, "state": "unverified", "op": {}, "told_check": False}
    # its terminal outcome card, twice
    m.c._queue_terminal(row)
    m.c._queue_terminal(row)
    # its retry card: his Go ahead on a card while the calendar can't be read, the same tap sent twice
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))
    target = json.dumps({"id": press["id"], "custom_id": "k:a:r23three", "message_id": "5", "op": {}})
    m.c._reconfirm_tap(target)
    m.c._reconfirm_tap(target)
    assert len(retry_targets(m)) == 1                                          # nothing minted for the duplicate
    # its waiting note, twice (its told mark never landed)
    tz, owner = ZoneInfo(m.c.config.timezone), m.c.config.owner_user_id
    m.c._tell_waits([(row, "unread", None, 2, "calendar")], tz, owner)
    m.c._tell_waits([(row, "unread", None, 2, "calendar")], tz, owner)
    key = m.c.handovers.key(press)
    assert len(texts(m, "Harness couldn't read your calendar to tell how far it got")) == 1
    assert len(texts(m, RETRY)) == 1
    assert len(texts(m, WAITING)) == 1
    # twenty-fourth round: the retry card's key names the card its attempts count on (no relist here: "relist0")
    for kind, purpose in (("outcome", "unverified"), ("retry", "relist0:1"), ("note", "waiting")):
        assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, kind, purpose)) is not None
    # a new attempt (his Go ahead on the retry card) goes, once
    (again,) = retry_targets(m)
    assert json.loads(again)["attempt"] == 1
    m.c._reconfirm_tap(again)
    m.c._reconfirm_tap(again)
    assert len(texts(m, RETRY)) == 2
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "retry", "relist0:2")) is not None
    before = len(m.link.cards)
    m.c.outbox.flush()
    sent = [c["text"] for c in posted(m, before)]
    assert len(sent) == 4                                                      # outcome, two retries, the note


def test_a_retry_card_with_an_unreadable_attempt_is_its_own_value(m, monkeypatch):
    """Twenty-fourth round: no longer counted as the first (it collided with a genuine first attempt)."""
    monkeypatch.setattr(m.c, "_tap_read", lambda op: ("unread", []))
    target = json.dumps({"id": "96302", "custom_id": "k:a:r23four", "message_id": "5", "op": {}, "attempt": "x"})
    m.c._reconfirm_tap(target)
    key = "96302|k:a:r23four"
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "retry", "relist0:unreadable")) is not None
    assert m.ledger.get_meta("outbox_once:" + Ledger.once_key(key, "retry", "relist0:1")) is None


# -- 4. the savepoint's cleanup ---------------------------------------------------------------------------------------

class RollbackFails:
    """The records' autocommit connection, with its savepoint rollback-to failing."""

    def __init__(self, real):
        self.real = real

    def execute(self, sql, *a, **kw):
        if sql.startswith("ROLLBACK TO SAVEPOINT"):
            raise sqlite3.OperationalError("disk I/O error")
        return self.real.execute(sql, *a, **kw)

    def __getattr__(self, name):
        return getattr(self.real, name)


def test_a_failing_rollback_keeps_the_original_error_and_a_following_write_commits(m, monkeypatch):
    real_conn = m.ledger.db
    assert real_conn.isolation_level is None and not real_conn.in_transaction
    real_set = m.ledger.set_meta

    def set_meta(key, value, db=None):
        if key.startswith("outbox_once:"):
            raise RuntimeError("the write failed")
        return real_set(key, value, db)
    monkeypatch.setattr(m.ledger, "set_meta", set_meta)
    m.ledger.db = RollbackFails(real_conn)
    # twenty-fourth round: a distinct TransactionAborted, the original its cause and the cleanup's error the original's
    with pytest.raises(TransactionAborted) as got:
        m.ledger.enqueue(chat_id=1, kind="notice", text="z", once="tap:9|outcome|z")
    assert isinstance(got.value.__cause__, RuntimeError) and "the write failed" in str(got.value.__cause__)
    assert isinstance(got.value.__cause__.__cause__, sqlite3.OperationalError)
    monkeypatch.undo()
    if isinstance(m.ledger.db, RollbackFails):
        m.ledger.db = real_conn
    assert not m.ledger.db.in_transaction                                      # not left holding the write lock
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text='z'").fetchone()[0] == 0
    m.ledger.set_meta("round23_probe", "1")
    other = sqlite3.connect(m.ledger.path)                                     # committed: seen from outside
    try:
        assert other.execute("SELECT value FROM meta WHERE key='round23_probe'").fetchone() == ("1",)
    finally:
        other.close()
