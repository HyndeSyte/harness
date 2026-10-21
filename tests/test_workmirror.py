"""Work-hours mirror: the planner decides; nothing is written before S2."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from harness import effects, schema
from harness.config import Config
from harness.workmirror import (Busy, FamilyRule, MirrorConfig, MirrorConfigError, card_expiry,
                                card_text, delivery, event_id, horizon, plan, read_extent, reconcile)

ET = ZoneInfo("America/New_York")
WORK = "me@work.example"
NOW = datetime(2026, 10, 9, 7, 0, tzinfo=ET)        # Friday morning


def cfg(**kw):
    base = dict(enabled=True, work_address=WORK, title_mode="as_is",
                family_rules=(FamilyRule(r"Pat - (.+)", "{1}"),
                              FamilyRule(r"Sam lesson", "Sam lesson (watching kids)")))
    base.update(kw)
    return MirrorConfig(**base)


def at(day, h, m=0):
    """Day 0 is Monday Oct 12."""
    return datetime(2026, 10, 12, h, m, tzinfo=ET) + timedelta(days=day)


def g(sid, start, end, title, **kw):
    return Busy("google", sid, "primary", start, end, False, title, **kw)


def f(sid, start, end, title, **kw):
    return Busy("family", sid, "Family", start, end, False, title, **kw)


def live_of(p):
    return {c.event_id: (c.start, c.end, c.title) for c in p.copies}


# -- what counts ----------------------------------------------------------------

def test_the_week_agreed_by_hand_on_2026_10_08():
    events = [
        g("meeting", at(0, 11), at(0, 11, 30), "Meeting", attendees=(WORK,)),
        g("pt1", at(1, 8, 30), at(1, 9, 30), "Gym"),
        g("pickup1", at(1, 16, 45), at(1, 17), "Pickup"),
        g("pt2", at(2, 9), at(2, 10), "Gym"),
        g("pickup2", at(3, 16, 45), at(3, 17), "Pickup"),
        f("school", at(0, 8, 30), at(0, 15, 15), "Kids school day"),
        f("dpt1", at(1, 8, 30), at(1, 9, 30), "Pat - Gym"),          # Family copy of Google Gym
        f("dentist", at(3, 9), at(3, 9, 30), "Pat - Dentist"),       # Family only
        f("th1", at(1, 17), at(1, 18), "Sam lesson"),
        f("th2", at(3, 17), at(3, 18), "Sam lesson"),
        f("wellness", at(0, 17, 20), at(0, 18, 20), "Kid wellness check"),
    ]
    p = plan(events, cfg(), NOW)
    assert [(c.start, c.title) for c in p.copies] == [
        (at(1, 8, 30), "Gym"), (at(1, 16, 45), "Pickup"), (at(1, 17), "Sam lesson (watching kids)"),
        (at(2, 9), "Gym"), (at(3, 9), "Dentist"), (at(3, 16, 45), "Pickup"),
        (at(3, 17), "Sam lesson (watching kids)")]
    reasons = dict(p.skipped)
    assert reasons["Meeting"] == "already invited"
    assert reasons["Pat - Gym"] == "same block is on his own calendar"
    assert "Kids school day" not in reasons        # not his: silently not mirrored


@pytest.mark.parametrize("ev,why", [
    (Busy("google", "a", "primary", date(2026, 10, 13), date(2026, 10, 14), True, "Trip"), "all day"),
    (g("b", at(1, 10), at(1, 11), "Hold", transparent=True), "marked free"),
    (g("c", at(1, 10), at(1, 11), "Party", declined=True), "declined"),
    (g("d", datetime(2026, 10, 13, 10), datetime(2026, 10, 13, 11), "Naive"), "no time zone"),
])
def test_not_busy_is_not_mirrored(ev, why):
    p = plan([ev], cfg(), NOW)
    assert p.copies == () and dict(p.skipped)[ev.title] == why


def test_work_hours_edges_and_partial_overlap():
    events = [g("early", at(1, 7), at(1, 8), "Ends at 8"),          # touches, doesn't overlap
              g("late", at(1, 18), at(1, 19), "Starts at 6"),
              g("span", at(1, 7, 30), at(1, 8, 15), "Crosses 8"),     # overlaps: copied whole
              g("sat", at(5, 10), at(5, 11), "Saturday")]
    p = plan(events, cfg(), NOW)
    assert [(c.title, c.start, c.end) for c in p.copies] == [("Crosses 8", at(1, 7, 30), at(1, 8, 15))]


def test_hours_and_days_are_config():
    ev = g("x", at(5, 10), at(5, 11), "Saturday shift")
    assert plan([ev], cfg(workdays=(5,), day_start="09:00", day_end="12:00"), NOW).copies


def test_hours_follow_his_time_zone_not_the_event_zone():
    chicago = ZoneInfo("America/Chicago")
    ev = g("x", datetime(2026, 10, 13, 7, 30, tzinfo=chicago), datetime(2026, 10, 13, 8, tzinfo=chicago),
           "8:30 Eastern")
    assert plan([ev], cfg(), NOW).copies


def test_skip_rule():
    events = [g("a", at(1, 10), at(1, 11), "Lunch"), g("b", at(1, 12), at(1, 13), "Gym")]
    p = plan(events, cfg(skip_titles=("lunch",)), NOW)
    assert [c.title for c in p.copies] == ["Gym"]
    assert dict(p.skipped)["Lunch"] == "skip rule"


def test_default_is_primary_only_never_every_calendar():
    shared = Busy("google", "x", "Spouse", at(1, 10), at(1, 11), False, "Spouse appointment")
    assert plan([shared], cfg(), NOW).copies == ()
    assert plan([shared], cfg(google_calendars=("spouse",)), NOW).copies


def test_family_event_needs_a_rule_and_rule_must_match_whole_title():
    events = [f("x", at(1, 10), at(1, 11), "Not Pat - Gym"), f("y", at(1, 12), at(1, 13), "Pat - Vet")]
    assert [c.title for c in plan(events, cfg(), NOW).copies] == ["Vet"]


@pytest.mark.parametrize("kw", [dict(transparent=True), dict(declined=True)])
def test_family_duplicate_of_a_free_or_declined_block_stays_out(kw):
    events = [g("a", at(1, 10), at(1, 11), "Gym", **kw), f("b", at(1, 10), at(1, 11), "Pat - Gym")]
    assert plan(events, cfg(), NOW).copies == ()


def test_titles_default_to_busy():
    c = MirrorConfig(enabled=True, work_address=WORK, family_rules=(FamilyRule("Pat - (.+)", "{1}"),))
    p = plan([g("a", at(1, 10), at(1, 11), "Checkup"), f("b", at(2, 10), at(2, 11), "Pat - Dentist")], c, NOW)
    assert [x.title for x in p.copies] == ["Busy", "Busy"]


# -- rolling horizon --------------------------------------------------------------

def test_horizon_is_rolling_not_weekly():
    # Booked Thursday for Monday: a Friday-for-next-week plan would have it
    # only by luck. The rolling window has it on the next read.
    thu = datetime(2026, 10, 8, 9, 42, tzinfo=ET)
    p = plan([g("mon", at(0, 9), at(0, 10), "Dentist")], cfg(), thu)
    assert [c.title for c in p.copies] == ["Dentist"]


def test_horizon_bounds():
    s, e = horizon(NOW, cfg(horizon_days=14))
    assert s == NOW and e == datetime(2026, 10, 23, 0, 0, tzinfo=ET)
    inside = g("in", datetime(2026, 10, 22, 10, tzinfo=ET), datetime(2026, 10, 22, 11, tzinfo=ET), "In")
    beyond = g("out", datetime(2026, 10, 23, 10, tzinfo=ET), datetime(2026, 10, 23, 11, tzinfo=ET), "Out")
    past = g("past", datetime(2026, 10, 8, 10, tzinfo=ET), datetime(2026, 10, 8, 11, tzinfo=ET), "Past")
    assert [c.title for c in plan([inside, beyond, past], cfg(), NOW).copies] == ["In"]


def test_block_under_way_still_counts():
    now = at(1, 10, 15)
    assert plan([g("a", at(1, 10), at(1, 11), "Now")], cfg(), now).copies


# -- the plan is stable and bindable --------------------------------------------

def test_plan_is_deterministic_and_order_free():
    evs = [g("a", at(1, 10), at(1, 11), "A"), g("b", at(2, 10), at(2, 11), "B")]
    assert plan(evs, cfg(), NOW).plan_hash == plan(list(reversed(evs)), cfg(), NOW).plan_hash


def test_any_change_changes_the_hash():
    base = plan([g("a", at(1, 10), at(1, 11), "A")], cfg(), NOW).plan_hash
    assert plan([g("a", at(1, 10), at(1, 12), "A")], cfg(), NOW).plan_hash != base
    assert plan([g("a", at(1, 10), at(1, 11), "B")], cfg(), NOW).plan_hash != base
    assert plan([g("a", at(1, 10), at(1, 11), "A")], cfg(work_address="x@y.example"), NOW).plan_hash != base


def test_event_ids_are_google_safe_and_stable():
    i = event_id("google", "abc")
    assert i == event_id("google", "abc") != event_id("google", "abd") != event_id("family", "abc")
    assert set(i) <= set("0123456789abcdefghijklmnopqrstuv") and 5 <= len(i) <= 1024


def test_titles_are_trimmed_and_capped():
    p = plan([g("a", at(1, 10), at(1, 11), "  two\n lines " + "x" * 400)], cfg(), NOW)
    assert p.copies[0].title.startswith("two lines ") and len(p.copies[0].title) == 200


# -- reconcile and delivery ------------------------------------------------------

def test_reconcile_moves_adds_and_cancels():
    before = plan([g("a", at(1, 10), at(1, 11), "A"), g("b", at(2, 10), at(2, 11), "B")], cfg(), NOW)
    live = live_of(before)
    assert reconcile(before, live).empty
    after = plan([g("a", at(1, 14), at(1, 15), "A"), g("c", at(3, 10), at(3, 11), "C")], cfg(), NOW)
    d = reconcile(after, live)
    assert [c.title for c in d.add] == ["C"] and [c.title for c in d.update] == ["A"]
    assert d.delete == (event_id("google", "b"),)
    assert d.digest(cfg()) != reconcile(before, {}).digest(cfg())


def test_partial_read_never_deletes():
    live = live_of(plan([g("a", at(1, 10), at(1, 11), "A")], cfg(), NOW))
    assert reconcile(plan([], cfg(), NOW, complete=False), live).empty
    assert reconcile(plan([], cfg(), NOW), live).delete == tuple(live)


def test_past_and_unread_copies_are_left_alone():
    old = {event_id("google", "past"): (datetime(2026, 10, 1, 10, tzinfo=ET),
                                        datetime(2026, 10, 1, 11, tzinfo=ET), "Past"),
           event_id("google", "far"): (datetime(2026, 11, 30, 10, tzinfo=ET),
                                       datetime(2026, 11, 30, 11, tzinfo=ET), "Far")}
    assert reconcile(plan([], cfg(), NOW), old).empty


def test_first_run_is_one_card_with_everything():
    p = plan([g("a", at(1, 10), at(1, 11), "A"), g("b", at(8, 10), at(8, 11), "B")], cfg(), NOW)
    d = reconcile(p, {})
    assert [c.title for c in d.add] == ["A", "B"] and not d.update and not d.delete


def test_soon_goes_now_later_waits_for_digest():
    mon = datetime(2026, 10, 12, 9, tzinfo=ET)
    soon = plan([g("a", at(1, 10), at(1, 11), "Tomorrow")], cfg(), mon)
    later = plan([g("b", at(4, 10), at(4, 11), "Friday")], cfg(), mon)
    assert delivery(reconcile(soon, {}), {}, mon, cfg()) == ("now", mon)
    assert delivery(reconcile(later, {}), {}, mon, cfg())[0] == "digest"
    assert delivery(reconcile(later, live_of(later)), live_of(later), mon, cfg()) is None
    assert delivery(reconcile(soon, {}), {}, mon, cfg(soon_hours=0))[0] == "digest"


def test_move_from_soon_to_later_is_still_soon():
    mon = datetime(2026, 10, 12, 7, tzinfo=ET)
    live = live_of(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), mon))
    moved = plan([g("a", at(4, 10), at(4, 11), "Gym")], cfg(), mon)
    d = reconcile(moved, live)
    assert d.update and delivery(d, live, mon, cfg())[0] == "now"
    assert "(was Tue Oct 13 10:00-11:00 am)" in card_text(d, live, cfg())


def test_cancel_of_a_soon_block_is_soon():
    mon = datetime(2026, 10, 12, 7, tzinfo=ET)
    live = live_of(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), mon))
    d = reconcile(plan([], cfg(), mon), live)
    assert d.delete and delivery(d, live, mon, cfg())[0] == "now"
    assert card_text(d, live, cfg()).endswith("- Tue Oct 13 10:00-11:00 am  Gym")


def test_card_expires_when_its_first_block_starts():
    mon = datetime(2026, 10, 12, 7, tzinfo=ET)
    d = reconcile(plan([g("a", at(0, 9), at(0, 10), "Gym")], cfg(), mon), {})
    assert card_expiry(d, {}, mon, 12 * 3600) == at(0, 9)
    d2 = reconcile(plan([g("b", at(4, 9), at(4, 10), "Later")], cfg(), mon), {})
    assert card_expiry(d2, {}, mon, 12 * 3600) == mon + timedelta(hours=12)


def test_card_text_counts_and_marks():
    d = reconcile(plan([g("a", at(1, 8, 30), at(1, 9, 30), "Gym")], cfg(), NOW), {})
    text = card_text(d, {}, cfg())
    assert text.startswith("Work calendar: 1 change (private, shows as busy)")
    assert "+ Tue Oct 13 8:30-9:30 am  Gym" in text


# -- config ---------------------------------------------------------------------

@pytest.mark.parametrize("kw", [
    dict(work_address="not an address"), dict(work_address="a@b.c, d@e.f"),
    dict(day_start="18:00", day_end="08:00"), dict(day_start="8am"), dict(workdays=(7,)),
    dict(workdays=()), dict(skip_titles=("(",)), dict(timezone="Mars/Base"),
    dict(horizon_days=0), dict(horizon_days=61), dict(soon_hours=-1),
    dict(horizon_days=1, soon_hours=48), dict(title_mode="public"),
])
def test_bad_config_is_refused(kw):
    with pytest.raises(Exception):
        cfg(**kw)


def test_family_rule_must_compile():
    with pytest.raises(MirrorConfigError):
        FamilyRule("(")


def test_off_and_empty_by_default():
    c = Config(owner_user_id=1)
    assert c.work_mirror.enabled is False and c.work_mirror.work_address == ""
    assert c.work_mirror.family_rules == () and c.work_mirror.skip_titles == ()
    assert c.work_mirror.title_mode == "busy"


def test_now_needs_a_zone():
    with pytest.raises(MirrorConfigError):
        plan([], cfg(), datetime(2026, 10, 9, 7))


# -- the write is controller-only and S2-gated ------------------------------------

def _stage(at_least):
    order = ("S0", "S1", "S2", "S3")
    return lambda s: order.index(at_least) >= order.index(s)


def test_model_cannot_propose_the_mirror_write():
    with pytest.raises(effects.ParamError, match="unknown effect type"):
        effects.lookup("work_mirror_copy", _stage("S3"))
    with pytest.raises(schema.OutputError):
        schema.parse_output({"kind": "proposal", "summary": "x", "effect_type": "work_mirror_copy",
                             "params": {}}, stage_at_least=_stage("S3"))


def test_controller_write_waits_for_s2():
    with pytest.raises(effects.ParamError, match="not enabled before S2"):
        effects.lookup("work_mirror_copy", _stage("S1"), origin="controller")
    d = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller")
    assert d.fixed["visibility"] == "private" and d.fixed["calendar"] == "harness-created"
    assert d.fixed["conference"] is None


def test_write_params_are_closed():
    d = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller")
    ok = {"op": "add", "event_id": event_id("google", "a"), "start": at(1, 10).isoformat(),
          "end": at(1, 11).isoformat(), "title": "Gym"}
    assert d.validate(ok) == ok
    for extra in ({"attendees": ["boss@work.example"]}, {"visibility": "public"},
                  {"calendar": "primary"}):
        with pytest.raises(effects.ParamError, match="undeclared"):
            d.validate({**ok, **extra})


def test_write_sends_updates_and_handles_tombstones():
    d = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller")
    assert d.fixed["send_updates"] == "externalOnly"
    assert d.fixed["reminders"] == () and d.fixed["reminders_use_default"] is False
    assert "cancelled" in d.idempotency and "patch it back" in d.idempotency


def test_copy_carries_nothing_but_time_and_title():
    f_ = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller").fixed
    assert f_["description"] == "" and f_["location"] == "" and f_["transparency"] == "opaque"
    assert f_["guests_can_invite_others"] is False and f_["guests_can_see_other_guests"] is False


def test_calendar_hold_still_model_only():
    with pytest.raises(effects.ParamError):
        effects.lookup("calendar_hold", _stage("S2"), origin="controller")
    assert effects.lookup("calendar_hold", _stage("S2")).name == "calendar_hold"


def test_block_that_ended_earlier_today_is_history():
    now = at(1, 12)
    assert plan([g("a", at(1, 9), at(1, 10), "Morning Gym")], cfg(), now).copies == ()



# -- review round 2 (2026-10-08) --------------------------------------------------

def test_same_calendar_same_card_across_reads():
    evs = [g("a", at(1, 10), at(1, 11), "A")]
    p1, p2 = plan(evs, cfg(), NOW), plan(evs, cfg(), NOW + timedelta(minutes=30))
    assert p1.plan_hash == p2.plan_hash
    assert reconcile(p1, {}).digest(cfg()) == reconcile(p2, {}).digest(cfg())
    assert reconcile(p1, {}).digest(cfg()) != reconcile(p1, {}).digest(cfg(work_address="x@y.example"))


def test_cancel_of_a_block_under_way_is_still_approvable():
    now = at(1, 10, 15)
    live = live_of(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), at(1, 9)))
    d = reconcile(plan([], cfg(), now), live)
    assert d.delete and card_expiry(d, live, now, 12 * 3600) == at(1, 11)
    assert delivery(d, live, now, cfg()) == ("now", now)


def test_partial_read_adds_no_family_blocks():
    evs = [f("d", at(1, 9), at(1, 9, 30), "Pat - Dentist")]
    assert plan(evs, cfg(), NOW).copies
    p = plan(evs, cfg(), NOW, complete=False)
    assert p.copies == () and dict(p.skipped)["Pat - Dentist"] == "a calendar wasn't read"


def test_card_shows_real_titles_even_when_work_gets_busy():
    c = cfg(title_mode="busy")
    d = reconcile(plan([g("a", at(1, 8, 30), at(1, 9, 30), "Gym")], c, NOW), {})
    assert d.add[0].title == "Busy"
    text = card_text(d, {}, c)
    assert "+ Tue Oct 13 8:30-9:30 am  Gym" in text and 'titled "Busy" at work' in text


def test_quiet_hours_hold_a_soon_card_until_morning():
    night = datetime(2026, 10, 12, 23, 0, tzinfo=ET)
    d = reconcile(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), night), {})
    assert delivery(d, {}, night, cfg()) == ("now", datetime(2026, 10, 13, 7, 0, tzinfo=ET))


def test_quiet_hours_yield_to_an_early_block():
    night = datetime(2026, 10, 12, 23, 0, tzinfo=ET)
    d = reconcile(plan([g("a", at(1, 7, 30), at(1, 8, 30), "Early Gym")], cfg(), night), {})
    # Must arrive an hour before 7:30, which is inside quiet hours.
    assert delivery(d, {}, night, cfg()) == ("now", at(1, 6, 30))


def test_edits_settle_into_one_card():
    mon = datetime(2026, 10, 12, 9, tzinfo=ET)
    d = reconcile(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), mon), {})
    assert delivery(d, {}, mon, cfg(), first_seen=mon) == ("now", mon + timedelta(minutes=10))
    # A block starting within the settle wait doesn't wait.
    d2 = reconcile(plan([g("b", at(0, 9, 30), at(0, 10, 30), "Now-ish")], cfg(), mon), {})
    assert delivery(d2, {}, mon, cfg(), first_seen=mon) == ("now", mon)


@pytest.mark.parametrize("params,why", [
    ({"op": "delete", "title": "x"}, "delete takes only event_id"),
    ({"op": "add"}, "add needs"),
    ({"op": "update", "start": "2026-10-13T11:00:00-04:00", "end": "2026-10-13T10:00:00-04:00",
      "title": "x"}, "end must be after start"),
    ({"op": "rename"}, "wrong format"),
])
def test_write_ops_are_checked(params, why):
    d = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller")
    with pytest.raises(effects.ParamError, match=why):
        d.validate({"event_id": event_id("google", "a"), **params})


def test_delete_op_is_valid():
    d = effects.lookup("work_mirror_copy", _stage("S2"), origin="controller")
    ok = {"op": "delete", "event_id": event_id("google", "a")}
    assert d.validate(ok) == ok



# -- review round 2, outside models: copies outside the window -------------------

def test_block_moved_past_the_horizon_is_an_update_not_a_cancel():
    live = live_of(plan([g("a", at(1, 10), at(1, 11), "Gym")], cfg(), NOW))
    far = datetime(2026, 11, 3, 10, tzinfo=ET)                  # beyond 14 days
    moved = [g("a", far, far + timedelta(hours=1), "Gym")]
    until = far + timedelta(hours=1)
    p = plan(moved, cfg(), NOW, tracked=frozenset(live), read_until=until)
    d = reconcile(p, live)
    assert [c.start for c in d.update] == [far] and not d.delete and not d.add
    # An untracked event that far out is still not added.
    assert plan([g("z", far, far + timedelta(hours=1), "New")], cfg(), NOW, read_until=until).copies == ()


def test_cancelled_far_copy_is_deleted_once_read_that_far():
    far = datetime(2026, 11, 3, 10, tzinfo=ET)
    live = {event_id("google", "a"): (far, far + timedelta(hours=1), "Gym")}
    until = read_extent(NOW, live, cfg())
    assert until == far + timedelta(hours=1)
    assert reconcile(plan([], cfg(), NOW, tracked=frozenset(live), read_until=until), live).delete
    # Not read that far: not deleted.
    assert reconcile(plan([], cfg(), NOW, tracked=frozenset(live)), live).empty
