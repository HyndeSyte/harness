"""0.6.0: Family kept true to his Gmail calendar, with no tap and no model.

All names and addresses are invented.
"""
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, effects, ical
from harness.family_copy import (MAX_REMOVALS_AT_ONCE, MAX_WRITES_PER_DAY, PROBLEM, FamilyCopy,
                                 name_from_options, plan, word_for)
from harness.net import TransportError
from harness.vault import FIELDS
from fake_caldav import (APP_PASSWORD, APPLE_ID, FAMILY_PATH, FAMILY_URL, FakeICloud,  # noqa: F401
                         no_network, props)
from test_family_add import Rig, on, plain_prompt, rig  # noqa: F401
from test_family_caldav import gated

NY = ZoneInfo("America/New_York")
TZ = "America/New_York"
GMAIL = "parent@gmail.com"


def when(rig, days=3, hour=9, minute=0):
    d = rig.clock().astimezone(NY).date() + timedelta(days=days)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=NY)


def occ(summary="PT at the clinic", start=None, hours=1, calendar=GMAIL, uid=None, organizer=GMAIL,
        transparent=False, location="", instance=""):
    start = start or datetime(2026, 11, 10, 9, tzinfo=NY)
    return ical.Occurrence(start, start + timedelta(hours=hours), False, summary, calendar,
                           transparent, uid or summary, instance, (), location, organizer)


def day_occ(summary, first, last, uid=None, organizer=GMAIL):
    return ical.Occurrence(first, last + timedelta(days=1), True, summary, GMAIL, False,
                           uid or summary, "", (), "", organizer)


class Feeds:
    """What the reader hands over, without any fetching."""
    ahead_days = 60
    configured = True

    def __init__(self):
        self.generation = 0
        self.window = ical.Window(GMAIL)
        res = SimpleNamespace(window=self.window, ahead=self.window)
        self.snapshot = SimpleNamespace(feeds={"a": res})


@pytest.fixture
def copy(on):
    on.feeds = Feeds()
    on.name = "Sam"
    on.copy = FamilyCopy(on.ledger, on.fa, on.feeds, name_fn=lambda: on.name, tz=TZ)
    on.c.family_copy = on.copy
    on.bot.sent.clear()
    return on


def read(rig, *events, unreadable=0):
    """A new read of Gmail lands, and a tick looks at it."""
    rig.feeds.window.occurrences = list(events)
    rig.feeds.window.unreadable = unreadable
    rig.feeds.generation += 1
    rig.tick()


def on_family(rig):
    return {p: v[1] for p, v in rig.icloud.family().items()}


def titles(rig):
    return sorted(props(ics)["SUMMARY"][0].split(":", 1)[1] for ics in on_family(rig).values())


def starts(rig):
    return sorted(props(ics)["DTSTART"][0] for ics in on_family(rig).values())


def seed(rig, title, start, hours=1, extra=()):
    utc, fmt = start.astimezone(ZoneInfo("UTC")), "%Y%m%dT%H%M%SZ"
    uid = f"his-{abs(hash((title, start))) % 99999}"
    path = f"{FAMILY_PATH}{uid}.ics"
    rig.icloud.seed(path, "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{utc:{fmt}}",
        f"DTSTART:{utc:{fmt}}", f"DTEND:{utc + timedelta(hours=hours):{fmt}}", f"SUMMARY:{title}",
        *extra, "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    return path


def events(rig, kind):
    return rig.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind=?", (kind,)).fetchone()[0]


# -- which events, and what Family gets ------------------------------------------------------

@pytest.mark.parametrize("title, word", [
    ("PT at the clinic", "PT"), ("Physical therapy", "PT"), ("Dentist (Main St)", "Dentist"),
    ("Doctor - Lee, PA", "Doctor"), ("Consultation with Jan Roe, MD", "Doctor"),
    ("Echo (cardiology)", "Doctor"), ("Coffee with Pat", "Coffee"), ("Pat + Sam ☕", "Coffee"),
    ("Appointment with the spa", "Appointment")])
def test_the_word_is_fixed_by_what_the_title_says(title, word):
    assert word_for(occ(title)) == word


@pytest.mark.parametrize("title", ["Busy (interim)", "Call: P. Lee (phone)", "Session: P. Lee",
                                   "Lunch", "Drive to the orthopedics clinic", "Budget review",
                                   "Dentist call", "Meeting with the doctor"])
def test_everything_else_gets_no_word(title):
    assert word_for(occ(title)) is None


def test_not_transparent_long_another_calendar_or_someones_invite():
    assert word_for(occ(transparent=True)) is None
    assert word_for(occ(hours=9)) is None
    assert word_for(occ(calendar="sam@work.example", organizer="")) is None
    assert word_for(occ(calendar="Holidays", organizer="")) is None
    assert word_for(occ(organizer="stranger@example.com")) is None
    assert word_for(occ(organizer="")) == "PT"


def test_no_text_from_gmail_ever_reaches_family(copy):
    read(copy, occ("PT secret https://evil.example /resume", start=when(copy), location="12 Secret St"))
    ics = next(iter(on_family(copy).values()))
    assert titles(copy) == ["Sam - PT"]
    assert "secret" not in ics.lower() and "evil" not in ics and "LOCATION" not in ics


def test_no_people_alarm_or_repeat_on_a_copy(copy):
    read(copy, occ(start=when(copy)))
    p = props(next(iter(on_family(copy).values())))
    assert not {"ATTENDEE", "ORGANIZER", "VALARM", "RRULE"} & set(p)
    assert "BEGIN:VALARM" not in p["BEGIN"]
    assert "X-HARNESS-OWNED" in p


# -- no tap: it just happens -------------------------------------------------------------------

def test_a_new_appointment_lands_with_no_tap_card_or_message(copy):
    calls = len(copy.claude.calls)
    read(copy, occ(start=when(copy)))
    assert titles(copy) == ["Sam - PT"]
    assert not copy.bot.sent
    assert len(copy.claude.calls) == calls


def test_it_is_off_without_his_name(copy):
    copy.name = ""
    read(copy, occ(start=when(copy)))
    assert not copy.icloud.family()


def test_it_is_off_when_adds_are_off(rig):
    rig.feeds = Feeds()
    rig.c.family_copy = FamilyCopy(rig.ledger, rig.fa, rig.feeds, name_fn=lambda: "Sam", tz=TZ)
    read(rig, occ(start=when(rig)))
    assert not rig.icloud.family()


def test_stop_stops_it_and_resume_picks_it_up(copy):
    copy.say("/stop")
    read(copy, occ(start=when(copy)))
    assert not copy.icloud.family()
    copy.say("/resume")
    read(copy, occ(start=when(copy)))
    assert len(copy.icloud.family()) == 1


def test_it_only_looks_after_a_new_read(copy):
    read(copy)
    copy.feeds.window.occurrences = [occ(start=when(copy))]
    copy.tick()
    assert not copy.icloud.family()
    read(copy, occ(start=when(copy)))
    assert len(copy.icloud.family()) == 1


def test_past_events_are_not_copied(copy):
    read(copy, occ(start=copy.clock().astimezone(NY) - timedelta(hours=3)))
    assert not copy.icloud.family()


def test_a_second_read_changes_nothing(copy):
    event = occ(start=when(copy))
    read(copy, event)
    puts = copy.icloud.methods().count("PUT")
    read(copy, event)
    assert copy.icloud.methods().count("PUT") == puts


def test_copies_never_touch_the_bake_in(copy):
    before = copy.fa._bake()["n"]
    event = occ(start=when(copy))
    read(copy, event)
    read(copy, occ(start=when(copy, 5), uid=event.uid))
    assert copy.fa._bake()["n"] == before
    assert not copy.ledger.db.execute("SELECT 1 FROM family_adds").fetchone()


def test_a_model_cannot_name_it():
    with pytest.raises(effects.ParamError):
        effects.lookup("family_copy_sync", lambda s: True)


# -- moved and cancelled ---------------------------------------------------------------------

def test_a_moved_event_moves_its_copy_and_stays_one_event(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    before = starts(copy)
    read(copy, occ(uid="u1", start=when(copy, 7)))
    assert len(copy.icloud.family()) == 1 and starts(copy) != before
    assert events(copy, "family_copy_moved") == 1


def test_a_changed_length_is_followed(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    read(copy, occ(uid="u1", start=when(copy, 5), hours=2))
    assert events(copy, "family_copy_moved") == 1


def test_a_cancelled_event_comes_off_after_two_good_reads(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    read(copy)
    assert len(copy.icloud.family()) == 1
    read(copy)
    assert not copy.icloud.family()
    assert events(copy, "family_copy_cancelled") == 1


def test_coming_back_between_reads_resets_the_count(copy):
    event = occ(uid="u1", start=when(copy, 5))
    read(copy, event)
    read(copy)
    read(copy, event)
    read(copy)
    assert len(copy.icloud.family()) == 1


def test_a_cancelled_event_that_returns_is_copied_again(copy):
    event = occ(uid="u1", start=when(copy, 5))
    read(copy, event)
    read(copy)
    read(copy)
    read(copy, event)
    assert len(copy.icloud.family()) == 1


def test_a_read_with_unreadable_events_removes_nothing(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    read(copy, unreadable=1)
    read(copy, unreadable=1)
    assert len(copy.icloud.family()) == 1


def test_many_gone_at_once_is_held_as_a_bad_read(copy):
    events_ = [occ(f"PT {i}", start=when(copy, 3 + i)) for i in range(MAX_REMOVALS_AT_ONCE + 1)]
    read(copy, *events_)
    read(copy)
    read(copy)
    assert len(copy.icloud.family()) == len(events_)
    assert "bad read" in copy.ledger.get_meta(PROBLEM)
    assert "bad read" in copy.copy.digest_line()


def test_a_few_gone_at_once_are_removed(copy):
    events_ = [occ(f"PT {i}", start=when(copy, 3 + i)) for i in range(MAX_REMOVALS_AT_ONCE)]
    read(copy, *events_)
    read(copy)
    read(copy)
    assert not copy.icloud.family()


def test_an_edit_on_family_is_left_alone_for_good(copy):
    event = occ(uid="u1", start=when(copy, 5))
    read(copy, event)
    path = next(iter(on_family(copy)))
    copy.icloud.human_edit(path, "SUMMARY:Sam - PT", "SUMMARY:Sam - PT then lunch")
    read(copy, occ(uid="u1", start=when(copy, 7)))
    read(copy)
    read(copy)
    assert titles(copy) == ["Sam - PT then lunch"]


def test_an_edit_racing_the_write_is_left_alone(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    path = next(iter(on_family(copy)))
    copy.icloud.before_write = lambda: copy.icloud.human_edit(path, "SUMMARY:Sam - PT", "SUMMARY:Sam - x")
    read(copy, occ(uid="u1", start=when(copy, 7)))
    assert titles(copy) == ["Sam - x"]
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "hands_off"


def test_a_copy_past_what_was_read_is_not_taken_as_cancelled(copy):
    copy.feeds.ahead_days = 5
    read(copy, occ(uid="u1", start=when(copy, 4)))
    copy.feeds.ahead_days = 2
    read(copy)
    read(copy)
    assert len(copy.icloud.family()) == 1


def test_a_finished_copy_is_left_on_family(copy):
    read(copy, occ(uid="u1", start=when(copy, 1)))
    copy.advance(days=3)
    read(copy)
    read(copy)
    assert len(copy.icloud.family()) == 1
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "done"


# -- deleted on Family: a signal -------------------------------------------------------------

def keep_family_readable(rig):
    """Something else on Family, so an empty answer isn't taken for a bad read."""
    seed(rig, "School day", when(rig, 1, hour=8), hours=6)


def remove_copies(rig, *titles_):
    for path, ics in list(on_family(rig).items()):
        if not titles_ or props(ics)["SUMMARY"][0].split(":", 1)[1] in titles_:
            del rig.icloud.events[path]


def test_a_copy_someone_removed_is_not_put_back(copy):
    event = occ(uid="u1", start=when(copy, 5))
    keep_family_readable(copy)
    read(copy, event)
    remove_copies(copy, "Sam - PT")
    read(copy, event)
    read(copy, event)
    read(copy, event)
    assert titles(copy) == ["School day"]
    assert "removed by someone" in copy.copy.digest_line()


def test_two_removed_of_a_kind_stops_copying_that_kind_only(copy):
    pt = [occ(f"PT {i}", start=when(copy, 3 + i)) for i in range(2)]
    keep_family_readable(copy)
    read(copy, *pt)
    remove_copies(copy, "Sam - PT")
    read(copy, *pt)
    read(copy, *pt)
    read(copy, *pt, occ("PT new", start=when(copy, 9)), occ("Dentist", start=when(copy, 10)))
    assert titles(copy) == ["Sam - Dentist", "School day"]


def test_one_removed_changes_nothing_else(copy):
    first = occ("PT 1", start=when(copy, 3))
    keep_family_readable(copy)
    read(copy, first)
    remove_copies(copy, "Sam - PT")
    read(copy, first)
    read(copy, first)
    read(copy, first, occ("PT 2", start=when(copy, 9)))
    assert titles(copy) == ["Sam - PT", "School day"]


def test_stopping_a_kind_does_not_remove_the_copies_still_there(copy):
    pt = [occ(f"PT {i}", start=when(copy, 3 + i)) for i in range(3)]
    read(copy, *pt)
    paths = list(on_family(copy))
    for p in paths[:2]:
        del copy.icloud.events[p]
    read(copy, *pt)
    read(copy, *pt)
    read(copy, *pt)
    read(copy, *pt)
    assert len(copy.icloud.family()) == 1


# -- trips -----------------------------------------------------------------------------------

def trip(rig):
    first = when(rig, 10).date()
    last = first + timedelta(days=3)
    out = datetime(first.year, first.month, first.day, 15, 15, tzinfo=NY)
    back = datetime(last.year, last.month, last.day, 13, 40, tzinfo=NY)
    return first, last, [day_occ("Stay at the Grand Hotel", first, last, uid="s1"),
                         occ("Flight to Springfield (ZZ 101)", start=out, hours=2),
                         occ("Flight to Homeville (ZZ 102)", start=back, hours=2)]


def test_a_trip_is_one_block_with_flight_times_and_numbers(copy):
    first, last, events_ = trip(copy)
    read(copy, *events_)
    assert len(copy.icloud.family()) == 1
    title = titles(copy)[0]
    assert title.startswith("Sam - Springfield (out ") and "3:15 PM ZZ 101" in title
    assert "back " in title and "1:40 PM ZZ 102" in title
    assert "Grand" not in title
    p = props(next(iter(on_family(copy).values())))
    assert p["DTSTART"] == [f"DTSTART;VALUE=DATE:{first:%Y%m%d}"]
    assert p["DTEND"] == [f"DTEND;VALUE=DATE:{last + timedelta(days=1):%Y%m%d}"]


def test_a_trip_can_run_past_a_day(copy):
    first, last, events_ = trip(copy)
    assert (last - first).days > 1
    read(copy, *events_)
    assert len(copy.icloud.family()) == 1


def test_a_trip_with_no_flights_says_away(copy):
    first = when(copy, 10).date()
    read(copy, day_occ("Stay at the Grand Hotel", first, first + timedelta(days=2)))
    assert titles(copy) == ["Sam - away"]


def test_his_copy_during_a_trip_is_not_removed(copy):
    first, _, events_ = trip(copy)
    during = datetime(first.year, first.month, first.day, 9, tzinfo=NY) + timedelta(days=1)
    path = seed(copy, "Sam - Coffee", during)
    event = occ("Coffee with Pat", uid="c1", start=during)
    read(copy, event)
    read(copy, *events_, event)
    read(copy, *events_, event)
    read(copy, *events_, event)
    assert path in on_family(copy)


def test_a_trip_under_way_keeps_its_title_as_flights_leave_the_read(copy):
    first, last, events_ = trip(copy)
    read(copy, *events_)
    title = titles(copy)[0]
    copy.advance(days=11)                      # past the flight out
    read(copy, events_[0], events_[2])
    assert titles(copy) == [title] and not events(copy, "family_copy_moved")


def test_a_connection_gives_the_time_he_leaves_and_where_he_ends_up():
    first = date(2026, 11, 10)
    one = datetime(2026, 11, 10, 7, tzinfo=NY)
    two = datetime(2026, 11, 10, 11, tzinfo=NY)
    wants = plan([day_occ("Stay at X", first, first + timedelta(days=2)),
                  occ("Flight to Midtown (ZZ 1)", start=one), occ("Flight to Springfield (ZZ 2)", start=two)],
                 "Sam", TZ)
    title = next(iter(wants.values())).title
    assert title.startswith("Sam - Springfield (out ") and "7:00 AM ZZ 1" in title


def test_stay_at_home_is_not_a_trip():
    first = date(2026, 11, 10)
    assert not plan([day_occ("Stay at home", first, first)], "Sam", TZ)


def test_a_long_or_wordy_city_gives_no_words():
    first = date(2026, 11, 10)
    out = datetime(2026, 11, 10, 9, tzinfo=NY)
    for city in ("Please call this number now", "Llanfairpwllgwyngyllgogerychwyrndrobwll",
                 "Buy now at my shop"):
        wants = plan([day_occ("Stay at X", first, first), occ(f"Flight to {city} (ZZ 1)", start=out)],
                     "Sam", TZ)
        assert [w.title for w in wants.values()] == ["Sam - away"]


def test_appointments_during_a_trip_are_not_copied(copy):
    first, _, events_ = trip(copy)
    during = datetime(first.year, first.month, first.day, 9, tzinfo=NY) + timedelta(days=1)
    read(copy, *events_, occ("Coffee with Pat", start=during))
    assert len(copy.icloud.family()) == 1


def test_a_trip_that_moves_moves(copy):
    first = when(copy, 10).date()
    read(copy, day_occ("Stay at the Grand Hotel", first, first + timedelta(days=2), uid="s1"))
    later = first + timedelta(days=4)
    read(copy, day_occ("Stay at the Grand Hotel", later, later + timedelta(days=2), uid="s1"))
    assert starts(copy) == [f"DTSTART;VALUE=DATE:{later:%Y%m%d}"]


def test_a_trip_that_is_cancelled_comes_off(copy):
    first = when(copy, 10).date()
    read(copy, day_occ("Stay at the Grand Hotel", first, first + timedelta(days=2), uid="s1"))
    read(copy)
    read(copy)
    assert not copy.icloud.family()


def test_a_flight_booked_later_updates_the_block(copy):
    first, last, events_ = trip(copy)
    read(copy, events_[0])
    assert titles(copy) == ["Sam - away"]
    read(copy, *events_)
    assert titles(copy)[0].startswith("Sam - Springfield")
    assert len(copy.icloud.family()) == 1


def test_someone_elses_stay_or_flight_is_ignored():
    first = date(2026, 11, 10)
    assert not plan([day_occ("Stay at X", first, first, organizer="x@example.com")], "Sam", TZ)
    out = datetime(2026, 11, 10, 9, tzinfo=NY)
    wants = plan([day_occ("Stay at X", first, first),
                  occ("Flight to Fakeville (ZZ 1)", start=out, organizer="x@example.com")], "Sam", TZ)
    assert [w.title for w in wants.values()] == ["Sam - away"]


@pytest.mark.parametrize("flight", ["Flight to https://evil.example (ZZ 1)", "Flight to evil.lol (ZZ 1)",
                                    "Flight to Springfield (click here)", "Flight to /resume (ZZ 1)"])
def test_a_flight_title_outside_the_pattern_gives_no_words(flight):
    first = date(2026, 11, 10)
    out = datetime(2026, 11, 10, 9, tzinfo=NY)
    wants = plan([day_occ("Stay at X", first, first), occ(flight, start=out)], "Sam", TZ)
    assert [w.title for w in wants.values()] == ["Sam - away"]


def test_a_trip_block_of_his_own_is_not_doubled(copy):
    first = when(copy, 10).date()
    path = f"{FAMILY_PATH}his-trip.ics"
    copy.icloud.seed(path, "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:his-trip", "DTSTAMP:20261103T000000Z",
        f"DTSTART;VALUE=DATE:{first:%Y%m%d}", f"DTEND;VALUE=DATE:{first + timedelta(days=4):%Y%m%d}",
        "SUMMARY:Sam - Riverton", "END:VEVENT", "END:VCALENDAR"]) + "\r\n")
    read(copy, day_occ("Stay at the Grand Hotel", first, first + timedelta(days=2)))
    assert list(on_family(copy)) == [path]


# -- what he copied by hand ----------------------------------------------------------------------

def test_his_copy_is_taken_over_not_doubled(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    assert list(on_family(copy)) == [path]
    assert "PUT" not in copy.icloud.methods()


def test_his_copy_within_the_drive_time_is_the_same_one(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - Dentist", start + timedelta(minutes=15))
    read(copy, occ("Dentist (Main St)", uid="u1", start=start))
    assert list(on_family(copy)) == [path]


def test_a_long_block_on_family_does_not_count_as_his_copy(copy):
    start = when(copy, 5)
    seed(copy, "School day", start - timedelta(hours=1), hours=6)
    read(copy, occ(uid="u1", start=start))
    assert "Sam - PT" in titles(copy)


def test_his_copy_moves_when_gmail_moves(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    read(copy, occ(uid="u1", start=when(copy, 7)))
    assert path not in on_family(copy) and titles(copy) == ["Sam - PT"]


def test_his_copy_comes_off_when_gmail_cancels(copy):
    start = when(copy, 5)
    seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    read(copy)
    read(copy)
    assert not copy.icloud.family()


def test_after_taking_over_it_follows_as_its_own(copy):
    start = when(copy, 5)
    seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    read(copy, occ(uid="u1", start=when(copy, 7)))
    first = starts(copy)
    read(copy, occ(uid="u1", start=when(copy, 9)))
    assert starts(copy) != first and len(copy.icloud.family()) == 1


def test_his_time_is_kept_until_gmail_moves(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - Dentist", start + timedelta(minutes=15))
    event = occ("Dentist", uid="u1", start=start)
    read(copy, event)
    read(copy, event)
    assert list(on_family(copy)) == [path] and "DELETE" not in copy.icloud.methods()


def test_a_copy_he_removed_himself_is_not_a_signal(copy):
    start = when(copy, 5)
    keep_family_readable(copy)
    path = seed(copy, "Sam - PT", start)
    event = occ(uid="u1", start=start)
    read(copy, event)
    del copy.icloud.events[path]
    read(copy, event)
    read(copy, event)
    read(copy, event)
    assert titles(copy) == ["School day"]
    assert not events(copy, "family_copy_removed")


@pytest.mark.parametrize("extra", [["ATTENDEE:mailto:pat@example.com"], ["ORGANIZER:mailto:pat@example.com"]])
def test_an_event_with_other_people_is_never_taken_over(copy, extra):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start, extra=extra)
    read(copy, occ(uid="u1", start=start))
    read(copy, occ(uid="u1", start=when(copy, 7)))
    read(copy)
    read(copy)
    assert path in on_family(copy)


def test_a_repeating_series_on_family_is_never_taken_over(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start, extra=["RRULE:FREQ=WEEKLY"])
    read(copy, occ(uid="u1", start=start))
    read(copy, occ(uid="u1", start=when(copy, 8)))
    assert path in on_family(copy)


def test_a_failed_put_after_removing_his_copy_tries_again(copy):
    start = when(copy, 5)
    seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    original = copy.icloud.request

    def refuse_put(method, url, **kw):
        if method == "PUT":
            copy.icloud.request = original
            raise TransportError("timeout")
        return original(method, url, **kw)
    copy.icloud.request = refuse_put
    moved = occ(uid="u1", start=when(copy, 7))
    read(copy, moved)
    assert titles(copy) == ["Sam - PT"]        # the same pass writes it anew
    read(copy, moved)
    assert titles(copy) == ["Sam - PT"]


def test_a_long_trip_title_is_not_taken_for_an_edit(copy):
    first, last, events_ = trip(copy)
    copy.name = "Samantha Jane"
    long_city = occ("Flight to Rancho Cucamonga West (ZZ 101)", start=events_[1].start, hours=2)
    read(copy, events_[0], long_city, events_[2])
    assert len(titles(copy)[0]) > 80
    later = first + timedelta(days=1)
    read(copy, day_occ("Stay at the Grand Hotel", later, last, uid="s1"))
    assert starts(copy) == [f"DTSTART;VALUE=DATE:{later:%Y%m%d}"]


def test_one_flight_on_a_one_day_stay_is_not_also_the_way_back():
    first = date(2026, 11, 10)
    out = datetime(2026, 11, 10, 9, tzinfo=NY)
    wants = plan([day_occ("Stay at X", first, first), occ("Flight to Springfield (ZZ 1)", start=out)], "Sam", TZ)
    title = next(iter(wants.values())).title
    assert "out " in title and "back " not in title


def test_his_own_wording_does_not_stop_it_following(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT then errands", start)
    read(copy, occ(uid="u1", start=start))
    read(copy, occ(uid="u1", start=when(copy, 7)))
    assert path not in on_family(copy) and titles(copy) == ["Sam - PT"]


def test_a_new_name_does_not_rewrite_his_copy(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start)
    event = occ(uid="u1", start=start)
    read(copy, event)
    copy.name = "Samuel"
    read(copy, event)
    assert list(on_family(copy)) == [path]


def test_his_name_alone_is_not_a_match(copy):
    start = when(copy, 5)
    seed(copy, "Sam - PT", start)
    read(copy, occ("Dentist", uid="u1", start=start))
    assert titles(copy) == ["Sam - Dentist", "Sam - PT"]


@pytest.mark.parametrize("extra", [["ATTENDEE:mailto:pat@example.com"], ["ORGANIZER:mailto:pat@example.com"],
                                   ["RRULE:FREQ=WEEKLY"]])
def test_nothing_with_people_or_a_repeat_is_recorded_as_his_copy(copy, extra):
    start = when(copy, 5)
    seed(copy, "Sam - PT", start, extra=extra)
    read(copy, occ(uid="u1", start=start))
    assert not copy.ledger.db.execute("SELECT 1 FROM family_copies").fetchone()


# -- what isn't his ------------------------------------------------------------------------------

def test_a_family_members_event_is_never_taken_over(copy):
    start = when(copy, 5)
    path = seed(copy, "Mom - Doctor", start)
    event = occ("Doctor - Lee", uid="u1", start=start)
    read(copy, event)
    assert sorted(titles(copy)) == ["Mom - Doctor", "Sam - Doctor"]
    read(copy)
    read(copy)
    assert titles(copy) == ["Mom - Doctor"] and path in on_family(copy)


def test_his_copy_rewritten_since_is_left_alone(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - PT", start)
    read(copy, occ(uid="u1", start=start))
    copy.icloud.human_edit(path, "SUMMARY:Sam - PT", "SUMMARY:Sam - PT at Grandma's birthday")
    read(copy, occ(uid="u1", start=when(copy, 7)))
    read(copy)
    read(copy)
    assert path in on_family(copy)


def test_a_new_event_does_not_take_over_another_ones_copy(copy):
    start = when(copy, 5)
    a = occ("Dentist cleaning", uid="a", start=start)
    b = occ("Dentist follow-up", uid="b", start=start + timedelta(minutes=20))
    read(copy, a)
    read(copy, a, b)
    assert titles(copy) == ["Sam - Dentist", "Sam - Dentist"]
    read(copy, a)
    read(copy, a)
    assert titles(copy) == ["Sam - Dentist"]
    assert not events(copy, "family_copy_removed")


def test_two_new_events_do_not_share_his_one_copy(copy):
    start = when(copy, 5)
    path = seed(copy, "Sam - Dentist", start)
    a = occ("Dentist cleaning", uid="a", start=start)
    b = occ("Dentist follow-up", uid="b", start=start + timedelta(minutes=20))
    read(copy, a, b)
    assert len(copy.icloud.family()) == 2 and path in on_family(copy)


def test_an_add_he_asked_for_is_not_doubled_or_taken_over(copy):
    start = when(copy, 5)
    copy.add_one(title="Sam - PT", start=start.isoformat(), end=(start + timedelta(hours=1)).isoformat())
    read(copy, occ(uid="u1", start=start))
    assert titles(copy) == ["Sam - PT"]
    assert not copy.ledger.db.execute("SELECT 1 FROM family_copies").fetchone()


def test_two_gmail_calendars_change_nothing_and_say_so(copy):
    second = SimpleNamespace(window=ical.Window("other@gmail.com"), ahead=ical.Window("other@gmail.com"))
    copy.feeds.snapshot.feeds["b"] = second
    read(copy, occ(start=when(copy)))
    assert not copy.icloud.family()
    assert "more than one Gmail" in copy.copy.digest_line()


# -- reads that lie --------------------------------------------------------------------------------

def test_an_empty_family_answer_is_a_bad_read_not_removals(copy):
    a, b = occ("Dentist", uid="a", start=when(copy, 5)), occ("PT", uid="b", start=when(copy, 6))
    read(copy, a, b)
    saved = dict(copy.icloud.events)
    copy.icloud.events.clear()
    read(copy, a, b)
    read(copy, a, b)
    copy.icloud.events.update(saved)
    read(copy, a, b)
    assert sorted(r[0] for r in copy.ledger.db.execute("SELECT state FROM family_copies")) == ["live", "live"]


def test_one_read_missing_a_copy_is_not_a_removal(copy):
    event = occ(uid="u1", start=when(copy, 5))
    keep_family_readable(copy)
    read(copy, event)
    path = next(p for p, ics in on_family(copy).items() if "Sam - PT" in ics)
    saved = copy.icloud.events.pop(path)
    read(copy, event)
    copy.icloud.events[path] = saved
    read(copy, event)
    read(copy, event)
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "live"


def test_many_missing_from_family_at_once_is_a_bad_read(copy):
    events_ = [occ(f"PT {i}", start=when(copy, 3 + i)) for i in range(MAX_REMOVALS_AT_ONCE + 1)]
    keep_family_readable(copy)
    read(copy, *events_)
    remove_copies(copy, "Sam - PT")
    read(copy, *events_)
    read(copy, *events_)
    assert "bad read" in copy.ledger.get_meta(PROBLEM)
    assert {r[0] for r in copy.ledger.db.execute("SELECT state FROM family_copies")} == {"live"}


def test_an_answer_with_no_event_in_it_is_none():
    icloud = FakeICloud()
    original = icloud.request

    def hollow(method, url, **kw):
        out = original(method, url, **kw)
        return out if method != "REPORT" else type(out)(207, {}, (
            b'<D:multistatus xmlns:D="DAV:"><D:response><D:href>/x.ics</D:href></D:response></D:multistatus>'))
    icloud.request = hollow
    assert client(icloud).items_between(*WINDOW, TZ) is None


def test_a_series_that_shifts_replaces_its_copies(copy):
    days = [when(copy, d) for d in range(3, 38, 7)]

    def series(hour):
        return [occ("PT", uid="s", start=d.replace(hour=hour), instance=f"{d.date()}-{hour}")
                for d in days]
    read(copy, *series(9))
    n = len(copy.icloud.family())
    assert n > MAX_REMOVALS_AT_ONCE
    for _ in range(2):
        read(copy, *series(13))
    copy.advance(days=1)                       # the day's cap on changes
    read(copy, *series(13))
    assert len(copy.icloud.family()) == n and all("T17" in s or "T18" in s for s in starts(copy))
    assert "bad read" not in (copy.ledger.get_meta(PROBLEM) or "")


def test_a_lost_answer_on_a_move_does_not_stop_it_following(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    copy.icloud.drop_response_next = True
    moved = occ(uid="u1", start=when(copy, 7))
    read(copy, moved)
    read(copy, moved)
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "live"
    read(copy, occ(uid="u1", start=when(copy, 9)))
    assert len(copy.icloud.family()) == 1 and events(copy, "family_copy_moved") == 2


def test_an_event_rescheduled_after_its_copy_finished_is_copied_again(copy):
    read(copy, occ(uid="u1", start=when(copy, 1)))
    copy.advance(days=3)
    read(copy)
    read(copy, occ(uid="u1", start=when(copy, 4)))
    assert len(copy.icloud.family()) == 2


# -- when things go wrong ----------------------------------------------------------------------

def test_gmail_unread_is_not_a_failure(copy):
    copy.feeds.snapshot.feeds["a"].ahead = None
    read(copy)
    assert not events(copy, "family_copy_failed")


def test_a_copy_past_what_was_read_stays_on_the_record(copy):
    copy.feeds.ahead_days = 5
    read(copy, occ(uid="u1", start=when(copy, 4)))
    copy.feeds.ahead_days = 2
    keep_family_readable(copy)
    original = copy.fa.client.items_between

    def nothing_that_far_out(start, end, tz):
        out = original(start, end, tz)
        return caldav.Read([i for i in out.items if "School" in i.occ.summary], out.unreadable)
    copy.fa.client.items_between = nothing_that_far_out
    read(copy)
    read(copy)
    read(copy)
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "live"


def test_an_unreadable_event_on_family_means_no_removal_is_assumed(copy):
    event = occ(uid="u1", start=when(copy, 5))
    keep_family_readable(copy)
    read(copy, event)
    original = copy.fa.client.items_between

    def one_unreadable(start, end, tz):
        out = original(start, end, tz)
        return caldav.Read([i for i in out.items if "School" in i.occ.summary], 1)
    copy.fa.client.items_between = one_unreadable
    read(copy, event)
    read(copy, event)
    read(copy, event)
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "live"


def test_his_copy_back_after_one_bad_read_resets_the_count(copy):
    start = when(copy, 5)
    keep_family_readable(copy)
    path = seed(copy, "Sam - PT", start)
    event = occ(uid="u1", start=start)
    read(copy, event)
    saved = copy.icloud.events.pop(path)
    read(copy, event)
    copy.icloud.events[path] = saved
    read(copy, event)
    copy.icloud.events.pop(path)
    read(copy, event)
    assert copy.ledger.db.execute("SELECT state FROM family_copies").fetchone()[0] == "live"


def test_a_put_checks_the_calendar_name_first():
    icloud = FakeICloud(names={FAMILY_PATH: "Other"})
    out = client(icloud).put_copy("hx-1", "Sam - PT", WINDOW[0], WINDOW[1], datetime(2026, 11, 3, tzinfo=NY))
    assert out.kind == "mismatch" and "PUT" not in icloud.methods()


def test_removing_his_copy_refuses_an_event_with_people():
    icloud = FakeICloud()
    path = f"{FAMILY_PATH}x.ics"
    etag = icloud.seed(path, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nATTENDEE:mailto:p@example.com"
                             "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    assert client(icloud).remove_hand_copy(path, etag).kind == "changed"
    assert "DELETE" not in icloud.methods()


def test_family_unread_changes_nothing_and_says_so(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    copy.icloud.down = True
    read(copy, occ("Dentist", start=when(copy, 6)))
    read(copy)
    read(copy)
    copy.icloud.down = False
    assert len(copy.icloud.family()) == 1
    assert "couldn't read" in copy.ledger.get_meta(PROBLEM)


def test_a_wrong_calendar_name_writes_nothing(copy):
    copy.icloud.names = {FAMILY_PATH: "Not Family"}
    read(copy, occ(start=when(copy)))
    assert "PUT" not in copy.icloud.methods()


def test_gmail_unread_changes_nothing(copy):
    read(copy, occ(uid="u1", start=when(copy, 5)))
    feed = copy.feeds.snapshot.feeds["a"]
    feed.ahead = None
    read(copy)
    read(copy)
    feed.window = None
    read(copy)
    read(copy)
    assert len(copy.icloud.family()) == 1


def test_a_lost_answer_does_not_double_on_the_next_try(copy):
    event = occ(uid="u1", start=when(copy, 5))
    copy.icloud.drop_response_next = True
    read(copy, event)
    assert len(copy.icloud.family()) == 1 and "try again" in copy.ledger.get_meta(PROBLEM)
    read(copy, event)
    assert len(copy.icloud.family()) == 1
    assert copy.ledger.get_meta(PROBLEM) == ""


def test_a_uid_that_isnt_ours_is_not_taken(copy):
    from harness.family_copy import _key, _uid
    event = occ(uid="u1", start=when(copy, 5))
    copy.icloud.seed(f"{FAMILY_PATH}{_uid(_key(event))}.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    read(copy, event)
    assert "try again" in copy.ledger.get_meta(PROBLEM)


def test_a_refused_write_is_said_and_tried_again(copy):
    event = occ(uid="u1", start=when(copy, 5))
    copy.icloud.force_status = 403
    read(copy, event)
    assert "try again" in copy.copy.digest_line()
    read(copy, event)
    assert len(copy.icloud.family()) == 1


def test_at_most_so_many_writes_a_day(copy):
    read(copy, *[occ(f"PT {i}", start=when(copy, 2 + i)) for i in range(MAX_WRITES_PER_DAY + 3)])
    assert len(copy.icloud.family()) == MAX_WRITES_PER_DAY


def test_the_rest_go_the_next_day(copy):
    all_ = [occ(f"PT {i}", start=when(copy, 2 + i)) for i in range(MAX_WRITES_PER_DAY + 3)]
    read(copy, *all_)
    copy.advance(days=1)
    read(copy, *all_)
    assert len(copy.icloud.family()) == MAX_WRITES_PER_DAY + 3


def test_a_bug_here_does_not_stop_the_loop(copy, monkeypatch):
    monkeypatch.setattr(copy.copy, "_sync", lambda: 1 / 0)
    read(copy, occ(start=when(copy)))
    assert events(copy, "family_copy_failed") == 1


# -- what he hears ------------------------------------------------------------------------------

def test_the_digest_counts_and_names_nothing(copy):
    read(copy, occ("PT secret", uid="u1", start=when(copy, 5)))
    read(copy, occ("PT secret", uid="u1", start=when(copy, 7)))
    line = copy.copy.digest_line()
    assert "1 added" in line and "1 moved" in line and "secret" not in line


def test_the_digest_is_silent_when_nothing_happened(copy):
    assert copy.copy.digest_line() == ""


def test_status_says_how_it_is(copy):
    read(copy, occ(start=when(copy)))
    assert "1 on Family" in copy.copy.status_line()
    copy.feeds.snapshot = SimpleNamespace(feeds={})
    assert "on Family" in copy.copy.status_line()      # before today's first read
    copy.feeds.snapshot = SimpleNamespace(feeds={"a": SimpleNamespace(
        window=SimpleNamespace(calendar="Holidays"), ahead=None)})
    assert "secret iCal address" in copy.copy.status_line()
    copy.feeds.configured = False
    assert "secret iCal address" in copy.copy.status_line()
    copy.name = ""
    assert "first name" in copy.copy.status_line()


# -- the setting ---------------------------------------------------------------------------------

@pytest.mark.parametrize("body, name", [
    ('{"family_copy_name": "Sam"}', "Sam"), ('{"family_copy_name": " Sam "}', "Sam"),
    ('{"family_copy_name": "Mary Jo"}', "Mary Jo"), ('{"family_copy_name": "Ren\u00e9e"}', "Ren\u00e9e"),
    ('{"family_copy_name": ""}', ""), ('{}', ""), ('not json', ""), ('[1]', ""),
    ('{"family_copy_name": 5}', ""), ('{"family_copy_name": "evil.example"}', ""),
    ('{"family_copy_name": "Sam https://evil.example"}', ""), ('{"family_copy_name": "/resume"}', ""),
    ('{"family_copy_name": "Sam\\nX-THING:1"}', "")])
def test_only_a_plain_name_turns_it_on(tmp_path, body, name):
    (tmp_path / "options.json").write_text(body, encoding="utf-8")
    assert name_from_options(str(tmp_path)) == name


def test_no_settings_file_leaves_it_off(tmp_path):
    assert name_from_options(str(tmp_path)) == ""


def test_the_setting_is_declared_empty():
    text = (Path(__file__).resolve().parents[1] / "harness" / "config.yaml").read_text(encoding="utf-8")
    assert 'family_copy_name: ""' in text and "family_copy_name: str?" in text


def test_the_name_is_not_kept_with_the_keys():
    assert "family_copy_name" not in FIELDS


# -- the client ----------------------------------------------------------------------------------

def client(icloud=None):
    return caldav.FamilyCalDav(icloud or FakeICloud(), lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL))


WINDOW = datetime(2026, 11, 10, tzinfo=NY), datetime(2026, 11, 11, tzinfo=NY)


def test_the_read_never_uses_a_prop_filter_and_writes_nothing():
    icloud = FakeICloud()
    assert client(icloud).items_between(*WINDOW, TZ).items == []
    assert icloud.methods() == ["PROPFIND", "REPORT"]
    assert b"prop-filter" not in icloud.log[-1][3] and b"time-range" in icloud.log[-1][3]


def test_the_read_gives_where_each_event_lives():
    icloud = FakeICloud()
    now = datetime(2026, 11, 3, tzinfo=NY)
    c = client(icloud)
    assert c.put_copy("hx-1", "Sam - PT", WINDOW[0] + timedelta(hours=9), WINDOW[0] + timedelta(hours=10), now).kind == "ok"
    item = c.items_between(*WINDOW, TZ).items[0]
    assert item.href == f"{FAMILY_PATH}hx-1.ics" and item.etag == icloud.events[item.href][0]
    assert item.occ.summary == "Sam - PT"


@pytest.mark.parametrize("status, body", [(207, b"not xml"), (500, b'<D:multistatus xmlns:D="DAV:"/>')])
def test_a_read_answered_badly_is_none(status, body):
    icloud = FakeICloud()
    original = icloud.request

    def broken(method, url, **kw):
        out = original(method, url, **kw)
        return out if method != "REPORT" else type(out)(status, {}, body)
    icloud.request = broken
    assert client(icloud).items_between(*WINDOW, TZ) is None


def test_a_wrong_calendar_name_is_none_with_no_report():
    icloud = FakeICloud(names={FAMILY_PATH: "Other"})
    assert client(icloud).items_between(*WINDOW, TZ) is None
    assert "REPORT" not in icloud.methods()


def test_the_real_transport_lets_the_read_out_only_to_the_one_host():
    t = gated()
    t.request("REPORT", FAMILY_URL)
    assert t._opener.urls
    with pytest.raises(TransportError) as e:
        t.request("REPORT", "https://evil.example/x")
    assert e.value.kind == "blocked"


@pytest.mark.parametrize("href", ["/other/x.ics", f"{FAMILY_PATH}../x.ics", f"{FAMILY_PATH}x.txt"])
def test_removing_his_copy_stays_inside_the_calendar(href):
    icloud = FakeICloud()
    assert client(icloud).remove_hand_copy(href, '"e"').kind == "failed"
    assert "DELETE" not in icloud.methods()


def test_removing_his_copy_needs_the_version_just_read():
    icloud = FakeICloud()
    path = f"{FAMILY_PATH}x.ics"
    etag = icloud.seed(path, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    assert client(icloud).remove_hand_copy(path, '"old"').kind == "changed"
    assert path in icloud.events and "DELETE" not in icloud.methods()
    assert client(icloud).remove_hand_copy(path, etag).kind == "ok"
    assert path not in icloud.events


def test_a_put_to_a_changed_copy_is_refused():
    icloud = FakeICloud()
    now = datetime(2026, 11, 3, tzinfo=NY)
    c = client(icloud)
    c.put_copy("hx-1", "Sam - PT", WINDOW[0], WINDOW[1], now)
    assert c.put_copy("hx-1", "Sam - PT", WINDOW[0], WINDOW[1], now, etag='"old"').kind == "changed"
