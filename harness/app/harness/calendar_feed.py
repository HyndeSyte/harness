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
import re
from concurrent.futures import Executor, Future
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import ical
from .ledger import Ledger
from .net import REDACT, Transport, TransportError

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


@dataclass
class FeedResult:
    feed: str
    ok: bool
    window: ical.Window | None = None
    error: str = ""
    day: str = ""              # the local day the window describes


@dataclass
class Snapshot:
    """The last good read of each feed, for one local day."""
    day: str = ""
    feeds: dict[str, FeedResult] = field(default_factory=dict)


def fetch_one(transport: Transport, url: str, *, start: datetime, end: datetime,
              tz: str) -> FeedResult:
    fid = feed_id(url)
    REDACT.register(url, url.rsplit("/", 2)[-2])          # the address and its private part
    try:
        resp = transport.request("GET", url, headers={"accept": "text/calendar"},
                                 timeout=TIMEOUT_S)
    except TransportError as e:
        return FeedResult(fid, False, error=f"couldn't reach Google ({e.kind})")
    if resp.status == 404:
        return FeedResult(fid, False, error="Google says this address doesn't exist "
                                           "(was it reset?)")
    if resp.status in (401, 403):
        return FeedResult(fid, False, error=f"Google refused this address ({resp.status})")
    if resp.status != 200:
        return FeedResult(fid, False, error=f"Google answered {resp.status}")
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
        return FeedResult(fid, False, error=f"couldn't read the calendar ({type(e).__name__})")
    return FeedResult(fid, True, window=w,
                      day=start.astimezone(ZoneInfo(tz)).date().isoformat())


def today_bounds(now: datetime, tz: str) -> tuple[datetime, datetime, str]:
    local = ZoneInfo(tz)
    d = now.astimezone(local).date()
    start = datetime.combine(d, datetime.min.time(), tzinfo=local)
    end = datetime.combine(d + timedelta(days=1), datetime.min.time(), tzinfo=local)
    return start, end, d.isoformat()


class CalendarFeeds:
    """Owned by the controller thread; fetches happen in workers."""

    def __init__(self, ledger: Ledger, transport: Transport, executor: Executor,
                 urls_fn, tz: str):
        self.ledger = ledger
        self.transport = transport
        self.executor = executor
        self.urls_fn = urls_fn
        self.tz = tz
        self.snapshot = Snapshot()
        self._futures: dict[str, Future] = {}
        self._started_at: dict[str, datetime] = {}
        self._last_start: datetime | None = None
        self._pre_digest_day: str | None = None

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
        elif self._last_start and now - self._last_start < FETCH_EVERY:
            return
        self.start()

    def start(self) -> None:
        now = self.ledger.now()
        self._last_start = now
        start, end, _ = today_bounds(now, self.tz)
        for url in self.urls():
            fid = feed_id(url)
            if fid in self._futures:
                continue
            self._futures[fid] = self.executor.submit(fetch_one, self.transport, url,
                                                      start=start, end=end, tz=self.tz)
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
                        self.ledger.input_failed(f"calendar:{fid}", "the read took too long")
                continue
            del self._futures[fid]
            try:
                res: FeedResult = fut.result()
            except Exception as e:
                res = FeedResult(fid, False, error=type(e).__name__)
            if fid not in live:
                continue
            if res.ok:
                self.ledger.input_ok(f"calendar:{fid}")
                if res.window is not None and res.day == day:
                    # A read that started yesterday describes yesterday.
                    self.snapshot.feeds[fid] = res
            else:
                self.ledger.input_failed(f"calendar:{fid}", res.error)

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
    def coverage(self) -> list[tuple[str, datetime | None, str]]:
        """(label, last success, last error) per configured feed."""
        rows = self.ledger.inputs()
        out = []
        for url in self.urls():
            fid = feed_id(url)
            row = rows.get(f"calendar:{fid}")
            res = self.snapshot.feeds.get(fid)
            label = res.window.calendar if res and res.window else f"calendar {fid[:4]}"
            ok_at = (datetime.fromisoformat(row["last_success_at"])
                     if row is not None and row["last_success_at"] else None)
            err = row["last_error"] if row is not None and row["last_error"] else ""
            out.append((label, ok_at, err))
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
