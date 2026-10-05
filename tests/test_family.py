"""The Family calendar, pushed in by Home Assistant: what the listener
accepts, how a squatter or a replay fails, and what the digest says.
Stores only; unknown is never an empty day; Family never marks an overlap."""
import http.client
import json
import logging
import queue
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from harness import daily, digest, family
from harness.calendar_feed import CalendarFeeds, today_bounds
from harness.config import Config
from harness.controller import Controller, family_line
from harness.family import FamilyInbox, Rejected, parse
from harness.setup_web import SetupApp, render_page
from harness.vault import Vault
from conftest import OWNER
from fakes import FakeBot, FakeEngine, FakeTransport, SyncExecutor
from test_calendar import TODAY, TOKEN, OKEY, U1, Rig, at_local, canary_ok

NY = ZoneInfo("America/New_York")
KEY = "k" * 40
KEY2 = "z" * 40


def body(now, *, events=None, ok=True, state="off", gen=None, ws=None, we=None, **extra):
    day = now.astimezone(NY).date()
    start = datetime.combine(day, datetime.min.time(), tzinfo=NY)
    d = {"v": 1, "entity": "calendar.family", "state": state, "ok": ok,
         "generated_at": (gen or now).isoformat(),
         "window_start": (ws or start).isoformat(),
         "window_end": (we or start + timedelta(days=2)).isoformat(),
         "events": events if events is not None else [
             {"summary": "Sam - Dentist", "start": f"{day}T09:30:00-04:00",
              "end": f"{day}T10:30:00-04:00"},
             {"summary": "School day", "start": f"{day}T08:30:00-04:00",
              "end": f"{day}T15:15:00-04:00"},
             {"summary": "Trip", "start": str(day), "end": str(day + timedelta(days=3))},
             {"summary": "Tomorrow thing", "start": f"{day + timedelta(days=1)}T09:00:00-04:00",
              "end": f"{day + timedelta(days=1)}T10:00:00-04:00"}]}
    d.update(extra)
    return json.dumps(d).encode()


def now_ny(h=6, m=30, d=21):
    return datetime(2026, 10, d, h, m, tzinfo=NY).astimezone(timezone.utc)


# -- the schema ------------------------------------------------------------------------

def test_a_good_push_parses():
    now = now_ny()
    p = parse(body(now), entity="calendar.family", now=now, last_generated=None)
    assert p.ok and len(p.events) == 4
    assert p.events[2][1] == date(2026, 10, 21)


@pytest.mark.parametrize("mutate,reason", [
    (lambda d: d.pop("state"), "wrong shape"),
    (lambda d: d.update(extra=1), "wrong shape"),
    (lambda d: d.update(v=2), "unknown version"),
    (lambda d: d.update(v=True), "unknown version"),
    (lambda d: d.update(entity="calendar.calendar"), "wrong calendar"),
    (lambda d: d.update(ok="yes"), "bad ok flag"),
    (lambda d: d.update(state="x" * 40), "bad state"),
    (lambda d: d.update(generated_at="2026-10-21T06:30:00"), "generated_at has no time zone"),
    (lambda d: d.update(window_end=d["window_start"]), "bad window"),
    (lambda d: d.update(events={}), "bad events"),
    (lambda d: d["events"].append({"summary": "x", "start": "2026-10-21"}), "bad event"),
    (lambda d: d["events"].append({"summary": "x", "start": "2026-10-21",
                                   "end": "2026-10-21", "location": "home"}), "bad event"),
    (lambda d: d["events"].append({"summary": 5, "start": "2026-10-21",
                                   "end": "2026-10-22"}), "bad title"),
    (lambda d: d["events"].append({"summary": "x", "start": "2026-10-21",
                                   "end": "2026-10-21T10:00:00-04:00"}),
     "mixed all-day and timed"),
    (lambda d: d["events"].append({"summary": "x", "start": "2026-10-21T10:00:00-04:00",
                                   "end": "2026-10-21T09:00:00-04:00"}),
     "ends before it starts"),
    (lambda d: d["events"].append({"summary": "x", "start": "2026-10-21T10:00:00",
                                   "end": "2026-10-21T11:00:00"}), "start has no time zone"),
    (lambda d: d.update(ok=False), "events without a read"),
])
def test_anything_unexpected_is_refused(mutate, reason):
    now = now_ny()
    d = json.loads(body(now))
    mutate(d)
    with pytest.raises(Rejected, match=f"^{reason}$"):
        parse(json.dumps(d).encode(), entity="calendar.family", now=now, last_generated=None)


def test_too_many_events_and_not_json_are_refused():
    now = now_ny()
    many = [{"summary": "x", "start": "2026-10-21", "end": "2026-10-22"}] * 301
    with pytest.raises(Rejected, match="bad events"):
        parse(body(now, events=many), entity="calendar.family", now=now, last_generated=None)
    with pytest.raises(Rejected, match="not JSON"):
        parse(b"\xff{", entity="calendar.family", now=now, last_generated=None)


def test_old_future_and_replayed_pushes_are_refused():
    now = now_ny()
    with pytest.raises(Rejected, match="too old"):
        parse(body(now, gen=now - timedelta(minutes=16)), entity="calendar.family",
              now=now, last_generated=None)
    with pytest.raises(Rejected, match="from the future"):
        parse(body(now, gen=now + timedelta(minutes=3)), entity="calendar.family",
              now=now, last_generated=None)
    with pytest.raises(Rejected, match="replayed"):
        parse(body(now), entity="calendar.family", now=now, last_generated=now)
    parse(body(now, gen=now - timedelta(minutes=14)), entity="calendar.family", now=now,
          last_generated=now - timedelta(minutes=30))


def test_a_null_title_is_kept_as_no_title(tmp_path):
    now = now_ny()
    inbox = FamilyInbox(str(tmp_path / "f.json"), lambda: now)
    day = "2026-10-21"
    inbox.receive(KEY, body(now, events=[{"summary": None, "start": day, "end": "2026-10-22"}]))
    s, e, _ = today_bounds(now, "America/New_York")
    v = inbox.view(now, "America/New_York", s, e)
    assert [o.summary for o in v.occurrences] == ["(no title)"]


# -- the key ---------------------------------------------------------------------------

class T:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def test_the_first_key_is_pinned_and_a_different_one_is_refused(tmp_path):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    inbox.receive(KEY, body(clock.t))
    clock.t += timedelta(minutes=30)
    with pytest.raises(Rejected, match="wrong key"):
        inbox.receive(KEY2, body(clock.t))
    st = inbox.status()
    assert st["rejected"] == "wrong key" and st["key_pinned_at"]
    inbox.receive(KEY, body(clock.t))
    # survives a restart, and the file never holds the key itself
    again = FamilyInbox(str(tmp_path / "f.json"), clock)
    with pytest.raises(Rejected, match="wrong key"):
        again.receive(KEY2, body(clock.t + timedelta(minutes=1)))
    assert KEY not in (tmp_path / "f.json").read_text()
    assert oct((tmp_path / "f.json").stat().st_mode & 0o777) == "0o600"


@pytest.mark.parametrize("key", ["", "short", "x" * 129, "k" * 39 + "!"])
def test_a_missing_or_malformed_key_is_refused_and_pins_nothing(tmp_path, key):
    now = now_ny()
    inbox = FamilyInbox(str(tmp_path / "f.json"), lambda: now)
    with pytest.raises(Rejected, match="no key"):
        inbox.receive(key, body(now))
    assert inbox.status()["key_pinned_at"] is None


def test_a_bad_body_does_not_pin_the_key(tmp_path):
    now = now_ny()
    inbox = FamilyInbox(str(tmp_path / "f.json"), lambda: now)
    with pytest.raises(Rejected):
        inbox.receive(KEY2, b"{}")
    inbox.receive(KEY, body(now))
    assert inbox.status()["key_pinned_at"]


def test_a_replay_of_the_last_push_is_refused(tmp_path):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    b = body(clock.t)
    inbox.receive(KEY, b)
    clock.t += timedelta(minutes=1)
    with pytest.raises(Rejected, match="replayed"):
        inbox.receive(KEY, b)


def test_forget_drops_the_key_and_the_events(tmp_path):
    now = now_ny()
    inbox = FamilyInbox(str(tmp_path / "f.json"), lambda: now)
    inbox.receive(KEY, body(now))
    inbox.forget()
    assert inbox.status()["received_at"] is None and inbox.status()["key_pinned_at"] is None
    with pytest.raises(Rejected, match="not accepting a new key"):
        inbox.receive(KEY2, body(now + timedelta(seconds=1)))
    inbox.arm()
    inbox.receive(KEY2, body(now + timedelta(seconds=2)))


# -- what the digest may say ------------------------------------------------------------

def view_at(inbox, now):
    s, e, _ = today_bounds(now, "America/New_York")
    return inbox.view(now, "America/New_York", s, e)


def test_statuses(tmp_path):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    assert view_at(inbox, clock.t).status == "never"
    with pytest.raises(Rejected):
        inbox.receive(KEY, b"nope")
    v = view_at(inbox, clock.t)
    assert (v.status, v.rejected) == ("never", "not JSON")
    inbox.receive(KEY, body(clock.t))
    v = view_at(inbox, clock.t)
    assert v.status == "fresh" and v.rejected == ""
    assert sorted(o.summary for o in v.occurrences) == ["Sam - Dentist", "School day", "Trip"]
    assert all(o.transparent and o.calendar == "Family" for o in v.occurrences)
    clock.t += timedelta(hours=2, minutes=1)
    assert view_at(inbox, clock.t).status == "stale"
    inbox.receive(KEY, body(clock.t, ok=False, events=[], state="unavailable"))
    assert view_at(inbox, clock.t).status == "unavailable"
    clock.t += timedelta(minutes=30)
    inbox.receive(KEY, body(clock.t, state="unavailable"))
    assert view_at(inbox, clock.t).status == "unavailable"


def test_yesterdays_push_does_not_cover_today(tmp_path):
    clock = T(now_ny(23, 50, d=20))
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    inbox.receive(KEY, body(clock.t, we=datetime(2026, 10, 21, 12, 0, tzinfo=NY)))
    clock.t = now_ny(0, 10)
    assert view_at(inbox, clock.t).status == "window"
    assert "time zone" in daily.family_problem(view_at(inbox, clock.t), "America/New_York")


def test_problem_lines():
    tz = "America/New_York"
    at = now_ny(5, 0)
    assert daily.family_problem(family.FamilyView("never", None, "", []), tz) == \
        "Family calendar: nothing from Home Assistant yet"
    assert daily.family_problem(family.FamilyView("never", None, "wrong key", []), tz) == \
        "Family calendar: nothing from Home Assistant yet (last push refused: wrong key)"
    assert daily.family_problem(family.FamilyView("stale", at, "", []), tz) == \
        "Family calendar: not updated since Wed 5:00 AM"
    assert daily.family_problem(family.FamilyView("unavailable", at, "", []), tz) == \
        "Family calendar: Home Assistant couldn't read it (as of Wed 5:00 AM)"
    assert daily.family_problem(family.FamilyView("fresh", at, "", []), tz) == ""


def test_status_line():
    tz = NY
    assert family_line({"received_at": None}, tz) == "no push from Home Assistant yet"
    st = {"received_at": "2026-10-21T10:30:00+00:00", "ok": True, "events": 3,
          "rejected_at": "2026-10-21T11:00:00+00:00", "rejected": "wrong key"}
    assert family_line(st, tz) == ("last push Wed 6:30 AM, 3 event(s) "
                                   "(last push refused: wrong key)")
    st["ok"] = False
    st["rejected_at"] = "2026-10-21T10:00:00+00:00"
    assert family_line(st, tz) == ("last push Wed 6:30 AM, 3 event(s), "
                                   "Home Assistant couldn't read it")


# -- end to end ------------------------------------------------------------------------

class FamRig(Rig):
    def __init__(self, ledger, tmp_path, clock, replies, **kw):
        super().__init__(ledger, tmp_path, clock, replies, **kw)
        self.inbox = FamilyInbox(str(tmp_path / "family.json"), clock)
        self.c.family = self.inbox


def test_the_digest_lists_family_as_context_never_as_an_overlap(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = FamRig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    r.inbox.receive(KEY, body(clock.t))
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("Clear · inputs fresh"), d
    assert ("<b>Today</b>\n"
            "All day · Feed delivery · owner\n"
            "All day · Trip · Family\n"
            "8:30 AM–3:15 PM School day · Family\n"
            "9:00 AM–10:00 AM Vet visit · owner ⚠ overlaps\n"
            "9:30 AM–10:30 AM Sam - Dentist · Family\n"
            "9:30 AM–10:30 AM School call · owner ⚠ overlaps") in d
    assert "Tomorrow thing" not in d


def test_without_a_push_the_day_is_never_clear(ledger, tmp_path, clock, caplog):
    at_local(clock, 6, 41)
    r = FamRig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.tick()
    at_local(clock, 7, 0)
    with caplog.at_level(logging.INFO, logger="harness.daily"):
        r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("<b>Attention needed</b>")
    assert "• Family calendar: nothing from Home Assistant yet" in d
    assert "<b>Today</b> · from 1 of 2 calendars" in d
    assert "family=never" in caplog.text


def test_family_alone_without_google_feeds(ledger, tmp_path, clock, caplog):
    at_local(clock, 6, 41)
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.c.tick()
    r.inbox.receive(KEY, body(clock.t))
    at_local(clock, 7, 0)
    with caplog.at_level(logging.INFO, logger="harness.daily"):
        r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("Clear"), d
    assert "<b>Today</b>\nAll day · Trip\n8:30 AM–3:15 PM School day\n" \
           "9:30 AM–10:30 AM Sam - Dentist" in d
    assert "overlaps" not in d
    assert "events=3 family=fresh" in caplog.text
    assert "Dentist" not in caplog.text


def test_a_work_title_from_family_is_kept_as_a_slot(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.c.base_config = Config(owner_user_id=1, stage="S1", proactive_from=date(2026, 10, 20),
                             work_markers=("Purview",))
    r.c.config = None
    r.c.startup()
    r.c.tick()
    r.inbox.receive(KEY, body(clock.t, events=[
        {"summary": "Microsoft Purview review", "start": "2026-10-21T09:00:00-04:00",
         "end": "2026-10-21T10:00:00-04:00"}]))
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert "Purview" not in d and "(work item, title not kept)" in d


def test_titles_from_family_are_escaped_and_defanged(ledger, tmp_path, clock):
    at_local(clock, 6, 41)
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.c.tick()
    r.inbox.receive(KEY, body(clock.t, events=[
        {"summary": "<b>x</b> see evil.example/a", "start": "2026-10-21",
         "end": "2026-10-22"}]))
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert "<b>x</b>" not in d and "&lt;b&gt;" in d and "evil.example/a" not in d


def test_reset_forgets_the_pinned_key(ledger, tmp_path, clock):
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.inbox.receive(KEY, body(clock.t))
    r.c.requests.put({"type": "reset", "by": "Owner"})
    r.c.tick()
    assert r.inbox.status()["key_pinned_at"] is None


def test_status_and_page_show_counts_not_titles(ledger, tmp_path, clock):
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.inbox.receive(KEY, body(clock.t))
    r.c.tick()
    assert "Family calendar: last push" in r.c.status_text()
    assert r.status["family"]["events"] == 4
    page = render_page(SetupApp(r.vault, r.status, queue.Queue()), "u1", "Owner")
    assert "Family calendar (from Home Assistant)" in page and "4 event(s)" in page
    card = page.split("Family calendar (from Home Assistant)", 1)[1].split("</div><h2>", 1)[0]
    assert "Dentist" not in card and KEY not in page and "key pinned" in card


def test_not_expected_means_no_line_and_no_listener_effect(ledger, tmp_path, clock):
    r = FamRig(ledger, tmp_path, clock, [(200, TODAY)] * 5)
    r.c.base_config = Config(owner_user_id=1, stage="S1", family_entity="")
    r.c.config = None
    r.c.tick()
    assert "Family" not in r.c.status_text()
    assert r.status["family"] is None


# -- the listener, over a real socket ---------------------------------------------------

@pytest.fixture
def server(tmp_path):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    httpd = family.serve(inbox, host="127.0.0.1", port=0, allowed_peers=("127.0.0.1",))
    yield inbox, clock, httpd.server_address[1]
    httpd.shutdown()


def post(port, data, *, path="/family", key=KEY, ctype="application/json", method="POST"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": ctype}
    if key is not None:
        headers["X-Harness-Key"] = key
    c.request(method, path, body=data, headers=headers)
    r = c.getresponse()
    out = (r.status, r.read().decode())
    c.close()
    return out


def test_listener_accepts_and_refuses(server):
    inbox, clock, port = server
    assert post(port, body(clock.t)) == (204, "")
    clock.t += timedelta(minutes=30)
    assert post(port, body(clock.t), key=KEY2) == (401, "wrong key")
    assert post(port, body(clock.t), key=None) == (401, "no key")
    assert post(port, body(clock.t), path="/other") == (404, "")
    assert post(port, body(clock.t), ctype="text/plain") == (415, "")
    assert post(port, b"x" * (family.MAX_BODY + 1)) == (413, "")
    assert post(port, b"", method="GET")[0] == 405
    assert post(port, b"{}") == (400, "wrong shape")
    b = body(clock.t)
    assert post(port, b) == (204, "")
    assert post(port, b) == (409, "replayed")


def test_listener_refuses_other_addresses(tmp_path):
    inbox = FamilyInbox(str(tmp_path / "f.json"), now_ny)
    httpd = family.serve(inbox, host="127.0.0.1", port=0, allowed_peers=("172.30.32.1",))
    try:
        with pytest.raises((http.client.RemoteDisconnected, ConnectionError)):
            post(httpd.server_address[1], body(now_ny()))
        assert inbox.status()["key_pinned_at"] is None
    finally:
        httpd.shutdown()


# -- the label fix ---------------------------------------------------------------------

def test_an_address_label_is_not_defanged():
    assert digest._short("first.last@example.com") == "first last"
    assert digest._short("Family") == "Family"


def test_build_starts_the_listener_on_its_own_port(tmp_path):
    from harness.__main__ import build
    controller, web, listener = build(str(tmp_path), port=0, family_port=0)
    try:
        assert listener is not None and controller.family is not None
        assert listener.server_address[1] != web.server_address[1]
    finally:
        web.shutdown(); listener.shutdown()
        controller.executor.shutdown(wait=False)
        controller.ledger.close()


# Rendered by Home Assistant 2026-10-05 from the DOCS.md template (titles shortened).
FROM_HA = (b'{"v":1,"entity":"calendar.family","state":"on","ok":true,'
           b'"generated_at":"2026-10-05T16:00:22.571925-04:00",'
           b'"window_start":"2026-10-05T00:00:00-04:00","window_end":"2026-10-07T00:00:00-04:00",'
           b'"events":[{"summary":"School Day \xf0\x9f\x93\x9a","start":"2026-10-05T08:30:00-04:00",'
           b'"end":"2026-10-05T15:15:00-04:00"},{"summary":"Sam - Trip",'
           b'"start":"2026-10-06","end":"2026-10-10"}]}')


def test_what_home_assistant_actually_sends_is_accepted(tmp_path):
    now = datetime(2026, 10, 5, 16, 1, tzinfo=NY)
    inbox = FamilyInbox(str(tmp_path / "f.json"), lambda: now)
    inbox.receive(KEY, FROM_HA)
    s, e, _ = today_bounds(now, "America/New_York")
    v = inbox.view(now, "America/New_York", s, e)
    assert v.status == "fresh" and [o.summary for o in v.occurrences] == ["School Day 📚"]


# -- after review: arming, loud squatters, refusals, damaged files, thread cap ----------

def test_a_key_is_pinned_only_while_armed(tmp_path):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)        # starts armed: unpinned
    assert inbox.status()["armed"]
    clock.t += family.ARM_FOR + timedelta(seconds=1)
    assert not inbox.status()["armed"]
    with pytest.raises(Rejected, match="not accepting a new key"):
        inbox.receive(KEY, body(clock.t))
    assert inbox.status()["key_pinned_at"] is None
    inbox.arm()
    inbox.receive(KEY, body(clock.t))
    assert inbox.status()["key_pinned_at"] and not inbox.status()["armed"]
    # a pinned inbox restarted is not armed, and arming changes nothing
    again = FamilyInbox(str(tmp_path / "f.json"), clock)
    again.arm()
    with pytest.raises(Rejected, match="wrong key"):
        again.receive(KEY2, body(clock.t + timedelta(minutes=1)))


def test_wrong_keys_reach_the_digest_even_while_good_pushes_arrive(ledger, tmp_path, clock):
    at_local(clock, 6, 0)
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    r.inbox.receive(KEY, body(clock.t))
    clock.advance(minutes=10)
    for _ in range(3):
        with pytest.raises(Rejected):
            r.inbox.receive(KEY2, body(clock.t))
    clock.advance(minutes=20)
    r.inbox.receive(KEY, body(clock.t))
    r.c.tick()
    at_local(clock, 7, 0)
    r.c.tick()
    d = r.bot.texts()[-1]
    assert d.startswith("<b>Attention needed</b>")
    assert "Family calendar: 3 push(es) with the wrong key" in d
    assert "School day" in d                       # still listed: the good push is fresh
    # the next day, with no new attempts, it is not repeated
    at_local(clock, 6, 30, d=22)
    r.inbox.receive(KEY, body(clock.t))
    at_local(clock, 7, 0, d=22)
    r.c.tick()
    assert "wrong key" not in r.bot.texts()[-1]


def test_refusals_before_the_body_are_recorded(server):
    inbox, clock, port = server
    post(port, body(clock.t), path="/other")
    assert inbox.status()["rejected"] == "wrong path"
    post(port, body(clock.t), ctype="text/plain")
    assert inbox.status()["rejected"] == "not JSON"
    post(port, b"x" * (family.MAX_BODY + 1))
    assert inbox.status()["rejected"] == "too big"


def test_refusals_are_written_at_most_once_a_minute(tmp_path, monkeypatch):
    clock = T(now_ny())
    inbox = FamilyInbox(str(tmp_path / "f.json"), clock)
    saves = []
    real = inbox._save
    monkeypatch.setattr(inbox, "_save", lambda: (saves.append(1), real()))
    for _ in range(20):
        with pytest.raises(Rejected):
            inbox.receive("", b"x")
    assert len(saves) == 1 and inbox.status()["rejected"] == "no key"
    clock.t += timedelta(minutes=1)
    with pytest.raises(Rejected):
        inbox.receive("", b"x")
    assert len(saves) == 2


@pytest.mark.parametrize("content", [
    "[]", "not json", '{"last": {"received_at": "x"}}', '{"last": 5}',
    '{"key_hash": 5}', '{"rejected": {"at": "nope"}}',
    '{"last": {"received_at": "2026-10-21T10:00:00+00:00", "generated_at": '
    '"2026-10-21T10:00:00+00:00", "window_start": "2026-10-21T04:00:00+00:00", '
    '"window_end": "2026-10-23T04:00:00+00:00", "ok": true, "state": "on", '
    '"events": [["t", "bad", "2026-10-22"]]}}'])
def test_a_damaged_file_is_a_fresh_start_not_a_crash(tmp_path, content):
    (tmp_path / "f.json").write_text(content)
    inbox = FamilyInbox(str(tmp_path / "f.json"), now_ny)
    assert view_at(inbox, now_ny()).status == "never"
    assert inbox.status()["armed"]


def test_an_unreadable_path_is_a_fresh_start(tmp_path):
    (tmp_path / "f.json").mkdir()
    inbox = FamilyInbox(str(tmp_path / "f.json"), now_ny)
    assert inbox.status()["received_at"] is None


def test_at_most_two_connections_at_once(tmp_path):
    inbox = FamilyInbox(str(tmp_path / "f.json"), now_ny)
    srv = family._Server(("127.0.0.1", 0), family.make_handler(inbox, ("127.0.0.1",)),
                         ("127.0.0.1",))
    try:
        assert srv.verify_request(None, ("127.0.0.1", 1))
        assert srv.verify_request(None, ("127.0.0.1", 2))
        assert not srv.verify_request(None, ("127.0.0.1", 3))
        srv.slots.release()
        assert srv.verify_request(None, ("127.0.0.1", 4))
        assert not srv.verify_request(None, ("10.0.0.1", 5))
    finally:
        srv.server_close()


def test_the_page_offers_to_accept_a_key_only_when_none_is_set(ledger, tmp_path, clock):
    from harness.setup_web import make_handler
    r = FamRig(ledger, tmp_path, clock, [], urls="")
    clock.advance(hours=1)                         # the start-up window has closed
    r.c.tick()
    app = SetupApp(r.vault, r.status, queue.Queue(), family=r.inbox)
    page = render_page(app, "u1", "Owner")
    assert "Accept a key from Home Assistant" in page
    r.inbox.arm()
    r.c.tick()
    page = render_page(app, "u1", "Owner")
    assert "the next push from Home Assistant sets it" in page
    r.inbox.receive(KEY, body(clock.t))
    r.c.tick()
    page = render_page(app, "u1", "Owner")
    assert "Accept a key" not in page and "key pinned" in page
