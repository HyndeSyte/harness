"""The drive-leg planner after the review of 0.24.1's second round, through the real sync loop (fakes, no
network): a school run is a drive only at school, an event held online gets none, every leg the planner
expects ends the read with an outcome, a skipped event in a chain is an error said and passed over, two
calendars that look like his are named, his own drives must truly be the leg, and an event at school
falls back to the school's own address. All names are invented.
"""
import logging
from datetime import datetime, timedelta

import pytest

from harness import drive, family_gmail
from harness.family_gmail import COMPUTED, COVERED, LEG_FAILED, LEG_NO_ADDRESS, ONLINE, SKIPPED
from fake_caldav import no_network  # noqa: F401  (autouse)
from test_drive_covered import (LOCATION, SCHOOL, assert_quiet, at_school, drive_blocks, drive_cards_sent, go,
                                outcomes, school_day)
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL, occ, when
from test_family_gmail import Feeds, g  # noqa: F401
from test_meaning_live import CLINIC, NY, PARK, POINTS, blocks, drives, goes, live, M  # noqa: F401

MEET = "https://meet.google.com/abc-defg-hij"


def school_on(rig):
    """The school's address set, and its drive from home known: 18 minutes, so a 30-minute block."""
    POINTS[SCHOOL] = "-78.45,38.45"
    rig.maps.minutes[frozenset({"home", SCHOOL})] = 18
    rig.gm.drives.school_fn = lambda: SCHOOL


def notes(rig):
    return rig.gm.digest_line() or ""


def failing(rig, monkeypatch, pairs):
    """Drive lookups between these places fail; every other one is the map's."""
    real = rig.gm.drives.between
    monkeypatch.setattr(rig.gm.drives, "between",
                        lambda a, b: drive.FAILED if (a, b) in pairs else real(a, b))


def mirror(rig, feed="a"):
    """His Gmail feed as Google gives it: the blocks the add-on wrote on it, each "<id>@google.com"."""
    window = rig.feeds.snapshot.feeds[feed].window
    for eid, e in rig.google.live().items():
        start, end = (datetime.fromisoformat(e[k]["dateTime"]) for k in ("start", "end"))
        window.occurrences.append(occ(e["summary"], start, hours=(end - start).total_seconds() / 3600,
                                      uid=f"{eid}@google.com"))


def at(t):
    t = t.astimezone(NY)
    return f"{t:%b} {t.day}, {t.hour % 12 or 12}:{t:%M}"


# -- 1. a school run is the drive only for an event at school -----------------------------------------

@pytest.mark.parametrize("ends_before", [10, 15])
def test_an_event_across_town_ending_before_the_pickup_keeps_both_drives(drives, ends_before):
    school_day(drives, 2)                                               # pickup 3:00 to 3:45
    end = when(drives, days=2, hour=15) - ends_before * M
    start = end - 60 * M
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", start - 30 * M, start, "") in blocks(drives)
    assert ("Busy (drive back)", end, end + 30 * M, "") in blocks(drives)  # crosses the pickup: both stay
    assert sorted(o for (k, w), o in outcomes(drives).items()) == [COMPUTED, COMPUTED]
    assert f"the drive for the event at {at(start)} crosses a school run block" in notes(drives)
    assert "couldn't look up" not in notes(drives)


@pytest.fixture(params=["at school", "across town"])
def written_before(request, drives):
    """A drive back the add-on wrote before a school run was there: for an event at school, or for one
    across town. Then the school day comes, its pickup starting as the event ends."""
    school_on(drives)
    start = when(drives, days=2, hour=14)
    if request.param == "at school":
        at_school(drives, "Harvest share", start)
    else:
        goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    back = ("Busy (drive back)", start + 60 * M, start + 90 * M, "")
    assert back in blocks(drives)
    school_day(drives, 2)                                               # pickup 3:00 to 3:45
    drives.where, drives.back = request.param, back
    return drives


def test_a_drive_block_written_before_beside_a_school_run(written_before, caplog):
    rig = written_before
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        for _ in range(3):
            go(rig)
    took = [r for r in caplog.records if "took off the Busy (drive back) block" in r.getMessage()]
    if rig.where == "at school":
        assert rig.back not in blocks(rig)                              # the pickup is that drive
        assert len(took) == 1
        assert ("Busy (school pickup)", rig.back[1], rig.back[1] + 45 * M, "") in blocks(rig)
    else:
        assert rig.back in blocks(rig)                                   # his drive home stays
        assert took == []
        assert "crosses a school run block" in notes(rig)
    # Later reads write nothing more, and say nothing more.
    caplog.clear()
    writes = len(rig.google.writes())
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        go(rig)
        go(rig)
    assert len(rig.google.writes()) == writes
    assert not [r for r in caplog.records if "took off" in r.getMessage()]


@pytest.mark.parametrize("written_before", ["at school"], indirect=True)
def test_the_cleanup_takes_off_only_the_add_ons_own_block(written_before):
    """A drive back of his own beside the pickup, at the same time as the add-on's: only the add-on's
    comes off. The removal path only ever reaches blocks from its record that Google lists with its mark."""
    rig = written_before
    rig.google.events["hisowndrive1"] = {             # his, with no mark of the add-on's
        "id": "hisowndrive1", "status": "confirmed", "summary": "Busy (drive back)", "etag": rig.google._etag(),
        "start": {"dateTime": rig.back[1].isoformat()}, "end": {"dateTime": rig.back[2].isoformat()}}
    for _ in range(3):
        go(rig)
    assert [b for b in blocks(rig) if b[0] == "Busy (drive back)"] == [rig.back]   # his: the add-on's is gone
    assert rig.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE state='cancelled'").fetchone()[0] == 1


# -- 2. online ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("location,extra", [
    (LOCATION, (f"DESCRIPTION:Join with Google Meet: {MEET}",)),               # a street and a Meet link
    ("Room 12", (f"DESCRIPTION:Join with Google Meet: {MEET}",)),              # a room and a Meet link
    ("Room 12", ("DESCRIPTION:A virtual option is available.",)),
    (LOCATION, ("DESCRIPTION:Join: https://meet.goo", " gle.com/abc-defg-hij\\n(virtual o", " ption)")),
])
def test_an_in_person_school_event_with_a_meet_link_keeps_its_drives(drives, location, extra):
    school_on(drives)
    start = when(drives, days=2, hour=10)
    at_school(drives, "Parent conference", start, location=location, extra=extra)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                                    ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert ("Busy (family)", start, start + 60 * M, SCHOOL) in blocks(drives)
    assert_quiet(drives)


@pytest.mark.parametrize("title,location,extra", [
    ("Zoom: parent conference", "", ()),                                        # the title, no place
    ("Parent conference", MEET, ()),                                            # the location is a link
    ("Parent conference", "", (f"DESCRIPTION:Join with Google Meet: {MEET}",)),
    ("Parent conference", "", ("DESCRIPTION:Join: https://meet.goo", " gle.com/abc-defg-hij")),   # folded
])
def test_an_online_school_event_gets_no_drive_and_says_nothing(drives, caplog, title, location, extra):
    school_on(drives)
    start = when(drives, days=2, hour=10)
    at_school(drives, title, start, location=location, extra=extra)
    with caplog.at_level(logging.INFO, logger="harness.family_gmail"):
        for _ in range(3):
            go(drives)
    assert drive_blocks(drives) == []
    assert sorted(outcomes(drives).values()) == [ONLINE, ONLINE]
    assert len([r for r in caplog.records if "held online" in r.getMessage()]) == 1
    # Named in the digest, one line for the event (0.24.1, fourth round), and nothing else about a drive.
    assert notes(drives).count("no drive: online") == 1
    assert f"Blocks on Gmail from Family: no drive: online, {at(start)}." in notes(drives)
    assert "couldn't" not in notes(drives)
    assert_quiet(drives)


def test_an_online_event_anywhere_gets_no_drive(drives):
    start = when(drives, days=2, hour=10)
    goes(drives, "Virtual check-in with the coach", start, "Online")    # its place says so (fourth round)
    go(drives)
    go(drives)
    assert drive_blocks(drives) == []
    assert sorted(outcomes(drives).values()) == [ONLINE, ONLINE]
    assert_quiet(drives)


# -- 3. every leg the planner expects ends with an outcome -------------------------------------------

def test_a_middle_event_whose_drive_home_fails_is_named_with_a_card(drives, monkeypatch):
    a, b, c = (when(drives, days=3, hour=9), when(drives, days=3, hour=11), when(drives, days=3, hour=15))
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    goes(drives, "Dentist", c, CLINIC)
    failing(drives, monkeypatch, {(PARK, drive.HOME)})
    for _ in range(3):
        go(drives)
    drives.tick()
    swim = next(k for (k, w), o in outcomes(drives).items() if w == "there" and
                drives.gm.live._why.get(k, {}).get("said") == "Swim lesson")
    assert outcomes(drives)[(swim, "back")] == LEG_FAILED
    assert at(b) in notes(drives) and "couldn't look up the drive" in notes(drives)
    sent = [s[1] for s in drive_cards_sent(drives)]
    assert any("11:00 AM" in t for t in sent), sent


def test_a_chain_whose_next_drive_fails_names_the_drive_on(drives, monkeypatch):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=15)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)                                # no time to go home: straight on
    failing(drives, monkeypatch, {(CLINIC, PARK)})
    for _ in range(3):
        go(drives)
    drives.tick()
    eye = next(k for k in drives.gm.live._why if drives.gm.live._why[k]["said"] == "Eye doctor")
    assert outcomes(drives)[(eye, "back")] == LEG_FAILED                # not "covered"
    assert at(a) in notes(drives)
    assert any("10:00 AM" in s[1] for s in drive_cards_sent(drives))


def test_a_lookup_waiting_three_reads_with_nothing_getting_through_is_named(drives, monkeypatch):
    start = when(drives, days=5, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    monkeypatch.setattr(drive, "MAX_REQUESTS_PER_READ", 0)              # no lookup gets through
    go(drives)                                                          # judged
    for n in range(2):
        go(drives)
        assert "couldn't look up" not in notes(drives), n               # a wait, for now
        assert drive_cards_sent(drives) == []
    go(drives)
    drives.tick()
    assert sorted(outcomes(drives).values()) == [LEG_FAILED, LEG_FAILED]
    assert f"couldn't look up the drive for the event at {at(start)}" in notes(drives)
    assert len(drive_cards_sent(drives)) == 1


# -- 4. a skipped event in a chain ---------------------------------------------------------------------

class Leaky(set):
    """His skips, as the planner's first look misses them (forcing what can't happen otherwise)."""

    def __init__(self, keys):
        super().__init__(keys)
        self.looked: set = set()

    def __contains__(self, key):
        if key not in self.looked:
            self.looked.add(key)
            return False
        return set.__contains__(self, key)


def test_a_skipped_event_reaching_the_chain_is_an_error_and_the_read_goes_on(drives, caplog):
    a, b = when(drives, days=3, hour=10), when(drives, days=3, hour=11, minute=30)
    goes(drives, "Eye doctor", a, CLINIC)
    goes(drives, "Swim lesson", b, PARK)
    go(drives)
    go(drives)
    swim = next(k for k in drives.gm.live._why if drives.gm.live._why[k]["said"] == "Swim lesson")
    cards = drives.gm.live.drive_cards
    real = cards.off
    cards.off = lambda: Leaky(real() | {swim})
    with caplog.at_level(logging.ERROR, logger="harness.family_gmail"):
        go(drives)
    errors = [r for r in caplog.records if r.levelno == logging.ERROR and "reached the day's drives" in r.getMessage()]
    assert len(errors) == 1
    assert outcomes(drives)[(swim, "there")] == SKIPPED and outcomes(drives)[(swim, "back")] == SKIPPED
    eye = next(k for k in drives.gm.live._why if drives.gm.live._why[k]["said"] == "Eye doctor")
    assert outcomes(drives)[(eye, "there")] == COMPUTED and outcomes(drives)[(eye, "back")] == COMPUTED
    assert ("Busy (drive back)", a + 60 * M, a + 90 * M, "") in drive_blocks(drives)   # home, not on to it


# -- 5. two calendars that look like his ---------------------------------------------------------------

def test_two_calendars_that_look_like_his_are_named_at_every_read_with_one_notice(drives):
    second = Feeds()
    second.window.calendar = "other@gmail.com"
    drives.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    goes(drives, "Eye doctor", when(drives, days=3, hour=10), CLINIC)
    for _ in range(3):
        go(drives)
        drives.tick()
        assert (f"two calendars look like yours: other@gmail.com and {GMAIL}; nothing that needs your "
                "calendar is done until one is removed") in notes(drives)
    told = [s for s in drives.bot.sent if s[1].startswith("Two calendars on the Harness page")]
    assert len(told) == 1 and s_buttons(told[0]) == []
    assert blocks(drives) == []


def s_buttons(sent):
    return sent[2] or []


def test_the_calendar_written_to_is_his_when_a_second_one_appears(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    go(drives)
    go(drives)
    before = blocks(drives)
    assert len(before) == 3
    mirror(drives)            # his feed shows the blocks Harness wrote (fourth round: the choice rests on them)
    second = Feeds()
    second.window.calendar = "other@gmail.com"
    drives.feeds.snapshot.feeds["b"] = second.snapshot.feeds["a"]
    go(drives)
    go(drives)
    assert drives.gm._address() == GMAIL
    assert blocks(drives) == before
    assert "two calendars" not in notes(drives)


# -- 6. his own drives ---------------------------------------------------------------------------------

def test_drive_to_a_street_named_drive_is_his_drive_and_named(drives):
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    drives.feeds.window.occurrences.append(occ("Drive to 12 Oak Drive", start - 30 * M, hours=0.5))
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert f"the drive there for the event at {at(start)} left off: covered by your 'Drive to 12 Oak Drive'" \
        in notes(drives)


@pytest.mark.parametrize("his", [
    ("Drive", 15, 15),             # a 15-minute drive ending as the event starts, against a 45-minute leg
    ("Commute", 20, 5),            # a weekly commute ending 5 minutes before, under half the leg
])
def test_a_short_drive_of_his_at_the_edge_of_a_long_leg_keeps_it(drives, his):
    title, minutes, before = his
    drives.maps.minutes[frozenset({"home", CLINIC})] = 40              # a 45-minute leg
    start = when(drives, days=3, hour=10)
    goes(drives, "Eye doctor", start, CLINIC)
    ends = start - before * M
    drives.feeds.window.occurrences.append(occ(title, ends - minutes * M, hours=minutes / 60,
                                               instance=f"{ends:%Y%m%d}"))
    go(drives)
    go(drives)
    assert drive_blocks(drives) == [("Busy (drive there)", start - 45 * M, start, ""),
                                    ("Busy (drive back)", start + 60 * M, start + 105 * M, "")]
    assert "covered by your" not in notes(drives)


# -- 7. at school with only a room's name --------------------------------------------------------------

def test_a_room_at_school_takes_the_schools_own_address(drives):
    school_on(drives)
    start = when(drives, days=2, hour=10)
    at_school(drives, "Class visit", start, location="Room 12")
    go(drives)
    go(drives)
    drives.tick()
    assert blocks(drives) == [("Busy (drive there)", start - 30 * M, start, ""),
                              ("Busy (family)", start, start + 60 * M, SCHOOL),
                              ("Busy (drive back)", start + 60 * M, start + 90 * M, "")]
    assert [s for s in drives.bot.sent if s[1].startswith("Where is")] == []
    assert_quiet(drives)


def test_a_room_at_school_with_no_school_address_is_named(drives):
    start = when(drives, days=2, hour=10)
    at_school(drives, "Class visit", start, location="Room 12")
    go(drives)
    go(drives)
    assert sorted(outcomes(drives).values()) == [LEG_NO_ADDRESS, LEG_NO_ADDRESS]
    assert f"couldn't find a drive to the event at {at(start)}" in notes(drives)
    assert [s for s in drives.bot.sent if s[1].startswith("Where is")] == []


def test_the_own_drive_words():
    for title in ("Drive to 12 Oak Drive", "Drive", "Commute", "Driving Sam to 400 Park Drive"):
        assert family_gmail._drive_words(title), title
    for title in ("Lunch at 400 Park Drive", "Test drive", "Food drive", "Google Drive cleanup"):
        assert not family_gmail._drive_words(title), title
    assert COVERED and SKIPPED
