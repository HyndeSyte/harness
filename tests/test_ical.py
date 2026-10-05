"""The iCal reader: what Google's secret address produces, placed in a day
correctly, and anything it can't place counted rather than dropped."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import ical

NY = ZoneInfo("America/New_York")


def cal(*events, name="owner@example.com", tz="America/New_York"):
    head = ["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
            "VERSION:2.0", f"X-WR-CALNAME:{name}", f"X-WR-TIMEZONE:{tz}",
            "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:DAYLIGHT",
            "TZOFFSETFROM:-0500", "END:DAYLIGHT", "END:VTIMEZONE"]
    body = []
    for i, e in enumerate(events):
        lines = e.strip().splitlines()
        if not any(x.startswith("UID:") for x in lines):
            lines.append(f"UID:ev{i}@google.com")
        body += ["BEGIN:VEVENT"] + [x.strip() for x in lines] + ["END:VEVENT"]
    return "\r\n".join(head + body + ["END:VCALENDAR", ""])


def day(y, m, d, text):
    s = datetime(y, m, d, tzinfo=NY)
    return ical.window(text, start=s, end=s + timedelta(days=1), tz="America/New_York")


def titles(w):
    return [o.summary for o in w.occurrences]


def starts(w):
    return [o.start.astimezone(NY).strftime("%H:%M") if isinstance(o.start, datetime)
            else "all-day" for o in w.occurrences]


# -- single events ---------------------------------------------------------------

def test_timed_event_in_zone_and_utc():
    t = cal("DTSTART;TZID=America/New_York:20261005T090000\nDTEND;TZID=America/New_York:"
            "20261005T100000\nSUMMARY:Call",
            "DTSTART:20261005T170000Z\nDTEND:20261005T173000Z\nSUMMARY:Lunch")
    w = day(2026, 10, 5, t)
    assert titles(w) == ["Call", "Lunch"] and starts(w) == ["09:00", "13:00"]
    assert w.unreadable == 0 and w.calendar == "owner@example.com"


def test_events_on_other_days_are_left_out():
    t = cal("DTSTART:20261006T170000Z\nDTEND:20261006T173000Z\nSUMMARY:Tomorrow",
            "DTSTART:20261005T035959Z\nDTEND:20261005T040000Z\nSUMMARY:Last night")
    assert titles(day(2026, 10, 5, t)) == []


def test_all_day_and_multi_day():
    t = cal("DTSTART;VALUE=DATE:20261005\nDTEND;VALUE=DATE:20261006\nSUMMARY:Payday",
            "DTSTART;VALUE=DATE:20261003\nDTEND;VALUE=DATE:20261010\nSUMMARY:Trip",
            "DTSTART;VALUE=DATE:20261006\nDTEND;VALUE=DATE:20261007\nSUMMARY:Not today")
    w = day(2026, 10, 5, t)
    assert sorted(titles(w)) == ["Payday", "Trip"]
    assert all(o.all_day for o in w.occurrences)
    # the day an all-day event ends is not part of it
    assert titles(day(2026, 10, 10, t)) == []


def test_all_day_events_sort_first():
    t = cal("DTSTART:20261005T120000Z\nDTEND:20261005T130000Z\nSUMMARY:B",
            "DTSTART;VALUE=DATE:20261005\nSUMMARY:A")
    assert titles(day(2026, 10, 5, t)) == ["A", "B"]


def test_event_running_over_midnight_shows_on_both_days():
    t = cal("DTSTART;TZID=America/New_York:20261005T230000\n"
            "DTEND;TZID=America/New_York:20261006T010000\nSUMMARY:Night shift")
    assert titles(day(2026, 10, 5, t)) == ["Night shift"]
    assert titles(day(2026, 10, 6, t)) == ["Night shift"]


def test_duration_instead_of_end_and_zero_length():
    t = cal("DTSTART:20261005T140000Z\nDURATION:PT45M\nSUMMARY:Dur",
            "DTSTART:20261005T150000Z\nSUMMARY:Reminder")
    w = day(2026, 10, 5, t)
    o = {x.summary: x for x in w.occurrences}
    assert o["Dur"].end - o["Dur"].start == timedelta(minutes=45)
    assert o["Reminder"].end == o["Reminder"].start


def test_text_escapes_folding_and_title_cap():
    t = cal("DTSTART:20261005T140000Z\nSUMMARY:Feed\\, water\\; check \\\\ fence\\nnow")
    t = t.replace("SUMMARY:Feed", "SUMMARY:Fe\r\n ed")
    assert titles(day(2026, 10, 5, t)) == ["Feed, water; check \\ fence now"]
    long = cal("DTSTART:20261005T140000Z\nSUMMARY:" + "x" * 200)
    assert len(titles(day(2026, 10, 5, long))[0]) == ical.MAX_SUMMARY


def test_untitled_event():
    assert titles(day(2026, 10, 5, cal("DTSTART:20261005T140000Z"))) == ["(no title)"]


def test_cancelled_declined_and_free_time():
    t = cal("DTSTART:20261005T140000Z\nSUMMARY:Gone\nSTATUS:CANCELLED",
            "DTSTART:20261005T150000Z\nSUMMARY:Nope\n"
            "ATTENDEE;CN=Owner;PARTSTAT=DECLINED:mailto:OWNER@example.com",
            "DTSTART:20261005T160000Z\nSUMMARY:Others declined\n"
            "ATTENDEE;PARTSTAT=DECLINED:mailto:someone@else.com",
            "DTSTART:20261005T170000Z\nSUMMARY:Free\nTRANSP:TRANSPARENT")
    w = day(2026, 10, 5, t)
    assert titles(w) == ["Others declined", "Free"]
    assert [o.transparent for o in w.occurrences] == [False, True]


def test_floating_time_uses_the_calendar_zone():
    t = cal("DTSTART:20261005T090000\nSUMMARY:Floating", tz="America/Chicago")
    assert starts(day(2026, 10, 5, t)) == ["10:00"]


def test_windows_zone_names_are_understood():
    t = cal("DTSTART;TZID=\"Pacific Standard Time\":20261005T090000\nSUMMARY:West")
    assert starts(day(2026, 10, 5, t)) == ["12:00"]


def test_unknown_zone_is_counted_not_guessed():
    t = cal("DTSTART;TZID=Mars/Olympus:20261005T090000\nSUMMARY:?")
    w = day(2026, 10, 5, t)
    assert titles(w) == [] and w.unreadable == 1


def test_a_valarm_inside_an_event_is_ignored():
    t = cal("DTSTART:20261005T140000Z\nSUMMARY:Has alarm\nBEGIN:VALARM\n"
            "ACTION:DISPLAY\nDESCRIPTION:This is an event reminder\nTRIGGER:-P0DT0H10M0S\n"
            "END:VALARM")
    w = day(2026, 10, 5, t)
    assert titles(w) == ["Has alarm"]


# -- recurrence -----------------------------------------------------------------------

def weekly_mwf(extra=""):
    return cal("DTSTART;TZID=America/New_York:20250106T090000\n"
               "DTEND;TZID=America/New_York:20250106T093000\n"
               "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\nUID:su@google.com\nSUMMARY:Standup" + extra)


def test_weekly_by_day():
    t = weekly_mwf()
    assert titles(day(2026, 10, 5, t)) == ["Standup"]       # Monday
    assert titles(day(2026, 10, 6, t)) == []                # Tuesday
    assert titles(day(2026, 10, 9, t)) == ["Standup"]       # Friday


def test_dst_keeps_wall_clock_time():
    t = weekly_mwf()
    assert starts(day(2026, 11, 2, t)) == ["09:00"]          # after the change
    assert starts(day(2026, 3, 9, t)) == ["09:00"]


def test_exdate_removes_one_instance():
    t = weekly_mwf("\nEXDATE;TZID=America/New_York:20261007T090000")
    assert titles(day(2026, 10, 7, t)) == []
    assert titles(day(2026, 10, 9, t)) == ["Standup"]


def test_exdate_in_utc_matches_a_zoned_instance():
    t = weekly_mwf("\nEXDATE:20261007T130000Z")
    assert titles(day(2026, 10, 7, t)) == []


def test_override_moves_one_instance():
    t = weekly_mwf() .replace("END:VCALENDAR", "\r\n".join([
        "BEGIN:VEVENT", "UID:su@google.com",
        "RECURRENCE-ID;TZID=America/New_York:20261009T090000",
        "DTSTART;TZID=America/New_York:20261009T140000",
        "DTEND;TZID=America/New_York:20261009T150000", "SUMMARY:Standup (moved)",
        "END:VEVENT", "END:VCALENDAR"]))
    w = day(2026, 10, 9, t)
    assert titles(w) == ["Standup (moved)"] and starts(w) == ["14:00"]


def test_override_to_another_day_and_cancelled_instance():
    extra = "\r\n".join([
        "BEGIN:VEVENT", "UID:su@google.com",
        "RECURRENCE-ID;TZID=America/New_York:20261005T090000",
        "DTSTART;TZID=America/New_York:20261006T090000",
        "DTEND;TZID=America/New_York:20261006T093000", "SUMMARY:Standup Tue", "END:VEVENT",
        "BEGIN:VEVENT", "UID:su@google.com",
        "RECURRENCE-ID;TZID=America/New_York:20261007T090000",
        "DTSTART;TZID=America/New_York:20261007T090000", "STATUS:CANCELLED",
        "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR"])
    t = weekly_mwf().replace("END:VCALENDAR", extra)
    assert titles(day(2026, 10, 5, t)) == []
    assert titles(day(2026, 10, 6, t)) == ["Standup Tue"]
    assert titles(day(2026, 10, 7, t)) == []


def test_count_and_until():
    t = cal("DTSTART;TZID=America/New_York:20261001T080000\nRRULE:FREQ=DAILY;COUNT=5\n"
            "SUMMARY:Five",
            "DTSTART;TZID=America/New_York:20261001T080000\n"
            "RRULE:FREQ=DAILY;UNTIL=20261004T120000Z\nSUMMARY:Until",
            "DTSTART;VALUE=DATE:20261001\nRRULE:FREQ=DAILY;UNTIL=20261005\nSUMMARY:AllDayUntil")
    assert sorted(titles(day(2026, 10, 4, t))) == ["AllDayUntil", "Five", "Until"]
    assert titles(day(2026, 10, 5, t)) == ["AllDayUntil", "Five"]
    assert titles(day(2026, 10, 6, t)) == []


def test_interval_every_other_week_with_wkst():
    t = cal("DTSTART;TZID=America/New_York:20260907T190000\n"
            "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU\nSUMMARY:Board")
    assert titles(day(2026, 9, 21, t)) == ["Board"]
    assert titles(day(2026, 9, 28, t)) == []
    assert titles(day(2026, 10, 5, t)) == ["Board"]


def test_monthly_by_ordinal_weekday_and_last():
    t = cal("DTSTART;TZID=America/New_York:20240112T080000\nRRULE:FREQ=MONTHLY;BYDAY=2FR\n"
            "SUMMARY:Second Friday",
            "DTSTART;TZID=America/New_York:20240126T080000\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\n"
            "SUMMARY:Last Friday")
    assert titles(day(2026, 10, 9, t)) == ["Second Friday"]
    assert titles(day(2026, 10, 30, t)) == ["Last Friday"]
    assert titles(day(2026, 10, 23, t)) == []


def test_monthly_by_monthday_skips_short_months():
    t = cal("DTSTART;TZID=America/New_York:20260131T080000\nRRULE:FREQ=MONTHLY\n"
            "SUMMARY:31st",
            "DTSTART;TZID=America/New_York:20260130T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1\n"
            "SUMMARY:Month end")
    assert titles(day(2026, 10, 31, t)) == ["31st", "Month end"]
    assert titles(day(2026, 11, 30, t)) == ["Month end"]
    assert titles(day(2026, 11, 1, t)) == []


def test_yearly_birthday_and_leap_day():
    t = cal("DTSTART;VALUE=DATE:19900614\nRRULE:FREQ=YEARLY\nSUMMARY:Birthday",
            "DTSTART;VALUE=DATE:20240229\nRRULE:FREQ=YEARLY\nSUMMARY:Leap")
    assert titles(day(2026, 6, 14, t)) == ["Birthday"]
    assert titles(day(2026, 2, 28, t)) == [] and titles(day(2026, 3, 1, t)) == []
    assert titles(day(2028, 2, 29, t)) == ["Leap"]


def test_yearly_by_month_and_weekday():
    t = cal("DTSTART;VALUE=DATE:20241128\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\n"
            "SUMMARY:Thanksgiving")
    assert titles(day(2026, 11, 26, t)) == ["Thanksgiving"]


def test_daily_weekdays_only():
    t = cal("DTSTART;TZID=America/New_York:20260101T060000\n"
            "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR\nSUMMARY:Chores")
    assert titles(day(2026, 10, 5, t)) == ["Chores"]
    assert titles(day(2026, 10, 10, t)) == []


def test_a_long_daily_series_is_walked_to_today():
    t = cal("DTSTART;TZID=America/New_York:20000101T060000\nRRULE:FREQ=DAILY\nSUMMARY:Old")
    assert titles(day(2026, 10, 5, t)) == ["Old"]


def test_recurring_all_day_spanning_days():
    t = cal("DTSTART;VALUE=DATE:20261003\nDTEND;VALUE=DATE:20261005\n"
            "RRULE:FREQ=WEEKLY\nSUMMARY:Weekend")
    assert titles(day(2026, 10, 4, t)) == ["Weekend"]
    assert titles(day(2026, 10, 5, t)) == []


# -- what it refuses to guess ---------------------------------------------------------

@pytest.mark.parametrize("rule", [
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=HOURLY",
    "FREQ=YEARLY;BYWEEKNO=20",
    "FREQ=DAILY;COUNT=3;UNTIL=20270101",
    "FREQ=WEEKLY;BYDAY=2MO",
    "FREQ=MONTHLY;BYMONTHDAY=40",
    "FREQ=YEARLY;BYMONTHDAY=5",
])
def test_unsupported_rules_are_counted(rule):
    t = cal(f"DTSTART;TZID=America/New_York:20260101T080000\nRRULE:{rule}\nSUMMARY:?")
    w = day(2026, 10, 5, t)
    assert titles(w) == [] and w.unreadable == 1


def test_rdate_is_counted():
    t = cal("DTSTART;TZID=America/New_York:20260101T080000\nRRULE:FREQ=WEEKLY\n"
            "RDATE;TZID=America/New_York:20261005T080000\nSUMMARY:?")
    assert day(2026, 10, 5, t).unreadable == 1


def test_bad_start_is_counted():
    t = cal("DTSTART:2026-10-05 09:00\nSUMMARY:?")
    assert day(2026, 10, 5, t).unreadable == 1


def test_old_or_future_oddities_do_not_nag():
    t = cal("DTSTART;TZID=America/New_York:20200101T080000\n"
            "RRULE:FREQ=MONTHLY;BYSETPOS=1;UNTIL=20201231T000000Z\nSUMMARY:Old",
            "DTSTART;TZID=America/New_York:20270101T080000\nRRULE:FREQ=HOURLY\nSUMMARY:Later",
            "DTSTART;TZID=Mars/Olympus:20200101T090000\nSUMMARY:Long ago")
    assert day(2026, 10, 5, t).unreadable == 0


def test_an_unreadable_series_with_a_start_in_the_past_still_counts():
    t = cal("DTSTART;TZID=America/New_York:20200101T080000\n"
            "RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO\nSUMMARY:Ongoing")
    assert day(2026, 10, 5, t).unreadable == 1


def test_empty_and_garbage_input():
    assert day(2026, 10, 5, "").occurrences == []
    assert day(2026, 10, 5, "not a calendar\nat all").occurrences == []
    w = day(2026, 10, 5, cal())
    assert w.occurrences == [] and w.unreadable == 0


def test_calendar_name_falls_back():
    t = cal("DTSTART:20261005T140000Z\nSUMMARY:x").replace("X-WR-CALNAME:owner@example.com\r\n",
                                                            "")
    w = ical.window(t, start=datetime(2026, 10, 5, tzinfo=NY),
                    end=datetime(2026, 10, 6, tzinfo=NY), tz="America/New_York",
                    fallback_name="Calendar ab12")
    assert w.calendar == "Calendar ab12"


def test_parse_line_handles_quoted_colons():
    p = ical.parse_line('ATTENDEE;CN="Smith: John";PARTSTAT=ACCEPTED:mailto:j@x.com')
    assert p.name == "ATTENDEE" and p.params["CN"] == "Smith: John"
    assert p.value == "mailto:j@x.com"
    assert ical.parse_line("no colon here") is None


def test_durations():
    assert ical.parse_duration("PT1H30M") == timedelta(hours=1, minutes=30)
    assert ical.parse_duration("P1W") == timedelta(weeks=1)
    assert ical.parse_duration("P1DT2H") == timedelta(days=1, hours=2)
    with pytest.raises(ical.Unreadable):
        ical.parse_duration("PT")
    with pytest.raises(ical.Unreadable):
        ical.parse_duration("1 hour")


def test_an_unreadable_long_event_still_running_is_counted():
    t = cal("DTSTART;TZID=Mars/Olympus:20260801T090000\n"
            "DTEND;TZID=Mars/Olympus:20261101T090000\nSUMMARY:?")
    assert day(2026, 10, 5, t).unreadable == 1


def test_count_is_kept_while_old_instances_are_skipped():
    t = cal("DTSTART;TZID=America/New_York:20261001T080000\nRRULE:FREQ=DAILY;COUNT=5\n"
            "SUMMARY:Five",
            "DTSTART;TZID=America/New_York:20261001T080000\nRRULE:FREQ=DAILY;COUNT=3\n"
            "SUMMARY:Three",
            "DTSTART;TZID=America/New_York:20200101T080000\n"
            "RRULE:FREQ=WEEKLY;UNTIL=20210101T000000Z\nSUMMARY:Ended")
    assert titles(day(2026, 10, 5, t)) == ["Five"]
    assert titles(day(2026, 10, 6, t)) == []
    assert titles(day(2026, 10, 3, t)) == ["Five", "Three"]


def test_a_big_feed_with_long_histories_reads_fast():
    import time as _t
    evs = []
    for i in range(300):
        evs.append(f"DTSTART;TZID=America/New_York:20050103T{6 + i % 12:02d}0000\n"
                   f"RRULE:FREQ=DAILY\nSUMMARY:D{i}")
    for i in range(200):
        evs.append(f"DTSTART;TZID=America/New_York:20050103T090000\n"
                   f"RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\nEXDATE;TZID=America/New_York:"
                   f"20100104T090000\nSUMMARY:W{i}")
    for i in range(3000):
        evs.append(f"DTSTART:2015{1 + i % 12:02d}{1 + i % 28:02d}T140000Z\nSUMMARY:S{i}")
    t = cal(*evs)
    t0 = _t.perf_counter()
    w = day(2026, 10, 5, t)
    took = _t.perf_counter() - t0
    assert len(w.occurrences) == 500 and w.unreadable == 0
    assert took < 3.0, took


@pytest.mark.parametrize("count,expect", [(1150, ["Last"]), (1149, [])])
def test_weekly_count_from_long_ago_ends_on_the_right_day(count, expect):
    # Mon/Wed/Fri from Mon 2019-06-03: instance 1150 is Mon 2026-10-05.
    t = cal("DTSTART;TZID=America/New_York:20190603T090000\n"
            f"RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT={count}\nSUMMARY:Last")
    assert titles(day(2026, 10, 5, t)) == expect


def test_weekly_count_starting_midweek():
    # Wed 2019-06-05 first; MO,WE,FR; the first week holds two (Wed, Fri).
    t = cal("DTSTART;TZID=America/New_York:20190605T090000\n"
            "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1149\nSUMMARY:Mid")
    assert titles(day(2026, 10, 5, t)) == ["Mid"]
    t2 = t.replace("COUNT=1149", "COUNT=1148")
    assert titles(day(2026, 10, 5, t2)) == []
