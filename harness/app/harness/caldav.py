"""The one client that can write to a calendar: iCloud Family, by CalDAV.

Adapted from the tested capability: add one event and delete that same event
again, and for copies from Gmail (family_copy.py) change its own copy or remove
one plain event he made by hand. Nothing here can name another calendar, or add
an attendee, an organizer, an alarm or a repeat: the event text is built here
from a few fields.

  * Before every write, the server's own display name for the saved address
    must be exactly "Family". A mislabeled address is refused.
  * An event is read by GET on its path. The one REPORT is a time-range read,
    to see what is already on Family: real iCloud answers 412 to a UID
    prop-filter, so that form is never sent.
  * A create is a PUT with If-None-Match: *, on a path derived from the
    effect id, so a repeat lands on the same path and is refused.
  * A delete is sent only if the event still has the ETag the harness saw
    when it wrote it, and carries that ETag in If-Match.

An Outcome says what the server answered and nothing more. A request with
no answer, or a 5xx to a write, is "unknown": it may have landed. Nothing
here retries.

Only TransportError is caught. The controller's stop signal is an ordinary
Exception raised from a signal handler, and it must get through.
"""
from __future__ import annotations

import base64
import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import urlsplit

from . import ical
from .net import REDACT, HttpResponse, TransportError

CALENDAR_NAME = "Family"       # fixed in code; nothing can name another calendar
MARKER = "X-HARNESS-OWNED"
TIMEOUT_S = 20
_DAV = "{DAV:}displayname"
_CALENDAR_DATA = "{urn:ietf:params:xml:ns:caldav}calendar-data"
_ICS_HEADERS = {"Content-Type": "text/calendar; charset=utf-8"}
_PROPFIND = ('<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop>'
             "<D:displayname/></D:prop></D:propfind>")
# https, this host pattern, a collection path, and nothing else: no port,
# no user, no query. Each path segment starts with a letter or digit, so no
# segment can be a dot segment.
URL_RE = re.compile(r"https://p[0-9]{1,6}-caldav\.icloud\.com"
                    r"(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,6}/")


def check_url(value: str) -> str:
    """The address as stored, or ValueError. Never echoes what was pasted."""
    url = (value or "").strip()
    if not URL_RE.fullmatch(url):
        raise ValueError("that isn't an iCloud calendar address "
                         "(https://p<digits>-caldav.icloud.com/.../)")
    return url


def host_of(value: str) -> str:
    """The one host the CalDAV transport may reach, or "" when none is set."""
    try:
        return urlsplit(check_url(value)).hostname or ""
    except ValueError:
        return ""


def uid_for(effect_id: str) -> str:
    """Stable per effect: a repeat of one effect can never be a second event."""
    return "hx-" + hashlib.sha256(f"family_event_add:{effect_id}".encode()).hexdigest()[:32]


# -- event text -----------------------------------------------------------------

def _esc(text: str) -> str:
    """TEXT value escaping. Control characters are dropped and a line break
    becomes the two characters backslash-n, so no input can start a new
    property. The effect's validator refuses these first; this is the second
    layer."""
    text = str(text).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(c for c in text if c == "\n" or ord(c) >= 32)
    return (text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\n", "\\n"))


def _fold(line: str) -> str:
    """RFC 5545: at most 75 octets a line, never splitting a character."""
    if len(line.encode("utf-8")) <= 75:
        return line
    parts, cur, used = [], "", 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        if used + n > 75:
            parts.append(cur)
            cur, used = " ", 1
        cur += ch
        used += n
    parts.append(cur)
    return "\r\n".join(parts)


def _utc(iso_time: str) -> str:
    return datetime.fromisoformat(iso_time).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_ics(uid: str, params: dict, now: datetime) -> str:
    """Title, start, end and optional location come from the effect. Everything
    else is fixed here: no ATTENDEE, ORGANIZER, VALARM or RRULE can appear."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//harness//family_event_add//EN",
             "BEGIN:VEVENT", f"UID:{uid}",
             f"DTSTAMP:{now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
             f"DTSTART:{_utc(params['start'])}", f"DTEND:{_utc(params['end'])}",
             f"SUMMARY:{_esc(params['title'])}"]
    if params.get("location"):
        lines.append(f"LOCATION:{_esc(params['location'])}")
    lines += [f"{MARKER}:1", "END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


def build_copy_ics(uid: str, title: str, start, end, now: datetime) -> str:
    """A copy from Gmail: the same fixed shape, and a trip can be whole days."""
    def when(name: str, value) -> str:
        if isinstance(value, datetime):
            return f"{name}:{_utc(value.isoformat())}"
        return f"{name};VALUE=DATE:{value:%Y%m%d}"
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//harness//family_copy//EN",
             "BEGIN:VEVENT", f"UID:{uid}",
             f"DTSTAMP:{now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
             when("DTSTART", start), when("DTEND", end), f"SUMMARY:{_esc(title)}",
             f"{MARKER}:1", "END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


def _lines(ics: str) -> tuple[list[str], list[str]]:
    text = re.sub(r"\r?\n[ \t]", "", ics.replace("\r\n", "\n"))
    lines = [x for x in text.split("\n") if x]
    return lines, [re.split(r"[;:]", x, maxsplit=1)[0].upper() for x in lines]


def _is_plain(ics: str) -> bool:
    """One event, with no attendee, organizer or repeat that could turn a delete
    into a message to someone."""
    lines, names = _lines(ics)
    if sum(x.upper() == "BEGIN:VEVENT" for x in lines) != 1:
        return False
    return not {"ATTENDEE", "ORGANIZER", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"} & set(names)


def _is_ours(ics: str, uid: str) -> bool:
    """Still one plain event of ours: right uid, marker kept."""
    lines, names = _lines(ics)
    if names.count("UID") != 1 or f"UID:{uid}" not in lines or f"{MARKER}:1" not in lines:
        return False
    return _is_plain(ics)


# -- the client -----------------------------------------------------------------

@dataclass(frozen=True)
class Outcome:
    # ok | exists | gone | changed | auth | mismatch | failed | unknown | no_credentials
    kind: str
    status: int | None = None
    etag: str | None = None


@dataclass(frozen=True)
class Item:
    """One occurrence read from Family, and where it lives."""
    occ: ical.Occurrence
    href: str
    etag: str


@dataclass(frozen=True)
class Read:
    items: list[Item]
    unreadable: int


class FamilyCalDav:
    def __init__(self, transport, credentials: Callable[[], tuple[str, str, str]]):
        self.transport = transport
        self.credentials = credentials     # (Apple ID, app password, calendar address)

    def configured(self) -> bool:
        user, password, url = self.credentials()
        return bool(user and password and host_of(url))

    def _auth(self) -> tuple[dict, str] | None:
        user, password, url = self.credentials()
        if not (user and password and host_of(url)):
            return None
        token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        # Known to the redactor before any request can fail.
        REDACT.register(user, password, url, token)
        return {"Authorization": "Basic " + token}, url

    def _call(self, auth: dict, method: str, url: str, headers: dict | None = None,
              body: str | None = None) -> HttpResponse:
        return self.transport.request(method, url, headers={**auth, **(headers or {})},
                                      body=body.encode("utf-8") if body else None,
                                      timeout=TIMEOUT_S)

    def _name_problem(self, auth: dict, url: str) -> Outcome | None:
        """None when the server says this address is the Family calendar."""
        try:
            r = self._call(auth, "PROPFIND", url,
                           {"Depth": "0", "Content-Type": "application/xml; charset=utf-8"},
                           _PROPFIND)
        except TransportError:
            return Outcome("failed")             # no write has been sent
        if r.status == 401:
            return Outcome("auth", r.status)
        if r.status != 207:
            return Outcome("failed", r.status)
        try:
            name = ET.fromstring(r.body).findtext(f".//{_DAV}")
        except ET.ParseError:
            return Outcome("failed", r.status)
        return None if name == CALENDAR_NAME else Outcome("mismatch", r.status)

    def create(self, uid: str, params: dict, now: datetime) -> Outcome:
        ready = self._auth()
        if ready is None:
            return Outcome("no_credentials")
        auth, url = ready
        problem = self._name_problem(auth, url)
        if problem is not None:
            return problem
        href = f"{url}{uid}.ics"
        try:
            r = self._call(auth, "PUT", href, {**_ICS_HEADERS, "If-None-Match": "*"},
                           build_ics(uid, params, now))
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 201, 204):
            return Outcome("ok", r.status, r.headers.get("etag") or self._read_etag(auth, href, uid))
        if r.status == 412:
            return Outcome("exists", r.status)
        if r.status == 401:
            return Outcome("auth", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    def _read_etag(self, auth: dict, href: str, uid: str) -> str | None:
        """A server need not give an ETag on a PUT. One read for it; without
        it the event stands, and Undo says it can't be sure."""
        try:
            r = self._call(auth, "GET", href)
        except TransportError:
            return None
        if r.status != 200 or not _is_ours(r.body.decode("utf-8", "replace"), uid):
            return None
        return r.headers.get("etag")

    def missing(self, uids: list[str]) -> int | None:
        """How many of these events are gone, by a GET of each path. Reads only.
        None when that can't be said for all of them."""
        ready = self._auth()
        if ready is None:
            return None
        auth, url = ready
        if self._name_problem(auth, url) is not None:
            return None
        gone = 0
        for uid in uids:
            try:
                r = self._call(auth, "GET", f"{url}{uid}.ics")
            except TransportError:
                return None
            if r.status == 404:
                gone += 1
            elif r.status != 200:
                return None
        return gone

    def items_between(self, start: datetime, end: datetime, tz: str) -> Read | None:
        """What is on Family in this window. Reads only. None when that can't be said."""
        ready = self._auth()
        if ready is None:
            return None
        auth, url = ready
        if self._name_problem(auth, url) is not None:
            return None
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
                "<D:prop><D:getetag/><C:calendar-data/></D:prop>"
                '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
                f'<C:time-range start="{_utc(start.isoformat())}" end="{_utc(end.isoformat())}"/>'
                "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>")
        try:
            r = self._call(auth, "REPORT", url,
                           {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"}, body)
            if r.status != 207:
                return None
            out: list[Item] = []
            unreadable = 0
            for resp in ET.fromstring(r.body).iter("{DAV:}response"):
                href = resp.findtext("{DAV:}href") or ""
                etag = resp.findtext(".//{DAV:}getetag") or ""
                data = resp.findtext(f".//{_CALENDAR_DATA}") or ""
                if "BEGIN:VCALENDAR" not in data:
                    return None                  # an answer with no event in it is no answer
                w = ical.window(data, start=start, end=end, tz=tz, fallback_name=CALENDAR_NAME)
                unreadable += w.unreadable
                out += [Item(occ, href, etag) for occ in w.occurrences]
            return Read(out, unreadable)
        except (TransportError, ET.ParseError, ValueError):
            return None

    def put_copy(self, uid: str, title: str, start, end, now: datetime,
                 etag: str | None = None) -> Outcome:
        """A copy from Gmail: new, or a change to our own. The uid is fixed per copy, so a
        write whose answer was lost finds itself on the next try instead of doubling."""
        ready = self._auth()
        if ready is None:
            return Outcome("no_credentials")
        auth, url = ready
        problem = self._name_problem(auth, url)
        if problem is not None:
            return problem
        href = f"{url}{uid}.ics"
        guard = {"If-Match": etag} if etag else {"If-None-Match": "*"}
        try:
            r = self._call(auth, "PUT", href, {**_ICS_HEADERS, **guard},
                           build_copy_ics(uid, title, start, end, now))
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 201, 204):
            return Outcome("ok", r.status, r.headers.get("etag"))
        if r.status == 412:
            if etag:
                return Outcome("changed", r.status)
            return self._ours_already(auth, href, uid)
        if r.status == 401:
            return Outcome("auth", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    def _ours_already(self, auth: dict, href: str, uid: str) -> Outcome:
        try:
            r = self._call(auth, "GET", href)
        except TransportError:
            return Outcome("unknown")
        if r.status == 200 and _is_ours(r.body.decode("utf-8", "replace"), uid):
            return Outcome("ok", r.status, r.headers.get("etag"))
        return Outcome("exists", r.status)

    def remove_hand_copy(self, href: str, etag: str) -> Outcome:
        """Delete one event he made by hand, taken over from Gmail. Only a plain one-off
        in this calendar, only as it was just read."""
        ready = self._auth()
        if ready is None:
            return Outcome("no_credentials")
        auth, url = ready
        problem = self._name_problem(auth, url)
        if problem is not None:
            return problem
        collection = urlsplit(url)
        if not href.startswith(collection.path) or not href.endswith(".ics") or ".." in href:
            return Outcome("failed")
        target = f"{collection.scheme}://{collection.netloc}{href}"
        try:
            r = self._call(auth, "GET", target)
        except TransportError:
            return Outcome("failed")
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status != 200:
            return Outcome("failed", r.status)
        if not etag or r.headers.get("etag") != etag \
                or not _is_plain(r.body.decode("utf-8", "replace")):
            return Outcome("changed", r.status)
        try:
            r = self._call(auth, "DELETE", target, {"If-Match": etag})
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    def undo(self, uid: str, etag: str | None) -> Outcome:
        """Delete this one event, if it is still exactly what the harness wrote."""
        ready = self._auth()
        if ready is None:
            return Outcome("no_credentials")
        auth, url = ready
        problem = self._name_problem(auth, url)
        if problem is not None:
            return problem
        href = f"{url}{uid}.ics"
        try:
            r = self._call(auth, "GET", href)
        except TransportError:
            return Outcome("failed")             # nothing has been deleted
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status == 401:
            return Outcome("auth", r.status)
        if r.status != 200:
            return Outcome("failed", r.status)
        current = r.headers.get("etag")
        if not etag or current != etag or not _is_ours(r.body.decode("utf-8", "replace"), uid):
            return Outcome("changed", r.status)
        try:
            r = self._call(auth, "DELETE", href, {"If-Match": etag})
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status == 412:
            return Outcome("changed", r.status)
        if r.status == 401:
            return Outcome("auth", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)
