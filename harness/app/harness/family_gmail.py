"""Keeping his Gmail calendar true to Family, for the few events that tie him up.

A Family event can be his commitment without being his event: while she's at an
appointment, he has the kids. The add-on's `family_to_gmail` option names those events
and what Gmail should say, as "Family title => Gmail title". Each one gets a block on
Gmail, which moves when it moves and goes when it goes, with no tap and no model.

The mirror image of family_copy.py, and it keeps the same safety:

  * Gmail gets the fixed title he set and the times, never text from Family but an
    event's recognized street address (live mode, below), and no guest or update
    (google_cal.py). His own default reminders apply: they're
    his, and a service account can't turn them off.
  * It changes only blocks it wrote. A block someone has since edited is left alone for
    good, and one someone removed, with its Family event still there, stays removed.
  * Nothing is removed, or taken as removed, on one read. It takes two good reads in a
    row, and more than a few at once is held back for a while as a sign the read is wrong.
  * If Family or Google can't be read, nothing happens.

School days work the same way, from the `family_school` option, which names the Family
events that mean a school day. Each gets two blocks, drop-off and pickup, unless a real event
on his own calendar is in the way, in which case the other parent has that run: one during the
trip to school, or, with the school's address entered, one he can't drive to or from in time
(drive.py). If the event goes, the block comes back.

The two can't chase each other: a title here must carry a word family_copy.py skips, so
a block never copies to Family, and a copy on Family (hx- uid) never gets a block.

Before its first block, one test event goes on Gmail and comes off again, so a key or
share that doesn't work costs nothing and says so.

With the `meaning_live` option on (meaning_live.py), the wants come from what each Family event
was judged to mean instead of the title rules and the two options; everything below that
decides how and whether to write stays as it is. Off, nothing here changes.

In live mode, an event he goes to himself, at a street address, also gets its drive: a block
"Busy (drive there)" ending as it starts and one "Busy (drive back)" starting as it ends, never
added to the event's own block, which keeps the event's times. Drives run from home (the
`home_location` option) unless two events in a day are too close to go home between them, in
which case it's straight from one to the next. The event's own block carries its street address,
and only that, so it opens in Maps; that place is ours, and it's compared with what was written,
so it never makes the block look edited.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import caldav, calendar_feed, drive, family_rules, google_cal, ical, render
from .family_copy import (_SKIP, _STAY, AHEAD_DAYS, GIVE_UP_READS, HOLD_READS, MAX_REMOVALS_AT_ONCE,
                          READS_BEFORE_REMOVING, _same, confirm_soon)
from .ledger import Ledger, iso

log = logging.getLogger("harness.family_gmail")

MAX_WRITES_PER_DAY = 100       # two runs a school day for 60 days fit, and no one's alerted
MAX_RULES = 5
DROP_TITLE = "Busy (school drop-off)"
PICK_TITLE = "Busy (school pickup)"
# 15 minutes each way and 15 to spare, so a run is 45 minutes. The spare is before the
# morning bell and after the afternoon one.
DROP_BEFORE, DROP_AFTER = timedelta(minutes=30), timedelta(minutes=15)
PICK_BEFORE, PICK_AFTER = timedelta(minutes=15), timedelta(minutes=30)
TO_SCHOOL = timedelta(minutes=15)   # a run starts when he leaves, so he's there this much later
NEAR_RUN = timedelta(hours=3)       # an event further from a run than this can't get in its way
NOTE_AHEAD = timedelta(days=14)     # how far ahead a missing address is worth a word
ASK_AHEAD = timedelta(days=14)      # how far ahead an event with no rule is worth asking about
MAX_ASKED = 5
MAX_ASKED_TITLE = 40
MAX_TITLE = 60
PROBLEM = "family_gmail_problem"
PROVEN = "family_gmail_proven"
TEST_TRY = "family_gmail_test_try"
READ_SIZE = "family_gmail_read_size"
THIN_READS = "family_gmail_thin_reads"
TEST_TITLE = "Busy (harness test, safe to delete)"
# meaning.TITLE's drive legs (meaning.py imports this module, so they're spelled here too).
DRIVE_THERE, DRIVE_BACK = "Busy (drive there)", "Busy (drive back)"
MAYBE_DRIVE = {DRIVE_THERE: "Maybe busy (drive there)", DRIVE_BACK: "Maybe busy (drive back)"}
# The school runs, sure or maybe: the drive logic decides whether the run is his.
_RUN_TITLES = frozenset({DROP_TITLE, PICK_TITLE, "Maybe busy (school drop-off)", "Maybe busy (school pickup)"})
_TITLE_RE = re.compile(r"[^\W_]+(?:[ '&()+,.-]+[^\W_]+)*[ )]*")


@dataclass(frozen=True)
class Rule:
    family: str
    title: str


def parse_rules(text: str) -> tuple[Rule, ...]:
    """Plain words, not a pattern, so what it matches is what it says. Anything off leaves
    this off: "Family title => Gmail title", ";" between several."""
    rules = []
    parts = [p for p in (text or "").split(";") if p.strip()]
    if len(parts) > MAX_RULES:
        return ()
    for part in parts:
        family, arrow, title = part.partition("=>")
        family, title = family.strip(), title.strip()
        if not (arrow and family and title) or len(family) > 100 or len(title) > MAX_TITLE:
            return ()
        # "Stay at" would come back to Family as a trip (family_copy.py).
        if not _TITLE_RE.fullmatch(title) or not _SKIP.search(title) or _STAY.match(title):
            return ()
        rules.append(Rule(family.casefold(), title))
    return tuple(rules)


def rules_from_options(data_dir: str) -> tuple[Rule, ...]:
    """The setting, read each time, like the first name for copies."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("family_to_gmail", "")
    except (OSError, ValueError, AttributeError):
        return ()
    return parse_rules(value) if isinstance(value, str) else ()


def parse_school(text: str) -> tuple[str, ...]:
    """The Family titles that mean a school day: plain words, ";" between several."""
    titles = [t.strip().casefold() for t in (text or "").split(";") if t.strip()]
    if len(titles) > MAX_RULES or any(len(t) > 100 for t in titles):
        return ()
    return tuple(titles)


def school_from_options(data_dir: str) -> tuple[str, ...]:
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("family_school", "")
    except (OSError, ValueError, AttributeError):
        return ()
    return parse_school(value) if isinstance(value, str) else ()


def _text_option(data_dir: str, name: str) -> str:
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get(name, "")
    except (OSError, ValueError, AttributeError):
        return ""
    return value.strip() if isinstance(value, str) else ""


def school_address_from_options(data_dir: str) -> str:
    return _text_option(data_dir, "family_school_address")


def home_from_options(data_dir: str) -> str:
    """Where his drives start and end: "lat, lon", or a street address."""
    return _text_option(data_dir, "home_location")


@dataclass(frozen=True)
class Want:
    key: str
    title: str
    start: datetime
    end: datetime
    kind: str = ""                 # "me": only if Gmail doesn't already have him busy
    state: str = ""                # live meaning (meaning_live.py): "confirmed" | "provisional"
    place: str = ""                # an event he goes to: its street address (drive.street_address)
    legs: bool = True              # False: the judgment already has him driving to it


def _short(title: str) -> str:
    """A title for the digest: no invisible characters, and not long enough to crowd it out."""
    text = "".join(ch for ch in title if unicodedata.category(ch) != "Cf").strip()
    return text if len(text) <= MAX_ASKED_TITLE else text[:MAX_ASKED_TITLE - 1].rstrip() + "\u2026"


def _said_kind(occ: ical.Occurrence, said: tuple) -> str | None:
    """What he said this event means, if he did. That comes before the add-on's settings."""
    rule = family_rules.pick(occ.summary, said)
    return rule.kind if rule else None


def _key(occ: ical.Occurrence, run: str = "") -> str:
    return hashlib.sha256((f"{occ.uid}|{occ.instance}" + (f"|{run}" if run else "")).encode()).hexdigest()[:32]


def school_plan(items: list[caldav.Item], titles: tuple[str, ...], said: tuple = ()) -> dict[str, Want]:
    """Each school day's two runs: there and back around the start, and around the end.
    Family says which days, so a closed day or a moved start needs nothing here."""
    wants = []
    for item in items:
        occ: ical.Occurrence = item.occ
        kind = _said_kind(occ, said)
        school = kind == "school" if kind else occ.summary.strip().casefold() in titles
        if not school or occ.all_day or occ.end <= occ.start or occ.uid.startswith("hx-"):
            continue
        for run, title, start, end in (("drop", DROP_TITLE, occ.start - DROP_BEFORE, occ.start + DROP_AFTER),
                                       ("pick", PICK_TITLE, occ.end - PICK_BEFORE, occ.end + PICK_AFTER)):
            wants.append(Want(_key(occ, run), title, start, end))
    out: dict[str, Want] = {}
    seen = set()
    for want in sorted(wants, key=lambda w: w.key):    # two events for one day are one run
        moment = (want.title, want.start.astimezone(timezone.utc))
        if moment not in seen:
            seen.add(moment)
            out[want.key] = want
    return out


def _is_real(occ: ical.Occurrence) -> bool:
    """Not a block from here, and not a "Busy" hold, which may only be drive time."""
    return not (google_cal.is_ours(occ.uid.removesuffix("@google.com"))
                or occ.summary.strip().casefold().startswith("busy"))


def _ties_him_up(occ: ical.Occurrence, want: Want, tz: str) -> bool:
    """A real event of his during the trip to school, which means the other parent has the run.
    The way back doesn't count: he can go straight on from there. Not an all-day event unless
    it's a trip: a birthday doesn't stop a school run."""
    if not _is_real(occ):
        return False
    if occ.all_day:
        return bool(_STAY.match(occ.summary)) and occ.start <= want.start.astimezone(ZoneInfo(tz)).date() < occ.end
    return not occ.transparent and occ.start < want.start + TO_SCHOOL and occ.end > want.start


def plan(items: list[caldav.Item], rules: tuple[Rule, ...], said: tuple = ()) -> dict[str, Want]:
    """What Gmail should hold, from Family alone. A title comes only from a rule: fixed words
    for what he said, or the one in the add-on's settings."""
    titles = {r.family: r.title for r in rules}
    out: dict[str, Want] = {}
    for item in items:
        occ: ical.Occurrence = item.occ
        kind = _said_kind(occ, said)
        title = family_rules.TITLES.get(kind) if kind else titles.get(occ.summary.strip().casefold())
        if title is None or occ.all_day or occ.uid.startswith("hx-") or occ.end <= occ.start:
            continue
        # A moved day keeps its series and its place in it, so it keeps its block.
        key = _key(occ)
        out[key] = Want(key, title, occ.start, occ.end, kind or "")
    return out


def unruled(items: list[caldav.Item], rules: tuple[Rule, ...], school: tuple[str, ...], said: tuple,
            now: datetime, until: datetime) -> list[tuple[str, datetime]]:
    """Family events coming up that no rule covers, soonest first, each title once. Timed only:
    a birthday doesn't tie him up. Not a copy of his own, and not a hold or block."""
    covered = {r.family for r in rules} | set(school)
    first: dict[frozenset, tuple[str, datetime]] = {}
    for item in items:
        occ: ical.Occurrence = item.occ
        if occ.all_day or occ.uid.startswith("hx-") or not now <= occ.start < until or occ.transparent \
                or not _is_real(occ) or not family_rules.words(occ.summary):
            continue
        if _said_kind(occ, said) or occ.summary.strip().casefold() in covered:
            continue
        key = family_rules.words(occ.summary)
        if key not in first or occ.start < first[key][1]:
            first[key] = (occ.summary.strip(), occ.start)
    return sorted(first.values(), key=lambda x: x[1])


def _intent(title: str, start: datetime, end: datetime, place: str = "") -> str:
    return json.dumps([title, start.isoformat(), end.isoformat(), place])


def _was_sent(intent: str, block: google_cal.Block) -> bool:
    """Google hands times back in the calendar's own offset, so compare moments. One written
    before blocks had places has none."""
    if not intent:
        return False
    title, start, end, *place = json.loads(intent)
    return block.title == title and _same(block.start, datetime.fromisoformat(start)) \
        and _same(block.end, datetime.fromisoformat(end)) and block.location == (place[0] if place else "")


def leg_key(key: str, leg: str) -> str:
    """A drive's own key, fixed by its event's, and never the same as it."""
    return hashlib.sha256(f"{key}|{leg}".encode()).hexdigest()[:32]


def _leg_title(leg: str, state: str) -> str:
    title = DRIVE_THERE if leg == "there" else DRIVE_BACK
    return MAYBE_DRIVE.get(title, title) if state == "provisional" else title


class FamilyGmail:
    def __init__(self, ledger: Ledger, family_add, calendar, google: google_cal.GoogleCalendar,
                 *, rules_fn=lambda: (), school_fn=lambda: (), said_fn=lambda: (), drives=None, tz: str,
                 live=None, live_fn=lambda: False):
        self.live = live                   # meaning_live.MeaningLive, or None
        self.live_fn = live_fn             # the meaning_live option: the judgments decide
        self.school_fn = school_fn         # the Family titles that mean a school day
        self.said_fn = said_fn             # what he's said Family events mean (family_rules.py)
        self.asking: list[tuple[str, datetime]] = []
        self.drives = drives               # drive times, once the school's address is entered
        self.ledger = ledger
        self.fa = family_add
        self.client = family_add.client
        self.calendar = calendar
        self.google = google
        self.rules_fn = rules_fn
        self.tz = tz
        self._seen: int | None = None      # the calendar read last looked at
        self.dropped: set[str] = set()     # no longer wanted only because of what he said
        self._last: tuple | None = None    # (settings, what he'd said) at the last read

    def _live_on(self) -> bool:
        return self.live is not None and bool(self.live_fn())

    def _named(self) -> bool:
        return bool(self.rules_fn() or self.school_fn() or self.said_fn()) or self._live_on()

    # -- what he sees ----------------------------------------------------------------
    def status_line(self) -> str:
        if not self._named():
            return ("Blocks on Gmail from Family: off. Nothing is named in the add-on's settings, "
                    "or what's there can't be read.")
        if not self.google.configured():
            return ("Blocks on Gmail from Family: waiting. Enter the Google service account key "
                    "on the add-on page.")
        if self.calendar.snapshot.feeds and self._address() is None:
            return ("Blocks on Gmail from Family: waiting. It needs exactly one Gmail calendar's "
                    "secret iCal address on the add-on page.")
        n = self.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE state='live'"
                                   ).fetchone()[0]
        return f"Blocks on Gmail from Family: on, {n} on Gmail now"

    def digest_line(self) -> str:
        """Counts only. Silent when nothing changed and nothing is wrong."""
        since = self.ledger.meta_time("last_digest_at")
        parts = []
        for kind, label in (("family_gmail_added", "added"), ("family_gmail_moved", "moved"),
                            ("family_gmail_cancelled", "removed as cancelled"),
                            ("family_gmail_removed", "removed by someone, not put back")):
            n = self.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind=? AND at>=?",
                                       (kind, iso(since) if since else "")).fetchone()[0]
            if n:
                parts.append(f"{n} {label}")
        line = "Blocks on Gmail from Family: " + ", ".join(parts) + "." if parts else ""
        problem = self.ledger.get_meta(PROBLEM)
        return " ".join(x for x in (line, problem, self._ask_line()) if x)

    def _ask_line(self) -> str:
        """Titles come from Family, which anyone with it can write, so they're defanged. The digest
        escapes them."""
        before = family_rules.asked(self.ledger)
        new = [(t, w) for t, w in self.asking if " ".join(sorted(family_rules.words(t))) not in before]
        if not new:
            return ""
        zone = ZoneInfo(self.tz)
        shown = new[:MAX_ASKED]            # the rest are asked on another day, by name then
        family_rules.mark_asked(self.ledger, [t for t, _ in shown])
        named = [f"{render.defang(_short(t))} ({w.astimezone(zone):%b} {w.astimezone(zone).day})"
                 for t, w in shown]
        return ("On Family with no rule yet: " + ", ".join(named) + ". If one ties you up, "
                "tell me, like \"Anything with Pat means I have the kids\". Ignore any that don't: "
                "I won't ask again.")

    # -- each tick -------------------------------------------------------------------
    def run(self, *, paused: bool) -> None:
        """Only after a new read. A bug here is a record, never a stopped loop."""
        if not paused and self._live_on():
            try:
                self._undo_requested()
            except Exception as e:
                log.warning("family to gmail undo failed: %s", type(e).__name__)
                self.ledger.event("family_gmail_failed", {"error": type(e).__name__})
        gen = self.calendar.generation
        if gen == self._seen:
            return
        self._seen = gen
        try:
            if not paused and self.fa.enabled() and self._named() and self.google.configured():
                self._sync()
        except Exception as e:
            log.warning("family to gmail failed: %s", type(e).__name__)
            self.ledger.event("family_gmail_failed", {"error": type(e).__name__})

    def _address(self) -> str | None:
        """Whose calendar: the feed names itself by his address (ical.py). Two is a guess."""
        found = [res.window.calendar for res in self.calendar.snapshot.feeds.values()
                 if res.window is not None and res.window.calendar.casefold().endswith("@gmail.com")]
        return found[0] if len(found) == 1 else None

    def _sync(self) -> None:
        address = self._address()
        if address is None:
            return
        rules = self.rules_fn()
        now = self.ledger.now()
        if self.ledger.get_meta(PROVEN) is None and not self._prove(address, now):
            return
        day_start, _, _ = calendar_feed.today_bounds(now, self.tz)
        until = day_start + timedelta(days=AHEAD_DAYS + 1)
        since = now - timedelta(days=1)
        family = self.client.items_between(since, until, self.tz)
        if family is None or (not family.items and any(
                self._when(r["end"]) > now for r in self._live())):
            self._problem("Blocks on Gmail from Family: couldn't read the Family calendar, so "
                          "nothing changed.")
            return
        blocks, why = self.google.list_ours(address, since, until)
        if blocks is None:
            self._problem(self._said(why))
            return
        if self.drives is not None:
            self.drives.begin()            # one allowance of lookups for the whole read
        self.leg_note = ""
        if self._live_on():
            # What each event was judged to mean, model-free here: the judgments are stored.
            judged = self.live.wants(family.items, now)
            self.dropped = set()
            self._last = None
            runs = {k: w for k, w in judged.items() if w.title in _RUN_TITLES}
            own = {k: w for k, w in judged.items() if k not in runs}
            named = self._not_busy(own)
            # From every event he goes to, even one Gmail already has him busy for: he often
            # puts it there himself, and the drive is still his.
            legs = self._drive_legs(own, now)
            wants = {k: w for k, w in {**named, **legs, **self._school_runs(family.items, runs)}.items()
                     if w.end > now}
            self.asking = []               # questions go on their own cards (meaning_live.py)
        else:
            said = self.said_fn()
            planned = plan(family.items, rules, said)
            # Wanted under what he'd said at the last read, not under what he says now, with the
            # same events and the same settings: that's his word, not a bad read. A setting that
            # read empty or an event that changed still takes two reads.
            self.dropped = set()
            if self._last is not None and self._last[0] == rules and self._last[1] != said:
                self.dropped = plan(family.items, rules, self._last[1]).keys() - planned.keys()
            self._last = (rules, said)
            named = self._not_busy(planned)
            wants = {k: w for k, w in {**named, **self._school_runs(family.items)}.items() if w.end > now}
            self.asking = unruled(family.items, rules, self.school_fn(), said, now, now + ASK_AHEAD)
        self.writes = self._writes_today()
        problem = self._follow(address, wants, {b.id: b for b in blocks}, now, until,
                               family.unreadable == 0, self._thin(len(family.items) - len(named)))
        added = self._add_new(address, wants)
        self._problem(problem or added or self.school_note or self.me_note or self.leg_note)
        confirm_soon(self.ledger, "family_gmail", self.calendar)

    def _school_runs(self, items: list[caldav.Item], runs: dict[str, Want] | None = None) -> dict[str, Want]:
        """The runs that are his. With no read of his calendar, what's there stays and nothing
        is added: that says nothing about whether he's free. With one event in it unreadable,
        the rest still counts, or one odd old event would stop new blocks for good: what's there
        stays, and a block too many only shows him busy."""
        self.school_note = ""
        if runs is None:
            runs = school_plan(items, self.school_fn(), self.said_fn())
        if not runs:
            return {}
        ahead = next((res.ahead for res in self.calendar.snapshot.feeds.values() if res.window is not None
                      and res.window.calendar.casefold().endswith("@gmail.com")), None)
        live = {r["key"] for r in self._live()}
        if ahead is None or not ahead.occurrences:
            self.school_note = ("Blocks on Gmail from Family: couldn't read your Gmail calendar, so "
                                "school runs didn't change.")
            return {k: w for k, w in runs.items() if k in live}
        self._no_address: set[datetime] = set()
        self._no_lookup = False
        self._use_drives = self.drives is not None and self.drives.on()
        now = self.ledger.now()
        # Soonest first, so a limit on lookups leaves the far-off days for the next read.
        free = {k: w for k, w in sorted(runs.items(), key=lambda kv: kv[1].start) if w.end > now
                and not any(_ties_him_up(o, w, self.tz) or self._too_far(o, w) for o in ahead.occurrences)}
        self.school_note = self._drive_note()
        if ahead.unreadable:
            return {**free, **{k: w for k, w in runs.items() if k in live}}
        return free

    def _not_busy(self, wants: dict[str, Want]) -> dict[str, Want]:
        """His own Family events, less those Gmail already has him busy for: he often puts them
        on both. With no read of Gmail, the ones already there stay and nothing is added."""
        self.me_note = ""
        mine = {k for k, w in wants.items() if w.kind == "me"}
        if not mine:
            return wants
        ahead = next((res.ahead for res in self.calendar.snapshot.feeds.values() if res.window is not None
                      and res.window.calendar.casefold().endswith("@gmail.com")), None)
        live = {r["key"] for r in self._live()}
        if ahead is None or not ahead.occurrences or ahead.unreadable:
            # Not knowing whether he's busy isn't knowing he's free, so nothing is added or taken.
            self.me_note = ("Blocks on Gmail from Family: couldn't read all of your Gmail calendar, so "
                            "your own Family events didn't change.")
            return {k: w for k, w in wants.items() if k not in mine or k in live}
        return {k: w for k, w in wants.items() if k not in mine or not any(
            _is_real(o) and not o.all_day and not o.transparent and o.start <= w.start and o.end >= w.end
            for o in ahead.occurrences)}

    def _too_far(self, occ: ical.Occurrence, want: Want) -> bool:
        """An event before or after a run that he can't get to or from in time. With no answer
        the run stays: a block too many only shows him busy, and the digest says why."""
        if not self._use_drives or occ.all_day or occ.transparent or not _is_real(occ):
            return False
        arrive = want.start + TO_SCHOOL
        gap = arrive - occ.end if occ.end <= want.start else occ.start - arrive
        if gap > NEAR_RUN:
            return False
        minutes = self.drives.minutes(occ.location)
        if minutes == drive.NO_ADDRESS:
            now = self.ledger.now()
            if now < occ.start < now + NOTE_AHEAD:
                self._no_address.add(occ.start)
            return False
        if minutes == drive.FAILED:
            self._no_lookup = True
            return False
        return timedelta(minutes=minutes) > gap

    def _drive_note(self) -> str:
        """Times only: nothing from the event itself goes in a note."""
        notes = []
        if self.drives is not None and self.drives.misread():
            notes.append("Blocks on Gmail from Family: the school's address in the add-on's settings doesn't "
                         "look like a street address, so drive times are off.")
        if self._no_lookup:
            notes.append("Blocks on Gmail from Family: couldn't look up a drive time, so I kept the school "
                         "runs it was for. I'll try again at the next read.")
        if self._no_address:
            zone = ZoneInfo(self.tz)
            whens = [f"{t:%b} {t.day}, {t.hour % 12 or 12}:{t:%M}"
                     for t in (s.astimezone(zone) for s in sorted(self._no_address))]
            which = f"the event at {whens[0]} is" if len(whens) == 1 else \
                f"the events at {'; '.join(whens)} are"
            notes.append(f"Blocks on Gmail from Family: {which} near a school run with "
                         "no address I can use, so I kept the run. Add an address if it's far.")
        return " ".join(notes)

    def _drive_legs(self, wants: dict[str, Want], now: datetime) -> dict[str, Want]:
        """The drives to and from the events he goes to, as their own blocks. In a day, in time
        order: straight from one event to the next when there isn't time to go home between,
        else home and out again. A drive that can't be found is left off, and the digest names
        the event's time (nothing else from it)."""
        drives = self.drives
        if drives is None or not hasattr(drives, "between"):
            return {}
        if drives.home_misread():
            self.leg_note = ("Blocks on Gmail from Family: home in the add-on's settings doesn't look like a "
                             "street address or map coordinates (lat, lon), so drive blocks are off.")
            return {}
        if not drives.home_on():
            return {}
        zone = ZoneInfo(self.tz)
        days: dict = {}
        # Soonest first, so a limit on lookups leaves the far-off days for the next read.
        for want in sorted((w for w in wants.values() if w.place and w.legs and w.end > now), key=lambda w: w.start):
            days.setdefault(want.start.astimezone(zone).date(), []).append(want)
        out: dict[str, Want] = {}
        failed: set[datetime] = set()
        not_found: set[datetime] = set()

        def minutes(origin: str, destination: str, event: Want) -> int | None:
            found = drives.between(origin, destination)
            if found == drive.FAILED:
                failed.add(event.start)
            elif found == drive.NO_ADDRESS:
                not_found.add(event.start)
            else:
                return math.ceil(found)
            return None

        def leg(event: Want, which: str, start: datetime, end: datetime) -> None:
            if end > start:
                key = leg_key(event.key, which)
                out[key] = Want(key, _leg_title(which, event.state), start, end, "", event.state)

        for events in days.values():
            prev: Want | None = None
            for event in events:
                there_from: str | None = drive.HOME
                if prev is not None:
                    back = minutes(prev.place, drive.HOME, prev)
                    out_again = minutes(drive.HOME, event.place, event)
                    if back is None or out_again is None:
                        there_from = None          # can't tell which way he goes: no drive between
                    elif event.start - prev.end < timedelta(minutes=back + out_again):
                        there_from = prev.place    # no time to go home: straight on
                    else:
                        leg(prev, "back", prev.end, prev.end + timedelta(minutes=back))
                if there_from is not None:
                    there = minutes(there_from, event.place, event)
                    if there is not None:
                        start = event.start - timedelta(minutes=there)
                        if there_from != drive.HOME:
                            start = max(start, prev.end)   # straight on starts when the last one ends
                        leg(event, "there", start, event.start)
                prev = event
            back = minutes(prev.place, drive.HOME, prev)
            if back is not None:
                leg(prev, "back", prev.end, prev.end + timedelta(minutes=back))
        self.leg_note = self._leg_note(failed, not_found, now)
        return out

    def _leg_note(self, failed: set[datetime], not_found: set[datetime], now: datetime) -> str:
        """Times only, each one named: nothing from the event itself goes in a note."""
        zone = ZoneInfo(self.tz)

        def which(times: set[datetime]) -> str:
            whens = [f"{t:%b} {t.day}, {t.hour % 12 or 12}:{t:%M}"
                     for t in (s.astimezone(zone) for s in sorted(times))]
            return f"the event at {whens[0]}" if len(whens) == 1 else f"the events at {'; '.join(whens)}"

        failed = {t for t in failed if t < now + NOTE_AHEAD}
        not_found = {t for t in not_found - failed if t < now + NOTE_AHEAD}
        notes = []
        if failed:
            notes.append(f"Blocks on Gmail from Family: couldn't look up the drive for {which(failed)}, "
                         "so a drive block is missing. I'll try again at the next read.")
        if not_found:
            notes.append(f"Blocks on Gmail from Family: couldn't find a drive to {which(not_found)}, "
                         "so a drive block is missing. Check the address on Family.")
        return " ".join(notes)

    def _thin(self, rest: int) -> bool:
        """Family holds everyone's events, so the rest of it doesn't suddenly halve. That tells
        a bad read from a series that really ended, which can take many blocks at once. If it
        stays that way, that's just what Family looks like now."""
        size = int(self.ledger.get_meta(READ_SIZE) or 0)
        reads = int(self.ledger.get_meta(THIN_READS) or 0) + 1
        thin = rest * 2 < size and reads < HOLD_READS
        with self.ledger.tx() as db:
            self.ledger.set_meta(THIN_READS, str(reads if thin else 0), db)
            if not thin:
                self.ledger.set_meta(READ_SIZE, str(rest), db)
        return thin

    def _prove(self, address: str, now: datetime) -> bool:
        """One event on Gmail and off again. Far enough out and at an hour he won't see it,
        and it comes off seconds later."""
        at = now.replace(hour=7, minute=0, second=0, microsecond=0) + timedelta(days=45)
        tried = int(self.ledger.get_meta(TEST_TRY) or 0)
        uid = google_cal.event_id(f"test:{tried}")     # a try whose answer was lost finds itself
        out = self.google.add(address, uid, TEST_TITLE, at, at + timedelta(minutes=15))
        if out.kind == "exists":
            # Its last try came off and the record of that didn't land. Next read, a new id.
            with self.ledger.tx() as db:
                self.ledger.set_meta(TEST_TRY, str(tried + 1), db)
            return False
        if out.kind != "ok":
            self._problem(self._said(out))
            return False
        blocks, why = self.google.list_ours(address, now, now + timedelta(days=AHEAD_DAYS))
        block = next((b for b in blocks or [] if b.id == uid), None)
        if block is None:
            self._problem(self._said(why) if why else
                          "Blocks on Gmail from Family: Google took the test event but doesn't "
                          "show it. Nothing else was written.")
            return False
        out = self.google.remove(address, block)
        if out.kind not in ("ok", "gone"):
            self._problem("Blocks on Gmail from Family: the test event wouldn't come off. It says "
                          f"\"{TEST_TITLE}\". Nothing else was written.")
            return False
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROVEN, iso(now), db)
        log.info("family to gmail: test write and remove worked")
        return True

    def _said(self, out: google_cal.Outcome | None) -> str:
        """Fixed words for each answer: nothing Google sends gets through."""
        kind = out.kind if out else "failed"
        if kind == "auth":
            return ("Blocks on Gmail from Family: Google refused the service account key, so "
                    "nothing changed.")
        if kind == "denied":
            return ("Blocks on Gmail from Family: Google refused. Check your Gmail calendar is "
                    f"shared with {self.google.account()} on \"Make changes and see all event "
                    "details\". "
                    "Nothing changed.")
        return (f"Blocks on Gmail from Family: the last change to Gmail didn't go through ({kind}). "
                "I'll try again at the next read.")

    def _live(self) -> list:
        return self.ledger.db.execute("SELECT * FROM family_gmail WHERE state='live'").fetchall()

    def _problem(self, text: str) -> None:
        if text:
            log.warning("family to gmail: %s", text)
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROBLEM, text, db)

    def _writes_today(self) -> int:
        day_start, _, _ = calendar_feed.today_bounds(self.ledger.now(), self.tz)
        return self.ledger.db.execute(
            "SELECT COUNT(*) FROM events WHERE kind IN ('family_gmail_added','family_gmail_moved',"
            "'family_gmail_cancelled') AND at>=?", (iso(day_start),)).fetchone()[0]

    def _room(self) -> bool:
        return self.writes < MAX_WRITES_PER_DAY

    @staticmethod
    def _when(value: str) -> datetime:
        return datetime.fromisoformat(value)

    # -- what's already there ------------------------------------------------------------
    def _follow(self, address: str, wants: dict, blocks: dict, now: datetime, until: datetime,
                family_clean: bool, thin: bool) -> str:
        gone, absent = [], []
        held = waiting = 0
        failed = ""
        for row in self._live():
            title, start, end = row["title"], self._when(row["start"]), self._when(row["end"])
            if end <= now:
                self._set(row, "done")
                continue
            if start >= until:
                continue                   # past what was read: unread, not gone
            block = blocks.get(row["event_id"])
            want = wants.get(row["key"])
            if block is None:
                absent.append((row, want))
                continue
            if not block.plain:
                self._set(row, "hands_off")    # someone added to it: theirs now
                continue
            if want is not None and self._landed(block, want):
                # Already as it should be: a write whose answer was lost.
                if not (_same(want.start, start) and _same(want.end, end) and want.title == title
                        and want.place == row["place"]):
                    self._moved(row, want)
                elif row["missing"]:
                    self._update(row, missing=0)
                continue
            # A move whose answer was lost, with the event moved again since: still ours.
            if not _was_sent(row["intent"], block) and not (block.title == title and _same(block.start, start)
                                 and _same(block.end, end) and block.location == row["place"]):
                self._set(row, "hands_off")    # someone edited it: theirs now
                continue
            if want is None:
                if family_clean:
                    gone.append((row, block))
                else:
                    held += 1
                    self._update(row, missing=0)
                continue
            if row["missing"]:
                self._update(row, missing=0)
            if not self._room():
                waiting += 1
                continue
            self._update(row, intent=_intent(want.title, want.start, want.end, want.place))
            out = self.google.move(address, block, want.title, want.start, want.end, want.place)
            if out.kind == "ok":
                self._moved(row, want)
            elif out.kind == "changed":
                self._set(row, "hands_off")
            elif out.kind == "gone":
                self._set(row, "lost")
            elif out.kind == "failed":
                failed = self._said(out)       # this one's trouble: the others still go
            else:
                return self._said(out)
        problem = self._absent(address, absent, family_clean)
        problem = self._cancel(address, gone, thin) or problem or failed
        if held and not problem:
            problem = (f"Blocks on Gmail from Family: {held} look cancelled, but part of Family "
                       "couldn't be read, so I left them. Delete any that are wrong.")
        if waiting and not problem:
            problem = self._capped(waiting)
        return problem

    @staticmethod
    def _capped(n: int) -> str:
        return (f"Blocks on Gmail from Family: {n} more changes wait for tomorrow, past today's "
                "limit. Those days may be wrong until then.")

    @staticmethod
    def _landed(block: google_cal.Block, want: Want) -> bool:
        return block.title == want.title and _same(block.start, want.start) \
            and _same(block.end, want.end) and block.location == want.place

    def _absent(self, address: str, absent: list, family_clean: bool) -> str:
        """Gone from Gmail. One read can be wrong, and so can many gone at once for a while."""
        if not absent:
            return ""
        if not family_clean:
            for row, _ in absent:
                self._update(row, missing=0)
            return ""
        if len(absent) > MAX_REMOVALS_AT_ONCE and min(r["missing"] for r, _ in absent) + 1 < HOLD_READS:
            for row, _ in absent:
                self._update(row, missing=row["missing"] + 1)
            return (f"Blocks on Gmail from Family: {len(absent)} blocks look gone from Gmail at "
                    "once. That looks like a bad read, so I changed nothing.")
        problem = ""
        for row, want in absent:
            if row["missing"] + 1 < READS_BEFORE_REMOVING:
                self._update(row, missing=row["missing"] + 1)
            elif not self.google.really_gone(address, row["event_id"]):
                # The list left it out but it's there, or Google won't say. In time, it's been
                # moved out of what's read: his now.
                if row["missing"] + 1 >= GIVE_UP_READS:
                    self._set(row, "hands_off")
                    continue
                self._update(row, missing=row["missing"] + 1)
                problem = ("Blocks on Gmail from Family: Google's list of blocks doesn't match "
                           "what's on Gmail, so I changed nothing. I'll try again.")
            elif want is None:
                self._set(row, "cancelled")    # gone on both sides: nothing to learn
            else:
                self._set(row, "removed")      # taken as his answer, and not put back
                self._log("family_gmail_removed", row["key"])
        return problem

    def _cancel(self, address: str, gone: list, thin: bool) -> str:
        ready = [(row, block) for row, block in gone
                 if row["missing"] + 1 >= READS_BEFORE_REMOVING or row["key"] in self.dropped]
        for row, _ in gone:
            self._update(row, missing=row["missing"] + 1)
        if len(ready) > MAX_REMOVALS_AT_ONCE and thin:
            return (f"Blocks on Gmail from Family: {len(ready)} blocks look cancelled at once. "
                    "That looks like a bad read, so I left them on Gmail.")
        for n, (row, block) in enumerate(ready):
            if not self._room():
                return self._capped(len(ready) - n)
            out = self.google.remove(address, block)
            if out.kind in ("ok", "gone"):
                self._set(row, "cancelled")
                self._log("family_gmail_cancelled", row["key"])
                self.writes += 1
            elif out.kind == "changed":
                self._set(row, "hands_off")
            else:
                return self._said(out)
        return ""

    def _moved(self, row, want: Want) -> None:
        self._update(row, title=want.title, start=want.start.isoformat(), end=want.end.isoformat(),
                     place=want.place, missing=0, intent="")
        self._log("family_gmail_moved", row["key"])
        self.writes += 1
        if self.live is not None and want.state == "confirmed" \
                and row["title"].startswith(google_cal.FREE_PREFIX):
            self.live.applied(want, row["generation"])     # a maybe he now has for sure

    # -- what's new ----------------------------------------------------------------------
    def _add_new(self, address: str, wants: dict) -> str:
        new = []
        for key, want in sorted(wants.items(), key=lambda kv: kv[1].start):
            row = self.ledger.db.execute("SELECT state, start, generation FROM family_gmail"
                                         " WHERE key=?", (key,)).fetchone()
            generation = 0
            if row is not None:
                # Google keeps a deleted id, so a block that comes back gets a new one. A
                # finished block is still on Gmail, so its event needs a new one too.
                again = row["state"] in ("cancelled", "lost") or (
                    row["state"] == "done" and row["start"] != want.start.isoformat())
                if not again:
                    continue
                generation = row["generation"] + 1
            new.append((want, generation))
        failed = ""
        for n, (want, generation) in enumerate(new):
            if not self._room():
                return self._capped(len(new) - n)
            uid = google_cal.event_id(f"{want.key}:{generation}")
            out = self.google.add(address, uid, want.title, want.start, want.end, want.place)
            if out.kind == "exists":
                self._insert(want, uid, generation, "lost")    # that id's used up: the next one
            elif out.kind == "changed":
                self._insert(want, uid, generation, "hands_off")
            elif out.kind == "failed":
                failed = self._said(out)       # this one's trouble: the others still go
            elif out.kind != "ok":
                return self._said(out)
            else:
                self._insert(want, uid, generation)
                self._log("family_gmail_added", want.key)
                self.writes += 1
                if self.live is not None and want.state == "confirmed":
                    self.live.applied(want, generation)    # its receipt, with Undo
        return failed

    # -- his Undo (meaning_live.py) ------------------------------------------------------
    def _undo_requested(self) -> None:
        """Take off the blocks he tapped Undo on, only as they were written. "Wrong time" may
        come back once it's judged again; the others stay off. Not under the day's cap: it's
        his tap."""
        waiting = self.live.removals()
        if not waiting:
            return
        address = self._address()
        if address is None or not self.google.configured():
            return
        for rid, key, action in waiting:
            row = self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=?", (key,)).fetchone()
            after = "cancelled" if action == "wrong_time" else "undone"
            if row is None or row["state"] != "live":
                if not self._drop_legs(address, key):
                    return                     # tried again next tick
                self.live.removed(rid)
                continue
            start, end = self._when(row["start"]), self._when(row["end"])
            blocks, why = self.google.list_ours(address, start - timedelta(minutes=1),
                                                end + timedelta(minutes=1))
            if blocks is None:
                self._problem(self._said(why))
                return
            block = next((b for b in blocks if b.id == row["event_id"]), None)
            if block is None:
                self._set(row, after)
                if not self._drop_legs(address, key):
                    return
                self.live.removed(rid)
                continue
            if not block.plain or not (block.title == row["title"] and _same(block.start, start)
                                       and _same(block.end, end) and block.location == row["place"]):
                self._set(row, "hands_off")    # someone changed it: theirs now
                self.live.removed(rid)
                continue
            out = self.google.remove(address, block)
            if out.kind in ("ok", "gone"):
                self._set(row, after)
                self._log("family_gmail_undone", row["key"])
                if not self._drop_legs(address, key):
                    return
                self.live.removed(rid)
            elif out.kind == "changed":
                self._set(row, "hands_off")
                self.live.removed(rid)
            else:
                return                         # tried again next tick

    def _drop_legs(self, address: str, key: str) -> bool:
        """His Undo takes the event's drives off with it, now, not two reads later: the wait is
        for a bad read, and a tap isn't one. A drive he changed is his and stays. False: Google
        couldn't be reached, so the Undo is tried again next tick."""
        for which in ("there", "back"):
            row = self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=? AND state='live'",
                                         (leg_key(key, which),)).fetchone()
            if row is None:
                continue
            start, end = self._when(row["start"]), self._when(row["end"])
            blocks, why = self.google.list_ours(address, start - timedelta(minutes=1), end + timedelta(minutes=1))
            if blocks is None:
                self._problem(self._said(why))
                return False
            block = next((b for b in blocks if b.id == row["event_id"]), None)
            if block is None:
                self._set(row, "cancelled")
                continue
            if not block.plain or not (block.title == row["title"] and _same(block.start, start)
                                       and _same(block.end, end)):
                self._set(row, "hands_off")
                continue
            out = self.google.remove(address, block)
            if out.kind in ("ok", "gone"):
                self._set(row, "cancelled")
                self._log("family_gmail_undone", row["key"])
            elif out.kind == "changed":
                self._set(row, "hands_off")
            else:
                return False
        return True

    # -- the record ----------------------------------------------------------------------
    def _insert(self, want: Want, uid: str, generation: int, state: str = "live") -> None:
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute(
                "INSERT INTO family_gmail(key, event_id, generation, intent, title, start, end,"
                " state, missing, created_at, updated_at, place) VALUES(?,?,?,'',?,?,?,?,0,?,?,?)"
                " ON CONFLICT(key) DO UPDATE SET event_id=excluded.event_id,"
                " generation=excluded.generation, intent='', title=excluded.title,"
                " start=excluded.start, end=excluded.end, state=excluded.state, missing=0,"
                " updated_at=excluded.updated_at, place=excluded.place",
                (want.key, uid, generation, want.title, want.start.isoformat(),
                 want.end.isoformat(), state, now, now, want.place))

    def _set(self, row, state: str) -> None:
        self._update(row, state=state)

    def _update(self, row, **fields) -> None:
        cols = ", ".join(f"{name}=?" for name in fields)
        with self.ledger.tx() as db:
            db.execute(f"UPDATE family_gmail SET {cols}, updated_at=? WHERE key=?",
                       (*fields.values(), iso(self.ledger.now()), row["key"]))

    def _log(self, kind: str, key: str) -> None:
        with self.ledger.tx() as db:
            self.ledger.event(kind, {"key": key}, db=db)
