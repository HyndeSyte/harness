"""Nov 27: a Family copy that followed his own move of one day of a repeating event, then stayed behind
when Harness moved that day on his card, and every request to fix it came back "Change the event on
Gmail". Massage with a street address, added by Harness, never got its copy, and there was no drive
time. These replay it and check each fix on its own. All names, ids and places are invented.
"""
import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from harness import caldav, drive_cards, family_copy, google_cal, ical
from harness.family_copy import FamilyCopy, plan, word_for
from harness.family_gmail import own_dry_run_from_options
from harness.ledger import iso
from fake_caldav import FAMILY_PATH, no_network  # noqa: F401  (autouse)
from fakes import result
from test_family_add import on, rig  # noqa: F401
from test_family_gmail import g  # noqa: F401
from test_meaning_live import CLINIC, M, PARK, blocks, drives, go, live, mine, quiet_family  # noqa: F401
from test_family_copy import Feeds, when
from test_plain_commands import GMAIL, NY, TZ, Morning, ask, at, change, plain_prompt  # noqa: F401

SERIES = "s0ai2c7kb1mbia2n4mdl3e6p10"                   # invented, shaped like Google's
DAY = 12                                                 # tomorrow in the rig (Thu Nov 12)
ORIGINAL = at(8, 30, day=DAY)                            # the day's place in the series
INSTANCE = f"{SERIES}_{ORIGINAL.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
SOURCE_TITLE = "Coffee with Chris"
COPY_TITLE = "Alex - Coffee"


@pytest.fixture
def m(ledger, tmp_path, clock):
    m = Morning(ledger, tmp_path, clock)
    m.gmail.events[INSTANCE] = {
        "id": INSTANCE, "iCalUID": f"{SERIES}@google.com", "etag": '"c1"', "status": "confirmed",
        "summary": SOURCE_TITLE, "organizer": {"email": GMAIL, "self": True}, "recurringEventId": SERIES,
        "originalStartTime": {"dateTime": ORIGINAL.isoformat(), "timeZone": TZ},
        "start": {"dateTime": ORIGINAL.isoformat(), "timeZone": TZ},
        "end": {"dateTime": (ORIGINAL + timedelta(hours=1)).isoformat(), "timeZone": TZ}}
    m.feeds = Feeds()
    m.feeds.window.calendar = GMAIL
    m.copier = FamilyCopy(ledger, m.fa, m.feeds, name_fn=lambda: "Alex", tz=TZ)
    m.key = family_copy._key(google_cal._occurrence(m.gmail.events[INSTANCE], GMAIL, ""))
    return m


def sync(m):
    """One read of his Gmail calendar (through Google, as the App reads it), and the copy's sync on it."""
    events = [{"iCalUID": f"{e['id']}@google.com", **e} for e in m.gmail.events.values()
              if e.get("status") != "cancelled"]
    m.feeds.window.occurrences = [o for o in (google_cal._occurrence(e, GMAIL, "") for e in events) if o is not None]
    m.feeds.generation += 1
    m.copier._sync()


def moved_by_hand(m, start, end):
    """He drags that day on Google Calendar: same id, same original start, new times."""
    e = m.gmail.events[INSTANCE]
    e["start"] = {"dateTime": start.isoformat(), "timeZone": TZ}
    e["end"] = {"dateTime": end.isoformat(), "timeZone": TZ}
    e["etag"] = f'"c{int(e["etag"].strip(chr(34))[1:]) + 1}"'


def copy_path(m):
    return FAMILY_PATH + family_copy._uid(m.key) + ".ics"


def copy_times(m):
    ics = m.icloud.events[copy_path(m)][1]
    fmt = "%Y%m%dT%H%M%SZ"
    return tuple(datetime.strptime(re.search(rf"{k}[^:]*:(\S+)", ics).group(1), fmt).replace(tzinfo=timezone.utc)
                 .astimezone(NY) for k in ("DTSTART", "DTEND"))


def row(m):
    return m.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (m.key,)).fetchone()


def at_coffee_time(m):
    """He has his coffee copy on Family, at the day's first time, as the sync made it."""
    sync(m)
    assert copy_times(m) == (ORIGINAL, ORIGINAL + timedelta(hours=1))


# -- 1. the Nov 27 sequence ------------------------------------------------------------------------

def test_a_repeating_day_moved_by_hand_then_moved_by_harness_moves_its_copy_both_times(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    sync(m)
    assert copy_times(m) == (at(13, 45, day=DAY), at(14, 45, day=DAY))       # followed him
    out = m.tells("coffee tomorrow at 2:15", ask(change("gmail", "move", "coffee", dates="2026-11-12",
                                                        start=at(14, 15, day=DAY).isoformat(),
                                                        end=at(15, 15, day=DAY).isoformat())))
    assert out["status"] == "executed"
    assert m.gmail_times(INSTANCE) == ("14:15", "15:15")
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY))       # moved with it
    # iCloud then hands back the copy as it was before Harness's own write (a lost write, or a read from
    # before it): that's Harness's own time on it, not anyone's edit. It used to be left alone for good.
    before = caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(13, 45, day=DAY), at(14, 45, day=DAY),
                                   m.clock())
    m.icloud.seed(copy_path(m), before)
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY))       # brought to its event
    assert row(m)["state"] == "live"
    sync(m)
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 15, day=DAY)) and row(m)["state"] == "live"


def test_a_copy_someone_moved_to_a_time_harness_never_wrote_stays_theirs(m):
    at_coffee_time(m)
    moved_by_hand(m, at(13, 45, day=DAY), at(14, 45, day=DAY))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(16, day=DAY),
                                                      at(17, day=DAY), m.clock()))
    sync(m)
    assert copy_times(m) == (at(16, day=DAY), at(17, day=DAY)) and row(m)["state"] == "hands_off"


# -- 2. found by its event's own identity ------------------------------------------------------------

def test_the_copys_event_is_kept_by_series_and_original_start(m):
    at_coffee_time(m)
    assert family_copy.source_of(m.ledger, m.key) == (f"{SERIES}@google.com",
                                                      f"{ORIGINAL.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}")
    assert family_copy.google_id(*family_copy.source_of(m.ledger, m.key)) == INSTANCE


def test_a_copy_is_found_by_series_and_original_start_after_its_day_moved(m):
    """The day moved to the next day: the copy's day has no such event, and the request still finds it by the
    series and the day's original start, and brings the copy to it (never "I can't find that day")."""
    at_coffee_time(m)
    with m.ledger.tx() as db:                          # left alone, as the copy was on Nov 27
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    moved_by_hand(m, at(14, 15, day=DAY + 1), at(15, 15, day=DAY + 1))
    out = m.tells("the family copy of my coffee is wrong", result({"type": "answer", "text": "I see."}))
    said = " ".join(m.seen()) + out.get("said", "")
    assert "Change the event on Gmail" not in said and "can't find" not in said
    assert "Family copy of Coffee with Chris" in said
    if out["status"] != "executed":
        m.tap("Approve")
    assert copy_times(m) == (at(14, 15, day=DAY + 1), at(15, 15, day=DAY + 1))
    assert m.gmail_times(INSTANCE) == ("14:15", "15:15")                       # Gmail isn't written
    assert row(m)["state"] == "live"


# -- 3. a fix-the-copy request is a card -----------------------------------------------------------

def test_a_question_about_the_copy_with_cains_note_makes_a_card_never_change_it_on_gmail(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 45, day=DAY))
    with m.ledger.tx() as db:                          # the copy left behind, as on Nov 27
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    out = m.tells("why is the family mirrored event not updating",
                  result({"type": "no_action", "reason": "he asked a question"}),
                  suggestion="Fix the Family copy of his coffee tomorrow: Gmail has it at 2:15 PM.")
    assert out["status"] == "waiting for his tap", out
    text = m.seen()[-1]
    assert "Move the Family copy of Coffee with Chris to 2:15 to 3:45 tomorrow, to match your Gmail calendar" \
        in text
    assert "Cain" in text                                                     # marked as from his note
    assert "Change the event on Gmail" not in " ".join(m.seen())
    m.tap("Approve")
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 45, day=DAY))
    assert m.gmail_times(INSTANCE) == ("14:15", "15:45") and row(m)["state"] == "live"


def test_a_copy_whose_event_is_really_gone_is_offered_off(m):
    at_coffee_time(m)
    m.gmail.events[INSTANCE]["status"] = "cancelled"
    out = m.tells("the family copy of my coffee is stale", result({"type": "answer", "text": "Hm."}))
    if out["status"] != "executed":
        m.tap("Approve")
    assert copy_path(m) not in m.icloud.events


def test_nothing_out_of_step_is_said_plainly(m):
    at_coffee_time(m)
    out = m.tells("is the family copy of my coffee wrong?", result({"type": "answer", "text": "No idea."}))
    assert "Every Family copy of your Gmail events matches its event now" in out["said"]


# -- 4. his own appointments, Harness's adds included ---------------------------------------------

def test_an_appointment_harness_added_gets_its_family_copy_but_its_blocks_dont():
    start = datetime(2026, 11, 27, 14, tzinfo=NY)

    def made(uid, title, organizer="harness@example-project.iam.gserviceaccount.com"):
        return ical.Occurrence(start, start + timedelta(hours=1), False, title, GMAIL, False, uid, "", (),
                               "12 Main St, Town, VA", organizer)
    massage = made("cm" + "a" * 32 + "@google.com", "Massage with Braden")
    errand = made("cm" + "b" * 32 + "@google.com", "Pick up the glasses")
    drive_block = made("hb" + "c" * 32 + "@google.com", "Busy (drive there)")
    busy = made("cm" + "d" * 32 + "@google.com", "Busy (hold)")
    assert word_for(massage) == "Massage" and word_for(errand) == "Appointment"
    assert word_for(drive_block) is None and word_for(busy) is None
    wants = plan([massage, errand, drive_block, busy], "Alex", TZ)
    assert sorted(w.title for w in wants.values()) == ["Alex - Appointment", "Alex - Massage"]
    # Someone else's invitation is still never copied, and his own massage is, by its word.
    assert word_for(made("x1", "Massage", organizer="someone@example.com")) is None
    assert word_for(made("x2", "Massage", organizer=GMAIL)) == "Massage"


def test_the_massage_harness_added_lands_on_family(m):
    out = m.tells("book a massage with Braden tomorrow at 2", ask(
        {**change("gmail", "add", "Massage with Braden", dates="", start=at(14, day=DAY).isoformat(),
                  end=at(15, day=DAY).isoformat()), "location": "12 Main St, Town, VA"}))
    if out["status"] != "executed":
        m.tap("Approve")
    added = [e for e in m.gmail.events.values() if e.get("summary") == "Massage with Braden"]
    assert added and added[0]["id"].startswith("cm")
    added[0]["organizer"] = {"email": "harness@example-project.iam.gserviceaccount.com"}   # as the key wrote it
    sync(m)
    copies = [v[1] for v in m.icloud.family().values() if "SUMMARY:Alex - Massage" in v[1]]
    assert len(copies) == 1


# -- 6. his own fix on Nov 27 stays --------------------------------------------------------------

def test_the_first_sync_leaves_a_copy_that_already_matches_its_event_alone(m):
    """He fixed the copy by hand (2:15 to 3:45 PM) to match Gmail: no write, and it stays where he put it."""
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 45, day=DAY))
    mine_ = caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(14, 15, day=DAY), at(15, 45, day=DAY),
                                  m.clock())
    m.icloud.seed(copy_path(m), mine_)
    etag = m.icloud.events[copy_path(m)][0]
    sync(m)
    assert m.icloud.events[copy_path(m)][0] == etag                          # not written
    assert copy_times(m) == (at(14, 15, day=DAY), at(15, 45, day=DAY)) and row(m)["state"] == "live"


def test_a_hand_fixed_copy_left_alone_stays_as_he_left_it(m):
    at_coffee_time(m)
    moved_by_hand(m, at(14, 15, day=DAY), at(15, 15, day=DAY))
    m.icloud.seed(copy_path(m), caldav.build_copy_ics(family_copy._uid(m.key), COPY_TITLE, at(14, 15, day=DAY),
                                                      at(15, 45, day=DAY), m.clock()))
    with m.ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off' WHERE key=?", (m.key,))
    etag = m.icloud.events[copy_path(m)][0]
    sync(m)
    sync(m)
    assert m.icloud.events[copy_path(m)][0] == etag and row(m)["state"] == "hands_off"


# -- 4. drive blocks written -----------------------------------------------------------------------

def test_drive_blocks_are_written_by_default_even_with_the_old_dry_run_setting_saved(drives, tmp_path):
    """Nov 27, at his word: "no drive time". His saved options still carry the old own_drive_dry_run: true."""
    (tmp_path / "options.json").write_text(json.dumps({"own_drive_dry_run": True, "own_drive_days": 3}))
    drives.gm.own_dry_fn = lambda: own_dry_run_from_options(str(tmp_path))
    drives.maps.minutes[frozenset({"home", CLINIC})] = 31                    # rounds up to 45
    quiet_family(drives)
    a, b = when(drives, days=2, hour=10), when(drives, days=2, hour=11, minute=30)
    dentist = mine(drives, "Dentist", a, CLINIC)
    mine(drives, "Massage", b, PARK)
    go(drives)
    go(drives)
    assert blocks(drives) == [
        ("Busy (drive there)", a - 45 * M, a, ""),                           # from home, a quarter hour up
        ("Busy (drive there)", b - 15 * M, b, ""),                           # one drive between the places
        ("Busy (drive back)", b + 60 * M, b + 90 * M, "")]                   # and the last one home
    # Moved, its drives go with it.
    drives.feeds.window.occurrences.remove(dentist)
    later = when(drives, days=2, hour=15)
    moved = mine(drives, "Dentist", later, CLINIC)
    go(drives)
    go(drives)
    assert ("Busy (drive there)", later - 45 * M, later, "") in blocks(drives)
    assert ("Busy (drive there)", a - 45 * M, a, "") not in blocks(drives)
    # Cancelled, they come off.
    drives.feeds.window.occurrences.remove(moved)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[1] in (later - 45 * M, later + 60 * M)]


def test_the_dry_run_switch_still_turns_them_back_to_the_log(drives, tmp_path):
    (tmp_path / "options.json").write_text(json.dumps({"drive_dry_run": True}))
    drives.gm.own_dry_fn = lambda: own_dry_run_from_options(str(tmp_path))
    quiet_family(drives)
    mine(drives, "Dentist", when(drives, days=2, hour=10), CLINIC)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]


# -- 5. a note naming a drive block makes a card ------------------------------------------------------

def test_a_question_with_a_drive_block_note_makes_a_card_marked_from_cain(m):
    cards = drive_cards.DriveCards(m.ledger, tz=TZ)
    m.c.runner.drive_card = lambda chat, job_id=None: cards.note_card(chat, planned=True, dry=True, now=m.clock(),
                                                                      job_id=job_id)
    out = m.tells("why is there no travel time", result({"type": "answer", "text": "They're in a dry run."}),
                  suggestion="He wants the drive blocks around his massage tomorrow.")
    assert out["status"] == "card", out
    card = m.seen()[-1]
    assert card.startswith("From Cain's note on your message, about your drive blocks:")
    assert {"Write them", "Keep logging"} <= set(m.labels())


def test_write_them_on_the_card_writes_his_drives_while_the_dry_run_setting_stays_on(drives):
    drives.gm.own_dry_fn = lambda: True
    quiet_family(drives)
    a = when(drives, days=2, hour=10)
    mine(drives, "Dentist", a, CLINIC)
    go(drives)
    go(drives)
    assert not [x for x in blocks(drives) if x[0].startswith("Busy (drive")]
    assert drives.gm.drive_note_card(drives.live.chat_id)
    bid = next(r["key"][len(drive_cards.NOTE_CARD):] for r in drives.ledger.db.execute(
        "SELECT key FROM meta WHERE key LIKE ?", (drive_cards.NOTE_CARD + "%",)))
    assert drives.live.on_choice("drive_write", bid).startswith("Writing the drives")
    assert drives.live.on_choice("drive_write", bid).startswith("Already settled")
    go(drives)
    go(drives)
    assert ("Busy (drive there)", a - 30 * M, a, "") in blocks(drives)
    drives.gm.own_dry_fn = lambda: False                                     # the setting off: the tap goes
    go(drives)
    assert not drives.live.drive_cards.written_by_tap()
