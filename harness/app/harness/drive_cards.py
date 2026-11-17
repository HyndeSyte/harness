"""Cards for his drive blocks (family_gmail.py, live mode): a receipt with Undo for the drives
around his own appointments, and one card when a drive can't be found, with Skip.

  * His own appointments (events on his Gmail calendar that he owns) get "Busy (drive there)"
    and "Busy (drive back)" blocks the same way his copies of Family events do. They have no
    block of their own, so their drives get their own card: one per event, when its drives are
    added or moved, once a later read of Gmail finds them as written, sent with the morning
    digest like the Family receipts. Undo takes that event's drives off at once, and they stay
    off for that event.
  * A drive that can't be found is never left off silently. The digest names the event's day
    and time (family_gmail.py), and he gets one card naming the day, the time and the reason (no
    usable address, the lookup failed, or the event before it can't be placed and there's no time
    to go home between), with Skip. A lookup that failed counts once it has
    failed on two reads in a row, so a moment's outage sends nothing. An event whose place the
    place book is already asking about (places.py) gets no second card: that question is the
    card. Each event is asked about once, ever; Skip leaves it without drive blocks for good.
  * Fixed templates only: the event's day and time, and on a receipt its title cleaned and cut
    short (meaning.shown). Nothing here writes a calendar; family_gmail.py does.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import choices, places, render
from .ledger import Ledger, iso

log = logging.getLogger("harness.drive_cards")

NO_ADDRESS = "no_address"
FAILED = "failed"
PLACE = "place"                        # the place book is asking where it is: that's the card
CHAIN = "chain"                        # the event before it can't be placed, and from home doesn't fit
FAILS_BEFORE_CARD = 2                  # reads in a row a lookup must fail before he hears of it
MAX_CARDS_PER_READ = 3
MAX_RECEIPTS = 5
CARD_TTL_S = 7 * 24 * 3600
REASONS = {NO_ADDRESS: "no usable address. Add a street address to it, or tap Skip.",
           FAILED: "the drive lookup failed. I'll keep trying at each read; tap Skip to leave it "
                   "without drive blocks.",
           CHAIN: "the drive from the event before it can't be worked out, and there isn't time to go "
                  "home between. Add a street address to that one, or tap Skip."}


def _day(d: datetime) -> str:
    return f"{d:%a %b} {d.day}"


def _time(d: datetime) -> str:
    return f"{d.hour % 12 or 12}:{d:%M} {'AM' if d.hour < 12 else 'PM'}"


class DriveCards:
    def __init__(self, ledger: Ledger, *, tz: str):
        self.ledger = ledger
        self.tz = tz

    # -- what he said ------------------------------------------------------------------------------
    def off(self) -> set[str]:
        """Events with no drive blocks, by his tap: Undo on their drives, or Skip on their card."""
        return {r["key"] for r in self.ledger.db.execute(
            "SELECT key FROM drive_cards WHERE receipt IN ('removing','undone') OR ask='skipped'")}

    def own_keys(self) -> set[str]:
        """His own appointments that have had drives, so a read of Gmail that fails keeps them."""
        return {r["key"] for r in self.ledger.db.execute("SELECT key FROM drive_cards WHERE kind='own'")}

    def own_rows(self) -> list:
        """His own appointments as last read: key, series uid, start, end and place."""
        return self.ledger.db.execute("SELECT * FROM drive_cards WHERE kind='own'").fetchall()

    def waiting_since(self, key: str, said: str, start: datetime, now: datetime) -> datetime:
        """When his appointment first waited for a Family event beside it to be judged."""
        row = self._row(key)
        if row is None:
            self._upsert(key, "own", said, start)
            row = self._row(key)
        if not row["wait_since"]:
            self._set(key, wait_since=iso(now))
            return now
        return datetime.fromisoformat(row["wait_since"])

    def _row(self, key: str):
        return self.ledger.db.execute("SELECT * FROM drive_cards WHERE key=?", (key,)).fetchone()

    def _upsert(self, key: str, kind: str, said: str, start: datetime) -> None:
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("INSERT INTO drive_cards(key, kind, said, start, receipt, what, rid, ask, reason,"
                       " aid, fails, created_at, updated_at) VALUES(?,?,?,?,'','','','','','',0,?,?)"
                       " ON CONFLICT(key) DO UPDATE SET said=excluded.said, start=excluded.start,"
                       " updated_at=excluded.updated_at", (key, kind, said, start.isoformat(), now, now))

    def _set(self, key: str, **fields) -> None:
        cols = ", ".join(f"{name}=?" for name in fields)
        with self.ledger.tx() as db:
            db.execute(f"UPDATE drive_cards SET {cols}, updated_at=? WHERE key=?",
                       (*fields.values(), iso(self.ledger.now()), key))

    # -- receipts for his own appointments' drives ------------------------------------------------------
    def seen(self, key: str, kind: str, said: str, start: datetime, end: datetime | None = None,
             place: str = "", uid: str = "") -> None:
        """An event whose drives are worked out at this read. His own appointment's end, place and
        series are kept, so a read of Gmail cut short still knows where its drives fit."""
        self._upsert(key, kind, said, start)
        if end is not None:
            self._set(key, until=end.isoformat(), place=place, uid=uid)

    def written(self, key: str, what: str) -> None:
        """Its drives were added or moved on Gmail: a receipt waits for a read that finds them. One
        not shown yet stays "added"."""
        row = self._row(key)
        if row is None or row["kind"] != "own":
            return
        if row["receipt"] in ("removing", "undone"):
            return
        if row["receipt"] in ("written", "new") and row["what"] == "added":
            what = "added"
        self._set(key, receipt="written", what=what)

    def waiting(self) -> list:
        return self.ledger.db.execute("SELECT * FROM drive_cards WHERE receipt='written'").fetchall()

    def read_back(self, key: str, found: bool | None) -> None:
        """True: a read found its drives as written. None: nothing left to tell of."""
        if found is None:
            self._set(key, receipt="")
        elif found:
            self._set(key, receipt="new")

    def send_receipts(self, chat_id: int | None, legs_fn) -> int:
        """With the morning digest: one card per event whose drives were added or moved, with Undo.
        legs_fn(key) gives the live drives as [(title, start, end)]."""
        if chat_id is None:
            return 0
        rows = self.ledger.db.execute("SELECT * FROM drive_cards WHERE receipt='new' ORDER BY start"
                                      " LIMIT ?", (MAX_RECEIPTS,)).fetchall()
        zone = ZoneInfo(self.tz)
        now = self.ledger.now()
        sent = 0
        for r in rows:
            legs = [(t, s.astimezone(zone), e.astimezone(zone)) for t, s, e in legs_fn(r["key"]) if e > now]
            if not legs:
                self._set(r["key"], receipt="")
                continue
            named = " and ".join(f"{render.escape(t)} {_time(s)} to {_time(e)}" for t, s, e in legs)
            start = datetime.fromisoformat(r["start"]).astimezone(zone)
            head = "Moved on your Gmail" if r["what"] == "moved" else "Added to your Gmail"
            text = (f"{head}: {named}, {_day(start)}, for {render.escape(r['said'])} at {_time(start)} on your "
                    "calendar. Nothing to do if that's right; tap Undo only if it's wrong.")
            rid = secrets.token_hex(8)
            with self.ledger.tx() as db:
                nonce = choices.mint(self.ledger, kind="drive_undo", target=rid, chat_id=chat_id,
                                     ttl_s=CARD_TTL_S, db=db)
                self.ledger.enqueue(chat_id=chat_id, kind="reply", text=render.fit(text), db=db,
                                    buttons=[[("Undo", choices.callback_data(nonce))]],
                                    binds=[{"type": "choice", "nonce": nonce}])
                db.execute("UPDATE drive_cards SET receipt='shown', rid=?, updated_at=? WHERE key=?",
                           (rid, iso(now), r["key"]))
            sent += 1
        return sent

    def removals(self) -> list[str]:
        """Undo taps waiting for family_gmail.py to take the drives off."""
        return [r["key"] for r in self.ledger.db.execute(
            "SELECT key FROM drive_cards WHERE receipt='removing' ORDER BY key")]

    def removed(self, key: str) -> None:
        self._set(key, receipt="undone")

    # -- a drive that can't be found -----------------------------------------------------------------
    def trouble(self, key: str, kind: str, said: str, start: datetime, reason: str) -> None:
        """At this read, its drive couldn't be found, for this reason."""
        self._upsert(key, kind, said, start)
        row = self._row(key)
        if row["ask"] in ("asked", "skipped"):
            return                         # asked once, ever
        if reason == PLACE:
            self._set(key, ask=PLACE, reason=NO_ADDRESS, fails=0)
            return                         # the place book is asking: that's the card
        # Once the place book has its answer (or he skipped its question), the place book isn't
        # asking any more: a lookup that fails from here gets its own card.
        fails = row["fails"] + 1 if reason == FAILED and row["ask"] == "failing" else int(reason == FAILED)
        self._set(key, ask="failing", reason=reason, fails=fails)

    def fine(self, key: str) -> None:
        """Its drives were all found at this read: a failing lookup starts its count again."""
        row = self._row(key)
        if row is not None and (row["fails"] or row["ask"] in ("failing", PLACE)):
            self._set(key, fails=0, ask="" if row["ask"] in ("failing", PLACE) else row["ask"])

    def ask(self, chat_id: int | None, now: datetime) -> int:
        """One card per event with no drive, each asked once. Not before breakfast unless the event
        is within 48 hours, and a few per read."""
        if chat_id is None:
            return 0
        zone = ZoneInfo(self.tz)
        early = now.astimezone(zone).time() < places.ASK_FROM
        sent = 0
        for r in self.ledger.db.execute("SELECT * FROM drive_cards WHERE ask='failing' ORDER BY start").fetchall():
            if sent >= MAX_CARDS_PER_READ:
                break
            start = datetime.fromisoformat(r["start"])
            if start <= now:
                continue
            if early and start >= now + places.URGENT:
                continue
            if r["reason"] == FAILED and r["fails"] < FAILS_BEFORE_CARD:
                continue
            local = start.astimezone(zone)
            text = (f"No drive blocks for the event on {_day(local)} at {_time(local)}: "
                    + REASONS.get(r["reason"], REASONS[FAILED]))
            aid = secrets.token_hex(8)
            ttl = int(min(CARD_TTL_S, max(3600, (start - now).total_seconds())))
            with self.ledger.tx() as db:
                nonce = choices.mint(self.ledger, kind="drive_skip", target=aid, chat_id=chat_id,
                                     ttl_s=ttl, db=db)
                self.ledger.enqueue(chat_id=chat_id, kind="reply", text=render.fit(text), db=db,
                                    buttons=[[("Skip", choices.callback_data(nonce))]],
                                    binds=[{"type": "choice", "nonce": nonce}])
                db.execute("UPDATE drive_cards SET ask='asked', aid=?, updated_at=? WHERE key=?",
                           (aid, iso(now), r["key"]))
                self.ledger.event("drive_asked", {"reason": r["reason"]}, db=db)
            sent += 1
        return sent

    # -- taps ------------------------------------------------------------------------------------------
    def on_choice(self, kind: str, target: str) -> str:
        if kind == "drive_undo":
            row = self.ledger.db.execute("SELECT * FROM drive_cards WHERE rid=? AND rid!=''",
                                         (target or "",)).fetchone()
            if row is None or row["receipt"] != "shown":
                return "Already done."
            self._set(row["key"], receipt="removing")
            return (f"Taking the drive blocks for {render.escape(row['said'])} off your Gmail. "
                    "They stay off for that event.")
        if kind == "drive_skip":
            row = self.ledger.db.execute("SELECT * FROM drive_cards WHERE aid=? AND aid!=''",
                                         (target or "",)).fetchone()
            if row is None:
                return "Nothing changed."
            if row["ask"] != "asked":
                return "Already settled. Nothing changed."
            self._set(row["key"], ask="skipped")
            return "Got it. No drive blocks for that event, and I won't ask about it again."
        return "Nothing changed."
