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
from test_family_copy import Feeds, when
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
    m.copier = FamilyCopy(ledger, m.fa, m.feeds, name_fn=lambda: "Alex", tz=TZ)
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
    assert "Move the Family copy of Coffee with Chris to 2:15 to 3:45 tomorrow, to match your Gmail calendar" \
        in text
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
    assert "Move the Family copy of Coffee with Chris to 4:00 to 5:00 tomorrow" in m.seen()[-1]
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
    assert "Move the Family copy of Coffee with Chris to 2:15 to 3:15 tomorrow" in m.seen()[-1]


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
    assert "Move the Family copy of Dentist checkup to 10:00 to 11:00 Saturday" in m.seen()[-1]


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
    assert drives.live.on_choice("drive_off", target_of(drives, "drive_off")[0]).startswith(
        "Drive blocks are back to logging only")
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
                               wrote=(COPY_TITLE, ORIGINAL, ORIGINAL + timedelta(hours=1)))
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
