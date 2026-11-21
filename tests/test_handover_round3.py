"""0.24.0, third round: what the second outside review of the handover fixes asked for (Nov 16).

Each must-fix on its own, against the fake calendars and a fake Discord: every change read back
before Done, the already-there rule as his decision, a lease on changes being written, the fast
path checked again at the moment of the write, replacing only the cards a correction addresses,
cards left open by the version before, a second read past any cache, the scope of a change to a
repeating event, relative days counted from his own day, and a clarify deadline that survives a
stalled tick or a restart. All names and ids invented.
"""
import logging
from datetime import datetime, timedelta, timezone

import pytest

from harness import approvals, calendar_change
from harness.handover import Handover
from harness.provenance import detail_line, resolution, resolutions
from fakes import result
from test_discord_keeper import OWNER
from test_plain_commands import (DROP_OFF, GMAIL, MOVE_PT, NY, PT_ID, TZ, Morning, at, ask, change,
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round2 import card_with, press
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


DENTIST = change("gmail", "add", "Dentist", dates="", start=at(15).isoformat(), end=at(16).isoformat())
PICK_OFF = change("gmail", "remove", "the pickup")
MOVE_DROP = change("gmail", "move", "the drop-off", start=at(8, 30).isoformat(), end=at(9, 15).isoformat())


def receipt_rows(m):
    return m.ledger.db.execute("SELECT * FROM calendar_changes ORDER BY rowid").fetchall()


def inserts(m):
    return [x for x in m.gmail.log if x[0] == "insert"]


# -- 1. read back for every change -------------------------------------------------------------

def test_an_add_the_read_back_cannot_find_is_not_done_and_never_written_again(m, monkeypatch):
    real = m.gmail.events_between

    def hides_the_dentist(address, start, end, fresh=False):
        return [e for e in real(address, start, end) if e.get("summary") != "Dentist"]
    monkeypatch.setattr(m.gmail, "events_between", hides_the_dentist)
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    said = m.seen()[-1]
    assert out["status"] != "executed" and said.startswith("Not confirmed.")
    assert "Not confirmed: Add Dentist, today, 3:00 to 4:00 (Gmail). I wrote it, but a read of your " \
           "Gmail calendar for that day doesn't list it" in said
    assert "Undo" in m.labels()                              # a way back for what was written
    assert receipt_rows(m)[-1]["state"] == "unverified"
    m.clock.t += timedelta(minutes=5)
    for _ in range(3):
        m.c.tick()
    assert len(inserts(m)) == 1                              # never written again on its own
    nothing_he_shouldnt_see(m, out)


def test_a_read_back_that_disagrees_once_is_read_again_past_the_cache(m, monkeypatch, caplog):
    real = m.gmail.events_between
    asked = []

    def stale_first(address, start, end, fresh=False):
        asked.append(fresh)
        events = real(address, start, end)
        return events if fresh else [e for e in events if e.get("summary") != "Dentist"]
    monkeypatch.setattr(m.gmail, "events_between", stale_first)
    pauses = []
    m.cc.sleep = pauses.append
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    out = m.tells("add the dentist at 3 today", ask(DENTIST))
    assert out["status"] == "executed" and m.seen()[-1].startswith("Done.")
    assert True in asked and pauses                          # the second read asked past any cache
    logged = [r.getMessage() for r in caplog.records if r.getMessage().startswith("read back of gmail")]
    assert any("(first)" in x for x in logged) and any("(fresh)" in x and "Dentist" in x for x in logged)


def test_a_move_whose_read_back_still_shows_the_old_time_is_said_so(m, monkeypatch):
    real = m.gmail.events_between

    def old_time(address, start, end, fresh=False):
        out = []
        for e in real(address, start, end):
            if e["id"] == PT_ID:
                e = {**e, "start": {"dateTime": at(12).isoformat()}, "end": {"dateTime": at(13).isoformat()}}
            out.append(e)
        return out
    monkeypatch.setattr(m.gmail, "events_between", old_time)
    out = m.tells("PT moved to 11:30 today", ask(MOVE_PT))
    said = m.seen()[-1]
    assert out["status"] != "executed" and said.startswith("Not confirmed.")
    assert "still shows it at the old time, 12:00 to 1:00 today" in said and "Undo" in m.labels()
    m.tap("Undo")
    assert m.gmail_times(PT_ID) == ("12:00", "13:00")


def test_a_half_applied_move_says_what_went_through_and_offers_the_way_back(m):
    def copy_refused():
        m.icloud.force_status = 403                          # the Family copy's write is turned down
    m.icloud.before_write = copy_refused
    out = m.tells("PT moved to 11:30 today", ask(MOVE_PT))
    said = m.seen()[-1]
    assert out["status"] != "executed" and m.gmail_times(PT_ID) == ("11:30", "12:30")
    assert "Partly done: Move PT to 11:30 to 12:30 today (Gmail and Family). It went through on Gmail, " \
           "not on the Family copy" in said
    assert "Undo" in m.labels()
    m.icloud.before_write = None
    m.tap("Undo")
    assert m.gmail_times(PT_ID) == ("12:00", "13:00") and m.seen()[-1].startswith("Undone.")


def test_a_move_the_read_back_finds_at_neither_time_is_said_so(m, monkeypatch):
    real = m.gmail.events_between
    moved = at(11, 30).isoformat()
    monkeypatch.setattr(m.gmail, "events_between",       # after the move, no read lists it anywhere
                        lambda address, start, end, fresh=False: [
                            e for e in real(address, start, end)
                            if not (e["id"] == PT_ID and e["start"].get("dateTime") == moved)])
    m.tells("PT moved to 11:30 today", ask(MOVE_PT))
    assert "shows it at neither the old time nor the new one" in m.seen()[-1] and "Undo" in m.labels()


# -- 2. already there: silent only for the very same event ---------------------------------------

def test_an_exact_duplicate_adds_nothing_and_its_receipt_names_it_with_add_anyway(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    before = dict(m.gmail.events)
    out = m.tells("add the dentist at 3 today", ask(change("gmail", "add", "  dentist ", dates="",
                                                            start=at(15).isoformat(), end=at(16).isoformat())))
    assert out["status"] == "executed" and "Approve" not in m.labels()
    said = m.seen()[-1]
    assert said.startswith("Nothing added.") and "Already there, nothing added: “Dentist”, today, 3:00 to 4:00" in said
    assert "Add anyway" in m.labels()                        # never silent (0.24.0, fourth round)
    assert m.gmail.events.keys() == before.keys() and len(inserts(m)) == 1


def test_add_anyway_on_a_loose_match_makes_the_second_event(m):
    out = m.tells("add the school drop-off at 8 today",
                  ask(change("gmail", "add", "School drop-off", dates="", start=at(8).isoformat(),
                             end=at(8, 45).isoformat())))
    assert out["status"] == "waiting for his tap" and not inserts(m)
    m.tap("Add anyway")
    made = [e for e in m.gmail.events.values() if e.get("summary") == "School drop-off"]
    assert len(made) == 1 and m.block_state("drop") == "confirmed"
    assert m.seen()[-1].startswith("Done.") and "Added School drop-off" in m.seen()[-1]


def test_leave_it_is_bookkeeping_a_rerun_counts_as_settled(m):
    mid = m.he_says("add the school drop-off at 8 today", ago=10 * 60)
    m.claude.script = [ask(change("gmail", "add", "School drop-off", dates="", start=at(8).isoformat(),
                                  end=at(8, 45).isoformat()))]
    m.handover(paired=OWNER, message=mid)
    m.tap("Leave it")
    assert not inserts(m) and "Add anyway" not in m.labels()
    job = m.ledger.job(m.ledger.db.execute("SELECT job_id FROM proposals WHERE state='declined'").fetchone()[0])
    done, busy, left = m.c.runner._not_yet_done(job, {"changes": [change(
        "gmail", "add", "School drop-off", dates="", start=at(8).isoformat(), end=at(8, 45).isoformat())]})
    assert done and done[0].startswith("Left as it is: ") and not busy and left["changes"] == []



def test_a_short_title_never_counts_as_already_there(m):
    out = m.tells("add PT at noon today", ask(change("gmail", "add", "PT", dates="", start=at(12).isoformat(),
                                                     end=at(13).isoformat())))
    assert out["status"] == "executed" and "Add anyway" not in m.labels()
    assert [x[1]["summary"] for x in inserts(m)] == ["PT"]


# -- 3. a lease on a change being written --------------------------------------------------------

def test_a_change_cut_short_is_offered_again_once_its_lease_runs_out(m):
    m.gmail.answer = "unknown"                               # the add's answer is lost; nothing landed
    m.gmail.down = True                                      # and reads by id can't tell
    mid = m.he_says("add the dentist at 3 today")
    m.claude.script = [ask(DENTIST)]
    m.handover(paired=OWNER, message=mid)
    assert receipt_rows(m)[-1]["state"] == "settling"
    pid = receipt_rows(m)[-1]["proposal_id"]
    assert m.cc.lease_state(pid) == "live"
    # Within the lease it's in progress: a rerun of that message waits rather than offer it twice.
    job = m.ledger.job(m.ledger.db.execute("SELECT job_id FROM proposals WHERE id=?", (pid,)).fetchone()[0])
    assert m.c.runner._not_yet_done(job, {"changes": [DENTIST]})[1] == ["Add Dentist, today, 3:00 to 4:00 (Gmail)"]
    m.gmail.answer = "ok"
    m.clock.t += timedelta(minutes=3)
    m.claude.script = [ask(DENTIST)]
    out = m.handover(paired=OWNER, message=mid, suggestion="The dentist at 3 PM today.")
    # Past the lease, a read says it isn't there: it stops, and comes again on a card.
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()[0] == "lapsed"
    assert out["status"] == "waiting for his tap" and "Approve" in m.labels()
    assert "In progress" not in m.seen()[-1] and "Already done" not in m.seen()[-1]
    m.tap("Approve")
    assert [e["summary"] for e in m.gmail.events.values() if e.get("summary") == "Dentist"] == ["Dentist"]


# -- 4. the fast path, checked again at the write -------------------------------------------------

def test_a_correction_between_the_decision_and_the_write_makes_a_card(m, monkeypatch):
    real = calendar_change.CalendarChange.auto_approve

    def he_corrects(self, pid, job_id, db):
        real(self, pid, job_id, db)
        m.he_says("wait, not today", ago=0)                  # arrives before the write
    monkeypatch.setattr(calendar_change.CalendarChange, "auto_approve", he_corrects)
    out = m.tells("not doing the 8:00 drop-off today", ask(change("gmail", "remove", "the 8:00 drop-off")))
    assert m.block_state("drop") == "confirmed"              # nothing applied
    assert out["status"] == "waiting for his tap" and "Approve" in m.labels()
    assert "you sent another message after it, so this waits for your tap" in m.seen()[-1]


def test_a_fast_path_change_over_two_minutes_old_at_its_write_makes_a_card(m, monkeypatch):
    real = calendar_change.CalendarChange.auto_approve

    def slow(self, pid, job_id, db):
        real(self, pid, job_id, db)
        m.clock.t += timedelta(minutes=3)
    monkeypatch.setattr(calendar_change.CalendarChange, "auto_approve", slow)
    m.tells("not doing the 8:00 drop-off today", ask(change("gmail", "remove", "the 8:00 drop-off")))
    assert m.block_state("drop") == "confirmed" and "over 2 minutes old now" in m.seen()[-1]


# -- 5. replacing only what a correction addresses --------------------------------------------------

def test_split_in_three_a_correction_to_part_two_leaves_parts_one_and_three_offered(m):
    mid = m.he_says("PT is at 11:30, no drop-off and no pickup today", ago=10 * 60)
    m.claude.script = [ask(MOVE_PT, DROP_OFF, PICK_OFF)]
    m.handover(paired=OWNER, message=mid)
    cards = [cid for cid in m.link.cards if m.link.cards[cid]["rows"]]
    assert len(cards) == 3
    texts = {cid: m.link.cards[cid]["text"] for cid in cards}
    pt = next(c for c, t in texts.items() if "Exactly: Move" in t)
    drop = next(c for c, t in texts.items() if "event school drop" in t)
    pick = next(c for c, t in texts.items() if "event the pickup" in t)
    m.claude.script = [ask(MOVE_PT, MOVE_DROP, PICK_OFF)]
    out = m.handover(paired=OWNER, message=mid, suggestion="He means the drop-off moved to 8:30, not off.")
    assert out["status"] == "waiting for his tap"
    assert m.link.cards[pt]["rows"] and m.link.cards[pick]["rows"]     # still offered, untouched
    assert m.link.cards[drop]["rows"] == []                           # replaced
    new = card_with(m, "Approve")
    assert new not in (pt, drop, pick) and "Move" in m.seen()[-1] and "8:30" in m.seen()[-1]
    assert "Replaces the earlier card." in m.seen()[-1]
    press(m, pick, "Approve")
    assert m.block_state("pick") == "cancelled"
    press(m, pt, "Approve")
    assert m.gmail_times(PT_ID) == ("11:30", "12:30")


def test_two_taps_on_one_card_at_once_apply_it_once(m):
    m.he_says("not doing the 8:00 drop-off", ago=10 * 60)
    m.claude.script = [ask(change("gmail", "remove", "the 8:00 drop-off"))]
    m.handover(paired=OWNER, message=m.d.hist[0]["id"])
    card = card_with(m, "Approve")
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"]
                  if c["label"] == "Approve")
    taps = [Handover(kind="press", press={"id": str(96000 + n), "token": "t", "app": "999",
                                          "custom_id": custom, "message_id": str(card)}) for n in range(2)]
    for h in taps:                                       # both in before either is handled
        m.c.handovers.submit(h)
    for _ in range(6):
        m.c.tick()
    drops = [x for x in m.gmail.log if x[0] == "drop"]
    assert len(drops) == 1 and m.block_state("drop") == "cancelled"
    assert len([1 for h in taps if h.done.is_set()]) == 2


def test_a_tap_and_a_replacement_cannot_both_win(ledger, clock):
    clock.t = datetime(2026, 11, 11, 13, tzinfo=timezone.utc)
    from types import SimpleNamespace
    with ledger.tx() as db:
        job = ledger.made_job(1, "x", kind="message", db=db, state="proposed")
    pid = approvals.create_proposal(ledger, job_id=job, effect_type="calendar_change", params={"changes": []},
                                    policy_version="p", ttl_s=600)
    nonce = approvals.mint(ledger, proposal_id=pid, owner_user_id=1, ttl_s=600)
    approvals.bind_message(ledger, nonce, 55)
    tap = SimpleNamespace(callback_data=approvals.callback_data("approve", nonce), user_id=1, chat_id=1,
                          chat_type="private", message_id=55, update_id=1)
    assert approvals.verify_and_consume(ledger, tap, owner_user_id=1, policy_version="p").ok
    with ledger.tx() as db:
        assert approvals.supersede(ledger, pid, db=db) is False        # the tap won
    assert ledger.db.execute("SELECT state FROM proposals WHERE id=?", (pid,)).fetchone()[0] == "approved"
    # The other order: the replacement wins, and the tap is refused as replaced.
    with ledger.tx() as db:
        job2 = ledger.made_job(1, "y", kind="message", db=db, state="proposed")
    pid2 = approvals.create_proposal(ledger, job_id=job2, effect_type="calendar_change", params={"changes": []},
                                     policy_version="p", ttl_s=600)
    nonce2 = approvals.mint(ledger, proposal_id=pid2, owner_user_id=1, ttl_s=600)
    approvals.bind_message(ledger, nonce2, 56)
    with ledger.tx() as db:
        assert approvals.supersede(ledger, pid2, db=db) is True
    late = SimpleNamespace(callback_data=approvals.callback_data("approve", nonce2), user_id=1, chat_id=1,
                           chat_type="private", message_id=56, update_id=2)
    v = approvals.verify_and_consume(ledger, late, owner_user_id=1, policy_version="p")
    assert not v.ok and v.reason == "replaced"


def test_a_correction_while_his_tap_is_being_done_waits_then_reads_the_result(m, monkeypatch):
    real = m.gmail.drop

    def lost(address, uid, etag):                            # his approved removal is still settling
        m.gmail.down = True
        from harness import caldav
        return caldav.Outcome("unknown")
    monkeypatch.setattr(m.gmail, "drop", lost)
    mid = m.he_says("not doing the 8:00 drop-off", ago=10 * 60)
    m.claude.script = [ask(change("gmail", "remove", "the 8:00 drop-off"))]
    m.handover(paired=OWNER, message=mid)
    m.tap("Approve")
    assert receipt_rows(m)[-1]["state"] == "settling"
    m.claude.script = [ask(change("gmail", "remove", "Busy (school drop-off)"))]
    h = Handover(paired=OWNER, message=mid, suggestion="The 8:00 drop-off on his Gmail.")
    m.c.handovers.submit(h)
    for _ in range(4):
        m.c.tick()
    assert not h.done.is_set() and len(m.claude.calls) == 1  # waits while the lease runs
    monkeypatch.setattr(m.gmail, "drop", real)
    m.gmail.down = False
    m.gmail.events[m.blocks["drop"][1]]["status"] = "cancelled"   # it did land
    m.clock.t += timedelta(minutes=1)
    for _ in range(6):
        m.c.tick()
        if h.done.is_set():
            break
    assert h.done.is_set() and len(m.claude.calls) == 2
    assert "Already done" in h.result["said"] and "Approve" not in m.labels()


# -- 6. cards left open by the version before: now tests/test_handover_round4.py (the migration) ------


# -- 8. a repeating event: which day, or the whole series -------------------------------------------

def _swim(m):
    """A weekly swim on his Gmail calendar, today's day of it and next week's."""
    master = {"id": "swim0series", "summary": "Swim", "status": "confirmed", "etag": '"s"',
              "organizer": {"email": GMAIL, "self": True}, "recurrence": ["RRULE:FREQ=WEEKLY"],
              "start": {"dateTime": at(18, day=4).isoformat(), "timeZone": TZ},
              "end": {"dateTime": at(19, day=4).isoformat(), "timeZone": TZ}}
    m.gmail.events["swim0series"] = master
    for day in (11, 18):
        uid = f"swim0series_202611{day}T230000Z"
        m.gmail.events[uid] = {"id": uid, "recurringEventId": "swim0series", "summary": "Swim",
                               "status": "confirmed", "etag": f'"{day}"', "organizer": {"email": GMAIL, "self": True},
                               "originalStartTime": {"dateTime": at(18, day=day).isoformat()},
                               "start": {"dateTime": at(18, day=day).isoformat(), "timeZone": TZ},
                               "end": {"dateTime": at(19, day=day).isoformat(), "timeZone": TZ}}
    return "swim0series_20261111T230000Z"


def test_taking_off_one_day_of_a_series_binds_that_occurrence_and_undo_puts_back_exactly_it(m):
    today = _swim(m)
    mid = m.he_says("no swim today", ago=10 * 60)
    m.claude.script = [ask(change("gmail", "remove", "Swim"))]
    m.handover(paired=OWNER, message=mid)
    card = m.seen()[-1]
    assert "this occurrence only (the rest of the series stays)" in card and "id ending 1230000Z"[-6:] in card
    bound = m.cc.bound_of(m.ledger.db.execute("SELECT id FROM proposals WHERE state='proposed'").fetchone()[0])
    assert bound["bound"][0]["recurrence"] == today and bound["bound"][0]["scope"] == "occurrence"
    m.tap("Approve")
    assert m.gmail.events[today]["status"] == "cancelled"
    assert m.gmail.events["swim0series_20261118T230000Z"]["status"] == "confirmed"
    assert m.seen()[-1].startswith("Done.")
    m.tap("Undo")
    assert m.gmail.events[today]["status"] == "confirmed" and m.seen()[-1].startswith("Undone.")
    # The read back is of that very occurrence at its own time: another time isn't "back".
    assert m.cc._undone_reads({"cal": "gmail", "how": "restore", "id": today,
                               "fields": {"start": {"dateTime": at(17, day=11).isoformat()}}}) == "differs"


def test_ending_a_series_shows_the_whole_series_and_undo_restores_it_read_back(m, monkeypatch):
    _swim(m)
    real = m.gmail.change

    def change_and_expand(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        rule = " ".join(m.gmail.events["swim0series"].get("recurrence") or [])
        for k, e in m.gmail.events.items():             # the days the rule now holds, as Google lists them
            if e.get("recurringEventId") == "swim0series":
                e["status"] = "cancelled" if "UNTIL" in rule and k.endswith("18T230000Z") else "confirmed"
        return out
    monkeypatch.setattr(m.gmail, "change", change_and_expand)
    mid = m.he_says("swim is over after this week, end it from the 18th", ago=10 * 60)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-18"))]
    m.handover(paired=OWNER, message=mid)
    assert "the whole series from then on" in m.seen()[-1]
    m.tap("Approve")
    assert m.seen()[-1].startswith("Done.") and "UNTIL" in m.gmail.events["swim0series"]["recurrence"][0]
    m.tap("Undo")
    assert m.seen()[-1].startswith("Undone.") and m.gmail.events["swim0series"]["recurrence"] == ["RRULE:FREQ=WEEKLY"]


# -- 9. relative days, counted from his own day -----------------------------------------------------

def test_tomorrow_sent_just_before_midnight_is_the_next_day_after_midnight_too():
    sent = datetime(2026, 11, 11, 23, 58, tzinfo=NY)
    read = datetime(2026, 11, 12, 0, 3, tzinfo=NY)
    c = change("gmail", "add", "Dentist", dates="", start="2026-11-12T15:00:00-05:00", end="2026-11-12T16:00:00-05:00")
    line, flagged = detail_line(c, "dentist tomorrow at 3pm", "", TZ, read, sent)
    assert not flagged and "date Thu Nov 12 (your “tomorrow”)" in line
    # Counted from the moment it's read instead, "tomorrow" would have been the 13th.
    assert resolution("dentist tomorrow", datetime(2026, 11, 13).date(), read.date()) == "tomorrow"
    assert resolution("dentist tomorrow", datetime(2026, 11, 12).date(), sent.date()) == "tomorrow"
    assert resolutions([c], "dentist tomorrow at 3pm", TZ, sent) == ["“tomorrow” as Thu Nov 12"]


def test_today_sent_just_before_midnight_is_still_that_day():
    sent = datetime(2026, 11, 11, 23, 59, tzinfo=NY)
    assert resolution("not tonight", datetime(2026, 11, 11).date(), sent.date()) == "tonight"
    assert resolution("not tonight", datetime(2026, 11, 12).date(), sent.date()) == ""


def test_next_friday_has_no_one_answer_and_needs_his_tap():
    today = datetime(2026, 11, 11).date()                  # a Wednesday
    assert resolution("dentist friday", datetime(2026, 11, 13).date(), today) == "friday"
    assert resolution("dentist next friday", datetime(2026, 11, 13).date(), today) == ""
    assert resolution("dentist next friday", datetime(2026, 11, 20).date(), today) == ""
    c = change("gmail", "add", "Dentist", dates="", start="2026-11-20T15:00:00-05:00", end="2026-11-20T16:00:00-05:00")
    line, flagged = detail_line(c, "dentist next friday at 3pm", "", TZ, datetime(2026, 11, 11, 9, tzinfo=NY))
    assert flagged and "date Fri Nov 20 (not in your words)" in line


def test_a_weekday_resolves_to_the_soonest_one_and_the_receipt_says_so(m):
    out = m.tells("dentist friday at 3pm", ask(change("gmail", "add", "Dentist", dates="",
                                                      start=at(15, day=13).isoformat(), end=at(16, day=13).isoformat())))
    assert out["status"] == "executed"
    assert "Read from your words: “friday” as Fri Nov 13." in m.seen()[-1]
    out = m.tells("dentist friday at 3pm", ask(change("gmail", "add", "Dentist again", dates="",
                                                      start=at(15, day=20).isoformat(), end=at(16, day=20).isoformat())))
    assert "Read from your words" not in m.seen()[-1]


# -- 10. a clarify deadline that a stalled tick or a restart can't lose ---------------------------------

def test_the_clarify_deadline_is_stored_and_fires_late_after_a_stall_with_the_delay_logged(m, caplog):
    m.claude.script = [result({"type": "clarify", "question": "Which field trip do you mean?"})]
    m.he_says("add the field trip")
    m.handover(paired=OWNER, suggestion="A field trip, from the school's email.")
    job = m.ledger.jobs_in("needs_clarification")[0]
    due = datetime.fromisoformat(m.ledger.get_meta(f"clarify_due:{job['id']}"))
    assert due == m.clock() + timedelta(minutes=10)
    cards = len(m.link.cards)
    caplog.set_level(logging.INFO, logger="harness.controller")
    m.clock.t += timedelta(hours=1)                          # no tick for an hour
    m.c._reconciled = False                                  # as after a restart
    m.c._reconcile()
    m.c.outbox.flush()
    assert len(m.link.cards) == cards + 1 and "Which field trip do you mean?" in m.seen()[-1]
    said = [r.getMessage() for r in caplog.records if "after its deadline" in r.getMessage()]
    assert said and "3000s after its deadline (the first tick after a restart)" in said[0]
    m.c.tick()
    assert len(m.link.cards) == cards + 1                    # once
