"""0.24.0, twentieth round: the defects the nineteenth outside review found in the nineteenth round's additions.

1. Any error on the records' hold read keeps the tap (read again on the schedule and at start); it's struck only on
   a positive terminal read. The real hold reader, against a ledger in each job state, and an injected sqlite error.
2. A tap left recorded as "unverified" (its outcome written, its strike not done) is terminal: the replay and the
   in-process re-read finish its strike and say again that the calendar couldn't be read; never "stopped before it
   took the tap".
4. A retry card's preview is read at the first offer's fixed ids, set with its proposal.
6. The "told once" mark for a waiting tap is written only once its note is queued.
7. Parts not offered again are told apart: unreadable, no identity, possibly sent; none has Go ahead. A step found in
   its very version gets no Go ahead.
9. A Go ahead whose read still fails never asks him to send anything again: a new card reads again when used.
All names and ids invented.
"""
import json
import sqlite3

import pytest

from harness.controller import Controller
from harness.ledger import TERMINAL
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import DENTIST, dentist_card, dentists, m, press_for, tap_journaled  # noqa: F401
from test_handover_round17_taps import card_labels, new_cards, new_said
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from fake_caldav import no_network  # noqa: F401  (autouse)


class Killed(BaseException):
    """The process dying at that point."""


class FailingHoldReads:
    """The ledger's connection, with every read of an approval's or choice's use failing as a database error."""

    def __init__(self, real):
        self.real = real

    def execute(self, sql, *a, **kw):
        if "consumed_update_id" in sql:
            raise sqlite3.OperationalError("database disk image is malformed")
        return self.real.execute(sql, *a, **kw)

    def __getattr__(self, name):
        return getattr(self.real, name)


def states(m):
    return [r["state"] for r in m.c.handovers.journaled()]


# -- 1. the real hold reader, in each job state ---------------------------------------------------------------------

@pytest.mark.card_only
@pytest.mark.parametrize("job_state", ["approved", "executed", "failed"])
def test_the_real_hold_reader_reads_each_job_state(m, monkeypatch, job_state):
    dentist_card(m)
    press = cut_after(m, monkeypatch, run=False)                              # its approval used up, not run
    jid = m.ledger.db.execute("SELECT j.id FROM approvals a JOIN proposals p ON p.id=a.proposal_id JOIN jobs j"
                              " ON j.id=p.job_id WHERE a.consumed_update_id IS NOT NULL").fetchone()[0]
    with m.ledger.tx() as db:
        db.execute("UPDATE jobs SET state=? WHERE id=?", (job_state, jid))
    assert m.c._records_hold(press) == ("ended" if job_state in TERMINAL else "settling")


def test_the_real_hold_reader_says_untaken_for_a_tap_the_records_never_used(m):
    assert m.c._records_hold({"id": "987654", "custom_id": "k:x"}) == "untaken"


@pytest.mark.card_only
def test_a_database_error_on_the_hold_read_keeps_the_tap_and_it_settles_once_a_read_answers(m, monkeypatch, clock):
    dentist_card(m)
    cut_after(m, monkeypatch)                                                  # the write lands with the tap
    real_db = m.ledger.db
    monkeypatch.setattr(m.ledger, "db", FailingHoldReads(real_db))
    before = len(m.link.cards)
    for wait in (61, 121, 301, 901, 1801, 3601, 3601):                         # the schedule, then a cap read
        later(m, clock, wait)
        assert states(m) == ["unknown"]                                         # never struck on an error
    said = new_said(m, before)
    assert len([t for t in said if "records couldn't be read just now" in t]) == 1
    assert not any("Harness's records took it" in t or "already on your calendar" in t for t in said)
    monkeypatch.setattr(m.ledger, "db", real_db)                               # the records read again
    later(m, clock, 3601)
    assert m.c.handovers.journaled() == []                                     # struck on a positive read
    assert any("already on your calendar" in t for t in new_said(m, before))
    assert len(dentists(m)) == 1


@pytest.mark.card_only
def test_a_database_error_on_the_hold_read_at_start_keeps_the_tap(m, monkeypatch, tmp_path):
    dentist_card(m)
    cut_after(m, monkeypatch)
    monkeypatch.setattr(m.ledger, "db", FailingHoldReads(m.ledger.db))
    real_restart(m, tmp_path)
    assert states(m) == ["unknown"]


# -- 2. a tap left recorded as unverified ---------------------------------------------------------------------------

def unverified_then_killed(m, monkeypatch, clock):
    """The schedule runs out with the calendar unreadable: the outcome "unverified" is written, then the process
    dies before the card and the strike."""
    dentist_card(m)
    cut_after(m, monkeypatch)
    m.gmail.down = True
    for wait in (61, 121, 301, 901, 1801):
        later(m, clock, wait)

    def die(*a, **kw):
        raise Killed()
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_finish_terminal", die)            # twenty-first round: the per-tap finish
        with pytest.raises(Killed):
            later(m, clock, 3601)
    assert states(m) == ["unverified"]


@pytest.mark.card_only
def test_a_kill_between_the_unverified_outcome_and_the_strike_is_finished_by_the_real_replay(m, monkeypatch, clock,
                                                                                             tmp_path):
    unverified_then_killed(m, monkeypatch, clock)
    clock.t = clock.t.replace(year=clock.t.year + 1)                           # long past the replay window
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    said = new_said(m, before)
    assert any("couldn't read your calendar to tell how far it got" in t for t in said)
    assert not any("stopped before it took" in t for t in said)                # never "nothing changed"
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert m.c.handovers.journaled() == []


@pytest.mark.card_only
def test_an_unverified_tap_is_finished_by_the_in_process_reread(m, monkeypatch, clock):
    unverified_then_killed(m, monkeypatch, clock)
    before = len(m.link.cards)
    later(m, clock, 5)                                                         # the next tick, same process
    said = new_said(m, before)
    assert any("couldn't read your calendar to tell how far it got" in t for t in said)
    assert m.c.handovers.journaled() == []
    later(m, clock, 5)                                                         # struck: nothing said twice
    assert len([t for t in new_said(m, before) if "how far it got" in t]) == 1


# -- 4. a retry card's preview is read at the first offer's fixed ids -------------------------------------------------

@pytest.mark.card_only
def test_a_retry_cards_preview_reads_the_first_offers_fixed_id(m, monkeypatch, clock):
    dentist_card(m)
    op = m.c._tap_op(press_for(m, "Approve"))
    fixed = m.cc._uid(f"{op['proposal']}:0", "cm")
    m.gmail.answer = "denied"
    cut_after(m, monkeypatch)
    m.gmail.answer = "ok"
    later(m, clock, 61)
    real_safe = m.cc.retry_safe

    def safe_then_landed(op_, got):
        out = real_safe(op_, got)                                              # read absent: offered again
        m.gmail.events[fixed] = {"id": fixed, "summary": "Dentist", "status": "confirmed", "etag": '"x"',
                                 "start": {"dateTime": DENTIST["start"]},
                                 "end": {"dateTime": DENTIST["end"]}}          # then it shows at the fixed id
        return out
    monkeypatch.setattr(m.cc, "retry_safe", safe_then_landed)
    monkeypatch.setattr(m.cc, "_already_there", lambda *a, **kw: (None, None))   # found only by its id
    monkeypatch.setattr(m.cc, "_recent_own_adds", lambda *a, **kw: [])
    before = len(m.link.cards)
    assert m.tap("Go ahead")["status"] == "ok"
    m.c.outbox.flush()
    pid = m.ledger.db.execute("SELECT id FROM proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()[0]
    assert m.cc.keys_of(pid) == [f"{op['proposal']}:0"]                        # set with its proposal
    lines = json.loads(m.ledger.get_meta(f"calendar_change_lines:{pid}") or "[]")
    shown = " ".join(lines) + " ".join(c["text"] for c in new_cards(m, before))
    assert "already" in shown.lower(), shown                                   # what the fixed id holds now


# -- 6. the told mark only once the note is queued ------------------------------------------------------------------

@pytest.mark.card_only
def test_a_waiting_note_that_couldnt_be_queued_is_said_at_the_next_read(m, monkeypatch, clock):
    dentist_card(m)
    cut_after(m, monkeypatch)
    m.gmail.down = True
    real_tell = m.c._tell_waits

    def fail(*a, **kw):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(m.c, "_tell_waits", fail)
    before = len(m.link.cards)
    later(m, clock, 61)
    assert states(m) == ["unknown"] and m.c.handovers.journaled()[0]["told_check"] is False
    assert not any("can't tell yet" in t for t in new_said(m, before))
    monkeypatch.setattr(m.c, "_tell_waits", real_tell)
    later(m, clock, 121)
    assert len([t for t in new_said(m, before) if "can't tell yet" in t]) == 1
    assert m.c.handovers.journaled()[0]["told_check"] is True
    later(m, clock, 301)
    assert len([t for t in new_said(m, before) if "can't tell yet" in t]) == 1  # told once


@pytest.mark.card_only
def test_a_waiting_note_that_couldnt_be_queued_is_said_after_a_restart(m, monkeypatch, clock, tmp_path):
    dentist_card(m)
    cut_after(m, monkeypatch)
    m.gmail.down = True
    with monkeypatch.context() as mp:
        mp.setattr(m.c, "_tell_waits", lambda *a, **kw: (_ for _ in ()).throw(sqlite3.OperationalError("full")))
        later(m, clock, 61)
    assert m.c.handovers.journaled()[0]["told_check"] is False
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    assert len([t for t in new_said(m, before) if "can't tell yet" in t]) == 1


# -- 7. parts not offered again, told apart -------------------------------------------------------------------------

def test_unreadable_no_identity_and_possibly_sent_parts_each_have_their_own_words():
    extra = {"names": ["Dinner", "Swim", "Lunch", "PT"], "got": ["absent", "unchecked", "unread", "not_done"],
             "retry": [3], "ask": [0, 1, 2], "why": {0: "maybe_sent", 1: "no_identity", 2: "unread"}}
    text = Controller._relist_words("unknown", "failed_retry", [], restored=False, extra=extra)
    sent = text[text.index("For Dinner"):]
    assert sent.split(". ")[0].count("may have reached your calendar") == 1
    swim = text[text.index("For Swim"):].split(". ")[0]
    assert "leaves nothing Harness can read" in swim and "made and" not in swim
    lunch = text[text.index("For Lunch"):].split(". ")[0]
    assert "couldn't be read just now" in lunch and "made and" not in lunch
    assert "ask Harness" not in text and "send" not in text


@pytest.mark.card_only
def test_the_ended_verdict_sorts_each_part_by_why(m, monkeypatch):
    op = {"effect": "calendar_change", "proposal": "p-sort", "keys": [], "bound": [],
          "changes": [dict(DENTIST, op="add"), dict(DENTIST, op="remove", calendar="family", title="Swim")]}
    monkeypatch.setattr(m.cc, "_plan_of", lambda pid: {"parts": [{"steps": [{"spec": {"key": "p-sort:0"},
                                                                             "status": "unconfirmed"}]}]})
    seen, extra = m.c._ended_verdict(op, "mixed", [("Dentist", "absent"), ("Swim", "unchecked")])
    assert seen == "failed_ask" and seen in Controller.NO_GO_AHEAD
    assert extra["why"] == {0: "maybe_sent", 1: "no_identity"}


def test_a_step_found_in_its_very_version_gets_no_go_ahead(m, monkeypatch):
    """Guard (passes on the old code by design): the settle keeps a found step's entry, so absent after it reads
    as ambiguous and isn't offered again; the docs now say so."""
    op = {"effect": "calendar_change", "proposal": "p-found", "keys": [], "bound": [], "changes": [dict(DENTIST,
                                                                                                         op="add")]}
    plan = {"parts": [{"steps": [{"spec": {"key": "p-found:0"}, "status": "found", "entry": {"id": "e1"}}]}]}
    monkeypatch.setattr(m.cc, "_plan_of", lambda pid: plan)
    assert m.cc.retry_safe(op, ["absent"]) == []


# -- 9. a Go ahead whose read still fails never asks him to send it again -----------------------------------------

@pytest.mark.card_only
def test_an_untaken_go_ahead_whose_read_fails_offers_a_new_card_and_never_asks_to_resend(m, monkeypatch, tmp_path):
    dentist_card(m)

    def handle(inc):
        raise RuntimeError("cut off before the approval")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        tap_journaled(m, "Approve")
    m.gmail.down = True
    real_restart(m, tmp_path)
    before = len(m.link.cards)
    assert m.tap("Go ahead")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    said = new_said(m, 0)
    assert any("still couldn't be read, so nothing was done" in t for t in said)
    assert not any("Ask Harness for it again" in t or "send it again" in t for t in said)
    cards = new_cards(m, before)
    assert "Go ahead" in card_labels(cards)                                   # the same Go ahead, on a new card
    assert not any(e[0] == "insert" for e in m.gmail.log)
    m.gmail.down = False                                                       # the calendar reads again
    assert m.tap("Go ahead")["status"] == "ok"
    m.c.outbox.flush()
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    if "Approve" in card_labels(new_cards(m, before)):
        assert m.tap("Approve")["status"] == "ok"
        for _ in range(3):
            m.c.tick()
    assert len(dentists(m)) == 1
