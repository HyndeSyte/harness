"""0.21.1: an input that stops is never silent (Nov 11).

From Nov 8 Gmail refused the Harness's app password, after a Google password change, and for
three days nothing said so. These check that a refused key is told at once, once an outage, with
the fix he can do from his phone; that anything else waits six hours with no success; that the
digest names each input that's down and says in one line which came back; and that a failed mail
read is logged by its kind, never by what Gmail said. All names are invented.
"""
import imaplib
import logging
import re
import sqlite3
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import caldav, daily, digest, discord_chat, google_cal, inputs, mail_dates
from harness.config import Config
from harness.ledger import Ledger
from harness.net import HttpResponse
from conftest import OWNER
from fake_caldav import APP_PASSWORD, APPLE_ID, FAMILY_URL, FakeICloud, no_network  # noqa: F401
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL
from test_family_gmail import KEY, FakeGoogle, g  # noqa: F401
from test_mail_dates import DEALER, VAN, again, msg, read, rig_mail

TZ = "America/New_York"
LAST_GOOD = datetime(2026, 11, 8, 21, 53, tzinfo=timezone.utc)      # Sun Nov 8, 4:53 PM in New York
REFUSED = mail_dates.WORDS["refused"]
UNREACHABLE = mail_dates.WORDS["unreachable"]


def watch(ledger, seen=None, *, off=()):
    """Mail, Family, Google and judging all set up, but those named off."""
    names = (inputs.MAIL, inputs.FAMILY, inputs.GOOGLE, inputs.MEANING)
    return inputs.Watch(ledger, seen, tz=TZ,
                        active={n: (lambda n=n: n not in off) for n in names})


def sent(ledger):
    return ledger.db.execute("SELECT * FROM outbox ORDER BY id").fetchall()


def readable(text):
    """As he reads it: no stamps, no ids, no em or en dashes."""
    assert not re.search(r"\d{4}-\d\d-\d\d|\d\d:\d\d:\d\d|[—–]|job ", text), text


def refused_since_last_good(ledger, clock):
    clock.t = LAST_GOOD
    ledger.input_ok("mail")
    clock.advance(minutes=5)
    ledger.input_failed("mail", REFUSED, "refused")


# -- 1. a refused key: told at once, once an outage ----------------------------------------------

def test_gmail_refusing_the_app_password_is_told_at_once_with_the_fix(ledger, clock):
    refused_since_last_good(ledger, clock)
    w = watch(ledger)
    assert w.tell(OWNER) == 1
    [row] = sent(ledger)
    text = row["text"]
    assert row["kind"] == "input" and row["buttons_json"] is None and row["binds_json"] is None
    assert text.startswith("<b>Harness can't read your email</b>\n")
    assert "No email has been read since 4:53 PM today: Gmail refused the app password." in text
    assert "Dates and addresses from your email aren't being added." in text
    assert ("make a new app password at https://myaccount.google.com/apppasswords named Harness, then "
            "paste it into the Harness page in Home Assistant, in the Gmail mail field") in text
    readable(text)
    for _ in range(24):                    # two hours of reads every five minutes, all refused
        clock.advance(minutes=5)
        ledger.input_failed("mail", REFUSED, "refused")
        assert w.tell(OWNER) == 0
    clock.advance(days=3)
    ledger.input_failed("mail", REFUSED, "refused")
    assert w.tell(OWNER) == 0 and len(sent(ledger)) == 1


def test_once_it_works_again_a_new_refusal_is_a_new_outage(ledger, clock):
    refused_since_last_good(ledger, clock)
    w = watch(ledger)
    w.tell(OWNER)
    clock.advance(hours=2)
    ledger.input_ok("mail")                            # he pasted a new one
    assert w.tell(OWNER) == 0 and len(sent(ledger)) == 1      # no "it's back" message
    clock.advance(days=1)
    ledger.input_failed("mail", REFUSED, "refused")
    assert w.tell(OWNER) == 1 and len(sent(ledger)) == 2
    assert "since 6:58 PM yesterday" in sent(ledger)[-1]["text"]


def test_icloud_turning_the_app_specific_password_down_is_told_at_once(ledger, clock):
    seen, fake = inputs.Seen(), FakeICloud()
    good = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL), seen=seen)
    w = inputs.Watch(ledger, seen, tz=TZ, active={inputs.FAMILY: good.configured})
    assert good.items_between(clock(), clock() + timedelta(days=1), TZ) is not None
    w.drain()
    assert ledger.inputs()["family"]["last_success_at"] and w.tell(OWNER) == 0
    clock.advance(hours=1)
    revoked = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, "wxyz-wxyz-wxyz-wxyz", FAMILY_URL), seen=seen)
    assert revoked.items_between(clock(), clock() + timedelta(days=1), TZ) is None
    w.drain()
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert text.startswith("<b>Harness can't reach the Family calendar</b>")
    assert ": iCloud refused the app-specific password." in text
    assert ("make a new app-specific password at https://account.apple.com (Sign-In and Security, then "
            "App-Specific Passwords) named Harness") in text
    assert "Family calendar app-specific password field" in text
    assert "wxyz" not in text and APP_PASSWORD not in text
    readable(text)
    fake.down = True                                   # then no answer at all: the same outage
    assert revoked.items_between(clock(), clock() + timedelta(days=1), TZ) is None
    w.drain()
    assert ledger.inputs()["family"]["kind"] == "unreachable" and w.tell(OWNER) == 0


def test_icloud_not_answering_isnt_a_refusal(ledger, clock):
    seen, fake = inputs.Seen(), FakeICloud()
    fake.down = True
    client = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL), seen=seen)
    assert client.items_between(clock(), clock() + timedelta(days=1), TZ) is None
    assert seen.take() == {"family": ("unreachable", "couldn't reach iCloud")}


class SignIn(FakeGoogle):
    """Google, answering a sign-in it turns down with what it says then."""

    def __init__(self, status, said):
        super().__init__()
        self.token_status, self.said = status, said

    def _token(self, method, body):
        if self.token_status != 200:
            self.token_calls += 1
            return HttpResponse(self.token_status, {}, self.said)
        return super()._token(method, body)


@pytest.mark.parametrize("status, said, kind", [
    (400, b'{"error": "invalid_grant", "error_description": "Invalid JWT Signature."}', "refused"),
    (401, b'{"error": "invalid_client", "error_description": "The OAuth client was not found."}', "refused"),
    (400, b'{"error": "invalid_grant", "error_description": "Invalid JWT: Token must be a short-lived '
          b'token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT '
          b'claim."}', "error"),                         # the Pi's clock: no new key would fix it
    (503, b"", "unreachable"),
])
def test_google_turning_the_key_down_is_told_apart_from_its_clock_or_an_outage(clock, status, said, kind):
    seen = inputs.Seen()
    client = google_cal.GoogleCalendar(SignIn(status, said), lambda: KEY, clock, seen=seen)
    assert client.events_between(GMAIL, clock(), clock() + timedelta(days=1)) is None
    assert seen.take()["google"][0] == kind


def test_a_refused_google_key_is_told_with_the_fix(ledger, clock):
    seen = inputs.Seen()
    client = google_cal.GoogleCalendar(SignIn(400, b'{"error": "invalid_grant"}'), lambda: KEY, clock,
                                       seen=seen)
    client.list_ours(GMAIL, clock(), clock() + timedelta(days=1))
    w = watch(ledger, seen)
    w.drain()
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert ": Google refused the service account key." in text
    assert "https://console.cloud.google.com" in text and "Gmail calendar key field" in text
    assert "BEGIN PRIVATE KEY" not in text
    readable(text)


def test_a_calendar_google_wont_show_isnt_taken_for_a_refused_key(clock):
    seen, fake = inputs.Seen(), FakeGoogle()
    client = google_cal.GoogleCalendar(fake, lambda: KEY, clock, seen=seen)
    assert client.events_between(GMAIL, clock(), clock() + timedelta(days=1)) == []
    assert seen.take() == {"google": ("ok", "")}
    fake.shared = False
    assert client.events_between(GMAIL, clock(), clock() + timedelta(days=1)) is None
    assert seen.take()["google"] == ("denied", google_cal.DENIED)
    fake.shared, fake.fail["GET"] = True, "drop"
    assert client.events_between(GMAIL, clock(), clock() + timedelta(days=1)) is None
    assert seen.take()["google"] == ("unreachable", "couldn't reach Google")


def test_the_names_the_clients_use_are_the_watchs():
    assert (caldav.INPUT, google_cal.INPUT) == (inputs.FAMILY, inputs.GOOGLE)


# -- 2. anything else: after six hours with no success, once ---------------------------------------

def test_any_other_failure_is_told_after_six_hours_with_no_success_once(ledger, clock):
    clock.t = LAST_GOOD
    ledger.input_ok("mail")
    w = watch(ledger)
    clock.advance(minutes=5)
    first = clock()
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    while clock() - first < timedelta(hours=6) - timedelta(minutes=5):
        clock.advance(minutes=5)
        ledger.input_failed("mail", UNREACHABLE, "unreachable")
        assert w.tell(OWNER) == 0
    clock.advance(minutes=5)                           # six hours since the first failure
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert "No email has been read since 4:53 PM today: couldn't reach Gmail." in text
    assert text.endswith("Harness keeps trying, and the morning digest will say when it works again.")
    readable(text)
    clock.advance(hours=12)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert w.tell(OWNER) == 0 and len(sent(ledger)) == 1


def test_a_success_inside_six_hours_ends_it_unsaid(ledger, clock):
    w = watch(ledger)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    clock.advance(hours=5, minutes=55)
    ledger.input_ok("mail")
    clock.advance(hours=1)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    clock.advance(hours=5)
    assert w.tell(OWNER) == 0 and sent(ledger) == []
    assert w.back_line() == ""                     # he never knew, so nothing to say came back


def test_a_refusal_later_in_the_same_outage_is_still_told(ledger, clock):
    w = watch(ledger)
    ledger.input_failed("google", "couldn't reach Google", "unreachable")
    clock.advance(hours=6)
    assert w.tell(OWNER) == 1
    ledger.input_failed("google", "Google refused the service account key", "refused")
    assert w.tell(OWNER) == 1 and w.tell(OWNER) == 0
    first, second = (r["text"] for r in sent(ledger))
    assert "Harness keeps trying" in first and "Create new key" in second


@pytest.mark.parametrize("name, words, kind, says", [
    ("meaning", "the engine refused the call (key or billing)", "engine",
     "check the Anthropic account's billing, or put a new Anthropic API key on the Harness page"),
    ("meaning", "this month's limit for judging events is used up", "limit",
     "It picks up again when the monthly limit resets."),
    ("google", google_cal.DENIED, "denied",
     'give the service account Harness uses "Make changes and see all event details"'),
])
def test_what_he_can_do_follows_the_kind(ledger, clock, name, words, kind, says):
    ledger.input_failed(name, words, kind)
    clock.advance(hours=6)
    w = watch(ledger)
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert says in text and words in text
    readable(text)


def test_an_input_that_isnt_set_up_is_never_told_or_named(ledger, clock):
    ledger.input_failed("mail", REFUSED, "refused")
    clock.advance(hours=7)
    w = watch(ledger, off=("mail",))
    assert w.tell(OWNER) == 0 and w.digest_lines() == []


def test_a_calendar_not_shared_any_more_names_the_account_to_share_with(ledger, clock):
    ledger.input_failed("google", google_cal.DENIED, "denied")
    clock.advance(hours=6)
    w = inputs.Watch(ledger, tz=TZ, active={inputs.GOOGLE: lambda: True}, account=lambda: "harness@example.iam.gserviceaccount.com")
    assert w.tell(OWNER) == 1
    assert 'give harness@example.iam.gserviceaccount.com "Make changes and see all event details".' in sent(ledger)[0]["text"]


def test_a_calendar_address_is_told_by_its_name(ledger, clock):
    ledger.input_failed("calendar:abcd", "Google says this address doesn't exist (was it reset?)")
    clock.advance(hours=6)
    w = inputs.Watch(ledger, tz=TZ, feeds=lambda: [("calendar:abcd", "owner@example.com")])
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert text.startswith("<b>Harness can't read one of your calendars</b>\nThe calendar owner@example.com "
                           "hasn't been read since 9:00 AM today: Google says this address doesn't exist")


# -- 3. the morning digest ---------------------------------------------------------------------------

def test_the_digest_names_each_input_down_in_plain_words(ledger, clock):
    refused_since_last_good(ledger, clock)
    ledger.input_ok("family")
    clock.t = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)       # Wed, 7:00 AM
    ledger.input_failed("mail", REFUSED, "refused")
    d = daily.gather(ledger, Config(owner_user_id=OWNER), paused=False, watch=watch(ledger))
    assert d.state == "attention"
    assert "• Email from Gmail: not working since Sun Nov 8 at 4:53 PM; Gmail refused the app password" in d.text
    assert "iCloud" not in d.text and "Working again" not in d.text


def test_when_one_comes_back_the_next_digest_says_so_in_one_line(ledger, clock):
    refused_since_last_good(ledger, clock)
    clock.t = datetime(2026, 11, 9, 11, 0, tzinfo=timezone.utc)        # Mon, 6:00 AM
    ledger.input_failed("family", "couldn't reach iCloud", "unreachable")
    clock.advance(hours=1)                                     # the digest, an hour on
    w = watch(ledger)
    assert w.tell(OWNER) == 1                                  # the mail, at once; Family not yet
    config = Config(owner_user_id=OWNER)
    d = daily.gather(ledger, config, paused=False, watch=w)
    assert "Family calendar through iCloud: not working since" in d.text   # named, so known now
    daily.deliver(ledger, config, d)
    w.digest_sent()
    clock.advance(hours=3)
    ledger.input_ok("mail")                                    # he made a new password
    ledger.input_ok("family")
    clock.t = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)       # Tue, 7:00 AM
    d = daily.gather(ledger, config, paused=False, watch=w)
    back = [line for line in d.text.split("\n") if "Working again" in line]
    assert back == ["Working again: Email from Gmail since 10:00 AM yesterday; "
                    "Family calendar through iCloud since 10:00 AM yesterday."]
    assert "not working" not in d.text
    daily.deliver(ledger, config, d)
    w.digest_sent()
    assert "Working again" not in daily.gather(ledger, config, paused=False, watch=w).text
    kinds = [r["kind"] for r in sent(ledger)]
    assert kinds == ["input", "digest", "digest"]              # never a separate "it's back"


def test_a_calendar_address_that_failed_since_its_last_read_is_named_before_it_is_stale():
    now = datetime(2026, 10, 21, 11, 0, tzinfo=timezone.utc)
    feed = digest.InputCoverage("Calendar owner", now - timedelta(minutes=30), timedelta(hours=2),
                                "Google answered 500", failing=True)
    d = digest.compose(now=now, tz=TZ, inputs=[feed], waiting=[], failures=[], low_balance=[],
                       canary_ok=True, config_unchanged_since=now)
    assert d.state == "attention" and "Calendar owner: no good read since Wed 6:30 AM (Google answered 500)" in d.text


# -- 4. the log --------------------------------------------------------------------------------------

def fails(g, error):
    def read_(*a):
        raise error
    g.box.read = read_


def test_a_failed_mail_read_is_a_warning_by_its_kind_at_most_hourly(g, caplog):
    rig_mail(g, [msg(1, "Your order of PC parts")])
    caplog.set_level(logging.INFO, logger="harness.mail_dates")

    def warned():
        return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    fails(g, imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials for someone@example.org "
                                 "(Failure)"))
    read(g)
    assert warned() == ["mail read failed: refused"]
    assert g.ledger.inputs()["mail"]["kind"] == "refused"
    for _ in range(11):                                # every five minutes, the same, for most of an hour
        g.clock.advance(minutes=5)
        read(g)
    assert warned() == ["mail read failed: refused"]
    fails(g, imaplib.IMAP4.abort("socket error: EOF"))     # the kind changes: said at once
    read(g)
    assert warned()[-1] == "mail read failed: unreachable"
    g.clock.advance(hours=1)                           # the same kind an hour on: said again
    read(g)
    assert warned()[-2:] == ["mail read failed: unreachable"] * 2
    assert "someone@example.org" not in caplog.text and "abcdefghijklmnop" not in caplog.text
    assert "Invalid credentials" not in caplog.text


def test_a_failed_look_up_is_a_warning_and_counts_against_the_mail(g, caplog):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)], {"Your service appointment": VAN})
    read(g)
    g.ledger.db.execute("UPDATE mail_dates SET sender=''")
    caplog.set_level(logging.INFO, logger="harness.mail_dates")

    def refuse(*a):
        raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")
    g.box.find = refuse
    again(g)
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING] == \
        ["mail look-up failed: refused"]
    row = g.ledger.inputs()["mail"]
    assert row["kind"] == "refused" and row["last_error"] == REFUSED


@pytest.mark.parametrize("error, kind", [
    (imaplib.IMAP4.error("b'[AUTHENTICATIONFAILED] Invalid credentials (Failure)'"), "refused"),
    (imaplib.IMAP4.error("b'[ALERT] Application-specific password required: "
                         "https://support.google.com/accounts/answer/185833 (Failure)'"), "refused"),
    (imaplib.IMAP4.abort("socket error: EOF"), "unreachable"),
    (TimeoutError("timed out"), "unreachable"),
    (EOFError(), "unreachable"),
    (imaplib.IMAP4.error("b'[UNAVAILABLE] Temporary System Problem. Try again later (Failure)'"), "error"),
    (imaplib.IMAP4.error("b'[ALERT] Too many simultaneous connections. (Failure)'"), "error"),
])
def test_what_gmail_answered_is_told_apart(error, kind):
    assert mail_dates.failure(error) == kind


# -- the way it reaches him ----------------------------------------------------------------------------

def test_the_controller_tells_him_at_once_with_no_buttons(on):
    on.c.inputs = inputs.Watch(on.ledger, inputs.Seen(), tz=TZ, active={inputs.MAIL: lambda: True})
    on.bot.sent.clear()
    on.ledger.input_failed("mail", REFUSED, "refused")
    on.tick()
    [(_, text, buttons, _)] = on.bot.sent
    assert text.startswith("<b>Harness can't read your email</b>") and buttons is None
    on.tick()
    assert len(on.bot.sent) == 1


def test_not_while_stopped_or_before_messages_start(on):
    on.c.inputs = inputs.Watch(on.ledger, inputs.Seen(), tz=TZ, active={inputs.MAIL: lambda: True})
    on.bot.sent.clear()
    on.ledger.input_failed("mail", REFUSED, "refused")
    started = on.c.config
    on.c.config = replace(started, proactive_from=date(2026, 12, 1))
    on.tick()
    on.c.config = started
    on.ledger.set_meta("paused", "1")
    on.tick()
    assert not any("can't read your email" in t for t in on.texts())
    on.ledger.set_meta("paused", "")
    on.tick()
    assert sum("can't read your email" in t for t in on.texts()) == 1


class Link:
    def __init__(self):
        self.cards = []

    def card(self, text, rows, kind, *, expires=None):
        self.cards.append((text, rows, kind))
        return 7


def test_on_discord_it_goes_out_at_once_with_no_buttons():
    link = Link()
    discord_chat.LinkChat(link).send_message(OWNER, "<b>Harness can't read your email</b>", kind=inputs.KIND)
    [(text, rows, kind)] = link.cards
    assert kind == "alert" and rows == []              # the link posts an alert at once; no Stop
    assert text == "**Harness can't read your email**"


# -- a ledger from before -------------------------------------------------------------------------------

def test_mail_already_refused_before_this_version_is_told_on_its_next_read(tmp_path, clock):
    path = str(tmp_path / "harness.sqlite")
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE inputs(name TEXT PRIMARY KEY, last_success_at TEXT, last_error_at TEXT,"
               " last_error TEXT)")
    db.execute("INSERT INTO inputs VALUES('mail', ?, ?, ?)", (LAST_GOOD.isoformat(),
               "2026-11-11T17:49:00+00:00", REFUSED))
    db.commit()
    db.close()
    clock.t = datetime(2026, 11, 11, 18, 0, tzinfo=timezone.utc)
    ledger = Ledger(path, clock=clock)
    row = ledger.inputs()["mail"]
    assert row["failing_since"] == "2026-11-11T17:49:00+00:00" and row["kind"] == ""
    w = watch(ledger)
    ledger.input_failed("mail", REFUSED, "refused")    # the next read, under this version
    assert w.tell(OWNER) == 1
    assert "No email has been read since Sun Nov 8 at 4:53 PM" in sent(ledger)[0]["text"]
