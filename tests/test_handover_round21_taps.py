"""0.24.0, twenty-first round: the defects the twentieth outside review found in the twentieth round's additions.

1. An unverified tap's card and its strike are one ledger transaction, with a "card queued" mark checked before the
   card, and a failing strike is retried on a back-off: a strike that can't be written never repeats the card.
2. More than ten unverified taps all finish, at a start and in the running loop, one card each; one tap's failure
   never rolls back the others; every journal state has its words for the overflow list.
3. The hold schedule and the calendar's schedule have their own counters: after six hold reads, the calendar still
   gets its own six reads.
4. Only a database or I/O error leaves a tap's hold unread; a press whose id can't be read is a permanent outcome
   (one card, no Go ahead, struck); the waiting line is logged only when the state changes.
5. A part read definitely as not done, but not safe to offer again, has its own words; "may have been sent" is kept
   for ambiguous reads.
10. The unverified card is deduplicated by the tap in the outbox.
All names and ids invented.
"""
import logging
import sqlite3

import pytest

from harness.controller import Controller
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import ask, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round16_taps import DENTIST, dentist_card, dentists, m  # noqa: F401
from test_handover_round17_taps import card_labels, new_cards, new_said
from test_handover_round18_taps import later, real_restart
from test_handover_round19_taps import cut_after
from test_handover_round20_taps import FailingHoldReads, states, unverified_then_killed
from fake_caldav import no_network  # noqa: F401  (autouse)

HOW_FAR = "couldn't read your calendar to tell how far it got"


def how_far(m, before=0):
    return [t for t in new_said(m, before) if HOW_FAR in t]


def queued_how_far(m):
    return [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox").fetchall() if HOW_FAR in r[0]]


class StrikeFails:
    """The tap journal's rewrite (the strike) failing as a disk error, counted."""

    def __init__(self, m, monkeypatch):
        self.calls = 0
        self.on = True
        real = m.c.handovers._rewrite

        def rewrite(keep):
            self.calls += 1
            if self.on:
                raise OSError(28, "No space left on device")
            return real(keep)
        monkeypatch.setattr(m.c.handovers, "_rewrite", rewrite)


def unverified_rows(m, n, *, base=93000):
    """n taps recorded as unverified in the journal (their outcome written, their card and strike not done)."""
    op = {"effect": "calendar_change", "proposal": "p-none", "changes": [dict(DENTIST, op="add")], "keys": [],
          "bound": []}
    presses = []
    for i in range(n):
        press = {"id": str(base + i), "custom_id": f"k:a:none{i}", "token": "t", "app": "999",
                 "message_id": "1"}
        h = Handover(kind="press", press=press)
        assert m.c.handovers.journal_add(h)
        assert m.c.handovers.journal_intent(press, op)
        assert m.c.handovers.journal_outcome(press, "unverified")
        presses.append(press)
    return presses


# -- 1. the card and the strike, one transaction ----------------------------------------------------------------------

@pytest.mark.card_only
def test_a_strike_that_cant_be_written_never_repeats_the_card_and_is_retried_on_a_backoff(m, monkeypatch, clock):
    unverified_then_killed(m, monkeypatch, clock)
    fails = StrikeFails(m, monkeypatch)
    before = len(m.link.cards)
    for _ in range(200):                                                       # ten minutes of ticks
        later(m, clock, 3)
    assert states(m) == ["unverified"]                                         # kept
    assert how_far(m, before) == [] and queued_how_far(m) == []                # rolled back with the strike
    assert fails.calls <= 5                                                    # backed off, not every tick
    fails.on = False                                                           # the journal can be written again
    for _ in range(1300):                                                      # past the longest back-off
        later(m, clock, 3)
        if not m.c.handovers.journaled():
            break
    assert m.c.handovers.journaled() == []                                     # struck
    for _ in range(20):
        later(m, clock, 3)
    assert len(how_far(m, before)) == 1                                        # exactly one card, ever
    assert len(queued_how_far(m)) == 1


@pytest.mark.card_only
def test_the_card_queued_mark_is_checked_before_the_card(m, monkeypatch, clock):
    """The card committed with its mark, but the journal kept the tap (the strike's rename lost, as on a power cut):
    the next finish strikes it and queues nothing again."""
    unverified_then_killed(m, monkeypatch, clock)
    real = m.c.handovers._rewrite
    lost = {"n": 0}

    def rename_lost(keep):
        lost["n"] += 1                                                         # "succeeds", the file unchanged
    monkeypatch.setattr(m.c.handovers, "_rewrite", rename_lost)
    before = len(m.link.cards)
    later(m, clock, 3)
    assert lost["n"] == 1 and states(m) == ["unverified"] and len(queued_how_far(m)) == 1
    monkeypatch.setattr(m.c.handovers, "_rewrite", real)
    for _ in range(5):
        later(m, clock, 3)
    assert m.c.handovers.journaled() == []
    assert len(how_far(m, before)) == 1 and len(queued_how_far(m)) == 1


# -- 2. more than ten unverified taps ---------------------------------------------------------------------------------

@pytest.mark.card_only
def test_eleven_and_more_unverified_taps_all_finish_at_start(m, tmp_path, caplog):
    unverified_rows(m, 12)
    before = len(m.link.cards)
    with caplog.at_level(logging.ERROR):
        real_restart(m, tmp_path)
    assert m.c.handovers.journaled() == []
    assert len(how_far(m, before)) == 12                                       # one card each
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR and "harness.controller" in r.name]
    for _ in range(5):
        m.c.tick()
    m.c.outbox.flush()
    assert len(how_far(m, before)) == 12                                       # nothing said twice


@pytest.mark.card_only
def test_eleven_and_more_unverified_taps_all_finish_in_the_running_loop(m, clock, caplog):
    unverified_rows(m, 11)
    before = len(m.link.cards)
    with caplog.at_level(logging.ERROR):
        later(m, clock, 3)
    assert m.c.handovers.journaled() == []
    assert len(how_far(m, before)) == 11
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR and "harness.controller" in r.name]
    for _ in range(5):
        later(m, clock, 3)
    assert len(how_far(m, before)) == 11


@pytest.mark.card_only
def test_one_taps_failing_strike_never_rolls_back_the_others(m, monkeypatch, clock):
    presses = unverified_rows(m, 11)
    stuck = m.c.handovers.key(presses[4])
    real = m.c.handovers.journal_done

    def done(press, *, strict=False):
        if m.c.handovers.key(press) == stuck:
            raise OSError(5, "Input/output error")
        return real(press, strict=strict)
    monkeypatch.setattr(m.c.handovers, "journal_done", done)
    before = len(m.link.cards)
    later(m, clock, 3)
    left = m.c.handovers.journaled()
    assert [m.c.handovers.key(r["press"]) for r in left] == [stuck]            # only its own row stays
    assert len(how_far(m, before)) == 10
    monkeypatch.setattr(m.c.handovers, "journal_done", real)
    for _ in range(40):
        later(m, clock, 3)
    assert m.c.handovers.journaled() == [] and len(how_far(m, before)) == 11


def test_every_journal_state_has_words_for_the_overflow_list(m):
    for state in ("committed", "unknown", "not_started", "found", "unverified", "unidentified", "refused"):
        assert Controller.TAP_STATE_WORDS[state]
    rows = [{"press": {"id": str(94000 + i), "custom_id": f"k:a:o{i}"}, "at": 1794000000.0 + i, "state": "unverified",
             "op": {}} for i in range(12)]
    m.c.handovers.journal_done = lambda press, **kw: None
    m.c._relist_taps(rows, restored=False, verdicts={m.c.handovers.key(r["press"]): ("records_unread", [], {})
                                                     for r in rows})
    m.c.outbox.flush()
    assert any("Older taps" in t and "how far it got" in t for t in new_said(m, 0))


# -- 3. two counters ------------------------------------------------------------------------------------------------

@pytest.mark.card_only
def test_after_six_hold_reads_the_calendar_still_gets_its_own_six_reads(m, monkeypatch, clock):
    dentist_card(m)
    steps = []
    real_check = m.c.handovers.journal_check

    def check(press, n, next_at, told, kind="first", seen=""):
        steps.append((kind, n, round(next_at - m.c._clock()), bool(told)))     # every step, duplicates included
        return real_check(press, n, next_at, told, kind, seen)
    m.c.handovers.journal_check = check
    cut_after(m, monkeypatch)                                                  # the write lands with the tap
    real_db = m.ledger.db
    monkeypatch.setattr(m.ledger, "db", FailingHoldReads(real_db))
    for wait in (61, 121, 301, 901, 1801, 3601):                               # six hold-unread reads
        later(m, clock, wait)
    monkeypatch.setattr(m.ledger, "db", real_db)                               # the records read again
    m.gmail.down = True                                                        # but the calendar fails
    reads = []
    real_read = m.c._tap_read
    monkeypatch.setattr(m.c, "_tap_read", lambda op: reads.append(1) or real_read(op))
    later(m, clock, 3601)
    assert states(m) == ["unknown"]                                            # still live, not written off
    for wait in (121, 301, 901, 1801):
        later(m, clock, wait)
        assert states(m) == ["unknown"]
    later(m, clock, 3601)                                                      # the calendar's sixth read
    assert len(reads) == 6
    assert m.c.handovers.journaled() == []
    assert steps == [
        ("first", 1, 60, False),
        ("hold", 2, 120, False), ("hold", 2, 120, True),                       # its note queued, then marked told
        ("hold", 3, 300, True), ("hold", 4, 900, True), ("hold", 5, 1800, True), ("hold", 6, 3600, True),
        ("hold", 7, 3600, True),
        ("calendar", 2, 120, True), ("calendar", 3, 300, True), ("calendar", 4, 900, True),
        ("calendar", 5, 1800, True), ("calendar", 6, 3600, True),
    ]
    assert len(how_far(m)) == 1


def test_the_journal_keeps_the_two_counters_apart(m):
    press = {"id": "95000", "custom_id": "k:a:two"}
    assert m.c.handovers.journal_add(Handover(kind="press", press=press))
    assert m.c.handovers.journal_intent(press, {})
    h = m.c.handovers
    h.journal_check(press, 1, 1.0, False)                                      # the first read: both
    h.journal_check(press, 4, 2.0, False, "hold", "hold_unread")
    (row,) = h.journaled()
    assert (row["checks"], row["hold_checks"], row["last_kind"], row["last_seen"]) == (1, 4, "hold", "hold_unread")
    h.journal_check(press, 3, 3.0, True, "calendar", "unread")
    (row,) = h.journaled()
    assert (row["checks"], row["hold_checks"], row["last_kind"], row["told_check"]) == (3, 4, "calendar", True)


# -- 4. only database and I/O errors leave the hold unread ------------------------------------------------------------

class Raising:
    def __init__(self, real, exc):
        self.real, self.exc = real, exc

    def execute(self, sql, *a, **kw):
        if "consumed_update_id" in sql:
            raise self.exc
        return self.real.execute(sql, *a, **kw)

    def __getattr__(self, name):
        return getattr(self.real, name)


@pytest.mark.parametrize("exc", [sqlite3.OperationalError("database is locked"), sqlite3.DatabaseError("malformed"),
                                 OSError(5, "Input/output error")], ids=["operational", "database", "os"])
def test_a_database_or_io_error_leaves_the_hold_unread(m, monkeypatch, exc):
    monkeypatch.setattr(m.ledger, "db", Raising(m.ledger.db, exc))
    assert m.c._records_hold({"id": "987654", "custom_id": "k:x"}) == "hold_unread"


@pytest.mark.parametrize("pid", ["not-a-tap", "", "-4", None], ids=["words", "empty", "negative", "none"])
def test_a_press_id_that_cant_be_read_is_unidentified(m, pid):
    assert m.c._records_hold({"id": pid, "custom_id": "k:x"}) == "unidentified"


@pytest.mark.card_only
def test_an_unidentified_tap_gets_one_card_with_no_go_ahead_and_is_struck(m, clock):
    press = {"id": "not-a-tap", "custom_id": "k:a:who", "token": "t", "app": "999", "message_id": "1"}
    h = m.c.handovers
    assert h.journal_add(Handover(kind="press", press=press))
    assert h.journal_intent(press, {"effect": "calendar_change", "proposal": "p-x", "changes": [], "keys": []})
    assert h.journal_check(press, 1, m.c._clock() + 60, False)
    before = len(m.link.cards)
    for _ in range(4):
        later(m, clock, 61)
    for _ in range(4):
        later(m, clock, 3601)                                                  # never read again hourly
    said = new_said(m, before)
    assert len([t for t in said if "couldn't identify this tap" in t]) == 1
    assert "Go ahead" not in card_labels(new_cards(m, before))
    assert h.journaled() == []
    assert not any("tap" in t and ("again" in t.split("couldn't identify")[-1] and "send" in t) for t in said)


@pytest.mark.card_only
def test_the_hourly_waiting_line_is_logged_only_when_the_state_changes(m, monkeypatch, clock, caplog):
    dentist_card(m)
    cut_after(m, monkeypatch)
    monkeypatch.setattr(m.ledger, "db", FailingHoldReads(m.ledger.db))
    with caplog.at_level(logging.WARNING, logger="harness.controller"):
        for wait in (61, 121, 301, 901, 1801, 3601, 3601, 3601, 3601):
            later(m, clock, wait)
    waits = [r for r in caplog.records if r.getMessage().startswith("a tap waits")]
    assert len(waits) == 1                                                     # one state, said once
    assert not [r for r in caplog.records if "read again in an hour" in r.getMessage()]


# -- 5. checked: not done ---------------------------------------------------------------------------------------------

def failed_text(why=None):
    extra = {"names": ["Dinner", "Swim", "Lunch", "PT"], "got": ["absent", "unchecked", "unread", "not_done"],
             "retry": [], "ask": [0, 1, 2, 3]}
    if why is not None:
        extra["why"] = why
    return Controller._relist_words("unknown", "failed_ask", [], restored=False, extra=extra)


@pytest.mark.parametrize("why", [None, {0: "maybe_sent", 1: "no_identity", 2: "unread", 3: "checked_not_done"}],
                         ids=["by-read", "recorded"])
def test_each_kind_of_part_not_offered_again_has_its_own_words(why):
    text = failed_text(why)

    def part(name):
        return text[text.index(f"For {name}"):].split(". ")[0]
    assert "may have reached your calendar" in part("Dinner")                  # ambiguous: absent at its fixed id
    assert "leaves nothing Harness can read" in part("Swim")
    assert "couldn't be read just now" in part("Lunch")
    pt = text[text.index("For PT"):]
    assert pt.startswith("For PT, checked: not done; it can't be offered again automatically, so ask for it again "
                         "if you still want it.")
    assert "may have reached" not in pt
    assert text.count("may have reached your calendar") == 1


def test_the_ended_verdict_sorts_a_part_read_as_not_done_as_checked(m, monkeypatch):
    op = {"effect": "calendar_change", "proposal": "p-nd", "keys": [], "bound": [],
          "changes": [dict(DENTIST, op="add"), dict(DENTIST, op="add", title="Swim")]}
    monkeypatch.setattr(m.cc, "retry_safe", lambda op_, got: [])
    seen, extra = m.c._ended_verdict(op, "mixed", [("Dentist", "not_done"), ("Swim", "absent")])
    assert seen == "failed_ask"
    assert extra["why"] == {0: "checked_not_done", 1: "maybe_sent"}


# -- 10. the outbox deduplicates by the tap ---------------------------------------------------------------------------

def test_the_outbox_queues_a_card_once_per_tap(m):
    with m.ledger.tx() as db:
        a = m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="first", once="tap:95100|k:a:x")
    with m.ledger.tx() as db:
        b = m.ledger.enqueue(chat_id=1, kind="notice", db=db, text="again", once="tap:95100|k:a:x")
    assert a == b
    assert [r[0] for r in m.ledger.db.execute("SELECT text FROM outbox WHERE text IN ('first','again')")] == ["first"]


@pytest.mark.card_only
def test_an_unverified_card_queued_before_a_kill_is_never_sent_twice(m, monkeypatch, clock, tmp_path):
    """Its card committed, then the process died before the tap's journal lost it, and the "card queued" mark
    isn't there to stop a second card (as on an older run): the outbox's own key does."""
    unverified_then_killed(m, monkeypatch, clock)
    with monkeypatch.context() as mp:
        mp.setattr(m.c.handovers, "_rewrite", lambda keep: None)               # the strike didn't reach the disk
        later(m, clock, 3)
    (row,) = m.c.handovers.journaled()
    key = m.c.handovers.key(row["press"])
    with m.ledger.tx() as db:
        db.execute("DELETE FROM meta WHERE key=?", (f"tap_card_queued:{key}",))
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    later(m, clock, 3)
    assert m.c.handovers.journaled() == []
    assert how_far(m, before) == [] and len(queued_how_far(m)) == 1
