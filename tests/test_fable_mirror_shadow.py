"""Work-hours mirror, shadow mode: computes, records, never writes, never
changes the digest's state. (Fable Job B, 2026-10-18.)"""
import json
import queue
import re
import socket
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from harness import daily, digest, effects, mirror_shadow
from harness.calendar_feed import CalendarFeeds
from harness.config import Config
from harness.controller import Controller
from harness.family import FamilyInbox
from harness.ledger import Ledger
from harness.mirror_shadow import MirrorShadow
from harness.vault import Vault
from harness.workmirror import event_id

from conftest import OWNER, Clock
from fakes import FakeBot, FakeEngine, FakeTransport, SyncExecutor, result
from test_calendar import OKEY, TOKEN, U1, U2
from test_fable_mirror_spec import SERIES, ics

NY = ZoneInfo("America/New_York")
KEY = "k" * 40
SETTINGS = "work: me@work.example\nfamily: Pat - (.+) => {1}\n"
GYM = ("DTSTART;TZID=America/New_York:20261022T100000\n"
      "DTEND;TZID=America/New_York:20261022T110000\nSUMMARY:Gym")
MEETING = ("DTSTART;TZID=America/New_York:20261023T140000\n"
           "DTEND;TZID=America/New_York:20261023T150000\nSUMMARY:Meeting\n"
           "ATTENDEE:mailto:me@work.example")
CHECKUP = ("DTSTART;TZID=America/New_York:20261026T090000\n"
            "DTEND;TZID=America/New_York:20261026T100000\nSUMMARY:Checkup")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    real = socket.create_connection

    def refuse(address, *a, **k):
        if address[0] not in ("127.0.0.1", "localhost", "::1"):
            raise AssertionError(f"network call to {address[0]}")
        return real(address, *a, **k)
    monkeypatch.setattr(socket, "create_connection", refuse)


def at_local(clock, h, m=0, d=21):
    clock.t = datetime(2026, 10, d, h, m, tzinfo=NY).astimezone(timezone.utc)


def push(now, events, *, days=4, ok=True):
    day = now.astimezone(NY).date()
    start = datetime.combine(day, datetime.min.time(), tzinfo=NY)
    body = {"v": 1, "entity": "calendar.family", "state": "off", "ok": ok,
            "generated_at": now.isoformat(), "window_start": start.isoformat(),
            "window_end": (start + timedelta(days=days)).isoformat(),
            "events": [{"summary": t, "start": s, "end": e} for t, s, e in events]}
    return json.dumps(body).encode()


FAMILY = [("Pat - Dentist", "2026-10-22T09:00:00-04:00", "2026-10-22T09:30:00-04:00"),
          ("Kids school day", "2026-10-22T08:30:00-04:00", "2026-10-22T15:15:00-04:00"),
          ("Pat - Gym", "2026-10-22T10:00:00-04:00", "2026-10-22T11:00:00-04:00")]


class Rig:
    """Feeds and Family wired to a shadow, the way __main__.build does it."""

    def __init__(self, ledger, tmp_path, clock, replies, *, settings=SETTINGS, family=True,
                 urls=U1):
        self.ledger, self.clock = ledger, clock
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("calendar_feeds", urls, by="Owner")
        if settings:
            self.vault.set_key("work_mirror", settings, by="Owner")
        self.transport = FakeTransport(replies)
        self.cal = CalendarFeeds(ledger, self.transport, SyncExecutor(),
                                 lambda: self.vault.get("calendar_feeds"), "America/New_York",
                                 ahead_days=mirror_shadow.read_days(None),
                                 ahead_when=lambda: bool((self.vault.get("work_mirror") or "").strip()))
        self.inbox = FamilyInbox(str(tmp_path / "family.json"), clock) if family else None
        self.shadow = MirrorShadow(ledger, lambda: self.vault.get("work_mirror"),
                                   calendar=self.cal, family=self.inbox, tz="America/New_York")

    def read(self):
        self.cal.start()
        self.cal.collect()

    def family_push(self, events=FAMILY, **kw):
        self.inbox.receive(KEY, push(self.clock(), events, **kw))

    def run(self):
        self.read()
        return self.shadow.run()

    def table(self):
        return {r["event_id"]: dict(r) for r in self.ledger.db.execute("SELECT * FROM mirror_shadow")}

    def records(self):
        return [json.loads(r["detail"]) for r in self.ledger.db.execute(
            "SELECT detail FROM events WHERE kind=? ORDER BY id", (mirror_shadow.RUN_EVENT,))]


# -- a shadow run ----------------------------------------------------------------------------

def test_a_run_records_what_it_would_write_and_writes_only_the_shadow_copy(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM, MEETING, CHECKUP).encode())] * 3)
    r.family_push()
    rec = r.run()
    assert rec["status"] == "ok" and rec["complete"] is True
    assert (rec["read"], rec["configured"], rec["family"]) == (1, 1, "fresh")
    # Gym (Google), Checkup (Google), Dentist (Family only); Meeting already invited;
    # Pat - Gym is the same block as Gym.
    assert rec["copies"] == 3 and rec["add"] == 3 and rec["update"] == rec["delete"] == 0
    assert rec["skipped"] == {"already invited": 1, "same block is on his own calendar": 1}
    t = r.table()
    assert len(t) == 3 and all(row["title"] == "Busy" for row in t.values())
    assert sorted(row["label"] for row in t.values()) == ["Checkup", "Dentist", "Gym"]
    assert sorted(row["source"] for row in t.values()) == ["family", "google", "google"]
    # ground truth: the hand-marked Meeting would have been mirrored
    assert rec["hand"] == 1 and rec["would"] == 3 and rec["agree"] == 1
    assert rec["missed"] == [] and rec["extra"] == []
    assert rec["family_matches"] == 2 and rec["family_twins"] == 1 and rec["family_only"] == 1
    assert rec["duplicates"] == 0 and rec["leaks"] == 0 and rec["flaps"] == 0
    assert r.transport.requests and all(q["method"] == "GET" for q in r.transport.requests)
    assert ledger.db.execute("SELECT COUNT(*) AS n FROM outbox").fetchone()["n"] == 0


def test_the_complete_state_is_compared_every_run_not_a_diff(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM, CHECKUP).encode()),
                                      (200, ics(GYM.replace("T100000", "T110000")
                                                .replace("T110000\nSUMMARY", "T120000\nSUMMARY")).encode()),
                                      (200, ics(GYM, CHECKUP).encode())], family=False)
    a = r.run()
    clock.advance(minutes=30)
    b = r.run()                      # Gym moved, Checkup gone
    assert (b["add"], b["update"], b["delete"]) == (0, 1, 1)
    clock.advance(minutes=30)
    c = r.run()                      # back as it was: Checkup re-added, Gym moved back
    assert (c["add"], c["update"], c["delete"]) == (1, 1, 0)
    assert c["flaps"] == 1           # Checkup deleted then added across consecutive runs
    assert a["plan_hash"] == c["plan_hash"] != b["plan_hash"]


def test_a_partial_read_never_deletes_and_adds_no_family(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode()), (404, b""), (200, ics(GYM).encode())])
    r.family_push()
    r.run()
    assert len(r.table()) == 2                       # Gym, and the Family-only Dentist
    clock.advance(minutes=30)
    rec = r.run()
    assert rec["complete"] is False and rec["read"] == 0 and rec["delete"] == 0
    assert rec["partial_delete"] == 0 and rec["partial_family_add"] == 0
    assert len(r.table()) == 2 and rec["skipped"] == {"a calendar wasn't read": 2}
    # Family stale is a partial read too
    clock.advance(hours=3)
    rec = r.run()
    assert rec["family"] == "stale" and rec["complete"] is False and rec["delete"] == 0


def test_a_source_that_is_gone_is_deleted_only_on_a_complete_read(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM, CHECKUP).encode()), (200, ics().encode())],
            family=False)
    r.run()
    assert len(r.table()) == 2
    clock.advance(minutes=30)
    rec = r.run()
    assert rec["complete"] and rec["delete"] == 2 and r.table() == {}
    assert rec["deleted_still_blocks"] == 0


def test_family_copies_beyond_the_push_window_are_held_not_deleted(ledger, tmp_path, clock):
    far = [("Pat - Vet", "2026-10-23T10:00:00-04:00", "2026-10-23T11:00:00-04:00")]
    r = Rig(ledger, tmp_path, clock, [(200, ics().encode())] * 3)
    r.family_push(far, days=4)
    assert r.run()["add"] == 1
    clock.advance(minutes=30)
    r.family_push(far, days=1)                 # a narrower push: Friday is unread now
    rec = r.run()
    assert rec["complete"] and rec["delete"] == 0 and len(r.table()) == 1
    clock.advance(minutes=30)
    r.family_push([], days=4)                  # read that far and it is gone
    assert r.run()["delete"] == 1 and r.table() == {}


def test_no_settings_off_and_bad_settings_are_records_not_failures(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 3, settings="")
    assert r.run()["status"] == "no settings" and r.shadow.digest_line() == ""
    r.vault.set_key("work_mirror", "enabled: no", by="Owner")
    assert r.run()["status"] == "off" and "off in settings" in r.shadow.digest_line()
    r.shadow.settings_fn = lambda: "work: nonsense"
    rec = r.run()
    assert rec["status"] == "bad settings" and "nonsense" not in r.shadow.digest_line()
    assert r.table() == {}


def test_no_settings_records_nothing(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 3, settings="")
    r.family_push()
    for _ in range(2):
        assert r.run()["status"] == "no settings"
        clock.advance(minutes=31)
    assert r.records() == [] and r.table() == {} and r.shadow.last is None
    # entered later: the next run is recorded
    r.vault.set_key("work_mirror", SETTINGS, by="Owner")
    r.run()
    assert [x["status"] for x in r.records()] == ["ok"]


def test_a_shadow_bug_is_a_record_and_a_line_never_an_exception(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 2)
    r.shadow.settings_fn = lambda: 1 / 0
    rec = r.run()
    assert rec["status"] == "failed" and rec["error"] == "ZeroDivisionError"
    assert r.shadow.digest_line() == "Mirror: shadow only, not writing · last run failed (ZeroDivisionError)"


def test_hand_marked_blocks_the_rules_would_skip_count_as_missed(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(MEETING).encode())] * 2,
            settings=SETTINGS + "skip: Meeting\n", family=False)
    rec = r.run()
    assert rec["hand"] == 1 and rec["would"] == 0 and len(rec["missed"]) == 1


def test_extras_count_only_once_the_block_has_started(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 3, family=False)
    assert r.run()["extra"] == []                    # Thursday's Gym: not yet evidence
    at_local(clock, 10, 30, d=22)
    rec = r.run()
    assert rec["extra"] == [event_id("google", "e0@google.com")]


def test_runs_only_after_something_new_was_read(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 3)
    assert r.shadow.due()
    r.run()
    assert not r.shadow.due()
    r.family_push()
    assert r.shadow.due()
    r.shadow.run()
    assert not r.shadow.due()
    clock.advance(minutes=31)
    r.read()
    assert r.shadow.due()


def test_the_digest_line_is_counts_only(ledger, tmp_path, clock):
    r = Rig(ledger, tmp_path, clock, [(200, ics(GYM, MEETING, CHECKUP).encode())] * 2)
    r.family_push()
    r.run()
    line = r.shadow.digest_line()
    assert line.startswith("Mirror: shadow only, not writing · 3 copies · would add 3, change 0, "
                           "remove 0 · 2 skipped · read 1/1, Family fresh · ground truth: "
                           "1 hand-marked, 0 missed, 0 extra, Family 1 twins/1 only")
    for word in ("Gym", "Meeting", "Checkup", "Dentist", "me@work", "Pat"):
        assert word not in line
    # a shadow that has run before speaks from its last record (after a restart)
    assert MirrorShadow(ledger, lambda: SETTINGS).digest_line() == line
    # nothing entered: no line, whatever was recorded before
    assert MirrorShadow(ledger, lambda: "").digest_line() == ""


def test_no_line_until_settings_exist_and_the_shadow_has_run(ledger, tmp_path, clock):
    assert MirrorShadow(ledger, lambda: "").digest_line() == ""
    assert MirrorShadow(ledger, lambda: None).digest_line() == ""
    assert MirrorShadow(ledger, lambda: "  \n").digest_line() == ""
    assert MirrorShadow(ledger, lambda: SETTINGS).digest_line() == ""        # not run yet


# -- the ahead parse can never cost him today's agenda ------------------------------------------

TODAY = ("DTSTART;TZID=America/New_York:20261021T140000\n"
         "DTEND;TZID=America/New_York:20261021T150000\nSUMMARY:Standup")


def _counting_window(monkeypatch, *, fail_ahead=False):
    """Wraps the parser; records each window asked for, and optionally makes
    the long (ahead) one raise an error that is not ical.Unreadable."""
    from harness import calendar_feed
    real, spans = calendar_feed.ical.window, []

    def window(text, *, start, end, **kw):
        spans.append(end - start)
        if fail_ahead and end - start > timedelta(days=2):
            raise RuntimeError("ahead parser bug")
        return real(text, start=start, end=end, **kw)
    monkeypatch.setattr(calendar_feed.ical, "window", window)
    return spans


def test_an_ahead_parse_failure_leaves_todays_agenda_and_is_recorded(ledger, tmp_path, clock,
                                                                      monkeypatch):
    spans = _counting_window(monkeypatch, fail_ahead=True)
    r = Rig(ledger, tmp_path, clock, [(200, ics(TODAY, GYM).encode())] * 2, family=False)
    rec = r.run()
    assert any(s > timedelta(days=2) for s in spans)            # the ahead parse was tried
    occ, unreadable, read, configured = r.cal.agenda("2026-10-21")
    assert [o.summary for o in occ] == ["Standup"] and (read, configured) == (1, 1)
    row = ledger.inputs()[f"calendar:{next(iter(r.cal.snapshot.feeds))}"]
    assert row["last_success_at"] and not row["last_error"]
    assert all(res.ahead is None for res in r.cal.snapshot.feeds.values())
    failed = [json.loads(x["detail"]) for x in ledger.db.execute(
        "SELECT detail FROM events WHERE kind='calendar_ahead_failed'")]
    assert failed == [{"feed": next(iter(r.cal.snapshot.feeds)), "error": "RuntimeError"}]
    # the shadow sees the feed as unread: partial, nothing deleted
    assert rec["status"] == "ok" and rec["complete"] is False and rec["read"] == 0
    assert rec["delete"] == 0
    d = daily.gather(ledger, Config(owner_user_id=OWNER, stage="S1"), paused=False,
                     calendar=r.cal)
    assert "Standup" in d.text


def test_no_mirror_settings_means_no_ahead_parse(ledger, tmp_path, clock, monkeypatch):
    spans = _counting_window(monkeypatch)
    r = Rig(ledger, tmp_path, clock, [(200, ics(TODAY, GYM).encode())] * 2, settings="",
            family=False)
    r.read()
    assert spans and all(s <= timedelta(days=1) for s in spans)
    assert all(res.ahead is None for res in r.cal.snapshot.feeds.values())
    assert [o.summary for o in r.cal.agenda("2026-10-21")[0]] == ["Standup"]
    # entered later: the next read parses ahead
    r.vault.set_key("work_mirror", SETTINGS, by="Owner")
    spans.clear()
    clock.advance(minutes=31)
    r.read()
    assert any(s > timedelta(days=2) for s in spans)
    assert all(res.ahead is not None for res in r.cal.snapshot.feeds.values())


# -- the digest's state is never the mirror's to change ----------------------------------------

def compose(extra, **kw):
    base = dict(now=datetime(2026, 10, 22, 11, tzinfo=timezone.utc), tz="America/New_York",
                inputs=[digest.InputCoverage("Telegram", datetime(2026, 10, 22, 10, 59, tzinfo=timezone.utc),
                                             timedelta(minutes=15))],
                waiting=[], failures=[], low_balance=[], canary_ok=True,
                config_unchanged_since=datetime(2026, 10, 20, tzinfo=timezone.utc))
    base.update(kw)
    return digest.compose(extra=extra, **base)


LINES = ["Mirror: shadow only, not writing · 3 copies · would add 1, change 0, remove 0",
         "Mirror: shadow only, not writing · last run failed (ZeroDivisionError)",
         "Mirror: shadow only, not writing · settings refused",
         "Mirror: shadow only, not writing · 0 copies · would add 0, change 0, remove 9 · read 0/1, partial"]


@pytest.mark.parametrize("line", LINES)
def test_shadow_outcomes_never_alter_the_digest_state_in_either_direction(line):
    clear = compose([line])
    assert clear.state == "clear" and clear.text.startswith("Clear ·") and line in clear.text
    assert clear.facts["problems"] == 0
    decision = compose([line], waiting=[digest.Waiting("x", datetime(2026, 10, 22, 9, tzinfo=timezone.utc))])
    assert decision.state == "decision" and line in decision.text
    attention = compose([line], failures=["job 1: boom"])
    assert attention.state == "attention" and line in attention.text
    # and without the line, the states are the same (the line is purely informational)
    assert compose([]).state == "clear" and compose([], failures=["x"]).state == "attention"
    # a failure line is not a problem line
    assert "• Mirror" not in attention.text and attention.facts["problems"] == 1


def test_gather_passes_the_line_and_nothing_else_changes(ledger, clock):
    cfg = Config(owner_user_id=OWNER, stage="S1")
    ledger.input_ok("telegram")
    with ledger.tx() as db:
        ledger.set_meta("last_poll_success", clock().isoformat(), db)
    with_line = daily.gather(ledger, cfg, paused=False, mirror_line=LINES[1])
    without = daily.gather(ledger, cfg, paused=False)
    assert with_line.state == without.state and with_line.facts == without.facts
    assert with_line.text == without.text + "\n\n" + LINES[1]


# -- through the controller, with every write-capable client replaced by one that raises ---------

class RaisingBot(FakeBot):
    """Reads work; anything that would reach Telegram's write side raises."""

    def send_message(self, *a, **k):
        raise AssertionError("send_message called")

    def edit_reply_markup(self, *a, **k):
        raise AssertionError("edit_reply_markup called")

    def answer_callback(self, *a, **k):
        raise AssertionError("answer_callback called")


class ReadOnlyTransport(FakeTransport):
    def request(self, method, url, **kw):
        if method != "GET" or not url.startswith("https://calendar.google.com/"):
            raise AssertionError(f"write-capable request {method} {url[:40]}")
        return super().request(method, url, **kw)


class Stack:
    def __init__(self, ledger, tmp_path, clock, replies, *, settings=SETTINGS, urls=U1,
                 wired=True):
        self.vault = Vault(str(tmp_path / "secrets.json"), clock=clock)
        self.vault.set_key("telegram_bot_token", TOKEN, by="Owner")
        self.vault.set_key("openai_api_key", OKEY, by="Owner")
        self.vault.set_key("calendar_feeds", urls, by="Owner")
        if settings:
            self.vault.set_key("work_mirror", settings, by="Owner")
        self.vault.try_pair(self.vault.new_pairing_code(), user_id=OWNER, chat_id=OWNER)
        self.bot = RaisingBot()
        self.transport = ReadOnlyTransport(replies)
        self.status = {}
        self.cal = CalendarFeeds(ledger, self.transport, SyncExecutor(),
                                 lambda: self.vault.get("calendar_feeds"), "America/New_York",
                                 ahead_days=mirror_shadow.read_days(None),
                                 ahead_when=lambda: bool((self.vault.get("work_mirror") or "").strip()))
        self.inbox = FamilyInbox(str(tmp_path / "family.json"), clock)
        self.shadow = MirrorShadow(ledger, lambda: self.vault.get("work_mirror"),
                                   calendar=self.cal, family=self.inbox, tz="America/New_York")
        engines = {"claude": FakeEngine("claude", [result(text="canary ok")]),
                   "gpt": FakeEngine("gpt", [result(text="canary ok", engine="gpt")])}
        self.c = Controller(ledger=ledger, vault=self.vault, api=self.bot, engines=engines,
                            executor=SyncExecutor(),
                            base_config=Config(owner_user_id=1, stage="S1",
                                               proactive_from=date(2026, 10, 20)),
                            sleep=lambda s: None, monotonic=lambda: 0.0, status_box=self.status,
                            requests=queue.Queue(), poll_timeout=0, calendar=self.cal,
                            family=self.inbox, mirror=self.shadow if wired else None)
        self.c.startup()


def spec_feeds():
    """Every iCal-level fixture of the spec, as one feed body each."""
    from test_fable_mirror_spec import ics as spec_ics
    return [spec_ics(GYM, MEETING, CHECKUP), spec_ics(SERIES), spec_ics(),
            spec_ics("DTSTART;VALUE=DATE:20261022\nSUMMARY:Trip"),
            spec_ics("DTSTART;TZID=Nowhere/Zone:20261022T100000\n"
                     "DTEND;TZID=Nowhere/Zone:20261022T110000\nSUMMARY:Odd"),
            spec_ics(GYM + "\nTRANSP:TRANSPARENT"),
            spec_ics(SERIES, "UID:e0@google.com\nRECURRENCE-ID;TZID=America/New_York:20261027T090000\n"
                             "DTSTART;TZID=America/New_York:20261028T140000\n"
                             "DTEND;TZID=America/New_York:20261028T150000\nSUMMARY:Gym"),
            spec_ics(SERIES + "\nEXDATE;TZID=America/New_York:20261027T090000"),
            spec_ics(GYM + "\nSTATUS:CANCELLED"), spec_ics(GYM, MEETING, CHECKUP)]


def test_shadow_over_every_spec_fixture_touches_no_write_capable_client(ledger, tmp_path, clock,
                                                                         monkeypatch):
    def refuse(*a, **k):
        raise AssertionError("effects.lookup called from shadow mode")
    monkeypatch.setattr(effects, "lookup", refuse)
    at_local(clock, 8, 0)
    ledger.set_meta("digest_date", "2026-10-21")       # today's digest and canary are done:
    ledger.set_meta("canary_date", "2026-10-21")       # nothing else may want to send
    feeds = spec_feeds()
    s = Stack(ledger, tmp_path, clock, [(200, f.encode()) for f in feeds] + [(404, b"")])
    s.inbox.receive(KEY, push(clock(), FAMILY))
    for _ in feeds:
        s.c.tick()
        clock.advance(minutes=31)
    s.c.tick()                                   # the 404: a partial read
    recs = [json.loads(r["detail"]) for r in ledger.db.execute(
        "SELECT detail FROM events WHERE kind=? ORDER BY id", (mirror_shadow.RUN_EVENT,))]
    assert len(recs) == len(feeds) + 1 and all(r["status"] == "ok" for r in recs)
    assert sum(r["duplicates"] + r["leaks"] + r["partial_delete"] + r["partial_family_add"]
               + r["deleted_still_blocks"] for r in recs) == 0
    assert recs[-1]["complete"] is False and recs[-1]["delete"] == 0
    assert all(q["method"] == "GET" for q in s.transport.requests)
    assert s.bot.sent == [] and ledger.db.execute("SELECT COUNT(*) AS n FROM outbox").fetchone()["n"] == 0
    assert ledger.db.execute("SELECT COUNT(*) AS n FROM proposals").fetchone()["n"] == 0
    assert "shadow only" in s.shadow.digest_line()


def test_the_digest_carries_the_line_and_a_shadow_failure_leaves_it_clear(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    s = Stack(ledger, tmp_path, clock, [(200, ics(GYM).encode())] * 6)
    s.bot.send_message = FakeBot.send_message.__get__(s.bot)      # the digest may go out
    s.inbox.receive(KEY, push(clock(), FAMILY))
    s.c.tick()
    s.shadow.settings_fn = lambda: 1 / 0                           # the shadow breaks
    at_local(clock, 7, 0)
    s.inbox.receive(KEY, push(clock(), FAMILY))
    s.c.tick()
    d = s.bot.texts()[-1]
    assert d.startswith("Clear · inputs fresh")
    assert "Mirror: shadow only, not writing · last run failed (ZeroDivisionError)" in d
    assert ledger.get_meta("last_digest_text") == d


def _digest_text(base, clock, wired):
    base.mkdir()
    lg = Ledger(str(base / "harness.sqlite"), clock=clock)
    s = Stack(lg, base, clock, [(200, ics(GYM).encode())] * 6, settings="", wired=wired)
    s.bot.send_message = FakeBot.send_message.__get__(s.bot)      # the digest may go out
    s.inbox.receive(KEY, push(clock(), FAMILY))
    s.c.tick()
    at_local(clock, 7, 0)
    s.inbox.receive(KEY, push(clock(), FAMILY))
    s.c.tick()
    text = lg.get_meta("last_digest_text")
    assert text and s.bot.texts()[-1] == text
    return text


def test_with_no_settings_the_digest_is_byte_identical_with_or_without_the_shadow(tmp_path):
    texts = []
    for wired in (False, True):
        clock = Clock()
        at_local(clock, 6, 41)
        texts.append(_digest_text(tmp_path / f"wired-{wired}", clock, wired))
    assert texts[0] == texts[1]
    assert "Mirror" not in texts[1]


# -- static: nothing in the shadow's reach can write ---------------------------------------------

def test_shadow_module_imports_no_client_and_no_effect():
    src = Path(mirror_shadow.__file__).read_text()
    for name in ("net", "telegram_api", "engines", "effects", "outbox", "approvals", "urllib",
                 "http", "socket"):
        assert not re.search(rf"^\s*(from \.?{name}\b|import {name}\b|from \. import .*\b{name}\b)",
                             src, re.M), name
    assert "work_mirror_copy" not in src and "enqueue" not in src
