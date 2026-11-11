"""Rendering: the controller decides every character he can tap.

Model text is shown escaped and with its links defanged, so a model --
or an email it summarized -- can never put a clickable link, a button or
a destination in front of him. Links he can tap (re-consent, an event he
just approved) are built here from canonical fields. Cards for proposals
are rendered from the canonical parameters and the effect definition,
never from the model's own description of what it wants to do.

Messages are written in simple HTML (<b>, <i>); only &, < and > need escaping.
discord_chat.to_markdown turns them into Discord markdown.
"""
from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

from . import approvals
from .effects import EffectDef

MESSAGE_LIMIT = 4096

# Anything a chat client may turn into something he can tap, in model text:
#   scheme URLs with any host -- names, IP literals, internationalized
#   names -- including tg:// links;
#   bare domains, with Unicode-aware labels and letter-only TLDs;
#   bare IPv4 addresses;
#   /commands (tapping one sends it from his account) and @mentions.
_SCHEME = re.compile(r"(?i)\b(?:https?|ftp|tg)://([^\s/<>\"'?#]+)([^\s<>\"']*)")
_BARE = re.compile(r"(?<![\w.\[])((?:[^\W_][\w-]*\.)+[^\W\d_]{2,})\b(/[^\s<>\"']*)?")
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_WIDE_DOTS = re.compile("[。．｡]")
_HOST_SHAPED = re.compile(r"(?i)\bmailto:|\bwww\.\S|\bxn--"
                          r"|[\w.+-]+@[^\W_][\w-]*\.[^\W\d_]{2,}"
                          r"|(?:[^\W_][\w-]*\.)+[^\W\d_]{2,}(?::\d|\?\S)")
# For deciding what may go on a calendar. Wider than _BARE, which is tuned for defang:
# no lookbehind or trailing \b, so [evil.com/x], .evil.com and evil.com_ all count.
_ANY_SCHEME = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://")
_ANY_HOST = re.compile(r"((?:[^\W_][\w-]*\.)+[^\W\d_]{2,})(/\S*)?")
_TIGHT_COLON = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*:[^\s\d]")
_PHONE = re.compile(r"\+?\d[\d ().-]{6,}\d")
_COMMAND = re.compile(r"(?<![\w/])/([A-Za-z0-9_]{1,32})")
_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{3,32})")
WORD_JOINER = "\u2060"     # invisible; breaks command and mention detection


def escape(text: str) -> str:
    return html.escape(text, quote=False)


def _allowed(host: str, allowed: tuple[str, ...]) -> bool:
    h = host.lower().split("@")[-1].split(":")[0]
    return any(h == d or h.endswith("." + d) for d in allowed)


def defang(text: str, allowlist: tuple[str, ...] = ()) -> str:
    """Make every link, bare domain, IP, /command and @mention in model text
    untappable unless its domain is on the allowlist:
    `https://evil.example/x` -> `evil[.]example/x`, `/cancel` -> `/\u2060cancel`."""
    allowed = tuple(d.lower().lstrip(".") for d in allowlist)

    def scheme(m: re.Match) -> str:
        if _allowed(m.group(1), allowed):
            return m.group(0)
        return m.group(1).replace(".", "[.]") + m.group(2)

    def bare(m: re.Match) -> str:
        if _allowed(m.group(1), allowed):
            return m.group(0)
        return m.group(1).replace(".", "[.]") + (m.group(2) or "")

    text = _SCHEME.sub(scheme, text)
    text = _BARE.sub(bare, text)
    text = _IPV4.sub(lambda m: m.group(0).replace(".", "[.]"), text)
    text = _COMMAND.sub(lambda m: "/" + WORD_JOINER + m.group(1), text)
    text = _MENTION.sub(lambda m: "@" + WORD_JOINER + m.group(1), text)
    return text


def model_text(text: str, allowlist: tuple[str, ...] = ()) -> str:
    return escape(defang(text, allowlist))


def units(text: str) -> int:
    """Length in UTF-16 code units. Measuring the
    HTML source this way over-counts, never under-counts."""
    return len(text.encode("utf-16-le")) // 2


def fit(text: str, footer: str = "") -> str:
    """Never exceed the message limit; say so when cut. Never cuts inside
    an HTML entity or tag."""
    room = MESSAGE_LIMIT - units(footer)
    if units(text) <= room:
        return text + footer
    marker = "\n… (cut to fit)"
    budget = room - units(marker)
    limit = budget
    while limit > 0:
        closed = _close_tags(_cut(text, limit))
        over = units(closed) - budget
        if over <= 0:                  # the closing tags fit too
            return closed + marker + footer
        limit -= over
    return marker.lstrip() + footer


def _cut(text: str, limit: int) -> str:
    out, used = [], 0
    for ch in text:
        u = units(ch)
        if used + u > limit:
            break
        out.append(ch)
        used += u
    cut = "".join(out)
    # don't leave half an entity (&am) or half a tag (<i) behind
    amp, semi = cut.rfind("&"), cut.rfind(";")
    if amp > semi:
        cut = cut[:amp]
    lt, gt = cut.rfind("<"), cut.rfind(">")
    if lt > gt:
        cut = cut[:lt]
    return cut


_TAG = re.compile(r"<(/?)([a-z]+)[^>]*>")


def _close_tags(text: str) -> str:
    """Close any tag the cut left open, so it still parses."""
    stack: list[str] = []
    for m in _TAG.finditer(text):
        closing, name = m.group(1), m.group(2)
        if closing:
            if stack and stack[-1] == name:
                stack.pop()
        else:
            stack.append(name)
    return text + "".join(f"</{n}>" for n in reversed(stack))


def plain(text: str) -> str:
    """What he saw, without the markup: for showing an earlier exchange
    back to a model as context."""
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def short(job_id: str) -> str:
    """A job's short id, for the log. Never in what he sees (Nov 11: "gobbledegook")."""
    return job_id.split("-", 1)[0]


def answer(job_id: str, text: str, *, rules_fired: tuple[str, ...] = (),
           allowlist: tuple[str, ...] = ()) -> str:
    """Model text for him. The job id stays in the ledger and the log, not on the message."""
    footer = ""
    if rules_fired:
        footer = "\n\n<i>rules " + ", ".join(escape(r) for r in rules_fired) + "</i>"
    return fit(model_text(text, allowlist), footer)


# -- dates and times as he reads them ------------------------------------------------------
# Nov 11: cards showed "2026-11-11T11:30:00-05:00". What he wants instead: "Move PT to 11:30
# to 12:30 today", "Take off today's 8:00 drop-off". A daytime hour needs no AM or PM; an
# early or late one gets it, so 7:00 PM is never read as the morning.

def no_dashes(text: str) -> str:
    """An em or en dash in a calendar's title reads as a hyphen in his messages."""
    return re.sub(r"\s*[—–]\s*", " - ", text)


def _daytime(t: datetime) -> bool:
    return 7 <= t.hour < 19


def clock_words(t: datetime, *, suffix: bool | None = None) -> str:
    """11:30, 8:00, 7:00 PM. A local time."""
    words = f"{t.hour % 12 or 12}:{t.minute:02d}"
    if suffix is None:
        suffix = not _daytime(t)
    return words + (f" {'AM' if t.hour < 12 else 'PM'}" if suffix else "")


def span_words(start: datetime, end: datetime) -> str:
    """11:30 to 12:30; 6:00 PM to 7:00 PM. Local times on one day."""
    suffix = not (_daytime(start) and _daytime(end))
    return f"{clock_words(start, suffix=suffix)} to {clock_words(end, suffix=suffix)}"


def date_words(day, today) -> str:
    """Fri Nov 20, with the year when it isn't this year's."""
    year = f", {day.year}" if day.year != today.year else ""
    return f"{day:%a} {day:%b} {day.day}{year}"


def day_words(day, today) -> str:
    """today, tomorrow, Friday (in the next week), or on Fri Nov 20."""
    gap = (day - today).days
    if gap == 0:
        return "today"
    if gap == 1:
        return "tomorrow"
    if gap == -1:
        return "yesterday"
    if 1 < gap < 7:
        return f"{day:%A}"
    return "on " + date_words(day, today)


def day_owner(day, today) -> str | None:
    """today's, tomorrow's, Friday's; None for a date further off, which reads better after."""
    words = day_words(day, today)
    return None if words.startswith("on ") else words + "'s"


def _when(start_iso: str, minutes: int, tz: str) -> str:
    start = datetime.fromisoformat(start_iso).astimezone(ZoneInfo(tz))
    end_minutes = start.hour * 60 + start.minute + minutes
    end_h, end_m = divmod(end_minutes % (24 * 60), 60)
    day = start.strftime("%a %b %-d")
    begin = start.strftime("%-I:%M %p")
    endt = datetime(2000, 1, 1, end_h, end_m).strftime("%-I:%M %p")
    zone = start.strftime("%Z")
    return f"{day}, {begin}–{endt} {zone} ({minutes} min)"


def _clock(dt: datetime) -> str:
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def _day(dt: datetime) -> str:
    return f"{dt:%a %b} {dt.day}, {dt.year}"


def family_when(start_iso: str, end_iso: str, tz: str) -> str:
    """In his local zone, with the weekday and the date, however the model
    wrote the offset: a wrong offset shows as a wrong time, in time to decline."""
    local = ZoneInfo(tz)
    s = datetime.fromisoformat(start_iso).astimezone(local)
    e = datetime.fromisoformat(end_iso).astimezone(local)
    if s.date() != e.date():
        return f"{_day(s)}, {_clock(s)} {s:%Z} to {_day(e)}, {_clock(e)} {e:%Z}"
    zone = f"{e:%Z}" if s.utcoffset() == e.utcoffset() else f"{s:%Z} to {e:%Z}"
    return f"{_day(s)}, {_clock(s)} to {_clock(e)} {zone}"


# A bare word.word is a link only with a suffix like these: Dr.Smith is a name.
LINK_SUFFIXES = frozenset("""
    com net org edu gov mil int info biz name pro mobi app dev ai io co me tv cc ws fm am gg ly gl
    to sh so xyz online site website shop store link click top club live life world news blog
    cloud page zip mov tech art fun icu vip win work bid loan
    uk us ca au nz ie de fr es it nl be at ch se no dk fi pl pt cz gr hu ro ru ua tr il in cn jp
    kr tw hk sg id my th vn ph br mx ar cl eu su рф
    example test
""".split())


def _plain_dots(text: str) -> str:
    return _WIDE_DOTS.sub(".", unicodedata.normalize("NFKC", text))


def has_link(text: str) -> bool:
    """A URL with any scheme, an IP address, a host with a path, port, query or mailbox,
    www., or a known suffix."""
    text = _plain_dots(text)
    if _ANY_SCHEME.search(text) or _IPV4.search(text) or _HOST_SHAPED.search(text):
        return True
    return any(m.group(2) or m.group(1).rsplit(".", 1)[-1].casefold() in LINK_SUFFIXES
               for m in _ANY_HOST.finditer(text))


def maybe_host(text: str) -> bool:
    """Any bare word.word, word:word or phone number. Dr.Smith is a name and evil.lol is
    not, and the suffix list can't tell them all apart, so his eyes do: this always gets
    a card."""
    text = _plain_dots(text)
    return bool(_ANY_HOST.search(text) or _TIGHT_COLON.search(text) or _PHONE.search(text))


def family_text(text: str) -> str:
    """Exact text, escaped, with /commands and @mentions made inert by a joiner he
    can't see. Text with a link never gets here: family_add refuses it first."""
    text = _COMMAND.sub(lambda m: "/" + WORD_JOINER + m.group(1), text)
    return escape(_MENTION.sub(lambda m: "@" + WORD_JOINER + m.group(1), text))


def family_event_text(params: dict, tz: str) -> str:
    """The event, from canonical params. Title and location are model text."""
    lines = [family_text(params["title"]), escape(family_when(params["start"], params["end"], tz))]
    if params.get("location"):
        lines.append("Where: " + family_text(params["location"]))
    return "\n".join(lines)


def family_card(params: dict, *, tz: str, expires: datetime, job_id: str,
                warnings=()) -> str:
    """No expiry line and no job id: he reads the event, nothing else (Nov 11)."""
    check = [f"\u26a0 <b>Check before approving:</b> {escape(w)}" for w in warnings]
    return fit("\n".join([
        "<b>Add to the Family calendar?</b>",
        family_event_text(params, tz),
        *check,
        "Family calendar only. No invitees, no repeat. It alerts family phones that have "
        "notifications on for this calendar."]))


def change_line(c: dict, tz: str, now: datetime) -> str:
    """One change he asked for, in plain words, for when his calendar couldn't be read to
    say it better (calendar_change.py says it from what it found). Never an ISO stamp."""
    local = ZoneInfo(tz)
    today = now.astimezone(local).date()

    def when(text: str):
        value = datetime.fromisoformat(text)
        return value.astimezone(local) if "T" in text else value.date()

    title = family_text(no_dashes(c["title"]))
    where = f" ({escape(c['calendar'].title())})"
    if c["op"] == "rule":
        # What a Family event's name means for him: no dates, no calendar write.
        from .calendar_change import RULE_WORDS
        meaning = RULE_WORDS.get(c.get("kind", ""), "mean what you said")
        return f"From now on, Family events with {title} in the name {escape(meaning)}"
    days = [datetime.fromisoformat(x).date() for x in c.get("dates", "").split(",") if x]
    named = ", ".join(day_words(d, today) for d in days)
    if c["op"] == "remove":
        owner = day_owner(days[0], today) if len(days) == 1 else None
        return f"Take off {owner} {title}{where}" if owner else f"Take {title} off {named}{where}"
    if c["op"] == "end_series":
        return f"End {title} from {date_words(days[0], today)} on{where}"
    start, end = when(c["start"]), when(c["end"])
    if isinstance(start, datetime):
        if start.date() == end.date():
            at = f"{span_words(start, end)} {day_words(start.date(), today)}"
        else:
            at = (f"{date_words(start.date(), today)}, {clock_words(start, suffix=True)} to "
                  f"{date_words(end.date(), today)}, {clock_words(end, suffix=True)}")
    else:
        at = day_words(start, today) if start == end else \
            f"{date_words(start, today)} through {date_words(end, today)}"
    if c["op"] == "move":
        moved = start.date() if isinstance(start, datetime) else start
        if days and moved != days[0]:
            return f"Move {title} from {named.removeprefix('on ')} to {at}{where}"
        return f"Move {title} to {at}{where}"
    if c["op"] == "add_series":
        return f"Add {title}, repeating, starting {at}{where}"
    return f"Add {title} {at}{where}"


def proposal_card(effect: EffectDef, params: dict, *, tz: str, expires: datetime,
                  job_id: str, warnings=(), lines: list[str] | None = None,
                  now: datetime | None = None) -> str:
    """Rendered from canonical params and the definition, or for a calendar change from
    what plain code found for them (`lines`). The model's own summary is not used here on
    purpose. No expiry line and no job id (Nov 11)."""
    if effect.name == "family_event_add":
        return family_card(params, tz=tz, expires=expires, job_id=job_id, warnings=warnings)
    if effect.name == "calendar_change":
        if lines is None:
            lines = [change_line(c, tz, now or expires) for c in params["changes"]]
        return fit("\n".join([
            "<b>Change your calendar?</b>",
            *[f"\u26a0 <b>Check before approving:</b> {escape(w)}" for w in warnings],
            *lines]))
    if effect.name == "calendar_hold":
        lines = [
            "<b>Hold on your harness calendar</b>",
            escape(_when(params["start"], params["duration_min"], tz)),
            f"Title: {escape(effect.fixed['title'])} \u00b7 no attendees \u00b7 private",
            f"Undo: {escape(effect.undo)}",
        ]
    else:
        lines = [f"<b>{escape(effect.name)}</b>"] + [
            f"{escape(k)}: {escape(str(v))}" for k, v in sorted(params.items())]
    lines.append("Reversible." if effect.reversible
                 else "<b>Not reversible.</b>")
    return fit("\n".join(lines))


def proposal_buttons(nonce: str) -> list[list[tuple[str, str]]]:
    return [[("Approve", approvals.callback_data("approve", nonce)),
             ("Decline", approvals.callback_data("decline", nonce))]]
