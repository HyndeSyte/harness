"""Keeping his Gmail calendar true to Family, for the few events that tie him up.

A Family event can be his commitment without being his event: while she's at an
appointment, he has the kids. The add-on's `family_to_gmail` option names those events
and what Gmail should say, as "Family title => Gmail title". Each one gets a block on
Gmail, which moves when it moves and goes when it goes, with no tap and no model.

The mirror image of family_copy.py, and it keeps the same safety:

  * Gmail gets the fixed title he set and the times, never text from Family, and no
    guest, place or update (google_cal.py). His own default reminders apply: they're
    his, and a service account can't turn them off.
  * It changes only blocks it wrote. A block someone has since edited is left alone for
    good, and one someone removed, with its Family event still there, stays removed.
  * Nothing is removed, or taken as removed, on one read. It takes two good reads in a
    row, and more than a few at once is held back for a while as a sign the read is wrong.
  * If Family or Google can't be read, nothing happens.

The two can't chase each other: a title here must carry a word family_copy.py skips, so
a block never copies to Family, and a copy on Family (hx- uid) never gets a block.

Before its first block, one test event goes on Gmail and comes off again, so a key or
share that doesn't work costs nothing and says so.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from . import caldav, calendar_feed, google_cal, ical
from .family_copy import (_SKIP, _STAY, AHEAD_DAYS, GIVE_UP_READS, HOLD_READS, MAX_REMOVALS_AT_ONCE,
                          READS_BEFORE_REMOVING, _same)
from .ledger import Ledger, iso

log = logging.getLogger("harness.family_gmail")

MAX_WRITES_PER_DAY = 30        # a weekly event that changes time is 18 writes, and no one's alerted
MAX_RULES = 5
MAX_TITLE = 60
PROBLEM = "family_gmail_problem"
PROVEN = "family_gmail_proven"
TEST_TRY = "family_gmail_test_try"
READ_SIZE = "family_gmail_read_size"
THIN_READS = "family_gmail_thin_reads"
TEST_TITLE = "Busy (harness test, safe to delete)"
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


@dataclass(frozen=True)
class Want:
    key: str
    title: str
    start: datetime
    end: datetime


def plan(items: list[caldav.Item], rules: tuple[Rule, ...]) -> dict[str, Want]:
    """What Gmail should hold, from Family alone. A title comes only from a rule."""
    titles = {r.family: r.title for r in rules}
    out: dict[str, Want] = {}
    for item in items:
        occ: ical.Occurrence = item.occ
        title = titles.get(occ.summary.strip().casefold())
        if title is None or occ.all_day or occ.uid.startswith("hx-") or occ.end <= occ.start:
            continue
        # A moved day keeps its series and its place in it, so it keeps its block.
        key = hashlib.sha256(f"{occ.uid}|{occ.instance}".encode()).hexdigest()[:32]
        out[key] = Want(key, title, occ.start, occ.end)
    return out


def _intent(title: str, start: datetime, end: datetime) -> str:
    return json.dumps([title, start.isoformat(), end.isoformat()])


def _was_sent(intent: str, block: google_cal.Block) -> bool:
    """Google hands times back in the calendar's own offset, so compare moments."""
    if not intent:
        return False
    title, start, end = json.loads(intent)
    return block.title == title and _same(block.start, datetime.fromisoformat(start)) \
        and _same(block.end, datetime.fromisoformat(end))


class FamilyGmail:
    def __init__(self, ledger: Ledger, family_add, calendar, google: google_cal.GoogleCalendar,
                 *, rules_fn=lambda: (), tz: str):
        self.ledger = ledger
        self.fa = family_add
        self.client = family_add.client
        self.calendar = calendar
        self.google = google
        self.rules_fn = rules_fn
        self.tz = tz
        self._seen: int | None = None      # the calendar read last looked at

    # -- what he sees ----------------------------------------------------------------
    def status_line(self) -> str:
        if not self.rules_fn():
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
        return " ".join(x for x in (line, problem) if x)

    # -- each tick -------------------------------------------------------------------
    def run(self, *, paused: bool) -> None:
        """Only after a new read. A bug here is a record, never a stopped loop."""
        gen = self.calendar.generation
        if gen == self._seen:
            return
        self._seen = gen
        try:
            if not paused and self.fa.enabled() and self.rules_fn() and self.google.configured():
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
        named = plan(family.items, rules)
        wants = {k: w for k, w in named.items() if w.end > now}
        self.writes = self._writes_today()
        problem = self._follow(address, wants, {b.id: b for b in blocks}, now, until,
                               family.unreadable == 0, self._thin(len(family.items) - len(named)))
        added = self._add_new(address, wants)
        self._problem(problem or added)

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
                if not (_same(want.start, start) and _same(want.end, end) and want.title == title):
                    self._moved(row, want)
                elif row["missing"]:
                    self._update(row, missing=0)
                continue
            # A move whose answer was lost, with the event moved again since: still ours.
            if not _was_sent(row["intent"], block) and not (block.title == title and _same(block.start, start)
                                 and _same(block.end, end)):
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
            self._update(row, intent=_intent(want.title, want.start, want.end))
            out = self.google.move(address, block, want.title, want.start, want.end)
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
            and _same(block.end, want.end)

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
        ready = [(row, block) for row, block in gone if row["missing"] + 1 >= READS_BEFORE_REMOVING]
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
                     missing=0, intent="")
        self._log("family_gmail_moved", row["key"])
        self.writes += 1

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
            out = self.google.add(address, uid, want.title, want.start, want.end)
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
        return failed

    # -- the record ----------------------------------------------------------------------
    def _insert(self, want: Want, uid: str, generation: int, state: str = "live") -> None:
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute(
                "INSERT INTO family_gmail(key, event_id, generation, intent, title, start, end,"
                " state, missing, created_at, updated_at) VALUES(?,?,?,'',?,?,?,?,0,?,?)"
                " ON CONFLICT(key) DO UPDATE SET event_id=excluded.event_id,"
                " generation=excluded.generation, intent='', title=excluded.title,"
                " start=excluded.start, end=excluded.end, state=excluded.state, missing=0,"
                " updated_at=excluded.updated_at",
                (want.key, uid, generation, want.title, want.start.isoformat(),
                 want.end.isoformat(), state, now, now))

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
