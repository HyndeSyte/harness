"""Where a change on a card came from, said on the card (0.24.0).

A change that doesn't rest on his own newest message, sent in the last 2 minutes, with nothing of
Cain's in it, always comes on a card. That card says which message of his it acts on (quoted, on
one line, with its age, and how many he sent after it), what exactly it will do (the operation,
the calendar, the event, the date and the time), and which of those came from Cain's suggestion
and not from his words, marked "from Cain". Plain code, no model: the card can't say what the
model wishes it said.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import render

QUOTE_MAX = 160
FROM_CAIN = " (from Cain)"
NOT_SAID = " (not in your words)"
_OPS = {"add": "Add", "add_series": "Add, repeating", "remove": "Take off", "move": "Move",
        "end_series": "End", "rule": "Keep as a rule"}
_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september",
           "october", "november", "december")
_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_CLOCK = re.compile(r"(?i)\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?|\b(\d{1,2}):([0-5]\d)\b|\bnoon\b")


def one_line(text: str, limit: int = QUOTE_MAX) -> str:
    """His message on one line, trimmed: what he wrote, nothing added but the ellipsis."""
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[:limit - 1].rstrip() + "…"


def age_words(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return "just now"
    if s < 3600:
        n = s // 60
        return f"{n} minute{'s' * (n != 1)} ago"
    n = s // 3600
    return f"{n} hour{'s' * (n != 1)} ago"


def origin_lines(origin: dict, now: datetime) -> list[str]:
    """The message it acts on, quoted, its age, and the messages he sent after it. HTML-safe."""
    out = []
    quote = one_line(origin.get("quote", ""))
    if quote:
        try:
            age = (now - datetime.fromisoformat(origin["sent_at"])).total_seconds()
            when = f" (sent {age_words(age)})"
        except (KeyError, ValueError, TypeError):
            when = ""
        out.append(f"Your message: “{render.escape(quote)}”{when}")
    after = int(origin.get("after") or 0)
    if after:
        out.append(f"You sent {after} message{'s' * (after != 1)} after this.")
    return out


def _when(text: str):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text) if "T" in text else date.fromisoformat(text)
    except ValueError:
        return None


def _day_of(c: dict, tz: ZoneInfo):
    start = _when(c.get("start", ""))
    if isinstance(start, datetime):
        return start.astimezone(tz).date(), start.astimezone(tz)
    if isinstance(start, date):
        return start, None
    first = (c.get("dates") or "").split(",")[0]
    return (_when(first) if first else None), None


def resolution(words: str, day: date, today: date) -> str:
    """The words of his that name that day by a rule with one answer, counted from his own day
    (the day he sent it, in his time zone): "today", "tomorrow", a weekday ("Friday", "this
    Friday": the soonest one, today included), the 13th (the soonest 13th), or the month and day
    ("Nov 13", "11/13"). "" when none does. "next Friday" has no one answer (this coming one, or
    the one after?), so it never counts (0.24.0, third round)."""
    t = " " + words.casefold() + " "
    if day == today and (m := re.search(r"\b(today|tonight|this (?:morning|afternoon|evening))\b", t)):
        return m.group(1)
    if day == today + timedelta(days=1) and re.search(r"\btomorrow\b", t):
        return "tomorrow"
    name = _DAYS[day.weekday()]
    if (day - today).days == (day.weekday() - today.weekday()) % 7:
        for m in re.finditer(rf"\b(next\s+|this\s+)?({name}|{name[:3]})s?\b", t):
            if not (m.group(1) or "").startswith("next"):
                return m.group(0).strip()
    month = _MONTHS[day.month - 1]
    m = re.search(rf"\b({month}|{month[:3]})\.?\s+{day.day}(st|nd|rd|th)?\b", t) \
        or re.search(rf"\b{day.day}(st|nd|rd|th)?\s+(of\s+)?({month}|{month[:3]})\b", t) \
        or re.search(rf"\b{day.month}/{day.day}\b", t)
    if m:
        return m.group(0).strip()
    m = re.search(rf"\b(?:the\s+)?{day.day}(st|nd|rd|th)\b", t)
    if m and _soonest_dom(today, day.day) == day:
        return m.group(0).strip()
    return ""


def _soonest_dom(today: date, dom: int) -> date | None:
    """The soonest day on or after today that is that day of a month."""
    y, mo = today.year, today.month
    for _ in range(13):
        try:
            d = date(y, mo, dom)
        except ValueError:
            d = None
        if d is not None and d >= today:
            return d
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return None


def ambiguous(words: str) -> str:
    """A day of his words with more than one answer ("next Friday"), or ""."""
    m = re.search(r"\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b",
                  words.casefold())
    return m.group(0) if m else ""


def date_in(words: str, day: date, today: date) -> bool:
    """He named that day himself, by a rule with one answer (resolution)."""
    return bool(resolution(words, day, today))


def resolutions(changes: list[dict], his: str, tz: str, sent: datetime) -> list[str]:
    """For a receipt: each day his own words named by a relative word, and the date it was read
    as: “Friday” as Fri Nov 13 (his own day, "today", goes without saying). Plain text."""
    zone = ZoneInfo(tz)
    today = sent.astimezone(zone).date()
    out = []
    for c in changes:
        day, _ = _day_of(c, zone)
        if day is None:
            continue
        phrase = resolution(his, day, today)
        if day != today and phrase and not re.search(r"\d", phrase):
            out.append(f"\u201c{phrase}\u201d as {day:%a %b} {day.day}")
    return list(dict.fromkeys(out))


def time_in(words: str, at: datetime) -> bool:
    """He gave that clock time himself: 8:00, 8am, 8:30 pm, noon."""
    for m in _CLOCK.finditer(words):
        if m.group(0).casefold() == "noon":
            hour, minute, half = 12, 0, "p"
        elif m.group(1):
            hour, minute, half = int(m.group(1)), int(m.group(2) or 0), m.group(3).casefold()
        else:
            hour, minute, half = int(m.group(4)), int(m.group(5)), ""
        hours = {hour % 12 + (12 if half == "p" else 0)} if half else {hour % 12, hour % 12 + 12}
        if at.hour in hours and at.minute == minute:
            return True
    return False


def _calendar_in(words: str, calendar: str) -> bool:
    t = words.casefold()
    if calendar == "family":
        return "family" in t
    return bool(re.search(r"\b(gmail|my calendar|my own calendar|work)\b", t))


def _title_in(words: str, title: str) -> bool:
    from .calendar_change import title_words
    return bool(title_words(title) & title_words(words))


def detail_line(c: dict, his: str, cain: str, tz: str, now: datetime,
                sent: datetime | None = None) -> tuple[str, bool]:
    """The change, field by field, with any field Cain supplied and he didn't marked "from Cain":
    (the line, HTML-safe; whether any field is Cain's or not his). A day is counted from the day he
    sent his message, in his time zone (`sent`), so "tomorrow" sent at 11:58 PM is the next day
    even when it's read after midnight; the day his words resolve to is shown with them, and a day
    his words leave open ("next Friday") is marked as not in his words, Cain or not (0.24.0)."""
    zone = ZoneInfo(tz)
    today = (sent or now).astimezone(zone).date()
    marks = []

    def mark(in_his: bool, in_cain: bool, needed: bool = False, forced: bool = False) -> str:
        """From Cain: in his suggestion and not in his words. A date or time in neither is said
        too: it has to come from somewhere, and it isn't from him."""
        if in_his or not (cain or forced) or not (in_cain or needed):
            return ""
        marks.append(1)
        return FROM_CAIN if in_cain else NOT_SAID

    title = render.family_text(render.no_dashes(c.get("title", "")))
    cal = "Family" if c.get("calendar") == "family" else "Gmail"
    op = c.get("op", "")
    # A removal, move or end is found by plain code on both calendars: the line under this names the
    # event where it is, so the calendar the model named isn't shown as if it were the one.
    found = op in ("remove", "move", "end_series")
    fields = [(_OPS.get(op, "Change") if found else f"{_OPS.get(op, 'Change')} on {cal}"
               + mark(_calendar_in(his, c.get("calendar", "")), _calendar_in(cain, c.get("calendar", "")))),
              f"event {title}" + mark(_title_in(his, c.get("title", "")), _title_in(cain, c.get("title", "")))]
    day, at = _day_of(c, zone)
    if day is not None:
        phrase = resolution(his, day, today)
        shown = f" (your \u201c{render.escape(phrase)}\u201d)" if phrase and not re.search(r"\d", phrase) else ""
        fields.append(f"date {day:%a %b} {day.day}{shown}"
                      + mark(bool(phrase), date_in(cain, day, today), True, forced=bool(ambiguous(his))))
    if at is not None:
        fields.append(f"time {render.clock_words(at, suffix=True)}"
                      + mark(time_in(his, at), time_in(cain, at), True))
    return "Exactly: " + "; ".join(fields), bool(marks)
