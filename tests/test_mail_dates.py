"""Follow-through: dates from his mail onto his Gmail calendar. All names are invented."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from harness import choices, google_cal
from harness.engines import EngineResult
from harness.mail_dates import (MAX_TO_ENGINE, MailDates, Message, clean, parse_items, picked,
                                text_of, title, Found)
from fake_caldav import no_network  # noqa: F401  (autouse)
from fakes import own, SyncExecutor
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL, TZ
from test_family_gmail import g  # noqa: F401

SENT = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)


class Box:
    """A mailbox that only answers, the way the real one does: oldest first, after a uid."""
    def __init__(self, messages, validity="7"):
        self.messages = messages
        self.validity = validity
        self.texts_read = []
        self.refuse = False

    def __call__(self, address, password):
        assert address == GMAIL and password == "abcdefghijklmnop"
        return self

    def read(self, last_uid, validity, since):
        if self.refuse:
            import imaplib
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")
        start = last_uid if validity == self.validity else 0
        return self.validity, start, [m for m in sorted(self.messages, key=lambda m: m.uid) if m.uid > start]

    def find(self, message_ids, since):
        """A look-up by Message-ID (a header search), the way the real one is asked."""
        self.looked_up = getattr(self, "looked_up", []) + [list(message_ids)]
        return [m for m in sorted(self.messages, key=lambda m: m.uid) if m.message_id in message_ids]

    def text_for(self, m):
        self.texts_read.append(m.uid)
        return m.text

    def close(self):
        pass


class Engine:
    """Answers by subject; a subject it's told to fail gets no answer."""
    def __init__(self, answers=None):
        self.answers = answers or {}
        self.asked = []
        self.fail = set()

    def complete(self, *, system, user, schema):
        subject = next(line[9:] for line in user.splitlines() if line.startswith("Subject: "))
        self.asked.append(subject)
        if subject in self.fail:
            from harness.engines import EngineError
            raise EngineError("fatal", "boom")
        items = self.answers.get(subject, [])
        return EngineResult("ok", {"items": items}, "claude", "m", 100, 20, 0.01)


def msg(uid, subject, text="", sender="Shop <orders@shop.example>"):
    return Message(uid, f"<{uid}@mail.example>", sender, subject, SENT, text)


def rig_mail(g, messages, answers=None, writes=True):
    g.box = Box(messages)
    g.engine = Engine(answers)
    g.writes = writes
    g.md = MailDates(g.ledger, g.client, SyncExecutor(), address=lambda: GMAIL,
                     password=lambda: "abcdefghijklmnop", engine_fn=lambda: g.engine,
                     writes_on=lambda: g.writes, tz=TZ, mailbox=g.box, sleep=lambda s: None,
                     family=g.fa.client)
    g.md.bind(1)
    return g


def again(g):
    """The look-up of emails behind appointments already written: due now, started, then collected."""
    g.ledger.db.execute("DELETE FROM meta WHERE key='mail_again_at'")
    g.md.run(paused=False)
    g.md.run(paused=False)


def read(g):
    g.ledger.db.execute("DELETE FROM meta WHERE key='mail_read_at'")
    g.md.run(paused=False)       # starts the read (sync), then
    g.md.run(paused=False)       # collects and writes


RETURN = [{"what": "Amazon return: PC parts", "date": "2026-11-26", "kind": "window_closes"}]


# -- what's picked and what comes back ------------------------------------------------------

def test_only_mail_that_may_carry_a_date_is_picked():
    assert picked("Shop <orders@shop.example>", "Your order has shipped")
    assert picked("Insurer", "Your policy renewal")
    assert not picked("Friend <a@b.example>", "Photos from the weekend")
    assert not picked("News <n@x.example>", "This week in woodworking")


def test_what_comes_back_is_checked_and_cleaned():
    today = date(2026, 11, 6)
    out = parse_items({"items": [
        {"what": "  Pay   water bill ", "date": "2026-11-20", "kind": "deadline"},
        {"what": "Old thing", "date": "2026-11-01", "kind": "deadline"},              # past
        {"what": "Far", "date": "2029-01-01", "kind": "renewal"},                     # a misread
        {"what": "Claim at evil.example/x", "date": "2026-11-20", "kind": "deadline"},  # a link
        {"what": "Odd", "date": "2026-13-01", "kind": "deadline"},
        {"what": "Odd kind", "date": "2026-11-20", "kind": "party"},
    ]}, today)
    assert out == [Found("Pay water bill", date(2026, 11, 20), "deadline")]
    assert title(out[0]) == "Due: Pay water bill"
    assert len(clean("x" * 300)) == 60


def test_html_mail_is_read_as_text():
    raw = (b"Content-Type: text/html; charset=utf-8\r\n\r\n<html><style>p{}</style><p>Return by"
           b" <b>Nov 26</b>&amp; keep the box</p></html>")
    assert text_of(raw) == "Return by Nov 26 & keep the box"


# -- shadow first ------------------------------------------------------------------------------

def test_with_writes_off_it_finds_and_writes_nothing(g):
    rig_mail(g, [msg(1, "Your order of PC parts", "Return within 30 days, by Nov 26")],
             {"Your order of PC parts": RETURN}, writes=False)
    read(g)
    assert g.google.live() == {}
    assert "found but not on your calendar yet" in g.md.digest_line()
    assert "Last day: Amazon return: PC parts" in g.md.digest_line()


def test_each_date_found_is_named_in_the_log_and_again_after_a_start(g, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="harness.mail_dates")
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN}, writes=False)
    read(g)
    assert "mail date: 2026-11-26 Last day: Amazon return: PC parts (from Your order of PC parts)" \
        in caplog.text
    caplog.clear()
    rig_mail(g, [], writes=False)                 # a restart: a fresh reader over the same ledger
    g.md.run(paused=False)
    assert "mail date waiting: 2026-11-26 Last day: Amazon return: PC parts" in caplog.text


def test_mail_that_isnt_picked_never_reaches_the_engine(g):
    rig_mail(g, [msg(1, "Photos from the weekend", "see you soon", sender="Friend <f@x.example>")])
    read(g)
    assert g.engine.asked == [] and g.box.texts_read == []


# -- writing -----------------------------------------------------------------------------------

def test_a_date_lands_free_all_day_with_no_reminder_and_one_undo(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    read(g)
    [(uid, ev)] = g.google.live().items()
    assert ev["summary"] == "Last day: Amazon return: PC parts"
    assert ev["start"] == {"date": "2026-11-26"} and ev["end"] == {"date": "2026-11-27"}
    assert ev["transparency"] == "transparent" and ev["reminders"] == {"useDefault": False}
    assert ev["extendedProperties"]["private"] == google_cal.NOTE_MARK and "attendees" not in ev
    said = g.bot.sent[-1] if g.bot.sent else None
    g.c.outbox.flush()
    said = g.bot.sent[-1]
    assert "From your mail, on your calendar" in said[1] and said[2][0][0][0] == "Undo these"
    nonce = choices.parse(said[2][0][0][1])
    kind = choices.kind_of(g.ledger, nonce)
    batch = g.ledger.db.execute("SELECT target FROM choices WHERE nonce=?", (nonce,)).fetchone()[0]
    assert g.md.on_choice(kind, batch).startswith("Taking those off")
    g.md.run(paused=False)
    assert g.google.live() == {}


def test_the_same_date_from_two_emails_lands_once(g):
    rig_mail(g, [msg(1, "Your order of PC parts"), msg(2, "Your order has shipped")],
             {"Your order of PC parts": RETURN,
              "Your order has shipped": [{"what": "Amazon return for PC parts", "date": "2026-11-26",
                                          "kind": "window_closes"}]})
    read(g)
    assert len(g.google.live()) == 1


def test_a_note_he_edited_isnt_taken_back(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    read(g)
    [uid] = g.google.live()
    g.google.hand_edit(uid, description="keep the receipt")
    batch = g.ledger.db.execute("SELECT batch FROM mail_dates").fetchone()[0]
    g.md.on_choice("mail_dates_undo", batch)
    g.md.run(paused=False)
    assert uid in g.google.live()
    assert g.ledger.db.execute("SELECT state FROM mail_dates").fetchone()[0] == "hands_off"


def test_the_sync_never_treats_a_note_as_its_block(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    read(g)
    blocks, _ = g.client.list_ours(GMAIL, datetime(2026, 11, 1, tzinfo=timezone.utc),
                                   datetime(2026, 12, 31, tzinfo=timezone.utc))
    assert blocks == []


# -- nothing skipped ---------------------------------------------------------------------------

def test_a_long_backlog_carries_on_where_it_stopped(g):
    many = [msg(i, f"Order {i} confirmed") for i in range(1, MAX_TO_ENGINE + 6)]
    rig_mail(g, many)
    g.md.run(paused=False)                # one read sends at most its cap
    assert len(g.engine.asked) == MAX_TO_ENGINE
    read(g)
    assert len(g.engine.asked) == MAX_TO_ENGINE + 5 and len(set(g.engine.asked)) == MAX_TO_ENGINE + 5


def test_a_backlog_reads_on_at_once_then_waits_for_the_clock(g):
    many = [msg(i, f"Order {i} confirmed") for i in range(1, 2 * MAX_TO_ENGINE + 3)]
    rig_mail(g, many)
    for _ in range(6):                 # no clock moves: each read starts as the last one ends
        g.md.run(paused=False)
    assert len(g.engine.asked) == 2 * MAX_TO_ENGINE + 2
    g.box.messages.append(msg(99, "Order 99 confirmed"))
    g.md.run(paused=False)
    g.md.run(paused=False)
    assert "Order 99 confirmed" not in g.engine.asked    # caught up: new mail waits READ_EVERY


def test_a_failed_call_is_tried_again_next_read(g):
    rig_mail(g, [msg(1, "Order 1 confirmed"), msg(2, "Order 2 confirmed"), msg(3, "Order 3 confirmed")])
    g.engine.fail = {"Order 2 confirmed"}
    read(g)
    assert g.engine.asked == ["Order 1 confirmed", "Order 2 confirmed"]
    g.engine.fail = set()
    read(g)
    assert g.engine.asked[2:] == ["Order 2 confirmed", "Order 3 confirmed"]


def test_a_refused_password_is_said_and_nothing_moves(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    g.box.refuse = True
    read(g)
    assert g.ledger.inputs()["mail"]["last_error"] == "Gmail refused the app password"
    assert g.ledger.get_meta("mail_last_uid") in (None, "0")


# -- the work holds script -----------------------------------------------------------------------

def test_googles_failure_email_for_the_work_script_reaches_the_digest(g):
    rig_mail(g, [msg(1, "Summary of failures for Google Apps Script: Work holds",
                     sender="apps-scripts-notifications@google.com")])
    read(g)
    assert "work holds script failed" in g.md.digest_line() and g.engine.asked == []


# -- the mailbox itself, against IMAP's own answers ----------------------------------------------

class FakeIMAP:
    """Answers as imaplib does. Anything that could change the mailbox fails the test."""
    HEAD = ("From: Shop <orders@shop.example>\r\nSubject: Your order of PC parts\r\n"
            "Date: Tue, 20 Oct 2026 08:00:00 -0400\r\nMessage-ID: <{n}@shop.example>\r\n\r\n")

    def __init__(self):
        self.calls = []

    def login(self, user, password):
        self.calls.append(("login", user))
        return "OK", [b"ok"]

    def select(self, box, readonly=False):
        assert box == "INBOX" and readonly is True
        return "OK", [b"3"]

    def status(self, box, what):
        return "OK", [b'"INBOX" (UIDVALIDITY 7)']

    def uid(self, command, *args):
        self.calls.append((command, args))
        assert command in ("SEARCH", "FETCH"), command
        if command == "SEARCH":
            return "OK", [b"4 5"] if args[1].startswith("UID") else [b"3 4 5"]
        if "PEEK[]" in args[1]:
            assert "PEEK" in args[1]
            raw = (b"Content-Type: text/plain\r\n\r\nReturn by Nov 26.")
            return "OK", [(b"5 (UID 5 BODY[]<0> {40}", raw), b")"]
        assert "BODY.PEEK[HEADER" in args[1]
        out = []
        for n in args[0].split(","):
            out += [(f"{n} (UID {n} BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {{99}}".encode(),
                     self.HEAD.format(n=n).encode()), b")"]
        return "OK", out

    def logout(self):
        pass

    def __getattr__(self, name):
        raise AssertionError(f"{name} would change the mailbox")


def test_the_mailbox_reads_only_and_parses_imap():
    from harness.mail_dates import Mailbox
    fake = FakeIMAP()
    box = Mailbox(GMAIL, "pw", connect=lambda: fake)
    validity, start, msgs = box.read(0, None, date(2026, 10, 7))
    assert validity == "7" and start == 0 and [m.uid for m in msgs] == [3, 4, 5]
    assert msgs[0].subject == "Your order of PC parts" and msgs[0].message_id == "<3@shop.example>"
    assert ("SEARCH", (None, "SINCE 07-Oct-2026")) in fake.calls
    assert box.text_for(msgs[2]) == "Return by Nov 26."
    validity, start, msgs = box.read(4, "7", date(2026, 10, 7))
    assert start == 4 and [m.uid for m in msgs] == [5]
    validity, start, msgs = box.read(4, "6", date(2026, 10, 7))    # rebuilt: from the start
    assert start == 0
    box.close()


# -- the second reader's findings ---------------------------------------------------------------

class Refuser(Engine):
    def complete(self, *, system, user, schema):
        subject = next(line[9:] for line in user.splitlines() if line.startswith("Subject: "))
        self.asked.append(subject)
        if subject in self.fail:
            return EngineResult("refused", None, "claude", "m", 100, 0, 0.01)
        return EngineResult("ok", {"items": self.answers.get(subject, [])}, "claude", "m", 100, 20, 0.01)


def test_one_message_the_engine_wont_answer_is_passed_after_three_tries(g):
    rig_mail(g, [msg(1, "Order 1 confirmed"), msg(2, "Order 2 confirmed")])
    g.engine = Refuser()
    g.md.engine_fn = lambda: g.engine
    g.engine.fail = {"Order 1 confirmed"}
    for _ in range(3):
        read(g)
    assert g.engine.asked == ["Order 1 confirmed"] * 3 + ["Order 2 confirmed"]
    spent = g.ledger.db.execute("SELECT COUNT(*) FROM spend WHERE purpose='mail_dates'").fetchone()[0]
    assert spent == 4


def test_an_odd_message_costs_its_spend_not_the_record(g):
    rig_mail(g, [msg(1, "Order 1 confirmed"), msg(2, "Order 2 confirmed")])
    real = g.box.text_for
    g.box.text_for = lambda m: (_ for _ in ()).throw(IndexError("odd header")) if m.uid == 2 else real(m)
    read(g)
    assert g.ledger.db.execute("SELECT COUNT(*) FROM spend WHERE purpose='mail_dates'").fetchone()[0] == 1
    assert g.ledger.get_meta("mail_last_uid") == "1"


def test_different_bills_on_one_day_are_two(g):
    rig_mail(g, [msg(1, "Your water bill"), msg(2, "Your electric bill")],
             {"Your water bill": [{"what": "Pay water bill", "date": "2026-11-20", "kind": "deadline"}],
              "Your electric bill": [{"what": "Pay electric bill", "date": "2026-11-20", "kind": "deadline"}]})
    read(g)
    assert len(g.google.live()) == 2


def test_one_thing_from_several_emails_is_one_entry(g):
    rig_mail(g, [msg(1, "Your service appointment"), msg(2, "Appointment confirmed"),
                 msg(3, "Your policy renewal"), msg(4, "Insurance notice"), msg(5, "Your session")],
             {"Your service appointment": [{"what": "Service appointment at Valley Motors",
                                            "date": "2026-11-13", "kind": "appointment"}],
              "Appointment confirmed": [{"what": "Service appointment: minivan at Valley Motors",
                                         "date": "2026-11-13", "kind": "appointment"}],
              "Your policy renewal": [{"what": "Home insurance policy renews", "date": "2026-11-29",
                                       "kind": "renewal"}],
              "Insurance notice": [{"what": "Hazard insurance expires; send renewal to lender",
                                    "date": "2026-11-29", "kind": "renewal"}],
              "Your session": [{"what": "Fill out intake form before session", "date": "2026-11-13",
                                "kind": "deadline"}]}, writes=False)
    read(g)
    found = [r["what"] for r in g.ledger.db.execute("SELECT what FROM mail_dates WHERE state='found'")]
    assert sorted(found) == ["Fill out intake form before session", "Home insurance policy renews",
                             "Service appointment at Valley Motors"]


def test_a_day_something_doesnt_happen_isnt_carried(g):
    rig_mail(g, [msg(1, "Learning Center Update")],
             {"Learning Center Update": [
                 {"what": "No class: fall break begins", "date": "2026-11-23", "kind": "event"},
                 {"what": "Celebration of Learning, 2-3pm", "date": "2026-11-19", "kind": "event"}]})
    read(g)
    assert [e["summary"] for e in g.google.live().values()] == ["On: Celebration of Learning, 2-3pm"]


def test_what_is_on_his_calendar_already_isnt_added_again(g):
    rig_mail(g, [msg(1, "Your service appointment")],
             {"Your service appointment": [{"what": "Service appointment at Valley Motors",
                                            "date": "2026-11-13", "kind": "appointment"}]})
    g.google.events["his1"] = {"id": "his1", "iCalUID": "his1@google.com", "status": "confirmed",
                               "etag": g.google._etag(), "eventType": "default",
                               "summary": "Valley Motors service",
                               "start": {"dateTime": "2026-11-13T08:00:00-05:00"},
                               "end": {"dateTime": "2026-11-13T09:00:00-05:00"}}
    read(g)
    assert [e["summary"] for e in g.google.live().values()] == ["Valley Motors service"]


def test_school_and_loan_mail_is_read():
    assert picked("A parent <p@x.example>", "Learning Center Update - October 31")
    assert picked("Bank <b@x.example>", "A servicing message from your bank")


def test_new_rules_find_it_all_again_and_leave_his_calendar_alone(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    read(g)
    live = dict(g.google.live())
    g.ledger.db.execute("INSERT INTO mail_dates(key, message_id, what, day, kind, state, event_id,"
                        " batch, created_at) VALUES('k','<9@x>','Old noise','2026-11-20','deadline',"
                        "'found','e',NULL,'2026-11-06T00:00:00+00:00')")
    g.ledger.set_meta("mail_rules", "1")
    g.engine.asked.clear()
    read(g)
    states = dict(g.ledger.db.execute("SELECT what, state FROM mail_dates").fetchall())
    assert "Old noise" not in states and g.google.live() == live
    assert g.engine.asked == []      # its one message is on his calendar already: not asked again


def test_a_title_cant_carry_a_command_or_too_many_dates():
    assert clean("/pause everything") == "pause everything" and clean("ask @somebot now") == "ask somebot now"
    many = {"items": [{"what": f"Thing {i}", "date": "2026-11-20", "kind": "deadline"} for i in range(40)]}
    assert len(parse_items(many, date(2026, 11, 6))) == 5


def test_undo_leaves_a_note_he_renamed(g):
    rig_mail(g, [msg(1, "Your order of PC parts")], {"Your order of PC parts": RETURN})
    read(g)
    [uid] = g.google.live()
    g.google.hand_edit(uid, summary="Return the PC parts!")
    batch = g.ledger.db.execute("SELECT batch FROM mail_dates").fetchone()[0]
    g.md.on_choice("mail_dates_undo", batch)
    g.md.run(paused=False)
    assert uid in g.google.live()


def test_a_failure_email_from_anyone_else_is_ignored(g):
    rig_mail(g, [msg(1, "Summary of failures for Google Apps Script: Work holds", sender="x@spoof.example")])
    read(g)
    assert "work holds script failed" not in g.md.digest_line()


# -- a date that moves ---------------------------------------------------------------------------

APPT = [{"what": "Service appointment at Valley Motors", "date": "2026-11-13", "kind": "appointment"}]


def test_a_rescheduled_email_moves_the_note_instead_of_adding_one(g):
    rig_mail(g, [msg(1, "Your service appointment")], {"Your service appointment": APPT})
    read(g)
    [(uid, ev)] = g.google.live().items()
    g.box.messages.append(msg(2, "Appointment rescheduled"))
    g.engine.answers["Appointment rescheduled"] = [{"what": "Service appointment at Valley Motors",
                                                   "date": "2026-11-20", "kind": "appointment",
                                                   "rescheduled": True}]
    read(g)
    [(uid2, ev2)] = g.google.live().items()
    assert uid2 == uid and ev2["start"] == {"date": "2026-11-20"} and ev2["end"] == {"date": "2026-11-21"}
    g.c.outbox.flush()
    assert "moved there, as the email says" in g.bot.sent[-1][1]


def test_a_second_appointment_that_isnt_a_reschedule_is_its_own(g):
    rig_mail(g, [msg(1, "Your service appointment")], {"Your service appointment": APPT})
    read(g)
    g.box.messages.append(msg(2, "Your next service appointment"))
    g.engine.answers["Your next service appointment"] = [{"what": "Service appointment at Valley Motors",
                                                         "date": "2027-01-15", "kind": "appointment"}]
    read(g)
    assert sorted(e["start"]["date"] for e in g.google.live().values()) == ["2026-11-13", "2027-01-15"]


def test_a_note_he_moved_himself_isnt_added_again_when_the_email_comes(g):
    rig_mail(g, [msg(1, "Your service appointment")], {"Your service appointment": APPT})
    read(g)
    [uid] = g.google.live()
    g.google.hand_edit(uid, start={"date": "2026-11-20"}, end={"date": "2026-11-21"})   # he said so in chat
    g.box.messages.append(msg(2, "Appointment rescheduled"))
    g.engine.answers["Appointment rescheduled"] = [{"what": "Service appointment at Valley Motors",
                                                   "date": "2026-11-20", "kind": "appointment",
                                                   "rescheduled": True}]
    read(g)
    assert [e["start"]["date"] for e in g.google.live().values()] == ["2026-11-20"]


# -- already on his calendar, whatever it's called -------------------------------------------------

def test_a_booking_at_the_time_of_his_own_event_isnt_added(g):
    rig_mail(g, [msg(1, "Thanks for Booking")],
             {"Thanks for Booking": [{"what": "Counseling session, 8:00am", "date": "2026-11-09",
                                      "kind": "appointment", "time": "08:00"}]})
    g.google.events["his1"] = {"id": "his1", "iCalUID": "his1@google.com", "status": "confirmed",
                               "etag": g.google._etag(), "eventType": "default", "summary": "Therapy",
                               "start": {"dateTime": "2026-11-09T08:00:00-05:00"},
                               "end": {"dateTime": "2026-11-09T09:00:00-05:00"}}
    read(g)
    assert [e["summary"] for e in g.google.live().values()] == ["Therapy"]


def test_a_school_event_on_family_isnt_added(g):
    from fake_caldav import FAMILY_PATH
    g.icloud.seed(FAMILY_PATH + "skate.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:skate", "DTSTAMP:20261101T120000Z",
        "DTSTART:20261120T180000Z", "DTEND:20261120T200000Z", "SUMMARY:Skating trip",
        "END:VEVENT", "END:VCALENDAR", ""]))
    rig_mail(g, [msg(1, "Learning Center Update")],
             {"Learning Center Update": [{"what": "Field trip: roller skating at the rink",
                                          "date": "2026-11-20", "kind": "event", "time": ""}]})
    read(g)
    assert g.google.live() == {}


def test_a_time_that_isnt_a_time_is_dropped():
    [f] = parse_items({"items": [{"what": "Thing", "date": "2026-11-20", "kind": "event",
                                  "time": "8am", "rescheduled": False}]}, date(2026, 11, 6))
    assert f.at == ""


def test_a_ledger_from_before_gets_the_time_column(tmp_path):
    from harness.ledger import Ledger
    path = str(tmp_path / "old.db")
    old = Ledger(path)
    old.db.execute("ALTER TABLE mail_dates DROP COLUMN at")
    old.db.close()
    again = Ledger(path)
    assert "at" in {r[1] for r in again.db.execute("PRAGMA table_info(mail_dates)")}


def test_a_word_in_another_form_is_the_same_name(g):
    """The school's "Skate Center" trip is Family's "Skating" outing: one thing, not two."""
    from fake_caldav import FAMILY_PATH
    g.icloud.seed(FAMILY_PATH + "skate2.ics", "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:skate2", "DTSTAMP:20261101T120000Z",
        "DTSTART:20261120T180000Z", "DTEND:20261120T200000Z", "SUMMARY:Skating LC",
        "END:VEVENT", "END:VCALENDAR", ""]))
    rig_mail(g, [msg(1, "Learning Center Update")],
             {"Learning Center Update": [{"what": "Field trip: Sunny's Skate Center",
                                          "date": "2026-11-20", "kind": "event", "time": ""}]})
    read(g)
    assert g.google.live() == {}


def test_word_forms_match_but_different_things_stay_apart():
    from harness.mail_dates import _names
    assert _names("Skate Center") & _names("Skating")
    assert _names("Celebrations") & _names("Celebration of Learning")
    assert not _names("Water bill") & _names("Electric bill")
    assert not _names("Class picture day") & _names("Glass recycling")


# -- at its time ---------------------------------------------------------------------------------

TIMED_APPT = [{"what": "Service appointment at Valley Motors", "date": "2026-11-13", "kind": "appointment",
               "time": "08:00"}]


def test_an_appointment_with_a_time_lands_at_that_time_with_his_usual_reminder(g):
    rig_mail(g, [msg(1, "Your service appointment")], {"Your service appointment": TIMED_APPT})
    read(g)
    [(uid, ev)] = g.google.live().items()
    start = datetime.fromisoformat(ev["start"]["dateTime"])
    assert start == datetime(2026, 11, 13, 8, tzinfo=ZoneInfo(TZ))
    assert datetime.fromisoformat(ev["end"]["dateTime"]) - start == timedelta(hours=1)
    # Nov 11: a timed appointment is a real one, so it's busy; this email gave no address.
    assert ev["transparency"] == "opaque" and "location" not in ev and ev["reminders"] == {"useDefault": True}
    g.c.outbox.flush()
    assert "Fri Nov 13 at 8:00 AM: Appt: Service appointment at Valley Motors" in g.bot.sent[-1][1]
    batch = g.ledger.db.execute("SELECT batch FROM mail_dates").fetchone()[0]
    g.md.on_choice("mail_dates_undo", batch)
    g.md.run(paused=False)
    assert g.google.live() == {}                   # undo still finds it, at its time


def test_a_deadline_with_a_time_stays_all_day(g):
    rig_mail(g, [msg(1, "Your bill")], {"Your bill": [
        {"what": "Pay by check", "date": "2026-11-20", "kind": "deadline", "time": "17:00"}]})
    read(g)
    [(uid, ev)] = g.google.live().items()
    assert ev["start"] == {"date": "2026-11-20"} and ev["reminders"] == {"useDefault": False}


def test_an_appointment_written_all_day_before_moves_to_its_time_once(g):
    rig_mail(g, [msg(1, "Your service appointment"), msg(2, "Your class")],
             {"Your service appointment": TIMED_APPT,
              "Your class": [{"what": "Pottery class", "date": "2026-11-14", "kind": "event", "time": "10:00"}]})
    g.ledger.set_meta("mail_retimed", "1")         # as on the Pi: already "run" under the old code
    read(g)
    for uid, ev in list(g.google.events.items()):  # what the old code wrote: all day
        g.google.events[uid].update(google_cal.note_span(date.fromisoformat(ev["start"]["dateTime"][:10])),
                                    reminders={"useDefault": False})
    appt, pottery = sorted(g.google.live(), key=lambda u: g.google.events[u]["summary"])
    g.google.hand_edit(pottery, description="bring an apron")          # his now
    g.ledger.set_meta("mail_retimed", "")
    g.md.run(paused=False)
    ev = g.google.events[appt]
    assert datetime.fromisoformat(ev["start"]["dateTime"]) == datetime(2026, 11, 13, 8, tzinfo=ZoneInfo(TZ))
    assert ev["reminders"] == {"useDefault": True}
    assert g.google.events[pottery]["start"] == {"date": "2026-11-14"}
    writes = len(g.google.writes())
    g.md.run(paused=False)
    assert len(g.google.writes()) == writes        # once


def test_the_receipt_names_every_date_never_and_n_more(g):
    subjects = [f"Your order {n}" for n in range(3)]
    answers = {s: [{"what": f"Return {s} part {i}",
                    "date": (date(2026, 11, 20) + timedelta(days=5 * n + i)).isoformat(),
                    "kind": "window_closes"} for i in range(5)] for n, s in enumerate(subjects)}
    rig_mail(g, [msg(n + 1, s) for n, s in enumerate(subjects)], answers)
    read(g)
    g.c.outbox.flush()
    text = g.bot.sent[-1][1]
    assert text.count("Last day: Return") == 15 and "more" not in text


# -- 0.21.0: a timed appointment from his mail is a real one (Nov 11) ---------------------------
# His car's service appointment was made free with no address on Nov 7, so neither work nor
# Family saw it, though the dealer's emails gave the address in a footer. Invented names.

DEALER = "Example Motors Service <service@motors.example>"
VAN = [{"what": "Service appointment: 2024 Example Van", "date": "2026-11-13", "kind": "appointment",
        "time": "08:00", "address": "12 Example Hwy / Springfield, VA 24401"}]
PLACE = "12 Example Hwy, Springfield, VA 24401"


def appt_of(g):
    [(uid, ev)] = [(u, e) for u, e in g.google.live().items() if e["summary"].startswith("Appt:")]
    return uid, ev


def test_a_timed_appointment_is_busy_at_the_address_its_email_gave(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER),
                 msg(2, "Your class", sender="Studio <hi@studio.example>"),
                 msg(3, "Your order of PC parts")],
             {"Your service appointment": VAN, "Your order of PC parts": RETURN,
              "Your class": [{"what": "Pottery class", "date": "2026-11-14", "kind": "event", "time": "10:00",
                              "address": "1 Clay Ln, Springfield, VA 24401"}]})
    read(g)
    uid, ev = appt_of(g)
    assert ev["summary"] == "Appt: Service appointment: 2024 Example Van"
    start = datetime.fromisoformat(ev["start"]["dateTime"])
    assert start == datetime(2026, 11, 13, 8, tzinfo=ZoneInfo(TZ))
    assert datetime.fromisoformat(ev["end"]["dateTime"]) - start == timedelta(hours=1)
    assert ev["transparency"] == "opaque" and ev["location"] == PLACE and ev["reminders"] == {"useDefault": True}
    rest = {e["summary"]: e for e in g.google.live().values() if not e["summary"].startswith("Appt:")}
    assert all(e["transparency"] == "transparent" and "location" not in e for e in rest.values())
    assert rest["Last day: Amazon return: PC parts"]["start"] == {"date": "2026-11-26"}
    g.c.outbox.flush()
    told = g.bot.sent[-1][1]
    assert f"Fri Nov 13 at 8:00 AM: Appt: Service appointment: 2024 Example Van, at {PLACE}" in told
    assert "busy, so work and Family see it" in told and "The rest are free" in told


def test_the_address_can_come_from_another_email_about_the_same_appointment(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER), msg(2, "Service reminder", sender=DEALER),
                 msg(3, "Your tire appointment", sender="Other Shop <hi@other.example>")],
             {"Your service appointment": [{**VAN[0], "address": ""}], "Service reminder": VAN,
              "Your tire appointment": [{**VAN[0], "what": "Tire check", "date": "2026-11-20", "address": ""}]})
    read(g)
    by_title = {e["summary"]: e for e in g.google.live().values()}
    assert by_title["Appt: Service appointment: 2024 Example Van"]["location"] == PLACE
    assert "location" not in by_title["Appt: Tire check"]                # another sender, another day


def test_an_address_that_turns_up_later_is_added_once(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)],
             {"Your service appointment": [{**VAN[0], "address": ""}]})
    read(g)
    uid, ev = appt_of(g)
    assert ev["transparency"] == "opaque" and "location" not in ev
    g.box.messages.append(msg(2, "Service reminder", sender=DEALER))
    g.engine.answers["Service reminder"] = VAN
    read(g)
    uid, ev = appt_of(g)
    assert ev["location"] == PLACE
    writes = len(g.google.writes())
    g.md.run(paused=False)
    assert len(g.google.writes()) == writes


def test_one_made_free_before_is_made_busy_with_the_address_a_second_read_finds(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)],
             {"Your service appointment": [{**VAN[0], "address": ""}]})
    read(g)
    uid, _ = appt_of(g)
    # As it was on his calendar from Nov 7: free, no address, recorded before any of this.
    g.google.events[uid]["transparency"] = "transparent"
    g.ledger.db.execute("UPDATE mail_dates SET busy=0, shown='', sender='', place=''")
    g.engine.answers["Your service appointment"] = VAN    # the same email, looked up again for its address
    again(g)
    uid, ev = appt_of(g)
    assert ev["transparency"] == "opaque" and ev["location"] == PLACE
    assert len(g.google.live()) == 1


def test_one_he_changed_is_his_and_left_alone(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)],
             {"Your service appointment": [{**VAN[0], "address": ""}]})
    read(g)
    uid, _ = appt_of(g)
    g.google.events[uid]["transparency"] = "transparent"
    g.ledger.db.execute("UPDATE mail_dates SET busy=0")
    g.google.hand_edit(uid, description="bring the spare key")         # his now
    g.md.run(paused=False)
    assert g.google.events[uid]["transparency"] == "transparent" and "location" not in g.google.events[uid]
    assert g.ledger.db.execute("SELECT busy FROM mail_dates").fetchone()[0] == 2


def test_undo_still_finds_a_busy_appointment_at_its_address(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)], {"Your service appointment": VAN})
    read(g)
    batch = g.ledger.db.execute("SELECT batch FROM mail_dates").fetchone()[0]
    g.md.on_choice("mail_dates_undo", batch)
    g.md.run(paused=False)
    assert g.google.live() == {}


def test_a_busy_appointment_from_mail_is_his_real_event_for_school_runs():
    from harness import ical
    from harness.family_gmail import _is_real
    start = datetime(2026, 11, 13, 8, tzinfo=ZoneInfo(TZ))
    uid = google_cal.event_id("mail:x") + "@google.com"

    def occ(summary, transparent):
        return ical.Occurrence(start, start + timedelta(hours=1), False, summary, GMAIL, transparent,
                               uid, "", (), PLACE, "")
    assert _is_real(occ("Appt: Service appointment: 2024 Example Van", False))
    assert not _is_real(occ("Appt: Service appointment: 2024 Example Van", True))
    assert not _is_real(occ("Due: Pay by check", True)) and not _is_real(occ("Busy (school drop-off)", False))


def test_only_a_street_address_is_kept():
    from harness.mail_dates import street
    assert street("12 Example Hwy / Springfield, VA 24401") == PLACE
    assert street("Example Motors, 12 Example Hwy, Springfield, VA 24401") == PLACE
    assert street("see https://motors.example/map") == "" and street("call 540-555-0100") == ""


def test_an_email_read_again_for_its_address_never_lands_a_second_entry(g):
    """Looked up again, the same email may be worded differently: it only fills in who sent it and
    where, and adds nothing."""
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)],
             {"Your service appointment": [{**VAN[0], "address": ""}]})
    read(g)
    uid, _ = appt_of(g)
    g.google.events[uid]["transparency"] = "transparent"
    g.ledger.db.execute("UPDATE mail_dates SET busy=0, shown='', sender='', place=''")
    g.engine.answers["Your service appointment"] = [{**VAN[0], "what": "Example Van service", "time": "08:45"}]
    again(g)
    assert len(g.google.live()) == 1
    uid, ev = appt_of(g)
    assert ev["transparency"] == "opaque" and ev["location"] == PLACE
    assert g.ledger.db.execute("SELECT COUNT(*) FROM mail_dates").fetchone()[0] == 1


def test_only_the_emails_behind_written_appointments_are_looked_up_again(g):
    """No full re-read (Nov 11 review): the rules stay, what was skipped stays, the read position
    stays, and only the email behind a timed appointment written before addresses is asked for."""
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER), msg(2, "Your order of PC parts"),
                 msg(3, "Your order shipped")],
             {"Your service appointment": [{**VAN[0], "address": ""}], "Your order of PC parts": RETURN,
              "Your order shipped": RETURN})
    read(g)
    skipped = g.ledger.db.execute("SELECT COUNT(*) FROM mail_dates WHERE state='skipped'").fetchone()[0]
    assert skipped == 1                                   # the shipping note's return date: once
    g.ledger.db.execute("UPDATE mail_dates SET sender='' WHERE kind='appointment'")   # from before 0.21.0
    last, asked = g.ledger.get_meta("mail_last_uid"), list(g.engine.asked)
    g.engine.answers["Your service appointment"] = VAN
    again(g)
    assert g.box.looked_up == [["<1@mail.example>"]]
    assert g.engine.asked == asked + ["Your service appointment"]
    assert g.ledger.get_meta("mail_last_uid") == last and g.ledger.get_meta("mail_rules") == "4"
    assert g.ledger.db.execute("SELECT COUNT(*) FROM mail_dates WHERE state='skipped'").fetchone()[0] == skipped
    uid, ev = appt_of(g)
    assert ev["location"] == PLACE
    again(g)
    assert len(g.box.looked_up) == 1                      # once: it knows who sent it now


def test_an_email_that_cant_be_found_is_looked_for_once(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)],
             {"Your service appointment": [{**VAN[0], "address": ""}]})
    read(g)
    g.ledger.db.execute("UPDATE mail_dates SET sender=''")
    g.box.messages = []                                   # deleted since
    again(g)
    again(g)
    assert len(g.box.looked_up) == 1
    assert g.ledger.db.execute("SELECT sender FROM mail_dates").fetchone()[0] == "-"


def test_the_next_digest_names_the_ones_made_busy(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)], {"Your service appointment": VAN})
    read(g)
    uid, _ = appt_of(g)
    g.google.events[uid]["transparency"] = "transparent"
    g.google.events[uid].pop("location", None)
    g.ledger.db.execute("UPDATE mail_dates SET busy=0, shown=''")
    g.md.run(paused=False)
    line = g.md.digest_line()
    assert ("From your mail, now busy so work and Family see them: Fri Nov 13 at 8:00 AM: "
            f"Appt: Service appointment: 2024 Example Van, at {PLACE}.") in line


def test_a_timed_class_or_event_stays_free(g):
    rig_mail(g, [msg(1, "Your class", sender="Studio <hi@studio.example>")],
             {"Your class": [{"what": "Pottery class", "date": "2026-11-14", "kind": "event", "time": "10:00",
                              "address": "1 Clay Ln, Springfield, VA 24401"}]})
    read(g)
    [(uid, ev)] = g.google.live().items()
    assert ev["transparency"] == "transparent" and "location" not in ev
    assert datetime.fromisoformat(ev["start"]["dateTime"]) == datetime(2026, 11, 14, 10, tzinfo=ZoneInfo(TZ))


def test_a_rescheduled_appointment_takes_the_new_emails_place(g):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)], {"Your service appointment": VAN})
    read(g)
    g.box.messages.append(msg(2, "Appointment rescheduled", sender=DEALER))
    g.engine.answers["Appointment rescheduled"] = [{**VAN[0], "date": "2026-11-20", "time": "09:00",
                                                     "rescheduled": True,
                                                     "address": "40 New Rd, Springfield, VA 24401"}]
    read(g)
    uid, ev = appt_of(g)
    assert datetime.fromisoformat(ev["start"]["dateTime"]) == datetime(2026, 11, 20, 9, tzinfo=ZoneInfo(TZ))
    assert ev["location"] == "40 New Rd, Springfield, VA 24401" and ev["transparency"] == "opaque"
    assert len(g.google.live()) == 1


def test_the_engine_is_told_where_the_address_comes_from():
    from harness.mail_dates import SYSTEM, output_schema
    assert "where it takes place" in SYSTEM and "not the sender's mailing, office or unsubscribe address" in SYSTEM
    assert "empty if unsure" in SYSTEM
    assert "address" in output_schema()["properties"]["output"]["properties"]["items"]["items"]["required"]
