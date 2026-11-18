"""Drive legs that something else already is, and every leg's outcome (0.24.2).

The day from the review of 0.24.1, through the real sync loop (fakes, no network): his own appointment
at 11:30 (its drives only in the dry run's log), at 1:30 a "Busy (drive there)" another part of this
system put on Gmail at his word ("cm" and 32 hex digits), at 2:00 the family block of a school event
judged at school whose location is the school's name and then its street, and at 3:00 the add-on's own
school pickup, which is the drive home. All names are invented.
"""
import hashlib
import logging
from datetime import timedelta
from urllib.parse import urlsplit

import pytest

from harness import drive, family_gmail, places
from harness.family_gmail import COMPUTED, COVERED, LEG_FAILED, SKIPPED, leg_key
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_copy import occ, when
from test_family_gmail import Feeds, g  # noqa: F401
from test_meaning_live import (CLINIC, NY, POINTS, PARK, _ics, answer_ex, blocks, drives, goes, judged,  # noqa: F401
                               live, ob, M)
from test_meaning_live import go as go_

SCHOOL = "227 N Lewis St, Lexington, VA 24450"
LOCATION = "Pine Hill Community School\\n227 N Lewis St, Lexington, VA  24450, United States"
CM_ID = "cm" + hashlib.sha256(b"calendar_change:drive there").hexdigest()[:32]


def go(rig):
    go_(rig)


def drive_cards_sent(rig):
    return [s for s in rig.bot.sent if s[1].startswith("No drive blocks")]


def failing_cards(rig):
    return rig.ledger.db.execute("SELECT key FROM drive_cards WHERE ask IN ('failing','asked')").fetchall()


def drive_blocks(rig):
    return [b for b in blocks(rig) if b[0].startswith(("Busy (drive", "Maybe busy (drive"))]


def outcomes(rig):
    """Each leg's outcome at the last read, by (event key, leg): the tests' events don't repeat."""
    return {(k, w): o for (k, _, w), o in rig.gm._leg_outcomes.items()}


def assert_quiet(rig, cards_before=0):
    """No leg reported failed, no digest line about a missing drive, and no card for one."""
    got = outcomes(rig)
    assert LEG_FAILED not in got.values(), got
    note = rig.gm.digest_line() or ""
    assert "couldn't look up" not in note and "drive block is missing" not in note, note
    assert len(drive_cards_sent(rig)) == cards_before
    assert not failing_cards(rig)


def school_day(rig, day, start_hour=8, start_minute=15, hours=7):
    """The kids' school day on Family, judged a school run of his: drop-off and pickup blocks."""
    start = when(rig, days=day, hour=start_hour, minute=start_minute)
    title = "School day"
    uid = "day-" + hashlib.sha256(f"{title}{start}".encode()).hexdigest()[:12]
    rig.icloud.seed(f"{FAMILY_PATH}{uid}.ics", _ics(uid, title, start, hours, ""))
    eid = answer_ex(rig, title, ["transport"])
    rig.judge.by[title] = judged(ob("transport", start, start + timedelta(hours=hours), place="school"),
                                 cites=[eid])
    return start


def at_school(rig, title, start, location=LOCATION, hours=1, extra=()):
    uid = "school-" + hashlib.sha256(title.encode()).hexdigest()[:12]
    ics = _ics(uid, title, start, hours, location)
    if extra:
        ics = ics.replace("END:VEVENT", "\r\n".join([*extra, "END:VEVENT"]))
    rig.icloud.seed(f"{FAMILY_PATH}{uid}.ics", ics)
    eid = answer_ex(rig, title, ["presence"])
    rig.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=hours), place="school"), cites=[eid])
    return uid


# -- tomorrow, as the review read it ---------------------------------------------------------------

@pytest.fixture
def tomorrow(drives, monkeypatch):
    """Before the upgrade: the family block written with no address (its two-line location not read
    yet), the pickup written, the drive there on Gmail by his go, his 11:30 appointment."""
    POINTS[SCHOOL] = "-78.45,38.45"
    drives.maps.minutes[frozenset({"home", SCHOOL})] = 18              # rounded up: 30 minutes
    drives.gm.own_dry_fn = lambda: True                                # his appointments: log only
    start = when(drives, days=1, hour=14)
    school_day(drives, 1)                                              # pickup 3:00 to 3:45
    at_school(drives, "Harvest share at school", start)
    drives.feeds.window.occurrences = [
        occ("Errand", when(drives, days=20, hour=15)),
        occ("Dentist", when(drives, days=1, hour=11, minute=30), location="The Clinic, " + CLINIC),
        occ("Busy (drive there)", start - 30 * M, hours=0.5, uid=CM_ID + "@google.com")]
    real = drive.street_address
    monkeypatch.setattr(drive, "street_address", lambda p: "" if "Lewis" in (p or "") else real(p))
    go(drives)
    go(drives)
    assert ("Busy (family)", start, start + 60 * M, "") in blocks(drives)          # as written before
    assert ("Busy (school pickup)", start + 60 * M, start + 105 * M, "") in blocks(drives)
    assert not drive_blocks(drives)
    monkeypatch.setattr(drive, "street_address", real)
    # 0.24.0 never asked about this event: what this build's reads under the old parse said (no address,
    # and no school address set here) is cleared, as it never happened.
    with drives.ledger.tx() as db:
        db.execute("DELETE FROM drive_cards")
    drives.bot.sent.clear()
    drives.start = start
    return drives


def test_tomorrow_sets_the_address_and_writes_no_drive_beside_the_pickup_or_his_drive(tomorrow, caplog):
    start = tomorrow.start
    before = len(tomorrow.google.writes())
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        go(tomorrow)
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) in blocks(tomorrow)    # the address, once
    assert not drive_blocks(tomorrow)                                              # no drive there or back
    assert len(tomorrow.google.writes()) == before + 1                             # the address and nothing else
    key = next(k for (k, w), o in outcomes(tomorrow).items() if w == "back" and o == COVERED)
    assert outcomes(tomorrow)[(key, "there")] == COVERED                    # his drive on Gmail
    assert_quiet(tomorrow)
    assert not [r for r in caplog.records if "no drive blocks for" in r.getMessage()]
    said = [r.getMessage() for r in caplog.records if "no drive " in r.getMessage()]
    assert any("no drive back" in m and "school run" in m for m in said), said
    assert any("no drive there" in m and "already on Gmail" in m for m in said), said
    # A later read writes nothing, and says nothing again.
    caplog.clear()
    after = len(tomorrow.google.writes())
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        go(tomorrow)
        go(tomorrow)
    assert len(tomorrow.google.writes()) == after
    assert not [r for r in caplog.records if "no drive " in r.getMessage()]
    assert_quiet(tomorrow)


def test_a_drive_block_he_deleted_stays_deleted_after_the_upgrade(tomorrow):
    """The upgrade's replay: one read sets the address and writes nothing else; a drive he deleted
    (here the morning's drive to an appointment of Family) isn't put back."""
    start = tomorrow.start
    other = when(tomorrow, days=2, hour=10)
    goes(tomorrow, "Eye doctor", other, CLINIC)
    go(tomorrow)
    go(tomorrow)
    there = next(k for k, e in tomorrow.google.live().items() if e["summary"] == "Busy (drive there)")
    tomorrow.google.events[there]["status"] = "cancelled"
    tomorrow.google.events[there]["etag"] = tomorrow.google._etag()
    for _ in range(3):
        go(tomorrow)
    assert [b[0] for b in drive_blocks(tomorrow)] == ["Busy (drive back)"]
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) in blocks(tomorrow)


def test_a_drop_off_ending_as_an_event_starts_is_its_drive_there(drives):
    POINTS[SCHOOL] = "-78.45,38.45"
    drives.maps.minutes[frozenset({"home", SCHOOL})] = 18
    school_day(drives, 2)                                              # drop-off 7:45 to 8:30
    start = when(drives, days=2, hour=8, minute=30)
    at_school(drives, "Class breakfast", start)
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive back)"]
    assert ("Busy (drive back)", start + 60 * M, start + 90 * M, "") in blocks(drives)
    there = [o for (k, w), o in outcomes(drives).items() if w == "there"]
    assert there == [COVERED]
    assert_quiet(drives)


def test_a_school_run_far_from_the_event_keeps_its_drives(drives):
    school_day(drives, 2)                                              # pickup 3:00 to 3:45
    start = when(drives, days=2, hour=17)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


@pytest.mark.parametrize("which,run_start,run_end,leg,cover", [
    ("back", 15 * 60, 15 * 60 + 45, (14 * 60 + 60, 14 * 60 + 90), True),       # starts as it ends
    ("back", 15 * 60 + 15, 16 * 60, (15 * 60, 15 * 60 + 30), True),            # crosses the leg
    ("back", 15 * 60 + 40, 16 * 60, (15 * 60, 15 * 60 + 30), False),           # 40 minutes on
    ("there", 13 * 60, 13 * 60 + 50, (13 * 60 + 30, 14 * 60), True),           # crosses the leg
    ("there", 12 * 60, 13 * 60 + 46, (13 * 60 + 50, 14 * 60), True),           # ends 14 minutes before
    ("there", 12 * 60, 13 * 60, (13 * 60 + 30, 14 * 60), False),               # an hour before
])
def test_the_school_run_rule(which, run_start, run_end, leg, cover):
    from datetime import datetime
    day = datetime(2026, 11, 19, tzinfo=NY)
    at = lambda m: day + timedelta(minutes=m)
    event = family_gmail.Want("e", "Busy (family)", at(14 * 60), at(15 * 60))
    run = family_gmail.Want("r", "Busy (school pickup)", at(run_start), at(run_end))
    assert family_gmail._run_covers(which, event, at(leg[0]), at(leg[1]), [run], True) is cover
    assert family_gmail._run_covers(which, event, at(leg[0]), at(leg[1]), [run], False) is False   # not at school


# -- every leg's outcome: only one with none is a failure ------------------------------------------

def skip(rig, title):
    key = next(r["key"] for r in rig.ledger.db.execute("SELECT key, said FROM drive_cards") if r["said"] == title)
    with rig.ledger.tx() as db:
        db.execute("UPDATE drive_cards SET ask='skipped' WHERE key=?", (key,))
    return key


def test_a_skipped_event_never_enters_the_days_and_its_legs_are_skipped(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    key = skip(drives, "Eye doctor")
    go(drives)
    go(drives)
    assert drive_blocks(drives) == []
    assert outcomes(drives)[(key, "there")] == SKIPPED
    assert outcomes(drives)[(key, "back")] == SKIPPED
    assert_quiet(drives)


def test_a_skipped_last_event_of_the_day_leaves_the_one_before_its_drive_home(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    go(drives)
    go(drives)
    key = skip(drives, "Swim lesson")
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", a - 30 * M, a, ""),
                                    ("Busy (drive back)", a + 60 * M, a + 90 * M, "")]
    assert outcomes(drives)[(key, "back")] == SKIPPED
    assert_quiet(drives)


def test_an_event_already_under_way_is_not_a_failure(drives):
    now = drives.clock().astimezone(NY)
    start = now - 30 * M
    goes(drives, "Eye doctor", start, CLINIC, hours=2)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive back)", start + 120 * M, start + 150 * M, "")]
    assert_quiet(drives)


def test_a_chained_pair_ending_the_day_is_not_a_failure(drives):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    go(drives)
    go(drives)
    assert [x[0] for x in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive there)", "Busy (drive back)"]
    assert sorted(outcomes(drives).values()) == sorted([COMPUTED, COVERED, COMPUTED, COMPUTED])
    assert_quiet(drives)


# -- his calendar, chosen once ---------------------------------------------------------------------

def test_two_gmail_feeds_leave_every_leg_and_warn_once(drives, caplog):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ("Drive to the clinic", start - 30 * M, hours=0.5))
    second = Feeds()
    second.window.calendar = "other@gmail.com"
    drives.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    gm = drives.gm
    event = family_gmail.Want("e", "Busy (family)", start, start + 60 * M, "me", place=CLINIC)
    with caplog.at_level(logging.WARNING, logger="harness.family_gmail"):
        assert gm._his_drives() == []
        assert gm._leg_cover("there", event, start - 30 * M, start, [], gm._his_drives()) == ""
        assert gm._his_feed() is None and gm._address() is None
        go(drives)
    warned = [r for r in caplog.records if "look like his Gmail calendar" in r.getMessage()]
    assert len(warned) == 1
    del drives.feeds.snapshot.feeds["b"]
    assert gm._his_feed() is not None
    assert len(gm._his_drives()) == 1                                    # one feed again: his drive counts


# -- his own drives on Gmail -----------------------------------------------------------------------

@pytest.mark.parametrize("title", ["Test drive at the dealer", "Driving lesson", "Blood drive at church",
                                   "Food drive drop-off", "Drive-in movie", "Google Drive cleanup",
                                   "Lunch at 400 Park Drive", "Travel soccer"])
def test_a_title_that_only_shares_the_word_keeps_the_drive(drives, title):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ(title, start - 30 * M, hours=0.5))
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


def test_a_short_crossing_of_another_drive_keeps_the_drive(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    # Takes Sam to practice from 9:00 to 9:40: ten minutes of the half-hour drive, ending 20 before.
    drives.feeds.window.occurrences.append(occ("Drive Sam to practice", start - 60 * M, hours=40 / 60))
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


def test_a_drive_this_system_put_on_gmail_is_the_drive_there(drives, caplog):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ("Busy (drive there)", start - 30 * M, hours=0.5,
                                               uid=CM_ID + "@google.com"))
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        for _ in range(4):
            go(drives)
    assert drive_blocks(drives) == [("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    said = [r for r in caplog.records if "no drive there" in r.getMessage()]
    assert len(said) == 1                                                 # once, not every read
    assert_quiet(drives)


def test_another_event_this_system_added_isnt_a_drive(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ("Call the bank", start - 30 * M, hours=0.5,
                                               uid=CM_ID + "@google.com"))
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]


# -- at school ------------------------------------------------------------------------------------

def test_at_school_with_only_a_name_takes_the_place_book_and_no_map(drives):
    POINTS[SCHOOL] = "-78.45,38.45"
    drives.maps.minutes[frozenset({"home", SCHOOL})] = 18
    checked, why = places.validate_rows({"rows": [{"place": "Pine Hill Community School", "address": SCHOOL,
                                                   "said_on": "2026-11-01"}]})
    assert checked, why
    drives.live.places.import_rows(checked)
    start = when(drives, days=2, hour=14)
    at_school(drives, "Harvest share", start, location="Pine Hill Community School")
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                              ("Busy (family)", start, start + 60 * M, SCHOOL),
                              ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    asked = [u for u in drives.maps.urls if urlsplit(u).hostname == drive.GEOCODE_HOST]
    assert all("Pine" not in u for u in asked)                             # never the map by its name


def test_at_school_with_a_room_name_not_in_the_book_asks_nothing(drives):
    start = when(drives, days=2, hour=10)
    at_school(drives, "Class visit", start, location="Room 12")
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    assert not [u for u in drives.maps.urls if urlsplit(u).hostname == drive.GEOCODE_HOST]
    assert not drives.ledger.db.execute("SELECT 1 FROM place_asks").fetchall()
    # No school address in the settings either: named, never quiet (0.24.1, third round).
    assert "couldn't find a drive to the event at" in (drives.gm.digest_line() or "")


@pytest.mark.parametrize("title,extra", [
    ("Online parent conference", ()),
    ("Parent conference (virtual)", ()),
    # With no place in its location, the description says (0.24.1, third round: beside a place it doesn't).
    ("Parent conference", ("DESCRIPTION:Join on Zoom: the link is in the newsletter",)),
    ("Parent conference", ("DESCRIPTION:We'll meet on Google Meet",)),
])
def test_at_school_online_gets_no_drive(drives, title, extra):
    start = when(drives, days=2, hour=14)
    at_school(drives, title, start, location=LOCATION if not extra else "", extra=extra)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == []
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) not in blocks(drives)
    assert_quiet(drives)


def test_meet_the_teacher_at_school_still_gets_its_drives(drives):
    POINTS[SCHOOL] = "-78.45,38.45"
    drives.maps.minutes[frozenset({"home", SCHOOL})] = 18
    start = when(drives, days=2, hour=14)
    at_school(drives, "Meet the teacher", start)
    go(drives)
    go(drives)
    assert [b[0] for b in drive_blocks(drives)] == ["Busy (drive there)", "Busy (drive back)"]
