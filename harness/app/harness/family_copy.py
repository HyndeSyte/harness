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
READS_BEFORE_REMOVING = 2
STOP_AFTER_REMOVED = 2
HOLD_READS = 6                 # three hours: long enough for a bad read to pass, then it's real
GIVE_UP_READS = 12             # six hours of a copy being there but not listed
CONFIRM_AFTER = timedelta(minutes=2)   # the second look before a removal, not the next usual read


HOLD = "family_copy_hold:"     # meta, per copy: a read showing these old times is from before his change
HOLD_FOR = timedelta(hours=3)
# meta, per copy: its Gmail event's own identity, the series uid and the day's original start ("" for a
# single event), as the last read gave it. The key is made from the same two, so this is what the key
# means, kept so the event can be read again by it wherever it now sits (calendar_change.py).
SOURCE = "family_copy_source:"
# meta, per copy: its versions on Family (the review of Nov 27, in place of remembering times). "confirmed": the
# version as last confirmed after Harness's own write; "pending": the version a write of its own was sent
# against (the pre-write version), when, and whether it's known to have landed; "retries": when it wrote
# again after a conflict. A Family read showing anything other than the copy as Harness wrote it is behind only
# when its version is that pre-write version, of a write still undecided or sent within LAG_FOR. Any other
# version is someone's edit, whatever times it shows, and the copy is theirs. A version is recorded as Harness's
# own only when the copy read there shows what Harness wrote (content_is, now the allowlist below: nothing but
# the lines it writes); any difference is someone's edit (round 3). A write still undecided after PENDING_FOR is settled the
# same way, by the copy's content, and its pre-write version is never lag after that.
# Round 4: "Harness's own" is an allowlist (caldav.copy_as_written): the copy holds exactly the lines Harness
# writes, compared by what they say, and nothing more. A copy that fails it is someone's edit and is never
# written over, not even by a conditional rewrite over its version. A pending write also keeps what the copy
# held before it ("before"), so a write that never landed is told apart by a decision table (_settle_expired).
VERSION = "family_copy_version:"
LAG_FOR = timedelta(minutes=5)
PENDING_FOR = timedelta(hours=1)
MAX_RETRIES = 2                # writes again after a conflict, per copy per RETRY_WINDOW
RETRY_WINDOW = timedelta(hours=1)
MAX_TOTAL_RETRIES = 6          # writes again (after a conflict, or a write that never landed), per copy, ever
# Round 5: the copy's ownership baseline is what Harness last wrote there, kept in its own record ("wrote" in
# VERSION), never what a read of the copy shows. A pending write keeps the version it went over ("from"), the body
# it went over ("prior_body") and the body it sent ("intended"), all saved before the write is sent; an undecided
# write whose record is missing a part of that, or can't be read, leaves the copy alone rather than guess.
PENDING_NEEDS = ("from", "at", "op", "prior_body", "intended")
LOUD_AFTER = 2                 # more copies than this going hands-off in one read: likely a server change
MISSING_404S = 3               # Gmail answering "not found" this many reads in a row for one copy: said
SERVER_CHANGE = "family_copy_server_change"
MISSING = "family_copy_missing:"      # meta, per copy: how many reads in a row Google answered 404 for its event
# Edits people make on Family, by line name: anything else that turns up on several copies at once is read as
# iCloud changing how it keeps events.
# Round 3 of the second review (Nov 28). A create whose answer was lost and whose copy isn't there when it is read
# again is left absent and said once: it is made again only after a write known to have failed without creating.
UNCERTAIN = "family_copy_uncertain"
# After every write to a copy, its Gmail event is read again by its id. If it moved again or was cancelled meanwhile,
# that is queued here (meta, per copy: {"op": check | move | cancel, "rev", "at", "tries"}), saved before the write
# is sent, and worked off at the next read; a cancel takes the guarded removal. RECONCILE_TRIES tries, then the
# digest says so.
RECONCILE = "family_copy_reconcile:"
RECONCILE_TRIES = 3
RECONCILE_CAPPED = "family_copy_reconcile_capped"
# A copy whose Gmail event isn't in the feed and that Google answers "not found" for (as it does once a deleted event
# is purged) is never taken off by itself: one digest line, and one card for his tap (meta, per copy: "due", then
# "carded").
PURGED = "family_copy_purged:"
PURGED_EVENT = "family_copy_purged"
# Round 4 of the second review (Nov 28). Reasons never to make a copy again by itself, nor to reconcile it (meta, per
# copy: {"why", "at"}): "asked_off" for a removal he approved that went through, "household" for a copy someone took
# off Family, and "approving" from the moment an approved removal is about to be sent until it lands or fails (good
# for APPROVING_FOR at most, should neither ever be said). Checked when queued work runs and before a create. Only his
# Undo of that removal clears one.
SUPPRESS = "family_copy_suppress:"
SUPPRESS_WHY = ("asked_off", "household", "approving")
APPROVING_FOR = timedelta(hours=1)
KNOWN_EDITS = frozenset({"SUMMARY", "DTSTART", "DTEND", "LOCATION", "DESCRIPTION", "VALARM", "ATTENDEE", "URL",
                         "STATUS", "RRULE", "CATEGORIES", "TRANSP", "X-APPLE-TRAVEL-DURATION", "CLASS",
                         "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR", "X-APPLE-TRAVEL-START", "X-APPLE-STRUCTURED-LOCATION",
                         "EVENTS", "ORGANIZER", "PRIORITY", "ATTACH", "GEO", "RDATE", "EXDATE"})


def source_of(ledger: Ledger, key: str) -> tuple[str, str] | None:
    """(series uid, original start) of this copy's Gmail event, or None if no read has named it."""
    try:
        d = json.loads(ledger.get_meta(SOURCE + key) or "null")
        return (str(d["uid"]), str(d.get("instance", ""))) if isinstance(d, dict) and d.get("uid") else None
    except (ValueError, TypeError, KeyError):
        return None


def remember_source(ledger: Ledger, key: str, occ: ical.Occurrence, db=None) -> None:
    value = json.dumps({"uid": occ.uid, "instance": occ.instance})
    if ledger.get_meta(SOURCE + key) != value:
        _set_meta(ledger, SOURCE + key, value, db)


def _set_meta(ledger: Ledger, key: str, value: str, db=None) -> None:
    if db is not None:
        ledger.set_meta(key, value, db)
        return
    with ledger.tx() as d:
        ledger.set_meta(key, value, d)


def google_id(uid: str, instance: str) -> str:
    """The Google event id of that event or that day of it: the series id, then for a day of a series
    "_" and its original start (Google's recurringEventId and originalStartTime)."""
    base = uid.removesuffix("@google.com")
    return f"{base}_{instance}" if instance else base


def source_matches(e: dict, uid: str, instance: str) -> bool:
    """Google's answer for a copy's event is that event (round 5): its iCalUID is the series uid; for one day of a
    series, its recurringEventId is that series' id and its original start is that day's (a moved day keeps its
    original start); for a single event, no series at all."""
    if not isinstance(e, dict) or str(e.get("iCalUID") or uid) != uid:
        return False
    base = uid.removesuffix("@google.com")
    if not instance:
        return not e.get("recurringEventId")
    if str(e.get("recurringEventId") or "") != base:
        return False
    original = e.get("originalStartTime") or {}
    try:
        when = (datetime.fromisoformat(original["dateTime"].replace("Z", "+00:00")) if original.get("dateTime")
                else date.fromisoformat(original["date"]))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
    return ical._key(when) == instance


def version(ledger: Ledger, key: str) -> dict:
    try:
        d = json.loads(ledger.get_meta(VERSION + key) or "{}")
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _set_version(ledger: Ledger, key: str, d: dict, db=None) -> None:
    value = json.dumps(d, sort_keys=True)
    if ledger.get_meta(VERSION + key) != value:
        _set_meta(ledger, VERSION + key, value, db)


def _shown(fields: tuple) -> dict:
    return {"title": fields[0] or "", "start": _text(fields[1]), "end": _text(fields[2])}


def baseline(ledger: Ledger, key: str, row=None) -> tuple | None:
    """(title, start, end) Harness last wrote on this copy, from its own record (round 5): what a read of the copy
    is judged against, never values read from the copy. A copy from before this record kept it in its row, which
    Harness alone writes."""
    got = pending_fields(version(ledger, key), "wrote")
    if got is not None:
        return got
    if row is None:
        return None
    try:
        return row["title"], _parse(row["start"]), _parse(row["end"])
    except (TypeError, ValueError, KeyError, IndexError):
        return None


def set_baseline(ledger: Ledger, key: str, fields: tuple, db=None) -> None:
    d = version(ledger, key)
    d["wrote"] = _shown(fields)
    _set_version(ledger, key, d, db)


def note_write(ledger: Ledger, key: str, was: str, got: str = "", *, landed: bool, db=None,
               wrote: tuple | None = None, before: tuple | None = None, prior_body: str | None = None,
               intended: str | None = None, op: str = "put", uid: str = "") -> None:
    """A write of Harness's own to this copy, its own sync's or a change he asked for: sent against `was` (the
    version just checked), leaving `got` ("" when not known). Not landed: its outcome is still undecided, and this
    is saved (committed) before the write is sent (round 5): the version and body it goes over (`prior_body`) and
    the body it sends (`intended`). `wrote`: (title, start, end) as written; once landed, that is the copy's new
    baseline. `before`: (title, start, end) the copy held as Harness's own just before, for the decision table."""
    d = version(ledger, key)
    old = d.get("pending") if isinstance(d.get("pending"), dict) else {}
    same = old.get("from") == (was or "") and not old.get("landed")
    d["pending"] = {"from": was or "", "at": iso(ledger.now()), "landed": bool(landed), "op": op}
    if uid:
        d["pending"]["uid"] = uid                # a create's address, so a create cut off is settled by it
    elif same and isinstance(old.get("uid"), str):
        d["pending"]["uid"] = old["uid"]
    if wrote is not None:
        d["pending"]["wrote"] = _shown(wrote)
    elif same and isinstance(old.get("wrote"), dict):
        d["pending"]["wrote"] = old["wrote"]
    if before is not None:
        d["pending"]["before"] = _shown(before)
    elif same and isinstance(old.get("before"), dict):
        d["pending"]["before"] = old["before"]   # the same write's answer: what it went over stays known
    for name, value in (("prior_body", prior_body), ("intended", intended)):
        if value is not None:
            d["pending"][name] = value
        elif same and isinstance(old.get(name), str):
            d["pending"][name] = old[name]
    if landed:
        d["confirmed"] = got or ""
        if isinstance(d["pending"].get("wrote"), dict) and op != "delete":
            d["wrote"] = d["pending"]["wrote"]
    _set_version(ledger, key, d, db)


def pending_state(ledger: Ledger, key: str) -> tuple[str, dict | None]:
    """("none", None) with no write undecided; ("ok", it) for an undecided write whose record is whole; ("damaged",
    None) when the record can't be read or an undecided write's record is missing what it needs (round 5): then
    the copy is left alone rather than guessed at."""
    raw = ledger.get_meta(VERSION + key)
    if not raw:
        return "none", None
    try:
        d = json.loads(raw)
    except ValueError:
        return "damaged", None
    if not isinstance(d, dict):
        return "damaged", None
    pending = d.get("pending")
    if pending is None:
        return "none", None
    if not isinstance(pending, dict):
        return "damaged", None
    if pending.get("landed"):
        return "none", None
    if any(not isinstance(pending.get(k), str) for k in PENDING_NEEDS) or (
            pending.get("op") != "delete" and pending_fields(pending, "wrote") is None):
        return "damaged", None
    return "ok", pending


def mark_hands_off(ledger: Ledger, key: str, why: str, lines: list[str] | None = None) -> None:
    """A copy someone changed on Family, found by a card's own check (calendar_change.py): no longer followed, and
    said once in the digest, as the sync's own _leave does (round 5)."""
    row = ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (key,)).fetchone()
    if row is None or row["hand"] or row["state"] not in ("live", "hands_off"):
        return
    was = row["state"]
    detail = {"key": key, "word": row["word"], "start": row["start"], "why": why}
    if lines:
        detail["lines"] = [x for x in lines if re.fullmatch(r"[A-Z0-9-]{1,40}", x)][:12]
    with ledger.tx() as db:
        db.execute("UPDATE family_copies SET state='hands_off', updated_at=? WHERE key=?", (iso(ledger.now()), key))
        if was == "live":
            ledger.event("family_copy_left_alone", detail, db=db)
    if was == "live":
        log.warning("family copy: %s copy of %s not followed (%s)", row["word"], row["start"][:10], why)


def settle(ledger: Ledger, key: str, etag: str, own: bool, db=None) -> None:
    """A write of Harness's own decided by the copy's content at this version: as written (own), the version is
    Harness's and what it wrote is the copy's baseline; anything else is someone's edit, kept apart and never
    Harness's own."""
    d = version(ledger, key)
    pending = d.get("pending")
    if isinstance(pending, dict):
        pending["landed"] = True
    if own:
        d["confirmed"] = etag or ""
        d.pop("edited", None)
        if isinstance(pending, dict) and isinstance(pending.get("wrote"), dict) and pending.get("op") != "delete":
            d["wrote"] = pending["wrote"]
    else:
        d["edited"] = etag or ""
    _set_version(ledger, key, d, db)


def expired(ledger: Ledger, key: str) -> dict | None:
    """The write still undecided after PENDING_FOR, if there is one: to be settled by content."""
    pending = version(ledger, key).get("pending")
    if not isinstance(pending, dict) or pending.get("landed"):
        return None
    try:
        old = ledger.now() - datetime.fromisoformat(pending["at"]) > PENDING_FOR
    except (KeyError, TypeError, ValueError):
        old = True
    return pending if old else None


def _parse(value: str):
    return datetime.fromisoformat(value) if "T" in value else date.fromisoformat(value)


def content_is(body: str, uid: str, title: str, start, end, tz: str = "") -> bool:
    """The copy's body holds exactly what Harness writes for this title, start and end, and nothing more: the
    allowlist (caldav.copy_as_written, round 4 of the review of Nov 27). Times compare as instants and text
    unfolded, so iCloud's own rewrites still pass; an alarm, attendee, link, status, repeat, second event, place
    or notes someone added doesn't. Anything that fails it is someone's edit."""
    return caldav.copy_as_written(body, uid, title, start, end)


def pending_fields(pending: dict, which: str) -> tuple | None:
    """(title, start, end) a pending write kept as `which` ("wrote" or "before"), or None."""
    f = pending.get(which) if isinstance(pending, dict) else None
    if not isinstance(f, dict) or not f.get("start") or not f.get("end"):
        return None
    try:
        when = [datetime.fromisoformat(v) if "T" in v else date.fromisoformat(v) for v in (f["start"], f["end"])]
    except (TypeError, ValueError):
        return None
    return str(f.get("title") or ""), when[0], when[1]


def decide(ledger: Ledger, key: str, landed: bool, db=None) -> None:
    """A pending write decided without a version of Harness's own to confirm: not landed (the decision table's
    "same version, pre-write content"). Its pre-write version is never lag after this."""
    d = version(ledger, key)
    pending = d.get("pending")
    if isinstance(pending, dict):
        pending["landed"] = True
        pending["outcome"] = "landed" if landed else "not landed"
    _set_version(ledger, key, d, db)


def confirm(ledger: Ledger, key: str, etag: str, db=None) -> None:
    """The copy read as Harness wrote it, at this version: that write is decided."""
    d = version(ledger, key)
    pending = d.get("pending")
    if d.get("confirmed") == etag and (not isinstance(pending, dict) or pending.get("landed")):
        return
    d["confirmed"] = etag or ""
    if isinstance(pending, dict):
        pending["landed"] = True
    _set_version(ledger, key, d, db)


def lagging(ledger: Ledger, key: str, etag: str) -> bool:
    """A Family read at this version is from before a write of Harness's own: its version is that write's
    pre-write version, and the write is undecided or was sent within LAG_FOR."""
    pending = version(ledger, key).get("pending")
    if not etag or not isinstance(pending, dict) or pending.get("from") != etag or pending.get("outcome"):
        return False
    if not pending.get("landed"):
        return expired(ledger, key) is None    # undecided an hour: settled by content, never lag (round 3)
    try:
        return ledger.now() - datetime.fromisoformat(pending["at"]) <= LAG_FOR
    except (KeyError, TypeError, ValueError):
        return False


def may_retry(ledger: Ledger, key: str) -> bool:
    """Another write after a conflict, or after a write that never landed, is allowed: fewer than MAX_RETRIES in
    the last hour and fewer than MAX_TOTAL_RETRIES ever for this copy (round 4). Counted when True."""
    d = version(ledger, key)
    total = d.get("retried") if isinstance(d.get("retried"), int) else 0
    if total >= MAX_TOTAL_RETRIES:
        return False
    now = ledger.now()
    kept = []
    for t in d.get("retries") or []:
        try:
            if now - datetime.fromisoformat(t) < RETRY_WINDOW:
                kept.append(t)
        except (TypeError, ValueError):
            continue
    ok = len(kept) < MAX_RETRIES
    if ok:
        kept.append(iso(now))
        d["retried"] = total + 1
    d["retries"] = kept
    _set_version(ledger, key, d)
    return ok


def hold(ledger: Ledger, key: str, start: str = "", end: str = "", *, gone: bool = False,
         db=None) -> None:
    """A copy moved with its Gmail event, or put back with it, in a change he asked for
    (calendar_change.py). A read taken before that change still shows the times it had, or no
    event at all, and mustn't undo it: until a read shows the copy as written, or three hours
    pass, those times, every one it has had in that while, and "gone" are a read from before."""
    try:
        d = json.loads(ledger.get_meta(HOLD + key) or "{}")
        times = [list(t) for t in d.get("times", []) if isinstance(t, list) and len(t) == 2]
    except (ValueError, TypeError, AttributeError):
        d, times = {}, []
    if start and end and [start, end] not in times:
        times.append([start, end])
    ledger.set_meta(HOLD + key, json.dumps({"times": times[-8:], "gone": bool(gone or d.get("gone")),
                                            "until": iso(ledger.now() + HOLD_FOR)}), db)


def queued(ledger: Ledger, key: str) -> dict | None:
    """The reconciliation queued for this copy after a write (round 3 of the second review), or None."""
    raw = ledger.get_meta(RECONCILE + key)
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except ValueError:
        d = None
    return d if isinstance(d, dict) else {"op": "check", "rev": "", "tries": 0}


def queue(ledger: Ledger, key: str, op: str, rev: str = "", db=None) -> None:
    """Saved (committed) as it is called: a check after a write, or a move or cancel found by that check. Its tries
    are kept across, so a source that keeps moving reaches the cap."""
    old = queued(ledger, key) or {}
    tries = old.get("tries") if isinstance(old.get("tries"), int) else 0
    _set_meta(ledger, RECONCILE + key, json.dumps({"op": op, "rev": rev or "", "at": iso(ledger.now()),
                                                   "tries": tries}, sort_keys=True), db)


def unqueue(ledger: Ledger, key: str, db=None) -> None:
    if ledger.get_meta(RECONCILE + key) is None:
        return
    if db is not None:
        db.execute("DELETE FROM meta WHERE key=?", (RECONCILE + key,))
        return
    with ledger.tx() as d:
        d.execute("DELETE FROM meta WHERE key=?", (RECONCILE + key,))


def suppress(ledger: Ledger, key: str, why: str, db=None) -> None:
    """A reason never to make this copy again, nor to reconcile it (SUPPRESS). A removal that went through outranks
    one being sent, and nothing outranks a removal: "approving" never replaces "asked_off" or "household"."""
    assert why in SUPPRESS_WHY
    if why == "approving" and (suppressed(ledger, key) or {}).get("why") in ("asked_off", "household"):
        return
    _set_meta(ledger, SUPPRESS + key, json.dumps({"why": why, "at": iso(ledger.now())}, sort_keys=True), db)


def suppressed(ledger: Ledger, key: str) -> dict | None:
    """Why this copy is never made again nor reconciled, or None. A record that can't be read counts (fail closed);
    an "approving" mark older than APPROVING_FOR is a removal that never got as far as landing or failing, and lapses."""
    raw = ledger.get_meta(SUPPRESS + key)
    if raw is None:
        return None
    try:
        d = json.loads(raw)
        why = d["why"] if isinstance(d, dict) and d.get("why") in SUPPRESS_WHY else None
    except (ValueError, TypeError, KeyError):
        why = None
    if why is None:
        return {"why": "unreadable"}
    if why == "approving":
        try:
            if ledger.now() - datetime.fromisoformat(d["at"]) > APPROVING_FOR:
                return None
        except (ValueError, TypeError, KeyError):
            pass
    return d


def unsuppress(ledger: Ledger, key: str, db=None, *, only: str = "") -> None:
    """His Undo of the removal (or, with only="approving", a removal that failed outright): the copy may follow again."""
    if ledger.get_meta(SUPPRESS + key) is None:
        return
    if only and (suppressed(ledger, key) or {}).get("why") != only:
        return
    if db is not None:
        db.execute("DELETE FROM meta WHERE key=?", (SUPPRESS + key,))
        return
    with ledger.tx() as d:
        d.execute("DELETE FROM meta WHERE key=?", (SUPPRESS + key,))


def confirm_soon(ledger: Ledger, table: str, calendar) -> None:
    """A few removals waiting on their second look get it in minutes. Many at once wait for the
    usual reads: that's the guard against a bad read, and it's meant to take hours."""
    n = ledger.db.execute(f"SELECT COUNT(*) FROM {table} WHERE state='live' AND missing=1").fetchone()[0]
    if 0 < n <= MAX_REMOVALS_AT_ONCE:
        calendar.read_soon(CONFIRM_AFTER)
SLOP = timedelta(minutes=30)   # travel time makes the two calendars differ a little
PROBLEM = "family_copy_problem"
READ_SIZE = "family_copy_read_size"
THIN_READS = "family_copy_thin_reads"
REVIVED = "family_copy_revived_074"      # a new name gives them one more try after this update
REVIVE_TRIES = "family_copy_revive_tries_074"
REVIVE_GONE = "family_copy_revive_gone_074"   # the ones it found taken off: told once, never waited on
TRIP = "trip"
CAPPED = ("Copies from Gmail: today's limit of changes is reached, so some wait for tomorrow and "
          "may be wrong until then.")
_WHY = {"edited": "changed on Family", "changed": "changed on Family",
        "not listed": "Family's list leaves it out", "gone": "no longer on Family",
        "off": "its time doesn't match Gmail", "earlier": "stopped following earlier",
        "conflicts": "Family kept giving it a new version as I wrote it",
        "record": "my record of a write to it couldn't be read, so I didn't guess",
        "taken back": "taken back on your tap"}
YOURS = ("edited", "changed")          # someone changed it on Family: his to keep, never written over

# The word on Family, by what the title says. Checked in order.
_WORDS = (("PT", r"pt|physical therapy|physio"),
          ("Dentist", r"dentist|dental|orthodontist"),
          ("Doctor", r"doctor|dr|clinic|hospital|surgery|echo|consult\w*|orthoped\w*|cardiolog\w*"
                     r"|dermatolog\w*|pediatric\w*|optometrist|eye exam"),
          ("Vet", r"vet|veterinar\w*"),
          ("Haircut", r"haircut|barber"),
          ("Coffee", r"coffee"),
          ("Computer Lab", r"computer lab"),
          ("Massage", r"massages?|massage therap\w*"),
          ("Appointment", r"appt|appointment"))
_WORD_RES = tuple((word, re.compile(rf"\b(?:{pattern})\b", re.I)) for word, pattern in _WORDS)
_SKIP = re.compile(r"\b(busy|call|session|meeting|flight|stay|reservation|drive|transit|uber|lyft"
                   r"|deadline|checkpoint|task|reminder|onboarding|keynote|webinar|reception"
                   r"|interview|standup|sync)\b", re.I)
_STAY = re.compile(r"stay at\b(?! home\b)", re.I)
# An event Harness itself added to his Gmail calendar at his word (calendar_change._gmail_add: "cm" and 32
# hex). His by construction, never anyone's invitation, so its appointment gets a copy whatever it's called.
_MADE_HERE = re.compile(r"cm[0-9a-f]{32}(?:@google\.com)?")
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
    word = next((word for word, rx in _WORD_RES if rx.search(occ.summary)), None)
    if word is None and made_here(occ):
        return "Appointment"       # one he had Harness add: his appointment, copied like the rest (Nov 27)
    return word


def made_here(occ: ical.Occurrence) -> bool:
    """Added to his Gmail calendar by Harness itself, at his word."""
    return bool(_MADE_HERE.fullmatch(occ.uid))


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
    return _key_of(occ.uid, occ.instance)


def _key_of(uid: str, instance: str) -> str:
    return hashlib.sha256(f"{uid}|{instance}".encode()).hexdigest()[:32]


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
    """His own: no organizer, or him. One Harness added for him is his whoever Google names as its
    organizer (the service account that wrote it, say)."""
    return not occ.organizer or occ.organizer == occ.calendar.casefold() or made_here(occ)


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
    def __init__(self, ledger: Ledger, family_add, calendar, *, name_fn=lambda: "", tz: str, google=None,
                 address_fn=None):
        self.ledger = ledger
        self.google = google               # his Gmail calendar by Google's API: a copy's event read again (round 4)
        self.address_fn = address_fn       # which Gmail calendar is his
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
            return "Copies from Gmail: off, no first name in Harness's settings."
        feeds = self.calendar.snapshot.feeds.values()
        if not self.calendar.configured or (feeds and not self._gmail_feeds()):
            return ("Copies from Gmail: waiting. Enter your Gmail calendar's secret iCal address "
                    "on the Harness page.")
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
        s = iso(since) if since else ""
        return " ".join(x for x in (line, self._server_line(s), left, self._not_found_line(s),
                                    self._named_line(s, UNCERTAIN, (
                                        "Copies from Gmail: iCloud's answer was lost when I made the Family copy of {}, "
                                        "and it isn't on Family now, so I left it off rather than risk making it twice.")),
                                    self._named_line(s, RECONCILE_CAPPED, (
                                        "Copies from Gmail: the Gmail event of {} kept moving, or couldn't be read "
                                        "again, each time I wrote its Family copy, so I stopped after "
                                        f"{RECONCILE_TRIES} tries; the next reads keep it in step as usual.")),
                                    self._named_line(s, PURGED_EVENT, (
                                        "Copies from Gmail: Google no longer has the Gmail event of {} (it answers "
                                        "“not found”, which is what it says once a deleted event is purged), so I "
                                        "left its Family copy as it is. A card asks whether to take it off.")),
                                    problem) if x)

    def _named_line(self, since: str, kind: str, words: str) -> str:
        """One line naming each copy an event of this kind is about (word and day), or ""."""
        out = []
        for r in self.ledger.db.execute("SELECT detail FROM events WHERE kind=? AND at>=?", (kind, since)):
            try:
                d = json.loads(r["detail"])
                day = _first_day(self._when(d["start"]), ZoneInfo(self.tz))
                out.append(f"{d['word']} {day:%b} {day.day}")
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        return words.format(", ".join(sorted(set(out)))) if out else ""

    def _event_for(self, kind: str, row) -> None:
        with self.ledger.tx() as db:
            self.ledger.event(kind, {"key": row["key"], "word": row["word"], "start": row["start"]}, db=db)

    def _server_line(self, since: str) -> str:
        """Once: many copies at once stopped reading as Harness wrote them (round 5)."""
        r = self.ledger.db.execute("SELECT detail FROM events WHERE kind=? AND at>=? ORDER BY at DESC LIMIT 1",
                                   (SERVER_CHANGE, since)).fetchone()
        if r is None:
            return ""
        try:
            d = json.loads(r["detail"])
            n, lines = int(d.get("n", 0)), [x for x in d.get("lines", []) if re.fullmatch(r"[A-Z0-9-]{1,40}", x)]
        except (ValueError, TypeError, AttributeError):
            n, lines = 0, []
        what = f", each with a new {', '.join(lines)} line" if lines else ""
        return (f"Copies from Gmail: {n or 'several'} Family copies stopped reading as I wrote them in one read"
                f"{what}. That looks like iCloud changing how it keeps events, not people's edits. I left them "
                "alone; ask me about one to take it back.")

    def _not_found_line(self, since: str) -> str:
        """A copy whose Gmail event Google keeps answering "not found" for, by name, once (round 5)."""
        out = []
        for r in self.ledger.db.execute("SELECT detail FROM events WHERE kind='family_copy_not_found' AND at>=?",
                                        (since,)):
            try:
                d = json.loads(r["detail"])
                if self.ledger.get_meta(PURGED + d["key"]):
                    continue                       # said by its own line, with its card

                day = _first_day(self._when(d["start"]), ZoneInfo(self.tz))
                out.append(f"{d['word']} {day:%b} {day.day}")
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        if not out:
            return ""
        return ("Copies from Gmail: Google keeps answering \u201cnot found\u201d for the Gmail event of "
                + ", ".join(sorted(set(out))) + ", so I left those copies as they are.")

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
        self.left_now: list[tuple[str, tuple]] = []    # copies gone hands-off on this read (round 5)
        try:
            self._sync_read(feed, family, now, until, name)
        finally:
            self._loud()

    def _sync_read(self, feed, family, now: datetime, until: datetime, name: str) -> None:
        self._revive(family, now, until)
        self._tell_once(family)
        occ = feed.ahead.occurrences
        self._occ_by_key = {_key(o): o for o in occ if o.uid}
        # Cancelled records the feed itself carries (ical.Window.cancelled): affirmative evidence of a deletion.
        self._feed_cancelled = {_key_of(uid, instance)
                                for uid, instance in getattr(feed.ahead, "cancelled", None) or ()}
        self._uncertain_found(family)
        planned = plan(occ, name, self.tz)
        wants = {k: w for k, w in planned.items() if self._ends(w) > now}
        sources = {_key(o): o.summary for o in occ}
        self.writes = self._writes_today()
        odd = self._thin(len(occ), len(occ) - len(planned)) or not occ
        if not odd and feed.ahead.unreadable == 0:
            self._let_go(planned)
        problems = [self._follow(wants, family, now, feed.ahead.unreadable == 0, until, odd)]
        problems.append(self._add_new(wants, sources, family.items, name))
        self._remember(occ)
        self._problem(next((p for p in problems if p), ""))

    def _remember(self, occ: list[ical.Occurrence]) -> None:
        """Each copy's Gmail event by its own identity (series uid and original start), whatever state
        the copy is in, so a request about it can read that event again wherever it now sits."""
        by_key = {_key(o): o for o in occ if o.uid}
        keys = [r["key"] for r in self.ledger.db.execute("SELECT key FROM family_copies").fetchall()
                if r["key"] in by_key]
        if not keys:
            return
        with self.ledger.tx() as db:
            for key in keys:
                remember_source(self.ledger, key, by_key[key], db)

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
        held = self._holds(now)
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
            if not row["hand"] and pending_state(self.ledger, row["key"])[0] == "damaged":
                self._leave(row, "record")         # a write's record can't be read: never guessed at (round 5)
                continue
            if not row["hand"] and (pending := expired(self.ledger, row["key"])) is not None:
                row, settled = self._settle_expired(row, item, pending)
                if settled:
                    continue
                start, end = self._when(row["start"]), self._when(row["end"])
            if not row["hand"] and self._work_queue(row, item, want):
                continue                           # a write's own check, worked off (round 3 of the second review)
            base = None if row["hand"] else (baseline(self.ledger, row["key"], row) or
                                             (row["title"], start, end))
            if row["hand"]:
                if not _still_seen(row, item):
                    self._leave(row, "edited")     # not what was taken over any more
                    continue
                if row["seen"] == _seen(item.occ):
                    self._update(row, seen=_seen_now(item))    # from before notes were seen
            elif want is not None and content_is(item.data, row["uid"], want.title, want.start, want.end):
                # Already as it should be: a write whose answer was lost, or a change he asked for.
                if not (_same(want.start, start) and _same(want.end, end)):
                    self._moved(row, row["uid"], want)
                elif row["missing"]:
                    self._update(row, missing=0)
                confirm(self.ledger, row["key"], item.etag)
                if row["key"] in held:
                    self._unhold(row["key"])
                continue
            elif not content_is(item.data, row["uid"], *base):
                before = self._before(row, item)
                if want is None or not lagging(self.ledger, row["key"], item.etag) or before is None:
                    # Someone edited it, whatever times it shows: theirs now. A read at the version before a
                    # write of Harness's own counts as behind only while it holds exactly what Harness had
                    # written there; anything added to it is never written over (round 4). Judged against what
                    # Harness last wrote, from its own record, never against the copy (round 5).
                    self._leave(row, "edited", lines=caldav.copy_differences(item.data, row["uid"], *base))
                    continue
                # The version from before a write of Harness's own still undecided or just sent: this read is
                # behind, not anyone's edit (Nov 27). Brought to its event, over the version just read.
                stale_times, _ = held.get(row["key"], ((), False))
                if any(_same(want.start, a) and _same(want.end, b) for a, b in stale_times):
                    continue                   # the Gmail read is the one from before: the next shows it
                if not self._room():
                    waiting += 1
                    continue
                if not may_retry(self.ledger, row["key"]):
                    self._leave(row, "conflicts")
                    continue
                failed = self._write_ours(row, item.etag, item.data, want, before=before)
                if failed:
                    problem = problem or failed
                    tries += 1
                    if tries >= MAX_FAILED_WRITES:
                        break
                continue
            stale_times, stale_gone = held.get(row["key"], ((), False))
            if want is None:
                if gmail_clean and not stale_gone:   # gone in a read from before his Undo: not gone
                    gone.append((row, item))
                continue
            if row["missing"]:
                self._update(row, missing=0)
            if any(_same(want.start, a) and _same(want.end, b) for a, b in stale_times):
                continue                       # a read from before the change he asked for: the next shows it
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

    def _holds(self, now: datetime) -> dict[str, tuple]:
        """Copies changed with a change he asked for: (the times a read from before may still show,
        whether such a read may show no event). One past its time is let go."""
        out = {}
        for r in self.ledger.db.execute("SELECT key, value FROM meta WHERE substr(key, 1, ?)=?",
                                        (len(HOLD), HOLD)).fetchall():
            try:
                d = json.loads(r["value"])
                if datetime.fromisoformat(d["until"]) > now:
                    out[r["key"][len(HOLD):]] = (tuple((self._when(a), self._when(b)) for a, b in d["times"]),
                                                 bool(d.get("gone")))
                    continue
            except (ValueError, KeyError, TypeError):
                pass
            self._unhold(r["key"][len(HOLD):])
        return out

    def _let_go(self, planned: dict) -> None:
        """A copy taken off with its Gmail event, at his word, waits only while a read may still
        show that event. Once a whole read doesn't, it's cancelled. Round 4 of the second review: his approved
        removal is recorded (suppressed), so it comes back only by his Undo, which clears that record."""
        for row in self.ledger.db.execute("SELECT * FROM family_copies WHERE state='asked_off'").fetchall():
            if row["key"] not in planned:
                self._set(row, "cancelled")

    def _unhold(self, key: str) -> None:
        with self.ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (HOLD + key,))

    def _settle_expired(self, row, item, pending: dict):
        """A write of Harness's own undecided for PENDING_FOR, settled by a decision table on what the copy shows
        now (round 4). Returns (the row as it now stands, settled): settled means nothing more is done with it
        on this read.

          * it holds exactly what that write wrote (the allowlist): landed, Harness's own at this version;
          * still the version the write went over, holding exactly what Harness had there before: it never
            landed. The row goes back to that and the usual sync writes it once more, conditionally on this
            version, counted against the copy's retry cap;
          * anything else, a new version or anything added: someone's edit. Left alone, never written over."""
        uid, key = row["uid"], row["key"]
        before = pending_fields(pending, "before")
        if pending.get("op") == "delete":
            # A removal undecided an hour, and the copy is still there: it never landed if the copy is still the
            # version it went over, holding exactly Harness's own; anything else is someone's.
            if before is not None and item.etag and item.etag == pending.get("from") and content_is(item.data, uid,
                                                                                                    *before):
                decide(self.ledger, key, landed=False)
                return row, False
            settle(self.ledger, key, item.etag, False)
            self._leave(row, "edited", lines=caldav.copy_differences(item.data, uid, *(before or baseline(
                self.ledger, key, row))))
            return row, True
        wrote = pending_fields(pending, "wrote") or baseline(self.ledger, key, row)
        if content_is(item.data, uid, *wrote):
            settle(self.ledger, key, item.etag, True)
            log.info("family copy: a %s copy's write undecided an hour, settled: landed", row["word"])
            return self._as_held(row, wrote), False
        if before is not None and item.etag and item.etag == pending.get("from") and content_is(item.data, uid, *before):
            decide(self.ledger, key, landed=False)
            log.info("family copy: a %s copy's write undecided an hour, settled: never landed", row["word"])
            if not may_retry(self.ledger, key):
                self._leave(row, "conflicts")
                return row, True
            return self._as_held(row, before), False
        settle(self.ledger, key, item.etag, False)
        log.info("family copy: a %s copy's write undecided an hour, settled: someone's edit", row["word"])
        self._leave(row, "edited", lines=caldav.copy_differences(item.data, uid, *wrote))
        return row, True

    def _as_held(self, row, fields: tuple):
        """The row brought to what the copy on Family is known to hold, and read again."""
        title, start, end = fields
        if (title, _text(start), _text(end)) != (row["title"], row["start"], row["end"]):
            self._update(row, title=title, start=_text(start), end=_text(end))
        set_baseline(self.ledger, row["key"], fields)     # what the copy is known to hold, as Harness wrote it
        return self.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (row["key"],)).fetchone()

    def _before(self, row, item) -> tuple | None:
        """What the copy held as Harness's own before its pending write, when this read shows exactly that at the
        version the write went over: the read is behind. None otherwise."""
        pending = version(self.ledger, row["key"]).get("pending")
        before = pending_fields(pending, "before")
        if before is None or not item.etag or pending.get("from") != item.etag:
            return None
        return before if content_is(item.data, row["uid"], *before) else None


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
            elif want is None and not row["hand"]:
                # Gone from Family with no write of Harness's: someone took it off. Left alone and said once, and
                # never made again by itself, even if its event comes back (round 5), and recorded so (round 4).
                suppress(self.ledger, row["key"], "household")
                self._leave(row, "gone")
            elif want is None:
                self._set(row, "cancelled")        # gone on both sides: nothing to learn
            else:
                self._removed(row)
        return problem

    def _evidence(self, row) -> str:
        """Why a copy's Gmail event is out of the feed (round 3 of the second review): "deleted" only on affirmative
        evidence, a cancelled record in the feed's own read, or Google answering 410 Gone or the event cancelled by
        its id; "elsewhere" when Google has it, as the copy's own event, but it isn't one to copy now (renamed, say);
        "behind" when Google has it as one to copy (the feed is behind); "purged" for "not found" (404), which is
        what Google says once a deleted event is purged, and also for an id it never had, so never a deletion;
        "unknown" for anything else, a read that fails or no way to read it. Only "deleted" and "elsewhere" take a
        copy off by itself."""
        if row["key"] in getattr(self, "_feed_cancelled", ()):
            return "deleted"
        google = self.google
        if google is None or not getattr(google, "configured", lambda: True)() or not (
                (self.address_fn() if self.address_fn else "") and source_of(self.ledger, row["key"])):
            return "unknown"                       # a trip too: its stay is read by its id (only its times aren't)
        kind, e = self._look(row)
        if kind == "deleted":
            return "deleted"
        if kind == "missing":
            return "purged"
        if kind != "ok":
            return "unknown"
        occ = self._source_occurrence(row, e)
        if occ is None:
            return "unknown"
        return "behind" if word_for(occ) is not None or row["word"] == TRIP else "elsewhere"

    def _purged(self, row) -> None:
        """A copy left because Google no longer has its event: said once, with one card for his tap (purged_due)."""
        n = int(self.ledger.get_meta(MISSING + row["key"]) or 0)
        if n < MISSING_404S or self.ledger.get_meta(PURGED + row["key"]):
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta(PURGED + row["key"], "due", db)
            self.ledger.event(PURGED_EVENT, {"key": row["key"], "word": row["word"], "start": row["start"]}, db=db)
        log.warning("family copy: a %s copy's Gmail event is no longer known to Google: left, a card asks",
                    row["word"])

    def purged_due(self) -> list[str]:
        """Copies left because their Gmail event was purged, whose take-it-off card hasn't gone yet."""
        return [r["key"][len(PURGED):] for r in self.ledger.db.execute(
            "SELECT key FROM meta WHERE substr(key, 1, ?)=? AND value='due'", (len(PURGED), PURGED)).fetchall()]

    def purged_carded(self, key: str) -> None:
        _set_meta(self.ledger, PURGED + key, "carded")

    def _cancel(self, gone: list, wants: dict, odd: bool) -> str:
        ready = [(row, item) for row, item in gone if row["missing"] + 1 >= READS_BEFORE_REMOVING]
        for row, _ in gone:
            self._update(row, missing=row["missing"] + 1)
        # Round 3 of the second review: a copy comes off by itself only on affirmative evidence its event was
        # deleted (or that Google has it and it isn't one to copy now). "Not found" is never that: one line and a
        # card. Anything unread: left, and asked again at the next read.
        sure = []
        for row, item in ready:
            why = self._evidence(row)
            if why in ("deleted", "elsewhere"):
                sure.append((row, item))
            elif why == "purged":
                self._purged(row)
        ready = sure
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
            if row["hand"]:
                out = self.client.remove_hand_copy(item.href, item.etag, item.data)
                kind = out.kind
            else:
                kind, out = self._guarded_delete(row, item)
            if kind in ("ok", "gone"):
                self.deleted.add(item.href)
                self._set(row, "cancelled")
                self._log("family_copy_cancelled", row["key"])
                self.writes += 1
            elif kind in ("changed", "record", "conflicts"):
                self._leave(row, kind)
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
        suppress(self.ledger, row["key"], "household")
        self._set(row, "removed")
        self._log("family_copy_removed", row["key"])

    def _move(self, row, item, want: Want) -> str:
        if row["hand"]:
            # Takes over his copy: removed, and ours written in its place.
            out = self.client.remove_hand_copy(item.href, item.etag, item.data)
            if out.kind == "changed":
                self._leave(row, "changed")
                return ""
            if out.kind not in ("ok", "gone"):
                return self._write_problem(out)
            self.deleted.add(item.href)
            uid = _uid(row["key"])
            verdict, out = self._create(row["key"], uid, want)
            if verdict == "theirs":
                self._leave(row, "changed")    # something at its address isn't Harness's: never written over
                return ""
            if verdict == "uncertain":
                self._update(row, uid=uid, hand=0, href="", seen="", state="uncertain")
                self._event_for(UNCERTAIN, row)
                return ""
            if verdict != "ok":
                self._set(row, "lost")     # his copy is gone and ours isn't there: try anew
                return self._write_problem(out)
            self._moved(row, uid, want)
            self._verify(row, want, "")
            return ""
        return self._write_ours(row, item.etag, item.data, want)

    def _write_ours(self, row, etag: str, data: str, want: Want, *, before: tuple | None = None) -> str:
        """Our own copy brought to its event, only over the version just checked, which holds exactly what Harness
        last wrote there (`before`, by default its baseline). Its Gmail event is read again by its id first, and the
        copy takes what that read says (round 4), and that read's revision is kept: if the event moved on while the
        copy was written, it's reconciled once, with the ownership and version checks again (round 5). The write
        goes through the one guarded write (_guarded): a conflict or a lost answer is never taken as either way."""
        uid = row["uid"]
        before = before or baseline(self.ledger, row["key"], row) or (row["title"], self._when(row["start"]),
                                                                     self._when(row["end"]))
        want, problem, rev = self._gmail_now(row, want)
        if want is None:
            return problem
        if content_is(data, uid, want.title, want.start, want.end):
            self._moved(row, uid, want)            # already so: the feed was behind the event
            unqueue(self.ledger, row["key"])
            return ""
        if suppressed(self.ledger, row["key"]) is not None:
            unqueue(self.ledger, row["key"])       # a removal he approved, or someone's, outranks this write
            return ""
        if self._looks(row, want):
            queue(self.ledger, row["key"], "check", rev)   # saved before the write: checked after it, even cut off
        verdict, out = self._guarded(row, etag, data, want, before)
        if verdict == "ok":
            self._moved(row, uid, want)
            self._verify(row, want, rev)
            return ""
        unqueue(self.ledger, row["key"])           # nothing of this write stands to check: the sync judges again
        if verdict in ("changed", "conflicts", "record"):
            self._leave(row, verdict)
            return ""
        return self._write_problem(out)

    def _looks_key(self, key: str, want: Want) -> bool:
        return self._looks({"key": key, "word": want.word}, want)

    def _verify(self, row, wrote: Want, rev: str) -> None:
        """Round 3 of the second review: after every write to a copy, the correction's included, its Gmail event is
        read again by its id. Still where the write put the copy (or at the revision the write used): nothing more.
        Moved again, or cancelled, or not readable: queued (saved) for the next read, which works it off with the
        ownership and version checks again, a cancel by the guarded removal (_work_queue)."""
        if row is None:
            return
        key = row["key"]
        if not self._looks(row, wrote):
            unqueue(self.ledger, key)
            return
        kind, e = self._look(row)
        if kind == "deleted":
            queue(self.ledger, key, "cancel", rev)
            log.info("family copy: a %s copy's Gmail event was cancelled while its copy was written: queued",
                     row["word"])
        elif kind == "ok" and (occ := self._source_occurrence(row, e)) is not None:
            if (rev and str(e.get("etag") or "") == rev) or (_same(occ.start, wrote.start)
                                                              and _same(occ.end, wrote.end)):
                unqueue(self.ledger, key)
                return
            queue(self.ledger, key, "move", rev)
            log.info("family copy: a %s copy's Gmail event moved on while its copy was written: queued", row["word"])
        else:
            queue(self.ledger, key, "check", rev)
        read_soon = getattr(self.calendar, "read_soon", None)
        if read_soon is not None:
            read_soon(CONFIRM_AFTER)

    def _work_queue(self, row, item, want: Want | None) -> bool:
        """A reconciliation queued after a write (_verify), worked off on this read: True when this read is done
        with the copy. Only over a copy that still holds exactly what Harness last wrote there; anything else goes
        to the usual judging (behind, or someone's edit). RECONCILE_TRIES tries, then the digest says so."""
        key, uid = row["key"], row["uid"]
        q = queued(self.ledger, key)
        if q is None:
            return False
        if suppressed(self.ledger, key) is not None:
            # Round 4 of the second review: a removal he approved (being sent, or done) or someone's removal outranks
            # any check queued before it. Never acted on: dropped, and this read leaves the copy alone.
            unqueue(self.ledger, key)
            log.info("family copy: a %s copy's queued reconciliation dropped: its removal outranks it", row["word"])
            return True
        if not item.etag:
            return True                              # a queued move only ever updates, with If-Match: next read
        base = baseline(self.ledger, key, row)
        if base is None or not content_is(item.data, uid, *base):
            return False
        tries = (q.get("tries") if isinstance(q.get("tries"), int) else 0) + 1
        if tries > RECONCILE_TRIES:
            unqueue(self.ledger, key)
            self._event_for(RECONCILE_CAPPED, row)
            log.warning("family copy: a %s copy's reconciliation reached its cap", row["word"])
            return False
        q["tries"] = tries
        _set_meta(self.ledger, RECONCILE + key, json.dumps(q, sort_keys=True))
        if not self._looks(row, want):
            unqueue(self.ledger, key)
            return False
        kind, e = self._look(row)
        if kind == "deleted":
            if not self._room() or suppressed(self.ledger, key) is not None:
                return True
            verdict, out = self._guarded_delete(row, item)
            if verdict in ("ok", "gone"):
                self.deleted.add(item.href)
                self._set(row, "cancelled")
                self._log("family_copy_cancelled", key)
                self.writes += 1
                unqueue(self.ledger, key)
            elif verdict in ("changed", "record", "conflicts"):
                self._leave(row, verdict)
                unqueue(self.ledger, key)
            return True
        occ = self._source_occurrence(row, e) if kind == "ok" else None
        if occ is None:
            return True                              # not read: tried again at the next read, counted
        target = Want(key, row["word"], want.title if want is not None else row["title"], occ.start, occ.end)
        if content_is(item.data, uid, target.title, target.start, target.end):
            unqueue(self.ledger, key)
            return False
        if not self._room():
            return True
        log.info("family copy: a %s copy's queued reconciliation: brought to its event", row["word"])
        self._write_ours(row, item.etag, item.data, target, before=base)
        return True

    def _guarded(self, row, etag: str, data: str, want: Want, before: tuple) -> tuple[str, caldav.Outcome]:
        """The one guarded change of a Harness copy (round 5): sent only with If-Match on the version that passed the
        ownership check, after its record (that version, the body it goes over, the body it sends) is saved. On a
        412 or a lost answer the copy is read again by its address and the allowlist run again (_judge_again):
        written (ok), still exactly Harness's own at a version that may be written over (once more, counted against
        the copy's retry cap), or anything else, left alone. Never retried blindly. Returns (ok | changed |
        conflicts | record | failed, the last answer)."""
        uid, key = row["uid"], row["key"]
        if not etag:
            # Round 4 of the second review: a change of a copy (a queued move included) is an update with If-Match on
            # a version, never a create: with no version, nothing is sent.
            return "failed", caldav.Outcome("failed")
        while True:
            body = caldav.build_copy_ics(uid, want.title, want.start, want.end, self.ledger.now())
            note_write(self.ledger, key, etag, landed=False, wrote=(want.title, want.start, want.end),
                       before=before, prior_body=data, intended=body, op="put")
            out = self.client.copy_write(uid, body, etag)
            if out.kind == "ok":
                note_write(self.ledger, key, etag, out.etag or "", landed=True)
                return "ok", out
            if out.kind not in ("changed", "unknown"):
                return "failed", out
            verdict, etag, data = self._judge_again(row, sent_over=etag, lost=out.kind == "unknown")
            log.info("family copy: a %s copy's write answered %s; read again: %s", row["word"], out.kind, verdict)
            if verdict == "landed":                  # its content is what was written (_judge_again)
                settle(self.ledger, key, etag, True)
                return "ok", out
            if verdict == "theirs":
                return "changed", out
            if verdict == "record":
                return "record", out
            if verdict != "ours":
                return "failed", out                 # gone or not read: the next read says
            if not may_retry(self.ledger, key):
                return "conflicts", out

    def _guarded_delete(self, row, item) -> tuple[str, caldav.Outcome]:
        """The one guarded removal of a Harness copy (round 5): only at the version that passed the ownership check
        (If-Match), its record saved first; a 412 or a lost answer is read again and the allowlist run again, as
        _guarded. Returns (ok | gone | changed | conflicts | record | failed, the last answer)."""
        uid, key = row["uid"], row["key"]
        base = baseline(self.ledger, key, row)
        etag, body = item.etag, item.data
        while True:
            note_write(self.ledger, key, etag, landed=False, before=base, prior_body=body, intended="", op="delete")
            out = self.client.copy_delete(uid, etag)
            if out.kind in ("ok", "gone"):
                decide(self.ledger, key, landed=True)
                return out.kind, out
            if out.kind not in ("changed", "unknown"):
                return "failed", out
            back, now_body = self.client.fetch(self.client.href_for(uid))
            if back.kind == "gone":
                decide(self.ledger, key, landed=True)
                return "gone", back
            if back.kind != "ok" or not now_body or not back.etag:
                return "failed", out
            if pending_state(self.ledger, key)[0] != "ok":
                return "record", out
            if base is None or not content_is(now_body, uid, *base) or (out.kind == "unknown" and back.etag != etag):
                return "changed", out
            decide(self.ledger, key, landed=False)
            if not may_retry(self.ledger, key):
                return "conflicts", out
            etag, body = back.etag, now_body

    def _create(self, key: str, uid: str, want: Want) -> tuple[str, caldav.Outcome]:
        """A new copy, through the one guarded write: If-None-Match: *, so it never lands over anything, its record
        saved first. A refusal (something is at its address) or a lost answer is read again: exactly what was
        written is Harness's own (a lost answer's write found); anything else there is someone's, never written
        over. Returns (ok | theirs | uncertain | failed, the answer).

        Round 3 of the second review: a create whose answer was lost, found absent when read again, is "uncertain":
        recorded, left absent and never sent again by itself (it may still turn up). Only a create known to have
        failed without creating (refused, or refused because something was there that has gone since) is "failed",
        made again at a later read. A read again that can't answer leaves the create undecided, settled at the next
        read (_settle_create) before anything is sent."""
        fields = (want.title, want.start, want.end)
        body = caldav.build_copy_ics(uid, *fields, self.ledger.now())
        note_write(self.ledger, key, "", landed=False, wrote=fields, prior_body="", intended=body, op="create",
                   uid=uid)
        out = self.client.copy_write(uid, body, None)
        if out.kind == "ok":
            note_write(self.ledger, key, "", out.etag or "", landed=True)
            return "ok", out
        if out.kind not in ("exists", "unknown"):
            decide(self.ledger, key, landed=False)       # refused outright: nothing was made
            return "failed", out
        verdict, back = self._settle_create(key, uid, fields, lost=out.kind == "unknown")
        return verdict, (back if verdict == "ok" else out)

    def _settle_create(self, key: str, uid: str, fields: tuple, *, lost: bool) -> tuple[str, caldav.Outcome]:
        """A create not known to have landed, read again at its address: exactly as written, it's Harness's (ok);
        anything else there is someone's (theirs); absent after a lost answer (uncertain); absent after a refusal
        for something being there (failed: nothing of Harness's was made); unread ("unread": still undecided)."""
        back, got = self.client.fetch(self.client.href_for(uid))
        if back.kind == "ok" and got and content_is(got, uid, *fields):
            settle(self.ledger, key, back.etag or "", True)
            return "ok", caldav.Outcome("ok", back.status, back.etag)
        if back.kind == "ok" and got:
            settle(self.ledger, key, back.etag or "", False)
            return "theirs", back
        if back.kind == "gone" and not lost:
            decide(self.ledger, key, landed=False)
            return "failed", back
        if back.kind == "gone":
            d = version(self.ledger, key)
            if isinstance(d.get("pending"), dict):
                d["pending"].update(landed=True, outcome="uncertain")
                _set_version(self.ledger, key, d)
            return "uncertain", back
        return "unread", back

    def _uncertain(self, key: str, want: Want, uid: str) -> None:
        """A create that may or may not have happened: its record kept as "uncertain" (never made again by itself, and
        not followed until it turns up as written), and said once in the digest."""
        self._insert(key, want, uid, "", hand=0)
        row = self.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (key,)).fetchone()
        self._set(row, "uncertain")
        self._event_for(UNCERTAIN, row)
        log.warning("family copy: a %s copy's create answered nothing and it isn't there: left absent", want.word)

    def _uncertain_found(self, family: caldav.Read) -> None:
        """An uncertain create that turned up after all, exactly as written: Harness's own, followed from now."""
        by_uid = {i.occ.uid: i for i in family.items}
        for row in self.ledger.db.execute("SELECT * FROM family_copies WHERE state='uncertain'").fetchall():
            item = by_uid.get(row["uid"])
            if item is None:
                continue
            fields = (row["title"], self._when(row["start"]), self._when(row["end"]))
            own = content_is(item.data, row["uid"], *fields)
            settle(self.ledger, row["key"], item.etag, own)
            if own:
                set_baseline(self.ledger, row["key"], fields)
                self._update(row, state="live", missing=0)
                log.info("family copy: an uncertain %s copy turned up as written: followed", row["word"])
            else:
                self._update(row, state="hands_off")
                self._note(row, "changed", caldav.copy_differences(item.data, row["uid"], *fields))

    def _pending_create(self, key: str) -> dict | None:
        """A create of this copy whose outcome was never decided (cut off before its answer, or its read again
        failed): settled before anything is sent again."""
        state, pending = pending_state(self.ledger, key)
        if state == "ok" and pending.get("op") == "create" and pending.get("uid"):
            return pending
        return None

    def _gmail_now(self, row, want: Want) -> tuple[Want | None, str, str]:
        """The copy's Gmail event read again by its own id right before the Family write (round 4): (the want with
        the times that read gives, "", the event's revision) when it's there; (None, "", "") when Google says it was
        deleted (only 410 Gone or the event answered as cancelled, google_cal.look_by_id), which the sync's own reads
        then take off as cancelled; (None, a problem line, "") when the read can't say, or answers for another day
        or another series than the copy's (round 5). With no Google key, or for a trip (made of several events),
        the feed's read is all there is."""
        if not self._looks(row, want):
            return want, "", ""
        kind, e = self._look(row)
        if kind == "deleted":
            log.info("family copy: a %s copy's Gmail event is gone at the read before the write", row["word"])
            return None, "", ""
        occ = self._source_occurrence(row, e) if kind == "ok" else None
        if occ is None:
            return None, ("Copies from Gmail: I couldn't read a Gmail event again just before changing its Family "
                          "copy, so I left that copy for now. I'll try again at the next read."), ""
        rev = str(e.get("etag") or "")
        if _same(occ.start, want.start) and _same(occ.end, want.end):
            return want, "", rev
        log.info("family copy: a %s copy's Gmail event moved since the feed's read: its newer times are used",
                 row["word"])
        return replace(want, start=occ.start, end=occ.end), "", rev

    def _looks(self, row, want: Want | None = None) -> bool:
        google = self.google
        if google is None or (want is not None and want.word == TRIP) or row["word"] == TRIP \
                or not getattr(google, "configured", lambda: True)():
            return False
        return bool((self.address_fn() if self.address_fn else "") and source_of(self.ledger, row["key"]))

    def _look(self, row) -> tuple[str, dict | None]:
        """The copy's Gmail event by the API id its feed item maps to (google_id: the series id and, for one day of
        a series, that day's original start, moved or not). Google answering "not found" is counted per copy, and
        several reads in a row of it are said in the digest (round 5)."""
        address = (self.address_fn() if self.address_fn else "") or ""
        ident = source_of(self.ledger, row["key"])
        if not address or ident is None:
            return "unknown", None
        try:
            kind, e = self.google.look_by_id(address, google_id(*ident))
        except Exception as x:                    # a look is a help, never a stop
            log.warning("family copy: its Gmail event couldn't be read again: %s", type(x).__name__)
            return "unknown", None
        self._count_missing(row, kind == "missing")
        return kind, e

    def _count_missing(self, row, missing: bool) -> None:
        key = MISSING + row["key"]
        n = int(self.ledger.get_meta(key) or 0) if missing else 0
        if not missing and not self.ledger.get_meta(key):
            return
        with self.ledger.tx() as db:
            if missing:
                self.ledger.set_meta(key, str(n + 1), db)
            else:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
        if missing and n + 1 == MISSING_404S:
            with self.ledger.tx() as db:
                self.ledger.event("family_copy_not_found", {"key": row["key"], "word": row["word"],
                                                           "start": row["start"]}, db=db)

    def _source_occurrence(self, row, e) -> ical.Occurrence | None:
        """The event Google answered, only if it is the copy's own (round 5): the same series, and for one day of a
        series, that series by recurringEventId and that day by its original start, wherever the day has moved.
        Anything else, another series or another day, is None: no write."""
        ident = source_of(self.ledger, row["key"])
        if not isinstance(e, dict) or ident is None or not source_matches(e, *ident):
            return None
        from . import google_cal                  # here: google_cal is a heavy import the copy's tests don't need
        try:
            occ = google_cal._occurrence(e, (self.address_fn() if self.address_fn else "") or "", "")
        except (KeyError, ValueError, TypeError, AttributeError):
            return None
        return occ if occ is not None and _key(occ) == row["key"] else None

    def _judge_again(self, row, *, sent_over: str = "", lost: bool = False) -> tuple[str, str, str]:
        """The copy read again by its address after a conflict or a lost answer, judged by the allowlist against
        the write's own saved record (round 5: a record missing or damaged is "record", never guessed at):
        ("landed", its version, body) when it holds exactly what was written; ("ours", ...) when it holds exactly
        what Harness had there before the write and either the write was refused (only its version moved on) or,
        after a lost answer, it's still the version the write went over (the write didn't land); ("theirs", ...)
        for anything else, an addition or a new version holding Harness's earlier content (someone putting it
        back, round 3); or ("gone" | "unread", "", "")."""
        back, body = self.client.fetch(self.client.href_for(row["uid"]))
        if back.kind == "gone":
            return "gone", "", ""
        if back.kind != "ok" or not body or not back.etag:
            return "unread", "", ""
        state, pending = pending_state(self.ledger, row["key"])
        wrote = pending_fields(pending, "wrote") if state == "ok" else None
        before = pending_fields(pending, "before") if state == "ok" else None
        if wrote is None or before is None:
            return "record", back.etag, body
        uid = row["uid"]
        if content_is(body, uid, *wrote):
            return "landed", back.etag, body
        if content_is(body, uid, *before) and (not lost or (sent_over and back.etag == sent_over)):
            return "ours", back.etag, body
        return "theirs", back.etag, body

    def _moved(self, row, uid: str, want: Want) -> None:
        """The copy known to hold exactly this, as Harness wrote it: its record and its baseline (round 5)."""
        self._update(row, uid=uid, hand=0, href="", seen="", title=want.title,
                     start=_text(want.start), end=_text(want.end), missing=0)
        set_baseline(self.ledger, row["key"], (want.title, want.start, want.end))
        self._log("family_copy_moved", row["key"])
        self.writes += 1

    # -- what's new ----------------------------------------------------------------------
    def _add_new(self, wants: dict, sources: dict, family: list, name: str) -> str:
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
            if suppressed(self.ledger, key) is not None:
                continue                       # he approved its removal, or someone took it off: never made again
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
            if (cut := self._pending_create(key)) is not None:
                # A create of it never decided (Harness stopped before its answer, or the read again failed): read at
                # its address first, never sent again blind (round 3 of the second review).
                uid = cut["uid"]
                was = pending_fields(cut, "wrote") or (want.title, want.start, want.end)
                verdict, out = self._settle_create(key, uid, was, lost=True)
                if verdict == "unread":
                    continue
                if verdict == "ok":
                    want = replace(want, title=was[0], start=was[1], end=was[2])
            else:
                if key in getattr(self, "_occ_by_key", {}):
                    remember_source(self.ledger, key, self._occ_by_key[key])   # so the write can be checked after
                if self._looks_key(key, want):
                    queue(self.ledger, key, "check")       # saved before the create: checked after it, even cut off
                verdict, out = self._create(key, uid, want)
            if verdict == "uncertain":
                self._uncertain(key, want, uid)
                unqueue(self.ledger, key)
                continue
            if verdict == "unread":
                return self._write_problem(caldav.Outcome("unknown"))
            if verdict != "ok":
                unqueue(self.ledger, key)
            if verdict == "theirs":
                # Something is at the copy's own address that isn't Harness's copy as written: someone's.
                self._insert(key, want, uid, "", hand=0)
                self._leave(self.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (key,)).fetchone(),
                            "changed")
                continue
            if verdict != "ok":
                return self._write_problem(out)
            self._insert(key, want, uid, "", hand=0)
            set_baseline(self.ledger, key, (want.title, want.start, want.end))
            self._log("family_copy_added", key)
            self.writes += 1
            self._verify(self.ledger.db.execute("SELECT * FROM family_copies WHERE key=?", (key,)).fetchone(),
                         want, "")
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

    def _leave(self, row, why: str, *, lines: list[str] | None = None) -> None:
        """No longer followed. Never silently: a copy left behind is a wrong calendar. `lines`: the names of what
        differs from what Harness wrote (never what they say), so many alike at once can be told as a server change."""
        self._set(row, "hands_off")
        self._note(row, why, lines)
        left = getattr(self, "left_now", None)
        if left is not None:
            left.append((row["key"], tuple(lines or ())))

    def _note(self, row, why: str, lines: list[str] | None = None) -> None:
        log.warning("family copy: %s copy of %s not followed (%s%s)", row["word"], row["start"][:10], why,
                    f": {','.join(lines)}" if lines else "")
        detail = {"key": row["key"], "word": row["word"], "start": row["start"], "why": why}
        if lines:
            detail["lines"] = [x for x in lines if re.fullmatch(r"[A-Z0-9-]{1,40}", x)][:12]
        with self.ledger.tx() as db:
            self.ledger.event("family_copy_left_alone", detail, db=db)

    def _loud(self) -> None:
        """Round 5: more than LOUD_AFTER copies going hands-off in one read, or the same line no person's edit
        explains turning up on several, is said once, as a likely change in how iCloud keeps events, not as edits."""
        left = getattr(self, "left_now", None) or []
        if not left:
            return
        unknown: dict[str, int] = {}
        for _, lines in left:
            for name in set(lines) - KNOWN_EDITS:
                unknown[name] = unknown.get(name, 0) + 1
        repeated = sorted(n for n, k in unknown.items() if k >= 2)
        if len(left) <= LOUD_AFTER and not repeated:
            return
        with self.ledger.tx() as db:
            self.ledger.event(SERVER_CHANGE, {"n": len(left), "lines": repeated[:6]}, db=db)

    def _left_alone(self, since: str) -> str:
        """Which ones, each by name and why, in fixed words: a fact, nothing for him to go and do."""
        said: list[str] = []
        yours: list[str] = []
        named = set()
        more = 0
        for r in self.ledger.db.execute("SELECT detail FROM events WHERE kind='family_copy_left_alone'"
                                        " AND at>=?", (since,)):
            try:
                d = json.loads(r["detail"])
                day = _first_day(self._when(d["start"]), ZoneInfo(self.tz))
                text = f"{d['word']} {day:%b} {day.day} ({_WHY[d['why']]})"
                if d["key"] in named:
                    continue               # given up on again after a retry: once is enough
                named.add(d["key"])
            except (ValueError, KeyError, TypeError, AttributeError):
                more += 1                  # an odd record mustn't cost the morning's digest
                continue
            (yours if d["why"] in YOURS else said).append(text)   # every one by name, never "and N more"
        if more:
            said.append(f"{more} whose record couldn't be read")
        lines = []
        if yours:
            # Told once, in one line: someone changed it on Family, so it's his to keep (round 4).
            lines.append("Left alone, yours to keep now: " + ", ".join(yours) + ". I won't change those copies again.")
        if said:
            lines.append("Left alone, no longer kept in step: " + ", ".join(said) + ".")
        return " ".join(lines)

    def _revive(self, family: caldav.Read, now: datetime, until: datetime) -> None:
        """Once, on the update that stopped leaving copies behind by mistake: any it gave up
        on that's still exactly as it left it goes back to being followed. Needs a whole read,
        since it only gets the one try. One whose day has passed is finished, so if its event
        moved on, that gets a new copy. One the list leaves out gets a few reads to turn up, and
        any it can't follow after that is named once, so none stays stale unsaid."""
        if self.ledger.get_meta(REVIVED) or not family.items or family.unreadable:
            return
        unseen = False
        gone: set[str] = set(json.loads(self.ledger.get_meta(REVIVE_GONE) or "[]"))
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
            if row["key"] in gone:
                continue
            path = caldav.href_path(row["href"])
            item = items.get(path) if row["hand"] else by_uid.get(row["uid"])
            if item is None:
                if not row["hand"] and self._moment(start) < until and self.client.missing([row["uid"]]) == 1:
                    # Last seen as Harness's own and gone now: someone took it off. Said once, never made again
                    # by itself, and not waited on (round 5).
                    gone.add(row["key"])
                    suppress(self.ledger, row["key"], "household")
                    self._note(row, "gone")
                    continue
                unseen = unseen or self._moment(start) < until
                continue
            claim = path if row["hand"] else row["uid"]
            if claim in held:
                continue
            base = None if row["hand"] else (baseline(self.ledger, row["key"], row) or (row["title"], start, end))
            if _still_seen(row, item) if row["hand"] else content_is(item.data, row["uid"], *base):
                self._update(row, state="live", missing=0)
                held.add(claim)
                log.info("family copy: following a %s copy again", row["word"])
        tries = int(self.ledger.get_meta(REVIVE_TRIES) or 0) + 1
        with self.ledger.tx() as db:
            self.ledger.set_meta(REVIVE_TRIES, str(tries), db)
            self.ledger.set_meta(REVIVE_GONE, json.dumps(sorted(gone)), db)
        if unseen and tries < HOLD_READS:
            return
        for row in self.ledger.db.execute(
                "SELECT * FROM family_copies WHERE state='hands_off'").fetchall():
            if row["key"] not in gone:
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
