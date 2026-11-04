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
    row, and more than a few at once is held back as a sign the read is wrong.
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
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import caldav, calendar_feed, ical
from .ledger import Ledger, iso

log = logging.getLogger("harness.family_copy")

AHEAD_DAYS = 60                # read this far, so a move is followed, not taken for a cancel
MAX_HOURS = 8                  # longer than this isn't an appointment
MAX_WRITES_PER_DAY = 12
MAX_REMOVALS_AT_ONCE = 3
READS_BEFORE_REMOVING = 2
STOP_AFTER_REMOVED = 2
SLOP = timedelta(minutes=30)   # travel time makes the two calendars differ a little
PROBLEM = "family_copy_problem"
TRIP = "trip"

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
        return f"Copies from Gmail: on, {n} on Family now"

    def digest_line(self) -> str:
        """Counts only. Silent when nothing changed and nothing is wrong."""
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
        return " ".join(x for x in (line, problem) if x)

    # -- each tick -------------------------------------------------------------------
    def run(self, *, paused: bool) -> None:
        """Only after a new read. A bug here is a record, never a stopped loop."""
        gen = self.calendar.generation
        if gen == self._seen:
            return
        self._seen = gen
        try:
            if not paused and self.fa.enabled() and self.name():
                self._sync()
        except Exception as e:
            log.warning("family copy failed: %s", type(e).__name__)
            self.ledger.event("family_copy_failed", {"error": type(e).__name__})

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
        occ = feed.ahead.occurrences
        wants = {k: w for k, w in plan(occ, name, self.tz).items() if self._ends(w) > now}
        sources = {_key(o): o.summary for o in occ}
        self.writes = self._writes_today()
        problems = [self._follow(wants, family, now, feed.ahead.unreadable == 0, until)]
        problems.append(self._add_new(wants, sources, family.items, name))
        self._problem(next((p for p in problems if p), ""))

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
                until: datetime) -> str:
        items = {i.href: i for i in family.items}
        by_uid = {i.occ.uid: i for i in family.items}
        gone, absent = [], []
        problem = ""
        for row in self._live():
            start, end = self._when(row["start"]), self._when(row["end"])
            if self._moment(end) <= now:
                self._set(row, "done")
                continue
            begins = self._moment(start)
            if begins >= until:
                continue                   # past what was read: unread, not gone
            item = items.get(row["href"]) if row["hand"] else by_uid.get(row["uid"])
            want = wants.get(row["key"])
            if item is None:
                absent.append((row, want))
                continue
            if row["hand"]:
                if row["seen"] != _seen(item.occ):
                    self._set(row, "hands_off")    # not what was taken over any more
                    continue
            elif want is not None and self._landed(item.occ, want):
                # Already as it should be: a write whose answer was lost.
                if not (_same(want.start, start) and _same(want.end, end)):
                    self._moved(row, row["uid"], want)
                elif row["missing"]:
                    self._update(row, missing=0)
                continue
            elif not self._as_written(item.occ, row, start, end):
                self._set(row, "hands_off")        # someone edited it: theirs now
                continue
            if want is None:
                if gmail_clean:
                    gone.append((row, item))
                continue
            if row["missing"]:
                self._update(row, missing=0)
            # Once begun, a trip's flights have left the read: that's not a change.
            retitled = not row["hand"] and want.title != row["title"] and begins > now
            if retitled or not (_same(want.start, start) and _same(want.end, end)):
                if not self._room():
                    continue
                problem = self._move(row, item, want)
                if problem:
                    break
        else:
            problem = self._absent(absent, family.unreadable == 0)
            problem = self._cancel(gone, wants) or problem
        return problem

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
        """Gone from Family. One read can be wrong, and so can many gone at once."""
        if not family_clean or not absent:
            return ""
        if len(absent) > MAX_REMOVALS_AT_ONCE:
            return (f"Copies from Gmail: {len(absent)} events look gone from Family at once. That "
                    "looks like a bad read, so I changed nothing.")
        for row, want in absent:
            if row["missing"] + 1 < READS_BEFORE_REMOVING:
                self._update(row, missing=row["missing"] + 1)
            elif want is None:
                self._set(row, "cancelled")        # gone on both sides: nothing to learn
            else:
                self._removed(row)
        return ""

    def _cancel(self, gone: list, wants: dict) -> str:
        ready = [(row, item) for row, item in gone if row["missing"] + 1 >= READS_BEFORE_REMOVING]
        for row, _ in gone:
            self._update(row, missing=row["missing"] + 1)
        # A series changed: Gmail still has as many as went. Many gone from a read that
        # came back thin is a bad read.
        if len(ready) > MAX_REMOVALS_AT_ONCE and len(wants) < len(ready):
            return (f"Copies from Gmail: {len(ready)} events look cancelled at once. That looks "
                    "like a bad read, so I left them on Family.")
        problem = ""
        for row, item in ready:
            if not self._room():
                break
            out = (self.client.remove_hand_copy(item.href, item.etag) if row["hand"]
                   else self.client.undo(row["uid"], item.etag))
            if out.kind in ("ok", "gone"):
                self._set(row, "cancelled")
                self._log("family_copy_cancelled", row["key"])
                self.writes += 1
            elif out.kind == "changed":
                self._set(row, "hands_off")
            else:
                problem = self._write_problem(out)
                break
        return problem

    def _removed(self, row) -> None:
        """Gone from Family with no help from here: taken as his answer, and not put back."""
        if row["hand"]:
            self._set(row, "done")
            return
        self._set(row, "removed")
        self._log("family_copy_removed", row["key"])

    def _move(self, row, item, want: Want) -> str:
        now = self.ledger.now()
        if row["hand"]:
            # Takes over his copy: removed, and ours written in its place.
            out = self.client.remove_hand_copy(item.href, item.etag)
            if out.kind == "changed":
                self._set(row, "hands_off")
                return ""
            if out.kind not in ("ok", "gone"):
                return self._write_problem(out)
            etag = None
        else:
            etag = item.etag
        uid = _uid(row["key"]) if row["hand"] else row["uid"]
        out = self.client.put_copy(uid, want.title, want.start, want.end, now, etag=etag)
        if out.kind == "changed":
            self._set(row, "hands_off")
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
        claimed = {r["href"] for r in live if r["hand"]} | {r["uid"] for r in live}
        free = [i for i in family if i.href not in claimed and i.occ.uid not in claimed]
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
                    self._insert(key, want, match.occ.uid, match.href, hand=1,
                                 seen=_seen(match.occ))
                    free = [i for i in free if i.href != match.href]
                continue
            if not self._room():
                break
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


def _text(value) -> str:
    return value.isoformat()
