"""How long a drive is: from the school to an event's address, for school runs, and between home
and his events' addresses, for his drive blocks.

OpenStreetMap's free services turn an address into a place and two places into a drive time,
with no account and no key. They get a street address and map points only. The address is
built from what's recognized as a house number, a street, and a town and state, so a name
or note beside it stays behind, and a place with no street in it isn't sent this way. Each
answer is kept, so an address goes out once. Home, from the add-on's settings, can be map
coordinates ("lat, lon"), which are used as they are and never looked up. Nothing here decides
anything (family_gmail.py).

A Family event's place is often only a name ("Funky's Skate Center"). When neither a street
address nor his place book (places.py) places it, find_place asks the map for that name, and
only that: the location's text, cut short, never the title or notes, and only within a box
around home. A result counts only if every meaningful word of the text is in its name;
otherwise it is not found, and he's asked. Found and not found are both kept, so a name goes
out once. The block then carries the place's name and street address, so Maps opens it.
"""
from __future__ import annotations

import hashlib
import logging
import math
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
AROUND_HOME = 1.0                 # degrees: a place found by name must be this close to home
MAX_NAME_TEXT = 100               # a place's name as sent: longer is a note, not a name
NAME_RESULTS = 5
MAX_LABEL = 60
_NOT_NAME_WORDS = frozenset({"the", "a", "an", "of", "at", "and", "in", "on"})

NO_ADDRESS = "no address"
FAILED = "failed"
FAMILY, OWN = "family", "own"        # whose drives a lookup is for (Drives.path)
LATER = "later"                   # this read's allowance of lookups is spent: the next read asks
HOME = "home"                     # between(): his home, from the add-on's settings

_ONLINE = re.compile(r"://|\b(?:zoom|teams|webex|google meet|telehealth|virtual|online)\b", re.I)
_IN_BRACKETS = re.compile(r"\((\d[^()]*)\)")
_ANY_BRACKETS = re.compile(r"\([^()]*\)")
_SUFFIX = (r"st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|hwy|highway|ct|court|pl|place|way|"
           r"pike|pkwy|parkway|cir|circle|ter|terrace|trl|trail|loop|run|sq|square|"
           r"xing|crossing|expy|expressway|fwy|freeway|tpke|turnpike|trce|trace|cres|crescent|aly|alley")
# A street's direction after its type ("Main St NW"), read as part of it.
_SIDE = r"(?:\s+(?:[NSEW]|NE|NW|SE|SW)\.?(?=\s*(?:,|$)))?"
_STREET = re.compile(rf"\d+[A-Za-z]?(?:\s+[\w.'-]+){{0,5}}?\s+(?:{_SUFFIX})\b\.?{_SIDE}"
                     rf"|\d+[A-Za-z]?\s+(?:us|va|rt|rte|route|hwy|highway)\.?[ -]?\d+\b{_SIDE}", re.I)
# A suite, unit or floor between the street and the town: skipped, never sent.
# The unit word ends at a word boundary and a unit number or letter follows it ("Suite 4",
# "Unit B", "#12"), so a town that starts with one ("Sterling", "Florence") stays a town.
_UNIT = re.compile(r"\s*,?\s*(?:(?:suite|ste|unit|apt|bldg|building|floor|fl|room|rm)\b\.?|#)\s*#?\s*"
                   r"(?=[\w-]{1,8}\b)(?:[A-Za-z-]*\d[\w-]*|[A-Za-z])\b", re.I)
# ", Town, ST 12345", ", ST", or a town and state with no comma between them when a zip
# code follows ("Town ST 12345", after a comma or not).
_TOWN_STATE = re.compile(r"\s*,\s*(?:([A-Za-z][A-Za-z .'-]{1,40}?)\s*,\s*)?([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\b"
                         r"|[\s,]+([A-Za-z][A-Za-z .'-]{1,40}?)\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b")


def is_online(place: str) -> bool:
    return bool(_ONLINE.search(place or ""))


# A phone call: a location that is only a phone number (with a label, an extension or a PIN), or
# words naming a call. A number is a tel: address, seven digits or more with a country code or
# not, or a vanity number with letters ("1-800-FLOWERS", "540-555-CALL").
_TEL = re.compile(r"\btel:[+\w().;=,-]+", re.I)
_NUMBER = re.compile(r"\+?\(?\d[\d\s().-]{5,}\d")
_VANITY = re.compile(r"(?<![\w-])(?:\+?1[\s.-]?)?(?:8\d\d[\s.-]?(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{3,10}"
                     r"|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?[A-Z]{4})(?![\w-])")
_DIAL_WORDS = re.compile(r"\b(?:dial[\s-]*in|dial|phone|telephone|tel|mobile|cell|call|conference|conf|line|"
                         r"bridge|number|num|no|pin|passcode|password|pw|access|code|meeting|id|ext|extension|"
                         r"x|or|and|then|press|enter|us|toll|free)\b", re.I)
_CALL = re.compile(r"\b(?:phone|call|calls|facetime|dial[\s-]*in|conference call)\b", re.I)


def _phone_only(text: str) -> bool:
    """Nothing but a phone number, with its label, extension or PIN: no place in it."""
    found = False

    def number(m: re.Match) -> str:
        nonlocal found
        if sum(ch.isdigit() for ch in m.group(0)) >= 7:
            found = True
            return " "
        return m.group(0)
    rest, tel = _TEL.subn(" ", text)
    rest, vanity = _VANITY.subn(" ", rest)
    rest = _NUMBER.sub(number, rest)
    if not (found or tel or vanity):
        return False
    rest = _DIAL_WORDS.sub(" ", re.sub(r"\d+", " ", rest))
    return not re.sub(r"[\s:#,;*()+./=_-]+", "", rest)


def is_call(text: str) -> bool:
    """A phone call, not a place to drive to: a location that is a phone number in any of its
    shapes, or words naming a call. Whole words only ("Callahan's" isn't one). A street address
    beside it wins (is_a_call, below)."""
    return bool(text) and (_phone_only(text) or bool(_CALL.search(text)))


def is_a_call(title: str, location: str) -> bool:
    """An appointment that's a call: its location is a phone number or names a call, or its title
    names one, unless the location has a street address, which means he goes there ("Curtain
    call" at a theater)."""
    if street_address(location):
        return False
    return is_call(location) or is_call(title)


_COORDS = re.compile(r"\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*")


def coordinates(text: str) -> str:
    """"lat, lon" as the route service wants it, "lon,lat". Empty when it isn't that."""
    m = _COORDS.fullmatch(text or "")
    if not m:
        return ""
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return ""
    return f"{lon},{lat}"


def point_text(text: str) -> str:
    """Map coordinates as a place is written: "lat, lon". Empty when it isn't that."""
    point = coordinates(text)
    if not point:
        return ""
    lon, lat = point.split(",")
    return f"{lat}, {lon}"


def name_words(text: str) -> frozenset[str]:
    """What a name says, for matching: its words, lower case, apostrophes and "the" left out,
    so "Funky's Skate Center" and "Funkys skate center" are the same."""
    t = re.sub(r"['\u2019`]", "", (text or "").casefold())
    return frozenset(w for w in re.findall(r"[^\W_]+", t) if w not in _NOT_NAME_WORDS)


def label(name: str) -> str:
    """A found place's name as a block may carry it, before its address: plain characters, no
    comma (the address follows one), cut short. Empty when nothing's left."""
    text = " ".join(re.sub(r"[^\w '&.\-]", " ", name or "").replace("_", " ").split())
    return text[:MAX_LABEL].strip()


def sound_place(location: str) -> bool:
    """What a block may carry as its place: a recognized street address, map coordinates
    ("lat, lon"), or a found place's name and then its street address. Never a note."""
    if not location:
        return True
    street = street_address(location)
    if location in (street, point_text(location)):
        return True
    if street and location.endswith(", " + street):
        name = location[:-len(street) - 2]
        return bool(name) and label(name) == name
    return False


def street_address(place: str) -> str:
    """Only the recognized parts of a place: a calendar often has a name in front of them, and
    what's beside them may be a person's. Empty when there's no street in it."""
    # Each line is a part: a venue's name on the first line and its street address on the next is
    # the usual shape from a phone's calendar. A newline written as the two characters "\n" too.
    text = re.sub(r"\s*(?:\n|\\n)\s*", ", ", (place or "").strip())
    inner = _IN_BRACKETS.search(text)
    text = inner.group(1) if inner else _ANY_BRACKETS.sub(" ", text)
    for part_start in (m.end() for m in re.finditer(r"(?:^|,)\s*", text)):
        street = _STREET.match(text, part_start)
        if street:
            address = " ".join(street.group(0).split())
            unit = _UNIT.match(text, street.end())
            tail = _TOWN_STATE.match(text, unit.end() if unit else street.end())
            if tail:
                town, state, code = tail.groups()[:3] if tail.group(2) else tail.groups()[3:]
                address += "".join(f", {x}" for x in (town, state) if x) + (f" {code}" if code else "")
            return address
    return ""


# One street said two ways ("St" and "Street", "N" and "North"): the same street (address_parts).
_SAME_WORD = {"st": "street", "ave": "avenue", "av": "avenue", "rd": "road", "dr": "drive", "ln": "lane",
              "blvd": "boulevard", "hwy": "highway", "ct": "court", "pl": "place", "pkwy": "parkway",
              "cir": "circle", "ter": "terrace", "trl": "trail", "sq": "square", "xing": "crossing",
              "expy": "expressway", "fwy": "freeway", "tpke": "turnpike", "trce": "trace", "cres": "crescent",
              "aly": "alley", "rt": "route", "rte": "route", "n": "north", "s": "south", "e": "east",
              "w": "west", "ne": "northeast", "nw": "northwest", "se": "southeast", "sw": "southwest"}
SAME_POINT_METERS = 150            # two map points this near are one place (same_place)


def address_parts(place: str) -> tuple[str, str, str, str] | None:
    """A place's street address in parts, through street_address: (house number, street, town,
    postcode), each lower case with the street's words in one spelling; a unit is never part of it.
    None when there's no street address in it."""
    address = street_address(place)
    if not address:
        return None
    street, *rest = [p.strip() for p in address.split(",")]
    m = re.match(r"(\d+[A-Za-z]?)\s+(.*)", street)
    if not m:
        return None
    words = [w.strip(".").casefold() for w in m.group(2).split()]
    name = " ".join(_SAME_WORD.get(w, w) for w in words if w)
    town = code = ""
    if rest:
        last = re.fullmatch(r"([A-Za-z]{2})(?:\s+(\d{5}))?", rest[-1])
        if last:
            code = last.group(2) or ""
            rest = rest[:-1]
        town = " ".join(rest[0].casefold().split()) if rest else ""
    return m.group(1).casefold(), name, town, code


def _meters(a: str, b: str) -> float:
    """Between two "lon,lat" points, near enough for a few hundred meters."""
    (lon1, lat1), (lon2, lat2) = ((float(x) for x in p.split(",")) for p in (a, b))
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371000 * math.hypot(x, math.radians(lat2 - lat1))


def same_place(a: str, b: str, points: tuple[str, str] = ("", "")) -> bool:
    """Two places are one: by their map points within SAME_POINT_METERS when both have one ("lon,lat"),
    else by their street addresses' parts (address_parts: the house number and the street the same, and
    the town or the postcode, where both sides say one), else, last, by their text with case, commas and
    spacing left out. "227 N Lewis St" and "227 North Lewis Street, Lexington, VA 24450" are one."""
    if not (a or "").strip() or not (b or "").strip():
        return False
    pa, pb = (points[0] or coordinates(a)), (points[1] or coordinates(b))
    if pa and pb:
        try:
            return _meters(pa, pb) <= SAME_POINT_METERS
        except ValueError:
            pass
    one, two = address_parts(a), address_parts(b)
    if one is not None and two is not None:
        if one[:2] != two[:2]:
            return False
        if one[2] and two[2] and one[2] != two[2] and not (one[3] and one[3] == two[3]):
            return False
        if one[3] and two[3] and one[3] != two[3]:
            return False
        return True
    if (one is None) != (two is None):
        return False

    def norm(text: str) -> str:
        return " ".join(text.casefold().replace(",", " ").split())
    return norm(a) == norm(b)


class Drives:
    def __init__(self, ledger: Ledger, transport: Transport, school_fn, *, home_fn=lambda: "",
                 sleep=time.sleep, clock=time.monotonic):
        self.ledger = ledger
        self.transport = transport
        self.school_fn = school_fn         # the school's address, from the add-on's settings
        self.home_fn = home_fn             # his home: "lat, lon" or a street address, the same
        self.sleep = sleep
        self.clock = clock
        # "" in live use. The drive dry run (family_gmail.py) sets its own: it reads every kept answer
        # but keeps what it looks up apart, so nothing it asks can change a Family event's drives.
        self.side = ""
        # Whose drives the lookups being made are for: "family" (a Family event's, and in live use the
        # chain they share with his own appointments) or "own" (his own appointments: their places, and
        # every drive the dry run works out for them). Counted per path, from the start, never reset.
        self.path = FAMILY
        self.lookups = {FAMILY: 0, OWN: 0}
        self.begin()

    def _kept(self, key: str):
        found = self.ledger.get_meta(self.side + key) if self.side else None
        return found if found is not None else self.ledger.get_meta(key)

    def _keep(self, key: str, value: str, db) -> None:
        self.ledger.set_meta(self.side + key, value, db)

    def begin(self) -> None:
        """A new read. A service that's down isn't asked again until the next."""
        self._requests = 0
        self._down = False
        self._refused = False
        self._started = self.clock()

    def capped(self) -> bool:
        """This read's allowance of lookups ran out with the service still answering: what wasn't
        asked waits for the next read, and isn't a failed lookup."""
        return self._refused and not self._down

    def _later(self, found):
        return LATER if found == FAILED and self.capped() else found

    def on(self) -> bool:
        return bool(street_address(self.school_fn()))

    def misread(self) -> bool:
        """Something's entered for the school, and it can't be used."""
        return bool((self.school_fn() or "").strip()) and not self.on()

    def home_on(self) -> bool:
        return self._spot(HOME) is not None

    def home_misread(self) -> bool:
        """Something's entered for home, and it can't be used."""
        return bool((self.home_fn() or "").strip()) and not self.home_on()

    def _spot(self, where: str) -> tuple[str, str, str] | None:
        """(what it's kept under, map point, street address): one of the last two. Only the
        recognized parts ever go out, as with an event's place."""
        text = (self.home_fn() or "") if where == HOME else where
        point = coordinates(text)
        if point:
            return "@" + point, point, ""
        address = street_address(text)
        return (address.casefold(), "", address) if address else None

    def between(self, origin: str, destination: str) -> float | str:
        """The drive from one place to another, or NO_ADDRESS, or FAILED, or LATER (the lookups
        for this read are spent: asked at the next)."""
        return self._later(self._between(origin, destination))

    def _between(self, origin: str, destination: str) -> float | str:
        """The drive from one place to another, or NO_ADDRESS, or FAILED. Either can be HOME,
        map coordinates, or an event's place. Home that can't be used is FAILED: that's the
        setting's trouble, not the event's."""
        ends = []
        for where in (origin, destination):
            spot = self._spot(where)
            if spot is None:
                return FAILED if where == HOME else NO_ADDRESS
            ends.append(spot)
        (a_id, a_point, a_address), (b_id, b_point, b_address) = ends
        if a_id == b_id:
            return 0.0
        key = "drive_between:" + _hash(a_id + "|" + b_id)
        kept = self._kept(key)
        if kept is not None:
            return self._read(kept)
        near = self._near()
        points = []
        for where, point, address in ((origin, a_point, a_address), (destination, b_point, b_address)):
            found = point or self._locate(address, near=near)
            if found == NO_ADDRESS or found == FAILED:
                return FAILED if where == HOME else found
            points.append(found)
        found = self._route(*points)
        if found == FAILED:
            return FAILED
        with self.ledger.tx() as db:
            self._keep(key, found, db)
        return self._read(found)

    def find_place(self, text: str) -> str:
        """As _find_place, or LATER when this read's lookups are spent before it was asked."""
        return self._later(self._find_place(text))

    def _find_place(self, text: str) -> str:
        """A place named on Family, by its name on the map near home: "Name, street address",
        or "lat, lon" when the map has no street for it, or NO_ADDRESS, or FAILED (ask again at
        the next read). Only the text goes out, cleaned and cut short."""
        query = " ".join((text or "").split())
        want = name_words(query)
        if not query or len(query) > MAX_NAME_TEXT or is_online(query) or not want:
            return NO_ADDRESS
        home = self._spot(HOME)
        if home is None:
            return NO_ADDRESS              # no home to look near: never a search of the world
        near = home[1] or self._locate(home[2])
        if near in (NO_ADDRESS, FAILED):
            return FAILED
        key = "drive_name:" + _hash(" ".join(sorted(want)) + "|" + near)
        kept = self._kept(key)
        if kept is not None:
            return NO_ADDRESS if kept == "none" else kept
        lon, lat = (float(x) for x in near.split(","))
        fields = {"format": "jsonv2", "limit": str(NAME_RESULTS), "q": query, "bounded": "1",
                  "addressdetails": "1",
                  "viewbox": f"{lon - AROUND_HOME},{lat + AROUND_HOME},{lon + AROUND_HOME},{lat - AROUND_HOME}"}
        answer = self._get(f"https://{GEOCODE_HOST}/search?{urlencode(fields)}")
        if not isinstance(answer, list):
            return FAILED
        found, point = "none", ""
        for r in answer:
            try:
                name = str(r.get("name") or "")
                r_lat, r_lon = float(r["lat"]), float(r["lon"])
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
            if not name or not want <= name_words(name):
                continue                   # a near miss is not found: he's asked instead
            street = _street_of(r.get("address"))
            point = f"{r_lon},{r_lat}"
            if street:
                found = f"{label(name)}, {street}" if label(name) else street
                if not sound_place(found):
                    found = street         # a name that reads as part of the address: the address alone
            else:
                found = point_text(f"{r_lat}, {r_lon}")
            break
        with self.ledger.tx() as db:
            self._keep(key, found or "none", db)
            if found != "none" and street_address(found):
                # Its point too, so the drive to it isn't a second lookup.
                self._keep("drive_place:" + _hash(street_address(found).casefold()), point, db)
        return NO_ADDRESS if found in ("none", "") else found

    def _near(self) -> str:
        """Where an address with no town is most likely to be: near home, else near the school."""
        for spot in (self._spot(HOME), self._spot(self.school_fn() or "")):
            if spot is None:
                continue
            found = spot[1] or self._locate(spot[2])
            if found not in (NO_ADDRESS, FAILED):
                return found
        return ""

    def minutes(self, place: str) -> float | str:
        """The drive from the school to this place, or NO_ADDRESS, or FAILED."""
        if is_online(place):
            return 0.0
        address = street_address(place)
        if not address:
            return NO_ADDRESS
        school = street_address(self.school_fn())
        key = "drive_minutes:" + _hash(school.casefold() + "|" + address.casefold())
        kept = self._kept(key)
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
            self._keep(key, found, db)
        return self._read(found)

    @staticmethod
    def _read(kept: str) -> float | str:
        if kept == "none":
            return NO_ADDRESS
        minutes = float(kept)
        return minutes if minutes <= MAX_MINUTES else NO_ADDRESS

    def kept_point(self, place: str) -> str:
        """A place's map point ("lon,lat") from its own text or a lookup already kept, never asked for
        now: empty when there's none (same_place)."""
        spot = self._spot(place) if place else None
        if spot is None:
            return ""
        if spot[1]:
            return spot[1]
        kept = self._kept("drive_place:" + _hash(spot[2].casefold()))
        return kept if kept and kept != "none" else ""

    def _locate(self, address: str, near: str = "") -> str:
        """"lon,lat", which is how the route service wants it."""
        key = "drive_place:" + _hash(address.casefold())
        kept = self._kept(key)
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
            self._keep(key, found, db)
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
        if self._down:
            return None
        if self._requests >= MAX_REQUESTS_PER_READ or self.clock() - self._started > MAX_SECONDS_PER_READ:
            self._refused = True           # not asked: not a failure (capped())
            return None
        if self._requests:
            self.sleep(1)
        self._requests += 1
        self.lookups[self.path] = self.lookups.get(self.path, 0) + 1
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


def _street_of(address) -> str:
    """A map result's address parts as a street address drive.py recognizes, or empty."""
    if not isinstance(address, dict):
        return ""
    parts = {k: str(v) for k, v in address.items() if isinstance(v, (str, int))}
    number, road = parts.get("house_number", ""), parts.get("road", "")
    town = next((parts[k] for k in ("city", "town", "village", "hamlet", "municipality") if parts.get(k)), "")
    region = parts.get("ISO3166-2-lvl4", "")
    state = region.split("-")[1] if re.fullmatch(r"US-[A-Z]{2}", region) else ""
    code = (re.match(r"\d{5}", parts.get("postcode", "")) or [""])[0]
    if not (number and road and town and state):
        return ""
    text = f"{number} {road}, {town}, {state}" + (f" {code}" if code else "")
    street = street_address(text)
    return street if street == text else ""


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]
