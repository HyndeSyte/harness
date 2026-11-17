"""0.24.0, nineteenth round: the defects the eighteenth outside review found in the eighteenth round's additions.

1. A "settling" tap (its approval used up, its job not finished) is never struck while its job runs: after the
   schedule it's read every hour, and settled once the job reads finished.
2. A used-up approval whose job ended with the calendar reading not done or mixed is a failed or partial outcome:
   its card names each part not done, offers Go ahead for parts safe to do again (a new card for his approval, at
   the first offer's fixed ids), and asks him to ask again where absence is ambiguous; a read that failed says so.
3. Undo steps with no journaled version get no automatic undo; the series-day exception compares every field.
5. Repeating adds are read by their fixed id again: present is skipped, absent gets no Go ahead and isn't written.
6. Settlement wording comes from the actual read and the persisted next-read time; an untaken tap whose calendar
   can't be read says so, and a Go ahead whose read also fails writes nothing and says so.
7. The re-read schedule is exactly 1, 2, 5, 15, 30 and 60 minutes.
9. Every declared records-only choice kind, run against the fake calendars, writes nothing to them.
10. A family 412 on a forced add is "already there"; a mixed change's ambiguous absent add gets no Go ahead.
All names and ids invented.
"""
import json
import logging
from datetime import timedelta

import pytest

from harness import caldav, choices
from harness.calendar_change import ANYWAY_THERE, SERIES_COMPARE, Stopped
from harness.controller import Controller
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, PT_ID, TZ, ask, at, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round16_taps import (DENTIST, dentist_card, dentists, lines, m,  # noqa: F401
                                        press_for, restart_after_restore, tap_journaled)
from test_handover_round17_taps import (FAMILY_DINNER, REMOVE_PT, card_labels, landed_then_crashed, new_cards,
                                        new_said)
from test_handover_round18_taps import later, real_restart
from fake_caldav import no_network  # noqa: F401  (autouse)

SERIES = dict(change("gmail", "add_series", "Swim", dates="", start=at(7).isoformat(), end=at(8).isoformat()),
              days="WE")
FAMILY_SERIES = dict(SERIES, calendar="family", title="Family swim")


def cut_after(m, monkeypatch, *, run=True, before_run=None):
    """His Approve taken (the approval used up), the change run or not, then the handler fails: unknown."""
    real = m.c.callbacks.handle

    def handle(inc):
        real(inc)
        if before_run:
            before_run()
        if run:
            m.cc.run_pending(paused=False)
        raise RuntimeError("the handler failed")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        if not run:
            mp.setattr(m.c, "_work", lambda: None)
        out, press = tap_journaled(m, "Approve")
    assert out["outcome"] == "unknown"
    return press


def journal_checks(m):
    got = []
    real = m.c.handovers.journal_check

    def check(press, n, next_at, told):
        step = (n, round(next_at - m.c._clock()))
        if not got or got[-1] != step:          # twentieth round: the told mark rewrites the same read once queued
            got.append(step)
        return real(press, n, next_at, told)
    m.c.handovers.journal_check = check
    return got


# -- 1. a settling tap is never struck while its job runs ------------------------------------------------------------

@pytest.mark.card_only
def test_a_job_that_finishes_after_the_schedule_ends_is_then_settled(m, monkeypatch, clock):
    dentist_card(m)
    cut_after(m, monkeypatch)                                                  # the write lands with the tap
    checks = journal_checks(m)
    real_hold = Controller._records_hold
    running = {"on": True}                                                     # its job reads unfinished till off
    monkeypatch.setattr(Controller, "_records_hold",
                        lambda self, p: "settling" if running["on"] else real_hold(self, p))
    before = len(m.link.cards)
    for wait in (61, 121, 301, 901, 1801, 3601, 3601, 3601):                   # the schedule, then two cap reads
        later(m, clock, wait)
        assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]  # never struck while it runs
    assert [d for _, d in checks] == [120, 300, 900, 1800, 3600, 3600, 3600, 3600]
    said = new_said(m, before)
    assert len([t for t in said if "still carrying it out" in t]) == 1         # told once
    assert not any("Harness's records took it" in t for t in said)             # no card for good while it runs
    assert "Go ahead" not in card_labels(new_cards(m, before))
    running["on"] = False                                                      # its job reads finished now
    later(m, clock, 3601)                                                      # the next hourly read: settled
    assert m.c.handovers.journaled() == []
    assert any("already on your calendar" in t for t in new_said(m, before))
    assert len(dentists(m)) == 1


@pytest.mark.card_only
def test_a_settling_tap_is_read_at_every_start_and_kept(m, monkeypatch, tmp_path):
    dentist_card(m)
    cut_after(m, monkeypatch, run=False)
    monkeypatch.setattr(Controller, "_work", lambda self: None)
    for _ in range(3):
        real_restart(m, tmp_path)
        assert [r["state"] for r in m.c.handovers.journaled()] == ["unknown"]


# -- 7. the schedule is exactly six reads ---------------------------------------------------------------------------

@pytest.mark.card_only
def test_the_backoff_is_exactly_one_two_five_fifteen_thirty_sixty_minutes(m, monkeypatch, clock):
    dentist_card(m)
    checks = journal_checks(m)
    press = cut_after(m, monkeypatch)
    reads = []
    real_read = m.c._tap_read
    monkeypatch.setattr(m.c, "_tap_read", lambda op: reads.append(1) or real_read(op))
    outcomes = []
    real_outcome = m.c.handovers.journal_outcome
    m.c.handovers.journal_outcome = lambda p, kind, note="": outcomes.append(kind) or real_outcome(p, kind, note)
    m.gmail.down = True
    for wait in (61, 121, 301, 901, 1801, 3601):
        later(m, clock, wait)
    assert checks == [(1, 60), (2, 120), (3, 300), (4, 900), (5, 1800), (6, 3600)]
    assert len(reads) == 6
    assert m.c.handovers.journaled() == [] and outcomes == ["unverified"]      # struck, recorded as unverified
    said = new_said(m, 0)
    assert any("couldn't read your calendar to tell how far it got" in t for t in said)
    assert not any("doesn't show all of it done" in t for t in said)


# -- 2. a job that ended with parts not done ------------------------------------------------------------------------

@pytest.mark.card_only
def test_an_add_the_failed_job_never_sent_gets_go_ahead_and_lands_at_its_fixed_id(m, monkeypatch, clock):
    dentist_card(m)
    op = m.c._tap_op(press_for(m, "Approve"))
    fixed = m.cc._uid(f"{op['proposal']}:0", "cm")
    m.gmail.answer = "denied"                                                  # a plain no: nothing written
    cut_after(m, monkeypatch)
    m.gmail.answer = "ok"
    assert dentists(m) == []
    before = len(m.link.cards)
    later(m, clock, 61)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "didn't all go through" in said and "Dentist: not on your calendar" in said
    assert "Go ahead" in card_labels(cards)
    assert m.c.handovers.journaled() == []
    assert m.tap("Go ahead")["status"] == "ok"
    m.c.outbox.flush()
    assert "Approve" in card_labels(new_cards(m, before))                      # a new card, for his approval
    assert dentists(m) == []                                                   # nothing written by Go ahead
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert [e["id"] for e in dentists(m)] == [fixed]                           # the first offer's fixed id


@pytest.mark.card_only
def test_an_add_whose_write_may_have_been_sent_is_ambiguous_and_asks_him_to_ask_again(m, monkeypatch, clock):
    dentist_card(m)
    m.gmail.answer = "denied"
    press = cut_after(m, monkeypatch)
    m.gmail.answer = "ok"
    row = m.ledger.db.execute("SELECT proposal_id, settle_json FROM calendar_changes").fetchone()
    plan = json.loads(row["settle_json"])
    for part in plan["parts"]:
        for rec in part["steps"]:
            rec["status"] = "unsure"                                           # as if it may have gone out
    with m.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET settle_json=?", (json.dumps(plan),))
    before = len(m.link.cards)
    later(m, clock, 61)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "Dentist: not on your calendar" in said and "may have reached your calendar" in said
    assert "ask Harness for it again" not in said                              # twentieth round: never asks again
    assert "Go ahead" not in card_labels(cards)
    assert not any(e[0] == "insert" for e in m.gmail.log[1:])


@pytest.mark.card_only
def test_a_removal_still_there_beside_a_done_add_gets_go_ahead_for_it_alone(m, monkeypatch, clock):
    out = m.tells("add the dentist 3 to 4 and take PT off today", ask(DENTIST, REMOVE_PT))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    real_drop = m.gmail.drop
    m.gmail.drop = lambda address, uid, etag: caldav.Outcome("denied")
    cut_after(m, monkeypatch)
    m.gmail.drop = real_drop
    assert len(dentists(m)) == 1 and m.gmail.events[PT_ID]["status"] != "cancelled"
    before = len(m.link.cards)
    later(m, clock, 61)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "PT: not done on your calendar" in said and "Dentist: on your calendar" not in said
    assert "Go ahead" in card_labels(cards)
    assert m.tap("Go ahead")["status"] == "ok"
    m.c.outbox.flush()
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    assert m.gmail.events[PT_ID]["status"] == "cancelled" and len(dentists(m)) == 1


def test_the_failed_card_words_name_every_part_and_no_button():
    extra = {"names": ["Dentist", "Lunch", "PT"], "got": ["done", "absent", "not_done"], "retry": [2], "ask": [1]}
    text = Controller._relist_words("unknown", "failed_retry", [], restored=False, extra=extra)
    assert "Lunch: not on your calendar" in text and "PT: not done on your calendar" in text
    assert "Dentist" not in text.split("The button")[0].split("through: ")[1]
    assert "For Lunch" in text and "isn't done again from here" in text
    assert "ask Harness" not in text and "again if you" not in text            # twentieth round: never asks again
    assert not any(b in text for b in ("Go ahead", "Approve", "Undo"))
    unread = Controller._relist_words("unknown", "records_unread", [], restored=False)
    assert "couldn't read your calendar" in unread and "doesn't show" not in unread


# -- 10. a mixed change with an ambiguous absent add -----------------------------------------------------------------

def test_a_mixed_change_with_an_absent_add_offers_no_go_ahead_for_that_part(m, monkeypatch):
    op = {"effect": "calendar_change", "proposal": "p-none", "keys": [], "bound": [],
          "changes": [DENTIST, dict(DENTIST, title="Lunch")]}
    m.gmail.events[m.cc._uid("p-none:0", "cm")] = {"id": m.cc._uid("p-none:0", "cm"), "summary": "Dentist",
                                                   "status": "confirmed", "etag": '"d"',
                                                   "start": {"dateTime": at(15).isoformat(), "timeZone": TZ},
                                                   "end": {"dateTime": at(16).isoformat(), "timeZone": TZ}}
    plan = {"parts": [{"steps": [{"spec": {"key": "p-none:1"}, "status": "unconfirmed"}]}]}   # Lunch was sent
    monkeypatch.setattr(m.cc, "_plan_of", lambda pid: plan)
    got = m.cc.tap_parts(op)
    assert got == ["done", "absent"]
    seen, extra = m.c._ended_verdict(op, "mixed", list(zip(["Dentist", "Lunch"], got)))
    assert seen == "failed_ask" and extra["retry"] == [] and extra["ask"] == [1]
    assert seen in Controller.NO_GO_AHEAD


# -- 10. a family 412 on a forced add --------------------------------------------------------------------------------

def test_a_family_412_on_a_forced_add_is_already_there_and_nothing_is_written(m, monkeypatch):
    uid = m.cc._uid("anyway:p5:0", "hm-")
    monkeypatch.setattr(m.cc, "_there_by_id", lambda cal, ident: "not_done")    # its read raced the write
    part = m.cc._add_part(FAMILY_DINNER, "anyway:p5:0", force=True)
    path = FAMILY_PATH + uid + ".ics"
    m.icloud.seed(path, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Family dinner\r\nEND:VEVENT\r\n"
                        "END:VCALENDAR\r\n")
    body = m.icloud.events[path]
    with pytest.raises(Stopped) as why:
        part.steps[0].run()
    assert why.value.words == ANYWAY_THERE and "already there, so nothing was written" in why.value.words
    assert m.icloud.events[path] == body
    puts = [(method, h) for method, p, h, _ in m.icloud.log if method == "PUT"]
    assert puts and all(h.get("If-None-Match") == "*" for _, h in puts)


# -- 6. untaken with an unreadable calendar --------------------------------------------------------------------------

@pytest.mark.card_only
def test_an_untaken_tap_with_an_unreadable_calendar_says_so_and_a_failing_go_ahead_writes_nothing(m, monkeypatch,
                                                                                                    tmp_path):
    dentist_card(m)

    def handle(inc):
        raise RuntimeError("cut off before the approval")
    with monkeypatch.context() as mp:
        mp.setattr(m.c.callbacks, "handle", handle)
        tap_journaled(m, "Approve")
    m.gmail.down = True
    before = len(m.link.cards)
    real_restart(m, tmp_path)
    cards = new_cards(m, before)
    said = " ".join(c["text"] for c in cards)
    assert "couldn't be read just now, so the button below reads it first" in said
    assert "after reading your calendar for it first" not in said
    assert "Go ahead" in card_labels(cards)
    out = m.tap("Go ahead")
    assert out["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    assert any("still couldn't be read, so nothing was done" in t for t in new_said(m, 0))
    assert not any(e[0] == "insert" for e in m.gmail.log)
    m.gmail.down = False
    assert dentists(m) == []


def test_the_wait_note_says_the_next_start_when_its_time_couldnt_be_written(m, monkeypatch):
    rows = [{"press": {"id": "1", "custom_id": "k:x"}, "at": 1.0e9, "op": {}, "checks": 1, "told_check": False}]
    monkeypatch.setattr(m.c, "_records_hold", lambda p: "settling")
    m.c.handovers.journal_check = lambda *a: False
    before = len(m.link.cards)
    m.c._settle_unknown(rows)
    m.c.outbox.flush()
    (said,) = [c["text"] for c in new_cards(m, before)]
    assert "again when Harness next starts" in said and "at about" not in said


# -- 3. undo with no journaled version; the series-day exception compares every field -------------------------------

@pytest.mark.card_only
def test_an_undo_step_with_no_journaled_version_gets_no_automatic_undo(m, caplog):
    dentist_card(m)
    assert m.tap("Approve")["status"] == "ok"
    for _ in range(3):
        m.c.tick()
    m.c.outbox.flush()
    steps = json.loads(m.ledger.db.execute("SELECT undo_json FROM calendar_changes").fetchone()[0])
    for st in steps:
        st.pop("etag", None)                                                   # as an old journal wrote it
        st.pop("after", None)
    with m.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET undo_json=?", (json.dumps(steps),))
    before = len(m.link.cards)
    with caplog.at_level(logging.WARNING):
        assert m.tap("Undo")["status"] == "ok"
        for _ in range(3):
            m.c.tick()
        m.c.outbox.flush()
    said = " ".join(new_said(m, before))
    assert "made before Harness kept the version" in said and "new card for you to review" in said
    assert len(dentists(m)) == 1 and not any(e[0] == "drop" for e in m.gmail.log)
    assert "Undo" not in card_labels(new_cards(m, before))
    assert "legacy undo fallback" in caplog.text


def series_day(m, **edit):
    uid = "swim1_20261111T120000Z"
    wrote = {"start": {"dateTime": at(9).isoformat(), "timeZone": TZ}, "end": {"dateTime": at(10).isoformat(),
                                                                               "timeZone": TZ}}
    ev = {"id": uid, "recurringEventId": "swim1", "status": "confirmed", "etag": '"sibling"', "summary": "Swim",
          "description": "lane 3", "location": "Pool", **wrote}
    after = {k: ev.get(k) for k in SERIES_COMPARE}
    m.gmail.events[uid] = {**ev, **edit}
    step = {"cal": "gmail", "how": "change", "id": uid, "series": "swim1", "etag": '"as-left"',
            "fields": {"start": {"dateTime": at(7).isoformat(), "timeZone": TZ},
                       "end": {"dateTime": at(8).isoformat(), "timeZone": TZ}},
            "wrote": wrote, "after": after}
    return uid, step


@pytest.mark.parametrize("edit", [{"description": "lane 5, bring fins"}, {"location": "Lake"},
                                  {"attendees": [{"email": "friend@example.com"}]},
                                  {"reminders": {"useDefault": False, "overrides": [{"method": "popup",
                                                                                     "minutes": 30}]}},
                                  {"conferenceData": {"entryPoints": [{"uri": "https://meet.example.com/x"}]}},
                                  {"extendedProperties": {"private": {"note": "his"}}}])
def test_an_owner_edit_to_any_field_on_a_series_day_is_changed_with_no_write(m, edit):
    uid, step = series_day(m, **edit)
    assert m.cc._undo_gmail(step, {}) == "changed"
    assert not any(e[0] in ("change", "drop") for e in m.gmail.log)


def test_a_series_day_whose_version_moved_only_by_a_sibling_is_still_undone(m):
    uid, step = series_day(m)
    assert m.cc._undo_gmail(step, {}) == "ok"
    assert m.gmail.events[uid]["start"]["dateTime"] == at(7).isoformat()


def test_a_series_day_with_no_content_journaled_is_changed(m):
    uid, step = series_day(m)
    step.pop("after")
    assert m.cc._undo_gmail(step, {}) == "changed"


# -- 5. repeating adds, read by their fixed id again -----------------------------------------------------------------

def seed_family(m, uid, title):
    m.icloud.seed(FAMILY_PATH + uid + ".ics", f"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{title}\r\n"
                                            "DTSTART:20261111T120000Z\r\nDTEND:20261111T130000Z\r\nRRULE:FREQ=WEEKLY\r\n"
                                            "END:VEVENT\r\nEND:VCALENDAR\r\n")


def test_a_series_add_present_on_both_calendars_is_done_and_skipped(m):
    op = {"effect": "calendar_change", "proposal": "p19s", "keys": [], "bound": [], "changes": [SERIES, FAMILY_SERIES]}
    g, f = m.cc._uid("p19s:0", "cm"), m.cc._uid("p19s:1", "hm-")
    m.gmail.events[g] = {"id": g, "summary": "Swim", "status": "confirmed", "etag": '"s"', "recurrence": ["x"],
                         "start": {"dateTime": at(7).isoformat(), "timeZone": TZ},
                         "end": {"dateTime": at(8).isoformat(), "timeZone": TZ}}
    seed_family(m, f, "Family swim")
    assert m.cc.tap_parts(op) == ["done", "done"]
    m.cc.skip_found("p19s", op)
    parts, _ = m.cc._plan_all({"changes": [SERIES, FAMILY_SERIES]}, "p19s", run=True)
    assert parts == []                                                         # skipped: nothing written twice


@pytest.mark.parametrize("cancelled", [False, True])
def test_a_series_add_deleted_since_is_absent_and_skipped(m, cancelled):
    op = {"effect": "calendar_change", "proposal": "p19d", "keys": [], "bound": [], "changes": [SERIES, FAMILY_SERIES]}
    g = m.cc._uid("p19d:0", "cm")
    if cancelled:
        m.gmail.events[g] = {"id": g, "summary": "Swim", "status": "cancelled", "etag": '"c"'}
    assert m.cc.tap_parts(op) == ["absent", "absent"]                          # 404/410/cancelled, empty address
    assert m.cc.combine(m.cc.tap_parts(op)) == "absent"
    m.cc.skip_found("p19d", op)
    parts, _ = m.cc._plan_all({"changes": [SERIES, FAMILY_SERIES]}, "p19d", run=True)
    assert parts == []


@pytest.mark.card_only
def test_a_series_add_deleted_since_gets_no_go_ahead_and_nothing_is_written(m, monkeypatch):
    out = m.tells("add swim every wednesday at 7", ask(SERIES))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    backup, press = landed_then_crashed(m, monkeypatch)
    swims = [k for k, e in m.gmail.events.items() if e.get("summary") == "Swim"]
    assert len(swims) == 1
    del m.gmail.events[swims[0]]                                               # he deleted the series
    before = len(m.link.cards)
    inserts = len([e for e in m.gmail.log if e[0] == "insert"])
    restart_after_restore(m, backup)
    cards = new_cards(m, before)
    assert any("can't tell whether it was added and taken off" in c["text"] for c in cards)
    assert "Go ahead" not in card_labels(cards)
    for _ in range(3):
        m.c.tick()
    assert len([e for e in m.gmail.log if e[0] == "insert"]) == inserts


def test_a_mixed_change_containing_a_series_add_runs_only_the_other_part(m):
    op = {"effect": "calendar_change", "proposal": "p19m", "keys": [], "changes": [SERIES, REMOVE_PT],
          "bound": [{"op": "remove", "calendar": "gmail", "id": PT_ID, "instance": PT_ID, "change": 1}]}
    g = m.cc._uid("p19m:0", "cm")
    m.gmail.events[g] = {"id": g, "summary": "Swim", "status": "confirmed", "etag": '"s"', "recurrence": ["x"],
                         "start": {"dateTime": at(7).isoformat(), "timeZone": TZ},
                         "end": {"dateTime": at(8).isoformat(), "timeZone": TZ}}
    assert m.cc.tap_parts(op) == ["done", "not_done"]
    assert m.cc.combine(m.cc.tap_parts(op)) == "mixed"
    m.cc.skip_found("p19m", op)
    parts, _ = m.cc._plan_all({"changes": [SERIES, REMOVE_PT]}, "p19m", run=True)
    assert len(parts) == 1 and "PT" in parts[0].name


def test_the_combine_priority_among_settled_states_is_changed_then_absent_then_removed(m):
    combine = m.cc.combine
    assert combine(["removed", "absent", "changed"]) == "changed"
    assert combine(["removed", "changed"]) == "changed"
    assert combine(["absent", "removed"]) == "absent"
    assert combine(["done", "removed"]) == "removed"
    assert combine(["done", "absent", "not_done"]) == "mixed"


# -- 9. every records-only kind writes no calendar ------------------------------------------------------------------

def calendar_writes(m):
    return (len([e for e in m.gmail.log if e[0] in ("insert", "change", "drop")]),
            len([x for x in m.icloud.log if x[0] in ("PUT", "DELETE")]))


@pytest.mark.card_only
@pytest.mark.parametrize("kind", sorted(Controller.CHOICE_RECORDS))
def test_each_declared_records_only_kind_writes_no_calendar(m, kind):
    assert kind in choices.KINDS                                               # a real kind, not a stale name
    dentist_card(m)
    out = m.tells("add family dinner 6 to 7 today", ask(FAMILY_DINNER))
    assert out["status"] == "waiting for his tap", out
    m.c.outbox.flush()
    pids = [r[0] for r in m.ledger.db.execute("SELECT id FROM proposals").fetchall()]
    before = calendar_writes(m)
    for target in pids + ["x", ""]:
        try:
            m.c.callbacks._apply_choice(kind, target)
        except Exception:                                                     # noqa: BLE001: a refusal is fine
            pass
        for _ in range(3):
            m.c.tick()
    assert calendar_writes(m) == before, kind
