"""Changing an event's text on iCloud, one thing at a time, keeping everything else.

Pure text to text, no network. Whatever an app wrote stays as it was: alarms, notes, its own
X- lines, the days already taken off. That's the lesson of Nov 5, 2026: an app that rewrites a
series can drop its single-day deletions, so nothing here rewrites what it wasn't asked to
change.

Refuses an event with an attendee (`Cant`): changing one can send someone a message, which only
he may do. An organizer alone has no one to message.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import ical

_FOLD = 75
_PEOPLE = frozenset({"ATTENDEE"})
_NOT_COPIED = frozenset({"RRULE", "RDATE", "EXDATE", "DTSTART", "DTEND", "DURATION"})


class Cant(ValueError):
    """Words for him: this event can't take this change."""


def _unfold(ics: str) -> list[str]:
    return ical.unfold(ics)


def _fold(line: str) -> str:
    if len(line.encode("utf-8")) <= _FOLD:
        return line
    parts, cur, used = [], "", 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        if used + n > _FOLD:
            parts.append(cur)
            cur, used = " ", 1
        cur += ch
        used += n
    parts.append(cur)
    return "\r\n".join(parts)


def _join(lines: list[str]) -> str:
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


def _name(line: str) -> str:
    return re.split(r"[;:]", line, maxsplit=1)[0].upper()


def _blocks(lines: list[str]) -> list[tuple[int, int]]:
    """Where each top-level VEVENT sits: (its BEGIN, its END). An alarm inside stays inside."""
    out, begin = [], None
    for i, line in enumerate(lines):
        up = line.strip().upper()
        if up == "BEGIN:VEVENT":
            begin = i
        elif up == "END:VEVENT" and begin is not None:
            out.append((begin, i))
            begin = None
    return out


def _find(lines: list[str], at: tuple[int, int], name: str) -> int | None:
    """Only the event's own lines, not an alarm's."""
    depth = 0
    for i in range(at[0] + 1, at[1]):
        up = lines[i].strip().upper()
        if up.startswith("BEGIN:"):
            depth += 1
        elif up.startswith("END:"):
            depth -= 1
        elif depth == 0 and _name(lines[i]) == name:
            return i
    return None


def _prop(line: str) -> ical.Prop:
    prop = ical.parse_line(line)
    if prop is None:
        raise Cant("I couldn't read that event")
    return prop


def _master(lines: list[str]) -> tuple[int, int] | None:
    for at in _blocks(lines):
        if _find(lines, at, "RECURRENCE-ID") is None:
            return at
    return None


def _start_prop(lines: list[str], at: tuple[int, int]) -> ical.Prop:
    i = _find(lines, at, "DTSTART")
    if i is None:
        raise Cant("I couldn't read that event's start")
    return _prop(lines[i])


def people(ics: str) -> bool:
    lines = _unfold(ics)
    return any(_name(lines[i]) in _PEOPLE for at in _blocks(lines) for i in range(at[0], at[1]))


def is_series(ics: str) -> bool:
    lines = _unfold(ics)
    at = _master(lines)
    return at is not None and _find(lines, at, "RRULE") is not None


def _check(ics: str) -> list[str]:
    if people(ics):
        raise Cant("it has invitees, and changing it could message them")
    return _unfold(ics)


def _like(prop: ical.Prop, name: str, when: datetime | date, default: ZoneInfo) -> str:
    """A date or time written the way this event writes its start."""
    if not isinstance(when, datetime):
        return f"{name};VALUE=DATE:{when:%Y%m%d}"
    tzid = prop.params.get("TZID")
    if tzid:
        local = when.astimezone(ical._zone(tzid, default))
        return f'{name};TZID={tzid}:{local:%Y%m%dT%H%M%S}'
    if prop.value.strip().endswith("Z") or prop.params.get("VALUE", "").upper() == "DATE":
        return f"{name}:{when.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
    return f"{name}:{when.astimezone(default):%Y%m%dT%H%M%S}"


def _from_key(key: str) -> datetime | date:
    if "T" in key:
        return datetime.strptime(key, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    return datetime.strptime(key, "%Y%m%d").date()


def _override_key(lines: list[str], at: tuple[int, int], default: ZoneInfo) -> str | None:
    i = _find(lines, at, "RECURRENCE-ID")
    if i is None:
        return None
    return ical._key(ical.parse_when(_prop(lines[i]), default))


def _touch(lines: list[str], at: tuple[int, int], now: datetime) -> None:
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for name in ("DTSTAMP", "LAST-MODIFIED"):
        i = _find(lines, at, name)
        if i is not None:
            lines[i] = f"{name}:{stamp}"
    i = _find(lines, at, "SEQUENCE")
    if i is not None:
        try:
            lines[i] = f"SEQUENCE:{int(_prop(lines[i]).value) + 1}"
        except ValueError:
            pass


def remove_days(ics: str, keys: list[str], tz: str, now: datetime) -> str:
    """These days of a series come off. Every other day, and each one taken off before, stays."""
    lines, default = _check(ics), ZoneInfo(tz)
    at = _master(lines)
    if at is None or _find(lines, at, "RRULE") is None:
        raise Cant("that isn't a repeating event")
    gone = set(keys)
    for block in reversed(_blocks(lines)):             # a moved day goes with its day
        if _override_key(lines, block, default) in gone:
            del lines[block[0]:block[1] + 1]
    at = _master(lines)
    start = _start_prop(lines, at)
    new = [_like(start, "EXDATE", _from_key(k), default) for k in sorted(gone)]
    i = _find(lines, at, "RRULE")
    lines[i + 1:i + 1] = new
    _touch(lines, _master(lines), now)
    return _join(lines)


def rule_days(rule: str, first: date) -> set[int]:
    """The days of the week a rule falls on. Also for a Google series."""
    parts = dict(p.split("=", 1) for p in rule.upper().split(";") if "=" in p)
    if parts.get("BYDAY"):
        return {ical.WEEKDAYS[x.strip()[-2:]] for x in parts["BYDAY"].split(",")}
    return set(range(7)) if parts.get("FREQ") == "DAILY" else {first.weekday()}


def series_facts(ics: str, tz: str) -> tuple[date, set[int]]:
    """When a series starts, and the days of the week it's on."""
    lines, default = _unfold(ics), ZoneInfo(tz)
    at = _master(lines)
    i = None if at is None else _find(lines, at, "RRULE")
    if i is None:
        raise Cant("that isn't a repeating event")
    start = ical.parse_when(_start_prop(lines, at), default)
    first = start.astimezone(default).date() if isinstance(start, datetime) else start
    return first, rule_days(lines[i].partition(":")[2], first)


def until_line(rule: str, day: date, *, all_day: bool, zone: ZoneInfo,
               floating: bool = False) -> tuple[str, bool]:
    """The rule, last happening before `day`, and whether that changes when it ends. Also for
    a Google series, which keeps the same rule text. UNTIL takes the form its start has: a date,
    local for a time with no zone, UTC otherwise."""
    before = day - timedelta(days=1)
    midnight = datetime(day.year, day.month, day.day, tzinfo=zone)
    if all_day:
        cut = f"{before:%Y%m%d}"
    elif floating:
        cut = f"{before:%Y%m%d}T235959"
    else:
        cut = (midnight - timedelta(seconds=1)).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    parts = [p for p in rule.split(";") if p]
    held = [p for p in parts if p.upper().startswith("UNTIL=")]
    if held:
        value = held[0].split("=", 1)[1].upper()
        if "T" in value and value.endswith("Z") and not all_day and not floating:
            over = value <= cut
        else:                                          # forms differ, so by the day
            over = value[:8] <= f"{before:%Y%m%d}"
        if over:
            return rule, False                         # already over by then
    keep = [p for p in parts if not p.upper().startswith(("UNTIL=", "COUNT="))]
    return ";".join(keep + [f"UNTIL={cut}"]), True


def end_from(ics: str, day: date, tz: str, now: datetime) -> str | None:
    """A series stops happening from this day on. None when that leaves no day at all, so
    it's the whole event that goes. Days already taken off stay off."""
    lines, default = _check(ics), ZoneInfo(tz)
    at = _master(lines)
    if at is None or _find(lines, at, "RRULE") is None:
        raise Cant("that isn't a repeating event")
    start = ical.parse_when(_start_prop(lines, at), default)
    first = start.astimezone(default).date() if isinstance(start, datetime) else start
    if first >= day:
        return None
    i = _find(lines, at, "RRULE")
    head, _, value = lines[i].partition(":")
    written = _start_prop(lines, at)
    rule, changed = until_line(value, day, all_day=not isinstance(start, datetime), zone=default,
                               floating=not written.params.get("TZID") and not written.value.strip().endswith("Z"))
    if not changed:
        raise Cant("that series already ends by then")
    lines[i] = f"{head}:{rule}"
    for block in reversed(_blocks(lines)):             # a moved day stands or goes by when it happens
        if _override_key(lines, block, default) is None:
            continue
        when = ical.parse_when(_start_prop(lines, block), default)
        moved = when.astimezone(default).date() if isinstance(when, datetime) else when
        if moved >= day:
            del lines[block[0]:block[1] + 1]
    _touch(lines, _master(lines), now)
    return _join(lines)


def ends_by(ics: str, day: date, tz: str) -> bool:
    """Nothing of this series happens on or after `day`, by its own rule: its UNTIL or COUNT, its
    days taken off, any extra days, and every moved day. A rule with neither UNTIL nor COUNT goes
    on. Raises ical.Unreadable or Cant when the event can't be read that far."""
    lines, default = _unfold(ics), ZoneInfo(tz)
    at = _master(lines)
    if at is None:
        raise Cant("I couldn't read that event")
    start = ical.parse_when(_start_prop(lines, at), default)

    def on(when) -> date:
        return when.astimezone(default).date() if isinstance(when, datetime) else when
    for block in _blocks(lines):                       # a moved day, wherever it moved
        if _override_key(lines, block, default) is not None \
                and on(ical.parse_when(_start_prop(lines, block), default)) >= day:
            return False
    i = _find(lines, at, "RRULE")
    if i is None:
        return on(start) < day
    rule = ical.parse_rrule(lines[i].partition(":")[2])
    if not rule.get("UNTIL") and not rule.get("COUNT"):
        return False
    gone: set[str] = set()
    for j in range(at[0] + 1, at[1]):
        name = _name(lines[j])
        if name not in ("RDATE", "EXDATE"):
            continue
        prop = _prop(lines[j])
        for value in prop.value.split(","):
            when = ical.parse_when(ical.Prop(name, prop.params, value), default)
            if name == "RDATE":
                if on(when) >= day:
                    return False
            else:
                gone.add(ical._key(when))
    for inst in ical.expand(start, rule, window_end_date=day + timedelta(days=366 * 50), default=default,
                            exdates=gone, skip_before=day - timedelta(days=1)):
        if on(inst) >= day:
            return False
    return True


def _set_times(lines: list[str], at: tuple[int, int], start: datetime, end: datetime,
               like: ical.Prop, default: ZoneInfo) -> None:
    i = _find(lines, at, "DURATION")
    if i is not None:
        del lines[i]
        at = (at[0], at[1] - 1)
    i = _find(lines, at, "DTEND")
    if i is not None:
        lines[i] = _like(like, "DTEND", end, default)
    else:
        lines.insert(at[0] + 1, _like(like, "DTEND", end, default))
        at = (at[0], at[1] + 1)
    lines[_find(lines, at, "DTSTART")] = _like(like, "DTSTART", start, default)


def move_one(ics: str, start: datetime, end: datetime, tz: str, now: datetime) -> str:
    """A one-off event, to new times."""
    lines, default = _check(ics), ZoneInfo(tz)
    at = _master(lines)
    if at is None or _find(lines, at, "RRULE") is not None:
        raise Cant("that's a repeating event")
    _set_times(lines, at, start, end, _start_prop(lines, at), default)
    _touch(lines, _master(lines), now)
    return _join(lines)


def move_day(ics: str, key: str, start: datetime, end: datetime, tz: str, now: datetime) -> str:
    """One day of a series, to new times. The rest of the series doesn't move."""
    lines, default = _check(ics), ZoneInfo(tz)
    at = _master(lines)
    if at is None or _find(lines, at, "RRULE") is None:
        raise Cant("that isn't a repeating event")
    like = _start_prop(lines, at)
    for block in _blocks(lines):
        if _override_key(lines, block, default) == key:
            _set_times(lines, block, start, end, like, default)
            return _join(lines)
    copied, depth = [], 0
    for line in lines[at[0] + 1:at[1]]:
        up = line.strip().upper()
        depth += up.startswith("BEGIN:")
        keep = depth > 0 or _name(line) not in _NOT_COPIED
        depth -= up.startswith("END:")
        if keep:
            copied.append(line)
    new = ["BEGIN:VEVENT", _like(like, "RECURRENCE-ID", _from_key(key), default),
           _like(like, "DTSTART", start, default), _like(like, "DTEND", end, default),
           *copied, "END:VEVENT"]
    lines[at[1] + 1:at[1] + 1] = new
    _touch(lines, _master(lines), now)
    return _join(lines)


# -- something new ------------------------------------------------------------------------

def _esc(text: str) -> str:
    return (str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\n", "\\n"))


def _changes_in(year: int, zone: ZoneInfo) -> list[tuple[datetime, timedelta, timedelta]]:
    """The clock changes in a year, by the hour: (local time just after, before, after)."""
    out = []
    at = datetime(year, 1, 1, tzinfo=timezone.utc)
    last = at.astimezone(zone).utcoffset()
    for _ in range(366 * 24):
        at += timedelta(hours=1)
        now = at.astimezone(zone).utcoffset()
        if now != last:
            out.append((at.astimezone(zone), last, now))
            last = now
    return out


def _offset(delta: timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    sign = "-" if minutes < 0 else "+"
    return f"{sign}{abs(minutes) // 60:02d}{abs(minutes) % 60:02d}"


def _in_month(month: int, day: int) -> bool:
    try:
        date(1970, month, day)
    except ValueError:
        return False
    return True


def vtimezone(tz: str, year: int) -> list[str]:
    """iCloud wants a series's zone spelled out, and the standard library has no such text,
    so it's worked out from when the clocks change. A zone that doesn't change is one line."""
    zone = ZoneInfo(tz)
    lines = ["BEGIN:VTIMEZONE", f"TZID:{tz}"]
    changes = _changes_in(year, zone)
    if not changes:
        off = _offset(datetime(year, 1, 1, tzinfo=zone).utcoffset())
        return lines + ["BEGIN:STANDARD", "DTSTART:19700101T000000", f"TZOFFSETFROM:{off}",
                        f"TZOFFSETTO:{off}", "END:STANDARD", "END:VTIMEZONE"]
    for when, before, after in changes:
        kind = "DAYLIGHT" if after > before else "STANDARD"
        nth = (when.day - 1) // 7 + 1
        last = when + timedelta(days=7)
        ordinal = "-1" if last.month != when.month else str(nth)
        wd = list(ical.WEEKDAYS)[when.weekday()]
        same = [date(1970, when.month, d) for d in range(1, 32) if _in_month(when.month, d)
                and date(1970, when.month, d).weekday() == when.weekday()]
        base = same[-1] if ordinal == "-1" else same[nth - 1]     # its start has to fit its rule
        lines += [f"BEGIN:{kind}", f"DTSTART:{base:%Y%m%d}T{(when - (after - before)).hour:02d}0000",
                  f"RRULE:FREQ=YEARLY;BYMONTH={when.month};BYDAY={ordinal}{wd}",
                  f"TZOFFSETFROM:{_offset(before)}", f"TZOFFSETTO:{_offset(after)}", f"END:{kind}"]
    return lines + ["END:VTIMEZONE"]


def build(uid: str, title: str, start: datetime | date, end: datetime | date, location: str,
          rule: str, tz: str, now: datetime) -> str:
    """An ordinary event, as a person would have made it: it carries no mark of ours, so Family's
    rules treat it as they treat anything else on the calendar. A series keeps its clock time
    through a clock change, so it's written in his zone."""
    head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//harness//calendar_change//EN"]
    event = ["BEGIN:VEVENT", f"UID:{uid}",
             f"DTSTAMP:{now.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"]
    if not isinstance(start, datetime):
        event += [f"DTSTART;VALUE=DATE:{start:%Y%m%d}", f"DTEND;VALUE=DATE:{end:%Y%m%d}"]
    elif rule:
        zone = ZoneInfo(tz)
        head += vtimezone(tz, start.year)
        event += [f"DTSTART;TZID={tz}:{start.astimezone(zone):%Y%m%dT%H%M%S}",
                  f"DTEND;TZID={tz}:{end.astimezone(zone):%Y%m%dT%H%M%S}"]
    else:
        event += [f"DTSTART:{start.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}",
                  f"DTEND:{end.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"]
    if rule:
        event.append(f"RRULE:{rule}")
    event.append(f"SUMMARY:{_esc(title)}")
    if location:
        event.append(f"LOCATION:{_esc(location)}")
    return _join(head + event + ["END:VEVENT", "END:VCALENDAR"])
