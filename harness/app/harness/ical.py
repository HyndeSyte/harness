"""Read an iCalendar feed (RFC 5545) and list what falls in a window.

Only what Google Calendar's secret iCal address actually produces is
understood: VEVENTs with DTSTART/DTEND/DURATION (UTC, TZID or all-day),
RRULE with FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH and
WKST, EXDATE, RECURRENCE-ID overrides, cancelled and declined events.

Anything else that would decide whether an event happens in the window
(another RRULE part, RDATE, a time zone zoneinfo doesn't know) is not
guessed at: the event is counted as unread and the digest says so. An
agenda that silently drops a meeting is worse than one that admits a gap.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SUPPORTED_RRULE = frozenset({"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY",
                             "BYMONTH", "WKST"})
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
# Exchange-style names that turn up in invitations forwarded into Google.
WINDOWS_TZ = {
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "US Mountain Standard Time": "America/Phoenix",
    "Pacific Standard Time": "America/Los_Angeles",
    "Alaskan Standard Time": "America/Anchorage",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "GMT Standard Time": "Europe/London",
    "UTC": "UTC",
}
MAX_STEPS = 50_000          # candidate periods walked per event, at most
MAX_SUMMARY = 80


class Unreadable(Exception):
    """This event can't be placed in time with confidence."""


@dataclass(frozen=True)
class Occurrence:
    start: datetime | date
    end: datetime | date
    all_day: bool
    summary: str
    calendar: str
    transparent: bool = False


@dataclass
class Window:
    """What a feed says about [start, end), in local time."""
    calendar: str
    occurrences: list[Occurrence] = field(default_factory=list)
    unreadable: int = 0          # events that might fall in the window but couldn't be read


# -- lines and properties -------------------------------------------------------

def unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


@dataclass(frozen=True)
class Prop:
    name: str
    params: dict
    value: str


def parse_line(line: str) -> Prop | None:
    in_q = False
    for i, ch in enumerate(line):
        if ch == '"':
            in_q = not in_q
        elif ch == ":" and not in_q:
            head, value = line[:i], line[i + 1:]
            break
    else:
        return None
    parts = re.findall(r'(?:[^;"]|"[^"]*")+', head)
    if not parts:
        return None
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.strip().upper()] = v.strip().strip('"')
    return Prop(parts[0].strip().upper(), params, value)


def unescape(v: str) -> str:
    out, i = [], 0
    while i < len(v):
        ch = v[i]
        if ch == "\\" and i + 1 < len(v):
            nxt = v[i + 1]
            out.append("\n" if nxt in "nN" else nxt)
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _zone(tzid: str | None, default: ZoneInfo) -> ZoneInfo:
    if not tzid:
        return default
    name = WINDOWS_TZ.get(tzid, tzid)
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise Unreadable(f"time zone {tzid!r}") from None


def parse_when(prop: Prop, default: ZoneInfo) -> datetime | date:
    """A DATE (all-day) or an aware DATETIME."""
    v = prop.value.strip()
    if prop.params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", v):
        try:
            return datetime.strptime(v[:8], "%Y%m%d").date()
        except ValueError:
            raise Unreadable(f"date {v!r}") from None
    m = re.fullmatch(r"(\d{8}T\d{6})(Z?)", v)
    if not m:
        raise Unreadable(f"date-time {v!r}")
    naive = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S")
    if m.group(2):
        return naive.replace(tzinfo=timezone.utc)
    return naive.replace(tzinfo=_zone(prop.params.get("TZID"), default))


def parse_duration(v: str) -> timedelta:
    m = re.fullmatch(r"([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
                     v.strip())
    if not m or v.strip() in ("P", "PT", "+P", "-P"):
        raise Unreadable(f"duration {v!r}")
    sign = -1 if m.group(1) == "-" else 1
    w, d, h, mi, s = (int(x or 0) for x in m.groups()[1:])
    return sign * timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


# -- events ---------------------------------------------------------------------------

@dataclass
class Event:
    uid: str = ""
    props: list[Prop] = field(default_factory=list)

    def first(self, name: str) -> Prop | None:
        for p in self.props:
            if p.name == name:
                return p
        return None

    def all(self, name: str) -> list[Prop]:
        return [p for p in self.props if p.name == name]


def parse_calendar(text: str) -> tuple[dict, list[Event]]:
    """Returns (calendar properties, top-level VEVENTs). Nested components
    (VALARM) are skipped; VTIMEZONE is ignored in favour of zoneinfo."""
    cal: dict = {}
    events: list[Event] = []
    stack: list[str] = []
    cur: Event | None = None
    for line in unfold(text):
        p = parse_line(line)
        if p is None:
            continue
        if p.name == "BEGIN":
            stack.append(p.value.strip().upper())
            if stack == ["VCALENDAR", "VEVENT"]:
                cur = Event()
            continue
        if p.name == "END":
            if stack and stack[-1] == "VEVENT" and len(stack) == 2 and cur is not None:
                events.append(cur)
                cur = None
            if stack:
                stack.pop()
            continue
        if stack == ["VCALENDAR"]:
            cal.setdefault(p.name, p.value)
        elif stack == ["VCALENDAR", "VEVENT"] and cur is not None:
            cur.props.append(p)
            if p.name == "UID":
                cur.uid = p.value
    return cal, events


# -- recurrence -------------------------------------------------------------------------

def parse_rrule(value: str) -> dict:
    rule: dict = {}
    for part in value.split(";"):
        if not part:
            continue
        k, _, v = part.partition("=")
        rule[k.strip().upper()] = v.strip()
    unknown = set(rule) - SUPPORTED_RRULE
    if unknown:
        raise Unreadable("RRULE " + ",".join(sorted(unknown)))
    if rule.get("FREQ") not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        raise Unreadable(f"RRULE FREQ={rule.get('FREQ')}")
    if "COUNT" in rule and "UNTIL" in rule:
        raise Unreadable("RRULE with both COUNT and UNTIL")
    return rule


def _ints(v: str | None, lo: int, hi: int) -> list[int]:
    if not v:
        return []
    out = []
    for x in v.split(","):
        try:
            n = int(x)
        except ValueError:
            raise Unreadable(f"RRULE value {x!r}") from None
        if not (lo <= abs(n) <= hi):
            raise Unreadable(f"RRULE value {x!r}")
        out.append(n)
    return out


def _bydays(v: str | None) -> list[tuple[int, int]]:
    """[(ordinal or 0, weekday)]"""
    out = []
    for x in (v or "").split(","):
        if not x:
            continue
        m = re.fullmatch(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)", x.strip().upper())
        if not m:
            raise Unreadable(f"BYDAY {x!r}")
        n = int(m.group(1)) if m.group(1) else 0
        if abs(n) > 53:
            raise Unreadable(f"BYDAY {x!r}")
        out.append((n, WEEKDAYS[m.group(2)]))
    return out


def _month_days(y: int, mo: int) -> int:
    nxt = date(y + (mo == 12), mo % 12 + 1, 1)
    return (nxt - date(y, mo, 1)).days


def _days_in_month(y: int, mo: int, bymonthday: list[int], byday: list[tuple[int, int]],
                   default_day: int) -> list[date]:
    n = _month_days(y, mo)
    days: set[int] = set()
    if bymonthday:
        for d in bymonthday:
            dd = d if d > 0 else n + 1 + d
            if 1 <= dd <= n:
                days.add(dd)
    if byday:
        found: set[int] = set()
        for ordinal, wd in byday:
            matches = [d for d in range(1, n + 1) if date(y, mo, d).weekday() == wd]
            if ordinal == 0:
                found.update(matches)
            elif 1 <= abs(ordinal) <= len(matches):
                found.add(matches[ordinal - 1] if ordinal > 0 else matches[ordinal])
        # BYMONTHDAY and BYDAY together: both must hold (RFC 5545 limit/expand).
        days = (days & found) if bymonthday else found
    if not bymonthday and not byday:
        if default_day <= n:
            days.add(default_day)
    return [date(y, mo, d) for d in sorted(days)]


def _fast_forward(start: date, rule: dict, skip_before: date) -> tuple[int, int]:
    """For the plain shapes (DAILY with no BY parts; WEEKLY with at most
    BYDAY), how many whole periods can be jumped before `skip_before`, and
    how many instances on or after `start` they hold. (0, 0) otherwise."""
    freq = rule["FREQ"]
    interval = int(rule.get("INTERVAL") or 1)
    if interval < 1 or rule.get("BYMONTH") or rule.get("BYMONTHDAY") or skip_before <= start:
        return 0, 0
    if freq == "DAILY" and not rule.get("BYDAY"):
        k = (skip_before - start).days // interval
        return k, k
    if freq == "WEEKLY":
        byday = _bydays(rule.get("BYDAY"))
        if any(n for n, _ in byday):
            return 0, 0
        wkst = WEEKDAYS.get((rule.get("WKST") or "MO").upper(), 0)
        wds = {wd for _, wd in byday} or {start.weekday()}
        week0 = start - timedelta(days=(start.weekday() - wkst) % 7)
        k = ((skip_before - week0).days // 7) // interval - 1     # whole periods before
        if k < 1:
            return 0, 0
        first_week = sum(1 for wd in wds if week0 + timedelta(days=(wd - wkst) % 7) >= start)
        return k, first_week + (k - 1) * len(wds)
    return 0, 0


def _candidate_dates(start: date, rule: dict, from_period: int = 0):
    """Yields candidate dates in order, starting at the period of `start`
    (or `from_period` periods later, for DAILY and WEEKLY)."""
    freq = rule["FREQ"]
    interval = int(rule.get("INTERVAL") or 1)
    if interval < 1:
        raise Unreadable("RRULE INTERVAL")
    byday = _bydays(rule.get("BYDAY"))
    bymonth = _ints(rule.get("BYMONTH"), 1, 12)
    bymonthday = _ints(rule.get("BYMONTHDAY"), 1, 31)
    wkst = WEEKDAYS.get((rule.get("WKST") or "MO").upper())
    if wkst is None:
        raise Unreadable("RRULE WKST")
    if freq in ("DAILY", "WEEKLY") and any(n for n, _ in byday):
        raise Unreadable("BYDAY ordinal outside MONTHLY/YEARLY")

    if freq == "DAILY":
        for i in range(from_period, from_period + MAX_STEPS):
            d = start + timedelta(days=i * interval)
            if bymonth and d.month not in bymonth:
                continue
            if bymonthday and not _day_matches(d, bymonthday):
                continue
            if byday and d.weekday() not in {wd for _, wd in byday}:
                continue
            yield d
        raise Unreadable("too many repeats to walk")
    if freq == "WEEKLY":
        wds = sorted({wd for _, wd in byday} or {start.weekday()},
                     key=lambda wd: (wd - wkst) % 7)
        week0 = start - timedelta(days=(start.weekday() - wkst) % 7)
        for i in range(from_period, from_period + MAX_STEPS):
            ws = week0 + timedelta(weeks=i * interval)
            for wd in wds:
                d = ws + timedelta(days=(wd - wkst) % 7)
                if bymonth and d.month not in bymonth:
                    continue
                if bymonthday and not _day_matches(d, bymonthday):
                    continue
                yield d
        raise Unreadable("too many repeats to walk")
    if freq == "MONTHLY":
        y, mo = start.year, start.month
        for _ in range(MAX_STEPS):
            if not bymonth or mo in bymonth:
                yield from _days_in_month(y, mo, bymonthday, byday, start.day)
            mo += interval
            while mo > 12:
                mo -= 12
                y += 1
        raise Unreadable("too many repeats to walk")
    # YEARLY
    if byday and not bymonth and any(n for n, _ in byday):
        raise Unreadable("YEARLY BYDAY ordinal without BYMONTH")
    if bymonthday and not bymonth:
        raise Unreadable("YEARLY BYMONTHDAY without BYMONTH")
    months = bymonth or [start.month]
    for i in range(MAX_STEPS):
        y = start.year + i * interval
        if y > 9998:
            raise Unreadable("year out of range")
        if byday and not bymonth:
            # every such weekday of the year
            for mo in range(1, 13):
                yield from _days_in_month(y, mo, bymonthday, byday, start.day)
            continue
        for mo in sorted(months):
            yield from _days_in_month(y, mo, bymonthday, byday, start.day)
    raise Unreadable("too many repeats to walk")


def _day_matches(d: date, bymonthday: list[int]) -> bool:
    n = _month_days(d.year, d.month)
    return any((x if x > 0 else n + 1 + x) == d.day for x in bymonthday)


def _key(when: datetime | date) -> str:
    """Comparable identity of an instance start, for EXDATE and RECURRENCE-ID."""
    if isinstance(when, datetime):
        return when.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return when.strftime("%Y%m%d")


def _instance_start(d: date, dtstart: datetime | date) -> datetime | date:
    if isinstance(dtstart, datetime):
        # Same wall-clock time in the event's own zone: DST-correct.
        return datetime.combine(d, dtstart.timetz().replace(tzinfo=None), tzinfo=dtstart.tzinfo)
    return d


def _until(rule: dict, dtstart, default: ZoneInfo):
    v = rule.get("UNTIL")
    if not v:
        return None
    return parse_when(Prop("UNTIL", {}, v), dtstart.tzinfo if isinstance(dtstart, datetime)
                      and dtstart.tzinfo else default)


def _not_after(inst, until) -> bool:
    if until is None:
        return True
    if isinstance(inst, datetime) and isinstance(until, datetime):
        return inst <= until
    if isinstance(inst, datetime):           # UNTIL is a date: through that whole day
        return inst.date() <= until
    if isinstance(until, datetime):
        return inst <= until.date()
    return inst <= until


def expand(dtstart, rule: dict, *, window_end_date: date, default: ZoneInfo,
           exdates: set[str], skip_before: date | None = None):
    """Instance starts of a recurring event, through window_end_date.
    Instances on days before `skip_before` are counted (for COUNT) but not
    built or yielded: a daily series from 2005 is walked cheaply."""
    first = dtstart.date() if isinstance(dtstart, datetime) else dtstart
    count = int(rule["COUNT"]) if rule.get("COUNT") else None
    if count is not None and count < 1:
        return
    until = _until(rule, dtstart, default)
    until_day = (until.astimezone(timezone.utc).date() if isinstance(until, datetime)
                 else until)
    jump, seen = _fast_forward(first, rule, skip_before) if skip_before else (0, 0)
    if until_day is not None and jump and seen and first + timedelta(days=1) > until_day:
        jump, seen = 0, 0
    for d in _candidate_dates(first, rule, jump):
        if d < first:
            continue
        if skip_before is not None and d < skip_before:
            if until_day is not None and d > until_day + timedelta(days=1):
                return
            seen += 1
            if count is not None and seen > count:
                return
            continue
        inst = _instance_start(d, dtstart)
        if not _not_after(inst, until):
            return
        seen += 1
        if count is not None and seen > count:
            return
        if d > window_end_date:
            return
        if _key(inst) in exdates:
            continue
        yield inst


# -- the window -------------------------------------------------------------------------

def _end_of(ev: Event, start, default: ZoneInfo):
    p = ev.first("DTEND")
    if p is not None:
        end = parse_when(p, default)
        if isinstance(end, datetime) != isinstance(start, datetime):
            raise Unreadable("DTSTART and DTEND of different kinds")
        return end - start
    p = ev.first("DURATION")
    if p is not None:
        return parse_duration(p.value)
    return timedelta(days=1) if not isinstance(start, datetime) else timedelta(0)


def _overlaps(start, end, ws: datetime, we: datetime, local: ZoneInfo) -> bool:
    if isinstance(start, datetime):
        if end == start:                       # a point in time
            return ws <= start < we
        return start < we and end > ws
    # all-day: dates, end exclusive
    return start < we.astimezone(local).date() and end > ws.astimezone(local).date()


def _declined(ev: Event, me: str | None) -> bool:
    if not me:
        return False
    for a in ev.all("ATTENDEE"):
        if a.value.lower().removeprefix("mailto:") == me and \
                a.params.get("PARTSTAT", "").upper() == "DECLINED":
            return True
    return False


def window(text: str, *, start: datetime, end: datetime, tz: str,
           fallback_name: str = "Calendar") -> Window:
    local = ZoneInfo(tz)
    cal, events = parse_calendar(text)
    default = local
    if cal.get("X-WR-TIMEZONE"):
        try:
            default = _zone(unescape(cal["X-WR-TIMEZONE"]).strip(), local)
        except Unreadable:
            default = local
    name = unescape(cal.get("X-WR-CALNAME", "")).strip() or fallback_name
    me = name.lower() if "@" in name else None       # Google names a primary calendar by address
    out = Window(calendar=name)
    window_end_date = end.astimezone(local).date() + timedelta(days=1)

    masters: dict[str, Event] = {}
    overrides: dict[str, dict[str, Event]] = {}
    loose: list[Event] = []
    for ev in events:
        if ev.first("RECURRENCE-ID") is not None:
            try:
                rid = parse_when(ev.first("RECURRENCE-ID"), default)
            except Unreadable:
                if _maybe_relevant(ev, None, start, end, default, local):
                    out.unreadable += 1
                continue
            overrides.setdefault(ev.uid, {})[_key(rid)] = ev
        elif ev.uid and ev.first("RRULE") is not None:
            masters[ev.uid] = ev
        else:
            loose.append(ev)

    def add(ev: Event, s, dur):
        e = s + dur
        if not _overlaps(s, e, start, end, local):
            return
        if (ev.first("STATUS") and ev.first("STATUS").value.upper() == "CANCELLED") \
                or _declined(ev, me):
            return
        summary = unescape(ev.first("SUMMARY").value).strip() if ev.first("SUMMARY") else ""
        summary = " ".join(summary.split())[:MAX_SUMMARY] or "(no title)"
        transp = ev.first("TRANSP")
        out.occurrences.append(Occurrence(s, e, not isinstance(s, datetime), summary, name,
                                          bool(transp and transp.value.upper() == "TRANSPARENT")))

    for ev in loose:
        try:
            p = ev.first("DTSTART")
            if p is None:
                raise Unreadable("no DTSTART")
            s = parse_when(p, default)
            add(ev, s, _end_of(ev, s, default))
        except Unreadable:
            if _maybe_relevant(ev, None, start, end, default, local):
                out.unreadable += 1

    for uid, ev in masters.items():
        ovs = overrides.pop(uid, {})
        try:
            p = ev.first("DTSTART")
            if p is None:
                raise Unreadable("no DTSTART")
            s0 = parse_when(p, default)
            dur = _end_of(ev, s0, default)
            if ev.first("RDATE") is not None or len(ev.all("RRULE")) > 1:
                raise Unreadable("RDATE or several RRULEs")
            rule = parse_rrule(ev.first("RRULE").value)
            ex: set[str] = set()
            for xp in ev.all("EXDATE"):
                for v in xp.value.split(","):
                    ex.add(_key(parse_when(Prop("EXDATE", xp.params, v), default)))
            span = dur.days + 2 if dur > timedelta(0) else 2
            skip_before = start.astimezone(local).date() - timedelta(days=span)
            for inst in expand(s0, rule, window_end_date=window_end_date, default=default,
                               exdates=ex, skip_before=skip_before):
                k = _key(inst)
                if k in ovs:
                    continue                       # replaced by its override below
                add(ev, inst, dur)
        except Unreadable:
            if _maybe_relevant(ev, ev.first("RRULE"), start, end, default, local):
                out.unreadable += 1
            continue
        for ov in ovs.values():
            _add_single(ov, add, out, start, end, default, local)

    # Overrides whose master isn't in the feed: stand-alone events.
    for ovs in overrides.values():
        for ov in ovs.values():
            _add_single(ov, add, out, start, end, default, local)

    out.occurrences.sort(key=lambda o: (not o.all_day, _sort_key(o.start, local), o.summary))
    return out


def _add_single(ev, add, out, start, end, default, local) -> None:
    try:
        p = ev.first("DTSTART")
        if p is None:
            raise Unreadable("no DTSTART")
        s = parse_when(p, default)
        add(ev, s, _end_of(ev, s, default))
    except Unreadable:
        if _maybe_relevant(ev, None, start, end, default, local):
            out.unreadable += 1


def _maybe_relevant(ev: Event, rrule: Prop | None, ws: datetime, we: datetime,
                    default: ZoneInfo, local: ZoneInfo) -> bool:
    """Could this unreadable event fall in the window? Only a clear no
    (it starts after the window, or it ended long before) keeps it out of
    the count, so an old oddity doesn't nag every morning forever."""
    first_day = ws.astimezone(local).date()
    last_day = we.astimezone(local).date()
    p = ev.first("DTSTART")
    try:
        s = parse_when(p, default) if p is not None else None
    except Unreadable:
        s = None
    if s is None:
        # The date part alone is still a fair bound (a zone moves it a day at most).
        m = re.match(r"(\d{8})", p.value.strip()) if p is not None else None
        try:
            s = datetime.strptime(m.group(1), "%Y%m%d").date() if m else None
        except ValueError:
            s = None
        if s is None:
            return True
    sd = s.astimezone(local).date() if isinstance(s, datetime) else s
    if sd > last_day + timedelta(days=1):
        return False
    if rrule is None:
        endp = ev.first("DTEND")
        m = re.match(r"(\d{8})", endp.value.strip()) if endp is not None else None
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y%m%d").date() >= \
                    first_day - timedelta(days=1)
            except ValueError:
                return True
        return sd >= first_day - timedelta(days=31)
    m = re.search(r"UNTIL=(\d{8})", rrule.value.upper())
    if m:
        try:
            if datetime.strptime(m.group(1), "%Y%m%d").date() < first_day - timedelta(days=1):
                return False
        except ValueError:
            return True
    return True


def _sort_key(s, local: ZoneInfo) -> datetime:
    if isinstance(s, datetime):
        return s
    return datetime.combine(s, time(0), tzinfo=local)
