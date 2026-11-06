"""Follow-through: dates from his mail onto his Gmail calendar. All names are invented."""
from datetime import date, datetime, timedelta, timezone

from harness import choices, google_cal
from harness.engines import EngineResult
from harness.mail_dates import (MAX_TO_ENGINE, MailDates, Message, clean, parse_items, picked,
                                text_of, title, Found)
from fake_caldav import no_network  # noqa: F401  (autouse)
from fakes import SyncExecutor
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
                     writes_on=lambda: g.writes, tz=TZ, mailbox=g.box, sleep=lambda s: None)
    g.md.bind(1)
    return g


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
