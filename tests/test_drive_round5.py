"""The drive-leg planner after the review of 0.24.1's fourth round, through the real sync loop (fakes, no
network): an address's parts decide before map points; tomorrow's exact day end to end; his calendar is
the option, then the record, then the feed holding the add-on's blocks; a room or a class only takes the
school's address; online by its place's words only; a leg's wait counts are pruned; and a removal stays
named until a digest that names it is sent. All names are invented.
"""
import logging
from datetime import datetime, timedelta

import pytest

from harness import calendar_feed, drive, family_gmail, meaning_live, places
from harness.family_gmail import COMPUTED, COVERED, LEG_NO_ADDRESS, FamilyGmail
from harness.ledger import iso
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_drive_covered import (CM_ID, LOCATION, SCHOOL, assert_quiet, at_school, drive_blocks, go, outcomes,
                                school_day)
from test_drive_round3 import at, notes, school_on
from test_drive_round4 import restart, said, second_feed
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL, occ, when
from test_family_gmail import Feeds, g  # noqa: F401
from test_meaning_live import CLINIC, POINTS, blocks, drives, goes, live, M  # noqa: F401


def his_feed_shows_gmail(rig, feed="a"):
    """His Gmail feed as Google gives it now: every event on the calendar, each "<id>@google.com"."""
    window = rig.feeds.snapshot.feeds[feed].window
    window.occurrences = [occ("Errand", when(rig, days=20, hour=15))]
    for eid, e in rig.google.live().items():
        start, end = (datetime.fromisoformat(e[k]["dateTime"]) for k in ("start", "end"))
        window.occurrences.append(occ(e["summary"], start, hours=(end - start).total_seconds() / 3600,
                                      uid=f"{eid}@google.com"))


def ours(rig) -> set:
    return {r["event_id"] for r in rig.ledger.db.execute("SELECT event_id FROM family_gmail")}


def digest_sent(rig, sent=True):
    """The morning digest went out (daily.deliver's own record of it), or was held back."""
    with rig.ledger.tx() as db:
        rig.ledger.set_meta("last_digest_at", iso(rig.clock() + timedelta(seconds=1)), db)
        rig.ledger.set_meta("last_digest_sent", "yes" if sent else "no", db)
    rig.clock.advance(seconds=2)


# -- 1. the address's parts decide; points only confirm ------------------------------------------------

def test_the_parts_decide_before_the_points():
    near = ("-78.45,38.45", "-78.45,38.4509")                       # about 100 m apart
    assert not drive.same_place("Lyric Theatre\n231 N Lewis St, Lexington, VA 24450", SCHOOL, near)
    assert not drive.same_place("227 N Lewis Ave, Lexington, VA 24450", SCHOOL, ("-78.45,38.45",) * 2)
    # Neither the town nor the postcode on both sides: only kept points that agree make it one place.
    assert not drive.same_place("12 Main St", "12 Main St, Othertown")
    assert drive.same_place("12 Main St", "12 Main St, Othertown", ("-78.45,38.45", "-78.45,38.4502"))
    assert not drive.same_place("12 Main St", "12 Main St, Othertown", near)
    # Differing towns with an agreeing postcode are still one place.
    assert drive.same_place("227 N Lewis St, Lexington City, VA 24450", SCHOOL)
    # The cases from earlier rounds.
    for same in ("227 N Lewis Street, Lexington, VA 24450", "227 N Lewis St, 24450",
                 "227 N Lewis St, Unit 2, Lexington, VA 24450", "227 North Lewis St., Lexington, VA"):
        assert drive.same_place(same, SCHOOL), same
    # With no street address on a side, the points decide, within about 40 m.
    assert drive.same_place("Pine Hill Community School", SCHOOL, ("-78.45,38.45", "-78.45,38.4502"))
    assert not drive.same_place("Pine Hill Community School", SCHOOL, near)


THEATRE = "231 N Lewis St, Lexington, VA 24450"


def test_a_theatre_across_the_road_keeps_its_drives_and_its_earlier_block(drives, monkeypatch):
    school_on(drives)
    monkeypatch.setitem(POINTS, THEATRE, "-78.45,38.4509")         # about 100 m from the school
    drives.maps.minutes[frozenset({"home", THEATRE})] = 18
    start = when(drives, days=2, hour=13, minute=50)                 # ends ten minutes before the pickup
    at_school(drives, "Spring concert", start, location="Lyric Theatre\\n" + THEATRE)
    go(drives)
    go(drives)
    written = [("Busy (drive there)", start - 30 * M, start, ""),
               ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert drive_blocks(drives) == written
    school_day(drives, 2)                                            # pickup 3:00 to 3:45
    kept = drives.gm.drives
    kept._locate(SCHOOL)                                             # the school's point kept, as a run's lookup keeps it
    for _ in range(3):
        go(drives)
    assert kept.kept_point(THEATRE) and kept.kept_point(SCHOOL)      # both points known, and near
    assert drive._meters(kept.kept_point(THEATRE), kept.kept_point(SCHOOL)) > drive.SAME_POINT_METERS
    assert drive_blocks(drives) == written                           # the earlier block stays
    concert = said(drives, "Spring concert")
    assert outcomes(drives)[(concert, "back")] == COMPUTED
    assert "removed the drive" not in notes(drives) and "assumed at school" not in notes(drives)


# -- 2. tomorrow's exact day, end to end -------------------------------------------------------------

@pytest.fixture(params=["name and street", "name and the place book"])
def tomorrow_day(request, drives):
    """Tomorrow at 2:00 an event at school; the other component's "Busy (drive there)" before it, on his
    Gmail at his word; and a drive back the add-on wrote before the pickup came to be."""
    school_on(drives)
    if request.param == "name and street":
        location = LOCATION                                          # the school's name, then its street
    else:
        location = "Pine Hill Community School"
        checked, why = places.validate_rows({"rows": [{"place": location, "address": SCHOOL,
                                                       "said_on": "2026-11-01"}]})
        assert checked, why
        drives.live.places.import_rows(checked)
    start = when(drives, days=1, hour=14)
    # The other component's drive there, on Google as it put it there: no mark of ours.
    cm = {"id": CM_ID, "summary": "Busy (drive there)", "status": "confirmed", "etag": drives.google._etag(),
          "start": {"dateTime": (start - 30 * M).isoformat()}, "end": {"dateTime": start.isoformat()}}
    drives.google.events[CM_ID] = dict(cm)
    his_feed_shows_gmail(drives)
    at_school(drives, "Harvest share at school", start, location=location)
    go(drives)
    go(drives)
    his_feed_shows_gmail(drives)
    go(drives)
    assert ("Busy (drive back)", start + 60 * M, start + 90 * M, "") in blocks(drives)    # written before
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) in blocks(drives)
    assert drives.google.events[CM_ID] == cm
    drives.start, drives.cm = start, cm
    return drives


def test_tomorrow_end_to_end(tomorrow_day, caplog):
    rig, start = tomorrow_day, tomorrow_day.start
    school_day(rig, 1)                                               # the pickup, 3:00 to 3:45
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        for _ in range(3):
            go(rig)
            his_feed_shows_gmail(rig)
    assert ("Busy (school pickup)", start + 60 * M, start + 105 * M, "") in blocks(rig)
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) in blocks(rig)          # its address
    assert ("Busy (drive back)", start + 60 * M, start + 90 * M, "") not in blocks(rig)   # the pickup is it
    # The other component's block: untouched, never listed as ours, never deleted, never merged.
    assert rig.google.events[CM_ID] == rig.cm
    assert CM_ID not in ours(rig)
    listed, _ = rig.gm.google.list_ours(GMAIL, start - timedelta(days=1), start + timedelta(days=1))
    assert CM_ID not in {b.id for b in listed}
    assert not [c for c in rig.google.calls if CM_ID in c[1]]
    # Nothing written that the add-on's ledger doesn't hold (but its write check, made and taken off).
    probe = {k for k, v in rig.google.events.items() if v["summary"] == family_gmail.TEST_TITLE}
    assert set(rig.google.events) - {CM_ID} - probe <= ours(rig)
    assert all(c[1].rsplit("/", 1)[-1] in ours(rig) | probe for c in rig.google.writes() if c[0] != "POST")
    key = said(rig, "Harvest share at school")
    assert outcomes(rig)[(key, "there")] == COVERED and outcomes(rig)[(key, "back")] == COVERED
    line = f"removed the drive back for {at(start)}: the pickup is that drive"
    assert notes(rig).count(line) == 1
    assert "assumed" not in notes(rig)                               # the address matched
    removed = [r for r in caplog.records if "took off the Busy (drive back)" in r.getMessage()]
    assert len(removed) == 1
    # The digest goes; the next reads write nothing, and the digest is quiet.
    digest_sent(rig)
    written = len(rig.google.writes())
    for _ in range(2):
        go(rig)
        his_feed_shows_gmail(rig)
    assert len(rig.google.writes()) == written
    assert rig.gm.digest_line() == ""
    assert_quiet(rig)
    assert rig.google.events[CM_ID] == rig.cm


# -- 3. his calendar: the option, then the record, then the ids ----------------------------------------

def written_and_mirrored(rig):
    start = when(rig, days=3, hour=10)
    goes(rig, "Eye doctor", start, CLINIC)
    go(rig)
    go(rig)
    his_feed_shows_gmail(rig)
    go(rig)
    return blocks(rig)


def test_a_feed_holding_the_ids_never_overrides_the_record(drives):
    before = written_and_mirrored(drives)
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == GMAIL
    other = second_feed(drives)
    other.window.occurrences = list(drives.feeds.window.occurrences)  # the same ids in another feed
    drives.feeds.window.occurrences = [occ("Errand", when(drives, days=20, hour=15))]
    go(drives)
    go(drives)
    assert drives.gm._address() == GMAIL
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == GMAIL
    assert blocks(drives) == before
    drives.gm.his_fn = lambda: "other@gmail.com"                     # the option first, always
    assert drives.gm._address() == "other@gmail.com"


def test_two_feeds_holding_the_ids_stand_down_naming_both_and_delete_nothing(drives):
    before = written_and_mirrored(drives)
    with drives.ledger.tx() as db:                                   # no record
        drives.ledger.set_meta(family_gmail.HIS_CALENDAR, "", db)
    other = second_feed(drives)
    other.window.occurrences = list(drives.feeds.window.occurrences)
    written = len(drives.google.writes())
    for _ in range(3):
        go(drives)
        drives.tick()
        assert drives.gm._address() is None
        assert f"two calendars look like yours: other@gmail.com and {GMAIL}" in notes(drives)
    assert blocks(drives) == before and len(drives.google.writes()) == written
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == ""   # never picked
    assert len([s for s in drives.bot.sent if s[1].startswith("Two calendars")]) == 1


def configured(rig, *names):
    """The calendars on the Harness page, by address, each feed keyed as the reader keys it."""
    urls = [f"https://calendar.example/{n}.ics" for n in names]
    rig.feeds.urls = lambda: urls
    return [calendar_feed.feed_id(u) for u in urls]


def test_a_failed_read_waits_quietly_and_never_touches_the_record(drives):
    before = written_and_mirrored(drives)
    mine = drives.feeds.snapshot.feeds["a"]
    a, b = configured(drives, "his", "other")
    other = Feeds()
    other.window.calendar = "other@gmail.com"
    drives.feeds.snapshot.feeds = {b: other.snapshot.feeds["a"]}     # his feed's read failed: nothing read
    for n in range(family_gmail.HIS_RETRY_READS - 1):
        go(drives)
        drives.tick()
        assert "isn't read now" not in notes(drives), n
        assert not [s for s in drives.bot.sent if s[1].startswith("Your Gmail calendar")]
    go(drives)
    drives.tick()
    assert f"your calendar {GMAIL} (the one Harness's blocks are on) isn't read now" in notes(drives)
    assert len([s for s in drives.bot.sent if s[1].startswith("Your Gmail calendar")]) == 1
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == GMAIL
    assert blocks(drives) == before
    drives.feeds.snapshot.feeds[a] = mine                            # read again
    go(drives)
    assert drives.gm._address() == GMAIL and blocks(drives) == before


def test_a_calendar_missing_from_the_page_is_said_at_once(drives):
    written_and_mirrored(drives)
    (b,) = configured(drives, "other")
    other = Feeds()
    other.window.calendar = "other@gmail.com"
    drives.feeds.snapshot.feeds = {b: other.snapshot.feeds["a"]}
    go(drives)
    drives.tick()
    assert f"your calendar {GMAIL} (the one Harness's blocks are on) isn't read now" in notes(drives)


def test_the_uid_form_is_logged_once_and_one_gmail_feed_is_taken_without_ids(drives, caplog):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)                                                       # one Gmail feed, no ids seen in it
    assert drives.gm._address() == GMAIL and len(blocks(drives)) == 3
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        his_feed_shows_gmail(drives)
        go(drives)
        go(drives)
    said_form = [r.getMessage() for r in caplog.records if "their ids in the form" in r.getMessage()]
    assert said_form == ["family to gmail: Harness's own blocks found in a calendar read, their ids in the "
                         "form <id>@google.com"]


# -- 4. only a room or a class takes the school's address -------------------------------------------------

def test_the_room_rule_has_no_short_name_branch():
    for room in ("Room 12", "Gym", "Hall", "Library", "Cafeteria", "Classroom 4B", "Auditorium", "Lab",
                 "Office", "Playground", "Field", "Court", "Mrs Lee's class", "Year 4", "Reception", "Grade 3"):
        assert meaning_live.room_like(room), room
    for place in ("Pizza Express", "The Red Lion", "St Mary's", "Grandma's", "The Assembly Rooms"):
        assert not meaning_live.room_like(place), place


@pytest.mark.parametrize("location", ["Pizza Express", "The Red Lion", "St Mary's", "Grandma's",
                                      "The Assembly Rooms"])
def test_a_short_name_that_isnt_a_room_doesnt_drive_to_the_school(drives, location):
    school_on(drives)
    start = when(drives, days=2, hour=18)
    at_school(drives, "End of term party", start, location=location)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == []
    assert sorted(outcomes(drives).values()) == [LEG_NO_ADDRESS, LEG_NO_ADDRESS]
    assert f"couldn't find a drive to the event at {at(start)}" in notes(drives)
    assert "school's address assumed" not in notes(drives)


# -- 5. online words ---------------------------------------------------------------------------------------

def test_the_online_words():
    for place in ("Webinar", "Livestream", "Live stream link to follow", "Teams", "Teams meeting", "On Meet",
                  "Microsoft Teams", "MS Teams", "Google Meet"):
        assert meaning_live.online_place(place), place
    for place in ("Away teams pitch", "Meet at the gate", "Meet the teacher", "Teams room, 2 Clinic Rd"):
        assert not meaning_live.online_place(place), place


# -- 6. wait counts pruned, and a removal named until a sent digest names it ---------------------------------

def counts(rig) -> dict:
    import json
    return json.loads(rig.ledger.get_meta(family_gmail.WAIT_COUNTS) or "{}")


def test_a_wait_count_goes_once_its_leg_resolves_and_survives_a_restart(drives, monkeypatch):
    start = when(drives, days=5, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    real = drives.gm.drives.between
    stuck = {"on": True}
    monkeypatch.setattr(drives.gm.drives, "between",
                        lambda a, b: drive.LATER if stuck["on"] and CLINIC in (a, b) else real(a, b))
    go(drives)
    go(drives)
    assert counts(drives) and set(counts(drives).values()) == {1}
    restart(drives)
    monkeypatch.setattr(drives.gm.drives, "between",
                        lambda a, b: drive.LATER if stuck["on"] and CLINIC in (a, b) else real(a, b))
    go(drives)
    assert set(counts(drives).values()) == {2}                       # kept across the restart
    stuck["on"] = False
    go(drives)
    assert counts(drives) == {}                                      # resolved: pruned
    assert len(drive_blocks(drives)) == 2


def test_a_wait_count_goes_once_its_event_has_passed_and_one_not_seen_stays(drives):
    import json
    goes(drives, "Eye doctor", when(drives, days=3, hour=10), CLINIC)
    past = iso(drives.clock() - timedelta(hours=1))
    ahead = iso(drives.clock() + timedelta(days=9))
    with drives.ledger.tx() as db:
        drives.ledger.set_meta(family_gmail.WAIT_COUNTS, json.dumps(
            {f"gone|{past}|there": 2, f"later|{ahead}|back": 1}), db)
    go(drives)
    go(drives)
    assert counts(drives) == {f"later|{ahead}|back": 1}


def test_a_removal_is_named_until_a_digest_naming_it_is_sent(drives):
    school_on(drives)
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location=SCHOOL)
    go(drives)
    go(drives)
    school_day(drives, 2)
    for _ in range(3):
        go(drives)
    line = f"removed the drive back for {at(start)}: the pickup is that drive"
    assert notes(drives).count(line) == 1
    digest_sent(drives, sent=False)                                  # held back: not sent
    go(drives)
    assert notes(drives).count(line) == 1
    assert drives.ledger.get_meta(family_gmail.RUN_PENDING)
    digest_sent(drives)                                              # sent, after the compose that named it
    go(drives)
    assert line not in notes(drives)
    assert not drives.ledger.get_meta(family_gmail.RUN_PENDING)


def test_a_removal_after_the_compose_waits_for_the_next_digest(drives):
    school_on(drives)
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location=SCHOOL)
    go(drives)
    go(drives)
    assert notes(drives) is not None                                 # a digest composed: nothing to name yet
    school_day(drives, 2)
    for _ in range(3):
        go(drives)                                                   # the removal lands after that compose
    with drives.ledger.tx() as db:                                   # and then the digest is delivered
        drives.ledger.set_meta("last_digest_at", iso(drives.clock()), db)
        drives.ledger.set_meta("last_digest_sent", "yes", db)
    line = f"removed the drive back for {at(start)}: the pickup is that drive"
    assert notes(drives).count(line) == 1                            # still to be named
