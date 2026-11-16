"""0.24.0, fifth round: what the fourth outside review of the handover fixes asked for (Nov 16).

Each must-fix on its own, against the fake calendars and a fake Discord: every no-card path behind
the one flag, provider-side fencing of moves and removals, a bounded write lifetime with follow-up
reads after a lapse, not seen yet instead of not done, the flag turned on only by a passing record
and his tap, migration reporting, supersede edges, and the owner's time zone for open days. All
names and ids invented.
"""
import json

import pytest

from harness import calendar_change
from test_family_add import (ask_cards, count_up, fresh, loose, on, rig, STOP)  # noqa: F401  (fixtures)


# -- 1. every no-card path behind the flag ---------------------------------------------------------

@pytest.mark.card_only
def test_the_bake_in_opt_in_is_a_normal_card_while_the_flag_is_off(loose):
    """His tap on the bake-in card is already in the ledger, and the smoke test's flag isn't on: an
    add comes on a card and nothing is written."""
    assert loose.fa.loosened() and not loose.fa.tapless()
    assert calendar_change.fast_path(loose.ledger) == {}
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods()
    assert "Add to the Family calendar?" in loose.last()[1]
    assert "each needs your tap until" in loose.fa.status_line()


def test_the_bake_in_opt_in_is_checked_against_the_flag_at_write_time(loose, monkeypatch):
    """On when the add was offered, turned off before its write: it comes back as a card."""
    real = loose.fa.auto_approve

    def then_off(proposal_id, job_id, db):
        took = real(proposal_id, job_id, db)
        if took:
            loose.ledger.set_meta(calendar_change.FAST_PATH, json.dumps({"on": False}), db)
        return took
    monkeypatch.setattr(loose.fa, "auto_approve", then_off)
    loose.ask(**fresh())
    assert "PUT" not in loose.icloud.methods()
    assert any("the Approve tap came back before I added it" in t for t in loose.texts())


def test_the_bake_in_opt_in_goes_without_a_tap_once_the_flag_is_on(loose):
    calendar_change.set_fast_path(loose.ledger, True, "passed")
    assert loose.fa.tapless()
    loose.ask(**fresh())
    assert "PUT" in loose.icloud.methods()


# -- 2. provider-side fencing for moves and removals -----------------------------------------------

import threading  # noqa: E402
from datetime import timedelta  # noqa: E402

from test_discord_keeper import OWNER  # noqa: E402
from test_plain_commands import (FAMILY_PATH, GMAIL, TZ, Morning, at, ask, change,  # noqa: E402,F401
                                 nothing_he_shouldnt_see, plain_prompt)  # noqa: F401  (autouse)
from test_handover_round4 import _lapse_and_reoffer, rows  # noqa: E402


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


HAIRCUT = "haircut1"
MOVE_HAIRCUT = change("gmail", "move", "Haircut", start=at(10, 30).isoformat(), end=at(11).isoformat())
DROP_HAIRCUT = change("gmail", "remove", "Haircut")
SWIM_PATH = FAMILY_PATH + "swim-1111.ics"
MOVE_SWIM = change("family", "move", "Swim", start=at(17).isoformat(), end=at(18).isoformat())
DROP_SWIM = change("family", "remove", "Swim")


def seed_haircut(m):
    m.gmail.events[HAIRCUT] = {"id": HAIRCUT, "summary": "Haircut", "status": "confirmed", "etag": '"h"',
                               "organizer": {"email": GMAIL, "self": True},
                               "start": {"dateTime": at(10).isoformat(), "timeZone": TZ},
                               "end": {"dateTime": at(10, 30).isoformat(), "timeZone": TZ}}


def correct_haircut(m, hour, minute=0):
    """Someone's correction lands on Google first: another time, a new version."""
    m.gmail.events[HAIRCUT].update(start={"dateTime": at(hour, minute).isoformat(), "timeZone": TZ},
                                   end={"dateTime": (at(hour, minute) + timedelta(minutes=30)).isoformat(),
                                        "timeZone": TZ})
    m.gmail._bump(HAIRCUT)


def haircut_at(m):
    e = m.gmail.events[HAIRCUT]
    if e.get("status") == "cancelled":
        return None
    from datetime import datetime
    from test_plain_commands import NY
    return datetime.fromisoformat(e["start"]["dateTime"]).astimezone(NY).strftime("%H:%M")


def swim_ics(start_utc: str, end_utc: str) -> str:
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:swim-1111",
                        "DTSTAMP:20261101T120000Z", f"DTSTART:{start_utc}", f"DTEND:{end_utc}",
                        "SUMMARY:Swim", "END:VEVENT", "END:VCALENDAR", ""])


def swim_at(m):
    import re
    cur = m.icloud.events.get(SWIM_PATH)
    return re.search(r"DTSTART:(\S+)", cur[1]).group(1) if cur else None


def hang_gmail(m, monkeypatch, name):
    """The first Gmail change or drop of the haircut waits, before it reaches Google, until released:
    it carries the version it was sent with, and Google checks that version when it arrives."""
    real = getattr(m.gmail, name)
    gate, calls = threading.Event(), []

    def slow(address, uid, *rest):
        calls.append(rest[-1])                       # the If-Match it carries
        if uid == HAIRCUT and len(calls) == 1:
            gate.wait(10)
        return real(address, uid, *rest)
    monkeypatch.setattr(m.gmail, name, slow)
    m.cc.write_timeout_s = 0.05
    return gate, calls


def hang_icloud(m):
    """The next write to iCloud waits, before iCloud checks its version, until released."""
    gate = threading.Event()
    m.icloud.before_write = lambda: gate.wait(10)
    m.cc.write_timeout_s = 0.05
    return gate


def settle(m, minutes=1, ticks=3):
    m.clock.t += timedelta(minutes=minutes)
    for _ in range(ticks):
        m.c.tick()


@pytest.mark.card_only
def test_the_card_keeps_the_events_version_and_a_tap_after_a_correction_is_refused_by_google(m, monkeypatch):
    seed_haircut(m)
    sent = []
    real = m.gmail.change
    monkeypatch.setattr(m.gmail, "change", lambda a, uid, f, etag: sent.append(etag) or real(a, uid, f, etag))
    out = m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    assert out["status"] == "waiting for his tap"
    pid = m.ledger.db.execute("SELECT id FROM proposals ORDER BY created_at DESC LIMIT 1").fetchone()[0]
    assert [b["etag"] for b in m.cc.bound_of(pid)["bound"]] == ['"h"']
    correct_haircut(m, 9, 30)                        # a correction lands before his tap
    m.tap("Approve")
    assert sent == ['"h"'] and haircut_at(m) == "09:30"       # sent with the card's version, refused
    receipt = m.seen()[-1]
    assert receipt.startswith("Not confirmed.") and "Someone changed that event since" in receipt
    assert "a read of it by its id shows “Haircut” at 9:30" in receipt
    assert rows(m)[-1]["state"] == "unverified" and "Undo" not in m.labels()


@pytest.mark.card_only
def test_a_refusal_whose_read_shows_the_change_as_asked_is_done_with_nothing_to_undo(m, monkeypatch):
    seed_haircut(m)
    m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    real = m.gmail.change

    def someone_first(address, uid, fields, etag):
        # someone else puts it at 10:30 just before our write arrives: a new version
        m.gmail.events[HAIRCUT].update(start={"dateTime": at(10, 30).isoformat(), "timeZone": TZ},
                                       end={"dateTime": at(11).isoformat(), "timeZone": TZ})
        m.gmail._bump(HAIRCUT)
        return real(address, uid, fields, etag)
    monkeypatch.setattr(m.gmail, "change", someone_first)
    m.tap("Approve")
    receipt = m.seen()[-1]
    assert haircut_at(m) == "10:30" and receipt.startswith("Done.")
    assert "shows it already as asked, so there's nothing of mine there to undo" in receipt
    assert "Undo" not in m.labels() and rows(m)[-1]["state"] == "done"


def test_a_stale_gmail_move_landing_after_a_correction_is_refused(m, monkeypatch):
    seed_haircut(m)
    gate, calls = hang_gmail(m, monkeypatch, "change")
    m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    assert rows(m)[-1]["state"] == "settling"        # abandoned at its deadline
    correct_haircut(m, 9, 30)                        # the correction lands while it's in flight
    gate.set()
    m.cc.join_abandoned()
    assert haircut_at(m) == "09:30"                  # Google refused the stale version
    settle(m)
    assert haircut_at(m) == "09:30" and len(calls) == 1
    assert "it was changed on the calendar since, so I left it as it is" in m.seen()[-1]


def test_a_stale_gmail_move_landing_after_undo_is_refused(m, monkeypatch):
    seed_haircut(m)
    gate, calls = hang_gmail(m, monkeypatch, "change")
    m.tells("haircut moved to 10:30 today", ask(MOVE_HAIRCUT))
    settle(m)                                        # read: not landed, so written once more
    assert haircut_at(m) == "10:30" and m.seen()[-1].startswith("Done.")
    m.tap("Undo")
    m.c.tick()
    assert haircut_at(m) == "10:00"
    gate.set()                                       # the first write reaches Google at last
    m.cc.join_abandoned()
    m.c.tick()
    assert haircut_at(m) == "10:00" and calls[0] == '"h"'


def test_a_stale_gmail_removal_landing_after_a_correction_is_refused(m, monkeypatch):
    seed_haircut(m)
    gate, calls = hang_gmail(m, monkeypatch, "drop")
    m.tells("no haircut today", ask(DROP_HAIRCUT))
    correct_haircut(m, 9, 30)
    gate.set()
    m.cc.join_abandoned()
    assert haircut_at(m) == "09:30"
    settle(m)
    assert haircut_at(m) == "09:30"


def test_a_stale_gmail_removal_landing_after_undo_is_refused(m, monkeypatch):
    seed_haircut(m)
    gate, calls = hang_gmail(m, monkeypatch, "drop")
    m.tells("no haircut today", ask(DROP_HAIRCUT))
    settle(m)
    assert haircut_at(m) is None and m.seen()[-1].startswith("Done.")
    m.tap("Undo")
    m.c.tick()
    assert haircut_at(m) == "10:00"
    gate.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert haircut_at(m) == "10:00"


def test_a_stale_icloud_move_landing_after_a_correction_is_refused(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    gate = hang_icloud(m)
    m.tells("swim moved to 5 today", ask(MOVE_SWIM))
    assert rows(m)[-1]["state"] == "settling"
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T200000Z", "20261111T210000Z"))   # the correction
    gate.set()
    m.cc.join_abandoned()
    assert swim_at(m) == "20261111T200000Z"
    settle(m)
    assert swim_at(m) == "20261111T200000Z"
    assert "it was changed on the calendar since, so I left it as it is" in m.seen()[-1]


def test_a_stale_icloud_removal_landing_after_undo_is_refused(m):
    m.icloud.seed(SWIM_PATH, swim_ics("20261111T210000Z", "20261111T220000Z"))
    gate = hang_icloud(m)
    m.tells("no swim today", ask(DROP_SWIM))
    settle(m)                                        # read: still there, so removed once more
    assert swim_at(m) is None and m.seen()[-1].startswith("Done.")
    m.tap("Undo")
    m.c.tick()
    assert swim_at(m) == "20261111T210000Z"
    gate.set()                                       # the first delete reaches iCloud at last
    m.cc.join_abandoned()
    m.c.tick()
    assert swim_at(m) == "20261111T210000Z"


def test_a_late_gmail_add_whose_id_holds_other_content_is_not_done_after_all(m, monkeypatch):
    gate, calls, first, newer = _lapse_and_reoffer(m, monkeypatch)
    m.gmail.events[calls[0]] = {"id": calls[0], "summary": "Someone else's", "status": "confirmed", "etag": '"x"',
                                "start": {"dateTime": at(9).isoformat(), "timeZone": TZ},
                                "end": {"dateTime": at(10).isoformat(), "timeZone": TZ}}
    gate.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert not any(t.startswith("Done after all") for t in m.seen())
    assert m.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (newer,)).fetchone()[0] == "proposed"


FAMILY_DENTIST = change("family", "add", "Dentist", dates="", start=at(15).isoformat(), end=at(16).isoformat())


def _family_lapse(m):
    gate = hang_icloud(m)
    mid = m.he_says("add the dentist at 3 today to family")
    m.claude.script = [ask(FAMILY_DENTIST)]
    m.handover(paired=OWNER, message=mid)
    first = rows(m)[-1]["proposal_id"]
    m.clock.t += timedelta(minutes=3)
    m.claude.script = [ask(FAMILY_DENTIST)]
    m.handover(paired=OWNER, message=mid, suggestion="The dentist at 3 PM today, on Family.")
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()[0] == "lapsed"
    return gate, first, m.ledger.get_meta(f"calendar_change_reoffer:{first}")


def test_a_late_icloud_add_refused_for_an_address_holding_other_content_is_never_taken_for_ours(m):
    gate, first, newer = _family_lapse(m)
    href = [p for p in m.icloud.events if "/hm-" in p]
    assert not href                                  # the hung write hasn't reached iCloud
    uid = m.cc._uid(f"{first}:0", "hm-")
    other = m.client.href_for(uid)
    from urllib.parse import urlsplit
    m.icloud.seed(urlsplit(other).path, swim_ics("20261111T140000Z", "20261111T150000Z").replace(
        "UID:swim-1111", f"UID:{uid}").replace("SUMMARY:Swim", "SUMMARY:Not ours"))
    gate.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert not any(t.startswith("Done after all") for t in m.seen())
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?", (first,)).fetchone()[0] == "lapsed"


def test_a_late_icloud_add_refused_because_the_newer_card_wrote_it_reads_as_there(m):
    gate, first, newer = _family_lapse(m)
    m.tap("Approve")                                 # the card offered again: written now, same address
    assert m.seen()[-1].startswith("Done.")
    gate.set()
    m.cc.join_abandoned()
    m.c.tick()
    assert m.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?",
                               (first,)).fetchone()[0] == "landed_late"
    assert len([p for p in m.icloud.events if "/hm-" in p]) == 1
