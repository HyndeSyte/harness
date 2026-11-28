"""Round 3 of the second review of PR 73 (Nov 28): the six fixes, each on its own. All names, ids and places are
invented.

1. A copy Harness left alone, named in an ordinary request (move, retime, remove), goes only on a take-back part
   that names what changed and says approving discards it, written with If-Match on exactly the version shown.
2. A create whose answer was lost, found absent, is recorded and left absent; made again only after a known failure.
3. A VTIMEZONE that puts DTSTART or DTEND at another instant than written, or can't be evaluated, is an edit.
4. Google's "not found" never takes a copy off; only a cancelled record in the feed, 410, or cancelled by id does.
   A copy left because its event was purged gets one digest line and a take-it-off card.
5. Every write to a copy is checked after against its Gmail event; a move or a cancel since is queued and worked
   off at the next read (a cancel by the guarded removal), and the cap is said in the digest.
6. The first-day check the other way: one untouched copy created, read back, moved and deleted reads as the App's
   own at each step, and the bodies iCloud returns are kept as fixtures.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from harness import caldav, copy_check, family_copy
from harness.calendar_change import Stopped
from fakes import result
from fake_caldav import FAMILY_PATH, FakeICloud, no_network  # noqa: F401  (autouse)
from test_family_copy_follows import (ALARM, COPY_TITLE, DAY, INSTANCE, ORIGINAL, SERIES, at, copy_path, copy_times,
                                      copy_writes, feed_now, icloud_way, left_why, m, moved_by_hand, row, sync,
                                      with_added)  # noqa: F401
from test_plain_commands import NY, TZ, ask, change

FIXTURES = Path(__file__).parent / "fixtures" / "family_copy_icloud"


def edited_on_family(m, extra=ALARM):
    """Someone adds an alert to the coffee copy on Family; the next read leaves it to them."""
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], extra))
    sync(m)
    assert row(m)["state"] == "hands_off"


def move_gmail(m, start, end, text="move my coffee tomorrow"):
    return m.tells(text, ask(change("gmail", "move", "coffee", dates="2026-11-12", start=start.isoformat(),
                                    end=end.isoformat())))


# -- 1. no bypass for ordinary requests ------------------------------------------------------------------------

def test_1_an_ordinary_move_never_moves_a_copy_left_alone_on_a_plain_card(m):
    sync(m)
    edited_on_family(m)
    out = move_gmail(m, at(15, day=DAY), at(16, day=DAY))
    assert out["status"] == "waiting for his tap"                    # never through without his tap
    card = m.seen()[-1]
    assert "Take back the Family copy of Coffee with Chris (changed on Family: an alert). Approving discards that " \
           "and writes Harness's copy over it at 3:00 to 4:00 tomorrow" in card
    assert "approving discards what is on the Family copy of Coffee with Chris now" in card
    shown = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    assert m.gmail_times(INSTANCE) == ("15:00", "16:00")
    puts = [x for x in copy_writes(m) if x[0] == "PUT"]
    assert puts[-1][2]["If-Match"] == shown                          # exactly the version the card showed
    assert ALARM not in m.icloud.events[copy_path(m)][1] and copy_times(m) == (at(15, day=DAY), at(16, day=DAY))
    assert row(m)["state"] == "live"


def test_1_a_copy_changed_again_after_the_card_is_not_written(m):
    sync(m)
    edited_on_family(m)
    move_gmail(m, at(15, day=DAY), at(16, day=DAY))
    m.icloud.seed(copy_path(m), with_added(m.icloud.events[copy_path(m)][1], "LOCATION:Corner Cafe"))
    before = len(copy_writes(m))
    m.tap("Approve")
    assert len(copy_writes(m)) == before                              # nothing sent over the newer version
    assert "LOCATION:Corner Cafe" in m.icloud.events[copy_path(m)][1] and row(m)["state"] == "hands_off"


def test_1_an_ordinary_removal_takes_a_copy_left_alone_off_only_on_its_take_back_part(m):
    sync(m)
    edited_on_family(m)
    out = m.tells("cancel my coffee tomorrow", ask(change("gmail", "remove", "coffee", dates="2026-11-12")))
    assert out["status"] == "waiting for his tap"
    card = m.seen()[-1]
    assert "Take the Family copy of Coffee with Chris off (changed on Family: an alert). Approving discards it as it " \
           "is now" in card
    shown = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    dels = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert dels and dels[-1][2]["If-Match"] == shown and copy_path(m) not in m.icloud.events


def test_1_nothing_but_a_take_back_writes_to_a_copy_left_alone(m):
    sync(m)
    edited_on_family(m)
    read = m.cc._family_fetch(copy_path(m))
    with pytest.raises(Stopped) as why:
        m.cc._copy_owned(m.key, read, "put", "BEGIN:VCALENDAR", at(15, day=DAY), at(16, day=DAY))
    assert "only a take-back card writes to it" in why.value.words
    with pytest.raises(Stopped):
        m.cc._copy_owned(m.key, read, "delete")
    m.cc._copy_owned(m.key, read, "delete", take_back=read.etag)      # the take-back part's own check passes


# -- 2. an uncertain create -------------------------------------------------------------------------------------

def test_2_a_create_cut_off_before_its_answer_is_settled_by_a_read_and_left_absent(m):
    """Harness stopped after saving the create's record and before its answer: the next read reads its address
    first. Absent: recorded as uncertain and left off, never sent blind."""
    uid = family_copy._uid(m.key)
    family_copy.note_write(m.ledger, m.key, "", landed=False, wrote=(COPY_TITLE, ORIGINAL,
                                                                     ORIGINAL + timedelta(hours=1)),
                           prior_body="", intended="x", op="create", uid=uid)
    sync(m)
    assert not copy_writes(m) and copy_path(m) not in m.icloud.events
    assert row(m)["state"] == "uncertain"
    sync(m)
    assert not copy_writes(m)
    assert "iCloud's answer was lost when I made the Family copy of Coffee Nov 12" in m.copier.digest_line()


def test_2_an_uncertain_create_that_turns_up_as_written_is_followed(m):
    m.icloud.drop_response_next = True             # the create lands, its answer is lost
    real = m.client.fetch
    calls = []

    def fetch(href):                               # and the read again doesn't see it yet
        calls.append(href)
        if len(calls) == 1:
            return caldav.Outcome("gone", 404), ""
        return real(href)
    m.client.fetch = fetch
    sync(m)
    m.client.fetch = real
    assert row(m)["state"] == "uncertain"
    sync(m)
    assert row(m)["state"] == "live" and len([x for x in copy_writes(m) if x[0] == "PUT"]) == 1


# -- 3. time zones ----------------------------------------------------------------------------------------------

VTZ = ("BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\n"
       "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nDTSTART:20070311T020000\r\nTZNAME:EDT\r\nTZOFFSETTO:-0400\r\n"
       "END:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n"
       "DTSTART:20071104T020000\r\nTZNAME:EST\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")
START, END = ORIGINAL, ORIGINAL + timedelta(hours=1)


def zoned(vtz=VTZ):
    body = caldav.build_copy_ics("hx-1", COPY_TITLE, START, END, datetime(2026, 11, 11, tzinfo=timezone.utc))
    local = icloud_way(body)                                         # times in TZID form, as iCloud keeps them
    return local.replace("BEGIN:VEVENT", vtz + "BEGIN:VEVENT", 1)


def test_3_a_time_zone_block_that_keeps_the_same_instants_passes():
    assert caldav.copy_differences(zoned(), "hx-1", COPY_TITLE, START, END) == []


@pytest.mark.parametrize("vtz", [
    VTZ.replace("TZOFFSETTO:-0500", "TZOFFSETTO:-0600"),                         # another instant
    VTZ.replace("BYMONTH=11;BYDAY=1SU", "BYMONTH=11;BYDAY=3SU"),                 # standard time from Nov 15 only
    VTZ.replace("BYDAY=1SU", "BYMONTHDAY=1"),                                    # can't be evaluated here
    VTZ.replace("TZOFFSETTO:-0500\r\n", ""),                                     # no offset at all
    VTZ + VTZ])                                                                  # defined twice
def test_3_a_time_zone_block_that_moves_the_copy_or_cant_be_read_is_an_edit(vtz):
    assert "VTIMEZONE" in caldav.copy_differences(zoned(vtz), "hx-1", COPY_TITLE, START, END)


def test_3_a_block_for_a_zone_the_times_dont_use_is_left_aside():
    other = VTZ.replace("TZID:America/New_York", "TZID:Europe/Paris").replace("TZOFFSETTO:-0500", "TZOFFSETTO:+0100")
    assert caldav.copy_differences(zoned(other), "hx-1", COPY_TITLE, START, END) == []


def test_3_the_sync_leaves_a_copy_whose_zone_was_redefined_and_keeps_one_merely_respelled(m):
    sync(m)
    uid = family_copy._uid(m.key)
    respelled = icloud_way(m.icloud.events[copy_path(m)][1]).replace("BEGIN:VEVENT", VTZ + "BEGIN:VEVENT", 1)
    m.icloud.seed(copy_path(m), respelled)
    sync(m)
    assert row(m)["state"] == "live"
    m.icloud.seed(copy_path(m), respelled.replace("TZOFFSETTO:-0500", "TZOFFSETTO:-0600"))
    sync(m)
    assert row(m)["state"] == "hands_off" and left_why(m) == ["edited"]
    assert caldav.copy_differences(m.icloud.events[copy_path(m)][1], uid, COPY_TITLE, START, END) == ["VTIMEZONE"]


# -- 4. Google deletion -----------------------------------------------------------------------------------------

def purge(m):
    """The day is deleted on Gmail and Google has since purged it: the feed leaves it out, and a read by its id
    answers 404."""
    del m.gmail.events[INSTANCE]


def test_4_a_not_found_answer_never_takes_a_copy_off(m):
    sync(m)
    purge(m)
    for _ in range(family_copy.MISSING_404S + 3):
        sync(m)
    assert copy_path(m) in m.icloud.events and not [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert row(m)["state"] == "live"
    line = m.copier.digest_line()
    assert line.count("Google no longer has the Gmail event of Coffee Nov 12") == 1
    assert "A card asks whether to take it off." in line and "keeps answering" not in line
    assert m.copier.purged_due() == [m.key]


def test_4_the_purged_copys_card_takes_it_off_only_on_his_tap(m):
    sync(m)
    purge(m)
    for _ in range(family_copy.MISSING_404S + 1):
        sync(m)
    m.c.family_copy = m.copier
    assert m.c._purged_copy_cards() == 1 and m.copier.purged_due() == []
    m.c.tick()                                                         # the card goes out
    card = m.seen()[-1]
    assert "Google no longer has the Gmail event this copies" in card and copy_path(m) in m.icloud.events
    assert "is no longer known to Google" in card
    shown = m.icloud.events[copy_path(m)][0]
    m.tap("Approve")
    dels = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert dels and dels[-1][2]["If-Match"] == shown and copy_path(m) not in m.icloud.events


@pytest.mark.parametrize("how", ["cancelled", "410"])
def test_4_a_cancelled_or_410_answer_by_id_takes_the_copy_off_guarded(m, how):
    sync(m)
    if how == "cancelled":
        m.gmail.events[INSTANCE]["status"] = "cancelled"
    else:
        m.gmail.gone_410 = {INSTANCE}
        m.feeds.window.occurrences = []
    for _ in range(family_copy.READS_BEFORE_REMOVING):
        if how == "cancelled":
            sync(m)
        else:
            m.feeds.generation += 1
            m.copier._sync()
    dels = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert dels and dels[-1][2].get("If-Match") and copy_path(m) not in m.icloud.events
    assert row(m)["state"] == "cancelled"


def test_4_a_cancelled_record_in_the_feed_is_evidence_enough(m):
    sync(m)
    m.gmail.look_by_id = lambda address, uid: ("unknown", None)        # Google can't be asked
    feed_now(m)
    m.feeds.window.occurrences = []
    m.feeds.window.cancelled = {(f"{SERIES}@google.com", INSTANCE.rsplit("_", 1)[1])}
    for _ in range(family_copy.READS_BEFORE_REMOVING):
        m.feeds.generation += 1
        m.copier._sync()
    assert copy_path(m) not in m.icloud.events and row(m)["state"] == "cancelled"


def test_4_an_event_merely_left_out_with_google_unreadable_stays(m):
    sync(m)
    m.gmail.look_by_id = lambda address, uid: ("unknown", None)
    m.feeds.window.occurrences = []
    for _ in range(family_copy.READS_BEFORE_REMOVING + 2):
        m.feeds.generation += 1
        m.copier._sync()
    assert copy_path(m) in m.icloud.events and row(m)["state"] == "live"


def test_4_the_google_window_keeps_its_cancelled_records():
    from harness import google_cal
    w = google_cal.ical.Window("a@gmail.com")
    google_cal._cancelled_into(w, {"iCalUID": f"{SERIES}@google.com", "status": "cancelled", "recurringEventId": SERIES,
                                   "originalStartTime": {"dateTime": ORIGINAL.isoformat()}})
    assert w.cancelled == {(f"{SERIES}@google.com", INSTANCE.rsplit("_", 1)[1])}


def test_4_an_ical_feed_keeps_its_cancelled_records():
    from harness import ical
    feed = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x1@google.com\r\nDTSTART:20261112T140000Z\r\n"
            "DTEND:20261112T150000Z\r\nSUMMARY:Coffee\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    w = ical.window(feed, start=datetime(2026, 11, 11, tzinfo=timezone.utc),
                    end=datetime(2026, 11, 14, tzinfo=timezone.utc), tz=TZ, fallback_name="a@gmail.com")
    assert not w.occurrences and w.cancelled == {("x1@google.com", "")}


# -- 5. verify after every write --------------------------------------------------------------------------------

def test_5_a_cancel_while_the_copy_was_written_is_queued_and_takes_the_guarded_removal(m):
    sync(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))

    def cancel():
        m.gmail.events[INSTANCE]["status"] = "cancelled"
    m.icloud.before_write = cancel
    sync(m)
    assert family_copy.queued(m.ledger, m.key)["op"] == "cancel"
    m.ledger.db.execute("SELECT 1")                                   # the queue is in the records (durable)
    assert m.ledger.get_meta(family_copy.RECONCILE + m.key)
    sync(m)
    dels = [x for x in copy_writes(m) if x[0] == "DELETE"]
    assert dels and dels[-1][2].get("If-Match") and copy_path(m) not in m.icloud.events
    assert row(m)["state"] == "cancelled" and family_copy.queued(m.ledger, m.key) is None


def test_5_the_correction_is_checked_too_and_requeued_when_the_event_moves_again(m):
    sync(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    assert family_copy.queued(m.ledger, m.key)["op"] == "move"
    m.icloud.before_write = lambda: moved_by_hand(m, at(18, day=DAY), at(19, day=DAY))    # moves during the fix
    sync(m)
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY))
    assert family_copy.queued(m.ledger, m.key)["op"] == "move"
    sync(m)
    assert copy_times(m) == (at(18, day=DAY), at(19, day=DAY)) and family_copy.queued(m.ledger, m.key) is None


def test_5_the_check_is_saved_before_the_write_so_a_write_cut_off_is_still_checked(m):
    sync(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    seen = {}

    def peek():
        seen["q"] = family_copy.queued(m.ledger, m.key)
    m.icloud.before_write = peek
    sync(m)
    assert seen["q"] and seen["q"]["op"] == "check"


def test_5_at_the_cap_it_is_said_in_the_digest(m):
    sync(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.before_write = lambda: moved_by_hand(m, at(16, day=DAY), at(17, day=DAY))
    sync(m)
    m.gmail.look_by_id = lambda address, uid: ("unknown", None)       # can't be read again, read after read
    for _ in range(family_copy.RECONCILE_TRIES + 1):
        feed_now(m)
        m.copier._sync()
    assert family_copy.queued(m.ledger, m.key) is None
    assert "kept moving, or couldn't be read again, each time I wrote its Family copy, so I stopped after 3 " \
           "tries" in m.copier.digest_line()


def test_5_a_cards_write_to_a_copy_is_checked_at_the_next_read(m):
    sync(m)
    move_gmail(m, at(15, day=DAY), at(16, day=DAY))
    assert family_copy.queued(m.ledger, m.key) is not None
    sync(m)
    assert family_copy.queued(m.ledger, m.key) is None and copy_times(m) == (at(15, day=DAY), at(16, day=DAY))


# -- 6. the first-day check the other way -----------------------------------------------------------------------

class IcloudWay(FakeICloud):
    """The fake iCloud keeping each copy as the repo models iCloud keeping one (icloud_way)."""

    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
        if method == "PUT" and body:
            body = icloud_way(body.decode()).encode()
        return super().request(method, url, headers=headers, json_body=json_body, body=body, timeout=timeout)


def checker(icloud):
    from fake_caldav import APP_PASSWORD, APPLE_ID, FAMILY_URL
    return caldav.FamilyCalDav(icloud, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL))


def test_6_an_untouched_copy_reads_as_the_apps_own_at_each_step_and_is_kept_as_fixtures(tmp_path):
    out = tmp_path / "check"
    got = copy_check.run(checker(IcloudWay()), str(out), datetime(2026, 11, 11, 15, tzinfo=timezone.utc), TZ)
    assert got["all_ok"], got["steps"]
    assert [s["step"] for s in got["steps"]] == ["create", "created read back", "move", "moved read back", "delete",
                                                 "deleted read back"]
    assert (out / "created.ics").read_text().count("TZID=") and (out / "moved.ics").exists()
    assert json.loads((out / "summary.json").read_text())["all_ok"] is True


def test_6_a_step_that_doesnt_read_as_the_apps_own_fails_the_check_and_still_cleans_up(tmp_path):
    class AddsAnAlert(FakeICloud):
        def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
            if method == "PUT" and body:
                body = body.decode().replace("END:VEVENT", ALARM + "\r\nEND:VEVENT", 1).encode()
            return super().request(method, url, headers=headers, json_body=json_body, body=body, timeout=timeout)
    icloud = AddsAnAlert()
    got = copy_check.run(checker(icloud), str(tmp_path), datetime(2026, 11, 11, 15, tzinfo=timezone.utc), TZ)
    assert not got["all_ok"]
    assert got["steps"][1] == {"step": "created read back", "ok": False, "differs": ["VALARM"]}
    assert not icloud.family()                                         # its throwaway copy taken off


def fixture_sets():
    return sorted(p for p in FIXTURES.glob("*/summary.json")) if FIXTURES.exists() else []


@pytest.mark.parametrize("summary", fixture_sets(), ids=lambda p: p.parent.name)
def test_6_every_kept_body_reads_as_the_apps_own(summary):
    """Every body kept from a run of the check (tests/fixtures/family_copy_icloud/<set>/): the modelled set now,
    and the bodies from the real Family calendar once a run's are copied in (DOCS 3e)."""
    s = json.loads(summary.read_text())
    for name in ("created", "moved"):
        body = (summary.parent / f"{name}.ics").read_text()
        start, end = (datetime.fromisoformat(s[name][k]) for k in ("start", "end"))
        assert caldav.copy_differences(body, s["uid"], s["title"], start, end) == [], name


def test_6_there_is_a_kept_set_to_judge():
    assert fixture_sets(), "tests/fixtures/family_copy_icloud/ holds no set"
