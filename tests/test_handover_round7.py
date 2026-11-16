"""0.24.0, seventh round: what the sixth outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: a refusal for a fence the calendar
can't honour ends with one plain receipt and no loop, and one fresh card per change family at most; every
Family write is built from one read with its If-Match from that read, and a Google series day writes its
own instance, so other days' edits survive; the smoke run is scoped, single use and bound to this build;
the fresh card after a stale refusal joins the change family; the bound record keeps attendees,
organiser and transparency; a late landing after his Decline; the run's test events, its lag samples and
the live re-read; and the card gate after an install. All names and ids invented.
"""
import json
import logging
import threading
from datetime import timedelta

import pytest

from harness import calendar_change, caldav, migrate
from harness.handover import Handover
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round2 import card_with, press
from test_handover_round4 import DENTIST, dentists, hang_first_insert
from test_handover_round5 import (DROP_SWIM, HAIRCUT, MOVE_HAIRCUT, SWIM_PATH, haircut_at, seed_haircut, settle,
                                  swim_ics)
from test_handover_round6 import (MOVE_POOL, MOVE_YOGA, POOL_PATH, SWIM, YOGA, _gmail_lapse, _lapse, _wait_for,
                                  card_for, dones, last_pid, pool_ics, run_smoke, seed_yoga, state, yoga_at,
                                  yoga_id, step_card)
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def not_applied(m):
    return [t for t in m.seen() if t.startswith("Not applied.")]


def fresh_cards(m):
    m.c.outbox.flush()
    return [t for t in m.seen() if "changed since your earlier card, so this is a fresh card" in t]


# -- 1. no re-card loop on a fence the calendar can't honour --------------------------------------------

def _gmail_refuses_every_fence(m, monkeypatch, weak=False):
    """Google answers 412 to every If-Match (or, `weak`, to every weak one, as a strong compare does),
    and the event never changes."""
    real_change, real_drop = m.gmail.change, m.gmail.drop
    sent = []

    def change_(address, uid, fields, etag):
        sent.append(etag)
        if etag and (not weak or etag.startswith("W/")):
            return caldav.Outcome("changed")
        return real_change(address, uid, fields, etag)

    def drop_(address, uid, etag):
        sent.append(etag)
        if etag and (not weak or etag.startswith("W/")):
            return caldav.Outcome("changed")
        return real_drop(address, uid, etag)
    monkeypatch.setattr(m.gmail, "change", change_)
    monkeypatch.setattr(m.gmail, "drop", drop_)
    return sent


def _icloud_refuses_every_fence(m, weak=False):
    real = m.icloud.request
    sent = []

    def request(method, url, *, headers=None, **kw):
        tag = (headers or {}).get("If-Match")
        if method in ("PUT", "DELETE") and tag:
            sent.append(tag)
            if not weak or tag.startswith("W/"):
                from harness.net import HttpResponse
                return HttpResponse(412)
        return real(method, url, headers=headers, **kw)
    m.icloud.request = request
    return sent


@pytest.mark.card_only
@pytest.mark.parametrize("weak", [False])     # eleventh round: a weak version is never sent (round 11 tests)
def test_gmail_refusing_every_fence_on_an_unchanged_event_says_so_once_with_no_fresh_card(m, monkeypatch, caplog, weak):
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    seed_haircut(m)
    if weak:
        m.gmail.events[HAIRCUT]["etag"] = 'W/"h1"'
    sent = _gmail_refuses_every_fence(m, monkeypatch, weak)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    cards = len(m.link.cards)
    m.tap("Approve")
    for minutes in (1, 3, 10, 40):
        settle(m, minutes=minutes, ticks=1)
    m.c.outbox.flush()
    assert haircut_at(m) == "10:00" and state(m, pid) == "fence_refused"
    said = not_applied(m)
    assert len(said) == 1 and "turned down the write at its safety check" in said[0]
    assert "shows the very version the write was guarded by, so nothing was changed" in said[0]
    assert "Try again makes a new card from a fresh read" in said[0] and "Try again" in m.labels()
    assert not fresh_cards(m) and not [c for c in list(m.link.cards)[cards:]
                                       if "Approve" in str(m.link.cards[c]["rows"])]   # no new card to tap
    assert len(sent) == 1                                                 # sent once, never again
    assert "refused the write's If-Match" in caplog.text and "although a read by id gives version" in caplog.text


@pytest.mark.card_only
@pytest.mark.parametrize("weak", [False])     # eleventh round: a weak version is never sent (round 11 tests)
def test_icloud_refusing_every_fence_on_an_unchanged_event_says_so_once_with_no_fresh_card(m, caplog, weak):
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    if weak:
        m.icloud._etag = lambda ics, n=iter(range(1, 99)): f'W/"weak-{next(n)}"'
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    sent = _icloud_refuses_every_fence(m, weak)
    pid = card_for(m, "no swim today", ask(DROP_SWIM))
    m.tap("Approve")
    for minutes in (1, 3, 10, 40):
        settle(m, minutes=minutes, ticks=1)
    m.c.outbox.flush()
    assert SWIM_PATH in m.icloud.events and state(m, pid) == "fence_refused"
    assert len(not_applied(m)) == 1 and not fresh_cards(m)
    assert len(sent) == 1
    assert "refused the write's If-Match" in caplog.text


@pytest.mark.card_only
def test_a_second_stale_refusal_in_one_change_family_ends_with_a_plain_receipt(m):
    seed_haircut(m)
    first = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))

    def someone_moves(hour):
        m.gmail.events[HAIRCUT].update(start={"dateTime": at(hour).isoformat(), "timeZone": TZ},
                                       end={"dateTime": at(hour, 30).isoformat(), "timeZone": TZ})
        m.gmail._bump(HAIRCUT)
    someone_moves(9)
    m.tap("Approve")
    assert len(fresh_cards(m)) == 1
    fresh = last_pid(m)
    assert fresh != first and m.cc.family_root(fresh) == m.cc.family_root(first)
    someone_moves(8)
    m.tap("Approve")                                 # the fresh card, refused as stale in turn
    m.c.outbox.flush()
    assert len(fresh_cards(m)) == 1                  # no second fresh card
    last = not_applied(m)[-1]
    assert "That was already its fresh card, so nothing was changed." in last
    assert "its start time and end time changed since your card" in last           # what changed since
    assert "Start again from now" in last and "Start again from now" in m.labels()
    assert haircut_at(m) == "08:00" and state(m, fresh) == "stale"


# -- 2. the write body comes from the pre-write read ------------------------------------------------------

def _pool_with_day_b_edits(desc="DESCRIPTION:Bring goggles\\n"):
    """The pool series with, written after the card: an override on Nov 18 (a later start, its own place and
    an alarm), an exception date on Nov 25, and a notes edit no compare can see (a trailing line end). (An
    attendee anywhere in the resource stops every write to it, so none is here: the invitee guard.)"""
    base = pool_ics(DESCRIPTION=desc).replace("RRULE:FREQ=WEEKLY;BYDAY=WE",
                                              "RRULE:FREQ=WEEKLY;BYDAY=WE\r\nEXDATE:20261125T220000Z")
    override = "\r\n".join(["BEGIN:VEVENT", "UID:pool-2222", "DTSTAMP:20261112T120000Z",
                            "RECURRENCE-ID:20261118T220000Z", "DTSTART:20261118T230000Z",
                            "DTEND:20261119T000000Z", "SUMMARY:Pool", "LOCATION:Pool C", "BEGIN:VALARM",
                            "ACTION:DISPLAY", "DESCRIPTION:Pool", "TRIGGER:-PT30M", "END:VALARM", "END:VEVENT"])
    return base.replace("END:VCALENDAR", override + "\r\nEND:VCALENDAR")


@pytest.mark.card_only
def test_a_family_series_write_keeps_another_days_override_exception_and_alarm(m):
    from test_calendar_change import days_of
    m.icloud.seed(POOL_PATH, pool_ics())
    pid = card_for(m, "pool at 5:30 today", ask(MOVE_POOL))
    edited = _pool_with_day_b_edits()
    m.icloud.seed(POOL_PATH, edited)                 # a new version of the resource, day A as the card had it
    read_etag = m.icloud.events[POOL_PATH][0]
    puts = []
    real = m.icloud.request

    def request(method, url, *, headers=None, body=None, **kw):
        if method == "PUT":
            puts.append(((headers or {}).get("If-Match"), body.decode()))
        return real(method, url, headers=headers, body=body, **kw)
    m.icloud.request = request
    m.tap("Approve")
    assert state(m, pid) == "done" and m.seen()[-1].startswith("Done."), m.seen()[-1]
    (if_match, sent), = puts
    assert if_match == read_etag                     # the If-Match is the pre-write read's
    after = m.icloud.events[POOL_PATH][1]
    assert "RECURRENCE-ID:20261118T220000Z" in after and "DTSTART:20261118T230000Z" in after
    assert "LOCATION:Pool C" in after and "TRIGGER:-PT30M" in after
    assert "EXDATE:20261125T220000Z" in after and "2026-11-25" not in days_of(after)
    assert "DESCRIPTION:Bring goggles\\n" in after   # the edit no compare could see survives the write


@pytest.mark.card_only
def test_a_family_write_whose_version_isnt_its_reads_is_never_sent(m, monkeypatch):
    m.icloud.seed(POOL_PATH, pool_ics())
    pid = card_for(m, "pool at 5:30 today", ask(MOVE_POOL))
    monkeypatch.setattr(m.cc, "_card_etag", lambda *a, **k: '"from-another-read"')
    before = dict(m.icloud.events)
    m.tap("Approve")
    assert m.icloud.events == before and state(m, pid) != "done"
    assert "the write's version didn't come from the read it was built from" in m.seen()[-1]


@pytest.mark.card_only
def test_a_gmail_series_day_write_is_the_instance_and_keeps_another_days_edits(m):
    seed_yoga(m)
    for day in (25,):
        m.gmail.events[yoga_id(day)] = {**m.gmail.events[yoga_id(18)], "id": yoga_id(day), "etag": f'"y{day}"',
                                        "originalStartTime": {"dateTime": at(18, day=day).isoformat()},
                                        "start": {"dateTime": at(18, day=day).isoformat(), "timeZone": TZ},
                                        "end": {"dateTime": at(19, day=day).isoformat(), "timeZone": TZ}}
    pid = card_for(m, "yoga at 6:30 today", ask(MOVE_YOGA))
    # Day B, before the tap: moved, an attendee's answer changed; day C cancelled (an exception date); and
    # day A's notes gain a trailing space, which no compare sees, with a new version.
    m.gmail.events[yoga_id(18)].update(start={"dateTime": at(19, day=18).isoformat(), "timeZone": TZ},
                                       end={"dateTime": at(20, day=18).isoformat(), "timeZone": TZ},
                                       attendees=[{"email": "coach@example.com", "responseStatus": "accepted"}])
    m.gmail.events[yoga_id(25)]["status"] = "cancelled"
    m.gmail.events[yoga_id(11)]["description"] = "Bring a mat  "
    for d in (11, 18, 25):
        m.gmail._bump(yoga_id(d))
    m.tap("Approve")
    assert state(m, pid) == "done" and yoga_at(m, 11) == "18:30"
    writes = [e for e in m.gmail.log if e[0] == "change"]
    assert [w[1] for w in writes] == [yoga_id(11)] and set(writes[0][2]) == {"start", "end"}   # the instance only
    assert YOGA not in [w[1] for w in writes]
    assert yoga_at(m, 18) == "19:00" and m.gmail.events[yoga_id(18)]["attendees"][0]["responseStatus"] == "accepted"
    assert m.gmail.events[yoga_id(25)]["status"] == "cancelled"
    assert m.gmail.events[yoga_id(11)]["description"] == "Bring a mat  "


@pytest.mark.card_only
def test_a_gmail_day_that_reads_as_the_whole_series_is_never_written(m):
    seed_yoga(m)
    pid = card_for(m, "yoga at 6:30 today", ask(MOVE_YOGA))
    day = m.gmail.events[yoga_id(11)]
    day.pop("recurringEventId")
    day["recurrence"] = ["RRULE:FREQ=WEEKLY;BYDAY=WE"]
    m.tap("Approve")
    assert not [e for e in m.gmail.log if e[0] == "change"] and state(m, pid) != "done"


# -- 3. the smoke run is scoped, single use and bound to this build -----------------------------------------

@pytest.mark.card_only
def test_a_run_from_another_version_is_refused(m, monkeypatch):
    run = run_smoke(m)
    monkeypatch.setattr(calendar_change, "app_version", lambda: "0.24.1")
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "refused" and "started under version 0.24.0, not 0.24.1" in out["said"]
    assert not calendar_change.fast_path_on(m.ledger)


@pytest.mark.card_only
def test_an_expired_run_is_refused_and_tags_nothing_more(m):
    run = run_smoke(m)
    m.clock.t += timedelta(hours=25)
    m.c.tick()
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "refused" and "ran out after 24 hours" in out["said"]
    card_for(m, "add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="", start=at(18, day=12).isoformat(),
                                                     end=at(19, day=12).isoformat())))
    m.tap("Approve")
    plan = json.loads(m.ledger.db.execute("SELECT settle_json FROM calendar_changes ORDER BY rowid DESC LIMIT 1")
                      .fetchone()[0])
    assert "smoke" not in plan and not m.cc.abandoned           # a normal request: never let go
    assert any(e.get("summary") == "Vet" for e in m.gmail.events.values())


@pytest.mark.card_only
def test_a_run_gives_one_turn_on_and_a_new_run_is_needed_after_turn_off(m):
    run = run_smoke(m)
    assert m.send(Handover(kind="fastpath", state="on", run=run))["status"] == "ok"
    m.tap("Turn on")
    assert calendar_change.fast_path_on(m.ledger)
    again = m.send(Handover(kind="fastpath", state="on", run=run))
    assert again["status"] == "refused" and "already used for a Turn on" in again["said"]
    m.tap("Turn off")
    assert not calendar_change.fast_path_on(m.ledger)
    again = m.send(Handover(kind="fastpath", state="on", run=run))
    assert again["status"] == "refused" and "already used" in again["said"]


@pytest.mark.card_only
def test_turn_off_takes_every_open_turn_on_card_off(m):
    run = run_smoke(m)
    m.send(Handover(kind="fastpath", state="on", run=run))
    card = card_with(m, "Turn on")
    m.send(Handover(kind="fastpath", state="off"))
    m.c.outbox.flush()
    assert m.link.cards[card]["rows"] == []
    assert not m.ledger.get_meta(calendar_change.FAST_OFFER)


@pytest.mark.card_only
def test_a_turn_on_card_from_before_an_install_does_nothing_when_tapped_after(m):
    run = run_smoke(m)
    m.send(Handover(kind="fastpath", state="on", run=run))
    card = card_with(m, "Turn on")
    custom = next(c["custom_id"] for r in m.link.cards[card]["rows"] for c in r["components"]
                  if c["label"] == "Turn on")
    out = migrate.install(m.ledger, m.cc, "0.24.1")            # the next version starts on this ledger
    assert out["run_closed"] is True and out["cards_retired"] == 2
    m.c.outbox.flush()
    assert m.link.cards[card]["rows"] == []
    m.send(Handover(kind="press", press={"id": "98765", "token": "t", "app": "999", "custom_id": custom,
                                         "message_id": str(card)}))         # his tap on the old card
    assert not calendar_change.fast_path_on(m.ledger)
    assert m.send(Handover(kind="fastpath", state="on", run=run))["status"] == "refused"


@pytest.mark.card_only
def test_a_normal_request_with_no_run_live_is_never_let_go(m):
    m.tells("add the dentist at 3 today", ask(DENTIST))
    m.tap("Approve")
    assert not m.cc.abandoned and len(dentists(m)) == 1 and m.seen()[-1].startswith("Done.")
    assert not m.cc._smoke_tag(m.ledger.db.execute("SELECT * FROM proposals ORDER BY rowid DESC LIMIT 1").fetchone())


# -- 4. the fresh card after a stale refusal joins the change family -----------------------------------------

def test_the_original_landing_late_takes_the_fresh_card_after_a_stale_refusal_off(m, monkeypatch):
    reach, answer, calls, first, newer = _gmail_lapse(m, monkeypatch, commit_first=True)
    reach.set()
    _wait_for(lambda: haircut_at(m) == "10:30")             # the first write is on Google; its answer waits
    m.gmail.events[HAIRCUT].update(start={"dateTime": at(11).isoformat(), "timeZone": TZ},
                                   end={"dateTime": at(11, 30).isoformat(), "timeZone": TZ})
    m.gmail._bump(HAIRCUT)                                    # then someone moves it on
    m.tap("Approve")                                          # the card offered again: refused as stale
    assert state(m, newer) == "stale" and len(fresh_cards(m)) == 1
    fresh = last_pid(m)
    assert set(m.cc.family_members(fresh)) >= {first, newer, fresh}
    card = card_with(m, "Approve")
    answer.set()                                              # the original's answer comes back: it landed
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert len(dones(m)) == 1 and dones(m)[0].startswith("Done after all")
    assert m.link.cards[card]["rows"] == [] and state(m, first) == "landed_late"
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (fresh,)).fetchone()[0] == "superseded"


# -- 5. the bound record keeps attendees, organiser and transparency ------------------------------------------

def test_the_print_keeps_attendees_organiser_transparency_and_evens_out_only_line_ends():
    at_ = calendar_change._print
    from datetime import datetime, timezone
    t = datetime(2026, 11, 11, 23, tzinfo=timezone.utc)
    one = at_("Yoga", t, t, [], "", "Bring a mat\r\n", [("Coach@Example.com", "accepted")], "Me@Example.com", "")
    assert one["attendees"] == [["coach@example.com", "accepted"]] and one["organizer"] == "me@example.com"
    assert one["transparency"] == "opaque"
    assert one == at_("Yoga", t, t, [], "", "Bring a mat  \n", [("coach@example.com", "accepted")], "me@example.com",
                      "OPAQUE")
    assert one["notes"] != at_("Yoga", t, t, [], "", "Bring  a mat", [("coach@example.com", "accepted")],
                               "me@example.com", "")["notes"]
    assert one != at_("Yoga", t, t, [], "", "Bring a mat", [("coach@example.com", "declined")], "me@example.com", "")
    assert one != at_("Yoga", t, t, [], "", "Bring a mat", [("coach@example.com", "accepted")], "you@example.com", "")
    assert one != at_("Yoga", t, t, [], "", "Bring a mat", [("coach@example.com", "accepted")], "me@example.com",
                      "transparent")


GMAIL_FIELD_EDITS = {
    "transparency": lambda e: e.update(transparency="transparent"),
    "notes_inner_space": lambda e: e.update(description="Bring  a mat"),
}


@pytest.mark.card_only
@pytest.mark.parametrize("edit", sorted(GMAIL_FIELD_EDITS))
def test_a_series_day_whose_busy_or_notes_changed_is_refused(m, edit):
    seed_yoga(m)
    pid = card_for(m, "yoga at 6:30 today", ask(MOVE_YOGA))
    GMAIL_FIELD_EDITS[edit](m.gmail.events[yoga_id(11)])
    m.gmail._bump(yoga_id(11))
    m.tap("Approve")
    assert yoga_at(m) == "18:00" and state(m, pid) == "stale"


@pytest.mark.card_only
@pytest.mark.parametrize("edit", ["attendee", "organizer"])
def test_a_series_day_whose_people_changed_since_the_card_is_never_written(m, edit):
    """People on an event stop the write before it's sent (the invitee guard); the bound record keeps
    them too, so even a write that got that far would be refused as changed."""
    seed_yoga(m)
    pid = card_for(m, "yoga at 6:30 today", ask(MOVE_YOGA))
    day = m.gmail.events[yoga_id(11)]
    if edit == "attendee":
        day["attendees"] = [{"email": "coach@example.com", "responseStatus": "accepted"}]
    else:
        day["organizer"] = {"email": "someone@example.com"}
    m.gmail._bump(yoga_id(11))
    printed = m.cc._gmail_print(m.gmail.events[yoga_id(11)])
    assert printed != m.cc.bound_of(pid)["bound"][0]["print"]
    m.tap("Approve")
    assert yoga_at(m) == "18:00" and state(m, pid) != "done"
    assert not [e for e in m.gmail.log if e[0] == "change"]


@pytest.mark.card_only
def test_a_family_series_whose_busy_flag_or_attendee_changed_is_never_written_over(m):
    m.icloud.seed(POOL_PATH, pool_ics())
    pid = card_for(m, "pool at 5:30 today", ask(MOVE_POOL))
    m.icloud.seed(POOL_PATH, pool_ics().replace("LOCATION:Pool A", "LOCATION:Pool A\r\nTRANSP:TRANSPARENT"))
    before = m.icloud.events[POOL_PATH][1]
    m.tap("Approve")
    assert m.icloud.events[POOL_PATH][1] == before and state(m, pid) == "stale"
    with_people = pool_ics().replace("LOCATION:Pool A", "LOCATION:Pool A\r\nORGANIZER:mailto:me@example.com\r\n"
                                     "ATTENDEE;PARTSTAT=ACCEPTED:mailto:coach@example.com")
    b = m.cc.bound_of(pid)["bound"][0]
    printed = m.cc._family_print(with_people, b["instance"], m.cc._day_of(b))
    assert printed["attendees"] == [["coach@example.com", "accepted"]] and printed["organizer"] == "me@example.com"


# -- 6. a late landing after his Decline ----------------------------------------------------------------------

def _declined_add_lands(m, monkeypatch, edit_after=None):
    gate, calls = hang_first_insert(m, monkeypatch)
    first, newer = _lapse(m, "add the dentist at 3 today", DENTIST, "The dentist at 3 PM today.")
    m.tap("Decline")
    gate.set()
    m.cc.join_abandoned()
    if edit_after:
        edit_after()
    m.c.tick()
    m.c.tick()
    m.c.outbox.flush()
    return first, newer


def test_a_plain_add_landing_after_his_decline_is_taken_off_again_by_itself(m, monkeypatch):
    first, newer = _declined_add_lands(m, monkeypatch)
    said = [t for t in m.seen() if t.startswith("Applied despite your Decline")]
    # Eighth round: the revert's own outcome is on that same receipt.
    assert len(said) == 1 and "I took it off again, only over that version" in said[0]
    assert "it's off your calendar now, and a read of it by its id shows it gone" in said[0]
    assert not dentists(m)                                     # taken off again
    assert not any(t.startswith("Undone.") for t in m.seen())  # one receipt, not two
    row = m.ledger.db.execute("SELECT undo_state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()
    assert row[0] == "undone"


def test_an_add_changed_since_it_landed_after_his_decline_keeps_undo_first_for_longer(m, monkeypatch):
    def he_edits():
        e = dentists(m)[0]
        e["description"] = "Bring the forms"
        m.gmail._bump(e["id"])
    first, newer = _declined_add_lands(m, monkeypatch, he_edits)
    said = [t for t in m.seen() if t.startswith("Applied despite your Decline")]
    assert len(said) == 1 and "Undo comes first" in said[0] and "it has changed since it was written" in said[0]
    assert len(dentists(m)) == 1
    card = max(m.link.cards)
    assert [c["label"] for r in m.link.cards[card]["rows"] for c in r["components"]][0] == "Undo"
    exp = m.ledger.db.execute("SELECT created_at, expires_at FROM choices WHERE kind='calendar_change_undo' AND"
                              " target=? ORDER BY rowid DESC", (first,)).fetchone()
    from datetime import datetime
    assert datetime.fromisoformat(exp[1]) - datetime.fromisoformat(exp[0]) == timedelta(days=30)


# -- 7. the run's test events, lag samples and the live re-read -----------------------------------------------

@pytest.mark.card_only
def test_the_runs_adds_are_tagged_and_listed_with_one_tap_removal_at_turn_on(m):
    run = run_smoke(m)
    tagged = [e for e in m.gmail.events.values() if e.get("summary", "").startswith("Smoke test: ")]
    assert tagged and tagged[0]["extendedProperties"]["private"]["harness_smoke"] == run
    family = [ics for _, ics in m.icloud.events.values() if "Smoke test: Piano" in ics]
    assert family and f"X-HARNESS-SMOKE:{run}" in family[0]
    assert m.send(Handover(kind="fastpath", state="on", run=run))["status"] == "ok"
    m.c.outbox.flush()
    listing = [t for t in m.seen() if t.startswith("Test events from the check after installing")]
    assert listing and "Gmail: “Smoke test: Dentist”" in listing[-1] and "Family: “Smoke test: Piano”" in listing[-1]
    m.tap("Take them off")
    assert not [e for e in m.gmail.events.values()
                if e.get("summary", "").startswith("Smoke test: ") and e.get("status") != "cancelled"]
    assert not [p for p, (_, ics) in m.icloud.events.items() if "Smoke test: " in ics]


@pytest.mark.card_only
def test_a_test_event_changed_since_is_left_by_take_them_off(m):
    run = run_smoke(m)
    m.send(Handover(kind="fastpath", state="on", run=run))
    dentist = next(e for e in m.gmail.events.values() if e.get("summary") == "Smoke test: Dentist")
    m.gmail._bump(dentist["id"])                              # changed since the listing read it
    real = m.gmail.drop
    m.gmail.drop = lambda a, uid, etag: caldav.Outcome("changed") if uid == dentist["id"] else real(a, uid, etag)
    m.tap("Take them off")
    assert m.gmail.events[dentist["id"]].get("status") != "cancelled"


@pytest.mark.card_only
def test_a_refused_or_expired_run_lists_its_test_events(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    step_card(m, run, "gmail-add", "add the dentist at 3 today", ask(DENTIST))    # tenth round: from its script
    m.tap("Approve")
    m.cc.join_abandoned()
    settle(m)
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    m.c.outbox.flush()
    assert out["status"] == "refused"
    assert [t for t in m.seen() if t.startswith("Test events from the check") and "was refused" in t]
    m.clock.t += timedelta(hours=25)
    m.c.tick()
    m.c.outbox.flush()
    assert [t for t in m.seen() if t.startswith("Test events from the check") and "the test ran out" in t]
    assert calendar_change.smoke_run(m.ledger).get("closed_why") == "expired"


@pytest.mark.card_only
def test_the_card_shows_two_lag_samples_per_calendar_and_the_live_state(m):
    run = run_smoke(m)
    m.gmail.events[next(k for k, e in m.gmail.events.items() if e.get("summary") == "Smoke test: Dentist")][
        "status"] = "cancelled"                               # taken off by hand since
    m.send(Handover(kind="fastpath", state="on", run=run))
    card = next(t for t in reversed(m.seen()) if t.startswith("The check after installing passed."))
    assert "(Gmail: 0s, 0s" in card and "Family: 0s, 0s" in card
    assert "Gmail: An add, id ending" in card and "(now: not on the calendar)" in card
    assert "(now: “Smoke test: Piano” on the calendar)" in card


@pytest.mark.card_only
def test_one_lag_sample_on_a_calendar_is_refused(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    items, missing, _ = m.cc.smoke_evidence(run)
    assert "listing_lag: 0 samples on Gmail, 2 needed; 0 samples on Family, 2 needed" in missing


def test_the_measured_lag_sends_a_no_card_change_to_a_card_after_a_fresh_write(m):
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.LISTING_LAG, "120", db)
    assert m.tells("add the dentist at 3 today", ask(DENTIST))["status"] == "executed"
    out = m.tells("add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="", start=at(18).isoformat(),
                                                       end=at(19).isoformat())))
    m.c.outbox.flush()
    assert "Approve" in m.labels() and any("within the time its listing takes to show new events" in t
                                           for t in m.seen()), out
    m.clock.t += timedelta(minutes=3)
    out = m.tells("add the cat at 7 today", ask(change("gmail", "add", "Cat", dates="", start=at(19).isoformat(),
                                                       end=at(20).isoformat())))
    assert out["status"] == "executed"


def test_the_docs_give_the_manual_step_for_the_refused_item_on_each_calendar():
    from pathlib import Path
    docs = (Path(__file__).resolve().parents[1] / "harness" / "DOCS.md").read_text()
    assert "To produce the Gmail stale card" in docs and "To produce the Family stale card" in docs


# -- 8. the card gate after an install ----------------------------------------------------------------------

# Eighth round: the gate holds cards per calendar instead of refusing them (test_handover_round8.py).


def test_a_restart_on_the_same_version_keeps_the_gate_and_doesnt_install_again(m):
    assert migrate.install(m.ledger, m.cc) == {}
    gate = calendar_change.card_gate(m.ledger)
    assert gate["version"] == calendar_change.app_version()


# -- 9. the migration from a ledger with an open Turn on card or a live run ------------------------------------

@pytest.mark.card_only
def test_an_install_over_a_live_run_ends_it_and_sets_the_gate(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    out = migrate.install(m.ledger, m.cc, "0.24.1")
    assert out["run_closed"] is True and out["from"] == calendar_change.app_version()
    kept = calendar_change.smoke_run(m.ledger)
    assert kept["closed_why"] == "install"
    gate = calendar_change.card_gate(m.ledger)
    assert gate["version"] == "0.24.1" and gate["verified"] == {}
    refused = m.send(Handover(kind="fastpath", state="on", run=run))
    assert refused["status"] == "refused" and "an update was installed since" in refused["said"]


@pytest.mark.card_only
def test_an_install_turns_the_no_card_paths_off_and_takes_the_turn_off_card_with_them(m):
    run = run_smoke(m)
    m.send(Handover(kind="fastpath", state="on", run=run))
    m.tap("Turn on")
    assert calendar_change.fast_path_on(m.ledger)
    out = migrate.run(m.ledger, m.cc, 1, version="0.24.1")
    assert out["install"]["fast_path_off"] is True
    assert not calendar_change.fast_path_on(m.ledger)
    assert migrate.run(m.ledger, m.cc, 1, version="0.24.1") == {}          # once per version
