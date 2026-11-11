"""0.21.0: his plain calendar commands just work (Nov 11).

That morning he told Cain his PT moved 30 minutes earlier and that he wasn't doing the school
drop-off. It failed three times: "PT" didn't match the PT on his calendar, a note from Cain
couldn't reach the question it answered, his dictated message got a paste tap, the drop-off
(a block Harness made on his Gmail calendar) was looked for on Family, and the cards were ISO
stamps and a job id. These replay it, through Cain's handover, against a fake calendar, then
check each fix on its own. All names and places are invented.
"""
import json
import queue
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import caldav, commands, family_copy, google_cal, render
from harness.calendar_change import CalendarChange, fit, said
from harness.config import Config
from harness.controller import Controller
from harness.discord_chat import LinkChat
from harness.discord_keeper import DiscordKeeper, KeeperStore
from harness.family_add import FamilyAdd
from harness.family_gmail import DROP_TITLE, PICK_TITLE
from harness.handover import Handover, Inbox
from harness.ledger import iso
from harness.vault import Vault
from fake_caldav import APP_PASSWORD, APPLE_ID, FAMILY_PATH, FAMILY_URL, FakeICloud, no_network  # noqa: F401
from fakes import FakeBot, FakeEngine, SyncExecutor, result
from test_calendar_change import FakeGmail
from test_discord_keeper import OWNER, TOKEN, FakeDiscord, FakeLink

TZ = "America/New_York"
NY = ZoneInfo(TZ)
GMAIL = "owner@gmail.com"
NOW = datetime(2026, 11, 11, 12, 30, tzinfo=timezone.utc)          # Wed Nov 11, 7:30 AM there
PT_ID = "pt20261111"
PT_TITLE = "PT — Example Clinic"
COPY_TITLE = "Alex - PT"                                           # his first name, invented
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\b")


@pytest.fixture(autouse=True)
def plain_prompt(monkeypatch):
    """The shipped prompt uses strftime codes Windows doesn't have; its text is checked elsewhere."""
    from harness import prompts
    monkeypatch.setattr(prompts, "system_prompt", lambda **kw: "system")


def at(hour, minute=0, day=11):
    return datetime(2026, 11, day, hour, minute, tzinfo=NY)


def change(calendar, op, title, dates="2026-11-11", start="", end=""):
    return {"calendar": calendar, "op": op, "title": title, "dates": dates, "start": start, "end": end,
            "days": "", "until": "", "location": ""}


def ask(*changes):
    return result({"type": "proposal", "effect_type": "calendar_change",
                   "params": {"changes": list(changes)}, "summary": "ignored"})


MOVE_PT = change("gmail", "move", "PT", start="2026-11-11T11:30:00-05:00", end="2026-11-11T12:30:00-05:00")
DROP_OFF = change("family", "remove", "school drop-off")          # as the model put it that morning


class Gmail(FakeGmail):
    """His Gmail calendar as the Google API gives it, all-day events too."""

    def events_between(self, address, start, end):
        out = []
        for e in self.events.values():
            if e.get("status") == "cancelled":
                continue
            side = e["start"]
            when = datetime.fromisoformat(side["dateTime"]) if side.get("dateTime") else \
                datetime.combine(date.fromisoformat(side["date"]), datetime.min.time(), NY)
            if start <= when < end:
                out.append(e)
        return out


class Morning:
    """Cain's handover, his Discord DM, both calendars, and Harness's own copies and blocks."""

    def __init__(self, ledger, tmp_path, clock):
        clock.t = NOW
        self.ledger, self.clock = ledger, clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("discord_bot_token", TOKEN, by="Owner")
        for field, value in (("family_apple_id", APPLE_ID), ("family_app_password", APP_PASSWORD),
                             ("family_calendar_url", FAMILY_URL)):
            self.vault.set_key(field, value, by="Owner")
        self.icloud = FakeICloud()
        self.client = caldav.FamilyCalDav(self.icloud, lambda: (
            self.vault.get("family_apple_id"), self.vault.get("family_app_password"),
            self.vault.get("family_calendar_url")))
        self.fa = FamilyAdd(ledger, self.client, tz=TZ, policy_version="p1", model="test-model",
                            creds_stamp=self.vault.family_stamp)
        self.gmail = Gmail()
        self.cc = CalendarChange(ledger, self.client, self.gmail, enabled=lambda: True,
                                 address=lambda: GMAIL, tz=TZ)
        self.claude = FakeEngine("claude")
        self.d = FakeDiscord()
        self.link = FakeLink()
        store = KeeperStore(str(tmp_path / "discord.json"))
        self.c = Controller(ledger=ledger, vault=self.vault, api=FakeBot(),
                            engines={"claude": self.claude, "gpt": FakeEngine("gpt")},
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1", proactive_from=date(2026, 10, 20)),
                            sleep=lambda s: None, monotonic=lambda: 0.0, status_box={},
                            requests=queue.Queue(), poll_timeout=0, family_add=self.fa, calendar_change=self.cc)
        self.c.discord = DiscordKeeper(self.d, store.get, store.set)
        self.c.discord_chat = LinkChat(self.link, paused=lambda: commands.is_paused(ledger))
        self.c.handovers = Inbox(lambda: TOKEN)
        self.seed()
        self.days_done()
        self.c.startup()
        self.c.tick()

    def days_done(self):
        today = self.clock().astimezone(NY).date().isoformat()
        with self.ledger.tx() as db:
            self.ledger.set_meta("canary_date", today, db)
            self.ledger.set_meta("digest_date", today, db)

    # -- the calendars as they were at 7:10 that morning ------------------------------------
    def seed(self):
        now = self.clock()
        self.gmail.events[PT_ID] = {
            "id": PT_ID, "iCalUID": f"{PT_ID}@google.com", "etag": '"1"', "status": "confirmed",
            "summary": PT_TITLE, "organizer": {"email": GMAIL, "self": True},
            "start": {"dateTime": at(12).isoformat(), "timeZone": TZ},
            "end": {"dateTime": at(13).isoformat(), "timeZone": TZ}}
        # Harness's copy of it on Family (family_copy.py), and its record.
        occ = google_cal._occurrence(self.gmail.events[PT_ID], GMAIL, "")
        self.copy_key = family_copy._key(occ)
        self.copy_uid = family_copy._uid(self.copy_key)
        self.copy_path = FAMILY_PATH + self.copy_uid + ".ics"
        self.icloud.seed(self.copy_path, caldav.build_copy_ics(self.copy_uid, COPY_TITLE, at(12), at(13), now))
        with self.ledger.tx() as db:
            db.execute("INSERT INTO family_copies(key, uid, href, hand, seen, word, title, start, end, state,"
                       " missing, created_at, updated_at) VALUES(?,?,'',0,'','PT',?,?,?,'live',0,?,?)",
                       (self.copy_key, self.copy_uid, COPY_TITLE, at(12).isoformat(), at(13).isoformat(),
                        iso(now), iso(now)))
        # The school day on Family, and the two runs Harness made from it on Gmail (family_gmail.py).
        school = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:school-1111",
                              "DTSTAMP:20261101T120000Z", "DTSTART:20261111T133000Z", "DTEND:20261111T200000Z",
                              "SUMMARY:School Day", "END:VEVENT", "END:VCALENDAR", ""])
        self.icloud.seed(FAMILY_PATH + "school-1111.ics", school)
        self.blocks = {}
        for run, title, start, end in (("drop", DROP_TITLE, at(8), at(8, 45)),
                                       ("pick", PICK_TITLE, at(14, 45), at(15, 30))):
            key = f"{run:0<32}"
            uid = google_cal.event_id(f"{key}:0")
            self.gmail.events[uid] = {**google_cal._body(uid, title, start, end), "etag": f'"{run}"'}
            self.blocks[run] = (key, uid)
            with self.ledger.tx() as db:
                db.execute("INSERT INTO family_gmail(key, event_id, generation, intent, title, start, end, state,"
                           " missing, created_at, updated_at, place) VALUES(?,?,0,'',?,?,?,'live',0,?,?,'')",
                           (key, uid, title, start.isoformat(), end.isoformat(), iso(now), iso(now)))

    # -- what he does ---------------------------------------------------------------------------
    def he_says(self, text, *, ago=5, **extra):
        mid = str(80000 + len(self.d.hist))
        when = (self.clock() - timedelta(seconds=ago)).isoformat()
        self.d.hist.insert(0, {"id": mid, "content": text, "timestamp": when, "author": {"id": OWNER}, **extra})
        return mid

    def send(self, h):
        self.c.handovers.submit(h)
        for _ in range(6):
            self.c.tick()
            if h.done.is_set():
                break
        return h.result

    def handover(self, **kw):
        return self.send(Handover(**kw))

    def tells(self, text, *outputs, **kw):
        """He says it to Cain; Cain hands it over; the model answers as scripted."""
        self.claude.script = list(outputs)
        self.he_says(text)
        return self.handover(paired=OWNER, **kw)

    def tap(self, label):
        card = next(cid for cid in sorted(self.link.cards, reverse=True)
                    if any(c["label"] == label for r in self.link.cards[cid]["rows"] for c in r["components"]))
        custom = next(c["custom_id"] for r in self.link.cards[card]["rows"] for c in r["components"]
                      if c["label"] == label)
        return self.send(Handover(kind="press", press={"id": str(90000 + len(self.link.answers)), "token": "t",
                                                       "app": "999", "custom_id": custom,
                                                       "message_id": str(card)}))

    # -- what he sees, and what's on the calendars -----------------------------------------------
    def seen(self):
        """Every card Cain showed him, as he reads it: Discord's bold and escapes taken out."""
        return [re.sub(r"\\(.)", r"\1", re.sub(r"(?<!\\)\*+", "", self.link.cards[cid]["text"]))
                for cid in sorted(self.link.cards)]

    def labels(self):
        return [c["label"] for cid in self.link.cards for r in self.link.cards[cid]["rows"]
                for c in r["components"]]

    def gmail_times(self, uid):
        e = self.gmail.events[uid]
        return (datetime.fromisoformat(e["start"]["dateTime"]).astimezone(NY).strftime("%H:%M"),
                datetime.fromisoformat(e["end"]["dateTime"]).astimezone(NY).strftime("%H:%M"))

    def copy_times(self):
        ics = self.icloud.events[self.copy_path][1]
        start = re.search(r"DTSTART[^:]*:(\S+)", ics).group(1)
        end = re.search(r"DTEND[^:]*:(\S+)", ics).group(1)
        fmt = "%Y%m%dT%H%M%SZ"
        return tuple(datetime.strptime(x, fmt).replace(tzinfo=timezone.utc).astimezone(NY).strftime("%H:%M")
                     for x in (start, end))

    def block_state(self, run):
        return self.gmail.events[self.blocks[run][1]].get("status", "confirmed")

    def row(self, table, key):
        return self.ledger.db.execute(f"SELECT * FROM {table} WHERE key=?", (key,)).fetchone()


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def nothing_he_shouldnt_see(m, *answers):
    """No ISO stamp, no job id, no expiry line, no em dash, anywhere he looks."""
    jobs = [r["id"] for r in m.ledger.db.execute("SELECT id FROM jobs")]
    for text in m.seen() + [a.get("said", "") for a in answers]:
        assert not ISO.search(text), text
        assert "job " not in text and not any(j.split("-")[0] in text for j in jobs), text
        assert "Offer ends" not in text and "—" not in text, text


# -- the morning, replayed ----------------------------------------------------------------------

def test_this_morning_replayed_does_it_with_one_receipt_and_undo_puts_it_all_back(m):
    # 1. Dictated, two lines. "School run" is honestly unclear, so the model asks: once, plainly.
    first = m.tells("PT today moved 30 minutes earlier, 11:30\nI'm not doing the school run today",
                    result({"type": "clarify", "question": "Drop-off, pickup or both?"}))
    assert first["status"] == "needs_clarification" and "Drop-off, pickup or both?" in first["said"]
    user = m.claude.calls[0]["user"]
    # What he named is in front of the model: no "I can't see that appointment on your calendar".
    assert "PT - Example Clinic" in user and "Busy (school drop-off) (a block Harness made)" in user
    # 2. His answer. The model asks for the drop-off on Family, as it did that morning.
    out = m.tells("drop-off only, duration unchanged", ask(MOVE_PT, DROP_OFF))
    assert out["status"] == "executed"
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.copy_times() == ("11:30", "12:30")
    assert m.block_state("drop") == "cancelled" and m.block_state("pick") == "confirmed"
    assert "SUMMARY:School Day" in m.icloud.events[FAMILY_PATH + "school-1111.ics"][1]
    receipt = m.seen()[-1]
    assert receipt.splitlines() == ["Done.", "Moved PT to 11:30 to 12:30 today (Gmail and Family)",
                                    "Took off today's 8:00 drop-off"]
    assert "Approve" not in m.labels() and m.labels().count("Undo") == 1
    assert out["said"] == "Done.\nMoved PT to 11:30 to 12:30 today (Gmail and Family)\nTook off today's 8:00 drop-off"
    nothing_he_shouldnt_see(m, first, out)
    # Harness's own records follow: the copy at its new time, the drop-off as his answer.
    assert m.row("family_copies", m.copy_key)["start"] == at(11, 30).isoformat()
    assert m.row("family_gmail", m.blocks["drop"][0])["state"] == "removed"
    # 3. Undo puts all three back, and the records with them.
    m.tap("Undo")
    assert m.gmail_times(PT_ID) == ("12:00", "13:00") and m.copy_times() == ("12:00", "13:00")
    assert m.block_state("drop") == "confirmed"
    assert m.row("family_copies", m.copy_key)["start"] == at(12).isoformat()
    assert m.row("family_gmail", m.blocks["drop"][0])["state"] == "live"
    assert "Undone" in m.seen()[-1]
    nothing_he_shouldnt_see(m)


def test_said_in_one_dictated_message_it_goes_straight_through(m):
    out = m.tells("PT today moved 30 minutes earlier, 11:30.\nAnd I'm not doing school drop-off today, "
                  "so take that off too. Thanks.", ask(MOVE_PT, DROP_OFF))
    assert out["status"] == "executed" and "Approve" not in m.labels()
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.block_state("drop") == "cancelled"


def test_the_third_try_from_that_morning_now_lands_whole(m):
    """The card that morning named the copy on Family as its own line and the block by its full
    title. Approved, it said "the closest I found is PT". Now it's one change, done."""
    out = m.tells("move PT to 11:30 and take off the drop-off", ask(
        MOVE_PT,
        change("family", "move", COPY_TITLE, start="2026-11-11T11:30:00-05:00", end="2026-11-11T12:30:00-05:00"),
        change("gmail", "remove", DROP_TITLE)))
    assert out["status"] == "executed"
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.copy_times() == ("11:30", "12:30")
    assert m.block_state("drop") == "cancelled"
    assert m.seen()[-1].count("Moved PT") == 1                      # one event, said once


# -- b. his words, either way round, on both calendars ---------------------------------------------

@pytest.mark.parametrize("words", ["PT", "physical therapy", "my physical therapy appointment", "Alex - PT",
                                   "the 12:00 PT", "PT — Example Clinic", "physio"])
def test_his_words_for_pt_find_the_one_pt(m, words):
    out = m.tells("PT moved to 11:30", ask(change("gmail", "move", words, start="2026-11-11T11:30:00-05:00",
                                                  end="2026-11-11T12:30:00-05:00")))
    assert out["status"] == "executed" and m.gmail_times(PT_ID) == ("11:30", "12:30")
    assert m.copy_times() == ("11:30", "12:30")


@pytest.mark.parametrize("asked, title, expected", [
    ("PT", PT_TITLE, 1), ("physical therapy", PT_TITLE, 1), ("physical therapy", "PT", 2),
    ("PT", "Physical Therapy", 2), ("drop-off", DROP_TITLE, 1), ("drop off", DROP_TITLE, 1),
    ("the 8:00 drop-off", DROP_TITLE, 1), ("school drop-off", DROP_TITLE, 1), ("pickup", PICK_TITLE, 1),
    ("drop-off", PICK_TITLE, 0), ("school", "Homeschool co-op", 0), ("school day", "School", 0),
    ("dentist", "Dental cleaning", 1), ("PT", "Pottery", 0), ("", "School", 0)])
def test_fit_goes_both_ways_and_never_on_part_of_a_word(asked, title, expected):
    assert fit(asked, title) == expected


def test_a_clock_time_in_his_words_says_which_one():
    assert said("the 8:00 drop-off") == (frozenset({"dropoff"}), ((8, 0, ""),))
    assert said("PT at 11:30am")[1] == ((11, 30, "a"),)
    assert said("2026-11-11T11:30:00-05:00 PT")[1] == ()             # a stamp isn't his clock


def test_the_8_00_drop_off_is_the_drop_off_at_8(m):
    out = m.tells("not doing the 8:00 drop-off", ask(change("gmail", "remove", "the 8:00 drop-off")))
    assert out["status"] == "executed" and m.block_state("drop") == "cancelled"
    assert "Took off today's 8:00 drop-off" in m.seen()[-1]


# -- e. clear goes straight through; unclear is asked once, by name ------------------------------

def test_two_events_that_fit_are_named_in_one_question_and_nothing_changes(m):
    m.gmail.events["pt2"] = {**m.gmail.events[PT_ID], "id": "pt2", "iCalUID": "pt2@google.com",
                             "summary": "PT follow-up", "start": {"dateTime": at(16).isoformat()},
                             "end": {"dateTime": at(17).isoformat()}}
    out = m.tells("move PT to 11:30", ask(MOVE_PT))
    assert out["status"] == "needs_clarification"
    question = out["said"]
    assert "PT - Example Clinic at 12:00" in question and "PT follow-up at 4:00" in question
    assert question.startswith("Nothing changed") and question.count("?") == 1
    assert m.gmail_times(PT_ID) == ("12:00", "13:00") and "Approve" not in m.labels()
    nothing_he_shouldnt_see(m, out)


def test_what_isnt_there_is_asked_with_what_is(m):
    out = m.tells("move karate to 11:30", ask(change("gmail", "move", "karate", start="2026-11-11T11:30:00-05:00",
                                                     end="2026-11-11T12:30:00-05:00")))
    assert out["status"] == "needs_clarification"
    assert "I can't find karate today" in out["said"] and "PT - Example Clinic at 12:00" in out["said"]


def test_a_pasted_email_still_gets_its_tap_and_the_card_reads_plainly(m):
    out = m.tells("From: Example Clinic <desk@clinic.example>\nSubject: Your visit moved\n\n"
                  "Your PT visit today is now at 11:30.", ask(MOVE_PT))
    assert out["status"] == "waiting for his tap" and m.gmail_times(PT_ID) == ("12:00", "13:00")
    card = m.seen()[-1]
    assert "Move PT to 11:30 to 12:30 today (Gmail and Family)" in card and "may be pasted text" in card
    nothing_he_shouldnt_see(m, out)
    m.tap("Approve")
    said_on_tap = [t for t in m.seen() if t.startswith("Approved")]
    assert said_on_tap == ["Approved. Doing it now:\nMove PT to 11:30 to 12:30 today (Gmail and Family)"]
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.seen()[-1].startswith("Done.")


# -- f. every part, or exactly which part failed and why -------------------------------------------

def test_a_part_that_fails_is_named_and_the_rest_still_goes(m):
    real = m.gmail.drop

    def refused(address, uid, etag):
        return caldav.Outcome("denied")                           # Google won't take this one off
    m.gmail.drop = refused
    out = m.tells("PT 11:30, no drop-off", ask(MOVE_PT, DROP_OFF))
    m.gmail.drop = real
    receipt = m.seen()[-1]
    assert m.gmail_times(PT_ID) == ("11:30", "12:30") and m.block_state("drop") == "confirmed"
    assert receipt.startswith("Only part of that went through.")
    assert "Moved PT to 11:30 to 12:30 today (Gmail and Family)" in receipt
    assert ("Not done: Take off today's 8:00 drop-off, because Google says this calendar isn't shared "
            "for changes.") in receipt
    assert "Nothing changed" not in receipt and "Undo" in m.labels()
    assert out["status"] == "failed"


def test_a_copy_that_fails_says_where_it_went_through(m):
    m.icloud.before_write = lambda: m.icloud.human_edit(m.copy_path, "SUMMARY:", "SUMMARY:Edited ")
    m.tells("PT 11:30", ask(MOVE_PT))
    receipt = m.seen()[-1]
    assert m.gmail_times(PT_ID) == ("11:30", "12:30")
    assert receipt.startswith("That stopped partway.") or receipt.startswith("Only part")
    assert ("Partly done: Move PT to 11:30 to 12:30 today (Gmail and Family). It went through on Gmail, "
            "not on the Family copy, because someone changed that event since") in receipt


# -- g. a block Harness made is found where it is -----------------------------------------------

def test_the_drop_off_named_on_family_comes_off_gmail_and_stays_off(m):
    m.tells("no drop-off today", ask(DROP_OFF))
    assert m.block_state("drop") == "cancelled"
    assert m.row("family_gmail", m.blocks["drop"][0])["state"] == "removed"   # its sync won't put it back


# -- h. a note for a question reaches it ------------------------------------------------------------

def test_a_note_from_cain_reaches_the_request_waiting_on_its_question(m):
    m.claude.script = [result({"type": "clarify", "question": "Which appointment?"})]
    m.he_says("my appointment today moved to 11:30")
    first = m.handover(paired=OWNER)
    assert first["status"] == "needs_clarification"
    m.claude.script = [ask(MOVE_PT)]
    again = m.handover(paired=OWNER, suggestion="He means PT, 12:00 to 1:00 PM on his Gmail calendar.")
    assert len(m.claude.calls) == 2 and "He means PT" in m.claude.calls[1]["user"]
    assert again["said"] != first["said"] and "Which appointment?" not in again["said"]
    # It rests on Cain's words, so it's offered on a card, plainly.
    assert again["status"] == "waiting for his tap" and "Move PT to 11:30 to 12:30 today" in again["said"]
    again2 = m.handover(paired=OWNER, suggestion="He means PT, 12:00 to 1:00 PM on his Gmail calendar.")
    assert len(m.claude.calls) == 2 and again2["status"] == "waiting for his tap"     # once is enough


# -- i. the copy moves with its event, and its sync agrees -----------------------------------------

def test_the_copys_sync_takes_the_move_as_its_own_and_a_read_from_before_cant_undo_it(m):
    m.tells("PT 11:30", ask(MOVE_PT))
    copier = family_copy.FamilyCopy(m.ledger, m.fa, None, name_fn=lambda: "Alex", tz=TZ)
    copier.writes = 0
    row = m.row("family_copies", m.copy_key)
    family = m.client.items_between(at(0), at(23), TZ)
    stale = copier._holds(m.clock())
    times, gone = stale[m.copy_key]
    assert times == ((at(12), at(13)),) and not gone
    # A read from before the change still has PT at 12:00: the copy stays where he put it.
    old = family_copy.Want(m.copy_key, "PT", COPY_TITLE, at(12), at(13))
    copier._follow({m.copy_key: old}, family, m.clock(), True, at(23, 59), False)
    assert m.copy_times() == ("11:30", "12:30") and m.row("family_copies", m.copy_key)["state"] == "live"
    # The next read has it at 11:30: as written, nothing to do, and the hold is let go.
    new = family_copy.Want(m.copy_key, "PT", COPY_TITLE, at(11, 30), at(12, 30))
    copier._follow({m.copy_key: new}, m.client.items_between(at(0), at(23), TZ), m.clock(), True,
                   at(23, 59), False)
    assert m.copy_times() == ("11:30", "12:30") and m.row("family_copies", m.copy_key)["state"] == "live"
    assert m.copy_key not in copier._holds(m.clock()) and row["start"] == at(11, 30).isoformat()


# -- j. the tap says what will happen; "done" only once it's read back ----------------------------

def test_no_done_until_the_calendar_reads_back_the_change(m):
    real = m.gmail.change

    def lands_but_reads_old(address, uid, fields, etag):
        out = real(address, uid, fields, etag)
        m.gmail.down = True                                       # the read back can't say
        return out
    m.gmail.change = lands_but_reads_old
    m.tells("PT 11:30", ask(MOVE_PT))
    m.gmail.change, m.gmail.down = real, False
    receipt = m.seen()[-1]
    assert not receipt.startswith("Done") and "Written, not confirmed" in receipt


# -- c and d. as he reads it ---------------------------------------------------------------------

def test_times_read_as_he_says_them():
    today = date(2026, 11, 11)
    assert render.span_words(at(11, 30), at(12, 30)) == "11:30 to 12:30"
    assert render.span_words(at(18), at(19)) == "6:00 PM to 7:00 PM"
    assert render.span_words(at(6, 30), at(7, 30)) == "6:30 AM to 7:30 AM"
    assert render.clock_words(at(20)) == "8:00 PM" and render.clock_words(at(8)) == "8:00"
    assert render.day_words(today, today) == "today" and render.day_words(date(2026, 11, 12), today) == "tomorrow"
    assert render.day_words(date(2026, 11, 13), today) == "Friday"
    assert render.day_words(date(2026, 11, 20), today) == "on Fri Nov 20"
    assert render.day_owner(today, today) == "today's" and render.day_owner(date(2026, 12, 1), today) is None
    assert render.no_dashes(PT_TITLE) == "PT - Example Clinic"


def test_a_card_from_his_words_alone_has_no_stamp_no_expiry_and_no_job():
    from harness import effects
    card = render.proposal_card(effects.REGISTRY["calendar_change"], {"changes": [MOVE_PT, DROP_OFF]}, tz=TZ,
                                expires=NOW + timedelta(hours=12), job_id="83e22204-aaaa", now=NOW)
    assert card.splitlines() == ["<b>Change your calendar?</b>",
                                 "Move PT to 11:30 to 12:30 today (Gmail)",
                                 "Take off today's school drop-off (Family)"]
    assert render.answer("83e22204-aaaa", "Which one?") == "Which one?"


def test_the_digest_names_a_waiting_change_without_a_job_number(m):
    from harness import daily
    m.tells("From: Office <desk@clinic.example>\nSubject: moved\n\nPT 11:30", ask(MOVE_PT))
    d = daily.gather(m.ledger, m.c.config, paused=False)
    assert "waiting for your tap" in d.text and "job " not in d.text


def test_the_model_is_told_what_already_happened(m):
    """Nov 11: an answer said no proposal had been sent, when one had been approved."""
    m.tells("PT 11:30, no drop-off", ask(MOVE_PT, DROP_OFF))
    m.tells("did that go through?", result(text="Yes, both are done."))
    user = m.claude.calls[-1]["user"]
    assert "<recent>" in user and "Outcome: done." in user
    assert "Move PT to 11:30 to 12:30 today (Gmail and Family)" in user
    assert "He was told: Done." in user


def test_a_card_waiting_for_his_tap_is_said_as_waiting(m):
    m.tells("From: Example Clinic <desk@clinic.example>\nSubject: moved\n\nPT 11:30", ask(MOVE_PT))
    m.tells("what's waiting?", result(text="One change."))
    assert "Outcome: offered on a card, waiting for his tap." in m.claude.calls[-1]["user"]


# -- what an independent review found, before shipping ----------------------------------------

def gmail_event(m, uid, title, start, end, series=""):
    m.gmail.events[uid] = {"id": uid, "iCalUID": f"{series or uid}@google.com", "etag": '"1"',
                           "status": "confirmed", "summary": title, "organizer": {"email": GMAIL, "self": True},
                           "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()},
                           **({"recurringEventId": series, "originalStartTime": {"dateTime": start.isoformat()}}
                              if series else {})}


def family_event(m, uid, title, start, end):
    fmt = "%Y%m%dT%H%M%SZ"
    m.icloud.seed(FAMILY_PATH + uid + ".ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", f"UID:{uid}", "DTSTAMP:20261101T120000Z",
        f"DTSTART:{start.astimezone(timezone.utc):{fmt}}", f"DTEND:{end.astimezone(timezone.utc):{fmt}}",
        f"SUMMARY:{title}", "END:VEVENT", "END:VCALENDAR", ""]))


def test_part_of_a_one_offs_name_is_asked_when_a_series_by_that_name_isnt_that_day(m):
    """PT is Mondays and Wednesdays; Tuesday has only the PT insurance call. "No PT Tuesday"
    can't take off the call, and "move PT Tuesday" can't move it: asked, on Gmail too."""
    for day in (16, 18):
        gmail_event(m, f"ptweekly_202611{day}", "PT", at(9, day=day), at(10, day=day), series="ptweekly")
    gmail_event(m, "ptcall", "PT insurance call", at(9, day=17), at(9, 30, day=17))
    for op in (change("gmail", "remove", "PT", dates="2026-11-17"),
               change("gmail", "move", "PT", dates="2026-11-17", start="2026-11-17T10:00:00-05:00",
                      end="2026-11-17T10:30:00-05:00")):
        out = m.tells("no PT Tuesday", ask(op))
        assert out["status"] == "needs_clarification" and "PT insurance call" in out["said"]
        assert m.gmail.events["ptcall"].get("status", "confirmed") == "confirmed"
        assert m.gmail_times("ptcall") == ("09:00", "09:30")


def test_his_word_on_the_other_calendar_only_is_asked_not_done(m):
    """Nothing called PT on his Gmail tomorrow; Family has someone else's. Never taken without asking."""
    family_event(m, "jordan-pt", "Jordan - PT", at(16, day=12), at(17, day=12))
    out = m.tells("no PT tomorrow", ask(change("gmail", "remove", "PT", dates="2026-11-12")))
    assert out["status"] == "needs_clarification"
    assert "PT isn't on your Gmail calendar tomorrow, and Jordan - PT at 4:00 (Family) is" in out["said"]
    assert FAMILY_PATH + "jordan-pt.ics" in m.icloud.events


def test_a_partial_match_is_named_by_its_own_title(m):
    gmail_event(m, "ptb", "PT follow-up — Clinic B", at(15, day=13), at(16, day=13))
    m.tells("no PT Friday", ask(change("gmail", "remove", "PT", dates="2026-11-13")))
    assert "Took off Friday's 3:00 PT follow-up - Clinic B (Gmail)" in m.seen()[-1]


def test_no_school_today_is_the_school_day_not_its_runs(m):
    out = m.tells("no school today", ask(change("family", "remove", "school")))
    assert out["status"] == "executed" and FAMILY_PATH + "school-1111.ics" not in m.icloud.events
    assert m.block_state("drop") == "confirmed" and m.block_state("pick") == "confirmed"
    assert "Took off today's 8:30 School Day (Family)" in m.seen()[-1]


def test_a_moved_block_is_his_and_undo_gives_it_back_to_its_sync(m):
    m.tells("drop-off at 8:15", ask(change("gmail", "move", "drop-off", start="2026-11-11T08:15:00-05:00",
                                           end="2026-11-11T09:00:00-05:00")))
    assert m.gmail_times(m.blocks["drop"][1]) == ("08:15", "09:00")
    assert m.row("family_gmail", m.blocks["drop"][0])["state"] == "hands_off"
    assert "Moved drop-off to 8:15 to 9:00 today" in m.seen()[-1]
    m.tap("Undo")
    assert m.gmail_times(m.blocks["drop"][1]) == ("08:00", "08:45")
    assert m.row("family_gmail", m.blocks["drop"][0])["state"] == "live"


def copier(m):
    c = family_copy.FamilyCopy(m.ledger, m.fa, None, name_fn=lambda: "Alex", tz=TZ)
    c.writes = 0
    return c


def follow(m, c, *wants):
    c._follow({w.key: w for w in wants}, m.client.items_between(at(0), at(23), TZ), m.clock(), True,
              at(23, 59), False)


def pt_want(m, start, end):
    return family_copy.Want(m.copy_key, "PT", COPY_TITLE, start, end)


def test_two_moves_before_the_feed_catches_up_and_no_read_from_before_moves_it_back(m):
    m.tells("PT 11:30", ask(MOVE_PT))
    m.tells("PT 11:00 now", ask(change("gmail", "move", "PT", start="2026-11-11T11:00:00-05:00",
                                       end="2026-11-11T12:00:00-05:00")))
    assert m.copy_times() == ("11:00", "12:00")
    c = copier(m)
    for start, end in ((at(12), at(13)), (at(11, 30), at(12, 30))):      # reads from before either move
        follow(m, c, pt_want(m, start, end))
        assert m.copy_times() == ("11:00", "12:00") and m.row("family_copies", m.copy_key)["state"] == "live"
    follow(m, c, pt_want(m, at(11), at(12)))                              # the read that shows it
    assert m.copy_key not in c._holds(m.clock())


def test_a_copy_taken_off_comes_back_with_undo_after_a_read_without_its_event(m):
    m.tells("no PT today", ask(change("gmail", "remove", "PT")))
    assert m.copy_path not in m.icloud.events
    assert m.row("family_copies", m.copy_key)["state"] == "asked_off"
    c = copier(m)
    c._let_go({})                                    # a whole read without the Gmail event
    assert m.row("family_copies", m.copy_key)["state"] == "cancelled"
    m.tap("Undo")
    assert m.copy_path in m.icloud.events and m.row("family_copies", m.copy_key)["state"] == "live"
    follow(m, c)                                     # a read from before the Undo: no PT in it
    assert m.row("family_copies", m.copy_key)["missing"] == 0 and m.copy_path in m.icloud.events


def test_two_days_where_one_copy_fails_names_that_day_and_does_the_other(m):
    gmail_event(m, "pt12", PT_TITLE, at(12, day=12), at(13, day=12))
    m.icloud.force_status = 403                      # Family refuses the first write: today's copy
    m.tells("no PT today or tomorrow", ask(change("gmail", "remove", "PT", dates="2026-11-11,2026-11-12")))
    receipt = m.seen()[-1]
    assert receipt.startswith("Only part of that went through.")
    assert "Took off tomorrow's 12:00 PT (Gmail)" in receipt
    assert ("Partly done: Take off today's 12:00 PT (Gmail and Family). It went through on Gmail, "
            "not on the Family copy") in receipt
    assert m.gmail.events["pt12"]["status"] == "cancelled"


def test_a_lost_answer_is_never_called_nothing_changed(m):
    real = m.gmail.change

    def lost(address, uid, fields, etag):
        real(address, uid, fields, etag)
        return caldav.Outcome("unknown")             # it landed; the answer didn't
    m.gmail.change = lost
    m.gmail.drop = lambda address, uid, etag: caldav.Outcome("denied")
    m.tells("PT 11:30, no drop-off", ask(MOVE_PT, DROP_OFF))
    receipt = m.seen()[-1]
    assert receipt.startswith("Not sure that went through.") and "Nothing changed" not in receipt


def test_a_misread_at_the_run_is_said_not_a_stopped_tick(m, monkeypatch):
    real = m.cc._plan_all

    def misread(params, pid):
        if pid == "preview":
            return real(params, pid)
        raise ValueError("odd event")
    monkeypatch.setattr(m.cc, "_plan_all", misread)
    out = m.tells("PT 11:30", ask(MOVE_PT))
    assert out["status"] == "failed" and "couldn't read one of those events" in out["said"]
    assert m.gmail_times(PT_ID) == ("12:00", "13:00")
    assert m.ledger.db.execute("SELECT state FROM calendar_changes").fetchone()[0] == "refused"


# -- Cain's link takes a card's buttons off when they lapse (Cain 0.7.0) ----------------------

def test_a_card_says_when_its_buttons_lapse(m):
    m.tells("From: Example Clinic <desk@clinic.example>\nSubject: moved\n\nPT 11:30", ask(MOVE_PT))
    card = m.link.cards[max(m.link.cards)]
    lapse = m.ledger.db.execute("SELECT expires_at FROM approvals").fetchone()[0]
    assert card["expires"] == lapse and datetime.fromisoformat(lapse) > NOW
    m.tap("Approve")
    receipt = m.link.cards[max(m.link.cards)]
    undo = m.ledger.db.execute("SELECT expires_at FROM choices WHERE kind='calendar_change_undo'").fetchone()[0]
    assert receipt["expires"] == undo and datetime.fromisoformat(undo) - NOW >= timedelta(days=7)
    said = [c for c in m.link.cards.values() if c["text"].startswith("Approved")]
    assert said and said[0]["expires"] is None                   # no buttons of its own: nothing to lapse


def test_the_link_is_told_only_when_there_is_an_expiry(monkeypatch):
    from harness.cain_relay import CainLink
    sent = []
    link = CainLink(lambda: TOKEN)
    monkeypatch.setattr(link, "_call", lambda method, path, body=None, **kw: sent.append(body) or {"id": 7})
    assert link.card("x", [], "reply") == 7 and "expires" not in sent[-1]
    link.card("x", [], "card", expires="2026-11-12T00:30:00+00:00")
    assert sent[-1]["expires"] == "2026-11-12T00:30:00+00:00"
