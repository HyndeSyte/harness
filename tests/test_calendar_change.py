"""Changing events he asks for, on Family and Gmail: from his message to a read back, no tap."""
import copy
import json
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, effects, ical, ics_edit, prompts, render, schema
from harness.calendar_change import CalendarChange, matches
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from fakes import own, result
from test_family_add import Rig, at_least, plain_prompt  # noqa: F401

TZ = "America/New_York"
NY = ZoneInfo(TZ)
UID = "TEST-SERIES-UID"
PATH = FAMILY_PATH + UID + ".ics"
SERIES = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iOS 18//EN",
    "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500",
    "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", f"UID:{UID}", "DTSTAMP:20260801T120000Z", "SEQUENCE:2",
    "DTSTART;TZID=America/New_York:20261102T083000", "DTEND;TZID=America/New_York:20261102T150000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20270528T035959Z",
    "EXDATE;TZID=America/New_York:20261104T083000",
    "SUMMARY:\U0001f3eb School Day", "X-APPLE-KEEP:yes",
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", ""])
ONE = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:one-off",
                   "DTSTAMP:20260801T120000Z", "DTSTART:20261201T150000Z", "DTEND:20261201T160000Z",
                   "SUMMARY:Oil change", "END:VEVENT", "END:VCALENDAR", ""])
INVITE = ONE.replace("SUMMARY:Oil change", "SUMMARY:Oil change\r\nORGANIZER:mailto:a@example.com\r\n"
                                           "ATTENDEE:mailto:b@example.com")


# Text from elsewhere, as it really arrives: an email's header lines. Length and line breaks
# are no sign of a paste (Nov 11: he dictates).
PASTED = ("From: Front Office <office@school.example>\nSubject: Schedule change\n\n"
          "There is no school on Monday, November 23.")


def change(calendar="family", op="remove", title="School Day", dates="", start="", end="", days="",
           until="", location=""):
    return {"calendar": calendar, "op": op, "title": title, "dates": dates, "start": start, "end": end,
            "days": days, "until": until, "location": location}


def ask(*changes):
    return result({"type": "proposal", "effect_type": "calendar_change",
                   "params": {"changes": list(changes)}, "summary": "ignored"})


def occs(ics, first="2026-11-01", last="2027-07-01"):
    a = datetime.fromisoformat(first).replace(tzinfo=NY)
    b = datetime.fromisoformat(last).replace(tzinfo=NY)
    return ical.window(ics, start=a, end=b, tz=TZ).occurrences


def days_of(ics, **kw):
    return {(o.start.astimezone(NY).date() if isinstance(o.start, datetime) else o.start).isoformat()
            for o in occs(ics, **kw)}


class FakeGmail:
    """What the planner and the undo ask of google_cal, over a dict. Each read hands out its own
    copy, as a real client does: nothing the harness keeps can change under it, or change the
    calendar, except through a write."""
    def __init__(self):
        self.events = {}
        self.log = []
        self.answer = "ok"
        self.down = False

    def configured(self):
        return True

    def events_between(self, address, start, end):
        out = []
        for e in self.events.values():
            if e.get("status") == "cancelled":
                continue
            when = datetime.fromisoformat(e["start"]["dateTime"])
            if start <= when < end:
                out.append(copy.deepcopy(e))
        return out

    def look(self, address, uid):
        if self.down:
            return "unknown", None
        e = self.events.get(uid)
        return ("ok", copy.deepcopy(e)) if e is not None else ("gone", None)

    def really_gone(self, address, uid):
        e = self.events.get(uid)
        return e is None or e.get("status") == "cancelled"

    def _stale(self, uid, etag):
        return etag is not None and uid in self.events and self.events[uid].get("etag") != etag

    def _bump(self, uid):
        self.n = getattr(self, "n", 10) + 1
        self.events[uid]["etag"] = f'"{self.n}"'

    def _out(self):
        return caldav.Outcome(self.answer)

    def change(self, address, uid, fields, etag):
        self.log.append(("change", uid, fields))
        if self._stale(uid, etag):
            return caldav.Outcome("changed")
        if self.answer == "ok":
            self.events[uid].update(fields)
            self._bump(uid)
        return self._out()

    def drop(self, address, uid, etag):
        self.log.append(("drop", uid))
        if self._stale(uid, etag):
            return caldav.Outcome("changed")
        if self.answer == "ok":
            self.events[uid]["status"] = "cancelled"
            self._bump(uid)
        return self._out()

    def insert(self, address, event):
        self.log.append(("insert", event))
        if self.answer == "ok":
            self.events[event["id"]] = copy.deepcopy(event)
            self._bump(event["id"])
        return self._out()


class CRig(Rig):
    def start(self):
        super().start()
        self.gmail = getattr(self, "gmail", FakeGmail())
        self.on_ = getattr(self, "on_", True)
        self.cc = CalendarChange(self.ledger, self.fa.client, self.gmail, enabled=lambda: self.on_,
                                 address=lambda: "owner@gmail.com", tz=TZ)
        self.c.calendar_change = self.cc
        self.c.config = None                      # the controller builds its parts again
        self.tick_ready = True

    def tell(self, *changes, words="take school off those days", **kw):
        self.claude.script = [ask(*changes)]
        self.say(words, **kw)

    def approve(self):
        """Tap Approve on the card just sent, if there is one: a request that ends a series."""
        last = self.bot.sent[-1] if self.bot.sent else None
        if last and last[2] and any(t == "Approve" for row in last[2] for t, _ in row):
            self.press(last, "Approve")

    def body(self, path=PATH):
        return self.icloud.events[path][1]


@pytest.fixture
def r(ledger, tmp_path, clock):
    clock.set(datetime(2026, 11, 5, 15, 0, tzinfo=timezone.utc)) if hasattr(clock, "set") else None
    rig = CRig(ledger, tmp_path, clock)
    rig.icloud.seed(PATH, SERIES)
    return rig


# What iCloud adds of its own when it stores an event: its X-APPLE lines, stamps, and a default alarm
# marked as one. A server manages all of these, so none is anyone's edit (caldav._as_sent).
ICLOUD_OWN = ("X-APPLE-CREATOR-IDENTITY:com.apple.calendar\r\nLAST-MODIFIED:20261105T150001Z\r\n"
              "BEGIN:VALARM\r\nX-WR-ALARMUID:00000000-0000-4000-8000-00000000A1A1\r\n"
              "TRIGGER;VALUE=DATE-TIME:19760401T005545Z\r\nACTION:NONE\r\nX-APPLE-DEFAULT-ALARM:TRUE\r\n"
              "END:VALARM\r\n")


def icloud_keeps(ics: str) -> str:
    """An event as a server that adds lines of its own stores it: once, before the first event ends."""
    return ics if ICLOUD_OWN in ics else ics.replace("END:VEVENT", ICLOUD_OWN + "END:VEVENT", 1)


def rewriting(r):
    """From here on, each event written is stored as icloud_keeps has it."""
    real = r.icloud.request

    def put(method, url, **kw):
        if method == "PUT" and kw.get("body"):
            kw["body"] = icloud_keeps(kw["body"].decode()).encode()
        return real(method, url, **kw)
    r.icloud.request = put


# -- the text of an event ---------------------------------------------------------------------

NOW = datetime(2026, 11, 5, 15, 0, tzinfo=timezone.utc)


def test_a_day_comes_off_and_everything_else_stays():
    key = "20261123T133000Z"
    new = ics_edit.remove_days(SERIES, [key], TZ, NOW)
    assert "EXDATE;TZID=America/New_York:20261123T083000" in new
    assert "EXDATE;TZID=America/New_York:20261104T083000" in new      # the one before stays off
    for kept in ("X-APPLE-KEEP:yes", "BEGIN:VALARM", "BEGIN:VTIMEZONE", "SEQUENCE:3"):
        assert kept in new
    days = days_of(new)
    assert "2026-11-23" not in days and "2026-11-25" in days and "2026-11-04" not in days


def test_ending_a_series_keeps_days_already_off():
    """The Nov 5 lesson: an app's rewrite dropped them. Ours doesn't touch them."""
    off = ics_edit.remove_days(SERIES, ["20261123T133000Z"], TZ, NOW)
    new = ics_edit.end_from(off, date(2027, 3, 8), TZ, NOW)
    days = days_of(new)
    assert "2027-03-03" in days and "2027-03-08" not in days and "2027-05-26" not in days
    assert "2026-11-23" not in days and "2026-11-04" not in days


def test_ending_on_the_first_day_means_the_whole_event_goes():
    assert ics_edit.end_from(SERIES, date(2026, 11, 2), TZ, NOW) is None


def test_ending_later_than_it_already_ends_is_refused():
    with pytest.raises(ics_edit.Cant):
        ics_edit.end_from(SERIES, date(2027, 7, 1), TZ, NOW)


def test_a_count_gives_way_to_the_end_date():
    text = SERIES.replace("UNTIL=20270528T035959Z", "COUNT=100")
    new = ics_edit.end_from(text, date(2026, 12, 1), TZ, NOW)
    assert "COUNT" not in new and "UNTIL=" in new


def test_one_day_moves_and_the_series_stays():
    key = "20261123T133000Z"
    start = datetime(2026, 11, 23, 10, 0, tzinfo=NY)
    new = ics_edit.move_day(SERIES, key, start, start + timedelta(hours=4), TZ, NOW)
    moved = [o for o in occs(new) if o.instance == key]
    assert len(moved) == 1 and moved[0].start.astimezone(NY).hour == 10
    assert "2026-11-25" in days_of(new)
    assert moved[0].uid == UID
    again = ics_edit.move_day(new, key, start + timedelta(hours=1), start + timedelta(hours=2), TZ, NOW)
    assert new.count("RECURRENCE-ID") == again.count("RECURRENCE-ID") == 1


def test_a_moved_day_taken_off_is_off():
    key = "20261123T133000Z"
    start = datetime(2026, 11, 23, 10, 0, tzinfo=NY)
    moved = ics_edit.move_day(SERIES, key, start, start + timedelta(hours=1), TZ, NOW)
    gone = ics_edit.remove_days(moved, [key], TZ, NOW)
    assert "RECURRENCE-ID" not in gone and "2026-11-23" not in days_of(gone)


def test_an_all_day_series_keeps_its_form():
    text = (SERIES.replace("DTSTART;TZID=America/New_York:20261102T083000", "DTSTART;VALUE=DATE:20261102")
            .replace("DTEND;TZID=America/New_York:20261102T150000", "DTEND;VALUE=DATE:20261103")
            .replace("EXDATE;TZID=America/New_York:20261104T083000", "EXDATE;VALUE=DATE:20261104"))
    new = ics_edit.remove_days(text, ["20261123"], TZ, NOW)
    assert "EXDATE;VALUE=DATE:20261123" in new and "2026-11-23" not in days_of(new)
    assert "UNTIL=20261130" in ics_edit.end_from(text, date(2026, 12, 1), TZ, NOW)


def test_an_event_with_people_is_refused():
    with pytest.raises(ics_edit.Cant):
        ics_edit.move_one(INVITE, NOW, NOW + timedelta(hours=1), TZ, NOW)


def test_a_new_series_reads_back_across_a_clock_change():
    start = datetime(2026, 10, 26, 8, 30, tzinfo=NY)
    text = ics_edit.build("hm-1", "Art Class", start, start + timedelta(hours=6), "",
                          "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270528T035959Z", TZ, NOW)
    assert "BEGIN:VTIMEZONE" in text and "BYDAY=2SU" in text and "BYDAY=1SU" in text
    hours = {o.start.astimezone(NY).hour for o in occs(text, first="2026-10-20")}
    assert hours == {8}
    assert "X-HARNESS" not in text


def test_words_match_whole_words_and_ignore_emoji():
    assert matches("school day", "\U0001f3eb School Day")
    assert matches("Coop", "Coop Day")
    assert not matches("school", "Homeschool co-op")
    assert not matches("school day", "School")
    assert not matches("", "School")


# -- what a model may say ---------------------------------------------------------------------

def parse(*changes):
    return schema.parse_output({"type": "proposal", "effect_type": "calendar_change",
                                "params": {"changes": list(changes)}, "summary": "x"},
                               stage_at_least=at_least("S1"))


def test_a_good_change_parses():
    assert parse(change(dates="2026-11-23,2026-11-25")).type == "proposal"


@pytest.mark.parametrize("bad", [
    change(calendar="work", dates="2026-11-23"),
    change(op="delete_everything", dates="2026-11-23"),
    change(dates="2026-11-23", start="2026-11-23T08:00:00-05:00"),
    {**change(dates="2026-11-23"), "attendees": "a@example.com"},
])
def test_anything_off_is_refused_whole(bad):
    with pytest.raises(schema.OutputError):
        parse(bad)


@pytest.mark.parametrize("bad", [
    change(dates="soon"),
    change(dates=""),
    change(op="end_series", dates="2026-11-23,2026-11-25"),
    change(op="add_series", start="2027-03-16T08:30:00-04:00", end="2027-03-16T15:00:00-04:00",
           days="MO,WE", until="2027-05-25"),
    change(op="move", dates="2026-11-23", start="2026-11-23T10:00:00", end="2026-11-23T11:00:00"),
    change(op="add", start="2026-11-23T10:00:00-05:00", end="2026-11-23T09:00:00-05:00"),
])
def test_doubtful_words_get_plain_refusals(bad):
    with pytest.raises(schema.OutputError) as e:
        parse(bad)
    assert isinstance(e.value.__cause__, effects.ChangeRefusal)


def test_the_schema_only_offers_it_when_on():
    plain = prompts.output_schema(at_least("S1"), family_add=True)["properties"]["output"]["anyOf"]
    assert not any(s["properties"].get("effect_type", {}).get("enum") == ["calendar_change"] for s in plain)
    on = prompts.output_schema(at_least("S1"), family_add=True, calendar_change=True)["properties"]["output"]["anyOf"]
    kinds = [s["properties"]["effect_type"]["enum"] for s in on if "effect_type" in s["properties"]]
    assert kinds == [["calendar_change"]]


# -- end to end ---------------------------------------------------------------------------------

def test_he_says_it_and_its_done_with_no_tap(r):
    r.tell(change(dates="2026-11-23,2026-11-25"), words="no school Nov 23 and 25")
    assert not any(b for s in r.bot.sent for b in (s[2] or []) if any(t == "Approve" for t, _ in b))
    days = days_of(r.body())
    assert "2026-11-23" not in days and "2026-11-25" not in days and "2026-11-30" in days
    assert "Nov 23, Nov 25" in r.texts()[-1] and "Done" in r.texts()[-1]
    assert r.with_button("Undo")


def test_undo_puts_it_back(r):
    r.tell(change(dates="2026-11-23"))
    r.press(r.with_button("Undo"), "Undo")
    assert ical.unfold(r.body()) == ical.unfold(SERIES)
    assert "Undone" in r.texts()[-1]


def test_undo_leaves_alone_an_event_someone_changed_since(r):
    r.tell(change(dates="2026-11-23"))
    r.icloud.human_edit(PATH, "School Day", "School Days")
    r.press(r.with_button("Undo"), "Undo")
    assert "School Days" in r.body() and "Not undone" in r.texts()[-1] and "Nothing changed" in r.texts()[-1]


def test_a_one_off_goes_and_undo_brings_it_back(r):
    path = FAMILY_PATH + "one-off.ics"
    r.icloud.seed(path, ONE)
    r.tell(change(title="oil change", dates="2026-12-01"))
    assert path not in r.icloud.events
    r.press(r.with_button("Undo"), "Undo")
    assert "Oil change" in r.body(path)


def test_a_title_it_cant_find_changes_nothing_and_says_whats_there(r):
    before = r.body()
    r.tell(change(title="Karate", dates="2026-11-23"))
    assert r.body() == before
    assert "Karate" in r.texts()[-1] and "School Day" in r.texts()[-1] and "Nothing changed" in r.texts()[-1]


def test_two_events_that_could_be_it_change_nothing(r):
    r.icloud.seed(FAMILY_PATH + "other.ics", SERIES.replace(UID, "SECOND").replace("School Day", "School Day Trip"))
    before = r.body()
    r.tell(change(title="school", dates="2026-11-23"))
    assert r.body() == before and "more than one" in r.texts()[-1]


def test_a_day_already_off_is_said_and_the_rest_goes(r):
    r.tell(change(dates="2026-11-04,2026-11-23"))
    assert "didn't find it on Nov 4" in r.texts()[-1] and "2026-11-23" not in days_of(r.body())


def test_a_copy_of_a_gmail_event_is_refused(r):
    r.icloud.seed(FAMILY_PATH + "hx-abc.ics", ONE.replace("UID:one-off", "UID:hx-abc"))
    cols = [c[1] for c in r.ledger.db.execute("PRAGMA table_info(family_copies)").fetchall()]
    row = {c: 0 if c in ("hand", "missing") else "x" for c in cols}
    row["uid"] = "hx-abc"
    with r.ledger.tx() as db:
        db.execute(f"INSERT INTO family_copies({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                   [row[c] for c in cols])
    r.tell(change(title="oil change", dates="2026-12-01"))
    assert FAMILY_PATH + "hx-abc.ics" in r.icloud.events and "copy" in r.texts()[-1]


def test_a_past_day_is_refused(r):
    before = r.body()
    r.tell(change(dates="2025-11-24"))
    assert r.body() == before and "already passed" in r.texts()[-1]


def test_an_invite_is_refused_with_why(r):
    path = FAMILY_PATH + "one-off.ics"
    r.icloud.seed(path, INVITE)
    r.tell(change(title="oil change", dates="2026-12-01"))
    assert path in r.icloud.events and "invitees" in r.texts()[-1]


def test_someone_editing_in_between_stops_the_write(r):
    r.icloud.before_write = lambda: r.icloud.human_edit(PATH, "School Day", "School Days")
    r.tell(change(dates="2026-11-23"))
    assert "School Days" in r.body() and "2026-11-23" in days_of(r.body())
    assert "changed that event" in r.texts()[-1]


def test_a_lost_answer_is_read_and_the_receipt_follows(r):
    """It landed and the answer was lost: a read a minute later finds it, and he gets the usual
    receipt. Nothing is written twice, and nothing asks him to look."""
    r.icloud.drop_response_next = True
    before = len(r.texts())
    r.tell(change(dates="2026-11-23"))
    assert len(r.texts()) == before                      # nothing said yet: a read settles it
    r.advance(minutes=1)
    r.tick()
    assert r.texts()[-1].startswith("<b>Done.</b>") and "Nov 23" in r.texts()[-1]
    assert r.with_button("Undo") and r.icloud.methods().count("PUT") == 1
    assert "2026-11-23" not in days_of(r.body())


def test_pasted_words_get_a_tap(r):
    before = r.body()
    r.tell(change(dates="2026-11-23"), words=PASTED)
    assert r.body() == before and r.with_button("Approve")
    r.press(r.with_button("Approve"), "Approve")
    assert "2026-11-23" not in days_of(r.body())


def test_stopped_means_nothing_changes(r):
    r.say("/stop")
    before = r.body()
    r.tell(change(dates="2026-11-23"))
    assert r.body() == before


def test_off_says_so_and_changes_nothing(r):
    r.on_ = False
    before = r.body()
    r.tell(change(dates="2026-11-23"))
    assert r.body() == before and "off" in r.texts()[-1]


def test_several_changes_land_in_one_receipt(r):
    r.tell(change(dates="2026-11-23"), change(op="end_series", dates="2027-03-08"))
    r.approve()                                # ending a series is tapped
    days = days_of(r.body())
    assert "2026-11-23" not in days and "2027-03-08" not in days and "2027-03-03" in days
    assert len([s for s in r.bot.sent if s[2] and any(t == "Undo" for row in s[2] for t, _ in row)]) == 1


def test_an_added_series_is_an_ordinary_event_and_undo_takes_it_off(r):
    r.tell(change(op="add_series", title="Art Class", start="2027-03-16T08:30:00-04:00",
                  end="2027-03-16T15:00:00-04:00", days="TU", until="2027-05-25"))
    added = [p for p in r.icloud.events if "/hm-" in p]
    assert len(added) == 1 and days_of(r.body(added[0]), first="2027-03-01") >= {"2027-03-16", "2027-05-25"}
    r.press(r.with_button("Undo"), "Undo")
    assert added[0] not in r.icloud.events


def test_a_day_that_comes_back_gets_a_digest_line(r):
    r.tell(change(dates="2026-11-23"))
    r.icloud.seed(PATH, SERIES)               # an app rewrites the series
    r.advance(minutes=31)
    r.tick()
    assert "came back" in r.cc.digest_line() and "Nov 23" in r.cc.digest_line()


def test_a_restart_during_a_write_is_read_and_told(r):
    r.tell(change(dates="2026-11-23"))
    with r.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET state='sending'")
        db.execute("UPDATE jobs SET state='approved' WHERE id=(SELECT job_id FROM calendar_changes)")
    r.bot.sent.clear()
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.advance(minutes=1)                       # read a minute after it was sent
    r.tick()
    assert r.texts()[-1].startswith("<b>Done.</b>") and r.icloud.methods().count("PUT") == 1


def test_a_crash_while_planning_never_runs_it_twice(r, monkeypatch):
    real = r.cc._plan

    def boom(c, key):
        if key.startswith("preview"):
            return real(c, key)                # found clear before it was offered
        raise RuntimeError("bug")              # and the run's own plan crashes
    monkeypatch.setattr(r.cc, "_plan", boom)
    r.claude.script = [ask(change(dates="2026-11-23"))]
    with pytest.raises(RuntimeError):
        r.say("no school Nov 23")
    monkeypatch.undo()
    r.tick()
    assert "2026-11-23" in days_of(r.body())
    assert any("stopped before anything was written" in t for t in r.texts())


# -- Gmail --------------------------------------------------------------------------------------

def gmail_day(r, uid="base_1", series="base", title="Piano", day="2026-11-09T08:00:00-05:00"):
    end = (datetime.fromisoformat(day) + timedelta(hours=1)).isoformat()     # an hour, like a lesson
    r.gmail.events[uid] = {"id": uid, "etag": '"1"', "summary": title, "recurringEventId": series,
                           "start": {"dateTime": day}, "end": {"dateTime": end}, "location": "Clinic"}
    r.gmail.events.setdefault(series, {"id": series, "etag": '"0"', "summary": title, "status": "confirmed",
                                       "start": {"dateTime": "2026-10-05T08:00:00-04:00"},
                                       "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"]})


def test_a_gmail_day_comes_off_and_comes_back(r):
    gmail_day(r)
    r.tell(change(calendar="gmail", title="piano", dates="2026-11-09"))
    assert r.gmail.events["base_1"]["status"] == "cancelled"
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.events["base_1"]["status"] == "confirmed"


def test_a_gmail_series_ends(r):
    gmail_day(r)
    r.gmail.events["base"] = {"id": "base", "etag": '"2"', "summary": "Piano", "status": "confirmed",
                              "start": {"dateTime": "2026-10-05T08:00:00-04:00"},
                              "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"]}
    r.tell(change(calendar="gmail", op="end_series", title="piano", dates="2026-11-09"))
    r.approve()                                # ending a series is tapped
    assert "UNTIL=20261109T045959Z" in r.gmail.events["base"]["recurrence"][0]
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.events["base"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_a_gmail_event_with_guests_is_refused(r):
    gmail_day(r)
    r.gmail.events["base_1"]["attendees"] = [{"email": "other@example.com"}]
    r.tell(change(calendar="gmail", title="piano", dates="2026-11-09"))
    assert "status" not in r.gmail.events["base_1"] and "invitees" in r.texts()[-1]


def test_a_gmail_add_has_a_fixed_id_and_no_guests(r):
    r.tell(change(calendar="gmail", op="add", title="Dentist", start="2026-11-20T09:00:00-05:00",
                  end="2026-11-20T10:00:00-05:00"))
    kind, event = r.gmail.log[-1]
    assert kind == "insert" and event["id"].startswith("cm") and "attendees" not in event
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.log[-1][0] == "drop"


# -- what the review found ------------------------------------------------------------------------

def test_the_google_transport_lets_patch_out(monkeypatch):
    from harness.net import GoogleTransport, HttpResponse, UrllibTransport
    from harness import google_cal
    monkeypatch.setattr(UrllibTransport, "request", lambda self, *a, **k: HttpResponse(200))
    assert GoogleTransport(google_cal.HOSTS).request("PATCH", "https://www.googleapis.com/x").status == 200


def test_a_read_back_that_disagrees_is_said_out_loud_and_undo_stays(r):
    real = r.icloud.request

    def drops_it(method, url, **kw):
        if method == "PUT":
            kw["body"] = SERIES.encode()           # the server keeps its old text
        return real(method, url, **kw)
    r.icloud.request = drops_it
    r.tell(change(dates="2026-11-23"))
    for _ in range(2):                         # it reads: the version its own write made, without the change
        r.advance(minutes=1)
        r.tick()
    last = r.bot.sent[-1]
    assert last[1].startswith("<b>Nothing changed.</b>") and "it didn't go through" in last[1]
    assert last[2] is None and r.icloud.methods().count("PUT") == 1


def test_a_lost_answer_isnt_called_nothing_changed(r):
    r.icloud.drop_response_next = True
    r.tell(change(dates="2026-11-23"))
    r.advance(minutes=1)
    r.tick()
    assert "Done" in r.texts()[-1] and "Nothing changed" not in r.texts()[-1]


def harness_transport_error():
    from harness.net import TransportError
    return TransportError("network", "OSError")


def test_a_failed_read_back_still_offers_undo(r):
    real = r.icloud.request
    puts = []

    def down_after_put(method, url, **kw):
        if puts and method == "GET":
            raise harness_transport_error()
        answer = real(method, url, **kw)
        if method == "PUT":
            puts.append(1)
        return answer
    r.icloud.request = down_after_put
    r.tell(change(dates="2026-11-23"))
    r.icloud.request = real
    r.advance(minutes=1)
    r.tick()
    assert r.texts()[-1].startswith("<b>Done.</b>") and r.with_button("Undo")


def test_the_exact_title_wins_over_one_that_only_contains_it(r):
    r.icloud.seed(FAMILY_PATH + "pics.ics", ONE.replace("UID:one-off", "UID:pics")
                  .replace("20261201T150000Z", "20261123T150000Z").replace("20261201T160000Z", "20261123T160000Z")
                  .replace("Oil change", "School Day Pictures"))
    r.tell(change(dates="2026-11-23"))
    assert FAMILY_PATH + "pics.ics" in r.icloud.events
    assert "2026-11-23" not in days_of(r.body())


def test_a_day_with_only_the_longer_title_doesnt_lose_it(r):
    r.icloud.seed(FAMILY_PATH + "pics.ics", ONE.replace("UID:one-off", "UID:pics")
                  .replace("20261201T150000Z", "20261104T150000Z").replace("20261201T160000Z", "20261104T160000Z")
                  .replace("Oil change", "School Day Pictures"))
    r.tell(change(dates="2026-11-04"))             # School Day is already off that day
    assert FAMILY_PATH + "pics.ics" in r.icloud.events and "Nothing changed" in r.texts()[-1]
    assert "School Day Pictures" in r.texts()[-1]                # asked, by name


def test_two_titles_that_could_be_it_are_named(r):
    r.icloud.seed(FAMILY_PATH + "pics.ics", ONE.replace("UID:one-off", "UID:pics")
                  .replace("20261201T150000Z", "20261123T150000Z").replace("20261201T160000Z", "20261123T160000Z")
                  .replace("Oil change", "School Pictures"))
    r.tell(change(title="school", dates="2026-11-23"))
    assert "School Pictures" in r.texts()[-1] and "2026-11-23" in days_of(r.body())


TRIP = ONE.replace("UID:one-off", "UID:trip").replace("DTSTART:20261201T150000Z", "DTSTART;VALUE=DATE:20261201") \
    .replace("DTEND:20261201T160000Z", "DTEND;VALUE=DATE:20261206").replace("Oil change", "Trip")


def test_one_day_of_a_trip_doesnt_take_off_the_trip(r):
    path = FAMILY_PATH + "trip.ics"
    r.icloud.seed(path, TRIP)
    r.tell(change(title="trip", dates="2026-12-03"))
    assert path in r.icloud.events and "Dec 1 to Dec 5" in r.texts()[-1]


def test_all_its_days_do(r):
    path = FAMILY_PATH + "trip.ics"
    r.icloud.seed(path, TRIP)
    r.tell(change(title="trip", dates="2026-12-01,2026-12-02,2026-12-03,2026-12-04,2026-12-05"))
    assert path not in r.icloud.events


def test_a_trip_can_move_to_new_days(r):
    path = FAMILY_PATH + "trip.ics"
    r.icloud.seed(path, TRIP)
    r.tell(change(op="move", title="trip", dates="2026-12-03", start="2026-12-02", end="2026-12-04"))
    assert "DTSTART;VALUE=DATE:20261202" in r.body(path) and "DTEND;VALUE=DATE:20261205" in r.body(path)


def test_undo_of_two_steps_on_one_event_survives_a_server_that_rewrites(r):
    rewriting(r)
    r.tell(change(dates="2026-11-23"), change(op="end_series", dates="2027-03-08"))
    r.approve()                                # ending a series is tapped
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1]
    assert "2026-11-23" in days_of(r.body()) and "2027-03-08" in days_of(r.body())


def test_an_undo_whose_answer_is_lost_runs_again_by_itself(r):
    r.tell(change(dates="2026-11-23"))
    r.icloud.force_status = 503                # not written, and the answer says nothing
    r.press(r.with_button("Undo"), "Undo")
    assert not any("Not fully undone" in t or "Undone" in t for t in r.texts())
    r.advance(minutes=1)
    r.tick()
    assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())
    assert ical.unfold(r.body()) == ical.unfold(SERIES)


def test_a_reply_to_a_receipt_gets_a_tap(r):
    r.tell(change(dates="2026-11-23"))
    receipt = r.with_button("Undo")
    before = r.body()
    r.tell(change(dates="2026-11-25"), words="do the same", reply_to=receipt[3])
    assert r.body() == before and r.with_button("Approve")


def test_end_series_finds_the_next_day_it_happens(r):
    r.tell(change(op="end_series", dates="2026-12-05"))         # a Saturday
    r.approve()                                # ending a series is tapped
    days = days_of(r.body())
    assert "2026-11-30" in days and "2026-12-07" not in days


def test_a_title_under_two_series_ends_both_or_only_the_day_named(r):
    wed = SERIES.replace(UID, "WED").replace("BYDAY=MO,WE", "BYDAY=WE").replace("20261102T", "20261104T") \
        .replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", "")
    mon = SERIES.replace("BYDAY=MO,WE", "BYDAY=MO").replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", "")
    r.icloud.seed(PATH, mon)
    r.icloud.seed(FAMILY_PATH + "WED.ics", wed)
    r.tell(change(op="end_series", dates="2027-03-08", days="MO"))
    r.approve()                                # ending a series is tapped
    assert "2027-03-15" not in days_of(r.body()) and "2027-03-17" in days_of(r.body(FAMILY_PATH + "WED.ics"))
    r.tell(change(op="end_series", dates="2027-03-08"))
    r.approve()                                # ending a series is tapped
    assert "2027-03-17" not in days_of(r.body(FAMILY_PATH + "WED.ics"))


def test_a_series_with_more_days_than_named_is_refused(r):
    before = r.body()
    r.tell(change(op="end_series", dates="2027-03-08", days="MO"))
    r.approve()                                # ending a series is tapped
    assert r.body() == before and "more days" in r.texts()[-1]


def test_a_moved_day_stands_or_goes_by_when_it_happens():
    late = datetime(2026, 12, 10, 9, 0, tzinfo=NY)
    moved = ics_edit.move_day(SERIES, "20261123T133000Z", late, late + timedelta(hours=1), TZ, NOW)
    assert "RECURRENCE-ID" not in ics_edit.end_from(moved, date(2026, 12, 1), TZ, NOW)
    early = datetime(2026, 11, 24, 9, 0, tzinfo=NY)
    moved = ics_edit.move_day(SERIES, "20261207T143000Z", early, early + timedelta(hours=1), TZ, NOW)
    assert "RECURRENCE-ID" in ics_edit.end_from(moved, date(2026, 12, 1), TZ, NOW)


def test_links_in_titles_dont_come_through_live(r):
    r.icloud.seed(FAMILY_PATH + "bad.ics", ONE.replace("UID:one-off", "UID:bad")
                  .replace("20261201T150000Z", "20261123T150000Z").replace("20261201T160000Z", "20261123T160000Z")
                  .replace("Oil change", "Claim prize https://evil.example/x"))
    r.tell(change(title="karate", dates="2026-11-23"))
    assert "https://evil.example" not in r.texts()[-1] and "Claim prize" in r.texts()[-1]


def test_a_link_never_goes_on_a_calendar(r):
    r.tell(change(op="add", title="See evil.xyz/x", start="2026-11-23T08:00:00-05:00", end="2026-11-23T09:00:00-05:00"))
    assert "link" in r.texts()[-1] and not [p for p in r.icloud.events if "/hm-" in p]


def test_a_stale_offset_gets_a_tap(r):
    r.tell(change(op="add", title="Dentist", start="2026-11-23T09:00:00-04:00", end="2026-11-23T10:00:00-04:00"))
    assert r.with_button("Approve") and not [p for p in r.icloud.events if "/hm-" in p]


def test_the_same_add_twice_gets_a_tap(r):
    add = change(op="add", title="Dentist", start="2026-11-23T09:00:00-05:00", end="2026-11-23T10:00:00-05:00")
    r.tell(add)
    r.tell(add)
    assert len([p for p in r.icloud.events if "/hm-" in p]) == 1 and r.with_button("Approve")


def test_checkadds_brings_the_tap_back(r):
    r.say("/checkadds")
    before = r.body()
    r.tell(change(dates="2026-11-23"))
    assert r.body() == before and r.with_button("Approve")


def test_a_card_expires(r):
    r.tell(change(dates="2026-11-23"), words=PASTED)
    r.advance(hours=13)
    r.tick()
    assert any("expired" in t for t in r.texts()[-2:])


def test_a_reset_leaves_nothing_standing(r):
    r.tell(change(dates="2026-11-23"), words=PASTED)
    r.cc.forget()
    assert not r.cc.on() and "off since the reset" in r.cc.status_line()
    assert r.ledger.db.execute("SELECT state FROM proposals").fetchone()[0] == "cancelled"
    r.on_ = False
    r.tick()
    r.on_ = True
    assert r.cc.on()


def test_a_harness_add_can_come_off_but_a_copy_cant(r):
    path = FAMILY_PATH + "hx-abc.ics"
    r.icloud.seed(path, ONE.replace("UID:one-off", "UID:hx-abc"))
    r.tell(change(title="oil change", dates="2026-12-01"))
    assert path not in r.icloud.events


def test_a_gmail_event_from_someone_else_is_refused(r):
    gmail_day(r)
    r.gmail.events["base_1"]["organizer"] = {"email": "other@example.com"}
    r.tell(change(calendar="gmail", title="piano", dates="2026-11-09"))
    assert "status" not in r.gmail.events["base_1"] and "invitees" in r.texts()[-1]


def test_gmail_undo_leaves_alone_what_he_changed_since(r):
    gmail_day(r)
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09T10:00:00-05:00", end="2026-11-09T11:00:00-05:00"))
    r.gmail.events["base_1"].update(etag='"his"', start={"dateTime": "2026-11-09T12:00:00-05:00"})
    r.press(r.with_button("Undo"), "Undo")
    assert "Not undone" in r.texts()[-1] and "12:00" in r.gmail.events["base_1"]["start"]["dateTime"]


def test_gmail_undo_of_a_removal_puts_its_details_back(r):
    gmail_day(r)
    r.tell(change(calendar="gmail", title="piano", dates="2026-11-09"))
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.log[-1][2]["location"] == "Clinic" and r.gmail.log[-1][2]["status"] == "confirmed"


def test_floating_and_date_untils_are_written_and_read_right():
    rule, changed = ics_edit.until_line("FREQ=WEEKLY", date(2026, 12, 7), all_day=False, zone=NY, floating=True)
    assert changed and rule.endswith("UNTIL=20261206T235959")
    _, changed = ics_edit.until_line("FREQ=WEEKLY;UNTIL=20261207", date(2026, 12, 7), all_day=False, zone=NY)
    assert changed                                  # Dec 7 still happens under that rule


def test_the_zone_block_starts_on_a_day_its_rule_fits():
    lines = ics_edit.vtimezone(TZ, 2027)
    assert "DTSTART:19700308T020000" in lines and "DTSTART:19701101T020000" in lines


# -- what the second pass found -------------------------------------------------------------------

def event_on(uid, title, start, end):
    return ("\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", f"UID:{uid}", "DTSTAMP:20260801T120000Z",
                         f"DTSTART:{start}", f"DTEND:{end}", f"SUMMARY:{title}", "END:VEVENT", "END:VCALENDAR", ""]))


NIGHTS = (SERIES.replace(UID, "NIGHTS").replace("School Day", "Night Shift").replace("BYDAY=MO,WE", "BYDAY=MO,TU,WE,TH")
          .replace("DTSTART;TZID=America/New_York:20261102T083000", "DTSTART;TZID=America/New_York:20261102T220000")
          .replace("DTEND;TZID=America/New_York:20261102T150000", "DTEND;TZID=America/New_York:20261103T060000")
          .replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", ""))


def test_a_night_shift_moves_on_the_day_it_starts(r):
    path = FAMILY_PATH + "NIGHTS.ics"
    r.icloud.seed(path, NIGHTS)
    r.tell(change(op="move", title="night shift", dates="2026-11-24", start="2026-11-24T23:00:00-05:00",
                  end="2026-11-25T07:00:00-05:00"))
    assert "RECURRENCE-ID;TZID=America/New_York:20261124T220000" in r.body(path)


def test_ending_a_night_shift_isnt_called_a_failed_read_back(r):
    r.icloud.seed(FAMILY_PATH + "NIGHTS.ics", NIGHTS)
    r.tell(change(op="end_series", title="night shift", dates="2026-12-01"))
    r.approve()                                # ending a series is tapped
    assert "Done" in r.texts()[-1]


def test_an_overnight_one_off_comes_off_on_its_day(r):
    path = FAMILY_PATH + "party.ics"
    r.icloud.seed(path, event_on("party", "Party", "20261224T010000Z", "20261224T060000Z"))
    r.tell(change(title="party", dates="2026-12-23"))
    assert path not in r.icloud.events


def later_series(start="20270112"):
    return (SERIES.replace(UID, "LATER").replace("BYDAY=MO,WE", "BYDAY=TU")
            .replace("20261102T", start + "T").replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", ""))


def test_ending_doesnt_delete_a_series_that_hasnt_started(r):
    r.icloud.seed(FAMILY_PATH + "LATER.ics", later_series())
    before = r.body()
    r.tell(change(op="end_series", dates="2026-12-15"))
    r.approve()                                # ending a series is tapped
    assert FAMILY_PATH + "LATER.ics" in r.icloud.events and r.body() == before
    assert "only starts on Jan 12" in r.texts()[-1]


def test_the_days_filter_goes_by_the_rule_not_the_weeks_around(r):
    """Wednesdays are off for weeks, and it's still a Monday and Wednesday series."""
    off = ics_edit.remove_days(SERIES, [f"202703{d:02d}T123000Z" for d in (17, 24, 31)], TZ, NOW)
    r.icloud.seed(PATH, off)
    r.tell(change(op="end_series", dates="2027-03-15", days="MO"))
    r.approve()                                # ending a series is tapped
    assert "more days" in r.texts()[-1] and "2027-03-15" in days_of(r.body())


def test_one_day_moved_doesnt_make_a_monday_series_more_than_mondays(r):
    mon = SERIES.replace("BYDAY=MO,WE", "BYDAY=MO").replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", "")
    start = datetime(2027, 3, 16, 9, 0, tzinfo=NY)
    r.icloud.seed(PATH, ics_edit.move_day(mon, "20270315T123000Z", start, start + timedelta(hours=1), TZ, NOW))
    r.tell(change(op="end_series", dates="2027-03-08", days="MO"))
    r.approve()                                # ending a series is tapped
    assert "Done" in r.texts()[-1]


def test_a_title_next_month_doesnt_make_today_unclear(r):
    r.icloud.seed(FAMILY_PATH + "board.ics", event_on("board", "School Board Meeting", "20261228T150000Z", "20261228T160000Z"))
    r.tell(change(title="school", dates="2026-11-23"))
    assert "2026-11-23" not in days_of(r.body())


def test_a_one_off_on_part_of_its_name_is_asked_when_the_series_isnt_that_day(r):
    """"School" on a Tuesday with only School Pictures on it, when School Day is Mondays and
    Wednesdays: two events fit his word, so he's asked, by name, and nothing comes off."""
    path = FAMILY_PATH + "pics.ics"
    r.icloud.seed(path, event_on("pics", "School Pictures", "20261124T150000Z", "20261124T160000Z"))
    r.tell(change(title="school", dates="2026-11-24"))
    asked = r.texts()[-1]
    assert path in r.icloud.events and "School Pictures" in asked and "School Day" in asked
    assert asked.startswith("Nothing changed") and asked.rstrip().endswith("?")
    assert r.ledger.db.execute("SELECT state FROM jobs ORDER BY created_at DESC").fetchone()[0] \
        == "needs_clarification"


def test_a_series_months_off_can_still_be_ended(r):
    r.icloud.seed(PATH, SERIES.replace("BYDAY=MO,WE", "BYDAY=MO").replace("FREQ=WEEKLY", "FREQ=MONTHLY;INTERVAL=3")
                  .replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", "").replace("20261102T", "20261012T")
                  .replace("BYDAY=MO;", ""))
    r.tell(change(op="end_series", dates="2026-11-20"))
    r.approve()                                # ending a series is tapped
    assert "Done" in r.texts()[-1]


def test_a_reply_chain_doesnt_launder_a_paste(r):
    r.claude.script = [result(text="noted")]
    r.say(PASTED, message_id=7001)
    first = r.bot.sent[-1]
    r.advance(hours=3)
    r.claude.script = [result(text="ok")]
    r.say("hm", reply_to=first[3])
    second = r.bot.sent[-1]
    r.advance(hours=3)
    before = r.body()
    r.tell(change(dates="2026-11-23"), words="do it", reply_to=second[3])
    assert r.body() == before and r.with_button("Approve")


def test_a_failed_read_isnt_called_already_gone(r):
    r.tell(change(calendar="gmail", op="add", title="Dentist", start="2026-11-20T09:00:00-05:00",
                  end="2026-11-20T10:00:00-05:00"))
    r.gmail.down = True
    r.press(r.with_button("Undo"), "Undo")
    assert not any("Not undone" in t for t in r.texts())     # not read is never "already gone"
    assert next(iter(r.gmail.events.values())).get("status") != "cancelled"
    r.gmail.down = False
    r.advance(minutes=1)
    r.tick()
    assert "Undone" in r.texts()[-1]
    assert next(iter(r.gmail.events.values()))["status"] == "cancelled"


def test_gmail_undo_works_after_a_read_back_that_failed(r):
    gmail_day(r)
    real = r.gmail.change

    def then_down(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        r.gmail.down = True
        return out
    r.gmail.change = then_down
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09T10:00:00-05:00", end="2026-11-09T11:00:00-05:00"))
    r.gmail.change = real
    r.gmail.down = False
    r.advance(minutes=1)
    r.tick()
    assert r.texts()[-1].startswith("<b>Done.</b>")
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1]


def test_gmail_undo_after_another_days_change_gave_it_a_new_version(r):
    gmail_day(r)
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09T10:00:00-05:00", end="2026-11-09T11:00:00-05:00"))
    r.gmail.events["base_1"]["etag"] = '"sibling"'     # same fields, new version
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1]


def test_gmail_undo_of_a_move_clears_the_other_form(r):
    gmail_day(r)
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09", end="2026-11-09"))
    r.press(r.with_button("Undo"), "Undo")
    start = r.gmail.log[-1][2]["start"]
    assert start["date"] is None and start["dateTime"]


def test_a_write_that_landed_is_named_in_the_receipt(r):
    r.icloud.seed(FAMILY_PATH + "one-off.ics", ONE)
    real = r.icloud.request
    puts = []

    def down_after_put(method, url, **kw):
        if puts and method == "GET":
            raise harness_transport_error()
        answer = real(method, url, **kw)
        if method == "PUT":
            puts.append(1)
        return answer
    r.icloud.request = down_after_put
    r.tell(change(dates="2026-11-23"))
    r.icloud.request = real
    r.advance(minutes=1)
    r.tick()
    assert r.texts()[-1].startswith("<b>Done.</b>") and "School Day" in r.texts()[-1]


def test_an_ended_series_that_comes_back_later_is_still_caught(r):
    r.tell(change(op="end_series", dates="2026-12-01"))
    r.approve()                                # ending a series is tapped
    r.clock.advance(days=30)
    r.mark_daily_done()
    r.icloud.seed(PATH, SERIES)
    r.tick()
    assert "came back" in r.cc.digest_line()


def test_the_came_back_check_reads_once(r):
    r.tell(change(dates="2026-11-23"))
    r.advance(minutes=31)
    r.icloud.log.clear()
    r.tick()
    assert r.icloud.methods().count("REPORT") == 1


def test_an_unreadable_option_clears_nothing(r):
    r.say("/checkadds")
    r.on_ = None
    r.tick()
    r.on_ = True
    assert "each needs your tap" in r.cc.status_line()
    r.on_ = False
    r.tick()
    r.on_ = True
    assert "no tap" in r.cc.status_line()


def test_something_unreadable_is_said_when_ending(r):
    r.icloud.seed(FAMILY_PATH + "odd.ics", SERIES.replace(UID, "ODD").replace("BYDAY=MO,WE", "BYSETPOS=1;BYDAY=TU"))
    r.tell(change(op="end_series", dates="2026-12-01"))
    card = r.with_button("Approve")[1]
    assert "can't be read, so another series called" in card and "School Day may keep going" in card   # a fact
    r.approve()                                # ending a series is tapped
    assert "can't be read" in r.texts()[-1] and "check" not in r.texts()[-1].lower()


def test_an_event_with_a_link_in_its_title_can_still_come_off(r):
    path = FAMILY_PATH + "bad.ics"
    r.icloud.seed(path, event_on("bad", "Meet at school.org", "20261124T150000Z", "20261124T160000Z"))
    r.tell(change(title="meet at school.org", dates="2026-11-24"))
    assert path not in r.icloud.events


# -- what the live test found -----------------------------------------------------------------------

def gmail_series(r, title="Harness Test"):
    """A Gmail series and its days as Google keeps them: one id for the series, one per day."""
    r.gmail.events["cmS"] = {"id": "cmS", "etag": '"5"', "summary": title, "status": "confirmed",
                             "start": {"dateTime": "2026-12-01T19:00:00-05:00"},
                             "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261230T045959Z"]}
    for d in (1, 8, 15):
        uid = f"cmS_202612{d + 1:02d}T000000Z"
        r.gmail.events[uid] = {"id": uid, "etag": f'"{d}"', "summary": title, "recurringEventId": "cmS",
                               "start": {"dateTime": f"2026-12-{d:02d}T19:00:00-05:00"},
                               "end": {"dateTime": f"2026-12-{d:02d}T20:00:00-05:00"}}


def undo_of(r, n):
    """The Undo on the nth receipt, counting from the first."""
    return [s for s in r.bot.sent if s[2] and any(t == "Undo" for row in s[2] for t, _ in row)][n]


def test_undo_of_an_earlier_change_waits_for_the_later_one(r):
    r.tell(change(dates="2026-11-23"))
    r.tell(change(dates="2026-11-25"))
    before = r.body()
    r.advance(days=6)
    r.press(undo_of(r, 0), "Undo")
    assert r.body() == before and "undone too" in r.texts()[-1]
    r.advance(days=2)                          # the later receipt's own button is gone now
    r.press(r.with_button("Undo both"), "Undo both")
    assert [t for t in r.texts()[-2:] if "Undone" in t] == r.texts()[-2:]
    assert {"2026-11-23", "2026-11-25"} <= days_of(r.body())
    assert ical.unfold(r.body()) == ical.unfold(SERIES)


def test_a_gmail_series_and_one_of_its_days_are_each_checked(r):
    gmail_series(r)
    r.tell(change(calendar="gmail", op="move", title="harness test", dates="2026-12-08",
                  start="2026-12-08T21:00:00-05:00", end="2026-12-08T22:00:00-05:00"),
           change(calendar="gmail", op="end_series", title="harness test", dates="2026-12-15"))
    r.approve()                                # ending a series is tapped
    ended = list(r.gmail.events["cmS"]["recurrence"])
    day = r.gmail.events["cmS_20261209T000000Z"]
    day.update(etag='"his"', start={"dateTime": "2026-12-08T18:00:00-05:00"})    # he moved it again
    r.press(r.with_button("Undo"), "Undo")
    assert "Not undone" in r.texts()[-1] and r.gmail.events["cmS"]["recurrence"] == ended


def test_an_event_already_back_doesnt_block_the_rest_of_the_undo(r):
    path = FAMILY_PATH + "one-off.ics"
    r.icloud.seed(path, ONE)
    gmail_day(r, uid="oil_1", series="oil", title="Oil change", day="2026-12-01T10:00:00-05:00")
    r.tell(change(title="oil change", dates="2026-12-01"),
           change(calendar="gmail", title="oil change", dates="2026-12-01"))
    r.icloud.seed(path, ONE)                    # a phone put it back
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1] and r.gmail.events["oil_1"]["status"] == "confirmed"


def test_undo_of_an_add_on_both_calendars_never_stops_halfway(r):
    """Nov 5: Gmail went, Family stayed, a later day's change still standing."""
    r.tell(change(op="add_series", title="Harness Test", start="2026-12-01T19:00:00-05:00",
                  end="2026-12-01T20:00:00-05:00", days="TU", until="2026-12-29"),
           change(calendar="gmail", op="add_series", title="Harness Test", start="2026-12-01T19:00:00-05:00",
                  end="2026-12-01T20:00:00-05:00", days="TU", until="2026-12-29"))
    added = [p for p in r.icloud.events if "/hm-" in p][0]
    r.icloud.human_edit(added, "SUMMARY:Harness Test", "SUMMARY:Harness Test2")
    gid = next(k for k in r.gmail.events if k.startswith("cm"))
    r.press(r.with_button("Undo"), "Undo")
    assert "Not undone" in r.texts()[-1] and "Nothing changed" in r.texts()[-1]
    assert r.gmail.events[gid].get("status") != "cancelled" and added in r.icloud.events


def test_a_gmail_day_isnt_put_back_under_a_series_thats_gone(r):
    gmail_series(r)
    r.tell(change(calendar="gmail", title="harness test", dates="2026-12-08"))
    r.gmail.events["cmS"]["status"] = "cancelled"          # the series went another way
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.events["cmS_20261209T000000Z"]["status"] == "cancelled"
    assert "isn't on the calendar any more" in r.texts()[-1]


def test_a_gmail_day_comes_back_when_its_series_is_there(r):
    gmail_series(r)
    r.tell(change(calendar="gmail", title="harness test", dates="2026-12-08"))
    r.press(r.with_button("Undo"), "Undo")
    assert r.gmail.events["cmS_20261209T000000Z"]["status"] == "confirmed" and "Undone" in r.texts()[-1]


def test_undo_matches_what_the_server_kept_not_what_was_sent(r):
    """A later change undone leaves the event as the server kept it after the first."""
    rewriting(r)
    r.tell(change(op="add_series", title="Harness Test", start="2026-12-01T19:00:00-05:00",
                  end="2026-12-01T20:00:00-05:00", days="TU", until="2026-12-29"))
    r.tell(change(title="harness test", dates="2026-12-08"))
    r.press(undo_of(r, 1), "Undo")
    assert "Undone" in r.texts()[-1]
    r.press(undo_of(r, 0), "Undo")
    assert "Undone" in r.texts()[-1] and not [p for p in r.icloud.events if "/hm-" in p]


def test_the_digest_says_what_wasnt_done_in_plain_words(r, monkeypatch):
    from harness import daily
    from harness.config import Config
    from conftest import OWNER
    from harness.calendar_change import Preview
    monkeypatch.setattr(r.cc, "preview", lambda *a: Preview([]))   # couldn't look first: the run finds out
    r.tell(change(title="Book club", dates="2026-12-01"))       # nothing called that on Family
    r.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    d = daily.gather(r.ledger, Config(owner_user_id=OWNER, stage="S1"), paused=False)
    assert "\u201cBook club\u201d" in d.text and "couldn't find that event" in d.text
    assert "Nothing changed" in d.text and "job " not in d.text


def test_a_reply_to_the_digest_needs_no_tap(r):
    from harness import daily
    from harness.config import Config
    from conftest import OWNER
    r.ledger.db.execute("DELETE FROM meta WHERE key='integrity_since'")
    r.tick()                                  # the controller builds its parts
    r.ledger.set_meta("digest_date", "2000-01-01")
    r.c._daily(False)
    r.c.outbox.flush()
    digest_msg = r.bot.sent[-1]
    r.tell(change(dates="2026-11-23"), words="take school off the 23rd", reply_to=digest_msg[3])
    assert "2026-11-23" not in days_of(r.body())
    assert not any(s[2] and any(t == "Approve" for row in s[2] for t, _ in row) for s in r.bot.sent)
    assert daily and Config and OWNER  # imported for the digest


def test_a_change_that_stopped_partway_isnt_called_nothing_changed(r):
    from harness import daily
    job = {"id": "j", "created_at": "2026-11-05T15:00:00+00:00"}
    line = daily._failed(r.ledger, job, {"effect": "calendar_change", "steps": 1, "outcome": "failed"}, TZ)
    assert "Nothing changed" not in line and "stopped partway" in line and "check" not in line
    line = daily._failed(r.ledger, job, {"reason": "not_found"}, TZ)
    assert "Nothing changed" in line and "a request (Thu 10:00 AM)" in line
    for reason in ("calendar_unknown", "family_unknown", "unknown"):     # what no read settled yet
        line = daily._failed(r.ledger, job, {"reason": reason}, TZ)
        assert line.endswith(": not confirmed yet, still checking.") and "check the" not in line


# -- "again": what his calendar already says, not a question ------------------------------------

def test_his_calendar_is_given_for_the_events_he_names(r):
    r.gmail.events["cof1"] = {"id": "cof1", "status": "confirmed", "summary": "Coffee with Sam",
                              "location": "Corner Cafe, 1 Main St",
                              "start": {"dateTime": "2026-10-16T08:30:00-04:00"},
                              "end": {"dateTime": "2026-10-16T10:00:00-04:00"}}
    r.gmail.events["den1"] = {"id": "den1", "status": "confirmed", "summary": "Dentist",
                              "start": {"dateTime": "2026-10-20T08:30:00-04:00"},
                              "end": {"dateTime": "2026-10-20T09:00:00-04:00"}}
    r.tell(change(calendar="gmail", op="add_series", title="Coffee with Sam",
                  start="2026-11-13T08:30:00-05:00", end="2026-11-13T10:00:00-05:00", days="FR",
                  until="", location="Corner Cafe") | {"every": "2"},
           words="Sam and I are on for coffee again next week, then every two weeks going forward")
    user = r.claude.calls[-1]["user"]
    assert "<calendar>" in user and "Coffee with Sam at Corner Cafe" in user and "Dentist" not in user
    [new] = [e for k, e in r.gmail.events.items() if k.startswith("cm")]
    assert new["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=FR;INTERVAL=2"]
    assert "every other Friday" in r.texts()[-1] and "until you end it" in r.texts()[-1]


def test_nothing_named_on_his_calendar_gives_no_calendar(r):
    r.tell(change(op="add", title="Recital", start="2026-12-01T18:00:00-05:00",
                  end="2026-12-01T19:00:00-05:00"), words="add the recital Dec 1 at 6")
    assert "<calendar>" not in r.claude.calls[-1]["user"]


def test_a_series_repeat_is_only_one_to_four_weeks():
    from harness.effects import ChangeRefusal, _one_change
    bad = change(calendar="gmail", op="add_series", title="Coffee", start="2026-11-13T08:30:00-05:00",
                 end="2026-11-13T10:00:00-05:00", days="FR") | {"every": "9"}
    with pytest.raises(ChangeRefusal):
        _one_change(bad)
    with pytest.raises(ChangeRefusal):
        _one_change(change(calendar="gmail", op="add", title="Coffee", start="2026-11-13T08:30:00-05:00",
                           end="2026-11-13T10:00:00-05:00") | {"every": "2"})


# -- an outcome no write confirmed is settled by reading, never handed to him (0.23.0) ----------

class Crash(BaseException):
    """The process dies mid-request (as the stop signal does)."""


def receipts(r):
    return [t for t in r.texts() if t.startswith(("<b>Done.</b>", "<b>Nothing changed.</b>",
                                                   "<b>Only part", "<b>That stopped", "<b>Not confirmed.</b>"))]


def test_nothing_landed_is_written_once_more_then_read(r):
    r.icloud.force_status = 503                # not written, and the answer says nothing
    r.tell(change(dates="2026-11-23"))
    assert "2026-11-23" in days_of(r.body()) and receipts(r) == []
    r.advance(minutes=1)
    r.tick()                                   # read: as it was, so written once more
    assert r.icloud.methods().count("PUT") == 2 and "2026-11-23" not in days_of(r.body())
    assert receipts(r)[-1].startswith("<b>Done.</b>") and r.with_button("Undo")


def test_nothing_landed_twice_is_said_plainly(r):
    r.icloud.force_status = 503
    r.tell(change(dates="2026-11-23"))
    r.advance(minutes=1)
    r.icloud.force_status = 503                # the second try's answer says nothing either
    r.tick()
    assert receipts(r) == []
    r.advance(minutes=1)
    r.tick()                                   # read: still as it was, and no third try
    [said] = receipts(r)
    assert said.startswith("<b>Nothing changed.</b>") and "because it didn't go through" in said
    assert r.icloud.methods().count("PUT") == 2 and r.bot.sent[-1][2] is None
    assert ical.unfold(r.body()) == ical.unfold(SERIES)


def test_a_read_that_cant_tell_says_so_once_after_an_hour_then_the_answer_once(r):
    r.icloud.drop_response_next = True         # it lands, and the answer is lost
    r.tell(change(dates="2026-11-23"))
    r.icloud.down = True                       # and then no read can tell
    for minutes in (1, 1, 30, 30, 1, 1):
        r.advance(minutes=minutes)
        r.tick()
    still = [t for t in r.texts() if "I couldn't confirm yet whether" in t]
    assert len(still) == 1 and still[0].endswith("School Day changed; I'm still checking.")
    line = r.cc.digest_line()
    assert "Not confirmed yet, still checking: Take off the 8:30" in line and "School Day on Mon Nov 23 (Family)." in line
    r.icloud.down = False
    r.advance(minutes=15)                      # past the first hour: read every 15 minutes
    r.tick()
    r.advance(minutes=1)
    r.tick()
    assert len(receipts(r)) == 1 and receipts(r)[0].startswith("<b>Done.</b>")
    assert r.icloud.methods().count("PUT") == 1 and "still checking" not in r.cc.digest_line()


def test_a_restart_mid_write_is_read_then_finished(r):
    r.icloud.before_write = lambda: (_ for _ in ()).throw(Crash())
    r.claude.script = [ask(change(dates="2026-11-23"))]
    with pytest.raises(Crash):
        r.say("no school Nov 23")
    assert r.ledger.db.execute("SELECT state FROM calendar_changes").fetchone()[0] == "sending"
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.advance(minutes=1)
    r.tick()                                   # read a minute on: never landed, so written once, by itself
    assert "2026-11-23" not in days_of(r.body()) and receipts(r)[-1].startswith("<b>Done.</b>")


def test_a_restart_mid_undo_finishes_the_undo(r):
    r.tell(change(dates="2026-11-23"))
    r.icloud.before_write = lambda: (_ for _ in ()).throw(Crash())
    with pytest.raises(Crash):
        r.press(r.with_button("Undo"), "Undo")
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.c.calendar_change = r.cc
    r.cc.reconcile_after_restart()
    r.tick()
    assert r.texts()[-1] == "<b>Undone.</b> It's back the way it was."
    assert ical.unfold(r.body()) == ical.unfold(SERIES)
    assert not any("Check the calendar" in t or "tap Undo again" in t for t in r.texts())


def test_an_undo_that_landed_before_a_restart_is_said_undone_without_a_second_write(r):
    r.tell(change(dates="2026-11-23"))
    r.icloud.drop_response_next = True         # the undo lands; its answer is lost
    r.press(r.with_button("Undo"), "Undo")
    puts = r.icloud.methods().count("PUT")
    r.advance(minutes=1)
    r.tick()
    assert r.texts()[-1] == "<b>Undone.</b> It's back the way it was."
    assert r.icloud.methods().count("PUT") == puts and ical.unfold(r.body()) == ical.unfold(SERIES)


def test_a_gmail_add_whose_answer_is_lost_is_never_made_twice(r):
    real = r.gmail.insert

    def lost(address, event):
        real(address, event)
        return caldav.Outcome("unknown")       # it landed; the answer didn't
    r.gmail.insert = lost
    r.tell(change(calendar="gmail", op="add", title="Dentist", start="2026-11-20T09:00:00-05:00",
                  end="2026-11-20T10:00:00-05:00"))
    r.advance(minutes=1)
    r.tick()
    assert [k for k, _ in r.gmail.log].count("insert") == 1
    assert receipts(r)[-1].startswith("<b>Done.</b>") and "Dentist" in receipts(r)[-1]


def test_a_lost_answer_waits_while_stopped(r):
    r.icloud.drop_response_next = True
    r.tell(change(dates="2026-11-23"))
    r.say("/stop")
    r.icloud.log.clear()
    r.advance(minutes=5)
    r.tick()
    assert "GET" not in r.icloud.methods() and receipts(r) == []
    r.say("/resume")
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>")


def test_a_reset_drops_a_change_waiting_for_a_read_without_a_word_or_a_write(r):
    r.icloud.force_status = 503                # not written; a read would write it once more
    r.tell(change(dates="2026-11-23"))
    r.cc.forget()
    r.icloud.log.clear()
    said = len(r.texts())
    r.advance(minutes=5)
    r.tick()
    assert "PUT" not in r.icloud.methods() and len(r.texts()) == said
    assert r.ledger.db.execute("SELECT state FROM calendar_changes").fetchone()[0] == "reset"


# -- the D2 review: a read decides, and nothing it can't tell is written over (0.23.0) ----------

def lost_answer_gmail_move(r):
    """Piano on Mon Nov 9 moved to 10:00: the move lands, its answer is lost."""
    gmail_day(r)
    real = r.gmail.change

    def lands_lost(address, uid, fields, etag):
        real(address, uid, fields, etag)
        return caldav.Outcome("unknown")
    r.gmail.change = lands_lost
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09T10:00:00-05:00", end="2026-11-09T11:00:00-05:00"), words="move piano to 10")
    r.gmail.change = real


def test_a_family_change_he_undid_by_hand_before_its_read_is_left_as_it_is(r):
    """It landed with its answer lost, and before a read could tell, a phone put the day back. The
    same lines under a new version are someone's write: nothing is written over it, and he hears so."""
    r.icloud.drop_response_next = True
    r.tell(change(dates="2026-11-23"))
    assert "2026-11-23" not in days_of(r.body())
    r.icloud.down = True
    for _ in range(3):
        r.advance(minutes=1)
        r.tick()
    r.icloud.down = False
    r.icloud.seed(PATH, SERIES.replace("SEQUENCE:2", "SEQUENCE:4"))      # a phone put the day back
    puts = r.icloud.methods().count("PUT")
    r.advance(minutes=1)
    r.tick()
    assert r.icloud.methods().count("PUT") == puts and "2026-11-23" in days_of(r.body())
    [said] = receipts(r)
    assert said.startswith("<b>Nothing changed.</b>")
    assert "because it was changed on the calendar since, so I left it as it is." in said
    assert r.bot.sent[-1][2] is None


def test_a_gmail_change_he_undid_by_hand_before_its_read_is_left_as_it_is(r):
    lost_answer_gmail_move(r)
    assert r.gmail.events["base_1"]["start"]["dateTime"] == "2026-11-09T10:00:00-05:00"
    r.gmail.down = True
    for _ in range(5):
        r.advance(minutes=1)
        r.tick()
    r.gmail.events["base_1"].update(start={"dateTime": "2026-11-09T08:00:00-05:00"},
                                    end={"dateTime": "2026-11-09T09:00:00-05:00"})
    r.gmail._bump("base_1")                    # he moved it back himself, in Google Calendar
    r.gmail.down = False
    r.gmail.log.clear()
    r.advance(minutes=1)
    r.tick()
    assert r.gmail.log == [] and r.gmail.events["base_1"]["start"]["dateTime"] == "2026-11-09T08:00:00-05:00"
    assert "because it was changed on the calendar since, so I left it as it is." in receipts(r)[-1]


def test_a_write_between_the_read_and_the_second_try_is_never_written_over(r):
    r.icloud.force_status = 503                # not written, and the answer says nothing
    r.tell(change(dates="2026-11-23"))
    real = r.cc._seen_as

    def then_a_phone_writes(entry):
        seen = real(entry)
        r.icloud.human_edit(PATH, "X-APPLE-KEEP:yes", "X-APPLE-KEEP:no")      # just after the read
        r.cc._seen_as = real
        return seen
    r.cc._seen_as = then_a_phone_writes
    r.advance(minutes=1)
    r.tick()                                   # read: as it was, but the second try finds a new version
    assert r.icloud.methods().count("PUT") == 1 and receipts(r) == []      # not written, not called his yet
    r.advance(minutes=1)
    r.tick()                                   # a read says whose change it is
    assert r.icloud.methods().count("PUT") == 1 and "X-APPLE-KEEP:no" in r.body()
    assert "2026-11-23" in days_of(r.body())
    assert "it was changed on the calendar since, so I left it as it is" in receipts(r)[-1]


@pytest.mark.parametrize("whose, said", [
    ("its own write, landing late", "<b>Done.</b>"),
    ("a phone", "it was changed on the calendar since, so I left it as it is"),
])
def test_a_second_try_refused_for_its_version_is_read_before_anything_is_said(r, whose, said):
    r.icloud.force_status = 503                # not written, and the answer says nothing
    r.tell(change(dates="2026-11-23"))
    if whose == "a phone":
        r.icloud.before_write = lambda: r.icloud.human_edit(PATH, "X-APPLE-KEEP:yes", "X-APPLE-KEEP:no")
    else:
        late = ics_edit.remove_days(SERIES, ["20261123T133000Z"], TZ, NOW)
        r.icloud.before_write = lambda: r.icloud.seed(PATH, late)
    r.advance(minutes=1)
    r.tick()                                   # the second try's write is refused for its version (412)
    assert receipts(r) == [] and r.icloud.methods().count("PUT") == 2
    r.advance(minutes=1)
    r.tick()                                   # read, and only then said
    assert said in receipts(r)[-1] and r.icloud.methods().count("PUT") == 2
    if whose != "a phone":
        r.press(r.with_button("Undo"), "Undo")
        assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())


def test_undo_after_a_read_settled_it_works_on_a_server_that_rewrites(r):
    rewriting(r)
    r.icloud.drop_response_next = True         # it lands, and the answer is lost
    r.tell(change(dates="2026-11-23"))
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>")
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())


def land_then_die(r):
    """The write lands, and the process dies before its answer is handled."""
    real = r.icloud.request

    def die_after(method, url, **kw):
        out = real(method, url, **kw)
        if method == "PUT":
            raise Crash()
        return out
    r.icloud.request = die_after
    return real


def test_a_write_cut_short_is_read_a_minute_after_it_was_sent_and_kept_in_full(r):
    """A restart right after a write: no read at once, so a late write shows first. The read that
    finds it landed keeps every record the usual path keeps, once."""
    real = land_then_die(r)
    r.claude.script = [ask(change(dates="2026-11-23"))]
    with pytest.raises(Crash):
        r.say("no school Nov 23")
    r.icloud.request = real
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.icloud.log.clear()
    r.tick()
    assert "GET" not in r.icloud.methods() and receipts(r) == []          # sent just now: not read yet
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>") and "PUT" not in r.icloud.methods()
    row = r.ledger.db.execute("SELECT undo_json FROM calendar_changes").fetchone()
    assert len(json.loads(row["undo_json"])) == 1
    assert r.ledger.db.execute("SELECT COUNT(*) FROM calendar_removed").fetchone()[0] == 1
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1] and ical.unfold(r.body()) == ical.unfold(SERIES)


def test_undo_tries_start_over_at_each_tap(r):
    r.tell(change(dates="2026-11-23"))
    for _ in range(2):
        r.icloud.force_status = 403            # the calendar turns the undo's write down
        r.press(r.with_button("Undo"), "Undo")
        assert r.texts()[-1].startswith("<b>Not fully undone:</b> the calendar refused it.")
    r.press(r.with_button("Undo"), "Undo")    # a third tap, with the calendar taking writes again
    assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())


def two_series(r):
    """School Day as two series, Mondays and Wednesdays, each its own event, both ended."""
    wed = (SERIES.replace(UID, "WED").replace("BYDAY=MO,WE", "BYDAY=WE").replace("20261102T", "20261104T")
           .replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", ""))
    mon = SERIES.replace("BYDAY=MO,WE", "BYDAY=MO").replace("EXDATE;TZID=America/New_York:20261104T083000\r\n", "")
    r.icloud.seed(PATH, mon)
    r.icloud.seed(FAMILY_PATH + "WED.ics", wed)
    r.claude.script = [ask(change(op="end_series", dates="2027-03-08"))]
    r.say("end school from march 8")


def puts_that(r, *plan):
    """Each PUT in turn: "ok", 503 (not written, nothing said), 403 (refused), or "lost" (written,
    its answer lost)."""
    real, n = r.icloud.request, {"put": 0}

    def put(method, url, **kw):
        if method == "PUT":
            what = plan[n["put"]] if n["put"] < len(plan) else "ok"
            n["put"] += 1
            if what in (403, 503):
                r.icloud.force_status = what
            elif what == "lost":
                r.icloud.drop_response_next = True
        return real(method, url, **kw)
    r.icloud.request = put
    return n


def test_a_put_back_whose_answer_is_lost_is_read_before_any_receipt(r):
    two_series(r)
    n = puts_that(r, "ok", 503, 503, "lost")   # Mondays end; Wednesdays twice not; the put-back lands unheard
    r.approve()
    for _ in range(3):
        r.advance(minutes=1)
        r.tick()
    assert n["put"] == 4 and "2027-03-15" in days_of(r.body())          # Mondays are back as they were
    [said] = receipts(r)
    assert said.startswith("<b>Nothing changed.</b>") and "Partly done" not in said
    assert "Only part of it went through on Family, so I put that part back as it was." in said
    assert "on Family, not on Family" not in said and r.bot.sent[-1][2] is None


def test_half_a_part_is_named_on_one_calendar_without_saying_it_twice(r):
    two_series(r)
    puts_that(r, "ok", 503, 503, 403)          # Mondays end; Wednesdays twice not; the put-back is refused
    r.approve()
    for _ in range(3):
        r.advance(minutes=1)
        r.tick()
    said = receipts(r)[-1]
    assert said.startswith("<b>That stopped partway.</b>") and "on Family, not on Family" not in said
    assert "Partly done: End " in said and "Only part of it went through on Family, because" in said
    assert r.with_button("Undo")


def test_reads_that_cant_tell_back_off_and_stop_after_a_week_with_one_line(r):
    """Each minute for the first hour, every 15 minutes until a day has passed, then hourly. A refused
    read (the address isn't Family's) keeps the same schedule. After a week: one receipt, then quiet."""
    r.icloud.drop_response_next = True         # it lands, and the answer is lost
    r.tell(change(dates="2026-11-23"))
    reads = []
    real = r.cc._seen_as

    def counted(entry):
        reads.append(r.clock())
        return real(entry)
    r.cc._seen_as = counted
    start = r.clock()
    r.icloud.names[FAMILY_PATH] = "Other"      # every read refused: the address isn't Family's
    for _ in range(90):
        r.advance(minutes=1)
        r.tick()
    minutes = [int((t - start).total_seconds() // 60) for t in reads]
    assert minutes == list(range(1, 61)) + [75, 90]
    assert len([t for t in r.texts() if "I couldn't confirm yet whether" in t]) == 1
    reads.clear()
    r.advance(hours=22, minutes=30)            # a day on, hourly from here
    r.tick()
    for _ in range(4):
        r.advance(minutes=30)
        r.tick()
    minutes = [int((t - start).total_seconds() // 60) for t in reads]
    assert minutes == [1440, 1500, 1560]
    r.icloud.names[FAMILY_PATH] = "Family"
    r.icloud.down = True                       # now nothing answers at all: the same reads
    r.advance(days=5, hours=20)                # six days and 22 hours since it was sent
    r.tick()
    assert receipts(r) == []
    r.advance(hours=2)
    r.tick()
    [said] = receipts(r)
    assert said.startswith("<b>Not confirmed.</b>") and "a week has passed, so I've stopped reading it" in said
    assert "Reads couldn't tell whether it went through" in said
    reads.clear()
    sent = len(r.bot.sent)
    r.advance(days=2)
    r.tick()
    assert reads == [] and len(r.bot.sent) == sent and "still checking" not in r.cc.digest_line()


def test_reads_that_cant_tell_stop_once_the_event_is_over(r):
    path = FAMILY_PATH + "soon.ics"
    r.icloud.seed(path, event_on("soon", "Oil change", "20261022T150000Z", "20261022T160000Z"))
    r.icloud.drop_response_next = True
    r.tell(change(title="oil change", dates="2026-10-22"))
    r.icloud.down = True
    r.advance(hours=27)                        # past its end, Oct 22 at noon
    r.tick()
    [said] = receipts(r)
    assert said.startswith("<b>Not confirmed.</b>") and "it's over now, so I've stopped reading it" in said
    r.icloud.down = False
    r.advance(hours=2)
    r.tick()
    assert len(receipts(r)) == 1


def test_undo_leaves_a_gmail_add_he_changed_since(r):
    r.tell(change(calendar="gmail", op="add", title="Dentist", start="2026-11-20T09:00:00-05:00",
                  end="2026-11-20T10:00:00-05:00"))
    gid = next(k for k in r.gmail.events if k.startswith("cm"))
    r.gmail.events[gid].update(start={"dateTime": "2026-11-20T11:00:00-05:00"},
                               end={"dateTime": "2026-11-20T12:00:00-05:00"})
    r.gmail._bump(gid)                         # he moved it in Google Calendar
    r.press(r.with_button("Undo"), "Undo")
    assert r.texts()[-1].startswith("<b>Not undone:</b> someone changed that event since, so I left it alone.")
    assert r.gmail.events[gid].get("status") != "cancelled" and r.gmail.log[-1][0] == "insert"


def test_a_gmail_move_is_done_only_with_its_new_start_and_end(r):
    gmail_day(r)
    real = r.gmail.change

    def start_only(address, uid, fields, etag):
        return real(address, uid, {"start": fields["start"]}, etag)       # the end didn't take
    r.gmail.change = start_only
    r.tell(change(calendar="gmail", op="move", title="piano", dates="2026-11-09",
                  start="2026-11-09T10:00:00-05:00", end="2026-11-09T11:00:00-05:00"), words="move piano to 10")
    r.gmail.change = real
    assert receipts(r) == []                   # not done: its end is where it was
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Nothing changed.</b>") and "it didn't go through" in receipts(r)[-1]


def test_a_gmail_move_that_comes_back_cancelled_or_with_its_old_end_isnt_done():
    cc = CalendarChange.__new__(CalendarChange)
    cc.tz = TZ
    check = {"kind": "starts", "start": "2026-11-09T10:00:00-05:00", "end": "2026-11-09T11:00:00-05:00"}
    moved = {"start": {"dateTime": "2026-11-09T10:00:00-05:00"}, "end": {"dateTime": "2026-11-09T11:00:00-05:00"}}
    assert cc._gmail_shows(check, moved)
    assert not cc._gmail_shows(check, {**moved, "status": "cancelled"})
    assert not cc._gmail_shows(check, {**moved, "end": {"dateTime": "2026-11-09T09:00:00-05:00"}})


def test_a_family_move_is_read_back_by_the_day_it_moved_not_another_at_that_time(r):
    """Monday the 23rd moved to Wednesday the 25th at 8:30, when that Wednesday's own day starts
    then too: a server that drops the move isn't read as it having landed."""
    real = r.icloud.request

    def drops_it(method, url, **kw):
        if method == "PUT":
            kw["body"] = SERIES.encode()       # the server keeps its old text
        return real(method, url, **kw)
    r.icloud.request = drops_it
    r.tell(change(op="move", dates="2026-11-23", start="2026-11-25T08:30:00-05:00",
                  end="2026-11-25T15:00:00-05:00"), words="move monday's school to wednesday")
    assert receipts(r) == []                   # Wednesday's own 8:30 isn't the day it moved
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Nothing changed.</b>") and "it didn't go through" in receipts(r)[-1]


def test_a_series_end_is_read_by_its_own_rule_not_only_the_next_400_days():
    ended = ics_edit.end_from(SERIES, date(2027, 3, 8), TZ, NOW)
    assert ics_edit.ends_by(ended, date(2027, 3, 8), TZ)
    assert not ics_edit.ends_by(SERIES, date(2027, 3, 8), TZ)                    # its UNTIL is in May
    forever = SERIES.replace(";UNTIL=20270528T035959Z", "")
    assert not ics_edit.ends_by(forever, date(2027, 3, 8), TZ)                  # no end at all
    counted = SERIES.replace("UNTIL=20270528T035959Z", "COUNT=400")
    assert not ics_edit.ends_by(counted, date(2027, 3, 8), TZ)                  # runs into 2030
    assert ics_edit.ends_by(SERIES.replace("UNTIL=20270528T035959Z", "COUNT=3"), date(2026, 11, 20), TZ)
    later = ended.replace("SUMMARY:", "RDATE;TZID=America/New_York:20290305T083000\r\nSUMMARY:", 1)
    assert not ics_edit.ends_by(later, date(2027, 3, 8), TZ)                    # an extra day in 2029
    moved = ics_edit.move_day(SERIES, "20261123T133000Z", datetime(2028, 6, 1, 9, 0, tzinfo=NY),
                              datetime(2028, 6, 1, 10, 0, tzinfo=NY), TZ, NOW)
    cut = moved.replace("UNTIL=20270528T035959Z", "UNTIL=20270307T045959Z")
    assert not ics_edit.ends_by(cut, date(2027, 3, 8), TZ)                      # a day moved two years on
    cc = CalendarChange.__new__(CalendarChange)
    cc.tz = TZ
    assert not cc._family_shows({"kind": "ends", "day": "2027-03-08"}, cut)     # past what 400 days show
    assert cc._family_shows({"kind": "ends", "day": "2027-03-08"}, ended)


def test_a_write_cut_short_by_the_update_before_it_kept_a_plan_is_never_made_twice(r):
    """0.22 kept no plan: a write in flight then can't be read back. It isn't run again, by the
    runner or here, and he's told plainly what's known."""
    from harness import runner
    real = land_then_die(r)
    r.claude.script = [ask(change(op="add", title="Recital", start="2026-11-20T18:00:00-05:00",
                                  end="2026-11-20T19:00:00-05:00"))]
    with pytest.raises(Crash):
        r.say("add recital nov 20 6pm to family")
    r.icloud.request = real
    with r.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET settle_json=''")          # as 0.22 left it
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.tick()
    said = r.texts()[-1]
    assert said.startswith("<b>That was cut short.</b>") and "didn't write it again" in said
    assert "confirm" not in said and "may" not in said
    job = r.ledger.db.execute("SELECT id FROM jobs WHERE kind='message' ORDER BY created_at DESC").fetchone()
    assert json.loads(r.ledger.receipts(job["id"])[-1]["detail"])["reason"] not in runner.RETRYABLE
    assert r.c.runner.retry_recent_failures() == 0
    r.tick()
    assert len([p for p in r.icloud.events if "/hm-" in p]) == 1


def test_an_undo_tapped_while_stopped_comes_back_as_its_own_card(r):
    r.tell(change(dates="2026-11-23"))
    receipt = r.with_button("Undo")
    r.say("/stop")
    r.press(receipt, "Undo")
    stopped = [t for t in r.texts() if "didn't undo that" in t]
    assert stopped and "/resume" not in stopped[-1] and "tap Undo" not in stopped[-1]
    assert "2026-11-23" not in days_of(r.body())
    r.say("/resume")
    card = next(s for s in reversed(r.bot.sent) if s[2] and "you asked to undo" in s[1])
    assert card[1].startswith("While I was stopped, you asked to undo \u201cTook off the 8:30")
    assert [t for t, _ in card[2][0]] == ["Do it now", "Drop it"]
    r.press(card, "Do it now")
    assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())


def test_a_dropped_undo_card_stays_dropped(r):
    from harness import commands
    r.tell(change(dates="2026-11-23"))
    receipt = r.with_button("Undo")
    r.say("/stop")
    r.press(receipt, "Undo")
    r.say("/resume")
    card = next(s for s in reversed(r.bot.sent) if s[2] and "you asked to undo" in s[1])
    r.press(card, "Drop it")
    assert "Dropped. Nothing was done." in r.texts()
    key = json.loads(r.ledger.db.execute("SELECT detail FROM events WHERE kind='stopped_dropped'")
                     .fetchone()[0])["job"]
    assert commands.on_stopped_choice(r.ledger, "stopped_redo", key) == "That was dropped, so nothing was done."
    r.tick()
    assert "2026-11-23" not in days_of(r.body())


@pytest.mark.parametrize("words", [
    "Check Family for it.", "Check Home Assistant's time zone.", "Look at the calendar to see whether it's there.",
    "Make sure it's on the calendar.", "Verify it on your phone.", "Confirm it went through.",
    "Tap Undo again.", "After you turn me back on, tap Undo here.", "Retry it in a minute.",
    "Delete it on the calendar if needed.", "it may not be there.", "Then check the Family calendar.",
])
def test_the_ask_scan_catches_each_chore(words):
    from conftest import asks_in
    assert asks_in(words), words


@pytest.mark.parametrize("words", [
    "I couldn't confirm yet whether PT changed; I'm still checking.", "Undo tries what's left again.",
    "Nothing to do if that's right; tap Undo if it's wrong.", "I'll try again at the next read.",
    "<b>Not confirmed:</b> reads couldn't tell whether PT was added, and it's over now, so I've stopped reading it.",
    "Every Family calendar add needs your Approve tap again.", "event id derived from the effect id; before any retry",
    "DELETE FROM meta WHERE key=?", "the time may not be what you meant.",
])
def test_the_ask_scan_leaves_its_own_words_and_facts_alone(words):
    from conftest import asks_in
    assert asks_in(words) == [], words


# -- the D2 re-check: a read hands Undo only what was written, and keeps what Undo clears ------------

def test_his_edit_before_the_read_that_settles_a_write_is_left_by_undo(r):
    """A day taken off, its answer lost, and before the read he renames the event on his phone. The
    read finds the day off, so it's done, but the version it found isn't what was written: Undo
    leaves his event as it is, and says so."""
    r.icloud.drop_response_next = True
    r.tell(change(dates="2026-11-23"))
    r.icloud.human_edit(PATH, "School Day", "School Day (early release)")
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>")
    r.press(r.with_button("Undo"), "Undo")
    assert r.texts()[-1].startswith("<b>Not undone:</b> someone changed that event since, so I left it alone.")
    assert "School Day (early release)" in r.body() and "2026-11-23" not in days_of(r.body())


@pytest.mark.parametrize("old, new, his", [
    ("SUMMARY:", "DESCRIPTION:Bring the permission slip\r\nSUMMARY:", "DESCRIPTION:Bring the permission slip"),
    ("END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\nEND:VEVENT", "TRIGGER:-PT1H"),
    ("END:VEVENT", ICLOUD_OWN + "END:VEVENT", ""),
], ids=["a note", "an alert", "the server's own lines"])
def test_a_note_or_an_alert_he_adds_before_the_read_is_left_by_undo(r, old, new, his):
    """A day taken off, its answer lost, and before the read he adds a note or an alert. It's done,
    but not as written: Undo leaves his event as it is. Lines a server manages, a default alarm
    among them, are no one's edit: Undo puts the day back."""
    r.icloud.drop_response_next = True
    r.tell(change(dates="2026-11-23"))
    r.icloud.human_edit(PATH, old, new)
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>")
    r.press(r.with_button("Undo"), "Undo")
    if not his:
        assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())
        return
    assert r.texts()[-1].startswith("<b>Not undone:</b> someone changed that event since, so I left it alone.")
    assert his in r.body() and "2026-11-23" not in days_of(r.body())


def test_a_gmail_add_he_changed_before_its_read_is_left_by_undo(r):
    """An add whose answer was lost, moved and renamed in Google Calendar before the read. It's there,
    so it's done, but not as written: Undo leaves it."""
    real = r.gmail.insert

    def lands_lost(address, event):
        real(address, event)
        return caldav.Outcome("unknown")       # it landed; the answer didn't
    r.gmail.insert = lands_lost
    r.tell(change(calendar="gmail", op="add", title="Dentist", start="2026-11-20T09:00:00-05:00",
                  end="2026-11-20T10:00:00-05:00"))
    r.gmail.insert = real
    gid = next(k for k in r.gmail.events if k.startswith("cm"))
    r.gmail.events[gid].update(start={"dateTime": "2026-11-21T13:00:00-05:00"},
                               end={"dateTime": "2026-11-21T14:00:00-05:00"}, summary="Dentist (bring forms)")
    r.gmail._bump(gid)
    r.advance(minutes=1)
    r.tick()
    assert receipts(r)[-1].startswith("<b>Done.</b>")
    r.press(r.with_button("Undo"), "Undo")
    assert r.texts()[-1].startswith("<b>Not undone:</b> someone changed that event since, so I left it alone.")
    assert r.gmail.events[gid].get("status") != "cancelled" and r.gmail.events[gid]["summary"] == "Dentist (bring forms)"


def test_a_read_as_written_holds_on_servers_that_rewrite_and_not_after_an_edit():
    """Which comparison tells Harness's own write from an edit. A server stores an event its own way:
    lines it manages (X-APPLE lines, stamps, a default alarm), and a moved day's times in UTC.
    caldav._unchanged fails on the default alarm; every sent line by its spelling fails on the UTC
    times. caldav._as_sent (what was sent and nothing more, by what it says, server-managed lines
    aside) holds on both, and shows a rename, even of one title of two alike, and a note, an alert,
    a place, a guest or a link someone adds."""
    def utc(m):
        moment = datetime.strptime(m.group(2), "%Y%m%dT%H%M%S").replace(tzinfo=NY).astimezone(timezone.utc)
        return f"{m.group(1)}:{moment:%Y%m%dT%H%M%SZ}"

    def utc_overrides(ics):                    # its own lines in the master; its moved days in UTC
        head, sep, rest = icloud_keeps(ics).partition("END:VEVENT")
        return head + sep + re.sub(r"(RECURRENCE-ID|DTSTART|DTEND);TZID=America/New_York:(\d{8}T\d{6})", utc, rest)

    edits = [lambda k: k.replace("School Day", "School Day (early release)", 1),
             lambda k: k.replace("SUMMARY:", "DESCRIPTION:Bring the permission slip\r\nSUMMARY:", 1),
             lambda k: k.replace("END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\n"
                                               "END:VEVENT", 1),
             lambda k: k.replace("SUMMARY:", "LOCATION:Gym\r\nSUMMARY:", 1),
             lambda k: k.replace("SUMMARY:", "ATTENDEE:mailto:guest@example.com\r\nSUMMARY:", 1),
             lambda k: k.replace("SUMMARY:", "URL:https://example.com/day\r\nSUMMARY:", 1)]
    key, ten = "20261123T133000Z", datetime(2026, 11, 23, 10, 0, tzinfo=NY)
    off = ics_edit.remove_days(SERIES, [key], TZ, NOW)
    moved = ics_edit.move_day(SERIES, key, ten, ten + timedelta(hours=4), TZ, NOW)
    for sent in (off, moved):
        for server in (icloud_keeps, utc_overrides):
            kept = server(sent)
            assert caldav._as_sent(kept, sent), (sent, server)
            assert not any(caldav._as_sent(edit(kept), sent) for edit in edits)
    assert not caldav._unchanged(icloud_keeps(off), off)

    def spelled(kept, sent):
        return set(caldav._content(sent)) <= set(caldav._content(kept))
    assert spelled(icloud_keeps(moved), moved) and not spelled(utc_overrides(moved), moved)
    own_alarm_with_its_id = icloud_keeps(off).replace("BEGIN:VALARM\r\nX-WR-ALARMUID",
                                                      "BEGIN:VALARM\r\nUID:ALARM-1\r\nX-WR-ALARMUID", 1)
    assert caldav._uids(own_alarm_with_its_id) == {UID} and caldav._as_sent(own_alarm_with_its_id, off)


def test_undo_of_a_write_a_restart_cut_short_clears_what_it_recorded(r):
    """The write lands and the process dies before its answer is handled, and a read settles it.
    Its Undo keeps what the usual path keeps (the day it took off, the records it changed), so Undo
    clears them too, and no digest says the day came back."""
    real = land_then_die(r)
    r.claude.script = [ask(change(dates="2026-11-23"))]
    with pytest.raises(Crash):
        r.say("no school Nov 23")
    r.icloud.request = real
    rows = [{"table": "family_copies", "key": "no-such-copy", "set": {"missing": 0}, "was": {"missing": 0}}]
    plan = json.loads(r.ledger.db.execute("SELECT settle_json FROM calendar_changes").fetchone()[0])
    plan["parts"][0]["steps"][0]["rows"] = rows        # as a step that also keeps a copy's record true
    with r.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET settle_json=?", (json.dumps(plan),))
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.advance(minutes=1)
    r.tick()
    [entry] = json.loads(r.ledger.db.execute("SELECT undo_json FROM calendar_changes").fetchone()[0])
    assert [x[:2] for x in entry.get("removed", [])] == [["family", UID]] and entry.get("rows") == rows
    r.press(r.with_button("Undo"), "Undo")
    assert "Undone" in r.texts()[-1] and "2026-11-23" in days_of(r.body())
    assert r.ledger.db.execute("SELECT COUNT(*) FROM calendar_removed").fetchone()[0] == 0
    r.advance(minutes=31)
    r.tick()
    assert "came back" not in r.cc.digest_line()


def test_do_it_now_on_a_stopped_undo_is_kept_through_a_restart_right_then(r, monkeypatch):
    """His Do it now is taken, and the process dies before the Undo's own module runs: the Undo was
    asked for with the card's answer, so the next process carries it out."""
    from harness import callbacks
    r.tell(change(dates="2026-11-23"))
    receipt = r.with_button("Undo")
    r.say("/stop")
    r.press(receipt, "Undo")
    r.say("/resume")
    card = next(s for s in reversed(r.bot.sent) if s[2] and "you asked to undo" in s[1])

    def dies(self, which, target):
        raise Crash()
    monkeypatch.setattr(callbacks.Callbacks, "_undo_kept", dies)
    with pytest.raises(Crash):
        r.press(card, "Do it now")
    r.start()
    r.cc.bind(r.vault.owner_id())
    r.tick()
    assert "Undone" in r.texts()[-1] and ical.unfold(r.body()) == ical.unfold(SERIES)
