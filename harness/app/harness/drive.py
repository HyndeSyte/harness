"""How long the drive is between the school and an event's address, for school runs.

OpenStreetMap's free services turn an address into a place and two places into a drive time,
with no account and no key. They get a street address and map points only. The address is
built from what's recognized as a house number, a street, and a town and state, so a name
or note beside it stays behind, and a place with no street in it isn't sent at all. Each
answer is kept, so an address goes out once. Nothing here decides anything (family_gmail.py).
"""
from __future__ import annotations

import hashlib
import logging
import re
import time
from urllib.parse import quote, urlencode

from .ledger import Ledger
from .net import Transport, TransportError

log = logging.getLogger("harness.drive")

GEOCODE_HOST = "nominatim.openstreetmap.org"
ROUTE_HOST = "router.project-osrm.org"
HOSTS = frozenset({GEOCODE_HOST, ROUTE_HOST})
# Both services ask callers to say who they are, and to go slowly.
AGENT = {"User-Agent": "harness-addon/1 (https://github.com/HyndeSyte/harness)", "Accept": "application/json"}
TIMEOUT_S = 5
MAX_REQUESTS_PER_READ = 10
MAX_SECONDS_PER_READ = 20         # the app waits on this, so a slow service can't hold it up
MAX_MINUTES = 240                 # longer means the wrong town was found: no answer, not far away
AROUND_SCHOOL = 1.0               # degrees: prefer a match this close, for an address with no town

NO_ADDRESS = "no address"
FAILED = "failed"

_ONLINE = re.compile(r"://|\b(?:zoom|teams|webex|google meet|telehealth|virtual|online)\b", re.I)
_IN_BRACKETS = re.compile(r"\((\d[^()]*)\)")
_ANY_BRACKETS = re.compile(r"\([^()]*\)")
_SUFFIX = (r"st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|hwy|highway|ct|court|pl|place|way|"
           r"pike|pkwy|parkway|cir|circle|ter|terrace|trl|trail|loop|run|sq|square")
_STREET = re.compile(rf"\d+[A-Za-z]?(?:\s+[\w.'-]+){{0,5}}?\s+(?:{_SUFFIX})\b\.?"
                     r"|\d+[A-Za-z]?\s+(?:us|va|rt|route|hwy|highway)[ -]?\d+\b", re.I)
_TOWN_STATE = re.compile(r"\s*,\s*(?:([A-Za-z][A-Za-z .'-]{1,40}?)\s*,\s*)?([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\b")


def is_online(place: str) -> bool:
    return bool(_ONLINE.search(place or ""))


def street_address(place: str) -> str:
    """Only the recognized parts of a place: a calendar often has a name in front of them, and
    what's beside them may be a person's. Empty when there's no street in it."""
    text = re.sub(r"\s*\n\s*", ", ", (place or "").strip())
    inner = _IN_BRACKETS.search(text)
    text = inner.group(1) if inner else _ANY_BRACKETS.sub(" ", text)
    for part_start in (m.end() for m in re.finditer(r"(?:^|,)\s*", text)):
        street = _STREET.match(text, part_start)
        if street:
            address = " ".join(street.group(0).split())
            tail = _TOWN_STATE.match(text, street.end())
            if tail:
                town, state, code = tail.groups()
                address += "".join(f", {x}" for x in (town, state) if x) + (f" {code}" if code else "")
            return address
    return ""


class Drives:
    def __init__(self, ledger: Ledger, transport: Transport, school_fn, *, sleep=time.sleep,
                 clock=time.monotonic):
        self.ledger = ledger
        self.transport = transport
        self.school_fn = school_fn         # the school's address, from the add-on's settings
        self.sleep = sleep
        self.clock = clock
        self.begin()

    def begin(self) -> None:
        """A new read. A service that's down isn't asked again until the next."""
        self._requests = 0
        self._down = False
        self._started = self.clock()

    def on(self) -> bool:
        return bool(street_address(self.school_fn()))

    def misread(self) -> bool:
        """Something's entered for the school, and it can't be used."""
        return bool((self.school_fn() or "").strip()) and not self.on()

    def minutes(self, place: str) -> float | str:
        """The drive from the school to this place, or NO_ADDRESS, or FAILED."""
        if is_online(place):
            return 0.0
        address = street_address(place)
        if not address:
            return NO_ADDRESS
        school = street_address(self.school_fn())
        key = "drive_minutes:" + _hash(school.casefold() + "|" + address.casefold())
        kept = self.ledger.get_meta(key)
        if kept is not None:
            return self._read(kept)
        home = self._locate(school)
        if home == NO_ADDRESS or home == FAILED:
            return FAILED                  # the school's address is the setting's trouble, not this event's
        there = self._locate(address, near=home)
        if there == NO_ADDRESS or there == FAILED:
            return there
        found = self._route(home, there)
        if found == FAILED:
            return FAILED
        with self.ledger.tx() as db:
            self.ledger.set_meta(key, found, db)
        return self._read(found)

    @staticmethod
    def _read(kept: str) -> float | str:
        if kept == "none":
            return NO_ADDRESS
        minutes = float(kept)
        return minutes if minutes <= MAX_MINUTES else NO_ADDRESS

    def _locate(self, address: str, near: str = "") -> str:
        """"lon,lat", which is how the route service wants it."""
        key = "drive_place:" + _hash(address.casefold())
        kept = self.ledger.get_meta(key)
        if kept is not None:
            return NO_ADDRESS if kept == "none" else kept
        fields = {"format": "jsonv2", "limit": "1", "q": address}
        if near:
            lon, lat = (float(x) for x in near.split(","))
            fields["viewbox"] = (f"{lon - AROUND_SCHOOL},{lat + AROUND_SCHOOL},"
                                 f"{lon + AROUND_SCHOOL},{lat - AROUND_SCHOOL}")
        answer = self._get(f"https://{GEOCODE_HOST}/search?{urlencode(fields)}")
        if answer is None:
            return FAILED
        try:
            found = f"{float(answer[0]['lon'])},{float(answer[0]['lat'])}" if answer else "none"
        except (KeyError, IndexError, TypeError, ValueError):
            return FAILED
        with self.ledger.tx() as db:
            self.ledger.set_meta(key, found, db)
        return NO_ADDRESS if found == "none" else found

    def _route(self, start: str, end: str) -> str:
        """Minutes as text for keeping, or "none" when no road joins them, or FAILED."""
        points = quote(f"{start};{end}", safe=",;.-")
        answer = self._get(f"https://{ROUTE_HOST}/route/v1/driving/{points}?overview=false", no_route_ok=True)
        if answer == "none":
            return "none"
        try:
            minutes = float(answer["routes"][0]["duration"]) / 60
        except (KeyError, IndexError, TypeError, ValueError):
            return FAILED
        return str(minutes) if minutes >= 0 else FAILED

    def _get(self, url: str, *, no_route_ok: bool = False):
        if self._down or self._requests >= MAX_REQUESTS_PER_READ \
                or self.clock() - self._started > MAX_SECONDS_PER_READ:
            return None
        if self._requests:
            self.sleep(1)
        self._requests += 1
        try:
            response = self.transport.request("GET", url, headers=AGENT, timeout=TIMEOUT_S)
            if no_route_ok and response.status == 400:
                return "none"              # about these two places: the service itself is fine
            if response.status != 200:
                raise ValueError(response.status)
            return response.json()
        except (TransportError, ValueError) as e:
            log.warning("drive lookup failed: %s", type(e).__name__)   # never the address
            self._down = True
            return None


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]
