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
import logging
import re
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import unquote, urlsplit

from . import ical
from .net import REDACT, HttpResponse, TransportError

log = logging.getLogger(__name__)

CALENDAR_NAME = "Family"       # fixed in code; nothing can name another calendar
INPUT = "family"               # its name among the inputs (inputs.FAMILY)
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


_STAMPS = frozenset({"DTSTAMP", "LAST-MODIFIED", "CREATED", "SEQUENCE", "PRODID"})
_NOT_PLAIN = frozenset({"ATTENDEE", "ORGANIZER", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"})


def _lines(ics: str) -> tuple[list[str], list[str]]:
    text = re.sub(r"\r?\n[ \t]", "", ics.replace("\r\n", "\n"))
    lines = [x for x in text.split("\n") if x]
    return lines, [re.split(r"[;:]", x, maxsplit=1)[0].upper() for x in lines]


def _not_plain(lines: list[str], names: list[str]) -> list[str]:
    """What stops this being a plain one-off. Only the event's own lines count: a time zone
    block alongside it has repeat lines of its own, for its clock changes."""
    out, inside = [], False
    for line, name in zip(lines, names):
        if line.upper() in ("BEGIN:VEVENT", "END:VEVENT"):
            inside = line.upper() == "BEGIN:VEVENT"
        elif inside and name in _NOT_PLAIN:
            out.append(line)
    return out


def _is_plain(ics: str) -> bool:
    """One event, with no attendee, organizer or repeat that could turn a delete
    into a message to someone."""
    lines, names = _lines(ics)
    if sum(x.upper() == "BEGIN:VEVENT" for x in lines) != 1:
        return False
    return not _not_plain(lines, names)


def _content(ics: str) -> list[str]:
    """What the event says: not its stamps, the server's own X- lines, or their order."""
    lines, names = _lines(ics)
    out, inside = [], False
    for line, name in zip(lines, names):
        if line.upper() in ("BEGIN:VEVENT", "END:VEVENT"):
            inside = line.upper() == "BEGIN:VEVENT"
        elif inside and name not in _STAMPS and not name.startswith("X-"):
            out.append(line)
    return sorted(out)


def _unchanged(ics: str, read: str) -> bool:
    """The same event as was just read, however the server wrote it. A calendar's list and a
    GET can answer with different ETags for one version."""
    now, then = _content(ics), _content(read)
    return bool(then) and now == then


_WHEN = frozenset({"DTSTART", "DTEND", "RECURRENCE-ID", "EXDATE", "RDATE"})


def _meant(line: str) -> str:
    """One line of an event by what it says, not how a server spells it: a time as the moment it
    names, however its zone is written; a rule's parts in any order; text with its escapes and
    spacing aside."""
    prop = ical.parse_line(line)
    if prop is None:
        return line
    if prop.name in _WHEN:
        try:
            moments = []
            for value in prop.value.split(","):
                when = ical.parse_when(ical.Prop(prop.name, prop.params, value), timezone.utc)
                moments.append(when.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                               if isinstance(when, datetime) else when.isoformat())
        except ical.Unreadable:
            return line
        return f"{prop.name}:{','.join(sorted(moments))}"
    if prop.name in ("RRULE", "EXRULE"):
        return f"{prop.name}:{';'.join(sorted(prop.value.upper().split(';')))}"
    params = "".join(f";{k}={v}" for k, v in sorted(prop.params.items()))
    return f"{prop.name}{params}:{' '.join(ical.unescape(prop.value).split())}"


def _said_by_events(ics: str) -> Counter:
    """What the events in it say, each line by what it says (_meant) and each alarm as one whole,
    counted, without what servers manage: the stamps and X- lines _unchanged leaves out too, and an
    alarm marked X-APPLE-DEFAULT-ALARM, which a server adds of its own."""
    lines, names = _lines(ics)
    out: Counter = Counter()
    inside, alarm, default = False, None, False
    for line, name in zip(lines, names):
        upper = line.upper()
        if upper in ("BEGIN:VEVENT", "END:VEVENT"):
            inside, alarm = upper == "BEGIN:VEVENT", None
        elif not inside:
            continue
        elif upper == "BEGIN:VALARM":
            alarm, default = [], False
        elif upper == "END:VALARM":
            if alarm is not None and not default:
                out["VALARM:" + "|".join(sorted(alarm))] += 1
            alarm = None
        elif name == "X-APPLE-DEFAULT-ALARM":
            default = default or line.split(":", 1)[-1].strip().upper() == "TRUE"
        elif name in _STAMPS or name.startswith("X-"):
            continue
        elif alarm is not None:
            alarm.append(_meant(line))
        else:
            out[_meant(line)] += 1
    return out


def _as_sent(read: str, sent: str) -> bool:
    """A read says what was sent and nothing more, however the server keeps it: lines folded or
    reordered, a time written in another zone, and the lines servers manage (stamps, X- lines, a
    default alarm it adds) aside. Anything else added or changed since, a note, an alert, a place, a
    guest or a link, is someone's edit, so it doesn't read as sent. Each line counts as often as it
    was sent, so one of two alike can't stand in for the other."""
    want = _said_by_events(sent)
    return bool(want) and _said_by_events(read) == want


def _uids(ics: str) -> set[str]:
    """The ids of the events in it: an alarm's own id inside one isn't."""
    lines, names = _lines(ics)
    out: set[str] = set()
    within: list[str] = []
    for line, name in zip(lines, names):
        if name == "BEGIN":
            within.append(line.split(":", 1)[-1].strip().upper())
        elif name == "END":
            within = within[:-1]
        elif name == "UID" and within[-1:] == ["VEVENT"] and ":" in line:
            out.add(line.split(":", 1)[1])
    return out


def _names(lines) -> list[str]:
    """Property names only, for the log. Never what they say."""
    names = {re.split(r"[;:]", x, maxsplit=1)[0].upper() for x in lines}
    return sorted(x for x in names if re.fullmatch(r"[A-Z0-9-]{1,40}", x))


def _why_refused(body: str, same_etag: bool, read: str) -> str:
    lines, names = _lines(body)
    odd = _names(_not_plain(lines, names))
    events = sum(x.upper() == "BEGIN:VEVENT" for x in lines)
    differ = set(_content(body)) ^ set(_content(read))
    return (f"events={events} not_plain={odd} same_etag={same_etag} "
            f"had_read={bool(read)} differ={_names(differ)}")


def href_path(href: str) -> str:
    """One event's address however the server wrote it, to compare two reads."""
    try:
        return unquote(urlsplit(href).path)
    except ValueError:
        return href


def details(ics: str) -> tuple[str, ...]:
    """What someone can add that the reader's title and times don't show."""
    lines, names = _lines(ics)
    return tuple(x for x, name in zip(lines, names) if name in ("DESCRIPTION", "LOCATION"))


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
    data: str = ""


@dataclass(frozen=True)
class Read:
    items: list[Item]
    unreadable: int


class FamilyCalDav:
    def __init__(self, transport, credentials: Callable[[], tuple[str, str, str]],
                 seen: Callable[..., None] | None = None):
        self.transport = transport
        self.credentials = credentials     # (Apple ID, app password, calendar address)
        # inputs.Seen: what iCloud answered, so a turned-down password is told at once.
        self.seen = seen or (lambda *a: None)

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
            self.seen(INPUT, "unreachable", "couldn't reach iCloud")
            return Outcome("failed")             # no write has been sent
        if r.status == 401:
            self.seen(INPUT, "refused", "iCloud refused the app-specific password")
            return Outcome("auth", r.status)
        if r.status != 207:
            self._answered(r.status)
            return Outcome("failed", r.status)
        try:
            name = ET.fromstring(r.body).findtext(f".//{_DAV}")
        except ET.ParseError:
            self.seen(INPUT, "error", "iCloud's answer couldn't be read")
            return Outcome("failed", r.status)
        if name != CALENDAR_NAME:
            self.seen(INPUT, "error", "the saved address isn't the Family calendar")
            return Outcome("mismatch", r.status)
        self.seen(INPUT)
        return None

    def _answered(self, status: int) -> None:
        """An answer that isn't the one asked for: none yet, or an error. Said without its code."""
        if status >= 500:
            self.seen(INPUT, "unreachable", "iCloud isn't answering right now")
        else:
            self.seen(INPUT, "error", "iCloud answered with an error")

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
                self._answered(r.status)
                return None
            out: list[Item] = []
            unreadable = 0
            for resp in ET.fromstring(r.body).iter("{DAV:}response"):
                href = resp.findtext("{DAV:}href") or ""
                etag = resp.findtext(".//{DAV:}getetag") or ""
                data = resp.findtext(f".//{_CALENDAR_DATA}") or ""
                if "BEGIN:VCALENDAR" not in data:
                    self.seen(INPUT, "error", "iCloud's answer couldn't be read")
                    return None                  # an answer with no event in it is no answer
                w = ical.window(data, start=start, end=end, tz=tz, fallback_name=CALENDAR_NAME)
                unreadable += w.unreadable
                out += [Item(occ, href, etag, data) for occ in w.occurrences]
            return Read(out, unreadable)
        except TransportError:
            self.seen(INPUT, "unreachable", "couldn't reach iCloud")
            return None
        except (ET.ParseError, ValueError):
            self.seen(INPUT, "error", "iCloud's answer couldn't be read")
            return None

    def put_copy(self, uid: str, title: str, start, end, now: datetime,
                 etag: str | None = None, data: str = "") -> Outcome:
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
        if etag == "":
            return Outcome("failed")           # a change to one with no version isn't a new one
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
                current = self._current_etag(auth, href, uid, data)
                if current.kind != "ok":
                    return current
                return self._put_again(auth, href, uid, title, start, end, now, current.etag)
            return self._ours_already(auth, href, uid)
        if r.status == 401:
            return Outcome("auth", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    def _current_etag(self, auth: dict, href: str, uid: str, data: str) -> Outcome:
        """The ETag of our copy, if it's unchanged from what was just read. Only an answer
        that shows a difference is "changed": not getting an answer says nothing."""
        try:
            r = self._call(auth, "GET", href)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status == 401:
            return Outcome("auth", r.status)
        if r.status != 200:
            return Outcome("unknown" if r.status >= 500 else "failed", r.status)
        body = r.body.decode("utf-8", "replace")
        if not (_is_ours(body, uid) and _unchanged(body, data)):
            return Outcome("changed", r.status)
        etag = r.headers.get("etag")
        return Outcome("ok", r.status, etag) if etag else Outcome("failed", r.status)

    def _put_again(self, auth: dict, href: str, uid: str, title: str, start, end, now: datetime,
                   etag: str) -> Outcome:
        """Once, with the ETag a GET gave. A second refusal is a real change."""
        try:
            r = self._call(auth, "PUT", href, {**_ICS_HEADERS, "If-Match": etag},
                           build_copy_ics(uid, title, start, end, now))
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 201, 204):
            return Outcome("ok", r.status, r.headers.get("etag"))
        if r.status == 412:
            return Outcome("changed", r.status)
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

    def remove_hand_copy(self, href: str, etag: str, data: str = "") -> Outcome:
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
        try:
            path = urlsplit(href).path     # a server may answer with a whole address, or escape it
        except ValueError:
            return Outcome("failed")
        if not unquote(path).startswith(unquote(collection.path)) or not path.endswith(".ics") \
                or ".." in unquote(path) or re.search(r"%(25|2f|5c)", path, re.I):
            return Outcome("failed")
        target = f"{collection.scheme}://{collection.netloc}{path}"
        try:
            r = self._call(auth, "GET", target)
        except TransportError:
            return Outcome("failed")
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status != 200:
            return Outcome("failed", r.status)
        body, current = r.body.decode("utf-8", "replace"), r.headers.get("etag")
        if not _is_plain(body) or (current != etag and not _unchanged(body, data)):
            log.warning("family copy: hand copy refused: %s", _why_refused(body, current == etag, data))
            return Outcome("changed", r.status)
        if not (current or etag):
            return Outcome("failed", r.status)   # nothing to guard the delete with
        try:
            r = self._call(auth, "DELETE", target, {"If-Match": current or etag})
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 204):
            return Outcome("ok", r.status)
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status == 412:
            log.warning("family copy: hand copy delete refused: same_etag=%s", current == etag)
            return Outcome("changed", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    # -- what he asks for (calendar_change.py): any event on Family, guarded the same way --
    def _at(self, url: str, href: str) -> str | None:
        """The event's whole address, only if it's in this calendar."""
        collection = urlsplit(url)
        try:
            path = urlsplit(href).path     # a server may answer with a whole address, or escape it
        except ValueError:
            return None
        if not unquote(path).startswith(unquote(collection.path)) or not path.endswith(".ics") \
                or ".." in unquote(path) or re.search(r"%(25|2f|5c)", path, re.I):
            return None
        return f"{collection.scheme}://{collection.netloc}{path}"

    def _ready(self) -> tuple[dict, str] | Outcome:
        ready = self._auth()
        if ready is None:
            return Outcome("no_credentials")
        return self._name_problem(*ready) or ready

    def fetch(self, href: str) -> tuple[Outcome, str]:
        """One event as it is now, with the version to guard a change with."""
        ready = self._ready()
        if isinstance(ready, Outcome):
            return ready, ""
        auth, url = ready
        target = self._at(url, href)
        if target is None:
            return Outcome("failed"), ""
        try:
            r = self._call(auth, "GET", target)
        except TransportError:
            return Outcome("failed"), ""
        if r.status == 404:
            return Outcome("gone", r.status), ""
        if r.status == 401:
            return Outcome("auth", r.status), ""
        if r.status != 200:
            return Outcome("failed", r.status), ""
        return Outcome("ok", r.status, r.headers.get("etag")), r.body.decode("utf-8", "replace")

    def _write(self, method: str, href: str, guard: dict, body: str | None = None) -> Outcome:
        ready = self._ready()
        if isinstance(ready, Outcome):
            return ready
        auth, url = ready
        target = self._at(url, href)
        if target is None:
            return Outcome("failed")
        try:
            r = self._call(auth, method, target,
                           {**(_ICS_HEADERS if body else {}), **guard}, body)
        except TransportError as e:
            return Outcome("failed" if e.kind == "blocked" else "unknown")
        if r.status in (200, 201, 204):
            return Outcome("ok", r.status, r.headers.get("etag"))
        if r.status == 412:
            return Outcome("changed", r.status)
        if r.status == 404:
            return Outcome("gone", r.status)
        if r.status == 401:
            return Outcome("auth", r.status)
        return Outcome("unknown" if r.status >= 500 else "failed", r.status)

    def replace(self, href: str, etag: str, ics: str) -> Outcome:
        """Only over the version just read."""
        return self._write("PUT", href, {"If-Match": etag}, ics) if etag else Outcome("failed")

    def remove_at(self, href: str, etag: str) -> Outcome:
        """Only the version just read."""
        return self._write("DELETE", href, {"If-Match": etag}) if etag else Outcome("failed")

    def put_new(self, href: str, ics: str) -> Outcome:
        """Never over anything."""
        return self._write("PUT", href, {"If-None-Match": "*"}, ics)

    def href_for(self, uid: str) -> str:
        return f"{self.credentials()[2]}{uid}.ics"

    def undo(self, uid: str, etag: str | None, data: str = "") -> Outcome:
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
        body, current = r.body.decode("utf-8", "replace"), r.headers.get("etag")
        if not _is_ours(body, uid) or (current != etag and not _unchanged(body, data)):
            return Outcome("changed", r.status)
        if not (current or etag):
            return Outcome("failed", r.status)   # nothing to guard the delete with
        try:
            r = self._call(auth, "DELETE", href, {"If-Match": current or etag})
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
