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
  * Only a block Google answers as deleted, or one a read found there once that Google later has
    nothing for (it drops a deleted event in time), is taken as his removal. One Google answered
    "ok" to but never had, and no read ever found, is a write that didn't land: written once more,
    its receipt still waiting for the read that finds it (google_cal.gone_how).
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

In live mode, an event he goes to himself, at a place that resolves (a street address in its
location, his place book, or the map by name near home: places.py), also gets its drive: a block
"Busy (drive there)" ending as it starts and one "Busy (drive back)" starting as it ends, never
added to the event's own block, which keeps the event's times. Drives run from home (the
`home_location` option) unless two events in a day are too close to go home between them, in
which case it's straight from one to the next. His own appointments on Gmail get their drives the
same way (an event he owns there, timed, busy, at a place that resolves; not a block made here,
known by its mark, a "Busy" hold, an invitation from someone else, or a call), each instance of a
series on its own, chained with the Family events he goes to,
with a card and Undo for each event's drives (drive_cards.py). They are read from his calendar's
secret iCal feed only, never the API read, and come off only when the feed says so or after two
full reads without them (FamilyGmail._own_events). With the own_drive_dry_run option on, they're
only logged. A drive that can't be found gets the
digest's line and one card (drive_cards.py). Nothing here writes Family. The event's own block carries its street address
(after the place's name, when the map found it by name) or map point, and only that, so it opens
in Maps; that place is ours, and it's compared with what was written,
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

from . import caldav, calendar_feed, drive, drive_cards, family_rules, google_cal, ical, render
from .family_copy import (_SKIP, _STAY, AHEAD_DAYS, GIVE_UP_READS, HOLD_READS, MAX_REMOVALS_AT_ONCE,
                          READS_BEFORE_REMOVING, _same, confirm_soon)
from .ledger import Ledger, iso

log = logging.getLogger("harness.family_gmail")

MAX_WRITES_PER_DAY = 100       # two runs a school day for 60 days fit, and no one's alerted
MAX_RULES = 5
DRIVE_ROUND = 15               # drive blocks are rounded up to whole quarter hours (Dane, Nov 9)
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
# A block he made himself with one of these titles is his own appointment, not a "Busy" hold:
# the add-on's own are known by its mark, never by their title.
_HAND_TITLES = frozenset(t.casefold() for t in (DRIVE_THERE, DRIVE_BACK, *MAYBE_DRIVE.values()))
JUDGE_WAIT = timedelta(hours=24)    # an appointment beside a Family event not judged yet waits this long
JUDGE_BEFORE = timedelta(hours=24)  # or until this long before it starts, whichever is sooner
NEAR_LATER = timedelta(hours=24)    # a drive still waiting for a lookup this near: digest line and card
OWN_MAX_REMOVALS = 3                # more appointments losing drives at once than this asks him first
FEED_OLD = timedelta(hours=6)       # a last full download older than this is named in the digest
FEED_SIZE = "family_gmail_feed_size"       # the last full read's size, in bytes
FEED_SMALL = "family_gmail_feed_small"     # evidence for a smaller feed (_evidence)
OWN_ODD = "family_gmail_own_odd"           # evidence for many appointments gone at once
OWN_SUSPECT = "family_gmail_own_suspect"   # appointments with drives when a shrink was believed
EVIDENCE_READS = 2                  # reads with a new ETag or body hash...
EVIDENCE_SPAN = timedelta(hours=2)  # ...at least this far apart, before odd data is believed
STALE_AFTER = timedelta(hours=24)   # a day of partial reads of Gmail is named in the digest
PARTIAL_SINCE = "family_gmail_partial_since"
OWN_MODE = "family_gmail_own_mode"         # "dry" or "live": leaving the dry run clears what it kept
_DRY_METAS = (FEED_SIZE, FEED_SMALL, OWN_ODD, OWN_SUSPECT, PARTIAL_SINCE)
DRY_COUNTS = "family_gmail_dry_counts"     # the dry run's would-write and would-remove, for the digest
MAX_SAMPLES = 3                     # anonymised feed samples kept for each kind, in the dry run
ADOPT_GENERATIONS = 20              # a block's id, from its key and generation, looked for this far
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


OWN_DAYS_DEFAULT, OWN_DAYS_MAX = 3, 60


def own_days_from_options(data_dir: str) -> int:
    """How many days ahead his own appointments get drives: the own_drive_days option, 1 to 60.
    Missing or unreadable is the short default, never the widest."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("own_drive_days", OWN_DAYS_DEFAULT)
    except (OSError, ValueError, AttributeError):
        return OWN_DAYS_DEFAULT
    if isinstance(value, bool) or not isinstance(value, int):
        return OWN_DAYS_DEFAULT
    return min(max(value, 1), OWN_DAYS_MAX)


def own_dry_run_from_options(data_dir: str) -> bool:
    """The own_drive_dry_run option: his own appointments' drives only logged, never written or
    told. On unless it reads as a plain false: the first live run is a dry run."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("own_drive_dry_run", True)
    except (OSError, ValueError, AttributeError):
        return True
    return value is not False


def cleanup_from_options(data_dir: str) -> bool:
    """The remove_all_blocks option: on, every block carrying the add-on's mark comes off Gmail and
    nothing new is written. Off unless it reads as a plain true."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("remove_all_blocks", False)
    except (OSError, ValueError, AttributeError):
        return False
    return value is True


def _at(t: datetime, zone: ZoneInfo) -> str:
    t = t.astimezone(zone)
    return f"{t:%a %b} {t.day} {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"


_SAMPLE_DROP = frozenset({"DESCRIPTION", "ATTENDEE", "ORGANIZER", "URL", "ATTACH", "COMMENT", "CONTACT",
                          "CONFERENCE", "GEO", "RELATED-TO", "CATEGORIES", "RESOURCES"})


def anonymised(raw: str, uids: set[str]) -> str:
    """The VEVENTs of these series from a feed, anonymised for a fixture: titles and places replaced,
    guests, notes, links and Google's own extras left out, and each uid replaced by a stand-in that
    keeps a split's "_R<date>" suffix. Times and repeat rules are kept as Google wrote them."""
    text = re.sub(r"\r?\n[ \t]", "", raw)
    alias = {}

    def stand_in(uid: str) -> str:
        base, sep, tail = uid.partition("_R")
        name = alias.setdefault(base, f"series{len(alias) + 1}")
        return name + (sep + tail if sep else "") + "@sample"

    out, block, keep = [], None, False
    for line in text.splitlines():
        name = line.split(":", 1)[0].split(";", 1)[0].strip().upper()
        if line.strip().upper() == "BEGIN:VEVENT":
            block, keep = [], False
            continue
        if line.strip().upper() == "END:VEVENT":
            if keep and block is not None:
                out += ["BEGIN:VEVENT", *block, "END:VEVENT"]
            block = None
            continue
        if block is None:
            continue                       # outside an event: his calendar's name and zone stay out
        value = line.split(":", 1)[1] if ":" in line else ""
        if name == "UID":
            keep = value.strip() in uids
            block.append("UID:" + stand_in(value.strip()))
        elif name == "SUMMARY":
            block.append("SUMMARY:Appointment")
        elif name == "LOCATION":
            block.append("LOCATION:1 Sample St\\, Town\\, VA")
        elif name in _SAMPLE_DROP or name.startswith("X-"):
            continue
        else:
            block.append(line)
    if not out:
        return ""
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//harness//anonymised sample//EN", *out,
                         "END:VCALENDAR"]) + "\r\n"


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
    """Not a block from here, and not a "Busy" hold, which may only be drive time. A timed
    appointment from his mail, written busy, is a real one of his (mail_dates.py)."""
    return not (google_cal.made_here(occ.uid.removesuffix("@google.com"), occ.summary, occ.transparent)
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
                 live=None, live_fn=lambda: False, own_days_fn=lambda: OWN_DAYS_MAX,
                 own_dry_fn=lambda: False, cleanup_fn=lambda: False, samples_dir: str | None = None):
        self.cleanup_fn = cleanup_fn       # the remove_all_blocks option
        self.samples_dir = samples_dir     # the dry run's anonymised feed samples go under it
        self.own_days_fn = own_days_fn     # how far ahead his own appointments get drives
        self.own_dry_fn = own_dry_fn       # his own appointments' drives only logged, never written
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
        if self._cleanup_on():
            return ("Blocks on Gmail from Family: clearing. remove_all_blocks is on, so every block Harness made "
                    "comes off Gmail and nothing new is written. Turn it off to start again.")
        if not self._named():
            return ("Blocks on Gmail from Family: off. Nothing is named in Harness's settings, "
                    "or what's there can't be read.")
        if not self.google.configured():
            return ("Blocks on Gmail from Family: waiting. Enter the Google service account key "
                    "on the Harness page.")
        if self.calendar.snapshot.feeds and self._address() is None:
            return ("Blocks on Gmail from Family: waiting. It needs exactly one Gmail calendar's "
                    "secret iCal address on the Harness page.")
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
        return " ".join(x for x in (line, problem, self._ask_line(), self._dry_line()) if x)

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
    def _cleanup_on(self) -> bool:
        try:
            return bool(self.cleanup_fn())
        except Exception:
            return False

    def run(self, *, paused: bool) -> None:
        """Only after a new read. A bug here is a record, never a stopped loop."""
        if self._cleanup_on():
            gen = self.calendar.generation
            if gen != self._seen and not paused:
                self._seen = gen
                try:
                    self._cleanup()
                except Exception as e:
                    log.warning("family to gmail cleanup failed: %s", type(e).__name__)
                    self.ledger.event("family_gmail_failed", {"error": type(e).__name__})
            return
        if not paused and self._live_on():
            try:
                self._undo_requested()
                self._drive_undo()
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

    def _cleanup(self) -> None:
        """The remove_all_blocks option: every block carrying the add-on's mark, from yesterday on, comes off
        Gmail, his edited ones too, and every record of a block on Gmail is closed. Not under the day's
        cap: it's his setting. Nothing new is written while it stays on."""
        address = self._address()
        if address is None or not self.google.configured():
            return
        now = self.ledger.now()
        blocks, why = self.google.list_ours(address, now - timedelta(days=1), now + timedelta(days=AHEAD_DAYS + 2))
        if blocks is None:
            self._problem(self._said(why))
            return
        gone = 0
        for block in blocks:
            out = self.google.remove(address, block)
            if out.kind in ("ok", "gone"):
                gone += 1
            elif out.kind != "changed":
                self._problem(self._said(out))
                return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_gmail SET state='cancelled', updated_at=? WHERE state='live'", (iso(now),))
            self.ledger.event("family_gmail_cleared", {"n": gone}, db=db)
        if gone:
            log.info("family to gmail: removed %d blocks carrying the mark (remove_all_blocks)", gone)
        self._problem("")

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
        day_start, _, _ = calendar_feed.today_bounds(now, self.tz)
        until = day_start + timedelta(days=AHEAD_DAYS + 1)
        since = now - timedelta(days=1)
        if self.ledger.get_meta(PROVEN) is None and not self._proven_before(address, since, until) \
                and not self._prove(address, now):
            return
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
        if self.live is not None:
            self._read_back({b.id: b for b in blocks}, now, until)
            self._read_back_drives({b.id: b for b in blocks}, now, until)
        self._leg_parent: dict[str, str] = {}
        self._kept_own: dict[str, Want] = {}
        self._own_said: dict[str, str] = {}
        self._stale_note = ""
        self._held_note = ""
        self._kept_own = {}
        self._conflicts: list[tuple[str, datetime, datetime]] = []
        self._own_unplaced, self._own_meta, self._own_gone = {}, {}, {}
        self._frozen, self._unsettled, self._said_off = set(), {}, set()
        self._feed_note = ""
        self._dry = False
        # The add-on's own blocks, by its mark (google_cal.MARK, a private extended property that
        # list_ours asks Google for) and by its record: never taken for an appointment of his.
        self._ours = {b.id for b in blocks} | {r["event_id"] for r in self.ledger.db.execute(
            "SELECT event_id FROM family_gmail").fetchall()}
        if self.drives is not None:
            self.drives.begin()            # one allowance of lookups for the whole read
        self.leg_note = ""
        if self._live_on():
            self._dry = bool(self.own_dry_fn())
            self._mode(self._dry)
            if not self._dry:
                self._warm_near(now)
            # What each event was judged to mean, model-free here: the judgments are stored.
            judged = self.live.wants(family.items, now, find=getattr(self.drives, "find_place", None))
            self.dropped = set()
            self._last = None
            runs = {k: w for k, w in judged.items() if w.title in _RUN_TITLES}
            own = {k: w for k, w in judged.items() if k not in runs}
            named = self._not_busy(own)
            # From every event he goes to, even one Gmail already has him busy for: he often
            # puts it there himself, and the drive is still his. His own appointments on Gmail
            # too, chained with them; theirs are drive blocks only.
            if self._dry:
                # Family events' drives first, from them alone, as before his appointments had any:
                # nothing his appointments would get can stop, move or starve one of them.
                legs = self._drive_legs(own, now)
                if self.drives is not None:
                    self.drives.side = "dry:"   # its lookups kept apart: no Family drive gains from them
                try:
                    mine = self._own_events(own, now, until)
                    self._dry_run(own, mine, now)
                finally:
                    if self.drives is not None:
                        self.drives.side = ""
                self.leg_note = " ".join(x for x in (self.leg_note, self._own_notes()) if x)
            else:
                mine = self._own_events(own, now, until)
                legs = self._drive_legs({**own, **mine}, now)
            legs = {**self._kept_own, **legs}      # a kept drive stays exactly as it is
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
        blocks = {b.id: b for b in blocks}
        self._adopt(address, wants, blocks)
        problem = self._follow(address, wants, blocks, now, until,
                               family.unreadable == 0, self._thin(len(family.items) - len(named)))
        added = self._add_new(address, wants)
        # A missing drive is named even beside another problem: it's never left off silently.
        self._problem(" ".join(x for x in (problem or added or self.school_note or self.me_note,
                                           self.leg_note) if x) or self._unwritten(now))
        confirm_soon(self.ledger, "family_gmail", self.calendar)

    def _proven_before(self, address: str, since: datetime, until: datetime) -> bool:
        """A calendar that already holds blocks with the add-on's mark has been written before (a state
        file lost, say): no test event is needed again."""
        blocks, _ = self.google.list_ours(address, since, until)
        if not [b for b in blocks or [] if b.title != TEST_TITLE]:   # the test event itself proves nothing
            return False
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROVEN, iso(self.ledger.now()), db)
        return True

    def _adopt(self, address: str, wants: dict[str, Want], blocks: dict) -> None:
        """Blocks with the add-on's mark that no record knows (the state file lost or emptied) become
        records again, never written twice: by the id the add-on gives each block (its key and
        generation), and, when no record at all is left, by title and times: a drive beside its
        appointment (ending as it starts, or starting as it ends; the key is the appointment's uid and
        original start), any other block at its exact times. An exact duplicate of a block kept (same
        title, times and place) comes off."""
        rows = self.ledger.db.execute("SELECT key, event_id FROM family_gmail").fetchall()
        known_ids, known_keys = {r["event_id"] for r in rows}, {r["key"] for r in rows}
        orphans = {i: b for i, b in blocks.items() if i not in known_ids}
        if not orphans:
            return
        empty = not rows
        legs = {DRIVE_THERE, DRIVE_BACK, *MAYBE_DRIVE.values()}
        adopted = 0
        for key, want in sorted(wants.items(), key=lambda kv: kv[1].start):
            if key in known_keys:
                continue
            found, generation = None, 0
            for g in range(ADOPT_GENERATIONS):
                b = orphans.get(google_cal.event_id(f"{key}:{g}"))
                if b is not None:
                    found, generation = b, g
                    break
            if found is None and empty:
                for b in sorted(orphans.values(), key=lambda b: b.id):
                    if b.title != want.title or not b.plain:
                        continue
                    if want.title in legs and want.title.endswith("there)") and _same(b.end, want.end) or \
                            want.title in legs and want.title.endswith("back)") and _same(b.start, want.start) or \
                            want.title not in legs and _same(b.start, want.start) and _same(b.end, want.end):
                        found = b
                        break
            if found is None or not found.plain:
                continue
            del orphans[found.id]
            now = iso(self.ledger.now())
            with self.ledger.tx() as db:
                db.execute("INSERT INTO family_gmail(key, event_id, generation, intent, title, start, end, state,"
                           " missing, created_at, updated_at, place, rewritten, seen)"
                           " VALUES(?,?,?,'',?,?,?,'live',0,?,?,?,0,1)",
                           (key, found.id, generation, found.title, found.start.isoformat(), found.end.isoformat(),
                            now, now, found.location))
                self.ledger.event("family_gmail_adopted", {"key": key}, db=db)
            adopted += 1
        kept = {(r["title"], self._when(r["start"]).astimezone(timezone.utc), self._when(r["end"]).astimezone(timezone.utc),
                 r["place"]) for r in self._live()}
        for i, b in sorted(orphans.items()):
            sig = (b.title, b.start.astimezone(timezone.utc), b.end.astimezone(timezone.utc), b.location)
            if not b.plain or sig not in kept:
                continue
            out = self.google.remove(address, b)
            if out.kind in ("ok", "gone"):
                del blocks[i]
                self._log("family_gmail_duplicate_removed", i)
        if adopted:
            log.info("family to gmail: %d blocks on Gmail had no record and were taken back", adopted)

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
            notes.append("Blocks on Gmail from Family: the school's address in Harness's settings doesn't "
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

    def _gmail_feed(self):
        """His Gmail calendar's feed as last read (calendar_feed.FeedResult), or None."""
        return next((res for res in self.calendar.snapshot.feeds.values() if res.window is not None
                     and res.window.calendar.casefold().endswith("@gmail.com")), None)

    # -- the dry run kept apart ------------------------------------------------------------
    def _m(self, name: str) -> str:
        """A count or baseline's own name: the dry run keeps its own, so nothing it sets carries
        into live mode."""
        return name + ":dry" if getattr(self, "_dry", False) else name

    def _ck(self, key: str) -> str:
        """An appointment's record in drive_cards: the dry run's are kept apart (kind "dry")."""
        return "dry:" + key if getattr(self, "_dry", False) else key

    def _own_kind(self) -> str:
        return "dry" if getattr(self, "_dry", False) else "own"

    def _mode(self, dry: bool) -> None:
        """Leaving the dry run: its records, counts and baselines go, whatever they said."""
        was = self.ledger.get_meta(OWN_MODE)
        now_mode = "dry" if dry else "live"
        if was == now_mode:
            return
        with self.ledger.tx() as db:
            if not dry:
                for name in _DRY_METAS:
                    self.ledger.set_meta(name + ":dry", "", db)
                db.execute("DELETE FROM meta WHERE key LIKE 'dry:drive_%'")   # the dry run's own lookups
            self.ledger.set_meta(OWN_MODE, now_mode, db)
        if not dry and self.live is not None:
            self.live.drive_cards.clear_dry()

    def _would_have(self, key: str, row, now: datetime) -> bool:
        """Has drives on Gmail now, or, in the dry run, would have them."""
        if self._has_legs(key, now):
            return True
        return getattr(self, "_dry", False) and bool(row["until"]) and self._when(row["until"]) > now

    # -- his own appointments ---------------------------------------------------------------
    def _own_events(self, family: dict[str, Want], now: datetime, until: datetime) -> dict[str, Want]:
        """His own appointments on Gmail, as events to drive to (no block of their own is
        written): ones he owns (no organizer, or him), timed, busy, not declined or tentative, and
        real (not a block made here: its mark, its id, or a drive's title with no place; not a
        "Busy" hold), not a call or a link, with a location the place book or the map can place
        (places.py). One at the same time as a Family event he goes to is that event: its drives
        come from there.

        The source is the secret iCal feed of his Gmail calendar, as Google sent it and the add-on's
        own expander read it (ical.window: repeat rules, excluded dates, overrides by their
        recurrence id, and overrides with no master kept as they are), never the read through
        Google's API that stands in for it elsewhere (calendar_feed.FeedResult.feed_ahead). Each
        instance is keyed by its series uid and its original start.

        Drives come off an appointment only when the feed says it's gone (an excluded date, a
        cancelled override, the series ended before it, or it's there but no longer wants drives),
        or when it's missing from two full reads in a row. A read that isn't full (_full_read) keeps
        every drive as it is and writes nothing. An appointment missing from one full read keeps its
        drives, and no drive is made or changed for any other appointment that day until a full read
        settles it. A series split with "this and following" is the old series ending where the new
        one starts: its drives go on under the new series, moved if the time or place changed, never
        removed (_splits). A believed shrink of the feed, or more than 3 appointments losing their
        drives at once, asks him first (_gate). Drives kept as they are (frozen) are never a stop in a
        chain: Family events, read in full, are worked out without them."""
        self._own_unplaced: dict[str, tuple[datetime, str, str]] = {}
        self._frozen: set[str] = set()     # his appointments whose drives stay as they are
        self._unsettled: dict[str, datetime] = {}   # kept only because a read didn't settle them
        self._own_meta: dict[str, tuple[str, str, str]] = {}   # key -> (series uid, place, instance)
        self._own_gone: dict[str, datetime] = {}   # appointments whose drives come off at this read
        self._said_off: set[str] = set()   # of those, ones the feed itself says are gone
        self._feed_note = ""
        self._shrunk = False
        drives = self.drives
        if self.live is None or drives is None or not hasattr(drives, "between") or not drives.home_on():
            return {}
        cards = self.live.drive_cards
        ck = self._ck
        dry = getattr(self, "_dry", False)
        off = cards.off()
        res = self._gmail_feed()
        self._feed_note = self._feed_age(res, now)
        if not self._full_read(res, now):
            self._partial_read(now)
            self._freeze_all(off)
            return {}
        ahead, read = res.feed_ahead, self._read_id(res)
        day_start = calendar_feed.today_bounds(now, self.tz)[0]
        horizon = now + timedelta(days=self.own_days_fn())
        me = (self._address() or "").casefold()
        find = getattr(drives, "find_place", None)
        from .meaning import shown            # meaning.py imports this module
        read_keys: set[str] = set()
        out: dict[str, Want] = {}
        for o in sorted(ahead.occurrences, key=lambda o: o.start if isinstance(o.start, datetime) else now):
            key = _key(o, "own")
            if isinstance(o.start, datetime):
                read_keys.add(key)
            if o.all_day or not isinstance(o.start, datetime) or o.transparent or not self._his_own(o):
                continue
            if o.partstat in ("DECLINED", "TENTATIVE"):
                continue                       # he isn't going, or isn't sure he is
            if o.organizer and o.organizer.casefold() != me:
                continue                       # someone else's invitation, not his own
            if o.end <= now:
                if self._freeze(key):
                    self._frozen.add(key)      # over: a drive home under way stays as it is
                continue
            if o.start >= min(until, horizon) or o.end <= o.start:
                continue                       # past how far ahead he asked for
            location = (o.location or "").strip()
            if not location or drive.is_online(location) or drive.is_online(o.summary) \
                    or drive.is_a_call(o.summary, location):
                continue                       # nowhere to drive to: a call, telehealth, or no place
            if any(f.start < o.end and f.end > o.start and (f.place or not f.legs) for f in family.values()
                   if f.kind == "me"):
                self._own_gone[key] = o.start  # the Family event he goes to: its drives already
                continue
            if key in off:
                continue
            self._own_said[key] = shown(o.summary)
            if any(s < o.end and e > o.start for s, e in getattr(self.live, "unjudged", ())):
                # A Family event there isn't judged yet: wait for it, but not for good. Until the
                # earlier of a day from now or a day before it starts; then from home, worked out
                # again once the judgment lands.
                since = cards.waiting_since(ck(key), self._own_said[key], o.start, now, kind=self._own_kind())
                if now < min(since + JUDGE_WAIT, o.start - JUDGE_BEFORE):
                    if self._freeze(key):
                        self._frozen.add(key)  # drives it already has stay while it waits
                    continue
            where, ask = self.live.places.resolve(location, find)
            if not where:
                if self._freeze(key):
                    self._frozen.add(key)      # its drives stay until its place is found again
                if ask and not dry:            # the dry run asks him nothing
                    self.live.places.unresolved(location, o.summary, o.start)
                if self.live.places.later:
                    if o.start < now + NEAR_LATER:   # too near to wait quietly: digest and card
                        self._own_unplaced[key] = (o.start, self._own_said[key], drive_cards.LATER)
                elif self.live.places.findable(location):
                    self._own_unplaced[key] = (o.start, self._own_said[key],
                                               drive_cards.PLACE if ask else drive_cards.FAILED)
                continue
            self._own_meta[key] = (o.uid, where, o.instance)
            out[key] = Want(key, "", o.start, o.end, "own", "confirmed", where)
            if dry and o.instance and o.instance != ical._key(o.start):
                self._sample(res, "edit", {o.uid})     # one week of a series moved on its own
        rows = {r["key"].removeprefix("dry:"): r for r in cards.own_rows(self._own_kind())}
        if self._shrunk:
            # The feed shrank and that's believed now: every appointment with drives at this moment
            # asks him before its drives come off.
            self._set_suspects(self._suspects() | {k for k, r in rows.items() if self._would_have(k, r, now)})
        for key, row in rows.items():
            if key in read_keys:
                cards.found(ck(key))
                cards.clear_hold(ck(key))      # back in a read: a later removal asks again
            if key in off or key in out or key in self._frozen or key in self._own_gone:
                continue
            if not self._would_have(key, row, now):
                continue
            if key in read_keys:
                self._own_gone[key] = self._when(row["start"])   # read, and no longer wants drives
            elif self._said_gone(row, ahead, day_start, until):
                self._own_gone[key] = self._when(row["start"])
                self._said_off.add(key)
            elif cards.missed(ck(key), read) >= READS_BEFORE_REMOVING:
                self._own_gone[key] = self._when(row["start"])
            else:
                if self._freeze(key):
                    self._frozen.add(key)      # missing from one full read: kept, not a chain stop
                self._unsettled[key] = self._when(row["start"])
        self._splits(res, ahead, rows, out, read_keys)
        self._gate(res, now)
        self._settle_days(out)
        if dry:
            for key in self._said_off & set(self._own_gone):
                row = rows.get(key)
                if row is not None and row["uid"]:
                    self._sample(res, "cancel", {row["uid"]})   # one week taken out of a series
        self._set_suspects({k for k in self._suspects() if k not in read_keys and k in rows
                            and self._would_have(k, rows[k], now)})
        for key in self._own_gone:
            self._superseded(key)
        self._clean_read()
        return out

    def _orig(self, inst: str) -> datetime | None:
        try:
            return (datetime.strptime(inst, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc) if "T" in inst
                    else datetime.strptime(inst, "%Y%m%d").replace(tzinfo=ZoneInfo(self.tz)))
        except ValueError:
            return None

    def _splits(self, res, ahead, rows: dict, out: dict[str, Want], read_keys: set[str]) -> None:
        """A series split in two ("this and following"), found by continuity: the old series, read
        in full and with an end (UNTIL or COUNT), lost a tail of instances after its last one left,
        and a series not seen before starts after that last one and before the second lost one,
        whatever its time or place. The lost instances (overrides of the old series included) go on,
        in order, under the new series' instances: the same records, moved if the time or place
        changed, never a removal and never counted as one."""
        timed: dict[str, list] = {}
        for o in ahead.occurrences:
            if isinstance(o.start, datetime) and not o.all_day:
                timed.setdefault(o.uid, []).append(o)
        known = {r["uid"] for r in rows.values() if r["uid"]}
        tails: dict[str, list[tuple[datetime, str]]] = {}
        for key in list(self._own_gone):
            row = rows.get(key)
            if row is None or key in read_keys or not row["uid"] or not row["inst"]:
                continue
            uid = row["uid"]
            if uid not in getattr(ahead, "series", ()):
                continue
            orig = self._orig(row["inst"])
            if orig is not None:
                tails.setdefault(uid, []).append((orig, key))
        zone = ZoneInfo(self.tz)
        for uid, tail in tails.items():
            # The same series re-timed as a whole ("all events"): each lost instance and a new instance of
            # that series on the same day are one appointment, moved.
            fresh = {}
            for o in timed.get(uid, []):
                if _key(o, "own") not in rows:
                    fresh.setdefault(o.start.astimezone(zone).date(), []).append(o)
            for orig, old in sorted(tail):
                day = self._when(rows[old]["start"]).astimezone(zone).date()
                if len(fresh.get(day, [])) != 1:
                    continue
                new = _key(fresh.pop(day)[0], "own")
                if self._rekey(old, new):
                    del self._own_gone[old]
                    self._said_off.discard(old)
                    if new not in out and self._freeze(new):
                        self._frozen.add(new)
            tail[:] = [t for t in tail if t[1] in self._own_gone]
        for uid, tail in tails.items():
            if not tail or uid not in getattr(ahead, "bounded", ()):
                continue                       # only a series with an end can be the old half of a split
            left = [o.start for o in timed.get(uid, [])]
            last = max(left) if left else None
            tail = sorted(t for t in tail if last is None or t[0] > last)
            if not tail:
                continue
            first = tail[0][0]
            second = tail[1][0] if len(tail) > 1 else first + timedelta(days=7)
            best, gap = None, None
            for v, occs in timed.items():
                if v == uid or v in known or v not in getattr(ahead, "series", ()):
                    continue
                f = min(o.start for o in occs)
                if (last is None or f > last) and first - (second - first) < f < second:
                    if gap is None or abs(f - first) < gap:
                        best, gap = v, abs(f - first)
            if best is None:
                continue
            news = sorted(timed[best], key=lambda o: o.start)
            kept = 0
            for (_, old), o in zip(tail, news):
                new = _key(o, "own")
                if new in rows or not self._rekey(old, new):
                    continue
                del self._own_gone[old]
                self._said_off.discard(old)
                kept += 1
                if new not in out and self._freeze(new):
                    self._frozen.add(new)      # its new self isn't placed yet: kept as it is
            if kept:
                log.info("family to gmail: a split series kept its drives (%d)", kept)
                if getattr(self, "_dry", False):
                    self._sample(res, "split", {uid, best})

    def _settle_days(self, out: dict[str, Want]) -> None:
        """An appointment kept only because a read didn't settle it (missing from one full read, or its
        removal waiting for his answer): nothing is made, moved or taken off for his appointments that
        day until a full read, or his answer, does."""
        if not self._unsettled:
            return
        zone = ZoneInfo(self.tz)
        days = {s.astimezone(zone).date() for s in self._unsettled.values()}
        for key in [k for k, w in out.items() if w.start.astimezone(zone).date() in days]:
            del out[key]
            if self._freeze(key):
                self._frozen.add(key)
        for key in [k for k, s in self._own_gone.items() if s.astimezone(zone).date() in days]:
            del self._own_gone[key]
            if self._freeze(key):
                self._frozen.add(key)

    def _gate(self, res, now: datetime) -> None:
        """Removals on odd data wait for his go. When the feed's shrink was believed (those
        appointments are kept as suspects) or more than 3 appointments lose their drives at once,
        nothing comes off until he taps Take them off on one card listing them by day and time; Keep
        them keeps them. The card goes out only once the oddity has held over reads with a new ETag or body
        hash, at least 2 hours apart (_evidence); until then the digest says so."""
        cards, ck = self.live.drive_cards, self._ck
        gone = self._own_gone
        suspect = self._suspects()
        holds = {k: cards.hold(ck(k)) for k in gone}
        odd = len(gone) > OWN_MAX_REMOVALS or bool(set(gone) & suspect)
        if odd:
            waiting = {k: s for k, s in gone.items() if holds[k] != "approved"}
        else:
            waiting = {k: s for k, s in gone.items() if holds[k] in ("asked", "kept")}
            self._evidence(self._m(OWN_ODD), res, now, reset=True)
        if not waiting:
            return
        for key, start in waiting.items():
            del gone[key]
            self._said_off.discard(key)
            if self._freeze(key):
                self._frozen.add(key)
            if holds[key] != "kept":
                self._unsettled[key] = start   # nothing new that day while it waits for his answer
        fresh = {k: s for k, s in waiting.items() if holds[k] == ""}
        if not fresh:
            if any(holds[k] == "asked" for k in waiting):
                self._held_note = ("Blocks on Gmail from Family: drive blocks for some of your own appointments wait "
                                   "for your answer on the card before they come off.")
            return
        why = "shrink" if set(fresh) & suspect else "many"
        # A believed shrink has already held over reads (_full_read): it asks at once.
        if why == "many" and not self._evidence(self._m(OWN_ODD), res, now):
            self._held_note = (f"Blocks on Gmail from Family: {len(fresh)} of your own appointments look gone from "
                               "your Gmail calendar at once, which may be a bad read, so their drive blocks stay. "
                               "If it holds, I'll ask you first.")
            return
        items = sorted(fresh.items(), key=lambda kv: kv[1])
        if getattr(self, "_dry", False):
            zone = ZoneInfo(self.tz)
            log.info("drive dry run: would ask before removing the drive blocks for %d appointments: %s", len(items),
                     "; ".join(_at(s, zone) for _, s in items))
            cards.ask_removals(None, [(ck(k), s) for k, s in items], why, now, send=False)
            return
        if cards.ask_removals(self.live.chat_id, [(ck(k), s) for k, s in items], why, now):
            self._held_note = ("Blocks on Gmail from Family: drive blocks for some of your own appointments wait "
                               "for your answer on the card before they come off.")
        else:                              # no one to ask yet: kept, and asked at a later read
            self._held_note = (f"Blocks on Gmail from Family: {len(items)} of your own appointments look gone from "
                               "your Gmail calendar, so their drive blocks stay until you're asked about them.")

    def _suspects(self) -> set[str]:
        try:
            return set(json.loads(self.ledger.get_meta(self._m(OWN_SUSPECT)) or "[]"))
        except ValueError:
            return set()

    def _set_suspects(self, keys: set[str]) -> None:
        with self.ledger.tx() as db:
            self.ledger.set_meta(self._m(OWN_SUSPECT), json.dumps(sorted(keys)) if keys else "", db)

    def _evidence(self, name: str, res, now: datetime, *, reset: bool = False) -> bool:
        """Reads that say the same odd thing, counted only with a new ETag or body hash (a 304, or the
        same body again, is no new evidence). Believed with 2 such reads at least 2 hours apart."""
        if reset:
            with self.ledger.tx() as db:
                self.ledger.set_meta(name, "", db)
            return False
        try:
            seen = json.loads(self.ledger.get_meta(name) or "{}")
        except ValueError:
            seen = {}
        etag, body = str(getattr(res, "etag", "") or ""), str(getattr(res, "body_hash", "") or "")
        ids = set(seen.get("ids", []))
        marks = [m for m in (("e:" + etag) if etag else "", ("h:" + body) if body else "") if m] \
            or ["r:" + self._read_id(res)]
        if any(m not in ids for m in marks):
            ids |= set(marks)
            seen = {"ids": sorted(ids)[-50:], "n": seen.get("n", 0) + 1,
                    "first": seen.get("first") or iso(now), "last": iso(now)}
            with self.ledger.tx() as db:
                self.ledger.set_meta(name, json.dumps(seen), db)
        if not seen.get("n"):
            return False
        span = datetime.fromisoformat(seen["last"]) - datetime.fromisoformat(seen["first"])
        return seen["n"] >= EVIDENCE_READS and span >= EVIDENCE_SPAN

    def _read_id(self, res) -> str:
        """This download of the feed, so a read looked at twice counts once."""
        return str(getattr(res, "read_id", "") or self.calendar.generation)

    def _full_read(self, res, now: datetime) -> bool:
        """A full read of his Gmail calendar's feed: Google answered 200, the body ends with
        END:VCALENDAR, every event in it could be read, and it isn't under half the size of the last
        full one. A smaller one is believed only once it has held over reads with a new ETag or body
        hash at least 2 hours apart (_evidence); then it's full, and every appointment with drives
        then asks him before its drives come off (_gate)."""
        ahead = getattr(res, "feed_ahead", None)
        if ahead is None or not ahead.occurrences or ahead.unreadable:
            return False
        if getattr(res, "status", 200) != 200 or not getattr(res, "complete", True):
            return False
        size = int(getattr(res, "size", 0) or 0)
        if not size:
            return True
        last = int(self.ledger.get_meta(self._m(FEED_SIZE)) or 0)
        if last and size * 2 < last:
            if not self._evidence(self._m(FEED_SMALL), res, now):
                return False
            self._shrunk = True
        with self.ledger.tx() as db:
            self.ledger.set_meta(self._m(FEED_SIZE), str(size), db)
        self._evidence(self._m(FEED_SMALL), res, now, reset=True)
        return True

    def _gmail_fid(self) -> str | None:
        return next((fid for fid, res in self.calendar.snapshot.feeds.items() if res.window is not None
                     and res.window.calendar.casefold().endswith("@gmail.com")), None)

    def _feed_age(self, res, now: datetime) -> str:
        """Named in the digest when the last successful download (Google answering 200) is more than 6
        hours old. Google's Last-Modified isn't used: it says when Google's copy last changed, not how
        old it is."""
        if res is None:
            return ""
        times = []
        fid = self._gmail_fid()
        try:
            kept = json.loads(self.ledger.get_meta(f"calendar_headers:{fid}") or "{}") if fid else {}
            if kept.get("at"):
                times.append(datetime.fromisoformat(kept["at"]))
        except (ValueError, TypeError, AttributeError):
            pass
        if isinstance(getattr(res, "fetched_at", None), datetime):
            times.append(res.fetched_at)
        times = [t for t in times if t.tzinfo is not None]
        if not times or now - max(times) <= FEED_OLD:
            return ""
        hours = int((now - max(times)).total_seconds() // 3600)
        return (f"Blocks on Gmail from Family: your Gmail calendar was last downloaded in full {hours} hours ago, so "
                "the drives around your own appointments may be behind it.")

    def _said_gone(self, row, ahead, day_start: datetime, until: datetime) -> bool:
        """The feed itself says this instance is gone: its series was read in full, its original
        start is in what was read, and the series no longer has it (an excluded date, a cancelled
        override, the series ended before it). A one-off event missing says nothing by itself."""
        inst = row["inst"]
        if not inst or not row["uid"] or row["uid"] not in getattr(ahead, "series", ()):
            return False
        orig = self._orig(inst)
        return orig is not None and day_start <= orig < until

    def _has_legs(self, key: str, now: datetime) -> bool:
        return any(self._when(r["end"]) > now for r in self.ledger.db.execute(
            "SELECT end FROM family_gmail WHERE key IN (?,?) AND state='live'",
            (leg_key(key, "there"), leg_key(key, "back"))))

    def _rekey(self, old: str, new: str) -> bool:
        """The old instance's drives, as they are on Gmail, become the new one's: nothing written
        here (a changed time or place moves them as an update), nothing told twice. False when the
        new key has a record of its own. The dry run moves only its own records."""
        if getattr(self, "_dry", False):
            self.live.drive_cards.rekey(self._ck(old), self._ck(new))
            return True
        pairs = [(leg_key(old, w), leg_key(new, w)) for w in ("there", "back")]
        if self.ledger.db.execute("SELECT COUNT(*) FROM family_gmail WHERE key IN (?,?)",
                                  tuple(n for _, n in pairs)).fetchone()[0]:
            return False
        with self.ledger.tx() as db:
            for o, n in pairs:
                db.execute("UPDATE family_gmail SET key=? WHERE key=?", (n, o))
        self.live.drive_cards.rekey(old, new)
        return True

    def _freeze_all(self, off: set[str]) -> None:
        """A read that isn't full: every appointment's drives stay as they are."""
        for row in self.live.drive_cards.own_rows():
            if row["key"] not in off and self._freeze(row["key"]):
                self._frozen.add(row["key"])

    def _warm_near(self, now: datetime) -> None:
        """Lookups go soonest first: the drives from home to his own appointments in the next day
        are asked before anything else this read, so far-off places (a Family event's name on
        the map, say) can't use up the allowance and leave a near one waiting. Kept answers cost
        nothing. Not in the dry run: there Family events' lookups come first."""
        drives = self.drives
        res = self._gmail_feed()
        ahead = getattr(res, "feed_ahead", None)
        if drives is None or not hasattr(drives, "between") or not drives.home_on() or ahead is None:
            return
        near = sorted((o for o in ahead.occurrences if isinstance(o.start, datetime) and not o.all_day
                       and now < o.end and o.start < now + NEAR_LATER), key=lambda o: o.start)
        for o in near:
            address = drive.street_address(o.location or "")
            if address and self._his_own(o) and not drive.is_online(o.location) \
                    and not drive.is_a_call(o.summary, o.location):
                drives.between(drive.HOME, address)

    def _his_own(self, o: ical.Occurrence) -> bool:
        """A real appointment of his: not a block the add-on wrote (its mark, the private extended
        property Google keeps on it, as this read of Gmail's blocks found it; its id, as the feed
        spells it; or a drive's title with no place, which is how the add-on writes them), and not a
        "Busy" hold, though a block he made himself with a drive's title and a place is his."""
        uid = o.uid.removesuffix("@google.com")
        if uid in getattr(self, "_ours", ()) or google_cal.made_here(uid, o.summary, o.transparent):
            return False
        title = o.summary.strip().casefold()
        if title in _HAND_TITLES:
            return bool((o.location or "").strip())
        return not title.startswith("busy")

    def _freeze(self, key: str) -> bool:
        """His appointment's live drives, kept exactly as they are for this read. False: it has none."""
        kept = False
        for which in ("there", "back"):
            row = self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=? AND state='live'",
                                         (leg_key(key, which),)).fetchone()
            if row is not None:
                state = "provisional" if row["title"] in MAYBE_DRIVE.values() else "confirmed"
                self._kept_own[row["key"]] = Want(row["key"], row["title"], self._when(row["start"]),
                                                  self._when(row["end"]), "", state, row["place"])
                kept = True
        return kept

    def _superseded(self, key: str) -> None:
        """An appointment of his whose drives are known to be wrong now: they come off at this read."""
        self.dropped |= {leg_key(key, "there"), leg_key(key, "back")}

    def _clean_read(self) -> None:
        with self.ledger.tx() as db:
            self.ledger.set_meta(self._m(PARTIAL_SINCE), "", db)

    def _partial_read(self, now: datetime) -> None:
        """A read of Gmail cut short. After a day of them, the digest says so."""
        since = self.ledger.get_meta(self._m(PARTIAL_SINCE))
        if not since:
            with self.ledger.tx() as db:
                self.ledger.set_meta(self._m(PARTIAL_SINCE), iso(now), db)
            return
        if now - datetime.fromisoformat(since) >= STALE_AFTER:
            self._stale_note = ("Blocks on Gmail from Family: your Gmail calendar hasn't been read in full for a "
                                "day, so the drives around your own appointments haven't changed since. I'll "
                                "keep trying.")

    def _own_notes(self) -> str:
        return " ".join(x for x in (getattr(self, "_stale_note", ""), getattr(self, "_held_note", ""),
                                    getattr(self, "_feed_note", "")) if x)

    def _dry_run(self, own: dict[str, Want], mine: dict[str, Want], now: datetime) -> None:
        """The first live run (the own_drive_dry_run option): the drives his own appointments would
        get, and the ones that would come off, in the log with the event's day and time, and nothing
        written, sent or kept as written for them. Family events' drives were already worked out
        without them (_sync), so nothing here can change those."""
        zone = ZoneInfo(self.tz)
        preview = self._drive_legs({**own, **mine}, now, quiet=True)
        writes, removes = set(), set()
        for key, want in sorted(preview.items(), key=lambda kv: kv[1].start):
            parent = self._leg_parent.get(key)
            if parent not in mine:
                continue
            writes.add(key)
            log.info("drive dry run: would write %s, %s to %s, for the appointment on %s", want.title,
                     _at(want.start, zone), _at(want.end, zone), _at(mine[parent].start, zone))
        for key, start in sorted(self._own_gone.items(), key=lambda kv: kv[1]):
            removes.add(key)
            log.info("drive dry run: would remove the drive blocks for the appointment on %s", _at(start, zone))
            self.live.drive_cards.forget(self._ck(key))   # said once: it has no drives to take off again
        self._count_dry(writes, removes)
        for key in (*mine, *self._own_gone):
            for which in ("there", "back"):
                self.dropped.discard(leg_key(key, which))
        self._leg_parent = {}
        self._own_unplaced = {}
        self._own_said = {}
        self._freeze_all(set())        # anything already written for him stays exactly as it is

    def _count_dry(self, writes: set[str], removes: set[str]) -> None:
        """For the digest: how many drive blocks would be written, and appointments' drives removed."""
        try:
            kept = json.loads(self.ledger.get_meta(DRY_COUNTS) or "{}")
        except ValueError:
            kept = {}
        w, r = set(kept.get("write", [])) | writes, set(kept.get("remove", [])) | removes
        with self.ledger.tx() as db:
            self.ledger.set_meta(DRY_COUNTS, json.dumps({"write": sorted(w), "remove": sorted(r)}), db)

    def _dry_line(self) -> str:
        """While the dry run is on: the counts since the last digest, then they start again."""
        try:
            kept = json.loads(self.ledger.get_meta(DRY_COUNTS) or "{}")
        except ValueError:
            kept = {}
        with self.ledger.tx() as db:
            self.ledger.set_meta(DRY_COUNTS, "", db)
        if not self._live_on() or not self.own_dry_fn():
            return ""
        w, r = len(kept.get("write", [])), len(kept.get("remove", []))
        return (f"Drive dry run since the last digest: {w} drive block{'' if w == 1 else 's'} would be written and "
                f"{r} appointment{'' if r == 1 else 's'} would lose {'its' if r == 1 else 'their'} drive blocks. "
                "Nothing was written for them; the log has each one.")

    def _sample(self, res, kind: str, uids: set[str]) -> None:
        """The dry run keeps a few real examples, anonymised (titles and places replaced, guests and notes
        left out), in the data folder for fixtures later: a split, a cancelled week, a moved week."""
        if not self.samples_dir or not uids or not getattr(res, "raw", ""):
            return
        try:
            folder = os.path.join(self.samples_dir, "drive_samples")
            os.makedirs(folder, exist_ok=True)
            have = sorted(f for f in os.listdir(folder) if f.startswith(kind + "-"))
            tag = hashlib.sha256("|".join(sorted(uids)).encode()).hexdigest()[:10]
            if len(have) >= MAX_SAMPLES or any(tag in f for f in have):
                return
            text = anonymised(res.raw, uids)
            if not text:
                return
            with open(os.path.join(folder, f"{kind}-{tag}.ics"), "w", encoding="utf-8") as f:
                f.write(text)
            log.info("drive dry run: kept an anonymised sample of a %s", kind)
        except OSError as e:
            log.info("drive dry run: couldn't keep a sample (%s)", type(e).__name__)

    def _drive_legs(self, wants: dict[str, Want], now: datetime, quiet: bool = False) -> dict[str, Want]:
        """The drives to and from the events he goes to, as their own blocks. In a day, in time
        order: straight from one event to the next when there isn't time to go home between,
        else home and out again. A drive that can't be found is left off, the digest names the
        event's time (nothing else from it), and he gets one card for it (drive_cards.py). His
        appointments whose drives are kept as they are (frozen: not read in full) are no stop in
        any chain, and never keep a drive off. A kept drive stays exactly as it is, busy: one that a
        drive worked out now crosses is named in the digest, with a card when that event is within a
        day, and nothing on Gmail changes for it.
        quiet: the dry run's preview, with no card and no digest line."""
        drives = self.drives
        if drives is None or not hasattr(drives, "between"):
            return {}
        if drives.home_misread():
            self.leg_note = ("Blocks on Gmail from Family: home in Harness's settings doesn't look like a "
                             "street address or map coordinates (lat, lon), so drive blocks are off.")
            return {}
        if not drives.home_on():
            return {}
        cards = self.live.drive_cards if self.live is not None else None
        off = cards.off() if cards is not None else set()
        kept = getattr(self, "_kept_own", {})
        zone = ZoneInfo(self.tz)
        days: dict = {}
        # Soonest first, so a limit on lookups leaves the far-off days for the next read.
        placed = sorted((w for w in wants.values() if w.place and w.legs and w.end > now and w.key not in off),
                        key=lambda w: w.start)
        for want in placed:
            days.setdefault(want.start.astimezone(zone).date(), []).append(want)
        out: dict[str, Want] = {}
        failed: set[datetime] = set()
        not_found: set[datetime] = set()
        chained: set[datetime] = set()
        trouble: dict[str, tuple[datetime, str]] = {}
        waiting: dict[str, datetime] = {}  # lookups this read had no allowance left for
        last: list = [None]                # the last lookup's answer, as drives.between gave it

        def minutes(origin: str, destination: str, event: Want) -> int | None:
            found = last[0] = drives.between(origin, destination)
            if found == drive.LATER:
                waiting[event.key] = event.start   # asked at the next read: not a failure, no card
            elif found == drive.FAILED:
                failed.add(event.start)
                trouble[event.key] = (event.start, drive_cards.FAILED)
            elif found == drive.NO_ADDRESS:
                not_found.add(event.start)
                trouble.setdefault(event.key, (event.start, drive_cards.NO_ADDRESS))
            if isinstance(found, (int, float)):
                return math.ceil(found / DRIVE_ROUND) * DRIVE_ROUND
            return None

        def leg(event: Want, which: str, start: datetime, end: datetime) -> None:
            if end > start:
                key = leg_key(event.key, which)
                out[key] = Want(key, _leg_title(which, event.state), start, end, "", event.state)
                self._leg_parent[key] = event.key

        def unresolved(event: Want) -> None:
            chained.add(event.start)
            trouble[event.key] = (event.start, drive_cards.CHAIN)

        for events in days.values():
            prev: Want | None = None
            for event in events:
                there_from: str | None = drive.HOME
                if prev is not None:
                    back = minutes(prev.place, drive.HOME, prev)
                    back_found = last[0]
                    out_again = minutes(drive.HOME, event.place, event)
                    if back is None and back_found == drive.NO_ADDRESS and out_again is not None:
                        # The last one can't be placed: from home, only if he can be home after it
                        # and leave in time, crossing no drive that stays.
                        leave = event.start - timedelta(minutes=out_again)
                        if leave >= prev.end and not self._crosses(leave, event.start, event.key, out, now):
                            there_from = drive.HOME
                        else:
                            there_from = None
                            unresolved(event)
                    elif back is None and out_again is not None:
                        # Which way he goes can't be told yet: this one has no drive there at
                        # this read, and says why, never silently.
                        there_from = None
                        if back_found == drive.LATER:
                            waiting[event.key] = event.start
                        else:
                            failed.add(event.start)
                            trouble.setdefault(event.key, (event.start, drive_cards.FAILED))
                    elif back is None or out_again is None:
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
        # A kept drive that a drive worked out now crosses: both stay busy, and he's told.
        if not quiet:
            events = {w.key: w for w in placed}
            for want in kept.values():
                for k, w in out.items():
                    parent = events.get(self._leg_parent.get(k, ""))
                    if k not in kept and parent is not None and w.start < want.end and want.start < w.end:
                        self._conflicts.append((parent.key, parent.start, want.start))
        # Events nothing could place: the place book asks where (that's their card), or the map
        # couldn't be reached.
        unplaced = {**(self.live.unplaced if self.live is not None else {}), **self._own_unplaced}
        for key, (start, _, why) in unplaced.items():
            if key in off or start <= now:
                continue
            (failed if why in (drive_cards.FAILED, drive_cards.LATER) else not_found).add(start)
            trouble[key] = (start, why)
        # A lookup still waiting this near is no longer a quiet wait: the digest names it, and it
        # gets its card.
        for key, start in waiting.items():
            if start < now + NEAR_LATER:
                failed.add(start)
                trouble.setdefault(key, (start, drive_cards.LATER))
        if quiet:
            if cards is not None:
                for event in placed:
                    if event.kind == "own":
                        uid, place, inst = self._own_meta.get(event.key, ("", event.place, ""))
                        cards.seen(self._ck(event.key), self._own_kind(), self._own_said.get(event.key, ""),
                                   event.start, event.end, place, uid, inst)
            return out
        self.leg_note = " ".join(x for x in (self._leg_note(failed, not_found, chained, now),
                                             self._conflict_note(now), self._own_notes()) if x)
        if cards is not None:
            self._drive_cards(cards, placed, trouble, unplaced, now, set(waiting))
        return out

    def _conflict_note(self, now: datetime) -> str:
        """Times only: a Family event's drive that crosses a drive kept for his own appointment."""
        times = sorted({s for _, s, _ in getattr(self, "_conflicts", []) if now < s < now + NOTE_AHEAD})
        if not times:
            return ""
        zone = ZoneInfo(self.tz)
        whens = [f"{t:%b} {t.day}, {t.hour % 12 or 12}:{t:%M}" for t in (s.astimezone(zone) for s in times)]
        which = f"the event at {whens[0]} crosses" if len(whens) == 1 else f"the events at {'; '.join(whens)} cross"
        return (f"Blocks on Gmail from Family: the drive for {which} a drive block kept for one of your own "
                "appointments, because your Gmail calendar couldn't be read in full. Both stay busy until it is.")

    def _crosses(self, start: datetime, end: datetime, key: str, out: dict[str, Want], now: datetime) -> bool:
        """A drive from start to end would cross another drive: one worked out at this read, or one
        on Gmail that stays (not this event's own, not one this read replaces, and not one of his own
        appointments' drives: those are never a stop for anything else)."""
        mine = {leg_key(key, "there"), leg_key(key, "back")}
        if any(k not in mine and w.start < end and start < w.end for k, w in out.items()):
            return True
        titles = {DRIVE_THERE, DRIVE_BACK, *MAYBE_DRIVE.values()}
        kept = getattr(self, "_kept_own", {})
        own_legs = {leg_key(r["key"], w) for r in self.live.drive_cards.own_rows() for w in ("there", "back")} \
            if self.live is not None else set()
        for row in self._live():
            if row["title"] in titles and row["key"] not in mine and row["key"] not in out \
                    and row["key"] not in kept and row["key"] not in own_legs \
                    and row["key"] not in self.dropped and self._when(row["end"]) > now \
                    and self._when(row["start"]) < end and start < self._when(row["end"]):
                return True
        return False

    def _drive_cards(self, cards, placed: list[Want], trouble: dict, unplaced: dict, now: datetime,
                     waiting: set = frozenset()) -> None:
        """Each event's drives as found at this read, for its cards (drive_cards.py)."""
        why = getattr(self.live, "_why", {})
        for event in placed:
            kind = "own" if event.kind == "own" else "family"
            said = self._own_said.get(event.key) or why.get(event.key, {}).get("said", "")
            if kind == "own":
                uid, place, inst = self._own_meta.get(event.key, ("", event.place, ""))
                cards.seen(event.key, kind, said, event.start, event.end, place, uid, inst)
            else:
                cards.seen(event.key, kind, said, event.start)
            if event.key not in trouble and event.key not in waiting:
                cards.fine(event.key)
        for key, (start, reason) in trouble.items():
            if not now < start < now + NOTE_AHEAD:
                continue
            said = self._own_said.get(key) or (unplaced.get(key) or (None, ""))[1] \
                or why.get(key, {}).get("said", "")
            cards.trouble(key, "own" if key in self._own_said else "family", said, start, reason)
        for key, start, kept_start in getattr(self, "_conflicts", []):
            cards.conflict(key, "family", why.get(key, {}).get("said", ""), start, kept_start, self.live.chat_id, now)
        cards.ask(self.live.chat_id, now)

    def _read_back_drives(self, blocks: dict, now: datetime, until: datetime) -> None:
        """His own appointments' drives, added or moved: their card waits for a read that finds
        them as written (drive_cards.py), like a Family block's receipt."""
        for r in self.live.drive_cards.waiting():
            rows = [self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=? AND state='live'",
                                           (leg_key(r["key"], which),)).fetchone() for which in ("there", "back")]
            rows = [row for row in rows if row is not None and self._when(row["end"]) > now]
            if not rows:
                self.live.drive_cards.read_back(r["key"], None)
                continue
            if any(self._when(row["start"]) >= until for row in rows):
                continue                   # not read this time
            if all((b := blocks.get(row["event_id"])) is not None and b.plain and b.title == row["title"]
                   and _same(b.start, self._when(row["start"])) and _same(b.end, self._when(row["end"]))
                   for row in rows):
                self.live.drive_cards.read_back(r["key"], True)

    def _legs_of(self, key: str) -> list[tuple[str, datetime, datetime]]:
        out = []
        for which in ("there", "back"):
            row = self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=? AND state='live'",
                                         (leg_key(key, which),)).fetchone()
            if row is not None:
                out.append((row["title"], self._when(row["start"]), self._when(row["end"])))
        return out

    def send_drive_receipts(self) -> int:
        """With the morning digest: his own appointments' drives, added or moved, one card each."""
        if self.live is None or not self._live_on():
            return 0
        try:
            return self.live.drive_cards.send_receipts(self.live.chat_id, self._legs_of)
        except Exception as e:
            log.warning("drive receipts failed: %s", type(e).__name__)
            return 0

    def _drive_undo(self) -> None:
        """His Undo on an appointment's drives: off now, and off for that event from here on."""
        waiting = self.live.drive_cards.removals()
        if not waiting:
            return
        address = self._address()
        if address is None or not self.google.configured():
            return
        for key in waiting:
            if not self._drop_legs(address, key):
                return                     # tried again next tick
            self.live.drive_cards.removed(key)

    def _leg_note(self, failed: set[datetime], not_found: set[datetime], chained: set[datetime],
                  now: datetime) -> str:
        """Times only, each one named: nothing from the event itself goes in a note."""
        zone = ZoneInfo(self.tz)

        def which(times: set[datetime]) -> str:
            whens = [f"{t:%b} {t.day}, {t.hour % 12 or 12}:{t:%M}"
                     for t in (s.astimezone(zone) for s in sorted(times))]
            return f"the event at {whens[0]}" if len(whens) == 1 else f"the events at {'; '.join(whens)}"

        failed = {t for t in failed if t < now + NOTE_AHEAD}
        not_found = {t for t in not_found - failed if t < now + NOTE_AHEAD}
        chained = {t for t in chained - failed - not_found if t < now + NOTE_AHEAD}
        notes = []
        if failed:
            notes.append(f"Blocks on Gmail from Family: couldn't look up the drive for {which(failed)}, "
                         "so a drive block is missing. I'll try again at the next read.")
        if not_found:
            notes.append(f"Blocks on Gmail from Family: couldn't find a drive to {which(not_found)}, "
                         "so a drive block is missing: it has no address the map can place.")
        if chained:
            notes.append(f"Blocks on Gmail from Family: couldn't work out the drive to {which(chained)} from "
                         "the event before it, and there isn't time to go home between, so a drive block is "
                         "missing.")
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
            return ("Blocks on Gmail from Family: Google refused. Your Gmail calendar needs to be "
                    f"shared with {self.google.account()} on \"Make changes and see event "
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
    def _read_back(self, blocks: dict, now: datetime, until: datetime) -> None:
        """A new block's receipt (meaning_live.py) goes out only once a read of Gmail after its
        write finds the block as written: ours, on his calendar, with the title, start and end its
        row says were last written (a move since the receipt was made counts, and the receipt then
        says where it is). This read is that check, before anything here changes. A block no longer
        ours to tell of (gone from the record, his, written again, or over) drops its receipt; one
        past what was read waits for a read that covers it."""
        for r in self.live.written():
            rid = r["id"]
            row = self.ledger.db.execute("SELECT * FROM family_gmail WHERE key=?", (r["gmail_key"],)).fetchone()
            if row is None or row["state"] != "live" or str(row["generation"]) != rid.rsplit(".", 1)[-1]:
                self.live.read_back(rid, None)
                continue
            title, start, end = row["title"], self._when(row["start"]), self._when(row["end"])
            if end <= now:
                self.live.read_back(rid, None)
                continue
            if start >= until:
                continue                   # not read this time: neither found nor missing
            block = blocks.get(row["event_id"])
            if block is not None and block.plain and block.title == title and _same(block.start, start) \
                    and _same(block.end, end):
                self.live.read_back(rid, True, title=title, start=start, end=end)
            else:
                self.live.read_back(rid, False)

    def _follow(self, address: str, wants: dict, blocks: dict, now: datetime, until: datetime,
                family_clean: bool, thin: bool) -> str:
        gone, absent = [], []
        held = 0
        waiting: list[tuple[str, datetime]] = []
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
            if not row["seen"]:                # there once: Google having nothing for it later is his removal
                self._update(row, seen=1)
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
                waiting.append((want.title, want.start))
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
                       "couldn't be read, so I left them for now. They come off once Family reads in "
                       "full and still doesn't have them.")
        if waiting and not problem:
            problem = self._capped(waiting)
        return problem

    def _capped(self, waiting: list[tuple[str, datetime]]) -> str:
        """Past today's limit: each change that waits, by its block's title and day, never a count."""
        zone = ZoneInfo(self.tz)
        days: dict[str, list[str]] = {}
        for title, start in sorted(waiting, key=lambda w: w[1]):
            local = start.astimezone(zone)
            days.setdefault(title, []).append(f"{local:%a %b} {local.day}")
        named = "; ".join(f"{title} on {', '.join(dict.fromkeys(ds))}" for title, ds in days.items())
        return (f"Blocks on Gmail from Family: past today's limit, these wait for tomorrow: {named}. "
                "Those days may be wrong until then.")

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
                continue
            how = self.google.gone_how(address, row["event_id"])
            if how in ("there", "unknown"):
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
            elif how == "never" and not row["seen"]:
                # Google has nothing by that id, and no read ever found it: a write it answered
                # "ok" never landed. That's no answer of his, so it's written once more, and its
                # receipt waits for the read that finds it (meaning_live.read_back). A deleted
                # block is answered "cancelled", and in time not at all: one a read found there
                # once is his removal, below, and never written again.
                problem = self._write_again(address, row, want) or problem
            else:
                self._set(row, "removed")      # taken as his answer, and not put back
                self._log("family_gmail_removed", row["key"])
        return problem

    def _unwritten(self, now: datetime) -> str:
        """Each block Google said it wrote, twice, but never had, by its title and day, until it's
        over: a fact, with nothing for him to do but know it."""
        zone = ZoneInfo(self.tz)
        named = [f"{r['title']} on {self._when(r['start']).astimezone(zone):%a %b} "
                 f"{self._when(r['start']).astimezone(zone).day}"
                 for r in self.ledger.db.execute("SELECT * FROM family_gmail WHERE state='unwritten'"
                                                 " ORDER BY start").fetchall() if self._when(r["end"]) > now]
        if not named:
            return ""
        return (f"Blocks on Gmail from Family: {'; '.join(named)} didn't go through. Google said "
                f"{'it was' if len(named) == 1 else 'they were'} written, twice, but "
                f"{'it isn' if len(named) == 1 else 'they aren'}'t on Gmail.")

    def _write_again(self, address: str, row, want: Want) -> str:
        """A block Google said it wrote but never had: once more, under the same id, which
        Google has never used. A second that never lands is said by name, not tried again."""
        if row["rewritten"]:
            self._set(row, "unwritten")        # said by name until it's over (_unwritten)
            return ""
        if not self._room():
            return ""                          # past today's limit: the next read tries
        out = self.google.add(address, row["event_id"], want.title, want.start, want.end, want.place)
        if out.kind in ("ok", "unknown"):      # landed, or a read finds out: either way, read again
            self._update(row, missing=0, rewritten=1, title=want.title, start=want.start.isoformat(),
                         end=want.end.isoformat(), place=want.place)
            self._log("family_gmail_rewritten", row["key"])
            self.writes += 1
            return ""
        if out.kind == "exists":               # Google has the id after all: a new one next time
            self._set(row, "lost")
            return ""
        return self._said(out)

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
                return self._capped([(r["title"], self._when(r["start"])) for r, _ in ready[n:]])
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
        if self.live is not None:          # a receipt not sent yet waits for a read of where it is now
            self.live.moved(row["key"], row["generation"])
            parent = getattr(self, "_leg_parent", {}).get(row["key"])
            if parent is not None:         # his own appointment's drive: its card (drive_cards.py)
                self.live.drive_cards.written(parent, "moved")
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
                return self._capped([(w.title, w.start) for w, _ in new[n:]])
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
                parent = getattr(self, "_leg_parent", {}).get(want.key)
                if self.live is not None and parent is not None:
                    self.live.drive_cards.written(parent, "added")   # his own appointment's drives
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
                " state, missing, created_at, updated_at, place, rewritten, seen)"
                " VALUES(?,?,?,'',?,?,?,?,0,?,?,?,0,0)"
                " ON CONFLICT(key) DO UPDATE SET event_id=excluded.event_id,"
                " generation=excluded.generation, intent='', title=excluded.title,"
                " start=excluded.start, end=excluded.end, state=excluded.state, missing=0,"
                " updated_at=excluded.updated_at, place=excluded.place, rewritten=0, seen=0",
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
