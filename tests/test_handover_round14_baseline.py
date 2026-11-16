"""0.24.0, fourteenth round, items 2 and 6: the lost-update baseline compares temporal fields by what they mean
and loosens only what the baseline showed, and the conformance item's own test event is kept by its URL until a
read shows it gone. All names and ids invented.
"""
import json
import re

import pytest

import queue
import urllib.parse

from harness import caldav, calendar_change
from harness.vault import Vault
from harness.calendar_change import _baseline_of, _gmail_fields, _ics_fields, _lost_fields, _matches_baseline
from harness.setup_web import SetupApp, render_page
from test_discord_keeper import OWNER  # noqa: F401
from test_plain_commands import Morning, nothing_he_shouldnt_see, plain_prompt  # noqa: F401  (autouse)
from test_handover_round10 import conform, start
from fake_caldav import no_network  # noqa: F401  (autouse)


@pytest.fixture
def m(ledger, tmp_path, clock):
    return Morning(ledger, tmp_path, clock)


def vevent(*lines, alarm=False, rid=""):
    body = ["BEGIN:VEVENT", "UID:hm-pool", "DTSTAMP:20261101T000000Z", *( [f"RECURRENCE-ID:{rid}"] if rid else []),
            *lines]
    if alarm:
        body += ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Reminder", "END:VALARM"]
    return body + ["END:VEVENT"]


def ics(*events):
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", *[x for e in events for x in e], "END:VCALENDAR"]) + "\r\n"


def server(body: str) -> str:
    """An iCloud-like server's own normalisation on any write: a London time written as UTC (the same instant in
    November), an empty description dropped, LOCATION given a language and lower case, and a field of its own
    added to every event."""
    body = re.sub(r"(DTSTART|DTEND);TZID=Europe/London:(\d{8}T\d{6})", r"\1:\2Z", body)
    body = body.replace("DESCRIPTION:\r\n", "")
    body = re.sub(r"LOCATION:([^\r\n]*)", lambda m_: "LOCATION;LANGUAGE=en:" + m_.group(1).lower(), body)
    return re.sub(r"(?m)^END:VEVENT", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\nEND:VEVENT", body)


ONE_OFF = ics(vevent("DTSTART;TZID=Europe/London:20261111T090000", "DTEND;TZID=Europe/London:20261111T100000",
                     "SUMMARY:Swim", "LOCATION:Pool", "DESCRIPTION:"))


def baseline():
    """The baseline the no-op round trip of the run's one-off test event gives (_baseline_family)."""
    return _baseline_of(_lost_fields(_ics_fields(ONE_OFF), _ics_fields(ONE_OFF), _ics_fields(server(ONE_OFF))))


def lost(before: str, back: str, base=None) -> list:
    b, a = _ics_fields(before), _ics_fields(back)
    return [x for x in _lost_fields(b, b, a) if not _matches_baseline(x, baseline() if base is None else base)]


def test_the_baseline_keeps_what_was_removed_and_the_zone_rewrite():
    base = baseline()
    assert base["VCALENDAR/VEVENT/DESCRIPTION"] == {"kind": "removed", "was": ["DESCRIPTION:"]}
    assert base["VCALENDAR/VEVENT/DTSTART"]["zones"] == [["Europe/London"], ["UTC"]]
    assert not lost(ONE_OFF, server(ONE_OFF))                              # its own normalisation, again


def test_a_foreign_tzid_only_change_is_reported():
    before = ONE_OFF.replace("DESCRIPTION:\r\n", "")
    for zone in ("Europe/Lisbon", "America/New_York"):   # Lisbon: the same instant in November, another zone
        back = server(before).replace("DTSTART:20261111T090000Z", f"DTSTART;TZID={zone}:20261111T090000")
        got = lost(before, back)
        assert [x["field"][1] for x in got] == ["DTSTART"], zone


def test_an_all_day_change_and_an_unresolvable_time_are_reported():
    before = ONE_OFF.replace("DESCRIPTION:\r\n", "")
    back = server(before).replace("DTSTART:20261111T090000Z", "DTSTART;VALUE=DATE:20261111")
    assert [x["field"][1] for x in lost(before, back)] == ["DTSTART"]
    back = server(before).replace("DTSTART:20261111T090000Z", "DTSTART;TZID=Nowhere/Atlantis:20261111T090000")
    assert [x["field"][1] for x in lost(before, back)] == ["DTSTART"]       # ambiguous counts as a lost update


def test_a_foreign_deletion_of_a_real_description_is_reported_when_the_server_strips_empty_ones():
    before = ONE_OFF.replace("DESCRIPTION:", "DESCRIPTION:Bring the forms")
    back = server(before).replace("DESCRIPTION:Bring the forms\r\n", "")
    got = lost(before, back)
    assert [x["field"][1] for x in got] == ["DESCRIPTION"] and got[0]["now"] is None
    assert not lost(ONE_OFF, server(ONE_OFF))                              # an empty one stripped is its own


def test_an_event_with_an_alarm_and_a_series_the_baseline_never_saw_raises_no_false_alarm():
    series = ics(vevent("DTSTART;TZID=Europe/London:20261111T090000", "DTEND;TZID=Europe/London:20261111T100000",
                        "RRULE:FREQ=WEEKLY;COUNT=6", "EXDATE;TZID=Europe/London:20261118T090000", "SUMMARY:Swim",
                        "LOCATION:Pool", "DESCRIPTION:", alarm=True),
                 vevent("DTSTART;TZID=Europe/London:20261125T093000", "DTEND;TZID=Europe/London:20261125T103000",
                        "SUMMARY:Swim", "LOCATION:Pool B", rid="20261125T090000Z", alarm=True))
    assert not lost(series, server(series))
    # Still told: someone's change of the series itself, and of the alarm.
    back = server(series).replace("RRULE:FREQ=WEEKLY;COUNT=6", "RRULE:FREQ=WEEKLY;COUNT=3")
    assert [x["field"][1] for x in lost(series, back)] == ["RRULE"]
    back = server(series).replace("TRIGGER:-PT15M", "TRIGGER:-PT1H", 1)
    assert [x["field"][1] for x in lost(series, back)] == ["TRIGGER"]


def test_loosening_applies_only_to_text_fields_the_baseline_showed_changed():
    base = baseline()
    # LOCATION was shown changed: case, spacing and a parameter are its own.
    before = ONE_OFF.replace("LOCATION:Pool", "LOCATION:Pool  B")
    assert not lost(before, server(before))
    assert [x["field"][1] for x in lost(before, server(before).replace("pool  b", "gym"))] == ["LOCATION"]
    # SUMMARY never was: a case change there is someone's.
    assert [x["field"][1] for x in lost(ONE_OFF, server(ONE_OFF).replace("SUMMARY:Swim", "SUMMARY:SWIM"))] == \
        ["SUMMARY"]
    # A field that isn't text, shown changed: only the very value the baseline's change gave.
    key = ("VCALENDAR/VEVENT", "X-APPLE-STRUCTURED-LOCATION")
    b2 = {**base, "VCALENDAR/VEVENT/X-APPLE-STRUCTURED-LOCATION": {"kind": "changed", "now": [key[1] + ":geo:1,2"]}}
    assert _matches_baseline({"field": key, "was": [key[1] + ":geo:0,0"], "now": [key[1] + ":geo:1,2"]}, b2)
    assert not _matches_baseline({"field": key, "was": [key[1] + ":GEO:1,2"], "now": [key[1] + ":geo:1,2 "]}, {
        **base, "VCALENDAR/VEVENT/X-APPLE-STRUCTURED-LOCATION": {"kind": "changed", "now": [key[1] + ":geo:9,9"]}})
    # A removal the baseline recorded without its value (an older record) matches nothing.
    assert not _matches_baseline({"field": ("VCALENDAR/VEVENT", "DESCRIPTION"), "was": ["DESCRIPTION:"],
                                  "now": None}, {"VCALENDAR/VEVENT/DESCRIPTION": {"kind": "removed"}})


def test_gmail_times_are_compared_by_instant_zone_and_all_day():
    ev = {"summary": "Swim", "start": {"dateTime": "2026-11-11T09:00:00Z", "timeZone": "Europe/London"},
          "end": {"dateTime": "2026-11-11T10:00:00Z", "timeZone": "Europe/London"}, "description": ""}
    norm = {**ev, "start": {"dateTime": "2026-11-11T09:00:00+00:00", "timeZone": "Europe/London"},
            "end": {"dateTime": "2026-11-11T10:00:00+00:00", "timeZone": "Europe/London"}}
    norm.pop("description")
    base = _baseline_of(_lost_fields(_gmail_fields(ev), _gmail_fields(ev), _gmail_fields(norm)))
    assert base["start"]["kind"] == "changed" and base["description"] == {"kind": "removed", "was": json.dumps("")}

    def g(before, back):
        b, a = _gmail_fields(before), _gmail_fields(back)
        return [x["field"] for x in _lost_fields(b, b, a) if not _matches_baseline(x, base)]
    assert not g(ev, norm)
    assert g(ev, {**norm, "start": {"dateTime": "2026-11-11T09:00:00+00:00", "timeZone": "Europe/Lisbon"}}) == \
        ["start"]
    assert g(ev, {**norm, "start": {"date": "2026-11-11"}}) == ["start"]
    real = {**ev, "description": "Bring the forms"}
    assert g(real, norm) == ["description"]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_foreign_tzid_change_after_an_unguarded_write_is_told(m):
    """Through _check_lost, as after a write sent without If-Match: the baseline on record doesn't hide it."""
    run = start(m)
    conform(m, run, "family")
    gate = calendar_change.card_gate(m.ledger)
    gate["conformance"]["family"]["baseline"] = baseline()
    with m.ledger.tx() as db:
        m.ledger.set_meta(calendar_change.CARD_GATE, json.dumps(gate), db)
    before = ONE_OFF.replace("DESCRIPTION:\r\n", "")
    b = _ics_fields(before)
    assert not m.cc._check_lost("family", "Swim", b, b, _ics_fields(server(before)))
    back = server(before).replace("DTSTART:20261111T090000Z", "DTSTART;TZID=Europe/Lisbon:20261111T090000")
    got = m.cc._check_lost("family", "Swim", b, b, _ics_fields(back))
    assert [x["field"][1] for x in got] == ["DTSTART"]
    m.c.outbox.flush()
    told = [t for t in m.seen() if t.startswith("<b>Possibly overwritten on") or "Possibly overwritten" in t]
    assert told and "Dtstart" in told[-1]


# -- item 6: the conformance item's own test event -----------------------------------------------------------------

def _unguarded(m):
    return [(i, path) for i, (meth, path, h, body) in enumerate(m.icloud.log)
            if meth == "PUT" and "If-Match" not in (h or {}) and "If-None-Match" not in (h or {})]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_the_test_event_has_a_random_url_is_created_only_where_nothing_is_and_is_forgotten_once_gone(m):
    run = start(m)
    conform(m, run, "family")
    (i, href), = _unguarded(m)
    assert re.search(r"hm-[0-9a-f]{32}\.ics$", href)
    first = next(j for j, (meth, path, *_r) in enumerate(m.icloud.log) if path == href and meth == "PUT")
    assert first < i and m.icloud.log[first][2].get("If-None-Match") == "*"   # made where nothing is, first
    assert href not in m.icloud.events
    assert calendar_change.test_events_left(m.ledger) == []
    # Another run's test event is at another URL.
    run2 = start(m)
    conform(m, run2, "family")
    hrefs = [p for _, p in _unguarded(m)]
    assert len(hrefs) == 2 and hrefs[0] != hrefs[1]


@pytest.mark.card_only
@pytest.mark.install_gate
def test_a_test_event_not_shown_gone_is_kept_shown_and_removed_at_a_later_start(m, monkeypatch, tmp_path):
    run = start(m)
    real = m.cc.client.remove_at
    seen: dict = {}

    def refuse(href, etag):
        if seen.get("href") is None:
            hits = _unguarded(m)
            seen["href"] = hits[0][1] if hits else None
        if seen.get("href") and href.endswith(seen["href"]):
            return caldav.Outcome("unknown", 503)
        return real(href, etag)
    monkeypatch.setattr(m.cc.client, "remove_at", refuse)
    conform(m, run, "family")
    href = seen["href"]
    assert href in m.icloud.events
    left = calendar_change.test_events_left(m.ledger)
    assert len(left) == 1 and left[0]["href"].endswith(href) and left[0]["run"] == run
    rec = calendar_change.card_gate(m.ledger)["conformance"]["family"]
    assert rec["unguarded_put"] == "unknown"
    # The next start retries it: still turned down, it's kept and counted, and the status page says so.
    m.c._reconciled = False
    m.c._reconcile()
    assert [x["tries"] for x in m.c.status_box["test_events_left"]] == [1]
    page = render_page(SetupApp(Vault(str(tmp_path / "v.json")), {"test_events_left": m.c.status_box[
        "test_events_left"]}, queue.Queue()), "u1", "Owner")
    assert "Harness write test event is still on Family" in page and run in page
    # A later start with the calendar answering again: removed, read back gone, forgotten.
    monkeypatch.setattr(m.cc.client, "remove_at", real)
    m.c._reconciled = False
    m.c._reconcile()
    assert href not in m.icloud.events
    assert calendar_change.test_events_left(m.ledger) == [] and not m.c.status_box["test_events_left"]


def test_the_sweep_never_removes_an_event_without_its_runs_tag(m):
    href = m.cc.client.href_for("hm-" + "a" * 32)
    m.cc._track_test(href, "run-x", "n1")
    m.icloud.seed(urllib.parse.urlparse(href).path, ics(vevent("DTSTART:20010101T030000Z", "SUMMARY:Someone's")))
    m.cc.sweep_test_events()
    assert calendar_change.test_events_left(m.ledger)[0]["tries"] == 1
    assert not [x for x in m.icloud.log if x[0] == "DELETE"]
