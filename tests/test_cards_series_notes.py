"""Harness 0.24.5: readable multi-event cards, series told apart by what he said, and notes read afresh.

Against the fake calendars and a fake Discord: a removal of several days of a repeating event reads as one
short list on its card, its tap notice and its receipt (title, calendar and scope once, the days on one line,
no ids, one warning line); an end of one of two series under one name finds the one he means by its exact
title, the weekday he named or an id ending, and asks with one card when nothing tells them apart; a new note
on a message answered "not a change" is read afresh, and the same "Nothing changed" isn't sent twice.
Review round: every day on the card (only the receipt shortens), two series of one title as two lists, no
first-day tiebreak, selectors on a whitelist and checked against each other, the run bound to the card's series
ids, the which-one card's pick taken once and checked, notes re-run at most twice, and the check line's hyphens.
Round 3: the exact removal set bound (each day by id and start, an end's days from its cutoff by fingerprint, the
series's version), the weekly range only for every week at one time, the note re-run claimed in the ledger, note-only
selectors never deciding, weekday cues and set equality, "Nothing changed" keyed on the facts, more than 20 candidates
asked in words, and dashes between digits kept. All names and ids invented.
"""
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import calendar_change
from harness.ledger import Ledger
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

@pytest.mark.parametrize("n, card_days, receipt_days", [
    (3, "Mon Nov 16, Nov 23, Nov 30", "Mon Nov 16, Nov 23, Nov 30"),
    # Review round: the card he approves lists every day (a weekly run as one range, the year when it crosses
    # one); only the receipt shortens a long list.
    (11, "Mon Nov 16, 2026 to Jan 25, 2027 (weekly)", "Mon Nov 16, 2026, Nov 23, Nov 30, Dec 7 ... Jan 25, 2027 (11 days)"),
])
def test_several_days_off_a_series_read_as_one_list_on_the_card_the_notice_and_the_receipt(m, n, card_days,
                                                                                          receipt_days):
    days = mondays(n)
    uids = _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=",".join(d.isoformat() for d in days)))]
    mid = m.he_says("no swim on those mondays")
    out = m.handover(paired=OWNER, message=mid)
    assert out["status"] == "waiting for his tap"
    card = m.seen()[-1]
    assert "Take off “Swim”, 8:30 AM, Gmail calendar:\n" + card_days + "\n" in card
    # Below his quoted words and what they were read as, the change itself: title and calendar once.
    change_block = card[card.index("Take off \u201cSwim\u201d"):]
    assert change_block.count("Swim") == 1 and change_block.count("Gmail") == 1
    assert card.count("Each of those days only, the rest of the series stays.") == 1
    assert "this occurrence only" not in card and "id ending" not in card and "..." not in card
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
    assert notice == ("Approved. Doing it now:\nTake off “Swim”, 8:30 AM, Gmail calendar:\n" + card_days
                      + "\nEach of those days only, the rest of the series stays.")
    done = m.seen()[-1]
    assert done.startswith("Done.\nTook off “Swim”, 8:30 AM, Gmail calendar:\n" + receipt_days
                           + "\nEach of those days only, the rest of the series stays.")
    assert done.count("Swim") == 1 and "id ending" not in done
    assert all(m.gmail.events[u]["status"] == "cancelled" for u in uids)
    assert m.gmail.events["swim0mon0series"]["status"] == "confirmed"


def test_two_series_of_one_title_on_one_calendar_are_two_lists_on_the_card_the_notice_and_the_receipt(m):
    """Review round: the list's key holds the series (its master event's id) and its start time, so two series
    called Swim on Gmail, removed on different days, are never one list, even at the same time."""
    mons = mondays(2)
    weds = [d + timedelta(days=2) for d in mons]
    mon_uids = _series(m, "swim0series0aaaa", "Swim", mons[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", mons)
    wed_uids = _series(m, "swim0series0bbbb", "Swim", weds[0], "RRULE:FREQ=WEEKLY;BYDAY=WE", weds)
    every = sorted(mons + weds)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=",".join(d.isoformat() for d in every)))]
    out = m.handover(paired=OWNER, message=m.he_says("no swim on those days"))
    assert out["status"] == "waiting for his tap", m.seen()[-1]
    card = m.seen()[-1]
    mon_list = "Take off “Swim”, 8:30 AM, Gmail calendar, the series on Mondays:\nMon Nov 16, Nov 23\n"
    wed_list = "Take off “Swim”, 8:30 AM, Gmail calendar, the series on Wednesdays:\nWed Nov 18, Nov 25\n"
    assert mon_list in card and wed_list in card
    m.tap("Approve")
    notice = next(t for t in m.seen() if t.startswith("Approved"))
    assert mon_list in notice + "\n" and wed_list in notice + "\n"
    done = m.seen()[-1]
    assert "Took off “Swim”, 8:30 AM, Gmail calendar, the series on Mondays:\nMon Nov 16, Nov 23\n" in done
    assert "Took off “Swim”, 8:30 AM, Gmail calendar, the series on Wednesdays:\nWed Nov 18, Nov 25\n" in done
    assert all(m.gmail.events[u]["status"] == "cancelled" for u in mon_uids + wed_uids)


def test_one_day_off_a_series_keeps_its_one_line_and_shows_no_id(m):
    days = mondays(2)
    _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=days[0].isoformat()))]
    m.handover(paired=OWNER, message=m.he_says("no swim monday"))
    # One event off goes without a card; its receipt keeps its one line, and no id anywhere.
    assert m.seen()[-1].startswith("Done.\nTook off Monday's 8:30 Swim (Gmail)")
    assert not any("id ending" in t for t in m.seen())


def test_days_line_lists_every_day_on_the_card_and_shortens_only_the_receipt():
    assert calendar_change.days_line([date(2026, 12, 28), date(2026, 12, 21)]) == "Mon Dec 21, Dec 28"
    # Every day, a weekly run of four or more as one range, the year where the list crosses one.
    # Round 3: the range only for every week with none missing at one time; a few weeks left out are "except".
    gap = [date(2026, 12, 21), date(2027, 1, 4), date(2027, 1, 11), date(2027, 1, 18), date(2027, 1, 25),
           date(2027, 2, 8)]
    assert calendar_change.days_line(gap) == \
        "Mon Dec 21, 2026 to Feb 8, 2027 (weekly), except Dec 28, 2026 and Feb 1, 2027"
    assert calendar_change.days_line(mondays(5, date(2027, 1, 4))) == "Mon Jan 4 to Feb 1 (weekly)"
    assert calendar_change.days_line(mondays(3, date(2027, 1, 4))) == "Mon Jan 4, Jan 11, Jan 18"
    assert calendar_change.days_line(mondays(7, date(2026, 12, 21))) == "Mon Dec 21, 2026 to Feb 1, 2027 (weekly)"
    # The receipt only: first four, the last, how many.
    assert calendar_change.days_line(mondays(7, date(2026, 12, 21)), short=True) == \
        "Mon Dec 21, 2026, Dec 28, Jan 4, 2027, Jan 11 ... Feb 1 (7 days)"
    assert calendar_change.days_line(mondays(7, date(2027, 1, 4)), short=True) == \
        "Mon Jan 4, Jan 11, Jan 18, Jan 25 ... Feb 15 (7 days)"
    # Times that differ are given day by day, and a run never spans two times.
    times = {date(2027, 1, 4): "8:30 AM", date(2027, 1, 11): "9:30 AM"}
    assert calendar_change.days_line(list(times), clocks=times) == "Mon Jan 4 8:30 AM, Jan 11 9:30 AM"


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


def test_the_day_he_gave_never_picks_a_series_whose_end_would_delete_it(m):
    """Review round: no first-day tiebreak. The emoji Swim only starts on the 16th, the day he gave, so ending
    both from then would delete it: he picks, even though only it has the 16th next."""
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 16th on, the whole series from then on"))
    assert out["status"] == "needs_clarification" and "Which series do you mean?" in m.seen()[-1]
    assert "Approve" not in m.labels() and m.gmail.log == []


def test_a_whole_series_taken_off_says_so_with_its_days_and_first_date(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=m.he_says("end the \U0001F3CA Swim series from the 15th on"))
    card = m.seen()[-1]
    assert "this takes off the whole “\U0001F3CA Swim” series (Mondays, first Mon Nov 16)" in card


def test_plain_words_with_a_plain_and_an_emoji_series_ask_which_even_when_neither_would_be_deleted(m):
    """Review round: "swim" names the plain Swim on word boundaries, and the emoji Swim differs from it only by
    its emoji, so nothing narrows: one card asks which, even with both already going."""
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-20"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 20th on"))
    card = m.seen()[-1]
    assert out["status"] == "needs_clarification" and "Which series do you mean?" in card
    assert m.labels().count("Series 1") == 1 and m.labels().count("Series 2") == 1


@pytest.mark.parametrize("words, conflict", [
    ("end the Monday swim series from the 15th on, the one with id ending 9f8e7d", "points to different series"),
    ("end swim from the 15th on, the one with id ending 0000aaaa", "no Swim series fits the id ending 0000aaaa"),
])
def test_selectors_that_disagree_or_match_nothing_are_a_question_never_dropped(m, words, conflict):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says(words))
    card = m.seen()[-1]
    assert out["status"] == "needs_clarification" and "Which series do you mean?" in card and conflict in card
    assert "Approve" not in m.labels()


def test_the_run_ends_exactly_the_series_its_card_bound_even_with_a_new_one_since(m):
    """Review round: the run takes the series ids bound at the card and never narrows again from his words. A
    Swim on Mondays added after the card (which his words would now also fit, and which only starts then, so a
    fresh narrowing would ask which) changes nothing about which ends."""
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-22"))]
    m.handover(paired=OWNER, message=m.he_says("end the Monday swim series from the 22nd on"))
    assert ended(m) == {MON_ID}
    _series(m, "swim0late0mon0new", "\U0001F3CA Swim", date(2026, 11, 30), "RRULE:FREQ=WEEKLY;BYDAY=MO",
            mondays(2, date(2026, 11, 23)))
    m.gmail.events["swim0late0mon0new"]["start"] = {
        "dateTime": datetime(2026, 11, 23, 8, 30, tzinfo=NY).isoformat(), "timeZone": TZ}
    m.tap("Approve")
    assert m.seen()[-1].startswith("Done."), m.seen()[-1]
    assert "UNTIL=20261122" in m.gmail.events[MON_ID]["recurrence"][0]
    assert m.gmail.events["swim0late0mon0new"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    assert m.gmail.events[PLAIN_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"]


def test_a_bound_series_whose_rule_changed_is_refused_as_changed_and_a_fresh_card_follows(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=m.he_says("end the Monday swim series from the 15th on"))
    first = proposal(m)
    m.gmail.events[MON_ID]["recurrence"] = ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"]
    m.tap("Approve")
    said = [t for t in m.seen() if "changed since your card" in t]
    assert said and "repeats differently now" in said[-1] and "A fresh card" in said[-1]
    assert m.gmail.events[MON_ID]["status"] == "confirmed" and not any(
        x for x in m.gmail.log if MON_ID in str(x))
    assert proposal(m) != first and m.labels().count("Approve") >= 1
    assert {b.get("rule") for b in m.cc.bound_of(proposal(m))["bound"]} == {"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"}


def _which_card(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    mid = m.he_says("end swim from the 15th on")
    out = m.handover(paired=OWNER, message=mid)
    assert out["status"] == "needs_clarification"
    token = next(r[0].split(":", 1)[1] for r in m.ledger.db.execute(
        "SELECT key FROM meta WHERE key LIKE 'calendar_change_which:%'"))
    return mid, token


def test_the_which_card_counts_as_a_card_so_a_note_doesnt_run_it_again_in_place(m):
    mid, _ = _which_card(m)
    job = m.ledger.db.execute("SELECT id FROM jobs WHERE message_id=?", (int(mid),)).fetchone()[0]
    states = {job: m.ledger.job(job)["state"]}
    assert not m.c._no_card_ever([job], states)
    calls = len(m.claude.calls)
    m.handover(paired=OWNER, message=mid, suggestion="He means the plain one.")
    assert len(m.claude.calls) == calls                       # not read again: his which card stands
    assert m.labels().count("Series 1") == 1


def test_a_pick_is_taken_once_and_a_second_tap_makes_no_second_end_card(m):
    _, token = _which_card(m)
    m.tap("Series 2")
    cards = m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0]
    assert cards == 1 and ended(m) == {PLAIN_ID}
    # The same pick again, or the other one, after the first: nothing more.
    assert m.c.runner._which_picked(f"{token}:1") == "Already done."
    assert m.c.runner._which_picked(f"{token}:0") == "Already done."
    assert m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 1
    # The card's other button came off with the tap.
    assert m.c.runner.ledger.db.execute("SELECT COUNT(*) FROM choices WHERE kind='calendar_change_which'"
                                        " AND consumed_at IS NULL").fetchone()[0] == 0


def test_a_pick_outside_the_card_or_of_a_series_changed_since_makes_no_end_card(m):
    _, token = _which_card(m)
    assert m.c.runner._which_picked(f"{token}:7") == "Nothing changed."
    m.gmail.events[PLAIN_ID]["recurrence"] = ["RRULE:FREQ=WEEKLY;BYDAY=TU"]
    got = m.c.runner._which_picked(f"{token}:1")
    assert got == "Nothing changed: that series repeats differently since the card, so no end card was made."
    assert m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 0


def test_every_candidate_gets_a_button_in_rows_of_five(m):
    for i, code in enumerate(("MO", "TU", "WE", "TH", "FR", "SA")):
        first = date(2026, 11, 16) + timedelta(days=i)
        _series(m, f"swim0day0{code.lower()}0000", "Swim", first, f"RRULE:FREQ=WEEKLY;BYDAY={code}",
                [first, first + timedelta(weeks=1)])
    # One of them only starts on the day he gave, so ending all of them isn't possible: he picks.
    m.gmail.events["swim0day0mo0000"]["start"] = {"dateTime": datetime(2026, 11, 16, 8, 30, tzinfo=NY).isoformat(),
                                                  "timeZone": TZ}
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 16th on"))
    assert out["status"] == "needs_clarification"
    assert [m.labels().count(f"Series {i}") for i in range(1, 7)] == [1] * 6
    card = max(m.link.cards)
    rows = [[c["label"] for c in r["components"]] for r in m.link.cards[card]["rows"]]
    assert [len(r) for r in rows if r[0].startswith("Series")] == [5, 1] and len(rows) <= 5


def test_two_of_one_title_on_the_same_days_are_told_apart_by_time_and_next_day_and_the_pick_binds_its_id(m):
    _series(m, "swim0early0mon00", "Swim", date(2026, 11, 23), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(2, date(2026, 11, 23)))
    _series(m, "swim0late00mon00", "Swim", date(2026, 11, 16), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(3), hour=17,
            minute=0)
    m.gmail.events["swim0early0mon00"]["start"] = {
        "dateTime": datetime(2026, 11, 23, 8, 30, tzinfo=NY).isoformat(), "timeZone": TZ}
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end the swim on mondays from the 16th on"))
    card = m.seen()[-1]
    assert out["status"] == "needs_clarification", card
    assert "“Swim” on Mondays at 5:00 PM, next Mon Nov 16, Gmail calendar" in card
    assert "“Swim” on Mondays at 8:30 AM, next Mon Nov 23, Gmail calendar" in card
    labels = [x for x in m.labels() if x.startswith("Series")]
    assert sorted(labels) == ["Series 1: next Nov 16, 5:00 PM", "Series 2: next Nov 23, 8:30 AM"]
    m.tap("Series 2: next Nov 23, 8:30 AM")
    assert "Approve" in m.labels() and ended(m) == {"swim0early0mon00"}
    m.tap("Approve")
    assert m.gmail.events["swim0early0mon00"]["status"] == "cancelled"
    assert m.gmail.events["swim0late00mon00"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


@pytest.mark.parametrize("text, days", [
    # A selector: a plural, "every", a noun after it, or the event's own title word next.
    ("end swim on Mondays", {0}),
    ("swim on Mondays and Thursdays", {0, 3}),
    ("end it every Monday", {0}),
    ("the Monday series", {0}),
    ("the Monday one", {0}),
    ("the Monday swim series", {0}),
    ("the Mon. swim series", {0}),
    ("end it on Mons", {0}),
    ("the Thurs one", {3}),
    ("every Wed", {2}),
    # A date, not a selector.
    ("end swim from Monday on", set()),
    ("end swim on Monday", set()),
    ("end swim Monday Nov 16", set()),
    ("end swim Monday, Nov 16", set()),
    ("end swim Monday the 16th", set()),
    ("end swim Monday 16th", set()),
    ("end swim Monday at 5", set()),
    ("end swim Monday 5pm", set()),
    ("end swim this Monday", set()),
    ("end swim last Monday", set()),
    ("end swim next Monday", set()),
    ("end swim until Monday", set()),
    ("end swim by Monday", set()),
    ("end swim before Monday", set()),
    ("end swim after Monday", set()),
    ("Monday's swim is off", set()),
    ("end swim from Mondays", set()),
    ("end it Mon", set()),
    # Round 3: a day before a title word alone is one day of it, never a schedule.
    ("the Monday swim", set()),
    ("Monday swim is done", set()),
    ("the Mon swim", set()),
    ("the Mon. swim", set()),
    ("the Tues swim", set()),
    ("end the Monday swim from the 15th on", set()),
    # Round 3: a day of it beside a schedule that shares some of its days: only the schedule's days count.
    ("skip Monday swim, and end the swim on Mondays and Wednesdays", {0, 2}),
    ("Monday swim is moved; end the Mondays and Wednesdays series", {0, 2}),
    ("cancel the Thursday swim but end every Tuesday and the Thursday one", {1, 3}),
    ("no Wednesday swim this week, the Wednesdays and Fridays one ends", {2, 4}),
    ("the Monday swim is off, end the Monday series", {0}),
    ("end the Tuesdays swim, not the Tuesday swim next week", {1}),
])
def test_said_weekdays_is_a_whitelist_of_selector_shapes(text, days):
    assert calendar_change.said_weekdays(text, ["\U0001F3CA Swim"]) == days


def test_a_note_s_weekdays_count_only_with_his_own_words(m):
    """His words first: a weekday only in Cain's note doesn't narrow (it isn't his), so he's asked."""
    two_swims(m)
    mid = m.he_says("end swim from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    assert m.handover(paired=OWNER, message=mid)["status"] == "not a change"
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means the swim on Mondays.")
    assert again["status"] == "needs_clarification" and "Which series do you mean?" in m.seen()[-1]


def test_titles_are_matched_on_word_boundaries():
    assert calendar_change._said_title("Swim", "end swim from monday")
    assert not calendar_change._said_title("Swim", "end swimming from monday")
    assert not calendar_change._said_title("\U0001F3CA Swim", "end swim from monday")
    assert calendar_change._said_title("\U0001F3CA Swim", "end the \U0001F3CA swim series")


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
    # Round 3: the exact title and the weekday are only the note's, so they don't pick the series by themselves:
    # the which-one card, the note's pick first, saying it was reconsidered.
    assert len(m.claude.calls) == 2 and again["status"] == "needs_clarification"
    assert again.get("cards") != first.get("cards") and len(m.seen()) == told + 1
    card = m.seen()[-1]
    assert card.startswith("Reconsidered after Cain's note:\nWhich series do you mean?")
    assert "1. “\U0001F3CA Swim” on Mondays, next Mon Nov 16 (Cain's note points to this one)" in card
    m.tap("Series 1")
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


# -- review round: notes re-run in place at most twice; "Nothing changed" counts once sent -----------------------

def test_in_place_re_runs_stop_at_the_cap_and_cain_hears_it(m):
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    assert m.handover(paired=OWNER, message=mid)["status"] == "not a change"
    for i, note in enumerate(("He means karate on Mondays.", "He means the karate class.")):
        m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
        m.handover(paired=OWNER, message=mid, suggestion=note)
        assert len(m.claude.calls) == i + 2
    third = m.handover(paired=OWNER, message=mid, suggestion="He means the karate at the gym.")
    assert len(m.claude.calls) == 3                            # not read again
    assert third["status"] == "not a change" and "the most for one message" in third["said"]
    assert m.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='job_note_capped'").fetchone()[0] == 1


def test_a_nothing_changed_whose_send_failed_is_sent_again_on_the_next_note(m):
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    assert m.handover(paired=OWNER, message=mid)["status"] == "not a change"
    # Its send failed after all: the key doesn't count it as said.
    m.ledger.db.execute("UPDATE outbox SET state='dead' WHERE text LIKE 'Nothing changed%'")
    told = len(m.seen())
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means karate on Mondays.")
    assert "wasn't sent to him again" not in again["said"] and len(m.seen()) == told + 1


def test_a_different_change_s_nothing_changed_is_its_own_answer(m):
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=mid)
    told = len(m.seen())
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-22"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means from the 22nd.")
    assert "wasn't sent to him again" not in again["said"] and len(m.seen()) == told + 1


# -- review round: the check line keeps hyphens and escapes once ------------------------------------------------

def test_check_line_keeps_hyphens_and_escapes_once():
    from harness import render
    got = render.check_line(["- Swim 9:00-10:00 on 2026-12-21 moves.", "a drop-off — then pick-up",
                             "Tom & Jerry <b>"])
    assert got == ["⚠ <b>Check before approving:</b> Swim 9:00-10:00 on 2026-12-21 moves; a drop-off, then "
                   "pick-up; Tom &amp; Jerry &lt;b&gt;."]
    long = render.check_line(["x & y " * 300])
    assert long[0].count("&amp;") <= 151 and "&amp;amp;" not in long[0] and long[0].endswith("….")
    assert render.check_line([]) == [] and render.check_line(["  ", "."]) == []



# -- round 3 -----------------------------------------------------------------------------------------------------


def _end_card(m, words="end the Monday swim series from the 22nd on"):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-22"))]
    out = m.handover(paired=OWNER, message=m.he_says(words))
    assert out["status"] == "waiting for his tap", m.seen()[-1]
    return proposal(m)


def _refused_with_fresh_card(m, first, *words):
    said = [t for t in m.seen() if t.startswith("Nothing changed: the event changed since your card")]
    assert said and all(w in said[-1] for w in words) and "A fresh card with it as it is now follows" in said[-1]
    assert m.seen()[-1].startswith("Change your calendar?") and proposal(m) != first
    return said[-1]


def test_an_end_binds_its_days_from_the_cutoff_and_a_moved_day_since_is_refused_with_one_fresh_card(m):
    """Round 3, point 1: one future occurrence moved between the card and Approve."""
    first = _end_card(m)
    bound = m.cc.bound_of(first)["bound"]
    assert [b["series"] for b in bound] == [MON_ID]
    assert len(bound[0]["occurrences"]) == 2 and bound[0]["fingerprint"] and bound[0]["master_etag"] == '"s"'
    day = next(u for u in m.gmail.events if u.startswith(MON_ID + "_") and "20261130" in u)
    moved = datetime(2026, 11, 30, 10, 0, tzinfo=NY)
    m.gmail.events[day]["start"] = {"dateTime": moved.isoformat(), "timeZone": TZ}
    m.gmail.events[day]["end"] = {"dateTime": (moved + timedelta(hours=1)).isoformat(), "timeZone": TZ}
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "moved since your card")
    assert m.gmail.events[MON_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"] and not any(
        MON_ID in str(x) for x in m.gmail.log)
    # The fresh card is bound to the days as they are now, and its tap ends the series.
    assert m.cc.bound_of(proposal(m))["bound"][0]["fingerprint"] != bound[0]["fingerprint"]
    m.tap("Approve")
    assert m.seen()[-1].startswith("Done."), m.seen()[-1]
    assert "UNTIL=" in m.gmail.events[MON_ID]["recurrence"][0]


def test_an_end_refuses_when_an_exception_was_added_since_its_card(m):
    """Round 3, point 1: one exception added (a day of the series taken off) between the card and Approve."""
    first = _end_card(m)
    day = next(u for u in m.gmail.events if u.startswith(MON_ID + "_") and "20261123" in u)
    m.gmail.events[day]["status"] = "cancelled"
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "taken off since your card")
    assert m.gmail.events[MON_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_an_end_refuses_when_a_day_was_added_to_the_series_since_its_card(m):
    first = _end_card(m)
    at = datetime(2026, 12, 2, 8, 30, tzinfo=NY)
    extra = f"{MON_ID}_20261202T133000Z"
    m.gmail.events[extra] = {**m.gmail.events[next(u for u in m.gmail.events if u.startswith(MON_ID + "_"))],
                             "id": extra, "originalStartTime": {"dateTime": at.isoformat()},
                             "start": {"dateTime": at.isoformat(), "timeZone": TZ},
                             "end": {"dateTime": (at + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "has a new day from then on")


def test_an_end_whose_series_was_edited_since_its_card_is_refused_by_its_version(m):
    """Round 3, point 1: the master event's version is bound and checked (Google's etag)."""
    first = _end_card(m)
    m.gmail.events[MON_ID]["etag"] = '"edited"'
    m.gmail.events[MON_ID]["description"] = "bring goggles"
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "edited on the calendar since your card")
    assert m.gmail.events[MON_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_an_end_sends_its_write_over_the_version_its_card_bound(m):
    first = _end_card(m)
    sent = []
    real = m.gmail.change

    def change(address, uid, fields, etag):
        sent.append((uid, etag))
        return real(address, uid, fields, etag)
    m.gmail.change = change
    m.tap("Approve")
    assert m.seen()[-1].startswith("Done.") and (MON_ID, '"s"') in sent and first


def test_a_second_change_after_the_fresh_card_gets_no_third_card(m):
    """The fresh card comes once per change family (the existing cap)."""
    first = _end_card(m)
    day = next(u for u in m.gmail.events if u.startswith(MON_ID + "_") and "20261123" in u)
    m.gmail.events[day]["status"] = "cancelled"
    m.tap("Approve")
    second = proposal(m)
    assert second != first
    other = next(u for u in m.gmail.events if u.startswith(MON_ID + "_") and "20261130" in u)
    m.gmail.events[other]["status"] = "cancelled"
    m.tap("Approve")
    last = [t for t in m.seen() if t.startswith("Nothing changed: the event changed since your card")][-1]
    assert "A fresh card" not in last
    assert m.ledger.db.execute("SELECT COUNT(*) FROM proposals").fetchone()[0] == 2
    assert m.gmail.events[MON_ID]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def _removal_card(m, n=3):
    days = mondays(n)
    uids = _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=",".join(d.isoformat() for d in days)))]
    out = m.handover(paired=OWNER, message=m.he_says("no swim on those mondays"))
    assert out["status"] == "waiting for his tap"
    return proposal(m), uids


def test_a_removal_binds_each_occurrence_and_one_moved_since_its_card_takes_nothing_off(m):
    """Round 3, point 1: the removal set is bound by series, id and start; one occurrence moved (same day,
    another time) between the card and Approve refuses the whole set before any write, with one fresh card."""
    first, uids = _removal_card(m)
    bound = m.cc.bound_of(first)["bound"]
    assert {(b["series"], b["instance"]) for b in bound} == {("swim0mon0series", u) for u in uids}
    assert all(b["start"] for b in bound)
    moved = datetime(2026, 11, 23, 18, 0, tzinfo=NY)
    m.gmail.events[uids[1]]["start"] = {"dateTime": moved.isoformat(), "timeZone": TZ}
    m.gmail.events[uids[1]]["end"] = {"dateTime": (moved + timedelta(hours=1)).isoformat(), "timeZone": TZ}
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "one event it takes off moved to another time")
    assert all(m.gmail.events[u]["status"] == "confirmed" for u in uids) and m.gmail.log == []
    # The fresh card shows the days at their times now.
    assert "6:00 PM Mon Nov 23" in m.seen()[-1] and "Mon Nov 16, Nov 30" in m.seen()[-1]


def test_a_removal_refuses_when_another_event_appeared_in_its_days_since_its_card(m):
    first, uids = _removal_card(m)
    at = datetime(2026, 11, 23, 17, 0, tzinfo=NY)
    m.gmail.events["swim0extra0one"] = {"id": "swim0extra0one", "summary": "Swim", "status": "confirmed",
                                        "etag": '"x"', "organizer": {"email": GMAIL, "self": True},
                                        "start": {"dateTime": at.isoformat(), "timeZone": TZ},
                                        "end": {"dateTime": (at + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
    m.tap("Approve")
    _refused_with_fresh_card(m, first, "more than one event on Mon Nov 23 fits Swim")
    assert all(m.gmail.events[u]["status"] == "confirmed" for u in uids)
    assert m.gmail.events["swim0extra0one"]["status"] == "confirmed" and m.gmail.log == []


@pytest.mark.parametrize("days, clocks, line", [
    # A gapped weekly run: the range with "except", or every day when too many weeks are missing.
    ([date(2026, 12, 21), date(2026, 12, 28), date(2027, 1, 11), date(2027, 1, 18), date(2027, 1, 25)], None,
     "Mon Dec 21, 2026 to Jan 25, 2027 (weekly), except Jan 4, 2027"),
    ([date(2027, 1, 4), date(2027, 1, 11), date(2027, 2, 22), date(2027, 3, 1)], None,
     "Mon Jan 4, Jan 11, Feb 22, Mar 1"),
    # A run with one moved time: every day, with its time.
    (mondays(5, date(2027, 1, 4)), "moved", "Mon Jan 4 8:30 AM, Jan 11 8:30 AM, Jan 18 9:30 AM, Jan 25 8:30 AM, "
                                            "Feb 1 8:30 AM"),
    # Strictly weekly, one time, none missing: the range.
    (mondays(9, date(2026, 12, 21)), None, "Mon Dec 21, 2026 to Feb 15, 2027 (weekly)"),
])
def test_the_weekly_range_only_for_every_week_at_one_time_with_none_missing(days, clocks, line):
    if clocks == "moved":
        clocks = {d: "8:30 AM" for d in days}
        clocks[days[2]] = "9:30 AM"
    assert calendar_change.days_line(days, clocks=clocks) == line


def test_a_card_with_a_gapped_run_lists_the_range_with_its_except(m):
    days = [d for d in mondays(6) if d != date(2026, 11, 30)]
    _series(m, "swim0mon0series", "Swim", days[0], "RRULE:FREQ=WEEKLY;BYDAY=MO", days)
    m.claude.script = [ask(change("gmail", "remove", "Swim", dates=",".join(d.isoformat() for d in days)))]
    assert m.handover(paired=OWNER, message=m.he_says("no swim on those"))["status"] == "waiting for his tap"
    assert "Take off “Swim”, 8:30 AM, Gmail calendar:\nMon Nov 16 to Dec 21 (weekly), except Nov 30\n" in m.seen()[-1]


def test_two_connections_racing_on_one_message_make_one_evaluation_and_one_card(m):
    """Round 3, point 3: the claim is a slot in the ledger taken under its write lock, so two notes handled
    at once over two connections to the same ledger re-run the message once."""
    import copy
    import threading
    two_swims(m)
    mid = m.he_says("end the Monday swim series from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    assert m.handover(paired=OWNER, message=mid)["status"] == "not a change"
    job = m.ledger.db.execute("SELECT id FROM jobs WHERE message_id=?", (int(mid),)).fetchone()[0]
    told, calls = len(m.seen()), len(m.claude.calls)
    gate = threading.Barrier(2)
    got, errors = [], []

    def note(words):
        try:
            other = copy.copy(m.c)
            other.ledger = Ledger(m.ledger.path, clock=m.ledger.clock)     # its own connection
            gate.wait()
            got.append(other._note_for_question(job, f"\n\n[A suggestion from Cain: {words}]", []))
            other.ledger.db.close()
        except Exception as e:            # pragma: no cover - reported below
            errors.append(e)
    threads = [threading.Thread(target=note, args=(w,)) for w in ("He means swim.", "He means the swim series.")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors and got == ["", ""]
    slots = m.ledger.db.execute("SELECT key, value FROM meta WHERE key LIKE 'note_slot:%'").fetchall()
    assert len(slots) == 1 and m.c.note_reruns(job) == 1
    assert m.ledger.job_text(job).count("A suggestion from Cain") == 1
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))] * 2
    for _ in range(6):
        m.c.tick()
    assert len(m.claude.calls) == calls + 1 and len(m.seen()) == told + 1
    card = m.seen()[-1]
    assert card.startswith("Reconsidered after Cain's note:\nChange your calendar?") and m.labels().count("Approve") == 1
    # The slot is answered in the transaction that recorded the card.
    assert '"answered"' in m.ledger.get_meta(slots[0]["key"]) and '"proposed"' in m.ledger.get_meta(slots[0]["key"])


def test_the_re_run_count_is_read_from_the_ledger(m):
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=mid)
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=mid, suggestion="He means karate on Mondays.")
    job = m.ledger.db.execute("SELECT id FROM jobs WHERE message_id=?", (int(mid),)).fetchone()[0]
    assert m.c.note_reruns(job) == 1
    # Another connection (as after a restart) reads the same count.
    import copy
    other = copy.copy(m.c)
    other.ledger = Ledger(m.ledger.path, clock=m.ledger.clock)
    assert other.note_reruns(job) == 1


SAME_A = "swim0same0aaaa11"
SAME_B = "swim0same0bbbb22"


def _same_swims(m):
    """Two series both called Swim on Mondays at one time, one only starting on the 16th."""
    _series(m, SAME_A, "Swim", date(2026, 11, 16), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(3))
    _series(m, SAME_B, "Swim", date(2026, 11, 16), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(3), hour=17, minute=0)
    m.gmail.events[SAME_B]["start"] = {"dateTime": datetime(2026, 11, 16, 17, 0, tzinfo=NY).isoformat(),
                                       "timeZone": TZ}


def test_a_note_only_id_ending_never_picks_one_of_two_same_title_series(m):
    """Round 3, point 4: the id ending is only in Cain's note: the which-one card, its pick listed first."""
    _same_swims(m)
    mid = m.he_says("end swim from the 16th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-16"))]
    assert m.handover(paired=OWNER, message=mid)["status"] == "not a change"
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=mid, suggestion="He means the one with id ending bbbb22.")
    card = m.seen()[-1]
    assert out["status"] == "needs_clarification" and "Which series do you mean?" in card
    assert "1. “Swim” on Mondays at 5:00 PM, next Mon Nov 16, Gmail calendar (Cain's note points to this one)" in card
    assert "Approve" not in m.labels() and m.gmail.log == []
    m.tap("Series 1: next Nov 16, 5:00 PM")
    assert ended(m) == {SAME_B}


def test_his_own_id_ending_still_picks_one_of_two_same_title_series(m):
    _same_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 16th on, the one with id ending bbbb22"))
    assert out["status"] == "waiting for his tap", m.seen()[-1]
    assert ended(m) == {SAME_B}


def test_a_weekday_set_matches_a_series_on_exactly_those_days(m):
    """Round 3, point 5: "Tuesdays" doesn't pick the Swim on Tuesdays and Thursdays (not a subset match)."""
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says("end the swim on Tuesdays from the 15th on"))
    assert out["status"] == "needs_clarification" and "no Swim series fits Tuesdays" in m.seen()[-1]
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says("end the swim on Tuesdays and Thursdays from the 15th on"))
    assert out["status"] == "waiting for his tap" and ended(m) == {PLAIN_ID}


def test_a_monday_swim_is_a_day_of_it_never_a_schedule(m):
    two_swims(m)
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-15"))]
    out = m.handover(paired=OWNER, message=m.he_says("end the Monday swim from the 15th on"))
    assert out["status"] == "needs_clarification" and "Which series do you mean?" in m.seen()[-1]


def _karate_once(m):
    at = datetime(2026, 11, 20, 18, 0, tzinfo=NY)
    m.gmail.events["karate0one0off"] = {"id": "karate0one0off", "summary": "Karate", "status": "confirmed",
                                        "etag": '"k1"', "organizer": {"email": GMAIL, "self": True},
                                        "start": {"dateTime": at.isoformat(), "timeZone": TZ},
                                        "end": {"dateTime": (at + timedelta(hours=1)).isoformat(), "timeZone": TZ}}


def test_the_same_nothing_changed_about_changed_facts_is_sent_again(m):
    """Round 3, point 6: the once-per-message key holds the matched events' ids and versions."""
    _karate_once(m)
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    first = m.handover(paired=OWNER, message=mid)
    assert first["status"] == "not a change"
    words = m.seen()[-1]
    told = len(m.seen())
    m.gmail.events["karate0one0off"]["etag"] = '"k2"'          # the event he means was edited
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    again = m.handover(paired=OWNER, message=mid, suggestion="He means karate on Fridays.")
    assert "wasn't sent to him again" not in again["said"]
    assert len(m.seen()) == told + 1 and m.seen()[-1] == words


def test_the_same_outcome_while_its_message_waits_reuses_that_outbox_row(m):
    _karate_once(m)
    mid = m.he_says("end the karate from the 15th on")
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=mid)
    row = m.ledger.db.execute("SELECT id, text FROM outbox WHERE text LIKE 'Nothing changed%' ORDER BY id DESC"
                              ).fetchone()
    # Not sent yet (its send is waiting for a retry).
    m.ledger.db.execute("UPDATE outbox SET state='queued', not_before='2099-01-01T00:00:00+00:00' WHERE id=?",
                        (row["id"],))
    m.claude.script = [ask(change("gmail", "end_series", "Karate", dates="2026-11-15"))]
    m.handover(paired=OWNER, message=mid, suggestion="He means karate on Fridays.")
    assert m.ledger.db.execute("SELECT COUNT(*) FROM outbox WHERE text=?", (row["text"],)).fetchone()[0] == 1


def test_more_than_twenty_series_ask_for_a_narrower_selector_with_no_partial_chooser(m):
    """Round 3, point 7: 21 candidates: one message with the count, no buttons."""
    for i in range(21):
        sid = f"swim0many0{i:02d}0000"
        _series(m, sid, "Swim", date(2026, 11, 16), "RRULE:FREQ=WEEKLY;BYDAY=MO", mondays(2), hour=6 + i // 4,
                minute=(i % 4) * 15)
    m.gmail.events["swim0many0000000"]["start"] = {
        "dateTime": datetime(2026, 11, 16, 6, 0, tzinfo=NY).isoformat(), "timeZone": TZ}
    m.claude.script = [ask(change("gmail", "end_series", "Swim", dates="2026-11-16"))]
    out = m.handover(paired=OWNER, message=m.he_says("end swim from the 16th on"))
    said = m.seen()[-1]
    assert out["status"] == "needs_clarification"
    assert said.startswith("Nothing changed: 21 Swim series fit that, more than one card can list.")
    assert "its calendar, its time or its exact title" in said
    assert not any(x.startswith("Series") for x in m.labels()) and "Approve" not in m.labels()
    assert m.ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE 'calendar_change_which:%'").fetchone()[0] == 0


def test_check_line_keeps_a_dash_between_digits():
    from harness import render
    got = render.check_line(["Swim 9:00–10:00 on Dec 21 – 28 moves", "a drop-off — then pick-up",
                             "— a bullet", "2026—2027"])
    assert got == ["⚠ <b>Check before approving:</b> Swim 9:00–10:00 on Dec 21 – 28 moves; a drop-off, then "
                   "pick-up; a bullet; 2026—2027."]
