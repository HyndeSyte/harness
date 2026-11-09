"""Where a place named on Family is: his place book, and asking him once about a new one.

Family entries often hold only a place's name ("HMLC"), not a street address, and the map
can't find every name: nicknames, typos and private places. He tells Cain where a place is; Cain keeps it in his record, areas/home/places.md, a table
`| Place | Address | Said on |`, and Cain's add-on sends the whole table here whenever it
changes (handover.py /places), as with what Family events mean.

  * Strictly checked before anything is queued: bounded lengths, plain words for the name,
    and an address that is a recognized street address (only its recognized parts are kept,
    drive.street_address) or map coordinates "lat, lon". "skip" says he doesn't want to be
    asked about that place.
  * The table is the book: each send replaces what was here. In it, the newest row for a
    place wins (by its date; on the same date, the lower row).
  * An event's place, in order: a street address in its location (as before); else the book,
    matching the location's words (case, spacing and punctuation don't count; the whole
    location must be the book's name, so "Pat" never matches "Pat's house"): his word wins
    over the map, and covers typos, nicknames and private places; else the map, by the
    location's name near home (drive.find_place); else nothing. Only the location is read,
    never the title: a title names what happens ("Skating"), and its words would match far
    more than the place. A place he skipped stops at the book: it isn't looked up either.
  * A presence event he goes to, with a location the map said it doesn't know (not one it
    couldn't be reached for: the next read tries again), gets ONE card
    for Cain: "Where is HMLC? (for Skating HMLC, Fri Nov 20) Reply with an address, or tap
    Skip." Each place is asked once; asked and skipped places are kept, and a skipped place
    is never asked again unless he raises it (a row for it in the book).
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from . import choices, drive, render
from .ledger import Ledger, iso

log = logging.getLogger("harness.places")

MAX_ROWS = 200
MAX_NAME = 80
MAX_NAME_WORDS = 8
MAX_ADDRESS = 200
SKIP = "skip"
ASK_AHEAD = timedelta(days=14)
URGENT = timedelta(hours=48)
ASK_FROM = time(7, 0)                  # not before breakfast, unless the event is within 48 hours
MAX_OPEN = 3
MIN_TTL_S = 3600
MAX_TTL_S = 14 * 24 * 3600
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_WORD = re.compile(r"[^\W_]+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def place_key(text: str) -> str:
    """A place's name as it's matched: its words, lower case, in order."""
    return " ".join(_WORD.findall((text or "").casefold()))


def clean_address(text: str) -> str:
    """What may be stored and sent on: a street address's recognized parts, or "lat, lon".
    Empty when it's neither."""
    return drive.point_text(text) or drive.street_address(text)


def validate_rows(body) -> tuple[list[dict] | None, str]:
    """The rows, cleaned, or None and a fixed reason (never an echo of what was sent)."""
    rows = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        return None, "rows must be a list"
    if len(rows) > MAX_ROWS:
        return None, f"at most {MAX_ROWS} rows"
    if not rows:
        # A send replaces the book: an empty one is far likelier a bad read than his word.
        return None, "an empty table would wipe the place book; nothing changed"
    today = datetime.now().date()
    out = []
    for n, row in enumerate(rows, 1):
        if not isinstance(row, dict) or set(row) != {"place", "address", "said_on"}:
            return None, f"row {n}: needs exactly place, address and said_on"
        name, address, said_on = row["place"], row["address"], row["said_on"]
        if not isinstance(name, str) or not 0 < len(name) <= MAX_NAME or _CONTROL.search(name):
            return None, f"row {n}: place must be 1 to {MAX_NAME} characters"
        key = place_key(name)
        words = key.split()
        if not words or len(words) > MAX_NAME_WORDS or any(len(w) > 30 for w in words):
            return None, f"row {n}: place must be 1 to {MAX_NAME_WORDS} plain words"
        if not isinstance(address, str) or not 0 < len(address) <= MAX_ADDRESS or _CONTROL.search(address):
            return None, f"row {n}: address must be 1 to {MAX_ADDRESS} characters"
        skip = address.strip().casefold() == SKIP
        cleaned = "" if skip else clean_address(address)
        if not skip and not cleaned:
            return None, f"row {n}: address must be a street address, map coordinates (lat, lon), or skip"
        if not isinstance(said_on, str) or not _DATE.fullmatch(said_on):
            return None, f"row {n}: said_on must be a date like 2026-11-08"
        try:
            day = date.fromisoformat(said_on)
        except ValueError:
            return None, f"row {n}: said_on must be a date like 2026-11-08"
        if day.year < 2020 or day > today + timedelta(days=1):
            return None, f"row {n}: said_on must not be in the future"
        out.append({"key": key, "address": cleaned, "skip": skip, "said_on": said_on})
    return out, ""


def _day(d: datetime) -> str:
    return f"{d:%a %b} {d.day}"


def question_text(place: str, title: str, start: datetime) -> str:
    """A fixed template, the location and the title cleaned and cut short. Nothing a model wrote."""
    from .meaning import shown            # meaning.py imports family_gmail; keep this module light
    return (f"Where is {render.escape(shown(place))}? (for {render.escape(shown(title))}, {_day(start)}) "
            "Reply with an address, or tap Skip.")


class PlaceBook:
    def __init__(self, ledger: Ledger, *, tz: str):
        self.ledger = ledger
        self.tz = tz
        self._waiting: dict[str, tuple[str, str, datetime]] = {}   # key -> (location, title, start)

    # -- the book --------------------------------------------------------------------------------
    def import_rows(self, rows: list[dict]) -> tuple[int, int]:
        """Rows already checked (validate_rows): the whole book. Returns (places, skipped)."""
        book: dict[str, dict] = {}
        for row in sorted(rows, key=lambda r: r["said_on"]):     # stable: the lower row wins a tie
            book[row["key"]] = row
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("DELETE FROM places")
            for row in book.values():
                db.execute("INSERT INTO places(key, address, skip, said_on, updated_at) VALUES(?,?,?,?,?)",
                           (row["key"], row["address"], int(row["skip"]), row["said_on"], now))
                db.execute("UPDATE place_asks SET state=?, updated_at=? WHERE key=? AND state='asked'",
                           ("skipped" if row["skip"] else "answered", now, row["key"]))
            self.ledger.event("places_imported", {"places": len(book),
                                                  "skipped": sum(r["skip"] for r in book.values())}, db=db)
        skipped = sum(1 for r in book.values() if r["skip"])
        return len(book) - skipped, skipped

    def resolve(self, location: str, find=None) -> tuple[str, bool]:
        """Where an event is, for its block and its drive, and whether to ask him: a street
        address in its location, else the book, else `find` (drive.Drives.find_place: the
        map, by name near home), else nothing. Ask only when the map said it isn't there,
        not when it couldn't be reached (the next read tries again)."""
        if not (location or "").strip() or drive.is_online(location):
            return "", False
        street = drive.street_address(location)
        if street:
            return street, False
        key = place_key(location)
        if not key:
            return "", False
        row = self.ledger.db.execute("SELECT address, skip FROM places WHERE key=?", (key,)).fetchone()
        if row is not None:
            return ("" if row["skip"] else row["address"]), False
        if find is None:
            return "", True
        found = find(location)
        if found == drive.FAILED:
            return "", False
        if found == drive.NO_ADDRESS or not found:
            return "", True
        return found, False

    # -- asking him once -------------------------------------------------------------------------
    def begin(self) -> None:
        """A new read of what he goes to: the places waiting are found again."""
        self._waiting = {}

    def unresolved(self, location: str, title: str, start: datetime) -> None:
        """An event he goes to, at a place nothing here can place. Its earliest occurrence counts."""
        key = place_key(location)
        if not key or drive.is_online(location):
            return
        had = self._waiting.get(key)
        if had is None or start < had[2]:
            self._waiting[key] = (location, title, start)

    def ask(self, chat_id: int | None, now: datetime) -> int:
        if chat_id is None or not self._waiting:
            return 0
        asked = {r["key"] for r in self.ledger.db.execute("SELECT key FROM place_asks")}
        known = {r["key"] for r in self.ledger.db.execute("SELECT key FROM places")}
        stamp = iso(now)
        room = MAX_OPEN - self.ledger.db.execute(
            "SELECT COUNT(*) FROM place_asks WHERE state='asked' AND starts>?", (stamp,)).fetchone()[0]
        early = now.astimezone(ZoneInfo(self.tz)).time() < ASK_FROM
        sent = 0
        for key, (location, title, start) in sorted(self._waiting.items(), key=lambda kv: kv[1][2]):
            if room <= 0:
                break
            if key in asked or key in known or start <= now or start >= now + ASK_AHEAD:
                continue
            if early and start >= now + URGENT:
                continue
            self._send(chat_id, key, location, title, start, now)
            room -= 1
            sent += 1
        return sent

    def _send(self, chat_id: int, key: str, location: str, title: str, start: datetime,
              now: datetime) -> None:
        from .meaning import shown
        qid = secrets.token_hex(8)
        ttl = int(min(MAX_TTL_S, max(MIN_TTL_S, (start - now).total_seconds())))
        text = question_text(location, title, start.astimezone(ZoneInfo(self.tz)))
        stamp = iso(now)
        with self.ledger.tx() as db:
            nonce = choices.mint(self.ledger, kind="place_skip", target=qid, chat_id=chat_id,
                                 ttl_s=ttl, db=db)
            db.execute("INSERT INTO place_asks(key, id, said, starts, state, created_at, updated_at)"
                       " VALUES(?,?,?,?,'asked',?,?)", (key, qid, shown(location), iso(start), stamp, stamp))
            self.ledger.enqueue(chat_id=chat_id, kind="reply", text=render.fit(text), db=db,
                                buttons=[[("Skip", choices.callback_data(nonce))]],
                                binds=[{"type": "choice", "nonce": nonce}])
            self.ledger.event("place_asked", {}, db=db)

    def on_choice(self, kind: str, target: str) -> str:
        if kind != "place_skip":
            return "Nothing changed."
        row = self.ledger.db.execute("SELECT * FROM place_asks WHERE id=?", (target or "",)).fetchone()
        if row is None:
            return "Nothing changed."
        said = render.escape(row["said"])
        if row["state"] != "asked":
            return f"Already settled for {said}. Nothing changed."
        with self.ledger.tx() as db:
            db.execute("UPDATE place_asks SET state='skipped', updated_at=? WHERE key=?",
                       (iso(self.ledger.now()), row["key"]))
        return f"Got it. I won't ask where {said} is again."
