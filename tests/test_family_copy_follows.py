"""Nov 27: a Family copy that followed his own move of one day of a repeating event, then stayed behind
when Harness moved that day on his card, and every request to fix it came back "Change the event on
Gmail". Massage with a street address, added by Harness, never got its copy, and there was no drive
time. These replay it and check each fix on its own. All names, ids and places are invented.
"""
import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from harness import caldav, drive_cards, family_copy, google_cal, ical
from harness.family_copy import FamilyCopy, plan, word_for
from harness.family_gmail import drive_dry
from harness.ledger import iso
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from fakes import result
from test_family_add import on, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_meaning_live import CLINIC, M, PARK, blocks, drives, go, live, mine, quiet_family  # noqa: F401
from test_family_copy import GMAIL as GMAIL_G, Feeds, when
from test_plain_commands import GMAIL, NY, TZ, Morning, ask, at, change, plain_prompt  # noqa: F401

SERIES = "s0ai2c7kb1mbia2n4mdl3e6p10"                   # invented, shaped like Google's
DAY = 12                                                 # tomorrow in the rig (Thu Nov 12)
ORIGINAL = at(8, 30, day=DAY)                            # the day's place in the series
INSTANCE = f"{SERIES}_{ORIGINAL.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
SOURCE_TITLE = "Coffee with Chris"
COPY_TITLE = "Alex - Coffee"


@pytest.fixture
def m(ledger, tmp_path, clock):
    m = Morning(ledger, tmp_path, clock)
    m.gmail.events[INSTANCE] = {
        "id": INSTANCE, "iCalUID": f"{SERIES}@google.com", "etag": '"c1"', "status": "confirmed",
        "summary": SOURCE_TITLE, "organizer": {"email": GMAIL, "self": True}, "recurringEventId": SERIES,
        "originalStartTime": {"dateTime": ORIGINAL.isoformat(), "timeZone": TZ},
        "start": {"dateTime": ORIGINAL.isoformat(), "timeZone": TZ},
        "end": {"dateTime": (ORIGINAL + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
    m.feeds = Feeds()
    m.feeds.window.calendar = GMAIL
    m.copier = FamilyCopy(ledger, m.fa, m.feeds, name_fn=lambda: "Alex", tz=TZ, google=m.gmail,
                          address_fn=lambda: GMAIL)
    m.key = family_copy._key(google_cal._occurrence(m.gmail.events[INSTANCE], GMAIL, ""))
    return m


def sync(m):
    """One read of his Gmail calendar (through Google, as the App reads it), and the copy's sync on it."""
    events = [{"iCalUID": f"{e['id']}@google.com", **e} for e in m.gmail.events.values()
              if e.get("status") != "cancelled"]
    m.feeds.window.occurrences = [o for o in (google_cal._occurrence(e, GMAIL, "") for e in events) if o is not None]
    m.feeds.generation += 1
    m.copier._sync()


def moved_by_hand(m, start, end):
    """He drags that day on Google Calendar: same id, same original start, new times."""
    e = m.gmail.events[INSTANCE]
    e["start"] = {"dateTime": start.isoformat(), "timeZone": TZ}
    e["end"] = {"dateTime": end.isoformat(), "timeZone": TZ}
    e["etag"] = f'"c{int(e["etag"].strip(chr(34))[1:]) + 1}"'


def copy_path(m):
    return FAMILY_PATH + family_copy._uid(m.key) + ".ics"


def copy_times(m):
    ics = m.icloud.events[copy_path(m)][1]
    fmt = "%Y%m%dT%H%M%SZ"
    return tuple(datetime.strptime(re.search(rf"{k}[^:]*:(\S+)", ics).group(1), fmt).replace(tzinfo=timezone.utc)
                 .astimezone(NY) for k in ("DTSTART", "DTEND"))


def row(m):
    return m.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (m.key,)).fetchone()


def at_coffee_time(m):
    """He has his coffee copy on Family, at the day's first time, as the sync made it."""
    sync(m)
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))


# -- 1. the Nov 27 sequence, and versions in place of remembered times (the review of Nov 27) ---------------

def card_move(m, start, end):
    out = m.tells("coffee tomorrow at 2:15", ask(change("gmail", "move", "coffee", dates="2026-11-12",
                                                        start=start.isoformat(), end=end.isoformat())))
    assert out["status"] == "executed"


def left_why(m):
    return [json.loads(r["detail"])["why"] for r in m.ledger.db.execute(
        "SELECT detail FROM events WHERE kind='family_copy_left_alone'")]


def puts(m):
    return [x for x in m.icloud.log if x[0] == "PUT" and x[1] == copy_path(m)]


def test_a_repeating_day_moved_by_hand_then_moved_by_harness_moves_its_copy_both_times(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY))       # followed him
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    assert m.gmail_times(INSTANCE) == ("14:15", "15:15")
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY))       # moved with it
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY)) and row(m)["state"] == "live"


def test_a_delayed_family_read_after_harnesss_write_is_taken_as_behind_and_the_copy_kept(m):
    """iCloud's listing still hands back the copy at the version before Harness's own write, just after it: that
    read is behind, not anyone's edit (Nov 27). The write goes over that version, is refused for it, and a read
    of the copy by its address shows the write landed: the copy is kept, nothing more is written."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    before = m.icloud.events[copy_path(m)]                                    # its version before the card
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.stale_report[copy_path(m)] = before                              # the listing is behind
    m.clock.advance(minutes=2)
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY))
    assert row(m)["state"] == "live" and not left_why(m)
    m.icloud.stale_report.clear()
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY)) and row(m)["state"] == "live"


def test_a_delayed_read_whose_write_was_lost_gets_the_copy_fixed(m):
    """The write's answer said it landed, but iCloud really still has the version before it: a read at that
    version, within minutes, is behind; the copy is written again over that version and brought to its event."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    before = m.icloud.events[copy_path(m)]
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.events[copy_path(m)] = before                                    # the write didn't hold
    m.clock.advance(minutes=3)
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY)) and row(m)["state"] == "live"


def test_a_human_moving_a_copy_back_to_a_time_harness_wrote_earlier_keeps_it_theirs(m):
    """13:45 is a time Harness itself once wrote on the copy. Someone puts the copy back there by hand: a new
    version, not the one before any write of Harness's own, so it's their edit and stays."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)                                                                  # Harness wrote 13:45
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))                    # and then 14:15
    m.clock.advance(minutes=1)
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(13, 45, day=DAY),
                                                      at(14, 45, day=DAY), m.clock()))
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY))
    assert row(m)["state"] == "hands_off" and left_why(m) == ["edited"]


def test_a_read_at_the_pre_write_version_long_after_the_write_is_someones_edit(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    before = m.icloud.events[copy_path(m)]
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.events[copy_path(m)] = before
    m.clock.advance(minutes=family_copy.LAG_FOR.seconds // 60 + 1)
    sync(m)
    assert row(m)["state"] == "hands_off"


def test_a_write_whose_answer_is_lost_is_decided_by_reading_the_copy_again(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.drop_response_next = True                                       # it lands; the answer is lost
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY))
    assert row(m)["start"] == at(13, 45, day=DAY).isoformat() and row(m)["state"] == "live"
    assert m.ledger.get_meta(family_copy.PROBLEM) == ""                       # decided, nothing to retry
    assert family_copy.version(m.ledger, m.key)["confirmed"] == m.icloud.events[copy_path(m)][0]
    assert len(puts(m)) == 2                                                 # the add, and the move once


def test_a_write_with_no_answer_that_didnt_land_is_written_again_after_the_read(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.force_status = 503                                              # not applied, no answer
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY)) and row(m)["state"] == "live"
    assert len(puts(m)) == 3


def test_a_stream_of_version_conflicts_stops_after_two_retries_and_is_said(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))

    def touch():                    # iCloud gives the copy a new version, same content, before every write
        etag, ics = m.icloud.events[copy_path(m)]
        m.icloud.seed(copy_path(m), ics)
        m.icloud.before_write = touch
    m.icloud.before_write = touch
    sync(m)
    m.icloud.before_write = None
    assert len(puts(m)) == 1 + 1 + family_copy.MAX_RETRIES                   # the add, the write, two retries
    assert row(m)["state"] == "hands_off" and left_why(m) == ["conflicts"]
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))         # nothing written over it
    sync(m)
    assert len(puts(m)) == 1 + 1 + family_copy.MAX_RETRIES


def test_a_conflict_whose_read_shows_someones_edit_leaves_the_copy_theirs(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: m.icloud.seed(copy_path(m), caldav.build_copy_ics(
        family_copy._uid(m.key), COPY_TITLE, at(16, day=DAY), at(17, day=DAY), m.clock()))
    sync(m)
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and row(m)["state"] == "hands_off"


def test_a_copy_someone_moved_to_a_time_harness_never_wrote_stays_theirs(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(16, day=DAY),
                                                      at(17, day=DAY), m.clock()))
    sync(m)
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and row(m)["state"] == "hands_off"


# -- 2. found by its event's own identity ------------------------------------------------------------

def test_the_copys_event_is_kept_by_series_and_original_start(m):
    at_coffee_time(m)
    assert family_copy.source_of(m.ledger, m.key) == (f"{SERIES}@google.com",
                                                      f"{ORIGINAL.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}")
    assert family_copy.google_id(*family_copy.source_of(m.ledger, m.key)) == INSTANCE


def test_a_copy_is_found_by_series_and_original_start_after_its_day_moved(m):
    """The day moved to the next day: the copy's day has no such event, and the request still finds it by the
    series and the day's original start, and brings the copy to it (never "I can't find that day")."""
    at_coffee_time(m)
    with m.ledger.tx() as db:                          # left alone, as the copy was on Nov 27
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    moved_by_hand(m, at(14, 15, day=DAY + 1), at(15, 15, day=DAY + 1))
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    said = " ".join(m.seen()) + out.get("said", "")
    assert "Change the event on Gmail" not in said and "can't find" not in said
    assert "Family copy of Coffee with Chris" in said
    if out["status"] != "executed":
        m.tap("Approve")
    assert copy_times(m) == (at(14, 15, day=DAY + 1), at(15, 15, day=DAY + 1))
    assert m.gmail_times(INSTANCE) == ("14:15", "15:15")                       # Gmail isn't written
    assert row(m)["state"] == "live"


# -- 3. a fix-the-copy request is a card -----------------------------------------------------------

def test_a_question_about_the_copy_with_cains_note_makes_a_card_never_change_it_on_gmail(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 45, day=DAY))
    with m.ledger.tx() as db:                          # the copy left behind, as on Nov 27
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    out = m.tells("why is the family mirrored event not updating",
                  result({"type": "no_action", "reason": "he asked a question"}),
                  suggestion="Fix the Family copy of his coffee tomorrow: Gmail has it at 2:15 PM.")
    assert out["status"] == "waiting for his tap", out
    text = m.seen()[-1]
    # Left alone, so a take-back part of its own (round 3 of the second review): it says approving discards it.
    assert ("Take back the Family copy of Coffee with Chris (left alone earlier, though nothing on it changed). "
            "Approving discards that and writes Harness's copy over it at 2:15 to 3:45 tomorrow, to match your Gmail "
            "calendar") in text
    assert "Cain" in text                                                     # marked as from his note
    assert "Change the event on Gmail" not in " ".join(m.seen())
    m.tap("Approve")
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 45, day=DAY))
    assert m.gmail_times(INSTANCE) == ("14:15", "15:45") and row(m)["state"] == "live"


def test_a_copy_whose_event_is_really_gone_is_offered_off_naming_it_and_why(m):
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] == "waiting for his tap", out
    assert "Take the Family copy \u201cAlex - Coffee\u201d on Nov 12 off: the Gmail event it copies was cancelled" \
        in m.seen()[-1]
    m.tap("Approve")
    assert copy_path(m) not in m.icloud.events


def test_a_copy_whose_event_cant_be_confirmed_gone_is_never_removed(m, monkeypatch):
    """Its Gmail event isn't in the listing, and the read of it by its id fails: unresolved, said plainly, and
    no removal offered."""
    at_coffee_time(m)
    del m.gmail.events[INSTANCE]
    monkeypatch.setattr(m.gmail, "look", lambda address, uid: ("unknown", None))
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] != "waiting for his tap", out
    said = " ".join(m.seen()) + out.get("said", "")
    assert "couldn't confirm whether the Gmail event the Family copy" in said and "Take the Family copy" not in said
    assert copy_path(m) in m.icloud.events


def test_a_removal_whose_event_came_back_before_the_tap_writes_nothing(m):
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    m.gmail.events[INSTANCE]["status"] = "confirmed"                         # back before his tap
    m.tap("Approve")
    assert copy_path(m) in m.icloud.events
    assert any("its Gmail event is on your Gmail calendar again" in x for x in m.seen())


# -- 3b. a fix card binds to what it saw (the review of Nov 27) ---------------------------------------------

def out_of_step(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))


def test_approval_after_the_gmail_event_moved_again_writes_nothing_and_sends_a_fresh_card(m):
    out_of_step(m)
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    assert out["status"] == "waiting for his tap"
    moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))                       # moved again before his tap
    m.tap("Approve")
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))         # not written
    assert m.gmail_times(INSTANCE) == ("16:00", "17:00")                       # and Gmail never moved back
    assert any("its Gmail event changed since your card. A fresh card follows" in x for x in m.seen())
    assert "Take back the Family copy of Coffee with Chris (left alone earlier, though nothing on it changed). " \
        "Approving discards that and writes Harness's copy over it at 4:00 to 5:00 tomorrow" in m.seen()[-1]
    m.tap("Approve")
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and m.gmail_times(INSTANCE) == ("16:00", "17:00")


def test_approval_after_the_copy_changed_writes_nothing_and_sends_a_fresh_card(m):
    out_of_step(m)
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(9, day=DAY),
                                                      at(10, day=DAY), m.clock()))
    m.tap("Approve")
    assert copy_times(m) == (at(9, day=DAY), at(10, day=DAY))
    assert any("that Family copy changed since your card. A fresh card follows" in x for x in m.seen())
    # Round 5: someone changed it on Family, so the fresh card is a take-back that says what changed.
    assert ("Take back the Family copy of Coffee with Chris (changed on Family: its start and its end). Approving "
            "discards that and writes Harness's copy over it at 2:15 to 3:15 tomorrow") in m.seen()[-1]


# -- 3c. scope: the copy he names, or all only when he says all ----------------------------------------------

def second(m, eid, title, start, hours=1):
    m.gmail.events[eid] = {"id": eid, "iCalUID": f"{eid}@google.com", "etag": '"e1"', "status": "confirmed",
                           "summary": title,
                           "organizer": {"email": GMAIL, "self": True},
                           "start": {"dateTime": start.isoformat(), "timeZone": TZ},
                           "end": {"dateTime": (start + timedelta(hours=hours)).isoformat(), "timeZone": TZ}}
    return family_copy._key(google_cal._occurrence(m.gmail.events[eid], GMAIL, ""))


def two_out_of_step(m, title="Dentist checkup"):
    key = second(m, "d0ai2c7kb1mbia2n4mdl3e6p10", title, at(9, day=DAY + 2))
    out_of_step(m)
    e = m.gmail.events["d0ai2c7kb1mbia2n4mdl3e6p10"]
    e["start"]["dateTime"], e["end"]["dateTime"] = at(10, day=DAY + 2).isoformat(), at(11, day=DAY + 2).isoformat()
    e["etag"] = '"e2"'
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (key,))
    return key


def changes_offered(m):
    """Every change offered on a card (several in one message come one to a card)."""
    return [c for r in m.ledger.db.execute("SELECT params_json FROM proposals") for c in json.loads(r[0])["changes"]]


def test_a_request_naming_one_copy_fixes_only_that_copy(m):
    other = two_out_of_step(m)
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    assert out["status"] == "waiting for his tap"
    assert [json.loads(c["copy"])["key"] for c in changes_offered(m)] == [m.key]
    assert "Dentist" not in m.seen()[-1]
    m.tap("Approve")
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY))
    path = FAMILY_PATH + family_copy._uid(other) + ".ics"
    assert "DTSTART:20261114T140000Z" in m.icloud.events[path][1]           # untouched: still 9 AM


def test_more_than_one_copy_fitting_is_asked_which(m):
    two_out_of_step(m)
    out = m.tells("why is the family mirrored event not updating", result({"type": "answer", "text": "Hm."}))
    assert out["status"] != "waiting for his tap" and not changes_offered(m)
    assert "Which one did you mean?" in out["said"]


def test_two_copies_his_words_both_fit_are_asked_which(m):
    two_out_of_step(m, title="Coffee with Sam")
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "Hm."}))
    assert not changes_offered(m) and "More than one Family copy fits" in out["said"]


def test_every_copy_is_offered_only_on_an_explicit_ask_for_all(m):
    other = two_out_of_step(m)
    out = m.tells("fix all the family copies, they're out of sync", result({"type": "answer", "text": "Hm."}))
    assert out["status"] == "waiting for his tap"
    assert sorted(json.loads(c["copy"])["key"] for c in changes_offered(m)) == sorted([m.key, other])
    assert "Take back the Family copy of Dentist checkup (left alone earlier, though nothing on it changed). " \
        "Approving discards that and writes Harness's copy over it at 10:00 to 11:00 Saturday" in m.seen()[-1]


def test_nothing_out_of_step_is_said_plainly(m):
    at_coffee_time(m)
    out = m.tells("is the family copy of my coffee wrong?", result({"type": "answer", "text": "No idea."}))
    assert "That Family copy matches its Gmail event now, so there's nothing to fix" in out["said"]


# -- 4. his own appointments, Harness's adds included ---------------------------------------------

def test_an_appointment_harness_added_gets_its_family_copy_but_its_blocks_dont():
    start = datetime(2026, 11, 27, 14, tzinfo=NY)

    def made(uid, title, organizer="harness@example-project.iam.gserviceaccount.com"):
        return ical.Occurrence(start, start + timedelta(hours=1), False, title, GMAIL, False, uid, "", (),
                               "12 Main St, Town, VA", organizer)
    massage = made("cm" + "a" * 32 + "@google.com", "Massage with Braden")
    errand = made("cm" + "b" * 32 + "@google.com", "Pick up the glasses")
    drive_block = made("hb" + "c" * 32 + "@google.com", "Busy (drive there)")
    busy = made("cm" + "d" * 32 + "@google.com", "Busy (hold)")
    assert word_for(massage) == "Massage" and word_for(errand) == "Appointment"
    assert word_for(drive_block) is None and word_for(busy) is None
    wants = plan([massage, errand, drive_block, busy], "Alex", TZ)
    assert sorted(w.title for w in wants.values()) == ["Alex - Appointment", "Alex - Massage"]
    # Someone else's invitation is still never copied, and his own massage is, by its word.
    assert word_for(made("x1", "Massage", organizer="someone@example.com")) is None
    assert word_for(made("x2", "Massage", organizer=GMAIL)) == "Massage"


def test_the_massage_harness_added_lands_on_family(m):
    out = m.tells("book a massage with Braden tomorrow at 2", ask(
        {**change("gmail", "add", "Massage with Braden", dates="", start=at(14, day=DAY).isoformat(),
                  end=at(15, day=DAY).isoformat()), "location": "12 Main St, Town, VA"}))
    if out["status"] != "executed":
        m.tap("Approve")
    added = [e for e in m.gmail.events.values() if e.get("summary") == "Massage with Braden"]
    assert added and added[0]["id"].startswith("cm")
    added[0]["organizer"] = {"email": "harness@example-project.iam.gserviceaccount.com"}   # as the key wrote it
    sync(m)
    copies = [v[1] for v in m.icloud.family().values() if "SUMMARY:Alex - Massage" in v[1]]
    assert len(copies) == 1


# -- 6. his own fix on Nov 27 stays --------------------------------------------------------------

def test_the_first_sync_leaves_a_copy_that_already_matches_its_event_alone(m):
    """He fixed the copy by hand (2:15 to 3:45 PM) to match Gmail: no write, and it stays where he put it."""
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 45, day=DAY))
    mine_ = caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(14, 15, day=DAY), at(15, 45, day=DAY),
                                  m.clock())
    m.icloud.seed(copy_path(m), mine_)
    etag = m.icloud.events[copy_path(m)][0]
    sync(m)
    assert m.icloud.events[copy_path(m)][0] == etag                          # not written
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 45, day=DAY)) and row(m)["state"] == "live"


def test_a_hand_fixed_copy_left_alone_stays_as_he_left_it(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(14, 15, day=DAY),
                                                      at(15, 45, day=DAY), m.clock()))
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    etag = m.icloud.events[copy_path(m)][0]
    sync(m)
    sync(m)
    assert m.icloud.events[copy_path(m)][0] == etag and row(m)["state"] == "hands_off"


# -- 4. drive blocks: on only by his tap (the review of Nov 27) -------------------------------------------

def target_of(rig, kind):
    return [r["target"] for r in rig.ledger.db.execute("SELECT target FROM choices WHERE kind=? ORDER BY created_at",
                                                       (kind,))]


def offers(rig):
    return [x for x in rig.bot.sent if x[1].startswith("Drive blocks: add them")]


def test_the_old_saved_dry_run_still_only_logs_until_his_tap_and_turn_off_stops_writing(drives, tmp_path):
    """His saved options still carry the old own_drive_dry_run: true, and the new setting's default is off. That
    changes nothing: his drives are only logged until he taps Turn on, on the one card that asks."""
    (tmp_path / "options.json").write_text(json.dumps({"own_drive_dry_run": True, "drive_dry_run": False,
                                                       "own_drive_days": 3}))
    drives.gm.own_dry_fn = lambda: drive_dry(drives.ledger, str(tmp_path))
    drives.maps.minutes[frozenset({"home", CLINIC})] = 31                    # rounds up to 45
    quiet_family(drives)
    a, b = when(drives, days=2, hour=10), when(drives, days=2, hour=11, minute=30)
    dentist = mine(drives, "Dentist", a, CLINIC)
    mine(drives, "Massage", b, PARK)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert [x[1] for x in offers(drives)] == [
        "Drive blocks: add them to your Gmail calendar from now on? Last week's dry run would have added 3."]
    assert [label for row in offers(drives)[0][2] for label, _ in row] == ["Turn on", "Keep logging"]
    go(drives)
    go(drives)
    assert len(offers(drives)) == 1                                          # once
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert drives.live.on_choice("drive_on", target_of(drives, "drive_on")[0]) == ""   # its receipt is the reply
    with drives.ledger.tx() as db:
        drives.ledger.release_held(db=db)
    drives.tick()
    receipt = [x for x in drives.bot.sent if x[1].startswith("Turned on")]
    assert receipt and [label for row in receipt[0][2] for label, _ in row] == ["Turn off"]
    assert (tmp_path / "options.json").read_text().count("own_drive_dry_run") == 1   # the options file untouched
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", a - 45 * M, a, ""),                           # from home, a quarter hour up
        ("Busy (drive there)", b - 15 * M, b, ""),                           # one drive between the places
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]                   # and the last one home
    assert drives.live.on_choice("drive_on", target_of(drives, "drive_on")[0]).startswith("Already settled")
    assert drives.live.on_choice("drive_off", target_of(drives, "drive_off")[0]) == ""   # its receipt is the reply
    with drives.ledger.tx() as db:
        drives.ledger.release_held(db=db)
    drives.tick()
    back = [x for x in drives.bot.sent if x[1].startswith("Drive blocks are back to logging only")]
    assert back and [label for row in back[0][2] for label, _ in row] == ["Turn on"]   # the way back (round 4)
    drives.feeds.window.occurrences.remove(dentist)
    later = when(drives, days=2, hour=15)
    mine(drives, "Dentist", later, CLINIC)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", later - 45 * M, later, "") not in blocks(drives)   # Turn off: nothing new
    assert len(offers(drives)) == 1                                          # and not asked again


def test_drives_live_before_the_update_stay_dry_and_the_turn_on_card_says_so(drives, tmp_path):
    """Round 3: he had them live (both old settings a plain false). The first read still leaves them in the dry
    run; the one card says they were on and Turn on is the only way live."""
    (tmp_path / "options.json").write_text(json.dumps({"own_drive_dry_run": False, "drive_dry_run": False}))
    drives.gm.own_dry_fn = lambda: drive_dry(drives.ledger, str(tmp_path))
    drives.maps.minutes[frozenset({"home", CLINIC})] = 31
    quiet_family(drives)
    a = when(drives, days=2, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    cards = [x for x in drives.bot.sent if x[1].startswith("Drive blocks were on before this update")]
    assert len(cards) == 1
    assert cards[0][1].startswith("Drive blocks were on before this update; tap Turn on to keep them on.")
    assert [label for row in cards[0][2] for label, _ in row] == ["Turn on", "Keep logging"]
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert drives.live.on_choice("drive_on", target_of(drives, "drive_on")[0]) == ""
    go(drives)
    go(drives)
    assert ("Busy (drive there)", a - 45 * M, a, "") in blocks(drives)


def test_his_drives_follow_their_events_once_turned_on(drives):
    drives.gm.own_dry_fn = lambda: False
    drives.maps.minutes[frozenset({"home", CLINIC})] = 31
    quiet_family(drives)
    a = when(drives, days=2, hour=10)
    dentist = mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", a - 45 * M, a, "") in blocks(drives)
    drives.feeds.window.occurrences.remove(dentist)                         # moved, its drives go with it
    later = when(drives, days=2, hour=15)
    moved = mine(drives, "Dentist", later, CLINIC)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", later - 45 * M, later, "") in blocks(drives)
    assert ("Busy (drive there)", a - 45 * M, a, "") not in blocks(drives)
    drives.feeds.window.occurrences.remove(moved)                           # cancelled, they come off
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[1] in (later - 45 * M, later + 60 * M)]


def test_the_dry_run_switch_still_turns_them_back_to_the_log(drives, tmp_path):
    (tmp_path / "options.json").write_text(json.dumps({"drive_dry_run": True}))
    with drives.ledger.tx() as db:
        drives.ledger.set_meta(drive_cards.LIVE, "on", db)
    drives.gm.own_dry_fn = lambda: drive_dry(drives.ledger, str(tmp_path))
    quiet_family(drives)
    mine(drives, "Dentist", when(drives, days=2, hour=10), CLINIC)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert drives.ledger.get_meta(drive_cards.LIVE) == "off"


# -- 5. a note naming a drive block makes a card ------------------------------------------------------

def test_a_question_with_a_drive_block_note_makes_a_card_marked_from_cain(m):
    cards = drive_cards.DriveCards(m.ledger, tz=TZ)
    m.c.runner.drive_card = lambda chat, job_id=None: cards.note_card(chat, planned=True, dry=True, now=m.clock(),
                                                                      job_id=job_id)
    out = m.tells("why is there no travel time", result({"type": "answer", "text": "They're in a dry run."}),
                  suggestion="He wants the drive blocks around his massage tomorrow.")
    assert out["status"] == "card", out
    card = m.seen()[-1]
    assert card.startswith("From Cain's note on your message, about your drive blocks:")
    assert {"Write them", "Keep logging"} <= set(m.labels())


def test_write_them_on_the_card_writes_his_drives_while_the_dry_run_setting_stays_on(drives, tmp_path):
    (tmp_path / "options.json").write_text(json.dumps({"drive_dry_run": False}))
    drives.gm.own_dry_fn = lambda: drive_dry(drives.ledger, str(tmp_path))
    quiet_family(drives)
    a = when(drives, days=2, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert drives.gm.drive_note_card(drives.live.chat_id)
    bid = target_of(drives, "drive_write")[0]
    assert drives.live.on_choice("drive_write", bid) == ""                  # its receipt, with Turn off
    assert drives.live.on_choice("drive_write", bid).startswith("Already settled")
    go(drives)
    go(drives)
    assert ("Busy (drive there)", a - 30 * M, a, "") in blocks(drives)
    assert drives.live.drive_cards.written_by_tap()


# -- round 3 (the review of Nov 27, round 2's findings) -------------------------------------------------------

def edited_on_family(m, start, end, extra="LOCATION:Corner Cafe"):
    """Someone on Family edits the copy: its times kept or changed, and a line Harness never writes."""
    ics = caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, start, end, m.clock())
    m.icloud.seed(copy_path(m), ics.replace("END:VEVENT", f"{extra}\r\nEND:VEVENT", 1))


def edit_before_the_next_fetch(m, start, end, extra="LOCATION:Corner Cafe"):
    """A family edit lands after Harness's write and before its read of the copy by its address."""
    real = m.client.fetch

    def fetch(href):
        m.client.fetch = real
        edited_on_family(m, start, end, extra)
        return real(href)
    m.client.fetch = fetch


def test_a_lost_answer_then_a_family_edit_before_the_read_is_never_taken_as_harnesss_own(m):
    """Round 3, item 2: the write lands, its answer is lost, and someone adds a place to the copy (same times and
    title as Harness wrote) before Harness reads it by its address. That version isn't Harness's own: the copy is
    left as theirs, and the next syncs write nothing over the edit, even once its event moves."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.drop_response_next = True
    edit_before_the_next_fetch(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    edited = m.icloud.events[copy_path(m)]
    assert "LOCATION:Corner Cafe" in edited[1]
    assert family_copy.version(m.ledger, m.key).get("confirmed") != edited[0]
    n = len(puts(m))
    sync(m)
    moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    assert len(puts(m)) == n and m.icloud.events[copy_path(m)] == edited          # nothing over the edit
    assert row(m)["state"] == "hands_off"


def test_a_lost_answer_then_someone_putting_the_copy_back_before_the_read_is_left_theirs(m):
    """Round 3, item 2: the write to 1:45 lands, its answer is lost, and someone on Family puts the copy back to
    8:30 (what Harness had written before) before the read by its address. That's a new version with other content
    than what was written: their edit. Nothing is written over it, then or at the next syncs."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.drop_response_next = True
    real = m.client.fetch

    def fetch(href):
        m.client.fetch = real
        m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, ORIGINAL,
                                                          ORIGINAL + timedelta(hours=1), m.clock()))
        return real(href)
    m.client.fetch = fetch
    sync(m)
    edited = m.icloud.events[copy_path(m)]
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1)) and len(puts(m)) == 2
    assert family_copy.version(m.ledger, m.key).get("confirmed") != edited[0]
    sync(m)
    sync(m)
    assert m.icloud.events[copy_path(m)] == edited and len(puts(m)) == 2 and row(m)["state"] == "hands_off"


def test_a_family_edit_keeping_harnesss_times_is_never_confirmed_as_its_own_by_a_sync(m):
    """The listing shows the copy at Harness's times and title, with a place someone added: not as Harness wrote
    it, so that version is never recorded as Harness's own and a later move of its event writes nothing."""
    at_coffee_time(m)
    edited_on_family(m, ORIGINAL, ORIGINAL + timedelta(hours=1))
    edited = m.icloud.events[copy_path(m)]
    sync(m)
    assert family_copy.version(m.ledger, m.key).get("confirmed") != edited[0]
    moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    assert m.icloud.events[copy_path(m)] == edited and row(m)["state"] == "hands_off"


def test_a_lost_fix_card_write_then_a_family_edit_is_left_theirs(m):
    """The fix card's write lands and its answer is lost; someone adds a place before the read. Only content as
    Harness wrote it makes the read's version Harness's own, so this one isn't, and the sync leaves it."""
    out_of_step(m)
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    m.icloud.drop_response_next = True
    edit_before_the_next_fetch(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.tap("Approve")
    edited = m.icloud.events[copy_path(m)]
    for _ in range(3):
        m.clock.advance(minutes=2)
        m.c.tick()
    assert family_copy.version(m.ledger, m.key).get("confirmed") != edited[0]
    sync(m)
    moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    assert m.icloud.events[copy_path(m)] == edited


def test_an_undecided_write_expires_after_an_hour_and_the_old_version_is_no_longer_lag(m):
    """Round 3, item 3: a write of Harness's own left undecided an hour is settled by the copy's content. Here the
    copy still shows the version from before it with other content: someone's edit, not a late read."""
    at_coffee_time(m)
    etag = m.icloud.events[copy_path(m)][0]
    with m.ledger.tx() as db:                       # a write sent over that version and never decided
        db.execute("UPDATE family_copies SET start=?, end=? WHERE key=?",
                   (at(13, 45, day=DAY).isoformat(), at(14, 45, day=DAY).isoformat(), m.key))
        family_copy.note_write(m.ledger, m.key, etag, landed=False, db=db,
                               wrote=(COPY_TITLE, at(13, 45, day=DAY), at(14, 45, day=DAY)))
    assert family_copy.lagging(m.ledger, m.key, etag)
    m.clock.advance(minutes=61)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert not family_copy.lagging(m.ledger, m.key, etag)
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1)) and row(m)["state"] == "hands_off"


def test_an_undecided_write_found_as_written_after_an_hour_is_harnesss_own(m):
    at_coffee_time(m)
    etag = m.icloud.events[copy_path(m)][0]
    with m.ledger.tx() as db:                       # undecided, though its content is what's there
        family_copy.note_write(m.ledger, m.key, "\"older\"", landed=False, db=db,
                               wrote=(COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1)), prior_body="", intended="")
    m.clock.advance(minutes=61)
    sync(m)
    d = family_copy.version(m.ledger, m.key)
    assert d["pending"]["landed"] and d["confirmed"] == etag and row(m)["state"] == "live"


def test_a_family_edit_between_the_approval_read_and_the_write_is_refused_and_a_fresh_card_follows(m):
    """Round 3, item 4: the fix card's write carries If-Match on the copy's version read at approval. An edit
    landing between that read and the write is refused by Family, nothing is written, and a fresh card comes."""
    out_of_step(m)
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    cards = len(m.seen())
    approval_read = m.icloud.events[copy_path(m)][0]                               # the version read at approval

    def edit():
        m.icloud.before_write = None
        m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(9, day=DAY),
                                                          at(10, day=DAY), m.clock()))
    m.icloud.before_write = edit
    m.tap("Approve")
    sent = [x for x in m.icloud.log if x[0] == "PUT" and x[1] == copy_path(m)]
    assert sent and sent[-1][2].get("If-Match") == approval_read                     # over the version just read
    assert copy_times(m) == (at(9, day=DAY), at(10, day=DAY))                        # and refused
    assert any("changed since" in x and "fresh card" in x for x in m.seen()[cards:])
    assert "Coffee with Chris to 2:15 to 3:15 tomorrow" in m.seen()[-1]                # the fresh card


# -- round 4 (the review of Nov 27, round 3's findings): Harness's own is an allowlist of what it writes ------

ALARM = "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM"
ADDED = {"an alarm": ALARM, "an attendee": "ATTENDEE:mailto:chris@example.com",
         "a link": "URL:https://example.com/coffee", "a status": "STATUS:TENTATIVE",
         "a repeat": "RRULE:FREQ=WEEKLY;COUNT=3", "a place": "LOCATION:Corner Cafe",
         "notes": "DESCRIPTION:Bring the book", "travel time": "X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT15M",
         "a category": "CATEGORIES:Family"}
SECOND = ("BEGIN:VEVENT\r\nUID:someone-else-1\r\nDTSTAMP:20261111T120000Z\r\nDTSTART:20261112T200000Z\r\n"
          "DTEND:20261112T210000Z\r\nSUMMARY:Alex - Coffee\r\nEND:VEVENT\r\n")


def with_added(ics, extra):
    return ics.replace("END:VEVENT", f"{extra}\r\nEND:VEVENT", 1)


def icloud_way(ics):
    """As iCloud keeps a copy it stored: its own lines, stamps and a default alarm marked as one, the times in
    the zone's own form, and a long line folded."""
    from test_calendar_change import ICLOUD_OWN

    def local(x):
        moment = datetime.strptime(x.group(2), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).astimezone(NY)
        return f"{x.group(1)};TZID={TZ}:{moment:%Y%m%dT%H%M%S}"
    out = re.sub(r"(DTSTART|DTEND):(\d{8}T\d{6}Z)", local, ics)
    out = out.replace("SUMMARY:Alex - Coffee", "SUMMARY:Alex -\r\n  Coffee")
    return out.replace("END:VEVENT", ICLOUD_OWN + "SEQUENCE:1\r\nEND:VEVENT", 1)


def test_the_allowlist_holds_on_icloud_rewrites_and_fails_on_anything_added():
    start, end = at(8, 30, day=DAY), at(9, 30, day=DAY)
    ics = caldav.build_copy_ics("hx-1", COPY_TITLE, start, end, datetime(2026, 11, 11, tzinfo=timezone.utc))
    assert family_copy.content_is(ics, "hx-1", COPY_TITLE, start, end)
    assert family_copy.content_is(icloud_way(ics), "hx-1", COPY_TITLE, start, end)    # iCloud's own: not an edit
    assert caldav.copy_holds_only_ours(icloud_way(ics), "hx-1")
    for what, extra in ADDED.items():
        for kept in (ics, icloud_way(ics)):
            assert not family_copy.content_is(with_added(kept, extra), "hx-1", COPY_TITLE, start, end), what
            assert not caldav.copy_holds_only_ours(with_added(kept, extra), "hx-1"), what
    two = ics.replace("END:VCALENDAR", SECOND + "END:VCALENDAR")
    assert not family_copy.content_is(two, "hx-1", COPY_TITLE, start, end)              # a second event
    assert not family_copy.content_is(ics.replace(f"{caldav.MARKER}:1\r\n", ""), "hx-1", COPY_TITLE, start, end)
    assert not family_copy.content_is(ics, "hx-1", COPY_TITLE, start, end + timedelta(minutes=15))
    assert not family_copy.content_is(ics, "hx-1", "Alex - Coffee!", start, end)
    assert not family_copy.content_is(ics, "hx-2", COPY_TITLE, start, end)


def test_the_moved_coffee_event_moves_its_untouched_family_copy_within_a_minute(m):
    """Nov 27, Dane + Chris coffee: its Gmail event moved and its Family copy stayed behind. The copy, as iCloud
    keeps it (its own lines and a new version, times in the zone's form), is untouched: one read after the move,
    a minute later, brings it to the new time."""
    at_coffee_time(m)
    m.icloud.seed(copy_path(m), icloud_way(m.icloud.events[copy_path(m)][1]))          # iCloud's own rewrite
    sync(m)
    assert row(m)["state"] == "live" and not left_why(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.clock.advance(seconds=60)
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY)) and row(m)["state"] == "live"
    assert len(puts(m)) == 2


@pytest.mark.parametrize("what", sorted(ADDED))
def test_a_copy_with_anything_added_is_never_rewritten_and_hes_told_once(m, what):
    at_coffee_time(m)
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ADDED[what]))
    edited = m.icloud.events[copy_path(m)]
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    sync(m)
    assert m.icloud.events[copy_path(m)] == edited and len(puts(m)) == 1                  # only the add, ever
    assert row(m)["state"] == "hands_off" and left_why(m) == ["edited"]
    line = m.copier.digest_line()
    assert "Left alone, yours to keep now: Coffee Nov 12 (changed on Family). I won't change those copies again." \
        in line
    m.clock.advance(minutes=1)
    with m.ledger.tx() as db:                                                            # the digest went out
        m.ledger.set_meta("last_digest_at", iso(m.clock()), db)
    sync(m)
    assert "yours to keep" not in m.copier.digest_line()                                 # once


def test_an_alarm_added_as_harness_writes_is_refused_and_never_written_over(m):
    """Someone adds an alarm to the copy just as Harness writes it: Family refuses the write for its version, and
    the read after shows the copy with the alarm. Not as Harness had it, so it's theirs: no retry over it."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))

    def alarm():
        m.icloud.before_write = None
        m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    m.icloud.before_write = alarm
    sync(m)
    assert ALARM in m.icloud.events[copy_path(m)][1] and copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))
    assert len(puts(m)) == 2 and row(m)["state"] == "hands_off" and left_why(m) == ["changed"]
    sync(m)
    assert len(puts(m)) == 2


def test_a_write_that_didnt_land_and_an_alarm_added_before_the_read_is_never_written_over(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.force_status = 503                                              # not applied, no answer
    edit_before_the_next_fetch(m, ORIGINAL, ORIGINAL + timedelta(hours=1), extra=ALARM)
    sync(m)
    m.icloud.force_status = None
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"
    n = len(puts(m))
    sync(m)
    assert len(puts(m)) == n


def test_a_read_at_the_pre_write_version_with_an_alarm_added_is_never_taken_as_behind(m):
    """Within minutes of a write of Harness's own, a read at the version it went over counts as behind only while
    it holds exactly what Harness had there: one with an alarm is someone's edit, and no rewrite goes over it."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    etag, ics = m.icloud.events[copy_path(m)]
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.events[copy_path(m)] = (etag, with_added(ics, ALARM))           # that version, with an alarm
    n = len(puts(m))
    m.clock.advance(minutes=2)
    sync(m)
    assert len(puts(m)) == n and ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"


def undecided(m, start, end):
    """A write of Harness's own sent over the copy's current version, from its first time to these, and never
    decided; the record moved on to these times, as a change he asked for leaves it."""
    etag, body = m.icloud.events[copy_path(m)]
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET start=?, end=? WHERE key=?", (start.isoformat(), end.isoformat(), m.key))
        family_copy.note_write(m.ledger, m.key, etag, landed=False, db=db, wrote=(COPY_TITLE, start, end),
                               before=(COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1)), prior_body=body,
                               intended=caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, start, end,
                                                              m.clock()))
    return etag


def test_an_expired_write_that_never_landed_is_written_once_more_over_its_version(m):
    """The decision table: the same version, holding exactly what Harness had there before the write. It never
    landed: one conditional rewrite, over that version."""
    at_coffee_time(m)
    etag = undecided(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.clock.advance(minutes=61)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    sent = puts(m)
    assert len(sent) == 2 and sent[-1][2].get("If-Match") == etag
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY)) and row(m)["state"] == "live"
    assert family_copy.version(m.ledger, m.key)["pending"]["landed"]
    sync(m)
    assert len(puts(m)) == 2


def test_an_expired_write_at_a_new_version_holding_the_old_content_is_someones_edit(m):
    """The decision table: a new version holding what Harness had before the write is someone putting it back."""
    at_coffee_time(m)
    undecided(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, ORIGINAL,
                                                      ORIGINAL + timedelta(hours=1), m.clock()))
    m.clock.advance(minutes=61)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert len(puts(m)) == 1 and row(m)["state"] == "hands_off" and left_why(m) == ["edited"]


def test_an_expired_write_found_with_an_alarm_added_is_someones_edit(m):
    at_coffee_time(m)
    undecided(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    etag, ics = m.icloud.events[copy_path(m)]
    m.icloud.events[copy_path(m)] = (etag, with_added(ics, ALARM))
    m.clock.advance(minutes=61)
    sync(m)
    assert len(puts(m)) == 1 and row(m)["state"] == "hands_off"


def feed_now(m):
    """What his Gmail calendar's feed shows at this moment, kept for a sync that runs later."""
    events = [{"iCalUID": f"{e['id']}@google.com", **e} for e in m.gmail.events.values()
              if e.get("status") != "cancelled"]
    m.feeds.window.occurrences = [o for o in (google_cal._occurrence(e, GMAIL, "") for e in events) if o is not None]
    m.feeds.generation += 1


def test_the_gmail_event_is_read_again_right_before_the_family_write_and_its_newer_times_win(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    feed_now(m)
    moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))                       # moved again, the feed is behind
    m.copier._sync()
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and len(puts(m)) == 2


def test_a_gmail_event_cancelled_since_the_feed_gets_no_family_write(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    feed_now(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.copier._sync()
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1)) and len(puts(m)) == 1


def test_a_gmail_event_that_cant_be_read_again_gets_no_family_write_and_its_said(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.gmail.down = True
    sync(m)
    m.gmail.down = False
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1)) and len(puts(m)) == 1
    assert "couldn't read a Gmail event again" in m.ledger.get_meta(family_copy.PROBLEM)
    assert row(m)["state"] == "live"
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY))


def test_a_404_for_the_copys_event_is_never_taken_as_deleted(m):
    """Only 410 Gone or the event answered as cancelled is a deletion: a 404 says nothing, so no removal."""
    at_coffee_time(m)
    del m.gmail.events[INSTANCE]                                             # read by its id: 404
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] != "waiting for his tap", out
    assert "Take the Family copy" not in " ".join(m.seen()) and copy_path(m) in m.icloud.events


def test_a_410_for_the_copys_event_offers_it_off_as_deleted(m):
    at_coffee_time(m)
    del m.gmail.events[INSTANCE]
    m.gmail.gone_410 = {INSTANCE}
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] == "waiting for his tap", out
    assert "the Gmail event it copies was deleted" in m.seen()[-1]


def test_google_answers_by_id_count_as_deleted_only_on_410_or_cancelled(g):
    g.google.shared = True
    g.google.events["evt1"] = {"id": "evt1", "status": "confirmed", "summary": "Coffee", "etag": '"1"',
                               "start": {"dateTime": "2026-11-12T08:30:00-05:00"},
                               "end": {"dateTime": "2026-11-12T09:30:00-05:00"}}
    assert g.client.look_by_id(GMAIL_G, "evt1")[0] == "ok"
    assert g.client.look_by_id(GMAIL_G, "nothere1") == ("missing", None)              # 404: never "deleted"
    assert g.google.queries[-1][1].get("showDeleted") == "true"                         # asked with showDeleted
    g.google.events["evt1"]["status"] = "cancelled"
    assert g.client.look_by_id(GMAIL_G, "evt1")[0] == "deleted"
    g.google.fail["GET"] = 410
    assert g.client.look_by_id(GMAIL_G, "evt1") == ("deleted", None)
    g.google.fail["GET"] = 500
    assert g.client.look_by_id(GMAIL_G, "evt1") == ("unknown", None)


def test_a_copys_retries_are_capped_in_all_not_only_per_hour(m):
    at_coffee_time(m)
    d = family_copy.version(m.ledger, m.key)
    d["retried"] = family_copy.MAX_TOTAL_RETRIES - 1                         # retried over earlier hours
    family_copy._set_version(m.ledger, m.key, d)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))

    def touch():
        etag, ics = m.icloud.events[copy_path(m)]
        m.icloud.seed(copy_path(m), ics)
        m.icloud.before_write = touch
    m.icloud.before_write = touch
    sync(m)
    m.icloud.before_write = None
    assert len(puts(m)) == 1 + 1 + 1                                         # the add, the write, one retry
    assert row(m)["state"] == "hands_off" and left_why(m) == ["conflicts"]
    assert family_copy.version(m.ledger, m.key)["retried"] == family_copy.MAX_TOTAL_RETRIES


def test_a_fix_card_for_a_copy_with_an_alarm_added_writes_nothing(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    edited = m.icloud.events[copy_path(m)]
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    if "Approve" in m.labels() and "Take back" not in m.seen()[-1]:
        m.tap("Approve")
    assert m.icloud.events[copy_path(m)] == edited
    assert row(m)["state"] == "hands_off"


def test_keep_logging_on_the_turn_on_card_leaves_a_way_back(drives, tmp_path):
    """Round 4: Keep logging on the one Turn on card isn't the end of it. Its reply carries Turn on, and that
    tap turns them on as the card's own would."""
    (tmp_path / "options.json").write_text(json.dumps({"drive_dry_run": False}))
    drives.gm.own_dry_fn = lambda: drive_dry(drives.ledger, str(tmp_path))
    quiet_family(drives)
    a = when(drives, days=2, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert len(offers(drives)) == 1
    assert drives.live.on_choice("drive_leave", target_of(drives, "drive_leave")[0]) == ""
    with drives.ledger.tx() as db:
        drives.ledger.release_held(db=db)
    drives.tick()
    back = [x for x in drives.bot.sent if x[1].startswith("Leaving them as they are: drive blocks stay logging")]
    assert back and [label for row in back[0][2] for label, _ in row] == ["Turn on"]
    assert drives.live.on_choice("drive_on", target_of(drives, "drive_on")[-1]) == ""
    assert drive_cards.live_on(drives.ledger)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", a - 30 * M, a, "") in blocks(drives)


# -- 5. round 5 of the review of Nov 27 -------------------------------------------------------------------------
# Each numbered item of the round's list, with its own tests. The iCloud shapes are modelled, not recorded: a
# cloud build can't reach a real shared calendar (see the pull request's "Not verified").

def retouched(m, *, keep_version=False, **subs):
    """Someone edits the copy on Family: each named line (SUMMARY, DTSTART, DTEND) given a new value, nothing
    else. keep_version: the listing still gives the old version (a read at that version)."""
    etag, ics = m.icloud.events[copy_path(m)]
    for name, value in subs.items():
        ics, n = re.subn(rf"(?m)^{name}[;:][^\r\n]*(?=\r?\n)", f"{name}:{value}", ics)
        assert n == 1, name
    if keep_version:
        m.icloud.events[copy_path(m)] = (etag, ics)
    else:
        m.icloud.seed(copy_path(m), ics)
    return m.icloud.events[copy_path(m)]


def utc(when):
    return f"{when.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"


ONLY = {"title": {"SUMMARY": "Alex - Coffee with Chris"},
        "start": {"DTSTART": utc(ORIGINAL - timedelta(minutes=15))},
        "end": {"DTEND": utc(ORIGINAL + timedelta(minutes=75))}}


def copy_writes(m):
    return [x for x in m.icloud.log if x[0] in ("PUT", "DELETE") and x[1] == copy_path(m)]


# 1. The baseline is what Harness last wrote, from its own record, never the copy.

@pytest.mark.parametrize("what", sorted(ONLY))
def test_1_a_change_of_only_the_title_start_or_end_makes_the_copy_hands_off_at_sync(m, what):
    at_coffee_time(m)
    edited = retouched(m, **ONLY[what])
    sync(m)
    sync(m)
    assert row(m)["state"] == "hands_off" and left_why(m) == ["edited"]
    assert m.icloud.events[copy_path(m)] == edited and len(copy_writes(m)) == 1        # only the add


@pytest.mark.parametrize("what", sorted(ONLY))
def test_1_revive_leaves_a_copy_whose_title_start_or_end_was_changed(m, what):
    at_coffee_time(m)
    with m.ledger.tx() as db:                               # left alone earlier, and the one revive still owed
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
        db.execute("DELETE FROM meta WHERE key=?", (family_copy.REVIVED,))
    retouched(m, **ONLY[what])
    sync(m)
    assert row(m)["state"] == "hands_off" and len(copy_writes(m)) == 1


def test_1_revive_takes_back_a_copy_still_exactly_as_harness_wrote_it(m):
    at_coffee_time(m)
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
        db.execute("DELETE FROM meta WHERE key=?", (family_copy.REVIVED,))
    sync(m)
    assert row(m)["state"] == "live"


@pytest.mark.parametrize("what", sorted(ONLY))
def test_1_settling_an_undecided_write_makes_a_copy_with_one_line_changed_hands_off(m, what):
    at_coffee_time(m)
    undecided(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    retouched(m, keep_version=True, **ONLY[what])           # the version the write went over, one line changed
    m.clock.advance(minutes=61)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert row(m)["state"] == "hands_off" and left_why(m) == ["edited"] and len(copy_writes(m)) == 1


def test_1_the_baseline_comes_from_harnesss_record_not_from_its_row_or_the_copy(m):
    """Even if the row were brought to what the copy now shows, the copy is judged against what Harness wrote."""
    at_coffee_time(m)
    retouched(m, SUMMARY="Alex - Coffee with Chris")
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET title=? WHERE key=?", ("Alex - Coffee with Chris", m.key))
    assert family_copy.baseline(m.ledger, m.key)[0] == COPY_TITLE
    sync(m)
    assert row(m)["state"] == "hands_off"


# 2. A fix card matches the whole copy against Harness's last write before a move or a removal.

@pytest.mark.parametrize("what", sorted(ONLY))
def test_2_a_fix_card_refuses_a_copy_whose_title_or_times_were_changed(m, what):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    edited = retouched(m, **ONLY[what])
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    if "Approve" in m.labels() and "Take back" not in m.seen()[-1]:
        m.tap("Approve")
    assert m.icloud.events[copy_path(m)] == edited and row(m)["state"] == "hands_off"


def test_2_a_fix_cards_move_checks_the_whole_copy_again_just_before_it_writes(m):
    """Changed between the card and the tap, at the same version (as a listing can show it): nothing is sent."""
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    assert out["status"] == "waiting for his tap"
    n = len(copy_writes(m))
    edited = retouched(m, keep_version=True, SUMMARY="Alex - Coffee with Chris")
    m.tap("Approve")
    assert m.icloud.events[copy_path(m)] == edited and len(copy_writes(m)) == n
    assert row(m)["state"] == "hands_off"


def test_2_a_fix_cards_removal_checks_the_whole_copy_again_just_before_it_deletes(m):
    at_coffee_time(m)
    del m.gmail.events[INSTANCE]
    m.gmail.gone_410 = {INSTANCE}
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] == "waiting for his tap"
    edited = retouched(m, keep_version=True, DTEND=utc(ORIGINAL + timedelta(minutes=90)))
    m.tap("Approve")
    assert m.icloud.events[copy_path(m)] == edited and row(m)["state"] == "hands_off"


# 3. No blanket X- exemption; a default alarm only with iCloud's own payload.

BASE_ICS = caldav.build_copy_ics("hx-1", COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1),
                                 datetime(2026, 11, 11, tzinfo=timezone.utc))


def ours(ics):
    return family_copy.content_is(ics, "hx-1", COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1))


@pytest.mark.parametrize("line", ["X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
                                  "X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT20M",
                                  "X-APPLE-TRAVEL-START;ROUTING=CAR:20261112T130000Z",
                                  "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Corner Cafe:geo:40.7,-74.0",
                                  "X-SOMETHING-NEW:1", "X-APPLE-SOMETHING:1", "X-MICROSOFT-CDO-BUSYSTATUS:BUSY"])
def test_3_every_x_line_but_the_named_ones_counts_as_an_edit(line):
    assert not ours(with_added(BASE_ICS, line))
    assert caldav.copy_differences(with_added(BASE_ICS, line), "hx-1", COPY_TITLE, ORIGINAL,
                                   ORIGINAL + timedelta(hours=1)) == [re.split(r"[;:]", line)[0]]


def test_3_only_the_named_icloud_bookkeeping_lines_are_set_aside():
    assert sorted(caldav.COPY_SERVER_LINES) == ["X-APPLE-CREATOR-IDENTITY", "X-APPLE-CREATOR-TEAM-IDENTITY"]
    assert ours(with_added(BASE_ICS, "X-APPLE-CREATOR-IDENTITY:com.apple.calendar"))
    assert ours(with_added(BASE_ICS, "X-APPLE-CREATOR-TEAM-IDENTITY:com.apple.calendar"))
    assert ours(with_added(BASE_ICS, "LAST-MODIFIED:20261111T120000Z\r\nCREATED:20261111T120000Z\r\nSEQUENCE:2"))


def test_3_a_default_alarm_is_set_aside_only_with_icloud_s_own_payload():
    from test_calendar_change import DEFAULT_15, NO_ALERT
    assert ours(with_added(BASE_ICS, NO_ALERT.rstrip("\r\n")))                       # iCloud's "none"
    assert ours(with_added(BASE_ICS, DEFAULT_15.rstrip("\r\n")))                     # the default 15-minute alert
    marked_30 = DEFAULT_15.replace("TRIGGER:-PT15M", "TRIGGER:-PT30M")
    marked_sound = DEFAULT_15.replace("ACTION:DISPLAY", "ACTION:AUDIO")
    unmarked = NO_ALERT.replace("X-APPLE-DEFAULT-ALARM:TRUE\r\n", "")
    marked_note = DEFAULT_15.replace("DESCRIPTION:Reminder", "DESCRIPTION:Bring the book")
    for alarm in (marked_30, marked_sound, unmarked, marked_note):
        assert not ours(with_added(BASE_ICS, alarm.rstrip("\r\n"))), alarm


# 4. TRANSP:OPAQUE written; a time zone block doesn't break "one plain event".

def test_4_harness_writes_transp_opaque_and_a_fresh_copy_reads_as_written():
    assert "\r\nTRANSP:OPAQUE\r\n" in BASE_ICS and ours(BASE_ICS)
    assert ours(BASE_ICS.replace("TRANSP:OPAQUE\r\n", ""))                          # RFC 5545's default
    assert not ours(BASE_ICS.replace("TRANSP:OPAQUE", "TRANSP:TRANSPARENT"))         # free, not busy: an edit


VTIMEZONE = ("BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\n"
             "TZOFFSETTO:-0400\r\nDTSTART:20070311T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZNAME:EDT\r\n"
             "END:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nDTSTART:20071104T020000\r\n"
             "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nTZNAME:EST\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")


def test_4_a_vtimezone_block_with_times_in_its_zone_still_reads_as_written():
    local = icloud_way(BASE_ICS).replace("BEGIN:VEVENT", VTIMEZONE + "BEGIN:VEVENT", 1)
    assert "DTSTART;TZID=America/New_York" in local and ours(local)
    assert caldav.copy_holds_only_ours(local, "hx-1")
    todo = local.replace("END:VCALENDAR", "BEGIN:VTODO\r\nUID:t1\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR")
    assert not ours(todo)                                                           # anything else beside it


def test_4_a_fresh_copy_as_icloud_keeps_it_follows_its_event(m):
    at_coffee_time(m)
    etag, ics = m.icloud.events[copy_path(m)]
    m.icloud.seed(copy_path(m), icloud_way(ics).replace("BEGIN:VEVENT", VTIMEZONE + "BEGIN:VEVENT", 1))
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY)) and row(m)["state"] == "live"


# 5. One guarded write: If-Match on the checked version, If-None-Match: * on a create, no blind retry.

def test_5_every_write_of_a_copy_carries_its_guard(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    checked = m.icloud.events[copy_path(m)][0]
    sync(m)
    card_move(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    first, *rest = copy_writes(m)
    assert first[2].get("If-None-Match") == "*" and "If-Match" not in first[2]
    assert rest and all(x[2].get("If-Match") for x in rest)
    assert rest[0][2]["If-Match"] == checked


def test_5_a_removal_raced_by_an_edit_is_read_again_and_left_theirs(m):
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"

    def alarm():
        m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)                                                   # the first read without it: not yet removed
    m.icloud.before_write = alarm
    sync(m)
    deletes = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert len(deletes) == 1 and deletes[0][2].get("If-Match")
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"
    sync(m)
    assert len([x for x in copy_writes(m) if x[0] == "DELETE"]) == 1               # never retried blindly


def test_5_a_removal_whose_answer_is_lost_is_read_again(m):
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    sync(m)
    m.icloud.drop_response_next = True
    sync(m)
    assert copy_path(m) not in m.icloud.events and row(m)["state"] == "cancelled"


def test_5_a_removal_refused_only_for_its_version_is_read_again_and_sent_once_more(m):
    """iCloud's listing and a read by address can give one version different ETags: a 412 whose read shows the
    copy exactly as Harness wrote it is sent once more, with the version that read gave."""
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    sync(m)
    m.icloud.before_write = lambda: m.icloud.seed(copy_path(m), m.icloud.events[copy_path(m)][1])
    sync(m)
    deletes = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert len(deletes) == 2 and deletes[0][2]["If-Match"] != deletes[1][2]["If-Match"]
    assert copy_path(m) not in m.icloud.events


def test_5_a_create_never_lands_over_something_already_there(m):
    path = copy_path(m)
    there = m.icloud.seed(path, caldav.build_copy_ics("someone-else-2", "Pottery", at(20, day=DAY + 10),
                                                      at(21, day=DAY + 10), m.clock()))
    sync(m)
    assert m.icloud.events[path][0] == there and row(m)["state"] == "hands_off"
    assert [x[2].get("If-None-Match") for x in copy_writes(m)] == ["*"]


def test_5_a_settled_rewrite_raced_by_an_edit_is_left_theirs(m):
    at_coffee_time(m)
    undecided(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.clock.advance(minutes=61)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"
    assert len(copy_writes(m)) == 2


def test_5_a_fix_card_move_refused_for_its_version_is_judged_again(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    assert out["status"] == "waiting for his tap"
    m.icloud.before_write = lambda: m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    m.tap("Approve")
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"


def test_5_put_copy_never_retries_a_refused_write_itself(m):
    at_coffee_time(m)
    n = len(copy_writes(m))
    out = m.client.put_copy(family_copy._uid(m.key), COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1),
                            m.clock(), etag='"old"')
    assert out.kind == "changed" and len(copy_writes(m)) == n + 1


# 6. A copy Harness last saw as its own and now gone: someone took it off. Never made again by itself.

def test_6_revive_finds_a_copy_gone_and_says_so_once_and_never_makes_it_again(m):
    at_coffee_time(m)
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
        db.execute("DELETE FROM meta WHERE key=?", (family_copy.REVIVED,))
    del m.icloud.events[copy_path(m)]
    sync(m)
    sync(m)
    assert copy_path(m) not in m.icloud.events and len(copy_writes(m)) == 1
    assert row(m)["state"] == "hands_off" and left_why(m) == ["gone"]
    assert "no longer on Family" in m.copier.digest_line()


def test_6_a_copy_taken_off_family_with_its_event_gone_too_isnt_made_again_when_the_event_comes_back(m):
    at_coffee_time(m)
    del m.icloud.events[copy_path(m)]
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    for _ in range(3):
        sync(m)
    assert row(m)["state"] == "hands_off" and "gone" in left_why(m)
    m.gmail.events[INSTANCE]["status"] = "confirmed"                         # his Undo, say
    sync(m)
    sync(m)
    assert copy_path(m) not in m.icloud.events and len(copy_writes(m)) == 1


# 7. The pending write's record is saved whole before it's sent; missing or damaged: hands-off.

def test_7_the_pending_record_is_saved_before_the_write_is_sent(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    prior_etag, prior_body = m.icloud.events[copy_path(m)]
    seen = {}

    def look():
        seen.update(family_copy.version(m.ledger, m.key)["pending"])
    m.icloud.before_write = look
    sync(m)
    assert seen["from"] == prior_etag and not seen["landed"]
    assert seen["prior_body"].replace("\r\n", "\n") == prior_body.replace("\r\n", "\n")   # as the listing gave it
    assert family_copy.content_is(seen["intended"], family_copy._uid(m.key), COPY_TITLE, at(13, 45, day=DAY),
                                  at(14, 45, day=DAY))
    sent = [x for x in copy_writes(m) if x[0] == "PUT"][-1]
    assert sent[3].decode() == seen["intended"]


@pytest.mark.parametrize("damage", ["{not json", "[]", "pending"])
def test_7_a_damaged_or_incomplete_record_leaves_the_copy_alone(m, damage):
    at_coffee_time(m)
    if damage == "pending":                                  # undecided, but what it went over wasn't kept
        family_copy.note_write(m.ledger, m.key, m.icloud.events[copy_path(m)][0], landed=False,
                               wrote=(COPY_TITLE, at(13, 45, day=DAY), at(14, 45, day=DAY)))
    else:
        with m.ledger.tx() as db:
            m.ledger.set_meta(family_copy.VERSION + m.key, damage, db)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert row(m)["state"] == "hands_off" and left_why(m) == ["record"] and len(copy_writes(m)) == 1


def test_7_a_lost_answer_with_its_record_gone_is_never_guessed(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.drop_response_next = True
    real = m.client.fetch

    def fetch(href):
        m.client.fetch = real
        with m.ledger.tx() as db:
            m.ledger.set_meta(family_copy.VERSION + m.key, "{", db)
        return real(href)
    m.client.fetch = fetch
    sync(m)
    assert row(m)["state"] == "hands_off" and left_why(m) == ["record"]


# 8. Google: the revision a write used, reconciled if it moved meanwhile; showDeleted; repeated 404s said.

def test_8_an_event_that_moves_while_its_copy_is_written_is_reconciled_with_the_checks_again(m):
    """Round 3 of the second review (fix 5): the move found by the check after the write is queued (saved), and the
    next read brings the copy to it, with the ownership and version checks again."""
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    assert family_copy.queued(m.ledger, m.key)["op"] == "move"
    m.icloud.before_write = None
    sync(m)
    puts_ = [x for x in copy_writes(m) if x[0] == "PUT"]
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and len(puts_) == 3
    assert puts_[2][2]["If-Match"] != puts_[1][2]["If-Match"] and row(m)["state"] == "live"
    assert family_copy.queued(m.ledger, m.key) is None


def test_8_a_copy_edited_before_the_reconcile_is_left_theirs(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    m.icloud.before_write = None
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"
    assert len([x for x in copy_writes(m) if x[0] == "PUT"]) == 2


def test_8_repeated_not_found_answers_for_one_copy_are_said_once(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    feed_now(m)                                               # the feed still lists it
    real = m.gmail.look_by_id
    m.gmail.look_by_id = lambda address, uid: ("missing", None)
    for _ in range(family_copy.MISSING_404S):
        m.feeds.generation += 1
        m.copier._sync()
    m.gmail.look_by_id = real
    assert len(copy_writes(m)) == 1
    line = m.copier.digest_line()
    assert line.count("keeps answering “not found” for the Gmail event of Coffee Nov 12") == 1


# 9. Feed items mapped to API ids explicitly; a read for another series or day is never written from.

def test_9_a_moved_single_day_is_read_by_its_series_and_original_start(m):
    at_coffee_time(m)
    asked = []
    real = m.gmail.look_by_id
    m.gmail.look_by_id = lambda address, uid: asked.append(uid) or real(address, uid)
    moved_by_hand(m, at(15, day=DAY), at(16, day=DAY))
    sync(m)
    assert set(asked) == {INSTANCE} and copy_times(m) == (at(15, day=DAY), at(16, day=DAY))


@pytest.mark.parametrize("wrong", ["series", "day"])
def test_9_an_answer_for_another_series_or_day_gets_no_write(m, wrong):
    at_coffee_time(m)
    moved_by_hand(m, at(15, day=DAY), at(16, day=DAY))
    real = m.gmail.look_by_id

    def other(address, uid):
        kind, e = real(address, uid)
        if wrong == "series":
            e["recurringEventId"] = "x0ai2c7kb1mbia2n4mdl3e6p10"
        else:
            e["originalStartTime"] = {"dateTime": (ORIGINAL + timedelta(days=7)).isoformat(), "timeZone": TZ}
        return kind, e
    m.gmail.look_by_id = other
    sync(m)
    assert len(copy_writes(m)) == 1 and copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))


def test_9_source_matches_checks_the_series_and_the_original_start():
    e = {"iCalUID": f"{SERIES}@google.com", "recurringEventId": SERIES,
         "originalStartTime": {"dateTime": ORIGINAL.isoformat()}}
    stamp = f"{ORIGINAL.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
    assert family_copy.source_matches(e, f"{SERIES}@google.com", stamp)
    assert not family_copy.source_matches(e, f"{SERIES}@google.com", "20261119T133000Z")
    assert not family_copy.source_matches(e, f"{SERIES}@google.com", "")                  # a day isn't a one-off
    assert not family_copy.source_matches({**e, "recurringEventId": "other"}, f"{SERIES}@google.com", stamp)
    assert family_copy.source_matches({"iCalUID": "one@google.com"}, "one@google.com", "")


# 10. Many at once said as a likely server change; a take-back card on his tap.

def three_copies(m):
    keys = [m.key]
    for i, eid in enumerate(("d0ai2c7kb1mbia2n4mdl3e6p10", "d1ai2c7kb1mbia2n4mdl3e6p10")):
        keys.append(second(m, eid, "Dentist checkup" if i == 0 else "Doctor visit", at(9, day=DAY + 2 + i)))
    sync(m)
    return [FAMILY_PATH + family_copy._uid(k) + ".ics" for k in keys]


def test_10_three_copies_going_hands_off_in_one_read_is_said_once_as_a_likely_server_change(m):
    paths = three_copies(m)
    for p in paths:
        m.icloud.seed(p, with_added(m.icloud.events[p][1], "LOCATION:Somewhere"))
    sync(m)
    line = m.copier.digest_line()
    assert line.count("That looks like iCloud changing how it keeps events, not people's edits.") == 1
    assert "3 Family copies stopped reading as I wrote them" in line


def test_10_one_unknown_line_on_two_copies_is_named_as_a_likely_server_change(m):
    paths = three_copies(m)[:2]
    for p in paths:
        m.icloud.seed(p, with_added(m.icloud.events[p][1], "X-APPLE-NEW-BOOKKEEPING:1"))
    sync(m)
    assert "each with a new X-APPLE-NEW-BOOKKEEPING line" in m.copier.digest_line()


def test_10_one_person_editing_one_copy_is_not_called_a_server_change(m):
    paths = three_copies(m)
    m.icloud.seed(paths[0], with_added(m.icloud.events[paths[0]][1], ALARM))
    sync(m)
    assert "iCloud changing" not in m.copier.digest_line()


def test_10_a_take_back_card_says_what_changed_and_writes_only_on_his_tap_over_that_version(m):
    at_coffee_time(m)
    shown = m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)
    assert row(m)["state"] == "hands_off"
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    n = len(copy_writes(m))
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    assert out["status"] == "waiting for his tap" and len(copy_writes(m)) == n        # nothing before his tap
    assert "Take back the Family copy of Coffee with Chris (changed on Family: an alert)" in m.seen()[-1]
    m.tap("Approve")
    sent = copy_writes(m)[-1]
    assert sent[2]["If-Match"] == shown
    assert ALARM not in m.icloud.events[copy_path(m)][1]
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY)) and row(m)["state"] == "live"
    sync(m)
    assert row(m)["state"] == "live"


def test_10_a_take_back_after_another_change_writes_nothing(m):
    at_coffee_time(m)
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    sync(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    edited = m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], "LOCATION:Corner Cafe"))
    n = len(copy_writes(m))
    m.tap("Approve")
    assert m.icloud.events[copy_path(m)][0] == edited and len(copy_writes(m)) == n


def test_5_a_fix_card_removal_refused_for_its_version_is_judged_again(m):
    at_coffee_time(m)
    del m.gmail.events[INSTANCE]
    m.gmail.gone_410 = {INSTANCE}
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    assert out["status"] == "waiting for his tap"
    m.icloud.before_write = lambda: m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], ALARM))
    m.tap("Approve")
    deletes = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert len(deletes) == 1 and deletes[0][2].get("If-Match")
    assert ALARM in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"
