"""0.21.1: an input that stops is never silent (Nov 11).

From Nov 8 Gmail refused the Harness's app password, after a Google password change, and for
three days nothing said so. These check that what only he can fix is told at once from its second
try, once an outage, with the steps he can follow on his phone; that anything else is told once a
failure is seen six hours after the first; that the digest names each input that's down and says
in one line which came back; and that a failed mail read is logged by its kind, never by what
Gmail said. The review of Nov 11 found the bugs marked "probe": each is a test here. All names are
invented.
"""
import imaplib
import logging
import re
import sqlite3
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pytest

from harness import caldav, controller, daily, digest, discord_chat, google_cal, inputs, mail_dates, setup_web
from harness.calendar_feed import CalendarFeeds, Snapshot, feed_id
from harness.config import Config
from harness.ledger import Ledger, iso
from harness.net import HttpResponse
from harness.vault import LABELS
from conftest import OWNER
from fake_caldav import APP_PASSWORD, APPLE_ID, FAMILY_URL, FakeICloud, no_network  # noqa: F401
from fakes import FakeTransport, SyncExecutor
from test_calendar import TODAY, U1
from test_family_add import on, rig  # noqa: F401
from test_family_copy import GMAIL
from test_family_gmail import ACCOUNT, KEY, FakeGoogle, g  # noqa: F401
from test_mail_dates import DEALER, VAN, again, msg, read, rig_mail

TZ = "America/New_York"
LAST_GOOD = datetime(2026, 11, 8, 21, 53, tzinfo=timezone.utc)      # Sun Nov 8, 4:53 PM in New York
REFUSED = mail_dates.WORDS["refused"]
UNREACHABLE = mail_dates.WORDS["unreachable"]
DAY = timedelta(days=1)


def watch(ledger, seen=None, *, off=()):
    """Mail, Family, Google and sorting all set up, but those named off."""
    names = (inputs.MAIL, inputs.FAMILY, inputs.GOOGLE, inputs.MEANING)
    return inputs.Watch(ledger, seen, tz=TZ, active={n: (lambda n=n: n not in off) for n in names},
                        account=lambda: ACCOUNT)


def sent(ledger):
    return ledger.db.execute("SELECT * FROM outbox ORDER BY id").fetchall()


def readable(text):
    """As he reads it: no stamps, ids, codes or class names, no em or en dashes."""
    assert not re.search(r"\d{4}-\d\d-\d\d|\d\d:\d\d:\d\d|[—–]|job |\b[45]\d\d\b|[A-Z][a-z]+Error\b|engine",
                         text), text


def refused(ledger, clock, n=2, name="mail", words=REFUSED, kind="refused"):
    """n refused reads, five minutes apart."""
    for _ in range(n):
        clock.advance(minutes=5)
        ledger.input_failed(name, words, kind)


def last_good(ledger, clock, name="mail"):
    clock.t = LAST_GOOD
    ledger.input_ok(name)


# -- 1. what only he can fix: at once, from its second, once an outage ---------------------------

def test_gmail_refusing_the_app_password_is_told_from_its_second_read_with_the_steps(ledger, clock):
    last_good(ledger, clock)
    refused(ledger, clock, 1)
    w = watch(ledger)
    assert w.tell(OWNER) == 0                          # one refusal could be a stray
    refused(ledger, clock, 1)                          # the next read, five minutes later
    assert w.tell(OWNER) == 1
    [row] = sent(ledger)
    text = row["text"]
    assert row["kind"] == "input" and row["buttons_json"] is None and row["binds_json"] is None
    assert text.startswith("<b>Harness can't read your email</b>\n")
    assert ("No email has been read since 4:53 PM today: Gmail refused the app password. Changing your "
            "Google password turns it off. Dates and addresses from your email aren't being added.") in text
    assert text.endswith(
        "To fix it from your phone: make a new app password at https://myaccount.google.com/apppasswords "
        "and name it Harness, then copy it. In Home Assistant open Settings > Apps > Harness > Open Web UI. "
        'Under "Replace a key", paste it into "Gmail mail: app password" and save. Then tap Approve on the '
        "Discord message that follows, within 15 minutes.")
    readable(text)
    for _ in range(24):                                # two more hours of refused reads
        refused(ledger, clock, 1)
        assert w.tell(OWNER) == 0
    clock.advance(days=3)
    refused(ledger, clock, 1)
    assert w.tell(OWNER) == 0 and len(sent(ledger)) == 1


def test_probe_a_stray_refusal_with_a_success_between_is_never_told(ledger, clock):
    """Probe P4: a flapping 401 sent "make a new password" on every flap."""
    seen, fake = inputs.Seen(), FakeICloud()
    good = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL), seen=seen)
    stray = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, "wxyz-wxyz-wxyz-wxyz", FAMILY_URL), seen=seen)
    w = inputs.Watch(ledger, seen, tz=TZ, active={inputs.FAMILY: good.configured})
    for _ in range(3):
        good.items_between(clock(), clock() + DAY, TZ)
        w.drain()
        clock.advance(minutes=30)
        stray.items_between(clock(), clock() + DAY, TZ)
        w.drain()
        assert w.tell(OWNER) == 0
        clock.advance(minutes=30)
    assert sent(ledger) == []


def test_icloud_turning_the_app_specific_password_down_is_told_from_its_second(ledger, clock):
    seen, fake = inputs.Seen(), FakeICloud()
    good = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL), seen=seen)
    w = inputs.Watch(ledger, seen, tz=TZ, active={inputs.FAMILY: good.configured})
    assert good.items_between(clock(), clock() + DAY, TZ) is not None
    w.drain()
    revoked = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, "wxyz-wxyz-wxyz-wxyz", FAMILY_URL), seen=seen)
    for told in (0, 1):
        clock.advance(minutes=30)
        assert revoked.items_between(clock(), clock() + DAY, TZ) is None
        w.drain()
        assert w.tell(OWNER) == told
    text = sent(ledger)[0]["text"]
    assert text.startswith("<b>Harness can't reach the Family calendar</b>")
    assert (": iCloud refused the app-specific password. Changing your Apple Account password turns these "
            "off.") in text
    assert ("at https://account.apple.com open Sign-In and Security, then App-Specific Passwords, make one "
            'named Harness and copy it.') in text and '"Family calendar: app-specific password"' in text
    assert "wxyz" not in text and APP_PASSWORD not in text
    readable(text)
    fake.down = True                                   # then no answer at all: the same outage
    assert revoked.items_between(clock(), clock() + DAY, TZ) is None
    w.drain()
    assert ledger.inputs()["family"]["kind"] == "unreachable" and w.tell(OWNER) == 0


def test_icloud_not_answering_isnt_a_refusal(ledger, clock):
    seen, fake = inputs.Seen(), FakeICloud()
    fake.down = True
    client = caldav.FamilyCalDav(fake, lambda: (APPLE_ID, APP_PASSWORD, FAMILY_URL), seen=seen)
    assert client.items_between(clock(), clock() + DAY, TZ) is None
    assert seen.take() == {"family": ("unreachable", "couldn't reach iCloud")}


def test_probe_a_new_key_turned_down_too_is_told_again(ledger, clock):
    """Probe P2: a new password that was refused too, in the same outage, was never told."""
    last_good(ledger, clock)
    refused(ledger, clock)
    w = watch(ledger)
    assert w.tell(OWNER) == 1
    clock.advance(hours=1)
    w.key_changed("gmail_app_password")                # he pasted a new one and tapped Approve
    refused(ledger, clock, 1)
    assert w.tell(OWNER) == 0                          # the new one's first refusal could be a stray
    refused(ledger, clock, 1)
    assert w.tell(OWNER) == 1 and len(sent(ledger)) == 2


def test_approving_a_new_key_on_its_card_starts_what_he_was_told_over(on):
    w = on.c.inputs = inputs.Watch(on.ledger, inputs.Seen(), tz=TZ, active={inputs.MAIL: lambda: True})
    refused(on.ledger, on.clock)
    w.tell(OWNER)
    assert on.ledger.inputs()["mail"]["told_kind"] == "refused"
    change = on.vault.request_change("gmail_app_password", "abcd efgh ijkl mnop", by="Owner")
    assert on.c._settings_decision(change, "approve").startswith("Done.")
    row = on.ledger.inputs()["mail"]
    assert (row["told_at"], row["told_kind"], row["refusals"]) == (None, "", 0)


@pytest.mark.parametrize("status, said, kind", [
    (400, b'{"error": "invalid_grant", "error_description": "Invalid JWT Signature."}', "refused"),
    (401, b'{"error": "invalid_client", "error_description": "The OAuth client was not found."}', "refused"),
    (403, b'{"error": "unauthorized_client"}', "refused"),
    (400, b'{"error": "invalid_grant", "error_description": "Invalid JWT: Token must be a short-lived '
          b'token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT '
          b'claim."}', "error"),                          # the Pi's clock: no new key would fix it
    (400, b'{"error": "invalid_request"}', "error"),
    (404, b'{"error": "invalid_grant"}', "error"),
    (429, b'{"error": "rate_limit_exceeded", "error_description": "Rate Limit Exceeded"}', "unreachable"),
    (408, b"", "unreachable"),
    (503, b"", "unreachable"),
])
def test_probe_google_turning_the_key_down_is_told_apart(clock, status, said, kind):
    """Probe P3: a 429 or 408 from Google's sign-in was taken for a refused key."""
    seen = inputs.Seen()
    client = google_cal.GoogleCalendar(SignIn(status, said), lambda: KEY, clock, seen=seen)
    assert client.events_between(GMAIL, clock(), clock() + DAY) is None
    assert seen.take()["google"][0] == kind


class SignIn(FakeGoogle):
    """Google, answering a sign-in it doesn't give with what it says then."""

    def __init__(self, status, said):
        super().__init__()
        self.token_status, self.said = status, said

    def _token(self, method, body):
        if self.token_status != 200:
            self.token_calls += 1
            return HttpResponse(self.token_status, {}, self.said)
        return super()._token(method, body)


def test_a_refused_google_key_is_told_with_steps_naming_the_account(ledger, clock):
    seen = inputs.Seen()
    client = google_cal.GoogleCalendar(SignIn(400, b'{"error": "invalid_grant"}'), lambda: KEY, clock,
                                       seen=seen)
    w = watch(ledger, seen)
    for told in (0, 1):
        client.list_ours(GMAIL, clock(), clock() + DAY)
        w.drain()
        assert w.tell(OWNER) == told
        clock.advance(minutes=5)
    text = sent(ledger)[0]["text"]
    assert ": Google refused the service account key." in text
    assert ("at https://console.cloud.google.com open IAM & Admin, then Service Accounts, then "
            f"{ACCOUNT}, then Keys, Add key, Create new key, JSON. It downloads a file: open it, select all "
            "and copy.") in text and '"Gmail calendar: Google service account key"' in text
    assert "BEGIN PRIVATE KEY" not in text
    readable(text)


class Others(FakeGoogle):
    """Google, with his calendar shared with Harness and someone else's not."""

    def request(self, method, url, **kw):
        if url != google_cal.TOKEN_URL and "/calendars/someone%40gmail.com/" in url:
            return HttpResponse(404, {}, b"{}")
        return super().request(method, url, **kw)


def test_probe_only_his_own_calendar_can_be_denied(clock):
    """Probe P8: another calendar read through the same key, not shared, flapped his as denied."""
    seen, fake = inputs.Seen(), Others()
    client = google_cal.GoogleCalendar(fake, lambda: KEY, clock, seen=seen)
    client.mine = lambda: GMAIL
    assert client.events_between("someone@gmail.com", clock(), clock() + DAY) is None
    assert client.events_between(GMAIL, clock(), clock() + DAY) == []
    assert seen.take() == {"google": ("ok", "")}
    client.events_between("someone@gmail.com", clock(), clock() + DAY)
    assert seen.take() == {}                           # someone else's says nothing about his
    fake.shared = False
    assert client.events_between(GMAIL, clock(), clock() + DAY) is None
    assert seen.take() == {"google": ("denied", "Google says your calendar isn't shared with Harness")}
    fake.shared, fake.fail["GET"] = True, "drop"
    assert client.events_between(GMAIL, clock(), clock() + DAY) is None
    assert seen.take() == {"google": ("unreachable", "couldn't reach Google")}
    client.mine = lambda: None                         # not known whose: nothing counts
    client.events_between(GMAIL, clock(), clock() + DAY)
    assert seen.take() == {}


def test_his_calendar_not_shared_is_told_like_a_refusal_with_the_steps(ledger, clock):
    w = watch(ledger)
    ledger.input_failed("google", google_cal.DENIED, "denied")
    assert w.tell(OWNER) == 0
    clock.advance(minutes=5)
    ledger.input_failed("google", google_cal.DENIED, "denied")
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert ": Google says your calendar isn't shared with Harness." in text
    assert text.endswith(
        "To fix it: open https://calendar.google.com in your phone's browser and switch to the desktop "
        "site. Open Settings, pick your calendar, then Shared with, Add people and groups. Add "
        f"{ACCOUNT} and choose Make changes and see event details.")
    readable(text)


def test_the_names_the_clients_use_are_the_watchs():
    assert (caldav.INPUT, google_cal.INPUT) == (inputs.FAMILY, inputs.GOOGLE)
    assert "make changes" not in google_cal.DENIED.lower()     # write refusals aren't read as it


def test_the_steps_name_what_is_really_on_the_page_and_the_card():
    page = open(setup_web.__file__, encoding="utf-8").read()
    assert "'Replace a key'" in page and "<button>Save</button>" in page
    assert controller.SETTINGS_TTL_S == 15 * 60
    for field, said in (("gmail_app_password", "Gmail mail: app password"),
                        ("family_app_password", "Family calendar: app-specific password"),
                        ("google_service_key", "Gmail calendar: Google service account key")):
        assert LABELS[field].startswith(said)
        assert any(f'"{said}"' in s.fix for s in inputs.SPECS.values())


# -- 2. anything else: once a failure is seen six hours after the first -----------------------------

def test_any_other_failure_is_told_once_a_failure_is_seen_six_hours_after_the_first(ledger, clock):
    last_good(ledger, clock)
    w = watch(ledger)
    clock.advance(minutes=5)
    first = clock()
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    while clock() - first < timedelta(hours=6) - timedelta(minutes=5):
        clock.advance(minutes=5)
        ledger.input_failed("mail", UNREACHABLE, "unreachable")
        assert w.tell(OWNER) == 0
    clock.advance(minutes=5)                           # a failure seen six hours after the first
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert w.tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert "No email has been read since 4:53 PM today: couldn't reach Gmail." in text
    assert text.endswith("Harness keeps trying, and the morning digest will say when it works again.")
    readable(text)
    clock.advance(hours=12)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert w.tell(OWNER) == 0 and len(sent(ledger)) == 1


def test_probe_a_pause_or_a_clock_jump_alone_never_tells(ledger, clock):
    """Probe P1: one failure, then seven hours with nothing tried, was told before any new try."""
    ledger.input_ok("mail")
    clock.advance(minutes=5)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")     # say, the network not up at boot
    clock.advance(hours=7)                                      # stopped, or the clock jumped
    w = watch(ledger)
    assert w.tell(OWNER) == 0
    ledger.input_failed("mail", UNREACHABLE, "unreachable")     # still failing when tried again
    assert w.tell(OWNER) == 1


def test_a_success_inside_six_hours_ends_it_unsaid(ledger, clock):
    w = watch(ledger)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    clock.advance(hours=5, minutes=55)
    ledger.input_ok("mail")
    clock.advance(hours=1)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    clock.advance(hours=5)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert w.tell(OWNER) == 0 and sent(ledger) == []
    assert w.back_line() == ""                         # he never knew, so nothing to say came back


def test_a_refusal_later_in_the_same_outage_is_still_told(ledger, clock):
    w = watch(ledger)
    ledger.input_failed("google", "couldn't reach Google", "unreachable")
    clock.advance(hours=6)
    ledger.input_failed("google", "couldn't reach Google", "unreachable")
    assert w.tell(OWNER) == 1
    refused(ledger, clock, name="google", words="Google refused the service account key")
    assert w.tell(OWNER) == 1 and w.tell(OWNER) == 0
    first, second = (r["text"] for r in sent(ledger))
    assert "Harness keeps trying" in first and "Create new key" in second


def test_what_is_unreachable_together_is_one_message(ledger, clock):
    w = watch(ledger)
    said = {"mail": UNREACHABLE, "family": "couldn't reach iCloud", "google": "couldn't reach Google"}
    claude = "Claude turned the request down (key or billing)"
    for name, words in said.items():
        ledger.input_failed(name, words, "unreachable")
    ledger.input_failed("meaning", claude, "engine")
    clock.advance(hours=6)
    for name, words in said.items():
        ledger.input_failed(name, words, "unreachable")
    assert w.tell(OWNER) == 1
    [row] = sent(ledger)
    assert row["text"].startswith("<b>Harness can't reach a few things it uses</b>\n")
    for words in said.values():
        assert words in row["text"]
    assert {r["told_outbox"] for r in ledger.inputs().values() if r["name"] != "meaning"} == {row["id"]}
    ledger.input_ok("mail")                            # one back, the others still down: it still goes
    assert ledger.outbox_row(row["id"])["state"] == "queued"
    clock.advance(minutes=5)
    ledger.input_failed("meaning", claude, "engine")   # due now, five minutes after that message
    assert w.tell(OWNER) == 0                          # anything else waits for the quarter hour
    clock.advance(minutes=10)
    assert w.tell(OWNER) == 1


def test_a_message_still_waiting_when_it_works_again_is_dropped(ledger, clock):
    w = watch(ledger)
    refused(ledger, clock)
    assert w.tell(OWNER) == 1                          # say, Cain's link down: not sent yet
    ledger.input_ok("mail")
    assert sent(ledger)[0]["state"] == "dropped"
    assert w.back_line() == ""                         # it never reached him
    assert ledger.due_outbox() == []


@pytest.mark.parametrize("name, words, kind, says", [
    ("meaning", "Claude turned the request down (key or billing)", "engine",
     "If it goes on, check Claude's billing at https://platform.claude.com/settings/billing and the "
     "Anthropic API key on the Harness page."),
    ("meaning", "this month's limit for sorting Family events is used up", "limit",
     "It picks up again when the monthly limit resets."),
])
def test_what_he_can_do_follows_the_kind(ledger, clock, name, words, kind, says):
    ledger.input_failed(name, words, kind)
    clock.advance(hours=6)
    ledger.input_failed(name, words, kind)
    assert watch(ledger).tell(OWNER) == 1
    text = sent(ledger)[0]["text"]
    assert says in text and words in text and text.startswith("<b>Harness can't sort Family events</b>")
    readable(text)


def test_an_input_that_isnt_set_up_is_never_told_or_named(ledger, clock):
    refused(ledger, clock)
    w = watch(ledger, off=("mail",))
    assert w.tell(OWNER) == 0 and w.digest_lines() == ([], [])


def test_a_calendar_address_is_told_by_its_name_or_as_one_of_his(ledger, clock):
    for name in ("calendar:abcd", "calendar:ef01"):
        ledger.input_failed(name, "Google says this address doesn't exist (was it reset?)")
    clock.advance(hours=6)
    for name in ("calendar:abcd", "calendar:ef01"):
        ledger.input_failed(name, "Google answered with an error")
    w = inputs.Watch(ledger, tz=TZ, feeds=lambda: [("calendar:abcd", "owner@example.com"), ("calendar:ef01", "")])
    assert w.tell(OWNER) == 2
    first, second = (r["text"] for r in sent(ledger))
    assert first.startswith("<b>Harness can't read one of your calendars</b>\nThe calendar owner@example[.]com "
                            "hasn't been read since 9:00 AM today: Google answered with an error.")
    assert "\nOne of your calendars hasn't been read since 9:00 AM today" in second


def test_probe_a_calendar_keeps_its_name_after_midnight_and_a_restart(ledger, clock):
    """Review: a calendar's message said "calendar ab12" once its read was from yesterday."""
    cal = CalendarFeeds(ledger, FakeTransport([(200, TODAY)]), SyncExecutor(), lambda: U1, TZ)
    cal.start()
    cal.collect()
    name = f"calendar:{feed_id(U1)}"
    assert cal.inputs() == [(name, "owner@example.com")]
    cal.snapshot = Snapshot(day="2026-10-22")                    # midnight
    assert cal.inputs() == [(name, "owner@example.com")]
    again_ = CalendarFeeds(ledger, FakeTransport([]), SyncExecutor(), lambda: U1, TZ)    # a restart
    assert again_.inputs() == [(name, "owner@example.com")]
    fresh = CalendarFeeds(Ledger(":memory:", clock=clock), FakeTransport([]), SyncExecutor(), lambda: U1, TZ)
    assert fresh.inputs() == [(name, "")]                        # never read: no name yet


# -- 3. the morning digest ---------------------------------------------------------------------------

def test_the_digest_names_each_input_down_in_one_plain_shape(ledger, clock):
    last_good(ledger, clock)
    refused(ledger, clock)
    ledger.input_ok("family")
    clock.t = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)       # Wed, 7:00 AM
    d = daily.gather(ledger, Config(owner_user_id=OWNER), paused=False, watch=watch(ledger))
    assert d.state == "attention" and d.named == ("mail",)
    assert "• Email from Gmail: not working since Sun Nov 8 at 4:53 PM; Gmail refused the app password" in d.text
    assert "iCloud" not in d.text and "Working again" not in d.text


def test_probe_one_blip_before_the_digest_isnt_named_or_back(ledger, clock):
    """Probe P5: one failed read just before the digest made it "Attention needed", then "Working
    again" the next day."""
    config = Config(owner_user_id=OWNER)
    clock.t = datetime(2026, 11, 10, 11, 50, tzinfo=timezone.utc)   # 6:50 AM
    ledger.input_ok("mail")
    clock.advance(minutes=5)
    ledger.input_failed("mail", UNREACHABLE, "unreachable")         # one blip at 6:55
    clock.advance(minutes=5)                                        # the 7:00 digest
    w = watch(ledger)
    d = daily.gather(ledger, config, paused=False, watch=w)
    assert "Email from Gmail" not in d.text and d.named == ()
    daily.deliver(ledger, config, d)
    w.digest_sent(d.named)
    clock.advance(minutes=5)
    ledger.input_ok("mail")                                         # the next read works
    clock.advance(days=1)
    assert "Working again" not in daily.gather(ledger, config, paused=False, watch=w).text
    ledger.input_failed("mail", UNREACHABLE, "unreachable")         # twice: named
    ledger.input_failed("mail", UNREACHABLE, "unreachable")
    assert "Email from Gmail: not working since 7:05 AM yesterday; couldn't reach Gmail" in \
        daily.gather(ledger, config, paused=False, watch=w).text


def test_when_one_comes_back_the_next_digest_says_so_in_one_line(ledger, clock):
    last_good(ledger, clock)
    refused(ledger, clock)
    clock.t = datetime(2026, 11, 9, 11, 0, tzinfo=timezone.utc)        # Mon, 6:00 AM
    ledger.input_failed("family", "couldn't reach iCloud", "unreachable")
    clock.advance(minutes=30)
    ledger.input_failed("family", "couldn't reach iCloud", "unreachable")
    clock.advance(minutes=30)                                  # the digest
    w = watch(ledger)
    assert w.tell(OWNER) == 1                                  # the mail, at once; Family not yet
    config = Config(owner_user_id=OWNER)
    d = daily.gather(ledger, config, paused=False, watch=w)
    assert "Family calendar through iCloud: not working since 6:00 AM today; couldn't reach iCloud" in d.text
    daily.deliver(ledger, config, d)
    w.digest_sent(d.named)
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
    w.digest_sent(d.named)
    assert "Working again" not in daily.gather(ledger, config, paused=False, watch=w).text
    assert [r["kind"] for r in sent(ledger)] == ["input", "digest", "digest"]    # never a separate "back"


def test_a_calendar_address_that_failed_twice_is_named_before_it_is_stale():
    now = datetime(2026, 10, 21, 11, 0, tzinfo=timezone.utc)
    feed = digest.InputCoverage("Calendar owner", now - timedelta(minutes=30), timedelta(hours=2),
                                "Google answered with an error", failing=True, key="calendar:abcd")
    d = digest.compose(now=now, tz=TZ, inputs=[feed], waiting=[], failures=[], low_balance=[],
                       canary_ok=True, config_unchanged_since=now)
    assert d.state == "attention" and d.named == ("calendar:abcd",)
    assert "Calendar owner: not working since 6:30 AM today; Google answered with an error" in d.text


class Broken(inputs.Watch):
    def digest_lines(self):
        raise RuntimeError("boom")


def test_the_digest_goes_out_even_when_the_inputs_cant_be_checked(ledger):
    d = daily.gather(ledger, Config(owner_user_id=OWNER), paused=False, watch=Broken(ledger, tz=TZ))
    assert "Couldn't check this morning whether email, Family and Google are working" in d.text


class Receipts:
    def __init__(self):
        self.sent = 0

    def tick(self, paused):
        pass

    def digest_line(self):
        return ""

    def send_receipts(self):
        self.sent += 1


class Unsendable(inputs.Watch):
    def digest_sent(self, named=()):
        raise RuntimeError("boom")


def test_a_failure_after_the_digest_never_skips_the_receipts(on):
    on.c.inputs = Unsendable(on.ledger, tz=TZ)
    on.c.meaning_live = Receipts()
    on.ledger.set_meta("digest_date", "")
    on.tick()
    assert on.c.meaning_live.sent == 1 and on.ledger.get_meta("last_digest_text")


# -- 4. the log --------------------------------------------------------------------------------------

def fails(g, error):
    def read_(*a):
        raise error
    g.box.read = read_


def warned(caplog, logger="harness.mail_dates"):
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and r.name == logger]


def test_a_failed_mail_read_is_a_warning_by_its_kind_at_most_hourly(g, caplog):
    rig_mail(g, [msg(1, "Your order of PC parts")])
    caplog.set_level(logging.INFO, logger="harness.mail_dates")
    fails(g, imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials for someone@example.org "
                                 "(Failure)"))
    read(g)
    assert warned(caplog) == ["mail read failed: refused"]
    assert g.ledger.inputs()["mail"]["kind"] == "refused"
    for _ in range(11):                                # every five minutes, the same, for most of an hour
        g.clock.advance(minutes=5)
        read(g)
    assert warned(caplog) == ["mail read failed: refused"]
    fails(g, imaplib.IMAP4.abort("socket error: EOF"))     # the kind changes: said at once
    read(g)
    assert warned(caplog)[-1] == "mail read failed: unreachable"
    g.clock.advance(hours=1)                           # the same kind an hour on: said again
    read(g)
    assert warned(caplog)[-2:] == ["mail read failed: unreachable"] * 2
    assert "someone@example.org" not in caplog.text and "abcdefghijklmnop" not in caplog.text
    assert "Invalid credentials" not in caplog.text


def test_probe_an_unexpected_failure_is_an_error_and_its_warning_is_throttled(g, caplog):
    """Probe P7: it was "unreachable", and warned about on every read, every five minutes."""
    rig_mail(g, [msg(1, "Your order of PC parts")])
    caplog.set_level(logging.INFO, logger="harness.mail_dates")
    fails(g, ValueError("parse"))
    for _ in range(12):
        read(g)
        g.clock.advance(minutes=5)
    assert warned(caplog) == ["mail read failed: unexpected (ValueError)"]
    row = g.ledger.inputs()["mail"]
    assert row["kind"] == "error" and row["last_error"] == "the read stopped on an unexpected problem"


def test_a_failed_look_up_is_a_warning_and_counts_against_the_mail(g, caplog):
    rig_mail(g, [msg(1, "Your service appointment", sender=DEALER)], {"Your service appointment": VAN})
    read(g)
    g.ledger.db.execute("UPDATE mail_dates SET sender=''")
    caplog.set_level(logging.INFO, logger="harness.mail_dates")

    def refuse(*a):
        raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")
    g.box.find = refuse
    again(g)
    assert warned(caplog) == ["mail look-up failed: refused"]
    row = g.ledger.inputs()["mail"]
    assert row["kind"] == "refused" and row["last_error"] == REFUSED


@pytest.mark.parametrize("error, failed", [
    (imaplib.IMAP4.error("b'[AUTHENTICATIONFAILED] Invalid credentials (Failure)'"), "refused"),
    (imaplib.IMAP4.error("b'[ALERT] Application-specific password required: "
                         "https://support.google.com/accounts/answer/185833 (Failure)'"), "refused"),
    (imaplib.IMAP4.error("b'[ALERT] Please log in via your web browser: "
                         "https://support.google.com/mail/accounts/answer/78754 (Failure)'"), "web"),
    (imaplib.IMAP4.abort("socket error: EOF"), "unreachable"),
    (TimeoutError("timed out"), "unreachable"),
    (EOFError(), "unreachable"),
    (imaplib.IMAP4.error("b'[UNAVAILABLE] Temporary System Problem. Try again later (Failure)'"), "error"),
    (imaplib.IMAP4.error("b'[ALERT] Too many simultaneous connections. (Failure)'"), "error"),
])
def test_what_gmail_answered_is_told_apart(error, failed):
    assert mail_dates.failure(error) == failed


def test_probe_gmail_wanting_a_sign_in_on_the_web_is_told_like_a_refusal(g):
    """Probe P9: a sign-in Gmail wants on the web first waited six hours as an error."""
    rig_mail(g, [msg(1, "Your order of PC parts")])
    fails(g, imaplib.IMAP4.error("b'[ALERT] Please log in via your web browser (Failure)'"))
    w = watch(g.ledger)
    for told in (0, 1):
        read(g)
        assert w.tell(OWNER) == told
        g.clock.advance(minutes=5)
    text = sent(g.ledger)[-1]["text"]
    assert ": Gmail asked for a sign-in on the web first." in text and "Changing your Google" not in text
    assert "https://myaccount.google.com/apppasswords" in text


# -- the way it reaches him ----------------------------------------------------------------------------

def test_the_controller_tells_him_from_the_second_refusal_with_no_buttons(on):
    on.c.inputs = inputs.Watch(on.ledger, inputs.Seen(), tz=TZ, active={inputs.MAIL: lambda: True})
    on.bot.sent.clear()
    on.ledger.input_failed("mail", REFUSED, "refused")
    on.tick()
    assert on.bot.sent == []
    on.ledger.input_failed("mail", REFUSED, "refused")
    on.tick()
    [(_, text, buttons, _)] = on.bot.sent
    assert text.startswith("<b>Harness can't read your email</b>") and buttons is None
    on.tick()
    assert len(on.bot.sent) == 1


def test_not_while_stopped_or_before_messages_start(on):
    on.c.inputs = inputs.Watch(on.ledger, inputs.Seen(), tz=TZ, active={inputs.MAIL: lambda: True})
    on.bot.sent.clear()
    refused(on.ledger, on.clock)
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


class Stuck(inputs.Watch):
    def drain(self):
        raise RuntimeError("boom")


def test_a_watch_that_fails_is_warned_about_once_an_hour(on, caplog):
    on.c.inputs = Stuck(on.ledger, tz=TZ)
    caplog.set_level(logging.INFO, logger="harness.controller")
    for _ in range(5):
        on.tick()
    assert warned(caplog, "harness.controller") == ["input watch failed: RuntimeError"]
    on.clock.advance(hours=1)
    on.tick()
    assert len(warned(caplog, "harness.controller")) == 2


class Link:
    def __init__(self):
        self.cards = []

    def card(self, text, rows, kind, *, expires=None):
        self.cards.append((text, rows, kind))
        return 7


def test_on_discord_it_goes_out_at_once_with_no_buttons_and_its_links_whole():
    link = Link()
    discord_chat.LinkChat(link).send_message(
        OWNER, "<b>Harness can't read your email</b>\nOpen https://example.com/app-pass_words/x_y-z and "
               "make one-named_thing. Then https://example.com/a-b.", kind=inputs.KIND)
    [(text, rows, kind)] = link.cards
    assert kind == "alert" and rows == []              # the link posts an alert at once; no Stop
    assert text.startswith("**Harness can't read your email**")
    assert "https://example.com/app-pass_words/x_y-z and" in text          # the link whole
    assert "one\\-named\\_thing" in text and "https://example.com/a-b." in text


def test_the_built_app_watches_mail_once_its_password_is_in(tmp_path, monkeypatch):
    from harness import __main__ as main
    monkeypatch.setattr(main, "serve", lambda *a, **k: None)
    monkeypatch.setattr(main.family, "serve", lambda *a, **k: None)
    c, _, _ = main.build(str(tmp_path))
    try:
        assert inputs.MAIL not in c.inputs.watched()
        c.vault.set_key("gmail_app_password", "abcd efgh ijkl mnop", by="Owner")
        assert inputs.MAIL in c.inputs.watched()               # whatever the feeds say today
        assert inputs.MEANING not in c.inputs.watched()        # sorting: only while it decides blocks
        assert c.family_gmail.google.mine == c.family_gmail._address
    finally:
        c.executor.shutdown(wait=False)


# -- a ledger from before -------------------------------------------------------------------------------

def old_ledger(tmp_path, *rows):
    path = str(tmp_path / "harness.sqlite")
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE inputs(name TEXT PRIMARY KEY, last_success_at TEXT, last_error_at TEXT,"
               " last_error TEXT)")
    db.executemany("INSERT INTO inputs VALUES(?, ?, ?, ?)", rows)
    db.commit()
    db.close()
    return path


def test_probe_mail_already_refused_before_this_version_is_told_once_from_its_reads(tmp_path, clock):
    """Probe P6: an old failure was told at once as "keeps trying", then again as refused."""
    path = old_ledger(tmp_path, ("mail", LAST_GOOD.isoformat(), "2026-11-11T05:00:00+00:00", REFUSED))
    clock.t = datetime(2026, 11, 11, 18, 0, tzinfo=timezone.utc)
    ledger = Ledger(path, clock=clock)
    row = ledger.inputs()["mail"]
    assert (row["failing_since"], row["failures"], row["kind"]) == (None, 0, "")    # starts at zero
    w = watch(ledger)
    assert w.tell(OWNER) == 0                          # before any read under this version
    refused(ledger, clock, 1)
    assert w.tell(OWNER) == 0
    refused(ledger, clock, 1)
    assert w.tell(OWNER) == 1 and len(sent(ledger)) == 1
    text = sent(ledger)[0]["text"]
    assert "No email has been read since Sun Nov 8 at 4:53 PM" in text and "apppasswords" in text


def test_what_he_was_told_before_it_last_worked_doesnt_count(ledger, clock):
    refused(ledger, clock)
    w = watch(ledger)
    assert w.tell(OWNER) == 1
    clock.advance(minutes=5)
    ledger.db.execute("UPDATE inputs SET last_success_at=? WHERE name='mail'", (iso(clock()),))   # 0.21.0's
    refused(ledger, clock)
    assert w.tell(OWNER) == 1 and len(sent(ledger)) == 2
