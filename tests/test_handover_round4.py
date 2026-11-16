"""0.24.0, fourth round: what the third outside review of the handover fixes asked for (Nov 16).

Each must-fix on its own, against the fake calendars and a fake Discord: writes fenced under the
lease, the ledger migration keyed to its own schema version, never silent on a duplicate, the
no-card paths behind a flag Cain turns on after the smoke test, not confirmed read again in the
background, supersede matching that asks when it can't tell, the fast path's re-check, and
relative days left open. All names and ids invented.
"""
import json
import logging
import threading
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import approvals, calendar_change
from harness.handover import Handover
from harness.provenance import detail_line, open_day, resolution
from test_discord_keeper import OWNER
from test_plain_commands import (GMAIL, NY, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round2 import card_with, press
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


DENTIST = change("gmail", "add", "Dentist", dates="", start=at(15).isoformat(), end=at(16).isoformat())


def rows(m):
    return m.ledger.db.execute("SELECT * FROM calendar_changes ORDER BY rowid").fetchall()


def dentists(m):
    return [e for e in m.gmail.events.values() if e.get("summary") == "Dentist" and e.get("status") != "cancelled"]


def hang_first_insert(m, monkeypatch):
    """The first Gmail add hangs until released, then lands; later adds go through at once."""
    real = m.gmail.insert
    gate = threading.Event()
    calls = []

    def insert(address, event):
        calls.append(event["id"])
        if len(calls) == 1:
            gate.wait(10)
        return real(address, event)
    monkeypatch.setattr(m.gmail, "insert", insert)
    m.cc.write_timeout_s = 0.05
    return gate, calls


# -- 1. the lease is fenced ---------------------------------------------------------------------

def test_a_hung_write_is_abandoned_at_its_timeout_and_settled_by_reading(m, monkeypatch, caplog):
    gate, calls = hang_first_insert(m, monkeypatch)
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    assert calendar_change.WRITE_TIMEOUT_S == 30 < calendar_change.LEASE_S
    m.tells("add the dentist at 3 today", ask(DENTIST))
    assert rows(m)[-1]["state"] == "settling"                # not done: its answer is read for
    assert any("gave no answer in 0.05s: abandoned" in r.getMessage() for r in caplog.records)
    plan = json.loads(rows(m)[-1]["settle_json"])
    rec = plan["parts"][0]["steps"][0]
    assert rec["abandoned"] and rec["fence"] == m.ledger.get_meta(f"calendar_change_fence:{rows(m)[-1]['proposal_id']}")
    gate.set()
    m.cc.join_abandoned()
    m.clock.t += timedelta(minutes=1)
    for _ in range(3):
        m.c.tick()
    assert len(dentists(m)) == 1 and len(calls) == 1          # the late answer is read, never sent again
    assert m.seen()[-1].startswith("Done.") and rows(m)[-1]["state"] == "done"


def _lapse_and_reoffer(m, monkeypatch):
    """A fast-path add whose write hangs past its lease; a note from Cain later finds it not done
    (two reads) and it comes again on a card, under the same fixed id."""
    gate, calls = hang_first_insert(m, monkeypatch)
    mid = m.he_says("add the dentist at 3 today")
    m.claude.script = [ask(DENTIST)]
    m.handover(paired=OWNER, message=mid)
    first = rows(m)[-1]["proposal_id"]
    m.clock.t += timedelta(minutes=3)
    m.claude.script = [ask(DENTIST)]
    out = m.handover(paired=OWNER, message=mid, suggestion="The dentist at 3 PM today.")
    assert out["status"] == "waiting for his tap"
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()[0] == "lapsed"
    newer = m.ledger.get_meta(f"calendar_change_reoffer:{first}")
    assert newer and m.cc.keys_of(newer) == [f"{first}:0"]   # the same fixed id as the first offer
    return gate, calls, first, newer


def test_a_write_landing_after_the_lease_and_after_the_reoffer_tap_is_never_a_second_event(m, monkeypatch):
    gate, calls, first, newer = _lapse_and_reoffer(m, monkeypatch)
    m.tap("Approve")                                         # the card offered again: written now
    assert len(dentists(m)) == 1 and m.seen()[-1].startswith("Done.")
    gate.set()                                               # the first write answers at last
    m.cc.join_abandoned()
    m.c.tick()
    assert len(dentists(m)) == 1 and len(set(calls)) == 1    # one fixed id: Google turned the late one down
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?",
                               (first,)).fetchone()[0] == "landed_late"


def test_a_write_landing_after_the_lease_takes_the_reoffered_card_off(m, monkeypatch):
    gate, calls, first, newer = _lapse_and_reoffer(m, monkeypatch)
    card = card_with(m, "Approve")
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"]
                  if c["label"] == "Approve")
    gate.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert len(dentists(m)) == 1
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (newer,)).fetchone()[0] == "superseded"
    said = [t for t in m.seen() if t.startswith("Done after all")]
    assert said and "the newer card is off" in said[-1] and "Undo" in m.labels()
    assert m.link.cards[card]["rows"] == []                  # its buttons came off
    m.send(Handover(kind="press", press={"id": "97100", "token": "t", "app": "999", "custom_id": custom,
                                         "message_id": str(card)}))
    assert len(dentists(m)) == 1                             # a tap that beat that does nothing


def test_lapsed_is_never_declared_on_one_read(m, monkeypatch):
    gate, calls = hang_first_insert(m, monkeypatch)
    mid = m.he_says("add the dentist at 3 today")
    m.claude.script = [ask(DENTIST)]
    m.handover(paired=OWNER, message=mid)
    pid = rows(m)[-1]["proposal_id"]
    m.clock.t += timedelta(minutes=3)
    real = m.gmail.events_between
    reads = []

    def one_answer(address, start, end, fresh=False):
        reads.append(fresh)
        if len(reads) > 1:
            return None                                       # the second read gets no answer
        return real(address, start, end)
    monkeypatch.setattr(m.gmail, "events_between", one_answer)
    assert m.cc.lease_state(pid) == "unsure"                  # one read isn't enough to lapse it
    assert rows(m)[-1]["state"] == "settling"
    gate.set()
    m.cc.join_abandoned()


def test_a_move_that_landed_already_is_a_no_op_at_the_apply(m):
    """The move's current time is checked again at the apply: one already at its new time (an
    earlier write that landed late) writes nothing."""
    m.gmail.events["haircut1"] = {"id": "haircut1", "summary": "Haircut", "status": "confirmed", "etag": '"h"',
                                  "organizer": {"email": GMAIL, "self": True},
                                  "start": {"dateTime": at(10, 30).isoformat(), "timeZone": TZ},
                                  "end": {"dateTime": at(11).isoformat(), "timeZone": TZ}}
    m.tells("haircut moved to 10:30 today", ask(change("gmail", "move", "Haircut", dates="2026-11-11",
                                                         start=at(10, 30).isoformat(), end=at(11).isoformat())))
    assert "Already at that time, nothing moved: “Haircut”" in m.seen()[-1]
    assert not [x for x in m.gmail.log if x[0] == "change"]


# -- 3. never silent on a duplicate ---------------------------------------------------------------

def test_add_anyway_on_the_receipt_makes_the_second_event(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    m.tells("add the dentist at 3 today", ask(DENTIST))
    assert "Already there, nothing added: “Dentist”" in m.seen()[-1] and len(dentists(m)) == 1
    m.tap("Add anyway")
    m.c.tick()
    assert len(dentists(m)) == 2 and m.seen()[-1].startswith("Done.") and "Undo" in m.labels()


def test_a_duration_mismatch_is_his_decision_on_a_card(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    out = m.tells("add the dentist 3 to 5 today", ask(change("gmail", "add", "Dentist", dates="",
                                                           start=at(15).isoformat(), end=at(17).isoformat())))
    assert out["status"] == "waiting for his tap" and "Add anyway" in m.labels() and "Leave it" in m.labels()
    assert "Already on your Gmail calendar at that time: “Dentist”, today, 3:00 to 4:00" in m.seen()[-1]
    assert len(dentists(m)) == 1


def test_one_day_of_a_series_is_not_the_same_event_as_a_one_off(m):
    m.gmail.events["dent0series"] = {
        "id": "dent0series", "summary": "Dentist", "status": "confirmed", "etag": '"s"',
        "organizer": {"email": GMAIL, "self": True}, "recurrence": ["RRULE:FREQ=WEEKLY"],
        "start": {"dateTime": at(15, day=4).isoformat(), "timeZone": TZ},
        "end": {"dateTime": at(16, day=4).isoformat(), "timeZone": TZ}}
    uid = "dent0series_20261111T200000Z"
    m.gmail.events[uid] = {"id": uid, "recurringEventId": "dent0series", "summary": "Dentist", "status": "confirmed",
                           "etag": '"d"', "organizer": {"email": GMAIL, "self": True},
                           "originalStartTime": {"dateTime": at(15).isoformat()},
                           "start": {"dateTime": at(15).isoformat(), "timeZone": TZ},
                           "end": {"dateTime": at(16).isoformat(), "timeZone": TZ}}
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "waiting for his tap" and "Leave it" in m.labels()
    assert "3:00 to 4:00, repeating" in m.seen()[-1]


# -- 4. the no-card paths behind a flag -------------------------------------------------------------

@pytest.mark.card_only
def test_after_install_his_fresh_words_come_on_a_normal_card(m):
    assert calendar_change.fast_path(m.ledger) == {}
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "waiting for his tap" and "Approve" in m.labels() and not dentists(m)
    m.tap("Approve")
    assert len(dentists(m)) == 1 and m.seen()[-1].startswith("Done.")


@pytest.mark.card_only
def test_a_mail_date_he_sent_to_family_comes_on_a_card_until_the_smoke_test(m):
    before = set(m.icloud.events)
    assert m.c._mail_to_family("Due: Field trip form", date(2026, 11, 13), None)
    m.c.tick()
    assert set(m.icloud.events) == before and "Approve" in m.labels()


@pytest.mark.card_only
def test_cains_fastpath_command_records_the_smoke_test_and_turns_it_on(m):
    out = m.send(Handover(kind="fastpath", state="on", smoke=""))
    assert out["status"] == "refused" and not calendar_change.fast_path_on(m.ledger)
    out = m.send(Handover(kind="fastpath", state="on", smoke="Added, moved and removed a test event on both calendars; each read back."))
    assert out["status"] == "ok"
    kept = calendar_change.fast_path(m.ledger)
    assert kept["on"] is True and kept["smoke"].startswith("Added, moved and removed") and kept["at"]
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "executed" and len(dentists(m)) == 1
    assert m.send(Handover(kind="fastpath", state="off"))["status"] == "ok"
    assert not calendar_change.fast_path_on(m.ledger)
    out = m.tells("add the dentist again at 5 today", ask(change("gmail", "add", "Dentist again", dates="",
                                                                start=at(17).isoformat(), end=at(18).isoformat())))
    assert out["status"] == "waiting for his tap"


# -- 8. relative days left open ---------------------------------------------------------------------

def test_a_weekday_that_is_the_day_he_sent_it_is_left_open():
    sent = datetime(2026, 11, 13, 9, tzinfo=NY)               # a Friday
    assert open_day("dentist friday at 3", sent) == "friday"
    assert resolution("dentist friday", date(2026, 11, 13), sent.date(), sent.hour) == ""
    assert resolution("dentist friday", date(2026, 11, 20), sent.date(), sent.hour) == ""
    line, flagged = detail_line(change("gmail", "add", "Dentist", dates="", start="2026-11-13T15:00:00-05:00",
                                       end="2026-11-13T16:00:00-05:00"), "dentist friday at 3pm", "", TZ, sent, sent)
    assert flagged and "(not in your words)" in line


def test_an_ordinal_that_is_todays_date_is_left_open():
    sent = datetime(2026, 11, 16, 9, tzinfo=NY)
    assert open_day("dentist on the 16th", sent) == "the 16th"
    assert open_day("dentist on Nov 16th", sent) == ""       # with its month it has one answer
    assert resolution("dentist on the 16th", date(2026, 11, 16), sent.date(), sent.hour) == ""
    line, flagged = detail_line(change("gmail", "add", "Dentist", dates="", start="2026-12-16T15:00:00-05:00",
                                       end="2026-12-16T16:00:00-05:00"), "dentist on the 16th at 3pm", "", TZ, sent, sent)
    assert flagged


def test_tonight_sent_between_midnight_and_four_is_left_open():
    sent = datetime(2026, 11, 12, 0, 30, tzinfo=NY)
    assert open_day("skip the movie tonight", sent) == "tonight"
    assert resolution("skip the movie tonight", date(2026, 11, 12), sent.date(), sent.hour) == ""
    later = datetime(2026, 11, 12, 4, 30, tzinfo=NY)
    assert open_day("skip the movie tonight", later) == ""
    assert resolution("skip the movie tonight", date(2026, 11, 12), later.date(), later.hour) == "tonight"


def test_his_wednesday_sent_on_a_wednesday_comes_on_a_card(m):
    out = m.tells("dentist wednesday at 3", ask(DENTIST))    # the rig's today is a Wednesday
    assert out["status"] == "waiting for his tap" and not dentists(m)
    assert "(not in your words)" in m.seen()[-1]
