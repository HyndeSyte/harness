"""A block made before its address could be read gets the address and its drives on the next pass.

The case from Nov 17: a school event on Family whose location is the school's name on one line and
its street address on the next ("..., VA  24450, United States"). Its block was written before
Harness read that shape, with no address and no drives. All names are invented; no network.
"""
import hashlib
import logging
from datetime import timedelta
from urllib.parse import urlsplit

import pytest

from harness import drive
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from test_family_add import on, rig  # noqa: F401
from test_family_copy import occ, when
from test_family_gmail import g  # noqa: F401
from test_meaning_live import (POINTS, _ics, answer_ex, blocks, drives, go, judged, live, ob,  # noqa: F401
                               M)

SCHOOL = "227 N Lewis St, Lexington, VA 24450"
LOCATION = "Pine Hill Community School\\n227 N Lewis St, Lexington, VA  24450, United States"


@pytest.fixture
def school(drives, monkeypatch):
    """The school event, judged as he goes, at school; its block written while its two-line location
    still read as no address (as before 0.24.0)."""
    POINTS[SCHOOL] = "-78.45,38.45"
    drives.maps.minutes[frozenset({"home", SCHOOL})] = 20
    start = when(drives, days=1, hour=14)
    title = "Harvest share at school"
    uid = "school-" + hashlib.sha256(title.encode()).hexdigest()[:12]
    drives.icloud.seed(f"{FAMILY_PATH}{uid}.ics", _ics(uid, title, start, 1, LOCATION))
    eid = answer_ex(drives, title, ["presence"])
    drives.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=1), place="school"), cites=[eid])
    real = drive.street_address
    monkeypatch.setattr(drive, "street_address", lambda p: "" if "Lewis" in (p or "") else real(p))
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]     # as it was on Nov 17
    monkeypatch.setattr(drive, "street_address", real)
    drives.start = start
    return drives


def writes(rig):
    return rig.google.writes()


def leg_ids(rig):
    return {k: e for k, e in rig.google.live().items() if e["summary"].startswith("Busy (drive")}


def test_an_old_block_gets_its_address_and_both_drives_then_nothing_more(school):
    start = school.start
    go(school)
    assert blocks(school) == [
        ("Busy (drive there)", start - 30 * M, start, ""),
        ("Busy (family)", start, start + 60 * M, SCHOOL),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    before = len(writes(school))
    go(school)
    go(school)
    assert len(writes(school)) == before                      # idempotent: nothing more is written
    assert len(blocks(school)) == 3


def test_drives_already_there_write_nothing(school):
    go(school)
    assert [b[0] for b in blocks(school)] == ["Busy (drive there)", "Busy (family)", "Busy (drive back)"]
    before = len(writes(school))
    for _ in range(3):
        go(school)
    assert len(writes(school)) == before


def test_a_drive_he_put_on_gmail_himself_isnt_doubled(school):
    start = school.start
    school.feeds.window.occurrences = [occ("Errand", when(school, days=20, hour=15)),
                                       occ("Drive to the school", start - 30 * M, hours=0.5)]
    go(school)
    go(school)
    assert blocks(school) == [
        ("Busy (family)", start, start + 60 * M, SCHOOL),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]


def test_a_drive_he_deleted_isnt_put_back(school):
    start = school.start
    go(school)
    there = next(k for k, e in leg_ids(school).items() if e["summary"] == "Busy (drive there)")
    school.google.events[there]["status"] = "cancelled"       # he deletes it on Gmail
    school.google.events[there]["etag"] = school.google._etag()
    for _ in range(4):
        go(school)
    assert blocks(school) == [
        ("Busy (family)", start, start + 60 * M, SCHOOL),
        ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]


def test_a_drive_left_off_is_logged_by_title_and_day_and_named_in_the_digest(school, caplog):
    school.maps.fail = "down"
    with caplog.at_level(logging.WARNING, logger="harness.family_gmail"):
        go(school)
    lines = [r.getMessage() for r in caplog.records]
    assert any("no drive blocks for Harvest share at school on " in m and "(failed)" in m for m in lines), lines
    assert "couldn't look up the drive for the event at" in school.gm.leg_note
    assert not leg_ids(school)


def test_at_school_with_no_street_address_asks_nothing_and_looks_nothing_up(drives):
    start = when(drives, days=2, hour=10)
    title = "Class visit"
    uid = "visit-" + hashlib.sha256(title.encode()).hexdigest()[:12]
    drives.icloud.seed(f"{FAMILY_PATH}{uid}.ics", _ics(uid, title, start, 1, "Room 12"))
    eid = answer_ex(drives, title, ["presence"])
    drives.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=1), place="school"), cites=[eid])
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]
    assert not [u for u in drives.maps.urls if urlsplit(u).hostname == drive.GEOCODE_HOST]


def test_at_home_still_gets_no_drive(drives):
    start = when(drives, days=2, hour=10)
    POINTS[SCHOOL] = "-78.45,38.45"
    title = "Piano lesson"
    uid = "piano-" + hashlib.sha256(title.encode()).hexdigest()[:12]
    drives.icloud.seed(f"{FAMILY_PATH}{uid}.ics", _ics(uid, title, start, 1, SCHOOL))
    eid = answer_ex(drives, title, ["presence"])
    drives.judge.by[title] = judged(ob("presence", start, start + timedelta(hours=1), place="home"), cites=[eid])
    go(drives)
    go(drives)
    assert blocks(drives) == [("Busy (family)", start, start + 60 * M, "")]


@pytest.mark.parametrize("place", [
    "Pine Hill Community School\n227 N Lewis St, Lexington, VA  24450, United States",
    "Pine Hill Community School\r\n227 N Lewis St, Lexington, VA  24450, United States",
    "Pine Hill Community School\\n227 N Lewis St, Lexington, VA  24450, United States",
    "Pine Hill Community School\n227  N  Lewis  St,  Lexington,  VA  24450,  United States",
    "Pine Hill Community School, 227 N Lewis St, Lexington, VA  24450, United States",
    "227 N Lewis St, Lexington, VA  24450, United States",
    "227 N Lewis St, Lexington, VA  24450, United States",
    "227 N Lewis St, Lexington, VA  24450-1234, United States",
    "227 N Lewis St, Lexington, VA  24450, USA",
])
def test_doubled_spaces_and_a_trailing_country_still_read_as_the_address(place):
    assert drive.street_address(place) == SCHOOL
