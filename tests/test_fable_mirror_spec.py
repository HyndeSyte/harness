"""Mirror spec (private), section 3: every input case as a fixture, at the level
the planner or the feed reader decides it. Expected outputs come from the
derivation rule (spec section 2), not from anything done by hand.
(Fable Job B, 2026-10-18.)"""
import socket
from dataclasses import replace
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from harness import ical
from harness.mirror_shadow import family_busy, google_busy
from harness.workmirror import (Busy, FamilyRule, MirrorConfig, event_id, plan, reconcile,
                                settings_hash)

ET = ZoneInfo("America/New_York")
W = "me@work.example"
NOW = datetime(2026, 10, 16, 7, 0, tzinfo=ET)          # Friday; Mon = Oct 19
MON = datetime(2026, 10, 19, 0, 0, tzinfo=ET)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    real = socket.create_connection

    def refuse(address, *a, **k):
        if address[0] not in ("127.0.0.1", "localhost", "::1"):
            raise AssertionError(f"network call to {address[0]}")
        return real(address, *a, **k)
    monkeypatch.setattr(socket, "create_connection", refuse)


def cfg(**kw):
    base = dict(enabled=True, work_address=W, family_rules=(FamilyRule(r"Pat - (.+)", "{1}"),))
    base.update(kw)
    return MirrorConfig(**base)


def t(day, h, m=0):
    """day 0 = Monday Oct 19, local."""
    return MON + timedelta(days=day, hours=h, minutes=m)


def g(sid, start, end, title="Thing", **kw):
    return Busy("google", sid, "primary", start, end, False, title, **kw)


def f(sid, start, end, title, **kw):
    return Busy("family", sid, "Family", start, end, False, title, **kw)


def copies(p):
    return [(c.start, c.end, c.title) for c in p.copies]


def ics(*events, name="owner@example.com"):
    body = []
    for i, e in enumerate(events):
        lines = e.strip().splitlines()
        if not any(x.startswith("UID:") for x in lines):
            lines = [f"UID:e{i}@google.com"] + lines
        body += ["BEGIN:VEVENT"] + lines + ["END:VEVENT"]
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", f"X-WR-CALNAME:{name}",
                        "X-WR-TIMEZONE:America/New_York"] + body + ["END:VCALENDAR", ""])


def feed(text, now=NOW, days=21):
    start = datetime.combine(now.astimezone(ET).date(), datetime.min.time(), tzinfo=ET)
    w = ical.window(text, start=start, end=start + timedelta(days=days + 1), tz="America/New_York")
    return [google_busy(o) for o in w.occurrences], w.unreadable


# -- cases 1-5: hours and overlaps -----------------------------------------------------------

def test_case_1_inside_work_hours():
    p = plan([g("a", t(1, 10), t(1, 11), "Gym")], cfg(), NOW)
    assert copies(p) == [(t(1, 10), t(1, 11), "Busy")] and p.skipped == ()


def test_case_2_entirely_outside_is_not_even_listed():
    p = plan([g("a", t(1, 7), t(1, 8)), g("b", t(1, 18), t(1, 19)), g("c", t(5, 10), t(5, 11))],
             cfg(), NOW)
    assert p.copies == () and p.skipped == ()


@pytest.mark.parametrize("s,e", [(t(1, 7, 30), t(1, 8, 15)), (t(1, 17, 45), t(1, 19)),
                                 (t(1, 6), t(1, 20))])
def test_cases_3_4_5_partial_overlaps_copy_the_whole_block(s, e):
    assert copies(plan([g("a", s, e)], cfg(), NOW)) == [(s, e, "Busy")]


# -- cases 6-9: all-day, free, declined ---------------------------------------------------

def test_cases_6_7_all_day_from_the_feed():
    evs, _ = feed(ics("DTSTART;VALUE=DATE:20261020\nSUMMARY:Trip",
                      "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261023\nSUMMARY:Away"))
    p = plan(evs, cfg(), NOW)
    assert p.copies == () and set(p.skipped) == {("Trip", "all day"), ("Away", "all day")}


def test_case_8_marked_free_from_the_feed():
    evs, _ = feed(ics("DTSTART;TZID=America/New_York:20261020T100000\n"
                      "DTEND;TZID=America/New_York:20261020T110000\nTRANSP:TRANSPARENT\nSUMMARY:Hold"))
    p = plan(evs, cfg(), NOW)
    assert p.copies == () and p.skipped == (("Hold", "marked free"),)


def test_case_9_declined_is_dropped_by_the_reader():
    evs, unreadable = feed(ics("DTSTART;TZID=America/New_York:20261020T100000\n"
                               "DTEND;TZID=America/New_York:20261020T110000\nSUMMARY:Party\n"
                               "ATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.com"))
    assert evs == [] and unreadable == 0
    p = plan([g("a", t(1, 10), t(1, 11), "Party", declined=True)], cfg(), NOW)
    assert p.copies == () and p.skipped == (("Party", "declined"),)


# -- cases 10-13: series, moved and cancelled instances --------------------------------------

SERIES = ("DTSTART;TZID=America/New_York:20261020T090000\n"
          "DTEND;TZID=America/New_York:20261020T100000\nRRULE:FREQ=WEEKLY;BYDAY=TU\nSUMMARY:Gym")


def test_case_10_recurring_series_gets_one_copy_per_instance_with_distinct_ids():
    evs, _ = feed(ics(SERIES))
    p = plan(evs, cfg(), NOW)
    assert [c.start for c in p.copies] == [t(1, 9), t(8, 9)]
    assert len({c.event_id for c in p.copies}) == 2
    assert all(c.source_id.startswith("e0@google.com|") for c in p.copies)


def test_case_11_moved_instance_keeps_its_id_so_reconcile_updates():
    before = plan(feed(ics(SERIES))[0], cfg(), NOW)
    live = {c.event_id: (c.start, c.end, c.title) for c in before.copies}
    moved = ics(SERIES, "UID:e0@google.com\nRECURRENCE-ID;TZID=America/New_York:20261027T090000\n"
                        "DTSTART;TZID=America/New_York:20261028T140000\n"
                        "DTEND;TZID=America/New_York:20261028T150000\nSUMMARY:Gym")
    after = plan(feed(moved)[0], cfg(), NOW)
    d = reconcile(after, live)
    assert not d.add and not d.delete and [c.start for c in d.update] == [t(9, 14)]
    assert {c.event_id for c in after.copies} == set(live)


def test_case_12_cancelled_instance_is_one_delete_on_a_complete_read():
    before = plan(feed(ics(SERIES))[0], cfg(), NOW)
    live = {c.event_id: (c.start, c.end, c.title) for c in before.copies}
    gone = ics(SERIES + "\nEXDATE;TZID=America/New_York:20261027T090000")
    d = reconcile(plan(feed(gone)[0], cfg(), NOW), live)
    assert not d.add and not d.update and len(d.delete) == 1
    assert live[d.delete[0]][0] == t(8, 9)


def test_case_13_cancelled_event_is_dropped_by_the_reader_and_its_copy_deleted():
    single = ("DTSTART;TZID=America/New_York:20261020T100000\n"
              "DTEND;TZID=America/New_York:20261020T110000\nSUMMARY:Meeting")
    before = plan(feed(ics(single))[0], cfg(), NOW)
    live = {c.event_id: (c.start, c.end, c.title) for c in before.copies}
    assert len(live) == 1
    after = plan(feed(ics(single + "\nSTATUS:CANCELLED"))[0], cfg(), NOW)
    assert after.copies == () and reconcile(after, live).delete == tuple(live)


# -- cases 14-19: midnight, DST, zones ----------------------------------------------------------

def test_case_14_15_midnight():
    assert plan([g("a", t(1, 23), t(2, 1))], cfg(), NOW).copies == ()
    assert copies(plan([g("b", t(1, 23), t(2, 9))], cfg(), NOW)) == [(t(1, 23), t(2, 9), "Busy")]


def test_case_16_dst_change_keeps_ids_and_needs_no_update():
    now = datetime(2026, 10, 26, 7, tzinfo=ET)
    evs, _ = feed(ics(SERIES), now=now)
    p = plan(evs, cfg(), now)
    starts = [c.start.astimezone(ZoneInfo("UTC")).hour for c in p.copies
              if c.start.date() in (date(2026, 10, 27), date(2026, 11, 3))]
    assert starts == [13, 14]                       # 09:00 EDT, 09:00 EST
    live = {c.event_id: (c.start, c.end, c.title) for c in p.copies}
    assert reconcile(plan(feed(ics(SERIES), now=now)[0], cfg(), now), live).empty


def test_case_17_other_zone_is_judged_in_his_hours():
    chi = ZoneInfo("America/Chicago")
    ev = g("a", datetime(2026, 10, 20, 7, 30, tzinfo=chi), datetime(2026, 10, 20, 8, tzinfo=chi))
    assert copies(plan([ev], cfg(), NOW)) == [(t(1, 8, 30), t(1, 9), "Busy")]


def test_case_18_naive_time_is_refused_and_the_reader_never_produces_one():
    p = plan([g("a", datetime(2026, 10, 20, 10), datetime(2026, 10, 20, 11), "Naive")], cfg(), NOW)
    assert p.copies == () and p.skipped == (("Naive", "no time zone"),)
    evs, _ = feed(ics("DTSTART:20261020T100000\nDTEND:20261020T110000\nSUMMARY:Floating"))
    assert all(e.start.tzinfo is not None for e in evs)


def test_case_19_unknown_zone_counts_as_unreadable_which_blocks_deletes():
    evs, unreadable = feed(ics("DTSTART;TZID=Nowhere/Zone:20261020T100000\n"
                               "DTEND;TZID=Nowhere/Zone:20261020T110000\nSUMMARY:Odd"))
    assert evs == [] and unreadable == 1
    live = {event_id("google", "x"): (t(1, 10), t(1, 11), "Busy")}
    assert reconcile(plan(evs, cfg(), NOW, complete=False), live).empty


# -- cases 20-25: Family --------------------------------------------------------------------

def test_case_20_family_rule_match():
    p = plan([f("d", t(3, 9), t(3, 9, 30), "Pat - Dentist")], cfg(), NOW)
    assert copies(p) == [(t(3, 9), t(3, 9, 30), "Busy")] and p.copies[0].label == "Dentist"


def test_cases_21_22_family_without_a_whole_title_match():
    p = plan([f("a", t(0, 8, 30), t(0, 15, 15), "Kids school day"),
              f("b", t(1, 10), t(1, 11), "Not Pat - Gym")], cfg(), NOW)
    assert p.copies == () and p.skipped == ()


def test_case_23_same_block_on_both_is_one_copy_from_google():
    p = plan([g("a", t(1, 8, 30), t(1, 9, 30), "Gym"), f("b", t(1, 8, 30), t(1, 9, 30), "Pat - Gym")],
             cfg(), NOW)
    assert [c.source for c in p.copies] == ["google"]
    assert p.skipped == (("Pat - Gym", "same block is on his own calendar"),)


@pytest.mark.parametrize("kw", [dict(transparent=True), dict(declined=True)])
def test_case_24_family_twin_of_a_free_or_declined_block(kw):
    p = plan([g("a", t(1, 10), t(1, 11), "Gym", **kw), f("b", t(1, 10), t(1, 11), "Pat - Gym")],
             cfg(), NOW)
    assert p.copies == ()


def test_case_25_widened_family_twin_is_two_copies_pre_registered():
    p = plan([g("a", t(1, 8, 30), t(1, 9, 30), "Gym"), f("b", t(1, 8), t(1, 10), "Pat - Gym")],
             cfg(), NOW)
    assert sorted(c.source for c in p.copies) == ["family", "google"]


# -- cases 26-27: already invited ----------------------------------------------------------------

def test_cases_26_27_already_invited_any_case():
    evs, _ = feed(ics("DTSTART;TZID=America/New_York:20261020T100000\n"
                      "DTEND;TZID=America/New_York:20261020T110000\nSUMMARY:Meeting\n"
                      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT:mailto:ME@WORK.EXAMPLE"))
    assert evs[0].attendees == ("me@work.example",)
    p = plan(evs, cfg(), NOW)
    assert p.copies == () and p.skipped == (("Meeting", "already invited"),)


# -- case 28: bursts -----------------------------------------------------------------------------

def test_case_28_bursts_never_duplicate():
    live = {}
    for h in (10, 11, 12):
        p = plan([g("a", t(1, h), t(1, h + 1), "Moving")], cfg(), NOW)
        d = reconcile(p, live)
        assert len(p.copies) == 1 and len(d.add) + len(d.update) == 1 and not d.delete
        for c in d.add + d.update:
            live[c.event_id] = (c.start, c.end, c.title)
    assert len(live) == 1 and list(live.values())[0][0] == t(1, 12)


# -- cases 29-32: partial reads and sources ----------------------------------------------------

def test_case_29_30_partial_read_keeps_copies_and_adds_no_family():
    live = {event_id("google", "a"): (t(1, 10), t(1, 11), "Busy")}
    p = plan([f("b", t(2, 10), t(2, 11), "Pat - Vet")], cfg(), NOW, complete=False)
    d = reconcile(p, live)
    assert d.empty and p.skipped == (("Pat - Vet", "a calendar wasn't read"),)


def test_case_31_32_source_gone_or_empty_on_a_complete_read_deletes():
    live = {event_id("google", "a"): (t(1, 10), t(1, 11), "Busy")}
    assert reconcile(plan([], cfg(), NOW), live).delete == tuple(live)


# -- cases 33-38: titles, privacy, ids ----------------------------------------------------------

def test_cases_33_34_title_modes():
    ev = g("a", t(1, 10), t(1, 11), "Checkup")
    busy = plan([ev], cfg(), NOW).copies[0]
    assert busy.title == "Busy" and busy.label == "Checkup"
    assert plan([ev], cfg(title_mode="as_is"), NOW).copies[0].title == "Checkup"


def test_case_35_skip_rule():
    p = plan([g("a", t(1, 10), t(1, 11), "Lunch"), g("b", t(1, 12), t(1, 13), "Gym")],
             cfg(skip_titles=("lunch",)), NOW)
    assert [c.label for c in p.copies] == ["Gym"] and p.skipped == (("Lunch", "skip rule"),)


def test_case_36_a_copy_is_only_time_and_title():
    from harness.workmirror import Copy
    assert set(Copy.__dataclass_fields__) == {"source", "source_id", "start", "end", "title",
                                              "event_id", "label"}


def test_cases_37_38_deterministic_and_no_duplicates():
    evs = [g("a", t(1, 10), t(1, 11), "A"), g("b", t(2, 10), t(2, 11), "B"),
           f("c", t(2, 10), t(2, 11), "Pat - B")]
    p1, p2 = plan(evs, cfg(), NOW), plan(list(reversed(evs)), cfg(), NOW)
    assert p1.plan_hash == p2.plan_hash and p1.copies == p2.copies
    assert len({c.event_id for c in p1.copies}) == len(p1.copies) == 2
    assert len({(c.start, c.end) for c in p1.copies}) == 2


# -- cases 39-43: time edges and scope -------------------------------------------------------

def test_cases_39_40_under_way_counts_ended_is_history():
    now = t(1, 10)
    assert len(plan([g("a", t(1, 9, 30), t(1, 10, 30))], cfg(), now).copies) == 1
    p = plan([g("b", t(1, 8), t(1, 9))], cfg(), now)
    live = {event_id("google", "b"): (t(1, 8), t(1, 9), "Busy")}
    assert p.copies == () and reconcile(p, live).empty


def test_case_41_42_horizon_and_tracked_copies():
    assert plan([g("a", t(14, 10), t(14, 11))], cfg(), NOW).copies == ()
    eid = event_id("google", "a")
    live = {eid: (t(9, 10), t(9, 11), "Busy")}
    p = plan([g("a", t(18, 10), t(18, 11))], cfg(), NOW, tracked=frozenset(live),
             read_until=NOW + timedelta(days=22))
    d = reconcile(p, live)
    assert [c.event_id for c in d.update] == [eid] and not d.delete


def test_case_43_spouse_calendar_only_when_named():
    ev = Busy("google", "x", "Spouse", t(1, 10), t(1, 11), False, "Spouse appointment")
    assert plan([ev], cfg(), NOW).copies == ()
    assert plan([ev], cfg(google_calendars=("spouse",)), NOW).copies


def test_the_feed_of_a_primary_calendar_counts_as_primary():
    evs, _ = feed(ics("DTSTART;TZID=America/New_York:20261020T100000\n"
                      "DTEND;TZID=America/New_York:20261020T110000\nSUMMARY:Gym"))
    assert evs[0].calendar == "primary" and plan(evs, cfg(), NOW).copies
    evs, _ = feed(ics("DTSTART;TZID=America/New_York:20261020T100000\n"
                      "DTEND;TZID=America/New_York:20261020T110000\nSUMMARY:Gym", name="Spouse"))
    assert evs[0].calendar == "Spouse" and plan(evs, cfg(), NOW).copies == ()


def test_family_identity_is_the_whole_event():
    a = family_busy("Pat - Gym", t(1, 8), t(1, 9))
    b = family_busy("Pat - Gym", t(1, 8, 30), t(1, 9))
    assert a.source_id != b.source_id and a.source_id == family_busy("Pat - Gym", t(1, 8), t(1, 9)).source_id


def test_settings_hash_covers_the_write_not_the_blocks():
    assert settings_hash(cfg()) != settings_hash(cfg(title_mode="as_is"))
    assert settings_hash(cfg()) == settings_hash(replace(cfg(), skip_titles=("x",)))
