"""0.24.0, sixth round: what the fifth outside review of the handover fixes asked for (Nov 16).

Each change on its own, against the fake calendars and a fake Discord: the version refinement compares
every bound field and only for a series or shared resource; a write the calendar refused for its
version is not applied and comes back on one fresh card; a write of ours that landed late is found
before "nothing of ours"; cards offered again keep the first card's version; late receipts say whose
request and how old; paused writes come back; etags byte for byte; and the no-card flag built from the
specialist's own ledger. All names and ids invented.
"""
import json
import threading
import time
from datetime import timedelta

import pytest

from harness import calendar_change
from harness.handover import Handover
from test_discord_keeper import OWNER
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round2 import card_with, press
from test_handover_round4 import rows
from test_handover_round5 import (DROP_HAIRCUT, HAIRCUT, MOVE_HAIRCUT, SWIM_PATH, haircut_at, seed_haircut,
                                  settle, swim_at, swim_ics)
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def state(m, pid):
    got = m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
    return got[0] if got else None


def last_pid(m):
    return m.ledger.db.execute("SELECT id FROM proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()[0]


def dones(m):
    return [t for t in m.seen() if t.startswith("Done")]


# -- a weekly series on each calendar ----------------------------------------------------------------

YOGA = "yoga0series"


def yoga_id(day):
    return f"{YOGA}_202611{day:02d}T230000Z"


def seed_yoga(m):
    """Yoga, weekly on Wednesdays at 6 PM on Gmail: the series and two of its days, as Google gives them."""
    m.gmail.events[YOGA] = {"id": YOGA, "summary": "Yoga", "status": "confirmed", "etag": '"m1"',
                            "organizer": {"email": GMAIL, "self": True},
                            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
                            "start": {"dateTime": at(18, day=4).isoformat(), "timeZone": TZ},
                            "end": {"dateTime": at(19, day=4).isoformat(), "timeZone": TZ}}
    for day in (11, 18):
        m.gmail.events[yoga_id(day)] = {
            "id": yoga_id(day), "recurringEventId": YOGA, "summary": "Yoga", "status": "confirmed",
            "etag": f'"y{day}"', "organizer": {"email": GMAIL, "self": True},
            "location": "Studio A", "description": "Bring a mat",
            "originalStartTime": {"dateTime": at(18, day=day).isoformat()},
            "start": {"dateTime": at(18, day=day).isoformat(), "timeZone": TZ},
            "end": {"dateTime": at(19, day=day).isoformat(), "timeZone": TZ}}


def yoga_at(m, day=11):
    from test_plain_commands import NY
    from datetime import datetime
    e = m.gmail.events[yoga_id(day)]
    if e.get("status") == "cancelled":
        return None
    return datetime.fromisoformat(e["start"]["dateTime"]).astimezone(NY).strftime("%H:%M")


MOVE_YOGA = change("gmail", "move", "Yoga", start=at(18, 30).isoformat(), end=at(19, 30).isoformat())
DROP_YOGA = change("gmail", "remove", "Yoga")

POOL_PATH = FAMILY_PATH + "pool-2222.ics"


def pool_ics(**edit):
    lines = {"DTEND": "DTEND:20261104T230000Z", "RRULE": "RRULE:FREQ=WEEKLY;BYDAY=WE",
             "DESCRIPTION": "DESCRIPTION:Bring goggles", "LOCATION": "LOCATION:Pool A", **edit}
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:pool-2222",
                        "DTSTAMP:20261101T120000Z", "DTSTART:20261104T220000Z", lines["DTEND"], lines["RRULE"],
                        "SUMMARY:Pool", lines["LOCATION"], lines["DESCRIPTION"], "END:VEVENT", "END:VCALENDAR", ""])


def pool_days(m):
    from test_calendar_change import days_of
    return days_of(m.icloud.events[POOL_PATH][1])


MOVE_POOL = change("family", "move", "Pool", start=at(17, 30).isoformat(), end=at(18, 30).isoformat())
DROP_POOL = change("family", "remove", "Pool")


def card_for(m, words, *outputs):
    out = m.tells(words, *outputs)
    assert out["status"] == "waiting for his tap", out
    return last_pid(m)


# -- 1. the refinement compares every bound field ------------------------------------------------------

GMAIL_EDITS = {
    "end": lambda e, master: e.update(end={"dateTime": at(19, 15).isoformat(), "timeZone": TZ}),
    "recurrence": lambda e, master: master.update(recurrence=["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=10"]),
    "notes": lambda e, master: e.update(description="Bring a towel"),
    "location": lambda e, master: e.update(location="Studio B"),
}


@pytest.mark.card_only
@pytest.mark.parametrize("op", ["move", "remove"])
@pytest.mark.parametrize("edit", sorted(GMAIL_EDITS))
def test_a_gmail_series_day_edited_between_card_and_write_is_refused(m, op, edit):
    seed_yoga(m)
    pid = card_for(m, "yoga at 6:30 today" if op == "move" else "no yoga today",
                   ask(MOVE_YOGA if op == "move" else DROP_YOGA))
    e = m.gmail.events[yoga_id(11)]
    GMAIL_EDITS[edit](e, m.gmail.events[YOGA])
    m.gmail._bump(yoga_id(11))                   # Google gives the day a new version
    m.tap("Approve")
    assert yoga_at(m) == "18:00"                 # not moved, not taken off
    assert state(m, pid) == "stale"
    assert any(t.startswith("Not applied.") and "The event changed since your card" in t for t in m.seen())


FAMILY_EDITS = {"DTEND": "DTEND:20261104T231500Z", "RRULE": "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=20",
                "DESCRIPTION": "DESCRIPTION:Bring a towel", "LOCATION": "LOCATION:Pool B"}


@pytest.mark.card_only
@pytest.mark.parametrize("op", ["move", "remove"])
@pytest.mark.parametrize("edit", sorted(FAMILY_EDITS))
def test_a_family_series_edited_between_card_and_write_is_refused(m, op, edit):
    m.icloud.seed(POOL_PATH, pool_ics())
    pid = card_for(m, "pool at 5:30 today" if op == "move" else "no pool today",
                   ask(MOVE_POOL if op == "move" else DROP_POOL))
    m.icloud.seed(POOL_PATH, pool_ics(**{edit: FAMILY_EDITS[edit]}))
    before = m.icloud.events[POOL_PATH][1]
    m.tap("Approve")
    assert m.icloud.events[POOL_PATH][1] == before        # nothing written over the edit
    assert state(m, pid) == "stale"
    assert any(t.startswith("Not applied.") for t in m.seen())


@pytest.mark.card_only
def test_two_days_of_one_family_series_on_two_cards_both_go(m):
    m.icloud.seed(POOL_PATH, pool_ics())
    first = card_for(m, "no pool today", ask(DROP_POOL))
    first_card = card_with(m, "Approve")
    second = card_for(m, "no pool next wednesday", ask(change("family", "remove", "Pool", dates="2026-11-18")))
    press(m, first_card, "Approve")
    assert "2026-11-11" not in pool_days(m)
    m.tap("Approve")                                      # its resource has a new version: the first card's write
    assert "2026-11-18" not in pool_days(m) and "2026-11-25" in pool_days(m)
    assert state(m, first) == "done" and state(m, second) == "done"


@pytest.mark.card_only
def test_two_days_of_one_gmail_series_on_two_cards_both_go(m):
    seed_yoga(m)
    first = card_for(m, "no yoga today", ask(DROP_YOGA))
    first_card = card_with(m, "Approve")
    second = card_for(m, "no yoga next wednesday", ask(change("gmail", "remove", "Yoga", dates="2026-11-18")))
    press(m, first_card, "Approve")
    m.gmail._bump(yoga_id(18))                            # a series edit gives the other day a new version
    m.tap("Approve")
    assert yoga_at(m, 11) is None and yoga_at(m, 18) is None
    assert state(m, first) == "done" and state(m, second) == "done"


@pytest.mark.card_only
def test_a_one_off_whose_version_moved_on_with_nothing_else_changed_is_still_refused(m):
    """Only a series or a shared resource may take a newer version: a lone event's card version stands."""
    seed_haircut(m)
    pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.gmail._bump(HAIRCUT)
    m.tap("Approve")
    assert haircut_at(m) == "10:00" and state(m, pid) == "stale"


# -- 2. a refused stale write is not unverified ---------------------------------------------------------

def correct_haircut(m):
    m.gmail.events[HAIRCUT].update(start={"dateTime": at(9, 30).isoformat(), "timeZone": TZ},
                                   end={"dateTime": at(10).isoformat(), "timeZone": TZ})
    m.gmail._bump(HAIRCUT)


SWIM = change("family", "move", "Swim", start=at(17).isoformat(), end=at(18).isoformat())


@pytest.mark.card_only
@pytest.mark.parametrize("provider", ["gmail", "family"])
def test_a_refusal_whose_read_doesnt_match_is_not_applied_with_one_fresh_card_and_no_follow_up(m, provider):
    if provider == "gmail":
        seed_haircut(m)
        pid = card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
        correct_haircut(m)
    else:
        m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
        pid = card_for(m, "swim moved to 5 today", ask(SWIM))
        m.icloud.seed(SWIM_PATH, swim_ics("20261111T200000Z", "20261111T210000Z"))
    cards = len(m.link.cards)
    m.tap("Approve")
    m.c.outbox.flush()
    new = [m.link.cards[c]["text"] for c in sorted(m.link.cards)[cards:]]
    assert len([t for t in new if "changed since your earlier card, so this is a fresh card" in t]) == 1
    receipt = next(t for t in m.seen() if t.startswith("Not applied."))
    assert "The event changed since your card" in receipt and "a read of it by its id" in receipt
    assert state(m, pid) == "stale"
    plan = json.loads(m.ledger.db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?",
                                          (pid,)).fetchone()[0])
    assert not plan.get("recheck") and not plan.get("watch_next")
    seen = len(m.seen())
    for minutes in (1, 3, 10, 40):
        settle(m, minutes=minutes, ticks=1)
    m.c.outbox.flush()
    assert len(m.seen()) == seen                          # no Not seen yet, Not found or Done after all
    assert not any(t.startswith(("Not seen yet", "Not found", "Not confirmed")) for t in m.seen())


@pytest.mark.card_only
def test_the_fresh_card_is_bound_to_the_events_version_now_and_its_tap_writes(m):
    seed_haircut(m)
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    correct_haircut(m)
    m.tap("Approve")
    fresh = last_pid(m)
    assert [b["etag"] for b in m.cc.bound_of(fresh)["bound"]] == [m.gmail.events[HAIRCUT]["etag"]]
    m.tap("Approve")
    assert haircut_at(m) == "10:30" and m.seen()[-1].startswith("Done.")


# -- a move whose first write hangs, lapses, and comes again on a card ---------------------------------

def _gmail_hold(m, monkeypatch, commit_first=False):
    """The first move of the haircut waits before it reaches Google until `reach` is set; with
    `commit_first`, Google then applies it and its answer waits on `answer`."""
    real = m.gmail.change
    reach, answer, calls = threading.Event(), threading.Event(), []

    def change_(address, uid, fields, etag):
        calls.append(etag)
        if uid == HAIRCUT and len(calls) == 1:
            reach.wait(10)
            out = real(address, uid, fields, etag)
            if commit_first:
                answer.wait(10)
            return out
        return real(address, uid, fields, etag)
    monkeypatch.setattr(m.gmail, "change", change_)
    m.cc.write_timeout_s = 0.05
    return reach, answer, calls


def _lapse(m, words, output, again):
    mid = m.he_says(words)
    m.claude.script = [ask(output)]
    m.handover(paired=OWNER, message=mid)
    first = rows(m)[-1]["proposal_id"]
    m.clock.t += timedelta(minutes=3)
    m.claude.script = [ask(output)]
    out = m.handover(paired=OWNER, message=mid, suggestion=again)
    assert out["status"] == "waiting for his tap"
    assert state(m, first) == "lapsed"
    newer = m.ledger.get_meta(f"calendar_change_reoffer:{first}")
    assert newer
    m.cc.write_timeout_s = 5
    return first, newer


def _gmail_lapse(m, monkeypatch, commit_first=False):
    seed_haircut(m)
    reach, answer, calls = _gmail_hold(m, monkeypatch, commit_first)
    first, newer = _lapse(m, "haircut moved to 10:30 today", MOVE_HAIRCUT, "The haircut at 10:30 today.")
    return reach, answer, calls, first, newer


def _family_lapse(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    reach = threading.Event()
    m.icloud.before_write = lambda: reach.wait(10)
    m.cc.write_timeout_s = 0.05
    first, newer = _lapse(m, "swim moved to 5 today", SWIM, "Swim at 5 today.")
    return reach, first, newer


def _wait_for(check, s=3.0):
    end = time.time() + s
    while time.time() < end and not check():
        time.sleep(0.01)
    assert check()


def test_a_refusal_whose_read_matches_after_our_own_abandoned_gmail_write_is_done_after_all_with_undo(m, monkeypatch):
    reach, answer, calls, first, newer = _gmail_lapse(m, monkeypatch, commit_first=True)
    real = m.gmail.change

    def first_lands_now(address, uid, fields, etag):
        reach.set()                                      # the earlier write reaches Google first
        _wait_for(lambda: haircut_at(m) == "10:30")
        m.gmail.change = real
        return real(address, uid, fields, etag)
    m.gmail.change = first_lands_now
    m.tap("Approve")
    assert haircut_at(m) == "10:30"
    said = dones(m)
    assert len(said) == 1 and said[0].startswith("Done after all.")
    assert "Your earlier approval's write went through late" in said[0] and "Undo" in m.labels()
    assert state(m, first) == "landed_late" and state(m, newer) == "done"
    answer.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert len(dones(m)) == 1
    m.tap("Undo")
    m.c.tick()
    assert haircut_at(m) == "10:00"


def test_a_refusal_whose_read_matches_after_our_own_abandoned_icloud_write_is_done_after_all_with_undo(m):
    reach, first, newer = _family_lapse(m)

    def first_lands_now():
        reach.set()
        _wait_for(lambda: swim_at(m) == "20261111T220000Z")
    m.icloud.before_write = first_lands_now
    m.tap("Approve")
    assert swim_at(m) == "20261111T220000Z"
    said = dones(m)
    assert len(said) == 1 and said[0].startswith("Done after all.") and "Undo" in m.labels()
    assert state(m, first) == "landed_late"
    m.cc.join_abandoned()
    m.c.tick()
    assert len(dones(m)) == 1


# -- 4. a card offered again keeps the first card's fixed id and version ----------------------------------

def test_the_card_offered_again_carries_the_first_cards_version(m, monkeypatch):
    reach, answer, calls, first, newer = _gmail_lapse(m, monkeypatch)
    assert [b["etag"] for b in m.cc.bound_of(newer)["bound"]] == [b["etag"] for b in m.cc.bound_of(first)["bound"]]
    reach.set()
    m.cc.join_abandoned()


@pytest.mark.parametrize("provider", ["gmail", "family"])
def test_the_first_write_landing_just_after_his_reapproval_is_refused(m, monkeypatch, provider):
    if provider == "gmail":
        reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    else:
        reach, first, newer = _family_lapse(m)
    m.tap("Approve")                                     # his tap on the card offered again: written
    assert len(dones(m)) == 1 and dones(m)[0].startswith("Done.")
    reach.set()                                          # the first write arrives with the first card's version
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert len(dones(m)) == 1
    if provider == "gmail":
        assert haircut_at(m) == "10:30" and calls[0] == '"h"'
    else:
        assert swim_at(m) == "20261111T220000Z"
        assert len([p for p in m.icloud.events if "swim" in p]) == 1


@pytest.mark.parametrize("provider", ["gmail", "family"])
def test_the_first_write_landing_just_before_his_reapproval_takes_the_card_off(m, monkeypatch, provider):
    if provider == "gmail":
        reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    else:
        reach, first, newer = _family_lapse(m)
    card = card_with(m, "Approve")
    reach.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    said = dones(m)
    assert len(said) == 1 and said[0].startswith("Done after all") and "the newer card is off" in said[0]
    assert m.link.cards[card]["rows"] == []
    assert (haircut_at(m) == "10:30") if provider == "gmail" else (swim_at(m) == "20261111T220000Z")


def test_the_first_write_landing_just_before_with_its_answer_lost_is_found_on_his_reapproval(m, monkeypatch):
    reach, answer, calls, first, newer = _gmail_lapse(m, monkeypatch, commit_first=True)
    reach.set()
    _wait_for(lambda: haircut_at(m) == "10:30")         # on Google; its answer hasn't come back
    m.tap("Approve")
    said = dones(m)
    assert len(said) == 1 and said[0].startswith("Done after all.") and "Undo" in m.labels()
    assert len([c for c in calls]) == 1                  # nothing written again
    answer.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert len(dones(m)) == 1 and state(m, first) == "landed_late"


def test_a_family_add_landing_just_before_his_reapproval_is_one_event_and_one_done(m):
    from test_handover_round5 import FAMILY_DENTIST
    reach = threading.Event()
    m.icloud.before_write = lambda: reach.wait(10)
    m.cc.write_timeout_s = 0.05
    first, newer = _lapse(m, "add the dentist at 3 today to family", FAMILY_DENTIST,
                          "The dentist at 3 PM today, on Family.")
    reach.set()
    m.cc.join_abandoned()
    m.tap("Approve") if any(l == "Approve" for l in m.labels()) else None
    m.c.tick()
    m.c.outbox.flush()
    assert len([p for p in m.icloud.events if "/hm-" in p]) == 1
    assert len(dones(m)) == 1


# -- 5. late receipts say whose request, when, how, and how old ------------------------------------------

def test_done_after_all_quotes_the_request_its_day_and_how_it_was_approved(m, monkeypatch):
    reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    reach.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    said = dones(m)[-1]
    assert "Your request: “haircut moved to 10:30 today”, asked Wed Nov 11 at 7:" in said
    assert "It went without a card, from your own fresh message." in said
    assert "days old" not in said


def test_a_late_landing_after_he_declined_the_offer_again_says_so_with_undo_first(m, monkeypatch):
    reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    m.tap("Decline")
    reach.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    said = [t for t in m.seen() if t.startswith("It went through after all, though you declined it")]
    assert said and "Undo comes first" in said[-1]
    card = max(m.link.cards)
    assert [c["label"] for r in m.link.cards[card]["rows"] for c in r["components"]][0] == "Undo"
    m.tap("Undo")
    m.c.tick()
    assert haircut_at(m) == "10:00"


def test_a_late_landing_more_than_a_day_on_says_how_old_the_request_is(m, monkeypatch):
    reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    m.clock.t += timedelta(days=2, hours=1)
    reach.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert "That request is 2 days old." in [t for t in m.seen() if t.startswith("Done after all")][-1]


def test_undo_of_a_late_landing_changed_since_shows_how_it_reads_now(m, monkeypatch):
    reach, _, calls, first, newer = _gmail_lapse(m, monkeypatch)
    reach.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.gmail.events[HAIRCUT].update(start={"dateTime": at(11).isoformat(), "timeZone": TZ},
                                   end={"dateTime": at(11, 30).isoformat(), "timeZone": TZ})
    m.gmail._bump(HAIRCUT)                               # someone moves it again
    m.tap("Undo")
    m.c.tick()
    m.c.outbox.flush()
    assert haircut_at(m) == "11:00"
    said = m.seen()[-1]
    assert said.startswith("Not undone:") and "after it went through late" in said
    assert "It reads now: “Haircut” at 11:00" in said
