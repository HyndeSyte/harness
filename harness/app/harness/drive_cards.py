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
    to go home between, or its lookup hasn't been done yet), with Skip. A lookup that failed counts
    once it has failed on two reads in a row, so a moment's outage sends nothing, except within a
    day of the event: a drive left off that near gets its card at once. An event whose place the
    place book is already asking about (places.py) gets no second card: that question is the
    card. Each event is asked about once, ever; Skip leaves it without drive blocks for good.
  * A receipt for drives put back just as the last card told him (the same key, times and place)
    isn't sent again.
  * Removals on odd data wait for his go: when Gmail's feed shrank and that was believed, more than
    3 appointments lose their drives at once, or a repeating appointment changed in a way that can't
    be matched to a new series, one card lists them by day and time, with "Take them off" and "Keep
    them", and nothing comes off until he taps Take them off, and then only the drives it listed
    (family_gmail.py).
  * A Family event's drive that crosses a drive kept for his own appointment while his calendar
    isn't read in full is named in the digest, and gets one card when it's within a day. Both stay
    busy; nothing is retitled.
  * Fixed templates only: the event's day and time, and on a receipt its title cleaned and cut
    short (meaning.shown). Nothing here writes a calendar; family_gmail.py does.
"""
from __future__ import annotations

import json
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
LATER = "later"                        # this read's lookups ran out before it (only named when it's near)
FAILS_BEFORE_CARD = 2                  # reads in a row a lookup must fail before he hears of it
NEAR = timedelta(hours=24)             # a drive left off this near always gets its card, at once
MAX_CARDS_PER_READ = 3
MAX_RECEIPTS = 5
CARD_TTL_S = 7 * 24 * 3600
REASONS = {NO_ADDRESS: "no usable address. Add a street address to it, or tap Skip.",
           FAILED: "the drive lookup failed. I'll keep trying at each read; tap Skip to leave it "
                   "without drive blocks.",
           CHAIN: "the drive from the event before it can't be worked out, and there isn't time to go "
                  "home between. Add a street address to that one, or tap Skip.",
           LATER: "its drive time hasn't been looked up yet. I'll keep trying at each read; tap Skip to "
                  "leave it without drive blocks."}


def _same_legs(a: str, b: str) -> bool:
    """The same drives, compared as moments, whatever offset they were written in."""
    try:
        x, y = json.loads(a), json.loads(b)
        return len(x) == len(y) and all(
            p[0] == q[0] and datetime.fromisoformat(p[1]) == datetime.fromisoformat(q[1])
            and datetime.fromisoformat(p[2]) == datetime.fromisoformat(q[2]) for p, q in zip(x, y))
    except (ValueError, TypeError, IndexError):
        return False


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

    def own_rows(self, kind: str = "own") -> list:
        """His own appointments as last read: key, series uid, start, end and place. kind "dry": the
        dry run's own records, kept apart so nothing it counts carries into live mode."""
        return self.ledger.db.execute("SELECT * FROM drive_cards WHERE kind=?", (kind,)).fetchall()

    def clear_dry(self) -> None:
        """Live mode again: the dry run's records and counts go, whatever they said."""
        with self.ledger.tx() as db:
            db.execute("DELETE FROM drive_cards WHERE kind='dry'")

    def waiting_since(self, key: str, said: str, start: datetime, now: datetime, kind: str = "own") -> datetime:
        """When his appointment first waited for a Family event beside it to be judged."""
        row = self._row(key)
        if row is None:
            self._upsert(key, kind, said, start)
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
             place: str = "", uid: str = "", inst: str = "") -> None:
        """An event whose drives are worked out at this read. His own appointment's end, place,
        series and original start (its instance) are kept, so a read of Gmail that doesn't have it
        still knows where its drives fit and whether the feed says it's gone. Seen, it isn't missing."""
        self._upsert(key, kind, said, start)
        if end is not None:
            self._set(key, until=end.isoformat(), place=place, uid=uid, inst=inst, missed=0, missed_read="")

    def missed(self, key: str, read: str) -> int:
        """His appointment isn't in this full read of Gmail: how many full reads in a row it's been
        missing from, this one counted once however often it's looked at."""
        row = self._row(key)
        if row is None:
            return 0
        if row["missed_read"] != read:
            self._set(key, missed=row["missed"] + 1, missed_read=read)
            return row["missed"] + 1
        return row["missed"]

    def found(self, key: str) -> None:
        """In this full read after all: its count of reads missing starts again."""
        row = self._row(key)
        if row is not None and (row["missed"] or row["missed_read"]):
            self._set(key, missed=0, missed_read="")

    def forget(self, key: str) -> None:
        """The dry run's appointment gone: no end kept, so it isn't counted as gone again."""
        if self._row(key) is not None:
            self._set(key, until="")

    def rekey(self, old: str, new: str) -> None:
        """A series split in two ("this and following"): the old instance's record, receipt and Undo
        included, goes on under the new instance's key, so its drives stay and nothing is told twice."""
        row = self._row(old)
        if row is None or self._row(new) is not None:
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE drive_cards SET key=?, updated_at=? WHERE key=?", (new, iso(self.ledger.now()), old))

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
        rows = self.ledger.db.execute("SELECT * FROM drive_cards WHERE receipt='new' ORDER BY start").fetchall()
        zone = ZoneInfo(self.tz)
        now = self.ledger.now()
        sent = 0
        for r in rows:
            if sent >= MAX_RECEIPTS:
                break
            legs = [(t, s.astimezone(zone), e.astimezone(zone)) for t, s, e in legs_fn(r["key"]) if e > now]
            if not legs:
                self._set(r["key"], receipt="")
                continue
            told = json.dumps([[t, s.isoformat(), e.isoformat()] for t, s, e in legs])
            if r["shown"] and _same_legs(r["shown"], told):
                # Put back as he was last told, with the same key, times and place: nothing new to say.
                self._set(r["key"], receipt="shown" if r["rid"] else "")
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
                db.execute("UPDATE drive_cards SET receipt='shown', rid=?, shown=?, updated_at=? WHERE key=?",
                           (rid, told, iso(now), r["key"]))
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
            start = datetime.fromisoformat(r["start"])
            if start <= now:
                continue
            near = start < now + NEAR       # a drive missing within a day is told at once, past the cap
            if sent >= MAX_CARDS_PER_READ and not near:
                break
            if early and start >= now + places.URGENT:
                continue
            if r["reason"] == FAILED and r["fails"] < FAILS_BEFORE_CARD and not near:
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

    # -- removals on odd data: his go first ------------------------------------------------------------
    def hold(self, key: str) -> str:
        """'' | 'asked' | 'approved' | 'kept': where his go on removing this appointment's drives stands."""
        row = self._row(key)
        return row["hold"] if row is not None else ""

    def clear_hold(self, key: str) -> None:
        """Back in a read: a later removal asks again."""
        row = self._row(key)
        if row is not None and (row["hold"] or row["bid"] or row["listed"] or row["approved_at"]):
            self._set(key, hold="", bid="", listed="", approved_at="")

    def approved_at(self, key: str) -> datetime | None:
        """When he tapped Take them off for this appointment's drives, or None."""
        row = self._row(key)
        try:
            return datetime.fromisoformat(row["approved_at"]) if row is not None and row["approved_at"] else None
        except ValueError:
            return None

    def listed(self, key: str) -> list:
        """The drives his card listed for this appointment: [[id, title, start, end], ...] (UTC ISO times)."""
        row = self._row(key)
        try:
            found = json.loads(row["listed"]) if row is not None and row["listed"] else []
        except ValueError:
            return []
        return [x for x in found if isinstance(x, list) and len(x) == 4] if isinstance(found, list) else []

    def still_listed(self, key: str, legs: str) -> bool:
        """His go was for the drives the card listed: they're still exactly those (legs as listed)."""
        row = self._row(key)
        return row is not None and row["listed"] == legs

    def ask_removals(self, chat_id: int | None, items: list[tuple[str, datetime]], why: str, now: datetime,
                     *, send: bool = True, listed: dict | None = None) -> bool:
        """One card listing the appointments by day and time, with Take them off and Keep them. Nothing
        comes off until he taps Take them off, and then only the drives listed (listed: key -> its drives
        as they were when asked; family_gmail.py checks them again before any comes off). send False (the
        dry run): marked asked, nothing sent. False: there's no one to ask yet."""
        if not items or (send and chat_id is None):
            return False
        bid = secrets.token_hex(8)
        zone = ZoneInfo(self.tz)
        whens = [f"{_day(s.astimezone(zone))} at {_time(s.astimezone(zone))}" for _, s in sorted(items, key=lambda x: x[1])]
        head = ("Your Gmail calendar came back much smaller than before" if why == "shrink" else
                "A repeating appointment of yours changed in a way I can't match to the new one" if why == "series"
                else f"{len(items)} of your appointments look gone from your Gmail calendar at once")
        text = (f"{head}. Should their drive blocks come off? {'; '.join(whens)}. They stay until you tap "
                "Take them off.")
        with self.ledger.tx() as db:
            if send:
                ok = choices.mint(self.ledger, kind="drive_remove", target=bid, chat_id=chat_id, ttl_s=CARD_TTL_S, db=db)
                keep = choices.mint(self.ledger, kind="drive_keep", target=bid, chat_id=chat_id, ttl_s=CARD_TTL_S, db=db)
                self.ledger.enqueue(chat_id=chat_id, kind="reply", text=render.fit(text), db=db,
                                    buttons=[[("Take them off", choices.callback_data(ok)),
                                              ("Keep them", choices.callback_data(keep))]],
                                    binds=[{"type": "choice", "nonce": ok}, {"type": "choice", "nonce": keep}])
                self.ledger.event("drive_removals_asked", {"n": len(items), "why": why}, db=db)
            for key, _ in items:
                db.execute("UPDATE drive_cards SET hold='asked', bid=?, listed=?, updated_at=? WHERE key=?",
                           (bid, (listed or {}).get(key, ""), iso(now), key))
        return True

    # -- a Family drive crossing a kept drive of his -----------------------------------------------------
    def conflict(self, key: str, kind: str, said: str, start: datetime, kept_start: datetime,
                 chat_id: int | None, now: datetime) -> None:
        """Within a day of the event: one card, said once for that kept drive. Nothing changes on Gmail."""
        self._upsert(key, kind, said, start)
        row = self._row(key)
        if row["conflict"] == kept_start.isoformat() or chat_id is None or not now < start < now + NEAR:
            return
        zone = ZoneInfo(self.tz)
        local, kept = start.astimezone(zone), kept_start.astimezone(zone)
        text = (f"The drive for the event on {_day(local)} at {_time(local)} crosses a drive block kept "
                f"for your own appointment ({_time(kept)}), because your Gmail calendar couldn't be read in full. "
                "Both stay on your calendar as busy until it reads in full.")
        with self.ledger.tx() as db:
            self.ledger.enqueue(chat_id=chat_id, kind="reply", text=render.fit(text), db=db)
            db.execute("UPDATE drive_cards SET conflict=?, updated_at=? WHERE key=?",
                       (kept_start.isoformat(), iso(now), key))
            self.ledger.event("drive_conflict_told", {}, db=db)

    # -- taps ------------------------------------------------------------------------------------------
    def on_choice(self, kind: str, target: str) -> str:
        if kind in ("drive_remove", "drive_keep"):
            rows = self.ledger.db.execute("SELECT * FROM drive_cards WHERE bid=? AND bid!=''",
                                          (target or "",)).fetchall()
            asked = [r for r in rows if r["hold"] == "asked"]
            if not asked:
                return "Already settled. Nothing changed."
            to = "approved" if kind == "drive_remove" else "kept"
            for r in asked:
                self._set(r["key"], hold=to, approved_at=iso(self.ledger.now()) if to == "approved" else "")
            if to == "approved":
                return "Taking those drive blocks off your Gmail at the next read."
            return "Keeping those drive blocks on your Gmail."
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
