"""The drive-leg planner after the review of 0.24.1's third round, through the real sync loop (fakes, no
network): where an event is rests on its own address before the "school" label; a school event's room gets
the school's address and says so, a place of its own nothing knows doesn't; an event is online only when
its place says so; a drive taken off for a school run is named once; a chain skips what has no place; a
leg's waits are its own and survive a restart; and his calendar is the one holding the add-on's blocks.
All names are invented.
"""
from datetime import timedelta

import pytest

from harness import drive, family_gmail, meaning_live
from harness.family_gmail import COMPUTED, COVERED, LEG_FAILED, LEG_NO_ADDRESS, ONLINE, FamilyGmail
from harness.ledger import iso
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_drive_covered import SCHOOL, at_school, drive_blocks, drive_cards_sent, go, outcomes, school_day
from test_drive_round3 import at, mirror, notes, school_on
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL, when
from test_family_gmail import Feeds, g  # noqa: F401
from test_meaning_live import CLINIC, PARK, POINTS, blocks, drives, goes, live, M  # noqa: F401


def said(rig, title):
    return next(k for k in rig.gm.live._why if rig.gm.live._why[k]["said"] == title)


# -- 1. an address that resolves decides, before the label ---------------------------------------------

def test_the_address_parts():
    for same in ("227 N Lewis Street, Lexington, VA 24450", "227 North Lewis St., Lexington, VA",
                 "227 N Lewis St, 24450", "Pine Hill School\n227 N Lewis St, Suite 4, Lexington, VA 24450",
                 "227 N Lewis St Lexington VA 24450"):
        assert drive.same_place(same, SCHOOL), same
    for other in ("12 Oak St, Lexington, VA 24450", "229 N Lewis St, Lexington, VA 24450",
                  "227 N Lewis St, Staunton, VA 24401", "227 S Lewis St, Lexington, VA 24450", ""):
        assert not drive.same_place(other, SCHOOL), other
    assert drive.same_place("38.45, -78.45", "38.4502, -78.4501")                  # within the radius (40 m since round 5)
    assert not drive.same_place("38.45, -78.45", "38.46, -78.45")
    assert drive.same_place("Riverside Hall", "riverside  hall")                     # the last resort


@pytest.fixture(params=["ends before the pickup", "starts after the pickup"])
def labelled_elsewhere(request, drives):
    """A school event (labelled so) at a theatre across town, its drive back or there written before the
    school day came: then the pickup (3:00 to 3:45) is ten minutes from it, and crosses that leg."""
    school_on(drives)
    if request.param == "ends before the pickup":
        start, leg = when(drives, days=2, hour=13, minute=50), "back"
    else:
        start, leg = when(drives, days=2, hour=15, minute=55), "there"
    at_school(drives, "Spring concert", start, location="Lyric Theatre, " + CLINIC)
    go(drives)
    go(drives)
    written = {"there": ("Busy (drive there)", start - 30 * M, start, ""),
               "back": ("Busy (drive back)", start + 60 * M, start + 90 * M, "")}
    assert drive_blocks(drives) == [written["there"], written["back"]]
    school_day(drives, 2)
    drives.start, drives.leg, drives.written = start, leg, written
    return drives


def test_a_school_event_at_another_street_keeps_its_drives_beside_the_pickup(labelled_elsewhere):
    rig = labelled_elsewhere
    for _ in range(3):
        go(rig)
    assert drive_blocks(rig) == [rig.written["there"], rig.written["back"]]       # the earlier block stays
    assert ("Busy (school pickup)", when(rig, days=2, hour=15), when(rig, days=2, hour=15, minute=45), "") \
        in blocks(rig)
    concert = said(rig, "Spring concert")
    assert outcomes(rig)[(concert, rig.leg)] == COMPUTED
    assert f"the drive for the event at {at(rig.start)} crosses a school run block" in notes(rig)
    assert "assumed at school" not in notes(rig) and "removed the drive" not in notes(rig)


@pytest.mark.parametrize("location", [
    "Pine Hill Community School\\n227 N Lewis Street, Lexington, VA 24450",      # Street, not St
    "227 N Lewis St, Lexington, VA",                                               # no postcode on this side
    "227 N Lewis St, Unit 2, Lexington, VA 24450",                                 # a unit
])
def test_the_schools_address_said_another_way_is_still_school(drives, monkeypatch, location):
    school_on(drives)
    monkeypatch.setitem(POINTS, drive.street_address(location), POINTS[SCHOOL])   # the map: one place
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location=location)
    school_day(drives, 2)                                                          # pickup 3:00 to 3:45
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 30 * M, start, "")]
    key = said(drives, "Harvest share")
    assert outcomes(drives)[(key, "back")] == COVERED
    assert "assumed at school" not in notes(drives)                                # by its address


def test_a_cover_resting_on_the_label_is_named(drives):
    school_on(drives)
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location="")                         # no place of its own
    school_day(drives, 2)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 30 * M, start, "")]
    assert f"left off: assumed at school for {at(start)}" in notes(drives)


# -- 2. the school's address only for a room ------------------------------------------------------------

def test_an_off_site_venue_nothing_knows_has_no_address(drives):
    school_on(drives)
    start = when(drives, days=2, hour=10)
    at_school(drives, "Swim gala", start, location="Riverside Leisure Centre")
    go(drives)
    go(drives)
    assert drive_blocks(drives) == []
    assert sorted(outcomes(drives).values()) == [LEG_NO_ADDRESS, LEG_NO_ADDRESS]
    assert f"couldn't find a drive to the event at {at(start)}" in notes(drives)
    assert "school's address assumed" not in notes(drives)


@pytest.mark.parametrize("location", ["Room 12", "Gym", "Library", "", "Mrs Lee's class"])
def test_a_room_takes_the_schools_address_and_says_so(drives, location):
    school_on(drives)
    start = when(drives, days=2, hour=10)
    at_school(drives, "Class visit", start, location=location)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                                    ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert f"the school's address assumed for the event at {at(start)}" in notes(drives)


def test_the_room_rule():
    for room in ("Room 12", "Gym", "Library", "Cafeteria", "Classroom 4B", "Virtual Reality Lab, Room 4",
                 "Main Hall", "School Hall", "Mrs Lee's class"):
        assert meaning_live.room_like(room), room
    for place in ("Riverside Leisure Centre", "Lyric Theatre", "St Mark's Church Hall", "12 Oak Rd",
                  "Lexington High School", "Lexington High School Gym", "Hall at 400 Main"):
        assert not meaning_live.room_like(place), place


# -- 3. online only when the place says so -------------------------------------------------------------

@pytest.mark.parametrize("title,location", [
    ("Online safety evening", "School Hall"),                       # the parents' evening, in the hall
    ("Parents evening", "Virtual Reality Lab, Room 4"),
    ("Zoom club", "Pine Hill Community School\\n227 N Lewis St, Lexington, VA  24450, United States"),
])
def test_a_title_word_beside_a_room_or_street_keeps_the_drives(drives, title, location):
    school_on(drives)
    start = when(drives, days=2, hour=18)
    at_school(drives, title, start, location=location)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                                    ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert "online" not in notes(drives)


def test_a_street_beside_zoom_away_from_school_keeps_the_place_and_drives(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, "Zoom call, " + CLINIC)
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                              ("Busy (family)", start, start + 60 * M, CLINIC),
                              ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]


@pytest.mark.parametrize("location", ["Online", "Zoom meeting", "https://zoom.us/j/123456", "Virtual - link to follow"])
def test_a_place_that_only_says_online_is_online_and_named_once(drives, location):
    start = when(drives, days=2, hour=10)
    goes(drives, "Coach check-in", start, location)
    for _ in range(3):
        go(drives)
    assert drive_blocks(drives) == []
    assert sorted(outcomes(drives).values()) == [ONLINE, ONLINE]
    assert notes(drives).count(f"no drive: online, {at(start)}") == 1


def test_the_online_rule():
    for place in ("Online", "online only", "Zoom meeting", "Google Meet", "https://meet.google.com/abc",
                  "Zoom: https://zoom.us/j/1"):
        assert meaning_live.online_place(place), place
    for place in ("Virtual Reality Lab, Room 4", "School Hall", "Zoom call, 2 Clinic Rd", "Online Cafe"):
        assert not meaning_live.online_place(place), place


# -- 4. a removal for a school run is named once ----------------------------------------------------------

def test_a_drive_block_taken_off_for_the_pickup_is_named_once(drives):
    school_on(drives)
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location=SCHOOL)
    go(drives)
    go(drives)
    assert ("Busy (drive back)", start + 60 * M, start + 90 * M, "") in blocks(drives)
    school_day(drives, 2)
    for _ in range(3):
        go(drives)
    line = f"removed the drive back for {at(start)}: the pickup is that drive"
    assert ("Busy (drive back)", start + 60 * M, start + 90 * M, "") not in blocks(drives)
    assert notes(drives).count(line) == 1
    drives.ledger.set_meta("last_digest_at", iso(drives.clock() + timedelta(seconds=1)))   # the digest went
    go(drives)
    assert line not in notes(drives)


# -- 5. a chain only of events with a place ----------------------------------------------------------------

def test_an_online_event_between_two_is_no_stop_and_the_first_drives_home(drives):
    a, b, c = (when(drives, days=3, hour=9), when(drives, days=3, hour=10, minute=30),
               when(drives, days=3, hour=13))
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Coach check-in", b, "https://zoom.us/j/123")
    goes(drives, "Swim lesson", c, PARK)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", a - 30 * M, a, ""),
                                    ("Busy (drive back)", a + 60 * M, a + 90 * M, ""),    # home
                                    ("Busy (drive there)", c - 30 * M, c, ""),
                                    ("Busy (drive back)", c + 60 * M, c + 90 * M, "")]
    assert outcomes(drives)[(said(drives, "Coach check-in"), "back")] == ONLINE


# -- 6. a leg's waits are its own ----------------------------------------------------------------------------

POOLS = [f"{n} Pool Ln, Town, VA" for n in (1, 2, 3)]


def restart(rig):
    old = rig.gm
    rig.gm = FamilyGmail(old.ledger, old.fa, old.calendar, old.google, rules_fn=old.rules_fn,
                         school_fn=old.school_fn, said_fn=old.said_fn, drives=old.drives, tz=old.tz,
                         live=old.live, live_fn=old.live_fn, own_days_fn=old.own_days_fn,
                         own_dry_fn=old.own_dry_fn, cleanup_fn=old.cleanup_fn, his_fn=old.his_fn)
    rig.c.family_gmail = rig.gm


@pytest.mark.parametrize("restarted", [False, True])
def test_a_stuck_leg_beside_lookups_that_get_through_is_named_at_its_third_wait(drives, monkeypatch, restarted):
    """The eye doctor's lookups never get through. Beside it, at each read another event's lookup waits
    one read and then gets through, so the waiting queue always moves: the eye doctor's count is still
    its own, and at its third wait it's named (with a restart between reads too)."""
    for n, pool in enumerate(POOLS):
        monkeypatch.setitem(POINTS, pool, f"-78.2{n + 1},38.2{n + 1}")
        drives.maps.minutes[frozenset({"home", pool})] = 20
    start = when(drives, days=5, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    for n, pool in enumerate(POOLS):
        goes(drives, f"Swim lesson {n}", when(drives, days=6 + n, hour=10), pool)
    blocked: set = set()
    real = drives.gm.drives.between
    monkeypatch.setattr(drives.gm.drives, "between", lambda a, b: drive.LATER
                        if CLINIC in (a, b) or blocked & {a, b} else real(a, b))
    go(drives)                                                          # judged
    for n in range(2):
        blocked.clear()
        blocked.add(POOLS[n])                                           # this one waits a read, then goes
        go(drives)
        assert "couldn't look up" not in notes(drives), n
        if restarted:
            restart(drives)
    blocked.clear()
    blocked.add(POOLS[2])
    go(drives)
    drives.tick()
    eye = said(drives, "Eye doctor")
    assert outcomes(drives)[(eye, "there")] == LEG_FAILED and outcomes(drives)[(eye, "back")] == LEG_FAILED
    assert f"couldn't look up the drive for the event at {at(start)}" in notes(drives)
    assert len(drive_cards_sent(drives)) == 1
    lesson = said(drives, "Swim lesson 0")
    assert outcomes(drives)[(lesson, "there")] == COMPUTED                  # the others got through


# -- 7. his calendar: the one holding the add-on's blocks ----------------------------------------------------

def second_feed(rig, calendar="other@gmail.com"):
    second = Feeds()
    second.window.calendar = calendar
    rig.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    return second


def test_two_feeds_and_no_record_settle_on_the_one_holding_the_blocks(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    before = blocks(drives)
    mirror(drives)
    with drives.ledger.tx() as db:                                      # a fresh install: no record
        drives.ledger.set_meta(family_gmail.HIS_CALENDAR, "", db)
    second_feed(drives)
    go(drives)
    go(drives)
    assert drives.gm._address() == GMAIL
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == GMAIL
    assert blocks(drives) == before
    assert (f"other@gmail.com and {GMAIL} both look like your Gmail calendar; using {GMAIL}, the one "
            "Harness's blocks are on") in notes(drives)


def test_the_option_wins_over_the_record(drives):
    other = second_feed(drives)
    with drives.ledger.tx() as db:
        drives.ledger.set_meta(family_gmail.HIS_CALENDAR, GMAIL, db)
    drives.gm.his_fn = lambda: "Other@gmail.com"
    assert drives.gm._address() == "other@gmail.com"
    assert drives.gm._his_feed()[1].window is other.window


def test_a_recorded_calendar_not_read_stands_down_with_one_notice(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    mirror(drives)
    go(drives)
    assert drives.ledger.get_meta(family_gmail.HIS_CALENDAR) == GMAIL
    before = blocks(drives)
    other = second_feed(drives)
    drives.feeds.snapshot.feeds["a"] = other.snapshot.feeds["a"]       # his own isn't read now
    del drives.feeds.snapshot.feeds["b"]
    for _ in range(3):
        go(drives)
        drives.tick()
        assert f"your calendar {GMAIL} (the one Harness's blocks are on) isn't read now" in notes(drives)
    assert drives.gm._address() is None
    assert blocks(drives) == before                                     # nothing written anywhere else
    assert len([s for s in drives.bot.sent if s[1].startswith("Your Gmail calendar")]) == 1


def test_his_calendar_option_reads_as_text(tmp_path):
    (tmp_path / "options.json").write_text('{"his_calendar": " me@gmail.com "}')
    assert family_gmail.his_calendar_from_options(str(tmp_path)).strip() == "me@gmail.com"
    (tmp_path / "options.json").write_text("{}")
    assert family_gmail.his_calendar_from_options(str(tmp_path)) == ""

