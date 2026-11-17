"""0.24.0, twenty-sixth round: the defects the twenty-fifth outside review found in the twenty-fifth round's additions.

1. A start replay put off by more than one tap re-arms itself for the earliest tap still put off, so a tap carried in
   from the file beside the journal and one deferred during the replay are each replayed once, with no restart.
2. A relist the records keep refusing reads the calendar once, past the schedule's top step.
3. A discarded tap's journal lines are never rewritten, across ticks and a restart.
4. A relist generation count that can't be read is never started again at one.
8. A batch relist's per-tap fallback queues one batch summary.
9. A requeued tap that was started is read on the calendar, never taken again.
All names and ids invented.
"""
import json
import sqlite3

import pytest

from harness import migrate
from harness.controller import Controller
from harness.handover import Handover, Inbox
from harness.ledger import Ledger, TransactionAborted
from test_discord_keeper import OWNER, TOKEN  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import dentist_card, dentists, m, tap_journaled  # noqa: F401
from test_handover_round18_taps import later, real_restart
from test_handover_round23_taps import queued, unknown_tap
from test_handover_round25_taps import per_tap, relist_refused_for, set_aside_unknown, settled, touched
from test_outbox_round24 import relisted
from fake_caldav import no_network  # noqa: F401  (autouse)


# -- 1. a start replay put off by two taps on different back-offs -------------------------------------------------------

def refused_tap(m, tap_id):
    press = {"id": tap_id, "custom_id": f"k:a:r26{tap_id}", "token": "t", "app": "999", "message_id": "5"}
    assert m.c.handovers.journal_add(Handover(kind="press", press=press))
    assert m.c.handovers.journal_outcome(press, "refused", note=f"Not taken {tap_id}.")
    return press, f"Not taken {tap_id}."


@pytest.mark.card_only
def test_two_taps_put_off_on_different_backoffs_are_each_replayed_once_without_a_restart(m, monkeypatch, clock,
                                                                                           tmp_path):
    h = m.c.handovers
    (a, note_a), (b, note_b) = refused_tap(m, "96101"), refused_tap(m, "96102")
    # a carried in from the file beside the journal: due in five minutes, its third failure
    with open(h.journal + Controller.REREAD_SIDE, "w", encoding="utf-8") as f:
        json.dump({"taps": {h.key(a): {"fails": 3, "due": m.c._clock() + 300}}}, f)
    monkeypatch.setattr(Inbox, "notify", lambda self, hv, text: False)       # posted as a message
    real = Controller._post_pending_notice
    calls = {"a": 0, "b": 0}

    def post(self, row):
        which = "a" if row["press"]["id"] == "96101" else "b"
        calls[which] += 1
        if which == "b" and calls["b"] == 1:                                   # b put off for a minute
            raise TransactionAborted("the records' transaction was aborted")
        return real(self, row)
    monkeypatch.setattr(Controller, "_post_pending_notice", post)
    real_restart(m, tmp_path)
    assert queued(m, note_a) == [] and queued(m, note_b) == []
    for _ in range(12 * 20):                                                   # twelve minutes of ticks, no restart
        later(m, clock, 3)
    assert len(queued(m, note_a)) == 1 and len(queued(m, note_b)) == 1        # each once, none repeated
    assert calls == {"a": 1, "b": 2}                                           # nothing taken twice
    assert m.c.handovers.journaled() == []
    assert m.c.__dict__.get("_replay_again_at") is None and m.c.__dict__.get("_replay_fails", 0) == 0


# -- 2. the kept verdict lasts as long as the deferral -----------------------------------------------------------------

@pytest.mark.card_only
def test_a_relist_refused_past_the_sixth_time_still_reads_the_calendar_once(m, monkeypatch, clock):
    a, b = unknown_tap(m, "96201"), unknown_tap(m, "96202")
    reads, _ = per_tap(monkeypatch)
    with monkeypatch.context() as mp:
        relist_refused_for(mp, m.c.handovers.key(a))
        later(m, clock, 61)
        assert settled(m, b)
        for _ in range(12):                                                    # twelve hourly retries
            later(m, clock, 3601)
        assert m.c.__dict__["_reread_mem"][m.c.handovers.key(a)]["fails"] > len(Controller.STRIKE_BACKOFF_S)
        assert reads["96201"] == 1                                             # the calendar read once in all
    later(m, clock, 3601)                                                      # the records write again
    assert settled(m, a) and reads["96201"] == 1
    assert m.c.handovers.key(a) not in m.c.__dict__.get("_relist_verdicts", {})


def test_the_kept_verdicts_are_bounded_by_count(m):
    cache = m.c.__dict__.setdefault("_relist_verdicts", {})
    for i in range(Controller.RELIST_VERDICTS_KEPT + 10):
        m.c._keep_verdict(f"{i}|x", ("untaken", [], {}))
    assert len(cache) == Controller.RELIST_VERDICTS_KEPT and "0|x" not in cache


# -- 3. a discarded tap's journal lines are never rewritten -------------------------------------------------------------

def rewrites_for(monkeypatch, tap_id):
    """Each journal rewrite that drops a line of that tap, counted."""
    n = {"rewrites": 0}
    real = Inbox._rewrite

    def rewrite(self, keep):
        before = self._journal_lines()
        if sum(1 for r in before if tap_id in json.dumps(r)) != sum(1 for r in keep if tap_id in json.dumps(r)):
            n["rewrites"] += 1
        return real(self, keep)
    monkeypatch.setattr(Inbox, "_rewrite", rewrite)
    return n


@pytest.mark.card_only
def test_a_discarded_taps_journal_is_never_rewritten_across_ticks_and_a_restart(m, monkeypatch, clock, tmp_path):
    press, key = set_aside_unknown(m, clock, "96301")
    with m.ledger.tx() as db:                                                  # a relist mark left pending for it
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps(
            {"press": dict(press), "gen": 2, "pending": True, "fails": 0, "due": 0.0}), db)
    got = migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)
    assert got["ok"]
    for prefix in (Controller.RELIST_FLAG, Controller.STRIKE_FLAG, Controller.REREAD_FLAG, Controller.QUARANTINE_FLAG):
        assert m.ledger.get_meta(prefix + key) is None                         # all its state goes with the discard
    lines = m.c.handovers.lines_for(key)
    n = rewrites_for(monkeypatch, "96301")
    for _ in range(10):
        later(m, clock, 61)
    real_restart(m, tmp_path)
    for _ in range(10):
        later(m, clock, 3601)
    assert n["rewrites"] == 0 and m.c.handovers.lines_for(key) == lines


@pytest.mark.card_only
def test_the_strike_resume_skips_a_discarded_tap_even_with_its_mark_still_there(m, monkeypatch, clock):
    press, key = set_aside_unknown(m, clock, "96302")
    assert migrate.set_aside_taps(m.ledger.path, key, "discard", journal=m.c.handovers.journal)["ok"]
    with m.ledger.tx() as db:                                                  # marks written by an older build
        m.ledger.set_meta(Controller.RELIST_FLAG + key, json.dumps(
            {"press": dict(press), "gen": 2, "pending": True, "fails": 0, "due": 0.0}), db)
        m.ledger.set_meta(Controller.STRIKE_FLAG + key, json.dumps(
            {"press": dict(press), "fails": 0, "due": 0.0, "state": "unverified"}), db)
    n = rewrites_for(monkeypatch, "96302")
    for _ in range(5):
        later(m, clock, 61)
    assert n["rewrites"] == 0


# -- 4. a relist count that can't be read is never started again at one ------------------------------------------------

def marks_unreadable(mp):
    real = Controller._flags

    def flags_(self, prefix, *more):
        if prefix == Controller.RELIST_FLAG:
            raise sqlite3.DatabaseError("database disk image is malformed")
        return real(self, prefix, *more)
    mp.setattr(Controller, "_flags", flags_)


def reconfirms(m):
    return m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='tap_reconfirm'").fetchone()[0]


def test_with_the_marks_unreadable_the_count_beside_the_journal_reaches_the_cap(m, monkeypatch):
    press = {"id": "96401", "custom_id": "k:a:r26gen", "token": "t", "app": "999", "message_id": "5"}
    relisted(m, press)                                                         # its first, counted beside too
    marks_unreadable(monkeypatch)
    for _ in range(Controller.RELIST_GEN_CAP + 3):                             # more than six relists unreadable
        relisted(m, press)
    assert reconfirms(m) == Controller.RELIST_GEN_CAP                          # one Go ahead per generation, no more
    assert len(queued(m, Controller.RELIST_ENDED_WORDS)) == 1


def test_with_the_marks_and_the_file_beside_unreadable_the_tap_ends_at_once(m, monkeypatch):
    press = {"id": "96402", "custom_id": "k:a:r26gen2", "token": "t", "app": "999", "message_id": "5"}
    relisted(m, press)                                                         # its first generation
    marks_unreadable(monkeypatch)
    monkeypatch.setattr(Controller, "_side_load", lambda self: {})
    for _ in range(Controller.RELIST_GEN_CAP + 3):
        relisted(m, press)
    assert reconfirms(m) == 1                                                  # never counted from one again
    # twenty-seventh round: its end says it couldn't be retried safely, not that it was brought back before
    assert len(queued(m, Controller.UNKNOWN_COUNT_WORDS)) == 1


# -- 8. the per-tap fallback queues one batch summary -------------------------------------------------------------------

SUMMARY = "<b>Harness stopped or hit an error before it noted what came of"


def summaries(m):
    return [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox").fetchall() if SUMMARY in r[0]]


@pytest.mark.card_only
def test_a_three_tap_refusal_queues_one_summary_for_the_taps_it_settled(m, monkeypatch, clock):
    a, b, c = unknown_tap(m, "96801"), unknown_tap(m, "96802"), unknown_tap(m, "96803")
    per_tap(monkeypatch)
    with monkeypatch.context() as mp:
        relist_refused_for(mp, m.c.handovers.key(a))
        later(m, clock, 61)
        assert settled(m, b) and settled(m, c)
        got = summaries(m)
        assert len(got) == 1 and "2 taps of yours" in got[0]                   # one for b and c, not one each
        assert len(queued(m, "the error came before it was taken")) == 2       # each its own card
        for _ in range(20):
            later(m, clock, 3)
        assert len(summaries(m)) == 1
    for _ in range(3):
        later(m, clock, 3601)
    assert settled(m, a)
    assert len(summaries(m)) == 2                                              # a's own, once it settles
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 5


# -- 9. a requeued tap that was started is read first, never taken again -----------------------------------------------

def set_aside_with_torn_intent(m, tap_id):
    """A tap whose intent line was torn (it can't be read, so the journal alone reads it as never acted on), set
    aside. Its action had already reached the calendar."""
    h = m.c.handovers
    press = {"id": tap_id, "custom_id": f"k:a:r26{tap_id}", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=press))
    key = h.key(press)
    with open(h.journal, "a", encoding="utf-8") as f:
        f.write('{"intent": "' + key + '", "op": {"effect": "calendar_ch\n')
    assert [r["state"] for r in h.journaled()] == ["not_started"]
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    return press, key


@pytest.mark.card_only
def test_a_requeued_tap_whose_action_already_reached_the_calendar_is_never_taken_again(m, monkeypatch, clock,
                                                                                         tmp_path):
    press, key = set_aside_with_torn_intent(m, "96901")
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=m.c.handovers.journal)
    assert got["ok"] and "never takes it by itself" in got["said"]
    n = touched(monkeypatch, "96901")
    monkeypatch.setattr(Controller, "_records_hold", lambda self, p: "untaken")
    monkeypatch.setattr(Controller, "_tap_read", lambda self, op: ("done", []))   # it's on the calendar
    real_restart(m, tmp_path)
    for _ in range(5):
        later(m, clock, 61)
    assert n["taken"] == 0                                                     # never a second write
    assert m.c.handovers.journaled() == []                                     # settled with its card
    found = m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text LIKE '%nothing is left to do%'").fetchone()[0]
    reconfirm = m.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='tap_reconfirm'").fetchone()[0]
    assert found + reconfirm >= 1                                              # "already done", or a Go ahead


@pytest.mark.card_only
def test_a_requeue_routes_on_the_journal_alone(m, clock, tmp_path):
    h = m.c.handovers
    plain = {"id": "96911", "custom_id": "k:a:r26plain", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=plain))                  # a press and nothing else
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + h.key(plain), json.dumps({"flag": "{not json"}), db)
    got = migrate.set_aside_taps(m.ledger.path, h.key(plain), "requeue", journal=h.journal)
    assert got["ok"] and "never acted on" in got["said"]
    started = {"id": "96912", "custom_id": "k:a:r26start", "token": "t", "app": "999", "message_id": "5"}
    assert h.journal_add(Handover(kind="press", press=started))
    assert h.journal_delivered(started)                                        # a line beyond its press: started
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + h.key(started), json.dumps({"flag": "{not json"}), db)
    got = migrate.set_aside_taps(m.ledger.path, h.key(started), "requeue", journal=h.journal)
    assert got["ok"] and "never takes it by itself" in got["said"]
    assert next(r for r in h.journaled() if r["press"]["id"] == "96912")["state"] == "unknown"


def test_a_requeue_with_a_journal_it_cant_read_is_refused(m, tmp_path):
    h = m.c.handovers
    key = "96921|k:a:r26odd"
    with m.ledger.tx() as db:
        m.ledger.set_meta(Controller.QUARANTINE_FLAG + key, json.dumps({"flag": "{not json"}), db)
    folder = tmp_path / "a-folder"
    folder.mkdir()
    got = migrate.set_aside_taps(m.ledger.path, key, "requeue", journal=str(folder))
    assert not got["ok"] and m.ledger.get_meta(Controller.QUARANTINE_FLAG + key) is not None
