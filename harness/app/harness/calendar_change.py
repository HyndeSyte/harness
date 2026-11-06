"""Changing events on Family and his Gmail calendar, because he asked.

    his message -> a model's typed change -> plain code finds the event on a fresh read
                -> the write -> a read back -> one receipt with Undo

He said on Nov 5, 2026 that this should go with no tap, so a change he asks for needs none.
It's off until the add-on's `calendar_changes` option is on, which only he can decide. The
tap comes back for what may not be his own words, because something pasted can say anything,
and for anything a check finds off (`warnings`). The harness doesn't start a change itself:
there is no date list, and nothing here runs without a message from him behind it.

A model says what he said: which calendar, what the event is called, which days. It never
sees or names an event. Plain code finds it on those days. An exact title beats one that only
contains his words, a one-off is never taken on part of its name, and if two different titles
could be it, or none, it changes nothing and says what's there. So a request lands or doesn't
start, as far as a read can tell in advance. A write that fails partway stops there and says
what's done.

  * A write carries the version just read, so someone's edit in between isn't overwritten.
  * Each write is read back from the calendar, and a read that disagrees is said out loud.
  * The event as it was is kept here, so Undo can put it back, unless someone changed it since.
  * A lost answer is reported as unknown and never retried, as with every other write.
  * Harness copies on Family are refused: Gmail is the source of those.
  * An event with invitees is refused: changing it could message them.
  * A day he took off that comes back, from any app, gets a line in the digest.

Only named errors are caught, as in caldav.py: the stop signal is an ordinary Exception.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from . import caldav, choices, commands, effects, family_rules, google_cal, ical, ics_edit, render
from .canonical import canonical_hash
from .family_add import _looks_pasted
from .ledger import Ledger, iso

log = logging.getLogger("harness.calendar_change")

UNDO_TTL_S = 7 * 24 * 3600
CHECK_EVERY = timedelta(minutes=30)
END_AHEAD = timedelta(days=366)        # how far on a series's next day is looked for
RETURN_AHEAD = timedelta(days=366)     # how far on a day that came back is looked for
MAX_REPLY_CHAIN = 10
LAST_CHECK = "calendar_change_checked"
PROBLEM = "calendar_change_problem"
TAP_BACK = "calendar_change_tap_back"  # /checkadds: every change gets a tap again
AFTER_RESET = "calendar_change_after_reset"
_CLEARED_WHEN_OFF = (TAP_BACK, AFTER_RESET)
_RESTORED = ("summary", "description", "location", "start", "end", "recurrence", "transparency",
             "visibility", "reminders", "extendedProperties", "colorId")
_WORD = re.compile(r"[^\W_]+")

WORDS = {"unknown": "the answer was lost or the server had an error, so it may or may not have "
                    "gone through. Check the calendar. I won't retry",
         "changed": "someone changed that event since, so I left it alone",
         "series_gone": "the series that day belongs to isn't on the calendar any more, so there's "
                        "nothing to put it back into",
         "gone": "that event isn't there any more",
         "auth": "the calendar refused the password or key on the add-on page",
         "mismatch": "the saved address isn't the Family calendar",
         "no_credentials": "the calendar's sign-in isn't set on the add-on page",
         "no_key": "the Google key isn't set on the add-on page",
         "denied": "Google says this calendar isn't shared for changes",
         "exists": "that one is already there"}
RULE_WORDS = {"me": "are yours: Busy on Gmail and at work, unless you're already busy then",
              "kids": "mean you have the kids: Busy (watching kids) on Gmail and at work",
              "school": "are school days: drop-off and pickup runs on Gmail and at work",
              "none": "don't tie you up: nothing on Gmail, and I won't ask about them"}


def changes_from_options(data_dir: str) -> bool | None:
    """True or False as set. None when it can't be read: not on, and not an answer either."""
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            value = json.load(f).get("calendar_changes")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, bool) else None


def _words(text: str) -> set[str]:
    return {w.casefold() for w in _WORD.findall(text)}


def matches(asked: str, title: str) -> bool:
    """Every word he used is in the title. Words, so an emoji or spacing doesn't matter and
    "school" can't match "homeschool"."""
    wanted = _words(asked)
    return bool(wanted) and wanted <= _words(title)


def pick_titles(asked: str, titles: set[str]) -> list[str]:
    """What he could mean. The exact title wins: "School Day" isn't "School Day Pictures"."""
    fits = {t for t in titles if matches(asked, t)}
    exact = {t for t in fits if _words(t) == _words(asked)}
    return sorted(exact or fits)


def _safe(text: str) -> str:
    """Text from a calendar, for Telegram. Anyone can put a title on his calendar by invite,
    so it can't be a link or a command."""
    return render.family_text(render.defang(text))


def _day_words(day: date) -> str:
    return f"{day:%b} {day.day}"


def _list(days: list[date]) -> str:
    return ", ".join(_day_words(d) for d in sorted(days))


def _dates(text: str) -> list[date]:
    return sorted({date.fromisoformat(x) for x in text.split(",") if x})


def _when(text: str) -> datetime | date:
    return date.fromisoformat(text) if effects.DATE_RE.fullmatch(text) else datetime.fromisoformat(text)


class Refuse(Exception):
    """Nothing was written. His words."""


class Stopped(Exception):
    def __init__(self, kind: str, status: int | None = None, words: str = "", undo: dict | None = None):
        super().__init__(kind)
        self.kind, self.status, self.words, self.undo = kind, status, words, undo


@dataclass
class Found:
    """One occurrence, on either calendar."""
    series: str                        # the event, or the series it's a day of
    instance: str                      # which day of it; "" for a one-off on Family
    title: str
    first: date
    last: date
    repeats: bool
    start: Any
    raw: Any                           # caldav.Item, or Google's event
    invited: bool = False


@dataclass
class Step:
    """One write, already decided."""
    label: str
    run: Callable[[], dict]            # does it: what Undo needs, or raises Stopped
    removed: list[tuple] = field(default_factory=list)   # (calendar, uid, instance, title, day)


class CalendarChange:
    def __init__(self, ledger: Ledger, client, google, *, enabled: Callable[[], bool],
                 address: Callable[[], str | None], tz: str):
        self.ledger = ledger
        self.client = client               # caldav.FamilyCalDav
        self.google = google               # google_cal.GoogleCalendar, or None
        self.enabled = enabled             # the add-on's option: True, False, or None if unread
        self.address = address             # his Gmail address, as its feed names itself
        self.tz = tz
        self.chat_id: int | None = None
        self.touched = False               # something landed this tick: read Family again now

    def bind(self, owner: int) -> None:
        self.chat_id = owner

    def on(self) -> bool:
        """A reset forgets the owner, so whoever pairs next doesn't inherit this: he turns the
        option off and on again."""
        return self.enabled() is True and self.ledger.get_meta(AFTER_RESET) is None

    def check_changes(self) -> str:
        """/checkadds, while this is on."""
        self.ledger.set_meta(TAP_BACK, "1")
        return (" Calendar changes you ask for need your Approve tap too. To go back to no tap, "
                "turn the calendar_changes option off, restart the add-on, then turn it on again.")

    # -- a proposal arrives ----------------------------------------------------------------
    def refuse(self, job, receipt: dict, params: dict) -> bool:
        """True when this goes no further; the words are queued."""
        if commands.is_paused(self.ledger):
            words, state, why = ("I'm stopped, so nothing changed. Send /resume to start again, "
                                 "then resend it."), "cancelled", "stopped"
        elif not self.on():
            words, state, why = ("Changing calendar events is off, so nothing changed. It's the "
                                 "calendar_changes option on the add-on page."), "no_action", "off"
        elif any(c["op"] in ("add", "add_series") and (render.has_link(c["title"]) or render.has_link(c["location"]))
                 for c in params["changes"]):
            words, state, why = ("Nothing changed: the title or location has a link or web address in "
                                 "it, and I don't put those on a calendar. Say it again without "
                                 "that."), "no_action", "link"
        else:
            return False
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], state, db=db,
                                   receipt=json.dumps({**receipt, "reason": why}))
            self._say(db, job["chat_id"], job["id"], words)
        return True

    def refuse_in_words(self, job, receipt: dict, why: str) -> None:
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "no_action", db=db, receipt=json.dumps(
                {**receipt, "reason": "calendar_change_impossible"}))
            self._say(db, job["chat_id"], job["id"], f"Nothing changed: {render.escape(why)}.")

    def warnings(self, job, params: dict, *, pasted_recently: bool) -> list[str]:
        """What gets a tap. Words that may not be his: a change can't start from what a paste
        says, or from a title in a receipt, which anyone can put there by invite. A reply to the
        harness's own answer is still him, unless what it answered may have been pasted."""
        out = []
        if self.ledger.get_meta(TAP_BACK):
            out.append("you asked to check these with /checkadds.")
        text = self.ledger.job_text(job["id"])
        if _looks_pasted(text) or pasted_recently or self._reply_may_be_foreign(job):
            out.append("your message, a recent one or the one you replied to may have been long or "
                       "had several lines, so it may be pasted text.")
        local = ZoneInfo(self.tz)
        for c in params["changes"]:
            for key in ("start", "end"):
                if c[key] and "T" in c[key]:
                    dt = datetime.fromisoformat(c[key])
                    if dt.utcoffset() != dt.astimezone(local).utcoffset():
                        out.append(f"the {key} of {c['title']} was written with a different UTC offset "
                                   "than your zone has then, so the time may not be what you meant.")
            if c["op"] in ("add", "add_series"):
                if render.maybe_host(c["title"]) or render.maybe_host(c["location"]):
                    out.append("the title or location has a word.word, a word:word or a phone number "
                               "in it. If that's an address, it may show as a link on family phones.")
                if self._is_duplicate(c):
                    out.append(f"this looks like a duplicate: I already added {c['title']} at that time.")
        return out

    def _reply_may_be_foreign(self, job) -> bool:
        """Back along the replies, since each answer carries what it answered."""
        for _ in range(MAX_REPLY_CHAIN):
            replied = job["reply_to_message_id"]
            if not replied:
                return False
            prev = self.ledger.outbound(job["chat_id"], replied)
            if prev is not None and prev["kind"] == "digest" and not prev["job_id"]:
                return False    # the engine is never shown a digest (runner._earlier): only his words
            if prev is None or prev["kind"] != "answer" or not prev["job_id"]:
                return True
            if _looks_pasted(self.ledger.job_text(prev["job_id"])):
                return True
            job = self.ledger.job(prev["job_id"])
            if job is None:
                return True
        return True

    def _is_duplicate(self, c: dict) -> bool:
        for r in self.ledger.db.execute(
                "SELECT p.params_json FROM proposals p LEFT JOIN calendar_changes x ON x.proposal_id=p.id"
                " WHERE p.effect_type=? AND p.state IN ('proposed','approved','auto_approved','executing',"
                "'executed') AND COALESCE(x.undo_state,'none')!='undone'", (effects.CALENDAR_CHANGE,)):
            for other in json.loads(r["params_json"])["changes"]:
                if other["op"] == c["op"] and other["calendar"] == c["calendar"] and other["start"] == c["start"] \
                        and other["title"].strip().casefold() == c["title"].strip().casefold():
                    return True
        return False

    def auto_approve(self, proposal_id: str, job_id: str, db) -> None:
        db.execute("UPDATE proposals SET state='auto_approved' WHERE id=? AND state='proposed'",
                   (proposal_id,))
        self.ledger.transition(job_id, "approved", db=db)
        self.ledger.event("calendar_change_auto", {"proposal": proposal_id}, db=db)

    # -- each tick ---------------------------------------------------------------------------
    def run_pending(self, *, paused: bool) -> None:
        if self.enabled() is False:
            for key in _CLEARED_WHEN_OFF:
                if self.ledger.get_meta(key) is not None:
                    with self.ledger.tx() as db:
                        db.execute("DELETE FROM meta WHERE key=?", (key,))
        self._expire_offers()
        self._fail_orphans()
        for p in self._approved():
            self._execute(p, paused)
        for (pid,) in self.ledger.db.execute(           # newest first, read fresh: an undo before
                "SELECT proposal_id FROM calendar_changes WHERE undo_state='requested' ORDER BY rowid DESC"
                ).fetchall():                            # it can hand this one new versions
            row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
            self._undo(row, paused)
        if not paused and self.on():
            self._check_returned()

    def reconcile_after_restart(self) -> None:
        self._fail_orphans()
        for p in self._approved():
            self._refused(p, "interrupted", "The harness restarted before it did that, so nothing "
                                            "changed. Send it again.")
        for row in self.ledger.db.execute(
                "SELECT * FROM calendar_changes WHERE undo_state IN ('requested','undoing')"
                ).fetchall():
            self._reopen(row, "The harness restarted during that undo. Check the calendar, then "
                              "tap Undo again if it's still needed.")

    def forget(self) -> None:
        """A reset: every button that could reach a calendar goes, and this waits for him."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("UPDATE choices SET consumed_at=? WHERE consumed_at IS NULL"
                       " AND kind='calendar_change_undo'", (now,))
            db.execute("UPDATE calendar_changes SET undo_state='none', undo_json='[]'"
                       " WHERE undo_state IN ('open','requested')")
            db.execute("UPDATE approvals SET consumed_at=?, outcome='reset' WHERE consumed_at"
                       " IS NULL AND proposal_id IN (SELECT id FROM proposals WHERE effect_type=?)",
                       (now, effects.CALENDAR_CHANGE))
            for p in db.execute("SELECT id, job_id FROM proposals WHERE effect_type=? AND"
                                " state='proposed'", (effects.CALENDAR_CHANGE,)).fetchall():
                db.execute("UPDATE proposals SET state='cancelled' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "cancelled", db=db,
                                       receipt=json.dumps({"reason": "reset"}))
            self.ledger.set_meta(AFTER_RESET, "1", db)

    def _approved(self) -> list:
        return self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state IN ('approved','auto_approved')"
            " ORDER BY created_at", (effects.CALENDAR_CHANGE,)).fetchall()

    def _expire_offers(self) -> None:
        """An unanswered card closes, so the digest stops calling it waiting."""
        rows = self.ledger.db.execute(
            "SELECT * FROM proposals WHERE effect_type=? AND state='proposed' AND expires_at<=?",
            (effects.CALENDAR_CHANGE, iso(self.ledger.now()))).fetchall()
        for p in rows:
            with self.ledger.tx() as db:
                db.execute("UPDATE proposals SET state='expired' WHERE id=?", (p["id"],))
                self.ledger.transition(p["job_id"], "expired",
                                       receipt="expired before it was approved", db=db)
                self._say(db, self.chat_id, p["job_id"], "That offer expired, so nothing changed.")

    def _fail_orphans(self) -> None:
        """Writes are synchronous, so a row still "sending" belongs to a run that died mid-request."""
        now = iso(self.ledger.now())
        for row in self.ledger.db.execute(
                "SELECT * FROM calendar_changes WHERE state='sending'").fetchall():
            landed = json.loads(row["undo_json"])
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET state='unknown', undo_state=?, updated_at=?"
                           " WHERE proposal_id=?", ("open" if landed else "none", now, row["proposal_id"]))
                db.execute("UPDATE proposals SET state='failed' WHERE id=?", (row["proposal_id"],))
                self.ledger.transition(row["job_id"], "failed", db=db, receipt=json.dumps(
                    {"reason": "calendar_unknown", "detail": "interrupted during the write"}))
                self.ledger.set_meta(PROBLEM, "Calendar change: the last one's outcome is unknown; "
                                              "check the calendar", db)
                buttons, binds = self._undo_button(db, row["proposal_id"]) if landed else (None, None)
                self._say(db, self.chat_id, row["job_id"],
                          "<b>I don't know how far that got.</b> The harness stopped during the "
                          "write. Check the calendar. I won't retry.", buttons=buttons, binds=binds)

    def _refused(self, p, reason: str, words: str) -> None:
        with self.ledger.tx() as db:
            db.execute("UPDATE proposals SET state='refused' WHERE id=?", (p["id"],))
            db.execute("UPDATE calendar_changes SET state='refused', updated_at=? WHERE proposal_id=?",
                       (iso(self.ledger.now()), p["id"]))
            self.ledger.transition(p["job_id"], "failed", db=db,
                                   receipt=json.dumps({"reason": reason}))
            self._say(db, self.chat_id, p["job_id"], words)

    # -- the change --------------------------------------------------------------------------
    def _execute(self, p, paused: bool) -> None:
        params = json.loads(p["params_json"])
        if paused:
            self._refused(p, "stopped", "I'm stopped, so nothing changed. Send /resume, then resend it.")
            return
        if not self.on():
            self._refused(p, "off", "Changing calendar events is off, so nothing changed.")
            return
        try:
            checked = effects.REGISTRY[effects.CALENDAR_CHANGE].validate(params)
        except effects.ParamError:
            checked = None
        if checked != params or canonical_hash(params) != p["params_hash"]:
            self._refused(p, "changed", "That changed after you saw it, so nothing changed.")
            return
        # Recorded before anything else, so a crash from here on can never run it twice.
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("INSERT INTO calendar_changes(proposal_id, job_id, state, undo_state,"
                       " undo_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                       (p["id"], p["job_id"], "sending", "none", "[]", now, now))
            db.execute("UPDATE proposals SET state='executing' WHERE id=?", (p["id"],))
        steps, notes = [], []
        try:
            for index, change in enumerate(params["changes"]):
                more, said = self._plan(change, f"{p['id']}:{index}")
                steps += more
                notes += said
        except Refuse as why:
            self._refused(p, "not_found", f"Nothing changed: {_safe(str(why))}.")
            return
        done, undo, stopped = [], [], None
        for step in steps:
            entry = None
            try:
                entry = step.run()
                done.append(step)
            except Stopped as s:
                stopped, entry = s, s.undo
                if entry is not None:            # it landed, though its read back didn't confirm it
                    notes.append(f"Written, not confirmed: {render.plain(step.label)}")
            except (ValueError, KeyError, TypeError, ical.Unreadable) as e:
                stopped = Stopped("failed", words=str(e) if isinstance(e, ics_edit.Cant)
                                  else "I couldn't read that event")
            if entry is not None:
                undo.append({**entry, "removed": [list(x[:3]) for x in step.removed]})
                with self.ledger.tx() as db:     # a crash after this still knows what to undo
                    db.execute("UPDATE calendar_changes SET undo_json=?, updated_at=? WHERE proposal_id=?",
                               (json.dumps(undo), iso(self.ledger.now()), p["id"]))
                    self._note_removed(db, step)
            if stopped is not None:
                break
        self.touched = self.touched or bool(undo)
        self._finish(p, done, undo, notes, stopped)

    def _note_removed(self, db, step: Step) -> None:
        now = iso(self.ledger.now())
        for calendar, uid, instance, title, day in step.removed:
            db.execute("INSERT OR REPLACE INTO calendar_removed(calendar, uid, instance, title,"
                       " day, removed_at, told_at) VALUES(?,?,?,?,?,?,NULL)",
                       (calendar, uid, instance, title, day.isoformat(), now))

    def _finish(self, p, done: list[Step], undo: list[dict], notes: list[str], stopped) -> None:
        with self.ledger.tx() as db:
            now = iso(self.ledger.now())
            ok = stopped is None
            kind = "done" if ok else stopped.kind
            db.execute("UPDATE proposals SET state=? WHERE id=?",
                       ("executed" if ok else "failed", p["id"]))
            db.execute("UPDATE calendar_changes SET state=?, undo_state=?, updated_at=? WHERE"
                       " proposal_id=?", (kind, "open" if undo else "none", now, p["id"]))
            self.ledger.transition(p["job_id"], "executed" if ok else "failed", db=db,
                                   receipt=json.dumps({"effect": effects.CALENDAR_CHANGE,
                                                       "steps": len(undo), "outcome": kind}))
            if ok:
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
                self.ledger.event("calendar_change_done", {"steps": len(done)}, db=db)
                head = ["<b>Done.</b>"]
            else:
                self.ledger.set_meta(PROBLEM, "Calendar change: the last one didn't finish", db)
                top = ("<b>That stopped partway.</b>" if undo
                       else "<b>Not sure that went through.</b>" if kind == "unknown"
                       else "<b>Nothing changed.</b>")
                why = stopped.words or WORDS.get(kind) or "the calendar refused it"
                head = [top, f"It stopped because {_safe(why)}."]
            lines = head + [_safe(x) for x in notes] + [step.label for step in done]
            buttons, binds = self._undo_button(db, p["id"]) if undo else (None, None)
            self._say(db, self.chat_id, p["job_id"], "\n".join(lines), buttons=buttons, binds=binds)

    # -- finding it --------------------------------------------------------------------------
    def _bounds(self, days: list[date], ahead: timedelta = timedelta(0)) -> tuple[datetime, datetime]:
        zone = ZoneInfo(self.tz)
        first, last = min(days), max(days) + ahead
        return (datetime(first.year, first.month, first.day, tzinfo=zone),
                datetime(last.year, last.month, last.day, tzinfo=zone) + timedelta(days=1))

    def _check_days(self, days: list[date]) -> None:
        today = self.ledger.now().astimezone(ZoneInfo(self.tz)).date()
        for day in days:
            if day < today:
                raise Refuse(f"{_day_words(day)}, {day.year} has already passed")
            if day > today + timedelta(days=effects.MAX_DAYS_AHEAD):
                raise Refuse(f"{_day_words(day)}, {day.year} is more than two years off")

    def _span(self, start, end) -> tuple[date, date]:
        """The days it covers. An all-day end isn't on that day, and a night out or a shift
        that runs past midnight belongs to the day it starts."""
        if not isinstance(start, datetime):
            return start, max(start, end - timedelta(days=1))
        zone = ZoneInfo(self.tz)
        first = start.astimezone(zone).date()
        if end - start <= timedelta(hours=24):
            return first, first
        return first, (end - timedelta(microseconds=1)).astimezone(zone).date()

    def _read(self, calendar: str, days: list[date], ahead: timedelta = timedelta(0)) -> tuple[list[Found], int]:
        start, end = self._bounds(days, ahead)
        if calendar == "family":
            read = self.client.items_between(start, end, self.tz)
            if read is None:
                raise Refuse("I couldn't read the Family calendar")
            out = []
            for item in read.items:
                occ = item.occ
                out.append(Found(occ.uid, occ.instance, occ.summary, *self._span(occ.start, occ.end),
                                 bool(occ.instance), occ.start, item, bool(occ.attendees)))
            return out, read.unreadable
        events = self.google.events_between(self._gmail_address(), start, end)
        if events is None:
            raise Refuse("I couldn't read your Gmail calendar")
        out = []
        for e in events:
            first, last = self._gmail_when(e.get("start")), self._gmail_when(e.get("end"))
            if first is None or last is None or e.get("status") == "cancelled":
                continue
            invited = bool([a for a in e.get("attendees") or [] if not a.get("self")]
                           or e.get("attendeesOmitted")
                           or ("organizer" in e and not (e.get("organizer") or {}).get("self")))
            out.append(Found(e.get("recurringEventId") or e["id"], e["id"], e.get("summary", ""),
                             *self._span(first, last), bool(e.get("recurringEventId")), first, e, invited))
        return out, 0

    def _gmail_address(self) -> str:
        if self.google is None or not self.google.configured():
            raise Refuse("the Google key isn't set on the add-on page")
        address = self.address()
        if not address:
            raise Refuse("I can't tell which Gmail calendar is yours")
        return address

    @staticmethod
    def _gmail_when(side: Any) -> datetime | date | None:
        try:
            if "dateTime" in side and side["dateTime"]:
                return datetime.fromisoformat(side["dateTime"].replace("Z", "+00:00"))
            return date.fromisoformat(side["date"])
        except (KeyError, ValueError, TypeError, AttributeError):
            return None

    def _is_copy(self, f: Found) -> bool:
        """hx- is also a Family add of his, which is his to change. A copy has a row here."""
        return f.series.startswith("hx-") and self.ledger.db.execute(
            "SELECT 1 FROM family_copies WHERE uid=? LIMIT 1", (f.series,)).fetchone() is not None

    def _hits(self, named: list[Found], day: date) -> list[Found]:
        hits = [f for f in named if f.first <= day <= f.last]
        if len({f.series for f in hits}) > 1:
            raise Refuse(f"on {_day_words(day)} there's more than one {hits[0].title}. Change it on the "
                         "calendar, or tell me something that tells them apart")
        return hits

    def _guard(self, f: Found) -> None:
        if f.invited:
            raise Refuse(f"{f.title} has invitees, and changing it could message them")
        if self._is_copy(f):
            raise Refuse(f"{f.title} on {_day_words(f.first)} is a copy of your Gmail event, so "
                         "change it on Gmail")

    def _missing(self, asked: str, day: date, found: list[Found], unreadable: int) -> Refuse:
        there = sorted({f.title for f in found if f.first <= day <= f.last})
        words = f"I can't find {asked} on {_day_words(day)}. That day has: {', '.join(there) or 'nothing'}"
        if unreadable:
            words += ", and something on that calendar I can't read"
        return Refuse(words)

    def _one_title(self, asked: str, titles: list[str]) -> str:
        if len({frozenset(_words(t)) for t in titles}) > 1:
            raise Refuse(f"more than one event fits {asked}: {', '.join(titles)}. Say which")
        return titles[0]

    def _named(self, asked: str, found: list[Found], days: list[date], unreadable: int) -> list[Found]:
        """What he meant, from what's on the days he named: a School Board Meeting next month
        doesn't make "school" on Monday unclear. Part of a repeating title is how anyone talks
        about it. A one-off goes only on its whole name, since "school" could be the day that's
        already off, and the one-off that's left is School Pictures."""
        on = [f for f in found if any(f.first <= d <= f.last for d in days)]
        titles = pick_titles(asked, {f.title for f in on})
        if not titles:
            raise self._missing(asked, days[0], found, unreadable)
        title = self._one_title(asked, titles)
        chosen = [f for f in on if _words(f.title) == _words(title)]
        if _words(title) != _words(asked) and not any(f.repeats for f in chosen):
            raise Refuse(f"the closest I found is {title}. If that's the one, say its whole name")
        return chosen

    # -- working out what to write -------------------------------------------------------------
    def _plan(self, c: dict, key: str) -> tuple[list[Step], list[str]]:
        calendar, op = c["calendar"], c["op"]
        if op == "rule":
            return [self._rule(c)], []
        if calendar == "gmail":
            self._gmail_address()
        if op in ("add", "add_series"):
            return [(self._family_add if calendar == "family" else self._gmail_add)(c, key)], []
        days = _dates(c["dates"])
        self._check_days(days)
        if op == "end_series":
            found, unreadable = self._read(calendar, days, END_AHEAD)
            return self._plan_end(calendar, c["title"], days[0], c["days"], found, unreadable)
        found, unreadable = self._read(calendar, days)
        named = self._named(c["title"], found, days, unreadable)
        if op == "remove":
            return self._plan_remove(calendar, c["title"], days, named, found, unreadable)
        hits = self._hits(named, days[0])
        if not hits:
            raise self._missing(c["title"], days[0], found, unreadable)
        hit = hits[0]
        self._guard(hit)
        if hit.repeats and hit.first != days[0]:
            raise Refuse(f"that day of {hit.title} starts on {_day_words(hit.first)}. Name that day")
        start, end, _ = self._new_times(c)
        move = self._family_move if calendar == "family" else self._gmail_move
        return [move(hit, start, end)], []

    def _plan_remove(self, calendar: str, asked: str, days: list[date], named: list[Found],
                     found: list[Found], unreadable: int) -> tuple[list[Step], list[str]]:
        picked, absent = {}, []
        for day in days:
            hits = self._hits(named, day)
            if not hits:
                absent.append(day)
            for f in hits:
                self._guard(f)
                covered = [f.first + timedelta(days=i) for i in range((f.last - f.first).days + 1)]
                if not set(covered) <= set(days):
                    raise Refuse(f"{f.title} runs {_day_words(f.first)} to {_day_words(f.last)}, so "
                                 "that would take off all of it. Name all its days to remove it, or "
                                 "give me its new dates")
                picked[(f.series, f.instance)] = f
        if not picked:
            raise self._missing(asked, absent[0], found, unreadable)
        notes = []
        if absent:
            notes.append(f"I didn't find it on {_list(absent)}, so nothing changed there.")
        if calendar == "gmail":
            return [self._gmail_remove(f) for f in picked.values()], notes
        series: dict[str, list[Found]] = {}
        steps = []
        for f in picked.values():
            if f.repeats:
                series.setdefault(f.series, []).append(f)
            else:
                steps.append(self._family_remove_one(f))
        return [self._family_remove_days(group) for group in series.values()] + steps, notes

    def _series_facts(self, calendar: str, f: Found) -> tuple[date, set[int]]:
        """When a series starts and which days of the week it's on, from its own rule: the
        days around now can't say, with some of them off or moved."""
        try:
            if calendar == "family":
                return ics_edit.series_facts(f.raw.data, self.tz)
            kind, master = self.google.look(self._gmail_address(), f.series)
            first = self._gmail_when((master or {}).get("start"))
            if kind != "ok" or first is None:
                raise Refuse(f"I couldn't read the {f.title} series")
            start = self._span(first, first)[0]
            rules = [x[6:] for x in master.get("recurrence") or [] if x.upper().startswith("RRULE:")]
            return start, ics_edit.rule_days(rules[0] if rules else "", start)
        except (ValueError, KeyError, TypeError, ical.Unreadable):
            raise Refuse(f"I couldn't read the {f.title} series") from None

    def _plan_end(self, calendar: str, asked: str, day: date, weekdays: str, found: list[Found],
                  unreadable: int) -> tuple[list[Step], list[str]]:
        """A program can be several series under one title, one for each day of the week, so
        this ends each one still going, or only those on the days he named."""
        pool = [f for f in found if f.repeats and f.first >= day]
        titles = pick_titles(asked, {f.title for f in pool})
        if not titles:
            words = f"I can't find {asked} repeating on or after {_day_words(day)}"
            raise Refuse(words + (", and something on that calendar I can't read" if unreadable else ""))
        title = self._one_title(asked, titles)
        series: dict[str, Found] = {}
        for f in sorted(pool, key=lambda f: f.first):
            if _words(f.title) == _words(title):
                series.setdefault(f.series, f)
        facts = {key: self._series_facts(calendar, f) for key, f in series.items()}
        if weekdays:
            wanted = {ical.WEEKDAYS[x] for x in weekdays.split(",")}
            for key, (_, on) in facts.items():
                if on & wanted and not on <= wanted:
                    raise Refuse(f"{title} repeats on more days than that as one series, so ending only "
                                 "those would end the others. Say to end it, and I'll add back the days "
                                 "that continue")
            series = {k: f for k, f in series.items() if facts[k][1] & wanted}
            if not series:
                raise Refuse(f"{title} doesn't repeat on those days")
        for key in series:
            if facts[key][0] >= day and len(series) > 1:
                raise Refuse(f"one {title} series only starts on {_day_words(facts[key][0])}, and ending "
                             "from then would delete it. Say which days of the week to end")
        steps = []
        for f in series.values():
            self._guard(f)
            steps.append((self._family_end if calendar == "family" else self._gmail_end)(f, day))
        notes = ["Something on that calendar I can't read, so check that nothing else by this name "
                 "keeps going."] if unreadable else []
        return steps, notes

    def _uid(self, key: str, prefix: str) -> str:
        return prefix + hashlib.sha256(f"calendar_change:{key}".encode()).hexdigest()[:32]

    def _new_times(self, c: dict) -> tuple:
        """Times to write. He says the last day of an all-day event; the calendars want the day after."""
        start, end = _when(c["start"]), _when(c["end"])
        if not isinstance(start, datetime):
            self._check_days([start, end])
            return start, end + timedelta(days=1), ""
        self._check_days([start.astimezone(ZoneInfo(self.tz)).date()])
        if c["op"] != "add_series":
            return start, end, ""
        until = date.fromisoformat(c["until"])
        self._check_days([until])
        cut = datetime(until.year, until.month, until.day, 23, 59, 59, tzinfo=ZoneInfo(self.tz))
        return start, end, f"FREQ=WEEKLY;BYDAY={c['days']};UNTIL={cut.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"

    def _when_words(self, start, end) -> str:
        if not isinstance(start, datetime):
            last = end - timedelta(days=1)
            return _day_words(start) if last == start else f"{_day_words(start)} to {_day_words(last)}"
        return render.escape(render.family_when(start.isoformat(), end.isoformat(), self.tz))

    def _new_words(self, c: dict, start, end) -> str:
        if c["op"] == "add_series":
            until = date.fromisoformat(c["until"])
            return (f" every {c['days']}, starting {self._when_words(start, end)}, through "
                    f"{_day_words(until)}, {until.year}")
        return ", " + self._when_words(start, end)

    # -- what an event means for him -------------------------------------------------------------
    def _rule(self, c: dict) -> Step:
        said, kind = c["title"].strip(), c["kind"]
        if not family_rules.words(said):
            raise Refuse("which event isn't clear")
        if not family_rules.room(self.ledger, said, kind):
            raise Refuse(f"there are already {family_rules.MAX_RULES} of these. Say one of them means "
                         "nothing to make room")

        def run() -> dict:
            before = family_rules.find(self.ledger, said)
            with self.ledger.tx() as db:
                family_rules.put(self.ledger, said, kind, db)
            return {"cal": "rule", "how": "rule", "said": said,
                    "before": [before.said, before.kind] if before else None}
        n = self._rule_reach(said)
        reach = ("" if n is None else " Nothing on Family has those words in the next two months." if n == 0
                 else f" That's {n} event{'' if n == 1 else 's'} on Family in the next two months.")
        return Step(f"From now on, Family events with {_safe(said)} in the name {RULE_WORDS[kind]}.{reach} "
                    "Gmail and work follow within a few minutes.", run)

    def _rule_reach(self, said: str) -> int | None:
        """How much one sentence moves, so he isn't surprised. None when Family can't be read."""
        now = self.ledger.now()
        try:
            read = self.client.items_between(now, now + timedelta(days=60), self.tz)
            if read is None:
                return None
            want = family_rules.words(said)
            return len({(i.occ.uid, i.occ.instance) for i in read.items if not i.occ.all_day
                        and not i.occ.uid.startswith("hx-") and want <= family_rules.words(i.occ.summary)})
        except Exception as e:                 # only the count is lost
            log.warning("rule count failed: %s", type(e).__name__)
            return None

    # -- Family --------------------------------------------------------------------------------
    def _family_fetch(self, href: str) -> tuple[str, str]:
        out, body = self.client.fetch(href)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status)
        if not out.etag:
            raise Stopped("failed", out.status, "iCloud gave no version of that event to guard the change")
        return body, out.etag

    def _occurrences(self, ics: str, start: datetime, end: datetime) -> list[ical.Occurrence]:
        return ical.window(ics, start=start, end=end, tz=self.tz, fallback_name="Family").occurrences

    def _family_write(self, href: str, etag: str, before: str, new: str, shows: Callable[[str], bool]) -> dict:
        """The write, then what the calendar holds afterward, not what was sent."""
        out = self.client.replace(href, etag, new)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status)
        entry = {"cal": "family", "how": "put", "href": href, "before": before, "after": new,
                 "etag": out.etag or ""}
        back, body = self.client.fetch(href)
        if back.kind != "ok":
            raise Stopped("unknown", back.status, "it was written, but reading it back failed. Check "
                                                  "the calendar", undo=entry)
        entry["etag"] = back.etag or entry["etag"]
        entry["after"] = body or new        # as the server keeps it, so a later undo can match it
        if not shows(body):
            raise Stopped("failed", words="the calendar doesn't show the change when I read it back. "
                                          "Check the calendar", undo=entry)
        return entry

    def _family_remove_days(self, group: list[Found]) -> Step:
        first = group[0]
        href = first.raw.href
        days = [f.first for f in group]
        keys = [f.instance for f in group]

        def shows(body: str) -> bool:
            start, end = self._bounds(days, timedelta(days=1))
            return not {o.instance for o in self._occurrences(body, start, end)} & set(keys)

        def run() -> dict:
            body, etag = self._family_fetch(href)
            return self._family_write(href, etag, body, ics_edit.remove_days(body, keys, self.tz, self.ledger.now()),
                                      shows)
        return Step(f"Family: {_safe(first.title)} off {_list(days)}.", run,
                    [("family", first.series, k, first.title, d) for k, d in zip(keys, days)])

    def _family_delete(self, href: str, etag: str, body: str) -> dict:
        out = self.client.remove_at(href, etag)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status)
        entry = {"cal": "family", "how": "restore", "href": href, "before": body}
        back, _ = self.client.fetch(href)
        if back.kind == "ok":
            raise Stopped("failed", words="the calendar still shows it when I read it back", undo=entry)
        if back.kind != "gone":
            raise Stopped("unknown", back.status, "it was removed, but reading it back failed. Check "
                                                  "the calendar", undo=entry)
        return entry

    def _family_remove_one(self, f: Found) -> Step:
        def run() -> dict:
            body, etag = self._family_fetch(f.raw.href)
            if ics_edit.people(body):
                raise ics_edit.Cant("it has invitees, and changing it could message them")
            return self._family_delete(f.raw.href, etag, body)
        return Step(f"Family: {_safe(f.title)} on {_day_words(f.first)} removed.", run,
                    [("family", f.series, "", f.title, f.first)])

    def _family_end(self, f: Found, day: date) -> Step:
        href = f.raw.href

        def shows(body: str) -> bool:
            start, end = self._bounds([day, day + timedelta(days=400)])
            return not any(self._span(o.start, o.end)[0] >= day for o in self._occurrences(body, start, end))

        def run() -> dict:
            body, etag = self._family_fetch(href)
            new = ics_edit.end_from(body, day, self.tz, self.ledger.now())
            if new is None:
                return self._family_delete(href, etag, body)
            return self._family_write(href, etag, body, new, shows)
        return Step(f"Family: {_safe(f.title)} ends, with nothing on or after {_day_words(day)}.", run,
                    [("family", f.series, "*", f.title, day)])

    def _family_move(self, f: Found, start, end) -> Step:
        href = f.raw.href

        def shows(body: str) -> bool:
            low, high = self._span(start, end)
            return any(_same_start(o.start, start) for o in self._occurrences(body, *self._bounds([low, high])))

        def run() -> dict:
            body, etag = self._family_fetch(href)
            now = self.ledger.now()
            new = (ics_edit.move_day(body, f.instance, start, end, self.tz, now) if f.instance
                   else ics_edit.move_one(body, start, end, self.tz, now))
            return self._family_write(href, etag, body, new, shows)
        return Step(f"Family: {_safe(f.title)} on {_day_words(f.first)} moved to {self._when_words(start, end)}.", run)

    def _family_add(self, c: dict, key: str) -> Step:
        start, end, rule = self._new_times(c)
        uid = self._uid(key, "hm-")
        href = self.client.href_for(uid)
        ics = ics_edit.build(uid, c["title"], start, end, c["location"], rule, self.tz, self.ledger.now())

        def run() -> dict:
            out = self.client.put_new(href, ics)
            if out.kind != "ok":
                raise Stopped(out.kind, out.status)
            entry = {"cal": "family", "how": "delete", "href": href, "after": ics, "etag": out.etag or ""}
            back, body = self.client.fetch(href)
            if back.kind != "ok":
                raise Stopped("unknown", back.status, "it was added, but reading it back failed. Check "
                                                      "the calendar", undo=entry)
            entry["etag"] = back.etag or entry["etag"]
            entry["after"] = body or ics
            if not ical.parse_calendar(body)[1]:
                raise Stopped("failed", words="the calendar doesn't show it when I read it back", undo=entry)
            return entry
        return Step(f"Family: {_safe(c['title'])} added{self._new_words(c, start, end)}.", run)

    # -- Gmail ---------------------------------------------------------------------------------
    def _gmail_reread(self, address: str, uid: str, entry: dict, shows: Callable[[dict], bool]) -> dict:
        kind, now = self.google.look(address, uid)
        if kind != "ok":
            raise Stopped("unknown", words="it was written, but reading it back failed. Check the calendar",
                          undo=entry)
        entry["etag"] = now.get("etag")
        if not shows(now):
            raise Stopped("failed", words="the calendar doesn't show the change when I read it back. "
                                          "Check the calendar", undo=entry)
        return entry

    def _gmail_stop(self, out) -> None:
        if out.kind != "ok":
            raise Stopped(out.kind, out.status)

    def _gmail_fresh(self, address: str, e: dict) -> dict:
        """As it is now. A change to another day of a series can give this day a new version,
        so what planning read can't guard the write. A different time means someone moved it."""
        kind, now = self.google.look(address, e["id"])
        if kind == "gone" or (now or {}).get("status") == "cancelled":
            raise Stopped("gone")
        if kind != "ok":
            raise Stopped("failed", words="I couldn't read that event just before changing it")
        if not _same_start(self._gmail_when(now.get("start")), self._gmail_when(e.get("start"))):
            raise Stopped("changed")
        return now

    def _gmail_drop(self, address: str, e: dict) -> dict:
        self._gmail_stop(self.google.drop(address, e["id"], e.get("etag")))
        entry = {"cal": "gmail", "how": "restore", "id": e["id"],
                 "fields": {**{k: e[k] for k in _RESTORED if k in e}, "status": "confirmed"}}
        if e.get("recurringEventId"):
            entry["series"] = e["recurringEventId"]
        if not self.google.really_gone(address, e["id"]):
            raise Stopped("unknown", words="it was removed, but reading it back didn't show that. Check "
                                           "the calendar", undo=entry)
        return entry

    def _gmail_remove(self, f: Found) -> Step:
        def run() -> dict:
            address = self._gmail_address()
            return self._gmail_drop(address, self._gmail_fresh(address, f.raw))
        return Step(f"Gmail: {_safe(f.title)} on {_day_words(f.first)} removed.", run,
                    [("gmail", f.series, f.instance, f.title, f.first)])

    def _gmail_end(self, f: Found, day: date) -> Step:
        series = f.series

        def run() -> dict:
            address = self._gmail_address()
            kind, master = self.google.look(address, series)
            if kind != "ok":
                raise Stopped("failed", words="I couldn't read that series")
            first = self._gmail_when(master.get("start"))
            if first is None:
                raise ics_edit.Cant("I couldn't read when that series starts")
            start_day = self._span(first, first)[0]
            if start_day >= day:
                return self._gmail_drop(address, master)
            before = list(master.get("recurrence") or [])
            after, changed = [], False
            for line in before:
                if line.upper().startswith("RRULE:"):
                    rule, moved = ics_edit.until_line(line[6:], day, all_day=not isinstance(first, datetime),
                                                      zone=ZoneInfo(self.tz))
                    after.append("RRULE:" + rule)
                    changed = changed or moved
                else:
                    after.append(line)
            if not changed:
                raise ics_edit.Cant("that series already ends by then")
            self._gmail_stop(self.google.change(address, series, {"recurrence": after}, master.get("etag")))
            entry = {"cal": "gmail", "how": "change", "id": series, "fields": {"recurrence": before},
                     "wrote": {"recurrence": after}}
            return self._gmail_reread(address, series, entry, lambda e: e.get("recurrence") == after)
        return Step(f"Gmail: {_safe(f.title)} ends, with nothing on or after {_day_words(day)}.", run,
                    [("gmail", series, "*", f.title, day)])

    def _gmail_side(self, when) -> dict:
        if isinstance(when, datetime):
            return {"dateTime": when.isoformat(), "timeZone": self.tz, "date": None}
        return {"date": when.isoformat(), "dateTime": None, "timeZone": None}

    def _gmail_move(self, f: Found, start, end) -> Step:
        e = f.raw
        fields = {"start": self._gmail_side(start), "end": self._gmail_side(end)}
        unset = {"date": None, "dateTime": None, "timeZone": None}    # a time and a date can't both stand
        old = {"start": {**unset, **(e.get("start") or {})}, "end": {**unset, **(e.get("end") or {})}}

        def run() -> dict:
            address = self._gmail_address()
            now = self._gmail_fresh(address, e)
            self._gmail_stop(self.google.change(address, e["id"], fields, now.get("etag")))
            entry = {"cal": "gmail", "how": "change", "id": e["id"], "fields": old, "wrote": fields}
            return self._gmail_reread(address, e["id"], entry,
                                      lambda now: _same_start(self._gmail_when(now.get("start")), start))
        return Step(f"Gmail: {_safe(f.title)} on {_day_words(f.first)} moved to {self._when_words(start, end)}.", run)

    def _gmail_add(self, c: dict, key: str) -> Step:
        start, end, rule = self._new_times(c)
        uid = self._uid(key, "cm")
        event: dict = {"id": uid, "summary": c["title"], "status": "confirmed",
                       "start": {k: v for k, v in self._gmail_side(start).items() if v},
                       "end": {k: v for k, v in self._gmail_side(end).items() if v},
                       "guestsCanInviteOthers": False}
        if c["location"]:
            event["location"] = c["location"]
        if rule:
            event["recurrence"] = ["RRULE:" + rule]

        def run() -> dict:
            address = self._gmail_address()
            self._gmail_stop(self.google.insert(address, event))
            entry = {"cal": "gmail", "how": "drop", "id": uid, "wrote": {"summary": c["title"]}}
            return self._gmail_reread(address, uid, entry, lambda now: now.get("status") != "cancelled")
        return Step(f"Gmail: {_safe(c['title'])} added{self._new_words(c, start, end)}.", run)

    # -- undo ----------------------------------------------------------------------------------
    def _undo_button(self, db, proposal_id: str, label: str = "Undo") -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="calendar_change_undo", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
        return [[(label, choices.callback_data(nonce))]], [{"type": "choice", "nonce": nonce}]

    def on_choice(self, kind: str, target: str) -> str:
        if kind != "calendar_change_undo":
            return "Nothing changed."
        with self.ledger.tx() as db:
            done = 0
            for pid in target.split():               # "Undo both" names the later changes too
                done += db.execute("UPDATE calendar_changes SET undo_state='requested', updated_at=?"
                                   " WHERE proposal_id=? AND undo_state='open'",
                                   (iso(self.ledger.now()), pid)).rowcount
            if not done:
                return "There's nothing to undo there."
        return "Undoing it now."

    def _reopen(self, row, words: str) -> None:
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_state='open', updated_at=? WHERE proposal_id=?",
                       (iso(self.ledger.now()), row["proposal_id"]))
            buttons, binds = self._undo_button(db, row["proposal_id"])
            self._say(db, self.chat_id, row["job_id"], words, buttons=buttons, binds=binds)

    def _undo(self, row, paused: bool) -> None:
        if paused:
            self._reopen(row, "I'm stopped, so I didn't undo that. After /resume, tap Undo here.")
            return
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_state='undoing', updated_at=? WHERE proposal_id=?",
                       (iso(self.ledger.now()), row["proposal_id"]))
        steps = json.loads(row["undo_json"])
        # Nothing is written unless every part checks out first. Only an edit in the seconds
        # between the check and the writes can still stop it partway.
        later = self._later_changes(row, steps)
        if later:
            self._offer_both(row, later)
            return
        problem = self._undo_ready(steps)
        if problem is not None:
            again = (" Undo here won't work while it stays that way." if problem == "changed"
                     else " Undo tries again.")
            self._reopen(row, f"<b>Not undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                              "Nothing changed. Check the calendar." + again)
            return
        left = list(steps)
        latest: dict[str, str] = {}          # an event undone a step ago has a new version
        for step in reversed(steps):
            problem = self._undo_step(step, latest)
            if problem != "ok":
                break
            problem = None
            left.remove(step)
            self.touched = True
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET undo_json=?, updated_at=? WHERE proposal_id=?",
                           (json.dumps(left), iso(self.ledger.now()), row["proposal_id"]))
                for calendar, uid, instance in step.get("removed", []):
                    db.execute("DELETE FROM calendar_removed WHERE calendar=? AND uid=? AND instance=?",
                               (calendar, uid, instance))
        if problem is None:
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET undo_state='undone', updated_at=? WHERE proposal_id=?",
                           (iso(self.ledger.now()), row["proposal_id"]))
                self._carry_versions(db, row, latest)
                self._say(db, self.chat_id, row["job_id"], "<b>Undone.</b> It's back the way it was.")
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROBLEM, "Calendar change: an undo didn't finish", db)
        self._reopen(row, f"<b>Not fully undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                          "Check the calendar. Undo tries what's left again.")

    @staticmethod
    def _event_key(step: dict) -> str:
        """One event however a step names it: one day of a Gmail series is part of the series."""
        if step["cal"] == "family":
            return "family:" + caldav.href_path(step["href"])
        if step["cal"] == "rule":
            return "rule:" + " ".join(sorted(family_rules.words(step["said"])))
        return "gmail:" + (step.get("series") or _gmail_series(step["id"]) or step["id"])

    @staticmethod
    def _object_key(step: dict) -> str:
        """One thing with its own version: a Gmail series and its days are separate here."""
        if step["cal"] == "family":
            return caldav.href_path(step["href"])
        return step["id"] if step["cal"] == "gmail" else CalendarChange._event_key(step)

    def _later_changes(self, row, steps: list) -> list[str]:
        """Later changes still standing on the same events, which have to go first, and any
        later ones on the events those touch."""
        keys = {self._event_key(s) for s in steps}
        found: list[str] = []
        rows = self.ledger.db.execute(            # rows go in as changes run, so rowid is their order
            "SELECT proposal_id, undo_json FROM calendar_changes WHERE rowid>(SELECT rowid FROM"
            " calendar_changes WHERE proposal_id=?) AND undo_state IN ('open','requested','undoing')"
            " ORDER BY rowid", (row["proposal_id"],)).fetchall()
        for other in rows:
            theirs = {self._event_key(s) for s in json.loads(other["undo_json"])}
            if keys & theirs:
                found.append(other["proposal_id"])
                keys |= theirs
        return found

    def _offer_both(self, row, later: list[str]) -> None:
        """One button for all of them, newest undone first, so no old receipt's expired button
        can leave this stuck."""
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_state='open', updated_at=? WHERE proposal_id=?",
                       (iso(self.ledger.now()), row["proposal_id"]))
            label = "Undo both" if len(later) == 1 else f"Undo all {len(later) + 1}"
            buttons, binds = self._undo_button(db, " ".join([row["proposal_id"], *later]), label)
            self._say(db, self.chat_id, row["job_id"],
                      "<b>Not undone:</b> you asked for another change to that event after this one, "
                      "so that has to be undone too. Nothing changed.", buttons=buttons, binds=binds)

    def _carry_versions(self, db, row, latest: dict[str, str]) -> None:
        """This undo put an event back as an earlier change left it, under a new version. That
        earlier change's own undo should know the event as its own, however the server rewrote it."""
        if not latest:
            return
        latest = {**latest, **{caldav.href_path(k): v for k, v in latest.items()}}   # an href in either form
        for other in db.execute(
                "SELECT proposal_id, undo_json FROM calendar_changes WHERE rowid<(SELECT rowid FROM"
                " calendar_changes WHERE proposal_id=?) AND undo_state IN ('open','requested')",
                (row["proposal_id"],)).fetchall():
            steps, moved = json.loads(other["undo_json"]), False
            for step in steps:
                key = self._object_key(step)
                if step["cal"] != "rule" and key in latest and latest[key]:
                    step["etag"], moved = latest[key], True
            if moved:
                db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?",
                           (json.dumps(steps), other["proposal_id"]))

    def _undo_ready(self, steps: list) -> str | None:
        """Each event as the last step of this change left it, read before anything is written."""
        seen: set[str] = set()
        for step in reversed(steps):
            key = self._object_key(step)
            if step["cal"] == "rule" or key in seen:
                continue                     # an earlier step on it is checked once the later one runs
            seen.add(key)
            problem = (self._gmail_ready if step["cal"] == "gmail" else self._family_ready)(step)
            if problem != "ok":
                return problem
        return None

    def _family_ready(self, step: dict) -> str:
        out, body = self.client.fetch(step["href"])
        if step["how"] == "restore":
            if out.kind == "ok":
                return "ok" if caldav._unchanged(body, step["before"]) else "changed"
            return "ok" if out.kind == "gone" else out.kind
        if out.kind == "gone" and step["how"] == "delete":
            return "ok"
        if out.kind != "ok":
            return out.kind
        if out.etag != step.get("etag") and not caldav._unchanged(body, step.get("after", "")):
            return "changed"
        return "ok"

    def _gmail_ready(self, step: dict) -> str:
        address = self.address()
        if not address or self.google is None:
            return "failed"
        kind, cur = self.google.look(address, step["id"])
        if kind == "unknown":
            return "unknown"
        cancelled = kind == "gone" or (cur or {}).get("status") == "cancelled"
        if step["how"] == "restore":
            return self._series_there(address, step) if cancelled else "ok"
        if cancelled:
            return "ok" if step["how"] == "drop" else "gone"
        if cur.get("etag") != step.get("etag") and not self._as_written(cur, step.get("wrote") or {}):
            return "changed"
        return "ok"

    def _series_there(self, address: str, step: dict) -> str:
        """Google will put one day back under a series that's gone, as an event on its own."""
        series = step.get("series") or _gmail_series(step["id"])
        if not series:
            return "ok"
        kind, cur = self.google.look(address, series)
        if kind == "unknown":
            return "unknown"
        return "series_gone" if kind == "gone" or (cur or {}).get("status") == "cancelled" else "ok"

    def _undo_step(self, step: dict, latest: dict[str, str]) -> str:
        if step["cal"] == "rule":
            with self.ledger.tx() as db:     # put back what it said before, or nothing
                family_rules.put(self.ledger, step["said"], None, db)
                if step["before"]:
                    family_rules.put(self.ledger, step["before"][0], step["before"][1], db)
            return "ok"
        return (self._undo_gmail if step["cal"] == "gmail" else self._undo_family)(step, latest)

    def _undo_family(self, step: dict, latest: dict[str, str]) -> str:
        href = step["href"]
        if step["how"] == "restore":
            out, body = self.client.fetch(href)
            if out.kind == "ok" and caldav._unchanged(body, step["before"]):
                return "ok"                  # something already put it back
            return self._after_undo(self.client.put_new(href, step["before"]), href, latest)
        out, body = self.client.fetch(href)
        if out.kind == "gone" and step["how"] == "delete":
            return "ok"
        if out.kind != "ok":
            return out.kind
        expected = latest.get(href, step.get("etag"))
        if out.etag != expected and not caldav._unchanged(body, step.get("after", "")):
            return "changed"
        if step["how"] == "delete":
            return self.client.remove_at(href, out.etag or "").kind
        return self._after_undo(self.client.replace(href, out.etag or "", step["before"]), href, latest)

    def _after_undo(self, out, href: str, latest: dict[str, str]) -> str:
        if out.kind == "ok":
            back, _ = self.client.fetch(href)
            latest[href] = back.etag or out.etag or ""
        return out.kind

    def _as_written(self, now: dict, wrote: dict) -> bool:
        """Still what the harness wrote, when the version can't say: another day's change can
        give this one a new version."""
        if not wrote:
            return False
        for key, value in wrote.items():
            if key in ("start", "end"):
                if not _same_start(self._gmail_when(now.get(key)), self._gmail_when(value)):
                    return False
            elif now.get(key) != value:
                return False
        return True

    def _undo_gmail(self, step: dict, latest: dict[str, str]) -> str:
        address = self.address()
        if not address or self.google is None:
            return "failed"
        uid = step["id"]
        kind, cur = self.google.look(address, uid)
        if kind == "unknown":
            return "unknown"                 # no answer says nothing about whether it's there
        cancelled = kind == "gone" or (cur or {}).get("status") == "cancelled"
        if step["how"] == "restore":
            if not cancelled:
                return "ok"                  # someone already put it back
            there = self._series_there(address, step)
            if there != "ok":
                return there
            out = self.google.change(address, uid, step["fields"], None)
        else:
            if cancelled:
                return "ok" if step["how"] == "drop" else "gone"
            if cur.get("etag") != latest.get(uid, step.get("etag")) \
                    and not self._as_written(cur, step.get("wrote") or {}):
                return "changed"
            out = (self.google.drop(address, uid, cur.get("etag")) if step["how"] == "drop"
                   else self.google.change(address, uid, step["fields"], cur.get("etag")))
        if out.kind == "ok":
            latest[uid] = (self.google.look(address, uid)[1] or {}).get("etag") or ""
        return out.kind

    # -- a day that came back ------------------------------------------------------------------
    def _check_returned(self) -> None:
        now = self.ledger.now()
        last = self.ledger.meta_time(LAST_CHECK)
        if last is not None and now - last < CHECK_EVERY:
            return
        self.ledger.set_meta(LAST_CHECK, iso(now))
        today = now.astimezone(ZoneInfo(self.tz)).date()
        # A series he ended stays watched past its end: that's when an app can bring it back.
        rows = self.ledger.db.execute(
            "SELECT * FROM calendar_removed WHERE told_at IS NULL AND (day>=? OR (instance='*' AND day>=?))",
            (today.isoformat(), (today - RETURN_AHEAD).isoformat())).fetchall()
        for calendar in ("family", "gmail"):
            mine = [r for r in rows if r["calendar"] == calendar]
            if not mine:
                continue
            days = [max(today, date.fromisoformat(r["day"])) for r in mine]
            seen = self._seen(calendar, days)
            if seen is None:
                continue                         # not read is not gone, and not back either
            for r in mine:
                day = date.fromisoformat(r["day"])
                back = (any(f.series == r["uid"] and f.first >= day for f in seen) if r["instance"] == "*"
                        else any(f.series == r["uid"] and f.instance == r["instance"] for f in seen))
                if back:
                    with self.ledger.tx() as db:
                        db.execute("UPDATE calendar_removed SET told_at=? WHERE calendar=? AND uid=?"
                                   " AND instance=?", (iso(now), calendar, r["uid"], r["instance"]))
                        self.ledger.event("calendar_change_returned",
                                          {"title": r["title"], "day": r["day"], "calendar": calendar}, db=db)

    def _seen(self, calendar: str, days: list[date]) -> list[Found] | None:
        """One read, whatever the days."""
        try:
            if calendar == "gmail" and (self.google is None or not self.address()):
                return None
            return self._read(calendar, days, RETURN_AHEAD)[0]
        except Refuse:
            return None

    # -- what he sees --------------------------------------------------------------------------
    def status_line(self) -> str:
        if self.enabled() is True and not self.on():
            return ("Calendar changes you ask for: off since the reset. Turn the calendar_changes "
                    "option off, restart the add-on, then turn it on to allow them again.")
        if not self.on():
            return "Calendar changes you ask for: off"
        if self.ledger.get_meta(TAP_BACK):
            return "Calendar changes you ask for: on, each needs your tap"
        return "Calendar changes you ask for: on, no tap (Undo, /stop and /checkadds stay)"

    def digest_line(self) -> str:
        since = self.ledger.meta_time("last_digest_at")
        at = iso(since) if since else ""
        parts = []
        n = self.ledger.db.execute("SELECT COUNT(*) FROM events WHERE kind='calendar_change_done' AND at>=?",
                                   (at,)).fetchone()[0]
        if n:
            parts.append(f"Calendar changes you asked for: {n}.")
        for r in self.ledger.db.execute("SELECT detail FROM events WHERE kind='calendar_change_returned'"
                                        " AND at>=?", (at,)).fetchall():
            d = json.loads(r["detail"])
            day = date.fromisoformat(d["day"])
            parts.append(f"{render.defang(d['title'])} on {_day_words(day)} came back on {d['calendar'].title()} "
                         "after you took it off. An app may have rewritten the series. Say so and I'll "
                         "take it off again.")
        problem = self.ledger.get_meta(PROBLEM)
        return " ".join(parts + ([problem] if problem else []))

    def _say(self, db, chat_id, job_id, text: str, *, buttons=None, binds=None) -> None:
        self.ledger.enqueue(chat_id=chat_id, kind="reply", job_id=job_id, text=render.fit(text),
                            buttons=buttons, binds=binds, db=db)
        self.ledger.release_held(db=db)


def _same_start(a, b) -> bool:
    if isinstance(a, datetime) and isinstance(b, datetime):
        return a.astimezone(timezone.utc) == b.astimezone(timezone.utc)
    return a == b


def _gmail_series(event_id: str) -> str:
    """The series one day of it belongs to, from its id, or "" if it isn't one day of a series."""
    m = re.fullmatch(r"(.+)_\d{8}(T\d{6}Z)?", event_id)
    return m.group(1) if m else ""
