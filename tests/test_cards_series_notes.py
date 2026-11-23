"""Harness 0.24.5: readable multi-event cards, series told apart by what he said, and notes read afresh.

Against the fake calendars and a fake Discord: a removal of several days of a repeating event reads as one
short list on its card, its tap notice and its receipt (title, calendar and scope once, the days on one line,
no ids, one warning line); an end of one of two series under one name finds the one he means by its exact
title, the weekday he named or an id ending, and asks with one card when nothing tells them apart; a new note
on a message answered "not a change" is read afresh, and the same "Nothing changed" isn't sent twice.
All names and ids invented.
"""
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import calendar_change
from fakes import result
from test_discord_keeper import OWNER
from test_plain_commands import GMAIL, NY, TZ, Morning, ask, change, nothing_he_shouldnt_see  # noqa: F401
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def _series(m, sid, title, first: date, rule, days: list[date], hour=8, minute=30):
    """A weekly series on his Gmail calendar that began the week before `first`, with the days of it Google
    lists. A change to its rule cancels the days it no longer holds, as Google lists them."""
    start = datetime(first.year, first.month, first.day, hour, minute, tzinfo=NY) - timedelta(weeks=1)
    m.gmail.events[sid] = {"id": sid, "summary": title, "status": "confirmed", "etag": '"s"',
                           "organizer": {"email": GMAIL, "self": True}, "recurrence": [rule],
                           "start": {"dateTime": start.isoformat(), "timeZone": TZ},
                           "end": {"dateTime": (start + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
    out = []
    for d in days:
        at = datetime(d.year, d.month, d.day, hour, minute, tzinfo=NY)
        uid = f"{sid}_{at.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
        m.gmail.events[uid] = {"id": uid, "recurringEventId": sid, "summary": title, "status": "confirmed",
                               "etag": f'"{d.day}{d.month}"', "organizer": {"email": GMAIL, "self": True},
                               "originalStartTime": {"dateTime": at.isoformat()},
                               "start": {"dateTime": at.isoformat(), "timeZone": TZ},
                               "end": {"dateTime": (at + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
        out.append(uid)
    if not getattr(m, "_expands", False):
        m._expands = True
        real = m.gmail.change

        def change_and_expand(address, uid, fields, etag):
            got = real(address, uid, fields, etag)
            rule = " ".join(m.gmail.events[uid].get("recurrence") or [])
            until = re.search(r"UNTIL=(\d{8})", rule)
            for e in m.gmail.events.values():
                if e.get("recurringEventId") == uid:
                    late = until and e["start"]["dateTime"][:10].replace("-", "") > until.group(1)
                    e["status"] = "cancelled" if late else "confirmed"
            return got
        m.gmail.change = change_and_expand
    return out


def mondays(n, first=date(2026, 11, 16)):
    return [first + timedelta(weeks=i) for i in range(n)]


def proposal(m):
    return m.ledger.db.execute("SELECT id FROM proposals WHERE state='proposed' ORDER BY rowid DESC").fetchone()[0]


# -- 1. several days off a repeating event: one short list -------------------------------------------------------

@pytest.mark.parametrize("n, days_line", [
    (3, "Mon Nov 16, Nov 23, Nov 30"),
    (11, "Mon Nov 16, Nov 23, Nov 30, Dec 7 ... Jan 25 (11 days)"),
])
def test_several_days_off_a_series_read_as_one_list_on_the_card_the_notice_and_the_receipt(m, n, days_line):
    days = mondays(n)
    uids = _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=",".join(d.isoformat() for d in days)))]
    mid = m.he_says("no swim on those mondays")
    out = m.handover(paired=OWNER, message=mid)
    assert out["status"] == "waiting for his tap"
    card = m.seen()[-1]
    assert "Take off “Swim”, 8:30 AM, Gmail calendar:\n" + days_line + "\n" in card
    # Below his quoted words and what they were read as, the change itself: title and calendar once.
    change_block = card[card.index("Take off \u201cSwim\u201d"):]
    assert change_block.count("Swim") == 1 and change_block.count("Gmail") == 1
    assert card.count("Each of those days only, the rest of the series stays.") == 1
    assert "this occurrence only" not in card and "id ending" not in card
    assert not any(u.split("_")[1][:8] in card for u in uids)
    # The warnings, folded into one line: its points between semicolons, never a dash.
    assert card.count("Check before approving") == 1 and f"this takes off {n} events at once" in card
    warning = next(x for x in card.split("\n") if "Check before approving" in x)
    assert "—" not in card and "–" not in card and warning.endswith(".")
    # The ids are bound in the ledger all the same, one for each day.
    assert len(m.cc.bound_of(proposal(m))["bound"]) == n
    assert m.labels().count("Approve") == 1 and m.labels().count("Decline") == 1
    m.tap("Approve")
    notice = next(t for t in m.seen() if t.startswith("Approved"))
    assert notice == ("Approved. Doing it now:\nTake off “Swim”, 8:30 AM, Gmail calendar:\n" + days_line
                      + "\nEach of those days only, the rest of the series stays.")
    done = m.seen()[-1]
    assert done.startswith("Done.\nTook off “Swim”, 8:30 AM, Gmail calendar:\n" + days_line
                           + "\nEach of those days only, the rest of the series stays.")
    assert done.count("Swim") == 1 and "id ending" not in done
    assert all(m.gmail.events[u]["status"] == "cancelled" for u in uids)
    assert m.gmail.events["swim0mon0series"]["status"] == "confirmed"


def test_one_day_off_a_series_keeps_its_one_line_and_shows_no_id(m):
    days = mondays(2)
    _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=days[0].isoformat()))]
    m.handover(paired=OWNER, message=m.he_says("no swim monday"))
    # One event off goes without a card; its receipt keeps its one line, and no id anywhere.
    assert m.seen()[-1].startswith("Done.\nTook off Monday's 8:30 Swim (Gmail)")
    assert not any("id ending" in t for t in m.seen())


def test_days_line_keeps_the_weekday_once_and_shortens_a_long_list():
    assert calendar_change.days_line([date(2026, 12, 28), date(2026, 12, 21)]) == "Mon Dec 21, Dec 28"
    assert calendar_change.days_line(mondays(7, date(2026, 12, 21))) == \
        "Mon Dec 21, Dec 28, Jan 4, Jan 11 ... Feb 1 (7 days)"


# -- 2. which series an end means ---------------------------------------------------------------------------------

MON_ID = "swim0emoji7a1b2c"
PLAIN_ID = "swim0plain9f8e7d"


def two_swims(m):
    """A plain Swim on Tuesdays and Thursdays since Nov 3 (its first listed day Nov 17), and a Swim with an emoji on Mondays that only
    starts on Nov 16."""
    plain_days = [date(2026, 11, 17) + timedelta(days=d) for d in (0, 2, 7, 9, 14, 16, 21, 23)]
    _series(m, PLAIN_ID, "Swim", date(2026, 11, 10), "RRULE:FREQ=WEEKLY;BYDAY=TU,TH", plain_days, hour=17)
    _series(m, MON_ID, "\U0001F3CA Swim", date(2026, 11, 30), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(3))
    m.gmail.events[MON_ID]["start"] = {"dateTime": datetime(2026, 11, 16, 8, 30, tzinfo=NY).isoformat(), "timeZone": TZ}
    m.gmail.events[MON_ID]["end"] = {"dateTime": datetime(2026, 11, 16, 9, 30, tzinfo=NY).isoformat(), "timeZone": TZ}


def ended(m):
    return {b["series"] for b in m.cc.bound_of(proposal(m))["bound"]}


@pytest.mark.parametrize("words", [
    "end the \U0001F3CA Swim series from the 15th on, the whole series from then on",
    "end the Monday swim series from the 15th on, the whole series from then on",
    "end the swim on Mondays from the 15th on",
    "end swim from the 15th on, the one with id ending 7a1b2c",
])
def test_an_end_finds_the_series_he_means_by_its_exact_title_its_weekday_or_its_id(m, words):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says(words))
    said = m.seen()[-1]
    assert out["status"] == "waiting for his tap", said
    assert "Say which days of the week" not in said and "only starts on" not in said
    assert ended(m) == {MON_ID} and "the whole series from then on" in said


def test_the_day_he_gave_tells_them_apart_when_only_one_has_it_next(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 16th on, the whole series from then on"))
    assert out["status"] == "waiting for his tap" and ended(m) == {MON_ID}


def test_nothing_to_tell_them_apart_asks_with_one_card_a_button_each(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 15th on"))
    card = m.seen()[-1]
    assert out["status"] == "needs_clarification"
    assert "Which series do you mean?" in card and "Say which days" not in card
    assert "1. “\U0001F3CA Swim” on Mondays, next Mon Nov 16" in card
    assert "2. “Swim” on Tuesdays and Thursdays, next Tue Nov 17" in card
    assert m.labels().count("Series 1") == 1 and m.labels().count("Series 2") == 1
    assert "Approve" not in m.labels()
    assert m.gmail.log == []                                  # nothing written
    m.tap("Series 2")
    assert "Approve" in m.labels() and ended(m) == {PLAIN_ID}
    m.tap("Approve")
    assert m.seen()[-1].startswith("Done.") and "UNTIL" in m.gmail.events[PLAIN_ID]["recurrence"][0]
    assert m.gmail.events[MON_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_said_weekdays_are_the_series_days_not_a_date():
    assert calendar_change.said_weekdays("the Monday swim") == {0}
    assert calendar_change.said_weekdays("swim on Mondays and Thursdays") == {0, 3}
    assert calendar_change.said_weekdays("end swim from Monday on") == set()
    assert calendar_change.said_weekdays("end swim Monday Nov 16") == set()


# -- 3 and 4. a note on a message answered "not a change" ---------------------------------------------------------

def test_a_new_note_on_a_message_answered_not_a_change_is_read_afresh(m):
    two_swims(m)
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    first = m.handover(paired=OWNER, message=mid)
    assert first["status"] == "not a change" and "Nothing changed" in first["said"]
    told = len(m.seen())
    # A different note, whose content warrants a change: read afresh, and a card of its own.
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means the Monday \U0001F3CA Swim series, not karate.")
    assert len(m.claude.calls) == 2 and again["status"] == "waiting for his tap"
    assert again.get("cards") != first.get("cards") and len(m.seen()) == told + 1
    assert ended(m) == {MON_ID}


def test_the_same_nothing_changed_is_sent_once_per_message(m):
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    first = m.handover(paired=OWNER, message=mid)
    assert first["status"] == "not a change"
    told = len(m.seen())
    # Another note, the same outcome: Cain hears it, and no second card goes to him.
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means karate on Mondays.")
    assert len(m.claude.calls) == 2 and again["status"] == "not a change"
    assert "Nothing changed" in again["said"] and "wasn't sent to him again" in again["said"]
    assert len(m.seen()) == told and not again.get("cards")
    # The same note again changes nothing and asks nothing.
    third = m.handover(paired=OWNER, message=mid, suggestion="He means karate on Mondays.")
    assert len(m.claude.calls) == 2 and len(m.seen()) == told and third["status"] == "not a change"
