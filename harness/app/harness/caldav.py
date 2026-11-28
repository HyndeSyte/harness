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
             # Written, not left to iCloud's default (round 5): a fresh copy reads as written whatever iCloud adds.
             "TRANSP:OPAQUE", f"{MARKER}:1", "END:VEVENT", "END:VCALENDAR"]
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


def _meant(line: str, repeats: bool = False) -> str:
    """One line of an event by what it says, not how a server spells it: a time as the moment it
    names, however its zone is written; a rule's parts in any order; text with its escapes and
    spacing aside. In an event that repeats by a rule, a time's form counts too (its zone, UTC or
    floating), since that decides where its later days fall."""
    prop = ical.parse_line(line)
    if prop is None:
        return line
    if prop.name in _WHEN:
        values = prop.value.split(",")
        try:
            moments = []
            for value in values:
                when = ical.parse_when(ical.Prop(prop.name, prop.params, value), timezone.utc)
                moments.append(when.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                               if isinstance(when, datetime) else when.isoformat())
        except ical.Unreadable:
            return line
        form = ""
        if repeats:
            form = (";DATE" if not any("T" in v for v in values) else ";UTC" if all(v.strip().endswith("Z")
                    for v in values) else f";TZID={prop.params['TZID']}" if prop.params.get("TZID") else ";FLOATING")
        return f"{prop.name}{form}:{','.join(sorted(moments))}"
    if prop.name in ("RRULE", "EXRULE"):
        return f"{prop.name}:{';'.join(sorted(prop.value.upper().split(';')))}"
    params = "".join(f";{k}={v}" for k, v in sorted(prop.params.items()))
    return f"{prop.name}{params}:{' '.join(ical.unescape(prop.value).split())}"


def _set_by_someone(name: str) -> bool:
    """A line someone sets, not one a server manages: not a stamp, and not an X- line, except an
    X-APPLE-TRAVEL- one, which is travel time he set."""
    return name not in _STAMPS and (not name.startswith("X-") or name.startswith("X-APPLE-TRAVEL-"))


def _events_said(ics: str) -> dict[tuple, tuple[Counter, Counter]]:
    """Each event in it, by its id and which day of a series it is, with what it says: each line by
    what it says (_meant) and each alarm as one whole, counted, the lines servers manage left out;
    and apart, those of its alarms marked X-APPLE-DEFAULT-ALARM, which a server may add."""
    lines, names = _lines(ics)
    found: list[tuple[list, list]] = []
    props = alarm = None
    default = False
    for line, name in zip(lines, names):
        upper = line.upper()
        if upper == "BEGIN:VEVENT":
            props, alarm = [], None
            found.append((props, []))
        elif upper == "END:VEVENT":
            props = alarm = None
        elif props is None:
            continue
        elif upper == "BEGIN:VALARM":
            alarm, default = [], False
        elif upper == "END:VALARM":
            if alarm is not None:
                found[-1][1].append((alarm, default))
            alarm = None
        elif alarm is not None and name == "X-APPLE-DEFAULT-ALARM":
            default = default or line.split(":", 1)[-1].strip().upper() == "TRUE"
        elif _set_by_someone(name):
            (alarm if alarm is not None else props).append((line, name))
    out: dict[tuple, tuple[Counter, Counter]] = {}
    for props, alarms in found:
        repeats = any(name in ("RRULE", "EXRULE") for _, name in props)
        said = Counter(_meant(line, repeats) for line, _ in props)
        defaults: Counter = Counter()
        for alarm_lines, marked in alarms:
            whole = "VALARM:" + "|".join(sorted(_meant(line) for line, _ in alarm_lines))
            said[whole] += 1
            if marked:
                defaults[whole] += 1
        key = (next((line.split(":", 1)[1] for line, name in props if name == "UID" and ":" in line), ""),
               next((_meant(line) for line, name in props if name == "RECURRENCE-ID"), ""))
        while key in out:                      # one named twice stays twice
            key += ("again",)
        out[key] = (said, defaults)
    return out


def _as_sent(read: str, sent: str) -> bool:
    """A read says what was sent and nothing more, event by event, however the server keeps it:
    lines folded or reordered, a one-off's time written in another zone, the lines servers manage
    (stamps, X- lines) aside, and an alarm marked X-APPLE-DEFAULT-ALARM that wasn't sent, which the
    server added. Anything else added, changed or taken away since, a note, an alert or its removal,
    travel time, a place, a guest or a link, is someone's edit, so it doesn't read as sent. Each
    line counts as often as it was sent, so one of two alike can't stand in for the other."""
    want, have = _events_said(sent), _events_said(read)
    if not want or set(want) != set(have):
        return False
    for key, (said, _) in want.items():
        kept, marked = have[key]
        if kept - (marked - said) != said:     # a default alarm the server added, and nothing else
            return False
    return True


# Round 5 of the review of Nov 27: a Family copy is judged by a strict allowlist, with no blanket X- exemption.
# Set aside, by name, only Harness's own marker (compared like any line it writes) and the iCloud bookkeeping lines
# the repo's iCloud shapes model as the server's own; X-APPLE-TRAVEL-*, X-APPLE-STRUCTURED-LOCATION and every other
# X- line count as edits. Stamps are a server's (_STAMPS).
COPY_SERVER_LINES = frozenset({"X-APPLE-CREATOR-IDENTITY", "X-APPLE-CREATOR-TEAM-IDENTITY"})
# Inside an alarm: its own id lines and the default mark are bookkeeping; what it does is its payload.
_ALARM_BOOKKEEPING = frozenset({"X-WR-ALARMUID", "UID", "X-APPLE-DEFAULT-ALARM", "ACKNOWLEDGED"})
# An alarm marked X-APPLE-DEFAULT-ALARM:TRUE is iCloud's own only when its whole payload is one of these (trigger,
# action, and a display alarm's fixed text), as the repo models iCloud writing them: "none", and the default
# 15-minute alert. Any other alarm, marked or not, is someone's edit.
ICLOUD_DEFAULT_ALARMS = (("ACTION:NONE", "TRIGGER;VALUE=DATE-TIME:19760401T005545Z"),
                         ("ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M"))
# Outside the event, only a time zone block may stand beside it (iCloud may write the copy's times in its zone).
_COPY_BESIDE = frozenset({"VTIMEZONE", "STANDARD", "DAYLIGHT"})


def _default_alarm(payload: list[str]) -> bool:
    said = tuple(sorted(_meant(x) for x in payload))
    return any(said == tuple(sorted(_meant(x) for x in shape)) for shape in ICLOUD_DEFAULT_ALARMS)


def _copy_said(ics: str) -> tuple[list[tuple[str, Counter]], list[str]]:
    """Each event in a Family copy, by its uid, with what it says strictly (round 5): every line by what it says
    (_meant), the stamps and COPY_SERVER_LINES aside, TRANSP:OPAQUE as the default it is (RFC 5545: a missing TRANSP
    means OPAQUE), each alarm as one whole unless it is one of iCloud's default alarms; and the names of anything
    beside the events that isn't a time zone block (a to-do, a journal), which is an edit too."""
    lines, names = _lines(ics)
    events: list[tuple[str, Counter]] = []
    odd: list[str] = []
    stack: list[str] = []
    said: Counter | None = None
    uid = ""
    alarm: list[str] | None = None
    marked = False
    for line, name in zip(lines, names):
        if name in ("BEGIN", "END"):
            comp = line.split(":", 1)[-1].strip().upper()
            if name == "BEGIN":
                stack.append(comp)
                if comp == "VEVENT" and stack == ["VCALENDAR", "VEVENT"]:
                    said, uid = Counter(), ""
                elif comp == "VALARM" and said is not None and stack[-2:] == ["VEVENT", "VALARM"]:
                    alarm, marked = [], False
                elif said is not None:
                    said[f"BEGIN:{comp}"] += 1          # anything else inside the event
                elif comp not in ("VCALENDAR", "VEVENT") and comp not in _COPY_BESIDE:
                    odd.append(comp)
                continue
            if stack:
                stack.pop()
            if comp == "VALARM" and alarm is not None:
                if not (marked and _default_alarm(alarm)):
                    said["VALARM:" + "|".join(sorted(_meant(x) for x in alarm))] += 1
                alarm = None
            elif comp == "VEVENT" and said is not None and stack == ["VCALENDAR"]:
                events.append((uid, said))
                said = None
            continue
        if said is None:
            continue                                    # the calendar's own lines, or a time zone block
        if alarm is not None:
            if name == "X-APPLE-DEFAULT-ALARM":
                marked = marked or line.split(":", 1)[-1].strip().upper() == "TRUE"
            elif name not in _ALARM_BOOKKEEPING:
                alarm.append(line)
            continue
        if name in _STAMPS or name in COPY_SERVER_LINES:
            continue
        if name == "UID" and ":" in line:
            uid = line.split(":", 1)[1].strip()
        meant = _meant(line)
        if meant != "TRANSP:OPAQUE":
            said[meant] += 1
    if said is not None or stack:
        odd.append("UNFINISHED")
    return events, odd


def _name_of(said_line: str) -> str:
    return re.split(r"[;:]", said_line, maxsplit=1)[0].upper()


def copy_differences(ics: str, uid: str, title: str, start, end) -> list[str]:
    """What a Family copy holds beyond, or short of, exactly what Harness writes for this title, start and end, by
    line name ("SUMMARY", "DTSTART", "VALARM", "X-APPLE-TRAVEL-DURATION", "EVENTS" for a second event, "MARKER" for
    its marker gone...). Empty means it holds exactly that: Harness's own (round 5's strict allowlist)."""
    if not ics:
        return ["EMPTY"]
    try:
        sent = build_copy_ics(uid, title or "", start, end, datetime(2000, 1, 1, tzinfo=timezone.utc))
    except (TypeError, ValueError, AttributeError):
        return ["UNREADABLE"]
    try:
        have, odd = _copy_said(ics)
    except (ValueError, TypeError, AttributeError):
        return ["UNREADABLE"]
    (_, want), = _copy_said(sent)[0]
    out = set(odd)
    if len(have) != 1:
        out.add("EVENTS")
    mine = [said for got, said in have if got == uid]
    if not mine:
        return sorted(out | {"UID"})
    said = mine[0]
    if not _is_ours(ics, uid):
        out.add("MARKER" if f"{MARKER}:1" not in _lines(ics)[0] else "NOT-PLAIN")
    out |= {_name_of(x) for x in (said - want) + (want - said)}
    return sorted(out)


def copy_as_written(ics: str, uid: str, title: str, start, end) -> bool:
    """A Family copy (family_copy.py) holds exactly what Harness writes for it and nothing more (round 5): one plain
    event, its uid, Harness's marker kept, and only the lines build_copy_ics writes, with this title, start and end,
    by what they say (times as instants, text unfolded and unescaped). Aside: stamps, the named iCloud bookkeeping
    lines (COPY_SERVER_LINES), a time zone block, and only iCloud's own default alarms (ICLOUD_DEFAULT_ALARMS). An
    allowlist: anything else, travel time, a structured place, any other X- line, an alarm, an attendee, a link, a
    status, a repeat, a second event, a place or notes, is someone's edit."""
    if not ics or not uid:
        return False
    return not copy_differences(ics, uid, title, start, end)


def copy_holds_only_ours(ics: str, uid: str) -> bool:
    """A Family copy holds nothing but the lines build_copy_ics writes, whatever its title and times now say (the
    strict allowlist, round 5)."""
    if not ics or not uid or not _is_ours(ics, uid):
        return False
    try:
        have, odd = _copy_said(ics)
    except (ValueError, TypeError, AttributeError):
        return False
    if odd or len(have) != 1 or have[0][0] != uid:
        return False
    names = sorted(_name_of(x) for x in have[0][1].elements())
    return names == ["DTEND", "DTSTART", "SUMMARY", "UID", MARKER]


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

    def items_between(self, start: datetime, end: datetime, tz: str, *, fresh: bool = False) -> Read | None:
        """What is on Family in this window. Reads only. None when that can't be said. `fresh`:
        asked past any cache (calendar_change's read back, read once more)."""
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
                           {"Depth": "1", "Content-Type": "application/xml; charset=utf-8",
                            **({"Cache-Control": "no-cache", "Pragma": "no-cache"} if fresh else {})}, body)
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
        """A copy from Gmail, new or a change to Harness's own, through the one guarded write (copy_write)."""
        return self.copy_write(uid, build_copy_ics(uid, title, start, end, now), etag)

    def copy_write(self, uid: str, body: str, etag: str | None) -> Outcome:
        """The one guarded write of a Harness copy on Family (round 5 of the review of Nov 27). A create (etag None)
        carries If-None-Match: *, so it never lands over anything; a change carries If-Match with the version that
        passed the ownership check, and a change with no version is never sent. Nothing is retried here: a 412 is
        "changed" ("exists" for a create) and a lost answer "unknown", and the caller reads the copy again and runs
        the allowlist before anything more is written (family_copy.FamilyCopy._guarded)."""
        if etag == "":
            return Outcome("failed")
        guard = {"If-None-Match": "*"} if etag is None else {"If-Match": etag}
        out = self._write("PUT", self.href_for(uid), guard, body)
        if etag is None and out.kind == "changed":
            return Outcome("exists", out.status)
        return out

    def copy_delete(self, uid: str, etag: str) -> Outcome:
        """A Harness copy taken off, only at the version that passed the ownership check (If-Match), never without
        one. As copy_write: no retry here."""
        if not etag:
            return Outcome("failed")
        return self._write("DELETE", self.href_for(uid), {"If-Match": etag})

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

    def replace(self, href: str, etag: str | None, ics: str) -> Outcome:
        """Only over the version just read. None (eleventh round): a read-compare-write the caller has
        already compared (a weak version, or a calendar he opened without protection): no If-Match."""
        if etag is None:
            return self._write("PUT", href, {}, ics)
        return self._write("PUT", href, {"If-Match": etag}, ics) if etag else Outcome("failed")

    def remove_at(self, href: str, etag: str | None) -> Outcome:
        """Only the version just read; None as for replace."""
        if etag is None:
            return self._write("DELETE", href, {})
        return self._write("DELETE", href, {"If-Match": etag}) if etag else Outcome("failed")

    def put_new(self, href: str, ics: str) -> Outcome:
        """Never over anything."""
        return self._write("PUT", href, {"If-None-Match": "*"}, ics)

    def href_for(self, uid: str) -> str:
        return f"{self.credentials()[2]}{uid}.ics"

    def undo(self, uid: str, etag: str | None, data: str = "",
             sending: Callable[[], None] | None = None) -> Outcome:
        """Delete this one event, if it is still exactly what the harness wrote. `sending` is called
        just before the delete goes out, and only then, so a caller can count the deletes it sends."""
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
        if sending is not None:
            sending()
        try:
            # Eighteenth round: If-Match the version the harness journaled when it wrote it, when it has one.
            r = self._call(auth, "DELETE", href, {"If-Match": etag or current})
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
