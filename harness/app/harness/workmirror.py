"""Work-hours mirror: which personal blocks his work calendar should see.

He keeps personal and work calendars apart, but during work hours his
work calendar has to show when he is busy (an appointment, an errand,
watching the kids). Each conflicting personal block is put in front of his work address as a PRIVATE invite, so
coworkers see "busy" and nothing else.

This module only decides. It is plain code, no model, so running it often
costs nothing but a calendar read.

Cadence (revised 2026-10-08, after he pointed out that a Friday plan for
next week leaves a blind spot of up to a week):
- A rolling window, `horizon_days` ahead (default 14), recomputed after
  every calendar read (every 30 minutes).
- The live copies on the work side are read back and compared with the
  plan (`reconcile`). No difference, no card.
- A difference that touches the next `soon_hours` (default 48) goes out at
  once, because a coworker could book over it today. Anything later waits
  for the morning digest, folded into one card, so he taps at most once a
  day for routine changes.
- Every card is bound to its exact operations (`Delta.digest`); a card
  that went stale because the calendar changed again is refused and
  replaced by the current one (invariant 3).

The first run after it is switched on is just a reconcile against an
empty work side: one card with everything in the window.

Shape of the write (fixed in effects.py, not here, never by a model): a
copy of the block on the calendar the harness created, visibility private,
one attendee: his configured work address. His own events are never
edited, so the harness needs only the narrow app-created scope, and undo
is deleting its own copy.

Extensible by config, not code: work days and hours, horizon and how soon
is "soon", which personal calendars count, titles to skip, per-pattern
rules for Family events, and whether copies carry titles. Defaults are
empty and off: this repository is public and holds no personal data, so
his values are entered at install.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

TITLE_MAX = 200
VISIBILITY = "private"          # not configurable: the whole point


class MirrorConfigError(ValueError):
    pass


@dataclass(frozen=True)
class FamilyRule:
    """A Family event is his only if a rule matches its whole title.

    `title` is the work copy's title; `{1}`, `{2}`... are the pattern's
    groups, `{0}` the whole title.
    """
    pattern: str
    title: str = "{0}"

    def __post_init__(self):
        try:
            re.compile(self.pattern)
        except re.error as exc:
            raise MirrorConfigError(f"family rule {self.pattern!r}: {exc}") from exc


@dataclass(frozen=True)
class MirrorConfig:
    enabled: bool = False
    work_address: str = ""
    timezone: str = "America/New_York"
    workdays: tuple[int, ...] = (0, 1, 2, 3, 4)        # Monday = 0
    day_start: str = "08:00"
    day_end: str = "18:00"
    # How far ahead the work side is kept true, and what counts as soon
    # enough to send a card right away instead of in the morning digest.
    horizon_days: int = 14
    soon_hours: int = 48
    # A "soon" card waits out the night unless a block in it starts first,
    # and waits `settle_minutes` after a change first appears so a burst of
    # edits makes one card, not several (unless a block starts within 2 h).
    quiet_start: str = "21:00"
    quiet_end: str = "07:00"
    settle_minutes: int = 10
    # Google calendars whose events count. Empty: his primary only.
    google_calendars: tuple[str, ...] = ()
    # Whole-title patterns never mirrored, from any calendar.
    skip_titles: tuple[str, ...] = ()
    family_rules: tuple[FamilyRule, ...] = ()
    # "busy": every work copy is titled "Busy" (the default: the invite
    # email and his work-side copy carry the title, and the work side is
    # the employer's system). "as_is": the source or rule title.
    title_mode: str = "busy"

    def __post_init__(self):
        if self.enabled and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}", self.work_address):
            raise MirrorConfigError("work_address must be one email address")
        if not self.workdays or any(d not in range(7) for d in self.workdays):
            raise MirrorConfigError("workdays must be 0-6, Monday = 0")
        if _hhmm(self.day_start) >= _hhmm(self.day_end):
            raise MirrorConfigError("day_start must be before day_end")
        if not 1 <= self.horizon_days <= 60:
            raise MirrorConfigError("horizon_days must be 1-60")
        if not 0 <= self.soon_hours <= self.horizon_days * 24:
            raise MirrorConfigError("soon_hours must be 0 to the horizon")
        _hhmm(self.quiet_start), _hhmm(self.quiet_end)
        if not 0 <= self.settle_minutes <= 120:
            raise MirrorConfigError("settle_minutes must be 0-120")
        if self.title_mode not in ("busy", "as_is"):
            raise MirrorConfigError('title_mode must be "busy" or "as_is"')
        ZoneInfo(self.timezone)
        for p in self.skip_titles:
            try:
                re.compile(p)
            except re.error as exc:
                raise MirrorConfigError(f"skip pattern {p!r}: {exc}") from exc


def _hhmm(s: str) -> time:
    m = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", s or "")
    if not m:
        raise MirrorConfigError(f"time {s!r} must be HH:MM")
    return time(int(m.group(1)), int(m.group(2)))


@dataclass(frozen=True)
class Busy:
    """One personal event, as read. `source` is "google" or "family".

    `source_id` names the single occurrence: for a repeating event, the
    instance id (series id plus original start), so moving one Tuesday
    of a series moves only that copy.
    """
    source: str
    source_id: str
    calendar: str
    start: datetime | date
    end: datetime | date
    all_day: bool
    title: str
    transparent: bool = False          # marked free
    declined: bool = False
    attendees: tuple[str, ...] = ()


@dataclass(frozen=True)
class Copy:
    source: str
    source_id: str
    start: datetime
    end: datetime
    title: str                         # what the work side gets
    event_id: str                      # deterministic: a re-run never duplicates
    label: str = ""                    # what his card shows: the real title, even when title is "Busy"


@dataclass(frozen=True)
class Plan:
    start: datetime                    # now, when it was made
    end: datetime                      # end of the horizon's last day
    copies: tuple[Copy, ...]
    skipped: tuple[tuple[str, str], ...]   # (title, reason), for the card's fine print
    plan_hash: str                     # settings plus copies; stable across reads
    # False when any input calendar wasn't read (invariant 19). An unread
    # calendar is never an empty one: reconcile won't delete from it.
    complete: bool = True


def event_id(source: str, source_id: str) -> str:
    # Google event ids: base32hex lowercase (a-v, 0-9), 5 to 1024 chars.
    # Keyed by the occurrence's own identity, not its time: a moved event
    # keeps its copy, and the work side gets one update, not a cancel and
    # a new invite.
    raw = hashlib.sha256(f"wm1|{source}|{source_id}".encode()).digest()
    return "m1" + base64.b32hexencode(raw).decode().rstrip("=").lower()


def horizon(now: datetime, cfg: MirrorConfig) -> tuple[datetime, datetime]:
    tz = ZoneInfo(cfg.timezone)
    local = now.astimezone(tz)
    last = local.date() + timedelta(days=cfg.horizon_days)
    return now, datetime.combine(last, time(0), tz)


def _windows(start: datetime, end: datetime, cfg: MirrorConfig) -> list[tuple[datetime, datetime]]:
    tz = ZoneInfo(cfg.timezone)
    s, e = _hhmm(cfg.day_start), _hhmm(cfg.day_end)
    out = []
    d = start.astimezone(tz).date()
    while datetime.combine(d, time(0), tz) < end:
        if d.weekday() in cfg.workdays:
            out.append((datetime.combine(d, s, tz), datetime.combine(d, e, tz)))
        d += timedelta(days=1)
    return out


def _clean(title: str) -> str:
    t = " ".join((title or "").split())
    return t[:TITLE_MAX] or "Busy"


def _title(t: str, cfg: MirrorConfig) -> str:
    return t if cfg.title_mode == "as_is" else "Busy"


def plan(events: list[Busy], cfg: MirrorConfig, now: datetime, *, complete: bool = True,
         tracked: frozenset[str] = frozenset(), read_until: datetime | None = None) -> Plan:
    """`tracked`: event ids of copies already on the work side. Their
    sources are followed past the horizon (up to `read_until`, how far the
    reader actually read), so a block moved beyond the window becomes an
    update of its copy, not a cancel now and a fresh invite later.
    """
    if now.tzinfo is None:
        raise MirrorConfigError("now needs a time zone")
    h_start, h_end = horizon(now, cfg)
    read_until = max(read_until or h_end, h_end)
    windows = _windows(h_start, read_until, cfg)
    addr = cfg.work_address.lower()
    skip = [re.compile(p, re.I) for p in cfg.skip_titles]
    rules = [(re.compile(r.pattern, re.I), r.title) for r in cfg.family_rules]
    # Empty means his primary calendar only, never "everything the reader
    # returns" (a shared spouse calendar must not reach his employer).
    google_cals = {c.lower() for c in cfg.google_calendars} or {"primary"}

    copies: list[Copy] = []
    skipped: list[tuple[str, str]] = []
    google_slots: set[tuple[datetime, datetime]] = set()

    def counts(s: datetime, e: datetime, eid: str) -> bool:
        # Still to come (or under way), inside the horizon (or tracked and
        # inside what was read), and touching work hours. A block that has
        # ended is history, not a conflict.
        end = read_until if eid in tracked else h_end
        return e > h_start and s < end and any(s < we and e > ws for ws, we in windows)

    def base_checks(ev: Busy) -> str:
        eid = event_id(ev.source, ev.source_id)
        if ev.all_day or not isinstance(ev.start, datetime) or not isinstance(ev.end, datetime):
            return "all day"
        if ev.start.tzinfo is None or ev.end.tzinfo is None:
            return "no time zone"                 # two different times on a travel week
        if not counts(ev.start, ev.end, eid):
            return "out of range"
        if ev.transparent:
            return "marked free"
        if ev.declined:
            return "declined"
        if any(p.fullmatch(_clean(ev.title)) for p in skip):
            return "skip rule"
        return ""

    def note(ev: Busy, why: str) -> None:
        if why != "out of range":
            skipped.append((_clean(ev.title), why))

    # Google first, so a Family copy of the same block can be recognized.
    for ev in sorted((e for e in events if e.source == "google"), key=lambda e: str(e.start)):
        if ev.calendar.lower() not in google_cals:
            continue
        if isinstance(ev.start, datetime) and isinstance(ev.end, datetime):
            # Recorded before the busy checks: a Family copy of a block he
            # marked free or declined must not slip through as "his".
            google_slots.add((ev.start, ev.end))
        why = base_checks(ev)
        if why:
            note(ev, why)
            continue
        if addr in (a.lower() for a in ev.attendees):
            skipped.append((_clean(ev.title), "already invited"))
            continue
        copies.append(Copy("google", ev.source_id, ev.start, ev.end, _title(_clean(ev.title), cfg),
                           event_id("google", ev.source_id), _clean(ev.title)))

    for ev in sorted((e for e in events if e.source == "family"), key=lambda e: str(e.start)):
        title = _clean(ev.title)
        rule = next(((rx, t) for rx, t in rules if rx.fullmatch(title)), None)
        if rule is None:
            continue                                  # not his: kids' school, chores
        why = base_checks(ev)
        if why:
            note(ev, why)
            continue
        if not complete:
            # The Google side may be the unread one, and then its copy of
            # this block is invisible: adding it could double the block.
            skipped.append((title, "a calendar wasn't read"))
            continue
        if (ev.start, ev.end) in google_slots:
            skipped.append((title, "same block is on his own calendar"))
            continue
        m = rule[0].fullmatch(title)
        try:
            out_title = _clean(rule[1].format(m.group(0), *m.groups()))
        except (IndexError, KeyError, ValueError):
            out_title = title
        copies.append(Copy("family", ev.source_id, ev.start, ev.end, _title(out_title, cfg),
                           event_id("family", ev.source_id), out_title))

    copies.sort(key=lambda c: (c.start, c.end, c.title))
    # The hash covers everything the write will do, not just the list he
    # reads: recipient, visibility, title mode, hours, zone, destination.
    # Not `now`: the same calendar must give the same hash on every read,
    # or a card he is holding goes stale every 30 minutes.
    canon = json.dumps({"v": 4, "settings": settings_hash(cfg),
                        "copies": [[c.event_id, c.start.isoformat(), c.end.isoformat(), c.title]
                                   for c in copies]}, sort_keys=True, separators=(",", ":"))
    return Plan(h_start, read_until, tuple(copies), tuple(skipped),
                hashlib.sha256(canon.encode()).hexdigest(), complete)


def read_extent(now: datetime, live: "Live", cfg: MirrorConfig) -> datetime:
    """How far the reader must read: the horizon, or the furthest live copy."""
    return max([horizon(now, cfg)[1]] + [v[1] for v in live.values()])


def settings_hash(cfg: MirrorConfig) -> str:
    """Everything about the write that isn't a block: who, how, where."""
    return hashlib.sha256(json.dumps(
        {"v": 1, "effect": "work_mirror_copy", "dest": "harness-created",
         "to": cfg.work_address.lower(), "vis": VISIBILITY, "send": "externalOnly", "reminders": "none", "tz": cfg.timezone,
         "hours": [cfg.day_start, cfg.day_end], "days": list(cfg.workdays), "titles": cfg.title_mode},
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()


Live = dict[str, tuple[datetime, datetime, str]]     # event id -> start, end, title


@dataclass(frozen=True)
class Delta:
    add: tuple[Copy, ...]
    update: tuple[Copy, ...]         # same id, new time or title
    delete: tuple[str, ...]          # event ids of copies that no longer match a block

    @property
    def empty(self) -> bool:
        return not (self.add or self.update or self.delete)

    def digest(self, cfg: MirrorConfig) -> str:
        """What a card's tap is bound to: the settings and every operation,
        exactly. Not the read time: an unchanged calendar keeps the card."""
        ops = ([["add", c.event_id, c.start.isoformat(), c.end.isoformat(), c.title] for c in self.add]
               + [["update", c.event_id, c.start.isoformat(), c.end.isoformat(), c.title]
                  for c in self.update]
               + [["delete", i] for i in self.delete])
        return hashlib.sha256(json.dumps({"v": 2, "settings": settings_hash(cfg), "ops": ops},
                                         separators=(",", ":")).encode()).hexdigest()


def reconcile(p: Plan, live: Live) -> Delta:
    """What to change on the work side so it matches the plan.

    `live` is the harness calendar's copies, read back from Google, never
    from memory. Every copy still to come is reconciled, wherever it sits:
    the caller reads sources as far as the furthest live copy and passes
    that as `read_until`, so a cancelled far-off block is deleted, not left
    behind. Past copies, and any beyond what was read, are left alone.
    """
    in_range = {i: v for i, v in live.items() if v[1] > p.start and v[0] < p.end}
    want = {c.event_id: c for c in p.copies}
    add = tuple(c for i, c in want.items() if i not in live)
    update = tuple(c for i, c in want.items()
                   if i in live and live[i] != (c.start, c.end, c.title))
    # From a partial read, a missing block may just be unread: keep its copy.
    delete = tuple(sorted(i for i in in_range if i not in want)) if p.complete else ()
    return Delta(add, update, delete)


def _deadline(start: datetime, end: datetime, now: datetime) -> datetime:
    """When an operation stops being worth approving: its start, or its end
    if it is already under way (cancelling a block in progress still helps)."""
    return start if start > now else end


def _deadlines(d: Delta, live: Live, now: datetime) -> list[datetime]:
    out = [_deadline(c.start, c.end, now) for c in d.add + d.update]
    out += [_deadline(live[c.event_id][0], live[c.event_id][1], now)
            for c in d.update if c.event_id in live]
    out += [_deadline(live[i][0], live[i][1], now) for i in d.delete if i in live]
    return out


def delivery(d: Delta, live: Live, now: datetime, cfg: MirrorConfig, *,
             first_seen: datetime | None = None) -> tuple[str, datetime] | None:
    """When a card goes out: None (nothing to do), or (mode, at).

    "now": an operation touches the next `soon_hours` (on the old and the
    new time of a move, because either can be the one a coworker is about
    to book over). It still waits `settle_minutes` after the change first
    appeared, and waits out quiet hours, unless a block starts before then.
    "digest": everything else, folded into the next morning digest.
    """
    if d.empty:
        return None
    soonest = min(_deadlines(d, live, now))
    if soonest >= now + timedelta(hours=cfg.soon_hours):
        return ("digest", now)
    at = now
    if first_seen is not None:
        at = max(at, first_seen + timedelta(minutes=cfg.settle_minutes))
    at = _after_quiet(at, cfg)
    # Never later than an hour before the first block (or now, if closer).
    latest = max(now, soonest - timedelta(hours=1))
    return ("now", min(at, latest))


def _after_quiet(t: datetime, cfg: MirrorConfig) -> datetime:
    tz = ZoneInfo(cfg.timezone)
    local = t.astimezone(tz)
    qs, qe = _hhmm(cfg.quiet_start), _hhmm(cfg.quiet_end)
    if qs == qe:
        return t
    tod = local.time()
    in_quiet = (qs <= tod or tod < qe) if qs > qe else (qs <= tod < qe)
    if not in_quiet:
        return t
    wake = datetime.combine(local.date(), qe, tz)
    if wake <= local:
        wake += timedelta(days=1)
    return wake


def card_expiry(d: Delta, live: Live, now: datetime, ttl_s: int) -> datetime:
    """A card lasts until its most urgent operation stops mattering."""
    return min([now + timedelta(seconds=ttl_s)] + _deadlines(d, live, now))


def _when(s: datetime, e: datetime, tz: ZoneInfo) -> str:
    s, e = s.astimezone(tz), e.astimezone(tz)
    return (f"{s:%a %b %-d %-I:%M}-{e:%-I:%M} {e:%p}").replace("AM", "am").replace("PM", "pm")


def card_text(d: Delta, live: Live, cfg: MirrorConfig) -> str:
    """Plain text; render.py escapes it like everything else."""
    tz = ZoneInfo(cfg.timezone)
    n = len(d.add) + len(d.update) + len(d.delete)
    lines = [f"Work calendar: {n} change{'s' if n != 1 else ''} (private, shows as busy)"]
    if cfg.title_mode == "busy":
        lines[0] += '; titled "Busy" at work'
    for c in d.add:
        lines.append(f"+ {_when(c.start, c.end, tz)}  {c.label or c.title}")
    for c in d.update:
        old = live.get(c.event_id)
        was = f" (was {_when(old[0], old[1], tz)})" if old and old[:2] != (c.start, c.end) else ""
        lines.append(f"~ {_when(c.start, c.end, tz)}  {c.label or c.title}{was}")
    for i in d.delete:
        if i in live:
            s, e, t = live[i]
            lines.append(f"- {_when(s, e, tz)}  {t}")
    return "\n".join(lines)


# -- settings entry -----------------------------------------------------------------
# His values are entered once on the add-on's own page (setup_web.py) and kept
# in /data with the keys (vault.py), never in this repository and never in
# add-on options. The text is a few `key: value` lines; it is parsed on every
# use, so a change (after his tap, once paired) applies without a restart.

SETTINGS_KEYS = ("enabled", "work", "days", "hours", "zone", "horizon", "calendars",
                 "skip", "family", "titles")
_DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_SETTINGS_LEN = 4000


def _days(v: str) -> tuple[int, ...]:
    out: list[int] = []
    for part in re.split(r"[,\s]+", v.strip().lower()):
        if not part:
            continue
        a, dash, b = part.partition("-")
        if a not in _DAY_NAMES or (dash and b not in _DAY_NAMES):
            raise MirrorConfigError(f"days: {part!r} is not mon..sun")
        lo, hi = _DAY_NAMES.index(a), _DAY_NAMES.index(b) if dash else _DAY_NAMES.index(a)
        if hi < lo:
            raise MirrorConfigError(f"days: {part!r} runs backwards")
        out += range(lo, hi + 1)
    return tuple(sorted(set(out)))


def parse_settings(text: str) -> MirrorConfig:
    """`key: value` lines (see SETTINGS_KEYS); `skip` and `family` may repeat;
    `#` starts a comment. `family: <pattern> => <title>`. Anything unknown or
    malformed is refused with the line named, never guessed."""
    if len(text or "") > MAX_SETTINGS_LEN:
        raise MirrorConfigError("settings are longer than this reads")
    kw: dict = {"enabled": True}
    skip: list[str] = []
    rules: list[FamilyRule] = []
    seen: set[str] = set()
    for n, raw in enumerate((text or "").splitlines(), 1):
        line = "" if raw.lstrip().startswith("#") else raw.strip()
        if not line:
            continue
        key, colon, value = line.partition(":")
        key, value = key.strip().lower(), value.strip()
        if not colon or key not in SETTINGS_KEYS or not value:
            raise MirrorConfigError(f"line {n}: expected one of {', '.join(SETTINGS_KEYS)} "
                                    "followed by a colon and a value")
        if key in seen and key not in ("skip", "family"):
            raise MirrorConfigError(f"line {n}: {key} is given twice")
        seen.add(key)
        if key == "enabled":
            if value.lower() not in ("yes", "no"):
                raise MirrorConfigError(f"line {n}: enabled must be yes or no")
            kw["enabled"] = value.lower() == "yes"
        elif key == "work":
            kw["work_address"] = value
        elif key == "days":
            kw["workdays"] = _days(value)
        elif key == "hours":
            m = re.fullmatch(r"(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})", value)
            if not m:
                raise MirrorConfigError(f"line {n}: hours must be HH:MM-HH:MM")
            kw["day_start"], kw["day_end"] = m.group(1), m.group(2)
        elif key == "zone":
            kw["timezone"] = value
        elif key == "horizon":
            if not value.isdigit():
                raise MirrorConfigError(f"line {n}: horizon must be a number of days")
            kw["horizon_days"] = int(value)
        elif key == "calendars":
            kw["google_calendars"] = tuple(c.strip() for c in value.split(",") if c.strip())
        elif key == "skip":
            skip.append(value)
        elif key == "family":
            pat, arrow, title = value.partition("=>")
            rules.append(FamilyRule(pat.strip(), title.strip() if arrow else "{0}"))
        elif key == "titles":
            kw["title_mode"] = value.lower()
    if kw["enabled"] and "work_address" not in kw:
        raise MirrorConfigError("work: <address> is required")
    try:
        return MirrorConfig(skip_titles=tuple(skip), family_rules=tuple(rules), **kw)
    except (ValueError, KeyError) as exc:           # MirrorConfigError or ZoneInfoNotFound
        raise MirrorConfigError(str(exc)) from None


def settings_text(cfg: MirrorConfig) -> str:
    """The normalized form of what parse_settings read (what the vault keeps)."""
    lines = [f"enabled: {'yes' if cfg.enabled else 'no'}"]
    if cfg.work_address:
        lines.append(f"work: {cfg.work_address}")
    lines += ["days: " + ",".join(_DAY_NAMES[d] for d in cfg.workdays),
             f"hours: {cfg.day_start}-{cfg.day_end}", f"zone: {cfg.timezone}",
             f"horizon: {cfg.horizon_days}", f"titles: {cfg.title_mode}"]
    if cfg.google_calendars:
        lines.append("calendars: " + ", ".join(cfg.google_calendars))
    lines += [f"skip: {p}" for p in cfg.skip_titles]
    lines += [f"family: {r.pattern} => {r.title}" for r in cfg.family_rules]
    return "\n".join(lines)
