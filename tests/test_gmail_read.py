"""0.11: his Gmail calendar read through Google, not the feed's cached copy.

The read must name each event exactly as the feed does, or every copy and block built on the
feed would come off and go on again. All names are invented.
"""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from harness import google_cal, ical
from harness.calendar_feed import CalendarFeeds

NY = ZoneInfo("America/New_York")
ME = "owner@gmail.com"

FEED = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", f"X-WR-CALNAME:{ME}", "X-WR-TIMEZONE:America/New_York",
    "BEGIN:VEVENT", "UID:abc@google.com", "DTSTART;TZID=America/New_York:20261110T093000",
    "DTEND;TZID=America/New_York:20261110T103000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:PT  visit",
    "LOCATION:Clinic", "END:VEVENT",
    "BEGIN:VEVENT", "UID:abc@google.com", "RECURRENCE-ID;TZID=America/New_York:20261117T093000",
    "DTSTART;TZID=America/New_York:20261117T130000", "DTEND;TZID=America/New_York:20261117T140000",
    "SUMMARY:PT  visit", "LOCATION:Clinic", "END:VEVENT",
    "BEGIN:VEVENT", "UID:one@google.com", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261123",
    "SUMMARY:Hotel", "TRANSP:TRANSPARENT", "END:VEVENT",
    "END:VCALENDAR"]) + "\r\n"

API = [
    {"id": "abc_20261110T143000Z", "iCalUID": "abc@google.com", "recurringEventId": "abc",
     "originalStartTime": {"dateTime": "2026-11-10T09:30:00-05:00"}, "summary": "PT  visit",
     "location": "Clinic", "start": {"dateTime": "2026-11-10T09:30:00-05:00"},
     "end": {"dateTime": "2026-11-10T10:30:00-05:00"}},
    {"id": "abc_20261117T143000Z", "iCalUID": "abc@google.com", "recurringEventId": "abc",
     "originalStartTime": {"dateTime": "2026-11-17T09:30:00-05:00"}, "summary": "PT  visit",
     "location": "Clinic", "start": {"dateTime": "2026-11-17T13:00:00-05:00"},
     "end": {"dateTime": "2026-11-17T14:00:00-05:00"}},
    {"id": "abc_20261124T143000Z", "iCalUID": "abc@google.com", "recurringEventId": "abc",
     "originalStartTime": {"dateTime": "2026-11-24T09:30:00-05:00"}, "summary": "PT  visit",
     "location": "Clinic", "start": {"dateTime": "2026-11-24T09:30:00-05:00"},
     "end": {"dateTime": "2026-11-24T10:30:00-05:00"}},
    {"id": "one", "iCalUID": "one@google.com", "summary": "Hotel", "transparency": "transparent",
     "start": {"date": "2026-11-20"}, "end": {"date": "2026-11-23"}},
    {"id": "gone", "iCalUID": "gone@google.com", "status": "cancelled", "summary": "Off",
     "start": {"date": "2026-11-21"}, "end": {"date": "2026-11-22"}},
    {"id": "wl", "iCalUID": "wl@google.com", "eventType": "workingLocation", "summary": "Home",
     "start": {"date": "2026-11-21"}, "end": {"date": "2026-11-22"}},
    {"id": "no", "iCalUID": "no@google.com", "summary": "Declined",
     "attendees": [{"email": ME, "self": True, "responseStatus": "declined"}],
     "start": {"dateTime": "2026-11-12T09:00:00-05:00"}, "end": {"dateTime": "2026-11-12T10:00:00-05:00"}},
    {"id": "odd", "iCalUID": "odd@google.com", "summary": "Odd", "start": {"dateTime": "2026-11-12T09:00:00"},
     "end": {"dateTime": "2026-11-12T10:00:00"}},
]

START = datetime(2026, 11, 6, tzinfo=NY)
END = START + timedelta(days=60)


class OneRead(google_cal.GoogleCalendar):
    def __init__(self, events):
        self.events = events

    def events_between(self, address, start, end):
        return self.events


def ident(occs):
    return sorted((o.uid, o.instance, o.summary, o.start.isoformat() if isinstance(o.start, date) else o.start,
                   o.all_day, o.transparent, o.location) for o in occs)


def test_the_read_names_every_event_as_the_feed_does():
    feed = ical.window(FEED, start=START, end=END, tz="America/New_York")
    read = OneRead(API).window(ME, START, END)
    assert ident(read.occurrences) == ident(feed.occurrences)
    assert read.unreadable == 1                 # a time with no offset is counted, not guessed


def test_moments_match_even_in_other_offsets():
    feed = ical.window(FEED, start=START, end=END, tz="America/New_York")
    read = OneRead(API).window(ME, START, END)
    by = {(o.uid, o.instance): o for o in feed.occurrences}
    for o in read.occurrences:
        assert by[(o.uid, o.instance)].start == o.start and by[(o.uid, o.instance)].end == o.end


def test_no_answer_is_none_not_an_empty_calendar():
    assert OneRead(None).window(ME, START, END) is None


class Res:
    ok = True

    def __init__(self, ahead):
        self.ahead = ahead
        self.window = ical.Window(ME)


def test_the_reader_uses_the_fresh_read_and_keeps_the_feed_without_one(ledger):
    asked = []
    fresh = ical.Window(ME)
    f = CalendarFeeds(ledger, None, None, lambda: "", "America/New_York", ahead_days=60,
                      ahead_from=lambda a, s, u: (asked.append(a), fresh)[1])
    span = (START, END)
    stale = ical.Window(ME)
    res = Res(stale)
    f._fresh_ahead(res, span)
    assert res.ahead is fresh and asked == [ME]
    f.ahead_from = lambda a, s, u: None
    res = Res(stale)
    f._fresh_ahead(res, span)
    assert res.ahead is stale
    f.ahead_from = lambda a, s, u: 1 / 0
    f._fresh_ahead(res, span)
    assert res.ahead is stale


def test_an_event_with_no_id_leaves_the_feed_in_charge():
    assert OneRead(API + [{"id": "x", "summary": "x", "start": {"date": "2026-11-21"},
                           "end": {"date": "2026-11-22"}}]).window(ME, START, END) is None
