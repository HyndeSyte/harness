"""0.24.0, twenty-eighth round: the defects the twenty-seventh outside review found in the twenty-seventh round's
additions.

1. A relist mark is checked against its schema: one that isn't an object, or whose generation is missing, null, not
   an integer, or outside 0 to 6, goes to the count beside the journal (the larger of the two when both read), the
   pending-strike reader included; with neither, the tap ends with its own words. Never a seventh Go ahead.
2. A requeue the records refuse leaves at most one intent for its tap: a later requeue that goes through gives one
   read, at most one Go ahead and one card, and a discard clears the orphan intent.
3. A start replay that can't read the set-aside taps backs off (1, 5, 15 minutes), says so once, and settles every
   tap it put off within one pass once the records answer.
4. A tap read as done whose relist the records keep refusing settles as already done once they take it: no unknown
   end, no Go ahead, and at most one calendar read per scheduled try.
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
from test_handover_round26_taps import reconfirms
from test_handover_round27_taps import RefusingConnection
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)


def tap(n):
    return {"id": str(n), "custom_id": f"k:a:r28{n}", "token": "t", "app": "999", "message_id": "5"}


def set_mark(m, key, raw):
    m.ledger.db.execute("UPDATE meta SET value=? WHERE key=?", (raw, Controller.RELIST_FLAG + key))


def mark(m, key):
    return json.loads(m.ledger.get_meta(Controller.RELIST_FLAG + key))


# -- 1. a relist mark checked against its schema -----------------------------------------------------------------------

BAD_GENS = [
    pytest.param('{"pending": false}', id="missing"),
    pytest.param('{"gen": null, "pending": false}', id="null"),
    pytest.param('{"gen": "x", "pending": false}', id="string"),
    pytest.param('{"gen": -1, "pending": false}', id="negative"),
    pytest.param('{"gen": 99, "pending": false}', id="over-cap"),
    pytest.param('{"gen": 2.5, "pending": false}', id="fraction"),
    pytest.param('{"gen": true, "pending": false}', id="bool"),
    pytest.param('[6]', id="not-an-object"),
]


@pytest.mark.card_only
@pytest.mark.parametrize("raw", BAD_GENS)
@pytest.mark.parametrize("restart", [False, True])
def test_a_bad_generation_after_six_relists_gives_no_seventh_go_ahead(m, raw, restart, tmp_path):
    press = tap(98101)
    key = m.c.handovers.key(press)
    for _ in range(Controller.RELIST_GEN_CAP):                                 # six relists, counted both places
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP
    for _ in range(3):
        set_mark(m, key, raw)
        if restart:
            real_restart(m, tmp_path)
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP                          # never a seventh Go ahead
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1                  # it ends, once, as brought back
    assert queued(m, Controller.UNKNOWN_COUNT_WORDS) == []


@pytest.mark.card_only
@pytest.mark.parametrize("raw", BAD_GENS)
@pytest.mark.parametrize("restart", [False, True])
def test_a_bad_generation_after_three_relists_counts_on_from_beside_the_journal(m, raw, restart, tmp_path):
    press = tap(98102)
    key = m.c.handovers.key(press)
    for _ in range(3):
        relisted(m, press)
    set_mark(m, key, raw)
    if restart:
        real_restart(m, tmp_path)
    relisted(m, press)                                                         # its fourth, counted on from three
    assert reconfirms(m) == 4
    assert mark(m, key)["gen"] == 4
    assert queued(m, Controller.RELIST_ENDED_WORDS) == [] and queued(m, Controller.UNKNOWN_COUNT_WORDS) == []
    for _ in range(5):
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


@pytest.mark.card_only
@pytest.mark.parametrize("raw", BAD_GENS)
def test_a_bad_generation_with_no_count_beside_the_journal_ends_with_its_own_words(m, raw, monkeypatch):
    press = tap(98103)
    key = m.c.handovers.key(press)
    relisted(m, press)
    monkeypatch.setattr(Controller, "_side_load", lambda self: {})
    set_mark(m, key, raw)
    relisted(m, press)
    assert reconfirms(m) == 1
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1 and queued(m, Controller.RELIST_ENDED_WORDS) == []


@pytest.mark.card_only
def test_the_larger_of_the_mark_and_the_count_beside_the_journal_is_used(m):
    press = tap(98104)
    key = m.c.handovers.key(press)
    for _ in range(5):
        relisted(m, press)
    set_mark(m, key, json.dumps({"gen": 2, "pending": False}))                 # the mark behind the file beside it
    relisted(m, press)
    assert mark(m, key)["gen"] == 6 and reconfirms(m) == 6
    relisted(m, press)
    assert reconfirms(m) == 6 and len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


@pytest.mark.card_only
@pytest.mark.parametrize("gen", [None, "x", -1, 99])
def test_a_pending_strike_with_a_bad_generation_keeps_the_count_beside_the_journal(m, gen, tmp_path):
    press = tap(98105)
    h = m.c.handovers
    key = h.key(press)
    for _ in range(Controller.RELIST_GEN_CAP):
        relisted(m, press)
    assert h.journal_add(Handover(kind="press", press=press))                  # its strike didn't happen
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-r28", "changes": [], "keys": []})
    set_mark(m, key, json.dumps({"press": press, "gen": gen, "pending": True, "fails": 0, "due": 0.0}))
    real_restart(m, tmp_path)                                                  # the start replay strikes it
    assert h.journaled() == []
    assert mark(m, key) == {"gen": Controller.RELIST_GEN_CAP, "pending": False}   # its count kept, never nought
    relisted(m, press)                                                         # it comes back once more
    assert reconfirms(m) == Controller.RELIST_GEN_CAP
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


@pytest.mark.card_only
def test_a_corrupt_mark_on_a_pending_strike_tap_gives_no_seventh_go_ahead(m, clock, tmp_path):
    press = tap(98106)
    h = m.c.handovers
    key = h.key(press)
    for _ in range(Controller.RELIST_GEN_CAP):
        relisted(m, press)
    assert h.journal_add(Handover(kind="press", press=press))                  # its strike didn't happen
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-r28", "changes": [], "keys": []})
    assert h.journal_check(press, 1, m.c._clock() + 60, False)
    set_mark(m, key, '{"press": {"id": "98106"}, "gen": 6, "pend')               # not JSON at all
    m.c._tap_read = lambda op: ("not_done", [])
    real_restart(m, tmp_path)
    m.c._tap_read = lambda op: ("not_done", [])
    for _ in range(4):
        later(m, clock, 3601)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP                          # never a seventh Go ahead
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1
    assert h.journaled() == []


# -- 2. a requeue the records refuse leaves at most one intent ---------------------------------------------------------

def set_aside_started(m, n):
    h = m.c.handovers
    press = tap(n)
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_delivered(press)                                          # started, with no intent written
    key = h.key(press)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    return press, key


def refused(m, mp, key, action):
    real_connect = sqlite3.connect
    mp.setattr(sqlite3, "connect", lambda *a, **kw: RefusingConnection(real_connect(*a, **kw)))
    got = migrate.set_aside_taps(m.ledger.path, key, action, journal=m.c.handovers.journal)
    assert not got["ok"] and "stays set aside" in got["said"]


def intents(m, key):
    return [r for r in m.c.handovers.lines_for(key) if "intent" in r]


@pytest.mark.card_only
def test_a_refused_requeue_then_one_that_goes_through_reads_and_cards_once(m, monkeypatch, clock, tmp_path):
    press, key = set_aside_started(m, 98201)
    for _ in range(2):                                                         # refused twice
        with monkeypatch.context() as mp:
            refused(m, mp, key, "requeue")
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"] and "requeued as unknown" in got["said"]
    assert len(intents(m, key)) == 1                                           # one intent, whichever requeue
    reads = {"n": 0}

    def read(self, op):
        reads["n"] += 1
        return ("not_done", [])
    monkeypatch.setattr(Controller, "_tap_read", read)
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    real_restart(m, tmp_path)
    for _ in range(6):
        later(m, clock, 3601)
    assert reads["n"] <= 1
    assert reconfirms(m) <= 1
    assert len(queued(m, "A tap of yours from")) == 1                         # its one card (with the summary)
    assert m.c.handovers.journaled() == []


@pytest.mark.card_only
def test_a_refused_requeue_then_a_discard_leaves_no_intent_to_act_on(m, monkeypatch, clock, tmp_path):
    press, key = set_aside_started(m, 98202)
    other = tap(98203)
    with open(m.c.handovers.journal, "a", encoding="utf-8") as f:              # another tap's torn line stays
        f.write('{"press": {"id": "98203", "tok\n')
    with monkeypatch.context() as mp:
        refused(m, mp, key, "requeue")
    assert len(intents(m, key)) == 1                                           # the orphan the refusal left
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert got["ok"] and got["said"].startswith("discarded")
    assert intents(m, key) == []                                               # cleared with the discard
    assert m.c.handovers.lines_for(key)                                        # its other lines stay
    with open(m.c.handovers.journal, encoding="utf-8") as f:
        assert '{"press": {"id": "98203", "tok\n' in f.read()
    # nothing acts on it even with the discard record gone
    m.ledger.db.execute("DELETE FROM meta WHERE key=?", (migrate.TAP_DISCARDED + key,))
    row = next(r for r in m.c.handovers.journaled() if m.c.handovers.key(r["press"]) == key)
    assert not row["intent"]
    assert other["id"] not in [r["press"]["id"] for r in m.c.handovers.journaled()]


# -- 3. a start replay that can't read the set-aside taps backs off and says so ----------------------------------------

@pytest.mark.card_only
def test_a_replay_with_the_set_aside_list_down_for_hours_backs_off_and_settles_once_back(m, monkeypatch, clock,
                                                                                         tmp_path):
    h = m.c.handovers
    a, b, held = tap(98301), tap(98302), tap(98303)
    for p in (a, b, held):                                                     # acted on, no next read journaled
        assert h.journal_add(Handover(kind="press", press=p))
        assert h.journal_intent(p, {"effect": "calendar_change", "proposal": f"p-{p['id']}", "changes": [],
                                    "keys": []})
    ka, kheld = h.key(a), h.key(held)
    with open(h.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:   # a put off: due in two minutes
        json.dump({"taps": {ka: {"fails": 2, "due": m.c._clock() + 120}}}, f)
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + kheld, json.dumps({"flag": "{not json"}), db)
    monkeypatch.setattr(Controller, "_tap_read", lambda self, op: ("not_done", []))
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    real_q, real_body = Controller._quarantined, Controller._replay_body
    state = {"down": True, "reads": 0, "passes": 0}

    def quarantined(self):
        if self.__dict__.get("_in_replay"):
            state["reads"] += 1
        if state["down"]:
            raise sqlite3.OperationalError("unable to open database file")
        return real_q(self)

    def body(self):
        state["passes"] += 1
        return real_body(self)
    monkeypatch.setattr(Controller, "_quarantined", quarantined)
    monkeypatch.setattr(Controller, "_replay_body", body)
    before = m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    real_restart(m, tmp_path)
    for _ in range(4 * 60):                                                    # four hours down
        later(m, clock, 60)
    assert state["reads"] <= 4 * 60 // 15 + 3                                  # backed off to every 15 minutes
    assert "waiting" in m.c.handovers.health()                                 # said where no records are needed
    assert m.c.notes.get("tap_setaside")
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == before   # nothing for any of them
    state["down"], state["passes"] = False, 0                                  # the records answer again
    while state["passes"] == 0:
        later(m, clock, 60)
    assert {r["press"]["id"] for r in h.journaled()} == {"98303"}              # both settled in that one pass
    assert settled(m, a) and settled(m, b)
    assert queued(m, "A tap of yours") and not any("98303" in t for t in queued(m, ""))
    assert "waiting" not in m.c.handovers.health() and "tap_setaside" not in m.c.notes
    assert m.ledger.get_meta(Controller.QUARANTINE_FLAG + kheld) is not None  # the set-aside tap left alone


# -- 4. a tap read as done, its relist refused past the schedule and the kept verdicts' bound -------------------------

@pytest.mark.card_only
@pytest.mark.parametrize("hold", ["untaken", "ended", "settled"])
def test_a_done_tap_refused_past_the_schedule_and_the_verdict_bound_settles_as_done(m, monkeypatch, clock, hold):
    press = unknown_tap(m, f"9840{len(hold)}")
    key = m.c.handovers.key(press)
    reads = {"n": 0, "tick": 0, "most": 0}

    def read(self, op):
        reads["n"] += 1
        reads["tick"] += 1
        reads["most"] = max(reads["most"], reads["tick"])
        return ("done", [])                                                    # it's on the calendar
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: hold)
    monkeypatch.setattr(Controller, "_tap_read", read)
    with monkeypatch.context() as mp:
        relist_refused_for(mp, key)
        for i in range(8 * 60):                                                # eight hours of refusals
            reads["tick"] = 0
            later(m, clock, 60)
            if i % 30 == 0:                                                    # other taps' verdicts crowd it out
                for j in range(Controller.RELIST_VERDICTS_KEPT + 1):
                    m.c._keep_verdict(f"other{i}-{j}|x", ("not_done", [], {}))
        assert [r["press"]["id"] for r in m.c.handovers.journaled()] == [press["id"]]
    for _ in range(3):                                                         # the records take it
        reads["tick"] = 0
        later(m, clock, 3601)
    assert m.c.handovers.journaled() == []
    assert queued(m, "nothing is left to do")                                  # settled as already done
    assert reconfirms(m) == 0                                                  # no Go ahead
    assert not queued(m, "isn't known") and not queued(m, "nothing more is done")   # no terminal card
    assert reads["most"] <= 1                                                  # one calendar read per try at most
    assert reads["n"] <= 8 * 60 // 60 * 2 + 12                                 # on the back-off, not every tick
