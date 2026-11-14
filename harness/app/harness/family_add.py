"""Adding an event to the Family calendar: the only write to a family calendar.

Off until his tap on a bound card turns it on. That setting is its own: it
does not move the stage, and no other effect looks at it.

    his message -> a model's typed proposal -> a card from plain code
                -> his tap (approvals) -> this module -> caldav -> a read of the event
                -> a receipt

Everything here runs on the controller's thread, after the tick's commands,
so a /stop in the same batch as a tap wins. A write is recorded as "sending"
before the request and its result after it, so a crash in between is never
silent. "Added" is said only once a read of the event by its uid finds it there: as written is the
usual receipt, and reading differently is said as that. Another event at its address, under
another id, isn't the add: said plainly, with no Undo.

An outcome no answer settled (a lost answer, a server error, a restart mid-request), or a read
after the write that doesn't find it, is settled by reading the event by its uid, never handed to
him (org rule R-004): there is the usual receipt; not there is written once more, if nothing
stands in the way, at the same address and only where nothing is, so it can never be two events,
and not there after that is said plainly. A read that can't tell is read again each minute for
the first hour, every 15 minutes until a day has passed, then hourly; it's said once after an
hour as not confirmed yet, told once it's known, and once the event is over or a week has passed,
said once as not confirmed and read no more, with its Undo when iCloud answered the write with a
version. The first read of a write whose answer was lost comes a minute after it was sent, so a
late write shows before any second one. An undo cut short the same way is settled by the same
read: gone is undone, and still there as written is deleted once more, at most. No answer there,
iCloud out of reach or a server error, is read again, and so is a refusal before anything is said
of it: gone is undone, still there is said with Undo again. While stopped, nothing here is read,
written or said: it waits for Turn back on.

Plain code checks every proposal. An impossible one (over 24 hours, over a year
ahead, or text the card couldn't show exactly) is refused in words. Anything
else doubtful puts a warning on the card, and an add never skips the tap with
a warning on it.

Plain code also counts the bake-in (org rule R-002). When 10 adds and 14 days
are both reached with no undo, no failed write and no unknown write, one card
asks him, with the whole record, whether to stop checking each add. Only that
tap loosens anything, and it changes one thing: adds skip the Approve tap. The
receipt, the Undo button and /stop stay. Nothing else loosens.

The count and that authority are held only for the policy, the model and the
credentials they were earned on. Any of those changing restarts the count and
voids an open card. That, an undo, a failed or unknown write, an add with no Undo,
a reset or /checkadds brings the tap back, and only a fresh full count can ask
again. A tapless add is checked once more just before its write, so one already
queued is refused if the tap has come back. His tap on the card re-reads the record
first: if it changed, or can't be read, nothing loosens.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from . import approvals, caldav, choices, commands, effects, ical, policy, render, rules
from .canonical import canonical_hash
from .ledger import TERMINAL, Ledger, iso

ENABLED = "family_add_enabled"
LOOSENED = "family_add_loosened"
PASTED_UNTIL = "family_add_pasted_until"
BAKE = "family_add_bake"
PROBLEM = "family_add_problem"
CREDS = "family_add_creds"
MANAGED = (ENABLED, LOOSENED, BAKE, PROBLEM, CREDS)

BAKE_ADDS = 10
BAKE_DAYS = 14
ENABLE_TTL_S = 15 * 60
UNDO_TTL_S = 7 * 24 * 3600
ASK_TTL_S = 3 * 24 * 3600
ASK_AGAIN_AFTER = timedelta(days=7)   # an ignored card, at most this often
MAX_DURATION = timedelta(hours=24)
MAX_TAPLESS_PER_DAY = 5
RECHECK_EVERY = timedelta(hours=1)    # a bake-in check that couldn't complete
# A read that couldn't tell is read again: each minute for the first hour, every 15 minutes until
# a day has passed, then hourly (calendar_change.py keeps the same schedule). Once the event is
# over, or a week has passed, it's said once as not confirmed, and read no more.
READ_AGAIN = timedelta(minutes=1)
READ_LATER = timedelta(minutes=15)
READ_SLOW = timedelta(hours=1)
GIVE_UP_AFTER = timedelta(days=7)
MAX_READS_PER_PASS = 10               # adds read in one pass, oldest first; it counts rows, not requests
STILL_CHECKING_AFTER = timedelta(hours=1)   # reads that can't tell, this long and this many, are
STILL_CHECKING_PASSES = 3                   # said once as not confirmed yet

# What the thread is told when a write did not end in a success. A lost answer isn't here:
# a read settles it (_settle).
FAILED_WORDS = {
    "exists": ("<b>Not added.</b> iCloud says an event with this id is already there, so I "
               "didn't write a second one."),
    "auth": ("<b>Not added: iCloud rejected the password.</b> Make a new app-specific "
             "password and enter it on the Harness page."),
    "mismatch": ("<b>Not added: name mismatch.</b> The saved address isn't the calendar named "
                 "Family, so I refused to write to it. The address on the Harness page needs to "
                 "be the Family calendar's."),
    "no_credentials": ("<b>Not added.</b> The Apple ID, app-specific password or calendar "
                       "address isn't set on the Harness page."),
    "failed": "<b>Not added.</b> {detail} Nothing was changed.",
}
# The standing line for the digest and /status. Our words only, never a server's.
PROBLEM_WORDS = {
    "unknown": "Family calendar: the last write isn't confirmed yet; I'm still checking",
    "undo_unknown": "Family calendar: the last undo isn't confirmed yet; I'm still checking",
    "exists": "Family calendar: the last add found an event already there",
    "auth": "Family calendar: iCloud rejected the password",
    "mismatch": "Family calendar: name mismatch, the saved address isn't Family",
    "no_credentials": "Family calendar: credentials aren't set",
    "failed": "Family calendar: the last write failed",
    "unconfirmed": "Family calendar: reads couldn't tell whether the last add went in",
    "undo_unconfirmed": "Family calendar: reads couldn't tell whether the last undo went through",
    "not_ours": "Family calendar: the last add found another event at its place",
}


UNDONE = "<b>Undone.</b> That event is off the Family calendar."
CHANGED = ("<b>Not undone.</b> The event changed since I wrote it, so someone may have edited it. "
           "I left it alone.")
STOPPED_UNDO = "I'm stopped, so I didn't undo that. It comes back as its own card after you turn me back on."
NOT_ADDED = "<b>Not added.</b> That didn't go through, so nothing was added."
NOT_OURS = ("<b>Not added.</b> Another event is at its place on the Family calendar, not the one I wrote, "
            "so I left it alone.")


def _settling(row) -> dict:
    """How the reads that settle an outcome are going (settle_json)."""
    try:
        return json.loads(row["settle_json"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        return {}


def read_gap(since: str | None, read_at: str) -> timedelta:
    """How long after a read that couldn't tell the next one comes: each minute for the first
    hour, every 15 minutes until a day has passed, then hourly."""
    if not since:
        return READ_AGAIN
    waited = datetime.fromisoformat(read_at) - datetime.fromisoformat(since)
    return READ_AGAIN if waited < timedelta(hours=1) else READ_LATER if waited < timedelta(days=1) else READ_SLOW


def read_due(state: dict, now: datetime) -> bool:
    at = state.get("read_at")
    return not at or datetime.fromisoformat(at) + read_gap(state.get("since"), at) <= now


def gave_up(since: str | None, over_at: datetime | None, now: datetime) -> str:
    """Reads that couldn't tell stop: "over" once the event is over, "week" once a week has passed
    since they began; "" while they go on."""
    if over_at is not None and over_at <= now:
        return "over"
    if since and now - datetime.fromisoformat(since) >= GIVE_UP_AFTER:
        return "week"
    return ""


GAVE_UP_WORDS = {"over": "it's over now", "week": "a week has passed"}


_due = read_due


def _detail(out: caldav.Outcome) -> str:
    """What iCloud said, in words: never its code (the code stays in the record)."""
    if not out.status:
        return "I couldn't reach iCloud."
    return "iCloud had a server error." if out.status >= 500 else "iCloud turned it down."


def _turned_down(out: caldav.Outcome) -> bool:
    """An answer that turns a request down: the password, the address, credentials not set, or a
    4xx. No answer, iCloud out of reach or a server error says nothing about the event."""
    return out.kind in ("auth", "no_credentials", "mismatch") or (
        out.kind == "failed" and out.status is not None and 400 <= out.status < 500)


def _still_there(out: caldav.Outcome) -> str:
    """An undo iCloud turned down, read afterwards and found still there as written: why, and where
    it is. Never "Nothing was changed": only the read says what stands."""
    words = FAILED_WORDS.get(out.kind, FAILED_WORDS["failed"]).format(detail=_detail(out))
    return words.replace("Not added", "Not undone").replace(" Nothing was changed.", "") + \
        " It's still on the Family calendar."


def _said(value: str) -> str:
    """Text as a calendar may hand it back: unescaped, its spaces and line breaks run together."""
    return " ".join(ical.unescape(value or "").split())


def _as_written(ics: str, uid: str, params: dict) -> bool:
    """A read of the event finds what was written: one plain event of ours (its uid and our
    marker, strictly), starting and ending at the same instants however the zone is written, with
    its title and place as iCloud may hand them back (escapes and spacing aside; a place may come
    back with more after it, never with less)."""
    if not ics or not caldav._is_ours(ics, uid):
        return False
    try:
        _, events = ical.parse_calendar(ics)
        ev = events[0]
        utc = ZoneInfo("UTC")
        start = ical.parse_when(ev.first("DTSTART"), utc)
        end = ical.parse_when(ev.first("DTEND"), utc)
    except (IndexError, AttributeError, ical.Unreadable):
        return False
    summary, where = ev.first("SUMMARY"), ev.first("LOCATION")
    title, place = _said(summary.value if summary else ""), _said(where.value if where else "")
    meant = _said(params.get("location") or "")
    return (isinstance(start, datetime) and isinstance(end, datetime)
            and start == datetime.fromisoformat(params["start"])
            and end == datetime.fromisoformat(params["end"])
            and title == _said(params["title"])
            and (place == meant or (bool(meant) and place.startswith(meant))))


def _one_year_after(dt: datetime) -> datetime:
    try:
        return dt.replace(year=dt.year + 1)
    except ValueError:                  # Feb 29
        return dt.replace(year=dt.year + 1, day=28)


# What pasted text carries and his own words don't. He dictates, often at length and over
# several lines (Nov 11), so length and line breaks are no sign at all: only these are.
_PASTE_SIGNS = (
    re.compile(r"(?m)^[ \t]*>"),                                      # a quoted line
    re.compile(r"```"),                                                 # a code block
    re.compile(r"(?im)^[ \t]*-*[ \t]*(?:original message|forwarded message|begin forwarded message)\b"),
    re.compile(r"(?im)^[ \t]*(?:fwd?|fw)[ \t]*:"),                       # a forward's subject
    re.compile(r"(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)"),  # a phone number
    # Words written to him, not by him: a business's reminder, a booking, a reply prompt.
    re.compile(r"(?i)\b(?:your (?:appointment|visit|reservation|booking|order|account)\b"
               r"|you(?: are|'re| have been) scheduled\b|you have an? (?:appointment|visit)\b"
               r"|please (?:arrive|call us|reply|confirm|let us know)\b|we look forward\b"
               r"|we(?:'ll| will) see you\b|reply (?:stop|yes|no|y|n|c|confirm)\b"
               r"|thank you for (?:choosing|booking|scheduling)\b|this is a (?:friendly )?reminder\b)"),
    re.compile(r"(?im)^[ \t]*dear\b"),                                  # a letter's greeting
    re.compile(r"(?im)^[ \t]*on\b[^\n]{4,160}\bwrote:[ \t]*$"),          # a reply's quote line
    re.compile(r"(?im)^[ \t]*sent from my\b"),                          # a mail app's signature
    re.compile(r"(?i)\b(?:https?://|www\.)\S"),                         # a link
    re.compile(r"(?i)\bunsubscribe\b"),                                 # a mailing's footer
)
_HEADER = re.compile(r"(?im)^[ \t]*(?:from|to|cc|bcc|sent|date|subject|reply-to)[ \t]*:[ \t]*\S")


def _looks_pasted(text: str) -> bool:
    """Real signs of text from elsewhere: a quote, an email's header lines, a forward, a link."""
    text = text or ""
    if any(sign.search(text) for sign in _PASTE_SIGNS):
        return True
    return len(_HEADER.findall(text)) >= 2


class FamilyAdd:
    def __init__(self, ledger: Ledger, client: caldav.FamilyCalDav, *, tz: str,
                 policy_version: str, model: str, creds_stamp: Callable[[], str]):
        self.ledger = ledger
        self.client = client
        self.tz = tz
        self.policy_version = policy_version
        self.model = model
        self.creds_stamp = creds_stamp
        self.chat_id: int | None = None

    def bind(self, owner: int) -> None:
        self.chat_id = owner

    # -- settings: only a tap on a bound card reaches these ------------------------
    def enabled(self) -> bool:
        return self.ledger.get_meta(ENABLED) == "1"

    def _authority(self) -> dict:
        return {"policy": self.policy_version, "model": self.model,
                "creds": self.creds_stamp()}

    def loosened(self) -> bool:
        """True only for the exact policy, model and credentials he said yes on."""
        raw = self.ledger.get_meta(LOOSENED)
        if not raw:
            return False
        try:
            return json.loads(raw) == self._authority()
        except ValueError:
            return False

    def problem(self) -> str:
        return self.ledger.get_meta(PROBLEM) or ""

    def forget(self) -> None:
        """A reset forgets the keys and the owner, so also this authority, every
        button that could bring it back, every open offer, and the record so far."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            for key in MANAGED:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
            db.execute("UPDATE choices SET consumed_at=? WHERE consumed_at IS NULL"
                       " AND kind LIKE 'family_add_%'", (now,))
            db.execute("UPDATE approvals SET consumed_at=?, outcome='reset' WHERE consumed_at"
                       " IS NULL AND proposal_id IN (SELECT id FROM proposals WHERE"
                       " effect_type=?)", (now, effects.FAMILY_ADD))
            for p in db.execute("SELECT id, job_id FROM proposals WHERE effect_type=? AND"
                                " state='proposed'", (effects.FAMILY_ADD,)).fetchall():
                db.execute("UPDATE proposals SET state='cancelled' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "cancelled", db=db,
                                       receipt=json.dumps({"reason": "reset"}))
            # Nothing waiting for a read writes again, or speaks, for whoever pairs next.
            for r in db.execute("SELECT proposal_id, job_id FROM family_adds WHERE state='settling'").fetchall():
                db.execute("UPDATE family_adds SET state='reset', settle_json='' WHERE proposal_id=?",
                           (r["proposal_id"],))
                db.execute("UPDATE proposals SET state='failed' WHERE id=?", (r["proposal_id"],))
                self.ledger.transition(r["job_id"], "failed", db=db, receipt=json.dumps({"reason": "reset"}))
            db.execute("UPDATE family_adds SET undo_state='none', settle_json='' WHERE undo_state='settling'")
            self._restart_count(db, floor=self._marks(db))

    def status_line(self) -> str:
        if not self.enabled():
            return "Family calendar adds: off"
        if self.loosened():
            return ("Family calendar adds: on, skipping the Approve tap "
                    "(receipt, Undo and /stop stay; /checkadds brings the tap back)")
        b = self._bake()
        return f"Family calendar adds: on, each needs your tap ({b['n']} since the last problem)"

    def digest_line(self) -> str:
        """Adds written but not confirmed since the last digest, each by name. And on every digest
        while adds skip the tap, so Clear can't hide it."""
        since = self.ledger.meta_time("last_digest_at")
        zone = ZoneInfo(self.tz)
        unsure = []
        for r in self.ledger.db.execute(
                "SELECT p.params_json FROM family_adds a JOIN proposals p ON p.id=a.proposal_id"
                " WHERE a.state='unconfirmed' AND a.updated_at>=? ORDER BY a.rowid", (iso(since) if since else "",)):
            params = json.loads(r["params_json"])
            start = datetime.fromisoformat(params["start"]).astimezone(zone)
            unsure.append(f"{params['title']} {start:%a %b} {start.day}")
        parts = [f"Written to the Family calendar but not confirmed by a read: {'; '.join(unsure)}."] if unsure else []
        waiting = []
        for r in self.ledger.db.execute(
                "SELECT p.params_json, a.state FROM family_adds a JOIN proposals p ON p.id=a.proposal_id"
                " WHERE a.state='settling' OR a.undo_state='settling' ORDER BY a.rowid"):
            params = json.loads(r["params_json"])
            start = datetime.fromisoformat(params["start"]).astimezone(zone)
            what = f"{params['title']} {start:%a %b} {start.day}"
            waiting.append(what if r["state"] == "settling" else f"the undo of {what}")
        if waiting:
            parts.append(f"Not confirmed yet, still checking: {'; '.join(waiting)}.")
        if self.enabled() and self.loosened():
            n = self.ledger.db.execute(
                "SELECT COUNT(*) FROM family_adds WHERE state='created' AND created_at>=?",
                (iso(since) if since else "",)).fetchone()[0]
            parts.append(f"Family calendar adds skip the Approve tap: {n} added since the last digest. "
                         "/checkadds brings the tap back.")
        return " ".join(parts)

    def check_adds(self) -> str:
        """/checkadds: plain code, at once, and only a fresh count can undo it."""
        if not self.ledger.get_meta(LOOSENED):
            if not self._bake()["asked_at"]:
                return "Every Family calendar add already needs your Approve tap. Nothing changed."
            with self.ledger.tx() as db:      # same as answering the card "keep checking"
                self._restart_count(db)
                self.ledger.event("family_add_kept", {"why": "/checkadds"}, db=db)
            return ("Every Family calendar add already needs your Approve tap, and it still does. "
                    "I've closed the question about stopping that, so that card no longer works "
                    f"and won't come back. The count starts over: {BAKE_ADDS} adds and "
                    f"{BAKE_DAYS} days before I'd ask again.")
        with self.ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (LOOSENED,))
            self._restart_count(db)
            self.ledger.event("family_add_tightened", {"why": "/checkadds"}, db=db)
        return ("<b>Done.</b> Every Family calendar add needs your Approve tap again. "
                f"Going without it takes a fresh count of {BAKE_ADDS} adds and {BAKE_DAYS} days.")

    def _setback(self, db, why: str) -> None:
        """An undo, or a failed or unknown write: the count starts over, and if
        adds were skipping the tap, the tap is back and he is told why."""
        self._restart_count(db)
        if self.ledger.get_meta(LOOSENED):
            db.execute("DELETE FROM meta WHERE key=?", (LOOSENED,))
            self.ledger.event("family_add_tightened", {"why": why}, db=db)
            self._say(db, self.chat_id, None,
                      f"<b>Family calendar adds need your Approve tap again:</b> {why}. Going "
                      f"without it takes a fresh count of {BAKE_ADDS} adds and {BAKE_DAYS} days.")

    def _check_authority(self) -> None:
        """Credentials, policy or model changed: what was earned on them ends."""
        stamp, seen = self.creds_stamp(), self.ledger.get_meta(CREDS)
        if stamp != seen:
            with self.ledger.tx() as db:
                self.ledger.set_meta(CREDS, stamp, db)
                if seen is not None:
                    self._setback(db, "the Family calendar address, Apple ID or password changed")
        earned_on = self._bake().get("on")
        if (self.ledger.get_meta(LOOSENED) and not self.loosened()) \
                or (earned_on and earned_on != self._earning()):
            with self.ledger.tx() as db:
                self._setback(db, "the policy or the model changed since this was earned")
        if self.ledger.get_meta(LOOSENED) and rules.legacy_waiting(self.ledger):
            with self.ledger.tx() as db:
                self._setback(db, "a standing rule saved before this update never had your tap")

    # -- the bake-in count -----------------------------------------------------------
    def _bake(self) -> dict:
        raw = self.ledger.get_meta(BAKE)
        return json.loads(raw) if raw else {"n": 0, "first": None, "epoch": None,
                                            "asked_at": None, "marks": [0, 0, 0],
                                            "floor": [0, 0, 0], "on": None}

    def _earning(self) -> dict:
        return {"policy": self.policy_version, "model": self.model}

    def _count_add(self, db) -> None:
        b = self._bake()
        b["n"] += 1
        b["first"] = b["first"] or iso(self.ledger.now())
        b["epoch"] = b["epoch"] or secrets.token_hex(8)
        b["on"] = b["on"] or self._earning()
        self.ledger.set_meta(BAKE, json.dumps(b), db)

    def _restart_count(self, db, floor: list[int] | None = None) -> None:
        # Random, so a card from any earlier count, even before a reset, can
        # never match this one.
        self.ledger.set_meta(BAKE, json.dumps(
            {"n": 0, "first": None, "epoch": secrets.token_hex(8), "asked_at": None,
             "marks": self._marks(db), "floor": floor or self._bake()["floor"],
             "on": self._earning()}), db)

    @staticmethod
    def _marks(db) -> list[int]:
        """Where this count begins, as row numbers: no clock can tie or reorder them."""
        return [db.execute("SELECT COALESCE(MAX(rowid), 0) FROM proposals").fetchone()[0],
                db.execute("SELECT COALESCE(MAX(rowid), 0) FROM family_adds").fetchone()[0],
                db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]]

    def _tally(self, marks: list[int]) -> dict:
        db = self.ledger.db
        states = dict(db.execute(
            "SELECT state, COUNT(*) FROM proposals WHERE effect_type=? AND rowid>?"
            " GROUP BY state", (effects.FAMILY_ADD, marks[0])).fetchall())

        def adds(where: str) -> int:
            return db.execute(f"SELECT COUNT(*) FROM family_adds WHERE ({where})"
                              " AND rowid>?", (marks[1],)).fetchone()[0]

        def events(kind: str) -> int:
            return db.execute("SELECT COUNT(*) FROM events WHERE kind=? AND id>?",
                              (kind, marks[2])).fetchone()[0]
        return {"declined": states.get("declined", 0), "expired": states.get("expired", 0),
                "cancelled": states.get("cancelled", 0),
                "refused": states.get("refused", 0) + events("family_add_refused"),
                "warned": events("family_add_warned"),
                "undone": adds("undo_state='undone'"),
                "failed": adds("state NOT IN ('created','written','sending','unknown','unconfirmed','settling')"),
                "unknown": adds("state IN ('unknown','unconfirmed','settling') OR undo_state IN ('unknown','settling')")}

    def _record(self, b: dict, days: int, missing: int) -> str:
        first = datetime.fromisoformat(b["first"]).astimezone(ZoneInfo(self.tz))
        now, ever = self._tally(b["marks"]), self._tally(b["floor"])

        def counts(t: dict) -> str:
            return (f"{t['declined']} declined, {t['expired']} expired, {t['cancelled']} "
                    f"cancelled, {t['refused']} refused, {t['undone']} undone, {t['failed']} "
                    f"failed, {t['unknown']} unknown, {t['warned']} shown with a warning")
        lines = [f"The record since {first:%b} {first.day} ({days} days): {b['n']} approved and "
                 f"added, {counts(now)}.",
                 f"Checked just now: {missing} of those {b['n']} added are no longer on the "
                 "calendar."]
        earlier = {k: ever[k] - now[k] for k in ever}
        if any(earlier.values()):
            lines.append(f"Before this count: {counts(earlier)}.")
        return "\n".join(lines)

    def _counted_uids(self, b: dict) -> list[str]:
        return [r["uid"] for r in self.ledger.db.execute(
            "SELECT uid FROM family_adds WHERE state IN ('created','written','unconfirmed') AND rowid>?",
            (b["marks"][1],))]

    def _snapshot(self, b: dict, missing: int) -> dict:
        """What a card says, to compare with the truth when he taps it."""
        return {"n": b["n"], "tally": self._tally(b["marks"]), "missing": missing}

    def _maybe_ask(self, *, held: bool) -> None:
        b = self._bake()
        if not self.enabled() or self.loosened() or b["n"] < BAKE_ADDS or not b["first"]:
            return
        first = datetime.fromisoformat(b["first"])
        now = self.ledger.now()
        days = (now - first).days
        if days < BAKE_DAYS:
            return
        if rules.blocking(self.ledger):
            if not b.get("rules_told"):
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps({**b, "rules_told": True}), db)
                    self.ledger.enqueue(
                        chat_id=self.chat_id, kind="notice", held=held, db=db,
                        text=("<b>Stop checking each Family calendar add?</b> That's due, but I "
                              "won't offer it yet: a standing rule is still waiting for your tap. "
                              "/rule lists them. Keep or drop each one on its card, and I'll "
                              "send this with the record."))
            return
        if b["asked_at"] and now - datetime.fromisoformat(b["asked_at"]) < ASK_AGAIN_AFTER:
            return
        tried = b.get("tried")
        if tried and now - datetime.fromisoformat(tried) < RECHECK_EVERY:
            return
        missing = self.client.missing(self._counted_uids(b))
        if missing is None:
            with self.ledger.tx() as db:
                said = b.get("told")
                self.ledger.set_meta(BAKE, json.dumps({**b, "tried": iso(now), "told": True}), db)
                if not said:
                    self.ledger.enqueue(
                        chat_id=self.chat_id, kind="notice", held=held, db=db,
                        text=("The Family calendar record is due for your review, but I couldn't "
                              "read the calendar to complete it, so I'm not offering any change "
                              "yet. I'll keep trying."))
            return
        self._send_card(b, days, missing, held=held)

    def _send_card(self, b: dict, days: int, missing: int, *, held: bool) -> None:
        record = self._record(b, days, missing)
        now = self.ledger.now()
        with self.ledger.tx() as db:
            target = b["epoch"]
            yes = choices.mint(self.ledger, kind="family_add_loosen", target=target,
                               chat_id=self.chat_id, ttl_s=ASK_TTL_S, db=db)
            no = choices.mint(self.ledger, kind="family_add_keep", target=target,
                              chat_id=self.chat_id, ttl_s=ASK_TTL_S, db=db)
            self.ledger.set_meta(BAKE, json.dumps({**b, "asked_at": iso(now),
                                                   "shown": self._snapshot(b, missing)}), db)
            self.ledger.event("family_add_asked", {"adds": b["n"], "days": days,
                                                   "missing": missing}, db=db)
            self.ledger.enqueue(
                chat_id=self.chat_id, kind="card", held=held,
                text=(f"<b>Stop checking each Family calendar add?</b>\n{record}\n"
                      "Every standing rule in use has your tap.\n"
                      "Adds alert family phones that have notifications on for the Family "
                      "calendar. Without the Approve tap, that alert can arrive with nothing "
                      "approved first.\n"
                      "<b>Were any of these adds wrong?</b>\n"
                      "If none were, you can say yes: an add then goes straight to the Family "
                      "calendar without the Approve tap, unless a check finds something off. You "
                      "still get a receipt you can undo, and /stop still works, though undoing can't "
                      "recall an alert already delivered. Nothing else changes: "
                      "edits, deletes and messages to people still need your go. Only your tap "
                      "changes this."),
                buttons=[[("None wrong: stop checking", choices.callback_data(yes))],
                         [("Something was off: keep checking", choices.callback_data(no))]],
                binds=[{"type": "choice", "nonce": yes}, {"type": "choice", "nonce": no}],
                db=db)

    # -- what plain code checks on every proposal ---------------------------------------
    def _impossible(self, params: dict) -> str | None:
        """Words for what is refused outright, with or without a tap."""
        start = datetime.fromisoformat(params["start"])
        if datetime.fromisoformat(params["end"]) - start > MAX_DURATION:
            return "it would run longer than 24 hours"
        if start > _one_year_after(self.ledger.now()):
            return "it starts more than a year from now"
        for text in (params["title"], params.get("location", "")):
            if render.has_link(text):
                return ("the title or location has a link or web address in it, and I don't "
                        "put those on the family calendar")
        return None

    def warnings(self, params: dict, *, message: str = "", replied: bool = False) -> list[str]:
        """What goes on the card. With any of these, an add never skips the tap."""
        out = []
        local = ZoneInfo(self.tz)
        for key in ("start", "end"):
            dt = datetime.fromisoformat(params[key])
            if dt.utcoffset() != dt.astimezone(local).utcoffset():
                out.append(f"the {key} was written with a different UTC offset than your zone "
                           "has at that moment, so the time shown may not be what you meant.")
        if any(render.maybe_host(params.get(key, "")) for key in ("title", "location")):
            out.append("the title or location has a word.word, a word:word or a phone number in "
                       "it. If that's an address, it may show as a link on family phones.")
        loose = self.loosened()
        if self._is_duplicate(params, any_title=loose):
            out.append("this looks like a duplicate: another add has the same start"
                       + ("." if loose else " and title."))
        if loose and self._tapless_today() >= MAX_TAPLESS_PER_DAY:
            out.append(f"{MAX_TAPLESS_PER_DAY} adds have already gone in without a tap today.")
        if loose and (_looks_pasted(message) or self._pasted_recently()):
            out.append("your message or a recent one may be pasted text: it has a quoted line, an "
                       "email's header lines, a forward, a link, a phone number or words written to you.")
        elif loose and replied:
            out.append("it's a reply, and the message you replied to may be pasted text.")
        return out

    def note_message(self, text: str) -> None:
        """Each message, before the model reads it. A paste stays in the conversation
        through the model's own replies, so every message in its window extends it. In
        the ledger, so a restart can't lose it."""
        if _looks_pasted(text) or self._pasted_recently():
            until = self.ledger.now() + timedelta(seconds=policy.CONTEXT_WINDOW_S)
            self.ledger.set_meta(PASTED_UNTIL, iso(until))

    def _pasted_recently(self) -> bool:
        until = self.ledger.get_meta(PASTED_UNTIL)
        return bool(until) and datetime.fromisoformat(until) > self.ledger.now()

    def note_warned(self, proposal_id: str, db) -> None:
        self.ledger.event("family_add_warned", {"proposal": proposal_id}, db=db)

    def _is_duplicate(self, params: dict, *, any_title: bool = False) -> bool:
        title = params["title"].strip().casefold()
        start = datetime.fromisoformat(params["start"])
        for r in self.ledger.db.execute(
                "SELECT p.params_json FROM proposals p"
                " LEFT JOIN family_adds a ON a.proposal_id=p.id"
                " WHERE p.effect_type=? AND (p.state IN ('proposed','approved',"
                "'auto_approved','executing',"
                "'executed') OR a.state IN ('unknown','settling'))"
                " AND COALESCE(a.undo_state,'none') NOT IN ('undone','gone')",
                (effects.FAMILY_ADD,)):
            other = json.loads(r["params_json"])
            if datetime.fromisoformat(other["start"]) == start \
                    and (any_title or other["title"].strip().casefold() == title):
                return True
        return False

    def _tapless_today(self) -> int:
        local = self.ledger.now().astimezone(ZoneInfo(self.tz))
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return self.ledger.db.execute(
            "SELECT COUNT(*) FROM events WHERE kind='family_add_auto' AND at>=?",
            (iso(midnight.astimezone(timezone.utc)),)).fetchone()[0]

    # -- a proposal arrives ------------------------------------------------------------
    def refuse(self, job, receipt: dict, params: dict) -> bool:
        """True when this proposal goes no further; the words are queued."""
        if commands.is_paused(self.ledger):
            with self.ledger.tx() as db:
                commands.note_stopped(self.ledger, job["id"], db)   # its card comes after /resume
                self.ledger.transition(job["id"], "cancelled", db=db,
                                       receipt=json.dumps({**receipt, "reason": "stopped"}))
                self._say(db, job["chat_id"], job["id"], "I'm stopped, so nothing was added.")
            return True
        if self.enabled():
            why = self._impossible(params)
            if not why:
                return False
            self.refuse_in_words(job, receipt, why)
            return True
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", db=db,
                                   receipt=json.dumps({**receipt, "reason": "family_add_off"}))
            if self.client.configured():
                # Bound to this message, so his tap brings its card back without a resend.
                nonce = choices.mint(self.ledger, kind="family_add_enable", target=job["id"],
                                     chat_id=job["chat_id"], ttl_s=ENABLE_TTL_S, db=db)
                self._say(db, job["chat_id"], job["id"],
                          "Adding to the Family calendar is off, so nothing was added. Turn it "
                          "on? Each add will still show you a card to approve, and each add "
                          "alerts family phones that have notifications on for this calendar.",
                          buttons=[[("Turn on", choices.callback_data(nonce))]],
                          binds=[{"type": "choice", "nonce": nonce}])
            else:
                self._say(db, job["chat_id"], job["id"],
                          "Adding to the Family calendar is off, so nothing was added. It needs "
                          "the Apple ID, an app-specific password and the calendar address on "
                          "the Harness page first.")
        return True

    def refuse_in_words(self, job, receipt: dict, why: str) -> None:
        """The checks said no. Plain words, a receipt, and a mark on the record."""
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", db=db, receipt=json.dumps(
                {**receipt, "reason": "family_add_impossible"}))
            self.ledger.event("family_add_refused", {"job": job["id"]}, db=db)
            self._say(db, job["chat_id"], job["id"], f"I didn't add that: {why}.")

    def auto_approve(self, proposal_id: str, job_id: str, db) -> bool:
        """After his tap on the bake-in card, an add needs no tap of its own.
        Nothing else can come through here."""
        row = db.execute("SELECT effect_type FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        if not self.loosened() or row["effect_type"] != effects.FAMILY_ADD:
            return False
        # Its own state: checked again just before the write (_blocked).
        db.execute("UPDATE proposals SET state='auto_approved' WHERE id=? AND state='proposed'",
                   (proposal_id,))
        self.ledger.transition(job_id, "approved", db=db)
        self.ledger.event("family_add_auto", {"proposal": proposal_id}, db=db)
        return True

    def stopped(self) -> bool:
        """Stopped, or a /stop already in from this same poll: taps run before commands."""
        return commands.is_paused(self.ledger) or self.ledger.db.execute(
            "SELECT 1 FROM jobs j JOIN job_text t ON t.job_id=j.id WHERE j.kind='command'"
            " AND j.state='received' AND LOWER(TRIM(t.text)) LIKE '/stop%' LIMIT 1"
        ).fetchone() is not None

    # -- his taps ---------------------------------------------------------------------
    def on_choice(self, kind: str, target: str) -> str:
        if kind == "family_add_enable":
            with self.ledger.tx() as db:
                self.ledger.set_meta(ENABLED, "1", db)
                self.ledger.event("family_add_enabled", {}, db=db)
                again = self._ask_again(db, target)
            return ("Adding to the Family calendar is on. Each add shows you a card to approve, "
                    "and /stop blocks it." + (" The card for your event comes next." if again else ""))
        if kind == "family_add_loosen":
            self._check_authority()
            b = self._bake()
            if not self.enabled() or target != b["epoch"]:
                return "The record changed after that card was sent, so nothing changed."
            if rules.blocking(self.ledger):
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps({**b, "asked_at": None,
                                                           "rules_told": False}), db)
                return ("A standing rule is waiting for your tap, so nothing changed and I didn't "
                        "read the calendar. Keep or drop it on its card, and I'll send a fresh "
                        "card.")
            missing = self.client.missing(self._counted_uids(b))
            if missing is None:
                with self.ledger.tx() as db:
                    self.ledger.set_meta(BAKE, json.dumps(
                        {**b, "asked_at": None, "tried": iso(self.ledger.now()), "told": True}), db)
                return ("I couldn't read the calendar just now, so nothing changed. I'll send a "
                        "fresh card when I can.")
            if b.get("shown") != self._snapshot(b, missing):
                days = (self.ledger.now() - datetime.fromisoformat(b["first"])).days
                self._send_card(b, days, missing, held=False)
                return "The record changed since that card, so nothing changed. Read the fresh card."
            with self.ledger.tx() as db:
                self.ledger.set_meta(LOOSENED, json.dumps(self._authority()), db)
                self.ledger.event("family_add_loosened", {"adds": b["n"]}, db=db)
            return ("Done. Adds to the Family calendar no longer wait for your tap, unless a "
                    "check finds something off. You still get a receipt you can undo, /stop "
                    "still blocks them, and /checkadds brings the tap back. Nothing else "
                    "changed.")
        if kind == "family_add_keep":
            if target == self._bake()["epoch"]:
                with self.ledger.tx() as db:
                    self._restart_count(db)
            return "Each add still needs your tap, and the count starts over."
        if kind == "family_add_undo":
            if self.stopped():
                # His tap waits with what he asked while stopped, and comes back as its own card.
                row = self.ledger.db.execute("SELECT * FROM family_adds WHERE proposal_id=? AND"
                                             " undo_state='open'", (target,)).fetchone()
                if row is None:
                    return "There's nothing to undo there."
                with self.ledger.tx() as db:
                    commands.note_stopped_undo(self.ledger, "family_add", target, self._undo_words(row), db)
                    self._setback(db, "you asked to undo an event")
                return STOPPED_UNDO
            with self.ledger.tx() as db:
                cur = db.execute("UPDATE family_adds SET undo_state='requested', updated_at=?"
                                 " WHERE proposal_id=? AND undo_state='open'",
                                 (iso(self.ledger.now()), target))
                if cur.rowcount != 1:
                    return "There's nothing to undo there."
                self._setback(db, "you undid an event")   # whatever happens next
            return "Undoing it now."
        return "Nothing changed."

    def undo_asked(self, target: str) -> str:
        """His Do it now on an Undo he tapped while stopped. commands has already asked for it, in
        the same transaction as the card's answer, so a restart right then can't lose it: run_pending
        carries it out, reading the event first. Here the count starts over, as at any Undo."""
        if self.stopped():
            return ""                          # a /stop came in with the tap: it waits, and says so
        with self.ledger.tx() as db:
            self._setback(db, "you undid an event")
        return "Undoing it now."

    # -- each tick ----------------------------------------------------------------------
    def run_pending(self, *, paused: bool, held: bool = False) -> None:
        self._check_authority()
        self._expire_offers()
        self._fail_orphans()
        for p in self._approved():
            self._execute(p, paused)
        if not paused:
            # Each read is a request to iCloud on this thread, so a pass reads at most
            # MAX_READS_PER_PASS rows (rows, not requests: settling one can also write it once
            # more), the longest waiting first; a read moves its add to the back. While stopped
            # nothing is read, written or said: an add's reads wait for Turn back on.
            now = self.ledger.now()
            reads = 0
            for row in self.ledger.db.execute("SELECT * FROM family_adds WHERE state='written'"
                                              " ORDER BY updated_at, rowid").fetchall():
                if reads >= MAX_READS_PER_PASS:
                    break
                if read_due(self._read_state(row), now):
                    self._read_back(row)
                    reads += 1
            # What no answer settled is read the same way (_settle), within the same allowance.
            for row in self.ledger.db.execute("SELECT * FROM family_adds WHERE state='settling'"
                                              " OR undo_state='settling' ORDER BY updated_at, rowid").fetchall():
                if reads >= MAX_READS_PER_PASS:
                    break
                if _due(_settling(row), now):
                    (self._settle if row["state"] == "settling" else self._settle_undo)(row)
                    reads += 1
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE undo_state='requested'").fetchall():
            self._undo(row, paused)
        if not paused:
            self._maybe_ask(held=held)

    def reconcile_after_restart(self) -> None:
        """Whatever a previous process left unfinished fails, loudly. An undo his tap asked for
        and the restart cut short is finished by itself (run_pending): it reads the event first."""
        self._check_authority()
        self._fail_orphans()
        for p in self._approved():
            # Never a resend ask: an interrupted job is run again by itself (runner.RETRYABLE).
            self._refused(p, "interrupted", "The harness restarted before it wrote that, so "
                                            "nothing was added.")

    def _approved(self) -> list:
        return self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state IN ('approved','auto_approved')"
            " ORDER BY created_at", (effects.FAMILY_ADD,)).fetchall()

    def _expire_offers(self) -> None:
        """An unanswered card closes, so the digest stops calling it waiting."""
        now = iso(self.ledger.now())
        rows = self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state='proposed' AND expires_at<=?",
            (effects.FAMILY_ADD, now)).fetchall()
        for p in rows:
            with self.ledger.tx() as db:
                db.execute("UPDATE proposals SET state='expired' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "expired",
                                       receipt="expired before it was approved", db=db)
                self._say(db, self.chat_id, p["job_id"],
                          "That offer expired, so nothing was added.")

    def _fail_orphans(self) -> None:
        """Writes are synchronous, so a row still "sending" here belongs to a run that died
        mid-request. The request may have landed: a read of the event by its uid settles it
        (_settle), and an undo cut short the same way (_settle_undo). The first read comes a
        minute after the request was sent, however soon the restart was, so a late write shows."""
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE state='sending'").fetchall():
            with self.ledger.tx() as db:
                self._wait_for_read(db, row, "state", sent_at=row["updated_at"])
                self._setback(db, "a write's outcome wasn't confirmed")
        for row in self.ledger.db.execute(
                "SELECT * FROM family_adds WHERE undo_state='deleting'").fetchall():
            with self.ledger.tx() as db:
                self._wait_for_read(db, row, "undo_state", sent_at=row["updated_at"])

    # -- the write ----------------------------------------------------------------------
    def _blocked(self, p, params: dict, paused: bool) -> tuple[str, str] | None:
        """Checked last thing before the request. No request has been sent, so
        none of these is a failed write."""
        if paused:
            return "stopped", "I'm stopped, so nothing was added."
        if not self.enabled():
            return "family_add_off", "Adding to the Family calendar is off, so nothing was added."
        if p["state"] == "auto_approved" and not self.loosened():
            return "tap_restored", ""          # it comes back as a card (_card_again)
        try:
            checked = effects.REGISTRY[effects.FAMILY_ADD].validate(params)
        except effects.ParamError:
            checked = None
        if checked != params or canonical_hash(params) != p["params_hash"]:
            return "changed", "That changed after you saw it, so nothing was added."
        if datetime.fromisoformat(params["start"]) <= self.ledger.now():
            return "past", "That time has already passed, so nothing was added."
        why = self._impossible(params)
        if why:
            return "impossible", f"I didn't add that: {why}."
        return None

    def _card_again(self, p, params: dict) -> None:
        """An add that was going in without a tap, when the tap came back before its write: his
        own card for it now, as if a check had found something, so nothing needs sending again.
        The card is fresh under today's policy, so his tap on it counts."""
        expires = self.ledger.now() + timedelta(seconds=effects.REGISTRY[effects.FAMILY_ADD].ttl_s)
        with self.ledger.tx() as db:
            db.execute("UPDATE proposals SET state='proposed', expires_at=?, policy_version=? WHERE id=?"
                       " AND state='auto_approved'", (iso(expires), self.policy_version, p["id"]))
            self.ledger.transition(p["job_id"], "proposed", db=db)
            nonce = approvals.mint(self.ledger, proposal_id=p["id"], owner_user_id=self.chat_id,
                                   ttl_s=effects.REGISTRY[effects.FAMILY_ADD].ttl_s, db=db)
            card = render.proposal_card(effects.REGISTRY[effects.FAMILY_ADD], params, tz=self.tz,
                                        expires=expires, job_id=p["job_id"],
                                        warnings=["the Approve tap came back before I added it."])
            self.ledger.event("family_add_card_again", {"proposal": p["id"]}, db=db)
            self.ledger.enqueue(chat_id=self.chat_id, kind="card", text=card, job_id=p["job_id"],
                                buttons=render.proposal_buttons(nonce),
                                binds=[{"type": "approval", "nonce": nonce}], db=db)
            self.ledger.release_held(db=db)

    def _refused(self, p, reason: str, words: str) -> None:
        with self.ledger.tx() as db:
            if reason == "stopped":
                commands.note_stopped(self.ledger, p["job_id"], db)   # its card comes after /resume
            db.execute("UPDATE proposals SET state='refused' WHERE id=?", (p["id"],))
            self.ledger.transition(p["job_id"], "failed", db=db,
                                   receipt=json.dumps({"reason": reason}))
            self._say(db, self.chat_id, p["job_id"], words)

    def _execute(self, p, paused: bool) -> None:
        params = json.loads(p["params_json"])
        blocked = self._blocked(p, params, paused)
        if blocked and blocked[0] == "tap_restored":
            self._card_again(p, params)
            return
        if blocked:
            self._refused(p, *blocked)
            return
        uid = caldav.uid_for(p["id"])
        now = self.ledger.now()
        with self.ledger.tx() as db:
            db.execute("INSERT INTO family_adds(proposal_id, job_id, uid, state, created_at,"
                       " updated_at) VALUES(?,?,?,?,?,?)",
                       (p["id"], p["job_id"], uid, "sending", iso(now), iso(now)))
            db.execute("UPDATE proposals SET state='executing' WHERE id=?", (p["id"],))
        out = self.client.create(uid, params, now)
        self._record_add(p, params, uid, out)

    def _record_add(self, p, params: dict, uid: str, out: caldav.Outcome) -> None:
        now = iso(self.ledger.now())
        job_id = p["job_id"]
        if out.kind == "unknown":              # the answer was lost: a read by its uid says (_settle)
            with self.ledger.tx() as db:
                row = db.execute("SELECT * FROM family_adds WHERE proposal_id=?", (p["id"],)).fetchone()
                self._wait_for_read(db, row, "state", status=out.status)
                self._setback(db, "a write's outcome wasn't confirmed")
            return
        with self.ledger.tx() as db:
            ok = out.kind == "ok"
            db.execute("UPDATE proposals SET state=? WHERE id=?",
                       ("executed" if ok else "failed", p["id"]))
            # Written isn't added yet: the receipt waits for a read of the event (_read_back).
            db.execute("UPDATE family_adds SET state=?, http_status=?, etag=?, undo_state=?,"
                       " updated_at=? WHERE proposal_id=?",
                       ("written" if ok else out.kind, out.status, out.etag,
                        "open" if ok and out.etag else "none", now, p["id"]))
            if not ok:
                self.ledger.transition(job_id, "failed", db=db, receipt=json.dumps(
                    {"reason": f"family_{out.kind}", "http_status": out.status}))
                self._setback(db, "a write failed")
                self._set_problem(db, out.kind)
                self._say(db, self.chat_id, job_id,
                          FAILED_WORDS.get(out.kind, FAILED_WORDS["failed"])
                          .format(detail=_detail(out)))
                return
            self.ledger.transition(job_id, "executed", db=db, receipt=json.dumps(
                {"effect": effects.FAMILY_ADD, "uid": uid, "http_status": out.status}))
            self._count_add(db)
            db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            if not out.etag and p["state"] == "auto_approved":
                self._setback(db, "an add went in with no Undo available")
        self._read_back(self.ledger.db.execute("SELECT * FROM family_adds WHERE proposal_id=?",
                                               (p["id"],)).fetchone())

    # -- the read after the write -------------------------------------------------------
    def _read_state(self, row) -> dict:
        """How the reads of a written add are going: since it was written, and its last read."""
        state = _settling(row)
        state.setdefault("since", row["created_at"])
        state.setdefault("read_at", row["updated_at"])
        return state

    def _read_back(self, row, seen: tuple | None = None) -> None:
        """He hears "Added" once a read of the event by its uid finds it there: ours, on the Family
        calendar, with its title, start, end and place is the usual receipt, and there but reading
        differently is said as that. Another event at its address, under another id, isn't the add:
        said plainly, with no Undo. Not there, a minute or more after it was written, is settled
        like any add no answer confirmed: written once more at the same address, only where nothing
        is, and not there after that is said plainly; while stopped, it waits instead. A read that
        can't tell is read again on the schedule (_not_yet). `seen`: a read just made, (out, ics)."""
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        params = json.loads(p["params_json"])
        out, ics = seen if seen is not None else self.client.fetch(self.client.href_for(row["uid"]))
        moment = self.ledger.now()
        state = self._read_state(row)
        if out.kind == "gone":
            blocked = self._blocked({**dict(p), "state": "approved"}, params, self.stopped())
            if moment - datetime.fromisoformat(row["created_at"]) < READ_AGAIN \
                    or (blocked is not None and blocked[0] == "stopped"):
                # A calendar can take a moment to show a write: not missing yet. Or stopped: nothing
                # is written or said until he turns it back on. Read again.
                self._read_later(row, state)
                return
            if not state.get("retried") and blocked is None:
                self._once_more(row, p, params, state)
            else:
                self._not_added(row, params, blocked)
            return
        uids = caldav._uids(ics) if out.kind == "ok" else set()
        if not uids:                           # no answer, or one with no event in it: says nothing yet
            self._not_yet(row, state, "added")
            return
        if row["uid"] not in uids:
            self._not_ours(row, params)
            return
        now = iso(moment)
        written = _as_written(ics, row["uid"], params)
        with self.ledger.tx() as db:
            cur = db.execute("SELECT state FROM family_adds WHERE proposal_id=?",
                             (row["proposal_id"],)).fetchone()
            if cur is None or cur["state"] != "written":
                return
            db.execute("UPDATE family_adds SET state='created', settle_json='', updated_at=? WHERE proposal_id=?",
                       (now, row["proposal_id"]))
            event = render.family_event_text(params, self.tz)
            text = (f"<b>Added to the Family calendar.</b>\n{event}" if written else
                    "<b>Added to the Family calendar.</b> It reads differently there now than this, "
                    f"which is what I wrote:\n{event}")
            if row["etag"]:
                buttons, binds = self._undo_button(db, row["proposal_id"])
                self._say(db, self.chat_id, row["job_id"],
                          text + "\nNothing to do if that's right; tap Undo if it's wrong.",
                          buttons=buttons, binds=binds)
            else:
                self._say(db, self.chat_id, row["job_id"], text + "\niCloud gave no version tag for "
                          "it, so I can't offer Undo safely.")

    def _once_more(self, row, p, params: dict, state: dict) -> None:
        """Not there: once more, at the same address, only where nothing is (If-None-Match), so it
        can never be two events. Recorded before it's sent, so a restart can't make it a third."""
        now = iso(self.ledger.now())
        receipted = row["state"] == "written"          # its write was answered: the job has its receipt
        state = {**state, "retried": True}
        with self.ledger.tx() as db:                   # written now: its reads start now
            db.execute("UPDATE family_adds SET state='sending', settle_json=?, created_at=?, updated_at=?"
                       " WHERE proposal_id=?", (json.dumps(state), now, now, row["proposal_id"]))
        res = self.client.create(row["uid"], params, self.ledger.now())
        sent = iso(self.ledger.now())
        if res.kind in ("unknown", "exists"):          # lost again, or the first one there after all
            state.update(since=state.get("since") or sent, read_at=sent)   # its first read a minute on
            with self.ledger.tx() as db:
                db.execute("UPDATE family_adds SET state='settling', settle_json=?, updated_at=? WHERE"
                           " proposal_id=?", (json.dumps(state), sent, row["proposal_id"]))
                self._set_problem(db, "unknown")
                self._setback(db, "a write's outcome wasn't confirmed")
            return
        if not receipted:
            self._record_add(p, params, row["uid"], res)
            return
        if res.kind != "ok":                           # turned down: still not there
            self._not_added(row, params, None)
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET state='written', http_status=?, etag=?, undo_state=?,"
                       " updated_at=? WHERE proposal_id=?",
                       (res.status, res.etag, "open" if res.etag else "none", sent, row["proposal_id"]))
        self._read_back(self.ledger.db.execute("SELECT * FROM family_adds WHERE proposal_id=?",
                                               (row["proposal_id"],)).fetchone())

    def _not_added(self, row, params: dict, blocked: tuple | None, *, state: str = "not_added",
                   words: str = NOT_ADDED, why: str = "a read didn't find it", problem: str = "failed") -> None:
        """Not there, and written once more already or not allowed to be: said plainly. Also another
        event at its address (_not_ours), with its own words."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET state=?, undo_state='none', settle_json='',"
                       " updated_at=? WHERE proposal_id=?", (state, now, row["proposal_id"]))
            db.execute("UPDATE proposals SET state='failed' WHERE id=?", (row["proposal_id"],))
            job = db.execute("SELECT state FROM jobs WHERE id=?", (row["job_id"],)).fetchone()
            if job is not None and job["state"] not in TERMINAL:
                self.ledger.transition(row["job_id"], "failed", db=db, receipt=json.dumps(
                    {"reason": f"family_{state}", "blocked": blocked[0] if blocked else ""}))
            else:                                      # it was answered as written: the count was wrong
                self._setback(db, f"an add was written, but {why}")
            self._set_problem(db, problem)
            self._say(db, self.chat_id, row["job_id"],
                      f"{words}\n{render.family_event_text(params, self.tz)}")

    def _not_ours(self, row, params: dict) -> None:
        """A read finds another event at its address, under another id: that isn't the add, so it
        isn't called added and gets no Undo, and that event is left as it is."""
        self._not_added(row, params, None, state="not_ours", words=NOT_OURS,
                        why="a read found another event at its place", problem="not_ours")

    def _read_later(self, row, state: dict) -> None:
        """Nothing settled by this read: read again on the schedule, with nothing written or said."""
        now = iso(self.ledger.now())
        state["read_at"] = now
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET settle_json=?, updated_at=? WHERE proposal_id=? AND state=?",
                       (json.dumps(state), now, row["proposal_id"], row["state"]))

    def _ask_again(self, db, job_id: str) -> bool:
        """His tap that turned adds on brings back the message it was for, as if just sent, so its
        card comes next: only that one message, only while it waits for exactly this."""
        job = db.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
        last = db.execute("SELECT detail FROM receipts WHERE job_id=? ORDER BY id DESC LIMIT 1",
                          (job_id,)).fetchone()
        try:
            reason = json.loads(last["detail"]).get("reason") if last is not None else None
        except (TypeError, ValueError, AttributeError):
            reason = None
        if job is None or job["state"] != "no_action" or reason != "family_add_off":
            return False
        self.ledger.transition(job_id, "received", db=db)
        self.ledger.event("family_add_asked_again", {"job": job_id}, db=db)
        return True

    # -- undo ---------------------------------------------------------------------------
    def _undo_button(self, db, proposal_id: str) -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="family_add_undo", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
        return ([[("Undo", choices.callback_data(nonce))]],
                [{"type": "choice", "nonce": nonce}])

    def _reoffer(self, row, words: str) -> None:
        """Nothing was deleted, so the Undo is still his to use."""
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state='open', updated_at=? WHERE"
                       " proposal_id=?", (iso(self.ledger.now()), row["proposal_id"]))
            buttons, binds = self._undo_button(db, row["proposal_id"])
            self._say(db, self.chat_id, row["job_id"], words, buttons=buttons, binds=binds)

    def _undo_words(self, row) -> str:
        """His Undo, as its card after Turn back on names it: what it takes off."""
        _, what = self._event_words(row)
        return f"adding {what} to the Family calendar"

    def _undo(self, row, paused: bool) -> None:
        if paused:
            # His tap waits with what he asked while stopped, and comes back as its own card.
            with self.ledger.tx() as db:
                db.execute("UPDATE family_adds SET undo_state='open', updated_at=? WHERE"
                           " proposal_id=?", (iso(self.ledger.now()), row["proposal_id"]))
                commands.note_stopped_undo(self.ledger, "family_add", row["proposal_id"],
                                           self._undo_words(row), db)
                self._say(db, self.chat_id, row["job_id"], STOPPED_UNDO)
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state='deleting', updated_at=? WHERE"
                       " proposal_id=?", (iso(self.ledger.now()), row["proposal_id"]))
        out = self.client.undo(row["uid"], row["etag"])
        if out.kind == "unknown":              # the answer was lost: a read by its uid says
            with self.ledger.tx() as db:
                self._wait_for_read(db, row, "undo_state", retried=False)
            return
        final = {"ok": ("undone", UNDONE),
                 "gone": ("gone", "That event isn't at its place on the calendar any more, so "
                                  "nothing was deleted."),
                 "changed": ("changed", CHANGED)}.get(out.kind)
        if final is None:
            with self.ledger.tx() as db:
                self._set_problem(db, out.kind)
            words = FAILED_WORDS.get(out.kind, FAILED_WORDS["failed"]).format(detail=_detail(out))
            self._reoffer(row, words.replace("Not added", "Not undone"))
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state=?, updated_at=? WHERE proposal_id=?",
                       (final[0], iso(self.ledger.now()), row["proposal_id"]))
            self.ledger.event("family_add_undo", {"proposal": row["proposal_id"],
                                                  "outcome": out.kind,
                                                  "http_status": out.status}, db=db)
            if out.kind == "ok":
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            self._say(db, self.chat_id, row["job_id"], final[1])

    # -- an outcome no answer settled, settled by reading the event by its uid ---------------
    # Safety: the event's address comes from its own id and is written only where nothing is
    # (If-None-Match), so writing once more can never make a second event, and it's done only
    # when a read finds nothing there, nothing stands in the way (_blocked) and it hasn't been
    # done before. An undo deletes only the event as it was written (client.undo), once more at
    # most. Nothing here runs while stopped.
    def _wait_for_read(self, db, row, column: str, *, status: int | None = None, retried: bool = False,
                       sent_at: str | None = None) -> None:
        """Waiting for a read: the add's own state, or its undo's. What the reads already did is
        kept: a restart in the middle of the one more try doesn't make it two. The first read comes
        a minute after the request was sent (`sent_at`, or now)."""
        now = iso(self.ledger.now())
        old = _settling(row)
        sent = sent_at or now
        state = {"since": old.get("since") or sent, "read_at": sent, "passes": old.get("passes", 0),
                 "told": old.get("told", False), "retried": retried or old.get("retried", False)}
        db.execute(f"UPDATE family_adds SET {column}='settling', settle_json=?, http_status=COALESCE(?, http_status),"
                   " updated_at=? WHERE proposal_id=?", (json.dumps(state), status, now, row["proposal_id"]))
        self._set_problem(db, "unknown" if column == "state" else "undo_unknown")

    def _event_words(self, row) -> tuple[dict, str]:
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        params = json.loads(p["params_json"])
        start = datetime.fromisoformat(params["start"]).astimezone(ZoneInfo(self.tz))
        return params, f"{render.family_text(params['title'])} on {start:%a %b} {start.day}"

    def _over_at(self, row) -> datetime:
        p = self.ledger.db.execute("SELECT params_json FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        return datetime.fromisoformat(json.loads(p["params_json"])["end"])

    def _not_yet(self, row, state: dict, verb: str) -> None:
        """A read that couldn't tell: read again on the schedule (read_gap); after several over an
        hour, he hears once that it isn't confirmed yet, and once more when it's known. Once the
        event is over or a week has passed, he hears once that it couldn't be confirmed, and the
        reads stop."""
        now = self.ledger.now()
        state.update(passes=state.get("passes", 0) + 1, read_at=iso(now))
        why = gave_up(state.get("since"), self._over_at(row), now)
        if why:
            self._unconfirmed(row, verb, why)
            return
        since = datetime.fromisoformat(state["since"]) if state.get("since") else now
        tell = (not state.get("told") and state["passes"] >= STILL_CHECKING_PASSES
                and now - since >= STILL_CHECKING_AFTER)
        state["told"] = state.get("told") or tell
        with self.ledger.tx() as db:           # read: to the back of the line
            db.execute("UPDATE family_adds SET settle_json=?, updated_at=? WHERE proposal_id=?",
                       (json.dumps(state), iso(now), row["proposal_id"]))
            if tell:
                _, what = self._event_words(row)
                self._say(db, self.chat_id, row["job_id"],
                          f"I couldn't confirm yet whether {what} was {verb}; I'm still checking.")

    def _unconfirmed(self, row, verb: str, why: str) -> None:
        """Reads couldn't tell, and the event is over or a week has passed: said once, read no more.
        An add iCloud answered as written, with a version, keeps its Undo on that line: Undo's own
        checks decide what it does (it deletes only the event as it was written)."""
        params, what = self._event_words(row)
        now = iso(self.ledger.now())
        offer = (verb == "added" and row["state"] == "written" and bool(row["etag"])
                 and row["undo_state"] == "open")
        with self.ledger.tx() as db:
            if verb == "undone":
                db.execute("UPDATE family_adds SET undo_state='unknown', settle_json='', updated_at=? WHERE"
                           " proposal_id=?", (now, row["proposal_id"]))
                self._set_problem(db, "undo_unconfirmed")
            else:
                db.execute("UPDATE family_adds SET state='unconfirmed', settle_json='', updated_at=? WHERE"
                           " proposal_id=?", (now, row["proposal_id"]))
                job = db.execute("SELECT state FROM jobs WHERE id=?", (row["job_id"],)).fetchone()
                if job is not None and job["state"] not in TERMINAL:
                    db.execute("UPDATE proposals SET state='failed' WHERE id=?", (row["proposal_id"],))
                    self.ledger.transition(row["job_id"], "failed", db=db,
                                           receipt=json.dumps({"reason": "family_unconfirmed"}))
                self._setback(db, "reads couldn't tell whether an add went in")
                self._set_problem(db, "unconfirmed")
            self.ledger.event("family_add_unconfirmed", {"proposal": row["proposal_id"], "verb": verb,
                                                         "why": why}, db=db)
            buttons, binds = self._undo_button(db, row["proposal_id"]) if offer else (None, None)
            self._say(db, self.chat_id, row["job_id"],
                      f"<b>Not confirmed:</b> reads couldn't tell whether {what} was {verb}, and "
                      f"{GAVE_UP_WORDS[why]}, so I've stopped reading it.", buttons=buttons, binds=binds)

    def _settle(self, row) -> None:
        """A write whose outcome no answer gave: a read of the event by its uid."""
        params, _ = self._event_words(row)
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        out, ics = self.client.fetch(self.client.href_for(row["uid"]))
        now = iso(self.ledger.now())
        state = _settling(row)
        if out.kind == "ok" and caldav._is_ours(ics, row["uid"]):
            # It landed. The receipt is the usual one, from the usual read (_read_back).
            with self.ledger.tx() as db:
                db.execute("UPDATE family_adds SET state='written', etag=?, undo_state=?, reads=0,"
                           " settle_json='', updated_at=? WHERE proposal_id=?",
                           (out.etag, "open" if out.etag else "none", now, row["proposal_id"]))
                db.execute("UPDATE proposals SET state='executed' WHERE id=?", (p["id"],))
                job = db.execute("SELECT state FROM jobs WHERE id=?", (row["job_id"],)).fetchone()
                if job is not None and job["state"] not in TERMINAL:
                    self.ledger.transition(row["job_id"], "executed", db=db, receipt=json.dumps(
                        {"effect": effects.FAMILY_ADD, "uid": row["uid"], "settled": "read"}))
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            self._read_back(self.ledger.db.execute("SELECT * FROM family_adds WHERE proposal_id=?",
                                                   (row["proposal_id"],)).fetchone(), seen=(out, ics))
            return
        uids = caldav._uids(ics) if out.kind == "ok" else set()
        if uids and row["uid"] not in uids:
            self._not_ours(row, params)                # another event there, under another id
            return
        if out.kind != "gone":
            self._not_yet(row, state, "added")
            return
        # Nothing there. Once more, at the same address, only where nothing is: not while stopped.
        blocked = self._blocked({**dict(p), "state": "approved"}, params, self.stopped())
        if blocked is not None and blocked[0] == "stopped":
            self._read_later(row, state)
            return
        if not state.get("retried") and blocked is None:
            self._once_more(row, p, params, state)
            return
        self._not_added(row, params, blocked)

    def _settle_undo(self, row) -> None:
        """An undo whose delete no answer settled: gone is undone; still there as written is
        deleted once more (client.undo reads it first), then read. The one more is recorded before
        it's sent, so it's never a second, let alone one a minute, and only as its delete goes out,
        so a try that fails at its own read spends nothing. No answer that says (iCloud out of
        reach, a server error, a lost answer) is read again on the schedule: the first delete may
        have landed. An answer that turns the one more down (the password, the address, a 4xx) says
        nothing about the first either, so it's read before anything is said: gone is undone; still
        there as written was turned down, said plainly with Undo offered again; a read that can't
        tell is read again on the schedule, and the refusal is kept so a later read says it. Every
        read checks the event is still as written: changed since is left alone and said so, never
        "still there", and an answer with no event in it can't tell."""
        state = _settling(row)
        now = iso(self.ledger.now())
        href = self.client.href_for(row["uid"])
        if state.get("retried"):
            refused = state.get("refused", "")      # why the one more was turned down, if it was
            kind = self._where(row, *self.client.fetch(href), there="refused" if refused else "still")
        else:
            state.pop("refused", None)              # a new try: an earlier refusal says nothing of it
            refused = ""

            def one_more() -> None:            # counted as it goes out, so a try that never sends spends nothing
                state["retried"] = True
                with self.ledger.tx() as db:
                    db.execute("UPDATE family_adds SET settle_json=? WHERE proposal_id=?",
                               (json.dumps(state), row["proposal_id"]))
            out = self.client.undo(row["uid"], row["etag"], sending=one_more)   # reads it first
            if out.kind == "ok":
                back, _ = self.client.fetch(href)
                kind = "ok" if back.kind == "gone" else "unread"
            elif _turned_down(out):
                with self.ledger.tx() as db:
                    self._set_problem(db, out.kind)
                refused = state["refused"] = _still_there(out)     # kept, for a later read to say
                kind = self._where(row, *self.client.fetch(href), there="refused")
            else:
                kind = {"gone": "ok", "changed": "changed"}.get(out.kind, "unread")
        if kind == "unread":
            self._not_yet(row, state, "undone")
            return
        final = {"ok": ("undone", UNDONE), "changed": ("changed", CHANGED), "refused": ("open", refused),
                 "still": ("open", "<b>Not undone.</b> That didn't go through, so it's still on the "
                                   "Family calendar.")}[kind]
        with self.ledger.tx() as db:
            db.execute("UPDATE family_adds SET undo_state=?, settle_json='', updated_at=? WHERE proposal_id=?",
                       (final[0], now, row["proposal_id"]))
            self.ledger.event("family_add_undo", {"proposal": row["proposal_id"], "outcome": kind,
                                                  "settled": "read"}, db=db)
            if kind == "ok":
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            again = kind in ("still", "refused")
            buttons, binds = self._undo_button(db, row["proposal_id"]) if again else (None, None)
            self._say(db, self.chat_id, row["job_id"], final[1], buttons=buttons, binds=binds)

    @staticmethod
    def _where(row, out: caldav.Outcome, body: str, *, there: str) -> str:
        """Where an undo's event stands, by a read: gone ("ok"); still there as it was written, ours
        with the same version (`there`); changed since; or "unread" when the read can't tell, an
        answer with no event in it (empty, a web page) included."""
        if out.kind == "gone":
            return "ok"
        if out.kind != "ok" or not caldav._uids(body):
            return "unread"
        return there if caldav._is_ours(body, row["uid"]) and out.etag == row["etag"] else "changed"

    # -- output ---------------------------------------------------------------------------
    def _set_problem(self, db, kind: str) -> None:
        self.ledger.set_meta(PROBLEM, PROBLEM_WORDS.get(kind, PROBLEM_WORDS["failed"]), db)

    def _say(self, db, chat_id: int | None, job_id: str | None, text: str, *, buttons=None,
             binds=None) -> None:
        self.ledger.enqueue(chat_id=chat_id, kind="reply", job_id=job_id,
                            text=render.fit(text), buttons=buttons, binds=binds, db=db)
        self.ledger.release_held(db=db)

