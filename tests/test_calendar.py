"""S1: the calendar feeds -- what they accept, how they fail, and how the
morning digest uses them. Read-only by construction; unknown is never an
empty day."""
import json
import logging
import queue
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import calendar_feed, digest
from harness.calendar_feed import CalendarFeeds, check_urls, feed_id, fetch_one
from harness.config import Config
from harness.controller import Controller
from harness.ical import Occurrence
from harness.net import REDACT, RedactingFilter, TransportError
from harness.vault import Vault, VaultError
from conftest import OWNER, Clock, msg
from fakes import FakeBot, FakeEngine, FakeTransport, ManualExecutor, SyncExecutor, result

NY = ZoneInfo("America/New_York")
U1 = ("https://calendar.google.com/calendar/ical/owner%40example.com/"
      "private-0123456789abcdef0123456789abcdef/basic.ics")
U2 = ("https://calendar.google.com/calendar/ical/family0123%40group.calendar.google.com/"
      "private-fedcba9876543210fedcba9876543210/basic.ics")
TOKEN = "123456789:AAEhBP0av28aH3sT9_" + "x" * 18
OKEY = "sk-proj-" + "B" * 40


def ics(*events, name="owner@example.com"):
    body = []
    for i, e in enumerate(events):
        body += ["BEGIN:VEVENT", f"UID:e{i}@google.com"] + e.strip().splitlines() + \
                ["END:VEVENT"]
    return ("\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", f"X-WR-CALNAME:{name}",
                         "X-WR-TIMEZONE:America/New_York"] + body + ["END:VCALENDAR", ""])
            .encode())


TODAY = ics("DTSTART;TZID=America/New_York:20261021T090000\n"
            "DTEND;TZID=America/New_York:20261021T100000\nSUMMARY:Vet visit",
            "DTSTART;TZID=America/New_York:20261021T093000\n"
            "DTEND;TZID=America/New_York:20261021T103000\nSUMMARY:School call",
            "DTSTART;VALUE=DATE:20261021\nSUMMARY:Feed delivery")


# -- what may be entered -------------------------------------------------------------

def test_only_google_secret_addresses_are_accepted():
    assert check_urls(f"  {U1}\n{U2} ") == f"{U1} {U2}"
    for bad in [U1.replace("calendar.google.com", "calendar.google.com.evil.example"),
                U1.replace("calendar.google.com", "evil.example"),
                U1.replace("https://", "http://"),
                U1.replace("/basic.ics", "/full.ics"),
                U1.replace("private-", "public-"),
                "https://calendar.google.com/calendar/embed?src=owner",
                U1 + "?x=1", "sk-ant-api03-" + "A" * 40]:
        with pytest.raises(ValueError):
            check_urls(bad)


def test_limits_on_how_many():
    with pytest.raises(ValueError, match="twice"):
        check_urls(f"{U1} {U1}")
    many = " ".join(U1.replace("0123456789abcdef0123456789abcdef", f"{i:032x}")
                    for i in range(7))
    with pytest.raises(ValueError, match="at most"):
        check_urls(many)
    with pytest.raises(ValueError):
        check_urls("   ")


def test_the_vault_keeps_them_like_a_key(tmp_path):
    v = Vault(str(tmp_path / "s.json"))
    v.set_key("calendar_feeds", f"{U1}\n{U2}", by="Owner")
    assert v.get("calendar_feeds") == f"{U1} {U2}"
    assert v.key_status()["calendar_feeds"]
    with pytest.raises(VaultError, match="secret iCal"):
        v.set_key("calendar_feeds", "https://example.com/cal.ics", by="Owner")
    # after pairing, a change is a request for his tap, like any key
    v.try_pair(v.new_pairing_code(), user_id=OWNER, chat_id=OWNER)
    v.request_change("calendar_feeds", U2, by="Owner")
    assert v.get("calendar_feeds") == f"{U1} {U2}"
    assert v.pending()["field"] == "calendar_feeds"


# -- fetching -------------------------------------------------------------------------

def bounds(d=date(2026, 10, 21)):
    s = datetime(d.year, d.month, d.day, tzinfo=NY)
    return dict(start=s, end=s + timedelta(days=1), tz="America/New_York")


def test_a_good_read():
    t = FakeTransport([(200, TODAY, {"content-type": "text/calendar"})])
    r = fetch_one(t, U1, **bounds())
    assert r.ok and r.day == "2026-10-21" and r.feed == feed_id(U1)
    assert [o.summary for o in r.window.occurrences] == ["Feed delivery", "Vet visit",
                                                         "School call"]
    assert t.requests[0]["method"] == "GET" and t.requests[0]["url"] == U1


@pytest.mark.parametrize("reply,needle", [
    ((404, b"Not Found"), "reset"),
    ((403, b""), "refused"),
    ((500, b""), "answered 500"),
    ((200, b"<html>sign in</html>"), "wasn't a calendar"),
    (TransportError("timeout"), "couldn't reach Google (timeout)"),
])
def test_failures_are_named(reply, needle):
    r = fetch_one(FakeTransport([reply]), U1, **bounds())
    assert not r.ok and needle in r.error and U1 not in r.error


def test_too_big_is_refused(monkeypatch):
    monkeypatch.setattr(calendar_feed, "MAX_BYTES", 100)
    r = fetch_one(FakeTransport([(200, TODAY)]), U1, **bounds())
    assert not r.ok and "larger" in r.error


def test_a_parser_crash_is_a_failed_read_not_a_dead_loop(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bug")
    monkeypatch.setattr(calendar_feed.ical, "window", boom)
    r = fetch_one(FakeTransport([(200, TODAY)]), U1, **bounds())
    assert not r.ok and "RuntimeError" in r.error


def test_the_address_never_reaches_a_log_line():
    REDACT.clear()
    fetch_one(FakeTransport([(200, TODAY)]), U1, **bounds())
    rec = logging.LogRecord("x", logging.INFO, "", 0, "fetching %s failed", (U1,), None)
    RedactingFilter().filter(rec)
    assert U1 not in rec.msg and "private-0123" not in rec.msg
    rec = logging.LogRecord("x", logging.INFO, "", 0, "private part %s", (U1.split("/")[-2],),
                            None)
    RedactingFilter().filter(rec)
    assert "0123456789abcdef0123456789abcdef" not in rec.msg


# -- the feeds over a day ---------------------------------------------------------------

class Feeds:
    def __init__(self, ledger, replies, urls=U1, executor=None):
        self.t = FakeTransport(replies)
        self.urls = urls
        self.f = CalendarFeeds(ledger, self.t, executor or SyncExecutor(),
                               lambda: self.urls, "America/New_York")


def test_reads_every_half_hour_and_records_the_input(ledger, clock):
    x = Feeds(ledger, [(200, TODAY)] * 3)
    x.f.maybe_start(); x.f.collect()
    assert ledger.inputs()[f"calendar:{feed_id(U1)}"]["last_success_at"]
    clock.advance(minutes=10); x.f.maybe_start()
    assert len(x.t.requests) == 1
    clock.advance(minutes=21); x.f.maybe_start(); x.f.collect()
    assert len(x.t.requests) == 2
    occ, unread, read, conf = x.f.agenda("2026-10-21")
    assert (len(occ), unread, read, conf) == (3, 0, 1, 1)


def test_nothing_configured_means_no_reads(ledger):
    x = Feeds(ledger, [], urls="")
    x.f.maybe_start()
    assert not x.f.configured and x.t.requests == []


def test_a_failed_read_keeps_the_last_good_agenda_and_records_why(ledger, clock):
    x = Feeds(ledger, [(200, TODAY), (404, b"")])
    x.f.maybe_start(); x.f.collect()
    clock.advance(minutes=31); x.f.maybe_start(); x.f.collect()
    row = ledger.inputs()[f"calendar:{feed_id(U1)}"]
    assert "reset" in row["last_error"]
    assert len(x.f.agenda("2026-10-21")[0]) == 3


def test_yesterdays_agenda_is_not_today(ledger, clock):
    x = Feeds(ledger, [(200, TODAY)])
    x.f.maybe_start(); x.f.collect()
    clock.advance(days=1)
    x.f.collect()
    occ, _, read, conf = x.f.agenda("2026-10-22")
    assert occ == [] and read == 0 and conf == 1


def test_a_read_started_before_midnight_is_not_used_for_the_new_day(ledger, clock):
    ex = ManualExecutor()
    clock.t = datetime(2026, 10, 22, 3, 59, tzinfo=timezone.utc)      # 23:59 local
    x = Feeds(ledger, [(200, TODAY)], executor=ex)
    x.f.maybe_start()
    clock.advance(minutes=2)                                           # 00:01 next day
    ex.run_all(); x.f.collect()
    assert x.f.agenda("2026-10-22")[2] == 0


def test_a_removed_calendar_is_forgotten(ledger, clock):
    x = Feeds(ledger, [(200, TODAY), (200, ics(name="family"))], urls=f"{U1} {U2}")
    x.f.maybe_start(); x.f.collect()
    assert x.f.agenda("2026-10-21")[2] == 2
    x.urls = U2
    x.f.collect()
    assert x.f.agenda("2026-10-21")[2:] == (1, 1)
    assert [c[0] for c in x.f.coverage()] == ["family"]


def test_before_the_digest_a_stale_read_is_refreshed_and_a_fresh_one_is_not(ledger, clock):
    x = Feeds(ledger, [(200, TODAY)] * 2)
    x.f.maybe_start(); x.f.collect()
    x.f.maybe_start(before_digest=True)
    assert len(x.t.requests) == 1
    clock.advance(minutes=11)
    x.f.maybe_start(before_digest=True)
    assert len(x.t.requests) == 2


# -- the agenda in the digest ------------------------------------------------------------

NOW = datetime(2026, 10, 21, 11, 0, tzinfo=timezone.utc)


def occ(h1, m1, h2, m2, title, cal="owner@example.com", transparent=False):
    return Occurrence(datetime(2026, 10, 21, h1, m1, tzinfo=NY),
                      datetime(2026, 10, 21, h2, m2, tzinfo=NY), False, title, cal, transparent)


def compose(agenda, **kw):
    base = dict(now=NOW, tz="America/New_York",
                inputs=[digest.InputCoverage("Telegram", NOW, timedelta(minutes=15))],
                waiting=[], failures=[], low_balance=[], canary_ok=True,
                config_unchanged_since=NOW - timedelta(days=3))
    base.update(kw)
    return digest.compose(agenda=agenda, **base)


def test_clear_day_with_an_agenda():
    a = digest.Agenda([Occurrence(date(2026, 10, 21), date(2026, 10, 22), True,
                                  "Feed delivery", "c"),
                       occ(9, 0, 10, 0, "Vet visit")], 0, 1, 1)
    d = compose(a)
    assert d.state == "clear"
    lines = d.text.split("\n")
    assert lines[0].startswith("Clear · inputs fresh")
    assert lines[2:] == ["<b>Today</b>", "All day · Feed delivery",
                         "9:00 AM–10:00 AM Vet visit"]
    assert d.facts["events"] == 2


def test_an_empty_day_is_said_only_when_every_calendar_was_read():
    assert "Nothing on the calendar." in compose(digest.Agenda([], 0, 2, 2)).text
    part = compose(digest.Agenda([], 0, 1, 2)).text
    assert "from 1 of 2 calendars" in part and "calendars I could read" in part
    none = compose(digest.Agenda([], 0, 0, 2)).text
    assert "can't say what's on it" in none and "Nothing" not in none


def test_overlaps_are_marked_but_free_time_is_not():
    a = digest.Agenda([occ(9, 0, 10, 0, "Vet"), occ(9, 30, 10, 30, "Call"),
                       occ(9, 45, 11, 0, "Free", transparent=True),
                       occ(10, 30, 11, 0, "Back to back")], 0, 1, 1)
    t = compose(a).text
    assert "9:00 AM–10:00 AM Vet ⚠ overlaps" in t
    assert "9:30 AM–10:30 AM Call ⚠ overlaps" in t
    assert "Free ⚠" not in t and "Back to back ⚠" not in t


def test_titles_are_escaped_and_labels_shown_for_several_calendars():
    a = digest.Agenda([occ(9, 0, 10, 0, "<b>Pay</b> & go", cal="partner@example.com"),
                       Occurrence(date(2026, 10, 21), date(2026, 10, 22), True, "<i>x</i>",
                                  "home<>")], 0, 2, 2, labels=True)
    t = compose(a).text
    assert "&lt;b&gt;Pay&lt;/\u2060b&gt; &amp; go · partner" in t
    assert "All day · &lt;i&gt;x&lt;/\u2060i&gt; · home&lt;&gt;" in t


def test_anyone_can_invite_him_so_titles_are_defanged_like_model_text():
    a = digest.Agenda([occ(9, 0, 10, 0, "Pay at evil-pay.example.com/login or tap /undo @phisher",
                           cal="x.example.org")], 0, 2, 2, labels=True)
    t = compose(a).text
    assert "evil-pay.example.com" not in t and "evil-pay[.]example[.]com" in t
    assert "/undo" not in t and "@phisher" not in t
    assert "x.example.org" not in t


def test_long_days_are_cut_with_a_count():
    a = digest.Agenda([occ(6 + i // 2, 30 * (i % 2), 7 + i // 2, 0, f"E{i}")
                       for i in range(15)], 0, 1, 1)
    t = compose(a).text
    assert "…and 3 more" in t and "E11" in t and "E12" not in t


def test_unreadable_events_need_attention():
    d = compose(digest.Agenda([occ(9, 0, 10, 0, "Vet")], 2, 1, 1))
    assert d.state == "attention"
    assert "calendar: 2 event(s) I couldn't read" in d.text and "Vet" in d.text


def test_a_stale_calendar_is_named_with_why():
    d = compose(digest.Agenda([], 0, 0, 1), inputs=[
        digest.InputCoverage("Telegram", NOW, timedelta(minutes=15)),
        digest.InputCoverage("Calendar owner", NOW - timedelta(hours=5), timedelta(hours=2),
                             "Google says this address doesn't exist (was it reset?)")])
    assert d.state == "attention"
    assert "Calendar owner: stale since Wed 2:00 AM (Google says" in d.text


def test_an_event_from_last_night_shows_when_it_ends():
    o = Occurrence(datetime(2026, 10, 20, 23, 0, tzinfo=NY), datetime(2026, 10, 21, 1, 0,
                                                                      tzinfo=NY),
                   False, "Night shift", "c")
    assert "until 1:00 AM Night shift" in compose(digest.Agenda([o], 0, 1, 1)).text


def test_a_calendar_not_read_today_is_never_clear():
    d = compose(digest.Agenda([], 0, 0, 1))
    assert d.state == "attention" and "calendar: 1 of 1 not read today" in d.text
    d = compose(digest.Agenda([occ(9, 0, 10, 0, "Vet")], 0, 1, 2))
    assert d.state == "attention" and "calendar: 1 of 2 not read today" in d.text


def test_an_event_ending_on_a_later_day_says_which():
    o = Occurrence(datetime(2026, 10, 21, 22, 0, tzinfo=NY),
                   datetime(2026, 10, 23, 9, 0, tzinfo=NY), False, "Trip", "c")
    assert "10:00 PM to Fri 9:00 AM Trip" in compose(digest.Agenda([o], 0, 1, 1)).text


def test_work_titles_are_kept_as_slots_not_words(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    feed = ics("DTSTART;TZID=America/New_York:20261021T090000\n"
               "DTEND;TZID=America/New_York:20261021T100000\nSUMMARY:Q4 plan MSIP_Label_abc")
    r = Rig(ledger, tmp_path, clock, [(200, feed)] * 5)
    r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert "MSIP" not in d and "9:00 AM–10:00 AM (work item, title not kept)" in d
    assert "MSIP" not in ledger.get_meta("last_digest_text")


def test_without_calendars_the_digest_is_unchanged():
    assert compose(None).text == compose(digest.Agenda([], 0, 0, 0)).text
    assert "Today" not in compose(None).text


# -- end to end through the controller ----------------------------------------------------

def at_local(clock, h, m, d=21):
    clock.t = datetime(2026, 10, d, h, m, tzinfo=NY).astimezone(timezone.utc)


def canary_ok(engine="claude"):
    return result({"type": "answer", "text": "canary ok"}, engine=engine)


class Rig:
    def __init__(self, ledger, tmp_path, clock, replies, *, urls=U1,
                 proactive_from=date(2026, 10, 20)):
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("telegram_bot_token", TOKEN, by="Owner")
        self.vault.set_key("openai_api_key", OKEY, by="Owner")
        if urls:
            self.vault.set_key("calendar_feeds", urls, by="Owner")
        self.vault.try_pair(self.vault.new_pairing_code(), user_id=OWNER, chat_id=OWNER)
        self.bot = FakeBot()
        self.claude = FakeEngine("claude", [canary_ok()])
        self.gpt = FakeEngine("gpt", [canary_ok("gpt")])
        self.transport = FakeTransport(replies)
        self.status = {}
        self.cal = CalendarFeeds(ledger, self.transport, SyncExecutor(),
                                 lambda: self.vault.get("calendar_feeds"), "America/New_York")
        self.c = Controller(ledger=ledger, vault=self.vault, api=self.bot,
                            engines={"claude": self.claude, "gpt": self.gpt},
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1",
                                               proactive_from=proactive_from),
                            sleep=lambda s: None, monotonic=lambda: 0.0, status_box=self.status,
                            requests=queue.Queue(), poll_timeout=0, calendar=self.cal)
        self.c.startup()


def test_the_morning_digest_carries_todays_calendar(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("Clear · inputs fresh")
    assert "<b>Today</b>\nAll day · Feed delivery\n9:00 AM–10:00 AM Vet visit ⚠ overlaps\n" \
           "9:30 AM–10:30 AM School call ⚠ overlaps" in d
    assert r.status["last_digest"]["sent"] is True and "Vet visit" in \
        r.status["last_digest"]["text"]
    assert r.status["calendar"][0]["label"] == "owner@example.com"


def test_before_launch_the_digest_is_kept_for_the_page_not_sent(ledger, tmp_path, clock):
    at_local(clock, 6, 41, d=15)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    at_local(clock, 7, 0, d=15)
    r.c.tick()
    assert r.bot.sent == []
    last = r.status["last_digest"]
    assert last["sent"] is False and last["text"].startswith("Clear")
    ev = ledger.db.execute("SELECT detail FROM events WHERE kind='digest'").fetchone()
    assert json.loads(ev["detail"])["sent"] is False


def test_a_dead_feed_makes_the_digest_say_so(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(404, b"")] * 5)
    r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("<b>Attention needed</b>")
    assert "Calendar calendar " in d and "no successful read yet" in d and "reset" in d
    assert "can't say what's on it" in d


def test_the_digest_waits_briefly_for_a_read_in_flight(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    ex = ManualExecutor()
    r.cal.executor = ex
    at_local(clock, 7, 0)
    r.cal._last_start = None
    with ledger.tx() as db:            # make the last read old, so one is started now
        ledger.db.execute("UPDATE inputs SET last_success_at=? WHERE name LIKE 'calendar:%'",
                          ((clock() - timedelta(hours=1)).isoformat(),))
    r.c.tick()
    assert ex.pending and not any(t.startswith("Clear") for t in r.bot.texts())
    at_local(clock, 7, 6)              # past the grace period: compose without it
    r.c.tick()
    assert any("Clear" in t or "Attention" in t for t in r.bot.texts())


def test_a_feed_that_stopped_reading_goes_stale_after_two_hours(ledger, tmp_path, clock):
    at_local(clock, 4, 30)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] + [(500, b"")] * 20)
    r.c.tick()                          # read once at 4:30, then every read fails
    for m in range(35, 60 * 2 + 31, 31):
        clock.advance(minutes=31)
        r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("<b>Attention needed</b>")
    assert "Calendar owner@example.com: stale since Wed 4:30 AM (Google answered 500)" in d


def test_a_dead_feed_is_tried_once_before_the_digest_not_hammered(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(404, b"")] * 400)
    r.c.tick()
    n = len(r.transport.requests)
    for s_ in range(0, 6 * 60, 2):
        clock.t = datetime(2026, 10, 21, 7, 0, tzinfo=NY).astimezone(timezone.utc) + \
            timedelta(seconds=s_)
        r.c.tick()
    assert len(r.transport.requests) - n <= 1
    assert any(t.startswith("<b>Attention needed</b>") for t in r.bot.texts())


def test_a_read_that_never_finishes_is_abandoned(ledger, clock):
    ex = ManualExecutor()
    x = Feeds(ledger, [(200, TODAY)], executor=ex)
    x.f.maybe_start()
    clock.advance(minutes=4)
    x.f.collect()
    assert not x.f.pending
    assert ledger.inputs()[f"calendar:{feed_id(U1)}"]["last_error"] == "the read took too long"


@pytest.mark.parametrize("body,ok", [
    (b"\xef\xbb\xbf" + TODAY, True),
    (TODAY[:-30], False),
])
def test_bom_is_fine_and_a_cut_off_feed_is_a_failed_read(body, ok):
    r = fetch_one(FakeTransport([(200, body)]), U1, **bounds())
    assert r.ok is ok
    if ok:
        assert len(r.window.occurrences) == 3
    else:
        assert "cut off" in r.error


def test_status_shows_the_calendar(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    assert "Calendar owner@example.com: read" in r.c.status_text()


def test_no_calendar_no_reads_and_no_section(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [], urls="")
    r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    assert r.transport.requests == []
    assert "Today" not in r.bot.texts()[-1] and r.status["calendar"] == []


def test_the_harness_never_writes_to_a_calendar(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 20)
    for h in range(8):
        at_local(clock, 6 + h, 41)
        r.c.tick()
    assert r.transport.requests
    assert {q["method"] for q in r.transport.requests} == {"GET"}
    assert all(q["url"] == U1 and q["json"] is None for q in r.transport.requests)


def test_the_settings_page_shows_calendars_and_the_last_digest_escaped(tmp_path):
    from harness.setup_web import SetupApp, render_page
    v = Vault(str(tmp_path / "s.json"))
    v.set_key("calendar_feeds", U1, by="Owner")
    status = {"stage": "S1",
              "calendar": [{"label": "owner@example.com", "ok_at": "2026-10-21T10:30:00+00:00",
                            "error": "<script>x</script>"}],
              "last_digest": {"at": "2026-10-21T11:00:00+00:00", "sent": False,
                              "text": "Clear\n\n<b>Today</b>\n9:00 AM <img src=x> Vet"}}
    page = render_page(SetupApp(v, status, queue.Queue()), "u1", "Owner")
    assert "owner@example.com: <span class=\"ok\">read 2026-10-21 10:30 UTC" in page
    assert "&lt;script&gt;" in page and "<script>" not in page
    assert "not sent: recorded only, before launch" in page
    assert "Today" in page and "<b>Today</b>" not in page and "&lt;img src=x&gt;" in page
    status["last_digest"]["text"] = "Tom &amp; Jerry"
    page = render_page(SetupApp(v, status, queue.Queue()), "u1", "Owner")
    assert "Tom &amp; Jerry" in page and "&amp;amp;" not in page
    assert U1 not in page and "private-0123" not in page
    assert "calendar addresses (secret iCal" in page


def test_before_the_digest_a_failing_feed_is_read_once_a_morning(ledger, clock):
    clock.t = datetime(2026, 10, 21, 7, 0, tzinfo=NY).astimezone(timezone.utc)
    x = Feeds(ledger, [(404, b"")] * 10)
    for _ in range(5):
        x.f.maybe_start(before_digest=True); x.f.collect()
        clock.advance(seconds=30)
    assert len(x.t.requests) == 1
    clock.advance(days=1)
    x.f.maybe_start(before_digest=True)
    assert len(x.t.requests) == 2


def test_each_digest_leaves_one_log_line_for_the_watchdog(ledger, tmp_path, clock, caplog):
    at_local(clock, 6, 41, d=15)
    r = Rig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    at_local(clock, 7, 0, d=15)
    with caplog.at_level(logging.INFO, logger="harness.daily"):
        r.c.tick()
    lines = [m for m in caplog.messages if m.startswith("DIGEST ")]
    assert lines == ["DIGEST 2026-10-15 state=clear sent=no problems=0 waiting=0 events=0"]
    assert "Vet" not in caplog.text
