"""Keeping Family true to his Gmail calendar, with no tap and no model.

After each read of his calendars, plain code works out which Gmail events belong on
Family, then adds, moves and removes its own copies to match. His first name in the
add-on's settings turns this on; adds must also be on, and /stop stops it.

What keeps that safe without a tap:

  * Family gets fixed words and times, never text from Gmail. An appointment is
    "Name - Doctor". A trip is "Name - City", with flight times and numbers only when
    they match a strict pattern. So private text and an outsider's wording can't get
    there, and a wrong guess only blocks an hour.
  * It changes only its own copies, and copies he made by hand that it took over. Those
    must carry his name, since Family holds everyone's events. A copy someone has since
    edited is left alone for good.
  * Nothing is removed, or taken as removed, on one read. It takes two good reads in a
    row. Many going at once is held back for a while as a sign the read is wrong, and the
    hold ends, since visits that really ended have to come off. His own copies stay while
    the Gmail read looks odd: a harness copy comes back by itself, and his can't.
  * If Gmail or Family can't be read, nothing happens.

A copy removed from Family, with its source still on Gmail, stays removed. Two removed
of a kind and it stops copying that kind.

This is separate from family_add: the bake-in count and record there are about adds he
asks for, and nothing here counts toward them or changes them.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import caldav, calendar_feed, ical
from .ledger import Ledger, iso

log = logging.getLogger("harness.family_copy")

AHEAD_DAYS = 60                # read this far, so a move is followed, not taken for a cancel
MAX_HOURS = 8                  # longer than this isn't an appointment
MAX_WRITES_PER_DAY = 12
MAX_REMOVALS_AT_ONCE = 3
MAX_FAILED_WRITES = 3          # in one read, before it stops trying until the next
MAX_NAMED = 10                 # in the digest, which has a length limit of its own
READS_BEFORE_REMOVING = 2
STOP_AFTER_REMOVED = 2
HOLD_READS = 6                 # three hours: long enough for a bad read to pass, then it's real
GIVE_UP_READS = 12             # six hours of a copy being there but not listed
SLOP = timedelta(minutes=30)   # travel time makes the two calendars differ a little
PROBLEM = "family_copy_problem"
READ_SIZE = "family_copy_read_size"
THIN_READS = "family_copy_thin_reads"
REVIVED = "family_copy_revived"
REVIVE_TRIES = "family_copy_revive_tries"
TRIP = "trip"
CAPPED = ("Copies from Gmail: today's limit of changes is reached, so some wait for tomorrow and "
          "may be wrong until then.")
_WHY = {"edited": "changed on Family", "changed": "changed on Family",
        "not listed": "Family's list leaves it out", "gone": "no longer on Family",
        "off": "its time doesn't match Gmail", "earlier": "stopped following earlier"}

# The word on Family, by what the title says. Checked in order.
_WORDS = (("PT", r"pt|physical therapy|physio"),
          ("Dentist", r"dentist|dental|orthodontist"),
          ("Doctor", r"doctor|dr|clinic|hospital|surgery|echo|consult\w*|orthoped\w*|cardiolog\w*"
                     r"|dermatolog\w*|pediatric\w*|optometrist|eye exam"),
          ("Vet", r"vet|veterinar\w*"),
          ("Haircut", r"haircut|barber"),
          ("Coffee", r"coffee"),
          ("Computer Lab", r"computer lab"),
          ("Appointment", r"appt|appointment"))
_WORD_RES = tuple((word, re.compile(rf"\b(?:{pattern})\b", re.I)) for word, pattern in _WORDS)
_SKIP = re.compile(r"\b(busy|call|session|meeting|flight|stay|reservation|drive|transit|uber|lyft"
                   r"|deadline|checkpoint|task|reminder|onboarding|keynote|webinar|reception"
                   r"|interview|standup|sync)\b", re.I)
_STAY = re.compile(r"stay at\b(?! home\b)", re.I)
# A city of up to three words of letters: no dot or colon, so it can't look like an address.
_FLIGHT = re.compile(r"flight to ((?:[A-Za-z'-]+ ){0,2}[A-Za-z'-]+) \(([A-Z0-9]{2} ?[0-9]{1,4})\)",
                     re.I)
MAX_CITY = 24
_NAME = re.compile(r"[^\W\d_]+(?:[ '-][^\W\d_]+){0,3}")
_STOP = frozenset({"with", "and", "the", "at", "to", "for", "from", "of", "in", "on", "my"})


def name_from_options(data_dir: str) -> str:
    """The setting, read each time. Anything but a plain name leaves copying off, since
    it goes in every title."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("family_copy_name", "")
    except (OSError, ValueError, AttributeError):
        return ""
    value = value.strip() if isinstance(value, str) else ""
    return value if _NAME.fullmatch(value) else ""


def is_gmail(occ: ical.Occurrence) -> bool:
    """Google names a primary calendar's feed by its address (ical.py)."""
    return occ.calendar.casefold().endswith("@gmail.com")


def word_for(occ: ical.Occurrence) -> str | None:
    """The word for Family, or None when this isn't an appointment to copy."""
    if not is_gmail(occ) or occ.all_day or occ.transparent:
        return None
    if not _his(occ):
        return None                    # someone else's invite: outside text
    if occ.end - occ.start > timedelta(hours=MAX_HOURS) or _SKIP.search(occ.summary):
        return None
    if "☕" in occ.summary:
        return "Coffee"
    return next((word for word, rx in _WORD_RES if rx.search(occ.summary)), None)


@dataclass(frozen=True)
class Want:
    key: str
    word: str
    title: str
    start: datetime | date
    end: datetime | date
    quiet: bool = False        # during a trip: followed if already there, never added


def _is_flight(occ: ical.Occurrence) -> bool:
    m = None if occ.all_day else _FLIGHT.match(occ.summary)
    return bool(m) and len(m.group(1)) <= MAX_CITY


def _key(occ: ical.Occurrence) -> str:
    """A moved event keeps its uid, so it keeps its copy."""
    return hashlib.sha256(f"{occ.uid}|{occ.instance}".encode()).hexdigest()[:32]


def _uid(key: str) -> str:
    return "hx-" + hashlib.sha256(f"family_copy:{key}".encode()).hexdigest()[:32]


def _first_day(when, tz: ZoneInfo) -> date:
    return when.astimezone(tz).date() if isinstance(when, datetime) else when


def _last_day(occ: ical.Occurrence, tz: ZoneInfo) -> date:
    if isinstance(occ.end, datetime):
        return occ.end.astimezone(tz).date()
    return occ.end - timedelta(days=1)


def _flight_words(flight: ical.Occurrence | None, label: str, tz: ZoneInfo) -> str:
    if flight is None:
        return ""
    local = flight.start.astimezone(tz)
    number = _FLIGHT.match(flight.summary).group(2)
    hour = local.hour % 12 or 12
    return f"{label} {local:%a} {hour}:{local:%M} {'PM' if local.hour >= 12 else 'AM'} {number}"


def _his(occ: ical.Occurrence) -> bool:
    return not occ.organizer or occ.organizer == occ.calendar.casefold()


def plan(occurrences: list[ical.Occurrence], name: str, tz: str) -> dict[str, Want]:
    """What Family should hold, from Gmail alone. Every title is built here."""
    local = ZoneInfo(tz)
    gmail = [o for o in occurrences if is_gmail(o) and _his(o)]
    flights = sorted((o for o in gmail if _is_flight(o)), key=lambda f: f.start)
    out: dict[str, Want] = {}
    away: list[tuple[date, date]] = []
    for stay in gmail:
        if not _STAY.match(stay.summary):
            continue
        first, last = _first_day(stay.start, local), _last_day(stay, local)
        leaving = [f for f in flights if _first_day(f.start, local) == first]
        there = leaving[0] if leaving else None      # when he leaves
        arrive = leaving[-1] if leaving else None    # where he ends up, past any connection
        back = next((f for f in flights if _first_day(f.start, local) == last
                     and f not in leaving), None)
        last = max(last, first)
        place = " ".join(_FLIGHT.match(arrive.summary).group(1).split()) if arrive else "away"
        legs = ", ".join(x for x in (_flight_words(there, "out", local),
                                     _flight_words(back, "back", local)) if x)
        title = f"{name} - {place}" + (f" ({legs})" if legs else "")
        away.append((first, last))
        out[_key(stay)] = Want(_key(stay), TRIP, title, first, last + timedelta(days=1))
    for o in gmail:
        word = word_for(o)
        if word is None:
            continue
        day = _first_day(o.start, local)
        # The trip's block already says he's away.
        quiet = any(first <= day <= last for first, last in away)
        out[_key(o)] = Want(_key(o), word, f"{name} - {word}", o.start, o.end, quiet)
    return out


def _words(title: str, name: str) -> set[str]:
    drop = _STOP | set(re.findall(r"\w+", name.casefold()))
    return {w for w in re.findall(r"\w+", title.casefold()) if len(w) > 1 and w not in drop}


def _same(a, b) -> bool:
    """Times compare as moments, and a date never equals a time."""
    return isinstance(a, datetime) == isinstance(b, datetime) and a == b


def match_on_family(want: Want, source_title: str, family: list[caldav.Item],
                    name: str) -> caldav.Item | None:
    """What he already has for this, if anything. It must carry his name: Family holds
    everyone's events, and "Mom - Doctor" at the same hour isn't his. Then the same time,
    give or take the drive, and a word in common; for a trip, an all-day block."""
    words = _words(f"{want.title} {source_title}", name)
    who = set(re.findall(r"\w+", name.casefold()))
    for item in family:
        f = item.occ
        if not who & set(re.findall(r"\w+", f.summary.casefold())):
            continue
        if want.word == TRIP:
            if f.all_day and f.start < want.end and f.end > want.start:
                return item
        elif not f.all_day and f.start < want.end + SLOP and f.end > want.start - SLOP \
                and words & _words(f.summary, name):
            return item
    return None


class FamilyCopy:
    def __init__(self, ledger: Ledger, family_add, calendar, *, name_fn=lambda: "", tz: str):
        self.ledger = ledger
        self.fa = family_add
        self.client = family_add.client
        self.calendar = calendar
        self.name_fn = name_fn             # the setting's first name; none means this is off
        self.tz = tz
        self._seen: int | None = None      # the calendar read last looked at

    def name(self) -> str:
        return (self.name_fn() or "").strip()

    # -- what he sees ----------------------------------------------------------------
    def status_line(self) -> str:
        if not self.name():
            return "Copies from Gmail: off, no first name in the add-on's settings."
        feeds = self.calendar.snapshot.feeds.values()
        if not self.calendar.configured or (feeds and not self._gmail_feeds()):
            return ("Copies from Gmail: waiting. Enter your Gmail calendar's secret iCal address "
                    "on the add-on page.")
        n = self.ledger.db.execute("SELECT COUNT(*) FROM family_copies WHERE state='live'"
                                   ).fetchone()[0]
        line = f"Copies from Gmail: on, {n} on Family now"
        stopped = sorted(self._stopped_words())
        return line + (f". Stopped for {', '.join(stopped)}, after two were removed" if stopped else "")

    def digest_line(self) -> str:
        """Counts, and which were left alone. Silent when nothing changed and nothing is wrong."""
        since = self.ledger.meta_time("last_digest_at")
        parts = []
        for kind, label in (("family_copy_added", "added"), ("family_copy_moved", "moved"),
                            ("family_copy_cancelled", "removed as cancelled"),
                            ("family_copy_removed", "removed by someone, not put back")):
            n = self.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind=? AND at>=?",
                                       (kind, iso(since) if since else "")).fetchone()[0]
            if n:
                parts.append(f"{n} {label}")
        line = "Copies from Gmail to Family: " + ", ".join(parts) + "." if parts else ""
        problem = self.ledger.get_meta(PROBLEM)
        left = self._left_alone(iso(since) if since else "")
        return " ".join(x for x in (line, left, problem) if x)

    # -- each tick -------------------------------------------------------------------
    def run(self, *, paused: bool) -> None:
        """Only after a new read. A bug here is a record, never a stopped loop."""
        gen = self.calendar.generation
        if gen == self._seen:
            return
        self._seen = gen
        try:
            if paused:
                return
            if self.fa.enabled() and self.name():
                self._sync()
            else:
                self._problem("")          # off: an old problem isn't one any more
        except Exception as e:
            log.warning("family copy failed: %s", type(e).__name__)
            self.ledger.event("family_copy_failed", {"error": type(e).__name__})
            self._problem("Copies from Gmail: something went wrong on the last read, so Family may "
                          "be out of date.")

    def _gmail_feeds(self) -> list:
        return [res for res in self.calendar.snapshot.feeds.values() if res.window is not None
                and res.window.calendar.casefold().endswith("@gmail.com")]

    def _stopped_words(self) -> frozenset[str]:
        return frozenset(r["word"] for r in self.ledger.db.execute(
            "SELECT word FROM family_copies WHERE state='removed' GROUP BY word"
            " HAVING COUNT(*)>=?", (STOP_AFTER_REMOVED,)))

    def _sync(self) -> None:
        feeds = self._gmail_feeds()
        if len(feeds) > 1:                 # which is his? someone else's would go on as his
            self._problem("Copies from Gmail: more than one Gmail calendar is entered, and I "
                          "can't tell which is yours, so nothing changed.")
            return
        if not feeds or feeds[0].ahead is None:
            return                         # not read is not empty
        feed = feeds[0]
        now = self.ledger.now()
        name = self.name()
        day_start, _, _ = calendar_feed.today_bounds(now, self.tz)
        until = day_start + timedelta(days=self.calendar.ahead_days + 1)
        family = self.client.items_between(now - timedelta(days=1), until, self.tz)
        if family is None or (not family.items and any(
                self._moment(self._when(r["end"])) > now for r in self._live())):
            self._problem("Copies from Gmail: couldn't read the Family calendar, so nothing "
                          "changed.")
            return
        self.deleted: set[str] = set()     # his copies removed this read: not there to match
        self._revive(family, now, until)
        self._tell_once(family)
        occ = feed.ahead.occurrences
        planned = plan(occ, name, self.tz)
        wants = {k: w for k, w in planned.items() if self._ends(w) > now}
        sources = {_key(o): o.summary for o in occ}
        self.writes = self._writes_today()
        odd = self._thin(len(occ), len(occ) - len(planned)) or not occ
        problems = [self._follow(wants, family, now, feed.ahead.unreadable == 0, until, odd)]
        problems.append(self._add_new(wants, sources, family.items, name))
        self._problem(next((p for p in problems if p), ""))

    def _thin(self, total: int, rest: int) -> bool:
        """Gmail holds more than what copies, so the rest of it doesn't suddenly halve, and it's
        never empty. That tells a bad read from visits that really ended, which can take many
        copies at once. If it stays that way, that's just what Gmail looks like now."""
        size = int(self.ledger.get_meta(READ_SIZE) or 0)
        reads = int(self.ledger.get_meta(THIN_READS) or 0) + 1
        thin = (total == 0 or rest * 2 < size) and reads < HOLD_READS
        with self.ledger.tx() as db:
            self.ledger.set_meta(THIN_READS, str(reads if thin else 0), db)
            if not thin:
                self.ledger.set_meta(READ_SIZE, str(rest), db)
        return thin

    def _live(self) -> list:
        return self.ledger.db.execute("SELECT * FROM family_copies WHERE state='live'").fetchall()

    def _ends(self, want: Want) -> datetime:
        if isinstance(want.end, datetime):
            return want.end
        return datetime.combine(want.end, datetime.min.time(), tzinfo=ZoneInfo(self.tz))

    def _problem(self, text: str) -> None:
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROBLEM, text, db)

    def _writes_today(self) -> int:
        local = self.ledger.now().astimezone(ZoneInfo(self.tz))
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return self.ledger.db.execute(
            "SELECT COUNT(*) FROM events WHERE kind IN ('family_copy_added','family_copy_moved',"
            "'family_copy_cancelled') AND at>=?",
            (iso(midnight.astimezone(timezone.utc)),)).fetchone()[0]

    def _room(self) -> bool:
        return self.writes < MAX_WRITES_PER_DAY

    def _when(self, value: str):
        return datetime.fromisoformat(value) if "T" in value else date.fromisoformat(value)

    # -- what's already there ------------------------------------------------------------
    def _follow(self, wants: dict, family: caldav.Read, now: datetime, gmail_clean: bool,
                until: datetime, odd: bool) -> str:
        items = {caldav.href_path(i.href): i for i in family.items}
        by_uid = {i.occ.uid: i for i in family.items}
        gone, absent = [], []
        problem = ""
        waiting = tries = 0
        for row in self._live():
            start, end = self._when(row["start"]), self._when(row["end"])
            if self._moment(end) <= now:
                self._set(row, "done")
                continue
            begins = self._moment(start)
            if begins >= until:
                continue                   # past what was read: unread, not gone
            item = items.get(caldav.href_path(row["href"])) if row["hand"] else by_uid.get(row["uid"])
            want = wants.get(row["key"])
            if item is None:
                absent.append((row, want))
                continue
            if row["hand"]:
                if not _still_seen(row, item):
                    self._leave(row, "edited")     # not what was taken over any more
                    continue
                if row["seen"] == _seen(item.occ):
                    self._update(row, seen=_seen_now(item))    # from before notes were seen
            elif want is not None and self._landed(item.occ, want):
                # Already as it should be: a write whose answer was lost.
                if not (_same(want.start, start) and _same(want.end, end)):
                    self._moved(row, row["uid"], want)
                elif row["missing"]:
                    self._update(row, missing=0)
                continue
            elif not self._as_written(item.occ, row, start, end) or caldav.details(item.data):
                self._leave(row, "edited")         # someone edited it: theirs now
                continue
            if want is None:
                if gmail_clean:
                    gone.append((row, item))
                continue
            if row["missing"]:
                self._update(row, missing=0)
            # Once begun, a trip's flights have left the read: that's not a change.
            retitled = not row["hand"] and want.title != row["title"] and begins > now
            # Taken over when Gmail had already moved on: the row can't show that, the event can.
            behind = row["hand"] and _off_time(item, want) and _clearly_same(item, want)
            if retitled or behind or not (_same(want.start, start) and _same(want.end, end)):
                if not self._room():
                    waiting += 1
                    continue
                failed = self._move(row, item, want)
                if failed:
                    # One copy's trouble shouldn't hold up the rest, but don't hammer iCloud.
                    problem = problem or failed
                    tries += 1
                    if tries >= MAX_FAILED_WRITES:
                        break
        if not problem:
            problem = self._absent(absent, family.unreadable == 0)
            problem = self._cancel(gone, wants, odd) or problem
        return problem or (CAPPED if waiting else "")

    def _moment(self, value) -> datetime:
        if isinstance(value, datetime):
            return value
        return datetime.combine(value, datetime.min.time(), tzinfo=ZoneInfo(self.tz))

    @staticmethod
    def _landed(occ: ical.Occurrence, want: Want) -> bool:
        return (occ.summary == want.title[:ical.MAX_SUMMARY] and _same(occ.start, want.start)
                and _same(occ.end, want.end))

    @staticmethod
    def _as_written(occ: ical.Occurrence, row, start, end) -> bool:
        # The reader cuts a long title, so compare as much as it keeps.
        return (occ.summary == row["title"][:ical.MAX_SUMMARY] and _same(occ.start, start)
                and _same(occ.end, end))

    def _absent(self, absent: list, family_clean: bool) -> str:
        """Gone from Family. One read can be wrong, and so can many gone at once for a while."""
        if not absent:
            return ""
        if not family_clean:
            return (f"Copies from Gmail: {len(absent)} events aren't in Family's list, but part of "
                    "Family couldn't be read, so I changed nothing.")
        if len(absent) > MAX_REMOVALS_AT_ONCE and min(r["missing"] for r, _ in absent) + 1 < HOLD_READS:
            for row, _ in absent:
                self._update(row, missing=row["missing"] + 1)
            return (f"Copies from Gmail: {len(absent)} events look gone from Family at once. That "
                    "looks like a bad read, so I changed nothing.")
        problem = ""
        for row, want in absent:
            if row["missing"] + 1 < READS_BEFORE_REMOVING:
                self._update(row, missing=row["missing"] + 1)
            elif not row["hand"] and (there := self.client.missing([row["uid"]])) != 1:
                # The read left it out but it's there, or iCloud won't say. In time, if it's
                # there, someone moved it out of what's read: theirs now.
                if there == 0 and row["missing"] + 1 >= GIVE_UP_READS:
                    self._leave(row, "not listed")
                    continue
                self._update(row, missing=row["missing"] + 1)
                problem = ("Copies from Gmail: what Family listed doesn't match what's on it, so "
                           "I changed nothing. I'll try again.")
            elif want is None:
                self._set(row, "cancelled")        # gone on both sides: nothing to learn
            else:
                self._removed(row)
        return problem

    def _cancel(self, gone: list, wants: dict, odd: bool) -> str:
        ready = [(row, item) for row, item in gone if row["missing"] + 1 >= READS_BEFORE_REMOVING]
        for row, _ in gone:
            self._update(row, missing=row["missing"] + 1)
        # A series changed: Gmail still has as many as went. Otherwise many going at once may
        # be a bad read, so wait, and tell him. Visits that really ended stay gone after that.
        if len(ready) > MAX_REMOVALS_AT_ONCE and (odd or len(wants) < len(ready)) \
                and min(row["missing"] for row, _ in ready) + 1 < HOLD_READS:
            return (f"Copies from Gmail: {len(ready)} events look cancelled at once. That looks "
                    "like a bad read, so I left them on Family.")
        problem = ""
        kept = 0
        for row, item in ready:
            if row["hand"] and odd:
                kept += 1      # his own copy can't be rebuilt from a bad read's mistake
                continue
            if not self._room():
                problem = CAPPED
                break
            out = (self.client.remove_hand_copy(item.href, item.etag, item.data) if row["hand"]
                   else self.client.undo(row["uid"], item.etag, item.data))
            if out.kind in ("ok", "gone"):
                self.deleted.add(item.href)
                self._set(row, "cancelled")
                self._log("family_copy_cancelled", row["key"])
                self.writes += 1
            elif out.kind == "changed":
                self._leave(row, "changed")
            else:
                problem = self._write_problem(out)
                break
        if kept and not problem:
            problem = (f"Copies from Gmail: {kept} of your own events on Family look cancelled, but "
                       "your Gmail calendar read oddly, so I left them.")
        return problem

    def _removed(self, row) -> None:
        """Gone from Family with no help from here: taken as his answer, and not put back."""
        if row["hand"]:
            self._set(row, "done")
            self._note(row, "gone")
            return
        self._set(row, "removed")
        self._log("family_copy_removed", row["key"])

    def _move(self, row, item, want: Want) -> str:
        now = self.ledger.now()
        if row["hand"]:
            # Takes over his copy: removed, and ours written in its place.
            out = self.client.remove_hand_copy(item.href, item.etag, item.data)
            if out.kind == "changed":
                self._leave(row, "changed")
                return ""
            if out.kind not in ("ok", "gone"):
                return self._write_problem(out)
            self.deleted.add(item.href)
            etag, data = None, ""
        else:
            etag, data = item.etag, item.data
        uid = _uid(row["key"]) if row["hand"] else row["uid"]
        out = self.client.put_copy(uid, want.title, want.start, want.end, now, etag=etag, data=data)
        if out.kind == "changed":
            self._leave(row, "changed")
            return ""
        if out.kind != "ok":
            if row["hand"]:
                self._set(row, "lost")     # his copy is gone and ours isn't there: try anew
            return self._write_problem(out)
        self._moved(row, uid, want)
        return ""

    def _moved(self, row, uid: str, want: Want) -> None:
        self._update(row, uid=uid, hand=0, href="", seen="", title=want.title,
                     start=_text(want.start), end=_text(want.end), missing=0)
        self._log("family_copy_moved", row["key"])
        self.writes += 1

    # -- what's new ----------------------------------------------------------------------
    def _add_new(self, wants: dict, sources: dict, family: list, name: str) -> str:
        now = self.ledger.now()
        stopped = self._stopped_words()
        live = self._live()
        claimed = {caldav.href_path(r["href"]) for r in live if r["hand"]} | {r["uid"] for r in live}
        free = [i for i in family if caldav.href_path(i.href) not in claimed
                and i.occ.uid not in claimed and i.href not in self.deleted]
        for key, want in sorted(wants.items(), key=lambda kv: _text(kv[1].start)):
            row = self.ledger.db.execute("SELECT state, start FROM family_copies WHERE key=?",
                                         (key,)).fetchone()
            again = row is not None and row["state"] == "done" and row["start"] != _text(want.start)
            if want.word in stopped or want.quiet or (
                    row is not None and not again and row["state"] not in ("cancelled", "lost")):
                continue
            match = match_on_family(want, sources.get(key, ""), free, name)
            if match is not None:
                if _takeable(match.occ):
                    # Past the drive time, Gmail has already moved on: record where it really
                    # is, so the next read moves it.
                    off = _off_time(match, want)
                    held = replace(want, start=match.occ.start, end=match.occ.end) if off else want
                    self._insert(key, held, match.occ.uid, match.href, hand=1,
                                 seen=_seen_now(match))
                    free = [i for i in free if i.href != match.href]
                    if off and not _clearly_same(match, want):
                        row = self.ledger.db.execute("SELECT * FROM family_copies WHERE key=?",
                                                     (key,)).fetchone()
                        self._leave(row, "off")    # may be another thing that looks like it
                continue
            if not self._room():
                return CAPPED
            # A finished copy is still on Family, so its event needs a new one.
            uid = _uid(f"{key}:{_text(want.start)}") if again else _uid(key)
            out = self.client.put_copy(uid, want.title, want.start, want.end, now)
            if out.kind != "ok":
                return self._write_problem(out)
            self._insert(key, want, uid, "", hand=0)
            self._log("family_copy_added", key)
            self.writes += 1
        return ""

    def _write_problem(self, out: caldav.Outcome) -> str:
        log.warning("family copy: a write answered %s (%s)", out.kind, out.status)
        return ("Copies from Gmail: the last change to Family didn't go through ("
                f"{out.kind}). I'll try again at the next read.")

    # -- the record ----------------------------------------------------------------------
    def _insert(self, key: str, want: Want, uid: str, href: str, *, hand: int,
                seen: str = "") -> None:
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute(
                "INSERT INTO family_copies(key, uid, href, hand, seen, word, title, start, end,"
                " state, missing, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,'live',0,?,?)"
                " ON CONFLICT(key) DO UPDATE SET uid=excluded.uid, href=excluded.href,"
                " hand=excluded.hand, seen=excluded.seen, title=excluded.title,"
                " start=excluded.start, end=excluded.end, state='live', missing=0,"
                " updated_at=excluded.updated_at",
                (key, uid, href, hand, seen, want.word, want.title, _text(want.start),
                 _text(want.end),
                 now, now))

    def _set(self, row, state: str) -> None:
        self._update(row, state=state)

    def _leave(self, row, why: str) -> None:
        """No longer followed. Never silently: a copy left behind is a wrong calendar."""
        self._set(row, "hands_off")
        self._note(row, why)

    def _note(self, row, why: str) -> None:
        log.warning("family copy: %s copy of %s not followed (%s)", row["word"], row["start"][:10], why)
        with self.ledger.tx() as db:
            self.ledger.event("family_copy_left_alone", {
                "key": row["key"], "word": row["word"], "start": row["start"], "why": why}, db=db)

    def _left_alone(self, since: str) -> str:
        """Which ones, so he can look, in fixed words."""
        said = []
        more = 0
        for r in self.ledger.db.execute("SELECT detail FROM events WHERE kind='family_copy_left_alone'"
                                        " AND at>=?", (since,)):
            try:
                d = json.loads(r["detail"])
                day = _first_day(self._when(d["start"]), ZoneInfo(self.tz))
                text = f"{d['word']} {day:%b} {day.day} ({_WHY[d['why']]})"
            except (ValueError, KeyError, TypeError, AttributeError):
                more += 1                  # an odd record mustn't cost the morning's digest
                continue
            if len(said) < MAX_NAMED:
                said.append(text)
            else:
                more += 1
        if more:
            said.append(f"and {more} more")
        return "Left alone, check by hand: " + ", ".join(said) + "." if said else ""

    def _revive(self, family: caldav.Read, now: datetime, until: datetime) -> None:
        """Once, on the update that stopped leaving copies behind by mistake: any it gave up
        on that's still exactly as it left it goes back to being followed. Needs a whole read,
        since it only gets the one try. One whose day has passed is finished, so if its event
        moved on, that gets a new copy. One the list leaves out gets a few reads to turn up, and
        any it can't follow after that is named once, so none stays stale unsaid."""
        if self.ledger.get_meta(REVIVED) or not family.items or family.unreadable:
            return
        unseen = False
        items = {caldav.href_path(i.href): i for i in family.items}
        by_uid = {i.occ.uid: i for i in family.items}
        live = self._live()
        held = {caldav.href_path(r["href"]) for r in live if r["hand"]} | {r["uid"] for r in live}
        for row in self.ledger.db.execute(
                "SELECT * FROM family_copies WHERE state='hands_off'").fetchall():
            start, end = self._when(row["start"]), self._when(row["end"])
            if self._moment(end) <= now:
                self._set(row, "done")
                continue
            path = caldav.href_path(row["href"])
            item = items.get(path) if row["hand"] else by_uid.get(row["uid"])
            if item is None:
                unseen = unseen or self._moment(start) < until
                continue
            claim = path if row["hand"] else row["uid"]
            if claim in held:
                continue
            if _still_seen(row, item) if row["hand"] else (
                    self._as_written(item.occ, row, start, end) and not caldav.details(item.data)):
                self._update(row, state="live", missing=0)
                held.add(claim)
                log.info("family copy: following a %s copy again", row["word"])
        tries = int(self.ledger.get_meta(REVIVE_TRIES) or 0) + 1
        with self.ledger.tx() as db:
            self.ledger.set_meta(REVIVE_TRIES, str(tries), db)
        if unseen and tries < HOLD_READS:
            return
        for row in self.ledger.db.execute(
                "SELECT * FROM family_copies WHERE state='hands_off'").fetchall():
            self._note(row, "earlier")
        with self.ledger.tx() as db:
            self.ledger.set_meta(REVIVED, "1", db)

    def _tell_once(self, family: caldav.Read) -> None:
        """Once per start: where his own copies stand. Words and dates only."""
        if getattr(self, "_told", False):
            return
        self._told = True
        for r in self.ledger.db.execute("SELECT word, state, start, missing FROM family_copies"
                                        " WHERE hand=1 OR state='hands_off'").fetchall():
            log.info("family copy: %s %s %s missing=%s", r["word"], r["start"][:10], r["state"], r["missing"])
        log.info("family copy: read %d events, %d unreadable", len(family.items), family.unreadable)

    def _update(self, row, **fields) -> None:
        cols = ", ".join(f"{name}=?" for name in fields)
        with self.ledger.tx() as db:
            db.execute(f"UPDATE family_copies SET {cols}, updated_at=? WHERE key=?",
                       (*fields.values(), iso(self.ledger.now()), row["key"]))

    def _log(self, kind: str, key: str) -> None:
        with self.ledger.tx() as db:
            self.ledger.event(kind, {"key": key}, db=db)


def _takeable(occ: ical.Occurrence) -> bool:
    """A plain one-off of his. Anything with people or a repeat stays his alone, and an
    add he asked for already has its own Undo."""
    return not (occ.attendees or occ.organizer or occ.instance or occ.uid.startswith("hx-"))


def _seen(occ: ical.Occurrence) -> str:
    """His event as it was taken over. If it changes, it isn't ours to touch."""
    return f"{occ.summary}|{occ.start.isoformat()}|{occ.end.isoformat()}"


def _seen_now(item: caldav.Item) -> str:
    """With a note or place, which the reader's title and times don't show."""
    extra = hashlib.sha256("\n".join(caldav.details(item.data)).encode()).hexdigest()[:16]
    return f"{_seen(item.occ)}|{extra}"


def _off_time(item: caldav.Item, want: Want) -> bool:
    return isinstance(want.start, datetime) and isinstance(item.occ.start, datetime) \
        and abs(item.occ.start - want.start) > SLOP


def _clearly_same(item: caldav.Item, want: Want) -> bool:
    """Close in time and a word in common isn't enough to rewrite someone's event: the very
    title a copy has, the same length, and no note. A place is his PT's usual."""
    return (item.occ.summary.strip() == want.title
            and item.occ.end - item.occ.start == want.end - want.start
            and not any(x.upper().startswith("DESCRIPTION") for x in caldav.details(item.data)))


def _still_seen(row, item: caldav.Item) -> bool:
    """A row from before that was added holds only the title and times."""
    return row["seen"] in (_seen_now(item), _seen(item.occ))


def _text(value) -> str:
    return value.isoformat()
