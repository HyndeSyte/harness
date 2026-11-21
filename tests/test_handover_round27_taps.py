"""0.24.0, twenty-seventh round: the defects the twenty-sixth outside review found in the twenty-sixth round's additions.

1. A relist mark whose value can't be read counts as unreadable, not empty: the count goes on from the file beside
   the journal, and the six-relist cap holds.
2. A calendar read that failed is never kept as a relist's verdict: once the calendar answers again, the tap is read
   once more and settles on what it shows.
3. An unknown tap at a restore whose relist was put off, with no next read in the journal, is settled without a
   restart: the start replay re-arms for it.
4. A requeue whose transaction the records refuse leaves the tap set aside, and the intent it appended gets no card,
   at a real restart either.
6. A tap whose relist count can't be read anywhere ends with its own words (it couldn't be tried again safely), not
   with the words for a tap brought back several times.
9. A requeue matches a torn journal line to its tap by whole fields, so another tap's line never makes it unknown.
All names and ids invented.
"""
import json
import sqlite3

import pytest

from harness import migrate
from harness.controller import Controller
from harness.handover import Handover
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m, tap_journaled  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round23_taps import queued, unknown_tap
from test_handover_round25_taps import relist_refused_for, settled
from test_handover_round26_taps import marks_unreadable, reconfirms
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)


# -- 1. a corrupt relist mark goes to the count beside the journal ------------------------------------------------------

@pytest.mark.card_only
def test_a_corrupt_relist_mark_counts_on_from_the_file_beside_the_journal(m):
    press = {"id": "97101", "custom_id": "k:a:r27gen", "token": "t", "app": "999", "message_id": "5"}
    key = m.c.handovers.key(press)
    for _ in range(3):                                                         # three relists, counted both places
        relisted(m, press)
    assert reconfirms(m) == 3
    for _ in range(Controller.RELIST_GEN_CAP + 2):                             # its mark corrupt before each relist
        m.ledger.db.execute("UPDATE meta SET value='{\"gen\": 3, \"pend' WHERE key=?", (Controller.RELIST_FLAG + key,))
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP                          # never a seventh Go ahead
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1                  # it ends, once


@pytest.mark.card_only
def test_a_corrupt_relist_mark_with_no_count_beside_the_journal_ends_the_tap(m, monkeypatch):
    press = {"id": "97102", "custom_id": "k:a:r27gen2", "token": "t", "app": "999", "message_id": "5"}
    key = m.c.handovers.key(press)
    relisted(m, press)
    monkeypatch.setattr(Controller, "_side_load", lambda self: {})            # nothing readable beside the journal
    m.ledger.db.execute("UPDATE meta SET value='not json' WHERE key=?", (Controller.RELIST_FLAG + key,))
    relisted(m, press)
    assert reconfirms(m) == 1                                                  # fails closed: no second Go ahead
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1


# -- 2. a failed read is never kept as a verdict ------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_failed_read_isnt_kept_so_the_tap_reads_again_once_the_calendar_answers(m, monkeypatch, clock):
    press = unknown_tap(m, "97201")
    key = m.c.handovers.key(press)
    state = {"down": True, "after": 0}

    def read(self, op):
        if not state["down"]:
            state["after"] += 1
            return ("done", [])                                                # it's on the calendar
        return ("unread", [])
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    monkeypatch.setattr(Controller, "_tap_read", read)
    with monkeypatch.context() as mp:
        relist_refused_for(mp, key)
        for _ in range(3):                                                     # an outage, the records refusing
            later(m, clock, 3601)
        assert key not in m.c.__dict__.get("_relist_verdicts", {})             # the failed read isn't kept
        state["down"] = False                                                  # the calendar answers again
        for _ in range(3):                                                     # the records still refuse
            later(m, clock, 3601)
    for _ in range(2):
        later(m, clock, 3601)
    assert state["after"] == 1                                                 # read once after it came back
    assert m.c.handovers.journaled() == []
    assert queued(m, "nothing is left to do")                                  # settled on what the calendar shows
    assert reconfirms(m) == 0                                                  # no Go ahead from the stale verdict


def test_only_a_read_that_answered_is_kept(m):
    for seen in ("unread", "untaken_unread", "records_unread"):
        m.c._keep_verdict(f"{seen}|x", (seen, [], {}))
        assert m.c._kept_verdict(f"{seen}|x") is None
    m.c._keep_verdict("part|x", ("mixed", [("Dentist", "done"), ("Gym", "unread")], {}))
    assert m.c._kept_verdict("part|x") is None
    m.c._keep_verdict("ok|x", ("untaken", [], {}))
    assert m.c._kept_verdict("ok|x") == ("untaken", [], {})
    m.c._keep_verdict("ok|x", ("unread", [], {}))                              # a later failed read drops it
    assert m.c._kept_verdict("ok|x") is None


# -- 3. a restore-boundary tap put off with no next read in the journal ------------------------------------------------

@pytest.mark.card_only
def test_a_boundary_tap_with_no_next_read_is_settled_without_a_restart(m, monkeypatch, clock, tmp_path):
    h = m.c.handovers
    press = {"id": "97301", "custom_id": "k:a:r27edge", "token": "t", "app": "999", "message_id": "1"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-97301", "changes": [], "keys": []})
    key = h.key(press)
    row = next(r for r in h.journaled() if h.key(r["press"]) == key)
    assert row["state"] == "unknown" and row.get("next_check") is None        # no check line
    with open(h.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:   # put off: due in two minutes
        json.dump({"taps": {key: {"fails": 2, "due": m.c._clock() + 120}}}, f)
    monkeypatch.setattr(Controller, "restored_at_start", True, raising=False)  # a restore at this start
    monkeypatch.setattr(Controller, "_tap_read", lambda self, op: ("not_done", []))
    with monkeypatch.context() as mp:
        relist_refused_for(mp, key)                                            # its relist refused once it's due
        real_restart(m, tmp_path)
        assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["97301"]
        for _ in range(50):                                                    # past its due: refused, put off
            later(m, clock, 3)
        assert [r["press"]["id"] for r in m.c.handovers.journaled()] == ["97301"]
    for _ in range(12 * 20):                                                   # twelve minutes, no restart
        later(m, clock, 3)
    assert settled(m, press)


# -- 4. a requeue the records refuse leaves no intent to act on ---------------------------------------------------------

class RefusingConnection:
    """The set-aside tool's own connection to the records, refusing its transaction."""

    def __init__(self, real):
        self._real = real

    def execute(self, sql, *a):
        if sql.strip().upper().startswith("BEGIN"):
            raise sqlite3.OperationalError("database or disk is full")
        return self._real.execute(sql, *a)

    def __getattr__(self, name):
        return getattr(self._real, name)


@pytest.mark.card_only
def test_a_requeue_the_records_refuse_leaves_the_tap_set_aside_with_no_card(m, monkeypatch, clock, tmp_path):
    h = m.c.handovers
    press = {"id": "97401", "custom_id": "k:a:r27req", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_delivered(press)                                          # started, with no intent written
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    real_connect = sqlite3.connect
    with monkeypatch.context() as mp:
        mp.setattr(sqlite3, "connect", lambda *a, **kw: RefusingConnection(real_connect(*a, **kw)))
        got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal)
    assert not got["ok"] and "stays set aside" in got["said"]
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
    assert any("intent" in r for r in h.lines_for(key))                        # the intent the requeue appended
    before = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    real_restart(m, tmp_path)
    for _ in range(10):
        later(m, clock, 61)
    real_restart(m, tmp_path)
    for _ in range(3):
        later(m, clock, 3601)
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == before   # no card for it
    assert reconfirms(m) == 0
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None   # still set aside


@pytest.mark.card_only
def test_the_strike_resumes_skip_a_set_aside_tap(m, monkeypatch, clock):
    h = m.c.handovers
    press = {"id": "97402", "custom_id": "k:a:r27req2", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps(
            {"press": dict(press), "gen": 2, "pending": True, "fails": 0, "due": 0.0}), db)
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, json.dumps(
            {"press": dict(press), "fails": 0, "due": 0.0, "state": "unverified"}), db)
    lines = h.lines_for(key)
    for _ in range(5):
        later(m, clock, 61)
    assert h.lines_for(key) == lines                                           # never struck while set aside


@pytest.mark.card_only
def test_a_start_replay_that_cant_read_the_set_aside_taps_acts_on_none(m, monkeypatch, clock, tmp_path):
    h = m.c.handovers
    press = {"id": "97403", "custom_id": "k:a:r27req3", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"requeued": True})                         # the intent a requeue appended
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    real = Controller._quarantined
    state = {"n": 0}

    def quarantined(self):
        state["n"] += 1
        if state["n"] == 1:                                                    # the start replay's first read
            raise sqlite3.OperationalError("database is locked")
        return real(self)
    monkeypatch.setattr(Controller, "_quarantined", quarantined)
    before = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 61)
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == before   # no card for it
    assert [r["press"]["id"] for r in h.journaled()] == ["97403"]              # its lines left as they were


# -- 6. a tap with no readable count anywhere -------------------------------------------------------------------------

@pytest.mark.card_only
def test_a_never_relisted_tap_with_no_readable_count_gets_its_own_end(m, monkeypatch):
    press = {"id": "97601", "custom_id": "k:a:r27none", "token": "t", "app": "999", "message_id": "5"}
    marks_unreadable(monkeypatch)
    monkeypatch.setattr(Controller, "_side_load", lambda self: {})
    relisted(m, press)                                                         # its very first relist
    assert reconfirms(m) == 0                                                  # no Go ahead: it can't be counted
    got = queued(m, Controller.UNKNOWN_COUNT_WORDS)
    assert len(got) == 1 and queued(m, Controller.RELIST_ENDED_WORDS) == []
    assert "several times" not in got[0] and "brought" not in got[0]


# -- 9. a torn line matched by whole fields -----------------------------------------------------------------------------

@pytest.mark.card_only
def test_another_taps_torn_line_doesnt_make_a_requeue_unknown(m):
    h = m.c.handovers
    press = {"id": "97901", "custom_id": "k:a:r27a", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))                  # a press and nothing else
    with open(h.journal, "a", encoding="utf-8") as f:                          # another tap's torn lines
        f.write('{"press": {"id": "97902", "custom_id": "k:a:r27ab", "tok\n')
        f.write('{"intent": "97902|k:a:r27ab", "op": {"eff\n')
        f.write('{"press": {"custom_id": "k:a:r27a2", "tok\n')
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=h.journal)
    assert got["ok"] and "never acted on" in got["said"]


@pytest.mark.parametrize("raw, mine", [
    ('{"intent": "97911|k:a:r27b", "op": {"eff', True),
    ('{"press": {"id": "97911", "cust', True),
    ('{"press": {"id": "97911", "custom_id": "k:a:r27b", "to', True),
    ('{"press": {"custom_id": "k:a:r27b", "to', True),
    ('{"intent": "97911|k:a:r27bc", "op": {"eff', False),
    ('{"press": {"id": "979111", "custom_id": "k:a:r27b", "to', False),
    ('{"press": {"id": "97912", "custom_id": "k:a:r27b", "to', False),
    ('{"press": {"id": "97911", "custom_id": "k:a:r27bb", "to', False),
    ('{"press": {"custom_id": "k:a:r27bb", "to', False),
])
def test_a_torn_line_names_a_tap_only_by_whole_fields(raw, mine):
    assert migrate._torn_names(raw, "97911|k:a:r27b") is mine
