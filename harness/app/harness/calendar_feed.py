"""S1: read his calendars, read-only, for the morning digest.

Source: each calendar's secret iCal address from Google Calendar
(Settings > the calendar > Integrate calendar). It is a read-only link by
construction, so no bug here can change his calendar, and no Google
Cloud project, sign-in or refresh token is involved. The address is a
secret: it lives in the vault with the other keys, is registered with
the log redactor before any request, and never appears in an error.

Fetches run in a worker (the controller thread never waits on the
network) every FETCH_EVERY, and once more just before the digest if the
last good read is older than FRESH_FOR. Each feed is its own input, so a
dead feed is named in the digest instead of quietly shrinking the agenda.
"""
from __future__ import annotations

import hashlib
import logging
import re
from concurrent.futures import Executor, Future
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NamedTuple
from zoneinfo import ZoneInfo

from . import ical, inputs
from .ledger import Ledger
from .net import REDACT, Transport, TransportError

log = logging.getLogger(__name__)

# Google's secret address, and nothing else: the controller only ever
# fetches from calendar.google.com.
URL_RE = re.compile(r"https://calendar\.google\.com/calendar/ical/[A-Za-z0-9._%@+-]{3,200}"
                    r"/private-[0-9a-f]{16,64}/basic\.ics")
MAX_FEEDS = 6
MAX_BYTES = 15 * 1024 * 1024
FETCH_EVERY = timedelta(minutes=30)
FRESH_FOR = timedelta(minutes=10)
MAX_AGE = timedelta(hours=2)          # the digest calls a feed stale after this
TIMEOUT_S = 30
GIVE_UP_AFTER = timedelta(minutes=3)    # a read still running after this is abandoned


def split_urls(value: str) -> list[str]:
    return [u for u in re.split(r"[\s,]+", (value or "").strip()) if u]


def check_urls(value: str) -> str:
    """Normalized form for the vault, or ValueError naming the problem."""
    urls = split_urls(value)
    if not urls:
        raise ValueError("no calendar address")
    if len(urls) > MAX_FEEDS:
        raise ValueError(f"at most {MAX_FEEDS} calendars")
    for u in urls:
        if not URL_RE.fullmatch(u):
            raise ValueError("that isn't a Google Calendar secret iCal address "
                             "(https://calendar.google.com/calendar/ical/.../private-.../basic.ics)")
    if len(set(urls)) != len(urls):
        raise ValueError("the same calendar address is in there twice")
    return " ".join(urls)


def feed_id(url: str) -> str:
    """A stable, non-secret name for a feed in the ledger and the logs."""
    return hashlib.sha256(url.encode()).hexdigest()[:8]


class FeedCoverage(NamedTuple):
    """One calendar address, for the digest and the Harness page."""
    label: str                 # the calendar's own name, the last it was read under; "" before any
    ok_at: datetime | None     # its last good read
    error: str                 # its last failure, in his words
    failing: bool              # down, and not a single blip (inputs.worth_naming)
    name: str                  # its input: calendar:<feed id>


@dataclass
class FeedResult:
    feed: str
    ok: bool
    window: ical.Window | None = None
    error: str = ""
    kind: str = "error"        # a failure's kind for the watch: "unreachable" for no answer (inputs.py)
    day: str = ""              # the local day the window describes
    # The same feed over the mirror's horizon (shadow mode), when asked for.
    ahead: ical.Window | None = None
    ahead_error: str = ""      # why the ahead parse failed; today's window is unaffected


@dataclass
class Snapshot:
    """The last good read of each feed, for one local day."""
    day: str = ""
    feeds: dict[str, FeedResult] = field(default_factory=dict)


def fetch_one(transport: Transport, url: str, *, start: datetime, end: datetime,
              tz: str, ahead_until: datetime | None = None) -> FeedResult:
    fid = feed_id(url)
    REDACT.register(url, url.rsplit("/", 2)[-2])          # the address and its private part
    try:
        resp = transport.request("GET", url, headers={"accept": "text/calendar"},
                                 timeout=TIMEOUT_S)
    except TransportError as e:
        log.info("calendar %s: no answer (%s)", fid[:4], e.kind)
        return FeedResult(fid, False, error="couldn't reach Google", kind="unreachable")
    if resp.status != 200:
        log.info("calendar %s: Google answered %s", fid[:4], resp.status)
    if resp.status >= 500 or resp.status in (408, 429):
        return FeedResult(fid, False, error="Google isn't answering right now", kind="unreachable")
    if resp.status == 404:
        return FeedResult(fid, False, error="Google says this address doesn't exist "
                                           "(was it reset?)")
    if resp.status in (401, 403):
        return FeedResult(fid, False, error="Google refused this address")
    if resp.status != 200:
        return FeedResult(fid, False, error="Google answered with an error")
    if len(resp.body) > MAX_BYTES:
        return FeedResult(fid, False, error="the calendar is larger than this reads")
    text = resp.body.decode("utf-8", "replace").lstrip("\ufeff")
    if "BEGIN:VCALENDAR" not in text[:2000]:
        return FeedResult(fid, False, error="the answer wasn't a calendar")
    if "END:VCALENDAR" not in text[-2000:]:
        return FeedResult(fid, False, error="the calendar arrived cut off")
    try:
        w = ical.window(text, start=start, end=end, tz=tz, fallback_name=f"Calendar {fid[:4]}")
    except Exception as e:                       # a parser bug must not kill the loop
        log.info("calendar %s: couldn't read it (%s)", fid[:4], type(e).__name__)
        return FeedResult(fid, False, error="couldn't read the calendar")
    # The mirror's longer window is parsed on its own: whatever goes wrong
    # there leaves it unread for the shadow and never touches today's agenda.
    ahead, ahead_error = None, ""
    if ahead_until is not None and ahead_until > end:
        try:
            ahead = ical.window(text, start=start, end=ahead_until, tz=tz,
                                fallback_name=f"Calendar {fid[:4]}")
        except Exception as e:
            ahead_error = type(e).__name__
    return FeedResult(fid, True, window=w,
                      day=start.astimezone(ZoneInfo(tz)).date().isoformat(), ahead=ahead,
                      ahead_error=ahead_error)


def today_bounds(now: datetime, tz: str) -> tuple[datetime, datetime, str]:
    local = ZoneInfo(tz)
    d = now.astimezone(local).date()
    start = datetime.combine(d, datetime.min.time(), tzinfo=local)
    end = datetime.combine(d + timedelta(days=1), datetime.min.time(), tzinfo=local)
    return start, end, d.isoformat()


class CalendarFeeds:
    """Owned by the controller thread; fetches happen in workers."""

    def __init__(self, ledger: Ledger, transport: Transport, executor: Executor,
                 urls_fn, tz: str, *, ahead_days: int = 0, ahead_when=None, ahead_from=None):
        self.ledger = ledger
        # (address, start, until) -> Window or None: his Gmail calendar read now, in place of the
        # feed's cached copy for the days ahead. None, or no answer, keeps the feed's.
        self.ahead_from = ahead_from
        self.ahead_days = ahead_days       # > 0: each read also parses this far ahead
        # Called at each read: False skips the ahead parse (no mirror settings
        # entered). None: always parse ahead when ahead_days > 0.
        self.ahead_when = ahead_when
        self.transport = transport
        self.executor = executor
        self.urls_fn = urls_fn
        self.tz = tz
        self.snapshot = Snapshot()
        self._futures: dict[str, Future] = {}
        self._started_at: dict[str, datetime] = {}
        self._last_start: datetime | None = None
        self._pre_digest_day: str | None = None
        self.generation = 0            # bumps whenever a read lands (ok or not)
        self._soon: datetime | None = None   # a read asked for before the usual time

    # -- what the controller calls -------------------------------------------------
    def urls(self) -> list[str]:
        return split_urls(self.urls_fn() or "")

    @property
    def configured(self) -> bool:
        return bool(self.urls())

    @property
    def pending(self) -> bool:
        return bool(self._futures)

    def maybe_start(self, *, before_digest: bool = False) -> None:
        if not self.configured or self._futures:
            return
        now = self.ledger.now()
        if before_digest:
            # One extra read per morning, not a retry loop against Google.
            _, _, day = today_bounds(now, self.tz)
            if self._pre_digest_day == day or self._fresh(now, FRESH_FOR):
                return
            self._pre_digest_day = day
        elif self._soon is not None and now >= self._soon:
            pass
        elif self._last_start and now - self._last_start < FETCH_EVERY:
            return
        self.start()

    def _read(self, url: str, start: datetime, end: datetime, ahead_until: datetime | None) -> FeedResult:
        """In a worker: a slow answer from Google never holds up his chat."""
        res = fetch_one(self.transport, url, start=start, end=end, tz=self.tz, ahead_until=ahead_until)
        if ahead_until is not None:
            self._fresh_ahead(res, (start, ahead_until))
        return res

    def _fresh_ahead(self, res: FeedResult, span: tuple[datetime, datetime]) -> None:
        if self.ahead_from is None or not res.ok or res.ahead is None or res.window is None \
                or not res.window.calendar.casefold().endswith("@gmail.com"):
            return
        try:
            fresh = self.ahead_from(res.window.calendar, *span)
        except Exception as e:                     # the feed's copy stands
            log.warning("gmail read failed: %s", type(e).__name__)
            fresh = None
        if fresh is not None:
            res.ahead = fresh
            log.info("gmail read through google: %d events, %d unreadable", len(fresh.occurrences),
                     fresh.unreadable)
        else:
            log.info("gmail read through google: none, the feed stands")

    def read_soon(self, after: timedelta = timedelta(0)) -> None:
        """He changed something, or a removal waits on a second look: read then, not at the usual
        time. A read already going started before this, so another follows it."""
        at = self.ledger.now() + after
        if self._soon is None or at < self._soon:
            self._soon = at

    def start(self) -> None:
        now = self.ledger.now()
        self._last_start = now
        if self._soon is not None and self._soon <= now:
            self._soon = None
        start, end, _ = today_bounds(now, self.tz)
        ahead_until = (start + timedelta(days=self.ahead_days + 1)
                       if self.ahead_days and self._want_ahead() else None)
        for url in self.urls():
            fid = feed_id(url)
            if fid in self._futures:
                continue
            self._futures[fid] = self.executor.submit(self._read, url, start, end, ahead_until)
            self._started_at[fid] = now

    def collect(self) -> None:
        _, _, day = today_bounds(self.ledger.now(), self.tz)
        if self.snapshot.day != day:
            self.snapshot = Snapshot(day=day)          # yesterday's agenda is not today's
        live = {feed_id(u) for u in self.urls()}
        for fid in list(self.snapshot.feeds):
            if fid not in live:
                del self.snapshot.feeds[fid]           # a removed calendar is forgotten
        now = self.ledger.now()
        for fid, fut in list(self._futures.items()):
            if not fut.done():
                if now - self._started_at.get(fid, now) > GIVE_UP_AFTER:
                    # A trickling connection can outlive every socket timeout.
                    # Stop waiting for it; its result, if it ever comes, is dropped.
                    fut.cancel()
                    del self._futures[fid]
                    if fid in live:
                        self.ledger.input_failed(f"calendar:{fid}", "the read took too long", "unreachable")
                continue
            del self._futures[fid]
            self.generation += 1
            try:
                res: FeedResult = fut.result()
            except Exception as e:
                log.info("calendar %s: the read stopped (%s)", fid[:4], type(e).__name__)
                res = FeedResult(fid, False, error="the read stopped on an unexpected problem")
            if fid not in live:
                continue
            if res.ok:
                # Its own name kept too, for his messages after midnight or a restart.
                self.ledger.input_ok(f"calendar:{fid}", label=res.window.calendar if res.window else "")
                if res.ahead_error:
                    with self.ledger.tx() as db:
                        self.ledger.event("calendar_ahead_failed",
                                          {"feed": fid, "error": res.ahead_error}, db=db)
                if res.window is not None and res.day == day:
                    # A read that started yesterday describes yesterday.
                    self.snapshot.feeds[fid] = res
            else:
                self.ledger.input_failed(f"calendar:{fid}", res.error, res.kind)
                prev = self.snapshot.feeds.get(fid)
                if prev is not None:
                    # Today's agenda keeps the last good read; the mirror's
                    # ahead window does not: a feed whose latest read failed
                    # is unread for the shadow (no delete from stale data).
                    prev.ahead = None

    def _want_ahead(self) -> bool:
        if self.ahead_when is None:
            return True
        try:
            return bool(self.ahead_when())
        except Exception:                       # unknown: today's read is what matters
            return False

    def _fresh(self, now: datetime, within: timedelta) -> bool:
        rows = self.ledger.inputs()
        for url in self.urls():
            row = rows.get(f"calendar:{feed_id(url)}")
            if row is None or not row["last_success_at"]:
                return False
            if now - datetime.fromisoformat(row["last_success_at"]) > within:
                return False
        return True

    # -- for the digest -----------------------------------------------------------------
    def coverage(self) -> list[FeedCoverage]:
        """Each configured feed: its name, last good read, last failure, and whether it's failing."""
        rows = self.ledger.inputs()
        out = []
        for name, label in self.inputs(rows):
            row = rows.get(name)
            ok_at = (datetime.fromisoformat(row["last_success_at"])
                     if row is not None and row["last_success_at"] else None)
            err = row["last_error"] if row is not None and row["last_error"] else ""
            out.append(FeedCoverage(label, ok_at, err, row is not None and inputs.worth_naming(row), name))
        return out

    def inputs(self, rows: dict | None = None) -> list[tuple[str, str]]:
        """(input name, label) per configured feed: its own name from today's read, else the last
        one it was read under, else "" (his messages say "one of your calendars")."""
        rows = self.ledger.inputs() if rows is None else rows
        out = []
        for url in self.urls():
            fid = feed_id(url)
            res = self.snapshot.feeds.get(fid)
            row = rows.get(f"calendar:{fid}")
            out.append((f"calendar:{fid}", res.window.calendar if res and res.window
                        else row["label"] if row is not None else ""))
        return out

    def agenda(self, day: str) -> tuple[list[ical.Occurrence], int, int, int]:
        """(today's occurrences from every feed read today, unreadable
        count, feeds read today, feeds configured)."""
        if self.snapshot.day != day:
            return [], 0, 0, len(self.urls())
        occ: list[ical.Occurrence] = []
        unreadable = 0
        for res in self.snapshot.feeds.values():
            occ += res.window.occurrences
            unreadable += res.window.unreadable
        return occ, unreadable, len(self.snapshot.feeds), len(self.urls())

    # -- for the mirror's shadow run ----------------------------------------------------
    def ahead(self, day: str) -> tuple[list[ical.Occurrence], int, int, int]:
        """(occurrences over the ahead window from every feed read today,
        unreadable count, feeds read today with an ahead window, feeds
        configured). Only feeds read today count: an older read is unread."""
        if self.snapshot.day != day or not self.ahead_days:
            return [], 0, 0, len(self.urls())
        occ: list[ical.Occurrence] = []
        unreadable = read = 0
        for res in self.snapshot.feeds.values():
            if res.ahead is None:
                continue
            read += 1
            occ += res.ahead.occurrences
            unreadable += res.ahead.unreadable
        return occ, unreadable, read, len(self.urls())
