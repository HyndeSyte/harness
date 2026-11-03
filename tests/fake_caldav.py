"""An in-process fake of iCloud CalDAV. No sockets: it is the transport.

Adapted from the family calendar capability's fake, keeping what the one write
needs. It imitates iCloud on the points that matter: Basic auth, quoted ETags,
If-Match and If-None-Match (412), GET by path, PROPFIND displayname, refusal of
invalid calendar data, and the 412 real iCloud gave to a REPORT with a UID
prop-filter. It can also land a write and lose the answer, or land it and answer
500. All names and addresses are invented.
"""
from __future__ import annotations

import base64
import hashlib
import re
import socket
from urllib.parse import unquote, urlsplit

import pytest

from harness.net import HttpResponse, TransportError

BASE = "https://p99-caldav.icloud.com"
FAMILY_PATH = "/1000001/calendars/shared-example/"
OTHER_PATH = "/1000001/calendars/other-example/"
FAMILY_URL = BASE + FAMILY_PATH
OTHER_URL = BASE + OTHER_PATH
APPLE_ID = "parent@example.com"
APP_PASSWORD = "abcd-efgh-ijkl-mnop"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any socket use fails the test, even if something swallows the error.
    Test modules import this so it applies to every test in them."""
    tried = []

    def refuse(*args, **kwargs):
        tried.append(args)
        raise AssertionError("a test tried to use the network")
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    yield
    assert tried == []


def unfold(text: str) -> list[str]:
    out: list[str] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        elif line:
            out.append(line)
    return out


def props(ics: str) -> dict[str, list[str]]:
    """Every property line of a calendar object, by name."""
    found: dict[str, list[str]] = {}
    for line in unfold(ics):
        found.setdefault(re.split(r"[;:]", line, maxsplit=1)[0].upper(), []).append(line)
    return found


def valid_ics(body: bytes | None) -> str | None:
    """The uid if this is acceptable calendar data, else None."""
    if not body:
        return None
    try:
        p = props(body.decode("utf-8"))
    except UnicodeDecodeError:
        return None
    if ["BEGIN:VCALENDAR"] != p.get("BEGIN", [""])[:1] or p.get("VERSION") != ["VERSION:2.0"]:
        return None
    if any(len(p.get(k, [])) != 1 for k in ("UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY")):
        return None
    if not re.fullmatch(r"DTSTART:\d{8}T\d{6}Z", p["DTSTART"][0]) \
            or not re.fullmatch(r"DTEND:\d{8}T\d{6}Z", p["DTEND"][0]):
        return None
    return p["UID"][0].split(":", 1)[1]


class FakeICloud:
    def __init__(self, *, put_returns_etag=True, names=None):
        self.names = names or {FAMILY_PATH: "Family", OTHER_PATH: "Other"}
        self.events: dict[str, tuple[str, str]] = {}      # path -> (etag, ics)
        self.log: list[tuple[str, str, dict, bytes | None]] = []
        self.put_returns_etag = put_returns_etag
        self.counter = 0
        self.down = False                # nothing answers at all
        self.force_status = None         # the next write is not applied and answers this
        self.drop_response_next = False  # the next write lands, then its answer is lost
        self.status_after_write = None   # the next write lands, then answers this
        self.before_write = None         # called just before a write is decided

    # -- what the tests look at ---------------------------------------------------
    def methods(self) -> list[str]:
        return [m for m, *_ in self.log]

    def family(self) -> dict[str, tuple[str, str]]:
        return {p: v for p, v in self.events.items() if p.startswith(FAMILY_PATH)}

    def human_edit(self, path: str, old: str, new: str) -> str:
        """A phone edit: new body, new ETag, every other property kept."""
        return self.seed(path, self.events[path][1].replace(old, new))

    def seed(self, path: str, ics: str) -> str:
        etag = self._etag(ics)
        self.events[path] = (etag, ics)
        return etag

    def _etag(self, ics: str) -> str:
        self.counter += 1
        return '"%s-%d"' % (hashlib.md5(ics.encode()).hexdigest()[:8], self.counter)

    # -- the transport ----------------------------------------------------------------
    def request(self, method, url, *, headers=None, json_body=None, body=None, timeout=30):
        headers = dict(headers or {})
        path = unquote(urlsplit(url).path)
        self.log.append((method, path, headers, body))
        if self.down:
            raise TransportError("network", "OSError")
        expected = "Basic " + base64.b64encode(f"{APPLE_ID}:{APP_PASSWORD}".encode()).decode()
        if headers.get("Authorization") != expected:
            return HttpResponse(401)
        cal = next((c for c in self.names if path.startswith(c)), None)
        if cal is None:
            return HttpResponse(404)
        if method == "PROPFIND":
            if path != cal:
                return HttpResponse(404)
            xml = ('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response>'
                   f"<D:href>{cal}</D:href><D:propstat><D:prop><D:displayname>{self.names[cal]}"
                   "</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>"
                   "</D:response></D:multistatus>")
            return HttpResponse(207, {}, xml.encode())
        if method == "REPORT":
            if b"prop-filter" in (body or b""):      # as real iCloud did
                return HttpResponse(412)
            return HttpResponse(207, {}, b'<D:multistatus xmlns:D="DAV:"/>')
        if method == "GET":
            cur = self.events.get(path)
            if cur is None:
                return HttpResponse(404)
            return HttpResponse(200, {"etag": cur[0]}, cur[1].encode())
        if method not in ("PUT", "DELETE"):
            return HttpResponse(405)
        if self.before_write:
            hook, self.before_write = self.before_write, None
            hook()
        if self.force_status:
            status, self.force_status = self.force_status, None
            return HttpResponse(status)
        cur = self.events.get(path)
        if method == "PUT":
            if headers.get("If-None-Match") == "*" and cur is not None:
                return HttpResponse(412)
            if valid_ics(body) is None:
                return HttpResponse(403, {}, b"valid-calendar-data")
            ics = body.decode()
            etag = self._etag(ics)
            self.events[path] = (etag, ics)
            answer = HttpResponse(201 if cur is None else 204,
                                  {"etag": etag} if self.put_returns_etag else {})
        else:
            if cur is None:
                return HttpResponse(404)
            if "If-Match" in headers and cur[0] != headers["If-Match"]:
                return HttpResponse(412)
            del self.events[path]
            answer = HttpResponse(204)
        if self.drop_response_next:
            self.drop_response_next = False
            raise TransportError("timeout")
        if self.status_after_write:
            status, self.status_after_write = self.status_after_write, None
            return HttpResponse(status)
        return answer
