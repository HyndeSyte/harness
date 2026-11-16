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


def card_for(m, words, *outputs, **kw):
    out = m.tells(words, *outputs, **kw)
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
    # Eighth round: its version differs from the card's and it isn't part of a series, so the read just
    # before the write calls it changed since the card: nothing is sent, and one fresh card follows.
    assert haircut_at(m) == "10:00" and state(m, pid) == "stale"
    receipt = next(t for t in m.seen() if t.startswith("Not applied."))
    assert "its version on the calendar changed since your card" in receipt and "nothing was sent" in receipt


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
    assert "The event changed since your card" in receipt and "a read just before writing shows" in receipt
    assert "so nothing was sent to the calendar" in receipt
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
    said = [t for t in m.seen() if t.startswith("Applied despite your Decline")]
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


# -- 6. paused writes come back ---------------------------------------------------------------------------

from test_handover_round4 import DENTIST, dentists  # noqa: E402


def _pause(m):
    hold = threading.Event()
    for _ in range(calendar_change.MAX_ABANDONED):
        t = threading.Thread(target=hold.wait, args=(10,), daemon=True)
        t.start()
        m.cc.abandoned.append(t)
    m.tells("add the dentist at 3 today", ask(DENTIST))
    assert not dentists(m) and "writes to your calendars are paused" in m.seen()[-1]
    return hold


def test_the_paused_count_is_only_writes_still_running(m):
    hold = _pause(m)
    assert m.cc.live_abandoned() == calendar_change.MAX_ABANDONED
    hold.set()
    m.cc.join_abandoned()
    assert m.cc.live_abandoned() == 0


def test_once_writes_end_the_paused_change_comes_back_on_a_fresh_card(m):
    hold = _pause(m)
    paused_card = card_with(m, "Approve")
    m.c.tick()
    assert m.link.cards[paused_card]["rows"]                 # still paused: the card stands
    hold.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert "writes to your calendars have resumed, so here it is again" in m.seen()[-1]
    assert m.link.cards[paused_card]["rows"] == []           # the paused card is replaced
    m.tap("Approve")
    assert len(dentists(m)) == 1 and m.seen()[-1].startswith("Done.")


def test_a_restart_on_the_same_ledger_offers_a_paused_change_again(m):
    hold = _pause(m)
    from harness.calendar_change import CalendarChange
    cc = CalendarChange(m.ledger, m.client, m.gmail, enabled=lambda: True, address=lambda: GMAIL, tz=TZ)
    cc.bind(OWNER)
    cc.recard = m.cc.recard                                  # the same runner, as wired at start
    assert cc.live_abandoned() == 0                          # a new instance: none of its own running
    cc.run_pending(paused=False)
    m.c.outbox.flush()
    assert "writes to your calendars have resumed, so here it is again" in m.seen()[-1]
    hold.set()
    m.cc.join_abandoned()
    m.c.tick()
    m.c.outbox.flush()
    assert len([t for t in m.seen() if "have resumed" in t]) == 1    # offered again once


# -- 3. the Turn on record is built from the specialist's own ledger ---------------------------------------

from test_handover_round5 import DROP_SWIM, PASSING  # noqa: E402


def smoke_step(m, run, step):
    """Ninth round: Cain opens one step of the run; only the next handover naming the run is its."""
    out = m.send(Handover(kind="fastpath", state="smoke-step", run=run, step=step))
    assert out["status"] == "ok", out
    return out


def step_card(m, run, step, words, *outputs):
    smoke_step(m, run, step)
    return card_for(m, words, *outputs, smoke_run=run)


def _approve(m, words, output, done="Done.", run="", step="step"):
    if run:
        step_card(m, run, step, words, ask(output))
    else:
        card_for(m, words, ask(output))
    m.tap("Approve")
    m.c.outbox.flush()
    assert m.seen()[-1].startswith(done) or done is None, m.seen()[-1]


def run_smoke(m):
    """The post-install smoke test, every change through the normal card path and his tap."""
    out = m.send(Handover(kind="fastpath", state="smoke-start"))
    assert out["status"] == "ok"
    run = out["run"]
    seed_haircut(m)
    seed_yoga(m)
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    m.icloud.seed(POOL_PATH, pool_ics())
    # Gmail: an add (the run's first: its answer let go, read back a minute on), a move and its Undo, a
    # removal, and a card for an event that changed since it (nothing sent).
    step_card(m, run, "gmail-add", "add the dentist at 3 today", ask(DENTIST))
    m.tap("Approve")
    m.cc.join_abandoned()
    settle(m)
    m.c.outbox.flush()
    assert m.seen()[-1].startswith("Done.") and "Added Smoke test: Dentist" in m.seen()[-1]   # a test event
    _approve(m, "haircut moved to 10:30 today", MOVE_HAIRCUT, run=run, step="gmail-move")
    m.tap("Undo")
    m.c.tick()
    m.c.outbox.flush()
    assert m.seen()[-1].startswith("Undone.")
    _approve(m, "no haircut today", DROP_HAIRCUT, run=run, step="gmail-remove")
    step_card(m, run, "gmail-stale", "yoga at 6:30 today", ask(MOVE_YOGA))
    m.gmail.events[yoga_id(11)]["description"] = "Bring a towel"
    m.gmail._bump(yoga_id(11))
    m.tap("Approve")
    assert any(t.startswith("Not applied.") for t in m.seen())
    # Family: an add, a move and its Undo, a removal, a refused write, and two days of one series.
    _approve(m, "add piano at 1 today to family", change("family", "add", "Piano", dates="",
                                                         start=at(13).isoformat(), end=at(14).isoformat()),
             run=run, step="family-add")
    _approve(m, "swim moved to 5 today", SWIM, run=run, step="family-move")
    m.tap("Undo")
    m.c.tick()
    m.c.outbox.flush()
    assert m.seen()[-1].startswith("Undone.")
    _approve(m, "no swim today", DROP_SWIM, run=run, step="family-remove")
    step_card(m, run, "family-stale", "pool at 5:30 today", ask(MOVE_POOL))
    m.icloud.seed(POOL_PATH, pool_ics(LOCATION="LOCATION:Pool B"))
    m.tap("Approve")
    _approve(m, "no pool next wednesday", change("family", "remove", "Pool", dates="2026-11-18"),
             run=run, step="series-1")
    _approve(m, "no pool on the 25th", change("family", "remove", "Pool", dates="2026-11-25"),
             run=run, step="series-2")
    # Ninth round: each calendar refuses the run's own stale write to its own test event.
    smoke_step(m, run, "conformance-gmail")
    smoke_step(m, run, "conformance-family")
    return run


@pytest.mark.card_only
def test_a_run_with_no_ledger_evidence_is_refused(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    cards = len(m.link.cards)
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "refused" and "No evidence for: gmail.add" in out["said"] and "listing_lag" in out["said"]
    assert len(m.link.cards) == cards and not calendar_change.fast_path_on(m.ledger)


@pytest.mark.card_only
def test_passes_sent_by_cain_are_ignored(m):
    run = m.send(Handover(kind="fastpath", state="smoke-start"))["run"]
    out = m.send(Handover(kind="fastpath", state="on", run=run, record=PASSING))
    assert out["status"] == "refused" and not calendar_change.fast_path_on(m.ledger)
    out = m.send(Handover(kind="fastpath", state="on", record=PASSING))         # no run named at all
    assert out["status"] == "refused" and "Name the smoke run" in out["said"]
    out = m.send(Handover(kind="fastpath", state="on", run="0123456789ab"))     # not the run it issued
    assert out["status"] == "refused" and "no smoke run with that id" in out["said"]


@pytest.mark.card_only
def test_the_card_shows_the_ledgers_evidence_and_every_no_card_path(m):
    run = run_smoke(m)
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "ok", out
    card = next(t for t in reversed(m.seen()) if t.startswith("The check after installing passed."))
    for words in ("Gmail: An add, id ending", "Gmail: A move, id ending", "Gmail: A removal, id ending",
                  "Gmail: An Undo, id ending", "Family: An add, id ending", "Family: An Undo, id ending",
                  "Gmail: A card for an event that changed since it", "Family: A card for an event that changed since it",
                  "so nothing was sent and it was not applied", "Two days of one series on Family, “Pool”",
                  "A write whose answer came late, Gmail", "within 0 seconds", "asked 7:30 AM Wed Nov 11",
                  "Your own newest message, under 2 minutes old", "A date from your mail you tap Add to Family on",
                  "Family calendar adds: none yet"):
        assert words in card, words
    assert {"Turn on", "Keep cards"} <= set(m.labels())
    assert not calendar_change.fast_path_on(m.ledger)


@pytest.mark.card_only
def test_a_stored_bake_in_opt_in_is_named_by_calendar_and_date(m):
    from harness.family_add import LOOSENED
    with m.ledger.tx() as db:
        m.ledger.set_meta(LOOSENED, json.dumps({"policy": "p1"}), db)
        m.ledger.event("family_add_loosened", {"adds": 5}, db=db)
    assert "Family calendar adds: you said to stop checking each one on Wed Nov 11, so they go too." in \
        m.cc._no_card_paths()


@pytest.mark.card_only
def test_turn_on_then_a_turn_off_button_on_the_same_card(m):
    run = run_smoke(m)
    m.send(Handover(kind="fastpath", state="on", run=run))
    card = card_with(m, "Turn on")
    m.tap("Turn on")
    m.c.outbox.flush()
    kept = calendar_change.fast_path(m.ledger)
    assert kept["on"] is True and kept["by"] == str(OWNER) and kept["smoke"]["run"] == run
    shown = [c["label"] for r in m.link.cards[card]["rows"] for c in r["components"]]
    assert "Turn off" in shown and "Turn on" not in shown and "Keep cards" not in shown
    out = m.tells("add the dentist again at 5 today", ask(change("gmail", "add", "Dentist again", dates="",
                                                                start=at(17).isoformat(), end=at(18).isoformat())))
    assert out["status"] == "executed"
    m.tap("Turn off")
    assert not calendar_change.fast_path_on(m.ledger)
    out = m.tells("add the vet at 6 today", ask(change("gmail", "add", "Vet", dates="",
                                                       start=at(18).isoformat(), end=at(19).isoformat())))
    assert out["status"] == "waiting for his tap"


def test_turn_off_sends_a_fast_path_write_in_flight_back_to_a_card(m, monkeypatch):
    real = m.cc.auto_approve

    def then_off(proposal_id, job_id, db):
        real(proposal_id, job_id, db)
        calendar_change.set_fast_path(m.ledger, False, "", by=str(OWNER), db=db)   # his Turn off tap
    monkeypatch.setattr(m.cc, "auto_approve", then_off)
    m.tells("add the dentist at 3 today", ask(DENTIST))
    assert not dentists(m) and "Approve" in m.labels()
    assert any("only once the check after installing has passed" in t for t in m.seen())


@pytest.mark.card_only
def test_a_listing_lag_past_an_hour_is_refused(m):
    run = run_smoke(m)
    row = m.ledger.db.execute("SELECT proposal_id, settle_json FROM calendar_changes WHERE state='done' LIMIT 1").fetchone()
    plan = json.loads(row[1])
    from datetime import datetime
    plan["listed_at"] = (datetime.fromisoformat(plan["listed_at"]) + timedelta(hours=2)).isoformat()
    with m.ledger.tx() as db:
        db.execute("UPDATE calendar_changes SET settle_json=? WHERE proposal_id=?", (json.dumps(plan), row[0]))
    out = m.send(Handover(kind="fastpath", state="on", run=run))
    assert out["status"] == "refused" and "listing_lag: 7200 seconds on" in out["said"]
    assert "is outside 0 to 300" in out["said"]                 # seventh round: bounded at 300 seconds


# -- 7. etags byte for byte, a cancelled event is gone, and the If-Match is logged -------------------------

@pytest.mark.card_only
def test_an_icloud_weak_etag_is_kept_and_sent_byte_for_byte(m, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    m.icloud._etag = lambda ics, n=iter(range(1, 99)): f'W/"weak-{next(n)}"'
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    weak = m.icloud.events[SWIM_PATH][0]
    pid = card_for(m, "no swim today", ask(DROP_SWIM))
    assert [b["etag"] for b in m.cc.bound_of(pid)["bound"]] == [weak]
    m.tap("Approve")
    sent = [h.get("If-Match") for meth, path, h, _ in m.icloud.log if meth == "DELETE" and path == SWIM_PATH]
    assert sent == [weak] and swim_at(m) is None
    assert f"family removal sent with If-Match {weak}: answered ok" in caplog.text


@pytest.mark.card_only
def test_a_google_etag_is_sent_as_given_and_the_answer_is_logged(m, monkeypatch, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="harness.calendar_change")
    seed_haircut(m)
    m.gmail.events[HAIRCUT]["etag"] = 'W/"MTcz"'
    sent = []
    real = m.gmail.change
    monkeypatch.setattr(m.gmail, "change", lambda a, uid, f, etag: sent.append(etag) or real(a, uid, f, etag))
    card_for(m, "haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    m.tap("Approve")
    assert sent == ['W/"MTcz"'] and haircut_at(m) == "10:30"
    assert 'gmail move sent with If-Match W/"MTcz": answered ok' in caplog.text


@pytest.mark.card_only
def test_a_google_event_read_back_cancelled_counts_as_gone_for_a_refused_removal(m, monkeypatch):
    seed_haircut(m)
    card_for(m, "no haircut today", ask(DROP_HAIRCUT))
    real = m.gmail.drop

    def someone_first(address, uid, etag):
        m.gmail.events[HAIRCUT]["status"] = "cancelled"          # taken off elsewhere: Google keeps it, cancelled
        m.gmail._bump(HAIRCUT)
        return real(address, uid, etag)
    monkeypatch.setattr(m.gmail, "drop", someone_first)
    m.tap("Approve")
    receipt = m.seen()[-1]
    assert receipt.startswith("Done.") and "nothing of mine there to undo" in receipt
    assert not any(t.startswith("Not applied.") for t in m.seen())


def test_the_checklist_has_a_refusal_per_calendar_and_two_days_of_one_series():
    assert {"gmail.stale", "family.stale", "series", "late_landing", "listing_lag"} <= set(calendar_change.SMOKE_ITEMS)
