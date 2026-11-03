"""The one write client and its transport, against a fake that behaves like iCloud."""
import http.client
import io
import logging
import urllib.error
import urllib.request
import urllib.response
from datetime import datetime, timezone

import pytest

from harness import caldav
from harness.net import REDACT, CalDavTransport, RedactingFilter, TransportError
from fake_caldav import (APP_PASSWORD, APPLE_ID, FAMILY_PATH, FAMILY_URL, OTHER_URL, FakeICloud,
                         no_network, props, valid_ics)  # noqa: F401  (no_network is autouse)

NOW = datetime(2026, 10, 21, 13, 0, tzinfo=timezone.utc)
PARAMS = {"title": "Dentist", "start": "2026-10-27T15:00:00-04:00",
          "end": "2026-10-27T16:00:00-04:00"}
UID = caldav.uid_for("effect-1")
PATH = f"{FAMILY_PATH}{UID}.ics"


def client(fake, url=FAMILY_URL, password=APP_PASSWORD):
    return caldav.FamilyCalDav(fake, lambda: (APPLE_ID, password, url))


# -- the event ---------------------------------------------------------------------

def test_the_event_has_only_what_was_asked_and_the_marker():
    ics = caldav.build_ics(UID, {**PARAMS, "location": "Main St"}, NOW)
    p = props(ics)
    assert valid_ics(ics.encode()) == UID
    assert p["DTSTART"] == ["DTSTART:20261027T190000Z"]
    assert p["DTEND"] == ["DTEND:20261027T200000Z"]
    assert p["SUMMARY"] == ["SUMMARY:Dentist"] and p["LOCATION"] == ["LOCATION:Main St"]
    assert p[caldav.MARKER] == [f"{caldav.MARKER}:1"]
    for never in ("ATTENDEE", "ORGANIZER", "VALARM", "RRULE", "RDATE", "EXDATE", "TRIGGER"):
        assert never not in ics


def test_no_title_can_start_a_new_property():
    evil = {**PARAMS, "title": "x\r\nATTENDEE:mailto:someone@example.com\nRRULE:FREQ=DAILY"}
    p = props(caldav.build_ics(UID, evil, NOW))
    assert "ATTENDEE" not in p and "RRULE" not in p
    assert len(p["SUMMARY"]) == 1


def test_long_titles_are_folded_without_splitting_characters():
    title = "é" * 200
    ics = caldav.build_ics(UID, {**PARAMS, "title": title}, NOW)
    assert all(len(line.encode()) <= 75 for line in ics.split("\r\n"))
    assert props(ics)["SUMMARY"] == [f"SUMMARY:{title}"]


def test_the_uid_comes_from_the_effect_id():
    assert caldav.uid_for("effect-1") == caldav.uid_for("effect-1") != caldav.uid_for("effect-2")
    assert caldav.uid_for("effect-1").startswith("hx-")


# -- writes ----------------------------------------------------------------------------

def test_a_create_checks_the_name_first_and_says_if_none_match():
    fake = FakeICloud()
    out = client(fake).create(UID, PARAMS, NOW)
    assert out == caldav.Outcome("ok", 201, fake.events[PATH][0])
    assert fake.methods() == ["PROPFIND", "PUT"]
    assert fake.log[1][2]["If-None-Match"] == "*"
    assert fake.log[1][1] == PATH


def test_a_repeat_cannot_duplicate():
    fake = FakeICloud()
    c = client(fake)
    first = c.create(UID, PARAMS, NOW)
    assert first.kind == "ok"
    assert c.create(UID, {**PARAMS, "title": "Other"}, NOW) == caldav.Outcome("exists", 412)
    assert len(fake.events) == 1 and "Dentist" in fake.events[PATH][1]


def test_a_mislabeled_address_is_refused_before_any_write():
    fake = FakeICloud()
    c = client(fake, url=OTHER_URL)
    assert c.create(UID, PARAMS, NOW).kind == "mismatch"
    assert c.undo(UID, '"x"').kind == "mismatch"
    assert fake.methods() == ["PROPFIND", "PROPFIND"] and not fake.events


def test_the_displayname_must_be_exactly_family():
    fake = FakeICloud(names={FAMILY_PATH: "Family 2"})
    assert client(fake).create(UID, PARAMS, NOW).kind == "mismatch"


def test_a_rejected_password_is_named_and_nothing_is_written():
    fake = FakeICloud()
    assert client(fake, password="zzzz-zzzz-zzzz-zzzz").create(UID, PARAMS, NOW).kind == "auth"
    assert fake.methods() == ["PROPFIND"]


def test_no_report_is_ever_sent_because_real_icloud_refuses_uid_filters():
    fake = FakeICloud()
    # the fake answers as real iCloud did
    assert fake.request("REPORT", FAMILY_URL, headers={
        "Authorization": _auth()}, body=b"<C:prop-filter name='UID'/>").status == 412
    fake.log.clear()
    c = client(fake)
    out = c.create(UID, PARAMS, NOW)
    c.undo(UID, out.etag)
    assert "REPORT" not in fake.methods()
    assert fake.methods() == ["PROPFIND", "PUT", "PROPFIND", "GET", "DELETE"]


def _auth():
    import base64
    return "Basic " + base64.b64encode(f"{APPLE_ID}:{APP_PASSWORD}".encode()).decode()


def test_a_missing_etag_on_put_is_read_by_path():
    fake = FakeICloud(put_returns_etag=False)
    out = client(fake).create(UID, PARAMS, NOW)
    assert out.etag == fake.events[PATH][0] and fake.methods() == ["PROPFIND", "PUT", "GET"]


# -- answers ----------------------------------------------------------------------------

def test_a_lost_answer_is_unknown_even_though_it_landed():
    fake = FakeICloud()
    fake.drop_response_next = True
    assert client(fake).create(UID, PARAMS, NOW) == caldav.Outcome("unknown")
    assert PATH in fake.events
    assert fake.methods().count("PUT") == 1


@pytest.mark.parametrize("status, kind", [(500, "unknown"), (503, "unknown"), (403, "failed"),
                                          (302, "failed"), (401, "auth"), (412, "exists")])
def test_an_answer_means_only_what_it_says(status, kind):
    fake = FakeICloud()
    fake.force_status = status
    assert client(fake).create(UID, PARAMS, NOW) == caldav.Outcome(kind, status)


def test_a_write_the_transport_blocked_is_failed_not_unknown():
    class Blocked(FakeICloud):
        def request(self, method, url, **kw):
            if method == "PUT":
                raise TransportError("blocked")
            return super().request(method, url, **kw)
    assert client(Blocked()).create(UID, PARAMS, NOW).kind == "failed"


def test_no_network_before_the_write_means_it_certainly_failed():
    fake = FakeICloud()
    fake.down = True
    assert client(fake).create(UID, PARAMS, NOW).kind == "failed"
    assert fake.methods() == ["PROPFIND"]


def test_the_stop_signal_is_not_swallowed():
    class Stop(Exception):
        pass

    class Dying(FakeICloud):
        def request(self, *a, **k):
            raise Stop()
    with pytest.raises(Stop):
        client(Dying()).create(UID, PARAMS, NOW)


def test_missing_credentials_send_nothing():
    fake = FakeICloud()
    c = caldav.FamilyCalDav(fake, lambda: ("", "", ""))
    assert not c.configured()
    assert c.create(UID, PARAMS, NOW).kind == "no_credentials" and fake.log == []


# -- undo -----------------------------------------------------------------------------

def added():
    fake = FakeICloud()
    c = client(fake)
    return fake, c, c.create(UID, PARAMS, NOW).etag


def test_undo_deletes_that_event_with_if_match():
    fake, c, etag = added()
    assert c.undo(UID, etag) == caldav.Outcome("ok", 204)
    assert not fake.events
    assert fake.log[-1][0] == "DELETE" and fake.log[-1][2]["If-Match"] == etag
    assert fake.log[-1][1] == PATH


def test_undo_refuses_an_edited_event_and_sends_no_delete():
    fake, c, etag = added()
    fake.human_edit(PATH, "Dentist", "Dentist moved")
    assert c.undo(UID, etag).kind == "changed"
    assert "DELETE" not in fake.methods() and PATH in fake.events


def test_an_edit_in_the_last_moment_is_stopped_by_if_match():
    fake, c, etag = added()
    fake.before_write = lambda: fake.human_edit(PATH, "Dentist", "Dentist moved")
    assert c.undo(UID, etag) == caldav.Outcome("changed", 412)
    assert "moved" in fake.events[PATH][1]


def test_undo_without_a_known_etag_refuses():
    fake, c, _ = added()
    assert c.undo(UID, None).kind == "changed" and "DELETE" not in fake.methods()


@pytest.mark.parametrize("edit", ["ATTENDEE:mailto:other@example.com\r\nEND:VEVENT",
                                  "RRULE:FREQ=DAILY\r\nEND:VEVENT"])
def test_undo_refuses_an_event_that_could_message_someone(edit):
    """Same ETag or not: a shape it never wrote is not deleted."""
    fake, c, _ = added()
    etag = fake.human_edit(PATH, "END:VEVENT", edit)
    assert c.undo(UID, etag).kind == "changed" and "DELETE" not in fake.methods()


def test_undo_refuses_when_the_marker_is_gone():
    fake, c, _ = added()
    etag = fake.human_edit(PATH, f"{caldav.MARKER}:1\r\n", "")
    assert c.undo(UID, etag).kind == "changed"


def test_undo_of_a_missing_event_is_gone():
    fake, c, etag = added()
    del fake.events[PATH]
    assert c.undo(UID, etag) == caldav.Outcome("gone", 404)


def test_undo_with_a_lost_answer_is_unknown():
    fake, c, etag = added()
    fake.drop_response_next = True
    assert c.undo(UID, etag) == caldav.Outcome("unknown")
    assert fake.methods().count("DELETE") == 1


# -- the address --------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "http://p99-caldav.icloud.com/1000001/calendars/a/",
    "https://caldav.icloud.com/1000001/calendars/a/",
    "https://pxx-caldav.icloud.com/1000001/calendars/a/",
    "https://p99-caldav.icloud.com.evil.example/1000001/calendars/a/",
    "https://evil.example/p99-caldav.icloud.com/1000001/calendars/a/",
    "https://user:pw@p99-caldav.icloud.com/1000001/calendars/a/",
    "https://p99-caldav.icloud.com:8443/1000001/calendars/a/",
    "https://p99-caldav.icloud.com/1000001/calendars/a/?x=1",
    "https://p99-caldav.icloud.com/1000001/calendars/a/#x",
    "https://p99-caldav.icloud.com/1000001/calendars/a",
    "https://p99-caldav.icloud.com/",
    "https://p99-caldav.icloud.com/1000001/../other/",
    "https://p99-caldav.icloud.com/1000001/calendars/a/\nx",
    "", "not a url",
])
def test_only_an_icloud_calendar_address_is_accepted(url):
    if url == "https://p99-caldav.icloud.com/1000001/calendars/a/\nx":
        pass
    with pytest.raises(ValueError) as e:
        caldav.check_url(url)
    assert url not in str(e.value) or not url
    assert caldav.host_of(url) == ""


def test_a_real_shaped_address_is_accepted():
    assert caldav.check_url(f"  {FAMILY_URL}\n") == FAMILY_URL
    assert caldav.host_of(FAMILY_URL) == "p99-caldav.icloud.com"


# -- the transport ---------------------------------------------------------------------

class RecordingOpener:
    def __init__(self):
        self.urls = []

    def open(self, req, timeout=None):
        self.urls.append(req.full_url)

        class R:
            status = 207
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b""
        return R()


def gated():
    t = CalDavTransport(lambda: "p99-caldav.icloud.com")
    t._opener = RecordingOpener()
    return t


def test_the_configured_host_is_allowed():
    t = gated()
    assert t.request("PROPFIND", FAMILY_URL).status == 207
    assert t._opener.urls == [FAMILY_URL]


@pytest.mark.parametrize("method, url", [
    ("GET", "https://p98-caldav.icloud.com/1/a/"),          # another iCloud host
    ("GET", "https://evil.example/1/a/"),
    ("GET", "http://p99-caldav.icloud.com/1/a/"),
    ("GET", "https://x@p99-caldav.icloud.com/1/a/"),
    ("GET", "https://p99-caldav.icloud.com:444/1/a/"),
    ("GET", "https://p99-caldav.icloud.com:bad/1/a/"),
    ("PATCH", FAMILY_URL),
    ("POST", FAMILY_URL),
])
def test_anything_else_never_leaves(method, url):
    t = gated()
    with pytest.raises(TransportError) as e:
        t.request(method, url)
    assert e.value.kind == "blocked" and t._opener.urls == []


def test_with_no_address_set_nothing_can_leave():
    t = CalDavTransport(lambda: "")
    t._opener = RecordingOpener()
    with pytest.raises(TransportError):
        t.request("GET", FAMILY_URL)
    assert t._opener.urls == []


def test_a_redirect_is_refused_not_followed():
    """A stub answers below the opener. A followed redirect would carry the password."""
    hits = []

    class Answers302(urllib.request.BaseHandler):
        handler_order = 100                 # ahead of the real HTTPS handler

        def https_open(self, req):
            hits.append(req.full_url)
            headers = http.client.HTTPMessage()
            headers["Location"] = "https://elsewhere.example/"
            answer = urllib.response.addinfourl(io.BytesIO(b""), headers, req.full_url, 302)
            answer.msg = "Found"
            return answer
    t = CalDavTransport(lambda: "p99-caldav.icloud.com")
    t._opener.add_handler(Answers302())
    assert t.request("GET", FAMILY_URL).status == 302
    assert hits == [FAMILY_URL]


def test_a_3xx_comes_back_as_an_answer_through_request():
    class Opener:
        def open(self, req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 302, "Found", {}, None)
    t = CalDavTransport(lambda: "p99-caldav.icloud.com")
    t._opener = Opener()
    assert t.request("GET", FAMILY_URL).status == 302


# -- secrets -----------------------------------------------------------------------------

def test_credentials_are_registered_with_the_redactor_before_any_request():
    REDACT.clear()
    fake = FakeICloud()
    client(fake).create(UID, PARAMS, NOW)
    text = f"oops {APP_PASSWORD} {APPLE_ID} {FAMILY_URL} {fake.log[0][2]['Authorization']}"
    clean = REDACT(text)
    for secret in (APP_PASSWORD, APPLE_ID, FAMILY_URL, _auth().split()[1]):
        assert secret not in clean
    record = logging.LogRecord("x", logging.INFO, "f", 1, text, (), None)
    RedactingFilter().filter(record)
    assert APP_PASSWORD not in record.getMessage()
    REDACT.clear()


# -- the bake-in's read of the calendar ---------------------------------------------------

def test_missing_counts_only_what_a_read_says_is_gone():
    fake, c, _ = added()
    other = caldav.uid_for("effect-2")
    assert c.missing([UID]) == 0
    assert c.missing([UID, other]) == 1
    assert {m for m in fake.methods()} == {"PROPFIND", "PUT", "GET"}
    assert fake.methods().count("PUT") == 1


def test_missing_says_so_when_it_cant_complete():
    fake, c, _ = added()
    fake.down = True
    assert c.missing([UID]) is None
    fake.down = False
    assert client(fake, password="zzzz-zzzz-zzzz-zzzz").missing([UID]) is None
    assert client(fake, url=OTHER_URL).missing([UID]) is None
    assert caldav.FamilyCalDav(fake, lambda: ("", "", "")).missing([UID]) is None


def test_missing_says_so_when_a_read_of_an_event_is_lost():
    class Lost(FakeICloud):
        def request(self, method, url, **kw):
            if method == "GET":
                raise TransportError("timeout")
            return super().request(method, url, **kw)
    assert client(Lost()).missing([UID]) is None


def test_missing_stops_at_a_server_error():
    class Broken(FakeICloud):
        def request(self, method, url, **kw):
            if method == "GET":
                from harness.net import HttpResponse
                return HttpResponse(500)
            return super().request(method, url, **kw)
    assert client(Broken()).missing([UID]) is None
