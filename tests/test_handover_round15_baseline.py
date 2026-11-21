"""0.24.0, fifteenth round: the lost-update baseline's defects from the fourteenth outside review (Nov 16).

7. A removed time is matched against the baseline's by what it means (instant or date, all-day, zone), like a kept
   one, never with its parameters set aside; one that can't be resolved is reported.
11. Zone names calendars write that aren't IANA names (Windows ids, legacy links, prefixed forms) are mapped before a
   zone is compared or a baseline's zone rewrite recorded; the smoke run records each calendar's zone form.
All names and ids invented.
"""
import inspect

import pytest

from harness import calendar_change as cc
from harness.calendar_change import (_baseline_of, _ics_fields, _lost_fields, _matches_baseline, iana_zone,
                                     zone_forms)

FIELD = ("VCALENDAR/VEVENT", "EXDATE")
NY_EX = "EXDATE;TZID=America/New_York:20261120T090000"


def removed(was):
    return {"field": FIELD, "was": [was], "now": None}


def base(was):
    return {"VCALENDAR/VEVENT/EXDATE": {"kind": "removed", "was": [was]}}


# -- 7. a removed time by what it means ----------------------------------------------------------------------------

def test_a_removed_exdate_that_differs_from_the_baselines_only_by_tzid_is_reported():
    assert _matches_baseline(removed(NY_EX), base(NY_EX))                      # the very removal: the calendar's own
    other = "EXDATE;TZID=America/Chicago:20261120T090000"                      # same digits, another zone
    assert not _matches_baseline(removed(other), base(NY_EX))
    same_instant = "EXDATE;TZID=America/Chicago:20261120T080000"               # same instant, another zone
    assert not _matches_baseline(removed(same_instant), base(NY_EX))


def test_a_removed_time_is_never_matched_with_its_parameters_set_aside():
    assert not _matches_baseline(removed("EXDATE:20261120T090000"), base(NY_EX))   # floating isn't New York
    assert not _matches_baseline(removed("EXDATE;VALUE=DATE:20261120"), base(NY_EX))
    utc = "EXDATE:20261120T140000Z"
    assert not _matches_baseline(removed(utc), base(NY_EX))                    # the zone counts, not only the instant


def test_a_removed_time_with_a_parameter_that_cant_be_resolved_is_reported():
    odd = "EXDATE;TZID=America/New_York;X-ODD=1:20261120T090000"
    assert not _matches_baseline(removed(odd), base(odd))
    assert not _matches_baseline(removed("EXDATE;TZID=Not/AZone:20261120T090000"),
                                 base("EXDATE;TZID=Not/AZone:20261120T090000"))


def test_a_removed_text_field_still_matches_exactly():
    f = {"field": ("VCALENDAR/VEVENT", "DESCRIPTION"), "was": ["DESCRIPTION:"], "now": None}
    assert _matches_baseline(f, {"VCALENDAR/VEVENT/DESCRIPTION": {"kind": "removed", "was": ["DESCRIPTION:"]}})


# -- 11. zone aliases ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("written,iana", [
    ("Eastern Standard Time", "America/New_York"),
    ("(UTC-05:00) Eastern Time (US & Canada)", "America/New_York"),
    ("US/Eastern", "America/New_York"),
    ("/mozilla.org/20050126_1/America/New_York", "America/New_York"),
    ("/America/New_York", "America/New_York"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Etc/UTC", "UTC"),
    ("America/Chicago", "America/Chicago"),
])
def test_zone_aliases_map_to_iana_names(written, iana):
    assert iana_zone(written) == iana


def event(tzid: str, start="20261120T090000", summary="Swim") -> str:
    return ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z1\r\n"
            f"DTSTART;TZID={tzid}:{start}\r\nDTEND;TZID={tzid}:20261120T100000\r\n"
            f"SUMMARY:{summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


def test_a_windows_zone_rewritten_to_iana_gives_a_baseline_rewrite_and_no_false_alarm():
    sent, read = event('"Eastern Standard Time"'), event("America/New_York")
    baseline = _baseline_of(_lost_fields(_ics_fields(sent), _ics_fields(sent), _ics_fields(read)))
    assert baseline["VCALENDAR/VEVENT/DTSTART"]["kind"] == "changed"           # the rewrite is in the baseline
    assert baseline["VCALENDAR/VEVENT/DTSTART"]["zones"] == [["America/New_York"], ["America/New_York"]]
    # A later write: his change to the title, the server's same zone rewrite. Only the title is his.
    mine, back = event('"Eastern Standard Time"', summary="Swim meet"), event("America/New_York", summary="Swim meet")
    lost = _lost_fields(_ics_fields(mine), _ics_fields(mine), _ics_fields(back))
    assert lost and all(_matches_baseline(x, baseline) for x in lost)          # no false alarm
    # Someone else moved it an hour: still reported.
    moved = event("America/New_York", start="20261120T100000", summary="Swim meet")
    lost = _lost_fields(_ics_fields(mine), _ics_fields(mine), _ics_fields(moved))
    assert any(not _matches_baseline(x, baseline) for x in lost)


def test_a_legacy_google_zone_compares_by_its_iana_name():
    was = '{"dateTime": "2026-11-20T09:00:00", "timeZone": "US/Eastern"}'
    now = '{"dateTime": "2026-11-20T09:00:00", "timeZone": "America/New_York"}'
    x = {"field": "start", "was": was, "now": now}
    assert _matches_baseline(x, {"start": {"kind": "changed", "now": now}})


def test_the_smoke_run_records_each_calendars_zone_form():
    form = zone_forms(event('"Eastern Standard Time"'), event("America/New_York"))
    assert form == {"written": ["America/New_York", "Eastern Standard Time"], "iana": ["America/New_York"]}
    g = zone_forms({"start": {"dateTime": "x", "timeZone": "US/Eastern"}}, {"end": {"timeZone": "America/New_York"}})
    assert g == {"written": ["America/New_York", "US/Eastern"], "iana": ["America/New_York"]}
    assert '"zone_form": got.get("zone_form")' in inspect.getsource(cc.CalendarChange)
    assert "self._zone_form = zone_forms(body, now)" in inspect.getsource(cc.CalendarChange._baseline_family)
    assert "self._zone_form = zone_forms(ev, now)" in inspect.getsource(cc.CalendarChange._baseline_gmail)
